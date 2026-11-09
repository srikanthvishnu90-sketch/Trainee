// Owner clarification (2026-11-09, D-MS-1): "someone can also approve all the applications at once and it could send all of
// them". On the production agent-chat handler (tests/flow/handler.ts: real supabase-js, real Postgres 16 with CI's migration
// order, Supabase-parity grants): five prepared applications, "show my applications" (one card of 5), one plain "yes".
//   1. One yes queues every item in that exact set: 5 career_apply_jobs rows, each under the hash the card carried.
//   2. Each finished application gets its own receipt (runReceipts, career_outbox "receipt:<id>"), and the batch gets ONE
//      closeout (batch_closeout.ts runBatchCloseouts over supabaseBatches, "status:closeout:<card id>") listing every item's
//      outcome: submitted with the employer's email, sent with a page reference only, uncertain, needs you, not sent and why.
//      A second run sends no second closeout; no closeout is sent while any item is still in flight.
//   4. One held for an unanswered required question is marked on the card, stays out of the approved set, and is named with
//      its question in the batch's closeout.
// Fail-first: on #632's head 6b753bd0 there was no batch closeout at all (only the chat overview's "Closeout, from the
// records" block), and the card did not say which items a yes does not cover.
// Fake model only (none is called), no network, $0.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runBatchCloseouts, supabaseBatches } from "../../supabase/functions/_shared/batch_closeout.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const RESUME_FILE = "%PDF-1.4\n% TEST batch closeout resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const PEOPLE: Record<string, string> = { "tok-bc-1": "7b0f8f8e-6a43-4a49-9d2c-0000000bc001", "tok-bc-2": "7b0f8f8e-6a43-4a49-9d2c-0000000bc002" };

