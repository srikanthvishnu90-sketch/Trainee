// A copied page is not a session (scenarios-file-session-binding-battery.ts) on real Postgres 16 (the flow harness: every migration
// in production order), through the deployed session store (supabaseSessionStore over the real supabase-js client; the only seam is
// the HTTP hop, answered by the PostgREST double as the service role). A seeded sample of every category: a saved, copied or
// replayed page reads nothing, approves nothing and leaves trainee_file_sessions / trainee_file_logins exactly as they were; the
// table holds each session's hash, never an id; the owner's own browser and the Mini App with fresh Telegram data still work.
// No network: the phone and its texts are fakes.
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { CATEGORIES, generate, newReport, printReport, runScenario } from "./scenarios-file-session-binding-battery.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const PER_CAT = 8;

Deno.test({ name: `file page session binding on real Postgres: ${PER_CAT * CATEGORIES.length} sampled scenarios through supabaseSessionStore`, sanitizeOps: false, sanitizeResources: false, async fn() {
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

    const per = new Map<string, number>();
    const picked = generate().filter((s) => { const n = per.get(s.cat) ?? 0; if (n >= PER_CAT || s.id % 5 !== 2) return false; per.set(s.cat, n + 1); return true; });
    let n = 0;
    const started = Date.now();
    for (const s of picked) {
      n++;
      const ids = { u: `cccccccc-0000-4000-8000-${String(2 * n).padStart(12, "0")}`, v: `cccccccc-0000-4000-8000-${String(2 * n + 1).padStart(12, "0")}` };
      await pg.sql(`insert into auth.users (id, email) values ('${ids.u}', 'sb-u${n}@example.test'), ('${ids.v}', 'sb-v${n}@example.test');`);
      await runScenario(s, { ids, sessions: store,
        async snapshot() {
          return JSON.stringify(await json(`select json_build_array(
            (select coalesce(json_agg(json_build_array(id_hash, user_id, via, list, expires_at, revoked_at) order by id_hash), '[]') from trainee_file_sessions where user_id in ('${ids.u}', '${ids.v}')),
            (select coalesce(json_agg(json_build_array(jti, phone, matched, sends, tries, expires_at, done_at) order by jti), '[]') from trainee_file_logins where user_id in ('${ids.u}', '${ids.v}')))`));
        } }, rep);
    }
    console.log(`[file-session-binding] Postgres run: ${picked.length} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    eq(picked.length, PER_CAT * CATEGORIES.length, "every category sampled");
    // the table holds hashes only: no stored value is shaped like a session id or a page token
    eq(await pg.sql(`select count(*) from trainee_file_sessions where id_hash !~ '^[0-9a-f]{64}$'`), "0");
    eq(outside, [], "nothing left the machine but the PostgREST double");
  } finally {
    globalThis.fetch = realFetch;
    await pg.stop();
  }
  eq(printReport("real Postgres", rep), 0, "every invariant held after every request, and the tables agree");
} });
