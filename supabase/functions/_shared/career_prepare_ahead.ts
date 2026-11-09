// FEATURE 3 (D-011; backend gap map G4): applications are prepared before the person asks. Pure selection and the one
// card a day, plus the database reads the scheduled run needs; the run itself is career_proactive_run.ts runPrepareAhead
// and the preparation is the queue path's own (workers/career-browser/prepare-ahead.ts prepareOne: the engine's dry run
// with the person's confirmed answers, the resume tailored to the posting and, when drafted, the cover note, all bound
// into the payload whose hash the card's tap approves). Nothing here approves, queues or sends: the card does, on the tap.
//   selectAhead   today's best new matches for the person's watches (the alerts' own match and order: matchPosting,
//                 freshWhenSeen, freshest first, first seen in the last 26 hours), less what they already applied to, had
//                 prepared or had tried, less an employer they applied to in 30 days, one per employer, up to the cap
//   aheadCap      their own daily pace when set (no product ceiling, CAPS-1390), and at most AHEAD_PER_DAY prepared a
//                 day by this run (work done ahead, not a limit on applying); an unreadable pace prepares nothing
//   aheadCardText "8/10 applications ready for your yes", the ready ones exactly as the card shows them (cardFor), and
//                 every one not ready named with its reason
import { type ReviewLinks, supabaseCardPush } from "./application_review_links.ts";
import { type AlertPrefs, matchPosting } from "./career_alerts.ts";
import { freshWhenSeen } from "./career_fresh.ts";
import { normCompany, paceState } from "./career_apply.ts";
import { cardFor, type Prepared } from "./career_apply_cards.ts";

export const AHEAD_PER_DAY = 10;
export const AHEAD_WINDOW_MS = 26 * 3600000;
export const COOLDOWN_MS = 30 * 86400000;

// What one preparation came to (prepare-ahead.ts AheadOutcome, structurally).
export interface AheadOutcome { job_id: string; outcome: "ready" | "asked" | "refused" | "no_resume" | "error"; detail: string; prepared_id?: string; cover_note?: boolean }
// One posting to prepare, as prepare-ahead.ts Candidate.
export interface AheadCandidate {
  user_id: string; job_id: string; company: string; title: string; url: string; location: string; description: string; epoch: number; version: number;
}
export interface Taken { jobs: Set<string>; companies: Set<string> }
export interface Skip { job_id: string; company: string; title: string; why: "taken" | "employer_30_days" | "same_employer" | "over_cap" }

export function aheadCap(daily: unknown): { cap: number; why: string | null } {
  const st = paceState(daily);
  if (st.state === "unreadable") return { cap: 0, why: "pace_unreadable" };
  return { cap: st.state === "set" ? Math.min(st.pace, AHEAD_PER_DAY) : AHEAD_PER_DAY, why: null };
}

const ms = (t: unknown) => { const n = Date.parse(String(t ?? "")); return Number.isFinite(n) ? n : NaN; };

export function selectAhead(o: { prefs: AlertPrefs; postings: any[]; now: number; taken: Taken; cap: number }): { picks: any[]; skipped: Skip[] } {
  const matches = o.postings
    .filter((p) => ms(p.first_seen_at) > o.now - AHEAD_WINDOW_MS && freshWhenSeen(p) && matchPosting(p, o.prefs))
    .sort((a, b) => ms(b.first_seen_at) - ms(a.first_seen_at) || String(a.job_id).localeCompare(String(b.job_id)));
  const picks: any[] = [], skipped: Skip[] = [], employers = new Set<string>();
  for (const p of matches) {
    const co = normCompany(p.company), s = { job_id: String(p.job_id), company: String(p.company ?? ""), title: String(p.title ?? "") };
    if (o.taken.jobs.has(s.job_id)) { skipped.push({ ...s, why: "taken" }); continue; }
    if (!co || o.taken.companies.has(co)) { skipped.push({ ...s, why: "employer_30_days" }); continue; }
    if (employers.has(co)) { skipped.push({ ...s, why: "same_employer" }); continue; }
    if (picks.length >= o.cap) { skipped.push({ ...s, why: "over_cap" }); continue; }
    employers.add(co);
    picks.push(p);
  }
  return { picks, skipped };
}

const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// Each stop in the person's words: what stopped it and what happens next. The detail is the run's own record.
export function stopWhy(o: AheadOutcome): string {
  switch (o.outcome) {
    case "asked": return `it asks something your confirmed details don't answer (${one(o.detail, 120)}); I'll text you the question`;
    case "no_resume": return "no resume could be made for it from your confirmed details";
    case "refused": return `the application form could not be filled ahead (${one(o.detail, 120)})`;
    case "error": return `preparing it failed (${one(o.detail, 120)})`;
    default: return one(o.detail, 120);
  }
}
export interface Stop { company: string; title: string; why: string }
const TEXT_MAX = 4000;
// The one card of the day. `ready` are the prepared rows still ready, in the order the run prepared them; `picked` how
// many were tried today. The numbered part is cardFor's, unchanged, so the database's check that the text carries every
// card line holds and "yes but not 2" means the card's own number 2. Null when nothing is ready.
export function aheadCardText(o: { picked: number; ready: Prepared[]; stops: Stop[] }): { take: Prepared[]; text: string } | null {
  const c = cardFor(o.ready.filter((r) => { const x = cardFor([r]); return x !== null && "take" in x; }));
  if (!c || !("take" in c)) return null;
  const n = o.ready.length;
  const head = `${n}/${o.picked} application${o.picked === 1 ? "" : "s"} ready for your yes. I prepared ${o.picked === 1 ? "it" : "them"} from today's new matches for your job alerts; nothing is sent until you say yes.`;
  const more = n > c.take.length ? [`${n - c.take.length} more ready: say "show my applications" after this one.`] : [];
  const lines = o.stops.map((s) => `- ${one(s.company, 80)}${s.title ? ` (${one(s.title, 80)})` : ""}: ${s.why}`);
  const build = (k: number) => [head, c.text, ...more,
    ...(o.stops.length ? [`Not ready (${o.stops.length}):\n${[...lines.slice(0, k), ...(k < lines.length ? [`- and ${lines.length - k} more`] : [])].join("\n")}`] : [])].join("\n\n");
  let k = lines.length, text = build(k);
  while (text.length > TEXT_MAX && k > 0) text = build(--k);
  return text.length > TEXT_MAX ? null : { take: c.take, text };
}

