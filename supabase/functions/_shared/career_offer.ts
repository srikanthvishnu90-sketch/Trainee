// WO-036: the offer benchmark. The person texts their offer in their own words ("JPM offered 110k base, 15k signing,
// NYC, analyst"); code reads it, asks once for what is missing, places it against public data, and drafts a counter
// from 128's factScript. The model never supplies a number.
//
// Public data only, each number said with what it is, its period and its n:
//   - DOL H-1B LCA: the employer's own filed wages for that occupation and metro (packages/career-data/datasets/
//     dol-lca-wages.json, built by scripts/career/datasets/aggregate-lca.py --wages). A median from fewer than 5
//     filings is never shown as a benchmark.
//   - BLS OEWS: the occupation's wage percentiles in the metro (bls-oews-metro.json, scripts/career/datasets/import-oews.py).
//   - BLS national median for the occupation (bls-labor-data.json, already on file) when the metro data is not loaded.
// A file not imported yet is said in one line ("not loaded yet"), never filled in. Nothing is sent: the counter is a
// draft the person reads, edits and sends themselves.
import { CareerNegotiation, CareerPaths } from "./router_core.career.js";

export const MIN_N = 5; // the fewest filings a median may come from
export const ASK_TTL_MS = 24 * 3600_000; // a half-told offer waits this long for the missing pieces
export const REQUIRED = ["company", "base", "city", "role"] as const;
export type Field = typeof REQUIRED[number];
export const MAX_MESSAGE = 1500;

export interface Competing { company: string | null; base: number; said: string }
export interface Offer {
  company: string | null; firm_id: string | null; lca_company_id: string | null; sector: string | null;
  base: number | null; hourly: number | null; signing: number | null; bonus: number | null; bonus_pct: number | null;
  city: string | null; metro: string | null; metro_label: string | null; remote: boolean;
  role: string | null; occupation: { key: string; soc: string; soc_title: string; bls_national: string | null } | null;
  competing: Competing[]; deadline: { text: string } | null;
  // LOOP 13: a bonus amount said as a target ("a $15k target bonus") is not guaranteed cash; and the clause each figure was
  // read from, so the reply can say where it came from (offer letter, verbal, the person's estimate).
  bonus_target?: number | null; from?: Partial<Record<"base" | "signing" | "bonus" | "bonus_pct" | "bonus_target", string>>;
}
export interface Bench {
  kind: "lca" | "oews" | "bls_national";
  shown: boolean;
  label: string; // what the number is, in words
  cite: string; // the short citation used in the draft
  what: string; // the caveat, said plainly
  period: string | null;
  n: number | null;
  median: number | null; p25: number | null; p75: number | null;
  position: string | null;
  reason: string | null; // why it is not shown
  source_url: string;
}
export interface OfferData { maps: any; lca_wages: any; oews_metro: any; bls_national: any; lca_companies: any }

export function payData(): OfferData { return (CareerNegotiation as any).payData(); }
function guide(): any { return (CareerPaths as any).firmGuide(); }

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9$%.]+/g, " ").trim();
// A word or phrase, bounded so "c++" and "jpm" match only as themselves. With `names`, a short company alias (JPM, GS,
// HRT, Meta) matches only written as a name (JPM or Jpm, Meta or META), so "gs" or "meta" inside a sentence never
// names a company.
export function hasWord(text: string, w: string, names = false): boolean {
  const bound = (s: string) => `(?<![\\w+#])${esc(s)}(?![\\w+#])`;
  if (names && w.length <= 4 && /^[a-z]+$/.test(w)) {
    return new RegExp(`${bound(w.toUpperCase())}|${bound(w[0].toUpperCase() + w.slice(1))}`).test(text);
  }
  return new RegExp(bound(w), "i").test(text);
}

