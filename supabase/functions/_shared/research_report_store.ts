// RESEARCH ANSWER LAYOUT (owner, 2026-10-28): where a research report lives, and the one link to it. The report is stored
// per person in the product's existing document store (channel_artifacts.ts, CHANNEL-DOC-1: owner-scoped rows, no new
// table or migration) with a long life, and served by trainee-report at a stable capability link: an HMAC over
// (report id, person) with TRAINEE_REPORT_SECRET, no expiry of its own; the row's expiry still ends it.
//
// A link is handed out only after the report was stored AND read back byte for byte. No secret, no base URL, a failed
// write or a read-back that differs: no link, and the caller says so (research_reply.ts). Never a link on a guess.
import { fetchArtifactBytes, materializeArtifacts } from "./channel_artifacts.ts";

export const REPORT_TTL_MS = 365 * 24 * 3600_000;
export const REPORT_THREAD = "research-report"; // the thread the rows are filed under when the turn has none

export interface ReportDoc { filename: string; mime: string; bytes: Uint8Array }
export interface ReportStore {
  put(userId: string, threadId: string, doc: ReportDoc): Promise<string | null>; // the report's id, or null when not stored
  get(userId: string, id: string): Promise<ReportDoc | null>; // owner-scoped; anything else reads as nothing
}

const toB64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The product's store: channel_artifacts rows through the service client.
// deno-lint-ignore no-explicit-any
export function artifactReportStore(admin: any, o: { now?: () => number } = {}): ReportStore {
  const now = o.now ?? Date.now;
  return {
    async put(userId, threadId, doc) {
      const { artifacts } = await materializeArtifacts(admin, { userId, threadId: threadId || REPORT_THREAD, now: now(), ttlMs: REPORT_TTL_MS,
        documents: [{ kind: "document", format: "html", filename: doc.filename, mime: doc.mime, base64: toB64(doc.bytes), sha256: await sha256Hex(doc.bytes) }] });
      return artifacts[0]?.ref ?? null;
    },
    async get(userId, id) {
      const got = await fetchArtifactBytes(admin, { userId, ref: id, now: now() });
      return got ? { filename: got.filename, mime: got.mime, bytes: got.bytes } : null;
    },
  };
}

// For tests and local runs. `failPut` / `corrupt` simulate a write that fails or a read-back that differs.
export function memoryReportStore(o: { failPut?: boolean; corrupt?: boolean } = {}): ReportStore & { rows(): Map<string, { userId: string; doc: ReportDoc }> } {
  const rows = new Map<string, { userId: string; doc: ReportDoc }>();
  let n = 0;
  return {
    async put(userId, _threadId, doc) {
      if (o.failPut) throw new Error("store unavailable");
      const id = `r${++n}`;
      rows.set(id, { userId, doc: o.corrupt ? { ...doc, bytes: new Uint8Array(0) } : doc });
      return id;
    },
    async get(userId, id) { const r = rows.get(id); return r && r.userId === userId ? r.doc : null; },
    rows: () => rows,
  };
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// The secret must be long enough to be one; a short one means "not configured".
const secretOk = (s: string | undefined | null) => typeof s === "string" && s.length >= 32;

export async function reportLink(o: { base: string; secret: string; id: string; userId: string }): Promise<string> {
  const sig = (await hmacHex(o.secret, `report.${o.id}.${o.userId}`)).slice(0, 32);
  return `${o.base.replace(/\/+$/, "")}/${encodeURIComponent(o.id)}?u=${encodeURIComponent(o.userId)}&s=${sig}`;
}
export async function verifyReportLink(secret: string | undefined, url: string | URL): Promise<{ id: string; userId: string } | null> {
  try {
    if (!secretOk(secret)) return null;
    const u = typeof url === "string" ? new URL(url) : url;
    const id = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const userId = u.searchParams.get("u") ?? "", sig = u.searchParams.get("s") ?? "";
    if (!id || !userId || !/^[0-9a-f]{32}$/.test(sig)) return null;
    const want = (await hmacHex(secret!, `report.${id}.${userId}`)).slice(0, 32);
    return sameText(sig, want) ? { id, userId } : null;
  } catch { return null; }
}

export type StoredReport = { ok: true; id: string; url: string; verified: true } | { ok: false; why: "not_configured" | "store_failed" | "readback_failed" };

// Store, read back, compare, then sign. Never throws.
export async function storeReport(o: { store: ReportStore; userId: string; threadId?: string | null; doc: ReportDoc; base?: string | null; secret?: string | null }): Promise<StoredReport> {
  if (!o.base || !/^https:\/\//.test(o.base) || !secretOk(o.secret)) return { ok: false, why: "not_configured" };
  let id: string | null = null;
  try { id = await o.store.put(o.userId, o.threadId || REPORT_THREAD, o.doc); } catch { id = null; }
  if (!id) return { ok: false, why: "store_failed" };
  let back: ReportDoc | null = null;
  try { back = await o.store.get(o.userId, id); } catch { back = null; }
  if (!back || back.bytes.length !== o.doc.bytes.length || await sha256Hex(back.bytes) !== await sha256Hex(o.doc.bytes)) return { ok: false, why: "readback_failed" };
  return { ok: true, id, url: await reportLink({ base: o.base, secret: o.secret!, id, userId: o.userId }), verified: true };
}

export const reportConfig = (env: { get(k: string): string | undefined }) => ({ base: env.get("TRAINEE_REPORT_BASE") ?? null, secret: env.get("TRAINEE_REPORT_SECRET") ?? null });
