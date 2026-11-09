// R10 WO-E (owner order 2026-11-09, spec docs/architect/specs/APP-LAYER-15-FIXES.md C.1, C.24, C.25, D): ONE visual system for the
// fifteen File families. Not a parallel system: it is drawn from the tokens and parts Trainee already has, and each family extends an
// existing File kind or renderer:
//   brand.ts          plum #5C2751, ink, mute, line, good/warn/bad, Inter and Brygada 1918 (brand.ts wins over the spec's sampled hex)
//   results_design.ts the status grounds the roles page already uses (chip and callout fills); its plum ramp is NOT used: the
//                     brand plum is (results_design p700 #512566 vs brand #5C2751; spec D.1 #52245F/#5B2A6B vs brand #5C2751)
//   file_design.ts    esc, freshnessStamp (times in the person's zone), stateHtml (empty/loading/error)
//   results_spec.ts   the role states, tones and mutually exclusive counts (F-05, F-10 use them; nothing is recounted here)
//   file_page.ts      layout(): the page shell (fonts, tokens, the 640 px single column)
//
// Family -> existing kind or renderer it extends (FAMILIES below; spec C.3-C.18):
//   F-01 career brief      career_brief_store / plan_review     F-09 application review application_proof (prepared) + "What will be sent"
//   F-02 profile facts     fact_schema / typed_profile_fields   F-10 batch File          results_batch.ts
//   F-03 path comparison   comparison + career_path.ts          F-11 pipeline            plan_review (variant pipeline)
//   F-04 search plan       plan_review + career_search          F-12 people and messages introduction + draft (email only, never LinkedIn)
//   F-05 roles shortlist   job_list / results_page.ts           F-13 interview hub       plan_review (variant interview_prep)
//   F-06 role workspace    results renderThings + apply_readiness F-14 plan, weekly brief plan_review + career_digest; negotiation: career_offer
//   F-07 materials studio  draft (cover_letter) + career_tailor  F-15 offer comparison    comparison + career_offer
//   F-08 answer library    question_map / career_apply_questions
//
// Rules this module enforces in code (D.4): every fact carries its source or kind; an external claim (a posting, an employer page, a
// document) shows its link and the time it was read, and without both it is drawn as "Unconfirmed", never as a fact; a missing value is
// the word "Unconfirmed" (or the caller's named unknown), never blank and never guessed; a download is a link that retrieves and never
// looks like a submit; a submit or send is a filled button that never looks like a preview; a disabled control says why next to it.
// Pure functions: data in, escaped HTML out.
import { DARK, DISPLAY_FONT, LIGHT, PLUM } from "./brand.ts";
import { esc, freshnessStamp, dateIn, stateHtml } from "./file_design.ts";
import { hostOf, layout, webUrl } from "./file_page.ts";
import { DARK_T, LIGHT_T } from "./results_design.ts";

export type FamilyId = "F-01" | "F-02" | "F-03" | "F-04" | "F-05" | "F-06" | "F-07" | "F-08" | "F-09" | "F-10" | "F-11" | "F-12" | "F-13" | "F-14" | "F-15";
export interface FamilyMeta { name: string; header: string; boundary: string; extends: string }
// The header title and the effect boundary under it (C.1 item 2, D.4.3) are the spec's own labels.
export const FAMILIES: Record<FamilyId, FamilyMeta> = {
  "F-01": { name: "Career brief", header: "Career brief", boundary: "Private File - only you", extends: "career_brief_store.ts, plan_review" },
  "F-02": { name: "Profile facts", header: "Profile facts", boundary: "Private - never sent without approval", extends: "fact_schema.ts, typed_profile_fields.ts" },
  "F-03": { name: "Path comparison", header: "Path comparison", boundary: "Decision File - no applications made", extends: "comparison, career_path.ts" },
  "F-04": { name: "Search plan", header: "Search plan", boundary: "Plan - searching is not applying", extends: "plan_review, career_search.ts" },
  "F-05": { name: "Roles shortlist", header: "Roles File", boundary: "Private workspace - nothing is submitted here", extends: "job_list, results_page.ts, results_spec.ts" },
  "F-06": { name: "Role workspace", header: "Role workspace", boundary: "One role - nothing submitted without your approval", extends: "results_page.ts renderThings, apply_readiness.ts" },
  "F-07": { name: "Materials studio", header: "Materials", boundary: "Drafts - nothing sent", extends: "draft, career_tailor.ts, career_resume_design.ts" },
  "F-08": { name: "Answer library", header: "Answer library", boundary: "Exact outgoing answers - inspectable", extends: "question_map.ts, career_apply_questions.ts" },
  "F-09": { name: "Application review", header: "Application review", boundary: "Approval covers exactly this application", extends: "application_proof, results_page.ts What will be sent" },
  "F-10": { name: "Batch File", header: "Batch File", boundary: "Each role keeps its own state", extends: "results_batch.ts" },
  "F-11": { name: "Pipeline", header: "Pipeline", boundary: "Your search history - no spreadsheet", extends: "plan_review (pipeline)" },
  "F-12": { name: "People and messages", header: "Message review", boundary: "Not sent", extends: "introduction, draft (email)" },
  "F-13": { name: "Interview hub", header: "Interview hub", boundary: "Suggested is not booked", extends: "plan_review (interview_prep)" },
  "F-14": { name: "Plan and weekly brief", header: "Weekly brief", boundary: "Operating rhythm - honest weeks", extends: "plan_review, career_digest.ts, career_offer.ts" },
  "F-15": { name: "Offer comparison", header: "Offer comparison", boundary: "Decision support - nothing accepted", extends: "comparison, career_offer.ts" },
};

