// D-072 (files reachable; owner standard "complete product", behavior guide P5/P17): every File family the product defines is made
// from the chat when the person's ask calls for it. Before this, no production code called createFamily, so the record-backed pages
// for F-01 to F-04, F-07, F-08 and F-12 to F-15 were served and tested but no person could reach them (item 6b report).
//
// One maker for those eleven. It never takes content from a model: the model names the family (the agent tool
// agent/file_family_tool.ts), code reads the person's records through the SAME FamilyRecords the File server draws the page from
// (file_family_serve.ts; trainee-file/deps.ts wires them), and:
//   - records unreadable          nothing is made; the reply says it could not be read (D-024).
//   - nothing on record (C.24)    nothing is made; what is missing is returned, so the reply says so (never a hollow File).
//   - records there               createFamily(userId, family, title, null, { ref }): no view is stored; the page reads the records
//                                 again on every open, so it never goes stale. `holds` lists what the page shows, from the same
//                                 view the page draws, so the reply can say what it holds and nothing else (D-066 P6, D-067).
// Approvals on these pages (F-04 approveplan, F-07 approvedoc, F-12 approvesend) stay POST forms bound to the payload hash the page
// shows (D-MS-1, D-MN-2); nothing here approves, sends or changes a row.
//
// The asks (familyAskOf) are what code reads to route a turn to the brain (career_staged.ts) and to hold the turn to making the File
// (career_brain.ts processCheck). The family -> ask -> creator table is in docs/architect/specs/FILE-RECORDS.md section 6.
import type { FileService } from "./file_service.ts";
// Types only: the record readers are wired in file_family_make_supabase.ts (agent-chat), so the brain loads none of them.
// The File server's record hook (file_family_serve.ts FamilyRecords), the part the maker uses, written out structurally so the brain
// loads no File page code; the real FamilyRecords (trainee-file/deps.ts) are passed in as they are.
export interface FamilyRec { id: string; data: { family: string; title?: string; ref?: Record<string, string> | null } }
export interface FamilyRecords { load(userId: string, rec: FamilyRec): Promise<{ view: unknown; asOf: string | null } | { state: unknown; asOf: string | null } | null> }
export type FamilyRecordsByFamily = Partial<Record<MadeFamily | "F-09", FamilyRecords>>;
type KV = { k: string; v: string | null; missing?: string };

import { FAMILY_BY_NAME, FAMILY_NAMES, FAMILY_TITLE, type MadeFamily } from "./file_family_ask.ts";
export { FAMILY_BY_NAME, FAMILY_NAMES, FAMILY_TITLE, familyAskOf, type MadeFamily } from "./file_family_ask.ts";

