// Mass submission (owner, 2026-10-27: D-MS-2 "no product volume cap"; 19:55 CDT "no person limit, never set a limit";
// 19:52 "operate at large scale"). One scheduler for every executor that drives employer pages: the person's own computer
// (approve-first.ts runLoop), the cloud worker (career-cloud/worker.ts cloudLoop) and the server's preparation
// (prepare-ahead.ts). Many instances run it at once against one database; nothing here is a single loop or a single VM.
//
// No number of ours slows anything. It claims as many approved applications as this machine has browsers for (its
// memory: machineSlots) and runs them all at once, on every host. What slows a host is that host refusing: a 429 or a
// 503 with Retry-After at its page, or a verification check. Then that host is held off (as long as it asked, else 30 s
// doubling to at most an hour, reset by the next success) for EVERY instance, through the database (dbHostGate), and
// resumed when it allows. The owner may still set a number (MASS_SUBMIT_*), never needed.
// A job the host refused before anything was sent (a 429 or a 503 at the page's open: sentNothingRefusal) is not ended: the same job goes back to the queue (o.requeue, 20261029180000), its approval unchanged, not handed out
// before the host's hold ends, and runs again then; every refusal backs off again, with no cap of ours. A verification
// check or a sign-in wall is the person's (needs_user, never retried); anything else after the engine started is recorded
// as it ended, and an unknown is never driven again. A job claimed and never started (the worker stopping, no start
// inside its lease budget, its host held, its journal line unwritable) is not ended either: the same job goes back to the
// queue (o.putBack, 20261029190000), its journal line cleared first, and runs later, once.
//
// Exactly once: a claimed application is started at most once. Before its engine starts, the start is written to a
// durable journal (fsync) when one is given. A worker that dies mid-batch leaves in the journal:
//   started, not finished   -> recorded unknown_outcome on the next start, never driven again (it may have been sent);
//   claimed, never started  -> driven on the next start under the same lease, if the lease still has time to run it;
//                              otherwise put back in the queue (o.putBack; without it recorded not_submitted): nothing
//                              was sent.
// Without the journal (a lost machine), the database's own sweep closes a drive older than 15 minutes as unknown and never
// re-drives it (attempts = 1): exactly once never rests on this machine. A claimed application that cannot start inside
// its lease budget (`startBudgetMs` after its claim) is never started late.

export interface Pacing {
  concurrency: number; // engines at once on this machine (its capacity, not a product number)
  claimBatch: number; // how many approved applications one claim asks for (the database may return fewer)
  hostMax: number; // engines at once on one employer host on this machine (Infinity: no number of ours)
  hostSpacingMs: number; // least time between two starts on one employer host (0: none of ours)
  startBudgetMs: number; // a claimed application must start within this of its claim (inside the 15-minute lease)
}

// The only defaults are technical: how many browsers this machine can hold, and the lease. One headless Chromium with
// one employer page takes about BROWSER_MB of memory (measured on the test pages).
export const BROWSER_MB = 450;
export function machineSlots(mem: () => { available?: number; free?: number } | null = () => {
  try { return Deno.systemMemoryInfo(); } catch { return null; }
}): number {
  const m = mem();
  const bytes = Number(m?.available ?? m?.free ?? 0);
  return Math.max(1, Math.floor(bytes / (BROWSER_MB * 1024 * 1024)));
}
export const DEFAULT_PACING: Pacing = { concurrency: 0, claimBatch: 0, hostMax: Infinity, hostSpacingMs: 0, startBudgetMs: 240_000 };

// The env names (the owner's; none is required). Each is a whole number; anything else keeps the default.
export const PACING_ENV: Record<keyof Pacing, string> = {
  concurrency: "MASS_SUBMIT_CONCURRENCY",
  claimBatch: "MASS_SUBMIT_CLAIM_BATCH",
  hostMax: "MASS_SUBMIT_HOST_MAX",
  hostSpacingMs: "MASS_SUBMIT_HOST_SPACING_MS",
  startBudgetMs: "MASS_SUBMIT_START_BUDGET_MS",
};
const FLOOR: Record<keyof Pacing, number> = { concurrency: 1, claimBatch: 1, hostMax: 1, hostSpacingMs: 0, startBudgetMs: 1_000 };

// concurrency 0 (unset) is this machine's capacity (machineSlots); claimBatch 0 (unset) is the concurrency.
export function pacingFrom(get: (k: string) => string | undefined, base: Partial<Pacing> = {}, slots: () => number = machineSlots): Pacing {
  const out: Pacing = { ...DEFAULT_PACING, ...base };
  for (const k of Object.keys(PACING_ENV) as (keyof Pacing)[]) {
    const raw = (get(PACING_ENV[k]) ?? "").trim();
    if (!/^\d{1,9}$/.test(raw)) continue;
    out[k] = Math.max(FLOOR[k], Number(raw));
  }
  if (!(Number(out.concurrency) >= 1)) out.concurrency = slots();
  if (!(Number(out.claimBatch) >= 1)) out.claimBatch = out.concurrency;
  for (const k of Object.keys(FLOOR) as (keyof Pacing)[]) {
    const v = Number(out[k]);
    out[k] = v === Infinity ? Infinity : Math.max(FLOOR[k], Math.floor(Number.isFinite(v) ? v : FLOOR[k]));
  }
  return out;
}

