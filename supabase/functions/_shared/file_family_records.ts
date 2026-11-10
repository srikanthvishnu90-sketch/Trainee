// Item 6 S4 (VERIFICATION-15 item 6; spec APP-LAYER-15-FIXES.md C.8, C.12, C.13, C.1, C.24): the Role workspace (F-06), the Batch
// File (F-10) and the Pipeline (F-11), drawn live from the records the roles page (F-05) reads: the results list's own roles, each
// with its posting, its prepared application and its application row (trainee-file/handler.ts loadFeed). Nothing here is stored as a
// view; every page is drawn from the records at the time of the request, and every number is counted from them.
//
// The rules held in code:
//   - A GET changes nothing. Every control that changes state is a POST form carrying the page token (the action names below are
//     the ones handleResults already answers: apply with the payload tag, applyall with the set hash, dismiss, restore, pause, resume,
//     refresh). The handler judges each post against the records as they are, and approves nothing that differs from what was shown.
//   - F-10: each role keeps its own state (results_spec.ts specOf); the batch counts are exclusive and sum to the total; the batch
//     yes is "applyall" bound to the hash of the exact ready set the page drew (the same set and hash as F-05's Apply to all).
//   - A decision that needs the person's own words opens the chat with the question filled in (file_family_serve.ts chatAsk), and
//     changes nothing.
//   - F-11 reads this list's applications only; it does not claim interview or offer counts it has not read.
import { type Act, type Block, type Ctx, FAMILIES, FAMILY_CSS, familyBodyHtml, type FamilyFile, type KV, type Part } from "./file_family.ts";
import { esc, layout } from "./file_page.ts";
import { batchFile, type BatchRow, pipelineFile } from "./file_family_apply.ts";
import { roleWorkspaceFile } from "./file_family_plan.ts";
import { askText, chatAsk } from "./file_family_serve.ts";
import type { ResultRow, ResultsFeed } from "./results_page.ts";
import { batchIdOf } from "./results_batch.ts";
import { type Spec, specOf, STATES } from "./results_spec.ts";

export type RecordsView = "batch" | "pipeline";
export const parseView = (v: string | null | undefined): RecordsView | null => v === "batch" || v === "pipeline" ? v : null;
// What the page needs beyond the feed: the chat link (TRAINEE_BOT_URL, https only) and each posting's own last check time.
export interface RecordsOpts { bot: string | null; checkedAt?: Map<string, string | null | undefined> }

const APPROVED = new Set(["approved", "queued", "in_progress", "uncertain", "submitted", "checking"]);
const isApproved = (s: Spec) => s.sent || APPROVED.has(s.key);
const name = (r: ResultRow) => `${r.job.title} at ${r.job.company}`;
const httpsOf = (u: string | null | undefined) => { try { const x = new URL(u ?? ""); return x.protocol === "https:" ? x.toString() : null; } catch { return null; } };
const ask = (o: RecordsOpts, file: string, item: string | null, label: string, aria?: string): Act => {
  const href = chatAsk(o.bot, askText(file, item, label));
  return href ? { label, effect: "open", href, aria: aria ?? `${label}: opens the chat with the question filled in` } : { label, effect: "decide", off: "Not available: the chat link isn't set up." };
};
const roleHref = (r: ResultRow) => `?role=${encodeURIComponent(r.ref)}`;
const post = (f: ResultsFeed, action: string, fields?: Record<string, string>) => ({ token: f.token, action, ...(fields ? { fields } : {}) });
const pauseAct = (f: ResultsFeed): Act => f.paused ? { label: "Resume", effect: "decide", post: post(f, "resume") } : { label: "Pause on this page", effect: "danger", post: post(f, "pause") };
const nav = (label: string, href: string): Act => ({ label, effect: "navigate", href });
const counted = (f: ResultsFeed) => f.countRows ?? f.rows;

