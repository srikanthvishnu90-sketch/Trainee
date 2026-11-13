// D-072 (files writers): the store of the paths a person said they are weighing (career_path_comparisons, 20261112150000), the
// record the F-03 Path comparison File is drawn from (file_family_records.ts pathComparisonView).
//
// A comparison is written when the person compares paths in chat (agent/path_comparison_tool.ts compare_paths): each direction as
// they named it and the words they used, with rows that point only at their own facts (D-007):
//   You said                  their own words about that path, from this message
//   Related confirmed facts   the confirmed entries of their record that hold the path's own words as whole words: two of its
//                             distinct words, or its one word when it has only one (code's match, named as such)
//   Offer on file             an offer for a company they told Trainee about (offer_benchmark's record) whose name stands, as whole
//                             words, in what they wrote for that path ("Meta" is not in "metallurgy"), with the terms they gave
// A direction's name is the person's own wording (the tool keeps a name only when they wrote it; else their quoted words are the
// name), so the words matched are theirs. Evidence is a count, never a prediction: Strong is three or more confirmed facts each
// holding two of the path's words (a one-word path is never Strong); any related fact is Partial; none is Weak. Reach,
// odds and timing are never predicted. A comparison is never overwritten: a new one is a new version, and the File shows the newest.
// No imports beyond types: the File server loads this.

export type PathSrcKind = "you" | "resume";
export interface PathRowEntry { k: string; v: string | null; missing?: string; src?: { kind: PathSrcKind; at?: string | null } | null }
export interface PathDirection { letter: string; name: string; said: string; evidence: "Strong" | "Partial" | "Weak"; related: number; rows: PathRowEntry[] }
export interface PathComparisonRow { version: number; title: string; directions: PathDirection[]; said: string; confirmed_facts: number; created_at: string }
export interface PathStore {
  newest(userId: string): Promise<PathComparisonRow | null>;
  insert(userId: string, row: Omit<PathComparisonRow, "created_at">): Promise<"ok" | "conflict">;
}

const clean = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const STOP = new Set(["the", "and", "for", "with", "into", "from", "path", "paths", "role", "roles", "job", "jobs", "career", "track", "going", "staying", "working", "work", "offer", "option", "either", "versus", "about", "some", "more", "less", "than", "that", "this", "what", "which", "should", "would", "could", "doing"]);
const tokensOf = (s: unknown, n = 400) => clean(s, n).toLowerCase().replace(/[\u2019']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const wordsOf = (s: string) => [...new Set(tokensOf(s).filter((w) => w.length >= 4 && !STOP.has(w)))];
// `phrase` stands in `text` as whole words, in order ("meta" in "the meta offer", never in "metallurgy").
const holdsPhrase = (text: string, phrase: string) => { const p = tokensOf(phrase).join(" "); return !!p && ` ${tokensOf(text).join(" ")} `.includes(` ${p} `); };

export interface ConfirmedFact { title: string; text: string }
export interface OfferSaid { company: string; terms: string; at: number }
// One direction's rows from the person's own words and records. `at`: when they said it.
export function directionOf(letter: string, p: { name: string; said: string }, facts: ConfirmedFact[], offers: OfferSaid[], at: string): PathDirection {
  const name = clean(p.name, 80), said = clean(p.said, 240), keys = wordsOf(name);
  // How many of the path's distinct words each confirmed fact holds, as whole words. Related: two of them (or the only one).
  const need = Math.min(2, keys.length);
  const shared = keys.length ? facts.map((f) => { const w = new Set(wordsOf(`${f.title} ${f.text}`)); return { f, n: keys.filter((k) => w.has(k)).length }; }).filter((x) => x.n >= need) : [];
  const related = shared.map((x) => x.f), strong = shared.filter((x) => x.n >= 2).length >= 3;
  const offer = offers.filter((o) => holdsPhrase(name, o.company) || holdsPhrase(said, o.company)).sort((a, b) => b.at - a.at)[0];
  const rows: PathRowEntry[] = [
    { k: "You said", v: said, src: { kind: "you", at } },
    related.length ? { k: "Related confirmed facts", v: clean(related.slice(0, 3).map((f) => f.title).join("; ") + (related.length > 3 ? ` and ${related.length - 3} more` : ""), 240), src: { kind: "resume" } }
      : { k: "Related confirmed facts", v: null, missing: "None on your confirmed record" },
    ...(offer ? [{ k: "Offer on file", v: clean(offer.terms, 200), src: { kind: "you" as const, at: new Date(offer.at).toISOString() } }] : []),
  ];
  return { letter, name, said, evidence: strong ? "Strong" : related.length ? "Partial" : "Weak", related: related.length, rows };
}

export async function writePathComparison(store: PathStore, userId: string, c: { title: string; directions: PathDirection[]; said: string; confirmed_facts: number }): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = await store.newest(userId);
    const version = (base?.version ?? 0) + 1;
    if (await store.insert(userId, { version, title: clean(c.title, 120), directions: c.directions, said: clean(c.said, 600), confirmed_facts: c.confirmed_facts }) === "ok") return version;
  }
  throw new Error("the path comparisons changed under three writes in a row");
}

