// R10 WO-E part 2: the planning and preparation File families in the shared anatomy (file_family.ts): F-01 career brief, F-02 profile
// facts, F-03 path comparison, F-04 search plan, F-06 role workspace, F-07 materials studio, F-08 answer library (spec C.3-C.6,
// C.8-C.10). Each builder takes structured data and returns a FamilyFile; it adds no fact of its own. Section labels and the fixed
// scope notes are the spec's own words (they say what the File does and does not do, never something about the person).
// Every fact arrives with its source (Src): a fact without a value is drawn as Unconfirmed; a posting or document fact without its
// link and read time is drawn as Unconfirmed (file_family.ts claimHtml). Controls come from the caller (Act), so a File never shows
// a button the server cannot answer; a download without a produced file is shown disabled with the reason.
import type { Act, Block, Chip, FamilyFile, KV, Meta, Part, Src } from "./file_family.ts";

type Acts = { primary?: Act | null; secondary?: Act[]; caption?: string | null };
const card = (label: string, parts: Part[]): Block => ({ b: "card", label, parts });
const note = (tone: "info" | "caution" | "danger", label: string, text: string): Block => ({ b: "note", tone, label, text });
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
// D.4-1 for a File with no hero: when it was drawn and what it is based on, said under the header (no time on file: "time unknown").
const fresh = (at: string | null | undefined, basis: string | null | undefined): Meta[] => [{ label: "Updated", at: at ?? null }, { label: "Based on", value: basis ?? null }];
// D.4-6 / E-64: the fields only the person answers, per application. Never shown as a reusable value, never guessed.
export const SENSITIVE = /work auth|authori[sz]ation|sponsor|visa|veteran|disab|gender|race|ethnic|demograph|graduation|\bgpa\b|pronoun|religio|criminal/i;
const PREFER_NOT = /^prefer not to (say|answer|disclose)\.?$/i;

