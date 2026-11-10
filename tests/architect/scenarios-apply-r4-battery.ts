// Apply and mass submission, round 4 (architect, 2026-11-05), in memory. Real employer submission is on (D-041), so this round
// is about what changes WHILE an approved application is on its way, on the submit path's own code (no copy of it):
//   bridge    the job bridge a cloud sandbox talks to (cloud_runner.ts handleBridge, jobToken): the lease swept (expired) or
//             handed to a second worker while the first sandbox still holds its token, the row finished, erased (gone), a
//             token minted for another sandbox or another job, a forged lease in the request, the queue unreadable.
//   flag      the runner's HTTP door (cloud_runner_http.ts createRunnerHandler) with CLOUD_RUNNER_ENABLED flipping between a
//             sandbox's steps (on, rolled back, odd values): the authorization before the engine and before the one Submit.
//   dispatch  one dispatcher tick (cloud_runner.ts dispatch): the claim failing or malformed, sandboxes that cannot be created
//             or started (after their retries), the not-sent record failing, the optional per-person and per-site numbers.
//   mail      the employer's email against the queue (career_apply_confirm.ts planConfirmations): a confirmation for a
//             different job at the same employer, a re-posted job (same title, new posting), the same posting closed as a
//             duplicate, none at all, late (after 14 days), early (before the application went), spoofed or unauthenticated.
//   words     what the person is told about every state (career_apply_status.ts statusReply / statusLine / countsLine and
//             apply_status_summary.ts applySummary / overclaims), every reason a worker or the database records, this round's
//             new ones included.
//   posting   one posting's identity across its links (career_apply.ts postingKey, admitApplication): the same posting under
//             every variant link is one posting (refused a second time); a re-posted job, the same number on another board
//             or another ATS is another posting.
// Invariants (every scenario): nothing is forwarded to the database for a sandbox that does not hold the job's current lease,
// and never with a lease or person taken from the request; no authorization reaches the database while sending is rolled
// back, and every started application can still record its outcome; every claimed job is started exactly once or recorded as
// not sent; an email confirms at most one application, only one that went (or may have gone), from that employer, authenticated,
// after it went and within 14 days, for that role; two that fit are asked about, never guessed; the person is told "submitted"
// only for an application the employer took, "confirmed" only for one the employer confirmed, "applied" never without one,
// counts that add up, no code and no company that is not theirs; one posting is one application, ever.
import { BRIDGE_OPS, type ClaimedJob, dispatch, handleBridge, jobToken, type SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { createRunnerHandler } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { releaseValue } from "../../supabase/functions/agent-chat/release_config.ts";
import { planConfirmations, type QueueRow } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { type AppRow, countsLine, statusLine, statusReply } from "../../supabase/functions/_shared/career_apply_status.ts";
import { applySummary, overclaims } from "../../supabase/functions/_shared/apply_status_summary.ts";
import { admitApplication, postingKey } from "../../supabase/functions/_shared/career_apply.ts";
import { type MailIn, parseFrom, sameCompany } from "../../supabase/functions/_shared/career_mail.ts";
import { CODES, readableReason, rng } from "./scenarios-submit-worker-battery.ts";

export const SEED = 20261105;
export const N = Number(Deno.env.get("APPLY_R4_N") ?? 10_000);
// Built at run time, never a literal secret.
const SECRET = ["TEST", "r4", "runner", "secret", "0123456789abcdef0123456789"].join("-");
const SERVICE = ["TEST", "r4", "service", "key"].join("-");
const UUID = () => crypto.randomUUID();

// ------------------------------------------------------------------------------------------------ the scenarios
export const BRIDGE_EVENTS = ["op_a", "op_a", "op_a", "op_b", "op_forged_lease", "op_other_sandbox", "op_other_job", "swept", "reclaimed_by_b",
  "finished", "erased", "read_fails", "rpc_fails"] as const;
export const FLAG_VALUES = [undefined, "on", "ON", " on ", "", "off", "OFF", "yes", "0"] as const;
export const SENT_STATES = ["confirmed", "submitted_unconfirmed"] as const;
export const STATES = ["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"] as const;
// This round's reasons, on top of every code the earlier rounds named (scenarios-submit-worker-battery.ts CODES).
export const R4_REASONS = ["duplicate_job", "posting_closed", "switch_off", "not_opted_in", "lease_lost", "account_changed", "RUNNER_UNAVAILABLE",
  "cloud sending is off", "authorize", "worker_lost_before_submit", "WORKER_STOPPED", "email_code",
  "not sent: this exact posting was already sent (recorded after you approved this one)", "not sent: the posting closed before we sent it",
  "application outcome unknown: the worker stopped after Submit was pressed; not retried", "missing_required_answer: Why do you want to work here?"] as const;
export const MAIL_KINDS = ["right", "right", "other_job", "reposted", "no_role", "late", "early", "spoof_unauth", "spoof_board", "dup_hash", "rejection"] as const;
export const POSTING_VARIANTS = ["same", "case", "www", "slash", "apply", "utm", "gh_src", "gh_jid", "job_boards", "port", "lever_tracking", "reorder"] as const;
export const POSTING_OTHERS = ["reposted", "other_board", "other_ats", "other_number"] as const;

export type Scenario =
  | { n: number; family: "bridge"; events: typeof BRIDGE_EVENTS[number][]; ops: string[] }
  | { n: number; family: "flag"; steps: { op: string; flag: typeof FLAG_VALUES[number] }[] }
  | { n: number; family: "dispatch"; claim: "rows" | "throws" | "not_array"; jobs: number; createFails: number[]; runFails: number[]; finishFails: number; limits: "both" | "one" | "none" }
  | { n: number; family: "mail"; rows: { state: typeof STATES[number]; title: number; company: number; ageH: number }[]; mails: { kind: typeof MAIL_KINDS[number]; row: number; atH: number }[] }
  | { n: number; family: "words"; rows: { state: typeof STATES[number]; reason: string | null; company: number; ageD: number }[]; ask: number }
  | { n: number; family: "posting"; ats: "greenhouse" | "lever" | "ashby"; variants: typeof POSTING_VARIANTS[number][]; other: typeof POSTING_OTHERS[number] };

export function generate(seed = SEED, n = N): Scenario[] {
  const r = rng(seed), out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r.next();
    if (roll < 0.2) {
      out.push({ n: i, family: "bridge", events: Array.from({ length: r.int(2, 9) }, () => r.pick(BRIDGE_EVENTS)),
        ops: Array.from({ length: 12 }, () => r.pick([...BRIDGE_OPS, "nope"])) });
    } else if (roll < 0.32) {
      out.push({ n: i, family: "flag", steps: Array.from({ length: r.int(2, 7) }, () => ({ op: r.pick(["job", "sources", "authorize", "authorize", "resume", "finish"]), flag: r.pick(FLAG_VALUES) })) });
    } else if (roll < 0.47) {
      const jobs = r.int(0, 6);
      out.push({ n: i, family: "dispatch", claim: r.chance(0.08) ? r.pick(["throws", "not_array"] as const) : "rows", jobs,
        createFails: Array.from({ length: jobs }, () => r.pick([0, 0, 0, 1, 2, 3, 9])), runFails: Array.from({ length: jobs }, () => r.pick([0, 0, 0, 0, 1, 3])),
        finishFails: r.pick([0, 0, 1, 2, 3]), limits: r.pick(["both", "one", "none"] as const) });
    } else if (roll < 0.67) {
      const rows = Array.from({ length: r.int(1, 4) }, () => ({ state: r.pick(STATES), title: r.int(0, 1), company: r.int(0, 2), ageH: r.int(-3, 24 * 20) }));
      out.push({ n: i, family: "mail", rows, mails: Array.from({ length: r.int(0, 3) }, () => ({ kind: r.pick(MAIL_KINDS), row: r.int(0, rows.length - 1), atH: r.int(0, 30) })) });
    } else if (roll < 0.88) {
      const pool = [...CODES, ...R4_REASONS];
      out.push({ n: i, family: "words", ask: r.int(0, 3),
        rows: Array.from({ length: r.int(0, 12) }, () => ({ state: r.pick(STATES), reason: r.pick(pool) as string | null, company: r.int(0, 5), ageD: r.int(0, 40) })) });
    } else {
      out.push({ n: i, family: "posting", ats: r.pick(["greenhouse", "lever", "ashby"] as const),
        variants: Array.from({ length: r.int(1, 4) }, () => r.pick(POSTING_VARIANTS)), other: r.pick(POSTING_OTHERS) });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ family: bridge
// The database's side as the bridge sees it: one row, its lease, its state. The oracle: an op is the sandbox's only while the
// row exists, is driven by the cloud, and its token names this job, this sandbox and the lease the row holds NOW.
export async function runBridge(s: Extract<Scenario, { family: "bridge" }>): Promise<string[]> {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} bridge [${s.events.join(",")}]: ${m}`);
  const id = UUID(), other = UUID(), L1 = UUID(), L2 = UUID(), user = UUID(), MARK = `VSECRET-payload-${s.n}`;
  let row: ClaimedJob | null = { id, lease_token: L1, user_id: user, company: "TEST Employer", url: "https://jobs.lever.co/r4/1", payload: { mark: MARK },
    payload_hash: "a".repeat(64), approval_hash: "a".repeat(64), job_id: "lever:r4:1", state: "driving", source: "cloud" };
  const holders = { a: { sandbox: "sbx_A", lease: L1 }, b: { sandbox: "sbx_B", lease: "" } };
  let readFails = false, rpcFails = false;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (rpcFails) { rpcFails = false; throw Error("career_apply_cloud_finish: 400 invalid apply claim"); }
    return name === "career_apply_cloud_finish" ? { state: "submitted_unconfirmed" } : { ok: true };
  };
  const readJob = async (x: string) => {
    if (readFails) { readFails = false; throw Error("read 503"); }
    return row && row.id === x ? structuredClone(row) : null;
  };
  let k = 0;
  for (const e of s.events) {
    if (e === "swept" && row) row.state = "unknown_outcome";
    if (e === "reclaimed_by_b" && row) { row.lease_token = L2; row.state = "driving"; holders.b.lease = L2; }
    if (e === "finished" && row) row.state = "submitted_unconfirmed";
    if (e === "erased") row = null;
    if (e === "read_fails") readFails = true;
    if (e === "rpc_fails") rpcFails = true;
    if (!e.startsWith("op_")) continue;
    const op = s.ops[k++ % s.ops.length];
    const who = e === "op_b" ? holders.b : holders.a;
    const jobId = e === "op_other_job" ? other : id, sandbox = e === "op_other_sandbox" ? "sbx_X" : who.sandbox;
    if (!who.lease) continue; // B holds nothing until it is handed the job
    const token = await jobToken(SECRET, e === "op_other_job" ? other : id, who.lease, who.sandbox);
    const forged = e === "op_forged_lease" ? { p_lease: L2, lease_token: L2, user_id: UUID(), p_user: UUID() } : {};
    const before = calls.length, wasReadFail = readFails;
    const snapshot = row ? structuredClone(row) : null;
    const reply = await handleBridge(op, { id: jobId, sandbox, token, p_hash: "a".repeat(64), p_source_digest: "b".repeat(64), questions: [], state: "submitted_unconfirmed",
      evidence: {}, outcome: "submitted", ...forged }, { rpc, readJob, secret: SECRET, stop: async () => {} });
    const mine = !wasReadFail && !!snapshot && snapshot.state === "driving" && snapshot.source === "cloud" && jobId === snapshot.id &&
      sandbox === who.sandbox && who.lease === snapshot.lease_token && (BRIDGE_OPS as readonly string[]).includes(op);
    const forwarded = calls.slice(before);
    const text = JSON.stringify(reply.body ?? null);
    if (!mine) {
      if (forwarded.length) fail(`${op} by a sandbox that does not hold the lease was forwarded: ${forwarded.map((c) => c.name).join(",")}`);
      if (reply.status < 400) fail(`${op} not this sandbox's, answered ${reply.status}`);
      if (text.includes(MARK)) fail(`${op} refused, but the reply carries the payload`);
      continue;
    }
    if (op === "job") {
      if (reply.status !== 200 || !text.includes(MARK)) fail(`its own job not read back: ${reply.status}`);
      if (forwarded.length) fail("reading the job called the database");
      continue;
    }
    if (forwarded.length !== 1) { fail(`${op}: ${forwarded.length} database calls`); continue; }
    const a = forwarded[0].args;
    if (op === "sources" && a.p_user !== snapshot!.user_id) fail("sources read for a person the request named");
    if (op !== "sources" && (a.p_id !== snapshot!.id || a.p_lease !== snapshot!.lease_token)) fail(`${op}: forwarded under a lease or job the database did not hand out`);
    if (Object.values(a).some((v) => v === L2 && snapshot!.lease_token !== L2)) fail(`${op}: the request's own lease reached the database`);
    if (reply.status >= 500) fail(`${op}: a database refusal answered ${reply.status}`);
    if (reply.status === 409 && /service|key|Bearer/i.test(text)) fail(`${op}: the refusal carries a credential`);
  }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: flag
// The runner's door with CLOUD_RUNNER_ENABLED changing between a sandbox's steps. A fake PostgREST holds the one job.
export async function runFlag(s: Extract<Scenario, { family: "flag" }>): Promise<string[]> {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} flag [${s.steps.map((x) => `${x.op}@${x.flag}`).join(",")}]: ${m}`);
  const id = UUID(), lease = UUID(), user = UUID(), sandbox = "sbx_flag";
  const row = { id, lease_token: lease, user_id: user, company: "TEST Employer", url: "https://jobs.ashbyhq.com/r4/1", payload: { x: 1 }, payload_hash: "c".repeat(64),
    approval_hash: "c".repeat(64), job_id: "ashby:r4:1", state: "driving", source: "cloud" };
  const env: Record<string, string | undefined> = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: SERVICE, CLOUD_RUNNER_SECRET: SECRET };
  const rpcs: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.origin !== "http://supabase.test") throw Error(`the runner reached ${u.origin}`);
    if (u.pathname === "/rest/v1/career_apply_jobs") return new Response(JSON.stringify([row]), { status: 200 });
    const name = u.pathname.split("/").at(-1)!;
    rpcs.push(name);
    void init;
    if (name === "career_apply_cloud_authorize_any") return new Response(JSON.stringify({ authorized: true, job_id: id, lease_token: lease, payload_hash: row.payload_hash }), { status: 200 });
    if (name === "career_apply_cloud_finish") return new Response(JSON.stringify({ state: "not_submitted" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const h = createRunnerHandler({ env: { get: (k) => env[k] }, fetch: f, host: { create: async () => "x", run: async () => {}, stop: async () => {} } });
  const token = await jobToken(SECRET, id, lease, sandbox);
  for (const st of s.steps) {
    if (st.flag === undefined) delete env.CLOUD_RUNNER_ENABLED; else env.CLOUD_RUNNER_ENABLED = st.flag;
    const on = releaseValue({ get: (k) => env[k] }, "CLOUD_RUNNER_ENABLED") === "on";
    const before = rpcs.length;
    const res = await h(new Request(`http://runner.test/functions/v1/career-cloud-runner/job/${st.op}`, { method: "POST",
      body: JSON.stringify({ id, sandbox, token, p_hash: row.payload_hash, p_source_digest: "d".repeat(64), state: "not_submitted", evidence: { reason: "TEST" }, outcome: "not_sent" }) }));
    const body = await res.text();
    const authorized = rpcs.slice(before).includes("career_apply_cloud_authorize_any");
    if (st.op === "authorize" && !on && authorized) fail(`the Submit authorization reached the database with sending rolled back (${JSON.stringify(st.flag)})`);
    if (st.op === "authorize" && !on && (res.status < 400 || /"authorized":true/.test(body))) fail(`authorization answered ${res.status} with sending rolled back`);
    if (st.op === "authorize" && on && !authorized) fail(`authorization not asked while sending is on (${res.status} ${body.slice(0, 80)})`);
    if (st.op === "finish" && !rpcs.slice(before).includes("career_apply_cloud_finish")) fail(`a started application could not record its outcome (${JSON.stringify(st.flag)}): ${res.status}`);
    if (body.includes(SERVICE)) fail("a reply carries the service key");
  }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: dispatch
