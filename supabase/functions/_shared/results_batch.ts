// F-10 Batch File (design spec 3.10, cap 16), the batch-level parts of the results page. Pure functions that draw HTML; no I/O.
// results_page.ts calls these from renderResults and adds nothing else, so this file can move without touching the cards.
//
//   - batch id: B-nn, stable for the list (derived from the list's own refs, never from sort, filter or dismissals)
//   - state filters: GET links, one per state that has roles, in the spec's own state words (a GET changes nothing)
//   - exception banners first: "N need information", "N blocked", "N closed before submission", ...
//   - "Approve these N applications": the SAME hash-bound form as "Apply to all N ready" (action applyall + the set hash).
//     There is no second path: this file only draws that form from `f.all`; the handler's applyall is the one place that approves.
//   - Pause: it pauses THIS PAGE. It does not cancel queued work, and the roles that keep going are named.
// No sentence here is canned prose beyond the spec's labels and the plain statements about what a control does and does not do.
import { esc } from "./file_page.ts";
import { MONO } from "./results_design.ts";
import { specOf, STATES, stateCountsOf, type StateKey, type Tone } from "./results_spec.ts";
import type { ResultRow, ResultsFeed } from "./results_page.ts";

const KEYS = Object.keys(STATES) as StateKey[];
export function parseStateFilter(v: string | null | undefined): StateKey | null {
  return v && (KEYS as string[]).includes(v) ? (v as StateKey) : null;
}
export const filterByState = <T extends Parameters<typeof specOf>[0]>(rows: readonly T[], key: StateKey | null | undefined): T[] =>
  key ? rows.filter((r) => specOf(r).key === key) : [...rows];

// B-nn: two digits from an FNV-1a hash of the list's refs sorted. The same list always has the same id; a re-sort, a filter or a
// dismissal (the refs passed are every role, dismissed included) never renames it. It is derived, not a counter: nothing is stored.
export function batchIdOf(refs: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const c of [...new Set(refs)].sort().join("|")) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `B-${String((h % 90) + 10)}`;
}

type F = Pick<ResultsFeed, "token" | "rows" | "filters" | "paused" | "all"> & { countRows?: ResultRow[]; coverRows?: ResultRow[] };
const cr = (f: F) => f.countRows ?? f.rows;
const href = (f: F, state: StateKey | null) => {
  const q = new URLSearchParams();
  if (f.filters.pay !== "any") q.set("pay", f.filters.pay);
  if (f.filters.where) q.set("where", f.filters.where);
  if (state) q.set("state", state);
  const s = q.toString();
  return s ? `?${s}` : "?";
};
const chip = (key: StateKey) => `<span class="chip t-${STATES[key].tone}">${esc(STATES[key].label)}</span>`;

// Header line: the batch id, and the review version (the hash of the exact set "Approve these N" covers) when there is one.
export function renderBatchHead(f: F): string {
  const refs = (f.coverRows ?? cr(f)).map((r) => r.ref);
  if (!refs.length) return "";
  const n = cr(f).length;
  return `<p class="batchline"><b class="bid">${esc(batchIdOf(refs))}</b> ${n} ${n === 1 ? "role" : "roles"}${f.all ? ` · review <span class="bid">${esc(f.all.hash.slice(0, 8))}</span> covers ${f.all.size} ready` : ""}</p>`;
}

// State filter segments: "All" and each state that has roles, with its count, in the spec's labels.
export function renderStateFilters(f: F): string {
  const counts = stateCountsOf(cr(f)).filter((c) => c.n);
  if (counts.length < 2) return "";
  const cur = f.filters.state ?? null;
  const item = (key: StateKey | null, label: string, n: number) => `<li><a href="${esc(href(f, key))}"${cur === key ? ' aria-current="true"' : ""} class="seg${cur === key ? " on" : ""}">${esc(label)} <b>${n}</b></a></li>`;
  return `<nav class="segs" aria-label="Filter by state"><ul>${item(null, "All", cr(f).length)}${counts.map((c) => item(c.key, c.label, c.n)).join("")}</ul></nav>`;
}

