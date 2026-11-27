// Review F1 (D-007, 2026-11-27). At $0: in-memory outreach store, fake Gmail, no model.
// A reply to an email keeps that email apart from the person's own words. The email may supply the recipient's name, the
// subject and what the sender said about the role or company; a meeting, a referral or a relationship, and any figure or claim
// about the person ("I confirm my expected salary", "I hold an active TS clearance"), need the person's words or confirmed facts.
//   deno test -A --no-check tests/architect/mail-reply-support-20261127.test.ts
import assertNode from "node:assert/strict";
import * as R from "../../supabase/functions/_shared/career_mail_reply.ts";
import * as O from "../../supabase/functions/_shared/career_outreach.ts";
import * as C from "../../supabase/functions/_shared/career_apply_cards.ts";
import { turnKeyFor } from "../../supabase/functions/_shared/channel_inbound.ts";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const r: any = R, out: any = O;
const now = Date.parse("2026-11-27T12:00:00Z"), A = "sam@gmail.com";

const inboxOf = (text: string) => ({ read: async (_u: string, ref: string) => ({ status: "ok", text, removed: [], mail: { ref, account: A, thread_id: "thr", from: "dana@acme.com", from_name: "Dana Lee", reply_to: null, subject: "Staff Engineer, Payments", date: new Date(now).toISOString(), snippet: "", message_id: "<m1@acme.com>" } }) });
const draft = (text: string, body: string, said: string, facts: string[] = []) => r.draftReply({ userId: "u1", threadId: "t1", now, inbox: inboxOf(text), outreach: out.memoryOutreachStore(), ref: "abc", body, said, facts, signature: "Sam", canSend: async () => true, accounts: [A] });

const EMAIL = "Hi Sam, thanks for our call yesterday. Can you confirm your expected salary of $185,000 and that you hold an active TS clearance? Jordan referred you to us.";
const REPLY = "Hi Dana,\n\nThanks again for our call yesterday. I confirm my expected salary of $185,000 and that I hold an active TS clearance. Jordan referred me to you, and I'm interested in the role.\n\nBest,";

