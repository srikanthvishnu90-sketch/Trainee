// The Telegram chat flow, round 2 (architect, 2026-10-30; round 1: scenarios-telegram.test.ts, #311): 10,000 generated
// scenarios (tests/architect/scenarios/telegram-r2-generator.ts, seed 20261031) through the real Telegram webhook, composed
// exactly as trainee-telegram/handler.ts composes it with the service client (webhookDeps; the resume file through
// ingestResumeFile over the adapter's getFile; job cards and taps through sendJobCards / tapJob over memory stores), the
// real inbound core (channel_inbound.ts), the real delivery run (channel.ts deliverDue over channel_memory.ts) and a fake Bot
// API (scenarios/telegram-bot-api.ts, plus getFile, the file download and the keyboard limits). No network, no model, no
// database, no wall clock: the clock is the scenario's. What must hold, from how each scenario was built:
//   conv    per update: exactly one model turn reading exactly the words it should (a forwarded post framed as someone
//           else's words, an "Apply here" link with its URL, the caption of a photo), with exactly one answer; or exactly
//           the fixed answer; or deliberately nothing (an edit, a sticker, a GIF, a dice, an update sent again). A forwarded
//           "STOP", "yes" or "/start <code>" is never the person's command. STOP and START hold the next day's alert.
//           Two people at once never read each other's answers.
//   long    4,001-4,096 characters: the brain reads a whole-word prefix of at most 4,000 characters, never half a
//           character, and the answer says where reading stopped.
//   api     topics answered once; taps on old messages answered once, approving only the payload on file now; keyboards
//           at most 8 a row and 100 in all; captions at most 1,024; a logo Telegram cannot fetch: the card as text, once;
//           "can't parse entities": sent again as plain text, once, word for word; a job page whose escaping outgrows
//           4,096 arrives whole (the payload is shown whole before Confirm); 403 blocked / deactivated: the person's STOP,
//           recorded, never called again; "chat not found": failed honestly, not retried; groups (migrated or not):
//           nothing; a file over what a bot may download: "too large", never "send it again in a minute".
//   lang    Spanish, Hindi, Arabic: the words reach the brain exactly; every word and link of the answer arrives; every
//           message valid for Telegram; "parar", "रुको", "توقف" are words, STOP is STOP.
// Every scenario: no Bot API refusal (the fake refuses what Telegram refuses, and records it), nothing to a group, no
// token or secret in a response.
// Run: deno test -A --no-check tests/architect/scenarios-telegram-r2.test.ts   (TG2_ONLY=12,34 runs those scenarios alone)
import assertNode from "node:assert/strict";
import { type ApiScenario, type ConvScenario, generate, type LangScenario, type LongScenario, NOW, ORIGINS, originName, rng, type Scenario, type Step } from "./scenarios/telegram-r2-generator.ts";
import { resumeFile } from "./scenarios/onboarding-r2-generator.ts";
import { jobSenderFor, webhookDeps } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleChannelWebhook, PHONE_ALREADY_REPLY, PHONE_NOT_YOURS_REPLY, PHOTO_NOT_READ_REPLY, SHARE_PHONE_ASK, TELEGRAM_LINK_REPLY, VOICE_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { textingNativeOn } from "../../supabase/functions/_shared/channel_voice.ts";
import { hashTag, type JobDeps, type JobStore, type PostingRow, type PreparedRow, refOf, sendJobCards, tapJob } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { tapCard, type TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { addressOf } from "../../supabase/functions/_shared/channel_adapters.ts";
import { FILE_EMPTY_REPLY, FILE_KIND_REPLY, FILE_TOO_BIG_REPLY, ingestResumeFile } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { fakeBot as botApi, LONE, type Msg, plainOf } from "./scenarios/telegram-bot-api.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261031 });
const ONLY = new Set((Deno.env.get("TG2_ONLY") ?? "").split(",").filter(Boolean).map(Number));
const only = (s: Scenario) => !ONLY.size || ONLY.has(s.id);
// Built at run time: no key-shaped string sits in the repository (tests/no-secrets.test.cjs).
const TOKEN = ["654321", "TEST-tg2-bot-token-not-real"].join(":"), SECRET = ["TEST", "tg2", "webhook", "secret", "0123456789abcdefghij"].join("_");
const LOGIN_URL = "https://trainee.test/telegram-link.html";
const ALLOWED_PHONE = (chat: number) => `+1555${String(chat).slice(-7)}`;
const MIN = 60000;

// ------------------------------------------------------------------------------------------------ the report
const BUCKETS: [string, RegExp][] = [
  ["forwarded words taken as the person's command, yes or link", /\(forward\).*(opted out|said \[|want nothing)|forward.*opted out is true|opted out is true, want false/],
  ["forwarded post read as the person's own words", /\(forward\)/],
  ["caption of a photo / video / GIF dropped", /\(caption:/],
  ["a GIF read as a resume file", /animation|gif-doc/],
  ["\"Apply here\" link (text_link) lost", /\(applyhere\)/],
  ["message over 4,000 cut silently / half a character", /^long\/|\(long\)/],
  ["file over the download limit: \"send it again\"", /huge-unsaid|over what a bot may download/],
  ["escaped job page cut at 4,096 (payload not shown whole before Confirm)", /^api\/escape/],
  ["403 on a direct answer not recorded", /^api\/blocked/],
];
type Failure = { s: Scenario; why: string };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(s: Scenario, whys: string[]) {
    this.total++;
    const k = s.category.split("/").slice(0, 2).join("/");
    this.byCat[k] = (this.byCat[k] ?? 0) + 1;
    for (const why of [...new Set(whys)].slice(0, 4)) {
      const key = `${s.category.split("/")[0]}/${s.category.split("/")[1]}: ${why.replace(/^second person: /, "").replace(/step \d+ /g, "").replace(/[0-9a-f]{12,}|\d{3,}/g, "#").replace(/«#»|«\d+»/g, "«n»").slice(0, 110)}`;
      if (!this.failures.has(key)) this.failures.set(key, []);
      this.failures.get(key)!.push({ s, why });
    }
  }
  assertClean() {
    const failed = new Set([...this.failures.values()].flat().map((f) => f.s.id)).size;
    const lines = [`[telegram-r2] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failed`];
    // Failing scenarios by the rule they broke (a scenario may break several).
    const by = new Map<string, Set<number>>();
    for (const f of [...this.failures.values()].flat()) {
      const b = BUCKETS.find(([, re]) => re.test(`${f.s.category} ${f.why}`))?.[0] ?? "other";
      if (!by.has(b)) by.set(b, new Set());
      by.get(b)!.add(f.s.id);
    }
    if (by.size) lines.push(`  by rule: ${[...by.entries()].map(([k, v]) => `${k} ${v.size}`).join(", ")}`);
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 2)) lines.push(`    #${x.s.id} ${x.s.category}: ${x.why.slice(0, 400)}`);
    }
    console.log(lines.join("\n"));
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${[...this.failures.keys()].slice(0, 8).join(" || ")}`);
  }
}

// ------------------------------------------------------------------------------------------------ the Bot API
// Round 1's fake (it refuses what Telegram refuses), plus what round 2 needs: getFile and the file download (a file of any
// size, a 400 "file is too big", a stream that runs past what getFile said), and the inline keyboard's limits (at most 8
// buttons a row, 100 in all: Telegram refuses the whole message, "Bad Request: reply markup is too long").
type FileSpec = { bytes: Uint8Array | null; size: number | null; getFile: "ok" | "too-big-400" | "stream-over" };
type Fail = Parameters<typeof botApi>[0]["fail"];
function bot(o: { clock: { t: number }; fail?: Fail }) {
  const b = botApi({ token: TOKEN, now: () => o.clock.t, fail: o.fail });
  const files = new Map<string, FileSpec>();
  const fileCalls: string[] = [];
  const limits: string[] = [];
  const fetchFake: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as string, init);
    const u = new URL(req.url);
    if (u.host !== "api.telegram.org") throw new TypeError(`network refused: ${u.host}`);
    if (u.pathname === `/bot${TOKEN}/getFile`) {
      const id = String((await req.json()).file_id ?? ""), f = files.get(id);
      fileCalls.push(`getFile ${id}`);
      if (!f) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
      if (f.getFile === "too-big-400") return Response.json({ ok: false, error_code: 400, description: "Bad Request: file is too big" }, { status: 400 });
      const size = f.getFile === "stream-over" ? 1000 : f.size ?? (f.bytes ? f.bytes.length : 25 * 1024 * 1024);
      return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u${id}`, file_size: size, file_path: `documents/${id}.bin` } });
    }
    if (u.pathname.startsWith(`/file/bot${TOKEN}/documents/`)) {
      const id = decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.bin$/, "")), f = files.get(id);
      fileCalls.push(`download ${id}`);
      if (!f) return new Response("not found", { status: 404 });
      if (f.bytes && f.getFile === "ok") return new Response(f.bytes as BodyInit);
      // a stream that runs on: 64 KB chunks, past any cap (the reader must stop it)
      let sent = 0;
      return new Response(new ReadableStream({ pull(c) { if (sent > 12 * 1024 * 1024) { c.close(); return; } sent += 65536; c.enqueue(new Uint8Array(65536)); } }));
    }
    const raw = await req.text();
    const method = u.pathname.split("/").pop()!;
    let body: any = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* multipart (sendDocument) */ }
    const rows = body?.reply_markup?.inline_keyboard;
    if (Array.isArray(rows)) {
      const n = rows.flat().length, wide = rows.find((r: unknown[]) => r.length > 8);
      if (n > 100 || wide) {
        limits.push(`an inline keyboard of ${n} buttons${wide ? ` (a row of ${wide.length})` : ""} in a ${method}`);
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: reply markup is too long" }, { status: 400 });
      }
    }
    return await b.fetch(new Request(req.url, { method: req.method, headers: req.headers, body: raw }));
  }) as typeof fetch;
  return { ...b, fetch: fetchFake, files, fileCalls, limits, problems: () => [...b.violations, ...limits] };
}

