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
import type { Act, Block, Chip, FamilyFile, KV, Meta, Part, Src } from "./file_family.ts";
import { STATES, type StateKey } from "./results_spec.ts";

type Acts = { primary?: Act | null; secondary?: Act[]; caption?: string | null };
const card = (label: string, parts: Part[]): Block => ({ b: "card", label, parts });
const note = (tone: "info" | "caution" | "danger", label: string, text: string, act?: Act): Block => ({ b: "note", tone, label, text, act });
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
const external = (s: Src | null | undefined) => !!s && !!s.href && !!s.at;
const fresh = (at: string | null | undefined, basis: string | null | undefined): Meta[] => [{ label: "Updated", at: at ?? null }, { label: "Based on", value: basis ?? null }];
const SENDS = new Set(["submit", "send", "approve"]);
// A control that must not act: the same label and look, disabled, with the reason beside it.
const off = (a: Act | undefined, why: string): Act | undefined => a && { ...a, off: why };

// ---------------------------------------------------------------- F-09 application review (C.11)
export interface ApplicationReview {
  appId: string; rid: string; title: string; company: string; destination: Src; pkg: KV[]; answers: { q: string; a: string | null; required: boolean }[];
  conditions: string[]; approve: Act; edit: Act; cancel: Act;
  // E-71: changed: what changed materially since the person reviewed (back to review); now + staleHours: a destination checked
  // longer ago than that is re-checked before anything acts; after: the real state once approved (never an optimistic Submitted).
  changed?: string | null; now?: number; staleHours?: number;
  after?: { state: "approved" | "in_progress" | "submitted"; evidence?: Src | null } | null;
}
export function applicationReviewFile(d: ApplicationReview): FamilyFile {
  const open = d.answers.filter((x) => x.required && !x.a).length;
  const age = d.now !== undefined ? (d.now - Date.parse(d.destination.at ?? "")) / 3_600_000 : 0;
  const stale = d.now !== undefined && (!d.destination.at || !(age <= (d.staleHours ?? 24)));
  const why = open ? `${n(open, "required answer")} not entered. Approval stays off until you answer.`
    : d.changed ? `Changed since you reviewed: ${d.changed}. Review it again - the earlier approval does not carry over.`
    : stale ? "The destination page was not checked recently. It is re-checked before anything can be approved." : d.after ? "Already approved. It is not approved twice." : null;
  const approve: Act = why ? { ...d.approve, off: why } : d.approve;
  // After approval: the real state, in words. "Submitted - confirmed" only with the employer's evidence (a link and a time).
  const ev = d.after?.evidence && external(d.after.evidence) ? d.after.evidence : null;
  const after: Block[] = !d.after ? [] : [d.after.state === "submitted" && ev
    ? { b: "card", label: "Status", parts: [{ p: "kv", rows: [{ k: "Submitted - confirmed", v: "Employer confirmation on file", src: ev }] }] }
    : note("info", d.after.state === "approved" ? "Approved - not submitted yet." : "In progress - not confirmed.", d.after.state === "submitted" ? "Recorded as submitted, but no employer confirmation with a link and time is on file, so it is still being checked." : "You approved this exact package. It shows Submitted only when the employer confirms it.")];
  return {
    family: "F-09", mono: `${d.appId} - ${d.rid}`, boundary: undefined,
    hero: { kicker: "Final review - approval covers exactly this", title: d.title, meta: [{ label: "", value: d.company }, { label: "Destination verified", at: d.destination.at ?? null }, { label: "Based on", value: "your approved versions" }] },
    blocks: [
      ...after,
      ...(d.changed ? [note("danger", "Changed since your review.", `${d.changed}. This returns to review; nothing is submitted on the old approval.`)] : []),
      card("The package", [{ p: "kv", rows: [...d.pkg, { k: "Destination", v: "Employer application page", src: d.destination }] }]),
      // N1: before approval an answer is a draft; "you approved this wording" only once it is approved.
      card("Exact answers - sent word for word", [{ p: "kv", rows: d.answers.map((x) => ({ k: x.q, v: x.a, src: x.a ? { label: d.after ? "You approved this wording" : "Your draft answer - not approved yet" } : null, missing: x.required ? "Not entered - required" : "Not entered - optional" })) }]),
      card("Conditions - in plain words", [{ p: "check", items: d.conditions.map((t) => ({ state: "met" as const, text: t })) }]),
      note("info", "What happens after approval.", "Trainee fills the reviewed answers on the verified page and submits once. You then see the employer's own confirmation - a click alone never counts as submitted."),
    ],
    actions: { primary: approve, secondary: [d.edit, { ...d.cancel, effect: "danger" }] },
  };
}

// ---------------------------------------------------------------- F-10 batch File (C.12)
export interface BatchRow { rid: string; title: string; key: StateKey; detail: string; evidence?: Src | null; act?: Act; menu?: Act[]; approved: boolean; reviewed?: boolean }
export interface BatchFile { batch: string; review: string; rows: BatchRow[]; expiresAt: string | null; exclusions: string; pause: Act; check?: Act; updatedAt?: string | null;
  approveAll?: { hash: string; token: string } | null; // "Approve these N": the one hash-bound approval of exactly the approvable rows shown (applyall + set)
}
const keyOf = (r: BatchRow): StateKey => r.key === "submitted" && !external(r.evidence) ? "checking" : r.key;
// The batch's own words (p-69): every row is in exactly one, and the five sum to the batch. A row outside the approved scope is "not
// approved" whatever else is true of it; the others come from results_spec's state.
// N2: each state in its own words - only queued, approved and in-progress work is "in progress".
const BUCKET = (r: BatchRow, k: StateKey) => !r.approved ? "not approved" : k === "submitted" ? "confirmed" : k === "uncertain" ? "uncertain" : k === "needs_info" ? "needs answer"
  : k === "user_step" ? "needs you" : k === "blocked" ? "blocked" : k === "closed" || k === "excluded" ? "closed" : "in progress";
// E-72, held on each row: a row not reviewed cannot be approved from here; an uncertain row's submit or retry is off (no blind
// retry); a row outside this batch's approval never carries an approving control.
function rowAct(r: BatchRow, k: StateKey): Act | undefined {
  if (!r.act || !SENDS.has(r.act.effect)) return r.act;
  if (k === "uncertain") return off(r.act, "Submission uncertain - the first attempt may have landed. Retry stays off until the employer status is checked.");
  if (r.reviewed === false) return off(r.act, "Not reviewed - only reviewed rows can be approved.");
  if (!r.approved) return off(r.act, "Outside this batch's approval - it never inherits it.");
  return r.act;
}
const ROW_WORD: Partial<Record<StateKey, string>> = { needs_info: "Needs answer", user_step: "Needs answer" };
export function batchFile(d: BatchFile): FamilyFile {
  // Approvable now: reviewed, inside the approval, ready (prepared), not uncertain - the rows "Approve these N" covers.
  const approvable = d.rows.filter((r) => r.approved && r.reviewed !== false && keyOf(r) === "ready");
  const keys = d.rows.map(keyOf), approved = d.rows.filter((r) => r.approved).length, buckets = d.rows.map((r, i) => BUCKET(r, keys[i]));
  const counts = ["confirmed", "in progress", "uncertain", "needs answer", "needs you", "blocked", "closed", "not approved"].map((b) => ({ n: buckets.filter((x) => x === b).length, label: b })).filter((x) => x.n);
  const needs = buckets.filter((b) => b === "needs answer" || b === "needs you" || b === "uncertain").length, done = buckets.filter((b) => b === "confirmed").length;
  const rows: Block[] = d.rows.map((r, i) => ({ b: "card", parts: [{ p: "item", id: r.rid, chip: { label: ROW_WORD[keys[i]] ?? STATES[keys[i]].label, tone: STATES[keys[i]].tone } as Chip, title: r.title, serif: true,
    text: keys[i] === "checking" && r.key === "submitted" ? "Recorded as submitted; no employer confirmation with a link and time is on file, so it is still being checked." : r.detail,
    src: keys[i] === "submitted" ? r.evidence : null, act: rowAct(r, keys[i]), menu: r.menu }] }));
  return {
    family: "F-10", mono: `${d.batch} - ${d.review}`, boundary: undefined, pause: d.pause,
    hero: { kicker: `Mass apply - batch ${d.batch}`, title: `${n(d.rows.length, "role")} - ${approved} approved`, meta: [{ label: "Approved scope:", value: n(approved, "application") }, { label: "Expires", at: d.expiresAt, future: true }, { label: "Excluded:", value: d.exclusions }, { label: "Updated", at: d.updatedAt ?? null }, { label: "Based on", value: "employer pages and emails" }], counts },
    segments: [{ label: "All", n: d.rows.length, selected: true }, { label: "Confirmed", n: done }, { label: "Needs you", n: needs }, { label: "Other", n: d.rows.length - done - needs }],
    blocks: [
      ...d.rows.filter((r) => r.key === "uncertain").map((r) => note("danger", `${r.rid} - submission uncertain.`, "The final step may have landed; confirmation has not. Trainee is checking the employer status - it will not resubmit blindly.", d.check)),
      ...rows,
      note("info", "Every role accounted once.", `${n(d.rows.length, "role")}, ${d.rows.length} primary states, no double counting. ${d.rows.length - approved === 1 ? "The 1 unapproved row stays visible - it never inherits" : `The ${d.rows.length - approved} unapproved rows stay visible - they never inherit`} this batch's approval.`),
    ],
    actions: { primary: approvable.length && d.approveAll ? { label: `Approve these ${approvable.length}`, effect: "approve", aria: `Approve these ${approvable.length} applications, each exactly as reviewed`, post: { token: d.approveAll.token, action: "applyall", fields: { set: d.approveAll.hash } } } : null,
      secondary: [{ ...d.pause, label: "Pause remaining", effect: "decide" }], caption: `${approvable.length && d.approveAll ? `Approves only ${n(approvable.length, "reviewed row")} shown; if the set changes, nothing is approved. ` : ""}Stops new submissions; in-flight steps are reconciled, not undone.` },
  };
}

// ---------------------------------------------------------------- F-11 pipeline (C.13)
export interface Pipeline {
  counts: { applications: number; interviews: number; offers: number };
  decisions: { title: string; chip: Chip; text: string; act?: Act }[]; waiting: { title: string; chip: Chip; text: string; src?: Src | null }[];
  stages: { title: string; chip: Chip; text: string }[]; watch?: { text: string; active: boolean; stopped?: string | null } | null; acts?: Acts;
  updatedAt?: string | null; basis?: string | null;
  // E-73: apps: one entry per receipt; the count is distinct applications (two roles at one employer are two, one role's duplicate
  // receipts are one). corrections keep the old status as history. alerts: deduplicated by key, each with why it matters.
  apps?: { appId: string; rid: string; company: string }[]; corrections?: { title: string; was: string; now: string; src: Src | null }[];
  alerts?: { key: string; text: string; why: string }[];
}
export function pipelineFile(d: Pipeline): FamilyFile {
  const items = (xs: { title: string; chip: Chip; text: string; act?: Act; src?: Src | null }[], icon?: "mail"): Part[] => xs.map((x) => ({ p: "item", title: x.title, chip: x.chip, text: x.text, act: x.act, src: x.src, icon }));
  // p-72: no hero; the segments first, then each group's label above its card.
  const group = (label: string, parts: Part[]): Block[] => [{ b: "group", label }, { b: "card", parts }];
  const apps = d.apps ? new Set(d.apps.map((a) => a.appId)).size : d.counts.applications;
  const alerts = (d.alerts ?? []).filter((a, i, xs) => xs.findIndex((y) => y.key === a.key) === i); // the first of each key
  return {
    family: "F-11", hero: null, title: "Pipeline", fresh: fresh(d.updatedAt, d.basis),
    segments: [{ label: "Applications", n: apps, selected: true }, { label: "Interviews", n: d.counts.interviews }, { label: "Offers", n: d.counts.offers }],
    blocks: [
      ...(d.decisions.length ? group("Needs a decision", items(d.decisions, "mail")) : []),
      ...(d.waiting.length ? group("Waiting on employers - silence is not rejection", items(d.waiting)) : []),
      ...(d.stages.length ? group("Employer stages - separate from submission", items(d.stages)) : []),
      ...(d.corrections?.length ? group("Corrections - history kept", d.corrections.map((x) => ({ p: "diff" as const, before: x.was, after: x.now, text: x.title, chip: { label: "Corrected", tone: "info" as const } }))) : []),
      ...(d.alerts ? group("Alerts", alerts.length ? alerts.map((a) => ({ p: "item" as const, title: a.text, text: `Why it matters: ${a.why}` })) : [{ p: "text", text: "Nothing changed, so no alert was sent." }]) : []),
      ...(d.watch ? [{ b: "card" as const, parts: [{ p: "tile" as const, icon: "watch" as const, title: "Watch: employer replies", chip: { label: d.watch.active ? "Active" : "Stopped", tone: "info" as const }, text: `${d.watch.text}${!d.watch.active && d.watch.stopped ? ` Stopped: ${d.watch.stopped}.` : ""} A watch never sends follow-ups.` }] }] : []),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-12 people and messages (C.14)
export interface MessageReview {
  kind: string; recipient: { initials: string; name: string; basis: string; resolved: boolean; relation?: string | null }; to: string | null; words: string;
  channel: "email" | "copy"; attachments: string | null; followUp: string; approve: Act; acts?: Acts;
  updatedAt?: string | null; optedOut?: boolean; // E-74: an opt-out stops this and every covered follow-up
  decline?: Act | null; stopFollowUps?: Act | null; // the person's own controls: decline this ask; stop every follow-up to this person
}
export function messageReviewFile(d: MessageReview): FamilyFile {
  const ok = d.recipient.resolved && (d.channel === "copy" || !!d.to);
  const approve = d.optedOut ? { ...d.approve, off: "They opted out. Nothing is sent, and no follow-up is scheduled." }
    : ok ? d.approve : { ...d.approve, off: "The recipient is not resolved, so nothing can be approved yet. No address is guessed." };
  return {
    family: "F-12", boundary: `${d.kind} - not sent`, hero: null, title: "Message review", fresh: fresh(d.updatedAt, "your contacts and your words"), // p-74: the recipient card comes first
    blocks: [
      { b: "card", parts: [{ p: "person", initials: d.recipient.initials, name: `${d.recipient.name} - ${d.recipient.resolved ? "recipient verified" : "recipient not resolved"}`, text: d.recipient.basis, chip: d.recipient.resolved ? { label: "Verified", tone: "confirmed" } : { label: "Not resolved", tone: "attention" } }] },
      card(d.channel === "email" ? "Exact words - sent as you, from your account" : "Exact words - you copy and send them", [{ p: "quote", text: `"${d.words}"` },
        { p: "kv", rows: [{ k: "Channel", v: d.channel === "email" ? "Email from your connected account" : "You send it yourself (copy the text)", src: { label: "The only channels this File can use" } },
          { k: "To", v: d.channel === "email" ? d.to : "Whoever you choose", src: d.to ? { label: "From your contacts" } : null, missing: "Not resolved" },
          { k: "Attachments", v: d.attachments ?? "None", src: { label: "Exactly what is listed" } }, { k: "Follow-up", v: d.optedOut ? "None - they opted out" : d.followUp, src: { label: "Your setting" } }, { k: "If no reply", v: "The ask ends. Silence is never read as a yes.", src: { label: "Always" } }] }]),
      note("info", "Scope.", `Approval sends this one message to this one person. It does not authorize your network, repeated nudges, or a claim that ${d.recipient.resolved ? d.recipient.name : "anyone"} endorses you.`),
      note("caution", "Relationship strength.", `${d.recipient.relation ? `Labeled "${d.recipient.relation}" as you described it, not inflated.` : "No relationship is claimed."} Closeness is never inferred from a platform connection.`),
    ],
    actions: { primary: approve, secondary: [...(d.acts?.secondary ?? []), ...(d.decline ? [d.decline] : []), ...(d.stopFollowUps && !d.optedOut ? [{ ...d.stopFollowUps, effect: "danger" as const }] : [])] },
  };
}

// ---------------------------------------------------------------- F-13 interview hub (C.15)
export interface InterviewHub {
  company: string; stage: string; at: string; tz: string; interviewerTz?: string | null; minutes: number; medium: string; booked: boolean; calendarVerified: boolean;
  person: { initials: string; name: string; role: string; verified: boolean; basis: string }; prep: { done: boolean; lead?: string; text: string }[]; acts?: Acts;
  // E-75: superseded: earlier times a reschedule replaced (shown, never active); feedback: on the answer the person actually gave;
  // assessment: a request for help on a test the employer prohibits it on is refused, with general learning offered instead.
  updatedAt?: string | null; basis?: string | null;
  practice?: Act | null; // the mock interview's own control; absent, the tile has no button (no link to a page that does nothing)
  superseded?: string[]; feedback?: { answer: string; note: string } | null; assessment?: { name: string; prohibited: boolean } | null;
}
const VOCAL = /\b(tone of voice|vocal|your voice|pace|pitch|confident[- ]sounding|sounded)\b/i;
// One absolute time, as p-76 writes it: "Tue Nov 10 - 2:00 PM CST" (the person's zone); time only for the interviewer's zone.
const fmt = (at: string, tz: string, o: Intl.DateTimeFormatOptions) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).formatToParts(new Date(Date.parse(at))).map((x) => [x.type, x.value]));
const clock = (at: string, tz: string, day = true) => { const p = fmt(at, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); return `${day ? `${p.weekday} ${p.month} ${p.day} - ` : ""}${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`; };
export function interviewHubFile(d: InterviewHub): FamilyFile {
  return {
    family: "F-13", boundary: `${d.company} - ${d.stage}`,
    hero: { kicker: d.booked ? "Confirmed logistics" : "Suggested time - not booked", title: clock(d.at, d.tz), meta: [
      ...(d.interviewerTz ? [{ label: "For the interviewer:", value: clock(d.at, d.interviewerTz, false) }] : []), { label: `${d.minutes} min -`, value: d.medium },
      { label: d.calendarVerified ? "Calendar verified" : "Calendar not checked" }, { label: "Updated", at: d.updatedAt ?? null }, { label: "Source:", value: d.basis ?? null }] },
    blocks: [
      ...(d.superseded?.length ? [card("Superseded - not active", d.superseded.map((at) => ({ p: "text" as const, muted: true, text: `${clock(at, d.tz)} - replaced by the time above; its reminders are off.` })))] : []),
      ...(d.assessment?.prohibited ? [note("danger", `Not helping with ${d.assessment.name}.`, "The employer does not allow outside help on this assessment, so Trainee will not answer or coach it. General practice on the same skills is available instead.")] : []),
      card("Who you're meeting", [{ p: "person", initials: d.person.initials, name: `${d.person.name} - ${d.person.role}`, text: d.person.basis, chip: d.person.verified ? { label: "Verified", tone: "confirmed" } : { label: "Not verified", tone: "attention" } }]),
      card("Preparation - this role, this stage", [{ p: "check", items: d.prep.map((p) => ({ state: p.done ? "done" as const : "todo" as const, lead: p.lead, text: p.text })) }]),
      ...(d.feedback ? [card("Feedback on your answer", [{ p: "quote", text: `"${d.feedback.answer}"` }, { p: "text", text: VOCAL.test(d.feedback.note) ? "Feedback on delivery is not given from text practice." : d.feedback.note }])] : []),
      { b: "card", parts: [{ p: "tile", icon: "practice", title: "Mock interview", text: "One question at a time, feedback on your actual answer. Text practice never claims to judge your voice.", act: d.practice ?? undefined }] },
      note("caution", "Reschedule safety.", "If the time changes, the old event and reminders are superseded - you'll never see two active meetings."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-14 weekly brief (C.16) and negotiation plan (C.17)
export interface WeeklyBrief {
  week: string; n: number; generatedAt: string | null; cadence: string; changed: string[]; decisions: { title: string; text: string; act?: Act }[]; blockers: string[]; acts?: Acts;
  basis?: string | null; paused?: boolean; urgent?: { next48: string[]; outside?: string[] } | null; // E-76: an urgent plan leads with 48 hours; legal and benefits go to professionals
}
const COUNT_HEADLINE = /^\s*\d+\s+applications?\b/i;
export function weeklyBriefFile(d: WeeklyBrief): FamilyFile {
  // E-76: the application count is never the headline - a line that leads with it is moved after the rest.
  const changed = [...d.changed.filter((t) => !COUNT_HEADLINE.test(t)), ...d.changed.filter((t) => COUNT_HEADLINE.test(t))];
  return {
    family: "F-14", hero: { kicker: `Week of ${d.week} - brief ${d.n}`, title: "Your week in careers", meta: [{ label: "Generated", at: d.generatedAt }, { label: "Based on", value: d.basis ?? null }, { label: "Cadence:", value: `${d.cadence} - change anytime` }] },
    blocks: [
      ...(d.urgent ? [card("The next 48 hours", [{ p: "check", items: d.urgent.next48.map((t) => ({ state: "todo" as const, text: t })) }]),
        note("caution", "Legal and benefits questions.", `${d.urgent.outside?.length ? `${d.urgent.outside.join("; ")}: ` : ""}these go to a qualified professional (an employment lawyer, your state's unemployment office or a benefits adviser). Trainee does not answer them.`)] : []),
      ...(d.paused ? [note("info", "Paused.", "No new covered actions start while paused. Every record is kept, and nothing already done is undone.")] : []),
      card("What actually changed", changed.length ? [{ p: "check", items: changed.map((t) => ({ state: "done" as const, text: t })) }] : [{ p: "text", lead: "Quiet week.", text: "Nothing changed that Trainee can show evidence for." }]),
      ...(d.decisions.length ? [card("Decisions only you can make", d.decisions.map((x) => ({ p: "item" as const, title: x.title, text: x.text, act: x.act })))] : []),
      ...(d.blockers.length ? [card("Blockers, stated plainly", d.blockers.map((t) => ({ p: "text" as const, text: t })))] : []),
      note("info", "No vanity metrics.", "Application count is not the goal. Quiet weeks say \"quiet week\" - never invented activity or guilt."),
    ],
    actions: d.acts,
  };
}
export interface Negotiation { company: string; v: number; deadline: string | null; basis: string; updatedAt?: string | null; position: KV[]; history: { v: string; written: boolean; text: string }[]; ask: { title: string; text: string; act?: Act }; acts?: Acts }
// E-77: a competing offer, deadline or acceptance intent is drawn only from a document with its link and time; anything else is
// Unconfirmed (never leverage). Approving the plan sends nothing: no control here sends, submits or approves.
const LEVERAGE = /competing|other offer|deadline|accept/i;
const nosend = (a: Act | null | undefined) => a && SENDS.has(a.effect) ? { ...a, effect: "navigate" as const } : a;
export function negotiationFile(d: Negotiation): FamilyFile {
  const position = d.position.map((r) => LEVERAGE.test(r.k) && !external(r.src) ? { ...r, src: null } : r);
  return {
    family: "F-14", header: "Negotiation plan", boundary: "Plan File - nothing sent to any employer",
    hero: { kicker: `Plan File - negotiation - v${d.v}`, title: `${d.company} offer`, meta: [{ label: "Deadline", at: d.deadline, future: true }, { label: "Based on", value: d.basis }, { label: "Updated", at: d.updatedAt ?? null }] },
    blocks: [
      card("Your position - confirmed with you", [{ p: "kv", rows: position }]),
      card("Term history - versions kept separate", d.history.map((h) => ({ p: "item" as const, title: h.v, chip: h.written ? { label: "Written", tone: "neutral" as const } : { label: "Verbal", tone: "attention" as const }, text: h.written ? h.text : `${h.text} - verbal claim, labeled verbal, not treated as a term` }))),
      card("The ask - drafted, awaiting your approval", [{ p: "item", title: d.ask.title, text: `${d.ask.text} Goes through the message review before anything is sent - approving this plan sends nothing.`, act: d.ask.act }]),
      note("caution", "No invented leverage.", "No fabricated competing offers, deadlines, or acceptance intent. Exploring a counter accepts nothing."),
    ],
    actions: d.acts && { ...d.acts, primary: nosend(d.acts.primary), secondary: d.acts.secondary?.map((a) => nosend(a)!) },
  };
}

// ---------------------------------------------------------------- F-15 offer comparison (C.18)
export interface OfferComparison { offers: { letter: string; company: string; rows: KV[] }[]; deadline: { company: string; at: string | null }; priorities?: string | null; acts?: Acts; updatedAt?: string | null }
// E-78: marking a preference accepts, withdraws and resigns nothing. A control that would is never on this page's own actions;
// each of those is its own approved action elsewhere.
const BINDING = /\b(accept|withdraw|resign|decline)\b/i;
export function offerComparisonFile(d: OfferComparison): FamilyFile {
  return {
    family: "F-15", hero: { kicker: `${n(d.offers.length, "offer")} - from actual documents`, title: d.offers.map((o) => o.company).join(" vs "), meta: [{ label: `${d.deadline.company} deadline:`, at: d.deadline.at, future: true }, { label: "Updated", at: d.updatedAt ?? null }] },
    blocks: [
      ...d.offers.map((o): Block => ({ b: "card", parts: [{ p: "heading", title: `${o.letter} - ${o.company}` }, { p: "kv", rows: o.rows.filter((r) => !/\btotal\b/i.test(r.k)) }] })),
      ...(d.priorities ? [note("info", "Your priorities applied.", `${d.priorities} Choosing a favorite here accepts nothing and withdraws nothing.`)] : []),
      note("caution", "Kept honest.", "Equity is never added to cash as one \"total\". Verbal claims stay separate from written terms. Tax and legal questions go to qualified professionals."),
    ],
    actions: d.acts && { ...d.acts, primary: d.acts.primary && BINDING.test(d.acts.primary.label) ? null : d.acts.primary, secondary: d.acts.secondary?.filter((a) => !BINDING.test(a.label)),
      caption: "Marking a preference accepts, withdraws and resigns nothing. Each of those is a separate action you approve." },
  };
}
