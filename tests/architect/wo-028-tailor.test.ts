// WO-028 (architect): a resume tailored to one posting, in chat, from confirmed facts only. Contract:
// docs/architect/work-orders/WO-028-tailor-in-chat.md. Offline: the store is in memory, the PDF renders in this process.
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile, CareerRender, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import {
  atsHarness, baseResume, callbackRate, changelog, confirmedOnly, edgeRenderer, LINK_TTL_SECONDS, memoryPersonaStore, memoryResumeStore,
  PERSONAS_KEY, privateLinkProblem, renderWith, type ResumeRenderer, resumePath, tailorForPosting,
} from "../../supabase/functions/_shared/career_tailor.ts";
import { prepare, resumeCardLine, takeResumeTag } from "../../workers/career-browser/approve-first.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
async function rejects(f: () => Promise<unknown>, re: RegExp) { try { await f(); } catch (e) { assert(re.test(String((e as Error).message)), `wrong error: ${(e as Error).message}`); return; } throw new Error("did not reject"); }

const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const NOW = Date.UTC(2026, 9, 20, 15);
const USER = "00000000-0000-4000-8000-000000000028";

// The fixture persona: the synthetic test resume, ingested as drafts and then confirmed fact by fact (the person's yes).
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
function fixtureProfile() {
  const head = RESUME_TEXT.split("\n").map((l) => l.trim()).filter(Boolean);
  const name = head[1].replace(/\s*\(TEST\)\s*$/, ""), email = /[\w.]+@[\w.]+/.exec(RESUME_TEXT)![0];
  const p = CareerProfile.createProfile({ basics: { name, email, location: "Chicago, IL" } });
  const r = CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  assert(r.ok && r.drafts.length > 5, "the fixture resume ingests");
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
// A draft the person never confirmed: its words must never reach a resume.
function withDraft(p: any) {
  CareerProfile.addFact(p, { kind: "experience", title: "Tableau Developer, Draftco", text: "Built Tableau dashboards in Snowflake for 900 analysts", bullets: ["Built Tableau dashboards in Snowflake for 900 analysts"], needs_confirmation: true, status: "draft" });
  return p;
}
// The fixture posting. Tableau and Snowflake are planted: the person has neither, so neither may appear.
const DATA_POSTING = `Data Analyst, Acme Analytics (TEST posting)
About the role: build reporting for internal teams.
Requirements:
- Experience with SQL and PostgreSQL, Python, and Tableau
- Build dashboards for internal users
- Snowflake warehouse experience
Nice to have: React`;
const BANK_POSTING = `Investment Banking Analyst, Test Bank (TEST posting)
Requirements:
- Financial modeling and valuation in Excel
- Prepare investment committee materials
- Python a plus`;

const pdfText = (pdf: Uint8Array) => (R.extractPdfLines(Buffer.from(pdf)) as string[]).join("\n");
const docText = (doc: any) => doc.sections.flatMap((s: any) => [s.heading, ...s.lines.map((l: any) => l.text)]).join("\n");
function tools(o: { store?: any; personas?: any; render?: ResumeRenderer; posting?: (id: string) => Promise<any> } = {}) {
  const store = o.store ?? memoryResumeStore(), personas = o.personas ?? memoryPersonaStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: o.posting ?? (async () => null), personas, resumes: store, render: o.render ?? edgeRenderer() } }).map((x) => [x.name, x]));
  return { t, store, personas };
}
const ctx = (profile: any, message = "make me a resume for this one") => ({ userId: USER, threadId: "t1", now: NOW, state: { profile } as Record<string, any>, turn: { message, added: [] as string[] } });
const deps = (store = memoryResumeStore(), render: ResumeRenderer = edgeRenderer(), tailor?: any) => ({ render, resumes: store, ...(tailor ? { tailor } : {}) });

Deno.test("WO-028/1 the four resume tools: names, effects, real descriptions; not configured is said, never faked", async () => {
  const all = careerTools({ postings: async () => [] });
  const mine = all.filter((x) => ["tailor_resume", "set_resume_contact", "save_resume_persona", "use_resume_persona"].includes(x.name));
  eq(mine.map((x) => [x.name, x.effect]), [["tailor_resume", "write_own"], ["set_resume_contact", "write_own"], ["save_resume_persona", "write_own"], ["use_resume_persona", "write_own"]]);
  for (const x of mine) assert(x.description.length >= 20 && x.description.length <= 400, `${x.name}: description is ${x.description.length} chars`);
  await rejects(() => mine[0].run({ posting_text: DATA_POSTING }, ctx(fixtureProfile())), /not configured/);
});

