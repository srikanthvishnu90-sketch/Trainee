// NETWORKING PIPELINE (2026-10-30): the parts of a Mapped-style outreach tool that need no external account, for ANY role or
// field. Pure functions over data the person gave: no network, no model, no send. Every name carries its source; an address
// is never guessed; a draft is held and bound to the exact payload; nothing here sends.
//
//   whatWeRead        the "what we read" summary from the person's confirmed facts (school, major, orgs, hometown, high
//                     school, sports, activities, interests) and what is still missing.
//   importContacts    a CSV the person provides (columns: name, firm, title, email, location, school, high school,
//                     hometown, sports, interests, orgs, source). Rows without a source or a name are set aside, never kept.
//   rankContacts      commonality ranking: hometown, sport, interest, school, high school, org, firm; each row shows the
//                     shared connection and where it came from.
//   draftFor          a per-contact first email (subject + body) that names the strongest shared connection and nothing the
//                     person has not confirmed; held, with the exact-payload hash.
//   confirmAddress    the person types the address back; only the sourced address (never a guess) can be confirmed.
//   sendWindow        the days and hours the person chose, with their own daily number; nextSlots schedules approved
//                     emails inside it. Nothing is scheduled for an unconfirmed address or an unapproved draft.
//   Pipeline          first email -> reply -> coffee chat -> done, notes per contact, booked meetings, and the counts
//                     (sent, replied, meetings, rates).
import { parseCsv } from "./career_people_import.ts";

const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const list = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").split(/[;|]/)).map((x) => String(x).trim()).filter(Boolean);
export async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------------------------------ what we read
export interface Fact { kind: string; value: string; status?: string; needs_confirmation?: boolean }
export interface Profile { name?: string; school: string; major: string; hometown: string; high_school: string; orgs: string[]; sports: string[]; activities: string[]; interests: string[]; employers: string[] }
const KIND: Record<string, keyof Profile> = { school: "school", university: "school", major: "major", majors: "major", hometown: "hometown", high_school: "high_school", org: "orgs", club: "orgs", sport: "sports", activity: "activities", interest: "interests", experience: "employers", employer: "employers", target_firm: "employers" };
const SCALAR = new Set(["school", "major", "hometown", "high_school"]);
export function profileOf(facts: Fact[]): Profile {
  const p: Profile = { school: "", major: "", hometown: "", high_school: "", orgs: [], sports: [], activities: [], interests: [], employers: [] };
  for (const f of facts ?? []) {
    if (!f || f.needs_confirmation || (f.status && f.status !== "confirmed")) continue; // only confirmed facts (D-007)
    const k = KIND[plain(f.kind).replace(/ /g, "_")]; const v = String(f.value ?? "").trim();
    if (!k || !v) continue;
    if (SCALAR.has(k)) (p as any)[k] = v; else if (!(p as any)[k].some((x: string) => plain(x) === plain(v))) (p as any)[k].push(v);
  }
  return p;
}
export function whatWeRead(facts: Fact[]): { profile: Profile; text: string; missing: string[] } {
  const p = profileOf(facts);
  const parts: string[] = [];
  if (p.school) parts.push(`you study${p.major ? ` ${p.major}` : ""} at ${p.school}`); else if (p.major) parts.push(`your major is ${p.major}`);
  if (p.hometown) parts.push(`you are from ${p.hometown}`);
  if (p.high_school) parts.push(`you went to ${p.high_school}`);
  if (p.orgs.length) parts.push(`you are in ${p.orgs.join(", ")}`);
  if (p.sports.length) parts.push(`you play ${p.sports.join(", ")}`);
  if (p.activities.length) parts.push(`you do ${p.activities.join(", ")}`);
  if (p.interests.length) parts.push(`you are into ${p.interests.join(", ")}`);
  const missing = [["school", p.school], ["hometown", p.hometown], ["high school", p.high_school], ["a sport, club or interest", [...p.sports, ...p.orgs, ...p.interests].join("")]].filter(([, v]) => !v).map(([k]) => k as string);
  const text = parts.length
    ? `Here is what I read: ${parts.join("; ")}. Tell me if anything is off${missing.length ? `, and add ${missing.slice(0, 2).join(" or ")} if you want warmer matches` : ""}.`
    : "I have not read anything about you yet. Tell me your school, hometown and one sport, club or interest and I will match people on them.";
  return { profile: p, text, missing };
}

