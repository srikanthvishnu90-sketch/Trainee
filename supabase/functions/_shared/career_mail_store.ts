// WO-024: where mail tracking keeps what it found (20261020100000_career_mail_tracking.sql) and where it reads the
// person's applications from: the apply queue (career_apply_jobs) and the tracker they keep by text (the career state's
// trackStore in agent_flow_state). The run writes events, drafts and the read cursor; it never writes the queue or the
// tracker, so a chat turn and the scheduled run never race on the same row.
import { type Draft, mergeApps, type StatusEvent, type TrackedApp } from "./career_mail.ts";
import { MAIL_MODEL_DAILY_CAP } from "./career_mail_model.ts";

export interface MailPerson { user_id: string; read_through: string | null; tz?: string | null; quiet_start?: number; quiet_end?: number }
export interface MailStore {
  // People with the career Google grant, the least recently read first.
  people(limit: number): Promise<MailPerson[]>;
  applications(userId: string): Promise<TrackedApp[]>;
  events(userId: string): Promise<StatusEvent[]>;
  // The message hashes stored by this call; one already stored (an earlier run) is not in the set.
  record(userId: string, events: StatusEvent[]): Promise<Set<string>>;
  // false: that draft was made before (once per application and kind, ever).
  saveDraft(userId: string, d: Draft): Promise<boolean>;
  saveCursor(userId: string, readThrough: number): Promise<void>;
  // Google verification (2026-10-26): is the person's career Google grant still there? A run reads their Gmail first and
  // writes afterwards; if they said "disconnect gmail" in between, what it read must not be saved. A store without it
  // never skips a write (the tests' stores that have no grants).
  stillConnected?(userId: string): Promise<boolean>;
  // WO-051: model calls granted to this person today (UTC), at most `want` and never past `cap` in the day, counted in the
  // database before any call (career_mail_model_claim). A store without it grants none: the model is never asked.
  claimModelCalls?(userId: string, want: number, cap: number, now: number): Promise<number>;
}

// Applications that reached the employer, or may have. One that never went (failed, not sent, still queued or waiting on
// the person) has no mail to match.
const WENT = new Set(["confirmed", "submitted_unconfirmed", "unknown_outcome"]);
export function appsFromQueue(rows: any[]): TrackedApp[] {
  return (rows ?? []).filter((r) => WENT.has(r.state) && r.company).map((r) => ({
    ref: `job:${r.id}`, company: String(r.company), role: r.title ? String(r.title) : undefined, url: r.url ?? undefined,
    applied_at: r.updated_at ?? r.created_at, stage: "Submitted", source: "queue" as const, events: [],
  }));
}
// The tracker's own words for what happened, as mail kinds; anything else is left out.
const TRACK_KIND: Record<string, StatusEvent["kind"]> = {
  confirmation: "received", rejection: "rejection", interview_invite: "interview", oa_invite: "assessment", offer: "offer", recruiter_other: "recruiter_reply",
};
// WO-034: a stage the person reported ("I have an interview with Datadog") is that step too, dated when they said it.
const STAGE_KIND: Record<string, StatusEvent["kind"]> = {
  "Recruiter screen": "recruiter_reply", "OA/assessment": "assessment", "Interview rounds": "interview", Final: "interview", Offer: "offer", Rejected: "rejection",
};
const trackerKind = (e: any): StatusEvent["kind"] | undefined => TRACK_KIND[e?.type] ?? (e?.type === "manual_update" ? STAGE_KIND[e?.stage_after] : undefined);
export function appsFromTracker(rows: any[]): TrackedApp[] {
  return (rows ?? []).filter((r) => r && r.app_id && r.company).map((r) => ({
    ref: `track:${r.app_id}`, company: String(r.company), role: r.role ? String(r.role) : undefined, url: r.url || undefined,
    applied_at: r.applied_at ?? undefined, stage: String(r.stage || "Submitted"), source: "tracker" as const,
    events: (r.events ?? []).filter((e: any) => trackerKind(e) && e.at).map((e: any) => ({ kind: trackerKind(e)!, at: String(e.at), source: "tracker" })),
  }));
}

