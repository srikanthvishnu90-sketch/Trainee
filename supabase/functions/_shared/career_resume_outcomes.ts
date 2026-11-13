// RELEASE 9 (workstream B): does tailoring get people more interviews? Measured per resume version, from state only.
//
// 1. At tailor time (tailor_resume), the file Trainee made is recorded by its sha256 under the person's own key
//    career:resume-versions in career_watch_kv: its version number (resume-v1, resume-v2, ... in the order this person's
//    files were made), its layout (plain, trainee or own) and the kinds of change it carries against their base resume
//    (reorder, drop, skills, reword: career_tailor.ts's changelog kinds). "Forget everything" erases the key with the rest
//    (the erase keeps only career:turn:* keys), and so does account deletion.
// 2. At apply time, the trigger career_apply_resume_version_tag (20261107120000) copies the version, layout and change kinds
//    of the exact file a tailored application carries onto its career_apply_jobs row, so the row says what was sent even
//    if the key changes later. An untailored application carries none.
// 3. The view career_apply_outcomes_by_resume reports, per person, applications sent and the response, interview and offer
//    rates by version, by tailored versus untailored, by layout and by change kind, with the same definitions as
//    career_apply_outcomes (B10): only what the queue and the person's filed job mail say. Nothing is estimated, and a
//    group under MIN_PER_GROUP applications is shown as too few to compare.
// Types only: the File page reads this module, and must not load the career bundle career_tailor.ts carries.
import type { TailorOut } from "./career_tailor.ts";

export const VERSIONS_KEY = "career:resume-versions";
export const MAX_VERSIONS = 200;
export const MIN_PER_GROUP = 30; // career_tailor.ts MIN_PER_ARM, the tailored-vs-untailored floor (a test holds them equal)
export type ChangeKind = "reorder" | "drop" | "skills" | "reword";
const KIND_OF: Record<string, ChangeKind> = { lead: "reorder", drop: "drop", skills: "skills", reword: "reword" };
// RELEASE 10: the layout "template" names which of the fifteen in template (T01..T15), so rates can be read per template.
export interface VersionEntry { n: number; layout: "plain" | "trainee" | "own" | "template"; template?: string | null; changes: ChangeKind[]; at: string; job_id: string | null; contact?: { status: string; email_hash: string | null } | null }
export interface VersionState { next: number; files: Record<string, VersionEntry> }
export interface ResumeVersionLog { get(userId: string): Promise<VersionState>; save(userId: string, s: VersionState): Promise<void> }

