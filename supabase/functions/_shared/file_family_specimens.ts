// R10 WO-E: the fictional specimens of the fifteen File families (spec C.3-C.18; target pages p-43 to p-86), one main state each.
// FICTIONAL ONLY: the spec's own specimen names ("Example ... Co", "Jordan M."), never a real person or employer, no real link that
// identifies anyone. They render a family for review and for the acceptance suite (file_kinds.ts FILE_FAMILIES; WO-I); nothing in
// production reads them as facts. Their times are fixed to SPECIMEN_NOW in America/Chicago, so every render is deterministic.
import type { ShortRole, ShortlistInput } from "./file_family_roles.ts";
import type { AnswerLibrary, CareerBrief, Materials, PathComparison, ProfileFacts, RoleWorkspace, SearchPlan } from "./file_family_plan.ts";
import type { ApplicationReview, BatchFile, InterviewHub, MessageReview, Negotiation, OfferComparison, Pipeline, WeeklyBrief } from "./file_family_apply.ts";
import type { Src } from "./file_family.ts";
import type { KindId } from "./file_kinds.ts";
import { FAMILIES, familyPage, type Act, type Ctx, type FamilyFile, type FamilyId } from "./file_family.ts";
import { rolesShortlistPage } from "./file_family_roles.ts";
import { answerLibraryFile, careerBriefFile, materialsFile, pathComparisonFile, profileFactsFile, roleWorkspaceFile, searchPlanFile } from "./file_family_plan.ts";
import { applicationReviewFile, batchFile, interviewHubFile, messageReviewFile, negotiationFile, offerComparisonFile, pipelineFile, weeklyBriefFile } from "./file_family_apply.ts";

export const SPECIMEN_NOW = Date.parse("2026-11-09T15:45:00Z"); // 9:45 AM in Chicago
export const SPECIMEN_TZ = "America/Chicago";
export const SPECIMEN_TOKEN = "fs1." + "a".repeat(64); // not a real session: a page token's shape only

// ---------------------------------------------------------------- F-05
const job = (n: number, company: string, title: string, url: string, o: Partial<ShortRole["job"]> = {}) => ({
  job_id: `greenhouse:example:${n}`, company, title, location: "US remote", url, pay: null, level: null, remote: "remote" as const, posted_at: "2026-11-05T14:00:00Z",
  first_seen_at: "2026-11-05T15:00:00Z", deadline: null, source: "Greenhouse", reasons: [], gaps: [], company_domain: null, ...o,
});
export function role(n: number, o: Partial<ShortRole> & { company?: string; title?: string; url?: string; gaps?: string[] } = {}): ShortRole {
  const { company = "Example Solar Co", title = "Customer Operations Specialist", url = `https://boards.greenhouse.io/examplesolar/jobs/${4000 + n}`, gaps = [], ...rest } = o;
  return {
    ref: `ref${n}`, job: job(n, company, title, url, { gaps }), logo: null, snippet: "", full: null, status: null, tag: null, resume: "Operations v3", byHand: false,
    payShown: null, payGroup: "unlisted", payNote: null, payConv: null, place: "US remote", checkedAt: "2026-11-09T15:12:00Z", ...rest,
  } as ShortRole;
}
// The spec's F-05 specimen (C.7) plus Example 2's internship additions (student window, uncertain line) and the honest edge cases:
// a blocked role, a prepared role, a role applied by hand, a role whose check time is not on file, and a target with no opening.
export function shortlist(): ShortlistInput {
  return {
    token: SPECIMEN_TOKEN, title: "Climate operations roles", review: "review v1", updatedAt: "2026-11-09T15:40:00Z", sourcesChecked: "9 boards + employer pages", back: "/f",
    rows: [
      role(1, { payShown: "$85-98k", payGroup: "meets", why: ["matches your process-rollout record.", "Customer-facing operations work matches your last 3 years."], gaps: ["energy-sector experience preferred, not required."] }),
      role(2, { title: "Program Operations Associate with a deliberately long title that has to wrap on a phone screen", place: "US remote - excludes 3 states", restriction: "Location restriction", blocked: "your state may be excluded" }),
      role(3, { company: "Example Carbon Co", title: "Operations Associate", url: "https://jobs.lever.co/examplecarbon/cc-2214", payShown: "$80-90k", payGroup: "meets", tag: "0123456789abcdef", why: ["Uses your confirmed scheduling-tool rollout."],
        send: [{ label: "Resume", value: "Operations v3" }, { label: "Where it goes", value: "jobs.lever.co" }, { label: "Earliest start", value: "", needs: true }] }),
      role(4, { company: "Example Carbon Co", title: "Data Operations Intern, Summer 2027", url: "https://jobs.lever.co/examplecarbon/cc-2290", window: "Enrolled undergraduate graduating Dec 2027 to June 2028",
        uncertain: "The posting does not say whether remote interns outside the US are accepted.", checkedAt: null }),
      role(5, { company: "Example Grid Co", title: "Field Operations Coordinator", url: "https://example-grid.com/careers/fo-12", byHand: true, why: ["Field coordination matches your confirmed logistics work."] }),
    ],
    targets: [{ company: "Example Climate Lab", note: "Fits your niche.", watch: { label: "Watch openings", effect: "decide", href: "?watch=example-climate-lab" } }],
  };
}