// The employer host a run talks to: the URL's host (with its port, so local test pages on 127.0.0.1 are told apart).
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return `unparsed:${String(url).slice(0, 200)}`;
  }
}

// ------------------------------------------------------------------------------------------ the host's own refusals
// A host that refused is held off until a time; one instance's refusal holds every instance off that host when the gate
// is shared through the database (dbHostGate); localHostGate keeps it in this process (one instance, or tests).
export interface HostGate {
  // When each host may be started again (epoch ms; 0 or past: open). One read for many hosts.
  until(hosts: string[], now: number): Promise<Map<string, number>>;
  // This host refused: until when it is held off (epoch ms).
  refused(host: string, why: string, retryAfterS: number | null, now: number): Promise<number>;
  // A success on this host: its back-off level resets.
  ok(host: string): Promise<void>;
  readonly shared: boolean;
}
// As long as the host asked (Retry-After), else 30 s doubling on each refusal in a row, to at most an hour between tries.
// These are how often a refusing host is asked again, not limits on work: a host that answers is never held.
export const BACKOFF_BASE_MS = 30_000, BACKOFF_CEIL_MS = 3_600_000;
export function backoffMs(level: number, retryAfterS: number | null): number {
  if (retryAfterS !== null && Number.isFinite(retryAfterS) && retryAfterS >= 0) return Math.min(retryAfterS * 1000, 86_400_000);
  return Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, level));
}
// The seconds a host's Retry-After header asks for (RFC 9110 10.2.3): delay-seconds (digits only), or an HTTP-date in
// one of its three forms (IMF-fixdate, RFC 850, asctime), counted from `now` (a date already past is 0). Anything else is
// not an answer (null: the default doubling applies). At most a day (86,400 s), the longest any gate holds a host: a
// larger number would not fit the database's integer argument and would leave the host not held at all.
// Date.parse alone is far too lenient here: it reads "1.5", "-1", "12/31" or "Retry in 5" as dates in 2001, which meant
// a wait of 0 s, the host asked again at once (found by tests/architect/scenarios-apply.test.ts, retry).
const HTTP_DATE = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
];
export const RETRY_AFTER_MAX_S = 86_400;
export function retryAfterSeconds(raw: string | null | undefined, now: number): number | null {
  const v = String(raw ?? "").trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), RETRY_AFTER_MAX_S);
  if (!HTTP_DATE.some((re) => re.test(v))) return null;
  // asctime has no zone: it is GMT (RFC 9110). RFC 850's two-digit year: Date.parse reads it as 19xx/20xx as browsers do.
  const at = Date.parse(HTTP_DATE[2].test(v) ? `${v} GMT` : v);
  return Number.isFinite(at) ? Math.min(RETRY_AFTER_MAX_S, Math.max(0, Math.round((at - now) / 1000))) : null;
}
export function localHostGate(): HostGate {
  const st = new Map<string, { until: number; level: number }>();
  return {
    shared: false,
    async until(hosts) { return new Map(hosts.map((h) => [h, st.get(h)?.until ?? 0])); },
    async refused(host, _why, retryAfterS, now) {
      const s = st.get(host) ?? { until: 0, level: 0 };
      const until = Math.max(s.until, now + backoffMs(s.level, retryAfterS));
      st.set(host, { until, level: s.level + 1 });
      return until;
    },
    async ok(host) { const s = st.get(host); if (s) st.set(host, { until: s.until, level: 0 }); },
  };
}
// The shared gate over three database functions (career_apply_host_backoff_get / career_apply_host_refused /
// career_apply_host_ok: the Request to the database lane; the reference SQL is tests/flow/host-backoff.sql). A database
// that does not have them yet is said once, and this process's own gate is used instead.
export interface GateRpc { rpc: (name: string, args?: unknown) => PromiseLike<{ data: any; error: { message: string } | null }> }
export function dbHostGate(db: GateRpc, o: { log?: (l: string) => void; cacheMs?: number } = {}): HostGate {
  const local = localHostGate(), cache = new Map<string, { until: number; at: number }>();
  let missing = false;
  const absent = (e: { message: string }) => {
    if (!missing && /could not find|does not exist|PGRST202|no function/i.test(e.message)) {
      missing = true;
      (o.log ?? console.log)("The shared host back-off is not in the database yet (career_apply_host_backoff_get): each instance backs off on its own.");
    }
    return missing;
  };
  return {
    get shared() { return !missing; },
    async until(hosts, now) {
      if (missing) return await local.until(hosts, now);
      const ask = hosts.filter((h) => { const c = cache.get(h); return !c || now - c.at >= (o.cacheMs ?? 1000); });
      if (ask.length) {
        const r = await db.rpc("career_apply_host_backoff_get", { p_hosts: ask });
        if (r.error) { if (absent(r.error)) return await local.until(hosts, now); throw Error(`host back-off: ${r.error.message}`); }
        const got = new Map<string, number>((r.data ?? []).map((x: any) => [String(x.host), Date.parse(x.until)]));
        for (const h of ask) cache.set(h, { until: got.get(h) ?? 0, at: now });
      }
      return new Map(hosts.map((h) => [h, cache.get(h)?.until ?? 0]));
    },
    async refused(host, why, retryAfterS, now) {
      if (missing) return await local.refused(host, why, retryAfterS, now);
      const r = await db.rpc("career_apply_host_refused", { p_host: host, p_reason: why.slice(0, 80), p_retry_after_s: retryAfterS });
      if (r.error) { if (absent(r.error)) return await local.refused(host, why, retryAfterS, now); throw Error(`host back-off: ${r.error.message}`); }
      const until = Date.parse(r.data);
      cache.set(host, { until, at: now });
      return until;
    },
    async ok(host) {
      if (missing) return await local.ok(host);
      const r = await db.rpc("career_apply_host_ok", { p_host: host });
      if (r.error && absent(r.error)) await local.ok(host);
    },
  };
}

