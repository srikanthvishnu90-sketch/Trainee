// FEATURE 5 (2026-10-25): job search that ranks by fit and explains it, on the live path.
//
// Before this, "find me data analyst jobs in Chicago" reached only the regex router's discovery, which scores the 600
// newest rows of the frozen career_kb_postings snapshot; searchPostings (career_search.ts: fitOf, goalScore, titleTier)
// over career_postings was reachable only by the brain, which is pinned off (DIAGNOSIS 2.9). This module is what the
// production handler calls after the router has decided a turn is a role search:
//
//   1. Source. The live board (career_postings) when it holds an open posting that matches; else the saved snapshot
//      (career_kb_postings), read by the asked role and place, plus the turn's snapshot window. The reply says which,
//      and how fresh: "From 37 live postings that match, first seen in the last 6 days."
//   2. Pre-filter. searchPostings ranks the matches by title, goal and fit to the person's CONFIRMED facts; the top N
//      (default 20) go on.
//   3. Judge (CAREER_JUDGE=on only, metered by the caller, cached per posting and profile hash). One model call rates
//      every uncached posting on the scale below with a one-line reason. Code keeps a verdict only when it is on the
//      scale and its reason names nothing that is not in the posting or the person's confirmed facts; anything else is
//      "not judged", with why. Off, failed or unanswered, the list is the fit order and the reply says it was not judged.
//   4. Account. "18/20 judged; 6 strong, 5 fair; 7 dropped as weak/no", every posting not judged with its reason.
//
// The person's own judge instructions ("judge prompt: ..."), kept as a standing instruction (career:standing, wiped by
// an erase), go to the judge with every search. They can shape a verdict, never the grounding rule or the scale.
// Nothing here sends, applies or writes anywhere but the person's own cache and standing instructions.
import { searchPostings, type SearchHit } from "./career_search.ts";
import { searchWords, wordStem } from "./career_ingest.ts";
import { hasLimits, type Limits, limitsLine, outsideLimits, REASON_WORDS, type Reason, searchTextOf, statedBand, statedPay } from "./posting_constraints.ts";
import { CareerPool } from "./career_pool.js";
import { CareerProfile } from "./router_core.career.js";
import { addStanding, type MemoryStore, type Standing } from "./agent/memory.ts";

// ------------------------------------------------------------------------------------------------ the scale (ONE place)
// The judge's fixed four-word scale, worst to best. The model is given exactly these words and their meanings; code
// accepts nothing else. Kept: fair and strong. Dropped: no and weak.
export const JUDGE_SCALE = ["no", "weak", "fair", "strong"] as const;
export type Verdict = typeof JUDGE_SCALE[number];
export const JUDGE_MEANING: Record<Verdict, string> = {
  no: "the posting asks for something the person's confirmed facts rule out, or is a different kind of work",
  weak: "the same kind of work, but most of what it asks for is not in the person's confirmed facts",
  fair: "a reasonable match: some of what it asks for is in the person's confirmed facts, some is not",
  strong: "most of what it asks for is in the person's confirmed facts",
};
export const KEPT_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["fair", "strong"]);
export function verdictOf(v: unknown): Verdict | null {
  const s = String(v ?? "").trim().toLowerCase();
  return (JUDGE_SCALE as readonly string[]).includes(s) ? s as Verdict : null;
}
export const verdictRank = (v: Verdict) => JUDGE_SCALE.indexOf(v);

export const JUDGE_DEFAULT_N = 20, JUDGE_MAX_N = 40, REASON_MAX = 160, CACHE_MAX = 500;
// Bumped when the prompt or the scale changes, so an old cached verdict is never read as a new one.
export const JUDGE_VERSION = "f05-1";

