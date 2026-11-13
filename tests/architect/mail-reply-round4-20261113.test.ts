// Independent review of PR #820 at e508e5933, round 4, 2026-11-13. At $0: in-memory outreach store, fake Gmail, no model.
//   1  an interview invite with a passcode is ordinary mail: only the passcode is redacted; ID, link and time stay.
//   2  the output guard acts only on what was actually redacted (code-shaped tokens, secret links), never on years, zips,
//      street numbers or ordinary links of a withheld security alert.
//   3  a code cue reaches only its own sentence; zip, dress, area, postal and territory codes are not cues.
//   4  new cues: signing in, inlogcode, codice, pair with, an N-digit number, "confirm with", "pass:", spaced letters, seed and
//      wallet phrases, lists of backup codes.
//   5  a second reply to one email (another card, another thread) never goes without a warning first.
//   deno test -A --no-check tests/architect/mail-reply-round4-20261113.test.ts
import assertNode from "node:assert/strict";
import * as R from "../../supabase/functions/_shared/career_mail_reply.ts";
import * as O from "../../supabase/functions/_shared/career_outreach.ts";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const r: any = R, out: any = O, s: any = S;
const now = Date.parse("2026-11-13T12:00:00Z"), MIN = 60_000, A = "me@gmail.com";
const BODY = "Hi Dana,\n\nTuesday at 3pm works for me.\n\nThanks,";

// ---------------------------------------------------------------------------------------------- 1
Deno.test("1 an interview invite with a passcode is not withheld; only the passcode is redacted", () => {
  const invites = [
    { from: "sarah@acme.example", subject: "Next round", text: "Link: https://acme.zoom.us/j/99887766554\nPasscode: 7781",
      want: "Link: https://acme.zoom.us/j/99887766554\nPasscode: [removed]" },
    { from: "sarah@acme.example", subject: "Interview: Acme Senior Engineer", text: "Sarah is inviting you to a scheduled Zoom meeting.\nTime: Nov 20, 2026 10:00 AM Pacific Time\nhttps://us02web.zoom.us/j/81234567890?pwd=abcXYZ123\nMeeting ID: 812 3456 7890\nPasscode: 551203\n+16699006833,,81234567890#,,,,*551203# US",
      want: "Sarah is inviting you to a scheduled Zoom meeting.\nTime: Nov 20, 2026 10:00 AM Pacific Time\nhttps://us02web.zoom.us/j/81234567890\nMeeting ID: 812 3456 7890\nPasscode: [removed]\n+16699006833,,81234567890#,,,,*[removed]# US" },
    { from: "sarah@acme.example", subject: "Assessment", text: "Your coding test is ready. Click below to start; it expires in 72 hours.\nhttps://www.hackerrank.com/test/abc123/login\nAccess code: 9921",
      want: "Your coding test is ready. Click below to start; it expires in 72 hours.\nhttps://www.hackerrank.com/test/abc123/login\nAccess code: [removed]" },
  ];
  for (const m of invites) {
    eq(s.securityMail(m), false, m.subject);
    eq(s.redactSecrets(m.text), m.want, m.subject);
  }
  // A real code mail that mentions a meeting is still withheld.
  eq(s.securityMail({ from: "noreply@zoom.us", subject: "Your Zoom verification code", text: "Your verification code is 482913. Do not share it." }), true);
});

// ---------------------------------------------------------------------------------------------- 2
const ALERT = "Security alert\nNew sign-in on Pixel 8, Nov 13 2026.\n© 2026 Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043\nhttps://myaccount.google.com/notifications";
Deno.test("2 the guard holds only what was redacted: a security alert's year, street number, zip and help link stay sayable", async () => {
  eq(s.securityMail({ from: "no-reply@accounts.google.com", subject: "Security alert", text: ALERT }), true);
  const w = s.withheldTokens(ALERT);
  eq(w, [], "nothing in that alert is a secret");
  const chat = "Sarah offered $145,000 base. Your interview is Nov 20, 2026 at 1600 Amphitheatre Parkway, Mountain View, CA 94043. See https://myaccount.google.com/notifications.";
  eq(s.stripRemoved(chat, w), chat);
  eq(s.mentionsRemoved("Hi Dana, Tuesday works. I can start in January 2026.\n\nThanks,", w), []);
  // The card that says so is not refused for it.
  const store = out.memoryOutreachStore();
  const inbox = { read: async (_u: string, ref: string) => ({ status: "ok", text: "Hi Sam, when could you start? Dana", removed: [], mail: { ref, account: A, thread_id: "thr", from: "dana@acme.com", from_name: "Dana Lee", reply_to: null, subject: "Start date", date: new Date(now).toISOString(), snippet: "", message_id: "<m1@acme.com>" } }) };
  const c: any = await r.draftReply({ userId: "u1", threadId: "t1", now, inbox, outreach: store, ref: "abc", body: "Hi Dana,\n\nI can start in January 2026.\n\nThanks,", said: "tell Dana I can start in January 2026", facts: [], signature: "Sam", canSend: async () => true, accounts: [A], withheld: w });
  eq(c.status, "ok", JSON.stringify(c));
  // An actual code in a withheld mail is still never said or sent.
  const code = s.withheldTokens("Your verification code is 482913. Do not share it.");
  eq(code, ["482913"]);
  eq(s.stripRemoved("The code was 482 913.", code), "The code was [removed].");
});

