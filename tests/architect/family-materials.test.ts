// FAMILY: APPLICATION MATERIALS (AM-01, AM-02, AM-03; 2026-10-26). A brand-new person, typing the way people type, gets
// a tailored resume through the REAL handler (handleChat, supabase/functions/agent-chat/handler-career.ts) on real
// Postgres (CI's migration order) with the real supabase-js client; the only seams are the HTTP hop to the Supabase
// project (tests/flow/postgrest.ts) and a fake Anthropic endpoint (no spend). Every assertion reads state: the rows in
// channel_artifacts, the bytes in them parsed back (PDF and DOCX), the model calls made, the reply against that state.
//
//   (1) "tailor it for this Ramp frontend intern role": the reply's "Saved as PDF and DOCX files, attached" is what is
//       stored and attached (two owner-scoped rows, the bytes' sha256 recorded); both files parse back to the same
//       lines; every line is the person's own confirmed words; no internal note (the eligibility verdict) is printed on
//       the page; the file is not called Resume_Resume.pdf. Another person cannot read the file by its ref.
//   (2) Change of mind ("actually do the Quillstone data analyst one instead"): a second version is stored beside the
//       first, cut for the other posting; "send me the pdf again" sends the newer one, byte for byte.
//   (3) Invented facts: with the rewrite on, the model's rewrites that add an employer, a number or a date are refused,
//       never reach either file, and the reply says why; the faithful rewrite reaches both files. One model call.
//   (4) Units (no database): the employer copy refuses a document carrying a line no confirmed fact supports, and
//       leaves the router's files as they were.
// Measured and printed: turns, wall time per turn (p50/p95), model calls.
// The gaps this family still has (cover letter, "shorter", "remove the GPA", undo, contact line, erase of the files,
// the version an application uses, SMS) are acceptance tests in tests/architect/pending/family-materials-gaps.test.ts.
// Run: CI=true deno test -A --no-check tests/architect/family-materials.test.ts (add --import-map=tests/flow/supabase-npm.json
// where esm.sh is unreachable).
import assertNode from "node:assert/strict";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { CareerProfile, CareerRender, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { employerFiles } from "../../supabase/functions/_shared/career_tailor_rewrite.ts";
import { documentsOf, fetchArtifactBytes } from "../../supabase/functions/_shared/channel_artifacts.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
const PEOPLE: Record<string, string> = {
  "tok-m1": "7b0f8f8e-6a43-4a49-9d2c-00000000a301",
  "tok-m2": "7b0f8f8e-6a43-4a49-9d2c-00000000a302",
  "tok-m3": "7b0f8f8e-6a43-4a49-9d2c-00000000a303",
};
// A resume as a student pastes it: name and contact on top, a GPA, two entries, a project, a skills line.
const RESUME = `Jordan Rivera
jordan.rivera@example.test | (312) 555-0142 | Chicago, IL

EDUCATION
DePaul University - B.S. Computer Science, GPA 3.6, expected June 2028

EXPERIENCE
Software Engineering Intern, Brightline Labs, June 2025 - August 2025
- Built a customer dashboard in React and TypeScript used by 300 clinic staff
- Reduced page load time by 35% by caching API responses

Data Analyst Intern, Northside Credit Union, June 2024 - August 2024
- Automated weekly loan reports in Python and SQL for the lending team

PROJECTS
StudyBuddy
- Built a study-group matching web app in JavaScript and Node.js with 150 student users

SKILLS
JavaScript, TypeScript, React, Node.js, Python, SQL`;
const RAMP = `Frontend Engineering Intern at Ramp. You will build customer-facing product surfaces in React and TypeScript.
Requirements: React, JavaScript, TypeScript; experience building dashboards for users. Nice to have: Python.`;
const QUILL = `Data Analyst Intern at Quillstone Analytics. You will automate reporting for internal teams.
Requirements: Python and SQL; experience automating reports. Nice to have: Tableau.`;

// ------------------------------------------------------------------------------------------------ the fake model
const calls: any[] = [];
let answer: (bullets: { id: string; text: string }[]) => { id: string; text: string }[] = (b) => b;
function fakeModel(body: any): Response {
  calls.push(body);
  const user = body.messages.find((m: any) => m.role === "user");
  const ask = JSON.parse(typeof user.content === "string" ? user.content : user.content.map((c: any) => c.text ?? "").join(""));
  const content = JSON.stringify({ bullets: answer(ask.bullets ?? []) });
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { headers: { "content-type": "application/json" } });
}

