// The results page for "I want X roles that pay $Y" (owner, 2026-11-01): the same shell, tokens and type as every Trainee page
// (file_page.ts, brand.ts), drawn as one clean card per role (reqs Q541, Q547, Q606, Q718): role and company first, then the key
// facts (pay with where it came from, or "Pay not listed"; place; posted age), the one-line fit reason (from confirmed facts
// only), the source link, the full posting behind an expand, and one plum Apply. Sorted by fit; roles that list no pay are a
// separate group. Filters for pay and place are a plain GET form (no script needed; a GET changes nothing).
//
// One solid black Apply per card (owner, 2026-11-02). On a card whose application is prepared, "What will be sent" (the resume,
// each answer, the cover note, where it goes) is an expand on the card itself, and the tap on Apply approves exactly that (the
// hash-bound approval in trainee-file/handler.ts). A card that isn't ready says why: the employer's questions are asked on
// "A few things first" (renderThings), or the application is still being prepared. Nothing here sends on a GET.
import { cap1, esc, hostOf, layout, webUrl, initialOf, type Row } from "./file_page.ts";
import { BRAND } from "./brand.ts";
import { stampHtml } from "./file_design.ts";
import { applyHelp, coverage, NOT_LISTED, specOf, stateCountsOf, stateOfDismissed, type Spec, type StateKey } from "./results_spec.ts";
import { DESIGN_CSS, DESIGN_FONT_LINK } from "./results_design.ts";
import { BATCH_CSS, filterByState, renderApprove, renderBatchHead, renderExceptions, renderPauseNote, renderStateFilters } from "./results_batch.ts";

export type PayFilter = "any" | "meets" | "listed";
export interface ResultRow extends Row {
  payShown: string | null; // "$30-40/hr" as the posting lists it; null: not listed
  payGroup: "meets" | "unlisted" | "unchecked" | "below"; // below: the posting's pay changed since the list was made
  payNote: string | null; // "the range starts below $30/hr", "in CAD, not compared with your $30/hr"
  payConv: string | null; // "≈ $43-58/hr, assuming 2,080 hrs/yr": a converted figure, never labelled as the posting's
  place: string; // "Austin, TX · Hybrid"
  guide?: string | null; // why Apply can't send yet: "2 questions need your answer first", or where the preparation stands
  openQs?: number; // the employer's questions still open for this role (their page is ?things=<ref>)
  rid?: string; // R-07: stable short id (results_spec.roleIds), the same after any re-sort or filter
  reqId?: string | null; // the requisition id the posting itself states, else null (shown "Not listed")
  checked?: string | null; // "Checked Nov 1, 2026, 9:08 AM CT" from this posting's own last_seen_at, else null
}
export interface ResultsFeed {
  token: string; title: string; floor: string | null; rows: ResultRow[]; total: number;
  filters: { pay: PayFilter; where: string; state?: StateKey | null }; places: string[]; top?: string; notes?: Record<string, string>;
  // The header: who and when, what was read and when, what is not confirmed, and a 2-3 line quick read.
  // stamp: "Postings checked ..." from the shown postings' own last_seen_at (file_design.ts); null: "Check time unknown".
  coverRows?: ResultRow[]; // every role including dismissed: what has been sent is told over these
  countRows?: ResultRow[]; // every active (not dismissed) role, before the pay/place filter: the top counts are over these
  paused?: boolean; updated?: string; dismissed?: ResultRow[]; // the person's own marks (private); updated: when this page was drawn
  madeFor?: string; stamp?: string | null; caveat?: string; quick?: string[];
  // "Apply to all N ready": the roles that are ready now (and not dismissed) and the hash of that exact set; absent: fewer than two, or paused.
  all?: { hash: string; size: number; filtered?: boolean } | null;
}

