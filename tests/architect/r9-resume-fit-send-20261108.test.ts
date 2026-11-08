// Review of PR #596 (release 9 B), 2026-11-08.
//   fit/1-3  A tailored resume's page fit (career_resume_design.ts Fit: body 10.5 pt, spacing 0.85) rode the router's employer
//            copy, which the router keeps on the person's profile (_careerRouterArtifacts). The hosted apply hashes that whole
//            profile at prepare and again before the effect (workers/career-cloud/prepare.ts, current_sources.ts) with the
//            apply hash, which takes whole numbers only (career_apply_store.ts canonical): every hosted send after a tailor
//            refused with INVALID_APPLY_PAYLOAD. What is kept or returned of a fit is now whole numbers (fitRecord).
//   name/1-3 The rendered resume carries the person's name and the contact header they confirmed with their resume (PDF and
//            DOCX); with no name and email at all the router no longer renders a nameless file (it shipped Resume_<co>.pdf
//            starting at SKILLS) but asks for them, as tailor_resume does; and a confirmed contact line that does not come
//            back out of the file refuses the file.
//   tool/1-2 The chat's tailor_resume prints the header the person confirmed (the form path still asks for a typed name and
//            email) and attaches its PDF and Word files to the reply; route/1 "make my resume fit the X job" is a tailoring.
//   two/1-2  Two roles in one ask, joined the way people text ("4 the", "n", "&", "+", "plus"): one file each, named for it.
//   parity/1-2 The DOCX (Inter) wraps no further than the PDF (Helvetica metrics), so LibreOffice lays it out on the PDF's pages.
// Offline: everything renders in this process.
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile, CareerRender, CareerRouter, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { CONDENSE_MAX, docxCondense, fit, fitRecord, interWidthPt, renderDesigned, traineeBlocks, TRAINEE_PALETTE, widthPt } from "../../supabase/functions/_shared/career_resume_design.ts";
import { atsHarness, confirmedOnly, edgeRenderer, memoryResumeStore, submissionResume, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { tailorRewriteTurn } from "../../supabase/functions/_shared/career_tailor_rewrite.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const NOW = Date.UTC(2026, 10, 8, 15);
const USER = "00000000-0000-4000-8000-0000000009b2";
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
const DATA_POSTING = `Data Analyst, Acme Analytics (TEST posting)
Requirements:
- Experience with SQL and PostgreSQL, Python, and Tableau
- Build dashboards for internal users
Nice to have: React, Kubernetes`;
function fixtureProfile() {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" } });
  const r = CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  assert(r.ok && r.drafts.length > 5, "the fixture resume ingests");
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
// Every number anywhere in a value that is not a whole number, by path (what the apply hash refuses).
function fractions(v: unknown, at = "$", out: string[] = []): string[] {
  if (typeof v === "number" && !Number.isSafeInteger(v)) out.push(`${at}=${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => fractions(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) fractions(x, `${at}.${k}`, out);
  return out;
}
// The router tailors, then the turn's employer copy is made (agent-chat runs tailorRewriteTurn after every career_tailor turn).
async function routerTailor() {
  const ctx: any = { profile: fixtureProfile(), now: NOW, thread: {}, jdText: DATA_POSTING, company: "Acme Analytics", jobId: "acme-data-1" };
  const r = CareerRouter.handleChat("tailor my resume for this posting", ctx);
  assert(r?.intent === "career_tailor" && r.artifact?.kind === "tailored_resume", `the router tailors: ${r?.intent}`);
  await tailorRewriteTurn({ out: { intent: r.intent, result: r } as any, profile: ctx.profile, on: false, model: null as any });
  assert(r.artifact.employer_copy === true && r.artifact.layout === "trainee", "the employer copy is in the Trainee layout");
  return { ctx, r };
}

Deno.test("fit/1 a fit is kept as whole numbers: tenths of a point and an integer percent, the same pages", () => {
  const doc = submissionResume(CareerTailor.tailorResume(confirmedOnly(fixtureProfile()), CareerTailor.parseJD(DATA_POSTING), {}).resume);
  const f = fit(traineeBlocks(doc), TRAINEE_PALETTE).fit;
  eq(fitRecord({ pages: 2, body: 10.5, scale: 0.85, target: 2, over: false }), { pages: 2, target: 2, over: false, body_pt10: 105, spacing_pct: 85 });
  eq(fitRecord({ pages: 3, body: 10, scale: 0.7, target: 2, over: true }), { pages: 3, target: 2, over: true, body_pt10: 100, spacing_pct: 70 });
  eq(fractions(fitRecord(f)), [], "whole numbers only");
  eq(fitRecord(f).pages, f.pages);
});

Deno.test("fit/2 after a tailor, the hosted apply's source check passes: the profile the router keeps hashes with the apply hash", async () => {
  const { ctx, r } = await routerTailor();
  eq(fractions(r.artifact), [], "the employer copy carries no fraction");
  assert(r.artifact.fit && r.artifact.fit.pages >= 1 && r.artifact.fit.pages <= 2 && r.artifact.fit.body_pt10 >= 100, JSON.stringify(r.artifact.fit));
  // The profile as the database holds it (agent_flow_state state.career.stores.profile, jsonb) and as
  // career_apply_message_cloud_sources hands it to the worker: { profile, rows }, digested with the user id.
  const profile = JSON.parse(JSON.stringify(ctx.profile));
  assert((profile._careerRouterArtifacts || []).some((a: any) => a.employer_copy && a.fit), "the kept copy is the one with the fit");
  eq(fractions(profile), [], "nothing in the stored profile is a fraction");
  const digest = await hashApplyPayload({ user_id: USER, profile, rows: [] });
  assert(/^[a-f0-9]{64}$/.test(digest), "prepare and the before-effect check hash it (workers/career-cloud)");
  // The check itself is strict: the shape #596 first stored is refused, so this test would have caught it.
  const before = JSON.parse(JSON.stringify(profile));
  before._careerRouterArtifacts.find((a: any) => a.fit).fit = { pages: 1, body: 10.5, scale: 1, target: 1, over: false };
  let refused = "";
  await hashApplyPayload({ user_id: USER, profile: before, rows: [] }).catch((e) => { refused = e.message; });
  eq(refused, "INVALID_APPLY_PAYLOAD");
});

Deno.test("fit/3 tailor_resume's file with a layout: what it returns and what an apply payload built from it carries hashes", async () => {
  const store = memoryResumeStore();
  const out = await tailorForPosting({ userId: USER, profile: fixtureProfile(), posting: { text: DATA_POSTING, job_id: "acme-data-1", company: "Acme Analytics" }, deps: { render: edgeRenderer(), resumes: store }, now: NOW, layout: "trainee" });
  assert(out.ok, JSON.stringify(out));
  const { detail: _d, ...returned } = out; // what the tool hands back (career_tools.ts tailor_resume)
  eq(fractions(returned), [], "the tool result carries no fraction");
  eq([out.fit?.pages, out.fit?.body_pt10 !== undefined && out.fit.body_pt10 >= 100], [1, true]);
  // A hosted payload binds the file by its hash and the WO-028 tag; with the result spread in, it still hashes.
  const payload = { version: 1, user_id: USER, job_id: "acme-data-1", company: "Acme Analytics", url: "https://jobs.example.test/acme-data-1", fields: [],
    privacy_epoch: 1, account_version: 1, expires_at: new Date(NOW + 86400000).toISOString(), resume_sha256: out.sha256, resume_tailored: true,
    resume_persona: null, resume_layout: out.layout, resume_fit: out.fit };
  assert(/^[a-f0-9]{64}$/.test(await hashApplyPayload(payload)), "the send check accepts it");
});

// ------------------------------------------------------------------------------------------------ the name and the header
// The person pastes their resume and says yes: the header shown with the entries is confirmed with them (142), and no name
// or email was ever typed for the resume (basics empty).
function headerOnlyProfile() {
  const ctx: any = { now: NOW, thread: {} };
  CareerRouter.handleChat(`here is my resume:\n${RESUME_TEXT}`, ctx);
  CareerRouter.handleChat("yes, that's my resume", ctx);
  assert(ctx.profile?.resume_header?.confirmed_at && !ctx.profile.basics?.name, "a confirmed header, nothing typed");
  return ctx.profile;
}
const NAME = "Alex Testcase (TEST)";
const CONTACT = "Chicago, IL (TEST) | alex.testcase@example.test | +1 555-0100 (TEST)";
const LINKS = "GitHub: https://github.com/example-testcase (TEST)";
const flat = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ");

Deno.test("name/1 the router's file and its employer copy carry the confirmed header at the top, PDF and DOCX", async () => {
  const ctx: any = { profile: headerOnlyProfile(), now: NOW, thread: {}, jdText: DATA_POSTING, company: "Acme Analytics", jobId: "acme-data-1" };
  const r = CareerRouter.handleChat("tailor my resume for this posting", ctx);
  assert(r?.intent === "career_tailor" && r.artifact, `tailored: ${r?.intent}`);
  await tailorRewriteTurn({ out: { intent: r.intent, result: r } as any, profile: ctx.profile, on: false, model: null as any });
  const pdf = flat(R.extractPdfLines(Buffer.from(r.artifact.pdf.base64, "base64")));
  const docx = flat(R.extractDocxLines(Buffer.from(r.artifact.docx.base64, "base64")));
  for (const [what, text] of [["PDF", pdf], ["DOCX", docx]]) {
    for (const s of [NAME, CONTACT, LINKS]) assert(text.includes(s), `the ${what} carries "${s}": ${text.slice(0, 240)}`);
    assert(text.indexOf(NAME) === 0 && text.indexOf(CONTACT) < text.indexOf("EXPERIENCE"), `the ${what} starts with the header`);
  }
  // A header read from the resume prints on it; the files keep the posting's name (career_tailor_rewrite.ts named()).
  eq([r.artifact.pdf.filename, r.artifact.docx.filename], ["Resume_Acme_Analytics.pdf", "Resume_Acme_Analytics.docx"]);
});

Deno.test("name/2 with no name and email (none typed, no header confirmed): the empty top is said and asked; the chat tool and the form path refuse", async () => {
  const p = CareerProfile.createProfile({});
  CareerProfile.ingestResume(p, { text: RESUME_TEXT.split("\n").slice(4).join("\n"), fileName: "test-resume.txt" });
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  assert(!p.basics.name && !p.resume_header && p.facts.length > 3, "confirmed entries, no contact");
  const ctx: any = { profile: p, now: NOW, thread: {}, jdText: DATA_POSTING, company: "Acme Analytics" };
  const r = CareerRouter.handleChat("tailor my resume for this posting", ctx);
  eq([r?.intent, r?.artifact?.no_contact], ["career_tailor", true]);
  assert(/There is no name or email at the top of this file/.test(r.reply) && /What name and email should go at the top of your resume\?/.test(r.reply), r.reply);
  // A header confirmed without an email is not a contact header either.
  const half = headerOnlyProfile();
  half.resume_header.email = null;
  const r2 = CareerRouter.handleChat("tailor my resume for this posting", { profile: half, now: NOW, thread: {}, jdText: DATA_POSTING, company: "Acme" } as any);
  eq(r2?.artifact?.no_contact, true);
  // tailor_resume (chat) and the form path refuse without one, with the same question.
  const o = await tailorForPosting({ userId: USER, profile: p, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assert(!o.ok && o.refused === "no_contact" && o.reason.includes("What name and email should go at the top of your resume?"), JSON.stringify(o));
});

Deno.test("name/3 the contact line the person confirmed must come back out of the file, or the file is refused", () => {
  const doc = submissionResume(CareerTailor.tailorResume(headerOnlyProfile(), CareerTailor.parseJD(DATA_POSTING), {}).resume);
  eq([doc.header.name, doc.header.contactLine], [NAME, CONTACT]);
  const good = R.renderPdf(doc);
  assert(good.ok && atsHarness(R, doc, new Uint8Array(good.buffer)).pass, JSON.stringify(good.ok && atsHarness(R, doc, new Uint8Array(good.buffer)).reasons));
  // The same file judged against a header whose contact line it does not carry.
  const other = { ...doc, header: { ...doc.header, contactLine: "Chicago, IL (TEST) | alex.testcase@example.test | +1 555-0199 (TEST)" } };
  const v = atsHarness(R, other, new Uint8Array(good.buffer));
  assert(!v.pass && v.reasons.some((x) => /contact line you confirmed/.test(x)), JSON.stringify(v.reasons));
  // And the designed layout's own check says the same.
  const d = renderDesigned(R, doc, { layout: "trainee" });
  assert(d.ok && d.parseCheck.status === "PASS", JSON.stringify(d.ok && d.parseCheck));
});

// ------------------------------------------------------------------------------------------------ PDF and DOCX parity
// The DOCX is set in Inter, about 6% wider than the Helvetica metrics of the PDF and the fit: a wrap-heavy record printed on
// one page as a PDF and on two in LibreOffice. A paragraph that would wrap further in Inter is drawn closer (docxCondense).
function longDoc(n: number) {
  const lines: any[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push({ text: `Analyst ${i}, Example Firm ${i} (TEST), 2015–2016`, type: "entry", factIds: [`F-${i}`] });
    for (let k = 1; k <= 3; k++) lines.push({ text: `Built reporting pipeline number ${k} for team ${i} in Python and SQL, used weekly by analysts across three offices`, type: "bullet", factIds: [`F-${i}`] });
  }
  return { header: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" }, sections: [{ heading: "Experience", lines }], lines: lines.map((l) => ({ ...l, section: "Experience" })) };
}
const condensing = (docx: Uint8Array) => [...Buffer.from(R.docxPart(Buffer.from(docx), "word/document.xml")).toString("utf8").matchAll(/<w:spacing w:val="-(\d+)"\/>/g)].map((m) => +m[1]);

Deno.test("parity/1 a paragraph that would wrap further in Inter is drawn closer, by the least that keeps the PDF's lines; others are untouched", () => {
  const short = renderDesigned(R, submissionResume(CareerTailor.tailorResume(confirmedOnly(fixtureProfile()), CareerTailor.parseJD(DATA_POSTING), {}).resume), { layout: "trainee" });
  assert(short.ok);
  eq(condensing(short.docx), [], "the fixture needs none: its DOCX is as it was");
  for (const n of [9, 14]) {
    const doc = longDoc(n), d = renderDesigned(R, doc, { layout: "trainee" });
    assert(d.ok && d.sameText && d.parseCheck.status === "PASS", `${n}: ${JSON.stringify(d.ok && d.parseCheck)}`);
    const c = condensing(d.docx);
    assert(c.length > 0 && c.every((x) => x >= 1 && x <= CONDENSE_MAX), `${n}: ${JSON.stringify(c)}`);
    // An entry is one line in the PDF: in Inter, with its condensing, its words end before the date at the right margin.
    for (const b of traineeBlocks(doc).filter((x) => x.kind === "entry" && x.right)) {
      const k = docxCondense(b, d.fit.body, TRAINEE_PALETTE);
      const width = 504 - Math.max(widthPt(b.right!, "F1", d.fit.body), interWidthPt(b.right!, false, d.fit.body)) - 12;
      assert(widthPt(b.text, "F2", d.fit.body) <= width + 1e-9 ? interWidthPt(b.text, true, d.fit.body, k) <= width : true, `"${b.text}" fits before its date`);
    }
  }
});

Deno.test({ name: "parity/2 LibreOffice lays the DOCX out on the PDF's pages, with the same words in order (where installed)", sanitizeResources: false, sanitizeOps: false, async fn() {
  const which = await new Deno.Command("which", { args: ["soffice"] }).output();
  if (!which.success) { console.log("NOT_RUN: soffice is not installed here"); return; }
  const dir = await Deno.makeTempDir({ prefix: "r9-parity-" });
  try {
    for (const n of [6, 9, 14]) {
      const d = renderDesigned(R, longDoc(n), { layout: "trainee" });
      assert(d.ok);
      await Deno.writeFile(`${dir}/r${n}.docx`, d.docx);
      const r = await new Deno.Command("soffice", { args: ["--headless", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, `${dir}/r${n}.docx`], stdout: "null", stderr: "null" }).output();
      assert(r.success, `soffice converted r${n}`);
      const info = new TextDecoder().decode((await new Deno.Command("pdfinfo", { args: [`${dir}/r${n}.pdf`] }).output()).stdout);
      const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
      eq([n, pages], [n, d.fit.pages], `${n} entries: the DOCX's pages in LibreOffice are the PDF's`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
} });

// ------------------------------------------------------------------------------------------------ the chat's tailor_resume
// e2e eval (full set, 2026-11-08): "make my resume fit ... one page pdf" and the other phrasings the router does not read reached
// the brain's tailor_resume, which refused a person whose name and email are the header they confirmed with their resume
// (no_contact), and, when it did make a file, returned only a link: no PDF rode the reply (resume.fit 0/25).
const { careerTools } = await import("../../supabase/functions/_shared/agent/career_tools.ts");
const { memoryPersonaStore } = await import("../../supabase/functions/_shared/career_tailor.ts");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

Deno.test("tool/1 tailor_resume uses the confirmed header and attaches its PDF and Word files to the reply", async () => {
  const store = memoryResumeStore(), sent: any[] = [];
  const tools = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer(), deliver: (d) => sent.push(d) } } as any).map((x: any) => [x.name, x]));
  const ctx = { userId: USER, threadId: "t1", now: NOW, state: { profile: headerOnlyProfile() } as Record<string, any>, turn: { message: "make my resume fit this job, one page pdf please", added: [] as string[] } };
  const r = await tools.tailor_resume.run({ posting_text: DATA_POSTING, layout: "trainee" }, ctx) as any;
  assert(r.ok && r.link, JSON.stringify(r).slice(0, 300));
  eq(sent.map((d) => [d.format, d.mime]), [["pdf", "application/pdf"], ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]]);
  eq(r.attached, [sent[0].filename, sent[1].filename], "the model is told what rides its reply");
  const pdf = fromB64(sent[0].base64);
  eq(crypto.createHash("sha256").update(pdf).digest("hex"), r.sha256, "the attached PDF is the stored one, byte for byte");
  assert(flat(R.extractPdfLines(Buffer.from(pdf))).startsWith(`${NAME} ${CONTACT}`), "it starts with their confirmed name and contact line");
  assert(flat(R.extractDocxLines(Buffer.from(fromB64(sent[1].base64)))).startsWith(`${NAME} ${CONTACT}`), "and so does the Word copy");
  eq(r.fit?.pages, 1, "one page");
  assert(!("detail" in r), "no bytes or internals in what the model reads");
  // Without a deliverer (another host), the result is as before: the link, nothing attached.
  const bare = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer() } } as any).map((x: any) => [x.name, x]));
  const r2 = await bare.tailor_resume.run({ posting_text: DATA_POSTING }, ctx) as any;
  assert(r2.ok && r2.link && !("attached" in r2), JSON.stringify(r2).slice(0, 200));
});

Deno.test("tool/2 the form path takes only a typed or answered name and email: a resume header alone asks the contact questions", async () => {
  const profile = headerOnlyProfile();
  const chat = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assert(chat.ok, "the chat makes the file from the confirmed header");
  const form = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, contact: "typed" });
  assert(!form.ok && form.refused === "no_contact", JSON.stringify(form));
  const src = await Deno.readTextFile(new URL("../../workers/career-browser/prepare-ahead.ts", import.meta.url));
  assert(/tailorForPosting\(\{[\s\S]{0,700}contact: "typed"/.test(src), "prepare-ahead asks for typed contact (SUBMIT-STEER-1130)");
});

Deno.test("route/1 'make my resume fit the X job at Y' is a tailoring, not a recommendation; 'which roles fit my resume' still is", async () => {
  const ctx: any = { profile: headerOnlyProfile(), now: NOW, thread: {}, jdText: DATA_POSTING, company: "Acme Analytics" };
  const r = CareerRouter.handleChat("make my resume fit the Data Analyst job at Acme Analytics, one page pdf please", ctx);
  assert(r?.intent === "career_tailor" && r.artifact?.pdf?.base64, `${r?.intent}`);
  await tailorRewriteTurn({ out: { intent: r.intent, result: r } as any, profile: ctx.profile, on: false, model: null as any });
  eq([r.artifact.layout, r.artifact.fit.pages], ["trainee", 1]);
  eq(CareerRouter.handleChat("which roles fit my resume", { profile: headerOnlyProfile(), now: NOW, thread: {} } as any)?.intent, "career_recommendations");
});

// ------------------------------------------------------------------------------------------------ two roles in one ask
// e2e eval resume.two (13/40): the texting and slang joins ("4 the", "n the", "& the", "plus the") read as one role, and the
// two files both came back as <Name>_Resume.pdf.
const { CareerHost } = await import("../../supabase/functions/_shared/career_host.js");
const core = await import("../../supabase/functions/_shared/router_core.career.js");
function twoRoleTurn(message: string, profile: any) {
  const host = (CareerHost as any).createCareerHost(core);
  const posting = (id: string, company: string, title: string, jd: string) => ({ id, job_id: id, company, title, location: "Chicago, IL", jd_text: jd, url: `https://boards.greenhouse.io/x/jobs/${id}` });
  const ctx = host.createTurnCtx({ userId: "TEST-r9-two", threadId: "t-two", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false },
    postings: [posting("gh-901", "Sable Software", "Data Scientist", "Data Scientist. Requirements: Python, SQL, Statistics."),
      posting("gh-902", "Willow Software", "Financial Analyst", "Financial Analyst. Requirements: Excel, SQL, financial modeling.")] });
  ctx.profile = profile;
  return host.runTurn(message, ctx);
}
Deno.test("two/1 the texting and slang joins name two roles: one file each, each named for its role, the confirmed name first", () => {
  for (const join of ["4 the Data Scientist role at Sable Software and", "for the Data Scientist role at Sable Software n", "for the Data Scientist role at Sable Software &", "for the Data Scientist role at Sable Software plus", "for the Data Scientist role at Sable Software +"]) {
    const m = `tailor my resume ${join} the Financial Analyst role at Willow Software and send both back rn`;
    const r = twoRoleTurn(m, headerOnlyProfile());
    const docs = (r.result?.documents ?? []).filter((d: any) => d && d.base64);
    eq(docs.map((d: any) => d.filename), ["Alex_Testcase_Resume_Sable_Software_Data_Scientist.pdf", "Alex_Testcase_Resume_Willow_Software_Financial_Analyst.pdf"], m);
    eq(new Set(docs.map((d: any) => d.sha256)).size, 2, "two different files");
    for (const d of docs) assert(flat(R.extractPdfLines(Buffer.from(d.base64, "base64"))).startsWith(`${NAME} ${CONTACT}`), `${d.filename} starts with the confirmed header`);
  }
});
Deno.test("two/2 the roles are read whole: an ampersand or a plus inside a role or a company is not a join", async () => {
  const src = await Deno.readTextFile(new URL("../../packages/domain/142-career-router.js", import.meta.url));
  const body = src.slice(src.indexOf("  function multiTailorTargets(text)"), src.indexOf("  function handleMultiTailor("));
  const s = (v: unknown) => String(v == null ? "" : v), lc = (v: unknown) => s(v).toLowerCase();
  const targets = new Function("s", "lc", `${body}; return multiTailorTargets;`)(s, lc);
  eq(targets("tailor my resume for the R&D Analyst role at AT&T and the C++ Developer role at Nimbus"), [{ role: "R&D Analyst", company: "AT&T" }, { role: "C++ Developer", company: "Nimbus" }]);
  eq(targets("tailor my resume for the Data Analyst role at Stripe"), null, "one role is the single tailor's");
});