// ---------------------------------------------------------------- F-01 to F-04, F-06 to F-08
// Sources as the library writes them, inline after the value ("3 years - resume, confirmed"; "2 weeks - you, Oct 28").
const you = (d?: string, label = "you confirmed"): Src => d ? { label, at: `${d}T15:00:00Z`, dateOnly: true } : { label };
const resume: Src = { label: "resume, confirmed" };
const plan: Src = { label: "your search plan" };
const POSTING = "https://jobs.lever.co/examplecarbon/cc-2214";
const posting: Src = { label: "employer page verified", href: POSTING, at: "2026-11-09T15:31:00Z" };
const go = (label: string, href: string, effect: "decide" | "navigate" | "prepare" = "decide") => ({ label, effect, href });

export const brief = (): CareerBrief => ({
  version: 2, title: "Next role: climate operations", updatedAt: "2026-11-09T15:32:00Z", sources: "your resume + chat",
  aim: { text: "Operations roles in climate-tech", detail: "Individual contributor, mid-level.", provisional: true }, constraints: ["US remote", "No people management", "$80k+ base if listed"],
  questions: [{ q: "Include roles with undisclosed pay?", why: "They would be marked \"pay unknown\" and kept out of auto-approval.", act: go("Answer", "?answer=undisclosed-pay") },
    { q: "Earliest start date", why: "Used only for roles with verified start-date requirements.", act: go("Answer", "?answer=start-date") }],
  first: [{ done: true, text: "Read your resume - facts go to your Profile for confirmation" }, { done: true, text: "Draft a search plan with your constraints" }, { done: false, text: "Build a first shortlist of 10-12 verified roles" }],
  acts: { primary: go("Start search", "?start=search", "navigate"), secondary: [go("Edit goals", "?edit=goals"), go("Add materials", "?add=materials")] },
});
export const profile = (): ProfileFacts => ({
  conflict: { text: "Your resume says Northwind Logistics ended Mar 2024; your profile says Jun 2024. Two prepared applications use the old date." },
  facts: [
    { k: "Current title", v: "Operations Associate", kind: "confirmed", src: resume }, { k: "Experience", v: "3 years", kind: "confirmed", src: resume },
    { k: "Location", v: "Chicago, IL", kind: "confirmed", src: you() }, { k: "Impact figure", v: "\"Cut onboarding time ~30%\"", kind: "estimate", src: { label: "your estimate" } },
    { k: "Northwind Logistics end date", v: "Mar 2024 or Jun 2024", kind: "review", src: { label: "Resume and profile disagree" } },
    { k: "Expected graduation", v: null, kind: "review", src: null },
    { k: "your shortlist feedback", v: "Prefers process-heavy roles", kind: "inferred", src: { label: "Inferred" }, correct: go("Correct", "?correct=process-heavy") },
  ],
  acts: { primary: go("Review 2 conflicts", "?review=conflicts", "navigate"), secondary: [{ label: "Export profile", effect: "download", href: "/files/profile.json" }, go("Stop reusing a fact", "?stop=reuse")] },
});
export const paths = (): PathComparison => ({
  title: "Operations lead vs program management", confirmedFacts: 24, updatedAt: "2026-11-09T14:00:00Z",
  directions: [
    { letter: "A", name: "Climate operations specialist", reach: "Reachable in 0-6 months on current evidence", evidence: "Strong",
      rows: [{ k: "Transferable proof", v: "3 process rollouts", src: resume }, { k: "Main gap", v: "Energy-sector vocabulary", src: { label: "12 postings you saved" } }, { k: "Cost of trying", v: "Low - apply + 1 project", src: { label: "Trainee's reading" } }] },
    { letter: "B", name: "Program management", reach: "Reachable in 12-24 months; needs new evidence", evidence: "Partial",
      rows: [{ k: "Transferable proof", v: "Coordination work, unscoped", src: resume }, { k: "Main gap", v: "No shipped program owned end-to-end", src: { label: "Trainee's reading" } }, { k: "Cost of trying", v: "Medium - portfolio project first", src: { label: "Trainee's reading" } }] },
  ],
  experiment: "apply to 5 specialist roles and scope one small program case study before paying for any course. If you change priorities, the ranking updates here, not in a new document.",
  acts: { primary: go("Find example roles for A", "?find=A", "navigate"), secondary: [go("Build transition plan", "?plan=transition"), go("Change priorities", "?priorities")] },
});
export const search = (): SearchPlan => ({
  version: 1, title: "Climate operations search", batchCap: 12, updatedAt: "2026-11-09T15:00:00Z",
  hard: [{ k: "Work arrangement", v: "US remote only", src: you() }, { k: "Role scope", v: "Individual contributor", src: you() }, { k: "Pay floor", v: "$80,000 base if listed", src: you() }, { k: "Excluded employers", v: "2", src: { label: "your list" } }],
  prefs: [{ k: "Sector", v: "Grid, solar, carbon", src: you() }, { k: "Company size", v: "50-500 preferred", src: plan }, { k: "Undisclosed pay", v: "Include, marked unknown", src: you() }],
  watch: { text: "Weekday mornings, quiet hours 9 PM-8 AM, stops Dec 15 or when you say stop.", active: true },
  acts: { primary: { label: "Approve search scope", effect: "approve", post: { token: SPECIMEN_TOKEN, action: "approveplan", fields: { v: "1" } } }, secondary: [go("Tighten search", "?tighten"), go("Explore adjacent roles", "?adjacent")] },
});
export const workspace = (): RoleWorkspace => ({
  rid: "R-07", appId: "A-014", title: "Operations Associate", company: "Example Carbon Co", req: "CC-2214", checkedAt: "2026-11-09T15:31:00Z", postingUrl: POSTING,
  fit: [{ state: "met", text: "3+ years operations", src: { label: "your confirmed history" } }, { state: "met", text: "US remote", src: posting },
    { state: "partial", text: "SQL reporting - transferable evidence shown, no direct claim" }, { state: "unknown", text: "Travel % - posting silent; kept out of the pitch" }],
  materials: [{ k: "Resume", v: "Operations v3", src: { label: "approved" } }, { k: "Letter", v: "R-07 letter v2", src: { label: "draft" } }, { k: "Answers", v: "Set v4", src: { label: "2 need you" } }],
  route: { supported: true, text: "Form fill on the employer page through your browser extension, submitted only after your approval. Confirmation: employer email, checked against this requisition." },
  declaration: "One question asks you to attest information is true. That step is always yours - it is never pre-checked.",
  acts: { primary: go("Review application", "?review=A-014", "navigate"), secondary: [{ label: "View posting", effect: "open", href: POSTING }, { label: "Exclude role", effect: "danger", href: "?exclude=R-07" }] },
});
export const materials = (file: string | null = "/files/operations-resume-v3.pdf"): Materials => ({
  rid: "R-07", docTitle: "Operations resume - v3", base: "master v6", approved: "v2", draft: "v3", updatedAt: "2026-11-09T15:10:00Z", format: "Dates, page flow, contact line verified", usedBy: "R-07 only",
  changes: [{ kind: "Emphasis", after: "Reordered evidence", text: "Process-rollout bullet moved above support work. No facts changed." },
    { kind: "Wording", before: "Managed scheduling tools", after: "Led scheduling rollout, 4 teams", text: "Stronger wording of a confirmed fact - source: your resume, confirmed Oct 12." },
    { kind: "Fact needed", after: "Added: carbon-accounting tooling", lead: "Needs your input", text: "- the posting asks for it; no supporting fact on file. Truthful alternative drafted." }],
  download: { label: "Download", effect: "download", href: file, ...(file ? {} : { off: "The file has not been produced yet, so there is nothing to download." }) },
  acts: { primary: { label: "Approve v3 for R-07", effect: "approve", post: { token: SPECIMEN_TOKEN, action: "approvedoc", fields: { doc: "operations-resume", v: "3", role: "R-07" } } }, secondary: [go("Compare changes", "?compare=v2-v3")] },
});
export const answers = (): AnswerLibrary => ({
  needed: 2, declaration: { rid: "R-07", text: "I certify this information is true" },
  factual: [{ k: "Years of experience", v: "3", src: resume }, { k: "Earliest start", v: "2 weeks", src: you("2026-10-28", "you") }, { k: "Location", v: "Chicago, IL", src: { label: "confirmed" } }],
  roleSpecific: [{ q: "Why Example Carbon Co?", scope: "This role only", note: "Cites their grid-storage product and your rollout record. Replacing the company name would not survive - that is the test." }],
  scoped: [{ q: "Willing to relocate", answer: "No", scope: "US-remote roles", outside: "A role in Austin" }],
  acts: { primary: go("Review 2 answers needed", "?answers=needed", "navigate"), secondary: [go("Use once", "?use=once"), go("Never reuse", "?reuse=never")] },
});

