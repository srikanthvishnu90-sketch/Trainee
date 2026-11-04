// Trainee's File design system (owner brief P3 and P6): the shared parts every hosted File is drawn from, so a jobs list, an
// application proof, a comparison or a results page all read as the same calm, personal, honest page. Pure functions: data in,
// escaped HTML out. Tests: tests/architect/file-design.test.ts (strings) and file-design-browser.test.ts (Chromium, 390 px).
//
// The anatomy (brief P3.1-P3.7, P6.1-P6.9):
//   - the wordmark and "Made for <first name> · <date>" ABOVE one card on the warm ground; a serif display title in the card;
//   - a freshness stamp under every title, computed from the data's own timestamps in the person's zone, never invented: no real
//     timestamp, no time (the stamp then says the check time is unknown, as a value);
//   - quiet section labels; numbered rows (bold name, gray detail, right-aligned value); the value is in the verified plum shade,
//     labelled "Verified", ONLY when verified;
//     unknowns are first-class values ("Unverified", "Pay not listed", "Closed"), never an empty cell;
//   - a caveat sits inside the section it qualifies, directly above the rows (the section takes it as an argument, so it cannot
//     drift into a footer);
//   - evidence rides with the claim (a confirmation snippet, its source and time, the receipt link or screenshot);
//   - the job card: logo or lettermark, role, company, the deciding facts (pay, location, posted), one fit line, one primary action
//     at the bottom; readable at 390 px, every tap target at least 44 px;
//   - empty, loading and error states each say what happened, why, what happens next, and (for an error) offer a retry.
//
// Colour roles (brand.ts; owner ruling 2026-11-01: keep the current colours, no new hue): plum only for the one primary action and
// links; the plum-derived TINT only as a caveat panel's ground; the darker plum shade only for a verified value, which always carries
// the word "Verified" so the colour is never the only signal; everything else ink and mute on the card.
import { BRAND, DISPLAY_FONT } from "./brand.ts";

// The same escaping as file_page.ts (bidi overrides and isolates and half surrogate pairs dropped, then HTML-escaped). Kept here, not
// imported, so file_page.ts can draw its shell from this module without an import cycle; file-design.test.ts proves the two agree.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const esc = (s: unknown) => String(s ?? "").replace(BIDI_CONTROLS, "").replace(LONE_SURROGATE, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const initialOf = (company: string) => { const c = [...String(company ?? "").replace(BIDI_CONTROLS, "").replace(LONE_SURROGATE, "").trim()][0]; return c ? [...c.toLocaleUpperCase("en")][0] : "?"; };
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const FALLBACK_ZONE = "America/Chicago";

