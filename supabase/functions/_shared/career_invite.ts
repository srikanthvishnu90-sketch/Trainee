// WO-034: an interview invite becomes a brief the same run it is read. extractInvite reads only what the invite itself
// states (the company, the role, the date and time with its zone, the format, who the person meets) and leaves anything
// it does not state empty: a date with no year resolves only when the words pin it, a time with no am/pm or zone is not
// completed, two offered times are not picked between. inviteBrief turns that and the company's record into two texts
// (the invite and what is on file; the 10-point plan). interviewDrafts plans the thank-you right after a dated interview
// and the thank-you and nudge after 7 quiet days. Pure functions: no I/O, no model, nothing sent.
//
// RULE, interviewers: Trainee knows only what the invite says about who the person meets (a name, a title if given). It
// never looks a named interviewer up: not on LinkedIn (never automated), and not through People Data Labs (D-018) or any
// other people-search source even when its key is set; a person who happens to interview someone is not a subject for
// enrichment. Nothing in this file takes a lookup, a fetch or a key, and the tests hold it to that.
import { classifyMail, companyFromText, type Draft, interviewPhrase, parseFrom, roleOf, sameCompany, TERMINAL, type TrackedApp } from "./career_mail.ts";
import { brief as roleBrief, type Brief, findRecord, possessive, recordName, sectorOf, sourceLabel } from "./career_mock.ts";

export const INTERVIEWER_LOOKUP = "never" as const;
export const INTERVIEWER_NOTE = "I only know what the invite says about who you're meeting.";
export const TEXT_LIMIT = 1500;
const DAY = 86400000;

export interface Interviewer { name: string; title: string | null }
export interface Invite {
  company: string | null;
  role: string | null;
  // said: the invite's own words for each date and time it states; date (YYYY-MM-DD), time (HH:MM, 24h) and zone (IANA)
  // only when exactly one is stated and nothing has to be guessed; starts_at only when all three are.
  when: { said: string[]; date: string | null; time: string | null; zone: string | null; zone_said: string | null; starts_at: string | null };
  format: { kind: "video" | "phone" | "onsite" | "recorded video" | "superday"; said: string } | null;
  interviewers: Interviewer[];
}

const clean = (s: unknown) => String(s ?? "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
const clip = (s: unknown, n: number) => { const t = clean(s); return t.length <= n ? t : `${t.slice(0, n - 3).replace(/\s+\S*$/, "")}...`; };
const pad = (n: number) => String(n).padStart(2, "0");

// ------------------------------------------------------------------------------------------------ dates
const MON = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const WD = String.raw`(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DATE_RES: { re: RegExp; parts: (m: RegExpExecArray) => { wd?: string; mon: number; d: number; y?: number } }[] = [
  { re: new RegExp(String.raw`\b(?:${WD},?\s+)?${MON}\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, "gi"),
    parts: (m) => ({ wd: m[1], mon: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, d: Number(m[3]), y: m[4] ? Number(m[4]) : undefined }) },
  { re: new RegExp(String.raw`\b(?:${WD},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MON}(?![a-z])(?:,?\s+(\d{4})\b)?`, "gi"),
    parts: (m) => ({ wd: m[1], mon: MONTHS.indexOf(m[3].slice(0, 3).toLowerCase()) + 1, d: Number(m[2]), y: m[4] ? Number(m[4]) : undefined }) },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parts: (m) => ({ mon: Number(m[2]), d: Number(m[3]), y: Number(m[1]) }) },
];
// 10/24/2026 reads one way in the US and another in Europe: only a numeric date whose day cannot be a month is read.
const NUMERIC_DATE = new RegExp(String.raw`\b(?:${WD},?\s+)?(\d{1,2})/(\d{1,2})/(\d{4})\b`, "gi");

