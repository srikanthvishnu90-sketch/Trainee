// R10 WO-F fix 10 (spec C.23 panels 1-7, E.7 items 56-60, E.11): valid sign-in and account binding, tested SEPARATELY and end to end
// on real Postgres 16 (the flow double: every migration in production order, the deployed session store over the real supabase-js
// client, the HTTP hop answered by the PostgREST double). The person's phone and the texted code are a fake (no SMS, no network).
// Two accounts, each with their own list. What is proved:
//   1. sign-in: a valid link -> "Sign in" -> "Check your phone" -> the right code -> a session for exactly that account (read back).
//   2. binding: the session (phone or Telegram) shows only that person's content, never the other's, even with the other's list id
//      in the request; a wrong code is "That code did not work" with Try again and nothing private.
//   3. an expired, invalid, used or bare link shows the recovery action and no private content.
// The code is typed on the page; nothing here puts a code or password in chat.
import nodeAssert from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { pageTokenOf, SESSION_TTL_MS, sha256 } from "../../supabase/functions/_shared/file_session.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { fakePhone, signedInit } from "./file-session-fakes.ts";

function assert(v: unknown, m?: string): asserts v { nodeAssert.ok(v, m); }
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const U = "8c0f8f8e-6a43-4a49-9d2c-0000000f2e01", V = "8c0f8f8e-6a43-4a49-9d2c-0000000f2e02";
const U_PHONE = "+15125550140", V_PHONE = "+15125550141";
const SECRET = "file-link-secret-r10-0123456789-abcdef", BOT_TOKEN = "123456:r10-test-bot-token", BOT_URL = "https://t.me/TraineeTestBot";
const U_LIST = "0a0a0a0a0a", V_LIST = "0b0b0b0b0b", URL_ = "http://supabase.test", KEY = "service-test-key";
// Fictional employers, one per person: a page that shows the other's is a binding failure.
const U_CO = "Lakefront Analytics (fictional)", V_CO = "Harbor Robotics (fictional)";
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const h1 = (h: string) => ((h.match(/<h1[^>]*>([^<]*)<\/h1>/) ?? [])[1] ?? "").replace(/&#39;/g, "'");

async function world() {
  const pg: Pg = await startPg();
  for (const id of [U, V]) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test');`);
  const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
  const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
  const sessions = supabaseSessionStore(admin);
  const kv = new Map<string, unknown>();
  const store = { async recall(u: string, r: string) { return kv.get(`${u}|${r}`) ?? null; }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return []; }, async prepared() { return null; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
  for (const [u, list, co, n] of [[U, U_LIST, U_CO, 1], [V, V_LIST, V_CO, 2]] as const) {
    const v = jobViewOf({ job_id: `greenhouse:r10:${n}`, company: co, title: "Data Analyst", url: `https://boards.greenhouse.io/r10/jobs/${n}` }, null);
    const ref = await refOf(u, v.job_id); kv.set(`${u}|${ref}`, { job: v, shownAs: "text" }); kv.set(`${u}|list|${list}`, [ref]);
  }
  const P = fakePhone({ [U]: U_PHONE, [V]: V_PHONE });
  let now = Date.parse("2026-11-09T15:00:00Z");
  const telegram: Record<string, string> = { "7001": U, "7002": V };
  const d: FileDeps = { store, sessions, phone: P.auth, now: () => now, userOfTelegram: async (id) => telegram[id] ?? null,
    env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] }, cards: {} as never, tap: {} as never };
  const link = async (user: string, list: string, at = now) => (await mintFileToken({ secret: SECRET, userId: user, list, now: at, kind: "l" }))!;
  const req = (o: { get?: string; form?: Record<string, string>; cookie?: string }) => handleFile(new Request(`https://trainee.example/file${o.get ?? ""}`, o.form
    ? { method: "POST", headers: { cookie: o.cookie ?? "", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o.form).toString() }
    : { headers: { cookie: o.cookie ?? "" } }), d);
  const cookies = (r: Response) => Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, ...x]) => [k, x.join("=")]));
  const q = async (s: string) => (await pg.sql(s)).trim();
  return { pg, P, d, link, req, cookies, q, setNow: (t: number) => { now = t; }, getNow: () => now };
}
const needsPg = () => { if (pgBinDir()) return true; if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return false; };
const asRoot = () => { if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return true; } return false; };

