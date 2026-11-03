// Connectors, disconnect and erase at scale (owner rules, 2026-10-29): a deterministic, seeded generator of what a person
// texts about their connected mail accounts, the accounts they have, the work waiting on them, and how the provider
// behaves when Trainee revokes. Every address is synthetic (.example / .test); every token is fake.
//
//   asks       "connect gmail", "link my outlook", "disconnect google", "remove gmail access", "unlink outlook", "what's
//              connected", "what can you see", "is my outlook connected", "check my gmail", with greetings, please and
//              thanks, case, punctuation and common typos; mixed with another intent ("disconnect gmail and apply to
//              Stripe": the connector turn never acts on half a message); and controls that are never a connector ask
//              ("remove Google from my list", "connect me with Maya at Google", "add Microsoft", "I applied to Google").
//   revokes    the stored grant (refresh and access token, one of them, none, unreadable) and what Google answers each
//              try (200, 400 invalid_token, 401/403/404, 429, 5xx, a timeout, a network failure).
//   accounts   who has what (none, Gmail, Outlook, both, the legacy finance grant), its token state (fresh, expired,
//              revoked at the provider, refresh failing), the work waiting on it (approved emails, queued sends to N
//              people, follow-ups, emails in flight, parked tasks, scheduled reply syncs, approved outreach actions, mail
//              read), how the provider answers the revoke, a database step that fails, and what is asked.
// Expectations are derived from the fields (tests/architect/scenarios-connectors.test.ts).

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
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: R, p: number) => r() < p;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ------------------------------------------------------------------------------------------------ asks
export type Id = "gmail" | "outlook";
export type Route =
  | { kind: "whats_connected" }
  | { kind: "connect"; id: Id }
  | { kind: "disconnect"; id: Id }
  | { kind: "status"; id: "outlook" }
  | { kind: "check"; need: Id | "mail" }
  | null;
export interface Ask { id: number; input: string; expect: Route; family: string }

const LEADS = ["", "", "", "please ", "pls ", "can you ", "could you ", "hey, ", "hey ", "ok ", "okay, ", "hi! ", "i want to ", "I'd like to ", "go ahead and ", "can u "];
const TAILS = ["", "", "", ".", "!", "?", " please", " pls", " thanks", " now", " right now", " for me", " asap", " please!", ", thanks"];
const CASES: ((s: string) => string)[] = [(s) => s, (s) => s, (s) => s.toLowerCase(), (s) => s.toUpperCase(), (s) => s.charAt(0).toUpperCase() + s.slice(1)];
const wrap = (r: R, core: string) => pick(r, CASES)(`${pick(r, LEADS)}${core}${pick(r, TAILS)}`).replace(/\s+/g, " ").trim();
// A question keeps its own lead-ins ("hey, what's connected?"), never "can you what's connected".
const QLEADS = ["", "", "", "hey ", "hey, ", "ok ", "so ", "hi, ", "quick question: "], QTAILS = ["", "", "?", "?", "??", " right now?", " now?", "."];
const wrapQ = (r: R, core: string) => pick(r, CASES)(`${pick(r, QLEADS)}${core}${pick(r, QTAILS)}`).replace(/\s+/g, " ").trim();

// Words for each mailbox. "google" and "microsoft" alone are also employers: with "remove" or "add" they are never a
// connector ask (controls below); with "disconnect", "unlink", "revoke", "connect", "link" they are.
const GMAIL = ["gmail", "Gmail", "my gmail", "my Gmail", "google", "Google", "my google account", "google account", "my google mail", "gmail account", "my gmail account", "my Google account", "the gmail"];
const GMAIL_TYPO = ["gmial", "gamil", "gmal", "g-mail", "g mail", "gmaill", "my gmial", "my gamil"];
const OUTLOOK = ["outlook", "Outlook", "my outlook", "my Outlook", "hotmail", "my hotmail", "outlook account", "my outlook account", "my microsoft account", "microsoft", "my work email", "my outlook email", "office 365", "my office 365"];
const OUTLOOK_TYPO = ["outlok", "outloook", "outlookk", "my outlok", "my outloook"];
const BARE_EMPLOYER = new Set(["google", "Google", "microsoft"]);
const DIS = ["disconnect", "unlink", "revoke", "remove", "Disconnect", "Unlink", "Remove"];
const DIS_TYPO = ["disconect", "dissconnect", "disconnet", "disconnnect", "discconnect", "disonnect", "unlnk", "dicsonnect"];
const CON = ["connect", "link", "hook up", "set up", "reconnect", "Connect", "Link"];
const CON_TYPO = ["conect", "connnect", "conncet", "cnnect", "reconect"];

