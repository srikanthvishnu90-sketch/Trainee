// FEATURE 8 (DIAGNOSIS-2026-10-25 §2.4, §2.5): inbox awareness and follow-ups that can be sent, through the REAL handler
// (handleChat) on real Postgres. The only seams are the HTTP hops: the Supabase project (tests/flow/postgrest.ts) and
// Google, answered here by a fake Gmail API (one employer email as fixture metadata; users.messages.send recorded, never
// delivered). The person's applications are career_apply_jobs rows as the product writes them; their career Google grant
// is a user_oauth_connections row and a vault entry, as gmail-oauth writes them.
//   (a) "check my email now" runs the scheduled mail tracking once for this person (behind CAREER_MAIL_TRACKING), so the
//       read model has the employer's email without a schedule;
//   (b) a due follow-up becomes one email card through the outreach store, hash-bound; a yes sends exactly it once from
//       the person's Gmail only with CAREER_EMAIL_SEND=on and the gmail.send grant, and says exactly what is missing else;
//   (c) the classified email updates the application everywhere the read model reads it: the queue row (confirmed), the
//       mail events (status and inbox), and what is due (an employer that replied owes no follow-up).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-f": "7b0f8f8e-6a43-4a49-9d2c-0000000000f8", "tok-x": "7b0f8f8e-6a43-4a49-9d2c-0000000000f9" };
const DAY = 86_400_000;
const READ = "https://www.googleapis.com/auth/gmail.readonly", SEND = "https://www.googleapis.com/auth/gmail.send";

