// CONTACT OUTREACH (proposal D-042): which facts about a contact are kept. A fact is a professional claim with the public
// source it came from, the words there that support it (at most 200 characters), when it was read and published, how sure
// the source makes it, how it was found, and when it expires (90 days: re-read before it is used again).
// Kept only: professional facts. Never a home address, family, health, religion or politics, whatever the source says.
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
  ["home address", /\b(?:lives? (?:at|in|on)|home address|resides? (?:at|in)|\d{1,5} [A-Z][a-z]+ (?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|blvd)\b)/i],
  ["family", /\b(?:husband|wife|spouse|married|divorc\w*|daughter|son|children|kids?|pregnan\w*|baby|fianc[eé]e?|boyfriend|girlfriend|widow\w*)\b/i],
  ["health", /\b(?:cancer|diagnos\w*|illness|disease|surgery|therapy|depression|anxiety|disabilit\w*|medical leave|hospitali[sz]ed|chemo\w*|mental health)\b/i],
  ["religion", /\b(?:church|mosque|synagogue|christian|muslim|jewish|hindu|buddhis\w*|catholic|evangelical|faith|religio\w*|pray\w*)\b/i],
  ["politics", /\b(?:democrat\w*|republican\w*|liberal|conservative|trump|biden|election|vot(?:ed|ing|er)|campaign donat\w*|political|partisan|maga)\b/i],
];
export function privateTopic(text: string): string | null { for (const [k, re] of PRIVATE) if (re.test(text)) return k; return null; }
const ADDRESSED_TO_DRAFTER = /\b(?:ignore|disregard)\b|\b(?:ai|llm|assistant|model|chatgpt|claude|gpt)s?\b[^.]{0,30}\b(?:reading|writing|should|must|please)\b|\b(?:send|forward|bcc|cc|reply)\b[^.]{0,40}@|\[\/?inst\]|<\/?system>/i;
export const instructionLike = (text: string) => readsAsInstruction(text) || ADDRESSED_TO_DRAFTER.test(text);
const clip = (s: string, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The facts kept from everything the sources returned: checked one by one, best sources first, at most 25.
export function keepFacts(raw: RawFact[], o: { now: number }): { facts: ContactFact[]; dropped: { why: DropWhy; claim: string; detail?: string }[] } {
  const facts: ContactFact[] = [], dropped: { why: DropWhy; claim: string; detail?: string }[] = [], seen = new Set<string>();
  const sorted = [...raw].sort((a, b) => b.confidence - a.confidence);
  for (const r of sorted) {
    const claim = clip(r.claim, 240), quote = clip(r.quote, SNIPPET_MAX);
    if (!/^https:\/\//.test(String(r.source_url ?? ""))) { dropped.push({ why: "no_source", claim }); continue; }
    if (instructionLike(r.claim) || instructionLike(r.quote)) { dropped.push({ why: "instruction", claim: "(text that reads as an instruction; not kept)" }); continue; }
    const p = privateTopic(`${r.claim} ${r.quote}`);
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
