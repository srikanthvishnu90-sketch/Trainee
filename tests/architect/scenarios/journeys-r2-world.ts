// WHOLE JOURNEYS, ROUND 2 (architect, 2026-11-02; round 1: flow-chat-journey.test.ts, #256): the world a seeded journey runs
// in. One real Postgres 16 with every migration (tests/flow/pg.ts) behind the PostgREST double (tests/flow/postgrest.ts), and
// the REAL handlers composed as their index.ts files compose them:
//   web        agent-chat's handleChat (handler-career.ts), as the person's app calls it with their bearer token;
//   Telegram   trainee-telegram's handleTelegram (the inbound core, job cards, Apply and Confirm taps, STOP/START), whose
//              turns go to the same agent-chat through chatThroughAgent, and the head-start delivery over the channel store;
//   workers    trainee-deliver's every-minute run (handleDeliver) and the send rail's worker (runSendWorker, career-send);
//   deletion   delete-account's own steps (account_delete.ts restDeps) over the double, GoTrue's admin API and Storage.
// The brain is scripted: the router answers every turn (CAREER_BRAIN unset); the one model call the product makes here (the
// outreach drafter) is a scripted writer at the OpenAI URL; on Telegram a search's postings ride the reply as the agent's
// find_jobs tool would put them (the cards). Telegram, Gmail, Stripe and Google's revoke are fakes at the HTTP boundary;
// every other host is refused and recorded. The person's computer (the extension) is the harness: it prepares an
// application with career_apply_prepare_own as that person, as mass-submit-handler-pg.test.ts does.
// What the person SAW and SAID is recorded here (the card's items, the drafts shown, the payload page's Confirm), so the
// checks (journeys-r2-check.ts) can tell an approval of an exact payload from anything else.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { AsyncLocalStorage } from "node:async_hooks";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { psqlSession } from "../../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity, type Turn } from "../../flow/handler.ts";
import { PgConn, serviceRpc } from "../../flow/pgwire.ts";
import { FakeGmail } from "../../flow/send-rail-fixture.ts";
import { fakeBot, plainOf } from "./telegram-bot-api.ts";
import { FakeStripe, STRIPE_KEY } from "./billing-generator.ts";
import { PDF, pdfBytes } from "./onboarding-r2-generator.ts";
import { handleTelegram } from "../../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseInboundStore } from "../../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../../supabase/functions/_shared/telegram.ts";
import { chatThroughAgent } from "../../../supabase/functions/_shared/channel_runtime.ts";
import { runSendWorker } from "../../../supabase/functions/_shared/career_send_rail.ts";
import { deleteAccount, deletionWords, restDeps } from "../../../supabase/functions/_shared/account_delete.ts";
import { handleFile } from "../../../supabase/functions/trainee-file/handler.ts";
import { buildFileDeps } from "../../../supabase/functions/trainee-file/deps.ts";
import { pageTokenOf, sha256, startSession } from "../../../supabase/functions/_shared/file_session.ts";
import { supabaseSessionStore } from "../../../supabase/functions/trainee-file/store.ts";
import { fakePhone } from "../file-session-fakes.ts";

export const CI = Deno.env.get("CI") === "true";
export const ROOT = new URL("../../..", import.meta.url).pathname;
// Built at run time: no key-shaped string sits in the repository (tests/no-secrets.test.cjs).
export const TG_TOKEN = ["771122", "TEST-journeys-r2-bot-not-real"].join(":");
export const TG_SECRET = ["TEST", "jr2", "webhook", "secret", "0123456789abcdef"].join("_");
const DELIVER_SECRET = ["TEST", "jr2", "deliver", "secret", "0123456789abcdef"].join("-");
const MODEL_KEY = ["TEST", "jr2", "model", "placeholder"].join("-");
const FILE_SECRET = ["file-link", "secret", "0123456789", "jr2"].join("-");
export const FILE_BASE = "https://trainee.example/file";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const SEND_SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
export const lit = q;

