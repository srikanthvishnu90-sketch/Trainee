// Channel delivery round 2 (2026-10-30): 10,600 generated scenarios (tests/architect/scenarios/channel-r2-generator.ts,
// seeded) on WhatsApp, iMessage/SMS (LoopMessage), across a person's channels, and the two leftovers of round 1 and of the
// Telegram round (crossing markdown; a 429 asking for more than 30 s on message 2+ of a row). Every scenario runs the real
// code end to end in memory: the real webhooks (trainee-whatsapp's handleWhatsApp, signed; trainee-telegram's
// handleTelegram; trainee-inbound's handleInbound), the real inbound core (channel_inbound.ts), the real head-start
// deliverer and the real every-minute run (trainee-deliver's handleDeliver), every adapter built from the secrets as the
// deploy builds it (channel_registry.ts adaptersFromEnv, loopSend), over the memory database (channel_memory.ts, the rules
// of the SQL), with fake provider HTTP (Bot API, Graph API, LoopMessage) on a deterministic clock. No network, no model,
// no database. Every expectation comes from how the scenario was built:
//   - each row delivered once (a message of a row never twice), in order; nothing to an opted-out contact; nothing to
//     another person (a number given to someone else, a chat linked to someone else); honest states (a provider's "failed"
//     is never left "delivered"; a row that cannot go says why); no message lost silently (a row bound to a channel that
//     is gone goes home, or fails with the reason); formatting valid per channel;
//   - WhatsApp: no text outside Meta's window (counted from the person's own message time) nor inside Trainee's 10-minute
//     margin; the template's one parameter is the person's own count; media answered as on Telegram;
//   - LoopMessage: SMS keywords on SMS; groups and delivery callbacks never a turn; no key: honest NOT_WIRED, nothing lost.
// Run: deno test -A --no-check tests/architect/scenarios-channel-r2.test.ts
import assertNode from "node:assert/strict";
import { DAY, EVERYWHERE, generate, HOUR, META_WINDOW, MIN, PLAN, type Scenario, SMS_WORDS, T0, TRAINEE_WINDOW } from "./scenarios/channel-r2-generator.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { addressOf, type Channel } from "../../supabase/functions/_shared/channel_adapters.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { FILE_NOT_READ_REPLY, SIGNUP_CLOSED_REPLY, VOICE_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { formatForChannel, nativeRender } from "../../supabase/functions/_shared/channel_voice.ts";
import { toBubbles } from "../../supabase/functions/_shared/conversation.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261031 });
// R2_ONLY=<id,id...> runs only those scenarios (to look at one closely).
const ONLY = (() => { try { return new Set((Deno.env.get("R2_ONLY") ?? "").split(",").filter(Boolean).map(Number)); } catch { return new Set<number>(); } })();
const of = <K extends Scenario["kind"]>(k: K) => SCENARIOS.filter((s): s is Extract<Scenario, { kind: K }> => s.kind === k && (!ONLY.size || ONLY.has(s.id)));
// Secrets made at run time (no key-shaped string in a tracked file).
const mk = (p: string, n: number) => `${p}${"x".repeat(n)}`;
const TG_TOKEN = `${7000 + 1}:${mk("TeSt", 31)}`, TG_SECRET = mk("tgsecret_", 32), WA_APP = mk("app", 32), WA_VERIFY = mk("verify", 32);
const LM_KEY = mk("loop", 20), IN_SECRET = mk("insecret", 32), DELIVER_SECRET = mk("deliver", 32), WA_TOKEN = mk("watoken", 20);

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
      const key = `${s.category.split("/").slice(0, 2).join("/")}: ${why.replace(/\d{3,}|u\d+/g, "#").slice(0, 100)}`;
      if (!this.failures.has(key)) this.failures.set(key, []);
      this.failures.get(key)!.push({ s, why, got });
    }
  }
  assertClean() {
    const failed = new Set([...this.failures.values()].flat().map((f) => f.s.id)).size;
    const lines = [`[channel-r2] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failed`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 2)) lines.push(`    #${x.s.id} ${x.s.category}: ${x.why.slice(0, 300)} | got ${x.got.slice(0, 400)} | ${JSON.stringify(x.s).slice(0, 300)}`);
    }
    console.log(lines.join("\n"));
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${[...this.failures.keys()].slice(0, 6).join(" || ")}`);
  }
}

// ------------------------------------------------------------------------------------------------ fake providers
type Prov = "telegram" | "whatsapp" | "loopmessage";
type Sent = { prov: Prov; to: string; text: string; id: string; t: number };
type FailHook = (a: { prov: Prov; to: string; text: string; nth: number }) => Response | "network" | "timeout" | null;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function providers(clock: { t: number }) {
  const sent: Sent[] = [], templates: { to: string; body: any; t: number }[] = [], violations: string[] = [], calls = new Map<string, number>();
  const waTs = new Map<string, number>(); // the person's last WhatsApp message, by its own time (Meta's window runs from it)
  const tgBlocked = new Map<string, number>();
  let seq = 0;
  const P = {
    sent, templates, violations, waTs, tgBlocked, fail: null as FailHook | null,
    to: (prov: Prov, to: string) => sent.filter((x) => x.prov === prov && x.to === to),
    fetch: (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      const attempt = (prov: Prov, to: string, text: string) => {
        const k = `${prov}|${to}|${text}`, n = calls.get(k) ?? 0;
        calls.set(k, n + 1);
        const f = P.fail?.({ prov, to, text, nth: n }) ?? null;
        if (f === "network") throw new TypeError("connection refused");
        if (f === "timeout") { sent.push({ prov, to, text, id: `maybe-${++seq}`, t: clock.t }); throw new DOMException("timed out", "TimeoutError"); }
        return f;
      };
      if (u.host === "api.telegram.org") {
        const method = u.pathname.split("/").pop();
        if (method !== "sendMessage") return json({ ok: true, result: method === "sendChatAction" ? true : { message_id: ++seq } });
        const to = String(b.chat_id), text = String(b.text);
        const until = tgBlocked.get(to);
        if (until !== undefined && clock.t < until) violations.push(`a sendMessage to ${to} ${until - clock.t} ms before its retry_after ended`);
        const f = attempt("telegram", to, text);
        if (f) return f;
        const id = String(++seq);
        sent.push({ prov: "telegram", to, text, id, t: clock.t });
        return json({ ok: true, result: { message_id: Number(id) } });
      }
      if (u.host === "graph.facebook.com") {
        if (b.status === "read") return json({ success: true });
        const to = String(b.to ?? b.recipient ?? "");
        if (b.type === "template") { templates.push({ to, body: b, t: clock.t }); return json({ messages: [{ id: `wamid.t${++seq}` }] }); }
        const text = String(b.text?.body ?? "");
        const f = attempt("whatsapp", to, text);
        if (f) return f;
        const ts = waTs.get(to);
        if (ts === undefined || clock.t - ts >= META_WINDOW) { violations.push(`a text to ${to} outside WhatsApp's window (${ts === undefined ? "never wrote" : `${clock.t - ts} ms after their message`})`); return json({ error: { code: 131047, message: "Re-engagement message" } }, 400); }
        const id = `wamid.${++seq}`;
        sent.push({ prov: "whatsapp", to, text, id, t: clock.t });
        return json({ messages: [{ id }] });
      }
      if (u.host === "a.loopmessage.com") {
        const to = String(b.contact), text = String(b.text);
        const f = attempt("loopmessage", to, text);
        if (f) return f;
        const id = `lm-${++seq}`;
        sent.push({ prov: "loopmessage", to, text, id, t: clock.t });
        return json({ message_id: id, success: true });
      }
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch,
  };
  return P;
}
const PROV: Record<Channel, Prov> = { telegram: "telegram", whatsapp: "whatsapp", imessage: "loopmessage" };

