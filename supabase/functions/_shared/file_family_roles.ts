// F-05 Roles shortlist, the flagship File (spec C.7, C.24 F-05 states), in the shared family anatomy (file_family.ts). It reads the
// SAME rows the live roles page reads (results_page.ts ResultRow) and takes every state word, tone and count from results_spec.ts,
// so this File and the roles page can never disagree about a role. Forms post only actions trainee-file/handler.ts already has:
//   Prepare application  = action "apply" with tag "none" (the handler's gate prepares; nothing is sent, handler.ts gate())
//   Prepare selected     = action "applysel" with picks "<ref>:none" only (a tag-less pick is prepared, never sent)
//   Dismiss              = action "dismiss"
// A prepared role offers "Review application" (what will be sent, as an expand), never a send from this File.
// Targets (companies with no verified opening) never show Apply and never enter a count (C.7).
import { type Act, type Block, type Ctx, type FamilyFile, familyPage, familyStatePage, claimHtml, chipHtml, actHtml } from "./file_family.ts";
import { esc, hostOf, webUrl } from "./file_page.ts";
import type { ResultRow } from "./results_page.ts";
import { batchIdOf } from "./results_batch.ts";
import { roleIds, specOf, stateCountsOf } from "./results_spec.ts";

export interface ShortRole extends ResultRow {
  checkedAt?: string | null; // when this posting was last read live (the posting's last_seen_at): the time on its sourced facts
  window?: string | null; // the student or graduation window in the posting's own words (Example 2)
  uncertain?: string | null; // what is not certain about this role, in words
}
export interface Target { company: string; note: string; watch?: Act | null }
export interface ShortlistInput { token: string; title: string; review?: string | null; updatedAt: string | null; sourcesChecked: string | null; rows: ShortRole[]; targets?: Target[]; back?: string | null }

const posting = (r: ShortRole) => ({ label: "From the posting", href: r.job.url, at: r.checkedAt ?? null });
function roleHtml(r: ShortRole, rid: string, f: ShortlistInput, c: Ctx): string {
  const sp = specOf(r), link = webUrl(r.job.url), host = link ? hostOf(link) : "";
  const pay = r.payShown ? `${r.payShown} employer-stated` : "pay not listed (marked unknown)";
  const meta = claimHtml([r.place || "Location not listed", pay].join(" · "), posting(r), c);
  const win = r.window ? `<p class="ff-p"><strong>Student window:</strong> ${claimHtml(`"${r.window}"`, posting(r), c)}</p>` : "";
  const gap = r.job.gaps?.[0] ?? r.payNote ?? (r.openQs ? `${r.openQs} employer ${r.openQs === 1 ? "question needs" : "questions need"} your answer.` : null);
  const fit = r.blocked
    ? `<div class="ff-fit ff-n-danger"><p class="ff-p"><strong>Restriction:</strong> ${esc(r.blocked)}</p><p class="ff-p">This must resolve before any preparation.</p></div>`
    : r.why?.length || gap ? `<div class="ff-fit">${r.why?.length ? `<p class="ff-p"><strong>Why it fits:</strong> ${esc(r.why[0])}</p>` : ""}${gap ? `<p class="ff-p"><strong>Gap:</strong> ${esc(gap)}</p>` : ""}</div>` : "";
  const unc = r.uncertain ? `<p class="ff-p"><strong>Uncertain:</strong> ${esc(r.uncertain)}</p>` : "";
  const label = `${r.job.title} at ${r.job.company}`;
  const acts: string[] = [];
  const approvable = !r.status && !r.byHand && !r.blocked;
  if (approvable && !r.tag) {
    acts.push(`<label class="ff-pick"><input type="checkbox" form="ff-sel" name="pick" value="${esc(`${r.ref}:none`)}" aria-label="Select ${esc(label)}"> Select</label>`);
    acts.push(actHtml({ label: "Prepare application", effect: "prepare", aria: `Prepare application: ${label}`, post: { token: f.token, action: "apply", fields: { ref: r.ref, tag: "none" } } }));
  } else if (!approvable && !r.status && !r.byHand) acts.push(actHtml({ label: "Prepare application", effect: "prepare", off: "Not offered until the restriction above is resolved." }));
  if (r.byHand && link) acts.push(actHtml({ label: `Apply yourself on ${host}`, effect: "open", href: link }));
  const quiet: string[] = [];
  if (link && !r.byHand) quiet.push(actHtml({ label: `View posting on ${host}`, effect: "open", href: link, ghost: true, aria: `View posting: ${label} on ${host}` }));
  const send = approvable && r.tag && r.send?.length ? `<details><summary>Review application</summary><dl class="ff-kv">${r.send.map((x) => `<div class="ff-kvr"><dt>${esc(x.label)}</dt><dd>${x.needs ? `<span class="ff-v ff-unk" data-unconfirmed="1">Needs you</span>` : esc(x.value)}</dd></div>`).join("")}</dl><p class="ff-p ff-mute">Nothing is sent from this File.</p></details>` : "";
  const why = (r.why?.length ?? 0) + (r.job.gaps?.length ?? 0) > 2 ? `<details><summary>Review fit</summary><ul>${[...(r.why ?? []).map((w) => `<li>${esc(w)}</li>`), ...(r.job.gaps ?? []).map((g) => `<li>Gap: ${esc(g)}</li>`)].join("")}</ul></details>` : "";
  const said = r.status ? `<p class="ff-p">${esc(sp.detail)}</p>` : "";
  const dismiss = !sp.sent ? `<form method="post" class="ff-act">${[["t", f.token], ["action", "dismiss"], ["ref", r.ref]].map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}<button type="submit" class="ff-btn ff-ghost" data-effect="decide" aria-label="Dismiss ${esc(label)}">Dismiss</button></form>` : "";
  return `<article class="ff-role" id="r-${esc(r.ref)}"><p class="ff-idrow"><span class="ff-id">${esc(rid)}</span>${chipHtml({ label: sp.label, tone: sp.tone })}</p><h3 class="ff-it ff-serif">${esc(r.job.title)}</h3><p class="ff-p ff-mute">${meta}</p>${win}${fit}${unc}${said}${send}${why}<div class="ff-ra">${acts.join("")}<div class="ff-rl">${quiet.join("")}${dismiss}</div></div></article>`;
}