// ---------------------------------------------------------------- F-09 to F-15
const letter = (d: string): Src => ({ label: "offer letter", href: "https://example-grid.com/offers/letter-v1.pdf", at: `${d}T15:00:00Z`, dateOnly: true });

export const review = (answered = true): ApplicationReview => ({
  appId: "A-014", rid: "R-07", title: "Operations Associate", company: "Example Carbon Co", destination: { label: "verified", href: POSTING, at: "2026-11-09T15:31:00Z" },
  pkg: [{ k: "Resume", v: "Operations v3", src: { label: "you approved" } }, { k: "Letter", v: "R-07 letter v2", src: { label: "you approved" } }, { k: "Answers", v: "Set v4", src: { label: "full text inspectable below" } }],
  answers: [{ q: "Why this role?", a: "I want to use process work to make grid operations calmer. At Northwind I led a scheduling rollout across 4 teams.", required: true },
    { q: "Earliest start", a: "2 weeks", required: true }, { q: "Work authorization", a: answered ? "Authorized to work in the US" : null, required: true }, { q: "Pronouns", a: null, required: false }],
  conditions: ["No payment is expected. Any unexpected charge stops this action.", "A new required question or declaration returns this to review.", "A material destination change cancels this approval.", "Approval expires in 48 hours."],
  approve: { label: "Approve submission", effect: "submit", post: { token: SPECIMEN_TOKEN, action: "approveapp", fields: { app: "A-014" } } }, edit: go("Edit materials", "?edit=A-014"), cancel: { label: "Cancel", effect: "danger", href: "?cancel=A-014" },
});
export const batch = (): BatchFile => ({
  batch: "B-01", review: "review v3", expiresAt: "2026-11-13T23:00:00Z", exclusions: "No outreach", pause: { label: "Pause remaining", effect: "danger", post: { token: SPECIMEN_TOKEN, action: "pause" } },
  check: { label: "Check status", effect: "decide", post: { token: SPECIMEN_TOKEN, action: "checkstatus", fields: { rid: "R-11" } } },
  rows: [
    { rid: "R-11", title: "Grid Analyst", key: "uncertain", detail: "The final page timed out after the submit step.", approved: true },
    { rid: "R-08", title: "Field Operations Coordinator", key: "needs_info", detail: "New required question appeared: relocation. Only this application returned to review - the other approved roles keep moving.", approved: true, act: go("Answer question", "?answer=R-08"), menu: [{ label: "Exclude R-08", effect: "danger", href: "?exclude=R-08" }] },
    { rid: "R-03", title: "Operations Analyst", key: "submitted", detail: "Employer receipt matches this requisition and your account.", approved: true, evidence: { label: "Employer email", href: "https://jobs.lever.co/examplegrid/receipt", at: "2026-11-09T15:17:00Z" }, act: { label: "View confirmation", effect: "open", href: "https://jobs.lever.co/examplegrid/receipt" } },
    { rid: "R-04", title: "Operations Coordinator", key: "submitted", detail: "Recorded as submitted.", approved: true, evidence: null },
    { rid: "R-05", title: "Program Associate", key: "queued", detail: "Approved and waiting its turn; not started.", approved: true },
    { rid: "R-06", title: "Logistics Analyst", key: "discovered", detail: "Not approved - stays visible, never inherits this batch's approval.", approved: false },
  ],
});
export const pipeline = (): Pipeline => ({
  counts: { applications: 11, interviews: 2, offers: 0 },
  decisions: [{ title: "Example Grid Co - interview times offered", chip: { label: "Reply due", tone: "attention" }, text: "Recruiter wrote 2h ago - 3 conflict-free options found, none booked.", act: go("Review options", "?options=grid") }],
  waiting: [{ title: "Example Solar Co - R-01", chip: { label: "Confirmed", tone: "confirmed" }, text: "Submitted, confirmed Oct 28 - employer receipt on file", src: { label: "Employer email", href: "https://boards.greenhouse.io/examplesolar/receipt", at: "2026-10-28T16:00:00Z" } },
    { title: "Example Carbon Co - R-07", chip: { label: "Aging", tone: "info" }, text: "12 days since confirmation - follow-up drafted, not sent" }],
  stages: [{ title: "Example Battery Co", chip: { label: "Interviewing", tone: "plum" }, text: "Interview 2 of 3 - submission history preserved below this stage" }],
  watch: { text: "Checks your connected inbox for receipts and replies, weekdays 8 AM-6 PM. Stops Nov 30.", active: true },
  acts: { primary: go("Review interview options", "?options=grid", "navigate"), secondary: [go("Correct a status", "?correct=status"), { label: "Export", effect: "download", href: "/files/pipeline.csv" }] },
});
export const message = (resolved = true): MessageReview => ({
  kind: "Referral request", recipient: resolved ? { initials: "JM", name: "Jordan M.", basis: "Former teammate at Northwind Logistics, 2 shared roles. Identity resolved from your contacts - not guessed among lookalikes.", resolved, relation: "former teammate" }
    : { initials: "?", name: "Maya at Example Carbon Co", basis: "Two contacts match this name. No address is guessed; pick the right person first.", resolved },
  to: resolved ? "jordan.m@example.com" : null, channel: "email", attachments: "Role link + forwardable blurb v1", followUp: "None - silence ends the ask",
  words: "Hey Jordan - saw Example Carbon Co is hiring an Operations Associate (req CC-2214). I'm applying and wondered if you'd be comfortable referring me. Short blurb you can forward is attached. Totally fine if not - no worries either way.",
  approve: { label: "Approve send", effect: "send", post: { token: SPECIMEN_TOKEN, action: "approvesend", fields: { msg: "M-3" } } },
  acts: { secondary: [go("Edit wording", "?edit=M-3"), go("Change recipient", "?recipient=M-3")] },
});
export const hub = (booked = true): InterviewHub => ({
  company: "Example Grid Co", stage: "stage 2 of 3", at: "2026-11-10T20:00:00Z", tz: "America/Chicago", interviewerTz: "America/Los_Angeles", minutes: 45, medium: "video", booked, calendarVerified: booked,
  person: { initials: "SP", name: "Sam P.", role: "Operations Director", verified: true, basis: "Identity verified against the recruiter's email. Public professional info only - no personal digging." },
  prep: [{ done: true, lead: "Likely topics:", text: "grid operations, incident process, cross-team rollout" }, { done: true, lead: "Your stories:", text: "3 outlined from confirmed facts - no invented achievements" }, { done: false, lead: "Questions to ask:", text: "on-call structure, 90-day expectations" }],
  acts: { primary: go("Open prep brief", "?brief=grid", "navigate"), secondary: [go("Propose new time", "?propose=grid"), go("Draft follow-up", "?followup=grid")] },
});
export const weekly = (quiet = false): WeeklyBrief => ({
  week: "Nov 2", n: 4, generatedAt: "2026-11-09T15:00:00Z", cadence: "weekly",
  changed: quiet ? [] : ["1 interview confirmed - Example Grid Co, Nov 10", "9 applications confirmed; 1 employer replied with questions", "2 new verified roles match your constraints"],
  decisions: [{ title: "Interview time for Example Grid Co", text: "3 options found - none booked yet", act: go("Decide", "?decide=time") }, { title: "Broaden search to adjacent roles?", text: "Current filters returned fewer roles this week", act: go("Decide", "?decide=broaden") }],
  blockers: ["One source board blocked automated checks - coverage note added; no roles were invented to fill the gap."],
  acts: { primary: go("Review 2 decisions", "?decisions", "navigate"), secondary: [go("Adjust plan", "?plan"), { label: "Pause search", effect: "danger", post: { token: SPECIMEN_TOKEN, action: "pause" } }] },
});
export const negotiation = (): Negotiation => ({
  company: "Example Grid Co", v: 2, deadline: "2026-11-13T23:00:00Z", basis: "the signed offer letter",
  position: [{ k: "Target base", v: "$98,000", src: { label: "you confirmed" } }, { k: "Walk-away floor", v: "$92,000", src: { label: "private, never shared" } }, { k: "Tradeable", v: "Start date, remote days", src: { label: "you said" } }],
  history: [{ v: "v1 - initial offer", written: true, text: "$92,000 base - 10% target bonus - offer letter Oct 30" }, { v: "v2 - recruiter call", written: false, text: "\"Room on base\"" }],
  ask: { title: "Counter at $98,000 with your rollout record", text: "Evidence-linked wording.", act: go("Review draft", "?draft=counter") },
  acts: { primary: go("Review the counter draft", "?draft=counter", "navigate"), secondary: [go("Adjust priorities", "?priorities"), go("Prepare decision", "?decision")] },
});
export const offers = (): OfferComparison => ({
  deadline: { company: "Grid Co", at: "2026-11-13T23:00:00Z" }, priorities: "You ranked stability over upside - A leads on guaranteed cash.",
  offers: [
    { letter: "A", company: "Example Grid Co", rows: [{ k: "Base", v: "$92,000", src: letter("2026-10-30") }, { k: "Bonus", v: "10% target - not guaranteed", src: letter("2026-10-30") }, { k: "Equity", v: "None", src: letter("2026-10-30") }, { k: "Start / location", v: "Dec 1 - US remote", src: letter("2026-10-30") }, { k: "Total compensation", v: "$101,200", src: { label: "added up" } }] },
    { letter: "B", company: "Voltline Energy", rows: [{ k: "Base", v: "$85,000", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" } }, { k: "Equity", v: "0.05% - 4yr vest, not cash", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" } },
      { k: "Benefits", v: null, missing: "Unknown - summary only" }, { k: "Clause", v: "Non-solicit - qualified advice suggested", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" }, tone: "bad" }] },
  ],
  acts: { primary: go("Prepare questions for Voltline", "?questions=voltline", "navigate"), secondary: [go("Negotiate", "?negotiate"), go("Mark preference", "?prefer")] },
});

// ---------------------------------------------------------------- the registry the acceptance suite reads (architect ruling, WO-E)
// id: the family (F-14n is the negotiation variant); kind: the existing File kind that carries it (file_kinds.ts KIND_IDS; the
// family renderer is not yet what the live page serves for that kind); specimen: the fictional data; page: that data rendered as the
// family's main state, at SPECIMEN_NOW in SPECIMEN_TZ, with the header's back and overflow controls.

export interface FamilySpecimen { id: FamilyId | "F-14n"; name: string; kind: KindId; specimen: unknown; page: (c?: Ctx) => string }
const CTX0: Ctx = { now: SPECIMEN_NOW, tz: SPECIMEN_TZ };
const MENU: Act[] = [{ label: "Export", effect: "download", href: "/files/export.json" }, { label: "Close this File", effect: "navigate", href: "/f" }];
const nav = (f: FamilyFile): FamilyFile => ({ ...f, back: "/f", menu: f.menu ?? MENU });
function fam<T>(id: FamilyId | "F-14n", kind: KindId, data: () => T, build: (d: T) => FamilyFile, name?: string): FamilySpecimen {
  return { id, kind, name: name ?? FAMILIES[id as FamilyId].name, specimen: data(), page: (c = CTX0) => familyPage(nav(build(data())), c) };
}
export const FILE_FAMILIES: FamilySpecimen[] = [
  fam("F-01", "plan_review", brief, careerBriefFile), fam("F-02", "plan_review", profile, profileFactsFile), fam("F-03", "comparison", paths, pathComparisonFile),
  fam("F-04", "plan_review", search, searchPlanFile),
  { id: "F-05", kind: "job_list", name: FAMILIES["F-05"].name, specimen: shortlist(), page: (c = CTX0) => rolesShortlistPage(shortlist(), c) },
  fam("F-06", "plan_review", workspace, roleWorkspaceFile), fam("F-07", "draft", () => materials(), materialsFile), fam("F-08", "plan_review", answers, answerLibraryFile),
  fam("F-09", "application_proof", () => review(), applicationReviewFile), fam("F-10", "job_list", batch, batchFile), fam("F-11", "plan_review", pipeline, pipelineFile),
  fam("F-12", "introduction", () => message(), messageReviewFile), fam("F-13", "plan_review", () => hub(), interviewHubFile), fam("F-14", "plan_review", () => weekly(), weeklyBriefFile),
  fam("F-14n", "plan_review", negotiation, negotiationFile, "Negotiation plan"), fam("F-15", "comparison", offers, offerComparisonFile),
];