// ------------------------------------------------------------------------------------------------ one world
type Brain = (a: { userId: string; message: string }) => { reply: string; parts?: string[] };
const defaultBrain: Brain = (a) => {
  const n = Number(/parts=(\d+)/.exec(a.message)?.[1] ?? "1"), tag = `[${a.userId}] ${a.message.replace(/ parts=\d+/, "")}`;
  if (n > 1) { const parts = Array.from({ length: n }, (_, i) => `${tag} part ${i + 1} of ${n}`); return { reply: parts[0], parts }; }
  return { reply: `${tag} answered` };
};
function world(o: { env?: Record<string, string | undefined>; brain?: Brain } = {}) {
  const W = memoryChannelWorld();
  const clock = { t: T0 };
  const P = providers(clock);
  const vars: Record<string, string | undefined> = {
    TRAINEE_DELIVER_SECRET: DELIVER_SECRET, TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: LM_KEY, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
    TELEGRAM_BOT_USERNAME: "TraineeTestBot", WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_TEMPLATE_UPDATES: "updates_waiting", TRAINEE_SIGNUP: "closed", ...o.env,
  };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  const adapters = () => adaptersFromEnv(env, { fetch: P.fetch, clock: () => clock.t, sleep });
  const chats: { userId: string; message: string }[] = [];
  const brain = o.brain ?? defaultBrain;
  const chat = async (a: any) => { chats.push({ userId: a.userId, message: a.message }); return { status: 200, threadId: `t-${a.userId}`, ...brain(a) } as any; };
  const head = async (a: { userId: string; key?: string; now: number; wholeUser?: boolean }) => {
    const s = W.delivery(a.wholeUser ? { user: a.userId } : { only: { userId: a.userId, key: a.key! } });
    const r = await deliverDue({ store: s, adapters: adapters(), now: a.now, limit: a.wholeUser ? 40 : 1 });
    await s.release();
    return r;
  };
  const runs: any[] = [];
  const run = async () => {
    const res = await handleDeliver(new Request("https://fn.test/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": DELIVER_SECRET } }), {
      env, now: () => clock.t, store: () => W.delivery(), send: (k) => loopSend({ apiKey: k, fetch: P.fetch, sleep }),
      adapters: (e) => adaptersFromEnv(e, { fetch: P.fetch, clock: () => clock.t, sleep }), recordRun: async () => {},
    });
    const body = await res.json();
    runs.push({ status: res.status, ...body });
    return { status: res.status, body };
  };
  const waAdapter = (e: { get(k: string): string | undefined }) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: e.get("WHATSAPP_PHONE_NUMBER_ID") || "", appSecret: e.get("WHATSAPP_APP_SECRET") || "",
    verifyToken: e.get("WHATSAPP_VERIFY_TOKEN") || "", fetch: P.fetch, clock: () => clock.t, sleep });
  const tgAdapter = (e: { get(k: string): string | undefined }) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: P.fetch, clock: () => clock.t, sleep });
  let mid = 0;
  // WhatsApp: a signed webhook POST carrying messages and/or statuses.
  const waPost = async (value: Record<string, unknown>) => {
    const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, ...value } }] }] }));
    const req = new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw });
    const res = await handleWhatsApp(req, { env, now: () => clock.t, store: () => W.inbound, chat, deliver: (a) => head({ userId: a.userId, now: a.now, wholeUser: true }), adapter: waAdapter });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // A message from the person, sent at `ts` (their clock, as Meta stamps it); Meta's window opens from then.
  const waText = async (a: { from: string | null; userId?: string | null; text?: string; ts?: number; type?: string; extra?: Record<string, unknown> }) => {
    const ts = a.ts ?? clock.t, type = a.type ?? "text";
    for (const id of [a.from, a.userId]) if (id) P.waTs.set(id, Math.max(P.waTs.get(id) ?? -Infinity, ts));
    const m: Record<string, unknown> = { id: `wamid.in${++mid}`, timestamp: String(Math.floor(ts / 1000)), type, ...(a.from ? { from: a.from } : {}), ...(a.userId ? { from_user_id: a.userId } : {}),
      ...(type === "text" ? { text: { body: a.text ?? "hi" } } : {}), ...a.extra };
    return await waPost({ contacts: [{ profile: { name: "T" }, ...(a.from ? { wa_id: a.from } : {}), ...(a.userId ? { user_id: a.userId } : {}) }], messages: [m] });
  };
  const waStatus = async (id: string, status: string, code?: number) =>
    await waPost({ statuses: [{ id, status, timestamp: String(Math.floor(clock.t / 1000)), recipient_id: "x", ...(status === "failed" ? { errors: [{ code, title: `error ${code}` }] } : {}) }] });
  let upd = 0;
  const tgText = async (chatId: number, text: string) => {
    const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
      body: JSON.stringify({ update_id: ++upd, message: { message_id: ++mid, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "T" }, date: Math.floor(clock.t / 1000), text } }) });
    const res = await handleTelegram(req, { env, now: () => clock.t, store: () => W.inbound, chat, deliver: (a) => head({ userId: a.userId, key: a.key, now: a.now }), adapter: tgAdapter });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const lmPost = async (body: Record<string, unknown>) => {
    const res = await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
      env, now: () => clock.t, store: () => W.inbound, send: (k) => loopSend({ apiKey: k, fetch: P.fetch, sleep }), chat,
      deliverReply: (a) => head({ userId: a.userId, key: a.key, now: a.now }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const lmText = async (from: string, text: string, extra: Record<string, unknown> = {}) => await lmPost({ alert_type: "message_inbound", message_id: `lm-in-${++mid}`, recipient: from, text, ...extra });
  // A person already known on some channels; at: their last message there (WhatsApp's window, the home channel by recency).
  const person = (contacts: { c: string; at: number; home?: boolean; alias?: string | null }[]) => {
    const u = W.newUser();
    for (const x of contacts) {
      const digits = x.c.startsWith("wa:") && /^wa:[0-9]{8,15}$/.test(x.c) ? `+${x.c.slice(3)}` : null;
      W.link(x.c, u, x.at - DAY, { lastInboundAt: x.at, home: !!x.home, alias: x.alias ?? null, ...(digits ? { phone: digits } : {}) });
      if (x.c.startsWith("wa:")) { P.waTs.set(addressOf(x.c), x.at); if (x.alias) P.waTs.set(x.alias, x.at); }
    }
    return u;
  };
  const rowsOf = (u: string) => W.outbox.filter((r) => r.userId === u);
  return { W, clock, P, env, vars, chats, run, runs, head, waPost, waText, waStatus, tgText, lmPost, lmText, person, rowsOf };
}
const due = (W: ReturnType<typeof memoryChannelWorld>) => W.outbox.some((o) => o.status === "queued" || (o.status === "failed" && o.retryAt !== null));
// k paragraphs of about 1,000 characters each: one message each on Telegram and WhatsApp (1,500 packed), one bubble on
// iMessage when about 600.
const paras = (tag: string, k: number, len = 1000) => Array.from({ length: k }, (_, i) => { let p = `${tag} message ${i + 1} of ${k}:`; while (p.length < len) p += " lorem ipsum dolor"; return p; });
const decodeHtml = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ================================================================================================ WhatsApp
Deno.test({ name: `channel r2: WhatsApp's 24-hour window at its edges, the person's own time against the webhook's (wa/window): ${of("wa_window").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/window");
  for (const s of of("wa_window")) {
    const w = world({ env: { WHATSAPP_TEMPLATE_UPDATES: s.template ? "updates_waiting" : undefined } });
    const addr = `1555${7000000 + s.id}`;
    const u = w.person([{ c: `wa:${addr}`, at: T0 - 3 * DAY }]);
    const ts = T0, recv = ts + s.lagMs, td = ts + s.gapMs;
    w.clock.t = recv;
    await w.waText({ from: addr, text: "hello there", ts });
    w.clock.t = td;
    for (let i = 0; i < s.proactive; i++) w.W.queue(u, { key: `status:w${s.id}-${i}`, kind: "status", text: `[${u}] update ${i}`, at: td - 1000 + i });
    await w.run();
    const base = Math.min(ts, recv), whys: string[] = [];
    const replyRow = w.rowsOf(u).find((r) => r.key.startsWith("reply:"))!;
    const replyOpen = recv - base < TRAINEE_WINDOW;
    if (replyRow?.status !== (replyOpen ? "delivered" : "held")) whys.push(`the answer is ${replyRow?.status}, must be ${replyOpen ? "delivered" : "held"} (sent ${recv - base} ms after the message)`);
    const open = td - base < TRAINEE_WINDOW;
    for (const r of w.rowsOf(u).filter((x) => x.key.startsWith("status:"))) if (r.status !== (open ? "delivered" : "held")) whys.push(`a proactive message is ${r.status}, must be ${open ? "delivered" : "held"} (${td - base} ms after the person's message)`);
    whys.push(...w.P.violations);
    const held = w.rowsOf(u).some((r) => r.status === "held");
    if (w.P.templates.length > 1) whys.push(`${w.P.templates.length} templates`);
    if (held && s.template && w.P.templates.length !== 1) whys.push("held, a template configured, and no template");
    if (!s.template && w.P.templates.length) whys.push("a template with none configured");
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status])));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: the waiting-updates template, its name, language and one parameter (wa/template): ${of("wa_template").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/template");
  for (const s of of("wa_template")) {
    const w = world({ env: { WHATSAPP_TEMPLATE_UPDATES: s.name, WHATSAPP_TEMPLATE_LANGUAGE: s.language } });
    const addr = `1555${7100000 + s.id}`;
    const u = w.person([{ c: `wa:${addr}`, at: T0 - 30 * HOUR }]);
    if (s.optedOut) await w.W.inbound.setOptOut(`wa:${addr}`, true, T0 - 2 * HOUR);
    if (s.nudgedBefore) w.W.contacts.get(`wa:${addr}`)!.nudgedAt = T0 - 2 * HOUR;
    for (let i = 0; i < s.held; i++) w.W.queue(u, { key: `status:t${s.id}-${i}`, kind: "status", text: `[${u}] update ${i}`, at: T0 - 60000 + i });
    const others: { addr: string; n: number }[] = [];
    for (let k = 0; k < s.others; k++) {
      const a = `1555${7200000 + s.id * 10 + k}`, v = w.person([{ c: `wa:${a}`, at: T0 - 40 * HOUR }]), n = 1 + ((s.id + k) % 4);
      for (let i = 0; i < n; i++) w.W.queue(v, { key: `digest:o${s.id}-${k}-${i}`, kind: "digest", text: `[${v}] digest ${i}`, at: T0 - 50000 + i });
      others.push({ addr: a, n });
    }
    await w.run(); await (w.clock.t += 2 * MIN, w.run());
    const whys: string[] = [...w.P.violations];
    const mine = w.P.templates.filter((t) => t.to === addr);
    const want = !s.optedOut && !s.nudgedBefore && !!s.name.trim();
    if (mine.length !== (want ? 1 : 0)) whys.push(`${mine.length} templates to the person (opted out ${s.optedOut}, nudged before ${s.nudgedBefore})`);
    for (const t of w.P.templates) {
      const params = (t.body.template?.components ?? []).flatMap((c: any) => c.parameters ?? []);
      if (t.body.template?.name !== s.name.trim()) whys.push(`template name ${JSON.stringify(t.body.template?.name)}, configured ${JSON.stringify(s.name)}`);
      if (t.body.template?.language?.code !== (s.language.trim() || "en_US")) whys.push(`template language ${JSON.stringify(t.body.template?.language?.code)}`);
      if (params.length !== 1 || params[0].type !== "text") { whys.push("not exactly one text parameter"); continue; }
      const p = String(params[0].text);
      if (/[\n\t]| {5,}/.test(p) || !p.trim()) whys.push(`a parameter Meta refuses: ${JSON.stringify(p)}`);
      const n = t.to === addr ? s.held : others.find((x) => x.addr === t.to)?.n;
      if (p !== String(n)) whys.push(`the parameter says ${p}, ${t.to === addr ? "the person" : "another person"} has ${n} waiting`);
    }
    if (s.optedOut && w.rowsOf(u).some((r) => r.status !== "skipped_opt_out")) whys.push("an opted-out person's proactive message was kept");
    rep.grade(s, whys, JSON.stringify(w.P.templates.map((t) => t.body.template)).slice(0, 300));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: WhatsApp media and non-text messages (wa/media): ${of("wa_media").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/media");
  for (const s of of("wa_media")) {
    const w = world();
    const addr = `1555${7300000 + s.id}`;
    const u = s.known ? w.person([{ c: `wa:${addr}`, at: s.windowClosed ? T0 - 30 * HOUR : T0 - HOUR }]) : null;
    if (u && s.windowClosed) { w.W.queue(u, { key: `status:m${s.id}`, kind: "status", text: `[${u}] update`, at: T0 - 60000 }); await w.run(); }
    w.clock.t += MIN;
    const sentBefore = w.P.sent.length;
    const extra: Record<string, Record<string, unknown>> = {
      audio: { audio: { id: "a1", mime_type: "audio/ogg" } }, voice: { audio: { id: "a1", mime_type: "audio/ogg; codecs=opus", voice: true } }, video: { video: { id: "v1" } },
      image: { image: { id: "i1", ...(s.caption ? { caption: s.caption } : {}) } }, document: { document: { id: "d1", filename: "resume.pdf", ...(s.caption ? { caption: s.caption } : {}) } },
      sticker: { sticker: { id: "s1" } }, reaction: { reaction: { message_id: "wamid.x", emoji: "👍" } }, location: { location: { latitude: 1, longitude: 2 } },
      contacts: { contacts: [{ name: { formatted_name: "A" } }] }, unsupported: { errors: [{ code: 131051 }] },
      button: { button: { text: "Show me jobs", payload: "x" } }, interactive: { interactive: { type: "button_reply", button_reply: { id: "b", title: "Yes please" } } },
    };
    await w.waText({ from: addr, type: s.type === "voice" ? "audio" : s.type, extra: extra[s.type] });
    await w.run();
    const got = w.P.sent.slice(sentBefore).filter((x) => x.to === addr).map((x) => x.text);
    const textual = s.type === "button" || s.type === "interactive";
    const whys: string[] = [...w.P.violations];
    let want: string[];
    if (!u) want = textual ? [SIGNUP_CLOSED_REPLY] : [];
    else if (textual) want = [`[${u}] ${s.type === "button" ? "Show me jobs" : "Yes please"} answered`];
    else if (["audio", "voice", "video"].includes(s.type)) want = [VOICE_NOT_READ_REPLY];
    else if (["image", "document"].includes(s.type)) want = [FILE_NOT_READ_REPLY];
    else want = [];
    if (u && s.windowClosed) want = [`[${u}] update`, ...want];
    const sortJ = (xs: string[]) => JSON.stringify([...xs].sort());
    if (sortJ(got) !== sortJ(want)) whys.push(`the person read ${JSON.stringify(got)}, must read ${JSON.stringify(want)}`);
    if (!u && w.chats.length) whys.push("a stranger's message ran a turn");
    if (u && !textual && w.chats.length) whys.push("a non-text message ran a turn");
    rep.grade(s, whys, JSON.stringify(got).slice(0, 300));
  }
  rep.assertClean();
} });

