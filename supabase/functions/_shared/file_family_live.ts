// R10 WO-E: the live roles page (trainee-file/handler.ts renderResults' feed) drawn as F-05, with every control today's page has.
// Nothing new is offered and nothing is dropped: the pay and place filter (GET), the state segments and exception links (GET), each
// role's Prepare / Submit / Select / Dismiss / Refresh / Answer them now, the hash-bound "Apply to all N ready" (applyall + set, the
// same form results_batch.ts draws), Apply to selected, Pause and Resume, and the Dismissed list with Restore. Every form posts an
// action the handler already has; the handler re-reads the page and approves nothing that differs from what was shown.
import { actHtml, chipHtml, type Block, type Ctx, FAMILY_CSS, familyBodyHtml, familyStatePage, type FamilyFile } from "./file_family.ts";
import { rolesShortlistFile, shortlistOfFeed, type Target, vocab } from "./file_family_roles.ts";
import { esc, layout } from "./file_page.ts";
import type { ResultRow, ResultsFeed } from "./results_page.ts";
import { batchIdOf, filterByState } from "./results_batch.ts";
import { coverage, specOf, stateCountsOf, stateOfDismissed, type StateKey } from "./results_spec.ts";

// The same GET link results_batch.ts draws for a state: the pay and place filters kept, the state set or cleared.
const stateHref = (f: ResultsFeed, state: StateKey | null) => {
  const q = new URLSearchParams();
  if (f.filters.pay !== "any") q.set("pay", f.filters.pay);
  if (f.filters.where) q.set("where", f.filters.where);
  if (state) q.set("state", state);
  const s = q.toString();
  return s ? `?${s}` : "?";
};
const EXC: [StateKey, (n: number) => string][] = [
  ["uncertain", (n) => `${n} submission uncertain`], ["user_step", (n) => `${n} user step needed`], ["needs_info", (n) => `${n} ${n === 1 ? "needs" : "need"} information`],
  ["blocked", (n) => `${n} blocked`], ["closed", (n) => `${n} closed before submission`],
];
const GOING: StateKey[] = ["queued", "in_progress", "approved"];
const OPEN = (r: ResultRow) => ["ready", "notprep", "needs"].includes(specOf(r).bucket);

