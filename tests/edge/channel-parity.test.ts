// CHANNEL PARITY (owner, 2026-11-05): the same message produces the same route, the same request to the brain, the same
// actions and the same reply on Telegram, WhatsApp and iMessage; only the transport's own formatting may differ, and each
// such difference is listed here (TRANSPORT) or is an open product decision (DECISIONS), never silent. A representative
// conversation of 40 messages (onboarding, search, apply cards and approvals, file links, outreach drafts, negotiation,
// status, erase and stop) runs through each channel's REAL webhook, composed as its index.ts composes it, over fakes
// (tests/edge/channel_world.ts).
// Run: deno test -A --no-check tests/edge/channel-parity.test.ts
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { ALREADY_TELEGRAM_REPLY, CHAT_DOWN_REPLY, FILE_NOT_READ_REPLY, GREETING, LINK_CODE_NO_MATCH_REPLY, longCutNote, cutForChat, SCREEN_REPLY_YES_NO } from "../../supabase/functions/_shared/channel_inbound.ts";
import { NEEDS_REPLY_CHANNEL, NEEDS_TAP_IMESSAGE } from "../../supabase/functions/_shared/career_apply_cards.ts";
import type { Channel } from "../../supabase/functions/_shared/channel_adapters.ts";
import { ADDR, AGENT_CHANNEL, CHANNELS, channelWorld, plain, type Sent } from "./channel_world.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const ROOT = new URL("../..", import.meta.url).pathname;

const RESUME = ["Alex Testcase", "Education: State University, B.S. Computer Science, 2026", "Experience: Data intern at Acme TEST (2025)", "Skills: Python, SQL"].join("\n");
const DRAFTS = Array.from({ length: 3 }, (_, i) => `Draft ${i + 1} of 3, to Hiring Manager ${i + 1} at Acme TEST:\n${"A sentence the person approves word for word. ".repeat(60)}`);
const LONG = `here is everything about me: ${"I like building data tools for small teams. ".repeat(110)}`;

// The scripted agent-chat: what the brain answers to each message (the same whatever channel asked: that is the property
// under test on the webhook side; agent-chat's own channel reads are pinned below).
function agent(m: string): Record<string, unknown> {
  if (m.startsWith("draft outreach")) return { reply: DRAFTS.join("\n\n"), parts: DRAFTS, meta: { intent: "career_outreach_draft" } };
  if (m === "apply to the first one") return { reply: "Acme TEST: Data Analyst Intern. First name: Alex. Email: alex@example.test. Reply yes to send exactly this, or no.", meta: { intent: "career_apply_card", card_id: "card-1" } };
  if (m === "yes please") return { reply: "", meta: { intent: "career_card_yes", result_status: "needs_reply" } };
  if (m === "does it ask about visa sponsorship") return { reply: "The posting asks: will you need visa sponsorship? Reply yes or no.", meta: { intent: "career_screen", screen_buttons: ["Yes", "No"], screen_qid: "0a1b2c3d" } };
  if (m === "send me my tailored resume") return { reply: "Your tailored resume for Acme TEST is ready: https://trainee.test/file/abc", artifacts: [{ ref: "art-1", filename: "resume.pdf", mime: "application/pdf" }], meta: { intent: "career_file_link" } };
  if (m === "find data analyst internships in Chicago") return { reply: "2 openings:\n1. Data Analyst Intern at Acme TEST (Chicago)\nhttps://jobs.lever.co/acmetest/1\n2. Analytics Intern at Globex TEST (Chicago)\nhttps://boards.greenhouse.io/globextest/jobs/2", postings: [{ job_id: "lever:acmetest:1", url: "https://jobs.lever.co/acmetest/1" }], meta: { intent: "career_search" } };
  if (m === "what went wrong") return { httpStatus: 500 };
  return { reply: `Answer to: ${m}`, meta: { intent: "career_turn" } };
}

