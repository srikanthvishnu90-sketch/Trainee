// NEW-USER ONBOARDING ROUND 4 end to end (architect, 2026-11-05; round 3: flow-scenarios-onboarding-r3.test.ts): people sampled
// from the round-4 generator (tests/architect/scenarios/onboarding-r4-generator.ts; the pure battery is
// scenarios-onboarding-r4.test.ts) sent through the REAL trainee-telegram webhook as its index.ts composes it, into the real
// agent-chat handler (handler-career.ts handleChat) on a real Postgres 16 with every migration (tests/flow/pg.ts) behind the
// PostgREST double. Telegram is a fake Bot API that also serves the files (real PDF and Word bytes, read by the product's
// own reader). No model (CAREER_BRAIN and ANTHROPIC_API_KEY unset); every other host is refused. After every message the
// reply is held to the database: it opens "Confirmed" only when a resume is on file after it.
//   disown    a file, then "oops wrong file" / "that's my friend's resume": no resume entry stays in the profile, nothing
//             on file; a later "yes, that's my resume" puts nothing on file and is not told Confirmed
//   pair      two different files sent at once (two webhooks in flight together), then "yes, that's my resume": the record
//             is one of the two files and the confirmed entries are exactly that file's, never a mix; sent one after the
//             other, the record is the second
//   older     two files, then "yes, the first one": nothing on file
//   replace   a confirmed file with an application being sent, one approved and queued and one prepared, all with it; a
//             newer file confirmed: the queued and the prepared are gone, the one being sent is still being sent, and the
//             reply says each of the three
//   names     a file named with 250 characters (the upload's own check refused it: "couldn't save it just now", for ever),
//             and a PDF named "resume.docx": both read and kept, under a name that fits, with the bytes' extension and type
//   long      a resume longer than the chat reads at once: the reply says where reading stopped; the yes confirms exactly
//             the entries shown
//   stop      a file, then STOP: the fixed reply, nothing on file; then "yes, that's my resume": on file, said Confirmed
//   major     a file, then "yes though my major isn't right": nothing confirmed, and no major "yes" read back
// One long-lived psql session for the checks (tests/flow/psql-session.ts).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { cleanDocx, sha256Bytes } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { DOCX, docxBytes, PDF, pdfBytes } from "./scenarios/onboarding-r2-generator.ts";
import { entriesOf, linesOf, person, type Person, sig } from "./scenarios/onboarding-r3-generator.ts";
import { disownPhrase, rng } from "./scenarios/onboarding-r4-generator.ts";

