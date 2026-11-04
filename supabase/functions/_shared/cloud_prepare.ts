// FEATURE 17 (2026-10-26): hosted preparation, the half of the cloud runner that makes the card. A person with only a
// phone says "apply me to <link>"; the chat queues the posting (career_apply_wanted) and kicks this door (agent-chat
// kickPrepare, CAREER_PREPARE_AHEAD_URL = <runner>/prepare). The door records the request in the database
// (career_apply_prepare_request_put: only that person's own queued postings), and the dispatcher, at once and on every
// minute's tick, claims requests under the global, per-person-per-day and per-site-per-minute numbers and starts one
// sandbox per request from the runner snapshot. The sandbox runs workers/career-cloud/prepare-runner.ts: the existing
// preparation (prepare-ahead.ts prepareAhead: the engine's dry run, the person's confirmed facts, their questions asked
// once), with the resume they keep for the cloud, as is. It holds no database credential: its token binds the request,
// its lease and the sandbox, and every call it makes goes through the bridge below, for that person and those postings
// only. At the finish the bridge shows the card of what is ready in the person's own thread at once
// (career_apply_card_push_requested_for), which the delivery run sends to their channel within its minute.
//
// Nothing here approves, queues or sends an application: the card does, on the person's own tap of its exact contents.
import { cardFor } from "./career_apply_cards.ts";
import { type OpenQuestion, questionsText } from "./career_apply_questions.ts";
import { type Rpc, type SandboxHost, withRetry } from "./cloud_runner.ts";
import { preparedCardProblem } from "./career_prepared_card.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((n) => n.toString(16).padStart(2, "0")).join("");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
export const PREPARE_SCRIPT = "workers/career-cloud/prepare-runner.ts";
export const RUNNER_UNAVAILABLE_TEXT =
  "I couldn't start preparing the application you asked for: the machine that prepares it didn't start. Nothing was sent, and it is still in your queue. Say \"apply me to\" with the link to try again in a few minutes.";

// The token a preparation sandbox carries: HMAC-SHA256 over the request id, its lease and the sandbox id, under the same
// secret as the send runner's, with its own prefix (a send token never opens a preparation, nor the other way round).
export async function prepareToken(secret: string, id: string, lease: string, sandbox: string): Promise<string> {
  if (!secret || secret.length < 32) throw Error("CLOUD_RUNNER_SECRET must be at least 32 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`trainee-cloud-prepare.v1.${id}.${lease}.${sandbox}`)));
}

// perPersonDay / perSiteMinute: a number someone set, or null (none: NO LIMITS).
export interface PrepareLimits { want: number; global: number; perPersonDay: number | null; perSiteMinute: number | null }
export interface PrepareRequestRow { id: string; user_id: string; job_ids: string[]; lease_token: string; state?: string; claimed_at?: string }
export interface PrepareDispatchResult { claimed: number; started: { request: string; sandbox: string }[]; unavailable: { request: string; why: string }[]; claim_error?: string }

// One tick: claim, then one sandbox per claimed request. A sandbox that cannot be started is stopped, the person is told
// (the chat said it had started), and its request finished 'failed' (RUNNER_UNAVAILABLE): nothing was prepared, the
// postings stay in the person's queue.
export async function dispatchPrepare(o: {
  rpc: Rpc; host: SandboxHost; limits: PrepareLimits; secret: string; bridgeUrl: string;
  retry?: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> }; log?: (line: string) => void;
}): Promise<PrepareDispatchResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const out: PrepareDispatchResult = { claimed: 0, started: [], unavailable: [] };
  let rows: PrepareRequestRow[];
  try {
    rows = await withRetry(async () => {
      const r = await o.rpc("career_apply_prepare_request_claim", { p_want: o.limits.want, p_global: o.limits.global,
        p_per_person_day: o.limits.perPersonDay, p_per_site_minute: o.limits.perSiteMinute });
      if (!Array.isArray(r)) throw Error("PREPARE_QUEUE_UNAVAILABLE");
      return r as PrepareRequestRow[];
    }, { tries: 2, baseMs: o.retry?.baseMs, sleep: o.retry?.sleep });
  } catch (e) {
    out.claim_error = String((e as Error)?.message ?? e).slice(0, 200);
    log(`prepare dispatch: the requests could not be read (${out.claim_error}); nothing claimed`);
    return out;
  }
  out.claimed = rows.length;
  for (const r of rows) {
    let sandbox = "";
    try {
      sandbox = await withRetry(() => o.host.create({ name: `trainee-prep-${r.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}` }), o.retry);
      await o.rpc("career_apply_prepare_request_sandbox", { p_id: r.id, p_lease: r.lease_token, p_sandbox: sandbox });
      const token = await prepareToken(o.secret, r.id, r.lease_token, sandbox);
      await withRetry(() => o.host.run(sandbox, { CLOUD_PREPARE_ID: r.id, CLOUD_SANDBOX_ID: sandbox, CLOUD_JOB_TOKEN: token, CLOUD_BRIDGE_URL: o.bridgeUrl }, PREPARE_SCRIPT), o.retry);
      out.started.push({ request: r.id, sandbox });
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      if (sandbox) await o.host.stop(sandbox).catch(() => {});
      // The chat told them it started; they are told it did not, once, on their channel (never after STOP).
      await o.rpc("career_apply_prepare_request_notice", { p_id: r.id, p_lease: r.lease_token, p_text: RUNNER_UNAVAILABLE_TEXT }).catch(() => {});
      await o.rpc("career_apply_prepare_request_finish", { p_id: r.id, p_lease: r.lease_token, p_state: "failed",
        p_outcome: { reason: "RUNNER_UNAVAILABLE", detail: why }, p_card: null }).catch(() => {});
      out.unavailable.push({ request: r.id, why });
    }
  }
  log(`prepare dispatch: claimed ${out.claimed}, started ${out.started.length}, not started ${out.unavailable.length}`);
  return out;
}