// ---------------------------------------------------------------- sources and values (D.4.1, D.4.2)
// external: a posting, an employer page, a board, a document, an offer letter: shown with its link and the time it was read.
// personal: what the person confirmed, estimated, or what Trainee inferred: shown with its kind (and its date when one is known).
export interface Src { label: string; href?: string | null; at?: string | null; dateOnly?: boolean; external?: boolean }
export interface Ctx { now: number; tz?: string | null }
export const UNCONFIRMED = "Unconfirmed";
const blank = (s: unknown) => s === null || s === undefined || !String(s).trim();
const msOf = (t: string | null | undefined) => { const n = t ? Date.parse(t) : NaN; return Number.isNaN(n) ? null : n; };
const isExternal = (s: Src) => s.external === true || !blank(s.href);
// A time in the person's zone, or null (a time ahead of the clock is not a check that happened).
export function timeIn(at: string | null | undefined, c: Ctx, label = "", dateOnly = false): string | null {
  const t = msOf(at);
  if (t === null || t > c.now + 60_000) return null;
  return dateOnly ? `${label ? `${label} ` : ""}${dateIn(t, c.tz)}` : freshnessStamp(label, [t], { now: c.now, tz: c.tz })?.trim() ?? null;
}
const timeTag = (at: string, text: string) => `<time datetime="${esc(new Date(Date.parse(at)).toISOString())}">${esc(text)}</time>`;
// The source line under a value: label · time · link. An external source missing its link or its time is not a source.
export function srcHtml(s: Src, c: Ctx): string {
  const when = timeIn(s.at, c, "", s.dateOnly), link = s.href ? webUrl(s.href) : null;
  const parts = [`<span class="ff-sl">${esc(s.label)}</span>`];
  if (when) parts.push(timeTag(s.at!, when));
  if (link && /^https:/i.test(link)) parts.push(`<a href="${esc(link)}" rel="noopener noreferrer" class="ff-sa">${esc(hostOf(link) || "Source")}<span class="ff-sr"> (opens the source)</span></a>`);
  return `<span class="ff-src">${parts.join(`<span aria-hidden="true"> · </span>`)}</span>`;
}
// A claim: value + its source. External without an https link AND a time: drawn as Unconfirmed (never fabricated, never upgraded).
export function claimHtml(value: string | null | undefined, src: Src | null | undefined, c: Ctx, o: { missing?: string; tone?: "warn" | "bad" } = {}): string {
  const tone = o.tone ? ` ff-t-${o.tone}` : "";
  if (blank(value) || !src) return `<span class="ff-v ff-unk" data-unconfirmed="1">${esc(blank(value) ? (o.missing ?? UNCONFIRMED) : value)}${!blank(value) ? ` <span class="ff-chip ff-c-attention">${UNCONFIRMED}</span>` : ""}</span>`;
  if (isExternal(src)) {
    const link = src.href ? webUrl(src.href) : null, when = timeIn(src.at, c, "", src.dateOnly);
    if (!link || !/^https:/i.test(link) || !when) return `<span class="ff-v" data-claim="1" data-src="unconfirmed">${esc(value)} <span class="ff-chip ff-c-attention">${UNCONFIRMED}</span><span class="ff-src">${esc(src.label)}: ${!link ? "source link not on file" : "time read not on file"}</span></span>`;
    return `<span class="ff-v${tone}" data-claim="1" data-src="external">${esc(value)}${srcHtml(src, c)}</span>`;
  }
  return `<span class="ff-v${tone}" data-claim="1" data-src="personal">${esc(value)}${srcHtml(src, c)}</span>`;
}

// ---------------------------------------------------------------- chips, actions
export type Tone = "neutral" | "info" | "attention" | "plum" | "risk" | "confirmed";
export interface Chip { label: string; tone: Tone }
export const chipHtml = (c: Chip) => `<span class="ff-chip ff-c-${c.tone}">${esc(c.label)}</span>`;
const chips = (xs: readonly Chip[] | undefined) => xs?.length ? `<span class="ff-chips">${xs.map(chipHtml).join("")}</span>` : "";

