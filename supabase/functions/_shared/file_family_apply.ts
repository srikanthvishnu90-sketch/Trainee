// R10 WO-E part 3: the application, follow-through and decision File families in the shared anatomy (file_family.ts): F-09
// application review, F-10 batch File, F-11 pipeline, F-12 people and messages, F-13 interview hub, F-14 weekly brief and its
// negotiation variant, F-15 offer comparison (spec C.11-C.18). Builders take structured data and add no fact of their own.
// Rules held here in code, not in copy:
//   F-09  every answer verbatim; a required answer not entered keeps Approve disabled, with the count said next to it.
//   F-10  role states and labels come from results_spec.ts; counts are one per role and sum to the batch; "Submitted - confirmed"
//         only with employer evidence that has its link and time, otherwise the row reads "Checking"; an uncertain row disables retry.
//   F-12  the channel is email from the person's connected account, or a copy they send themselves; nothing else exists here
//         (CLAUDE.md: never automate LinkedIn). An unresolved recipient keeps Approve send disabled.
//   F-13  suggested is not booked: an unbooked time says so in the hero.
//   F-15  no "total" that mixes cash with equity: a row labelled total is never drawn.
import type { Act, Block, Chip, FamilyFile, KV, Part, Src } from "./file_family.ts";
import { STATES, type StateKey } from "./results_spec.ts";

type Acts = { primary?: Act | null; secondary?: Act[]; caption?: string | null };
const card = (label: string, parts: Part[]): Block => ({ b: "card", label, parts });
const note = (tone: "info" | "caution" | "danger", label: string, text: string, act?: Act): Block => ({ b: "note", tone, label, text, act });
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
const external = (s: Src | null | undefined) => !!s && !!s.href && !!s.at;

// ---------------------------------------------------------------- F-09 application review (C.11)
export interface ApplicationReview {
  appId: string; rid: string; title: string; company: string; destination: Src; pkg: KV[]; answers: { q: string; a: string | null; required: boolean; src?: Src | null }[];
  conditions: string[]; approve: Act; edit: Act; cancel: Act;
  // Item 6 S1 (the live page, file_family_review.ts): the hero's time label when the destination was not re-verified, the open
  // required questions in the form's own words, and where the application stands with its Check status post.
  destinationMeta?: string; open?: { q: string; ask: string; act?: Act }[]; status?: { tone: "info" | "caution" | "danger"; label: string; text: string; act?: Act };
}
export function applicationReviewFile(d: ApplicationReview): FamilyFile {
  const open = d.answers.filter((x) => x.required && !x.a).length;
  const approve: Act = open ? { ...d.approve, off: `${n(open, "required answer")} not entered. Approval stays off until you answer.` } : d.approve;
  return {
    family: "F-09", mono: `${d.appId} - ${d.rid}`, boundary: undefined,
    hero: { kicker: "Final review - approval covers exactly this", title: d.title, meta: [{ label: "", value: d.company }, { label: d.destinationMeta ?? "Destination verified", at: d.destination.at ?? null }] },
    blocks: [
      card("The package", [{ p: "kv", rows: [...d.pkg, { k: "Destination", v: "Employer application page", src: d.destination }] }]),
      card("Exact answers - sent word for word", [{ p: "kv", rows: d.answers.map((x) => ({ k: x.q, v: x.a, src: x.a ? (x.src ?? { label: "You approved this wording" }) : null, missing: x.required ? "Not entered - required" : "Not entered - optional" })) }]),
      ...(d.open?.length ? [card(`Open questions - ${n(d.open.length, "required answer")} not entered, nothing is sent until you answer`, d.open.map((o) => ({ p: "item" as const, title: o.q, text: o.ask, ...(o.act ? { act: o.act } : {}) })))] : []),
      card("Conditions - in plain words", [{ p: "check", items: d.conditions.map((t) => ({ state: "met" as const, text: t })) }]),
      note("info", "What happens after approval.", "Trainee fills the reviewed answers on the verified page and submits once. You then see the employer's own confirmation - a click alone never counts as submitted."),
      ...(d.status ? [note(d.status.tone, d.status.label, d.status.text, d.status.act)] : []),
    ],
    actions: { primary: approve, secondary: [d.edit, { ...d.cancel, effect: "danger" }] },
  };
}

