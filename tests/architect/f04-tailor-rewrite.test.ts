// FEATURE 4 unit tests: the bullet rewrite (_shared/career_tailor_rewrite.ts) with a fake model. A faithful rewrite
// passes; an invented metric, employer, tool, or claimed role is refused bullet by bullet with its reason and the original
// kept; the rewritten resume passes 123's truth audit and renders to PDF through 123/148 exactly as the router renders;
// a model failure or an unreadable answer leaves the select-and-reorder resume; the flag is off by default.
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile, CareerRender, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { auditRewrite, rewriteOn, rewriteResume, rewriteTargets, tailorRewriteTurn } from "../../supabase/functions/_shared/career_tailor_rewrite.ts";
import { changelog } from "../../supabase/functions/_shared/career_tailor.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });

const POSTING = `Data Analyst, Quillstone Analytics (TEST)
Requirements: SQL, Python and Tableau; build dashboards for internal users; automate recurring reporting.`;
function person() {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test" } });
  CareerProfile.addFact(p, { kind: "experience", title: "Data Intern, Example Bank (TEST)", org: "Example Bank (TEST)", start: "2025-06", end: "2025-08",
    text: "Data intern on the reporting team", skills: ["Python", "SQL"],
    bullets: ["Wrote SQL queries in Python that refreshed 14 reporting dashboards for internal users", "Automated a weekly variance report, cutting preparation time by 30%"] });
  CareerProfile.addFact(p, { kind: "project", title: "Rainfall forecaster (TEST)", text: "Python project",
    skills: ["Python"], bullets: ["Built a rainfall forecaster in Python on 10 years of public weather data"] });
  CareerProfile.addFact(p, { kind: "education", title: "TEST University, B.S. Statistics", text: "B.S. Statistics, TEST University, 2026", start: "2022", end: "2026" });
  for (const f of p.facts) { f.needs_confirmation = false; f.status = "confirmed"; }
  return p;
}
const fakeModel = (rewrite: (text: string) => string, seen: any[] = []) => async (payload: any) => {
  seen.push(payload);
  const ask = JSON.parse(payload.messages[0].content);
  return { content: [{ type: "text", text: JSON.stringify({ bullets: ask.bullets.map((b: any) => ({ id: b.id, text: rewrite(b.text) })) }) }], usage: {} };
};
const tailored = (p: any) => {
  const t = CareerTailor.tailorResume(p, POSTING, { company: "Quillstone Analytics (TEST)" });
  assert(t.ok && t.resume, "the select-and-reorder tailor runs");
  return t;
};
const factOf = (p: any, needle: string) => p.facts.find((f: any) => (f.bullets || []).some((b: string) => b.includes(needle)));

Deno.test("F04/1 audit: a faithful reword passes; invented metric, employer, tool, claimed role and a dropped number are refused with reasons", () => {
  const p = person(), f = factOf(p, "refreshed 14");
  const original = "Wrote SQL queries in Python that refreshed 14 reporting dashboards for internal users";
  const ok = auditRewrite({ original, proposed: "Refreshed 14 reporting dashboards for internal users with SQL queries written in Python", fact: f, profile: p });
  assert(ok.ok, `faithful: ${ok.reasons.join("; ")}`);
  const cases: [string, RegExp][] = [
    ["Wrote SQL queries in Python that refreshed 40 reporting dashboards for internal users", /number "40"/],
    ["Wrote SQL queries in Python at Goldman Sachs that refreshed 14 reporting dashboards for internal users", /name "Goldman"/],
    ["Wrote SQL queries in Python and Tableau that refreshed 14 reporting dashboards for internal users", /tool or skill "Tableau"/],
    ["Led a team writing SQL queries in Python that refreshed 14 reporting dashboards for internal users", /"Led"|"team"/],
    ["Managed SQL queries in Python that refreshed reporting dashboards for internal users", /drops the number "14"/],
    ["Wrote SQL queries in Python that refreshed 14 reporting dashboards for internal users, saving $2M", /number "2"|"M"/],
  ];
  for (const [proposed, why] of cases) {
    const a = auditRewrite({ original, proposed, fact: f, profile: p });
    assert(!a.ok && a.reasons.some((r) => why.test(r)), `${proposed}: ${a.reasons.join("; ")}`);
  }
  // Another fact's words do not support this bullet: each bullet traces to the fact it cites.
  const cross = auditRewrite({ original, proposed: "Wrote SQL queries in Python that refreshed 14 reporting dashboards on public weather data", fact: f, profile: p });
  assert(!cross.ok && cross.reasons.some((r) => /"weather"/.test(r)), cross.reasons.join("; "));
});