const BRAND_PLUM = "#5C2751";
const CSS = `
:root{--card:#FFFFFF}@media (prefers-color-scheme:dark){:root{--card:var(--panel)}}
.eyebrow{margin:0 0 6px;font-size:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
.made{margin:0 0 10px;font-size:15px;color:var(--mute)}
.results h1{font-size:32px;line-height:1.15;margin:0}
.stamp{margin:12px 0 0;font-size:15px;color:var(--mute)}
.caveat{margin:14px 0 0;font-size:16px;line-height:1.55}
.quick{margin:22px 0 4px;padding:16px 18px;border-radius:14px;background:var(--card);border:1px solid var(--line)}
.quick h2{margin:0 0 6px;font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
.quick p{margin:4px 0 0;font-size:16px;line-height:1.5}
.lede{margin:8px 0 0;font-size:16px;color:var(--mute)}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:18px 0 6px;padding:14px;border-radius:14px;background:var(--panel)}
.filters label{display:flex;flex-direction:column;gap:4px;font-size:15px;font-weight:600;flex:1 1 140px;min-width:0}
.filters select{min-height:44px;width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
.ghost{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:6px 18px;border-radius:999px;border:1px solid var(--ink);background:transparent;color:var(--ink);font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.selbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0 4px}.selbar p{margin:0;font-size:15px;color:var(--mute)}
h2.group{margin:28px 0 4px;font-size:20px;font-weight:600}.groupnote{margin:0 0 10px;font-size:16px;color:var(--mute)}
ul.cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}
.card .head{display:flex;gap:14px;align-items:flex-start}
.card .logo{position:relative;flex:none;width:44px;height:44px;border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.ttl{flex:1;min-width:0}.ttl .title{margin:0;font-size:20px;line-height:1.3;font-weight:600;overflow-wrap:anywhere;unicode-bidi:plaintext}
.ttl .co{margin:2px 0 0;font-size:17px;overflow-wrap:anywhere;unicode-bidi:plaintext}
dl.facts{margin:14px 0 0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:16px}
dl.facts dt{color:var(--mute)}dl.facts dd{margin:0;overflow-wrap:anywhere}dd.paid{font-weight:600}
.src{font-size:14px;color:var(--mute);font-weight:400}
.fit{margin:12px 0 0;font-size:16px}.fit b{font-weight:600}
.card details{margin:10px 0 0}.card summary{min-height:44px;display:flex;align-items:center;color:var(--link);font-size:16px;font-weight:500;cursor:pointer}
.card .full{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;margin:8px 0}
.card .open a{display:inline-flex;align-items:center;min-height:44px;color:var(--link);font-size:16px}
.acts{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-top:14px}
.pick{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-size:16px;cursor:pointer}.pick input{width:22px;height:22px;accent-color:var(--accent)}
.card form.go{margin:0}.card .ghost.go{min-width:120px;min-height:48px;text-decoration:none}
.card .chip{min-height:44px}.card .note{margin:10px 0 0;font-size:16px;color:var(--ink)}
.top{margin:18px 0 4px;padding:16px 18px;border-radius:14px;background:var(--card);border:2px solid ${BRAND_PLUM}}
.top h2{margin:0 0 8px;font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${BRAND_PLUM}}
.counts{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}.counts li{padding:6px 12px;border-radius:999px;border:1px solid var(--line);font-size:16px}.counts b{font-weight:700}
.top .cover{margin:12px 0 0;font-size:16px;line-height:1.5}.top .upd{margin:8px 0 0;font-size:14px;color:var(--mute)}
.top .pausebar{margin:12px 0 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}.top .pausebar p{margin:0;font-size:15px;color:var(--mute);flex:1 1 220px}
.state{margin:8px 0 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:15px}.rid{font-weight:700;color:${BRAND_PLUM};letter-spacing:.02em}
.applyhelp{margin:8px 0 0;font-size:15px;color:var(--mute)}.card form.mark{margin:0}.ghost.small{min-height:44px;padding:6px 14px;font-size:15px;font-weight:500}
.markhelp{margin:6px 0 0;font-size:14px;color:var(--mute)}details.gone{margin:24px 0 0}details.gone summary{min-height:44px;display:flex;align-items:center;font-size:17px;font-weight:600;cursor:pointer}
.empty{margin:18px 0;padding:18px;border-radius:14px;background:var(--panel)}
.results .apply,.things .apply{display:inline-flex;align-items:center;justify-content:center;min-width:120px;min-height:48px;padding:6px 26px;border-radius:999px;border:2px solid #000;background:#000;color:#fff;font:inherit;font-size:17px;font-weight:600;cursor:pointer;text-decoration:none}
.results .apply:hover,.things .apply:hover{background:#000;border-color:#000;opacity:.88}.results .apply:focus-visible,.things .apply:focus-visible,.ghost:focus-visible{outline:3px solid var(--link);outline-offset:2px}
@media (prefers-color-scheme:dark){.results .apply,.things .apply{border-color:var(--ink)}.results .apply:hover,.things .apply:hover{border-color:var(--ink)}}
.card details.send dl.facts{grid-template-columns:minmax(0,38%) 1fr;margin:6px 0 4px}.card .guide{margin:10px 0 0;font-size:16px;color:var(--ink)}
.things fieldset{margin:0 0 16px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}.things legend{padding:0 6px;font-weight:600;font-size:17px;overflow-wrap:anywhere}
.things .opt{display:flex;align-items:center;gap:10px;min-height:44px;font-size:17px}.things .opt input{width:22px;height:22px;accent-color:var(--ink)}
.things input[type=text],.things select,.things textarea{box-sizing:border-box;width:100%;min-height:48px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
.things .err{margin:8px 0 0;color:var(--bad);font-size:16px}.things .hand{margin:0;font-size:16px}
.back{display:inline-flex;align-items:center;min-height:44px;color:var(--link);font-size:16px}
@media (max-width:480px){.card .apply,.card .ghost.go,.selbar .apply,.things .apply{width:100%}.acts{flex-direction:column;align-items:stretch}}
` + DESIGN_CSS + BATCH_CSS;
const hidden = (token: string, action: string, extra = "") => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}">${extra}`;
const logoOf = (r: Row) => `<span class="logo"><span class="lettermark" aria-hidden="true">${esc(initialOf(r.job.company))}</span>${r.logo ? `<img src="${esc(r.logo)}" alt="${esc(r.job.company)} logo" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
// The chip is the colour AND the spec word (design 1.6, "Submitted - confirmed" only with evidence); the class keeps the row's status word.
const chipOf = (sp: Spec, cls: string) => `<span class="chip ${cls} t-${sp.tone}" role="status">${esc(sp.label)}</span>`;
const specChip = (r: ResultRow) => chipOf(specOf(r), r.status ? r.status.word.replace(/ /g, "-") : "ready");
const approvable = (r: Row) => !r.status && !r.byHand && !r.blocked;

