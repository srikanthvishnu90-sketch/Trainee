// MIRROR-1000 distinctness check (architect builder, 2026-11-11). Rejects near-duplicate prompts in a set, $0, no model.
//
//   deno run -A evals/mirror/distinct.ts [evals/mirror/prompts.v1.jsonl] [--json out.json]
//
// Two prompts are near-duplicates when any of these holds:
//   lexical   the normalized token 4-gram Jaccard is >= 0.5, or the edit-distance ratio (1 - Levenshtein / longer length, on the
//             normalized text) is >= 0.8
//   structural  same category, the same task.must_do set and the same skeleton (the prompt with every entity removed: the
//             vocab.ts phrases, numbers, emails, links and capitalized names)
// It also counts "same task" pairs: same category and the same task.must_do set, whatever the words. The set is built so that
// count is 0 too (every prompt differs in intent or constraint, not only in entity names; README.md says how).
// Exit code 1 when any near-duplicate or same-task pair is found.
import { ENTITY_PHRASES } from "./vocab.ts";

export interface MirrorPrompt {
  id: string; category: string; persona: string;
  setup: { turns: string[]; state: Record<string, unknown> };
  prompt: string;
  task: { must_do: string[]; must_not: string[]; outcome_check: string };
  safe_for_live: boolean; stop_before_action?: boolean;
}

