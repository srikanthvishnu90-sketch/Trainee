// Sign-in scenarios at scale for the hosted jobs page (owner, 2026-10-29): a deterministic, seeded generator of random
// sequences of who does what to supabase/functions/trainee-file/handler.ts. Each scenario is a world (does the SMS provider
// work) and 4-30 steps; each step is one actor's request, a change in the world (the clock, the account, Telegram, a payload,
// a store that fails), or a few requests at once. The runner and the invariants are in tests/architect/scenarios-file-signin-battery.ts.
//
// Actors (the runner gives each its own browser, cookie jar and what it has seen):
//   owner    - the account U's person: gets U's links from the bot, holds U's phone (reads its texts), types it many ways;
//   stranger - has forwarded copies of U's links; knows U's number sometimes; types wrong numbers, garbage, injection; guesses
//              codes, replays stale ones; may hold a stale session id of U's (a shared computer) that is already ended;
//   other    - the account V's person: its own links and phone; opens U's forwarded links; uses V's own valid code on them;
//   crawler  - a link-preview fetcher (TelegramBot user agent) opening any link;
//   mini     - the Telegram Mini App: signed initData for a linked or unlinked Telegram id, tampered, stale, future, wrong bot.
// Synthetic only: no real person, number or posting.

export type Actor = "owner" | "stranger" | "other" | "crawler" | "mini";

export type PhoneInput =
  | { k: "own"; fmt: number } // the actor's own account phone, in format #fmt (owner: U's, other: V's)
  | { k: "account_u"; fmt: number } // U's phone (a stranger or V who knows it)
  | { k: "account_v"; fmt: number } // V's phone
  | { k: "old_u" } // U's phone before it changed
  | { k: "random"; n: number } // a number that is no account's
  | { k: "literal"; s: string }; // garbage, injection, too long, empty, unicode digits

export type CodeInput =
  | { k: "live" } // the latest code texted to the actor's own phone (only owner and other have one)
  | { k: "live_spaced" } // the same, typed "123 456"
  | { k: "stale" } // a code that was used or replaced (the stranger's only kind of real code)
  | { k: "other_live" } // V's live code (the other actor uses it on U's link)
  | { k: "random"; n: number }
  | { k: "literal"; s: string };

export type LinkPick = "latest" | "random" | "oldest" | "forged" | "truncated" | "session_id" | "kind_s" | "garbage" | "other_user";
export type InitPick = "u" | "v" | "unlinked" | "tampered" | "stale" | "future" | "wrong_bot" | "garbage" | "empty";
export type ListPick = "u" | "v" | "random" | "garbage";
export type TPick = "own" | "none" | "garbage" | "stolen" | "foreign";
export type Fault =
  | "sessions.session" | "sessions.createSession" | "sessions.beginLogin" | "sessions.login" | "sessions.setPhone" | "sessions.countSend"
  | "sessions.countTry" | "sessions.finishLogin" | "sessions.revoke" | "sessions.revokeAll" | "sessions.setList"
  | "phone.accountPhone" | "phone.send" | "phone.send_refused" | "phone.check" | "tg.lookup" | "store.recallList" | "store.recall"
  | "store.prepared" | "store.appRow" | "store.applied" | "cards.open" | "tap.answer" | "tap.card";

export type Step =
  | { k: "link"; to: "owner" | "other"; forward: boolean; age: number } // the bot sends a fresh link (minted `age` ms ago)
  | { k: "open"; actor: Actor; pick: LinkPick; r: number } // open a link (a browser follows the 303)
  | { k: "get"; actor: Actor; mode: "cookies" | "none" | "text" | "bootstrap" | "stolen" | "foreign_cookie"; r: number }
  | { k: "start"; actor: Actor; phone: PhoneInput }
  | { k: "verify"; actor: Actor; code: CodeInput }
  | { k: "reset"; actor: Actor }
  | { k: "apply"; actor: Actor; t: TPick; ref: "seen" | "random_u" | "random_v" | "garbage"; tag: "seen" | "stale" | "garbage" | "none" | "other_row" | "current"; r: number }
  | { k: "applyall"; actor: Actor; t: TPick; set: "seen" | "stale" | "garbage" | "empty"; r: number }
  | { k: "refresh"; actor: Actor; t: TPick }
  | { k: "signout"; actor: Actor; all: boolean; t: TPick }
  | { k: "mini_boot"; list: ListPick }
  | { k: "mini_post"; init: InitPick; list: ListPick }
  | { k: "method"; m: "PUT" | "DELETE" | "PATCH" }
  | { k: "clock"; ms: number }
  | { k: "phone_change"; to: "new" | "back" | "none" }
  | { k: "delete_account" }
  | { k: "tg"; op: "unlink" | "relink" }
  | { k: "payload"; n: number; op: "change" | "unprepare" | "prepare" }
  | { k: "fault"; f: Fault }
  | { k: "par"; steps: Step[] }; // requests at once (Promise.all)

