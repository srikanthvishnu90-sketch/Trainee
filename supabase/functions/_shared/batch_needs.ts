// Batch needs (2026-11-10): what one batch of applications still needs from the person, from the open
// career_apply_questions rows alone (unique per user and key, so one question shared by many postings is one row with
// every posting in job_ids). Pure: no reads, no writes, no model. Code says what is missing; nothing here guesses an answer
// (D-007), and nothing here approves or sends anything (D-MS-1).
//
// Each missing item: its key, the plain question (the employer's own words), how many of the batch's postings need it,
// how many it alone stands between and being prepared (unblocks), and whether it is a per-application answer (sensitive:
// a job: key, kept to that one posting, like a self-identification answer or an essay) or a reusable one (a fact: or
// label: key, which travels to every posting that asks the same thing). Ordered: most postings first, per-application
// items last. A question never asked by text (NEVER_BY_TEXT: an identity, bank or card number, a password) is never an
// item to ask; it is listed apart (onForm), since the person types it on the form.
import { NEVER_BY_TEXT } from "./question_map.ts";

export interface NeedRow {
  id?: string;
  key: string;
  label: string;
  job_ids: string[];
  state?: string; // open | answered (absent: open)
  answer?: string | null;
  misfit?: boolean; // an answer that did not fit a form's choices: open again
}
export interface Need {
  key: string;
  id: string | null;
  question: string;
  postings: string[]; // the batch's postings that need it
  needed: number; // postings.length
  unblocks: number; // postings for which it is the last open item
  sensitive: boolean; // per application (job: key)
  reusable: boolean; // fact: or label: key
}
export interface BatchNeeds { items: Need[]; onForm: Need[]; batch: number }

const words = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const isOpen = (r: NeedRow) => (r.state ?? "open") === "open" || (!!r.misfit && r.state !== "answered");
export const isReusable = (key: string) => /^(?:fact|label):/.test(String(key ?? ""));

export function batchNeeds(rows: NeedRow[], batchJobIds: Iterable<string>): BatchNeeds {
  const batch = new Set([...batchJobIds].map(String));
  // One item per key (the table is unique per user and key; rows of two reads are merged, never counted twice).
  const byKey = new Map<string, { row: NeedRow; postings: Set<string>; at: number }>();
  rows.forEach((r, at) => {
    if (!r || typeof r.key !== "string" || !r.key || !isOpen(r)) return;
    const mine = (Array.isArray(r.job_ids) ? r.job_ids : []).map(String).filter((j) => batch.has(j));
    if (!mine.length) return;
    const had = byKey.get(r.key);
    if (had) mine.forEach((j) => had.postings.add(j));
    else byKey.set(r.key, { row: r, postings: new Set(mine), at });
  });
  // How many open items each posting still waits on (never-by-text ones too: they hold the posting all the same).
  const perPosting = new Map<string, number>();
  for (const { postings } of byKey.values()) for (const j of postings) perPosting.set(j, (perPosting.get(j) ?? 0) + 1);
  const all = [...byKey.values()].map(({ row, postings, at }) => {
    const ps = [...postings].sort();
    const reusable = isReusable(row.key);
    return { at, need: {
      key: row.key, id: row.id ?? null, question: words(row.label), postings: ps, needed: ps.length,
      unblocks: ps.filter((j) => perPosting.get(j) === 1).length, sensitive: !reusable, reusable,
    } as Need };
  });
  all.sort((a, b) => Number(a.need.sensitive) - Number(b.need.sensitive) || b.need.needed - a.need.needed ||
    b.need.unblocks - a.need.unblocks || a.at - b.at);
  const items = all.filter((x) => !NEVER_BY_TEXT.test(x.need.question)).map((x) => x.need);
  const onForm = all.filter((x) => NEVER_BY_TEXT.test(x.need.question)).map((x) => x.need);
  return { items, onForm, batch: batch.size };
}

// The order for the questions a text asks next (career_apply_questions.ts present): most postings first, otherwise oldest
// first; with perApplicationLast, a per-application one after every reusable one (batchNeeds' order). Without the batch,
// every posting a question names counts. The questions turn asks by postings only: its architect tests pin oldest-first
// between a per-application question and a reusable one (wo-029-ask-once WO-029/5, wo-030-essay-drafts WO-030/2).
export function orderAsks<T extends NeedRow>(qs: T[], batchJobIds?: Iterable<string> | null, o: { perApplicationLast?: boolean } = {}): T[] {
  const batch = batchJobIds ? new Set([...batchJobIds].map(String)) : null;
  const n = (q: T) => {
    const ids = Array.isArray(q.job_ids) ? q.job_ids.map(String) : [];
    const inBatch = batch ? ids.filter((j) => batch.has(j)).length : 0;
    return inBatch || ids.length;
  };
  const last = (q: T) => (o.perApplicationLast && !isReusable(q.key) ? 1 : 0);
  return qs.map((q, at) => ({ q, at })).sort((a, b) => last(a.q) - last(b.q) || n(b.q) - n(a.q) || a.at - b.at).map((x) => x.q);
}

// The one plain sentence a question is asked with: how many applications it is needed for.
export function neededSentence(q: { job_ids: string[] }, batchJobIds?: Iterable<string> | null): string {
  const ids = [...new Set((Array.isArray(q.job_ids) ? q.job_ids : []).map(String))];
  const batch = batchJobIds ? new Set([...batchJobIds].map(String)) : null;
  const inBatch = batch ? ids.filter((j) => batch.has(j)).length : 0;
  if (batch && inBatch && batch.size >= inBatch) {
    if (batch.size === 1) return "It's needed for your application.";
    if (inBatch === batch.size) return `It's needed for all ${batch.size} of your applications.`;
    return `It's needed for ${inBatch} of your ${batch.size} applications.`;
  }
  if (ids.length > 1) return `It's needed for ${ids.length} of your applications.`;
  return ids.length === 1 ? "It's needed for one of your applications." : "";
}

// The postings of a batch that wait on no open question. An open row whose postings cannot be read holds every posting
// (fail closed: it may be any of theirs).
export function readyPostings(open: unknown[], batchJobIds: string[]): string[] {
  const held = new Set<string>();
  for (const r of open) {
    const ids = (r as NeedRow | null)?.job_ids;
    if (!Array.isArray(ids)) return [];
    ids.forEach((j) => held.add(String(j)));
  }
  return batchJobIds.filter((j) => !held.has(j));
}

const list = (xs: string[]) => {
  const u = [...new Set(xs.map(words).filter(Boolean))];
  return u.length <= 3 ? u.join("; ") : `${u.slice(0, 3).join("; ")}; and ${u.length - 3} more`;
};
// The batch's readiness in one text, once every posting is prepared or held back with its reason: what a yes would send.
// The yes itself is the card's (career_apply_cards.ts): it approves exactly the prepared payloads the card shows.
export function batchReadyText(o: { ready: number; total: number; still: string[] }): string {
  const { ready, total } = o, k = total - ready;
  if (total < 1 || ready < 0 || ready > total) return "";
  if (k === 0) return total === 1 ? "Your application is ready to send. Reply yes to send it." : `All ${total} are ready to send. Reply yes to send all ${total}.`;
  const why = o.still.length ? `: ${list(o.still)}` : "";
  return `${ready} of ${total} are ready; ${k} still need${k === 1 ? "s" : ""} you${why}.`;
}