Deno.test("WO-028/2 the tailored resume holds confirmed facts only: a planted posting skill and a draft never reach it; a private 7-day link; under 60 seconds", async () => {
  const { t, store } = tools();
  const profile = withDraft(fixtureProfile());
  const t0 = performance.now();
  const r = await t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)) as any;
  const ms = performance.now() - t0;
  console.log(`  measured: tailor_resume on the fixture persona and posting took ${ms.toFixed(0)} ms (tool's own count ${r.ms} ms)`);
  assert(ms < 60_000, "under 60 seconds");
  assert(!("detail" in r), "the model gets the result, not the document");
  const path = resumePath(USER, r.sha256);
  const pdf = store.files.get(`career-resumes/${path}`);
  assert(pdf, "stored at career-resumes/<user_id>/<sha256>.pdf");
  eq(R.sha256(Buffer.from(pdf)), r.sha256, "the stored bytes are the bytes hashed");
  eq(privateLinkProblem(r.link, path), null, "a signed link to that private object");
  eq(store.signed, [{ path, seconds: LINK_TTL_SECONDS }], "signed for 7 days");
  eq(r.expires_at, new Date(NOW + 7 * 86400_000).toISOString());
  const text = pdfText(pdf);
  for (const planted of ["Tableau", "Snowflake", "Draftco", "900"]) assert(!text.includes(planted), `"${planted}" is not in the PDF`);
  assert(text.includes("Alex Testcase") && text.includes("alex.testcase@example.test"), "name and email print");
  assert(!/Eligibility verdict/.test(text), "the tailor's verdict note is for the person, never printed for an employer");
  eq(r.ats.status === "PASS" || r.ats.status === "WARN", true, "it passed the ATS parse harness");
  assert(r.not_on_your_record.includes("Tableau"), "what the posting wants and the record lacks is said as a gap, not claimed");
  // Every printed line is cited to a confirmed fact that supports it.
  const out = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(), now: NOW });
  assert(out.ok);
  const confirmed = new Set(CareerProfile.confirmedFacts(profile).map((f: any) => f.id));
  for (const l of out.detail.doc.lines) assert(l.factIds.length && l.factIds.every((id: string) => confirmed.has(id)), `cited to confirmed facts: ${l.text}`);
  eq(CareerTailor.auditResume(out.detail.doc, confirmedOnly(profile)).ok, true, "the truth audit passes on exactly what printed");
  eq(out.sha256, r.sha256, "the same record and posting render the same file");
});

Deno.test("WO-028/3 the truth audit is a hard gate on what prints: an invented line or a refused assembly is refused, nothing stored", async () => {
  const profile = fixtureProfile(), store = memoryResumeStore();
  // A defective assembler that slips in a claim no fact supports (a number and a skill the record never states).
  const invents = (p: any, jd: any, o: any) => {
    const t = CareerTailor.tailorResume(p, jd, o);
    t.resume.sections[1].lines.push({ text: "Led Tableau migration for 5000 users", factIds: ["F-002"], type: "bullet" });
    return t;
  };
  const a = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(store, edgeRenderer(), invents), now: NOW });
  assert(!a.ok && a.refused === "truth_audit", "refused by the audit");
  assert(/Tableau|5000/.test(a.reason), `the reason names the claim: ${a.reason}`);
  const refused = () => ({ ok: false, refused: true, violations: [{ reason: 'skill "Rust" is not evidenced by the cited fact(s)' }] });
  const b = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(store, edgeRenderer(), refused), now: NOW });
  assert(!b.ok && b.refused === "truth_audit" && /Rust/.test(b.reason), "the assembler's own refusal is said with its reason");
  eq(store.files.size, 0, "nothing was stored");
  const { t } = tools({ store });
  // Through the tool: no confirmed facts, or no name and email, is a refusal with the reason.
  const empty = CareerProfile.createProfile({ basics: { name: "A B", email: "a@example.test" } });
  CareerProfile.addFact(empty, { kind: "experience", title: "Draft only", text: "Draft only", needs_confirmation: true });
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(empty)), /no confirmed experience.*Nothing was stored/);
  const noContact = fixtureProfile(); noContact.basics.email = null;
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(noContact)), /name and email are not on your profile/);
});