// ------------------------------------------------------------------------------------------------ the world
let priorKey: string | undefined; // the model key as it was: a key left set would reach later test files in the same process
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
const timings: number[] = [];
async function world() {
  if (handler) return { pg: pg!, handler };
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  const esc = (s: string) => s.replace(/'/g, "''");
  await pg.sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ('test:ramp:fe-intern', 'ashby', 'ramp', 'Ramp', 'Frontend Engineering Intern', 'New York, NY', 'https://jobs.ashbyhq.com/ramp/fe-intern', now(), '${esc(RAMP)}', 'h-ramp'),
    ('test:quillstone:da-intern', 'greenhouse', 'quillstone', 'Quillstone Analytics', 'Data Analyst Intern', 'Chicago, IL', 'https://boards.greenhouse.io/quillstone/jobs/2', now(), '${esc(QUILL)}', 'h-quill')`);
  Deno.env.set("CAREER_ACCOUNT_MEMORY", "on");
  handler = await careerHandler(pg, PEOPLE);
  const viaDouble = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    if (new URL(req.url).host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
    return viaDouble(req);
  }) as typeof fetch;
  priorKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-fake");
  return { pg, handler };
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the materials flow needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const say = async (c: Chat, m: string): Promise<Turn> => {
  const t0 = performance.now();
  const r = await c.say(m);
  timings.push(performance.now() - t0);
  eq(r.status, 200, `${m}: ${r.status} ${r.reply}`);
  return r;
};
async function onboard(c: Chat) {
  const pasted = await say(c, `here's my resume\n${RESUME}`);
  eq(pasted.intent, "career_resume_ingest", pasted.reply);
  const yes = await say(c, "yes, that's my resume");
  eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
}
interface Stored { id: string; filename: string; mime: string; sha256: string; bytes: Buffer; thread: string }
async function stored(person: string): Promise<Stored[]> {
  const rows = JSON.parse(await pg!.sql(`select coalesce(json_agg(json_build_object('id', id, 'filename', filename, 'mime', mime, 'sha256', sha256, 'b64', bytes_b64, 'thread', thread_id) order by created_at, filename), '[]') from public.channel_artifacts where user_id = '${person}'`));
  return rows.map((r: any) => ({ id: r.id, filename: r.filename, mime: r.mime, sha256: r.sha256, bytes: Buffer.from(r.b64, "base64"), thread: r.thread }));
}
const sha = (b: Uint8Array) => nodeCrypto.createHash("sha256").update(b).digest("hex");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// The two files of one turn, parsed back by 148's own readers (the ATS parse harness reads them the same way).
async function filesOf(person: string, r: Turn) {
  const refs = (r.body.artifacts ?? []).map((a: any) => a.ref);
  const rows = (await stored(person)).filter((x) => refs.includes(x.id));
  const pdf = rows.find((x) => x.mime === "application/pdf"), docx = rows.find((x) => x.mime === DOCX);
  return { refs, rows, pdf, docx, pdfText: pdf ? squash((R.extractPdfLines(pdf.bytes) as string[]).join(" ")) : "", docxLines: docx ? (R.extractDocxLines(docx.bytes) as string[]).map((l) => squash(l).replace(/^•\s*/, "")).filter(Boolean) : [] };
}
// Every printed line is a heading, or the person's own confirmed words (the pasted resume, which they confirmed), or the
// skills line made only of skills they listed.
const HEADINGS = new Set(["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS", "LEADERSHIP", "CERTIFICATIONS"]);
const SKILLS = ["JavaScript", "TypeScript", "React", "Node.js", "Python", "SQL"];
function untraced(lines: string[]): string[] {
  const source = squash(RESUME.replace(/^- /gm, ""));
  return lines.map((l) => l.replace(/^•\s*/, "")).filter((l) => {
    if (HEADINGS.has(l.toUpperCase())) return false;
    if (source.includes(l)) return false;
    const items = l.split(/,\s*/);
    return !(items.length > 1 && items.every((s) => SKILLS.includes(s)));
  });
}

// ------------------------------------------------------------------------------------------------ (1) and (2)
Deno.test({ name: "materials (1)(2): a messy new user tailors for Ramp, changes their mind, asks for the file again: PDF and DOCX stored, traced, versioned, owner-only", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-m1"], other = PEOPLE["tok-m2"], chat = handler.chat("tok-m1");
  Deno.env.set("CAREER_TAILOR_REWRITE", "off"); // D-036: a release flag (on when unset); "off" is its rollback
  const before = calls.length;
  await onboard(chat);
  let ramp: Turn;

  await t.step("tailor it for this Ramp frontend intern role: both files stored, attached, parsed back, every line traced", async () => {
    ramp = await say(chat, "tailor it for this Ramp frontend intern role");
    console.log("RAMP:", ramp.intent, ramp.resultStatus, ramp.reply, JSON.stringify(ramp.body.artifacts));
    eq(ramp.intent, "career_tailor", ramp.reply);
    assert(/Ramp/.test(ramp.reply), ramp.reply);
    const f = await filesOf(person, ramp);
    // The reply says "Saved as PDF and DOCX files, attached"; that is what rides the reply and what is stored.
    assert(/PDF and DOCX/.test(ramp.reply), ramp.reply);
    eq((ramp.body.artifacts ?? []).map((a: any) => a.mime).sort(), ["application/pdf", DOCX].sort(), `both files ride the reply: ${JSON.stringify(ramp.body.artifacts)}`);
    eq(f.rows.length, 2, "both are stored");
    for (const row of f.rows) {
      eq(row.thread, chat.thread(), "stored against the turn's own thread");
      eq(row.sha256, sha(row.bytes), `${row.filename}: the recorded sha256 is the stored bytes' own`);
    }
    assert(f.pdf!.bytes.subarray(0, 5).toString() === "%PDF-", "a PDF");
    assert(f.docx!.bytes[0] === 0x50 && f.docx!.bytes[1] === 0x4b, "a DOCX (zip)");
    // The two files hold the same lines, in the same order.
    assert(f.docxLines.length >= 6, `the DOCX reads back: ${f.docxLines.join(" / ")}`);
    let at = 0;
    for (const l of f.docxLines) { const i = f.pdfText.indexOf(l, at); assert(i >= 0, `the PDF carries "${l}" in the DOCX's order:\n${f.pdfText}`); at = i + l.length; }
    eq(untraced(f.docxLines), [], "every line is the person's own confirmed words");
    assert(f.docxLines.includes("Built a customer dashboard in React and TypeScript used by 300 clinic staff"), f.docxLines.join("\n"));
    // What is for the person stays in the reply: the tailor's verdict is not a resume line.
    assert(/Eligibility verdict/.test(ramp.reply), "the verdict is said in the reply");
    assert(!/Eligibility verdict|gap list|not evidenced/i.test(f.pdfText), `no internal note is printed on the PDF:\n${f.pdfText}`);
    assert(!f.docxLines.some((l) => /Eligibility verdict/i.test(l)), "nor on the DOCX");
    // Named for what it is; never "Resume_Resume".
    eq(f.rows.map((x) => x.filename).sort(), ["Resume_Ramp.docx", "Resume_Ramp.pdf"]);
  });

  await t.step("the file is the owner's: another person cannot read it by its ref, and the owner can", async () => {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const ref = ramp.body.artifacts[0].ref;
    eq(await fetchArtifactBytes(admin, { userId: other, ref }), null, "another person's id reads nothing");
    const mine = await fetchArtifactBytes(admin, { userId: person, threadId: chat.thread(), ref });
    assert(mine && mine.bytes.length > 500, "the owner reads the bytes");
  });

  let quill: Turn;
  await t.step("change of mind: the Quillstone data analyst one instead -> a second version beside the first", async () => {
    quill = await say(chat, "actually tailor my resume for the Quillstone data analyst intern role instead");
    console.log("QUILL:", quill.intent, quill.resultStatus, quill.reply);
    eq(quill.intent, "career_tailor", quill.reply);
    assert(/Quillstone/.test(quill.reply) && /Data Analyst/.test(quill.reply), quill.reply);
    const f = await filesOf(person, quill);
    eq(f.rows.map((x) => x.filename).sort(), ["Resume_Quillstone_Analytics.docx", "Resume_Quillstone_Analytics.pdf"]);
    eq(untraced(f.docxLines), [], "every line traced");
    assert(f.docxLines.includes("Automated weekly loan reports in Python and SQL for the lending team"), f.docxLines.join("\n"));
    const all = await stored(person);
    eq(all.length, 4, "the Ramp version is kept beside the Quillstone one");
    const r1 = await filesOf(person, ramp);
    assert(r1.pdf!.sha256 !== f.pdf!.sha256, "two different cuts");
  });

  await t.step("send me the pdf again: the newer version, byte for byte", async () => {
    const again = await say(chat, "send me the pdf again");
    console.log("AGAIN:", again.intent, again.reply, JSON.stringify(again.body.artifacts));
    eq(again.intent, "career_document_delivery", again.reply);
    const f = await filesOf(person, again);
    eq(f.rows.length, 1, "the PDF only, as the reply says");
    assert(/PDF is attached/.test(again.reply), again.reply);
    const q = await filesOf(person, quill);
    eq(f.pdf!.sha256, q.pdf!.sha256, "the same bytes as the Quillstone version");
    eq(f.pdf!.filename, "Resume_Quillstone_Analytics.pdf");
  });
  console.log(`MODEL CALLS (rewrite off): ${calls.length - before}`);
  eq(calls.length, before, "no model call with the rewrite off");
} });

