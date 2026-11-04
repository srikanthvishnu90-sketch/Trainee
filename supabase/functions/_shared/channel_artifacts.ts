// CHANNEL-DOC-1 — the document seam between agent-chat and the
// messaging channels (LANE B, 2026-10-20; closes the gap recorded in
// channel_present.ts since the presentation lane).
//
// THE CONTRACT (landed): when a turn produces a document a user should
// receive as a file (today: the tailored resume PDF rendered by module
// 148 inside module 123's render — its artifact rides the router
// result), agent-chat materializes the bytes into the owner-scoped
// store below and the reply carries
//   artifacts?: [{ kind: "document", ref, filename, mime }]
// `ref` is an opaque row id in channel_artifacts — a BYTES-REF, never
// a URL and never the bytes themselves. The channel bridges resolve a
// ref through this module, always scoped to the user the turn ran as
// (and, where the channel knows it, the turn's thread): an artifact
// is only ever delivered to its owner's channel thread. A document
// that was never stored is never claimed sent — materialization
// failure drops the entry and the handler says so on the reply.
//
// WHATSAPP MEDIA: Twilio fetches MediaUrl server-side, so a bytes-ref
// cannot ride the send. The WhatsApp bridge mints a SIGNED, EXPIRING
// URL on its own function (whatsapp-inbound's GET route) — HMAC over
// (ref, user, expiry) with a function secret, 10-minute life, verified
// fail-closed before a single byte is served. It is a capability URL
// for exactly one document and one owner, not a public link, and it
// dies on its expiry even while the stored artifact lives on.
//
// Storage is the product's own: a Postgres table written/read through
// the service-role admin client, like channel_threads and
// channel_pending_approvals. Migration:
// supabase/migrations/20261020000000_channel_artifacts.sql
// (operator-applied with the rollout, like the other channel tables).

// (Self-contained on purpose: agent-chat's handler imports this
// module, and that graph must stay linkable in realms that resolve
// every specifier as a file — no imports here at all.)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const ARTIFACTS_TABLE = "channel_artifacts";
export const ARTIFACT_TTL_MS = 7 * 24 * 3600_000; // stored-artifact lifetime
export const ARTIFACT_URL_TTL_SEC = 600; // signed media URL lifetime (10 min)

// ------------------------------------------------------------------
// Turn documents: the byte-carrying documents a router result offers
// for delivery. Two producers shape them today — the delivery
// handler's own result.documents[], and the tailor artifact's PDF
// (module 148's artifact(): { format, filename, contentType, base64,
// sha256 }). Entries without bytes are dropped: a filename alone is
// not a document, and claiming one would be the CHANNEL-DOC-1 failure
// all over again.

export interface TurnDocument {
  kind: "document";
  format: string | null;
  filename: string;
  mime: string;
  base64: string;
  sha256: string | null;
}

function asDocument(d: any): TurnDocument | null {
  if (!d || typeof d !== "object") return null;
  if (typeof d.base64 !== "string" || !d.base64) return null;
  return {
    kind: "document",
    format: typeof d.format === "string" ? d.format : null,
    filename: typeof d.filename === "string" && d.filename ? d.filename : "document.pdf",
    mime: typeof d.mime === "string" ? d.mime : (typeof d.contentType === "string" ? d.contentType : "application/pdf"),
    base64: d.base64,
    sha256: typeof d.sha256 === "string" ? d.sha256 : null,
  };
}

export function documentsOf(result: any): TurnDocument[] {
  const out: TurnDocument[] = [];
  if (!result || typeof result !== "object") return out;
  // A result that names the same document twice (a documents[] entry
  // AND the producing artifact) delivers it ONCE — identity is the
  // bytes' own hash (falling back to the bytes themselves).
  const seen = new Set<string>();
  const push = (d: any) => {
    const doc = asDocument(d);
    if (!doc) return;
    const key = doc.sha256 ?? doc.base64;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(doc);
  };
  if (Array.isArray(result.documents)) for (const d of result.documents) push(d);
  const art = result.artifact && typeof result.artifact === "object" ? result.artifact : null;
  if (art?.pdf) push(art.pdf);
  // FAMILY MATERIALS (AM-03): the Word copy of the same resume, when the turn rendered one (career_tailor_rewrite.ts
  // employerFiles), rides beside the PDF, so "Saved as PDF and DOCX files, attached" is what the person gets.
  if (art?.docx) push(art.docx);
  return out;
}

// ------------------------------------------------------------------
// The store. Rows are written by agent-chat (the turn's owner) and
// read by the channel bridges under the same owner scope. Every read
// checks the expiry: a dead row reads as nothing.

export interface ArtifactRef { kind: "document"; ref: string; filename: string; mime: string }

