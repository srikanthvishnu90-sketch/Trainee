// D-072 (files writers): the writer of the F-04 Search plan's rows (career_search_plans, 20261110160000; FILE-RECORDS.md section 1).
// Before it nothing in production wrote a plan, so the Search plan File was shown only for rows a test had seeded.
//
// When the person sets or changes a search in chat (the role, the places, the limits they stated, how many roles) or a watch on
// it (set, changed, paused or stopped), the plan as it now stands is written as a NEW version, only when it differs from the newest
// one: the same search asked again writes nothing. A version is never overwritten (the table's trigger refuses it), so a plan the
// person approved on the page stays as they approved it, and the new version needs its own approval (the page's hash-bound
// approveplan, career_search_plan_approve_as). Approving a plan authorizes searching and shortlisting only.
//
// Every value is the person's own (D-007): the role, place, level, pay floor, employer and term are read from their message by code
// (career_search_judge.ts askFor, posting_constraints.ts), each with its source ("you", and when). The watch is their alert settings
// as saved (career_alert_prefs). Nothing is inferred and nothing sensitive (visa sponsorship) is written to the plan: it is answered
// per application. The first batch is how many roles the search lists: their count, else the search's own default.
import type { AlertRow } from "./career_alert_store.ts";
import { SHOW_DEFAULT, type SearchAsk } from "./career_search_judge.ts";
import type { PlanEntry, PlanRow } from "./file_family_records_materials.ts";

export interface PlanContent { title: string; hard: PlanEntry[]; prefs: PlanEntry[]; batch_cap: number; watch: { text: string; active: boolean } | null }
export interface SearchPlanWriteStore {
  newest(userId: string): Promise<(PlanContent & { version: number }) | null>;
  // "conflict": that version was written meanwhile (another turn); the writer reads again and retries.
  insert(userId: string, version: number, c: PlanContent): Promise<"ok" | "conflict">;
}
export type PlanWrite = { written: true; version: number } | { written: false; why: "unchanged" | "nothing_to_plan" };

const clean = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const BAND: Record<string, string> = { intern: "Internship", new_grad: "New grad", junior: "Junior", mid: "Mid level", senior: "Senior", staff: "Staff", manager: "Manager", director: "Director" };
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const you = (at: string): PlanEntry["src"] => ({ kind: "you", at });

// The search the person stated, as the plan's title, hard limits and first batch.
export function planFromAsk(ask: SearchAsk, at: string): Omit<PlanContent, "watch"> {
  const role = clean(ask.roles?.length ? ask.roles.join(", ") : ask.role, 100);
  const place = clean(ask.place, 80);
  const where = ask.remoteOnly ? "Remote only" : place && ask.remote ? `${place} or remote` : place || (ask.remote ? "Remote" : "");
  const l = ask.limits;
  const hard: PlanEntry[] = [];
  if (role) hard.push({ k: "Role", v: role, src: you(at) });
  if (where) hard.push({ k: "Location", v: where, src: you(at) });
  if (l?.bands?.length) hard.push({ k: "Level", v: l.bands.map((b) => BAND[b] ?? b).join(", "), src: you(at) });
  if (l?.notBands?.length) hard.push({ k: "Not these levels", v: l.notBands.map((b) => BAND[b] ?? b).join(", "), src: you(at) });
  if (l?.pay) hard.push({ k: "Pay floor", v: `${money(l.pay.amount)} ${l.pay.period === "hour" ? "an hour" : "a year"} or more, where pay is listed`, src: you(at) });
  if (clean(l?.company)) hard.push({ k: "Employer", v: clean(l?.company, 80), src: you(at) });
  if (clean(l?.term)) hard.push({ k: "Term", v: clean(l?.term, 40), src: you(at) });
  const title = clean(`${cap1(role || "roles")}${ask.remoteOnly ? ", remote" : place ? ` in ${place}` : ""}`, 120);
  const want = Number(ask.want);
  return { title, hard, prefs: [], batch_cap: Number.isInteger(want) && want >= 1 && want <= 50 ? want : SHOW_DEFAULT };
}

// The watch on the plan: the person's alert settings as saved. Off is kept as paused (the settings stay; nothing is texted).
export function watchOf(row: Pick<AlertRow, "prefs"> | null): PlanContent["watch"] {
  if (!row) return null;
  const p = row.prefs, what = p.keywords.join(", "), where = p.locations.length ? ` in ${p.locations.join(", ")}` : "";
  const text = `New ${what} roles${where}${p.remote_ok ? " (remote counted)" : ""}: up to ${p.max_instant_per_day} texts a day, a daily report at ${p.report_hour}:00, none from ${p.quiet_start}:00 to ${p.quiet_end}:00.`;
  return { text: clean(p.on ? text : `Paused. ${text}`, 400), active: !!p.on };
}

