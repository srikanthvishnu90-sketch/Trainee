// WO-033 part 1: contact lists. A list comes from a ContactSource: a CSV the person exported themselves (their own
// LinkedIn connections export, the file they download), or a CSV exported from Apollo's own UI (the owner's choice of list
// vendor, 2026-10-20; docs/career/contact-vendors.md). No vendor API is called: the CSV path works on every Apollo plan.
// Never LinkedIn automation: nothing here fetches a URL from a row, and every profile-URL column is dropped on import.
//
// Every address is checked by what can actually be run, and says which. The free first pass, here:
//   syntax      one address, a plain local part and a domain with a dot (no comma, no space, no second @);
//   mx          the domain publishes a mail server, read through DNS-over-HTTPS behind a seam (NOT_WIRED offline);
//   role        info@, careers@, hr@ and their kin: an inbox, not a person;
//   disposable  a throwaway-mail domain.
// Then, only for addresses that passed it, the paid independent check: Hunter's Email Verifier (HUNTER_API_KEY; NOT_WIRED
// without it), rate-limited and cached per address per billing month. Only Hunter's "valid" counts as deliverable;
// accept_all (a server that accepts any address) and webmail are reported apart, never as deliverable. Apollo's own
// "Email Status" column is kept as the vendor's claim and never counted as a check.
// An address is "verified" only when it passed every check that ran on it, and the label names exactly those checks.
// Trainee never probes a mailbox over SMTP itself (RCPT TO): it is abusive to the receiving server and gets the sender's
// IPs blocked. Hunter runs its own checks on its own servers; that is the one mailbox-level signal, and it is labeled.
import { CareerProfile } from "./router_core.career.js";
import { cleanCell, isFormula, readsAsInstruction } from "./career_people_import.ts";
import type { RecipientFact } from "./career_outreach_personalize.ts";

export const MAX_CONTACTS = 3000; // what the per-thread state keeps (the snapshot is at most 1 MB)
export const NO_SMTP_PROBE = "Trainee never probes a mailbox over SMTP itself: it is abusive to mail servers and gets IPs blocked. Only Hunter's own check, where it ran, speaks to the mailbox.";

export type HunterStatus = "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown";
export interface Checks {
  syntax: "pass" | "fail"; mx: "pass" | "fail" | "not_run"; role: "pass" | "flagged"; disposable: "pass" | "flagged";
  hunter?: HunterStatus; hunter_score?: number | null; ran: string[];
}
export interface ContactRow {
  file: string; row: number; // the source row: the file's name and the data row's number after the header
  name: string; email: string | null;
  firm: string; firm_raw: string; company: string; // firm normalized; company mirrors it for the older readers (142)
  title: string; school: string; connected_on: string | null;
  // PERSONALIZED OUTREACH (2026-10-31): sourced facts about this person (career_outreach_personalize.ts), each with
  // source_kind + retrieved_at. A contact with them is drafted by the personalization engine.
  facts?: RecipientFact[];
  check?: Checks; verified?: boolean;
  vendor?: string; vendor_email_status?: string; // the list vendor's own claim (Apollo's "Email Status"), never a check
  // A person web discovery found (career_people source "provider"): their address was published on the page that names
  // them, or inferred from the company's email format. The draft card says which (2026-10-29).
  address?: "published" | "inferred";
  discovered?: true; // found by web discovery: someone a draft may reach, never someone the person "knows"
  // #361 re-review (2026-11-01): a row Trainee read from somewhere (a public page, a Gmail correspondent) rather than one the
  // person gave (their LinkedIn export, a CSV or a pasted list). Its address never makes a domain the firm's verified one.
  unverified?: true;
}
export type SourceResult =
  | { status: "ok"; source: string; kind: "own_export" | "vendor"; vendor: string | null; rows: ContactRow[]; duplicates: number; skipped: { row: number; why: string }[]; cost_usd: number }
  | { status: "NOT_WIRED"; source: string; kind: "vendor"; ask: string; cost_usd: 0 };
export interface ListQuery { firms?: string[]; titles?: string[]; count?: number }
export interface ContactSource { name: string; kind: "own_export" | "vendor"; fetch(q?: ListQuery): Promise<SourceResult> }