// deno-lint-ignore no-explicit-any
export function supabasePathStore(admin: any): PathStore {
  return {
    async newest(u) {
      const r = await admin.from("career_path_comparisons").select("version,title,directions,said,confirmed_facts,created_at").eq("user_id", u).order("version", { ascending: false }).limit(1);
      if (r.error) throw new Error(`read the path comparisons: ${r.error.message}`);
      return (r.data?.[0] ?? null) as PathComparisonRow | null;
    },
    async insert(u, row) {
      const r = await admin.from("career_path_comparisons").insert({ user_id: u, ...row });
      if (!r.error) return "ok";
      if (r.error.code === "23505") return "conflict";
      throw new Error(`write the path comparison: ${r.error.message}`);
    },
  };
}
export function memoryPathStore(now: () => number = Date.now): PathStore & { rows: Map<string, PathComparisonRow[]> } {
  const rows = new Map<string, PathComparisonRow[]>();
  return {
    rows,
    async newest(u) { const l = rows.get(u) ?? []; return l.length ? structuredClone(l[l.length - 1]) : null; },
    async insert(u, row) { const l = rows.get(u) ?? []; if (l.some((x) => x.version === row.version)) return "conflict"; l.push({ ...structuredClone(row), created_at: new Date(now()).toISOString() }); rows.set(u, l); return "ok"; },
  };
}

// The person comparing paths they are weighing ("I'm weighing two paths: consulting or product management", "should I take the
// Evercore offer or go to grad school? compare them"): a weighing or comparing word with a path word, or "X or Y" after "torn
// between" / "deciding between". Code routes it to the brain (career_staged.ts), which saves it with compare_paths. Offers compared
// as a File ("show me my offer comparison") and people-graph questions are not this.
const WEIGH = /\b(?:weigh(?:ing)?|compar(?:e|ing)|torn\s+between|deciding\s+between|decide\s+between|choos(?:e|ing)\s+between)\b/i;
const PATH_WORD = /\b(?:paths?|tracks?|directions?|career\s+(?:options?|moves?|choices?)|options?)\b/i;
const NOT_PATHS = /\b(?:people|network|graph|intro(?:duction)?s?|connections?|contacts?|alumni|referrals?)\b/i;
export function pathCompareAskOf(message: string): boolean {
  const m = String(message ?? "").replace(/[’`]/g, "'");
  if (!m || m.length > 600 || NOT_PATHS.test(m)) return false;
  return WEIGH.test(m) && PATH_WORD.test(m) || /\b(?:torn|deciding|choosing)\s+between\b[^.?!]{2,80}\bor\b/i.test(m);
}
