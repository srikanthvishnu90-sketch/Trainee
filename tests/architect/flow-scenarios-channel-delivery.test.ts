// Channel delivery end to end on Postgres (2026-10-29): about 100 deliveries through trainee-deliver's real handler
// (handleDeliver, wired as its index.ts wires it: supabaseChannelStore over supabase-js, every channel's adapter from the
// secrets with CAREER_TEXTING_NATIVE on, the run recorded in channel_delivery_runs), on a real Postgres 16 with every
// migration (tests/flow/pg.ts), the PostgREST double at the Supabase hop (tests/flow/postgrest.ts), and fake providers at
// the HTTP boundary (api.telegram.org, graph.facebook.com, a.loopmessage.com): nothing leaves the machine, no model runs.
// Eight people on iMessage, Telegram and WhatsApp, run after run until nothing is due, then the database read back:
//   - every message reached only its own person's address, and every part of a reply arrived once, in order (a reply of 60
//     parts included: the old 50-part ceiling refused its 51st row; a part retried after a 429 still before the next);
//   - STOP: every proactive message held (alert, card, brief, digest), the rest of an answer to a message sent before
//     the STOP held and said why, an answer to a message sent after it delivered; a Telegram block is the person's STOP;
//   - WhatsApp outside its window: held, never sent, one template; a row bound to iMessage goes to iMessage, the rest to
//     the person's home channel;
//   - a later part is never claimed while another claim holds an earlier one (two sessions, one holding the lock).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-channel-delivery.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { STOPPED_REPLY_NOTE } from "../../supabase/functions/_shared/channel.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const T0 = Date.parse("2026-10-29T15:00:00Z"), MIN = 60000, HOUR = 3600000;
const SECRET = "d".repeat(40);
const uid = (n: number) => `00000000-0000-4000-8000-0000000c71${String(n).padStart(2, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();

// Who is where. Address as each provider sees it: Telegram's chat id, WhatsApp's wa_id, LoopMessage's contact.
const PEOPLE = [
  { n: 1, contacts: [["+15550007101", T0 - HOUR]] },
  { n: 2, contacts: [["tg:7102", T0 - HOUR]] },
  { n: 3, contacts: [["wa:15550007103", T0 - HOUR]] },
  { n: 4, contacts: [["wa:15550007104", T0 - 30 * HOUR]] },
  { n: 5, contacts: [["+15550007105", T0 - HOUR]] },
  { n: 6, contacts: [["tg:7106", T0 - 10 * MIN], ["+15550007106", T0 - 5 * HOUR]] },
  { n: 7, contacts: [["tg:7107", T0 - HOUR]] },
  { n: 8, contacts: [["+15550007108", T0 - HOUR]] },
] as const;
const ownerOf = new Map<string, number>();
for (const p of PEOPLE) for (const [c] of p.contacts) ownerOf.set(c.replace(/^(tg|wa):/, ""), p.n);

Deno.test({ name: "channel delivery end to end on Postgres: ~100 deliveries through trainee-deliver on every channel, run after run", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const inbound = supabaseInboundStore(admin);
    for (const p of PEOPLE) {
      await db.sql.query(`insert into auth.users(id, email) values (${q(uid(p.n))}, ${q(`cd${p.n}@example.test`)});
        insert into public.profiles(id) values (${q(uid(p.n))});
        insert into public.career_watch_kv(user_id, key, value) values (${q(uid(p.n))}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${p.contacts.map(([c, seen]) => `insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at) values (${q(c)}, ${q(uid(p.n))}, ${q(iso(seen))}, ${q(iso(T0 - 48 * HOUR))});`).join("\n")}`);
    }
    // What is queued. Every text names its person and its place, so what arrives can be traced back.
    const proactive = async (n: number, kind: string, i: number, at = T0 - 30 * MIN, channel: string | null = null) =>
      await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel) values (${q(uid(n))}, ${q(`${kind}:cd${n}-${i}`)}, ${q(kind)}, ${q(`U${n} ${kind} ${i}: a short update.`)}, ${q(iso(at))}, ${channel ? q(channel) : "null"})`);
    const reply = async (n: number, id: string, parts: number, at: number, channel: string) => {
      const key = `reply:${id}`;
      if (parts === 1) return void ok(await inbound.enqueueReply(uid(n), key, `U${n} ${id} part 1 of 1: the answer.`, at, channel as any), "queued");
      for (let i = 1; i <= parts; i++) ok(await inbound.enqueueReply(uid(n), `${key}:${i}`, `U${n} ${id} part ${i} of ${parts}: the answer goes on.`, at, channel as any, { of: key, n: i }), `part ${i} of ${key} queued`);
    };
    await t.step("queue: proactive messages for everyone, replies in parts (one of 60), and a STOP between two of U5's answers", async () => {
      for (const k of ["card", "brief", "digest", "status"]) await proactive(1, k, 1);
      await reply(1, "lm-cd1", 5, T0 - 2 * MIN, "imessage");
      await reply(2, "tg:cd2", 60, T0 - 3 * MIN, "telegram"); // over the 50-part ceiling 20261021070000 kept
      await proactive(2, "digest", 1);
      await proactive(3, "brief", 1); await proactive(3, "status", 2);
      await reply(3, "wa:cd3", 3, T0 - 2 * MIN, "whatsapp");
      await proactive(4, "digest", 1); await proactive(4, "card", 2);
      await reply(4, "wa:cd4", 1, T0 - 26 * HOUR, "whatsapp");
      await reply(5, "lm-cd5a", 2, T0 - 20 * MIN, "imessage"); // the message it answers came before the STOP
      await inbound.setOptOut("+15550007105", true, T0 - 10 * MIN);
      await reply(5, "lm-cd5b", 1, T0 - 5 * MIN, "imessage"); // after it
      for (const k of ["alert", "card", "brief", "digest"]) await proactive(5, k, 1);
      for (const k of ["brief", "status", "digest"]) await proactive(6, k, 1); // the home channel: Telegram, written to last
      await reply(6, "lm-cd6", 1, T0 - MIN, "imessage"); // bound to the channel it came in on
      await proactive(7, "status", 1);
      for (let i = 1; i <= 20; i++) await proactive(8, "status", i, T0 - 30 * MIN + i);
    });

    // The providers. LoopMessage refuses U1's second part once (429: nothing went out); Telegram says U7 blocked the bot.
    const got: { provider: string; to: string; text: string }[] = [], templates: string[] = [];
    let refusedOnce = false;
    const providers = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (u.host === "api.telegram.org" && u.pathname.endsWith("/sendMessage")) {
        if (b.chat_id === 7107) return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 });
        got.push({ provider: "telegram", to: String(b.chat_id), text: b.text });
        return new Response(JSON.stringify({ ok: true, result: { message_id: got.length } }), { status: 200 });
      }
      if (u.host === "graph.facebook.com") {
        if (b.type === "template") { templates.push(b.to); return new Response(JSON.stringify({ messages: [{ id: `wamid.t${templates.length}` }] }), { status: 200 }); }
        got.push({ provider: "whatsapp", to: String(b.to), text: b.text.body });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${got.length}` }] }), { status: 200 });
      }
      if (u.host === "a.loopmessage.com") {
        if (!refusedOnce && /^U1 lm-cd1 part 2 /.test(b.text)) { refusedOnce = true; return new Response("busy", { status: 429 }); }
        got.push({ provider: "loopmessage", to: String(b.contact), text: b.text });
        return new Response(JSON.stringify({ message_id: `lm-${got.length}` }), { status: 200 });
      }
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;
    const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: "loop-test", TELEGRAM_BOT_TOKEN: "tg-test", WHATSAPP_TOKEN: "wa-test",
      WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_TEMPLATE_UPDATES: "updates_waiting", CAREER_TEXTING_NATIVE: "on" };
    const deliver = async (now: number) => {
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => now, store: () => supabaseChannelStore(admin),
        send: (apiKey) => loopSend({ apiKey, fetch: providers, sleep: async () => {} }),
        adapters: (e) => adaptersFromEnv(e, { fetch: providers, clock: () => now, sleep: async () => {} }),
        recordRun: async (r) => {
          const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out,
            capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 });
          if (error) throw new Error(`record run: ${error.message}`);
        },
      });
      const body = await res.json();
      eq(res.status, 200, `trainee-deliver: ${JSON.stringify(body)}`);
      return body;
    };
    const runs: any[] = [];
    await t.step("deliver: run after run (every two minutes) until nothing is due", async () => {
      for (let i = 0; i < 12; i++) {
        const r = await deliver(T0 + i * 2 * MIN);
        runs.push(r);
        const left = await rows(db, `select id from public.career_outbox where status in ('queued', 'sending') or (status = 'failed' and retry_at is not null)`);
        if (!left.length) break;
      }
      const left = await rows(db, `select key, status from public.career_outbox where status in ('queued', 'sending') or (status = 'failed' and retry_at is not null)`);
      eq(left, [], `nothing left due after ${runs.length} runs: ${JSON.stringify(runs)}`);
      ok(got.length >= 100, `about 100 deliveries: ${got.length}`);
    });
    const outbox = async (n: number) => await rows<{ key: string; status: string; error: string | null }>(db, `select key, status, error from public.career_outbox where user_id = ${q(uid(n))} order by id`);
    await t.step("nobody reads anyone else's message: every text reached the address of the person it names", () => {
      for (const g of got) eq(`U${ownerOf.get(g.to)}`, g.text.split(" ")[0], `${g.provider} to ${g.to}: ${g.text}`);
    });
    await t.step("every part of every reply once and in order (60 parts on Telegram; a part retried after a 429 still before the next)", async () => {
      for (const [n, id, parts] of [[1, "lm-cd1", 5], [2, "tg:cd2", 60], [3, "wa:cd3", 3]] as const) {
        const seq = got.filter((g) => g.text.startsWith(`U${n} ${id} part `)).map((g) => Number(/part (\d+) of/.exec(g.text)![1]));
        eq(seq, Array.from({ length: parts }, (_, i) => i + 1), `U${n}'s ${id} arrived in order, each part once`);
      }
      ok(refusedOnce, "the 429 happened");
      eq((await outbox(2)).filter((o) => o.key.startsWith("reply:")).map((o) => o.status), Array(60).fill("delivered"), "all 60 rows delivered");
    });
    await t.step("STOP: proactive held, the rest of an answer to a message before the STOP held and said why, an answer after it delivered", async () => {
      const o = await outbox(5);
      eq(o.map((x) => [x.key, x.status]), [["reply:lm-cd5a:1", "skipped_opt_out"], ["reply:lm-cd5a:2", "skipped_opt_out"], ["reply:lm-cd5b", "delivered"],
        ["alert:cd5-1", "skipped_opt_out"], ["card:cd5-1", "skipped_opt_out"], ["brief:cd5-1", "skipped_opt_out"], ["digest:cd5-1", "skipped_opt_out"]], "U5's rows");
      ok(o.filter((x) => x.key.startsWith("reply:lm-cd5a")).every((x) => x.error === STOPPED_REPLY_NOTE), "said why");
      eq(got.filter((g) => g.to === "+15550007105").map((g) => g.text), ["U5 lm-cd5b part 1 of 1: the answer."], "U5 read only the answer to what they sent after STOP");
    });
    await t.step("a Telegram block is the person's STOP: recorded, nothing retried, nothing later sent", async () => {
      eq((await outbox(7)).map((x) => x.status), ["skipped_opt_out"], "U7's row");
      eq((await rows(db, `select opted_out from public.channel_contacts where contact = 'tg:7107'`)).map((r: any) => r.opted_out), [true], "the block is recorded");
      await proactive(7, "digest", 2, T0 + 30 * MIN);
      await deliver(T0 + 31 * MIN);
      eq((await outbox(7)).map((x) => x.status), ["skipped_opt_out", "skipped_opt_out"], "a later digest is held too");
    });
    await t.step("WhatsApp outside its window: held whole, never sent, one template; the open window delivers", async () => {
      eq((await outbox(4)).map((x) => x.status), ["held", "held", "held"], "U4's rows wait for their next message");
      eq(got.filter((g) => g.to === "15550007104").length, 0, "nothing sent outside the window");
      eq(templates, ["15550007104"], "one template, to U4 only, however many runs");
      eq((await outbox(3)).map((x) => x.status), Array(5).fill("delivered"), "U3, inside the window");
    });
    await t.step("each row on its channel: bound to iMessage goes to iMessage, the rest to the home channel (Telegram)", async () => {
      eq(got.filter((g) => g.text.startsWith("U6 ")).map((g) => [g.provider, g.to, g.text.split(":")[0]]).sort(), [
        ["loopmessage", "+15550007106", "U6 lm-cd6 part 1 of 1"], ["telegram", "7106", "U6 brief 1"], ["telegram", "7106", "U6 digest 1"], ["telegram", "7106", "U6 status 1"]], "U6's messages");
    });
    await t.step("a later part is never claimed while another claim holds an earlier one (two sessions)", async () => {
      await reply(8, "lm-race", 3, T0 + 40 * MIN, "imessage");
      const holder = await db.conn();
      await holder.query(`begin; select id from public.career_outbox where key = 'reply:lm-race:1' for update`);
      const claimer = await db.conn();
      await claimer.query("set role service_role");
      const raced = await claimer.query(`select key from public.career_outbox_claim(${q(iso(T0 + 41 * MIN))}, 20) where key like 'reply:lm-race:%'`);
      await holder.query("rollback");
      eq(raced.map((r) => r[0]), [], "while part 1 is held by another claim, parts 2 and 3 wait (the old claim took them)");
      const after = await claimer.query(`select key from public.career_outbox_claim(${q(iso(T0 + 42 * MIN))}, 20) where key like 'reply:lm-race:%' order by key`);
      eq(after.map((r) => r[0]), ["reply:lm-race:1", "reply:lm-race:2", "reply:lm-race:3"], "then all three, in one run");
      holder.close(); claimer.close();
    });
    await t.step("honest states: nothing left sending or due; every run recorded without an error", async () => {
      eq(await rows(db, `select key from public.career_outbox where status = 'sending' and key not like 'reply:lm-race%'`), [], "nothing stuck sending");
      const recorded = await rows(db, `select error from public.channel_delivery_runs`);
      ok(recorded.length >= runs.length && recorded.every((r: any) => r.error === null), `runs recorded: ${JSON.stringify(recorded)}`);
      console.log(`[channel-delivery flow] ${got.length} deliveries, ${templates.length} template, ${runs.length} runs, ${Date.now() - started} ms`);
    });
  } finally {
    await db.stop();
  }
} });
