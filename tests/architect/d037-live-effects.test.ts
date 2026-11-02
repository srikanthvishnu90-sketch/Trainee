// D-037 (owner, in writing, 2026-11-01 20:04 CT: "turn these on: Real submissions … Sending email as the person … Reply
// rewriters"). Each condition the architect attached is enforced by code; one test per condition. The release values
// themselves are pinned in tests/architect/release-flags.test.ts. Approval tests elsewhere are unchanged.
import assertNode from "node:assert/strict";
import { RELEASE_DB_SWITCHES, RELEASE_FLAGS, RELEASE_NEVER_ON, releaseValue } from "../../supabase/functions/agent-chat/release_config.ts";
import { createRunnerHandler, runnerLimits, OPTIONAL_LIMITS } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { careerTokenFor } from "../../supabase/functions/_shared/career_mail_gmail.ts";
import { gmailSender } from "../../supabase/functions/_shared/career_outreach_gmail.ts";
import { mailHash, queueApproved, sendRailOn } from "../../supabase/functions/_shared/career_send_rail.ts";
import { approvedExtras, GMAIL_SEND, requestableScopes } from "../../supabase/functions/_shared/google_scopes.ts";
import { applyHereAsk } from "../../supabase/functions/_shared/apply_here.ts";
import { inventedFact, REWRITERS, side, verdict } from "../../evals/career/rewriters/run.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
type Env = { get(k: string): string | undefined };
const envOf = (o: Record<string, string> = {}): Env => ({ get: (k) => o[k] });
const text = (p: string) => Deno.readTextFile(`${ROOT}/${p}`);
const U = "u-d037";

// ------------------------------------------------------------------------------------------------ 1. real submission
Deno.test("D-037/1a: the database switches the release turns on are written by go-live, after the claim guards, with a kill switch", async () => {
  eq(Object.keys(RELEASE_DB_SWITCHES).sort(), ["APPLY_VM", "CAREER_AGENT_SUBMIT", "CAREER_CLOUD_APPLY"]);
  const sql = await text("scripts/launch/release-db-switches.sql");
  const keys = [...sql.matchAll(/\('([A-Z_]+)', :'v'\)/g)].map((m) => m[1]).sort();
  eq(keys, Object.keys(RELEASE_DB_SWITCHES).sort(), "the SQL writes exactly RELEASE_DB_SWITCHES");
  ok(!/\b(create|alter|drop)\b/i.test(sql.replace(/^--.*$/gm, "")), "values only, never schema");
  const sh = await text("scripts/launch/trainee-go-live.sh");
  const guards = sh.indexOf('-f scripts/launch/verify-claim-guards.sql" "${P[@]}"'), write = sh.indexOf('-f scripts/launch/release-db-switches.sql" "${P[@]}"');
  ok(guards > 0 && write > guards, "the switches are written only after every claim guard is verified in place");
  ok(/REAL_SUBMIT="on"/.test(sh) && /--real-submit\) shift; REAL_SUBMIT=/.test(sh), "on by default; --real-submit off is the kill switch");
  ok(/\[\[ "\$REAL_SUBMIT" == on \|\| "\$REAL_SUBMIT" == off \]\] \|\| fail/.test(sh), "any other value stops the run");
});

const RUNNER_BASE = { SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc", CLOUD_RUNNER_SECRET: "r".repeat(40),
  CLOUD_DISPATCH_SECRET: "d".repeat(40), CAREER_PREPARE_AHEAD_TOKEN: "p".repeat(40) };
const dispatch = (h: (r: Request) => Promise<Response>, path: string, headers: Record<string, string>) =>
  h(new Request(`https://x.supabase.test/functions/v1/career-cloud-runner${path}`, { method: "POST", headers }));

Deno.test("D-037/1b: the cloud runner's switches are on, and without the Vercel sandbox secrets it fails closed: needs setup, nothing started", async () => {
  const calls: string[] = [];
  const f = (async (i: Request | URL | string) => { calls.push(String(i instanceof Request ? i.url : i)); return new Response("[]"); }) as typeof fetch;
  const h = createRunnerHandler({ env: envOf(RUNNER_BASE), fetch: f });
  for (const [path, headers] of [["/dispatch", { "x-cloud-dispatch-secret": RUNNER_BASE.CLOUD_DISPATCH_SECRET }],
    ["/prepare-dispatch", { "x-cloud-dispatch-secret": RUNNER_BASE.CLOUD_DISPATCH_SECRET }],
    ["/prepare", { authorization: `Bearer ${RUNNER_BASE.CAREER_PREPARE_AHEAD_TOKEN}` }]] as const) {
    const r = await dispatch(h, path, headers);
    const body = await r.json();
    eq(r.status, 503, `${path}: ${JSON.stringify(body)}`);
    ok(/^needs setup: VERCEL_TOKEN is not set/.test(body.error) && body.needs_setup === "VERCEL_TOKEN", `${path} names what to set: ${body.error}`);
  }
  eq(calls.filter((u) => /vercel/.test(u)), [], "no sandbox was started");
  // The kill switch: rolled back, the tick is skipped before any setup check.
  const off = createRunnerHandler({ env: envOf({ ...RUNNER_BASE, CLOUD_RUNNER_ENABLED: "off" }), fetch: f });
  eq((await (await dispatch(off, "/dispatch", { "x-cloud-dispatch-secret": RUNNER_BASE.CLOUD_DISPATCH_SECRET })).json()).skipped, "CLOUD_RUNNER_ENABLED is not on");
});

