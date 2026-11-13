// FEATURE 17: what runs inside one preparation sandbox (docs/launch/CLOUD-RUNNER.md). One request, then exit.
//
// The dispatcher claimed the request (one person's queued postings) and started this sandbox with four values: the
// request id, this sandbox's id, the token binding them to the request's current lease, and the bridge URL. This process
// holds no database credential. It prepares exactly as the worker host does (prepare-ahead.ts prepareAhead: the engine's
// dry run on the employer's form, the person's confirmed facts and answers only, a question asked once for anything they
// have not told Trainee), with the resume they keep for the cloud, byte for byte as they gave it. Every database call goes
// through the bridge, which names the person and the postings from the request, never from this process. Then it
// finishes the request, and the bridge shows the card of what is ready (or texts the questions) in their thread.
// Nothing is approved, queued or sent here.
import { postingSchema, schemaCache } from "../../supabase/functions/_shared/posting_schema.ts";
import { engineRunner, type RunEngine } from "../career-browser/approve-first.ts";
import { PacedLimiter } from "../career-browser/mass-run.ts";
import { prepareAhead, type PreparedResume, type ServiceRpc, storedProfile } from "../career-browser/prepare-ahead.ts";

export function prepareBridge(o: { url: string; id: string; sandbox: string; token: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch;
  const call = async (op: string, extra: Record<string, unknown> = {}) => {
    const r = await f(`${o.url.replace(/\/$/, "")}/prep/${op}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: o.id, sandbox: o.sandbox, token: o.token, ...extra }),
    });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!r.ok) throw Object.assign(Error(`${op}: ${r.status} ${String(body?.error ?? text).slice(0, 200)}`), { status: r.status });
    return body;
  };
  // prepare-ahead.ts's database door, answered by the bridge: { data, error } as supabase-js answers.
  const db: ServiceRpc = {
    rpc: async (name: string, args?: any) => {
      try { return { data: await call("rpc", { name, args: args ?? {} }), error: null }; } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; }
    },
  };
  return { call, db };
}

// The resume the person keeps for the cloud, as is, written into the preparation's own folder; null when none is kept
// (the posting is then recorded no_resume and nothing is prepared: nothing goes out with a resume they did not give).
// R9-G2 (E09): asked for the posting it prepares, so a resume tailored for that posting ("tailor ... and apply with it") is
// the file that goes, and the card names it; any other posting gets the kept resume as before.
export function keptResume(call: (op: string, extra?: Record<string, unknown>) => Promise<any>) {
  // deno-lint-ignore no-explicit-any
  return async (c: unknown, dir: string, profile?: any): Promise<PreparedResume | null> => {
    const posting = c && typeof c === "object" && typeof (c as any).job_id === "string" ? (c as any).job_id : null;
    const r = await call("resume", posting ? { posting } : {});
    if (!r || typeof r.b64 !== "string" || !/^[0-9a-f]{64}$/.test(String(r.sha256)) || !/^[^/\\.][^/\\]{0,199}$/.test(String(r.filename))) return null;
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const sum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((n) => n.toString(16).padStart(2, "0")).join("");
    if (!bytes.length || sum !== r.sha256) return null;
    // No card with a resume whose contact is a placeholder or cannot be read (the same gate the submit paths use).
    const gate = (await import("../../supabase/functions/_shared/career_tailor.ts"));
    if ((await gate.resumeFileContactProblems(bytes, { confirmed: profile ? gate.confirmedEmails(profile) : [], ...gate.recordOf(r) })).length) return null;
    await Deno.mkdir(`${dir}/kept`, { recursive: true, mode: 0o700 });
    const path = `${dir}/kept/${r.filename}`;
    await Deno.writeFile(path, bytes, { mode: 0o600 });
    return { path, sha256: sum, tag: null };
  };
}

// One request, start to finish. `urlFor` is the tests' (a local copy of the employer's form); production opens the
// posting's own link.
// One cache per process: a posting's published form read once per 6 hours, whoever's preparation asks.
const SCHEMAS = schemaCache();
// MASS APPLY at scale (docs/architect/mass-apply-scale-audit.md section 7, fix 3): a part of up to 25 postings was prepared one after
// another (prepareAhead's default pool is one), so at real forms' 30-90 s a part outlived its 13-minute sandbox and was killed with
// the work half done and the slot held to the 15-minute lease. The sandbox now prepares several at once through one shared pool:
// default 4 (the 4 GB sandbox holds about 450 MB per Chromium), at most 8. Every employer host runs at full parallelism unless it
// refuses (a refusal holds that host off for the pool, as in prepare-ahead.ts); nothing here is a per-person or per-site number.
export const PREPARE_PARALLEL = { default: 4, max: 8 } as const;
export const prepareParallel = (n: unknown): number => {
  const k = Math.floor(Number(n));
  return Number.isFinite(k) && k >= 1 ? Math.min(k, PREPARE_PARALLEL.max) : PREPARE_PARALLEL.default;
};
export async function runPrepareRequest(o: {
  bridge: ReturnType<typeof prepareBridge>; runEngine: RunEngine; urlFor?: (c: { url: string }) => string; tmpRoot?: string; log?: (l: string) => void;
  // Postings prepared at once in this sandbox (1 to PREPARE_PARALLEL.max; absent or nonsense: PREPARE_PARALLEL.default).
  parallel?: number;
  // MASS APPLY: Greenhouse's board API (posting_schema.ts); off with schema: false. greenhouseApi: the tests' local board.
  schema?: false | { fetch?: typeof fetch; greenhouseApi?: string };
}) {
  const log = o.log ?? ((l: string) => console.log(l));
  const req = await o.bridge.call("request");
  const parallel = prepareParallel(o.parallel);
  let done: Awaited<ReturnType<typeof prepareAhead>> = [];
  try {
    done = await prepareAhead({
      db: o.bridge.db, runEngine: o.runEngine, limiter: new PacedLimiter({ concurrency: parallel, hostMax: parallel, hostSpacingMs: 0 }), profileFor: storedProfile(o.bridge.db), resumeFor: keptResume(o.bridge.call), resumeIsFile: true,
      ...(o.urlFor ? { urlFor: o.urlFor } : {}), ...(o.tmpRoot ? { tmpRoot: o.tmpRoot } : {}),
      ...(o.schema === false ? {} : { schemaFor: (url: string) => postingSchema(url, { fetch: o.schema?.fetch ?? fetch, cache: SCHEMAS, greenhouseApi: o.schema?.greenhouseApi }) }),
    }, { only: { user_id: String(req.user_id), job_ids: (req.job_ids ?? []).map(String) }, perPerson: 25, limit: 500 });
  } catch (e) {
    log(`prepare: ${(e as Error)?.message ?? e}`);
  }
  for (const r of done) log(`${r.outcome.toUpperCase()} ${r.job_id} (${r.detail})`);
  const finish = await o.bridge.call("finish", { outcomes: done.map((r) => ({ job_id: r.job_id, outcome: r.outcome, detail: r.detail })) });
  return { outcomes: done, finish };
}

// The four values the dispatcher started this sandbox with, read once and removed from this process's environment, so
// the engine and Chromium it starts (engineRunner inherits the environment) and any page they open never see the token.
export const RUNNER_ENV = ["CLOUD_BRIDGE_URL", "CLOUD_PREPARE_ID", "CLOUD_SANDBOX_ID", "CLOUD_JOB_TOKEN"] as const;
export function takeRunnerEnv(env: { get(k: string): string | undefined; delete(k: string): void } = Deno.env): string[] {
  const out = RUNNER_ENV.map((k) => env.get(k) || "");
  for (const k of RUNNER_ENV) env.delete(k);
  return out;
}

if (import.meta.main) {
  const [url, id, sandbox, token] = takeRunnerEnv();
  if (!url || !id || !sandbox || !token) {
    console.error("usage: CLOUD_BRIDGE_URL, CLOUD_PREPARE_ID, CLOUD_SANDBOX_ID and CLOUD_JOB_TOKEN (set by the dispatcher)");
    Deno.exit(2);
  }
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const started = Date.now();
  const r = await runPrepareRequest({ bridge: prepareBridge({ url, id, sandbox, token }), runEngine: engineRunner({ root }) });
  console.log(`PREPARE ${JSON.stringify({ ready: r.outcomes.filter((x) => x.outcome === "ready").length, of: r.outcomes.length, push: r.finish?.push, ms: Date.now() - started })}`);
  Deno.exit(0);
}
