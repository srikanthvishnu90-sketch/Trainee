// R10 WO-C (owner order 2026-11-09, spec APP-LAYER-15-FIXES.md B.2, E.2 #19): a follow-up that WIDENS the thread's last
// search ("Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships")
// keeps what was asked before (the role, the internship level, the place) and adds what it names: more role titles, the
// place's metro area, remote roles in the US. On production after release 9 that follow-up was answered with the
// graduation-window template, because the word "requirements" was in it, and the search was never run again.
//
// Pure: the previous ask (discovery.lastAsk, kept by the handler) and the message in, the widened ask out. Code changes the
// search's scope only; nothing here writes a fact or an application.
import type { SearchAsk } from "./career_search_judge.ts";
import { CORRECTION_WINDOW_MS } from "./search_correction.ts";
import { searchSentence } from "./posting_constraints.ts";
import { ABROAD } from "./posting_place.ts";

export type Widening = "roles" | "area" | "remote_us" | "remote";
const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

// The towns a "<city> area" search also takes. A posting located in one of them is in the area; nothing else is inferred.
export const METRO: Record<string, string[]> = {
  chicago: ["chicago", "evanston", "schaumburg", "oak brook", "oakbrook", "naperville", "skokie", "deerfield", "northbrook", "rosemont",
    "itasca", "downers grove", "lombard", "arlington heights", "lake forest", "glenview", "elk grove village", "hoffman estates", "lisle",
    "aurora", "joliet", "vernon hills", "lincolnshire", "bannockburn", "oak park", "wheaton", "elmhurst", "hinsdale", "rolling meadows",
    "mount prospect", "park ridge", "des plaines", "northfield", "riverwoods", "warrenville", "bolingbrook", "west chicago", "libertyville"],
};
export function inMetro(location: string, place: string): boolean {
  const towns = METRO[lc(place)];
  if (!towns) return lc(location).includes(lc(place));
  const loc = lc(location);
  return towns.some((t) => new RegExp(`(^|[^a-z])${t}($|[^a-z])`).test(loc));
}
// A remote posting open in the US: remote, and no other country or region named.
export const remoteInUs = (location: string) => /\bremote\b/i.test(location) && (/\b(?:us|u\.s\.?|usa|united states|america)\b/i.test(location) || !ABROAD.test(location));

const CUE = /\b(?:include|including|add|adding|widen|expand|broaden|plus|as well|too)\b/;
const NOUN = "(?:internships?|interns?|roles?|jobs?|positions?|openings?)";
// "business analyst and analytics internships" -> ["business analyst", "analytics"]
const COUNT = "(?:\\s+(?:the\\s+)?(?:top\\s+)?(?:\\d{1,2}|two|three|four|five|six|seven|eight|nine|ten))?(?:\\s+(?:verified|open|actually|currently|new|paid|more|other))*";
function rolesNamed(s: string, fresh = false): string[] {
  const m = new RegExp(fresh ? `\\b(?:find|show|search for|look for|get|list)(?:\\s+me)?${COUNT}\\s+([a-z][a-z ,/&-]{1,80}?)\\s+${NOUN}\\b` : `\\b(?:include|including|add|adding|also)\\s+(?:the\\s+)?([a-z][a-z ,/&-]{1,80}?)\\s+${NOUN}\\b`).exec(s);
  if (!m) return [];
  return m[1].split(/\s*(?:,|\band\b|\bor\b|\/|&)\s*/).map((x) => x.replace(/\b(?:more|other|some|any|also|remote|paid)\b/g, " ").replace(/\s+/g, " ").trim())
    .filter((x) => x && x.split(" ").length <= 4 && !/\b(?:us|u\.s|usa|area)\b/.test(x));
}

