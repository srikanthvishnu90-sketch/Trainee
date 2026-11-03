// D-MS-1 / D-MS-2 on the real path (owner, 2026-10-27): the production agent-chat handler (handler-career.ts handleChat;
// harness tests/flow/handler.ts: real supabase-js, real Postgres with CI's migration order, Supabase-parity grants and
// row security), the web app's turn (no reply id, as the app sends it). Prepared applications are stored through the
// person's own career_apply_prepare_own (the database computes each hash); "show my applications" opens one card
// (career_apply_card_open_as); the plain texted "yes" approves the batch through career_apply_card_answer_as, the
// existing batch approval, each item by the hash the card carries. Asserted on the database's own rows: career_apply_jobs
// (approval_hash = payload_hash = the hash shown), career_apply_cards (answered once), career_apply_prepared.
// Before builder A's D-MS-2 migration the database refuses a card of more than 8: the chat shows 8 and says how many more
// wait (asserted here); after it, one card carries them all (tests/architect/mass-submit-chat.test.ts, D-MS-2/1).
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";

// The resume file each person's computer sends with every application (synthetic); its sha256 binds into each payload.
const RESUME_FILE = "%PDF-1.4\n% TEST mass-submission resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = {
  "tok-ms-1": "7b0f8f8e-6a43-4a49-9d2c-00000000d001",
  "tok-ms-2": "7b0f8f8e-6a43-4a49-9d2c-00000000d002",
  "tok-ms-3": "7b0f8f8e-6a43-4a49-9d2c-00000000d003",
  "tok-ms-4": "7b0f8f8e-6a43-4a49-9d2c-00000000d004",
};

