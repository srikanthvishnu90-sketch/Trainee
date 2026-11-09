// R10 WO-E: each File family's non-negotiables (APP-LAYER-15-FIXES.md C.3-C.18, one line each in E.8 items 63-78) tested as
// behaviour: every test feeds the builder data that WOULD break the rule and checks the page holds it. Test names carry the spec id.
// Fictional specimens (file_family_specimens.ts) and fixtures only; the clock and zone are inputs.
import assert from "node:assert/strict";
import { type Ctx, familyBodyHtml, type FamilyFile } from "../../supabase/functions/_shared/file_family.ts";
import { answerLibraryFile, careerBriefFile, materialsFile, pathComparisonFile, profileFactsFile, roleWorkspaceFile, searchPlanFile } from "../../supabase/functions/_shared/file_family_plan.ts";
import { applicationReviewFile, batchFile, interviewHubFile, messageReviewFile, negotiationFile, offerComparisonFile, pipelineFile, weeklyBriefFile } from "../../supabase/functions/_shared/file_family_apply.ts";
import { rolesShortlistPage } from "../../supabase/functions/_shared/file_family_roles.ts";
import * as S from "../../supabase/functions/_shared/file_family_specimens.ts";
import { CTX, role, shortlist } from "./r10-files-fixtures.ts";

const page = (f: FamilyFile, c: Ctx = CTX) => familyBodyHtml(f, c);
const NOW = Date.parse("2026-11-09T15:45:00Z");

Deno.test("E-63 F-01: provisional reading labeled; work authorization, seniority, pay floor and relocation never assumed; a correction flags dependents, never restarts", () => {
  const h = page(careerBriefFile({ ...S.brief(), constraints: ["US remote", { label: "Senior level", from: "inferred" }, { label: "Willing to relocate to Austin", from: "inferred" }, { label: "Needs no sponsorship", from: "inferred" }, { label: "Likes small teams", from: "inferred" }],
    corrections: [{ fact: "Northwind end date", was: "Jun 2024", now: "Mar 2024", dependents: ["R-07 application", "Operations resume v3"] }] }));
  assert.match(h, /Provisional reading - you can change this anytime\./);
  const chips = h.slice(h.indexOf("Hard constraints"), h.indexOf("</div>", h.indexOf("Hard constraints")));
  for (const x of ["Senior level", "relocate", "sponsorship", "Likes small teams"]) assert.ok(!chips.includes(x), `${x} drawn as a constraint`);
  for (const x of ["Confirm: Senior level?", "Confirm: Willing to relocate to Austin?", "Confirm: Needs no sponsorship?"]) assert.ok(h.includes(x), x);
  assert.match(h, /Not assumed\. Trainee only uses it once you say so\./);
  assert.match(h, /Corrected: Northwind end date\.[\s\S]*Flagged for a re-check because they used it: R-07 application; Operations resume v3\.[\s\S]*nothing restarts/);
  assert.match(h, /Career brief - v2/, "same version: the brief is not restarted");
});

Deno.test("E-64 F-02: the four categories never silently upgrade; sensitive answers are per application and never reused; \"prefer not to say\" kept", () => {
  const h = page(profileFactsFile({ ...S.profile(), facts: [...S.profile().facts,
    { k: "Salary expectation", v: "$90,000", kind: "estimate", src: { label: "chat" } }, { k: "Team size", v: "8 people", kind: "confirmed", src: null },
    { k: "Work authorization", v: "US citizen", kind: "confirmed", src: { label: "you" } }, { k: "Veteran status", v: "Prefer not to say", kind: "confirmed", src: { label: "you" } }],
    achievements: [{ text: "Led scheduling rollout across 4 teams", date: "Mar 2023", src: { label: "resume, confirmed" }, reuse: { label: "Stop reusing", effect: "decide", href: "?stop=rollout" } }] }));
  assert.match(h, /\$90,000<span class="ff-src"> - chat, your estimate/, "an estimate is labeled an estimate");
  assert.match(h, /8 people <span class="ff-chip ff-c-attention">Unconfirmed/, "a confirmed fact with no source is not drawn as a fact");
  assert.ok(!h.includes("US citizen"), "a sensitive answer is never shown as a reusable value");
  assert.match(h, /Work authorization:<\/strong> answered per application, by you\. No stored answer is reused\./);
  assert.match(h, /Veteran status:<\/strong> &quot;Prefer not to say&quot; - kept exactly as you said it\./);
  assert.match(h, /Achievements - dated, reuse per item[\s\S]*Dated Mar 2023[\s\S]*Stop reusing/);
  assert.match(h, /Inferred preferences - not attestations[\s\S]*never sent to employers/);
});

