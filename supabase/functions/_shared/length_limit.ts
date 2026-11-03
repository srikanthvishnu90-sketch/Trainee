// The length a form's own words set on an answer ("in 150 words or less", "max 500 characters", "in 1-3 sentences").
// One reading for the drafter (essay_draft.ts lengthLimit) and for every typed answer (career_apply.ts typedFieldProblem):
// ROUND 3 (2026-11-02) found a person's own answer longer than the form's stated limit saved and planned, to be cut off by
// the form mid-sentence or mid-number. An answer over the limit is never cut: the person is told and shortens it.
export interface StatedLimit { words: number | null; chars: number | null; sentences: number | null }
export function statedLimit(label: unknown): StatedLimit | null {
  const t = String(label ?? "").toLowerCase().replace(/,(?=\d{3})/g, "");
  const num = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[m.length - 1]) : null; };
  const words = num(/\b(?:in|under|within|max(?:imum)?|up to|no more than|less than|fewer than|at most|limit(?:ed)? to|(?:word )?limit:?)\s*(?:of\s*)?(\d{2,4})\s*words?\b/) ??
    num(/\b(\d{2,4})\s*(?:-\s*)?words?\s*(?:or (?:less|fewer)|max(?:imum)?|limit|or under)\b/) ?? num(/\b(\d{2,4})-word\b/);
  const chars = num(/\b(?:in|under|within|max(?:imum)?|up to|no more than|less than|fewer than|at most|limit(?:ed)? to|(?:character )?limit:?)\s*(?:of\s*)?(\d{2,5})\s*char(?:acter)?s?\b/) ??
    num(/\b(\d{2,5})\s*char(?:acter)?s?\s*(?:or (?:less|fewer)|max(?:imum)?|limit)\b/);
  const sentences = num(/\bin\s*(?:\d\s*-\s*)?(\d{1,2})\s*sentences?\b/) ?? num(/\b(?:no more than|at most|up to|max(?:imum)?)\s*(\d{1,2})\s*sentences?\b/);
  return words !== null || chars !== null || sentences !== null ? { words, chars, sentences } : null;
}
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
// What is over the form's stated words or characters, said plainly; null when the answer fits (or no limit is stated).
// Sentences are the drafter's to count (it splits them with 154's own splitter).
export function overStatedLimit(label: unknown, value: string): string | null {
  const l = statedLimit(label);
  if (!l) return null;
  const v = String(value ?? "").trim();
  if (l.chars !== null && v.length > l.chars) return `has ${v.length} characters and the form allows ${l.chars}; shorten it (I never cut an answer off)`;
  if (l.words !== null && countWords(v) > l.words) return `has ${countWords(v)} words and the form allows ${l.words}; shorten it (I never cut an answer off)`;
  return null;
}