// ------------------------------------------------------------------------------------------------ (3)
Deno.test({ name: "materials (3): an invented employer, number or date in a rewrite is refused and reaches neither file", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-m3"], chat = handler.chat("tok-m3");
  Deno.env.set("CAREER_TAILOR_REWRITE", "on");
  try {
    await onboard(chat);
    answer = (bullets) => bullets.map((b) => {
      if (/customer dashboard/.test(b.text)) return { id: b.id, text: "Built a React and TypeScript customer dashboard used by 300 clinic staff" }; // faithful
      if (/page load time/.test(b.text)) return { id: b.id, text: "Reduced page load time by 60% by caching API responses" }; // invented number
      if (/study-group/.test(b.text)) return { id: b.id, text: "Built a study-group matching web app at Google in JavaScript and Node.js with 150 student users" }; // invented employer
      if (/loan reports/.test(b.text)) return { id: b.id, text: "Automated weekly loan reports in Python and SQL for the lending team since 2019" }; // invented date
      return b;
    });
    const n = calls.length;
    const r = await say(chat, "can you tailor my resume to the ramp frontend internship");
    console.log("REWRITE:", r.intent, r.reply, JSON.stringify(r.body.meta?.tailor_rewrite?.rejected?.map((x: any) => x.reasons)));
    eq(r.intent, "career_tailor", r.reply);
    eq(calls.length, n + 1, "one model call");
    const f = await filesOf(person, r);
    console.log("REWRITE FILES:\n" + f.docxLines.join("\n") + "\n---\n" + f.pdfText);
    eq(f.rows.length, 2, "PDF and DOCX");
    for (const bad of ["60%", "Google", "2019"]) {
      assert(!f.pdfText.includes(bad), `${bad} never reaches the PDF:\n${f.pdfText}`);
      assert(!f.docxLines.some((l) => l.includes(bad)), `${bad} never reaches the DOCX`);
    }
    assert(f.docxLines.includes("Built a React and TypeScript customer dashboard used by 300 clinic staff"), `the faithful rewrite is in the DOCX:\n${f.docxLines.join("\n")}`);
    assert(f.pdfText.includes("Built a React and TypeScript customer dashboard used by 300 clinic staff"), "and in the PDF");
    assert(f.docxLines.includes("Reduced page load time by 35% by caching API responses"), "the refused bullet keeps the person's words");
    const rw = r.body.meta?.tailor_rewrite;
    eq(rw?.accepted?.length, 1, JSON.stringify(rw));
    const reasons = (rw?.rejected ?? []).map((x: any) => x.reasons.join("; ")).join("\n");
    for (const bad of ["60%", "Google", "2019"]) assert(reasons.includes(bad), `the refusal names ${bad}:\n${reasons}`);
    assert(/60%/.test(r.reply) && /Google/.test(r.reply), `the reply says why each was kept as written: ${r.reply}`);
    eq(untraced(f.docxLines.filter((l) => l !== "Built a React and TypeScript customer dashboard used by 300 clinic staff")), [], "every other line is the person's own words");
    const cost = await pg!.sql(`select calls from public.agent_turn_costs where user_id = '${person}' order by id desc limit 1`);
    eq(cost.trim(), "1", "the call is metered");
    // Every rewrite invented something: nothing is reworded, and the person still gets both files, in their own words.
    answer = (bullets) => bullets.map((b) => ({ id: b.id, text: `${b.text} at Google in 2019` }));
    const none = await say(chat, "tailor my resume for the quillstone data analyst intern role");
    eq(none.intent, "career_tailor", none.reply);
    eq(none.body.meta?.tailor_rewrite?.accepted?.length, 0, JSON.stringify(none.body.meta?.tailor_rewrite));
    assert(/No bullet was reworded/.test(none.reply), none.reply);
    const g = await filesOf(person, none);
    eq(g.rows.map((x) => x.filename).sort(), ["Resume_Quillstone_Analytics.docx", "Resume_Quillstone_Analytics.pdf"], "both files, named for the posting");
    assert(!/Google|2019|Eligibility verdict/.test(g.pdfText), g.pdfText);
    eq(untraced(g.docxLines), [], "every line is the person's own words");
  } finally {
    Deno.env.delete("CAREER_TAILOR_REWRITE");
    answer = (b) => b;
  }
} });