export interface Scenario { id: number; smsOff: boolean; steps: Step[]; category: string }

// mulberry32: a small seeded PRNG, so every run generates the same scenarios.
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

// Ways a person types a number (the runner fills in the digits): format i of PHONE_FORMATS.
export const PHONE_FORMATS = [
  (d: string) => `+1${d}`, (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, (d: string) => `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`,
  (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`, (d: string) => `1${d}`, (d: string) => ` ${d} `, (d: string) => `+1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
  (d: string) => d, (d: string) => `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)} ${d.slice(6)}`,
];
const GARBAGE_PHONES = [
  "", " ", "call me", "12345", "0207 946 0958", "<script>alert(1)</script>", "' OR 1=1 --", "+1 512 555 0100; DROP TABLE trainee_file_logins", "5".repeat(40),
  "+1 512 555 0100 ext 9", "５１２５５５０１００", "+15125550100\u0000", "null", "undefined", "{{phone}}", "%2B15125550100", "+", "++15125550100", "‮0010555215",
  "+44 20 7946 0958", "+91 98765 43210", "+0 123 456 7890", "1".repeat(16), "+1 (512) 555-01OO", "javascript:alert(1)", "\" onmouseover=\"x", "<img src=x onerror=1>",
];
const GARBAGE_CODES = ["", " ", "abcdef", "12345", "1234567", "<img src=x>", "000000", "999999", "12 34 56 78", "１２３４５６", "123-456", "' OR '1'='1", "-123456", "123456\n", "null"];

const pickOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const MIN = 60_000, HOUR = 3600_000;

function phoneInput(r: () => number, actor: Actor): PhoneInput {
  const k = r();
  if (actor === "owner") {
    if (k < 0.75) return { k: "own", fmt: Math.floor(r() * PHONE_FORMATS.length) };
    if (k < 0.82) return { k: "old_u" };
    if (k < 0.9) return { k: "random", n: Math.floor(r() * 1e7) };
    return { k: "literal", s: pickOf(r, GARBAGE_PHONES) };
  }
  if (actor === "other") {
    if (k < 0.5) return { k: "own", fmt: Math.floor(r() * PHONE_FORMATS.length) };
    if (k < 0.7) return { k: "account_u", fmt: Math.floor(r() * PHONE_FORMATS.length) };
    if (k < 0.85) return { k: "random", n: Math.floor(r() * 1e7) };
    return { k: "literal", s: pickOf(r, GARBAGE_PHONES) };
  }
  if (k < 0.3) return { k: "account_u", fmt: Math.floor(r() * PHONE_FORMATS.length) };
  if (k < 0.4) return { k: "account_v", fmt: Math.floor(r() * PHONE_FORMATS.length) };
  if (k < 0.45) return { k: "old_u" };
  if (k < 0.7) return { k: "random", n: Math.floor(r() * 1e7) };
  return { k: "literal", s: pickOf(r, GARBAGE_PHONES) };
}
function codeInput(r: () => number, actor: Actor): CodeInput {
  const k = r();
  if (actor === "owner" || actor === "other") {
    if (k < 0.55) return { k: "live" };
    if (k < 0.62) return { k: "live_spaced" };
    if (k < 0.72) return { k: "stale" };
    if (actor === "other" && k < 0.82) return { k: "other_live" };
    if (k < 0.9) return { k: "random", n: Math.floor(r() * 1e6) };
    return { k: "literal", s: pickOf(r, GARBAGE_CODES) };
  }
  if (k < 0.3) return { k: "stale" };
  if (k < 0.75) return { k: "random", n: Math.floor(r() * 1e6) };
  return { k: "literal", s: pickOf(r, GARBAGE_CODES) };
}
const tPick = (r: () => number, actor: Actor): TPick => {
  const k = r();
  if (actor === "owner" || actor === "other" || actor === "mini") return k < 0.8 ? "own" : k < 0.88 ? "none" : k < 0.94 ? "garbage" : "foreign";
  return k < 0.45 ? "stolen" : k < 0.65 ? "none" : k < 0.85 ? "garbage" : "foreign";
};
const FAULTS: Fault[] = ["sessions.session", "sessions.createSession", "sessions.beginLogin", "sessions.login", "sessions.setPhone", "sessions.countSend", "sessions.countTry",
  "sessions.finishLogin", "sessions.revoke", "sessions.revokeAll", "sessions.setList", "phone.accountPhone", "phone.send", "phone.send_refused", "phone.check", "tg.lookup",
  "store.recallList", "store.recall", "store.prepared", "store.appRow", "store.applied", "cards.open", "tap.answer", "tap.card"];

// One actor's request.
function request(r: () => number, actor: Actor): Step {
  const k = r();
  if (actor === "crawler") return { k: "open", actor, pick: pickOf(r, ["latest", "random", "oldest", "forged", "other_user"] as const), r: r() };
  if (actor === "mini") {
    if (k < 0.2) return { k: "mini_boot", list: pickOf(r, ["u", "v", "random", "garbage"] as const) };
    if (k < 0.65) return { k: "mini_post", init: r() < 0.55 ? "u" : pickOf(r, ["v", "unlinked", "tampered", "stale", "future", "wrong_bot", "garbage", "empty"] as const), list: r() < 0.75 ? "u" : pickOf(r, ["v", "random", "garbage"] as const) };
    if (k < 0.8) return { k: "apply", actor, t: tPick(r, actor), ref: r() < 0.8 ? "seen" : "random_u", tag: r() < 0.75 ? "seen" : pickOf(r, ["stale", "garbage", "none", "other_row", "current"] as const), r: r() };
    if (k < 0.88) return { k: "applyall", actor, t: tPick(r, actor), set: r() < 0.8 ? "seen" : pickOf(r, ["stale", "garbage", "empty"] as const), r: r() };
    if (k < 0.94) return { k: "refresh", actor, t: tPick(r, actor) };
    return { k: "signout", actor, all: r() < 0.4, t: tPick(r, actor) };
  }
  const linkPick: LinkPick = actor === "stranger" ? pickOf(r, ["latest", "latest", "random", "oldest", "forged", "truncated", "session_id", "kind_s", "garbage", "other_user"] as const)
    : r() < 0.8 ? "latest" : pickOf(r, ["random", "oldest", "forged", "truncated", "kind_s", "other_user"] as const);
  if (k < 0.16) return { k: "open", actor, pick: linkPick, r: r() };
  if (k < 0.27) return { k: "get", actor, mode: r() < 0.7 ? "cookies" : pickOf(r, ["none", "text", "bootstrap", actor === "stranger" ? "stolen" : "foreign_cookie", "foreign_cookie"] as const), r: r() };
  if (k < 0.42) return { k: "start", actor, phone: phoneInput(r, actor) };
  if (k < 0.57) return { k: "verify", actor, code: codeInput(r, actor) };
  if (k < 0.6) return { k: "reset", actor };
  if (k < 0.78) return { k: "apply", actor, t: tPick(r, actor), ref: r() < 0.75 ? "seen" : pickOf(r, ["random_u", "random_v", "garbage"] as const), tag: r() < 0.7 ? "seen" : pickOf(r, ["stale", "garbage", "none", "other_row", "current"] as const), r: r() };
  if (k < 0.85) return { k: "applyall", actor, t: tPick(r, actor), set: r() < 0.75 ? "seen" : pickOf(r, ["stale", "garbage", "empty"] as const), r: r() };
  if (k < 0.91) return { k: "refresh", actor, t: tPick(r, actor) };
  return { k: "signout", actor, all: r() < 0.35, t: tPick(r, actor) };
}
const ACTORS: Actor[] = ["owner", "owner", "owner", "owner", "stranger", "stranger", "stranger", "other", "other", "crawler", "mini", "mini"];

function worldStep(r: () => number): Step {
  const k = r();
  if (k < 0.35) return { k: "clock", ms: pickOf(r, [MIN, 5 * MIN, 14 * MIN, 16 * MIN, 30 * MIN, HOUR, 2 * HOUR + MIN, 3 * HOUR, 23 * HOUR, 24 * HOUR + MIN]) };
  if (k < 0.47) return { k: "phone_change", to: pickOf(r, ["new", "back", "back", "none"] as const) };
  if (k < 0.5) return { k: "delete_account" };
  if (k < 0.6) return { k: "tg", op: pickOf(r, ["unlink", "relink", "relink"] as const) };
  if (k < 0.75) return { k: "payload", n: 1 + Math.floor(r() * 4), op: pickOf(r, ["change", "change", "unprepare", "prepare"] as const) };
  if (k < 0.97) return { k: "fault", f: pickOf(r, FAULTS) };
  return { k: "method", m: pickOf(r, ["PUT", "DELETE", "PATCH"] as const) };
}

// The owner's own happy path, so most scenarios reach a signed-in page (where Apply, sign-out and revocation can be tested).
function signInSteps(r: () => number, actor: "owner" | "other"): Step[] {
  return [
    { k: "link", to: actor, forward: actor === "owner" && r() < 0.4, age: 0 },
    { k: "open", actor, pick: "latest", r: r() },
    { k: "start", actor, phone: { k: "own", fmt: Math.floor(r() * PHONE_FORMATS.length) } },
    { k: "verify", actor, code: r() < 0.85 ? { k: "live" } : { k: "live_spaced" } },
    { k: "get", actor, mode: "cookies", r: r() },
  ];
}

// A stranger with a forwarded link guessing: a number (often not the account's), then a run of codes past the cap.
function guessSteps(r: () => number): Step[] {
  return [
    { k: "open", actor: "stranger", pick: "latest", r: r() },
    { k: "start", actor: "stranger", phone: phoneInput(r, "stranger") },
    ...Array.from({ length: 5 + Math.floor(r() * 3) }, () => ({ k: "verify", actor: "stranger", code: codeInput(r, "stranger") }) as Step),
  ];
}

// The other account V holding a LIVE code for its own phone (texted on its own link, not used yet) and trying it on U's
// link: typing V's own number, or U's; a code that proves V must never open U's list.
function crossSteps(r: () => number): Step[] {
  return [
    { k: "link", to: "other", forward: false, age: 0 },
    { k: "open", actor: "other", pick: "latest", r: r() },
    { k: "start", actor: "other", phone: { k: "own", fmt: Math.floor(r() * PHONE_FORMATS.length) } },
    { k: "open", actor: "other", pick: "other_user", r: r() },
    { k: "start", actor: "other", phone: r() < 0.6 ? { k: "own", fmt: Math.floor(r() * PHONE_FORMATS.length) } : { k: "account_u", fmt: Math.floor(r() * PHONE_FORMATS.length) } },
    { k: "verify", actor: "other", code: r() < 0.8 ? { k: "live" } : { k: "live_spaced" } },
    { k: "get", actor: "other", mode: "cookies", r: r() },
  ];
}

const CATEGORIES = ["owner_flow", "forwarded", "other_account", "revocation", "expiry", "mini_app", "faults", "concurrency", "mixed"] as const;

export function generate(o: { seed: number; count: number }): Scenario[] {
  const r = rng(o.seed);
  const out: Scenario[] = [];
  for (let id = 0; id < o.count; id++) {
    const category = CATEGORIES[id % CATEGORIES.length];
    const steps: Step[] = [];
    const smsOff = r() < 0.04;
    // Most scenarios start with the owner signed in (or on the way); some with nothing at all.
    if (r() < 0.75) steps.push(...signInSteps(r, "owner"));
    else steps.push({ k: "link", to: "owner", forward: r() < 0.7, age: r() < 0.1 ? 24 * HOUR - 2 * MIN : 0 });
    if (category === "other_account" && r() < 0.5) steps.push(...crossSteps(r));
    else if (category === "other_account" || r() < 0.2) steps.push(...signInSteps(r, "other"));
    if ((category === "forwarded" || category === "expiry") && r() < 0.5) steps.push({ k: "link", to: "owner", forward: true, age: 0 }, ...guessSteps(r));
    const n = 3 + Math.floor(r() * 12);
    for (let i = 0; i < n; i++) {
      const k = r();
      const bias = (a: Actor[]) => (r() < 0.6 ? pickOf(r, a) : pickOf(r, ACTORS));
      const actor: Actor = category === "forwarded" ? bias(["stranger"]) : category === "other_account" ? bias(["other"]) : category === "mini_app" ? bias(["mini"])
        : category === "owner_flow" || category === "revocation" ? bias(["owner"]) : pickOf(r, ACTORS);
      const conc = category === "concurrency" ? 0.35 : 0.06;
      const world = category === "faults" ? 0.35 : category === "expiry" || category === "revocation" ? 0.3 : 0.15;
      if (k < conc) {
        // Requests at once: a double tap (the same request 2-4 times), or two actors racing.
        const a = request(r, actor);
        const copies = r() < 0.6 ? Array.from({ length: 2 + Math.floor(r() * 3) }, () => a) : [a, request(r, pickOf(r, ACTORS))];
        steps.push({ k: "par", steps: copies });
      } else if (k < conc + world) {
        steps.push(category === "faults" && r() < 0.6 ? { k: "fault", f: pickOf(r, FAULTS) } : worldStep(r));
      } else if (k < conc + world + 0.06) {
        steps.push({ k: "link", to: r() < 0.8 ? "owner" : "other", forward: r() < 0.5, age: r() < 0.1 ? 24 * HOUR - 5 * MIN : 0 });
      } else if (category === "revocation" && r() < 0.15) {
        steps.push({ k: "signout", actor: "owner", all: r() < 0.5, t: "own" });
      } else if (category === "owner_flow" && r() < 0.25) {
        steps.push(...signInSteps(r, "owner").slice(r() < 0.5 ? 0 : 1));
      } else {
        steps.push(request(r, actor));
      }
    }
    out.push({ id, smsOff, steps, category });
  }
  return out;
}

// A seeded sample of the scenarios, every category represented in proportion.
export function sample(all: Scenario[], k: number, seed = 7): Scenario[] {
  const r = rng(seed), pool = [...all], out: Scenario[] = [];
  while (out.length < k && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