// Exception banners: first, each a link to the roles it counts. Blocked and closed roles are named here and are never in the ready count.
const EXC: { key: StateKey; text: (n: number) => string }[] = [
  { key: "uncertain", text: (n) => `${n} submission uncertain` },
  { key: "user_step", text: (n) => `${n} user step needed` },
  { key: "needs_info", text: (n) => `${n} ${n === 1 ? "needs" : "need"} information` },
  { key: "blocked", text: (n) => `${n} blocked` },
  { key: "closed", text: (n) => `${n} closed before submission` },
];
export function renderExceptions(f: F): string {
  const counts = new Map(stateCountsOf(cr(f)).map((c) => [c.key, c.n]));
  const items = EXC.filter((e) => counts.get(e.key)).map((e) => `<li class="t-${STATES[e.key].tone as Tone}"><a href="${esc(href(f, e.key))}">${esc(e.text(counts.get(e.key)!))}</a></li>`);
  return items.length ? `<section class="exc" aria-label="Exceptions"><ul>${items.join("")}</ul></section>` : "";
}

// The ONE approval: the same hash-bound form as "Apply to all N ready" (action applyall + the set it was drawn from). The handler
// re-reads the page, and approves only if the set is exactly this one; this function draws the form and nothing else approves.
export function approveBatchForm(f: Pick<F, "token" | "all" | "paused">, label: string, id: string): string {
  if (!f.all || f.paused) return "";
  const h = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  return `<form method="post" id="${esc(id)}">${h("t", f.token)}${h("action", "applyall")}${h("set", f.all.hash)}<button type="submit" class="apply">${esc(label)}</button></form>`;
}
export function renderApprove(f: F): string {
  const form = approveBatchForm(f, `Approve these ${f.all?.size ?? 0} applications`, "approve-batch");
  return form ? `<section class="batchact" aria-label="Approve this batch">${form}<p>Approves the ${f.all!.size} ready roles on this list, each exactly as its What will be sent shows. Dismissed roles and roles that aren't ready are left out. If anything changes first, nothing is approved.</p></section>` : "";
}

// Pause is honest: it pauses this page. Queued work is not cancelled, and the roles that are queued, in progress or approved are named.
const GOING: StateKey[] = ["queued", "in_progress", "approved"];
export function renderPauseNote(f: F): string {
  const going = cr(f).filter((r) => (GOING as string[]).includes(specOf(r).key));
  if (!going.length) return "";
  const li = going.map((r) => `<li><b class="bid">${esc(r.rid ?? "R-??")}</b> ${esc(r.job.title)} at ${esc(r.job.company)} ${chip(specOf(r).key)}</li>`).join("");
  return `<section class="pausenote" aria-label="Work Pause does not stop"><p>${f.paused ? "Paused on this page. Queued work is not cancelled. Still going:" : "Pause on this page does not cancel queued work. Not stopped by Pause:"}</p><ul>${li}</ul></section>`;
}

export const BATCH_CSS = `
.filehead .batchline{margin:10px 0 0;font-size:14px;line-height:1.5;color:#F1E8F5}.bid{font-family:${MONO};font-weight:700;letter-spacing:.02em}
.filehead .bid{color:#fff}
.segs{margin:0 0 10px}.segs ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.segs a.seg{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:6px 12px;border-radius:11px;border:1px solid var(--hair);background:var(--card);color:var(--ink);font-size:14px;text-decoration:none}
.segs a.seg.on{background:var(--plum-100);color:var(--plum-text);border:2px solid var(--plum-text);font-weight:600}
.segs a.seg:focus-visible{outline:3px solid var(--plum-600);outline-offset:2px}
.exc{margin:0 0 10px}.exc ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.exc li{border-radius:11px;border:1px solid currentColor;font-weight:600}
.exc li.t-risk{background:var(--st-risk-bg);color:var(--st-risk)}.exc li.t-attention{background:var(--st-attention-bg);color:var(--st-attention)}.exc li.t-neutral{background:var(--st-neutral-bg);color:var(--st-neutral)}
.exc li a{display:flex;align-items:center;min-height:44px;padding:6px 12px;color:inherit;font-size:16px;text-decoration:underline}
.batchact{margin:0 0 10px;padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--hair)}
.batchact form{margin:0}.batchact .apply{width:100%}.batchact p{margin:8px 0 0;font-size:14px;color:var(--ink-2)}
.pausenote{margin:0 0 10px;padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--hair)}
.pausenote p{margin:0 0 6px;font-size:14px;color:var(--ink-2)}.pausenote ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.pausenote li{font-size:16px}
.bid{color:var(--plum-text)}
`;