// ------------------------------------------------------------------------------------------------ (4) units
const FACTS = { id: "p1", basics: {}, facts: [
  { id: "F-1", kind: "experience", title: "Software Engineering Intern, Brightline Labs, June 2025 - August 2025", org: "Brightline Labs", text: "Built a customer dashboard in React and TypeScript used by 300 clinic staff", bullets: ["Built a customer dashboard in React and TypeScript used by 300 clinic staff"], skills: ["React", "TypeScript"], status: "confirmed" },
  { id: "F-2", kind: "skill", name: "React", title: "React", status: "confirmed" },
] };
function profile() {
  const p = CareerProfile.createProfile({ id: "p1", basics: {}, facts: [] });
  for (const f of FACTS.facts) CareerProfile.addFact(p, { ...f });
  return p;
}
Deno.test("materials (4): the employer copy refuses a line no confirmed fact supports and leaves the router's files", () => {
  const p = profile();
  const t = CareerTailor.tailorResume(p, RAMP, { company: "Ramp" });
  assert(t.ok && t.resume, JSON.stringify(t).slice(0, 300));
  const router = { kind: "tailored_resume", company: "Ramp", pdf: { base64: "cm91dGVy", filename: "Resume_Resume.pdf" } };
  const ok = { artifact: { ...router }, tailorDoc: t.resume };
  assert(employerFiles(ok, t.resume, p), "a traced document becomes the employer copy");
  assert(ok.artifact.pdf.base64 !== "cm91dGVy" && (ok.artifact as any).docx?.base64, "PDF and DOCX replaced and added");
  eq([ok.artifact.pdf.filename, (ok.artifact as any).docx.filename], ["Resume_Ramp.pdf", "Resume_Ramp.docx"]);
  eq(documentsOf(ok).map((d) => d.mime), ["application/pdf", DOCX], "both ride the turn's documents");
  // A line that cites a fact but says something the fact does not: refused, the router's files untouched.
  const bad = JSON.parse(JSON.stringify(t.resume));
  const line = { text: "Led a team of 12 engineers at Google", factIds: ["F-1"], type: "bullet" };
  bad.sections.find((s: any) => s.heading === "Experience").lines.push(line);
  bad.lines.push({ ...line, section: "Experience" });
  const refused = { artifact: { ...router }, tailorDoc: bad };
  eq(employerFiles(refused, bad, p), false, "the audit refuses it");
  eq(refused.artifact, router, "the router's files are left exactly as they were");
  eq(documentsOf(refused).length, 1, "and only what exists is attached");
  // Nothing on the page that is not cited: the verdict line goes.
  const noted = JSON.parse(JSON.stringify(t.resume));
  noted.sections.push({ heading: "Notes", lines: [{ text: "Eligibility verdict: internal", factIds: [], type: "note" }] });
  const n = { artifact: { ...router }, tailorDoc: noted };
  assert(employerFiles(n, noted, p));
  const lines = (R.extractDocxLines(Buffer.from((n.artifact as any).docx.base64, "base64")) as string[]).join("\n");
  assert(!/Eligibility verdict/.test(lines), lines);
  // A named person's files are named for them.
  const named = JSON.parse(JSON.stringify(t.resume));
  named.header = { ...(named.header || {}), name: "Jordan Rivera", email: "jordan.rivera@example.test" };
  const nm = { artifact: { ...router }, tailorDoc: named };
  assert(employerFiles(nm, named, p));
  eq(nm.artifact.pdf.filename, "Jordan_Rivera_Resume.pdf");
});

// ------------------------------------------------------------------------------------------------ measurement
Deno.test({ name: "materials: measured turns, wall time and model calls (printed; this machine, not production)", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const xs = [...timings].sort((a, b) => a - b);
  const q = (p: number) => xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]) : 0;
  console.log(`MATERIALS MEASURE: turns=${xs.length} p50_ms=${q(0.5)} p95_ms=${q(0.95)} max_ms=${Math.round(xs.at(-1) ?? 0)} model_calls=${calls.length}`);
  assert(xs.length >= 9, "the flows above ran (5 + 4 turns)");
  handler?.restore();
  if (priorKey === undefined) Deno.env.delete("ANTHROPIC_API_KEY"); else Deno.env.set("ANTHROPIC_API_KEY", priorKey);
  await pg?.stop();
} });
