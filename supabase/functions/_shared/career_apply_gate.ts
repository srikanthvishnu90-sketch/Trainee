// The posting screen's gate (FEATURES F09, gap closed): every apply path (single ask, batch ask, the possible-match
// answer, the brain's queue_applications) passes its picks through gatePicks BEFORE anything is queued, so no payload
// is prepared or shown for approval for a stale, closed, scam-looking or knocked-out posting.
//   * stale / closed / scam / knock-out mismatch against a CONFIRMED fact: excluded, with a short reason;
//   * a knock-out the person has not confirmed a fact for: held, and asked ONCE per batch (never guessed, D-007);
//   * D-MS-3: only an exact duplicate blocks (the screen's own already_applied / duplicate_in_batch); no per-company rule;
//   * NO LIMITS (D-MS-2): no count cap anywhere; the batch is screened in one pass.
// The pure screen is career_apply_screen.ts; this file adapts the chat's fact list and posting records to it.
import { type ExcludeReason, type ScreenFacts, type ScreenFactKey, type ScreenPosting, screenBatch } from "./career_apply_screen.ts";

// What a pick may carry beyond its identity: the posting record's own text and dates, copied from the record on file.
export interface PostingContent { description?: string | null; posted_at?: string | null; first_seen_at?: string | null; closed_at?: string | null; remote?: string | null; apply_url?: string | null }
export interface GatePick { url?: string; job_id?: string; company?: string; title?: string; location?: string; content?: PostingContent }
export const contentOf = (rec: any): PostingContent | undefined => rec && typeof rec === "object"
  ? { description: rec.description ?? null, posted_at: rec.posted_at ?? null, first_seen_at: rec.first_seen_at ?? null, closed_at: rec.closed_at ?? null, remote: rec.remote ?? null, apply_url: rec.apply_url ?? null }
  : undefined;

