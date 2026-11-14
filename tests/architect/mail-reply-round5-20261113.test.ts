// Review of 069841439 (PR #820), round 5, 2026-11-13. At $0: in-memory outreach store, fake Gmail, no model.
//   1  a code cue's window runs on into the next short sentence when the cue's own sentence has no code ("Your code follows.
//      554102"); withholding a security mail does not stop at a full stop either; "dress code" and "zip code" stay non-cues.
//   2  a meeting number labelled "access code" is a meeting ID and stays; spaced letters collapse only when they spell a cue
//      word ("C O D E"), never ordinary letters ("A B A A").
//   3  S13: a reply whose outcome is unknown stays a possible send after a later card replaces it: every later card warns.
//   deno test -A --no-check tests/architect/mail-reply-round5-20261113.test.ts
import assertNode from "node:assert/strict";
import * as R from "../../supabase/functions/_shared/career_mail_reply.ts";
import * as O from "../../supabase/functions/_shared/career_outreach.ts";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const r: any = R, out: any = O, s: any = S;
const now = Date.parse("2026-11-13T12:00:00Z"), MIN = 60_000, A = "me@gmail.com";

// ---------------------------------------------------------------------------------------------- 1
Deno.test("1 a code in the sentence after its cue is caught, in redaction and in withholding", () => {
  const cases: [string, string, string][] = [
    ["n4", "Your code follows. 554102", "554102"],
    ["n5", "Here is your login code. It is 330918.", "330918"],
    ["n6", "We sent a one-time code. Write it down! 7 7 2 0 1 9", "7 7 2 0 1 9"],
  ];
  for (const [n, text, code] of cases) {
    ok(!s.redactSecrets(text).includes(code), `${n} redacted: ${s.redactSecrets(text)}`);
    eq(s.securityMail({ from: "noreply@app.example", subject: "Hi", text }), true, `${n} withheld`);
  }
  // Non-cues stay non-cues across sentences, and a later sentence with ordinary words keeps its numbers.
  for (const text of ["The dress code is business casual. 1455 Market Street, Suite 400.", "Our zip code is below. 94016 is the office.",
    "We loved your code sample. 3 engineers reviewed it on 11/18.", "Please read the code of conduct. The office is at 200 Park Ave, New York, NY 10166."]) {
    eq(s.redactSecrets(text), text, text);
    eq(s.securityMail({ from: "dana@acme.com", subject: "Onsite", text }), false, text);
  }
});

// ---------------------------------------------------------------------------------------------- 2
Deno.test("2 a meeting number labelled access code stays; only cue words are collapsed from spaced letters", () => {
  eq(s.redactSecrets("Webex meeting\nMeeting number (access code): 2634 812 9011\nMeeting password: Xy7!pq"), "Webex meeting\nMeeting number (access code): 2634 812 9011\nMeeting password: [removed]");
  eq(s.redactSecrets("Seats: A B A A, row 4."), "Seats: A B A A, row 4.");
  eq(s.redactSecrets("Grades: A B B A C on the five modules."), "Grades: A B B A C on the five modules.");
  ok(!s.redactSecrets("C O D E : 7 7 3 1 0 2").includes("7 7 3 1 0 2"));
  ok(!s.redactSecrets("Your P I N is 4471").includes("4471"));
});

// ---------------------------------------------------------------------------------------------- 3
Deno.test("3 S13: card 1 timed out but landed; card 2 replaced it; card 3 still warns before its yes, and nothing goes unwarned", async () => {
  const store = out.memoryOutreachStore(), delivered: string[] = [];
  let n = 0;
  const send = async (_u: string, _m: any, t: any) => { delivered.push(t.messageId); return ++n === 1 ? { status: "ERROR", detail: "send: no answer from Gmail in 30 s" } : { status: "sent", id: `g${n}`, thread_id: "thr" }; };
  const findSent = async () => ({ status: "absent" }); // Sent lags: card 1's message is not visible yet
  const inbox = { read: async (_u: string, ref: string) => ({ status: "ok", text: "Hi Sam, can you do Tuesday at 3pm? Dana", removed: [], mail: { ref, account: A, thread_id: "thr", from: "dana@acme.com", from_name: "Dana Lee", reply_to: null, subject: "Chat", date: new Date(now).toISOString(), snippet: "", message_id: "<m1@acme.com>" } }) };
  const card = (at: number) => r.draftReply({ userId: "u1", threadId: "t1", now: at, inbox, outreach: store, ref: "abc", body: "Hi Dana,\n\nTuesday at 3pm works for me.\n\nThanks,", said: "reply to Dana", facts: [], signature: "Sam", canSend: async () => true, accounts: [A], findSent });
  const yes = (meta: any, at: number) => r.replyAnswer({ userId: "u1", now: at, answer: "yes", meta, deps: { outreach: store, sendOn: true, canSend: async () => true, send, accounts: async () => [A], findSent } });
  const k1: any = await card(now);
  eq((await yes(k1.show.meta, now + MIN)).status, "unknown_outcome");
  const k2: any = await card(now + 17 * MIN);
  ok(/an earlier reply to this email .* is unconfirmed/.test(k2.show.text), k2.show.text);
  eq((await yes(k2.show.meta, now + 18 * MIN)).status, "sent", "the person said yes knowing card 1 may have gone");
  const k3: any = await card(now + 19 * MIN);
  eq(k3.status, "ok");
  ok(/you already sent a reply to this email/.test(k3.show.text) && /an earlier reply to this email .* (?:is unconfirmed|may have gone)/.test(k3.show.text), `card 3 names both earlier replies first:\n${k3.show.text}`);
  eq([...k3.show.meta.mail_reply.acknowledged].sort(), [k1.show.meta.mail_reply_card, k2.show.meta.mail_reply_card].sort());
  // A yes to a card that did not carry those warnings is stopped and told first.
  const stripped = { ...k3.show.meta, mail_reply: { ...k3.show.meta.mail_reply, acknowledged: [k2.show.meta.mail_reply_card] } };
  const quiet = await yes(stripped, now + 20 * MIN);
  eq([quiet.status, delivered.length], ["another_reply", 2], quiet.reply);
  ok(/may already have gone/.test(quiet.reply), quiet.reply);
  // The replaced card's row is not a plain failure: it still reads as unconfirmed.
  const row1 = store.dump().drafts.find((d: any) => d.id === k1.show.meta.mail_reply_card);
  ok(/^unconfirmed/.test(row1.result), row1.result);
  eq((await store.replyAttempts("u1", "dana@acme.com", "<m1@acme.com>")).map((d: any) => d.id).includes(row1.id), true, "the keyed lookup still returns it");
});
