// R10 WO-A + WO-B (owner order 2026-11-09; spec docs/architect/specs/APP-LAYER-15-FIXES.md A.2 resume turns 1-3, B.1, B.4,
// B.6, E.1, E.4, E.6): the three production turns of the resume scenario, replayed word for word through the REAL handler
// (handler-career.ts handleChat over tests/flow: real supabase-js, the PostgREST and storage double, Postgres 16 with every
// migration) with the fake model only. The person has an earlier resume intake (pasted and confirmed, no name or email ever
// given, no file kept) and an OLD job list on the thread whose roles are machine learning ones (Reddit's ML Engineering
// Manager among them). Every file is opened here with an extractor of this test's own (inflate the page streams, read the
// text operators, fonts and colours), not the product's renderer or parser:
//   t1        T1 names the target: a one-page PDF for data analyst internships, now, as an attachment and a working link;
//             never "There is no document file ... Name the role" (trunk 142-career-router.js:2058)
//   t2        T2 keeps the target: never a role "picked first from the N roles" of the old list (142:878); the specific
//             missing fact is asked as one question; no "parse check", no DOCX claimed that is not delivered
//   t3        T3 is a correction plus boundaries on the RESUME task: no batch, no apply (handler-career.ts:168/185), the
//             file again for the right target, a download link that fetches the PDF; "I haven't applied"
//   wrong     a person whose last file WAS for the wrong role (the posting tailor picked the old list's first role): T3
//             owns the mismatch once and the new file is for data analyst internships
//   send      example 4: "Send this one." with the resume and job cards showing: ONE two-choice question and no external
//             action; "The PDF to me." delivers it; "send the DOCX too" delivers a real DOCX
// Fails on trunk: t1 (no file), t2 (the Pinwheel/Reddit ML role), t3 (a batch), wrong, send.
import assertNode from "node:assert/strict";
import * as zlib from "node:zlib";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { buildResume, jobNumberOf, parseCheckWords, resumeAskOf, resumeTaskTurn, targetOf, titleShaped } from "../../supabase/functions/_shared/career_resume_task.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const FIXTURE = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
// The intake without its header: no name, email or phone was ever given (as on production: "There is no name or email").
const RESUME = FIXTURE.split("\n").slice(5).join("\n");
const T1 = "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF.";
const T2 = "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF. If a fact needs my confirmation, ask me the specific question rather than adding anything.";
const T3 = "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything.";
const A = "7b0f8f8e-6a43-4a49-9d2c-0000010a0001", B = "7b0f8f8e-6a43-4a49-9d2c-0000010a0002";
const OLD = [["reddit", "reddit", "Ads Conversion Modeling, Machine Learning Engineering Manager", "San Francisco, CA"], ["pinwheel", "Pinwheel Labs", "Machine Learning Engineer", "Remote"],
  ["quanta", "Quanta Freight", "Senior ML Engineer", "New York, NY"], ["orbit", "Orbit Data", "ML Platform Engineer", "Seattle, WA"], ["ferro", "Ferro Health", "Applied Scientist", "Boston, MA"]]
  .map(([board, company, title, location], i) => ({ key: `greenhouse:${board}:${i + 1}`, board, company, title, location, url: `https://boards.greenhouse.io/${board}/jobs/${i + 1}` }));
const FIRST = "Built a reporting dashboard in React and Python used by 200 internal users";
const SHORTER = "Built a React and Python reporting dashboard for 200 internal users";
const WARMER = "For 200 internal users, built a React and Python reporting dashboard";
const INTERNAL = /\b(parse check|runner|record|batch|PASS)\b/i;
const OLD_ROLE = /machine learning|pinwheel|quanta|orbit|ferro|applied scientist|picked first/i;

