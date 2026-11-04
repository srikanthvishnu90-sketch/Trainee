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
import { pgBinDir, startPg } from "../flow/pg.ts";
import { RELEASE_PENDING } from "../../supabase/functions/agent-chat/release_config.ts";
import { SEND_CONSENT_SCOPES, SUBMITTED_SCOPES } from "../../supabase/functions/_shared/google_scopes.ts";
import { supabaseConnectDeps } from "../../supabase/functions/trainee-connect/store.ts";
import { emailBind, issueState, verifyState } from "../../supabase/functions/gmail-oauth/career.ts";
import { googleCallback, SEND_REFUSED_WORDS, sendRevokeAllowed } from "../../supabase/functions/_shared/oauth_connect.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { MemDb } from "./scenarios/connectors-r3-memdb.ts";

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
  const keys = [...new Set([...sql.matchAll(/\('([A-Z_]+)', :'v'\)/g)].map((m) => m[1]))].sort();
  eq(keys, Object.keys(RELEASE_DB_SWITCHES).sort(), "the SQL writes exactly RELEASE_DB_SWITCHES");
  ok(!/\b(create|alter|drop)\b/i.test(sql.replace(/^--.*$/gm, "")), "values only, never schema");
  const sh = await text("scripts/launch/trainee-go-live.sh");
  const guardLine = sh.split("\n").find((l) => l.includes('run "psql *** -X -q -v ON_ERROR_STOP=1 -f scripts/launch/verify-claim-guards.sql"')) ?? "";
  ok(guardLine && !/\|\||;\s*true|\btrue\s*$/.test(guardLine.replace(/"[^"]*"/g, "")), `the claim-guard check is never softened (no || or || true): ${guardLine}`);
  const guards = sh.indexOf(guardLine), write = sh.indexOf('-f scripts/launch/release-db-switches.sql" "${P[@]}"');
  ok(guards > 0 && write > guards, "the switches are written only after every claim guard is verified in place");
  ok(/^REAL_SUBMIT=""$/m.test(sh) && /--real-submit\) shift; REAL_SUBMIT=/.test(sh), "unset by default: a plain go-live overwrites nothing");
  ok(/RS_V=off; RS_OVER=true/.test(sh) && !/RS_V=on/.test(sh) && /--real-submit on is refused/.test(sh), "owner 2026-11-02: a go-live always writes the submit switches off; on is refused");
  ok(/\[\[ -z "\$REAL_SUBMIT" \|\| "\$REAL_SUBMIT" == off \]\] \|\| fail/.test(sh), "any other value, on included, stops the run");
  ok(!/--brain\)[^\n]*REAL_SUBMIT/.test(sh), "--brain (the emergency rollback) never touches real submit");
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

Deno.test({ name: "D-037/1a': on Postgres: the owner's 'off' survives a plain go-live (and --brain router); only an explicit --real-submit overwrites", sanitizeResources: false, sanitizeOps: false, async fn() {
  const CI = Deno.env.get("CI") === "true";
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root (initdb)"); return; }
  const pg = await startPg();
  try {
    const run = async (v: string, overwrite: boolean) => {
      const p = await new Deno.Command(`${pgBinDir()}/psql`, { args: ["-X", "-q", "-h", pg.host, "-p", String(pg.port), "-U", "postgres", "-d", "postgres",
        "-v", `v=${v}`, "-v", `overwrite=${overwrite}`, "-f", `${ROOT}/scripts/launch/release-db-switches.sql`], stdout: "piped", stderr: "piped" }).output();
      ok(p.success, new TextDecoder().decode(p.stderr));
    };
    const rows = async () => (await pg.sql("select string_agg(key || '=' || value, ',' order by key) from public.career_cloud_settings where key in ('APPLY_VM','CAREER_AGENT_SUBMIT','CAREER_CLOUD_APPLY')")).trim();
    await pg.sql("delete from public.career_cloud_settings where key in ('APPLY_VM','CAREER_AGENT_SUBMIT','CAREER_CLOUD_APPLY'); insert into public.career_cloud_settings (key, value) values ('CAREER_AGENT_SUBMIT', 'off')");
    await run("on", false); // a plain go-live, as trainee-go-live.sh runs it with REAL_SUBMIT unset (also under --brain router)
    eq(await rows(), "APPLY_VM=on,CAREER_AGENT_SUBMIT=off,CAREER_CLOUD_APPLY=on", "the owner's off is kept; only missing rows are written on");
    await run("on", false);
    eq(await rows(), "APPLY_VM=on,CAREER_AGENT_SUBMIT=off,CAREER_CLOUD_APPLY=on", "and again on the next go-live");
    await run("off", true); // --real-submit off
    eq(await rows(), "APPLY_VM=off,CAREER_AGENT_SUBMIT=off,CAREER_CLOUD_APPLY=off");
    await run("on", false);
    eq(await rows(), "APPLY_VM=off,CAREER_AGENT_SUBMIT=off,CAREER_CLOUD_APPLY=off", "a plain go-live after the kill switch changes nothing");
    await run("on", true); // --real-submit on
    eq(await rows(), "APPLY_VM=on,CAREER_AGENT_SUBMIT=on,CAREER_CLOUD_APPLY=on", "only an explicit --real-submit on turns them back on");
  } finally { await pg.stop(); }
} });

