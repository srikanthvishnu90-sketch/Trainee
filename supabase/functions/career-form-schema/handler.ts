// career-form-schema (WO-121, D-042 M4): the scheduled lane that reads each new Greenhouse, Lever and Ashby posting's
// application form once, soon after the ingest first sees it, with one plain request and no browser, and stores the form
// with its person-independent map (career_posting_forms). pg_cron calls it every minute
// (scripts/launch/schedule-career-form-schema.sql) with its own secret. Polite and bounded: at most `perHost` reads in
// flight per ATS host with a `gapMs` gap between starts; a 429 stops that host for the rest of the tick (its row is
// recorded rate_limited; the host's rows not yet read are left for a later tick, never given a verdict); at most 5
// attempts per posting, 15 min x attempt apart (the database's todo). No model is reached; nothing is answered or sent.
import { equalSecret } from "../_shared/message_service.ts";
import { mapForm, type MappedField } from "../_shared/form_readiness.ts";
import { type FormField, type FormSchema, type FormUnread, formRequestFor, readForm, type Unread } from "../_shared/posting_schema.ts";

export interface TodoRow { job_id: string; provider: string; board: string; ats_id: string | null; url: string; first_seen_at: string }
export interface FormRow {
  job_id: string; provider: string; state: "captured" | "unread"; source: string | null; unread: Unread | null; detail: string | null;
  fields: FormField[]; mapped: MappedField[]; uploads: string[]; captcha_expected: boolean | null; schema_sha256: string | null;
  first_seen_at: string; read_at: string;
}
export interface LaneDeps {
  todo: () => Promise<TodoRow[]>; put: (rows: FormRow[]) => Promise<number>; fetch: typeof fetch; now: () => number;
  perHost: number; gapMs: number; ashbyGraphql: boolean; deadlineMs: number; userAgent?: string;
}
export type LaneResult = { claimed: number; captured: number; unread: Record<Unread, number>; left_for_next_tick: number; model_calls: 0 };
const UNREAD: Unread[] = ["not_public", "needs_partner_key", "sign_in_required", "no_form", "http_error", "rate_limited", "parse_error"];
const BATCH = 100;

export function formRow(t: TodoRow, r: FormSchema | FormUnread): FormRow {
  const base = { job_id: t.job_id, provider: t.provider, first_seen_at: t.first_seen_at, read_at: r.read_at };
  if ("unread" in r) {
    return { ...base, state: "unread", source: null, unread: r.unread, detail: (r.retry_after_s !== undefined ? `${r.detail}; retry after ${r.retry_after_s} s` : r.detail).slice(0, 300),
      fields: [], mapped: [], uploads: [], captcha_expected: null, schema_sha256: null };
  }
  return { ...base, state: "captured", source: r.source, unread: null, detail: null, fields: r.fields, mapped: mapForm(r), uploads: r.uploads,
    captcha_expected: r.captcha_expected, schema_sha256: r.sha256 };
}

export async function runFormLane(d: LaneDeps): Promise<LaneResult> {
  const started = d.now();
  const rows = await d.todo();
  const out: LaneResult = { claimed: rows.length, captured: 0, unread: Object.fromEntries(UNREAD.map((u) => [u, 0])) as Record<Unread, number>,
    left_for_next_tick: 0, model_calls: 0 };
  const buf: FormRow[] = [];
  const flush = async (all: boolean) => { while (buf.length >= BATCH || (all && buf.length)) await d.put(buf.splice(0, BATCH)); };
  const record = async (t: TodoRow, r: FormSchema | FormUnread) => {
    buf.push(formRow(t, r));
    if ("unread" in r) out.unread[r.unread]++; else out.captured++;
    await flush(false);
  };
  // Rows that need no request (SmartRecruiters, Workday, Ashby without the owner's yes, never-read hosts) are recorded
  // at once; the rest queue per ATS host.
  const queues = new Map<string, TodoRow[]>();
  for (const t of rows) {
    const req = formRequestFor(t, { ashbyGraphql: d.ashbyGraphql });
    if ("unread" in req) { await record(t, { ...req, read_at: new Date(d.now()).toISOString() }); continue; }
    const host = new URL(req.url).hostname;
    queues.get(host)?.push(t) ?? queues.set(host, [t]);
  }
  const perHost = Math.max(1, Math.min(8, Math.floor(d.perHost) || 1));
  await Promise.all([...queues.values()].map(async (q) => {
    let stopped = false, nextAt = 0;
    const worker = async () => {
      while (q.length && !stopped && d.now() - started < d.deadlineMs) {
        const slot = Math.max(Date.now(), nextAt);
        nextAt = slot + d.gapMs;
        if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
        if (stopped || d.now() - started >= d.deadlineMs) break;
        const t = q.shift();
        if (!t) break;
        const r = await readForm(t, { fetch: d.fetch, now: d.now, ashbyGraphql: d.ashbyGraphql, userAgent: d.userAgent });
        if ("unread" in r && r.unread === "rate_limited") stopped = true;
        await record(t, r);
      }
    };
    await Promise.all(Array.from({ length: perHost }, worker));
    out.left_for_next_tick += q.length;
  }));
  await flush(true);
  return out;
}

// The HTTP entry: POST with x-trainee-form-schema-secret; ?limit (default 600) and ?since_h (default 24).
export interface FormSchemaDeps {
  env: { get(k: string): string | undefined };
  db: () => { todo(since: string, limit: number): Promise<TodoRow[]>; put(rows: FormRow[]): Promise<number> };
  fetch: typeof fetch; now: () => number;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const int = (v: string | null, d: number, lo: number, hi: number) => { const n = Math.floor(Number(v)); return v && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export async function handleFormSchema(req: Request, d: FormSchemaDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("CAREER_FORM_SCHEMA_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: CAREER_FORM_SCHEMA_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-form-schema-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  const contact = d.env.get("INGEST_CONTACT_EMAIL") || "";
  if (!contact) return json({ error: "not configured: INGEST_CONTACT_EMAIL is not set (boards are told who is reading them)" }, 503);
  const q = new URL(req.url).searchParams, db = d.db();
  const since = new Date(d.now() - int(q.get("since_h"), 24, 1, 168) * 3600_000).toISOString(), limit = int(q.get("limit"), 600, 1, 2000);
  try {
    const t0 = d.now();
    const out = await runFormLane({ todo: () => db.todo(since, limit), put: (rows) => db.put(rows), fetch: d.fetch, now: d.now,
      perHost: 4, gapMs: 250, ashbyGraphql: d.env.get("CAREER_FORM_ASHBY_GRAPHQL") === "on", deadlineMs: 100_000,
      userAgent: `Trainee job alerts (contact: ${contact})` });
    return json({ ok: true, ...out, ms: d.now() - t0 });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
}
