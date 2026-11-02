// NEW-USER ONBOARDING ROUND 3 end to end (architect, 2026-11-01; round 2: flow-scenarios-onboarding-r2.test.ts, #317): people
// sampled from the round-3 generator (tests/architect/scenarios/onboarding-r3-generator.ts; the pure battery is
// scenarios-onboarding-r3.test.ts) sent through the REAL trainee-telegram webhook as its index.ts composes it, into the
// real agent-chat handler (handler-career.ts handleChat) on a real Postgres 16 with every migration (tests/flow/pg.ts)
// behind the PostgREST double. Telegram is a fake Bot API that also serves the files (real PDF and Word bytes, read by the
// product's own reader). No model (CAREER_BRAIN and OPENAI_API_KEY unset); every other host is refused.
//   pair      the same resume as a PDF and as the .docx it came from, seconds apart, then the PDF again, then the yes: the
//             record names the PDF (the file whose message showed the entries last), not the .docx
//   fix       after the yes, "actually I graduated 2023" / "my GPA is 3.8": exactly that value changes in the profile and
//             in what every application is prepared from (career_apply_profile_for), confirmed, with a fact_confirmed
//             event of its own; the record (the file) is unchanged
//   name      "my name is X", then a resume headed by someone else's name: a bare yes puts nothing on file; "yes, that's my
//             resume" does
//   inject    a file with a line addressed to an AI in another language or by name: in no table; nothing confirmed by it
//   secret    a pasted resume with a password or an SSN: in no table and no reply
//   damaged   a broken .docx: said to be damaged, nothing stored, no turn
//   replace   a confirmed resume with a prepared application bound to its file; a newer resume shown (nothing moves), then
//             confirmed: the application is gone, the old file's entries gone from what applications are prepared from
// One long-lived psql session for the checks (tests/flow/psql-session.ts).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { FILE_DAMAGED_REPLY, sha256Bytes } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { ENTRY_CORRECTION_VIA } from "../../supabase/functions/_shared/career_router_evidence.ts";
import { DOCX, docxBytes, PDF, pdfBytes } from "./scenarios/onboarding-r2-generator.ts";
import { entriesOf, INJECTIONS_R3, linesOf, OTHER_FIRST, person, type Person, rng, sig } from "./scenarios/onboarding-r3-generator.ts";

