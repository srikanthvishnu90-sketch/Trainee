// CONTACT DATA SOURCES: the normalized Contact, provenance, dedupe and the one import function the networking
// builder calls. Interface only: nothing in this module touches outreach or draft code. See docs/launch/CONTACT-DATA-LEGAL.md.
//
// Hard rules enforced here (tests/edge/contact-sources.test.ts proves each):
//   - every Contact carries at least one Provenance: source_url + retrieved_at + license_note (no provenance, no contact);
//   - an email exists only with a named basis: published on the source page, supplied by the user, or returned by a licensed
//     verifier provider. There is no code in this module that builds an address from a name and a domain;
//   - a person on the suppression list is never imported again.

export type RoleFamily = "finance" | "tech" | "healthcare" | "law" | "education" | "trades" | "other";
export type SourceKind = "user_csv" | "pasted" | "sec_edgar" | "team_page" | "university_directory" | "conference_speakers" | "licensed_provider";
export type EmailBasis = "published_on_source" | "user_supplied" | "licensed_verifier";

export const SOURCE_KINDS: SourceKind[] = ["user_csv", "pasted", "sec_edgar", "team_page", "university_directory", "conference_speakers", "licensed_provider"];
export const EMAIL_BASES: EmailBasis[] = ["published_on_source", "user_supplied", "licensed_verifier"];
export const ROLE_FAMILIES: RoleFamily[] = ["finance", "tech", "healthcare", "law", "education", "trades", "other"];

export interface Provenance {
  source_kind: SourceKind;
  source_url: string;      // https URL of the page/API, or user-upload://<file> / user-paste://<id> for the user's own data
  retrieved_at: string;    // ISO 8601
  license_note: string;    // the terms/licence this record was taken under, in a sentence
}

export interface Contact {
  id: string;                       // stable: hash of the dedupe key
  full_name: string;
  role_title: string | null;
  role_family: RoleFamily;
  firm: string | null;
  location: string | null;
  education: string[];              // schools/degrees as the source states them
  shared_connections: string[];     // names of people both the user and this contact know, ONLY when the user's own data says so
  email: string | null;
  email_basis: EmailBasis | null;   // non-null iff email is non-null
  email_detail: string | null;      // e.g. "valid (Hunter, 2026-10-30)"; the verifier's own words, never ours
  provenance: Provenance[];         // never empty
}

// What an adapter hands over. Same shape without the derived fields; provenance is exactly one entry.
export interface Candidate {
  full_name: string;
  role_title?: string | null;
  role_family?: RoleFamily;
  firm?: string | null;
  location?: string | null;
  education?: string[];
  shared_connections?: string[];
  email?: string | null;
  email_basis?: EmailBasis | null;
  email_detail?: string | null;
  provenance: Provenance;
}

export interface ContactSourceAdapter {
  kind: SourceKind;
  run(): Promise<Candidate[]> | Candidate[];
}

export type RejectReason =
  | "suppressed" | "no_name" | "bad_name" | "no_provenance" | "bad_provenance" | "email_without_basis" | "bad_email" | "bad_email_basis" | "profile_url_source_blocked";
export interface Rejected { reason: RejectReason; name: string; detail?: string }

// An email basis must fit where the record came from: a page can only publish; a user can only supply; only a licensed
// provider can verify; EDGAR carries no email at all.
export const BASIS_BY_KIND: Record<SourceKind, EmailBasis[]> = {
  user_csv: ["user_supplied"], pasted: ["user_supplied"], sec_edgar: [], team_page: ["published_on_source"], university_directory: ["published_on_source"],
  conference_speakers: ["published_on_source"], licensed_provider: ["licensed_verifier"],
};
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
export function cleanEmail(v: unknown): string | null {
  const e = String(v ?? "").trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  return e.length <= 254 && EMAIL_RE.test(e) && !e.includes("..") ? e : null;
}

const TITLES = /^(dr|prof|professor|mr|mrs|ms|mx|sir|hon|rev)\.?$/i;
const SUFFIXES = /^(jr|sr|ii|iii|iv|phd|md|do|esq|cpa|cfa|mba|rn|pe|dds|dvm)\.?,?$/i;
export function cleanName(v: unknown): string {
  let s = String(v ?? "").replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const parts = s.split(" ").filter((p) => p && !TITLES.test(p));
  while (parts.length > 1 && SUFFIXES.test(parts[parts.length - 1])) parts.pop();
  return parts.join(" ").replace(/,$/, "").slice(0, 120);
}
export const normKey = (v: unknown): string =>
  String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|llp|lp|ltd|corp|corporation|co|company|plc|the)\b/g, " ").replace(/\s+/g, " ").trim();
export const nameKey = (v: unknown): string => normKey(cleanName(v));

