// The file page sign-in round 4 battery (scenarios-file-signin-r4-battery.ts) on real Postgres 16 (the flow harness: every
// migration in production order, 20261105150000_trainee_file_erase_r4.sql included), through the deployed session store
// (supabaseSessionStore over the real supabase-js client; the only seam is the HTTP hop, answered by the PostgREST double as the
// service role) and the real trainee-file handler. A seeded sample of every category, with the account's erase done the way
// production does it (the account row written with a higher epoch and paused, which fires the erase triggers) and account deletion
// as a real delete of auth.users; then, read back from the tables: an erase leaves the person no session and no sign-in that holds
// a number or can still be finished, and keeps the counts the limits read. No network: the phone and its texts are fakes.
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { handleFile, type FileDeps } from "../../supabase/functions/trainee-file/handler.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { CATEGORIES, type Env, generate, HOST, newReport, printReport, runScenario, SECRET } from "./scenarios-file-signin-r4-battery.ts";
import { fakePhone } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const PER_CAT = 24;

Deno.test({ name: `file page sign-in round 4 on real Postgres: ${PER_CAT * CATEGORIES.length} sampled scenarios through the handler and supabaseSessionStore; an erase signs every page out`, sanitizeOps: false, sanitizeResources: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const rep = newReport();
  try {
    const URL_ = "http://supabase.test", KEY = ["service", "test", "key"].join("-");
    const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
    const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    const outside: string[] = [];
    globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    const store = supabaseSessionStore(admin);
    const json = async (q: string) => JSON.parse((await pg.sql(q)).trim() || "null");
    const epoch = new Map<string, number>();
    const eraseOf = async (user: string, how: "erase" | "delete") => {
      if (how === "delete") { await pg.sql(`delete from auth.users where id = '${user}';`); return; }
      const e = (epoch.get(user) ?? 0) + 1; epoch.set(user, e);
      await pg.sql(`insert into career_watch_kv (user_id, key, value) values ('${user}', 'career:account', '{"version":${e},"epoch":${e},"paused":true}')
        on conflict (user_id, key) do update set value = excluded.value, updated_at = now();`);
    };

    // ---- the sample: every category, spread by a fixed stride
    const per = new Map<string, number>();
    const picked = generate().filter((s) => { const n = per.get(s.cat) ?? 0; if (n >= PER_CAT || s.id % 5 !== 4) return false; per.set(s.cat, n + 1); return true; });
    let n = 0, erased = 0;
    const started = Date.now();
    for (const s of picked) {
      n++;
      const ids = { u: `dddddddd-0000-4000-8000-${String(2 * n).padStart(12, "0")}`, v: `dddddddd-0000-4000-8000-${String(2 * n + 1).padStart(12, "0")}` };
      await pg.sql(`insert into auth.users (id, email) values ('${ids.u}', 'r4-u${n}@example.test'), ('${ids.v}', 'r4-v${n}@example.test');`);
      const env: Env = { ids, sessions: store,
        async snapshot() {
          return JSON.stringify(await json(`select json_build_array(
            (select coalesce(json_agg(json_build_array(id_hash, user_id, via, list, expires_at, revoked_at) order by id_hash), '[]') from trainee_file_sessions where user_id in ('${ids.u}', '${ids.v}')),
            (select coalesce(json_agg(json_build_array(jti, phone, matched, sends, tries, expires_at, done_at) order by jti), '[]') from trainee_file_logins where user_id in ('${ids.u}', '${ids.v}')))`));
        },
        async erase(who, how) {
          await eraseOf(ids[who], how);
          if (how === "erase") {
            erased++;
            // read back at once: nothing of the person's sign-ins is left that opens anything or holds a number
            eq(await pg.sql(`select count(*) from trainee_file_sessions where user_id = '${ids[who]}'`), "0", `#${s.id}: a session survived the erase`);
            eq(await pg.sql(`select count(*) from trainee_file_logins where user_id = '${ids[who]}' and (phone is not null or done_at is null)`), "0", `#${s.id}: a sign-in survived the erase`);
          }
        } };
      await runScenario(s, env, rep);
    }
    console.log(`[file-signin-r4] Postgres run: ${picked.length} scenarios (${erased} erases) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    eq(picked.length, PER_CAT * CATEGORIES.length, "every category sampled");
    eq(await pg.sql(`select count(*) from trainee_file_sessions where id_hash !~ '^[0-9a-f]{64}$'`), "0", "the table holds hashes only");

    // ---- the erase, end to end through the handler: a live page and a half-done sign-in, then "forget everything"
    const U = "dddddddd-0000-4000-8000-0000000fe4ff", PHONE = "+15125557499", LIST = "0123456789";
    await pg.sql(`insert into auth.users (id, email) values ('${U}', 'r4-erase@example.test');`);
    const P = fakePhone({ [U]: PHONE });
    const now = Date.now();
    const d = { store: { async recall() { return null; }, async recallList() { return []; }, async postings() { return []; } } as never, cards: {} as never, tap: {} as never, now: () => now, sessions: store, phone: P.auth,
      env: { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file` } as Record<string, string>)[k] } } as unknown as FileDeps;
    const call = (o: { q?: string; form?: Record<string, string>; cookie: string }) => handleFile(new Request(`${HOST}/file${o.q ?? ""}`, o.form
      ? { method: "POST", headers: { cookie: o.cookie, origin: HOST, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o.form).toString() } : { headers: { cookie: o.cookie } }), d);
    const jarOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");
    const signIn = async () => {
      const l = (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now, kind: "l" }))!;
      const lc = jarOf(await call({ q: `?t=${encodeURIComponent(l)}`, cookie: "" }));
      await call({ form: { action: "phone_start", phone: PHONE }, cookie: lc });
      return { lc, code: P.lastCode() };
    };
    const a = await signIn();
    const done = await call({ form: { action: "phone_verify", code: a.code }, cookie: a.lc });
    eq(done.status, 303);
    const sc = jarOf(done);
    eq((await call({ cookie: sc })).status, 404, "signed in (the list is empty: 'This list is gone', behind the session)");
    const b = await signIn(); // a second link, its code texted, not typed yet
    eq(await pg.sql(`select count(*) from trainee_file_logins where user_id = '${U}' and phone = '${PHONE}' and done_at is null`), "1");
    await eraseOf(U, "erase");
    const after = await call({ cookie: sc });
    eq([after.status, /You were signed out|This link isn/.test(await after.text())], [403, true], "the live page is signed out by the erase");
    const late = await call({ form: { action: "phone_verify", code: b.code }, cookie: b.lc });
    eq([late.status, /already used/.test(await late.text())], [410, true], "the half-done sign-in cannot be finished");
    eq(await pg.sql(`select count(*) from trainee_file_sessions where user_id = '${U}'`), "0");
    eq(await pg.sql(`select string_agg(coalesce(phone, '-') || ':' || (done_at is not null) || ':' || sends, ',' order by created_at) from trainee_file_logins where user_id = '${U}'`), "-:true:1,-:true:1", "numbers cleared, links used up, counts kept");
    eq(outside, [], "nothing left the machine but the PostgREST double");
  } finally {
    globalThis.fetch = realFetch;
    await pg.stop();
  }
  eq(printReport("real Postgres", rep), 0, "every invariant held after every request, and the tables agree");
} });