// ------------------------------------------------------------------------------------------------ judgments and accounting
export interface Judgment { job_id: string; verdict: Verdict | null; reason: string | null; why_not?: string; from?: "model" | "cache" }
export interface Accounting {
  sent: number; judged: number; counts: Record<Verdict, number>; kept: number; dropped: number;
  unjudged: { job_id: string; why: string }[];
}
export function accountFor(sent: string[], judgments: Map<string, Judgment>): Accounting {
  const counts = Object.fromEntries(JUDGE_SCALE.map((v) => [v, 0])) as Record<Verdict, number>;
  const unjudged: { job_id: string; why: string }[] = [];
  for (const id of sent) {
    const j = judgments.get(id);
    if (j && j.verdict) counts[j.verdict]++;
    else unjudged.push({ job_id: id, why: j?.why_not || "the judge returned nothing for it" });
  }
  const judged = sent.length - unjudged.length;
  const kept = JUDGE_SCALE.filter((v) => KEPT_VERDICTS.has(v)).reduce((n, v) => n + counts[v], 0);
  return { sent: sent.length, judged, counts, kept, dropped: judged - kept, unjudged };
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "18/20 judged; 6 strong, 5 fair; 7 dropped as weak/no; 2 not judged (the reason named something not in the posting or
// your profile)". Every posting sent is in exactly one of the counts.
export function accountingLine(a: Accounting): string {
  const keptWords = [...JUDGE_SCALE].reverse().filter((v) => KEPT_VERDICTS.has(v)).map((v) => `${a.counts[v]} ${v}`).join(", ");
  const droppedWords = [...JUDGE_SCALE].reverse().filter((v) => !KEPT_VERDICTS.has(v)).join("/");
  let line = `${a.judged}/${a.sent} judged; ${keptWords}; ${a.dropped} dropped as ${droppedWords}`;
  if (a.unjudged.length) {
    const whys = [...new Set(a.unjudged.map((u) => u.why))];
    line += `; ${a.unjudged.length} not judged (${whys.join("; ")})`;
  }
  return line;
}

// ------------------------------------------------------------------------------------------------ grounding
// A reason is kept only when it is one short line and every name or number in it is in the posting or the person's
// confirmed facts. A name is a capitalised word, or a word with a digit; a sentence's first word is a name too unless it is
// one of the plain openers below ("Asks for SQL", "Most of it"), so "Google alumni do well here" is caught. A reason that
// names an employer, a school, a skill or a figure from nowhere is the model inventing, and the posting is "not judged".
const PLAIN = new Set(["i", "you", "your", "yours", "the", "a", "an", "it", "its", "this", "that", "these", "those", "no", "not", "and", "or",
  "but", "both", "us", "asks", "ask", "needs", "need", "requires", "require", "wants", "expects", "lists", "matches", "match", "fits", "fit",
  "most", "some", "none", "little", "few", "many", "much", "all", "only", "mostly", "partly", "largely", "nothing", "same", "different",
  "close", "good", "strong", "fair", "weak", "role", "posting", "job", "work", "experience", "profile", "facts", "skills", "there", "here",
  "nearly", "about", "also", "unclear", "missing", "senior", "junior", "entry", "level", "requirements", "requirement", "in", "on", "for",
  "with", "without", "has", "have", "is", "are", "yes", "though", "however", "while", "although", "location", "remote", "onsite", "hybrid"]);
export function groundingProblem(reason: unknown, sources: string[]): string | null {
  const r = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!r) return "the judge gave no reason";
  if (r.length > REASON_MAX) return "the reason ran past one line";
  const hay = sources.join(" \n ").toLowerCase();
  for (const m of r.matchAll(/[A-Za-z0-9][A-Za-z0-9+#.]*/g)) {
    const w = m[0].replace(/\.+$/, ""), before = r.slice(0, m.index).trimEnd();
    const opener = before === "" || /[.!?;:]$/.test(before);
    const named = /\d/.test(w) || (/^[A-Z]/.test(w) && !(opener && PLAIN.has(w.toLowerCase())) && !(!opener && ["I"].includes(w)));
    if (!named) continue;
    if (!hay.includes(w.toLowerCase())) return "the reason named something not in the posting or your profile";
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the person's judge prompt
// Kept as a standing instruction whose text starts with "Judge:", so it lives with the rest of what the person said must
// hold, and an erase removes it. At most one: a new one replaces the old.
export const JUDGE_PREFIX = "Judge: ";
export function judgeInstructionsOf(standing: Standing[]): string[] {
  return (standing ?? []).filter((s) => s && typeof s.text === "string" && s.text.startsWith(JUDGE_PREFIX))
    .map((s) => s.text.slice(JUDGE_PREFIX.length).trim()).filter(Boolean);
}
const SET_RE = /^\s*(?:(?:please\s+)?(?:set|save|use|make)\s+)?(?:my\s+)?(?:job\s+)?judge\s+prompt(?:\s+(?:to|is|as))?\s*[:,\-]?\s+(.+)$/is;
const WHEN_RE = /^\s*when\s+(?:you\s+)?(?:judge|rate|score|rank)\s+(?:jobs|roles|postings|job postings|openings)(?:\s+for\s+me)?\s*[:,\-]?\s+(.+)$/is;
const CLEAR_RE = /^\s*(?:please\s+)?(?:forget|clear|remove|delete|drop|reset)\s+(?:my\s+)?(?:job\s+)?judge\s+prompt\b/i;
const SHOW_RE = /^\s*(?:what(?:'s|\s+is)\s+my\s+(?:job\s+)?judge\s+prompt|show\s+(?:me\s+)?my\s+(?:job\s+)?judge\s+prompt)\s*\??\s*$/i;
export const JUDGE_PROMPT_INTENT = "career_judge_prompt";
export interface JudgePromptResult { reply: string; status: "saved" | "refused" | "cleared" | "none" | "shown" | "unreadable"; intent: string }
// Whether judgePromptTurn answers this message (no I/O): a "judge prompt: ..." instruction is code's, so the staged brain
// never takes it (D-035; the brain branch comes before the router branch that runs judgePromptTurn).
export function isJudgePromptAsk(message: string): boolean {
  const m = String(message ?? "");
  return SET_RE.test(m) || WHEN_RE.test(m) || CLEAR_RE.test(m) || SHOW_RE.test(m);
}

export async function judgePromptTurn(o: { message: string; userId: string; now: number; memory: MemoryStore; judgeOn: boolean }): Promise<JudgePromptResult | null> {
  const m = String(o.message ?? "");
  const set = SET_RE.exec(m) ?? WHEN_RE.exec(m), clear = CLEAR_RE.test(m), show = SHOW_RE.test(m);
  if (!set && !clear && !show) return null;
  const intent = JUDGE_PROMPT_INTENT;
  let items: Standing[];
  try { items = await o.memory.standing(o.userId); }
  catch { return { reply: "I couldn't read your saved instructions just now, so nothing was changed. Try again in a minute.", status: "unreadable", intent }; }
  const mine = judgeInstructionsOf(items);
  const when = o.judgeOn ? "Every search I run now judges the postings with it." : "It is saved; for now searches are ranked by how well each matches what you've confirmed, and it applies as soon as judging is switched on.";
  if (show) {
    return mine.length
      ? { reply: `Your judge prompt: "${mine[0]}". ${when}`, status: "shown", intent }
      : { reply: `You have no judge prompt. Say "judge prompt: ..." with what matters to you in a posting, and I'll judge postings with it.`, status: "none", intent };
  }
  const rest = items.filter((s) => !(typeof s.text === "string" && s.text.startsWith(JUDGE_PREFIX)));
  if (clear) {
    if (!mine.length) return { reply: "You have no judge prompt, so there was nothing to remove.", status: "none", intent };
    try { await o.memory.saveStanding(o.userId, rest); }
    catch { return { reply: "I couldn't save that just now, so your judge prompt is still kept. Try again in a minute.", status: "unreadable", intent }; }
    return { reply: "Removed your judge prompt. Postings are judged on the fixed scale and your confirmed facts only.", status: "cleared", intent };
  }
  const instruction = set![1].replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "");
  const r = addStanding(rest, { text: `${JUDGE_PREFIX}${instruction}`, said: m.slice(0, 300), now: o.now });
  if (!r.ok) return { reply: `Not kept: ${r.error.replace(/^Not kept:\s*/, "")}`, status: "refused", intent };
  try { await o.memory.saveStanding(o.userId, r.items); }
  catch { return { reply: "I couldn't save that just now, so nothing was changed. Try again in a minute.", status: "unreadable", intent }; }
  return { reply: `Saved as your judge prompt: "${instruction}". ${when} It can change a verdict, not the scale (${JUDGE_SCALE.join(", ")}) or the rule that every reason comes from the posting and your confirmed facts.`, status: "saved", intent };
}

// ------------------------------------------------------------------------------------------------ the cache
// One record per person and profile hash (career_watch_kv key career:judge:<hash>, service role only, wiped by an erase):
// the verdicts given for that exact set of confirmed facts and judge prompt. A new fact or a new prompt is a new hash.
export interface CachedVerdict { v: Verdict; r: string; at: string }
export interface JudgeCache {
  read(userId: string, key: string): Promise<Record<string, CachedVerdict>>;
  write(userId: string, key: string, verdicts: Record<string, CachedVerdict>): Promise<void>;
}
export function memoryJudgeCache(): JudgeCache & { dump(): Record<string, Record<string, CachedVerdict>> } {
  const st: Record<string, Record<string, CachedVerdict>> = {};
  return {
    async read(u, k) { return JSON.parse(JSON.stringify(st[`${u}|${k}`] ?? {})); },
    async write(u, k, v) { st[`${u}|${k}`] = JSON.parse(JSON.stringify(v)); },
    dump() { return JSON.parse(JSON.stringify(st)); },
  };
}
export function supabaseJudgeCache(admin: any): JudgeCache {
  const key = (k: string) => `career:judge:${k}`;
  return {
    async read(u, k) {
      const r = await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", key(k)).maybeSingle();
      if (r.error) throw new Error(`read the judge cache: ${r.error.message}`);
      const v = r.data?.value?.verdicts;
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    },
    async write(u, k, verdicts) {
      const r = await admin.from("career_watch_kv").upsert({ user_id: u, key: key(k), value: { verdicts, version: JUDGE_VERSION, updated_at: new Date().toISOString() } }, { onConflict: "user_id,key" });
      if (r.error) throw new Error(`save the judge cache: ${r.error.message}`);
    },
  };
}
export async function profileHash(facts: { kind?: string; text?: string }[], instructions: string[]): Promise<string> {
  const body = JSON.stringify({ v: JUDGE_VERSION, facts: facts.map((f) => `${f.kind ?? ""}:${f.text ?? ""}`).sort(), instructions });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------------------------------ the judge
export type Model = (payload: any) => Promise<any>;
export interface JudgeInput { job_id: string; title: string; company: string; location: string; text: string }
const factLine = (f: any) => `${f.kind ?? "fact"}: ${String(f.text ?? "").replace(/\s+/g, " ").trim()}`;
export function judgePayload(postings: JudgeInput[], facts: any[], instructions: string[]): any {
  const scale = JUDGE_SCALE.map((v) => `- ${v}: ${JUDGE_MEANING[v]}`).join("\n");
  const system = [
    "You judge how well job postings fit one person. Use only two sources: the posting text given, and the person's confirmed facts given. Never use anything else you know about the employer, the person or the field.",
    `Give each posting exactly one verdict from this scale:\n${scale}`,
    `For each posting, one plain reason of at most ${REASON_MAX - 40} characters that says which of the person's facts meet or miss what the posting asks. Name only things written in the posting or the facts. If the facts say nothing relevant, say that.`,
    instructions.length ? `The person's own judging instructions (follow them where they do not conflict with the rules above):\n${instructions.map((i) => `- ${i}`).join("\n")}` : "",
    "Answer with JSON only.",
  ].filter(Boolean).join("\n\n");
  const user = JSON.stringify({
    confirmed_facts: facts.map(factLine),
    postings: postings.map((p) => ({ id: p.job_id, title: p.title, company: p.company, location: p.location, text: p.text.slice(0, 1500) })),
  });
  return {
    system, max_tokens: Math.min(4000, 80 * postings.length + 200),
    messages: [{ role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "judgments", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["judgments"],
      properties: { judgments: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "verdict", "reason"],
        properties: { id: { type: "string" }, verdict: { type: "string", enum: [...JUDGE_SCALE] }, reason: { type: "string" } } } } },
    } } },
  };
}
export interface JudgeRun { judgments: Map<string, Judgment>; modelCalled: boolean; failed: string | null; cacheHits: number }
export async function judgePostings(o: {
  userId: string; now: number; postings: JudgeInput[]; facts: any[]; instructions: string[]; model: Model; cache?: JudgeCache | null;
}): Promise<JudgeRun> {
  const judgments = new Map<string, Judgment>();
  const key = await profileHash(o.facts, o.instructions);
  let cached: Record<string, CachedVerdict> = {};
  if (o.cache) { try { cached = await o.cache.read(o.userId, key); } catch (e) { console.error("career judge cache:", (e as Error)?.message ?? e); } }
  let hits = 0;
  const todo: JudgeInput[] = [];
  for (const p of o.postings) {
    const c = cached[p.job_id];
    if (c && verdictOf(c.v) && typeof c.r === "string") { judgments.set(p.job_id, { job_id: p.job_id, verdict: verdictOf(c.v), reason: c.r, from: "cache" }); hits++; }
    else todo.push(p);
  }
  if (!todo.length) return { judgments, modelCalled: false, failed: null, cacheHits: hits };
  const factText = o.facts.map((f) => String(f.text ?? ""));
  let failed: string | null = null, rows: any[] = [];
  try {
    const msg = await o.model(judgePayload(todo, o.facts, o.instructions));
    const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed?.judgments) ? parsed.judgments : [];
  } catch (e) {
    failed = e instanceof SyntaxError ? "the judge's answer could not be read" : "the judge did not answer";
    console.error("career judge:", (e as Error)?.message ?? e);
  }
  const byId = new Map(todo.map((p) => [p.job_id, p]));
  const fresh: Record<string, CachedVerdict> = {};
  for (const r of rows) {
    const p = byId.get(String(r?.id ?? ""));
    if (!p || judgments.has(p.job_id)) continue;
    const v = verdictOf(r.verdict);
    if (!v) { judgments.set(p.job_id, { job_id: p.job_id, verdict: null, reason: null, why_not: "the verdict was not on the scale" }); continue; }
    const reason = String(r.reason ?? "").replace(/\s+/g, " ").trim();
    const problem = groundingProblem(reason, [p.title, p.company, p.location, p.text, ...factText]);
    if (problem) { judgments.set(p.job_id, { job_id: p.job_id, verdict: null, reason: null, why_not: problem }); continue; }
    judgments.set(p.job_id, { job_id: p.job_id, verdict: v, reason, from: "model" });
    fresh[p.job_id] = { v, r: reason, at: new Date(o.now).toISOString() };
  }
  for (const p of todo) if (!judgments.has(p.job_id)) judgments.set(p.job_id, { job_id: p.job_id, verdict: null, reason: null, why_not: failed ?? "the judge returned nothing for it" });
  if (o.cache && Object.keys(fresh).length) {
    const merged = Object.entries({ ...cached, ...fresh }).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, CACHE_MAX);
    try { await o.cache.write(o.userId, key, Object.fromEntries(merged)); } catch (e) { console.error("career judge cache:", (e as Error)?.message ?? e); }
  }
  return { judgments, modelCalled: true, failed, cacheHits: hits };
}