// effect: what the control does in the world. submit/send/approve always draw filled (never a preview); download always draws as a
// retrieving link with its icon (never like a submit); open goes to another site and says so.
export type Effect = "submit" | "send" | "approve" | "prepare" | "download" | "open" | "navigate" | "decide" | "danger";
export interface Act { label: string; effect: Effect; href?: string | null; post?: { token: string; action: string; fields?: Record<string, string>; id?: string }; off?: string | null; aria?: string; ghost?: boolean }
const FILLED = new Set<Effect>(["submit", "send", "approve"]);
const DL_ICON = `<svg class="ff-ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0 0-4-4m4 4 4-4M4 16h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const OUT_ICON = `<span aria-hidden="true"> ↗</span>`;
export function actHtml(a: Act, primary = false): string {
  const cls = a.effect === "download" ? "ff-btn ff-sec ff-dl" : a.effect === "danger" ? "ff-btn ff-sec ff-danger" : FILLED.has(a.effect) || primary ? "ff-btn ff-pri" : a.ghost ? "ff-btn ff-ghost" : "ff-btn ff-sec";
  const aria = a.aria ? ` aria-label="${esc(a.aria)}"` : "";
  const data = ` data-effect="${a.effect}"`;
  const label = `${a.effect === "download" ? DL_ICON : ""}${esc(a.label)}${a.effect === "open" ? OUT_ICON : ""}`;
  const why = a.off ? `<span class="ff-off">${esc(a.off)}</span>` : "";
  if (a.off) return `<span class="ff-act"><button type="button" class="${cls}" disabled${aria}${data}>${label}</button>${why}</span>`;
  if (a.post) {
    const f = { t: a.post.token, action: a.post.action, ...(a.post.fields ?? {}) };
    return `<form method="post" class="ff-act"${a.post.id ? ` id="${esc(a.post.id)}"` : ""}>${Object.entries(f).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button type="submit" class="${cls}"${aria}${data}>${label}</button></form>`;
  }
  const href = a.href && (webUrl(a.href) || /^(\?|#|\/)/.test(a.href)) ? a.href : null;
  if (!href) return `<span class="ff-act"><button type="button" class="${cls}" disabled${aria}${data}>${label}</button><span class="ff-off">Not available: no link is on file.</span></span>`;
  const ext = a.effect === "open" ? ` rel="noopener noreferrer"` : "";
  return `<a class="${cls}" href="${esc(href)}"${a.effect === "download" ? " download" : ""}${ext}${aria}${data}>${label}</a>`;
}

// ---------------------------------------------------------------- blocks (C.1 items 3-6)
export type CheckState = "met" | "partial" | "missing" | "unknown" | "done" | "todo";
const CHECK_WORD: Record<CheckState, string> = { met: "Met", partial: "Partly evidenced", missing: "Missing", unknown: "Unknown", done: "Done", todo: "Not done" };
export type Icon = "lock" | "target" | "route" | "mail" | "practice" | "watch";
const ICONS: Record<Icon, string> = {
  lock: `<rect x="5" y="9" width="10" height="8" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/>`, target: `<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2"/>`,
  route: `<path d="M4 10h11m0 0-4-4m4 4-4 4"/>`, mail: `<rect x="3" y="5" width="14" height="10" rx="2"/><path d="m3 6 7 5 7-5"/>`,
  practice: `<path d="M8 15V5l8-2v10"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="13" r="2"/>`, watch: `<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2v4m6-4v4"/>`,
};
const iconHtml = (i: Icon) => `<span class="ff-tile" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[i]}</svg></span>`;
export interface KV { k: string; v: string | null; src?: Src | null; missing?: string; tone?: "warn" | "bad" }
export type Part =
  | { p: "text"; lead?: string; text: string; muted?: boolean }
  | { p: "chips"; chips: Chip[]; lead?: string }
  | { p: "kv"; rows: KV[] }
  | { p: "check"; items: { state: CheckState; lead?: string; text: string; src?: Src | null }[] }
  | { p: "item"; id?: string; chip?: Chip; title: string; text?: string; src?: Src | null; act?: Act; serif?: boolean }
  | { p: "tile"; icon: Icon; title: string; text: string; chip?: Chip; act?: Act }
  | { p: "quote"; text: string }
  | { p: "diff"; before?: string | null; after: string; chip?: Chip; text: string }
  | { p: "person"; initials: string; name: string; text: string; chip?: Chip }
  | { p: "divider" }
  | { p: "html"; html: string };
export type Block =
  | { b: "card"; label?: string; parts: Part[]; id?: string }
  | { b: "note"; tone: "info" | "caution" | "danger"; label: string; text: string; act?: Act }
  | { b: "group"; label: string }
  | { b: "html"; html: string }
  | { b: "fn"; html: (c: Ctx) => string }; // drawn at render time, when it needs the clock and the person's zone