// The fake Gmail API: the person's token only; one interview email from Globex (metadata and snippet, as format=metadata
// returns it); every send recorded with its decoded MIME.
function fakeGoogle() {
  const calls: string[] = [], sent: string[] = [];
  const at = Date.now() - DAY;
  const msg = {
    id: "gm-globex-1", internalDate: String(at), snippet: "Hi Pat, thank you for applying to the Data Analyst role at Globex. We would like to invite you to interview with our team next week. Please share your availability.",
    payload: { headers: [
      { name: "From", value: "Globex Recruiting <recruiting@globex.com>" }, { name: "Subject", value: "Interview invitation: Data Analyst at Globex" },
      { name: "Date", value: new Date(at).toUTCString() },
      { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@globex.com header.s=s1; spf=pass smtp.mailfrom=recruiting@globex.com; dmarc=pass header.from=globex.com" },
    ] },
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.origin}${u.pathname}`);
    if (u.hostname !== "gmail.googleapis.com") return json({ error: "not faked" }, 404);
    if (req.headers.get("authorization") !== "Bearer AT-F8") return json({ error: { code: 401 } }, 401);
    if (req.method === "GET" && u.pathname === "/gmail/v1/users/me/messages") return json({ messages: [{ id: msg.id }] });
    if (req.method === "GET" && u.pathname === `/gmail/v1/users/me/messages/${msg.id}`) return json(msg);
    if (req.method === "POST" && u.pathname === "/gmail/v1/users/me/messages/send") {
      const raw = String((await req.json()).raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
      sent.push(new TextDecoder().decode(Uint8Array.from(atob(raw + "=".repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0))));
      return json({ id: `sent-${sent.length}`, threadId: `thr-${sent.length}` });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch, calls, sent, gmail: () => calls.filter((c) => c.includes("gmail.googleapis.com")).length };
}

Deno.test({ name: "FEATURE 8: check my email now, the employer's email everywhere, and a follow-up sent on one yes", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const google = fakeGoogle();
  const realFetch = globalThis.fetch;
  const flags = ["CAREER_MAIL_TRACKING", "CAREER_EMAIL_SEND"];
  const before = Object.fromEntries(flags.map((f) => [f, Deno.env.get(f)]));
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    for (const f of flags) Deno.env.delete(f);
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const me = PEOPLE["tok-f"];
    const row = (company: string, url: string, daysAgo: number) => {
      const payload = JSON.stringify({ version: "1", user_id: me, job_id: `gh:${company}`, company, url, fields: [], title: "Data Analyst" });
      const h = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
      return `('${me}', 'gh:${company}', '${company}', '${url}', '${payload}'::jsonb, '${h}', '${h}', 'submitted_unconfirmed', now() - interval '${daysAgo} days', now() - interval '${daysAgo} days')`;
    };
    await pg.sql(`set session_replication_role = replica;
      insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at, updated_at) values
        ${row("Stripe", "https://stripe.com/jobs/listing/data-analyst/1", 16)}, ${row("Globex", "https://globex.com/careers/123", 15)};
      set session_replication_role = origin;
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${me}', 'google_career', 'oauth_google_career_${me}', 'pat@example.test', '${READ} ${SEND}');
      select public.oauth_vault_store('oauth_google_career_${me}', '{"access_token":"AT-F8","refresh_token":"RT-F8","expires_at":${Date.now() + 365 * DAY}}');
      insert into public.career_outreach_prefs (user_id, signature) values ('${me}', 'Pat Lee');`);
    globalThis.fetch = google.fetch as typeof fetch; // the double passes every non-Supabase request to this
    handler = await careerHandler(pg, PEOPLE);
    const chat: Chat = handler.chat("tok-f");
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    const q = (sql: string) => pg.sql(sql);

    await t.step("switch off: 'check my email now' says nothing was read, and reads nothing", async () => {
      Deno.env.set("CAREER_MAIL_TRACKING", "off"); // D-036: a release flag (on when unset); "off" is its rollback
      const r = await say(chat, "check my email now");
      eq(r.intent, "career_inbox_check", r.reply);
      eq(r.resultStatus, "MAIL_OFF", r.reply);
      assert(/reading it is not switched on in Trainee yet, so nothing was read/.test(r.reply), r.reply);
      eq(google.gmail(), 0, "no Gmail call with the switch off");
      const due = await say(chat, "what follow-ups are due?");
      assert(/Stripe \(Data Analyst\): follow-up due/.test(due.reply) && /Globex \(Data Analyst\): follow-up due/.test(due.reply), `both are quiet before the read:\n${due.reply}`);
    });

    await t.step("(a) switch on: one mail run for this person, said in the reply; nothing texted", async () => {
      Deno.env.set("CAREER_MAIL_TRACKING", "on");
      const r = await say(chat, "Check my email now please");
      eq(r.intent, "career_inbox_check", r.reply);
      eq(r.resultStatus, "updated", r.reply);
      assert(/I read your mail through \w+ \d+: 1 new message/.test(r.reply), r.reply);
      assert(/Globex \(Data Analyst\) wants to interview you/.test(r.reply), r.reply);
      assert(/No reply from Stripe \(Data Analyst\) \(applied .*; no reply in 16 days\)\. I drafted a follow-up; it is not sent/.test(r.reply), r.reply);
      assert(/Say "send the follow-up to" and the company/.test(r.reply), r.reply);
      eq(await q(`select kind || '|' || company || '|' || stage from public.career_mail_events where user_id = '${me}'`), "interview|Globex|Interview rounds");
      eq(await q(`select count(*) from public.career_mail_cursors where user_id = '${me}'`), "1", "the cursor moved");
      eq(await q(`select company || '|' || state from public.career_mail_drafts where user_id = '${me}'`), "Stripe|drafted");
      eq(await q(`select count(*) from public.career_outbox where user_id = '${me}'`), "0", "said in chat, never queued as texts too");
      assert(google.calls.some((c) => c === "GET https://gmail.googleapis.com/gmail/v1/users/me/messages"), google.calls.join("\n"));
    });

    await t.step("(c) the classified email is in every record the read model reads", async () => {
      eq(await q(`select state || '|' || (email_confirmed_at is not null) from public.career_apply_jobs where user_id = '${me}' and company = 'Globex'`), "confirmed|true", "the queue row is confirmed by the employer's email");
      const stand = await say(chat, "where do I stand with Globex?");
      eq(stand.intent, "career_apply_status", stand.reply);
      assert(/Globex confirmed it/.test(stand.reply) && /Globex's email: interview invitation on \w+ \d+ \(stage: Interview rounds\)/.test(stand.reply), stand.reply);
      const who = await say(chat, "any news from Globex?");
      assert(/Globex \(Data Analyst\): interview invitation on/.test(who.reply), who.reply);
      const due = await say(chat, "what follow-ups are due?");
      assert(/Stripe \(Data Analyst\): follow-up drafted/.test(due.reply) && !/Globex/.test(due.reply), `Globex replied, so it owes no follow-up:\n${due.reply}`);
      assert(/Or say "send the follow-up to Stripe"/.test(due.reply), due.reply);
      const none = await say(chat, "follow up with Globex");
      eq(none.resultStatus, "none_due", none.reply);
      assert(/No follow-up is due for Globex right now/.test(none.reply), none.reply);
      const again = await say(chat, "I just connected my Gmail");
      eq(again.intent, "career_inbox_check", again.reply);
      assert(/Thanks for connecting\. I read your mail/.test(again.reply) && /Nothing in it changes any of your applications/.test(again.reply), `the same email again is no news:\n${again.reply}`);
      eq(await q(`select count(*) from public.career_mail_events where user_id = '${me}'`), "1");
    });

    await t.step("(b) the follow-up as one email card: the address is asked for, never guessed; the card is hash-bound", async () => {
      const ask = await say(chat, "send the follow-up to Stripe");
      eq(ask.resultStatus, "need_address", ask.reply);
      assert(/Trainee has no address for Stripe on record and won't guess one/.test(ask.reply) && /Hello, I applied for the Data Analyst role at Stripe/.test(ask.reply), ask.reply);
      eq(await q(`select count(*) from public.career_outreach_drafts where user_id = '${me}'`), "0", "no card without an address");
      const card = await say(chat, "jane.doe@stripe.com");
      eq(card.intent, "career_followup_card", card.reply);
      eq(card.resultStatus, "shown", card.reply);
      assert(/To: jane\.doe@stripe\.com \(the address you gave\)/.test(card.reply) && /Subject: Following up on my Data Analyst application/.test(card.reply), card.reply);
      assert(/Hello, I applied for the Data Analyst role at Stripe on .*\n\nPat Lee/.test(card.reply) && /Trainee doesn't send email for you: copy it into your own email, or open it ready to send in your mail app: mailto:jane\.doe@stripe\.com\?subject=/.test(card.reply), `sending is off, so the card says Trainee doesn't send and gives the text (family email, 2026-10-26):\n${card.reply}`);
      eq(await q(`select status || '|' || recipient_email || '|' || (hash ~ '^[a-f0-9]{64}$') from public.career_outreach_drafts where user_id = '${me}'`), "shown|jane.doe@stripe.com|true");
    });

    await t.step("yes with sending off, then without the gmail.send grant: each says exactly that, nothing goes", async () => {
      const off = await say(chat, "yes");
      eq(off.resultStatus, "SEND_OFF", off.reply);
      assert(/Not sent: Trainee doesn't send email for you, so nothing went to Stripe\. Copy the email above into your own email, or open it ready to send: mailto:/.test(off.reply), off.reply);
      Deno.env.set("CAREER_EMAIL_SEND", "on");
      await q(`update public.user_oauth_connections set scopes = '${READ}' where user_id = '${me}'`);
      const nogrant = await say(chat, "yes");
      eq(nogrant.resultStatus, "NOT_WIRED", nogrant.reply);
      assert(/Not sent: your Google connection lets Trainee read your mail, not send it, so nothing went to Stripe\. Copy the email above/.test(nogrant.reply), nogrant.reply);
      await q(`update public.user_oauth_connections set scopes = '${READ} ${SEND}' where user_id = '${me}'`);
      eq(google.sent.length, 0);
      eq(await q(`select status from public.career_outreach_drafts where user_id = '${me}'`), "shown");
    });

    await t.step("a card changed after it was shown is refused by its hash", async () => {
      await q(`update public.career_outreach_drafts set body = body || ' P.S. I can start tomorrow.' where user_id = '${me}'`);
      const r = await say(chat, "yes");
      eq(r.resultStatus, "changed", r.reply);
      eq(google.sent.length, 0, "nothing sent for a message the person never saw");
    });

    await t.step("one yes sends exactly the card once from their Gmail; it is never due again", async () => {
      const card = await say(chat, "Send the follow-up to Stripe at jane.doe@stripe.com");
      eq(card.resultStatus, "shown", card.reply);
      const r = await say(chat, "yes, send it");
      eq(r.resultStatus, "sent", r.reply);
      assert(/Sent to jane\.doe@stripe\.com from your Gmail: your follow-up to Stripe, exactly as shown/.test(r.reply), r.reply);
      eq(google.sent.length, 1);
      const mime = google.sent[0];
      assert(/^To: jane\.doe@stripe\.com\r\nSubject: Following up on my Data Analyst application\r\n/.test(mime) && !/^(?:Cc|Bcc):/mi.test(mime), mime);
      assert(/Hello, I applied for the Data Analyst role at Stripe on [^\n]*\r\n\r\nPat Lee$/.test(mime.trimEnd()) && !/P\.S\./.test(mime), mime);
      eq(await q(`select string_agg(status, ',' order by created_at) from public.career_outreach_drafts where user_id = '${me}'`), "shown,sent");
      eq(await q(`select state || '|' || (sent_at is not null) || '|' || (outreach_draft is not null) from public.career_mail_drafts where user_id = '${me}' and company = 'Stripe'`), "sent|true|true");
      const due = await say(chat, "what follow-ups are due?");
      assert(/No follow-up is due right now/.test(due.reply) && /Stripe \(Data Analyst\): follow-up sent \w+ \d+ from your Gmail, on your yes/.test(due.reply), due.reply);
      const twice = await say(chat, "yes");
      eq(google.sent.length, 1, `a second yes sends nothing: ${twice.reply}`);
      const after = await say(chat, "send the follow-up to Stripe");
      eq(after.resultStatus, "already_sent", after.reply);
    });

    await t.step("another person: no application, no grant; nothing of the first person's, no Gmail call", async () => {
      const calls = google.gmail();
      const other = handler!.chat("tok-x");
      const none = await say(other, "draft the follow-up to Stripe");
      assert(/There's no application to Stripe on record/.test(none.reply), none.reply);
      const read = await say(other, "check my inbox");
      // Task 3 (connector framework): with no mailbox of their own, Trainee asks once for one; nothing is read.
      assert(["NOT_WIRED", "asked", "not_wired"].includes(String(read.resultStatus)), read.reply);
      assert(/nothing was read|one-time link/i.test(read.reply) && !/Stripe|Acme/.test(read.reply), read.reply);
      eq(google.gmail(), calls, "no Gmail call without their own grant");
      const thanks = await say(chat, "send the thank-you to Acme");
      assert(/There's no application to Acme on record, so there's no thank-you to send/.test(thanks.reply), thanks.reply);
    });
  } finally {
    handler?.restore();
    globalThis.fetch = realFetch;
    for (const f of flags) { if (before[f] === undefined) Deno.env.delete(f); else Deno.env.set(f, before[f]!); }
    await pg.stop();
  }
} });
