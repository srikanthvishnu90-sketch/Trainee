// CONTACT OUTREACH (proposal D-042): which facts about a contact are kept. A fact is a professional claim with the public
// source it came from, the words there that support it (at most 200 characters), when it was read and published, how sure
// the source makes it, how it was found, and when it expires (90 days: re-read before it is used again).
// Kept only: professional facts. Never a home address, family (parents, children, a partner or spouse), health, religion or
// politics (parties, campaigns, votes), whatever the source says.
// Never an instruction: page and API text is data, so a claim or quote that reads as an instruction to whoever drafts
// ("ignore previous instructions", "note to AI assistants", "send this to ...") is dropped, never obeyed, never quoted.
import { readsAsInstruction } from "./career_people_import.ts";
import type { RawFact, SourceType } from "./career_contact_sources.ts";

export const FACT_MAX = 25, FACT_TTL_DAYS = 90, NEWS_MAX_MONTHS = 24, SNIPPET_MAX = 200;
export interface ContactFact {
  claim: string; source_url: string; source_type: SourceType; retrieved_at: string; published_at: string | null;
  quote_snippet: string; confidence: number; method: string; expires_at: string;
}
export type DropWhy = "private" | "instruction" | "no_source" | "stale" | "duplicate" | "over_cap";

const PRIVATE: [string, RegExp][] = [
  ["home address", /\b(?:lives? (?:at|in|on|with|nearby)|home address|resides? (?:at|in)|\d{1,5} [A-Z][a-z]+ (?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|blvd)\b)/i],
  // Parents and children, a partner or spouse. "Partner" alone is a job title (Partner at Sequoia, managing partner), so a
  // partner is private only as someone's: her partner, his life partner, a domestic partner. "Parent company" is a company.
  ["family", new RegExp([
    "\\b(?:husband|wife|wives|spouse|married|divorc\\w*|daughters?|sons?|stepsons?|stepdaughters?|children(?![\u2019']s\\s+(?:hospital|health|medical|national|research))|kids?|toddlers?|newborn|pregnan\\w*|bab(?:y|ies)",
    "fianc[e\u00e9]e?|boyfriend|girlfriend|widow\\w*|fathers?|mothers?|moms?|mums?|mommy|mummy|dads?|daddy|grand(?:child|children|kids?|son|daughter|parents?|ma|pa)",
    "maternity|paternity|parental leave|stay-at-home|homemaker|in-laws?|nephews?|nieces?|siblings?)\\b",
    "\\bparent(?:s|ing|hood)?\\b(?!\\s+(?:compan(?:y|ies)|org\\w*|firm|entity|corporation|group|brand))",
    "\\b(?:his|her|their|my|our|your)\\s+(?:(?:long-?time|life|domestic|romantic|same-sex)\\s+)?partner\\b(?!\\s+(?:at|in|of|on|with|for|program\\w*|compan\\w*|firm|network|ecosystem|integration\\w*|team\\w*|manager\\w*|success|engineer\\w*)\\b)",
    "\\b(?:life|domestic)\\s+partner\\b",
  ].join("|"), "i")],
  ["health", /\b(?:cancer|diagnos\w*|illness|disease|surgery|therapy|depression|anxiety|disabilit\w*|medical leave|hospitali[sz]ed|chemo\w*|mental health)\b/i],
  // Religion: places, clergy and practice. Professional names that share a word (Church & Dwight, Temple University, Parish
  // Medical Center) are set aside first (PROFESSIONAL_NAMES), never by loosening these words.
  ["religion", /\b(?:church(?:es)?|parish(?:es|ioners?)?|pastor\w*|priest\w*|rabbi\w*|imam\w*|clergy\w*|deacon\w*|vicar\w*|bishop\w*|nuns?|monks?|mosques?|temples?|synagogues?|gurdwaras?|chapels?|cathedrals?|diocese\w*|congregation\w*|sermons?|bible|scripture\w*|worship\w*|sabbath|ramadan|christian\w*|muslims?|islam\w*|jewish|judaism|hindu\w*|buddhis\w*|sikh\w*|catholic\w*|protestant\w*|evangelical\w*|baptist\w*|methodist\w*|lutheran\w*|mormon\w*|faith|religio\w*|pray\w*|spiritual\w*|atheis\w*)\b/i],
  // Politics: parties (by name and by abbreviation), campaigns for office, votes and donations.
  ["politics", /\b(?:democrat\w*|republican\w*|liberal|conservative|libertarian\w*|socialist\w*|progressive caucus|tea party|trump|biden|obama|maga|dnc|rnc|gop|dccc|nrcc|super ?pacs?|political action committees?|labour party|tor(?:y|ies)|green party|election\w*|re-?elect\w*|vot(?:e|ed|es|ing|ers?)|ballot\w*|canvass\w*|phone[- ]?bank\w*|campaign(?:s|ed|ing)? (?:for|of) (?:office|mayor|governor|senate|congress|president|city council|state)|(?:political|presidential|senate|senatorial|congressional|mayoral|gubernatorial|council|primary|reelection) campaigns?|ran for (?:office|mayor|governor|senate|congress|president|city council)|political\w*|partisan|caucus\w*|precinct\w*)\b/i],
];
// Professional names that share a word with a private topic: a company (Church & Dwight), a school (Temple University), an
// employer (Parish Medical Center). Each is matched whole and set aside before the private-topic check; nothing else is,
// so a private fact beside one of them is still dropped. keepFacts also sets aside the contact's own employer.
export const PROFESSIONAL_NAMES = ["Church & Dwight", "Church and Dwight", "Temple University", "Temple University Hospital", "Temple Health", "Parish Medical Center", "Bishop Fox", "Chapel Hill"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const withoutNames = (text: string, names: string[]) =>
  names.map((n) => n.replace(/\s+/g, " ").trim()).filter((n) => n.length >= 3).sort((a, b) => b.length - a.length)
    .reduce((t, n) => t.replace(new RegExp(`(?<![A-Za-z0-9])${escape(n).replace(/ /g, "\\s+")}(?![A-Za-z0-9])`, "gi"), " "), text);
export function privateTopic(text: string, employers: string[] = []): string | null {
  const t = withoutNames(text, [...PROFESSIONAL_NAMES, ...employers]);
  for (const [k, re] of PRIVATE) if (re.test(t)) return k;
  return null;
}
const ADDRESSED_TO_DRAFTER = /\b(?:ignore|disregard)\b|\b(?:ai|llm|assistant|model|chatgpt|claude|gpt)s?\b[^.]{0,30}\b(?:reading|writing|should|must|please)\b|\b(?:send|forward|bcc|cc|reply)\b[^.]{0,40}@|\[\/?inst\]|<\/?system>/i;
export const instructionLike = (text: string) => readsAsInstruction(text) || ADDRESSED_TO_DRAFTER.test(text);
const clip = (s: string, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The facts kept from everything the sources returned: checked one by one, best sources first, at most 25.
// o.employers: the contact's own employer (the company the job post names), a professional name like PROFESSIONAL_NAMES.
export function keepFacts(raw: RawFact[], o: { now: number; employers?: string[] }): { facts: ContactFact[]; dropped: { why: DropWhy; claim: string; detail?: string }[] } {
  const facts: ContactFact[] = [], dropped: { why: DropWhy; claim: string; detail?: string }[] = [], seen = new Set<string>();
  const sorted = [...raw].sort((a, b) => b.confidence - a.confidence);
  for (const r of sorted) {
    const claim = clip(r.claim, 240), quote = clip(r.quote, SNIPPET_MAX);
    if (!/^https:\/\//.test(String(r.source_url ?? ""))) { dropped.push({ why: "no_source", claim }); continue; }
    if (instructionLike(r.claim) || instructionLike(r.quote)) { dropped.push({ why: "instruction", claim: "(text that reads as an instruction; not kept)" }); continue; }
    const p = privateTopic(`${r.claim} ${r.quote}`, o.employers ?? []);
    if (p) { dropped.push({ why: "private", claim: `(${p}; not kept)`, detail: p }); continue; }
    if (r.source_type === "news" && (!r.published_at || o.now - Date.parse(r.published_at) > NEWS_MAX_MONTHS * 30.44 * 86400_000)) { dropped.push({ why: "stale", claim }); continue; }
    if (seen.has(key(claim))) { dropped.push({ why: "duplicate", claim }); continue; }
    if (facts.length >= FACT_MAX) { dropped.push({ why: "over_cap", claim }); continue; }
    seen.add(key(claim));
    facts.push({ claim, source_url: r.source_url, source_type: r.source_type, retrieved_at: new Date(o.now).toISOString(), published_at: r.published_at,
      quote_snippet: quote, confidence: Math.max(0, Math.min(1, r.confidence)), method: clip(r.method, 80), expires_at: new Date(o.now + FACT_TTL_DAYS * 86400_000).toISOString() });
  }
  return { facts, dropped };
}
export const liveFacts = (facts: ContactFact[], now: number) => facts.filter((f) => Date.parse(f.expires_at) > now);
