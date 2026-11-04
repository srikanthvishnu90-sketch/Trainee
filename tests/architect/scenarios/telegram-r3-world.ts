// The world the Telegram round-3 scenarios run in (scenarios-telegram-r3.test.ts): the real Telegram webhook composed exactly as
// trainee-telegram/handler.ts composes it with the service client (webhookDeps, then the job cards and taps over memory stores),
// the real inbound core (channel_inbound.ts), the real delivery run (channel.ts deliverDue over channel_memory.ts), and a fake
// Bot API (telegram-bot-api.ts) wrapped with what round 3 needs: a 429 / 403 / 502 or a timeout on a chosen call to a chosen
// chat, and a check of its own that no call reaches a chat before the retry_after Telegram asked for. A timeout is the worst
// case: the message WAS delivered (the fake recorded it) and the sender never heard back. No network, no model, no wall clock.
import { fakeBot } from "./telegram-bot-api.ts";
import { jobSenderFor, webhookDeps } from "../../../supabase/functions/trainee-telegram/handler.ts";
import { handleChannelWebhook } from "../../../supabase/functions/_shared/channel_inbound.ts";
import { memoryChannelWorld } from "../../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../../supabase/functions/_shared/telegram.ts";
import { textingNativeOn } from "../../../supabase/functions/_shared/channel_voice.ts";
import { type JobDeps, type JobStore, type PostingRow, type PreparedRow, sendJobCards, tapJob } from "../../../supabase/functions/_shared/telegram_jobs.ts";
import { tapCard, type TapStore } from "../../../supabase/functions/_shared/channel_card_tap.ts";
import { addressOf } from "../../../supabase/functions/_shared/channel_adapters.ts";

export const NOW = Date.parse("2026-10-31T16:00:00Z");
// Built at run time: no key-shaped string sits in the repository (tests/no-secrets.test.cjs).
export const TOKEN = ["765432", "TEST-tg3-bot-token-not-real"].join(":");
export const SECRET = ["TEST", "tg3", "webhook", "secret", "0123456789abcdefghij"].join("_");

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}

// ------------------------------------------------------------------------------------------------ the Bot API, with faults
export type Fault = { chat: number; method: string; nth: number; kind: "429" | "403" | "502" | "timeout" | "deactivated"; retryAfter?: number; times?: number };
export function bot(clock: { t: number }) {
  const b = fakeBot({ token: TOKEN, now: () => clock.t });
  const faults: Fault[] = [];
  const seen = new Map<string, number>(), until = new Map<string, number>();
  const extra: string[] = [];
  const attempts: { chat: string | null; method: string; at: number }[] = []; // every call, including the ones a fault answered
  const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split("/").pop() ?? "";
    let chat: string | null = null;
    if (typeof init?.body === "string") { try { const j = JSON.parse(init.body); chat = j.chat_id !== undefined ? String(j.chat_id) : null; } catch { /* not JSON */ } }
    else if (init?.body instanceof FormData) chat = String(init.body.get("chat_id") ?? "") || null;
    attempts.push({ chat, method, at: clock.t });
    if (chat !== null) {
      const u = until.get(chat);
      if (u !== undefined && clock.t < u) extra.push(`retry_after not honoured: a ${method} to ${chat} ${u - clock.t} ms early`);
      const k = `${chat}|${method}`, n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      const f = faults.find((x) => String(x.chat) === chat && x.method === method && n >= x.nth && n < x.nth + (x.times ?? 1));
      if (f) {
        if (f.kind === "429") { until.set(chat, clock.t + (f.retryAfter ?? 1) * 1000); return Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${f.retryAfter ?? 1}`, parameters: { retry_after: f.retryAfter ?? 1 } }, { status: 429 }); }
        if (f.kind === "403") return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
        if (f.kind === "deactivated") return Response.json({ ok: false, error_code: 403, description: "Forbidden: user is deactivated" }, { status: 403 });
        if (f.kind === "502") return Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 });
        // timeout: Telegram took it (the fake records it) and the answer never came back
        await b.fetch(input, init);
        throw new DOMException("Signal timed out.", "TimeoutError");
      }
    }
    return await b.fetch(input, init);
  }) as typeof fetch;
  return { ...b, fetch, faults, attempts, problems: () => [...b.violations, ...extra] };
}

// ------------------------------------------------------------------------------------------------ the jobs' memory stores
export type Prep = PreparedRow & { userId: string };
export function jobStores() {
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
  return { store, cards, tap, rows, preps, applied, approvals, wants, kv };
}

// ------------------------------------------------------------------------------------------------ one world
export type Turn = { userId: string; message: string; n: number };
export function world(o: { native?: boolean; env?: Record<string, string | undefined>; replies?: (a: { message: string; n: number; userId: string }) => Record<string, unknown> } = {}) {
  const W = memoryChannelWorld();
  const clock = { t: NOW };
  const B = bot(clock);
  const vars: Record<string, string | undefined> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeR3Bot", TRAINEE_SIGNUP: "open",
    ...(o.native ? { CAREER_TEXTING_NATIVE: "on" } : {}), ...o.env };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  const adapters = adaptersFromEnv(env, { fetch: B.fetch, clock: () => clock.t, sleep });
  const turns: Turn[] = [];
  let n = 0;
  let replies = o.replies;
  const chat = async (a: any) => {
    const k = ++n;
    turns.push({ userId: a.userId, message: a.message, n: k });
    if (!String(a.message ?? "").trim()) throw new Error("agent-chat HTTP 400");
    return { status: 200, threadId: `t-${a.userId}`, reply: `«${k}» ok`, ...(replies ? replies({ message: a.message, n: k, userId: a.userId }) : {}) } as any;
  };
  const deliver = async (a: { userId: string; key: string; now: number }) => {
    const s = W.delivery({ only: { userId: a.userId, key: a.key } });
    const r = await deliverDue({ store: s, adapters, now: a.now, clock: () => clock.t }); await s.release(); return r;
  };
  const cron = async () => { const s = W.delivery(); const r = await deliverDue({ store: s, adapters, now: clock.t, limit: 100, clock: () => clock.t }); await s.release(); return r; };
  // Every minute for `minutes` minutes (the deployment's schedule), so a row waiting out a retry_after or a backoff goes.
  const cronFor = async (minutes: number) => { for (let i = 0; i < minutes; i++) { clock.t += 60000; await cron(); } };
  const adapterOf = (e: { get(k: string): string | undefined }) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "",
    fetch: B.fetch, clock: () => clock.t, sleep, native: textingNativeOn(e) });
  const pd = { env, now: () => clock.t, store: () => W.inbound, chat, deliver, adapter: adapterOf };
  const J = jobStores();
  const jd = (): JobDeps => ({ store: J.store, cards: J.cards as any, tap: J.tap, now: () => clock.t, env, events: null, facts: async () => [] });
  const post = async (u: unknown, raw?: string) => {
    clock.t += 1000;
    const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: raw ?? JSON.stringify(u) });
    const adapter = adapterOf(env);
    const core = { ...webhookDeps(adapter, pd as any),
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
  return { W, clock, B, env, vars, adapters, turns, cron, cronFor, post, from, userOf, known, optedOut, J, jd, adapterOf, chat, setReplies: (f: typeof replies) => { replies = f; } };
}
export type World = ReturnType<typeof world>;