Deno.test("WO-028/4 the ATS parse harness: the real file passes; a file that drops lines, or loses the email, is refused and never offered", async () => {
  const profile = fixtureProfile();
  const ok = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(), now: NOW });
  assert(ok.ok);
  const doc = ok.detail.doc;
  const pdf = new Uint8Array(R.renderPdf(doc).buffer);
  eq(atsHarness(R, doc, pdf).pass, true);
  const cut = new Uint8Array(R.renderPdf({ ...doc, sections: doc.sections.slice(0, 1) }).buffer);
  const v = atsHarness(R, doc, cut);
  assert(!v.pass && v.reasons.some((x) => /missing_content/.test(x)), "lines missing from the file fail");
  const noMail = { ...doc, header: { ...doc.header, email: null } };
  assert(!atsHarness(R, noMail, new Uint8Array(R.renderPdf(noMail).buffer)).pass, "no email out of the file fails");
  // A renderer that drops a section: the tool refuses and stores nothing.
  const broken: ResumeRenderer = async (d) => {
    const r = R.renderPdf({ ...d, sections: d.sections.slice(0, 1) }), b = new Uint8Array(r.buffer);
    return { ok: true, pdf: b, sha256: R.sha256(r.buffer), filename: r.filename, ats: atsHarness(R, d, b), where: "test" };
  };
  const { t, store } = tools({ render: broken });
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)), /failed the ATS parse check: .*missing_content.*Nothing was stored/);
  eq(store.files.size, 0);
});

Deno.test("WO-028/5 where the PDF renders: Deno's node built-ins give Node's exact bytes; without them the tool says why and stores nothing", async () => {
  const profile = fixtureProfile();
  const out = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(), now: NOW });
  assert(out.ok);
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/doc.json`, JSON.stringify(out.detail.doc));
  const render148 = new URL("../../packages/domain/148-career-render.js", import.meta.url).pathname;
  const node = await new Deno.Command("node", { args: ["-e", `const R=require(${JSON.stringify(render148)});const d=require(process.argv[1]);process.stdout.write(R.sha256(R.renderPdf(d).buffer))`, `${dir}/doc.json`] }).output();
  eq(new TextDecoder().decode(node.stdout), out.sha256, "the edge renders the same bytes Node does");
  await Deno.remove(dir, { recursive: true });
  // The bundle's default instance in Deno has no require, so no zlib: honest refusal.
  eq((CareerRender as any).runtime.zlib, false, "the default Deno instance has no zlib");
  const { t, store } = tools({ render: renderWith(CareerRender, "this runtime") });
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)), /PDF could not be made: the PDF renderer needs zlib and crypto, which this runtime does not provide\. Nothing was stored/);
  eq(store.files.size, 0);
});

Deno.test("WO-028/6 the changelog is one plain line built from the diff, and claims nothing the diff does not hold", async () => {
  const profile = fixtureProfile();
  const out = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: deps(), now: NOW });
  assert(out.ok);
  console.log(`  changelog: ${out.changelog}`);
  assert(!out.changelog.includes("\n") && out.changelog.length <= 300, "one line");
  assert(!/[*#`_]/.test(out.changelog), "no markdown");
  const diff = CareerTailor.diffResume(baseResume(confirmedOnly(profile)).lines, out.detail.doc, confirmedOnly(profile));
  eq(diff, out.detail.diff, "the diff is the tailor's own diff against the base resume");
  assert(out.changes.length >= 2, "the fixture posting changes the resume");
  for (const c of out.changes) assert((diff as any)[c.diff].some((d: any) => d.text === c.line), `"${c.text}" is in the diff (${c.diff})`);
  assert(/^Led with Software Engineering Intern, TEST Systems Inc, which shows Python/.test(out.changelog), "leads with the dashboard work, and why");
  for (const c of out.changes.filter((x) => x.diff === "removed")) assert(diff.removed.some((d: any) => d.text === c.line), "every drop is a removal");
  assert(/; dropped Finance Intern, Example Capital \(TEST\), DeployBoard \(TEST project\) and MarketSim valuation project \(TEST\), which this posting doesn't ask for\.$/.test(out.changelog), "the dropped entries and why, in one clause");
  // A posting that names, anywhere, a skill a dropped entry shows (the finance internship's Excel, in its About us):
  // that drop is said without "doesn't ask for".
  const excel = DATA_POSTING.replace("(TEST posting)\n", "(TEST posting)\nAbout us: our analysts live in Excel.\n");
  const ex = await tailorForPosting({ userId: USER, profile, posting: { text: excel }, deps: deps(), now: NOW });
  assert(ex.ok);
  const fin = ex.changes.find((c) => c.kind === "drop" && c.name === "Finance Intern, Example Capital (TEST)");
  assert(fin && fin.why === "", "no 'doesn't ask for' when the posting names a skill the entry shows");
  assert(/; dropped Finance Intern, Example Capital \(TEST\)(;| and )/.test(ex.changelog) && !/Finance Intern, Example Capital \(TEST\), which/.test(ex.changelog), `said without a reason: ${ex.changelog}`);
  // Nothing changed: said as such.
  const same = { added: [], moved: [], removed: [] };
  eq(changelog({ diff: same, base: { lines: [] }, tailored: { lines: [] }, profile, jd: CareerTailor.parseJD(""), hidden: [], persona: null }).line,
    "Same as your base resume; it already fits this posting.");
});

