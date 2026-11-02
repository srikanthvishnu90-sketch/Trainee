// WO-030: a written answer drafted from the person's confirmed facts, offered inside ask once ("draft 2"), shown in full,
// and saved only when the person says "use 2". Code decides everything that matters; the model only writes sentences:
//   1. The employer's own AI policy decides first (ai_policy.ts over the posting's own labels, carried into
//      CareerWriting.gate0 as the context's record). A form that asks for answers written without AI, or names an AI
//      policy it does not spell out, is never drafted for.
//   2. Never invent (D-007): only confirmed facts (never a draft waiting for the person's yes) and the posting's own words
//      (company, the question). Fewer than 2 facts that fit: no draft, and the reply says what would let it draft. Every
//      number, date, proper noun, employer, school, title, tool and metric in a draft must trace to those (factLock); a
//      draft that does not is written again once with the failing items named, and if it still does not, it is not shown.
//   3. The form's own length limit ("in 150 words", "max 500 characters") is met by writing it again, never by cutting; a
//      draft the model cut off mid-sentence is never shown.
//   4. The model is called only through the injected `model` (the gateway's callModel in the handler, a stub in tests); a
//      failure says so and leaves the question open. Nothing here throws out of the turn.
import { CareerProfile, CareerWriting } from "./router_core.career.js";
import { type AiPolicy, readAiPolicy } from "./ai_policy.ts";
import { claimProblems, selfRole } from "./person_claims.ts";
import { redactIdentity } from "./identity_redact.ts";

export type ModelFn = (payload: any) => Promise<any>;
export interface DraftDeps {
  model: ModelFn;
  facts: () => Promise<unknown[]> | unknown[]; // the person's profile facts; only confirmed ones are ever used
}
export interface EssayQuestion {
  id: string; label: string; type: string; kind: string; company: string | null; job_ids: string[]; ai_policy?: string | null;
}
export interface Limit { words: number | null; chars: number; sentences: number | null; stated: boolean }
export type DraftOutcome =
  | { ok: true; text: string; policy: AiPolicy; factIds: string[]; limit: Limit; tries: number }
  | { ok: false; why: "policy" | "thin" | "unverified" | "too_long" | "model"; policy: AiPolicy | null; detail: string[]; tries: number };

const W: any = CareerWriting;
export const DEFAULT_WORDS = 250; // no limit on the form: an application answer, not an essay contest
export const HARD_CHARS = 2000; // what one answer may hold (career_apply_questions.answer, checkAnswer)
export const MIN_FACTS = 2;

// ---------------------------------------------------------------------------------------------------------------------
// Facts: confirmed only (memory.ts and 122's rule: needs_confirmation or status "draft" is not theirs yet), never a
// skill with no evidence (122 flags it unproven; it supports no written line), and never a D-007 quarantined fact (122).
const unproven = (f: any) => f.unproven === true || (f.kind === "skill" && f.unproven !== false && !(Array.isArray(f.evidence) && f.evidence.length));
export function confirmedFacts(facts: unknown[]): any[] {
  return (Array.isArray(facts) ? facts : []).filter((f: any) =>
    f && typeof f === "object" && !f.needs_confirmation && (!f.status || f.status === "confirmed") && !unproven(f) && !CareerProfile.quarantinedFact(f)
  );
}
// TAILORING ROUND 2: how a fact was confirmed is not what it says. Its provenance ("owner confirmed in chat the resume entry
// shown to them (2026-10-29T15:04:00Z)"), its confirmation event's id (a UUID), when it was confirmed and the ids of the
// facts that evidence it were sources of claims: "I was the owner of the data team" traced to "owner confirmed", "I
// supported 29 clinics" to the 29th of the month the fact was confirmed, "4000 customers" to a UUID's digits.
const SKIP_KEYS = new Set(["id", "kind", "status", "source", "needs_confirmation", "unproven", "fact_id", "provenance", "confirmation_event_id", "confirmed_at",
  "created_at", "updated_at", "added_at", "stated_at", "evidence", "derived_from", "message_sha256", "shown_sha256", "shown_message_ids", "quarantined",
  "source_key", "source_table", "event_id"]);
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || v == null) return out;
  if (typeof v === "string" || typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out, depth + 1));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v as any)) if (!SKIP_KEYS.has(k)) strings(x, out, depth + 1);
  return out;
}
export const factText = (f: any) => [...new Set(strings(f).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))].join("; ");
const factId = (f: any) => String(f?.id || f?.fact_id || "");