// [message, what it exercises]. 40 messages, one person, in order, on each channel.
const CONVERSATION: [string, string][] = [
  ["find me product design internships in NYC", "first message: greeting, then the answer"],
  [`here is my resume:\n${RESUME}`, "onboarding: a pasted resume"],
  ["yes, that's my resume", "onboarding: the yes"],
  ["actually my graduation year is 2027", "onboarding: a correction"],
  ["what do you know about me", "onboarding: readback"],
  ["find data analyst internships in Chicago", "search (postings ride as cards where the channel has them)"],
  ["show me remote ones too", "search: refine"],
  ["am I a fit for the first one?", "search: fit"],
  ["apply to the first one", "apply card"],
  ["yes please", "card yes without a reply to the card (needs_reply)"],
  ["does it ask about visa sponsorship", "screen question (Yes/No)"],
  ["yes", "screen answer, typed"],
  ["no", "a typed no"],
  ["show my applications", "status"],
  ["did my application to Acme TEST go through", "status of one"],
  ["what did you send to Acme TEST", "receipt"],
  ["send me my tailored resume", "file link (documents follow where the channel sends files)"],
  ["give me the link to my resume page", "file page link"],
  ["draft outreach to 3 people at Acme TEST", "outreach drafts in parts"],
  ["send the first draft", "outreach: send ask"],
  ["who do I know at Globex TEST", "networking"],
  ["help me negotiate an offer from Acme TEST", "negotiation"],
  ["they offered 25 an hour, what should I counter", "negotiation: numbers"],
  ["write the counter email", "negotiation: draft"],
  ["what should I do next?", "next step"],
  ["remind me tomorrow at 9am to follow up", "reminder"],
  ["pause my job alerts", "alerts"],
  [LONG, "a message over 4,000 characters (cut on a word, said)"],
  ["LINK 1234", "a LINK code that matches nothing"],
  ["yes", "a plain yes with no link question"],
  ["HELP", "HELP from a known person (a brain turn on chat channels)"],
  ["what went wrong", "agent-chat failing: the same apology everywhere"],
  ["STOP", "stop: fixed words, no turn"],
  ["find me jobs", "a message after STOP is still answered"],
  ["START", "start: fixed words"],
  ["connect telegram", "connect Telegram (TRANSPORT: already on Telegram there)"],
  ["erase my data", "erase"],
  ["delete my account", "account delete ask"],
  ["thanks!", "small talk"],
  ["bye", "goodbye"],
];

// TRANSPORT: the documented ways one channel's text may differ, as functions over what the person read. Each one is the
// transport's, never the reply's content.
//  - Telegram's posting screen: Yes / No buttons under "Yes or no?" (F09); elsewhere the words "Reply yes or no." when the
//    reply does not already say so.
//  - SERIAL-1480: a card yes with no usable reply id: Telegram and WhatsApp can reply to the card; iMessage cannot (no
//    verified reply-id path), so it is told to tap the card. Different words for a different capability; same action (nothing approved).
//  - "connect telegram" on Telegram itself: there is nothing to connect.
const SCREEN_TG = "Yes or no?";
function transport(ch: Channel, said: string, msgs: Sent[]): string[] {
  let out = msgs.map((m) => plain(m.text));
  if (ch === "telegram") out = out.filter((t, i) => !(t === SCREEN_TG && msgs[i].buttons.join() === "Yes,No"));
  out = out.map((t) => (t === NEEDS_TAP_IMESSAGE || t === NEEDS_REPLY_CHANNEL ? "<needs reply: channel wording>" : t));
  if (said === "connect telegram") {
    const all = out.join("\n");
    if (all === ALREADY_TELEGRAM_REPLY || /^Open this link where you use Telegram[^]*https:\/\/t\.me\/TraineeTestBot\?start=[A-Za-z0-9_-]{32}$/.test(all)) return ["<connect telegram: channel wording>"];
  }
  return out;
}
const flat = (xs: string[]) => xs.join("\n").replace(/\s+/g, " ").trim();

Deno.test("channel parity: 40 messages, the same route, the same request to agent-chat and the same reply on Telegram, WhatsApp and iMessage", async () => {
  const runs: Record<string, { results: unknown[]; asks: Record<string, unknown>[]; read: string[]; raw: Sent[][] }> = {};
  for (const ch of CHANNELS) {
    const h = channelWorld({ agent: agent as never });
    const results: unknown[] = [], asks: Record<string, unknown>[] = [], read: string[] = [], raw: Sent[][] = [];
    for (const [said] of CONVERSATION) {
      const m = h.mark(), a = h.agentCalls.length;
      const r = await h.text(ch, ADDR[ch], said);
      results.push(ch === "imessage" ? r : r.results?.[0]);
      // The request each webhook made of agent-chat, without what is the transport's: its channel name (checked below) and
      // the turn key (a hash of the provider's message id).
      const call = h.agentCalls[a] as Record<string, unknown> | undefined;
      if (call) { eq(call.channel, AGENT_CHANNEL[ch], `${ch}: names its channel`); const { channel: _c, turn_key: _t, ...rest } = call; asks.push(rest); } else asks.push({ none: true });
      const msgs = h.read(ADDR[ch], m);
      raw.push(msgs);
      read.push(flat(transport(ch, said, msgs)));
    }
    runs[ch] = { results, asks, read, raw };
  }
  CONVERSATION.forEach(([said, what], i) => {
    for (const ch of ["whatsapp", "imessage"] as const) {
      const at = `message ${i + 1} (${what}) on ${ch}`;
      eq(runs[ch].results[i], runs.telegram.results[i], `${at}: the same route as Telegram`);
      eq(runs[ch].asks[i], runs.telegram.asks[i], `${at}: the same request to agent-chat as Telegram`);
      eq(runs[ch].read[i], runs.telegram.read[i], `${at}: the same words as Telegram (said: ${JSON.stringify(said.slice(0, 40))})`);
    }
  });
  // What the conversation pins, read once (the same on every channel by the loop above).
  const T = runs.telegram;
  eq(T.raw[0].map((m) => plain(m.text))[0], GREETING, "the first message is greeted first");
  eq(T.read.filter((r) => r.includes(GREETING)).length, 1, "and only once in 40 messages");
  assert(T.read[18].includes("Draft 1 of 3") && T.read[18].includes("Draft 3 of 3"), "every outreach draft, whole");
  assert(T.read[27].startsWith(flat([longCutNote(cutForChat(LONG).text)])), "the long message is cut and said");
  eq(T.read[28], LINK_CODE_NO_MATCH_REPLY);
  eq(T.read[31], CHAT_DOWN_REPLY, "agent-chat failing reads the same apology");
  eq([T.read[32], T.read[34]], [CHANNEL_REPLIES.stop, CHANNEL_REPLIES.start]);
  eq(T.asks[32], { none: true }, "STOP never reaches the brain");
  assert(T.read[10].includes("Reply yes or no."), "the screen question");
  // Telegram's own buttons, where the others have the words (TRANSPORT).
  assert(runs.telegram.raw[10].some((m) => m.buttons.join() === "Yes,No"), "Telegram: Yes / No buttons");
  assert(!runs.whatsapp.raw[10].some((m) => plain(m.text) === SCREEN_TG) && !runs.imessage.raw[10].some((m) => plain(m.text) === SCREEN_REPLY_YES_NO), "elsewhere: the reply's own words, not a second question");
});