export function rolesShortlistFile(f: ShortlistInput): FamilyFile {
  const ids = roleIds(f.rows.map((r) => r.ref)), batch = batchIdOf(f.rows.map((r) => r.ref));
  const counts = stateCountsOf(f.rows).filter((x) => x.n > 0).map((x) => ({ n: x.n, label: x.label }));
  const groups = new Map<string, ShortRole[]>();
  for (const r of f.rows) groups.set(r.job.company, [...(groups.get(r.job.company) ?? []), r]);
  const blocks: Block[] = [];
  for (const [co, rs] of groups) {
    blocks.push({ b: "group", label: `${co} - ${rs.length} ${rs.length === 1 ? "role" : "roles"}` });
    blocks.push({ b: "fn", html: (c) => `<section class="ff-card">${rs.map((r) => roleHtml(r, r.rid ?? ids.get(r.ref) ?? "", f, c)).join("")}</section>` });
  }
  if (f.targets?.length) blocks.push({ b: "group", label: "Targets - companies, no verified opening" },
    { b: "card", parts: f.targets.map((t) => ({ p: "tile" as const, icon: "target" as const, title: t.company, text: `${t.note} No open requisition verified - not counted as an opportunity.`, act: t.watch ?? undefined })) });
  const preparable = f.rows.some((r) => !r.status && !r.byHand && !r.blocked && !r.tag);
  return {
    family: "F-05", mono: batch, back: f.back ?? null,
    hero: { kicker: `Roles File - batch ${batch}${f.review ? ` - ${f.review}` : ""}`, title: f.title, meta: [{ label: "Updated", at: f.updatedAt }, { label: "Sources checked:", value: f.sourcesChecked }], counts },
    blocks,
    actions: preparable ? { primary: { label: "Prepare selected roles", effect: "prepare", post: { token: f.token, action: "applysel", id: "ff-sel" } }, caption: "Preparation creates materials for your review. Nothing is submitted." } : { caption: "Nothing is submitted from this File." },
  };
}
// The page; with no roles, the empty state names the scope checked and adds nothing (C.24).
export function rolesShortlistPage(f: ShortlistInput, c: Ctx): string {
  if (!f.rows.length) return familyStatePage({ state: "empty", family: "F-05", scope: f.sourcesChecked, next: f.targets?.[0]?.watch ?? null }, c);
  return familyPage(rolesShortlistFile(f), c);
}