// ------------------------------------------------------------------------------------------------ the sources
// A posting as searchPostings reads it, with where it came from.
export interface SourcePosting { job_id: string; company: string; title: string; location: string; url: string; description: string; first_seen_at: string | null; closed_at?: string | null; fetched_on?: string | null; pay?: string | null }
export interface SearchSources {
  // Open career_postings rows matching the words (the live board), newest first.
  live(words: string[], limit: number): Promise<SourcePosting[]>;
  // Whether the live board holds any open posting at all.
  liveHasRows(): Promise<boolean>;
  // Snapshot rows whose title carries every role word and whose location carries the place, newest first.
  snapshot(roleWords: string[], place: string | null, limit: number): Promise<SourcePosting[]>;
}
export function fromKbPosting(p: any): SourcePosting | null {
  if (!p || !p.job_id || !p.title) return null;
  return { job_id: String(p.job_id), company: p.company ?? "", title: String(p.title), location: p.location || "", url: p.url || "", description: p.jd_text || "", first_seen_at: p.posted_at || null, closed_at: null, fetched_on: p.fetched_on ?? null };
}
const like = (w: string) => `%${String(w).replace(/[%_\\]/g, "")}%`;
// The production sources: the service-role client the handler already holds, and the turn's snapshot window (the pool
// the router was given) merged under the targeted snapshot read.
export function supabaseSearchSources(admin: any, o: { window?: any[]; jobs?: any } = {}): SearchSources {
  return {
    async live(words, limit) {
      const base = () => admin.from("career_postings").select("*").is("closed_at", null);
      const lexemes = words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
      if (!lexemes.length) return [];
      const r = await base().textSearch("search", lexemes.join(" "), { type: "websearch", config: "english" }).order("first_seen_at", { ascending: false }).limit(limit);
      if (r.error) throw new Error(`search the live board: ${r.error.message}`);
      return (r.data ?? []) as SourcePosting[];
    },
    async liveHasRows() {
      const r = await admin.from("career_postings").select("job_id").is("closed_at", null).limit(1);
      if (r.error) throw new Error(`read the live board: ${r.error.message}`);
      return (r.data ?? []).length > 0;
    },
    async snapshot(roleWords, place, limit) {
      // The targeted read reaches past the window; when it fails, the window the router was given still answers, and
      // with nothing in the window the failure is thrown, so the turn says the source could not be read.
      let read: SourcePosting[] = [], failure: string | null = null;
      try {
        let q: any = admin.from(CareerPool.KB_POSTINGS_TABLE).select(CareerPool.KB_POSTINGS_COLUMNS);
        for (const w of roleWords) q = q.ilike("title", like(w));
        if (place) q = q.ilike("location", like(place));
        const r = await q.order("posted_at", { ascending: false, nullsFirst: false }).limit(limit);
        if (r.error) throw new Error(r.error.message);
        read = (r.data ?? []).map((row: any) => fromKbPosting(CareerPool.mapKbPosting(row, o.jobs ?? null))).filter(Boolean) as SourcePosting[];
      } catch (e) { failure = `search the snapshot: ${(e as Error)?.message ?? e}`; console.error("career search:", failure); }
      const seen = new Set(read.map((p) => p.job_id));
      const win = (o.window ?? []).map(fromKbPosting).filter((p): p is SourcePosting => !!p && !seen.has(p.job_id));
      if (failure && !win.length) throw new Error(failure);
      return [...read, ...win];
    },
  };
}

