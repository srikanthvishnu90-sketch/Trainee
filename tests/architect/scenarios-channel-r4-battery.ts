// Channel delivery round 4 (2026-11-05): the seeded battery behind scenarios-channel-r4.test.ts. A model of career_outbox and
// channel_contacts with the database's own states and rules (the claim's parts order, "sending" until marked, the sweep, the
// release, the reroute of a channel that was unlinked, a STOP kept when its chat is unlinked), the REAL deliverDue (channel.ts) and the REAL adapters (telegram.ts,
// whatsapp.ts, loopmessage_adapter.ts) over fake provider APIs at the fetch boundary, on a virtual clock (a pacing wait moves
// the clock, never the wall). Each scenario is a few people on one or two channels, a queue of answers in parts and of what
// Trainee starts on its own, and a fault plan: providers answering with every shape of error, the person saying STOP or
// blocking the bot, a channel unlinked or a home channel switched, the time zone moved, the database refusing a write mid-run,
// two runs at once. Then it is read back against strict invariants (see check()).
//
// Nothing here calls a network or a model; the "secrets" are built at runtime from the seed.
import { deliverDue, type ChannelStore, type DeliveryMark, isReply, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { channelOf, type Channel, type DeliveryAdapter } from "../../supabase/functions/_shared/channel_adapters.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { whatsappAdapter } from "../../supabase/functions/_shared/whatsapp.ts";
import { loopMessageAdapter } from "../../supabase/functions/_shared/loopmessage_adapter.ts";
import { OUTBOX_CHARS } from "../../supabase/functions/_shared/conversation.ts";
import { quietAt, zoneOr } from "../../supabase/functions/_shared/career_alerts.ts";
import { SENDING_TIMEOUT_MS, UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";

export const T0 = Date.parse("2026-11-05T15:00:00Z");
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { next, int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}
type R = ReturnType<typeof rng>;

// ------------------------------------------------------------------------------------------------------- the model store
type Status = "queued" | "sending" | "delivered" | "failed" | "skipped_opt_out" | "held";
export interface Row {
  id: string; userId: string; key: string; text: string; channel: Channel | null; partOf: string | null; part: number | null;
  deliverAt: number; status: Status; attempts: number; retryAt: number | null; claimedAt: number | null; contact: string | null;
  sentParts: number; providerIds: string[]; error: string | null; deliveredAt: number | null; heldAt: number | null;
}
export interface Contact { contact: string; userId: string; home: boolean; optedOut: boolean; optedOutAt: number | null; lastInboundAt: number | null; nudgedAt: number | null }
export interface Model {
  rows: Row[]; contacts: Map<string, Contact>; zones: Map<string, { tz: string; quiet_start: number; quiet_end: number }>; faults: { markFails: number; readFails: number };
  // every STOP / START with its time (by: the person between runs, or the product on a provider's block during one); the rows
  // and contacts a refused database call was about (the row whose own handling failed stays "sending" for the sweep)
  optLog: { userId: string; at: number; out: boolean; by: "person" | "product" }[]; culprits: Set<string>;
}

const target = (m: Model, userId: string, ch: Channel | null): string | null => {
  const mine = [...m.contacts.values()].filter((c) => c.userId === userId);
  if (ch) return mine.find((c) => channelOf(c.contact) === ch)?.contact ?? null;
  return (mine.find((c) => c.home) ?? mine[0])?.contact ?? null;
};
const waiting = (e: Row, now: number) => e.status === "sending" || e.status === "held" || (e.status === "failed" && e.retryAt !== null && e.retryAt > now) || (e.status === "queued" && e.deliverAt > now);
const claimable = (o: Row, now: number) => o.deliverAt <= now && (o.status === "queued" || (o.status === "failed" && o.retryAt !== null && o.retryAt <= now));

// One store instance per run, as supabaseChannelStore is: its own claimed rows, the shared model under it.
export function modelStore(m: Model, scope: { only?: { userId: string; key: string }; user?: string } = {}) {
  const claimed = new Map<string, Status>();
  const refuse = (what: string, about: string) => { if (m.faults.readFails > 0) { m.faults.readFails--; m.culprits.add(about); throw new Error(`${what}: connection reset`); } };
  const store: ChannelStore & { release(): Promise<number>; sweep(now: number): Promise<number>; reroute(now: number): Promise<number> } = {
    async due(now, limit) {
      const cand = m.rows.filter((o) => (scope.only ? o.userId === scope.only.userId && o.key === scope.only.key : scope.user ? o.userId === scope.user : true)
        && claimable(o, now) && target(m, o.userId, o.channel) !== null
        && (o.part === null || !m.rows.some((e) => e.userId === o.userId && e.partOf === o.partOf && e.part! < o.part! && (scope.only ? (e.status === "queued" || waiting(e, now) || (e.status === "failed" && e.retryAt !== null)) : waiting(e, now)))))
        .sort((a, b) => a.deliverAt - b.deliverAt || Number(a.id) - Number(b.id)).slice(0, limit);
      const due = cand.filter((c) => c.part === null || !m.rows.some((e) => e.userId === c.userId && e.partOf === c.partOf && e.part! < c.part! && (e.status === "queued" || (e.status === "failed" && e.retryAt !== null)) && !cand.includes(e)));
      return due.map((o) => {
        claimed.set(o.id, o.status);
        o.status = "sending"; o.claimedAt = now; o.contact = target(m, o.userId, o.channel);
        const c = m.contacts.get(o.contact!)!;
        const wa = o.contact!.startsWith("wa:");
        return { id: o.id, userId: o.userId, contact: o.contact!, key: o.key, text: o.text, deliver_at: o.deliverAt, attempts: o.attempts,
          ...(wa ? { lastInboundAt: c.lastInboundAt, nudgedAt: c.nudgedAt, heldAt: o.heldAt } : {}), ...(o.sentParts > 0 ? { sentParts: o.sentParts, sentIds: [...o.providerIds] } : {}),
          ...(o.attempts > 0 ? { lastError: o.error } : {}) } as OutboxRow; // as supabaseChannelStore reads it for a row tried before
      });
    },
    async optedOut(contact) {
      refuse("read opt-out", contact);
      const own = m.contacts.get(contact);
      return own ? [...m.contacts.values()].some((c) => c.userId === own.userId && c.optedOut) : false;
    },
    async optedOutAt(contact) {
      const own = m.contacts.get(contact);
      const at = own ? [...m.contacts.values()].filter((c) => c.userId === own.userId && c.optedOut && c.optedOutAt !== null).map((c) => c.optedOutAt!) : [];
      return at.length ? Math.max(...at) : null;
    },
    async stillTheirs(userId, contact) { return m.contacts.get(contact)?.userId === userId; },
    async quietHours(userId) { const z = m.zones.get(userId); return z ? { tz: z.tz, quiet_start: z.quiet_start, quiet_end: z.quiet_end } : null; },
    async setOptOut(contact, out, at) { const c = m.contacts.get(contact); if (c) { c.optedOut = out; c.optedOutAt = out ? at : null; m.optLog.push({ userId: c.userId, at, out, by: "product" }); } },
    async contactsSentOn(day, ch) { return new Set(m.rows.filter((o) => o.status === "delivered" && o.deliveredAt !== null && new Date(o.deliveredAt).toISOString().slice(0, 10) === day && (!ch || channelOf(o.contact!) === ch)).map((o) => o.contact)).size; },
    async sentTo(contact, day) { return m.rows.some((o) => o.contact === contact && o.status === "delivered" && o.deliveredAt !== null && new Date(o.deliveredAt).toISOString().slice(0, 10) === day); },
    async mark(id, k: DeliveryMark) {
      if (m.faults.markFails > 0) { m.faults.markFails--; m.culprits.add(id); throw new Error("record delivery: connection reset"); }
      const o = m.rows.find((x) => x.id === id)!;
      if (o.status !== "sending") return; // .eq("status", "sending")
      o.claimedAt = null; o.error = k.error ? k.error.slice(0, 500) : null;
      if (k.status === "delivered") { o.status = "delivered"; o.deliveredAt = k.at; o.retryAt = null; o.providerIds = (k.providerIds ?? []).slice(0, 10); o.sentParts = 0; if (k.text !== undefined) o.text = k.text; }
      else if (k.status === "failed") { o.status = "failed"; o.attempts++; o.retryAt = k.retryAt ?? null; if (k.sentParts !== undefined) { o.sentParts = k.sentParts; o.providerIds = (k.providerIds ?? []).slice(0, 10); } }
      else if (k.status === "queued") { o.status = "queued"; o.contact = null; o.retryAt = null; if (k.deliverAt) o.deliverAt = k.deliverAt; }
      else { o.status = k.status; o.retryAt = null; if (k.status === "held") o.heldAt ??= k.at; if (k.sentParts !== undefined) { o.sentParts = k.sentParts; o.providerIds = (k.providerIds ?? []).slice(0, 10); } }
      claimed.delete(id);
    },
    async heldFor(userId) { return m.rows.filter((o) => o.userId === userId && ["held", "queued", "sending"].includes(o.status)).length; },
    async claimTemplate(contact, _day, _cap, at) { const c = m.contacts.get(contact); if (c) c.nudgedAt = at; return true; },
    async unclaimTemplate(contact, at) { const c = m.contacts.get(contact); if (c && c.nudgedAt === at) c.nudgedAt = null; },
    async putBack(ids) {
      let n = 0;
      for (const id of ids) { const prior = claimed.get(id); const o = m.rows.find((x) => x.id === id)!; if (prior === undefined || o.status !== "sending") continue; o.status = prior; o.claimedAt = null; o.contact = null; claimed.delete(id); n++; }
      return n;
    },
    async release() { return await store.putBack!([...claimed.keys()]); },
    async sweep(now) {
      let n = 0;
      for (const o of m.rows) if (o.status === "sending" && o.claimedAt !== null && o.claimedAt < now - SENDING_TIMEOUT_MS) { o.status = "failed"; o.retryAt = null; o.claimedAt = null; o.error = UNKNOWN_OUTCOME; n++; }
      return n;
    },
    async reroute(_now) {
      let n = 0;
      for (const o of m.rows) {
        if (!o.channel || !(o.status === "queued" || o.status === "held" || (o.status === "failed" && o.retryAt !== null))) continue;
        const mine = [...m.contacts.values()].filter((c) => c.userId === o.userId);
        if (mine.some((c) => channelOf(c.contact) === o.channel)) continue;
        if (mine.length) { o.channel = null; if (o.status === "held") o.status = "queued"; o.sentParts = 0; o.providerIds = []; }
        else { o.status = "failed"; o.retryAt = null; o.claimedAt = null; o.error = "not sent: the channel this answers was unlinked and the person has no other texting channel"; }
        n++;
      }
      return n;
    },
  };
  return store;
}

// ------------------------------------------------------------------------------------------------------- the providers
export type Fault = "ok" | "429ra" | "429long" | "429bare" | "502" | "503" | "500acc" | "504acc" | "timeout" | "refused" | "malformed200" | "error200" | "403blocked" | "400migrated" | "401" | "190";
export interface Call { t: number; channel: Channel; to: string; text: string; accepted: boolean; fault: Fault; runNow: number }
type Zone = { tz: string; quiet_start: number; quiet_end: number };
export interface World {
  m: Model; r: R; clock: { t: number }; calls: Call[]; logs: string[]; runNow: number;
  tokens: { tg: string; wa: string; lm: string };
  faultFor(channel: Channel, to: string): Fault;
  authDownUntil: Partial<Record<Channel, number>>; blocked: Set<string>; migrated: Set<string>;
  violations: string[]; zonesAt: Map<number, Map<string, Zone>>;
}
const j = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const TOKEN_RE = /r(\d+)w(\d+)/g;
let seqId = 0;
export function providers(w: World): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const b = JSON.parse(String(init?.body ?? "{}"));
    const channel: Channel = u.host === "api.telegram.org" ? "telegram" : u.host === "graph.facebook.com" ? "whatsapp" : u.host === "a.loopmessage.com" ? "imessage" : (() => { throw new TypeError(`network refused: ${u.host}`); })();
    if (channel === "telegram" && !u.pathname.endsWith("/sendMessage")) return j({ ok: true, result: true });
    if (channel === "whatsapp" && b.type === "template") return j({ messages: [{ id: `wamid.t${++seqId}` }] });
    if (channel === "whatsapp" && b.status === "read") return j({ success: true });
    const to = String(channel === "telegram" ? b.chat_id : channel === "whatsapp" ? b.to ?? b.recipient : b.contact);
    const text = String(channel === "telegram" ? b.text : channel === "whatsapp" ? b.text?.body : b.text);
    const key = channel === "telegram" ? `tg:${to}` : channel === "whatsapp" ? `wa:${to}` : to;
    // the credentials (built at runtime): a call with any other is a bug of the test, never of the product
    const auth = channel === "telegram" ? u.pathname.includes(`/bot${w.tokens.tg}/`) : String((init?.headers as Record<string, string>)?.Authorization ?? "").includes(channel === "whatsapp" ? w.tokens.wa : w.tokens.lm);
    if (!auth) w.violations.push(`a ${channel} call without the configured credentials`);
    let fault: Fault = (w.authDownUntil[channel] ?? -Infinity) > w.clock.t ? (channel === "whatsapp" ? "190" : "401") : w.blocked.has(key) ? "403blocked" : w.migrated.has(key) ? "400migrated" : w.faultFor(channel, key);
    if (channel !== "telegram" && (fault === "403blocked" || fault === "400migrated" || fault === "error200")) fault = "ok";
    if (channel === "imessage" && fault === "190") fault = "401";
    const accepted = fault === "ok" || fault === "500acc" || fault === "504acc" || fault === "timeout" || fault === "malformed200";
    w.calls.push({ t: w.clock.t, channel, to: key, text, accepted, fault, runNow: w.runNow });
    if (fault === "403blocked") w.blocked.add(key);
    if (fault === "400migrated") w.migrated.add(key);
    const id = String(++seqId);
    switch (fault) {
      case "ok": return channel === "telegram" ? j({ ok: true, result: { message_id: Number(id) } }) : channel === "whatsapp" ? j({ messages: [{ id: `wamid.${id}` }] }) : j({ message_id: `lm-${id}`, success: true });
      case "429ra": return channel === "telegram" ? j({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, 429) : j({ error: { code: 130429, message: "Rate limit hit" } }, 429);
      case "429long": return channel === "telegram" ? j({ ok: false, error_code: 429, description: "Too Many Requests: retry after 75", parameters: { retry_after: 75 } }, 429) : j({ error: { code: 80007, message: "Rate limit" } }, 400);
      case "429bare": return j(channel === "telegram" ? { ok: false, error_code: 429, description: "Too Many Requests" } : {}, 429);
      case "502": return j("<html>Bad Gateway</html>", 502);
      case "503": return j("Service Unavailable", 503);
      case "500acc": return j("Internal Server Error", 500);
      case "504acc": return j("Gateway Timeout", 504);
      case "timeout": throw new DOMException("The signal has been aborted", "TimeoutError");
      case "refused": throw new TypeError("error sending request: connection refused");
      case "malformed200": return new Response('{"ok":true,"result":{"message_id":', { status: 200 });
      case "error200": return j({ ok: false, error_code: 400, description: "Bad Request: message text is empty" });
      case "403blocked": return j({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403);
      case "400migrated": return j({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001234567890 } }, 400);
      case "401": return channel === "telegram" ? j({ ok: false, error_code: 401, description: "Unauthorized" }, 401) : j({ success: false, message: "Unauthorized" }, 401);
      case "190": return j({ error: { code: 190, type: "OAuthException", message: "Error validating access token: Session has expired" } }, 401);
    }
  }) as typeof fetch;
}

