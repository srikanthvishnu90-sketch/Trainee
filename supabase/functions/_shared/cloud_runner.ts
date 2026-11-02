// The cloud runner (F-RUNNER, docs/launch/CLOUD-RUNNER.md): a dispatcher that claims approved applications through the
// one cloud claim and starts one short-lived sandbox per application, and the job bridge each sandbox talks to.
//
// Nothing here decides whether an application may go: the database does, at the claim (career_apply_cloud_refusal: the
// kill switch, the gate or waiver, the opt-in, pauses, the person's own pace, one employer per 30 days), at the
// authorization before the engine and again before the one Submit (career_apply_message_cloud_authorize), and at the
// finish (career_apply_cloud_finish). The engine in the sandbox submits only the exact approved application.
//
// The sandbox never holds the service key. It holds one job's id, its lease, its own sandbox id and a token binding the
// three (HMAC under CLOUD_RUNNER_SECRET). Through the bridge it can read that job, the approved resume for it, the
// person's source snapshot, ask for the one authorization, put questions, and finish it: only while the job is still
// being driven under that lease, and with the job, lease and person always taken from the database, never from the
// request.

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface ClaimedJob {
  id: string;
  lease_token: string;
  user_id: string;
  company: string;
  url: string;
  payload: any;
  payload_hash: string;
  approval_hash: string;
  job_id?: string;
  state?: string;
  source?: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((n) => n.toString(16).padStart(2, "0")).join("");

// The token a sandbox carries for its one job: HMAC-SHA256 over the job id, its lease and the sandbox id.
export async function jobToken(secret: string, id: string, lease: string, sandbox: string): Promise<string> {
  if (!secret || secret.length < 32) throw Error("CLOUD_RUNNER_SECRET must be at least 32 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`trainee-cloud-runner.v1.${id}.${lease}.${sandbox}`)));
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ------------------------------------------------------------------------------------------------ the dispatcher

export interface SandboxHost {
  // A fresh sandbox from the runner snapshot; its id.
  create(o: { name: string }): Promise<string>;
  // Start the runner in it (not waited for). The env carries the job id, the sandbox id, the token and the bridge URL.
  // `script`: the repo path to run (default: the send runner, workers/career-cloud/sandbox-runner.ts).
  run(sandbox: string, env: Record<string, string>, script?: string): Promise<void>;
  stop(sandbox: string): Promise<void>;
}
export interface DispatchLimits {
  want: number; // at most this many new applications per tick
  global: number; // at most this many applications driven by the cloud at once
  perPortal: number; // at most this many at once on one portal family (greenhouse, lever, ashby)
  // FEATURE 17: with both given (a number or null), the dispatcher also claims text-card approvals
  // (career_apply_cloud_dispatch_claim2). null: no such number (NO LIMITS; only the person's own pace binds); a number:
  // at most perPersonDay sent per person in 24 hours, at most perSiteMinute claims per employer host per minute.
  perPersonDay?: number | null;
  perSiteMinute?: number | null;
}
export interface DispatchResult {
  claimed: number;
  started: { job: string; sandbox: string }[];
  unavailable: { job: string; why: string }[];
  claim_error?: string;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Exponential backoff with jitter: 1 s, 2 s, 4 s (± 25%) by default.
export async function withRetry<T>(f: () => Promise<T>, o: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const tries = o.tries ?? 3, base = o.baseMs ?? 1000, sleep = o.sleep ?? sleepMs;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(Math.round(base * 2 ** i * (0.75 + Math.random() * 0.5)));
    }
  }
  throw last;
}

// One tick: claim, then one sandbox per claimed application. A sandbox that cannot be started after its retries is
// stopped, and its application is finished as not sent (RUNNER_UNAVAILABLE): the engine never started, so nothing could
// have reached the employer, and the person's approval is not left to the 15-minute sweep, which would call it unknown.
export async function dispatch(o: {
  rpc: Rpc;
  host: SandboxHost;
  limits: DispatchLimits;
  secret: string;
  bridgeUrl: string;
  parallel?: number;
  retry?: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> };
  log?: (line: string) => void;
}): Promise<DispatchResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const out: DispatchResult = { claimed: 0, started: [], unavailable: [] };
  let jobs: ClaimedJob[];
  try {
    jobs = await withRetry(async () => {
      const both = o.limits.perPersonDay !== undefined && o.limits.perSiteMinute !== undefined;
      const rows = both
        ? await o.rpc("career_apply_cloud_dispatch_claim2", { p_want: o.limits.want, p_global: o.limits.global, p_per_portal: o.limits.perPortal,
          p_per_person_day: o.limits.perPersonDay, p_per_site_minute: o.limits.perSiteMinute })
        : await o.rpc("career_apply_cloud_dispatch_claim", { p_want: o.limits.want, p_global: o.limits.global, p_per_portal: o.limits.perPortal });
      if (!Array.isArray(rows)) throw Error("APPLY_QUEUE_UNAVAILABLE");
      return rows as ClaimedJob[];
    }, { tries: 2, baseMs: o.retry?.baseMs, sleep: o.retry?.sleep });
  } catch (e) {
    // Nothing was claimed (the claim is one transaction): the next tick asks again.
    out.claim_error = String((e as Error)?.message ?? e).slice(0, 200);
    log(`dispatch: the queue could not be read (${out.claim_error}); nothing claimed`);
    return out;
  }
  out.claimed = jobs.length;
  const one = async (job: ClaimedJob) => {
    let sandbox = "";
    try {
      sandbox = await withRetry(() => o.host.create({ name: `trainee-run-${job.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}` }), o.retry);
      const token = await jobToken(o.secret, job.id, job.lease_token, sandbox);
      await withRetry(() => o.host.run(sandbox, { CLOUD_JOB_ID: job.id, CLOUD_SANDBOX_ID: sandbox, CLOUD_JOB_TOKEN: token, CLOUD_BRIDGE_URL: o.bridgeUrl }), o.retry);
      out.started.push({ job: job.id, sandbox });
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      if (sandbox) await o.host.stop(sandbox).catch(() => {});
      try {
        await withRetry(() => o.rpc("career_apply_cloud_finish", {
          p_id: job.id, p_lease: job.lease_token, p_state: "not_submitted",
          p_evidence: { reason: "RUNNER_UNAVAILABLE", by: "cloud", detail: why, at: new Date().toISOString() },
          p_outcome: "not_sent", p_error_kind: "RUNNER_UNAVAILABLE",
        }), { tries: 3, baseMs: o.retry?.baseMs, sleep: o.retry?.sleep });
      } catch { /* the 15-minute sweep records it as unknown; it is never re-driven */ }
      out.unavailable.push({ job: job.id, why });
    }
  };
  const n = Math.max(1, Math.min(32, o.parallel ?? 8));
  for (let i = 0; i < jobs.length; i += n) await Promise.all(jobs.slice(i, i + n).map(one));
  log(`dispatch: claimed ${out.claimed}, started ${out.started.length}, not started ${out.unavailable.length}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ the job bridge

export const BRIDGE_OPS = ["job", "sources", "authorize", "resume", "ask", "finish"] as const;
export type BridgeOp = typeof BRIDGE_OPS[number];
export interface BridgeDeps {
  rpc: Rpc;
  readJob: (id: string) => Promise<ClaimedJob | null>;
  secret: string;
  stop?: (sandbox: string) => Promise<void>;
}
export interface BridgeReply { status: number; body: unknown }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (status: number, error: string): BridgeReply => ({ status, body: { error } });

export async function handleBridge(op: string, body: any, d: BridgeDeps): Promise<BridgeReply> {
  if (!(BRIDGE_OPS as readonly string[]).includes(op)) return refuse(404, "unknown operation");
  const id = String(body?.id ?? ""), sandbox = String(body?.sandbox ?? ""), token = String(body?.token ?? "");
  if (!UUID.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(sandbox) || !/^[0-9a-f]{64}$/.test(token)) return refuse(400, "invalid request");
  let row: ClaimedJob | null;
  try {
    row = await d.readJob(id);
  } catch {
    return refuse(503, "the queue could not be read");
  }
  // The token names this job, under the lease it holds now, for this sandbox; and the job must still be driven by the cloud.
  if (!row || row.source !== "cloud" || row.state !== "driving" || !row.lease_token ||
    !sameText(token, await jobToken(d.secret, id, row.lease_token, sandbox))) return refuse(403, "not this sandbox's job");
  const lease = row.lease_token;
  try {
    switch (op as BridgeOp) {
      case "job":
        return { status: 200, body: { id: row.id, lease_token: lease, user_id: row.user_id, company: row.company, url: row.url, payload: row.payload,
          payload_hash: row.payload_hash, approval_hash: row.approval_hash, job_id: row.job_id } };
      case "sources":
        return { status: 200, body: await d.rpc("career_apply_message_cloud_sources", { p_user: row.user_id }) };
      case "authorize":
        // FEATURE 17: either route's authorization (a card-cloud job goes to the bridge's own, unchanged; a text-card job
        // to career_apply_cloud_text_authorize), chosen by the database from the job, never by the request.
        return { status: 200, body: await d.rpc("career_apply_cloud_authorize_any", {
          p_id: id, p_lease: lease, p_hash: String(body?.p_hash ?? ""), p_source_digest: String(body?.p_source_digest ?? ""),
        }) };
      case "resume":
        return { status: 200, body: await d.rpc("career_apply_cloud_resume", { p_id: id, p_lease: lease }) };
      case "ask":
        if (!Array.isArray(body?.questions) || body.questions.length > 40) return refuse(400, "invalid questions");
        return { status: 200, body: await d.rpc("career_apply_cloud_ask", { p_id: id, p_lease: lease, p_questions: body.questions }) };
      case "finish": {
        const r = await d.rpc("career_apply_cloud_finish", {
          p_id: id, p_lease: lease, p_state: String(body?.state ?? ""), p_evidence: body?.evidence ?? null,
          p_outcome: String(body?.outcome ?? ""), p_error_kind: body?.error_kind == null ? null : String(body.error_kind),
        });
        // The application is recorded; the sandbox has nothing left to do.
        if (d.stop) await d.stop(sandbox).catch(() => {});
        return { status: 200, body: { state: r?.state ?? null } };
      }
    }
  } catch (e) {
    // The database's refusal, as it said it, never the service key or the request.
    return refuse(409, String((e as Error)?.message ?? e).replace(/^[a-z_]+: \d+ /, "").slice(0, 300));
  }
  return refuse(404, "unknown operation");
}

// ------------------------------------------------------------------------------------------------ the host: Vercel Sandbox

// Vercel's REST API (the same endpoints the Vercel CLI and MCP use): POST /v4/sandboxes, POST
// /v2/sandboxes/sessions/{id}/cmd, POST /v2/sandboxes/sessions/{id}/stop. One sandbox per application, from the runner
// snapshot (docs/launch/CLOUD-RUNNER.md), not persistent, stopped by the bridge at the finish and by its own timeout.
export function vercelSandboxHost(o: {
  token: string;
  teamId: string;
  projectId: string;
  snapshotId: string;
  region?: string;
  vcpus?: number;
  timeoutMs?: number;
  repoDir?: string;
  // The owner's switch UPMORE_SCRIPT_SUBMIT_LIVE=1 (a secret of this function): handed to both runner scripts so the engine
  // binds a real Greenhouse, Ashby or Lever form's scripted Submit (scripts/apply.ts scriptSubmitFamily). Without it every
  // Ashby posting, Ramp's included, stops at SUBMIT_DESTINATION_NOT_BOUND in the preparation and in the send.
  scriptSubmitLive?: boolean;
  fetch?: typeof fetch;
}): SandboxHost {
  const f = o.fetch ?? fetch, api = "https://api.vercel.com";
  const call = async (path: string, body: unknown) => {
    const r = await f(`${api}${path}?teamId=${encodeURIComponent(o.teamId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw Error(`vercel ${path.split("/").slice(0, 3).join("/")}: ${r.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : null;
  };
  const vcpus = o.vcpus ?? 2, dir = o.repoDir ?? "/vercel/repo";
  return {
    async create({ name }) {
      const r = await call("/v4/sandboxes", {
        projectId: o.projectId, name, persistent: false, region: o.region ?? "iad1",
        // Under the queue's 15-minute lease: a sandbox that outlives it would hold an application the sweep already closed.
        timeout: o.timeoutMs ?? 13 * 60_000, resources: { vcpus, memory: vcpus * 2048 },
        source: { type: "snapshot", snapshotId: o.snapshotId }, tags: { purpose: "trainee-cloud-runner" },
      });
      const id = r?.session?.id ?? r?.sandbox?.currentSessionId;
      if (!id) throw Error("vercel: no sandbox session id");
      return String(id);
    },
    async run(sandbox, env, script = "workers/career-cloud/sandbox-runner.ts") {
      if (!/^workers\/career-cloud\/(sandbox|prepare)-runner\.ts$/.test(script)) throw Error("vercel: not a runner script");
      await call(`/v2/sandboxes/sessions/${encodeURIComponent(sandbox)}/cmd`, {
        command: "bash", cwd: dir,
        args: ["-c", `exec deno run -A --no-check ${script} > /tmp/runner.log 2>&1`],
        env: { ...env, PLAYWRIGHT_BROWSERS_PATH: "/vercel/.cache/ms-playwright", UPMORE_PLAYWRIGHT_PATH: `${dir}/tools/node_modules/playwright`,
          ...(o.scriptSubmitLive ? { UPMORE_SCRIPT_SUBMIT_LIVE: "1" } : {}) },
      });
    },
    async stop(sandbox) {
      await call(`/v2/sandboxes/sessions/${encodeURIComponent(sandbox)}/stop`, {});
    },
  };
}