// ------------------------------------------------------------------------------------------------ the turn
export interface ShortlistEntry { id: string | null; title: string; company: string | null; location: string | null; url: string | null }
// limits: the level, pay floor, employer, season and sponsorship the person stated (posting_constraints.ts); remoteOnly: they
// asked for remote alone, not "this city or remote".
export interface SearchAsk { role: string; place: string | null; remote: boolean; remoteOnly?: boolean; limits?: Limits }
export interface SearchJudgeResult {
  reply: string; status: "ranked" | "judged" | "none"; source: "live" | "snapshot" | "none";
  shortlist: ShortlistEntry[]; accounting: Accounting | null; modelCalled: boolean;
}
export const SEARCH_INTENTS = new Set(["career_discovery", "career_internship_discovery"]);
// The ask, as the router parsed it this turn (discovery.lastParams, written by its handleDiscovery for this very text).
// Null when the router did not run a search on this message: a follow-up, a fit question, a chained turn.
// 2026-10-28 (search-parameter eval): the router's parse keeps a role only when the message ends in "roles/jobs/internships/
// openings" and a place only when capitalized after "in"; level, pay, employer, season and sponsorship were never carried.
// askFromRouter stays the router's own parse; askFor (below) reads the message again (posting_constraints.ts searchTextOf):
// what the message states wins, the router's parse fills what it does not say.
function enrich(message: string, base: SearchAsk | null): SearchAsk | null {
  const st = searchTextOf(message);
  const role = st.role || base?.role || "";
  if (!searchWords(role).length) return null;
  const orRemote = /\b(?:or|and|\/)\s*remote\b|\bremote\s*(?:or|and|\/)\s|\bhybrid\b/i.test(message);
  // The router's own spelling of the place ("Chicago") is kept when the message's reading is the same place in lower case.
  const place = base?.place && st.place && base.place.toLowerCase() === st.place.toLowerCase() ? base.place : st.place ?? base?.place ?? null, remote = st.remote || !!base?.remote;
  return { role, place, remote, remoteOnly: remote && !orRemote, limits: st.limits };
}
export function askFromRouter(message: string, routerOut: { intent?: string } | null, discovery: any): SearchAsk | null {
  if (!routerOut || !SEARCH_INTENTS.has(String(routerOut.intent ?? ""))) return null;
  const p = discovery?.lastParams;
  if (!p || typeof p.ask !== "string" || p.ask !== String(message ?? "").slice(0, 200)) return null;
  const role = typeof p.roleText === "string" ? p.roleText : "";
  if (!searchWords(role).length) return null;
  return { role, place: typeof p.whereText === "string" && p.whereText.trim() ? p.whereText.trim() : null, remote: !!p.remote };
}
// A search the router did not run: the message states a role and the router claimed nothing else for it (no intent, its
// fallback or catch-all, a goal it recorded, or a fact it recorded from the same sentence: "new grad backend, no sponsorship
// needed" was taken as a correction and never searched). `append`: the router's own reply is kept and the search follows it.
const UNCLAIMED = new Set(["", "undefined", "career_fallback", "career_catchall"]);
const ALSO = new Set(["career_goal_record", "intent_sensitive_correction", "profile_correction"]);
const SEARCH_CUE = /\b(?:find|search|show|looking|look|want|need|seeking|hiring|openings?|jobs?|roles?|positions?|interns?(?:hips?)?|new[- ]?grad|entry[- ]level|remote)\b|\$\s?\d/i;
export function searchAskFromMessage(message: string, routerOut: { intent?: string; resultStatus?: string } | null): { ask: SearchAsk; append: boolean } | null {
  const intent = String(routerOut?.intent ?? "");
  const open = UNCLAIMED.has(intent), also = ALSO.has(intent) && String(routerOut?.resultStatus ?? "") === "completed";
  if (!open && !also) return null;
  const text = String(message ?? "").trim();
  if (!text || text.length > 200 || /\?\s*$/.test(text)) return null;
  const ask = enrich(text, null);
  if (!ask || searchWords(ask.role).length > 6) return null;
  if (!SEARCH_CUE.test(text) && !ask.place && !ask.limits?.bands) return null;
  // Said with nothing that makes it a search for work (no level, pay, place, remote, employer or job word): not a search.
  if (!ask.limits?.bands && !ask.limits?.pay && !ask.place && !ask.remote && !/\b(?:jobs?|roles?|positions?|openings?|interns?(?:hips?)?)\b/i.test(text)) return null;
  return { ask, append: also };
}
const DAY = 86400000;
const where = (p: { location?: string | null }) => String(p.location ?? "").trim();
function inPlace(p: SourcePosting, ask: SearchAsk): boolean {
  const loc = where(p).toLowerCase();
  // "remote" alone, or "remote in Canada": only a remote posting (inside that place, when one is named).
  if (ask.remoteOnly) return /\bremote\b/.test(loc) && (!ask.place || loc.includes(ask.place.toLowerCase()));
  if (ask.place && loc.includes(ask.place.toLowerCase())) return true;
  if (ask.remote && /\bremote\b/.test(loc)) return true;
  return !ask.place && !ask.remote;
}
// "data internships" finds "Data Intern" titles: the shared stem of the two.
const roleWordsOf = (role: string) => [...new Set(searchWords(role).map((w) => /^intern(ship)?s?$/.test(w) ? "intern" : w))];
const asked = (ask: SearchAsk) => {
  const lim = ask.limits && hasLimits(ask.limits) ? limitsLine(ask.limits) : "";
  const role = ask.role.replace(/\s+(roles|jobs|openings|positions)$/i, "");
  return `${ask.remoteOnly ? "remote " : ""}${role}${ask.place ? ` in ${ask.place}` : ""}${ask.remote && !ask.remoteOnly ? `${ask.place ? " or" : ""} remote` : ""}${lim ? ` (${lim})` : ""}`;
};
// Postings the person's stated limits rule out (posting_constraints.ts), counted by reason; the rest stay.
function holdToLimits(pool: SourcePosting[], limits: Limits | undefined): { kept: SourcePosting[]; dropped: Partial<Record<Reason, number>>; noPay: number } {
  if (!limits || !hasLimits(limits)) return { kept: pool, dropped: {}, noPay: 0 };
  const dropped: Partial<Record<Reason, number>> = {}, kept: SourcePosting[] = [];
  for (const p of pool) { const r = outsideLimits(p, limits); if (r) dropped[r] = (dropped[r] ?? 0) + 1; else kept.push(p); }
  return { kept, dropped, noPay: limits.pay ? kept.filter((p) => !statedPay(p)).length : 0 };
}
const droppedLine = (d: Partial<Record<Reason, number>>) => Object.entries(d).map(([r, n]) => `${n} ${REASON_WORDS[r as Reason]}`).join(", ");

