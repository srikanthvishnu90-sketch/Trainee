// Erase scenarios, round 2 (owner rules, 2026-10-30): a deterministic, seeded generator of account deletions, token
// refreshes racing a disconnect, the replies about them, and deliveries racing a deletion. Fresh seeds and new categories
// next to round 1 (tests/architect/scenarios/connectors-generator.ts). Every address is synthetic (.example / .test);
// every token is fake.
//
//   deletions   who has what (Gmail career grant, the legacy finance grant, Outlook, none), what each stored grant holds
//               (refresh and access token, one of them, none, unreadable), what Google answers each revoke try (200, 400
//               invalid_token, 401/403/404, 429, 5xx, a timeout, a network failure), the other secrets and resume files the
//               person has, the step of the deletion that fails (reading the grants, a Vault read, the connection delete,
//               the secret purge, Storage, the ledger, the auth delete, the read-back, the record), and whether the request
//               comes twice.
//   refreshes   a Gmail or Outlook token refresh: expired or not, the provider's answer to the refresh, the connection
//               row deleted while the refresh was at the provider (a disconnect or an account deletion), the refresh write
//               RPC missing (the migration not applied yet), the write failing.
//   results     deletion outcomes, for the words alone: deleted or not, every mix of Google outcomes, Outlook, failures.
//   deliveries  outbox rows (job alerts, reports, answers in parts) claimed by a delivery run, and the person's account
//               deleted after the claim, before the send; another person's rows in the same run.
// Expectations are derived from the fields (tests/architect/scenarios-erase-r2.test.ts).

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = ReturnType<typeof rng>;
export const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: R, p: number) => r() < p;
export const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export type Answer = 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | "timeout" | "network";
export const ANSWERS: readonly Answer[] = [200, 400, 401, 403, 404, 429, 500, 502, 503, "timeout", "network"];
export const uidOf = (id: number) => `5e2a0c1d-7b3f-4c8e-9a10-${String(id).padStart(12, "0")}`;