// ---------------------------------------------------------------- values: verified, stated, or a first-class unknown
// A fact on a File always carries its source (audit R17): the same labels the File kinds use (file_kinds.ts SOURCES), Trainee's own
// records, or Trainee's own arithmetic over rows shown on the same page. A verified or stated value without one of these is never
// drawn as a fact: it is drawn as the unknown "Unverified", so an unsourced number cannot reach a page.
export const FILE_SOURCES = ["From the posting", "From your resume", "From you", "Reported, not verified", "From Trainee's records", "Added up from the rows above"] as const;
export type FileSource = typeof FILE_SOURCES[number];
export type Value = { kind: "verified"; text: string; source: FileSource } | { kind: "stated"; text: string; source: FileSource } | { kind: "unknown"; text: string };
// The unknowns a File writes as values (brief P3.5, P6.5). A caller may pass its own words; these are the shared ones.
export const UNKNOWN = {
  unverified: "Unverified", payNotListed: "Pay not listed", locationNotListed: "Location not listed", postedNotGiven: "Posted date not given",
  closed: "Closed", amountUnknown: "Amount unknown", notConfirmed: "Not confirmed yet", checkUnknown: "Check time unknown",
} as const;
const blank = (s: unknown) => s === null || s === undefined || !String(s).replace(BIDI_CONTROLS, "").replace(LONE_SURROGATE, "").trim();
const sourced = (s: unknown): s is FileSource => (FILE_SOURCES as readonly unknown[]).includes(s);
export const verified = (text: string, source: FileSource): Value => ({ kind: "verified", text, source });
export const stated = (text: string, source: FileSource): Value => ({ kind: "stated", text, source });
export const unknown = (text: string = UNKNOWN.unverified): Value => ({ kind: "unknown", text });
// A value from data: blank is the named unknown (never an empty cell); otherwise verified only when the caller has proof.
export function valueOf(text: string | null | undefined, o: { verified: boolean; missing: string; source: FileSource }): Value {
  if (blank(text)) return unknown(o.missing);
  return o.verified ? verified(String(text).trim(), o.source) : stated(String(text).trim(), o.source);
}
// The source chip, under the value it qualifies.
const chip = (s: FileSource) => `<span class="fsrc">${esc(s)}</span>`;
export function valueHtml(v: Value): string {
  // Unsourced or blank: never drawn as a fact (R17).
  if (v.kind !== "unknown" && (blank(v.text) || !sourced(v.source))) return valueHtml(unknown(UNKNOWN.unverified));
  const text = blank(v.text) ? UNKNOWN.unverified : v.text;
  return `<span class="v v-${v.kind}" data-v="${v.kind}">${esc(text)}${v.kind === "verified" ? ` <span class="vtag">Verified</span>` : ""}${v.kind === "unknown" ? "" : chip(v.source)}</span>`;
}

// A total only from complete data (audit D08: no grand totals from partial data). Every value must be a sourced money amount in the
// same form ("$1,250", "$32/hr" all with the same suffix); one unknown or unparseable value and there is no total, said with how many
// are missing.
export function totalOf(values: readonly Value[]): { value: Value; caveat: string | null } {
  const parsed = values.map((v) => {
    if (v.kind === "unknown" || !sourced(v.source)) return null;
    const m = /^\$\s?([\d,]+(?:\.\d{1,2})?)\s*(\/\s*\w+)?$/.exec(v.text.trim());
    return m ? { n: Number(m[1].replace(/,/g, "")), unit: (m[2] ?? "").replace(/\s/g, "") } : null;
  });
  const missing = parsed.filter((p) => !p).length;
  const units = new Set(parsed.filter(Boolean).map((p) => p!.unit));
  if (!values.length || missing || units.size > 1) {
    const why = !values.length ? "There is nothing to add up." : missing ? `${missing} of ${values.length} ${missing === 1 ? "amount isn't" : "amounts aren't"} known, so there is no total.` : "These amounts aren't in the same unit, so there is no total.";
    return { value: unknown("No total"), caveat: why };
  }
  const sum = parsed.reduce((a, p) => a + p!.n, 0), unit = [...units][0];
  const txt = `$${sum.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(sum) ? 0 : 2, maximumFractionDigits: 2 })}${unit}`;
  return { value: stated(txt, "Added up from the rows above"), caveat: null };
}