// ------------------------------------------------------------------------------------------------ firm names
// One spelling per firm, so "Goldman Sachs & Co. LLC", "GS" and "Goldman" are one firm on the list and in the referral map.
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const ALIASES: [string, RegExp][] = [
  ["Goldman Sachs", /^(goldman( sachs)?|gs)$/],
  ["JPMorgan", /^(j ?p ?morgan( chase)?|jpmorgan( chase)?|jpm|chase)$/],
  ["Morgan Stanley", /^(morgan stanley|ms)$/],
  ["Bank of America", /^(bank of america( merrill( lynch)?)?|bofa( securities| merrill)?|baml|merrill( lynch)?)$/],
  ["Citi", /^(citi(group|bank)?( global markets)?)$/],
  ["Barclays", /^barclays( capital| investment bank)?$/],
  ["Deutsche Bank", /^(deutsche bank|db)$/],
  ["Wells Fargo", /^wells fargo$/],
  ["Evercore", /^evercore$/],
  ["Lazard", /^lazard( freres)?$/],
  ["Centerview Partners", /^centerview( partners)?$/],
  ["PJT Partners", /^pjt( partners)?$/],
  ["Moelis", /^moelis$/],
  ["Houlihan Lokey", /^houlihan( lokey)?$/],
  ["Jefferies", /^jefferies$/],
];
const SUFFIX = /\b(and co|and company|incorporated|inc|llc|l l c|llp|ltd|limited|plc|corp|corporation|co|company|n a|na|group|holdings|securities|the)\b/g;
export function normalizeFirm(raw: unknown): string {
  const original = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return "";
  return knownFirm(original) ?? (original.replace(/[,\s]+(Inc\.?|LLC|L\.L\.C\.|LLP|Ltd\.?|Limited|PLC|Corp\.?|Corporation|& Co\.?|Co\.)$/i, "").trim() || original);
}
// A firm only when the words are one of the known spellings ("GS", "Goldman"), else null: an alert word like "analyst" is no firm.
export function knownFirm(raw: unknown): string | null {
  const p = plain(raw), bare = p.replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
  for (const [name, rx] of ALIASES) if (rx.test(p) || rx.test(bare)) return name;
  return null;
}
export const sameFirm = (a: unknown, b: unknown) => !!plain(a) && plain(normalizeFirm(a)) === plain(normalizeFirm(b));
// The key sameFirm compares, for an indexed lookup: sameFirm(a, b) exactly when firmKey(a) !== "" && firmKey(a) === firmKey(b).
export const firmKey = (a: unknown) => (plain(a) ? plain(normalizeFirm(a)) : "");

// ------------------------------------------------------------------------------------------------ CSV import
const COLUMNS: Record<string, string[]> = {
  first: ["first name", "firstname", "first"],
  last: ["last name", "lastname", "last", "surname"],
  name: ["name", "full name", "fullname", "contact name"],
  email: ["email address", "email", "e mail", "work email", "business email", "email 1"],
  firm: ["company", "firm", "organization", "organisation", "employer", "company name", "current company", "account name", "company name for emails"],
  title: ["position", "title", "job title", "role", "current title"],
  school: ["school", "university", "college", "education", "alma mater", "school name"],
  connected: ["connected on", "connected", "date connected"],
  email_status: ["email status"],
};
// Apollo's contact export, as its header reads in an export file: First Name, Last Name, Title, Company, Company Name for
// Emails, Email, Email Status, Seniority, Departments, Person Linkedin Url, City, State, Country, Apollo Contact Id (and
// more). Which columns appear is set in Apollo's "Edit export CSV settings", so the mapping goes by header name, never by
// position; "Person Linkedin Url" and every other URL column are read past, never kept.
const isApollo = (header: string[]) => { const h = header.map(plain); return h.includes("apollo contact id") || (h.includes("email status") && h.includes("seniority")); };
function columnsOf(header: string[]): Record<string, number> | null {
  const h = header.map(plain);
  const at: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLUMNS)) { const i = names.map((n) => h.indexOf(n)).find((i) => i >= 0); if (i !== undefined) at[k] = i; }
  const named = at.name !== undefined || at.first !== undefined;
  return named && (at.firm !== undefined || at.email !== undefined) ? at : null;
}

