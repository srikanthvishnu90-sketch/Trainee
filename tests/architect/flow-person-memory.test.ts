// ROOT CAUSE 3 (docs/architect/ROOT-CAUSES-2026-10-31.md): what a person tells Trainee belongs to the PERSON, not to one
// conversation thread. Telegram, WhatsApp and iMessage share one texting thread; the web app opens threads of its own. Until
// this change the confirmed resume and the tracker lived in each thread's state (agent_flow_state) unless the owner set
// CAREER_ACCOUNT_MEMORY=on, so a resume confirmed on Telegram was unknown on the web and an application logged on the web was
// unknown on WhatsApp. Here the environment is the DEFAULT (CAREER_ACCOUNT_MEMORY unset), as a fresh deploy runs.
//
// Everything runs through the real code: the Telegram webhook (handleTelegram), the WhatsApp webhook (handleWhatsApp,
// signed), the LoopMessage webhook (handleInbound), each composed as its index.ts composes it (supabaseInboundStore over
// supabase-js, agent-chat through chatThroughAgent), the real agent-chat career handler (handler-career.ts handleChat) for
// both those turns and the web app's own turns, on Postgres 16 with every migration (tests/flow/pg.ts) behind the PostgREST
// double. No model, no network: providers are fakes at the HTTP boundary and every other host is refused.
//
//   (1) a resume pasted and confirmed on Telegram is known on the web (a new web thread): its confirmed entries, each with
//       the confirmation event made on Telegram, are in the web thread's profile and the web reply names them; one thread
//       holds the profile copy (the last to save), so the server's readers never see a stale second profile;
//   (2) an application logged on the web is known on WhatsApp and on iMessage (the texting thread's tracker), and a fact
//       stated on iMessage is known on the web;
//   (3) another person never sees any of it: their Telegram chat and their web thread know none of the first person's
//       entries, applications, facts or contacts, and their account record holds nothing of them;
//       and the other person's own copy survives the first person's saves;
//   (5) a thread last written before the switch (no account_memory stamp) keeps its copy, and a web-only person stays
//       per-thread while other people have texting contacts linked;
//   (4) nothing was sent to anyone: no outreach, no application, no email (external effects still wait for an approval of
//       the exact payload), and no fact was invented (every confirmed entry on the account has its fact_confirmed event).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-person-memory.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const ME = "7b0f8f8e-6a43-4a49-9d2c-0000000031a1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000031a2";
const THIRD = "7b0f8f8e-6a43-4a49-9d2c-0000000031a3", WEBONLY = "7b0f8f8e-6a43-4a49-9d2c-0000000031a4";
const LEGACY_THREAD = "7b0f8f8e-6a43-4a49-9d2c-0000000031b3";
const TG_ME = 7731001, TG_OTHER = 7731002, TG_THIRD = 7731003, WA_ME = "15550131001", IM_ME = "+15550131002";
const TOKEN = "123456:TEST-person-memory-token-not-real", TG_SECRET = "TEST_person_memory_webhook_secret_0123456789";
const IN_SECRET = "TEST_person_memory_inbound_secret_0123456789", WA_APP = "TEST_person_memory_wa_app_secret_0123456789";
const ENV_OFF = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL",
  "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND",
  "CAREER_MAIL_TRACKING", "CAREER_REPLY_WRITER", "CAREER_TEXTING_NATIVE", "CAREER_SEND_RAIL", "CAREER_OUTREACH_SEND", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET",
  "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL", "LOOPMESSAGE_DAILY_CONTACTS", "TRAINEE_LOGO_URL", "TRAINEE_LOGO_GUESS"];

let pg: Pg | null = null;
let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
let saved: Record<string, string | undefined> = {};
let inner: typeof fetch | null = null;
const replies: { userId: string; body: any }[] = [];
const outbound: string[] = [];

