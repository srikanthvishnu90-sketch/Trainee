// Presentation fixtures for the Telegram bridge: HTML rendering, typing
// presence, document sends, and — the load-bearing case — an approval
// button tap resolving into the SAME structured, hash-bound approval the
// app client sends (exact message + career_batch approve request).
import { handleTelegramWebhook, withTelegramTyping } from "../../supabase/functions/_shared/telegram_bridge.ts";
import {
  FakeAdminApprovals, assert, assertEq, envOf, fakeFetchRich, TEST_USER, SUPABASE_URL, SERVICE_KEY,
} from "./lib/channel_fixture.ts";

const CHAT_ID = 424242;
const SECRET = "fixture-webhook-secret";
const RUN_ID = "batch-fixture42";
const HASH = "a".repeat(64);

const CARD_REPLY = "**Your batch is ready**\n\n13 roles are tailored and sitting at the final review screen — nothing submits until your yes.";
const APPROVED_REPLY = "Your yes is recorded for this batch exactly as carded — the browser worker will submit it under that approval.";

function batchRecord(status = "awaiting_approval", hash = HASH) {
  return {
    version: "career_batch_run/v1", userId: TEST_USER, runId: RUN_ID, status,
    run: { id: RUN_ID, status, cardSha256: hash, summary: {} },
  };
}

function deps(chat: (body: any) => any, opts: { parseFailOnce?: boolean; seedRun?: boolean } = {}) {
  const admin = new FakeAdminApprovals();
  if (opts.seedRun !== false) admin.batchRuns.set(RUN_ID, batchRecord());
  const f = fakeFetchRich({ chat, telegramParseFailOnce: opts.parseFailOnce });
  const env = envOf({
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    TELEGRAM_BOT_TOKEN: "fixture-bot-token",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    CHANNEL_TEST_USER_ID: TEST_USER,
    TELEGRAM_ALLOWED_CHAT_IDS: String(CHAT_ID),
  });
  return { admin, calls: f.calls, d: { env, fetchFn: f.fn, createAdmin: () => admin, paceMs: 0 } as any };
}

function tgReq(update: any) {
  return new Request("https://fixture.supabase.co/functions/v1/telegram-inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update),
  });
}
const textUpdate = (text: string, id = 11, chatId = CHAT_ID) => ({
  update_id: 9000 + id,
  message: { message_id: id, date: 1760000000, text, chat: { id: chatId, type: "private" }, from: { id: 777, is_bot: false } },
});
const callbackUpdate = (data: string, id = 71, chatId = CHAT_ID) => ({
  update_id: 9500 + id,
  callback_query: {
    id: `cbq-${id}`, from: { id: 777, is_bot: false },
    message: { message_id: 55, date: 1760000000, chat: { id: chatId, type: "private" } },
    data,
  },
});
const agentCalls = (calls: any[]) => calls.filter((c) => c.url.includes("/functions/v1/agent-chat"));
const tgCalls = (calls: any[], method: string) => calls.filter((c) => c.url.includes("api.telegram.org") && c.url.endsWith("/" + method));
const sendBodies = (calls: any[]) => tgCalls(calls, "sendMessage").map((c) => JSON.parse(c.init.body));

async function offerCard(d: any, admin: FakeAdminApprovals) {
  const res = await handleTelegramWebhook(tgReq(textUpdate("batch status")), d);
  assertEq(res.status, 200);
  const kb = sendBodies((d as any).__calls ?? []);
  return kb;
}

// Scripted chat: first the card status reply (batch_run awaiting approval),
// then the approval confirmation for the structured approve request.
function cardThenApprove(body: any) {
  if (body.career_batch?.action === "approve") return { reply: APPROVED_REPLY };
  return {
    reply: CARD_REPLY,
    batch: { version: "career_batch_run/v1", id: RUN_ID, userId: TEST_USER, status: "awaiting_approval", kind: "batch_run", summary: {} },
  };
}

Deno.test("card reply renders as HTML and carries a real approval keyboard", async () => {
  const { d, calls, admin } = deps(cardThenApprove);
  const res = await handleTelegramWebhook(tgReq(textUpdate("batch status")), d);
  assertEq(res.status, 200);
  const bodies = sendBodies(calls);
  assert(bodies.some((b) => b.parse_mode === "HTML" && String(b.text).includes("<b>Your batch is ready</b>")), "card text sent as HTML with structure: " + JSON.stringify(bodies));
  const kbMsg = bodies.find((b) => b.reply_markup?.inline_keyboard);
  assert(kbMsg, "an inline keyboard was offered");
  const flat = kbMsg.reply_markup.inline_keyboard.flat();
  const approveBtn = flat.find((b: any) => /^appr:/.test(b.callback_data ?? ""));
  assert(approveBtn, "approve button with token callback_data");
  assert(flat.some((b: any) => /^apprx:/.test(b.callback_data ?? "")), "not-now button present");
  assertEq(admin.approvals.size, 1, "one pending approval stored");
  const row = [...admin.approvals.values()][0];
  assertEq(row.run_id, RUN_ID);
  assertEq(row.card_sha256, HASH, "the card hash is bound server-side, never in the button");
  assert(!JSON.stringify(kbMsg).includes(HASH), "the hash itself never reaches the client");
});