function payFact(r: ResultRow): string {
  if (!r.payShown) return `<dt>Pay</dt><dd class="key">Pay not listed</dd>`;
  // The posting's own figure is "listed on the posting"; a conversion is its own line and says how it was made (Q672, Q684).
  return `<dt>Pay</dt><dd class="paid key">${esc(r.payShown)} <span class="src">· listed on the posting${r.payNote ? `; ${esc(r.payNote)}` : ""}</span>${r.payConv ? `<br><span class="src conv">${esc(r.payConv)}</span>` : ""}</dd>`;
}
const markForm = (r: ResultRow, f: ResultsFeed, kind: "dismiss" | "restore") => kind === "dismiss"
  ? `<form method="post" class="mark">${hidden(f.token, "dismiss", `<input type="hidden" name="ref" value="${esc(r.ref)}">`)}<button type="submit" class="ghost small" aria-label="Dismiss ${esc(r.job.title)} at ${esc(r.job.company)}">Dismiss</button><p class="markhelp">Hides this role from your list. Private to you, and you can bring it back. It does not touch any application.</p></form>`
  : `<form method="post" class="mark">${hidden(f.token, "restore", `<input type="hidden" name="ref" value="${esc(r.ref)}">`)}<button type="submit" class="ghost small" aria-label="Restore ${esc(r.job.title)} at ${esc(r.job.company)}">Restore</button></form>`;
