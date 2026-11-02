// REQS DOC 2 (reminders and follow-ups): a reminder the person sets in chat, kept and delivered like every other proactive
// text. Before this, "remind me to send my transcript to Acme tomorrow" got "I don't run reminders", and nothing the
// person said about a date ever came back to them.
//   set     "remind me to X <when>", "remind me <when> to X", "set a reminder for <when> to X": one career_outbox row
//           (kind status, key status:reminder:<id>, deliver_at the time asked: the outbox's existing kind for a note Trainee
//           sends the person, so no migration is needed), delivered by the texting channel's own run (channel.ts deliverDue)
//           to the conversation the person texts from. The reply says the exact text and the exact time it will arrive, and
//           names any assumption (a time picked because none was said, the zone used when none is on file); a time inside
//           their quiet hours is held by delivery to the end of them, and the reply says that too. A time already past,
//           more than a year away, or not understood is said so; nothing is saved.
//   list    "what reminders do I have", "my reminders": every reminder not yet sent, numbered, each with its time.
//   cancel  "cancel reminder 2", "cancel my reminder about Acme", "cancel all my reminders", "stop reminding me": the
//           rows not yet sent are removed, and the reply names each one removed (or says none matched; nothing removed).
// The reminder text carries the request back: what they asked, when they asked it and the time it was set for, so a
// reminder read late or out of context still says what it is. Delivery keeps every hold the channel has: a pause, STOP
// or an erased account sends nothing. Nothing here sends anything to anyone but the person.
// Without a texting channel linked there is no way to deliver one, so none is saved and the reply says how to link one.
import { DEFAULT_PREFS, DEFAULT_ZONE, nextAwake, quietAt, zoneOr } from "./career_alerts.ts";
import { trackAsk } from "./career_outreach_track.ts";
import { WHATSAPP_WINDOW_MS } from "./channel_adapters.ts";

export const REMINDER_SET_INTENT = "career_reminder_set";
export const REMINDER_LIST_INTENT = "career_reminder_list";
export const REMINDER_CANCEL_INTENT = "career_reminder_cancel";
export const REMINDER_ASK_INTENT = "career_reminder_when";
const MAX_WHAT = 300, YEAR = 366 * 86_400_000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export interface ReminderRow { key: string; text: string; at: number; created?: number }
export const REMINDER_PREFIX = "status:reminder:";
export interface ReminderSettings { tz: string | null; quiet_start: number; quiet_end: number }
export interface ReminderStore {
  settings(userId: string): Promise<ReminderSettings>; // their saved zone (career_alert_prefs.tz; null: none on file) and quiet hours
  reachable(userId: string): Promise<boolean>; // a texting contact that is not opted out
  // RE-REVIEW (PR #355): paused, opted out or erased (career_user_quiet): delivery skips every row then and nothing resumes
  // it, so no reminder is saved. And the contact delivery would use (channel_target), for WhatsApp's 24-hour window.
  paused?(userId: string): Promise<boolean>;
  target?(userId: string): Promise<{ contact: string; lastInboundAt: number | null } | null>;
  add(userId: string, r: ReminderRow): Promise<boolean>; // false: that key exists already
  pending(userId: string): Promise<ReminderRow[]>; // not yet sent, soonest first
  remove(userId: string, keys: string[]): Promise<number>; // only rows not yet sent; the count removed
  networking(userId: string): Promise<boolean>; // any networking email on record (career_outreach_drafts): its turn owns its reminders
}

// ------------------------------------------------------------------------------------------------ the asks
export type ReminderAsk =
  | { kind: "set"; what: string; when: string }
  | { kind: "when"; what: string } // a reminder with no time: asked once, nothing saved
  | { kind: "repeat"; what: string; every: string } // a repeating reminder: not supported, said so, nothing saved
  | { kind: "list" }
  | { kind: "cancel"; which: { all: true } | { n: number } | { about: string } | { last: true } };

