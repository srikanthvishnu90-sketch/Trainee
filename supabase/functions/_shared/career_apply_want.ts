// WO-066: from chat to applying. When the person asks Trainee to apply, the brain puts real postings into the person's
// own apply queue (career_apply_wanted); the Trainee extension takes them, prepares each in the person's browser and
// shows a card; nothing reaches an employer before they approve that card. A posting is keyed exactly as the extension
// keys it (posting_key.ts), so the same posting is queued once and the extension's own queue never holds it twice.
import { applyUrl, detectPortal, formUrlFor, postingKey } from "./posting_key.ts";
import { COMPANY_COOLDOWN_DAYS, dailyLimit, type Limits, normCompany } from "./career_apply.ts";
import { sameCompany, type TrackedApp } from "./career_mail.ts";
import { contentOf, type GateResult, gatePicks } from "./career_apply_gate.ts";

export interface Want { posting_key: string; url: string; company: string; title: string; queued_at: string }
export interface WantRow extends Want { state: "waiting" | "taken" }
// FEATURE 1 (2026-10-25): the store may refuse an item itself (career_apply_want_put_for, 20261026100001): the person's
// own daily pace and the 30-day employer rule are enforced in SQL too, so a race past the screens here still queues nothing.
export interface StoreRefusal { posting_key: string; reason: "company_cooldown" | "daily_cap" | string }
export interface WantStore {
  put(userId: string, items: Want[]): Promise<{ added: Want[]; already: string[]; refused?: StoreRefusal[] }>;
  list(userId: string): Promise<WantRow[]>;
  queuedSince(userId: string, sinceIso: string): Promise<number>;
}

const NEVER = /(^|\.)(linkedin\.com|indeed\.com)$/i;
const host = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

import type { PostingContent } from "./career_apply_gate.ts";
export interface Pick { url?: string; job_id?: string; company?: string; title?: string; location?: string; content?: PostingContent }
// WO-091b: a refused pick names the posting and the reason, so the model says exactly what happened. `url` and `why` are
// the same refusal in WO-066's words, kept for its callers.
// SERIAL-1490: `ask` marks a refusal that is a question to the person (a possible current-employer match): the posting
// is not queued until they answer it, and the chat asks it once.
// `reason` is for the model (it may tell it what to do next, about "they"); `said` is the same refusal in words to the person
// ("you", "your"), what a chat reply shows them. Without its own wording, `said` is the reason.
// Reqs doc 2 Q395: `prior` marks a refusal because of an earlier application (this exact posting, or this employer inside
// the cooldown), so the chat can say that application's date and outcome from the record.
export interface Refusal { posting: { job_id: string | null; company: string; title: string; url: string }; reason: string; said: string; url: string; why: string; ask?: "employer" | "fact"; prior?: "posting" | "company" }
export function refusal(p: Pick, reason: string, said = reason): Refusal {
  const url = String(p?.url ?? "").trim();
  return { posting: { job_id: p?.job_id ? String(p.job_id) : null, company: String(p?.company ?? ""), title: String(p?.title ?? ""), url }, reason, said, url, why: reason };
}

// One posting, compared: its key without case. A posting's id is unique on its board (a Greenhouse job number, a Lever or
// Ashby posting id, a Workday requisition), so "jobs.lever.co/Acme/<id>" and "jobs.lever.co/acme/<id>" are one posting;
// the key itself keeps the link's case (the board's own reads use it).
export const samePosting = (key: string | null | undefined) => key ? key.toLowerCase() : null;
// The posting a pick names: its board's form when it is known by its id (WO-078: a shelf posting shown on the employer's
// own careers page), else its link. The same rule wantsFrom queues by.
const pickLink = (p: Pick) => formUrlFor(String(p?.job_id ?? "")) ?? String(p?.url ?? "").trim();

