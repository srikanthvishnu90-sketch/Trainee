// RELEASE 9 workstream B (outcomes): each tailored file is recorded by version, layout and kind of change when it is made; the
// application that carries it is tagged at apply time (20261107120000, tested in tests/db/career_resume_outcomes.test.sql);
// the person's File page shows response, interview and offer rates by version, tailoring, layout and change, read only.
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryPersonaStore, memoryResumeStore, MIN_PER_ARM } from "../../supabase/functions/_shared/career_tailor.ts";
import { changeKinds, MAX_VERSIONS, memoryVersionLog, MIN_PER_GROUP, rateLines, ratesHtml, ratesText, type RateRow, recordVersion, VERSIONS_KEY, withVersion } from "../../supabase/functions/_shared/career_resume_outcomes.ts";
import { esc, renderFeed, renderText } from "../../supabase/functions/_shared/file_page.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
void zlib; void crypto; void Buffer;

const USER = "00000000-0000-4000-8000-0000000009c1";
const NOW = Date.UTC(2026, 10, 7, 15);
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
function fixtureProfile() {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" } });
  CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
const POSTING = `Data Analyst, Acme Analytics (TEST posting)
Requirements:
- Experience with SQL and PostgreSQL, Python, and Tableau
- Build dashboards for internal users
Nice to have: React`;
const BANK = `Investment Banking Analyst, Test Bank (TEST posting)
Requirements:
- Financial modeling and valuation in Excel
- Prepare investment committee materials`;

Deno.test("outcomes/1 versions: numbered in the order this person's files were made; the same file keeps its number; capped", () => {
  let s = { next: 1, files: {} };
  const a = withVersion(s, { sha256: "a".repeat(64), layout: "trainee", changes: ["reorder"], job_id: "J1", now: NOW });
  eq(a.version, "resume-v1"); s = a.state;
  const b = withVersion(s, { sha256: "b".repeat(64), layout: "plain", changes: [], job_id: null, now: NOW });
  eq(b.version, "resume-v2"); s = b.state;
  const again = withVersion(s, { sha256: "a".repeat(64), layout: "own", changes: ["drop"], job_id: "J9", now: NOW });
  eq([again.version, again.state === s, (again.state.files as any)["a".repeat(64)].layout], ["resume-v1", true, "trainee"], "the same file: its first record stands");
  let big = { next: 1, files: {} } as any;
  for (let i = 0; i < MAX_VERSIONS + 5; i++) big = withVersion(big, { sha256: i.toString(16).padStart(64, "0"), layout: "plain", changes: [], job_id: null, now: NOW }).state;
  eq([Object.keys(big.files).length, big.next, (big.files as any)["0".repeat(64)]], [MAX_VERSIONS, MAX_VERSIONS + 6, undefined], "the oldest go; numbers never repeat");
  let threw = false;
  try { withVersion(s, { sha256: "nope", layout: "plain", changes: [], job_id: null, now: NOW }); } catch { threw = true; }
  assert(threw, "a malformed hash is refused");
  eq(changeKinds([{ kind: "lead" }, { kind: "drop" }, { kind: "drop" }, { kind: "kept" }, { kind: "reword" }, { kind: "skills" }]), ["drop", "reorder", "reword", "skills"]);
  eq(MIN_PER_GROUP, MIN_PER_ARM, "the same floor as the tailored-vs-untailored report");
  eq(VERSIONS_KEY.startsWith("career:") && !VERSIONS_KEY.startsWith("career:turn:"), true, "a key the career erase deletes");
});

Deno.test("outcomes/2 tailor_resume records each file it makes, with its layout and kinds of change; a failed record never stops the file", async () => {
  const versions = memoryVersionLog(), store = memoryResumeStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer(), versions } }).map((x) => [x.name, x]));
  const ctx = { userId: USER, threadId: "t1", now: NOW, state: { profile: fixtureProfile() } as Record<string, any>, turn: { message: "make me a resume for this one", added: [] as string[] } };
  const r1 = await t.tailor_resume.run({ posting_text: POSTING, layout: "trainee" }, ctx) as any;
  const r2 = await t.tailor_resume.run({ posting_text: BANK }, ctx) as any;
  const again = await t.tailor_resume.run({ posting_text: POSTING, layout: "trainee" }, ctx) as any;
  const s = versions.rows.get(USER)!;
  eq([s.next, s.files[r1.sha256].n, s.files[r1.sha256].layout, s.files[r2.sha256].n, s.files[r2.sha256].layout], [3, 1, "trainee", 2, "plain"]);
  eq(again.sha256, r1.sha256, "the same record and posting make the same file, which keeps resume-v1");
  eq(s.files[r1.sha256].changes, changeKinds(r1.changes), "its kinds of change are the changelog's");
  assert(typeof r1.gaps?.summary === "string" && typeof r1.preview === "string", "the gap summary and preview reach the model");
  const broken = { get: async () => { throw new Error("db down"); }, save: async () => {} };
  const t2 = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer(), versions: broken } }).map((x) => [x.name, x]));
  const r3 = await t2.tailor_resume.run({ posting_text: POSTING }, ctx) as any;
  assert(r3.link, "the file still goes");
  eq(await recordVersion(broken, { userId: USER, out: r3, now: NOW }), null);
});