const HOLD = new Set([131047, 131049]), RETRY = new Set([130429]);
Deno.test({ name: `channel r2: WhatsApp status webhooks out of order and repeated (wa/status): ${of("wa_status").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/status");
  for (const s of of("wa_status")) {
    const w = world();
    const addr = `1555${7400000 + s.id}`;
    const u = w.person([{ c: `wa:${addr}`, at: T0 - HOUR }]);
    const bubbles = paras(`[${u}] S${s.id}`, s.bubbles);
    await w.W.inbound.enqueueReply(u, `reply:wa:s${s.id}`, bubbles.join("\n\n"), T0 - 1000, "whatsapp");
    await w.run();
    const first = w.P.to("whatsapp", addr).map((x) => x.id);
    const whys: string[] = [];
    if (first.length !== s.bubbles) whys.push(`${first.length} of ${s.bubbles} messages went at first`);
    // What Meta then says, message by message: delivered (it arrived) or failed (it did not).
    const failedIds = new Set<string>();
    w.clock.t += 30000;
    for (const e of s.events) {
      const id = first[e.bubble];
      if (!id) continue;
      if (e.kind === "failed") failedIds.add(id);
      await w.waStatus(id, e.kind, s.code);
    }
    if (HOLD.has(s.code)) { w.clock.t += 5 * MIN; await w.waText({ from: addr, text: "ok" }); }
    for (const dt of [2 * MIN, 10 * MIN, 60 * MIN]) { w.clock.t += dt; await w.run(); }
    if (s.lateCopy && first[s.failAt]) { w.clock.t += MIN; await w.waStatus(first[s.failAt], "failed", s.code); w.clock.t += 2 * MIN; await w.run(); w.clock.t += 10 * MIN; await w.run(); }
    // Every message of the row the person actually has, counted.
    const arrived = w.P.to("whatsapp", addr).filter((x) => !failedIds.has(x.id) && x.text.includes(`S${s.id} message`));
    const counts = bubbles.map((b) => arrived.filter((x) => x.text === b).length);
    const row = w.rowsOf(u).find((r) => r.key === `reply:wa:s${s.id}`)!;
    const finalCode = !HOLD.has(s.code) && !RETRY.has(s.code);
    if (finalCode) {
      if (row.status !== "failed") whys.push(`Meta said ${s.code} (not delivered) and the row is ${row.status}`);
      else if (!new RegExp(String(s.code)).test(row.error ?? "")) whys.push(`the row does not say why: ${row.error}`);
      if (counts.some((c, i) => c !== (i < s.failAt ? 1 : 0))) whys.push(`after a final ${s.code}: messages arrived ${JSON.stringify(counts)} times (sent again or lost)`);
    } else {
      if (row.status !== "delivered") whys.push(`the row is ${row.status} after ${s.code} and ${HOLD.has(s.code) ? "the person's next message" : "a retry"}`);
      if (counts.some((c) => c !== 1)) whys.push(`messages arrived ${JSON.stringify(counts)} times, each must arrive once`);
    }
    const order = arrived.map((x) => bubbles.indexOf(x.text));
    if (order.some((v, i) => i && v < order[i - 1])) whys.push(`out of order ${JSON.stringify(order)}`);
    whys.push(...w.P.violations);
    rep.grade(s, whys, `${row.status} ${row.error ?? ""} counts ${JSON.stringify(counts)}`);
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: a WhatsApp number given to someone else, or changed by its person (wa/owner): ${of("wa_owner").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/owner");
  for (const s of of("wa_owner")) {
    const w = world({ env: { TRAINEE_SIGNUP: s.signupOpen ? "open" : "closed" } });
    const n = `1555${7500000 + s.id}`, n2 = `1555${7600000 + s.id}`, bsA = `US.A${s.id}x`, bsB = `US.B${s.id}y`;
    const others = s.others.map((ch, i) => ({ ch, c: ch === "imessage" ? `+1555${7700000 + s.id}` : `tg:${7800000 + s.id}`, at: T0 - 3 * HOUR + i * MIN }));
    const u = w.person([{ c: `wa:${n}`, at: T0 - HOUR, alias: bsA }, ...others.map((x) => ({ c: x.c, at: x.at }))]);
    let k = 0;
    for (let i = 0; i < s.queued; i++) w.W.queue(u, { key: `digest:q${s.id}-${i}`, kind: "digest", text: `[${u}] digest ${i}`, at: T0 - 30000 + i });
    for (let i = 0; i < s.held; i++) { await w.W.inbound.enqueueReply(u, `reply:wa:h${s.id}-${i}`, `[${u}] held answer ${i}`, T0 - 40000 + i, "whatsapp"); w.W.outbox.at(-1)!.status = "held"; }
    for (let i = 1; i <= s.partsQueued; i++) await w.W.inbound.enqueueReply(u, `reply:wa:p${s.id}:${i}`, `[${u}] part ${i} of ${s.partsQueued}`, T0 - 20000, "whatsapp", { of: `reply:wa:p${s.id}`, n: i });
    k = w.P.sent.length;
    const whys: string[] = [];
    if (s.mode === "new_owner") {
      await w.waText({ from: n, userId: bsB, text: "hi, is this the job bot?" });
      for (const dt of [2 * MIN, 10 * MIN]) { w.clock.t += dt; await w.run(); }
      const toN = w.P.to("whatsapp", n).slice(0).filter((x) => w.P.sent.indexOf(x) >= k);
      if (toN.some((x) => x.text.includes(`[${u}]`))) whys.push(`the new owner of the number read the old owner's messages: ${JSON.stringify(toN.map((x) => x.text)).slice(0, 200)}`);
      if (w.chats.some((c) => c.userId === u)) whys.push("the new owner's message ran as the old owner's turn");
      const newTurn = w.chats.find((c) => c.userId !== u);
      if (s.signupOpen ? !newTurn : !toN.some((x) => x.text === SIGNUP_CLOSED_REPLY)) whys.push(`the new owner was not treated as someone new (${JSON.stringify(toN.map((x) => x.text)).slice(0, 160)})`);
    } else {
      await w.waPost({ contacts: [{ wa_id: n, user_id: bsA }], messages: [{ from: n, from_user_id: bsA, id: `wamid.sys${s.id}`, timestamp: String(Math.floor(w.clock.t / 1000)), type: "system", system: { body: `T changed from ${n} to ${n2}`, wa_id: n2, type: "user_changed_number" } }] });
      w.clock.t += MIN;
      await w.waText({ from: n2, userId: bsA, text: "back on my new number" });
      for (const dt of [2 * MIN, 10 * MIN]) { w.clock.t += dt; await w.run(); }
      if (!w.chats.some((c) => c.userId === u && c.message === "back on my new number")) whys.push(`the person's message from their new number did not reach their account (turns ${JSON.stringify(w.chats)})`);
      if (w.P.sent.slice(k).some((x) => x.to === n && x.text.includes(`[${u}]`))) whys.push("a message went to the old number after the person moved");
    }
    // The old owner's waiting messages: on another channel of theirs, or (none left) the bound ones failed with the reason.
    const homeOther = others.length ? others.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    for (const r of w.rowsOf(u).filter((x) => /^(digest:q|reply:wa:[hp])/.test(x.key))) {
      if (s.mode === "moved") { if (r.status !== "delivered" || r.contact !== `wa:${n2}`) whys.push(`${r.key} is ${r.status} to ${r.contact}, must reach the new number`); continue; }
      if (homeOther) { if (r.status !== "delivered" || r.contact !== homeOther.c) whys.push(`${r.key} is ${r.status}${r.contact ? ` to ${r.contact}` : ""}, must go to the person's ${homeOther.ch}`); }
      else if (r.channel !== null) { if (r.status !== "failed" || !/no other texting channel/.test(r.error ?? "")) whys.push(`${r.key} (bound to WhatsApp, no other channel) is ${r.status}: ${r.error}; must fail with the reason`); }
      else if (r.status !== "queued") whys.push(`${r.key} (proactive, no channel) is ${r.status}`);
    }
    const parts = w.P.sent.filter((x) => x.text.startsWith(`[${u}] part `)).map((x) => Number(/part (\d+)/.exec(x.text)![1]));
    if (parts.length && JSON.stringify(parts) !== JSON.stringify(Array.from({ length: s.partsQueued }, (_, i) => i + 1))) whys.push(`parts arrived ${JSON.stringify(parts)}`);
    whys.push(...w.P.violations.filter((v) => !v.includes(n) || s.mode === "moved"));
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status, r.contact])).slice(0, 400));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: business-scoped ids beside phone numbers (wa/bsuid): ${of("wa_bsuid").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/bsuid");
  for (const s of of("wa_bsuid")) {
    const w = world();
    const n = `1555${7900000 + s.id}`, b = `US.${s.id}abc`;
    const stored = s.stored === "wa_id" ? { c: `wa:${n}`, alias: null } : s.stored === "bsuid" ? { c: `wa:${b}`, alias: null } : { c: `wa:${n}`, alias: b };
    const u = w.person([{ c: stored.c, at: T0 - HOUR, alias: stored.alias }]);
    const neigh: string[] = [];
    for (let i = 0; i < s.neighbours; i++) { const v = w.person([{ c: i % 2 ? `wa:US.${s.id}abc${i}` : `wa:${Number(n) + i + 1}`, at: T0 - HOUR }]); neigh.push(v); }
    await w.waText({ from: s.sends === "bsuid" ? null : n, userId: s.sends === "wa_id" ? null : b, text: "any data roles?" });
    const knows = (s.stored !== "bsuid" && s.sends !== "bsuid") || (s.stored !== "wa_id" && s.sends !== "wa_id");
    const whys: string[] = [...w.P.violations];
    if (w.chats.some((c) => neigh.includes(c.userId))) whys.push("the message ran as another person");
    if (knows) {
      if (!w.chats.some((c) => c.userId === u)) whys.push("the person was not recognised");
      const ans = w.P.sent.find((x) => x.text.includes(`[${u}]`));
      if (!ans) whys.push("no answer reached the person");
      else if (![n, b].includes(ans.to)) whys.push(`the answer went to ${ans.to}`);
    } else if (w.chats.some((c) => c.userId === u)) whys.push("a business-scoped id the account never had ran as the account");
    rep.grade(s, whys, JSON.stringify(w.P.sent.map((x) => [x.to, x.text.slice(0, 40)])));
  }
  rep.assertClean();
} });