Deno.test({ name: "R10 fix 10 sign-in: a valid link -> Sign in -> Check your phone -> the right code -> a session for exactly that account, read back from Postgres", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!needsPg() || asRoot()) return;
  const w = await world();
  try {
    const open = await w.req({ get: `?t=${encodeURIComponent(await w.link(U, U_LIST))}` });
    eq(open.status, 303);
    const lc = `tf_l=${w.cookies(open).tf_l}`;
    // the phone entry
    const entry = await (await w.req({ cookie: lc })).text();
    eq(h1(entry), "Sign in");
    assert(/name="phone"/.test(entry) && />Send code</.test(entry) && /Open from Telegram/.test(entry), "phone entry: the field, Send code, and the Telegram way");
    for (const secret of [U_CO, V_CO, U_PHONE, V_PHONE]) assert(!entry.includes(secret), `the sign-in shows no ${secret}`);
    // code sent: the same heading and words for any number (the page never says whose it is)
    const sent = await (await w.req({ form: { action: "phone_start", phone: "512-555-0140" }, cookie: lc })).text();
    eq(h1(sent), "Check your phone");
    assert(/If that is the number on your Trainee account, we texted it a code/.test(plain(sent)) && /name="code"/.test(sent) && !/name="code"[^>]*value=/.test(sent), "the code field, empty");
    assert(/Use a different number/.test(sent) && />Sign in</.test(sent), "Sign in, and Use a different number");
    assert(/<p id="verifying" class="status" role="status" hidden>Checking this sign-in\. Private content remains hidden\.<\/p>/.test(sent), "the verifying status is there, hidden until the code is sent");
    assert(/script-src 'sha256-/.test((await w.req({ cookie: lc })).headers.get("content-security-policy") ?? ""), "the code step's script is allowed by hash");
    const stranger = await w.link(U, U_LIST);
    const o2 = await w.req({ get: `?t=${encodeURIComponent(stranger)}` });
    const other = await (await w.req({ form: { action: "phone_start", phone: "+14155550123" }, cookie: `tf_l=${w.cookies(o2).tf_l}` })).text();
    eq(plain(other.replace(/<input[^>]*>/g, "")), plain(sent.replace(/<input[^>]*>/g, "")), "a stranger's number gets exactly the same page");
    // the right code
    const ok = await w.req({ form: { action: "phone_verify", code: w.P.lastCode() }, cookie: lc });
    eq(ok.status, 303);
    const sid = w.cookies(ok).tf_s;
    assert(/^fs1\.[0-9a-f]{64}$/.test(sid), "a session cookie");
    eq(await w.q(`select user_id || ' ' || via || ' ' || phone || ' ' || list from trainee_file_sessions where id_hash = '${await sha256(sid)}' and revoked_at is null`), `${U} phone ${U_PHONE} ${U_LIST}`);
    const page = await w.req({ cookie: `tf_s=${sid}` });
    eq(page.status, 200);
    const ph = await page.text();
    assert(ph.includes(U_CO), "signed in: the person's own list");
    // "Signed in" only now, after real authentication, masked, beside Sign out (spec C.23 panel 5, E.7 #58)
    assert(/<div class="signedin" role="status"><span>Signed in with your phone number<\/span>/.test(ph), "the signed-in mark");
    assert(!ph.includes(U_PHONE) && !ph.includes(U_PHONE.slice(-4)), "no digit of the number, not even the last 4");
    for (const [name, h] of [["phone entry", entry], ["code sent", sent], ["a stranger's number", other]] as const) assert(!/Signed in with/.test(h), `${name}: never 'Signed in' before authentication`);
    const bar = ph.match(/<div class="signedin"[\s\S]*?<\/div>/)![0];
    const pageTok = bar.match(/name="t" value="([^"]+)"/)![1];
    assert(/name="action" value="signout"/.test(bar) && />Sign out</.test(bar), "Sign out in the bar");
    // signing out makes the private page unavailable again
    const out = await w.req({ form: { t: pageTok, action: "signout" }, cookie: `tf_s=${sid}` });
    eq(out.status, 200);
    assert(/Signed out/.test(await out.text()) && /tf_s=;/.test(out.headers.get("set-cookie") ?? ""));
    assert(await w.q(`select revoked_at is not null from trainee_file_sessions where id_hash = '${await sha256(sid)}'`) === "t", "revoked in the database");
    const after = await w.req({ cookie: `tf_s=${sid}` });
    eq(after.status, 401);
    assert(!(await after.text()).includes(U_CO), "the list is unavailable after signing out");
  } finally { await w.pg.stop(); }
} });