Deno.test("F04/2 rewriteResume: faithful rewrites land, inventions are refused one by one, the whole document passes the truth audit and renders", async () => {
  const p = person(), t = tailored(p);
  const targets = rewriteTargets(t.resume, p);
  assert(targets.length >= 3, `bullets to rewrite: ${JSON.stringify(targets)}`);
  const seen: any[] = [];
  const model = fakeModel((x) => {
    if (/refreshed 14/.test(x)) return "Refreshed 14 reporting dashboards for internal users with SQL queries written in Python";
    if (/variance report/.test(x)) return "Automated a weekly variance report in Tableau, cutting preparation time by 30%";
    if (/rainfall/.test(x)) return "Built a rainfall forecaster in Python on 10 years of public weather data for 3 utilities";
    return x;
  }, seen);
  const r = await rewriteResume({ resume: t.resume, profile: p, jd: CareerTailor.parseJD(POSTING), posting: { title: "Data Analyst", company: "Quillstone Analytics (TEST)" }, model });
  eq(seen.length, 1, "one model call for the whole resume");
  const sent = JSON.parse(seen[0].messages[0].content);
  assert(sent.posting.skills_named.includes("Python") && sent.bullets.every((b: any) => b.fact && b.id), "the posting's priorities and each bullet's own fact are sent");
  eq(r.status, "rewritten");
  eq(r.accepted.map((a) => a.after), ["Refreshed 14 reporting dashboards for internal users with SQL queries written in Python"]);
  eq(r.rejected.length, 2, JSON.stringify(r.rejected));
  assert(r.rejected.some((x) => /variance/.test(x.before) && x.reasons.some((y) => /Tableau/.test(y))), "the invented tool is refused");
  assert(r.rejected.some((x) => /rainfall/.test(x.before) && x.reasons.some((y) => /number "3"|"utilities"/.test(y))), "the invented metric is refused");
  const texts = r.resume.lines.map((l: any) => l.text);
  assert(texts.includes("Automated a weekly variance report, cutting preparation time by 30%"), "a refused bullet keeps its own words");
  assert(!texts.some((x: string) => /Tableau|utilities/.test(x)), "no invention reaches the document");
  const sectionTexts = r.resume.sections.flatMap((s: any) => s.lines.map((l: any) => l.text));
  assert(sectionTexts.includes("Refreshed 14 reporting dashboards for internal users with SQL queries written in Python"), "the sections the PDF renders from carry the rewrite");
  assert(CareerTailor.auditResume(r.resume, p).ok, "the rewritten resume passes 123's truth audit");
  const doc = R.renderPdf(r.resume);
  assert(doc.ok, `renders: ${doc.reason}`);
  const lines = (R.extractPdfLines(doc.buffer) as string[]).join("\n");
  assert(lines.includes("Refreshed 14 reporting dashboards for internal users with SQL queries written in Python") && !/Tableau|utilities/.test(lines), lines);
  // The original document object is never mutated.
  assert(t.resume.lines.some((l: any) => /Wrote SQL queries/.test(l.text)), "the input resume is untouched");
});

Deno.test("F04/3 no model, model error, unreadable answer: the select-and-reorder resume, said plainly", async () => {
  const p = person(), t = tailored(p), jd = CareerTailor.parseJD(POSTING), posting = { title: "Data Analyst", company: "Q" };
  const down = await rewriteResume({ resume: t.resume, profile: p, jd, posting, model: async () => { throw new Error("OpenAI API key is not configured"); } });
  eq([down.status, down.accepted.length], ["model_unavailable", 0]);
  assert(down.resume === t.resume, "the same resume");
  const junk = await rewriteResume({ resume: t.resume, profile: p, jd, posting, model: async () => ({ content: [{ type: "text", text: "Sure! Here you go." }] }) });
  eq(junk.status, "unreadable");
  const base = { diff: { added: [], moved: [], removed: [] }, base: { lines: [] }, tailored: { lines: [] }, profile: p, jd, hidden: [], persona: null };
  assert(/No bullet was reworded this time/.test(changelog({ ...base, rewrites: down }).line), "the changelog says nothing was reworded");
  const r = await rewriteResume({ resume: t.resume, profile: p, jd, posting, model: fakeModel((x) => x) });
  eq([r.status, r.accepted.length, r.rejected.length], ["unchanged", 0, 0]);
});

Deno.test("F04/4 the flag and the live turn: off by default; on, the router's career_tailor result gets the rewritten PDF in place", async () => {
  eq(rewriteOn({ get: () => undefined }), true, "D-036: a release flag, on when unset");
  eq(rewriteOn({ get: (k: string) => (k === "CAREER_TAILOR_REWRITE" ? "off" : undefined) }), false, "off is its rollback");
  eq(rewriteOn({ get: (k: string) => (k === "CAREER_TAILOR_REWRITE" ? "on" : undefined) }), true);
  const p = person(), t = tailored(p);
  const artifact = { kind: "tailored_resume", format: "text", text: t.rendered.text, pdf: t.rendered.pdf, sha256: "x", company: "Quillstone Analytics (TEST)" };
  const out = () => ({ intent: "career_tailor", reply: "Your resume is tailored.", result: { intent: "career_tailor", artifact: { ...artifact }, tailorDoc: t.resume, tailorJd: POSTING, tailorPosting: { title: "Data Analyst", company: "Quillstone Analytics (TEST)" } } });
  let called = 0;
  const model = async (payload: any) => { called++; return fakeModel((x) => /refreshed 14/.test(x) ? "Refreshed 14 reporting dashboards for internal users with SQL queries written in Python" : x)(payload); };
  const off = await tailorRewriteTurn({ out: out(), profile: p, on: false, model });
  eq([off.summary, called], [null, 0], "off: untouched, no call");
  const other = await tailorRewriteTurn({ out: { intent: "career_resume_ingest", reply: "x", result: {} }, profile: p, on: true, model });
  eq([other.summary, called], [null, 0], "another intent: untouched");
  const o = out();
  const on = await tailorRewriteTurn({ out: o, profile: p, on: true, model });
  eq(called, 1);
  assert(on.summary && on.summary.accepted.length === 1, JSON.stringify(on.summary));
  assert(/What changed: .*Reworded 1 bullet/.test(on.out.reply), on.out.reply);
  const a = o.result.artifact as any;
  assert(a.pdf && a.pdf.base64 && a.pdf !== artifact.pdf && a.reworded === 1, "the artifact's PDF is replaced in place");
  const lines = (R.extractPdfLines(Buffer.from(a.pdf.base64, "base64")) as string[]).join("\n");
  assert(lines.includes("Refreshed 14 reporting dashboards for internal users with SQL queries written in Python"), lines);
  assert(a.text.includes("Refreshed 14 reporting dashboards"), "the text form matches the PDF");
});