Deno.test({
  name: "D-MS-1 on the real path: show the batch, one plain 'yes' from the app approves it through career_apply_card_answer_as; wait/maybe approve nothing; a changed payload is refused by name",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the mass-submission handler test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      for (const id of Object.values(PEOPLE)) {
        // OWNER RULE (2026-10-26, #194): each person has a confirmed resume on file, as a file they sent and confirmed.
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(id, RESUME_FILE)}`);
      }
      h = await careerHandler(pg, PEOPLE);
      // n prepared applications, each to its own employer, stored by the person's own computer (career_apply_prepare_own).
      const prepare = async (person: string, n: number) => {
        for (let i = 1; i <= n; i++) {
          const payload = { version: 1, user_id: person, job_id: `TEST-MS-${person.slice(-4)}-${i}`, company: `Mass Employer ${i}`, url: `https://jobs.lever.co/mass${i}/${i}`,
            fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "TEST-1" }], privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
          const r = await pg.asPerson(person).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`Mass Employer ${i}: TEST Analyst`, "Email: t@example.test", `Sends to https://jobs.lever.co/mass${i}/${i}`] });
          assertEquals(r.error, null, JSON.stringify(r.error));
        }
      };
      const jobs = async (person: string) => Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`));
      const bound = async (person: string) => await pg.sql(`select bool_and(j.approval_hash = j.payload_hash and j.payload_hash = p.payload_hash) from public.career_apply_jobs j join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id where j.user_id = '${person}'`);

      await t.step("8 shown, one plain 'yes' (no reply id, as the app sends it): 8 queued, each bound to the hash the card carried; a second yes approves nothing", async () => {
        const P = PEOPLE["tok-ms-1"];
        await prepare(P, 8);
        const chat = h!.chat("tok-ms-1");
        const shown = await chat.say("show my applications");
        assertEquals([shown.intent, shown.resultStatus], ["career_apply_card", "shown"], shown.reply);
        assert(typeof shown.body?.meta?.card_id === "string", "the card's id rides the reply");
        assert(/^8 applications are ready\./.test(shown.reply) && /Reply "yes" to send all 8/.test(shown.reply), shown.reply);
        const yes = await chat.say("yes");
        assertEquals([yes.intent, yes.resultStatus], ["career_apply_card_answer", "answered"], yes.reply);
        assert(/^8 approved exactly as shown\. Nothing has gone to an employer yet\./.test(yes.reply), yes.reply);
        assertEquals(await jobs(P), 8);
        assertEquals(await bound(P), "t", "each queued under the hash the card showed");
        assertEquals(await pg.sql(`select string_agg(state, ',') from public.career_apply_cards where user_id = '${P}'`), "answered");
        const again = await chat.say("yes");
        assertEquals(await jobs(P), 8, `nothing more: ${again.reply}`);
        assert(/already answered/.test(again.reply), again.reply);
      });

      await t.step("12 ready before builder A's migration: the database takes 8 on a card, the chat says 4 more wait; 'yes except 2' approves 7; the next card holds the 4", async () => {
        const P = PEOPLE["tok-ms-2"];
        await prepare(P, 12);
        const chat = h!.chat("tok-ms-2");
        const shown = await chat.say("show my applications");
        assertEquals(shown.resultStatus, "shown", shown.reply);
        const size = Number(await pg.sql(`select jsonb_array_length(items) from public.career_apply_cards where user_id = '${P}' and state = 'open'`));
        if (size === 12) {
          // Builder A's D-MS-2 migration is in: one card of all 12.
          assert(/^12 applications are ready\./.test(shown.reply), shown.reply);
          const yes = await chat.say("yes except 2");
          assert(/^11 approved exactly as shown; 1 of the 12 not sent/.test(yes.reply), yes.reply);
          assertEquals(await jobs(P), 11);
          return;
        }
        assertEquals(size, 8, "the database's card bound before D-MS-2");
        assert(/^8 applications are ready\./.test(shown.reply) && /4 more are ready; they come on the next card after you answer this one\./.test(shown.reply), shown.reply);
        const yes = await chat.say("yes except 2");
        assert(/^7 approved exactly as shown; 1 of the 8 not sent, each below with why\./.test(yes.reply) && /\n2\. Mass Employer 2: not sent: you left it out/.test(yes.reply), yes.reply);
        assertEquals(await jobs(P), 7);
        const next = await chat.say("show my applications");
        assert(/^4 applications are ready\./.test(next.reply), next.reply);
        const yes2 = await chat.say("yes");
        assert(/^4 approved exactly as shown\./.test(yes2.reply), yes2.reply);
        assertEquals(await jobs(P), 11);
      });

      await t.step("'wait' and 'maybe' approve nothing and keep the card waiting; then 'only 1 and 3' approves exactly those", async () => {
        const P = PEOPLE["tok-ms-3"];
        await prepare(P, 4);
        const chat = h!.chat("tok-ms-3");
        await chat.say("show my applications");
        for (const [m, words] of [["wait", /^Okay, holding: nothing was approved and nothing was sent\./], ["maybe", /^I couldn't tell which ones you mean, so nothing was approved\./], ["yes but not the one in Ohio", /nothing was approved/]] as const) {
          const r = await chat.say(m);
          assertEquals(r.intent, "career_apply_card", `${m}: the card stays the thread's last word`);
          assert(words.test(r.reply), `${m}: ${r.reply}`);
          assertEquals(await jobs(P), 0, m);
        }
        const r = await chat.say("only 1 and 3");
        assert(/^2 approved exactly as shown; 2 of the 4 not sent/.test(r.reply), r.reply);
        assertEquals(await pg.sql(`select string_agg(company, ',' order by company) from public.career_apply_jobs where user_id = '${P}'`), "Mass Employer 1,Mass Employer 3");
      });

      await t.step("a payload that changed since the card was shown: refused by name, the rest queued", async () => {
        const P = PEOPLE["tok-ms-4"];
        await prepare(P, 3);
        const chat = h!.chat("tok-ms-4");
        await chat.say("show my applications");
        // The prepared row's payload changed after the card was shown (as a re-prepare under a new hash does).
        await pg.sql(`update public.career_apply_prepared set payload_hash = repeat('e', 64) where user_id = '${P}' and job_id = 'TEST-MS-${P.slice(-4)}-2'`);
        const r = await chat.say("yes");
        assert(/^2 approved exactly as shown; 1 of the 3 not sent/.test(r.reply) && /\n2\. Mass Employer 2: not sent: it changed after the card was shown/.test(r.reply), r.reply);
        assertEquals(await pg.sql(`select string_agg(company, ',' order by company) from public.career_apply_jobs where user_id = '${P}'`), "Mass Employer 1,Mass Employer 3");
      });
    } finally {
      h?.restore();
      await pg.stop();
    }
  },
});