// Rows of a contacts CSV: a LinkedIn connections export (with its "Notes:" preamble), an Apollo export, or any list with
// a name column and a company or email column. Duplicates (same address, or same name at the same firm) are counted, not
// kept twice.
export function importContactsCsv(file: string, text: string): { rows: ContactRow[]; duplicates: number; skipped: { row: number; why: string }[]; vendor: string | null; error?: string } {
  const lines: string[][] = (CareerProfile as any).parseCsv(String(text ?? ""));
  const hi = lines.findIndex((r) => columnsOf(r) !== null);
  if (hi < 0) return { rows: [], duplicates: 0, skipped: [], vendor: null, error: "no header row with a name column and a company or email column" };
  const at = columnsOf(lines[hi])!, vendor = isApollo(lines[hi]) ? "apollo" : null;
  // NETWORKING SCENARIOS (2026-10-29): a list is a file anyone can make, so its cells get the export's rules
  // (career_people_import.ts): a cell a spreadsheet would run as a formula (= + - @, a tab or CR, a DDE pipe) or that reads
  // as an instruction is never kept as written (a name: the row is left out with the reason; any other field: blanked);
  // markup and control characters are dropped and every field is bounded. Before, every cell was kept as written.
  const raw = (r: string[], k: string) => (at[k] === undefined ? "" : String(r[at[k]] ?? ""));
  const cell = (r: string[], k: string, max = 300) => {
    const v = raw(r, k);
    if (isFormula(v) || readsAsInstruction(v)) return "";
    const c = cleanCell(v, max);
    return readsAsInstruction(c) ? "" : c;
  };
  const rows: ContactRow[] = [], skipped: { row: number; why: string }[] = [], seen = new Set<string>();
  let duplicates = 0;
  lines.slice(hi + 1).forEach((r, i) => {
    const row = i + 1;
    const parts = at.name !== undefined ? [raw(r, "name")] : [raw(r, "first"), raw(r, "last")];
    if (parts.some(isFormula)) { skipped.push({ row, why: "a name that is a spreadsheet formula" }); return; }
    const rawName = parts.filter((x) => x.trim()).join(" ");
    const name = cleanCell(rawName, 200);
    if (readsAsInstruction(rawName) || readsAsInstruction(name)) { skipped.push({ row, why: "a name that reads as an instruction" }); return; }
    if (!name || !/\p{L}/u.test(name)) { skipped.push({ row, why: "no name" }); return; }
    if (/https?:|www\.|\/\//i.test(name)) { skipped.push({ row, why: "a name that is a link" }); return; }
    const rawEmail = raw(r, "email");
    // Never cut to fit: a cut address would be a different, made-up one, so a cell past an address's length is none.
    const cleaned = isFormula(rawEmail) ? "" : cleanCell(rawEmail, 100_000).toLowerCase().replace(/^mailto:/, "");
    const email = cleaned && cleaned.length <= 320 ? cleaned : null;
    const firmRaw = cell(r, "firm", 200), firm = normalizeFirm(firmRaw);
    const key = email ? `e:${email}` : `n:${plain(name)}@${plain(firm)}`;
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    if (rows.length >= MAX_CONTACTS) { skipped.push({ row, why: `past the ${MAX_CONTACTS}-contact limit` }); return; }
    rows.push({
      file, row, name, email, firm, firm_raw: firmRaw, company: firm, title: cell(r, "title", 300), school: cell(r, "school", 200), connected_on: cell(r, "connected", 40) || null,
      ...(vendor ? { vendor, vendor_email_status: cell(r, "email_status") || undefined } : {}),
    });
  });
  return { rows, duplicates, skipped, vendor };
}

// A CSV: the person's own export ($0, every row theirs) or an Apollo export (its cost is what the owner enters for it,
// listCost below). Which one is read from the header.
export function csvSource(file: string, text: string, o: { cost_usd?: number } = {}): ContactSource {
  return {
    name: file, kind: "own_export",
    async fetch() {
      const r = importContactsCsv(file, text);
      return { status: "ok", source: file, kind: r.vendor ? "vendor" : "own_export", vendor: r.vendor, rows: r.rows, duplicates: r.duplicates, skipped: r.skipped, cost_usd: Math.max(0, Number(o.cost_usd) || 0) };
    },
  };
}
// A list nobody has exported yet ("500 bulge bracket bankers"): built in Apollo's UI by whoever holds the account,
// exported as a CSV and sent here. Nothing is called and nothing is spent from here.
export const VENDOR_ASK = "I can't pull a list myself. Build it in Apollo (search, then export to CSV), send me the CSV, and I'll check every address in it.";
export function vendorSource(vendor = "apollo"): ContactSource {
  return { name: vendor, kind: "vendor", async fetch() { return { status: "NOT_WIRED", source: vendor, kind: "vendor", ask: VENDOR_ASK, cost_usd: 0 }; } };
}

// The cost of one list, as the owner enters it: the plan's price for the billing period and how many exports that period
// had, so this list's share is price x rows / exports. VERIFIED only with an invoice number the owner typed; else ASSUMED.
export const LIST_TARGET_USD = 50;
export interface ListCost { file: string; usd: number; plan_price_usd: number; exports_in_period: number; rows: number; invoice: string | null; label: "VERIFIED" | "ASSUMED"; under_target: boolean; at: string }
export function listCost(o: { file: string; plan_price_usd: unknown; exports_in_period: unknown; rows: unknown; invoice?: unknown; now: number }): ListCost | { error: string } {
  const price = Number(o.plan_price_usd), exports = Number(o.exports_in_period), rows = Number(o.rows);
  if (!Number.isFinite(price) || price < 0 || price > 10000) return { error: "the plan price is a dollar amount from 0 to 10,000" };
  if (!Number.isInteger(exports) || !Number.isInteger(rows) || rows < 1 || exports < rows) return { error: "the exports in the period are a whole number at least the rows in this list, and the list has at least 1 row" };
  const invoice = String(o.invoice ?? "").trim();
  const real = /^[A-Za-z0-9][A-Za-z0-9_-]{3,40}$/.test(invoice);
  const usd = Math.round((price * rows / exports) * 100) / 100;
  return { file: o.file, usd, plan_price_usd: price, exports_in_period: exports, rows, invoice: real ? invoice : null, label: real ? "VERIFIED" : "ASSUMED", under_target: usd < LIST_TARGET_USD, at: new Date(o.now).toISOString() };
}

// ------------------------------------------------------------------------------------------------ the free first pass
export type MxResult = { status: "ok"; hosts: string[] } | { status: "none" } | { status: "NOT_WIRED" } | { status: "error"; detail: string };
export type MxResolver = (domain: string) => Promise<MxResult>;
export const MX_NOT_WIRED: MxResolver = async () => ({ status: "NOT_WIRED" });
// MX through DNS-over-HTTPS (the JSON form Cloudflare's resolver serves). An answer with MX records is a pass; NXDOMAIN or
// no MX record is a fail; anything else did not run.
export function dohMx(fetchFn: typeof fetch, endpoint = "https://cloudflare-dns.com/dns-query"): MxResolver {
  return async (domain) => {
    try {
      const r = await fetchFn(`${endpoint}?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: "application/dns-json" } });
      if (!r.ok) return { status: "error", detail: `HTTP ${r.status}` };
      const j: any = await r.json();
      if (j?.Status === 3) return { status: "none" };
      if (j?.Status !== 0) return { status: "error", detail: `DNS status ${j?.Status}` };
      const hosts = (Array.isArray(j.Answer) ? j.Answer : []).filter((a: any) => a?.type === 15).map((a: any) => String(a.data ?? "").split(/\s+/).pop()!.replace(/\.$/, "")).filter((h: string) => h && h !== ".");
      return hosts.length ? { status: "ok", hosts } : { status: "none" };
    } catch (e) {
      return { status: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
export const ROLE_LOCALS = new Set(["info", "admin", "administrator", "support", "sales", "contact", "contactus", "hello", "hi", "team", "office", "hr",
  "careers", "career", "jobs", "job", "recruiting", "recruitment", "recruiter", "talent", "hiring", "help", "marketing", "press", "media", "pr", "billing",
  "accounts", "finance", "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster", "abuse", "webmaster", "hostmaster", "enquiries", "inquiries",
  "ir", "investor", "investors", "investorrelations", "legal", "compliance", "privacy", "security", "service", "customerservice", "feedback", "events", "general"]);
// NETWORKING SCENARIOS (2026-10-29): a role inbox is more than the bare words above: "careers.us@", "recruiting-team@",
// "talent-acquisition@", "university.recruiting@", "jobs+eng@" and "talentacquisition@" are inboxes too, never a person's
// address. One is when the local part (a +tag dropped) is an inbox word, or splits wholly into inbox words and their
// qualifiers (a region, a team, campus/university) with at least one inbox word among them. A person's own address
// ("hi.nguyen@", "pressley@", "jobson@", "info.li@") is not: one part is a name.
// The same rule as the database's career_email_is_role (20261029160000): keep the two in step (the flow test compares them).
const ROLE_CORE = new Set([...ROLE_LOCALS, "people", "recruit", "staffing"]);
const ROLE_QUALIFIERS = new Set(["acquisition", "us", "uk", "eu", "emea", "apac", "latam", "na", "global", "university", "campus", "college", "grad",
  "graduate", "graduates", "early", "intern", "interns", "internships", "internship", "ops", "operations", "employment",
  "resumes", "resume", "cv", "apply", "applications", "application", "eng", "engineering", "tech", "notifications", "notification", "mail", "desk",
  "hq", "relations", "partnerships", "partners", "programs", "program", "student", "students", "new", "newgrad", "dept", "department", "center"]);
// A part run together from inbox words ("talentacquisition", "campusrecruiting"): only words of 3+ letters join that way,
// so a name like "hina" (hi + na) is never read as one.
const longest = (xs: Iterable<string>) => [...xs].filter((w) => w.length >= 3 && /^[a-z]+$/.test(w)).sort((a, b) => b.length - a.length).join("|");
const ROLE_RUN = new RegExp(`^(?:${longest([...ROLE_CORE, ...ROLE_QUALIFIERS])})+$`);
const ROLE_CORE_IN = new RegExp(`(?:${longest(ROLE_CORE)})`);
export function isRoleAddress(email: unknown): boolean {
  const local = String(email ?? "").trim().toLowerCase().split("@")[0].replace(/\+.*$/, "");
  if (!local) return false;
  const bare = local.replace(/[._-]+/g, "");
  if (ROLE_CORE.has(local) || ROLE_CORE.has(bare)) return true;
  let core = false;
  for (const part of local.split(/[._-]+/)) {
    if (!part || /^\d+$/.test(part)) continue;
    if (ROLE_CORE.has(part)) { core = true; continue; }
    if (ROLE_QUALIFIERS.has(part)) continue;
    if (!ROLE_RUN.test(part)) return false;
    if (ROLE_CORE_IN.test(part)) core = true;
  }
  return core;
}
// A "person" whose name is a team or inbox ("Talent Acquisition", "Careers Team", "Recruiting", "Press Office"): every word
// is an inbox word, so it is a team, never someone to write to (and never given an address in a person's format).
export const isTeamName = (name: unknown): boolean => {
  const w = String(name ?? "").toLowerCase().replace(/[^a-z\s-]/g, " ").trim().split(/[\s-]+/).filter(Boolean);
  return w.length > 0 && w.length <= 4 && isRoleAddress(`${w.join(".")}@x.io`);
};
export const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "10minutemail.net",
  "yopmail.com", "yopmail.net", "temp-mail.org", "tempmail.com", "tempmailo.com", "trashmail.com", "trashmail.de", "getnada.com", "nada.email",
  "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com",
  "spamgourmet.com", "mytemp.email", "tempinbox.com", "burnermail.io", "33mail.com", "moakt.com", "inboxkitten.com", "getairmail.com"]);
export const CHECK_WORDS: Record<string, string> = { syntax: "syntax", mx: "mail server (MX)", role: "not a role inbox", disposable: "not a throwaway domain", hunter: "Hunter verifier" };

// What ran decides "verified": syntax always; role and disposable read the address itself, so they ran when it parsed; MX
// only when the resolver answered; Hunter only when it returned a status. A check that did not run is never in `ran`, so
// never in a label, and never makes an address verified.
function verdict(c: Checks): boolean {
  return c.syntax === "pass" && c.mx !== "fail" && c.role === "pass" && c.disposable === "pass" && (c.hunter === undefined || c.hunter === "valid");
}
export async function checkAddress(email: string | null, mx: MxResolver, cache = new Map<string, Promise<MxResult>>()): Promise<{ check: Checks; verified: boolean }> {
  const e = String(email ?? "").trim().toLowerCase();
  const syntax = EMAIL.test(e) && !e.includes("..") && !/^\.|\.@/.test(e) ? "pass" : "fail";
  const [local = "", domain = ""] = e.split("@");
  const role = syntax === "pass" && (ROLE_LOCALS.has(local) || ROLE_LOCALS.has(local.replace(/[._+-]/g, "")) || isRoleAddress(e)) ? "flagged" : "pass";
  const disposable = syntax === "pass" && DISPOSABLE.has(domain) ? "flagged" : "pass";
  let mxState: Checks["mx"] = "not_run";
  if (syntax === "pass") {
    if (!cache.has(domain)) cache.set(domain, mx(domain).catch((x) => ({ status: "error", detail: String(x) }) as MxResult));
    const r = await cache.get(domain)!;
    mxState = r.status === "ok" ? "pass" : r.status === "none" ? "fail" : "not_run";
  }
  const ran = ["syntax", ...(syntax === "pass" ? ["role", "disposable"] : []), ...(mxState !== "not_run" ? ["mx"] : [])];
  const check: Checks = { syntax, mx: mxState, role, disposable, ran };
  return { check, verified: verdict(check) };
}
export async function verifyRows(rows: ContactRow[], mx: MxResolver): Promise<ContactRow[]> {
  const cache = new Map<string, Promise<MxResult>>();
  const out: ContactRow[] = [];
  for (const r of rows) {
    if (!r.email) { out.push({ ...r, check: undefined, verified: false }); continue; }
    const { check, verified } = await checkAddress(r.email, mx, cache);
    out.push({ ...r, check, verified });
  }
  return out;
}
// Passed the free pass: worth a Hunter credit.
export const freePassed = (r: ContactRow) => !!r.email && !!r.check && r.check.syntax === "pass" && r.check.mx !== "fail" && r.check.role === "pass" && r.check.disposable === "pass";

// ------------------------------------------------------------------------------------------------ Hunter, the paid check
// GET https://api.hunter.io/v2/email-verifier?email=...&api_key=... answers { data: { status, score, ... } }; 202 means the
// check is still running (asked again on a later pass, never cached); 401 is a key Hunter refused; 429 a rate limit.
// Published limits for the endpoint: 10 requests a second, 300 a minute; this stays at 4 a second.
export interface HunterResult { status: HunterStatus; score: number | null }
export interface CheckCache { get(key: string): Promise<HunterResult | null>; set(key: string, v: HunterResult, at: number): Promise<void> }
export type VerifyOutcome = { status: "ok"; result: HunterResult; cached: boolean } | { status: "NOT_WIRED"; reason: string } | { status: "RATE_LIMITED"; retry_after_ms: number } | { status: "PENDING" } | { status: "ERROR"; detail: string };
export interface Verifier { name: string; verify(email: string): Promise<VerifyOutcome> }
export const HUNTER_STATUSES: HunterStatus[] = ["valid", "invalid", "accept_all", "webmail", "disposable", "unknown"];
export const mapHunter = (s: unknown): HunterStatus => (HUNTER_STATUSES as string[]).includes(String(s)) ? String(s) as HunterStatus : "unknown";
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
// Cached per address per billing month (a calendar month: ASSUMED to match the plan's cycle; a new month checks again).
export const cacheKey = async (email: string, now: number) => `${new Date(now).toISOString().slice(0, 7)}:${await sha256(email.trim().toLowerCase())}`;
export const HUNTER_NOT_WIRED: Verifier = { name: "hunter", async verify() { return { status: "NOT_WIRED", reason: "HUNTER_API_KEY is not set" }; } };

export function hunterVerifier(o: { fetch: typeof fetch; apiKey?: string | null; cache: CheckCache; now: () => number; sleep?: (ms: number) => Promise<void>; gapMs?: number }): Verifier {
  if (!o.apiKey) return HUNTER_NOT_WIRED;
  const sleep = o.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  const gap = o.gapMs ?? 250;
  let last = 0;
  return {
    name: "hunter",
    async verify(email) {
      const key = await cacheKey(email, o.now());
      const hit = await o.cache.get(key).catch(() => null);
      if (hit) return { status: "ok", result: hit, cached: true };
      for (let attempt = 0; ; attempt++) {
        const wait = last + gap - o.now();
        if (wait > 0) await sleep(wait);
        last = o.now();
        let r: Response;
        try { r = await o.fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(o.apiKey!)}`); }
        catch (e) { return { status: "ERROR", detail: e instanceof Error ? e.message : String(e) }; }
        if (r.status === 429) {
          const after = Math.min(Math.max(Number(r.headers.get("retry-after")) * 1000 || 2000, 500), 10000);
          if (attempt >= 1) return { status: "RATE_LIMITED", retry_after_ms: after };
          await sleep(after);
          continue;
        }
        if (r.status === 401 || r.status === 403) return { status: "NOT_WIRED", reason: `Hunter refused the key (HTTP ${r.status})` };
        if (r.status === 202) return { status: "PENDING" };
        if (!r.ok) return { status: "ERROR", detail: `Hunter: HTTP ${r.status}` };
        const j: any = await r.json().catch(() => ({}));
        const result: HunterResult = { status: mapHunter(j?.data?.status), score: Number.isFinite(Number(j?.data?.score)) ? Number(j.data.score) : null };
        await o.cache.set(key, result, o.now()).catch(() => {});
        return { status: "ok", result, cached: false };
      }
    },
  };
}
export function memoryCheckCache(): CheckCache & { size(): number } {
  const m = new Map<string, HunterResult>();
  return { async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, { ...v }); }, size: () => m.size };
}
export function supabaseCheckCache(admin: any): CheckCache {
  return {
    async get(k) {
      const r = await admin.from("career_email_checks").select("status,score").eq("key", k).maybeSingle();
      if (r.error) throw new Error(`read a cached check: ${r.error.message}`);
      return r.data ? { status: mapHunter(r.data.status), score: r.data.score ?? null } : null;
    },
    async set(k, v, at) {
      const r = await admin.from("career_email_checks").upsert({ key: k, status: v.status, score: v.score, checked_at: new Date(at).toISOString() }, { onConflict: "key" });
      if (r.error) throw new Error(`cache a check: ${r.error.message}`);
    },
  };
}