// ---------------------------------------------------------------- freshness stamp (brief P3.3, P6.4)
const zoneValid = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const partsOf = (t: number, tz: string, name: "shortGeneric" | "short") => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: name }).formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { date: `${g("month")} ${g("day")}, ${g("year")}`, time: `${g("hour")}:${g("minute")}`, ampm: g("dayPeriod").toUpperCase(), zone: g("timeZoneName") };
};
// "CT", "ET", "PT" where the zone has a short generic name; else its offset name ("GMT+9"), never a long country name.
const zoneName = (t: number, tz: string) => { const g = partsOf(t, tz, "shortGeneric").zone; return /^[A-Z]{2,5}$/.test(g) ? g : partsOf(t, tz, "short").zone; };
const toMs = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) && x > 0 ? x : null;
  if (typeof x !== "string" || !x.trim()) return null;
  const t = Date.parse(x); return Number.isNaN(t) ? null : t;
};
// "Postings checked Nov 1, 2026, 3:08–3:25 PM CT": the earliest and latest of the data's own timestamps, in the person's zone (else
// Chicago's, and the stamp says so). A timestamp that cannot be read, or one ahead of our clock, is not a check that happened and is
// left out; with none left there is no stamp (null), never an invented time.
export function freshnessStamp(label: string, times: readonly unknown[], o: { now: number; tz?: string | null }): string | null {
  const ts = times.map(toMs).filter((t): t is number => t !== null && t <= o.now + 60_000).sort((a, b) => a - b);
  if (!ts.length) return null;
  const known = zoneValid(o.tz), tz = known ? o.tz as string : FALLBACK_ZONE, note = known ? "" : " (Chicago time; your time zone isn't on file)";
  const lo = ts[0], hi = ts[ts.length - 1], a = partsOf(lo, tz, "short"), b = partsOf(hi, tz, "short");
  const za = zoneName(lo, tz), zb = zoneName(hi, tz);
  let when: string;
  if (a.date === b.date && a.time === b.time && a.ampm === b.ampm && (a.zone === b.zone)) when = `${a.date}, ${a.time} ${a.ampm} ${za}`;
  else if (a.zone !== b.zone) {
    // Across a clock change (Nov 1, 2026, 1:30 AM CDT then 1:30 AM CST) the generic "CT" would read as no time passing: each end
    // carries its own zone.
    when = a.date === b.date ? `${a.date}, ${a.time} ${a.ampm} ${a.zone}–${b.time} ${b.ampm} ${b.zone}` : `${a.date}, ${a.time} ${a.ampm} ${a.zone} – ${b.date}, ${b.time} ${b.ampm} ${b.zone}`;
  } else if (a.date === b.date) when = a.ampm === b.ampm ? `${a.date}, ${a.time}–${b.time} ${b.ampm} ${zb}` : `${a.date}, ${a.time} ${a.ampm}–${b.time} ${b.ampm} ${zb}`;
  else when = `${a.date}, ${a.time} ${a.ampm} – ${b.date}, ${b.time} ${b.ampm} ${zb}`;
  return `${label} ${when}${note}`;
}
// The stamp line under a title. No stamp is said as a value: the reader is told the check time is unknown.
export const stampHtml = (stamp: string | null, missing: string = UNKNOWN.checkUnknown) =>
  stamp ? `<p class="stamp" data-stamp="known">${esc(stamp)}</p>` : `<p class="stamp" data-stamp="unknown">${valueHtml(unknown(missing))}</p>`;

// ---------------------------------------------------------------- "Made for <first name> · <date>" (brief P3.1)
// The first name only from a CONFIRMED fact (D-007): preferred name, else first name. A stated-in-chat or draft fact is not
// confirmed. None: "you". Never a guess from an email or a Telegram display name.
export function firstNameOf(facts: readonly unknown[] | null | undefined): string | null {
  // deno-lint-ignore no-explicit-any
  const ok = (facts ?? []).filter((f: any) => f && typeof f === "object" && !f.stated && f.status !== "draft" && f.confirmed !== false) as any[];
  for (const kind of ["preferred_name", "first_name"]) {
    const f = ok.find((x) => x.kind === kind || x.id === kind || x.key === kind);
    const raw = f ? (typeof f.value === "string" ? f.value : typeof f.value?.value === "string" ? f.value.value : "") : "";
    const word = raw.replace(BIDI_CONTROLS, "").replace(LONE_SURROGATE, "").trim().split(/\s+/)[0] ?? "";
    if (word && word.length <= 40 && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(word)) return word;
  }
  return null;
}
export function dateIn(t: number, tz?: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zoneValid(tz) ? tz : FALLBACK_ZONE, month: "short", day: "numeric", year: "numeric" }).format(new Date(t));
}
export const madeForLine = (firstName: string | null, at: number, tz?: string | null) => `Made for ${firstName ?? "you"} · ${dateIn(at, tz)}`;

// ---------------------------------------------------------------- sections, rows, caveats, evidence
export interface RowItem { name: string; detail?: string | null; value: Value; href?: string | null }
export const caveatHtml = (text: string, title?: string) =>
  `<aside class="caveat" role="note">${title ? `<strong class="caveat-t">${esc(title)}</strong> ` : ""}${esc(text)}</aside>`;