// ------------------------------------------------------------------------------------------------ the people
const FIRSTS = ["Ines", "Tomas", "Wren", "Arjun", "Mei", "Kwame", "Lucia", "Oskar", "Hana", "Dev", "Rosa", "Felix"];
const LASTS = ["Quellmar", "Brindlow", "Ostrava", "Pemberly", "Vantorre", "Halvick", "Dunmore", "Ashgrove", "Kellerby", "Morrowind", "Tolliver", "Wexham"];
const SCHOOLS = ["Marlow", "Eastgate", "Pinecrest", "Harbor", "Wexford", "Cobalt", "Larkspur", "Ironwood", "Bellmont", "Sorrel", "Juniper", "Halden"];
export const GPAS = ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.8", "3.9"];
export interface PersonSpec { i: number; first: string; last: string; school: string; gpa: string; grad: number }
export function personSpec(i: number, slot: number): PersonSpec {
  // Distinct name, school and GPA within a database (slot < 12), so a reply naming another person's is caught.
  return { i, first: FIRSTS[slot % 12], last: LASTS[(slot * 5) % 12], school: SCHOOLS[(slot * 7) % 12], gpa: GPAS[slot % GPAS.length], grad: 2026 + (slot % 3) };
}
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
export function resumeOf(s: PersonSpec): string {
  return RESUME.replaceAll("Alex Testcase", `${s.first} ${s.last}`).replaceAll("alex.testcase@example.test", emailOf(s))
    .replaceAll("TEST University", `${s.school} University`).replace("GPA 3.7", `GPA ${s.gpa}`).replace("graduating May 2028", `graduating May ${s.grad}`);
}
export const emailOf = (s: PersonSpec) => `${s.first.toLowerCase()}.${s.last.toLowerCase()}@example.test`;
// Their LinkedIn export: three people at Stripe (two with an address), one at Ramp; the addresses are theirs alone.
export function connectionsCsv(s: PersonSpec): string {
  const tag = `${s.last.toLowerCase()}${s.i}`; // their contacts are theirs alone, in every group
  return `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Maya,Chen,https://www.linkedin.com/in/maya-chen-${tag},maya.chen.${tag}@stripe.example,"Stripe, Inc.",Data Analyst,02 Feb 2025
Sam,Rivera,https://www.linkedin.com/in/sam-rivera-${tag},sam.rivera.${tag}@stripe.example,Stripe,Analytics Manager,11 Mar 2025
Lee,Park,https://www.linkedin.com/in/lee-park-${tag},,Stripe,Recruiter,20 Apr 2025
Priya,Shah,https://www.linkedin.com/in/priya-shah-${tag},priya.shah.${tag}@ramp.example,Ramp,Product Manager,05 May 2025
`;
}

// ------------------------------------------------------------------------------------------------ postings
export const POSTINGS = [["alpha", "Alpha Works"], ["bravo", "Bravo Labs"], ["charlie", "Charlie Freight"], ["delta", "Delta Metrics"], ["echo", "Echo Systems"], ["foxtrot", "Foxtrot Data"], ["golf", "Golf Analytics"]]
  .map(([board, company], i) => ({ key: `greenhouse:${board}:${i + 1}`, board, company, url: `https://boards.greenhouse.io/${board}/jobs/${i + 1}`, title: "Data Analyst", location: "Chicago, IL" }));
export type Posting = typeof POSTINGS[number];
const DESC = "TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.";

// ------------------------------------------------------------------------------------------------ what a person saw and said
export interface Seen {
  // The card on screen (its id and items, read from the database when the reply showed it), and the drafts on screen.
  card: { id: string; items: { job_id: string; payload_hash: string; company: string }[] } | null;
  drafts: { id: string; n: number; hash: string; to: string }[] | null;
  // The Telegram payload page on screen: the Confirm's data and the hash it stands for.
  page: { jobId: string; hash: string; data: string } | null;
}
export interface Person {
  spec: PersonSpec; uid: string; token: string; tg: number; web: { thread: string | null };
  seen: Seen; seenTg: Seen; // what is on screen in the web thread and in the Telegram chat (each thread its own last word)
  // Exact payloads the person approved: application (job_id|hash) and draft (id|hash).
  approvedApps: Set<string>; approvedDrafts: Set<string>;
  // Corrections: values that must never be used again once corrected.
  retiredGpa: string[]; gpa: string; retiredGrad: number[]; grad: number;
  confirmed: boolean; deleted: boolean; tgStopped: boolean; paused: boolean; gmail: boolean; erased: boolean;
  log: string[];
}