export async function materializeArtifacts(
  admin: any,
  args: { userId: string; threadId: string; documents: TurnDocument[]; now?: number; ttlMs?: number },
): Promise<{ artifacts: ArtifactRef[]; failed: number }> {
  const now = args.now ?? Date.now();
  const expires = new Date(now + (args.ttlMs ?? ARTIFACT_TTL_MS)).toISOString();
  const artifacts: ArtifactRef[] = [];
  let failed = 0;
  // FAMILY MATERIALS (AM-03): a turn can now carry two documents (the resume as PDF, then as DOCX). The first is the
  // primary one, and it stays the thread's NEWEST row, as it was when a turn carried one document: rows are written
  // last-first, each earlier document one millisecond newer than the next, and the refs come back in the turn's order.
  const made: (ArtifactRef | null)[] = args.documents.map(() => null);
  for (let i = args.documents.length - 1; i >= 0; i--) {
    const doc = args.documents[i];
    try {
      const id = crypto.randomUUID();
      const { error } = await admin.from(ARTIFACTS_TABLE).insert({
        id,
        user_id: args.userId,
        thread_id: args.threadId,
        kind: "document",
        filename: doc.filename,
        mime: doc.mime,
        bytes_b64: doc.base64,
        sha256: doc.sha256,
        created_at: new Date(now - i).toISOString(),
        expires_at: expires,
      });
      if (error) { failed += 1; continue; }
      made[i] = { kind: "document", ref: id, filename: doc.filename, mime: doc.mime };
    } catch {
      failed += 1;
    }
  }
  for (const a of made) if (a) artifacts.push(a);
  return { artifacts, failed };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function fetchArtifactBytes(
  admin: any,
  args: { userId: string; threadId?: string | null; ref: string; now?: number },
): Promise<{ bytes: Uint8Array; filename: string; mime: string } | null> {
  try {
    let q = admin.from(ARTIFACTS_TABLE).select("*").eq("id", args.ref).eq("user_id", args.userId);
    if (args.threadId) q = q.eq("thread_id", args.threadId);
    const { data: row, error } = await q.maybeSingle();
    if (error || !row) return null;
    if (typeof row.bytes_b64 !== "string" || !row.bytes_b64) return null;
    if (new Date(row.expires_at).getTime() <= (args.now ?? Date.now())) return null;
    return {
      bytes: b64ToBytes(row.bytes_b64),
      filename: typeof row.filename === "string" ? row.filename : "document.pdf",
      mime: typeof row.mime === "string" ? row.mime : "application/pdf",
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Signed, expiring media URLs (WhatsApp). The secret is the function's
// own: CHANNEL_ARTIFACT_SECRET when configured, else the Twilio auth
// token the WhatsApp function already holds. No secret, no URL — the
// bridge degrades to the product-voice failure line instead of an
// unsigned link.

type EnvGetter = (k: string) => string | undefined;

export function artifactUrlSecret(env: EnvGetter): string {
  return env("CHANNEL_ARTIFACT_SECRET") ?? env("TWILIO_AUTH_TOKEN") ?? "";
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signedArtifactUrl(
  env: EnvGetter,
  args: { base: string; ref: string; userId: string; now?: number; ttlSec?: number },
): Promise<string | null> {
  const secret = artifactUrlSecret(env);
  if (!secret) return null;
  const exp = Math.floor((args.now ?? Date.now()) / 1000) + (args.ttlSec ?? ARTIFACT_URL_TTL_SEC);
  const sig = await hmacHex(secret, `${args.ref}.${args.userId}.${exp}`);
  const qs = new URLSearchParams({ artifact: args.ref, u: args.userId, exp: String(exp), sig });
  return `${args.base}?${qs.toString()}`;
}

export async function verifyArtifactUrl(
  env: EnvGetter,
  url: string | URL,
  now?: number,
): Promise<{ ref: string; userId: string } | null> {
  try {
    const secret = artifactUrlSecret(env);
    if (!secret) return null;
    const u = typeof url === "string" ? new URL(url) : url;
    const ref = u.searchParams.get("artifact") ?? "";
    const userId = u.searchParams.get("u") ?? "";
    const expRaw = u.searchParams.get("exp") ?? "";
    const sig = u.searchParams.get("sig") ?? "";
    if (!ref || !userId || !sig || !/^\d+$/.test(expRaw)) return null;
    if (Number(expRaw) * 1000 <= (now ?? Date.now())) return null;
    const expected = await hmacHex(secret, `${ref}.${userId}.${expRaw}`);
    if (!timingSafeEqual(sig, expected)) return null;
    return { ref, userId };
  } catch {
    return null;
  }
}