Deno.test("D-037/1e: the batch executor stays off while nothing in production loads it", async () => {
  ok(!("CAREER_BATCH_EXECUTOR" in RELEASE_FLAGS) && /executor not deployed/.test(RELEASE_PENDING.CAREER_BATCH_EXECUTOR ?? ""), "pending: executor not deployed");
  // Entry points that run in production: every edge function's index, the launch scripts, the workflows, the worker services.
  const roots = ["supabase/functions", "scripts/launch", ".github/workflows", "workers"];
  const loaders: string[] = [];
  // A load, not a mention: require/import of it, or a command that runs it (comments are skipped).
  const LOADS = /require\(\s*["'][^"']*batch-executor|from\s+["'][^"']*batch-executor|import\(\s*["'][^"']*batch-executor|\b(?:node|deno run[^\n]*)\s+\S*batch-executor/;
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(`${ROOT}/${d}`)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (p !== "workers/career-browser/batch-executor.cjs" && !/test/.test(e.name) && LOADS.test((await Deno.readTextFile(`${ROOT}/${p}`).catch(() => "")).split("\n").filter((l) => !/^\s*(\/\/|\*|#|--)/.test(l)).join("\n"))) loaders.push(p);
    }
  };
  for (const d of roots) await walk(d);
  ok(LOADS.test(`const x = require("./batch-executor.cjs")`) && LOADS.test("node workers/career-browser/batch-executor.cjs"), "the scan sees a real load (mutation check)");
  eq(loaders.filter((p) => !/\.md$/.test(p)), [], "nothing in production loads the executor; when something does, move CAREER_BATCH_EXECUTOR into RELEASE_FLAGS");
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

Deno.test("D-037/2d: incremental authorization: the normal connect never asks for gmail.send; the send consent adds it to the grant", async () => {
  eq(approvedExtras(envOf({})), [], "GOOGLE_APPROVED_EXTRA_SCOPES is not a release flag: unset, no extra scope");
  ok(!requestableScopes([GMAIL_SEND], envOf({})).scopes.includes(GMAIL_SEND), "the plain connect asks only for the submitted scopes");
  eq(approvedExtras(envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: `${GMAIL_SEND} https://www.googleapis.com/auth/calendar.events` })).length, 2, "the owner may list several approved scopes");
  ok(!("GOOGLE_APPROVED_EXTRA_SCOPES" in RELEASE_FLAGS));
  eq([...SEND_CONSENT_SCOPES], ["openid", "email", GMAIL_SEND]);
  // The connect page's two consent URLs, from the code that builds them.
  const held: Record<string, unknown> | null = { email: "alice@example.test" };
  const q = (row: unknown) => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: row, error: null }) }; return c; };
  let connected: unknown = held;
  const admin = { rpc: async (n: string) => ({ data: n === "career_connector_link_issue" ? "nonce-1" : { ok: true }, error: null }), from: () => q(connected) };
  const env = envOf({ GOOGLE_OAUTH_CLIENT_ID: "cid", OAUTH_STATE_SECRET: "s".repeat(40), GOOGLE_OAUTH_REDIRECT_URI: "https://x.example/cb" });
  const d = supabaseConnectDeps(admin, env, fetch, () => 1_800_000_000_000);
  const plain = new URL((await d.start("google", U, "telegram", "replies"))!), send = new URL((await d.start("google", U, "telegram", "send"))!);
  const scopes = (u: URL) => (u.searchParams.get("scope") ?? "").split(" ");
  ok(!scopes(plain).includes(GMAIL_SEND) && scopes(plain).every((x) => SUBMITTED_SCOPES.includes(x)), `plain connect: ${scopes(plain)}`);
  eq(plain.searchParams.get("include_granted_scopes"), null);
  ok(scopes(send).includes(GMAIL_SEND), `send consent: ${scopes(send)}`);
  eq(send.searchParams.get("include_granted_scopes"), "true", "added to what the person already granted");
  eq(send.searchParams.get("login_hint"), "alice@example.test", "Google is told which account: the connected one");
  const st = await verifyState(send.searchParams.get("state")!, "s".repeat(40), 1_800_000_000_000);
  eq(st.bind, await emailBind("alice@example.test"), "the state is bound to the connected account");
  eq(plain.searchParams.get("login_hint"), null);
  connected = null;
  const none = new URL((await d.start("google", U, "telegram", "send"))!);
  ok(!scopes(none).includes(GMAIL_SEND) && none.searchParams.get("include_granted_scopes") === null && !(await verifyState(none.searchParams.get("state")!, "s".repeat(40), 1_800_000_000_000)).bind,
    "no Gmail connected: nothing to add sending to, the plain connect");
  const doc = await text("docs/architect/RELEASE-FLAGS-2026-11-01.md");
  ok(/test users/i.test(doc) && /Google Cloud console/.test(doc) && /owner/.test(doc), "the doc says the owner adds Google test users (Google has not verified gmail.send)");
  const src = await text("supabase/functions/_shared/career_outreach.ts");
  ok(/opted_out/.test(src) && /bounced/.test(src), "the outreach stop rules (opt-out, bounce) are still there");
});