// ---------------------------------------------------------------- what the page holds (from the page's own view)
const clip = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const kvLine = (r: KV) => `${clip(r.k, 60)}: ${r.v === null || r.v === undefined ? clip(r.missing || "Unknown", 60) : clip(r.v)}`;
// The interview's time as the page's hero shows it (file_family_apply.ts clock): in the zone the page reads it in, with the zone
// named. Never the stored UTC instant, which the model would restate as a wrong hour (review of #798).
export function clockOf(at: unknown, tz: unknown): string {
  const t = Date.parse(String(at ?? ""));
  if (!Number.isFinite(t)) return "time not on record";
  const parts = (zone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  let p: Record<string, string>;
  try { p = parts(String(tz || "America/Chicago")); } catch { p = parts("America/Chicago"); }
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}
// deno-lint-ignore no-explicit-any
export function holdsOf(family: MadeFamily, v: any): string[] {
  const out: string[] = [];
  switch (family) {
    case "F-01":
      out.push(`Aim: ${clip(v.aim?.text)}`, ...(v.constraints ?? []).map((c: string) => `Constraint: ${clip(c)}`), ...(v.questions ?? []).map((q: { q: string }) => `Open question: ${clip(q.q)}`),
        ...(v.first ?? []).map((f: { done: boolean; text: string }) => `${f.done ? "Done" : "To do"}: ${clip(f.text)}`));
      break;
    case "F-02": out.push(...(v.facts ?? []).map((f: { k: string; v: string | null }) => `${clip(f.k, 60)}: ${f.v === null ? "Unknown" : clip(f.v)}`)); break;
    case "F-03": out.push(`${clip(v.title)}`, ...(v.directions ?? []).map((d: { letter: string; name: string; evidence: string }) => `${d.letter}: ${clip(d.name)} (${d.evidence} evidence)`)); break;
    case "F-04": out.push(`Search plan v${v.version}: ${clip(v.title)}`, `First batch: ${v.batchCap} roles at most`, ...(v.hard ?? []).map((r: KV) => `Must: ${kvLine(r)}`), ...(v.prefs ?? []).map((r: KV) => `Prefer: ${kvLine(r)}`),
      `Approval: ${v.acts?.primary ? "not approved yet (approving covers searching and shortlisting only)" : "approved"}`); break;
    case "F-07": out.push(`${clip(v.kind ?? "Document")}: ${clip(v.docTitle)}`, `For: ${clip(v.usedBy)}`, ...(v.versions ?? []).map((x: { v: string; label: string; state: string }) => `${x.v}, ${clip(x.label, 80)}: ${clip(x.state, 40)}`)); break;
    case "F-08": out.push(...(v.factual ?? []).filter((r: KV) => r.v).map((r: KV) => `Saved answer: ${kvLine(r)}`), ...(v.roleSpecific ?? []).map((r: { q: string; scope: string }) => `For ${clip(r.scope, 60)} only: ${clip(r.q)}`),
      ...(v.declaration ? [`Declaration to review (${clip(v.declaration.rid, 60)}): ${clip(v.declaration.text)}`] : []), `Questions waiting for your answer: ${Number(v.needed) || 0}`); break;
    case "F-12": out.push(`${clip(v.kind)} to ${clip(v.recipient?.name, 80)}${v.to ? ` (${clip(v.to, 120)})` : " (address not resolved)"}`, `${clip(String(v.words ?? "").split("\n")[0], 200)}`, `Status: ${clip(v.boundary ?? "not sent", 80)}`); break;
    case "F-13": out.push(`Interview: ${clip(v.company, 80)}, ${clip(v.stage, 80)}`, `When: ${clockOf(v.at, v.tz)} (${v.booked ? "the time the invite stated" : "suggested times, not booked"})`, `Format: ${clip(v.medium, 40)}`, `Interviewer: ${clip(v.person?.name, 60)}${v.person?.role ? `, ${clip(v.person.role, 60)}` : ""}`); break;
    case "F-14": out.push(`Cadence: ${clip(v.cadence, 60)}`, ...(v.changed?.length ? v.changed.map((c: string) => `This week: ${clip(c)}`) : ["This week: a quiet week"]), ...(v.decisions ?? []).map((d: { title: string }) => `Decision: ${clip(d.title)}`), ...(v.blockers ?? []).map((b: string) => `Blocker: ${clip(b)}`)); break;
    case "F-14n": out.push(`Offer: ${clip(v.company, 80)}`, ...(v.history ?? []).map((h: { v: string; text: string; written: boolean }) => `${clip(h.v, 60)}: ${clip(h.text)}${h.written ? "" : " (verbal)"}`), ...(v.position ?? []).map((r: KV) => `Position: ${kvLine(r)}`)); break;
    case "F-15": for (const o of v.offers ?? []) out.push(`${o.letter} ${clip(o.company, 60)}: ${(o.rows ?? []).filter((r: KV) => r.v).map((r: KV) => kvLine(r)).join("; ")}`);
      if (v.deadline?.text) out.push(`Deadline: ${clip(v.deadline.company, 60)}, ${clip(v.deadline.text, 60)}`); break;
  }
  return out.filter((x) => x.trim()).slice(0, 30);
}

// ---------------------------------------------------------------- the maker
// refs: which record a File of F-07 (a document, by doc_key) or F-12 (one outreach draft) is about. The other families read the
// person's records as a whole. null: none on record.
export interface FamilyRefs { latestDoc(userId: string): Promise<string | null>; latestDraft(userId: string): Promise<string | null> }
export interface FamilyMakeDeps { files: Pick<FileService, "createFamily">; records: FamilyRecordsByFamily; refs: FamilyRefs }
export type MakeResult =
  | { ok: true; family: MadeFamily; title: string; url: string; holds: string[] }
  | { ok: false; family: MadeFamily | null; reason: "unknown_family" | "unreadable" | "nothing_on_record" | "no_link"; error: string };

export async function makeFamilyFile(d: FamilyMakeDeps, userId: string, name: string): Promise<MakeResult> {
  const family = FAMILY_BY_NAME[String(name ?? "").trim()] ?? null;
  if (!family) return { ok: false, family: null, reason: "unknown_family", error: `not made: no File family named "${clip(name, 40)}" (one of: ${FAMILY_NAMES.join(", ")})` };
  const title = FAMILY_TITLE[family], src: FamilyRecords | undefined = d.records[family];
  if (!userId || !src || typeof d.files.createFamily !== "function") return { ok: false, family, reason: "unreadable", error: `not made: the ${title} can't be read here, so no File was made` };
  let ref: Record<string, string>;
  try {
    if (family === "F-07") { const doc = await d.refs.latestDoc(userId); if (!doc) return nothing(family, "No tailored document versions are on record for you."); ref = { doc }; }
    else if (family === "F-12") { const id = await d.refs.latestDraft(userId); if (!id) return nothing(family, "No message draft is on record for you."); ref = { draft_id: id }; }
    else ref = { records: "live" };
  } catch { return { ok: false, family, reason: "unreadable", error: `not made: your records for the ${title} could not be read just now, so no File was made` }; }
  const rec: FamilyRec = { id: "", data: { family, title, ref } };
  const loaded = await src.load(userId, rec).catch(() => null);
  if (!loaded) return { ok: false, family, reason: "unreadable", error: `not made: your records for the ${title} could not be read just now, so no File was made` };
  if ("state" in loaded) {
    const s = loaded.state as { title?: string; field?: { why?: string }; scope?: string };
    return nothing(family, [s.title, s.field?.why ?? s.scope].filter(Boolean).map((x) => clip(x, 200)).join(". "));
  }
  // What it holds is read before the File is made: a view that can't be summarised makes no File (never a row with no link sent).
  let holds: string[];
  try { holds = holdsOf(family, loaded.view); } catch { return { ok: false, family, reason: "unreadable", error: `not made: your records for the ${title} could not be read just now, so no File was made` }; }
  const made = await d.files.createFamily!(userId, family, title, null, { ref }).catch(() => null);
  if (!made || !made.ok || !made.url) return { ok: false, family, reason: "no_link", error: `not made: ${made && !made.ok ? made.error : "File links aren't set up"}, so no File was made` };
  return { ok: true, family, title, url: made.url, holds };
}
const nothing = (family: MadeFamily, why: string): MakeResult => ({ ok: false, family, reason: "nothing_on_record", error: `not made: nothing on record for the ${FAMILY_TITLE[family]}: ${why}` });
