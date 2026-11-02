// Connectors, disconnect and erase, round 3 (owner rules, 2026-10-31): a deterministic, seeded generator with fresh seeds and
// categories rounds 1 and 2 did not have (scenarios-connectors, scenarios-erase-r2). Every address is synthetic (.example /
// .test); every token is fake and built here at run time.
//
//   callbacks   a Google connect callback: the account deleted while the person was at Google, the state replayed (the
//               browser's back button, a leaked URL paired with another consent's code), the address already connected to
//               another Trainee account (Gmail career or the legacy finance grant, any case or spacing), the same address on
//               this account's other grant, Google's token and userinfo answers, the scopes granted (a box left unticked),
//               Google's answer to the revoke of a grant that must not be kept.
//   partials    a grant missing a permission (Gmail: read, send when it was asked; Outlook: Mail.Read, Mail.Send,
//               Calendars.ReadWrite), and what the person asks: "check my email" / "check my outlook", or nothing (the
//               connect confirmation alone).
//   inbox       an inbox run (Gmail's scheduled mail run, Outlook's sync) for a person who says "disconnect gmail|outlook" or
//               "forget everything" at a moment of the run: before it reads, while it reads, after the run's last check
//               and before its write, or not at all; another person in the same run who never asks anything.
//   deletions   account deletion results for the words: whether the record was written, whether a plan was cancelled at
//               Stripe, Google's answers, Outlook, failures.
// Expectations are derived from the fields (tests/architect/scenarios-connectors-r3.test.ts).
import { chance, int, pick, rng } from "./erase-r2-generator.ts";
export { rng };

export const uidOf = (id: number) => `6f3b1d2e-8c40-4d9f-8b21-${String(id).padStart(12, "0")}`;
// Fake tokens, assembled at run time so nothing key-shaped sits in the source.
export const fakeTok = (kind: "access" | "refresh", tag: string | number) => (kind === "access" ? ["ya29", "FAKEat"].join(".") : ["1", "", "FAKErt"].join("/")) + `-${tag}`;

export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