const norm = (s: string) => String(s ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const LIST = /^(?:so )?(?:what|which|any|do i have any|show(?: me)?|list|see)? ?(?:are )?(?:my |the )?(?:upcoming |pending |active |current )?reminders?(?: do i have| have i set| are set| are there| set| pending| coming up)?(?: right now| now)?$/i;
const CANCEL_ALL = /^(?:please )?(?:cancel|delete|remove|clear|drop) (?:all|every one of|all of) (?:my |the )?reminders?$|^stop (?:all )?reminding me$|^(?:cancel|delete|remove|clear) (?:my |the )?reminders$/i;
const CANCEL_N = /^(?:please )?(?:cancel|delete|remove|drop) (?:my |the )?reminder (?:#|number |no\.? )?(\d{1,2})$/i;
const CANCEL_ABOUT = /^(?:please )?(?:cancel|delete|remove|drop) (?:my |the )?reminder (?:about|for|to|on) (.+)$|^stop reminding me (?:about|to) (.+)$/i;
const CANCEL_LAST = /^(?:please )?(?:cancel|delete|remove|drop|undo) (?:my |that |the )?(?:last |latest )?reminder$/i;
// A question about the past ("remind me what you found", "remind me why I passed on Acme") is a recall, never a reminder.
const RECALL = /^(?:what|who|which|where|why|how|when (?:did|was|were|is|are|do)|if|whether|of\b)/i;

// The when-phrase at the start or the end of the rest of the sentence.
const N_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty five": 45, "forty-five": 45, half: 0.5 };
const NUM = String.raw`(?:\d{1,3}(?:\.\d)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty[- ]five|half an?)`;
const UNIT = String.raw`(?:min(?:ute)?s?|hours?|hrs?|days?|weeks?)`;
const WEEKDAY = String.raw`(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
// RE-REVIEW 2 (PR #355): also 24-hour "0900"/"1530", "9.30", "half past 3", "quarter to 9", "8 o'clock".
const CLOCK = String.raw`(?:(?:half|quarter) (?:past|after|to|til) \d{1,2}|\d{1,2} ?o'?clock|(?:[01]\d|2[0-3])[0-5]\d|\d{1,2}(?:[:.]\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.)|[ap]\b)?|noon|midnight)`;
// Anything in a message that names a time of day. A default time (9 AM, or a part of the day's hour) is used only when
// the message has none of these: one the parser could not place is asked about, never saved as 9 AM (RE-REVIEW 2).
const TIMELIKE = /\b(?:\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}[ap]\b|\d{1,2}\s*ish|\d{1,2} ?o'?clock|o'?clock|half past|quarter (?:past|after|to|til)|(?:at|around|by) \d{1,4}\b|noon|midnight)/i;
// Something time-like left at the start of the reminder's text ("8ish to ...", "9.30 to ...", "o'clock to ..."): a time
// that could not be read. Asked, never saved as 9 AM with the time in the text (RE-REVIEW, PR #355).
const TIMEISH = /^(?:(?:at|around|by) )?(?:\d{1,2}(?:[:.]\d+)?[a-z.']*|\d{1,2} ?o'?clock|o'?clock|ish)(?=,? (?:to|about|that) |$)/i;
const PART = String.raw`(?:morning|afternoon|evening|night|tonight)`;
const ZONE = String.raw`(?:(?:chicago|central|eastern|pacific|mountain|new york|los angeles|denver|phoenix|london|ct|et|pt|mt|cst|cdt|est|edt|pst|pdt|mst|mdt|utc|gmt)(?: time)?)`;
const DAYWORD = String.raw`(?:today|tonight|tomorrow|tmrw|tmr|(?:on |this |next )?${WEEKDAY}|(?:on )?${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?|(?:on )?\d{1,2}\/\d{1,2})`;
// A day may carry both a part of the day and a clock ("tomorrow morning at 7"): the clock is the time, the part says am or pm.
const SLOT = String.raw`(?:,? (?:at |around |by )?(?:${CLOCK}|${PART}))`;
const WHEN = String.raw`(?:in ${NUM} ${UNIT}(?: and ${NUM} ${UNIT})?|(?:${DAYWORD})${SLOT}?${SLOT}?|(?:at |around |by )(?:${CLOCK})(?: (?:today|tonight|tomorrow|tmrw|(?:on |this |next )?${WEEKDAY}))?(?: ${PART})?|(?:this|tomorrow|${WEEKDAY}) ${PART}${SLOT}?|tonight)(?:,? ${ZONE})?`;
const WHEN_END = new RegExp(String.raw`^(.+?),? (${WHEN})$`, "i");
const WHEN_START = new RegExp(String.raw`^(${WHEN})[,:]? (?:to |about |that )?(.+)$`, "i");
const LEAD = /^(?:(?:hey|hi|ok|okay|so|please|pls|trainee)[,!]? )*(?:(?:can|could|would|will) you (?:please )?)?(?:remind me|set (?:a|me a) reminder|reminder:?|make a reminder|add a reminder)(?: for\b)?,? ?/i;
// REVIEW (PR #355): the lead swallowed "at" and "on", so "remind me at 3pm to call Acme" was not read. They stay with the
// time now; only "for" is dropped ("set a reminder for 3pm to ..." reads as "at 3pm").
// A repeating reminder ("every Friday", "daily", "on Mondays"): not supported. Read whole, so "call mom every Friday" is never
// saved as one reminder saying "call mom every".
const REPEAT = new RegExp(String.raw`\b(?:every (?:single )?(?:day|night|morning|afternoon|evening|week|weekday|weekend|month|year|hour|other ${WEEKDAY}|other \w+|\d+ ${UNIT}|${NUM} ${UNIT}|${WEEKDAY})|each (?:day|night|morning|afternoon|evening|week|weekday|month|${WEEKDAY})|daily|nightly|weekly|monthly|(?:on )?(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b`, "i");

export function reminderAsk(message: string): ReminderAsk | null {
  const t = norm(message).replace(/[?!.]+$/, "").trim();
  if (!t || t.length > 600) return null;
  const low = t.toLowerCase();
  if (CANCEL_ALL.test(low)) return { kind: "cancel", which: { all: true } };
  const n = CANCEL_N.exec(low);
  if (n) return { kind: "cancel", which: { n: Number(n[1]) } };
  const about = CANCEL_ABOUT.exec(t);
  if (about) return { kind: "cancel", which: { about: (about[1] ?? about[2]).trim() } };
  if (CANCEL_LAST.test(low)) return { kind: "cancel", which: { last: true } };
  if (/reminders?/.test(low) && LIST.test(low)) return { kind: "list" };
  const lead = LEAD.exec(t);
  if (!lead) return null;
  // An intro's own nudge ("remind me about intro 2 in 3 days", "... if no reply") is the people turn's (career_people.ts).
  if (/\bintro(?:duction)?\s*#?\d|\bif (?:there'?s |i get )?no (?:reply|response|answer)\b/i.test(t)) return null;
  let rest = t.slice(lead[0].length).trim();
  // A bare "remind me" / "set a reminder" is a reminder with nothing said yet: asked once (the router's line says reminders
  // do not exist, so it must never get this turn).
  if (!rest) return { kind: "when", what: "" };
  if (RECALL.test(rest)) return null;
  const rep = REPEAT.exec(rest);
  if (rep) {
    const left = norm(rest.slice(0, rep.index) + " " + rest.slice(rep.index + rep[0].length)).replace(/^(?:to|about|that|of) /i, "");
    const s2 = WHEN_START.exec(left), e2 = WHEN_END.exec(left);
    const what = s2 && !/^(?:to|about|that)$/i.test(s2[2]) ? s2[2] : e2 ? e2[1] : left;
    return { kind: "repeat", what: clean(what.replace(/^(?:to|about|that|of) /i, "")), every: rep[0].toLowerCase() };
  }
  if (/^(?:\d|noon\b|midnight\b|(?:half|quarter) (?:past|after|to|til) \d)/i.test(rest)) rest = `at ${rest}`;
  const start = WHEN_START.exec(rest);
  if (start && !/^(?:to|about|that)$/i.test(start[2])) return set(start[2], start[1]);
  rest = rest.replace(/^(?:to|about|that|of) /i, "");
  const end = WHEN_END.exec(rest);
  if (end) return set(end[1], end[2]);
  // A time that could not be read ("at 8ish to ...", "at 9.30am. to ..."): asked when, never left to the general reply.
  if (TIMELIKE.test(rest)) return { kind: "when", what: clean(untimed(rest)) };
  // "remind me about the Acme interview" with no time: a reminder, asked when; "remind me what ..." returned above.
  return /^(?:me )?(?:to|about) /i.test(t.slice(lead[0].length).trim()) || /remind me (?:to|about) /i.test(t) ? { kind: "when", what: clean(rest) } : null;
}
function set(what: string, when: string): ReminderAsk {
  const odd = TIMEISH.exec(what.trim());
  if (odd) return { kind: "when", what: clean(what.trim().slice(odd[0].length).replace(/^,? (?:to|about|that) /i, "")) };
  return { kind: "set", what: clean(what.replace(/^(?:to|about|that|of) /i, "")), when: when.trim() };
}
// The text with a leading time phrase that could not be read taken off ("at 8ish to call Acme" -> "call Acme").
const untimed = (s: string) => s.replace(/^(?:(?:at|around|by) )?\S*\d\S*(?: ?o'?clock)?,?:? (?:to |about |that )?/i, "").replace(/^(?:(?:at|around|by) )?(?:half past|quarter (?:past|after|to|til)) \S+,? (?:to |about |that )?/i, "");
const clean = (s: string) => norm(s).replace(/^(?:to|about|that) /i, "").replace(/[,;:]+$/, "").slice(0, MAX_WHAT);

// ------------------------------------------------------------------------------------------------ the time
const ZONES: [RegExp, string][] = [
  [/^(?:chicago|central|ct|cst|cdt)$/, "America/Chicago"], [/^(?:eastern|new york|et|est|edt)$/, "America/New_York"],
  [/^(?:pacific|los angeles|pt|pst|pdt)$/, "America/Los_Angeles"], [/^(?:mountain|denver|mt|mst|mdt)$/, "America/Denver"],
  [/^phoenix$/, "America/Phoenix"], [/^london$/, "Europe/London"], [/^(?:utc|gmt)$/, "UTC"],
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parts(at: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) };
}
// The instant a local wall time names in a zone (a time skipped by a daylight-saving jump moves forward to one that exists).
export function zonedInstant(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(t, tz);
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return t;
}
type Clock = { h: number; mi: number; bare?: boolean; am?: boolean };
// bare: an hour from 1 to 12 with no am or pm (which of the two is settled by the words around it, or said).
function clockOf(s: string): Clock | null {
  const c = s.toLowerCase().replace(/(\d)\.(\d)/g, "$1:$2").replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (c === "noon") return { h: 12, mi: 0 };
  if (c === "midnight") return { h: 0, mi: 0 };
  const hhmm = /^([01]\d|2[0-3])([0-5]\d)$/.exec(c); // 24-hour "0900", "1530": no am or pm to settle
  if (hhmm) return { h: +hhmm[1], mi: +hhmm[2] };
  const oc = /^(\d{1,2}) ?o'?clock$/.exec(c);
  if (oc) return +oc[1] >= 1 && +oc[1] <= 12 ? { h: +oc[1], mi: 0, bare: true } : null;
  const q = /^(half|quarter) (past|after|to|til) (\d{1,2})$/.exec(c);
  if (q) {
    const n = +q[3];
    if (n < 1 || n > 12) return null;
    if (q[2] === "to" || q[2] === "til") return { h: n === 1 ? 12 : n - 1, mi: q[1] === "half" ? 30 : 45, bare: true };
    return { h: n, mi: q[1] === "half" ? 30 : 15, bare: true };
  }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(c);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  const sfx = m[3] ? (m[3][0] === "a" ? "am" : "pm") : null;
  if (sfx && (h < 1 || h > 12)) return null; // "13pm", "0am"
  if (sfx === "pm" && h < 12) h += 12;
  if (sfx === "am" && h === 12) h = 0;
  return { h, mi, bare: !sfx && h >= 1 && h <= 12, am: sfx === "am" };
}
const ampm = (h: number, mi: number) => `${h % 12 || 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const PART_HOURS: Record<string, number> = { morning: 9, afternoon: 14, evening: 18, night: 20, tonight: 20 };

// defaulted: no time of day was said, and one was picked (9 AM, or a part of the day's hour).
export type When = { at: number; zone: string; assumed: string[]; defaulted?: boolean } | { error: string };
// The instant a when-phrase names, from now, in the zone it names, else their saved zone, else the default (said so).
export function whenOf(phrase: string, now: number, saved: string | null): When {
  let p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const assumed: string[] = [];
  let zone: string | null = null;
  const z = new RegExp(String.raw`,? (${ZONE})$`, "i").exec(p);
  if (z) {
    const name = z[1].replace(/ time$/, "");
    zone = ZONES.find(([re]) => re.test(name))?.[1] ?? null;
    p = p.slice(0, z.index).trim();
  }
  if (!zone) {
    const s = saved ? zoneOr(saved, "") : "";
    if (s) zone = s;
    else { zone = DEFAULT_ZONE; assumed.push(`Eastern time, since I don't have your time zone (say it with the time, like "at 9am Chicago time", to change it)`); }
  }
  const rel = new RegExp(String.raw`^in (${NUM}) (${UNIT})(?: and (${NUM}) (${UNIT}))?$`).exec(p);
  if (rel) {
    const amount = (n: string) => (/^\d/.test(n) ? Number(n) : N_WORDS[n.replace(/ an?$/, "")] ?? N_WORDS[n] ?? NaN);
    const unit = (u: string) => (/^min/.test(u) ? MIN : /^(?:hour|hr)/.test(u) ? HOUR : /^day/.test(u) ? DAY : 7 * DAY);
    let ms = amount(rel[1]) * unit(rel[2]);
    if (rel[3]) ms += amount(rel[3]) * unit(rel[4]);
    if (!Number.isFinite(ms) || ms < MIN) return { error: "I couldn't read that amount of time" };
    return { at: Math.round((now + ms) / MIN) * MIN, zone, assumed: [] }; // a span needs no zone
  }
  const today = parts(now, zone);
  let day: { y: number; m: number; d: number } | null = null, clock: { h: number; mi: number } | null = null, dayNamed = false;
  const take = (re: RegExp, f: (m: RegExpExecArray) => void) => { const m = re.exec(p); if (m) { f(m); p = (p.slice(0, m.index) + " " + p.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); } return !!m; };
  const plus = (n: number) => { const t = new Date(Date.UTC(today.y, today.m - 1, today.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
  let tonight = false, part: string | null = null;
  take(/\b(today|tonight)\b/, (m) => { day = plus(0); dayNamed = true; tonight = m[1] === "tonight"; });
  take(/\b(tomorrow|tmrw|tmr)\b/, () => { day = plus(1); dayNamed = true; });
  take(new RegExp(String.raw`\b(?:on |this |(next) )?(${WEEKDAY})\b`), (m) => {
    const wd = DAYS.indexOf(m[2].slice(0, 3));
    let n = (wd - today.wd + 7) % 7;
    // RE-REVIEW (PR #355): "next Tuesday" is the Tuesday of next week, 7 to 13 days away, said with its date ("Tuesday" or
    // "this Tuesday" is the coming one).
    if (m[1] === "next") {
      if (n < 7) n += 7;
      const d = plus(n);
      assumed.push(`next ${m[2]} as ${new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}, the one next week`);
    }
    day = plus(n); dayNamed = true;
  });
  take(new RegExp(String.raw`\b(?:on )?(${MONTH})\.? (\d{1,2})(?:st|nd|rd|th)?\b`), (m) => {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1, d = +m[2];
    const y = mo < today.m || (mo === today.m && d < today.d) ? today.y + 1 : today.y;
    day = { y, m: mo, d }; dayNamed = true;
  });
  take(/\b(?:on )?(\d{1,2})\/(\d{1,2})\b/, (m) => {
    const mo = +m[1], d = +m[2];
    const y = mo < today.m || (mo === today.m && d < today.d) ? today.y + 1 : today.y;
    day = { y, m: mo, d }; dayNamed = true;
  });
  // The day first (a date's number is never read as a clock time), then the part of the day, then the clock.
  take(new RegExp(String.raw`\b(?:this )?(${PART})\b`), (m) => { part = m[1]; if (m[1] === "tonight") { day = plus(0); dayNamed = true; tonight = true; } });
  take(/\b(?:at|around|by) /, () => {});
  let badClock: string | null = null;
  take(new RegExp(String.raw`\b(${CLOCK})(?=$| )`), (m) => { const c = clockOf(m[1]); if (c) clock = c; else badClock = m[1]; });
  // RE-REVIEW (PR #355): "25:00" or "9:75" was dropped and 9 AM saved "since you didn't say a time".
  if (badClock) return { error: `"${badClock}" isn't a valid time` };
  if (p.replace(/[ ,]/g, "")) return { error: `I couldn't read "${phrase}" as a time` };
  const c0 = clock as Clock | null;
  if (!c0 && !dayNamed && !part) return { error: `I couldn't read "${phrase}" as a time` };
  const late = tonight || part === "night" || part === "evening" || part === "afternoon";
  let hm: { h: number; mi: number }, nextDay = false;
  if (!c0) {
    hm = part ? { h: PART_HOURS[part], mi: 0 } : tonight ? { h: 20, mi: 0 } : { h: 9, mi: 0 };
    if (!part && !tonight) assumed.unshift("9:00 AM, since you didn't say a time");
  } else if (tonight && (c0.h === 0 || (c0.bare && c0.h === 12) || (c0.am && c0.h < 6))) {
    // REVIEW (PR #355): "tonight at midnight" (or 12, or 12am, or 1am) is after midnight: the next day, never noon today.
    hm = { h: c0.bare && c0.h === 12 ? 0 : c0.h, mi: c0.mi }; nextDay = true;
  } else if (c0.bare && (late || part === "morning")) {
    hm = { h: late ? (c0.h % 12) + 12 : c0.h % 12, mi: c0.mi };
  } else if (c0.bare && dayNamed) {
    // A day with a bare hour: 1 to 7 is the afternoon or evening, 8 to 12 the morning or noon; said either way.
    hm = { h: c0.h <= 7 ? c0.h + 12 : c0.h, mi: c0.mi };
    assumed.unshift(`${ampm(hm.h, hm.mi)}, since you didn't say am or pm`);
  } else if (c0.bare) {
    // No day and no am or pm: the next time the clock reads that hour, said (REVIEW, PR #355).
    const cands = [c0.h % 12, (c0.h % 12) + 12].flatMap((h) => [0, 1].map((n) => { const d = plus(n); return { h, d, at: zonedInstant(d.y, d.m, d.d, h, c0.mi, zone!) }; }))
      .filter((x) => x.at > now).sort((a, b) => a.at - b.at);
    const pick = cands[0];
    hm = { h: pick.h, mi: c0.mi };
    day = pick.d;
    assumed.unshift(`${ampm(pick.h, c0.mi)} ${pick.d.d === today.d ? "today" : "tomorrow"}, the next ${c0.h}${c0.mi ? `:${String(c0.mi).padStart(2, "0")}` : " o'clock"} (say am or pm to change it)`);
  } else hm = { h: c0.h, mi: c0.mi };
  let dd = day as { y: number; m: number; d: number } | null;
  if (dd && nextDay) { const t = new Date(Date.UTC(dd.y, dd.m - 1, dd.d + 1)); dd = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  if (!dd) {
    // A time with no day: today if it is still ahead, else tomorrow (said, unless it is midnight).
    dd = plus(0);
    if (zonedInstant(dd.y, dd.m, dd.d, hm.h, hm.mi, zone) <= now) {
      dd = plus(1);
      if (hm.h || hm.mi) assumed.unshift(`tomorrow, since ${ampm(hm.h, hm.mi)} today has already passed`);
    }
  }
  if (dd.m < 1 || dd.m > 12 || dd.d < 1 || dd.d > 31 || new Date(Date.UTC(dd.y, dd.m - 1, dd.d)).getUTCDate() !== dd.d) return { error: `there is no such date as ${phrase}` };
  return { at: zonedInstant(dd.y, dd.m, dd.d, hm.h, hm.mi, zone), zone, assumed, ...(c0 ? {} : { defaulted: true }) };
}

// "Fri, Nov 1, 9:00 AM CDT"
export function whenLabel(at: number, zone: string): string {
  return new Date(at).toLocaleString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
const dayLabel = (at: number, zone: string) => new Date(at).toLocaleDateString("en-US", { timeZone: zone, month: "short", day: "numeric" });

// The text that arrives: what they asked for, in their words, when they asked and the time it was set for.
export function reminderText(what: string, setAt: number, at: number, zone: string): string {
  return `Reminder: ${what}. You asked me on ${dayLabel(setAt, zone)} to remind you at ${whenLabel(at, zone)}.`;
}
// The zone a reminder was set in rides on its key (status:reminder:<id>:<zone>), so its reply, its list line and the
// quiet-hours hold at delivery (channel.ts deliverDue) all use the one zone the person named. No migration needed.
export const reminderKey = (id: string, zone: string) => `${REMINDER_PREFIX}${id}:${zone}`;
export function reminderZone(key: string): string | null {
  const m = /^status:reminder:[^:]+:([A-Za-z0-9_+\-\/]+)$/.exec(key);
  return m ? zoneOr(m[1], "") || null : null;
}
const whatOf = (text: string) => (/^Reminder: (.*)\. You asked me on /.exec(text)?.[1] ?? text);

// ------------------------------------------------------------------------------------------------ the turn
export interface ReminderReply { reply: string; status: string; intent: string }
export async function reminderTurn(o: { message: string; userId: string; now: number; store: ReminderStore; newKey?: () => string }): Promise<ReminderReply | null> {
  const ask = reminderAsk(o.message);
  if (!ask) return null;
  // A networking follow-up reminder ("remind me to follow up with Maya in 3 days") is the networking turn's own
  // (career_outreach_track.ts): tied to the email they sent, and off when that person replies. A cancel it would also read
  // ("stop reminding me", "cancel the reminder about Maya") is this turn's only when it matches a reminder set here.
  const net = trackAsk(o.message);
  if (net?.kind === "remind") return null;
  const yieldEmpty = net?.kind === "no_remind";
  const s = o.store;
  if (ask.kind === "repeat") {
    const wd = new RegExp(WEEKDAY, "i").exec(ask.every)?.[0];
    const FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const nextDay = wd ? FULL[DAYS.indexOf(wd.slice(0, 3).toLowerCase())] : "tomorrow";
    const what = ask.what || "...";
    return { reply: `I can't set repeating reminders yet (you asked for "${ask.every}"), so nothing is set. Want just the next one? Say "remind me ${nextDay} at 9am to ${what}" and I'll set that one.`, status: "repeat_unsupported", intent: REMINDER_ASK_INTENT };
  }
  if (ask.kind === "when") {
    if (!ask.what) return { reply: `What should I remind you about, and when? Say it like "remind me tomorrow at 9am to send my transcript". Nothing is set yet.`, status: "needs_text", intent: REMINDER_ASK_INTENT };
    return { reply: `When should I remind you to ${ask.what}? Say it with a time, like "remind me tomorrow at 9am to ${ask.what}". Nothing is set yet.`, status: "needs_time", intent: REMINDER_ASK_INTENT };
  }
  if (ask.kind === "set") {
    if (!ask.what) return { reply: "What should the reminder say? Nothing is set yet.", status: "needs_text", intent: REMINDER_ASK_INTENT };
    let mine: ReminderSettings, reach = false, paused = false, target: { contact: string; lastInboundAt: number | null } | null = null;
    try { [mine, reach, paused, target] = await Promise.all([s.settings(o.userId), s.reachable(o.userId), s.paused ? s.paused(o.userId) : false, s.target ? s.target(o.userId) : null]); }
    catch (e) { console.error("reminder: read:", e instanceof Error ? e.message : String(e)); return { reply: "I couldn't save that reminder just now, so nothing is set. Ask me again in a minute.", status: "unreadable", intent: REMINDER_SET_INTENT }; }
    if (!reach) return { reply: "I can only send reminders by text, and no texting channel is linked to your account (or texts are stopped), so nothing is set. Link Telegram, WhatsApp or iMessage from the Trainee app, then ask again.", status: "no_channel", intent: REMINDER_SET_INTENT };
    if (paused) return { reply: "Nothing is set: my texts to you are on hold (your account is paused, or you texted STOP on one of your linked numbers), and a reminder can't go out while they're held. Resume in the Trainee app or text START where you sent STOP, then ask me again.", status: "paused", intent: REMINDER_SET_INTENT };
    const w = whenOf(ask.when, o.now, mine.tz);
    if ("error" in w) return { reply: `Nothing is set: ${w.error}. Say it like "remind me tomorrow at 9am to ${ask.what}" or "in 2 hours".`, status: "bad_time", intent: REMINDER_SET_INTENT };
    // RE-REVIEW 2 (PR #355): a default time only when the message names no time at all ("tomorrow to prep for the 3pm call").
    const tl = w.defaulted ? TIMELIKE.exec(ask.what) : null;
    if (tl) return { reply: `When should I remind you to ${ask.what}? I see "${tl[0]}" in it but I'm not sure that's when you want the reminder. Say it like "remind me tomorrow at 9am to ${ask.what}". Nothing is set yet.`, status: "needs_time", intent: REMINDER_ASK_INTENT };
    if (w.at <= o.now + 30_000) return { reply: `Nothing is set: ${whenLabel(w.at, w.zone)} has already passed. Give me a time that's still ahead.`, status: "past", intent: REMINDER_SET_INTENT };
    if (w.at > o.now + YEAR) return { reply: "Nothing is set: that's more than a year away. Give me a time within the next year.", status: "too_far", intent: REMINDER_SET_INTENT };
    const key = reminderKey((o.newKey ?? (() => crypto.randomUUID()))(), w.zone);
    const text = reminderText(ask.what, o.now, w.at, w.zone);
    let ok = false;
    try { ok = await s.add(o.userId, { key, text, at: w.at }); }
    catch (e) { console.error("reminder: save:", e instanceof Error ? e.message : String(e)); }
    if (!ok) return { reply: "I couldn't save that reminder just now, so nothing is set. Ask me again in a minute.", status: "not_saved", intent: REMINDER_SET_INTENT };
    const note = w.assumed.length ? ` I used ${w.assumed.join(", and ")}.` : "";
    // Quiet hours on the clock of the zone the reminder is in: the same zone delivery holds it by.
    const quiet = quietAt(w.at, w.zone, mine) ? ` That's inside your quiet hours (${hour12(mine.quiet_start)} to ${hour12(mine.quiet_end)}), so it will come when they end, at ${whenLabel(nextAwake(w.at, w.zone, mine), w.zone)}.` : "";
    // RE-REVIEW (PR #355): WhatsApp delivers free text only within its window after the person's last message; a reminder
    // due after that waits for their next message (channel.ts deliverDue hold). Said, with when the window closes.
    const closes = target && /^wa:/.test(target.contact) ? (target.lastInboundAt ?? -Infinity) + WHATSAPP_WINDOW_MS : null;
    const wa = closes !== null && w.at >= closes ? ` One thing: this goes to WhatsApp, which only lets me text you within 24 hours of your last message to me${Number.isFinite(closes) ? ` (that window closes ${whenLabel(closes, w.zone)})` : ""}. Unless you message me in the 24 hours before it's due, it will wait until you next message me.` : "";
    return { reply: `Set. At ${whenLabel(w.at, w.zone)} I'll text you: "${text}"${note}${quiet}${wa} Say "my reminders" to see them, or "cancel my reminder about ${short(ask.what)}" to drop it.`, status: "set", intent: REMINDER_SET_INTENT };
  }
  let rows: ReminderRow[], zone = DEFAULT_ZONE;
  try {
    const [r, z] = await Promise.all([s.pending(o.userId), s.settings(o.userId)]);
    rows = r.sort((a, b) => a.at - b.at);
    zone = zoneOr(z.tz);
  } catch (e) {
    console.error("reminder: list:", e instanceof Error ? e.message : String(e));
    if (yieldEmpty && await s.networking(o.userId).catch(() => true)) return null;
    return { reply: "I couldn't read your reminders just now, so I can't say which are set; nothing was changed. Ask me again in a minute.", status: "unreadable", intent: ask.kind === "list" ? REMINDER_LIST_INTENT : REMINDER_CANCEL_INTENT };
  }
  const zoneOf = (r: ReminderRow) => reminderZone(r.key) ?? zone;
  const line = (r: ReminderRow, i: number) => `${i + 1}. ${whenLabel(r.at, zoneOf(r))}: ${whatOf(r.text)}`;
  if (ask.kind === "list") {
    if (!rows.length) return { reply: "You have no reminders set. Say \"remind me tomorrow at 9am to ...\" to set one.", status: "none", intent: REMINDER_LIST_INTENT };
    return { reply: [`Your reminders, soonest first:`, ...rows.map(line), `Say "cancel reminder 1" to drop one.`].join("\n"), status: "shown", intent: REMINDER_LIST_INTENT };
  }
  const w = ask.which;
  const pick = "all" in w ? rows : "n" in w ? rows.slice(w.n - 1, w.n).filter(() => w.n >= 1)
    : "about" in w ? rows.filter((r) => words(whatOf(r.text)).some((x) => words(w.about).includes(x)) && words(w.about).every((x) => STOP.has(x) || words(whatOf(r.text)).includes(x)))
    : rows.length ? [rows.reduce((a, b) => (keyTime(b) > keyTime(a) ? b : a))] : [];
  if (!pick.length) {
    if (yieldEmpty && await s.networking(o.userId).catch(() => true)) return null;
    const why = !rows.length ? "you have no reminders set" : "n" in w ? `there is no reminder ${w.n}` : "about" in w ? `none of your reminders is about "${w.about}"` : "no reminder matched";
    return { reply: `Nothing was cancelled: ${why}.${rows.length ? `\n${["Your reminders:", ...rows.map(line)].join("\n")}` : ""}`, status: "none", intent: REMINDER_CANCEL_INTENT };
  }
  let removed = 0;
  try { removed = await s.remove(o.userId, pick.map((r) => r.key)); }
  catch (e) { console.error("reminder: cancel:", e instanceof Error ? e.message : String(e)); return { reply: "I couldn't cancel that just now, so the reminder still stands. Ask me again in a minute.", status: "unreadable", intent: REMINDER_CANCEL_INTENT }; }
  if (removed < pick.length) return { reply: `${removed ? `Cancelled ${removed} of ${pick.length}; the rest` : "Nothing was cancelled: it"} had already gone out.`, status: removed ? "partial" : "already_sent", intent: REMINDER_CANCEL_INTENT };
  return { reply: [`Cancelled ${pick.length === 1 ? "this reminder" : `these ${pick.length} reminders`}; ${pick.length === 1 ? "it" : "they"} won't be sent:`, ...pick.map((r) => `- ${whenLabel(r.at, zoneOf(r))}: ${whatOf(r.text)}`)].join("\n"), status: "cancelled", intent: REMINDER_CANCEL_INTENT };
}
const hour12 = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
const STOP = new Set(["the", "a", "an", "my", "to", "for", "about", "on", "at", "of", "and", "with"]);
const words = (s: string) => norm(s).toLowerCase().split(/[^a-z0-9']+/).filter((x) => x && !STOP.has(x));
const short = (s: string) => s.split(" ").slice(0, 4).join(" ");
// The most recently set reminder: the row's own creation time.
const keyTime = (r: ReminderRow) => r.created ?? 0;

// ------------------------------------------------------------------------------------------------ the stores
// The quiet hours the alert settings keep (career_alert_prefs.prefs), else the defaults delivery itself uses.
// deno-lint-ignore no-explicit-any
const hours = (p: any) => ({
  quiet_start: Number.isInteger(p?.quiet_start) ? p.quiet_start : DEFAULT_PREFS.quiet_start,
  quiet_end: Number.isInteger(p?.quiet_end) ? p.quiet_end : DEFAULT_PREFS.quiet_end,
});
// deno-lint-ignore no-explicit-any
export function supabaseReminderStore(admin: any): ReminderStore {
  // deno-lint-ignore no-explicit-any
  const must = <T>(r: { data: T; error: any }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r.data; };
  return {
    settings: async (u) => {
      // deno-lint-ignore no-explicit-any
      const r = must<any>(await admin.from("career_alert_prefs").select("tz,prefs").eq("user_id", u).maybeSingle(), "read the time zone");
      return { tz: r?.tz ?? null, ...hours(r?.prefs) };
    },
    // deno-lint-ignore no-explicit-any
    reachable: async (u) => (must<any[]>(await admin.from("channel_contacts").select("contact").eq("user_id", u).eq("opted_out", false).limit(1), "read the texting channel") ?? []).length > 0,
    paused: async (u) => must<boolean>(await admin.rpc("career_user_quiet", { p_user: u }), "read the pause") === true,
    target: async (u) => {
      const contact = must<string | null>(await admin.rpc("channel_target", { p_user: u, p_channel: null }), "read the texting contact");
      if (!contact) return null;
      // deno-lint-ignore no-explicit-any
      const r = must<any>(await admin.from("channel_contacts").select("last_inbound_at").eq("contact", contact).maybeSingle(), "read the last message");
      return { contact, lastInboundAt: r?.last_inbound_at ? Date.parse(r.last_inbound_at) : null };
    },
    add: async (u, r) => {
      const res = await admin.from("career_outbox").insert({ user_id: u, key: r.key, kind: "status", text: r.text, deliver_at: new Date(r.at).toISOString() });
      if (res.error) { if (String(res.error.code) === "23505") return false; throw new Error(`save the reminder: ${res.error.message}`); }
      return true;
    },
    // deno-lint-ignore no-explicit-any
    pending: async (u) => (must<any[]>(await admin.from("career_outbox").select("key,text,deliver_at,created_at").eq("user_id", u).eq("kind", "status").like("key", `${REMINDER_PREFIX}%`).eq("status", "queued").is("delivered_at", null).order("deliver_at", { ascending: true }).limit(100), "read the reminders") ?? [])
      .map((r) => ({ key: r.key, text: r.text, at: Date.parse(r.deliver_at), created: Date.parse(r.created_at) })),
    // deno-lint-ignore no-explicit-any
    networking: async (u) => (must<any[]>(await admin.from("career_outreach_drafts").select("id").eq("user_id", u).limit(1), "read the networking emails") ?? []).length > 0,
    // deno-lint-ignore no-explicit-any
    remove: async (u, keys) => (must<any[]>(await admin.from("career_outbox").delete().eq("user_id", u).eq("kind", "status").like("key", `${REMINDER_PREFIX}%`).eq("status", "queued").is("delivered_at", null).in("key", keys).select("key"), "cancel the reminders") ?? []).length,
  };
}

export interface MemoryReminders { networking?: Record<string, boolean>; prefs?: Record<string, { quiet_start?: number; quiet_end?: number }>; zones: Record<string, string | null>; reachable: Record<string, boolean>; paused?: Record<string, boolean>; targets?: Record<string, { contact: string; lastInboundAt: number | null }>; rows: (ReminderRow & { userId: string; created: number; sent?: boolean })[] }
export function memoryReminderStore(init: Partial<MemoryReminders> = {}): ReminderStore & { dump(): MemoryReminders } {
  const st: MemoryReminders = { zones: {}, reachable: {}, rows: [], ...init };
  let n = 0;
  return {
    settings: async (u) => ({ tz: st.zones[u] ?? null, ...hours(st.prefs?.[u]) }),
    reachable: async (u) => !!st.reachable[u],
    paused: async (u) => !!st.paused?.[u],
    target: async (u) => st.targets?.[u] ?? null,
    networking: async (u) => !!st.networking?.[u],
    add: async (u, r) => { if (st.rows.some((x) => x.userId === u && x.key === r.key)) return false; st.rows.push({ ...r, userId: u, created: ++n }); return true; },
    pending: async (u) => st.rows.filter((x) => x.userId === u && !x.sent).map((x) => ({ key: x.key, text: x.text, at: x.at, created: x.created })),
    remove: async (u, keys) => { const before = st.rows.length; st.rows = st.rows.filter((x) => !(x.userId === u && !x.sent && keys.includes(x.key))); return before - st.rows.length; },
    dump: () => st,
  };
}