function partHtml(x: Part, c: Ctx): string {
  switch (x.p) {
    case "text": return `<p class="ff-p${x.muted ? " ff-mute" : ""}">${x.lead ? `<strong>${esc(x.lead)}</strong> ` : ""}${esc(x.text)}</p>`;
    case "chips": return `<div class="ff-chiprow">${x.lead ? `<strong class="ff-lead">${esc(x.lead)}</strong>` : ""}${chips(x.chips)}</div>`;
    case "kv": return `<dl class="ff-kv">${x.rows.map((r) => `<div class="ff-kvr"><dt>${esc(r.k)}</dt><dd>${claimHtml(r.v, r.src, c, { missing: r.missing, tone: r.tone })}</dd></div>`).join("")}</dl>`;
    case "check": return `<ul class="ff-check">${x.items.map((i) => `<li class="ff-ck ff-ck-${i.state}"><span class="ff-box" aria-hidden="true"></span><span class="ff-ckt"><span class="ff-sr">${CHECK_WORD[i.state]}: </span>${i.lead ? `<strong>${esc(i.lead)}</strong> ` : ""}${i.src ? claimHtml(i.text, i.src, c) : esc(i.text)}</span></li>`).join("")}</ul>`;
    case "item": return `<div class="ff-item"><div class="ff-itb">${x.id || x.chip ? `<p class="ff-idrow">${x.id ? `<span class="ff-id">${esc(x.id)}</span>` : ""}${x.chip ? chipHtml(x.chip) : ""}</p>` : ""}<p class="ff-it${x.serif ? " ff-serif" : ""}">${esc(x.title)}</p>${x.text ? `<p class="ff-p ff-mute">${x.src ? claimHtml(x.text, x.src, c) : esc(x.text)}</p>` : ""}</div>${x.act ? `<div class="ff-ita">${actHtml(x.act)}</div>` : ""}</div>`;
    case "tile": return `<div class="ff-item ff-tiled">${iconHtml(x.icon)}<div class="ff-itb"><p class="ff-it">${esc(x.title)} ${x.chip ? chipHtml(x.chip) : ""}</p><p class="ff-p ff-mute">${esc(x.text)}</p></div>${x.act ? `<div class="ff-ita">${actHtml(x.act)}</div>` : ""}</div>`;
    case "quote": return `<blockquote class="ff-quote">${esc(x.text)}</blockquote>`;
    case "diff": return `<div class="ff-diff">${x.chip ? `<p class="ff-idrow">${chipHtml(x.chip)}</p>` : ""}${x.before ? `<p class="ff-p"><del class="ff-old"><span class="ff-sr">Before: </span>${esc(x.before)}</del></p>` : ""}<p class="ff-p"><ins class="ff-new"><span class="ff-sr">After: </span>${esc(x.after)}</ins></p><p class="ff-p ff-mute">${esc(x.text)}</p></div>`;
    case "person": return `<div class="ff-item ff-tiled"><span class="ff-avatar" aria-hidden="true">${esc(x.initials.slice(0, 3))}</span><div class="ff-itb"><p class="ff-it">${esc(x.name)} ${x.chip ? chipHtml(x.chip) : ""}</p><p class="ff-p ff-mute">${esc(x.text)}</p></div></div>`;
    case "divider": return `<hr class="ff-hr">`;
    case "html": return x.html;
  }
}
export function blockHtml(x: Block, c: Ctx): string {
  switch (x.b) {
    case "card": return `<section class="ff-card"${x.id ? ` id="${esc(x.id)}"` : ""}>${x.label ? `<h2 class="ff-label">${esc(x.label)}</h2>` : ""}${x.parts.map((p) => partHtml(p, c)).join("")}</section>`;
    case "note": return `<aside class="ff-note ff-n-${x.tone}" role="note"><strong>${esc(x.label)}</strong> ${esc(x.text)}${x.act ? ` ${actHtml(x.act)}` : ""}</aside>`;
    case "group": return `<h2 class="ff-group">${esc(x.label)}</h2>`;
    case "html": return x.html;
    case "fn": return x.html(c);
  }
}