// ---------------------------------------------------------------- F-10 batch File (C.12)
export interface BatchRow { rid: string; title: string; key: StateKey; detail: string; evidence?: Src | null; act?: Act; menu?: Act[]; approved: boolean }
export interface BatchFile { batch: string; review: string; rows: BatchRow[]; expiresAt: string | null; exclusions: string; pause: Act; check?: Act }
const keyOf = (r: BatchRow): StateKey => r.key === "submitted" && !external(r.evidence) ? "checking" : r.key;
// The batch's own words (p-69): every row is in exactly one, and the five sum to the batch. A row outside the approved scope is "not
// approved" whatever else is true of it; the others come from results_spec's state.
const BUCKET = (r: BatchRow, k: StateKey) => !r.approved ? "not approved" : k === "submitted" ? "confirmed" : k === "uncertain" ? "uncertain" : k === "needs_info" || k === "user_step" ? "needs answer" : "in progress";
const ROW_WORD: Partial<Record<StateKey, string>> = { needs_info: "Needs answer", user_step: "Needs answer" };
export function batchFile(d: BatchFile): FamilyFile {
  const keys = d.rows.map(keyOf), approved = d.rows.filter((r) => r.approved).length, buckets = d.rows.map((r, i) => BUCKET(r, keys[i]));
  const counts = ["confirmed", "in progress", "uncertain", "needs answer", "not approved"].map((b) => ({ n: buckets.filter((x) => x === b).length, label: b })).filter((x) => x.n);
  const needs = buckets.filter((b) => b === "needs answer" || b === "uncertain").length, done = buckets.filter((b) => b === "confirmed").length;
  const rows: Block[] = d.rows.map((r, i) => ({ b: "card", parts: [{ p: "item", id: r.rid, chip: { label: ROW_WORD[keys[i]] ?? STATES[keys[i]].label, tone: STATES[keys[i]].tone } as Chip, title: r.title, serif: true,
    text: keys[i] === "checking" && r.key === "submitted" ? "Recorded as submitted; no employer confirmation with a link and time is on file, so it is still being checked." : r.detail,
    src: keys[i] === "submitted" ? r.evidence : null, act: r.act, menu: r.menu }] }));
  return {
    family: "F-10", mono: `${d.batch} - ${d.review}`, boundary: undefined, pause: d.pause,
    hero: { kicker: `Mass apply - batch ${d.batch}`, title: `${n(d.rows.length, "role")} - ${approved} approved`, meta: [{ label: "Approved scope:", value: n(approved, "application") }, { label: "Expires", at: d.expiresAt, future: true }, { label: "Excluded:", value: d.exclusions }], counts },
    segments: [{ label: "All", n: d.rows.length, selected: true }, { label: "Confirmed", n: done }, { label: "Needs you", n: needs }, { label: "Other", n: d.rows.length - done - needs }],
    blocks: [
      ...d.rows.filter((r) => r.key === "uncertain").map((r) => note("danger", `${r.rid} - submission uncertain.`, "The final step may have landed; confirmation has not. Trainee is checking the employer status - it will not resubmit blindly.", d.check)),
      ...rows,
      note("info", "Every role accounted once.", `${n(d.rows.length, "role")}, ${d.rows.length} primary states, no double counting. ${d.rows.length - approved === 1 ? "The 1 unapproved row stays visible - it never inherits" : `The ${d.rows.length - approved} unapproved rows stay visible - they never inherit`} this batch's approval.`),
    ],
    actions: { secondary: [{ ...d.pause, label: "Pause remaining", effect: "decide" }], caption: "Stops new submissions; in-flight steps are reconciled, not undone." },
  };
}