// ------------------------------------------------------------------------------------------------ the world
export interface World {
  pg: Pg; sql: (s: string) => Promise<string>; json: <T = any>(s: string) => Promise<T>; admin: any; conn: PgConn;
  bot: ReturnType<typeof fakeBot>; gmail: FakeGmail; stripe: FakeStripe;
  revokes: string[]; outbound: string[]; modelCalls: { at: number; user: string; brain: boolean }[]; logged: string[];
  clock: { skew: number }; now: () => number;
  people: Person[];
  addPerson(i: number, slot: number): Promise<Person>;
  as<T>(p: Person, f: () => Promise<T>): Promise<T>;
  web(p: Person, message: string, extra?: Record<string, unknown>): Promise<Turn>;
  tg(p: Person, text: string): Promise<{ status: number; said: string[] }>;
  tgResumeFile(p: Person, text: string): Promise<{ status: number; said: string[] }>;
  tap(p: Person, data: string): Promise<{ status: number; said: string[]; answer: string }>;
  // The jobs page (trainee-file), signed in on their phone: the latest list Telegram showed them, and its forms.
  filePage(p: Person): Promise<{ status: number; html: string; rows: { ref: string; tag: string; jobId: string | null }[]; sid: string } | null>;
  filePost(p: Person, sid: string, form: Record<string, string>): Promise<{ status: number; html: string }>;
  prepare(p: Person, keys: string[]): Promise<number>;
  connectGmail(p: Person): Promise<void>;
  sendWorker(): Promise<void>;
  deliverCron(minutes?: number): Promise<{ sentTo: Map<string, number> }>;
  deleteAccount(p: Person): Promise<{ deleted: boolean; words: string }>;
  stop(): Promise<void>;
}