// The postings the brain picked, kept when each is a real application link the extension can open; refused with why.
export function wantsFrom(picks: Pick[], now: number): { ok: Want[]; refused: Refusal[] } {
  const ok: Want[] = [], refused: Refusal[] = [], seen = new Set<string>();
  for (const p of picks) {
    // WO-078: a shelf posting is queued at its board's own form, whatever its public link (an employer's careers page).
    const url = pickLink(p);
    if (NEVER.test(host(url))) { refused.push(refusal({ ...p, url }, "LinkedIn and Indeed are never automated; the person applies there themselves", "Trainee never applies on LinkedIn or Indeed; apply there yourself")); continue; }
    const key = detectPortal(url) ? postingKey(url) : null;
    if (!key) { refused.push(refusal({ ...p, url }, "not a Greenhouse, Lever, Ashby or Workday posting link I can open yet")); continue; }
    if (seen.has(samePosting(key)!)) continue;
    seen.add(samePosting(key)!);
    ok.push({ posting_key: key, url: applyUrl(url), company: String(p.company ?? "").slice(0, 200), title: String(p.title ?? "").slice(0, 200), queued_at: new Date(now).toISOString() });
  }
  return { ok, refused };
}

// The start of the person's day (UTC when the zone is unknown), for the daily limit.
export function dayStart(now: number, tz = "UTC"): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now));
    const n = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    const sinceMidnight = ((n("hour") % 24) * 3600 + n("minute") * 60 + n("second")) * 1000;
    return new Date(now - sinceMidnight - (now % 1000)).toISOString();
  } catch {
    return new Date(now - (now % 86_400_000)).toISOString();
  }
}

// Queue what fits under today's limit; what is over is refused with the limit named.
// No product ceiling on how many a person queues (owner, 2026-10-22; CAPS-1390): room is computed only against a daily
// pace the person set themselves; the once-per-employer screen, the exact-payload approval on each card and the site
// limits stand.
export async function queueWants(store: WantStore, userId: string, picks: Pick[], now: number, o: { limits?: Limits; tz?: string } = {}) {
  const { ok, refused } = wantsFrom(picks, now);
  // SERIAL-1430: a saved pace that cannot be read is unknown, not "no limit": nothing is queued, each pick refused by name.
  if (o.limits?.unreadable !== undefined || Number.isNaN(dailyLimit(o.limits))) {
    for (const w of ok) refused.push(refusal({ ...w, job_id: w.posting_key }, `their saved daily pace could not be read (it says ${JSON.stringify(String(o.limits?.unreadable ?? ""))}); nothing was queued until they set it again ("set my daily pace to N", or "no daily pace")`,
      `your saved daily pace couldn't be read (it says ${JSON.stringify(String(o.limits?.unreadable ?? ""))}); nothing was queued until you set it again ("set my daily pace to N", or "no daily pace")`));
    return { queued: 0, already: 0, items: [] as Want[], refused, limit: null as number | null };
  }
  const cap = dailyLimit(o.limits);
  const used = Number.isFinite(cap) ? await store.queuedSince(userId, dayStart(now, o.tz)) : 0;
  const room = Math.max(0, cap - used);
  const have = new Set((await store.list(userId)).map((w) => samePosting(w.posting_key)));
  const fresh = ok.filter((w) => !have.has(samePosting(w.posting_key)));
  const take = fresh.slice(0, room);
  for (const w of fresh.slice(room)) refused.push(refusal({ ...w, job_id: w.posting_key }, `over the daily pace they set themselves (${cap} a day)`, `over the daily pace you set (${cap} a day)`));
  const r = await store.put(userId, take);
  for (const x of r.refused ?? []) {
    const w = take.find((t) => t.posting_key === x.posting_key);
    if (!w) continue;
    const pace = Number.isFinite(cap) ? ` (${cap} a day)` : "";
    refused.push(x.reason === "company_cooldown"
      ? { ...refusal({ ...w, job_id: w.posting_key }, `they already applied to ${w.company || "this employer"} in the last ${COMPANY_COOLDOWN_DAYS} days (the queue's own record); Trainee applies once per company every ${COMPANY_COOLDOWN_DAYS} days; nothing was queued`,
        `you already applied to ${w.company || "this employer"} in the last ${COMPANY_COOLDOWN_DAYS} days; Trainee applies once per company every ${COMPANY_COOLDOWN_DAYS} days, so nothing was queued`), prior: "company" as const }
      : x.reason === "daily_cap" ? refusal({ ...w, job_id: w.posting_key }, `over the daily pace they set themselves${pace}`, `over the daily pace you set${pace}`)
      // D-MS-3: the queue's own record has this exact posting already sent or in flight (any path, any link to it).
      : x.reason === "duplicate_job" ? { ...refusal({ ...w, job_id: w.posting_key }, `${w.title || "this posting"} at ${w.company || "this employer"} is already in their applications as the same posting; nothing was queued`,
        `${w.title || "this posting"} at ${w.company || "this employer"} is already in your applications as the same posting; nothing was queued`), prior: "posting" as const }
      : refusal({ ...w, job_id: w.posting_key }, `the queue refused it (${x.reason})`));
  }
  return { queued: r.added.length, already: ok.length - fresh.length + r.already.length, items: r.added, refused, limit: Number.isFinite(cap) ? cap : null };
}

