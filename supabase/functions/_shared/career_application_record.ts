// D-062 (owner, 2026-11-11: "be able to answer emails, find alumni, do all of it. not gmail read, but gmail read and send"),
// MIRROR-PROCESS C6 and C16: "have I applied to anything?" and "set up that application tracker". One read of the person's own
// records, as data for the brain and for the tracker File; no reply prose lives here (the model writes the words).
//   applied      applications that went, each with its evidence and dates: the employer's own email in the person's
//                connected Gmail (the mail tracking run's career_mail_events, CAREER_MAIL_TRACKING), Trainee's apply queue
//                (what Trainee submitted), or the person's word (the tracker they keep by text). Confirmed by email only when
//                an employer's email says so; never inferred.
//   researched   roles shown in this conversation (the last list) that are not applied to: research, not applications.
//   drafts       what is prepared and not submitted or sent: a prepared application waiting for a yes, an application asked
//                for in chat, an email draft or card waiting for a yes.
//   coverage     what this record can and cannot see: it is Gmail-based (one connected Google account; mail from another
//                address, or a status shown only on an employer's portal, is missed), read through a date.
//   changes      G9 (MIRROR-RULINGS): what differs from the record shown last time, by the same evidence (an email's hash or
//                an application's ref), so the next reply corrects an earlier claim out loud.
// Facts only from records (D-007): company, role and dates are read, never written by a model.
import { sameCompany, type StatusEvent, type TrackedApp } from "./career_mail.ts";
import type { Situation, Task } from "./career_situation.ts";

export type Evidence = { kind: string; at: string; from: "gmail" | "trainee" | "you"; text?: string };
export interface AppliedItem {
  ref: string; company: string; role: string | null; applied_at: string | null; stage: string;
  status: string; // what the record says now, in plain words (submitted, confirmed by email, interview, rejected, ...)
  confirmed_by: "employer email" | "Trainee's submission record" | "your word";
  evidence: Evidence[]; hashes: string[];
}
export interface ResearchedItem { company: string; role: string | null; url: string | null; job_id: string | null }
export interface DraftItem { company: string | null; what: string; state: string; since: string | null }
export interface MailCoverage {
  tracking_on: boolean; // CAREER_MAIL_TRACKING
  gmail: "connected" | "not_connected" | "not_allowed" | "unknown";
  mailbox: string | null; read_through: string | null;
  accounts_connected: number;
  // One Google account per person: connecting another replaces the first (career_mail_store.ts, CONNECTORS ROUND 4).
  multiple_accounts_supported: false;
  read_now?: "read" | "not_read" | "error";
}
export interface RecordChange { ref: string; what: string; was: string; now: string }
export interface ApplicationRecord {
  as_of: string; applied: AppliedItem[]; researched: ResearchedItem[]; drafts: DraftItem[];
  mail: MailCoverage; coverage: string[]; changes: RecordChange[]; unreadable: string[];
}
// What was shown, kept per person (career_watch_kv, erased with everything else) so the next record can correct it.
export interface Snapshot { at: string; items: { ref: string; company: string; role: string | null; stage: string; hashes: string[] }[] }