// ---------------------------------------------------------------- F-10 Batch File
export function liveBatchFile(f: ResultsFeed, _o: RecordsOpts): FamilyFile {
  const rows = counted(f), batch = batchIdOf((f.coverRows ?? rows).map((r) => r.ref));
  const brows: BatchRow[] = rows.map((r) => {
    const s = specOf(r), note = f.notes?.[r.ref];
    const act: Act = s.key === "needs_info" && r.openQs ? nav("Answer them now", `?things=${encodeURIComponent(r.ref)}`) : nav(`Open ${r.rid ?? "role"}`, roleHref(r));
    return { rid: r.rid ?? r.ref, title: name(r), key: s.key, detail: note ? `${note} ${s.detail}` : s.detail, evidence: s.evidence ? { label: s.evidence } : null, act, approved: isApproved(s) };
  });
  const base = batchFile({ batch, review: f.all ? `Review ${f.all.hash.slice(0, 8)}` : "No review open", rows: brows, expiresAt: null,
    exclusions: f.dismissed?.length ? `${f.dismissed.length} dismissed by you` : "none", pause: pauseAct(f),
    check: { label: "Check status again", effect: "decide", post: post(f, "refresh") } });
  // The one batch yes: exactly the ready set the page drew, bound to its hash (handler applyall). Without one, each role is its own yes.
  const ready = rows.filter((r) => !r.status && !r.byHand && !r.blocked && !!r.tag);
  const primary: Act | null = f.all && !f.paused ? { label: `Approve these ${f.all.size} applications`, effect: "approve", post: { ...post(f, "applyall", { set: f.all.hash }), id: "ff-all" } } : null;
  const scope: Block[] = f.all && !f.paused
    ? [{ b: "note", tone: "info", label: "What this yes approves.", text: `Exactly these ${f.all.size}: ${ready.map((r) => r.rid ?? r.ref).join(", ")}, each as its What will be sent shows. Roles that aren't ready, and dismissed roles, are left out. If any of them changes first, nothing is approved.` }]
    : ready.length ? [{ b: "note", tone: "info", label: "Approving.", text: ready.length === 1 ? "One role is ready. Open it to approve it on its own." : "This page is paused, so nothing can be approved from it. Resume first." }] : [];
  const top: Block[] = f.top ? [{ b: "html", html: `<p class="ff-top" role="alert">${esc(f.top)}</p>` }] : [];
  return {
    ...base, back: "?", header: "Batch File",
    hero: base.hero && { ...base.hero, meta: [...base.hero.meta.filter((m) => m.label !== "Expires"), { label: "Updated", value: f.updated ?? null }] },
    blocks: [...top, ...scope, ...base.blocks],
    actions: { primary, secondary: [pauseAct(f), nav("Pipeline", "?view=pipeline")], caption: f.paused ? "Paused on this page. Anything already approved or in progress may still finish." : "Pause stops new approvals from this page; work already approved or in progress is not cancelled." },
  };
}

// ---------------------------------------------------------------- F-11 Pipeline
export function livePipelineFile(f: ResultsFeed, o: RecordsOpts): FamilyFile {
  const rows = counted(f), specs = rows.map((r) => ({ r, s: specOf(r) }));
  const chip = (s: Spec) => ({ label: s.label, tone: STATES[s.key].tone });
  const decisions = specs.filter(({ s }) => s.key === "needs_info" || s.key === "user_step" || s.key === "uncertain" || s.key === "ready").map(({ r, s }) => ({
    title: `${r.rid ? `${r.rid} ` : ""}${name(r)}`, chip: chip(s), text: s.detail,
    act: s.key === "needs_info" && r.openQs ? nav("Answer them now", `?things=${encodeURIComponent(r.ref)}`)
      : s.key === "user_step" && httpsOf(r.job.url) ? { label: "Open the employer page", effect: "open" as const, href: httpsOf(r.job.url)! }
      : s.key === "uncertain" ? ask(o, "Pipeline", `${r.rid ?? ""} ${name(r)}`.trim(), "Check whether it was submitted")
      : nav(`Review ${r.rid ?? "role"}`, roleHref(r)),
  }));
  const waiting = specs.filter(({ s }) => isApproved(s) && s.key !== "uncertain").map(({ r, s }) => ({ title: `${r.rid ? `${r.rid} ` : ""}${name(r)}`, chip: chip(s), text: s.evidence ? `${s.detail} Evidence: ${s.evidence}.` : s.detail }));
  const applications = specs.filter(({ s }) => isApproved(s)).length;
  const base = pipelineFile({ counts: { applications, interviews: 0, offers: 0 }, decisions, waiting, stages: [] });
  const empty: Block[] = !decisions.length && !waiting.length ? [{ b: "note", tone: "info", label: "Nothing in flight.", text: "No role on this list has been approved, and none needs a decision from you." }] : [];
  const top: Block[] = f.top ? [{ b: "html", html: `<p class="ff-top" role="alert">${esc(f.top)}</p>` }] : [];
  return {
    ...base, back: "?",
    // Only what this page read: the list's applications. Interviews and offers are not read here, so they are not counted.
    segments: [{ label: "Applications", n: applications, selected: true }],
    blocks: [...top, ...base.blocks, ...empty,
      { b: "note", tone: "info", label: "What this page reads.", text: `The ${rows.length} ${rows.length === 1 ? "role" : "roles"} on this list and their applications, as of ${f.updated ?? "now"}. Interviews and offers are not read here, so none are counted.`, act: ask(o, "Pipeline", null, "Ask about my interviews and offers") }],
    actions: { secondary: [nav("Batch File", "?view=batch"), nav("All roles", "?")] },
  };
}

