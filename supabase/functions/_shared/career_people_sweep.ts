// PEOPLE FINDING: Gmail read in full, in leased batches (owner, 2026-10-27: no volume limit of Trainee's own; follow-up on
// #222). One sweep per person, kind and company (career_people_gmail_sweeps, 20261027170100): a cursor into Gmail's own
// list order that every reader resumes from. A turn takes the sweep's lease, reads for TURN_BUDGET_MS, keeps what it
// read (people in career_people, postings in career_job_emails), saves the cursor and lets go; the reply says plainly
// when more is still being read. The scheduled run (CAREER_PEOPLE_SWEEP=on) claims unfinished sweeps in batches with
// FOR UPDATE SKIP LOCKED and carries each on until Gmail has nothing more. Gmail asking to slow down (429 / rate-limit
// 403) is the only thing that pauses a sweep: it is held until the time Gmail gave, then resumes where it stopped.
// The time budgets bound how long one reader waits; they never bound how much is read.
import { partialError } from "./career_proactive_run.ts";
import { type Correspondent, correspondentsQuery, correspondentsStep, type Cursor, type GmailRead, type JobEmail, jobAlertsQuery, jobAlertsStep, type Step } from "./career_people_gmail.ts";

export type SweepKind = "correspondents" | "job_alerts";
export interface SweepRow {
  user_id: string; kind: SweepKind; scope: string; company_key: string; state: "idle" | "reading" | "done";
  query: string | null; page_token: string | null; skip: number; newest_at: string | null; read_count: number;
  lease_id: string | null; retry_at: string | null;
}
export interface SweepStore {
  lease(userId: string, kind: SweepKind, scope: string, companyKey: string, leaseSeconds: number): Promise<{ leased: boolean; row: SweepRow }>;
  save(row: SweepRow, s: { state: "reading" | "done"; query: string; page_token: string | null; skip: number; newest_at: string | null; read_count: number; retry_at: string | null }): Promise<boolean>;
  claim(leaseSeconds: number, limit: number): Promise<SweepRow[]>;
  forget(userId: string, kinds: SweepKind[]): Promise<void>;
}
// What a sweep keeps: the people it found (career_people, source gmail) or the postings (career_job_emails).
export interface SweepSink {
  people(userId: string, label: string, companyKey: string, items: Correspondent[], read: number): Promise<void>;
  jobs(userId: string, items: JobEmail[]): Promise<number>;
}
export const LEASE_SECONDS = 120;       // a reader that stops answering (a crash) lets go after this
export const TURN_BUDGET_MS = 6_000;    // how long a turn reads before it answers
export const RUN_BUDGET_MS = 90_000;    // how long one scheduled run reads, across sweeps
export const SWEEP_SLICE_MS = 20_000;   // one sweep's share of that, so a run moves many people's sweeps forward
export const CLAIM_BATCH = 25;          // sweeps one claim hands a run at a time (the next claim takes the next ones)

// deno-lint-ignore no-explicit-any
const must = (r: { data: any; error: any }, what: string): any => { if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r.data; };
// deno-lint-ignore no-explicit-any
export function supabaseSweepStore(admin: any): SweepStore {
  return {
    async lease(userId, kind, scope, companyKey, leaseSeconds) {
      const r = must(await admin.rpc("career_people_sweep_lease", { p_user: userId, p_kind: kind, p_scope: scope, p_company_key: companyKey, p_lease_seconds: leaseSeconds }), "read your Gmail's place");
      return { leased: !!r?.leased, row: r?.row as SweepRow };
    },
    async save(row, s) {
      return !!must(await admin.rpc("career_people_sweep_save", { p_user: row.user_id, p_kind: row.kind, p_scope: row.scope, p_lease: row.lease_id, p_state: s.state, p_query: s.query,
        p_page_token: s.page_token, p_skip: s.skip, p_newest_at: s.newest_at, p_read_count: s.read_count, p_retry_at: s.retry_at }), "save your Gmail's place");
    },
    async claim(leaseSeconds, limit) { return must(await admin.rpc("career_people_sweep_claim", { p_lease_seconds: leaseSeconds, p_limit: limit }), "claim Gmail reads") ?? []; },
    async forget(userId, kinds) { must(await admin.from("career_people_gmail_sweeps").delete().eq("user_id", userId).in("kind", kinds).select("user_id"), "forget your Gmail's place"); },
  };
}

