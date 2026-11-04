// The Telegram chat flow end to end at scale (2026-10-30; the beta's live channel): about 11,000 generated scenarios
// (tests/architect/scenarios/telegram-generator.ts, seeded) through the real Telegram webhook (trainee-telegram/handler.ts
// handleTelegram, its adapter built exactly as the deploy builds it, over a fake Bot API), the real inbound core
// (channel_inbound.ts), the real delivery run (channel.ts deliverDue over the channel's memory database, channel_memory.ts),
// and, for postings, the real job cards and taps (telegram_jobs.ts) composed exactly as the handler composes them with the
// service client (webhookDeps + jobTap / showPostings / cardTap), over memory stores. No network, no model, no database,
// no wall clock: the clock is the scenario's.
//
// What must hold, from how each scenario was built:
//   webhook    a wrong or missing secret header is refused (403, as WO-038 pinned it) and nothing is processed: no update
//              claimed, no account made, no model turn, no Bot API call; another method 405; not configured 503.
//   order      every update is processed once (a retried update_id runs nothing), in any order, and every reply goes to the
//              chat that asked, and only there.
//   update     edits, channel posts, stickers, polls, member updates, group and supergroup messages, a bot's message and
//              malformed updates: answered 200, never a crash, no model turn, nothing sent to a group; voice / audio /
//              video and photos / files from a known person get their plain answer (never silence); a block is the STOP.
//   identity   a forwarded contact (another user id, none, or not the sender's) never links or makes an account; a
//              shared phone never runs an empty turn; /stop holds every proactive message queued before or after it, /start
//              resumes; two chats are two accounts, each reading only its own replies.
//   cards      every card line is a field the posting states (or an honest label of one); the logo only from the
//              employer's own domain (never an ATS's, a job board's or another company's that shares a prefix); callback
//              data valid UTF-8, at most 64 bytes, mapping back to exactly that posting; a mass list without the hosted page
//              degrades to cards, honestly.
//   taps       Confirm approves exactly the shown payload hash, at most once (a double tap, a retried update, a changed
//              payload, another person's chat, a forged tag, a closed posting, a posting past its deadline, a
//              LinkedIn / Indeed / Handshake host, a payload with a password field: nothing approved); every tap answered once.
//   applyhere  LinkedIn, Indeed and Handshake links are never set up (link-out only); each posting gets ONE Apply button.
//   reply      every message at most 4,096 characters, valid UTF-8, well-formed HTML when parse_mode is HTML, every link
//              whole; #301 long answers: the head, then ONE second message (or the page link), in that order; no secret in
//              an error or a response.
//   ratelimit  Telegram's 429: retry_after honoured (no call to that chat before it ends), never a message twice, every
//              message in order.
// Run: deno test -A --no-check tests/architect/scenarios-telegram.test.ts
import assertNode from "node:assert/strict";
import { generate, NOW, NEVER, type Scenario, type PostingSpec, type IdStep } from "./scenarios/telegram-generator.ts";
import { handleTelegram, jobSenderFor, webhookDeps } from "../../supabase/functions/trainee-telegram/handler.ts";
import { CHAT_DOWN_REPLY, FILE_NOT_READ_REPLY, handleChannelWebhook, MEDIA_CAPTION_NOTE, PHONE_ALREADY_REPLY, PHONE_NO_ACCOUNT_REPLY, PHONE_NOT_YOURS_REPLY, SIGNUP_CLOSED_REPLY,
  VOICE_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { hashTag, type JobDeps, type JobStore, type PostingRow, type PreparedRow, refOf, sendJobCards, tapJob } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { tapCard, type TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { applyHereAsk } from "../../supabase/functions/_shared/apply_here.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { addressOf } from "../../supabase/functions/_shared/channel_adapters.ts";
import { bytes, decode, fakeBot as botApi, LONE, plainOf } from "./scenarios/telegram-bot-api.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261030 });
// TG_ONLY=12,34 runs only those scenarios (a failure, again, alone).
const ONLY = new Set((Deno.env.get("TG_ONLY") ?? "").split(",").filter(Boolean).map(Number));
const only = (s: Scenario) => !ONLY.size || ONLY.has(s.id);
const TOKEN = "123456:TEST-telegram-token-not-real-ZZZZ", SECRET = "TEST_webhook_secret_0123456789_abcdefghij";
const MIN = 60000;

// ------------------------------------------------------------------------------------------------ the report
type Failure = { s: Scenario; why: string; got: string };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(s: Scenario, whys: string[], got = "") {
    this.total++;
    const k = s.category.split("/").slice(0, 2).join("/");
    this.byCat[k] = (this.byCat[k] ?? 0) + 1;
    for (const why of [...new Set(whys)].slice(0, 3)) {
      const key = `${s.kind}: ${why.replace(/[0-9a-f]{12,}|\d{3,}/g, "#").slice(0, 90)}`;
      if (!this.failures.has(key)) this.failures.set(key, []);
      this.failures.get(key)!.push({ s, why, got });
    }
  }
  assertClean() {
    const failed = new Set([...this.failures.values()].flat().map((f) => f.s.id)).size;
    const lines = [`[telegram] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failed`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 2)) lines.push(`    #${x.s.id} ${x.s.category}: ${x.why.slice(0, 300)} | got ${x.got.slice(0, 300)}`);
    }
    console.log(lines.join("\n"));
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${[...this.failures.keys()].slice(0, 6).join(" || ")}`);
  }
}
const fakeBot = (o: { clock: { t: number }; fail?: Parameters<typeof botApi>[0]["fail"]; throwFirst?: boolean }) => botApi({ token: TOKEN, now: () => o.clock.t, fail: o.fail, throwFirst: o.throwFirst });

// ------------------------------------------------------------------------------------------------ the jobs' memory stores
type Prep = PreparedRow & { userId: string };
function jobStores(now: () => number) {
  const kv = new Map<string, any>();
  const rows = new Map<string, PostingRow>();
  const preps: Prep[] = [];
  const applied = new Set<string>(), wants: string[] = [];
  const approvals: { userId: string; jobId: string; hash: string }[] = [];
  const store: JobStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, structuredClone({ job, shownAs })); },
    async recall(u, ref) { return structuredClone(kv.get(`${u}|job|${ref}`) ?? null); },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, [...refs]); },
    async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings(ids) { return ids.map((i) => rows.get(i)).filter((x): x is PostingRow => !!x).map((x) => structuredClone(x)); },
    async save(u, ref) { const k = `${u}|saved|${ref}`; if (kv.has(k)) return "already"; kv.set(k, true); return "saved"; },
    async prepared(u, jobId) { const p = preps.filter((x) => x.userId === u && x.job_id === jobId && (x.state === "ready" || x.state === "shown")).at(-1); return p ? structuredClone(p) : null; },
    async applied(u, jobId) { return applied.has(`${u}|${jobId}`); },
    async want(u, job) { const k = `${u}|${job.job_id}`; if (wants.includes(k)) return { result: "already" }; wants.push(k); return { result: "queued" }; },
  };
  // career_apply_card_confirm_as: one card opened and answered at once, bound to exactly this hash, once per posting.
  const cards = {
    async open() { throw new Error("the deployed store confirms in one transaction"); },
    async confirm(u: string, ids: string[], hashes: string[]) {
      const p = preps.find((x) => x.id === ids[0] && x.userId === u && (x.state === "ready" || x.state === "shown"));
      if (!p || p.payload_hash !== hashes[0]) throw new Error("card_changed");
      const k = `${u}|${p.job_id}`;
      if (applied.has(k)) return { card: { id: `card-${ids[0]}` }, results: [{ n: 1, company: p.company, result: "duplicate" }] };
      applied.add(k); p.state = "approved"; approvals.push({ userId: u, jobId: p.job_id, hash: p.payload_hash });
      return { card: { id: `card-${ids[0]}` }, results: [{ n: 1, company: p.company, result: "queued" }] };
    },
  };
  const tap: TapStore = { async card() { return null; }, async prepared() { return []; }, async answer() { throw new Error("no card"); } };
  return { store, cards, tap, rows, preps, applied, approvals, wants, now };
}

// ------------------------------------------------------------------------------------------------ one world
type Brain = (a: { userId: string; message: string; threadId: string | null }) => Record<string, unknown>;
function world(o: { env?: Record<string, string | undefined>; native?: boolean; brain?: Brain; fail?: Parameters<typeof fakeBot>[0]["fail"]; jobs?: boolean; throwFirst?: boolean } = {}) {
  const W = memoryChannelWorld();
  const clock = { t: NOW };
  const bot = fakeBot({ clock, fail: o.fail, throwFirst: o.throwFirst });
  const vars: Record<string, string | undefined> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot", TRAINEE_SIGNUP: "open",
    CAREER_TEXTING_NATIVE: o.native ? "on" : "off", ...o.env };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  const adapters = adaptersFromEnv(env, { fetch: bot.fetch, clock: () => clock.t, sleep });
  const chats: { userId: string; message: string }[] = [];
  const brain: Brain = o.brain ?? ((a) => ({ reply: `re[${a.userId}]: ${a.message}`.slice(0, 300) }));
  const chat = async (a: any) => { chats.push({ userId: a.userId, message: a.message }); if (!String(a.message ?? "").trim()) throw new Error("agent-chat HTTP 400"); return { status: 200, threadId: `t-${a.userId}`, ...brain(a) } as any; };
  const runs: any[] = [];
  const deliver = async (a: { userId: string; key: string; now: number }) => {
    const s = W.delivery({ only: { userId: a.userId, key: a.key } });
    const r = await deliverDue({ store: s, adapters, now: a.now }); await s.release(); runs.push(r); return r;
  };
  const cron = async () => { const s = W.delivery(); const r = await deliverDue({ store: s, adapters, now: clock.t, limit: 100 }); await s.release(); runs.push(r); return r; };
  // The webhook's own adapter, built as handleTelegram builds it from the secrets (no texting voice: that is the delivery's).
  const adapterOf = (e: { get(k: string): string | undefined }) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: bot.fetch, clock: () => clock.t, sleep });
  const pd = { env, now: () => clock.t, store: () => W.inbound, chat, deliver, adapter: adapterOf };
  const J = jobStores(() => clock.t);
  const jd = (): JobDeps => ({ store: J.store, cards: J.cards as any, tap: J.tap, now: () => clock.t, env, events: null, facts: async () => [], feedLinks: (u, l) => feedUrlsFor(env, u, l, clock.t) });
  let upd = 1;
  const post = async (u: unknown, h: { secret?: string | null; method?: string; raw?: string } = {}) => {
    clock.t += 1000;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (h.secret !== null) headers["x-telegram-bot-api-secret-token"] = h.secret ?? SECRET;
    const method = h.method ?? "POST";
    const req = new Request("https://fn.test/trainee-telegram", { method, headers, ...(method === "GET" ? {} : { body: h.raw ?? JSON.stringify(u) }) });
    let res: Response;
    if (o.jobs) {
      // Composed exactly as handler.ts composes it with the service client: the card taps and the job cards over the stores.
      const adapter = adapterOf(env);
      const core = { ...webhookDeps(adapter, pd as any),
        cardTap: async (a: { userId: string; data: string; now: number }) => await tapCard({ ...a, store: J.tap, events: null }),
        jobTap: async (a: { userId: string; data: string; messageId: string | null; contact: string }) => await tapJob({ userId: a.userId, data: a.data, messageId: a.messageId, deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }),
        showPostings: async (a: { userId: string; contact: string; hits: unknown[] }) => await sendJobCards({ userId: a.userId, hits: a.hits as any[], deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }) };
      res = await handleChannelWebhook(req, adapter, core as any);
    } else res = await handleTelegram(req, pd as any);
    return { status: res.status, text: await res.text() };
  };
  const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
  let mid = 10;
  const text = (chat: number, t: string, id = ++upd) => post({ update_id: id, message: { message_id: ++mid, ...from(chat), text: t } });
  const tap = (chat: number, data: string, messageId: number | null, id = ++upd) => post({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: chat, is_bot: false }, ...(messageId !== null ? { message: { message_id: messageId, chat: { id: chat, type: "private" }, date: 1 } } : {}), data } });
  const userOf = (chat: number) => W.contacts.get(`tg:${chat}`)?.userId ?? null;
  const known = (chat: number) => { const u = W.newUser(); W.link(`tg:${chat}`, u, clock.t - 3600000, { home: true, lastInboundAt: clock.t - 3600000 }); return u; };
  return { W, clock, bot, env, vars, adapters, chats, runs, cron, post, text, tap, from, userOf, known, J, nextUpdate: () => ++upd, nextMsg: () => ++mid };
}
const leaks = (s: string) => s.includes(TOKEN) || s.includes(SECRET) || s.includes(TOKEN.split(":")[1]);

// ================================================================================================ webhook
Deno.test({ name: "telegram battery: the webhook's door (secret, method, configuration, body)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("webhook");
  for (const s of SCENARIOS) {
    if (s.kind !== "webhook" || !only(s)) continue;
    const w = world({ env: s.config === "short_secret" ? { TELEGRAM_WEBHOOK_SECRET: "short" } : s.config === "no_secret" ? { TELEGRAM_WEBHOOK_SECRET: undefined } : s.config === "no_token" ? { TELEGRAM_BOT_TOKEN: undefined } : {} });
    const chat = 700000 + s.id;
    if (s.known) w.known(chat);
    const header = s.secret === "ok" ? SECRET : s.secret === "missing" ? null : s.secret === "wrong" ? "W".repeat(40) : s.secret === "prefix" ? SECRET.slice(0, -1) : s.secret === "suffix" ? `${SECRET}x`
      : s.secret === "case" ? SECRET.toUpperCase() : s.secret === "empty" ? "" : "OTHER_bot_secret_0123456789_abcdefghijkl";
    const body = { update_id: 900000 + s.id, message: { message_id: 5, ...w.from(chat), text: "hello there" } };
    const raw = s.body === "text" ? JSON.stringify(body) : s.body === "garbage" ? "{not json" : s.body === "array" ? "[1,2,3]" : s.body === "null" ? "null" : "";
    const contactsBefore = w.W.contacts.size;
    const r = await w.post(null, { secret: header, method: s.method, raw });
    const want = s.method !== "POST" ? 405 : s.config === "short_secret" || s.config === "no_secret" ? 503 : s.secret !== "ok" ? 403 : s.config === "no_token" ? 503 : 200;
    const whys: string[] = [];
    if (r.status !== want) whys.push(`status ${r.status}, want ${want}`);
    if (leaks(r.text)) whys.push("the response carries a secret");
    if (want !== 200) {
      if (w.bot.calls.length) whys.push(`refused, yet ${w.bot.calls.length} Bot API call(s)`);
      if (w.chats.length) whys.push("refused, yet a model turn ran");
      if (w.W.inbound.claimed.size) whys.push("refused, yet the update was claimed");
      if (w.W.contacts.size !== contactsBefore) whys.push("refused, yet a contact was recorded");
    } else if (s.body === "text") {
      if (w.chats.length !== 1) whys.push(`processed ${w.chats.length} turns`);
      if (!w.bot.to(chat).length) whys.push("no reply to the chat");
    } else if (w.chats.length || w.bot.msgs.length) whys.push("a body that is no update ran a turn");
    whys.push(...w.bot.violations);
    rep.grade(s, whys, r.text);
  }
  rep.assertClean();
} });

// ================================================================================================ order and retries
Deno.test({ name: "telegram battery: retried and out-of-order updates (each once, each reply to the chat that asked)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("order");
  for (const s of SCENARIOS) {
    if (s.kind !== "order" || !only(s)) continue;
    const w = world();
    for (const c of s.chats) w.known(c);
    const whys: string[] = [];
    for (const k of s.deliveries) {
      const u = s.updates[k];
      const r = await w.text(u.chat, u.text, u.updateId);
      if (r.status !== 200) whys.push(`update ${k}: status ${r.status}`);
    }
    for (const c of s.chats) {
      const mine = s.updates.filter((u) => u.chat === c);
      const turns = w.chats.filter((t) => t.userId === w.userOf(c)).map((t) => t.message).sort();
      if (JSON.stringify(turns) !== JSON.stringify(mine.map((u) => u.text).sort())) whys.push(`chat ${c}: turns ${turns.length} for ${mine.length} updates`);
      const got = w.bot.to(c).map(plainOf);
      for (const u of mine) { const n = got.filter((g) => g.includes(`: ${u.text.slice(0, 40)}`)).length; if (n !== 1) whys.push(`chat ${c}: the reply to "${u.text.slice(0, 20)}" arrived ${n} times`); }
      for (const g of got) if (!g.startsWith(`re[${w.userOf(c)}]`)) whys.push(`chat ${c} read another person's reply: ${g.slice(0, 60)}`);
    }
    whys.push(...w.bot.violations);
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ every update shape
Deno.test({ name: "telegram battery: every update shape (edits, channel posts, stickers, voice, groups, malformed): never a crash, never silence where the product answers", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("updates");
  for (const s of SCENARIOS) {
    if (s.kind !== "update" || !only(s)) continue;
    const w = world({ env: { TRAINEE_SIGNUP: s.signup === "open" ? "open" : "closed" } });
    const chat = s.chat, group = -1000000000000 - s.id;
    if (s.known) w.known(chat);
    const id = 300000 + s.id, mid = w.nextMsg();
    const m = (x: Record<string, unknown>) => ({ update_id: id, message: { message_id: mid, ...w.from(chat), ...x } });
    const g = (type: string, x: Record<string, unknown>) => ({ update_id: id, message: { message_id: mid, chat: { id: group, type, title: "TEST group" }, from: { id: chat, is_bot: false }, date: 1, ...x } });
    const U: Record<string, unknown> = {
      text: m({ text: "what should I do next?" }), edited_message: { update_id: id, edited_message: { message_id: mid, ...w.from(chat), text: "edited", edit_date: 2 } },
      edited_channel_post: { update_id: id, edited_channel_post: { message_id: mid, chat: { id: group, type: "channel" }, date: 1, text: "x" } },
      channel_post: { update_id: id, channel_post: { message_id: mid, chat: { id: group, type: "channel", title: "c" }, date: 1, text: "post" } },
      sticker: m({ sticker: { file_id: "s1", file_unique_id: "u1", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } }),
      voice: m({ voice: { file_id: "v1", file_unique_id: "uv1", duration: 3 } }), audio: m({ audio: { file_id: "a1", file_unique_id: "ua1", duration: 3 } }),
      video: m({ video: { file_id: "vd1", file_unique_id: "uvd1", width: 1, height: 1, duration: 3 } }), video_note: m({ video_note: { file_id: "vn1", file_unique_id: "uvn1", length: 1, duration: 3 } }),
      photo: m({ photo: [{ file_id: "p1", file_unique_id: "up1", width: 1, height: 1 }] }), caption_only_photo: m({ photo: [{ file_id: "p2", file_unique_id: "up2", width: 1, height: 1 }], caption: "my resume" }),
      document: m({ document: { file_id: "d1", file_unique_id: "ud1", file_name: "resume.pdf", mime_type: "application/pdf", file_size: 2000 } }),
      location: m({ location: { latitude: 1, longitude: 2 } }), poll: m({ poll: { id: "p", question: "q", options: [] } }), dice: m({ dice: { emoji: "🎲", value: 3 } }),
      inline_query: { update_id: id, inline_query: { id: "iq", from: { id: chat, is_bot: false }, query: "jobs", offset: "" } },
      chosen_inline_result: { update_id: id, chosen_inline_result: { result_id: "r", from: { id: chat, is_bot: false }, query: "jobs" } },
      member_kicked: { update_id: id, my_chat_member: { chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false }, date: 1, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } },
      member_back: { update_id: id, my_chat_member: { chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false }, date: 1, old_chat_member: { status: "kicked" }, new_chat_member: { status: "member" } } },
      chat_member: { update_id: id, chat_member: { chat: { id: group, type: "supergroup" }, from: { id: chat, is_bot: false }, date: 1, new_chat_member: { status: "member" } } },
      group_text: g("group", { text: "Trainee, what's my resume say?" }), supergroup_text: g("supergroup", { text: "show my applications" }), group_start: g("group", { text: "/start" }),
      bot_sender: { update_id: id, message: { message_id: mid, chat: { id: chat, type: "private" }, from: { id: 999, is_bot: true }, date: 1, text: "I am a bot" } },
      group_tap: { update_id: id, callback_query: { id: `cb-${id}`, from: { id: chat, is_bot: false }, message: { message_id: 1, chat: { id: group, type: "group" }, date: 1 }, data: "jca:0123456789ab" } },
      tap_no_message: { update_id: id, callback_query: { id: `cb-${id}`, from: { id: chat, is_bot: false }, data: "tca:00000000-0000-4000-8000-000000000000:0123456789abcdef" } },
      no_update_id: { message: { message_id: mid, ...w.from(chat), text: "hi" } }, string_update_id: { update_id: String(id), message: { message_id: mid, ...w.from(chat), text: "hi" } },
      empty_text: m({ text: "" }), whitespace_text: m({ text: "   \n " }),
      negative_chat: { update_id: id, message: { message_id: mid, chat: { id: -chat, type: "private" }, from: { id: chat, is_bot: false }, date: 1, text: "hi" } },
      huge_text: m({ text: "word ".repeat(1500) }), help: m({ text: "/help" }), start: m({ text: "/start" }),
    };
    const contacts = w.W.contacts.size;
    let r: { status: number; text: string };
    try { r = await w.post(U[s.shape]); } catch (e) { rep.grade(s, [`a crash: ${e instanceof Error ? e.message : String(e)}`]); continue; }
    const whys: string[] = [];
    if (r.status !== 200) whys.push(`status ${r.status}`);
    const toChat = w.bot.to(chat).map(plainOf);
    const toGroup = w.bot.msgs.filter((x) => Number(x.chat) < 0 || x.chat === String(-chat));
    if (toGroup.length) whys.push("something was sent to a group, a channel or a forged chat");
    const silent = ["edited_message", "edited_channel_post", "channel_post", "sticker", "location", "poll", "dice", "inline_query", "chosen_inline_result", "member_back", "chat_member",
      "group_text", "supergroup_text", "group_start", "bot_sender", "group_tap", "no_update_id", "string_update_id", "empty_text", "whitespace_text", "negative_chat", "member_kicked"];
    if (silent.includes(s.shape)) {
      if (w.chats.length) whys.push("a model turn ran for an update that is not the person's message");
      if (toChat.length) whys.push(`the chat was sent: ${toChat[0].slice(0, 60)}`);
      if (s.shape === "member_kicked" && s.known && !w.W.contacts.get(`tg:${chat}`)?.optedOut) whys.push("a block was not recorded as the person's STOP");
      if (s.shape !== "member_kicked" && w.W.contacts.size !== contacts) whys.push("an account or contact was recorded from an update that is not a private message");
    } else if (["voice", "audio", "video", "video_note"].includes(s.shape)) {
      if (w.chats.length) whys.push("a model turn ran for a voice message");
      if (s.known && JSON.stringify(toChat) !== JSON.stringify([VOICE_NOT_READ_REPLY])) whys.push(`a voice message got ${JSON.stringify(toChat).slice(0, 120)}`);
    } else if (s.shape === "photo") {
      if (w.chats.length) whys.push("a model turn ran for a photo");
      if (s.known && JSON.stringify(toChat) !== JSON.stringify([FILE_NOT_READ_REPLY])) whys.push(`a photo got ${JSON.stringify(toChat).slice(0, 120)}`);
    } else if (s.shape === "document") {
      if (w.chats.length) whys.push("a model turn ran for a file nobody read");
      const want = s.known || s.signup === "open" ? [FILE_NOT_READ_REPLY] : [SIGNUP_CLOSED_REPLY];
      if (JSON.stringify(toChat) !== JSON.stringify(want)) whys.push(`a file got ${JSON.stringify(toChat).slice(0, 120)}`);
    } else if (s.shape === "tap_no_message") {
      if (w.chats.length) whys.push("a model turn ran for a tap");
      if (w.bot.answers.length !== 1) whys.push(`the tap was answered ${w.bot.answers.length} times`);
    } else {
      // the person's own message: a turn when they have (or may make) an account, the sign-up answer when not
      if (s.shape === "help" && !s.known) {
        // HELP before any account exists is answered with the fixed help, never a model turn (WO-106)
        if (w.chats.length || JSON.stringify(toChat) !== JSON.stringify([CHANNEL_REPLIES.help])) whys.push(`a stranger's /help got ${JSON.stringify(toChat).slice(0, 120)}`);
      } else if (s.known || s.signup === "open") {
        if (w.chats.length !== 1) whys.push(`${w.chats.length} model turns`);
        if (w.chats.some((c) => !c.message.trim())) whys.push("an empty model turn");
        if (!toChat.length) whys.push("silence");
        if (toChat.some((t) => t === CHAT_DOWN_REPLY)) whys.push("I couldn't answer that");
        if (s.shape === "start" && s.known && !toChat[0]?.startsWith(CHANNEL_REPLIES.start.slice(0, 20))) whys.push(`/start from a known person: ${toChat[0]?.slice(0, 80)}`);
        // TELEGRAM ROUND 2 (2026-10-30, scenarios-telegram-r2.test.ts): the words sent with a photo are read (a job post's flyer
        // carries the post as its caption); the answer says first that the picture itself was not seen.
        if (s.shape === "caption_only_photo" && (w.chats[0]?.message !== "my resume" || !toChat[0]?.startsWith(MEDIA_CAPTION_NOTE))) whys.push(`a photo's caption: read ${JSON.stringify(w.chats[0]?.message)}, said ${JSON.stringify(toChat[0]?.slice(0, 80))}`);
      } else {
        if (w.chats.length) whys.push("a stranger's message ran a model turn with sign-up closed");
        if (s.shape === "help" ? toChat.length !== 1 : JSON.stringify(toChat) !== JSON.stringify([SIGNUP_CLOSED_REPLY])) whys.push(`a stranger got ${JSON.stringify(toChat).slice(0, 120)}`);
      }
    }
    whys.push(...w.bot.violations);
    rep.grade(s, whys, JSON.stringify(toChat).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ identity
Deno.test({ name: "telegram battery: identity (shared contacts, sign-up, /stop and /start, two chats)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("identity");
  for (const s of SCENARIOS) {
    if (s.kind !== "identity" || !only(s)) continue;
    const env: Record<string, string | undefined> = { TRAINEE_SIGNUP: s.signup === "open" ? "open" : "closed",
      TRAINEE_ALLOWED_CONTACTS: s.signup === "allow_chat" ? `telegram:${s.chat}` : s.signup === "allow_phone" ? s.allowPhone : undefined,
      TELEGRAM_LOGIN_URL: s.signup === "login_url" ? "https://trainee.test/telegram-link" : undefined };
    const w = world({ env });
    const whys: string[] = [];
    // another account already has this phone on iMessage: a shared contact asks there, never merges
    let other: string | null = null;
    if (s.otherAccountPhone) { other = w.W.newUser(); w.W.link(s.otherAccountPhone, other, NOW - 7 * 24 * 3600000, { home: true, lastInboundAt: NOW - 3600000, phone: s.otherAccountPhone }); }
    const second = s.chat + 5000000;
    const events: { type: "stop" | "start"; t: number }[] = [];
    for (const step of s.steps as IdStep[]) {
      const before = { user: w.userOf(s.chat), turns: w.chats.length, msgs: w.bot.to(s.chat).length, contacts: w.W.contacts.size };
      if (step.op === "text") await w.text(s.chat, step.text);
      else if (step.op === "second_chat") await w.text(second, step.text);
      else if (step.op === "contact") {
        const uid = step.whose === "own" ? s.chat : step.whose === "forwarded" ? 424242 : step.whose === "mismatch" ? s.chat + 1 : undefined;
        const asks = other ? w.W.outbox.filter((o) => o.userId === other && o.kind === "link").length : 0;
        await w.post({ update_id: w.nextUpdate(), message: { message_id: w.nextMsg(), ...w.from(s.chat), contact: { phone_number: step.phone, first_name: "TEST", ...(uid !== undefined ? { user_id: uid } : {}) } } });
        const said = w.bot.to(s.chat).slice(before.msgs).map(plainOf);
        if (step.whose !== "own") {
          if (w.userOf(s.chat) !== before.user) whys.push(`a ${step.whose} contact changed who this chat is`);
          if (w.chats.length !== before.turns) whys.push(`a ${step.whose} contact ran a model turn`);
          if (JSON.stringify(said) !== JSON.stringify([PHONE_NOT_YOURS_REPLY])) whys.push(`a ${step.whose} contact got ${JSON.stringify(said).slice(0, 100)}`);
          if (other && w.W.outbox.filter((o) => o.userId === other && o.kind === "link").length !== asks) whys.push("a forwarded contact asked another account to link");
        } else if (before.user) {
          if (w.userOf(s.chat) !== before.user) whys.push("an own contact moved a linked chat to another account");
          if (JSON.stringify(said) !== JSON.stringify([PHONE_ALREADY_REPLY])) whys.push(`an own contact on a linked chat got ${JSON.stringify(said).slice(0, 100)}`);
        } else {
          if (said.some((t) => t === CHAT_DOWN_REPLY)) whys.push("sharing their own phone got \"I couldn't answer that\"");
          if (w.chats.slice(before.turns).some((c) => !c.message.trim())) whys.push("sharing their own phone ran an empty model turn");
          if (other && w.userOf(s.chat) === other) whys.push("an own contact merged the chat into another account without asking it");
          if (!said.length) whys.push("sharing their own phone: silence");
          const allowed = s.signup === "open" || s.signup === "allow_chat" || s.signup === "allow_phone";
          if (!other && !allowed && JSON.stringify(said.slice(0, 1)) !== JSON.stringify([PHONE_NO_ACCOUNT_REPLY])) whys.push(`no account for that phone, sign-up closed: ${JSON.stringify(said).slice(0, 120)}`);
          if (!other && allowed && !w.userOf(s.chat)) whys.push("an allowed phone made no account");
        }
      } else if (step.op === "proactive") {
        const u = w.userOf(s.chat);
        if (u) w.W.queue(u, { key: step.key, kind: step.key.split(":")[0], text: `PROACTIVE ${step.key}`, at: w.clock.t });
      } else if (step.op === "deliver") { w.clock.t += MIN; await w.cron(); }
      else {
        const t = step.op === "stop" ? "/stop" : step.op === "start" ? "/start" : step.op === "help" ? "/help" : step.op === "stop_word" ? "STOP" : "START";
        await w.text(s.chat, t);
        if (step.op === "stop" || step.op === "stop_word") events.push({ type: "stop", t: w.clock.t });
        if ((step.op === "start" || step.op === "start_word") && events.length) events.push({ type: "start", t: w.clock.t });
        if ((step.op === "stop" || step.op === "stop_word") && w.chats.length !== before.turns) whys.push("STOP ran a model turn");
      }
      if (w.chats.slice(before.turns).some((c) => !c.message.trim())) whys.push(`an empty model turn after ${step.op}`);
    }
    w.clock.t += MIN; await w.cron();
    // STOP: nothing proactive went out while the person was stopped; after START a new one does
    const got = w.bot.to(s.chat).map(plainOf);
    const me = w.userOf(s.chat);
    for (const o of w.W.outbox.filter((x) => x.userId === me && x.kind !== "reply" && x.kind !== "link")) {
      if (o.status === "delivered") {
        const last = events.filter((e) => e.t <= (o.deliveredAt ?? 0)).at(-1);
        if (last?.type === "stop") whys.push(`a proactive ${o.key} went out while the person was stopped`);
      } else if (o.status === "queued" || o.status === "failed") whys.push(`a proactive ${o.key} left ${o.status}`);
      else if (o.status === "skipped_opt_out" && o.key === "alert:after" && events.at(-1)?.type === "start") whys.push("after START a new alert was held");
    }
    // two chats: two accounts, each reading only its own
    if (s.steps.some((x) => x.op === "second_chat") && w.userOf(second)) {
      if (w.userOf(second) === w.userOf(s.chat)) whys.push("two chats share one account");
      for (const t of w.bot.to(second).map(plainOf)) if (w.userOf(s.chat) && t.includes(`re[${w.userOf(s.chat)}]`)) whys.push("the second chat read the first chat's reply");
      for (const t of got) if (t.includes(`re[${w.userOf(second)}]`)) whys.push("the first chat read the second chat's reply");
    }
    for (const m of w.bot.msgs) if (m.chat !== String(s.chat) && m.chat !== String(second) && m.chat !== String(s.otherAccountPhone)) whys.push(`a message to ${m.chat}`);
    whys.push(...w.bot.violations);
    rep.grade(s, whys, JSON.stringify(got).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ job cards
const cleanText = (s: string, n: number) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, n);
const hitOf = (p: PostingSpec) => ({ job_id: p.jobId, company: p.company, title: p.title, location: p.location, url: p.url, pay: p.pay, level: p.level,
  first_seen_at: p.firstSeenAt, deadline: p.deadline, ...(p.statedDomain !== null ? { company_domain: p.statedDomain } : {}), fit: { reasons: p.reasons, gaps: p.gaps } });
const rowOf = (p: PostingSpec, now: number): PostingRow => ({ job_id: p.jobId, provider: p.jobId.split(":")[0], company: p.company, title: p.title, location: p.location, url: p.url,
  description: p.description, remote: p.remote, seniority_band: p.level, posted_at: p.postedAt, first_seen_at: p.firstSeenAt, pay: p.pay, closed_at: p.closed ? new Date(now - 3600000).toISOString() : null });
const SOURCE: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", web: "Web" };
// Every line of a card, judged against the posting it names: a field it states, an honest label, the link.
function cardLineProblems(text: string, p: PostingSpec, now: number): string[] {
  const out: string[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const trunc = /…$/.test(text);
  // A field the card shows whole or cut at its own limit (company 120, title and bullets 160): a prefix of what the posting states.
  const company = cleanText(p.company, 9999), title = cleanText(p.title, 9999), loc = cleanText(p.location, 120);
  const reasons = p.reasons.map((x) => cleanText(x, 9999)), gaps = p.gaps.map((x) => cleanText(x, 9999));
  const cut = (full: string, x: string, max: number) => full === x || (x.length >= Math.min(max, full.length) - 1 && full.startsWith(x));
  lines.forEach((l, i) => {
    const last = trunc && i === lines.length - 1, base = last ? l.replace(/…$/, "") : l;
    const isPrefix = (full: string) => (last ? full.startsWith(base) : full === base);
    if (i === 0) { if (!(last ? company.startsWith(base) : cut(company, base, 120))) out.push(`line 1 is not the company: ${l.slice(0, 60)}`); return; }
    if (i === 1) { if (!(last ? title.startsWith(base) : cut(title, base, 160))) out.push(`line 2 is not the title: ${l.slice(0, 60)}`); return; }
    if (l === p.url || l === `Link: ${p.url}`) return;
    if (/^(Why it fits you:|Gaps:)$/.test(l)) return;
    let m;
    if ((m = /^Pay: (.*)$/.exec(base))) { if (!p.pay || !isPrefix(`Pay: ${cleanText(p.pay, 120)}`)) out.push(`a pay the posting does not state: ${l}`); return; }
    if ((m = /^Level: (.*)$/.exec(base))) { if (!p.level || !isPrefix(`Level: ${p.level}`)) out.push(`a level the posting does not state: ${l}`); return; }
    if ((m = /^(Posted|First seen): (.*)$/.exec(base))) {
      const iso = m[1] === "Posted" ? p.postedAt : p.firstSeenAt;
      if (!iso) { out.push(`a ${m[1]} date the posting does not state`); return; }
      const t = Date.parse(iso);
      if (t > now && /\bago\b/.test(m[2])) out.push(`a future date said as "ago": ${l} (${iso})`);
      return;
    }
    if (/^Apply by: /.test(base)) { if (!p.deadline) out.push(`a deadline the posting does not state: ${l}`); return; }
    if ((m = /^Source: (.*)$/.exec(base))) { if (!isPrefix(`Source: ${SOURCE[p.jobId.split(":")[0]]}`)) out.push(`a source that is not the posting's: ${l}`); return; }
    if ((m = /^• (.*)$/.exec(base))) { const x = m[1]; if (![...reasons, ...gaps].some((r) => (last ? r.startsWith(x) : cut(r, x, 160)))) out.push(`a bullet the fit does not state: ${l.slice(0, 60)}`); return; }
    const where = base.split(" · ");
    const known = [loc, "Remote", "Hybrid", "On-site"].filter(Boolean);
    if (where.every((x, k) => known.some((y) => (last && k === where.length - 1 ? y.startsWith(x) : y.toLowerCase() === x.toLowerCase())))) return;
    if (/^Not prepared yet\.|^Tap Apply|^Not checked:/.test(l)) return;
    out.push(`a line the posting does not state: ${l.slice(0, 80)}`);
  });
  return out;
}
const logoDomainOf = (photo: string) => { try { return decodeURIComponent(new URL(photo).searchParams.get("domain") ?? ""); } catch { return ""; } };

Deno.test({ name: "telegram battery: job cards (only the posting's facts, the employer's own logo, callback data that maps back)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("cards");
  for (const s of SCENARIOS) {
    if (s.kind !== "cards" || !only(s)) continue;
    const env: Record<string, string | undefined> = { TRAINEE_FILE_BASE_URL: s.feed === "none" ? undefined : "https://trainee.test/file",
      TRAINEE_FILE_LINK_SECRET: s.feed === "url" || s.feed === "both" ? "file-link-secret-0123456789-abcdef" : undefined, TRAINEE_LOGO_GUESS: s.logoGuess ? "on" : undefined };
    const hits = s.postings.map(hitOf);
    const w = world({ env, jobs: true, brain: () => ({ reply: `${s.postings.length} postings for you.`, postings: hits }),
      fail: s.photoFails ? ({ method }) => (method === "sendPhoto" ? Response.json({ ok: false, error_code: 400, description: "Bad Request: failed to get HTTP URL content" }, { status: 400 }) : null) : undefined });
    const chat = 600000 + s.id, user = w.known(chat);
    for (const p of s.postings) if (p.row) w.J.rows.set(p.jobId, rowOf(p, NOW));
    const r = await w.text(chat, "find me jobs");
    const whys: string[] = [];
    if (r.status !== 200) whys.push(`status ${r.status}`);
    const msgs = w.bot.to(chat);
    const refs = new Map<string, PostingSpec>();
    for (const p of s.postings) refs.set(await refOf(user, p.jobId), p);
    const cards = msgs.filter((m) => m.buttons.some((b) => /^jca:/.test(b.callback_data ?? "")));
    const list = msgs.find((m) => /jobs for you\./.test(m.text));
    const unique = new Set(s.postings.map((p) => p.jobId)).size;
    if (s.postings.length > 3 && s.feed !== "none") {
      if (!list) whys.push("a mass list with the hosted page configured is not one line with the link");
      else {
        if ((s.feed === "url" || s.feed === "both") && !/https:\/\/trainee\.test\/file\?t=/.test(list.text)) whys.push("the list line has no signed link");
        if (s.feed === "webapp" && /https?:\/\//.test(list.text)) whys.push("the list line shows a link that opens nowhere (a Mini App URL needs Telegram's button)");
        if (s.feed === "webapp" && !list.buttons.some((b) => b.web_app?.url)) whys.push("the Mini App list has no Open button");
        for (const b of list.buttons) if (b.url && !/^https:\/\//.test(b.url)) whys.push("a list button that is not https");
      }
    } else {
      const want = Math.min(unique, 5);
      if (cards.length !== want && !(s.postings.length > 5)) whys.push(`${cards.length} cards for ${want} postings`);
      if (s.postings.length > 5 && cards.length !== 5) whys.push(`the first page has ${cards.length} cards, want 5`);
      if (unique > 5 && !msgs.some((m) => m.buttons.some((b) => /^jcn:/.test(b.callback_data ?? "")))) whys.push("more than five postings and no Next button");
    }
    for (const m of cards) {
      const data = m.buttons.map((b) => b.callback_data).filter(Boolean) as string[];
      for (const d of data) if (bytes(d) > 64 || LONE.test(d)) whys.push(`callback data ${d}`);
      const ref = /^jca:([0-9a-f]{12})$/.exec(data.find((d) => d.startsWith("jca:")) ?? "")?.[1];
      const p = ref ? refs.get(ref) : undefined;
      if (!p) { whys.push(`a card whose Apply maps to no posting: ${data.join(",")}`); continue; }
      if (!data.includes(`jcd:${ref}`) || !data.includes(`jcs:${ref}`)) whys.push("Details / Save not bound to the same posting");
      const text = plainOf(m).replace(new RegExp(`\\n\\n${p.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
      whys.push(...cardLineProblems(text, p, NOW));
      if (m.photo) {
        const d = logoDomainOf(m.photo);
        if (!s.logoGuess && d !== p.truthDomain) whys.push(`a logo from ${d} for ${p.company} (${p.urlKind} ${new URL(p.url).hostname}${p.statedDomain ? `, stated ${p.statedDomain}` : ""}); the employer's is ${p.truthDomain ?? "unknown"}`);
      } else if (!s.photoFails && !s.logoGuess && p.truthDomain && p.urlKind !== "decoy" && /^own_/.test(p.urlKind) && new URL(p.url).hostname.replace(/^(www|careers|jobs)\./, "") === p.truthDomain && p.truthDomain.split(".")[0] === p.company.toLowerCase().replace(/[^a-z0-9]/g, "")) {
        whys.push(`no logo for ${p.company} on its own host ${new URL(p.url).hostname}`);
      }
    }
    whys.push(...w.bot.violations);
    rep.grade(s, whys, msgs.map((m) => m.text.slice(0, 80)).join(" | "));
  }
  rep.assertClean();
} });

// ================================================================================================ taps
const NEVER_HOST = /(^|\.)(linkedin\.com|indeed\.com|joinhandshake\.com|lnkd\.in)\.?$/i;
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
Deno.test({ name: "telegram battery: taps (Confirm approves exactly the shown payload once; never twice, never changed, never another person's, never closed or never-automated)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("taps");
  let seq = 1;
  const rnd = (() => { let a = 99; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; })();
  for (const s of SCENARIOS) {
    if (s.kind !== "taps" || !only(s)) continue;
    const p = s.posting;
    const postings = [p, ...Array.from({ length: s.pageCount - 1 }, (_, i) => ({ ...p, jobId: `${p.jobId}-${i + 2}`, url: `${p.url}${p.url.includes("?") ? "&" : "?"}n=${i + 2}` }))];
    const w = world({ jobs: true, brain: (a) => (/find/.test(a.message) ? { reply: "Here you go.", postings: postings.map(hitOf) } : { reply: "ok" }) });
    const A = 500000 + s.id * 2, B = A + 1;
    const ua = w.known(A), ub = w.known(B);
    for (const q of postings) if (q.row) w.J.rows.set(q.jobId, rowOf(q, NOW));
    const SECRET_VALUE = "hunter2-Pa55word!";
    const newPrep = (): Prep => ({ id: `prep-${seq++}`, userId: ua, job_id: p.jobId, company: p.company, url: p.url, payload_hash: hex(rnd, 64), state: "ready", card_lines: [`${p.title} at ${p.company}`],
      payload: { resume_sha256: "f".repeat(64), resume_name: "test-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Alex" }, ...(s.secretField ? [{ name: "password", label: "Password", type: "password", value: SECRET_VALUE }] : [])],
        ...(s.destinationNever ? { destination: NEVER(1)[0] } : {}) } as any });
    if (s.prepared) w.J.preps.push(newPrep());
    if (s.applied) w.J.applied.add(`${ua}|${p.jobId}`);
    await w.text(A, "find me jobs");
    const ref = await refOf(ua, p.jobId);
    const cardMsg = w.bot.to(A).find((m) => m.buttons.some((b) => b.callback_data === `jca:${ref}`));
    const whys: string[] = [];
    if (!cardMsg) whys.push("no card with Apply for the posting");
    let shownTag: string | null = null, shownHash: string | null = null, lastTap: { chat: number; data: string; id: number } | null = null;
    let closed = p.closed, approvedBefore = s.applied, taps = 0;
    const current = () => w.J.preps.filter((x) => x.userId === ua && x.job_id === p.jobId && (x.state === "ready" || x.state === "shown")).at(-1) ?? null;
    const doTap = async (chat: number, data: string, id = w.nextUpdate()) => { taps++; lastTap = { chat, data, id }; return await w.tap(chat, data, cardMsg?.id ?? null, id); };
    for (const st of s.steps) {
      const before = { approvals: w.J.approvals.length, a: w.bot.to(A).length };
      if (st.op === "apply") {
        await doTap(A, `jca:${ref}`);
        const conf = w.bot.to(A).slice(before.a).flatMap((m) => m.buttons).find((b) => /^jcy:/.test(b.callback_data ?? ""));
        if (conf) { shownTag = conf.callback_data.split(":")[2]; shownHash = current()?.payload_hash ?? null; }
        if (conf && (s.secretField || NEVER_HOST.test(hostOf(p.url)))) whys.push("a Confirm button on an application that can never be approved here");
      } else if (st.op === "confirm" || st.op === "confirm_forged" || st.op === "confirm_stale_tag") {
        const tag = st.op === "confirm_forged" ? hex(rnd, 16) : st.op === "confirm_stale_tag" ? hex(rnd, 16) : shownTag ?? (current() ? hashTag(current()!.payload_hash) : "0".repeat(16));
        const cur = current();
        const deadlinePassed = p.deadline !== null && Date.parse(p.deadline) < w.clock.t;
        const may = !!cur && hashTag(cur.payload_hash) === tag && !approvedBefore && !closed && p.row && !deadlinePassed && !NEVER_HOST.test(hostOf(p.url)) && !s.destinationNever && !s.secretField;
        await doTap(A, `jcy:${ref}:${tag}`);
        const got = w.J.approvals.length - before.approvals;
        if (got > 1) whys.push("one Confirm approved more than once");
        if (got === 1 && !may) whys.push(`Confirm approved what it must not (${!cur ? "nothing prepared" : hashTag(cur.payload_hash) !== tag ? "a changed or forged tag" : approvedBefore ? "already approved" : closed ? "a closed posting" : !p.row ? "no posting on file" : deadlinePassed ? "past its deadline" : NEVER_HOST.test(hostOf(p.url)) ? "a never-automated host" : s.destinationNever ? "a never-automated destination" : "a password field"})`);
        if (got === 1) { const a = w.J.approvals.at(-1)!; if (a.userId !== ua || hashTag(a.hash) !== tag || a.jobId !== p.jobId) whys.push("the approval is not the shown payload"); approvedBefore = true; }
        const recent = !p.postedAt || (Date.parse(p.postedAt) <= w.clock.t && w.clock.t - Date.parse(p.postedAt) < 3 * 24 * 3600000);
        if (may && got === 0 && shownTag === tag && shownHash === cur!.payload_hash && recent && st.op === "confirm" && !p.description?.includes("German")) whys.push("a clean Confirm of the shown payload approved nothing");
      } else if (st.op === "change_payload") { const c = current(); if (c) { c.state = "superseded"; const n = newPrep(); w.J.preps.push(n); } }
      else if (st.op === "close_posting") { closed = true; const row = w.J.rows.get(p.jobId); if (row) row.closed_at = new Date(w.clock.t).toISOString(); }
      else if (st.op === "prepare") { if (!current() && !approvedBefore) w.J.preps.push(newPrep()); }
      else if (st.op === "other_person") {
        const bBefore = w.bot.to(B).length;
        const data = st.tap === "apply" ? `jca:${ref}` : st.tap === "details" ? `jcd:${ref}` : `jcy:${ref}:${shownTag ?? hashTag(current()?.payload_hash ?? "0".repeat(64))}`;
        await doTap(B, data);
        if (w.J.approvals.some((a) => a.userId === ub)) whys.push("another person's chat approved something");
        if (w.J.approvals.length !== before.approvals) whys.push("a tap from another person's chat approved the owner's application");
        for (const m of w.bot.to(B).slice(bBefore)) { const t = plainOf(m); if (t.includes(cleanText(p.title, 160)) || (p.company.length > 4 && t.includes(cleanText(p.company, 120)))) whys.push("another person's chat was shown the owner's posting"); }
      } else if (st.op === "next") {
        const nx = w.bot.to(A).flatMap((m) => m.buttons).filter((b) => /^jcn:/.test(b.callback_data ?? "")).at(-1);
        if (nx) await doTap(A, nx.callback_data);
      } else if (st.op === "retry_last") {
        if (lastTap) { const n = w.bot.answers.length, k = w.J.approvals.length; await w.tap(lastTap.chat, lastTap.data, cardMsg?.id ?? null, lastTap.id); if (w.bot.answers.length !== n || w.J.approvals.length !== k) whys.push("a retried update ran its tap again"); }
      } else if (st.op === "old_card") await doTap(A, `jca:${hex(rnd, 12)}`);
      else await doTap(A, `${{ details: "jcd", save: "jcs", edit: "jce", cancel: "jcx" }[st.op]}:${ref}`);
      if (w.J.approvals.length - before.approvals > 1) whys.push("a single tap approved twice");
    }
    if (w.J.approvals.filter((a) => a.userId === ua && a.jobId === p.jobId).length > 1) whys.push("the same posting approved twice");
    if (w.bot.answers.length !== taps) whys.push(`${taps} taps, ${w.bot.answers.length} answers`);
    if (new Set(w.bot.answers.map((a) => a.id)).size !== w.bot.answers.length) whys.push("a tap answered twice");
    for (const m of w.bot.msgs) if (s.secretField && m.text.includes(SECRET_VALUE)) whys.push("a password value was shown in the chat");
    whys.push(...w.bot.violations);
    rep.grade(s, whys, w.bot.to(A).slice(-3).map((m) => plainOf(m).slice(0, 100)).join(" | "));
  }
  rep.assertClean();
} });

// ================================================================================================ apply here
Deno.test({ name: "telegram battery: apply here (LinkedIn / Indeed / Handshake never set up; one Apply button per posting)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("applyhere");
  for (const s of SCENARIOS) {
    if (s.kind !== "applyhere" || !only(s)) continue;
    const whys: string[] = [];
    const ask = applyHereAsk(s.text, null);
    if (s.never.length || s.boards.length) {
      if (!ask) whys.push("the links were not read as an apply ask");
      else {
        for (const u of s.never) if (!ask.blocked.some((b) => b.replace(/[.,;:!?)\]]+$/, "") === u.replace(/[.,;:!?)\]]+$/, ""))) whys.push(`a never-automated link was not refused: ${u}`);
        for (const u of ask.urls) if (NEVER_HOST.test(hostOf(u))) whys.push(`a never-automated link would be opened: ${u}`);
      }
    }
    // Through the channel: the boards' postings as apply_here hits, each with its one button.
    const posts = s.boards.map((u, i) => ({ jobId: `greenhouse:${u.split("/")[3]}:${u.split("/").pop()}`, url: u, company: u.split("/")[3].replace(/^./, (c) => c.toUpperCase()), title: `Role ${i + 1}` }));
    if (posts.length) {
      const w = world({ jobs: true, env: { TRAINEE_FILE_BASE_URL: s.feed ? "https://trainee.test/file" : undefined, TRAINEE_FILE_LINK_SECRET: s.feed ? "file-link-secret-0123456789-abcdef" : undefined },
        brain: () => ({ reply: posts.length === 1 ? `${posts[0].title} at ${posts[0].company}: tap Apply.` : `${posts.length} postings ready.`, postings: posts.map((x) => ({ job_id: x.jobId, company: x.company, title: x.title, location: "", url: x.url, apply_here: true })) }) });
      const chat = 400000 + s.id, user = w.known(chat);
      for (const [i, x] of posts.entries()) {
        w.J.rows.set(x.jobId, { job_id: x.jobId, provider: "greenhouse", company: x.company, title: x.title, url: x.url, posted_at: new Date(NOW - 3600000).toISOString(), first_seen_at: null, closed_at: null, description: "Requirements\nSQL" });
        if (s.prepared[i]) w.J.preps.push({ id: `ah-${s.id}-${i}`, userId: user, job_id: x.jobId, company: x.company, url: x.url, payload_hash: `${String(i).padStart(2, "0")}${"ab".repeat(31)}`, state: "ready", card_lines: [], payload: { fields: [{ name: "first_name", label: "First name", value: "Alex" }] } as any });
      }
      await w.text(chat, s.text);
      const msgs = w.bot.to(chat);
      const withButtons = msgs.filter((m) => m.buttons.length);
      if (s.feed && posts.length > 1) {
        if (!msgs.some((m) => /Open the list/.test(m.text) && /https:\/\/trainee\.test\/file\?t=/.test(m.text))) whys.push("several postings with the list configured: no list link");
      } else {
        const uniq = new Set(posts.map((x) => x.jobId)).size;
        if (withButtons.length !== uniq) whys.push(`${withButtons.length} button messages for ${uniq} postings`);
        for (const m of withButtons) if (m.buttons.length !== 1 || m.buttons[0].text !== "Apply") whys.push(`a posting with buttons ${m.buttons.map((b) => b.text).join(",")}`);
        for (const [i, x] of posts.entries()) {
          const ref = await refOf(user, x.jobId);
          const b = withButtons.flatMap((m) => m.buttons).find((y) => (y.callback_data ?? "").includes(ref));
          if (!b) { whys.push(`no Apply for ${x.url}`); continue; }
          if (s.prepared[i] && !b.callback_data.startsWith(`jcy:${ref}:`)) whys.push("a prepared posting's Apply is not the hash-bound approval");
          if (!s.prepared[i] && b.callback_data !== `jca:${ref}`) whys.push("an unprepared posting's Apply is not the queue button");
        }
        // one tap on the first prepared posting's Apply approves exactly that payload, once
        const first = posts.findIndex((_, i) => s.prepared[i]);
        if (first >= 0 && posts.findIndex((x) => x.jobId === posts[first].jobId) === first) {
          const ref = await refOf(user, posts[first].jobId);
          const b = withButtons.flatMap((m) => m.buttons).find((y) => (y.callback_data ?? "").startsWith(`jcy:${ref}:`));
          if (b) {
            await w.tap(chat, b.callback_data, withButtons[0].id); await w.tap(chat, b.callback_data, withButtons[0].id);
            const a = w.J.approvals.filter((x) => x.jobId === posts[first].jobId);
            if (a.length !== 1 || hashTag(a[0].hash) !== b.callback_data.split(":")[2]) whys.push(`one Apply tap (twice) gave ${a.length} approvals`);
          }
        }
      }
      for (const m of msgs) for (const b of m.buttons) if (b.url && NEVER_HOST.test(hostOf(b.url))) whys.push("a button opens a never-automated site");
      whys.push(...w.bot.violations);
    }
    rep.grade(s, whys, s.text.slice(0, 200));
  }
  rep.assertClean();
} });

