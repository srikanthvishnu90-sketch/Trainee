// The Telegram chat flow, round 3, on Postgres (architect, 2026-10-31; the 10,000 generated scenarios over memory stores are
// scenarios-telegram-r3.test.ts). Sampled end to end: the REAL trainee-telegram webhook (handleTelegram, composed as its index.ts
// composes it: the inbound store over supabase-js, the service client for the job cards, the card buttons and Confirm, the
// head-start delivery over the channel store) and trainee-deliver's real handler for the every-minute run, on a real Postgres 16
// with every migration (tests/flow/pg.ts) behind the PostgREST double. The brain is a scripted stand-in (no model: what a turn
// answers is the scenario's), and Telegram is a fake Bot API with faults (scenarios/telegram-r3-world.ts bot: a 429 with
// retry_after, a 403, a timeout after Telegram took the message). The clock is real time plus a skew the test moves forward, so
// a retry_after of 61 seconds is waited without waiting. Every other host is refused. Per person, one of:
//   other-from      a tap in the owner's chat by someone else (callback_query.from is not the chat): nothing queued, nothing to
//                   the owner, the tap answered with why
//   forwarded-card  another account taps the owner's card in their own chat: nothing queued, nothing of the owner's shown
//   dup-confirm     the same Confirm update delivered three times: one application queued, one answer
//   changed         Confirm after the application was prepared again: nothing approved, the current one re-shown; its own
//                   Confirm queues exactly it, once
//   edit            "yes" edited into "no" after Trainee answered: no turn, one answer saying the edit changed nothing
//   deeplink        someone else's chat opens the owner's link: nothing linked, and the owner's own chat can still use it
//                   (linked on the owner's YES in their chat: TELEGRAM LINK OWNERSHIP, 2026-10-31)
//   ratelimit       an answer in parts, the 2nd refused with 429 retry_after 61 three times: every part once, in order
//   more-429        the #301 rest refused with 429: the rest and the links after it arrive later, in order, once
//   blocked         a 403 (blocked) on part 2 of 4: the person's STOP; nothing after it is tried
//   timeout         a long answer whose 2nd message timed out after Telegram took it: the rest arrives, nothing twice
//   group           a group's "/start", "yes" and a tap: nothing sent anywhere, no turn, no STOP
// After every person: every message to a private chat, within Telegram's limits, valid, retry_after honoured; nothing left the
// machine; no token or secret in a response or a log line.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-telegram-r3.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { bot, SECRET, TOKEN } from "./scenarios/telegram-r3-world.ts";
import { plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { textingNativeOn } from "../../supabase/functions/_shared/channel_voice.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";
import { hashTag, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";

const CI = Deno.env.get("CI") === "true";
const N = Number(Deno.env.get("TG3_FLOW_N") || 55);
const KINDS = ["other-from", "forwarded-card", "dup-confirm", "changed", "edit", "deeplink", "ratelimit", "more-429", "blocked", "timeout", "group"] as const;
const CHAT = (n: number) => 7830000 + n * 3;
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const EDIT_NOT_READ_REPLY = (IN as Record<string, unknown>).EDIT_NOT_READ_REPLY as string ?? "(no answer to an edit)";
const NOT_YOUR_TAP = "That button isn't yours, so nothing was done.";

Deno.test({
  name: `Telegram round 3 on Postgres: ${N} people through the real webhook and delivery, the database read back`,
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
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    try {
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, {});
      const sql = async (s: string) => (await fast.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      // ------------------------------------------------------------------------------------------ the clock, Telegram, the network
      let skew = 0;
      const now = () => Date.now() + skew;
      const clock = { get t() { return now(); } };
      const sleep = async (ms: number) => { skew += ms; };
      const B = bot(clock as { t: number });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(input as any, init);
        if (u.host === "api.telegram.org") return await B.fetch(input as any, init);
        outbound.push(`${u.host}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

      // ------------------------------------------------------------------------------------------ the deployment's secrets
      const vars: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeFlowR3Bot", TRAINEE_SIGNUP: "closed",
        TRAINEE_DELIVER_SECRET: ["TEST", "deliver", "secret", "r3", "0123456789", "abcdefghij"].join("-") };
      const env = { get: (k: string) => vars[k] || undefined };
      const adapterOf = (e: typeof env) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: B.fetch, clock: now, sleep, native: textingNativeOn(e) });
      const adapters = () => adaptersFromEnv(env, { fetch: B.fetch, clock: now, sleep });

      // ------------------------------------------------------------------------------------------ the brain, scripted
      const turns: { userId: string; message: string }[] = [];
      const replies = new Map<string, (message: string, n: number) => Record<string, unknown>>();
      const chat = async (a: any) => {
        turns.push({ userId: a.userId, message: a.message });
        const extra = replies.get(a.userId)?.(a.message, turns.length) ?? {};
        return { status: 200, threadId: a.threadId ?? null, reply: `TEST answer ${turns.length}.`, ...extra } as any;
      };
      // trainee-telegram's index.ts: the head start is one delivery run over the channel store for that row (deliverer)
      const deliver = async (a: { userId: string; key: string; now: number }) => {
        const store = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } });
        const r = await deliverDue({ store, adapters: adapters(), now: a.now, limit: 1 });
        await store.release();
        return r;
      };
      let upd = 910000;
      const raws = new Map<number, string>();
      const post = async (body: Record<string, unknown> | null, again?: number) => {
        await sql("delete from public.agent_rate_limits");
        const id = again ?? ++upd;
        const raw = again ? raws.get(again)! : JSON.stringify({ update_id: id, ...body });
        raws.set(id, raw);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: raw }),
          { env, now, store: () => supabaseInboundStore(admin), chat, admin, deliver, adapter: adapterOf });
        const text = await res.text();
        if (res.status !== 200) fail("webhook", `HTTP ${res.status} ${text.slice(0, 160)}`);
        if (text.includes(TOKEN) || text.includes(SECRET)) fail("webhook", "a response carries a secret");
        return { id, text };
      };
      // trainee-deliver, the every-minute run, `minutes` times
      const cron = async (minutes: number) => {
        for (let i = 0; i < minutes; i++) {
          skew += 60000;
          const res = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": vars.TRAINEE_DELIVER_SECRET } }), {
            env, now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }), adapters: () => adapters(), recordRun: async () => {},
          } as any);
          if (res.status !== 200) fail("deliver", `HTTP ${res.status}`);
          await res.body?.cancel();
        }
      };
      const from = (c: number) => ({ chat: { id: c, type: "private" }, from: { id: c, is_bot: false, first_name: "TEST" }, date: 1 });
      let mid = 100;
      const text = (c: number, t: string, m?: number) => ({ message: { message_id: m ?? ++mid, ...from(c), text: t } });
      const tap = (c: number, data: string, o: { from?: number; msgChat?: number; chatType?: string } = {}) => {
        const id = `cb-r3-${++mid}`;
        return { id, body: { callback_query: { id, from: { id: o.from ?? c, is_bot: false, first_name: "TEST" }, chat_instance: `ci${c}`, message: { message_id: 1, chat: { id: o.msgChat ?? c, type: o.chatType ?? "private" }, date: 1 }, data } } };
      };
      const said = (c: number, k: number) => B.to(c).slice(k).map(plainOf);
      let seq = 0;
      const person = async (c: number) => {
        const u = crypto.randomUUID();
        await sql(`insert into auth.users (id, email) values ('${u}', 'tg3-${++seq}@example.test'); insert into public.profiles (id) values ('${u}');
          insert into public.channel_contacts (contact, user_id, created_at, updated_at, last_inbound_at) values ('tg:${c}', '${u}', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour');
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"authority_version":0,"paused":false}'::jsonb) on conflict (user_id, key) do nothing;
          ${confirmedResumeSql(u)} insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('a', 64) || '.pdf') on conflict do nothing;`);
        return u;
      };
      const prep = async (u: string, jobId: string, url: string, v: string) => JSON.parse(await sql(`with p as (select jsonb_build_object('version',1,'user_id','${u}','job_id',${q(jobId)},'company','Acme','url',${q(url)},
          'fields',jsonb_build_array(jsonb_build_object('name','first_name','label','First name','value','Alex'),jsonb_build_object('name','cover_letter','label','Cover letter','value',${q(v)})),
          'privacy_epoch',0,'account_version',0,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64)) as pl)
        insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines) select '${u}', ${q(jobId)}, 'Acme', ${q(url)}, pl, public.career_apply_payload_hash(pl), array['Acme'] from p
        returning json_build_object('id', id, 'hash', payload_hash)`));
      // The owner's card (a turn that found the posting) and the exact payload (Apply): returns the Confirm the person saw.
      const ownerWithConfirm = async (c: number, n: number) => {
        const u = await person(c);
        const jobId = `lever:acme:r3${n}`, url = `https://jobs.lever.co/acme/r3${n}`;
        await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values (${q(jobId)}, 'lever', 'acme', 'Acme', 'Data Analyst (TEST)', 'Austin, TX', ${q(url)}, 'Requirements\nSQL.', now() - interval '2 hours', now() - interval '2 hours', now()) on conflict (job_id) do nothing;`);
        const p1 = await prep(u, jobId, url, `First cover ${n}.`);
        replies.set(u, (m) => (/find/.test(m) ? { postings: [{ job_id: jobId, company: "Acme", title: "Data Analyst (TEST)", location: "Austin, TX", url, fit: { reasons: [], gaps: [] } }] } : {}));
        await post(text(c, "find me data jobs"));
        const ref = await refOf(u, jobId);
        const t = tap(c, `jca:${ref}`);
        await post(t.body);
        const confirm = B.to(c).flatMap((m) => m.buttons).map((b: any) => b.callback_data as string).find((d) => /^jcy:/.test(d ?? ""));
        if (confirm !== `jcy:${ref}:${hashTag(p1.hash)}`) fail(`owner ${n}`, `setup: the payload page's Confirm is ${confirm}, want the prepared hash's`);
        return { u, jobId, url, ref, p1, confirm: confirm ?? `jcy:${ref}:${hashTag(p1.hash)}` };
      };
      const jobs = async (u: string) => await json(`select payload_hash, approval_hash from public.career_apply_jobs where user_id = '${u}'`);
      const parts = (k: number, n: number) => Array.from({ length: n }, (_, i) => `R3 part ${i + 1} of ${n} for person ${k}. ${"Details that matter. ".repeat(40)}`.trim());

      for (let n = 0; n < N; n++) {
        const kind = KINDS[n % KINDS.length], c = CHAT(n), who = `person ${n} (${kind})`;
        bump(kind);
        const before = { failures: failures.length };
        if (kind === "other-from" || kind === "forwarded-card") {
          const o = await ownerWithConfirm(c, n);
          const other = c + 1, ou = await person(other);
          const k0 = B.to(c).length, k1 = B.to(other).length;
          const t = kind === "other-from" ? tap(c, o.confirm, { from: other }) : tap(other, o.confirm);
          await post(t.body);
          if ((await jobs(o.u)).length || (await jobs(ou)).length) fail(who, "an application was queued on someone else's tap");
          if (B.to(c).length !== k0) fail(who, `the owner's chat got ${JSON.stringify(said(c, k0)).slice(0, 160)}`);
          if (said(other, k1).some((x) => x.includes("First cover"))) fail(who, "the tapper was shown the owner's payload");
          const ans = B.answers.find((a) => a.id === t.id)?.text ?? "";
          if (kind === "other-from" && ans !== NOT_YOUR_TAP) fail(who, `the tap was answered ${JSON.stringify(ans)}`);
          if (!ans) fail(who, "the tap was not answered");
        } else if (kind === "dup-confirm") {
          const o = await ownerWithConfirm(c, n);
          const t = tap(c, o.confirm);
          const a0 = B.answers.length, r = await post(t.body);
          const k = B.to(c).length;
          await post(null, r.id); await post(null, r.id);
          const j = await jobs(o.u);
          if (j.length !== 1 || j[0].payload_hash !== o.p1.hash || j[0].approval_hash !== o.p1.hash) fail(who, `queued ${JSON.stringify(j)}, want the shown payload once`);
          if (B.answers.length - a0 !== 1) fail(who, `${B.answers.length - a0} answers to one tap delivered three times`);
          if (B.to(c).length !== k) fail(who, "a retried tap sent more messages");
        } else if (kind === "changed") {
          const o = await ownerWithConfirm(c, n);
          await sql(`update public.career_apply_prepared set state = 'expired' where id = '${o.p1.id}'`);
          const p2 = await prep(o.u, o.jobId, o.url, `Second cover ${n}.`);
          const k = B.to(c).length;
          await post(tap(c, o.confirm).body);
          const s = said(c, k).join("\n");
          if ((await jobs(o.u)).length) fail(who, "the old Confirm queued an application");
          if (!/nothing was approved/i.test(s)) fail(who, `no refusal: ${s.slice(0, 160)}`);
          const fresh = B.to(c).slice(k).flatMap((m) => m.buttons).map((b: any) => b.callback_data as string).find((d) => /^jcy:/.test(d ?? ""));
          if (fresh !== `jcy:${o.ref}:${hashTag(p2.hash)}` || !s.includes(`Second cover ${n}.`)) fail(who, `the current application was not re-shown with its own Confirm (${fresh})`);
          if (fresh) await post(tap(c, fresh).body);
          const j = await jobs(o.u);
          if (j.length !== 1 || j[0].payload_hash !== p2.hash || j[0].approval_hash !== p2.hash) fail(who, `the fresh Confirm queued ${JSON.stringify(j)}, want the current payload once`);
        } else if (kind === "edit") {
          const u = await person(c);
          const m = ++mid;
          await post(text(c, "yes", m));
          const t0 = turns.filter((x) => x.userId === u).length, k = B.to(c).length;
          await post({ edited_message: { message_id: m, ...from(c), edit_date: 2, text: "no" } });
          await cron(1);
          if (turns.filter((x) => x.userId === u).length !== t0) fail(who, "an edit ran a turn");
          const s = said(c, k);
          if (s.length !== 1 || s[0] !== EDIT_NOT_READ_REPLY) fail(who, `the edit was answered ${JSON.stringify(s).slice(0, 200)}`);
        } else if (kind === "deeplink") {
          const owner = await person(c), other = c + 1;
          await person(other);
          const code = await supabaseInboundStore(admin).issueLinkNonce!(owner, now());
          const k = B.to(other).length;
          await post(text(other, `/start ${code}`));
          if (!said(other, k).includes(IN.TELEGRAM_LINKED_ELSEWHERE_REPLY)) fail(who, `another account's chat was answered ${JSON.stringify(said(other, k)).slice(0, 160)}`);
          // TELEGRAM LINK OWNERSHIP (2026-10-31): opening the link asks the owner's chat; the owner's YES there links the new chat.
          const mine = c + 2;
          await post(text(mine, `/start ${code}`));
          if (!said(mine, 0).includes(IN.TELEGRAM_LINK_CONFIRM_REPLY)) fail(who, `the owner's new chat was answered ${JSON.stringify(said(mine, 0)).slice(0, 160)}`);
          const y = B.to(mine).length;
          await post(text(c, `LINK ${/reply LINK ([0-9]{4}) /.exec(said(c, 0).filter((t) => /^Someone wants to link Telegram /.test(t)).at(-1) ?? "")?.[1] ?? "none"}`));
          const linked = await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${mine}'), '')`);
          if (linked !== owner) fail(who, "the owner's own chat could not use their link after another account's chat opened it");
          if (!said(mine, y).includes(IN.LINKED_HERE_REPLY)) fail(who, `after the YES the owner's chat was answered ${JSON.stringify(said(mine, y)).slice(0, 160)}`);
        } else if (kind === "ratelimit" || kind === "blocked" || kind === "timeout" || kind === "more-429") {
          const u = await person(c);
          const want = kind === "timeout" ? null : kind === "more-429" ? null : parts(n, 4);
          if (kind === "timeout") replies.set(u, () => ({ reply: Array.from({ length: 4 }, (_, i) => `R3 long ${i + 1} for ${n}. ${"Words that carry the point. ".repeat(30)}`.trim()).join("\n\n") }));
          else if (kind === "more-429") replies.set(u, () => ({ reply: `The head of answer ${n}.`, shape: { attachments: [], links: [`https://example.org/r3/${n}/a`, `https://example.org/r3/${n}/b`], more: [`The rest of answer ${n}.`] } }));
          else replies.set(u, () => ({ reply: "intro", parts: want }));
          if (kind === "ratelimit") B.faults.push({ chat: c, method: "sendMessage", nth: 1, kind: "429", retryAfter: 61, times: 3 });
          if (kind === "blocked") B.faults.push({ chat: c, method: "sendMessage", nth: 1, kind: "403", times: 1000 });
          if (kind === "timeout") B.faults.push({ chat: c, method: "sendMessage", nth: 1, kind: "timeout" });
          if (kind === "more-429") B.faults.push({ chat: c, method: "sendMessage", nth: 1, kind: "429", retryAfter: 45 });
          await post(text(c, `tell me everything ${n}`));
          await cron(kind === "ratelimit" ? 10 : 3);
          const got = B.to(c).filter((m) => m.method === "sendMessage").map(plainOf);
          const rows = await json(`select key, status, coalesce(error, '') as error from public.career_outbox where user_id = '${u}' order by part nulls first, id`);
          if (kind === "blocked") {
            if (JSON.stringify(got) !== JSON.stringify(want!.slice(0, 1))) fail(who, `sent ${JSON.stringify(got.map((x) => x.slice(0, 22)))}, want only part 1 (blocked at part 2)`);
            const tried = B.attempts.filter((a) => a.chat === String(c) && a.method === "sendMessage").length;
            if (tried !== 2) fail(who, `${tried} sends to a chat that blocked Trainee at the 2nd (want 2)`);
            if ((await sql(`select opted_out from public.channel_contacts where contact = 'tg:${c}'`)) !== "t") fail(who, "the block was not recorded as STOP");
          } else if (kind === "timeout") {
            const heads = got.map((x) => /^R3 long (\d)/.exec(x)?.[1]).filter(Boolean);
            if (JSON.stringify(heads) !== JSON.stringify(["1", "2", "3", "4"])) fail(who, `the long answer arrived as ${JSON.stringify(heads)} (${got.length} messages), want 1-4 once each; rows ${JSON.stringify(rows).slice(0, 300)}`);
          } else if (kind === "more-429") {
            const w2 = [`The head of answer ${n}.`, `The rest of answer ${n}.`, `https://example.org/r3/${n}/a`, `https://example.org/r3/${n}/b`];
            if (JSON.stringify(got) !== JSON.stringify(w2)) fail(who, `arrived ${JSON.stringify(got)}, want ${JSON.stringify(w2)}; rows ${JSON.stringify(rows).slice(0, 300)}`);
          } else if (JSON.stringify(got) !== JSON.stringify(want)) fail(who, `arrived ${JSON.stringify(got.map((x) => x.slice(0, 22)))}, want the 4 parts once each in order; rows ${JSON.stringify(rows).slice(0, 400)}`);
        } else if (kind === "group") {
          const u = await person(c), G = -1009300000000 - n;
          const t0 = turns.length;
          const g = { chat: { id: G, type: "supergroup", title: "TEST" }, from: { id: c, is_bot: false }, date: 1 };
          await post({ message: { message_id: ++mid, ...g, text: "/start" } });
          await post({ message: { message_id: ++mid, ...g, text: "yes" } });
          await post({ message: { message_id: ++mid, ...g, text: "/stop" } });
          const t = tap(c, `jcy:${"a".repeat(12)}:${"b".repeat(16)}`, { msgChat: G, chatType: "supergroup" });
          await post(t.body);
          if (turns.length !== t0) fail(who, "a group message ran a turn");
          if ((await sql(`select opted_out from public.channel_contacts where contact = 'tg:${c}'`)) === "t") fail(who, "a group's /stop stopped the person");
          if (B.answers.find((a) => a.id === t.id)?.text !== "This button works in your private chat with me.") fail(who, "the group tap was not answered with the group line");
          void u;
        }
        if (failures.length === before.failures) bump(`${kind} ok`);
      }

      for (const v of B.problems()) fail("Bot API", v);
      if (B.msgs.some((x) => Number(x.chat) < 0)) fail("Bot API", "a message to a group");
      if (outbound.length) fail("network", [...new Set(outbound)].join(", "));
      const secrets = logged.filter((l) => l.includes(TOKEN) || l.includes(SECRET));
      if (secrets.length) fail("logs", `${secrets.length} log lines carry a secret`);
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      console.log(`[flow-telegram-r3] ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${B.msgs.length} messages, ${B.answers.length} taps answered; ${failures.length} failures`);
      if (failures.length) console.log(failures.slice(0, 60).join("\n"));
      assertNode.deepEqual(failures, [], failures.slice(0, 40).join("\n"));
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
