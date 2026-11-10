// Release item 9 (profile and memory): a fact the person corrects in chat reopens the answer library's answer it
// contradicts (tests/architect/loop-09-memory-apply.test.ts).
//
// Before: "Actually I will need visa sponsorship" was recorded as a stated fact with its own event, but the answer the
// person once gave an employer's "Will you ... require sponsorship?" ("No", career_apply_questions fact:sponsorship) stayed
// answered, and every later application was filled from it (career_apply_answers_for, the preparation's text answers). The
// card prepared before the correction could still be approved with the old answer.
// Now, in the turn the corrected fact is recorded: each answered library row for that fact whose answer disagrees with it is
// reopened (state open, answer cleared), so the person is asked again, in their own words. It is never rewritten to the
// new value (D-007, and the coordinator's ruling on #720: reopen and ask, never auto-replace). A prepared application that
// carried that answer is expired (prepared again, so the question is asked), and an approved one not yet handed out is
// stopped (nothing was sent). The reply says what was done.
// The facts: sponsorship and graduation date, the two the router records from a statement (or, for the date, a corrected
// education entry) AND an employer's form asks as one shared fact. A statement that agrees with the answer on file changes nothing.
// deno-lint-ignore-file no-explicit-any

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// The month (1-12, or null) and year of a date in the words people and forms use: "December 2026", "Dec 18, 2026",
// "2026-12-18", "12/18/2026", "2026".
export function monthYear(s: string): { month: number | null; year: number } | null {
  const t = String(s ?? "").toLowerCase();
  let m = t.match(/\b(20\d\d)-(\d{1,2})(?:-\d{1,2})?\b/);
  if (m) return { year: +m[1], month: +m[2] };
  m = t.match(/\b(\d{1,2})\/(?:\d{1,2}\/)?(20\d\d)\b/);
  if (m) return { year: +m[2], month: +m[1] };
  const y = t.match(/\b(20\d\d)\b/);
  if (!y) return null;
  const mi = MONTHS.findIndex((x) => new RegExp(`\\b${x}[a-z]*\\.?\\b`).test(t));
  return { year: +y[1], month: mi >= 0 ? mi + 1 : null };
}
const yes = (a: string) => /^\s*(y|yes|yeah|yep|i do|i will)\b/i.test(a);
const no = (a: string) => /^\s*(n|no|nope|i do not|i don'?t|i will not|i won'?t)\b/i.test(a);
// The library key each stated fact answers, and whether an answer on file agrees with the stated value.
const LIBRARY: Record<string, { key: string; agrees: (stated: string, answer: string) => boolean }> = {
  sponsorship: {
    key: "fact:sponsorship",
    agrees: (v, a) => /^needs\b/i.test(v) ? yes(a) : /^does not need\b/i.test(v) ? no(a) : true,
  },
  graduation: {
    key: "fact:graduation_date",
    agrees: (v, a) => {
      const s = monthYear(v), g = monthYear(a);
      if (!s) return true; // nothing comparable was stated
      return !!g && g.year === s.year && (s.month === null || g.month === s.month);
    },
  },
};

// The stated facts this turn recorded (they carry an event the facts before the turn did not), for the facts above.
export function freshStatedFacts(before: any[] | null | undefined, after: any[] | null | undefined): { kind: string; value: string }[] {
  const had = new Set((Array.isArray(before) ? before : []).map((f) => f?.confirmation_event_id).filter(Boolean));
  return (Array.isArray(after) ? after : [])
    .filter((f) => f && LIBRARY[f.kind] && typeof f.value === "string" && f.value.trim() && f.confirmation_event_id && !had.has(f.confirmation_event_id))
    .map((f) => ({ kind: String(f.kind), value: String(f.value) }));
}

// A confirmed education entry whose date the person corrected this turn (its held fact_confirmed event, career_router_evidence.ts
// evidenceEntryCorrections: "actually I graduate December 2026, not May 2027") states the graduation date as well.
export function entryCorrectionFacts(rows: any[] | null | undefined): { kind: string; value: string }[] {
  return (Array.isArray(rows) ? rows : []).filter((e) => e?.kind === "fact_confirmed" && e?.detail?.kind === "education" && e?.detail?.corrected)
    .filter((e) => monthYear(String(e.detail.corrected.to ?? "")) && monthYear(String(e.detail.corrected.from ?? "")))
    .map((e) => ({ kind: "graduation", value: String(e.detail.corrected.to) }));
}