// ---------------------------------------------------------------- the File (C.1 anatomy)
export interface Meta { label: string; at?: string | null; dateOnly?: boolean; value?: string | null }
export interface FamilyFile {
  family: FamilyId; header?: string; boundary?: string; mono?: string | null; back?: string | null; menu?: Act[]; pause?: Act | null;
  hero: { kicker: string; title: string; meta: Meta[]; counts?: { n: number; label: string }[] };
  segments?: { label: string; n?: number; href?: string | null; selected?: boolean }[];
  blocks: Block[]; actions?: { primary?: Act | null; secondary?: Act[]; caption?: string | null };
}
// A meta line: a time (in the person's zone; none known: "time unknown", said) or a value (none: Unconfirmed).
function metaHtml(m: Meta, c: Ctx): string {
  if ("at" in m) { const t = timeIn(m.at, c, "", m.dateOnly); return `<span class="ff-meta">${esc(m.label)} ${t ? `<b>${timeTag(m.at!, t)}</b>` : `<b data-unconfirmed="1">time unknown</b>`}</span>`; }
  return `<span class="ff-meta">${esc(m.label)} <b${blank(m.value) ? ` data-unconfirmed="1"` : ""}>${esc(blank(m.value) ? UNCONFIRMED : m.value)}</b></span>`;
}
function headHtml(f: Pick<FamilyFile, "family" | "header" | "boundary" | "mono" | "back" | "menu" | "pause">): string {
  const meta = FAMILIES[f.family];
  const back = f.back ? `<a class="ff-sq" href="${esc(f.back)}" aria-label="Back"><span aria-hidden="true">←</span></a>` : "";
  const menu = f.pause ? actHtml({ ...f.pause, label: "❚❚", aria: f.pause.aria ?? f.pause.label })
    : f.menu?.length ? `<details class="ff-menu"><summary class="ff-sq" aria-label="More actions"><span aria-hidden="true">⋯</span></summary><div class="ff-menul">${f.menu.map((a) => actHtml(a)).join("")}</div></details>` : "";
  return `<header class="ff-head">${back}<div class="ff-hb"><p class="ff-ht">${esc(f.header ?? meta.header)}</p><p class="ff-hs">${f.mono ? `<span class="ff-id">${esc(f.mono)}</span> · ` : ""}${esc(f.boundary ?? meta.boundary)}</p></div>${menu}</header>`;
}
export function familyBodyHtml(f: FamilyFile, c: Ctx): string {
  const h = f.hero;
  const hero = `<section class="ff-hero" aria-label="Summary"><p class="ff-kick">${esc(h.kicker)}</p><h1 class="ff-h1">${esc(h.title)}</h1><p class="ff-metas">${h.meta.map((m) => metaHtml(m, c)).join("")}</p>`
    + (h.counts?.length ? `<ul class="ff-counts" aria-label="Counts">${h.counts.map((x) => `<li><b>${x.n}</b> ${esc(x.label)}</li>`).join("")}</ul>` : "") + `</section>`;
  const seg = f.segments?.length ? `<nav class="ff-seg" aria-label="Show">${f.segments.map((s) => { const t = `${esc(s.label)}${s.n === undefined ? "" : ` <b>${s.n}</b>`}`; return s.href ? `<a href="${esc(s.href)}"${s.selected ? ` aria-current="page" class="on"` : ""}>${t}</a>` : `<span${s.selected ? ` aria-current="page" class="on"` : ""}>${t}</span>`; }).join("")}</nav>` : "";
  const a = f.actions, sec = a?.secondary ?? [];
  const bar = a && (a.primary || sec.length) ? `<div class="ff-bar">${a.primary ? actHtml(a.primary, true) : ""}${sec.length ? `<div class="ff-two">${sec.map((x) => actHtml(x)).join("")}</div>` : ""}${a.caption ? `<p class="ff-cap">${esc(a.caption)}</p>` : ""}</div>` : "";
  return `<div class="ff" data-family="${f.family}">${headHtml(f)}<main id="main">${hero}${seg}${f.blocks.map((b) => blockHtml(b, c)).join("")}${bar}</main></div>`;
}
export const familyPage = (f: FamilyFile, c: Ctx) => layout(`${f.hero.title} - Trainee`, familyBodyHtml(f, c), { css: FAMILY_CSS });

