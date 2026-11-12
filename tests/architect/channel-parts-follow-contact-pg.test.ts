// Parts follow the contact (s-release, 2026-11-10): the CI flake of flow-scenarios-channel-r4 on 3645456a ("digest:r4c20-103
// delivered whole"), reproduced locally once in about 100 runs and fixed by 20261110190000_career_outbox_parts_follow_contact.sql.
// Here with nothing left to chance, through the real delivery handler (trainee-deliver's handleDeliver over supabaseChannelStore
// with the two-lane claim) on Postgres 16 with every migration and the PostgREST double, fake providers at the HTTP boundary:
//   a digest that Telegram renders as two messages sends the first, the second gets a 502; the person unlinks Telegram; the row
//   follows them to iMessage, which renders the same text as a different number of bubbles.
// Before: the row resumed on iMessage by skipping as many iMessage bubbles as Telegram messages had gone, and was marked
// delivered. The person had the start on Telegram and an overlapping tail on iMessage, and nothing whole on either.
// Now: on iMessage it goes whole, each word once, in order, and the row is delivered. A row resumed on the SAME chat still
// sends only the rest (the second case). Nothing leaves the machine; no model runs.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/channel-parts-follow-contact-pg.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { telegramPacerFromEnv } from "../../supabase/functions/_shared/channel_pacer.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const WORD = /pf(\d+)w(\d+)/g;
// 119 words in three paragraphs, about 1,560 characters (the flake's row was 1,718): two Telegram messages, three iMessage
// bubbles (checked below, so the case stays the one seen)
const digest = (tag: number) => Array.from({ length: 119 }, (_, k) => `pf${tag}w${k}xxxxxx${k % 40 === 39 ? "\n\n" : ""}`).join(" ");

async function run(sameChat: boolean) {
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const vc = virtualClock();
    const user = sameChat ? "00000000-0000-4000-8000-00000000f602" : "00000000-0000-4000-8000-00000000f601";
    const tg = sameChat ? "tg:9602" : "tg:9601", im = sameChat ? "+15550009602" : "+15550009601", tag = sameChat ? 2 : 1;
    await db.sql.query(`insert into auth.users(id, email) values (${q(user)}, ${q(`pf${tag}@example.test`)});
      insert into public.profiles(id) values (${q(user)});
      insert into public.career_watch_kv(user_id, key, value) values (${q(user)}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, home) values
        (${q(tg)}, ${q(user)}, ${q(iso(vc.clock() - 3600000))}, ${q(iso(vc.clock() - 172800000))}, true),
        (${q(im)}, ${q(user)}, ${q(iso(vc.clock() - 3600000))}, ${q(iso(vc.clock() - 172800000))}, false);
      insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(user)}, ${q(`digest:pf${tag}`)}, 'digest', ${q(digest(tag))}, ${q(iso(vc.clock() - 60000))});`);
    const calls: { to: string; words: number[]; accepted: boolean }[] = [];
    let telegramSends = 0, seq = 0;
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const providers = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (u.host === "api.telegram.org") {
        if (!u.pathname.endsWith("/sendMessage")) return j({ ok: true, result: true });
        const words = [...plain(String(b.text)).matchAll(WORD)].map((m) => Number(m[2]));
        const refuse = ++telegramSends === 2; // the second Telegram message of the first run: a 502
        calls.push({ to: `tg:${b.chat_id}`, words, accepted: !refuse });
        return refuse ? j("Bad Gateway", 502) : j({ ok: true, result: { message_id: ++seq } });
      }
      if (u.host === "a.loopmessage.com") {
        calls.push({ to: String(b.contact), words: [...plain(String(b.text)).matchAll(WORD)].map((m) => Number(m[2])), accepted: true });
        return j({ message_id: `lm-${++seq}`, success: true });
      }
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;
    const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: "d".repeat(40), LOOPMESSAGE_API_KEY: `lm_${"k".repeat(36)}`, TELEGRAM_BOT_TOKEN: `7401:${"T".repeat(34)}`, CAREER_TEXTING_NATIVE: "on" };
    const E = { get: (k: string) => env[k] || undefined };
    const adapters = (e: typeof E) => adaptersFromEnv(e, { fetch: providers, clock: vc.clock, sleep: vc.sleep, sharedPace: telegramPacerFromEnv(e, admin, { sleep: vc.sleep, now: vc.clock }) });
    const ad = adapters(E) as any;
    const tgAd = ad instanceof Map ? ad.get("telegram") : ad.telegram, imAd = ad instanceof Map ? ad.get("imessage") : ad.imessage;
    eq(tgAd.render(digest(tag)).length, 2, "precondition: Telegram renders the digest as two messages");
    ok(imAd.render(digest(tag)).length > 2, "precondition: iMessage renders it as more bubbles than Telegram");
    const deliver = async () => (await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": env.TRAINEE_DELIVER_SECRET } }), {
      env: E, now: vc.clock, store: (so) => supabaseChannelStore(admin, { lanes: true, shard: so?.shard }),
      send: (apiKey) => loopSend({ apiKey, fetch: providers, sleep: vc.sleep }), adapters, recordRun: async () => {},
    })).json();

    await deliver();
    const after1 = (await db.sql.query(`select status, sent_parts from public.career_outbox where key = ${q(`digest:pf${tag}`)}`))[0];
    eq([after1[0], Number(after1[1])], ["failed", 1], "the first run sent one Telegram message of two, then the 502: one part recorded");
    if (!sameChat) eq(Number((await db.sql.query(`select public.channel_telegram_unlink_as(${q(user)}, ${q(iso(vc.clock()))})`))[0][0]), 1, "Telegram unlinked");
    for (let i = 0; i < 6; i++) {
      await vc.sleep(10 * 60000);
      await deliver();
      const s = (await db.sql.query(`select status from public.career_outbox where key = ${q(`digest:pf${tag}`)}`))[0][0];
      if (s === "delivered") break;
    }
    const row = (await db.sql.query(`select status, contact from public.career_outbox where key = ${q(`digest:pf${tag}`)}`))[0];
    eq(row[0], "delivered", "the row is delivered");
    const all = Array.from({ length: 119 }, (_, k) => k);
    const on = (to: string) => calls.filter((c) => c.accepted && c.to === to).flatMap((c) => c.words);
    if (sameChat) {
      eq(on(tg), all, "on the same Telegram chat: the rest after the part that went, each word once, in order");
      eq(on(im), [], "nothing on iMessage");
    } else {
      eq(row[1], im, "delivered on iMessage");
      eq(on(im), all, "on iMessage the digest went whole, each word once, in order (before: the first bubble was skipped)");
    }
  } finally {
    await db.stop();
  }
}

Deno.test({ name: "parts follow the contact: a digest part sent on Telegram, then Telegram unlinked, goes whole on iMessage", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  await run(false);
} });

Deno.test({ name: "parts follow the contact: the same chat still resumes after the part that went", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  await run(true);
} });