Deno.test("E-65 F-03: no hiring-odds figure; re-ranked in place; a bridge-role card for career changers; no private gap reason", () => {
  const base = S.paths();
  const d = { ...base, priority: "stability over pay",
    directions: [{ ...base.directions[0], rank: 2, rows: [...base.directions[0].rows, { k: "Hiring odds", v: "72%", src: { label: "model" } }, { k: "Employment gap", v: "Caregiving 2022", src: { label: "you" } }] },
      { ...base.directions[1], rank: 1, bridge: true, rows: [...base.directions[1].rows, { k: "Fit", v: "62% chance of offer", src: { label: "model" } }] }] };
  const h = page(pathComparisonFile(d));
  assert.doesNotMatch(h, /72%|62% chance|Hiring odds<\/dt>/); assert.doesNotMatch(h, /Caregiving|Employment gap/);
  assert.ok(h.indexOf(`${base.directions[1].letter} - ${base.directions[1].name}`) < h.indexOf(`${base.directions[0].letter} - ${base.directions[0].name}`), "re-ranked");
  assert.match(h, /Re-ranked in place\.[\s\S]*stability over pay/);
  assert.match(h, /Bridge role/);
  assert.match(h, /Hiring odds are not predicted/);
});

Deno.test("E-66 F-04: approving the plan authorizes search only; a starved search names the limiting factor instead of padding", () => {
  const plan = S.search();
  const h = page(searchPlanFile({ ...plan, starved: { found: 2, limiting: "the $80,000 base floor" }, acts: { primary: { label: "Approve plan", effect: "submit", post: { token: "t", action: "approveplan" } } } }));
  assert.match(h, /Only 2 roles matched\.[\s\S]*The limiting constraint is the \$80,000 base floor\. No weaker matches were added/);
  assert.doesNotMatch(h, /data-effect="(submit|send)"/, "the plan's approval can never submit");
  assert.match(h, /Approving this plan authorizes searching and shortlisting only/);
  assert.match(h, /searching is not applying/);
});

Deno.test("E-67 F-05: cross-posts merge with each source; similar titles stay separate; unknown in words; pay qualifier beside the number; targets never Apply; closed roles keep records with explained disabled controls", () => {
  const f = shortlist();
  f.rows = [
    role(1, { reqId: "CC-2214", payShown: "$85-98k", payGroup: "meets" }),
    role(2, { reqId: "CC-2214", url: "https://jobs.lever.co/examplesolar/cc-2214" }), // the same requisition, cross-posted
    role(3, { reqId: "CC-2290" }), // same title, a different requisition
    role(4, { place: "", title: "Field Coordinator" }),
    role(5, { title: "Grid Analyst", blocked: "the posting closed Nov 8" }),
  ];
  const h = rolesShortlistPage(f, CTX), cards = h.split('<article class="ff-card ff-role"').slice(1);
  assert.equal(cards.length, 4, "one merged role, the different requisition kept");
  assert.match(cards[0], /Also posted:[\s\S]*jobs\.lever\.co/);
  assert.match(h, /\$85-98k employer-stated/); assert.match(h, /pay not listed \(marked unknown\)/); assert.match(h, /location unknown/);
  assert.match(h, /Targets - companies, no verified opening[\s\S]*Never shows an Apply button/);
  const closed = cards.find((c) => c.includes("Grid Analyst"))!;
  assert.match(closed, /<strong>Closed:<\/strong> the posting closed Nov 8\. Kept here as a record\./);
  assert.match(closed, /disabled data-effect="prepare">Prepare application<\/button><span class="ff-off">Closed - the posting no longer takes applications/);
  const counts = h.slice(h.indexOf('class="ff-counts"'), h.indexOf("</ul>", h.indexOf('class="ff-counts"')));
  assert.equal([...counts.matchAll(/<b>(\d+)<\/b>/g)].reduce((a, m) => a + +m[1], 0), 4, "the hero counts the 4 roles; the target is never counted");
});

