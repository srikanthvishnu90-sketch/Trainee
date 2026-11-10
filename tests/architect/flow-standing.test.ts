// WO-107 (F3): the one read model through the REAL handler (handleChat) on real Postgres. The four records are seeded
// as the product writes them: career_apply_jobs rows (what Trainee sent), career_mail_events rows (what the mail run read
// from the employer's mail), the tracker from the person's own text in chat ("I applied to Vandelay Industries ...", the
// router's tracker log), and a career_mail_drafts row (a follow-up the mail run drafted). Then the asks, as a person types
// them, and what each record adds. A record revoked from the service role is named, never guessed.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-s": "7b0f8f8e-6a43-4a49-9d2c-0000000000d4", "tok-o": "7b0f8f8e-6a43-4a49-9d2c-0000000000e5" };
const HASH = (n: number) => n.toString(16).padStart(64, "0");

Deno.test({ name: "WO-107: status, inbox and due follow-ups from one read model at the real handler", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const me = PEOPLE["tok-s"];
    const row = (company: string, state: string, daysAgo: number, conf: string | null, reason: string | null) => {
      const payload = JSON.stringify({ version: "1", user_id: me, job_id: `gh:${company}`, company, url: `https://${company.toLowerCase()}.example.test/apply`, fields: [], title: "Data Analyst" });
      const h = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
      return `('${me}', 'gh:${company}', '${company}', 'https://${company.toLowerCase()}.example.test/apply', '${payload}'::jsonb, '${h}', '${h}', '${state}', ${reason ? `'${reason}'` : "null"}, ${conf ? `'${conf}'` : "null"}, now() - interval '${daysAgo} days', now() - interval '${daysAgo} days')`;
    };
    await pg.sql(`set session_replication_role = replica;
      insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, reason, confirmation_id, created_at, updated_at) values
        ${row("Acme", "confirmed", 16, "ACME-1", null)}, ${row("Globex", "submitted_unconfirmed", 9, "CONF-4242", null)}, ${row("Initech", "unknown_outcome", 20, null, null)},
        ${row("Umbrella", "queued", 1, null, null)}, ${row("Hooli", "not_submitted", 2, null, "the employer page changed after you approved it")};
      set session_replication_role = origin;
      insert into public.career_mail_events (user_id, application_ref, kind, company, role, stage, flagged, evidence, message_hash, mail_at)
        select '${me}', 'job:' || id, 'interview', 'Globex', 'Data Analyst', 'Interview rounds', false, 'interview email', '${HASH(1)}', now() - interval '5 days' from public.career_apply_jobs where user_id = '${me}' and company = 'Globex';
      insert into public.career_mail_events (user_id, application_ref, kind, company, role, stage, flagged, evidence, message_hash, mail_at)
        values ('${me}', 'mail:stark', 'recruiter_reply', 'Stark Industries', null, null, false, 'recruiter reply email', '${HASH(2)}', now() - interval '1 day');
      insert into public.career_mail_drafts (user_id, draft_key, application_ref, kind, company, role, text, basis, state)
        select '${me}', 'followup:job:' || id, 'job:' || id, 'followup', 'Initech', null, 'Hello, I applied for a role at Initech and wanted to follow up. I am still very interested.', 'applied 20 days ago; no reply in 15 days', 'drafted' from public.career_apply_jobs where user_id = '${me}' and company = 'Initech';
      insert into public.career_mail_cursors (user_id, read_through) values ('${me}', now() - interval '1 hour');`);
    handler = await careerHandler(pg, PEOPLE);
    const chat: Chat = handler.chat("tok-s");
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };

    await t.step("the tracker from their own words, then status: the queue's lines, the tracker's employer, the employer's mail, each named", async () => {
      // The router's tracker log keeps the row in its own words (role and stage as it records them); the model repeats them.
      const logged = await say(chat, "I applied to Vandelay Industries for the Data Analyst role");
      assert(/Added to your tracker: Vandelay Industries/.test(logged.reply), logged.reply);
      const all = await say(chat, "where are my applications?");
      eq(all.intent, "career_apply_status", all.reply);
      for (const w of [/Acme[^:\n]*: submitted; their page showed ACME-1; Acme has not confirmed it by email yet\./, /Globex invited you to interview/, /can't tell whether it reached Initech/, /Umbrella[^:\n]*: approved, not sent yet/, /Hooli[^:\n]*: not sent/]) assert(w.test(all.reply), `${w}: ${all.reply}`);
      assert(/Also on your tracker \(what you told Trainee\): Vandelay Industries \([^)]*Data Analyst[^)]*\): you told Trainee you applied on \w+ \d+; stage \w+/.test(all.reply), all.reply);
      assert(/Employer email on record \(last 30 days\): Stark Industries: recruiter reply on/.test(all.reply) && /Globex \(Data Analyst\): interview invitation on/.test(all.reply), all.reply);
      const one = await say(chat, "did my application to Globex go through?");
      // Architect amendment, D-024 status truth (coordinator ruling 2026-11-10): the line says the employer's latest answer.
      assert(/Globex invited you to interview/.test(one.reply) && /Globex's email: interview invitation on .* \(stage: Interview rounds\)/.test(one.reply) && !/Stark|Vandelay|Acme/.test(one.reply), one.reply);
      const stand = await say(chat, "where do I stand with Vandelay Industries?");
      eq(stand.intent, "career_apply_status", stand.reply);
      assert(/no application to Vandelay Industries on record/.test(stand.reply) && /You told Trainee: applied on \w+ \d+; stage \w+/.test(stand.reply) && /No email from Vandelay Industries in the mail Trainee has read/.test(stand.reply), stand.reply);
    });

    await t.step("inbox: who emailed, newest first; one employer; one with nothing", async () => {
      const who = await say(chat, "who emailed me?");
      eq(who.intent, "career_inbox", who.reply);
      const lines = who.reply.split("\n").filter((l) => l.startsWith("- "));
      eq(lines.length, 2, who.reply);
      assert(/^- Stark Industries: recruiter reply on/.test(lines[0]) && /^- Globex \(Data Analyst\): interview invitation on .* \(stage: Interview rounds\)/.test(lines[1]), who.reply);
      const news = await say(chat, "any news from Globex?");
      assert(/Globex \(Data Analyst\): interview invitation on/.test(news.reply) && !/Stark/.test(news.reply), news.reply);
      const none = await say(chat, "did Hooli get back to me?");
      assert(/No email from Hooli in the mail Trainee has read \(read through /.test(none.reply), none.reply);
    });

    await t.step("follow-ups: the drafted one from the table, the due one from the quiet-days rule; nothing sent", async () => {
      const due = await say(chat, "what follow-ups are due?");
      eq(due.intent, "career_followups_due", due.reply);
      assert(/Initech: follow-up drafted .* \(applied 20 days ago; no reply in 15 days\); not sent/.test(due.reply), due.reply);
      assert(/Acme \(Data Analyst\): follow-up due \(applied .*; no reply in 16 days\); not drafted yet/.test(due.reply), due.reply);
      assert(!/Globex|Umbrella|Hooli/.test(due.reply), `a replied, unsent or failed application owes none: ${due.reply}`);
      assert(/Hello, I applied for a role at Initech/.test(due.reply) && /Nothing is sent by Trainee/.test(due.reply), due.reply);
      eq(await pg.sql(`select count(*) from public.career_mail_drafts where user_id = '${me}'`), "1", "the turn drafts nothing");
      eq(await pg.sql(`select count(*) from public.career_outbox where user_id = '${me}'`), "0", "and sends nothing");
    });

    await t.step("another person sees none of it; a record the service role cannot read is named, not guessed", async () => {
      const other = handler!.chat("tok-o");
      const o = await say(other, "who emailed me?");
      assert(/No employer email about your applications is on record/.test(o.reply) && /has not read your mail yet/.test(o.reply) && !/Globex|Stark/.test(o.reply), o.reply);
      const os = await say(other, "where are my applications?");
      assert(/No applications are on record/.test(os.reply) && !/Acme|Vandelay/.test(os.reply), os.reply);
      await pg.sql(`revoke select on public.career_mail_events from service_role`);
      try {
        const st = await say(chat, "where are my applications?");
        assert(/Acme[^:\n]*: submitted; their page showed ACME-1/.test(st.reply) && /Your mail events could not be read just now/ /* architect ruling 13-Obs (2026-11-09): a page reference alone is not "Acme confirmed it" */.test(st.reply) && !/interview invitation|recruiter reply/.test(st.reply), st.reply);
        const who = await say(chat, "who emailed me?");
        assert(/couldn't read your mail events just now/.test(who.reply) && !/Globex|Stark|No employer email/.test(who.reply), who.reply);
        const due = await say(chat, "what follow-ups are due?");
        assert(/couldn't read your mail events just now/.test(due.reply) && !/Acme.*due/.test(due.reply), due.reply);
      } finally {
        await pg.sql(`grant select on public.career_mail_events to service_role`);
      }
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
