// R10 WO-E part 2 (spec C.3-C.6, C.8-C.10, D.4): F-01 career brief, F-02 profile facts, F-03 path comparison, F-04 search plan,
// F-06 role workspace, F-07 materials studio, F-08 answer library. Strings first (what each File must and must not say), then the
// visual checker in Chromium at 390 and 1280 px (r10-files-check.ts). Fails on trunk: file_family_plan.ts does not exist there.
import assert from "node:assert/strict";
import { familyBodyHtml, familyPage, type FamilyFile } from "../../supabase/functions/_shared/file_family.ts";
import { answerLibraryFile, careerBriefFile, materialsFile, pathComparisonFile, profileFactsFile, roleWorkspaceFile, searchPlanFile } from "../../supabase/functions/_shared/file_family_plan.ts";
import { checkPages } from "./r10-files-check.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { answers, brief, materials, paths, profile, search, workspace } from "./r10-files-fixtures-2.ts";

// Every File page has the header's back and overflow controls (C.1 item 2; p-43 to p-66).
const nav = (f: FamilyFile): FamilyFile => ({ ...f, back: "/f", menu: f.menu ?? [{ label: "Export", effect: "download", href: "/files/export.json" }, { label: "Close this File", effect: "navigate", href: "/f" }] });
const FILES = { "F-01-career-brief": () => nav(careerBriefFile(brief())), "F-02-profile-facts": () => nav(profileFactsFile(profile())), "F-03-path-comparison": () => nav(pathComparisonFile(paths())),
  "F-04-search-plan": () => nav(searchPlanFile(search())), "F-06-role-workspace": () => nav(roleWorkspaceFile(workspace())), "F-07-materials-studio": () => nav(materialsFile(materials())),
  "F-08-answer-library": () => nav(answerLibraryFile(answers())) };
const html = (k: keyof typeof FILES) => familyBodyHtml(FILES[k](), CTX);

Deno.test("R10 WO-E 2: every family File has its header (back, overflow, boundary or ids), a time in the person's zone, and one filled primary at most", () => {
  for (const k of Object.keys(FILES) as (keyof typeof FILES)[]) {
    const h = html(k);
    assert.match(h, /<a class="ff-sq" href="\/f" aria-label="Back">[\s\S]*<summary class="ff-sq" aria-label="More actions">/, k);
    assert.match(h, k === "F-06-role-workspace" ? /<p class="ff-hs"><span class="ff-id">R-07 - A-014<\/span><\/p>/ : /<p class="ff-hs">[^<]*(only you|never sent|no applications|not applying|nothing|inspectable)/i, k);
    if (FILES[k]().hero) assert.match(h, /<time datetime="2026-11-0\dT[\d:.]+Z">Today \d{1,2}:\d\d [AP]M CT<\/time>/, k);
    else assert.doesNotMatch(h, /class="ff-hero"/, k); // F-02 and F-08 have no hero (p-46, p-64)
    assert.ok((h.match(/ff-btn ff-pri/g) ?? []).length <= 1, `${k}: more than one filled primary`);
    assert.doesNotMatch(h, /\b\d{1,3}\s?% (chance|odds|likely)|hiring odds of/i, k);
  }
});

