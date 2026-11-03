// SCALE (owner, 2026-10-27: "we need to be able to operate these things at large scale"; D-MS-1 / D-MS-2): one texted
// yes approves a batch of 500 in one bounded call. The production agent-chat handler (handler-career.ts, harness
// tests/flow/handler.ts: real supabase-js, real Postgres 16 with CI's migration order) as the web app's turn: 500 prepared
// applications (each sending a confirmed resume), "show my applications" (one card of 500, paged for reading), "yes".
// Measured: the HTTP requests each turn makes to the database (the PostgREST double's log) and the turn's wall time.
// Asserted: one career_apply_card_answer_as call carries all 500 numbers; 500 career_apply_jobs rows, each bound to the
// hash the card carried; the timeline lines written in one insert; the turn's request count does not grow with the batch
// (the same as a batch of 5, within a fixed allowance); no per-item round trip.
//
// D-MS-2 SETUP, NOT A MIGRATION: builder A's migration removes the database's 8-per-card bound. Until it lands, this test
// removes that bound on its own throwaway database only (the items check, and career_apply_card_open_for's 'between 1 and
// 8' guard, replaced with 'at least 1'), and says so in its output. Once the migration is on trunk, the setup is a no-op.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const BIG = 500, SMALL = 5;
const PEOPLE: Record<string, string> = { "tok-scale-big": "7b0f8f8e-6a43-4a49-9d2c-00000000e500", "tok-scale-small": "7b0f8f8e-6a43-4a49-9d2c-00000000e005" };
const RESUME_FILE = "%PDF-1.4\n% TEST mass-submission scale resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");

// D-MS-2 on this throwaway database only, until builder A's migration is on trunk (then a no-op).
async function liftCardBound(pg: Awaited<ReturnType<typeof startPg>>): Promise<string> {
  const body = await pg.sql(`select pg_get_functiondef('public.career_apply_card_open_for(uuid,uuid[],timestamptz)'::regprocedure)`);
  if (!/not between 1 and 8/.test(body)) return "the database already takes cards of any size (D-MS-2 migration present)";
  await pg.sql(`do $$ declare c text; begin
    for c in select conname from pg_constraint where conrelid = 'public.career_apply_cards'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'jsonb_array_length' loop
      execute format('alter table public.career_apply_cards drop constraint %I', c); end loop;
    alter table public.career_apply_cards add constraint career_apply_cards_items_nonempty check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) >= 1);
  end $$;`);
  await pg.sql(body.replace("cardinality(p_ids) not between 1 and 8", "cardinality(p_ids) < 1"));
  return "TEST SETUP: lifted the database's 8-per-card bound on this throwaway database (builder A's D-MS-2 migration not on trunk yet)";
}