const STATUS: Record<string, string> = {
  received: "confirmed received by the employer's email", interview: "interview invitation by email", assessment: "assessment sent by email",
  offer: "offer by email", rejection: "rejected by email", recruiter_reply: "recruiter replied by email",
};
const QUEUE_STATE: Record<string, string> = {
  confirmed: "submitted by Trainee, confirmed by the employer", submitted_unconfirmed: "submitted by Trainee, not yet confirmed by the employer",
  unknown_outcome: "sent by Trainee, outcome not confirmed",
};
const iso = (v: unknown): string | null => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// The applications that went (from the mail store's read of the queue and the tracker) and the status emails recorded against
// them; an application first seen in mail (ref "mail:...") stands on its email alone.
export function appliedFrom(apps: TrackedApp[], events: StatusEvent[], situation: Situation | null): AppliedItem[] {
  const out: AppliedItem[] = [];
  const byRef = new Map<string, StatusEvent[]>();
  for (const e of events ?? []) { if (!e?.ref) continue; const xs = byRef.get(e.ref) ?? []; xs.push(e); byRef.set(e.ref, xs); }
  const evidenceOf = (ref: string) => (byRef.get(ref) ?? []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const stateOf = (ref: string) => {
    const id = /^job:(.+)$/.exec(ref)?.[1];
    const t = id ? situation?.tasks.find((x) => x.id === `job:${id}`) : null;
    return t?.state ?? null;
  };
  for (const a of apps ?? []) {
    const evs = evidenceOf(a.ref), last = evs.at(-1);
    const fromMail = evs.length > 0;
    const confirmed_by: AppliedItem["confirmed_by"] = a.source === "queue" ? "Trainee's submission record" : a.source === "mail" || evs.some((e) => e.kind === "received") ? "employer email" : "your word";
    const queueState = a.source === "queue" ? stateOf(a.ref) : null;
    const status = last ? STATUS[last.kind] ?? last.kind : queueState ? QUEUE_STATE[queueState] ?? queueState : a.source === "tracker" ? `${a.stage} (you told me)` : a.stage;
    out.push({
      ref: a.ref, company: clip(a.company, 120), role: a.role ? clip(a.role, 160) : null, applied_at: iso(a.applied_at), stage: a.stage, status, confirmed_by,
      evidence: [
        ...(a.source === "queue" ? [{ kind: "submitted", at: iso(a.applied_at) ?? "", from: "trainee" as const }] : a.source === "tracker" ? [{ kind: "told", at: iso(a.applied_at) ?? "", from: "you" as const }] : []),
        ...evs.map((e) => ({ kind: e.kind, at: iso(e.at) ?? "", from: "gmail" as const, text: clip(e.evidence, 200) })),
      ].filter((e) => e.at || e.from !== "gmail"),
      hashes: evs.map((e) => e.hash).filter(Boolean),
    });
    void fromMail;
  }
  // Applications only an email knows of (the mail run's own "mail:" refs whose application row the store did not return).
  for (const [ref, evs] of byRef) {
    if (out.some((x) => x.ref === ref) || !/^mail:/.test(ref)) continue;
    const first = evs.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0], last = evs.at(-1)!;
    if (!evs.some((e) => e.kind === "received")) continue;
    out.push({ ref, company: clip(first.company, 120), role: first.role ? clip(first.role, 160) : null, applied_at: iso(first.at), stage: last.stage ?? "Submitted",
      status: STATUS[last.kind] ?? last.kind, confirmed_by: "employer email",
      evidence: evs.map((e) => ({ kind: e.kind, at: iso(e.at) ?? "", from: "gmail" as const, text: clip(e.evidence, 200) })), hashes: evs.map((e) => e.hash) });
  }
  return out.sort((a, b) => String(b.applied_at ?? "").localeCompare(String(a.applied_at ?? "")));
}

