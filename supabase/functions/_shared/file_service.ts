// File service: create (validate against the kind, store for ONE user, mint the link), read (expiry and revocation), revoke.
// The link is minted here, in code. The agent tool never sees it and the model never writes it. Tests: tests/architect/file-kinds.test.ts.
import { feedUrlsFor } from "./file_link.ts";
import { KIND_LABEL, tagOf, validateKind, type FileRecord, type KindId } from "./file_kinds.ts";

export const DEFAULT_TTL_HOURS = 168; // a week; TRAINEE_FILE_TTL_HOURS sets it (1 to 720)
// Every read and write is keyed by the user id, so one person can never read, change or revoke another's file.
export interface FileKindStore {
  put(rec: FileRecord): Promise<void>;
  get(userId: string, id: string): Promise<FileRecord | null>;
  patch(userId: string, id: string, state: Record<string, unknown>): Promise<void>; // merges into the record's state
  revoke(userId: string, id: string, at: number): Promise<boolean>;
  claim(userId: string, id: string, name: string, at: number): Promise<boolean>; // atomic once-only: true for the first caller of (user, file, name) only
}
export type FileRead = { state: "ok"; rec: FileRecord } | { state: "expired" | "revoked"; rec: FileRecord } | { state: "missing" };
// A row of the person's own application record (career_apply_jobs). The ONLY place "From Trainee's records" values come from.
export interface ApplicationRow { state: string; reason: string | null; confirmation_id: string | null; created_at: string; updated_at: string; email_confirmed_at?: string | null; payload: Record<string, unknown>; company: string; url?: string }
export interface Records { application(userId: string, id: string): Promise<ApplicationRow | null> }
export type Env = { get(k: string): string | undefined };
export interface FileService {
  create(userId: string, kind: string, data: unknown): Promise<{ ok: true; id: string; kind: KindId; title: string; url: string | null; webApp: string | null } | { ok: false; error: string }>;
  get(userId: string, id: string): Promise<FileRead>;
  patchState(userId: string, id: string, state: Record<string, unknown>): Promise<void>;
  revoke(userId: string, id: string): Promise<boolean>;
  ttlHours(): number;
  claim(userId: string, id: string, name: string): Promise<boolean>;
}