export function changeKinds(changes: { kind: string }[]): ChangeKind[] {
  return [...new Set(changes.map((c) => KIND_OF[c.kind]).filter(Boolean))].sort() as ChangeKind[];
}
// The same file made again keeps its first number; a new file gets the next one. The oldest entries go past MAX_VERSIONS.
export function withVersion(s: VersionState, o: { sha256: string; layout: VersionEntry["layout"]; template?: string | null; changes: ChangeKind[]; job_id: string | null; now: number }): { state: VersionState; version: string } {
  if (!/^[a-f0-9]{64}$/.test(o.sha256)) throw new Error("not recorded: bad resume hash");
  const had = s.files[o.sha256];
  if (had) return { state: s, version: `resume-v${had.n}` };
  const n = Math.max(1, s.next);
  const files = { ...s.files, [o.sha256]: { n, layout: o.layout, ...(o.template ? { template: o.template } : {}), changes: o.changes, at: new Date(o.now).toISOString(), job_id: o.job_id } };
  const keep = Object.entries(files).sort((a, b) => b[1].n - a[1].n).slice(0, MAX_VERSIONS);
  return { state: { next: n + 1, files: Object.fromEntries(keep) }, version: `resume-v${n}` };
}
// Never fails the tailoring: a record that could not be written is logged and the file still goes.
export async function recordVersion(log: ResumeVersionLog, o: { userId: string; out: Extract<TailorOut, { ok: true }>; now: number }): Promise<string | null> {
  try {
    const cur = await log.get(o.userId);
    const { state, version } = withVersion(cur, { sha256: o.out.sha256, layout: o.out.layout, template: o.out.template ?? null, changes: changeKinds(o.out.changes), job_id: o.out.job_id, now: o.now });
    // The file's contact verdict rides its version record (career_tailor.ts contactVerdict): the gates read it, not the bytes alone.
    const f = state.files[o.out.sha256];
    if (f && o.out.contact && !f.contact) f.contact = { status: o.out.contact.status, email_hash: o.out.contact.email_hash };
    if (state !== cur || f?.contact) await log.save(o.userId, state);
    return version;
  } catch (e) {
    console.error("resume version:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
const empty = (): VersionState => ({ next: 1, files: {} });
export function memoryVersionLog(): ResumeVersionLog & { rows: Map<string, VersionState> } {
  const rows = new Map<string, VersionState>();
  return { rows, async get(u) { return structuredClone(rows.get(u) ?? empty()); }, async save(u, s) { rows.set(u, structuredClone(s)); } };
}
// deno-lint-ignore no-explicit-any
export function supabaseVersionLog(admin: any): ResumeVersionLog {
  return {
    async get(u) {
      const r = await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", VERSIONS_KEY).maybeSingle();
      if (r.error) throw new Error(`read resume versions: ${r.error.message}`);
      const v = r.data?.value;
      return v && typeof v === "object" && v.files ? { next: Number(v.next) || 1, files: v.files } : empty();
    },
    async save(u, s) {
      const r = await admin.from("career_watch_kv").upsert({ user_id: u, key: VERSIONS_KEY, value: s }, { onConflict: "user_id,key" });
      if (r.error) throw new Error(`save resume versions: ${r.error.message}`);
    },
  };
}

// ---------------------------------------------------------------- the rates, for the File page
export interface RateRow {
  dimension: "version" | "tailoring" | "layout" | "template" | "change_type"; bucket: string;
  sent: number; responses: number; interviews: number; offers: number;
  response_per_100: number | null; interview_per_100: number | null; offer_per_100: number | null;
}
// deno-lint-ignore no-explicit-any
export function supabaseResumeRates(admin: any): (userId: string) => Promise<RateRow[]> {
  return async (u) => {
    const r = await admin.from("career_apply_outcomes_by_resume").select("dimension,bucket,sent,responses,interviews,offers,response_per_100,interview_per_100,offer_per_100").eq("user_id", u).limit(500);
    if (r.error) throw new Error(`read resume outcomes: ${r.error.message}`);
    return (r.data ?? []).map((x: RateRow) => ({ ...x, sent: Number(x.sent), responses: Number(x.responses), interviews: Number(x.interviews), offers: Number(x.offers) }));
  };
}
const DIM_TITLE: Record<RateRow["dimension"], string> = { tailoring: "Tailored or not", version: "By resume version", layout: "By layout", template: "By template", change_type: "By kind of change" };
const BUCKET_WORD: Record<string, string> = { tailored: "Tailored", untailored: "Not tailored", plain: "Plain", trainee: "Trainee layout", own: "Your own layout", template: "A Trainee template", reorder: "Reordered", drop: "Left things out", skills: "Skills line changed", reword: "Bullets reworded" };
const pct = (x: number | null) => (x === null ? "-" : `${Number.isInteger(x) ? x : x.toFixed(1)}%`);
const nOf = (k: number, n: number) => `${k} of ${n}`;
const ORDER: RateRow["dimension"][] = ["tailoring", "version", "layout", "template", "change_type"];
export interface RateLine { dimension: string; label: string; sent: number; responses: string; interviews: string; offers: string; enough: boolean }
export function rateLines(rows: RateRow[], min = MIN_PER_GROUP): { title: string; lines: RateLine[] }[] {
  return ORDER.map((dim) => ({
    title: DIM_TITLE[dim],
    lines: rows.filter((r) => r.dimension === dim).sort((a, b) => b.sent - a.sent || a.bucket.localeCompare(b.bucket)).map((r) => ({
      dimension: dim, label: BUCKET_WORD[r.bucket] ?? r.bucket, sent: r.sent, enough: r.sent >= min,
      responses: `${pct(r.response_per_100)} (${nOf(r.responses, r.sent)})`, interviews: `${pct(r.interview_per_100)} (${nOf(r.interviews, r.sent)})`, offers: `${pct(r.offer_per_100)} (${nOf(r.offers, r.sent)})`,
    })),
  })).filter((g) => g.lines.length);
}
export const RATES_NOTE = `Counted from your applications that reached an employer and the job mail filed under each one; a response is any reply, an interview includes an assessment. Under ${MIN_PER_GROUP} applications a group is too few to compare.`;
export function ratesText(rows: RateRow[]): string {
  const groups = rateLines(rows);
  if (!groups.length) return "How your resumes are doing: no application has reached an employer yet.";
  const L = ["How your resumes are doing"];
  for (const g of groups) {
    L.push(g.title);
    for (const l of g.lines) L.push(`  ${l.label}: ${l.sent} sent; responses ${l.responses}; interviews ${l.interviews}; offers ${l.offers}${l.enough ? "" : " (too few to compare)"}`);
  }
  L.push(RATES_NOTE);
  return L.join("\n");
}
export function ratesHtml(rows: RateRow[], esc: (s: unknown) => string): string {
  const groups = rateLines(rows);
  const body = groups.length
    ? groups.map((g) => `<h3>${esc(g.title)}</h3><table class="rates"><thead><tr><th scope="col">Resume</th><th scope="col">Sent</th><th scope="col">Responses</th><th scope="col">Interviews</th><th scope="col">Offers</th></tr></thead><tbody>${g.lines.map((l) =>
      `<tr${l.enough ? "" : ` class="few"`}><th scope="row">${esc(l.label)}${l.enough ? "" : ` <span class="mute">(too few to compare)</span>`}</th><td>${l.sent}</td><td>${esc(l.responses)}</td><td>${esc(l.interviews)}</td><td>${esc(l.offers)}</td></tr>`).join("")}</tbody></table>`).join("")
    : `<p>No application has reached an employer yet.</p>`;
  return `<section class="rates-sec" aria-labelledby="rates-h"><h2 id="rates-h">How your resumes are doing</h2>${body}<p class="mute">${esc(RATES_NOTE)}</p></section>`;
}
export const RATES_CSS = `.rates-sec{margin-top:28px}.rates-sec h2{font-size:20px;margin:0 0 8px}.rates-sec h3{font-size:16px;margin:16px 0 6px}.rates{width:100%;border-collapse:collapse;font-size:15px}.rates th,.rates td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}.rates thead th{color:var(--mute);font-weight:600}.rates td{font-variant-numeric:tabular-nums}.rates .few td{color:var(--mute)}.rates-sec .mute{color:var(--mute);font-size:14px}`;