Deno.test({ name: "R10 fix 10 binding: a session shows only its own account's content (phone and Telegram), never the other's, even with the other's list id; a wrong code shows nothing private", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!needsPg() || asRoot()) return;
  const w = await world();
  try {
    // V's link, signed in with V's phone: V's list only.
    const ov = await w.req({ get: `?t=${encodeURIComponent(await w.link(V, V_LIST))}` });
    const lv = `tf_l=${w.cookies(ov).tf_l}`;
    await w.req({ form: { action: "phone_start", phone: V_PHONE }, cookie: lv });
    // a wrong code first: the named state, Try again, and nothing private
    const wrong = await w.req({ form: { action: "phone_verify", code: "000000" }, cookie: lv });
    eq(wrong.status, 401);
    const wh = await wrong.text();
    eq(h1(wh), "That code did not work");
    assert(/role="alert"/.test(wh) && /Check the latest code or request a new one/.test(wh) && />Try again</.test(wh) && /Use a different number/.test(wh));
    for (const secret of [U_CO, V_CO, "Sign out"]) assert(!wh.includes(secret), `a wrong code shows no ${secret}`);
    eq(await w.q(`select count(*) from trainee_file_sessions`), "0", "no session from a wrong code");
    const sid = w.cookies(await w.req({ form: { action: "phone_verify", code: w.P.lastCode() }, cookie: lv })).tf_s;
    eq(await w.q(`select user_id from trainee_file_sessions where id_hash = '${await sha256(sid)}'`), V, "bound to V");
    const vh = await (await w.req({ cookie: `tf_s=${sid}` })).text();
    assert(vh.includes(V_CO) && !vh.includes(U_CO), "V sees V's list and not U's");

    // U's link typed with V's number (a forwarded link): V's code never opens U's list.
    const ou = await w.req({ get: `?t=${encodeURIComponent(await w.link(U, U_LIST))}` });
    const lu = `tf_l=${w.cookies(ou).tf_l}`;
    const texts = w.P.texts.length;
    await w.req({ form: { action: "phone_start", phone: V_PHONE }, cookie: lu });
    eq(w.P.texts.length, texts, "no code is texted to a number that is not the link's account");
    const cross = await w.req({ form: { action: "phone_verify", code: "314166" }, cookie: lu });
    eq(cross.status, 401);
    assert(!(await cross.text()).includes(U_CO));
    eq(await w.q(`select count(*) from trainee_file_sessions where user_id = '${U}'`), "0", "U has no session");

    // Telegram: the signed identity decides the account, not the list id in the request. tg 7002 is V; with U's list id it never gets U's list.
    const init = await signedInit("7002", Math.floor(w.getNow() / 1000), BOT_TOKEN);
    const tg = await w.req({ form: { init, list: U_LIST } });
    const tgh = await tg.text();
    assert(!tgh.includes(U_CO), "V's Telegram with U's list id never shows U's list");
    eq(await w.q(`select user_id || ' ' || via || ' ' || telegram_id from trainee_file_sessions where via = 'telegram'`), `${V} telegram 7002`, "the Telegram session is V's");
    const tgu = await (await w.req({ form: { init: await signedInit("7001", Math.floor(w.getNow() / 1000), BOT_TOKEN), list: U_LIST } })).text();
    assert(tgu.includes(U_CO) && !tgu.includes(V_CO), "U's Telegram opens U's list only");
    // an unlinked Telegram account: stays out, nothing private
    const nobody = await (await w.req({ form: { init: await signedInit("7999", Math.floor(w.getNow() / 1000), BOT_TOKEN), list: U_LIST } })).text();
    assert(/isn't linked/.test(plain(nobody)) && !nobody.includes(U_CO) && !nobody.includes(V_CO));
    // the Telegram entry page itself (opened outside Telegram): its own named state, the way back, nothing about anyone
    const entry = await (await w.req({ get: `?list=${U_LIST}` })).text();
    eq(h1(entry), "Open from your Trainee chat");
    assert(/Use the button in your Trainee chat to identify your account/.test(entry) && /Open Telegram/.test(entry) && entry.includes(BOT_URL) && /Sign in another way/.test(entry));
    assert(!entry.includes(U_CO) && !entry.includes(V_CO));
  } finally { await w.pg.stop(); }
} });