// ------------------------------------------------------------------------------------------------ memory (tests)
export interface MemoryMail {
  people: MailPerson[]; queue: Record<string, any[]>; tracker: Record<string, any[]>;
  events: Record<string, StatusEvent[]>; drafts: Record<string, Draft[]>; cursors: Record<string, number>;
  // WO-051: model calls granted, by "<user>|<UTC day>".
  model_calls: Record<string, number>;
}
export function memoryMailStore(init: Partial<MemoryMail> = {}): MailStore & { dump(): MemoryMail; disconnect(userId: string): void } {
  const st: MemoryMail = { people: [], queue: {}, tracker: {}, events: {}, drafts: {}, cursors: {}, model_calls: {}, ...JSON.parse(JSON.stringify(init)) };
  return {
    async people(limit) {
      return st.people.map((p) => ({ ...p, read_through: st.cursors[p.user_id] ? new Date(st.cursors[p.user_id]).toISOString() : p.read_through }))
        .sort((a, b) => String(a.read_through ?? "").localeCompare(String(b.read_through ?? ""))).slice(0, limit);
    },
    async applications(u) { return mergeApps(appsFromQueue(st.queue[u] ?? []), appsFromTracker(st.tracker[u] ?? [])); },
    async events(u) { return JSON.parse(JSON.stringify(st.events[u] ?? [])); },
    async record(u, evs) {
      const mine = (st.events[u] ??= []), fresh = new Set<string>();
      for (const e of evs) if (!mine.some((x) => x.hash === e.hash)) { mine.push(JSON.parse(JSON.stringify(e))); fresh.add(e.hash); }
      return fresh;
    },
    async saveDraft(u, d) {
      const mine = (st.drafts[u] ??= []);
      if (mine.some((x) => x.key === d.key)) return false;
      mine.push(JSON.parse(JSON.stringify(d)));
      return true;
    },
    async saveCursor(u, at) { st.cursors[u] = at; },
    async stillConnected(u) { return st.people.some((p) => p.user_id === u); },
    // What "disconnect gmail" does to this store: the grant goes, and so do the events, drafts and cursor.
    disconnect(u) { st.people = st.people.filter((p) => p.user_id !== u); delete st.events[u]; delete st.drafts[u]; delete st.cursors[u]; },
    async claimModelCalls(u, want, cap, now) {
      const key = `${u}|${new Date(now).toISOString().slice(0, 10)}`, used = st.model_calls[key] ?? 0;
      const got = Math.max(0, Math.min(Math.floor(want), Math.min(cap, MAIL_MODEL_DAILY_CAP) - used));
      st.model_calls[key] = used + got;
      return got;
    },
    dump() { return JSON.parse(JSON.stringify(st)); },
  };
}