function filtersHtml(f: ResultsFeed): string {
  const sel = (name: string, label: string, cur: string, opts: [string, string][]) => `<label class="ff-fl"><span>${esc(label)}</span><select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const pay: [string, string][] = [["any", "Any pay"], ...(f.floor ? [["meets", `Lists ${f.floor} or more`] as [string, string]] : []), ["listed", "Lists pay"]];
  const where: [string, string][] = [["", "Anywhere"], ["remote", "Remote"], ...f.places.map((p) => [p, p] as [string, string])];
  return `<form method="get" class="ff-filters" role="search">${f.filters.state ? `<input type="hidden" name="state" value="${esc(f.filters.state)}">` : ""}${sel("pay", "Pay", f.filters.pay, pay)}${sel("where", "Where", f.filters.where, where)}<button type="submit" class="ff-btn ff-sec" data-effect="navigate">Show</button></form>`;
}

export interface LiveOpts { updatedAt?: string | null; sourcesChecked?: string | null; targets?: Target[]; back?: string | null }

export function liveShortlistFile(feed: ResultsFeed, o: LiveOpts = {}): FamilyFile {
  const shown: ResultsFeed = { ...feed, rows: filterByState(feed.rows, feed.filters.state) }; // pay and place were applied by the caller
  const counted = feed.countRows ?? feed.rows, covered = feed.coverRows ?? counted;
  const base = rolesShortlistFile(shortlistOfFeed(shown, o));
  const batch = batchIdOf(covered.map((r) => r.ref)), paused = !!feed.paused;
  const head: Block[] = [];
  if (feed.top) head.push({ b: "html", html: `<p class="ff-top" role="alert">${esc(feed.top)}</p>` });
  // How the list was made: who and when, what was read, what is not confirmed, and what has been sent (coverage over every role).
  const made = [feed.madeFor, feed.stamp ?? "Check time unknown", feed.caveat, coverage(covered),
    feed.dismissed?.length ? `${feed.dismissed.length} dismissed by you, listed at the bottom (not counted above).` : null,
    feed.updated ? `Page updated ${feed.updated}. Counts come from each role's current state.` : null].filter((x): x is string => !!x);
  head.push({ b: "card", label: "About this list", parts: made.map((text) => ({ p: "text" as const, text, muted: true })) });
  if (feed.madeFor && feed.quick?.length) head.push({ b: "card", label: "Quick read", parts: feed.quick.map((text) => ({ p: "text" as const, text })) });
  const n = new Map(stateCountsOf(counted).map((x) => [x.key, x.n]));
  for (const [k, t] of EXC) if (n.get(k)) head.push({ b: "note", tone: k === "uncertain" || k === "blocked" ? "danger" : "caution", label: vocab(k).chip, text: t(n.get(k)!), act: { label: `Show ${vocab(k).chip.toLowerCase()}`, effect: "navigate", href: stateHref(feed, k) } });
  // Pause is honest: it pauses this page; Telegram buttons still work; queued, in-progress and approved work is named and keeps going.
  if (paused) head.push({ b: "note", tone: "caution", label: "Paused", text: "Paused on this page. This page is not starting new applications; Telegram buttons still work. Anything already approved or in progress may still finish.", act: { label: "Resume", effect: "decide", post: { token: feed.token, action: "resume" } } });
  else if (counted.some(OPEN)) head.push({ b: "note", tone: "info", label: "Pause", text: "Pause on this page stops this page from approving or starting anything new. It does not stop Telegram, and it does not cancel work already approved or in progress.", act: { label: "Pause on this page", effect: "danger", post: { token: feed.token, action: "pause" } } });
  const going = counted.filter((r) => (GOING as string[]).includes(specOf(r).key));
  if (going.length) head.push({ b: "card", label: paused ? "Still going (not cancelled by Pause)" : "Not stopped by Pause", parts: going.map((r) => ({ p: "item" as const, id: r.rid ?? undefined, chip: { label: specOf(r).label, tone: specOf(r).tone }, title: `${r.job.title} at ${r.job.company}` })) });
  // "Apply to all N ready": the one hash-bound approval (handler applyall). It approves sends, so it is a filled approve, never "prepare".
  if (feed.all && !paused) head.push({ b: "card", label: "Approve this batch", parts: [{ p: "html", html: `${actHtml({ label: `Apply to all ${feed.all.size} ready`, effect: "approve", post: { token: feed.token, action: "applyall", fields: { set: feed.all.hash }, id: "ff-all" } })}<p class="ff-p ff-mute">Approves ${feed.all.filtered ? `all ${feed.all.size} ready roles on the whole list, not only the roles your filters show` : `the ${feed.all.size} ready roles on this list`}, each exactly as its What will be sent shows. Dismissed roles and roles that aren't ready are left out. If anything changes first, nothing is approved. Review <span class="ff-id">${esc(feed.all.hash.slice(0, 8))}</span>.</p>` }] });
  // Item 6 S4: the same list as a Batch File (F-10) and a Pipeline (F-11), drawn from the same records.
  if (feed.total > 0) head.push({ b: "html", html: `<nav class="ff-p ff-views" aria-label="Other views of this list"><a href="?view=batch">Batch File</a> · <a href="?view=pipeline">Pipeline</a></nav>` });
  if (feed.total > 0) head.push({ b: "html", html: filtersHtml(feed) });
  if (shown.rows.length < feed.total) head.push({ b: "html", html: `<p class="ff-p">Showing ${shown.rows.length} of ${feed.total}. <a href="?">Show all ${feed.total}</a></p>` });
  if (!shown.rows.length && feed.total > 0) head.push({ b: "html", html: `<p class="ff-p" role="status">No roles match these filters.</p>` });
  const gone: Block[] = feed.dismissed?.length ? [{ b: "group", label: `Dismissed - ${feed.dismissed.length}` }, { b: "html", html: `<details class="ff-full ff-gone"><summary>Show dismissed (${feed.dismissed.length})</summary>${feed.dismissed.map((r) => `<article class="ff-card" id="r-${esc(r.ref)}"><p class="ff-idrow">${r.rid ? `<span class="ff-id">${esc(r.rid)}</span>` : ""}${chipHtml({ label: stateOfDismissed().label, tone: "neutral" })}</p><h3 class="ff-it ff-serif">${esc(r.job.title)}</h3><p class="ff-p ff-mute">${esc(r.job.company)}. Dismissed by you. Private and reversible. No application was touched. Current state: ${esc(specOf(r).label)}.</p>${actHtml({ label: "Restore", effect: "decide", aria: `Restore ${r.job.title} at ${r.job.company}`, post: { token: feed.token, action: "restore", fields: { ref: r.ref } } })}</article>`).join("")}</details>` }] : [];
  const segs = stateCountsOf(counted).filter((x) => x.n);
  return {
    ...base, boundary: `Private workspace - batch ${batch}`,
    menu: paused ? [{ label: "Resume", effect: "decide", post: { token: feed.token, action: "resume" } }] : base.menu,
    // The hero says what the feed says: when the page was drawn and when the shown postings were read (null: said, never guessed).
    hero: base.hero && { ...base.hero, kicker: `Roles File - batch ${batch}`, counts: segs.map((x) => ({ n: x.n, label: vocab(x.key).count })),
      meta: [{ label: "Updated", value: feed.updated ?? o.updatedAt ?? null }, { label: "Postings checked:", value: feed.stamp ? feed.stamp.replace(/^Postings checked\s*/i, "") : null }] },
    segments: segs.length >= 2 ? [{ label: "All", n: counted.length, href: stateHref(feed, null), selected: !feed.filters.state }, ...segs.map((x) => ({ label: vocab(x.key).chip, n: x.n, href: stateHref(feed, x.key), selected: feed.filters.state === x.key }))] : undefined,
    blocks: [...head, ...base.blocks, ...gone],
  };
}

export const LIVE_CSS = `
.ff-top{margin:0 0 12px;padding:12px 14px;border-radius:12px;background:var(--ff-card);border:2px solid var(--ff-ptext);font-size:16px;line-height:1.5}
.ff-filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin:0 0 14px}
.ff-fl{display:flex;flex-direction:column;gap:4px;font-size:14px;font-weight:600;color:var(--ff-mute);flex:1 1 140px;min-width:0}
.ff-fl select{min-height:44px;width:100%;padding:6px 10px;border-radius:10px;border:1px solid var(--ff-line);background:var(--ff-card);color:var(--ff-ink);font:inherit;font-size:16px;font-weight:400}
.ff-gone .ff-card{margin-top:10px}
.ff-views a{display:inline-flex;align-items:center;min-height:44px}
`;

// The page: no roles at all is the shared empty state (C.24); filtered to none keeps the filter and Show all.
export function liveShortlistPage(feed: ResultsFeed, c: Ctx, o: LiveOpts = {}): string {
  if (feed.total === 0 && !feed.dismissed?.length) return familyStatePage({ state: "empty", family: "F-05", scope: o.sourcesChecked ?? null, next: null }, c);
  return layout(`${feed.title} - Trainee`, familyBodyHtml(liveShortlistFile(feed, o), c), { css: FAMILY_CSS + LIVE_CSS });
}