// What this machine runs on each host now, when it last started there (only for an owner-set hostMax or spacing), and
// until when the gate holds the host off.
export class HostPacer {
  private running = new Map<string, number>();
  private last = new Map<string, number>();
  private held = new Map<string, number>();
  constructor(private p: Pacing) {}
  readyAt(host: string): number {
    const l = this.last.get(host);
    return Math.max(l === undefined ? 0 : l + this.p.hostSpacingMs, this.held.get(host) ?? 0);
  }
  canStart(host: string, now: number): boolean {
    return (this.running.get(host) ?? 0) < this.p.hostMax && now >= this.readyAt(host);
  }
  heldUntil(host: string): number {
    return this.held.get(host) ?? 0;
  }
  hold(host: string, until: number) {
    if (until > 0) this.held.set(host, until);
    else this.held.delete(host);
  }
  started(host: string, now: number) {
    this.running.set(host, (this.running.get(host) ?? 0) + 1);
    this.last.set(host, now);
  }
  // The engine actually starting (after the decision's own async work): spacing counts from the later of the two, so
  // two real starts on one host are never closer than the spacing however long each took to get going.
  began(host: string, now: number) {
    this.last.set(host, Math.max(this.last.get(host) ?? 0, now));
  }
  ended(host: string) {
    this.running.set(host, Math.max(0, (this.running.get(host) ?? 0) - 1));
  }
  inFlight(host: string): number {
    return this.running.get(host) ?? 0;
  }
}

// A verification check, as the engine or the worker records it (the engine's own words or the worker's handed-back ones).
export function isBotCheck(r: { state?: string; reason?: string | null } | null | undefined): boolean {
  const reason = String(r?.reason ?? "");
  return (r?.state === "needs_user" && /^(captcha|bot_check)$/.test(reason)) || reason === "CAPTCHA_AT_SUBMIT";
}
// The host refused this run: a rate limit at its page (the engine's HOST_RATE_LIMITED, with the seconds it asked for) or
// a verification check. The host is backed off; the application ends as the run recorded it.
export function refusal(r: { state?: string; reason?: string | null; retry_after_s?: number | null } | null | undefined): { why: string; retryAfterS: number | null } | null {
  const reason = String(r?.reason ?? "").split(":")[0];
  if (reason === "HOST_RATE_LIMITED") return { why: "rate_limited", retryAfterS: typeof r?.retry_after_s === "number" ? r.retry_after_s : null };
  if (isBotCheck(r)) return { why: "bot_check", retryAfterS: null };
  return null;
}
// The employer's page itself, at its open, refusing for load (scripts/apply.ts, before anything is filled): a 429 (Too Many
// Requests) or a 503 (Service Unavailable), with or without Retry-After. Owner rule (2026-10-27): back off only when an
// outside system refuses, then RESUME; a 503 is the site saying it cannot take us now, the same as a 429. The seconds it
// asked for (retryAfterSeconds), or null: the default doubling. Anything else is not a refusal for load.
export function pageRefusal(status: number, retryAfter: string | null | undefined, now: number): { status: number; retry_after_s: number | null } | null {
  if (status !== 429 && status !== 503) return null;
  return { status, retry_after_s: retryAfterSeconds(retryAfter, now) };
}
// The host refused BEFORE anything was filled or sent, for load: the engine's HOST_RATE_LIMITED (a 429 or a 503, with or
// without Retry-After: pageRefusal), which scripts/apply.ts reports only at the page's open, before any
// field is filled and before any write leaves the browser. Owner rule (2026-10-27): "back off only when an outside
// system refuses, then RESUME". Such an application is not ended: the same job goes back to the queue, its approval and
// hash binding unchanged, not to be claimed before the host's hold ends (career_apply_requeue_refused_*, 20261029180000),
// and runs again then. Nothing else is put back: a verification check and a sign-in wall are the person's (needs_user,
// never retried), and anything after the engine may have sent is unknown, never driven again. Returns the database's
// reason, or null.
export function sentNothingRefusal(r: { state?: string; reason?: string | null; status?: number | null; proof?: unknown; confirmation_id?: unknown } | null | undefined): "rate_limited" | "server_busy" | null {
  if (!r || r.state !== "not_submitted" || String(r.reason ?? "").split(":")[0] !== "HOST_RATE_LIMITED") return null;
  if (r.proof || r.confirmation_id) return null;
  return r.status === 503 ? "server_busy" : "rate_limited";
}
// Why a claim was let go without its engine starting, as the database's put-back names it (20261029190000).
export function unstartedWhy(why: string): string {
  return String(why ?? "").split(":")[0].trim().toLowerCase();
}
// A database that does not have the requeue yet (before 20261029180000): the application is recorded as before.
export const requeueMissing = (text: string) => /career_apply_requeue_refused|PGRST202|could not find the function|no function/i.test(text);

