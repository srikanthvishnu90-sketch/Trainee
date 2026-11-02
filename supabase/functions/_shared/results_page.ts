// The results page for "I want X roles that pay $Y" (owner, 2026-11-01): the same shell, tokens and type as every Trainee page
// (file_page.ts, brand.ts), drawn as one clean card per role (reqs Q541, Q547, Q606, Q718): role and company first, then the key
// facts (pay with where it came from, or "Pay not listed"; place; posted age), the one-line fit reason (from confirmed facts
// only), the source link, the full posting behind an expand, and one plum Apply. Sorted by fit; roles that list no pay are a
// separate group. Filters for pay and place are a plain GET form (no script needed; a GET changes nothing).
//
// Apply never sends from the list. It opens the review: the exact application (every field and answer, the resume, where it
// goes), and Approve there needs the 6-digit code Trainee sends to the person's own chat (approval_code.ts). "Apply to selected"
// is the same review for the ticked roles, approved once, as one set.
import { cap1, esc, hostOf, layout, webUrl, initialOf, type Row, type Status } from "./file_page.ts";
import { BRAND } from "./brand.ts";
import { stampHtml } from "./results_stamp.ts";

export type PayFilter = "any" | "meets" | "listed";
export interface ResultRow extends Row {
  payShown: string | null; // "$30-40/hr" as the posting lists it; null: not listed
  payGroup: "meets" | "unlisted" | "unchecked" | "below"; // below: the posting's pay changed since the list was made
  payNote: string | null; // "the range starts below $30/hr", "in CAD, not compared with your $30/hr"
  payConv: string | null; // "≈ $43-58/hr, assuming 2,080 hrs/yr": a converted figure, never labelled as the posting's
  place: string; // "Austin, TX · Hybrid"
}
export interface ResultsFeed {
  token: string; title: string; floor: string | null; rows: ResultRow[]; total: number;
  filters: { pay: PayFilter; where: string }; places: string[]; top?: string; notes?: Record<string, string>;
  // The header: who and when, what was read and when, what is not confirmed, and a 2-3 line quick read.
  // stamp: "Postings checked ..." from the shown postings' own last_seen_at (results_stamp.ts); null: "Check time unknown".
  madeFor?: string; stamp?: string | null; caveat?: string; quick?: string[];
}

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
.empty{margin:18px 0;padding:18px;border-radius:14px;background:var(--panel)}
.review .card dl.facts{grid-template-columns:minmax(0,40%) 1fr}
.codebox{margin:20px 0 0;padding:16px;border-radius:14px;background:var(--panel)}.codebox form+form{margin-top:18px}
.codebox label{display:block;font-weight:600;margin:0 0 6px}
.codebox input{width:100%;max-width:240px;min-height:48px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;font-size:20px;letter-spacing:.2em}
.codebox .apply{margin-top:12px}.hint{font-size:15px;color:var(--mute)}
.back{display:inline-flex;align-items:center;min-height:44px;color:var(--link);font-size:16px}
@media (max-width:480px){.card .apply,.card .ghost.go,.codebox .apply,.selbar .apply{width:100%}.acts{flex-direction:column;align-items:stretch}}
`;
const hidden = (token: string, action: string, extra = "") => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}">${extra}`;
const logoOf = (r: Row) => `<span class="logo"><span class="lettermark" aria-hidden="true">${esc(initialOf(r.job.company))}</span>${r.logo ? `<img src="${esc(r.logo)}" alt="${esc(r.job.company)} logo" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
const chip = (s: Status) => `<span class="chip ${s.word.replace(/ /g, "-")}" role="status">${esc(cap1(s.word))}</span>`;
const approvable = (r: Row) => !r.status && !r.byHand && !r.blocked;