// The same rules over memory (leases, the slow-down hold, a save only by the lease holder): for tests and for a caller
// with no database. Leases and the slow-down hold are judged by the wall clock, as the database judges them by now().
export function memorySweepStore(clock: () => number = Date.now): SweepStore & { rows: Map<string, SweepRow & { lease_until: number | null }> } {
  const rows = new Map<string, SweepRow & { lease_until: number | null }>();
  const k = (u: string, kind: string, scope: string) => `${u}|${kind}|${scope}`;
  const free = (r: { lease_until: number | null; retry_at: string | null }) => (r.lease_until === null || r.lease_until <= clock()) && (!r.retry_at || Date.parse(r.retry_at) <= clock());
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  return {
    rows,
    async lease(u, kind, scope, companyKey, secs) {
      const key = k(u, kind, scope);
      if (!rows.has(key)) rows.set(key, { user_id: u, kind, scope, company_key: companyKey, state: "idle", query: null, page_token: null, skip: 0, newest_at: null, read_count: 0, lease_id: null, retry_at: null, lease_until: null });
      const r = rows.get(key)!;
      if (!free(r)) return { leased: false, row: copy(r) };
      Object.assign(r, { lease_id: crypto.randomUUID(), lease_until: clock() + secs * 1000 });
      return { leased: true, row: copy(r) };
    },
    async save(row, s) {
      const r = rows.get(k(row.user_id, row.kind, row.scope));
      if (!r || !row.lease_id || r.lease_id !== row.lease_id) return false;
      const newest = [r.newest_at, s.newest_at].filter(Boolean).sort().at(-1) ?? null;
      Object.assign(r, { ...s, page_token: s.state === "done" ? null : s.page_token, skip: s.state === "done" ? 0 : s.skip, newest_at: newest, lease_id: null, lease_until: null });
      return true;
    },
    async claim(secs, limit) {
      const out: SweepRow[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (r.state !== "reading" || !free(r)) continue;
        Object.assign(r, { lease_id: crypto.randomUUID(), lease_until: clock() + secs * 1000 });
        out.push(copy(r));
      }
      return out;
    },
    async forget(u, kinds) { for (const [key, r] of rows) if (r.user_id === u && kinds.includes(r.kind)) rows.delete(key); },
  };
}

export type SweepOutcome =
  | { status: "read"; more: boolean; read: number; readSoFar: number; refused: number; newJobs: number }
  | { status: "busy"; readSoFar: number }                     // another reader holds it right now
  | { status: "slow"; readSoFar: number; retryAt: string }    // Gmail asked to slow down
  | { status: "not_connected" } | { status: "error"; detail: string };