// ------------------------------------------------------------------------------------------------ the jobs' memory stores (as round 1's)
type Prep = PreparedRow & { userId: string };
function jobStores() {
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
  return { store, cards, tap, rows, preps, applied, approvals };
}

// ------------------------------------------------------------------------------------------------ one world
type Turn = { userId: string; message: string; replyTo: string | null; n: number };
function world(o: { native?: boolean; env?: Record<string, string | undefined>; fail?: Fail; replies?: (a: { message: string; n: number }) => Record<string, unknown> } = {}) {
  const W = memoryChannelWorld();
  const clock = { t: NOW };
  const B = bot({ clock, fail: o.fail });
  const vars: Record<string, string | undefined> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeR2Bot", TRAINEE_SIGNUP: "open",
    ...(o.native ? { CAREER_TEXTING_NATIVE: "on" } : {}), ...o.env };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  const adapters = adaptersFromEnv(env, { fetch: B.fetch, clock: () => clock.t, sleep });
  const turns: Turn[] = [];
  let n = 0;
  const chat = async (a: any) => {
    const k = ++n;
    turns.push({ userId: a.userId, message: a.message, replyTo: a.replyToMessageId ?? null, n: k });
    if (!String(a.message ?? "").trim()) throw new Error("agent-chat HTTP 400");
    return { status: 200, threadId: `t-${a.userId}`, reply: `«${k}» ok`, ...(o.replies ? o.replies({ message: a.message, n: k }) : {}) } as any;
  };
  const deliver = async (a: { userId: string; key: string; now: number }) => {
    const s = W.delivery({ only: { userId: a.userId, key: a.key } });
    const r = await deliverDue({ store: s, adapters, now: a.now }); await s.release(); return r;
  };
  const cron = async () => { const s = W.delivery(); const r = await deliverDue({ store: s, adapters, now: clock.t, limit: 100 }); await s.release(); return r; };
  // The webhook's adapter, built as handleTelegram builds it from the secrets (the texting voice when CAREER_TEXTING_NATIVE is on).
  const adapterOf = (e: { get(k: string): string | undefined }) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "",
    fetch: B.fetch, clock: () => clock.t, sleep, native: textingNativeOn(e) });
  const pd = { env, now: () => clock.t, store: () => W.inbound, chat, deliver, adapter: adapterOf };
  const J = jobStores();
  const uploads: { userId: string; ref: string; filename: string }[] = [];
  const jd = (): JobDeps => ({ store: J.store, cards: J.cards as any, tap: J.tap, now: () => clock.t, env, events: null, facts: async () => [], feedLinks: (u, l) => feedUrlsFor(env, u, l, clock.t) });
  const post = async (u: unknown, raw?: string) => {
    clock.t += 1000;
    const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: raw ?? JSON.stringify(u) });
    // Composed exactly as handler.ts composes it with the service client (admin): the resume file through ingestResumeFile
    // over the adapter's getFile, the card taps and the job cards over the stores.
    const adapter = adapterOf(env);
    const core = { ...webhookDeps(adapter, pd as any),
      resumeFile: async (a: any) => await ingestResumeFile({ userId: a.userId, channel: "telegram", doc: a.doc, fetchFile: (id, max) => adapter.fetchFile!(id, max),
        record: async (row) => { uploads.push({ userId: row.userId, ref: row.ref, filename: row.filename }); return `up-${uploads.length}`; } }),
      cardTap: async (a: { userId: string; data: string; now: number }) => await tapCard({ ...a, store: J.tap, events: null }),
      jobTap: async (a: { userId: string; data: string; messageId: string | null; contact: string }) => await tapJob({ userId: a.userId, data: a.data, messageId: a.messageId, deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }),
      showPostings: async (a: { userId: string; contact: string; hits: unknown[] }) => await sendJobCards({ userId: a.userId, hits: a.hits as any[], deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }) };
    const res = await handleChannelWebhook(req, adapter, core as any);
    return { status: res.status, text: await res.text() };
  };
  const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST", language_code: "en" }, date: 1 });
  const userOf = (chat: number) => W.contacts.get(`tg:${chat}`)?.userId ?? null;
  const known = (chat: number) => { const u = W.newUser(); W.link(`tg:${chat}`, u, clock.t - 3600000, { home: true, lastInboundAt: clock.t - 3600000 }); return u; };
  const optedOut = (chat: number) => W.contacts.get(`tg:${chat}`)?.optedOut === true;
  return { W, clock, B, env, vars, adapters, turns, cron, post, from, userOf, known, optedOut, J, jd, adapterOf, uploads, chat, raw: new Map<number, string>() };
}
type World = ReturnType<typeof world>;
const leaks = (s: string) => s.includes(TOKEN) || s.includes(SECRET) || s.includes(TOKEN.split(":")[1]);
const said = (w: World, chat: number, from: number) => w.B.to(chat).slice(from).map(plainOf);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const forwardedFrame = (name: string, text: string) => `Forwarded from ${name.replace(/["“”]/g, "'")}:\n“${text.replace(/["“”]/g, "'")}”`;