// Hunter over the rows that passed the free pass and have no Hunter status yet, at most `max` a call (a chat turn's
// worth). Stops at the first NOT_WIRED or rate limit and says so; what was checked stays checked.
export async function hunterPass(rows: ContactRow[], v: Verifier, o: { max?: number } = {}): Promise<{ rows: ContactRow[]; checked: number; cached: number; left: number; stopped: string | null }> {
  const out = rows.map((r) => ({ ...r, check: r.check ? { ...r.check, ran: [...r.check.ran] } : undefined }));
  let checked = 0, cached = 0, stopped: string | null = null;
  const todo = out.filter((r) => freePassed(r) && r.check!.hunter === undefined);
  for (const r of todo.slice(0, o.max ?? 100)) {
    const x = await v.verify(r.email!);
    if (x.status === "NOT_WIRED") { stopped = `Hunter is not connected (${x.reason})`; break; }
    if (x.status === "RATE_LIMITED") { stopped = "Hunter's rate limit; the rest go on the next pass"; break; }
    if (x.status !== "ok") continue; // pending or an error: not checked, asked again next time
    r.check!.hunter = x.result.status;
    r.check!.hunter_score = x.result.score;
    r.check!.ran.push("hunter");
    r.verified = verdict(r.check!);
    checked++; if (x.cached) cached++;
  }
  return { rows: out, checked, cached, left: out.filter((r) => freePassed(r) && r.check!.hunter === undefined).length, stopped };
}

