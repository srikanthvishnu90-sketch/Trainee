// NEW-USER ONBOARDING ROUND 2 end to end (architect, 2026-10-30; round 1: flow-scenarios-onboarding.test.ts, #294): first
// sessions sampled from the round-2 generator (tests/architect/scenarios/onboarding-r2-generator.ts; every journey runs on the
// pure code in scenarios-onboarding-r2.test.ts) sent through the REAL trainee-telegram webhook, composed as its index.ts
// composes it (handleTelegram with the inbound store over supabase-js, the service client for the file, agent-chat through
// chatThroughAgent, the head-start deliverer), into the real agent-chat handler (handler-career.ts handleChat) on a real
// Postgres 16 with every migration (tests/flow/pg.ts) behind the PostgREST double. Telegram is a fake Bot API
// (scenarios/telegram-bot-api.ts) that also serves getFile and the file itself: the resumes are real PDF and Word bytes,
// read by the product's own reader. No model (CAREER_BRAIN and ANTHROPIC_API_KEY unset); every other host is refused.
// Each person signs up by their first message (an allow-listed chat), sends their resume as a FILE, and replies: partial
// yeses, a correction, /start, a search or an apply ask, a newer resume before the yes, a cover letter or a transcript
// instead, the yes, a dispute ("actually I never worked at X"), a newer resume after. After every turn the database is
// judged against the generator's model:
//   - the profile holds exactly the confirmed entries (as corrected, minus what was disowned) and the latest file's drafts
//   - career_resume_on_file is true exactly when they confirmed; the record names the FILE they confirmed (its sha256);
//     career_apply_profile_for (what every application is prepared from) holds exactly the confirmed entries
//   - before the yes nothing is queued; an apply ask says the resume is why
//   - read-backs carry nothing unconfirmed, replaced or disowned
// and, beside the journeys:
//   bad files   a scan, a locked PDF, over 10 MB, 0 bytes, a photo, a .doc, an SSN or a card number inside: the reason said,
//               no turn, nothing stored (the number in no table)
//   stop        /stop in the middle of onboarding, then /start: the entries come back for the yes, and the yes confirms
//   races       the yes on Telegram and on the web at once (saved, or said plainly not saved and saved when sent again); a
//               newer file and the yes at once: one consistent state
//   second      a second person in another chat: none of the first person's record is theirs
// Volume and time: 70 people, about 400 turns. One long-lived psql session for the checks (tests/flow/psql-session.ts).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { FILE_EMPTY_REPLY, FILE_KIND_REPLY, FILE_LOCKED_REPLY, FILE_NO_TEXT_REPLY, FILE_TOO_BIG_REPLY, cleanDocx, fileKind, fileSecretReply, sha256Bytes } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { type Entry, fileFor, type Journey, journeys, linkedinPaste, modelStep, newModel, resumeFile, type ResumeFile, rng, sig, type Step } from "./scenarios/onboarding-r2-generator.ts";

