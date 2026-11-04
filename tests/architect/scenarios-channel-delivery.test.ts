// Channel delivery at scale (2026-10-29): about 10,000 generated scenarios (tests/architect/scenarios/channel-delivery-
// generator.ts, seeded) through the real delivery code of every texting channel, with every expectation from how the
// scenario was built:
//   formatting  Telegram: parse mode HTML well formed (only b, i, s, code, pre; properly nested; nothing inside code; every
//               & < > escaped), no markdown left; WhatsApp: its own *bold* _italic_ ~strike~, no HTML, no "**", no "#"
//               headings, no tables, no [label](url); iMessage: plain text, no asterisks, headers, tables or backticks.
//               Each with CAREER_TEXTING_NATIVE on (the voice); with it off only what does not depend on the voice.
//   splitting   no part empty; Telegram and WhatsApp parts within 4,096 and the 1,500 the texting rule packs, iMessage
//               bubbles within 700 (a link alone may be longer: it is never cut); never inside a word, a link, an emoji
//               (a surrogate pair) or an HTML entity; every word of the reply read once, in order; only a token longer than
//               a whole message is cut, and its pieces join back.
//   links       every link exactly as written, whole, exactly once (never doubled by a markdown link, never eaten by a
//               longer link, never cut at its own bracket); on its own line (Telegram, WhatsApp) or its own bubble
//               (iMessage, for its preview card) where the product says so.
//   parts       a reply in parts (agent-chat's parts): any number, each within the outbox's 4,000, none empty, every word.
//   STOP        STOP / STOPALL / UNSUBSCRIBE (and CANCEL / END / QUIT on SMS) in any case, with what phones put around them,
//               is a STOP: recorded, answered only with the confirmation, never a model call; a message that merely
//               contains the word is a message. Every queued and later proactive message is skipped_opt_out, so is the
//               rest of an answer to a message sent before the STOP; an answer to a message sent after it still goes;
//               START resumes; another person is never touched.
//   buttons     Telegram callback data is sent exactly as made and within 64 bytes, or the button is left off; the
//               message always goes.
//   window      WhatsApp outside its 24-hour window: held, never sent; at most one template, only when configured, never
//               to a person who said STOP.
//   providers   a failure on any bubble in any way: retried only when nothing went out, never a bubble twice, the final
//               state honest (delivered, failed "after n of m", or the person's block recorded as their STOP).
//   inbound     a provider message delivered again runs once; two people's turns never cross.
// Run: deno test -A --no-check tests/architect/scenarios-channel-delivery.test.ts (no network, no database, no model).
import assertNode from "node:assert/strict";
import { generate, NOW, type Scenario } from "./scenarios/channel-delivery-generator.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import type { ChannelAdapter, DeliveryAdapter, InboundMessage } from "../../supabase/functions/_shared/channel_adapters.ts";
import { channelCommand, CHANNEL_REPLIES, deliverDue, memoryChannel, STOPPED_REPLY_NOTE } from "../../supabase/functions/_shared/channel.ts";
import { OUTBOX_CHARS } from "../../supabase/functions/_shared/conversation.ts";
import { type InboundStore, replyParts, runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import { parseTelegramUpdate, telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { parseWhatsAppBody, whatsappAdapter } from "../../supabase/functions/_shared/whatsapp.ts";
import { loopMessageAdapter } from "../../supabase/functions/_shared/loopmessage_adapter.ts";
import { imessageNativeRender } from "../../supabase/functions/_shared/channel_voice.ts";
import { toBubbles } from "../../supabase/functions/_shared/conversation.ts";
import { WHATSAPP_WINDOW_MS } from "../../supabase/functions/_shared/channel_adapters.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261029 });
const of = <K extends Scenario["kind"]>(k: K) => SCENARIOS.filter((s): s is Extract<Scenario, { kind: K }> => s.kind === k);

// ------------------------------------------------------------------------------------------------ the report
type Failure = { s: Scenario; got: string; why: string };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(s: Scenario, why: string | null, got = "") {
    this.total++;
    const k = s.category.split("/").slice(0, 2).join("/");
    this.byCat[k] = (this.byCat[k] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ s, got, why });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[channel-delivery] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    #${x.s.id} ${x.s.category}: ${x.why} | got ${JSON.stringify(x.got).slice(0, 240)} | input ${JSON.stringify("text" in x.s ? x.s.text : x.s).slice(0, 240)}`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | got ${JSON.stringify(xs[0].got).slice(0, 200)} | ${JSON.stringify("text" in xs[0].s ? xs[0].s.text : xs[0].s).slice(0, 200)}`).join(" || ");
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ helpers (the oracle)
const tokens = (s: string): string[] => s.match(/[\p{L}\p{N}]+/gu) ?? [];
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const astral = (s: string) => (s.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length;
const decode = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A link as a whole token: not glued to more link characters after it (a longer link that starts with it is another link).
const linkCount = (text: string, u: string) => (text.match(new RegExp(`(?<![A-Za-z0-9/])${esc(u)}(?=$|[\\s<>"'\`)\\].,;:!?…*_~])`, "g")) ?? []).length;
const withoutLinks = (text: string, urls: string[]) => [...urls].sort((a, b) => b.length - a.length).reduce((t, u) => t.replace(new RegExp(`${esc(u)}(?=$|[\\s<>"'\`)\\].,;:!?…*_~])`, "g"), " "), text);

// Telegram's HTML parse mode: only the tags the product writes, properly nested, nothing inside code, & < > escaped.
function telegramHtmlProblem(h: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([a-z]+)>|&(?:amp|lt|gt|quot);|[<>&]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h))) {
    if (m[0] === "<" || m[0] === ">") return `a raw "${m[0]}" outside a tag`;
    if (m[0] === "&") return "a raw & that is not an entity";
    if (m[0].startsWith("&")) continue;
    const tag = m[2];
    if (!["b", "i", "s", "code", "pre"].includes(tag)) return `tag <${tag}>`;
    if (m[1]) { if (stack.pop() !== tag) return `</${tag}> closes another tag`; continue; }
    if (stack.includes("code") || stack.includes("pre")) return `<${tag}> inside code`;
    stack.push(tag);
  }
  return stack.length ? `<${stack[stack.length - 1]}> never closed` : null;
}
// Markdown left in what a person reads (links taken out first: a link's "__" or "*" is the link's).
function markdownLeft(visible: string, mode: "plain" | "telegram" | "whatsapp"): string | null {
  for (const line of visible.split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return `a markdown heading: ${line.slice(0, 60)}`;
    if (/^\s*\|.*\|\s*$/.test(line)) return `a markdown table row: ${line.slice(0, 60)}`;
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return "a markdown rule";
  }
  if (/\]\(/.test(visible)) return "a markdown link's syntax";
  if (/~~/.test(visible)) return "~~";
  if (mode !== "whatsapp" && /\*\*|__(?=[\p{L}\p{N}])/u.test(visible)) return "**";
  if (mode === "whatsapp" && /\*\*/.test(visible)) return "** on WhatsApp";
  if (mode === "whatsapp" && /<\/?(?:b|i|s|code|pre)>/.test(visible)) return "HTML on WhatsApp";
  if (mode === "plain") {
    if (/`/.test(visible)) return "a backtick";
    const m = /(?:^|[^\p{L}\p{N}*_])([*_])(?=[^\s*_])[^*_\n]*?[^\s*_]\1(?![\p{L}\p{N}])/u.exec(visible);
    if (m) return `markdown emphasis: ${m[0].slice(0, 40)}`;
  }
  return null;
}
// The person's words in order; a token longer than a whole message may come in pieces that join back.
function wordsProblem(got: string[], want: string[], giant: string[]): string | null {
  let i = 0, j = 0;
  while (i < want.length) {
    if (got[j] === want[i]) { i++; j++; continue; }
    if (giant.some((g) => tokens(g).includes(want[i]))) {
      let acc = "";
      const start = j;
      while (j < got.length && acc.length < want[i].length && want[i].startsWith(acc + got[j])) acc += got[j++];
      if (acc === want[i]) { i++; continue; }
      j = start;
    }
    return `word ${i + 1} of ${want.length}: wanted ${JSON.stringify(want[i])}, read ${JSON.stringify(got.slice(Math.max(0, j - 2), j + 3))}`;
  }
  return j === got.length ? null : `extra words after the reply: ${JSON.stringify(got.slice(j, j + 5))}`;
}

const refuse = (async () => { throw new TypeError("network refused in the scenario run"); }) as unknown as typeof fetch;
const wiring = (native: boolean) => adaptersFromEnv({ get: (k: string) => ({ LOOPMESSAGE_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", WHATSAPP_TOKEN: "w", WHATSAPP_PHONE_NUMBER_ID: "1", CAREER_TEXTING_NATIVE: native ? "on" : "off" } as Record<string, string>)[k] }, { fetch: refuse, clock: () => NOW, sleep: async () => {} });
const WIRED = { true: wiring(true), false: wiring(false) };

// ------------------------------------------------------------------------------------------------ render + split
function gradeRender(rep: Report, s: Extract<Scenario, { kind: "render" | "split" }>) {
  const adapter = WIRED[String(s.native) as "true" | "false"][s.channel]!;
  // trainee-deliver renders iMessage itself (its LoopMessage send); it must be the adapter's rendering.
  const parts = adapter.render(s.text);
  if (s.channel === "imessage") {
    const handler = s.native ? imessageNativeRender(s.text) : toBubbles(s.text);
    if (JSON.stringify(handler) !== JSON.stringify(parts)) return rep.grade(s, "trainee-deliver's iMessage rendering is not the adapter's", JSON.stringify(handler).slice(0, 200));
  }
  const html = s.channel === "telegram" && s.native;
  const visible = parts.map((p) => (html ? decode(p) : p));
  const all = visible.join("\n");
  const fail = (why: string, got = all) => rep.grade(s, why, got);
  if (!parts.length) return fail("nothing to send");
  for (const [k, p] of parts.entries()) {
    if (!p.trim() || !visible[k].trim()) return fail(`part ${k + 1} is empty`, p);
    if (LONE.test(p)) return fail(`part ${k + 1} has half an emoji (a lone surrogate)`, p.slice(0, 120));
    if (html) { const bad = telegramHtmlProblem(p); if (bad) return fail(`part ${k + 1}: Telegram HTML: ${bad}`, p); }
    const max = s.channel === "imessage" ? 700 : 1500, hard = s.channel === "imessage" ? 5000 : 4096;
    if (p.length > hard) return fail(`part ${k + 1} is ${p.length} characters, over the platform's ${hard}`, p.slice(0, 80));
    if (visible[k].length > max && !s.urls.includes(visible[k].trim())) return fail(`part ${k + 1} is ${visible[k].length} characters (texting size ${max}) and not a link alone`, visible[k].slice(0, 120));
  }
  for (const u of s.urls) {
    const want = s.native || s.channel === "imessage" ? 1 : linkCount(s.text, u);
    const n = linkCount(all, u);
    if (n !== want) return fail(n === 0 ? `link altered, cut or lost: ${u}` : `link ${u} sent ${n} times (wanted ${want})`);
  }
  if (s.native && s.channel !== "imessage") {
    for (const u of s.urls) if (!visible.some((v) => v.split("\n").some((l) => l.trim() === u))) return fail(`link not on its own line: ${u}`);
  }
  if (s.channel === "imessage" && s.urls.length <= 2) {
    for (const u of s.urls) if (!visible.some((v) => v.trim() === u)) return fail(`link not alone in its bubble (its preview card): ${u}`, JSON.stringify(visible).slice(0, 300));
  }
  const rest = withoutLinks(all, s.urls);
  if (s.native) { const left = markdownLeft(rest, s.channel === "telegram" ? "telegram" : s.channel === "whatsapp" ? "whatsapp" : "plain"); if (left) return fail(`markdown leaked: ${left}`); }
  const w = wordsProblem(tokens(rest), s.native ? s.words : s.rawWords, s.giant);
  if (w) return fail(w);
  if (astral(rest) !== s.astral) return fail(`emoji: ${astral(rest)} read, ${s.astral} written`);
  rep.grade(s, null);
}

Deno.test(`channel delivery at scale, formatting and links on every channel (render): ${of("render").length} scenarios`, () => {
  const rep = new Report("render");
  for (const s of of("render")) gradeRender(rep, s);
  rep.assertClean();
});
Deno.test(`channel delivery at scale, long replies split at natural boundaries (split): ${of("split").length} scenarios`, () => {
  const rep = new Report("split");
  for (const s of of("split")) gradeRender(rep, s);
  rep.assertClean();
});

Deno.test(`channel delivery at scale, a reply in parts of any length (parts): ${of("parts").length} scenarios`, () => {
  const rep = new Report("parts");
  for (const s of of("parts")) {
    const got = replyParts(s.parts);
    const usable = s.parts.filter((p) => p.trim());
    if (usable.length < 2) { rep.grade(s, got === null ? null : "fewer than two usable parts must be the single reply", JSON.stringify(got)); continue; }
    if (!got) { rep.grade(s, "parts dropped"); continue; }
    const bad = got.findIndex((p) => !p.trim() || LONE.test(p) || (p.length > OUTBOX_CHARS && !/^https?:\/\/\S+$/.test(p.trim())));
    if (bad >= 0) { rep.grade(s, `part ${bad + 1} is empty, over ${OUTBOX_CHARS} or cut inside a character (${got[bad].length})`, got[bad].slice(0, 80)); continue; }
    if (got.length < usable.length) { rep.grade(s, `${usable.length} parts became ${got.length}`); continue; }
    const w = wordsProblem(tokens(got.join(" ").replace(/https?:\/\/\S+/g, " ")), s.words, []);
    rep.grade(s, w, got.length + " parts");
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ STOP, START, HELP
interface MemInbound extends InboundStore { optOuts: { contact: string; out: boolean; at: number }[]; rows: { userId: string; key: string; text: string }[] }
function memInbound(known: Record<string, string>): MemInbound {
  const claimed = new Set<string>(), people = new Map(Object.entries(known).map(([c, u]) => [c, { userId: u, threadId: null as string | null, contact: c }]));
  const st: MemInbound = {
    optOuts: [], rows: [],
    async claimMessage(id, _at, provider) { const k = `${provider ?? "loopmessage"}|${id}`; if (claimed.has(k)) return false; claimed.add(k); return true; },
    async person(c) { return people.get(c) ?? null; },
    async refusedBefore() { return false; },
    async createPerson(c) { const p = { userId: `new-${c}`, threadId: null, contact: c }; people.set(c, p); return p; },
    async setThread() {},
    async setOptOut(contact, out, at) { st.optOuts.push({ contact, out, at }); },
    async enqueueReply(userId, key, text) { if (st.rows.some((r) => r.userId === userId && r.key === key)) return false; st.rows.push({ userId, key, text }); return true; },
  };
  return st;
}
const addressOfCh = (ch: string, n: number) => (ch === "telegram" ? `tg:${700000 + n}` : ch === "whatsapp" ? `wa:1555${String(1000000 + n)}` : `+1555${String(2000000 + n)}`);
function inboundMsg(ch: "telegram" | "whatsapp" | "imessage", contact: string, text: string, id: string): InboundMessage {
  if (ch === "telegram") return parseTelegramUpdate({ update_id: Number(id), message: { message_id: 1, chat: { id: Number(contact.slice(3)), type: "private" }, from: { id: Number(contact.slice(3)), is_bot: false }, text } }).message!;
  if (ch === "whatsapp") {
    const wa = contact.slice(3);
    return parseWhatsAppBody({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, contacts: [{ wa_id: wa }], messages: [{ id: `wamid.${id}`, from: wa, type: "text", text: { body: text } }] } }] }] }, "1").messages[0];
  }
  return { provider: "loopmessage", channel: "imessage", messageId: id, kind: "text", contact, address: contact, phone: contact, text, replyToMessageId: null };
}