// The plan's content without the time each entry was said: the same search said again is the same plan.
const canon = (c: PlanContent) => JSON.stringify([c.title, c.hard.map((e) => [e.k, e.v]), c.prefs.map((e) => [e.k, e.v]), c.batch_cap, c.watch]);

// change.search: the search set or changed this turn. change.watch: the person's alert row as it now is (null: none), when this turn
// set, changed, paused or stopped a watch; undefined when the turn did not touch the watch.
export async function writeSearchPlan(store: SearchPlanWriteStore, userId: string, change: { search?: SearchAsk | null; watch?: Pick<AlertRow, "prefs"> | null; now: number }): Promise<PlanWrite> {
  const at = new Date(change.now).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = await store.newest(userId);
    let next: PlanContent;
    if (change.search && clean(change.search.role)) next = { ...planFromAsk(change.search, at), watch: change.watch !== undefined ? watchOf(change.watch) : base?.watch ?? null };
    else if (change.watch !== undefined) {
      const w = watchOf(change.watch);
      if (base) next = { title: base.title, hard: base.hard, prefs: base.prefs, batch_cap: base.batch_cap, watch: w };
      else if (change.watch && w) {
        // No search on record yet: the watch's own words are the plan (the role and places the person said to watch).
        const p = change.watch.prefs, what = clean(p.keywords.join(", "), 100);
        const hard: PlanEntry[] = [{ k: "Role", v: what, src: you(at) }, ...(p.locations.length ? [{ k: "Location", v: clean(p.locations.join(", ") + (p.remote_ok ? " or remote" : ""), 120), src: you(at) }] : [])];
        next = { title: clean(`${cap1(what)}${p.locations.length ? ` in ${p.locations.join(", ")}` : ""}`, 120), hard, prefs: [], batch_cap: SHOW_DEFAULT, watch: w };
      } else return { written: false, why: "nothing_to_plan" };
    } else return { written: false, why: "nothing_to_plan" };
    if (!next.title) return { written: false, why: "nothing_to_plan" };
    if (base && canon(base) === canon(next)) return { written: false, why: "unchanged" };
    const version = (base?.version ?? 0) + 1;
    if (await store.insert(userId, version, next) === "ok") return { written: true, version };
  }
  throw new Error("the search plan changed under three writes in a row");
}

// ---------------------------------------------------------------- the stores
// deno-lint-ignore no-explicit-any
export function supabaseSearchPlanWriter(admin: any): SearchPlanWriteStore {
  return {
    async newest(u) {
      const r = await admin.from("career_search_plans").select("version,title,hard,prefs,batch_cap,watch").eq("user_id", u).order("version", { ascending: false }).limit(1);
      if (r.error) throw new Error(`read the search plan: ${r.error.message}`);
      return (r.data?.[0] ?? null) as (PlanContent & { version: number }) | null;
    },
    async insert(u, version, c) {
      // payload_hash is computed by the table's trigger from the content; the placeholder is replaced on insert.
      const r = await admin.from("career_search_plans").insert({ user_id: u, version, title: c.title, hard: c.hard, prefs: c.prefs, batch_cap: c.batch_cap, watch: c.watch, payload_hash: "0".repeat(64) });
      if (!r.error) return "ok";
      if (r.error.code === "23505") return "conflict";
      throw new Error(`write the search plan: ${r.error.message}`);
    },
  };
}
// The in-memory store over memoryPlanMaterialStore's rows (tests).
export function memorySearchPlanWriter(plans: { plans(u: string): Promise<PlanRow[]>; addPlan(u: string, p: Omit<PlanRow, "payload_hash" | "approved_at">): Promise<void> }, now: () => number = Date.now): SearchPlanWriteStore {
  return {
    async newest(u) { const p = (await plans.plans(u)).sort((a, b) => b.version - a.version)[0]; return p ? { version: p.version, title: p.title, hard: p.hard, prefs: p.prefs, batch_cap: p.batch_cap, watch: p.watch } : null; },
    async insert(u, version, c) {
      try { await plans.addPlan(u, { version, ...c, created_at: new Date(now()).toISOString() }); return "ok"; } catch { return "conflict"; }
    },
  };
}