const CI = Deno.env.get("CI") === "true";
const SEED = 20261105;
const TOKEN = "123456:TEST-onboarding-r4-token-not-real", SECRET = "TEST_onboarding_r4_webhook_secret_0123456789";
const CHAT = (n: number) => 7760000 + n;
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const KINDS = ["disown", "pair", "older", "replace", "names", "long", "stop", "major"] as const;
type Kind = typeof KINDS[number];
const stack = (lines: string[]) => lines.filter((l) => l !== "").map((t, i) => ({ text: t, x: 72, y: 740 - i * 16 }));
const xmlEsc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.filter(Boolean).map((t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join(""));
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

Deno.test({
  name: "onboarding round 4 on Postgres: a resume disowned, two files at once, a yes for the older one, a replacement while applications are in flight, odd file names, a long resume, STOP mid-onboarding and a partial yes, through the real Telegram webhook",
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
      "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_LOGO_URL", "TRAINEE_LOGO_GUESS"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    let closeSession: (() => Promise<void>) | null = null;
    const failures: string[] = [];
    const fail = (who: string, why: string) => failures.push(`${who}: ${why}`);
    try {
      const N = 40;
      const sample = Array.from({ length: N }, (_, i) => ({ i, kind: KINDS[i % KINDS.length] as Kind }));
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const pace = virtualClock(); // the send pacing's clock (tests/flow/virtual-clock.ts): Telegram's one-a-second per chat is still computed and waited, on this clock, not the wall
      const bot = fakeBot({ token: TOKEN, now: pace.clock });
      const files = new Map<string, { bytes: Uint8Array; size: number }>();
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        // deno-lint-ignore no-explicit-any
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
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeOnb4Bot", TRAINEE_SIGNUP: "closed",
        TRAINEE_ALLOWED_CONTACTS: sample.map(({ i }) => `telegram:${CHAT(i)}`).join(","), TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh" })) Deno.env.set(k, v);
      let upd = 9000, mid = 100, fid = 0;
      const post = async (body: Record<string, unknown>) => {
        await sql("delete from public.agent_rate_limits");
        const deliverNow = deliverer(admin, Deno.env, pace);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: ++upd, ...body }) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        return { status: res.status, body: await res.text() };
      };
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      const text = (chat: number, words: string) => post({ message: { message_id: ++mid, ...from(chat), text: words } });
      const sendFile = (chat: number, bytes: Uint8Array, name: string, mime: string, unique?: string) => {
        const id = `F${++fid}`;
        files.set(id, { bytes, size: bytes.length });
        return post({ message: { message_id: ++mid, ...from(chat), document: { file_id: id, file_unique_id: unique ?? `u${id}`, file_name: name, mime_type: mime, file_size: bytes.length } } });
      };
      const userOfChat = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
      const said = (chat: number, from: number) => bot.to(chat).slice(from).map(plainOf).join("\n");
      const state = async (u: string) => JSON.parse(await sql(`select json_build_object(
        'facts', coalesce((select s.state->'career'->'stores'->'profile'->'facts' from public.agent_flow_state s where s.user_id = '${u}' order by s.updated_at desc limit 1), '[]'::jsonb),
        'on_file', public.career_resume_on_file('${u}'),
        'record', (select json_build_object('state', r.state, 'kind', r.kind, 'sha256', r.sha256) from public.career_resume_record r where r.user_id = '${u}'),
        'apply', coalesce(public.career_apply_profile_for('${u}')->'facts', '[]'::jsonb),
        'record_name', (select r.filename from public.career_resume_record r where r.user_id = '${u}'),
        'upload_names', coalesce((select json_agg(json_build_object('filename', x.filename, 'mime', x.mime) order by x.created_at) from public.career_resume_uploads x where x.user_id = '${u}'), '[]'::json),
        'driving', (select count(*) from public.career_apply_jobs where user_id = '${u}' and state = 'driving'),
        'optout', (select count(*) from public.channel_contacts c where c.user_id = '${u}' and c.opted_out),
        'uploads', (select count(*) from public.career_resume_uploads where user_id = '${u}'),
        'turns', (select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and m.role = 'user'),
        'prepared', (select count(*) from public.career_apply_prepared where user_id = '${u}'),
        'jobs', (select count(*) from public.career_apply_jobs where user_id = '${u}' and state = 'queued'))`));
      // deno-lint-ignore no-explicit-any
      const resumeFacts = (st: any) => (st.facts as any[]).filter((x) => x && x.source === "resume-ingest");
      // deno-lint-ignore no-explicit-any
      const confirmed = (st: any) => resumeFacts(st).filter((x) => x.needs_confirmation === false);
      const counts: Record<string, number> = {};
      const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
      let turns = 0;
      const anywhere = async (u: string, needle: string) => Number(await sql(`select (select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and position(${pgLit(needle)} in m.content) > 0)
        + (select count(*) from public.agent_flow_state s where s.user_id = '${u}' and position(${pgLit(needle)} in s.state::text) > 0)
        + (select count(*) from public.career_events e where e.user_id = '${u}' and position(${pgLit(needle)} in e.detail::text || coalesce(e.subject, '')) > 0)`));

      await t.step(`${N} people through the Telegram webhook`, async () => {
        for (const { i, kind } of sample) {
          const chat = CHAT(i), r = rng(SEED + 100 + i);
          // Each kind runs five times; its two variants alternate (v would give one kind one variant only).
          const v = Math.floor(i / KINDS.length) % 2;
          const log: string[] = [];
          const who = () => `person ${i} (${kind})\n      ${log.join("\n      ")}`;
          // After every message: a reply that opens "Confirmed" has a resume on file behind it.
          const told = async (s: string) => {
            if (!/^\s*Confirmed\b/m.test(s)) return;
            const u = await userOfChat(chat);
            if (!u || !(await state(u)).on_file) fail(`person ${i}`, `told Confirmed with no resume on file: ${who()}`);
          };
          const say = async (w: string) => { const b = bot.to(chat).length; const res = await text(chat, w); turns++; const s = said(chat, b); log.push(`${JSON.stringify(w.slice(0, 50))} -> ${res.status}: ${s.slice(0, 200).replace(/\n/g, " | ")}`); await told(s); return s; };
          const file = async (bytes: Uint8Array, name: string, mime: string) => { const b = bot.to(chat).length; const res = await sendFile(chat, bytes, name, mime); turns++; const s = said(chat, b); log.push(`file ${JSON.stringify(name.slice(0, 40))} -> ${res.status}: ${s.slice(0, 200).replace(/\n/g, " | ")}`); await told(s); return s; };
          const p: Person = person(r, { gpa: true, date: true });
          const q: Person = other(r, p);
          const lines = linesOf(p);
          if (kind === "disown") {
            await file(v ? pdfBytes(stack(lines)) : docxOf(lines), v ? "resume.pdf" : "resume.docx", v ? PDF : DOCX);
            const d = disownPhrase(r).text;
            const reply = await say(d);
            const u = await userOfChat(chat);
            const st = await state(u);
            if (resumeFacts(st).length || st.on_file || st.record) fail(`person ${i}`, `the disowned resume is still in the profile or on file (${resumeFacts(st).length} entries): ${who()}`);
            if (!/set aside/.test(reply) || !/nothing from it is on your record/.test(reply)) fail(`person ${i}`, `the person was not told the resume was set aside: ${who()}`);
            const y = await say("yes, that's my resume");
            const st2 = await state(u);
            if (st2.on_file || st2.record || resumeFacts(st2).length || /^\s*Confirmed\b/m.test(y)) fail(`person ${i}`, `a yes after the disown put it on file (or was told Confirmed): ${who()}`);
          } else if (kind === "pair") {
            const a = pdfBytes(stack(lines)), b = docxOf(linesOf(q));
            if (v) await Promise.all([file(a, "resume-a.pdf", PDF), file(b, "resume-b.docx", DOCX)]);
            else { await file(a, "resume-a.pdf", PDF); await file(b, "resume-b.docx", DOCX); }
            await say("yes, that's my resume");
            const u = await userOfChat(chat);
            const st = await state(u);
            // the stored file is the cleaned copy (owner decision, release 8)
            const shaA = await sha256Bytes(a), shaB = await sha256Bytes(await cleanDocx(b));
            const conf = factSig(confirmed(st));
            const isA = same(conf, sig(entriesOf(p))), isB = same(conf, sig(entriesOf(q)));
            if (st.on_file) {
              if (!(isA && st.record?.sha256 === shaA) && !(isB && st.record?.sha256 === shaB)) fail(`person ${i}`, `the record and the confirmed entries are not one and the same file: record ${st.record?.sha256?.slice(0, 12)} (A ${shaA.slice(0, 12)}, B ${shaB.slice(0, 12)}), entries ${JSON.stringify(conf)}: ${who()}`);
              if (v === 0 && st.record?.sha256 !== shaB) fail(`person ${i}`, `one after the other, the record is not the second file: ${who()}`);
            } else if (v === 0) fail(`person ${i}`, `one after the other, the yes put nothing on file: ${who()}`);
            if (conf.length && !isA && !isB) fail(`person ${i}`, `the confirmed entries mix the two resumes: ${JSON.stringify(conf)}: ${who()}`);
          } else if (kind === "older") {
            await file(pdfBytes(stack(lines)), "resume-old.pdf", PDF);
            await file(docxOf(linesOf(q)), "resume-new.docx", DOCX);
            const y = await say(r.pick(["yes, the first one", "the first one is mine", "yes to the first resume"]));
            const st = await state(await userOfChat(chat));
            if (st.on_file || st.record || confirmed(st).length || /^\s*Confirmed\b/m.test(y)) fail(`person ${i}`, `a yes for the older resume put something on file: ${who()}`);
          } else if (kind === "replace") {
            const a = pdfBytes(stack(lines));
            await file(a, "resume.pdf", PDF);
            await say("yes, that's my resume");
            const u = await userOfChat(chat);
            const shaA = await sha256Bytes(a);
            const pl = (co: string) => JSON.stringify({ resume_sha256: shaA, company: co }).replace(/'/g, "''");
            const ins = await sql(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token)
              values ('${u}', 'job-r4-send-${i}', 'Kestrel Freight (TEST)', 'https://example.test/jobs/s${i}', '${pl("Kestrel Freight (TEST)")}'::jsonb, encode(sha256('${pl("Kestrel Freight (TEST)")}'::bytea), 'hex'), encode(sha256('${pl("Kestrel Freight (TEST)")}'::bytea), 'hex'), 'driving', 1, now(), gen_random_uuid()),
                ('${u}', 'job-r4-queue-${i}', 'Juniper Bank (TEST)', 'https://example.test/jobs/q${i}', '${pl("Juniper Bank (TEST)")}'::jsonb, encode(sha256('${pl("Juniper Bank (TEST)")}'::bytea), 'hex'), encode(sha256('${pl("Juniper Bank (TEST)")}'::bytea), 'hex'), 'queued', 0, null, null);
              insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
              values ('${u}', 'job-r4-prep-${i}', 'Brightline Analytics (TEST)', 'https://example.test/jobs/p${i}', '${pl("Brightline Analytics (TEST)")}'::jsonb, encode(sha256('${pl("Brightline Analytics (TEST)")}'::bytea), 'hex'), array['TEST card'], 'ready'); select 'ok'`).catch((e) => `refused: ${(e as Error).message.slice(0, 200)}`);
            if (!ins.endsWith("ok")) { fail(`person ${i}`, `could not set up applications with the confirmed resume: ${ins}`); continue; }
            const b = docxOf(linesOf(q));
            await file(b, "resume-new.docx", DOCX);
            const mid0 = await state(u);
            if (Number(mid0.jobs) !== 1 || Number(mid0.prepared) !== 1 || Number(mid0.driving) !== 1) fail(`person ${i}`, `a newer resume not yet confirmed stopped something: ${JSON.stringify({ jobs: mid0.jobs, prepared: mid0.prepared, driving: mid0.driving })}: ${who()}`);
            const y = await say("yes, that's my resume");
            const st = await state(u);
            // the stored file is the cleaned copy (owner decision, release 8)
            if (st.record?.sha256 !== await sha256Bytes(await cleanDocx(b))) fail(`person ${i}`, `the new resume is not the record: ${who()}`);
            if (Number(st.jobs) !== 0 || Number(st.prepared) !== 0 || Number(st.driving) !== 1) fail(`person ${i}`, `not exactly the queued and the prepared stopped: ${JSON.stringify({ jobs: st.jobs, prepared: st.prepared, driving: st.driving })}: ${who()}`);
            if (!/1 approved application that hadn't gone out yet was made with your earlier resume, so it is cancelled \(Juniper Bank \(TEST\)\)/.test(y)) fail(`person ${i}`, `the cancelled approval was not said: ${who()}`);
            if (!/1 prepared application made with your earlier resume is discarded/.test(y)) fail(`person ${i}`, `the discarded preparation was not said: ${who()}`);
            if (!/1 application is being sent right now with your earlier resume and can't be stopped/.test(y)) fail(`person ${i}`, `the application being sent with the old resume was not said: ${who()}`);
            if (/nothing from that one is used any more/.test(y)) fail(`person ${i}`, `told nothing from the old resume is used while one is being sent: ${who()}`);
          } else if (kind === "names") {
            const long = `${"My Resume Final Version ".repeat(11).trim()}.pdf`;
            const nm = v ? long : "resume.docx";
            const up = await file(pdfBytes(stack(lines)), nm, v ? PDF : DOCX);
            if (/couldn't save it/.test(up) || !up.includes(p.edus[0].line)) fail(`person ${i}`, `the file was not read and kept: ${who()}`);
            await say("yes, that's my resume");
            const st = await state(await userOfChat(chat));
            // deno-lint-ignore no-explicit-any
            const un = (st.upload_names as any[])[0] ?? {};
            const name = String(st.record_name ?? "");
            if (!st.on_file || !name.endsWith(".pdf") || name.length > 200 || /[\/\\\n]/.test(name)) fail(`person ${i}`, `the record's file name does not fit or is not a PDF's: ${JSON.stringify(name)}: ${who()}`);
            if (un.mime !== "application/pdf" || !String(un.filename).endsWith(".pdf")) fail(`person ${i}`, `the upload is not kept as the PDF it is: ${JSON.stringify(un)}: ${who()}`);
          } else if (kind === "long") {
            // A long summary on top (a section not read into entries), then the resume, then more projects than fit: the text
            // passes 4,000 characters while what is shown stays short (the flow database counts bytes: tests/db/run.sh).
            const l2 = lines.slice(0, 2);
            l2.push("", "SUMMARY");
            for (let k = 0; k < 34; k++) l2.push(`Analyst who likes clean data and clear writing; sentence ${k + 1} of a long summary written for TEST.`);
            l2.push(...lines.slice(2).filter((l) => l !== "SKILLS" && !lines.slice(-1).includes(l)));
            l2.push("", "PROJECTS");
            for (let k = 0; k < 24; k++) l2.push(`Fixture Project ${k + 1} (TEST)`, `- Built part ${k + 1} of a TEST pipeline`);
            l2.push("", "SKILLS", lines[lines.length - 1]);
            const up = await file(docxOf(l2), "resume-long.docx", DOCX);
            if (!/longer than the 4,000 characters I can read at once, so I read it only up to/.test(up)) fail(`person ${i}`, `a resume cut to what the chat reads was not said to be cut: ${who()}`);
            const u = await userOfChat(chat);
            const drafts = factSig(resumeFacts(await state(u)));
            await say("yes, that's my resume");
            const st = await state(u);
            const conf = factSig(confirmed(st));
            if (!st.on_file || !same(conf, drafts)) fail(`person ${i}`, `the yes did not confirm exactly the entries shown: ${conf.length} vs ${drafts.length}: ${who()}`);
            const fileText = l2.join("\n");
            // deno-lint-ignore no-explicit-any
            for (const f of confirmed(st) as any[]) if (!fileText.includes(titleOf(f))) fail(`person ${i}`, `a confirmed entry is not in the file: ${titleOf(f)}`);
          } else if (kind === "stop") {
            await file(v ? pdfBytes(stack(lines)) : docxOf(lines), v ? "resume.pdf" : "resume.docx", v ? PDF : DOCX);
            const s = await say(v ? "STOP" : "/stop");
            const u = await userOfChat(chat);
            const st = await state(u);
            if (!/unsubscribed/i.test(s) || st.on_file || Number(st.optout) < 1) fail(`person ${i}`, `STOP mid-onboarding: not the fixed reply, not opted out, or something on file: ${who()}`);
            const y = await say("yes, that's my resume");
            const st2 = await state(u);
            if (!st2.on_file || !same(factSig(confirmed(st2)), sig(entriesOf(p))) || !/^\s*Confirmed\b/m.test(y)) fail(`person ${i}`, `after STOP, "yes, that's my resume" did not put exactly the resume on file and say so: ${who()}`);
          } else if (kind === "major") {
            await file(pdfBytes(stack(lines)), "resume.pdf", PDF);
            await say(r.pick(["yes though my major isn't right", "yes but my major is wrong"]));
            const u = await userOfChat(chat);
            const st = await state(u);
            if (st.on_file || confirmed(st).length) fail(`person ${i}`, `a partial yes put something on file: ${who()}`);
            const m = await say("what's my major?");
            if (/study (?:yes|wrong)\b/i.test(m) || await anywhere(u, "you study yes") || await anywhere(u, "you study wrong")) fail(`person ${i}`, `a reply word was recorded as their major: ${who()}`);
          }
          bump(kind);
        }
      });

      await t.step("every message valid for Telegram; nothing left the machine", () => {
        for (const v of bot.violations) fail("Bot API", v);
        if (outbound.length) fail("network", outbound.join(", "));
        const secs = (Date.now() - started) / 1000;
        realLog.log(`[flow-onboarding-r4] ${turns} turns in ${secs.toFixed(1)} s; ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}; ${failures.length} failures`);
        const why = [...new Set(logged.filter((l) => /not recorded|career evidence|revision|conflict|resume file|error/i.test(l)).map((l) => l.slice(0, 300)))].slice(0, 8);
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
const pgLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
// A second, different person's resume: no entry in common with the first.
function other(r: ReturnType<typeof rng>, p: Person): Person {
  const have = new Set(sig(entriesOf(p)));
  for (let k = 0; k < 40; k++) { const q = person(r, { gpa: true, date: true }); if (!sig(entriesOf(q)).some((x) => have.has(x))) return q; }
  const q = person(r, { gpa: true, date: true });
  q.skills = ["Rust"];
  return q;
}