// ------------------------------------------------------------------------------------------------ WO-091b: what a pick means
// Audit chat-brain F2 (BR-023, BR-018, BR-019, BR-021): the model's picks were queued as given. Code now checks what each
// one means before it reaches the queue; the extension's card stays the approval of each application.

// Each pick is resolved by its job_id (or its link's own posting key, the same id) through the postings on file, and its
// employer, title and link come from that record, never from the model. One not on file, or closed, is refused. With no
// posting reader (a caller that has none), the picks stay as given.
export async function resolvePicks(picks: Pick[], get?: ((jobId: string) => Promise<any | null>) | null): Promise<{ ok: Pick[]; refused: Refusal[] }> {
  if (!get) return { ok: picks, refused: [] };
  const ok: Pick[] = [], refused: Refusal[] = [];
  for (const p of picks) {
    const id = String(p?.job_id ?? "").trim() || (p?.url ? postingKey(String(p.url)) ?? "" : "");
    const rec = id ? await get(id) : null;
    if (!rec) {
      refused.push(refusal(p, "not found among the postings on file (it may have closed, or was never listed); nothing was queued for it. Search again, or the person can paste the posting's link in chat",
        "not found among the postings on file (it may have closed, or was never listed); nothing was queued for it. Paste its link here and I'll check it"));
      continue;
    }
    const real: Pick = { job_id: String(rec.job_id ?? id), url: String(rec.url || p.url || ""), company: String(rec.company ?? ""), title: String(rec.title ?? ""), location: String(rec.location ?? ""), content: contentOf(rec) };
    if (rec.closed_at) { refused.push(refusal(real, `${real.title} at ${real.company} has closed; nothing was queued for it`)); continue; }
    ok.push(real);
  }
  return { ok, refused };
}

// Employer names compared without case, punctuation or "Inc"/"LLC" (career_apply.ts normCompany, the queue's own rule).
// A one-word stand-in for a longer name ("Copperline" for "Copperline Infra") counts only when that word is distinctive.
const COMMON = new Set(("new first general american national united global international data remote software systems digital health bank capital " +
  "financial solutions services technologies technology tech labs energy home city state north south east west central operations jobs job analyst " +
  "engineer engineering grad senior junior early career careers role roles apply platform product design sales marketing research open big blue red " +
  "green smart true next one all best great pacific atlantic summit peak bright clear prime core cloud network media partners consulting associates " +
  "ventures foods insurance medical care community remote work part time full").split(" "));