const BASE_KINDS = new Set(["experience", "project", "leadership", "award", "publication", "education", "certification", "other"]);
const STOP = new Set("the a an and or of to in for on at with your you our we us is are was were be what why how do does did this that it as about from by have has tell describe share any".split(" "));
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
// The facts that can carry this answer: a job, a project, a result, a school (and, for "why us", what they want next),
// with enough words to say something; the ones sharing the question's words first.
export function relevantFacts(facts: unknown[], o: { label: string; company: string | null; why: boolean }): any[] {
  const want = new Set([...words(o.label), ...words(o.company ?? "")]);
  return confirmedFacts(facts)
    .filter((f) => (BASE_KINDS.has(String(f.kind)) || (o.why && f.kind === "preference")) && words(factText(f)).length >= 3)
    .map((f, i) => ({ f, i, s: words(factText(f)).filter((w) => want.has(w)).length }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 8)
    .map((x) => x.f);
}
const WHY = /\bwhy\b|\binterest|\bexcite|\bdrew you|\bwant to (work|join)/i;
export function whatWouldHelp(label: string, company: string | null): string {
  if (WHY.test(label)) {
    return `a job or project you're proud of, with what it achieved, and what you want next in your work${company ? ` (and what draws you to ${company})` : ""}`;
  }
  return "a project you led or a job you held, with what it achieved (a number if there is one)";
}

// ---------------------------------------------------------------------------------------------------------------------
// Length: the form's own words ("in 150 words or less", "max 500 characters", "in 1-3 sentences"); else 250 words.
export function lengthLimit(label: string): Limit {
  const t = String(label ?? "").toLowerCase().replace(/,(?=\d{3})/g, "");
  const num = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[m.length - 1]) : null; };
  const w = num(/\b(?:in|under|within|max(?:imum)?|up to|no more than|less than|fewer than|at most|limit(?:ed)? to|(?:word )?limit:?)\s*(?:of\s*)?(\d{2,4})\s*words?\b/) ??
    num(/\b(\d{2,4})\s*(?:-\s*)?words?\s*(?:or (?:less|fewer)|max(?:imum)?|limit|or under)\b/) ?? num(/\b(\d{2,4})-word\b/);
  const c = num(/\b(?:in|under|within|max(?:imum)?|up to|no more than|less than|fewer than|at most|limit(?:ed)? to|(?:character )?limit:?)\s*(?:of\s*)?(\d{2,5})\s*char(?:acter)?s?\b/) ??
    num(/\b(\d{2,5})\s*char(?:acter)?s?\s*(?:or (?:less|fewer)|max(?:imum)?|limit)\b/);
  const s = num(/\bin\s*(?:\d\s*-\s*)?(\d{1,2})\s*sentences?\b/) ?? num(/\b(?:no more than|at most|up to|max(?:imum)?)\s*(\d{1,2})\s*sentences?\b/);
  const stated = w !== null || c !== null || s !== null;
  return { words: w ?? (stated ? null : DEFAULT_WORDS), chars: Math.min(c ?? HARD_CHARS, HARD_CHARS), sentences: s, stated };
}
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const countSentences = (s: string) => (W.splitSentences(s) as string[]).length;
export function overLimit(text: string, l: Limit): string | null {
  if (l.words !== null && countWords(text) > l.words) return `it was ${countWords(text)} words and the limit is ${l.words}`;
  if (text.length > l.chars) return `it was ${text.length} characters and the limit is ${l.chars}`;
  if (l.sentences !== null && countSentences(text) > l.sentences) return `it was ${countSentences(text)} sentences and the limit is ${l.sentences}`;
  return null;
}
const limitWords = (l: Limit) =>
  [l.words !== null ? `at most ${l.words} words` : "", `at most ${l.chars} characters`, l.sentences !== null ? `at most ${l.sentences} sentences` : ""]
    .filter(Boolean).join(", ");

