// trainee-file sign-in on real Postgres 16 (the flow harness: every migration in production order), through the deployed
// store (supabaseSessionStore) over the real supabase-js client; the only seam is the HTTP hop, answered by the PostgREST
// double as the service role. The person's phone and the texted code are a fake (no SMS provider, no network); the job list
// is a memory store (not what this measures). Every step reads the database back: a session id is stored as its hash only,
// a link's sign-in is one row used once, wrong codes stop at the cap, sign-out and sign-out-everywhere set revoked_at, a
// deleted account takes its sessions with it.
import nodeAssert from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { MAX_CODE_TRIES, pageTokenOf, sha256 } from "../../supabase/functions/_shared/file_session.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { fakePhone } from "./file-session-fakes.ts";

function assert(v: unknown, m?: string): asserts v { nodeAssert.ok(v, m); }
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const U = "8c0f8f8e-6a43-4a49-9d2c-0000000f1e01", V = "8c0f8f8e-6a43-4a49-9d2c-0000000f1e02";
const U_PHONE = "+15125550100", V_PHONE = "+15125550199";
const SECRET = "file-link-secret-0123456789-abcdef", LIST = "0123456789", URL_ = "http://supabase.test", KEY = "service-test-key";

Deno.test({ name: "trainee-file sign-in on real Postgres: link -> phone -> code -> session (hash only); forwarded link locked; replay; sign out one and everywhere; deleted account", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  try {
    for (const id of [U, V]) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test');`);
    const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
    const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    const sessions = supabaseSessionStore(admin);
    const q = async (s: string) => (await pg.sql(s)).trim();
    // U's list (memory: the job store is not what this measures)
    const kv = new Map<string, unknown>();
    const store = { async recall(u: string, r: string) { return kv.get(`${u}|${r}`) ?? null; }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
      async postings() { return []; }, async prepared() { return null; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
    const v = jobViewOf({ job_id: "greenhouse:acme:1", company: "Acme", title: "Data Analyst", url: "https://boards.greenhouse.io/acme/jobs/1" }, null);
    const ref = await refOf(U, v.job_id); kv.set(`${U}|${ref}`, { job: v, shownAs: "text" }); kv.set(`${U}|list|${LIST}`, [ref]);
    const phones: Record<string, string | null> = { [U]: U_PHONE, [V]: V_PHONE };
    const P = fakePhone(phones);
    let now = Date.now();
    const d: FileDeps = { store, sessions, phone: P.auth, now: () => now, env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET } as Record<string, string>)[k] }, cards: {} as never, tap: {} as never };
    const link = async () => (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now, kind: "l" }))!;
    const jtiOf = (l: string) => JSON.parse(atob(l.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).j as string;
    const req = (o: { get?: string; form?: Record<string, string>; cookie?: string }) => handleFile(new Request(`https://trainee.example/file${o.get ?? ""}`, o.form
      ? { method: "POST", headers: { cookie: o.cookie ?? "", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o.form).toString() }
      : { headers: { cookie: o.cookie ?? "" } }), d);
    const cookies = (r: Response) => Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, ...x]) => [k, x.join("=")]));

    // ---- the intended sign-in
    const l1 = await link();
    const open = await req({ get: `?t=${encodeURIComponent(l1)}` });
    eq(open.status, 303);
    const lc = `tf_l=${cookies(open).tf_l}`;
    eq(await q(`select count(*) from trainee_file_logins where jti = '${jtiOf(l1)}' and user_id = '${U}' and list = '${LIST}' and done_at is null`), "1");
    eq((await req({ form: { action: "phone_start", phone: "512-555-0100" }, cookie: lc })).status, 200);
    eq(await q(`select phone || ' ' || matched || ' ' || sends from trainee_file_logins where jti = '${jtiOf(l1)}'`), `${U_PHONE} true 1`);
    const ok = await req({ form: { action: "phone_verify", code: P.lastCode() }, cookie: lc });
    eq(ok.status, 303);
    const sid = cookies(ok).tf_s;
    assert(/^fs1\.[0-9a-f]{64}$/.test(sid));
    eq(await q(`select user_id || ' ' || via || ' ' || phone || ' ' || list from trainee_file_sessions where id_hash = '${await sha256(sid)}' and revoked_at is null`), `${U} phone ${U_PHONE} ${LIST}`);
    eq(await q(`select count(*) from trainee_file_sessions where id_hash = '${sid}' or id_hash like '%${sid.slice(4, 20)}%'`), "0", "the id itself is never stored");
    assert(await q(`select done_at is not null from trainee_file_logins where jti = '${jtiOf(l1)}'`) === "t", "the link is used up");
    const page = await req({ cookie: `tf_s=${sid}` });
    eq(page.status, 200); assert((await page.text()).includes("Acme"));

    // ---- replay: the used link, the used code
    eq((await req({ get: `?t=${encodeURIComponent(l1)}` })).status, 410);
    eq((await req({ form: { action: "phone_verify", code: P.lastCode() }, cookie: lc })).status, 410);
    eq(await q(`select count(*) from trainee_file_sessions where user_id = '${U}'`), "1");

    // ---- a forwarded link: a stranger's number, no text; wrong codes stop at the cap, counted in the database
    const l2 = await link();
    const o2 = await req({ get: `?t=${encodeURIComponent(l2)}` });
    const lc2 = `tf_l=${cookies(o2).tf_l}`;
    const texts = P.texts.length;
    await req({ form: { action: "phone_start", phone: "+14155550123" }, cookie: lc2 });
    eq(P.texts.length, texts, "no text");
    eq(await q(`select matched || ' ' || sends from trainee_file_logins where jti = '${jtiOf(l2)}'`), "false 0");
    for (let i = 0; i < MAX_CODE_TRIES; i++) eq((await req({ form: { action: "phone_verify", code: String(200000 + i) }, cookie: lc2 })).status, 401);
    eq((await req({ form: { action: "phone_verify", code: "200009" }, cookie: lc2 })).status, 429);
    eq(await q(`select tries from trainee_file_logins where jti = '${jtiOf(l2)}'`), String(MAX_CODE_TRIES));
    eq(await q(`select count(*) from trainee_file_sessions where user_id = '${U}'`), "1", "no session from the forwarded link");

    // ---- sign out here; then sign out everywhere (a second device)
    const l3 = await link();
    const o3 = await req({ get: `?t=${encodeURIComponent(l3)}` });
    const lc3 = `tf_l=${cookies(o3).tf_l}`;
    await req({ form: { action: "phone_start", phone: U_PHONE }, cookie: lc3 });
    const sid2 = cookies(await req({ form: { action: "phone_verify", code: P.lastCode() }, cookie: lc3 })).tf_s;
    // sign out from the page, as its browser sends it: the cookie, and the page token drawn for that session
    const tok = async (id: string) => (await pageTokenOf(await sha256(id), SECRET))!;
    eq((await req({ form: { t: sid, action: "signout" } })).status, 401, "the session id alone in a form signs nothing out");
    eq((await req({ form: { t: await tok(sid), action: "signout" }, cookie: `tf_s=${sid}` })).status, 200);
    assert(await q(`select revoked_at is not null from trainee_file_sessions where id_hash = '${await sha256(sid)}'`) === "t");
    eq((await req({ cookie: `tf_s=${sid}` })).status, 401);
    eq((await req({ cookie: `tf_s=${sid2}` })).status, 200, "the other device still signed in");
    eq((await req({ form: { t: await tok(sid2), action: "signout_all" }, cookie: `tf_s=${sid2}` })).status, 200);
    eq(await q(`select count(*) from trainee_file_sessions where user_id = '${U}' and revoked_at is null`), "0");
    eq((await req({ cookie: `tf_s=${sid2}` })).status, 401);

    // ---- the account's phone changes: an open session ends on its next request and is revoked in the database
    const l4 = await link();
    const o4 = await req({ get: `?t=${encodeURIComponent(l4)}` });
    const lc4 = `tf_l=${cookies(o4).tf_l}`;
    await req({ form: { action: "phone_start", phone: U_PHONE }, cookie: lc4 });
    const sid3 = cookies(await req({ form: { action: "phone_verify", code: P.lastCode() }, cookie: lc4 })).tf_s;
    phones[U] = "+15125550111";
    eq((await req({ cookie: `tf_s=${sid3}` })).status, 401);
    assert(await q(`select revoked_at is not null from trainee_file_sessions where id_hash = '${await sha256(sid3)}'`) === "t");

    // ---- the account deleted: its sessions and sign-ins go with it
    await pg.sql(`delete from auth.users where id = '${U}'`);
    eq(await q(`select (select count(*) from trainee_file_sessions where user_id = '${U}') + (select count(*) from trainee_file_logins where user_id = '${U}')`), "0");
    now += 1; // (the clock is the test's; nothing above depends on wall time)
  } finally {
    await pg.stop();
  }
} });