Deno.test({ name: "R10 fix 10 recovery: an expired, invalid, used or bare link shows its heading and the recovery action (Get a new link) and no private content", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!needsPg() || asRoot()) return;
  const w = await world();
  try {
    const old = await w.link(U, U_LIST, w.getNow() - 3 * 86_400_000);
    const used = await w.link(U, U_LIST);
    const o = await w.req({ get: `?t=${encodeURIComponent(used)}` });
    await w.req({ form: { action: "phone_start", phone: U_PHONE }, cookie: `tf_l=${w.cookies(o).tf_l}` });
    await w.req({ form: { action: "phone_verify", code: w.P.lastCode() }, cookie: `tf_l=${w.cookies(o).tf_l}` });
    const cases: [string, string, RegExp][] = [
      ["bare /file", "", /isn't valid/], ["expired link", `?t=${encodeURIComponent(old)}`, /expired/], ["invalid link", `?t=${encodeURIComponent(used.slice(0, -6) + "AAAAAA")}`, /isn't valid/],
      ["used link", `?t=${encodeURIComponent(used)}`, /already used/],
    ];
    for (const [name, q, title] of cases) {
      const r = await w.req({ get: q });
      const html = await r.text();
      assert(r.status >= 400, `${name}: not a 200 (${r.status})`);
      assert(title.test(h1(html)), `${name}: the heading says what happened (${h1(html)})`);
      assert(new RegExp(`<p class="recovery"><a class="apply" href="${BOT_URL.replace(/[.]/g, "\\.")}"[^>]*>Get a new link</a>`).test(html), `${name}: the recovery action`);
      for (const secret of [U_CO, V_CO, U_PHONE, "Sign out", ">Apply<"]) assert(!html.includes(secret), `${name}: no ${secret}`);
    }
  } finally { await w.pg.stop(); }
} });

Deno.test("R10 fix 10 the results list: 'Signed in' and Sign out from the verified session; signing out makes the list unavailable", async () => {
  const R = await import("../helpers/results_world.ts");
  const w = R.world(); const r = await R.made(w);
  // A fixed session id, opened the way w.A.tok opens one (the phone session store), instead of a random one: the page carries
  // the session's page token (an HMAC of the id), and a random 64-hex token sometimes held "1000", the fake phone's last 4 digits,
  // which failed the check below by chance (CI run 42719744871). Neither the fixed id nor its page token contains a run of the
  // number's last 4, checked first so a change to the secret or the token's shape cannot bring the flake back unseen.
  const s = `fs1.${"ab".repeat(32)}`, last4 = w.A.phoneOf(R.U).slice(-4);
  await w.A.store.createSession({ idHash: await sha256(s), userId: R.U, via: "phone", phone: w.A.phoneOf(R.U), telegramId: null, list: r.listId, at: R.NOW, expiresAt: R.NOW + SESSION_TTL_MS });
  assert(!s.includes(last4) && !(await pageTokenOf(await sha256(s), R.SECRET) ?? "").includes(last4), "the fixed test token holds none of the phone's digits");
  const html = await (await R.get(w, s)).text();
  const bar = html.match(/<div class="signedin" role="status">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert(bar.includes("Signed in with your phone number") && />Sign out</.test(bar), bar || "no signed-in bar on the results list");
  assert(!html.includes(w.A.phoneOf(R.U)) && !html.includes(w.A.phoneOf(R.U).slice(-4)), "no digit of the number, not even the last 4");
  const out = await R.post(w, s, { action: "signout" });
  eq(out.status, 200);
  assert(/Signed out/.test(await out.text()));
  const gone = await R.get(w, s);
  eq(gone.status, 401);
  assert(!/class="card"/.test(await gone.text()), "no role card after signing out");
});