export async function runDispatch(s: Extract<Scenario, { family: "dispatch" }>): Promise<string[]> {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} dispatch ${s.claim}/${s.jobs} create=${s.createFails} run=${s.runFails} finish=${s.finishFails} ${s.limits}: ${m}`);
  const jobs: ClaimedJob[] = Array.from({ length: s.jobs }, (_, i) => ({ id: UUID(), lease_token: UUID(), user_id: UUID(), company: `TEST ${i}`, url: `https://boards.greenhouse.io/r4/jobs/${i}`,
    payload: {}, payload_hash: "e".repeat(64), approval_hash: "e".repeat(64) }));
  const rpcs: { name: string; args: any }[] = [];
  let finishFails = s.finishFails;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ name, args });
    if (name.startsWith("career_apply_cloud_dispatch_claim")) {
      if (s.claim === "throws") throw Error("TEST queue unreachable");
      return s.claim === "not_array" ? { rows: jobs } : jobs;
    }
    if (name === "career_apply_cloud_finish") { if (finishFails-- > 0) throw Error("TEST finish failed"); return { state: "not_submitted" }; }
    throw Error(`unexpected ${name}`);
  };
  const createLeft = new Map<string, number>(), runLeft = new Map<string, number>();
  const created: { name: string; id: string }[] = [], ran: { sandbox: string; env: Record<string, string> }[] = [], stopped: string[] = [];
  const of = (name: string) => jobs.findIndex((j) => name.includes(j.id.slice(0, 8)));
  const host: SandboxHost = {
    create: async ({ name }) => {
      const i = of(name), left = createLeft.get(String(i)) ?? s.createFails[i];
      if (left > 0) { createLeft.set(String(i), left - 1); throw Error("TEST no capacity"); }
      const sid = `sbx_${i}_${created.length}`;
      created.push({ name, id: sid });
      return sid;
    },
    run: async (sandbox, env) => {
      const i = Number(sandbox.split("_")[1]), left = runLeft.get(String(i)) ?? s.runFails[i];
      if (left > 0) { runLeft.set(String(i), left - 1); throw Error("TEST run refused"); }
      ran.push({ sandbox, env: { ...env } });
    },
    stop: async (sandbox) => { stopped.push(sandbox); },
  };
  const limits = { want: 30, global: 60, perPortal: 20, ...(s.limits === "both" ? { perPersonDay: 3, perSiteMinute: null } : s.limits === "one" ? { perPersonDay: 3 } : {}) };
  const out = await dispatch({ rpc, host, limits, secret: SECRET, bridgeUrl: "http://runner.test/functions/v1/career-cloud-runner", retry: { sleep: async () => {} }, log: () => {} });
  const claimName = rpcs[0]?.name;
  if (claimName !== (s.limits === "both" ? "career_apply_cloud_dispatch_claim2" : "career_apply_cloud_dispatch_claim")) fail(`claimed through ${claimName}`);
  if (s.claim !== "rows") {
    if (out.started.length || ran.length || created.length || rpcs.some((c) => c.name === "career_apply_cloud_finish")) fail("a failed claim started or recorded something");
    if (!out.claim_error) fail("a failed claim was not reported");
    return bad;
  }
  for (const [i, j] of jobs.entries()) {
    const started = out.started.filter((x) => x.job === j.id), unavailable = out.unavailable.filter((x) => x.job === j.id);
    if (started.length + unavailable.length !== 1) { fail(`job ${i}: started ${started.length}, not started ${unavailable.length}`); continue; }
    const runs = ran.filter((x) => x.env.CLOUD_JOB_ID === j.id);
    const mine = created.filter((c) => c.name.includes(j.id.slice(0, 8))).map((c) => c.id);
    if (started.length) {
      if (runs.length !== 1) fail(`job ${i}: started in ${runs.length} sandboxes`);
      const r = runs[0];
      if (r && (r.env.CLOUD_SANDBOX_ID !== r.sandbox || r.env.CLOUD_JOB_TOKEN !== await jobToken(SECRET, j.id, j.lease_token, r.sandbox))) fail(`job ${i}: its token does not bind its job, lease and sandbox`);
      if (r && Object.values(r.env).some((v) => v.includes(SECRET) || v.includes(SERVICE))) fail(`job ${i}: a secret in the sandbox's environment`);
      if (stopped.includes(started[0].sandbox)) fail(`job ${i}: its running sandbox was stopped`);
      for (const sid of mine.filter((x) => x !== started[0].sandbox)) if (!stopped.includes(sid)) fail(`job ${i}: a sandbox that failed to start was left running`);
      if (rpcs.some((c) => c.name === "career_apply_cloud_finish" && c.args.p_id === j.id)) fail(`job ${i}: started and also recorded not sent`);
    } else {
      if (runs.length) fail(`job ${i}: not started, yet a sandbox ran it`);
      for (const sid of mine) if (!stopped.includes(sid)) fail(`job ${i}: a sandbox it could not start was left running`);
      const fin = rpcs.filter((c) => c.name === "career_apply_cloud_finish" && c.args.p_id === j.id);
      if (!fin.length || fin.length > 3) fail(`job ${i}: recorded not sent ${fin.length} times`);
      if (fin.some((c) => c.args.p_lease !== j.lease_token || c.args.p_state !== "not_submitted" || c.args.p_outcome !== "not_sent" || c.args.p_error_kind !== "RUNNER_UNAVAILABLE"))
        fail(`job ${i}: not recorded as not sent under its own lease`);
    }
  }
  if (out.claimed !== jobs.length) fail(`claimed ${out.claimed} of ${jobs.length}`);
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: mail
const COMPANIES = [{ name: "Stripe", url: "https://job-boards.greenhouse.io/stripe/jobs/", from: "Stripe <no-reply@us.greenhouse-mail.io>" },
  { name: "Plaid", url: "https://jobs.lever.co/plaid/", from: "Plaid <no-reply@hire.lever.co>" },
  { name: "Ramp", url: "https://jobs.ashbyhq.com/ramp/", from: "Ramp <no-reply@ashbyhq.com>" }];
