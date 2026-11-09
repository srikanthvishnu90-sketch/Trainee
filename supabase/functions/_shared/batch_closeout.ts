// Owner clarification (2026-11-09, D-MS-1): "someone can also approve all the applications at once and it could send all of
// them". One yes to a card approves exactly the set it showed (career_apply_card_answer_as, bound to the set hash), every
// application in it is sent, and each still gets its own receipt (career_apply_receipts.ts). Once every application that yes
// queued has finished, the batch gets ONE closeout text listing every item's outcome, from the records alone (spec B.3,
// application_review.ts closeoutLine): submitted with what proves it, uncertain, needs you, not sent and why, and each one
// held back by an unanswered question, named with that question. A card that queued nothing gets no closeout (nothing went).
// Keyed by the card ("status:closeout:<card id>"), so a batch is closed out once however often the run sees it.
import { closeoutText, narrowQuestion, openQuestionsFor, type RecordRow, type ReviewItem } from "./application_review.ts";

export const FINISHED = new Set(["confirmed", "submitted_unconfirmed", "unknown_outcome", "needs_user", "failed", "not_submitted"]);
// The card's own refusal words (career_apply_card_answer_as results), said as what happened: none of these was sent.
const NOT_QUEUED: Record<string, string> = {
  declined: "you did not approve it", changed: "it changed after the card was shown, so the yes did not cover it",
  daily_cap: "today's application limit was reached", company_cooldown: "another application to this employer went out recently",
  duplicate: "an application to this posting is already on record", no_resume: "no confirmed resume was on file",
  stale: "the posting's details went out of date", pace_unreadable: "the send limits could not be read",
  refused: "the queue refused it",
};

export interface BatchItem {
  n: number; company: string; result: string; title?: string | null;
  job?: (RecordRow & { id?: string }) | null; // the queue's row for a queued item (null: not found yet)
  held?: { label: string; options?: string[] } | null; // a declined item still held by an unanswered required question
}
export interface Batch { key: string; userId: string; items: BatchItem[]; tz?: string | null }

// Null until every item the yes queued has finished (or when it queued none).
export function batchCloseoutText(b: Batch): string | null {
  const queued = b.items.filter((i) => i.result === "queued");
  if (!queued.length || queued.some((i) => !i.job || !FINISHED.has(i.job.state))) return null;
  const rows = queued.map((i) => ({ ...i.job!, company: i.job!.company ?? i.company, title: i.job!.title ?? i.title ?? null }));
  const held: ReviewItem[] = [], skipped: string[] = [];
  for (const i of b.items.filter((x) => x.result !== "queued")) {
    if (i.held) {
      held.push({ employer: i.company, role: i.title ?? null, unresolved: [{ question: i.held.label, fact: "", ask: narrowQuestion({ label: i.held.label, company: i.company, options: i.held.options }) }] } as unknown as ReviewItem);
    } else {
      const name = `${i.title ? `${i.title} at ` : ""}${i.company}`;
      skipped.push(`${name.charAt(0).toUpperCase()}${name.slice(1)}: not sent (${NOT_QUEUED[i.result] ?? "it was not approved"}).`);
    }
  }
  const body = [closeoutText(rows, { tz: b.tz, held }), ...skipped].filter(Boolean).join("\n");
  return `Your batch of ${b.items.length} is closed out, from the records:\n${body}`;
}

export interface CloseoutOutbox { enqueue(userId: string, m: { key: string; kind: "status"; text: string; at: number }): Promise<boolean> }
export async function runBatchCloseouts(o: { outbox: CloseoutOutbox; now: number; batches: () => Promise<Batch[]> }): Promise<number> {
  let n = 0;
  for (const b of await o.batches()) {
    const text = batchCloseoutText(b);
    if (text && (await o.outbox.enqueue(b.userId, { key: b.key, kind: "status", text, at: o.now }))) n++;
  }
  return n;
}

// The answered cards since `since`, each with its items' outcomes and, for a queued one, the queue's row for that exact
// payload (user, posting and payload hash: the card's own binding).
// deno-lint-ignore no-explicit-any
export function supabaseBatches(admin: any) {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data ?? []; };
  return async (sinceIso: string): Promise<Batch[]> => {
    const cards = must(await admin.from("career_apply_cards").select("id,user_id,items,answer").eq("state", "answered").gte("answered_at", sinceIso).limit(500), "read the answered cards");
    const out: Batch[] = [];
    for (const c of cards) {
      // deno-lint-ignore no-explicit-any
      const items: any[] = Array.isArray(c.items) ? c.items : [], results: any[] = Array.isArray(c.answer?.results) ? c.answer.results : [];
      if (!results.some((r) => r?.result === "queued")) continue;
      const ids = items.map((i) => String(i.prepared_id ?? "")).filter(Boolean);
      // deno-lint-ignore no-explicit-any
      const prepared: any[] = ids.length ? must(await admin.from("career_apply_prepared").select("id,job_id,company,payload_hash,state,title:payload->>title").eq("user_id", c.user_id).in("id", ids), "read the batch's prepared applications") : [];
      const byId = new Map(prepared.map((p) => [p.id, p]));
      const jobIds = prepared.map((p) => p.job_id);
      // deno-lint-ignore no-explicit-any
      const jobs: any[] = jobIds.length ? must(await admin.from("career_apply_jobs").select("id,job_id,company,state,reason,confirmation_id,email_confirmed_at,confirmation_mail_hash,claimed_at,payload_hash,title:payload->>title").eq("user_id", c.user_id).in("job_id", jobIds), "read the batch's applications") : [];
      const open = await openQuestionsFor(admin, c.user_id, prepared.filter((p) => p.state === "ready").map((p) => p.job_id));
      out.push({ key: `status:closeout:${c.id}`, userId: c.user_id, items: items.map((it) => {
        const p = byId.get(String(it.prepared_id)), r = results.find((x) => Number(x?.n) === Number(it.n));
        const job = p ? jobs.find((j) => j.job_id === p.job_id && j.payload_hash === it.payload_hash) ?? null : null;
        const q = p && p.state === "ready" ? open.find((x) => (x.job_ids ?? []).includes(p.job_id)) : undefined;
        return { n: Number(it.n), company: String(r?.company ?? p?.company ?? "the employer"), title: p?.title ?? null, result: String(r?.result ?? "declined"),
          job: job ? { ...job, sent_at: job.claimed_at ?? null } : null, held: q ? { label: q.label, options: q.options } : null };
      }) });
    }
    return out;
  };
}