Deno.test("E-68 F-06: hard eligibility apart from fit; no fit rating beside an unmet mandatory credential; the route card says what only you do", () => {
  const w = S.workspace();
  const h = page(roleWorkspaceFile({ ...w, fitLabel: "Excellent fit", fit: [{ state: "missing", text: "PMP certification (required)", hard: true }, ...w.fit],
    route: { supported: false, text: "The employer page needs an account.", you: ["create the account", "sign in"] } }));
  assert.match(h, /Eligibility not met\.[\s\S]*PMP certification \(required\)[\s\S]*Fit is not rated while a mandatory requirement is unmet/);
  assert.doesNotMatch(h, /Excellent fit/);
  assert.ok(h.indexOf("Eligibility - mandatory, as posted") < h.indexOf("Fit - preferences, separate from eligibility"));
  assert.match(h, /Not supported - you do this step: The employer page needs an account\. Only you: create the account; sign in\./);
  assert.match(page(roleWorkspaceFile({ ...w, fitLabel: "Strong fit", fit: [{ state: "met", text: "Bachelor's degree", hard: true }, ...w.fit] })), /Strong fit/);
});

Deno.test("E-69 F-07: the approved version is used, not the newest; a missing achievement is a question, never an invented metric; portfolio kinds; copyable profile edit; no public account touched", () => {
  const m = S.materials();
  const h = page(materialsFile({ ...m, changes: [...m.changes, { kind: "Fact needed", after: "Cut onboarding time 40%", lead: "Needs your input", text: "How much did onboarding time change?" }],
    portfolio: [{ title: "Grid dashboard", type: "employment" }, { title: "SQL course project", type: "learning" }, { title: "Case study outline", type: "draft" }],
    profileEdit: { site: "your professional profile", before: "Operations Associate", after: "Operations Associate - scheduling rollouts across 4 teams" } }));
  assert.match(h, /Version used<\/dt><dd><span class="ff-v" data-claim="1" data-src="personal">v2 \(approved\)<span class="ff-src"> - the approved version, not the newest/);
  assert.doesNotMatch(h, /40%/); assert.match(h, /How much did onboarding time change\? Nothing is written until you give the fact\./);
  assert.match(h, /Employment work[\s\S]*Learning project[\s\S]*Draft/);
  assert.match(h, /Profile edit - your professional profile - you paste it[\s\S]*Operations Associate - scheduling rollouts across 4 teams[\s\S]*not permission to touch your public account/);
  const profileCard = h.slice(h.indexOf("Profile edit"), h.indexOf("</section>", h.indexOf("Profile edit")));
  assert.doesNotMatch(profileCard, /data-effect="(submit|send|approve)"/);
  assert.match(page(materialsFile({ ...m, approved: null })), /none yet - nothing is used until you approve one/);
});

Deno.test("E-70 F-08: exact outgoing answers inspectable word for word; an attestation blocks until reviewed and is never pre-checked or hidden", () => {
  const a = S.answers(), h = page(answerLibraryFile(a));
  for (const s of a.scoped) assert.ok(h.includes(`Answer: &quot;${s.answer}&quot;`), "verbatim");
  assert.match(h, /New declaration on R-07\.[\s\S]*&quot;I certify this information is true&quot;[\s\S]*blocks submission until you review it/);
  assert.doesNotMatch(h, /\bchecked\b(?!=)|<input[^>]*type="checkbox"[^>]*checked/);
});

Deno.test("E-71 F-09: approval covers exactly this package; a material change returns to review; no optimistic Submitted; a stale destination re-checks first", () => {
  const r = S.review();
  const ok = page(applicationReviewFile({ ...r, now: NOW }));
  assert.match(ok, /approval covers exactly this[\s\S]*Resume[\s\S]*Letter[\s\S]*Answers[\s\S]*Destination/);
  assert.match(ok, /<button type="submit" class="ff-btn ff-pri" data-effect="submit">Approve submission/);
  assert.match(page(applicationReviewFile({ ...r, changed: "the employer added a relocation question" })), /disabled data-effect="submit">Approve submission<\/button><span class="ff-off">Changed since you reviewed: the employer added a relocation question/);
  assert.match(page(applicationReviewFile({ ...r, now: NOW + 3 * 86_400_000 })), /disabled data-effect="submit">[\s\S]*re-checked before anything can be approved/);
  const after = page(applicationReviewFile({ ...r, after: { state: "submitted", evidence: null } }));
  assert.doesNotMatch(after, /Submitted - confirmed/); assert.match(after, /no employer confirmation with a link and time is on file/);
  assert.match(page(applicationReviewFile({ ...r, after: { state: "submitted", evidence: { label: "Employer email", href: "https://jobs.lever.co/x/receipt", at: "2026-11-09T15:40:00Z" } } })), /Submitted - confirmed[\s\S]*data-src="external"/);
  assert.match(page(applicationReviewFile({ ...r, after: { state: "approved" } })), /Approved - not submitted yet\./);
});