async function world() {
  if (h) return;
  pg = await startPg();
  await supabaseParity(pg);
  saved = Object.fromEntries([...ENV_OFF, "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TRAINEE_SIGNUP", "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_INBOUND_SECRET",
    "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"].map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_OFF) Deno.env.delete(k);
  for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TRAINEE_SIGNUP: "closed", TRAINEE_ALLOWED_CONTACTS: "",
    TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: "loop-test", WHATSAPP_TOKEN: "wa-test", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: WA_APP })) Deno.env.set(k, v);
  for (const id of [ME, OTHER, THIRD, WEBONLY]) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  // Setup: the person's three texting contacts are linked to their account (as the link flows leave them), and the other
  // person's Telegram chat to theirs.
  await pg.sql(`insert into public.channel_contacts (contact, user_id, last_inbound_at, created_at) values
    ('tg:${TG_ME}', '${ME}', now() - interval '1 hour', now() - interval '2 days'),
    ('wa:${WA_ME}', '${ME}', now() - interval '1 hour', now() - interval '2 days'),
    ('${IM_ME}', '${ME}', now() - interval '1 hour', now() - interval '2 days'),
    ('tg:${TG_OTHER}', '${OTHER}', now() - interval '1 hour', now() - interval '2 days'),
    ('tg:${TG_THIRD}', '${THIRD}', now() - interval '1 hour', now() - interval '2 days');`);
  // Setup: the third person has a web thread last written before the switch (no account_memory stamp), holding a tracker row.
  await pg.sql(`insert into public.agent_threads (id, user_id, title) values ('${LEGACY_THREAD}', '${THIRD}', 'TEST pre-switch thread');
    insert into public.agent_flow_state (thread_id, user_id, state, updated_at) values ('${LEGACY_THREAD}', '${THIRD}',
      '{"career":{"v":1,"scope":{"userId":"${THIRD}"},"revision":3,"stores":{"trackStore":{"rows":[{"app_id":"legacy-1","company":"Legacy Co","status":"applied"}]}}}}', now() - interval '20 days');`);
  h = await careerHandler(pg, { "tok-pm-me": ME, "tok-pm-other": OTHER, "tok-pm-webonly": WEBONLY });
  const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
  const viaDouble = globalThis.fetch;
  const bot = fakeBot({ token: TOKEN, now: Date.now });
  inner = viaDouble;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") {
      const body = await req.clone().json().catch(() => ({}));
      const res = await handleChat(req);
      replies.push({ userId: String(body.as_user_id ?? ""), body: await res.clone().json().catch(() => ({})) });
      return res;
    }
    if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
    if (u.host === "api.telegram.org") return await bot.fetch(req);
    // The WhatsApp and LoopMessage send APIs answer as accepted; what they were asked to send is not under test here.
    if (u.host === "graph.facebook.com") return Response.json({ messages: [{ id: `wamid.out${replies.length}` }] });
    if (u.host.endsWith("loopmessage.com")) return Response.json({ success: true, message_id: `lm-out-${replies.length}` });
    outbound.push(`${req.method} ${u.host}`);
    throw new TypeError(`network refused: ${u.host}`);
  }) as typeof fetch;
}

