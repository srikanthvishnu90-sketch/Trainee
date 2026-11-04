// COMPETITIVE-BAR G2 / B10 + B5: "how are my applications doing" and "show proof for X" from state only. Confirmed only by
// the employer's own email (email_confirmed_at); interviews only from mail filed under that application; flagged mail
// never counts; per 100 applications. The migration's view is wired into go-live with a MIGRATION_MARK.
import assert, { deepStrictEqual as eq } from "node:assert/strict";
import { funnelOf, outcomesAsk, outcomesTurn, type OutcomeEvent, type OutcomeJob } from "../../supabase/functions/_shared/career_apply_outcomes.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86400000).toISOString();
const H = (c: string) => c.repeat(64);
const jobs: OutcomeJob[] = [
  { id: "j1", company: "Acme", title: "Data Analyst", state: "confirmed", created_at: ago(3), claimed_at: ago(3), email_confirmed_at: ago(2), confirmation_mail_hash: H("a"), confirmation_id: "ACME-77" },
  { id: "j2", company: "Globex", state: "submitted_unconfirmed", created_at: ago(2), claimed_at: ago(2) },
  { id: "j3", company: "Initech", state: "confirmed", created_at: ago(20), claimed_at: ago(20), email_confirmed_at: ago(19), confirmation_mail_hash: H("c") },
  { id: "j4", company: "Hooli", state: "failed", created_at: ago(1) }, // never went: not counted
];
const events: OutcomeEvent[] = [
  { application_ref: "job:j1", kind: "received", company: "Acme", evidence: "Thanks for applying to Acme, we received your application", message_hash: H("a"), mail_at: ago(2) },
  { application_ref: "job:j1", kind: "interview", company: "Acme", evidence: "We'd like to schedule an interview", message_hash: H("b"), mail_at: ago(1) },
  { application_ref: "job:j3", kind: "received", company: "Initech", evidence: "Application received", message_hash: H("c"), mail_at: ago(19) },
  { application_ref: "job:j3", kind: "rejection", company: "Initech", evidence: "we will not be moving forward", message_hash: H("d"), mail_at: ago(10) },
  { application_ref: "job:j2", kind: "offer", company: "Globex", evidence: "forwarded offer", message_hash: H("e"), mail_at: ago(1), flagged: true }, // evidence only
];
const read = { jobs: async () => jobs, events: async () => events };

Deno.test("asks: messy phrasings route; other text does not", () => {
  for (const m of ["how are my applications doing?", "How's my job search going", "my numbers", "how many interviews have I gotten"]) eq(outcomesAsk(m)?.kind, "funnel", m);
  eq(outcomesAsk("show me proof for Acme"), { kind: "proof", company: "acme" });
  eq(outcomesAsk("did Globex get my application?"), { kind: "proof", company: "globex" });
  eq(outcomesAsk("apply to 50 jobs"), null);
});

Deno.test("funnel from state: confirmed only by email, flagged mail never counts, per 100", () => {
  const f = funnelOf(jobs, events, NOW);
  eq([f.sent, f.confirmed, f.interviews, f.offers, f.rejections, f.replies], [3, 2, 1, 0, 1, 2]);
  eq([f.sent_7d, f.confirmed_7d, f.interviews_7d], [2, 1, 1]);
  eq(f.per100, { confirmed: 66.7, interviews: 33.3, offers: 0, replies: 66.7 });
});

Deno.test("turns: the funnel in plain words; proof is the employer's email, or says plainly there is none", async () => {
  const fun = await outcomesTurn({ message: "how are my applications doing", userId: "u", now: NOW, read });
  assert(fun && /This week: 2 applications sent, 1 confirmed by the employer's email, 1 interview\./.test(fun.reply), fun?.reply);
  assert(/Per 100 applications: 66\.7 confirmed, 33\.3 interviews/.test(fun!.reply), fun!.reply);
  const acme = await outcomesTurn({ message: "show proof for Acme", userId: "u", now: NOW, read });
  assert(/Confirmed by Acme's own email on .*"Thanks for applying to Acme, we received your application"/.test(acme!.reply), acme!.reply);
  assert(/ACME-77/.test(acme!.reply) && /asked you to interview/.test(acme!.reply), acme!.reply);
  const globex = await outcomesTurn({ message: "did Globex get my application", userId: "u", now: NOW, read });
  assert(/not confirmed/.test(globex!.reply) && !/offer/.test(globex!.reply), globex!.reply);
  const none = await outcomesTurn({ message: "show proof for Umbrella", userId: "u", now: NOW, read });
  assert(/no application to Umbrella on record/i.test(none!.reply), none!.reply);
  const broken = await outcomesTurn({ message: "my numbers", userId: "u", now: NOW, read: { jobs: () => Promise.reject(new Error("down")), events: async () => [] } });
  eq(broken!.status, "unreadable");
});

Deno.test("migration: the view is in go-live with its mark, in this lane's range", async () => {
  const sh = await Deno.readTextFile(new URL("../../scripts/launch/trainee-go-live.sh", import.meta.url));
  assert(sh.includes("20261028010000_career_apply_outcomes.sql"));
  assert(sh.includes(`"to_regclass('public.career_apply_outcomes') is not null"`));
  const sql = await Deno.readTextFile(new URL("../../supabase/migrations/20261028010000_career_apply_outcomes.sql", import.meta.url));
  assert(/security_invoker = true/.test(sql) && /email_confirmed_at is not null/.test(sql) && /not e\.flagged/.test(sql));
});
