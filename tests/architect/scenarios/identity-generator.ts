// Multi-channel identity and account linking (2026-10-30): a deterministic, seeded generator of how one person (or several)
// reaches Trainee on iMessage/SMS, WhatsApp and Telegram, and what must follow. The product is never consulted here: every
// expectation comes from how the scenario was built (who wrote where, when, from which number, what they answered). The
// runner is scenarios-identity.test.ts; the Postgres journeys are flow-scenarios-identity.test.ts.
//
//   link/chain     one phone arriving on two or three channels in any order (iMessage, WhatsApp, Telegram's own-number
//                  share); the channel already linked is asked, and the new one joins only on a bare yes from the contact
//                  that was asked, within the hour, typed (not forwarded). Answers: yes, a late yes, a yes from another of
//                  the person's channels, a forwarded yes, a yes from the new chat itself, a yes from someone else, other
//                  words ("yeah", "yes please"), something else then a yes, nothing.
//   link/stopped   the phone's account said STOP on the channel that would be asked: no second account for the number, no
//                  question held unseen; said plainly; after START there, the next message asks.
//   link/two       one phone on two accounts (a WhatsApp business-scoped id that signed up alone, then its number arrived):
//                  a third channel joins at most one of them, only on that one's yes; the two never merge.
//   link/taken     the number is already an account's sign-in phone, with no channel to ask: no second account, said once.
//   link/card      a forwarded contact card (Telegram, someone else's user id; WhatsApp's contacts message) or a number
//                  typed as text: never links, never signs up, never asks.
//   link/nonce     "connect telegram" links: single use, ten minutes, bound to the account that issued it; another
//                  account's chat, a forged token, the fourth live token burning the first, the account deleted first.
//   iso/recycled   a WhatsApp number given to someone else (another business-scoped id): the new owner never runs as the
//                  old one and, where sign-up allows, gets a fresh account of their own.
//   iso/family     two people texting from one shared iMessage number: one contact is one account (Trainee cannot tell
//                  them apart, and never splits or merges on its own).
//   iso/deleted    an account deleted and the person back on any channel: a fresh account, nothing of the old one, told
//                  about sign-up when it is closed (never silence).
//   iso/crowd      several people on random channels writing in turn: every turn runs as the contact's owner, every message
//                  reaches only its owner.
//   con/stop       STOP on one channel holds what Trainee starts on every channel (WO-038: STOP is the person's); the answer
//                  to a message sent after STOP still goes where it was asked; START on any channel turns all back on.
//   con/home       the home channel: the one set, else the last written on; a link never moves it on its own.
//   con/memory     after a link every channel runs as one account in one thread: a fact said on one is known on the others
//                  (the brain is a stub that remembers per account and thread); another account never knows it.
//   cc/two-links   WhatsApp and Telegram asking at once: each yes links one (the latest asked), named in the reply.
//   cc/turn        the new channel asks while the asked channel's turn is running; the yes after it links.
//   cc/unlink      Telegram unlinked while an answer in parts goes out: nothing claimed after it goes to the chat.
//   cc/nonce-race  two chats redeeming the same link: one wins.
import { chance, int, pick, rng, type R } from "./channel-r2-generator.ts";

export type Ch = "telegram" | "whatsapp" | "imessage";
export const T0 = Date.parse("2026-10-30T15:00:00Z");
export const MIN = 60000, HOUR = 3600000, DAY = 86400000;
export const CHANNELS: readonly Ch[] = ["imessage", "whatsapp", "telegram"];

export type Answer = "yes" | "late" | "wrong_channel" | "forwarded" | "from_new" | "stranger" | "not_yes" | "other_then_yes" | "none";
export const YES_WORDS = ["yes", "Yes", "YES", "yes.", "Yes!", "yes!!", " yes "];
export const NOT_YES = ["yeah", "yes please", "ok", "sure", "y", "yes, link it", "Yes I did", "no", "who is this?"];
export type Signup = "open" | "allow_phone" | "closed";

