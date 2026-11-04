// WO-034: where interviews and the weekly digest live (20261021050000_career_brief_digest.sql). career_interviews keeps
// what each invite stated and when its brief went out (the time from the email to the brief is measured from these
// rows); career_digest_prefs keeps the person's digest day, hour and on/off. The digest reads everything else from the
// rows other orders write: career_apply_jobs, the tracker, career_mail_events, career_mail_drafts, career_outbox,
// career_events. The person reads their own rows; only the service role writes.
import type { InterviewRow } from "./career_invite.ts";
import { type DigestPrefs, type DigestRows } from "./career_digest.ts";
import type { StatusEvent } from "./career_mail.ts";

export interface InterviewPerson { user_id: string; tz: string | null; quiet_start?: number; quiet_end?: number }
export interface InterviewStore {
  // false: that invite was stored before (once per message or pasted text, ever).
  save(userId: string, row: InterviewRow): Promise<boolean>;
  list(userId: string): Promise<InterviewRow[]>;
  briefed(userId: string, key: string, at: number, ms: number | null): Promise<void>;
  // People with an interview dated in [from, to], for the thank-you and nudge run.
  dated(fromDate: string, toDate: string): Promise<InterviewPerson[]>;
}
export interface DigestPerson { user_id: string; tz: string | null; quiet_start?: number; quiet_end?: number; prefs: DigestPrefs | null }
export interface DigestStore {
  get(userId: string): Promise<{ prefs: DigestPrefs; tz: string | null } | null>;
  save(userId: string, prefs: DigestPrefs, tz: string | null): Promise<void>;
  // Everyone the digest may be for: a digest row, or career activity in the last 30 days.
  people(now: number): Promise<DigestPerson[]>;
  rows(userId: string, sinceIso: string): Promise<DigestRows>;
}

// ------------------------------------------------------------------------------------------------ memory (tests)
export interface MemoryBriefs {
  interviews: Record<string, InterviewRow[]>; digest: Record<string, { prefs: DigestPrefs; tz: string | null }>;
  people: InterviewPerson[]; rows: Record<string, Partial<DigestRows>>;
}
export function memoryBriefStores(init: Partial<MemoryBriefs> = {}): { interviews: InterviewStore; digest: DigestStore; dump(): MemoryBriefs } {
  const st: MemoryBriefs = { interviews: {}, digest: {}, people: [], rows: {}, ...JSON.parse(JSON.stringify(init)) };
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const person = (u: string): InterviewPerson => st.people.find((p) => p.user_id === u) ?? { user_id: u, tz: null };
  const interviews: InterviewStore = {
    async save(u, row) {
      const mine = (st.interviews[u] ??= []);
      if (mine.some((r) => r.key === row.key)) return false;
      mine.push(copy(row));
      return true;
    },
    async list(u) { return copy(st.interviews[u] ?? []); },
    async briefed(u, key, at, ms) {
      const r = (st.interviews[u] ?? []).find((x) => x.key === key);
      if (r) { r.brief_at = new Date(at).toISOString(); r.brief_ms = ms; }
    },
    async dated(from, to) {
      return Object.entries(st.interviews).filter(([, rs]) => rs.some((r) => r.date && r.date >= from && r.date <= to)).map(([u]) => copy(person(u)));
    },
  };
  const digest: DigestStore = {
    async get(u) { return st.digest[u] ? copy(st.digest[u]) : null; },
    async save(u, prefs, tz) { st.digest[u] = copy({ prefs, tz }); },
    async people() {
      const ids = new Set([...Object.keys(st.digest), ...Object.keys(st.rows), ...Object.keys(st.interviews), ...st.people.map((p) => p.user_id)]);
      return [...ids].map((u) => ({ ...copy(person(u)), tz: person(u).tz ?? st.digest[u]?.tz ?? null, prefs: st.digest[u]?.prefs ?? null }));
    },
    async rows(u) {
      const r = st.rows[u] ?? {};
      return copy({ queue: r.queue ?? [], tracker: r.tracker ?? [], mail: r.mail ?? [], interviews: st.interviews[u] ?? r.interviews ?? [], drafts: r.drafts ?? [], alerts: r.alerts ?? [], events: r.events ?? [] });
    },
  };
  return { interviews, digest, dump: () => copy(st) };
}