export function rowsHtml(items: readonly RowItem[]): string {
  return `<ol class="nrows">${items.map((r, i) => {
    const link = r.href && /^https:\/\//i.test(r.href) ? r.href : null;
    const name = link ? `<a class="nname" href="${esc(link)}" rel="noopener noreferrer">${esc(r.name)}</a>` : `<span class="nname">${esc(r.name)}</span>`;
    return `<li class="nrow"><span class="nnum" aria-hidden="true">${i + 1}</span><span class="nbody">${name}${blank(r.detail) ? "" : `<span class="ndetail">${esc(r.detail)}</span>`}</span>${valueHtml(r.value)}</li>`;
  }).join("")}</ol>`;
}
// A section: its quiet label, then its caveat (directly above what it qualifies), then the body.
export const sectionHtml = (label: string, body: string, o: { caveat?: { text: string; title?: string } | null } = {}) =>
  body ? `<section class="fsec"><h2 class="flabel">${esc(label)}</h2>${o.caveat ? caveatHtml(o.caveat.text, o.caveat.title) : ""}${body}</section>` : "";

// Rows under a label. When any value is unknown and the caller gave no caveat, a caveat says how many are not known (audit D08:
// caveats wherever data is incomplete), directly above the rows.
export function rowsSectionHtml(label: string, items: readonly RowItem[], caveat?: { text: string; title?: string } | null): string {
  if (!items.length) return "";
  const n = items.filter((r) => r.value.kind === "unknown").length;
  const auto = n && !caveat ? { text: `${n} of ${items.length} ${n === 1 ? "isn't" : "aren't"} known, so ${n === 1 ? "it is" : "they are"} shown as unknown rather than guessed.` } : null;
  return sectionHtml(label, rowsHtml(items), { caveat: caveat ?? auto });
}

export interface Evidence { quote: string; source: string; at?: number | string | null; href?: string | null; hrefLabel?: string; image?: string | null; imageAlt?: string }
// The proof rides with the claim: the snippet, where it came from and when, and the receipt itself (link, or the screenshot inline
// when its origin is one the page's CSP allows; the caller decides that and passes image only then).
export function evidenceHtml(e: Evidence, tz?: string | null): string {
  const t = toMs(e.at), when = t ? ` · ${freshnessStamp("", [t], { now: Number.MAX_SAFE_INTEGER, tz })!.trim()}` : "";
  const img = e.image && /^https:\/\//i.test(e.image) ? `<img class="ev-img" src="${esc(e.image)}" alt="${esc(e.imageAlt ?? "Screenshot of the confirmation")}" loading="lazy" referrerpolicy="no-referrer">` : "";
  const link = e.href && /^https:\/\//i.test(e.href) ? `<a class="ev-link" href="${esc(e.href)}" rel="noopener noreferrer">${esc(e.hrefLabel ?? "Open the receipt")}</a>` : "";
  return `<figure class="evidence"><blockquote class="ev-q">${esc(e.quote)}</blockquote>${img}<figcaption class="ev-c">${esc(e.source)}${esc(when)}${link ? ` ${link}` : ""}</figcaption></figure>`;
}