function payFact(r: ResultRow): string {
  if (!r.payShown) return `<dt>Pay</dt><dd>Pay not listed</dd>`;
  // The posting's own figure is "listed on the posting"; a conversion is its own line and says how it was made (Q672, Q684).
  return `<dt>Pay</dt><dd class="paid">${esc(r.payShown)} <span class="src">· listed on the posting${r.payNote ? `; ${esc(r.payNote)}` : ""}</span>${r.payConv ? `<br><span class="src conv">${esc(r.payConv)}</span>` : ""}</dd>`;
}
function card(r: ResultRow, f: ResultsFeed): string {
  const j = r.job, link = webUrl(j.url), host = link ? hostOf(link) : "";
  const facts = `<dl class="facts">${payFact(r)}${r.place ? `<dt>Where</dt><dd>${esc(r.place)}</dd>` : ""}${r.posted ? `<dt>Posted</dt><dd>${esc(r.posted.replace(/^Posted /, ""))}</dd>` : ""}${j.source ? `<dt>Source</dt><dd>${esc(j.source)}</dd>` : ""}</dl>`;
  const fit = r.why?.length ? `<p class="fit"><b>Why it fits:</b> ${esc(r.why.slice(0, 2).join(" "))}</p>` : "";
  const more = `<details><summary>Full posting</summary>${r.full ? `<p class="full">${esc(r.full)}</p>` : `<p class="full">The full posting text isn't on file.</p>`}</details>`;
  const open = host ? `<p class="open"><a href="${esc(link)}" rel="noopener noreferrer">Open on ${esc(host)}</a></p>` : "";
  const label = `${esc(j.title)} at ${esc(j.company)}`;
  let acts = "";
  if (r.status) acts = chip(r.status);
  else if (r.byHand) acts = link ? `<a class="ghost go" href="${esc(link)}" rel="noopener noreferrer">Apply there</a>` : ""; // secondary: one plum action per page
  else if (!r.blocked) {
    const tag = r.tag ?? "none";
    acts = `<label class="pick"><input type="checkbox" form="sel" name="pick" value="${esc(`${r.ref}:${tag}`)}" aria-label="Select ${label}"> Select</label>`
      + `<form method="post" class="go">${hidden(f.token, "review", `<input type="hidden" name="ref" value="${esc(r.ref)}"><input type="hidden" name="tag" value="${esc(tag)}">`)}<button type="submit" class="ghost go" aria-label="Apply to ${label}">Apply</button></form>`;
  }
  const note = f.notes?.[r.ref] ?? r.note;
  const said = note ? `<p class="note" role="status">${esc(note)}</p>` : r.status ? `<p class="note">${esc(r.status.detail)}</p>` : r.byHand ? `<p class="note">Not applied for automatically on this site.</p>` : r.blocked ? `<p class="note">Not offered: ${esc(r.blocked)}</p>` : "";
  return `<li class="card" id="r-${esc(r.ref)}"><div class="head">${logoOf(r)}<div class="ttl"><h3 class="title">${esc(j.title)}</h3><p class="co">${esc(j.company)}</p></div></div>${facts}${fit}${open}${more}${acts ? `<div class="acts">${acts}</div>` : ""}${said}</li>`;
}