// ---------------------------------------------------------------------------------------------- 3
Deno.test("3 a cue reaches only its own sentence; zip, dress, area, postal and territory codes are not cues", () => {
  const cases: [string, string][] = [
    ["Our office is at 1007 Mountain Drive, zip code 60601. The dress code is business casual. Parking code 4471 opens the gate.", "Our office is at 1007 Mountain Drive, zip code 60601. The dress code is business casual. Parking code [removed] opens the gate."],
    ["Account manager role, quota 1.2M, territory code EMEA-7.", "Account manager role, quota 1.2M, territory code EMEA-7."],
    ["Call 415-555-0134 (area code 415). Postal code 560001 for the courier.", "Call 415-555-0134 (area code 415). Postal code 560001 for the courier."],
    ["Please review the code of conduct by 2027-01-05.", "Please review the code of conduct by 2027-01-05."],
    ["Passport no. X1234567 on file.", "Passport no. [removed] on file."],
  ];
  for (const [text, want] of cases) eq(s.redactSecrets(text), want, text);
});

// ---------------------------------------------------------------------------------------------- 4
Deno.test("4 new cues: signing in, inlogcode, codice, pair with, an N-digit number, confirm with, pass:, spaced letters, seed and code lists", () => {
  const cases: [string, string[], string[]][] = [
    ["Use 5821 0937 to finish signing in.", ["5821 0937"], ["Use", "to finish signing in."]],
    ["Il tuo codice è 448812", ["448812"], ["Il tuo codice"]],
    ["Je inlogcode is 339021", ["339021"], ["Je inlogcode is"]],
    ["Pair with: 7HGT-2KLQ-9WXP", ["7HGT-2KLQ-9WXP"], ["Pair with"]],
    ["Your 6 digit number for Acme: 302 918", ["302 918"], ["for Acme"]],
    ["Confirm with 3 0 2 - 9 1 8 now.", ["3 0 2 - 9 1 8"], ["now."]],
    ["VPN pass: purple-monkey-dishwasher-9", ["purple-monkey-dishwasher-9"], ["VPN pass"]],
    ["C O D E : 7 7 3 1 0 2", ["7 7 3 1 0 2"], []],
    ["wallet words\nlegal winner thank year wave sausage worth useful legal winner thank yellow", ["legal winner thank year wave sausage"], ["wallet words"]],
    ["Seed: zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", ["zoo zoo zoo zoo zoo zoo"], ["Seed:"]],
    ["spare ones\n83920-19283\n29381-02938\n93812-38291", ["83920-19283", "29381-02938"], ["spare ones"]],
    ["Save these: abcd-efgh ijkl-mnop qrst-uvwx", ["abcd-efgh", "ijkl-mnop"], ["Save these"]],
  ];
  for (const [text, gone, kept] of cases) {
    const red = s.redactSecrets(text);
    for (const g of gone) ok(!red.includes(g), `removed "${g}": ${red}`);
    for (const k of kept) ok(red.includes(k), `kept "${k}": ${red}`);
  }
  // Ordinary mail with lists stays: an address block, a schedule.
  for (const text of ["Room 2104\nSuite 400\nFloor 14", "Round 1: 10:00\nRound 2: 11:30", "Our cohort: Class of 2027\nStart 2027-06-15"]) eq(s.redactSecrets(text), text);
});

