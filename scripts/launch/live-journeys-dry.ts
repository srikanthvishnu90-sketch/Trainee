// The dry mode of scripts/launch/live-journeys.ts (R3 of docs/architect/TEST-STRATEGY-2026-11-01.md): the SAME journeys, sent
// over real HTTP with the real secret header, to the REAL trainee-telegram handler composed exactly as its index.ts composes it
// (the inbound store over supabase-js, agent-chat through chatThroughAgent, the deliverer, the service client), listening on
// 127.0.0.1, with the REAL agent-chat career handler, on a throwaway Postgres 16 with every migration (tests/flow/pg.ts) behind
// the PostgREST double. Telegram is the fake Bot API (tests/architect/scenarios/telegram-bot-api.ts), the model the scripted
// stand-in the acceptance suite uses; any other host is refused and recorded, and the record must be empty. The database is
// read through the same scoped reads as production. $0, no network. Run as an unprivileged user (initdb refuses root).
//   deno run -A [--import-map=tests/flow/supabase-npm.json] scripts/launch/live-journeys.ts --dry
import { startPg } from "../../tests/flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../../tests/flow/handler.ts";
import { fakeBot } from "../../tests/architect/scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
// Types only from live-journeys.ts (its main dynamically imports this file; a value import would be a cycle under its top-level
// await): the journey itself is passed in.
import type { JourneyReport, runJourneys as RunJourneys, webhookPoster as WebhookPoster } from "./live-journeys.ts";
export interface Core { runJourneys: typeof RunJourneys; webhookPoster: typeof WebhookPoster; SYNTHETIC_CHAT: number }