// The chat's kick (agent-chat kickPrepare): { user_id, job_ids }, any number of them (the database splits a big request
// into parts; nothing is cut). 202 when the request is accepted (it runs now or within the minute); 429 only when a
// per-person number was set and today's is used (the chat then says it has not started); 400/409 on anything else. The
// token is checked by the caller.
export async function handlePrepareDoor(body: any, d: { rpc: Rpc; perPersonDay: number | null; kick?: () => void }): Promise<{ status: number; body: unknown }> {
  const user = String(body?.user_id ?? "");
  const ids = Array.isArray(body?.job_ids) ? body.job_ids.map(String).filter((x: string) => x && x.length <= 300) : [];
  if (!UUID.test(user) || !ids.length) return { status: 400, body: { error: "bad request" } };
  let r: any;
  try {
    r = await d.rpc("career_apply_prepare_request_put", { p_user: user, p_job_ids: ids, p_per_person_day: d.perPersonDay });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return { status: 409, body: { error: /nothing_to_prepare/.test(msg) ? "nothing to prepare" : "refused" } };
  }
  if (!r?.accepted) return { status: 429, body: { request: r?.id ?? null, waiting_for: r?.waiting_for ?? "per_person_day" } };
  d.kick?.();
  return { status: 202, body: { accepted: typeof r.postings === "number" ? r.postings : ids.length, request: r.id } };
}

// ------------------------------------------------------------------------------------------------ the bridge
// What the sandbox may call. Every one names the person from the request row, never from the body; the posting-scoped
// ones must name one of the request's postings.
const PERSON_RPCS = new Set(["career_apply_answers_for", "career_apply_profile_for"]);
const POSTING_RPCS = new Set(["career_apply_prepare_attempt_for", "career_apply_prepare_ask_for", "career_apply_prepare_for"]);
export const PREPARE_OPS = ["request", "rpc", "resume", "finish"] as const;
export interface PrepareBridgeDeps {
  rpc: Rpc;
  readRequest: (id: string) => Promise<PrepareRequestRow | null>;
  secret: string;
  stop?: (sandbox: string) => Promise<void>;
  now?: () => number;
}
const refuse = (status: number, error: string) => ({ status, body: { error } });

