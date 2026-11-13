// D-075 (review of #790, round 3, item 5; round 2 of #822; tests/architect/hosted-apply-stale-fact-20261113.test.ts): a fact the
// person set aside ("the 3.9 gpa is outdated") or corrected (correct_profile_fact) stops, in that turn, the hosted applications
// that state it (career_apply_stop_stale_facts, 20261113140000): by the fact's id (a field filled from it, "Yes" included), and
// by its old value where a field carries no fact id. Approved and not yet started, waiting on the person, or being filled in by
// the apply VM before its submit point: closed, not sent. Prepared and not yet approved: discarded. Already tried once: refused at
// its next claim. Past the submit point: named as being sent. The fact write itself records the change too (a trigger in the same
// commit), so the claim and submit checks refuse even when this call fails; the reply then says the applications could not be
// checked. Putting the fact back re-queues nothing: a stopped application needs the person's approval again.

export interface StoppedRow { id: string; company: string }
export interface StaleStops { cancelled: StoppedRow[]; waiting: StoppedRow[]; stopped_preparing: StoppedRow[]; discarded: StoppedRow[]; started: StoppedRow[]; being_sent: StoppedRow[] }
export interface FactChange { set_aside?: { id: string; text: string }[] | null; corrected?: { id: string; was: string; text: string }[] | null }
export interface ChangedFact { id: string; was: string; now: string | null }

// What changed this turn, for the database: each fact's id, its old words, and its new words when it was corrected (null when set
// aside). A correction that changes nothing is not a change.
export function staleFactChanges(c: FactChange): ChangedFact[] {
  const out: ChangedFact[] = [];
  for (const f of c.set_aside ?? []) if (f?.id) out.push({ id: String(f.id), was: String(f.text ?? ""), now: null });
  for (const f of c.corrected ?? []) {
    if (!f?.id || String(f.was ?? "").trim().toLowerCase() === String(f.text ?? "").trim().toLowerCase()) continue;
    out.push({ id: String(f.id), was: String(f.was ?? ""), now: String(f.text ?? "") });
  }
  return out.slice(0, 40);
}

const rows = (v: unknown): StoppedRow[] => (Array.isArray(v) ? v : []).map((x) => ({ id: String(x?.id ?? ""), company: String(x?.company ?? "").trim() }));
const KEYS = ["cancelled", "waiting", "stopped_preparing", "discarded", "started", "being_sent"] as const;

// The stop itself. "failed" when it could not run or its answer could not be read: the caller says so, never nothing.
// deno-lint-ignore no-explicit-any
export async function stopStaleFacts(admin: any, userId: string, changes: ChangedFact[], reason: "set_aside" | "corrected"): Promise<StaleStops | "failed"> {
  try {
    const r = await admin.rpc("career_apply_stop_stale_facts", { p_user: userId, p_changes: changes, p_reason: reason });
    const d = r?.data;
    if (r?.error || !d || typeof d !== "object" || KEYS.some((k) => !Array.isArray(d[k]))) {
      console.error("career stale facts: stop not confirmed:", r?.error?.message ?? "unreadable answer");
      return "failed";
    }
    return Object.fromEntries(KEYS.map((k) => [k, rows(d[k])])) as unknown as StaleStops;
  } catch (e) { console.error("career stale facts: stop failed:", (e as Error)?.message ?? e); return "failed"; }
}

const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
const at = (r: StoppedRow[]) => { const c = [...new Set(r.map((x) => x.company).filter(Boolean))].slice(0, 6); return c.length ? ` (${c.join(", ")})` : ""; };
export const STALE_UNCHECKED_LINE = "I couldn't check your approved applications for that answer just now, so I can't confirm that none of them goes out with it.";

// The sentences the reply carries. Every count is what the database stopped or found; nothing is promised.
export function staleFactLines(r: StaleStops | "failed"): string[] {
  if (r === "failed") return [STALE_UNCHECKED_LINE];
  const out: string[] = [];
  const c = r.cancelled.length + r.stopped_preparing.length, w = r.waiting.length, d = r.discarded.length, s = r.started.length, b = r.being_sent.length;
  if (c) out.push(`${n(c, "approved application that hadn't gone out yet states", "approved applications that hadn't gone out yet state")} that answer, so ${c === 1 ? "it is" : "they are"} stopped and not sent${at([...r.cancelled, ...r.stopped_preparing])}: ${c === 1 ? "it needs" : "they need"} your approval again before anything goes.`);
  if (w) out.push(`${n(w, "application waiting on you states", "applications waiting on you state")} that answer, so ${w === 1 ? "it is" : "they are"} stopped too${at(r.waiting)}: ${w === 1 ? "it needs" : "they need"} a fresh look and your approval again.`);
  if (d) out.push(`${n(d, "prepared application stating that answer is", "prepared applications stating that answer are")} discarded${at(r.discarded)}, so nothing is approved or sent with it.`);
  if (s) out.push(`${n(s, "approved application stating that answer was", "approved applications stating that answer were")} already tried once and ${s === 1 ? "is" : "are"} waiting for another try${at(r.started)}: ${s === 1 ? "it is" : "they are"} not started again with that answer.`);
  if (b) out.push(`${n(b, "application stating that answer is", "applications stating that answer are")} being sent right now${at(r.being_sent)} and can't be stopped midway; one that goes out can't be taken back.`);
  return out;
}