// What only the person can do: a verification check (never solved or got around) or the employer's sign-in wall (never
// signed in for them). Either ends the application needs_user with its link, and it is never retried. The engine stops
// on both before anything is sent (CAPTCHA_AT_SUBMIT: no write left the browser; ACCOUNT_LOGIN_REQUIRED: before filling).
// Returns the reason to record, or null when the result is not one of these.
export function handBack(r: { state?: string; reason?: string | null } | null | undefined): "captcha" | "login_required" | null {
  const reason = String(r?.reason ?? "").split(":")[0];
  if ((r?.state === "needs_user" && reason === "captcha") || reason === "CAPTCHA_AT_SUBMIT") return "captcha";
  if (reason === "ACCOUNT_LOGIN_REQUIRED") return "login_required";
  return null;
}

// -------------------------------------------------------------------------------------------------------- the journal
// One file per claimed application (0600, in a 0700 folder): the job as claimed, when it was claimed, and whether its
// engine started. The start is written and fsynced before the engine runs; the file is removed once the outcome is
// recorded. It holds the person's approved answers for as long as the drive lasts, like the facts file the engine reads.
// Each instance has its own folder (one per machine or container).
// Submit worker round (2026-10-31): the employer's answer is written here too, after the engine returned and before the
// queue records it (`result`). A worker that dies between the two used to leave only "started", recorded unknown on its
// next start although the employer had answered (a confirmation number on the page): the next start now records that
// answer (o.recovered), and still never drives the application again.
export interface JournalResult { state: string; reason?: string | null; outcome?: string | null; errorKind?: string | null; evidence?: Record<string, unknown> }
export interface JournalEntry<J> { job: J; claimedAt: number; started: boolean; result?: JournalResult }
export interface Journal<J extends { id: string }> {
  put(job: J, claimedAt: number): Promise<void>;
  start(id: string): Promise<void>;
  // The engine's answer, before the queue records it (optional: a journal without it leaves the start only).
  result?(id: string, r: JournalResult): Promise<void>;
  done(id: string): Promise<void>;
  list(): Promise<JournalEntry<J>[]>;
}
const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;
export function fileJournal<J extends { id: string }>(dir: string): Journal<J> {
  const file = (id: string) => {
    if (!SAFE_ID.test(id)) throw Error("JOURNAL_BAD_ID");
    return `${dir}/${id}.json`;
  };
  const write = async (path: string, body: unknown) => {
    const tmp = `${path}.tmp`;
    const f = await Deno.open(tmp, { write: true, create: true, truncate: true, mode: 0o600 });
    try {
      await f.write(new TextEncoder().encode(JSON.stringify(body)));
      await f.sync();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, path);
    // The rename itself is made durable with the folder.
    try {
      const d = await Deno.open(dir, { read: true });
      try { await d.sync(); } finally { d.close(); }
    } catch { /* a platform that cannot sync a folder */ }
  };
  let ready: Promise<void> | null = null;
  const init = () => ready ??= (async () => {
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700).catch(() => {});
  })();
  return {
    async put(job, claimedAt) {
      await init();
      await write(file(job.id), { job, claimedAt, started: false });
    },
    async start(id) {
      await init();
      const e = JSON.parse(await Deno.readTextFile(file(id)));
      await write(file(id), { ...e, started: true });
    },
    async result(id, r) {
      await init();
      const e = JSON.parse(await Deno.readTextFile(file(id)));
      await write(file(id), { ...e, started: true, result: r });
    },
    async done(id) {
      await Deno.remove(file(id)).catch(() => {});
    },
    async list() {
      await init();
      const out: JournalEntry<J>[] = [];
      for await (const f of Deno.readDir(dir)) {
        if (!f.isFile || !f.name.endsWith(".json")) continue;
        try {
          const e = JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`));
          if (e?.job?.id && typeof e.claimedAt === "number") {
            out.push({ job: e.job, claimedAt: e.claimedAt, started: e.started === true,
              ...(e.started === true && e.result && typeof e.result.state === "string" ? { result: e.result } : {}) });
          }
        } catch { /* a torn temp write: its rename never happened, so the job was never started from it */ }
      }
      return out.sort((a, b) => a.claimedAt - b.claimedAt);
    },
  };
}

// --------------------------------------------------------------------------------------------------- the scheduler
export interface MassJob { id: string; url: string; lease_token?: string; claimed_at?: string | null }
// requeue: the run met a host refusing before anything was sent and recorded nothing; the scheduler puts the same job back
// (o.requeue). not_before: when the database will hand a requeued job out again (epoch ms).
export interface MassResult { state: string; reason?: string | null; recorded?: boolean; retry_after_s?: number | null; requeue?: boolean; status?: number | null; not_before?: number | null }
export interface Requeue { why: string; reason: "rate_limited" | "server_busy"; retryAfterS: number | null; until: number }
export interface MassOutcome extends MassResult { id: string; host: string; started: boolean }

// When an application was claimed: the earlier of this machine's clock and the database's claimed_at, so a clock that
// runs behind never lets an application start after its lease budget.
function claimTime(job: MassJob, local: number): number {
  const db = job.claimed_at ? Date.parse(job.claimed_at) : NaN;
  return Number.isFinite(db) ? Math.min(local, db) : local;
}

export async function massRun<J extends MassJob>(o: {
  claim: (limit: number) => Promise<J[]>;
  // Runs one claimed application and records its outcome (the finish). `onStart` is awaited right before its engine
  // starts (the journal's durable start); if it throws, the engine must not start. Never throws for a job: a failure is
  // its recorded outcome.
  run: (job: J, onStart: () => Promise<void>, onResult?: (r: JournalResult) => Promise<void>) => Promise<MassResult>;
  // Ends a claimed application that will not be started (its lease budget ran out, or the worker is stopping). Nothing
  // was sent. Recorded not_submitted. Used only where putBack (below) is absent, or for a run that may not be put back.
  unstarted: (job: J, why: string) => Promise<MassResult>;
  // A started application a crashed run left unfinished: recorded unknown_outcome, never driven again.
  orphaned: (job: J) => Promise<MassResult>;
  // A started application a crashed run left with the engine's answer journaled but not recorded: that answer recorded
  // (never driven again). Absent: orphaned.
  recovered?: (job: J, r: JournalResult) => Promise<MassResult>;
  // A run whose host refused before anything was sent (its result says requeue): the same job back to the queue, not to
  // be handed out before `until` (the host's hold); returns state "queued" and the database's not_before. Absent, or for
  // anything but a load refusal, it is recorded not sent (unstarted).
  requeue?: (job: J, q: Requeue) => Promise<MassResult>;
  // A claimed application whose engine never started and will not start in this run (the worker stopping, its lease
  // budget spent, its host held, its journal line unwritable): the same job back to the queue, not to be handed out
  // before `until` (now, or the host's hold), to run later, once (20261029190000). Called only for a claim that never
  // started, after its journal line is cleared. Returns state "queued" and the database's not_before; a queue that
  // cannot put it back records it not sent instead (as unstarted does). Absent: unstarted.
  putBack?: (job: J, why: string, until: number) => Promise<MassResult>;
  // A queue whose claim only leases (many instances: career_apply_claim_fair): the leased applications this round will
  // start become drives, in one call, after their journal lines and before any engine starts. Returns the ids begun; one
  // whose lease lapsed (another instance has it now) is not started here and nothing is recorded for it.
  begin?: (jobs: J[]) => Promise<Set<string>>;
  pacing: Pacing;
  stop: () => boolean;
  journal?: Journal<J>;
  // The hosts' refusals, shared across instances (dbHostGate); absent, this process's own (localHostGate).
  gate?: HostGate;
  // When the queue is empty and nothing is in flight, stop instead of waiting for more (a one-shot drain).
  drain?: boolean;
  idleMs?: number;
  now?: () => number;
  // The wait between asks of an empty or unreadable queue (tests make it instant). Back-off waits are real time.
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  // A claim that throws: "stop" ends the run (an expired sign-in), "wait" asks again after idleMs.
  onClaimError?: (e: unknown) => "stop" | "wait";
}): Promise<MassOutcome[]> {
  const p = o.pacing, now = o.now ?? Date.now, log = o.log ?? ((l: string) => console.log(l)), idle = o.idleMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gate = o.gate ?? localHostGate();
  const pacer = new HostPacer(p);
  const out: MassOutcome[] = [];
  type Item = { job: J; claimedAt: number; host: string };
  const pending: Item[] = [];
  const inFlight = new Set<Promise<void>>();
  // The latest time a job this run put back (a host refused it before anything was sent) may be handed out again: a drain
  // ends only after an empty claim made after it, so a requeued job is driven again before the drain stops.
  let resumeAt = 0, dryAt = 0;
  let signal: () => void = () => {};
  const waitEvent = (ms: number) => new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => { if (timer !== undefined) clearTimeout(timer); signal = () => {}; resolve(); };
    signal = done;
    if (Number.isFinite(ms)) timer = setTimeout(done, Math.max(1, ms));
  });
  const settle = (item: { job: J; host: string }, started: boolean, r: MassResult) =>
    out.push({ id: item.job.id, host: item.host, started, state: r.state, reason: r.reason ?? null, ...(r.recorded !== undefined ? { recorded: r.recorded } : {}) });
  const guarded = async (f: () => Promise<MassResult>): Promise<MassResult> => {
    try { return await f(); } catch (e) { return { state: "unrecorded", reason: String((e as Error)?.message ?? e).slice(0, 200), recorded: false }; }
  };
  const forget = async (id: string, r: MassResult) => { if (o.journal && r.recorded !== false) await o.journal.done(id).catch(() => {}); };
  // The gate's view of the hosts we hold claims for, refreshed before each round of starts.
  const refreshHolds = async () => {
    const hosts = [...new Set(pending.map((x) => x.host))];
    if (!hosts.length) return;
    try {
      for (const [h, until] of await gate.until(hosts, now())) pacer.hold(h, until);
    } catch (e) {
      log(`The host back-off could not be read (${String((e as Error)?.message ?? e).slice(0, 120)}); using what this instance knows.`);
    }
  };

  // 1. What a crashed run left in the journal: a started one is never driven again; an unstarted one runs now if its
  //    claim still has time, else it is ended as not sent.
  if (o.journal) {
    let orphans = 0, kept = 0;
    for (const e of await o.journal.list()) {
      const item = { job: e.job, claimedAt: claimTime(e.job, e.claimedAt), host: hostOf(e.job.url) };
      if (e.started) {
        const answered = e.result, r = answered && o.recovered ? await guarded(() => o.recovered!(e.job, answered)) : await guarded(() => o.orphaned(e.job));
        settle(item, true, r);
        await forget(e.job.id, r);
        orphans++;
      } else { pending.push(item); kept++; }
    }
    if (orphans) log(`${orphans} application(s) were running when the worker last stopped: recorded as unknown, never sent again.`);
    if (kept) log(`${kept} claimed application(s) from the last run had not started; each runs now if its claim still has time.`);
  }

  // The host's count was taken when this start was decided (pacer.started in step 3).
  const start = (item: Item) => {
    let began = false;
    const onStart = async () => {
      if (o.journal) await o.journal.start(item.job.id);
      pacer.began(item.host, now());
      began = true;
    };
    // The engine's answer, journaled before the queue records it (a crash between the two keeps the answer).
    const onResult = async (res: JournalResult) => { if (o.journal?.result) await o.journal.result(item.job.id, res).catch(() => {}); };
    const pr: Promise<void> = (async () => {
      let r = await guarded(() => o.run(item.job, onStart, onResult));
      const no = refusal(r);
      if (no) {
        let until: number;
        try {
          until = await gate.refused(item.host, no.why, no.retryAfterS, now());
          log(`${item.host} refused (${no.why === "rate_limited" ? "rate limited" : "a verification check, handed back to the person, never retried"}); every instance waits until ${new Date(until).toISOString()} before starting there again.`);
        } catch (e) {
          until = now() + backoffMs(0, no.retryAfterS);
          log(`${item.host} refused, and the shared back-off could not be written (${String((e as Error)?.message ?? e).slice(0, 120)}).`);
        }
        pacer.hold(item.host, until);
        // Refused before anything was sent (the run recorded nothing): the same job goes back to the queue until the host's
        // hold ends, its approval unchanged, and runs again then (owner: back off, then RESUME). Never a verification check.
        if (r.requeue) {
          const first = r, reason = first.status === 503 ? "server_busy" as const : "rate_limited" as const;
          r = no.why === "rate_limited" && o.requeue
            ? await guarded(() => o.requeue!(item.job, { why: no.why, reason, retryAfterS: no.retryAfterS, until }))
            : await guarded(() => o.unstarted(item.job, String(first.reason ?? "HOST_RATE_LIMITED")));
          if (r.state === "queued") {
            resumeAt = Math.max(resumeAt, until, Number(r.not_before ?? 0));
            log(`${item.job.id}: nothing was sent; it goes back to the queue and runs again once ${item.host} allows (after ${new Date(Math.max(until, Number(r.not_before ?? 0))).toISOString()}).`);
          }
        }
      } else if (r.requeue) {
        // A run may say "put it back" only for a refusal the gate is told of; anything else is recorded as not sent.
        const first = r;
        r = await guarded(() => o.unstarted(item.job, String(first.reason ?? "HOST_RATE_LIMITED")));
      } else if (began && r.state !== "unrecorded") {
        await gate.ok(item.host).catch(() => {});
      }
      settle(item, began, r);
      await forget(item.job.id, r);
    })().finally(() => {
      pacer.ended(item.host);
      inFlight.delete(pr);
      signal();
    });
    inFlight.add(pr);
  };
  // A claim that never started and will not start here. Put back (owner: back off, then RESUME; 20261029190000) when the
  // queue can: its journal line is cleared FIRST, so a crash after the put-back can never start it from this lease (a
  // crash before it leaves the drive to the database's sweep: unknown, never driven twice). Else recorded not sent.
  const giveUp = async (item: Item, why: string, until = now(), journaled = true) => {
    if (o.putBack) {
      let cleared = true;
      if (o.journal && journaled) await o.journal.done(item.job.id).catch(() => { cleared = false; });
      if (cleared) {
        const r = await guarded(() => o.putBack!(item.job, why, until));
        if (r.state === "queued") {
          resumeAt = Math.max(resumeAt, until, Number(r.not_before ?? 0));
          log(`${item.job.id}: not started (${why}); nothing was sent; it goes back to the queue and runs later.`);
        }
        settle(item, false, r);
        return;
      }
    }
    const r = await guarded(() => o.unstarted(item.job, why));
    settle(item, false, r);
    await forget(item.job.id, r);
  };

  let dry = false, stopped = false;
  while (true) {
    if (!stopped && o.stop()) stopped = true;
    if (stopped) {
      // Stopping: nothing new starts; what was claimed and not started is ended as not sent; the runs in flight finish.
      for (const item of pending.splice(0)) await giveUp(item, "WORKER_STOPPING");
      await Promise.all([...inFlight]);
      break;
    }
    // 2. Claim while this machine has free browsers and nothing it claimed is waiting: a claimed application waits only
    //    behind a host that refused (held off by the gate), never behind a backlog this instance took on. The rest stay
    //    queued for the other instances.
    // What waits on a host that is held off does not take a browser: keep claiming for the hosts that answer (at most one
    // machine's worth may wait on held hosts; on a leased queue they are given back instead, below).
    const tc = now(), waitingHeld = pending.filter((x) => pacer.readyAt(x.host) > tc).length;
    const free = Math.min(p.concurrency - inFlight.size - (pending.length - waitingHeld), 2 * p.concurrency - inFlight.size - pending.length);
    if (!dry && free > 0) {
      const want = Math.min(p.claimBatch, free);
      try {
        const asked = now();
        const jobs = await o.claim(want);
        const at = now();
        if (!jobs.length) { dry = true; dryAt = asked; }
        for (const job of jobs) {
          // A claim row with no id or link is nothing this worker claimed (a database's claim that returned a row it did
          // not take, 20261030140000): never run, never recorded.
          if (!job || typeof job.id !== "string" || !job.id || typeof job.url !== "string") { log("The claim returned a row with no application in it; skipped."); continue; }
          const item = { job, claimedAt: claimTime(job, at), host: hostOf(job.url) };
          if (o.journal) {
            try { await o.journal.put(job, item.claimedAt); } catch (e) {
              // Without its journal line a crash could not tell whether it ran: it is not started.
              // Put back a little later (this machine's disk), so another instance or a later round takes it.
              await giveUp(item, `JOURNAL_UNWRITABLE: ${String((e as Error)?.message ?? e).slice(0, 120)}`, now() + BACKOFF_BASE_MS, false);
              continue;
            }
          }
          pending.push(item);
        }
      } catch (e) {
        if ((o.onClaimError?.(e) ?? "wait") === "stop") { stopped = true; continue; }
        // An unreadable queue is not an empty one (a drain does not end on it): ask again after the idle wait.
        if (!pending.length && !inFlight.size) await sleep(idle);
        else dry = true;
        continue;
      }
    }
    // 3. Start what may start now, oldest claim first. One that waited past its lease budget (its host held off) is
    //    ended as not sent instead of started late.
    await refreshHolds();
    const t = now();
    // A leased queue (o.begin): what waits on a host that is held off goes back to the queue at once (its lease given
    // back; the database's claim skips held hosts), so it never takes a browser from a host that answers.
    if (o.begin) {
      for (let i = 0; i < pending.length;) {
        if (pacer.heldUntil(pending[i].host) > t) {
          const [item] = pending.splice(i, 1);
          await giveUp(item, "HOST_HELD", pacer.heldUntil(item.host));
          continue;
        }
        i++;
      }
    }
    const ready: Item[] = [];
    for (let i = 0; i < pending.length;) {
      const item = pending[i];
      if (t - item.claimedAt > p.startBudgetMs) {
        pending.splice(i, 1);
        await giveUp(item, "NOT_STARTED_IN_LEASE");
        continue;
      }
      if (inFlight.size + ready.length < p.concurrency && pacer.canStart(item.host, t)) {
        pending.splice(i, 1);
        ready.push(item);
        pacer.started(item.host, t); // counted from this decision, so this round never puts more on a host than it may take
        continue;
      }
      i++;
    }
    let begun: Set<string> | null = null;
    if (ready.length && o.begin) {
      try {
        begun = await o.begin(ready.map((x) => x.job));
      } catch (e) {
        // Nothing became a drive: the leases lapse and any instance (this one too) claims them again. Not started.
        log(`The leased applications could not be begun (${String((e as Error)?.message ?? e).slice(0, 120)}); they go back to the queue when their lease lapses.`);
        begun = new Set();
      }
    }
    for (const item of ready) {
      if (begun && !begun.has(item.job.id)) {
        pacer.ended(item.host);
        // Its lease lapsed and another instance holds it now: nothing to record here, and no engine.
        if (o.journal) await o.journal.done(item.job.id).catch(() => {});
        continue;
      }
      start(item);
    }
    if (!pending.length && !inFlight.size) {
      if (dry) {
        if (o.drain && dryAt > resumeAt) break;
        // A job this run put back is due again soon: wait for its time, then ask (a drain does not end before it).
        if (resumeAt >= dryAt) await waitEvent(Math.min(idle, resumeAt - now() + 1));
        else await sleep(idle);
        dry = false;
      }
      continue;
    }
    {
      const tw = now(), held = pending.filter((x) => pacer.readyAt(x.host) > tw).length;
      if (!dry && Math.min(p.concurrency - inFlight.size - (pending.length - held), 2 * p.concurrency - inFlight.size - pending.length) > 0) continue; // free browsers: ask at once
    }
    // 4. Wait for the first of: a run ending, a held host's time passing, a waiting claim reaching its budget, and (when
    //    the queue was empty) the time to ask it again.
    let until = Infinity;
    for (const item of pending) {
      until = Math.min(until, item.claimedAt + p.startBudgetMs + 1);
      if (pacer.inFlight(item.host) < p.hostMax) until = Math.min(until, pacer.readyAt(item.host));
    }
    if (dry) until = Math.min(until, now() + idle, resumeAt >= dryAt ? Math.max(now(), resumeAt + 1) : Infinity);
    // A host held by another instance can be released early (its next success); look again at least every few seconds.
    if (pending.length) until = Math.min(until, now() + 5_000);
    await waitEvent(until - now());
    dry = false;
  }
  return out;
}

// A shared limiter with the same per-host gate, for work that is not claimed (the server's dry runs in prepare-ahead.ts):
// every caller holding the same limiter shares this machine's browsers and the hosts' refusals, however many runs are in
// progress (the chat's door can start several at once). Waiters start in arrival order per host. A run whose result is a
// refusal (`refusalOf`) holds that host off for everyone holding the gate.
export class PacedLimiter {
  private pacer: HostPacer;
  private active = 0;
  private waiting: { host: string; go: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly pacing: Pacing;
  constructor(pacing: Partial<Pacing>, private now: () => number = Date.now, private gate: HostGate = localHostGate()) {
    this.pacing = pacingFrom(() => undefined, pacing);
    this.pacer = new HostPacer(this.pacing);
  }
  get inFlight() { return this.active; }
  async run<R>(url: string, fn: () => Promise<R>, refusalOf?: (r: R) => { why: string; retryAfterS: number | null } | null): Promise<R> {
    const host = hostOf(url);
    try { for (const [h, until] of await this.gate.until([host], this.now())) this.pacer.hold(h, until); } catch { /* this instance's view */ }
    await new Promise<void>((go) => { this.waiting.push({ host, go }); this.pump(); });
    try {
      const r = await fn();
      const no = refusalOf?.(r) ?? null;
      if (no) this.pacer.hold(host, await this.gate.refused(host, no.why, no.retryAfterS, this.now()).catch(() => this.now() + backoffMs(0, no.retryAfterS)));
      else await this.gate.ok(host).catch(() => {});
      return r;
    } finally {
      this.active--;
      this.pacer.ended(host);
      this.pump();
    }
  }
  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const t = this.now();
    let next = Infinity;
    for (let i = 0; i < this.waiting.length && this.active < this.pacing.concurrency;) {
      const w = this.waiting[i];
      if (this.pacer.canStart(w.host, t)) {
        this.waiting.splice(i, 1);
        this.active++;
        this.pacer.started(w.host, t);
        w.go();
        continue;
      }
      if (this.pacer.inFlight(w.host) < this.pacing.hostMax) next = Math.min(next, this.pacer.readyAt(w.host));
      i++;
    }
    if (this.waiting.length && this.active < this.pacing.concurrency && Number.isFinite(next)) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, next - this.now()));
    }
  }
}

// Every item through one limiter (a fresh one unless given), results in the items' order.
export async function pacedPool<T, R>(items: T[], o: {
  url: (item: T) => string;
  run: (item: T) => Promise<R>;
  pacing?: Partial<Pacing>;
  limiter?: PacedLimiter;
}): Promise<R[]> {
  const limiter = o.limiter ?? new PacedLimiter(o.pacing ?? {});
  return await Promise.all(items.map((item) => limiter.run(o.url(item), () => o.run(item))));
}