const skip = () => {
  if (pgBinDir()) return Deno.uid?.() === 0 && !CI ? (console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"), true) : false;
  if (CI) throw Error("the person memory flow needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const sql = async (s: string) => (await pg!.sql(s)).trim();
const num = async (s: string) => Number(await sql(s));
const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
const fresh = () => sql("delete from public.agent_rate_limits");
const admin = async () => {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
};
// The reply agent-chat gave the channel's turn (what the channel then delivers).
const lastReply = (userId: string) => {
  const r = [...replies].reverse().find((x) => x.userId === userId);
  return { reply: String(r?.body?.reply ?? ""), intent: r?.body?.meta?.intent ?? null, resultStatus: r?.body?.meta?.result_status ?? null };
};
const noDeliver = async () => ({ delivered: 0 }) as any;

let upd = 9000, mid = 500;
async function telegram(chat: number, text: string, userId: string) {
  await fresh();
  const n = replies.length;
  const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
    body: JSON.stringify({ update_id: ++upd, message: { message_id: ++mid, chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1, text } }) }),
    { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(adminClient!), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin: adminClient!, deliver: noDeliver } as any);
  eq(res.status, 200, `telegram webhook: ${await res.text()}`);
  assert(replies.length > n, `telegram "${text.slice(0, 40)}" ran a turn`);
  return lastReply(userId);
}
async function whatsapp(text: string) {
  await fresh();
  const n = replies.length;
  const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" },
    contacts: [{ wa_id: WA_ME }], messages: [{ from: WA_ME, id: `wamid.in${++mid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] }));
  const res = await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), {
    env: Deno.env, now: Date.now, store: () => supabaseInboundStore(adminClient!), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "whatsapp" }), deliver: noDeliver,
    adapter: (e: any) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: "1", appSecret: WA_APP, fetch: globalThis.fetch, clock: Date.now, sleep: async () => {} }),
  } as any);
  eq(res.status, 200, `whatsapp webhook: ${await res.text()}`);
  assert(replies.length > n, `whatsapp "${text.slice(0, 40)}" ran a turn`);
  return lastReply(ME);
}
async function imessage(text: string) {
  await fresh();
  const n = replies.length;
  const res = await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST",
    body: JSON.stringify({ alert_type: "message_inbound", message_id: `lm-in-pm-${++mid}`, recipient: IM_ME, text }) }), {
    env: Deno.env, now: Date.now, store: () => supabaseInboundStore(adminClient!), send: (k: string) => loopSend({ apiKey: k, fetch: globalThis.fetch, sleep: async () => {} }),
    chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "imessage" }), deliverReply: noDeliver,
  } as any);
  eq(res.status, 200, `loopmessage webhook: ${await res.text()}`);
  assert(replies.length > n, `imessage "${text.slice(0, 40)}" ran a turn`);
  return lastReply(ME);
}
// deno-lint-ignore no-explicit-any
let adminClient: any = null;
const webSay = async (c: ReturnType<NonNullable<typeof h>["chat"]>, m: string) => { await fresh(); const r = await c.say(m); eq(r.status, 200, `${m}: ${r.status} ${r.reply}`); return r; };
const textingThread = async (userId: string) => await sql(`select coalesce((select thread_id::text from public.channel_contacts where user_id = '${userId}' and thread_id is not null limit 1), '')`);
const profileFacts = async (thread: string) => await json(`select f->>'text' as text, f->>'status' as status, f->>'confirmation_event_id' as ev from public.agent_flow_state s,
  jsonb_array_elements(coalesce(s.state#>'{career,stores,profile,facts}', '[]')) f where s.thread_id = '${thread}'`);
const trackerOf = async (thread: string) => await json(`select r->>'company' as company from public.agent_flow_state s,
  jsonb_array_elements(coalesce(s.state#>'{career,stores,trackStore,rows}', '[]')) r where s.thread_id = '${thread}'`);
const confirmedOnTelegram: { text: string; ev: string }[] = [];

Deno.test({ name: "person memory (1): a resume confirmed on Telegram is known in a new web thread", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  adminClient = await admin();
  await telegram(TG_ME, `here is my resume:\n${RESUME}`, ME);
  await telegram(TG_ME, "yes, that's my resume", ME);
  const tg = await textingThread(ME);
  assert(tg, "the Telegram turn has the person's texting thread");
  const facts = (await profileFacts(tg)).filter((f: any) => f.status === "confirmed" && f.ev);
  assert(facts.length > 0, `precondition: the resume is confirmed on Telegram: ${JSON.stringify(await profileFacts(tg))}`);
  confirmedOnTelegram.push(...facts.map((f: any) => ({ text: f.text, ev: f.ev })));
  const events = new Set((await json(`select detail->>'confirmation_event_id' as ev from public.career_events where user_id = '${ME}' and kind = 'fact_confirmed'`)).map((r: any) => r.ev));
  assert(confirmedOnTelegram.every((f) => events.has(f.ev)), "each confirmed entry has its fact_confirmed event");

  // The web app, a thread of its own.
  const web = h!.chat("tok-pm-me");
  const known = await webSay(web, "what do you know about me");
  assert(web.thread() && web.thread() !== tg, "a web thread, not the texting thread");
  const webFacts = (await profileFacts(web.thread()!)).filter((f: any) => f.status === "confirmed");
  eq(webFacts.map((f: any) => f.ev).sort(), confirmedOnTelegram.map((f) => f.ev).sort(), "the web thread holds the entries confirmed on Telegram, with the same events");
  assert(/TEST Systems Inc|TEST University|DeployBoard/.test(known.reply) || new RegExp(`\\b${confirmedOnTelegram.length}\\b`).test(known.reply),
    `the web reply knows the resume confirmed on Telegram: ${known.reply}`);
  assert(!/no resume|haven't (sent|given) me (a|your) resume|paste or attach your resume/i.test(known.reply), `the web reply does not ask for the resume again: ${known.reply}`);
  // One copy: the server's readers (career_apply_profile_for, career_resume_on_file) take the newest thread holding a
  // profile; the texting thread's older copy is cleared (20261031050000), so no stale second profile is left beside it.
  eq(await json(`select thread_id::text as t from public.agent_flow_state where user_id = '${ME}' and jsonb_typeof(state#>'{career,stores,profile,facts}') = 'array'`),
    [{ t: web.thread() }], "exactly one thread holds the person's profile copy: the one that saved last");
} });

Deno.test({ name: "person memory (2): an application logged on the web is known on WhatsApp and iMessage; a fact stated on iMessage is known on the web", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  const web = h!.chat("tok-pm-me");
  const logged = await webSay(web, "I applied to Stripe for the software engineering intern role");
  assert(/Stripe/.test(logged.reply), logged.reply);
  eq((await trackerOf(web.thread()!)).map((r: any) => r.company), ["Stripe"], "precondition: the web thread's tracker holds Stripe");

  const wa = await whatsapp("what does my tracker look like");
  const tg = await textingThread(ME);
  assert((await trackerOf(tg)).some((r: any) => r.company === "Stripe"), `the texting thread's tracker holds the application logged on the web: ${JSON.stringify(await trackerOf(tg))}`);
  assert(/Stripe/.test(wa.reply), `WhatsApp knows the application logged on the web: ${wa.reply}`);
  const im = await imessage("what does my tracker look like");
  assert(/Stripe/.test(im.reply), `iMessage knows the application logged on the web: ${im.reply}`);

  await imessage("I am a junior majoring in computer science");
  const web2 = h!.chat("tok-pm-me");
  const known = await webSay(web2, "what do you know about me");
  assert(/junior/i.test(known.reply) && /computer science/i.test(known.reply), `the web knows the fact stated on iMessage: ${known.reply}`);
  assert(/Stripe/.test(known.reply), `and the application: ${known.reply}`);
} });

Deno.test({ name: "person memory (3): another person never sees any of it, on Telegram or on the web", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  // The first person types a contact on Telegram (kept on their account), so there is something of theirs to leak.
  // The other person's own record, saved first: the first person's later saves must leave it whole.
  await telegram(TG_OTHER, "I applied to Figma for the product design intern role", OTHER);
  const otherThread = await textingThread(OTHER);
  assert((await trackerOf(otherThread)).some((r: any) => r.company === "Figma"), `precondition: the other person's texting thread holds Figma: ${JSON.stringify(await trackerOf(otherThread))}`);
  await telegram(TG_ME, "email Maya Chen at Stripe about a coffee chat, her email is maya.chen@stripe.example", ME);
  assert((await trackerOf(otherThread)).some((r: any) => r.company === "Figma"), `the first person's save leaves the other person's copy whole: ${JSON.stringify(await trackerOf(otherThread))}`);
  const leak = /Stripe|junior|computer science|TEST Systems|TEST University|DeployBoard|Maya|Alex Testcase/i;
  const tg = await telegram(TG_OTHER, "what do you know about me", OTHER);
  assert(!leak.test(tg.reply), `the other person's Telegram knows nothing of the first: ${tg.reply}`);
  const tgTrack = await telegram(TG_OTHER, "what does my tracker look like", OTHER);
  assert(!/Stripe/.test(tgTrack.reply), `nor their tracker: ${tgTrack.reply}`);
  const web = h!.chat("tok-pm-other");
  const known = await webSay(web, "what do you know about me");
  assert(!leak.test(known.reply), `the other person's web knows nothing of the first: ${known.reply}`);
  const who = await webSay(web, "who do I know at Stripe?");
  assert(!/Maya/.test(who.reply), `nor their contacts: ${who.reply}`);
  const acct = JSON.parse(await sql(`select coalesce((select value::text from public.career_watch_kv where user_id = '${OTHER}' and key = 'career:account'), 'null')`));
  assert(!leak.test(JSON.stringify(acct)), `the other person's account record holds nothing of the first: ${JSON.stringify(acct)}`);
  eq(await num(`select count(*) from public.agent_flow_state where user_id = '${OTHER}' and state::text ~ '(Stripe|TEST Systems|DeployBoard|Maya)'`), 0, "no thread of theirs holds any of it");
  eq(await num(`select count(*) from public.career_account_contacts where user_id = '${OTHER}'`), 0, "no contact of the first person is theirs");
  // The first person still knows their own contact on the web (contacts are the account's).
  const mine = await webSay(h!.chat("tok-pm-me"), "who do I know at Stripe?");
  assert(/Maya Chen/.test(mine.reply), `the first person's web knows the contact typed on Telegram: ${mine.reply}`);
} });

Deno.test({ name: "person memory (5): a thread from before the switch keeps its copy; a web-only person stays per-thread", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  const before = await sql(`select state::text from public.agent_flow_state where thread_id = '${LEGACY_THREAD}'`);
  await telegram(TG_THIRD, "I applied to Notion for the data analyst intern role", THIRD);
  assert((await trackerOf(await textingThread(THIRD))).some((r: any) => r.company === "Notion"), "precondition: the third person's texting thread saved their tracker");
  eq(await sql(`select state::text from public.agent_flow_state where thread_id = '${LEGACY_THREAD}'`), before, "the unstamped thread keeps its own copy until its next turn folds it in");
  // A person with no texting contact, while other people have theirs linked: their record stays with the thread.
  const web = h!.chat("tok-pm-webonly");
  const logged = await webSay(web, "I applied to Ramp for the finance intern role");
  assert(/Ramp/.test(logged.reply), logged.reply);
  eq((await trackerOf(web.thread()!)).map((r: any) => r.company), ["Ramp"], "the web thread holds the application");
  const acct = JSON.parse(await sql(`select coalesce((select value::text from public.career_watch_kv where user_id = '${WEBONLY}' and key = 'career:account'), 'null')`));
  assert(!acct || !("memory" in acct), `a web-only person's record is not moved to the account: ${JSON.stringify(acct)}`);
  eq(await sql(`select coalesce(state#>>'{career,account_memory}', 'none') from public.agent_flow_state where thread_id = '${web.thread()}'`), "none", "nor is their thread stamped as account-backed");
} });

Deno.test({ name: "person memory (4): nothing was sent and nothing invented", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  try {
    eq(outbound, [], "no request left for any other host");
    eq(await num(`select count(*) from public.career_apply_jobs`), 0, "no application was queued");
    eq(await num(`select count(*) from public.career_outreach_drafts where status in ('approved', 'sending', 'sent')`), 0, "no outreach was approved or sent");
    // Every confirmed entry on the account's memory has its fact_confirmed event: nothing confirmed that the person did not confirm.
    const acct = JSON.parse(await sql(`select coalesce((select value::text from public.career_watch_kv where user_id = '${ME}' and key = 'career:account'), 'null')`));
    const confirmed = (acct?.memory?.profile?.facts ?? []).filter((f: any) => f.status === "confirmed");
    const events = new Set((await json(`select detail->>'confirmation_event_id' as ev from public.career_events where user_id = '${ME}' and kind = 'fact_confirmed'`)).map((r: any) => r.ev));
    assert(confirmed.length > 0 && confirmed.every((f: any) => events.has(f.confirmation_event_id)), `every confirmed entry on the account has its event: ${confirmed.length}`);
  } finally {
    if (inner) globalThis.fetch = inner;
    await h?.restore();
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await pg?.stop();
  }
} });
