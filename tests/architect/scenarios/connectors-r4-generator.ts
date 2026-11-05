// Connectors, disconnect and erase, round 4 (owner rules, 2026-11-05): a deterministic, seeded generator with fresh seeds and
// categories rounds 1 to 3 did not have (scenarios-connectors, scenarios-erase-r2, scenarios-connectors-r3). Every address
// is synthetic (.example / .test); every token is fake and built here at run time.
//
//   deliveries  a delivery run holding a person's queued texts (some made from their mail: a status read from an email, a
//               deadline reminder, a confirmation, a "which application?" ask, an interview brief, a draft's offer; some
//               not: a job alert, a receipt, a reminder set in chat, the daily brief, an outreach follow-up, an answer) when
//               the person says "disconnect gmail", connects another Google account, connects the same one again, says
//               "disconnect outlook" or deletes their account: before the run claims, or while it holds row k; one run
//               or four lanes at once; another person in the same run who does nothing.
//   mailruns    the scheduled Gmail run (or Outlook's inbox sync) reading a person's mail when the person disconnects or
//               connects another account at the k-th call the run makes to the database; another person beside.
//   refreshes   a token refresh (Gmail career, Outlook) in flight at the provider's token endpoint when the person
//               disconnects, disconnects and connects the same account again, connects another account, gives the send
//               consent again (the same account, a new grant), or deletes their account; Google rotating the refresh token
//               or not; a grant stored before grants were stamped.
//   erasures    an account deletion that fails part way (Stripe, the grants read, the Vault read, the disconnect, the
//               secrets, the files, the ledger, the auth delete, the read-back) and is asked again, up to four times, with
//               Google's answer to each revoke; another person whose outreach names this person as a contact.
// Expectations are derived from the fields (tests/architect/scenarios-connectors-r4.test.ts).
import { chance, int, pick, rng } from "./erase-r2-generator.ts";
export { rng };

export const uidOf = (id: number) => `4d1c0b2a-9e8f-4a7b-8c6d-${String(id).padStart(12, "0")}`;
export const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
export const fakeTok = (kind: "access" | "refresh", tag: string | number) => (kind === "access" ? ["ya29", "FAKEat4"].join(".") : ["1", "", "FAKErt4"].join("/")) + `-${tag}`;
export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

// ------------------------------------------------------------------------------------------------ the outbox keys
// made from mail (MAIL), the offers of drafts made from mail (OFFER), and look-alikes that are not (OTHER).
export type KeyKind = "status" | "deadline" | "confirmed" | "which" | "brief" | "brief_moved" | "offer_followup" | "offer_thanks"
  | "alert" | "receipt" | "daily_brief" | "chat_reminder" | "connect_status" | "outlook_status" | "outreach_followup" | "reply" | "digest";