// ------------------------------------------------------------------------------------------------ this test's own PDF reader
type Run = { text: string; size: number; color: string; y: number };
function unPdfString(s: string): string {
  // WinAnsi: octal 225 is the bullet, 267 the middle dot (latin1 has them elsewhere).
  const WIN: Record<number, string> = { 0o225: "•", 0o267: "·", 0o226: "–", 0o227: "—", 0o222: "’" };
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => /^[0-7]+$/.test(c) ? WIN[parseInt(c, 8)] ?? String.fromCharCode(parseInt(c, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c);
}
function readPdf(bytes: Uint8Array): { pages: number; runs: Run[]; lines: string[] } {
  const raw = new TextDecoder("latin1").decode(bytes);
  assertNode.ok(raw.startsWith("%PDF-") && raw.trimEnd().endsWith("%%EOF"), "a PDF file");
  const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const runs: Run[] = [];
  for (const m of raw.matchAll(/<<([^>]*?\/FlateDecode[^>]*?)>>\s*stream\r?\n/g)) {
    const len = Number(/\/Length (\d+)/.exec(m[1])?.[1]);
    const start = m.index! + m[0].length;
    const ops = new TextDecoder("latin1").decode(zlib.inflateSync(bytes.subarray(start, start + len)));
    for (const bt of ops.matchAll(/BT ([\s\S]*?) ET/g)) {
      const size = Number(/\/F\d+ ([\d.]+) Tf/.exec(bt[1])?.[1]);
      const color = /([\d.]+ [\d.]+ [\d.]+) rg/.exec(bt[1])?.[1] ?? "";
      const y = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(bt[1])?.[1]);
      const text = [...bt[1].matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((x) => unPdfString(x[1])).join("");
      runs.push({ text, size, color, y });
    }
  }
  const byY = new Map<number, string[]>();
  for (const r of runs) byY.set(r.y, [...(byY.get(r.y) ?? []), r.text]);
  return { pages, runs, lines: [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([, xs]) => xs.join(" ")) };
}
const FLAG_RGB = "0.541 0.353 0"; // career_resume_design.ts FLAG #8A5A00
const norm = (s: string) => s.replace(/[•]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
// The intake as written, and with GPA left off (the person's "Leave GPA off" takes the value out, nothing else).
const CORPUS = norm(RESUME.replace(/^- /gm, "")) + " " + norm(RESUME.replace(/^- /gm, "").replace(/,\s*GPA \d\.\d+/g, "")) + " " + ["Education", "Experience", "Projects", "Leadership", "Skills", "Skills:"].join(" ").toLowerCase();
// The file must be the asked one: one page, the data analyst internship target, the person's own words and nothing else
// (every run that is not a flagged placeholder or review note comes out of their intake), the contact placeholders visible
// and flagged, no run under 10 pt, no line of the old list's roles.
function inspect(bytes: Uint8Array, what: string, approved: string[] = []) {
  const pdf = readPdf(bytes);
  const text = norm(pdf.lines.join(" "));
  assertNode.equal(pdf.pages, 1, `${what}: one page`);
  assertNode.ok(/data analyst internships/.test(text), `${what}: the requested target is on the file: ${text.slice(-300)}`);
  for (const r of pdf.runs) {
    if (r.text === "•") continue;
    if (r.color === FLAG_RGB) continue;
    assertNode.ok(CORPUS.includes(norm(r.text)) || approved.some((x) => norm(x).includes(norm(r.text))), `${what}: an invented line: ${JSON.stringify(r.text)}`);
  }
  const flagged = pdf.runs.filter((r) => r.color === FLAG_RGB).map((r) => r.text).join(" ");
  assertNode.ok(/\[your name\]/i.test(flagged) && flagged.includes("[email · phone · LinkedIn to add]"), `${what}: contact placeholders visible and flagged: ${flagged}`);
  assertNode.ok(!OLD_ROLE.test(text), `${what}: nothing of the old list's roles`);
  assertNode.ok(pdf.runs.every((r) => r.size >= 10), `${what}: readable type (no run under 10 pt): ${[...new Set(pdf.runs.map((r) => r.size))]}`);
  for (const k of ["TEST Systems Inc", "TEST University", "Python"]) assertNode.ok(text.includes(k.toLowerCase()), `${what}: ${k} from the intake`);
  assertNode.ok(text.indexOf("education") < text.indexOf("experience"), `${what}: an internship resume leads with education`);
  return pdf;
}

Deno.test({
  name: "R10 resume task: T1-T3 of the production resume scenario, example 4, through the real handler, the files opened",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "CAREER_MODEL", "CAREER_TAILOR_REWRITE", "CAREER_PLANNER", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.test'), ('${B}', 'b@example.test'); insert into public.profiles (id) values ('${A}'), ('${B}');
        insert into public.career_watch_kv (user_id, key, value) values ('${A}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${B}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      const desc = "Requirements: Machine Learning, Python, 8+ years leading teams.";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${OLD.map((p) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', '${p.title}', '${p.location}', '${p.url}', '${desc}', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${OLD.map((p, i) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', '${p.title}', '${p.location}', '${p.url}', now() - interval '${i} hours', '${desc}', 'r10old${i}')`).join(",")};`);
      h = await careerHandler(pg, { "tok-a": A, "tok-b": B });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      let modelCalls = 0;
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        // deno-lint-ignore no-explicit-any
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        // The fake model: answers nothing useful, so every turn here is the product's code.
        // The fake model: the bullet rewriter gets one scripted shorter bullet; everything else gets nothing useful.
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => {
          modelCalls++;
          const sys = String(chat.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
          const asked = String(chat.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "");
          const content = !/Rewrite one resume bullet/.test(sys) ? "{}" : /warmer/i.test(asked) && asked.includes(SHORTER) ? WARMER : SHORTER;
          return new Response(JSON.stringify({ id: "chatcmpl-test", model: chat.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
        });
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      Deno.env.set("ANTHROPIC_API_KEY", ["sk", "test", "fake"].join("-"));
      Deno.env.set("TRAINEE_FILE_BASE_URL", "https://trainee.test/file");
      Deno.env.set("TRAINEE_FILE_LINK_SECRET", "file-link-secret-0123456789-abcdef");
      const transcript: string[] = [];
      const turn = (chat: Chat, who: string) => async (m: string): Promise<Turn> => {
        await pg.sql(`delete from public.agent_rate_limits where user_id = '${who}'`);
        const r = await chat.say(m);
        assertNode.equal(r.status, 200, r.reply);
        transcript.push(`USER: ${m}\nTRAINEE [${r.intent}]: ${r.reply}\nFILES: ${JSON.stringify((r.body.artifacts ?? []).map((a: { filename: string }) => a.filename))}`);
        return r;
      };
      const setup = async (who: string, tok: string) => {
        const chat = h!.chat(tok), say = turn(chat, who);
        eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
        eq((await say("yes, that's my resume")).resultStatus, "completed");
        // The old list as the person read it (the File page link is off for this turn, so the roles are in the reply itself).
        const base = Deno.env.get("TRAINEE_FILE_BASE_URL")!;
        Deno.env.delete("TRAINEE_FILE_BASE_URL");
        const list = await say("find machine learning jobs").finally(() => Deno.env.set("TRAINEE_FILE_BASE_URL", base));
        assertNode.ok(/reddit/i.test(list.reply) && /Machine Learning Engineering Manager/.test(list.reply), `the old list shows the Reddit ML manager role: ${list.reply}`);
        const kept = await pg.sql(`select coalesce((select state->'career'->'stores'->'discovery'->'lastShortlist' from public.agent_flow_state where user_id = '${who}' and thread_id = '${chat.thread()}')::text, '[]')`);
        assertNode.ok(/reddit/i.test(kept), `the old list holds the Reddit ML manager role: ${list.reply}`);
        return { chat, say };
      };
      const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
      // The attachment's bytes (what the channel bridge sends: channel_artifacts, owner-scoped) and the link's (fetched).
      const fileOf = async (r: Turn, who: string, mime = "application/pdf") => {
        const refs = (r.body.artifacts ?? []).filter((a: { mime: string }) => a.mime === mime);
        eq(refs.length, 1, `one ${mime} attached: ${JSON.stringify(r.body.artifacts)}`);
        const b64 = await pg.sql(`select bytes_b64 from public.channel_artifacts where id = '${refs[0].ref}' and user_id = '${who}'`);
        return { bytes: Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)), filename: refs[0].filename as string };
      };
      // The privacy ruling: a link only when asked for, and only ever the signed-in File page (file/1 proves it needs the sign-in);
      // the File holds exactly the attached PDF. Never a storage link, in a reply or in the thread's saved messages.
      const linkOf = async (r: Turn, who: string) => {
        const url = /^https:\/\/trainee\.test\/file\?t=v1\.\S+$/m.exec(r.reply)?.[0];
        assertNode.ok(url, `the File page link on its own line: ${r.reply}`);
        const rec = await pg.sql(`select value->'data'->>'pdf_b64' from public.career_watch_kv where user_id = '${who}' and value->>'kind' = 'draft' and value->'data'->>'variant' = 'resume' order by updated_at desc limit 1`);
        return Uint8Array.from(atob(rec.trim()), (c) => c.charCodeAt(0));
      };
      const noLink = (r: Turn, what: string) => assertNode.ok(!/https:\/\//.test(r.reply), `${what}: no link unless asked for: ${r.reply}`);
      const noBearer = async () => eq(await pg.sql(`select count(*) from public.agent_messages where content like '%object/sign%' or content like '%storage/v1%'`), "0", "no storage link or token in any saved message");
      const nothingApplied = async (who: string) => {
        for (const table of ["career_apply_wanted", "career_apply_jobs", "career_apply_cards", "career_send_queue", "career_outreach_drafts"]) {
          eq(await pg.sql(`select count(*) from public.${table} where user_id = '${who}'`), "0", `nothing in ${table}`);
        }
      };
      const plain = (r: Turn, what: string) => {
        assertNode.ok(!INTERNAL.test(r.reply), `${what}: no internal terms or self-reports: ${r.reply}`);
        assertNode.ok(!/\battached\b/i.test(r.reply) || (r.body.artifacts ?? []).length > 0, `${what}: "attached" only with a file`);
        assertNode.ok(!/\bdocx\b/i.test(r.reply) || (r.body.artifacts ?? []).some((a: { mime: string }) => /wordprocessing/.test(a.mime)), `${what}: no DOCX claimed that is not delivered`);
        assertNode.ok(r.reply.split("\n").length <= 9, `${what}: a short reply: ${r.reply}`);
      };

      const a = await setup(A, "tok-a");
      let t1File: Uint8Array | null = null;
      await t.step("t1: the target in T1 makes the file at T1, attachment and working link", async () => {
        const r = await a.say(T1);
        assertNode.ok(!/no document file|Name the role|paste the posting/i.test(r.reply), `never "no document file ... name the role": ${r.reply}`);
        const f = await fileOf(r, A);
        inspect(f.bytes, "T1 attachment");
        noLink(r, "T1");
        t1File = f.bytes;
        assertNode.ok(/data analyst internships/i.test(r.reply) && /general/i.test(r.reply), `says it is the general data analyst internship version: ${r.reply}`);
        assertNode.ok(/original file/i.test(r.reply), `says the original file is not on hand and the saved intake was used: ${r.reply}`);
        assertNode.ok(/name and email/i.test(r.reply) && (r.reply.replace(/https:\/\/\S+/g, "").match(/\?/g) ?? []).length === 1, `one narrow question for the missing contact: ${r.reply}`);
        plain(r, "T1");
      });

      await t.step("t2: T2 keeps the target; no old-list role, no self-report", async () => {
        const r = await a.say(T2);
        assertNode.ok(!OLD_ROLE.test(r.reply), `never a role from the old list: ${r.reply}`);
        const f = await fileOf(r, A);
        inspect(f.bytes, "T2 attachment");
        noLink(r, "T2");
        assertNode.ok(/What name and email/i.test(r.reply), `asked for the specific fact, as T2 asked: ${r.reply}`);
        assertNode.ok(!/general version/i.test(r.reply), `the T1 caveat is not repeated: ${r.reply}`);
        plain(r, "T2");
        await nothingApplied(A);
      });

      await t.step("t3: the correction repairs the resume task; 'don't apply' is a boundary; the link works", async () => {
        const r = await a.say(T3);
        assertNode.ok(!/haven't started that batch|apply list|applications ready/i.test(r.reply), `no batch help: ${r.reply}`);
        assertNode.ok(!["career_batch_apply", "career_apply_queue"].includes(String(r.intent)), `not an apply turn: ${r.intent}`);
        const f = await fileOf(r, A);
        inspect(f.bytes, "T3 attachment");
        eq(await linkOf(r, A), f.bytes, "T3 asked for a link: the File page holds the T3 PDF");
        eq(f.bytes, t1File, "the same target, the same file as T1");
        assertNode.ok(/data analyst internships/i.test(r.reply) && /haven't applied/i.test(r.reply), `the target and the boundary, said: ${r.reply}`);
        assertNode.ok(!/What name and email/.test(r.reply), `the T2 question is not asked a third time: ${r.reply}`);
        plain(r, "T3");
        await nothingApplied(A);
      });

      await t.step("send: example 4, one two-choice question and no action until it is settled; then the PDF; then a real DOCX", async () => {
        const q = await a.say("Send this one.");
        eq((q.body.artifacts ?? []).length, 0, "nothing delivered or sent on an ambiguous ask");
        eq((q.reply.match(/\?/g) ?? []).length, 1, `one question: ${q.reply}`);
        assertNode.ok(/submit|apply/i.test(q.reply) && /PDF/.test(q.reply) && /\bor\b/.test(q.reply), `two concrete choices: ${q.reply}`);
        await nothingApplied(A);
        // The other answer: "Submit job 2." names the application, and nothing goes before its exact payload is reviewed.
        const sub = await a.say("Submit job 2.");
        assertNode.ok(/^This is the .+ application at .+\. Nothing has been sent/.test(sub.reply) && (sub.body.artifacts ?? []).length === 0, `submit job 2: the review sentence, nothing sent: ${sub.reply}`);
        await nothingApplied(A);
        eq((await a.say("Send this one.")).intent, "career_resume_clarify");
        const p = await a.say("The PDF to me.");
        inspect((await fileOf(p, A)).bytes, "the PDF to me");
        noLink(p, "the PDF to me");
        await nothingApplied(A);
        const d = await a.say("Can you also send the DOCX of the resume?");
        const docx = await fileOf(d, A, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        const xml = [...new TextDecoder("latin1").decode(docx.bytes).matchAll(/word\/document\.xml/g)].length;
        assertNode.ok(xml > 0 && docx.filename.endsWith(".docx"), "a real Word file");
        plain(d, "DOCX");
      });

      await t.step("continuation 1 (spec B.6): one task through six turns; what changed, GPA off, a shorter bullet shown then used, the open details, no apply", async () => {
        const c1 = await a.say("Make it more like a data analyst resume. Keep it one page.");
        inspect((await fileOf(c1, A)).bytes, "C1");
        assertNode.ok(/\babove\b/.test(c1.reply) && /one page/.test(c1.reply) && /unchanged/.test(c1.reply) && /contact details/.test(c1.reply), `C1 says what leads, one page, experience unchanged, what is still needed: ${c1.reply}`);
        plain(c1, "C1");
        const c2 = await a.say("Leave GPA off. What did you change?");
        eq((c2.body.artifacts ?? []).length, 0, "C2 explains; no file claimed");
        assertNode.ok(/\bmoved\b|kept the order/.test(c2.reply) && /did not add a new job, tool, result or credential/.test(c2.reply) && /GPA stays off/.test(c2.reply) && /placeholders/.test(c2.reply), `C2: the actual edits: ${c2.reply}`);
        const c3 = await a.say("Can you make the first bullet less wordy?");
        eq((c3.body.artifacts ?? []).length, 0, "C3 proposes; nothing regenerated");
        assertNode.ok(c3.reply.includes(`Proposed replacement: ${SHORTER}`) && c3.reply.includes(`Now: ${FIRST}`) && /\b200\b.*not accurate/.test(c3.reply), `C3: the new bullet beside the old one, the kept number named: ${c3.reply}`);
        const c4 = await a.say("That is fine, give me the PDF.");
        const pdf = inspect((await fileOf(c4, A)).bytes, "C4", [SHORTER]);
        const text = pdf.lines.join(" ");
        assertNode.ok(text.includes(SHORTER) && !text.includes(FIRST), `C4: the approved bullet is in the file: ${text}`);
        assertNode.ok(!/GPA/.test(text), `C4: GPA is off the file: ${text}`);
        assertNode.ok(/revised/.test(c4.reply) && /GPA is omitted/.test(c4.reply) && /contact placeholders still need filling/.test(c4.reply) && /review draft/.test(c4.reply), `C4: ${c4.reply}`);
        noLink(c4, "C4");
        plain(c4, "C4");
        const c5 = await a.say("Why does it still say contact details to fill in?");
        assertNode.ok(/didn't establish the contact details/.test(c5.reply) && /contact line/.test(c5.reply) && (c5.body.artifacts ?? []).length === 0, `C5: ${c5.reply}`);
        const c6 = await a.say("Now apply with it.");
        eq((c6.reply.match(/\?/g) ?? []).length, 1, `C6: one question: ${c6.reply}`);
        assertNode.ok(/Which role/.test(c6.reply) && /exact application answers/.test(c6.reply) && /contact details/.test(c6.reply), `C6: a short stop at the real decision: ${c6.reply}`);
        assertNode.ok(!/batch|apply list/i.test(c6.reply), `C6: no batch plan: ${c6.reply}`);
        await nothingApplied(A);
        // WO-H's finding: a bare follow-up right after the resume is about that resume (the current artifact), never a fresh
        // tailor. The model's rewording is audited per bullet; only what passes is shown, nothing is applied or sent.
        const warm = await a.say("Make it warmer.");
        eq(warm.intent, "career_resume_task", `"Make it warmer." stays on the resume just shown: ${warm.intent}: ${warm.reply}`);
        assertNode.ok(!/tailored for|Picked first/i.test(warm.reply) && /data analyst internships/.test(warm.reply), `the current resume, by its target: ${warm.reply}`);
        assertNode.ok(warm.reply.includes(`New: ${WARMER}`) && /^New: /m.test(warm.reply) && /^Now: /m.test(warm.reply) && (warm.body.artifacts ?? []).length === 0, `before and after shown, nothing regenerated: ${warm.reply}`);
        // Re-review of #644 (1): a rewording is shown, then a new fact is told and its question answered. The answer is kept with the
        // fact; the old rewording is never approved by it.
        const swaps = async () => await pg.sql(`select coalesce((state->'career'->'stores'->'profile'->'_resumeTask'->'swaps')::text, '[]') from public.agent_flow_state where user_id = '${A}' and thread_id = '${a.chat.thread()}'`);
        const nf = await a.say("update my resume with my new job at Acme (TEST)");
        assertNode.ok(nf.intent === "career_resume_task" && /What is your title there/.test(nf.reply) && !(nf.body.artifacts ?? []).length, `a new fact is asked about: ${nf.reply}`);
        const bare = await a.say("yes");
        assertNode.ok(bare.intent === "career_resume_task" && /What is your title at Acme \(TEST\)/.test(bare.reply) && !/Kept with/.test(bare.reply), `a bare yes is asked again: ${bare.reply}`);
        const detail = await a.say("ok, Analyst since May");
        assertNode.ok(/Analyst since May/.test(detail.reply) && !(detail.body.artifacts ?? []).length && !/revised/i.test(detail.reply), `the answer is kept, nothing approved: ${detail.reply}`);
        assertNode.ok(!(await swaps()).includes(WARMER), "the shown rewording was not approved by the answer to another question");
        const facts = await pg.sql(`select (state->'career'->'stores'->'profile'->'facts')::text from public.agent_flow_state where user_id = '${A}' and thread_id = '${a.chat.thread()}'`);
        assertNode.ok(/New job at Acme \(TEST\): Analyst since May/.test(facts) && /"status": "draft"/.test(facts), "the title is kept with the fact, unconfirmed");
        const again = await a.say("Make it warmer.");
        assertNode.ok(/^New: /m.test(again.reply), `shown again: ${again.reply}`);
        const fixed = await a.say(T3);
        assertNode.equal(fixed.intent, "career_resume_task", "the correction is the task's");
        const yesAfter = await a.say("yes");
        assertNode.ok(yesAfter.intent !== "career_resume_task" && !(await swaps()).includes(WARMER), `a yes after a target correction approves no old rewording: ${yesAfter.intent}: ${yesAfter.reply}`);
        // Review of #634 (b): a shown rewording answers only the very next turn. Another reply comes between; a plain yes is then
        // that reply's, never an approval of the old rewording, and no file is made.
        eq((await a.say("send me the resume PDF again")).intent, "career_resume_task");
        assertNode.ok(/^New: /m.test((await a.say("Make it warmer.")).reply), "a rewording is shown");
        const between = await a.say("what do you know about me?");
        assertNode.ok(between.intent !== "career_resume_task", `an unrelated turn is not the resume task's: ${between.intent}`);
        const yes = await a.say("yes, that's fine");
        assertNode.ok(yes.intent !== "career_resume_task" && (yes.body.artifacts ?? []).length === 0, `a stale rewording is never approved by a later yes: ${yes.intent}: ${yes.reply}`);
        // Round-2 re-review (1a): a search or a question after the "new job" question leaves it and runs as itself; neither is the title.
        const factTitles = async () => await pg.sql(`select coalesce(string_agg(f->>'title', ' | '), '') from public.agent_flow_state, jsonb_array_elements(state->'career'->'stores'->'profile'->'facts') f where user_id = '${A}' and thread_id = '${a.chat.thread()}'`);
        for (const [co, next] of [["Beta (TEST)", "find machine learning jobs"], ["Gamma (TEST)", "what do you know about me?"]]) {
          await a.say("Make it warmer.");
          const asked = await a.say(`update my resume with my new job at ${co}`);
          assertNode.ok(/What is your title there/.test(asked.reply), `${co}: asked: ${asked.reply}`);
          const other = await a.say(next);
          assertNode.ok(other.intent !== "career_resume_task" && !/Kept with/.test(other.reply), `"${next}" runs as itself: ${other.intent}: ${other.reply}`);
          const titles = await factTitles();
          assertNode.ok(titles.includes(`New job at ${co}`) && !titles.includes(`New job at ${co}:`), `"${next}" is not stored as the title: ${titles}`);
        }
        await nothingApplied(A);
        // The ruling on review drafts: a file printed from unconfirmed or placeholder facts never reaches the apply door. None of the
        // resume task's files is in an apply source, and the hosted apply refuses a resume it does not hold.
        const shas = (await pg.sql(`select string_agg(distinct encode(sha256(decode(bytes_b64, 'base64')), 'hex'), ',') from public.channel_artifacts where user_id = '${A}' and mime = 'application/pdf'`)).split(",").filter(Boolean);
        assertNode.ok(shas.length >= 2, "the resume task's PDFs");
        for (const sha of shas) {
          eq(await pg.sql(`select count(*) from public.career_apply_cloud_resumes where sha256 = '${sha}'`), "0", "not an apply resume");
          eq(await pg.sql(`select count(*) from public.career_resume_uploads where sha256 = '${sha}'`), "0", "not a confirmed upload");
          const door = await pg.sql(`do $$ begin perform public.career_apply_message_cloud_prepare_context('${A}', '${sha}'); raise exception 'opened'; exception when others then if sqlerrm = 'opened' then raise; end if; end $$; select 'refused'`).catch((e) => String(e));
          assertNode.ok(/refused/.test(door), `the apply door refuses the review draft: ${door}`);
        }
      });

      const b = await setup(B, "tok-b");
      await t.step("wrong: a last file for the old list's first role; T3 owns the mismatch once and makes the right file", async () => {
        // R1 (spec E.1 #11; changed from #634, where this asserted trunk's pick): a bare "tailor my resume" never takes the old
        // list's first role; it asks which role, with no file.
        const bare = await b.say("tailor my resume");
        assertNode.ok(/Which role should I tailor your resume for\?/.test(bare.reply) && !OLD_ROLE.test(bare.reply) && !(bare.body.artifacts ?? []).length, `a bare tailor asks which role: ${bare.intent}: ${bare.reply.slice(0, 200)}`);
        // The person picks the old list's first role themselves; that file is the one T3 then calls wrong.
        const wrong = await b.say("tailor my resume for the first one");
        assertNode.ok(OLD_ROLE.test(wrong.reply), `setup: the posting tailor made a file for the old list's first role: ${wrong.reply.slice(0, 160)}`);
        assertNode.ok(!/parse check/i.test(wrong.reply) && /Saved as PDF and DOCX/.test(wrong.reply), `the posting tailor's reply keeps what was saved, without the parser's self-report: ${wrong.reply}`);
        const r = await b.say(T3);
        eq((r.reply.match(/wrong role/gi) ?? []).length, 1, `the mismatch owned once: ${r.reply}`);
        assertNode.ok(!/haven't started that batch|applications ready/i.test(r.reply), `no batch: ${r.reply}`);
        const wf = await fileOf(r, B);
        inspect(wf.bytes, "wrong -> T3 attachment");
        eq(await linkOf(r, B), wf.bytes, "the File page holds the same PDF");
        await noBearer();
        plain(r, "wrong T3");
        await nothingApplied(B);
      });

      console.log(`r10-resume-task transcript:\n${transcript.join("\n\n")}\nmodel calls ${modelCalls}; refused reads: ${outbound.join("; ") || "none"}`);
      eq(outbound, [], "no network");
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});

// ------------------------------------------------------------------------------------------------ facts (fix 3), no database
// The record's own facts as written; a GPA stated twice with different values is left off the file and asked about once;
// skills read with their label still on ("Skill: Interests: Golf", the production intake's defect) print under that label;
// with nothing confirmed, the saved intake is used and said to be unconfirmed.
const NOW = Date.UTC(2026, 10, 9, 23);
function intake(extra: string, confirm: boolean) {
  const p = CareerProfile.createProfile({});
  CareerProfile.ingestResume(p, { text: RESUME + extra, fileName: "intake.txt" });
  if (confirm) for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
const turnOn = (p: unknown, message: string) => resumeTaskTurn({ message, ctx: { profile: p }, userId: "u-r10", now: NOW, deps: { uploaded: async () => false } });

Deno.test("facts/1 the target is read from the ask, the rejected role never is", () => {
  assertNode.deepStrictEqual(targetOf(T1), { role: "data analyst", level: "internship", label: "data analyst internships" });
  assertNode.deepStrictEqual(targetOf(T2)?.label, "data analyst internships");
  assertNode.deepStrictEqual(targetOf(T3)?.label, "data analyst internships");
  assertNode.equal(targetOf("send me the PDF"), null);
});

Deno.test("facts/2 two GPA values: left off the file, one narrow question; labelled skills keep their labels", async () => {
  const p = intake("\nAWARDS\nDean's List (TEST), cumulative GPA 3.4\n\nINTERESTS\nInterests: Golf, Chess\n", true);
  // As the production intake filed them: "Skill: Skills: Python", "Skill: Interests: Golf".
  const sk = p.facts.filter((f: { kind: string }) => f.kind === "skill");
  sk[0].name = "Skills: Python"; sk[1].name = "Interests: Golf";
  const b = buildResume(p, targetOf(T1)!, false);
  assertNode.deepStrictEqual(b.gpaConflict, ["3.7", "3.4"]);
  const body = b.blocks.filter((x) => !x.flag).map((x) => x.text).join(" ");
  assertNode.ok(!/GPA/.test(body), `no GPA printed while the values conflict: ${body}`);
  const r = await turnOn(p, T1);
  const pdf = readPdf(Uint8Array.from(atob(r!.documents[0].base64), (c) => c.charCodeAt(0)));
  assertNode.equal(pdf.pages, 1);
  assertNode.ok(!/GPA 3\.[47]\b/.test(pdf.runs.filter((x) => x.color !== FLAG_RGB).map((x) => x.text).join(" ")), "the file prints no GPA value");
  assertNode.equal((r!.reply.match(/Which one is right\?/g) ?? []).length, 1, r!.reply);
  const printed = pdf.lines.join(" | ");
  assertNode.ok(/Interests: Golf/.test(printed) && !/Skills?: (Interests|Skills)/.test(printed) && !/Golf.*Python|Interests: .*Python/.test(printed), `interests under their own label, not as skills: ${printed}`);
});

Deno.test("facts/3 nothing confirmed: the saved intake is used, said unconfirmed on the file and in the reply", async () => {
  const p = intake("", false);
  const r = await turnOn(p, T1);
  assertNode.ok(r && r.documents.length === 1, "a file from the saved intake");
  const pdf = readPdf(Uint8Array.from(atob(r!.documents[0].base64), (c) => c.charCodeAt(0)));
  assertNode.ok(/Facts unconfirmed; not for external submission/.test(pdf.lines.join(" ")), pdf.lines.join(" | "));
  assertNode.ok(/not yet confirmed by you/.test(r!.reply) && /Are they right as written\?/.test(r!.reply), r!.reply);
});

// R3a (D-007): with nothing confirmed the saved intake is used, but a quarantined fact (flagged, delegated, or the bank's
// F-027..F-079) is never printed.
Deno.test("facts/5 nothing confirmed, quarantined facts present: none of them is printed", async () => {
  const p = intake("", false);
  (p as any).facts.push(
    { id: "q1", kind: "experience", title: "Quant Researcher, Invented Capital (TEST)", text: "Quant Researcher, Invented Capital (TEST)", bullets: ["Built an invented trading model (TEST)"], quarantined: true, needs_confirmation: true },
    { id: "q2", kind: "project", title: "Delegated Project Zeta (TEST)", text: "Delegated Project Zeta (TEST)", bullets: [], provenance: "owner-delegated answer-all", needs_confirmation: true },
    { id: "q3", kind: "leadership", title: "Bank Fact Omega Club (TEST)", text: "Bank Fact Omega Club (TEST)", bullets: [], factId: "F-031", needs_confirmation: true });
  const built = buildResume(p, targetOf(T1)!, false);
  assertNode.ok(built.unconfirmed, "nothing confirmed");
  const r = await turnOn(p, T1);
  const pdf = readPdf(Uint8Array.from(atob(r!.documents[0].base64), (c) => c.charCodeAt(0))).lines.join(" ");
  for (const x of ["Invented Capital", "invented trading model", "Project Zeta", "Omega Club"]) {
    assertNode.ok(!built.lines.join(" ").includes(x) && !pdf.includes(x) && !r!.reply.includes(x), `${x}: never printed`);
  }
  assertNode.ok(/TEST University/.test(pdf), "the person's own intake is still used");
});

// R1 (owner readiness review): any stated target is the target, with or without a role word; an employer in front of a role is
// a posting; a bare ask states none.
Deno.test("target/1 'product management', 'consulting', 'trading', 'nursing' are targets; 'the quillstone data analyst intern role' is a posting", () => {
  for (const [ask, label] of [["make my resume a PDF for product management", "product management roles"], ["tailor my resume for consulting roles", "consulting roles"],
    ["make my resume a PDF for trading", "trading roles"], ["make my resume for nursing jobs", "nursing roles"], ["tailor my resume for product management roles", "product management roles"]] as const) {
    assertNode.equal(targetOf(ask)?.label, label, ask);
  }
  for (const ask of ["tailor my resume for the quillstone data analyst intern role", "tailor my resume", "make my resume a pdf for me", "make my resume for review"]) assertNode.equal(targetOf(ask), null, ask);
  // Round 3: a name and only a generic word is an employer: a posting, never "Resume for stripe roles". With a resume task on
  // hand it is still not the task's (142's named-firm path or the last job list answers it).
  const task = { pending: null, file: { sha256: "x", filename: "x.pdf", pages: 1, label: "data analyst internships" }, target: targetOf(T1) } as any;
  for (const ask of ["tailor my resume for the Stripe role", "make my resume for the Goldman Sachs internship", "tailor my resume for Google roles"]) {
    assertNode.equal(targetOf(ask), null, ask);
    assertNode.equal(resumeAskOf(ask, task, { companies: [], jobs: 0, posting: false, resumeShown: true }), null, `${ask}: not the resume task's`);
  }
});

Deno.test("facts/4 the task lapses after a day: an old target and an old rewording are not carried into a new ask", async () => {
  const p = intake("", true);
  const t1 = await turnOn(p, T1);
  assertNode.ok(t1 && t1.task.target.label === "data analyst internships");
  // Shown a rewording, then a day and an hour pass with no turn of the task's own.
  (p as any)._resumeTask.proposed = [{ before: "x", after: "y" }];
  (p as any)._resumeTask.at = new Date(NOW - 25 * 3600_000).toISOString();
  const late = await resumeTaskTurn({ message: "That is fine, give me the PDF.", ctx: { profile: p }, userId: "u-r10", now: NOW, deps: { uploaded: async () => false, lastIntent: async () => "career_resume_task" } });
  assertNode.equal(late, null, "an expired task answers nothing");
  assertNode.equal((p as any)._resumeTask, undefined, "and is gone");
});

// Review of #634 (c): the task takes only resume and file wording. With a task and a file on hand, each of these is someone else's.
Deno.test("routing/1 with a resume task on hand: posting links, apply corrections, other contact questions, cover letters and searches are not its", async () => {
  const p = intake("", true);
  const task = (await turnOn(p, T1))!.task;
  const view = { companies: ["reddit", "stripe"], jobs: 2, posting: false, resumeShown: true };
  const none: [string, string][] = [
    ["send me a link to the posting", "a posting link"], ["can you send the application link for job 2?", "an application link"],
    ["wrong job, apply to that other one instead", "an apply correction"], ["why do you need my contact info for the application?", "another contact question"],
    ["write me a cover letter for data analyst internships", "a cover letter"], ["make a cover letter PDF for the data analyst role", "a cover letter file"],
    ["Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.", "A.2 search turn 1"],
    ["Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.", "A.2 search turn 2"],
    ["apply with my resume to the data analyst role at Stripe", "an apply"],
  ];
  for (const [m, what] of none) assertNode.equal(resumeAskOf(m, task, view), null, `${what}: ${m}`);
  // And what stays its own.
  assertNode.equal(resumeAskOf("send a download link for the PDF, the attachment isn't opening", task, view), "link");
  assertNode.equal(resumeAskOf(T3, task, view), "correct");
  assertNode.equal(resumeAskOf("Why does it still say contact details to fill in?", task, view), "why_contact");
  // "update my resume with my new job at X": kept as an unconfirmed fact and asked about, never dropped, never printed.
  const r = await turnOn(p, "update my resume with my new job at Northwind Traders (TEST)");
  assertNode.ok(r && r.documents.length === 0 && /new job at Northwind Traders \(TEST\) as unconfirmed/.test(r.reply) && /title/.test(r.reply), r?.reply);
  const fact = (p as any).facts.find((f: { text?: string }) => /Northwind/.test(f.text ?? ""));
  assertNode.ok(fact && fact.status === "draft" && fact.needs_confirmation === true, JSON.stringify(fact));
  assertNode.ok(!buildResume(p, targetOf(T1)!, false).lines.some((l) => /Northwind/.test(l)), "an unconfirmed fact prints on no file beside confirmed ones");
});

// Review of #634 (d): every way a GPA is written is found, compared across forms and taken off whole (scale and comma included).
Deno.test("gpa/1 '3.7 GPA', 'GPA 3.7/4.0', '3.7/4.0 GPA', 'GPA of 3.7': conflicts across forms, nothing left over when it is off", () => {
  const base = buildResume(intake("", true), targetOf(T1)!, false);
  assertNode.equal(base.gpaConflict, null, "one GPA, written once: no conflict");
  for (const [form, other, conflict] of [["GPA 3.7/4.0", "3.4 GPA", true], ["3.7/4.0 GPA", "GPA of 3.7", false], ["3.70 GPA", "GPA: 3.7", false], ["GPA of 3.7", "3.5/4.0 cumulative GPA", true]] as const) {
    const p = intake(`\nAWARDS\nDean's List (TEST), ${other}\n`, true);
    for (const f of (p as any).facts) if (/TEST University/.test(f.title ?? "")) { f.title = f.title.replace("GPA 3.7", form); f.text = f.title; }
    const b = buildResume(p, targetOf(T1)!, false);
    assertNode.equal(!!b.gpaConflict, conflict, `${form} vs ${other}: ${JSON.stringify(b.gpaConflict)}`);
    const off = buildResume(p, targetOf(T1)!, false, { noGpa: true }).blocks.filter((x) => !x.flag).map((x) => x.text).join(" | ");
    assertNode.ok(!/GPA|\/4\.0|\b3\.[457]0?\b/.test(off), `leave GPA off takes every form off whole (${form}, ${other}): ${off}`);
    assertNode.ok(off.includes("| TEST University - B.S. Computer Science, graduating May 2028 |"), `the school line, whole, with nothing left over: ${off}`);
  }
});

Deno.test("scrub/1 a parser's PASS is not said; a FAIL is said in plain words", () => {
  eq0(parseCheckWords("Saved as PDF and DOCX files, attached for your review — parse check PASS."), "Saved as PDF and DOCX files, attached for your review.");
  eq0(parseCheckWords("Saved as PDF and DOCX files, attached for your review — parse check FAIL."), "Saved as PDF and DOCX files, attached for your review, but an applicant tracking system may not read it correctly, so check the file before you use it.");
});
const eq0 = (a: unknown, b: unknown) => assertNode.deepStrictEqual(a, b);

// Re-review of #644 (2): the scale is never read as the GPA, and "GPA off" leaves no "out of 4", "Cumulative" or "(4.0 scale)".
Deno.test("gpa/2 '3.8 out of 4.0 GPA' reads 3.8; every phrase comes off whole", () => {
  const forms = ["3.8 out of 4.0 GPA", "GPA 3.8 out of 4", "GPA - 3.8", "GPA – 3.8", "Cumulative GPA: 3.80", "GPA: 3.8 (4.0 scale)", "GPA 3.8/4.0", "3.8/4.0 GPA", "GPA of 3.8", "3.8 GPA"];
  for (const form of forms) {
    const p = CareerProfile.createProfile({});
    CareerProfile.ingestResume(p, { text: `EDUCATION\nTEST University - B.S. Economics, ${form}, graduating May 2028\n\nEXPERIENCE\nAnalyst, Acme (TEST), 2025\n- Did analysis (TEST)\n\nLEADERSHIP\nTreasurer, Club (TEST), 2024\n- Kept a GPA 3.8 study group going`, fileName: "x.txt" });
    for (const f of (p as any).facts) CareerProfile.confirmFact(p, f.id);
    const on = buildResume(p, targetOf(T1)!, false), off = buildResume(p, targetOf(T1)!, false, { noGpa: true });
    assertNode.equal(on.gpaConflict, null, `${form}: read as 3.8 (the same as the other line), never 4.0`);
    const school = off.lines.find((l) => /TEST University/.test(l));
    assertNode.equal(school, "TEST University - B.S. Economics, graduating May 2028", `${form}: off whole`);
  }
  const p = CareerProfile.createProfile({});
  CareerProfile.ingestResume(p, { text: `EDUCATION\nTEST University - B.S. Economics, 3.8 out of 4.0 GPA\n\nAWARDS\nDean's List (TEST), GPA 3.4\n\nEXPERIENCE\nAnalyst, Acme (TEST), 2025\n- Did analysis (TEST)`, fileName: "x.txt" });
  for (const f of (p as any).facts) CareerProfile.confirmFact(p, f.id);
  assertNode.deepEqual(buildResume(p, targetOf(T1)!, false).gpaConflict, ["3.8", "3.4"], "a real conflict names the values as written, never the scale");
});

// Round-2 re-review of #644 (2): a full stop after the value or the scale, a major and an overall value, "on a 4.0 scale", a GPA in
// parentheses, "GPA (cumulative)", "CGPA": each is read as its value and comes off whole; "3.8/4.0" with no GPA word is left alone.
Deno.test("gpa/3 'GPA 3.8.', 'GPA 3.8/4.0.', 'Major GPA 3.9, overall 3.6', '(GPA: 3.8)', 'CGPA 3.8': read right, off whole", () => {
  const cases: [string, string | null, string][] = [
    ["GPA 3.8.", "3.8", "TEST University - B.S. Economics."],
    ["GPA: 3.85. Dean's List", "3.85", "TEST University - B.S. Economics. Dean's List"],
    ["GPA 3.8/4.0.", "3.8", "TEST University - B.S. Economics."],
    ["Major GPA 3.9, overall 3.6", "3.6", "TEST University - B.S. Economics"],
    ["Major GPA 3.9, overall GPA 3.6; Dean's List", "3.6", "TEST University - B.S. Economics; Dean's List"],
    ["Overall GPA 3.6, Major GPA 3.9", "3.6", "TEST University - B.S. Economics"],
    ["GPA 3.8 on a 4.0 scale", "3.8", "TEST University - B.S. Economics"],
    ["(GPA: 3.8)", "3.8", "TEST University - B.S. Economics"],
    ["GPA (cumulative): 3.8", "3.8", "TEST University - B.S. Economics"],
    ["CGPA 3.8", "3.8", "TEST University - B.S. Economics"],
    ["3.8/4.0", null, "TEST University - B.S. Economics, 3.8/4.0"],
  ];
  for (const [form, value, offLine] of cases) {
    const p = CareerProfile.createProfile({});
    CareerProfile.ingestResume(p, { text: `EDUCATION\nTEST University - B.S. Economics, ${form}\n\nAWARDS\nHonor (TEST), GPA 3.4\n\nEXPERIENCE\nAnalyst, Acme (TEST), 2025\n- Did analysis (TEST)`, fileName: "x.txt" });
    for (const f of (p as any).facts) CareerProfile.confirmFact(p, f.id);
    const on = buildResume(p, targetOf(T1)!, false), off = buildResume(p, targetOf(T1)!, false, { noGpa: true });
    assertNode.deepEqual(on.gpaConflict, value ? [value, "3.4"] : null, `${form}: read as ${value ?? "no GPA"}`);
    assertNode.equal(off.lines.find((l) => /TEST University/.test(l)), offLine, `${form}: off whole, nothing left over`);
  }
});

// Round-2 re-review of #644 (1b): a yes approves exactly the pairs shown. Five bullets can be reworded, two are shown; the yes
// puts those two in and no other.
Deno.test("restyle/1 five rewordings, two shown: a yes changes only the two shown", async () => {
  const p = CareerProfile.createProfile({});
  CareerProfile.ingestResume(p, { text: RESUME, fileName: "r.txt" });
  for (const f of (p as any).facts) CareerProfile.confirmFact(p, f.id);
  const at = Date.parse("2026-11-09T12:00:00Z"), U = "11111111-1111-4111-8111-111111111111";
  // Each bullet loses its last word: a real rewording the audit passes (no new word, number or claim).
  const rewrite = async (b: string) => b.replace(/\s+\S+$/, "");
  const turn = (message: string) => resumeTaskTurn({ message, ctx: { profile: p }, userId: U, now: at, deps: { uploaded: async () => false, lastIntent: async () => "career_resume_task", rewrite } });
  assertNode.ok((await turn(T1))?.task.file, "the resume is made");
  const warm = await turn("Make it warmer.");
  const proposed = (p as any)._resumeTask.proposed as { before: string; after: string }[];
  assertNode.equal(proposed.length, 2, `only the shown pairs are proposed: ${warm?.reply}`);
  const shown = [...warm!.reply.matchAll(/^New: (.*)$/gm)].map((m) => m[1]);
  assertNode.deepEqual(shown, proposed.map((x) => x.after), "what is proposed is what was shown");
  assertNode.ok(Number(/(\d+) more bullets could change the same way/.exec(warm!.reply)?.[1] ?? 0) >= 3, `five or more reworded, the others named, not proposed: ${warm!.reply}`);
  const yes = await turn("yes, that's fine");
  const swaps = (p as any)._resumeTask.swaps as { before: string; after: string }[];
  assertNode.deepEqual(swaps, proposed, `the yes puts in exactly the two shown: ${yes?.reply}`);
  assertNode.ok(/2 bullets are reworded/.test(yes!.reply), yes!.reply);
});

// Round-2 re-review of #644 (1a): the "new job" question keeps only a title or role; anything else is not stored as the title.
Deno.test("fact_detail/1 a search, a question and a bare yes are never stored as the new job's title", () => {
  const task = { pending: "fact_detail", file: { sha256: "x", filename: "x.pdf", pages: 1, label: "data analyst internships" }, target: targetOf(T1) } as any;
  const view = { companies: [], jobs: 3, posting: false, resumeShown: true };
  for (const t of ["find machine learning jobs", "what do you know about me?", "search for data jobs in Boston", "send me the resume PDF"]) assertNode.notEqual(resumeAskOf(t, task, view), "fact_detail", t);
  for (const t of ["yes", "no", "Yes.", "ok"]) { assertNode.equal(resumeAskOf(t, task, view), "fact_detail", `${t}: asked again`); assertNode.equal(titleShaped(t), false, t); }
  // Round 3: one capitalised word is not a title unless it is a title word.
  for (const t of ["Thanks", "Perfect", "Great", "Cool", "Hello", "Wait", "LOL"]) assertNode.equal(titleShaped(t), false, t);
  assertNode.ok(titleShaped("Analyst"), "Analyst");
  for (const t of ["ok, Analyst since May", "Data Analyst, started June 2026", "Sous Chef", "Junior Software Engineer"]) { assertNode.equal(resumeAskOf(t, task, view), "fact_detail", t); assertNode.ok(titleShaped(t), t); }
});

// Re-review of #644 (7): a number is a job number only with a cue.
Deno.test("submit/1 'submit the 1 page version' is not job 1; 'job 2', '#2', 'number 2', 'the 2nd one' are job 2", () => {
  for (const t of ["submit the 1 page version", "submit the 1-page one", "apply with the 2 page resume"]) assertNode.equal(jobNumberOf(t), null, t);
  for (const t of ["submit job 2", "submit #2", "apply to number 2", "submit the 2nd one", "submit the second one", "submit job #2"]) assertNode.equal(jobNumberOf(t), 2, t);
});