export function widenedAsk(message: string, discovery: unknown, now: number = Date.now()): { ask: SearchAsk; changes: Widening[] } | null {
  const d = discovery as { lastAsk?: SearchAsk; lastAskAt?: number; lastShortlist?: { id?: string | null }[] } | null;
  const prev = d?.lastAsk;
  if (!prev || typeof prev !== "object" || typeof prev.role !== "string") return null;
  if (typeof d?.lastAskAt !== "number" || now - d.lastAskAt > CORRECTION_WINDOW_MS || now < d.lastAskAt) return null;
  const t = lc(message);
  if (!t || t.length > 400 || !CUE.test(t)) return null;
  const s = lc(searchSentence(String(message ?? "")));
  const changes: Widening[] = [];
  const named = rolesNamed(s);
  const had = prev.roles?.length ? prev.roles : [prev.role];
  const roles = [...new Set([...had, ...named].map(lc).filter(Boolean))];
  if (roles.length > had.length) changes.push("roles");
  let place = prev.place ?? null, area = !!prev.area;
  const ar = areaOf(s);
  if (ar) { place = ar; if (!area) changes.push("area"); area = true; }
  let remote = !!prev.remote, remoteRegion = prev.remoteRegion ?? null;
  if (/\bremote\b/.test(s)) {
    const us = remoteUsSaid(s);
    if (!remote || (us && remoteRegion !== "us")) changes.push(us ? "remote_us" : "remote");
    remote = true; if (us) remoteRegion = "us";
  }
  if (!changes.length) return null;
  const keep = (d?.lastShortlist ?? []).map((e) => String(e?.id ?? "")).filter(Boolean);
  return { ask: { ...prev, roles, place, area, remote, remoteOnly: false, remoteRegion, keep: [...new Set([...(prev.keep ?? []), ...keep])] }, changes };
}

// "the Chicago area", "greater Chicago", "Chicago suburbs" -> "chicago"
function areaOf(s: string): string | null {
  const AREA = "\\s+(?:area|metro(?:politan)?(?:\\s+area)?|suburbs)\\b";
  const a = new RegExp(`\\b(?:in|around|near)\\s+(?:the\\s+)?(?:greater\\s+)?([a-z][a-z.'-]*(?:\\s+[a-z][a-z.'-]*){0,2}?)${AREA}`).exec(s)
    ?? new RegExp(`\\b(?:the\\s+)?([a-z][a-z.'-]*(?:\\s+[a-z][a-z.'-]*)?)${AREA}`).exec(s) ?? /\bgreater\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*)?)\b/.exec(s);
  return a ? a[1].trim() : null;
}
const remoteUsSaid = (s: string) => /\bremote\s+(?:in\s+(?:the\s+)?)?(?:us|u\.s\.?|usa|united states)\b|\b(?:us|u\.s\.?|usa)[- ]remote\b|\bremote\b[^.]{0,30}\b(?:in|across) the (?:us|united states)\b/.test(s);

// F.1 (2026-11-08 6:02 pm): one search sentence that names several titles and places at once ("Find 3 verified open data
// analyst, business analyst or analytics internships in the Chicago area or remote in the US") is that whole scope, not one
// role made of every word.
export function withScope(ask: SearchAsk, message: string): SearchAsk {
  const s = lc(searchSentence(String(message ?? "")));
  const roles = rolesNamed(s, true), area = areaOf(s), us = /\bremote\b/.test(s) && remoteUsSaid(s);
  if (roles.length < 2 && !area && !us) return ask;
  return { ...ask, ...(roles.length >= 2 ? { role: roles[0], roles } : {}), ...(area ? { place: area, area: true } : {}), ...(us ? { remote: true, remoteOnly: false, remoteRegion: "us" as const } : {}) };
}

// F.1: "What is actually blocking the search: no open roles found, a search connection problem, or my unconfirmed resume?"
// asks about the last search: it is run again and the reply names the evidenced blocker (never an eligibility lecture).
export function isBlockerAsk(message: string): boolean {
  const t = lc(message);
  return /\b(?:what(?:'s| is)(?: actually| really)? (?:blocking|stopping|holding up)|why (?:is|was|did|does) (?:the|my|this) search|why (?:are there |were there )?(?:no|nothing|zero) (?:roles?|jobs?|postings?|internships?|results?))\b/.test(t)
    && /\b(?:search|postings?|roles?|jobs?|internships?|results?)\b/.test(t);
}
export function blockerAsk(message: string, discovery: unknown, now: number = Date.now()): SearchAsk | null {
  const d = discovery as { lastAsk?: SearchAsk; lastAskAt?: number } | null;
  if (!isBlockerAsk(message) || !d?.lastAsk || typeof d.lastAsk.role !== "string") return null;
  if (typeof d.lastAskAt !== "number" || now - d.lastAskAt > 2 * CORRECTION_WINDOW_MS || now < d.lastAskAt) return null;
  return d.lastAsk;
}