// ---------------------------------------------------------------------------------------------- 5
// The review's nine double-send scenarios (S1 to S9), against a fake Gmail where every send that is not refused lands and shows
// in Sent after `lag`. A second delivery counts as a double send unless the yes that caused it was to a card or a warning that
// said another reply to this email had gone or may have gone.
function gmail(o: { behave: (n: number) => "ok" | "timeout" | "503"; lag: number; sentReadable?: () => boolean }) {
  const delivered: { mid: string; at: number }[] = [];
  let n = 0, clock = now;
  return {
    delivered, setClock: (t: number) => { clock = t; },
    send: async (_u: string, _m: any, t: any) => { const b = o.behave(++n); delivered.push({ mid: t?.messageId, at: clock }); return b === "ok" ? { status: "sent", id: `g${n}`, thread_id: "thr" } : { status: "ERROR", detail: b === "timeout" ? "send: no answer from Gmail in 30 s" : "send: HTTP 503" }; },
    findSent: async (_u: string, q: any) => {
      if (o.sentReadable && !o.sentReadable()) return { status: "unknown", detail: "search Sent: HTTP 500" };
      const vis = delivered.filter((d) => d.at + o.lag <= clock);
      if (vis.find((d) => d.mid === q.messageId)) return { status: "found", by: "id", id: "gx", thread_id: "thr" };
      return vis.length ? { status: "similar", id: "gy" } : { status: "absent" };
    },
  };
}
async function scenario(g: ReturnType<typeof gmail>, steps: (c: any) => Promise<void>) {
  const store = out.memoryOutreachStore(), warned: boolean[] = [];
  const inbox = { search: async () => ({ status: "ok", mails: [] }), read: async (_u: string, ref: string) => ({ status: "ok", text: "Hi Sam, can you do Tuesday at 3pm for a chat? Dana", removed: [], mail: { ref, account: A, thread_id: "thr", from: "dana@acme.com", from_name: "Dana Lee", reply_to: null, subject: "Chat", date: new Date(now).toISOString(), snippet: "", message_id: "<m1@acme.com>" } }) };
  const c = {
    store,
    card: async (at: number, thread = "t1") => { g.setClock(at); return await r.draftReply({ userId: "u1", threadId: thread, now: at, inbox, outreach: store, ref: "abc", body: BODY, said: "reply to Dana and say Tuesday at 3pm works", facts: [], signature: "Sam", canSend: async () => true, accounts: [A], findSent: g.findSent }); },
    yes: async (meta: any, at: number) => {
      g.setClock(at);
      const before = g.delivered.length, told = !!(meta?.mail_reply?.acknowledged?.length || meta?.mail_reply?.prior_unconfirmed);
      const res = await r.replyAnswer({ userId: "u1", now: at, answer: "yes", meta, deps: { outreach: store, sendOn: true, canSend: async () => true, send: g.send, accounts: async () => [A], findSent: g.findSent } });
      if (g.delivered.length > before) warned.push(told);
      return res;
    },
  };
  await steps(c);
  // The first delivery needs no warning; every later one does.
  return { delivered: g.delivered.length, unwarned: warned.slice(1).filter((w) => !w).length };
}
Deno.test("5 a second reply to one email never goes without a warning first: the review's nine scenarios", async () => {
  const res: Record<string, { delivered: number; unwarned: number }> = {};
  res.S1 = await scenario(gmail({ behave: (n) => (n === 1 ? "timeout" : "ok"), lag: 20 * MIN }), async (c) => { const k = await c.card(now); const a = await c.yes(k.show.meta, now + MIN); await c.yes(a.meta ?? k.show.meta, now + 4 * MIN); await c.yes(a.meta ?? k.show.meta, now + 17 * MIN); });
  res.S2 = await scenario(gmail({ behave: () => "503", lag: 0 }), async (c) => { const k = await c.card(now); await c.yes(k.show.meta, now + MIN); await c.yes(k.show.meta, now + 3 * MIN); });
  res.S3 = await scenario(gmail({ behave: (n) => (n === 1 ? "timeout" : "ok"), lag: 3 * MIN }), async (c) => { const k = await c.card(now); await c.yes(k.show.meta, now + MIN); await c.yes(k.show.meta, now + 3.5 * MIN); await c.yes(k.show.meta, now + 5 * MIN); });
  res.S4 = await scenario(gmail({ behave: (n) => (n === 1 ? "timeout" : "ok"), lag: 30 * MIN }), async (c) => { const k = await c.card(now); await c.yes(k.show.meta, now + MIN); const k2 = await c.card(now + 17 * MIN); if (k2.show) await c.yes(k2.show.meta, now + 18 * MIN); });
  res.S5 = await scenario(gmail({ behave: (n) => (n === 1 ? "timeout" : "ok"), lag: 0, sentReadable: () => false }), async (c) => { const k = await c.card(now); await c.yes(k.show.meta, now + MIN); await c.yes(k.show.meta, now + 5 * MIN); const k2 = await c.card(now + 17 * MIN); if (k2.show) await c.yes(k2.show.meta, now + 18 * MIN); });
  res.S6 = await scenario(gmail({ behave: () => "ok", lag: 0 }), async (c) => { const k = await c.card(now); await Promise.all([c.yes(k.show.meta, now + MIN), c.yes(k.show.meta, now + MIN)]); await c.yes(k.show.meta, now + 2 * MIN); });
  res.S7 = await scenario(gmail({ behave: () => "ok", lag: 0 }), async (c) => {
    const k1 = await c.card(now, "t1"), k2 = await c.card(now + 6000, "t2");
    await c.yes(k1.show.meta, now + MIN);
    const second = await c.yes(k2.show.meta, now + 1.1 * MIN);
    eq(second.status, "another_reply", "the second card waits, and says why");
    ok(/another reply to this same email, from another card, already went/.test(second.reply) && /Say yes again only if you want this reply sent as well/.test(second.reply), second.reply);
    const knowing = await c.yes(second.meta, now + 1.2 * MIN);
    eq(knowing.status, "sent", "a yes after the warning sends it, once");
  });
  res.S7b = await scenario(gmail({ behave: () => "ok", lag: 0 }), async (c) => {
    const k1 = await c.card(now, "t1"), k2 = await c.card(now, "t2");
    const both = await Promise.all([c.yes(k1.show.meta, now + MIN), c.yes(k2.show.meta, now + MIN)]);
    // Whichever way the two claims interleave: at most one goes, and a card that did not send says why.
    ok(both.every((x: any) => x.status === "sent" || x.status === "another_reply"), JSON.stringify(both.map((x: any) => x.status)));
  });
  res.S8 = await scenario(gmail({ behave: () => "ok", lag: 30 * MIN }), async (c) => {
    const k = await c.card(now), d = c.store.dump().drafts[0];
    await c.store.update("u1", { ...d, status: "sending", approved_hash: d.hash, approved_at: new Date(now).toISOString(), sent_at: new Date(now).toISOString() });
    await c.yes(k.show.meta, now + MIN); await c.yes(k.show.meta, now + 2 * MIN); const k2 = await c.card(now + 20 * MIN); if (k2.show) await c.yes(k2.show.meta, now + 21 * MIN);
  });
  res.S9 = await scenario(gmail({ behave: () => "timeout", lag: 0 }), async (c) => {
    const k = await c.card(now), real = c.store.claim.bind(c.store);
    let first = true;
    c.store.claim = async (...a: any[]) => { const x = await real(...a); if (first) { first = false; throw new Error("network"); } return x; };
    await c.yes(k.show.meta, now + MIN); await c.yes(k.show.meta, now + 3 * MIN); await c.yes(k.show.meta, now + 5 * MIN);
  });
  eq(Object.entries(res).filter(([, v]) => v.unwarned > 0).map(([k]) => k), [], `no second reply without a warning: ${JSON.stringify(res)}`);
  ok(res.S7b.delivered <= 1, "two cards said yes to at once: at most one reply");
  eq([res.S1.delivered, res.S2.delivered, res.S3.delivered, res.S6.delivered], [1, 1, 1, 1]);
});

