// Channel delivery round 4 end to end on Postgres (2026-11-05): a seeded sample of the round's scenarios through the real
// delivery handlers (trainee-deliver's handleDeliver over supabaseChannelStore with the two-lane claim, and the inbound head
// start, channel_runtime.ts deliverer(admin, env, {clock, sleep})) on Postgres 16 with every migration (tests/flow/pg.ts) and
// the PostgREST double, with fake provider APIs at the HTTP boundary (api.telegram.org, graph.facebook.com,
// a.loopmessage.com) that answer with every shape of error, and the database itself refusing a write or a read now and then.
// Pacing runs on a virtual clock (tests/flow/virtual-clock.ts): Telegram's shared bucket (channel_rate_acquire) is read at it
// and a wait moves it, never the wall. Nothing leaves the machine; no model runs. The database is read back:
//   - a run whose write of "delivered" the database refused: only that row ends "delivery outcome unknown"; every other row it
//     had claimed goes back and is delivered (before: each failed as "outcome unknown", never sent);
//   - a refused STOP read: that row counts an attempt and goes later; never blocks the rows behind it;
//   - a provider refusing the credentials (Telegram 401, WhatsApp 190, LoopMessage 401) for a while: nothing failed for it;
//     everything goes once they work; a 200 whose body was cut short: the row is delivered, its later messages sent;
//   - STOP while parts are queued, Telegram unlinked mid-conversation, a chat blocked (403) or migrated (400): nothing after
//     STOP or to a chat that is not the person's; every part at most once and in order; nothing left "sending";
//   - no recorded reason carries a message's words or a credential.
// And, on its own with nothing left to chance (the CI flake of 2026-11-05): a row the provider refused twice whose STOP read is
// then refused on its third try is tried again and delivered, not failed for good.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-channel-r4.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore, UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { telegramPacerFromEnv } from "../../supabase/functions/_shared/channel_pacer.ts";
import { deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { deliverDue, MAX_ATTEMPTS, RUN_FAILED_NOTE } from "../../supabase/functions/_shared/channel.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { rng } from "./scenarios-channel-r4-battery.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const MIN = 60000, HOUR = 3600000;
const uid = (n: number) => `00000000-0000-4000-8000-0000000c74${String(n).padStart(2, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const TOKEN = /q(\d+)x(\d+)w(\d+)/g;
const EMOJI = ["👨‍👩‍👧‍👦", "🇺🇸", "👍🏽", "नमस्ते", "😀"];
const PEOPLE = 20;

Deno.test({ name: "channel delivery round 4 end to end on Postgres: provider errors, refused writes, credentials, STOP, unlink, parts in order", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    // the database refusing a call now and then: a write recording a delivery, or the STOP read
    const refuse = { delivered: 0, optOutRead: 0, hit: 0 };
    const flaky = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body = String(init?.body ?? "");
      if (refuse.delivered > 0 && init?.method === "PATCH" && u.includes("/rest/v1/career_outbox") && body.includes('"status":"delivered"')) { refuse.delivered--; refuse.hit++; return new Response(JSON.stringify({ message: "connection reset by peer" }), { status: 503 }); }
      if (refuse.optOutRead > 0 && u.includes("/rest/v1/rpc/channel_opted_out")) { refuse.optOutRead--; return new Response(JSON.stringify({ message: "connection reset by peer" }), { status: 503 }); }
      return await double.fetch(input as any, init);
    }) as typeof fetch;
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: flaky }, auth: { persistSession: false, autoRefreshToken: false } });
    const inbound = supabaseInboundStore(admin);
    const vc = virtualClock();
    const r = rng(20261105);
    // ------------------------------------------------------------------------------------------- people, channels, the queue
    type P = { n: number; contacts: string[]; stoppedAt: number | null; unlinkedAt: number | null };
    const people: P[] = [];
    const ownerOf = new Map<string, number>();
    for (let n = 1; n <= PEOPLE; n++) {
      const kinds = n % 5 === 0 ? ["telegram", "imessage"] : n % 7 === 0 ? ["whatsapp", "telegram"] : [(["imessage", "telegram", "whatsapp"] as const)[n % 3]];
      const contacts = kinds.map((k) => k === "imessage" ? `+1555007${String(n).padStart(4, "0")}` : k === "telegram" ? `tg:74${String(n).padStart(4, "0")}` : `wa:1555008${String(n).padStart(4, "0")}`);
      people.push({ n, contacts, stoppedAt: null, unlinkedAt: null });
      for (const c of contacts) ownerOf.set(c, n);
      await db.sql.query(`insert into auth.users(id, email) values (${q(uid(n))}, ${q(`r4c${n}@example.test`)});
        insert into public.profiles(id) values (${q(uid(n))});
        insert into public.career_watch_kv(user_id, key, value) values (${q(uid(n))}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${contacts.map((c, i) => `insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, home${/^wa:/.test(c) ? ", phone" : ""}) values (${q(c)}, ${q(uid(n))}, ${q(iso(vc.clock() - HOUR))}, ${q(iso(vc.clock() - 48 * HOUR))}, ${i === 0}${/^wa:/.test(c) ? `, ${q(`+${c.slice(3)}`)}` : ""});`).join("\n")}`);
    }
    // At most 3,500 bytes (a cluster made without a UTF-8 locale counts the 4,000 of career_outbox's check in bytes).
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const words = (p: number, x: number, n: number) => {
      const out: string[] = [];
      for (let k = 0; k < n; k++) {
        const w = `q${p}x${x}w${k}${r.chance(0.3) ? ` ${r.pick(EMOJI).repeat(r.int(1, 4))}` : ""}${k % 40 === 39 ? "\n\n" : ""}`;
        if (bytes(out.join(" ")) + bytes(w) > 3500) break;
        out.push(w);
      }
      sizes.set(`q${p}x${x}`, out.length);
      return out.join(" ");
    };
    const sizes = new Map<string, number>(); // q<p>x<x> -> words
    let x = 0;
    const queue = async (at: number) => {
      for (const p of people) {
        const ch = p.contacts[0].startsWith("tg:") ? "telegram" : p.contacts[0].startsWith("wa:") ? "whatsapp" : "imessage";
        const parts = r.int(1, 3), of = `reply:r4c${p.n}-${++x}`;
        for (let i = 1; i <= parts; i++) {
          const n = r.int(10, 400); ++x;
          ok(await inbound.enqueueReply(uid(p.n), parts > 1 ? `${of}:${i}` : of, words(p.n, x, n), at, ch, parts > 1 ? { of, n: i } : undefined), "queued");
        }
        for (const kind of ["digest", "status"]) {
          const n = r.int(5, 120); ++x;
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(uid(p.n))}, ${q(`${kind}:r4c${p.n}-${x}`)}, ${q(kind)}, ${q(words(p.n, x, n))}, ${q(iso(at))})`);
        }
      }
    };
    // ------------------------------------------------------------------------------------------- the providers
    type Call = { prov: string; to: string; text: string; accepted: boolean; t: number; fault: string };
    const calls: Call[] = [];
    const blocked = new Set<string>(), migrated = new Set<string>();
    const authDown: Record<string, number> = {};
    let seq = 0;
    const tokens = { tg: `7401:${"T".repeat(34)}`, wa: `EAAG${"w".repeat(40)}`, lm: `lm_${"k".repeat(36)}` };
    const j = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const providers = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = JSON.parse(String(init?.body ?? "{}"));
      const prov = u.host === "api.telegram.org" ? "telegram" : u.host === "graph.facebook.com" ? "whatsapp" : u.host === "a.loopmessage.com" ? "imessage" : null;
      if (!prov) throw new TypeError(`network refused: ${u.host}`);
      if (prov === "telegram" && !u.pathname.endsWith("/sendMessage")) return j({ ok: true, result: true });
      if (prov === "whatsapp" && (b.type === "template" || b.status === "read")) return j({ messages: [{ id: `wamid.t${++seq}` }], success: true });
      const to = prov === "telegram" ? `tg:${b.chat_id}` : prov === "whatsapp" ? `wa:${b.to ?? b.recipient}` : String(b.contact);
      const text = plain(String(prov === "telegram" ? b.text : prov === "whatsapp" ? b.text?.body : b.text));
      const now = vc.clock();
      let fault = (authDown[prov] ?? 0) > now ? "401" : blocked.has(to) ? "403" : migrated.has(to) ? "400migrated"
        : r.chance(0.18) ? r.pick(["429", "502", "timeout", "cut200", "500", prov === "telegram" ? "403" : "502", prov === "telegram" ? "400migrated" : "429"]) : "ok";
      const accepted = fault === "ok" || fault === "cut200" || fault === "500" || fault === "timeout";
      calls.push({ prov, to, text, accepted, t: now, fault });
      const id = ++seq;
      switch (fault) {
        case "ok": return prov === "telegram" ? j({ ok: true, result: { message_id: id } }) : prov === "whatsapp" ? j({ messages: [{ id: `wamid.${id}` }] }) : j({ message_id: `lm-${id}`, success: true });
        case "cut200": return new Response('{"ok":true,"result":{"message_id":', { status: 200 });
        case "429": return prov === "telegram" ? j({ ok: false, error_code: 429, description: "Too Many Requests: retry after 4", parameters: { retry_after: 4 } }, 429) : j({ error: { code: 130429, message: "Rate limit hit" } }, 429);
        case "502": return j("Bad Gateway", 502);
        case "500": return j("Internal Server Error", 500);
        case "timeout": throw new DOMException("The signal has been aborted", "TimeoutError");
        case "403": blocked.add(to); return j({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403);
        case "400migrated": migrated.add(to); return j({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001234567890 } }, 400);
        default: return prov === "whatsapp" ? j({ error: { code: 190, type: "OAuthException", message: "Error validating access token: Session has expired" } }, 401) : prov === "telegram" ? j({ ok: false, error_code: 401, description: "Unauthorized" }, 401) : j({ success: false }, 401);
      }
    }) as typeof fetch;
    const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: "d".repeat(40), LOOPMESSAGE_API_KEY: tokens.lm, TELEGRAM_BOT_TOKEN: tokens.tg, WHATSAPP_TOKEN: tokens.wa, WHATSAPP_PHONE_NUMBER_ID: "1", CAREER_TEXTING_NATIVE: "on" };
    const E = { get: (k: string) => env[k] || undefined };
    const runs: any[] = [];
    const runStarts: number[] = [];
    const deliver = async () => {
      env.DELIVER_BATCH_SIZE = String(r.int(5, 40)); env.DELIVER_CONCURRENCY = String(r.int(1, 4));
      runStarts.push(vc.clock());
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": env.TRAINEE_DELIVER_SECRET } }), {
        env: E, now: vc.clock, store: (so) => supabaseChannelStore(admin, { lanes: true, shard: so?.shard }),
        send: (apiKey) => loopSend({ apiKey, fetch: providers, sleep: vc.sleep }),
        adapters: (e) => adaptersFromEnv(e, { fetch: providers, clock: vc.clock, sleep: vc.sleep, sharedPace: telegramPacerFromEnv(e, admin, { sleep: vc.sleep, now: vc.clock }) }),
        recordRun: async (x) => { runs.push(x); },
      });
      return await res.json();
    };
    // (the head start sends through the same fake providers: before, it had no fetch and called the real provider APIs)
    const head = deliverer(admin, E, { clock: vc.clock, sleep: vc.sleep, fetch: providers });

    await t.step("the runs: faults at the providers and in the database, STOP, unlink, a credential outage", async () => {
      await queue(vc.clock() - MIN);
      for (let i = 0; i < 24; i++) {
        if (i === 2) refuse.delivered = 1;
        if (i === 4) refuse.optOutRead = 1;
        if (i === 6) authDown.whatsapp = vc.clock() + 12 * MIN;
        if (i === 7) authDown.telegram = vc.clock() + 8 * MIN;
        if (i === 9) refuse.delivered = 1;
        if (i === 3 || i === 10) {
          for (const p of people.filter((p) => p.n % 6 === i % 6 + 1 && p.stoppedAt === null)) {
            // STOP from a chat the person still has (an unlinked Telegram chat is no longer theirs)
            const from = p.unlinkedAt !== null ? p.contacts.find((c) => !c.startsWith("tg:"))! : p.contacts[0];
            await db.sql.query(`select public.channel_set_opt_out(${q(from)}, true, ${q(iso(vc.clock()))})`);
            p.stoppedAt = vc.clock();
          }
        }
        if (i === 5) for (const p of people.filter((p) => p.n % 5 === 0)) { eq(Number((await db.sql.query(`select public.channel_telegram_unlink_as(${q(uid(p.n))}, ${q(iso(vc.clock()))})`))[0][0]), 1); p.unlinkedAt = vc.clock(); }
        if (i === 8) await queue(vc.clock());
        // the head start of one person's answer beside the scheduled run
        const p = people[r.int(0, PEOPLE - 1)];
        const k = (await rows<{ key: string }>(db, `select key from public.career_outbox where user_id = ${q(uid(p.n))} and kind = 'reply' and status = 'queued' order by id limit 1`))[0]?.key;
        await Promise.all([deliver(), k ? head({ userId: uid(p.n), key: k, now: vc.clock() }).catch(() => null) : null]);
        await vc.sleep(r.int(40, 90) * 1000);
      }
      // drain: the sweep's ten minutes, then the retries
      for (let i = 0; i < 12; i++) { await vc.sleep(i === 0 ? 11 * MIN : 6 * MIN); await deliver(); }
    });

    await t.step("read back: every row says what happened; nothing twice, in order, nothing after STOP, nothing to a chat not theirs", async () => {
      const out = await rows<{ id: string; user_id: string; key: string; status: string; error: string | null; text: string; contact: string | null; part: number | null; part_of: string | null; deliver_at: string }>(db,
        `select id::text, user_id::text, key, status, error, text, contact, part, part_of, deliver_at::text from public.career_outbox order by id`);
      const byTag = new Map<string, Call[]>();
      for (const c of calls) {
        ok(c.text.length <= (c.prov === "imessage" ? 5000 : 4096) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c.text), `${c.prov} message within its limit, whole characters`);
        ok(ownerOf.has(c.to), `sent only to a linked chat: ${c.to}`);
        const tags = new Set([...c.text.matchAll(TOKEN)].map((m) => `q${m[1]}x${m[2]}`));
        for (const tg of tags) (byTag.get(tg) ?? byTag.set(tg, []).get(tg)!).push(c);
      }
      const counts: Record<string, number> = {};
      for (const o of out) {
        counts[o.status] = (counts[o.status] ?? 0) + 1;
        const tag = /q(\d+)x(\d+)w0/.exec(o.text)!;
        const key = `q${tag[1]}x${tag[2]}`, p = people[Number(tag[1]) - 1], mine = byTag.get(key) ?? [];
        // at most once, in order, per chat
        const per = new Map<string, number[]>();
        for (const c of mine.filter((c) => c.accepted)) for (const m of c.text.matchAll(TOKEN)) if (`q${m[1]}x${m[2]}` === key) (per.get(c.to) ?? per.set(c.to, []).get(c.to)!).push(Number(m[3]));
        for (const [to, ps] of per) for (let i = 1; i < ps.length; i++) ok(ps[i] > ps[i - 1], `${o.key}: word ${ps[i]} again or out of order on ${to}`);
        if (o.status === "delivered") ok([...per.values()].some((ps) => new Set(ps).size === sizes.get(key)), `${o.key} delivered whole`);
        ok(o.status !== "sending", `${o.key} not left sending`);
        if (o.status !== "delivered" && o.status !== "queued") ok(!!o.error, `${o.key} ${o.status} says why`);
        ok(!/HTTP 401|\(190\)|HTTP 200$/.test(o.error ?? ""), `${o.key} never failed on the credentials or a 200: ${o.error}`);
        if (o.error === UNKNOWN_OUTCOME) ok(mine.length > 0, `${o.key} "outcome unknown" only after a send`);
        ok(!TOKEN.test(o.error ?? "") && !Object.values(tokens).some((s) => (o.error ?? "").includes(s)), `${o.key}: no words or credential in the reason`);
        TOKEN.lastIndex = 0;
        // nothing after STOP (as the run that sent it saw it); nothing to a chat after it was unlinked
        for (const c of mine) {
          const run = Math.max(...runStarts.filter((s) => s <= c.t));
          // an answer to a message the person sent after STOP still goes (the STOP reply promises it); nothing else does
          if (p.stoppedAt !== null && run > p.stoppedAt) ok(o.key.startsWith("reply:") && Date.parse(o.deliver_at) > p.stoppedAt, `${o.key} sent after STOP`);
          if (p.unlinkedAt !== null && c.to.startsWith("tg:") && c.t > p.unlinkedAt) ok(false, `${o.key} sent to the unlinked chat ${c.to}`);
        }
      }
      // parts in order per chat: part n+1 of an answer never arrives before part n
      for (const of of new Set(out.filter((o) => o.part_of).map((o) => o.part_of!))) {
        const parts = out.filter((o) => o.part_of === of).sort((a, b) => a.part! - b.part!);
        const first = parts.map((o) => { const tag = /q(\d+)x(\d+)w0/.exec(o.text)!; const c = (byTag.get(`q${tag[1]}x${tag[2]}`) ?? []).filter((c) => c.accepted); return c.length ? Math.min(...c.map((c) => calls.indexOf(c))) : null; });
        for (let i = 1; i < first.length; i++) if (first[i] !== null && first[i - 1] !== null) ok(first[i]! > first[i - 1]!, `${of}: part ${i + 1} before part ${i}`);
      }
      // the refused writes: one row each ended "outcome unknown" (it went), every other row of those runs went
      eq(refuse.hit, 2, "two writes of 'delivered' were refused");
      eq(out.filter((o) => o.error === UNKNOWN_OUTCOME).length, 2, "only the two rows whose record was refused end 'outcome unknown'");
      ok(out.filter((o) => o.error === RUN_FAILED_NOTE && o.status === "failed").length === 0, "the row whose STOP read was refused went later");
      ok(calls.some((c) => c.fault === "401") && calls.some((c) => c.fault === "cut200"), "the outage and the cut 200 happened");
      ok(out.filter((o) => o.status === "delivered").length >= out.length * 0.5, `most rows delivered: ${JSON.stringify(counts)}`);
      eq(await rows(db, `select id from public.career_outbox where status = 'sending'`), [], "nothing stuck sending");
      ok(runs.every((x) => x.error === null || /connection reset/.test(x.error)), "a run fails only on the refused write");
      console.log(`[channel-r4 flow] ${out.length} rows ${JSON.stringify(counts)}, ${calls.length} provider calls, ${runs.length} runs, ${Date.now() - started} ms`);
    });
  } finally {
    await db.stop();
  }
} });