export type Scenario = { id: number; category: string } & (
  | { kind: "chain"; order: Ch[]; tgFirstVia: "share" | "start"; answers: Answer[]; yesWord: string; notYes: string; delayMin: number[]; signup: Signup }
  | { kind: "stopped"; first: Ch; second: Ch; thenStart: boolean; startOn: "first" | "second"; signup: Signup }
  | { kind: "two"; third: "telegram" | "imessage"; answerBy: "a" | "b" | "none" | "both"; stopA: boolean; stopB: boolean }
  | { kind: "taken"; channel: Ch; signup: Signup; times: number }
  | { kind: "card"; how: "tg_card_owned" | "tg_card_allowed" | "tg_card_unknown" | "wa_contacts" | "typed_number"; fromKnown: boolean; signup: Signup }
  | { kind: "nonce"; issueOn: "imessage" | "whatsapp" | "web"; redeem: "fresh" | "twice" | "late" | "edge_ok" | "edge_late" | "elsewhere" | "forged" | "fourth" | "deleted" | "same_chat" | "replace_old" | "other_account"; ageMs: number }
  | { kind: "recycled"; signup: Signup; otherChannel: "imessage_other_number" | "telegram" | "none"; queued: number; oldAlias: boolean }
  | { kind: "family"; members: number; turns: number }
  | { kind: "deleted"; channels: Ch[]; backOn: Ch; signup: Signup; pending: "none" | "nonce" | "ask"; queued: number }
  | { kind: "crowd"; people: { channels: Ch[] }[]; turns: number; stops: number }
  | { kind: "stop"; channels: Ch[]; stopOn: Ch; textOn: Ch; startOn: Ch | null; proactive: number }
  | { kind: "home"; channels: Ch[]; home: Ch | null; lastOn: Ch; linkNew: Ch | null; proactive: number }
  | { kind: "memory"; order: Ch[]; factOn: number; askOn: number; otherAsks: boolean }
  | { kind: "two_links"; yesCount: number; arrival: "wa_first" | "tg_first"; gapMin: number }
  | { kind: "turn"; when: "during_existing" | "during_new_retry" }
  | { kind: "unlink"; parts: number; unlinkAfter: number; other: "imessage" | "whatsapp" | "none"; via: "text" | "web" }
  | { kind: "nonce_race"; chats: number }
);