// ------------------------------------------------------------------------------------------------ contacts
export type SourceKind = "user_linkedin_export" | "pasted" | "alumni_export" | "firm_team_page" | "user_csv";
export const SOURCE_KINDS: SourceKind[] = ["user_linkedin_export", "pasted", "alumni_export", "firm_team_page", "user_csv"];
export interface Contact {
  id: string; name: string; firm: string; title: string; location: string; school: string; high_school: string; hometown: string;
  sports: string[]; interests: string[]; orgs: string[]; email: string | null; address: "sourced" | "none"; source: SourceKind; source_note: string;
}
export interface ImportResult { contacts: Contact[]; set_aside: { row: number; why: string; ask?: true }[] }
const HEAD: Record<string, string> = { name: "name", "full name": "name", firm: "firm", company: "firm", employer: "firm", title: "title", role: "title", position: "title", email: "email", "email address": "email", location: "location", city: "location", school: "school", university: "school", "high school": "high_school", highschool: "high_school", hometown: "hometown", sports: "sports", sport: "sports", interests: "interests", interest: "interests", orgs: "orgs", clubs: "orgs", activities: "orgs", source: "source" };
// The source gate is exact. A source is one of the five kinds, spelled as the kind or as one of the whole-string aliases below.
// Any other text is split into tokens: one that names a site we never use or a way of getting names we never use (LinkedIn,
// Indeed, Handshake, scraping, a database, a guess, a bought list) is refused; anything else is unclear and the person is asked.
const ALIASES: Record<string, SourceKind> = {
  user_csv: "user_csv", csv: "user_csv", my_csv: "user_csv", my_own_csv: "user_csv", user_provided_csv: "user_csv",
  pasted: "pasted", pasted_names: "pasted", names_i_pasted: "pasted",
  alumni_export: "alumni_export", school_alumni_directory: "alumni_export", alumni_directory_export: "alumni_export", alumni_directory: "alumni_export",
  firm_team_page: "firm_team_page", team_page: "firm_team_page", firm_team_pages: "firm_team_page",
  user_linkedin_export: "user_linkedin_export", own_linkedin_export: "user_linkedin_export", my_linkedin_export: "user_linkedin_export", linkedin_export: "user_linkedin_export", linkedin_connections_export: "user_linkedin_export",
};
const REFUSED_TOKENS = new Set(["linkedin", "indeed", "handshake", "scrape", "scraped", "scraper", "scraping", "crawl", "crawled", "crawler", "database", "db", "guess", "guessed", "guessing", "infer", "inferred", "pattern", "bought", "buy", "purchased", "purchase", "apollo", "zoominfo", "lusha", "rocketreach", "navigator", "sales", "leaked", "dump"]);
export type SourceVerdict = { kind: "ok"; source: SourceKind } | { kind: "refused"; token: string } | { kind: "ask" };
// Compatibility-normalize (fullwidth "ｌｉｎｋｅｄｉｎ" becomes "linkedin"), drop zero-width and bidi control characters, then read.
// The blank fallback is only for a string that is empty or spaces to begin with. A non-empty string that maps to no kind and
// no refused token (Cyrillic, CJK, symbols only) is unclear: ask.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
export function sourceVerdict(raw: string, fallback: SourceKind): SourceVerdict {
  const text = String(raw ?? "");
  if (text.trim() === "") return { kind: "ok", source: fallback };
  const norm = text.normalize("NFKC").replace(INVISIBLE, "");
  const tokens = plain(norm).split(" ").filter(Boolean);
  if (!tokens.length) return { kind: "ask" };
  const key = tokens.join("_");
  const asciiOnly = /^[\x20-\x7e]+$/.test(norm.trim());
  if (asciiOnly && ALIASES[key]) return { kind: "ok", source: ALIASES[key] };
  const bad = tokens.find((t) => REFUSED_TOKENS.has(t));
  if (bad) return { kind: "refused", token: bad };
  return { kind: "ask" };
}
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
// A CSV the person provides. `defaultSource` is what the file is (the person says it); a row may name its own source. A row
// with no name, or a source that is not one of the five, is set aside with the reason. An address is kept only as the file
// gave it; one is never built from a name and a domain.
export function importContacts(csv: string, defaultSource: SourceKind = "user_csv"): ImportResult {
  const rows = parseCsv(String(csv ?? ""), 20000);
  const out: ImportResult = { contacts: [], set_aside: [] };
  if (rows.length < 2) return out;
  const cols = rows[0].map((h) => HEAD[plain(h)] ?? null);
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const row: Record<string, string> = {}; cols.forEach((c, j) => { if (c) row[c] = String(r[j] ?? "").trim(); });
    if (!row.name) { out.set_aside.push({ row: i + 2, why: "no name" }); return; }
    if (/^[=+\-@]/.test(row.name) || /ignore|instruction|system prompt/i.test(Object.values(row).join(" "))) { out.set_aside.push({ row: i + 2, why: "cell reads as a formula or instruction" }); return; }
    const v = sourceVerdict(row.source ?? "", defaultSource);
    if (v.kind === "refused") { out.set_aside.push({ row: i + 2, why: `source "${row.source}" is refused ("${v.token}"): names come only from ${SOURCE_KINDS.join(", ")}` }); return; }
    if (v.kind === "ask") { out.set_aside.push({ row: i + 2, why: `source "${row.source}" is unclear: which is it, ${SOURCE_KINDS.join(", ")}?`, ask: true }); return; }
    const source = v.source;
    const email = row.email && EMAIL.test(row.email) ? row.email.toLowerCase() : null;
    const key = `${plain(row.name)}|${plain(row.firm)}`;
    if (seen.has(key)) { out.set_aside.push({ row: i + 2, why: "duplicate of an earlier row" }); return; }
    seen.add(key);
    out.contacts.push({ id: `c${out.contacts.length + 1}`, name: row.name, firm: row.firm ?? "", title: row.title ?? "", location: row.location ?? "", school: row.school ?? "", high_school: row.high_school ?? "", hometown: row.hometown ?? "", sports: list(row.sports), interests: list(row.interests), orgs: list(row.orgs), email, address: email ? "sourced" : "none", source, source_note: `${source}, row ${i + 2}` });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ commonality
export type CommonKind = "hometown" | "high_school" | "school" | "sport" | "org" | "interest" | "firm";
export interface Common { kind: CommonKind; value: string; weight: number; sentence: string }
const WEIGHT: Record<CommonKind, number> = { sport: 5, hometown: 5, high_school: 4, org: 4, interest: 3, school: 3, firm: 2 };
export function commonalities(p: Profile, c: Contact): Common[] {
  const out: Common[] = [];
  const add = (kind: CommonKind, value: string, sentence: string) => out.push({ kind, value, weight: WEIGHT[kind], sentence });
  const eq = (a: string, b: string) => !!plain(a) && plain(a) === plain(b);
  if (eq(p.hometown, c.hometown)) add("hometown", c.hometown, `we are both from ${c.hometown}`);
  if (eq(p.high_school, c.high_school)) add("high_school", c.high_school, `we both went to ${c.high_school}`);
  if (eq(p.school, c.school)) add("school", c.school, `we both went to ${c.school}`);
  for (const s of p.sports) if (c.sports.some((x) => eq(x, s))) add("sport", s, `we both play ${s}`);
  for (const o of p.orgs) if (c.orgs.some((x) => eq(x, o))) add("org", o, `we were both in ${o}`);
  for (const i of p.interests) if (c.interests.some((x) => eq(x, i))) add("interest", i, `we share an interest in ${i}`);
  for (const e of p.employers) if (eq(e, c.firm)) add("firm", c.firm, `I am aiming at ${c.firm}`);
  return out.sort((a, b) => b.weight - a.weight);
}
export interface Ranked { contact: Contact; score: number; common: Common[]; shared: string; line: string }
export function rankContacts(p: Profile, contacts: Contact[]): Ranked[] {
  return contacts.map((c) => {
    const common = commonalities(p, c);
    const score = common.reduce((n, x) => n + x.weight, 0);
    const shared = common.length ? common.map((x) => x.value).join(", ") : "none on file";
    return { contact: c, score, common, shared, line: `${c.name}, ${c.title || "role not listed"} at ${c.firm || "firm not listed"}${c.location ? `, ${c.location}` : ""} - shared: ${shared} (source: ${c.source_note})` };
  }).sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name));
}

