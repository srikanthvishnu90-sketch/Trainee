// D-075 (review of #790, round 3, item 5; tests/architect/hosted-apply-stale-fact-20261113.test.ts): a fact the person set aside
// ("the 3.9 gpa is outdated") or corrected (correct_profile_fact) stops, in that turn, the hosted applications that state its old
// value: approved and not yet started are closed unsent, prepared and not yet approved are discarded, and the ones already started
// or being sent are named as they are (career_apply_stop_stale_facts, 20261113140000). The reply says exactly what the database
// returned; when the call fails it says the approved applications could not be checked. Putting the fact back re-queues nothing:
// a stopped application needs the person's approval again.

export interface StoppedRow { id: string; company: string }
export interface StaleStops { cancelled: StoppedRow[]; discarded: StoppedRow[]; started: StoppedRow[]; being_sent: StoppedRow[] }
export interface FactChange { set_aside?: { id: string; text: string }[] | null; corrected?: { id: string; was: string; text: string }[] | null }

const words = (t: string) => String(t ?? "").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
const afterLabel = (t: string) => /^[^:]{1,40}:\s*(\S.*)$/.exec(String(t ?? "").trim())?.[1] ?? null;

// The values an application must not state any more. A fact set aside: its own words, and what follows its label ("GPA: 3.9" ->
// "3.9"). A correction: the old words, what followed their label, and each old word the corrected fact no longer has
// ("... role in Austin" corrected to "... role in Denver" -> "Austin").
export function staleFactValues(c: FactChange): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => { const s = String(v ?? "").trim(); if (s.length >= 2) out.add(s.slice(0, 300)); };
  for (const f of c.set_aside ?? []) { add(f.text); add(afterLabel(f.text)); }
  for (const f of c.corrected ?? []) {
    if (String(f.was ?? "").trim().toLowerCase() === String(f.text ?? "").trim().toLowerCase()) continue;
    add(f.was);
    const now = new Set(words(f.text).map((w) => w.toLowerCase())), gone = words(f.was).filter((w) => !now.has(w.toLowerCase()));
    for (const w of gone) add(w);
    if (gone.length) add(afterLabel(f.was));
  }
  return [...out].slice(0, 40);
}

const rows = (v: unknown): StoppedRow[] => (Array.isArray(v) ? v : []).map((x) => ({ id: String(x?.id ?? ""), company: String(x?.company ?? "").trim() }));

// The stop itself. "failed" when it could not run or its answer could not be read: the caller says so, never nothing.
// deno-lint-ignore no-explicit-any
export async function stopStaleFacts(admin: any, userId: string, values: string[], reason: "set_aside" | "corrected"): Promise<StaleStops | "failed"> {
  try {
    const r = await admin.rpc("career_apply_stop_stale_facts", { p_user: userId, p_values: values, p_reason: reason });
    const d = r?.data;
    if (r?.error || !d || typeof d !== "object" || !Array.isArray(d.cancelled) || !Array.isArray(d.discarded) || !Array.isArray(d.started) || !Array.isArray(d.being_sent)) {
      console.error("career stale facts: stop not confirmed:", r?.error?.message ?? "unreadable answer");
      return "failed";
    }
    return { cancelled: rows(d.cancelled), discarded: rows(d.discarded), started: rows(d.started), being_sent: rows(d.being_sent) };
  } catch (e) { console.error("career stale facts: stop failed:", (e as Error)?.message ?? e); return "failed"; }
}

const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
const at = (r: StoppedRow[]) => { const c = [...new Set(r.map((x) => x.company).filter(Boolean))].slice(0, 6); return c.length ? ` (${c.join(", ")})` : ""; };
export const STALE_UNCHECKED_LINE = "I couldn't check your approved applications for that answer just now, so I can't confirm that none of them goes out with it.";

// The sentences the reply carries. Every count is what the database stopped or found; nothing is promised.
export function staleFactLines(r: StaleStops | "failed"): string[] {
  if (r === "failed") return [STALE_UNCHECKED_LINE];
  const out: string[] = [];
  const c = r.cancelled.length, d = r.discarded.length, s = r.started.length, b = r.being_sent.length;
  if (c) out.push(`${n(c, "approved application that hadn't gone out yet states", "approved applications that hadn't gone out yet state")} that answer, so ${c === 1 ? "it is" : "they are"} stopped and not sent${at(r.cancelled)}: ${c === 1 ? "it needs" : "they need"} your approval again before anything goes.`);
  if (d) out.push(`${n(d, "prepared application stating that answer is", "prepared applications stating that answer are")} discarded${at(r.discarded)}, so nothing is approved or sent with it.`);
  if (s) out.push(`${n(s, "approved application stating that answer was", "approved applications stating that answer were")} already tried once and ${s === 1 ? "is" : "are"} waiting for another try${at(r.started)}: ${s === 1 ? "it is" : "they are"} not started again with that answer.`);
  if (b) out.push(`${n(b, "application stating that answer is", "applications stating that answer are")} being sent right now${at(r.being_sent)} and can't be stopped midway; one that goes out can't be taken back.`);
  return out;
}