Deno.test("E-72 F-10: only reviewed rows approvable; blocked never counted ready; no inherited approval; exceptions isolated; uncertain disables retry; Pause never undoes", () => {
  const b = S.batch(), go = (label: string) => ({ label, effect: "submit" as const, post: { token: "t", action: "applyrow" } });
  const h = page(batchFile({ ...b, rows: [
    { ...b.rows[0], act: go("Retry submission") }, // uncertain
    { rid: "R-20", title: "Ops Analyst", key: "ready", detail: "Prepared.", approved: true, reviewed: false, act: go("Approve R-20") },
    { rid: "R-21", title: "Grid Planner", key: "blocked", detail: "Location excluded.", approved: true },
    { rid: "R-22", title: "Field Lead", key: "ready", detail: "New match.", approved: false, act: go("Approve R-22") },
    ...b.rows.slice(1, 3) ] }));
  assert.match(h, /disabled data-effect="submit">Retry submission<\/button><span class="ff-off">Submission uncertain/);
  assert.match(h, /disabled data-effect="submit">Approve R-20<\/button><span class="ff-off">Not reviewed/);
  assert.match(h, /disabled data-effect="submit">Approve R-22<\/button><span class="ff-off">Outside this batch&#39;s approval|disabled data-effect="submit">Approve R-22<\/button><span class="ff-off">Outside this batch's approval/);
  const counts = h.slice(h.indexOf('class="ff-counts"'), h.indexOf("</ul>", h.indexOf('class="ff-counts"')));
  assert.match(counts, /<b>1<\/b> blocked/); assert.match(counts, /<b>1<\/b> not approved/);
  assert.match(h, /Only this application returned to review - the other approved roles keep moving/);
  assert.match(h, /in-flight steps are reconciled, not undone/);
});

Deno.test("E-73 F-11: two roles at one employer stay two; duplicate receipts never inflate; corrections keep history; alerts deduplicated, explained, quiet, and visibly stopped", () => {
  const p = S.pipeline();
  const h = page(pipelineFile({ ...p, apps: [{ appId: "A-1", rid: "R-01", company: "Example Grid Co" }, { appId: "A-2", rid: "R-02", company: "Example Grid Co" }, { appId: "A-2", rid: "R-02", company: "Example Grid Co" }],
    corrections: [{ title: "R-07 status", was: "Rejected", now: "Interviewing", src: null }],
    alerts: [{ key: "grid-reply", text: "Example Grid Co replied", why: "an interview time needs your answer" }, { key: "grid-reply", text: "Example Grid Co replied", why: "duplicate" }],
    watch: { text: "Checks your inbox.", active: false, stopped: "reached Nov 30, the end date you set" } }));
  assert.match(h, /Applications <b>2<\/b>/);
  assert.match(h, /Corrections - history kept[\s\S]*Rejected[\s\S]*Interviewing/);
  assert.equal((h.match(/Example Grid Co replied/g) ?? []).length, 1); assert.match(h, /Why it matters: an interview time needs your answer/);
  assert.match(h, /Stopped: reached Nov 30, the end date you set\./);
  assert.match(page(pipelineFile({ ...p, alerts: [] })), /Nothing changed, so no alert was sent\./);
});

Deno.test("E-74 F-12: one recipient is not a network; silence ends the ask; an opt-out stops follow-ups; an unverified sender stays unverified", () => {
  const ok = page(messageReviewFile(S.message()));
  assert.match(ok, /Approval sends this one message to this one person\. It does not authorize your network/);
  assert.match(ok, /If no reply<\/dt><dd>[\s\S]*The ask ends\. Silence is never read as a yes\./);
  const out = page(messageReviewFile({ ...S.message(), optedOut: true }));
  assert.match(out, /disabled data-effect="send">Approve send<\/button><span class="ff-off">They opted out\./); assert.match(out, /None - they opted out/);
  const amb = page(messageReviewFile({ ...S.message(false), recipient: { ...S.message(false).recipient, relation: "close friend" } }));
  assert.match(amb, /Not resolved/); assert.match(amb, /disabled data-effect="send">Approve send/); assert.doesNotMatch(amb, /recipient verified/);
});

Deno.test("E-75 F-13: suggested is not booked; reschedules supersede; feedback on the actual answer; no vocal judging from text; prohibited assessment help refused", () => {
  assert.match(page(interviewHubFile(S.hub(false))), /Suggested time - not booked/);
  const h = page(interviewHubFile({ ...S.hub(), superseded: ["2026-11-09T20:00:00Z"], feedback: { answer: "I led the rollout across four teams.", note: "Your tone of voice sounded unsure." },
    assessment: { name: "the Example Grid Co coding test", prohibited: true } }));
  assert.match(h, /Superseded - not active[\s\S]*replaced by the time above; its reminders are off/);
  assert.match(h, /&quot;I led the rollout across four teams\.&quot;/); assert.doesNotMatch(h, /tone of voice sounded/); assert.match(h, /Feedback on delivery is not given from text practice/);
  assert.match(h, /Not helping with the Example Grid Co coding test\.[\s\S]*General practice on the same skills is available instead/);
});

Deno.test("E-76 F-14: quiet weeks say so; the application count is never the headline; Pause keeps records; urgent plans lead with 48 hours and route legal and benefits out", () => {
  assert.match(page(weeklyBriefFile(S.weekly(true))), /Quiet week\./);
  const w = S.weekly();
  const h = page(weeklyBriefFile({ ...w, changed: ["14 applications sent", ...w.changed], paused: true, urgent: { next48: ["File for unemployment", "Ask HR for the severance terms in writing"], outside: ["Is the severance negotiable?"] } }));
  assert.ok(h.indexOf("14 applications sent") > h.indexOf(w.changed[0]), "the count is not the headline");
  assert.match(h, /<h1 class="ff-h1">Your week in careers<\/h1>/, "the headline holds no count");
  assert.ok(h.indexOf("The next 48 hours") < h.indexOf("What actually changed"));
  assert.match(h, /qualified professional[\s\S]*Trainee does not answer them/);
  assert.match(h, /Paused\.[\s\S]*Every record is kept, and nothing already done is undone/);
});

Deno.test("E-77 F-14 negotiation: approving the plan sends nothing; no fabricated competing offer, deadline or acceptance intent; written and verbal terms carry different chips", () => {
  const n = S.negotiation();
  const h = page(negotiationFile({ ...n, position: [...n.position, { k: "Competing offer", v: "$105,000 from Voltline", src: { label: "you mentioned" } }],
    acts: { primary: { label: "Send counter", effect: "send", post: { token: "t", action: "approvesend" } } } }));
  assert.doesNotMatch(h, /data-effect="(send|submit|approve)"/);
  assert.match(h, /\$105,000 from Voltline <span class="ff-chip ff-c-attention">Unconfirmed/);
  assert.match(h, /v1 - initial offer[\s\S]*Written[\s\S]*v2 - recruiter call[\s\S]*Verbal/);
  assert.match(h, /approving this plan sends nothing/); assert.match(h, /No fabricated competing offers, deadlines, or acceptance intent/);
});

Deno.test("E-78 F-15: no single total mixing cash and unvested equity; marking a preference accepts, withdraws and resigns nothing", () => {
  const o = S.offers();
  const h = page(offerComparisonFile({ ...o, acts: { primary: { label: "Accept Example Grid Co offer", effect: "approve", post: { token: "t", action: "accept" } }, secondary: [...(o.acts?.secondary ?? []), { label: "Withdraw from Voltline", effect: "danger", href: "?w" }] } }));
  assert.doesNotMatch(h, /Total compensation|\$101,200/);
  assert.doesNotMatch(h, /Accept Example Grid Co offer|Withdraw from Voltline/);
  assert.match(h, /Mark preference/); assert.match(h, /Marking a preference accepts, withdraws and resigns nothing\. Each of those is a separate action you approve\./);
});