const WA_HOLD = new Set(["131047", "131049"]), WA_RETRY = new Set(["130429", "131056", "80007", "429", "502", "503", "network"]);
Deno.test({ name: `channel r2: WhatsApp refusing message b of k on the send (wa/errors): ${of("wa_errors").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("wa/errors");
  for (const s of of("wa_errors")) {
    const w = world();
    const addr = `1556${7000000 + s.id}`;
    const u = w.person([{ c: `wa:${addr}`, at: T0 - HOUR }]);
    const bubbles = paras(`[${u}] E${s.id}`, s.bubbles);
    let failed = false;
    w.P.fail = (a) => {
      if (failed || a.prov !== "whatsapp" || a.text !== bubbles[s.failAt]) return null;
      failed = true;
      if (s.mode === "network" || s.mode === "timeout") return s.mode;
      const http = Number(s.mode) < 1000 ? Number(s.mode) : 400;
      return json({ error: { code: Number(s.mode) < 1000 ? http : Number(s.mode), message: "refused" } }, http);
    };
    await w.W.inbound.enqueueReply(u, `reply:wa:e${s.id}`, bubbles.join("\n\n"), T0 - 1000, "whatsapp");
    await w.run();
    if (WA_HOLD.has(s.mode)) { w.clock.t += 5 * MIN; await w.waText({ from: addr, text: "ok" }); }
    for (const dt of [2 * MIN, 10 * MIN, 60 * MIN]) { w.clock.t += dt; await w.run(); }
    const got = w.P.to("whatsapp", addr).filter((x) => x.text.includes(`E${s.id} message`));
    const counts = bubbles.map((b) => got.filter((x) => x.text === b).length);
    const row = w.rowsOf(u).find((r) => r.key === `reply:wa:e${s.id}`)!;
    const whys: string[] = [...w.P.violations];
    if (counts.some((c) => c > 1)) whys.push(`a message arrived twice ${JSON.stringify(counts)}`);
    if (WA_HOLD.has(s.mode) || WA_RETRY.has(s.mode)) {
      if (row.status !== "delivered" || counts.some((c) => c !== 1)) whys.push(`${s.mode} on message ${s.failAt + 1} of ${s.bubbles}: ${row.status} (${row.error}), arrived ${JSON.stringify(counts)}; each must arrive once`);
    } else {
      if (row.status !== "failed" || row.retryAt !== null) whys.push(`${s.mode} may have gone or is final: the row must be failed, not retried (${row.status})`);
      if (s.failAt > 0 && !/after \d+ of \d+/.test(row.error ?? "")) whys.push(`the failure does not say how many went: ${row.error}`);
    }
    rep.grade(s, whys, `${row.status} ${row.error ?? ""} ${JSON.stringify(counts)}`);
  }
  rep.assertClean();
} });

// ================================================================================================ iMessage / SMS
Deno.test({ name: `channel r2: carrier keywords over SMS and iMessage, in English, French and Spanish (lm/sms): ${of("lm_sms").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("lm/sms");
  for (const s of of("lm_sms")) {
    const w = world();
    const from = `+1557${7000000 + s.id}`;
    const u = w.person([{ c: from, at: T0 - HOUR }]);
    await w.lmText(from, s.text, s.sms === null ? {} : { delivery_type: s.sms ? "sms" : "imessage" });
    const k = s.word.toLowerCase();
    const cmd = EVERYWHERE[k] ?? (s.sms === true ? SMS_WORDS[k] : undefined) ?? null;
    const got = w.P.to("loopmessage", from).map((x) => x.text);
    const out = w.W.contacts.get(from)!.optedOut;
    const whys: string[] = [];
    if (cmd === "stop" || (cmd === "start" && true) || (cmd === "help" && s.sms === true)) {
      if (w.chats.length) whys.push(`"${s.text}" (${cmd}) ran a model turn`);
      if (JSON.stringify(got) !== JSON.stringify([CHANNEL_REPLIES[cmd]])) whys.push(`"${s.text}" got ${JSON.stringify(got).slice(0, 120)}, must get the ${cmd} reply`);
      if (out !== (cmd === "stop")) whys.push(`opted out ${out} after "${s.text}"`);
    } else if (cmd === "help") {
      if (out) whys.push("HELP opted the person out");
    } else {
      if (out) whys.push(`"${s.text}" opted the person out (${s.sms ? "SMS" : "iMessage"})`);
      if (!w.chats.some((c) => c.userId === u)) whys.push(`"${s.text}" is a message for Trainee and ran no turn`);
    }
    rep.grade(s, whys, JSON.stringify(got).slice(0, 200));
  }
  rep.assertClean();
} });