const words = (s: unknown) => normCompany(s).split(" ").filter(Boolean);
// An employer's name is its first line: whatever a stored company field carries after a line break or control character
// (a pasted paragraph, an injected heading) is not part of the name the person types.
const nameLine = (s: unknown) => String(s ?? "").split(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, 1)[0];
const SUFFIX_WORDS = new Set(["inc", "llc", "ltd", "corp", "corporation", "company", "group", "holdings", "limited", "plc"]);
const distinctiveOf = (ws: string[]) => ws.filter((w) => w.length >= 4 && !COMMON.has(w) && !SUFFIX_WORDS.has(w));
// Two contracts over one matcher (SERIAL-1490/1491), kept apart on purpose:
//   namesEmployer (selection): does this text name this employer? Strict: a company with two or more distinctive words
//     needs every one of them in a run. Used to pick the posting the person asked for; a miss costs a question, never a
//     wrong employer.
//   employerMatch (the protective screen): could this employer be where the person works now? "yes" when the text names
//     it; "possible" when the two share their leading distinctive word but one name is longer ("I work at Acme" against
//     "Acme Robotics Inc", or "I work at Acme Robotics Inc" against "Acme"); "no" otherwise. A possible match is asked
//     once and queues nothing until answered: the wrong direction (applying to their own employer unasked) is worse than
//     an extra question.
export function namesEmployer(text: unknown, company: unknown): boolean {
  const co = words(nameLine(company)), t = words(text);
  if (!co.length || !t.length) return false;
  if (` ${t.join(" ")} `.includes(` ${co.join(" ")} `)) return true;
  // SERIAL-1480: a company with two or more distinctive words is named only by a run of words that carries every one of
  // them ("Acme Robotics" is not "Acme Health", "TEST Chat Employer" is not "TEST Current Employer"); one shared leading word
  // is not it, and sameCompany's alias leniency (a dropped suffix, a leading-words match) does not apply to that run.
  const distinctive = distinctiveOf(co);
  if (distinctive.length >= 2) {
    for (let n = distinctive.length; n <= Math.min(6, t.length); n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const g = t.slice(i, i + n);
        if (distinctive.every((w) => g.includes(w))) return true;
      }
    }
    return false;
  }
  // SERIAL-1491: a one-word match is not the employer when the text's name goes on with a distinctive word the company
  // lacks ("Acme Robotics Inc" in the text is not the posting at "Acme Health"; "Acme Health" still is, "health" being a
  // common word).
  const foreign = (w: string | undefined) => !!w && w.length >= 4 && !COMMON.has(w) && !SUFFIX_WORDS.has(w) && !co.includes(w);
  for (let n = 1; n <= Math.min(4, co.length + 1); n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n);
      if (n === 1 && (g[0].length < 4 || COMMON.has(g[0]))) continue;
      if (foreign(t[i - 1]) || foreign(t[i + n])) continue;
      if (sameCompany(g.join(" "), co.join(" "))) return true;
    }
  }
  return false;
}
export type EmployerMatch = "yes" | "possible" | "no";
const core = (name: unknown) => words(nameLine(name)).filter((w) => !SUFFIX_WORDS.has(w));
export function employerMatch(text: unknown, company: unknown): EmployerMatch {
  const co = words(nameLine(company)), t = words(text);
  if (!co.length || !t.length) return "no";
  const coD = distinctiveOf(co), cc = core(company);
  // The employers the text names: after "at", or the text itself when it is a bare name (a current_employer fact's value).
  const named = [...employersNamed(String(text ?? "")), ...(t.length <= 5 ? [String(text ?? "")] : [])].map(core).filter((n) => n.length);
  const prefix = (a: string[], b: string[]) => a.length < b.length && a.every((w, i) => b[i] === w);
  for (const n of named) {
    if (n.join(" ") === cc.join(" ")) return "yes";
    // One name the leading words of the other, in either direction ("Acme" at work and a posting at "Acme Robotics Inc";
    // "Acme Robotics Inc" at work and a posting at "Acme"; "Acme" and "Acme Health"): possible, asked, never passed.
    if (prefix(n, cc) || prefix(cc, n)) return "possible";
  }
  // No named employer to compare (the text has no "at <Name>" and is not a bare name): the selection rule decides.
  if (!named.length && namesEmployer(text, company)) return "yes";
  // A shared leading distinctive word ("Acme Robotics Inc" at work, a posting at "Acme Health"): possible.
  if (coD.length && t.includes(coD[0])) return "possible";
  return "no";
}
// The employers a message names after "at" ("the operations role at Quickhire Remote Jobs"), capitalized as names are.
export function employersNamed(message: string): string[] {
  const out: string[] = [];
  for (const clause of String(message ?? "").split(/[!?;,\n]|\.(?=\s|$)/)) {
    for (const m of clause.matchAll(/\bat\s+((?:[A-Z][\w&.'’-]*)(?:[ \t]+(?:[A-Z][\w&.'’-]*|&|of|and))*)/g)) {
      const name = m[1].replace(/(\s+(and|of|&))+$/i, "").trim();
      if (name) out.push(name);
    }
  }
  return out;
}
// A pick by position from what was shown ("the first one", "#2", "1 and 3", "these"): it must be one the previous turn
// showed. A broad ask ("apply me to 25 data analyst jobs") leaves the employers to the search. Anything else that names
// no employer ("the operations role", "yes") refers to what was shown too.
const BY_POSITION = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last (one|two|three|\d+)|top (one|two|three|four|five|\d+)|both|these|those|them|all of (them|these|those)|above|you (showed|listed|found|sent))\b|#\s?\d+\b|\b(number|no\.)\s?\d+\b|\b\d+(st|nd|rd|th)\b|\b\d+\s*(,|and|&)\s*\d+\b/i;
const BROAD = /\b(\d+|a few|some|several|all|any|every|more|many)\b|\b(jobs|roles|positions|postings|openings|internships)\b/i;