const ROWS: RateRow[] = [
  { dimension: "tailoring", bucket: "tailored", sent: 40, responses: 10, interviews: 4, offers: 1, response_per_100: 25, interview_per_100: 10, offer_per_100: 2.5 },
  { dimension: "tailoring", bucket: "untailored", sent: 12, responses: 1, interviews: 0, offers: 0, response_per_100: 8.3, interview_per_100: 0, offer_per_100: 0 },
  { dimension: "version", bucket: "resume-v2", sent: 31, responses: 9, interviews: 4, offers: 1, response_per_100: 29, interview_per_100: 12.9, offer_per_100: 3.2 },
  { dimension: "version", bucket: "<b>resume-v1</b>", sent: 9, responses: 1, interviews: 0, offers: 0, response_per_100: 11.1, interview_per_100: 0, offer_per_100: 0 },
  { dimension: "change_type", bucket: "reword", sent: 31, responses: 9, interviews: 4, offers: 1, response_per_100: 29, interview_per_100: 12.9, offer_per_100: 3.2 },
];
Deno.test("outcomes/3 the File page section: rates by tailoring, version and change, counts beside every rate, small groups marked, read only", () => {
  const groups = rateLines(ROWS);
  eq(groups.map((g) => g.title), ["Tailored or not", "By resume version", "By kind of change"], "only the groups with data, in a fixed order");
  eq(groups[0].lines.map((l) => [l.label, l.sent, l.interviews, l.enough]), [["Tailored", 40, "10% (4 of 40)", true], ["Not tailored", 12, "0% (0 of 12)", false]]);
  const text = ratesText(ROWS);
  assert(/Not tailored: 12 sent; responses 8\.3% \(1 of 12\); interviews 0% \(0 of 12\); offers 0% \(0 of 12\) \(too few to compare\)/.test(text), text);
  eq(ratesText([]), "How your resumes are doing: no application has reached an employer yet.");
  const html = ratesHtml(ROWS, esc);
  assert(html.includes("&lt;b&gt;resume-v1&lt;/b&gt;") && !html.includes("<b>resume-v1"), "escaped");
  assert(!/<form|<button|<input/.test(html), "read only: no control");
  const page = renderFeed({ token: "t", rows: [], setHash: null, setSize: 0, resumeRates: ROWS });
  assert(page.includes(`<h2 id="rates-h">How your resumes are doing</h2>`) && page.includes(".rates-sec"), "the section and its style are on the page");
  assert(!/#[0-9a-f]{6}/i.test(page.slice(page.indexOf(".rates-sec{"), page.indexOf(".rates-sec{") + 600)), "the section's style uses the brand tokens, no new colour");
  const none = renderFeed({ token: "t", rows: [], setHash: null, setSize: 0 });
  assert(!none.includes("rates-sec"), "no rates read: the page is as it was");
  assert(renderText({ token: "t", rows: [], setHash: null, setSize: 0, resumeRates: ROWS }).includes("How your resumes are doing"), "the plain-text twin carries it");
});

Deno.test("outcomes/4 the migration: additive, run by the DB suite twice with its rollback, and the File page reads it as a section", async () => {
  const root = new URL("../../", import.meta.url);
  const sql = await Deno.readTextFile(new URL("supabase/migrations/20261107120000_career_resume_outcomes.sql", root));
  const down = await Deno.readTextFile(new URL("supabase/rollbacks/20261107120000_career_resume_outcomes.down.sql", root));
  const sh = await Deno.readTextFile(new URL("tests/db/run.sh", root));
  assert(!/\bdrop\s+(table|column)|\bdelete\s+from|\bupdate\s+public\./i.test(sql), "nothing dropped, deleted or rewritten");
  assert(/with \(security_invoker = true\)/.test(sql) && /revoke all on public\.career_apply_outcomes_by_resume from public, anon/.test(sql), "invoker rights; nobody signed out");
  assert(/security definer set search_path = public, pg_temp/.test(sql) && /revoke all on function public\.career_apply_resume_version_tag\(\) from public, anon, authenticated/.test(sql), "the trigger function is locked down");
  assert(/drop view if exists public\.career_apply_outcomes_by_resume/.test(down) && /drop column if exists resume_version/.test(down), "the rollback undoes it");
  assert((sh.match(/20261107120000_career_resume_outcomes\.sql/g) || []).length >= 3 && sh.includes("career_resume_outcomes.test.sql") && sh.includes("rollbacks/20261107120000_career_resume_outcomes.down.sql"), "the DB suite applies it twice, tests it and rolls it back");
  const deps = await Deno.readTextFile(new URL("supabase/functions/trainee-file/deps.ts", root));
  assert(/resumeRates: supabaseResumeRates\(admin\)/.test(deps), "the deployed File page reads the rates");
});