function disconnectAsk(r: R, id: Id): { input: string; family: string } {
  const words = id === "gmail" ? GMAIL : OUTLOOK, typos = id === "gmail" ? GMAIL_TYPO : OUTLOOK_TYPO;
  const k = r();
  if (k < 0.45) {
    let v = pick(r, DIS), w = pick(r, words);
    // "remove Google" alone is an employer; "remove my google account", "remove gmail" are the mailbox.
    while (/^remove$/i.test(v) && BARE_EMPLOYER.has(w)) w = pick(r, words);
    const tail = /^(?:revoke|remove)$/i.test(v) && chance(r, 0.4) ? " access" : "";
    return { input: wrap(r, `${v} ${w}${tail}`), family: `${v.toLowerCase()}${tail ? "+access" : ""}` };
  }
  if (k < 0.6) {
    const w = pick(r, words.filter((x) => !BARE_EMPLOYER.has(x)));
    const t = pick(r, ["remove {w} access", "revoke {w} access", "remove access to {w}", "revoke access to {w}", "revoke trainee's access to {w}", "remove trainee's access to {w}",
      "remove your access to {w}", "disconnect trainee from {w}", "unlink trainee from {w}", "remove trainee from {w}", "disconnect {w} from trainee", "unlink {w} from trainee"]);
    return { input: wrap(r, t.replace("{w}", w)), family: "access" };
  }
  if (k < 0.8) {
    const v = pick(r, DIS_TYPO), w = pick(r, words.filter((x) => !BARE_EMPLOYER.has(x)));
    return { input: wrap(r, `${v} ${w}`), family: "typo-verb" };
  }
  const v = pick(r, ["disconnect", "unlink", "revoke"]), w = pick(r, typos);
  return { input: wrap(r, `${v} ${w}`), family: "typo-mailbox" };
}
function connectAsk(r: R, id: Id): { input: string; family: string } {
  const k = r();
  if (id === "gmail") {
    if (k < 0.65) return { input: wrap(r, `${pick(r, CON)} ${pick(r, GMAIL)}`), family: "connect" };
    if (k < 0.8) return { input: wrap(r, `${pick(r, ["add", "add my", "set up my", "hook up my"])} ${pick(r, ["gmail", "Gmail", "google account", "gmail account"])}`), family: "add" };
    if (k < 0.92) return { input: wrap(r, `${pick(r, CON_TYPO)} ${pick(r, GMAIL.filter((x) => !BARE_EMPLOYER.has(x)))}`), family: "typo-verb" };
    return { input: wrap(r, `${pick(r, ["connect", "link"])} ${pick(r, GMAIL_TYPO)}`), family: "typo-mailbox" };
  }
  const W = ["outlook", "Outlook", "my outlook", "my hotmail", "my work email", "my school email", "my microsoft account", "office 365", "my outlook account", "hotmail", "microsoft"];
  if (k < 0.65) return { input: wrap(r, `${pick(r, [...CON.filter((c) => !/reconnect/i.test(c))])} ${pick(r, W)}`), family: "connect" };
  if (k < 0.8) return { input: wrap(r, `${pick(r, ["use", "add", "set up"])} ${pick(r, ["my outlook", "my work email", "my school email", "my hotmail", "outlook"])}`), family: "use" };
  if (k < 0.92) return { input: wrap(r, `${pick(r, CON_TYPO.filter((c) => !/reconect/.test(c)))} ${pick(r, ["outlook", "my outlook", "my work email", "hotmail"])}`), family: "typo-verb" };
  return { input: wrap(r, `${pick(r, ["connect", "link"])} ${pick(r, OUTLOOK_TYPO)}`), family: "typo-mailbox" };
}
const WHATS = ["what's connected", "whats connected", "what is connected", "what's linked", "what's connected to trainee", "what accounts are connected",
  "which accounts are connected", "what do you have access to", "what have I connected", "show my connections", "my connections", "list my connections",
  "what can you see", "what can you access", "what can you read", "what accounts do you have access to", "what apps are connected", "what's hooked up",
  "is my gmail connected", "is gmail connected", "is my google account connected", "what email accounts are connected", "whats conected", "what's conected"];