Deno.test("D-037/1c: no per-person or per-site number of Trainee's own is added; one the owner sets still binds", () => {
  // The owner's NO LIMITS rule (D-MS-2): per-person and per-site numbers are optional, unset by default. D-037 adds none.
  const none = runnerLimits(envOf({}));
  eq([none.send.perPersonDay, none.send.perSiteMinute], [null, null]);
  eq(runnerLimits(envOf({ CLOUD_MAX_PER_PERSON_DAY: "5" })).send.perPersonDay, 5, "CLOUD_MAX_PER_PERSON_DAY, when set, is the per-person daily limit");
  ok(OPTIONAL_LIMITS.includes("CLOUD_MAX_PER_PERSON_DAY"));
  for (const k of OPTIONAL_LIMITS) ok(!(k in RELEASE_FLAGS), `${k} is the owner's number, never set by the release`);
});

Deno.test("D-037/1d: LinkedIn, Indeed and Handshake are never applied on; a captcha is never solved", async () => {
  for (const u of ["https://www.linkedin.com/jobs/view/123", "https://www.indeed.com/viewjob?jk=1", "https://app.joinhandshake.com/jobs/9"]) {
    const ask = applyHereAsk(`apply here ${u}`, null);
    ok(ask && ask.blocked.includes(u) && !ask.urls.includes(u), `${u} is refused, never opened`);
  }
  const worker = await text("workers/career-cloud/worker.ts");
  ok(/never solved or got around/.test(worker) && /reason === "captcha"/.test(worker), "the cloud worker hands a captcha to the person");
  for (const f of Object.keys(RELEASE_FLAGS)) ok(!/LINKEDIN|INDEED|CAPTCHA/.test(f), `${f} is not a LinkedIn, Indeed or captcha switch`);
});

// ------------------------------------------------------------------------------------------------ 2. send as the person
const conn = (scopes: string[]) => ({ vault_name: `oauth_google_career_${U}`, scopes });
function tokenDeps(scopes: string[], reads: string[]) {
  return { connection: async () => conn(scopes), readVault: async (n: string) => { reads.push(n); return JSON.stringify({ access_token: "AT", expires_at: Date.now() + 3600_000 }); },
    now: Date.now, env: envOf({}), fetch: (async () => new Response("{}")) as typeof fetch } as any;
}

Deno.test("D-037/2a: at send time the person's own grant must carry gmail.send; without it nothing is sent and there is no other sender", async () => {
  const reads: string[] = [];
  eq(await careerTokenFor(tokenDeps(["https://www.googleapis.com/auth/gmail.readonly"], reads), GMAIL_SEND)(U), null, "a read-only grant gives no send token");
  eq(reads, [], "its stored token is not even read");
  eq(await careerTokenFor(tokenDeps([GMAIL_SEND], reads), GMAIL_SEND)(U), "AT", "the person's own grant with gmail.send");
  const hits: string[] = [];
  const sender = gmailSender({ fetch: (async (i: any) => { hits.push(String(i)); return new Response("{}"); }) as typeof fetch, token: async () => null });
  const r = await sender.send(U, { to: "maya@stripe.example", subject: "Hi", text: "Hello" } as any);
  eq(r.status, "NOT_WIRED", "fails closed");
  eq(hits, [], "no request to any sender at all");
});

Deno.test("D-037/2b: mail leaves from the person's own account only: no From of Trainee's, one recipient, no Cc or Bcc", async () => {
  let raw = "";
  const sender = gmailSender({ fetch: (async (_i: any, init: any) => { raw = JSON.parse(init.body).raw; return Response.json({ id: "m1", threadId: "t1" }); }) as typeof fetch, token: async () => "AT" });
  eq((await sender.send(U, { to: "maya@stripe.example", subject: "Intro", text: "Hello" } as any)).status, "sent");
  const msg = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  ok(/^To: maya@stripe\.example\r\n/.test(msg) && !/^(From|Cc|Bcc|Reply-To|Sender):/im.test(msg), `Gmail adds the signed-in account as From; Trainee writes none:\n${msg}`);
  eq((await sender.send(U, { to: "a@x.example, b@x.example", subject: "s", text: "t" } as any)).status, "ERROR", "never two recipients");
  ok(!Object.keys(RELEASE_FLAGS).some((f) => /TRAINEE_SENDER|FROM_ADDRESS|SYSTEM_SEND/.test(f)), "no switch sends from Trainee's identity");
});

