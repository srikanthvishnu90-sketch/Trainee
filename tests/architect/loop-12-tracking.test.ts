// Item 12 (tracking), the loop: after Trainee sends applications, the employer's mail is read and the person asks where
// things stand. On a real Postgres 16 with every migration, the production mail run (career_inbox_followups.ts mailNow ->
// career_proactive_run.ts runMail, with supabaseMailStore and supabaseConfirmStore over supabase-js) files each email, and
// the production chat handler (agent-chat handler-career.ts handleChat) answers the status asks. Only Gmail is replaced:
// the read hands over the emails below as Gmail would.
//   seed    application rows written straight in with the triggers off (session_replication_role = replica), in every
//           state an answer has to tell apart; the database's own check constraints still hold
//   mail    an employer's receipt, a rejection, a receipt then an interview invitation, a recruiter's request for more
//           information (from a person, and through the ATS: the rules read that one as unclear, so it is filed under
//           nothing here and goes to the mail model's second look in production, asserted below), a rejection for an application that never went, a
//           receipt for one of two roles at one employer, a newsletter and a job-board alert
//   asks    "did my application to <employer> go through?" for each employer and "where are my applications?"
// The bar (one number each, all 0):
//   wrong_statuses      each application's line says what its record and its employer's mail say, and nothing else
//   mismatched_mail     each email is filed under the right application (career_mail_events.application_ref) or none
//   next_actions        each reply holds exactly one next action (one "Next: " line)
//   unproven_confirmed  "confirmed" is said only for a row with email_confirmed_at and confirmation_mail_hash whose
//                       email is on record under that application
// Fail-first: on trunk 2af8f1be a rejection or interview email left the reply saying "submitted, and X confirmed it",
// and no reply named a next action.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { mailNow } from "../../supabase/functions/_shared/career_inbox_followups.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { supabaseConfirmStore } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { classifyMail } from "../../supabase/functions/_shared/career_mail.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000c1201", TOKEN = "tok-loop-12";
const DAY = 86_400_000, NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const lit = (s: string | null) => (s === null ? "null" : `'${s.replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------------------------- the applications
type Want = "confirmed" | "rejected" | "interview" | "replied" | "submitted" | "page_only" | "unknown" | "not_sent";
interface App { key: string; id: string; company: string; title: string; state: string; reason?: string; confirmation_id?: string; want: Want }
const id = (n: number) => `00000000-0000-4000-8000-0000000c12${String(n).padStart(2, "0")}`;
const APPS: App[] = [
  { key: "acme_ops", id: id(1), company: "Acme Analytics", title: "Operations Analyst", state: "submitted_unconfirmed", want: "confirmed" },
  { key: "acme_mkt", id: id(2), company: "Acme Analytics", title: "Marketing Coordinator", state: "submitted_unconfirmed", want: "submitted" },
  { key: "birch", id: id(3), company: "Birch Labs", title: "Data Analyst", state: "submitted_unconfirmed", want: "rejected" },
  { key: "cobalt", id: id(4), company: "Cobalt Systems", title: "Software Engineer Intern", state: "submitted_unconfirmed", want: "interview" },
  { key: "dune", id: id(5), company: "Dune Health", title: "Product Analyst", state: "submitted_unconfirmed", want: "replied" },
  { key: "elm", id: id(6), company: "Elm Retail", title: "UX Designer", state: "submitted_unconfirmed", want: "submitted" },
  { key: "fjord", id: id(7), company: "Fjord Media", title: "Content Strategist", state: "confirmed", confirmation_id: "FJ-1001", want: "page_only" },
  { key: "grove", id: id(8), company: "Grove Bank", title: "Risk Analyst", state: "unknown_outcome", want: "unknown" },
  { key: "hazel", id: id(9), company: "Hazel Foods", title: "Supply Chain Analyst", state: "not_submitted", reason: "POSTING_CLOSED", want: "not_sent" },
  { key: "iris", id: id(10), company: "Iris Labs", title: "Research Assistant", state: "submitted_unconfirmed", want: "submitted" },
];
const SENT_AT = NOW - 4 * DAY;

// ---------------------------------------------------------------------------------------------- the employer's mail
const authFor = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=AbC; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const GH = "us.greenhouse-mail.io";
const viaAts = (co: string) => ({ from: `${co} <no-reply@${GH}>`, auth: authFor(GH) });
interface Mail { key: string; from: string; auth: string[]; subject: string; snippet: string; at: number; to: string | null }
const MAILS: Mail[] = [
  { key: "acme_received", ...viaAts("Acme Analytics"), subject: "Thank you for applying to Acme Analytics",
    snippet: "We have received your application for the Operations Analyst role and will review it shortly.", at: NOW - 3 * DAY, to: "acme_ops" },
  { key: "birch_rejection", ...viaAts("Birch Labs"), subject: "Your application to Birch Labs",
    snippet: "Thank you for your interest in the Data Analyst position. Unfortunately, we have decided to move forward with other candidates.", at: NOW - 2 * DAY, to: "birch" },
  { key: "cobalt_received", ...viaAts("Cobalt Systems"), subject: "Thank you for applying to Cobalt Systems",
    snippet: "We have received your application for the Software Engineer Intern role and will review it shortly.", at: NOW - 3 * DAY, to: "cobalt" },
  { key: "cobalt_interview", ...viaAts("Cobalt Systems"), subject: "Interview invitation: Software Engineer Intern at Cobalt Systems",
    snippet: "We'd like to invite you to interview for the Software Engineer Intern role. Please pick a time that works for you.", at: NOW - 1 * DAY, to: "cobalt" },
  { key: "dune_info", from: "Priya Shah <priya.shah@dunehealth.example>", auth: authFor("dunehealth.example"), subject: "Product Analyst application: one more thing",
    snippet: "Hi Ada, could you share your expected graduation date and your work authorization status? We need it to move your application for the Product Analyst role forward.", at: NOW - 1 * DAY, to: "dune" },
  { key: "iris_info", ...viaAts("Iris Labs"), subject: "Your application for Research Assistant at Iris Labs",
    snippet: "Could you send us a copy of your unofficial transcript so we can continue reviewing your application for the Research Assistant role?", at: NOW - 1 * DAY, to: null },
  { key: "hazel_rejection", ...viaAts("Hazel Foods"), subject: "Your application to Hazel Foods",
    snippet: "Thank you for your interest in the Supply Chain Analyst position. Unfortunately, we have decided to move forward with other candidates.", at: NOW - 2 * DAY, to: null },
  { key: "newsletter", from: "Hollow Weekly <news@hollowweekly.example>", auth: authFor("hollowweekly.example"), subject: "This week's top 10 productivity tips",
    snippet: "Read our latest blog posts and unsubscribe any time.", at: NOW - 2 * DAY, to: null },
  { key: "job_alert", from: "Job Alerts <alerts@jobboard.example>", auth: authFor("jobboard.example"), subject: "New jobs for Data Analyst near you",
    snippet: "5 new jobs match your search: Data Analyst at Birch Labs and more.", at: NOW - 2 * DAY, to: null },
];

// ---------------------------------------------------------------------------------------------- reading a reply
// What one line says about one application. The most specific reading wins; a line that says none of these is "unread".
function said(line: string): Want | "unread" {
  if (/turned (?:it|you) down|said no\b|not moving forward|decided to move forward with other/i.test(line)) return "rejected";
  if (/invited you to (?:an )?interview|asked you to interview/i.test(line)) return "interview";
  if (/wrote back to you/i.test(line)) return "replied";
  if (/may have landed/.test(line)) return "unknown";
  if (/: not sent\b/.test(line)) return "not_sent";
  if (/has not confirmed it by email yet/.test(line)) return "page_only";
  if (/has not confirmed it yet/.test(line)) return "submitted";
  if (/, and .+ confirmed it\b/.test(line)) return "confirmed";
  return "unread";
}
// The line for one application in a reply: the queue's line names the employer and the role ("Acme Analytics
// (Operations Analyst): ...").
const lineFor = (reply: string, a: App) => reply.split("\n").map((l) => l.replace(/^- /, "")).find((l) => l.startsWith(`${a.company} (${a.title}):`)) ?? null;
const nextCount = (reply: string) => reply.split("\n").filter((l) => /^Next: \S/.test(l)).length;

Deno.test({
  name: "loop 12: tracking: employer mail filed to the right application, every status as recorded, one next action, nothing confirmed without the employer's email",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg = await startPg();
    let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${U}', 'loop12@example.test'); insert into public.profiles (id) values ('${U}');
        insert into public.career_watch_kv (user_id, key, value) values ('${U}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes)
        values ('${U}', 'google_career', 'oauth_google_career_${U}', 'loop12@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly');`);
      // The seed: the rows as the queue would hold them, written with the triggers off (no state machine runs).
      const rows: string[] = [];
      for (const a of APPS) {
        const url = `https://boards.greenhouse.io/${a.key}/jobs/12${a.id.slice(-2)}`;
        const payload = JSON.stringify({ version: 1, user_id: U, job_id: `greenhouse:${a.key}:12`, company: a.company, title: a.title, url });
        const h = await hex(payload);
        rows.push(`('${a.id}', '${U}', 'greenhouse:${a.key}:12', ${lit(a.company)}, '${url}', ${lit(payload)}::jsonb, '${h}', '${h}', '${a.state}', ${lit(a.reason ?? null)},
          ${lit(a.confirmation_id ?? null)}, ${a.state === "not_submitted" || a.state === "queued" ? 0 : 1}, '${iso(SENT_AT)}', '${iso(SENT_AT - 600_000)}', '${iso(SENT_AT + 60_000)}')`);
      }
      await pg.sql(`set session_replication_role = replica;
        insert into public.career_apply_jobs (id, user_id, job_id, company, url, payload, payload_hash, approval_hash, state, reason, confirmation_id, attempts, claimed_at, created_at, updated_at)
        values ${rows.join(",\n")};
        set session_replication_role = origin;`);

      handler = await careerHandler(pg, { [TOKEN]: U });
      // deno-lint-ignore no-explicit-any
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      const hashes = new Map<string, string>();
      for (const m of MAILS) hashes.set(m.key, await hex(`loop12:${m.key}`));
      const mails = MAILS.map((m) => ({ hash: hashes.get(m.key)!, from: m.from, subject: m.subject, snippet: m.snippet, date: iso(m.at), auth: m.auth }));
      const ran = await mailNow({ userId: U, now: NOW, store: supabaseMailStore(admin), cursor: async () => null, confirm: supabaseConfirmStore(admin),
        read: async () => ({ status: "ok", mails, readThrough: NOW, listed: mails.length }) });
      assert(ran.status === "ok", `the mail run: ${JSON.stringify(ran)}`);
      const iris = mails[MAILS.findIndex((m) => m.key === "iris_info")];
      assert(classifyMail(iris).ambiguous === true, "the ATS's request for a transcript is unclear to the rules: the mail model's second look reads it");

      // mismatched_mail: each email under the right application, or none.
      const filed = JSON.parse((await pg.sql(`select coalesce(json_agg(json_build_object('h', message_hash, 'ref', application_ref, 'kind', kind)), '[]')::text from public.career_mail_events where user_id = '${U}'`)).trim());
      const problems: string[] = [];
      let mismatched = 0;
      for (const m of MAILS) {
        const ev = filed.find((e: any) => e.h === hashes.get(m.key));
        const ref = ev && String(ev.ref).startsWith("job:") ? String(ev.ref).slice(4) : null;
        const want = m.to ? APPS.find((a) => a.key === m.to)!.id : null;
        if (ref !== want) { mismatched++; problems.push(`mail ${m.key}: filed under ${ref ? APPS.find((a) => a.id === ref)?.key ?? ref : "none"} (${ev?.kind ?? "no event"}), want ${m.to ?? "none"}`); }
      }

      // The asks, through the handler.
      const chat = handler.chat(TOKEN);
      const replies: { ask: string; reply: string; apps: App[] }[] = [];
      for (const company of [...new Set(APPS.map((a) => a.company))]) {
        const ask = `did my application to ${company} go through?`;
        const t = await chat.say(ask);
        replies.push({ ask, reply: t.reply, apps: APPS.filter((a) => a.company === company) });
      }
      const all = await chat.say("where are my applications?");
      replies.push({ ask: "where are my applications?", reply: all.reply, apps: APPS });

      const jobs = JSON.parse((await pg.sql(`select json_object_agg(id, json_build_object('at', email_confirmed_at, 'h', confirmation_mail_hash))::text from public.career_apply_jobs where user_id = '${U}'`)).trim());
      let wrong = 0, next = 0, unproven = 0;
      for (const r of replies) {
        if (nextCount(r.reply) !== 1) { next++; problems.push(`"${r.ask}": ${nextCount(r.reply)} next actions`); }
        for (const a of r.apps) {
          const line = lineFor(r.reply, a);
          // The whole list shows 8 lines and counts the rest ("…and 2 more."); one waiting on the person is never below the cut.
          if (!line && r.apps === APPS && /\n…and \d+ more\./.test(r.reply) && !["interview", "replied"].includes(a.want)) continue;
          const got = line ? said(line) : "unread";
          if (got !== a.want) { wrong++; problems.push(`"${r.ask}" ${a.key}: says ${got}, want ${a.want}: ${line ?? "(no line)"}`); }
          if (got === "confirmed") {
            const j = jobs[a.id];
            const proven = j?.at && j?.h && filed.some((e: any) => e.h === j.h && e.ref === `job:${a.id}`);
            if (!proven) { unproven++; problems.push(`"${r.ask}" ${a.key}: said confirmed without the employer's email on record`); }
          }
        }
      }
      console.log(`LOOP-12 wrong_statuses=${wrong} mismatched_mail=${mismatched} next_actions=${next} unproven_confirmed=${unproven} (applications=${APPS.length} mails=${MAILS.length} replies=${replies.length})`);
      for (const p of problems) console.log(`  ${p}`);
      console.log(`--- "where are my applications?"\n${all.reply}\n---`);
      assert(wrong === 0 && mismatched === 0 && next === 0 && unproven === 0, `the bar is 0 on every count:\n${problems.join("\n")}`);
    } finally {
      handler?.restore();
      await pg.stop();
    }
  },
});