// ------------------------------------------------------------------------------------------------ Supabase
function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const fromRow = (r: any): InterviewRow => ({
  key: r.invite_key, source: r.source, ref: r.application_ref ?? null, company: r.company ?? null, role: r.role ?? null,
  when_said: Array.isArray(r.when_said) ? r.when_said : [], date: r.interview_date ?? null, time: r.interview_time ?? null, zone: r.zone ?? null,
  starts_at: r.starts_at ?? null, format: r.format ?? null, interviewers: Array.isArray(r.interviewers) ? r.interviewers : [],
  mail_at: r.mail_at ?? null, seen_at: r.seen_at, brief_at: r.brief_at ?? null, brief_ms: r.brief_ms ?? null,
});
// deno-lint-ignore no-explicit-any
export function supabaseInterviewStore(admin: any): InterviewStore {
  return {
    async save(u, row) {
      const r = await admin.from("career_interviews").insert({
        user_id: u, invite_key: row.key, source: row.source, application_ref: row.ref, company: row.company?.slice(0, 200) ?? null, role: row.role?.slice(0, 200) ?? null,
        when_said: row.when_said.slice(0, 6).map((s) => s.slice(0, 80)), interview_date: row.date, interview_time: row.time, zone: row.zone, starts_at: row.starts_at,
        format: row.format, interviewers: row.interviewers.slice(0, 6), mail_at: row.mail_at, seen_at: row.seen_at,
      });
      if (r.error && (r.error.code === "23505" || /duplicate key/i.test(r.error.message))) return false;
      must(r, "save an interview");
      return true;
    },
    async list(u) {
      return (must<any[]>(await admin.from("career_interviews").select("*").eq("user_id", u).order("seen_at", { ascending: false }).limit(200), "read interviews") ?? []).map(fromRow);
    },
    async briefed(u, key, at, ms) {
      must(await admin.from("career_interviews").update({ brief_at: new Date(at).toISOString(), brief_ms: ms === null ? null : Math.max(0, Math.round(ms)) }).eq("user_id", u).eq("invite_key", key), "record the brief");
    },
    async dated(from, to) {
      const rows = must<any[]>(await admin.from("career_interviews").select("user_id").gte("interview_date", from).lte("interview_date", to).limit(5000), "read dated interviews") ?? [];
      const ids = [...new Set(rows.map((r) => r.user_id))];
      if (!ids.length) return [];
      const prefs = must<any[]>(await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", ids), "read quiet hours") ?? [];
      const of = new Map(prefs.map((p) => [p.user_id, p]));
      return ids.map((u) => { const p: any = of.get(u); return { user_id: u, tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end }; });
    },
  };
}

const DIGEST_ACTIVE_DAYS = 30;
// deno-lint-ignore no-explicit-any
export function supabaseDigestStore(admin: any): DigestStore {
  return {
    async get(u) {
      const r = must<any>(await admin.from("career_digest_prefs").select("enabled,day,hour,tz").eq("user_id", u).maybeSingle(), "read digest settings");
      return r ? { prefs: { on: r.enabled, day: r.day, hour: r.hour }, tz: r.tz ?? null } : null;
    },
    async save(u, p, tz) {
      must(await admin.from("career_digest_prefs").upsert({ user_id: u, enabled: p.on, day: p.day, hour: p.hour, tz, updated_at: new Date().toISOString() }, { onConflict: "user_id" }), "save digest settings");
    },
    async people(now) {
      const since = new Date(now - DIGEST_ACTIVE_DAYS * 86400000).toISOString();
      const ids = new Set<string>();
      const add = async (table: string, col: string) => {
        for (const r of must<any[]>(await admin.from(table).select("user_id").gte(col, since).limit(20000), `read ${table}`) ?? []) ids.add(r.user_id);
      };
      await add("career_apply_jobs", "updated_at");
      await add("career_mail_events", "detected_at");
      await add("career_interviews", "seen_at");
      await add("career_events", "at");
      const set = must<any[]>(await admin.from("career_digest_prefs").select("user_id,enabled,day,hour,tz").limit(20000), "read digest settings") ?? [];
      for (const r of set) ids.add(r.user_id);
      if (!ids.size) return [];
      const list = [...ids];
      const prefs: any[] = [];
      for (let i = 0; i < list.length; i += 500) prefs.push(...(must<any[]>(await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", list.slice(i, i + 500)), "read quiet hours") ?? []));
      const quiet = new Map(prefs.map((p) => [p.user_id, p])), mine = new Map(set.map((r) => [r.user_id, r]));
      return list.map((u) => {
        const q: any = quiet.get(u), d: any = mine.get(u);
        return { user_id: u, tz: q?.tz ?? d?.tz ?? null, quiet_start: q?.prefs?.quiet_start, quiet_end: q?.prefs?.quiet_end, prefs: d ? { on: d.enabled, day: d.day, hour: d.hour } : null };
      });
    },
    async rows(u, sinceIso) {
      const [queue, threads, mail, interviews, drafts, alerts, events] = await Promise.all([
        admin.from("career_apply_jobs").select("id,company,url,state,created_at,updated_at,title:payload->>title").eq("user_id", u).order("created_at", { ascending: false }).limit(1000),
        admin.from("agent_flow_state").select("rows:state->career->stores->trackStore->rows").eq("user_id", u).limit(200),
        admin.from("career_mail_events").select("application_ref,kind,company,role,stage,flagged,evidence,message_hash,mail_at").eq("user_id", u).order("mail_at", { ascending: true }).limit(2000),
        admin.from("career_interviews").select("*").eq("user_id", u).order("seen_at", { ascending: false }).limit(200),
        admin.from("career_mail_drafts").select("draft_key,kind,company,role,state,created_at").eq("user_id", u).eq("state", "drafted").order("created_at", { ascending: false }).limit(200),
        // PROACTIVE SCENARIOS (2026-10-29): "Job alerts sent" counts the alerts that went out. It counted every alert row
        // queued in the week, so alerts held back by a STOP or a pause, or stopped at delivery (skipped_opt_out), and ones
        // still waiting were told to the person as sent.
        admin.from("career_outbox").select("created_at").eq("user_id", u).eq("kind", "alert").eq("status", "delivered").gte("created_at", sinceIso).limit(1000),
        admin.from("career_events").select("at,kind,subject,detail").eq("user_id", u).eq("kind", "status_change").gte("at", sinceIso).limit(500),
      ]);
      return {
        queue: must<any[]>(queue, "read applications") ?? [],
        tracker: (must<any[]>(threads, "read the tracker") ?? []).flatMap((t) => (Array.isArray(t.rows) ? t.rows : [])),
        mail: (must<any[]>(mail, "read status events") ?? []).map((r): StatusEvent => ({ hash: r.message_hash, ref: r.application_ref, kind: r.kind, company: r.company, role: r.role ?? undefined, stage: r.stage, flagged: r.flagged, evidence: r.evidence, at: r.mail_at, new_app: false })),
        interviews: (must<any[]>(interviews, "read interviews") ?? []).map(fromRow),
        drafts: (must<any[]>(drafts, "read drafts") ?? []).map((d) => ({ key: d.draft_key, kind: d.kind, company: d.company, role: d.role ?? null, state: d.state, created_at: d.created_at })),
        alerts: must<any[]>(alerts, "read alerts sent") ?? [],
        events: must<any[]>(events, "read the timeline") ?? [],
      };
    },
  };
}