export async function startWorld(o: { tokens: Record<string, string> }): Promise<World> {
  const pg = await startPg();
  await supabaseParity(pg);
  const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
  const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
  const sql = async (s: string) => (await fast.sql(s)).trim();
  const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
  const conn = await PgConn.connect({ host: pg.host, port: pg.port });
  const h = await careerHandler(fast, o.tokens);
  const { handleChat } = await import("../../../supabase/functions/agent-chat/handler-career.ts");
  const clock = { skew: 0 };
  const now = () => Date.now() + clock.skew;
  const bot = fakeBot({ token: TG_TOKEN, now });
  const gmail = new FakeGmail();
  const stripe = new FakeStripe();
  const revokes: string[] = [], outbound: string[] = [], modelCalls: { at: number; user: string; brain: boolean }[] = [];
  // Whose step a model call belongs to: people's steps run concurrently, so each step runs inside its own context.
  const whose = new AsyncLocalStorage<string>();
  let modelTurn = 0;
  // The scripted writer at the OpenAI URL (flow-chat-journey's): one short email from the recipient row.
  const fakeOpenAI = (body: any) => {
    const brain = Array.isArray(body.tools) && body.tools.length > 0;
    modelCalls.push({ at: modelTurn, user: whose.getStore() ?? "", brain });
    // The staged brain (a conversation turn the router hands over): one plain answer, no tool, no fact about anyone.
    if (brain) return new Response(JSON.stringify({ id: "chatcmpl-jr2b", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "TEST brain: happy to help with your search. Tell me the role and city, or ask what is ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
    const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
    const first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
    const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to hear how you got started. Would you be open to a short call?`;
    return new Response(JSON.stringify({ id: "chatcmpl-jr2", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const viaDouble = globalThis.fetch;
  const files = new Map<string, Uint8Array>();
  let fid = 0;
  const rows = async (s: string) => await json(s);
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.origin === new URL(SUPABASE_URL).origin) {
      if (u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
      const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
      if (m && req.method === "DELETE") {
        const gone = await sql(`with d as (delete from auth.users where id = ${q(m[1])} returning id) select count(*) from d`);
        return gone === "1" ? new Response("{}", { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
      }
      if (m && req.method === "GET") {
        const has = await sql(`select exists (select 1 from auth.users where id = ${q(m[1])})`);
        return has === "t" ? new Response(JSON.stringify({ id: m[1] }), { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
      }
      if (u.pathname === "/storage/v1/object/list/career-resumes") {
        const b = await req.json();
        if (!/^[0-9a-f-]{36}\/$/.test(String(b.prefix))) return new Response("{}", { status: 400 });
        return new Response(JSON.stringify(await rows(`select substr(name, ${String(b.prefix).length + 1}) as name from storage.objects where bucket_id = 'career-resumes' and name like ${q(`${b.prefix}%`)} order by name limit 1000`)), { status: 200 });
      }
      if (u.pathname === "/storage/v1/object/career-resumes" && req.method === "DELETE") {
        const b = await req.json();
        for (const name of b.prefixes ?? []) await sql(`delete from storage.objects where bucket_id = 'career-resumes' and name = ${q(name)}`);
        return new Response("[]", { status: 200 });
      }
      return await viaDouble(req);
    }
    if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
    // Telegram's file download (the resume a person sends as a PDF), then the Bot API.
    if (u.host === "api.telegram.org" && u.pathname === `/bot${TG_TOKEN}/getFile`) {
      const id = String((await req.json()).file_id), f = files.get(id);
      if (!f) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
      return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u${id}`, file_size: f.length, file_path: `documents/${id}.bin` } });
    }
    if (u.host === "api.telegram.org" && u.pathname.startsWith(`/file/bot${TG_TOKEN}/documents/`)) {
      const f = files.get(decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.bin$/, "")));
      return f ? new Response(f as BodyInit) : new Response("not found", { status: 404 });
    }
    if (u.host === "api.telegram.org") return await bot.fetch(req);
    if (u.host === "api.stripe.com") return await stripe.fetch(req);
    if (req.url === GOOGLE_REVOKE) { revokes.push(new URLSearchParams(await req.text()).get("token") ?? ""); return new Response("", { status: 200 }); }
    if (u.host === "gmail.googleapis.com") return await gmail.fetch(req);
    outbound.push(`${req.method} ${u.host}${u.pathname}`);
    throw new TypeError(`network refused in the journeys: ${u.host}`);
  }) as typeof fetch;
  const logged: string[] = [];
  const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of ["info", "warn", "error", "debug"] as const) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); if (logged.length > 4000) logged.splice(0, 2000); };
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // The deployment's settings (restored by stop()).
  const vars: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_BOT_USERNAME: "TraineeJourneysBot", TRAINEE_SIGNUP: "closed",
    TRAINEE_DELIVER_SECRET: DELIVER_SECRET, CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: MODEL_KEY, CAREER_MODEL: "gpt-5-mini", CAREER_SEND_RAIL: "on",
    CAREER_MAIL_TRACKING: "off", STRIPE_SECRET_KEY: STRIPE_KEY, TRAINEE_FILE_BASE_URL: FILE_BASE, TRAINEE_FILE_LINK_SECRET: FILE_SECRET, TRAINEE_BOT_URL: "https://t.me/TraineeJourneysBot",
  };
  const unset = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_ACCOUNT_MEMORY", "CAREER_TEXTING_NATIVE", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_ALLOWED_CONTACTS", "CAREER_REPLY_WRITER"];
  const saved = Object.fromEntries([...Object.keys(vars), ...unset].map((k) => [k, Deno.env.get(k)]));
  for (const k of unset) Deno.env.delete(k);
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  const env = { get: (k: string) => Deno.env.get(k) || undefined };
  const sleep = (ms: number) => { clock.skew += ms; return Promise.resolve(); };
  const adapters = () => adaptersFromEnv(env, { fetch: globalThis.fetch, clock: now, sleep });
  const adapterOf = (e: typeof env) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: globalThis.fetch, clock: now, sleep });

  // Postings: on file and in the knowledge base the search reads (as flow-chat-journey.test.ts).
  await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${POSTINGS.map((p) => `(${q(p.key)}, 'greenhouse', ${q(p.board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, ${q(DESC)}, now(), now())`).join(",")};
    insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ${POSTINGS.map((p, i) => `(${q(p.key)}, 'greenhouse', ${q(p.board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, now() - interval '${i} hours', ${q(DESC)}, 'jr2-${i}')`).join(",")};`);

  // Telegram: the webhook as trainee-telegram/index.ts composes it, into the real agent-chat. The scripted brain: on a search,
  // the postings the search shows ride the reply (what the agent's find_jobs tool puts there), so Telegram shows them as cards.
  const realChat = chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" });
  const chat = async (a: any) => {
    const r: any = await realChat(a);
    if (/\b(find|search|look for)\b/i.test(a.message) && r.status === 200 && /data analyst/i.test(a.message) && !/paused|unsubscribed/i.test(r.reply)) {
      // "find me ..." shows them all (more than three: one link to the jobs page); any other search its first three (one card each).
      const all = POSTINGS.map((p) => ({ job_id: p.key, company: p.company, title: p.title, location: p.location, url: p.url, fit: { reasons: [], gaps: [] } }));
      r.postings = /\bfind me\b/i.test(a.message) ? all : all.slice(0, 3);
    }
    return r;
  };
  const deliver = async (a: { userId: string; key: string; now: number }) => {
    const store = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } });
    const r = await deliverDue({ store, adapters: adapters(), now: a.now, limit: 1 });
    await store.release();
    return r;
  };
  let upd = 300000, mid = 100, cb = 0;
  const post = async (body: Record<string, unknown>) => {
    const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify({ update_id: ++upd, ...body }) }),
      { env, now, store: () => supabaseInboundStore(admin), chat, admin, deliver, adapter: adapterOf });
    await res.text();
    return res.status;
  };
  const from = (c: number) => ({ chat: { id: c, type: "private" }, from: { id: c, is_bot: false, first_name: "TEST" }, date: 1 });
  const people: Person[] = [];
  const chats = new Map<string, ReturnType<typeof h.chat>>();
  // The jobs page as trainee-file/index.ts serves it (buildFileDeps), the phone's texted code faked (no SMS).
  const phones: Record<string, string | null> = {};
  const phone = fakePhone(phones);
  const fileDeps = () => ({ ...buildFileDeps(admin, env, now), phone: phone.auth, pace: undefined, background: undefined });
  const sids = new Map<string, string>();
  const fileReq = async (sid: string, init?: { form: Record<string, string> }) => {
    const headers: Record<string, string> = { cookie: `tf_s=${sid}`, origin: "https://trainee.example", "sec-fetch-site": "same-origin" };
    const req = init ? new Request(FILE_BASE, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: (await pageTokenOf(await sha256(sid), FILE_SECRET))!, ...init.form }).toString() })
      : new Request(FILE_BASE, { headers });
    const res = await handleFile(req, fileDeps() as any);
    return { status: res.status, html: await res.text() };
  };

  const w: World = {
    pg, sql, json: json as any, admin, conn, bot, gmail, stripe, revokes, outbound, modelCalls, logged, clock, now, people,
    async addPerson(i, slot) {
      const spec = personSpec(i, slot);
      const uid = uidOf(i), token = tokenOf(i), tg = tgOf(i);
      await sql(`insert into auth.users (id, email) values (${q(uid)}, ${q(emailOf(spec))}); insert into public.profiles (id) values (${q(uid)});
        insert into public.career_watch_kv (user_id, key, value) values (${q(uid)}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.channel_contacts (contact, user_id, created_at, updated_at, last_inbound_at) values ('tg:${tg}', ${q(uid)}, now() - interval '1 day', now() - interval '1 day', now() - interval '1 day');`);
      const p: Person = { spec, uid, token, tg, web: { thread: null }, seen: { card: null, drafts: null, page: null }, seenTg: { card: null, drafts: null, page: null }, approvedApps: new Set(), approvedDrafts: new Set(),
        retiredGpa: [], gpa: spec.gpa, retiredGrad: [], grad: spec.grad, confirmed: false, deleted: false, tgStopped: false, paused: false, gmail: false, erased: false, log: [] };
      people.push(p);
      chats.set(uid, h.chat(token));
      return p;
    },
    as: (p, f) => whose.run(p.uid, f),
    async web(p, message, extra = {}) {
      await sql(`delete from public.agent_rate_limits where user_id = ${q(p.uid)}`);
      modelTurn++;
      const r = await chats.get(p.uid)!.say(message, extra);
      p.web.thread = chats.get(p.uid)!.thread();
      return r;
    },
    async tg(p, text) {
      await sql(`delete from public.agent_rate_limits where user_id = ${q(p.uid)}`);
      modelTurn++;
      const b = bot.to(p.tg).length;
      const status = await post({ message: { message_id: ++mid, ...from(p.tg), text } });
      return { status, said: bot.to(p.tg).slice(b).map(plainOf) };
    },
    // The resume sent as a PDF on Telegram (read by the product's own reader), so its confirmation names the file.
    async tgResumeFile(p, text) {
      await sql(`delete from public.agent_rate_limits where user_id = ${q(p.uid)}`);
      modelTurn++;
      const bytes = pdfBytes(text.split("\n").filter((l) => l.trim() !== "").map((t, i) => ({ text: t, x: 72, y: 760 - i * 16 })));
      const id = `F${++fid}`;
      files.set(id, bytes);
      const b = bot.to(p.tg).length;
      const status = await post({ message: { message_id: ++mid, ...from(p.tg), document: { file_id: id, file_unique_id: `u${id}`, file_name: "resume.pdf", mime_type: PDF, file_size: bytes.length } } });
      return { status, said: bot.to(p.tg).slice(b).map(plainOf) };
    },
    async filePage(p) {
      const list = await sql(`select coalesce((select substr(key, 9) from public.career_watch_kv where user_id = ${q(p.uid)} and key like 'tg:list:%' order by updated_at desc limit 1), '')`);
      if (!/^[0-9a-f]{10}$/.test(list)) return null;
      phones[p.uid] = `+1512555${String(1000 + (p.spec.i % 9000)).padStart(4, "0")}`;
      let sid = sids.get(`${p.uid}:${list}`);
      if (!sid) { sid = await startSession(supabaseSessionStore(admin), { userId: p.uid, via: "phone", phone: phones[p.uid], telegramId: null, list, now: now() }); sids.set(`${p.uid}:${list}`, sid); }
      const r = await fileReq(sid);
      const rows: { ref: string; tag: string; jobId: string | null }[] = [];
      for (const m of r.html.matchAll(/name="ref" value="([0-9a-f]{12})"><input type="hidden" name="tag" value="([0-9a-f]{16}|none)">/g)) {
        const jobId = await sql(`select coalesce((select value->'job'->>'job_id' from public.career_watch_kv where user_id = ${q(p.uid)} and key = ${q(`tg:job:${m[1]}`)}), '')`);
        rows.push({ ref: m[1], tag: m[2], jobId: jobId || null });
      }
      return { status: r.status, html: r.html, rows, sid };
    },
    async filePost(_p, sid, form) {
      return await fileReq(sid, { form });
    },
    async tap(p, data) {
      await sql(`delete from public.agent_rate_limits where user_id = ${q(p.uid)}`);
      modelTurn++;
      const b = bot.to(p.tg).length, id = `cb-jr2-${++cb}`;
      const status = await post({ callback_query: { id, from: { id: p.tg, is_bot: false, first_name: "TEST" }, chat_instance: `ci${p.tg}`, message: { message_id: 1, chat: { id: p.tg, type: "private" }, date: 1 }, data } });
      return { status, said: bot.to(p.tg).slice(b).map(plainOf), answer: bot.answers.find((a) => a.id === id)?.text ?? "" };
    },
    // Their computer prepares what waits in their queue (the extension's career_apply_prepare_own; the database hashes it).
    async prepare(p, keys) {
      let n = 0;
      const sha = await sql(`select coalesce((select detail->'upload'->>'sha256' from public.career_events where user_id = ${q(p.uid)} and kind = 'fact_confirmed' and detail ? 'upload' order by at desc limit 1), '')`);
      for (const key of keys) {
        const post = POSTINGS.find((x) => x.key === key)!;
        const payload = { version: 1, user_id: p.uid, job_id: post.key, company: post.company, url: post.url,
          fields: [{ name: "email", label: "Email", value: emailOf(p.spec), factId: "jr2-email" }, { name: "gpa", label: "GPA", value: p.gpa, factId: "jr2-gpa" }],
          privacy_epoch: Number(await sql(`select coalesce((value->>'epoch')::int, 0) from public.career_watch_kv where user_id = ${q(p.uid)} and key = 'career:account'`) || 0),
          account_version: Number(await sql(`select coalesce((value->>'version')::int, 0) from public.career_watch_kv where user_id = ${q(p.uid)} and key = 'career:account'`) || 0),
          expires_at: new Date(Date.now() + 2 * 86400_000).toISOString(), resume_sha256: sha || "0".repeat(64) };
        const before = await sql(`select count(*) from public.career_apply_prepared where user_id = ${q(p.uid)} and job_id = ${q(post.key)} and state in ('ready', 'shown')`);
        const r = await pg.asPerson(p.uid).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`${post.company}: ${post.title}`, `Email: ${emailOf(p.spec)}`, `GPA: ${p.gpa}`] });
        const after = await sql(`select count(*) from public.career_apply_prepared where user_id = ${q(p.uid)} and job_id = ${q(post.key)} and state in ('ready', 'shown')`);
        if (!r.error && Number(after) > 0 && (Number(after) > Number(before) || r.data)) n++;
      }
      return n;
    },
    async connectGmail(p) {
      const secret = JSON.stringify({ refresh_token: `FAKE-refresh-${p.spec.i}`, access_token: `FAKE-access-${p.spec.i}`, expires_at: Date.now() + 3600e3, email: emailOf(p.spec), scopes: SEND_SCOPES });
      await sql(`select public.oauth_vault_store(${q(`oauth_google_career_${p.uid}`)}, ${q(secret)});
        insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values (${q(p.uid)}, 'google_career', ${q(`oauth_google_career_${p.uid}`)}, ${q(emailOf(p.spec))}, ${q(SEND_SCOPES)})
        on conflict do nothing`);
      p.gmail = true;
    },
    // The career-send function's loop: Gmail faked; the token is the person's own only while their grant is there.
    async sendWorker() {
      await runSendWorker({
        rpc: serviceRpc(conn).rpc, now: Date.now, fetch: gmail.fetch,
        token: async (u, scope) => (await sql(`select exists (select 1 from public.user_oauth_connections where user_id = ${q(u)} and provider = 'google_career')`)) === "t" ? `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}` : null,
        drafts: async (u, ids) => ids.length ? await json(`select * from public.career_outreach_drafts where user_id = ${q(u)} and id in (${ids.map(q).join(",")})`) : [],
      }, { worker: "jr2-worker", deadlineMs: 2000 });
    },
    // trainee-deliver, the every-minute run.
    async deliverCron(minutes = 1) {
      const before = new Map<string, number>();
      for (const p of people) before.set(p.uid, bot.to(p.tg).length);
      for (let i = 0; i < minutes; i++) {
        clock.skew += 60000;
        const res = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": DELIVER_SECRET } }), {
          env, now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }), adapters: () => adapters(), recordRun: async () => {},
        } as any);
        await res.body?.cancel();
      }
      const sentTo = new Map<string, number>();
      for (const p of people) sentTo.set(p.uid, bot.to(p.tg).length - before.get(p.uid)!);
      return { sentTo };
    },
    // delete-account's steps (the app's Delete my account), over the double, GoTrue and Storage.
    async deleteAccount(p) {
      const r = await deleteAccount(restDeps(SUPABASE_URL, SERVICE_KEY, globalThis.fetch, { sleep: async () => {}, billing: { stripeKey: STRIPE_KEY } }), p.uid);
      return { deleted: r.deleted, words: deletionWords(r) };
    },
    async stop() {
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h.restore();
      conn.close();
      await session.close();
      await pg.stop();
    },
  };
  return w;
}
export const uidOf = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${(0xa2000000 + i).toString(16).padStart(12, "0")}`;
export const tokenOf = (i: number) => `tok-jr2-${i}`;
export const tgOf = (i: number) => 7910000 + i;