Deno.test(`channel delivery at scale, STOP / START / HELP read from what people text (command): ${of("command").length} scenarios`, async () => {
  const rep = new Report("command");
  let n = 0;
  for (const s of of("command")) {
    const got = channelCommand(s.text, s.channel);
    if (got !== s.expect) { rep.grade(s, `read as ${got ?? "a message"}, must be ${s.expect ?? "a message"}`, String(got)); continue; }
    if (s.channel === undefined || s.channel === "sms" || n++ % 3) { rep.grade(s, null); continue; }
    // The whole inbound path for this text: the command is answered with its fixed words and never reaches the model.
    const contact = addressOfCh(s.channel, s.id), known = s.id % 4 !== 0;
    const store = memInbound(known ? { [contact]: `user-${s.id}` } : {});
    const chats: string[] = [], replies: string[][] = [];
    const msg = inboundMsg(s.channel, contact, s.text, String(100000 + s.id));
    const r = await runInbound(msg, {
      env: { get: (k: string) => (k === "TRAINEE_SIGNUP" ? "open" : undefined) }, now: () => NOW, store, render: (t) => [t],
      reply: async (_c, b) => { replies.push(b); return { ok: true }; },
      chat: async (a) => { chats.push(a.message); return { status: 200, reply: `answer for ${a.userId}`, threadId: null }; },
      deliver: async () => {},
    });
    let why: string | null = null;
    if (r.status !== 200) why = `inbound answered ${r.status}`;
    else if (s.expect === "stop" || s.expect === "start" || (s.expect === "help" && !known)) {
      if (chats.length) why = `a ${s.expect} reached the model`;
      else if (JSON.stringify(replies) !== JSON.stringify([[CHANNEL_REPLIES[s.expect]]])) why = `the answer to ${s.expect} must be only its confirmation`;
      else if (s.expect !== "help" && JSON.stringify(store.optOuts.map((o) => [o.contact, o.out])) !== JSON.stringify([[contact, s.expect === "stop"]])) why = `the opt-out was not recorded for this contact: ${JSON.stringify(store.optOuts)}`;
      else if (store.rows.length) why = "a command queued a message";
    } else {
      if (chats.length !== 1) why = `a message must be one turn (${chats.length})`;
      else if (store.optOuts.length) why = "a message changed the opt-out";
    }
    rep.grade(s, why, JSON.stringify({ chats, replies, optOuts: store.optOuts }).slice(0, 200));
  }
  rep.assertClean();
});