// ---------------------------------------------------------------------------------------------------------------------
// The fact-lock. 154's extractCheckables finds numbers, dates and capitalized names; this adds what it does not see in
// an application answer: possessive names ("Stripe's"), mixed-case and versioned tools (JavaScript, PostgreSQL, EC2),
// lowercase tools, job titles, degrees, scale words ("doubled", "millions"), units on a number ("$2M" is not "$2K"),
// percents, and bare month names. Each must appear, as words, in a confirmed fact or the posting's own text.
export function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/'/g, "").replace(/[^a-z0-9+#$%]+/g, " ").replace(/\s+/g, " ").trim();
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWords = (corpus: string, phrase: string) => {
  const p = norm(phrase);
  return !!p && new RegExp(`(^| )${esc(p)}( |$)`).test(corpus);
};
const UNIT: Record<string, string> = { k: "k", thousand: "k", m: "m", mm: "m", million: "m", millions: "m", b: "b", bn: "b", billion: "b", billions: "b", x: "x" };
const scaled = (s: string) => {
  const out: string[] = [];
  for (const m of String(s).toLowerCase().matchAll(/\$?(\d[\d,]*(?:\.\d+)?)\s?(k|m|mm|b|bn|thousand|millions?|billions?|x)\b/g)) out.push(`${m[1].replace(/,/g, "")}${UNIT[m[2]]}`);
  return out;
};
const percents = (s: string) => [...String(s).toLowerCase().matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent\b)/g)].map((m) => `${m[1].replace(/,/g, "")}%`);
export const TOOLS = [
  "python", "java", "javascript", "typescript", "sql", "nosql", "excel", "tableau", "looker", "power bi", "salesforce", "hubspot", "kubernetes",
  "docker", "terraform", "aws", "gcp", "azure", "react", "angular", "vue", "node", "django", "flask", "rails", "ruby", "golang", "rust", "kotlin",
  "swift", "scala", "matlab", "pytorch", "tensorflow", "pandas", "numpy", "spark", "hadoop", "airflow", "dbt", "snowflake", "bigquery",
  "redshift", "postgres", "postgresql", "mysql", "mongodb", "redis", "kafka", "graphql", "figma", "jira", "netsuite", "quickbooks", "sap",
  "oracle", "workday", "stripe", "shopify", "zendesk", "marketo", "segment", "amplitude", "mixpanel", "linux", "c++", "c#", "php", "perl",
];
export const TITLES = [
  "engineer", "engineering manager", "manager", "director", "analyst", "scientist", "designer", "founder", "cofounder", "co founder", "intern",
  "vice president", "vp", "president", "ceo", "cto", "cfo", "coo", "chief", "principal", "staff", "senior", "junior", "consultant", "controller",
  "accountant", "architect", "recruiter", "researcher", "professor", "developer", "head of", "team lead", "tech lead", "associate", "partner",
  "specialist", "coordinator", "administrator", "officer", "fellow",
];
export const DEGREES = ["bachelor", "bachelors", "master", "masters", "mba", "phd", "doctorate", "bsc", "msc", "degree", "diploma", "valedictorian", "summa cum laude", "magna cum laude", "cum laude", "dean s list", "deans list"];
export const SCALE = ["doubled", "tripled", "quadrupled", "halved", "tenfold", "twofold", "threefold", "dozens", "hundreds", "thousands", "millions", "billions"];
// Ordinary words that open a sentence and so are capitalized there; 154 keeps its own list, these are the ones an
// application answer adds. A name is never one of them.
const STARTERS = new Set("leading managing owning shipping designing running teaching selling scaling launching across through during outside beyond together ultimately early lately later most much both since before after over three four five".split(" "));