const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
Deno.test({ name: `channel r2: iMessage bubbles in GSM-7 and UCS-2 (lm/segments): ${of("lm_segments").length} scenarios`, async fn() {
  const rep = new Report("lm/segments");
  let maxSeg = 0;
  for (const s of of("lm_segments")) {
    const bubbles = s.native ? (await import("../../supabase/functions/_shared/channel_voice.ts")).imessageNativeRender(s.text) : toBubbles(s.text);
    const whys: string[] = [];
    for (const b of bubbles) {
      if (b.length > 700) whys.push(`a ${b.length}-character bubble`);
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(b)) whys.push("half a character at a cut");
      const seg = GSM.test(b) ? Math.ceil(b.length / 153) : Math.ceil(b.length / 67);
      maxSeg = Math.max(maxSeg, seg);
      if (!s.ucs && !GSM.test(b)) whys.push(`a GSM-7 reply became UCS-2 (twice the SMS segments): ${JSON.stringify([...b].filter((c) => !GSM.test(c)).slice(0, 3))}`);
    }
    const words = (t: string) => t.split(/\s+/).filter(Boolean);
    if (JSON.stringify(words(bubbles.join(" "))) !== JSON.stringify(words(s.text))) whys.push("a word was lost, changed or moved");
    rep.grade(s, whys, JSON.stringify(bubbles.map((b) => b.length)));
  }
  console.log(`[channel-r2] lm/segments: the longest bubble is ${maxSeg} SMS segments on an SMS fallback`);
  rep.assertClean();
} });