Deno.test("channel parity: a file sent with no words gets the same answer on every channel (iMessage answered nothing before)", async () => {
  const got: Record<string, string[]> = {};
  for (const ch of CHANNELS) {
    const h = channelWorld();
    await h.text(ch, ADDR[ch], "find me jobs");
    const m = h.mark();
    await h.file(ch, ADDR[ch]);
    got[ch] = h.read(ADDR[ch], m).map((s) => plain(s.text));
  }
  // Telegram reads a resume file where the service client is wired (production); without it, the plain answer, as the others.
  eq(got.telegram, [FILE_NOT_READ_REPLY]);
  eq(got.whatsapp, got.telegram, "WhatsApp");
  eq(got.imessage, got.telegram, "iMessage");
});

Deno.test("channel parity: each webhook's index.ts names its channel to agent-chat (none is left on the web's formatting)", async () => {
  for (const [dir, ch] of [["trainee-telegram", "telegram"], ["trainee-whatsapp", "whatsapp"], ["trainee-inbound", "imessage"]] as const) {
    const src = await Deno.readTextFile(`${ROOT}supabase/functions/${dir}/index.ts`);
    assert(new RegExp(`chatThroughAgent\\(url, key, \\{ channel: "${ch}" \\}\\)`).test(src), `${dir}/index.ts passes channel "${ch}"`);
    eq(AGENT_CHANNEL[ch], ch);
  }
});

// agent-chat's own reads of the channel: every place a turn's ROUTE or CONTENT depends on which channel asked. Each is either
// the transport's (a button, a link token's channel, the writer's formatting line) or an open product decision (DECISIONS in
// the PR). A new read fails here until it is listed, so a channel-only feature cannot arrive silently.
const AGENT_CHANNEL_READS: Record<string, string> = {
  "sendConsentFor": "TRANSPORT: the connect link's token records the channel it was sent on",
  "writeReadinessAsk": "TRANSPORT: the formatting line (markdown or not)",
  "hereOut": "DECISION: APPLY HERE (a pasted posting answered with one line and an Apply button) is Telegram's only; WhatsApp and iMessage run the apply turn",
  "confirmMailAsk": "TRANSPORT: Telegram gets the link as a button too; the words and the link are the same",
  "shape:": "TRANSPORT (and off: CAREER_REPLY_WRITER is never on): Telegram's files and links as their own messages",
  "longRest": "TRANSPORT (and off: CAREER_REPLY_WRITER is never on): a long answer's rest as a second message",
  "writeReply": "TRANSPORT (and off: CAREER_REPLY_WRITER is never on): the writer's formatting line",
  "shapeForTurn": "TRANSPORT (and off: CAREER_REPLY_WRITER is never on): the reply shaped into files and links on Telegram",
};
Deno.test("channel parity: agent-chat reads the channel only where it is listed", async () => {
  const src = await Deno.readTextFile(`${ROOT}supabase/functions/agent-chat/handler-career.ts`);
  const lines = src.split("\n").filter((l) => /\(body as any\)\?\.channel/.test(l));
  for (const l of lines) assert(Object.keys(AGENT_CHANNEL_READS).some((k) => l.includes(k)), `an unlisted channel read in agent-chat: ${l.trim().slice(0, 160)}`);
  eq(lines.length, 10, "the reads listed (two confirmMailAsk, two writeReadinessAsk)");
});