// ------------------------------------------------------------------------------------------------------- one scenario
export type Category = "errors" | "stop" | "channels" | "crash" | "quiet" | "long";
const EMOJI = ["👨‍👩‍👧‍👦", "🇺🇸", "🇮🇳", "👍🏽", "é", "नमस्ते", "😀", "🧑🏿‍💻", "✅"];
const ZONES = ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Sydney", "Pacific/Auckland", "America/Sao_Paulo"];
let rowSeq = 0;
// A row is at most what the outbox holds (OUTBOX_CHARS, 4,000: an answer longer than that is split into parts before it is
// queued, channel_inbound.ts replyParts), so every word of it must arrive.
function words(r: R, id: string, n: number, emoji: boolean): string {
  const out: string[] = [];
  let len = 0;
  const add = (x: string) => { out.push(x); len += x.length + 1; };
  for (let k = 0; k < n && len < OUTBOX_CHARS - 80; k++) {
    add(`r${id}w${k}`);
    if (emoji && r.chance(0.35)) add(r.pick(EMOJI).repeat(r.int(1, 6)));
    if (r.chance(0.04)) add("\n\n"); else if (r.chance(0.05)) add("\n");
  }
  let text = out.join(" ").replace(/ ?\n ?/g, "\n");
  while (text.length > OUTBOX_CHARS) text = text.slice(0, text.lastIndexOf(" r"));
  return text;
}