Deno.test({ name: `channel r2: a message in an iMessage group (lm/group): ${of("lm_group").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("lm/group");
  for (const s of of("lm_group")) {
    const w = world({ env: { TRAINEE_SIGNUP: "open" } });
    const from = `+1557${8000000 + s.id}`;
    if (s.known) w.person([{ c: from, at: T0 - HOUR }]);
    await w.lmText(from, s.text, s.shape === "object" ? { group: { group_id: `g${s.id}`, name: "Friends", participants: [from, "+15550001111"] } } : { group_id: `g${s.id}` });
    const whys: string[] = [];
    if (w.chats.length) whys.push("a group message ran a turn");
    if (w.P.sent.length) whys.push(`a group message was answered: ${JSON.stringify(w.P.sent.map((x) => x.text)).slice(0, 120)}`);
    if (w.W.outbox.length) whys.push("a group message queued a reply");
    if (w.W.contacts.get(from)?.optedOut) whys.push("a STOP said in a group stopped the person");
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: LoopMessage's delivery callbacks (lm/callbacks): ${of("lm_callbacks").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("lm/callbacks");
  for (const s of of("lm_callbacks")) {
    const w = world();
    const to = `+1557${9000000 + s.id}`;
    const u = w.person([{ c: to, at: T0 - HOUR }]);
    const bubbles = paras(`[${u}] C${s.id}`, s.bubbles, 600);
    await w.W.inbound.enqueueReply(u, `reply:c${s.id}`, bubbles.join("\n\n"), T0 - 1000, "imessage");
    await w.run();
    const ids = w.P.to("loopmessage", to).map((x) => x.id);
    const whys: string[] = [];
    if (ids.length !== s.bubbles) whys.push(`${ids.length} of ${s.bubbles} bubbles went`);
    for (const e of s.events) {
      w.clock.t += 1000;
      await w.lmPost({ alert_type: e.casing === "upper" ? e.alert.toUpperCase() : e.alert, message_id: ids[e.bubble], recipient: to, ...(e.withText ? { text: bubbles[e.bubble] } : {}), ...(/fail/.test(e.alert) ? { error_code: 110 } : {}) });
    }
    w.clock.t += 2 * MIN; await w.run();
    const row = w.rowsOf(u).find((r) => r.key === `reply:c${s.id}`)!;
    const failed = s.events.some((e) => /fail|timeout/.test(e.alert));
    if (w.chats.length) whys.push(`a delivery callback ran a turn with Trainee's own words: ${JSON.stringify(w.chats[0].message).slice(0, 80)}`);
    if (w.P.sent.length !== s.bubbles) whys.push(`${w.P.sent.length - s.bubbles} more message(s) sent after the callbacks`);
    if (failed && (row.status !== "failed" || !/LoopMessage/.test(row.error ?? ""))) whys.push(`LoopMessage said it was not delivered and the row is ${row.status}`);
    if (!failed && row.status !== "delivered") whys.push(`the row is ${row.status} after ${s.events.map((e) => e.alert).join(",")}`);
    rep.grade(s, whys, `${row.status} ${row.error ?? ""}`);
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: LOOPMESSAGE_API_KEY missing: an honest NOT_WIRED, nothing lost (lm/nokey): ${of("lm_nokey").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("lm/nokey");
  for (const s of of("lm_nokey")) {
    const w = world({ env: { LOOPMESSAGE_API_KEY: undefined, ...(s.others.includes("telegram") ? {} : { TELEGRAM_BOT_TOKEN: undefined }), ...(s.others.includes("whatsapp") ? {} : { WHATSAPP_TOKEN: undefined }) } });
    const im = `+1558${7000000 + s.id}`, tg = `tg:${8100000 + s.id}`, wa = `wa:1558${8000000 + s.id}`;
    const u = w.person([{ c: im, at: T0 - 10 * MIN, home: true }, ...(s.others.includes("telegram") ? [{ c: tg, at: T0 - HOUR }] : []), ...(s.others.includes("whatsapp") ? [{ c: wa, at: T0 - HOUR }] : [])]);
    for (let i = 0; i < s.rows; i++) w.W.queue(u, { key: `status:n${s.id}-${i}`, kind: "status", text: `[${u}] update ${i}`, at: T0 - 60000 + i });
    for (const ch of s.others) await w.W.inbound.enqueueReply(u, `reply:${ch}:n${s.id}`, `[${u}] ${ch} answer`, T0 - 30000, ch);
    const whys: string[] = [];
    let inId = "";
    if (s.inbound) {
      inId = `lm-in-n${s.id}`;
      const r = await w.lmPost({ alert_type: "message_inbound", message_id: inId, recipient: im, text: "find jobs" });
      if (r.status !== 503 || !/NOT_WIRED/.test(JSON.stringify(r.body))) whys.push(`the webhook answered ${r.status} ${JSON.stringify(r.body)}`);
      if (w.W.inbound.claimed.size || w.chats.length) whys.push("a message was claimed or run with no key (LoopMessage's retry would then be dropped)");
    }
    const r1 = await w.run();
    if (!s.others.length) { if (r1.status !== 503 || !/NOT_WIRED/.test(JSON.stringify(r1.body))) whys.push(`no channel at all: the run answered ${r1.status}`); }
    else if (r1.status !== 200) whys.push(`the run answered ${r1.status}`);
    for (const r of w.rowsOf(u)) {
      const onImessage = r.key.startsWith("status:");
      if (onImessage && r.status !== "queued") whys.push(`${r.key} is ${r.status} with no iMessage key (must wait, queued)`);
      if (!onImessage && r.status !== "delivered") whys.push(`${r.key} on a wired channel is ${r.status}`);
    }
    // The key is set: everything that waited goes once, and LoopMessage's retry of the webhook runs once.
    w.vars.LOOPMESSAGE_API_KEY = LM_KEY;
    w.clock.t += MIN;
    if (s.inbound) await w.lmPost({ alert_type: "message_inbound", message_id: inId, recipient: im, text: "find jobs" });
    if (s.inbound) await w.lmPost({ alert_type: "message_inbound", message_id: inId, recipient: im, text: "find jobs" });
    await w.run();
    if (s.inbound && w.chats.length !== 1) whys.push(`the retried message ran ${w.chats.length} turns`);
    for (const r of w.rowsOf(u)) if (r.status !== "delivered") whys.push(`${r.key} is ${r.status} once the key is set`);
    const texts = w.P.sent.map((x) => x.text);
    if (new Set(texts).size !== texts.length) whys.push("a message went twice");
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status])));
  }
  rep.assertClean();
} });