Deno.test({ name: "channel delivery round 4 on Postgres: a row the provider refused twice is not lost to one refused STOP read on its third try", sanitizeResources: false, sanitizeOps: false, async fn() {
  // Before: the refused read counted as the row's last attempt and the row ended "failed" (RUN_FAILED_NOTE, no retry), never
  // sent. The main test above hit this only when its random faults gave the row of the refused read two provider refusals first.
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    let refuseOptOut = 1;
    const flaky = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (refuseOptOut > 0 && u.includes("/rest/v1/rpc/channel_opted_out")) { refuseOptOut--; return new Response(JSON.stringify({ message: "connection reset by peer" }), { status: 503 }); }
      return await double.fetch(input as any, init);
    }) as typeof fetch;
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: flaky }, auth: { persistSession: false, autoRefreshToken: false } });
    const T = Date.parse("2026-11-05T15:00:00Z"), u = uid(99), contact = "+15550079999";
    await db.sql.query(`insert into auth.users(id, email) values (${q(u)}, 'r4c99@example.test');
      insert into public.profiles(id) values (${q(u)});
      insert into public.career_watch_kv(user_id, key, value) values (${q(u)}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, home) values (${q(contact)}, ${q(u)}, ${q(iso(T - HOUR))}, ${q(iso(T - 48 * HOUR))}, true);
      insert into public.career_outbox(user_id, key, kind, text, deliver_at, status, attempts, error, retry_at)
        values (${q(u)}, 'status:r4c99-1', 'status', 'your application was viewed', ${q(iso(T - HOUR))}, 'failed', ${MAX_ATTEMPTS - 1}, 'LoopMessage HTTP 502', ${q(iso(T - MIN))})`);
    const sent: string[] = [];
    const send = async (to: string, bubbles: string[]) => { sent.push(`${to}|${bubbles.join("/")}`); return { ok: true as const, id: `lm-${sent.length}` }; };
    const run = (now: number) => deliverDue({ store: supabaseChannelStore(admin, { lanes: true }), send, now });
    const row = async () => (await rows<{ status: string; attempts: number; error: string | null; retry_at: string | null }>(db, `select status, attempts, error, retry_at::text from public.career_outbox where key = 'status:r4c99-1'`))[0];
    let threw = "";
    try { await run(T); } catch (e) { threw = (e as Error).message; }
    ok(/read opt-out/.test(threw), `the run fails on the refused STOP read: ${threw}`);
    const a = await row();
    eq([a.status, a.attempts, a.error], ["failed", MAX_ATTEMPTS, RUN_FAILED_NOTE], "the run failure is recorded as one attempt");
    ok(a.retry_at !== null && Date.parse(a.retry_at) > T, `and the row is tried again, not failed for good: ${JSON.stringify(a)}`);
    eq(sent, [], "nothing went in the failed run");
    await run(Date.parse(a.retry_at!));
    eq((await row()).status, "delivered", "the next run after the backoff delivers it");
    eq(sent, [`${contact}|your application was viewed`], "once");
  } finally {
    await db.stop();
  }
} });