const TOKEN = "123456:TEST-live-journeys-token-not-real", SECRET = "TEST_live_journeys_webhook_secret_0123456789";
const ENV_KEYS = ["CAREER_BRAIN", "CAREER_NETWORKING_DRAFT", "OPENAI_API_KEY", "CAREER_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TRAINEE_SIGNUP",
  "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_DELIVER_SECRET", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"];

// The scripted networking writer at the OpenAI URL (as the acceptance suite): one short email.
function fakeOpenAI(body: any): Response {
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
  const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to hear how you got started. Would you be open to a short call?`;
  return Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } });
}

// Two other people in the same database, looking like real ones: one made by the product over Telegram (BYSTANDER_CHAT:
// "hi", a resume, "yes"), one seeded as a web sign-up with a real-looking address and phone. The first searches while the
// sandbox posting is live; neither may see it, and the run and its clean-up may not change a single row of either.
export const BYSTANDER_CHAT = 123456789;
export const BYSTANDER_WEB = { id: "5d1f6a2e-8c3b-4e7a-9f01-2b3c4d5e6f70", email: "jordan.lee@gmail.com", phone: "+13125550142" };
export const BYSTANDER_SEARCHES = ["find me internships", "find me internships in Chicago", "find me software engineering internships in Chicago", "find me jobs in Chicago", "find me remote jobs"];
// A real-looking posting the bystander's searches must find (so "never saw the sandbox posting" is not an empty search).
export const DECOY = { job: "greenhouse:northwindtest:7001", company: "Northwind TEST", title: "Software Engineering Intern", url: "https://boards.greenhouse.io/northwindtest/jobs/7001" };
export interface DryReport extends JourneyReport {
  outbound: string[]; botViolations: string[]; botMessages: number; webhookRequests: number; badSecretStatus: number;
  bystander: { searched: number; sawSandbox: string[]; sawDecoy: number; rowsChanged: string[]; messagesAfterSearch: number; contactsIntact: boolean };
  // The sandbox posting as it is stored while live (what search reads), not as the script spells it.
  postingRow: { title: string; company: string; location: string; description: string; lexemes: string[] } | null;
  // With crashedRunFirst: what a killed earlier run left, and what was left of it after this run's preflight.
  crash: { leftPosting: number; leftAccount: boolean; postingAfter: number; accountRowsAfter: string; pointingAfter: string } | null;
}

// crashedRunFirst: a first run on the same chat is killed right after its prepared application is written (every later
// database call and webhook post fails, so its clean-up never runs), as a cancelled deploy job would leave it.
// leakToBystander: while the posting is live, a row of the web bystander's is made to point at it; the run must FAIL.
export async function runDry(o: { resume: string; runId: string; log?: (l: string) => void; crashedRunFirst?: boolean; leakToBystander?: boolean }, core: Core): Promise<DryReport> {
  const { runJourneys, webhookPoster, SYNTHETIC_CHAT } = core;
  const pg = await startPg();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  const realFetch = globalThis.fetch;
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  let server: Deno.HttpServer | null = null;
  try {
    await supabaseParity(pg);
    h = await careerHandler(pg, {});
    const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
    const bot = fakeBot({ token: TOKEN, now: Date.now });
    const viaDouble = globalThis.fetch, outbound: string[] = [];
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.hostname === "127.0.0.1") return await realFetch(req); // the journeys' own webhook POSTs
      if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
      if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
      if (u.host === "api.telegram.org") return await bot.fetch(req);
      if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
      outbound.push(`${req.method} ${u.host}${u.pathname}`);
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;
    for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeLiveJourneysBot", TRAINEE_SIGNUP: "closed",
      TRAINEE_ALLOWED_CONTACTS: `telegram:${SYNTHETIC_CHAT},telegram:${BYSTANDER_CHAT}`, TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh", CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: "sk-test-not-real",
      CAREER_MODEL: "gpt-5-mini" })) Deno.env.set(k, v);
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // trainee-telegram as index.ts serves it, on loopback.
    let webhookRequests = 0;
    server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
      if (new URL(req.url).pathname !== "/functions/v1/trainee-telegram") return new Response("not found", { status: 404 });
      webhookRequests++;
      const deliverNow = deliverer(admin, Deno.env);
      return await handleTelegram(req, { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
        deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
    });
    const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/functions/v1/trainee-telegram`;
    // The door: a wrong secret is refused before anything is read.
    const bad = await webhookPoster(url, "wrong-secret-0000000000000000")({ update_id: 1, message: { message_id: 1, chat: { id: SYNTHETIC_CHAT, type: "private" }, from: { id: SYNTHETIC_CHAT }, date: 1, text: "hi" } });
    const poster = webhookPoster(url, SECRET);
    const allUserTables = `from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'user_id' and tb.table_type = 'BASE TABLE'`;
    const countWhere = async (where: string) => (await pg.sql(`select coalesce(string_agg(x, ', '), '') from (select c.table_name || ':' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I t where ${where.replace(/'/g, "''").replace(/%/g, "%%")}', c.table_name), false, true, '')))[1]::text as x ${allUserTables}) s where x !~ ':0$'`)).trim();

    // ---- a killed earlier run
    let crash: DryReport["crash"] = null, crashUid = "", crashBoard = "";
    if (o.crashedRunFirst) {
      let killed = false;
      const crashRun = `${o.runId}-crash`.slice(0, 40);
      crashBoard = `trainee-sandbox-${crashRun}`;
      await runJourneys({
        post: async (u) => { if (killed) throw new Error("KILLED"); return await poster(u); },
        db: { sql: async (t) => { if (killed) throw new Error("KILLED"); const r = await pg.sql(t); if (/insert into public\.career_apply_prepared/.test(t)) killed = true; return r; } },
        chat: SYNTHETIC_CHAT, delivery: "verified", runId: crashRun, resume: o.resume, log: (l) => (o.log ?? console.log)(`(killed run) ${l}`), replyTimeoutMs: 15_000, tapWaitMs: 300,
      });
      crashUid = (await pg.sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${SYNTHETIC_CHAT}'), '')`)).trim();
      crash = { leftPosting: Number(await pg.sql(`select count(*) from public.career_postings where board = '${crashBoard}'`)), leftAccount: !!crashUid, postingAfter: -1, accountRowsAfter: "?", pointingAfter: "?" };
    }

    // ---- the bystanders, before the run
    let bu = 50_000, bm = 0;
    const bsay = async (text: string) => {
      const r = await poster({ update_id: ++bu, message: { message_id: ++bm, chat: { id: BYSTANDER_CHAT, type: "private" }, from: { id: BYSTANDER_CHAT, is_bot: false, first_name: "Jordan" }, date: 1, text } });
      if (r.status !== 200) throw new Error(`bystander update refused: ${r.status}`);
    };
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values
      ('${DECOY.job}', 'greenhouse', 'northwindtest', '${DECOY.company}', '${DECOY.title}', 'Chicago, IL', '${DECOY.url}', 'Requirements: Python, SQL. Summer internship.', now() - interval '2 hours', now() - interval '2 hours', now())`);
    await bsay("hi");
    await bsay(`here is my resume:\n${o.resume}`);
    await bsay("yes, that's my resume");
    const W = BYSTANDER_WEB;
    await pg.sql(`insert into auth.users (id, email) values ('${W.id}', '${W.email}'); insert into public.profiles (id) values ('${W.id}');
      insert into public.channel_contacts (contact, user_id) values ('${W.phone}', '${W.id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${W.id}', 'career:account', '{"epoch":0,"version":0,"paused":false}'::jsonb);
      insert into public.career_events (user_id, kind, subject, detail) values ('${W.id}', 'fact_confirmed', 'Data Analyst at Northwind', '{"confirmation_event_id":"seed-ev"}');`);
    const tgUser = (await pg.sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${BYSTANDER_CHAT}'), '')`)).trim();
    if (!tgUser) throw new Error("the Telegram bystander has no account");
    const people = [tgUser, W.id];
    // Every row of theirs, table by table, as text: equal before and after means untouched.
    const snapshot = async () => {
      const t = await pg.sql(`select coalesce(string_agg(x, E'\n' order by x), '') from (
        select c.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(t::text, %L order by t::text)), %L) as h from public.%I t where t.user_id = any(%L::uuid[])',
          '|', 'none', c.table_name, '{${people.join(",")}}'), false, true, '')))[1]::text as x
        from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'user_id' and tb.table_type = 'BASE TABLE'
        union all select 'auth.users:' || coalesce(md5(string_agg(u::text, '|' order by u.id)), 'none') from auth.users u where u.id = any('{${people.join(",")}}'::uuid[])
        union all select 'channel_contacts:' || coalesce(md5(string_agg(c::text, '|' order by c.contact)), 'none') from public.channel_contacts c where c.user_id = any('{${people.join(",")}}'::uuid[])
      ) s`);
      return new Map(t.split("\n").filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf(":")), l.slice(l.lastIndexOf(":") + 1)]));
    };
    const bystander = { searched: 0, sawSandbox: [] as string[], sawDecoy: 0, rowsChanged: [] as string[], messagesAfterSearch: 0, contactsIntact: false };
    let before = new Map<string, string>(), botAfter = 0;
    let postingRow: DryReport["postingRow"] = null;
    const whilePostingLive = async (p: { company: string; title: string; board: string }) => {
      const row = JSON.parse((await pg.sql(`select coalesce((select json_build_object('title', title, 'company', company, 'location', location, 'description', description,
        'lexemes', (select coalesce(json_agg(lexeme order by lexeme), '[]') from unnest(search))) from public.career_postings where board = '${p.board}'), 'null')`)).trim());
      postingRow = row;
      if (o.leakToBystander) await pg.sql(`insert into public.career_watch_kv (user_id, key, value) values ('${W.id}', 'tg:job:leak', ${"'"}${JSON.stringify({ job: `greenhouse:${p.board}:1` })}${"'"}::jsonb)`);
      for (const words of BYSTANDER_SEARCHES) {
        const from = bot.to(BYSTANDER_CHAT).length;
        await bsay(words);
        bystander.searched++;
        const seen = bot.to(BYSTANDER_CHAT).slice(from).map((m: any) => `${m.text} ${JSON.stringify(m.buttons ?? [])}`).join("\n");
        if (seen.includes(p.company) || seen.includes(p.title) || seen.includes(p.board) || seen.includes("sandbox-employer")) bystander.sawSandbox.push(words);
        if (seen.includes(DECOY.company)) bystander.sawDecoy++;
      }
      before = await snapshot();
      botAfter = bot.to(BYSTANDER_CHAT).length;
    };

    const report = await runJourneys({ post: poster, db: { sql: (t) => pg.sql(t) }, chat: SYNTHETIC_CHAT, delivery: "verified", runId: o.runId, resume: o.resume, log: o.log, replyTimeoutMs: 15_000, tapWaitMs: 300, whilePostingLive });
    const after = await snapshot();
    for (const [k, v] of before) if (after.get(k) !== v) bystander.rowsChanged.push(k);
    for (const k of after.keys()) if (!before.has(k)) bystander.rowsChanged.push(k);
    bystander.messagesAfterSearch = bot.to(BYSTANDER_CHAT).length - botAfter;
    bystander.contactsIntact = (await pg.sql(`select count(*) from public.channel_contacts where (contact = 'tg:${BYSTANDER_CHAT}' and user_id = '${tgUser}') or (contact = '${W.phone}' and user_id = '${W.id}')`)).trim() === "2";
    if (crash) {
      crash.postingAfter = Number(await pg.sql(`select count(*) from public.career_postings where board = '${crashBoard}'`));
      crash.accountRowsAfter = crashUid ? await countWhere(`t.user_id = '${crashUid}'`) : "";
      crash.pointingAfter = await countWhere(`t::text like '%${crashBoard}%'`);
      (o.log ?? console.log)(`LIVE_JOURNEY dry killed run: left posting=${crash.leftPosting} account=${crash.leftAccount}; after: posting=${crash.postingAfter} account_rows=${crash.accountRowsAfter || 0} pointing=${crash.pointingAfter || 0}`);
      if (!crash.leftPosting || !crash.leftAccount || crash.postingAfter || crash.accountRowsAfter || crash.pointingAfter) report.pass = false;
    }
    const out: DryReport = { ...report, outbound, botViolations: bot.violations.slice(0, 5), botMessages: bot.to(SYNTHETIC_CHAT).length, webhookRequests, badSecretStatus: bad.status, bystander, postingRow, crash };
    (o.log ?? console.log)(`LIVE_JOURNEY dry bystanders: searched=${bystander.searched} saw_sandbox=${bystander.sawSandbox.length} saw_decoy=${bystander.sawDecoy} rows_changed=${bystander.rowsChanged.join(",") || 0} messages_after=${bystander.messagesAfterSearch} contacts_intact=${bystander.contactsIntact}`);
    if (bystander.searched < BYSTANDER_SEARCHES.length || bystander.sawSandbox.length || bystander.sawDecoy < 2 || bystander.rowsChanged.length || bystander.messagesAfterSearch || !bystander.contactsIntact || before.size === 0) out.pass = false;
    (o.log ?? console.log)(`LIVE_JOURNEY dry: webhook_requests=${webhookRequests} bot_messages=${out.botMessages} bot_violations=${bot.violations.length} outbound=${outbound.length} bad_secret_status=${bad.status}`);
    if (outbound.length || bot.violations.length || ![401, 403].includes(bad.status)) out.pass = false;
    return out;
  } finally {
    await server?.shutdown();
    globalThis.fetch = realFetch;
    h?.restore();
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await pg.stop();
  }
}