Deno.test("typing presence fires before the agent is called", async () => {
  const { d, calls } = deps(() => ({ reply: "Working on it." }));
  await handleTelegramWebhook(tgReq(textUpdate("find roles")), d);
  const typingIdx = calls.findIndex((c) => c.url.endsWith("/sendChatAction"));
  const agentIdx = calls.findIndex((c) => c.url.includes("/functions/v1/agent-chat"));
  assert(typingIdx >= 0, "sendChatAction was called");
  assert(agentIdx > typingIdx, "typing precedes the agent call");
  const action = JSON.parse(calls[typingIdx].init.body);
  assertEq(action.action, "typing");
  assertEq(action.chat_id, CHAT_ID);
});

Deno.test("typing refreshes while a turn runs long, and stops when it settles", async () => {
  const { d, calls } = deps(() => ({ reply: "ok" }), { seedRun: false });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const p = withTelegramTyping(d, "fixture-bot-token", String(CHAT_ID), async () => { await gate; return 7; }, 20);
  await new Promise((r) => setTimeout(r, 90));
  release();
  assertEq(await p, 7, "the wrapped work's value passes through");
  const n = tgCalls(calls, "sendChatAction").length;
  assert(n >= 3, `typing fired at intake and refreshed while waiting (saw ${n})`);
  await new Promise((r) => setTimeout(r, 60));
  assertEq(tgCalls(calls, "sendChatAction").length, n, "typing stops when the turn settles — no leaked interval");
});

Deno.test("a structured reply goes out as one HTML part: bullets and a bare URL intact", async () => {
  const { d, calls } = deps(() => ({
    reply: "**Plan**\n\n- One\n- Two\n\nApply here: https://jobs.example.com/posting/1",
  }), { seedRun: false });
  const res = await handleTelegramWebhook(tgReq(textUpdate("plan please")), d);
  assertEq(res.status, 200);
  const bodies = sendBodies(calls).filter((b) => b.parse_mode === "HTML");
  assertEq(bodies.length, 1, "one HTML part");
  assert(String(bodies[0].text).includes("• One") && String(bodies[0].text).includes("• Two"), "bullets survive: " + bodies[0].text);
  assert(String(bodies[0].text).includes("https://jobs.example.com/posting/1"), "the bare URL survives unmangled: " + bodies[0].text);
});

Deno.test("button tap == exact-message approval: identical structured effect, single use", async () => {
  const { d, calls, admin } = deps(cardThenApprove);
  await handleTelegramWebhook(tgReq(textUpdate("batch status")), d);
  const token = [...admin.approvals.keys()][0];
  assert(token, "pending approval token exists");

  const res = await handleTelegramWebhook(tgReq(callbackUpdate(`appr:${token}`)), d);
  assertEq(res.status, 200);
  const ac = agentCalls(calls);
  assertEq(ac.length, 2, "card turn + approval turn");
  const approveBody = JSON.parse(ac[1].init.body);
  assertEq(approveBody.message, `Approve batch ${RUN_ID}`, "the exact approval message, word for word");
  assertEq(approveBody.as_user_id, TEST_USER);
  assertEq(approveBody.career_batch.action, "approve");
  assertEq(approveBody.career_batch.version, "career_batch_intent/v1");
  assertEq(approveBody.career_batch.runId, RUN_ID);
  assertEq(approveBody.career_batch.cardSha256, HASH, "the card's own hash rides the request — the core re-verifies it");
  assert(typeof approveBody.career_batch.eventId === "string" && approveBody.career_batch.eventId.length > 0, "event id present");
  assert(sendBodies(calls).some((b) => String(b.text).includes("Your yes is recorded")), "the core's own answer is what the user sees");
  assert(tgCalls(calls, "answerCallbackQuery").length >= 1, "the tap is acknowledged");

  // Replay of the same tap: the token is spent — no second approval call.
  const before = agentCalls(calls).length;
  await handleTelegramWebhook(tgReq(callbackUpdate(`appr:${token}`, 72)), d);
  assertEq(agentCalls(calls).length, before, "a spent button never approves twice");
});

Deno.test("not-now tap consumes the offer and approves nothing", async () => {
  const { d, calls, admin } = deps(cardThenApprove);
  await handleTelegramWebhook(tgReq(textUpdate("batch status")), d);
  const token = [...admin.approvals.keys()][0];
  await handleTelegramWebhook(tgReq(callbackUpdate(`apprx:${token}`)), d);
  assertEq(agentCalls(calls).length, 1, "no approval call was made");
  assert(sendBodies(calls).some((b) => String(b.text).includes("nothing was approved")), "dismissal is spoken in product voice");
  const before = agentCalls(calls).length;
  await handleTelegramWebhook(tgReq(callbackUpdate(`appr:${token}`, 73)), d);
  assertEq(agentCalls(calls).length, before, "the spent offer cannot be revived");
});

