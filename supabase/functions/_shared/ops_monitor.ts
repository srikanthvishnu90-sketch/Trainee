// Owner monitoring (2026-10-28). Reads existing tables, decides in pure code (evaluate), and tells the owner through the
// existing founder_alerts path (one ops_* row per alert, which is also the dedupe record) and a Telegram message to the owner
// chat. A source that cannot be read is "not measured" and raises no alert about itself; the digest names it.
// Nothing here calls a model or spends money. Secrets are read from env and never logged or put in a message.
import { buildFunnel, type FunnelSource, renderFunnel } from "./ops_funnel.ts";

type Admin = any;
const H = 3600000, MIN = 60000;

export interface Snapshot {
  now: number;
  ingest: { lastRunAt: string | null } | null;
  delivery: { runs: { run_at: string; delivered: number; failed: number; error: string | null }[] } | null;
  worker: { oldestQueuedAt: string | null; lastClaimAt: string | null; stuckDriving: number } | null;
  refusals: { id: string; kind: string; created_at: string; detail: any }[] | null;
  spend: Spend | null;
  http5xx: { fn: string; count: number }[] | null;
  // Optional so a caller that does not read them is unchanged (undefined = not measured, like null).
  deploySmoke?: { id: string; created_at: string; sha: string; fail: number; notRun: number } | null; // newest founder_alerts kind=deploy_smoke
  outbox?: { oldestPendingAt: string | null; pending: number } | null; // texts due but never delivered (career_outbox)
  // approval_rate_v (rolling 7 days, per kind); undefined/null = not measured.
  approval?: { kind: string; shown: number; approvedUnchanged: number }[] | null;
}
// The owner's quality line: of what Trainee shows the person, at least 95% is accepted as shown, once a kind has 20 or more shown.
// A measurement, never a limit: it raises an alert to the owner and changes nothing a person is shown, asked, or sent.
export const APPROVAL_TARGET_PCT = 95, APPROVAL_MIN_SHOWN = 20;
export interface Spend { source: "model_budget" | "turn_costs"; day: string; spentMicros: number; reservedMicros: number; limitMicros: number }
export interface Thresholds { ingestStaleMs: number; deliveryWindowMs: number; deliveryMinFailed: number; deliverySilentMs: number; workerQueuedMs: number; workerDrivingMs: number; http5xxMin: number; smokeFreshMs: number; outboxStuckMs: number }
export const DEFAULTS: Thresholds = { ingestStaleMs: 2 * H, deliveryWindowMs: 30 * MIN, deliveryMinFailed: 3, deliverySilentMs: 10 * MIN, workerQueuedMs: 20 * MIN, workerDrivingMs: 30 * MIN, http5xxMin: 10, smokeFreshMs: 24 * H, outboxStuckMs: 30 * MIN };
export interface Alert { kind: string; key: string; cooldownMs: number; text: string }

