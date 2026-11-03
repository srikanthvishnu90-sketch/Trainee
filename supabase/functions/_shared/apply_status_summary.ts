// Spec 6.5 and 2.6 (status vocabulary, honest closeout): every count the brain states comes from row states, never from how many
// times something was pressed or queued. The reply is written (by the model) from this structure; code gives the numbers and
// which words are allowed, and checks the model's text against them.
//
// Vocabulary: prepared (materials created), approved (permission given), started (execution begun), submitted and confirmed
// (evidenced completion), still checking (uncertain), needs you (waiting on the person's step), not sent (stopped, nothing sent).
// "applied" is allowed only for an evidenced submission: a row the employer confirmed (state "confirmed"). A submission whose
// receipt is a page's thank-you ("submitted_unconfirmed") is "submitted, not confirmed yet": it is still checking, and the word
// "applied" does not describe it. Every row is counted once, so the counts add up to the total.
import type { AppRow } from "./career_apply_status.ts";

export type Word = "prepared" | "approved" | "started" | "submitted_confirmed" | "still_checking" | "needs_you" | "not_sent";
export const WORDS: readonly Word[] = ["prepared", "approved", "started", "submitted_confirmed", "still_checking", "needs_you", "not_sent"];
// The queue's states (career_apply_jobs.state) mapped to the vocabulary. "prepared" rows are not in the queue: they come in as a count.
const OF: Record<string, Word> = {
  queued: "approved", driving: "started", confirmed: "submitted_confirmed",
  submitted_unconfirmed: "still_checking", unknown_outcome: "still_checking",
  needs_user: "needs_you", failed: "not_sent", not_submitted: "not_sent",
};
// A form that wanted an emailed code after the submit went: the application was sent but is not finished, so it is "still checking",
// not a step the person must take before anything goes.
export const sentButUnfinished = (state: string, reason?: unknown) => state === "needs_user" && /^email_code\b/.test(String(reason ?? ""));
export const wordOf = (state: string, reason?: unknown): Word => sentButUnfinished(state, reason) ? "still_checking" : (OF[state] ?? "still_checking"); // a state nobody named is uncertain, never a success

export interface ApplySummary {
  total: number;
  counts: Record<Word, number>;
  // How many rows may be called "applied": evidenced (employer-confirmed) submissions only.
  applied_ok: number;
  // Rows submitted but not yet confirmed: "submitted, not confirmed yet" (a subset of still_checking).
  submitted_not_confirmed: number;
  rule: string;
}
export function applySummary(rows: (Pick<AppRow, "state"> & { reason?: unknown })[], o: { prepared?: number } = {}): ApplySummary {
  const counts = Object.fromEntries(WORDS.map((w) => [w, 0])) as Record<Word, number>;
  for (const r of rows) counts[wordOf(String(r.state), r.reason)]++;
  counts.prepared = Math.max(0, Math.floor(Number(o.prepared) || 0));
  const total = rows.length + counts.prepared;
  return {
    total, counts, applied_ok: counts.submitted_confirmed,
    submitted_not_confirmed: rows.filter((r) => r.state === "submitted_unconfirmed" || sentButUnfinished(String(r.state), r.reason)).length,
    rule: "Say a count only from counts. Use prepared, approved, started, submitted and confirmed, still checking, needs you, not sent. Do not say applied for anything but submitted and confirmed. Name what needs the person. Say partial when anything is not submitted and confirmed.",
  };
}
export const appliedAllowed = (state: string) => wordOf(state) === "submitted_confirmed";

// The numbers and claims the facts license, as text the reply writer's fact check can compare against (career_reply_writer.ts).
export function summaryFacts(s: ApplySummary): string {
  const bits = WORDS.filter((w) => s.counts[w] > 0).map((w) => `${s.counts[w]} ${w.replace(/_/g, " ")}`);
  // Counts cover every application the person has, not only the company or role a question named.
  return `Application counts across all applications (from row states, total ${s.total}): ${bits.join(", ") || "none"}.${s.submitted_not_confirmed > 0 ? ` ${s.submitted_not_confirmed} submitted, not confirmed yet.` : ""}${s.applied_ok > 0 ? ` ${s.applied_ok} submitted and confirmed.` : " None is submitted and confirmed."}`;
}

// Whether a written text overclaims against the summary: "applied" with no confirmed row, or a count larger than the rows license.
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1 };
export function overclaims(text: string, s: ApplySummary): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const claimsApplied = t.split(/[.!?\n]+/).some((c) => /\b(?:applied|have applied|has applied|i applied|were applied|got applied|went in|went through|are in|done and in)\b/i.test(c) && !/\b(?:not|n't|never|nothing|until|if|once|haven't|hasn't|yet)\s+(?:\w+\s+){0,2}(?:applied|in|through|sent)\b|\b(?:haven't|hasn't|not|never)\b/i.test(c));
  if (claimsApplied && s.applied_ok === 0) out.push('says "applied" but no row is submitted and confirmed');
  const CONF = "(?:applications?\\s+|roles?\\s+|of them\\s+)?(?:(?:were |was |are |have been |is )?(?:submitted and confirmed|confirmed|applied)\\b)";
  for (const m of t.matchAll(new RegExp(`\\b(\\d+|${Object.keys(NUM_WORDS).join("|")})\\s+${CONF}`, "gi"))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1].toLowerCase()];
    if (n > s.applied_ok) out.push(`says ${m[1]} confirmed but ${s.applied_ok} are`);
  }
  // "both confirmed" claims two; "all confirmed" claims every row (only when the summary knows the total).
  for (const m of t.matchAll(/\bboth(?: of them)?(?: applications?)? (?:are |were |have been )?(?:submitted and )?(?:confirmed|applied)\b/gi)) if (s.applied_ok < 2) out.push(`says both confirmed but ${s.applied_ok} are`);
  const total = (s as Partial<ApplySummary>).total;
  if (typeof total === "number" && total > s.applied_ok && /\ball(?: of them| of the applications| applications)? (?:are |were |have been )?(?:submitted and )?(?:confirmed|applied)\b/i.test(t)) out.push("says all confirmed but not every row is");
  return out;
}