const FAMILY_WORDS: Array<[RoleFamily, RegExp]> = [
  ["law", /\b(attorney|lawyer|counsel|partner.*(llp|law)|paralegal|judge|solicitor|barrister|general counsel|law)\b/i],
  ["education", /\b(professor|lecturer|faculty|teacher|dean|provost|principal|instructor|school|university|college|curriculum|academic)\b/i],
  ["finance", /\b(cfo|chief financial|banker|banking|analyst|portfolio|trader|investment|private equity|venture|hedge|asset management|treasurer|controller|accountant|audit|underwrit|wealth|fund)\w*/i],
  ["healthcare", /\b(physician|nurse|rn|md|surgeon|clinician|pharmacist|therapist|dentist|medical|clinical|health|hospital|patient|radiolog|cardiolog|oncolog)\w*/i],
  ["tech", /\b(software|engineer|developer|cto|chief technology|data scientist|machine learning|devops|product manager|cloud|security engineer|cio|architect|it director|technology)\b/i],
  ["trades", /\b(electrician|plumber|hvac|carpenter|welder|mechanic|contractor|foreman|machinist|journeyman|apprentice|roofer|technician|union local)\b/i],
];
const FIRM_WORDS: Array<[RoleFamily, RegExp]> = [
  ["law", /\b(law|legal|llp|attorneys)\b/i],
  ["finance", /\b(capital|bank|banking|securities|asset management|equity|financial|advisors|investments?|holdings fund|partners lp)\b/i],
  ["healthcare", /\b(hospital|medical|health|clinic|pharma)\w*/i],
  ["education", /\b(university|college|school)\b/i],
  ["trades", /\b(ibew|local \d+|union|plumbing|electric|hvac)\b/i],
];

export function classifyRoleFamily(title?: string | null, firm?: string | null, hint?: RoleFamily): RoleFamily {
  for (const [fam, re] of FAMILY_WORDS) if (re.test(title ?? "")) return fam;
  if (hint) return hint;
  for (const [fam, re] of FIRM_WORDS) if (re.test(firm ?? "")) return fam;
  return "other";
}

export function dedupeKey(c: { full_name: string; firm?: string | null; email?: string | null }): string {
  return c.email ? `e:${c.email}` : `n:${nameKey(c.full_name)}|${normKey(c.firm)}`;
}
function fnv(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
export const contactId = (c: { full_name: string; firm?: string | null }): string => `ct_${fnv(`n:${nameKey(c.full_name)}|${normKey(c.firm)}`)}${fnv(`${normKey(c.firm)}~${nameKey(c.full_name)}`)}`;

const BLOCKED_SOURCE_HOSTS = ["linkedin.com", "indeed.com", "joinhandshake.com", "glassdoor.com", "ziprecruiter.com"];
export const isBlockedHost = (host: string): boolean => { const h = host.toLowerCase().replace(/\.$/, ""); return BLOCKED_SOURCE_HOSTS.some((b) => h === b || h.endsWith("." + b)); };

export function validProvenance(p: Provenance | undefined | null): string | null {
  if (!p) return "missing";
  if (!SOURCE_KINDS.includes(p.source_kind)) return "unknown source_kind";
  if (!p.source_url || !p.retrieved_at || !p.license_note || !String(p.license_note).trim()) return "source_url, retrieved_at and license_note are all required";
  if (Number.isNaN(Date.parse(p.retrieved_at))) return "retrieved_at is not a date";
  if (/^user-(upload|paste):\/\/.+/.test(p.source_url)) return p.source_kind === "user_csv" || p.source_kind === "pasted" ? null : "user-data URL on a non-user source";
  let u: URL; try { u = new URL(p.source_url); } catch { return "source_url is not a URL"; }
  if (u.protocol !== "https:") return "source_url must be https";
  if (isBlockedHost(u.hostname)) return "source_url is on a blocked site";
  if (p.source_kind === "user_csv" || p.source_kind === "pasted") return "user sources must use user-upload:// or user-paste://";
  return null;
}

// Build one Contact from one Candidate, or say why not. Pure.
export function toContact(c: Candidate): { contact: Contact } | { rejected: Rejected } {
  const name = cleanName(c.full_name);
  const rej = (reason: RejectReason, detail?: string) => ({ rejected: { reason, name, detail } as Rejected });
  if (!name) return rej("no_name");
  if (name.split(" ").length < 2 || /\d|@|https?:/i.test(name)) return rej("bad_name");
  const pv = validProvenance(c.provenance);
  if (pv) return rej(c.provenance ? "bad_provenance" : "no_provenance", pv);
  let email: string | null = null, basis: EmailBasis | null = null;
  if (c.email != null && String(c.email).trim() !== "") {
    email = cleanEmail(c.email);
    if (!email) return rej("bad_email");
    if (!c.email_basis) return rej("email_without_basis");
    if (!EMAIL_BASES.includes(c.email_basis)) return rej("bad_email_basis", String(c.email_basis));
    const allowed = BASIS_BY_KIND[c.provenance.source_kind] ?? [];
    if (!allowed.includes(c.email_basis)) return rej("bad_email_basis", `${c.email_basis} is not allowed for ${c.provenance.source_kind}`);
    basis = c.email_basis;
  } else if (c.email_basis) return rej("email_without_basis", "basis without an address");
  const firm = c.firm ? String(c.firm).replace(/\s+/g, " ").trim().slice(0, 160) || null : null;
  const role = c.role_title ? String(c.role_title).replace(/\s+/g, " ").trim().slice(0, 160) || null : null;
  const list = (a?: string[]) => [...new Set((a ?? []).map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 160)).filter(Boolean))];
  return { contact: {
    id: contactId({ full_name: name, firm }), full_name: name, role_title: role,
    role_family: c.role_family ?? classifyRoleFamily(role, firm),
    firm, location: c.location ? String(c.location).replace(/\s+/g, " ").trim().slice(0, 120) || null : null,
    education: list(c.education), shared_connections: list(c.shared_connections),
    email, email_basis: basis, email_detail: email ? (c.email_detail ?? null) : null,
    provenance: [{ ...c.provenance }],
  } };
}