function card(r: ResultRow, f: ResultsFeed): string {
  const j = r.job, link = webUrl(j.url), host = link ? hostOf(link) : "";
  const facts = `<dl class="facts">${payFact(r)}<dt>Where</dt><dd class="key">${esc(r.place || NOT_LISTED)}</dd>${r.posted ? `<dt>Posted</dt><dd>${esc(r.posted.replace(/^Posted /, ""))}</dd>` : ""}<dt>Source</dt><dd>${esc(j.source || NOT_LISTED)}</dd><dt>Requisition ID</dt><dd>${esc(r.reqId || NOT_LISTED)}</dd><dt>Checked</dt><dd>${esc((r.checked ?? "Check time unknown").replace(/^Checked /, ""))}</dd></dl>`;
  // The fit callout: one concrete reason from confirmed facts and a visible gap where the data has one. Nothing is invented.
  const gapText = r.payNote ? `Pay: ${r.payNote}.` : !r.payShown ? "Pay not listed, so it wasn't checked against what you asked." : r.openQs ? (r.guide || `${r.openQs} employer ${r.openQs === 1 ? "question needs" : "questions need"} your answer.`) : "";
  const fitLines = [r.why?.length ? `<p><b>Why it fits:</b> ${esc(r.why.slice(0, 1).join(" "))}</p>` : "", gapText ? `<p class="gap"><b>Gap:</b> ${esc(gapText)}</p>` : ""].join("");
  const fit = fitLines ? `<div class="fit">${fitLines}</div>` : "";
  const more = `<details><summary>Full posting</summary>${r.full ? `<p class="full">${esc(r.full)}</p>` : `<p class="full">The full posting text isn't on file.</p>`}</details>`;
  const open = host ? `<p class="open"><a href="${esc(link)}" rel="noopener noreferrer" aria-label="View role: ${esc(j.title)} on ${esc(host)}">View role on ${esc(host)}</a></p>` : "";
  const label = `${esc(j.title)} at ${esc(j.company)}`;
  // What will be sent: only a prepared application has one, and it is what the Apply on this card approves.
  const sendRows = !r.status && r.send?.length ? r.send : null;
  const sends = sendRows ? `<details class="send"><summary>What will be sent</summary><dl class="facts">${sendRows.map((x) => `<dt>${esc(x.label)}</dt><dd>${x.needs ? "<strong>Needs you</strong>" : esc(x.value)}</dd>`).join("")}${r.tag ? `<dt>Application</dt><dd>${esc(r.tag)}</dd>` : ""}</dl></details>` : "";
  let acts = "", help = "";
  if (r.status) acts = (r.status.word === "preparing" ? `<a class="ghost go" href="?#r-${esc(r.ref)}">Refresh</a>` : "");
  else if (r.byHand) acts = link ? `<a class="ghost go" href="${esc(link)}" rel="noopener noreferrer">Apply there</a>` : "";
  else if (!r.blocked && f.paused) acts = `<p class="note">Paused: this page is not starting new applications.</p>`;
  else if (!r.blocked) {
    const tag = r.tag ?? "none";
    acts = `<label class="pick"><input type="checkbox" form="sel" name="pick" value="${esc(`${r.ref}:${tag}`)}" aria-label="Select ${label}"> Select</label>`
      + `<form method="post" class="go">${hidden(f.token, "apply", `<input type="hidden" name="ref" value="${esc(r.ref)}"><input type="hidden" name="tag" value="${esc(tag)}">`)}<button type="submit" class="apply" aria-label="Apply to ${label}">Apply</button></form>`;
    help = `<p class="applyhelp">${esc(applyHelp(r))}</p>`;
  }
  const guide = !r.status && !r.byHand && !r.blocked && r.guide ? `<p class="guide">${esc(r.guide)}${r.openQs ? ` <a href="?things=${esc(r.ref)}">Answer them now</a>` : ""}</p>` : "";
  const note = f.notes?.[r.ref] ?? r.note;
  const said = note ? `<p class="note" role="status">${esc(note)}</p>` : r.status ? `<p class="note">${esc(r.status.word === "preparing" ? r.guide || "Getting your application ready. Nothing has been sent." : r.status.detail)}</p>` : r.byHand ? `<p class="note">Not applied for automatically on this site.</p>` : r.blocked ? `<p class="note">Not offered: ${esc(r.blocked)}</p>` : "";
  return `<li class="card" id="r-${esc(r.ref)}"><p class="state">${r.rid ? `<span class="rid">${esc(r.rid)}</span>` : "<span></span>"}${specChip(r)}</p><div class="head">${logoOf(r)}<div class="ttl"><h3 class="title">${esc(j.title)}</h3><p class="co">${esc(j.company)}</p></div></div>${facts}${fit}${more}${sends}${guide}${acts ? `<div class="acts">${acts}</div>` : ""}${help}${said}<div class="more">${open}${markForm(r, f, "dismiss")}</div></li>`;
}