// ------------------------------------------------------------------------------------------------ the report
export interface ListReport {
  total: number; with_email: number; verified: number; deliverable_share: number | null;
  checked: string; not_checked: string[]; label: string; cost_usd: number | null; never: string;
  hunter: { checked: number; valid: number; accept_all: number; webmail: number; invalid: number; disposable: number; unknown: number; deliverable_share: number | null; target_85: "met" | "not met" | "not run" };
  vendor_claims: Record<string, number>;
  by_firm: { firm: string; contacts: number; verified: number }[];
}
// What the list is worth, said exactly: the share passing, labeled with what was checked on how many, and what never is.
// The 85% target is computed only over Hunter-checked addresses, and only Hunter's "valid" counts.
export function listReport(rows: ContactRow[], cost_usd: number | null = 0): ListReport {
  const mailed = rows.filter((r) => r.email && r.check);
  const verified = mailed.filter((r) => r.verified).length;
  const ranOn = (k: string) => mailed.filter((r) => r.check!.ran.includes(k)).length;
  const parts: string[] = [], notChecked: string[] = [];
  for (const k of ["syntax", "mx", "role", "disposable", "hunter"]) {
    const n = ranOn(k);
    if (!mailed.length) continue;
    if (n === mailed.length) parts.push(CHECK_WORDS[k]);
    else if (n > 0) parts.push(`${CHECK_WORDS[k]} on ${n} of ${mailed.length}`);
    else notChecked.push(k === "mx" ? "mail server (MX): the lookup isn't available here" : k === "hunter" ? "Hunter verifier: not run on these" : CHECK_WORDS[k]);
  }
  const hc = mailed.filter((r) => r.check!.hunter !== undefined);
  const count = (s: HunterStatus) => hc.filter((r) => r.check!.hunter === s).length;
  const hShare = hc.length ? Math.round((count("valid") / hc.length) * 1000) / 10 : null;
  const hunter = {
    checked: hc.length, valid: count("valid"), accept_all: count("accept_all"), webmail: count("webmail"), invalid: count("invalid"), disposable: count("disposable"), unknown: count("unknown"),
    deliverable_share: hShare, target_85: (hShare === null ? "not run" : hShare >= 85 ? "met" : "not met") as "met" | "not met" | "not run",
  };
  const share = mailed.length ? Math.round((verified / mailed.length) * 1000) / 10 : null;
  const checked = parts.join(", ");
  const hLine = hc.length ? ` Hunter: ${hunter.valid} of ${hc.length} checked are valid (${hShare}%; the 85% target is ${hunter.target_85}); ${hunter.accept_all} accept-all and ${hunter.webmail} webmail, not counted as deliverable.` : "";
  const label = !mailed.length
    ? `No addresses to check: ${rows.length} contact${rows.length === 1 ? "" : "s"}, none with an email.`
    : `${verified} of ${mailed.length} addresses passed every check that ran (${share}%). Checked: ${checked}. Not checked: ${notChecked.length ? notChecked.join("; ") : "nothing else"}.${hLine}`;
  const vendor_claims: Record<string, number> = {};
  for (const r of rows) if (r.vendor_email_status) vendor_claims[r.vendor_email_status] = (vendor_claims[r.vendor_email_status] ?? 0) + 1;
  const firms = new Map<string, { firm: string; contacts: number; verified: number }>();
  for (const r of rows) {
    const f = r.firm || "(no company)";
    const x = firms.get(f) ?? { firm: f, contacts: 0, verified: 0 };
    x.contacts++; if (r.verified) x.verified++;
    firms.set(f, x);
  }
  return {
    total: rows.length, with_email: mailed.length, verified, deliverable_share: share, checked, not_checked: notChecked, label,
    cost_usd: cost_usd === null ? null : Math.round(cost_usd * 100) / 100, never: NO_SMTP_PROBE, hunter, vendor_claims,
    by_firm: [...firms.values()].sort((a, b) => b.contacts - a.contacts).slice(0, 25),
  };
}