const TRUST: Record<EmailBasis, number> = { licensed_verifier: 3, published_on_source: 2, user_supplied: 1 };
export function mergeContacts(a: Contact, b: Contact): Contact {
  const pick = <T>(x: T | null, y: T | null) => x ?? y;
  const useB = b.email && (!a.email || TRUST[b.email_basis!] > TRUST[a.email_basis!]);
  const seen = new Set<string>();
  const provenance = [...a.provenance, ...b.provenance].filter((p) => { const k = `${p.source_kind}|${p.source_url}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const e = useB ? b : a;
  return { ...a,
    role_title: pick(a.role_title, b.role_title), firm: pick(a.firm, b.firm), location: pick(a.location, b.location),
    role_family: a.role_family === "other" ? b.role_family : a.role_family,
    education: [...new Set([...a.education, ...b.education])], shared_connections: [...new Set([...a.shared_connections, ...b.shared_connections])],
    email: e.email, email_basis: e.email_basis, email_detail: e.email_detail, provenance };
}

// Dedupe a list: by email first, then by normalized name + firm. A name-only record with no firm joins a same-name record
// only when exactly one such record exists (two "Alex Kim"s at different firms are different people).
export function dedupe(list: Contact[]): Contact[] {
  const byEmail = new Map<string, Contact>(), byNF = new Map<string, Contact>(), out: Contact[] = [];
  for (const c of list) {
    const nf = `${nameKey(c.full_name)}|${normKey(c.firm)}`;
    let hit = (c.email && byEmail.get(c.email)) || byNF.get(nf);
    if (!hit && !c.firm) { const same = out.filter((o) => nameKey(o.full_name) === nameKey(c.full_name)); if (same.length === 1) hit = same[0]; }
    if (hit) {
      const m = mergeContacts(hit, c); out[out.indexOf(hit)] = m;
      if (m.email) byEmail.set(m.email, m); byNF.set(`${nameKey(m.full_name)}|${normKey(m.firm)}`, m); byNF.set(nf, m);
    } else { out.push(c); if (c.email) byEmail.set(c.email, c); byNF.set(nf, c); }
  }
  return out;
}

// ---- the interface the networking builder calls ----
import type { SuppressionList } from "./suppression.ts";
export interface ImportResult { contacts: Contact[]; rejected: Rejected[]; suppressed: number; merged: number }
export function importContacts(candidates: Candidate[], opts: { suppression?: SuppressionList; existing?: Contact[] } = {}): ImportResult {
  const rejected: Rejected[] = []; const fresh: Contact[] = []; let suppressed = 0;
  const sup = opts.suppression;
  for (const cand of candidates) {
    const r = toContact(cand);
    if ("rejected" in r) rejected.push(r.rejected); else fresh.push(r.contact);
  }
  // Merge first, then apply suppression: an opt-out by email must also catch the same person's name-only copy.
  const merged = dedupe([...(opts.existing ?? []), ...fresh]);
  const all = merged.filter((c) => { if (!sup?.matches(c)) return true; suppressed++; rejected.push({ reason: "suppressed", name: c.full_name }); return false; });
  return { contacts: all, rejected, suppressed, merged: (opts.existing?.length ?? 0) + fresh.length - merged.length };
}
export async function importFromAdapters(adapters: ContactSourceAdapter[], opts: { suppression?: SuppressionList; existing?: Contact[] } = {}): Promise<ImportResult> {
  const all: Candidate[] = []; for (const a of adapters) all.push(...await a.run());
  return importContacts(all, opts);
}

// Is this contact reachable by email, on what basis, and is the person suppressed? Outreach code asks this; it never builds an address.
export function emailEligibility(c: Contact, sup?: SuppressionList): { ok: boolean; reason: string } {
  if (sup?.matches(c)) return { ok: false, reason: "suppressed" };
  if (!c.email || !c.email_basis) return { ok: false, reason: "no_email_with_basis" };
  if (!c.provenance.length) return { ok: false, reason: "no_provenance" };
  return { ok: true, reason: c.email_basis };
}