const ago = (now: number, iso: string | null) => (iso ? now - Date.parse(iso) : Infinity);
const mins = (ms: number) => `${Math.round(ms / MIN)} minutes`;
// Free text from a table (a delivery run's error) is untrusted: it can carry a URL with a token, an address, a phone number or a
// key. It is reduced to a short, plain, redacted phrase before it goes into an alert (which is stored and sent to Telegram).
export function sanitizeError(raw: unknown, max = 100): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]")
    .replace(/\b(bearer|basic)(\s+)\S+/gi, "$1$2[redacted]")
    .replace(/\b(token|api[_-]?key|apikey|key|secret|password|passwd|authorization|auth|signature|sig)\b(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, "[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
export const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

export function evaluate(s: Snapshot, t: Thresholds = DEFAULTS): Alert[] {
  const out: Alert[] = [];
  if (s.ingest) {
    const age = ago(s.now, s.ingest.lastRunAt);
    if (age > t.ingestStaleMs) out.push({ kind: "ingest_stalled", key: "ingest_stalled", cooldownMs: 6 * H,
      text: s.ingest.lastRunAt ? `Job ingest has not completed a run for ${(age / H).toFixed(1)} hours (last run ${s.ingest.lastRunAt}). The posting index is going stale.` : "Job ingest has never recorded a completed run." });
  }
  if (s.delivery) {
    const runs = s.delivery.runs.filter((r) => ago(s.now, r.run_at) <= t.deliveryWindowMs);
    const failed = runs.reduce((n, r) => n + r.failed, 0), delivered = runs.reduce((n, r) => n + r.delivered, 0), errored = runs.filter((r) => r.error).length;
    if ((failed >= t.deliveryMinFailed && failed > delivered) || errored >= 2) out.push({ kind: "delivery_failing", key: "delivery_failing", cooldownMs: 2 * H,
      text: `Message deliveries are failing: in the last ${mins(t.deliveryWindowMs)}, ${failed} failed, ${delivered} delivered, ${errored} runs errored${runs.find((r) => r.error) ? ` (${sanitizeError(runs.find((r) => r.error)!.error)})` : ""}.` });
    const newest = Math.min(...s.delivery.runs.map((r) => ago(s.now, r.run_at)), Infinity);
    if (newest > t.deliverySilentMs) out.push({ kind: "delivery_silent", key: "delivery_silent", cooldownMs: 2 * H,
      text: newest === Infinity ? "The delivery runner has no recorded run." : `The delivery runner has not recorded a run for ${mins(newest)}. Texts are not going out.` });
  }
  if (s.worker) {
    const q = ago(s.now, s.worker.oldestQueuedAt), c = ago(s.now, s.worker.lastClaimAt);
    if (s.worker.oldestQueuedAt && q > t.workerQueuedMs && c > t.workerQueuedMs) out.push({ kind: "apply_worker_down", key: "apply_worker_down", cooldownMs: 2 * H,
      text: `The apply worker looks down: the oldest queued application has waited ${mins(q)} and nothing has been claimed for ${c === Infinity ? "as long as the queue records" : mins(c)}.` });
    if (s.worker.stuckDriving > 0) out.push({ kind: "apply_worker_stuck", key: "apply_worker_stuck", cooldownMs: 2 * H,
      text: `${s.worker.stuckDriving} application(s) have been in the driving state for over ${mins(t.workerDrivingMs)}: the worker may have died mid-run.` });
  }
  for (const r of s.refusals ?? []) out.push({ kind: "model_budget_refusal", key: r.id, cooldownMs: 7 * 24 * H,
    text: `Model budget refusal (${r.kind.replace("model_budget_", "")}) on ${r.detail?.day ?? r.created_at.slice(0, 10)}: no paid model call is being made${r.detail?.limit_micros != null ? `; limit ${usd(Number(r.detail.limit_micros))}, spent ${usd(Number(r.detail.spent_micros ?? 0))}` : ""}.` });
  if (s.spend && s.spend.limitMicros > 0) {
    const used = s.spend.spentMicros + s.spend.reservedMicros, pct = (100 * used) / s.spend.limitMicros;
    const level = [100, 80, 50].find((p) => pct >= p);
    if (level) out.push({ kind: "spend_threshold", key: `${s.spend.day}:${level}`, cooldownMs: 36 * H,
      text: `Model spend has crossed ${level}% of the daily cap for ${s.spend.day}: ${usd(used)} of ${usd(s.spend.limitMicros)} (${pct.toFixed(0)}%), source ${s.spend.source}.` });
  }
  for (const e of s.http5xx ?? []) if (e.count >= t.http5xxMin) out.push({ kind: "http_5xx_spike", key: `http_5xx_spike:${e.fn}`, cooldownMs: 1 * H,
    text: `5xx spike: function ${e.fn} returned ${e.count} server errors in the last 15 minutes.` });
  // A deploy smoke that failed (or ran with a FAIL) is reported once per run, for a day after it ran; a later passing run replaces it.
  const sm = s.deploySmoke;
  if (sm && sm.fail > 0 && ago(s.now, sm.created_at) <= t.smokeFreshMs) out.push({ kind: "deploy_smoke_failed", key: sm.id, cooldownMs: 24 * H,
    text: `The last deploy smoke${sm.sha ? ` (commit ${sm.sha.slice(0, 7)})` : ""} had ${sm.fail} failing check(s) and ${sm.notRun} not run, at ${sm.created_at}. The live project may not match what was shipped; re-run scripts/launch/trainee-go-live.sh --only-smoke.` });
  // Stuck queue: texts that were due long ago and were never delivered (the delivery runner can be "running" and still not draining).
  if (s.outbox && s.outbox.pending > 0 && s.outbox.oldestPendingAt && ago(s.now, s.outbox.oldestPendingAt) > t.outboxStuckMs) out.push({ kind: "outbox_stuck", key: "outbox_stuck", cooldownMs: 2 * H,
    text: `${s.outbox.pending} queued text(s) are past due and undelivered; the oldest has waited ${mins(ago(s.now, s.outbox.oldestPendingAt))}. The delivery queue is stuck.` });
  for (const a of s.approval ?? []) {
    if (a.shown < APPROVAL_MIN_SHOWN || a.approvedUnchanged * 100 >= APPROVAL_TARGET_PCT * a.shown) continue;
    const kind = String(a.kind).replace(/[^a-z_]/g, "").slice(0, 40);
    out.push({ kind: "approval_below_target", key: `approval_below_target:${kind}`, cooldownMs: 24 * H,
      text: `Approval rate for ${kind.replace(/_/g, " ")} is ${(100 * a.approvedUnchanged / a.shown).toFixed(1)}% over the last 7 days (${a.approvedUnchanged} approved unchanged of ${a.shown} shown), under the ${APPROVAL_TARGET_PCT}% target. Read the edits and skips, then fix the cause.` });
  }
  return out;
}

// ---- Reads. Each degrades to null (not measured) on any error, including a table that does not exist yet.
export function chicagoDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
const safe = async <T>(f: () => Promise<T | null>): Promise<T | null> => { try { return await f(); } catch { return null; } };

export async function readSpend(admin: Admin, nowMs: number, env: { get(k: string): string | undefined }, dayMs = nowMs): Promise<Spend | null> {
  const day = chicagoDay(dayMs);
  const b = await safe(async () => {
    const r = await admin.from("model_budget_days").select("limit_micros,spent_micros,reserved_micros").eq("day", day).maybeSingle();
    if (r.error || !r.data) return null; // table absent (PR #260 not on trunk) or no approved row for the day
    return { source: "model_budget" as const, day, spentMicros: Number(r.data.spent_micros), reservedMicros: Number(r.data.reserved_micros), limitMicros: Number(r.data.limit_micros) };
  });
  if (b) return b;
  const cap = Number(env.get("OPS_DAILY_CAP_USD") ?? ""); // fallback: the turn-cost ledger against an owner-set cap
  if (!(cap > 0)) return null;
  return await safe(async () => {
    const utc = new Date(dayMs).toISOString().slice(0, 10);
    const r = await admin.from("agent_turn_costs").select("usd_micros").gte("created_at", `${utc}T00:00:00Z`).lt("created_at", new Date(Date.parse(`${utc}T00:00:00Z`) + 24 * H).toISOString()).limit(50000);
    if (r.error) return null;
    return { source: "turn_costs" as const, day: utc, spentMicros: (r.data ?? []).reduce((n: number, x: any) => n + Number(x.usd_micros || 0), 0), reservedMicros: 0, limitMicros: Math.round(cap * 1e6) };
  });
}

export async function readSnapshot(admin: Admin, env: { get(k: string): string | undefined }, now: number, fetch5xx?: () => Promise<{ fn: string; count: number }[] | null>): Promise<Snapshot> {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    now,
    ingest: await safe(async () => {
      const r = await admin.from("career_ingest_state").select("last_run_at").eq("id", 1).maybeSingle();
      if (r.error) return null;
      let last = r.data?.last_run_at ?? null;
      const runs = await admin.from("career_ingest_runs").select("at").order("at", { ascending: false }).limit(1);
      const at = !runs.error && runs.data?.[0]?.at;
      if (at && (!last || Date.parse(at) > Date.parse(last))) last = at;
      return { lastRunAt: last };
    }),
    delivery: await safe(async () => {
      const r = await admin.from("channel_delivery_runs").select("run_at,delivered,failed,error").gte("run_at", iso(now - 2 * H)).order("run_at", { ascending: false }).limit(200);
      return r.error ? null : { runs: r.data ?? [] };
    }),
    worker: await safe(async () => {
      const q = await admin.from("career_apply_jobs").select("created_at").eq("state", "queued").order("created_at", { ascending: true }).limit(1);
      const c = await admin.from("career_apply_jobs").select("claimed_at").not("claimed_at", "is", null).order("claimed_at", { ascending: false }).limit(1);
      const d = await admin.from("career_apply_jobs").select("id", { count: "exact", head: true }).eq("state", "driving").lt("claimed_at", iso(now - DEFAULTS.workerDrivingMs));
      if (q.error || c.error) return null;
      return { oldestQueuedAt: q.data?.[0]?.created_at ?? null, lastClaimAt: c.data?.[0]?.claimed_at ?? null, stuckDriving: d.error ? 0 : (d.count ?? 0) };
    }),
    refusals: await safe(async () => {
      const r = await admin.from("founder_alerts").select("id,kind,created_at,detail").like("kind", "model_budget_%").gte("created_at", iso(now - 24 * H)).limit(50);
      return r.error ? null : (r.data ?? []).map((x: any) => ({ ...x, id: String(x.id) }));
    }),
    spend: await readSpend(admin, now, env),
    http5xx: fetch5xx ? await safe(fetch5xx) : null,
    deploySmoke: await safe(async () => {
      const r = await admin.from("founder_alerts").select("id,created_at,detail").eq("kind", "deploy_smoke").order("created_at", { ascending: false }).limit(1);
      if (r.error) return null;
      const x = r.data?.[0];
      return x ? { id: String(x.id ?? x.created_at), created_at: x.created_at, sha: String(x.detail?.sha ?? ""), fail: Number(x.detail?.fail ?? 0), notRun: Number(x.detail?.not_run ?? 0) } : { id: "none", created_at: iso(0), sha: "", fail: 0, notRun: 0 };
    }),
    outbox: await safe(async () => {
      const r = await admin.from("career_outbox").select("deliver_at").is("delivered_at", null).lt("deliver_at", iso(now - DEFAULTS.outboxStuckMs)).order("deliver_at", { ascending: true }).limit(500);
      return r.error ? null : { oldestPendingAt: r.data?.[0]?.deliver_at ?? null, pending: (r.data ?? []).length };
    }),
    approval: await safe(async () => {
      const r = await admin.from("approval_rate_v").select("kind,shown,approved_unchanged");
      return r.error ? null : (r.data ?? []).map((x: any) => ({ kind: String(x.kind), shown: Number(x.shown), approvedUnchanged: Number(x.approved_unchanged) }));
    }),
  };
}

// Supabase edge-function 5xx counts over the last 15 minutes, through the Management API analytics endpoint. Needs
// SUPABASE_ACCESS_TOKEN (a personal access token, the owner creates it) and SUPABASE_PROJECT_REF; else null (not measured).
export function edge5xxFetcher(env: { get(k: string): string | undefined }, now: number, request: typeof fetch = fetch): (() => Promise<{ fn: string; count: number }[] | null>) | undefined {
  const token = env.get("SUPABASE_ACCESS_TOKEN"), ref = env.get("SUPABASE_PROJECT_REF");
  if (!token || !ref) return undefined;
  return async () => {
    const sql = "select request.path as path, count(*) as n from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as request cross join unnest(m.response) as response where response.status_code >= 500 group by request.path";
    const u = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all`);
    u.searchParams.set("sql", sql); u.searchParams.set("iso_timestamp_start", new Date(now - 15 * MIN).toISOString()); u.searchParams.set("iso_timestamp_end", new Date(now).toISOString());
    const r = await request(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const body = await r.json();
    return (body.result ?? []).map((x: any) => ({ fn: String(x.path ?? "").replace(/^\/(functions\/v1\/)?/, "").split("/")[0] || "unknown", count: Number(x.n) }));
  };
}

// ---- Telegram to the owner chat (plain text, one message; 4096 is Telegram's limit).
export async function sendOwner(env: { get(k: string): string | undefined }, text: string, request: typeof fetch = fetch): Promise<"sent" | "not_configured" | string> {
  const token = env.get("TELEGRAM_BOT_TOKEN"), chat = env.get("OWNER_TELEGRAM_CHAT_ID");
  if (!token || !chat) return "not_configured";
  try {
    const r = await request(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } }) });
    return r.ok ? "sent" : `failed:${r.status}`;
  } catch { return "failed:network"; }
}

// ---- Dispatch with dedupe. The ops_<kind> founder_alerts row is both the owner-visible record and the dedupe key.
// A failed Telegram send is not retried on every 5-minute run for the whole outage: one attempt per alert per hour.
export const RETRY_AFTER_MS = H;
export async function dispatch(admin: Admin, env: { get(k: string): string | undefined }, alerts: Alert[], now: number, request: typeof fetch = fetch) {
  const results: { kind: string; key: string; telegram: string }[] = [];
  const configured = !!(env.get("TELEGRAM_BOT_TOKEN") && env.get("OWNER_TELEGRAM_CHAT_ID"));
  for (const a of alerts) {
    const since = new Date(now - a.cooldownMs).toISOString();
    const r = await admin.from("founder_alerts").select("detail,created_at").eq("kind", `ops_${a.kind}`).gte("created_at", since).limit(200);
    const prior = (r.data ?? []).filter((x: any) => x.detail?.key === a.key);
    // A prior row blocks a repeat if it reached the owner, if Telegram is not configured now (nothing new could do better), or
    // if the last attempt was under an hour ago (back off, do not retry a down Telegram every run).
    const recent = (x: any) => !(Date.parse(x.created_at) <= now - RETRY_AFTER_MS);
    if (prior.some((x: any) => x.detail?.telegram === "sent" || !configured || recent(x))) continue;
    const telegram = await sendOwner(env, `[Trainee alert] ${a.text}`, request);
    await admin.from("founder_alerts").insert({ kind: `ops_${a.kind}`, user_id: null, detail: { key: a.key, text: a.text, telegram } });
    results.push({ kind: a.kind, key: a.key, telegram });
  }
  return results;
}

// ---- Daily digest: the funnel for the last full UTC day, and spend.
export async function buildDigest(admin: Admin, env: { get(k: string): string | undefined }, source: FunnelSource, now: number): Promise<string> {
  const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  const f = await buildFunnel(source, new Date(dayStart - 24 * H).toISOString(), new Date(dayStart).toISOString());
  const today = await readSpend(admin, now, env), yday = await readSpend(admin, dayStart - 12 * H, env);
  const sp = (label: string, s: Spend | null) => s ? `${label}: ${usd(s.spentMicros + s.reservedMicros)} of ${usd(s.limitMicros)} cap (${(100 * (s.spentMicros + s.reservedMicros) / Math.max(1, s.limitMicros)).toFixed(0)}%), ${s.day}, source ${s.source}` : `${label}: not measured (no budget row or cap configured)`;
  return ["Trainee daily digest", renderFunnel(f, { maxDays: 1 }), sp("Spend yesterday", yday), sp("Spend today so far", today)].join("\n\n");
}

export async function digestAlreadySent(admin: Admin, day: string): Promise<boolean> {
  const r = await admin.from("founder_alerts").select("detail").eq("kind", "ops_digest").gte("created_at", new Date(Date.parse(day + "T00:00:00Z")).toISOString()).limit(20);
  return (r.data ?? []).some((x: any) => x.detail?.key === day && x.detail?.telegram === "sent");
}