// ------------------------------------------------------------------------------------------------ Supabase
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
// deno-lint-ignore no-explicit-any
// CONNECTORS ROUND 3 (2026-10-31): what a run read from someone's Gmail is written only while their grant is there and no
// "forget everything" came after the run started (career_mail_record_events, career_mail_save_draft, career_mail_save_cursor,
// 20261031060000). Before, a disconnect between stillConnected and the write re-created what the disconnect had erased, and
// an erase was never checked. The erase epoch is read with the people, before their mail is read. A project without the
// functions gets the old writes.
const missingFn = (e: any, fn: string) => { const s = `${e?.code ?? ""} ${e?.message ?? ""}`; return (s.includes(fn) || /PGRST202/.test(s)) && /exist|find|no function|PGRST202/i.test(s); };
export function supabaseMailStore(admin: any): MailStore {
  const epochs = new Map<string, number>();
  // People whose mail this store recorded: their drafts come from that mail. An interview's thank-you (runInterviewDrafts)
  // is made for anyone, mail grant or not, and is written as before.
  const fromMail = new Set<string>();
  return {
    async people(limit) {
      const conns = must<any[]>(await admin.from("user_oauth_connections").select("user_id").eq("provider", "google_career").limit(5000), "read career grants") ?? [];
      const ids = [...new Set(conns.map((c) => c.user_id))];
      if (!ids.length) return [];
      const acct = await admin.from("career_watch_kv").select("user_id,value").eq("key", "career:account").in("user_id", ids);
      if (!acct.error) {
        for (const u of ids) epochs.set(u, 0);
        for (const a of acct.data ?? []) { const e = Number(a?.value?.epoch ?? 0); if (Number.isFinite(e)) epochs.set(a.user_id, e); }
      }
      const cur = must<any[]>(await admin.from("career_mail_cursors").select("user_id,read_through").in("user_id", ids), "read mail cursors") ?? [];
      const prefs = must<any[]>(await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", ids), "read quiet hours") ?? [];
      const at = new Map(cur.map((c) => [c.user_id, c.read_through])), pref = new Map(prefs.map((p) => [p.user_id, p]));
      return ids.map((u) => {
        const p: any = pref.get(u);
        return { user_id: u, read_through: at.get(u) ?? null, tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end };
      }).sort((a, b) => String(a.read_through ?? "").localeCompare(String(b.read_through ?? ""))).slice(0, limit);
    },
    async applications(u) {
      const queue = must<any[]>(await admin.from("career_apply_jobs").select("id,company,url,state,created_at,updated_at,title:payload->>title")
        .eq("user_id", u).order("created_at", { ascending: false }).limit(1000), "read applications") ?? [];
      const threads = must<any[]>(await admin.from("agent_flow_state").select("rows:state->career->stores->trackStore->rows").eq("user_id", u).limit(200), "read the tracker") ?? [];
      const tracked = threads.flatMap((t) => (Array.isArray(t.rows) ? t.rows : []));
      return mergeApps(appsFromQueue(queue), appsFromTracker(tracked));
    },
    async events(u) {
      const rows = must<any[]>(await admin.from("career_mail_events").select("application_ref,kind,company,role,stage,flagged,evidence,message_hash,mail_at")
        .eq("user_id", u).order("mail_at", { ascending: true }).limit(2000), "read status events") ?? [];
      return rows.map((r) => ({ hash: r.message_hash, ref: r.application_ref, kind: r.kind, company: r.company, role: r.role ?? undefined, stage: r.stage, flagged: r.flagged, evidence: r.evidence, at: r.mail_at, new_app: false }));
    },
    async record(u, evs) {
      fromMail.add(u);
      if (!evs.length) return new Set();
      const rows = evs.map((e) => ({ user_id: u, application_ref: e.ref, kind: e.kind, company: e.company.slice(0, 200), role: e.role?.slice(0, 200) ?? null, stage: e.stage, flagged: e.flagged, evidence: e.evidence, message_hash: e.hash, mail_at: e.at }));
      const g = await admin.rpc("career_mail_record_events", { p_user: u, p_rows: rows.map(({ user_id: _u, ...r }) => r), p_epoch: epochs.get(u) ?? null });
      if (g.error && missingFn(g.error, "career_mail_record_events")) {
        const got = must<any[]>(await admin.from("career_mail_events").upsert(rows, { onConflict: "user_id,message_hash", ignoreDuplicates: true }).select("message_hash"), "record status events") ?? [];
        return new Set(got.map((r) => r.message_hash));
      }
      const out = must<any>(g, "record status events");
      if (out?.ok !== true) { epochs.set(u, Number.POSITIVE_INFINITY); return new Set(); } // withdrawn: stillConnected says so
      return new Set((Array.isArray(out.stored) ? out.stored : []).map(String));
    },
    async saveDraft(u, d) {
      const g = !fromMail.has(u) ? null : await admin.rpc("career_mail_save_draft", { p_user: u, p_row: { draft_key: d.key, application_ref: d.ref, kind: d.kind, company: d.company.slice(0, 200), role: d.role?.slice(0, 200) ?? null, text: d.text, basis: d.basis },
        p_epoch: epochs.has(u) && Number.isFinite(epochs.get(u)!) ? epochs.get(u) : null });
      if (g && !(g.error && missingFn(g.error, "career_mail_save_draft"))) return must<string>(g, "save a draft") === "saved";
      const r = await admin.from("career_mail_drafts").insert({ user_id: u, draft_key: d.key, application_ref: d.ref, kind: d.kind, company: d.company.slice(0, 200), role: d.role?.slice(0, 200) ?? null, text: d.text, basis: d.basis });
      if (r.error && (r.error.code === "23505" || /duplicate key/i.test(r.error.message))) return false;
      must(r, "save a draft");
      return true;
    },
    async saveCursor(u, at) {
      const g = await admin.rpc("career_mail_save_cursor", { p_user: u, p_read_through: new Date(at).toISOString() });
      if (!(g.error && missingFn(g.error, "career_mail_save_cursor"))) { must(g, "save the mail cursor"); return; }
      must(await admin.from("career_mail_cursors").upsert({ user_id: u, read_through: new Date(at).toISOString(), updated_at: new Date().toISOString() }, { onConflict: "user_id" }), "save the mail cursor");
    },
    async stillConnected(u) {
      // A write the database refused (disconnected or erased since the run began): nothing more of this run is kept or said.
      if (epochs.get(u) === Number.POSITIVE_INFINITY) return false;
      const r = must<any[]>(await admin.from("user_oauth_connections").select("provider").eq("user_id", u).eq("provider", "google_career").limit(1), "read the career grant") ?? [];
      if (!r.length) return false;
      if (epochs.has(u)) {
        const a = await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", "career:account").maybeSingle();
        if (!a.error && Number(a.data?.value?.epoch ?? 0) > (epochs.get(u) ?? 0)) return false;
      }
      return true;
    },
    // The database's own day and count (20261021130000_career_mail_model_calls.sql); the run's clock is not trusted here.
    async claimModelCalls(u, want, cap) {
      const got = must<number>(await admin.rpc("career_mail_model_claim", { p_user: u, p_want: Math.floor(want), p_cap: cap }), "claim mail model calls");
      return Math.max(0, Number(got) || 0);
    },
  };
}