Deno.test("R10 WO-E 2: missing facts show as unconfirmed, never guessed; sensitive fields stay the person's", () => {
  const p = html("F-02-profile-facts");
  assert.match(p, /Conflict to resolve\./); assert.match(p, /Confirmed <b>3<\/b>[\s\S]*Estimates <b>1<\/b>[\s\S]*Inferred <b>1<\/b>[\s\S]*Needs review <b>2<\/b>/);
  assert.match(p, /3 years<span class="ff-src"> - resume, confirmed<\/span>/); assert.match(p, /- your estimate/); assert.match(p, /never sent to employers/);
  assert.doesNotMatch(p, /Expected graduation/); // a fact under review stays in the conflict banner, never in the confirmed sample
  const missing = familyBodyHtml(profileFactsFile({ facts: [{ k: "Expected graduation", v: null, kind: "confirmed", src: null }] }), CTX);
  assert.match(missing, /Expected graduation<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Unconfirmed<\/span>/);
  const a = html("F-08-answer-library");
  assert.match(a, /2 weeks<span class="ff-src"> - you, <time datetime="2026-10-28T15:00:00.000Z">Oct 28<\/time>/);
  assert.match(a, /New declaration on R-07\.[\s\S]*blocks submission until you review it/);
  assert.match(a, /Answer: &quot;No&quot; - scoped to US-remote roles\. A role in Austin would ask again, not reuse silently\./); // the answer and its scope on one line
  const s = html("F-04-search-plan");
  assert.match(s, /Undisclosed pay<\/dt><dd><span class="ff-v" data-claim="1" data-src="personal">Include, marked unknown/);
  assert.match(s, /Plan v1 - searching is not applying/); assert.match(s, /Watching never submits anything\./);
});

Deno.test("R10 WO-E 2: a posting fact carries its link and read time; the role workspace keeps hard eligibility separate and says who does each step", () => {
  const w = html("F-06-role-workspace");
  assert.match(w, /<span class="ff-sr">Met: <\/span><strong>Met:<\/strong> <span class="ff-v" data-claim="1" data-src="external">US remote<span class="ff-src"> - employer page verified <time datetime="2026-11-09T15:31:00.000Z">9:31 AM today<\/time>[\s\S]*?href="https:\/\/jobs\.lever\.co\/examplecarbon\/cc-2214"/);
  assert.match(w, /ff-ck-unknown[\s\S]*Unknown:<\/strong> Travel %/);
  assert.match(w, /Execution route[\s\S]*Supported: Form fill[\s\S]*submitted only after your approval/); assert.match(w, /never pre-checked/);
  assert.match(w, /class="ff-btn ff-sec ff-danger" href="\?exclude=R-07"/);
});

Deno.test("R10 WO-E 2: materials: download retrieves (or says the file is not produced), the change summary shows before and after, approval names its role", () => {
  const m = html("F-07-materials-studio");
  assert.match(m, /<a class="ff-btn ff-sec ff-dl" href="\/files\/operations-resume-v3\.pdf" download data-effect="download">/);
  assert.match(m, /<del class="ff-old"><span class="ff-sr">Before: <\/span>Managed scheduling tools<\/del> <ins class="ff-new"><span class="ff-sr">After: <\/span>Led scheduling rollout, 4 teams<\/ins>/);
  assert.match(m, /Change summary - v2 → v3 - 1 fact needed/);
  assert.match(m, /<button type="submit" class="ff-btn ff-pri" data-effect="approve">Approve v3 for R-07<\/button>/);
  assert.match(m, /Downloading never submits\./); assert.match(m, /Never fabricated\./);
  const none = familyBodyHtml(materialsFile(materials(null)), CTX);
  assert.match(none, /disabled data-effect="download">[\s\S]*Download<\/button><span class="ff-off">The file has not been produced yet/);
  assert.doesNotMatch(none, / download data-effect/);
});

Deno.test("R10 WO-E 2: the brief marks a provisional reading, the path comparison names evidence strength and predicts no odds", () => {
  const b = html("F-01-career-brief");
  assert.match(b, /Provisional reading - you can change this anytime\./); assert.match(b, /ff-ck-done[\s\S]*ff-ck-todo/);
  assert.match(b, /Updated <b><time datetime="2026-11-09T15:32:00.000Z">Today 9:32 AM CT<\/time><\/b>/);
  const p = html("F-03-path-comparison");
  assert.match(p, /Strong evidence[\s\S]*Partial evidence/); assert.match(p, /Hiring odds are not predicted\./);
});

const PAGES = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, () => familyPage(f(), CTX)]));
Deno.test({ name: "R10 WO-E 2: F-01 to F-04 and F-06 to F-08 pass the visual checker at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false,
  async fn(t) { await checkPages(t, PAGES); } });