export interface Lock { pass: boolean; untraced: string[] }
export function factLock(text: string, sources: string[]): Lock {
  const raw = sources.join(" \n ");
  const corpus = norm(raw);
  const nums = new Set<string>();
  for (const m of raw.matchAll(/\d[\d,]*(?:\.\d+)?/g)) nums.add(m[0].replace(/,/g, ""));
  const untraced: string[] = [];
  const miss = (v: string) => { if (!untraced.some((u) => norm(u) === norm(v))) untraced.push(v); };
  // 154's checkables: numbers (digits and spelled with a unit), dates, capitalized names.
  for (const c of W.extractCheckables(text) as { type: string; value: string; numeric?: number; sentence: string }[]) {
    if (c.type === "entity" && !c.value.includes(" ") && STARTERS.has(c.value.toLowerCase()) && c.sentence.trim().startsWith(c.value)) continue;
    if (c.type === "number") {
      // TAILORING ROUND 2: 154 reads "thirty-three percent" as "three percent"; the number said is the whole compound.
      const tens = c.numeric != null && c.numeric < 10 ? new RegExp(`\\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-${esc(c.value.toLowerCase())}\\b`).exec(c.sentence.toLowerCase()) : null;
      if (tens) {
        const whole = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }[tens[1]]! + c.numeric!;
        if (!nums.has(String(whole)) && !hasWords(corpus, tens[0])) miss(tens[0]);
        continue;
      }
      const ok = c.numeric != null ? nums.has(String(c.numeric)) || hasWords(corpus, c.value) : nums.has(c.value.replace(/[$,%]/g, ""));
      if (!ok) miss(c.value);
    } else if (!hasWords(corpus, c.value)) {
      const toks = norm(c.value).split(" ").filter((t) => t.length >= 3 && !["the", "of", "in", "at", "and"].includes(t));
      if (!(c.type === "entity" && toks.length && toks.every((t) => hasWords(corpus, t)))) miss(c.value);
    }
  }
  // Possessive names, which 154's run splitter drops ("Stripe's" is not a capitalized word to it), and any capitalized
  // word inside a sentence, which it drops when punctuation sticks to it ("an MBA from Stanford.").
  for (const m of text.matchAll(/\b([A-Z][A-Za-z&.]+)['’]s\b/g)) if (!hasWords(corpus, m[1])) miss(m[1]);
  for (const s of W.splitSentences(text) as string[]) {
    for (const m of s.matchAll(/(?<=\s)([A-Z][A-Za-z&]*[A-Za-z])(?![A-Za-z'’])/g)) {
      if (m[1] !== "I" && !hasWords(corpus, m[1])) miss(m[1]);
    }
  }
  // Mixed case, digits in a word, dotted or plus-signed tools: JavaScript, PostgreSQL, iOS, EC2, GPT-4, Node.js, C++.
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([BM]\.\s?(?:A|S|Sc|Eng)\.|Ph\.\s?D\.?|M\.B\.A\.|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|[A-Za-z]+\d+[A-Za-z0-9]*|[A-Za-z]+-\d+[A-Za-z0-9]*|[A-Za-z]+\.(?:js|io|ai|net)|C\+\+|C#|\.NET)(?![A-Za-z0-9])/g)) {
    if (!hasWords(corpus, m[1])) miss(m[1]);
  }
  const low = ` ${norm(text)} `;
  for (const list of [TOOLS, TITLES, DEGREES, SCALE]) {
    // TAILORING ROUND 2: a title said of someone else ("my manager said", "reported to the head of sales", "your Google
    // Cloud Engineer role") is no claim about the person (person_claims.ts roleFraming); said of them, it must be traced.
    for (const w of list) if (low.includes(` ${norm(w)} `) && !hasWords(corpus, w) && (list !== TITLES || selfRole(text, w))) miss(w);
  }
  const corpusScaled = new Set(scaled(raw)), corpusPct = new Set(percents(raw));
  for (const v of scaled(text)) if (!corpusScaled.has(v)) miss(v);
  for (const v of percents(text)) if (!corpusPct.has(v)) miss(v);
  // A month named on its own ("last March"); "may" the verb is lowercase and never counted.
  for (const m of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g)) {
    const at = m.index ?? 0;
    if (m[1] === "May" && /(^|[.!?]\s+)$/.test(text.slice(0, at))) continue;
    if (!hasWords(corpus, m[1])) miss(m[1]);
  }
  return { pass: untraced.length === 0, untraced };
}

// ---------------------------------------------------------------------------------------------------------------------
// The model's words, read back. A reply cut off by the token limit, or ending mid-sentence, is not a draft.
function textOf(msg: any): { text: string; cut: boolean } {
  const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("")
    .trim().replace(/^["“]([\s\S]*)["”]$/, "$1").trim();
  return { text, cut: msg?.stop_reason === "max_tokens" || !/[.!?]["”')\]]?$/.test(text) };
}
const SYSTEM = [
  "You write one answer to a job application question, for the person applying, in their own plain first-person voice.",
  "Rules that do not bend:",
  "1. Use ONLY the facts listed. Every employer, school, title, degree, tool, number, date and result you say about the person must appear in those facts. The question and the company name are what you answer, never a source of facts about the person: never say the person did, studied, holds or is anything only because the question mentions it. Never state work authorization, citizenship, a visa, sponsorship, salary, or anything about gender, race, ethnicity, veteran status or disability unless a fact says it. If the answer would need something the facts do not say, leave that part out; never fill a gap with something plausible.",
  "2. Stay inside the length limit and finish every sentence.",
  "3. No greeting, sign-off, heading, list or quotation marks. Return only the answer text.",
  "4. Never mention AI, Upmore or that this is a draft. No stock phrases (\"I am excited to apply\", \"passionate\", \"in today's fast-paced world\").",
].join("\n");
export function draftPayload(o: { q: EssayQuestion; facts: any[]; limit: Limit; previous?: string | null; fix?: string[] }) {
  const lines = [
    o.q.company ? `Company: ${o.q.company}` : "",
    `Question: ${o.q.label.replace(/\s+/g, " ").trim()}`,
    `Length: ${limitWords(o.limit)}.`,
    "The person's confirmed facts (the only material you may use):",
    ...o.facts.map((f) => `- [${[factId(f), f.kind].filter(Boolean).join(", ")}] ${factText(f)}`),
    o.previous ? `\nWrite a different version from this earlier one:\n${o.previous}` : "",
    o.fix?.length ? `\nYour last version broke these rules. Write it again without breaking them:\n${o.fix.map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean);
  return { system: SYSTEM, messages: [{ role: "user", content: lines.join("\n") }], max_tokens: 900, temperature: 0.5 };
}

// ---------------------------------------------------------------------------------------------------------------------
// The employer's policy, then gate0 (154) over it: a ban or an unread policy is recorded on the context as a ban, so
// gate0's own rule ("absence of a found prohibition is not permission" for its program contexts) and any registry
// entry still refuse first. An employer's application question is employer application material, gate0's cover_letter
// context; with no statement on the form the draft is offered for the person to edit.
export function employerGate(q: EssayQuestion, siblingLabels: string[]) {
  const policy = readAiPolicy([q.label, q.ai_policy ?? "", ...siblingLabels]);
  const gate = W.gate0({
    kind: "cover_letter",
    program: q.company ?? undefined,
    contextName: q.company ?? undefined,
    aiPolicy: policy.policy === "prohibited" || policy.policy === "unread" ? "ban" : policy.policy === "allowed" ? "AI_OK" : undefined,
    aiPolicySource: policy.said ? `the employer's form: "${policy.said.slice(0, 200)}"` : undefined,
  });
  return { policy, gate };
}

// The facts that may carry this answer. A cover letter says what the person wants next too (FRS), as a "why us" answer does.
const factsFor = (all: unknown[], q: EssayQuestion) =>
  relevantFacts(all, { label: q.label, company: q.company, why: WHY.test(q.label) || /\bcover letter\b/i.test(q.label) });

// limitText: the field's own limit when the form states it outside the label (WO-049: the card sends the field's maxlength
// as "max 500 characters"); read with the label by lengthLimit, never shown to the model as part of the question.
export async function draftEssay(o: {
  q: EssayQuestion; siblingLabels: string[]; deps: DraftDeps; previous?: string | null; limitText?: string;
}): Promise<DraftOutcome> {
  const { policy, gate } = employerGate(o.q, o.siblingLabels);
  if (!gate.allowed) return { ok: false, why: "policy", policy, detail: [gate.reason], tries: 0 };
  let all: unknown[];
  try { all = await o.deps.facts(); }
  catch (e) { return { ok: false, why: "model", policy, detail: [`could not read your facts: ${e instanceof Error ? e.message : String(e)}`], tries: 0 }; }
  const facts = factsFor(all, o.q);
  if (facts.length < MIN_FACTS) return { ok: false, why: "thin", policy, detail: [String(facts.length)], tries: 0 };
  const limit = lengthLimit(o.limitText ? `${o.q.label} ${o.limitText}` : o.q.label);
  const sources = { facts: facts.map(factText), posting: [o.q.company ?? "", o.q.label] };
  let fix: string[] = [], last: Judged | null = null;
  for (let tries = 1; tries <= 2; tries++) {
    let msg: any;
    try { msg = await o.deps.model(draftPayload({ q: o.q, facts, limit, previous: o.previous, fix })); }
    catch (e) { return { ok: false, why: "model", policy, detail: [e instanceof Error ? e.message : String(e)], tries }; }
    const { text, cut } = textOf(msg);
    if (!text) return { ok: false, why: "model", policy, detail: ["the model returned no text"], tries };
    const j = judge(text, cut, sources, limit);
    if (j.pass) return { ok: true, text, policy, factIds: facts.map(factId).filter(Boolean), limit, tries };
    last = j;
    fix = [
      ...(j.lock.pass ? [] : [`It named things that are not in the facts: ${j.lock.untraced.join("; ")}. Leave them out entirely; do not rephrase them.`]),
      ...(j.long ? [`It was too long: ${j.long}. Write a shorter answer; never cut a sentence off.`] : []),
      ...(j.cut ? ["It stopped in the middle of a sentence. Write a complete, shorter answer."] : []),
      ...(j.banned.length ? [`It used stock phrases: ${j.banned.join("; ")}.`] : []),
    ];
  }
  return failed(last, policy, 2);
}

// Every check a draft must pass before anyone reads it: each name and number traced to the sources, inside the limit,
// finished, no stock phrase.
// TAILORING SCENARIOS (2026-10-29): the posting (the question, the company) may be named in an answer but is never a source
// of a claim about the person. factLock traces names against facts and posting alike; claimProblems (person_claims.ts)
// then holds every claim about the person (a degree, a title, a tool, a number, leadership, work authorization, how they
// identify, a secret, a posting's name as their employer or school) to their confirmed facts alone.
interface Judged { pass: boolean; lock: Lock; long: string | null; cut: boolean; banned: string[] }
const CLAIM_VOCAB = [...TOOLS, ...TITLES, ...DEGREES, ...SCALE];
function judge(text: string, cut: boolean, sources: { facts: string[]; posting: string[] }, limit: Limit): Judged {
  const traced = factLock(text, [...sources.facts, ...sources.posting]);
  // The company's own name is never a claim, even when it is also a tool's or a word's ("why Stripe", "why Visa").
  const claims = claimProblems(text, { record: sources.facts, mentionable: sources.posting, vocab: CLAIM_VOCAB, company: sources.posting[0] });
  // A secret in the text is named as one, never quoted: its digits or words are not repeated in the reply the person
  // reads, nor in the "write it again" note the model gets.
  const redacted = redactIdentity(text);
  const shown = (u: string) => {
    if (!redacted.removed.length) return true;
    const v = norm(/"([^"]+)"/.exec(u)?.[1] ?? u);
    return !v || !norm(text).includes(v) || norm(redacted.text).includes(v);
  };
  const untraced = [...traced.untraced, ...claims].filter(shown);
  const lock: Lock = claims.length || !traced.pass ? { pass: false, untraced } : traced;
  const long = overLimit(text, limit);
  const banned = W.slopGate(text, { factPack: [] }).metrics.banned_phrases.value.hard as string[];
  return { pass: lock.pass && !long && !cut && !banned.length, lock, long, cut, banned };
}
const failed = (j: Judged | null, policy: AiPolicy, tries: number): DraftOutcome =>
  j && !j.lock.pass ? { ok: false, why: "unverified", policy, detail: j.lock.untraced, tries }
    : { ok: false, why: "too_long", policy, detail: [j?.long ?? (j?.cut ? "it kept stopping mid-sentence" : "it kept using stock phrases")], tries };

// G4: a draft written before the person asked (workers/career-browser/prepare-ahead.ts) is shown only if it passes, now,
// every check draftEssay makes: the employer's policy (with the posting's questions as they are now) and the person's
// confirmed facts as they are now (a fact they have since removed or not confirmed supports nothing). No model is called.
export async function checkDraft(o: {
  q: EssayQuestion; siblingLabels: string[]; deps: Pick<DraftDeps, "facts">; text: string; limitText?: string;
}): Promise<DraftOutcome> {
  const { policy, gate } = employerGate(o.q, o.siblingLabels);
  if (!gate.allowed) return { ok: false, why: "policy", policy, detail: [gate.reason], tries: 0 };
  let all: unknown[];
  try { all = await o.deps.facts(); }
  catch (e) { return { ok: false, why: "model", policy, detail: [`could not read your facts: ${e instanceof Error ? e.message : String(e)}`], tries: 0 }; }
  const facts = factsFor(all, o.q);
  if (facts.length < MIN_FACTS) return { ok: false, why: "thin", policy, detail: [String(facts.length)], tries: 0 };
  const limit = lengthLimit(o.limitText ? `${o.q.label} ${o.limitText}` : o.q.label);
  const text = String(o.text ?? "").trim();
  const j = judge(text, !/[.!?]["”')\]]?$/.test(text), { facts: facts.map(factText), posting: [o.q.company ?? "", o.q.label] }, limit);
  return j.pass ? { ok: true, text, policy, factIds: facts.map(factId).filter(Boolean), limit, tries: 0 } : failed(j, policy, 0);
}

// What the person reads. The draft is always shown whole; nothing is saved here.
const who = (q: { company: string | null }) => q.company ? `${q.company}'s form` : "This employer's form";
const quote = (s: string | null) => s ? ` ("${s.length > 90 ? `${s.slice(0, 87)}...` : s}")` : "";
export function draftReply(n: number, q: EssayQuestion, d: DraftOutcome): string {
  if (d.ok) {
    const why = d.policy.policy === "allowed"
      ? `${who(q)} allows AI help${quote(d.policy.said)}. It's still yours to edit.`
      : `${who(q)} doesn't say whether AI help is allowed, so this is a draft for you to edit, not a finished answer.`;
    return [
      `Draft for ${n}, written only from your confirmed facts${d.factIds.length ? ` (${d.factIds.join(", ")})` : ""}. ${why} Nothing is saved yet.`,
      "",
      d.text,
      "",
      `Reply "use ${n}" to save it as your answer, "redo ${n}" for another version, or "${n}" and your own words.`,
    ].join("\n");
  }
  const own = `Reply "${n}" and your own answer whenever you're ready.`;
  switch (d.why) {
    case "policy":
      if (d.policy?.policy === "unread") {
        return `${who(q)} has its own AI policy for applications${quote(d.policy.said)} and doesn't show what it allows, so I won't draft ${n}: it needs your own words. ${own}`;
      }
      if (d.policy?.policy === "prohibited") {
        return `${q.company ?? "This employer"} asks for answers written without AI${quote(d.policy.said)}, so I won't draft ${n}: it needs your own words. ${own}`;
      }
      return `${d.detail[0] ?? "This application doesn't allow AI-written answers."} ${own}`;
    case "thin":
      return `I can't draft ${n} yet: only ${d.detail[0]} of your confirmed facts fit it, and I need at least ${MIN_FACTS} so nothing is made up. Tell me ${whatWouldHelp(q.label, q.company)}, confirm it, then say "draft ${n}" again. Or: ${own}`;
    case "unverified":
      return `I didn't show a draft for ${n}: it kept including things you haven't confirmed (${d.detail.join("; ")}). If any of that is true, tell me and confirm it, then say "draft ${n}" again. Or: ${own}`;
    case "too_long":
      return `I couldn't write ${n} inside the form's limit (${d.detail[0]}), and I don't cut answers off mid-sentence, so there's no draft. ${own}`;
    default:
      return `I couldn't draft ${n} right now, so nothing changed and ${n} is still open. Try "draft ${n}" again in a few minutes, or: ${own}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The texts that act on a draft. Each is the whole message, so an answer that merely starts with "use" or "write" is
// still an answer: "draft 2", "write 2 for me", "can you draft it", "redo 2", "draft 2 again", "use 2", "use draft 2".
export type DraftCommand = { act: "draft" | "redo" | "use"; n: number | null };
const PRE = "(?:(?:please|pls|can you|could you|would you|will you|ok|okay|yes|yeah|sure|go ahead and|and|then|just) )*";
const FILL = "(?:(?:me|a|the|an|my|your|that|this) )*(?:(?:draft|answer|version|response|question|number|no\\.?)(?: (?:of|for|to))? )*";
const NUM = "#?(\\d{1,2}|it|that|this|that one|this one)";
const POST = "(?: (?:for me|please|pls|thanks|thank you|as (?:my|the) answer|instead|then|now))*";
const REDO = [
  new RegExp(`^${PRE}(?:redo|rewrite|retry|redraft)(?: me)? ${FILL}${NUM}${POST}$`),
  new RegExp(`^${PRE}(?:draft|write)(?: me)? ${FILL}${NUM} again${POST}$`),
  new RegExp(`^${PRE}(?:try|give me another (?:draft|version)(?: (?:of|for))?|another (?:draft|version)(?: (?:of|for))?) ${NUM}(?: again)?${POST}$`),
];
const DRAFT = new RegExp(`^${PRE}(?:draft|write)(?: me)? ${FILL}${NUM}${POST}$`);
const USE = new RegExp(`^${PRE}(?:use|keep|save|take|go with)(?: (?:your|the|my|that|this))? ${FILL}${NUM}${POST}$`);
export function parseDraftCommand(text: string): DraftCommand | null {
  const t = String(text ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60) return null;
  const pick = (m: RegExpExecArray | null, act: DraftCommand["act"]): DraftCommand | null =>
    m ? { act, n: /^\d+$/.test(m[1]) ? Number(m[1]) : null } : null;
  for (const re of REDO) { const c = pick(re.exec(t), "redo"); if (c) return c; }
  return pick(DRAFT.exec(t), "draft") ?? pick(USE.exec(t), "use");
}