// ------------------------------------------------------------------------------------------------ the send consent's callback
const SECRET = "s".repeat(40), NOW = 1_800_000_000_000, ALICE = "alice@example.test";
// A fake Google that keeps ONE grant per account and app, as Google does: revoking any token of an account ends every
// token of that account (the person's own earlier grant included).
function fakeGoogle(o: { signedIn: string; granted: string }) {
  const owner = new Map<string, string>(), dead = new Set<string>(), revokes: string[] = [];
  const own = (tok: string, account: string) => { owner.set(tok, account.trim().toLowerCase()); return tok; };
  let n = 0;
  const fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      n++;
      return Response.json({ access_token: own(`NEW-AT-${n}`, o.signedIn), refresh_token: own(`NEW-RT-${n}`, o.signedIn), expires_in: 3600, scope: o.granted });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) return Response.json({ email: o.signedIn });
    if (url.startsWith(GOOGLE_REVOKE)) {
      const body = String(init?.body ?? url), tok = new URLSearchParams(body.includes("=") ? body : new URL(url).search).get("token") ?? "";
      const acct = owner.get(tok);
      revokes.push(acct ?? "?");
      if (acct) dead.add(acct);
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const works = (tok: string) => owner.has(tok) && !dead.has(owner.get(tok)!);
  return { fetch, own, works, revokes };
}

const Q = "7b0f8f8e-6a43-4a49-9d2c-00000000000q".replace("q", "9");
async function sendCallback(o: { connected: { email: string; scopes: string } | null; signedIn: string; granted: string; bindTo?: string; others?: { user: string; email: string }[] }) {
  const db = new MemDb();
  db.users.add(U);
  const g = fakeGoogle({ signedIn: o.signedIn, granted: o.granted });
  const tokens: Record<string, string> = {};
  if (o.connected) {
    db.rows("user_oauth_connections").push({ user_id: U, provider: "google_career", vault_name: `oauth_google_career_${U}`, email: o.connected.email, scopes: o.connected.scopes, connected_at: "2026-10-01T00:00:00Z" });
    tokens.mine = g.own("OLD-AT-P", o.connected.email);
    db.vault.set(`oauth_google_career_${U}`, JSON.stringify({ access_token: tokens.mine, refresh_token: g.own("OLD-RT-P", o.connected.email) }));
  }
  for (const x of o.others ?? []) {
    db.users.add(x.user);
    db.rows("user_oauth_connections").push({ user_id: x.user, provider: "google_career", vault_name: `oauth_google_career_${x.user}`, email: x.email, scopes: `openid email https://www.googleapis.com/auth/gmail.readonly`, connected_at: "2026-10-01T00:00:00Z" });
    tokens[x.user] = g.own(`AT-${x.user}`, x.email);
    db.vault.set(`oauth_google_career_${x.user}`, JSON.stringify({ access_token: tokens[x.user] }));
  }
  const state = await issueState(U, "career", SECRET, NOW, await emailBind(o.bindTo ?? ALICE));
  const v = await verifyState(state, SECRET, NOW);
  const out = await googleCallback({ admin: db as any, fetch: g.fetch, now: () => NOW, clientId: "cid", clientSecret: "cs", redirectUri: "https://x.example/cb", grantedFallback: () => "", sleep: async () => {} },
    { code: "c1", state, userId: U, provider: "google_career", bind: v.bind });
  return { out, row: db.rows("user_oauth_connections").find((r) => r.user_id === U) ?? null, vault: db.vault.get(`oauth_google_career_${U}`) ?? null, revokes: g.revokes, works: g.works, tokens };
}
const READ = "https://www.googleapis.com/auth/gmail.readonly";

