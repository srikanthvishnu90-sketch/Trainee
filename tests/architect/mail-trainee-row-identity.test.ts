// Item 14: an employer's reply (interview, rejection, offer) moves the application it is about. The applications Trainee
// sends carry no title (the cloud card's payload has a closed key set without one, 20261024130000), so the mail run
// must take the posting's own title, as the confirmation run already does (career_apply_confirm.ts). Without a role:
// a hand-tracked application at the same employer is dropped as a "duplicate" of Trainee's, and a rejection for that
// other job marks Trainee's application Rejected. And a sent application is dated when it was sent (claimed_at), not when
// its row was last touched. Driven through the real supabaseMailStore over a fake PostgREST client that returns only
// the columns the store selects. Synthetic employer and person only; no network, no database, no model.
import { classifyMail, followUps, type MailIn, planUpdates } from "../../supabase/functions/_shared/career_mail.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
const ok = (v: unknown, why: string) => { if (!v) throw new Error(why); };
const DAY = 86400000, NOW = Date.parse("2026-11-20T15:00:00Z"), iso = (t: number) => new Date(t).toISOString();
const U = "00000000-0000-4000-8000-0000000000a1";
const AUTH = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const SENT = NOW - 20 * DAY, TOUCHED = NOW - 2 * DAY;