export async function handlePrepareBridge(op: string, body: any, d: PrepareBridgeDeps): Promise<{ status: number; body: unknown }> {
  if (!(PREPARE_OPS as readonly string[]).includes(op)) return refuse(404, "unknown operation");
  const id = String(body?.id ?? ""), sandbox = String(body?.sandbox ?? ""), token = String(body?.token ?? "");
  if (!UUID.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(sandbox) || !/^[0-9a-f]{64}$/.test(token)) return refuse(400, "invalid request");
  let row: PrepareRequestRow | null;
  try { row = await d.readRequest(id); } catch { return refuse(503, "the requests could not be read"); }
  const now = (d.now ?? Date.now)();
  if (!row || row.state !== "running" || !row.lease_token || !row.claimed_at || Date.parse(row.claimed_at) <= now - 15 * 60_000 ||
    !sameText(token, await prepareToken(d.secret, id, row.lease_token, sandbox))) return refuse(403, "not this sandbox's request");
  const user = row.user_id, lease = row.lease_token, postings = new Set(row.job_ids);
  try {
    switch (op as typeof PREPARE_OPS[number]) {
      case "request":
        return { status: 200, body: { id, user_id: user, job_ids: row.job_ids } };
      case "resume":
        return { status: 200, body: await d.rpc("career_apply_cloud_resume_kept_for", { p_user: user }) };
      case "rpc": {
        const name = String(body?.name ?? ""), args = body?.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
        if (name === "career_apply_prepare_candidates") {
          const rows = await d.rpc(name, { p_now: new Date(now).toISOString(), p_per_person: 25, p_limit: 500 });
          return { status: 200, body: (Array.isArray(rows) ? rows : []).filter((c: any) => c?.user_id === user && postings.has(String(c?.job_id))) };
        }
        if (PERSON_RPCS.has(name)) return { status: 200, body: await d.rpc(name, { p_user: user }) };
        if (POSTING_RPCS.has(name)) {
          if (!postings.has(String(args.p_posting_job_id ?? ""))) return refuse(403, "not one of this request's postings");
          if (args.p_user !== undefined && args.p_user !== user) return refuse(403, "not this request's person");
          if (name === "career_apply_prepare_for") {
            // The sandbox read a page nobody trusts: the application must be for the link this request asked for, and
            // its card must say exactly what it sends (career_prepared_card.ts), or nothing is stored.
            const posting = await d.rpc("career_apply_prepare_request_posting", { p_id: id, p_lease: lease, p_posting: String(args.p_posting_job_id) });
            const payload = args.p_payload;
            if (!posting || typeof posting.url !== "string" || !payload || typeof payload !== "object" || payload.url !== posting.url) {
              return refuse(403, "not the application for this request's posting");
            }
            const kept = await d.rpc("career_apply_cloud_resume_kept_for", { p_user: user });
            const problem = preparedCardProblem(payload, args.p_card_lines, kept && typeof kept.filename === "string" ? { filename: kept.filename } : null);
            if (problem) return refuse(422, `card refused: ${problem}`);
          }
          // A try names no prepared application from the sandbox: only career_apply_prepare_for (checked above) links one, and
          // never with outcome 'ready' (that is what a stored, checked application records itself).
          if (name === "career_apply_prepare_attempt_for" && (args.p_prepared != null || args.p_outcome === "ready")) {
            return refuse(403, "a try cannot name a prepared application");
          }
          return { status: 200, body: await d.rpc(name, { ...args, p_user: user }) };
        }
        return refuse(403, "not a preparation call");
      }
      case "finish": {
        const outcomes = Array.isArray(body?.outcomes) ? body.outcomes.slice(0, 100).map((o: any) => ({
          job_id: String(o?.job_id ?? "").slice(0, 300), outcome: String(o?.outcome ?? "").slice(0, 20), detail: String(o?.detail ?? "").slice(0, 300),
        })) : [];
        // The card the person asked for, shown now: every application this request made ready, as the card shows them.
        const ready = await d.rpc("career_apply_prepare_request_ready", { p_id: id, p_lease: lease });
        let card: string | null = null, push = "nothing_ready";
        const c = Array.isArray(ready) && ready.length ? cardFor(ready.filter((r: any) => { const one = cardFor([r]); return one !== null && "take" in one; })) : null;
        if (c && "take" in c) {
          card = await d.rpc("career_apply_card_push_requested_for", { p_user: user, p_request: id, p_ids: c.take.map((p) => p.id), p_text: c.text,
            p_now: new Date(now).toISOString() });
          push = card ? "shown" : "held";
        }
        // Nothing ready because the form asks what they have not told Trainee: those questions, texted now, numbered as
        // "what do you need from me" shows them, so their numbered answers are saved by the questions turn.
        let questions = 0;
        if (!card) {
          const open = await d.rpc("career_apply_prepare_request_questions", { p_id: id, p_lease: lease });
          const t = Array.isArray(open) && open.length ? questionsText(open as OpenQuestion[], open.length) : null;
          if (t && await d.rpc("career_apply_questions_push_requested_for", { p_user: user, p_request: id, p_ids: t.take.map((q) => q.id),
            p_text: t.text, p_now: new Date(now).toISOString() })) { questions = t.take.length; push = "questions"; }
        }
        // Nothing to show and nothing to ask: they are told why, in their words, once.
        let told = false;
        if (!card && !questions && push !== "held" && !outcomes.some((o: { outcome: string }) => o.outcome === "asked" || o.outcome === "ready")) {
          told = !!await d.rpc("career_apply_prepare_request_notice", { p_id: id, p_lease: lease, p_text: notPreparedText(outcomes) });
          if (told) push = "told";
        }
        const r = await d.rpc("career_apply_prepare_request_finish", { p_id: id, p_lease: lease, p_state: "done",
          p_outcome: { outcomes, ready: Array.isArray(ready) ? ready.length : 0, card: push, questions }, p_card: card });
        if (d.stop) await d.stop(sandbox).catch(() => {});
        return { status: 200, body: { state: r?.state ?? null, card, push, questions } };
      }
    }
  } catch (e) {
    return refuse(409, String((e as Error)?.message ?? e).slice(0, 300));
  }
  return refuse(404, "unknown operation");
}

// Why nothing could be prepared, per posting, in the person's words: never an engine code, and always that nothing was sent.
const NOT_READY: Record<string, string> = {
  no_resume: "I don't have your resume file to attach. Send your resume here as a PDF or Word file, say it's yours, then ask again",
  refused: "the employer's form could not be filled ahead of time",
  error: "preparing it failed on my side",
};
export function notPreparedText(outcomes: { outcome: string }[]): string {
  const whys = [...new Set(outcomes.filter((o) => o.outcome !== "ready" && o.outcome !== "asked").map((o) => NOT_READY[o.outcome] ?? NOT_READY.error))];
  if (!outcomes.length) {
    return "I couldn't prepare the application you asked for: it is no longer open on file, it was already prepared or tried this week, or you applied to that employer in the last 30 days. Nothing was sent.";
  }
  return `I couldn't prepare the application you asked for: ${whys.join("; ") || NOT_READY.error}. Nothing was sent.`;
}