// ---------------------------------------------------------------- F-11 pipeline (C.13)
export interface Pipeline {
  counts: { applications: number; interviews: number; offers: number };
  decisions: { title: string; chip: Chip; text: string; act?: Act }[]; waiting: { title: string; chip: Chip; text: string; src?: Src | null }[];
  stages: { title: string; chip: Chip; text: string }[]; watch?: { text: string; active: boolean } | null; acts?: Acts;
}
export function pipelineFile(d: Pipeline): FamilyFile {
  const items = (xs: { title: string; chip: Chip; text: string; act?: Act; src?: Src | null }[], icon?: "mail"): Part[] => xs.map((x) => ({ p: "item", title: x.title, chip: x.chip, text: x.text, act: x.act, src: x.src, icon }));
  // p-72: no hero; the segments first, then each group's label above its card.
  const group = (label: string, parts: Part[]): Block[] => [{ b: "group", label }, { b: "card", parts }];
  return {
    family: "F-11", hero: null, title: "Pipeline",
    segments: [{ label: "Applications", n: d.counts.applications, selected: true }, { label: "Interviews", n: d.counts.interviews }, { label: "Offers", n: d.counts.offers }],
    blocks: [
      ...(d.decisions.length ? group("Needs a decision", items(d.decisions, "mail")) : []),
      ...(d.waiting.length ? group("Waiting on employers - silence is not rejection", items(d.waiting)) : []),
      ...(d.stages.length ? group("Employer stages - separate from submission", items(d.stages)) : []),
      ...(d.watch ? [{ b: "card" as const, parts: [{ p: "tile" as const, icon: "watch" as const, title: "Watch: employer replies", chip: { label: d.watch.active ? "Active" : "Stopped", tone: "info" as const }, text: `${d.watch.text} A watch never sends follow-ups.` }] }] : []),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-12 people and messages (C.14)
export interface MessageReview {
  kind: string; recipient: { initials: string; name: string; basis: string; resolved: boolean; relation?: string | null }; to: string | null; words: string;
  channel: "email" | "copy"; attachments: string | null; followUp: string; approve: Act; acts?: Acts;
}
export function messageReviewFile(d: MessageReview): FamilyFile {
  const ok = d.recipient.resolved && (d.channel === "copy" || !!d.to);
  const approve = ok ? d.approve : { ...d.approve, off: "The recipient is not resolved, so nothing can be approved yet. No address is guessed." };
  return {
    family: "F-12", boundary: `${d.kind} - not sent`, hero: null, title: "Message review", // p-74: the recipient card comes first
    blocks: [
      { b: "card", parts: [{ p: "person", initials: d.recipient.initials, name: `${d.recipient.name} - ${d.recipient.resolved ? "recipient verified" : "recipient not resolved"}`, text: d.recipient.basis, chip: d.recipient.resolved ? { label: "Verified", tone: "confirmed" } : { label: "Not resolved", tone: "attention" } }] },
      card(d.channel === "email" ? "Exact words - sent as you, from your account" : "Exact words - you copy and send them", [{ p: "quote", text: `"${d.words}"` },
        { p: "kv", rows: [{ k: "Channel", v: d.channel === "email" ? "Email from your connected account" : "You send it yourself (copy the text)", src: { label: "The only channels this File can use" } },
          { k: "To", v: d.channel === "email" ? d.to : "Whoever you choose", src: d.to ? { label: "From your contacts" } : null, missing: "Not resolved" },
          { k: "Attachments", v: d.attachments ?? "None", src: { label: "Exactly what is listed" } }, { k: "Follow-up", v: d.followUp, src: { label: "Your setting" } }] }]),
      note("info", "Scope.", `Approval sends this one message to this one person. It does not authorize your network, repeated nudges, or a claim that ${d.recipient.resolved ? d.recipient.name : "anyone"} endorses you.`),
      note("caution", "Relationship strength.", `${d.recipient.relation ? `Labeled "${d.recipient.relation}" as you described it, not inflated.` : "No relationship is claimed."} Closeness is never inferred from a platform connection.`),
    ],
    actions: { primary: approve, secondary: d.acts?.secondary ?? [] },
  };
}

// ---------------------------------------------------------------- F-13 interview hub (C.15)
export interface InterviewHub {
  company: string; stage: string; at: string; tz: string; interviewerTz?: string | null; minutes: number | null; medium: string; booked: boolean; calendarVerified: boolean;
  person: { initials: string; name: string; role: string; verified: boolean; basis: string }; prep: { done: boolean; lead?: string; text: string }[]; acts?: Acts;
}
// One absolute time, as p-76 writes it: "Tue Nov 10 - 2:00 PM CST" (the person's zone); time only for the interviewer's zone.
const fmt = (at: string, tz: string, o: Intl.DateTimeFormatOptions) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).formatToParts(new Date(Date.parse(at))).map((x) => [x.type, x.value]));
const clock = (at: string, tz: string, day = true) => { const p = fmt(at, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); return `${day ? `${p.weekday} ${p.month} ${p.day} - ` : ""}${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`; };
export function interviewHubFile(d: InterviewHub): FamilyFile {
  return {
    family: "F-13", boundary: `${d.company} - ${d.stage}`,
    hero: { kicker: d.booked ? "Confirmed logistics" : "Suggested time - not booked", title: clock(d.at, d.tz), meta: [
      ...(d.interviewerTz ? [{ label: "For the interviewer:", value: clock(d.at, d.interviewerTz, false) }] : []), { label: d.minutes ? `${d.minutes} min -` : "Length not stated -", value: d.medium },
      { label: d.calendarVerified ? "Calendar verified" : "Calendar not checked" }] },
    blocks: [
      card("Who you're meeting", [{ p: "person", initials: d.person.initials, name: `${d.person.name} - ${d.person.role}`, text: d.person.basis, chip: d.person.verified ? { label: "Verified", tone: "confirmed" } : { label: "Not verified", tone: "attention" } }]),
      card("Preparation - this role, this stage", [{ p: "check", items: d.prep.map((p) => ({ state: p.done ? "done" as const : "todo" as const, lead: p.lead, text: p.text })) }]),
      { b: "card", parts: [{ p: "tile", icon: "practice", title: "Mock interview", text: "One question at a time, feedback on your actual answer. Text practice never claims to judge your voice.", act: { label: "Practice", effect: "decide", href: "?practice=1" } }] },
      note("caution", "Reschedule safety.", "If the time changes, the old event and reminders are superseded - you'll never see two active meetings."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-14 weekly brief (C.16) and negotiation plan (C.17)
export interface WeeklyBrief { week: string; n: number | null; generatedAt: string | null; cadence: string; changed: string[]; decisions: { title: string; text: string; act?: Act }[]; blockers: string[]; acts?: Acts }
export function weeklyBriefFile(d: WeeklyBrief): FamilyFile {
  return {
    family: "F-14", hero: { kicker: `Week of ${d.week}${d.n ? ` - brief ${d.n}` : ""}`, title: "Your week in careers", meta: [{ label: "Generated", at: d.generatedAt }, { label: "Cadence:", value: `${d.cadence} - change anytime` }] },
    blocks: [
      card("What actually changed", d.changed.length ? [{ p: "check", items: d.changed.map((t) => ({ state: "done" as const, text: t })) }] : [{ p: "text", lead: "Quiet week.", text: "Nothing changed that Trainee can show evidence for." }]),
      ...(d.decisions.length ? [card("Decisions only you can make", d.decisions.map((x) => ({ p: "item" as const, title: x.title, text: x.text, act: x.act })))] : []),
      ...(d.blockers.length ? [card("Blockers, stated plainly", d.blockers.map((t) => ({ p: "text" as const, text: t })))] : []),
      note("info", "No vanity metrics.", "Application count is not the goal. Quiet weeks say \"quiet week\" - never invented activity or guilt."),
    ],
    actions: d.acts,
  };
}
export interface Negotiation { company: string; v: number; deadline: string | null; basis: string; position: KV[]; history: { v: string; written: boolean; text: string }[]; ask: { title: string; text: string; act?: Act }; acts?: Acts }
export function negotiationFile(d: Negotiation): FamilyFile {
  return {
    family: "F-14", header: "Negotiation plan", boundary: "Plan File - nothing sent to any employer",
    hero: { kicker: `Plan File - negotiation - v${d.v}`, title: `${d.company} offer`, meta: [{ label: "Deadline", at: d.deadline, future: true }, { label: "Based on", value: d.basis }] },
    blocks: [
      card("Your position - confirmed with you", [{ p: "kv", rows: d.position }]),
      card("Term history - versions kept separate", d.history.map((h) => ({ p: "item" as const, title: h.v, chip: h.written ? { label: "Written", tone: "neutral" as const } : { label: "Verbal", tone: "attention" as const }, text: h.written ? h.text : `${h.text} - verbal claim, labeled verbal, not treated as a term` }))),
      card("The ask - drafted, awaiting your approval", [{ p: "item", title: d.ask.title, text: `${d.ask.text} Goes through the message review before anything is sent - approving this plan sends nothing.`, act: d.ask.act }]),
      note("caution", "No invented leverage.", "No fabricated competing offers, deadlines, or acceptance intent. Exploring a counter accepts nothing."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-15 offer comparison (C.18)
export interface OfferComparison { offers: { letter: string; company: string; rows: KV[] }[]; deadline: { company: string; at: string | null; text?: string | null }; priorities?: string | null; basis?: string; acts?: Acts }
export function offerComparisonFile(d: OfferComparison): FamilyFile {
  return {
    family: "F-15", hero: { kicker: `${n(d.offers.length, "offer")} - ${d.basis ?? "from actual documents"}`, title: d.offers.map((o) => o.company).join(" vs "), meta: [d.deadline.text ? { label: `${d.deadline.company} deadline:`, value: d.deadline.text } : { label: `${d.deadline.company} deadline:`, at: d.deadline.at, future: true }] },
    blocks: [
      ...d.offers.map((o): Block => ({ b: "card", parts: [{ p: "heading", title: `${o.letter} - ${o.company}` }, { p: "kv", rows: o.rows.filter((r) => !/\btotal\b/i.test(r.k)) }] })),
      ...(d.priorities ? [note("info", "Your priorities applied.", `${d.priorities} Choosing a favorite here accepts nothing and withdraws nothing.`)] : [note("info", "Nothing accepted.", "Comparing offers here accepts nothing, declines nothing and sends nothing to any employer.")]),
      note("caution", "Kept honest.", "Equity is never added to cash as one \"total\". Verbal claims stay separate from written terms. Tax and legal questions go to qualified professionals."),
    ],
    actions: d.acts,
  };
}