// The database as the run sees it: one application Trainee sent (cloud: no title in its payload; touched again two days
// ago when its confirmation email was recorded), the posting it was for, and one application the person made by hand at
// the same employer for a different job.
const TABLES: Record<string, Record<string, unknown>[]> = {
  career_apply_jobs: [{ id: "11111111-1111-4111-8111-111111111111", user_id: U, job_id: "TEST-POST-SWE", company: "Synthetic Robotics",
    url: "https://jobs.lever.co/syntheticrobotics/0a1b2c3d", state: "submitted_unconfirmed", created_at: iso(SENT - 3600000), claimed_at: iso(SENT),
    updated_at: iso(TOUCHED), payload: { version: 1, job_id: "TEST-POST-SWE", company: "Synthetic Robotics", url: "https://jobs.lever.co/syntheticrobotics/0a1b2c3d", fields: [] } }],
  career_postings: [{ job_id: "TEST-POST-SWE", title: "Software Engineer Intern" }, { job_id: "TEST-POST-OTHER", title: "Account Executive" }],
  agent_flow_state: [{ user_id: U, state: { career: { stores: { trackStore: { rows: [{ app_id: "t-data", company: "Synthetic Robotics", role: "Data Analyst",
    stage: "Submitted", applied_at: iso(NOW - 30 * DAY), events: [] }] } } } } }],
};
// A PostgREST stand-in: filters by eq/in, and returns only the selected columns ("alias:col->>key", "alias:a->b->c").
function fakeAdmin() {
  const reads: string[] = [];
  const from = (table: string) => {
    let cols = "*"; const filters: ((r: any) => boolean)[] = [];
    const q: any = {
      select(c: string) { cols = c; return q; },
      eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
      in(k: string, vs: unknown[]) { filters.push((r) => vs.includes(r[k])); return q; },
      order() { return q; }, limit() { return q; },
      then(res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) {
        reads.push(`${table}:${cols}`);
        const rows = (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => {
          if (cols === "*") return { ...r };
          const out: Record<string, unknown> = {};
          for (const part of cols.split(",").map((s) => s.trim())) {
            const [alias, path] = part.includes(":") ? part.split(":") : [part, part];
            const steps = path.split(/->>|->/);
            let v: any = r;
            for (const s of steps) v = v == null ? undefined : v[s];
            out[alias] = v ?? null;
          }
          return out;
        });
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { from, reads };
}
const lever = "Synthetic Robotics <no-reply@hire.lever.co>";
const mail = (hash: string, subject: string, snippet: string, at: number): MailIn => ({ hash, from: lever, subject, snippet, date: iso(at), auth: AUTH("hire.lever.co") });
const REJECT_DATA = mail("a".repeat(64), "Your application to Synthetic Robotics",
  "Thank you for applying for the Data Analyst role at Synthetic Robotics. Unfortunately, we have decided not to move forward with your application.", NOW - 3600000);
const INTERVIEW_SWE = mail("b".repeat(64), "Interview invitation: Software Engineer Intern at Synthetic Robotics",
  "We would like to invite you to interview for the Software Engineer Intern role at Synthetic Robotics. Please pick a time.", NOW - 1800000);

Deno.test("item 14: the mails read as the employer's rejection and interview, for two different jobs (fixture control)", () => {
  const r = classifyMail(REJECT_DATA), i = classifyMail(INTERVIEW_SWE);
  ok(r.kind === "rejection" && r.role === "Data Analyst" && i.kind === "interview" && i.role === "Software Engineer Intern", JSON.stringify({ r, i }));
});

Deno.test("item 14: an application Trainee sent carries its posting's title and the time it was sent", async () => {
  const apps = await supabaseMailStore(fakeAdmin()).applications(U);
  const job = apps.find((a) => a.ref === "job:11111111-1111-4111-8111-111111111111");
  ok(job, "Trainee's application is tracked");
  ok(job!.role === "Software Engineer Intern", `its role is the posting's title, got ${JSON.stringify(job!.role)}`);
  ok(job!.applied_at === iso(SENT), `dated when it was sent (${iso(SENT)}), got ${job!.applied_at}`);
  ok(apps.some((a) => a.ref === "track:t-data"), `the hand-made application for another job at the same employer is kept: ${JSON.stringify(apps.map((a) => a.ref))}`);
});

Deno.test("item 14: a rejection for the other job moves that job, never the application Trainee sent", async () => {
  const plan = planUpdates([REJECT_DATA], await supabaseMailStore(fakeAdmin()).applications(U), NOW);
  const e = plan.events.find((x) => x.hash === REJECT_DATA.hash);
  ok(e && e.ref === "track:t-data" && e.stage === "Rejected", `the Data Analyst rejection is filed under its own application: ${JSON.stringify(e)}`);
  ok(!plan.events.some((x) => x.ref.startsWith("job:") && x.stage === "Rejected"), "Trainee's application is not marked Rejected");
});

Deno.test("item 14: the interview for the job Trainee sent moves Trainee's application", async () => {
  const plan = planUpdates([REJECT_DATA, INTERVIEW_SWE], await supabaseMailStore(fakeAdmin()).applications(U), NOW);
  const e = plan.events.find((x) => x.hash === INTERVIEW_SWE.hash);
  ok(e && e.ref === "job:11111111-1111-4111-8111-111111111111" && e.stage === "Interview rounds", `interview filed under Trainee's application: ${JSON.stringify(e)}`);
  ok(plan.ambiguous === 0 && plan.unmatched === 0, `nothing left ambiguous or unmatched: ${plan.ambiguous}/${plan.unmatched}`);
});

Deno.test("item 14: the follow-up clock runs from the day it was sent, not the day its row was last touched", async () => {
  const quiet = (await supabaseMailStore(fakeAdmin()).applications(U)).filter((a) => a.ref.startsWith("job:"));
  const d = followUps(quiet, NOW).find((x) => x.ref.startsWith("job:"));
  ok(d && /no reply in 20 days/.test(d.basis), `a follow-up is drafted 20 quiet days after sending: ${JSON.stringify(d)}`);
});

Deno.test("item 14: without any title the row stays roleless: never guessed", async () => {
  const saved = TABLES.career_postings;
  TABLES.career_postings = [];
  try {
    const apps = await supabaseMailStore(fakeAdmin()).applications(U);
    const job = apps.find((a) => a.ref.startsWith("job:"));
    ok(job && job.role === undefined, `no title anywhere: no role is invented: ${JSON.stringify(job?.role)}`);
  } finally { TABLES.career_postings = saved; }
});
