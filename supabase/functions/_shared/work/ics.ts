// Work artifacts, ICS (spec WORK-ARTIFACTS.md, rules D2 and D9). RFC 5545 text for a tentative, private hold: CRLF line
// ends, folding at 75 octets, TEXT escaping and UTC times. A hold never carries METHOD, ATTENDEE, ORGANIZER or VALARM, so
// importing it invites nobody and sends nothing. lintIcs checks those rules on any text; offsetOn gives a zone's UTC offset
// for one date, taken at local noon so that the day of a DST change still gets that day's offset.
export type IcsEvent = {
  uid: string; start: string; end: string; summary: string;
  description?: string; location?: string; private?: boolean; tentative?: boolean; stamp?: string;
};

const enc = new TextEncoder();
const octets = (s: string) => enc.encode(s).length;
const TEXT_PROPS = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT"]);
const FORBIDDEN = ["METHOD", "ATTENDEE", "ORGANIZER"];

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds one content line so no physical line exceeds 75 octets, never splitting a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "", limit = 75;
  for (const ch of line) {
    if (octets(cur) + octets(ch) > limit) {
      out.push(cur);
      cur = " ";
      limit = 75;
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function utc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`bad time ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function writeIcs(events: IcsEvent[], opts: { now?: string } = {}): string {
  const stamp = utc(opts.now ?? new Date().toISOString());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trainee//Work artifacts//EN", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    if (new Date(e.end) <= new Date(e.start)) throw new Error(`event ${e.uid} ends before it starts`);
    lines.push("BEGIN:VEVENT", `UID:${escapeText(e.uid)}`, `DTSTAMP:${e.stamp ? utc(e.stamp) : stamp}`,
      `DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end)}`, `SUMMARY:${escapeText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    lines.push(`CLASS:${e.private === false ? "PUBLIC" : "PRIVATE"}`, `STATUS:${e.tentative === false ? "CONFIRMED" : "TENTATIVE"}`,
      "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function unescapedIn(value: string): string | null {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[i] === ";" || value[i] === ",") return value[i];
  }
  return null;
}

/** Findings for a hold file; an empty list means it lints clean. */
export function lintIcs(text: string): string[] {
  const f: string[] = [];
  if (/(^|[^\r])\n/.test(text)) f.push("line endings must be CRLF");
  if (/\r(?!\n)/.test(text)) f.push("bare CR found; line endings must be CRLF");
  const physical = text.split(/\r?\n/);
  physical.forEach((l, i) => { if (octets(l) > 75) f.push(`line ${i + 1} is ${octets(l)} octets, over the 75-octet fold limit`); });
  const lines: string[] = [];
  for (const l of physical) {
    if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += l.slice(1);
    else if (l !== "") lines.push(l);
  }
  if (lines[0] !== "BEGIN:VCALENDAR" || lines[lines.length - 1] !== "END:VCALENDAR") f.push("must begin with BEGIN:VCALENDAR and end with END:VCALENDAR");
  if (!lines.includes("VERSION:2.0")) f.push("VERSION:2.0 missing");
  if (!lines.some((l) => l.startsWith("PRODID:"))) f.push("PRODID missing");
  let ev: string[] | null = null, events = 0;
  for (const l of lines) {
    const name = /^[A-Za-z-]+/.exec(l)?.[0].toUpperCase() ?? "";
    const value = l.slice(l.indexOf(":") + 1);
    if (FORBIDDEN.includes(name)) f.push(`${name} is not allowed in a hold (it would invite or send)`);
    if (l === "BEGIN:VALARM") f.push("VALARM is not allowed in a hold");
    if (l === "BEGIN:VEVENT") { ev = []; events++; continue; }
    if (l === "END:VEVENT" && ev) {
      const uid = ev.find((x) => x.startsWith("UID:")) ?? "(no UID)";
      for (const req of ["UID:", "DTSTAMP:", "DTSTART", "DTEND"]) if (!ev.some((x) => x.startsWith(req))) f.push(`${uid}: ${req.replace(":", "")} missing`);
      if (!ev.includes("CLASS:PRIVATE")) f.push(`${uid}: CLASS:PRIVATE missing`);
      if (!ev.includes("STATUS:TENTATIVE")) f.push(`${uid}: STATUS:TENTATIVE missing`);
      ev = null;
      continue;
    }
    ev?.push(l);
    if (["DTSTART", "DTEND", "DTSTAMP"].includes(name) && !/^\d{8}T\d{6}Z$/.test(value)) f.push(`${name} must be a UTC time (…Z): ${value}`);
    if (TEXT_PROPS.has(name)) {
      const bad = unescapedIn(value);
      if (bad) f.push(`${name} has an unescaped "${bad}"`);
    }
  }
  if (!events) f.push("no VEVENT");
  return f;
}

function offsetAt(zone: string, t: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((wall - Math.floor(t / 1000) * 1000) / 60000);
}

/** The zone's UTC offset in minutes (east positive) on isoDate, at local noon. */
export function offsetOn(zone: string, isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`bad date ${isoDate}`);
  const noon = Date.UTC(+m[1], +m[2] - 1, +m[3], 12);
  const first = offsetAt(zone, noon);
  return offsetAt(zone, noon - first * 60000);
}
