// R10 WO-E part 2 (spec C.3-C.6, C.8-C.10, D.4): F-01 career brief, F-02 profile facts, F-03 path comparison, F-04 search plan,
// F-06 role workspace, F-07 materials studio, F-08 answer library. Strings first (what each File must and must not say), then the
// visual checker in Chromium at 390 and 1280 px (r10-files-check.ts). Fails on trunk: file_family_plan.ts does not exist there.
import assert from "node:assert/strict";
import { familyBodyHtml, familyPage } from "../../supabase/functions/_shared/file_family.ts";
import { answerLibraryFile, careerBriefFile, materialsFile, pathComparisonFile, profileFactsFile, roleWorkspaceFile, searchPlanFile } from "../../supabase/functions/_shared/file_family_plan.ts";
import { checkPages } from "./r10-files-check.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { answers, brief, materials, paths, profile, search, workspace } from "./r10-files-fixtures-2.ts";

const FILES = { "F-01-career-brief": () => careerBriefFile(brief()), "F-02-profile-facts": () => profileFactsFile(profile()), "F-03-path-comparison": () => pathComparisonFile(paths()),
  "F-04-search-plan": () => searchPlanFile(search()), "F-06-role-workspace": () => roleWorkspaceFile(workspace()), "F-07-materials-studio": () => materialsFile(materials()),
  "F-08-answer-library": () => answerLibraryFile(answers()) };
const html = (k: keyof typeof FILES) => familyBodyHtml(FILES[k](), CTX);

Deno.test("R10 WO-E 2: every family File has its header boundary, a freshness time in the person's zone, and one filled primary at most", () => {
  for (const k of Object.keys(FILES) as (keyof typeof FILES)[]) {
    const h = html(k);
    assert.match(h, /<p class="ff-hs">(?:<span class="ff-id">[^<]*<\/span> · )?[^<]*(only you|never sent|no applications|not applying|nothing|without your approval|inspectable)/i, k);
    assert.match(h, /<time datetime="2026-11-0\dT[\d:.]+Z">[^<]*(CT|, 2026)<\/time>/, k);
    assert.ok((h.match(/ff-btn ff-pri/g) ?? []).length <= 1, `${k}: more than one filled primary`);
    assert.doesNotMatch(h, /\b\d{1,3}\s?% (chance|odds|likely)|hiring odds of/i, k);
  }
});

Deno.test("R10 WO-E 2: missing facts show as unconfirmed, never guessed; sensitive fields stay the person's", () => {
  const p = html("F-02-profile-facts");
  assert.match(p, /Conflict to resolve\./); assert.match(p, /Confirmed <b>3<\/b>[\s\S]*Estimates <b>1<\/b>[\s\S]*Inferred <b>1<\/b>[\s\S]*Needs review <b>2<\/b>/);
  assert.match(p, /Expected graduation<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Unconfirmed<\/span>/);
  assert.match(p, /Your estimate/); assert.match(p, /never sent to employers/);
  const a = html("F-08-answer-library");
  assert.match(a, /Work authorization<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Not entered - yours to answer/);
  assert.match(a, /New declaration on R-07\.[\s\S]*blocks submission until you review it/);
  assert.match(a, /Answer: &quot;No&quot; - scoped to US-remote roles\./); // the answer and its scope on one line
  const s = html("F-04-search-plan");
  assert.match(s, /Undisclosed pay<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Not decided - you were asked/);
  assert.match(s, /Plan v1 - searching is not applying/); assert.match(s, /Watching never submits anything\./);
});

Deno.test("R10 WO-E 2: a posting fact carries its link and read time; the role workspace keeps hard eligibility separate and says who does each step", () => {
  const w = html("F-06-role-workspace");
  assert.match(w, /<span class="ff-sr">Met: <\/span><strong>Met:<\/strong> <span class="ff-v" data-claim="1" data-src="external">US remote[\s\S]*?<time datetime="2026-11-09T15:31:00.000Z">Nov 9, 2026, 9:31 AM CT<\/time>[\s\S]*?href="https:\/\/jobs\.lever\.co\/examplecarbon\/cc-2214"/);
  assert.match(w, /ff-ck-unknown[\s\S]*Unknown:<\/strong> Travel %/);
  assert.match(w, /Execution route[\s\S]*submitted only after your approval/); assert.match(w, /never pre-checked/);
  assert.match(w, /class="ff-btn ff-sec ff-danger" href="\?exclude=R-07"/);
});

Deno.test("R10 WO-E 2: materials: download retrieves (or says the file is not produced), the change summary shows before and after, approval names its role", () => {
  const m = html("F-07-materials-studio");
  assert.match(m, /<a class="ff-btn ff-sec ff-dl" href="\/files\/operations-resume-v3\.pdf" download data-effect="download">/);
  assert.match(m, /<del class="ff-old"><span class="ff-sr">Before: <\/span>Managed scheduling tools<\/del>[\s\S]*<ins class="ff-new"><span class="ff-sr">After: <\/span>Led scheduling rollout, 4 teams<\/ins>/);
  assert.match(m, /<button type="submit" class="ff-btn ff-pri" data-effect="approve">Approve v3 for R-07<\/button>/);
  assert.match(m, /Downloading never submits\./); assert.match(m, /Never fabricated\./);
  const none = familyBodyHtml(materialsFile(materials(null)), CTX);
  assert.match(none, /disabled data-effect="download">[\s\S]*Download<\/button><span class="ff-off">The file has not been produced yet/);
  assert.doesNotMatch(none, / download data-effect/);
});

Deno.test("R10 WO-E 2: the brief marks a provisional reading, the path comparison names evidence strength and predicts no odds", () => {
  const b = html("F-01-career-brief");
  assert.match(b, /Provisional reading - you can change this anytime\./); assert.match(b, /ff-ck-done[\s\S]*ff-ck-todo/);
  assert.match(b, /Updated <b><time datetime="2026-11-09T15:32:00.000Z">Nov 9, 2026, 9:32 AM CT<\/time><\/b>/);
  const p = html("F-03-path-comparison");
  assert.match(p, /Strong evidence[\s\S]*Partial evidence/); assert.match(p, /Hiring odds are not predicted\./);
});

const PAGES = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, () => familyPage(f(), CTX)]));
Deno.test({ name: "R10 WO-E 2: F-01 to F-04 and F-06 to F-08 pass the visual checker at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false,
  async fn(t) { await checkPages(t, PAGES); } });