// ------------------------------------------------------------------------------------------------ drafts
export interface Draft { contact_id: string; to: string | null; subject: string; body: string; common: Common | null; status: "held"; address_confirmed: boolean; hash: string; resume_attached: boolean }
const first = (n: string) => n.trim().split(/\s+/)[0] || n;
// The first email for one contact, in the person's voice, any field. It names the strongest shared connection and what the
// person asked for (a short chat), and states nothing the confirmed facts do not carry. Held; never sent from here.
export async function draftFor(p: Profile, r: Ranked, o: { senderName: string; ask?: string; attachResume?: boolean } = { senderName: "" }): Promise<Draft> {
  const c = r.contact, top = r.common[0] ?? null;
  const field = c.title ? ` as ${/^[aeiou]/i.test(c.title) ? "an" : "a"} ${c.title}` : "";
  const intro = p.school ? `I am a ${p.major ? p.major + " student" : "student"} at ${p.school}` : "I am exploring a move into your field";
  const link = top ? `${top.sentence.charAt(0).toUpperCase()}${top.sentence.slice(1)}, which is why I am writing.` : `I found you through ${c.source_note}.`;
  const subject = top ? `${top.kind === "firm" ? `Question about ${c.firm}` : `Fellow ${top.value} - quick question`}` : `Quick question about your work at ${c.firm || "your firm"}`;
  const body = `Hi ${first(c.name)},\n\n${intro}. ${link} I would value 15 minutes to hear how you got to your work${field}${c.firm ? ` at ${c.firm}` : ""}${o.ask ? `, and ${o.ask}` : ""}.\n\nIf now is not a good time, no problem at all.\n\n${o.senderName}`.trim();
  const confirmed = false;
  return { contact_id: c.id, to: c.email, subject, body, common: top, status: "held", address_confirmed: confirmed, resume_attached: !!o.attachResume, hash: await sha256(JSON.stringify([c.email, subject, body, !!o.attachResume])) };
}
// Many at once: ranked order, every draft held, one list back with the count.
export async function draftAll(p: Profile, ranked: Ranked[], o: { senderName: string; ask?: string; attachResume?: boolean }): Promise<{ drafts: Draft[]; notice: string }> {
  const drafts: Draft[] = [];
  for (const r of ranked) drafts.push(await draftFor(p, r, o));
  return { drafts, notice: `${drafts.length} drafts are ready and held. Nothing is sent until you confirm each address and approve each email.` };
}
// The person edits a draft: the body changes, the hash follows, and any earlier approval no longer matches.
export async function editDraft(d: Draft, body: string): Promise<Draft> {
  return { ...d, body, address_confirmed: d.address_confirmed, hash: await sha256(JSON.stringify([d.to, d.subject, body, d.resume_attached])) };
}

