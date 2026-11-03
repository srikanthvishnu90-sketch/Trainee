// The file page web-security battery (scenarios-file-websec-battery.ts) on real Postgres 16 (the flow harness: every migration
// in production order, 20261031100000_trainee_file_signin_limits.sql included), through the deployed session store
// (supabaseSessionStore over the real supabase-js client; the only seam is the HTTP hop, answered by the PostgREST double as the
// service role). A seeded sample of the categories that touch the store: a refused cross-site post leaves the tables exactly as
// they were; a HEAD leaves no sign-in row; texts and code checks are capped per account by the database, also when guesses on
// many links run at the same moment. No network: the phone and its texts are fakes.
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES, MAX_CODE_SENDS, MAX_CODE_TRIES } from "../../supabase/functions/_shared/file_session.ts";
import { type Env, generate, newReport, printReport, runScenario } from "./scenarios-file-websec-battery.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const PG_SAMPLE = 80;
const STORE_CATS = new Set(["csrf_phone", "csrf_action", "csrf_init", "methods", "body", "link", "fixation", "devices", "brute", "enum"]);

Deno.test({ name: `file page web security on real Postgres: ${PG_SAMPLE} sampled scenarios through supabaseSessionStore; per-account caps hold under concurrent guesses`, sanitizeOps: false, sanitizeResources: false, async fn() {
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

    // ---- the sample: every category that touches the store, spread by a fixed stride
    const all = generate().filter((s) => STORE_CATS.has(s.cat));
    const picked: typeof all = [];
    const per = new Map<string, number>();
    for (const s of all) { if ((per.get(s.cat) ?? 0) < Math.ceil(PG_SAMPLE / STORE_CATS.size) && picked.length < PG_SAMPLE && s.id % 7 === 3) { picked.push(s); per.set(s.cat, (per.get(s.cat) ?? 0) + 1); } }
    let n = 0;
    const started = Date.now();
    for (const s of picked) {
      n++;
      const ids = { u: `bbbbbbbb-0000-4000-8000-${String(2 * n).padStart(12, "0")}`, v: `bbbbbbbb-0000-4000-8000-${String(2 * n + 1).padStart(12, "0")}` };
      await pg.sql(`insert into auth.users (id, email) values ('${ids.u}', 'ws-u${n}@example.test'), ('${ids.v}', 'ws-v${n}@example.test');`);
      const env: Env = { ids, sessions: store,
        async snapshot() {
          return JSON.stringify(await json(`select json_build_array(
            (select coalesce(json_agg(json_build_array(id_hash, user_id, list, revoked_at) order by id_hash), '[]') from trainee_file_sessions where user_id in ('${ids.u}', '${ids.v}')),
            (select coalesce(json_agg(json_build_array(jti, phone, matched, sends, tries, expires_at, done_at) order by jti), '[]') from trainee_file_logins where user_id in ('${ids.u}', '${ids.v}')))`));
        },
        async liveSessions(who, now) {
          return (await json(`select coalesce(json_agg(id_hash), '[]') from trainee_file_sessions where user_id = '${ids[who]}' and revoked_at is null and expires_at > to_timestamp(${now} / 1000.0)`)) as string[];
        } };
      await runScenario(s, env, rep);
      const rows = await json(`select coalesce(json_agg(json_build_object('s', sends, 't', tries)), '[]') from trainee_file_logins where user_id in ('${ids.u}', '${ids.v}')`) as { s: number; t: number }[];
      for (const r of rows) if (r.s > MAX_CODE_SENDS || r.t > MAX_CODE_TRIES) { const l = rep.violations.get("a sign-in counted past its cap in the table") ?? []; l.push(`#${s.id}: ${r.s}/${r.t}`); rep.violations.set("a sign-in counted past its cap in the table", l); }
    }
    console.log(`[file-websec] Postgres run: ${picked.length} scenarios (${[...per].map(([k, v]) => `${k} ${v}`).join(", ")}) in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    // ---- the per-account caps under concurrency: 12 links of one account, the account's number on each, every text and every
    // guess at the same moment: the database lets exactly the account's caps through, never more
    const U = "bbbbbbbb-0000-4000-8000-0000000fffff";
    await pg.sql(`insert into auth.users (id, email) values ('${U}', 'ws-race@example.test');`);
    const T = Date.parse("2026-11-02T18:00:00Z");
    const jtis = [...Array(12)].map((_, i) => `0000000000c0ff${String(i).padStart(2, "0")}`);
    for (const [i, j] of jtis.entries()) { await store.beginLogin({ jti: j, userId: U, list: "0123456789", at: T + i * 1000, expiresAt: T + 900_000 }); await store.setPhone(j, "+15125550100", true); }
    const sends = (await Promise.all(jtis.flatMap((j) => [0, 1, 2].map(() => store.countSend(j, MAX_CODE_SENDS))))).filter(Boolean).length;
    const tries = (await Promise.all(jtis.flatMap((j) => [0, 1, 2, 3, 4].map(() => store.countTry(j, MAX_CODE_TRIES))))).filter(Boolean).length;
    eq([sends, tries], [ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES], "the account's caps, exactly, under concurrent calls");
    eq(await pg.sql(`select sum(sends) || '/' || sum(tries) from trainee_file_logins where user_id = '${U}'`), `${ACCOUNT_MAX_SENDS}/${ACCOUNT_MAX_TRIES}`);
    // a stranger's number on another link of the account: its own link's tries only (it checks nothing)
    await store.beginLogin({ jti: "0000000000c0ffee", userId: U, list: "0123456789", at: T, expiresAt: T + 900_000 });
    await store.setPhone("0000000000c0ffee", "+14155550123", false);
    eq(await store.countTry("0000000000c0ffee", MAX_CODE_TRIES), true);
    // two hours on, a new link of the account has its whole budget
    await store.beginLogin({ jti: "0000000000c0ffed", userId: U, list: "0123456789", at: T + 2 * 3600_000, expiresAt: T + 2 * 3600_000 + 900_000 });
    await store.setPhone("0000000000c0ffed", "+15125550100", true);
    eq([await store.countSend("0000000000c0ffed", MAX_CODE_SENDS), await store.countTry("0000000000c0ffed", MAX_CODE_TRIES)], [true, true]);
    eq(outside, [], "nothing left the machine but the PostgREST double");
  } finally {
    globalThis.fetch = realFetch;
    await pg.stop();
  }
  eq(printReport("real Postgres", rep), 0, "every invariant held after every request, and the tables agree");
} });