// ---------------------------------------------------------------- the job card (brief P6.3, P6.7)
export interface JobCard {
  company: string; title: string; logo?: string | null; // a same-origin or allowlisted logo src; absent, the lettermark
  pay: Value; location: Value; posted: Value; fit?: string | null;
  action: { html: string } | { href: string; label: string } | null; // ONE primary action, drawn at the bottom
  closed?: boolean; // the posting is closed: no action is offered, the card says so where the action would be (audit D01)
}
export function jobCardHtml(c: JobCard): string {
  const img = c.logo ? `<img src="${esc(c.logo)}" alt="" width="44" height="44" loading="lazy" referrerpolicy="no-referrer">` : "";
  const fact = (k: string, v: Value) => `<div class="jf"><dt>${esc(k)}</dt><dd>${valueHtml(v)}</dd></div>`;
  const act = c.closed ? `<p class="jclosed" role="status">${valueHtml(unknown(UNKNOWN.closed))} This posting is no longer taking applications.</p>` : !c.action ? "" : "html" in c.action ? c.action.html
    : /^https?:\/\//i.test(c.action.href) ? `<a class="apply jbtn" href="${esc(c.action.href)}" rel="noopener noreferrer">${esc(c.action.label)}</a>` : "";
  return `<article class="jcard${c.closed ? " jcard-closed" : ""}"><div class="jhead"><span class="jlogo"><span class="lettermark" aria-hidden="true">${esc(initialOf(c.company))}</span>${img}</span>`
    + `<span class="jwho"><span class="jrole">${esc(c.title)}</span><span class="jco">${esc(c.company)}</span></span></div>`
    + `<dl class="jfacts">${fact("Pay", c.pay)}${fact("Location", c.location)}${fact("Posted", c.posted)}</dl>`
    + (blank(c.fit) ? "" : `<p class="jfit">${esc(c.fit)}</p>`) + (act ? `<div class="jact">${act}</div>` : "") + `</article>`;
}

// ---------------------------------------------------------------- empty, loading and error states (brief P6.8)
export interface StateBlock { kind: "empty" | "loading" | "error"; title: string; reason: string; next: string; retry?: { token?: string; action?: string; href?: string; label?: string } }
export function stateHtml(s: StateBlock): string {
  const role = s.kind === "error" ? "alert" : "status";
  const retry = s.retry ? (s.retry.href && /^(https:\/\/|\?|\/)/.test(s.retry.href)
    ? `<a class="apply" href="${esc(s.retry.href)}">${esc(s.retry.label ?? "Try again")}</a>`
    : `<form method="post">${s.retry.token ? `<input type="hidden" name="t" value="${esc(s.retry.token)}">` : ""}<input type="hidden" name="action" value="${esc(s.retry.action ?? "refresh")}"><button type="submit" class="apply">${esc(s.retry.label ?? "Try again")}</button></form>`) : "";
  const busy = s.kind === "loading" ? ` aria-busy="true"` : "";
  const bar = s.kind === "loading" ? `<span class="fbar" aria-hidden="true"></span>` : "";
  return `<section class="fstate fstate-${s.kind}" role="${role}"${busy}>${bar}<h2 class="fstate-t">${esc(s.title)}</h2><p class="fstate-why">${esc(s.reason)}</p><p class="fstate-next"><strong>What happens next:</strong> ${esc(s.next)}</p>${retry}</section>`;
}

// ---------------------------------------------------------------- the shell: header above, one card
export interface FileShell { made: string; title: string; stamp: string | null; stampMissing?: string; eyebrow?: string | null; intro?: string | null; body: string; after?: string }
export function fileShellHtml(o: FileShell): string {
  return `<header class="fhead">${BRAND}<p class="made">${esc(o.made)}</p></header>`
    + `<div class="fcard">${o.eyebrow ? `<p class="eyebrow">${esc(cap1(o.eyebrow))}</p>` : ""}<h1 class="ftitle">${esc(o.title)}</h1>${stampHtml(o.stamp, o.stampMissing)}`
    + `${blank(o.intro) ? "" : `<p class="intro">${esc(o.intro)}</p>`}<main id="main">${o.body}</main></div>${o.after ?? ""}`;
}