Deno.test("WO-028/7 personas pick and order the same confirmed facts, never others; saved and switched only on the person's words", async () => {
  const profile = withDraft(fixtureProfile());
  const draftId = profile.facts.find((f: any) => f.needs_confirmation).id;
  const { t, personas } = tools();
  const say = (m: string) => ctx(profile, m);
  await rejects(() => t.save_resume_persona.run({ name: "banking", lead_fact_ids: ["F-003"] }, say("make me a resume")), /did not name a "banking" persona/);
  await rejects(() => t.save_resume_persona.run({ name: "banking", lead_fact_ids: [draftId] }, say("save a banking version")), /not a confirmed fact/);
  await rejects(() => t.save_resume_persona.run({ name: "banking", lead_fact_ids: ["F-099"] }, say("save a banking version")), /not a confirmed fact/);
  const s = await t.save_resume_persona.run({ name: "banking", lead_fact_ids: ["F-003", "F-005"], hide_fact_ids: ["F-004"] }, say("save a banking resume that leads with my finance internship and drops DeployBoard")) as any;
  eq(s.restated, "banking: leads with Finance Intern, Example Capital (TEST) (F-003), then MarketSim valuation project (TEST) (F-005); leaves out DeployBoard (TEST project) (F-004). Same confirmed facts, nothing added.");
  await t.save_resume_persona.run({ name: "data", lead_fact_ids: ["F-002"] }, say("and a data one too"));
  eq((await personas.get(USER)).items.map((p: any) => p.name), ["banking", "data"]);
  eq(PERSONAS_KEY, "career:resume-personas", "kept under the account's key, wiped by an erase with every other non-turn key");
  // The erase as it stands today (career_host_commit, last redefined by the timeline's erase migration).
  const erase = await Deno.readTextFile(new URL("../../supabase/migrations/20261020120100_career_events_erase.sql", import.meta.url));
  assert(erase.includes("delete from career_watch_kv where user_id=p_user and key not like 'career:turn:%'") && !PERSONAS_KEY.startsWith("career:turn:"), "the erase wipes it");
  await rejects(() => t.use_resume_persona.run({ name: "banking" }, say("what jobs are open")), /did not name that persona/);
  await rejects(() => t.use_resume_persona.run({ name: "sales" }, say("apply as my sales resume")), /no persona named sales; saved: banking, data/);
  const u = await t.use_resume_persona.run({ name: "banking" }, say("apply as my banking resume")) as any;
  eq([u.active, u.saved], ["banking", ["banking", "data"]]);
  // Tailoring now uses it: the same posting, the same confirmed facts, only picked and ordered differently.
  const plain = await tailorForPosting({ userId: USER, profile, posting: { text: BANK_POSTING }, deps: deps(), now: NOW });
  const st = await personas.get(USER);
  const banking = await tailorForPosting({ userId: USER, profile, posting: { text: BANK_POSTING }, persona: st.items[0], deps: deps(), now: NOW });
  assert(plain.ok && banking.ok);
  const entries = (o: any) => o.detail.doc.lines.filter((l: any) => l.type === "entry").map((l: any) => l.factIds[0]);
  eq(entries(banking)[0], "F-003", "leads with the persona's first fact");
  assert(!entries(banking).includes("F-004"), "the left-out fact is not on it");
  const facts = new Map(CareerProfile.confirmedFacts(profile).map((f: any) => [f.id, f]));
  for (const l of banking.detail.doc.lines) {
    if (l.type === "skills") continue;
    const f: any = facts.get(l.factIds[0]);
    const own = [f?.title, f?.text, ...(f?.bullets || [])].join(" ").toLowerCase();
    assert(f && (own.includes(l.text.toLowerCase()) || l.text.startsWith(String(f.title))), `a line of the cited fact's own: ${l.text}`);
  }
  const lineSet = (o: any) => o.detail.doc.lines.map((l: any) => l.text).sort();
  eq(lineSet(banking).filter((x: string) => !lineSet(plain).includes(x)), [], "a persona adds no line the plain tailoring could not");
  const viaTool = await t.tailor_resume.run({ job_id: "lever:test:IB-1" }, say("tailor it for the bank one")).catch((e: Error) => e.message);
  assert(/no posting lever:test:IB-1/.test(String(viaTool)), "an unknown job id is said");
  const { t: t2 } = tools({ personas, posting: async (id) => id === "lever:test:IB-1" ? { job_id: id, title: "Investment Banking Analyst", company: "Test Bank", description: BANK_POSTING } : null });
  const r = await t2.tailor_resume.run({ job_id: "lever:test:IB-1" }, say("tailor it for the bank one")) as any;
  eq([r.persona, r.company, r.job_id], ["banking", "Test Bank", "lever:test:IB-1"], "the active persona and the posting from its id");
  assert(/^Led with Finance Intern/.test(r.changelog), `the persona's lead is in the changelog: ${r.changelog}`);
  await t.use_resume_persona.run({ name: "base" }, say("go back to my regular resume"));
  eq((await personas.get(USER)).active, null);
});