Deno.test({
  name: "D-MS-1 batch: one yes to a card of 5 queues 5; 5 receipts and exactly 1 closeout with every outcome; a held item is marked, left out and named",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("the batch closeout test needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      for (const id of Object.values(PEOPLE)) {
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(id, RESUME_FILE)}`);
      }
      h = await careerHandler(pg, PEOPLE);
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const job = (person: string, i: number) => `TEST-BC-${person.slice(-4)}-${i}`;
      const prepare = async (person: string, n: number) => {
        for (let i = 1; i <= n; i++) {
          const payload = { version: 1, user_id: person, job_id: job(person, i), company: `Batch Employer ${i}`, url: `https://jobs.lever.co/batch${i}/${i}`, title: `TEST Analyst ${i}`,
            fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "TEST-1" }], privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
          const r = await pg.asPerson(person).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`Batch Employer ${i}: TEST Analyst ${i}`, "Email: t@example.test", `Sends to https://jobs.lever.co/batch${i}/${i}`] });
          eq(r.error, null, JSON.stringify(r.error));
        }
      };
      const outbox = async (person: string, prefix: string) => (await pg.sql(`select coalesce(string_agg(key, ',' order by key), '') from public.career_outbox where user_id = '${person}' and key like '${prefix}%'`)).split(",").filter(Boolean);
      const closeoutText = async (person: string) => await pg.sql(`select text from public.career_outbox where user_id = '${person}' and key like 'status:closeout:%'`);
      // The worker's outcome for each, written as the queue records it (state, reason, the page's reference, the employer's
      // email matched to it): this test is about the batch's texts, not the employer's form.
      const finish = async (person: string, i: number, set: string) => await pg.sql(`set session_replication_role = replica;
        update public.career_apply_jobs set ${set}, claimed_at = now() - interval '5 minutes', updated_at = now() where user_id = '${person}' and job_id = '${job(person, i)}';
        set session_replication_role = origin;`);
      const receipts = async () => await runReceipts({ outbox: supabaseAlertStore(admin), now: Date.now(),
        finished: async () => JSON.parse((await pg.sql(`select coalesce(json_agg(x), '[]') from (select id, user_id, company, url, state, reason, confirmation_id, email_confirmed_at, evidence, source from public.career_apply_jobs where state in ('confirmed','submitted_unconfirmed','needs_user','failed','not_submitted','unknown_outcome')) x`)) || "[]") });
      const closeouts = async () => await runBatchCloseouts({ outbox: supabaseAlertStore(admin), now: Date.now(), batches: () => supabaseBatches(admin)(new Date(Date.now() - 86_400_000).toISOString()) });

      await t.step("a card of 5, one plain yes: 5 queued, each under the card's hash; 5 receipts; one closeout with every outcome, once", async () => {
        const P = PEOPLE["tok-bc-1"];
        await prepare(P, 5);
        const chat = h!.chat("tok-bc-1");
        const shown = await chat.say("show my applications");
        eq([shown.intent, shown.resultStatus], ["career_apply_card", "shown"], shown.reply);
        assert(/^5 applications are ready\./.test(shown.reply) && /Reply "yes" to send all 5/.test(shown.reply), shown.reply);
        assert(!/Not covered by a yes/.test(shown.reply), `nothing is held on this card: ${shown.reply}`);
        const yes = await chat.say("yes");
        eq([yes.intent, yes.resultStatus], ["career_apply_card_answer", "answered"], yes.reply);
        assert(/^5 approved exactly as shown\. Nothing has gone to an employer yet\./.test(yes.reply), yes.reply);
        eq(Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P}'`)), 5, "every item in the exact set is queued");
        eq(await pg.sql(`select bool_and(j.approval_hash = j.payload_hash and j.payload_hash = p.payload_hash) from public.career_apply_jobs j join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id where j.user_id = '${P}'`), "t", "each under the hash the card showed");

        // Four finish; one is still being sent: no closeout yet (a batch is closed out only once all of it has finished).
        await finish(P, 1, `state = 'confirmed', confirmation_id = 'BE-1001', email_confirmed_at = now(), confirmation_mail_hash = '${"c".repeat(64)}'`);
        await finish(P, 2, `state = 'submitted_unconfirmed', confirmation_id = 'BE-2002'`);
        await finish(P, 3, `state = 'unknown_outcome', reason = 'DRIVER_ERROR'`);
        await finish(P, 4, `state = 'needs_user', reason = 'login_required'`);
        await finish(P, 5, `state = 'driving'`);
        await receipts();
        eq(await closeouts(), 0, "one still in flight: no closeout");
        eq((await outbox(P, "status:closeout:")).length, 0);
        await finish(P, 5, `state = 'not_submitted', reason = 'POSTING_CLOSED'`);
        await receipts();
        eq(await closeouts(), 1, "the batch has finished: one closeout");
        eq(await closeouts(), 0, "a second run sends no second closeout");
        eq((await outbox(P, "receipt:")).length, 5, "each application its own receipt");
        eq((await outbox(P, "status:closeout:")).length, 1, "and the batch one closeout");

        const text = await closeoutText(P);
        assert(text.startsWith("Your batch of 5 is closed out, from the records:\n"), text);
        assert(/Submitted TEST Analyst 1 at Batch Employer 1[^\n]*\. Confirmation: Batch Employer 1's confirmation email \([^)]+\); their page showed BE-1001\./.test(text), text);
        assert(/Sent TEST Analyst 2 at Batch Employer 2[^\n]*; their page showed BE-2002, but Batch Employer 2 has not confirmed it by email yet, so it is not confirmed\./.test(text), text);
        assert(/TEST Analyst 3 at Batch Employer 3: the final step may have landed, but Batch Employer 3 has not confirmed it\. I won't send it again/.test(text), text);
        assert(/TEST Analyst 4 at Batch Employer 4: not submitted \([^)]*sign in[^)]*\)/.test(text), text);
        assert(/TEST Analyst 5 at Batch Employer 5: not submitted \([^)]*closed[^)]*\)/.test(text), text);
        eq(text.split("\n").length, 6, "one line per item, nothing else");
        assert(!/Batch Employer [2-5][^\n]*Confirmation:/.test(text), "only the one confirmed by the employer's email reads as confirmed");
      });

      await t.step("a held item: marked on the card, left out of the yes, named with its question in the closeout", async () => {
        const P = PEOPLE["tok-bc-2"];
        await prepare(P, 3);
        await pg.sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, options, job_ids, company) values
          ('${P}', 'fact:work_authorization', 'fact', 'Are you legally authorized to work in the United States?', 'select', '["Yes","No"]', array['${job(P, 2)}'], 'Batch Employer 2')`);
        const chat = h!.chat("tok-bc-2");
        const shown = await chat.say("show my applications");
        eq(shown.resultStatus, "shown", shown.reply);
        assert(/Not covered by a yes until you answer:\n2\. Batch Employer 2: held back, so a yes does not approve it\. For Batch Employer 2, the form asks: "Are you legally authorized to work in the United States\?"/.test(shown.reply), shown.reply);
        const yes = await chat.say("yes");
        eq(yes.resultStatus, "answered", yes.reply);
        eq(await pg.sql(`select string_agg(company, ',' order by company) from public.career_apply_jobs where user_id = '${P}'`), "Batch Employer 1,Batch Employer 3", "the held one is not in the approved set");
        await finish(P, 1, `state = 'submitted_unconfirmed'`);
        await finish(P, 3, `state = 'submitted_unconfirmed'`);
        await receipts();
        eq(await closeouts(), 1);
        const text = await closeoutText(P);
        assert(text.startsWith("Your batch of 3 is closed out, from the records:\n"), text);
        assert(/TEST Analyst 2 at Batch Employer 2 is ready but not submitted because "Are you legally authorized to work in the United States\?" is unanswered\. For Batch Employer 2, the form asks/.test(text), text);
        eq((await outbox(P, "receipt:")).length, 2, "a receipt for each one that went, none for the held one");
      });
    } finally {
      h?.restore();
      await pg.stop();
    }
  },
});