// ================================================================================================ replies
const urlsIn = (t: string) => (t.match(/https?:\/\/[^\s<>"']+/g) ?? []);
Deno.test({ name: "telegram battery: replies (4,096 characters, valid UTF-8 and HTML, links whole, #301 long answers in two messages, no secret echoed)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("replies");
  for (const s of SCENARIOS) {
    if (s.kind !== "reply" || !only(s)) continue;
    const shape = s.more !== null ? { attachments: [], links: s.links, more: [s.more] } : undefined;
    const w = world({ native: s.native, throwFirst: s.secretsInError, brain: () => ({ reply: s.reply, ...(s.parts ? { parts: s.parts } : {}), ...(shape ? { shape } : {}) }) });
    const chat = 200000 + s.id;
    w.known(chat);
    const r = await w.text(chat, "tell me");
    if (s.secretsInError) { w.clock.t += 2 * MIN; await w.cron(); }
    const whys: string[] = [];
    if (r.status !== 200) whys.push(`status ${r.status}`);
    if (leaks(r.text)) whys.push("the webhook's response carries a secret");
    for (const o of w.W.outbox) if (o.error && leaks(o.error)) whys.push("an outbox error carries the bot token");
    const msgs = w.bot.to(chat);
    const texts = msgs.map(plainOf);
    if (ONLY.size) console.log(JSON.stringify({ texts: texts.map((t) => t.slice(0, 80)), outbox: w.W.outbox.map((o) => [o.key, o.status, o.error]), runs: w.runs, calls: w.bot.calls.map((c) => c.method) }, null, 1));
    if (!msgs.length) whys.push("silence");
    const all = texts.join("\n");
    const sources = s.parts ?? [s.reply];
    for (const u of sources.flatMap(urlsIn)) if (!urlsIn(all).some((x) => x === u || x.replace(/[.,;:!?)]+$/, "") === u.replace(/[.,;:!?)]+$/, ""))) whys.push(`a link arrived cut or not at all: ${u.slice(0, 80)}`);
    if (s.more !== null) {
      // the words, whatever the voice did to the markdown
      const sq = (x: string) => x.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
      const head = sq(texts[0] ?? ""), rest = sq(s.more), links = s.links;
      if (!head || rest.startsWith(head.slice(0, 30)) || links.includes((texts[0] ?? "").trim())) whys.push("#301: the answer did not come first");
      const moreMsgs = texts.filter((t) => !links.includes(t.trim()) && rest.includes(sq(t).slice(0, 30)) && sq(t) !== head);
      const body = sq(moreMsgs.join(" "));
      if (body !== rest) whys.push("#301: the rest of the long answer did not arrive whole, once");
      // one second message when the answer went out at once; when Telegram refused the answer, the rest waited behind it in the outbox
      if (!s.secretsInError && moreMsgs.length !== 1) whys.push(`#301: the rest of a long answer came in ${moreMsgs.length} messages, want one`);
      if (!s.secretsInError && texts.filter((t) => !links.includes(t.trim())).length > 2) whys.push(`#301: ${texts.length - links.length} messages for one long answer, want at most 2`);
      const order = texts.map((t) => (links.includes(t.trim()) ? "L" : moreMsgs.includes(t) ? "M" : "H")).join("");
      if (!/^HM+L*$/.test(order)) whys.push(`#301: out of order (${order}: H the answer, M the rest, L the link)`);
      for (const l of links) if (!texts.includes(l)) whys.push("#301: the page link did not arrive alone");
    }
    whys.push(...w.bot.violations);
    rep.grade(s, whys, texts.map((t) => t.slice(0, 60)).join(" | "));
  }
  rep.assertClean();
} });