// ---------------------------------------------------------------- F-06 Role workspace
export function liveRoleFile(f: ResultsFeed, r: ResultRow, o: RecordsOpts): FamilyFile {
  const s = specOf(r), dismissed = !!f.dismissed?.some((x) => x.ref === r.ref), posting = httpsOf(r.job.url);
  const fit = [
    ...(r.blocked ? [{ state: "missing" as const, text: r.blocked, src: { label: "From the posting screen" } }] : []),
    ...(r.why ?? []).map((t) => ({ state: "met" as const, text: t, src: { label: "From what you confirmed" } })),
    ...(r.openQs ? [{ state: "unknown" as const, text: `${r.openQs} employer ${r.openQs === 1 ? "question is" : "questions are"} not answered yet.` }] : []),
  ];
  const materials: KV[] = [{ k: "Resume", v: r.resume, missing: "No resume is attached to this application yet" },
    ...(!r.status && r.send?.length ? r.send.map((x) => ({ k: x.label, v: x.needs ? null : x.value, missing: "Needs you" })) : []),
    ...(r.tag ? [{ k: "Application", v: r.tag }] : [])];
  const route = r.byHand ? { supported: false, text: "this site needs you to apply on it yourself." } : { supported: true, text: r.submitLine ?? "Trainee fills the employer's form with what you approve here, and stops if anything changed." };
  // The one primary is named for the decision the record allows now; everything that changes state is a POST.
  const primary: Act | null = dismissed ? { label: "Restore to my list", effect: "decide", post: post(f, "restore", { ref: r.ref }) }
    : f.paused ? null
    : s.key === "ready" ? { label: "Approve and apply", effect: "approve", aria: `Approve and apply to ${name(r)}`, post: post(f, "apply", { ref: r.ref, tag: r.tag! }) }
    : s.key === "needs_info" && r.openQs ? nav("Answer them now", `?things=${encodeURIComponent(r.ref)}`)
    : s.key === "discovered" ? { label: "Get it ready", effect: "decide", aria: `Get ${name(r)} ready (nothing is sent)`, post: post(f, "apply", { ref: r.ref, tag: "none" }) }
    : s.key === "user_step" && posting ? { label: "Open the employer page", effect: "open", href: posting }
    : null;
  const canDismiss = !dismissed && !s.sent && s.bucket !== "progress" && s.bucket !== "done";
  const secondary: Act[] = [ask(o, "Role workspace", `${r.rid ?? ""} ${name(r)}`.trim(), "Ask about this role"),
    ...(canDismiss ? [{ label: "Dismiss", effect: "danger" as const, aria: `Dismiss ${name(r)}`, post: post(f, "dismiss", { ref: r.ref }) }] : posting ? [{ label: "Open the posting", effect: "open" as const, href: posting }] : [])];
  const base = roleWorkspaceFile({ rid: r.rid ?? r.ref, title: r.job.title, company: r.job.company, req: r.reqId ?? null, checkedAt: o.checkedAt?.get(r.job.job_id) ?? null, postingUrl: posting,
    fit: fit.length ? fit : [{ state: "unknown", text: "No fit reason from what you confirmed is on file for this role." }], materials, route,
    acts: { primary, secondary: secondary.slice(0, 2) } });
  const note = f.notes?.[r.ref] ?? f.top;
  const state: Block = { b: "card", label: "Where it stands", parts: [{ p: "item", id: r.rid, chip: { label: dismissed ? "Excluded" : s.label, tone: dismissed ? "neutral" : STATES[s.key].tone }, title: dismissed ? "Dismissed by you" : s.label, text: dismissed ? "Private and reversible. No application was touched." : s.evidence ? `${s.detail} Evidence: ${s.evidence}.` : s.detail } as Part,
    ...(posting ? [{ p: "item", title: "The posting", text: `${r.job.company}'s own page.`, src: { label: "Employer posting", href: posting, at: o.checkedAt?.get(r.job.job_id) ?? null } } as Part] : [])] };
  return { ...base, back: "?", blocks: [...(note ? [{ b: "html" as const, html: `<p class="ff-top" role="status">${esc(note)}</p>` }] : []), state, ...base.blocks, ...(f.paused ? [{ b: "note" as const, tone: "caution" as const, label: "Paused on this page.", text: "Nothing can be approved or started from this page until you resume.", act: { label: "Resume", effect: "decide" as const, post: post(f, "resume") } }] : [])] };
}

// ---------------------------------------------------------------- pages
const RECORDS_CSS = `.ff-top{margin:0 0 12px;padding:12px 14px;border-radius:12px;background:var(--ff-card);border:2px solid var(--ff-ptext);font-size:16px;line-height:1.5}`;
const page = (file: FamilyFile, c: Ctx) => layout(`${file.hero?.title ?? file.title ?? FAMILIES[file.family].header} - Trainee`, familyBodyHtml(file, c), { css: FAMILY_CSS + RECORDS_CSS });
export const liveBatchPage = (f: ResultsFeed, c: Ctx, o: RecordsOpts) => page(liveBatchFile(f, o), c);
export const livePipelinePage = (f: ResultsFeed, c: Ctx, o: RecordsOpts) => page(livePipelineFile(f, o), c);
export const liveRolePage = (f: ResultsFeed, r: ResultRow, c: Ctx, o: RecordsOpts) => page(liveRoleFile(f, r, o), c);