const TITLES = ["Data Analyst", "Software Engineer, Payments"];
const OPEN = new Set(["submitted_unconfirmed", "unknown_outcome", "confirmed", "driving"]);
const authFor = (from: string) => {
  const d = parseFrom(from).domain;
  return [`mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=AbC; spf=pass (google.com: domain of bounce@${d} designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${d}`];
};
export function runMail(s: Extract<Scenario, { family: "mail" }>): string[] {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} mail ${JSON.stringify(s)}: ${m}`);
  const NOW = Date.parse("2026-11-05T12:00:00Z"), H = 3_600_000, DAY = 24 * H;
  // A row already confirmed by an email carries that email's hash (it is not open to another).
  const rows: QueueRow[] = s.rows.map((r, i) => ({ id: `J${i}`, company: COMPANIES[r.company].name, title: TITLES[r.title], url: `${COMPANIES[r.company].url}${4000 + i}`, state: r.state,
    submitted_at: new Date(NOW - r.ageH * H).toISOString(), confirmation_hash: r.state === "confirmed" ? `${i}`.repeat(64).slice(0, 64) : null }));
  // Each mail is about one row's employer (its kind says how it relates to that row).
  type M = MailIn & { kind: string; about: number; role: string | null; genuine: boolean };
  const mails: M[] = [];
  for (const [i, m] of s.mails.entries()) {
    // The same message read twice (the mail run reads each new message once; a re-read is the same hash and the same text).
    if (m.kind === "dup_hash" && mails.length) { mails.push({ ...mails[0] }); continue; }
    const row = rows[m.row], c = COMPANIES[s.rows[m.row].company], sent = Date.parse(row.submitted_at);
    const role = m.kind === "no_role" ? null : m.kind === "other_job" ? TITLES[1 - s.rows[m.row].title] : row.title!;
    const at = m.kind === "late" ? sent + 15 * DAY + m.atH * H : m.kind === "early" ? sent - (m.atH + 1) * H : sent + m.atH * H;
    const from = m.kind === "spoof_board" ? `${c.name} Careers <jobs@indeed.com>` : c.from;
    const subject = m.kind === "rejection" ? `Your application to ${c.name}` : `Thank you for applying to ${c.name}`;
    const snippet = m.kind === "rejection" ? `Thank you for your interest in the ${role} role. Unfortunately we have decided to move forward with other candidates.`
      : role ? `We have received your application for the ${role} role and will review it shortly.` : "We have received your application and will review it shortly.";
    mails.push({ hash: String.fromCharCode(97 + i).repeat(64), date: new Date(at).toISOString(), from, subject, snippet,
      auth: m.kind === "spoof_unauth" ? [] : authFor(from), kind: m.kind, about: m.row, role, genuine: !["spoof_unauth", "spoof_board"].includes(m.kind) });
  }
  const plan = planConfirmations(mails, rows);
  // The oracle: the rules applied in the order the emails arrive (an email that already confirmed one is read once).
  const hashed = new Map(rows.map((r) => [r.id, r.confirmation_hash ?? null]));
  const expected: string[] = [];
  for (const m of [...mails].sort((a, b) => a.date.localeCompare(b.date))) {
    if ([...hashed.values()].includes(m.hash)) continue;
    const at = Date.parse(m.date);
    const fits = rows.filter((r) => OPEN.has(r.state) && !hashed.get(r.id) && m.genuine && r.company === COMPANIES[s.rows[m.about].company].name &&
      Date.parse(r.submitted_at) <= at && at - Date.parse(r.submitted_at) <= 14 * DAY && (!m.role || m.role === r.title));
    if (fits.length === 1) { hashed.set(fits[0].id, m.hash); expected.push(`confirm ${fits[0].id} by ${m.kind}`); }
    else if (fits.length > 1) expected.push(`ask ${fits.map((r) => r.id).sort().join("/")} by ${m.kind}`);
  }
  const got = plan.map((p) => `${p.kind === "confirm" ? `confirm ${p.id}` : `ask ${[...p.ids].sort().join("/")}`} by ${mails.find((m) => m.hash === p.hash)!.kind}`);
  if (got.join("; ") !== expected.join("; ")) fail(`planned [${got.join("; ")}], the rules say [${expected.join("; ")}]`);
  const perRow = new Map<string, number>();
  for (const p of plan) if (p.kind === "confirm") perRow.set(p.id, (perRow.get(p.id) ?? 0) + 1);
  for (const [id, k] of perRow) if (k > 1) fail(`${id} confirmed by ${k} emails`);
  for (const p of plan) {
    if (p.kind !== "confirm") continue;
    const r = rows.find((x) => x.id === p.id)!, m = mails.find((x) => x.hash === p.hash)!;
    if (!OPEN.has(r.state)) fail(`confirmed a ${r.state} application (nothing went)`);
    if (!m.genuine) fail(`confirmed by a ${m.kind} email`);
    if (Date.parse(m.date) < Date.parse(r.submitted_at)) fail("confirmed by an email from before the application went");
    if (m.role && m.role !== r.title) fail("confirmed by an email about another role");
  }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: words
const WORD_COMPANIES = ["Acme", "Beta Labs", "Gamma & Sons", "Zeta Ünïcode GmbH", "Acme Robotics", ""];
const ASKS = ["where are my applications", "did my application to Acme go through?", "did it go through?", "what's the status of my application to Beta Labs"];
const SAYS_SUBMITTED = /:\s*(?:submitted\b|sent, but not finished)/;
export function runWords(s: Extract<Scenario, { family: "words" }>): string[] {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} words: ${m}`);
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const rows: AppRow[] = s.rows.map((r, i) => ({ id: `J${i}`, job_id: `lever:w:${i}`, company: WORD_COMPANIES[r.company], state: r.state, reason: r.reason,
    created_at: new Date(NOW - r.ageD * 86_400_000).toISOString(), updated_at: new Date(NOW - r.ageD * 86_400_000).toISOString(),
    confirmation_id: r.state === "confirmed" || r.state === "submitted_unconfirmed" ? (i % 2 ? `C-${i}` : null) : null,
    // architect ruling 13-Obs (2026-11-09): a "confirmed" row is confirmed by the employer's matched email (D-024).
    email_confirmed_at: r.state === "confirmed" ? new Date(NOW - 3_600_000).toISOString() : null }));
  for (const a of rows) {
    const line = statusLine(a);
    const took = a.state === "confirmed" || a.state === "submitted_unconfirmed" || (a.state === "needs_user" && a.reason === "email_code");
    if (SAYS_SUBMITTED.test(line) !== took) fail(`${a.state}/${a.reason}: ${took ? "a sent application not said as sent" : "said as sent although the employer took nothing"}: ${line}`);
    if (/, and .* confirmed it\b/.test(line) !== (a.state === "confirmed")) fail(`${a.state}: "confirmed" ${a.state === "confirmed" ? "missing" : "said"}: ${line}`);
    if (/\bapplied\b/i.test(line)) fail(`"applied" in a status line: ${line}`);
    if (!readableReason(line)) fail(`the person reads a code: ${line}`);
    if (/not sent \(not sent/i.test(line)) fail(`"not sent" twice: ${line}`);
    if (["not_submitted", "failed", "queued", "driving"].includes(a.state) && /\bit will not be sent again\b/i.test(line)) fail(`an unsent one is said never to be sent: ${line}`);
  }
  const ask = ASKS[s.ask], res = statusReply(ask, rows, NOW);
  if (!res) { fail(`not read as a status question: ${ask}`); return bad; }
  const sum = applySummary(rows);
  const total = Object.values(sum.counts).reduce((k, v) => k + v, 0);
  if (total !== rows.length || sum.applied_ok !== rows.filter((r) => r.state === "confirmed").length) fail(`summary counts ${JSON.stringify(sum.counts)} for ${rows.length} rows`);
  if (!sum.applied_ok && !overclaims("I applied to all of them.", sum).length) fail("'applied' passes with nothing confirmed");
  if (rows.length > 1) {
    const counts = countsLine(rows), nums = [...counts.matchAll(/(\d+) [a-z]/g)].map((m) => Number(m[1]));
    if (nums[0] !== rows.length || nums.slice(1).reduce((k, v) => k + v, 0) !== rows.length) fail(`counts do not add up: ${counts}`);
    const said = Number(/(\d+) submitted\b/.exec(counts)?.[1] ?? 0);
    if (said !== rows.filter((r) => r.state === "submitted_unconfirmed").length) fail(`"submitted" counted ${said}: ${counts}`);
  }
  // No company the person has no application to: every line of the reply names one of their rows' companies (or the asked one).
  for (const line of res.reply.split("\n").filter((l) => /^- |^[^\d].*: /.test(l))) {
    const named = line.replace(/^- /, "").split(/: | \(/)[0];
    if (!/^(?:I |No |Your |…|That )/.test(named) && named !== "An employer" && !WORD_COMPANIES.includes(named) && !rows.some((r) => r.company === named)) fail(`a company that is not theirs: ${line}`);
  }
  if (s.ask === 1 || s.ask === 3) {
    const co = s.ask === 1 ? "Acme" : "Beta Labs";
    const mine = rows.filter((r) => sameCompany(r.company, co));
    if (!mine.length && !/no application to/.test(res.reply)) fail(`no row for ${co}, yet: ${res.reply}`);
    if (!mine.length && /: submitted|confirmed it/.test(res.reply)) fail(`says ${co} went with no record: ${res.reply}`);
  }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: posting
export function linkOf(ats: string, board: string, num: number, v: string): string {
  if (ats === "greenhouse") {
    const host = v === "job_boards" ? "job-boards.greenhouse.io" : "boards.greenhouse.io";
    if (v === "gh_jid") return `https://boards.greenhouse.io/embed/job_app?for=${board}&gh_jid=${num}`;
    return { same: `https://${host}/${board}/jobs/${num}`, case: `HTTPS://${host.toUpperCase()}/${board}/jobs/${num}`, www: `https://www.${host}/${board}/jobs/${num}`,
      slash: `https://${host}/${board}/jobs/${num}/`, apply: `https://${host}/${board}/jobs/${num}`, utm: `https://${host}/${board}/jobs/${num}?utm_source=linkedin&utm_medium=x`,
      gh_src: `https://${host}/${board}/jobs/${num}?gh_src=abc123`, job_boards: `https://job-boards.greenhouse.io/${board}/jobs/${num}`, port: `https://${host}:443/${board}/jobs/${num}`,
      lever_tracking: `https://${host}/${board}/jobs/${num}?source=LinkedIn`, reorder: `https://${host}/${board}/jobs/${num}?ref=a&utm_x=b` }[v]!;
  }
  const host = ats === "lever" ? "jobs.lever.co" : "jobs.ashbyhq.com", id = `${num.toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(num).padStart(12, "0")}`;
  const base = `https://${host}/${board}/${id}`;
  return { same: base, case: base.replace(host, host.toUpperCase()), www: base.replace(host, `www.${host}`), slash: `${base}/`, apply: `${base}/${ats === "lever" ? "apply" : "application"}`,
    utm: `${base}?utm_source=x`, gh_src: `${base}?gh_src=y`, gh_jid: `${base}?lever-source=LinkedIn`, job_boards: `${base}?lever-origin=applied`, port: base.replace(host, `${host}:443`),
    lever_tracking: `${base}?lever-source%5B%5D=x`.replace("%5B%5D", ""), reorder: `${base}?referrer=z&src=q` }[v]!;
}
export function runPosting(s: Extract<Scenario, { family: "posting" }>): string[] {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} posting ${s.ats} ${s.variants.join(",")}/${s.other}: ${m}`);
  const board = `r4b${s.n % 50}`, num = 7_000_000 + s.n;
  const base = postingKey(linkOf(s.ats, board, num, "same"));
  if (!base) { fail("no key for the posting's own link"); return bad; }
  for (const v of s.variants) {
    const link = linkOf(s.ats, board, num, v);
    if (postingKey(link) !== base) fail(`${v} link ${link} is another posting (${postingKey(link)} vs ${base})`);
  }
  const otherAts = s.ats === "greenhouse" ? "lever" : "greenhouse";
  const other = s.other === "reposted" ? linkOf(s.ats, board, num + 1, "same") : s.other === "other_board" ? linkOf(s.ats, `${board}x`, num, "same")
    : s.other === "other_ats" ? linkOf(otherAts, board, num, "same") : linkOf(s.ats, board, num + 1000, "utm");
  // The same number on another Greenhouse board is the same Greenhouse job (the job number is global there).
  const sameJob = s.ats === "greenhouse" && s.other === "other_board";
  if ((postingKey(other) === base) !== sameJob) fail(`${s.other} ${other}: ${sameJob ? "not" : "also"} this posting`);
  const now = Date.parse("2026-11-05T12:00:00Z"), user = "u-r4";
  const log = [{ user_id: user, job_id: `${s.ats}:${board}:${num}`, company: "TEST", at: now - 3_600_000, state: "submitted_unconfirmed", url: linkOf(s.ats, board, num, "same") }];
  for (const v of s.variants) {
    const a = admitApplication(log, { user_id: user, job_id: `${s.ats}:${board}:${num}:${v}`, company: "TEST", url: linkOf(s.ats, board, num, v) }, now);
    if (a.ok || a.reason !== "duplicate_job") fail(`a second application to the same posting (${v}) was admitted: ${JSON.stringify(a)}`);
  }
  const b = admitApplication(log, { user_id: user, job_id: `other:${s.n}`, company: "TEST", url: other }, now);
  if (b.ok === sameJob) fail(`${s.other}: admitted ${b.ok}`);
  return bad;
}

// ------------------------------------------------------------------------------------------------ the run
export async function runScenario(s: Scenario): Promise<string[]> {
  switch (s.family) {
    case "bridge": return await runBridge(s);
    case "flag": return await runFlag(s);
    case "dispatch": return await runDispatch(s);
    case "mail": return runMail(s);
    case "words": return runWords(s);
    case "posting": return runPosting(s);
  }
}
export async function runPart(part: number, parts: number) {
  const all = generate().filter((s) => s.n % parts === part);
  const bad: string[] = [], tally: Record<string, number> = {};
  for (const s of all) {
    bad.push(...await runScenario(s));
    tally[s.family] = (tally[s.family] ?? 0) + 1;
  }
  return { ran: all.length, tally, bad };
}