const OUTLOOK_STATUS = ["is my outlook connected", "is outlook connected", "is my hotmail connected", "is my work email connected", "is my outlook still connected"];
const CHECKS: [string, Id | "mail"][] = [["check my gmail", "gmail"], ["check my outlook", "outlook"], ["check my email", "mail"], ["read my inbox", "mail"], ["scan my gmail for replies", "gmail"], ["check my hotmail", "outlook"], ["sync my outlook", "outlook"]];
const OTHER = ["apply to Stripe", "find me analyst jobs", "what's my status", "tell me about Acme", "draft a note to Maya", "show my applications", "set my pace to 5 a day"];
const NAMES = ["Maya", "Maya Chen", "Sam", "the recruiter", "Priya", "Jordan Lee"];
const COS = ["Google", "Microsoft", "Stripe", "Acme", "Google Cloud", "Outlook Labs"];
function control(r: R): string {
  const fixed = ["remove google", "Remove Google", "remove Google from my list", "remove google from my targets", "remove microsoft", "Remove Microsoft from my list",
    "add google", "add Google to my list", "add microsoft", "add Microsoft to my targets", "I applied to Google", "apply to google", "connect me with Maya at Google",
    "connect me with someone at Microsoft", "disconnect", "unlink", "connect", "what's next", "what is my status", "link to the job please", "my gmail is sam@gmail.example",
    "I use outlook at work", "gmail", "outlook", "does google sponsor visas?", "remove the second one", "remove 2", "what's connected to the role?", "who do I know at google",
    "should I use gmail or outlook for applications?", "is google hiring?", "what can you do", "connect the dots for me", "remove my last application", "unlink my resume"];
  const k = r();
  if (k < 0.5) return pick(r, fixed);
  if (k < 0.65) return `${pick(r, ["connect me with", "can you connect me with", "introduce me to", "link me up with"])} ${pick(r, NAMES)} at ${pick(r, COS)}`;
  if (k < 0.8) return `${pick(r, ["remove", "drop", "add", "delete"])} ${pick(r, COS)} ${pick(r, ["from my list", "from my targets", "to my list", "to my targets", "from the shortlist"])}`;
  return `${pick(r, ["I applied to", "I interviewed at", "tell me about", "what does"])} ${pick(r, COS)}${pick(r, ["", "?", " last week", " pay"])}`;
}

