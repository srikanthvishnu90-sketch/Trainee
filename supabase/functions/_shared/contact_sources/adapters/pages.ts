// Page parsers for public "people" pages: a firm's team page, a university faculty/staff directory, a conference speaker page.
// Every fetch goes through WebGate (allowlist + robots + pace). Parsing is by class tokens on card elements, tested on fixtures.
// Email is taken only from a mailto: link or a visible address inside that person's own card. Never constructed.
import type { Candidate, Provenance, RoleFamily, SourceKind } from "../types.ts";
import { cleanEmail, cleanName, classifyRoleFamily } from "../types.ts";
import { GateDeny, WebGate } from "../web_gate.ts";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => { if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; } return ENT[e.toLowerCase()] ?? m; });
const text = (h: string) => decode(h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t\r\f]+/g, " ").replace(/ ?\n ?/g, "\n").trim();

export interface Preset {
  kind: SourceKind; cards: string[]; name: string[]; title: string[]; org: string[]; location: string[]; education: string[]; dept: string[];
  hint?: RoleFamily; firmFromRule: boolean;
}
export const PRESETS: Record<"team_page" | "university_directory" | "conference_speakers", Preset> = {
  team_page: { kind: "team_page", cards: ["team-member", "team-card", "person", "people-card", "profile-card", "bio-card", "staff-member"], name: ["name", "person-name", "member-name"], title: ["title", "role", "position", "job-title"], org: [], location: ["location", "office"], education: ["education", "degrees", "credentials"], dept: [], firmFromRule: true },
  university_directory: { kind: "university_directory", cards: ["faculty-member", "faculty-card", "staff-member", "directory-entry", "person", "profile-card"], name: ["name", "person-name", "faculty-name"], title: ["title", "position", "rank"], org: [], location: ["location", "office", "building"], education: ["education", "degrees", "alma-mater"], dept: ["department", "dept", "unit"], hint: "education", firmFromRule: true },
  conference_speakers: { kind: "conference_speakers", cards: ["speaker", "speaker-card", "speaker-item", "person"], name: ["name", "speaker-name"], title: ["title", "role", "position", "job-title"], org: ["company", "org", "organization", "affiliation", "employer"], location: ["location"], education: [], dept: [], firmFromRule: false },
};
const tokens = (attrs: string) => { const m = attrs.match(/class\s*=\s*"([^"]*)"|class\s*=\s*'([^']*)'/i); return (m?.[1] ?? m?.[2] ?? "").toLowerCase().split(/\s+/).filter(Boolean); };
function fieldText(seg: string, want: string[]): string | null {
  if (!want.length) return null;
  for (const m of seg.matchAll(/<(\w+)([^>]*)>/g)) {
    if (!tokens(m[2]).some((t) => want.includes(t))) continue;
    const from = m.index! + m[0].length, end = seg.toLowerCase().indexOf(`</${m[1].toLowerCase()}>`, from);
    const t = text(seg.slice(from, end < 0 ? undefined : end)); if (t) return t;
  }
  return null;
}
function cardEnd(html: string, from: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi"); re.lastIndex = from; let depth = 1, m: RegExpExecArray | null;
  while ((m = re.exec(html))) { depth += m[1] ? -1 : 1; if (depth === 0) return m.index; }
  return html.length;
}
export function parseCards(html: string, preset: Preset, pageUrl: string, retrievedAt: string, firm: string | null, licenseNote: string): Candidate[] {
  const starts: Array<{ at: number; tag: string; len: number }> = [];
  for (const m of html.matchAll(/<(div|li|article|section|tr)\b([^>]*)>/gi)) if (tokens(m[2]).some((t) => preset.cards.includes(t))) starts.push({ at: m.index!, tag: m[1].toLowerCase(), len: m[0].length });
  const prov: Provenance = { source_kind: preset.kind, source_url: pageUrl, retrieved_at: retrievedAt, license_note: licenseNote };
  const out: Candidate[] = [];
  starts.forEach((s, i) => {
    // The card is its own element, closed by its matching end tag (nesting counted), and never runs past the next card:
    // a footer mailto after the last card is not that person's.
    const limit = i + 1 < starts.length ? starts[i + 1].at : html.length;
    const seg = html.slice(s.at + s.len, Math.min(limit, cardEnd(html, s.at + s.len, s.tag)));
    const name = fieldText(seg, preset.name) ?? (seg.match(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/i) ? text(seg.match(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/i)![1]) : null);
    if (!name) return;
    let email: string | null = null;
    const mt = seg.match(/href\s*=\s*["']mailto:([^"'?]+)/i);
    if (mt) email = cleanEmail(decode(mt[1]));
    if (!email) { const v = text(seg).match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/); if (v) email = cleanEmail(v[0]); }
    const dept = fieldText(seg, preset.dept), title = fieldText(seg, preset.title);
    const org = fieldText(seg, preset.org);
    const edu = fieldText(seg, preset.education);
    const role = [title, dept].filter(Boolean).join(", ") || null;
    const f = preset.firmFromRule ? firm : (org ?? null);
    out.push({
      full_name: cleanName(name), role_title: role, firm: f, location: fieldText(seg, preset.location),
      education: edu ? edu.split(/[;\n]/).map((x) => x.trim()).filter(Boolean) : [],
      role_family: classifyRoleFamily(role, f, preset.hint),
      email, email_basis: email ? "published_on_source" : null, email_detail: email ? "address appears in this person's own card on the source page" : null,
      provenance: { ...prov },
    });
  });
  return out;
}
export async function pageContacts(gate: WebGate, url: string, kind: keyof typeof PRESETS): Promise<{ candidates: Candidate[]; denied: { url: string; reason: GateDeny } | null }> {
  const r = await gate.fetchText(url);
  if (!r.ok) return { candidates: [], denied: { url, reason: r.reason } };
  const note = `${r.rule.license_note} Terms read: ${r.rule.terms_url} (reviewed ${r.rule.terms_reviewed_on} by ${r.rule.terms_reviewed_by}).`;
  return { candidates: parseCards(r.text, PRESETS[kind], r.final_url, r.retrieved_at, r.rule.org_name, note), denied: null };
}
