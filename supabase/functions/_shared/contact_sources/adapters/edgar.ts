// SEC EDGAR public insider data: officers and directors named on Forms 3/4/5 (public filings on sec.gov). Name, role, issuer only.
// Never an email (EDGAR has none for individuals) and never the filer's mailing address (it can be a home address).
// Access follows SEC's fair-access policy: a User-Agent that names the requester and a contact email, and well under 10 requests/second
// (we pace at 150 ms or more through WebGate). Tests use fixtures; nothing here fetches unless a WebGate is passed in.
import type { Candidate, Provenance } from "../types.ts";
import { cleanName } from "../types.ts";
import { SiteRule, WebGate } from "../web_gate.ts";

export const SEC_LICENSE = "SEC EDGAR public filings (sec.gov). Public record; reuse is subject to sec.gov Privacy & Security / Accessing EDGAR Data policy (declared User-Agent, <10 requests/second). Names and roles only.";
export const secRules = (reviewedOn: string, reviewedBy: string): SiteRule[] => ["www.sec.gov", "data.sec.gov"].map((host) => ({
  host, org_name: "U.S. Securities and Exchange Commission", terms_url: "https://www.sec.gov/about/privacy-information#security",
  terms_reviewed_on: reviewedOn, terms_reviewed_by: reviewedBy,
  terms_summary: "Automated access allowed with a declared User-Agent and under 10 requests/second; filings are public records.",
  license_note: SEC_LICENSE, min_delay_ms: 150, path_prefixes: host === "data.sec.gov" ? ["/submissions/"] : ["/Archives/edgar/data/"],
}));
// SEC requires "Company/Name contact@email" in the User-Agent. Anything else is refused up front.
export function validSecUserAgent(ua: string): boolean { return /\S+\s+[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua) && !/example\.(com|org)|test@|noreply/i.test(ua); }

const tag = (xml: string, name: string, from = 0): string | null => { const m = xml.slice(from).match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null; };
const titleCase = (s: string) => s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, a, b) => a + b.toUpperCase()) : s;
// EDGAR writes owners "LAST FIRST MIDDLE" (or "Last, First"). Return "First Middle Last".
export function secOwnerName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s.includes(",")) { const [l, f] = s.split(",", 2); return cleanName(titleCase(`${f.trim()} ${l.trim()}`)); }
  const p = s.split(" "); if (p.length < 2) return cleanName(titleCase(s));
  return cleanName(titleCase([...p.slice(1), p[0]].join(" ")));
}
export function form4Candidates(xml: string, sourceUrl: string, retrievedAt: string): Candidate[] {
  const issuer = tag(xml, "issuerName"); const out: Candidate[] = [];
  const prov: Provenance = { source_kind: "sec_edgar", source_url: sourceUrl, retrieved_at: retrievedAt, license_note: SEC_LICENSE };
  const owners = xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/g) ?? [];
  for (const o of owners) {
    const nm = tag(o, "rptOwnerName"); if (!nm) continue;
    const isOfficer = /^(1|true)$/i.test(tag(o, "isOfficer") ?? ""), isDirector = /^(1|true)$/i.test(tag(o, "isDirector") ?? "");
    const officerTitle = tag(o, "officerTitle"), other = tag(o, "otherText");
    const role = isOfficer && officerTitle ? officerTitle : isDirector ? "Director" : (other ?? (isOfficer ? "Officer" : null));
    out.push({ full_name: secOwnerName(nm), role_title: role, firm: issuer, provenance: { ...prov } });
  }
  return out;
}
// Reduce a submissions-JSON "primaryDocument" like "xslF345X05/wk-form4_1.xml" to the raw XML file name.
export const rawXmlName = (doc: string) => doc.replace(/^xsl[^/]*\//i, "");
export function recentInsiderFilings(subsJson: string, max = 10): Array<{ cik: string; accession: string; doc: string }> {
  let j: any; try { j = JSON.parse(subsJson); } catch { return []; }
  const r = j?.filings?.recent; const cik = String(Number(j?.cik ?? 0)); if (!r?.form || !cik || cik === "0") return [];
  const out: Array<{ cik: string; accession: string; doc: string }> = [];
  for (let i = 0; i < r.form.length && out.length < max; i++) if (["3", "4", "5"].includes(String(r.form[i])) && /\.xml$/i.test(r.primaryDocument?.[i] ?? "")) out.push({ cik, accession: String(r.accessionNumber[i]).replace(/-/g, ""), doc: rawXmlName(r.primaryDocument[i]) });
  return out;
}
export async function edgarInsiders(o: { gate: WebGate; cik: string | number; max?: number; userAgent?: string }): Promise<{ candidates: Candidate[]; denied: Array<{ url: string; reason: string }> }> {
  const candidates: Candidate[] = [], denied: Array<{ url: string; reason: string }> = [];
  // The User-Agent that is validated is the one the gate actually sends.
  if (!validSecUserAgent(o.gate.userAgent)) throw new Error("SEC requires a User-Agent that names the requester and a real contact email");
  if (o.userAgent !== undefined && o.userAgent !== o.gate.userAgent) throw new Error("userAgent differs from the gate's User-Agent: the gate's is what is sent");
  const cik10 = String(o.cik).replace(/\D/g, "").padStart(10, "0");
  const subsUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const subs = await o.gate.fetchText(subsUrl); if (!subs.ok) return { candidates, denied: [{ url: subsUrl, reason: subs.reason }] };
  for (const f of recentInsiderFilings(subs.text, o.max ?? 10)) {
    const url = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accession}/${f.doc}`;
    const r = await o.gate.fetchText(url); if (!r.ok) { denied.push({ url, reason: r.reason }); continue; }
    candidates.push(...form4Candidates(r.text, url, r.retrieved_at));
  }
  return { candidates, denied };
}