// One step of one sweep the caller holds the lease on: read, keep, save the cursor. Exported for the run and the tests.
// keepLeaseOnError: the scheduled run leaves a failed sweep's lease to run out, so it is retried by a later run and not
// again in this one; a turn lets go at once, so the person's next ask can try again.
export async function advance(o: { sweeps: SweepStore; sink: SweepSink; gmail: GmailRead; row: SweepRow; deadline: number; keepLeaseOnError?: boolean }): Promise<SweepOutcome> {
  const row = o.row;
  // A sweep in progress continues its own query; a new one (never read, or finished) reads what is newer than it saw.
  const fresh = row.state !== "reading" || !row.query;
  const after = fresh && row.state === "done" && row.newest_at ? Date.parse(row.newest_at) : null;
  const cur: Cursor = fresh
    ? { query: row.kind === "correspondents" ? correspondentsQuery(row.scope, after) : jobAlertsQuery(after), pageToken: null, skip: 0 }
    : { query: row.query!, pageToken: row.page_token, skip: row.skip };
  const base = fresh ? 0 : Number(row.read_count ?? 0);
  const step: Step<Correspondent> | Step<JobEmail> = row.kind === "correspondents"
    ? await correspondentsStep(o.gmail, row.user_id, row.scope, cur, o.deadline)
    : await jobAlertsStep(o.gmail, row.user_id, cur, o.deadline);
  if (step.status === "NOT_WIRED" || step.status === "ERROR") {
    // nothing read: the cursor stays as it was
    if (!o.keepLeaseOnError) await o.sweeps.save(row, { state: row.state === "reading" ? "reading" : "done", query: row.query ?? cur.query, page_token: row.page_token, skip: row.skip, newest_at: row.newest_at, read_count: Number(row.read_count ?? 0), retry_at: null });
    return step.status === "NOT_WIRED" ? { status: "not_connected" } : { status: "error", detail: step.detail };
  }
  let newJobs = 0;
  if (row.kind === "correspondents") { if (step.items.length) await o.sink.people(row.user_id, row.scope, row.company_key, step.items as Correspondent[], step.read); }
  else newJobs = await o.sink.jobs(row.user_id, step.items as JobEmail[]);
  const readSoFar = base + step.read;
  const newest = step.newestMs ? new Date(step.newestMs).toISOString() : null;
  if (step.status === "SLOW_DOWN") {
    const retryAt = new Date(Date.now() + step.retryAfterMs).toISOString();
    await o.sweeps.save(row, { state: "reading", query: step.next.query, page_token: step.next.pageToken, skip: step.next.skip, newest_at: newest, read_count: readSoFar, retry_at: retryAt });
    return { status: "slow", readSoFar, retryAt };
  }
  await o.sweeps.save(row, step.next
    ? { state: "reading", query: step.next.query, page_token: step.next.pageToken, skip: step.next.skip, newest_at: newest, read_count: readSoFar, retry_at: null }
    : { state: "done", query: cur.query, page_token: null, skip: 0, newest_at: newest, read_count: readSoFar, retry_at: null });
  return { status: "read", more: !!step.next, read: step.read, readSoFar, refused: step.refused, newJobs };
}

// A turn's read: take the lease (or say who holds it), one step within the turn's budget.
export async function sweepTurn(o: { sweeps: SweepStore; sink: SweepSink; gmail: GmailRead; userId: string; kind: SweepKind; scope: string; companyKey: string; budgetMs?: number }): Promise<SweepOutcome> {
  const l = await o.sweeps.lease(o.userId, o.kind, o.scope, o.companyKey, LEASE_SECONDS);
  if (!l.leased) {
    const r = l.row;
    if (r?.retry_at && Date.parse(r.retry_at) > Date.now()) return { status: "slow", readSoFar: Number(r.read_count ?? 0), retryAt: r.retry_at };
    return { status: "busy", readSoFar: Number(r?.read_count ?? 0) };
  }
  return await advance({ sweeps: o.sweeps, sink: o.sink, gmail: o.gmail, row: l.row, deadline: Date.now() + (o.budgetMs ?? TURN_BUDGET_MS) });
}

// The scheduled rail: claim unfinished sweeps in batches (skip-locked, so parallel runs never share one) and move each
// forward, until none is waiting or the run's time is spent. Returns how many sweeps it moved forward.
export async function runPeopleSweeps(o: { sweeps: SweepStore; sink: SweepSink; gmail: GmailRead; awake?: (rows: SweepRow[]) => Promise<SweepRow[]>;
  budgetMs?: number; sliceMs?: number }): Promise<number> {
  const until = Date.now() + (o.budgetMs ?? RUN_BUDGET_MS);
  let moved = 0;
  const failed: string[] = [];
  while (Date.now() < until) {
    const claimed = await o.sweeps.claim(LEASE_SECONDS, CLAIM_BATCH);
    if (!claimed.length) break;
    const rows = o.awake ? await o.awake(claimed) : claimed;
    // a quiet person's sweep is let go untouched (their lease runs out; nothing is read for them)
    for (const row of rows) {
      if (Date.now() >= until) break;
      const r = await advance({ sweeps: o.sweeps, sink: o.sink, gmail: o.gmail, row, deadline: Math.min(until, Date.now() + (o.sliceMs ?? SWEEP_SLICE_MS)), keepLeaseOnError: true }).catch((e) => ({ status: "error" as const, detail: String(e?.message ?? e) }));
      if (r.status === "read" || r.status === "slow") moved++;
      else if (r.status === "error") failed.push(r.detail);
    }
    if (!rows.length) break;
  }
  if (failed.length) throw partialError(`people sweeps failed for ${failed.length}: ${failed[0]}`, moved);
  return moved;
}