// ================================================================================================ 429
Deno.test({ name: "telegram battery: Telegram's 429 (retry_after honoured, never a message twice, every message in order)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("ratelimit");
  for (const s of SCENARIOS) {
    if (s.kind !== "ratelimit" || !only(s)) continue;
    let left = s.times;
    const chat = 100000 + s.id;
    const more = s.viaMore ? "The rest of the answer. It explains one more thing in plain words. And one more thing after that." : null;
    const w = world({ native: s.native, brain: () => ({ reply: s.viaMore ? "The short answer, first." : s.reply, ...(more ? { shape: { attachments: [], links: [], more: [more] } } : {}) }),
      fail: ({ method, body, nth }) => (method === "sendMessage" && String(body.chat_id) === String(chat) && nth === (s.viaMore ? 0 : s.failOn) + (s.times - left) && left > 0
        ? (left--, Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${s.retryAfter}`, parameters: { retry_after: s.retryAfter } }, { status: 429 })) : null) });
    w.known(chat);
    const want = s.viaMore ? ["The short answer, first.", more!] : w.adapters.telegram!.render(s.reply).map((b) => (s.native ? decode(b) : b));
    await w.text(chat, "tell me");
    for (let k = 0; k < 240 && w.W.outbox.some((o) => o.status === "queued" || (o.status === "failed" && o.retryAt !== null)); k++) { w.clock.t += 30000; await w.cron(); }
    const got = w.bot.to(chat).map(plainOf);
    const whys: string[] = [];
    for (const t of new Set(got)) if (got.filter((x) => x === t).length > want.filter((x) => x === t).length) whys.push("a message arrived twice");
    const prefix = got.every((g, i) => g === want[i]);
    if (!prefix) whys.push("the messages arrived out of order or changed");
    if (got.length !== want.length) {
      const honest = w.W.outbox.some((o) => o.status === "failed" && o.retryAt === null && /after \d+ of \d+/.test(o.error ?? ""));
      if (!(s.failOn > 0 && s.retryAfter > 30 && honest)) whys.push(`${got.length} of ${want.length} messages arrived (retry_after ${s.retryAfter} on message ${s.failOn + 1})`);
    }
    whys.push(...w.bot.violations);
    rep.grade(s, whys, JSON.stringify(w.W.outbox.map((o) => [o.key, o.status, o.error])).slice(0, 300));
  }
  rep.assertClean();
} });

Deno.test("telegram battery: the generator is seeded and deterministic (11,300 scenarios)", () => {
  eq(SCENARIOS.length, 11_300);
  eq(JSON.stringify(generate({ seed: 20261030 }).slice(0, 60)), JSON.stringify(SCENARIOS.slice(0, 60)), "the same seed, the same scenarios");
});
