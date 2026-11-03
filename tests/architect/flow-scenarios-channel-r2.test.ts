// Channel delivery round 2 end to end on Postgres (2026-10-30): about 80 deliveries through trainee-deliver's real handler
// (handleDeliver over supabaseChannelStore and supabase-js, every adapter from the secrets with CAREER_TEXTING_NATIVE on),
// the real WhatsApp webhook (handleWhatsApp, signed, over supabaseInboundStore) and the real LoopMessage webhook
// (handleInbound), on Postgres 16 with every migration (tests/flow/pg.ts) and the PostgREST double, with fake providers at
// the HTTP boundary (api.telegram.org, graph.facebook.com, a.loopmessage.com) on a fixed clock. Nothing leaves the machine;
// no model runs (the chat is a stub that names the person). The database is read back:
//   - WhatsApp says message 3 then message 2 of a row failed (out of order): the person's next message sends 2 and 3 again,
//     once each, and a late copy changes nothing; 131026 marks the row failed with the reason;
//   - Telegram's 429 for 61 s on message 2 of 3: the rest goes after it, once each, never early;
//   - Telegram unlinked: the answer in parts bound to it goes to the person's iMessage, in order; with no channel left, it
//     fails with the reason; a WhatsApp number given to someone else: the stranger is told about sign-up, runs no turn as
//     the old owner, reads nothing of theirs; a person who changed their number gets everything on the new one;
//   - LoopMessage's message_failed marks the row; message_scheduled (which carries Trainee's own text) is never a turn;
//   - the home channel switched while WhatsApp's window held messages: they go to the new home;
//   - a person on two channels with LoopMessage's daily cap reached: their Telegram answer is not held behind iMessage;
//   - crossing emphasis on Telegram is valid HTML; nobody reads anyone else's message; nothing is sent twice.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-channel-r2.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { SIGNUP_CLOSED_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const T0 = Date.parse("2026-10-30T15:00:00Z"), MIN = 60000, HOUR = 3600000, DAY = 86400000;
const mk = (p: string, n: number) => `${p}${"y".repeat(n)}`;
const SECRET = mk("deliver", 33), IN_SECRET = mk("inbound", 33), WA_APP = mk("app", 33);
const uid = (n: number) => `00000000-0000-4000-8000-0000000c72${String(n).padStart(2, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const paras = (tag: string, k: number) => Array.from({ length: k }, (_, i) => { let p = `${tag} message ${i + 1} of ${k}:`; while (p.length < 1000) p += " lorem ipsum dolor"; return p; });
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Who is where (the address as each provider sees it).
const PEOPLE: { n: number; contacts: { c: string; at: number; alias?: string; home?: boolean }[] }[] = [
  { n: 1, contacts: [{ c: "wa:15550072001", at: T0 - HOUR, alias: "US.p1" }] }, // statuses out of order
  { n: 2, contacts: [{ c: "wa:15550072002", at: T0 - HOUR }] }, // 131026
  { n: 3, contacts: [{ c: "tg:72003", at: T0 - HOUR }] }, // 429 for 61 s on message 2
  { n: 4, contacts: [{ c: "tg:72004", at: T0 - HOUR }, { c: "+15550072004", at: T0 - 3 * HOUR }] }, // Telegram unlinked, iMessage left
  { n: 5, contacts: [{ c: "tg:72005", at: T0 - HOUR }] }, // Telegram unlinked, nothing left
  { n: 6, contacts: [{ c: "wa:15550072006", at: T0 - HOUR, alias: "US.p6" }, { c: "+15550072066", at: T0 - 4 * HOUR }] }, // number now someone else's (their iMessage is another number)
  { n: 7, contacts: [{ c: "wa:15550072007", at: T0 - HOUR, alias: "US.p7" }] }, // number changed
  { n: 8, contacts: [{ c: "+15550072008", at: T0 - HOUR }] }, // LoopMessage callbacks
  { n: 9, contacts: [{ c: "+15550072009", at: T0 - HOUR }, { c: "tg:72009", at: T0 - 2 * HOUR }] }, // two channels, cap
  { n: 10, contacts: [{ c: "wa:15550072010", at: T0 - 30 * HOUR, home: true }, { c: "tg:72010", at: T0 - 40 * HOUR }] }, // home switched
  { n: 11, contacts: [{ c: "+15550072011", at: T0 - HOUR }] }, // bulk iMessage
  { n: 12, contacts: [{ c: "tg:72012", at: T0 - HOUR }] }, // a long answer in parts, crossing emphasis
  { n: 13, contacts: [{ c: "wa:15550072013", at: T0 - HOUR }] }, // bulk WhatsApp
];
const owner = new Map<string, number>();
for (const p of PEOPLE) for (const x of p.contacts) owner.set(x.c.replace(/^(tg|wa):/, ""), p.n);

Deno.test({ name: "channel delivery round 2 end to end on Postgres: ~80 deliveries, statuses, unlinked channels, moved numbers, callbacks, home switch", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const inbound = supabaseInboundStore(admin);
    for (const p of PEOPLE) {
      await db.sql.query(`insert into auth.users(id, email) values (${q(uid(p.n))}, ${q(`r2c${p.n}@example.test`)});
        insert into public.profiles(id) values (${q(uid(p.n))});
        insert into public.career_watch_kv(user_id, key, value) values (${q(uid(p.n))}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${p.contacts.map((x) => `insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, alias, home${/^wa:\d+$/.test(x.c) ? ", phone" : ""})
          values (${q(x.c)}, ${q(uid(p.n))}, ${q(iso(x.at))}, ${q(iso(T0 - 2 * DAY))}, ${x.alias ? q(x.alias) : "null"}, ${x.home ? "true" : "false"}${/^wa:\d+$/.test(x.c) ? `, ${q(`+${x.c.slice(3)}`)}` : ""});`).join("\n")}`);
    }
    // ------------------------------------------------------------------------------------------- the providers
    const clock = { t: T0 };
    const got: { prov: string; to: string; text: string; id: string; t: number }[] = [], templates: string[] = [], early: string[] = [];
    const waTs = new Map<string, number>(); // the person's own last message time on WhatsApp
    for (const p of PEOPLE) for (const x of p.contacts) if (x.c.startsWith("wa:")) { waTs.set(x.c.slice(3), x.at); if (x.alias) waTs.set(x.alias, x.at); }
    const tgBlocked = new Map<string, number>();
    let seq = 0, p3Refused = false;
    const failedIds = new Set<string>();
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const providers = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (u.host === "api.telegram.org") {
        if (!u.pathname.endsWith("/sendMessage")) return j({ ok: true, result: true });
        const to = String(b.chat_id);
        if ((tgBlocked.get(to) ?? 0) > clock.t) early.push(`telegram ${to} ${tgBlocked.get(to)! - clock.t} ms early`);
        if (to === "72003" && !p3Refused && plain(b.text).startsWith("[U3] R message 2 of 3")) { p3Refused = true; tgBlocked.set(to, clock.t + 61000); return j({ ok: false, error_code: 429, description: "Too Many Requests: retry after 61", parameters: { retry_after: 61 } }, 429); }
        if (to === "72009" && plain(b.text).includes("[U9] tg ask") && !got.some((g) => g.text === "busy-once-9")) { got.push({ prov: "x", to: "x", text: "busy-once-9", id: "x", t: 0 }); return j({ ok: false, error_code: 502, description: "Bad Gateway" }, 502); }
        const id = String(++seq);
        got.push({ prov: "telegram", to, text: b.text, id, t: clock.t });
        return j({ ok: true, result: { message_id: Number(id) } });
      }
      if (u.host === "graph.facebook.com") {
        if (b.status === "read") return j({ success: true });
        const to = String(b.to ?? b.recipient);
        if (b.type === "template") { templates.push(to); return j({ messages: [{ id: `wamid.t${++seq}` }] }); }
        const ts = waTs.get(to);
        if (ts === undefined || clock.t - ts >= DAY) { early.push(`whatsapp ${to} outside its window`); return j({ error: { code: 131047, message: "Re-engagement" } }, 400); }
        const id = `wamid.${++seq}`;
        got.push({ prov: "whatsapp", to, text: b.text.body, id, t: clock.t });
        return j({ messages: [{ id }] });
      }
      if (u.host === "a.loopmessage.com") {
        const id = `lm-${++seq}`;
        got.push({ prov: "loopmessage", to: String(b.contact), text: b.text, id, t: clock.t });
        return j({ message_id: id, success: true });
      }
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;
    const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: SECRET, TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: "loop-test", TELEGRAM_BOT_TOKEN: "tg-test",
      WHATSAPP_TOKEN: "wa-test", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_TEMPLATE_UPDATES: "updates_waiting", CAREER_TEXTING_NATIVE: "on", TRAINEE_SIGNUP: "closed" };
    const E = { get: (k: string) => env[k] || undefined };
    const sleep = async (ms: number) => { clock.t += ms; };
    const runs: any[] = [];
    const deliver = async () => {
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": SECRET } }), {
        env: E, now: () => clock.t, store: () => supabaseChannelStore(admin),
        send: (apiKey) => loopSend({ apiKey, fetch: providers, sleep: async () => {} }),
        adapters: (e) => adaptersFromEnv(e, { fetch: providers, clock: () => clock.t, sleep }),
        recordRun: async (r) => {
          const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out,
            capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 });
          if (error) throw new Error(`record run: ${error.message}`);
        },
      });
      const body = await res.json();
      eq(res.status, 200, `trainee-deliver: ${JSON.stringify(body)}`);
      runs.push(body);
      return body;
    };
    const chats: { userId: string; message: string }[] = [];
    const chat = async (a: any) => { chats.push({ userId: a.userId, message: a.message }); const n = Number(a.userId.slice(-2)); return { status: 200, threadId: null, reply: `[U${n}] answered: ${a.message}` }; };
    const headUser = async (a: { userId: string; now: number }) => { const s = supabaseChannelStore(admin, { user: a.userId }); const r = await deliverDue({ store: s, adapters: adaptersFromEnv(E, { fetch: providers, clock: () => clock.t, sleep }), now: a.now, limit: 40 }); await s.release(); return r; };
    const headKey = async (a: { userId: string; key: string; now: number }) => { const s = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } }); const r = await deliverDue({ store: s, adapters: adaptersFromEnv(E, { fetch: providers, clock: () => clock.t, sleep }), now: a.now, limit: 1 }); await s.release(); return r; };
    let mid = 0;
    const waPost = async (value: Record<string, unknown>) => {
      const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, ...value } }] }] }));
      const res = await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), {
        env: E, now: () => clock.t, store: () => inbound, chat, deliver: (a) => headUser(a),
        adapter: (e) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: "1", appSecret: WA_APP, fetch: providers, clock: () => clock.t, sleep }),
      });
      const body = await res.json();
      eq(res.status, 200, `whatsapp webhook: ${JSON.stringify(body)}`);
      return body;
    };
    const waText = async (from: string, userId: string | null, text: string) => {
      waTs.set(from, clock.t); if (userId) waTs.set(userId, clock.t);
      return await waPost({ contacts: [{ wa_id: from, ...(userId ? { user_id: userId } : {}) }], messages: [{ from, ...(userId ? { from_user_id: userId } : {}), id: `wamid.in${++mid}`, timestamp: String(Math.floor(clock.t / 1000)), type: "text", text: { body: text } }] });
    };
    const waFailed = async (id: string, code: number) => { failedIds.add(id); return await waPost({ statuses: [{ id, status: "failed", timestamp: String(Math.floor(clock.t / 1000)), recipient_id: "x", errors: [{ code, title: `error ${code}` }] }] }); };
    const lmPost = async (body: Record<string, unknown>) => {
      const res = await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST", body: JSON.stringify(body) }), {
        env: E, now: () => clock.t, store: () => inbound, send: (k) => loopSend({ apiKey: k, fetch: providers, sleep: async () => {} }), chat, deliverReply: (a) => headKey(a),
      });
      return { status: res.status, body: await res.json() };
    };
    const outbox = async (n: number) => await rows<{ key: string; status: string; error: string | null; contact: string | null; channel: string | null }>(db, `select key, status, error, contact, channel from public.career_outbox where user_id = ${q(uid(n))} order by id`);
    const reply = async (n: number, key: string, text: string, channel: string, at = T0 - MIN) => ok(await inbound.enqueueReply(uid(n), key, text, at, channel as any), `${key} queued`);
    const proactive = async (n: number, kind: string, i: number, at = T0 - 30 * MIN) =>
      await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(uid(n))}, ${q(`${kind}:r2c${n}-${i}`)}, ${q(kind)}, ${q(`[U${n}] ${kind} ${i}: an update.`)}, ${q(iso(at))})`);
    const B1 = paras("[U1] S", 3), B3 = paras("[U3] R", 3), B2 = paras("[U2] F", 1);

    await t.step("queue: rows for thirteen people on every channel", async () => {
      await reply(1, "reply:wa:r2c1", B1.join("\n\n"), "whatsapp");
      await reply(2, "reply:wa:r2c2", B2[0], "whatsapp");
      await reply(3, "reply:tg:r2c3", B3.join("\n\n"), "telegram");
      for (let i = 1; i <= 3; i++) ok(await inbound.enqueueReply(uid(4), `reply:tg:r2c4:${i}`, `[U4] part ${i} of 3: the answer.`, T0 - MIN, "telegram", { of: "reply:tg:r2c4", n: i }), "U4 part");
      await reply(5, "reply:tg:r2c5", "[U5] the answer.", "telegram"); await proactive(5, "digest", 1);
      await reply(8, "reply:r2c8", ["[U8] first bubble " + "word ".repeat(120), "[U8] second bubble " + "word ".repeat(120)].join("\n\n"), "imessage");
      for (let i = 1; i <= 3; i++) await proactive(10, "status", i);
      for (let i = 1; i <= 30; i++) await proactive(11, "status", i, T0 - 30 * MIN + i);
      for (let i = 1; i <= 20; i++) ok(await inbound.enqueueReply(uid(12), `reply:tg:r2c12:${i}`, i === 1 ? "[U12] **Acme *great** offer* today, part 1 of 20." : `[U12] part ${i} of 20.`, T0 - MIN, "telegram", { of: "reply:tg:r2c12", n: i }), "U12 part");
      for (let i = 1; i <= 12; i++) await proactive(13, "digest", i, T0 - 30 * MIN + i);
    });

    await t.step("the channels go: Telegram unlinked (U4, U5); then the runs (20 rows a run)", async () => {
      for (const n of [4, 5]) eq(Number((await db.sql.query(`select public.channel_telegram_unlink_as(${q(uid(n))}, ${q(iso(T0))})`))[0][0]), 1, `U${n}'s Telegram unlinked`);
      for (let i = 0; i < 7; i++) { await deliver(); clock.t += 30000; }
    });

    await t.step("WhatsApp: message 3 then message 2 fail (out of order); U1 writes; 2 and 3 go once each; a late copy finds nothing", async () => {
      const ids = got.filter((g) => g.to === "15550072001").map((g) => g.id);
      eq(ids.length, 3, "three messages went");
      await waFailed(ids[2], 131047); await waFailed(ids[1], 131047);
      eq((await outbox(1))[0].status, "held", "the row waits for U1's next message");
      clock.t += 5 * MIN;
      await waText("15550072001", "US.p1", "ok");
      clock.t += MIN; await deliver();
      await waFailed(ids[2], 131047); // Meta retries the webhook
      clock.t += 2 * MIN; await deliver();
      const arrived = got.filter((g) => g.to === "15550072001" && !failedIds.has(g.id) && g.text.includes("[U1] S message")).map((g) => B1.indexOf(g.text) + 1);
      eq(arrived, [1, 2, 3], "each message of the row arrived once, in order");
      eq((await outbox(1)).find((r) => r.key === "reply:wa:r2c1")!.status, "delivered", "the row is delivered");
      // 131026 on U2's row.
      const id2 = got.find((g) => g.to === "15550072002")!.id;
      await waFailed(id2, 131026);
      const r2 = (await outbox(2))[0];
      ok(r2.status === "failed" && /131026/.test(r2.error ?? ""), `U2's row says what Meta said: ${JSON.stringify(r2)}`);
    });

    await t.step("Telegram: a 429 for 61 s on message 2 of 3: the rest after it, once each, never early", async () => {
      for (let i = 0; i < 6; i++) { clock.t += 30000; await deliver(); }
      eq(got.filter((g) => g.to === "72003").map((g) => B3.indexOf(plain(g.text)) + 1), [1, 2, 3], "every message once, in order");
      eq((await outbox(3))[0].status, "delivered", "the row is delivered");
      ok(p3Refused, "the 429 happened");
    });

    await t.step("Telegram unlinked: the parts go to iMessage in order; with nothing left the answer fails with the reason", async () => {
      eq(got.filter((g) => g.text.startsWith("[U4]")).map((g) => [g.prov, g.to, g.text]), [1, 2, 3].map((i) => ["loopmessage", "+15550072004", `[U4] part ${i} of 3: the answer.`]), "U4's parts on iMessage");
      const o5 = await outbox(5);
      ok(o5[0].status === "failed" && /no other texting channel/.test(o5[0].error ?? ""), `U5's answer: ${JSON.stringify(o5[0])}`);
      eq(o5[1].status, "queued", "U5's digest waits (no channel)");
      eq(got.filter((g) => g.to === "72004" || g.to === "72005").length, 0, "nothing to the unlinked chats");
    });

    await t.step("a WhatsApp number now someone else's: told about sign-up, no turn as the old owner; U6's messages on iMessage", async () => {
      await reply(6, "reply:wa:r2c6", "[U6] the answer.", "whatsapp", clock.t); await proactive(6, "digest", 1, clock.t);
      const k = got.length;
      clock.t += MIN;
      await waText("15550072006", "US.stranger6", "hi who is this");
      clock.t += MIN; await deliver();
      eq(chats.filter((c) => c.userId === uid(6)).length, 0, "no turn as U6");
      eq(got.slice(k).filter((g) => g.to === "15550072006").map((g) => g.text), [SIGNUP_CLOSED_REPLY], "the stranger reads only the sign-up line");
      eq(got.filter((g) => g.text.startsWith("[U6]")).map((g) => [g.prov, g.to]).sort(), [["loopmessage", "+15550072066"], ["loopmessage", "+15550072066"]], "U6's answer and digest on iMessage");
    });

    await t.step("a person who changed their WhatsApp number: everything on the new one", async () => {
      for (let i = 1; i <= 2; i++) await proactive(7, "digest", i, clock.t);
      clock.t += MIN;
      await waPost({ contacts: [{ wa_id: "15550072007", user_id: "US.p7" }], messages: [{ from: "15550072007", from_user_id: "US.p7", id: "wamid.sys7", timestamp: String(Math.floor(clock.t / 1000)), type: "system", system: { body: "changed", wa_id: "15550072077", type: "user_changed_number" } }] });
      clock.t += MIN;
      await waText("15550072077", "US.p7", "new number here");
      clock.t += MIN; await deliver();
      ok(chats.some((c) => c.userId === uid(7) && c.message === "new number here"), "U7's message from the new number is U7's");
      const after = got.filter((g) => g.text.startsWith("[U7]"));
      ok(after.length === 3 && after.every((g) => g.to === "15550072077"), `U7's digests and answer on the new number: ${JSON.stringify(after.map((g) => g.to))}`);
    });

    await t.step("LoopMessage: message_failed marks the row; message_scheduled (Trainee's own text) runs no turn; a repeat changes nothing", async () => {
      const mine = got.filter((g) => g.to === "+15550072008");
      eq(mine.length, 2, "two bubbles went");
      const turns = chats.length;
      const sch = await lmPost({ alert_type: "message_scheduled", message_id: mine[0].id, recipient: "+15550072008", text: mine[0].text });
      eq(sch.status, 200); eq(chats.length, turns, "no turn from a callback carrying Trainee's own words");
      for (let i = 0; i < 2; i++) { const r = await lmPost({ alert_type: "message_failed", message_id: mine[1].id, recipient: "+15550072008", text: mine[1].text, error_code: 110 }); eq(r.status, 200); }
      const o8 = (await outbox(8))[0];
      ok(o8.status === "failed" && /LoopMessage message_failed/.test(o8.error ?? ""), `U8's row: ${JSON.stringify(o8)}`);
      eq(chats.length, turns, "still no turn");
    });

    await t.step("the home channel switched while WhatsApp's window held U10's updates: they go to Telegram", async () => {
      eq((await outbox(10)).map((r) => r.status), ["held", "held", "held"], "held for WhatsApp's window");
      await db.sql.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', ${q(uid(10))}, true), set_config('request.jwt.claims', ${q(JSON.stringify({ sub: uid(10), role: "authenticated" }))}, true); select public.channel_set_home('telegram'); commit;`);
      clock.t += MIN; await deliver();
      eq((await outbox(10)).map((r) => [r.status, r.contact]), [1, 2, 3].map(() => ["delivered", "tg:72010"]), "on Telegram now");
    });

    await t.step("two channels, LoopMessage's daily cap reached: U9's Telegram answer is not held behind their iMessage one", async () => {
      env.LOOPMESSAGE_DAILY_CONTACTS = "1";
      clock.t += MIN;
      await lmPost({ alert_type: "message_inbound", message_id: "lm-in-r2c9", recipient: "+15550072009", text: "im ask" });
      await reply(9, "reply:tg:r2c9", "[U9] tg ask answered.", "telegram", clock.t);
      await headKey({ userId: uid(9), key: "reply:tg:r2c9", now: clock.t }); // Telegram refuses it once (502)
      for (let i = 0; i < 3; i++) { clock.t += 2 * MIN; await deliver(); }
      const o9 = await outbox(9);
      eq(o9.find((r) => r.key.startsWith("reply:lm-in"))!.status, "queued", "the iMessage answer waits for tomorrow's allowance");
      eq(o9.find((r) => r.key === "reply:tg:r2c9")!.status, "delivered", "the Telegram answer went");
      delete env.LOOPMESSAGE_DAILY_CONTACTS;
    });

    await t.step("everything read back: nobody reads another's message; nothing twice; HTML valid; no early call; about 80 deliveries", async () => {
      const real = got.filter((g) => g.prov !== "x");
      for (const g of real) {
        const m = /^\[U(\d+)\]/.exec(plain(g.text));
        if (m) eq(owner.get(g.to) === Number(m[1]) || (g.to === "15550072077" && m[1] === "7"), true, `${g.prov} to ${g.to} read ${plain(g.text).slice(0, 40)}`);
      }
      const texts = real.filter((g) => !failedIds.has(g.id)).map((g) => `${g.to}|${g.text}`);
      eq(texts.length, new Set(texts).size, "nothing arrived twice");
      const u12 = real.filter((g) => g.to === "72012");
      eq(u12.map((g) => Number(/part (\d+) of/.exec(plain(g.text))?.[1])), Array.from({ length: 20 }, (_, i) => i + 1), "U12's twenty parts, in order");
      ok(u12[0].text.includes("<b>Acme <i>great</i></b><i> offer</i>"), `crossing emphasis as valid HTML: ${u12[0].text}`);
      eq(early, [], "no call before its retry_after, no WhatsApp text outside its window");
      eq(real.filter((g) => g.to === "15550072013").length, 12, "U13's digests");
      eq(real.filter((g) => g.to === "+15550072011").length, 30, "U11's updates");
      ok(real.length >= 80, `about 80 deliveries: ${real.length}`);
      eq(await rows(db, `select key from public.career_outbox where status = 'sending'`), [], "nothing stuck sending");
      const recorded = await rows(db, `select error from public.channel_delivery_runs`);
      ok(recorded.length === runs.length && recorded.every((r: any) => r.error === null), "every run recorded without an error");
      console.log(`[channel-r2 flow] ${real.length} deliveries, ${templates.length} templates, ${runs.length} runs, ${Date.now() - started} ms`);
    });
  } finally {
    await db.stop();
  }
} });