// The day's record per person (career_watch_kv, career:prepare-ahead:<user>): prepared once a local day, and the card
// pushed once; a card the database held back (a busy thread, quiet hours) is tried again by later runs that day.
export interface AheadDay { date: string; picked: number; ready_ids: string[]; stops: Stop[]; card_id: string | null }
export interface AheadAccount { epoch: number; version: number }
export interface AheadStore {
  accounts(userIds: string[]): Promise<Map<string, AheadAccount>>; // career:account, not paused
  resumeOnFile(userId: string): Promise<boolean>;
  pace(userId: string): Promise<unknown>; // the stored daily_limit as stored (paceState reads it); undefined: none
  taken(userId: string, now: number): Promise<Taken>;
  day(userId: string): Promise<AheadDay | null>;
  saveDay(userId: string, d: AheadDay): Promise<void>;
  ready(userId: string, ids: string[]): Promise<Prepared[]>;
  push(userId: string, ids: string[], text: string): Promise<string | null>;
}
const dayKey = (u: string) => `career:prepare-ahead:${u}`;
const COUNTED = ["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "unknown_outcome"];

// deno-lint-ignore no-explicit-any
export function supabaseAheadStore(admin: any, review?: ReviewLinks): AheadStore {
  const must = (r: { data: any; error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    accounts: async (ids) => {
      const out = new Map<string, AheadAccount>();
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        const rows = must(await admin.from("career_watch_kv").select("user_id,value").in("user_id", part).eq("key", "career:account"), "read accounts") ?? [];
        for (const r of rows) {
          const v = r.value ?? {};
          if (String(v.paused ?? "false") === "true") continue;
          out.set(String(r.user_id), { epoch: Number(v.epoch ?? 0) || 0, version: Number(v.version ?? 0) || 0 });
        }
      }
      return out;
    },
    resumeOnFile: async (u) => {
      const p = must(await admin.rpc("career_apply_profile_for", { p_user: u }), "read their profile");
      return !!p && typeof p === "object" && Array.isArray(p.facts) && p.facts.length > 0;
    },
    pace: async (u) => {
      const rows = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", "career:account"), "read their pace") ?? [];
      return rows[0]?.value?.daily_limit ?? undefined;
    },
    taken: async (u, now) => {
      const jobs = new Set<string>(), companies = new Set<string>();
      const since = new Date(now - COOLDOWN_MS).toISOString();
      for (const r of must(await admin.from("career_apply_jobs").select("job_id,company,state,created_at").eq("user_id", u), "read their applications") ?? []) {
        jobs.add(String(r.job_id));
        if (COUNTED.includes(r.state) && String(r.created_at) >= since) companies.add(normCompany(r.company));
      }
      for (const r of must(await admin.from("career_apply_prepared").select("job_id,company,state").eq("user_id", u), "read their prepared applications") ?? []) {
        jobs.add(String(r.job_id));
        if (["ready", "shown", "approved"].includes(r.state)) companies.add(normCompany(r.company));
      }
      for (const r of must(await admin.from("career_apply_prepare_attempts").select("posting_job_id").eq("user_id", u), "read their prepare tries") ?? []) jobs.add(String(r.posting_job_id));
      companies.delete("");
      return { jobs, companies };
    },
    day: async (u) => {
      const rows = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", dayKey(u)), "read the day's record") ?? [];
      const v = rows[0]?.value;
      return v && typeof v === "object" && typeof v.date === "string" ? v as AheadDay : null;
    },
    saveDay: async (u, d) => {
      must(await admin.from("career_watch_kv").upsert({ user_id: u, key: dayKey(u), value: d, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save the day's record");
    },
    ready: async (u, ids) => {
      if (!ids.length) return [];
      const rows = must(await admin.from("career_apply_prepared").select("id,company,card_lines,created_at,state").eq("user_id", u).in("id", ids), "read prepared applications") ?? [];
      const by = new Map(rows.filter((r: any) => r.state === "ready").map((r: any) => [String(r.id), r]));
      return ids.map((id) => by.get(id)).filter(Boolean).map((r: any) => ({ id: String(r.id), company: String(r.company), card_lines: (r.card_lines ?? []).map(String), created_at: r.created_at }));
    },
    // WO-G: the review File link of each application on the card, while the card stays one text.
    push: supabaseCardPush(admin, review),
  };
}