// ---------------------------------------------------------------- F-01 career brief (C.3)
export interface CareerBrief {
  version: number; title: string; updatedAt: string | null; sources: string | null;
  // A constraint is the person's own words (a string, or from: "you" / "resume"); one Trainee only inferred is never drawn as a
  // constraint. In the four fields the spec names (work authorization, seniority, pay floor, relocation) an inferred one becomes
  // an open question instead (E-63: never assumed).
  aim: { text: string; detail?: string | null; provisional: boolean }; constraints: (string | { label: string; from: "you" | "resume" | "inferred" })[];
  questions: { q: string; why: string; act?: Act }[]; first: { done: boolean; text: string }[]; acts?: Acts;
  corrections?: { fact: string; was: string; now: string; dependents: string[] }[]; // E-63: a correction flags what used it; nothing restarts
}
const NEVER_ASSUMED = /authori[sz]ation|sponsor|visa|senior|level|\bpay\b|salary|\$|base|relocat|move to/i;
export function careerBriefFile(d: CareerBrief): FamilyFile {
  const cs = d.constraints.map((x) => typeof x === "string" ? { label: x, from: "you" as const } : x);
  const kept = cs.filter((x) => x.from !== "inferred").map((x) => x.label);
  const asked = cs.filter((x) => x.from === "inferred" && NEVER_ASSUMED.test(x.label)).map((x): CareerBrief["questions"][number] => ({ q: `Confirm: ${x.label}?`, why: "Not assumed. Trainee only uses it once you say so." }));
  const questions = [...asked, ...d.questions];
  const aim: Part[] = [{ p: "heading", bold: true, title: d.aim.text }, ...(d.aim.detail || d.aim.provisional ? [{ p: "text" as const, muted: true, text: [d.aim.detail, d.aim.provisional ? "Provisional reading - you can change this anytime." : ""].filter(Boolean).join(" ") }] : [])];
  return {
    family: "F-01", hero: { kicker: `Career brief - v${d.version}`, title: d.title, meta: [{ label: "Updated", at: d.updatedAt }, { label: "Source:", value: d.sources }] },
    blocks: [
      card("What you're aiming for", [...aim, { p: "divider" }, kept.length ? { p: "chips", lead: "Hard constraints", chips: kept.map((c) => ({ label: c, tone: "plum" })) } : { p: "text", lead: "Hard constraints", text: "None confirmed yet." }]),
      ...(d.corrections ?? []).map((x) => note("caution", `Corrected: ${x.fact}.`, `"${x.was}" is now "${x.now}". ${x.dependents.length ? `Flagged for a re-check because they used it: ${x.dependents.join("; ")}.` : "Nothing else used it."} The brief keeps its version; nothing restarts.`)),
      ...(questions.length ? [card("Open questions - only what blocks good work", questions.map((q) => ({ p: "item" as const, title: q.q, text: q.why, act: q.act })))] : []),
      card("First actions", [{ p: "check", items: d.first.map((f) => ({ state: f.done ? "done" as const : "todo" as const, text: f.text })) }]),
      note("info", "Where facts come from.", "Every important fact in this brief links to its source - your resume, a document, or your words in chat. Correcting one fact updates everything that used it."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-02 profile facts (C.4)
export type FactKind = "confirmed" | "estimate" | "inferred" | "review" | "external";
// confirm / correct: the person's own controls on this fact (review facts are confirmed or corrected; any fact can be corrected).
export interface ProfileFact { k: string; v: string | null; kind: FactKind; src: Src | null; correct?: Act; confirm?: Act }
export interface ProfileFacts { facts: ProfileFact[]; conflict?: { text: string } | null; acts?: Acts; updatedAt?: string | null; basis?: string | null; achievements?: { text: string; date: string; src: Src | null; reuse?: Act }[] }
// E-64: a category is never silently upgraded. A "confirmed" fact needs a source the person gave or confirmed; without one it is
// shown under Needs review. An estimate keeps "your estimate" beside its value. A sensitive field is never a stored value here.
const KIND_WORD: Record<FactKind, string> = { confirmed: "confirmed", estimate: "your estimate", inferred: "inferred", review: "needs review", external: "external" };
export function profileFactsFile(d: ProfileFacts): FamilyFile {
  // A sensitive field with an answer on file is never drawn as a reusable value (only "prefer not to say", kept as said); one with no
  // answer is drawn like any missing fact (Unconfirmed). A value without a source is drawn Unconfirmed by the shell, never as a fact.
  const withheld = (f: ProfileFact) => SENSITIVE.test(f.k) && !!f.v && !PREFER_NOT.test(f.v.trim());
  const sens = d.facts.filter((f) => SENSITIVE.test(f.k) && !!f.v);
  const c = (k: FactKind) => d.facts.filter((f) => f.kind === k);
  const word = (f: ProfileFact) => f.src && !f.src.label.toLowerCase().includes(KIND_WORD[f.kind]) ? { ...f.src, label: `${f.src.label}, ${KIND_WORD[f.kind]}` } : f.src;
  const kv = (fs: ProfileFact[]): KV[] => fs.filter((f) => !SENSITIVE.test(f.k) || !f.v).map((f) => ({ k: f.k, v: f.v, src: word(f) }));
  return {
    family: "F-02", hero: null, title: "Profile facts", fresh: fresh(d.updatedAt, d.basis), // p-46: segments come straight after the header
    segments: [{ label: "Confirmed", n: c("confirmed").length, selected: true }, { label: "Estimates", n: c("estimate").length }, { label: "Inferred", n: c("inferred").length }, ...(c("external").length ? [{ label: "External", n: c("external").length }] : []), { label: "Needs review", n: c("review").length }],
    blocks: [
      ...(d.conflict ? [note("danger", "Conflict to resolve.", d.conflict.text)] : []),
      // Each category in its own place, so an estimate never sits among confirmed facts (E-64).
      ...(c("confirmed").length ? [card("Confirmed facts - sample", [{ p: "kv", rows: kv(c("confirmed")) }])] : []),
      ...(c("estimate").length ? [card("Your estimates - not confirmed facts", [{ p: "kv", rows: kv(c("estimate")) }])] : []),
      ...(c("external").length ? [card("External facts - from their source, with its link and time", [{ p: "kv", rows: kv(c("external")).map((r) => ({ ...r, src: r.src && { ...r.src, external: true } })) }])] : []),
      // Review facts with a value are listed with Confirm and Correct; a sensitive one stays in the sensitive card (D.4-6).
      ...(c("review").filter((f) => f.v && !SENSITIVE.test(f.k)).length ? [card("Needs review - not used until you confirm", c("review").filter((f) => f.v && !SENSITIVE.test(f.k)).map((f) => ({ p: "item" as const, chip: { label: "Needs review", tone: "attention" as const }, title: f.k, text: f.v!, src: f.src, act: f.confirm, menu: f.correct ? [f.correct] : undefined })))] : []),
      ...(d.facts.some((f) => f.kind !== "review" && f.correct && f.kind !== "inferred") ? [card("Correct a fact", d.facts.filter((f) => f.kind !== "review" && f.kind !== "inferred" && f.correct && !SENSITIVE.test(f.k)).map((f) => ({ p: "item" as const, title: f.k, text: f.v ?? "unknown", act: f.correct })))] : []),
      ...(c("inferred").length ? [card("Inferred preferences - not attestations", c("inferred").map((f) => ({ p: "item" as const, title: f.v ?? f.k, text: `Working interpretation from ${f.k} - never sent to employers.`, act: f.correct })))] : []),
      ...(d.achievements?.length ? [card("Achievements - dated, reuse per item", d.achievements.map((a) => ({ p: "item" as const, title: a.text, text: `Dated ${a.date}`, src: a.src, act: a.reuse })))] : []),
      card("Sensitive fields", [{ p: "tile", icon: "lock", title: "Work authorization, veteran status, demographics", text: "Answered per application, only by you. Never guessed, never reused silently. \"Prefer not to say\" is respected." },
        ...sens.map((f) => ({ p: "text" as const, lead: `${f.k}:`, text: withheld(f) ? "answered per application, by you. No stored answer is reused." : `"${f.v!.trim()}" - kept exactly as you said it.` }))]),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-03 path comparison (C.5)
export interface Direction { letter: string; name: string; reach: string; evidence: "Strong" | "Partial" | "Weak"; rows: KV[]; bridge?: boolean; rank?: number }
export interface PathComparison { title: string; confirmedFacts: number; updatedAt: string | null; directions: Direction[]; experiment?: string | null; acts?: Acts; priority?: string | null }
// E-65: no hiring-odds figure, and no private gap reason, is ever drawn, whatever the caller passes.
const ODDS = /\bodds\b|chance|probab|likelihood|hire rate|success rate/i, GAP = /\bgap\b|reason for leaving|why (you )?left|unemploy|time off/i;
const EVIDENCE: Record<Direction["evidence"], Chip["tone"]> = { Strong: "confirmed", Partial: "attention", Weak: "risk" };
export function pathComparisonFile(d: PathComparison): FamilyFile {
  // A priority change re-ranks the same directions in place (rank ascending; ties keep their order) - the File is not rebuilt.
  const dirs = d.directions.map((x, i) => ({ x, i })).sort((a, b) => (a.x.rank ?? a.i) - (b.x.rank ?? b.i) || a.i - b.i).map((y) => y.x);
  const rows = (r: KV[]) => r.filter((k) => !ODDS.test(k.k) && !ODDS.test(k.v ?? "") && !GAP.test(k.k));
  return {
    family: "F-03", hero: { kicker: `Comparing ${n(d.directions.length, "direction")}`, title: d.title, meta: [{ label: "Based on", value: n(d.confirmedFacts, "confirmed fact") }, { label: "Updated", at: d.updatedAt }] },
    blocks: [
      ...(d.priority ? [note("info", "Re-ranked in place.", `Ordered for your priority: ${d.priority}. Nothing else changed.`)] : []),
      // For a career changer the direction card is a bridge-role card: the role between where you are and where you are going.
      ...dirs.map((x): Block => ({ b: "card", label: x.bridge ? "Bridge role" : undefined, parts: [{ p: "heading", title: `${x.letter} - ${x.name}`, sub: x.reach, chip: { label: `${x.evidence} evidence`, tone: EVIDENCE[x.evidence] } }, { p: "kv", rows: rows(x.rows) }] })),
      ...(d.experiment ? [note("info", "Recommended experiment:", d.experiment)] : []),
      note("caution", "Unknowns stay unknown.", "Hiring odds are not predicted. No course or certification is claimed to guarantee progression."),
    ],
    actions: d.acts,
  };
}

// ---------------------------------------------------------------- F-04 search plan (C.6)
export interface SearchPlan { version: number; title: string; batchCap: number; updatedAt: string | null; basis?: string | null; hard: KV[]; prefs: KV[]; watch?: { text: string; active: boolean } | null; acts?: Acts; starved?: { found: number; limiting: string } | null }
export function searchPlanFile(d: SearchPlan): FamilyFile {
  return {
    family: "F-04", boundary: `Plan v${d.version} - searching is not applying`,
    hero: { kicker: `Search plan - v${d.version}`, title: d.title, meta: [{ label: "First batch:", value: `${d.batchCap} roles max` }, { label: "Calibration before scaling" }, { label: "Updated", at: d.updatedAt }, { label: "Based on", value: d.basis ?? null }] },
    blocks: [
      // E-66: a starved search names its limiting constraint; it is never padded with weak matches.
      ...(d.starved ? [note("caution", `Only ${n(d.starved.found, "role")} matched.`, `The limiting constraint is ${d.starved.limiting}. No weaker matches were added to fill the list; loosen it or keep it.`)] : []),
      card("Hard constraints - cannot be overridden by fit score", [{ p: "kv", rows: d.hard }]),
      card("Preferences - influence ranking, never gate", [{ p: "kv", rows: d.prefs }]),
      ...(d.watch ? [{ b: "card" as const, parts: [{ p: "tile" as const, icon: "watch" as const, title: "Watch: new roles", chip: { label: d.watch.active ? "Active" : "Paused", tone: "info" as const }, text: `${d.watch.text} Watching never submits anything.` }] }] : []),
      note("info", "What approval covers.", "Approving this plan authorizes searching and shortlisting only. Every application still needs its own review. If constraints return almost nothing, you'll see which constraint is limiting - not padded weak matches."),
    ],
    // E-66: approving the plan authorizes search only, so its primary can never submit, send or approve an application.
    actions: d.acts && { ...d.acts, primary: d.acts.primary && ["submit", "send"].includes(d.acts.primary.effect) ? { ...d.acts.primary, effect: "decide" } : d.acts.primary },
  };
}

// ---------------------------------------------------------------- F-06 role workspace (C.8)
export interface RoleWorkspace {
  rid: string; appId?: string | null; title: string; company: string; req?: string | null; checkedAt: string | null; postingUrl: string | null;
  // hard: a mandatory requirement of the posting (eligibility), kept apart from preference fit. fitLabel: a fit summary, never drawn
  // while a mandatory requirement is unmet or unknown (E-68). route.you: the steps only the person can do.
  fit: { state: "met" | "partial" | "missing" | "unknown"; text: string; src?: Src | null; hard?: boolean }[]; materials: KV[]; fitLabel?: string | null;
  route: { supported: boolean; text: string; you?: string[] }; declaration?: string | null; acts?: Acts;
}
const FIT_LEAD = { met: "Met:", partial: "Partly evidenced:", missing: "Missing:", unknown: "Unknown:" } as const;
export function roleWorkspaceFile(d: RoleWorkspace): FamilyFile {
  const item = (f: RoleWorkspace["fit"][number]) => ({ state: f.state, lead: FIT_LEAD[f.state], text: f.text, src: f.src });
  const hard = d.fit.filter((f) => f.hard), soft = d.fit.filter((f) => !f.hard), unmet = hard.filter((f) => f.state !== "met");
  return {
    family: "F-06", mono: [d.rid, d.appId].filter(Boolean).join(" - "), boundary: undefined,
    hero: { kicker: "Role workspace", title: d.title, meta: [{ label: "", value: d.company }, { label: "Req", value: d.req ?? null }, { label: "Checked", at: d.checkedAt }, { label: "Source:", value: d.postingUrl ? "the employer's posting" : null }] },
    blocks: [
      ...(unmet.length ? [note("danger", "Eligibility not met.", `${unmet.map((f) => f.text).join("; ")}. Fit is not rated while a mandatory requirement is unmet or unknown.`)] : []),
      ...(hard.length ? [card("Eligibility - mandatory, as posted", [{ p: "check", items: hard.map(item) }])] : []),
      card(hard.length ? "Fit - preferences, separate from eligibility" : "Fit and eligibility", [...(d.fitLabel && !unmet.length ? [{ p: "text" as const, text: d.fitLabel }] : []), { p: "check" as const, items: soft.map(item) }]),
      card("Materials for this role", [{ p: "kv", rows: d.materials }]),
      { b: "card", parts: [{ p: "tile", icon: "route", title: "Execution route", text: `${d.route.supported ? "Supported" : "Not supported - you do this step"}: ${d.route.text}${d.route.you?.length ? ` Only you: ${d.route.you.join("; ")}.` : ""}` }] },
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
  portfolio?: { title: string; type: "employment" | "learning" | "draft" }[]; profileEdit?: { site: string; before: string; after: string } | null;
  downloadVersion?: string | null; // the version the download retrieves; anything but the approved one says so and is never the one used
}
const PORTFOLIO: Record<"employment" | "learning" | "draft", Chip> = { employment: { label: "Employment work", tone: "confirmed" }, learning: { label: "Learning project", tone: "info" }, draft: { label: "Draft", tone: "neutral" } };
export function materialsFile(d: Materials): FamilyFile {
  const needs = d.changes.filter((c) => c.kind === "Fact needed").length;
  return {
    family: "F-07", boundary: `${d.docTitle.split(" - ")[0]} - for ${d.rid} - nothing sent`,
    hero: { kicker: "Materials studio", title: d.docTitle, meta: [{ label: "Based on", value: d.base }, { label: `${d.approved ? `${d.approved} approved` : "No version approved"} - ${d.draft}`, value: "draft" }, { label: "Updated", at: d.updatedAt }] },
    blocks: [
      // E-69: a missing achievement is a question to you; its proposed words are never drawn as resume text (no invented metric).
      card(`Change summary - ${d.approved ?? "master"} → ${d.draft}${needs ? ` - ${n(needs, "fact")} needed` : ""}`, d.changes.map((c) => c.kind === "Fact needed"
        ? { p: "item" as const, chip: { label: c.kind, tone: "attention" as const }, title: c.lead ?? "Needs your input", text: `${c.text} Nothing is written until you give the fact.` }
        : { p: "diff" as const, before: c.before, after: c.after, text: c.text, lead: c.lead, chip: { label: c.kind, tone: "neutral" as const } })),
      note("danger", "Never fabricated.", "No invented metrics, titles, tools, or employers. A missing achievement becomes a question to you, not a sentence in the resume."),
      ...(d.portfolio?.length ? [card("Portfolio - kinds kept apart", d.portfolio.map((x) => ({ p: "item" as const, title: x.title, chip: PORTFOLIO[x.type] })))] : []),
      // A profile edit on a site Trainee cannot edit: before and after, with the text to copy. Drafting it touches no public account.
      ...(d.profileEdit ? [card(`Profile edit - ${d.profileEdit.site} - you paste it`, [{ p: "diff", before: d.profileEdit.before, after: d.profileEdit.after, text: "Copy the new text and paste it yourself. Drafting this is not permission to touch your public account; Trainee changes nothing there.", chip: { label: "Copy only", tone: "info" } }])] : []),
      { b: "card", parts: [{ p: "kv", rows: [{ k: "Version used", v: d.approved ? `${d.approved} (approved)` : null, src: d.approved ? { label: "the approved version, not the newest" } : null, missing: "none yet - nothing is used until you approve one" }, { k: "Format check", v: d.format, src: d.format ? { label: "checked on the file" } : null, missing: "Not checked yet" }, { k: "Used by", v: d.usedBy, src: { label: "approving here covers no other role" } }] }] },
    ],
    // The download names the version it retrieves; a draft download says it is not the version used (the approved one is).
    actions: { ...d.acts, secondary: [...(d.acts?.secondary ?? []), d.downloadVersion ? { ...d.download, label: `${d.download.label} ${d.downloadVersion}${d.downloadVersion === d.approved ? " (approved)" : " (draft - not the one used)"}` } : d.download], caption: d.acts?.caption ?? "Downloading never submits. The approved version is the one used - not the newest." },
  };
}

// ---------------------------------------------------------------- F-08 answer library (C.10)
export interface AnswerLibrary {
  declaration?: { rid: string; text: string } | null; factual: KV[]; roleSpecific: { q: string; scope: string; note: string }[];
  scoped: { q: string; answer: string; scope: string; outside?: string | null }[]; needed: number; acts?: Acts; updatedAt?: string | null; basis?: string | null;
}
export function answerLibraryFile(d: AnswerLibrary): FamilyFile {
  return {
    family: "F-08", hero: null, title: "Answer library", fresh: fresh(d.updatedAt, d.basis), // p-64: the blocking banner comes first
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