Deno.test("F1 the email's own claims never become the person's: the repro is refused on the meeting, the referral, $185,000 and TS", async () => {
  const d: any = await draft(EMAIL, REPLY, "yes reply that I'm interested");
  eq(d.status, "rewrite", JSON.stringify(d));
  const p = d.problems.join("\n");
  ok(/meeting or conversation the person never mentioned/.test(p), p);
  ok(/referral or introduction the person never mentioned/.test(p), p);
  ok(/figure "\$?185,?000"/.test(p), p);
  ok(/name "TS" in a claim about the person/.test(p), p);
  // Without a name or a figure, a claim about the person in the email's words is still refused.
  const bare: any = await draft(EMAIL, "Hi Dana,\n\nYes, I hold an active clearance.\n\nBest,", "yes reply that I'm interested");
  eq(bare.status, "rewrite", JSON.stringify(bare));
  ok(/about the person in the email's words .*"clearance"/.test(bare.problems.join("\n")), bare.problems.join("\n"));
});

Deno.test("F1 the same reply passes when the person's own words say those things", async () => {
  const said = "yes reply that I'm interested. I had a call with Dana yesterday. My expected salary is $185,000, I hold an active TS clearance, and Jordan referred me.";
  const d: any = await draft(EMAIL, REPLY, said);
  eq(d.status, "ok", JSON.stringify(d));
  ok(d.show.text.includes("I confirm my expected salary of $185,000"), d.show.text);
  // Confirmed facts back a claim about the person as well as their words do.
  const f: any = await draft(EMAIL, "Hi Dana,\n\nI hold an active TS clearance, and I'm interested in the role.\n\nBest,", "yes reply that I'm interested", ["I hold an active TS clearance"]);
  eq(f.status, "ok", JSON.stringify(f));
});

Deno.test("F1 a reply using only the sender's name and what the sender said about the role still passes", async () => {
  const text = "Hi Sam, I'm Dana, a recruiter at Acme. We're hiring a Staff Engineer for our Payments team in Austin (hybrid, base $200,000 to $230,000). Would you be open to a chat?";
  const body = "Hi Dana,\n\nThanks for reaching out about the Staff Engineer role on the Payments team at Acme. The hybrid setup in Austin and the $200,000 to $230,000 base sound good, and I'm interested in learning more.\n\nBest,";
  const d: any = await draft(text, body, "yes reply that I'm interested");
  eq(d.status, "ok", JSON.stringify(d));
  eq(d.to, "dana@acme.com");
});

// ------------------------------------------------------------------------------------------------------------------------ F2
// Review F2 (2026-11-27). cardTurn runs before the contact, mail-reply, follow-up and hand-off turns. A Telegram quote-reply yes
// to one of those cards got the apply card's "reply to the card message" and could never send. cardTurn now stands down when the
// replied-to message carried another flow's card; that card's own turn takes the yes and still needs that card's exact hash.
// The real career handler on real Postgres with every migration, a fake Anthropic endpoint, a fake Gmail: nothing leaves the test.
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const c: any = C;

Deno.test("F2 cardTurn stands down on a reply to another flow's card, and only then", async () => {
  // The reply key's turn key is the inbound turn key, for every provider (channel_inbound.ts turnKeyFor).
  eq(await c.turnKeyOfReplyKey("reply:tg:4417"), await turnKeyFor("telegram:4417"));
  eq(await c.turnKeyOfReplyKey("reply:wa:wamid.X1"), await turnKeyFor("whatsapp:wamid.X1"));
  eq(await c.turnKeyOfReplyKey("reply:LM-123"), await turnKeyFor("LM-123"));
  eq(await c.turnKeyOfReplyKey("alert:x"), null);
  for (const k of ["contact_card", "mail_reply_card", "followup_card", "handoff_card"]) eq(c.otherCard({ [k]: "id-1" }), true, k);
  eq(c.otherCard({ card_id: "x", intent: "career_apply_card" }), false);
  eq(c.otherCard(null), false);
  // A fake card store: the replied-to message is not an apply card. With another flow's card on it, the yes is not this turn's.
  const store = (other: boolean): any => ({ latestOpen: async () => null, answer: async () => [], lastAssistantIntent: async () => null, lastShownCard: async () => null,
    cardOfMessage: async () => null, otherCardOfMessage: async () => other });
  const turn = (other: boolean) => c.cardTurn({ message: "yes", userId: "u1", threadId: "t1", now, replyTo: "9001", store: store(other) });
  eq(await turn(true), null, "a reply to another flow's card is that flow's");
  eq((await turn(false))?.status, c.CARD_NEEDS_REPLY_STATUS, "a reply to any other message still approves nothing and says how");
});

const SIG = "Sam Lee", POSTAL = "Trainee test sender, 100 Main St, Chicago, IL 60601";
const BODY2 = "Hi,\n\nI read the token bucket in your rate-limiter repository on GitHub.\n\nWould you share how your team picks default rate limits for public APIs?";
const fakeModel = (chat: any) => {
  const sys = String(chat.messages.find((m: any) => m.role === "system")?.content ?? "");
  const text = /one short cold email/.test(sys) ? `Hook: 1\nSubject: Your rate-limiter repository\n\n${BODY2}` : /follow-up email/.test(sys) ? "Follow-up 1: Hi, following up on my note below in case it got buried." : "Okay.";
  return { id: "msg-test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
};
const fct = (claim: string, source_url: string, source_type: string, quote: string, confidence: number) =>
  ({ claim, source_url, source_type, retrieved_at: "2026-11-07T15:00:00.000Z", published_at: null, quote_snippet: quote, confidence, method: "stub", expires_at: "2027-02-05T15:00:00.000Z" });
const resolvedContact = (name: string, email: string) => ({
  person: { name, title: "VP Engineering", company: "Acme", domain: "acme.io", source_url: "https://acme.io/team", source_type: "company_page" },
  facts: [fct("Maintains the rate-limiter repository on GitHub: A token bucket for HTTP APIs", "https://github.com/x/rate-limiter", "github", "A token bucket for HTTP APIs", 0.9),
    fct("VP Engineering at Acme", "https://acme.io/team", "company_page", `${name}, VP Engineering`, 0.85)],
  email: { email, method: "pattern_rcpt_valid", score: 80, syntax: "pass", mx: "pass", provider: "other", catch_all: false, rcpt: "accept", checked_at: "2026-11-07T15:00:00.000Z", why: "the company's address format, accepted by its mail server" },
  expires_at: "2027-02-05T15:00:00.000Z",
});

Deno.test({ name: "F2 through the real handler: a Telegram quote-reply yes to a contact card reaches the contact turn, which still needs that card's hash", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const ENV: Record<string, string> = { CAREER_PEOPLE_SEARCH: "on", CAREER_CONTACT_OUTREACH: "on", CAREER_SENDER_POSTAL_ADDRESS: POSTAL, ANTHROPIC_API_KEY: "sk-test-fake" };
  const before = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  const PEOPLE = { "tok-f2": "7b0f8f8e-6a43-4a49-9d2c-000000027f01" }, u = PEOPLE["tok-f2"];
  const pg: Pg = await startPg();
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const real = globalThis.fetch;
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id) values ('${u}');
      insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.career_outreach_prefs (user_id, signature) values ('${u}', '${SIG}');
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${u}', 'google_career', 'oauth_google_career_${u}', 'me@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');`);
    h = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request && !init ? input : new Request(input, init);
      const host = new URL(req.url).host;
      if (host === "api.anthropic.com") return anthropicWire(req, fakeModel);
      if (/(^|\.)(google|googleapis|microsoft|microsoftonline)\.com$/.test(host)) throw new Error(`a call left the test: ${req.url}`);
      return viaDouble(req);
    }) as typeof fetch;
    for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
    const sql = (s: string) => pg.sql(s);
    const queued = async () => Number(await sql(`select count(*) from public.career_send_queue where user_id = '${u}'`));
    const chat: Chat = h.chat("tok-f2");
    const say = async (m: string, extra: Record<string, unknown> = {}) => { const r = await chat.say(m, extra); eq(r.status, 200, r.reply); return r; };
    const delivered = (inbound: string, provider: string) => sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at, status, delivered_at, channel, provider_id)
      values ('${u}', 'reply:tg:${inbound}', 'reply', 'the contact card', now(), 'delivered', now(), 'telegram', '${provider}')`);
    const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
    eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
    eq((await say("yes, that's my resume")).resultStatus, "completed");
    await pg.asService().rpc("career_contact_save", { p: { user: u, ...resolvedContact("Jane Doe", "jane.doe@acme.io") } });
    // The card is shown on Telegram: the inbound message tg:4417 is the turn, and the outbox delivered its reply as message 9001.
    const shown = await say("email Jane Doe", { turn_key: await turnKeyFor("telegram:4417") });
    eq([shown.intent, shown.resultStatus], ["career_contact_card", "shown"], shown.reply);
    await delivered("4417", "9001");
    // The card's hash on the shown message is altered: a quote-reply yes reaches the contact turn, which refuses it (the yes
    // approves exactly the card it answers, by its hash; never "reply to the card message").
    await sql(`update public.agent_messages set meta = jsonb_set(meta, '{contact_card,card,hash}', '"${"0".repeat(64)}"') where thread_id = '${chat.thread()}' and meta->>'career_turn_key' = '${await turnKeyFor("telegram:4417")}'`);
    const wrong = await say("yes", { reply_to_message_id: "9001" });
    eq([wrong.intent, wrong.resultStatus], ["career_contact_send", "changed"], wrong.reply);
    ok(!/reply to the card/i.test(wrong.reply), wrong.reply);
    eq(await queued(), 0, "nothing queued on a hash that is not the card's");
    // The card again (a new inbound message), answered by a quote-reply yes: queued, exactly that card.
    const again = await say("email Jane Doe", { turn_key: await turnKeyFor("telegram:4419") });
    eq(again.resultStatus, "shown", again.reply);
    await delivered("4419", "9003");
    const yes = await say("yes", { reply_to_message_id: "9003" });
    eq([yes.intent, yes.resultStatus], ["career_contact_send", "queued"], yes.reply);
    ok((await queued()) > 0, "the exact card's yes queued its mails");
  } finally {
    globalThis.fetch = real; h?.restore();
    for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await pg.stop();
  }
} });