const CI = Deno.env.get("CI") === "true";
const SEED = 20261030;
const TOKEN = "123456:TEST-onboarding-r2-token-not-real", SECRET = "TEST_onboarding_r2_webhook_secret_0123456789";
const CHAT = (n: number) => 7740000 + n;
const SEEDED = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000002e${String(n).padStart(4, "0")}`;
const RESUME_KINDS = new Set(["experience", "education", "project", "leadership", "certification"]);
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const BAD = ["bad-scan", "bad-locked", "bad-huge", "bad-huge-unsaid", "bad-zero", "bad-photo", "bad-doc", "bad-ssn", "bad-card", "bad-zip-as-pdf"] as const;
const REFUSAL = (f: ResumeFile) => ({ kind: FILE_KIND_REPLY, too_large: FILE_TOO_BIG_REPLY, empty: FILE_EMPTY_REPLY, no_text: FILE_NO_TEXT_REPLY, locked: FILE_LOCKED_REPLY,
  secret: fileSecretReply([f.family === "bad-ssn" ? "a Social Security number" : "a card number"]) } as Record<string, string>)[(f.expect as { refusal: string }).refusal];

type Role = "plain" | "bad-first" | "stop" | "race-channels" | "race-newer";
function people(): { j: Journey; role: Role }[] {
  const all = journeys(rng(SEED + 9), 3000).filter((j) => j.steps.length <= 7);
  const out: { j: Journey; role: Role }[] = [];
  const N = 70;
  for (let i = 0; i < N; i++) {
    const j = all[i * Math.floor(all.length / N)];
    let role: Role = i % 7 === 2 ? "bad-first" : i % 14 === 5 ? "stop" : i % 14 === 10 ? "race-channels" : i % 14 === 12 ? "race-newer" : "plain";
    if (role.startsWith("race") && j.steps[0].t !== "upload") role = "plain";
    out.push({ j, role });
  }
  return out;
}

Deno.test({
  name: "onboarding round 2 on Postgres: 70 first sessions through the real Telegram webhook, resumes as real files; only what each person confirmed is theirs",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
      "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL", "TRAINEE_SIGNUP", "TRAINEE_ALLOWED_CONTACTS", "CAREER_REPLY_WRITER", "CAREER_TEXTING_NATIVE", "TRAINEE_DELIVER_SECRET", "LOOPMESSAGE_API_KEY",
      "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_LOGO_URL", "TRAINEE_LOGO_GUESS", "TELEGRAM_GLOBAL_PACER"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    let closeSession: (() => Promise<void>) | null = null;
    const failures: string[] = [];
    const fail = (who: string, why: string) => failures.push(`${who}: ${why}`);
    try {
      const sample = people();
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      // Race people have an account before they write (the web chat needs its token); everyone else signs up by writing.
      const seededIdx = sample.map((s, i) => (s.role.startsWith("race") ? i : -1)).filter((i) => i >= 0);
      h = await careerHandler(fast, Object.fromEntries(seededIdx.map((i) => [`tok-${i}`, SEEDED(i)])));
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const bot = fakeBot({ token: TOKEN, now: Date.now });
      // The files Telegram holds, by file_id: bytes, and the size getFile reports.
      const files = new Map<string, { bytes: Uint8Array; size: number }>();
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.telegram.org" && u.pathname === `/bot${TOKEN}/getFile`) {
          const id = String((await req.json()).file_id), f = files.get(id);
          if (!f) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
          return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u${id}`, file_size: f.size, file_path: `documents/${id}.bin` } });
        }
        if (u.host === "api.telegram.org" && u.pathname.startsWith(`/file/bot${TOKEN}/documents/`)) {
          const f = files.get(decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.bin$/, "")));
          return f ? new Response(f.bytes as BodyInit) : new Response("not found", { status: 404 });
        }
        if (u.host === "api.telegram.org") return await bot.fetch(req);
        outbound.push(`${req.method} ${u.host}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const sql = async (s: string) => (await fast.sql(s)).trim();
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeOnbBot", TRAINEE_SIGNUP: "closed",
        TRAINEE_ALLOWED_CONTACTS: sample.map((_, i) => `telegram:${CHAT(i)}`).concat(Array.from({ length: 6 }, (_, k) => `telegram:${CHAT(200 + k)}`)).join(","),
        // The shared Telegram bucket (channel_pacer.ts) really waits one second per chat per message; 70 sessions would take minutes. Its own tests (telegram-global-pacer, delivery-throughput-pg) cover it.
        TELEGRAM_GLOBAL_PACER: "off",
        TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh" })) Deno.env.set(k, v);
      for (const i of seededIdx) {
        await sql(`insert into auth.users (id, email) values ('${SEEDED(i)}', 'onbr2-${i}@example.test'); insert into public.profiles (id) values ('${SEEDED(i)}');
          insert into public.career_watch_kv (user_id, key, value) values ('${SEEDED(i)}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          insert into public.channel_contacts (contact, user_id, last_inbound_at, created_at) values ('tg:${CHAT(i)}', '${SEEDED(i)}', now() - interval '1 hour', now() - interval '2 days');`);
      }
      // ------------------------------------------------------------------------------------------ the webhook, as index.ts composes it
      let upd = 9000, mid = 100;
      const post = async (body: Record<string, unknown>) => {
        await sql("delete from public.agent_rate_limits");
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: ++upd, ...body }) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        return { status: res.status, body: await res.text() };
      };
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      const text = (chat: number, words: string) => post({ message: { message_id: ++mid, ...from(chat), text: words } });
      let fid = 0;
      const sendFile = (chat: number, f: ResumeFile) => {
        const id = `F${++fid}`;
        const size = f.family === "bad-huge-unsaid" ? 11 * 1024 * 1024 : f.declared ?? f.bytes.length;
        files.set(id, { bytes: f.bytes, size });
        return post({ message: { message_id: ++mid, ...from(chat), document: { file_id: id, file_unique_id: `u${id}`, file_name: f.name, mime_type: f.mime || undefined, ...(f.declared === null ? {} : { file_size: f.declared }) } } });
      };
      const userOfChat = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
      const said = (chat: number, from: number) => bot.to(chat).slice(from).map(plainOf).join("\n");
      const state = async (u: string) => JSON.parse(await sql(`select json_build_object(
        'facts', coalesce((select s.state->'career'->'stores'->'profile'->'facts' from public.agent_flow_state s where s.user_id = '${u}' order by (s.thread_id = (select c.thread_id from public.channel_contacts c where c.user_id = '${u}' and c.contact like 'tg:%' limit 1)) desc nulls last, s.updated_at desc limit 1), '[]'::jsonb),
        'on_file', public.career_resume_on_file('${u}'),
        'record', (select json_build_object('state', r.state, 'kind', r.kind, 'sha256', r.sha256) from public.career_resume_record r where r.user_id = '${u}'),
        'apply', coalesce(public.career_apply_profile_for('${u}')->'facts', '[]'::jsonb),
        'events', (select count(*) from public.career_events e where e.user_id = '${u}' and e.kind = 'fact_confirmed' and e.detail->>'via' = 'router: their yes to the resume entries shown to them'),
        'uploads', (select count(*) from public.career_resume_uploads where user_id = '${u}'),
        'turns', (select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and m.role = 'user'),
        'queued', (select count(*) from public.career_apply_wanted where user_id = '${u}') + (select count(*) from public.career_apply_jobs where user_id = '${u}')
          + (select count(*) from public.career_apply_cards where user_id = '${u}') + (select count(*) from public.career_apply_prepared where user_id = '${u}'))`));
      const counts: Record<string, number> = {};
      const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
      let turns = 0;

      await t.step(`${sample.length} people: sign up by sending their resume as a file, reply, confirm (or not), dispute, replace; the database holds only what each confirmed`, async () => {
        for (const [i, { j, role }] of sample.entries()) {
          const chat = CHAT(i);
          const log: string[] = [];
          const who = () => `person ${i} (${role}) [${j.family}] A=${j.aFamily} B=${j.bFamily}\n      ${log.join("\n      ")}`;
          const m = newModel();
          // What the drafts came from (a file, or a paste) and what the confirmed entries came from.
          let confirmedFile: ResumeFile | "paste" | null = null, pendingFile: ResumeFile | "paste" | null = null, okUploads = 0;
          const shaOf = new Map<ResumeFile, string>();
          // One step: sent (a file or words), the reply read back, the model moved, the database judged.
          const run = async (s: Step) => {
            const before = bot.to(chat).length;
            let r: { status: number; body: string };
            const f = fileFor(j, s);
            // the stored file is the cleaned copy (owner decision, release 8)
            if (f) { r = await sendFile(chat, f); shaOf.set(f, await sha256Bytes(fileKind(f.name, f.mime, f.bytes) === "docx" ? await cleanDocx(f.bytes).catch(() => f.bytes) : f.bytes)); }
            else if (s.t === "start") r = await text(chat, "/start");
            else if (s.t === "linkedin") r = await text(chat, linkedinPaste(j.a).text);
            else r = await text(chat, (s as { input: string }).input);
            turns++;
            const reply = said(chat, before);
            log.push(`${s.t}${f ? `(${f.family})` : ""} ${"input" in s ? JSON.stringify(s.input.slice(0, 50)) : ""} -> ${r.status}: ${reply.slice(0, 160).replace(/\n/g, " | ")}`);
            if (r.status !== 200) fail(`person ${i}`, `turn not answered: ${who()}`);
            const hadPending = m.pending;
            modelStep(m, j, s);
            if (f && "entries" in f.expect) { pendingFile = m.pending ? f : pendingFile; okUploads++; }
            if (s.t === "linkedin") pendingFile = "paste";
            if (s.t === "yes" && hadPending && m.confirmed && !m.pending) confirmedFile = pendingFile;
            if (s.t === "dispute" && !m.pending && hadPending) pendingFile = null;
            const u = await userOfChat(chat);
            if (!u) { fail(`person ${i}`, `no account after the first message: ${who()}`); return reply; }
            const st = await state(u);
            // deno-lint-ignore no-explicit-any
            const facts = (st.facts as any[]).filter((x) => x && x.source === "resume-ingest");
            const conf = facts.filter((x) => x.needs_confirmation === false), drafts = facts.filter((x) => x.needs_confirmation === true);
            if (JSON.stringify(factSig(conf)) !== JSON.stringify(sig(m.confirmed))) fail(`person ${i}`, `confirmed entries are not what the person confirmed: ${who()}\n      db    ${JSON.stringify(factSig(conf))}\n      model ${JSON.stringify(sig(m.confirmed))}`);
            if (JSON.stringify(factSig(drafts)) !== JSON.stringify(sig(m.pending))) fail(`person ${i}`, `drafts are not the latest file's: ${who()}\n      db    ${JSON.stringify(factSig(drafts))}\n      model ${JSON.stringify(sig(m.pending))}`);
            if (st.on_file !== !!(m.confirmed && m.confirmed.length)) fail(`person ${i}`, `career_resume_on_file is ${st.on_file}: ${who()}`);
            if (m.confirmed) {
              const want = confirmedFile && confirmedFile !== "paste" ? shaOf.get(confirmedFile) : null;
              if (st.record?.state !== "confirmed" || (confirmedFile === "paste" ? st.record?.kind !== "paste" : st.record?.kind !== "file" || st.record?.sha256 !== want)) fail(`person ${i}`, `the record does not name the confirmed file: ${JSON.stringify(st.record)} want ${want}: ${who()}`);
              // deno-lint-ignore no-explicit-any
              const applyFacts = factSig((st.apply as any[]).filter((x) => RESUME_KINDS.has(x.kind)));
              const wantApply = sig(m.confirmed).filter((x) => RESUME_KINDS.has(x.split("|")[0]));
              if (JSON.stringify(applyFacts) !== JSON.stringify(wantApply)) fail(`person ${i}`, `applications would be prepared from other entries: ${who()}\n      apply ${JSON.stringify(applyFacts)}\n      model ${JSON.stringify(wantApply)}`);
            } else if (st.record) fail(`person ${i}`, `a resume record with nothing confirmed: ${JSON.stringify(st.record)}: ${who()}`);
            if (!m.confirmed && Number(st.queued) !== 0) fail(`person ${i}`, `something queued before a confirmed resume: ${who()}`);
            if (Number(st.uploads) > okUploads) fail(`person ${i}`, `${st.uploads} files stored for ${okUploads} readable resumes sent: ${who()}`);
            if (s.t === "ask" && /\bapply\b/i.test(s.input) && !m.confirmed && !/resume/i.test(reply)) fail(`person ${i}`, `an apply ask before a confirmed resume does not say the resume is why: ${who()}`);
            if (s.t === "document" && !/couldn't read that file as a resume, so I didn't keep it/i.test(reply)) fail(`person ${i}`, `a ${s.family} was not said not to be a resume: ${who()}`);
            if (s.t === "readback") {
              const held = (m.confirmed ?? []).map((e: Entry) => e.title).join(" ");
              for (const v of [j.a, j.b].flatMap((p) => [p.school, p.gpa, ...p.jobs.map((x) => x.company)])) if (reply.includes(v) && !held.includes(v)) fail(`person ${i}`, `a value not on the confirmed record was read back (${v}): ${who()}`);
            }
            return reply;
          };
          // A bad file first: the reason said, no turn, nothing stored.
          if (role === "bad-first") {
            const bad = resumeFile(rng(SEED + 500 + i), BAD[(i / 7 | 0) % BAD.length], 0, j.a);
            const before = bot.to(chat).length;
            const r = await sendFile(chat, bad);
            turns++;
            const reply = said(chat, before);
            log.push(`bad file (${bad.family}) -> ${r.status}: ${reply.slice(0, 160)}`);
            if (reply.trim() !== REFUSAL(bad)) fail(`person ${i}`, `a ${bad.family} was not refused with its reason: ${who()}`);
            const u = await userOfChat(chat);
            if (u) {
              const st = await state(u);
              if (Number(st.uploads) !== 0 || Number(st.turns) !== 0) fail(`person ${i}`, `a refused ${bad.family} was stored (${st.uploads}) or ran a turn (${st.turns}): ${who()}`);
              const secret = (bad.expect as { secret?: string }).secret;
              if (secret) {
                const d = secret.replace(/\D/g, "");
                const found = await sql(`select (select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and regexp_replace(m.content, '\\D', '', 'g') like '%${d}%')
                  + (select count(*) from public.agent_flow_state s where s.user_id = '${u}' and regexp_replace(s.state::text, '\\D', '', 'g') like '%${d}%')
                  + (select count(*) from public.career_resume_uploads x where x.user_id = '${u}')`);
                if (found !== "0" || logged.some((l) => l.replace(/\D/g, "").includes(d))) fail(`person ${i}`, `a ${bad.family}'s number was kept: ${who()}`);
              }
            }
            bump(`bad:${bad.family}`);
          }
          const steps = role.startsWith("race") ? j.steps.slice(0, 1) : j.steps;
          for (const [k, s] of steps.entries()) {
            if (s.t === "silence") { log.push(`(silence: ${s.days} days, not replayed on the database clock)`); continue; }
            await run(s);
            if (role === "stop" && k === 0) {
              // STOP in the middle of onboarding: a fixed reply and no turn; /start brings the entries back for the yes.
              const b1 = bot.to(chat).length;
              await text(chat, "/stop"); turns++;
              if (!said(chat, b1).includes(CHANNEL_REPLIES.stop)) fail(`person ${i}`, `no STOP reply: ${who()}`);
              const back = await run({ t: "start" });
              if (m.pending && (!back.includes(CHANNEL_REPLIES.start) || !m.pending.every((e: Entry) => back.replace(/\s+/g, " ").includes(e.title)))) fail(`person ${i}`, `/start after STOP did not show the entries again: ${who()}`);
              bump("stop");
            }
          }
          if (role === "race-channels") {
            // The yes on Telegram and on the web app at the same moment (two threads of one account; the turn gate orders one
            // thread's turns, career_host_commit's version check the two threads'). Either the Telegram yes is saved, or its
            // reply says plainly that it was not and to send it again; sent again, it is saved. Then one consistent state.
            const web = h!.chat(`tok-${i}`);
            const b0 = bot.to(chat).length;
            const [tg, w] = await Promise.all([text(chat, "yes, that's my resume"), web.say("yes, that's my resume")]);
            turns += 2;
            const tgSaid = said(chat, b0);
            log.push(`yes on Telegram and on the web at once -> ${tg.status} / ${w.status} ${w.intent}/${w.resultStatus}; Telegram said: ${tgSaid.slice(0, 200).replace(/\n/g, " | ")}`);
            const facts0 = ((await state(SEEDED(i))).facts as any[]).filter((x) => x && x.source === "resume-ingest");
            if (!facts0.some((x) => x.needs_confirmation === false)) {
              if (!/couldn't save my answer to that message/.test(tgSaid) || !/send it again/i.test(tgSaid)) fail(`person ${i}`, `the Telegram yes was not saved and the reply did not say so: ${who()}`);
              bump("race-channels:refused-and-said");
              const b1 = bot.to(chat).length;
              await text(chat, "yes, that's my resume"); turns++;
              log.push(`sent again -> ${said(chat, b1).slice(0, 160).replace(/\n/g, " | ")}`);
            } else bump("race-channels:saved");
            const st = await state(SEEDED(i));
            // deno-lint-ignore no-explicit-any
            const facts = (st.facts as any[]).filter((x) => x && x.source === "resume-ingest");
            const conf = facts.filter((x) => x.needs_confirmation === false), drafts = facts.filter((x) => x.needs_confirmation === true);
            if (drafts.length) fail(`person ${i}`, `confirmed entries and drafts side by side after two yeses at once: ${who()}`);
            if (JSON.stringify(factSig(conf)) !== JSON.stringify(sig(m.pending))) fail(`person ${i}`, `two yeses at once did not confirm exactly the entries shown: ${JSON.stringify(factSig(conf))}: ${who()}`);
            if (Number(st.events) !== conf.length || conf.some((x) => !x.confirmation_event_id)) fail(`person ${i}`, `${st.events} fact_confirmed events for ${conf.length} entries: ${who()}`);
            const first = fileFor(j, j.steps[0])!;
            // the stored file is the cleaned copy (owner decision, release 8)
            if (!st.on_file || st.record?.kind !== "file" || st.record?.sha256 !== await sha256Bytes(fileKind(first.name, first.mime, first.bytes) === "docx" ? await cleanDocx(first.bytes).catch(() => first.bytes) : first.bytes)) fail(`person ${i}`, `record and profile disagree: ${JSON.stringify(st.record)}: ${who()}`);
            // deno-lint-ignore no-explicit-any
            if (JSON.stringify(factSig((st.apply as any[]).filter((x) => RESUME_KINDS.has(x.kind)))) !== JSON.stringify(sig(m.pending).filter((x) => RESUME_KINDS.has(x.split("|")[0])))) fail(`person ${i}`, `applications would be prepared from other entries after the race: ${who()}`);
            bump("race-channels");
          }
          if (role === "race-newer") {
            // A newer file and the yes at the same moment: either the first file confirmed with the newer one waiting, or
            // the newer one confirmed (the yes came after it was shown). Never a mix; the record names the confirmed file.
            const first = fileFor(j, j.steps[0])!, newer = resumeFile(rng(j.id * 7 + 2), j.bFamily, 1, j.b);
            await Promise.all([sendFile(chat, newer), text(chat, "yes")]);
            turns += 2;
            const st = await state(SEEDED(i));
            // deno-lint-ignore no-explicit-any
            const facts = (st.facts as any[]).filter((x) => x && x.source === "resume-ingest");
            const conf = factSig(facts.filter((x) => x.needs_confirmation === false)), drafts = factSig(facts.filter((x) => x.needs_confirmation === true));
            const A = sig((first.expect as { entries: Entry[] }).entries), B = sig((newer.expect as { entries: Entry[] }).entries);
            // the stored file is the cleaned copy (owner decision, release 8)
            const okA = JSON.stringify(conf) === JSON.stringify(A) && JSON.stringify(drafts) === JSON.stringify(B) && st.record?.sha256 === await sha256Bytes(fileKind(first.name, first.mime, first.bytes) === "docx" ? await cleanDocx(first.bytes).catch(() => first.bytes) : first.bytes);
            const okB = JSON.stringify(conf) === JSON.stringify(B) && drafts.length === 0 && st.record?.sha256 === await sha256Bytes(fileKind(newer.name, newer.mime, newer.bytes) === "docx" ? await cleanDocx(newer.bytes).catch(() => newer.bytes) : newer.bytes);
            const okNone = conf.length === 0 && JSON.stringify(drafts) === JSON.stringify(B) && !st.record;
            if (!okA && !okB && !okNone) fail(`person ${i}`, `a newer file and a yes at once left a mixed state: conf ${JSON.stringify(conf)} drafts ${JSON.stringify(drafts)} record ${JSON.stringify(st.record)}: ${who()}`);
            bump(okA ? "race-newer:first-confirmed" : okB ? "race-newer:newer-confirmed" : "race-newer:none");
          }
          bump(`role:${role}`);
          bump(`shape:${j.family}`);
        }
      });

      await t.step("a second person in another chat: none of the first people's records is theirs", async () => {
        const all = sample.flatMap(({ j }) => [j.a, j.b]).flatMap((p) => [p.school, p.gpa, ...p.jobs.map((x) => x.company)]);
        for (let k = 0; k < 6; k++) {
          const chat = CHAT(200 + k);
          for (const q of ["what's on my resume?", "where have I worked?", "where did I go to school?", "what's my GPA?"]) {
            const before = bot.to(chat).length;
            await text(chat, q); turns++;
            const reply = said(chat, before);
            for (const v of all) if (reply.includes(v)) fail(`second person ${k}`, `another person's ${v} read back: ${reply.slice(0, 160)}`);
          }
          const u = await userOfChat(chat);
          if (!u) { fail(`second person ${k}`, "no account"); continue; }
          const st = await state(u);
          if ((st.facts as unknown[]).length || st.on_file || st.record) fail(`second person ${k}`, `holds a record: ${JSON.stringify(st).slice(0, 200)}`);
          bump("second-person");
        }
      });

      await t.step("every message valid for Telegram; nothing left the machine", () => {
        for (const v of bot.violations) fail("Bot API", v);
        if (outbound.length) fail("network", outbound.join(", "));
        const secs = (Date.now() - started) / 1000;
        realLog.log(`[flow-onboarding-r2] ${turns} turns in ${secs.toFixed(1)} s; ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}; ${failures.length} failures`);
        if (secs > 240 && CI) fail("time", `took ${secs.toFixed(0)} s`);
        const why = [...new Set(logged.filter((l) => /not recorded|career evidence|revision|conflict|resume file/i.test(l)).map((l) => l.slice(0, 300)))].slice(0, 8);
        const kinds = new Map<string, number>();
        for (const f of failures) { const k = f.replace(/^person \d+/, "person").replace(/:.*$/s, "").slice(0, 120) + ": " + (f.split(": ")[1] ?? "").slice(0, 80); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
        if (failures.length) realLog.log(`[flow-onboarding-r2] failures by kind:\n${[...kinds].map(([k, n]) => `  ${n} ${k}`).join("\n")}`);
        assertNode.deepEqual(failures.slice(0, 30), [], `${failures.length} failures:\n${failures.slice(0, 30).join("\n")}\nhandler log:\n${why.join("\n")}`);
      });
    } finally {
      Object.assign(console, realLog);
      globalThis.fetch = realFetch;
      h?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