const real = (y: number, mon: number, d: number) => {
  const t = Date.UTC(y, mon - 1, d);
  return mon >= 1 && mon <= 12 && new Date(t).getUTCDate() === d ? t : null;
};
// One stated date, as a calendar day. A year is taken as written; with none, the weekday the invite names picks it (the
// one year it fits), or, with no weekday either, the date's next occurrence within 120 days of the invite. Anything else
// (a weekday that does not fit the date, a date far off with no year) stays unresolved: never a guessed year.
function resolveDate(p: { wd?: string; mon: number; d: number; y?: number }, sentAt: number): string | null {
  const sent = new Date(sentAt), floor = Date.UTC(sent.getUTCFullYear(), sent.getUTCMonth(), sent.getUTCDate()) - DAY;
  const wd = p.wd ? WEEKDAYS.indexOf(p.wd.slice(0, 3).toLowerCase()) : -1;
  const fits = (t: number | null) => t !== null && (wd < 0 || new Date(t).getUTCDay() === wd);
  let t: number | null = null;
  if (p.y) {
    t = real(p.y, p.mon, p.d);
    if (!fits(t)) return null;
  } else {
    // The date's next occurrence, within 120 days; a weekday the invite names must fit it (never a later year that fits).
    const next = [sent.getUTCFullYear(), sent.getUTCFullYear() + 1].map((y) => real(y, p.mon, p.d)).find((x): x is number => x !== null && x >= floor);
    if (next === undefined || next - floor > 121 * DAY || !fits(next)) return null;
    t = next;
  }
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------------------------------------ times and zones
const AMPM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])`;
const RANGE = new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*(?:${AMPM})?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*${AMPM}`, "gi");
const SINGLE = new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${AMPM}`, "gi");
const H24 = /\b([01]\d|2[0-3]):([0-5]\d)\b(?!\s*(?:a\.?\s?m|p\.?\s?m))/gi;
const to24 = (h: number, mi: number, ap: string) => {
  if (h < 1 || h > 12 || mi > 59) return null;
  const pm = /^p/i.test(ap);
  return (h % 12) + (pm ? 12 : 0) + mi / 60;
};
const hhmm = (x: number) => `${pad(Math.floor(x))}:${pad(Math.round((x % 1) * 60))}`;
// A zone abbreviation counts only right after a stated time ("2 PM ET"), so "Stamford, CT" is never a time zone; a zone
// spelled out ("Eastern Time", "America/Chicago") counts anywhere.
const ABBREV: Record<string, string> = {
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York", CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver", PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  UTC: "UTC", GMT: "UTC", BST: "Europe/London",
};
const ZONE_AFTER = /^\s*\(?\s*(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT|BST)\b/;
const ZONE_WORD_AFTER: [RegExp, string][] = [
  [/^\s*\(?\s*(eastern)\b/i, "America/New_York"], [/^\s*\(?\s*(central)\b/i, "America/Chicago"],
  [/^\s*\(?\s*(mountain)\b/i, "America/Denver"], [/^\s*\(?\s*(pacific)\b/i, "America/Los_Angeles"],
];
// A window to pick from ("between 2 and 4 pm") or a day named only by a word ("Thursday", "tomorrow") is said back as
// written and never turned into a time or a date.
const WINDOW = new RegExp(String.raw`\bbetween\s+(\d{1,2})(?::\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)?\s+and\s+(\d{1,2})(?::\d{2})?\s*${AMPM}`, "gi");
const LONE_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week)\b/gi;
const SPELLED: [RegExp, string][] = [
  [/\beastern (?:standard |daylight )?time\b/i, "America/New_York"], [/\bcentral (?:standard |daylight )?time\b/i, "America/Chicago"],
  [/\bmountain (?:standard |daylight )?time\b/i, "America/Denver"], [/\bpacific (?:standard |daylight )?time\b/i, "America/Los_Angeles"],
  [/\b(?:coordinated universal time|greenwich mean time)\b/i, "UTC"],
];
const IANA = /\b((?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian)\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?)\b/g;
const validZone = (z: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } };

function offsetMs(at: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - at;
}
// The instant a wall-clock time names in a zone (twice through, so a daylight-saving edge settles on the zone's own offset).
export function zonedInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}

// ------------------------------------------------------------------------------------------------ format
const FORMATS: [NonNullable<Invite["format"]>["kind"], RegExp][] = [
  ["recorded video", /\b(hirevue|recorded video(?: interview)?|on-?demand video(?: interview)?|one-way video(?: interview)?)\b/i],
  ["superday", /\b(super ?day)\b/i],
  ["video", /\b(virtual on-?site)\b/i],
  ["onsite", /\b(on-?site|in[- ]person|at our office|our office at|office visit)\b/i],
  ["video", /\b(zoom|google meet|microsoft teams|teams meeting|webex|video (?:call|interview|conference)|virtual(?:ly)?)\b/i],
  ["phone", /\b(phone (?:call|screen|interview)|by phone|over the phone|we will call you|call you at)\b/i],
];

// ------------------------------------------------------------------------------------------------ interviewers
const NAME = String.raw`([A-Z][a-z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z'’-]+){1,2})\b`;
const WHO = new RegExp(String.raw`(?:\b[Ww]ith|\b[Mm]eet(?:ing)?(?:\s+with)?|\b[Ss]peak(?:ing)?\s+with|\b[Cc]hat(?:ting)?\s+with|\b[Ii]nterviewers?(?:\s+(?:will be|is|are))?:?|\b[Hh]osted by|\b[Ii]nterviewing\s+with)\s+${NAME}`, "g");
const MORE = new RegExp(String.raw`^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*;\s*)${NAME}`);
// A title right after a name, "(Engineering Manager)" or ", VP of Engineering", taken only when it is a job title.
const PAREN_TITLE = /^\s*\(([^)]{2,60})\)/;
const COMMA_TITLE = /^,\s+(?:(?:our|the|a|an)\s+)?([A-Z][A-Za-z&/-]*(?:\s+(?:[A-Z][A-Za-z&/-]*|of|for|the|&)){0,6})/;
// "an interview at Acme Robotics on October 22": the employer the invite's words place the interview at.
const AT_COMPANY = /\b(?:interview|interviews|interviewing|onsite|on-site|superday|phone screen|call|chat)\b[^.\n]{0,60}?\bat\s+([A-Z][A-Za-z0-9&'’-]*(?:\s+(?:[A-Z][A-Za-z0-9&'’-]*|&|of)){0,3})(?=\s+(?:on|for|in|next|this|at|from)\b|[.,!;:\n]|\s*$)/;
const ROLE_WORD = /\b(manager|director|engineer|engineering|recruiter|recruiting|lead|partner|analyst|associate|vp|vice president|president|head|officer|coordinator|specialist|scientist|designer|founder|co-founder|ceo|cto|cfo|coo|principal|managing director|staff|developer|architect|consultant|product|talent|banker|trader|researcher)\b/i;
// Words that make a capitalized pair something other than a person: a tool, a team, a time, a place, a month.
const NOT_PERSON = /\b(google|meet|microsoft|teams?|zoom|webex|hirevue|hiring|recruiting|recruitment|talent|acquisition|human|resources|interview|interviews|eastern|central|mountain|pacific|standard|daylight|time|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|street|avenue|road|floor|suite|building|office|campus|round|panel|superday|online|assessment|calendar|invite|invitation|link|the|our|your|this|next|first|second|final|virtual|video|phone|call)\b/i;
const CORP_END = /\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|partners|capital|bank|sachs|stanley|technologies|labs?|systems|health|securities|associates|consulting|ventures|foods|energy|motors|media|software)\.?$/i;
function interviewersIn(text: string, company: string | null): Interviewer[] {
  const out: Interviewer[] = [];
  // One name and the title after it, if that is a job title; returns the text after what it used.
  const take = (name: string, after: string): string => {
    const n = clean(name);
    const p = PAREN_TITLE.exec(after) ?? COMMA_TITLE.exec(after);
    const t = p ? clean(p[1]).replace(/[.,;:]+$/, "") : "";
    const title = t && ROLE_WORD.test(t) && !NOT_PERSON.test(t.split(" ")[0]) && t.length <= 80 ? t : null;
    const person = !NOT_PERSON.test(n) && !CORP_END.test(n) && !(company && sameCompany(n, company)) && !findRecord(n);
    if (person && !out.some((x) => x.name === n) && out.length < 6) out.push({ name: n, title });
    return title && p ? after.slice(p[0].length) : after;
  };
  for (const m of text.matchAll(WHO)) {
    let rest = take(m[1], text.slice((m.index ?? 0) + m[0].length));
    for (let i = 0; i < 5; i++) {
      const more = MORE.exec(rest);
      if (!more) break;
      rest = take(more[1], rest.slice(more[0].length));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the invite
// A forwarded invite carries its own header lines (From:, Date:, Sent:, Subject:): the date the email was sent is not the
// interview's, so those lines are read for the sender and the subject only.
const HEADER = /^\s*(?:>\s*)?(from|date|sent|to|cc|subject)\s*:\s*(.*)$/i;
export function splitInvite(text: string): { from: string | null; subject: string | null; body: string } {
  let from: string | null = null, subject: string | null = null;
  const body: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h = HEADER.exec(line);
    if (!h) { if (!/^\s*-{3,}\s*forwarded message\s*-{3,}\s*$/i.test(line)) body.push(line); continue; }
    const k = h[1].toLowerCase();
    if (k === "from" && !from) from = h[2].trim();
    if (k === "subject" && !subject) subject = h[2].trim();
  }
  return { from, subject, body: body.join("\n") };
}

export function isInvite(text: string, subject = ""): boolean {
  return interviewPhrase(`${subject}\n${text}`) !== null;
}

// What the invite states, and nothing it does not. sentAt is when the invite was sent (the email's date, or the chat
// message's time for a pasted invite with no Date line): it only places a date written without a year.
export function extractInvite(o: { text: string; subject?: string | null; from?: string | null; sentAt: number; company?: string | null; role?: string | null }): Invite {
  const parts = splitInvite(o.text);
  const subject = clean(o.subject ?? parts.subject ?? ""), from = o.from ?? parts.from ?? "";
  const body = parts.body.replace(/\s+/g, " ").trim();
  const all = `${subject}. ${body}`;
  // The company: the caller's (the application the email matched), else what the sender or the words name.
  let company = clean(o.company) || null;
  if (!company && from) {
    const c = classifyMail({ from, subject, snippet: body, date: new Date(o.sentAt).toISOString() });
    const s = parseFrom(from);
    // A sender's display name names the employer; a bare address's domain is not something the invite states.
    if (c.company && (s.name.trim() || c.company.toLowerCase() !== s.label)) company = c.company;
  }
  // The words, line by line (a pasted subject line and the greeting under it are not one name).
  const lines = `${subject}\n${parts.body}`;
  if (!company) company = companyFromText(lines) ?? AT_COMPANY.exec(lines)?.[1] ?? null;
  const role = clean(o.role) || roleOf(subject, body) || null;

  // Dates: every one stated, resolved without guessing; one distinct day or none.
  const said: string[] = [], days = new Set<string>();
  let unresolved = 0;
  const seen: [number, number][] = [];
  for (const { re, parts: get } of DATE_RES) {
    for (const m of body.matchAll(re)) {
      const at = m.index ?? 0;
      if (seen.some(([a, b]) => at < b && at + m[0].length > a)) continue;
      seen.push([at, at + m[0].length]);
      const p = get(m as RegExpExecArray);
      if (!p.mon || p.mon < 1 || !p.d) continue;
      said.push(clean(m[0]));
      const d = resolveDate(p, o.sentAt);
      if (d) days.add(d); else unresolved++;
    }
  }
  for (const m of body.matchAll(NUMERIC_DATE)) {
    const at = m.index ?? 0;
    if (seen.some(([a, b]) => at < b && at + m[0].length > a)) continue;
    said.push(clean(m[0]));
    const a = Number(m[2]), b = Number(m[3]), y = Number(m[4]);
    // Only an order the numbers force: 10/24/2026 (month first) or 24/10/2026 (day first). 03/04/2026 is not read.
    const p = a > 12 && b <= 12 ? { mon: b, d: a, y } : b > 12 && a <= 12 ? { mon: a, d: b, y } : null;
    const d = p ? resolveDate({ wd: m[1], ...p }, o.sentAt) : null;
    if (d) days.add(d); else unresolved++;
  }
  for (const m of body.matchAll(LONE_DAY)) {
    const at = m.index ?? 0;
    if (seen.some(([a, b]) => at >= a && at < b)) continue;
    said.push(clean(m[0]));
    if (!/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(m[0]) || !days.size) unresolved++;
  }
  const date = days.size === 1 && unresolved === 0 ? [...days][0] : null;

  // Times: a range's start (its am/pm from the range's end when the start has none), single times with am/pm, 24-hour
  // times past noon. One distinct time or none; a time with no am/pm that could be either is not read.
  const times = new Set<string>(), timeAt: number[] = [];
  let rest = body;
  for (const m of body.matchAll(WINDOW)) {
    said.push(clean(m[0]));
    times.add("window").add("window-end"); // a window to choose from is not a start time
    rest = rest.replace(m[0], " ".repeat(m[0].length));
  }
  for (const m of rest.matchAll(RANGE)) {
    const h1 = Number(m[1]), mi1 = Number(m[2] ?? 0), h2 = Number(m[4]), mi2 = Number(m[5] ?? 0);
    const end = to24(h2, mi2, m[6]);
    let start = m[3] ? to24(h1, mi1, m[3]) : to24(h1, mi1, m[6]);
    if (!m[3] && start !== null && end !== null && start > end) start = to24(h1, mi1, /^p/i.test(m[6]) ? "am" : "pm");
    if (start === null) continue;
    times.add(hhmm(start));
    said.push(clean(m[0]));
    timeAt.push((m.index ?? 0) + m[0].length);
    rest = rest.replace(m[0], " ".repeat(m[0].length));
  }
  for (const m of rest.matchAll(SINGLE)) {
    const t = to24(Number(m[1]), Number(m[2] ?? 0), m[3]);
    if (t !== null) { times.add(hhmm(t)); said.push(clean(m[0])); timeAt.push((m.index ?? 0) + m[0].length); }
  }
  for (const m of rest.matchAll(H24)) {
    const h = Number(m[1]);
    if (h < 13 && h !== 0) continue;
    times.add(`${m[1]}:${m[2]}`);
    said.push(clean(m[0]));
    timeAt.push((m.index ?? 0) + m[0].length);
  }
  if (/\bnoon\b/i.test(rest) && !times.size) { times.add("12:00"); said.push("noon"); }
  const time = times.size === 1 ? [...times][0] : null;

  // The zone: an abbreviation right after a stated time, or a zone spelled out; one, or none.
  const zones = new Map<string, string>();
  for (const end of timeAt) {
    const after = body.slice(end, end + 14);
    const z = ZONE_AFTER.exec(after);
    if (z) zones.set(ABBREV[z[1]], z[1]);
    for (const [re, tz] of ZONE_WORD_AFTER) { const w = re.exec(after); if (w) zones.set(tz, clean(w[1])); }
  }
  for (const [re, tz] of SPELLED) { const m = re.exec(body); if (m) zones.set(tz, clean(m[0])); }
  for (const m of body.matchAll(IANA)) if (validZone(m[1])) zones.set(m[1], m[1]);
  const zone = zones.size === 1 ? [...zones.keys()][0] : null;
  const zone_said = zone ? zones.get(zone)! : null;
  const starts_at = date && time && zone ? new Date(zonedInstant(date, time, zone)).toISOString() : null;

  let format: Invite["format"] = null;
  for (const [kind, re] of FORMATS) { const m = re.exec(all); if (m) { format = { kind, said: clean(m[0]) }; break; } }

  return {
    company: company ? clip(company, 80) : null, role: role ? clip(role, 80) : null,
    when: { said: [...new Set(said)].slice(0, 6), date, time, zone, zone_said, starts_at },
    format, interviewers: interviewersIn(body, company),
  };
}

// ------------------------------------------------------------------------------------------------ the record
// The company's record on file by its name as the mail or the person gave it: exact, or with a legal ending dropped
// ("JPMorgan Chase & Co." is JPMorganChase's record). Never by a shared first word (Bain Capital is not Bain & Company).
export function recordFor(company: string | null | undefined, lib?: any[]): any | null {
  const c = clean(company);
  if (!c) return null;
  for (const v of [c, c.replace(/\s*(?:,\s*)?(?:&|and)\s*(?:co\.?|company)\s*$/i, ""), c.replace(/[,.]?\s+(?:co\.?|inc\.?|llc|ltd\.?|corp\.?|corporation|plc)\s*$/i, "")]) {
    const r = v.trim() ? findRecord(v.trim(), lib) : null;
    if (r) return r;
  }
  return null;
}

// "Questions that company asked in the last 12 months": only questions a record lists one by one, each with its own
// source and the date it was asked or reported, inside the last 365 days. The date a record was checked is not the date a
// question was asked, so a record's as_of never dates a question. The records on file today list no questions this way,
// so this is "none on file" until one does.
export interface AskedQuestion { q: string; asked: string; label: string }
const QUESTION_FIELDS = ["reported_questions", "interview_questions", "questions_asked"];
export function askedLastYear(cir: any, now: number): AskedQuestion[] {
  const out: AskedQuestion[] = [];
  for (const f of QUESTION_FIELDS) {
    for (const it of Array.isArray(cir?.[f]) ? cir[f] : []) {
      if (!it || typeof it !== "object") continue;
      const q = clean(it.question ?? it.q ?? it.text);
      const asked = String(it.asked_at ?? it.reported_at ?? it.date ?? "").slice(0, 10);
      const t = Date.parse(asked);
      const label = sourceLabel(cir, { source_url: it.source_url, source_type: it.source_type });
      if (!q || !label || !Number.isFinite(t) || t > now || now - t > 365 * DAY) continue;
      out.push({ q: clip(q, 160), asked, label });
    }
  }
  return out.sort((a, b) => b.asked.localeCompare(a.asked));
}

// ------------------------------------------------------------------------------------------------ the brief
const fmtDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtTime = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};
export function whenLine(inv: Invite): string {
  const w = inv.when;
  if (w.date) {
    const at = w.time ? ` at ${fmtTime(w.time)}${w.zone_said ? ` ${w.zone_said}` : ", no time zone stated"}` : ", no time stated";
    return `When: ${fmtDay(w.date)}${at}.`;
  }
  if (w.said.length) return `When: the invite says ${w.said.slice(0, 4).map((s) => `"${clip(s, 40)}"`).join(", ")}; I have not filled in or picked a date or time it does not state.`;
  return "When: the invite states no date or time. Confirm them with the recruiter.";
}
export function whoLine(inv: Invite): string {
  const names = inv.interviewers.map((p) => (p.title ? `${p.name} (${p.title})` : p.name));
  return `Who you're meeting: ${names.length ? names.join(", ") : "the invite names no one"}. ${INTERVIEWER_NOTE}`;
}

export interface InviteBrief { texts: string[]; brief: Brief; record: string | null; asked: AskedQuestion[]; patterns_from: "company record" | "role bank" | "none" }
export function inviteBrief(inv: Invite, o: { now: number; cir?: any | null; postings?: any[]; lib?: any[] }): InviteBrief {
  const cir = o.cir !== undefined ? o.cir : recordFor(inv.company, o.lib);
  const b = roleBrief({ company: inv.company, role: inv.role, cir, postings: o.postings ?? [], lib: o.lib });
  const name = b.company, rec = b.record;
  const asked = cir ? askedLastYear(cir, o.now) : [];
  const sector = inv.role ? sectorOf(inv.role) : null;
  const facts = rec ? [rec.look_for, rec.style && rec.style.text !== rec.look_for?.text ? rec.style : null].filter(Boolean) as { text: string; label: string }[] : [];
  const patterns_from = facts.length ? "company record" : b.families.length ? "role bank" : "none";
  // The record's steps are in the plan (point 6); this text carries what the record says they ask and look for.
  const first = (quote: number, nAsked: number) => {
    const lines = [`Interview brief: ${name ?? "the invite does not name the company"}${inv.role ? `, ${inv.role}` : ""}.`, whenLine(inv)];
    lines.push(`Format: ${inv.format ? `${inv.format.kind} (the invite says "${inv.format.said}")` : "not stated in the invite"}.`);
    lines.push(whoLine(inv));
    const co = name ?? "this company";
    if (asked.length && nAsked) {
      lines.push(`Questions ${co} asked in the last 12 months (${asked.length} on file):`);
      for (const a of asked.slice(0, nAsked)) lines.push(`- "${clip(a.q, quote + 40)}" (${a.label}; asked ${a.asked})`);
    } else lines.push(`Questions ${co} asked in the last 12 months: none on file.`);
    if (patterns_from === "company record" && rec) {
      const parts = facts.map((f) => `"${clip(f.text, quote)}" (${f.label})`);
      lines.push(`Question patterns from ${possessive(rec.name)} record${rec.as_of ? ` (as of ${rec.as_of})` : ""}: ${parts.join("; ")}.`);
    } else if (patterns_from === "role bank") {
      lines.push(`Question patterns from the ${String(sector ?? "role").replace(/_/g, " ")} question bank (about the role, not about ${co}): ${b.families.join(", ")}.`);
    } else lines.push(`Question patterns: ${rec ? `${possessive(rec.name)} record says nothing about its interviews` : `no record for ${co}`} and there is no question bank for ${inv.role || "this role"}; practice general behavioral questions.`);
    return lines.join("\n");
  };
  let one = first(160, 3);
  for (const [q, n] of [[120, 3], [80, 2], [50, 1], [30, 1]] as [number, number][]) if (one.length > TEXT_LIMIT) one = first(q, n);
  if (one.length > TEXT_LIMIT) one = one.slice(0, TEXT_LIMIT);
  const two = [`10-point plan${name ? ` for ${name}` : ""}:`, ...b.plan.map((p, i) => `${i + 1}. ${p}`)].join("\n");
  return { texts: [one, two.length <= TEXT_LIMIT ? two : two.slice(0, TEXT_LIMIT)], brief: b, record: rec ? rec.name : null, asked, patterns_from };
}

// ------------------------------------------------------------------------------------------------ after the interview
// One stored interview (career_interviews): the invite's facts, where it came from, and when its brief went out.
export interface InterviewRow {
  key: string; // sha-256 of the message (mail) or of the pasted text (chat)
  source: "mail" | "chat";
  ref: string | null; // the application it belongs to, when one matched
  company: string | null; role: string | null;
  when_said: string[]; date: string | null; time: string | null; zone: string | null; starts_at: string | null;
  format: string | null; interviewers: Interviewer[];
  mail_at: string | null; seen_at: string; brief_at: string | null; brief_ms: number | null;
}
export function interviewRow(inv: Invite, o: { key: string; source: "mail" | "chat"; ref: string | null; mail_at: string | null; seen_at: number }): InterviewRow {
  return {
    key: o.key, source: o.source, ref: o.ref, company: inv.company, role: inv.role,
    when_said: inv.when.said, date: inv.when.date, time: inv.when.time, zone: inv.when.zone, starts_at: inv.when.starts_at,
    format: inv.format?.kind ?? null, interviewers: inv.interviewers,
    mail_at: o.mail_at, seen_at: new Date(o.seen_at).toISOString(), brief_at: null, brief_ms: null,
  };
}

// The interview's moment: its stated start, or (a date with no time) the start of that day in the person's zone.
function localMidnight(date: string, tz: string): number {
  try { return zonedInstant(date, "00:00", tz); } catch { return Date.parse(`${date}T00:00:00Z`); }
}
export const THANKS_AFTER_MS = 90 * 60000, THANKS_WINDOW_MS = DAY, NUDGE_DAYS = 7, NUDGE_WINDOW_DAYS = 30;
const REPLIES = new Set(["rejection", "interview", "assessment", "offer", "recruiter_reply"]);
const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const inviteRef = (r: Pick<InterviewRow, "ref" | "key">) => r.ref ?? `invite:${r.key.slice(0, 24)}`;

// Drafts for interviews with a stated date. A thank-you is due 90 minutes after a stated start time, or at the end of the
// interview day when only the date is known, and drafted only within 24 hours of that. The thank-you and nudge comes 7
// days after the interview when nothing came from the employer since (no later invite, test, offer, rejection or reply),
// up to 30 days. A closed application or one at Offer gets neither. Drafts are drafts: the person sends them.
export function interviewDrafts(rows: InterviewRow[], apps: TrackedApp[], now: number, tz = "America/New_York"): Draft[] {
  const out: Draft[] = [];
  const done = new Set<string>();
  for (const r of [...rows].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))) {
    if (!r.date) continue;
    const ref = inviteRef(r);
    if (done.has(`${ref}:${r.date}`)) continue;
    done.add(`${ref}:${r.date}`);
    const app = apps.find((a) => a.ref === ref) ?? null;
    if (app && (TERMINAL.has(app.stage) || app.stage === "Offer")) continue;
    const company = clean(r.company ?? app?.company ?? "");
    if (!company) continue;
    const role = r.role ?? app?.role ?? null;
    const moment = r.starts_at ? Date.parse(r.starts_at) : localMidnight(r.date, r.zone ?? tz);
    const thanksDue = r.starts_at ? moment + THANKS_AFTER_MS : localMidnight(new Date(Date.parse(`${r.date}T12:00:00Z`) + DAY).toISOString().slice(0, 10), r.zone ?? tz);
    const when = shortDay(r.date);
    const first = r.interviewers.map((p) => p.name.split(" ")[0]).filter(Boolean);
    const hello = first.length ? `Hello ${first.length > 1 ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}` : first[0]},` : "Hello,";
    const forRole = role ? ` about the ${clip(role, 60)} role` : "";
    if (now >= thanksDue && now <= thanksDue + THANKS_WINDOW_MS) {
      out.push({
        key: `thank_you:${ref}:after:${r.date}`, ref, kind: "thank_you", step: "thanks", company, role: role ?? undefined,
        basis: `interview ${when}${r.time ? ` at ${fmtTime(r.time)}` : ""}, from the invite`,
        text: `${hello} thank you for taking the time to speak with me on ${when}${forRole} at ${clip(company, 80)}. I enjoyed the conversation and I am very interested in the role. I look forward to hearing about next steps.`,
      });
      continue;
    }
    const quiet = (now - moment) / DAY;
    const since = (app?.events ?? []).some((e) => REPLIES.has(e.kind) && Date.parse(e.at) > moment);
    if (quiet >= NUDGE_DAYS && quiet <= NUDGE_WINDOW_DAYS && !since) {
      out.push({
        key: `thank_you:${ref}:${r.date}`, ref, kind: "thank_you", step: "nudge", company, role: role ?? undefined,
        basis: `interview ${when}; nothing since in ${Math.floor(quiet)} days`,
        text: `${hello} thank you again for the time with ${clip(company, 80)}${forRole} on ${when}. I enjoyed the conversation and remain very interested. Is there an update on next steps?`,
      });
    }
  }
  return out;
}