export function renderResults(f: ResultsFeed): string {
  f = { ...f, rows: filterByState(f.rows, f.filters.state) }; // the state filter (results_batch.ts); pay and place were applied by the caller
  const floor = f.floor;
  const sel = (name: string, cur: string, opts: [string, string][]) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const payOpts: [string, string][] = [["any", "Any pay"], ...(floor ? [["meets", `Lists ${floor} or more`] as [string, string]] : []), ["listed", "Lists pay"]];
  const filters = `<form method="get" class="filters" role="search">${f.filters.state ? `<input type="hidden" name="state" value="${esc(f.filters.state)}">` : ""}<label>Pay${sel("pay", f.filters.pay, payOpts)}</label><label>Where${sel("where", f.filters.where, [["", "Anywhere"], ["remote", "Remote"], ...f.places.map((p) => [p, p] as [string, string])])}</label><button type="submit" class="ghost">Show</button></form>`;
  const canPick = !f.paused && f.rows.some(approvable);
  const cr0 = f.countRows ?? f.rows;
  // Sticky bottom bar (spec 3.10): the page's main action (Apply to selected, solid black) and Pause on this page (danger).
  const pausable = !f.paused && cr0.some((r) => ["ready", "notprep", "needs"].includes(specOf(r).bucket));
  const selForm = canPick ? `<form method="post" id="sel">${hidden(f.token, "applysel")}<button type="submit" class="apply">Apply to selected</button></form>` : "";
  const pauseForm = pausable ? `<form method="post">${hidden(f.token, "pause")}<button type="submit" class="ghost danger">Pause on this page</button></form>` : "";
  const actionbar = selForm || pauseForm ? `<div class="actionbar" role="region" aria-label="Page actions"><div class="abin">${selForm}${pauseForm}</div></div>` : "";
  const selhelp = canPick ? `<p class="selhelp">Tick the roles you want, then use Apply to selected at the bottom. Ones that are ready go in one tap; the rest say what they need.</p>` : "";
  const allbar = f.all && !f.paused ? `<div class="selbar allbar"><form method="post" id="all">${hidden(f.token, "applyall", `<input type="hidden" name="set" value="${esc(f.all.hash)}">`)}<button type="submit" class="apply">Apply to all ${f.all.size} ready</button></form><p>Approves ${f.all.filtered ? `all ${f.all.size} ready roles on the whole list, not only the roles your filters show` : `the ${f.all.size} ready roles on this list`}, each exactly as its What will be sent shows. Dismissed roles and roles that aren't ready are left out. If anything changes first, nothing is approved.</p></div>` : "";
  const meets = f.rows.filter((r) => r.payGroup === "meets"), unchecked = f.rows.filter((r) => r.payGroup === "unchecked"), unlisted = f.rows.filter((r) => r.payGroup === "unlisted"), below = f.rows.filter((r) => r.payGroup === "below");
  const group = (title: string, note: string, rows: ResultRow[]) => rows.length ? `<h2 class="group">${esc(title)} (${rows.length})</h2>${note ? `<p class="groupnote">${esc(note)}</p>` : ""}<ul class="cards">${rows.map((r) => card(r, f)).join("")}</ul>` : "";
  const body = f.rows.length
    ? group(floor ? `Lists ${floor} or more` : "Lists pay", "", meets)
      + group("Pay in another currency", floor ? `Shown as each posting lists it; not compared with ${floor}.` : "", unchecked.filter((r) => /^in /.test(r.payNote ?? "")))
      + group("Pay without a period", floor ? `The posting doesn't say per hour or per year, so it wasn't compared with ${floor}.` : "", unchecked.filter((r) => !/^in /.test(r.payNote ?? "")))
      + group("Pay not listed", floor ? `These don't list pay, so they weren't checked against ${floor}.` : "These don't list pay.", unlisted) + group(`Lists less than ${floor ?? "you asked"}`, "Their posted pay changed since this list was made.", below)
    : `<div class="empty" role="status"><p>No roles match these filters.</p><p><a class="back" href="?">Show all ${f.total}</a></p></div>`;
  const shown = f.rows.length < f.total ? `<p class="lede">Showing ${f.rows.length} of ${f.total}. <a class="back" href="?">Show all</a></p>` : "";
  const top = f.top ? `<p class="top-note" role="alert">${esc(f.top)}</p>` : "";
  const kicker = `<p class="kicker">Roles file</p>`;
  const headTop = f.madeFor
    ? `${kicker}<p class="made">${esc(f.madeFor)}</p><h1>${esc(cap1(f.title))}</h1>${stampHtml(f.stamp ?? null)}${f.caveat ? `<p class="caveat">${esc(f.caveat)}</p>` : ""}`
    : `${kicker}<h1>${esc(cap1(f.title))}</h1>${stampHtml(f.stamp ?? null)}<p class="lede">Sorted by fit to what you've confirmed. Pay is only what each posting lists. Nothing is sent until you tap Apply.</p>`;
  const quick = f.madeFor && f.quick?.length ? `<section class="quick" aria-label="Quick read"><h2>Quick read</h2>${f.quick.map((q) => `<p>${esc(q)}</p>`).join("")}</section>` : "";
  const cr = f.countRows ?? f.rows, counts = stateCountsOf(cr);
  const open = cr.some((r) => ["ready", "notprep", "needs"].includes(specOf(r).bucket));
  // Counts: one primary state per role, so the strip sums to the role total. Blocked, excluded and closed roles are listed in their own
  // words and are never in the ready count. (Dismissed roles are Excluded and shown at the bottom, not counted here.)
  const topBlock = `<section class="top" aria-label="Where things stand"><h2>Where things stand</h2><ul class="counts">${counts.filter((c) => c.n).map((c) => `<li class="t-${c.tone}"><b>${c.n}</b> ${esc(c.label)}</li>`).join("") || "<li>No active roles</li>"}</ul>`
    + (cr.length ? `<p class="upd">${cr.length} ${cr.length === 1 ? "role" : "roles"} in total; each is in exactly one state.</p>` : "")
    + (f.dismissed?.length ? `<p class="upd">${f.dismissed.length} dismissed by you, listed at the bottom as Excluded (not counted above).</p>` : "")
    + `<p class="cover">${esc(coverage(f.coverRows ?? cr))}</p>${f.updated ? `<p class="upd">Page updated ${esc(f.updated)}. Counts come from each role's current state.</p>` : ""}`
    + (f.paused
      ? `<div class="pausebar"><p><b>Paused on this page.</b> This page is not starting new applications; Telegram buttons still work. Anything already approved or in progress is not changed by this and may still finish.</p><form method="post">${hidden(f.token, "resume")}<button type="submit" class="ghost">Resume</button></form></div>`
      : open ? `<div class="pausebar"><p><b>Pause on this page</b> (button at the bottom) stops this page from approving or starting anything new. It does not stop Telegram: the buttons there still work. Applications already approved or in progress are not cancelled and may still finish.</p></div>` : "")
    + `</section>`;
  const gone = f.dismissed?.length ? `<details class="gone"><summary>Dismissed (${f.dismissed.length})</summary><ul class="cards">${f.dismissed.map((r) => `<li class="card" id="r-${esc(r.ref)}"><p class="state">${r.rid ? `<span class="rid">${esc(r.rid)}</span>` : "<span></span>"}${chipOf(stateOfDismissed(), "dismissed")}</p><div class="head">${logoOf(r)}<div class="ttl"><h3 class="title">${esc(r.job.title)}</h3><p class="co">${esc(r.job.company)}</p></div></div><p class="markhelp">Dismissed by you. Private and reversible. No application was touched. Current state: ${esc(specOf(r).label)}.</p>${markForm(r, f, "restore")}</li>`).join("")}</ul></details>` : "";
  const inner = `<div id="root" class="results">${BRAND}<header class="filehead">${headTop}${renderBatchHead(f)}${topBlock}</header>${quick}${filters}${shown}${renderStateFilters(f)}${renderExceptions(f)}${renderApprove(f)}${renderPauseNote(f)}${selhelp}${actionbar}<main id="main">${top}${body}${gone}</main></div>`;
  return layout(`${cap1(f.title)} - Trainee`, inner, { css: CSS, head: DESIGN_FONT_LINK });
}