// A confirmed fact (D-007) that says the person works at this employer now. Drafts, past jobs and wishes do not count.
const NOW_WORDS = /\b(current(ly)?|presently|present|now|still|i work|i'?m working|i am working|i'?m employed|i am employed|works? (at|for)|working (at|for)|employed (at|by))\b/i;
const PAST_WORDS = /\b(former(ly)?|previous(ly)?|used to|ex|left|until|interned|worked|was|were)\b/i;
const WISH_WORDS = /\b(want|wants|hope|goal|dream|would like|aspire|target|interested)\b/i;
// A fact's reading against this employer by the protective screen's contract (employerMatch), or "no" when the fact is
// not about where they work now.
function employerFactMatch(f: any, company: string): EmployerMatch {
  if (!f || f.needs_confirmation || f.status === "draft") return "no";
  const text = String(f.text ?? f.value ?? "");
  if (f.key === "current_employer" || f.kind === "current_employer") return employerMatch(text, company);
  if (["goal", "preference", "skill", "education", "location"].includes(String(f.kind))) return "no";
  return NOW_WORDS.test(text) && !PAST_WORDS.test(text) && !WISH_WORDS.test(text) ? employerMatch(text, company) : "no";
}
export function currentEmployerFact(company: string, facts: any[]): any | null {
  return (facts ?? []).find((f) => employerFactMatch(f, company) === "yes") ?? null;
}
// SERIAL-1490: a fact that may name this employer (a shared leading distinctive word, one name longer): asked, never passed.
export function possibleEmployerFact(company: string, facts: any[]): any | null {
  return (facts ?? []).find((f) => employerFactMatch(f, company) === "possible") ?? null;
}
// The person's answer to that question, kept on the thread (SERIAL-1491): is this company where they work now?
export interface EmployerAnswer { company: string; is_employer: boolean }
export const employerQuestion = (company: string) => `is ${company} where you work now?`;
// Their knowing go-ahead, in their own words this turn ("I know I work there, apply anyway").
const GO_AHEAD = /\b(anyway|regardless|even though|internal(ly)?|knowing|i know (i|it|that|they|this))\b/i;