// A file the person attached: imported and given the free pass by code before the model runs (a 2,000-row export never
// goes through the model). Rows from the same file replace that file's earlier rows; the state keeps at most MAX_CONTACTS.
// Hunter runs later, on the person's word (verify_contacts), because it spends credits and takes time.
export async function importContactsFile(state: Record<string, unknown>, file: { name: string; text: string | null }, mx: MxResolver): Promise<{ ok: boolean; note: string; report?: ListReport }> {
  if (file.text === null) return { ok: false, note: `${file.name}: this file type can't be read yet` };
  const src = await csvSource(file.name, file.text).fetch();
  if (src.status !== "ok" || !src.rows.length) return { ok: false, note: `${file.name}: no contacts found (it needs a header row with a name column and a company or email column)` };
  const checked = await verifyRows(src.rows, mx);
  const kept = contactsOf(state).filter((r) => r.file !== file.name);
  state.contacts = [...kept, ...checked].slice(-MAX_CONTACTS);
  const report = listReport(checked, src.vendor ? null : 0);
  const cost = src.vendor ? `Source: an ${src.vendor === "apollo" ? "Apollo" : src.vendor} export; its cost is whatever its plan charged, which the owner can record.` : "Cost: $0 (your own export).";
  return { ok: true, report, note: `${file.name}: imported ${checked.length} contacts (${src.duplicates} duplicate${src.duplicates === 1 ? "" : "s"} left out, ${checked.filter((r) => r.email).length} with an email). ${report.label} ${cost}` };
}
export const contactsOf = (state: Record<string, unknown>): ContactRow[] => (Array.isArray(state.contacts) ? (state.contacts as ContactRow[]).filter((r) => r && typeof r.row === "number" && typeof r.file === "string") : []);
