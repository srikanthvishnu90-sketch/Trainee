// Channel delivery round 2 (2026-10-30): a deterministic, seeded generator of what happens around a delivery on WhatsApp,
// iMessage/SMS (LoopMessage) and across a person's channels, each scenario with what must happen. Round 1 is
// channel-delivery-generator.ts. The product is never consulted here: every expectation comes from how the scenario was
// built (who wrote where and when, what the provider answered, what the person changed).
//
//   wa/window     WhatsApp's 24-hour window at its edges: the person's own message time (the webhook's timestamp) against
//                 the webhook's arrival (Meta retries a webhook for hours; a phone's clock runs ahead), and a delivery at
//                 exactly 24 h, 24 h less Trainee's 10-minute margin, a millisecond either side, and anywhere between.
//   wa/template   the waiting-updates template: its name and language as configured (spaces, case), its one parameter (the
//                 count of held messages, never a newline, a tab or another person's count), once per silence, never to
//                 a person who said STOP.
//   wa/media      what a person sends that is not text: a voice note, audio, video, a photo, a file, a sticker, a reaction,
//                 a location, a contact card, an unsupported message, a quick-reply tap; from a known person or a stranger.
//   wa/status     Meta's status webhooks for a row of 1-4 messages: sent / delivered / read / failed, out of order and
//                 repeated, a failure on any message (131047 and 131049 the window, 130429 throughput, 131026 undeliverable,
//                 131000, 131051), and a late copy of the same failure after the row was sent again.
//   wa/owner      a number given to someone else (another business-scoped id writes from it) and a person who changed their
//                 number (Meta's user_changed_number), with queued, held and in-flight messages, and other channels or none.
//   wa/bsuid      business-scoped ids beside phone numbers: a contact known by one, a message carrying the other or both.
//   wa/errors     the send itself refused on message b of k: 131047, 131049, 131026, 130429, 131056, 80007, HTTP 429 / 500 /
//                 502 / 503, a timeout, a connection that never opened.
//   lm/sms        texts that came over SMS (iMessage not available) or iMessage: the carrier keywords in English, French and
//                 Spanish (STOP, CANCEL, END, QUIT, REVOKE, OPT OUT, ARRET, ARRÊT, PARAR, BAJA, CANCELAR, HELP, AIDE,
//                 AYUDA...) with what phones put around them.
//   lm/segments   replies in GSM-7 and in UCS-2 (emoji, CJK, curly quotes) of every length, as iMessage bubbles.
//   lm/group      a message in an iMessage group, from a known person or not.
//   lm/callbacks  LoopMessage's callbacks for a row of 1-4 bubbles: message_sent, message_failed, message_timeout,
//                 message_scheduled and message_reaction (both carry text), repeated and out of order.
//   lm/nokey      LOOPMESSAGE_API_KEY missing: the webhook, the delivery run with and without the other channels, then the
//                 key set.
//   x/two         a person on two or three channels at once, writing on each in turn, with answers in parts, proactive
//                 messages and LoopMessage's daily contact cap reached.
//   x/home        the home channel switched while messages wait (queued, and held by WhatsApp's window).
//   x/link        a second channel linked mid-conversation (the same number on WhatsApp, a Telegram link) while an answer in
//                 parts is going out.
//   x/delete      a channel let go (Telegram unlinked, a WhatsApp number now someone else's) while messages wait for it.
//   fmt/cross     crossing emphasis (**a *b** c*) and its kin, on every channel.
//   tg/429        Telegram's 429 on message 2+ of a row asking for more than 30 s, once or twice.

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
export type R = ReturnType<typeof rng>;
export const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: R, p: number) => r() < p;
export const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const shuffle = <T>(r: R, xs: T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export type Ch = "telegram" | "whatsapp" | "imessage";
export const T0 = Date.parse("2026-10-30T15:00:00Z");
export const MIN = 60000, HOUR = 3600000, DAY = 86400000;
// Trainee's window: WhatsApp's 24 hours less a 10-minute margin (channel_adapters.ts WHATSAPP_WINDOW_MS, WO-038).
export const META_WINDOW = 24 * HOUR, TRAINEE_WINDOW = 24 * HOUR - 10 * MIN;

const WORDS = ["data", "analyst", "role", "Acme", "Chicago", "remote", "salary", "interview", "Python", "SQL", "team", "hiring", "offer", "Friday",
  "recruiter", "onsite", "Seattle", "Toronto", "benefits", "deadline", "tailored", "manager", "week", "next"];
const UCS = ["résumé", "Müller", "東京", "データ", "🚀", "👍🏽", "🇺🇸", "👩‍💻", "it’s", "“great”", "Łódź", "İstanbul", "naïve", "café", "€120k"];
export const words = (r: R, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");
const sentence = (r: R, ucs: boolean) => { const w = Array.from({ length: int(r, 5, 14) }, () => (ucs && chance(r, 0.25) ? pick(r, UCS) : pick(r, WORDS))); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(" ")}.`; };

export type Scenario = { id: number; category: string } & (
  | { kind: "wa_window"; lagMs: number; gapMs: number; template: boolean; proactive: number }
  | { kind: "wa_template"; held: number; others: number; name: string; language: string; optedOut: boolean; nudgedBefore: boolean }
  | { kind: "wa_media"; type: string; known: boolean; voice: boolean; caption: string | null; windowClosed: boolean }
  | { kind: "wa_status"; bubbles: number; failAt: number; code: number; events: { kind: "sent" | "delivered" | "read" | "failed"; bubble: number }[]; lateCopy: boolean }
  | { kind: "wa_owner"; mode: "new_owner" | "moved"; others: Ch[]; signupOpen: boolean; held: number; queued: number; partsQueued: number }
  | { kind: "wa_bsuid"; stored: "wa_id" | "bsuid" | "both"; sends: "wa_id" | "bsuid" | "both"; neighbours: number }
  | { kind: "wa_errors"; bubbles: number; failAt: number; mode: string }
  | { kind: "lm_sms"; text: string; word: string; sms: boolean | null }
  | { kind: "lm_segments"; text: string; ucs: boolean; native: boolean }
  | { kind: "lm_group"; known: boolean; shape: "object" | "id"; text: string }
  | { kind: "lm_callbacks"; bubbles: number; events: { alert: string; bubble: number; withText: boolean; casing: "lower" | "upper" }[] }
  | { kind: "lm_nokey"; others: Ch[]; rows: number; inbound: boolean }
  | { kind: "x_two"; channels: Ch[]; home: Ch | null; msgs: { ch: Ch; parts: number; at: number }[]; proactive: number; capped: boolean }
  | { kind: "x_home"; channels: Ch[]; from: Ch; to: Ch; queued: number; held: number; replies: number }
  | { kind: "x_link"; how: "phone" | "telegram"; partsInFlight: number; proactiveAfter: number }
  | { kind: "x_delete"; what: "telegram" | "whatsapp"; others: Ch[]; bound: number; parts: number; unbound: number; held: number; relinkedToOther: boolean }
  | { kind: "fmt_cross"; md: string; vis: string; channel: Ch }
  | { kind: "tg_429"; bubbles: number; failAt: number; retryAfter: number; times: number }
);

// ------------------------------------------------------------------------------------------------ the families
const LAGS = [0, 1000, 5 * MIN, 2 * HOUR, 9 * HOUR, 20 * HOUR, 25 * HOUR, -2 * MIN, -HOUR];
const GAPS = [TRAINEE_WINDOW - 1, TRAINEE_WINDOW, TRAINEE_WINDOW + 1, META_WINDOW - 1, META_WINDOW, META_WINDOW + 1, 23 * HOUR, 12 * HOUR, MIN, 30 * HOUR, 47 * HOUR];
function waWindow(r: R, id: number): Scenario {
  const lagMs = pick(r, LAGS), gapMs = chance(r, 0.7) ? pick(r, GAPS) : int(r, 0, 30 * HOUR);
  return { id, category: `wa/window/${lagMs > 0 ? "late-webhook" : lagMs < 0 ? "clock-ahead" : "on-time"}`, kind: "wa_window", lagMs, gapMs: Math.max(gapMs, Math.max(0, lagMs) + 1000), template: chance(r, 0.6), proactive: int(r, 1, 3) };
}
const NAMES = ["updates_waiting", " updates_waiting ", "updates_waiting\n", "Updates_Waiting", "trainee_updates_v2"];
const LANGS = ["en_US", " en_US", "pt_BR", "es", "", "en_US\t"];
function waTemplate(r: R, id: number): Scenario {
  return { id, category: "wa/template", kind: "wa_template", held: int(r, 1, 40), others: int(r, 0, 3), name: pick(r, NAMES), language: pick(r, LANGS), optedOut: chance(r, 0.15), nudgedBefore: chance(r, 0.2) };
}
const MEDIA = ["audio", "voice", "video", "image", "document", "sticker", "reaction", "location", "contacts", "unsupported", "button", "interactive"];
function waMedia(r: R, id: number): Scenario {
  const type = pick(r, MEDIA);
  return { id, category: `wa/media/${type}`, kind: "wa_media", type, known: chance(r, 0.8), voice: type === "voice", caption: (type === "image" || type === "document") && chance(r, 0.3) ? words(r, 3) : null, windowClosed: chance(r, 0.5) };
}
const STATUS_CODES = [131047, 131049, 130429, 131026, 131000, 131051];
function waStatus(r: R, id: number): Scenario {
  const bubbles = int(r, 1, 4), failAt = int(r, 0, bubbles - 1), code = pick(r, STATUS_CODES);
  const events: { kind: "sent" | "delivered" | "read" | "failed"; bubble: number }[] = [];
  for (let b = 0; b < bubbles; b++) {
    events.push({ kind: "sent", bubble: b });
    if (b < failAt) { events.push({ kind: "delivered", bubble: b }); if (chance(r, 0.5)) events.push({ kind: "read", bubble: b }); }
    else { events.push({ kind: "failed", bubble: b }); if (chance(r, 0.3)) events.push({ kind: "failed", bubble: b }); }
  }
  return { id, category: `wa/status/${code}`, kind: "wa_status", bubbles, failAt, code, events: shuffle(r, events), lateCopy: chance(r, 0.6) };
}
function waOwner(r: R, id: number): Scenario {
  const mode = chance(r, 0.6) ? "new_owner" as const : "moved" as const;
  const others = shuffle(r, ["imessage", "telegram"] as Ch[]).slice(0, pick(r, [0, 0, 1, 1, 2]));
  return { id, category: `wa/owner/${mode}/${others.length ? "other-channel" : "only-whatsapp"}`, kind: "wa_owner", mode, others, signupOpen: chance(r, 0.4), held: int(r, 0, 2), queued: int(r, 0, 3), partsQueued: pick(r, [0, 0, 2, 3]) };
}
function waBsuid(r: R, id: number): Scenario {
  return { id, category: "wa/bsuid", kind: "wa_bsuid", stored: pick(r, ["wa_id", "bsuid", "both"] as const), sends: pick(r, ["wa_id", "bsuid", "both"] as const), neighbours: int(r, 1, 3) };
}
const WA_MODES = ["131047", "131049", "131026", "130429", "131056", "80007", "429", "500", "502", "503", "timeout", "network"];
function waErrors(r: R, id: number): Scenario {
  const bubbles = int(r, 1, 4), failAt = int(r, 0, bubbles - 1), mode = pick(r, WA_MODES);
  return { id, category: `wa/errors/${failAt ? "later" : "first"}`, kind: "wa_errors", bubbles, failAt, mode };
}
// The words a person may text, and what they are. Everywhere: STOP, STOPALL, UNSUBSCRIBE, OPT OUT (optout, opt-out); START,
// UNSTOP; HELP, INFO. On SMS only: CANCEL, END, QUIT, REVOKE (the FCC's 2025 revocation words), ARRET / ARRÊT (Canada),
// PARAR, BAJA, CANCELAR (Spanish); AIDE, AYUDA (help).
export const EVERYWHERE: Record<string, "stop" | "start" | "help"> = { stop: "stop", stopall: "stop", unsubscribe: "stop", optout: "stop", "opt out": "stop", "opt-out": "stop", start: "start", unstop: "start", help: "help", info: "help" };
export const SMS_WORDS: Record<string, "stop" | "start" | "help"> = { cancel: "stop", end: "stop", quit: "stop", revoke: "stop", arret: "stop", "arrêt": "stop", parar: "stop", baja: "stop", cancelar: "stop", aide: "help", ayuda: "help" };
const NOT_COMMANDS = ["stop sending me sales jobs", "cancel my interview", "end", "help me with my resume", "opt out of alerts please", "arrêt de bus", "parar aqui", "baja california jobs", "revoke gmail"];
function lmSms(r: R, id: number): Scenario {
  const sms = pick(r, [true, true, false, null] as const);
  if (chance(r, 0.15)) { const t = pick(r, NOT_COMMANDS); return { id, category: "lm/sms/message", kind: "lm_sms", text: t, word: t, sms }; }
  const word = pick(r, [...Object.keys(EVERYWHERE), ...Object.keys(SMS_WORDS), ...Object.keys(SMS_WORDS)]);
  const cased = pick(r, [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)]);
  const text = pick(r, [(w: string) => w, (w: string) => `${w}.`, (w: string) => ` ${w} `, (w: string) => `“${w}”`, (w: string) => `${w}!`, (w: string) => `¡${w}!`, (w: string) => `${w}​`])(cased);
  return { id, category: `lm/sms/${sms === true ? "sms" : sms === false ? "imessage" : "unsaid"}`, kind: "lm_sms", text, word, sms };
}
function lmSegments(r: R, id: number): Scenario {
  const ucs = chance(r, 0.5), n = pick(r, [1, 2, 4, 8, 16, 30]);
  const paras: string[] = [];
  for (let i = 0; i < n; i++) paras.push(Array.from({ length: int(r, 1, 4) }, () => sentence(r, ucs)).join(" "));
  return { id, category: `lm/segments/${ucs ? "ucs2" : "gsm7"}`, kind: "lm_segments", text: paras.join(chance(r, 0.5) ? "\n\n" : " "), ucs, native: chance(r, 0.5) };
}
function lmGroup(r: R, id: number): Scenario {
  return { id, category: "lm/group", kind: "lm_group", known: chance(r, 0.7), shape: pick(r, ["object", "id"] as const), text: pick(r, ["find me jobs", "STOP", "yes", words(r, 4)]) };
}
const ALERTS = ["message_sent", "message_failed", "message_timeout", "message_scheduled", "message_reaction", "message_delivered", "message_read"];
function lmCallbacks(r: R, id: number): Scenario {
  const bubbles = int(r, 1, 4), events: { alert: string; bubble: number; withText: boolean; casing: "lower" | "upper" }[] = [];
  for (let i = 0, n = int(r, 1, 5); i < n; i++) events.push({ alert: pick(r, ALERTS), bubble: int(r, 0, bubbles - 1), withText: chance(r, 0.8), casing: chance(r, 0.85) ? "lower" : "upper" });
  if (chance(r, 0.4) && events.length) events.push({ ...events[0] }); // the same callback delivered again
  return { id, category: `lm/callbacks/${events.some((e) => /fail|timeout/.test(e.alert)) ? "failed" : "other"}`, kind: "lm_callbacks", bubbles, events };
}
function lmNokey(r: R, id: number): Scenario {
  const others = shuffle(r, ["telegram", "whatsapp"] as Ch[]).slice(0, int(r, 0, 2));
  return { id, category: `lm/nokey/${others.length ? "others" : "alone"}`, kind: "lm_nokey", others, rows: int(r, 1, 3), inbound: chance(r, 0.6) };
}
function xTwo(r: R, id: number): Scenario {
  const channels = shuffle(r, ["imessage", "whatsapp", "telegram"] as Ch[]).slice(0, int(r, 2, 3));
  const msgs: { ch: Ch; parts: number; at: number }[] = [];
  let at = 0;
  for (let i = 0, n = int(r, 2, 6); i < n; i++) { at += pick(r, [0, 1000, 30000, 2 * MIN, 10 * MIN]); msgs.push({ ch: pick(r, channels), parts: pick(r, [1, 1, 1, 2, 3, 5]), at }); }
  return { id, category: `x/two/${channels.length}`, kind: "x_two", channels, home: chance(r, 0.4) ? pick(r, channels) : null, msgs, proactive: int(r, 0, 3), capped: channels.includes("imessage") && chance(r, 0.3) };
}
function xHome(r: R, id: number): Scenario {
  const channels = shuffle(r, ["imessage", "whatsapp", "telegram"] as Ch[]).slice(0, int(r, 2, 3));
  const from = chance(r, 0.6) && channels.includes("whatsapp") ? "whatsapp" as Ch : pick(r, channels);
  const to = pick(r, channels.filter((c) => c !== from));
  return { id, category: `x/home/${from}->${to}`, kind: "x_home", channels, from, to, queued: int(r, 0, 3), held: from === "whatsapp" ? int(r, 1, 3) : 0, replies: int(r, 0, 2) };
}
function xLink(r: R, id: number): Scenario {
  return { id, category: `x/link/${chance(r, 0.5) ? "phone" : "telegram"}`, kind: "x_link", how: chance(r, 0.5) ? "phone" : "telegram", partsInFlight: int(r, 2, 6), proactiveAfter: int(r, 0, 2) };
}
function xDelete(r: R, id: number): Scenario {
  const what = chance(r, 0.6) ? "telegram" as const : "whatsapp" as const;
  const pool: Ch[] = what === "telegram" ? ["imessage", "whatsapp"] : ["imessage", "telegram"];
  const others = shuffle(r, pool).slice(0, pick(r, [0, 1, 1, 2]));
  return { id, category: `x/delete/${what}/${others.length ? "other-channel" : "no-other"}`, kind: "x_delete", what, others, bound: int(r, 0, 2), parts: pick(r, [0, 2, 3, 4]), unbound: int(r, 0, 2), held: what === "whatsapp" ? int(r, 0, 2) : 0, relinkedToOther: what === "telegram" && chance(r, 0.3) };
}
// Crossing emphasis: an opener inside, its closer after the outer one's.
const PAIRS: [string, string][] = [["**", "*"], ["*", "**"], ["__", "_"], ["_", "__"], ["~~", "**"], ["**", "_"], ["__", "*"], ["~~", "*"]];
function fmtCross(r: R, id: number): Scenario {
  const [a, b] = pick(r, PAIRS), w = () => words(r, int(r, 1, 3));
  const x = w(), y = w(), z = w(), pre = chance(r, 0.5) ? `${w()} ` : "", post = chance(r, 0.5) ? ` ${w()}` : "";
  const md = `${pre}${a}${x} ${b}${y}${a} ${z}${b}${post}`, vis = `${pre}${x} ${y} ${z}${post}`;
  return { id, category: `fmt/cross/${a}${b}`, kind: "fmt_cross", md, vis, channel: pick(r, ["imessage", "whatsapp", "telegram"] as Ch[]) };
}
function tg429(r: R, id: number): Scenario {
  const bubbles = int(r, 2, 6);
  return { id, category: `tg/429/${chance(r, 0.5) ? "a" : "b"}`, kind: "tg_429", bubbles, failAt: int(r, 1, bubbles - 1), retryAfter: pick(r, [31, 45, 61, 120, 300]), times: pick(r, [1, 1, 2]) };
}

export const PLAN: [Scenario["kind"], number, (r: R, id: number) => Scenario][] = [
  ["wa_window", 1000, waWindow], ["wa_template", 500, waTemplate], ["wa_media", 500, waMedia], ["wa_status", 1000, waStatus], ["wa_owner", 400, waOwner],
  ["wa_bsuid", 400, waBsuid], ["wa_errors", 600, waErrors], ["lm_sms", 600, lmSms], ["lm_segments", 400, lmSegments], ["lm_group", 300, lmGroup],
  ["lm_callbacks", 600, lmCallbacks], ["lm_nokey", 300, lmNokey], ["x_two", 1000, xTwo], ["x_home", 600, xHome], ["x_link", 500, xLink],
  ["x_delete", 700, xDelete], ["fmt_cross", 600, fmtCross], ["tg_429", 600, tg429],
];
export function generate(o: { seed: number }): Scenario[] {
  const r = rng(o.seed), out: Scenario[] = [];
  let id = 0;
  for (const [, n, f] of PLAN) for (let i = 0; i < n; i++) out.push(f(r, ++id));
  return out;
}