// Each resolved pick, checked against what the person said this turn (`message`), what the previous turn showed them
// (`before`; undefined when the caller has no history), their applications and their confirmed facts.
// `resolved` (SERIAL-1491): the person's answers to the possible-match question in this thread; "no" clears a possible
// match for that company (and no other), "yes" makes it their employer in their own words.
export function screenPicks(picks: Pick[], o: { message?: string; before?: string; apps: TrackedApp[]; facts: any[]; now: number; resolved?: EmployerAnswer[] }): { ok: Pick[]; refused: Refusal[]; gate: GateResult } {
  const passed: Pick[] = [], refused: Refusal[] = [];
  const message = o.message ?? "";
  const answered = (co: string) => (o.resolved ?? []).filter((a) => a && a.company && sameCompany(a.company, co)).map((a) => !!a.is_employer).pop();
  const named = o.message === undefined ? [] : employersNamed(message);
  const byReference = o.message !== undefined && (BY_POSITION.test(message) || !BROAD.test(message));
  for (const p of picks) {
    const co = String(p.company ?? ""), what = `${p.title || "this posting"} at ${co || "an employer not on record"}`;
    if (o.message !== undefined && !namesEmployer(message, co)) {
      if (named.length && !named.some((n) => namesEmployer(n, co))) {
        refused.push(refusal(p, `${what} is not the employer they named (${named.join(", ")}); nothing was queued for it. Search for ${named[0]}, or ask them for its link`,
          `${what} isn't the employer you named (${named.join(", ")}); nothing was queued for it. Send me its link if that's the one you meant`));
        continue;
      }
      if (!named.length && byReference && o.before !== undefined && !namesEmployer(o.before, co)) {
        refused.push(refusal(p, `they did not name ${co || "this employer"}, and ${what} was not among the postings shown to them last turn; nothing was queued for it. Ask which posting they mean`,
          `you didn't name ${co || "this employer"}, and ${what} wasn't in the list I just showed you; nothing was queued for it. Which posting do you mean?`));
        continue;
      }
    }
    const job = currentEmployerFact(co, o.facts), said = answered(co);
    if ((job || said === true) && !GO_AHEAD.test(message)) {
      const basis = job ? `their confirmed fact: "${String(job.text ?? job.value ?? "").slice(0, 160)}"` : "they said so when asked";
      const basisYou = job ? `your confirmed fact: "${String(job.text ?? job.value ?? "").slice(0, 160)}"` : "you said so when I asked";
      refused.push(refusal(p, `${co} is their current employer (${basis}); nothing was queued. Ask them first, and queue it only if they say to go ahead knowing that`,
        `${co} is your current employer (${basisYou}); nothing was queued. Say "apply anyway" if you still want it`));
      continue;
    }
    // SERIAL-1490: a possible match (a shared leading distinctive word, one name longer) is a question, asked once, and the
    // posting waits for the answer; their "no" on this thread clears it for this company only.
    const maybe = !job && said === undefined ? possibleEmployerFact(co, o.facts) : null;
    if (maybe && !GO_AHEAD.test(message)) {
      const fact = String(maybe.text ?? maybe.value ?? "").slice(0, 160);
      refused.push({ ...refusal(p, `${co} may be where they work now (their confirmed fact: "${fact}"); nothing was queued until they answer: ${employerQuestion(co)}`,
        `${co} may be where you work now (your confirmed fact: "${fact}"); nothing was queued until you answer: ${employerQuestion(co)}`), ask: "employer" });
      continue;
    }
    // A different posting at the same company is allowed, at any date. A recorded application to this exact
    // posting is still a duplicate. Only compare real URLs: employer name alone never identifies a posting.
    // The posting by its id when it has one (its board's form), else by its link; compared without case (samePosting).
    const key = samePosting(postingKey(pickLink(p)));
    const prior = key && (o.apps ?? []).find((a) => a.stage !== "Saved" && a.url && samePosting(postingKey(a.url)) === key);
    if (prior) {
      refused.push({ ...refusal(p, `${what} is already in their applications as the same posting; nothing was queued`, `${what} is already in your applications as the same posting; nothing was queued`), prior: "posting" });
      continue;
    }
    passed.push(p);
  }
  // THE POSTING SCREEN (career_apply_gate.ts, F09): whatever got this far is screened for closed, stale, scam-looking and
  // knock-out mismatches against CONFIRMED facts before it can be queued or shown for approval. Not optional, not a switch.
  const gate = gatePicks(passed, { facts: o.facts, now: o.now });
  const gated = new Set<Pick>(gate.ok);
  for (const d of gate.dropped) refused.push(refusal({ ...d.posting, job_id: d.posting.job_id ?? undefined }, `screened out (${d.kind === "knockout" ? "knock-out" : d.kind}): ${d.why}`));
  for (const h of gate.held) refused.push({ ...refusal({ ...h, job_id: h.job_id ?? undefined }, `held, not guessed: it needs a fact you haven't confirmed (${h.facts.join(", ").replace(/_/g, " ")})`), ask: "fact" });
  const ok = passed.filter((p) => gated.has(p));
  return { ok, refused, gate };
}