const perm = <T>(r: R, xs: readonly T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ANSWERS: Answer[] = ["yes", "yes", "yes", "late", "wrong_channel", "forwarded", "from_new", "stranger", "not_yes", "other_then_yes", "none"];
const SIGNUPS: Signup[] = ["open", "allow_phone", "allow_phone", "closed"];

function chain(r: R, id: number): Scenario {
  const order = perm(r, CHANNELS).slice(0, chance(r, 0.55) ? 3 : 2);
  const answers = order.slice(1).map(() => pick(r, ANSWERS));
  // A first channel always signs up: "closed" is the allow list of the first contact only (later ones must link or stay out).
  const signup = pick(r, SIGNUPS);
  const tgFirstVia = chance(r, 0.8) ? "share" as const : "start" as const;
  return { id, category: `link/chain/${order.map((c) => c[0]).join("")}/${answers.join("+")}`, kind: "chain", order, tgFirstVia, answers, yesWord: pick(r, YES_WORDS), notYes: pick(r, NOT_YES),
    delayMin: answers.map((a) => a === "late" ? int(r, 61, 300) : pick(r, [0, 1, 5, 30, 59])), signup };
}
function stopped(r: R, id: number): Scenario {
  const [first, second] = perm(r, ["imessage", "whatsapp"] as Ch[]).concat([]);
  const s2: Ch = chance(r, 0.35) ? "telegram" : second;
  return { id, category: `link/stopped/${first}-${s2}`, kind: "stopped", first, second: s2, thenStart: chance(r, 0.6), startOn: chance(r, 0.8) ? "first" : "second", signup: pick(r, SIGNUPS) };
}
function two(r: R, id: number): Scenario {
  return { id, category: "link/two", kind: "two", third: chance(r, 0.7) ? "telegram" : "imessage", answerBy: pick(r, ["a", "b", "none", "both"] as const), stopA: chance(r, 0.15), stopB: chance(r, 0.15) };
}
function taken(r: R, id: number): Scenario {
  return { id, category: "link/taken", kind: "taken", channel: pick(r, CHANNELS), signup: pick(r, ["open", "allow_phone"] as Signup[]), times: int(r, 1, 3) };
}
function card(r: R, id: number): Scenario {
  const how = pick(r, ["tg_card_owned", "tg_card_owned", "tg_card_allowed", "tg_card_unknown", "wa_contacts", "typed_number"] as const);
  return { id, category: `link/card/${how}`, kind: "card", how, fromKnown: chance(r, 0.4), signup: pick(r, SIGNUPS) };
}
const REDEEMS = ["fresh", "fresh", "twice", "late", "edge_ok", "edge_late", "elsewhere", "forged", "fourth", "deleted", "same_chat", "replace_old", "other_account"] as const;
function nonce(r: R, id: number): Scenario {
  const redeem = pick(r, REDEEMS);
  const ageMs = redeem === "late" ? int(r, 10 * MIN + 1, 3 * HOUR) : redeem === "edge_ok" ? 10 * MIN - 1 : redeem === "edge_late" ? 10 * MIN : int(r, 0, 9 * MIN);
  return { id, category: `link/nonce/${redeem}`, kind: "nonce", issueOn: pick(r, ["imessage", "whatsapp", "web"] as const), redeem, ageMs };
}
function recycled(r: R, id: number): Scenario {
  return { id, category: `iso/recycled/${chance(r, 0.5) ? "a" : "b"}`, kind: "recycled", signup: pick(r, SIGNUPS), otherChannel: pick(r, ["imessage_other_number", "telegram", "none"] as const), queued: int(r, 0, 3), oldAlias: true };
}
function family(r: R, id: number): Scenario { return { id, category: "iso/family", kind: "family", members: int(r, 2, 3), turns: int(r, 2, 6) }; }
function deleted(r: R, id: number): Scenario {
  const channels = perm(r, CHANNELS).slice(0, int(r, 1, 3));
  return { id, category: `iso/deleted/${channels.length}`, kind: "deleted", channels, backOn: pick(r, CHANNELS), signup: pick(r, SIGNUPS), pending: pick(r, ["none", "nonce", "ask"] as const), queued: int(r, 0, 3) };
}
function crowd(r: R, id: number): Scenario {
  const people = Array.from({ length: int(r, 2, 5) }, () => ({ channels: perm(r, CHANNELS).slice(0, int(r, 1, 3)) }));
  return { id, category: `iso/crowd/${people.length}`, kind: "crowd", people, turns: int(r, 4, 14), stops: int(r, 0, 2) };
}
function stop(r: R, id: number): Scenario {
  const channels = perm(r, CHANNELS).slice(0, int(r, 2, 3));
  return { id, category: `con/stop/${channels.length}`, kind: "stop", channels, stopOn: pick(r, channels), textOn: pick(r, channels), startOn: chance(r, 0.6) ? pick(r, channels) : null, proactive: int(r, 1, 4) };
}
function home(r: R, id: number): Scenario {
  const channels = perm(r, CHANNELS).slice(0, int(r, 1, 2));
  const rest = CHANNELS.filter((c) => !channels.includes(c));
  return { id, category: `con/home/${channels.length}`, kind: "home", channels, home: chance(r, 0.4) ? pick(r, channels) : null, lastOn: pick(r, channels),
    linkNew: rest.length && chance(r, 0.7) ? pick(r, rest) : null, proactive: int(r, 1, 3) };
}
function memory(r: R, id: number): Scenario {
  const order = perm(r, CHANNELS).slice(0, int(r, 2, 3));
  return { id, category: `con/memory/${order.length}`, kind: "memory", order, factOn: int(r, 0, order.length - 1), askOn: int(r, 0, order.length - 1), otherAsks: chance(r, 0.5) };
}
function twoLinks(r: R, id: number): Scenario {
  return { id, category: "cc/two-links", kind: "two_links", yesCount: int(r, 0, 3), arrival: chance(r, 0.5) ? "wa_first" : "tg_first", gapMin: pick(r, [0, 0, 1, 10]) };
}
function turn(r: R, id: number): Scenario { return { id, category: "cc/turn", kind: "turn", when: chance(r, 0.6) ? "during_existing" : "during_new_retry" }; }
function unlink(r: R, id: number): Scenario {
  const parts = int(r, 2, 5);
  return { id, category: `cc/unlink/${chance(r, 0.5) ? "x" : "y"}`, kind: "unlink", parts, unlinkAfter: int(r, 1, parts - 1), other: pick(r, ["imessage", "whatsapp", "none"] as const), via: chance(r, 0.5) ? "text" : "web" };
}
function nonceRace(r: R, id: number): Scenario { return { id, category: "cc/nonce-race", kind: "nonce_race", chats: int(r, 2, 4) }; }

// How many of each (10,000 in all).
export const PLAN: [number, (r: R, id: number) => Scenario][] = [
  [2600, chain], [600, stopped], [600, two], [300, taken], [600, card], [1300, nonce], [600, recycled], [200, family], [600, deleted],
  [500, crowd], [500, stop], [400, home], [400, memory], [300, twoLinks], [200, turn], [200, unlink], [100, nonceRace],
];
export function generate(o: { seed: number }): Scenario[] {
  const r = rng(o.seed);
  const out: Scenario[] = [];
  for (const [n, f] of PLAN) for (let i = 0; i < n; i++) out.push(f(r, out.length + 1));
  return out;
}
