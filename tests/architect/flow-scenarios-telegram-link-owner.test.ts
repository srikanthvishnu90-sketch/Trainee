// Telegram link ownership on Postgres (architect, 2026-10-31; the seeded scenarios over memory stores are
// scenarios-telegram-link-owner.test.ts). Owner rule of 2026-10-29: "A signed, expiring, single-use link is not proof of who opened
// it. An unused, forwarded or copied link must not let another person read my private data or act as me." End to end through the
// REAL trainee-telegram webhook (handleTelegram composed as its index.ts composes it: the inbound store over supabase-js, the
// service client for the card buttons, the head-start delivery over the channel store) on a real Postgres 16 with every migration
// (tests/flow/pg.ts) behind the PostgREST double; the brain is a stand-in, Telegram a fake Bot API, every other host refused.
// The account's own channel here is its earlier Telegram chat (a person moving to a new Telegram account, the link made in the
// app); iMessage as the asked channel runs in flow-scenarios-identity.test.ts ("tokens"). Per journey:
//   stranger        the link forwarded to a stranger, who opens it, asks about the account, says yes, taps Approve: nothing
//   owner           the person's new chat opens it; their YES in their chat links it, once
//   twice           the same chat opens it twice: one question; the YES links it
//   expired         opened after 10 minutes: nothing asked
//   late            the YES after 15 minutes: nothing linked
//   replay          after it linked, a stranger opens it again: nothing
//   wrong           yeses from another account's chat and from the new chat itself: nothing
//   forwarded       the account's chat forwards a "yes": nothing
//   stop            the account's chat says STOP after the question, then yes: nothing
//   deleted         the account deleted while the question waits, then the chat writes: nothing
//   race            two strangers open the same link at once: one question, nothing linked without the YES
//   two-codes       the owner's chat and a stranger's open two links of the account: the YES links neither
// After every journey, read back from the database: no chat the YES did not confirm is the account's, no turn ran as the account
// from it, nothing it was sent carries the account's answers; no application queued; nothing left the machine; no secret logged.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-telegram-link-owner.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { bot, SECRET, TOKEN } from "./scenarios/telegram-r3-world.ts";
import { plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";

const CI = Deno.env.get("CI") === "true";
const X = IN as Record<string, unknown>;
const CONFIRM = (X.TELEGRAM_LINK_CONFIRM_REPLY as string) ?? "<TELEGRAM_LINK_CONFIRM_REPLY>";
const WAITING = (X.TELEGRAM_LINK_WAITING_REPLY as string) ?? "<TELEGRAM_LINK_WAITING_REPLY>";
const AMBIGUOUS = (X.LINK_AMBIGUOUS_REPLY as string) ?? "<LINK_AMBIGUOUS_REPLY>";
const ASK = /^Someone wants to link Telegram (@[A-Za-z0-9_]{5,32}|\(no username; Telegram id [0-9]{1,20}\)|\(an account with no username\)) to your Trainee\. To allow it, reply LINK ([0-9]{4}|\{code\}) here within 15 minutes\. A plain yes does not link it; ignore this if it wasn't you\./;
const JOURNEYS = ["stranger", "owner", "twice", "expired", "late", "replay", "wrong", "forwarded", "stop", "deleted", "race", "two-codes"] as const;
const MIN = 60000;

Deno.test({
  name: `Telegram link ownership on Postgres: ${JOURNEYS.length} journeys through the real webhook, the database read back`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    let closeSession: (() => Promise<void>) | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const failures: string[] = [];
    const fail = (who: string, why: string) => failures.push(`${who}: ${why}`);
    try {
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, {});
      const sql = async (s: string) => (await fast.sql(s)).trim();

      let skew = 0;
      const now = () => Date.now() + skew;
      const sleep = async (ms: number) => { skew += ms; };
      const B = bot({ get t() { return now(); } } as { t: number });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(input as any, init);
        if (u.host === "api.telegram.org") return await B.fetch(input as any, init);
        outbound.push(u.host);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const vars: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeLinkOwnerBot", TRAINEE_SIGNUP: "closed" };
      const env = { get: (k: string) => vars[k] || undefined };
      const adapterOf = (e: typeof env) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: B.fetch, clock: now, sleep });
      const adapters = () => adaptersFromEnv(env, { fetch: B.fetch, clock: now, sleep });
      const turns: { userId: string; message: string; chat: number }[] = [];
      let cur = 0;
      const chat = async (a: any) => { turns.push({ userId: a.userId, message: a.message, chat: cur }); return { status: 200, threadId: a.threadId ?? null, reply: `PRIVATE answer for ${a.userId}.` } as any; };
      const deliver = async (a: { userId: string; key: string; now: number }) => {
        const store = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } });
        const r = await deliverDue({ store, adapters: adapters(), now: a.now, limit: 1 });
        await store.release();
        return r;
      };
      let upd = 930000, mid = 100;
      const post = async (body: Record<string, unknown>) => {
        await sql("delete from public.agent_rate_limits");
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({ update_id: ++upd, ...body }) }), { env, now, store: () => supabaseInboundStore(admin), chat, admin, deliver, adapter: adapterOf });
        const text = await res.text();
        if (res.status !== 200) fail("webhook", `HTTP ${res.status} ${text.slice(0, 160)}`);
        if (text.includes(TOKEN) || text.includes(SECRET)) fail("webhook", "a response carries a secret");
      };
      const handles = new Map<number, string>();
      const from = (c: number) => ({ chat: { id: c, type: "private" }, from: { id: c, is_bot: false, first_name: "TEST", ...(handles.has(c) ? { username: handles.get(c) } : {}) }, date: 1 });
      const say = async (c: number, t: string, forwarded = false) => {
        cur = c;
        await post({ message: { message_id: ++mid, ...from(c), text: t, ...(forwarded ? { forward_origin: { type: "user", sender_user: { id: 4242, is_bot: false, first_name: "F" }, date: 1 } } : {}) } });
      };
      const tapIn = async (c: number, data: string) => {
        cur = c;
        const id = `cb-lo-${++mid}`;
        await post({ callback_query: { id, from: from(c).from, chat_instance: `ci${c}`, message: { message_id: 1, chat: { id: c, type: "private" }, date: 1 }, data } });
        return B.answers.find((a) => a.id === id)?.text ?? "";
      };
      const said = (c: number, k = 0) => B.to(c).slice(k).map(plainOf);
      const ownerOf = async (c: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${c}'), '')`);
      let seq = 0;
      const person = async (c: number) => {
        const u = crypto.randomUUID();
        await sql(`insert into auth.users (id, email) values ('${u}', 'tglo-${++seq}@example.test'); insert into public.profiles (id) values ('${u}');
          insert into public.channel_contacts (contact, user_id, created_at, updated_at, last_inbound_at) values ('tg:${c}', '${u}', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour');`);
        return u;
      };
      const code = async (u: string) => await supabaseInboundStore(admin).issueLinkNonce!(u, now());

      for (let n = 0; n < JOURNEYS.length; n++) {
        const kind = JOURNEYS[n], who = `journey ${n} (${kind})`;
        const O = 7840000 + n * 10, M = O + 1, S = O + 2, S2 = O + 3, Other = O + 4;
        const u = await person(O);
        handles.set(S, `stranger_${n}x`); handles.set(M, `owner_${n}x`);
        const confirmed = new Set<number>();
        const t0 = turns.length;
        const asks = () => said(O).filter((x) => ASK.test(x));
        const yes = async (c: number) => { confirmed.add(c); await say(O, `LINK ${ASK.exec(asks().filter((x) => x.includes(handles.has(c) ? `@${handles.get(c)} ` : `Telegram id ${c})`)).at(-1) ?? "")?.[2] ?? "none"}`); };
        const k = await code(u);
        if (kind === "stranger") {
          await say(S, `/start ${k}`);
          if (!said(S).includes(CONFIRM)) fail(who, `the stranger was told ${JSON.stringify(said(S))}`);
          const q = asks();
          if (q.length !== 1 || !q[0].includes(`@stranger_${n}x`)) fail(who, `the account's chat was asked ${JSON.stringify(q)}`);
          const k1 = B.to(S).length;
          await say(S, "what do you know about me");
          await say(S, "yes");
          if (JSON.stringify(said(S, k1)) !== JSON.stringify([WAITING, WAITING])) fail(who, `the waiting chat was told ${JSON.stringify(said(S, k1))}`);
          const ans = await tapIn(S, `jcy:${"a".repeat(12)}:${"b".repeat(16)}`);
          if (!/Nothing was approved/.test(ans)) fail(who, `a tap in the waiting chat was answered ${JSON.stringify(ans)}`);
          skew += 16 * MIN;
          await say(S, "hello again");
        } else if (kind === "owner" || kind === "twice") {
          await say(M, `/start ${k}`);
          if (!said(M).includes(CONFIRM)) fail(who, `the new chat was told ${JSON.stringify(said(M))}`);
          if (kind === "twice") {
            const k1 = B.to(M).length;
            await say(M, `/start ${k}`);
            if (JSON.stringify(said(M, k1)) !== JSON.stringify([WAITING])) fail(who, `opened again, told ${JSON.stringify(said(M, k1))}`);
            if (asks().length !== 1) fail(who, `one link asked ${asks().length} times`);
          }
          if (await ownerOf(M) === u) fail(who, "linked before the YES");
          const k1 = B.to(M).length;
          await yes(M);
          if (await ownerOf(M) !== u) fail(who, "the YES did not link the owner's chat");
          if (!said(M, k1).includes(IN.LINKED_HERE_REPLY)) fail(who, `after the YES the chat was told ${JSON.stringify(said(M, k1))}`);
          const t1 = turns.length;
          await say(M, "what do you know about me");
          if (!turns.slice(t1).some((t) => t.userId === u)) fail(who, "the linked chat does not run as the account");
        } else if (kind === "expired") {
          skew += 11 * MIN;
          await say(S, `/start ${k}`);
          if (!said(S).includes(IN.TELEGRAM_LINK_INVALID_REPLY)) fail(who, `an expired link was answered ${JSON.stringify(said(S))}`);
          if (asks().length) fail(who, "an expired link asked");
        } else if (kind === "late") {
          await say(M, `/start ${k}`);
          skew += 16 * MIN;
          await say(O, "yes");
        } else if (kind === "replay") {
          await say(M, `/start ${k}`);
          await yes(M);
          await say(S, `/start ${k}`);
          if (!said(S).includes(IN.TELEGRAM_LINK_INVALID_REPLY)) fail(who, `a used link was answered ${JSON.stringify(said(S))}`);
        } else if (kind === "wrong") {
          await person(Other);
          await say(S, `/start ${k}`);
          await say(Other, "yes");
          await say(S, "yes");
        } else if (kind === "forwarded") {
          await say(S, `/start ${k}`);
          await say(O, "yes", true);
        } else if (kind === "stop") {
          await say(S, `/start ${k}`);
          await say(O, "/stop");
          await say(O, "yes");
        } else if (kind === "deleted") {
          await say(S, `/start ${k}`);
          await sql(`delete from public.career_outbox where user_id = '${u}'; delete from public.channel_contacts where user_id = '${u}'; delete from auth.users where id = '${u}'`);
          await say(S, "what do you know about me");
          if ((await sql(`select count(*) from public.channel_link_requests where contact = 'tg:${S}'`)) !== "0") fail(who, "the deleted account's question is still there");
        } else if (kind === "race") {
          await Promise.all([say(S, `/start ${k}`), say(S2, `/start ${k}`)]);
          const told = [...said(S), ...said(S2)];
          if (told.filter((x) => x === CONFIRM).length !== 1 || told.filter((x) => x === IN.TELEGRAM_LINK_INVALID_REPLY).length !== 1) fail(who, `two openers were told ${JSON.stringify(told)}`);
          if ((await sql(`select count(*) from public.channel_link_requests where user_id = '${u}'`)) !== "1") fail(who, "one link asked more than once");
        } else if (kind === "two-codes") {
          const k2 = await code(u);
          await say(M, `/start ${k}`);
          await say(S, `/start ${k2}`);
          const k1 = B.to(O).length, t1 = turns.length;
          await say(O, "yes");
          if (turns.length === t1 || said(O, k1).includes(AMBIGUOUS)) fail(who, `a plain yes with two chats waiting did not go on to the turn: ${JSON.stringify(said(O, k1))}`);
        }
        // ------------------------------------------------------------------------------------- read back
        for (const c of [M, S, S2, Other]) {
          if (confirmed.has(c)) continue;
          if (c !== Other && await ownerOf(c) === u) fail(who, `chat ${c === M ? "M" : "S"} is the account's without its YES`);
          for (const x of said(c)) if (x.includes(`PRIVATE answer for ${u}`)) fail(who, `an unconfirmed chat read the account's answer: ${x.slice(0, 80)}`);
          if (said(c).some((x) => ASK.test(x))) fail(who, "the question went to a chat that opened the link");
        }
        // every turn that ran as the account came from its own chat or a chat its YES linked
        const stray = turns.slice(t0).filter((t) => t.userId === u && t.chat !== O && !confirmed.has(t.chat));
        if (stray.length) fail(who, `${stray.length} turns ran as the account from a chat it never confirmed`);
        const linked = Number(await sql(`select count(*) from public.channel_contacts where user_id = '${u}' and contact like 'tg:%' and contact <> 'tg:${O}'`));
        if (linked > 1) fail(who, `one link linked ${linked} chats`);
        if (!confirmed.size && linked) fail(who, "a chat was linked without the account's YES");
        if (Number(await sql(`select count(*) from public.career_apply_jobs where user_id = '${u}'`))) fail(who, "an application was queued");
      }
      for (const v of B.problems()) fail("Bot API", v);
      if (outbound.length) fail("network", [...new Set(outbound)].join(", "));
      const secrets = logged.filter((l) => l.includes(TOKEN) || l.includes(SECRET));
      if (secrets.length) fail("logs", `${secrets.length} log lines carry a secret`);
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      console.log(`[flow-telegram-link-owner] ${JOURNEYS.length} journeys; ${B.msgs.length} messages; ${failures.length} failures`);
      assertNode.deepStrictEqual(failures, []);
    } finally {
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      globalThis.fetch = realFetch;
      h?.restore();
      await closeSession?.();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