Deno.test("D-037/2f: the send consent is bound to the connected account: the happy path adds gmail.send to it", async () => {
  const r = await sendCallback({ connected: { email: ALICE, scopes: `openid email ${READ}` }, signedIn: "Alice@Example.test", granted: `openid email ${READ} ${GMAIL_SEND}` });
  eq(r.out.ok, true, JSON.stringify(r.out));
  ok(r.row?.scopes.includes(GMAIL_SEND) && r.row?.scopes.includes(READ) && r.row?.email.toLowerCase() === ALICE, `the same account, now with send: ${JSON.stringify(r.row)}`);
  eq(r.revokes, [], "nothing revoked");
});

Deno.test("D-037/2g: a refused send consent stores nothing, leaves the connection as it was, and never ends a grant anyone uses", async () => {
  const keep = (r: Awaited<ReturnType<typeof sendCallback>>, c: { email: string; scopes: string }, name: string) => {
    eq([r.row?.email, r.row?.scopes], [c.email, c.scopes], `${name}: the connection is unchanged`);
    ok(/OLD-AT-P/.test(r.vault ?? ""), `${name}: the stored access is unchanged`);
  };
  const conn = { email: ALICE, scopes: `openid email ${READ}` };

  // The person unticks send, or drops read, on their own connected account: nothing stored, nothing revoked, and their
  // read grant (mail tracking) keeps working. Google would end the whole grant on a revoke.
  for (const [name, granted] of [["send not granted", `openid email ${READ}`], ["the old read permission missing", `openid email ${GMAIL_SEND}`]] as const) {
    const r = await sendCallback({ connected: conn, signedIn: ALICE, granted });
    eq([r.out.ok, (r.out as any).why], [false, "send_scopes"], name);
    eq(r.revokes, [], `${name}: nothing revoked (it is the person's own account)`);
    ok(r.works(r.tokens.mine), `${name}: alice's stored token still works`);
    keep(r, conn, name);
  }

  // bob@ picked in Google's chooser, while Trainee user Q has bob@ connected: refused, and Q's grant is untouched.
  {
    const r = await sendCallback({ connected: conn, signedIn: "bob@example.test", granted: `openid email ${READ} ${GMAIL_SEND}`, others: [{ user: Q, email: "bob@example.test" }] });
    eq([r.out.ok, (r.out as any).why], [false, "send_other_account"]);
    eq(r.revokes, [], "bob@ is connected to Q: nothing revoked");
    ok(r.works(r.tokens[Q]), "Q's stored token still works");
    ok(r.works(r.tokens.mine), "and so does alice's");
    keep(r, conn, "other account, connected elsewhere");
  }
  // bob@ connected to no one: the grant Google just made is revoked, and only bob's tokens end.
  {
    const r = await sendCallback({ connected: conn, signedIn: "bob@example.test", granted: `openid email ${READ} ${GMAIL_SEND}` });
    eq([r.out.ok, (r.out as any).why], [false, "send_other_account"]);
    ok(r.revokes.length > 0 && r.revokes.every((a) => a === "bob@example.test"), `only bob's grant is revoked: ${r.revokes}`);
    ok(r.works(r.tokens.mine), "alice's stored token still works");
    keep(r, conn, "other account, connected nowhere");
  }
  // No connection at all, and the signed-in account connected nowhere: revoked, nothing stored.
  {
    const r = await sendCallback({ connected: null, signedIn: ALICE, granted: `openid email ${READ} ${GMAIL_SEND}` });
    eq([r.out.ok, (r.out as any).why], [false, "send_no_connection"]);
    ok(r.revokes.length > 0, "an unused grant is revoked");
    eq([r.row, r.vault], [null, null], "nothing stored");
  }
  // The state bound to another address than the connection: refused; alice is connected (to P), so nothing revoked.
  {
    const r = await sendCallback({ connected: conn, signedIn: ALICE, granted: `openid email ${READ} ${GMAIL_SEND}`, bindTo: "carol@example.test" });
    eq([r.out.ok, (r.out as any).why], [false, "send_other_account"]);
    eq(r.revokes, []);
    ok(r.works(r.tokens.mine));
    keep(r, conn, "bound elsewhere");
  }
  for (const why of ["send_no_connection", "send_other_account", "send_scopes"] as const) ok(SEND_REFUSED_WORDS(why, ALICE).startsWith("Sending wasn't allowed"), "the landing says why");
});

