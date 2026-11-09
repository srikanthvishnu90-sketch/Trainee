// F-05 Roles shortlist, the flagship File (spec C.7; target pages p-54 to p-57), in the shared family anatomy (file_family.ts). It
// reads the SAME rows the live roles page reads (results_page.ts ResultRow) and takes every role's state and every count from
// results_spec.ts, so this File and the roles page can never disagree about a role; only the words are the library's (VOCAB).
// Forms post only actions trainee-file/handler.ts already has:
//   Prepare application  = action "apply" with tag "none" (the handler's gate prepares; nothing is sent, handler.ts gate())
//   Prepare selected     = action "applysel" with picks "<ref>:none" only (a tag-less pick is prepared, never sent)
//   Dismiss              = action "dismiss";   Pause this page = action "pause"
// A prepared role offers "Review application" (what will be sent, as an expand), never a send from this File.
// Targets (companies with no verified opening) never show Apply and never enter a count (C.7).
import { type Act, type Block, type Ctx, type FamilyFile, type Tone, familyPage, familyStatePage, claimHtml, chipHtml, actHtml } from "./file_family.ts";
import { esc, hostOf, webUrl } from "./file_page.ts";
import type { ResultRow, ResultsFeed } from "./results_page.ts";
import { batchIdOf } from "./results_batch.ts";
import { roleIds, specOf, stateCountsOf, STATES, type StateKey } from "./results_spec.ts";

export interface ShortRole extends ResultRow {
  checkedAt?: string | null; // when this posting was last read live (the posting's last_seen_at): the time on its sourced facts
  window?: string | null; // the student or graduation window: the posting's own words, or WO-C's ready line ('Student window: "..."' / 'Student window: not stated in the posting')
  openLine?: string | null; // WO-C's open-check line, shown as given ("Open: application page checked Nov 8, 5:16 PM CST" / "Not re-checked when listed")
  uncertain?: string | null; // what is not certain about this role, in words
  restriction?: string | null; // the kind of restriction that blocks it ("Location restriction"); the reason is `blocked`
  alsoAt?: { href: string; at: string | null }[]; // E-67: the same requisition cross-posted elsewhere, merged into this one role
}
export interface Target { company: string; note: string; watch?: Act | null }
export interface ShortlistInput {
  token: string; title: string; review?: string | null; updatedAt: string | null; sourcesChecked: string | null; rows: ShortRole[]; targets?: Target[]; back?: string | null;
  // live: drawn from the live roles feed (shortlistOfFeed), with today's page's controls: a prepared role's Submit and Select carry its
  // exact payload tag, so they approve exactly what its card shows. Without it (the spec's F-05), every form prepares and nothing sends.
  live?: boolean; paused?: boolean; notes?: Record<string, string>;
}

// The library's words for results_spec's states (p-54/p-56): chip label and tone, and the hero count's words. Same keys, same counts.
const VOCAB: Partial<Record<StateKey, { chip: string; tone: Tone; count: string }>> = {
  discovered: { chip: "Ready to prepare", tone: "confirmed", count: "ready to prepare" }, ready: { chip: "Ready for review", tone: "plum", count: "ready for review" },
  needs_info: { chip: "Needs answers", tone: "attention", count: "need answers" }, user_step: { chip: "Needs you", tone: "attention", count: "need you" },
  blocked: { chip: "Needs eligibility check", tone: "attention", count: "need eligibility check" }, closed: { chip: "Closed", tone: "neutral", count: "closed" },
};
export const vocab = (k: StateKey) => VOCAB[k] ?? { chip: STATES[k].label, tone: STATES[k].tone, count: STATES[k].label.toLowerCase() };
const hidden = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
const menu = (label: string, items: string[]) => items.length ? `<details class="ff-menu"><summary class="ff-sq" aria-label="${esc(label)}"><span aria-hidden="true">⋯</span></summary><div class="ff-menul">${items.join("")}</div></details>` : "";

// The time on a role's sourced facts: WO-C's live check (JobView.checked) when it read the page live, else checkedAt. Never a guess.
const checkedIso = (r: ShortRole): string | null => {
  const ck = (r.job as { checked?: { state?: string; at?: number } | null }).checked;
  return ck?.state === "live" && Number.isFinite(ck.at) ? new Date(ck.at as number).toISOString() : r.checkedAt ?? null;
};
const WINDOW_PREFIX = /^\s*student window:\s*/i;