// ================================================================================================ across channels
const addrOf = (ch: Channel, id: number) => ch === "imessage" ? `+1559${7000000 + id}` : ch === "whatsapp" ? `wa:1559${8000000 + id}` : `tg:${9100000 + id}`;
Deno.test({ name: `channel r2: a person on two or three channels at once (x/two): ${of("x_two").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("x/two");
  for (const s of of("x_two")) {
    const w = world({ env: s.capped ? { LOOPMESSAGE_DAILY_CONTACTS: "1" } : {} });
    const cs = Object.fromEntries(s.channels.map((ch) => [ch, addrOf(ch, s.id)])) as Record<Channel, string>;
    const u = w.person(s.channels.map((ch, i) => ({ c: cs[ch], at: T0 - 2 * HOUR + i * MIN, home: s.home === ch })));
    const b = w.person(s.channels.map((ch) => ({ c: addrOf(ch, s.id + 500000), at: T0 - HOUR }))); // someone else on the same channels
    if (s.capped) { w.W.queue(b, { key: `status:cap${s.id}`, kind: "status", text: `[${b}] earlier today`, at: T0 - 10 * MIN }); w.W.link(addrOf("imessage", s.id + 500000), b, T0 - DAY, { home: true }); await w.run(); }
    // The other channels' first try fails once (nothing went): their answers then go through the every-minute run.
    const flaky = s.id % 3 === 0;
    const tried = new Set<string>();
    w.P.fail = (a) => (flaky && a.prov !== "loopmessage" && a.text.includes(`[${u}]`) && !tried.has(a.text) ? (tried.add(a.text), json({ ok: false, description: "busy", error: { code: 503, message: "busy" } }, 503)) : null);
    const asked: { ch: Channel; tag: string; parts: number }[] = [];
    for (const [i, m] of s.msgs.entries()) {
      w.clock.t = T0 + m.at + i * 1000 + 500; // never in the same second as another (WhatsApp stamps whole seconds)
      const text = `ask${i} parts=${m.parts}`;
      const c = cs[m.ch];
      if (m.ch === "whatsapp") await w.waText({ from: addressOf(c), text });
      else if (m.ch === "telegram") await w.tgText(Number(addressOf(c)), text);
      else await w.lmText(c, text);
      asked.push({ ch: m.ch, tag: `[${u}] ask${i}`, parts: m.parts });
    }
    for (let i = 0; i < s.proactive; i++) w.W.queue(u, { key: `digest:x${s.id}-${i}`, kind: "digest", text: `[${u}] digest ${i}`, at: w.clock.t + i });
    for (let k = 0; k < 16; k++) { w.clock.t += 2 * MIN; await w.run(); }
    const whys: string[] = [...w.P.violations];
    const mine = (x: Sent) => x.text.includes(`[${u}]`) || decodeHtml(x.text).includes(`[${u}]`);
    for (const x of w.P.sent) if (mine(x) && !s.channels.some((ch) => PROV[ch] === x.prov && addressOf(cs[ch]) === x.to)) whys.push(`${x.prov} to ${x.to} read the person's message`);
    for (const a of asked) {
      const got = w.P.sent.filter((x) => decodeHtml(x.text).startsWith(a.tag + " ") || decodeHtml(x.text) === `${a.tag} answered`);
      const capped = s.capped && a.ch === "imessage";
      if (got.some((x) => x.prov !== PROV[a.ch] || x.to !== addressOf(cs[a.ch]))) whys.push(`the answer to a message on ${a.ch} went to ${got.map((x) => x.prov).join(",")}`);
      const want = capped ? 0 : a.parts;
      if (got.length !== want) whys.push(`${got.length} of ${a.parts} part(s) of the answer on ${a.ch}${capped ? " (LoopMessage's cap: must wait)" : ""} arrived`);
      if (a.parts > 1) { const seq = got.map((x) => Number(/part (\d+) of/.exec(decodeHtml(x.text))?.[1])); if (seq.some((v, i) => v !== i + 1)) whys.push(`parts out of order ${JSON.stringify(seq)}`); }
    }
    // Proactive: the home channel the person set, else the one they wrote on last.
    const last = new Map<Channel, number>(s.channels.map((ch, i) => [ch, T0 - 2 * HOUR + i * MIN]));
    for (const [i, m] of s.msgs.entries()) { const t = T0 + m.at + i * 1000 + 500; last.set(m.ch, m.ch === "whatsapp" ? Math.floor(t / 1000) * 1000 : t); }
    const home = s.home ?? [...last.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const r of w.rowsOf(u).filter((x) => x.key.startsWith("digest:"))) {
      const capped = s.capped && home === "imessage";
      if (capped ? r.status !== "queued" : r.status !== "delivered" || r.contact !== cs[home]) whys.push(`${r.key} is ${r.status} on ${r.contact}, must go to the home channel ${home}${capped ? " (capped: wait)" : ""}`);
    }
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status, r.contact, r.error])).slice(0, ONLY.size ? 4000 : 400));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: the home channel switched while messages wait (x/home): ${of("x_home").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("x/home");
  for (const s of of("x_home")) {
    const w = world();
    const cs = Object.fromEntries(s.channels.map((ch) => [ch, addrOf(ch, s.id)])) as Record<Channel, string>;
    const u = w.person(s.channels.map((ch) => ({ c: cs[ch], at: ch === "whatsapp" ? T0 - 30 * HOUR : T0 - 2 * HOUR, home: ch === s.from })));
    for (let i = 0; i < s.held; i++) w.W.queue(u, { key: `status:h${s.id}-${i}`, kind: "status", text: `[${u}] held ${i}`, at: T0 - 60000 + i });
    if (s.held) await w.run();
    for (let i = 0; i < s.queued; i++) w.W.queue(u, { key: `digest:q${s.id}-${i}`, kind: "digest", text: `[${u}] digest ${i}`, at: w.clock.t + i });
    const bound = s.channels.filter((c) => c !== "whatsapp")[0];
    for (let i = 0; i < s.replies; i++) await w.W.inbound.enqueueReply(u, `reply:${bound}:r${s.id}-${i}`, `[${u}] answer ${i}`, w.clock.t, bound);
    // The app's "home channel" (channel_set_home).
    const W = w.W as any;
    if (W.setHome) W.setHome(u, s.to); else for (const c of w.W.person(u)) c.home = c.contact === cs[s.to];
    for (const dt of [MIN, 2 * MIN]) { w.clock.t += dt; await w.run(); }
    const whys: string[] = [];
    for (const r of w.rowsOf(u)) {
      const want = r.key.startsWith("reply:") ? cs[bound] : cs[s.to];
      const windowShut = want.startsWith("wa:");
      if (windowShut ? r.status !== "held" : r.status !== "delivered" || r.contact !== want) whys.push(`${r.key} is ${r.status} on ${r.contact}, must go to ${want} (home now ${s.to})`);
    }
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status, r.contact])));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: a second channel linked mid-conversation (x/link): ${of("x_link").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("x/link");
  for (const s of of("x_link")) {
    const w = world();
    const im = addrOf("imessage", s.id), wa = `1559${7000000 + s.id}`, tg = 9300000 + s.id;
    const u = w.person([{ c: im, at: T0 - HOUR, home: false }]);
    // The answer in parts: LoopMessage refuses part 2's first try (nothing went), so parts 2..n are still going out.
    let refused = false;
    w.P.fail = (a) => (!refused && a.prov === "loopmessage" && a.text.includes("ask1 part 2 of") ? (refused = true, new Response("busy", { status: 503 })) : null);
    await w.lmText(im, `ask1 parts=${s.partsInFlight}`);
    const whys: string[] = [];
    if (s.how === "phone") {
      w.clock.t += 10000;
      await w.waText({ from: wa, text: "hello from whatsapp" });
      w.clock.t += 10000;
      await w.lmText(im, "yes");
    } else {
      w.clock.t += 10000;
      await w.lmText(im, "connect telegram");
      const link = w.P.to("loopmessage", im).map((x) => x.text).join("\n");
      const nonce = /start=([A-Za-z0-9_-]{32})/.exec(link)?.[1];
      if (!nonce) whys.push("no Telegram link was sent");
      w.clock.t += 10000;
      if (nonce) await w.tgText(tg, `/start ${nonce}`);
      // TELEGRAM LINK OWNERSHIP (2026-10-31): the link asks the channel already linked; its YES binds the chat.
      w.clock.t += 10000;
      if (nonce) await w.lmText(im, `LINK ${/reply LINK ([0-9]{4}) /.exec(w.P.to("loopmessage", im).map((x) => x.text).filter((t) => /^Someone wants to link Telegram /.test(t)).at(-1) ?? "")?.[1] ?? "none"}`);
    }
    w.clock.t += 2 * MIN; await w.run();
    w.clock.t += 10000;
    const newCh: Channel = s.how === "phone" ? "whatsapp" : "telegram", newAddr = s.how === "phone" ? wa : String(tg);
    if (s.how === "phone") await w.waText({ from: wa, text: "ask2" }); else await w.tgText(tg, "ask2");
    for (let i = 0; i < s.proactiveAfter; i++) w.W.queue(u, { key: `digest:l${s.id}-${i}`, kind: "digest", text: `[${u}] digest ${i}`, at: w.clock.t + i });
    for (const dt of [2 * MIN, 5 * MIN]) { w.clock.t += dt; await w.run(); }
    const parts = w.P.sent.filter((x) => x.text.startsWith(`[${u}] ask1 part`));
    const seq = parts.map((x) => Number(/part (\d+) of/.exec(x.text)![1]));
    if (JSON.stringify(seq) !== JSON.stringify(Array.from({ length: s.partsInFlight }, (_, i) => i + 1))) whys.push(`the answer in flight arrived ${JSON.stringify(seq)}`);
    if (parts.some((x) => x.prov !== "loopmessage" || x.to !== im)) whys.push("a part of the answer in flight moved to the new channel");
    const ask2 = w.P.sent.filter((x) => decodeHtml(x.text) === `[${u}] ask2 answered`);
    if (ask2.length !== 1 || ask2[0].prov !== PROV[newCh] || ask2[0].to !== newAddr) whys.push(`the answer on the new channel: ${JSON.stringify(ask2.map((x) => [x.prov, x.to]))}`);
    if (!w.chats.some((c) => c.userId === u && c.message === "ask2")) whys.push("the new channel did not reach the person's account");
    for (const r of w.rowsOf(u).filter((x) => x.key.startsWith("digest:"))) if (r.status !== "delivered" || r.contact !== (s.how === "phone" ? `wa:${wa}` : `tg:${tg}`)) whys.push(`${r.key} is ${r.status} on ${r.contact}, must go to the channel written on last`);
    whys.push(...w.P.violations);
    rep.grade(s, whys, JSON.stringify(w.P.sent.map((x) => [x.prov, x.text.slice(0, 40)])).slice(0, 400));
  }
  rep.assertClean();
} });

