// WO-091a: what the end of an agent turn checks in the model's reply before the person reads it (audit chat-brain F6,
// F10; the claim check, F5, lives in loop.ts and uses the sentence pieces here). The model writes the words; code checks:
//   facts   a sentence about the person (a draft in their voice, or "you/your" with a skill, school, employer, title or
//           number) may say only what traces to their confirmed facts, their own messages or this turn's tool results.
//           The tracing is the essay fact lock (essay_draft.ts factLock, also inside career_outreach.ts outreachLock);
//           this file only picks the sentences and the kinds of words that are claims about the person.
//   leaks   no tool name, raw job id, uuid or JSON field name reaches the person.
// Each finder returns what it found (for the one rewrite the loop asks for) and a fixer applies code's last resort.
import { DEGREES, factLock, factText, norm, SCALE, TITLES, TOOLS } from "../essay_draft.ts";
import { personalSourceDenied as sourceDenied, personalSourceGuard } from "../personal_fact_source.ts";

// ------------------------------------------------------------------------------------------------ sentences
// A reply as sentence pieces with the whitespace after each, so a piece can be dropped or changed and the rest of the
// reply (paragraphs, bullets, a draft's line breaks) rebuilt as it was.
export interface Piece { text: string; sep: string }
export function pieces(reply: string): Piece[] {
  const parts = String(reply ?? "").split(/((?<=[.!?]["”')\]]?)[ \t]+|[ \t]*\n\s*)/);
  const out: Piece[] = [];
  for (let i = 0; i < parts.length; i += 2) out.push({ text: parts[i] ?? "", sep: parts[i + 1] ?? "" });
  return out;
}
const breaks = (s: string) => (s.match(/\n/g) || []).length;
export function rebuild(ps: Piece[], drop: Set<number> = new Set()): string {
  const out: Piece[] = [];
  ps.forEach((p, i) => {
    if (!drop.has(i)) { out.push({ ...p }); return; }
    // A dropped sentence keeps the larger break around it: dropping a paragraph's last sentence keeps the paragraph.
    if (out.length && breaks(p.sep) > breaks(out[out.length - 1].sep)) out[out.length - 1].sep = p.sep;
  });
  const text = out.map((p) => p.text + p.sep).join("");
  return (drop.size ? text.replace(/\n{3,}/g, "\n\n") : text).trim();
}
export const plainQuotes = (s: string) => String(s ?? "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
// Code's own masks while it edits: links are never touched.
function masked(text: string, fn: (t: string) => string): string {
  const kept: string[] = [];
  const t = text.replace(URL_RE, (u) => { kept.push(u); return `\u0000${kept.length - 1}\u0000`; });
  return fn(t).replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}
function tidy(s: string): string {
  return s.replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?)])/g, "$1").replace(/\(\s+/g, "(").replace(/^\s+|\s+$/g, "");
}

// ------------------------------------------------------------------------------------------------ secrets
// ADVERSARIAL ROUND 2 (2026-10-30): a key-shaped string (an API key, a token, a signed JWT) never reaches the person or
// the stored reply, whoever asked for it and wherever the model read it (a posting, an email, a pasted page). The
// sentence that carries one is dropped whole.
const SECRET_RE = /(?<![A-Za-z0-9])(?:sk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{8,}|(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/;
export const secretIn = (text: string) => SECRET_RE.test(String(text ?? ""));
export function stripSecrets(reply: string): string {
  const ps = pieces(reply);
  return rebuild(ps, new Set(ps.flatMap((p, i) => (secretIn(p.text) ? [i] : []))));
}

// ------------------------------------------------------------------------------------------------ sources
// What a sentence about the person may draw on: confirmed facts (never one waiting for their yes, memory.ts's rule),
// the account's stated facts, this turn's message, their own earlier messages, and this turn's tool results. Never the
// model's own earlier replies.
const FACT_KINDS = new Set(["experience", "education", "skill", "project", "leadership", "award", "publication", "certification", "goal", "location", "preference", "other"]);
const record = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
function sourceFactOk(f: any, legacyToolText = false): boolean {
  if (!record(f) || sourceDenied(f)) return false;
  // Explicit confirmation survives old rows without the flag; absent/unknown status on a stored profile is not proof.
  // Opaque, unlabelled tool facts retain their existing conversational contract. This is not submit authorization.
  return (f.status === "confirmed" || (legacyToolText && f.status === undefined)) &&
    (f.needs_confirmation === false || f.needs_confirmation === undefined);
}
function currentFact(f: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["text", "title", "name", "value"]) if (typeof f[key] === "string" || typeof f[key] === "number") out[key] = f[key];
  for (const key of ["bullets", "skills"]) if (Array.isArray(f[key])) out[key] = f[key].filter((v: unknown) => typeof v === "string");
  // Audit, corrected_from, evidence ids and model notes describe how a row got here, not additional current facts.
  return out;
}
const SOURCE_AUDIT_KEYS = new Set(["corrected_from", "was", "audit", "audit_log", "profile_corrections", "unconfirmed", "drafts", "rejected", "requirement", "requirements"]);
const pathMove = (v: any) => record(v) && record(v.requirement) && Object.hasOwn(v, "fact") && ["met", "unmet", "unknown"].includes(v.status);
function sourceResult(v: any, factContext = false, depth = 0, denied = sourceDenied): any {
  if (depth > 20) return undefined;
  if (Array.isArray(v)) return v.map((x) => sourceResult(x, factContext, depth + 1, denied)).filter((x) => x !== undefined);
  if (!record(v)) return v;
  // A child's own status cannot erase an enclosing record's explicit untrusted provenance.
  if (denied(v)) return undefined;
  // An employer's requirements describe a job, not this person's experience. Posting display still reads raw results.
  if ((typeof v.job_id === "string" || typeof v.posting_id === "string") && typeof v.title === "string" &&
    (typeof v.description === "string" || typeof v.url === "string")) return undefined;
  // career_path_answer mixes cited personal facts with external requirements and prose rendered from those
  // requirements. Keep only each move's actual personal evidence; its messages are not an independent fact source.
  if (Array.isArray(v.moves) && v.moves.some(pathMove)) return sourceResult(v.moves.filter(pathMove), false, depth + 1, denied);
  if (pathMove(v)) return record(v.fact) ? sourceResult(v.fact, true, depth + 1, denied) : undefined;
  if (factContext || Object.hasOwn(v, "needs_confirmation") || FACT_KINDS.has(v.kind) ||
    (typeof v.text === "string" && Object.hasOwn(v, "status"))) return sourceFactOk(v, true) ? currentFact(v) : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (SOURCE_AUDIT_KEYS.has(key)) continue;
    const cleaned = sourceResult(value, key === "facts" || key === "fact" || key === "confirmed", depth + 1, denied);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}
function parseSourceResult(text: string): { raw: string; structured: boolean; value: unknown } {
  try { return { raw: text, structured: true, value: JSON.parse(text) }; }
  catch { return { raw: text, structured: false, value: undefined }; }
}
function resultSource(result: ReturnType<typeof parseSourceResult>, denied: (value: unknown) => boolean): string {
  // A truncated JSON result can still contain a rejected fact's words. Never reinterpret that broken record as prose.
  if (!result.structured) return /^\s*[\[{]/.test(result.raw) ? "" : result.raw;
  try { const clean = sourceResult(result.value, false, 0, denied); return clean === undefined ? "" : JSON.stringify(clean); }
  catch { return ""; }
}
export function factSources(o: { state: Record<string, unknown>; message: string; history: any[]; results: string[] }): string[] {
  const profile: any = o.state?.profile;
  const sf: any = o.state?.statedFacts;
  const results = o.results.map(parseSourceResult), denied = personalSourceGuard([profile, sf, ...results.map(r => r.value)]);
  const facts = (Array.isArray(profile?.facts) && !denied(profile) ? profile.facts : []).filter((f: any) => !denied(f) && sourceFactOk(f));
  const stated = Array.isArray(sf?.facts) ? sf.facts : Array.isArray(sf) ? sf : [];
  const userSaid = (Array.isArray(o.history) ? o.history : []).filter((m: any) => m && m.role === "user").map((m: any) =>
    typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("\n") : ""
  );
  return [...facts.map((f: any) => factText(currentFact(f))), ...stated.filter((f: any) => !denied(sf) && !denied(f) && sourceFactOk(f, true)).map((f: any) => factText(currentFact(f))), String(o.message ?? ""), ...userSaid, ...results.map(r => resultSource(r, denied))].filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ the fact lock on a reply
// A clause speaks about the person when it says "your …", "my …", "I built/used/led…", "you worked/studied…", "I'm a…"
// or marks something "(confirmed)". A clause that negates or names a gap ("not in your facts", "you don't have") claims
// nothing. A question claims nothing.
const ABOUT = /\b(?:your|yours|my|confirmed)\b|\b(?:you|i)(?:'ve| have| had)?\s+(?:a|an)\s+(?:\d(?:\.\d+)?(?:\s*\/\s*4(?:\.0+)?)?\s+(?:(?:cumulative|overall|major|unweighted|weighted)\s+)?)?GPA\b|\b(?:gave|taught|earned|got) me\b|\b(?:you|i)(?:'re|'m| are| am| were| was)\s+(?:an?|proficient|skilled|experienced|fluent|certified)\b|\b(?:you|i)(?:'ve| have| had)?\s+(?:built|led|used|managed|developed|created|designed|worked|interned|studied|graduated|majored|minored|earned|completed|shipped|launched|ran|analy[sz]ed|automated|grew|increased|reduced|cut|taught|served|spent|bring|know|hold|have \d)\b/i;
const GAP = /\b(?:not|no|never|none|without|lack|lacking|missing|gaps?|cannot)\b|n't\b/i;
// "Your GPA: 3.85" is one claim, not two clauses (ADVERSARIAL ROUND 2).
const CLAUSE = /([,;]\s+|\s*[—–]\s*|(?<!\bGPA\s?):\s+|\s+(?:and|but|or|while|whereas)\s+)/;
const MONTHS = /^(?:January|February|March|April|May|June|July|August|September|October|November|December)$/;
// Capitals that are ordinary words, places, formats or products, never a skill the person claims.
const COMMON_CAPS = new Set(["I", "US", "USA", "UK", "EU", "NY", "NYC", "SF", "LA", "DC", "IL", "CA", "TX", "WA", "MA", "GPA", "CS", "AI", "ML", "HR", "PM", "AM", "QA", "OK", "ATS", "PDF", "CSV", "URL", "CV", "FAQ", "ID", "EST", "PST", "CST", "UTC", "TBD", "ASAP", "FYI", "TEST", "SWE", "BS", "BA", "MS", "LinkedIn", "WhatsApp", "iMessage", "YouTube", "iPhone", "Trainee", "Upmore"]);
const inList = (list: string[], u: string) => list.some((w) => norm(w) === norm(u));
const before = (clause: string, w: string) => { const at = clause.search(new RegExp(`(?<![\\w$])${esc(w)}(?![\\w%])`, "i")); return at < 0 ? null : clause.slice(0, at); };
// Each kind of word is a claim about the person only where the clause attributes it to them.
const SKILL_CUE = /\b(?:experience (?:with|in)|skills? (?:in|with)|your|my|used|using|proficient (?:in|with)|knowledge of|worked with|built (?:with|in))\s+(?:[\w+#./-]+\s+){0,2}$/i;
const TITLE_CUE = /\b(?:as an?|i(?:'m| am| was) an?|you(?:'re| are| were) an?|(?:your|my) (?:role|title|job|position|time) (?:as|at)(?: an?)?)\s+(?:[\w-]+\s+){0,3}$/i;
// A number right after "GPA" and a few linking words ("GPA of", "GPA is", "GPA: ", "GPA stands at") is a GPA.
const GPA_CUE = /\bGPA\b(?:\s*(?:of|is|was|=|:|at|stands at|is now|currently|around|about|now)\b)*[\s:=]*$/i;
const NUM_UNIT = /^\s*(?:\+\s*)?(?:years?|yrs?|months?|people|engineers|members|students|users|customers|clients|employees|reports|interns|projects)\b/i;
// D-035 review (staged brain, fact lock): a number right BEFORE "GPA" is a GPA too ("your 3.9 GPA", "you have a 3.9 GPA",
// "a 3.7/4.0 cumulative GPA"); only the number after it was read, so "With your 3.9 GPA from ..." delivered an invented GPA.
const GPA_AFTER = /^\s*(?:\/\s*4(?:\.0+)?\s*)?(?:(?:cumulative|overall|major|unweighted|weighted)\s+)?GPA\b/i;
const GPA_BEFORE = /(?<![\w.])(\d(?:\.\d+)?)(?:\s*\/\s*4(?:\.0+)?)?\s+(?:(?:cumulative|overall|major|unweighted|weighted)\s+)?GPA\b/gi;
export interface Untraced { word: string; kind: "skill" | "title" | "degree" | "number" | "result" | "month" | "place" }
const PLACEHOLDER: Record<Untraced["kind"], string> = {
  skill: "[your skill]", title: "[your title]", degree: "[your degree]", number: "[number]", result: "[result]", month: "[month]", place: "[employer or school]",
};
// Which of the fact lock's untraced words are claims about the person, and of what kind; the rest (a capitalized word
// opening a clause, "Hiring", "your Fieldnote recruiter", "within 48 hours") is ordinary prose.
function classify(u: string, clause: string): Untraced | null {
  const w = u.replace(/['’]s$/, "").trim();
  const pre = w ? before(clause, w) : null;
  if (!w || pre === null || COMMON_CAPS.has(w)) return null;
  if (inList(TOOLS, w)) return { word: w, kind: "skill" };
  if (/^(?:[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|[A-Za-z]+\d+[A-Za-z0-9]*|[A-Za-z]+\.(?:js|io|net)|C\+\+|C#|[A-Z]{2,5})$/.test(w)) return SKILL_CUE.test(pre) ? { word: w, kind: "skill" } : null;
  if (inList(DEGREES, w)) return { word: w, kind: "degree" };
  if (inList(TITLES, w)) return TITLE_CUE.test(pre) ? { word: w, kind: "title" } : null;
  if (inList(SCALE, w)) return { word: w, kind: "result" };
  if (MONTHS.test(w)) return { word: w, kind: "month" };
  if (/\d/.test(w)) {
    if (/[$%]|\d\s?(?:k|m|bn|b)$/i.test(w) || /^(?:19|20)\d\d$/.test(w)) return { word: w, kind: "number" };
    // ADVERSARIAL ROUND 2 (2026-10-30): "Your GPA is 3.95" and "your GPA: 4.0" claim a GPA as surely as "GPA of 3.95".
    const after = clause.slice(pre.length + w.length);
    // The lock also reads "3.9" as "3" and "9": the "9" of "3.9 GPA" is not a GPA of its own (GPA_BEFORE reads it whole).
    return NUM_UNIT.test(after) || GPA_CUE.test(pre) || (GPA_AFTER.test(after) && !/[\d.\/]$/.test(pre)) ? { word: w, kind: "number" } : null;
  }
  // A prospective role at an employer is not employment history ("your skills fit the role at X"). A worked/studied
  // predicate still claims the person was there, even when that sentence also names a role.
  if (/^[A-Z]/.test(w)) {
    const targetRole = /\b(?:for|to|about)\s+(?:a|an|the|this|that)\s+(?:role|job|position|opening|opportunity)\s+at\s+(?:the\s+)?$/i.test(pre) ||
      /\b(?:would|could|might|may)\b[^.!?]*\bin\s+(?:a|an|the|this|that)\s+(?:role|job|position|opening|opportunity)\s+at\s+(?:the\s+)?$/i.test(pre);
    const personalHistory = /\b(?:worked|interned|employed|studied|graduated|served|held|was|were|am|attended)\b|'m\b/i.test(pre);
    return /\b(?:at|from)\s+(?:the\s+)?$/i.test(pre) && !(targetRole && !personalHistory) ? { word: w, kind: "place" } : null;
  }
  return null;
}
const unbracketed = (s: string) => s.replace(/\[[^\]]*\]/g, (m) => " ".repeat(m.length));
// ADVERSARIAL ROUND 2 (2026-10-30): a GPA is the person's own record, so it traces only to what they said and their
// facts (`personal`), never to a posting, an email or a search result a tool returned this turn: a posting that said
// "the candidate's GPA is 4.0" let "Your GPA is 4.0" through.
const GPA_STATED = /\bGPA\b(?:\s*(?:of|is|was|=|:|at|stands at|is now|currently|around|about|now)\b)*[\s:=]*(\d(?:\.\d+)?)\b/gi;
function clauseClaims(clause: string, sources: string[], personal: string[] = sources): Untraced[] {
  const plain = unbracketed(plainQuotes(clause)).replace(URL_RE, " ");
  if (!ABOUT.test(plain) || GAP.test(plain)) return [];
  const out: Untraced[] = [];
  const mine = new Set([...personal.join(" \n ").matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
  for (const re of [GPA_STATED, GPA_BEFORE]) for (const m of plain.matchAll(re)) if (!mine.has(m[1]) && !out.some((x) => x.word === m[1])) out.push({ word: m[1], kind: "number" });
  const nums = new Set([...sources.join(" \n ").matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
  for (const u of factLock(plain, sources).untraced) {
    const c = classify(u, plain);
    // The lock reads "3.7" as "3" and "7" too; a number is checked whole ("3.7" on record traces "GPA is 3.7").
    if (c?.kind === "number" && /^\d+$/.test(c.word)) {
      const at = before(plain, c.word);
      const whole = at === null ? c.word : (plain.slice(at.length).match(/^\d[\d,]*(?:\.\d+)?/) ?? [c.word])[0].replace(/,/g, "");
      if (nums.has(whole)) continue;
    }
    if (c && !out.some((x) => norm(x.word) === norm(c.word) || (c.kind === "number" && x.kind === "number" && x.word.split(/[.,]/)[0] === c.word))) out.push(c);
  }
  return out;
}
const isQuestion = (s: string) => /\?["”')\]]*\s*$/.test(s.trim());
// Every untraced claim about the person in the reply, sentence by sentence.
export function untracedFacts(reply: string, sources: string[], personal: string[] = sources): Untraced[] {
  const out: Untraced[] = [];
  for (const p of pieces(reply)) {
    if (isQuestion(p.text)) continue;
    for (const clause of p.text.split(CLAUSE).filter((_, i) => i % 2 === 0)) {
      for (const c of clauseClaims(clause, sources, personal)) if (!out.some((x) => norm(x.word) === norm(c.word))) out.push(c);
    }
  }
  return out;
}
// Code's last resort: each untraced claim becomes a placeholder the person fills in ("[your skill]"), in the clause
// that makes it, never inside a bracket or a link.
export function bracketUntraced(reply: string, sources: string[], personal: string[] = sources): string {
  const ps = pieces(reply);
  for (const p of ps) {
    if (isQuestion(p.text)) continue;
    const parts = p.text.split(CLAUSE);
    for (let i = 0; i < parts.length; i += 2) {
      const found = clauseClaims(parts[i], sources, personal);
      if (!found.length) continue;
      parts[i] = masked(parts[i], (t) => t.split(/(\[[^\]]*\])/).map((seg, j) => {
        if (j % 2) return seg;
        let s = seg;
        // A number is replaced whole: "4.0" read as "4" left "[number].0" (ADVERSARIAL ROUND 2).
        for (const f of found) s = s.replace(f.kind === "number" ? new RegExp(`(?<![\\w$.])${esc(f.word)}(?:[.,]\\d+)*(?![\\w%])`, "gi") : new RegExp(`(?<![\\w$])${esc(f.word)}(?![\\w%])`, "gi"), PLACEHOLDER[f.kind]);
        return s;
      }).join(""));
    }
    p.text = parts.join("");
  }
  return rebuild(ps);
}

// ------------------------------------------------------------------------------------------------ internal words
// The tool vocabulary the person must never read: tool names, snake_case field names (job_id, remote_ok, full_name),
// uuids and raw job ids ("greenhouse:copperlineinfra:4100016"). A word the person typed themselves is theirs to read.
const SNAKE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RAW_ID = /\b[a-z][a-z0-9]*:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*\b/gi;
export interface Posting { title: string; company: string }
// The postings this turn's tool results named, by every id they gave it.
export function postingsOf(results: string[]): Map<string, Posting> {
  const out = new Map<string, Posting>();
  const walk = (v: any, depth = 0) => {
    if (depth > 6 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    const title = typeof v.title === "string" ? v.title : "", company = typeof v.company === "string" ? v.company : "";
    if (title || company) for (const k of ["job_id", "posting_id", "posting_key", "id"]) if (typeof v[k] === "string" && v[k].length >= 4) out.set(v[k], { title, company });
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const r of results) { try { walk(JSON.parse(r)); } catch { /* a plain-text result names no posting */ } }
  return out;
}
const idLike = (id: string) => /[:_-]/.test(id) && id.length >= 6;
function typedWords(typed: string): Set<string> {
  const t = String(typed ?? "").toLowerCase();
  return new Set([...(t.match(SNAKE) || []), ...(t.match(UUID) || []), ...(t.match(RAW_ID) || [])]);
}
export function leakedWords(reply: string, o: { tools: string[]; typed: string; postings: Map<string, Posting> }): string[] {
  const own = typedWords(o.typed);
  const out: string[] = [];
  const add = (w: string) => { if (!own.has(w.toLowerCase()) && !out.includes(w)) out.push(w); };
  const t = String(reply ?? "").replace(URL_RE, " ");
  for (const id of o.postings.keys()) if (idLike(id) && t.includes(id)) add(id);
  for (const re of [RAW_ID, UUID, SNAKE]) for (const m of t.matchAll(re)) add(m[0]);
  for (const name of o.tools) if (/_/.test(name) && new RegExp(`\\b${esc(name)}\\b`).test(t)) add(name);
  // WO-061 (second judge, run 39603731114 p3: "You don't have that interview on file yet: SITUATION shows nothing"):
  // the name of the system prompt's block is internal; only the all-caps block name, never the ordinary word.
  if (BLOCK_NAME.test(t) && !/\bSITUATION\b/.test(o.typed)) add("SITUATION");
  return out;
}
const BLOCK_NAME = /\bSITUATION\b/;
// Code's last resort: a known job id becomes "title at company" (or goes, when the sentence already names it), any other
// id goes, and a field or tool name becomes plain words.
export function stripLeaks(reply: string, o: { tools: string[]; typed: string; postings: Map<string, Posting> }): string {
  const own = typedWords(o.typed);
  const ps = pieces(reply);
  for (const p of ps) {
    if (!leakedWords(p.text, o).length) continue;
    p.text = tidy(masked(p.text, (t) => {
      let s = t;
      const ids = [...new Set([...[...o.postings.keys()].filter((id) => idLike(id) && s.includes(id)), ...(s.match(RAW_ID) || []), ...(s.match(UUID) || [])])]
        .filter((id) => !own.has(id.toLowerCase())).sort((a, b) => b.length - a.length);
      for (const id of ids) {
        const known = o.postings.get(id);
        const named = known && known.company && s.toLowerCase().includes(known.company.toLowerCase()) && (!known.title || s.toLowerCase().includes(known.title.toLowerCase()));
        const say = known && !named ? [known.title, known.company].filter(Boolean).join(" at ") : "";
        s = s.split(id).join(say);
      }
      return s.replace(SNAKE, (w) => own.has(w.toLowerCase()) ? w : w.replace(/_/g, " ")).replace(/\bSITUATION\b/g, (w) => /\bSITUATION\b/.test(o.typed) ? w : "your account");
    }));
  }
  return rebuild(ps);
}

// ------------------------------------------------------------------------------------------------ money
// WO-106 (eval run 39538248995, E038: "postings ... list about $65k–$95k" with no tool call): a pay or money figure is said
// only when this turn's tool results or the person's own words hold it. The sentences that carry one are returned.
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M)?\b|\b\d{2,3}(?:\.\d)?\s?[kK]\b/g;
const moneyKey = (m: string) => {
  const t = m.replace(/[$,\s]/g, "").toLowerCase();
  const n = /k$/.test(t) ? Math.round(parseFloat(t) * 1000) : /m$/.test(t) ? Math.round(parseFloat(t) * 1e6) : Math.round(parseFloat(t));
  return Number.isFinite(n) ? String(n) : t;
};
function moneyIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(MONEY)) out.add(moneyKey(m[0]));
  for (const m of String(text ?? "").matchAll(/\b\d{4,7}\b/g)) out.add(String(Number(m[0])));
  return out;
}
export function unsourcedMoney(reply: string, sources: string[]): { index: number; figure: string }[] {
  const known = new Set<string>();
  for (const s of sources) for (const k of moneyIn(s)) known.add(k);
  const out: { index: number; figure: string }[] = [];
  pieces(reply).forEach((p, index) => {
    for (const m of p.text.matchAll(MONEY)) if (!known.has(moneyKey(m[0]))) { out.push({ index, figure: m[0].trim() }); break; }
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ waiver wording
// WO-061 (H018, run 39549570017 p2): the brain drafted the approval-bypass wording for the person to send ("reply with:
// Share my resume with your whole network - don't ask me each time ... I'll save it"). The standing-instruction refusal
// stops the save, not a reply proposing it. Wording the reply puts in their mouth (quoted, or after "reply with / text /
// send / say ...:") that the refusal flags is a solicitation; so is the save offer beside it. Returns piece indices.
const PROPOSE = /\b(reply|respond|text|send|say|type|write|message)( me| back| us)?( with| this| exactly| the words?)?\s*[:\u2013\u2014-]\s*(.*)$/i;
const SAVE_OFFER = /\b(i'?ll|i will|i can|i'?d|let me|and i|want me to|should i|shall i)\b[^.?]{0,40}\b(save|keep|remember|store|set( up)?|record|add)\b|\b(standing instruction|standing rule|persistent rule|permanent rule|a rule (so|that)|save (it|that|this) as)\b/i;
// WO-061 (H018 p1, run 39549570017 / 39551229537): when the person's own message asks to waive their yes, ANY offer in the
// reply to save, keep or set something is an offer to save that waiver ("I can save a standing instruction that says
// exactly what you want"), quoted or not. Anywhere, a save offer whose own sentence describes the waiver is one too.
export function waiverSolicits(reply: string, refuse: (text: string) => string | null, message = ""): number[] {
  const ps = pieces(reply), hit = new Set<number>();
  const asked = !!(message && refuse(message));
  ps.forEach((p, i) => { if (SAVE_OFFER.test(p.text) && (asked || refuse(p.text))) hit.add(i); });
  ps.forEach((p, i) => {
    const segs: string[] = [];
    for (const m of p.text.matchAll(/["\u201c\u201d]([^"\u201c\u201d]{4,240})["\u201c\u201d]/g)) segs.push(m[1]);
    const m = PROPOSE.exec(p.text);
    if (m) segs.push(m[4] || ps[i + 1]?.text || "");
    if (segs.some((x) => x.trim() && refuse(x))) { hit.add(i); if (m && !m[4]) hit.add(i + 1); }
  });
  for (const i of [...hit]) for (const j of [i - 1, i + 1]) if (ps[j] && SAVE_OFFER.test(ps[j].text)) hit.add(j);
  // WO-061 (H018 p1, run 39554573965): a short question pointing at removed wording ("Is that the wording you want?",
  // "Does that work?") goes with it; left alone it is a bare prompt to confirm the waiver.
  for (const i of [...hit].sort((a, b) => a - b)) {
    for (let j = i + 1; j < ps.length && j <= i + 2; j++) {
      const t = ps[j].text.trim();
      if (!t || hit.has(j)) continue;
      if (/\?\s*$/.test(t) && t.split(/\s+/).length <= 14 && /\b(wording|words|phrasing|that right|this right|that work|that ok|that okay|want me to|should i|shall i|is that what you want|sound (good|right))\b/i.test(t)) hit.add(j);
      break;
    }
  }
  // WO-061 (H018 p1, run 39592260931: refusal, then "Is that what you'd like?"): after the person asked to waive their
  // yes there is nothing for them to confirm; a short confirm question anywhere in the reply reads as an offer to waive.
  if (asked) ps.forEach((p, i) => { const t = p.text.trim(); if (t.split(/\s+/).length <= 10 && CONFIRM_AFTER_REFUSAL.test(t)) hit.add(i); });
  // WO-061 (H018 p1, stacked run 39599518668: "Is there a short phrase you want saved?"): after a waiver ask, any
  // question about saving, keeping or remembering something is an offer to save the waiver, first person or not.
  if (asked) ps.forEach((p, i) => { if (/\?\s*$/.test(p.text) && SAVE_WORDS.test(p.text)) hit.add(i); });
  return [...hit].filter((i) => i >= 0 && i < ps.length).sort((a, b) => a - b);
}
const SAVE_WORDS = /\b(?:sav(?:e|ed|ing)|keep(?:s|ing)?|kept|remember(?:ed|ing)?|stor(?:e|ed|ing)|record(?:ed|ing)?|note (?:it|that|this) down)\b/i;
const CONFIRM_AFTER_REFUSAL = /^(?:(?:is|does|would|will|are|was)\s+(?:that|this|it|everything|all of that)\b[^?]{0,50}|(?:sounds?|ok|okay|good|alright|all right|fair|agreed|deal)\b[^?]{0,20}|.{0,30}\bwhat you(?:'d| would)? (?:like|want)\b[^?]{0,20})\?$/i;