export function asks(seed: number, n: number): Ask[] {
  const r = rng(seed);
  const out: Ask[] = [];
  const add = (input: string, expect: Route, family: string) => out.push({ id: out.length, input, expect, family });
  while (out.length < n) {
    const k = r();
    if (k < 0.24) { const id: Id = chance(r, 0.55) ? "gmail" : "outlook"; const a = disconnectAsk(r, id); add(a.input, { kind: "disconnect", id }, `disconnect/${id}/${a.family}`); }
    else if (k < 0.42) { const id: Id = chance(r, 0.5) ? "gmail" : "outlook"; const a = connectAsk(r, id); add(a.input, { kind: "connect", id }, `connect/${id}/${a.family}`); }
    else if (k < 0.56) { const w = pick(r, WHATS); add(wrapQ(r, w), { kind: "whats_connected" }, `whats_connected/${/see|access|read/.test(w) ? "what-can-you" : /^is /.test(w) ? "is-gmail" : "words"}`); }
    else if (k < 0.6) add(wrapQ(r, pick(r, OUTLOOK_STATUS)), { kind: "status", id: "outlook" }, "status/outlook");
    else if (k < 0.64) { const [m, need] = pick(r, CHECKS); add(pick(r, [m, `${m} please`, `can you ${m}?`, `${m.charAt(0).toUpperCase()}${m.slice(1)}`]), { kind: "check", need }, `check/${need}`); }
    else if (k < 0.78) {
      // Mixed with another intent: never acted on as a connector ask by code.
      const id: Id = chance(r, 0.5) ? "gmail" : "outlook";
      const core = chance(r, 0.6) ? disconnectAsk(r, id).input.replace(/[.!?]+$/, "") : connectAsk(r, id).input.replace(/[.!?]+$/, "");
      const other = pick(r, OTHER);
      const form = pick(r, ["{a} and {o}", "{a}, then {o}", "{o} and {a}", "{a} and also {o}", "{a}. also {o}", "first {a} then {o}"]);
      add(form.replace("{a}", core).replace("{o}", other), null, "mixed");
    } else if (k < 0.8) add(wrap(r, pick(r, ["disconnect gmail and outlook", "disconnect both gmail and outlook", "unlink outlook and gmail"])), null, "mixed/both");
    else add(control(r), null, "control");
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ revokes
export type Answer = 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | "timeout" | "network";
export const ANSWERS: readonly Answer[] = [200, 400, 401, 403, 404, 429, 500, 502, 503, "timeout", "network"];
export interface Revoke { id: number; secret: string | null; tokens: string[]; answers: Record<string, Answer[]>; family: string }
// The stored Vault secret (JSON) and, per token, Google's answer to each try (enough answers for every try).
export function revokes(seed: number, n: number): Revoke[] {
  const r = rng(seed);
  const out: Revoke[] = [];
  while (out.length < n) {
    const i = out.length;
    const refresh = `1//FAKErefresh${i}`, access = `ya29.FAKEaccess${i}`;
    const shape = pick(r, ["both", "both", "both", "refresh", "access", "none", "garbage", "empty-strings", "null"] as const);
    const tok: Record<string, unknown> = {};
    if (shape === "both" || shape === "refresh") tok.refresh_token = refresh;
    if (shape === "both" || shape === "access") tok.access_token = access;
    if (shape === "empty-strings") { tok.refresh_token = ""; tok.access_token = ""; }
    const secret = shape === "garbage" ? "not json {" : shape === "null" ? null : JSON.stringify({ ...tok, expires_at: 1, token_type: "Bearer" });
    const tokens = [tok.refresh_token, tok.access_token].filter((t) => typeof t === "string" && t.length > 0) as string[];
    const answers: Record<string, Answer[]> = {};
    const style = pick(r, ["ok", "refused", "flaky", "down", "mixed", "random"] as const);
    for (const t of tokens) {
      const seq: Answer[] = [];
      for (let k = 0; k < 4; k++) {
        seq.push(style === "ok" ? 200 : style === "refused" ? 400 : style === "down" ? pick(r, [500, 502, 503, "timeout", "network"] as const)
          : style === "flaky" ? (k < int(r, 0, 3) ? pick(r, [503, "timeout", "network", 429] as const) : 200) : pick(r, ANSWERS));
      }
      answers[t] = seq;
    }
    out.push({ id: i, secret, tokens, answers, family: `${shape}/${style}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ accounts
export type TokenState = "fresh" | "expired" | "revoked_at_provider" | "refresh_failing";
export type Step = "none" | "read_connections" | "vault_read" | "vault_delete" | "row_delete" | "row_delete_noop" | "mail_delete" | "mail_read" | "drafts_read" | "drafts_update" | "queue_read" | "readback";
export interface Account {
  id: number;
  gmail: boolean; legacy: boolean; outlook: boolean; // the grants held (google_career, the legacy finance "gmail", microsoft)
  vault: { gmail: boolean; legacy: boolean; outlook: boolean }; // whether each grant's Vault entry exists
  token: TokenState;
  revoke: Answer; // what Google answers every try for this person
  approved: number; // approved outreach emails not on the rail
  queued: { gmail: number; outlook: number }; // emails queued on the rail per mailbox (to N people)
  queuedOutreachOn: "gmail" | "outlook" | null; // one approved outreach draft queued on this mailbox
  followups: number; // follow-ups queued behind a sent email
  inFlight: "none" | "before_token" | "after_token" | "accepted" | "dead_worker"; // a worker holding one email when the disconnect runs
  parked: ("gmail" | "outlook" | "mail")[]; // tasks waiting on a connector
  sync: boolean; // a scheduled reply sync (cursor) for each connected mailbox
  actions: number; // approved outreach actions (follow-ups) waiting to be handed to the rail
  mail: { events: number; drafts: number; cursor: boolean; outlook: number; turns: number }; // mail read from the accounts
  ask: Id | "whats_connected"; // what the person texts
  phrase: string;
  fail: Step; // one database step that fails (or "none")
  erase: "none" | "account_delete" | "forget_everything";
  reconnect: boolean; // the person connects the same mailbox again afterwards
}
export function accounts(seed: number, n: number): Account[] {
  const r = rng(seed);
  const out: Account[] = [];
  while (out.length < n) {
    const has = pick(r, ["none", "gmail", "gmail", "outlook", "outlook", "both", "both", "legacy+gmail", "legacy"] as const);
    const gmail = has === "gmail" || has === "both" || has === "legacy+gmail", outlook = has === "outlook" || has === "both", legacy = has.startsWith("legacy");
    const ask: Account["ask"] = chance(r, 0.1) ? "whats_connected" : has === "outlook" ? (chance(r, 0.85) ? "outlook" : "gmail") : has === "none" ? pick(r, ["gmail", "outlook"] as const) : has === "both" ? pick(r, ["gmail", "outlook"] as const) : (chance(r, 0.85) ? "gmail" : "outlook");
    const qn = () => (chance(r, 0.45) ? 0 : pick(r, [1, 1, 2, 3, 5, 8, 25]));
    const a: Account = {
      id: out.length, gmail, legacy, outlook,
      vault: { gmail: gmail && chance(r, 0.95), legacy: legacy && chance(r, 0.95), outlook: outlook && chance(r, 0.95) },
      token: pick(r, ["fresh", "fresh", "expired", "revoked_at_provider", "refresh_failing"] as const),
      revoke: chance(r, 0.5) ? 200 : pick(r, ANSWERS),
      approved: chance(r, 0.5) ? 0 : pick(r, [1, 2, 3, 7]),
      queued: { gmail: gmail ? qn() : 0, outlook: outlook ? qn() : 0 },
      queuedOutreachOn: chance(r, 0.3) ? (gmail && (!outlook || chance(r, 0.5)) ? "gmail" : outlook ? "outlook" : null) : null,
      followups: gmail && chance(r, 0.3) ? int(r, 1, 3) : 0,
      inFlight: (gmail || outlook) && chance(r, 0.3) ? pick(r, ["before_token", "after_token", "accepted", "dead_worker"] as const) : "none",
      parked: chance(r, 0.25) ? [pick(r, ["gmail", "outlook", "mail"] as const)] : [],
      sync: chance(r, 0.4),
      actions: chance(r, 0.3) ? int(r, 1, 3) : 0,
      mail: { events: chance(r, 0.4) ? int(r, 1, 4) : 0, drafts: chance(r, 0.2) ? int(r, 1, 2) : 0, cursor: chance(r, 0.4), outlook: chance(r, 0.4) ? int(r, 1, 5) : 0, turns: chance(r, 0.3) ? int(r, 1, 3) : 0 },
      ask, phrase: "",
      fail: chance(r, 0.7) ? "none" : pick(r, ["read_connections", "vault_read", "vault_delete", "row_delete", "row_delete_noop", "mail_delete", "mail_read", "drafts_read", "drafts_update", "queue_read", "readback"] as const),
      erase: chance(r, 0.8) ? "none" : pick(r, ["account_delete", "forget_everything"] as const),
      reconnect: chance(r, 0.35),
    };
    const ar = rng(seed * 31 + a.id);
    a.phrase = a.ask === "whats_connected" ? wrapQ(ar, pick(ar, WHATS.filter((w) => !/^is /.test(w)))) : disconnectAsk(ar, a.ask).input;
    out.push(a);
  }
  return out;
}

// A sample that covers every value of every field at least once, then fills up at random (seeded).
export function sampleAccounts(all: Account[], k: number, seed = 7): Account[] {
  const r = rng(seed);
  const got = new Set<Account>();
  const keys = (a: Account) => [`has:${a.gmail}${a.outlook}${a.legacy}`, `tok:${a.token}`, `rev:${a.revoke}`, `fly:${a.inFlight}`, `fail:${a.fail}`, `erase:${a.erase}`, `ask:${a.ask}`, `park:${a.parked.join()}`, `qo:${a.queuedOutreachOn}`];
  const seen = new Set<string>();
  for (const a of all) {
    if (got.size >= k) break;
    if (keys(a).some((x) => !seen.has(x))) { got.add(a); keys(a).forEach((x) => seen.add(x)); }
  }
  while (got.size < k) got.add(pick(r, all));
  return [...got].sort((a, b) => a.id - b.id);
}

// A reply that asks the person for a secret (a password or a one-time code). "your password never reaches Trainee" is not.
export const ASKS_SECRET = /\b(?:send|tell|give|text|share|enter|type|paste|reply with)\b[^.?!]{0,30}\b(?:password|passcode|one-time code|verification code|2fa code|otp)\b|\bwhat(?:'s| is) your (?:password|code)\b/i;