// The chat's confirmed-fact list (profile facts + facts stated in chat) as the screen's keyed facts. Only a fact that is
// confirmed counts (not needs_confirmation, not draft, not D-007 quarantined). Three real shapes are read:
//   * a fact the screen's own question saved (career_apply_screen_answer.ts): `screen_key` + `value`;
//   * the profile builder's facts (packages/domain/122-career-profile.js): `kind` + `text`, with no `value`:
//       location (where they live, never a place they want to work), eligibility / preference / profile / other (sponsorship,
//       citizenship, relocation and "N years of experience" in the person's own words), education (the highest finished degree);
//   * the router's stated facts (handler: { kind, value, text, stated }): geography, sponsorship, citizenship.
// A legacy keyed fact ({ key | fact_key, value }) still reads. Nothing is guessed: text that does not say it maps to nothing,
// and the screen then asks the question once. Years are never added up from job dates (an undercount would wrongly drop a posting).
const KEYS = new Set(["location", "country", "relocation", "sponsorship", "work_authorization", "citizenship", "years_experience", "education_level", "skills"]);
const WANTS_LOCATION = /\b(want|wants|prefer|prefers|looking|seeking|target|targets|interested|would like|hope|hoping|open to|relocat|move to|work in|roles? in|jobs? in|remote)\b/i;
const NOT_ABOUT_SELF = /\b(spouse|wife|husband|partner|parents?|mother|father|friend|brother|sister|boss|manager)\b/i;
const EDU_RANK: Record<string, number> = { high_school: 1, associate: 2, bachelor: 3, master: 4, doctorate: 5 };
export const placeOf = (text: string): string => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const m = /^(?:i\s*(?:'m|am|\s)\s*)?(?:currently\s+|now\s+)?(?:live|lives|living|reside|resides|residing|based|located|moved|relocated|home is)\s*(?:in|at|to|is)?\s+(.+?)(?:\s+(?:now|currently|right now|for (?:the )?(?:past|last)?\s*\w+\s+(?:years?|months?)))?$/i.exec(t);
  const v = (m ? m[1] : t).replace(/^(?:in|at)\s+/i, "").trim();
  return v;
};
const looksLikePlace = (v: string) => v.length >= 2 && v.length <= 60 && /^[A-Za-z][A-Za-z.'’ -]*(?:,\s*[A-Za-z][A-Za-z.'’ -]*)*$/.test(v) && !/\b(and|but|because|want|need|would|the|my|is|are|was)\b/i.test(v);
export function educationLevelOf(text: string): string | null {
  const t = String(text ?? "");
  if (/\b(pursuing|enrolled|in progress|working (?:on|towards?)|candidate|expected|currently (?:studying|a student)|dropped out|incomplete|did not (?:finish|complete)|didn'?t (?:finish|complete))\b/i.test(t)) return null;
  if (/\b(ph\.?\s?d|doctorate|doctoral|d\.?phil)\b/i.test(t)) return "doctorate";
  if (/\b(?:master'?s?|m\.?sc?\.?|m\.?eng|m\.?tech|mba|m\.?a\.?|m\.?s)\b/i.test(t)) return "master";
  if (/\b(bachelor'?s?|b\.?sc?\.?|b\.?a\.?|b\.?tech|b\.?eng|undergraduate degree|b\.?s)\b/i.test(t)) return "bachelor";
  if (/\bassociate'?s?\b/i.test(t)) return "associate";
  if (/\b(high school|ged)\b/i.test(t)) return "high_school";
  return null;
}
function eligibilityFromText(text: string): Partial<Record<"sponsorship" | "citizenship" | "relocation" | "years_experience", string>> {
  const t = String(text ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  const out: Partial<Record<"sponsorship" | "citizenship" | "relocation" | "years_experience", string>> = {};
  if (!t || NOT_ABOUT_SELF.test(t)) return out;
  if (/\b(?:do not|don'?t|won'?t|will not|never|no longer|not)\s+(?:\w+\s+){0,2}?(?:need|require)\b[^.]{0,40}\b(?:sponsor|h-?1b|visa)/i.test(t) || /\bwithout\b[^.]{0,30}\bsponsorship\b|\bno\s+(?:visa\s+)?sponsorship\s+(?:needed|required|necessary)\b|\bsponsorship\s+(?:is\s+)?not\s+(?:needed|required)\b/i.test(t)) out.sponsorship = "no";
  else if (/\b(?:need|needs|require|requires|will need|would need)\b[^.]{0,40}\b(?:sponsor|h-?1b|visa)/i.test(t)) out.sponsorship = "yes";
  if (/\b(?:non|not)[- ]?(?:an? )?(?:u\.?s\.?|american)\s+citizen/i.test(t) || /\b(?:green card|permanent resident|visa holder)\b/i.test(t) && !/\bcitizen\b/i.test(t)) out.citizenship = "no";
  else if (/\b(?:u\.?s\.?|american|united states)\s+citizen\b/i.test(t) && !/\b(?:non|not|isn'?t|aren'?t)\b/i.test(t)) out.citizenship = "yes";
  const cz = /\bcitizen(?:ship)?\s+of\s+([A-Z][A-Za-z ]{1,30})/.exec(t);
  if (!out.citizenship && cz) out.citizenship = cz[1].trim();
  if (/\b(?:not|n'?t|unwilling|no)\b[^.]{0,25}\b(?:relocat\w*|mov\w+)\b|\bno relocation\b/i.test(t)) out.relocation = "no";
  else if (/\b(?:open|willing|happy|able|ready)\s+to\s+(?:relocat\w*|move)\b|\bwill(?:ing)? (?:to )?relocate\b|\bcan relocate\b/i.test(t)) out.relocation = t;
  const y = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|work\s+|industry\s+|relevant\s+|full[- ]time\s+)?experience\b/i.exec(t);
  if (y && !/\b(?:with|requires?|requiring|minimum|at least|seeking|looking)\b/i.test(t.slice(0, y.index))) out.years_experience = y[1];
  return out;
}
export function screenFactsFrom(facts: any[]): ScreenFacts {
  const out: ScreenFacts = {};
  const skills: string[] = [];
  let eduRank = 0;
  const put = (k: string, value: unknown, f: any) => { out[k] = { value, confirmed: true, id: f?.id }; };
  for (const f of facts ?? []) {
    if (!f || f.needs_confirmation || f.status === "draft" || f.quarantine || f.quarantined) continue;
    const kind = String(f.kind ?? "");
    if (kind === "skill") {
      // The profile builder leaves `name` empty for a skill saved by text, and the resume reader keeps the bullet ("- SQL").
      const n = String(f.name || f.value || f.title || String(f.text ?? "").replace(/^skill:\s*/i, "")).replace(/^[\s\-•*]+/, "").trim();
      if (n && n.length <= 40) skills.push(n);
      continue;
    }
    // 1. a fact the screen's own question saved.
    if (f.screen_key && KEYS.has(String(f.screen_key)) && f.value !== undefined && f.value !== null && String(f.value).trim() !== "") { put(String(f.screen_key), f.value, f); continue; }
    // 2. a keyed fact.
    const hasValue = f.value !== undefined && f.value !== null && String(f.value).trim() !== "";
    const k = String(f.key ?? f.fact_key ?? (hasValue && KEYS.has(kind) ? kind : ""));
    if (KEYS.has(k)) { if (hasValue) put(k, f.value, f); continue; }
    // 3. the router's stated facts: a value of its own.
    if (f.stated) {
      const v = String(f.value ?? "").trim();
      if (!v) continue;
      if (kind === "geography") put("location", v, f);
      else if (kind === "sponsorship" || kind === "citizenship") put(kind, v, f);
      continue;
    }
    // 4. the profile builder's facts: kind + the person's words in `text`.
    const text = String(f.text ?? f.title ?? "").trim();
    if (!text) continue;
    if (kind === "location") {
      if (WANTS_LOCATION.test(text) || NOT_ABOUT_SELF.test(text)) continue;
      const place = placeOf(text);
      if (looksLikePlace(place)) put("location", place, f);
    } else if (kind === "education") {
      const lvl = educationLevelOf(text);
      if (lvl && EDU_RANK[lvl] > eduRank) { eduRank = EDU_RANK[lvl]; put("education_level", lvl, f); }
    } else if (["eligibility", "preference", "profile", "other", "goal"].includes(kind)) {
      const e = eligibilityFromText(text);
      for (const [key, value] of Object.entries(e)) put(key, value, f);
    }
  }
  if (skills.length) out.skills = { value: skills, confirmed: true };
  return out;
}

// The facts the chat's screen reads this turn: the profile's confirmed facts and what the person stated in chat, in the
// shapes the profile builder and the router really produce (the handler passes CareerProfile.confirmedFacts(profile)).
export const chatScreenFacts = (confirmed: any[], stated: any[] = []): any[] => [
  ...(confirmed ?? []),
  ...(stated ?? []).map((f) => ({ kind: f.kind, value: f.value, text: f.evidence ?? f.value, stated: true })),
];

export type DropKind = "stale" | "closed" | "scam" | "knockout" | "duplicate";
const KIND: Record<ExcludeReason, DropKind> = {
  closed: "closed", stale: "stale", scam: "scam", already_applied: "duplicate", duplicate_in_batch: "duplicate",
  location: "knockout", sponsorship: "knockout", citizenship: "knockout", years: "knockout", degree: "knockout",
};
export interface Dropped { posting: { job_id: string | null; company: string; title: string; url: string }; kind: DropKind; reason: ExcludeReason; why: string }
export interface GateResult {
  ok: GatePick[];
  dropped: Dropped[];
  held: { job_id: string | null; company: string; title: string; url: string; facts: ScreenFactKey[] }[]; // waiting on a fact the person has not confirmed
  asks: { fact: ScreenFactKey; question: string; count: number }[]; // each missing fact once
  // Facts the screen could not check because the person has not confirmed them: the posting PROCEEDS ("not checked"), it is never held
  // or interrogated for them (owner ruling: unknown = proceed and label; a CONFIRMED conflicting fact stops it; closed / stale / scam stop it regardless).
  unchecked: { posting: { job_id: string | null; company: string; title: string; url: string }; facts: ScreenFactKey[] }[];
  counts: { total: number; ok: number; dropped: number; held: number; by_kind: Partial<Record<DropKind, number>> };
}

// A pure yes / no, so the Yes / No buttons and a one-word reply answer it.
export const GATE_QUESTIONS = { relocation: "Would you relocate for this role? Reply yes or no." } as const;

export function gatePicks(picks: GatePick[], o: { facts: any[]; now: number }): GateResult {
  const sp: (ScreenPosting & { _i: number })[] = picks.map((p, _i) => ({
    _i, job_id: p.job_id ?? null, url: p.url ?? null, company: p.company ?? null, title: p.title ?? null, location: p.location ?? null,
    description: p.content?.description ?? null, posted_at: p.content?.posted_at ?? null, first_seen_at: p.content?.first_seen_at ?? null,
    closed_at: p.content?.closed_at ?? null, remote: p.content?.remote ?? null, apply_url: p.content?.apply_url ?? null,
  }));
  const b = screenBatch("", sp, screenFactsFrom(o.facts), { now: o.now });
  const idOf = (x: { _i?: number }) => x._i as number;
  const id = (p: GatePick) => ({ job_id: p.job_id ? String(p.job_id) : null, company: String(p.company ?? ""), title: String(p.title ?? ""), url: String(p.url ?? "") });
  const by_kind: Partial<Record<DropKind, number>> = {};
  const dropped = b.exclude.map((x) => {
    const kind = KIND[x.reason];
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
    return { posting: id(picks[idOf(x as any)]), kind, reason: x.reason, why: x.why } as Dropped;
  });
  // The ONE question left to ask: relocation, and only when a confirmed home exists, the posting is in person somewhere else, and the
  // person has not said whether they would move. Every other missing fact (location included) is "not checked": the posting proceeds.
  const askCount = new Map<ScreenFactKey, number>();
  const ok = b.include.map((x) => picks[idOf(x as any)]);
  const held: GateResult["held"] = [], unchecked: GateResult["unchecked"] = [];
  for (const x of b.needs_fact) {
    const p = picks[idOf(x as any)];
    if (x.facts.includes("relocation")) { askCount.set("relocation", (askCount.get("relocation") ?? 0) + 1); held.push({ ...id(p), facts: ["relocation"] }); }
    else { ok.push(p); unchecked.push({ posting: id(p), facts: x.facts }); }
  }
  const asks = askCount.size ? [{ fact: "relocation" as ScreenFactKey, question: GATE_QUESTIONS.relocation, count: askCount.get("relocation") ?? 0 }] : [];
  return {
    ok, dropped, held, asks, unchecked,
    counts: { total: picks.length, ok: ok.length, dropped: dropped.length, held: held.length, by_kind },
  };
}

// The batch summary line the person reads: counts and short reasons, nothing hidden. "" when nothing was screened out.
export function gateSummary(g: GateResult, name: (p: { title?: string; company?: string }) => string, max = 8): string {
  if (!g.dropped.length && !g.held.length) return "";
  const lab: Record<DropKind, string> = { stale: "stale", closed: "closed", scam: "scam-looking", knockout: "knock-out mismatch", duplicate: "duplicate" };
  const kinds = Object.entries(g.counts.by_kind).map(([k, n]) => `${n} ${lab[k as DropKind]}`);
  const parts: string[] = [];
  if (g.dropped.length) {
    const shown = g.dropped.slice(0, max).map((d) => `${name(d.posting)}: ${d.why}`);
    parts.push(`Screened out ${g.dropped.length} (${kinds.join(", ")}): ${shown.join("; ")}${g.dropped.length > max ? `; and ${g.dropped.length - max} more` : ""}.`);
  }
  if (g.held.length) {
    parts.push(`${g.held.length} held until you confirm a fact, not guessed. One question at a time: ${g.asks[0].question}`);
  }
  return parts.join(" ");
}