Deno.test("5 a new card for an email already answered says so first", async () => {
  const store = out.memoryOutreachStore(), g = gmail({ behave: () => "ok", lag: 0 });
  const inbox = { read: async (_u: string, ref: string) => ({ status: "ok", text: "Hi Sam, can you do Tuesday at 3pm? Dana", removed: [], mail: { ref, account: A, thread_id: "thr", from: "dana@acme.com", from_name: "Dana Lee", reply_to: null, subject: "Chat", date: new Date(now).toISOString(), snippet: "", message_id: "<m1@acme.com>" } }) };
  const card = (at: number) => r.draftReply({ userId: "u1", threadId: "t1", now: at, inbox, outreach: store, ref: "abc", body: BODY, said: "reply to Dana", facts: [], signature: "Sam", canSend: async () => true, accounts: [A], findSent: g.findSent });
  const k1: any = await card(now);
  eq((await r.replyAnswer({ userId: "u1", now: now + MIN, answer: "yes", meta: k1.show.meta, deps: { outreach: store, sendOn: true, canSend: async () => true, send: g.send, accounts: async () => [A], findSent: g.findSent } })).status, "sent");
  const k2: any = await card(now + 2 * MIN);
  ok(/^Before you answer: you already sent a reply to this email \(2026-11-13 12:01 UTC\)\. If you say yes here, a second reply goes\./.test(k2.show.text), k2.show.text);
  eq(k2.show.meta.mail_reply.acknowledged, [k1.show.meta.mail_reply_card]);
});