Deno.test("WO-028/8 the approval card says a tailored resume and its persona; the payload is tagged; an untailored one is unchanged", async () => {
  eq(resumeCardLine("r.pdf", "b".repeat(64), { tailored: true, persona: "banking" }), `Resume: banking, tailored for this role (${"b".repeat(12)})`);
  eq(resumeCardLine("r.pdf", "b".repeat(64), { tailored: true, persona: null }), `Resume: your base resume, tailored for this role (${"b".repeat(12)})`);
  eq(resumeCardLine("r.pdf", "b".repeat(64), null), `Resume: r.pdf (${"b".repeat(12)})`);
  eq(takeResumeTag(["--tailored-resume", "banking", "--headed"]), { tag: { tailored: true, persona: "banking" }, rest: ["--headed"] });
  eq(takeResumeTag(["--tailored-resume", "base"]).tag, { tailored: true, persona: null });
  eq(takeResumeTag(["--headed"]), { tag: null, rest: ["--headed"] });
  const evidence = {
    approval_hash: "a".repeat(64), readback: {}, fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "F-1" }],
    payload: { user_id: USER, posting: "lever:test:1", company: "Test Co", destination: "https://jobs.lever.co/test/1", resume: { filename: "Alex_Testcase_Resume.pdf", sha256: "c".repeat(64) }, page_fields: {} },
  };
  const run = async () => ({ result: { state: "not_submitted", reason: "dry_run" }, evidence });
  const base = { url: "https://jobs.lever.co/test/1", factsPath: "f", resumePath: "r", account: { epoch: 1, version: 1 }, now: NOW, runEngine: run };
  const tailored = await prepare({ ...base, resumeTag: { tailored: true, persona: "banking" } });
  const plain = await prepare(base);
  assert(tailored.ready && plain.ready);
  assert(tailored.card.includes(`Resume: banking, tailored for this role (${"c".repeat(12)})`), "the card line");
  eq([tailored.payload.resume_tailored, tailored.payload.resume_persona], [true, "banking"]);
  eq(tailored.hash, await hashApplyPayload(tailored.payload), "the tag is inside what is approved");
  assert(!("resume_tailored" in plain.payload) && !("resume_persona" in plain.payload), "an untailored payload is exactly as before");
  assert(plain.card.includes(`Resume: Alex_Testcase_Resume.pdf (${"c".repeat(12)})`));
});

