// R10 WO-E part 2 fixtures: the spec's fictional specimens for F-01 to F-04 and F-06 to F-08 (C.3-C.6, C.8-C.10). Fictional only.
import type { AnswerLibrary, CareerBrief, Materials, PathComparison, ProfileFacts, RoleWorkspace, SearchPlan } from "../../supabase/functions/_shared/file_family_plan.ts";
import type { Src } from "../../supabase/functions/_shared/file_family.ts";
import { TOKEN } from "./r10-files-fixtures.ts";

const you = (d = "2026-10-12"): Src => ({ label: "You confirmed", at: `${d}T15:00:00Z`, dateOnly: true });
const resume: Src = { label: "Resume, confirmed", at: "2026-10-12T15:00:00Z", dateOnly: true };
const plan: Src = { label: "Your search plan" };
const POSTING = "https://jobs.lever.co/examplecarbon/cc-2214";
const posting: Src = { label: "Employer page", href: POSTING, at: "2026-11-09T15:31:00Z" };
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
  updatedAt: "2026-11-09T15:20:00Z", conflict: { text: "Your resume says Northwind Logistics ended Mar 2024; your profile says Jun 2024. Two prepared applications use the old date." },
  facts: [
    { k: "Current title", v: "Operations Associate", kind: "confirmed", src: resume }, { k: "Experience", v: "3 years", kind: "confirmed", src: resume },
    { k: "Location", v: "Chicago, IL", kind: "confirmed", src: you() }, { k: "Impact figure", v: "\"Cut onboarding time ~30%\"", kind: "estimate", src: { label: "Your estimate" } },
    { k: "Northwind Logistics end date", v: "Mar 2024 or Jun 2024", kind: "review", src: { label: "Resume and profile disagree" } },
    { k: "Expected graduation", v: null, kind: "review", src: null },
    { k: "From your shortlist feedback", v: "Prefers process-heavy roles", kind: "inferred", src: { label: "Inferred" }, correct: go("Correct", "?correct=process-heavy") },
  ],
  acts: { primary: go("Review 2 conflicts", "?review=conflicts", "navigate"), secondary: [{ label: "Export profile", effect: "download", href: "/files/profile.json" }, go("Stop reusing a fact", "?stop=reuse")] },
});
export const paths = (): PathComparison => ({
  title: "Operations lead vs program management", confirmedFacts: 24, updatedAt: "2026-11-09T14:00:00Z",
  directions: [
    { letter: "A", name: "Climate operations specialist", reach: "Reachable in 0-6 months on current evidence", evidence: "Strong", find: go("Find example roles", "?find=A", "navigate"),
      rows: [{ k: "Transferable proof", v: "3 process rollouts", src: resume }, { k: "Main gap", v: "Energy-sector vocabulary", src: { label: "From 12 postings you saved" } }, { k: "Cost of trying", v: "Low - apply + 1 project", src: { label: "Trainee's reading" } }] },
    { letter: "B", name: "Program management", reach: "Reachable in 12-24 months; needs new evidence", evidence: "Partial", find: go("Find example roles", "?find=B", "navigate"),
      rows: [{ k: "Transferable proof", v: "Coordination work, unscoped", src: resume }, { k: "Main gap", v: "No shipped program owned end-to-end", src: { label: "Trainee's reading" } }, { k: "Cost of trying", v: "Medium - portfolio project first", src: { label: "Trainee's reading" } }] },
  ],
  experiment: "apply to 5 specialist roles and scope one small program case study before paying for any course. If you change priorities, the ranking updates here, not in a new document.",
  acts: { primary: go("Find example roles for A", "?find=A", "navigate"), secondary: [go("Build transition plan", "?plan=transition"), go("Change priorities", "?priorities")] },
});
export const search = (): SearchPlan => ({
  version: 1, title: "Climate operations search", batchCap: 12, updatedAt: "2026-11-09T15:00:00Z",
  hard: [{ k: "Work arrangement", v: "US remote only", src: you() }, { k: "Role scope", v: "Individual contributor", src: you() }, { k: "Pay floor", v: "$80,000 base if listed", src: you() }, { k: "Excluded employers", v: "2 - your list", src: you("2026-11-02") }],
  prefs: [{ k: "Sector", v: "Grid, solar, carbon", src: you() }, { k: "Company size", v: "50-500 preferred", src: plan }, { k: "Undisclosed pay", v: null, missing: "Not decided - you were asked" }],
  watch: { text: "Weekday mornings, quiet hours 9 PM-8 AM, stops Dec 15 or when you say stop.", active: true },
  acts: { primary: { label: "Approve search scope", effect: "approve", post: { token: TOKEN, action: "approveplan", fields: { v: "1" } } }, secondary: [go("Tighten search", "?tighten"), go("Explore adjacent roles", "?adjacent")] },
});
export const workspace = (): RoleWorkspace => ({
  rid: "R-07", appId: "A-014", title: "Operations Associate", company: "Example Carbon Co", req: "CC-2214", checkedAt: "2026-11-09T15:31:00Z", postingUrl: POSTING,
  fit: [{ state: "met", text: "3+ years operations - your confirmed history", src: resume }, { state: "met", text: "US remote", src: posting },
    { state: "partial", text: "SQL reporting - transferable evidence shown, no direct claim" }, { state: "unknown", text: "Travel % - posting silent; kept out of the pitch" }],
  materials: [{ k: "Resume", v: "Operations v3 - approved", src: { label: "You approved", at: "2026-11-08T20:00:00Z" } }, { k: "Letter", v: "R-07 letter v2 - draft", src: { label: "Draft, not approved" } }, { k: "Answers", v: "Set v4 - 2 need you", src: { label: "Answer library" } }],
  route: { supported: true, text: "Form fill on the employer page through your browser extension, submitted only after your approval. Confirmation: employer email, checked against this requisition." },
  declaration: "One question asks you to attest information is true. That step is always yours - it is never pre-checked.",
  acts: { primary: go("Review application", "?review=A-014", "navigate"), secondary: [{ label: "View posting", effect: "open", href: POSTING }, { label: "Exclude role", effect: "danger", href: "?exclude=R-07" }] },
});
export const materials = (file: string | null = "/files/operations-resume-v3.pdf"): Materials => ({
  rid: "R-07", docTitle: "Operations resume - v3", base: "master v6", approved: "v2", draft: "v3", updatedAt: "2026-11-09T15:10:00Z", format: "Dates, page flow, contact line verified", usedBy: "R-07 only",
  changes: [{ kind: "Emphasis", after: "Reordered evidence", text: "Process-rollout bullet moved above support work. No facts changed." },
    { kind: "Wording", before: "Managed scheduling tools", after: "Led scheduling rollout, 4 teams", text: "Stronger wording of a confirmed fact - source: your resume, confirmed Oct 12." },
    { kind: "Fact needed", after: "Added: carbon-accounting tooling", text: "Needs your input - the posting asks for it; no supporting fact on file. Truthful alternative drafted." }],
  download: { label: "Download", effect: "download", href: file, ...(file ? {} : { off: "The file has not been produced yet, so there is nothing to download." }) },
  acts: { primary: { label: "Approve v3 for R-07", effect: "approve", post: { token: TOKEN, action: "approvedoc", fields: { doc: "operations-resume", v: "3", role: "R-07" } } }, secondary: [go("Compare changes", "?compare=v2-v3")] },
});
export const answers = (): AnswerLibrary => ({
  updatedAt: "2026-11-09T15:00:00Z", needed: 2, declaration: { rid: "R-07", text: "I certify this information is true" },
  factual: [{ k: "Years of experience", v: "3", src: resume }, { k: "Earliest start", v: "2 weeks", src: you("2026-10-28") }, { k: "Location", v: "Chicago, IL", src: you() }, { k: "Work authorization", v: null, missing: "Not entered - yours to answer" }],
  roleSpecific: [{ q: "Why Example Carbon Co?", scope: "This role only", note: "Cites their grid-storage product and your rollout record. Replacing the company name would not survive - that is the test." }],
  scoped: [{ q: "Willing to relocate", answer: "No", scope: "US-remote roles" }],
  acts: { primary: go("Review 2 answers needed", "?answers=needed", "navigate"), secondary: [go("Use once", "?use=once"), go("Never reuse", "?reuse=never")] },
});