function roleCard(r: ShortRole, rid: string, f: ShortlistInput, c: Ctx): string {
  const sp = specOf(r), v = vocab(sp.key), link = webUrl(r.job.url), host = link ? hostOf(link) : "", label = `${r.job.title} at ${r.job.company}`;
  const pay = r.payShown ? `${r.payShown} employer-stated` : "pay not listed (marked unknown)";
  const at = checkedIso(r);
  const meta = claimHtml([r.place || "location unknown", pay].join(" - "), { label: "checked", href: r.job.url, at }, c);
  const also = r.alsoAt?.length ? `<p class="ff-p ff-mute">Also posted: ${r.alsoAt.map((x) => claimHtml("same requisition", { label: "cross-post", href: x.href, at: x.at }, c)).join("; ")}</p>` : "";
  // WO-C hands the window already prefixed; strip the prefix so it is said once, and quote only raw posting words.
  const prefixed = WINDOW_PREFIX.test(r.window ?? ""), words = prefixed ? r.window!.replace(WINDOW_PREFIX, "") : r.window ? `"${r.window}"` : "";
  const win = words ? `<p class="ff-p ff-win"><strong>Student window:</strong> ${claimHtml(words, { label: "posting", href: r.job.url, at }, c)}</p>` : "";
  const open = r.openLine ? `<p class="ff-p ff-mute ff-open">${esc(r.openLine)}</p>` : "";
  const gap = r.job.gaps?.[0] ?? r.payNote ?? (r.openQs ? `${r.openQs} employer ${r.openQs === 1 ? "question needs" : "questions need"} your answer.` : null);
  const closed = specOf(r).key === "closed";
  const fit = closed ? `<div class="ff-fit ff-restr"><p class="ff-p"><strong>Closed:</strong> ${esc(r.blocked ?? "")}. Kept here as a record.</p></div>`
    : r.blocked
    ? `<div class="ff-fit ff-restr"><p class="ff-p"><strong>${esc(r.restriction ?? "Restriction")}:</strong> ${esc(r.blocked)} - this must resolve before any preparation.</p></div>`
    : r.why?.length || gap ? `<div class="ff-fit"><p class="ff-p">${r.why?.length ? `<strong>Why it fits:</strong> ${esc(r.why[0])} ` : ""}${gap ? `Gap: ${esc(gap)}` : ""}</p></div>` : "";
  const unc = r.uncertain ? `<p class="ff-p"><strong>Uncertain:</strong> ${esc(r.uncertain)}</p>` : "";
  const approvable = !r.status && !r.byHand && !r.blocked, paused = !!f.paused, tag = f.live ? r.tag ?? "none" : "none";
  // The row: one main action, Review fit (when there is more to read than the callout), and the "..." overflow (p-55).
  const more: string[] = [];
  // Select carries the exact payload tag its card shows (none: prepare only), as the live page's Select does (results_page.ts).
  if (approvable && !paused && (f.live || !r.tag)) more.push(`<label class="ff-pick"><input type="checkbox" form="ff-sel" name="pick" value="${esc(`${r.ref}:${tag}`)}" aria-label="Select ${esc(label)}"> Select</label>`);
  if (link && (!r.blocked || closed) && !r.byHand) more.push(actHtml({ label: `View posting on ${host}`, effect: "open", href: link, ghost: true, aria: `View posting: ${label} on ${host}` }));
  more.push(`<form method="post" class="ff-act">${hidden({ t: f.token, action: "dismiss", ref: r.ref })}<button type="submit" class="ff-btn ff-ghost" data-effect="decide" aria-label="Dismiss ${esc(label)}">Dismiss</button><span class="ff-off">Hides this role from your list. Private and reversible; no application is touched.</span></form>`);
  let main = "";
  // What will be sent: only a prepared application has one, and it is exactly what its Submit approves (its payload tag).
  const sends = approvable && r.tag && r.send?.length ? `<details class="ff-fitd"><summary class="ff-btn ff-sec">${f.live ? "What will be sent" : "Review application"}</summary><dl class="ff-kv">${r.send.map((x) => `<div class="ff-kvr"><dt>${esc(x.label)}</dt><dd>${x.needs ? `<span class="ff-v ff-unk" data-unconfirmed="1">Needs you</span>` : `${esc(x.value)}<span class="ff-src"> - as prepared for this role</span>`}</dd></div>`).join("")}${f.live ? `<div class="ff-kvr"><dt>Application</dt><dd class="ff-id">${esc(r.tag)}</dd></div></dl>` : `</dl><p class="ff-p ff-mute">Nothing is sent from this File.</p>`}</details>` : "";
  if (r.status) main = r.status.word === "preparing" ? actHtml({ label: "Refresh", effect: "navigate", href: `?#r-${r.ref}`, aria: `Refresh ${label}` }) : "";
  else if (approvable && paused) main = `<p class="ff-p ff-mute">Paused: this page is not starting new applications.</p>`;
  else if (approvable && !r.tag) main = actHtml({ label: "Prepare application", effect: "prepare", aria: `Prepare application: ${label}`, post: { token: f.token, action: "apply", fields: { ref: r.ref, tag: "none" } } }, true);
  else if (approvable && f.live) main = actHtml({ label: "Submit application", effect: "submit", aria: `Submit application: ${label}, exactly as What will be sent shows`, post: { token: f.token, action: "apply", fields: { ref: r.ref, tag } } });
  else if (closed) main = actHtml({ label: "Prepare application", effect: "prepare", off: "Closed - the posting no longer takes applications, so this stays off. The record is kept." });
  else if (r.blocked && link) main = actHtml({ label: `Review ${(r.restriction ?? "restriction").toLowerCase()}`, effect: "open", href: link, aria: `Review ${(r.restriction ?? "restriction").toLowerCase()} on ${host}` });
  else if (r.byHand && link) main = actHtml({ label: `Apply yourself on ${host}`, effect: "open", href: link });
  const all = [...(r.why ?? []).slice(1), ...(r.job.gaps ?? []).slice(1)];
  const review = all.length ? `<details class="ff-fitd"><summary class="ff-btn ff-sec">Review fit</summary><ul class="ff-p">${all.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : "";
  const note = f.notes?.[r.ref] ?? r.note;
  const said = note ? `<p class="ff-p" role="status">${esc(note)}</p>` : r.status ? `<p class="ff-p">${esc(r.status.word === "preparing" ? r.guide || "Getting your application ready. Nothing has been sent." : sp.detail)}</p>` : "";
  const guide = approvable && r.guide ? `<p class="ff-p">${esc(r.guide)}${r.openQs ? ` <a href="?things=${esc(r.ref)}">Answer them now</a>` : ""}</p>` : "";
  const full = `<details class="ff-full"><summary>Full posting</summary><p class="ff-p">${esc(r.full || "The full posting text isn't on file.")}</p></details>`;
  return `<article class="ff-card ff-role" id="r-${esc(r.ref)}"><p class="ff-idrow"><span class="ff-id">${esc(rid)}</span>${chipHtml({ label: v.chip, tone: v.tone })}</p><h3 class="ff-it ff-serif">${esc(r.job.title)}</h3><p class="ff-p ff-mute ff-meta2">${meta}</p>${also}${open}${win}${fit}${unc}${guide}${said}${full}<div class="ff-row-acts">${main}${sends}${review}${menu(`More for ${label}`, more)}</div></article>`;
}

// E-67: cross-posts of one requisition (same company, same stated requisition id) are one role with several source links; similar
// titles without the same requisition id stay separate roles. The first row is kept; the others' postings become its alsoAt.
export function dedupeCrossPosts(rows: ShortRole[]): ShortRole[] {
  const seen = new Map<string, ShortRole>(), out: ShortRole[] = [];
  for (const r of rows) {
    const k = r.reqId ? `${r.job.company.trim().toLowerCase()}|${r.reqId.trim().toLowerCase()}` : null, first = k ? seen.get(k) : undefined;
    if (first) { first.alsoAt = [...(first.alsoAt ?? []), { href: r.job.url, at: checkedIso(r) }]; continue; }
    const kept = { ...r, alsoAt: r.alsoAt ? [...r.alsoAt] : undefined };
    if (k) seen.set(k, kept);
    out.push(kept);
  }
  return out;
}
export function rolesShortlistFile(f0: ShortlistInput): FamilyFile {
  const f = { ...f0, rows: dedupeCrossPosts(f0.rows) };
  const ids = roleIds(f.rows.map((r) => r.ref)), batch = batchIdOf(f.rows.map((r) => r.ref));
  const counts = stateCountsOf(f.rows).filter((x) => x.n > 0).map((x) => ({ n: x.n, label: vocab(x.key).count }));
  const groups = new Map<string, ShortRole[]>();
  for (const r of f.rows) groups.set(r.job.company, [...(groups.get(r.job.company) ?? []), r]);
  const blocks: Block[] = [];
  for (const [co, rs] of groups) {
    const open = rs.filter((r) => specOf(r).key !== "closed").length;
    blocks.push({ b: "group", label: `${co} - ${open} open ${open === 1 ? "role" : "roles"}` }, { b: "fn", html: (c) => rs.map((r) => roleCard(r, r.rid ?? ids.get(r.ref) ?? "", f, c)).join("") });
  }
  if (f.targets?.length) blocks.push({ b: "group", label: "Targets - companies, no verified opening" },
    ...f.targets.map((t): Block => ({ b: "card", parts: [{ p: "tile", icon: "target", title: t.company, text: `${t.note} No open requisition verified - not counted as an opportunity. Never shows an Apply button.`, act: t.watch ?? undefined }] })));
  // The bar's words follow what a tick can do: with a prepared role pickable it approves (each exactly as its card shows), else it prepares.
  const pickable = f.paused ? [] : f.rows.filter((r) => !r.status && !r.byHand && !r.blocked && (f.live || !r.tag)), approves = !!f.live && pickable.some((r) => r.tag);
  return {
    family: "F-05", boundary: `Private workspace - batch ${batch}`, back: f.back ?? null, menu: [{ label: "Pause this page", effect: "decide", post: { token: f.token, action: "pause" } }],
    hero: { kicker: `Roles File - batch ${batch}${f.review ? ` - ${f.review}` : ""}`, title: f.title, meta: [{ label: "Updated", at: f.updatedAt }, { label: "Sources checked:", value: f.sourcesChecked }], counts },
    blocks,
    actions: !pickable.length ? { caption: f.paused ? "Paused on this page: nothing new starts from this File." : "Nothing is submitted from this File." }
      : approves ? { primary: { label: "Apply to selected roles", effect: "approve", post: { token: f.token, action: "applysel", id: "ff-sel" } }, caption: "Tick roles in their ⋯ menu first. Prepared ones are approved exactly as their What will be sent shows; the rest are prepared or say what they need." }
      : { primary: { label: "Prepare selected roles", effect: "prepare", post: { token: f.token, action: "applysel", id: "ff-sel" } }, caption: "Preparation creates materials for your review. Nothing is submitted." },
  };
}
// The page; with no roles, the empty state names the scope checked and adds nothing (C.24).
// The live roles page's feed (trainee-file/handler.ts renderResults) as F-05's input: the same rows, the same token, nothing
// added. A row's check time is the posting's own last_seen_at when the ingest read it; WO-C's live check wins (checkedIso).
export function shortlistOfFeed(f: ResultsFeed, o: { updatedAt?: string | null; sourcesChecked?: string | null; targets?: Target[]; back?: string | null } = {}): ShortlistInput {
  const rows: ShortRole[] = f.rows.map((r) => ({ ...r, checkedAt: (r as ShortRole).checkedAt ?? (r.job as { last_seen_at?: string | null }).last_seen_at ?? null }));
  return { live: true, paused: !!f.paused, notes: f.notes, token: f.token, title: f.title, updatedAt: o.updatedAt ?? null, sourcesChecked: o.sourcesChecked ?? null, rows, targets: o.targets, back: o.back ?? null };
}

export function rolesShortlistPage(f: ShortlistInput, c: Ctx): string {
  if (!f.rows.length) return familyStatePage({ state: "empty", family: "F-05", scope: f.sourcesChecked, next: f.targets?.[0]?.watch ?? null }, c);
  return familyPage(rolesShortlistFile(f), c);
}