const STATUS: Record<string, string> = { queued: "queued", driving: "prepared", needs_user: "prepared", submitted_unconfirmed: "submitted", confirmed: "confirmed", failed: "failed", not_submitted: "failed" };
const SECRETISH = /pass(?:word|wd|code)?\b|one[- ]?time|\botp\b|\bssn\b|social security|card number|\bcvv\b|\bpin\b|passport|api[-_ ]?key|secret|\btoken\b/i;
// Everything on an application proof comes from the record, built here by code. The model supplies only the application id.
export function proofFromRow(row: ApplicationRow, now: number): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const status = STATUS[row.state];
  if (!status) return { ok: false, error: `the application's outcome is not known (recorded as ${row.state}), so there is nothing to show` };
  const reason = String(row.reason ?? "").trim();
  const fields = (Array.isArray((row.payload as any)?.fields) ? (row.payload as any).fields : []) as any[];
  const answers = fields.filter((f) => f && !SECRETISH.test(`${f.name ?? ""} ${f.label ?? ""}`) && !/file/i.test(String(f.type ?? "")) && String(f.value ?? "").trim())
    .slice(0, 30).map((f) => ({ question: String(f.label ?? f.name ?? "Field").replace(/\s+/g, " ").trim().slice(0, 80), answer: String(f.value).replace(/\s+/g, " ").trim().slice(0, 500), source: "From Trainee's records" }));
  const problems = status === "failed" && reason ? [{ item: "Submitting the application", outcome: "failed", reason: reason.slice(0, 300) }]
    : row.state === "needs_user" && reason ? [{ item: "Waiting for you", outcome: "skipped", reason: reason.slice(0, 300) }] : [];
  const rn = String((row.payload as any)?.resume_name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const dest = (() => { try { return new URL(String(row.url ?? "")).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  return { ok: true, data: { title: `Application to ${row.company}`.slice(0, 80), company: row.company, status, prepared_at: row.created_at, as_of: row.updated_at,
    // No submit time: the row has none (claimed_at is when the drive started, not when it was sent), so the page says "Last updated".
    ...(status === "confirmed" && row.confirmation_id ? { confirmation: { id: row.confirmation_id } } : {}), ...(dest ? { destination: dest } : {}), ...(rn ? { resume: rn } : {}), answers, problems } };
}

export function createFileService(o: { store: FileKindStore; env: Env; now: () => number; records?: Records | null }): FileService {
  const ttlHours = () => { const n = Number(o.env.get("TRAINEE_FILE_TTL_HOURS")); return Number.isFinite(n) && n >= 1 && n <= 720 ? Math.floor(n) : DEFAULT_TTL_HOURS; };
  return {
    ttlHours,
    async create(userId, kind, data) {
      if (!userId) return { ok: false, error: "not created: no person to make it for" };
      const now = o.now();
      let v = validateKind(kind, data, { now });
      if (!v.ok) return { ok: false, error: `not created: ${v.errors.join("; ")}` };
      if (kind === "application_proof") {
        // The record is read server-side; if it can't be read, there is no file (nothing is guessed or filled in).
        const row = o.records ? await o.records.application(userId, v.data.application_id).catch(() => null) : null;
        if (!row) return { ok: false, error: "not created: that application isn't on record for this person (or can't be read now), so there is nothing to prove. Do not describe it." };
        const built = proofFromRow(row, now);
        if (!built.ok) return { ok: false, error: `not created: ${built.error}` };
        v = validateKind(kind, built.data, { trusted: true, now });
        if (!v.ok) return { ok: false, error: `not created: the record could not be shown (${v.errors.join("; ")})` };
      }
      const id = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const links = await feedUrlsFor(o.env, userId, id, now);
      if (!links.url && !links.webApp) return { ok: false, error: "not created: file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was made." };
      await o.store.put({ id, userId, kind: kind as KindId, data: v.data, state: {}, tag: await tagOf(kind, v.data), created_at: now, expires_at: now + ttlHours() * 3600_000, revoked_at: null });
      return { ok: true, id, kind: kind as KindId, title: String(v.data.title ?? KIND_LABEL[kind as KindId]), url: links.url, webApp: links.webApp };
    },
    async get(userId, id) {
      const rec = userId && /^[0-9a-f]{10}$/.test(id) ? await o.store.get(userId, id) : null;
      if (!rec || rec.userId !== userId || (rec.kind === "application_proof" && rec.data?.from_record !== true)) return { state: "missing" };
      if (rec.revoked_at !== null) return { state: "revoked", rec };
      return o.now() >= rec.expires_at ? { state: "expired", rec } : { state: "ok", rec };
    },
    patchState: (userId, id, state) => o.store.patch(userId, id, state),
    claim: (userId, id, name) => o.store.claim(userId, id, name, o.now()),
    revoke: (userId, id) => o.store.revoke(userId, id, o.now()),
  };
}

// In-memory store (tests, and any caller without a database).
export function memoryFileStore(): FileKindStore & { size(): number; all(): FileRecord[] } {
  const m = new Map<string, FileRecord>();
  const k = (u: string, id: string) => `${u}|${id}`;
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const claims = new Set<string>();
  return {
    size: () => m.size, all: () => [...m.values()].map(copy),
    async put(r) { m.set(k(r.userId, r.id), copy(r)); },
    async get(u, id) { const r = m.get(k(u, id)); return r ? copy(r) : null; },
    async patch(u, id, state) { const r = m.get(k(u, id)); if (r) r.state = { ...r.state, ...copy(state) }; },
    async revoke(u, id, at) { const r = m.get(k(u, id)); if (!r || r.revoked_at !== null) return false; r.revoked_at = at; return true; },
    async claim(u, id, name) { const key = `${k(u, id)}|claim|${name}`; if (claims.has(key)) return false; claims.add(key); return true; }, // no await between check and set: atomic
  };
}

// Supabase store: one career_watch_kv row per file, key "tf:file:<id>", scoped by user_id (the table's unique (user_id, key)).
// deno-lint-ignore no-explicit-any
export function supabaseFileKindStore(admin: any): FileKindStore {
  const key = (id: string) => `tf:file:${id}`;
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const read = async (u: string, id: string): Promise<FileRecord | null> => {
    const rows = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", key(id)).limit(1), "read the file");
    const v = rows?.[0]?.value;
    return v && v.userId === u && v.id === id ? v as FileRecord : null;
  };
  const write = async (r: FileRecord) => { must(await admin.from("career_watch_kv").upsert({ user_id: r.userId, key: key(r.id), value: r, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save the file"); };
  return {
    put: write, get: read,
    async patch(u, id, state) { const r = await read(u, id); if (r) await write({ ...r, state: { ...r.state, ...state } }); },
    async revoke(u, id, at) { const r = await read(u, id); if (!r || r.revoked_at !== null) return false; await write({ ...r, revoked_at: at }); return true; },
    // Insert-if-absent on the table's unique (user_id, key): the database lets exactly one concurrent insert win. Any other error is surfaced, never treated as won.
    async claim(u, id, name, at) {
      const r = await admin.from("career_watch_kv").insert({ user_id: u, key: `tf:claim:${id}:${name}`, value: { at: new Date(at).toISOString() }, updated_at: new Date(at).toISOString() });
      if (!r.error) return true;
      if (r.error.code === "23505") return false;
      throw new Error(`claim: ${r.error.message}`);
    },
  };
}
