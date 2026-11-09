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
import { buildResume, resumeTaskTurn, targetOf } from "../../supabase/functions/_shared/career_resume_task.ts";
import { memoryResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";

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
const CORPUS = norm(RESUME.replace(/^- /gm, "")) + " " + ["Education", "Experience", "Projects", "Leadership", "Skills", "Skills:"].join(" ").toLowerCase();
// The file must be the asked one: one page, the data analyst internship target, the person's own words and nothing else
// (every run that is not a flagged placeholder or review note comes out of their intake), the contact placeholders visible
// and flagged, no run under 10 pt, no line of the old list's roles.
function inspect(bytes: Uint8Array, what: string) {
  const pdf = readPdf(bytes);
  const text = norm(pdf.lines.join(" "));
  assertNode.equal(pdf.pages, 1, `${what}: one page`);
  assertNode.ok(/data analyst internships/.test(text), `${what}: the requested target is on the file: ${text.slice(-300)}`);
  for (const r of pdf.runs) {
    if (r.text === "•") continue;
    if (r.color === FLAG_RGB) continue;
    assertNode.ok(CORPUS.includes(norm(r.text)), `${what}: an invented line: ${JSON.stringify(r.text)}`);
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
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "CAREER_MODEL", "CAREER_TAILOR_REWRITE", "CAREER_PLANNER"];
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
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => { modelCalls++; return new Response(JSON.stringify({ id: "chatcmpl-test", model: chat.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } }); });
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      Deno.env.set("ANTHROPIC_API_KEY", ["sk", "test", "fake"].join("-"));
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
        const list = await say("find machine learning jobs");
        assertNode.ok(/reddit/i.test(list.reply), `the old list shows the Reddit ML manager role: ${list.reply}`);
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
      const linkOf = async (r: Turn) => {
        const url = /^https:\/\/\S+\/storage\/v1\/object\/sign\/career-resumes\/\S+$/m.exec(r.reply)?.[0];
        assertNode.ok(url, `a download link on its own line: ${r.reply}`);
        const res = await h!.double.fetch(new Request(url!));
        eq(res.status, 200, `the link works: ${url}`);
        return new Uint8Array(await res.arrayBuffer());
      };
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
        eq(await linkOf(r), f.bytes, "the link serves the same PDF");
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
        await linkOf(r);
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
        eq(await linkOf(r), f.bytes, "the download link serves the T3 PDF");
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
        const p = await a.say("The PDF to me.");
        inspect((await fileOf(p, A)).bytes, "the PDF to me");
        await linkOf(p);
        await nothingApplied(A);
        const d = await a.say("Can you also send the DOCX of the resume?");
        const docx = await fileOf(d, A, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        const xml = [...new TextDecoder("latin1").decode(docx.bytes).matchAll(/word\/document\.xml/g)].length;
        assertNode.ok(xml > 0 && docx.filename.endsWith(".docx"), "a real Word file");
        plain(d, "DOCX");
      });

      const b = await setup(B, "tok-b");
      await t.step("wrong: a last file for the old list's first role; T3 owns the mismatch once and makes the right file", async () => {
        const wrong = await b.say("tailor my resume");
        assertNode.ok(OLD_ROLE.test(wrong.reply), `setup: the posting tailor made a file for an old-list role (trunk's T2): ${wrong.reply.slice(0, 160)}`);
        assertNode.ok(!/parse check/i.test(wrong.reply) && /Saved as PDF and DOCX/.test(wrong.reply), `the posting tailor's reply keeps what was saved, without the parser's self-report: ${wrong.reply}`);
        const r = await b.say(T3);
        eq((r.reply.match(/wrong role/gi) ?? []).length, 1, `the mismatch owned once: ${r.reply}`);
        assertNode.ok(!/haven't started that batch|applications ready/i.test(r.reply), `no batch: ${r.reply}`);
        inspect((await fileOf(r, B)).bytes, "wrong -> T3 attachment");
        await linkOf(r);
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
const turnOn = (p: unknown, message: string) => resumeTaskTurn({ message, ctx: { profile: p }, userId: "u-r10", now: NOW, deps: { resumes: memoryResumeStore(), uploaded: async () => false } });

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