// ================================================================================================ conversations
// The fixed refusals and answers a document gets, from how the file was built.
const NOT_RESUME = /^I couldn't read that file as a resume, so I didn't keep it/;
type Who = { chat: number; start: ConvScenario["start"]; account: boolean; out: boolean; msgIds: number[]; updIds: number[]; steps: Step[]; refused: boolean };
let UPD = 1;
async function runStep(w: World, p: Who, s: Step, i: number, r: ReturnType<typeof rng>, sid: number): Promise<string[]> {
  const whys: string[] = [];
  const chat = p.chat;
  const before = { turns: w.turns.length, said: w.B.to(chat).length, answers: w.B.answers.length, uploads: w.uploads.length, files: w.B.fileCalls.length };
  const mid = 100 + i + (p.msgIds.length ? Math.max(...p.msgIds) : 0);
  const m = (x: Record<string, unknown>) => ({ message: { message_id: mid, ...w.from(chat), ...x } });
  let update: any = null, updateId = 0;
  const lastBot = w.B.to(chat).at(-1)?.id ?? null;
  const doc = (d: Record<string, unknown>, f: FileSpec) => { const id = `F${sid}x${i}`; w.B.files.set(id, f); return m({ document: { file_id: id, file_unique_id: `u${id}`, ...d } }); };
  const mediaOf = (k: string): Record<string, unknown> => k === "photo" ? { photo: [{ file_id: "p1", file_unique_id: `up${sid}${i}`, width: 1, height: 1 }] }
    : k === "video" ? { video: { file_id: "v1", file_unique_id: `uv${sid}${i}`, width: 1, height: 1, duration: 2 } }
    : k === "animation" ? { animation: { file_id: "g1", file_unique_id: `ug${sid}${i}`, width: 1, height: 1, duration: 2 }, document: { file_id: "g1", file_unique_id: `ug${sid}${i}`, file_name: "giphy.mp4", mime_type: "video/mp4" } }
    : k === "voice" ? { voice: { file_id: "vo1", file_unique_id: `uvo${sid}${i}`, duration: 2 } } : k === "audio" ? { audio: { file_id: "a1", file_unique_id: `ua${sid}${i}`, duration: 2 } }
    : k === "video_note" ? { video_note: { file_id: "vn1", file_unique_id: `uvn${sid}${i}`, length: 1, duration: 2 } }
    : k === "sticker" ? { sticker: { file_id: "s1", file_unique_id: `us${sid}${i}`, type: "regular", width: 1, height: 1, is_animated: false, is_video: false } }
    : k === "dice" ? { dice: { emoji: "🎲", value: 3 } } : k === "location" ? { location: { latitude: 30.27, longitude: -97.74 } } : { poll: { id: "pl", question: "q?", options: [] } };
  // ---- what this step must do (from how it was built)
  type Want = { turn: string | null; replyTo?: string | null; fixed: string[] | null; firstStartsWith?: string; nothing?: boolean; check?: (got: string[]) => string[] };
  let want: Want = { turn: null, fixed: null, nothing: true };
  const turnOr = (message: string, extra: Partial<Want> = {}): Want => {
    if (p.account) return { turn: message, fixed: null, ...extra };
    if (p.start === "new-open") { p.account = true; return { turn: message, fixed: null, ...extra }; }
    // sign-up closed, Telegram's login page set: the share-phone ask and the link, once; later words go unanswered until then
    if (p.refused) return { turn: null, fixed: null, nothing: true };
    p.refused = true;
    return { turn: null, fixed: [SHARE_PHONE_ASK, TELEGRAM_LINK_REPLY] };
  };
  switch (s.t) {
    case "text": update = m({ text: s.text }); want = turnOr(s.text); break;
    case "applyhere": update = m({ text: s.text, entities: [{ type: "text_link", offset: s.text.length - s.label.length, length: s.label.length, url: s.url }] }); want = turnOr(`${s.text} (${s.url})`); break;
    case "long": update = m({ text: s.text }); want = turnOr("(long)"); if (want.turn) want.check = (got) => longProblems(s.text, w.turns.at(-1)?.message ?? "", got); break;
    case "forward": {
      const at = s.text.indexOf("Apply here"), o = ORIGINS[s.origin];
      const ents = s.withLink && at >= 0 ? [{ type: "text_link", offset: at, length: "Apply here".length, url: s.withLink }] : undefined;
      update = m({ text: s.text, ...(ents ? { entities: ents } : {}), forward_origin: o, forward_date: 1 });
      const body = ents ? `${s.text.slice(0, at + 10)} (${s.withLink})${s.text.slice(at + 10)}` : s.text;
      want = turnOr(forwardedFrame(originName(o), body));
      break;
    }
    case "caption": {
      const ents = s.link ? [{ type: "text_link", offset: 0, length: Math.min(4, s.caption.length), url: s.link }] : undefined;
      // the first word as the link (a flyer's "Apply" in its caption); the URL follows those words
      const expected = ents ? `${s.caption.slice(0, ents[0].length)} (${s.link})${s.caption.slice(ents[0].length)}` : s.caption;
      const surrogate = ents && /[\uD800-\uDBFF]/.test(s.caption.charAt(ents[0].length - 1));
      update = m({ ...mediaOf(s.media), caption: s.caption, ...(ents && !surrogate ? { caption_entities: ents } : {}) });
      want = turnOr(ents && !surrogate ? expected : s.caption, { firstStartsWith: "I can't see or play what you attached" });
      break;
    }
    case "media": {
      update = m(mediaOf(s.media));
      if (!p.account) want = { turn: null, fixed: null, nothing: true };
      else if (s.media === "photo") want = { turn: null, fixed: [PHOTO_NOT_READ_REPLY] };
      else if (["voice", "audio", "video", "video_note"].includes(s.media)) want = { turn: null, fixed: [VOICE_NOT_READ_REPLY] };
      else want = { turn: null, fixed: null, nothing: true };
      break;
    }
    case "edit": update = { edited_message: { message_id: p.msgIds[s.of] ?? mid, ...w.from(chat), text: "fixed typo", edit_date: 2 } }; want = { turn: null, fixed: null, nothing: true }; break;
    case "again": { updateId = p.updIds[s.of]; update = null; want = { turn: null, fixed: null, nothing: true }; break; }
    case "reply": {
      const to = s.toBot && lastBot ? lastBot : p.msgIds.at(-1) ?? lastBot ?? 1;
      update = m({ text: s.text, reply_to_message: { message_id: to, ...w.from(chat), text: "earlier" } });
      want = turnOr(s.text, { replyTo: String(to) });
      break;
    }
    case "cmd": {
      update = m({ text: s.cmd });
      const stop = ["/stop", "STOP", "stop", "Stop."].includes(s.cmd);
      // A stranger's STOP or START records their chat (channel_contacts), but is not the sign-up refusal: IDENTITY SCENARIOS
      // (20261030120000_channel_identity.sql, refused_at) record the refusal itself, so their next message is told once.
      if (stop) { p.out = true; want = { turn: null, fixed: [CHANNEL_REPLIES.stop] }; }
      else if (s.cmd === "START") { p.out = false; want = { turn: null, fixed: [CHANNEL_REPLIES.start] }; }
      else if (s.cmd === "/help") want = p.account ? { turn: "/help", fixed: null } : { turn: null, fixed: [CHANNEL_REPLIES.help] };
      else { // /start
        if (p.account) { p.out = false; want = { turn: "/start", fixed: null, firstStartsWith: CHANNEL_REPLIES.start }; }
        else if (p.start === "new-open") { p.account = true; want = { turn: "/start", fixed: null }; }
        else { p.refused = true; want = { turn: null, fixed: [SHARE_PHONE_ASK, TELEGRAM_LINK_REPLY] }; }
      }
      break;
    }
    case "contact": {
      update = m({ contact: { phone_number: s.own ? ALLOWED_PHONE(chat) : "+15550001111", first_name: "TEST", user_id: s.own ? chat : 4040404 } });
      if (!s.own) want = { turn: null, fixed: [PHONE_NOT_YOURS_REPLY] };
      else if (p.account) want = { turn: null, fixed: [PHONE_ALREADY_REPLY] };
      else { p.account = true; want = { turn: "/start", fixed: null }; } // the allow-listed (or open) phone makes the account: a first turn
      break;
    }
    case "doc": {
      const rr = rng(sid * 31 + i);
      const f = s.family;
      if (f === "gif-doc") { update = m(mediaOf("animation")); want = { turn: null, fixed: null, nothing: true }; break; }
      if (f === "pdf-resume" || f === "not-resume") {
        const rf = resumeFile(rr, f === "pdf-resume" ? "pdf-lines" : "not-cover-letter");
        update = doc({ file_name: rf.name, mime_type: rf.mime, file_size: rf.bytes.length }, { bytes: rf.bytes, size: rf.bytes.length, getFile: "ok" });
        want = f === "pdf-resume" ? turnOr("(resume)") 
          : p.account || p.start === "new-open" ? (p.account = true, { turn: null, fixed: null, check: (got) => got.length === 1 && NOT_RESUME.test(got[0]) ? [] : [`a cover letter got ${JSON.stringify(got).slice(0, 160)}`] })
          : turnOr("");
        if (f === "pdf-resume" && want.turn) want.check = () => { const t = w.turns.at(-1)?.message ?? ""; return /^here is my resume:\n/.test(t) ? [] : [`the resume file reached the brain as ${JSON.stringify(t.slice(0, 60))}`]; };
        break;
      }
      const kinds: Record<string, [Record<string, unknown>, FileSpec, string]> = {
        png: [{ file_name: "IMG_2041.png", mime_type: "image/png", file_size: 4000 }, { bytes: new Uint8Array(4000), size: 4000, getFile: "ok" }, FILE_KIND_REPLY],
        zip: [{ file_name: "portfolio.zip", mime_type: "application/zip", file_size: 9000 }, { bytes: new Uint8Array(9000), size: 9000, getFile: "ok" }, FILE_KIND_REPLY],
        txt: [{ file_name: "notes.txt", mime_type: "text/plain", file_size: 300 }, { bytes: new TextEncoder().encode("some notes"), size: 10, getFile: "ok" }, FILE_KIND_REPLY],
        doc: [{ file_name: "resume.doc", mime_type: "application/msword", file_size: 608 }, { bytes: new Uint8Array(608), size: 608, getFile: "ok" }, FILE_KIND_REPLY],
        empty: [{ file_name: "resume.pdf", mime_type: "application/pdf", file_size: 0 }, { bytes: new Uint8Array(0), size: 0, getFile: "ok" }, FILE_EMPTY_REPLY],
        "big-said": [{ file_name: "resume.pdf", mime_type: "application/pdf", file_size: 15_000_000 }, { bytes: null, size: 15_000_000, getFile: "ok" }, FILE_TOO_BIG_REPLY],
        "huge-said": [{ file_name: "resume.pdf", mime_type: "application/pdf", file_size: 52_428_800 }, { bytes: null, size: 52_428_800, getFile: "too-big-400" }, FILE_TOO_BIG_REPLY],
        "huge-unsaid": [{ file_name: "resume.pdf", mime_type: "application/pdf" }, { bytes: null, size: null, getFile: "too-big-400" }, FILE_TOO_BIG_REPLY],
      };
      const [d, spec, reply] = kinds[f];
      update = doc(d, spec);
      if (p.account || p.start === "new-open") { p.account = true; want = { turn: null, fixed: [reply] }; }
      else want = turnOr("");
      if (f === "big-said" || f === "huge-said") { const n0 = before.files; want.check = () => w.B.fileCalls.length !== n0 ? [`a file Telegram said is over 10 MB was asked for (${w.B.fileCalls.slice(n0).join(", ")})`] : []; }
      break;
    }
  }
  // ---- send it
  const id = updateId || ++UPD;
  let res: { status: number; text: string };
  if (updateId) res = await w.post(null, w.raw.get(id));
  else { const body = { update_id: id, ...update }; w.raw.set(id, JSON.stringify(body)); res = await w.post(body); }
  p.updIds[i] = id; p.msgIds[i] = mid;
  if (res.status !== 200) whys.push(`step ${i} (${s.t}): HTTP ${res.status} ${res.text.slice(0, 100)}`);
  if (leaks(res.text)) whys.push(`step ${i}: the response carries a secret`);
  // ---- judge it
  const newTurns = w.turns.slice(before.turns);
  const got = said(w, chat, before.said);
  const tag = `step ${i} (${s.t}${"media" in s ? `:${s.media}` : ""}${"family" in s ? `:${s.family}` : ""}${"cmd" in s ? `:${s.cmd}` : ""})`;
  if (want.turn !== null) {
    if (newTurns.length !== 1) whys.push(`${tag}: ${newTurns.length} model turns, want 1`);
    else {
      const t = newTurns[0];
      if (!["(long)", "(resume)", ""].includes(want.turn) && t.message !== want.turn) whys.push(`${tag}: the brain read ${JSON.stringify(t.message.slice(0, 120))}, want ${JSON.stringify(want.turn.slice(0, 120))}`);
      if (LONE.test(t.message)) whys.push(`${tag}: the brain read half a character`);
      if (t.message.length > 4000) whys.push(`${tag}: the brain was sent ${t.message.length} characters (agent-chat refuses over 4,000)`);
      if (want.replyTo !== undefined && t.replyTo !== want.replyTo) whys.push(`${tag}: reply-to ${t.replyTo}, want ${want.replyTo}`);
      const mine = got.filter((g) => g.includes(`«${t.n}»`));
      if (mine.length !== 1) whys.push(`${tag}: the answer arrived ${mine.length} times`);
      if (got.length !== 1) whys.push(`${tag}: ${got.length} messages for one update: ${JSON.stringify(got).slice(0, 200)}`);
      if (want.firstStartsWith && !norm(got[0] ?? "").startsWith(norm(want.firstStartsWith))) whys.push(`${tag}: the answer does not start with ${JSON.stringify(want.firstStartsWith.slice(0, 40))}: ${JSON.stringify((got[0] ?? "").slice(0, 120))}`);
      if (!want.firstStartsWith && s.t !== "long" && /^(I can't see or play|That message was longer)/.test(got[0] ?? "")) whys.push(`${tag}: a note no one asked for: ${got[0].slice(0, 80)}`);
    }
  } else {
    if (newTurns.length) whys.push(`${tag}: a model turn ran: ${JSON.stringify(newTurns[0].message.slice(0, 80))}`);
    if (want.fixed && JSON.stringify(got.map(norm)) !== JSON.stringify(want.fixed.map(norm))) whys.push(`${tag}: said ${JSON.stringify(got).slice(0, 220)}, want ${JSON.stringify(want.fixed).slice(0, 160)}`);
    if (want.nothing && got.length) whys.push(`${tag}: said ${JSON.stringify(got).slice(0, 160)}, want nothing`);
  }
  if (want.check) whys.push(...want.check(got).map((x) => `${tag}: ${x}`));
  const c = w.W.contacts.get(`tg:${chat}`);
  if (c && c.optedOut !== p.out) whys.push(`${tag}: opted out is ${c.optedOut}, want ${p.out}`);
  void r;
  return whys;
}
function longProblems(text: string, read: string, got: string[]): string[] {
  const out: string[] = [];
  if (read.length > 4000) out.push(`the brain was sent ${read.length} characters`);
  if (read.length < 3000) out.push(`only ${read.length} of ${text.length} characters were read`);
  if (!text.startsWith(read)) out.push(`what the brain read is not the start of the message: ${JSON.stringify(read.slice(-40))}`);
  if (LONE.test(read)) out.push("half a character");
  if (!/^That message was longer than the 4,000 characters/.test(got[0] ?? "")) out.push(`the answer does not say where reading stopped: ${JSON.stringify((got[0] ?? "").slice(0, 100))}`);
  return out;
}

Deno.test({ name: "telegram r2: 4,000 whole conversations (typos, emoji, voice, stickers, GIFs, edits, replies, forwarded posts, links, files, STOP/START, the next day's alert)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("conversations");
  for (const s of SCENARIOS) {
    if (s.kind !== "conv" || !only(s)) continue;
    const w = world({ native: s.native, env: s.start === "new-phone" ? { TRAINEE_SIGNUP: "closed", TELEGRAM_LOGIN_URL: LOGIN_URL, TRAINEE_ALLOWED_CONTACTS: `${ALLOWED_PHONE(s.chat)}${s.second ? `,telegram:${s.second.chat}` : ""}` } : {} });
    const people: Who[] = [{ chat: s.chat, start: s.start, account: false, out: false, msgIds: [], updIds: [], steps: s.steps, refused: false }];
    if (s.start === "known") { w.known(s.chat); people[0].account = true; }
    if (s.second) { w.known(s.second.chat); people.push({ chat: s.second.chat, start: "known", account: true, out: false, msgIds: [], updIds: [], steps: s.second.steps, refused: false }); }
    const whys: string[] = [];
    const r = rng(s.id);
    const order: [Who, number][] = [];
    for (let i = 0; i < Math.max(...people.map((p) => p.steps.length)); i++) for (const p of people) if (i < p.steps.length) order.push([p, i]);
    for (const [p, i] of order) {
      try { whys.push(...(await runStep(w, p, p.steps[i], i, r, s.id)).map((x) => p === people[0] ? x : `second person: ${x}`)); }
      catch (e) { whys.push(`step ${i}: a crash: ${e instanceof Error ? e.stack?.slice(0, 300) : String(e)}`); }
    }
    // isolation: every answer token went to the chat whose turn it was
    for (const t of w.turns) {
      const chatOf = people.find((p) => w.userOf(p.chat) === t.userId)?.chat;
      for (const p of people) if (p.chat !== chatOf && w.B.to(p.chat).some((m) => plainOf(m).includes(`«${t.n}»`))) whys.push(`chat ${p.chat} read another person's answer`);
    }
    // the next day's alert: held by STOP, sent after START (only for a person with an account)
    if (s.alertAfter && people[0].account && w.userOf(s.chat)) {
      w.clock.t += 18 * 3600000;
      const before = w.B.to(s.chat).length;
      w.W.queue(w.userOf(s.chat)!, { key: `alert:r2-${s.id}`, kind: "alert", text: `TEST alert for ${s.id}: 3 new postings`, at: w.clock.t });
      await w.cron();
      const row = w.W.outbox.find((o) => o.key === `alert:r2-${s.id}`)!;
      const got = said(w, s.chat, before);
      if (people[0].out && (row.status !== "skipped_opt_out" || got.length)) whys.push(`after STOP the next day's alert was ${row.status} (${got.length} messages)`);
      if (!people[0].out && (row.status !== "delivered" || got.length !== 1)) whys.push(`the next day's alert was ${row.status} ${row.error ?? ""} (${got.length} messages) though the person is subscribed`);
    }
    whys.push(...w.B.problems());
    if (w.B.msgs.some((x) => Number(x.chat) < 0)) whys.push("something went to a group");
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ long messages
Deno.test({ name: "telegram r2: 600 messages of 4,001-4,096 characters: a whole-word prefix read, never half a character, the answer says where reading stopped", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("long");
  for (const s of SCENARIOS) {
    if (s.kind !== "long" || !only(s)) continue;
    const w = world();
    w.known(s.chat);
    const fwd = s.how === "forward" ? ORIGINS[s.id % ORIGINS.length] : null;
    const r = await w.post({ update_id: ++UPD, message: { message_id: 7, ...w.from(s.chat), text: s.text, ...(fwd ? { forward_origin: fwd } : {}) } });
    const whys: string[] = [];
    if (r.status !== 200) whys.push(`HTTP ${r.status}`);
    const got = said(w, s.chat, 0);
    if (w.turns.length !== 1) whys.push(`${w.turns.length} turns`);
    else {
      const read = w.turns[0].message;
      if (fwd) {
        const head = `Forwarded from ${originName(fwd).replace(/["“”]/g, "'")}:\n“`;
        if (!read.startsWith(head) || !read.endsWith("”")) whys.push(`a forwarded long message was not framed: ${JSON.stringify(read.slice(0, 60))}`);
        whys.push(...longProblems(s.text.replace(/["“”]/g, "'"), read.slice(head.length, -1), got).filter((x) => !/only \d+ of/.test(x) || read.length < 3000));
        if (read.length > 4000) whys.push(`${read.length} characters to the brain`);
      } else whys.push(...longProblems(s.text, read, got));
      if (got.filter((g) => g.includes(`«${w.turns[0].n}»`)).length !== 1) whys.push(`the answer arrived ${got.length} times`);
    }
    whys.push(...w.B.problems());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ Bot API realities
const posting = (id: number, k: number, o: { title?: string; reasons?: string[]; domain?: string | null; description?: string; url?: string } = {}) => ({
  job_id: `lever:acme:${id}-${k}`, company: "Acme", title: o.title ?? `Data Analyst ${k}`, location: "Austin, TX", url: o.url ?? `https://jobs.lever.co/acme/${id}-${k}`, pay: null, level: null,
  first_seen_at: new Date(NOW - 3600000).toISOString(), deadline: null, ...(o.domain !== undefined ? (o.domain ? { company_domain: o.domain } : {}) : {}), fit: { reasons: o.reasons ?? [], gaps: [] } });
const prepFor = (userId: string, jobId: string, v: number, cover: string): Prep => ({ id: `prep-${jobId}-${v}`, userId, job_id: jobId, company: "Acme", url: `https://jobs.lever.co/acme/${jobId}`,
  payload: { version: 1, fields: [{ name: "first_name", label: "First name", value: `Alex v${v}` }, { name: "cover_letter", label: "Cover letter", value: cover }] },
  payload_hash: `${String(v).repeat(8)}${"ab".repeat(28)}`.slice(0, 64).replace(/[^0-9a-f]/g, "a"), card_lines: ["Acme"], state: "ready" });

async function apiScenario(s: ApiScenario): Promise<string[]> {
  const a = s.a, chat = s.chat, whys: string[] = [];
  const respond = (method: string, status: number, description: string, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error_code: status, description, ...extra }, { status });
  switch (a.c) {
    case "thread": {
      const w = world();
      w.known(chat);
      const msg = a.private ? { message_id: 9, message_thread_id: a.thread, is_topic_message: true, ...w.from(chat), text: "any remote jobs?" }
        : { message_id: 9, message_thread_id: a.thread, is_topic_message: true, chat: { id: -1001000000000 - s.id, type: "supergroup", is_forum: true, title: "TEST forum" }, from: { id: chat, is_bot: false }, date: 1, text: "any remote jobs?" };
      await w.post({ update_id: ++UPD, message: msg });
      const got = said(w, chat, 0);
      if (a.private) {
        if (w.turns.length !== 1 || got.length !== 1) whys.push(`a message in a topic of the private chat: ${w.turns.length} turns, ${got.length} answers`);
      } else if (w.turns.length || w.B.msgs.length) whys.push("a forum topic in a group ran a turn or got a message");
      whys.push(...w.B.problems());
      return whys;
    }
    case "migrated": {
      const w = world();
      w.known(chat);
      const g = -1000 - s.id, sg = -1001000000000 - s.id;
      const msg = a.how === "group-msg" ? { message_id: 3, chat: { id: g, type: "group", title: "TEST" }, from: { id: chat, is_bot: false }, date: 1, text: "find jobs" }
        : a.how === "migrate-to" ? { message_id: 3, chat: { id: g, type: "group", title: "TEST" }, from: { id: chat, is_bot: false }, date: 1, migrate_to_chat_id: sg }
        : a.how === "migrate-from" ? { message_id: 1, chat: { id: sg, type: "supergroup", title: "TEST" }, from: { id: chat, is_bot: false }, date: 1, migrate_from_chat_id: g }
        : { message_id: 4, message_thread_id: 5, is_topic_message: true, chat: { id: sg, type: "supergroup", is_forum: true, title: "TEST" }, from: { id: chat, is_bot: false }, date: 1, text: "/start" };
      const r = await w.post({ update_id: ++UPD, message: msg });
      if (r.status !== 200) whys.push(`HTTP ${r.status}`);
      if (w.turns.length || w.B.calls.length) whys.push(`a group's update (${a.how}) ran a turn or a Bot API call`);
      return whys;
    }
    case "blocked": case "notfound": {
      const desc = a.c === "notfound" ? "Bad Request: chat not found" : a.how === "blocked" ? "Forbidden: bot was blocked by the user" : "Forbidden: user is deactivated";
      const status = a.c === "notfound" ? 400 : 403;
      let armed = false, hits = 0;
      const w = world({ fail: (c) => (armed && c.body?.chat_id === chat && /^send/.test(c.method) ? (hits++, respond(c.method, status, desc)) : null),
        replies: a.c === "blocked" && a.where === "parts" ? () => ({ parts: ["First part of the answer.", "Second part of the answer.", "Third part of the answer."] }) : undefined });
      const u = w.known(chat);
      const where = a.where;
      const before = w.B.calls.length;
      armed = true;
      if (where === "alert") { w.W.queue(u, { key: `alert:b${s.id}`, kind: "alert", text: "TEST alert", at: w.clock.t }); await w.cron(); }
      else if (where === "fixed") await w.post({ update_id: ++UPD, message: { message_id: 4, ...w.from(chat), voice: { file_id: "v", file_unique_id: `uv${s.id}`, duration: 1 } } });
      else await w.post({ update_id: ++UPD, message: { message_id: 4, ...w.from(chat), text: "hi" } });
      // the next day: an alert, and the every-minute run a few times
      w.clock.t += 20 * 3600000;
      w.W.queue(u, { key: `alert:b2-${s.id}`, kind: "alert", text: "TEST alert 2", at: w.clock.t });
      const hitsBefore = hits;
      for (let k = 0; k < 4; k++) { await w.cron(); w.clock.t += 10 * MIN; }
      const rows = w.W.outbox.filter((o) => o.userId === u);
      if (a.c === "blocked") {
        if (!w.optedOut(chat)) whys.push(`a ${a.how} person (403 on ${where}) is not recorded as stopped`);
        if (hits - hitsBefore > 0) whys.push(`${hits - hitsBefore} more Bot API calls to a person who ${a.how === "blocked" ? "blocked the bot" : "deleted their account"}`);
        for (const r of rows) if (r.status !== "skipped_opt_out") whys.push(`${r.key} ended ${r.status} (${r.error ?? ""})`);
        for (const r of rows.filter((x) => x.error)) if (!/blocked|deactivated|STOP|opted|unsubscribed/i.test(r.error!) && !/^not sent/.test(r.error!)) whys.push(`${r.key}: the reason is not said: ${r.error}`);
      } else {
        const first = rows.find((r) => r.key.startsWith(where === "alert" ? "alert:b" : "reply:"))!;
        if (!first || first.status !== "failed" || first.retryAt !== null || !/chat not found/.test(first.error ?? "")) whys.push(`"chat not found": the row is ${first?.status} retry ${first?.retryAt} (${first?.error})`);
      }
      if (w.B.calls.length === before) whys.push("nothing was tried");
      whys.push(...w.B.violations.filter((v) => !/retry_after/.test(v)));
      return whys;
    }
    case "bigfile": {
      const w = world();
      w.known(chat);
      w.B.files.set(`B${s.id}`, { bytes: null, size: a.size, getFile: a.getFile });
      await w.post({ update_id: ++UPD, message: { message_id: 5, ...w.from(chat), document: { file_id: `B${s.id}`, file_unique_id: `uB${s.id}`, file_name: "resume.pdf", mime_type: "application/pdf", ...(a.size !== null ? { file_size: a.size } : {}) } } });
      const got = said(w, chat, 0);
      if (JSON.stringify(got) !== JSON.stringify([FILE_TOO_BIG_REPLY])) whys.push(`a file over what a bot may download (${a.size === null ? "size not said" : `${a.size} bytes said`}, getFile ${a.getFile}) got ${JSON.stringify(got).slice(0, 200)}`);
      if (a.size !== null && w.B.fileCalls.length) whys.push(`asked Telegram for a file it said is ${a.size} bytes`);
      if (w.B.fileCalls.some((x) => x.startsWith("download")) && a.getFile !== "stream-over") whys.push("downloaded a file over the cap");
      if (w.uploads.length || w.turns.length) whys.push("a file over the cap was stored or read");
      return whys;
    }
    case "parse400": {
      // Telegram refuses this message's markup (a stricter parser than ours, a new entity rule): sent again as plain text, once.
      const paras = Array.from({ length: a.parts }, (_, i) => `[P${i}] **Point ${i + 1}**: ${"keep a plain record of what you tried and learned, ".repeat(26)}*done* ${i}.`);
      const refused = new Set(a.refuse.map((i) => `[P${i}]`));
      const w = world({ native: a.native, fail: (c) => c.method === "sendMessage" && c.body?.parse_mode === "HTML" && [...refused].some((k) => String(c.body.text).includes(k)) ? respond(c.method, 400, "Bad Request: can't parse entities: Unsupported start tag \"b\" at byte offset 7") : null });
      const u = w.known(chat);
      w.W.queue(u, { key: `report:p${s.id}`, kind: "report", text: paras.join("\n\n"), at: w.clock.t });
      await w.cron();
      const got = said(w, chat, 0);
      for (let i = 0; i < a.parts; i++) {
        const n = got.filter((g) => g.includes(`[P${i}]`)).length;
        if (n !== 1) whys.push(`part ${i} arrived ${n} times`);
        const g = got.find((x) => x.includes(`[P${i}]`)) ?? "";
        if (!g.includes(`Point ${i + 1}`) || !g.replace(/\*/g, "").includes(`done ${i}.`) || (a.native && /\*\*|<b>/.test(g))) whys.push(`part ${i} did not arrive word for word: ${JSON.stringify(g.slice(0, 80))}`);
      }
      const row = w.W.outbox.find((o) => o.key === `report:p${s.id}`)!;
      if (row.status !== "delivered") whys.push(`the row is ${row.status}: ${row.error}`);
      whys.push(...w.B.limits, ...w.B.violations);
      return whys;
    }
    case "caption": {
      const title = `Senior Data Analyst ${"(Growth & Insights) ".repeat(Math.ceil(a.titleLen / 20))}`.slice(0, a.titleLen);
      const reasons = Array.from({ length: a.fitLines }, (_, i) => `You know SQL and dashboards from your internship number ${i + 1} at a company 😀`);
      const failPhoto = a.photoFails;
      const w = world({ env: { TRAINEE_LOGO_URL: "https://logos.trainee.test/{domain}.png" }, fail: (c) => c.method !== "sendPhoto" || failPhoto === "none" ? null
        : failPhoto === "network" ? respond(c.method, 500, "Internal Server Error")
        : respond(c.method, 400, failPhoto === "400-url" ? "Bad Request: wrong file identifier/HTTP URL specified" : "Bad Request: failed to get HTTP URL content") });
      const u = w.known(chat);
      const hit = posting(s.id, 1, { title, reasons, domain: "acme.test" });
      const sent = await sendJobCards({ userId: u, hits: [hit], deps: w.jd(), send: jobSenderFor(w.adapterOf(w.env), String(chat)) });
      const cards = w.B.to(chat).filter((m) => m.buttons.some((b: any) => /^jca:/.test(b.callback_data ?? "")));
      if (sent.sent !== 1 || cards.length !== 1) whys.push(`${cards.length} cards for one posting (photo ${failPhoto})`);
      for (const m of cards) if (m.photo !== null && m.text.length > 1024) whys.push(`a caption of ${m.text.length}`);
      if (failPhoto !== "none" && cards.some((m) => m.photo !== null)) whys.push("a photo card although Telegram could not fetch the logo");
      whys.push(...w.B.problems());
      return whys;
    }
    case "keyboard": {
      const w = world({ env: a.feed ? { TRAINEE_FILE_BASE_URL: "https://files.trainee.test/f", TRAINEE_FILE_LINK_SECRET: ["TEST", "file", "link", "secret", "0123456789abcdef"].join("-") } : {} });
      const u = w.known(chat);
      const hits = Array.from({ length: a.postings }, (_, k) => posting(s.id, k));
      for (const h of hits) w.J.preps.push(prepFor(u, h.job_id, 1, "I am interested."));
      await sendJobCards({ userId: u, hits, deps: w.jd(), send: jobSenderFor(w.adapterOf(w.env), String(chat)) });
      const first = w.B.to(chat).flatMap((m) => m.buttons).find((b: any) => /^jca:/.test(b.callback_data ?? ""));
      if (first) await w.post({ update_id: ++UPD, callback_query: { id: `cb${s.id}`, from: { id: chat, is_bot: false }, message: { message_id: 1, chat: { id: chat, type: "private" }, date: 1 }, data: first.callback_data } });
      for (const m of w.B.to(chat)) {
        const rows = m.replyMarkup?.inline_keyboard ?? [];
        if (rows.flat().length > 100 || rows.some((r: unknown[]) => r.length > 8)) whys.push("a keyboard over Telegram's limits");
      }
      whys.push(...w.B.problems());
      return whys;
    }
    case "escape": {
      // A job page whose words carry many "&" (R&D, P&L, Q&A): escaped for HTML it grows past 4,096, and was cut there.
      const amps = Array.from({ length: a.amps }, (_, i) => `R&D${i}`).join(" ");
      const w = world({ native: a.native });
      const u = w.known(chat);
      const hit = posting(s.id, 1, { domain: null });
      if (a.page === "details") {
        const desc = `Requirements\n${amps} ${"SQL and dashboards. ".repeat(Math.max(1, Math.floor((3300 - amps.length) / 20)))}END-OF-REQUIREMENTS-${s.id}`;
        w.J.rows.set(hit.job_id, { job_id: hit.job_id, provider: "lever", company: "Acme", title: hit.title, location: "Austin, TX", url: hit.url, description: desc } as PostingRow);
      } else {
        w.J.rows.set(hit.job_id, { job_id: hit.job_id, provider: "lever", company: "Acme", title: hit.title, location: "Austin, TX", url: hit.url, description: "Requirements\nSQL." } as PostingRow);
        w.J.preps.push(prepFor(u, hit.job_id, 1, `${amps} ${"I build dashboards & reports. ".repeat(Math.max(1, Math.floor((3300 - amps.length) / 30)))}END-OF-COVER-${s.id}`));
      }
      await sendJobCards({ userId: u, hits: [hit], deps: w.jd(), send: jobSenderFor(w.adapterOf(w.env), String(chat)) });
      const card = w.B.to(chat).at(-1)!;
      const data = card.buttons.find((b: any) => (a.page === "details" ? /^jcd:/ : /^jca:/).test(b.callback_data ?? ""))?.callback_data;
      const before = w.B.to(chat).length;
      await w.post({ update_id: ++UPD, callback_query: { id: `cb${s.id}`, from: { id: chat, is_bot: false }, message: { message_id: card.id, chat: { id: chat, type: "private" }, date: 1 }, data } });
      const shown = w.B.to(chat).slice(before).concat(w.B.msgs.filter((m) => m.method === "editMessageText" && m.chat === String(chat)));
      const all = shown.map(plainOf).join("\n");
      const end = a.page === "details" ? `END-OF-REQUIREMENTS-${s.id}` : `END-OF-COVER-${s.id}`;
      if (!all.includes(end)) whys.push(`the ${a.page} page arrived cut (${a.amps} "&"): its last words never reached the person${a.page === "apply" ? ", yet Confirm approves the whole payload" : ""}`);
      if (a.page === "apply") {
        const confirmAt = shown.findIndex((m) => m.buttons.some((b: any) => /^jcy:/.test(b.callback_data ?? "")));
        const endAt = shown.findIndex((m) => plainOf(m).includes(end));
        if (confirmAt < 0) whys.push("no Confirm");
        else if (endAt < 0 || endAt > confirmAt) whys.push("Confirm came before the whole payload was shown");
      }
      whys.push(...w.B.problems());
      return whys;
    }
    case "stale": {
      const w = world();
      const u = w.known(chat);
      const hits = Array.from({ length: a.op === "next-old" ? 7 : 1 }, (_, k) => posting(s.id, k, a.op === "details-photo" ? { domain: "acme.test" } : { domain: null }));
      for (const h of hits) w.J.rows.set(h.job_id, { job_id: h.job_id, provider: "lever", company: "Acme", title: h.title, location: "Austin, TX", url: h.url, description: "Requirements\nSQL." } as PostingRow);
      if (a.op === "details-photo") w.vars.TRAINEE_LOGO_URL = "https://logos.trainee.test/{domain}.png";
      w.J.preps.push(prepFor(u, hits[0].job_id, 1, "First version."));
      await sendJobCards({ userId: u, hits, deps: w.jd(), send: jobSenderFor(w.adapterOf(w.env), String(chat)) });
      const card = w.B.to(chat).find((m) => m.buttons.some((b: any) => /^jca:/.test(b.callback_data ?? "")))!;
      const ref = await refOf(u, hits[0].job_id);
      const tap = (data: string, messageId: number | null) => w.post({ update_id: ++UPD, callback_query: { id: `cb${s.id}-${UPD}`, from: { id: chat, is_bot: false },
        ...(messageId !== null && !a.noMessage ? { message: { message_id: messageId, chat: { id: chat, type: "private" }, date: 1 } } : {}), data } });
      // the card changes after it was shown: the posting's text, the prepared application (a new version), a new list
      w.J.rows.get(hits[0].job_id)!.description = "Requirements\nSQL and Python now.";
      const answers0 = w.B.answers.length;
      let taps = 0;
      if (a.op === "details" || a.op === "details-photo") { await tap(`jcd:${ref}`, card.id); taps++; }
      if (a.op === "save") { await tap(`jcs:${ref}`, card.id); await tap(`jcs:${ref}`, card.id); taps += 2; }
      if (a.op === "apply" || a.op === "confirm-old" || a.op === "confirm-new") { await tap(`jca:${ref}`, card.id); taps++; }
      const p1 = w.J.preps[0];
      if (a.op === "confirm-old" || a.op === "confirm-new") {
        p1.state = "expired";
        const p2 = prepFor(u, hits[0].job_id, 2, "Second version.");
        w.J.preps.push(p2);
        if (a.op === "confirm-old") { await tap(`jcy:${ref}:${hashTag(p1.payload_hash)}`, card.id + 1); taps++; }
        else { await tap(`jca:${ref}`, card.id); await tap(`jcy:${ref}:${hashTag(p2.payload_hash)}`, card.id + 2); await tap(`jcy:${ref}:${hashTag(p2.payload_hash)}`, card.id + 2); taps += 3; }
      }
      if (a.op === "next-old") {
        const next = w.B.to(chat).flatMap((m) => m.buttons).find((b: any) => /^jcn:/.test(b.callback_data ?? ""))?.callback_data;
        await sendJobCards({ userId: u, hits: [posting(s.id, 99, { domain: null })], deps: w.jd(), send: jobSenderFor(w.adapterOf(w.env), String(chat)) });
        if (!next) whys.push("no Next on a list of 7");
        else { await tap(next, card.id); taps++; }
      }
      if (w.B.answers.length - answers0 !== taps) whys.push(`${taps} taps, ${w.B.answers.length - answers0} answered`);
      const approvals = w.J.approvals;
      if (a.op === "confirm-old" && approvals.length) whys.push("an old Confirm approved a payload that changed after it was shown");
      if (a.op === "confirm-new" && (approvals.length !== 1 || approvals[0].hash !== w.J.preps[1].payload_hash)) whys.push(`${approvals.length} approvals for the current payload tapped twice`);
      if (a.op !== "confirm-new" && approvals.length) whys.push("an approval no one gave");
      if (a.op === "details" || a.op === "details-photo") { const all = w.B.msgs.filter((m) => m.chat === String(chat)).map(plainOf).join("\n"); if (!all.includes("SQL and Python now.")) whys.push("Details did not show the posting as it is now"); }
      whys.push(...w.B.problems());
      return whys;
    }
  }
  return whys;
}
Deno.test({ name: "telegram r2: 3,000 Bot API realities (topics, old taps, keyboards, captions, logos that fail, parse errors, escaping, 403s, chat not found, groups, big files)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("api");
  for (const s of SCENARIOS) {
    if (s.kind !== "api" || !only(s)) continue;
    let whys: string[];
    try { whys = await apiScenario(s); } catch (e) { whys = [`a crash: ${e instanceof Error ? e.stack?.slice(0, 300) : String(e)}`]; }
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ languages
const md = (s: string) => s.replace(/\*\*|__|[*_`]/g, "").replace(/^- /gm, "");
Deno.test({ name: "telegram r2: 2,400 people writing in Spanish, Hindi and Arabic: their words exact, every word and link of the answer, every message valid", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("languages");
  for (const s of SCENARIOS) {
    if (s.kind !== "lang" || !only(s)) continue;
    const answer = s.long ? (() => { let x = s.reply; while (x.length < s.long) x += `\n\n${s.reply}`; return x; })() : s.reply;
    const w = world({ native: s.native, replies: () => ({ reply: answer }) });
    w.known(s.chat);
    const whys: string[] = [];
    const r = await w.post({ update_id: ++UPD, message: { message_id: 2, ...w.from(s.chat), text: s.said } });
    if (r.status !== 200) whys.push(`HTTP ${r.status}`);
    if (w.turns.length !== 1) whys.push(`${w.turns.length} turns for "${s.said}"${w.optedOut(s.chat) ? " (read as STOP)" : ""}`);
    else if (w.turns[0].message !== s.said) whys.push(`the brain read ${JSON.stringify(w.turns[0].message)}, they wrote ${JSON.stringify(s.said)}`);
    const got = said(w, s.chat, 0);
    const all = got.join("\n");
    for (const word of md(answer).split(/\s+/).map((x) => x.replace(/^[(\[]+|[)\].,:;!?،؟।]+$/g, "")).filter((x) => x.length > 1 && !/^https?:/.test(x))) {
      if (!all.includes(word)) { whys.push(`a word of the answer never arrived: ${JSON.stringify(word)}`); break; }
    }
    for (const url of answer.match(/https:\/\/\S+/g) ?? []) if (!got.some((g) => g.split(/\s+/).includes(url))) whys.push(`the link ${url} did not arrive whole`);
    for (const m of w.B.to(s.chat)) if (m.html && /<(b|i)>\s*<\/\1>/.test(m.text)) whys.push("an empty emphasis tag");
    // (an answer over the outbox's 4,000 characters is cut there and says so; a marker cut open there is not judged)
    if (got.some((g) => /\*\*|(^|\s)_\S|`/.test(g) && !/That's where I had to stop/.test(g)) && s.native) whys.push(`markdown arrived as typed: ${(() => { const g = got.find((x) => /\*\*|(^|\s)_\S|`/.test(x))!; const k = g.search(/\*\*|(^|\s)_\S|`/); return JSON.stringify(g.slice(Math.max(0, k - 120), k + 120)) + ` (message ${got.indexOf(g) + 1} of ${got.length}, ${g.length} characters)`; })()}`);
    // their STOP still works
    await w.post({ update_id: ++UPD, message: { message_id: 3, ...w.from(s.chat), text: "STOP" } });
    if (!w.optedOut(s.chat)) whys.push("STOP after a conversation in another language did not stop");
    whys.push(...w.B.problems());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });
