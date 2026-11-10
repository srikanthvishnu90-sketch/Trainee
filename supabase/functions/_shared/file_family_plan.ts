// R10 WO-E part 2: the planning and preparation File families in the shared anatomy (file_family.ts): F-01 career brief, F-02 profile
// facts, F-03 path comparison, F-04 search plan, F-06 role workspace, F-07 materials studio, F-08 answer library (spec C.3-C.6,
// C.8-C.10). Each builder takes structured data and returns a FamilyFile; it adds no fact of its own. Section labels and the fixed
// scope notes are the spec's own words (they say what the File does and does not do, never something about the person).
// Every fact arrives with its source (Src): a fact without a value is drawn as Unconfirmed; a posting or document fact without its
// link and read time is drawn as Unconfirmed (file_family.ts claimHtml). Controls come from the caller (Act), so a File never shows
// a button the server cannot answer; a download without a produced file is shown disabled with the reason.
import type { Act, Block, Chip, FamilyFile, KV, Part, Src } from "./file_family.ts";

type Acts = { primary?: Act | null; secondary?: Act[]; caption?: string | null };
const card = (label: string, parts: Part[]): Block => ({ b: "card", label, parts });
const note = (tone: "info" | "caution" | "danger", label: string, text: string): Block => ({ b: "note", tone, label, text });
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

// ---------------------------------------------------------------- F-01 career brief (C.3)
export interface CareerBrief {
  version: number; title: string; updatedAt: string | null; sources: string | null;
  aim: { text: string; detail?: string | null; provisional: boolean }; constraints: string[];
  questions: { q: string; why: string; act?: Act }[]; first: { done: boolean; text: string }[]; acts?: Acts;
}
export function careerBriefFile(d: CareerBrief): FamilyFile {
  const aim: Part[] = [{ p: "heading", bold: true, title: d.aim.text }, ...(d.aim.detail || d.aim.provisional ? [{ p: "text" as const, muted: true, text: [d.aim.detail, d.aim.provisional ? "Provisional reading - you can change this anytime." : ""].filter(Boolean).join(" ") }] : [])];
  return {
    family: "F-01", hero: { kicker: `Career brief - v${d.version}`, title: d.title, meta: [{ label: "Updated", at: d.updatedAt }, { label: "Source:", value: d.sources }] },
    blocks: [
      card("What you're aiming for", [...aim, { p: "divider" }, d.constraints.length ? { p: "chips", lead: "Hard constraints", chips: d.constraints.map((c) => ({ label: c, tone: "plum" })) } : { p: "text", lead: "Hard constraints", text: "None confirmed yet." }]),
      ...(d.questions.length ? [card("Open questions - only what blocks good work", d.questions.map((q) => ({ p: "item" as const, title: q.q, text: q.why, act: q.act })))] : []),
      card("First actions", [{ p: "check", items: d.first.map((f) => ({ state: f.done ? "done" as const : "todo" as const, text: f.text })) }]),
      note("info", "Where facts come from.", "Every important fact in this brief links to its source - your resume, a document, or your words in chat. Correcting one fact updates everything that used it."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-02 profile facts (C.4)
export type FactKind = "confirmed" | "estimate" | "inferred" | "review";
export interface ProfileFact { k: string; v: string | null; kind: FactKind; src: Src | null; correct?: Act }
export interface ProfileFacts { facts: ProfileFact[]; conflict?: { text: string } | null; acts?: Acts }
export function profileFactsFile(d: ProfileFacts): FamilyFile {
  const c = (k: FactKind) => d.facts.filter((f) => f.kind === k);
  const kv = (fs: ProfileFact[]): KV[] => fs.map((f) => ({ k: f.k, v: f.v, src: f.src }));
  return {
    family: "F-02", hero: null, title: "Profile facts", // p-46: segments come straight after the header
    segments: [{ label: "Confirmed", n: c("confirmed").length, selected: true }, { label: "Estimates", n: c("estimate").length }, { label: "Inferred", n: c("inferred").length }, { label: "Needs review", n: c("review").length }],
    blocks: [
      ...(d.conflict ? [note("danger", "Conflict to resolve.", d.conflict.text)] : []),
      ...(c("confirmed").length + c("estimate").length ? [card("Confirmed facts - sample", [{ p: "kv", rows: kv([...c("confirmed"), ...c("estimate")]) }])] : []),
      ...(c("inferred").length ? [card("Inferred preferences - not attestations", c("inferred").map((f) => ({ p: "item" as const, title: f.v ?? f.k, text: `Working interpretation from ${f.k} - never sent to employers.`, act: f.correct })))] : []),
      card("Sensitive fields", [{ p: "tile", icon: "lock", title: "Work authorization, veteran status, demographics", text: "Answered per application, only by you. Never guessed, never reused silently. \"Prefer not to say\" is respected." }]),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-03 path comparison (C.5)
export interface Direction { letter: string; name: string; reach: string; evidence: "Strong" | "Partial" | "Weak"; rows: KV[] }
export interface PathComparison { title: string; confirmedFacts: number; updatedAt: string | null; directions: Direction[]; experiment?: string | null; acts?: Acts }
const EVIDENCE: Record<Direction["evidence"], Chip["tone"]> = { Strong: "confirmed", Partial: "attention", Weak: "risk" };
export function pathComparisonFile(d: PathComparison): FamilyFile {
  return {
    family: "F-03", hero: { kicker: `Comparing ${n(d.directions.length, "direction")}`, title: d.title, meta: [{ label: "Based on", value: n(d.confirmedFacts, "confirmed fact") }, { label: "Updated", at: d.updatedAt }] },
    blocks: [
      ...d.directions.map((x): Block => ({ b: "card", parts: [{ p: "heading", title: `${x.letter} - ${x.name}`, sub: x.reach, chip: { label: `${x.evidence} evidence`, tone: EVIDENCE[x.evidence] } }, { p: "kv", rows: x.rows }] })),
      ...(d.experiment ? [note("info", "Recommended experiment:", d.experiment)] : []),
      note("caution", "Unknowns stay unknown.", "Hiring odds are not predicted. No course or certification is claimed to guarantee progression."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-04 search plan (C.6)
export interface SearchPlan { version: number; title: string; batchCap: number; updatedAt: string | null; hard: KV[]; prefs: KV[]; watch?: { text: string; active: boolean } | null; acts?: Acts }
export function searchPlanFile(d: SearchPlan): FamilyFile {
  return {
    family: "F-04", boundary: `Plan v${d.version} - searching is not applying`,
    hero: { kicker: `Search plan - v${d.version}`, title: d.title, meta: [{ label: "First batch:", value: `${d.batchCap} roles max` }, { label: "Calibration before scaling" }, { label: "Updated", at: d.updatedAt }] },
    blocks: [
      card("Hard constraints - cannot be overridden by fit score", [{ p: "kv", rows: d.hard }]),
      card("Preferences - influence ranking, never gate", [{ p: "kv", rows: d.prefs }]),
      ...(d.watch ? [{ b: "card" as const, parts: [{ p: "tile" as const, icon: "watch" as const, title: "Watch: new roles", chip: { label: d.watch.active ? "Active" : "Paused", tone: "info" as const }, text: `${d.watch.text} Watching never submits anything.` }] }] : []),
      note("info", "What approval covers.", "Approving this plan authorizes searching and shortlisting only. Every application still needs its own review. If constraints return almost nothing, you'll see which constraint is limiting - not padded weak matches."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-06 role workspace (C.8)
export interface RoleWorkspace {
  rid: string; appId?: string | null; title: string; company: string; req?: string | null; checkedAt: string | null; postingUrl: string | null;
  fit: { state: "met" | "partial" | "missing" | "unknown"; text: string; src?: Src | null }[]; materials: KV[];
  route: { supported: boolean; text: string }; declaration?: string | null; acts?: Acts;
}
const FIT_LEAD = { met: "Met:", partial: "Partly evidenced:", missing: "Missing:", unknown: "Unknown:" } as const;
export function roleWorkspaceFile(d: RoleWorkspace): FamilyFile {
  return {
    family: "F-06", mono: [d.rid, d.appId].filter(Boolean).join(" - "), boundary: undefined,
    hero: { kicker: "Role workspace", title: d.title, meta: [{ label: "", value: d.company }, { label: "Req", value: d.req ?? null }, { label: "Checked", at: d.checkedAt }] },
    blocks: [
      card("Fit and eligibility", [{ p: "check", items: d.fit.map((f) => ({ state: f.state, lead: FIT_LEAD[f.state], text: f.text, src: f.src })) }]),
      card("Materials for this role", [{ p: "kv", rows: d.materials }]),
      { b: "card", parts: [{ p: "tile", icon: "route", title: "Execution route", text: `${d.route.supported ? "Supported" : "Not supported - you do this step"}: ${d.route.text}` }] },
      ...(d.declaration ? [note("caution", "Declarations.", d.declaration)] : []),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-07 materials studio (C.9)
export type ChangeKind = "Emphasis" | "Wording" | "Fact needed";
// lead: a bold run-in before the text ("Needs your input"); from: the version pair the summary compares ("v2", "v3").
export interface Materials {
  rid: string; docTitle: string; base: string; approved?: string | null; draft: string; updatedAt: string | null;
  changes: { kind: ChangeKind; before?: string | null; after: string; text: string; lead?: string }[]; format: string | null; usedBy: string; download: Act; acts?: Acts;
  // Item 6 S3: the document's kind for the header ("Resume"), and every version named by its human label (E.4 40).
  kind?: string; versions?: { v: string; label: string; state: string }[];
}
export function materialsFile(d: Materials): FamilyFile {
  const needs = d.changes.filter((c) => c.kind === "Fact needed").length;
  return {
    family: "F-07", boundary: `${d.kind ?? d.docTitle.split(" - ")[0]} - for ${d.rid} - nothing sent`,
    hero: { kicker: "Materials studio", title: d.docTitle, meta: [{ label: "Based on", value: d.base }, { label: `${d.approved ? `${d.approved} approved` : "No version approved"} - ${d.draft}`, value: "draft" }, { label: "Updated", at: d.updatedAt }] },
    blocks: [
      card(`Change summary - ${d.approved ?? "master"} → ${d.draft}${needs ? ` - ${n(needs, "fact")} needed` : ""}`, d.changes.map((c) => ({ p: "diff" as const, before: c.before, after: c.after, text: c.text, lead: c.lead, chip: { label: c.kind, tone: c.kind === "Fact needed" ? "attention" as const : "neutral" as const } }))),
      ...(d.versions?.length ? [card("Versions", [{ p: "kv" as const, rows: d.versions.map((x) => ({ k: `${x.v} - ${x.label}`, v: x.state, src: { label: "your version record" } })) }])] : []),
      note("danger", "Never fabricated.", "No invented metrics, titles, tools, or employers. A missing achievement becomes a question to you, not a sentence in the resume."),
      { b: "card", parts: [{ p: "kv", rows: [{ k: "Format check", v: d.format, src: d.format ? { label: "checked on the file" } : null, missing: "Not checked yet" }, { k: "Used by", v: d.usedBy, src: { label: "approving here covers no other role" } }] }] },
    ],
    actions: { ...d.acts, secondary: [...(d.acts?.secondary ?? []), d.download], caption: d.acts?.caption ?? "Downloading never submits. The approved version is the one used - not the newest." },
  };
}

// ---------------------------------------------------------------- F-08 answer library (C.10)
export interface AnswerLibrary {
  declaration?: { rid: string; text: string } | null; factual: KV[]; roleSpecific: { q: string; scope: string; note: string }[];
  scoped: { q: string; answer: string; scope: string; outside?: string | null }[]; needed: number; acts?: Acts;
}
export function answerLibraryFile(d: AnswerLibrary): FamilyFile {
  return {
    family: "F-08", hero: null, title: "Answer library", // p-64: the blocking banner comes first
    blocks: [
      ...(d.declaration ? [note("caution", `New declaration on ${d.declaration.rid}.`, `"${d.declaration.text}" is an attestation. It blocks submission until you review it - it is never treated as routine reusable text.`)] : []),
      card("Factual - reused with source", [{ p: "kv", rows: d.factual }]),
      ...(d.roleSpecific.length ? [card("Role-specific - drafted from evidence", d.roleSpecific.map((r) => ({ p: "item" as const, title: `"${r.q}"`, chip: { label: r.scope, tone: "plum" as const }, text: r.note })))] : []),
      ...(d.scoped.length ? [card("Scoped reuse", d.scoped.map((s) => ({ p: "item" as const, title: s.q, chip: { label: "Scoped", tone: "info" as const }, text: `Answer: "${s.answer}" - scoped to ${s.scope}. ${s.outside ?? "Anything outside that scope"} would ask again, not reuse silently.` })))] : []),
      card("Sensitive - always yours", [{ p: "tile", icon: "lock", title: "Sponsorship, demographics, disability, veteran status", text: "Never guessed or inferred. Optional fields say so. \"Prefer not to say\" is preserved, not recommended." }]),
    ],
    actions: d.acts,
  };
}