Deno.test("expired button and foreign-chat taps never reach the agent", async () => {
  const { d, calls, admin } = deps(cardThenApprove);
  await handleTelegramWebhook(tgReq(textUpdate("batch status")), d);
  const token = [...admin.approvals.keys()][0];
  // Foreign chat tries the button.
  await handleTelegramWebhook(tgReq(callbackUpdate(`appr:${token}`, 74, 999999)), d);
  assertEq(agentCalls(calls).length, 1, "foreign chat tap ignored");
  // Expire the offer, then the owner taps.
  const row = admin.approvals.get(token);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  await handleTelegramWebhook(tgReq(callbackUpdate(`appr:${token}`, 75)), d);
  assertEq(agentCalls(calls).length, 1, "expired tap never approves");
  const answers = tgCalls(calls, "answerCallbackQuery").map((c) => JSON.parse(c.init.body));
  assert(answers.some((a) => String(a.text).includes("expired")), "expiry is named to the user");
});

Deno.test("telegram HTML parse failure falls back to a plain send of the same content", async () => {
  const { d, calls } = deps(() => ({ reply: "Found **3** roles for you." }), { parseFailOnce: true, seedRun: false });
  const res = await handleTelegramWebhook(tgReq(textUpdate("find roles")), d);
  assertEq(res.status, 200);
  const bodies = sendBodies(calls);
  const withMode = bodies.filter((b) => b.parse_mode === "HTML");
  const plain = bodies.filter((b) => !b.parse_mode);
  assertEq(withMode.length, 1, "first attempt used HTML");
  assertEq(plain.length, 1, "the same part was resent without parse_mode");
  assert(!String(plain[0].text).includes("<b>"), "fallback text carries no raw tags");
  assert(String(plain[0].text).includes("3"), "content preserved in the fallback");
});

Deno.test("telegram HTML parse failure keeps the link destination in the plain fallback", async () => {
  const { d, calls } = deps(() => ({ reply: "Details: [the card](https://example.com/card?a=1&b=2) inside." }), { parseFailOnce: true, seedRun: false });
  const res = await handleTelegramWebhook(tgReq(textUpdate("details please")), d);
  assertEq(res.status, 200);
  const bodies = sendBodies(calls);
  const plain = bodies.filter((b) => !b.parse_mode);
  assertEq(plain.length, 1, "the part was resent without parse_mode");
  assert(String(plain[0].text).includes("the card (https://example.com/card?a=1&b=2)"), "label AND destination survive the fallback: " + plain[0].text);
});

Deno.test("document artifacts are sent as files; the current contract sends none", async () => {
  {
    const { d, calls } = deps(() => ({
      reply: "Here is your tailored resume.",
      artifacts: [{ kind: "document", url: "https://files.example.com/resume.pdf", filename: "resume.pdf" }],
    }), { seedRun: false });
    await handleTelegramWebhook(tgReq(textUpdate("send my resume")), d);
    const docs = tgCalls(calls, "sendDocument");
    assertEq(docs.length, 1, "one document sent");
    assertEq(JSON.parse(docs[0].init.body).document, "https://files.example.com/resume.pdf");
  }
  {
    const { d, calls } = deps(() => ({ reply: "No file this time." }), { seedRun: false });
    await handleTelegramWebhook(tgReq(textUpdate("hi")), d);
    assertEq(tgCalls(calls, "sendDocument").length, 0, "no artifact field -> no document send (CHANNEL-DOC-1)");
  }
});

Deno.test("an agent failure is spoken in product voice, once", async () => {
  const { d, calls } = deps(() => ({ __status: 500, body: { error: "internal" } }), { seedRun: false });
  const res = await handleTelegramWebhook(tgReq(textUpdate("find roles")), d);
  assertEq(res.status, 500);
  const errSends = sendBodies(calls).filter((b) => String(b.text).includes("the request failed on Trainee's side"));
  assertEq(errSends.length, 1, "the user hears one plain error with a next step");
  assert(String(errSends[0].text).includes("nothing was changed"), "the error names the state honestly");
});

// Codex's live /start, 2026-10-20 4:59 PM: agent-chat answered 429 (the person's hourly turn limit) and the bridge
// threw "agent-chat HTTP 429", so the person heard "Something went wrong on my side" and Telegram was told 500.
// A limit is not a failure: the person hears that the message was not read and when to send it again.
Deno.test("an hourly-limit 429 is spoken as the limit, not as a failure", async () => {
  const { d, calls } = deps(() => ({ __status: 429, body: { error: "rate_limited", message: "Slow down a little — try again in a bit." } }), { seedRun: false });
  const res = await handleTelegramWebhook(tgReq(textUpdate("/start")), d);
  assertEq(res.status, 200, "a limit is handled; Telegram must not retry it as a failure");
  const texts = sendBodies(calls).map((b) => String(b.text));
  assertEq(texts.filter((t) => t.includes("the request failed on Trainee's side")).length, 0, "no false error reply");
  const limit = texts.filter((t) => t.includes("didn't read that message"));
  assertEq(limit.length, 1, "one limit message");
  assert(limit[0].includes("60 messages an hour") && limit[0].includes("send it again"), "names the limit and the next step");
});