// Roles this conversation listed that were not applied to.
export function researchedFrom(listed: any[] | null | undefined, situation: Situation | null, applied: AppliedItem[]): ResearchedItem[] {
  const rows: ResearchedItem[] = [];
  const add = (company: unknown, role: unknown, url: unknown, id: unknown) => {
    const c = clip(company, 120);
    if (!c) return;
    const r = role ? clip(role, 160) : null;
    if (applied.some((a) => sameCompany(a.company, c) && (!a.role || !r || a.role.toLowerCase() === r.toLowerCase()))) return;
    if (rows.some((x) => sameCompany(x.company, c) && x.role === r)) return;
    rows.push({ company: c, role: r, url: typeof url === "string" && /^https:\/\//.test(url) ? url : null, job_id: id ? String(id) : null });
  };
  for (const e of Array.isArray(listed) ? listed : []) add(e?.company, e?.title ?? e?.role, e?.url, e?.id ?? e?.job_id);
  for (const e of situation?.last_shown?.items ?? []) add(e.company, e.title, null, e.job_id);
  return rows.slice(0, 25);
}

const DRAFT_STATE: Record<string, string> = { awaiting_approval: "prepared, waiting for your yes", waiting_extension: "asked for, not prepared or submitted", drafted: "drafted, not sent" };
export function draftsFrom(situation: Situation | null): DraftItem[] {
  const keep = (t: Task) => (t.kind === "application" && t.state === "awaiting_approval") || t.kind === "apply_request" || (t.kind === "outreach" && t.state === "awaiting_approval") || t.kind === "mail_draft";
  return (situation?.tasks ?? []).filter(keep).map((t) => ({
    company: t.company, what: t.kind === "application" ? "application" : t.kind === "apply_request" ? "application asked for in chat" : t.title ?? t.kind,
    state: DRAFT_STATE[t.state] ?? t.state, since: iso(t.since),
  })).slice(0, 25);
}

// Coverage, as data the reply restates in its own words.
export function coverageOf(m: MailCoverage): string[] {
  const out: string[] = [];
  if (!m.tracking_on) out.push("reading email is switched off, so no email confirmation was read");
  else if (m.gmail === "not_connected") out.push("no Gmail is connected, so no email confirmation was read; the person connects it themselves (they sign in to Google)");
  else if (m.gmail === "not_allowed") out.push("Gmail is connected without permission to read mail, so no email confirmation was read");
  else if (m.gmail === "connected") {
    out.push(`Gmail-based: only confirmations that reached ${m.mailbox || "the connected Gmail"}${m.read_through ? `, read through ${m.read_through.slice(0, 10)}` : ""}`);
    out.push("an application confirmed to another email address, or a status change shown only on an employer's portal, is not in this record");
    out.push("one Gmail account at a time: Trainee does not read several accounts");
  } else out.push("whether Gmail is connected could not be read just now");
  out.push("researched roles are research only, not applications");
  return out;
}

// G9: what changed since the record was last shown, by the same evidence.
export function changesSince(prev: Snapshot | null, applied: AppliedItem[]): RecordChange[] {
  if (!prev?.items?.length) return [];
  const out: RecordChange[] = [];
  for (const p of prev.items) {
    const now = applied.find((a) => a.ref === p.ref) ?? applied.find((a) => p.hashes.length && a.hashes.some((h) => p.hashes.includes(h)));
    if (!now) { out.push({ ref: p.ref, what: "no longer on record", was: `${p.company}${p.role ? ` (${p.role})` : ""}`, now: "not in the record now" }); continue; }
    if (!sameCompany(now.company, p.company)) out.push({ ref: now.ref, what: "employer", was: p.company, now: now.company });
    if ((now.role ?? "") !== (p.role ?? "") && (now.role || p.role)) out.push({ ref: now.ref, what: "role", was: p.role ?? "not stated", now: now.role ?? "not stated" });
    if (now.stage !== p.stage) out.push({ ref: now.ref, what: "stage", was: p.stage, now: now.stage });
  }
  return out.slice(0, 10);
}
export const snapshotOf = (r: ApplicationRecord): Snapshot => ({ at: r.as_of, items: r.applied.map((a) => ({ ref: a.ref, company: a.company, role: a.role, stage: a.stage, hashes: a.hashes.slice(0, 10) })) });

export function buildRecord(o: { now: number; apps: TrackedApp[]; events: StatusEvent[]; situation: Situation | null; listed: any[] | null | undefined; mail: MailCoverage; previous: Snapshot | null; unreadable?: string[] }): ApplicationRecord {
  const applied = appliedFrom(o.apps, o.events, o.situation);
  return {
    as_of: new Date(o.now).toISOString(), applied, researched: researchedFrom(o.listed, o.situation, applied), drafts: draftsFrom(o.situation),
    mail: o.mail, coverage: coverageOf(o.mail), changes: changesSince(o.previous, applied), unreadable: [...new Set([...(o.unreadable ?? []), ...(o.situation?.unreadable ?? [])])],
  };
}

// The tracker File's data (file_kinds.ts kind "tracker", built by code only: trusted).
const DAY = (s: string | null) => (s ? s.slice(0, 10) : null);
export function trackerData(r: ApplicationRecord): Record<string, unknown> {
  return {
    title: "Application tracker", as_of: r.as_of,
    applied: r.applied.map((a) => ({ company: a.company, ...(a.role ? { role: a.role } : {}), ...(DAY(a.applied_at) ? { applied_on: DAY(a.applied_at) } : {}), status: a.status, source: a.confirmed_by,
      evidence: a.evidence.filter((e) => e.at).map((e) => ({ what: e.from === "gmail" ? (STATUS[e.kind] ?? e.kind) : e.from === "trainee" ? "submitted by Trainee" : "you told me", on: DAY(e.at), ...(e.text ? { text: e.text } : {}) })).slice(0, 6) })),
    researched: r.researched.map((x) => ({ company: x.company, ...(x.role ? { role: x.role } : {}), ...(x.url ? { url: x.url } : {}), status: "researched, not applied" })),
    drafts: r.drafts.map((d) => ({ ...(d.company ? { company: d.company } : {}), what: d.what, status: d.state, ...(DAY(d.since) ? { since: DAY(d.since) } : {}) })),
    coverage: r.coverage,
    ...(r.changes.length ? { changes: r.changes.map((c) => `${c.what}: was ${c.was}, now ${c.now}`) } : {}),
  };
}