Deno.test({ name: `channel r2: a channel let go while messages wait for it (x/delete): ${of("x_delete").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("x/delete");
  for (const s of of("x_delete")) {
    const w = world();
    const tg = 9400000 + s.id, wa = `1559${9000000 + s.id}`, bsA = `US.A${s.id}d`;
    const gone = s.what === "telegram" ? `tg:${tg}` : `wa:${wa}`;
    const others = s.others.map((ch, i) => ({ ch, c: addrOf(ch, s.id + 700000), at: T0 - 3 * HOUR + i * MIN }));
    const u = w.person([{ c: gone, at: T0 - HOUR, alias: s.what === "whatsapp" ? bsA : null }, ...others.map((x) => ({ c: x.c, at: x.at }))]);
    for (let i = 0; i < s.bound; i++) await w.W.inbound.enqueueReply(u, `reply:x:b${s.id}-${i}`, `[${u}] answer ${i}`, T0 - 60000 + i, s.what);
    for (let i = 1; i <= s.parts; i++) await w.W.inbound.enqueueReply(u, `reply:x:p${s.id}:${i}`, `[${u}] part ${i} of ${s.parts}`, T0 - 50000, s.what, { of: `reply:x:p${s.id}`, n: i });
    for (let i = 0; i < s.held; i++) { await w.W.inbound.enqueueReply(u, `reply:x:h${s.id}-${i}`, `[${u}] held ${i}`, T0 - 45000 + i, "whatsapp"); w.W.outbox.at(-1)!.status = "held"; }
    for (let i = 0; i < s.unbound; i++) w.W.queue(u, { key: `digest:u${s.id}-${i}`, kind: "digest", text: `[${u}] digest ${i}`, at: T0 - 40000 + i });
    const whys: string[] = [];
    // The channel goes: "unlink telegram" in the chat, or the WhatsApp number now another person's.
    if (s.what === "telegram") {
      const inb = w.W.inbound as any;
      if (inb.unlinkTelegram) { const r = await w.tgText(tg, "unlink telegram"); if (!/unlinked/.test(JSON.stringify(r.body))) whys.push(`unlink: ${JSON.stringify(r.body)}`); }
      else for (const c of w.W.person(u)) if (c.contact === gone) { c.userId = null; c.threadId = null; }
      if (s.relinkedToOther) { const v = w.W.newUser(); w.W.link(gone, v, w.clock.t, { lastInboundAt: w.clock.t }); }
    } else await w.waText({ from: wa, userId: `US.B${s.id}z`, text: "who is this" });
    const k = w.P.sent.length;
    for (const dt of [2 * MIN, 5 * MIN, 30 * MIN]) { w.clock.t += dt; await w.run(); }
    const after = w.P.sent.slice(k);
    if (after.some((x) => x.to === addressOf(gone) && x.text.includes(`[${u}]`))) whys.push(`the let-go ${s.what} ${s.relinkedToOther ? "(now someone else's) " : ""}read the person's messages`);
    const home = others.length ? others.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    for (const r of w.rowsOf(u)) {
      if (home) { if (r.status !== "delivered" || r.contact !== home.c) whys.push(`${r.key} is ${r.status}${r.contact ? ` on ${r.contact}` : ""}, must go to the person's ${home.ch}`); }
      else if (r.key.startsWith("reply:")) { if (r.status !== "failed" || !/no other texting channel/.test(r.error ?? "")) whys.push(`${r.key} (bound to the let-go ${s.what}, no other channel) is ${r.status}; must fail with the reason`); }
      else if (r.status !== "queued") whys.push(`${r.key} (proactive, no channel left) is ${r.status}`);
    }
    const seq = after.filter((x) => x.text.startsWith(`[${u}] part `)).map((x) => Number(/part (\d+)/.exec(x.text)![1]));
    if (seq.length && JSON.stringify(seq) !== JSON.stringify(Array.from({ length: s.parts }, (_, i) => i + 1))) whys.push(`parts arrived ${JSON.stringify(seq)}`);
    const texts = after.filter((x) => x.text.includes(`[${u}]`)).map((x) => x.text);
    if (new Set(texts).size !== texts.length) whys.push("a message went twice");
    rep.grade(s, whys, JSON.stringify(w.rowsOf(u).map((r) => [r.key, r.status, r.contact])).slice(0, 400));
  }
  rep.assertClean();
} });

// ================================================================================================ formatting and Telegram's 429
const HTML_OK = (h: string) => {
  const stack: string[] = [];
  for (const m of h.matchAll(/<(\/?)([a-z]+)>|<[^>]*>|&(?!amp;|lt;|gt;)/g)) {
    if (!m[2]) return false;
    if (!["b", "i", "s", "code", "pre"].includes(m[2])) return false;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return !stack.length;
};
Deno.test(`channel r2: crossing emphasis on every channel (fmt/cross): ${of("fmt_cross").length} scenarios`, () => {
  const rep = new Report("fmt/cross");
  for (const s of of("fmt_cross")) {
    const out = s.channel === "imessage" ? formatForChannel(s.md, "imessage") : nativeRender(s.channel, 1500)(s.md).join("\n");
    const whys: string[] = [];
    if (s.channel === "imessage" && out !== s.vis) whys.push(`plain text ${JSON.stringify(out)}, must be ${JSON.stringify(s.vis)}`);
    if (s.channel === "telegram") {
      if (!HTML_OK(out)) whys.push(`HTML not well formed: ${out}`);
      if (decodeHtml(out) !== s.vis) whys.push(`Telegram shows ${JSON.stringify(decodeHtml(out))}`);
    }
    if (s.channel === "whatsapp") {
      if (/\*\*|__|~~/.test(out)) whys.push(`markdown left: ${out}`);
      if (out.replace(/[*_~]/g, "") !== s.vis) whys.push(`WhatsApp shows ${JSON.stringify(out)}`);
      for (const m of out.matchAll(/[*_~]/g)) {
        const before = out[m.index! - 1], after = out[m.index! + 1];
        if ((before === undefined || /\s/.test(before)) && (after === undefined || /\s/.test(after))) whys.push(`a lone mark WhatsApp shows as is: ${JSON.stringify(out)}`);
      }
      for (const c of ["*", "_", "~"]) if (out.split(c).length % 2 === 0) whys.push(`an unpaired ${c}: ${JSON.stringify(out)}`);
    }
    rep.grade(s, whys, out);
  }
  rep.assertClean();
});

Deno.test({ name: `channel r2: Telegram's 429 for more than 30 s on message 2+ of a row (tg/429): ${of("tg_429").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("tg/429");
  for (const s of of("tg_429")) {
    const w = world();
    const chat = 9500000 + s.id;
    const u = w.person([{ c: `tg:${chat}`, at: T0 - HOUR }]);
    const bubbles = paras(`[${u}] R${s.id}`, s.bubbles);
    let left = s.times;
    w.P.fail = (a) => {
      if (a.prov !== "telegram" || a.text !== bubbles[s.failAt] || left <= 0) return null;
      left--;
      w.P.tgBlocked.set(a.to, w.clock.t + s.retryAfter * 1000);
      return json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${s.retryAfter}`, parameters: { retry_after: s.retryAfter } }, 429);
    };
    await w.W.inbound.enqueueReply(u, `reply:tg:r${s.id}`, bubbles.join("\n\n"), T0 - 1000, "telegram");
    for (let k = 0; k < 80 && (k === 0 || due(w.W)); k++) { await w.run(); w.clock.t += 30000; }
    const got = w.P.to("telegram", String(chat)).map((x) => x.text);
    const row = w.rowsOf(u)[0];
    const whys: string[] = [...w.P.violations];
    if (JSON.stringify(got) !== JSON.stringify(bubbles)) whys.push(`arrived ${JSON.stringify(got.map((t) => bubbles.indexOf(t) + 1))} of ${s.bubbles} (429 for ${s.retryAfter} s on message ${s.failAt + 1}, ${s.times}x): every message once, in order`);
    if (row.status !== "delivered") whys.push(`the row is ${row.status}: ${row.error}`);
    rep.grade(s, whys, `${row.status} ${row.error ?? ""}`);
  }
  rep.assertClean();
} });

Deno.test("channel r2: the generator is seeded and deterministic (10,600 scenarios)", () => {
  if (ONLY.size) return;
  eq(SCENARIOS.length, PLAN.reduce((a, p) => a + p[1], 0));
  eq(SCENARIOS.length, 10_600);
  eq(JSON.stringify(generate({ seed: 20261031 }).slice(0, 80)), JSON.stringify(SCENARIOS.slice(0, 80)), "the same seed, the same scenarios");
});