// ------------------------------------------------------------------------------------------------ deletions
export type Shape = "both" | "refresh" | "access" | "none" | "garbage" | "missing" | "unreadable";
export type DeleteStep = "none" | "grants" | "vault_read" | "disconnect" | "secrets" | "files" | "rows" | "ledger" | "user_delete" | "user_delete_404" | "readback_user" | "secrets_left" | "record";
export interface Deletion {
  id: number; uid: string;
  grants: { google_career: boolean; gmail: boolean; microsoft: boolean };
  shape: { google_career: Shape; gmail: Shape }; // what each Google grant's Vault entry holds
  answers: Record<string, Answer[]>; // token -> Google's answer per try
  execRefs: number; // vaulted merchant credentials (Upmore)
  files: number; // tailored resumes in career-resumes/<uid>/
  fail: DeleteStep;
  twice: boolean; // the request comes again after the first
  family: string;
}
export const tokensOf = (p: string, id: number) => ({ refresh: `1//FAKErefresh-${p}-${id}`, access: `ya29.FAKEaccess-${p}-${id}` });
export function secretOf(shape: Shape, p: string, id: number): string | null {
  const t = tokensOf(p, id);
  if (shape === "garbage") return "not json {";
  if (shape === "missing" || shape === "unreadable") return null;
  const o: Record<string, unknown> = { expires_at: 4102444800000, email: `${p}-${id}@example.test` };
  if (shape === "both" || shape === "refresh") o.refresh_token = t.refresh;
  if (shape === "both" || shape === "access") o.access_token = t.access;
  return JSON.stringify(o);
}
export function deletions(seed: number, n: number): Deletion[] {
  const r = rng(seed);
  const out: Deletion[] = [];
  while (out.length < n) {
    const id = out.length;
    const holding = pick(r, ["none", "gmail", "gmail", "gmail+outlook", "outlook", "gmail+legacy", "legacy", "all"] as const);
    const grants = { google_career: /gmail|all/.test(holding), gmail: /legacy|all/.test(holding), microsoft: /outlook|all/.test(holding) };
    const shapeOf = (): Shape => pick(r, ["both", "both", "both", "refresh", "access", "none", "garbage", "missing", "unreadable"] as const);
    const shape = { google_career: shapeOf(), gmail: shapeOf() };
    const style = pick(r, ["ok", "ok", "refused", "flaky", "down", "random"] as const);
    const answers: Record<string, Answer[]> = {};
    for (const p of ["google_career", "gmail"] as const) {
      const t = tokensOf(p, id);
      for (const tok of [t.refresh, t.access]) {
        answers[tok] = Array.from({ length: 3 }, (_, k) => style === "ok" ? 200 : style === "refused" ? 400
          : style === "down" ? pick(r, [500, 502, 503, "timeout", "network"] as const)
          : style === "flaky" ? (k < int(r, 0, 3) ? pick(r, [503, "timeout", "network", 429] as const) : 200) : pick(r, ANSWERS));
      }
    }
    const fail: DeleteStep = chance(r, 0.55) ? "none" : pick(r, ["grants", "vault_read", "disconnect", "secrets", "files", "rows", "ledger", "user_delete", "user_delete_404", "readback_user", "secrets_left", "record"] as const);
    out.push({ id, uid: uidOf(id), grants, shape, answers, execRefs: chance(r, 0.2) ? int(r, 1, 3) : 0, files: chance(r, 0.5) ? int(r, 1, 4) : 0,
      fail, twice: chance(r, 0.25), family: `${holding}/${style}/${fail}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ refreshes
export interface Refresh {
  id: number; uid: string;
  provider: "gmail" | "outlook";
  expired: boolean;
  answer: 200 | 400 | 401 | 429 | 500; // the provider's answer to the refresh
  gone: "no" | "disconnect" | "account_delete"; // the connection row deleted while the refresh was at the provider
  rpc: "present" | "missing" | "failing"; // oauth_vault_refresh
  family: string;
}
export function refreshes(seed: number, n: number): Refresh[] {
  const r = rng(seed);
  const out: Refresh[] = [];
  while (out.length < n) {
    const id = out.length;
    const provider = pick(r, ["gmail", "outlook"] as const);
    const expired = chance(r, 0.8);
    const answer = pick(r, [200, 200, 200, 400, 401, 429, 500] as const);
    const gone = pick(r, ["no", "disconnect", "disconnect", "account_delete"] as const);
    const rpc = chance(r, 0.8) ? "present" : pick(r, ["missing", "failing"] as const);
    out.push({ id, uid: uidOf(100000 + id), provider, expired, answer, gone, rpc, family: `${provider}/${expired ? "expired" : "fresh"}/${answer}/${gone}/${rpc}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ results
export type Outcome = "revoked" | "refused" | "not_confirmed" | "no_token";
export interface Result {
  id: number; deleted: boolean; google: Record<string, Outcome>; outlook: boolean; failures: string[]; had: string[]; disconnected: boolean; grantsRead: boolean; recorded: boolean; family: string;
}
const FAILS = ["check which Google and Microsoft accounts were connected", "read the stored Google access to revoke it", "delete your saved resume files",
  "delete the stored access tokens", "delete your account", "check that everything was deleted"];
export function results(seed: number, n: number): Result[] {
  const r = rng(seed);
  const out: Result[] = [];
  while (out.length < n) {
    const id = out.length;
    const google: Record<string, Outcome> = {};
    const had: string[] = [];
    for (const p of ["google_career", "gmail"]) if (chance(r, 0.5)) { google[p] = pick(r, ["revoked", "revoked", "refused", "not_confirmed", "no_token"] as const); had.push(p); }
    const outlook = chance(r, 0.35);
    if (outlook) had.push("microsoft");
    const grantsRead = chance(r, 0.9);
    const deleted = chance(r, 0.75);
    const failures = FAILS.filter(() => chance(r, 0.15));
    if (!deleted && !failures.includes("delete your account")) failures.push("delete your account");
    if (deleted) failures.splice(0, failures.length, ...failures.filter((f) => f !== "delete your account"));
    if (!grantsRead) { for (const k of Object.keys(google)) delete google[k]; had.length = 0; failures.push(FAILS[0]); }
    out.push({ id, deleted, google: grantsRead ? google : {}, outlook: grantsRead && outlook, failures: [...new Set(failures)], had: grantsRead ? had : [], disconnected: chance(r, 0.8), grantsRead, recorded: chance(r, 0.9),
      family: `${deleted ? "deleted" : "kept"}/${Object.values(google).join("+") || "no-google"}/${outlook ? "outlook" : "-"}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ deliveries
export interface DeliveryRow { id: string; user: "deleted" | "other"; key: string; parts: number }
export interface Delivery { id: number; rows: DeliveryRow[]; goneRead: "ok" | "fails"; family: string }
export function deliveries(seed: number, n: number): Delivery[] {
  const r = rng(seed);
  const out: Delivery[] = [];
  while (out.length < n) {
    const id = out.length;
    const rows: DeliveryRow[] = [];
    const k = int(r, 1, 6);
    for (let i = 0; i < k; i++) {
      const kind = pick(r, ["alert", "report", "reply", "reply"] as const);
      rows.push({ id: `${id}-${i}`, user: chance(r, 0.6) ? "deleted" : "other", key: `${kind}:${id}-${i}`, parts: kind === "reply" ? int(r, 1, 3) : 1 });
    }
    const goneRead = chance(r, 0.9) ? "ok" : "fails";
    out.push({ id, rows, goneRead, family: `${rows.map((x) => `${x.user[0]}${x.key.split(":")[0][0]}`).join("")}/${goneRead}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ people (Postgres flow)
// One person each, with what they have and what is running when they ask (tests/architect/flow-scenarios-erase-r2.test.ts).
export type Action = "delete_account" | "forget_everything" | "disconnect_gmail" | "disconnect_outlook" | "switch_gmail" | "switch_outlook" | "none";
export type Mid = "none" | "send_before_token" | "send_after_token" | "send_accepted" | "refresh" | "delivery_alert" | "delivery_reply" | "twice_at_once";
export interface Person {
  id: number; uid: string; email: string; phone: string; telegram: string;
  action: Action; mid: Mid;
  gmail: boolean; legacy: boolean; outlook: boolean;
  revoke: Answer; // what Google answers each revoke try for this person
  queued: { gmail: number; outlook: number }; approved: number; turns: number;
  mail: { events: number; cursor: boolean; outlook: number };
  outbox: { alerts: number; replies: number };
  linked: { telegram: boolean; session: boolean; login: boolean; linkRequest: boolean };
  chat: number; files: number; dnc: boolean; execRef: boolean; parked: boolean;
  resignup: boolean;
  family: string;
}
export function people(seed: number, n: number): Person[] {
  const r = rng(seed);
  const out: Person[] = [];
  while (out.length < n) {
    const id = out.length;
    const action = pick(r, ["delete_account", "delete_account", "delete_account", "delete_account", "forget_everything", "disconnect_gmail", "disconnect_outlook", "switch_gmail", "switch_outlook", "none"] as const);
    let gmail = chance(r, 0.75), outlook = chance(r, 0.45);
    const legacy = chance(r, 0.2);
    if (/gmail/.test(action)) gmail = true;
    if (/outlook/.test(action)) outlook = true;
    let mid: Mid = "none";
    const m = r();
    if (action === "delete_account") mid = m < 0.15 ? "send_before_token" : m < 0.25 ? "send_after_token" : m < 0.33 ? "send_accepted" : m < 0.45 ? "refresh" : m < 0.55 ? "delivery_alert" : m < 0.65 ? "delivery_reply" : m < 0.72 ? "twice_at_once" : "none";
    else if (action === "disconnect_gmail" || action === "switch_gmail" || action === "forget_everything") mid = m < 0.2 ? "send_before_token" : m < 0.3 ? "send_after_token" : m < 0.5 && action !== "forget_everything" ? "refresh" : "none";
    if (mid.startsWith("send") || mid === "refresh") gmail = true;
    const revoke = pick(r, [200, 200, 200, 400, 503, "timeout", "network", 401] as const);
    out.push({
      id, uid: uidOf(500000 + id), email: `person-${id}@example.test`, phone: `+1555${String(7000000 + id).padStart(7, "0")}`, telegram: String(880000000 + id),
      action, mid, gmail, legacy, outlook, revoke,
      queued: { gmail: gmail ? int(r, 0, 3) : 0, outlook: outlook ? int(r, 0, 2) : 0 }, approved: int(r, 0, 2), turns: int(r, 0, 2),
      mail: { events: gmail ? int(r, 0, 3) : 0, cursor: gmail && chance(r, 0.5), outlook: outlook ? int(r, 0, 3) : 0 },
      outbox: { alerts: int(r, 0, 2), replies: int(r, 0, 2) },
      linked: { telegram: chance(r, 0.7) || mid.startsWith("delivery"), session: chance(r, 0.5), login: chance(r, 0.3), linkRequest: chance(r, 0.2) },
      chat: int(r, 0, 3), files: int(r, 0, 3), dnc: chance(r, 0.4), execRef: chance(r, 0.15), parked: chance(r, 0.3),
      resignup: action === "delete_account" && chance(r, 0.3),
      family: `${action}/${mid}`,
    });
  }
  return out;
}