Deno.test("D-037/2i: the revoke check fails closed: no revoke on any doubt, on a legacy or mixed-case row, or while any Google row has no address", async () => {
  const db = (rows: Record<string, unknown>[]) => { const d = new MemDb(); for (const x of rows) d.rows("user_oauth_connections").push(x); return d as any; };
  const row = (provider: string, email: string | null, user = "u2") => ({ user_id: user, provider, vault_name: `oauth_${provider}_${user}`, email, scopes: "openid email" });
  eq(await sendRevokeAllowed(db([]), "bob@example.test"), true, "connected nowhere: the unused grant may be revoked");
  eq(await sendRevokeAllowed(db([]), null), false, "missing address");
  eq(await sendRevokeAllowed(db([]), "  "), false, "blank address");
  const q = (res: any) => { const c: any = { select: () => c, in: () => c, is: () => c, ilike: () => c, limit: () => c, then: (ok: any, no: any) => Promise.resolve(res).then(ok, no) }; return c; };
  eq(await sendRevokeAllowed({ from: () => q({ data: null, error: { message: "boom" } }) } as any, "bob@example.test"), false, "a read error");
  let n = 0;
  eq(await sendRevokeAllowed({ from: () => q(n++ === 0 ? { data: [], error: null } : { data: null, error: { message: "boom" } }) } as any, "bob@example.test"), false, "a read error on the address lookup");
  eq(await sendRevokeAllowed({ from: () => { throw new Error("down"); } } as any, "bob@example.test"), false, "a thrown query");
  eq(await sendRevokeAllowed(db([row("gmail", "bob@example.test")]), "bob@example.test"), false, "the legacy gmail provider row protects bob@");
  eq(await sendRevokeAllowed(db([row("google_career", "Bob@Example.TEST")]), "bob@example.test"), false, "a mixed-case stored address matches");
  eq(await sendRevokeAllowed(db([row("google_career", "bob@example.test")]), "BOB@example.test"), false, "a mixed-case signed-in address matches");
  eq(await sendRevokeAllowed(db([row("google_career", null, "u3")]), "bob@example.test"), false, "a Google row with no stored address could be bob@: no revoke");
  eq(await sendRevokeAllowed(db([row("microsoft", "bob@example.test")]), "bob@example.test"), true, "an Outlook row is another provider's grant");
});

Deno.test("D-037/2h: an old send link used after the person reconnected another account cannot put the previous account back", async () => {
  // P made a send link while alice@ was connected, then reconnected bob@ within the link's 10 minutes; the old link is then
  // opened and alice@ signs in. The connection is bob@ now, so the link's account is not the connected one: refused.
  const now = { email: "bob@example.test", scopes: `openid email ${READ}` };
  const r = await sendCallback({ connected: now, signedIn: ALICE, granted: `openid email ${READ} ${GMAIL_SEND}`, bindTo: ALICE });
  eq([r.out.ok, (r.out as any).why], [false, "send_other_account"]);
  eq([r.row?.email, r.row?.scopes], [now.email, now.scopes], "the connection stays bob@, as the person last set it");
  ok(r.works(r.tokens.mine), "bob's stored token still works");
});

Deno.test("D-037/2e: a send refused for want of gmail.send offers the person the 'allow sending' link, and sends nothing", async () => {
  const src = await text("supabase/functions/_shared/career_inbox_followups.ts");
  ok(/allow sending: \$\{allow\} then say yes again/.test(src) && /sendConsent\?: \(userId: string\) => Promise<string \| null>/.test(src));
  const em = await text("supabase/functions/_shared/career_apply_email.ts");
  ok(/To send this from your Gmail, allow sending: \$\{allow\} then say yes again\./.test(em));
  const h = await text("supabase/functions/agent-chat/handler-career.ts");
  eq(h.split("sendConsent: sendConsentFor").length - 1, 2, "both send paths get the link");
  ok(/connectUrlsFor\(Deno\.env, u, "send",/.test(h), "the link is a connect link with reason send (the incremental consent)");
  const cb = await text("supabase/functions/gmail-oauth/index.ts");
  ok(cb.includes("{ code, state, userId, provider, ...(verified.bind ? { bind: verified.bind } : {}) }"), "the callback hands the state's binding to googleCallback");
  ok(/got\.why === "send_other_account"/.test(cb) && /SEND_REFUSED_WORDS\(got\.why/.test(cb), "and the landing says why a send consent was refused");
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