export function memoryWantStore(): WantStore & { dump(): Record<string, WantRow[]> } {
  const rows: Record<string, WantRow[]> = {};
  return {
    async put(userId, items) {
      const mine = (rows[userId] ??= []);
      const added: Want[] = [], already: string[] = [];
      for (const w of items) {
        if (mine.some((x) => x.posting_key === w.posting_key)) { already.push(w.posting_key); continue; }
        mine.push({ ...w, state: "waiting" });
        added.push(w);
      }
      return { added, already };
    },
    async list(userId) { return (rows[userId] ?? []).map((w) => ({ ...w })); },
    async queuedSince(userId, sinceIso) { return (rows[userId] ?? []).filter((w) => w.queued_at >= sinceIso).length; },
    dump() { return JSON.parse(JSON.stringify(rows)); },
  };
}

// Service role, acting for the person whose chat this is: writes go through career_apply_want_put_for only.
export function supabaseWantStore(admin: any): WantStore {
  return {
    async put(userId, items) {
      if (!items.length) return { added: [], already: [] };
      const { data, error } = await admin.rpc("career_apply_want_put_for", { p_user: userId, p_items: items });
      if (error) throw new Error(`the apply queue could not be saved: ${error.message}`);
      const keys = new Set<string>((data?.added ?? []) as string[]);
      const refused = ((data?.refused ?? []) as StoreRefusal[]).filter((x) => x && x.posting_key);
      const no = new Set(refused.map((x) => x.posting_key));
      return { added: items.filter((w) => keys.has(w.posting_key)), already: items.filter((w) => !keys.has(w.posting_key) && !no.has(w.posting_key)).map((w) => w.posting_key), refused };
    },
    async list(userId) {
      const { data, error } = await admin.from("career_apply_wanted").select("posting_key,url,company,title,queued_at,state").eq("user_id", userId).order("queued_at", { ascending: true }).limit(500);
      if (error) throw new Error(`the apply queue could not be read: ${error.message}`);
      return (data ?? []) as WantRow[];
    },
    async queuedSince(userId, sinceIso) {
      const { count, error } = await admin.from("career_apply_wanted").select("posting_key", { count: "exact", head: true }).eq("user_id", userId).gte("queued_at", sinceIso);
      if (error) throw new Error(`the apply queue could not be read: ${error.message}`);
      return count ?? 0;
    },
  };
}