// ---------------------------------------------------------------- shared output states (C.24)
export type StateId = "loading" | "empty" | "needs_input" | "prepared" | "in_progress" | "uncertain" | "confirmed" | "error" | "expired";
// The spec's own message per state (C.24 table).
export const STATE_TITLE: Record<StateId, string> = {
  loading: "Checking the employer page", empty: "No verified roles matched this search", needs_input: "Graduation date needed", prepared: "Ready for review, not submitted",
  in_progress: "Approved, sending not confirmed", uncertain: "Submission may have landed", confirmed: "Employer confirmation verified", error: "Could not load this page", expired: "This link is no longer available",
};
export interface StateInput {
  state: StateId; family: FamilyId; title?: string; // a state title the caller has from data ("Graduation date needed" is the spec's example)
  prior?: Meta | null; scope?: string | null; next?: Act | null; field?: { name: string; why: string } | null; draft?: KV[]; step?: string | null;
  evidence?: { quote: string; src: Src } | null; target?: KV[]; recover?: Act | null;
}
export function familyStateHtml(s: StateInput, c: Ctx): string {
  const t = s.title ?? STATE_TITLE[s.state], kv = (rows?: KV[]) => rows?.length ? partHtml({ p: "kv", rows }, c) : "";
  let body: string;
  switch (s.state) {
    case "loading": body = stateHtml({ kind: "loading", title: t, reason: "No result yet.", next: "This page fills in when the check finishes. The action that would repeat this check is off until then." })
      + (s.prior ? `<p class="ff-p ff-mute">${metaHtml(s.prior, c)}</p>` : "") + actHtml({ label: "Check again", effect: "decide", off: "A check is already running." }); break;
    case "empty": body = stateHtml({ kind: "empty", title: t, reason: s.scope ? `Checked: ${s.scope}` : "The scope checked isn't on file.", next: "No roles were added to fill the gap." }) + (s.next ? actHtml(s.next) : ""); break;
    case "error": body = stateHtml({ kind: "error", title: t, reason: "Nothing was changed and nothing was sent.", next: "Anything you typed here is kept." }) + (s.recover ? actHtml(s.recover, true) : ""); break;
    case "expired": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2><p class="ff-p">Ask Trainee for a new link to the same task.</p>${s.recover ? actHtml(s.recover, true) : ""}</section>`; break;
    case "needs_input": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2>${s.field ? `<aside class="ff-note ff-n-caution" role="note"><strong>${esc(s.field.name)}:</strong> ${esc(s.field.why)}</aside>` : ""}${kv(s.draft)}${s.next ? actHtml(s.next, true) : ""}</section>`; break;
    case "prepared": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2>${chipHtml({ label: "Prepared - not submitted", tone: "plum" })}${kv(s.target)}${s.next ? actHtml(s.next) : ""}</section>`; break;
    case "in_progress": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2>${chipHtml({ label: "In progress", tone: "info" })}<p class="ff-p">${s.step ? `<strong>Step reached:</strong> ${esc(s.step)}` : "The step reached isn't on file."}</p>${kv(s.target)}</section>`; break;
    case "uncertain": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2>${chipHtml({ label: "Submission uncertain", tone: "risk" })}<p class="ff-p">The previous attempt is kept. Retrying is off until the employer's status is checked.</p>${kv(s.target)}${s.next ? actHtml(s.next, true) : ""}${actHtml({ label: "Submit again", effect: "submit", off: "Off until the employer's status is checked: the first attempt may have landed." })}</section>`; break;
    case "confirmed": body = `<section class="ff-state" role="status"><h2 class="ff-st">${esc(t)}</h2>${s.evidence && isExternal(s.evidence.src) ? `${chipHtml({ label: "Submitted - confirmed", tone: "confirmed" })}<figure class="ff-ev"><blockquote class="ff-quote">${esc(s.evidence.quote)}</blockquote><figcaption>${claimHtml("Employer confirmation", s.evidence.src, c)}</figcaption></figure>` : `${chipHtml({ label: "Not confirmed yet", tone: "attention" })}<p class="ff-p">No employer evidence is on file, so this is not shown as confirmed.</p>`}${kv(s.target)}</section>`; break;
  }
  return `<div class="ff" data-family="${s.family}" data-state="${s.state}">${headHtml({ family: s.family })}<main id="main">${body}</main></div>`;
}
export const familyStatePage = (s: StateInput, c: Ctx) => layout(`${STATE_TITLE[s.state]} - Trainee`, familyStateHtml(s, c), { css: FAMILY_CSS });

// ---------------------------------------------------------------- the stylesheet: tokens only (brand.ts + results_design.ts grounds)
const tok = (b: typeof LIGHT, r: typeof LIGHT_T, dark: boolean) => `--ff-bg:${b.bg};--ff-card:${b.card};--ff-ink:${b.ink};--ff-mute:${b.mute};--ff-line:${b.line};--ff-plum:${b.accent};--ff-plum-ink:${b.accentInk};--ff-ptext:${dark ? b.accent : PLUM};`
  + `--ff-hero-a:${DARK.tint};--ff-hero-b:${PLUM};--ff-lav:${r.p50};--ff-lav-line:${r.plumBg};`
  + `--ff-good:${b.good};--ff-warn:${b.warn};--ff-bad:${b.bad};--ff-info:${r.info};--ff-good-bg:${r.confirmedBg};--ff-warn-bg:${r.attentionBg};--ff-bad-bg:${r.riskBg};--ff-info-bg:${r.infoBg};--ff-neu-bg:${r.neutralBg};--ff-plum-bg:${r.plumBg}`;