Deno.test({
  name: "SCALE: one plain yes approves 500 in one bounded call; the turn's database requests do not grow with the batch; measured",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the mass-submission scale test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      console.log(await liftCardBound(pg));
      for (const id of Object.values(PEOPLE)) {
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(id, RESUME_FILE)}`);
      }
      h = await careerHandler(pg, PEOPLE);
      // n prepared applications, stored by the person's own computer (career_apply_prepare_own: the database hashes each).
      const prepare = async (person: string, n: number) => {
        const client = pg.asPerson(person);
        for (let i = 1; i <= n; i++) {
          const payload = { version: 1, user_id: person, job_id: `TEST-SCALE-${person.slice(-4)}-${i}`, company: `Scale Employer ${person.slice(-4)}-${i}`, url: `https://jobs.lever.co/scale${i}/${i}`,
            fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "TEST-1" }], privacy_epoch: 0, account_version: 0,
            expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(), resume_sha256: RESUME_SHA };
          const r = await client.rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`Scale Employer ${i}: TEST Analyst`, "Email: t@example.test", `Sends to https://jobs.lever.co/scale${i}/${i}`] });
          assertEquals(r.error, null, JSON.stringify(r.error));
        }
      };
      // One person's two turns, measured: the requests this turn sent to the database, and its time.
      const run = async (token: string, n: number) => {
        const chat = h!.chat(token);
        const turn = async (message: string) => {
          const from = h!.double.log.length, t0 = performance.now();
          const r = await chat.say(message);
          const ms = performance.now() - t0, reqs = h!.double.log.slice(from);
          return { r, ms, reqs };
        };
        const shown = await turn("show my applications");
        assertEquals(shown.r.resultStatus, "shown", shown.r.reply.slice(0, 300));
        const yes = await turn("yes");
        assertEquals(yes.r.resultStatus, "answered", yes.r.reply.slice(0, 300));
        return { n, shown, yes };
      };

      await prepare(PEOPLE["tok-scale-small"], SMALL);
      await prepare(PEOPLE["tok-scale-big"], BIG);
      const small = await run("tok-scale-small", SMALL);
      const big = await run("tok-scale-big", BIG);
      const P = PEOPLE["tok-scale-big"];

      await t.step("the card: one card of 500, every one shown, paged for reading", async () => {
        assertEquals(await pg.sql(`select jsonb_array_length(items) from public.career_apply_cards where user_id = '${P}'`), String(BIG));
        assert(/^500 applications are ready\./.test(big.shown.r.reply), big.shown.r.reply.slice(0, 120));
        const parts: string[] = big.shown.r.body?.parts ?? [];
        assert(parts.length > 1 && parts.every((p) => p.length <= 3800), `${parts.length} pages`);
        assert(!/more (?:is|are) ready; .* on the next card/.test(big.shown.r.reply), "nothing held back for a later card");
        for (const i of [1, 250, 500]) assert(big.shown.r.reply.includes(`${i}. Scale Employer ${i}: TEST Analyst`), `item ${i} shown`);
      });

      await t.step("the yes: one career_apply_card_answer_as call with all 500 numbers; 500 queued, each by the hash shown; the reply says 500", async () => {
        const answers = big.yes.reqs.filter((x) => x.path.includes("/rpc/career_apply_card_answer_as"));
        assertEquals(answers.length, 1, "one batch approval call");
        assertEquals(await pg.sql(`select jsonb_array_length(answer->'approve') from public.career_apply_cards where user_id = '${P}'`), String(BIG));
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P}'`), String(BIG));
        assertEquals(await pg.sql(`select bool_and(j.approval_hash = j.payload_hash and j.payload_hash = p.payload_hash) from public.career_apply_jobs j join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id where j.user_id = '${P}'`), "t");
        assert(/^500 approved exactly as shown\. Nothing has gone to an employer yet\./.test(big.yes.r.reply), big.yes.r.reply.slice(0, 200));
        const inserts = big.yes.reqs.filter((x) => x.method === "POST" && x.path.startsWith("/rest/v1/career_events"));
        assertEquals(inserts.length, 1, "the 500 timeline lines in one insert");
        assertEquals(await pg.sql(`select count(*) from public.career_events where user_id = '${P}' and kind = 'application_approved'`), String(BIG));
      });

      await t.step("bounded: the turns' database requests are the same for 500 as for 5 (no per-item round trip); measured", async () => {
        const rows = [
          ["show my applications", small.shown, big.shown],
          ["yes", small.yes, big.yes],
        ] as const;
        for (const [m, s, b] of rows) {
          console.log(`SCALE ${m}: ${SMALL} items -> ${s.reqs.length} requests, ${Math.round(s.ms)} ms; ${BIG} items -> ${b.reqs.length} requests, ${Math.round(b.ms)} ms`);
          assert(b.reqs.length <= s.reqs.length + 2, `"${m}": ${b.reqs.length} requests for ${BIG} vs ${s.reqs.length} for ${SMALL}: ${b.reqs.map((x) => x.path.split("?")[0]).join(", ")}`);
        }
        // A wall-time sanity bound only (a shared runner varies several-fold; the request count above is the real bound):
        // one yes of 500 in under 2 minutes. Measured on an idle machine: about 2 to 5 s.
        assert(big.yes.ms < 120_000, `the yes of ${BIG} took ${Math.round(big.yes.ms)} ms`);
      });
    } finally {
      h?.restore();
      await pg.stop();
    }
  },
});