// ------------------------------------------------------------------------------------------------ callbacks
export type TokenAnswer = "ok" | 400 | 500 | "no_access";
export type Holder = "none" | "other_career" | "other_legacy" | "self_legacy" | "other_microsoft";
export type RevokeAnswer = 200 | 400 | 503 | "network";
export interface Callback {
  id: number; uid: string; other: string;
  gone: boolean; // the account was deleted before Google's callback
  uses: number; // how many times the same state reaches the callback (1: once)
  holder: Holder; // who else holds the address
  addrVariant: "same" | "upper" | "spaced";
  token: TokenAnswer;
  email: string | null; // what Google's userinfo says (null: no address)
  scopes: string[]; // what Google says was granted (empty: no scope echoed)
  refresh: boolean; // Google returned a refresh token
  revoke: RevokeAnswer;
  family: string;
}
export function callbacks(seed: number, n: number): Callback[] {
  const r = rng(seed), out: Callback[] = [];
  for (let i = 0; i < n; i++) {
    const id = 10_000 + i;
    const gone = chance(r, 0.22), uses = chance(r, 0.25) ? int(r, 2, 3) : 1;
    const holder = pick(r, ["none", "none", "other_career", "other_legacy", "self_legacy", "other_microsoft"] as const);
    const token = pick(r, ["ok", "ok", "ok", "ok", 400, 500, "no_access"] as const);
    const email = chance(r, 0.08) ? null : `person-${id}@example.test`;
    const scopes = chance(r, 0.1) ? [] : ["openid", "email", ...(chance(r, 0.85) ? [GMAIL_READ] : []), ...(chance(r, 0.3) ? [GMAIL_SEND] : [])];
    const family = token !== "ok" ? `exchange_${token}` : uses > 1 ? "replayed" : gone ? "gone" : holder.startsWith("other") && holder !== "other_microsoft" && email ? "taken" : "connect";
    out.push({ id, uid: uidOf(id), other: uidOf(90_000 + i), gone, uses, holder, addrVariant: pick(r, ["same", "upper", "spaced"] as const), token, email, scopes,
      refresh: chance(r, 0.85), revoke: pick(r, [200, 200, 400, 503, "network"] as const), family });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ partial grants
export const OUTLOOK_SCOPES = ["Mail.Read", "Mail.Send", "Calendars.ReadWrite"] as const;
export interface Partial {
  id: number; uid: string; provider: "gmail" | "outlook";
  granted: string[]; // the permissions granted (Gmail: full URLs; Outlook: names)
  sendAsked: boolean; // Gmail: gmail.send was on the consent page (GOOGLE_APPROVED_EXTRA_SCOPES)
  ask: "check" | "confirm";
  family: string;
}
export function partials(seed: number, n: number): Partial[] {
  const r = rng(seed), out: Partial[] = [];
  for (let i = 0; i < n; i++) {
    const id = 20_000 + i;
    const provider = chance(r, 0.5) ? "gmail" : "outlook";
    const granted = provider === "gmail"
      ? ["openid", "email", ...(chance(r, 0.5) ? [GMAIL_READ] : []), ...(chance(r, 0.4) ? [GMAIL_SEND] : [])]
      : ["openid", "email", "offline_access", "User.Read", ...OUTLOOK_SCOPES.filter(() => chance(r, 0.55))];
    const ask = chance(r, 0.6) ? "check" : "confirm";
    const reads = provider === "gmail" ? granted.includes(GMAIL_READ) : granted.includes("Mail.Read");
    out.push({ id, uid: uidOf(id), provider, granted, sendAsked: chance(r, 0.5), ask, family: `${provider}/${ask}/${reads ? "reads" : "no_read"}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ inbox runs
export type When = "none" | "before_read" | "during_read" | "after_check";
export interface Inbox {
  id: number; uid: string; other: string; provider: "gmail" | "outlook";
  what: "disconnect" | "erase";
  when: When;
  mails: number; // messages the run reads (Outlook) / rejections (Gmail)
  priorEpoch: number; // erases before this run
  family: string;
}
export function inboxes(seed: number, n: number): Inbox[] {
  const r = rng(seed), out: Inbox[] = [];
  for (let i = 0; i < n; i++) {
    const id = 30_000 + i;
    const provider = chance(r, 0.5) ? "gmail" : "outlook";
    const what = chance(r, 0.5) ? "disconnect" : "erase";
    const when = pick(r, ["none", "before_read", "during_read", "after_check", "after_check"] as const);
    out.push({ id, uid: uidOf(id), other: uidOf(95_000 + i), provider, what, when, mails: int(r, 1, 4), priorEpoch: chance(r, 0.3) ? int(r, 1, 3) : 0,
      family: `${provider}/${when === "none" ? "none" : `${what}_${when}`}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ deletion words
export interface DeletionWords {
  id: number; deleted: boolean; recorded: boolean; billing: "none" | "cancelled" | undefined; google: Record<string, "revoked" | "refused" | "not_confirmed" | "no_token">;
  outlook: boolean; failures: string[]; grantsRead: boolean; had: string[]; disconnected: boolean; family: string;
}
const FAILS = ["delete your saved resume files", "delete the stored access tokens", "check that everything was deleted"];
export function deletionWords(seed: number, n: number): DeletionWords[] {
  const r = rng(seed), out: DeletionWords[] = [];
  for (let i = 0; i < n; i++) {
    const google: DeletionWords["google"] = {};
    if (chance(r, 0.6)) google.google_career = pick(r, ["revoked", "revoked", "refused", "not_confirmed", "no_token"] as const);
    if (chance(r, 0.2)) google.gmail = pick(r, ["revoked", "refused", "not_confirmed"] as const);
    const deleted = chance(r, 0.85), outlook = chance(r, 0.3);
    const failures = FAILS.filter(() => chance(r, 0.12));
    const billing = pick(r, [undefined, "none", "cancelled"] as const);
    const recorded = chance(r, 0.85);
    out.push({ id: 40_000 + i, deleted, recorded, billing, google, outlook, failures: deleted ? failures : [...failures, "delete your account"], grantsRead: chance(r, 0.93),
      had: [...Object.keys(google), ...(outlook ? ["microsoft"] : [])], disconnected: chance(r, 0.9), family: `${deleted ? "deleted" : "kept"}/${billing ?? "no_billing"}/${recorded ? "recorded" : "unrecorded"}` });
  }
  return out;
}