Deno.test("D-037/2c: the exact message (to, subject, body) is approved every time: any change since the approval is refused", async () => {
  const m = { to: "maya@stripe.example", subject: "Intro", text: "Hello Maya" };
  const h = await mailHash(m);
  const deps = { rpc: async () => { throw new Error("nothing changed may reach the queue in this test"); } } as any;
  for (const changed of [{ ...m, to: "lee@stripe.example" }, { ...m, subject: "Intro!" }, { ...m, text: "Hello Maya." }]) {
    const [r] = await queueApproved(deps, U, [{ kind: "outreach", sourceId: "d1", approvalHash: h, ...changed } as any]);
    eq([r.status, (r as any).reason], ["refused", "changed"], JSON.stringify(changed));
  }
  const [cc] = await queueApproved(deps, U, [{ kind: "outreach", sourceId: "d1", approvalHash: h, ...m, cc: "x@y.example" } as any]);
  eq((cc as any).reason, "cc_bcc_not_approved");
  ok(sendRailOn(envOf({})) && !sendRailOn(envOf({ CAREER_SEND_RAIL: "off" })), "the rail is on, and its kill switch works");
});

Deno.test("D-037/2d: gmail.send is asked for at connect in production; rolled back, it is not; the owner's Google test users are documented", async () => {
  eq(approvedExtras(envOf({})), [GMAIL_SEND]);
  ok(requestableScopes([GMAIL_SEND], envOf({})).scopes.includes(GMAIL_SEND), "asked for at connect");
  ok(!requestableScopes([GMAIL_SEND], envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: "off" })).scopes.includes(GMAIL_SEND), "rolled back: not asked");
  eq(releaseValue(envOf({}), "GOOGLE_APPROVED_EXTRA_SCOPES"), GMAIL_SEND);
  const doc = await text("docs/architect/RELEASE-FLAGS-2026-11-01.md");
  ok(/test users/i.test(doc) && /Google Cloud console/.test(doc) && /owner/.test(doc), "the doc says the owner adds Google test users (Google has not verified gmail.send)");
  const src = await text("supabase/functions/_shared/career_outreach.ts");
  ok(/opted_out/.test(src) && /bounced/.test(src), "the outreach stop rules (opt-out, bounce) are still there");
});

// ------------------------------------------------------------------------------------------------ 3. reply rewriters
Deno.test("D-037/3: a reply rewriter goes ON only after its measurement: no worse pass rate and no added invented-fact failure", () => {
  for (const r of REWRITERS) {
    ok(RELEASE_NEVER_ON.includes(r) && !(r in RELEASE_FLAGS), `${r} stays off: not measured yet`);
  }
  const items = [{ id: "A", persona: "", turns: ["x"], must: ["m"], must_not: ["claims a degree not on the record"] },
    { id: "B", persona: "", turns: ["x"], must: ["m"], must_not: ["says I didn't catch that"] }];
  ok(inventedFact(items[0], ["claims a degree not on the record"]));
  ok(!inventedFact(items[1], ["says I didn't catch that"]));
  const off = side(items, [{ id: "A", pass: true, failed: [] }, { id: "B", pass: false, failed: ["says I didn't catch that"] }]);
  const better = side(items, [{ id: "A", pass: true, failed: [] }, { id: "B", pass: true, failed: [] }]);
  const invents = side(items, [{ id: "A", pass: false, failed: ["claims a degree not on the record"] }, { id: "B", pass: true, failed: [] }]);
  const worse = side(items, [{ id: "A", pass: false, failed: ["m"] }, { id: "B", pass: false, failed: ["m"] }]);
  eq(verdict("CAREER_REPLY_WRITER", off, better, true).on_release, true);
  eq(verdict("CAREER_REPLY_WRITER", off, invents, true).on_release, false, "same pass rate, but an invented fact: off");
  eq(verdict("CAREER_REPLY_WRITER", off, worse, true).on_release, false, "lower pass rate: off");
  eq(verdict("CAREER_REPLY_WRITER", off, better, false).on_release, false, "an incomplete run is no verdict");
});

Deno.test("D-037: the decision is written down", async () => {
  const d = await text("docs/architect/DECISIONS.md");
  ok(d.includes("| D-037 |") && d.includes("turn these on: Real submissions … Sending email as the person … Reply rewriters"));
});
