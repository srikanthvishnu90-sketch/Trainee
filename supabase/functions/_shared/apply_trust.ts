// Whether a prepared application can still be approved, judged BEFORE the yes (apply round 3, 2026-10-30).
//
// The queue (career_apply_enqueue: career_apply_current) and the worker (approve-first.ts assertApprovedPayload) refuse an
// application after the person approved it when: its own expiry has passed; the account it was prepared under changed (paused,
// "forget everything" moved the privacy epoch, the authority fence moved past it); an answer comes from a fact the D-007
// contract never sends (the owner's quarantined bank F-027..F-079, an answer-all delegation, a fact derived from one, malformed
// derivation metadata, a texted answer with no question it answered, other quarantine rules); or an answer carries another
// account's fact. The jobs page and Telegram's Confirm offered one-tap approval of exactly those, so the person's yes approved
// something that could never go as approved (tests/architect/scenarios-apply-r3.test.ts). This is the same rule as plain code,
// so the page offers no Apply for them and Confirm approves nothing. It never loosens the database's or the worker's checks.
import { factDependencies, quarantinedFact } from "./fact_quarantine.ts";

// The quarantine rules the worker judges by (extension/src/apply_core.ts QUARANTINE_VERSION; the r3 battery checks they agree).
export const QUARANTINE_RULES = "d007-v1";
// A payload this close to its expiry is not offered: the queue reads the database's clock, which may be ahead of this one.
export const EXPIRY_MARGIN_MS = 2 * 60_000;

export interface AccountStamp { epoch: number; version: number; authority_version: number; paused: boolean }

// The account record's stamp (career_watch_kv "career:account"), as career_apply_current reads it; null when there is no record.
// deno-lint-ignore no-explicit-any
export function stampOf(acct: any): AccountStamp | null {
  if (!acct || typeof acct !== "object") return null;
  const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : NaN; };
  return { epoch: n(acct.epoch), version: n(acct.version), authority_version: n(acct.authority_version), paused: String(acct.paused ?? "false") !== "false" };
}

// Why answers in this payload can never be sent as approved: the worker's own contract (approve-first.ts payloadTrust and its
// FACT_OWNER_MISMATCH). Empty when none.
// deno-lint-ignore no-explicit-any
export function untrustedAnswers(payload: any): string[] {
  const why: string[] = [];
  if (payload?.quarantine_version !== undefined && payload.quarantine_version !== QUARANTINE_RULES) why.push("it was prepared under other rules for which facts may be used");
  for (const f of Array.isArray(payload?.fields) ? payload.fields : []) {
    const label = String(f?.label ?? f?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "an answer";
    const deps = factDependencies(f);
    if (f?.user_id !== undefined && f.user_id !== payload?.user_id) why.push(`"${label}" is not one of your own facts`);
    else if (quarantinedFact({ factId: f?.factId, provenance: f?.provenance })) why.push(`"${label}" comes from a fact you never confirmed`);
    else if (deps === null) why.push(`"${label}" doesn't say which of your facts it came from`);
    else if (deps.some((x) => quarantinedFact({ factId: x }))) why.push(`"${label}" comes from a fact you never confirmed`);
    else if (String(f?.factId ?? "").startsWith("text-answer:") && !f?.source?.key) why.push(`"${label}" is a texted answer with no question it answered`);
  }
  return why;
}

// One sentence (no trailing period) when the payload can no longer be approved, else null. `account` is undefined when no account
// source is wired in (then only the payload's own rules are judged); null when the record is missing.
// deno-lint-ignore no-explicit-any
export function unsendableWhy(payload: any, o: { now: number; account?: AccountStamp | null | "unreadable" }): string | null {
  const untrusted = untrustedAnswers(payload);
  if (untrusted.length) return `${untrusted[0]}, so it can't be sent as it is. Tell Trainee in Telegram to prepare it again`;
  // Every prepare stamps expires_at (approve-first.ts prepare, the extension's prepare); a payload without one is left to the queue,
  // which refuses it. One that names a time that is past, about to pass, or no time at all is not offered.
  const has = payload?.expires_at !== undefined && payload?.expires_at !== null;
  const exp = Date.parse(String(payload?.expires_at ?? ""));
  if (has && (Number.isNaN(exp) || exp <= o.now + EXPIRY_MARGIN_MS)) return "it was prepared too long ago and expired before it was approved. Tell Trainee in Telegram to prepare it again";
  if (o.account === undefined) return null;
  if (o.account === "unreadable") return "I couldn't check your account just now. Refresh in a minute";
  const a = o.account;
  if (!a) return "your Trainee account has no record to check it against, so it can't be approved";
  if (a.paused) return "Trainee is paused for you, so nothing can be approved. Say \"resume\" to Trainee in Telegram first";
  const epoch = Number(payload?.privacy_epoch), ver = Number(payload?.account_version);
  if (!Number.isFinite(epoch) || !Number.isFinite(ver) || epoch !== a.epoch || ver < a.authority_version || ver > a.version || [a.epoch, a.version, a.authority_version].some(Number.isNaN)) {
    return "your details changed after it was prepared. Tell Trainee in Telegram to prepare it again";
  }
  return null;
}