export const FAMILY_CSS = `
:root{${tok(LIGHT, LIGHT_T, false)}}@media (prefers-color-scheme:dark){:root{${tok(DARK, DARK_T, true)}}}
.wrap:has(>.ff){max-width:680px;padding-left:calc(16px + env(safe-area-inset-left));padding-right:calc(16px + env(safe-area-inset-right))}
.ff{font-size:16px;line-height:1.5;color:var(--ff-ink);overflow-wrap:anywhere}.ff p{margin:0}
.ff-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ff-head{display:flex;align-items:center;gap:12px;padding:0 0 14px;margin:0 0 16px;border-bottom:1px solid var(--ff-line)}
.ff-sq{flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border:1px solid var(--ff-line);border-radius:12px;background:var(--ff-card);color:var(--ff-ink);font-size:20px;text-decoration:none;cursor:pointer;list-style:none}
.ff-sq::-webkit-details-marker{display:none}.ff-hb{flex:1;min-width:0}
.ff-ht{font-family:${DISPLAY_FONT};font-size:24px;font-weight:500;line-height:1.2}.ff-hs{margin-top:2px!important;font-size:15px;color:var(--ff-mute)}
.ff-menu{position:relative}.ff-menul{position:absolute;right:0;top:50px;z-index:3;display:flex;flex-direction:column;gap:8px;min-width:220px;padding:10px;border:1px solid var(--ff-line);border-radius:14px;background:var(--ff-card)}
.ff-hero{margin:0 0 16px;padding:20px;border-radius:20px;background-color:var(--ff-hero-b);background-image:linear-gradient(135deg,var(--ff-hero-a),var(--ff-hero-b));color:#fff}
.ff-kick{font-size:14px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#F1E8F5}
.ff-h1{margin:6px 0 10px;font-family:${DISPLAY_FONT};font-size:30px;font-weight:500;line-height:1.18;color:#fff}
.ff-metas{display:flex;flex-wrap:wrap;gap:4px 16px}.ff-meta{font-size:15px;color:var(--ff-mute)}.ff-meta b{color:var(--ff-ink);font-weight:700}.ff-hero .ff-meta{color:#F1E8F5}.ff-hero .ff-meta b{color:#fff}
.ff-counts{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px}.ff-counts li{padding:4px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.12);color:#fff;font-size:15px}
.ff-seg{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 16px;padding:4px;border-radius:14px;background:var(--ff-neu-bg)}
.ff-seg a,.ff-seg span{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:4px 12px;border-radius:10px;color:var(--ff-ink);font-size:15px;text-decoration:none}
.ff-seg .on{background:var(--ff-card);color:var(--ff-ptext);font-weight:700}
.ff-card{margin:0 0 16px;padding:20px;border:1px solid var(--ff-line);border-radius:20px;background:var(--ff-card)}
.ff-label,.ff-group{margin:0 0 12px;font-size:14px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ff-mute)}.ff-group{margin:22px 0 10px}
.ff-p+.ff-p,.ff-p+.ff-chiprow,.ff-chiprow+.ff-p{margin-top:6px}.ff-mute{color:var(--ff-mute)}.ff-lead{margin-right:4px}
.ff-hr{border:0;border-top:1px solid var(--ff-line);margin:14px 0}
.ff-chips,.ff-chiprow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ff-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:14px;font-weight:700;line-height:1.5;background:var(--ff-neu-bg);color:var(--ff-mute);white-space:normal}
.ff-c-confirmed,.ff-c-attention,.ff-c-risk,.ff-c-info{}.ff-c-confirmed::before,.ff-c-attention::before,.ff-c-risk::before,.ff-c-info::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
.ff-c-confirmed{background:var(--ff-good-bg);color:var(--ff-good)}.ff-c-attention{background:var(--ff-warn-bg);color:var(--ff-warn)}.ff-c-risk{background:var(--ff-bad-bg);color:var(--ff-bad)}
.ff-c-info{background:var(--ff-info-bg);color:var(--ff-info)}.ff-c-plum{background:var(--ff-plum-bg);color:var(--ff-ptext)}
.ff-kv{margin:0}.ff-kvr{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--ff-line)}.ff-kvr:first-child{border-top:0;padding-top:0}
.ff-kvr dt{flex:0 1 40%;color:var(--ff-mute)}.ff-kvr dd{flex:1 1 60%;margin:0;text-align:right;font-weight:600;min-width:0}
.ff-v{display:inline}.ff-t-warn{color:var(--ff-warn)}.ff-t-bad{color:var(--ff-bad)}.ff-unk{color:var(--ff-mute);font-style:italic;font-weight:500}
.ff-src{display:block;margin-top:2px;font-size:14px;font-weight:400;color:var(--ff-mute)}.ff-src time{white-space:nowrap}
.ff-sa{display:inline-flex;align-items:center;min-height:44px;color:var(--ff-ptext);font-weight:600}
.ff-check{list-style:none;margin:0;padding:0}.ff-ck{display:flex;gap:12px;align-items:flex-start;padding:8px 0}
.ff-box{flex:none;width:22px;height:22px;margin-top:1px;border-radius:7px;border:2px solid var(--ff-mute);background:var(--ff-card)}
.ff-ck-met .ff-box,.ff-ck-done .ff-box{border-color:var(--ff-good);background:var(--ff-good) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='m5 10 3 3 7-7' fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E") center/16px no-repeat}
.ff-ck-partial .ff-box{border-color:var(--ff-warn);background:var(--ff-warn-bg)}.ff-ck-missing .ff-box,.ff-ck-unknown .ff-box{border-color:var(--ff-bad);background:var(--ff-bad-bg)}
.ff-ckt{flex:1;min-width:0}
.ff-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--ff-line)}.ff-card>.ff-item:first-of-type,.ff-label+.ff-item{border-top:0;padding-top:0}
.ff-itb{flex:1;min-width:0}.ff-tiled{flex-wrap:wrap}.ff-tiled>.ff-itb{flex:1 1 200px}.ff-tiled>.ff-ita{flex:1 1 100%;max-width:none;padding-left:52px}.ff-ita{flex:none;max-width:48%}.ff-it{font-weight:700;font-size:17px}.ff-serif{font-family:${DISPLAY_FONT};font-weight:500;font-size:21px;line-height:1.25}
.ff-idrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:6px!important}
.ff-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:600;color:var(--ff-mute)}
.ff-tile,.ff-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--ff-lav);color:var(--ff-ptext)}.ff-tile svg{width:22px;height:22px}
.ff-avatar{border-radius:50%;background:var(--ff-plum-bg);font-weight:700;font-size:15px}
.ff-quote{margin:0 0 12px;padding:14px 16px;border-radius:14px;background:var(--ff-lav);border:1px solid var(--ff-lav-line);white-space:pre-wrap}
.ff-diff{padding:12px 0;border-top:1px solid var(--ff-line)}.ff-old{background:var(--ff-bad-bg);color:var(--ff-bad);text-decoration:line-through}.ff-new{background:var(--ff-good-bg);color:var(--ff-good);text-decoration:none}
.ff-note{display:block;margin:0 0 16px;padding:14px 16px;border-radius:20px;border:1px solid;font-size:16px}
.ff-n-info{background:var(--ff-lav);border-color:var(--ff-lav-line);color:var(--ff-ink)}.ff-n-info strong{color:var(--ff-ptext)}
.ff-n-caution{background:var(--ff-warn-bg);border-color:var(--ff-warn);color:var(--ff-ink)}.ff-n-caution strong{color:var(--ff-warn)}
.ff-n-danger{background:var(--ff-bad-bg);border-color:var(--ff-bad);color:var(--ff-ink)}.ff-n-danger strong{color:var(--ff-bad)}
.ff-fit{margin:12px 0 0;padding:10px 14px;border-left:4px solid var(--ff-plum);border-radius:0 12px 12px 0;background:var(--ff-lav)}
.ff-fit.ff-n-danger{background:var(--ff-bad-bg);border-left-color:var(--ff-bad)}.ff-fit.ff-n-danger strong{color:var(--ff-bad)}
.ff-role{padding:16px 0;border-top:1px solid var(--ff-line)}.ff-card>.ff-role:first-of-type{border-top:0;padding-top:0}
.ff-ra{display:flex;flex-direction:column;gap:10px;margin-top:12px}.ff-rl{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
.ff-role details{margin-top:10px}.ff-role summary{display:flex;align-items:center;min-height:44px;color:var(--ff-ptext);font-weight:600;cursor:pointer}
.ff-pick{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-size:16px}.ff-pick input{width:22px;height:22px;accent-color:var(--ff-plum)}
.ff-act{display:flex;flex-direction:column;gap:4px;margin:0}.ff-off{font-size:14px;color:var(--ff-mute)}
.ff-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;padding:8px 16px;border-radius:16px;font:inherit;font-size:16px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
.ff-pri{min-height:56px;border:2px solid var(--ff-plum);background:var(--ff-plum);color:var(--ff-plum-ink)}
.ff-sec{border:2px solid var(--ff-plum);background:var(--ff-card);color:var(--ff-ptext)}.ff-danger{border-color:var(--ff-bad);color:var(--ff-bad)}
.ff-ghost{width:auto;border:2px solid transparent;background:transparent;color:var(--ff-ptext);text-decoration:underline;text-underline-offset:3px;padding:8px 4px}.ff-dl{border-style:dashed}.ff-ic{width:20px;height:20px;flex:none}
.ff-btn:disabled{border-color:var(--ff-line);background:var(--ff-neu-bg);color:var(--ff-mute);cursor:default}
.ff-btn:focus-visible,.ff a:focus-visible,.ff summary:focus-visible{outline:3px solid var(--ff-ink);outline-offset:2px}
.ff-bar{margin:20px 0 0;padding:16px 0 0;border-top:1px solid var(--ff-line);display:flex;flex-direction:column;gap:12px}
.ff-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ff-cap{font-size:14px;color:var(--ff-mute);text-align:center}
.ff-state{padding:20px;border:1px solid var(--ff-line);border-radius:20px;background:var(--ff-card);display:flex;flex-direction:column;gap:12px}
.ff-st,.ff .fstate-t{margin:0;font-family:${DISPLAY_FONT};font-weight:500;font-size:24px;line-height:1.2}
.ff .fstate{margin:0 0 12px;padding:20px;border:1px solid var(--ff-line);border-radius:20px;background:var(--ff-card)}.ff .fstate-why,.ff .fstate-next{font-size:16px}
.ff .fbar{display:block;height:6px;width:40%;margin:0 0 14px;border-radius:999px;background:var(--ff-line)}
.ff-state>.ff-chip{align-self:flex-start}.ff-ev{margin:0}.ff-ev figcaption{font-size:15px}
`;