const CI = Deno.env.get("CI") === "true";
const SEED = 20261101;
const TOKEN = "123456:TEST-onboarding-r3-token-not-real", SECRET = "TEST_onboarding_r3_webhook_secret_0123456789";
const CHAT = (n: number) => 7750000 + n;
const RESUME_KINDS = new Set(["experience", "education", "project", "leadership", "certification"]);
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const KINDS = ["pair", "fix", "name", "inject", "secret", "damaged", "replace"] as const;
type Kind = typeof KINDS[number];
const stack = (lines: string[]) => lines.filter((l) => l !== "").map((t, i) => ({ text: t, x: 72, y: 740 - i * 16 }));
const xmlEsc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.filter(Boolean).map((t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join(""));

Deno.test({
  name: "onboarding round 3 on Postgres: two files with one text, corrections after the yes, someone else's resume, AI lines, secrets, damaged files and a replaced resume, through the real Telegram webhook",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
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
      const N = 42;
      const sample = Array.from({ length: N }, (_, i) => ({ i, kind: KINDS[i % KINDS.length] as Kind }));
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const bot = fakeBot({ token: TOKEN, now: Date.now });
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
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeOnbBot", TRAINEE_SIGNUP: "closed",
        TRAINEE_ALLOWED_CONTACTS: sample.map(({ i }) => `telegram:${CHAT(i)}`).join(","), TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh" })) Deno.env.set(k, v);
      let upd = 9000, mid = 100, fid = 0;
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
        'fixEvents', (select count(*) from public.career_events e where e.user_id = '${u}' and e.kind = 'fact_confirmed' and e.detail->>'via' = '${ENTRY_CORRECTION_VIA}'),
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
          const log: string[] = [];
          const who = () => `person ${i} (${kind})\n      ${log.join("\n      ")}`;
          const say = async (w: string) => { const b = bot.to(chat).length; const res = await text(chat, w); turns++; const s = said(chat, b); log.push(`${JSON.stringify(w.slice(0, 50))} -> ${res.status}: ${s.slice(0, 160).replace(/\n/g, " | ")}`); return s; };
          const file = async (bytes: Uint8Array, name: string, mime: string, unique?: string) => { const b = bot.to(chat).length; const res = await sendFile(chat, bytes, name, mime, unique); turns++; const s = said(chat, b); log.push(`file ${name} -> ${res.status}: ${s.slice(0, 160).replace(/\n/g, " | ")}`); return s; };
          const p: Person = person(r, { gpa: true, date: true });
          const lines = linesOf(p);
          if (kind === "pair") {
            // The same text as a PDF and as a .docx, seconds apart, then the PDF again; the yes binds to the PDF.
            const pdf = pdfBytes(stack(lines)), docx = docxOf(lines);
            await file(pdf, "resume.pdf", PDF, `uA${i}`);
            await file(docx, "resume.docx", DOCX, `uB${i}`);
            await file(pdf, "resume.pdf", PDF, `uA${i}`);
            await say("yes, that's my resume");
            const st = await state(await userOfChat(chat));
            if (st.record?.kind !== "file" || st.record?.sha256 !== await sha256Bytes(pdf)) fail(`person ${i}`, `the record does not name the file whose message showed the entries (the PDF sent again): ${JSON.stringify(st.record)} want ${await sha256Bytes(pdf)} (the .docx is ${await sha256Bytes(docx)}): ${who()}`);
            if (JSON.stringify(factSig(confirmed(st))) !== JSON.stringify(sig(entriesOf(p)))) fail(`person ${i}`, `the confirmed entries are not the resume's: ${JSON.stringify(factSig(confirmed(st)))}: ${who()}`);
          } else if (kind === "fix") {
            await file(i % 2 ? pdfBytes(stack(lines)) : docxOf(lines), i % 2 ? "resume.pdf" : "resume.docx", i % 2 ? PDF : DOCX);
            await say("yes, that's my resume");
            const u = await userOfChat(chat);
            const st0 = await state(u);
            const field = i % 3 === 0 ? "gpa" : "grad";
            const to = field === "gpa" ? "3.97" : "2031";
            const before = p.edus[0].line;
            const ds = before.match(/\b(?:(?:jan|may|june|aug|dec|december|spring|fall)\w*\.?\s+)?(?:\d{1,2}\/)?(?:19|20)\d\d\b/gi) ?? [];
            const gpa = /\bGPA:?\s*([0-4]\.\d{1,2})\b|\b([0-4]\.\d{1,2})\s*GPA\b/i.exec(before);
            const old = field === "gpa" ? (gpa![1] || gpa![2]) : ds[ds.length - 1];
            const after = before.replace(old, to);
            const reply = await say(field === "gpa" ? `actually my GPA is ${to}` : `actually I graduated ${to}`);
            const st = await state(u);
            const conf = confirmed(st);
            const want = factSig(confirmed(st0)).map((x) => x === `education|${before}` ? `education|${after}` : x).sort();
            if (JSON.stringify(factSig(conf)) !== JSON.stringify(want)) fail(`person ${i}`, `not exactly that value changed: ${JSON.stringify(factSig(conf))} want ${JSON.stringify(want)}: ${who()}`);
            // deno-lint-ignore no-explicit-any
            const f = conf.find((x: any) => x.title === after);
            if (!f || !/owner corrected in chat/.test(String(f.provenance)) || !f.confirmation_event_id || Number(st.fixEvents) !== 1) fail(`person ${i}`, `the correction is not confirmed with its own event (events ${st.fixEvents}): ${JSON.stringify(f ?? null).slice(0, 300)}: ${who()}`);
            // deno-lint-ignore no-explicit-any
            const apply = factSig((st.apply as any[]).filter((x) => RESUME_KINDS.has(x.kind)));
            if (!apply.includes(`education|${after}`) || apply.includes(`education|${before}`)) fail(`person ${i}`, `applications are not prepared from the corrected entry: ${JSON.stringify(apply)}: ${who()}`);
            if (!st.on_file || st.record?.sha256 !== st0.record?.sha256) fail(`person ${i}`, `the resume on file moved with a correction: ${JSON.stringify(st.record)} was ${JSON.stringify(st0.record)}: ${who()}`);
            if (!reply.includes(after)) fail(`person ${i}`, `the reply does not show the corrected entry: ${who()}`);
          } else if (kind === "name") {
            await say(`my name is ${p.name}`);
            const other = `${r.pick(OTHER_FIRST)} Otherperson`;
            const up = await file(pdfBytes(stack(linesOf(p, other))), "resume.pdf", PDF);
            if (!up.includes(`The name at the top of this resume is “${other}”`)) fail(`person ${i}`, `someone else's name at the top was not said: ${who()}`);
            await say("yes");
            const u = await userOfChat(chat);
            const st1 = await state(u);
            if (st1.on_file || confirmed(st1).length || st1.record) fail(`person ${i}`, `a bare yes put someone else's resume on file: ${who()}`);
            await say("yes, that's my resume");
            const st2 = await state(u);
            if (!st2.on_file || JSON.stringify(factSig(confirmed(st2))) !== JSON.stringify(sig(entriesOf(p)))) fail(`person ${i}`, `a yes that says it is theirs did not put it on file: ${who()}`);
            if ((await say("what's my name?")).includes(other.split(" ")[0])) fail(`person ${i}`, `the name at the top became theirs: ${who()}`);
          } else if (kind === "inject") {
            const inj = INJECTIONS_R3[i % INJECTIONS_R3.length].line;
            const l2 = lines.slice();
            l2.splice(l2.indexOf("EXPERIENCE") + 1, 0, inj);
            const up = await file(i % 2 ? pdfBytes(stack(l2)) : docxOf(l2), i % 2 ? "resume.pdf" : "resume.docx", i % 2 ? PDF : DOCX);
            if (!/addressed to an AI/.test(up)) fail(`person ${i}`, `the person was not told the AI's line was left out: ${who()}`);
            const u = await userOfChat(chat);
            if (confirmed(await state(u)).length) fail(`person ${i}`, `the AI's line confirmed something: ${who()}`);
            await say("yes, that's my resume");
            const core = inj.replace(/[­​⁠]/g, "").slice(0, 20);
            const st = await state(u);
            if (resumeFacts(st).some((x) => JSON.stringify(x).replace(/[­​⁠]/g, "").includes(core))) fail(`person ${i}`, `the AI's line is on the record: ${who()}`);
          } else if (kind === "secret") {
            const pw = ["Tr0ub", String(r.int(10, 99)), "!q"].join(""), ssn = `${r.int(100, 899)}-${r.int(10, 99)}-${r.int(1000, 9999)}`;
            const l2 = lines.slice();
            l2.splice(l2.findIndex((l) => l.startsWith("- ")) + 1, 0, i % 2 ? `- Portal password: ${pw}` : `SSN ${ssn}`);
            const v = i % 2 ? pw : ssn;
            const reply = await say(`here is my resume:\n${l2.join("\n")}`);
            // The password as written; the SSN as its nine digits in a row (however it is spaced).
            if (reply.includes(v) || (i % 2 === 0 && reply.replace(/[\s-]/g, "").includes(v.replace(/-/g, "")))) fail(`person ${i}`, `the secret is in the reply: ${who()}`);
            const u = await userOfChat(chat);
            if (await anywhere(u, v)) fail(`person ${i}`, `the secret was kept: ${who()}`);
            if (logged.some((l) => l.includes(v))) fail(`person ${i}`, `the secret is in the log: ${who()}`);
          } else if (kind === "damaged") {
            const full = docxOf(lines);
            await say("hi");
            const u = await userOfChat(chat);
            const st0 = await state(u);
            const reply = await file(full.subarray(0, Math.floor(full.length / 2)), "resume.docx", DOCX);
            if (reply.trim() !== FILE_DAMAGED_REPLY) fail(`person ${i}`, `a broken .docx was not said to be damaged: ${who()}`);
            const st = await state(u);
            if (Number(st.uploads) !== 0 || Number(st.turns) !== Number(st0.turns)) fail(`person ${i}`, `a broken file was stored (${st.uploads}) or ran a turn: ${who()}`);
          } else if (kind === "replace") {
            const a = pdfBytes(stack(lines));
            await file(a, "resume.pdf", PDF);
            await say("yes, that's my resume");
            const u = await userOfChat(chat);
            const shaA = await sha256Bytes(a);
            // An application prepared (not yet approved) and one approved and queued, each carrying the first resume.
            const payload = JSON.stringify({ resume_sha256: shaA, company: "Brightline Analytics (TEST)" }).replace(/'/g, "''");
            const ins = await sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
              values ('${u}', 'job-r3-${i}', 'Brightline Analytics (TEST)', 'https://example.test/jobs/${i}', '${payload}'::jsonb, encode(sha256('${payload}'::bytea), 'hex'), array['TEST card'], 'ready') returning 'ok'`).catch((e) => `refused: ${(e as Error).message.slice(0, 160)}`);
            if (ins !== "ok") { fail(`person ${i}`, `could not set up a prepared application with the confirmed resume: ${ins}`); continue; }
            const q = Person2(r);
            const b = docxOf(linesOf(q));
            await file(b, "resume-new.docx", DOCX);
            const mid = await state(u);
            if (Number(mid.prepared) !== 1 || mid.record?.sha256 !== shaA) fail(`person ${i}`, `a newer resume not yet confirmed moved what is on file: ${JSON.stringify(mid.record)} prepared ${mid.prepared}: ${who()}`);
            await say("yes, that's my resume");
            const st = await state(u);
            if (st.record?.sha256 !== await sha256Bytes(b)) fail(`person ${i}`, `the new resume is not the record: ${who()}`);
            if (Number(st.prepared) !== 0) fail(`person ${i}`, `an application prepared with the replaced resume is still there to approve: ${who()}`);
            // deno-lint-ignore no-explicit-any
            const apply = factSig((st.apply as any[]).filter((x) => RESUME_KINDS.has(x.kind)));
            const wantApply = sig(entriesOf(q)).filter((x) => RESUME_KINDS.has(x.split("|")[0]));
            if (JSON.stringify(apply) !== JSON.stringify(wantApply)) fail(`person ${i}`, `applications would be prepared from the replaced resume's entries: ${JSON.stringify(apply)} want ${JSON.stringify(wantApply)}: ${who()}`);
          }
          bump(kind);
        }
      });

      await t.step("every message valid for Telegram; nothing left the machine", () => {
        for (const v of bot.violations) fail("Bot API", v);
        if (outbound.length) fail("network", outbound.join(", "));
        const secs = (Date.now() - started) / 1000;
        realLog.log(`[flow-onboarding-r3] ${turns} turns in ${secs.toFixed(1)} s; ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}; ${failures.length} failures`);
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
// A second, different person's resume (the replacement): other schools, jobs and skills than the first.
function Person2(r: ReturnType<typeof rng>): Person {
  for (let k = 0; k < 20; k++) { const q = person(r, { gpa: true, date: true }); if (q.edus[0].line) return q; }
  return person(r);
}