Deno.test("WO-028/9 callbackRate: tailored vs untailored with counts, sent applications only, NOT enough data under 30 per arm", () => {
  const rows = (n: number, tailored: boolean, replied: number, interviewed: number) =>
    Array.from({ length: n }, (_, i) => ({ tailored, state: "confirmed", replied: i < replied, interviewed: i < interviewed }));
  const small = callbackRate([...rows(12, true, 3, 1), ...rows(4, false, 0, 0), { tailored: true, state: "failed", replied: true }]);
  eq([small.tailored.applications, small.tailored.replies, small.tailored.interviews], [12, 3, 1], "a failed application is not counted");
  eq(small.enough, false);
  eq(small.label, "NOT enough data: 12 tailored and 4 untailored applications sent; 30 of each are needed before the rates mean anything.");
  const big = callbackRate([...rows(40, true, 10, 4), ...rows(30, false, 3, 1)]);
  eq(big.enough, true);
  eq([big.tailored.reply_rate, big.untailored.reply_rate], [0.25, 0.1]);
  eq(big.label, "Tailored: replies 25% (10 of 40), interviews 10% (4 of 40). Untailored: replies 10% (3 of 30), interviews 3.3% (1 of 30).");
  eq(callbackRate([...rows(30, true, 0, 0), ...rows(29, false, 0, 0)]).enough, false, "29 in one arm is not enough");
  eq(callbackRate([]).tailored.reply, "n/a (0 of 0)");
});

Deno.test("WO-028/10 storage: <user_id>/<sha256>.pdf in the private bucket; a public or foreign link is never offered", async () => {
  const sha = "d".repeat(64);
  eq(resumePath(USER, sha), `${USER}/${sha}.pdf`);
  for (const bad of [["../x", sha], [USER, "abc"], [`${USER}/x`, sha]]) { let threw = false; try { resumePath(bad[0], bad[1]); } catch { threw = true; } assert(threw, `refused: ${bad}`); }
  const path = `${USER}/${sha}.pdf`, base = "https://p.supabase.co/storage/v1/object";
  eq(privateLinkProblem(`${base}/sign/career-resumes/${path}?token=x`, path), null);
  eq(privateLinkProblem(`${base}/public/career-resumes/${path}`, path), "the link is a public object URL");
  eq(privateLinkProblem(`${base}/sign/career-resumes/${USER}/${"e".repeat(64)}.pdf?token=x`, path), "the link is not a signed link to this resume");
  eq(privateLinkProblem(`${base}/sign/career-resumes/${path}`, path), "the link carries no signature");
  eq(privateLinkProblem(`http://p.supabase.co/storage/v1/object/sign/career-resumes/${path}?token=x`, path), "the link is not https");
  const migration = await Deno.readTextFile(new URL("../../supabase/migrations/20261020130000_career_resume_tailoring.sql", import.meta.url));
  assert(/values \('career-resumes', 'career-resumes', false,/.test(migration) && /set public = false/.test(migration), "the bucket is created private and kept private");
  assert(!/for (insert|update|delete|all) to authenticated/.test(migration), "no person may write there; only the service role stores");
  // A store that hands back a public URL: the tool refuses to offer it.
  const store = memoryResumeStore();
  const leaky = { ...store, signedUrl: async (p: string) => `https://p.supabase.co/storage/v1/object/public/career-resumes/${p}` };
  const { t } = tools({ store: leaky });
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(fixtureProfile())), /not offered: the link is a public object URL\. The file stays private; no link was given/);
});