export const MAIL_KINDS: readonly KeyKind[] = ["status", "deadline", "confirmed", "which", "brief", "brief_moved"];
export const OFFER_KINDS: readonly KeyKind[] = ["offer_followup", "offer_thanks"];
export const OTHER_KINDS: readonly KeyKind[] = ["alert", "receipt", "daily_brief", "chat_reminder", "connect_status", "outlook_status", "outreach_followup", "reply", "digest"];
export const fromMailbox = (k: KeyKind) => MAIL_KINDS.includes(k) || OFFER_KINDS.includes(k);
export function keyOf(k: KeyKind, tag: string): { key: string; kind: string } {
  const h = hexOf(tag);
  switch (k) {
    case "status": return { key: `status:${h}`, kind: "status" };
    case "deadline": return { key: `status:deadline:${h}`, kind: "status" };
    case "confirmed": return { key: `status:confirmed:${uuidOf(tag)}`, kind: "status" };
    case "which": return { key: `status:which:${h}`, kind: "status" };
    case "brief": return { key: `brief:${h}:1`, kind: "brief" };
    case "brief_moved": return { key: `brief:${h}:moved`, kind: "brief" };
    case "offer_followup": return { key: `followup:followup:track:${tag}`, kind: "followup" };
    case "offer_thanks": return { key: `followup:thank_you:track:${tag}:2026-11-01`, kind: "followup" };
    case "alert": return { key: `alert:job-${tag}`, kind: "alert" };
    case "receipt": return { key: `receipt:${uuidOf(tag)}`, kind: "receipt" };
    case "daily_brief": return { key: `brief:2026-11-05`, kind: "brief" };
    case "chat_reminder": return { key: `status:reminder:${tag}:America/Chicago`, kind: "status" };
    case "connect_status": return { key: `status:connect:${uuidOf(tag)}`, kind: "status" };
    case "outlook_status": return { key: `status:outlook:${uuidOf(tag)}`, kind: "status" };
    case "outreach_followup": return { key: `followup:outreach:${uuidOf(tag)}`, kind: "followup" };
    case "reply": return { key: `reply:${tag}`, kind: "reply" };
    case "digest": return { key: `digest:2026-W45`, kind: "digest" };
  }
}
const uuidOf = (tag: string) => { const h = hexOf(`u-${tag}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// ------------------------------------------------------------------------------------------------ deliveries
export type DeliveryEvent = "none" | "disconnect" | "switch" | "same_reconnect" | "outlook_disconnect" | "delete";
export interface Delivery {
  id: number; uid: string; other: string;
  rows: KeyKind[]; otherRows: KeyKind[];
  event: DeliveryEvent;
  at: number; // -1: before the run claims; k: while the run holds the person's k-th row (0-based, the order it handles them)
  lanes: 1 | 4;
  family: string;
}
export function deliveries(seed: number, n: number): Delivery[] {
  const r = rng(seed), out: Delivery[] = [];
  const all = [...MAIL_KINDS, ...OFFER_KINDS, ...OTHER_KINDS];
  for (let i = 0; i < n; i++) {
    const id = 40_000 + i;
    const rows = Array.from({ length: int(r, 2, 7) }, () => pick(r, chance(r, 0.55) ? [...MAIL_KINDS, ...OFFER_KINDS] : OTHER_KINDS));
    // one of each key kind at most once per person (a key is once per person ever)
    const uniq = [...new Set(rows)];
    const event = pick(r, ["none", "disconnect", "disconnect", "switch", "same_reconnect", "outlook_disconnect", "delete", "delete"] as const);
    const at = chance(r, 0.25) ? -1 : int(r, 0, uniq.length - 1);
    out.push({ id, uid: uidOf(id), other: uidOf(140_000 + i), rows: uniq, otherRows: [...new Set(Array.from({ length: int(r, 1, 4) }, () => pick(r, all)))],
      event, at, lanes: chance(r, 0.3) ? 4 : 1, family: `delivery/${event}/${at < 0 ? "before_claim" : "while_held"}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ mail runs
export type MailEvent = "none" | "disconnect" | "switch";
export interface MailRun { id: number; uid: string; other: string; provider: "gmail" | "outlook"; mails: number; event: MailEvent; at: number; family: string }
export function mailruns(seed: number, n: number): MailRun[] {
  const r = rng(seed), out: MailRun[] = [];
  for (let i = 0; i < n; i++) {
    const id = 50_000 + i;
    const event = pick(r, ["none", "disconnect", "disconnect", "switch"] as const);
    const provider = chance(r, 0.7) ? "gmail" : "outlook";
    out.push({ id, uid: uidOf(id), other: uidOf(150_000 + i), provider, mails: int(r, 1, 4), event, at: provider === "gmail" ? int(r, 1, 16) : int(r, 1, 7), family: `mailrun/${provider}/${event}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ refreshes
export type RefreshEvent = "none" | "disconnect" | "reconnect_same" | "switch" | "consent_same" | "delete";
export interface Refresh { id: number; uid: string; provider: "google_career" | "microsoft"; event: RefreshEvent; rotate: boolean; legacy: boolean; family: string }
export function refreshes(seed: number, n: number): Refresh[] {
  const r = rng(seed), out: Refresh[] = [];
  for (let i = 0; i < n; i++) {
    const id = 60_000 + i;
    const provider = chance(r, 0.5) ? "google_career" : "microsoft";
    const event = pick(r, ["none", "disconnect", "reconnect_same", "reconnect_same", "switch", "consent_same", "delete"] as const);
    out.push({ id, uid: uidOf(id), provider, event, rotate: provider === "microsoft" || chance(r, 0.2), legacy: chance(r, 0.2), family: `refresh/${provider}/${event}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ erasures
export type EraseStep = "billing" | "grants" | "vault" | "disconnect" | "secrets" | "files" | "ledger" | "user" | "readback" | "record";
export const ERASE_STEPS: readonly EraseStep[] = ["billing", "grants", "vault", "disconnect", "secrets", "files", "ledger", "user", "readback", "record"];
export type RevokeAnswer = 200 | 400 | 503 | "network";
export interface Erasure {
  id: number; uid: string; other: string;
  grants: ("google_career" | "gmail" | "microsoft")[];
  revoke: RevokeAnswer;
  files: number;
  plan: boolean; // a live Trainee plan (cancelled at Stripe first)
  fails: (EraseStep | null)[]; // the step that fails on attempt 1, 2, ... (null: nothing fails); the last attempt never fails
  family: string;
}
export function erasures(seed: number, n: number): Erasure[] {
  const r = rng(seed), out: Erasure[] = [];
  for (let i = 0; i < n; i++) {
    const id = 70_000 + i;
    const grants = (["google_career", "gmail", "microsoft"] as const).filter(() => chance(r, 0.5));
    const tries = int(r, 1, 4);
    const fails: (EraseStep | null)[] = Array.from({ length: tries - 1 }, () => pick(r, ERASE_STEPS));
    fails.push(null);
    out.push({ id, uid: uidOf(id), other: uidOf(170_000 + i), grants: [...grants], revoke: pick(r, [200, 200, 400, 503, "network"] as const), files: int(r, 0, 3), plan: chance(r, 0.3), fails,
      family: `erase/${fails.length === 1 ? "first_try" : `retry_after_${fails[0]}`}` });
  }
  return out;
}