Deno.test("Telegram's own commands: /stop, /STOP@bot and /stop with words are a STOP, never a turn", async () => {
  for (const text of ["/stop", "/STOP", "/stop@TraineeBot", "/stop now"]) {
    const store = memInbound({ "tg:777": "u-777" }), chats: string[] = [], replies: string[][] = [];
    await runInbound(inboundMsg("telegram", "tg:777", text, "424242"), { env: { get: () => undefined }, now: () => NOW, store, render: (t) => [t],
      reply: async (_c, b) => { replies.push(b); return { ok: true }; }, chat: async (a) => { chats.push(a.message); return { status: 200, reply: "x", threadId: null }; }, deliver: async () => {} });
    eq([chats.length, replies, store.optOuts.map((o) => o.out)], [0, [[CHANNEL_REPLIES.stop]], [true]], text);
  }
});

// What a person's queued messages do around their STOP (deliverDue over the memory store, a recording adapter per channel).
function recorder(channel: "telegram" | "whatsapp" | "imessage") {
  const sent: { address: string; bubbles: string[] }[] = [];
  const adapter: DeliveryAdapter = { channel, limits: channel === "whatsapp" ? { windowMs: WHATSAPP_WINDOW_MS } : {}, render: (t) => [t],
    send: async (address, bubbles) => { sent.push({ address, bubbles }); return { ok: true, id: `p${sent.length}` }; } };
  return { sent, adapter };
}
Deno.test(`channel delivery at scale, every queued and later proactive message held by STOP, START resumes (optout): ${of("optout").length} scenarios`, async () => {
  const rep = new Report("optout");
  for (const s of of("optout")) {
    const contact = addressOfCh(s.channel, s.id), other = addressOfCh(s.channel, s.id + 500000);
    const store = memoryChannel();
    const seen = s.channel === "whatsapp" ? { lastInboundAt: NOW - 3600000 } : {};
    s.rows.forEach((r, i) => store.queue({ id: `${s.id}-${i}`, userId: `u${s.id}`, contact, key: r.key, text: `${r.key} for ${contact}`, deliver_at: r.at, attempts: 0, ...seen }));
    store.queue({ id: `${s.id}-other`, userId: `o${s.id}`, contact: other, key: `alert:${s.id}-other`, text: `alert for ${other}`, deliver_at: NOW - 1000, attempts: 0, ...seen });
    await store.setOptOut(contact, true, s.stopAt);
    const { sent, adapter } = recorder(s.channel);
    await deliverDue({ store, adapters: { [s.channel]: adapter }, now: NOW });
    const rows = store.rows();
    let why: string | null = null;
    for (const [i, r] of s.rows.entries()) {
      const row = rows.find((x) => x.id === `${s.id}-${i}`)!;
      const want = r.proactive || r.at < s.stopAt ? "skipped_opt_out" : "delivered";
      if (row.status !== want) { why = `${r.key} queued ${r.at < s.stopAt ? "before" : "after"} STOP is ${row.status}, must be ${want}`; break; }
      if (!r.proactive && r.at < s.stopAt && row.error !== STOPPED_REPLY_NOTE) { why = `${r.key}: not said why it was not sent`; break; }
    }
    if (!why && rows.find((x) => x.id === `${s.id}-other`)!.status !== "delivered") why = "another person's alert was held by this person's STOP";
    if (!why && sent.some((x) => x.bubbles.join(" ").includes(contact) && x.address !== contact.replace(/^(tg|wa):/, ""))) why = "a message went to another contact";
    if (!why && s.startAt) {
      await store.setOptOut(contact, false, s.startAt);
      store.queue({ id: `${s.id}-after`, userId: `u${s.id}`, contact, key: `digest:${s.id}-after`, text: "after START", deliver_at: s.startAt, attempts: 0, ...seen });
      await deliverDue({ store, adapters: { [s.channel]: adapter }, now: s.startAt + 1000 });
      if (store.rows().find((x) => x.id === `${s.id}-after`)!.status !== "delivered") why = "START did not resume proactive messages";
    }
    rep.grade(s, why, JSON.stringify(store.rows().map((x) => [x.key, x.status])).slice(0, 200));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ Telegram buttons
Deno.test(`channel delivery at scale, Telegram buttons within 64 bytes and never cut (buttons): ${of("buttons").length} scenarios`, async () => {
  const rep = new Report("buttons");
  for (const s of of("buttons")) {
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true, result: { message_id: bodies.length } }), { status: 200 }); }) as unknown as typeof fetch;
    const a = telegramAdapter({ token: "t", fetch: f, sleep: async () => {}, clock: () => NOW });
    const r = await a.send("42", ["Your card"], { buttons: s.buttons });
    const kb = bodies[0]?.reply_markup?.inline_keyboard ?? [];
    const sentData: string[] = kb.flat().map((b: any) => b.callback_data);
    const wantData = s.buttons.flatMap((row, i) => row.filter((_, j) => s.valid[i][j]).map((b) => b.data));
    let why: string | null = null;
    if (!r.ok || bodies.length !== 1) why = "the message did not go";
    else if (sentData.some((d) => typeof d !== "string" || !d || new TextEncoder().encode(d).length > 64)) why = "callback data over 64 bytes or empty";
    else if (JSON.stringify(sentData) !== JSON.stringify(wantData)) why = "a button's data was cut, or a good button left off";
    else if (kb.flat().some((b: any) => LONE.test(b.text) || [...b.text].length > 64)) why = "a label cut inside a character";
    rep.grade(s, why, JSON.stringify(sentData).slice(0, 200));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ WhatsApp's window
Deno.test(`channel delivery at scale, WhatsApp's 24-hour window and its template (window): ${of("window").length} scenarios`, async () => {
  const rep = new Report("window");
  for (const s of of("window")) {
    const contact = `wa:1555${3000000 + s.id}`, last = s.lastInboundAgoMs === null ? null : NOW - s.lastInboundAgoMs;
    const store = memoryChannel();
    if (s.nudgedAgoMs !== null) await store.setNudged!(contact, NOW - s.nudgedAgoMs);
    if (s.optedOut) await store.setOptOut(contact, true, NOW - 7200000);
    s.rows.forEach((r, i) => store.queue({ id: `${s.id}-${i}`, userId: `u${s.id}`, contact, key: r.key, text: `message ${i}`, deliver_at: NOW - 60000 + i, attempts: 0, lastInboundAt: last }));
    const texts: any[] = [], templates: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (b.type === "template") { templates.push(b); return new Response(JSON.stringify({ messages: [{ id: `wamid.t${templates.length}` }] }), { status: 200 }); }
      texts.push(b);
      if (s.sendFailCode !== null) return new Response(JSON.stringify({ error: { code: s.sendFailCode, message: "refused" } }), { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.m${texts.length}` }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = whatsappAdapter({ token: "w", phoneNumberId: "1", fetch: f, sleep: async () => {}, clock: () => NOW, template: s.template ? { name: "updates_waiting", language: "en_US" } : null });
    await deliverDue({ store, adapters: { whatsapp: a }, now: NOW });
    const open = last !== null && NOW - last < WHATSAPP_WINDOW_MS;
    const rows = store.rows();
    let why: string | null = null, stalled = false, held = 0;
    for (const [i, r] of s.rows.entries()) {
      const row = rows.find((x) => x.id === `${s.id}-${i}`)!;
      let want: string;
      if (s.optedOut && !r.reply) want = "skipped_opt_out";
      else if (r.reply && stalled) want = "queued";
      else if (!open) want = "held";
      else if (s.sendFailCode === 131047 || s.sendFailCode === 131049) want = "held";
      else if (s.sendFailCode === 131056) want = "failed";
      else want = "delivered";
      if (r.reply && (want === "held" || want === "failed")) stalled = true;
      if (want === "held") held++;
      if (row.status !== want) { why = `${r.key} (${r.reply ? "an answer" : "proactive"}, window ${open ? "open" : "closed"}) is ${row.status}, must be ${want}`; break; }
    }
    const lastIn = last, nudged = s.nudgedAgoMs === null ? null : NOW - s.nudgedAgoMs;
    const mayNudge = held > 0 && s.template && !s.optedOut && (nudged === null || (lastIn !== null && nudged < lastIn));
    if (!why && !open && texts.length) why = "a message was sent outside the window";
    if (!why && templates.length > 1) why = `${templates.length} templates to one person`;
    if (!why && templates.length !== (mayNudge ? 1 : 0)) why = `template ${templates.length ? "sent" : "not sent"} (configured ${s.template}, opted out ${s.optedOut}, held ${held}, nudged ${s.nudgedAgoMs})`;
    rep.grade(s, why, JSON.stringify(rows.map((x) => [x.key, x.status])).slice(0, 200));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ provider failures
const RETRY_FIRST: Record<string, Set<string>> = {
  imessage: new Set(["429", "502", "503", "network"]), telegram: new Set(["429", "502", "503", "network"]), whatsapp: new Set(["429", "502", "503", "network"]),
};
Deno.test(`channel delivery at scale, provider failures retried only when nothing went out, never twice (provider): ${of("provider").length} scenarios`, async () => {
  const rep = new Report("provider");
  for (const s of of("provider")) {
    const bubbles = Array.from({ length: s.bubbles }, (_, i) => `bubble ${i + 1} of ${s.id}`);
    const out = new Map<string, number>(); // bubble -> times it may have reached the person
    let failed = false;
    const respond = (text: string) => {
      const i = bubbles.indexOf(text);
      if (!failed && i === s.failAt && s.mode !== "ok") {
        failed = true;
        if (s.mode === "network") throw new TypeError("connection refused");
        if (s.mode === "timeout") { out.set(text, (out.get(text) ?? 0) + 1); throw new DOMException("timed out", "TimeoutError"); }
        const status = Number(s.mode);
        if (status === 500 || status === 504) out.set(text, (out.get(text) ?? 0) + 1);
        const body = s.channel === "telegram" ? { ok: false, description: status === 403 ? "Forbidden: bot was blocked by the user" : "error" } : s.channel === "whatsapp" ? { error: { code: status, message: "error" } } : { success: false };
        return new Response(JSON.stringify(body), { status });
      }
      out.set(text, (out.get(text) ?? 0) + 1);
      const body = s.channel === "telegram" ? { ok: true, result: { message_id: out.size } } : s.channel === "whatsapp" ? { messages: [{ id: `wamid.${out.size}` }] } : { message_id: `lm-${out.size}` };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      return respond(s.channel === "telegram" ? b.text : s.channel === "whatsapp" ? b.text.body : b.text);
    }) as unknown as typeof fetch;
    const base: ChannelAdapter = s.channel === "telegram" ? telegramAdapter({ token: "t", fetch: f, sleep: async () => {}, clock: () => NOW })
      : s.channel === "whatsapp" ? whatsappAdapter({ token: "w", phoneNumberId: "1", fetch: f, sleep: async () => {}, clock: () => NOW })
      : loopMessageAdapter({ apiKey: "k", fetch: f, sleep: async () => {} });
    const adapter = { ...base, render: () => bubbles };
    const contact = s.channel === "telegram" ? `tg:${800000 + s.id}` : s.channel === "whatsapp" ? `wa:1555${4000000 + s.id}` : `+1555${5000000 + s.id}`;
    const store = memoryChannel([{ id: `p${s.id}`, userId: `u${s.id}`, contact, key: s.reply ? `reply:p${s.id}` : `status:p${s.id}`, text: "x", deliver_at: NOW - 1000, attempts: 0, ...(s.channel === "whatsapp" ? { lastInboundAt: NOW - 60000 } : {}) }]);
    for (const t of [NOW, NOW + 2 * 60000, NOW + 10 * 60000, NOW + 60 * 60000]) await deliverDue({ store, adapters: { [s.channel]: adapter }, now: t });
    const row = store.rows()[0];
    let why: string | null = null;
    const twice = [...out.entries()].find(([, n]) => n > 1);
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): a failure that certainly sent nothing of its bubble (429, 502, 503, a connection
    // that never opened) is retried on any bubble, from that bubble (career_outbox.sent_parts): it must then end delivered
    // with every bubble exactly once. It was final after the first bubble ("after n of m"), the rest never sent.
    // TELEGRAM ROUND 3 (2026-10-31): a Telegram timeout on a bubble that is not the last counts that bubble as sent (it most
    // likely went) and the rest goes again from the next: delivered, every bubble once. On the last bubble it stays final.
    const retryable = s.mode !== "ok" && (RETRY_FIRST[s.channel].has(s.mode) || (s.channel === "telegram" && s.mode === "timeout" && s.failAt < s.bubbles - 1));
    const blocked = s.channel === "telegram" && s.mode === "403";
    if (twice) why = `"${twice[0]}" may have reached the person ${twice[1]} times`;
    else if (s.mode === "ok" || retryable) { if (row.status !== "delivered" || bubbles.some((b) => out.get(b) !== 1)) why = `must end delivered, every bubble once (status ${row.status})`; }
    else if (blocked) { if (row.status !== "skipped_opt_out" || !store.optOuts().includes(contact)) why = `a block is the person's STOP (status ${row.status})`; }
    else if (row.status !== "failed" || row.retryAt !== null) why = `a failure that may have gone out must be final, never retried (status ${row.status}, retry ${row.retryAt})`;
    else if (s.failAt > 0 && !/after \d+ of \d+/.test(row.error ?? "")) why = `the failure must say how many went out: ${row.error}`;
    rep.grade(s, why, `${s.mode} at ${s.failAt}: ${row.status} ${row.error ?? ""}`);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ inbound dedupe
Deno.test(`channel delivery at scale, a webhook delivered again runs once and people never cross (inbound): ${of("inbound").length} scenarios`, async () => {
  const rep = new Report("inbound");
  for (const s of of("inbound")) {
    const contacts = Array.from({ length: s.people }, (_, i) => addressOfCh(s.channel, s.id * 10 + i));
    const store = memInbound(Object.fromEntries(contacts.map((c, i) => [c, `user-${s.id}-${i}`])));
    const chats: { userId: string; message: string }[] = [];
    const deps = {
      env: { get: (k: string) => (k === "TRAINEE_SIGNUP" ? "open" : undefined) }, now: () => NOW, store, render: (t: string) => [t],
      reply: async () => ({ ok: true }), deliver: async () => {},
      chat: async (a: { userId: string; message: string }) => { chats.push(a); return { status: 200, reply: `for ${a.userId} about ${a.message}`, threadId: null }; },
    };
    for (let d = 0; d < s.deliveries; d++) for (const [i, c] of contacts.entries()) await runInbound(inboundMsg(s.channel, c, `hello from ${i}`, String(s.id * 100 + i)), deps);
    if (s.sameIdOtherProvider && s.channel !== "imessage") await runInbound(inboundMsg("imessage", "+15550009999", "other provider", String(s.id * 100)), deps);
    let why: string | null = null;
    const expected = s.people + (s.sameIdOtherProvider && s.channel !== "imessage" ? 1 : 0);
    if (chats.length !== expected) why = `${chats.length} turns for ${expected} messages (delivered ${s.deliveries} times)`;
    else if (store.rows.length !== expected) why = `${store.rows.length} answers queued for ${expected} messages`;
    else if (store.rows.some((r) => !r.text.startsWith(`for ${r.userId} `))) why = "an answer was queued for another person";
    rep.grade(s, why, JSON.stringify(store.rows).slice(0, 200));
  }
  rep.assertClean();
});

Deno.test("the battery is about 10,000 scenarios", () => {
  if (SCENARIOS.length < 9500) throw new Error(`only ${SCENARIOS.length} scenarios`);
  console.log(`[channel-delivery] ${SCENARIOS.length} scenarios: ${[...new Set(SCENARIOS.map((s) => s.kind))].map((k) => `${k} ${SCENARIOS.filter((s) => s.kind === k).length}`).join(", ")}`);
});