export async function searchJudgeTurn(o: {
  message: string; ask: SearchAsk; userId: string; now: number; profile: any; sources: SearchSources;
  judge: { on: boolean; model?: Model | null; cache?: JudgeCache | null; n?: number; standing?: () => Promise<Standing[]> };
  show?: number;
}): Promise<SearchJudgeResult | null> {
  const ask = o.ask, roleWords = roleWordsOf(ask.role), placeWords = ask.place ? searchWords(ask.place) : [];
  const show = Math.max(1, Math.min(12, o.show ?? 8));
  const N = Math.max(1, Math.min(JUDGE_MAX_N, Math.floor(Number(o.judge.n) || JUDGE_DEFAULT_N)));
  // 1. The source: the live board when it has a match, else the snapshot. A read that fails is said, never guessed.
  let source: "live" | "snapshot" | "none" = "none", pool: SourcePosting[] = [], liveNote = "";
  let liveRows: boolean | null = null;
  // What the person's stated limits (level, pay, season, employer, sponsorship) left out of the source used, and of the one
  // that matched the role and place but nothing after the limits.
  let held = holdToLimits([], ask.limits), heldAny: ReturnType<typeof holdToLimits> | null = null;
  try {
    const liveAll = (await o.sources.live([...searchWords(ask.role), ...placeWords], 300)).filter((p) => !p.closed_at && inPlace(p, ask));
    const h = holdToLimits(liveAll, ask.limits);
    if (liveAll.length && !h.kept.length) heldAny = h;
    if (h.kept.length) { source = "live"; pool = h.kept; held = h; }
    else liveRows = await o.sources.liveHasRows();
  } catch (e) { console.error("career search: live board", (e as Error)?.message ?? e); liveNote = "the live board could not be read just now"; }
  let snapshotFailed = false;
  if (source === "none") {
    try {
      const snapAll = (await o.sources.snapshot(roleWords.map(wordStem), ask.place, 300)).filter((p) => inPlace(p, ask));
      const h = holdToLimits(snapAll, ask.limits);
      if (snapAll.length && !h.kept.length) heldAny ??= h;
      if (h.kept.length) { source = "snapshot"; pool = h.kept; held = h; }
    } catch (e) { snapshotFailed = true; console.error("career search: snapshot", (e as Error)?.message ?? e); }
  }
  if (!liveNote && source !== "live") liveNote = liveRows ? "the live board has no match for it" : "the live board has no postings yet";
  // 2. The pre-filter: role first, then goal and fit to confirmed facts, then newest.
  const found = searchPostings(pool, roleWords.join(" "), o.profile, 50);
  const hits: SearchHit[] = found.postings;
  if (!hits.length) {
    // A source that could not be read is not evidence of no postings: the router's own reply stands.
    if (snapshotFailed || (source === "none" && liveRows === null)) return null;
    const leftOut = heldAny && droppedLine(heldAny.dropped) ? ` ${Object.values(heldAny.dropped).reduce((a, b) => a! + b!, 0)} matched the role and place but were left out: ${droppedLine(heldAny.dropped)}.` : "";
    const reply = `I found no posting for ${asked(ask)}: ${liveNote}, and the saved snapshot has none either.${leftOut} Nothing was invented to fill the list. Widen the role or the place and I'll search again.`;
    return { reply, status: "none", source: "none", shortlist: [], accounting: null, modelCalled: false };
  }
  const byId = new Map(pool.map((p) => [p.job_id, p]));
  const freshness = source === "live"
    ? (() => {
      const oldest = Math.min(...pool.map((p) => Date.parse(String(p.first_seen_at ?? ""))).filter(Number.isFinite));
      const days = Number.isFinite(oldest) ? Math.max(1, Math.ceil((o.now - oldest) / DAY)) : null;
      return `From ${plural(found.total, "live posting")} for ${asked(ask)}${days ? `, first seen in the last ${plural(days, "day")}` : ""}.`;
    })()
    : (() => {
      const fetched = pool.map((p) => String(p.fetched_on ?? "")).filter(Boolean).sort().at(-1);
      return `From ${plural(found.total, "posting")} for ${asked(ask)} in the saved snapshot of job boards${fetched ? ` (read ${fetched})` : ""}, not the live board: ${liveNote}. Some may have closed since.`;
    })();
  const facts = o.profile ? CareerProfile.confirmedFacts(o.profile) : [];
  // OWNER LIST #6 (2026-10-28): a fit is said in words, never as a raw score ("fit 12/100" read as a verdict on the person).
  const matchWord = (n: number | null) => n == null ? "match not scored" : n >= 75 ? "strong match" : n >= 55 ? "good match" : "partial match";
  const fitWord = (h: SearchHit) => h.fit ? (h.fit.excluded ? `not eligible on your confirmed facts (${h.fit.reasons[0] ?? "a hard requirement"})` : matchWord(h.fit.score)) : null;
  // A level was asked for and this posting's own text states none: it stays, and the line says so.
  const noLevel = (h: SearchHit) => !!ask.limits?.bands && statedBand(h.title, byId.get(h.job_id)?.description ?? "") === "unstated";
  const lineOf = (h: SearchHit, i: number, tail: string | null) =>
    `${i + 1}. ${h.title} at ${h.company || "an employer the posting does not name"}${where(h) ? ` — ${where(h)}` : ""}${h.url ? ` (${h.url})` : ""}${noLevel(h) ? " [level not stated]" : ""}${tail ? `. ${tail}` : ""}${/[.!?]$/.test(tail ?? "") ? "" : "."}`;
  const top = hits.slice(0, N);
  // 3. The judge, when on and a model is given; else the fit order.
  let rows: { h: SearchHit; tail: string | null }[] = [], account: Accounting | null = null, modelCalled = false, header: string;
  if (o.judge.on && o.judge.model) {
    let instructions: string[] = [];
    if (o.judge.standing) { try { instructions = judgeInstructionsOf(await o.judge.standing()); } catch (e) { console.error("career judge: standing", (e as Error)?.message ?? e); } }
    const run = await judgePostings({ userId: o.userId, now: o.now, facts, instructions, model: o.judge.model, cache: o.judge.cache ?? null,
      postings: top.map((h) => ({ job_id: h.job_id, title: h.title, company: h.company || "", location: where(h), text: byId.get(h.job_id)?.description ?? "" })) });
    modelCalled = run.modelCalled;
    account = accountFor(top.map((h) => h.job_id), run.judgments);
    const order = new Map(top.map((h, i) => [h.job_id, i]));
    const kept = top.filter((h) => { const v = run.judgments.get(h.job_id)?.verdict; return v && KEPT_VERDICTS.has(v); })
      .sort((a, b) => verdictRank(run.judgments.get(b.job_id)!.verdict!) - verdictRank(run.judgments.get(a.job_id)!.verdict!) || order.get(a.job_id)! - order.get(b.job_id)!);
    const unjudged = top.filter((h) => !run.judgments.get(h.job_id)?.verdict);
    rows = [
      ...kept.map((h) => { const j = run.judgments.get(h.job_id)!; return { h, tail: `${j.verdict}: ${j.reason}` }; }),
      ...unjudged.map((h) => ({ h, tail: `not judged${fitWord(h) ? `; ${fitWord(h)}` : ""}` })),
    ];
    header = `I ranked the ${plural(top.length, "closest match", "closest matches")} by fit, then judged them: ${accountingLine(account)}.`;
    if (!o.profile || !facts.length) header += " You have no confirmed facts yet, so every verdict rests on the posting alone.";
  } else {
    rows = top.map((h) => ({ h, tail: fitWord(h) }));
    // OWNER LIST #6: no internal words ("the model judge is off") in the reply.
    header = found.ranked_by === "newest"
      ? "You have no confirmed facts yet, so these are newest first."
      : "Ranked by how well each matches what you've confirmed.";
  }
  const listed = rows.slice(0, show);
  const more = rows.length - listed.length;
  const lines = [freshness];
  if (ask.limits && hasLimits(ask.limits)) {
    const out = droppedLine(held.dropped);
    lines.push(`Held to what you asked (${limitsLine(ask.limits)}).${out ? ` Left out: ${out}.` : ""}${held.noPay ? ` ${held.noPay} of those list no pay, so the floor could not be checked on them.` : ""}`);
  }
  lines.push(header);
  if (listed.length) lines.push(...listed.map((r, i) => lineOf(r.h, i, r.tail)));
  else lines.push(`None of the ${top.length} judged came out ${[...KEPT_VERDICTS].join(" or ")}, so none is listed.`);
  if (more > 0) lines.push(`${more} more ${more === 1 ? "is" : "are"} not shown.`);
  lines.push(listed.length ? `Say "apply to these" to queue the ${listed.length === 1 ? "one" : listed.length} listed, or name one to tailor your resume for.` : "Widen the role or the place and I'll search again.");
  const shortlist = listed.map((r) => ({ id: r.h.job_id, title: r.h.title, company: r.h.company || null, location: where(r.h) || null, url: r.h.url || null }));
  return { reply: lines.join("\n"), status: account ? "judged" : "ranked", source, shortlist, accounting: account, modelCalled };
}

// The ask for this turn: the router's search with the message's own parameters added; a search the router ran but named no
// role for ("SWE internship Chicago summer 2027"); or a search the router did not run (searchAskFromMessage). `append`: the
// router's own reply stays and the search follows it.
export function askFor(message: string, routerOut: { intent?: string; resultStatus?: string } | null, discovery: any): { ask: SearchAsk; append: boolean } | null {
  const router = askFromRouter(message, routerOut, discovery);
  if (router) return { ask: enrich(message, router) ?? router, append: false };
  const p = discovery?.lastParams;
  if (routerOut && SEARCH_INTENTS.has(String(routerOut.intent ?? "")) && p && p.ask === String(message ?? "").slice(0, 200)) {
    const ask = enrich(message, { role: "", place: typeof p.whereText === "string" ? p.whereText : null, remote: !!p.remote });
    return ask ? { ask, append: false } : null;
  }
  return searchAskFromMessage(message, routerOut);
}