// ---------- reading the offer from the person's words ----------
const MONEY = /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|K|thousand|m|M)?(?![\w])(\s?(?:\/\s?(?:hr|hour)|an hour|per hour|hourly|\/h\b))?/g;
interface Amount { value: number; hourly: boolean; at: number; end: number }
function amounts(clause: string): Amount[] {
  const out: Amount[] = [];
  for (const m of clause.matchAll(MONEY)) {
    let v = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").toLowerCase(), hourly = !!m[3];
    if (unit === "k" || unit === "thousand") v *= 1000;
    else if (unit === "m") v *= 1_000_000;
    const dollar = m[0].includes("$");
    // "401k", "403(b)", "457b" name a retirement plan, never pay (LOOP 13: "a 4% 401k match" was read as a $401,000 base).
    if (!dollar && /^(?:401|403|457)$/.test(m[1]) && /^\s?\(?[kb]\)?/i.test(clause.slice((m.index ?? 0) + m[0].indexOf(m[1]) + m[1].length))) continue;
    // A bare small number is a count or a date, not pay: pay is "110k", "$110,000", "110000" or "$45/hr".
    if (!hourly && v < 1000) continue;
    if (hourly && (v < 7 || v > 1000)) continue;
    if (!dollar && !unit && !hourly && (v < 10000 || /^20\d\d$/.test(m[1]))) continue;
    out.push({ value: v, hourly, at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}
export function firmIn(text: string): any | null {
  const g = guide();
  let best: any = null, bestLen = 0;
  for (const f of g?.firms || []) {
    for (const a of [f.name, ...(f.aliases || [])]) {
      const w = String(a).toLowerCase();
      if (w.length > bestLen && hasWord(text, w, true)) { best = f; bestLen = w.length; }
    }
  }
  return best;
}
// A company not in the guide, named the way people say it: "Acme offered", "offer from Acme", "at Acme".
function namedCompany(text: string): string | null {
  const m = text.match(/\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:offered|is offering|gave me|made me an offer)/) ||
    text.match(/\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:will|might|may|could|should|is going to|is likely to) offer\b/) ||
    text.match(/\boffer (?:letter )?(?:from|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
  if (!m) return null;
  const name = m[1].replace(/^(?:I|My|The|An?|They|We)\s+/, "").trim();
  return name && !/^(I|My|The|They|We|So|Just|Also)$/.test(name) ? name : null;
}
function metroIn(text: string, maps: any): any | null {
  let best: any = null, bestLen = 0;
  for (const m of maps?.metros || []) for (const w of m.words) if (w.length > bestLen && hasWord(text, w)) { best = m; bestLen = w.length; }
  return best;
}
const ROLE_WORDS = ["investment banking analyst", "summer analyst", "ib analyst", "financial analyst", "research analyst", "business analyst",
  "data analyst", "data scientist", "software engineer", "software developer", "software development engineer", "machine learning engineer",
  "product manager", "associate consultant", "management consultant", "consultant", "quantitative researcher", "quantitative trader",
  "trader", "associate", "analyst", "engineer", "developer", "swe", "sde", "accountant", "auditor"];
function roleIn(text: string): string | null {
  for (const r of ROLE_WORDS) if (hasWord(text, r)) return r === "swe" || r === "sde" ? r.toUpperCase() : r;
  return null;
}
function occupationFor(role: string | null, sector: string | null, maps: any): Offer["occupation"] {
  if (!role) return null;
  const r = role.toLowerCase();
  const occs: any[] = maps?.occupations || [];
  // The longest matching phrase wins ("investment banking analyst" over "analyst").
  let best: any = null, bestLen = 0;
  for (const o of occs) for (const w of o.words) if (w.length > bestLen && (r === w || hasWord(r, w))) { best = o; bestLen = w.length; }
  if (!best && /^(summer )?analyst$/.test(r) && sector) best = occs.find((o) => (o.analyst_sectors || []).includes(sector)) || null;
  return best ? { key: best.key, soc: best.soc, soc_title: best.soc_title, bls_national: best.bls_national ?? null } : null;
}
const DEADLINE = /\b(?:deadline(?: is)?|expires?(?: on)?|due|(?:answer|respond|reply|decide|sign|accept)(?: back)? by|need to (?:answer|decide|respond|reply|sign|accept)(?: by)?|have until|by)\s+((?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|end of (?:the )?(?:day|week|month)|eod|eow|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})/i;
const BENEFIT = /\b(relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)(?![\w])/i;
// An amount followed by a benefit's name ("$3,000 relocation") inside a clause that also states the pay.
const BENEFIT_AMOUNT = /^\s*(?:in |of |for )?(?:relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)/i;
const COMPETING = /\b(another offer|competing offer|other offer|second offer|also (?:have|got) an offer|also offered|offer from .+ too)\b/i;

// One message, or one piece of it, read into an offer. Clauses are read one at a time so "110k base, 15k signing" puts
// each number with its own label, and a clause about another offer never becomes this offer's numbers.
export function parseOfferWords(text: string, data: OfferData = payData()): Offer {
  const t = String(text ?? "");
  const maps = data?.maps;
  const offer: Offer = { company: null, firm_id: null, lca_company_id: null, sector: null, base: null, hourly: null, signing: null, bonus: null, bonus_pct: null,
    city: null, metro: null, metro_label: null, remote: false, role: null, occupation: null, competing: [], deadline: null };
  const clauses = t.split(/[;\n]|,(?!\d{3})|\.(?=\s|$)|\s+(?:and|but|plus|with)\s+/i).map((c) => c.trim()).filter(Boolean);
  const main: string[] = [];
  for (const c of clauses) {
    if (COMPETING.test(c) || (/\boffer(?:ed)?\b.*\btoo\b/i.test(c) && amounts(c).length)) {
      const a = amounts(c)[0];
      if (a) {
        const f = firmIn(c.replace(COMPETING, ""));
        const named = f ? f.name : (c.match(/\b(?:from|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/)?.[1] ?? null);
        offer.competing.push({ company: named, base: a.hourly ? a.value * 2080 : a.value, said: c });
      }
      continue;
    }
    main.push(c);
  }
  const body = main.join(", ");
  const firm = firmIn(body);
  if (firm) { offer.company = firm.name; offer.firm_id = firm.firm_id; offer.lca_company_id = firm.lca_company_id ?? null; offer.sector = firm.sector ?? null; }
  else offer.company = namedCompany(body);
  const from: NonNullable<Offer["from"]> = {};
  offer.from = from;
  offer.bonus_target = null;
  for (const c of main) {
    const as = amounts(c).filter((a) => !BENEFIT_AMOUNT.test(c.slice(a.end, a.end + 40)));
    if (!as.length) { const p = c.match(/(\d{1,2}(?:\.\d+)?)\s?%\s*(?:target )?bonus|bonus(?: target)?(?: of)? (\d{1,2}(?:\.\d+)?)\s?%/i); if (p) { offer.bonus_pct = Number(p[1] ?? p[2]); from.bonus_pct = c; } continue; }
    // A relocation, a stipend or a retirement match is a benefit, never the base or a bonus (LOOP 13).
    if (BENEFIT.test(c) && !/\b(base|salary)\b/i.test(c)) continue;
    const a = as[0];
    if (/sign(?:ing|-on| on)/i.test(c)) { offer.signing = a.value; from.signing = c; }
    else if (/bonus/i.test(c) && /\btarget\b/i.test(c)) { offer.bonus_target = a.value; from.bonus_target = c; }
    else if (/bonus/i.test(c)) { offer.bonus = a.value; from.bonus = c; }
    else if (/\b(base|salary|pay|offered|offer of|offering|comp|per year|a year|annual|\/yr)\b/i.test(c) || a.hourly || offer.base == null) {
      if (a.hourly) { offer.hourly = a.value; offer.base = Math.round(a.value * 2080); } else offer.base = a.value;
      from.base = c;
    }
  }
  const metro = metroIn(body, maps);
  if (metro) { offer.metro = metro.key; offer.metro_label = metro.label; offer.city = metro.label; }
  else if (/\bremote\b/i.test(body)) { offer.remote = true; offer.city = "remote"; }
  offer.role = roleIn(body);
  offer.occupation = occupationFor(offer.role, offer.sector, maps);
  const d = t.match(DEADLINE);
  if (d) offer.deadline = { text: d[1] };
  return offer;
}

// Later words fill what earlier words left open, and correct what they said.
export function mergeOffers(a: Offer, b: Offer, data: OfferData = payData()): Offer {
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "competing") continue;
    if (v !== null && v !== false && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  out.competing = [...a.competing, ...b.competing];
  out.from = { ...(a.from ?? {}), ...(b.from ?? {}) };
  out.occupation = occupationFor(out.role, out.sector, data?.maps);
  return out as Offer;
}
export function missingOf(o: Offer): Field[] {
  return REQUIRED.filter((f) => f === "city" ? !o.city : f === "base" ? o.base == null : !o[f]);
}
const ASK_WORDS: Record<Field, string> = { company: "the company", base: "the base salary", city: "the city", role: "the job title" };
export function askFor(missing: Field[]): string {
  const w = missing.map((f) => ASK_WORDS[f]);
  const list = w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0];
  return `To benchmark it I need ${list}. What ${missing.length > 1 ? "are they" : "is it"}?`;
}

// ---------- the benchmark ----------
function position(base: number, b: { median: number | null; p25: number | null; p75: number | null }): string | null {
  if (b.median == null) return null;
  const pct = Math.round(((base - b.median) / b.median) * 100);
  const vs = pct === 0 ? "right at the median" : `${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} the median`;
  let band = "";
  if (b.p25 != null && base < b.p25) band = ", under the 25th percentile";
  else if (b.p75 != null && base > b.p75) band = ", over the 75th percentile";
  else if (b.p25 != null && b.p75 != null) band = base < b.median ? ", between the 25th percentile and the median" : base > b.median ? ", between the median and the 75th percentile" : "";
  return `Your base is ${vs}${band}.`;
}
export function benchmarks(o: Offer, data: OfferData = payData()): Bench[] {
  const out: Bench[] = [];
  if (!o.occupation) return out;
  const occ = o.occupation;
  const base = o.base;
  // 1. The employer's own filed H-1B wages for this occupation and metro.
  const lca = data?.lca_wages;
  const lcaWhat = "Employers' filed wages for H-1B workers, not offers; a floor signal (the employer must pay at least this).";
  if (o.lca_company_id && o.metro) {
    const b: Bench = { kind: "lca", shown: false, label: `${o.company}'s own H-1B filings for ${occ.soc_title} in the ${o.metro_label}`, cite: "", what: lcaWhat,
      period: lca?.period ?? null, n: null, median: null, p25: null, p75: null, position: null, reason: null, source_url: lca?.source_url || "https://www.dol.gov/agencies/eta/foreign-labor/performance" };
    if (lca?.status !== "imported") b.reason = "not loaded yet";
    else {
      const cell = (lca.cells || []).find((c: any) => c.company_id === o.lca_company_id && c.soc === occ.soc && c.metro === o.metro);
      if (!cell) b.reason = `none on file for ${lca.period}`;
      else {
        b.n = cell.n;
        if (cell.n < MIN_N) b.reason = `only ${cell.n} filing${cell.n === 1 ? "" : "s"} in ${lca.period}, too few for a median`;
        else Object.assign(b, { shown: true, median: cell.median, p25: cell.p25, p75: cell.p75, cite: `${o.company}'s own H-1B filings for ${occ.soc_title} in the ${o.metro_label} (DOL LCA, ${lca.period}, ${cell.n} filings)` });
      }
    }
    out.push(b);
  }
  // 2. BLS OEWS for the occupation in the metro.
  const oews = data?.oews_metro;
  const oewsWhat = "What employers in the area paid people in this occupation, all levels of experience; not entry-level pay and not one employer's.";
  let oewsShown = false;
  if (o.metro) {
    const b: Bench = { kind: "oews", shown: false, label: `BLS pay for ${occ.soc_title} in the ${o.metro_label}`, cite: "", what: oewsWhat,
      period: oews?.reference_period ?? null, n: null, median: null, p25: null, p75: null, position: null, reason: null, source_url: oews?.source_url || "https://www.bls.gov/oes/tables.htm" };
    if (oews?.status !== "imported") b.reason = "not loaded yet";
    else {
      const cell = (oews.cells || []).find((c: any) => c.soc === occ.soc && c.metro === o.metro);
      if (!cell) b.reason = `none on file for ${oews.reference_period}`;
      else if (cell.median == null) b.reason = (cell.flags || []).includes("median_top_coded") ? "the median is above BLS's top published band" : "BLS did not release a median";
      else { Object.assign(b, { shown: true, n: cell.employment ?? null, median: cell.median, p25: cell.p25, p75: cell.p75, cite: `BLS OEWS for ${occ.soc_title} in the ${o.metro_label} (${oews.reference_period})` }); oewsShown = true; }
    }
    out.push(b);
  }
  // 3. The national median already on file, when the metro figure is not there.
  if (!oewsShown && occ.bls_national) {
    const bls = data?.bls_national;
    const rec = (bls?.occupations || []).find((r: any) => r.occupation === occ.bls_national);
    if (rec && Number.isFinite(rec.median_annual_wage_usd_may2024)) {
      out.push({ kind: "bls_national", shown: true, label: `BLS national median for ${rec.occupation.toLowerCase()}`, cite: `BLS's national median for ${rec.occupation.toLowerCase()} (May 2024)`,
        what: `All employers and experience levels, nationwide${o.metro_label ? `; not the ${o.metro_label}` : ""}, not entry level.`, period: "May 2024", n: rec.employment_2024 ?? null,
        median: rec.median_annual_wage_usd_may2024, p25: null, p75: null, position: null, reason: null, source_url: rec.source_url });
    }
  }
  if (base != null) for (const b of out) if (b.shown) b.position = position(base, b);
  return out;
}

// ---------- the reply ----------
function host(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function fit(lines: string[]): string[] {
  // Split on purpose at a line boundary so no message is over MAX_MESSAGE characters.
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    const next = cur ? `${cur}\n${l}` : l;
    if (next.length > MAX_MESSAGE && cur) { out.push(cur.trim()); cur = l; } else cur = next;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((m) => m.length > MAX_MESSAGE ? m.slice(0, MAX_MESSAGE - 3) + "..." : m);
}
export interface OfferResult {
  status: "ask" | "benchmarked";
  offer: Offer;
  missing: Field[];
  ask: string | null;
  benchmarks: Bench[];
  draft: { email: string; call: string; sent: false } | null;
  messages: string[];
}
export function offerReply(o: Offer, notGiven: Field[], data: OfferData = payData()): OfferResult {
  const bench = benchmarks(o, data);
  const parts = [o.company, o.role, o.city === "remote" ? "remote" : o.metro_label, o.base != null ? `base ${usd(o.base)}${o.hourly ? ` (${usd(o.hourly)} an hour x 2,080 hours)` : ""}` : null,
    o.signing != null ? `signing ${usd(o.signing)}` : null, o.bonus != null ? `bonus ${usd(o.bonus)}` : null, o.bonus_pct != null ? `target bonus ${o.bonus_pct}%` : null].filter(Boolean);
  const lines: string[] = [`Your offer: ${parts.join(", ")}.`];
  if (notGiven.length) lines.push(`Not given: ${notGiven.map((f) => ASK_WORDS[f]).join(", ")}, so I left ${notGiven.length > 1 ? "those" : "that"} out of the comparison.`);
  if (!o.occupation) lines.push(o.role ? `I don't have public pay data mapped to "${o.role}" at ${o.sector ? `a ${o.sector} firm` : "this employer"}, so there is no occupation benchmark.` : "Without the job title there is no occupation to benchmark against.");
  const urls: string[] = [];
  for (const b of bench) {
    if (b.shown) {
      lines.push("");
      lines.push(`${b.label}, ${b.period}${b.kind === "lca" ? `, ${b.n} filings` : b.n ? `, about ${b.n.toLocaleString("en-US")} people employed` : ""}: median ${usd(b.median!)}${b.p25 != null && b.p75 != null ? ` (middle half ${usd(b.p25)} to ${usd(b.p75)})` : ""}.`);
      lines.push(`What it is: ${b.what}`);
      if (b.position) lines.push(b.position);
      urls.push(b.source_url);
    } else {
      lines.push("");
      lines.push(`${b.label}: ${b.reason}.`);
    }
  }
  const shown = bench.filter((b) => b.shown);
  if (o.occupation && !shown.length) lines.push("", "So I have no public number to place your offer against yet, and I won't make one up.");
  const firstUp = shown.find((b) => b.median != null);
  const script = (CareerNegotiation as any).factScript({ company: o.company, role: o.role, base: o.base, signing: o.signing },
    { competing: o.competing.map((c) => ({ ...c })), deadline: o.deadline, benchmark: firstUp ? { median: firstUp.median, cite: firstUp.cite } : null });
  const uniq = [...new Set(urls)];
  if (uniq.length) lines.push("", "Sources:", ...uniq);
  const draftLines = ["A counter you could send. Nothing is sent: edit it and send it yourself.", "", script.email, "", "On a call:", script.call];
  return {
    status: "benchmarked", offer: o, missing: notGiven, ask: null, benchmarks: bench,
    draft: { email: script.email, call: script.call, sent: false },
    messages: [...fit(lines), ...fit(draftLines)],
  };
}

// ---------- the tool's turn: read, ask once, answer ----------
export interface OfferPending { v: 1; pieces: string[]; asked: Field[]; at: number }
export function offerTurn(o: { words: string; pending: OfferPending | null; now: number; data?: OfferData }): { result: OfferResult; pending: OfferPending | null } {
  const data = o.data ?? payData();
  const fresh = o.pending && o.now - o.pending.at < ASK_TTL_MS ? o.pending : null;
  const now = parseOfferWords(o.words, data);
  // A new offer (another company with its own base) starts over instead of mixing two offers.
  let pieces = fresh ? [...fresh.pieces, o.words] : [o.words];
  let asked = fresh ? fresh.asked : [];
  if (fresh && now.company && now.base != null) {
    const before = fresh.pieces.map((p) => parseOfferWords(p, data)).reduce((a, b) => mergeOffers(a, b, data));
    if (before.company && before.company !== now.company) { pieces = [o.words]; asked = []; }
  }
  const offer = pieces.map((p) => parseOfferWords(p, data)).reduce((a, b) => mergeOffers(a, b, data));
  const missing = missingOf(offer);
  if (missing.length && !asked.length) {
    const ask = askFor(missing);
    return { result: { status: "ask", offer, missing, ask, benchmarks: [], draft: null, messages: [ask] }, pending: { v: 1, pieces, asked: missing, at: o.now } };
  }
  // Asked once already: what is still missing is said, never asked again.
  return { result: offerReply(offer, missing, data), pending: null };
}
// The words must be the person's own, from this turn's message.
export function saidIn(message: string, words: string): boolean {
  const w = plain(words), m = plain(message);
  return !!w && ` ${m} `.includes(` ${w} `);
}
export { host as sourceHost };