// ------------------------------------------------------------------------------------------------ confirm the address
export type AddressResult = { ok: true; address: string } | { ok: false; why: string };
// The person types the address back. Only the address the source gave can be confirmed; a different one is a new address from
// the person (their own words) and is taken as such only when it is well formed, flagged "typed by you", never guessed by us.
export function confirmAddress(c: Contact, typed: string): AddressResult {
  const t = String(typed ?? "").trim().toLowerCase();
  if (!EMAIL.test(t)) return { ok: false, why: "That is not a complete email address." };
  if (c.email && t === c.email) return { ok: true, address: t };
  if (!c.email) return { ok: true, address: t };
  return { ok: false, why: `The address on file from ${c.source_note} is ${c.email}. Type that one to confirm it, or tell me it is wrong and paste the right one.` };
}

// The draft after the person confirmed the address: the address is part of the payload, so the hash follows it.
export async function withConfirmedAddress(d: Draft, address: string): Promise<Draft> {
  return { ...d, to: address, address_confirmed: true, hash: await sha256(JSON.stringify([address, d.subject, d.body, d.resume_attached])) };
}

// ------------------------------------------------------------------------------------------------ send windows
export interface Window { days: number[]; startHour: number; endHour: number; tzOffsetMin: number; dailyNumber: number }
export function sendWindow(o: Partial<Window> & { dailyNumber: number }): Window {
  const days = (o.days?.length ? o.days : [1, 2, 3, 4, 5]).filter((d) => d >= 0 && d <= 6);
  const startHour = Math.min(23, Math.max(0, o.startHour ?? 9)), endHour = Math.min(24, Math.max(startHour + 1, o.endHour ?? 17));
  return { days: days.length ? days : [1, 2, 3, 4, 5], startHour, endHour, tzOffsetMin: o.tzOffsetMin ?? 0, dailyNumber: Math.max(1, Math.floor(o.dailyNumber)) };
}
export interface Ready { draft: Draft; approvedHash: string | null }
// Slots for approved, confirmed emails inside the person's days and hours, at most dailyNumber a day, spread through the
// hours. A draft whose address is unconfirmed, that is not approved, or whose text changed since approval gets no slot.
export function nextSlots(ready: Ready[], w: Window, nowMs: number): { slots: { contact_id: string; at: string }[]; skipped: { contact_id: string; why: string }[] } {
  const slots: { contact_id: string; at: string }[] = [], skipped: { contact_id: string; why: string }[] = [];
  const eligible = ready.filter((r) => {
    if (!r.draft.address_confirmed) { skipped.push({ contact_id: r.draft.contact_id, why: "address not confirmed" }); return false; }
    if (!r.approvedHash) { skipped.push({ contact_id: r.draft.contact_id, why: "not approved" }); return false; }
    if (r.approvedHash !== r.draft.hash) { skipped.push({ contact_id: r.draft.contact_id, why: "changed since you approved it" }); return false; }
    return true;
  });
  const local = (ms: number) => new Date(ms + w.tzOffsetMin * 60000);
  let day = Math.floor((nowMs + w.tzOffsetMin * 60000) / 86400000), used = 0, i = 0;
  const per = w.dailyNumber, span = (w.endHour - w.startHour) * 3600000;
  while (i < eligible.length && day < Math.floor(nowMs / 86400000) + 400) {
    const dow = new Date(day * 86400000).getUTCDay();
    if (w.days.includes(dow)) {
      for (used = 0; used < per && i < eligible.length; used++) {
        const at = day * 86400000 + w.startHour * 3600000 + Math.floor((span * (used + 0.5)) / per) - w.tzOffsetMin * 60000;
        if (at < nowMs) continue;
        slots.push({ contact_id: eligible[i].draft.contact_id, at: new Date(at).toISOString() }); i++;
      }
    }
    day++;
  }
  void local;
  return { slots, skipped };
}