export const JACCARD_MAX = 0.5, EDIT_MAX = 0.8;

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/'/g, "").replace(/[^a-z0-9À-￿]+/g, " ").trim();
}
export function tokens(s: string): string[] { return normalize(s).split(" ").filter(Boolean); }
export function grams4(s: string): Set<string> {
  const t = tokens(s), out = new Set<string>();
  if (t.length < 4) { out.add(t.join(" ")); return out; }
  for (let i = 0; i + 4 <= t.length; i++) out.add(t.slice(i, i + 4).join(" "));
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
export function levenshtein(a: string, b: string, cap = Infinity): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i; let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return rowMin;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
export function editRatio(a: string, b: string): number {
  const x = normalize(a), y = normalize(b), L = Math.max(x.length, y.length) || 1;
  return 1 - levenshtein(x, y) / L;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENTITY_RX = new RegExp(`\\b(?:${ENTITY_PHRASES.map(esc).join("|")})\\b`, "g");
// The prompt's shape with its entities removed.
export function skeleton(s: string): string {
  let t = s.replace(/\bhttps?:\/\/\S+/g, " E ").replace(/\b[\w.+-]+@[\w.-]+\b/g, " E ");
  // capitalized words that are not the first word of a sentence: names
  t = t.replace(/(?<=[^.!?\s][)"']?\s+)[A-Z][a-zA-Z&'-]+/g, "E");
  t = t.toLowerCase().replace(/[’‘]/g, "'").replace(/\$?\d[\d,.]*k?\b/g, " e ").replace(ENTITY_RX, " e ");
  return normalize(t).split(" ").map((w) => (w === "e" ? "E" : w)).join(" ").replace(/(?:E )+E\b/g, "E");
}
export const taskKey = (p: MirrorPrompt) => `${p.category}|${[...p.task.must_do].map((x) => x.trim().toLowerCase()).sort().join("|")}`;

export interface Pair { a: string; b: string; why: string; score: number }
export interface DistinctReport {
  n: number; near_duplicates: Pair[]; same_task: Pair[];
  max_jaccard: { score: number; a: string; b: string }; max_edit_ratio: { score: number; a: string; b: string; exact_above: number };
  categories: Record<string, number>; duplicate_ids: string[];
}

// Character bigram multisets as sets of "gram#k" (the k-th occurrence), so a set intersection is the multiset one.
function bigramKeys(s: string): string[] {
  const seen = new Map<string, number>(), out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) { const g = s.slice(i, i + 2), k = (seen.get(g) ?? 0) + 1; seen.set(g, k); out.push(`${g}#${k}`); }
  return out;
}

// EDIT_REPORT: every pair whose edit ratio could reach this is measured exactly (the q-gram count filter rules the rest out:
// with Levenshtein d, two strings share at least maxLen - 1 - 2d bigrams), so the reported maximum is exact when it is at or
// above this value and otherwise "below EDIT_REPORT".
export const EDIT_REPORT = 0.6;
export function checkSet(set: MirrorPrompt[]): DistinctReport {
  const n = set.length, ids = set.map((p) => p.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  const near: Pair[] = [], same: Pair[] = [];
  const g = set.map((p) => grams4(p.prompt));
  // inverted index of 4-grams: only pairs sharing a gram can have a Jaccard above 0
  const idx = new Map<string, number[]>();
  g.forEach((s, i) => { for (const x of s) { const l = idx.get(x); if (l) l.push(i); else idx.set(x, [i]); } });
  let maxJ = { score: 0, a: "", b: "" };
  const counts = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    counts.fill(0);
    for (const x of g[i]) for (const j of idx.get(x)!) if (j > i) counts[j]++;
    for (let j = i + 1; j < n; j++) {
      if (!counts[j]) continue;
      const J = counts[j] / (g[i].size + g[j].size - counts[j]);
      if (J > maxJ.score) maxJ = { score: J, a: ids[i], b: ids[j] };
      if (J >= JACCARD_MAX) near.push({ a: ids[i], b: ids[j], why: "4-gram jaccard", score: J });
    }
  }
  // edit ratio with a bigram count filter
  const norm = set.map((p) => normalize(p.prompt));
  const bk = norm.map(bigramKeys);
  const bidx = new Map<string, number[]>();
  bk.forEach((ks, i) => { for (const k of ks) { const l = bidx.get(k); if (l) l.push(i); else bidx.set(k, [i]); } });
  let maxE = { score: 0, a: "", b: "", exact_above: EDIT_REPORT };
  for (let i = 0; i < n; i++) {
    counts.fill(0);
    for (const k of bk[i]) for (const j of bidx.get(k)!) if (j > i) counts[j]++;
    for (let j = i + 1; j < n; j++) {
      const L = Math.max(norm[i].length, norm[j].length) || 1, dMax = Math.floor((1 - EDIT_REPORT) * L);
      if (Math.abs(norm[i].length - norm[j].length) > dMax) continue;
      if (counts[j] < L - 1 - 2 * dMax) continue;
      const d = levenshtein(norm[i], norm[j], dMax), r = 1 - d / L;
      if (r > maxE.score) maxE = { score: r, a: ids[i], b: ids[j], exact_above: EDIT_REPORT };
      if (r >= EDIT_MAX) near.push({ a: ids[i], b: ids[j], why: "edit ratio", score: r });
    }
  }
  // structural and same task
  const byTask = new Map<string, number[]>();
  set.forEach((p, i) => { const k = taskKey(p); const l = byTask.get(k); if (l) l.push(i); else byTask.set(k, [i]); });
  for (const list of byTask.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const [i, j] = [list[x], list[y]];
    same.push({ a: ids[i], b: ids[j], why: "same category and must_do set", score: 1 });
    if (skeleton(set[i].prompt) === skeleton(set[j].prompt)) near.push({ a: ids[i], b: ids[j], why: "structural: category, must_do and skeleton", score: 1 });
  }
  const categories: Record<string, number> = {};
  for (const p of set) categories[p.category] = (categories[p.category] ?? 0) + 1;
  return { n, near_duplicates: near, same_task: same, max_jaccard: maxJ, max_edit_ratio: maxE, categories, duplicate_ids: dupIds };
}

export async function loadSet(path: string): Promise<MirrorPrompt[]> {
  return (await Deno.readTextFile(path)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
export const SET_PATH = new URL("./prompts.v1.jsonl", import.meta.url).pathname;

if (import.meta.main) {
  const a = Deno.args, jsonAt = a.indexOf("--json");
  const path = a.find((x, i) => !x.startsWith("--") && a[i - 1] !== "--json") ?? SET_PATH;
  const t0 = performance.now();
  const r = checkSet(await loadSet(path));
  console.log(`MIRROR-DISTINCT prompts=${r.n} near_duplicates=${r.near_duplicates.length} same_task=${r.same_task.length} duplicate_ids=${r.duplicate_ids.length} ` +
    `max_jaccard=${r.max_jaccard.score.toFixed(3)} (${r.max_jaccard.a}~${r.max_jaccard.b}) max_edit_ratio=${r.max_edit_ratio.score >= EDIT_REPORT ? r.max_edit_ratio.score.toFixed(3) + ` (${r.max_edit_ratio.a}~${r.max_edit_ratio.b})` : `<${EDIT_REPORT}`} ` +
    `in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`categories (${Object.keys(r.categories).length}): ${Object.entries(r.categories).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  for (const p of [...r.near_duplicates, ...r.same_task].slice(0, 40)) console.log(`  ${p.why}: ${p.a} ~ ${p.b} (${p.score.toFixed(3)})`);
  if (jsonAt >= 0) await Deno.writeTextFile(a[jsonAt + 1], JSON.stringify(r, null, 1) + "\n");
  if (r.near_duplicates.length || r.same_task.length || r.duplicate_ids.length) Deno.exit(1);
}