export interface Reopened { reopened: { label: string; answer: string }[]; expired: number; stopped: number }
const carries = (payload: any, factIds: Set<string>) => (Array.isArray(payload?.fields) ? payload.fields : []).some((f: any) => factIds.has(String(f?.factId ?? "")));

// Reopen what the fresh facts contradict, as the service (the library is written only by the person's answers and this).
export async function reopenContradicted(admin: any, userId: string, fresh: { kind: string; value: string }[], now: number): Promise<Reopened> {
  const out: Reopened = { reopened: [], expired: 0, stopped: 0 };
  const ids = new Set<string>();
  for (const f of fresh) {
    const lib = LIBRARY[f.kind];
    const r = await admin.from("career_apply_questions").select("id,label,answer").eq("user_id", userId).eq("key", lib.key).eq("state", "answered");
    if (r.error) throw Error(`the answer on file was not read: ${r.error.message}`);
    for (const row of r.data ?? []) {
      if (lib.agrees(f.value, String(row.answer ?? ""))) continue;
      const at = new Date(now).toISOString();
      const u = await admin.from("career_apply_questions").update({ state: "open", answer: null, answered_at: null, updated_at: at })
        .eq("id", row.id).eq("user_id", userId).eq("state", "answered").select("id");
      if (u.error) throw Error(`the answer on file was not reopened: ${u.error.message}`);
      if (!(u.data ?? []).length) continue;
      ids.add(`text-answer:${row.id}`);
      out.reopened.push({ label: String(row.label), answer: String(row.answer ?? "") });
    }
  }
  if (!ids.size) return out;
  // A prepared application carrying the reopened answer: expired, its tries removed, so it is prepared (and asked) again.
  const prep = await admin.from("career_apply_prepared").select("id,payload").eq("user_id", userId).in("state", ["ready", "shown"]);
  if (prep.error) throw Error(`the prepared applications were not read: ${prep.error.message}`);
  const stale = (prep.data ?? []).filter((p: any) => carries(p.payload, ids)).map((p: any) => p.id);
  if (stale.length) {
    const d = await admin.from("career_apply_prepare_attempts").delete().eq("user_id", userId).in("prepared_id", stale);
    if (d.error) throw Error(`the prepare tries were not cleared: ${d.error.message}`);
    const e = await admin.from("career_apply_prepared").update({ state: "expired", updated_at: new Date(now).toISOString() }).eq("user_id", userId).in("id", stale).in("state", ["ready", "shown"]).select("id");
    if (e.error) throw Error(`the prepared applications were not expired: ${e.error.message}`);
    out.expired = (e.data ?? []).length;
  }
  // An approved application not yet handed out that carries it: stopped, as career_apply_cancel_for stops one (nothing sent).
  const jobs = await admin.from("career_apply_jobs").select("id,payload").eq("user_id", userId).eq("state", "queued").eq("attempts", 0);
  if (jobs.error) throw Error(`the approved applications were not read: ${jobs.error.message}`);
  const stop = (jobs.data ?? []).filter((j: any) => carries(j.payload, ids)).map((j: any) => j.id);
  if (stop.length) {
    const s = await admin.from("career_apply_jobs").update({ state: "not_submitted", reason: "not sent: you corrected an answer it carried", updated_at: new Date(now).toISOString() })
      .eq("user_id", userId).in("id", stop).eq("state", "queued").eq("attempts", 0).select("id");
    if (s.error) throw Error(`the approved applications were not stopped: ${s.error.message}`);
    out.stopped = (s.data ?? []).length;
  }
  return out;
}

// What the reply adds, from what was done; nothing when nothing was reopened.
export function reopenedLine(r: Reopened | null): string | null {
  if (!r || !r.reopened.length) return null;
  const said = r.reopened.map((x) => `"${x.label}" (you had answered "${x.answer}")`).join("; ");
  return `That no longer matches your earlier answer to ${said}, so I won't use it: I'll ask you again before an application needs it.` +
    (r.expired ? ` ${r.expired} prepared application${r.expired === 1 ? "" : "s"} that carried it will be prepared again.` : "") +
    (r.stopped ? ` ${r.stopped} approved application${r.stopped === 1 ? "" : "s"} not yet sent that carried it ${r.stopped === 1 ? "was" : "were"} stopped; nothing was sent.` : "");
}