// ---------------------------------------------------------------- "A few things first": the employer's open questions for one role
// One labelled input per question: the employer's own options as radios (a select when there are many), yes/no as two choices,
// else text. Nothing is pre-filled or defaulted. A question that needs a secret has no input at all.
export interface ThingQuestion { id: string; label: string; options: string[]; kind: "choice" | "yesno" | "text" | "long" | "secret"; value?: string; error?: string }
export function renderThings(o: { token: string; ref: string; title: string; company: string; link: string | null; questions: ThingQuestion[]; note?: string; stamp?: string | null }): string {
  const field = (q: ThingQuestion) => {
    const id = `q_${q.id}`, err = q.error ? `<p class="err" id="e_${esc(q.id)}" role="alert">${esc(cap1(q.error))}</p>` : "";
    const radios = (opts: string[]) => opts.map((x, i) => `<label class="opt" for="${esc(id)}_${i}"><input type="radio" id="${esc(id)}_${i}" name="${esc(id)}" value="${esc(x)}"${q.value === x ? " checked" : ""}> ${esc(x)}</label>`).join("");
    let ctl: string;
    if (q.kind === "secret") ctl = `<p class="hand">Trainee never collects this. Type it yourself on the employer's site${o.link ? `: <a href="${esc(o.link)}" rel="noopener noreferrer">${esc(hostOf(o.link))}</a>` : ""}.</p>`;
    else if (q.kind === "yesno") ctl = radios(["Yes", "No"]);
    else if (q.kind === "choice") ctl = q.options.length > 6 ? `<select id="${esc(id)}" name="${esc(id)}"><option value="">Choose one</option>${q.options.map((x) => `<option value="${esc(x)}"${q.value === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>` : radios(q.options);
    else if (q.kind === "long") ctl = `<textarea id="${esc(id)}" name="${esc(id)}" rows="5" maxlength="2000">${esc(q.value ?? "")}</textarea>`;
    else ctl = `<input type="text" id="${esc(id)}" name="${esc(id)}" maxlength="2000" value="${esc(q.value ?? "")}">`;
    return `<fieldset${q.error ? ` aria-describedby="e_${esc(q.id)}"` : ""}><legend>${esc(q.label)}</legend>${ctl}${err}</fieldset>`;
  };
  const askable = o.questions.some((q) => q.kind !== "secret");
  const inner = `<div id="root" class="things">${BRAND}<header class="filehead"><p class="kicker">A few things first</p><h1>${esc(o.title)} at ${esc(o.company)}</h1>${stampHtml(o.stamp ?? null)}<p class="lede">The employer asks these. Your answers are saved as typed, nothing is guessed, and nothing is sent from this page.</p></header>`
    + `<main id="main">${o.note ? `<p class="top-note" role="status">${esc(o.note)}</p>` : ""}<form method="post">${hidden(o.token, "answer", `<input type="hidden" name="ref" value="${esc(o.ref)}">`)}${o.questions.map(field).join("")}${askable ? `<button type="submit" class="apply">Save answers</button>` : ""}</form><p><a class="back" href="?#r-${esc(o.ref)}">Back to the list</a></p></main></div>`;
  return layout("A few things first - Trainee", inner, { css: CSS, head: DESIGN_FONT_LINK });
}
