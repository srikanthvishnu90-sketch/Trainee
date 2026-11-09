// R10 (architect, 2026-11-09): the interim line of a slow turn ("on it — looking for roles now") went straight to Telegram
// and nothing recorded it, so a replay could only compute it. It is now a career_outbox row: kind 'interim', key
// interim:tg:<update id> (as the answer's reply:tg:<update id>), already delivered, with the exact text Telegram was sent. A delivered row is never
// claimed, so it is never sent twice.
// Through the REAL trainee-telegram webhook, the REAL Supabase inbound store over Postgres 16 (every migration, behind the
// PostgREST double), a fake Bot API, and a fake clock that makes the turn slow. The turn itself is a stub: what is checked is
// what the person was sent and what was recorded.
// Fail-first on trunk: no interim row is ever written (and kind 'interim' is refused by the outbox's checks).
import { pgBinDir, startPg } from "../flow/pg.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { careerHandler, SUPABASE_URL, SERVICE_KEY, supabaseParity } from "../flow/handler.ts";
import { fakeBot } from "./scenarios/telegram-bot-api.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const TOKEN = "123456:TEST-interim-token-not-real", SECRET = "TEST_interim_webhook_secret_0123456789abcd";

function fakeTimers() {
  let t = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    pending: () => q.size,
    set: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, e] of q) if (e.at <= end && (best === null || e.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const e = q.get(best)!;
        q.delete(best);
        t = e.at;
        e.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

Deno.test({ name: "R10: a slow turn's interim is recorded in career_outbox (kind interim, key interim:tg:<id>), with the exact text Telegram was sent", ignore: !pgBinDir(), sanitizeOps: false, sanitizeResources: false }, async () => {
  const vars: Record<string, string> = { TRAINEE_SIGNUP: "open", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot" };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  const pg = await startPg();
  const realFetch = globalThis.fetch;
  try {
    await supabaseParity(pg);
    await careerHandler(pg, {});
    const viaDouble = globalThis.fetch;
    const pace = virtualClock();
    const bot = fakeBot({ token: TOKEN, now: pace.clock });
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
      if (u.host === "api.telegram.org") return await bot.fetch(req);
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;
    const { handleTelegram } = await import("../../supabase/functions/trainee-telegram/handler.ts");
    const { supabaseInboundStore } = await import("../../supabase/functions/trainee-inbound/store.ts");
    const { deliverer } = await import("../../supabase/functions/_shared/channel_runtime.ts");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const timers = fakeTimers();
    let turnMs = 0;
    const chat = async (a: { userId: string; message: string }) => {
      await timers.advance(turnMs);
      return { status: 200, reply: `Answer to: ${a.message}`, threadId: null };
    };
    const CHAT = 7_101;
    let upd = 40_000, mid = 500;
    const post = async (text: string, again?: { update_id: number; message: any }) => {
      const body = again ?? { update_id: ++upd, message: { message_id: ++mid, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "TEST" }, date: 1, text } };
      const deliverNow = deliverer(admin, Deno.env, pace);
      const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(body) }),
        { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat, admin, timers: { set: timers.set, clear: timers.clear },
          deliver: (a: any) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) } as any);
      eq(res.status, 200, await res.text());
      return body;
    };
    const rows = async () => JSON.parse((await pg.sql(`select coalesce(json_agg(x order by x.id), '[]') from (select o.id, o.key, o.kind, o.status, o.text, o.delivered_at is not null as delivered
      from public.career_outbox o join public.channel_contacts c on c.user_id = o.user_id where c.contact = 'tg:${CHAT}' and o.kind = 'interim') x`)).trim());
    const sentTo = () => bot.to(CHAT).map((m: any) => m.text as string);

    // A fast turn: no interim sent, none recorded.
    turnMs = 1000;
    await post("hello");
    eq(await rows(), [], "a fast turn records no interim");

    // A slow search: one interim, sent while the turn runs, recorded with the same text.
    turnMs = 9000;
    const ask = "find me data analyst internships in Chicago";
    const before = sentTo().length;
    const slow = await post(ask);
    const out = sentTo().slice(before);
    const interim = ackFor(ask);
    eq(out, [interim, `Answer to: ${ask}`], "one interim, then the answer");
    const got = await rows();
    eq(got.map((r: any) => [r.key, r.kind, r.status, r.delivered, r.text]), [[`interim:tg:${slow.update_id}`, "interim", "delivered", true, out[0]]], "one interim row: delivered, the exact text sent");

    // The same update again (Telegram's retry): nothing sent, nothing recorded.
    const n0 = sentTo().length;
    await post("", slow);
    eq(sentTo().length, n0, "a retried update sends nothing");
    eq((await rows()).length, 1, "a retried update records nothing");

    // A second slow turn: its own row. A delivery run after it never sends an interim again.
    const ask2 = "draft an email to the recruiter at Acme";
    const b2 = sentTo().length;
    const second = await post(ask2);
    const out2 = sentTo().slice(b2);
    eq(out2, [ackFor(ask2), `Answer to: ${ask2}`], "one interim, then the answer");
    eq((await rows()).map((r: any) => [r.key, r.text]), [[`interim:tg:${slow.update_id}`, out[0]], [`interim:tg:${second.update_id}`, out2[0]]], "one interim row per slow turn");
    const n1 = sentTo().length;
    await deliverer(admin, Deno.env, pace)({ userId: (await pg.sql(`select user_id from public.channel_contacts where contact = 'tg:${CHAT}'`)).trim(), key: `interim:tg:${slow.update_id}`, now: Date.now() } as any).catch(() => null);
    eq(sentTo().length, n1, "a recorded interim is never delivered again");
    eq(timers.pending(), 0, "nothing left armed");
  } finally {
    globalThis.fetch = realFetch;
    await pg.stop();
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});