// ------------------------------------------------------------------------------------------------ pipeline + analytics
export const STAGES = ["drafted", "approved", "sent", "replied", "chat_booked", "chat_done"] as const;
export type Stage = typeof STAGES[number];
export interface Entry { contact_id: string; stage: Stage; notes: { at: string; text: string }[]; meeting_at: string | null; history: { stage: Stage; at: string }[] }
export class Pipeline {
  entries = new Map<string, Entry>();
  add(contact_id: string, at: string): Entry { const e: Entry = { contact_id, stage: "drafted", notes: [], meeting_at: null, history: [{ stage: "drafted", at }] }; this.entries.set(contact_id, e); return e; }
  move(contact_id: string, stage: Stage, at: string, meetingAt?: string): Entry {
    const e = this.entries.get(contact_id); if (!e) throw new Error("not on the pipeline");
    if (STAGES.indexOf(stage) < STAGES.indexOf(e.stage)) throw new Error(`cannot move back from ${e.stage} to ${stage}`);
    if (stage === "chat_booked") { if (!meetingAt) throw new Error("a booked chat needs its time"); e.meeting_at = meetingAt; }
    e.stage = stage; e.history.push({ stage, at }); return e;
  }
  note(contact_id: string, text: string, at: string) { const e = this.entries.get(contact_id); if (!e) throw new Error("not on the pipeline"); e.notes.push({ at, text: String(text).slice(0, 2000) }); }
  calendar(): { contact_id: string; at: string }[] { return [...this.entries.values()].filter((e) => e.meeting_at && e.stage === "chat_booked").map((e) => ({ contact_id: e.contact_id, at: e.meeting_at! })).sort((a, b) => a.at.localeCompare(b.at)); }
  analytics() {
    const reached = (s: Stage) => [...this.entries.values()].filter((e) => STAGES.indexOf(e.stage) >= STAGES.indexOf(s)).length;
    const sent = reached("sent"), replied = reached("replied"), meetings = reached("chat_booked");
    const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
    return { drafted: this.entries.size, approved: reached("approved"), sent, replied, meetings, reply_rate_pct: pct(replied, sent), meeting_rate_pct: pct(meetings, sent) };
  }
}