export const FILE_CSS = `
.fhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:4px 0 14px}.fhead .brand{margin:0}
.made{margin:0;font-size:15px;color:var(--mute)}
.fcard{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px 28px;box-shadow:0 1px 2px rgba(20,20,20,.04)}
.ftitle{margin:0;font-family:${DISPLAY_FONT};font-weight:500;font-size:30px;line-height:1.18;overflow-wrap:anywhere}
.eyebrow{margin:0 0 6px;font-size:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
.stamp{margin:8px 0 0;font-size:15px;color:var(--mute)}.stamp .v-unknown{color:inherit}.intro{margin:14px 0 0;font-size:17px}
.fsec{margin:22px 0 0;padding-top:16px;border-top:1px solid var(--line)}
.flabel{margin:0 0 10px;font-size:14px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mute)}
ol.nrows{list-style:none;margin:0;padding:0}
.nrow{display:flex;align-items:baseline;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.nrow:first-child{border-top:0}
.nnum{flex:none;min-width:1.4em;font-size:15px;color:var(--mute);font-variant-numeric:tabular-nums}
.nbody{flex:1;min-width:0}.nname{display:block;font-weight:600;overflow-wrap:anywhere}.ndetail{display:block;font-size:16px;color:var(--mute);overflow-wrap:anywhere}
a.nname{color:var(--link);display:inline-flex;align-items:center;min-height:44px}
.v{flex:none;max-width:45%;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.v-verified{color:var(--verified)}.vtag{display:inline-block;margin-left:4px;font-size:14px;font-weight:600;font-style:normal;color:var(--verified);white-space:nowrap}.v-stated{color:var(--ink)}.v-unknown{color:var(--mute);font-weight:500;font-style:italic}
.caveat{margin:0 0 12px;padding:12px 14px;border-radius:12px;background:var(--tint);color:var(--ink);font-size:16px;overflow-wrap:anywhere}.caveat-t{font-weight:600}
.evidence{margin:10px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px}
.ev-q{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.ev-img{display:block;max-width:100%;height:auto;margin:10px 0 0;border:1px solid var(--line);border-radius:8px}
.ev-c{margin:8px 0 0;font-size:15px;color:var(--mute);overflow-wrap:anywhere}
.fcard a:not(.apply):not(.btn),.ev-link{color:var(--link)}.ev-link{display:inline-flex;align-items:center;min-height:44px}
.jcard{margin:0 0 14px;padding:18px 16px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
.jhead{display:flex;align-items:center;gap:12px}
.jlogo{position:relative;flex:none;width:44px;height:44px;border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.jlogo .lettermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:${DISPLAY_FONT};font-size:22px;font-weight:700;color:var(--ink)}
.jlogo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fff;color:transparent;font-size:0}
.jwho{min-width:0}.jrole{display:block;font-weight:600;font-size:18px;overflow-wrap:anywhere}.jco{display:block;font-size:16px;color:var(--mute);overflow-wrap:anywhere}
.jfacts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:14px 0 0}.jf dt{font-size:14px;color:var(--mute)}.jf dd{margin:0}.jf .v{display:block;max-width:none;text-align:left;font-size:16px}
.jfit{margin:12px 0 0;font-size:16px;overflow-wrap:anywhere}
.jact{margin-top:16px}.jact .apply,.jact form,.jact .jbtn{width:100%}.jact .apply{display:flex;min-height:48px}
.fstate{padding:8px 0}.fstate-t{margin:0 0 8px;font-family:${DISPLAY_FONT};font-weight:500;font-size:22px}.fstate-why,.fstate-next{margin:0 0 10px;font-size:16px}
.fstate .apply{margin-top:6px}
.fbar{display:block;height:6px;width:40%;margin:0 0 14px;border-radius:999px;background:var(--line)}
@media (prefers-reduced-motion:no-preference){.fbar{animation:fpulse 1.6s ease-in-out infinite}}@keyframes fpulse{50%{opacity:.4}}
.fsrc{display:block;margin-top:2px;font-size:14px;font-weight:400;font-style:normal;color:var(--mute);white-space:normal}
.v .fsrc{text-align:inherit}.jf .fsrc{text-align:left}
.jclosed{margin:0;font-size:16px;color:var(--mute)}.jclosed .v{display:inline;max-width:none}
.jcard-closed{background:var(--card)}.jcard-closed .jrole{color:var(--mute)}
.apply:focus-visible,.fcard a:focus-visible,.fcard button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}

@media (max-width:360px){.jfacts{grid-template-columns:1fr 1fr}.fcard{padding:20px 16px 24px}}
`;