export function renderResults(f: ResultsFeed): string {
  const floor = f.floor;
  const sel = (name: string, cur: string, opts: [string, string][]) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const payOpts: [string, string][] = [["any", "Any pay"], ...(floor ? [["meets", `Lists ${floor} or more`] as [string, string]] : []), ["listed", "Lists pay"]];
  const filters = `<form method="get" class="filters" role="search"><label>Pay${sel("pay", f.filters.pay, payOpts)}</label><label>Where${sel("where", f.filters.where, [["", "Anywhere"], ["remote", "Remote"], ...f.places.map((p) => [p, p] as [string, string])])}</label><button type="submit" class="ghost">Show</button></form>`;
  const canPick = f.rows.some(approvable);
  const selbar = canPick ? `<div class="selbar"><form method="post" id="sel">${hidden(f.token, "review_sel")}<button type="submit" class="apply">Apply to selected</button></form><p>Tick the roles you want, then review them together.</p></div>` : "";
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
  const head = f.madeFor
    ? `<p class="made">${esc(f.madeFor)}</p><h1>${esc(cap1(f.title))}</h1>${stampHtml(f.stamp ?? null)}${f.caveat ? `<p class="caveat">${esc(f.caveat)}</p>` : ""}`
      + (f.quick?.length ? `<section class="quick" aria-label="Quick read"><h2>Quick read</h2>${f.quick.map((q) => `<p>${esc(q)}</p>`).join("")}</section>` : "")
    : `<p class="eyebrow">Your results</p><h1>${esc(cap1(f.title))}</h1>${stampHtml(f.stamp ?? null)}<p class="lede">Sorted by fit to what you've confirmed. Pay is only what each posting lists. Nothing is sent until you approve it.</p>`;
  const inner = `<div id="root" class="results"><header>${BRAND}${head}${filters}${shown}${selbar}</header><main id="main">${top}${body}</main></div>`;
  return layout(`${cap1(f.title)} - Trainee`, inner, { css: CSS });
}

// ---------------------------------------------------------------- the review: the exact application(s), then Approve with the code
export interface ReviewItem { ref: string; tag: string; title: string; company: string; send: { label: string; value: string; needs?: boolean }[] }
export function renderReview(o: { token: string; items: ReviewItem[]; set: string | null; note?: string; codeSent?: boolean; canApprove: boolean; stamp?: string | null }): string {
  const many = o.items.length > 1;
  const carry = many ? o.items.map((i) => `<input type="hidden" name="pick" value="${esc(`${i.ref}:${i.tag}`)}">`).join("") + `<input type="hidden" name="set" value="${esc(o.set ?? "")}">`
    : `<input type="hidden" name="ref" value="${esc(o.items[0].ref)}"><input type="hidden" name="tag" value="${esc(o.items[0].tag)}">`;
  const cards = o.items.map((i) => `<li class="card"><div class="ttl"><h3 class="title">${esc(i.title)}</h3><p class="co">${esc(i.company)}</p></div><dl class="facts">${i.send.map((s) => `<dt>${esc(s.label)}</dt><dd>${s.needs ? "<strong>Needs you</strong>" : esc(s.value)}</dd>`).join("")}<dt>Application</dt><dd>${esc(i.tag)}</dd></dl></li>`).join("");
  const note = o.note ? `<p class="top-note" role="status">${esc(o.note)}</p>` : "";
  const code = o.canApprove ? `<div class="codebox"><form method="post">${hidden(o.token, "code_send", carry)}<p>${o.codeSent ? "We sent a 6-digit code to your Trainee chat." : "To approve, we send a 6-digit code to your Trainee chat (where you text Trainee)."}</p><button type="submit" class="ghost">${o.codeSent ? "Send a new code" : "Text me a code"}</button></form>`
    + `<form method="post">${hidden(o.token, many ? "approve_sel" : "approve", carry)}<label for="code">Code from your chat</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 -]{6,9}" maxlength="9" required><br><button type="submit" class="apply">${many ? `Approve and send all ${o.items.length}` : "Approve and send"}</button><p class="hint">Trainee never asks for a password, and never asks for this code in chat.</p></form></div>`
    : `<p class="top-note">Approving here isn't switched on yet, so nothing can be sent from this page. Nothing was sent.</p>`;
  const inner = `<div id="root" class="review"><header>${BRAND}<p class="eyebrow">Check before it goes</p><h1>${many ? `Check ${o.items.length} applications` : "Check your application"}</h1>${stampHtml(o.stamp ?? null)}<p class="lede">This is exactly what will be sent${many ? " for each" : ""}. If anything changes before you approve, nothing is sent and you'll see it again.</p></header><main id="main">${note}<ul class="cards">${cards}</ul>${code}<p><a class="back" href="?">Back to the list</a></p></main></div>`;
  return layout(many ? "Check your applications - Trainee" : "Check your application - Trainee", inner, { css: CSS });
}
