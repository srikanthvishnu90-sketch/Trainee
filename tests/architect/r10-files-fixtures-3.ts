// R10 WO-E part 3 fixtures: the spec's fictional specimens for F-09 to F-15 (C.11-C.18), plus the honest edge cases (an answer
// not entered, a "confirmed" with no evidence, an unresolved recipient, an unbooked time, a quiet week, a "total" row).
import type { ApplicationReview, BatchFile, InterviewHub, MessageReview, Negotiation, OfferComparison, Pipeline, WeeklyBrief } from "../../supabase/functions/_shared/file_family_apply.ts";
import type { Src } from "../../supabase/functions/_shared/file_family.ts";
import { TOKEN } from "./r10-files-fixtures.ts";

const POSTING = "https://jobs.lever.co/examplecarbon/cc-2214";
const go = (label: string, href: string, effect: "decide" | "navigate" = "decide") => ({ label, effect, href });
const letter = (d: string): Src => ({ label: "Offer letter", href: "https://example-grid.com/offers/letter-v1.pdf", at: `${d}T15:00:00Z`, dateOnly: true });

export const review = (answered = true): ApplicationReview => ({
  appId: "A-014", rid: "R-07", title: "Operations Associate", company: "Example Carbon Co", destination: { label: "Employer page", href: POSTING, at: "2026-11-09T15:31:00Z" },
  pkg: [{ k: "Resume", v: "Operations v3", src: { label: "You approved", at: "2026-11-08T20:00:00Z" } }, { k: "Letter", v: "R-07 letter v2", src: { label: "You approved", at: "2026-11-09T14:00:00Z" } }],
  answers: [{ q: "Why this role?", a: "I want to use process work to make grid operations calmer. At Northwind I led a scheduling rollout across 4 teams.", required: true },
    { q: "Earliest start", a: "2 weeks", required: true }, { q: "Work authorization", a: answered ? "Authorized to work in the US" : null, required: true }, { q: "Pronouns", a: null, required: false }],
  conditions: ["No payment is expected. Any unexpected charge stops this action.", "A new required question or declaration returns this to review.", "A material destination change cancels this approval.", "Approval expires in 48 hours."],
  approve: { label: "Approve submission", effect: "submit", post: { token: TOKEN, action: "approveapp", fields: { app: "A-014" } } }, edit: go("Edit materials", "?edit=A-014"), cancel: { label: "Cancel", effect: "danger", href: "?cancel=A-014" },
});
export const batch = (): BatchFile => ({
  batch: "B-01", review: "review v3", expiresAt: "2026-11-13T23:00:00Z", exclusions: "No outreach", pause: { label: "Pause remaining", effect: "danger", post: { token: TOKEN, action: "pause" } },
  check: { label: "Check status", effect: "decide", post: { token: TOKEN, action: "checkstatus", fields: { rid: "R-11" } } },
  rows: [
    { rid: "R-11", title: "Grid Analyst", key: "uncertain", detail: "The final page timed out after the submit step.", approved: true },
    { rid: "R-08", title: "Field Operations Coordinator", key: "needs_info", detail: "New required question appeared: relocation. Only this application returned to review - the other approved roles keep moving.", approved: true, act: go("Answer question", "?answer=R-08") },
    { rid: "R-03", title: "Operations Analyst", key: "submitted", detail: "Employer receipt matches this requisition and your account.", approved: true, evidence: { label: "Employer email", href: "https://jobs.lever.co/examplegrid/receipt", at: "2026-11-09T15:17:00Z" }, act: { label: "View confirmation", effect: "open", href: "https://jobs.lever.co/examplegrid/receipt" } },
    { rid: "R-04", title: "Operations Coordinator", key: "submitted", detail: "Recorded as submitted.", approved: true, evidence: null },
    { rid: "R-05", title: "Program Associate", key: "queued", detail: "Approved and waiting its turn; not started.", approved: true },
    { rid: "R-06", title: "Logistics Analyst", key: "discovered", detail: "Not approved - stays visible, never inherits this batch's approval.", approved: false },
  ],
});
export const pipeline = (): Pipeline => ({
  counts: { applications: 11, interviews: 2, offers: 0 }, updatedAt: "2026-11-09T15:00:00Z",
  decisions: [{ title: "Example Grid Co - interview times offered", chip: { label: "Reply due", tone: "attention" }, text: "Recruiter wrote 2h ago - 3 conflict-free options found, none booked.", act: go("Review options", "?options=grid") }],
  waiting: [{ title: "Example Solar Co - R-01", chip: { label: "Confirmed", tone: "confirmed" }, text: "Submitted, confirmed Oct 28 - employer receipt on file", src: { label: "Employer email", href: "https://boards.greenhouse.io/examplesolar/receipt", at: "2026-10-28T16:00:00Z" } },
    { title: "Example Carbon Co - R-07", chip: { label: "Aging", tone: "info" }, text: "12 days since confirmation - follow-up drafted, not sent" }],
  stages: [{ title: "Example Battery Co", chip: { label: "Interviewing", tone: "plum" }, text: "Interview 2 of 3 - submission history preserved below this stage" }],
  watch: { text: "Checks your connected inbox for receipts and replies, weekdays 8 AM-6 PM. Stops Nov 30.", active: true },
  acts: { primary: go("Review interview options", "?options=grid", "navigate"), secondary: [go("Correct a status", "?correct=status"), { label: "Export", effect: "download", href: "/files/pipeline.csv" }] },
});
export const message = (resolved = true): MessageReview => ({
  kind: "Referral request", recipient: resolved ? { initials: "JM", name: "Jordan M.", basis: "Former teammate at Northwind Logistics, 2 shared roles. Identity resolved from your contacts - not guessed among lookalikes.", resolved }
    : { initials: "?", name: "Maya at Example Carbon Co", basis: "Two contacts match this name. No address is guessed; pick the right person first.", resolved },
  to: resolved ? "jordan.m@example.com" : null, channel: "email", attachments: "Role link + forwardable blurb v1", followUp: "None - silence ends the ask",
  words: "Hey Jordan - saw Example Carbon Co is hiring an Operations Associate (req CC-2214). I'm applying and wondered if you'd be comfortable referring me. Short blurb you can forward is attached. Totally fine if not - no worries either way.",
  approve: { label: "Approve send", effect: "send", post: { token: TOKEN, action: "approvesend", fields: { msg: "M-3" } } },
  acts: { secondary: [go("Edit wording", "?edit=M-3"), go("Change recipient", "?recipient=M-3")] },
});
export const hub = (booked = true): InterviewHub => ({
  company: "Example Grid Co", stage: "stage 2 of 3", at: "2026-11-10T20:00:00Z", tz: "America/Chicago", interviewerTz: "America/Los_Angeles", minutes: 45, medium: "video", booked, calendarVerified: booked,
  person: { initials: "SP", name: "Sam P.", role: "Operations Director", verified: true, basis: "Identity verified against the recruiter's email. Public professional info only - no personal digging." },
  prep: [{ done: true, text: "Likely topics: grid operations, incident process, cross-team rollout" }, { done: true, text: "Your stories: 3 outlined from confirmed facts - no invented achievements" }, { done: false, text: "Questions to ask: on-call structure, 90-day expectations" }],
  acts: { primary: go("Open prep brief", "?brief=grid", "navigate"), secondary: [go("Propose new time", "?propose=grid"), go("Draft follow-up", "?followup=grid")] },
});
export const weekly = (quiet = false): WeeklyBrief => ({
  week: "Nov 2", n: 4, generatedAt: "2026-11-09T15:00:00Z", cadence: "weekly",
  changed: quiet ? [] : ["1 interview confirmed - Example Grid Co, Nov 10", "9 applications confirmed; 1 employer replied with questions", "2 new verified roles match your constraints"],
  decisions: [{ title: "Interview time for Example Grid Co", text: "3 options found - none booked yet", act: go("Decide", "?decide=time") }, { title: "Broaden search to adjacent roles?", text: "Current filters returned fewer roles this week", act: go("Decide", "?decide=broaden") }],
  blockers: ["One source board blocked automated checks - coverage note added; no roles were invented to fill the gap."],
  acts: { primary: go("Review 2 decisions", "?decisions", "navigate"), secondary: [go("Adjust plan", "?plan"), { label: "Pause search", effect: "danger", post: { token: TOKEN, action: "pause" } }] },
});
export const negotiation = (): Negotiation => ({
  company: "Example Grid Co", v: 2, deadline: "2026-11-13T23:00:00Z", basis: "the signed offer letter",
  position: [{ k: "Target base", v: "$98,000", src: { label: "You confirmed", at: "2026-11-08T18:00:00Z" } }, { k: "Walk-away floor", v: "$92,000 - private, never shared", src: { label: "You confirmed", at: "2026-11-08T18:00:00Z" } }, { k: "Tradeable", v: "Start date, remote days", src: { label: "You said" } }],
  history: [{ v: "v1 - initial offer", written: true, text: "$92,000 base - 10% target bonus - offer letter Oct 30" }, { v: "v2 - recruiter call", written: false, text: "\"Room on base\"" }],
  ask: { title: "Counter at $98,000 with your rollout record", text: "Evidence-linked wording.", act: go("Review draft", "?draft=counter") },
  acts: { primary: go("Review the counter draft", "?draft=counter", "navigate"), secondary: [go("Adjust priorities", "?priorities"), go("Prepare decision", "?decision")] },
});
export const offers = (): OfferComparison => ({
  deadline: { company: "Grid Co", at: "2026-11-13T23:00:00Z" }, priorities: "You ranked stability over upside - A leads on guaranteed cash.",
  offers: [
    { letter: "A", company: "Example Grid Co", rows: [{ k: "Base", v: "$92,000", src: letter("2026-10-30") }, { k: "Bonus", v: "10% target - not guaranteed", src: letter("2026-10-30") }, { k: "Equity", v: "None", src: letter("2026-10-30") }, { k: "Start / location", v: "Dec 1 - US remote", src: letter("2026-10-30") }, { k: "Total compensation", v: "$101,200", src: { label: "Added up" } }] },
    { letter: "B", company: "Voltline Energy", rows: [{ k: "Base", v: "$85,000", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" } }, { k: "Equity", v: "0.05% - 4yr vest, not cash", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" } },
      { k: "Benefits", v: null, missing: "Unknown - summary only" }, { k: "Clause", v: "Non-solicit - qualified advice suggested", src: { ...letter("2026-11-02"), href: "https://voltline.example.com/offer.pdf" }, tone: "bad" }] },
  ],
  acts: { primary: go("Prepare questions for Voltline", "?questions=voltline", "navigate"), secondary: [go("Negotiate", "?negotiate"), go("Mark preference", "?prefer")] },
});