Deno.test("WO-028/11 the name and email at the top come only from what the person typed this turn", async () => {
  const profile = fixtureProfile();
  profile.basics.name = null; profile.basics.email = null;
  const { t, store } = tools();
  await rejects(() => t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)), /Ask exactly: "What name and email should go at the top of your resume\?"/);
  eq(store.files.size, 0);
  // The model passes an email the person never typed (the account's, a guess): refused.
  await rejects(() => t.set_resume_contact.run({ name: "Alex Testcase", email: "alex@account.example.test" }, ctx(profile, "it's Alex Testcase, alex.testcase@example.test")), /did not type that email.*What name and email should go at the top of your resume\?/);
  await rejects(() => t.set_resume_contact.run({ name: "Alex Testcase", email: "alex.testcase@example.test" }, ctx(profile, "my email is alex.testcase@example.test")), /did not type that name/);
  await rejects(() => t.set_resume_contact.run({ name: "Alex T3stcase", email: "alex.testcase@example.test" }, ctx(profile, "Alex T3stcase alex.testcase@example.test")), /2 to 80 letters/);
  await rejects(() => t.set_resume_contact.run({ name: "Alex Testcase", email: "alex.testcase@example" }, ctx(profile, "Alex Testcase alex.testcase@example")), /not a valid email/);
  await rejects(() => t.set_resume_contact.run({ name: "Alex Testcase", email: "testcase@example.test" }, ctx(profile, "Alex Testcase, alex.testcase@example.test")), /did not type that email/);
  eq([profile.basics.name, profile.basics.email], [null, null], "nothing saved by a refusal");
  const s = await t.set_resume_contact.run({ name: "alex   TESTCASE", email: "Alex.Testcase@Example.test" }, ctx(profile, "Put ALEX testcase and alex.testcase@example.test at the top")) as any;
  eq(s.restated, "Your resume will show alex TESTCASE and Alex.Testcase@Example.test at the top.");
  eq([profile.basics.name, profile.basics.email], ["alex TESTCASE", "Alex.Testcase@Example.test"]);
  const r = await t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)) as any;
  assert(r.link && store.files.size === 1, "after saving, the resume is made end to end");
  assert(pdfText(store.files.get(`career-resumes/${resumePath(USER, r.sha256)}`)!).includes("Alex.Testcase@Example.test"), "the typed email prints");
});

Deno.test("WO-028/12 the text the person reads is plain on every channel: the link alone on its own line, no markdown, no channel names", async () => {
  const profile = fixtureProfile();
  const { t } = tools();
  const r = await t.tailor_resume.run({ posting_text: DATA_POSTING }, ctx(profile)) as any;
  const lines = r.text.split("\n");
  assert(lines.includes(r.link), "the link stands alone on its own line");
  eq(lines.filter((l: string) => l.includes("https://")).length, 1, "and only there");
  assert(/^Your resume for this posting is ready\. Led with /.test(lines[0]), lines[0]);
  eq(lines.at(-1), "The link works for 7 days.");
  const said: string[] = [r.text, r.changelog];
  for (const x of careerTools({ postings: async () => [] }).filter((x) => /resume/.test(x.name))) said.push(x.description);
  const s = await t.save_resume_persona.run({ name: "data", lead_fact_ids: ["F-002"] }, ctx(profile, "save my data resume")) as any;
  said.push(s.restated, (await t.use_resume_persona.run({ name: "base" }, ctx(profile, "use my base resume")) as any).restated);
  said.push((await t.set_resume_contact.run({ name: "Alex Testcase", email: "a@example.test" }, ctx(profile, "Alex Testcase a@example.test")) as any).restated);
  for (const x of said) {
    assert(!/imessage|whatsapp|telegram|\bsms\b/i.test(x), `no channel names: ${x}`);
    assert(!/[*`#]|\]\(|^\s*[-•] /m.test(x), `no markdown: ${x}`);
  }
});

Deno.test("WO-028/13 tailored resumes go with the person: the career erase and account deletion remove them", async () => {
  const store = memoryResumeStore();
  await store.put(`${USER}/${"a".repeat(64)}.pdf`, new Uint8Array([1]));
  await store.put(`${USER}/${"b".repeat(64)}.pdf`, new Uint8Array([2]));
  await store.put(`00000000-0000-4000-8000-000000000099/${"c".repeat(64)}.pdf`, new Uint8Array([3]));
  eq(await store.removeAll(USER), 2);
  eq([...store.files.keys()], [`career-resumes/00000000-0000-4000-8000-000000000099/${"c".repeat(64)}.pdf`], "only their own folder");
  const handler = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  // The save is the evidenced commit (commitTurn wraps persistence.commit since #318).
  const commit = handler.indexOf("saved = await commitTurn("), erase = handler.indexOf("if (ctx._hostPatch?.erase === true) await supabaseResumeStore(admin).removeAll(user.id)");
  assert(commit > 0 && erase > commit, "the erase removes them once it is recorded");
});