export interface Outcome { category: Category; seed: number; violations: string[]; calls: number; rows: number }
export async function scenario(category: Category, seed: number): Promise<Outcome> {
  const r = rng(seed * 7919 + category.length);
  rowSeq = 0; seqId = 0; // each seed is the same scenario whatever ran before it
  const m: Model = { rows: [], contacts: new Map(), zones: new Map(), faults: { markFails: 0, readFails: 0 }, optLog: [], culprits: new Set() };
  const tag = (seed % 997).toString(36);
  const w: World = {
    m, r, clock: { t: T0 }, calls: [], logs: [], runNow: T0, violations: [], authDownUntil: {}, blocked: new Set(), migrated: new Set(),
    zonesAt: new Map(), tokens: { tg: `${seed}:tg-${tag}${"k".repeat(30)}`, wa: `wa-${tag}${"q".repeat(30)}`, lm: `lm-${tag}${"z".repeat(30)}` },
    faultFor: () => "ok",
  };
  const faults: Fault[] = category === "errors"
    ? ["ok", "ok", "ok", "429ra", "429long", "429bare", "502", "503", "500acc", "504acc", "timeout", "refused", "malformed200", "error200", "403blocked", "400migrated"]
    : category === "long" ? ["ok", "ok", "ok", "ok", "429ra", "timeout", "malformed200", "502"] : ["ok", "ok", "ok", "ok", "ok", "ok", "429ra", "502", "timeout"];
  const pFault = category === "errors" ? 0.35 : 0.12;
  w.faultFor = () => (r.chance(pFault) ? r.pick(faults) : "ok");
  // people and their channels
  const people = r.int(1, category === "channels" ? 3 : 4);
  const users: string[] = [];
  for (let p = 0; p < people; p++) {
    const u = `u${p}`; users.push(u);
    const chans = [...new Set([r.pick(["imessage", "telegram", "whatsapp"] as const), ...(category === "channels" || r.chance(0.3) ? [r.pick(["imessage", "telegram", "whatsapp"] as const)] : [])])];
    chans.forEach((ch, i) => {
      const n = 5550000000 + seed * 10 + p;
      const contact = ch === "imessage" ? `+1${n}` : ch === "telegram" ? `tg:${n}` : `wa:1${n}`;
      m.contacts.set(contact, { contact, userId: u, home: i === 0, optedOut: false, optedOutAt: null, lastInboundAt: ch === "whatsapp" ? T0 - (r.chance(0.85) ? r.int(1, 20) * HOUR : 30 * HOUR) : null, nudgedAt: null });
    });
    if (category === "quiet" || r.chance(0.3)) m.zones.set(u, { tz: r.pick(ZONES), quiet_start: r.pick([22, 21, 23, 0]), quiet_end: r.pick([7, 6, 8]) });
  }
  // the queue
  const long = category === "long";
  for (const u of users) {
    const mine = [...m.contacts.values()].filter((c) => c.userId === u).map((c) => channelOf(c.contact));
    for (let k = r.int(1, category === "crash" ? 6 : 4); k > 0; k--) {
      const reply = r.chance(0.55);
      const at = T0 - r.int(0, 20) * MIN;
      if (reply) {
        const ch = r.pick(mine), parts = r.int(1, long ? 2 : 3), of = `reply:${ch.slice(0, 2)}:${seed}-${u}-${k}`;
        for (let n = 1; n <= parts; n++) {
          const id = String(++rowSeq);
          const text = words(r, id, long ? r.int(200, 900) : r.int(3, 60), long || r.chance(0.4));
          m.rows.push({ id, userId: u, key: parts > 1 ? `${of}:${n}` : of, text, channel: ch, partOf: parts > 1 ? of : null, part: parts > 1 ? n : null, deliverAt: at, status: "queued", attempts: 0, retryAt: null, claimedAt: null, contact: null, sentParts: 0, providerIds: [], error: null, deliveredAt: null, heldAt: null });
        }
      } else {
        const id = String(++rowSeq);
        const kind = r.pick(["status", "receipt", "digest", "card", "followup"]);
        m.rows.push({ id, userId: u, key: `${kind}:${seed}-${u}-${k}`, text: words(r, id, long ? r.int(100, 600) : r.int(3, 40), long || r.chance(0.3)), channel: null, partOf: null, part: null, deliverAt: at, status: "queued", attempts: 0, retryAt: null, claimedAt: null, contact: null, sentParts: 0, providerIds: [], error: null, deliveredAt: null, heldAt: null });
      }
    }
  }
  const native = r.chance(0.5);
  const capped = r.chance(0.15);
  const adapters = (): Partial<Record<Channel, DeliveryAdapter>> => {
    const f = providers(w), sleep = async (ms: number) => { w.clock.t += Math.max(0, ms); };
    return {
      telegram: telegramAdapter({ token: w.tokens.tg, fetch: f, clock: () => w.clock.t, sleep, native }),
      whatsapp: whatsappAdapter({ token: w.tokens.wa, phoneNumberId: "1", fetch: f, clock: () => w.clock.t, sleep, native, template: { name: "updates_waiting", language: "en_US" } }),
      imessage: loopMessageAdapter({ apiKey: w.tokens.lm, fetch: f, sleep, native, dailyContacts: capped ? 1 : 300 }),
    };
  };
  // the run: sweep, reroute, the delivery itself (sometimes two at once), the release; the events between runs
  // A contact unlinked (Telegram unlink, a WhatsApp number released): the row leaves the person, and its STOP stays on the
  // contacts they still have (channel_contacts_keep_stop, 20261105160000_channel_delivery_r4.sql).
  const unlink = (gone: Contact) => {
    m.contacts.delete(gone.contact);
    if (gone.optedOut) for (const c of m.contacts.values()) if (c.userId === gone.userId && !c.optedOut) { c.optedOut = true; c.optedOutAt = gone.optedOutAt; }
  };
  const origError = console.error, origLog = console.log;
  console.error = (...a: unknown[]) => { w.logs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { w.logs.push(a.map(String).join(" ")); };
  try {
    const runs = category === "long" ? 40 : 60;
    for (let i = 0; ; i++) {
      // events, until the last runs (which only drain the queue)
      const calm = i >= runs - 16;
      if (calm) { m.faults.markFails = 0; m.faults.readFails = 0; }
      if (!calm) if ((category === "stop" && r.chance(0.15)) || (category === "channels" && r.chance(0.04))) { const u = r.pick(users); const c = [...m.contacts.values()].find((x) => x.userId === u); if (c && !c.optedOut) { c.optedOut = true; c.optedOutAt = w.clock.t; m.optLog.push({ userId: u, at: w.clock.t, out: true, by: "person" }); } }
      if (!calm) if (category === "stop" && r.chance(0.05)) { for (const c of m.contacts.values()) if (c.optedOut && r.chance(0.3)) { c.optedOut = false; c.optedOutAt = null; if (![...m.contacts.values()].some((x) => x.userId === c.userId && x.optedOut)) m.optLog.push({ userId: c.userId, at: w.clock.t, out: false, by: "person" }); } }
      if (!calm) if (category === "channels" && r.chance(0.1)) {
        const u = r.pick(users), mine = [...m.contacts.values()].filter((c) => c.userId === u);
        if (mine.length > 1 && r.chance(0.5)) { const gone = r.pick(mine); unlink(gone); if (gone.home) mine.find((c) => c !== gone)!.home = true; }
        else if (mine.length > 1) { for (const c of mine) c.home = false; r.pick(mine).home = true; }
        else if (mine.length && r.chance(0.3)) unlink(mine[0]); // unlinked, nothing left
      }
      if (!calm) if (category === "channels" && r.chance(0.05)) { const c = r.pick([...m.contacts.values()]); if (c && c.contact.startsWith("wa:")) c.lastInboundAt = w.clock.t; for (const o of m.rows) if (o.status === "held" && o.userId === c?.userId) o.status = "queued"; }
      if (!calm) if (category === "quiet" && r.chance(0.1)) { const u = r.pick(users); const z = m.zones.get(u); if (z) z.tz = r.pick(ZONES); }
      if (!calm) if (category === "crash" && r.chance(0.25)) m.faults.markFails = 1;
      if (!calm) if (category === "crash" && r.chance(0.1)) m.faults.readFails = 1;
      if (!calm) if ((category === "errors" || category === "crash") && r.chance(0.04)) { const ch = r.pick(["telegram", "whatsapp", "imessage"] as const); w.authDownUntil[ch] = w.clock.t + r.int(2, 30) * MIN; }
      const now = w.clock.t;
      w.runNow = now;
      w.zonesAt.set(now, new Map([...m.zones].map(([k, z]) => [k, { ...z }])));
      const one = async (scope: Parameters<typeof modelStore>[1], limit: number, concurrency: number, down?: Set<Channel>) => {
        const store = modelStore(m, scope);
        try { await deliverDue({ store, adapters: adapters(), now, limit, clock: () => w.clock.t, budgetMs: 100_000, concurrency, ...(down ? { down } : {}) }); await store.release(); }
        catch { /* a failed run: what it handed to a provider stays "sending" for the sweep; deliverDue put back the rest */ }
      };
      const sched = async () => {
        const store = modelStore(m);
        await store.sweep(now); await store.reroute(now);
        const down = new Set<Channel>();
        for (let round = 0; round < 3; round++) { await one({}, r.int(2, 30), r.int(1, 4), down); }
      };
      if (r.chance(0.25)) {
        const u = r.pick(users), k = m.rows.find((o) => o.userId === u && isReply(o.key) && o.status === "queued");
        await Promise.all([sched(), k ? one({ only: { userId: u, key: k.key } }, 1, 1) : one({ user: u }, 40, 1)]);
      } else await sched();
      w.clock.t = Math.max(w.clock.t, now) + r.int(20, 90) * 1000;
      if (i === runs - 15) w.clock.t += SENDING_TIMEOUT_MS + 2 * MIN; // the sweep gets its turn
      if (i === runs - 8) w.clock.t += DAY; // a new day (the daily cap, quiet hours) and every credential working again
      // the drain: past the planned runs, keep going (to the next row's time) while something still waits for a retry or its time
      if (i >= runs - 1) {
        const next = m.rows.filter((o) => (o.status === "failed" && o.retryAt !== null) || (o.status === "queued" && o.deliverAt > w.clock.t)).map((o) => o.status === "failed" ? o.retryAt! : o.deliverAt);
        if (!next.length || i > runs + 40) break;
        w.clock.t = Math.max(w.clock.t, Math.min(...next));
      }
    }
  } finally { console.error = origError; console.log = origLog; }
  check(w, category, capped);
  return { category, seed, violations: w.violations, calls: w.calls.length, rows: m.rows.length };
}

// ------------------------------------------------------------------------------------------------------- the invariants
function check(w: World, category: Category, capped: boolean) {
  const v = (s: string) => w.violations.push(s);
  const byRow = new Map<string, { pos: number; accepted: boolean; channel: Channel; t: number; to: string; call: Call }[]>();
  const LIMIT: Record<Channel, number> = { telegram: 4096, whatsapp: 4096, imessage: 5000 };
  for (const c of w.calls) {
    if (c.text.length > LIMIT[c.channel]) v(`${c.channel} message of ${c.text.length} characters (limit ${LIMIT[c.channel]})`);
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.text)) v(`${c.channel} message with half a character`);
    if (!c.text.trim()) v(`an empty ${c.channel} message`);
    for (const t of c.text.matchAll(TOKEN_RE)) { const id = t[1]; (byRow.get(id) ?? byRow.set(id, []).get(id)!).push({ pos: Number(t[2]), accepted: c.accepted, channel: c.channel, t: c.t, to: c.to, call: c }); }
  }
  for (const o of w.m.rows) {
    const got = byRow.get(o.id) ?? [];
    const total = (o.text.match(TOKEN_RE) ?? []).length;
    // I1 at most once, in order: the accepted words of a row, per channel it went on, strictly increasing
    const acc = got.filter((g) => g.accepted);
    const perChannel = new Map<Channel, number[]>();
    for (const g of acc) (perChannel.get(g.channel) ?? perChannel.set(g.channel, []).get(g.channel)!).push(g.pos);
    for (const [ch, ps] of perChannel) for (let i = 1; i < ps.length; i++) if (ps[i] <= ps[i - 1]) { v(`row ${o.key}: word ${ps[i]} arrived again or out of order on ${ch} (after ${ps[i - 1]})`); break; }
    // I2 never lost: a delivered row arrived whole on some channel; every row ends in a state that says what happened
    if (o.status === "delivered" && ![...perChannel.values()].some((ps) => new Set(ps).size === total)) v(`row ${o.key} marked delivered with ${Math.max(0, ...[...perChannel.values()].map((ps) => new Set(ps).size))} of ${total} words accepted`);
    if ((o.status === "failed" || o.status === "skipped_opt_out") && !o.error) v(`row ${o.key} ${o.status} with no reason`);
    if (o.status === "sending") v(`row ${o.key} left sending`);
    // (a row for a person with no texting channel left waits in the outbox, as a web-only person's do, for a channel)
    if (o.status === "failed" && o.retryAt !== null && !capped && target(w.m, o.userId, o.channel) !== null) v(`row ${o.key} still waiting for a retry at the end`);
    // B1: a row the sweep failed as "outcome unknown" was handed to a provider, or the database refused to record it (its own
    // mark threw); never a row the run claimed and never reached
    if (o.status === "failed" && o.error === UNKNOWN_OUTCOME && got.length === 0 && !w.m.culprits.has(o.id)) v(`row ${o.key} failed as "outcome unknown" though no provider was ever asked to send it (${category})`);
    // (a part waits behind an earlier part WhatsApp's window holds: it goes out with it, when the person next writes)
    const behindHeld = o.partOf !== null && w.m.rows.some((e) => e.partOf === o.partOf && e.userId === o.userId && e.part! < o.part! && e.status === "held");
    if (o.status === "queued" && !capped && !behindHeld) {
      const t = target(w.m, o.userId, o.channel);
      if (t !== null && o.deliverAt <= w.clock.t - DAY) v(`row ${o.key} queued at the end with a channel to send on (${t})`);
    }
    for (const g of got) {
      // I4 nothing to a chat that is not the person's: every call went to a contact the row's person holds or held
      const c = w.m.contacts.get(g.to);
      if (c && c.userId !== o.userId) v(`row ${o.key} of ${o.userId} sent to ${g.to}, which is ${c.userId}'s`);
      if (/-100/.test(g.to)) v(`row ${o.key} sent to a migrated chat id ${g.to}`);
    }
    // a row of a provider's 401 / 190 never ends failed for it
    if (o.status === "failed" && /HTTP 401|\(190\)/.test(o.error ?? "")) v(`row ${o.key} failed for good on the provider refusing the credentials: ${o.error}`);
    // a 200 that could not be read (no description: not a refusal) never ends a row as failed
    if (o.status === "failed" && /HTTP 200(:\s*)?( after \d+ of \d+ \w+ went out)?$/.test(o.error ?? "")) v(`row ${o.key} failed on a 200 the provider answered: ${o.error}`);
  }
  // I5 STOP: nothing Trainee starts after the person's STOP (or block) as it stood at the call; an answer only to a message after it.
  // Read from the calls against the opt-out log the model keeps: the contact's optedOutAt at the end bounds every call after it.
  for (const c of w.calls) {
    const rowId = /r(\d+)w/.exec(c.text)?.[1];
    const o = rowId ? w.m.rows.find((x) => x.id === rowId) : undefined;
    if (!o) continue;
    // the person's STOP as it stood when the run began (a block the product recorded during that same run may race a run beside it)
    const log = w.m.optLog.filter((x) => x.userId === o.userId && (x.by === "person" ? x.at <= c.runNow : x.at < c.runNow));
    const last = log[log.length - 1];
    if (last?.out) {
      const since = Math.max(...log.filter((x) => x.out).map((x) => x.at));
      if (!isReply(o.key) || o.deliverAt <= since) v(`row ${o.key} sent at ${new Date(c.t).toISOString()} after STOP at ${new Date(since).toISOString()}`);
    }
    // quiet hours on the person's clock as it was when the run looked (the run's start)
    const z = w.zonesAt.get(c.runNow)?.get(o.userId);
    if (z && /^(status|receipt|digest|followup|alert|report|brief):/.test(o.key) && quietAt(c.runNow, zoneOr(z.tz), z)) v(`row ${o.key} sent in quiet hours (${z.tz} ${z.quiet_start}-${z.quiet_end} at ${new Date(c.runNow).toISOString()})`);
  }
  // I7 nothing private in a log or a recorded reason: no words of a message, no credential
  const secrets = [w.tokens.tg, w.tokens.wa, w.tokens.lm];
  for (const line of [...w.logs, ...w.m.rows.map((o) => o.error ?? "")]) {
    if (TOKEN_RE.test(line)) v(`a message's words in a log or reason: ${line.slice(0, 120)}`);
    TOKEN_RE.lastIndex = 0;
    for (const s of secrets) if (line.includes(s)) v(`a credential in a log or reason: ${line.slice(0, 60)}`);
  }
}

// The battery as the two test files run it: each category's seeds 1..n, every violation reported (the first dozen).
export async function battery(plan: [Category, number][], label: string) {
  const started = Date.now(), out: string[] = [];
  let total = 0, calls = 0;
  for (const [cat, n] of plan) {
    let bad = 0;
    for (let seed = 1; seed <= n; seed++) {
      const o = await scenario(cat, seed);
      total++; calls += o.calls;
      if (o.violations.length) { bad++; if (out.length < 12) out.push(`${cat} seed ${seed}: ${o.violations.slice(0, 2).join(" | ")}`); }
    }
    console.log(`[channel-r4${label}] ${cat}: ${n} scenarios, ${bad} failed`);
  }
  console.log(`[channel-r4${label}] ${total} scenarios, ${calls} provider calls, ${Date.now() - started} ms`);
  if (out.length) throw new Error(`invariants broken:\n${out.join("\n")}`);
}

