// The Telegram chat flow, round 4, on Postgres (architect, 2026-11-05; the ~10,000 generated scenarios on the pure functions are
// scenarios-telegram-r4.test.ts). Sampled end to end: the REAL trainee-telegram webhook (handleTelegram, composed as its index.ts
// composes it: the inbound store and the service client over supabase-js, the job cards, Confirm, the head-start delivery over the
// channel store) -> chatThroughAgent -> agent-chat's REAL career handler (handler-career.ts handleChat) on a real Postgres 16 with every
// migration (tests/flow/pg.ts) behind the PostgREST double. No model: the one turn a model would answer with postings ("find me 2 data
// jobs", its search tool's hits) is a scripted stand-in; every other turn is agent-chat's own code (the results list and its apply-all
// offer, the yes, /start). Telegram is a fake Bot API (scenarios/telegram-r3-world.ts bot); its pacing waits on a moved clock, not the
// wall. Every other host is refused. Per person, one of:
//   cards     two job cards; Apply shows the exact payload with Confirm; a tampered Confirm, another chat's Confirm and a second tap
//             approve nothing more; the Confirm approves exactly that payload, once
//   changed   the application is prepared again after Apply: the old Confirm approves nothing and says so, the current one is
//             shown, and its own Confirm approves exactly it
//   yes       "find me 10 frontend internship roles" (agent-chat's results and offer), "yes": exactly the prepared roles approved
//             (approval hash = the payload hash offered), the unprepared one queued to prepare, a second yes adds nothing
//   stop-yes  the offer, then /stop, then "yes": nothing approved, said why (round 4 fix); /start: back on, and the old offer is over;
//             asked again, the yes approves exactly the prepared roles
//   paused    the offer, then the account is paused ("pause"), then "yes": nothing approved and nothing queued, said why
// After every person, against the database: every application row is the person's own, its approval hash is its payload hash and
// one the person was shown; nothing for anyone else. After all: every message to a private chat, within Telegram's limits; no
// internal id (an account id, a prepared id, a posting's internal id) in any message; nothing left the machine; no secret in a log.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-telegram-r4.test.ts (TG4_FLOW_N=10)
// After PR #498 merges, its tests/flow/virtual-clock.ts can drive this file's pacing too; it sleeps nothing today (the adapters get
// a moved clock), and each chat gets at most about a dozen messages.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { bot, SECRET, TOKEN } from "./scenarios/telegram-r3-world.ts";
import { plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { hashTag, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import * as AY from "../../supabase/functions/_shared/apply_all_yes.ts";
// architect amendment E.21 (2026-11-10): a search's posting-page checks are held to helpers/posting_checks.ts (no board listing, at most N for the N shown, never over 10); every other off-machine request is still a fault.
import { postingChecks } from "./helpers/posting_checks.ts";

const STOPPED_AFTER_OFFER_REPLY = (AY as Record<string, unknown>).STOPPED_AFTER_OFFER_REPLY as string ?? "(no answer for a yes after STOP)";
const CI = Deno.env.get("CI") === "true";
const N = Number(Deno.env.get("TG4_FLOW_N") || 5);
const KINDS = ["cards", "changed", "yes", "stop-yes", "paused"] as const;
const CHAT = (n: number) => 7840000 + n * 3;
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const LIVE = [
  { id: "greenhouse:qa4:1", company: "TEST Web", title: "Frontend Engineering Intern", loc: "Chicago, IL", d: "Build React and TypeScript components. Pay: $35 - $40 per hour." },
  { id: "greenhouse:qa4:2", company: "TEST Design", title: "Frontend Intern", loc: "Remote", d: "Ship UI features in JavaScript with our design team." },
  { id: "greenhouse:qa4:3", company: "TEST Quiet", title: "Frontend Developer Intern", loc: "Chicago, IL", d: "Build web pages in JavaScript and CSS for our product." },
  { id: "greenhouse:qa4:4", company: "TEST Fourth", title: "Frontend Intern", loc: "Chicago, IL", d: "JavaScript and CSS frontend internship." },
];
const urlOf = (i: number) => `https://boards.greenhouse.io/qa4/jobs/${i + 1}`;
const ASK = "find me 10 frontend internship roles";

Deno.test({
  name: `Telegram round 4 on Postgres: ${N} people, cards -> taps -> apply-all yes -> /stop -> /start through the real webhook and agent-chat`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string | null) => { if (!(k in saved)) saved[k] = Deno.env.get(k); v === null ? Deno.env.delete(k) : Deno.env.set(k, v); };
    for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) saved[k] = Deno.env.get(k);
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
      const sql = async (s: string) => (await fast.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
      for (const [i, p] of LIVE.entries()) {
        await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
          values (${q(p.id)}, 'greenhouse', 'qa4', ${q(p.company)}, ${q(p.title)}, ${q(p.loc)}, ${q(urlOf(i))}, ${q(p.d)}, now() - interval '${i + 1} days', now() - interval '${i + 1} days', now())`);
      }
      // agent-chat's own settings for the results list (its page link) and no model at all (a key left by an earlier file would let one run).
      setEnv("TRAINEE_FILE_LINK_SECRET", ["TEST", "r4", "results", "link", "secret", "0123456789abcdef"].join("-"));
      setEnv("TRAINEE_FILE_BASE_URL", "https://trainee.example/file");
      setEnv("OPENAI_API_KEY", ["test", "key", "r4"].join("-"));
      for (const k of ["ANTHROPIC_API_KEY", "CAREER_BRAIN", "CAREER_MODEL", "CAREER_REPLY_MODEL", "CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_APPLY_ALL_YES"]) setEnv(k, null);
      h = await careerHandler(fast, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");

      // ------------------------------------------------------------------------------------------ the clock, Telegram, the network
      let skew = 0;
      const now = () => Date.now() + skew;
      const clock = { get t() { return now(); } };
      const sleep = async (ms: number) => { skew += ms; };
      const B = bot(clock as { t: number });
      const viaDouble = globalThis.fetch, outbound: string[] = [], checks = postingChecks();
      let modelCalls = 0;
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.telegram.org") return await B.fetch(req.url, { method: req.method, headers: req.headers, body: await req.text() });
        if (u.host === "api.openai.com" || u.host === "api.anthropic.com") { modelCalls++; throw new TypeError("no model in this test"); }
        if (checks.take(req.method, req.url)) throw new TypeError(`network refused: ${u.host}`);
        outbound.push(u.host);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

      // ------------------------------------------------------------------------------------------ the deployment's secrets (built at run time)
      const vars: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeFlowR4Bot", TRAINEE_SIGNUP: "closed",
        TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_FILE_LINK_SECRET: Deno.env.get("TRAINEE_FILE_LINK_SECRET")! };
      const env = { get: (k: string) => vars[k] || undefined };
      const adapterOf = (e: typeof env) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: e.get("TELEGRAM_WEBHOOK_SECRET") || "", fetch: B.fetch, clock: now, sleep });
      const adapters = () => adaptersFromEnv(env, { fetch: B.fetch, clock: now, sleep });

      // ------------------------------------------------------------------------------------------ the brain: agent-chat, but for one search
      const agent = chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" });
      const scripted = new Map<string, unknown[]>(); // a person's "find me 2 data jobs": the hits a model's search tool would return
      const chat = async (a: any) => {
        const hits = /^find me 2 data jobs$/.test(a.message) ? scripted.get(a.userId) : undefined;
        if (hits) return { status: 200, threadId: a.threadId ?? null, reply: "Two roles for you (TEST).", postings: hits } as any;
        return await agent(a);
      };
      const deliver = async (a: { userId: string; key: string; now: number }) => {
        const store = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } });
        const r = await deliverDue({ store, adapters: adapters(), now: a.now, limit: 1 });
        await store.release();
        return r;
      };
      let upd = 940000, mid = 100;
      const post = async (body: Record<string, unknown>) => {
        await sql("delete from public.agent_rate_limits");
        const raw = JSON.stringify({ update_id: ++upd, ...body });
        const chatOf = (raw: string) => { try { const b = JSON.parse(raw); return Number((b.message ?? b.edited_message ?? b.callback_query?.message)?.chat?.id ?? 0); } catch { return 0; } };
        const c = chatOf(raw), k = B.to(c).length;
        const res = await checks.turn(`update ${upd}`, () => handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: raw }),
          { env, now, store: () => supabaseInboundStore(admin), chat, admin, deliver, adapter: adapterOf }), () => B.to(c).slice(k).map(plainOf).join("\n"));
        const text = await res.text();
        if (res.status !== 200) fail("webhook", `HTTP ${res.status} ${text.slice(0, 160)}`);
        if (text.includes(TOKEN) || text.includes(SECRET)) fail("webhook", "a response carries a secret");
        return text;
      };
      const from = (c: number) => ({ chat: { id: c, type: "private" }, from: { id: c, is_bot: false, first_name: "TEST" }, date: 1 });
      const say = async (c: number, t: string) => { const k = B.to(c).length; await post({ message: { message_id: ++mid, ...from(c), text: t } }); return B.to(c).slice(k).map(plainOf); };
      const tap = async (c: number, data: string, o: { from?: number } = {}) => {
        const id = `cb-r4-${++mid}`, k = B.to(c).length;
        await post({ callback_query: { id, from: { id: o.from ?? c, is_bot: false, first_name: "TEST" }, chat_instance: `ci${c}`, message: { message_id: 1, chat: { id: c, type: "private" }, date: 1 }, data } });
        return { said: B.to(c).slice(k).map(plainOf), answer: B.answers.find((a) => a.id === id)?.text ?? "" };
      };
      const buttons = (c: number, k = 0) => B.to(c).slice(k).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? ""));
      let seq = 0;
      const person = async (c: number) => {
        const u = crypto.randomUUID();
        await sql(`insert into auth.users (id, email) values ('${u}', 'tg4-${++seq}@example.test'); insert into public.profiles (id) values ('${u}');
          insert into public.channel_contacts (contact, user_id, created_at, updated_at, last_inbound_at) values ('tg:${c}', '${u}', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour');
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"authority_version":0,"paused":false}'::jsonb) on conflict (user_id, key) do nothing;
          ${confirmedResumeSql(u)} insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('a', 64) || '.pdf') on conflict do nothing;`);
        return u;
      };
      // One prepared application (the exact payload the person approves), the newest for its posting.
      const prepare = async (u: string, i: number, note: string): Promise<{ id: string; hash: string }> => JSON.parse(await sql(`
        update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${q(LIVE[i].id)} and state in ('ready','shown');
        with p as (select jsonb_build_object('version',1,'user_id','${u}','job_id',${q(LIVE[i].id)},'company',${q(LIVE[i].company)},'url',${q(urlOf(i))},'destination',${q(urlOf(i))},
          'fields','[]'::jsonb,'cover_note',jsonb_build_object('text',${q(note)}),'privacy_epoch',0,'account_version',0,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64)) as pl)
        insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state) select '${u}', ${q(LIVE[i].id)}, ${q(LIVE[i].company)}, ${q(urlOf(i))}, pl, public.career_apply_payload_hash(pl), array[${q(LIVE[i].company)}], 'ready' from p
        returning json_build_object('id', id, 'hash', payload_hash)`).then((x) => x.split("\n").pop()!));
      const jobs = async (u: string) => await json(`select job_id, payload_hash, approval_hash from public.career_apply_jobs where user_id = '${u}' order by job_id`) as { job_id: string; payload_hash: string; approval_hash: string }[];
      const wanted = async (u: string) => Number(await sql(`select count(*) from public.career_apply_wanted where user_id = '${u}'`));
      const offerOn = async (u: string) => JSON.parse(await sql(`select coalesce((select m.meta->'apply_all_offer' from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
        where t.user_id = '${u}' and m.role = 'assistant' order by m.id desc limit 1), 'null'::jsonb)`) || "null");
      const ids: string[] = [];
      const shownHashes = new Map<string, Set<string>>();
      const shown = (u: string, hash: string) => { const s = shownHashes.get(u) ?? new Set(); s.add(hash); shownHashes.set(u, s); };
      // The invariant on the database after each person: every row theirs, approved as shown.
      const check = async (who: string, u: string) => {
        for (const r of await jobs(u)) {
          if (r.approval_hash !== r.payload_hash) fail(who, `an application whose approval hash is not its payload hash (${r.job_id})`);
          if (!shownHashes.get(u)?.has(r.payload_hash)) fail(who, `an application approved that the person was never shown (${r.job_id})`);
        }
      };

      for (let n = 0; n < N; n++) {
        const kind = KINDS[n % KINDS.length], c = CHAT(n), who = `person ${n} (${kind})`;
        bump(kind);
        const before = failures.length;
        const u = await person(c);
        ids.push(u);
        if (kind === "cards" || kind === "changed") {
          const p0 = await prepare(u, 0, `Cover for TEST Web ${n}.`);
          ids.push(p0.id);
          scripted.set(u, [0, 1].map((i) => ({ job_id: LIVE[i].id, company: LIVE[i].company, title: LIVE[i].title, location: LIVE[i].loc, url: urlOf(i), fit: { reasons: [], gaps: [] } })));
          const k0 = B.to(c).length;
          await say(c, "find me 2 data jobs");
          const ref = await refOf(u, LIVE[0].id);
          if (!buttons(c, k0).includes(`jca:${ref}`)) fail(who, `no Apply on the card: ${JSON.stringify(buttons(c, k0))}`);
          const a = await tap(c, `jca:${ref}`);
          const confirm = `jcy:${ref}:${hashTag(p0.hash)}`;
          if (!a.said.some((x) => x.includes(`Cover for TEST Web ${n}.`))) fail(who, `Apply did not show the exact payload: ${JSON.stringify(a.said).slice(0, 300)}`);
          if (!buttons(c, k0).includes(confirm)) fail(who, "the payload page's Confirm is not bound to the prepared hash");
          shown(u, p0.hash);
          if (kind === "cards") {
            const bad = `jcy:${ref}:${hashTag(p0.hash).replace(/^./, (x) => (x === "0" ? "1" : "0"))}`;
            const t1 = await tap(c, bad);
            if ((await jobs(u)).length) fail(who, "a tampered Confirm approved something");
            if (!t1.answer || !t1.said.some((x) => /nothing was approved/i.test(x))) fail(who, `a tampered Confirm was not refused in words: ${JSON.stringify(t1)}`.slice(0, 300));
            const other = c + 1, ou = await person(other);
            const t2 = await tap(other, confirm);
            if ((await jobs(u)).length || (await jobs(ou)).length) fail(who, "another chat's tap on the owner's Confirm approved something");
            if (t2.said.some((x) => x.includes("Cover for TEST Web"))) fail(who, "another chat was shown the owner's payload");
            await tap(c, confirm);
            await tap(c, confirm);
            const js = await jobs(u);
            if (js.length !== 1 || js[0].payload_hash !== p0.hash) fail(who, `Confirm then a second tap: ${JSON.stringify(js)}`);
          } else {
            const p1 = await prepare(u, 0, `A changed cover for TEST Web ${n}.`);
            ids.push(p1.id);
            const t1 = await tap(c, confirm);
            if ((await jobs(u)).length) fail(who, "the old Confirm approved a payload that changed");
            if (!t1.said.some((x) => /changed after I showed it/.test(x) && /nothing was approved/.test(x))) fail(who, `the change was not said: ${JSON.stringify(t1.said).slice(0, 300)}`);
            if (!t1.said.some((x) => x.includes(`A changed cover for TEST Web ${n}.`))) fail(who, "the current application was not shown");
            const fresh = `jcy:${ref}:${hashTag(p1.hash)}`;
            if (!buttons(c).includes(fresh)) fail(who, "no Confirm bound to the current hash");
            shown(u, p1.hash);
            await tap(c, fresh);
            const js = await jobs(u);
            if (js.length !== 1 || js[0].payload_hash !== p1.hash) fail(who, `the fresh Confirm: ${JSON.stringify(js)}`);
          }
        } else {
          const preps = [];
          for (const i of [0, 1, 2]) { const p = await prepare(u, i, `Cover ${i} for ${n}.`); preps.push(p); ids.push(p.id); }
          const askFor = async () => {
            const out = await say(c, ASK);
            const offer = await offerOn(u);
            if (!offer || offer.jobs?.length !== 4) { fail(who, `no offer for the 4 roles: ${JSON.stringify(out).slice(0, 300)}`); return null; }
            if (!out.some((x) => /Reply yes and I'll apply to the 3 prepared so far and get the other 1 ready\./.test(x))) fail(who, `the results do not end with the question: ${JSON.stringify(out).slice(-300)}`);
            for (const j of offer.jobs) if (j.tag) { const p = preps.find((x) => hashTag(x.hash) === j.tag); if (!p) fail(who, "an offered tag that is no prepared payload"); else shown(u, p.hash); }
            return offer;
          };
          if (kind === "yes") {
            if (await askFor()) {
              const y = await say(c, "yes");
              const js = await jobs(u);
              if (js.length !== 3 || js.some((r) => !preps.some((p) => p.hash === r.payload_hash))) fail(who, `the yes approved ${JSON.stringify(js)}`);
              if (await wanted(u) < 1) fail(who, "the unprepared role was not queued to prepare");
              if (!y.some((x) => /Approved and queued 3 applications/.test(x))) fail(who, `the yes reply: ${JSON.stringify(y).slice(0, 300)}`);
              await say(c, "yes");
              if ((await jobs(u)).length !== 3) fail(who, "a second yes approved more");
            }
          } else if (kind === "stop-yes") {
            if (await askFor()) {
              const s = await say(c, "/stop");
              if (!s.includes(CHANNEL_REPLIES.stop)) fail(who, `the STOP reply: ${JSON.stringify(s)}`);
              if (await sql(`select opted_out from public.channel_contacts where contact = 'tg:${c}'`) !== "t") fail(who, "/stop was not recorded");
              const y = await say(c, "yes");
              if ((await jobs(u)).length || await wanted(u)) fail(who, "a yes after /stop approved or queued something");
              if (!y.includes(STOPPED_AFTER_OFFER_REPLY)) fail(who, `a yes after /stop was answered ${JSON.stringify(y).slice(0, 300)}`);
              const st = await say(c, "/start");
              if (!st.some((x) => x.startsWith(CHANNEL_REPLIES.start))) fail(who, `the /start reply: ${JSON.stringify(st).slice(0, 200)}`);
              if (await sql(`select opted_out from public.channel_contacts where contact = 'tg:${c}'`) !== "f") fail(who, "/start did not turn messages back on");
              await say(c, "yes");
              if ((await jobs(u)).length) fail(who, "a yes after /start approved the offer /stop ended");
              if (await askFor()) {
                await say(c, "yes");
                const js = await jobs(u);
                if (js.length !== 3) fail(who, `asked again after /start, the yes approved ${js.length}`);
              }
            }
          } else {
            if (await askFor()) {
              await sql(`update public.career_watch_kv set value = jsonb_set(value, '{paused}', 'true') where user_id = '${u}' and key = 'career:account'`);
              const y = await say(c, "yes");
              if ((await jobs(u)).length || await wanted(u)) fail(who, `a paused account's yes approved ${(await jobs(u)).length} or queued ${await wanted(u)}`);
              if (!y.some((x) => /paused/.test(x))) fail(who, `a paused account's yes did not say paused: ${JSON.stringify(y).slice(0, 300)}`);
            }
          }
        }
        await check(who, u);
        if (failures.length === before) bump(`${kind} ok`);
      }

      // Everyone else's rows: none (the only applications are the people's own, checked above).
      const strays = await json(`select user_id from public.career_apply_jobs where user_id <> all (array[${ids.filter((x) => /^[0-9a-f-]{36}$/.test(x)).map((x) => `'${x}'::uuid`).join(",")}])`);
      if (strays.length) fail("database", `${strays.length} applications for someone outside the scenario`);
      for (const v of B.problems()) fail("Bot API", v);
      for (const m of B.msgs) {
        if (Number(m.chat) <= 0) fail("Bot API", "a message to a group");
        const t = plainOf(m);
        if (t.length > 4096) fail("Bot API", `a ${t.length}-character message`);
        for (const id of [...ids, ...LIVE.map((p) => p.id)]) if (t.includes(id)) { fail("text", `an internal id in a message: ${id.slice(0, 18)} in ${JSON.stringify(t.slice(0, 160))}`); break; }
      }
      if (outbound.length) fail("network", [...new Set(outbound)].join(", "));
      for (const f of checks.faults) fail("network", f);
      const secrets = logged.filter((l) => l.includes(TOKEN) || l.includes(SECRET));
      if (secrets.length) fail("logs", `${secrets.length} log lines carry a secret`);
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      console.log(`[flow-telegram-r4] ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${B.msgs.length} messages, ${B.answers.length} taps answered; ${modelCalls} model calls refused; ${failures.length} failures`);
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
