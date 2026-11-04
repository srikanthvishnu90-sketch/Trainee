// Outcome funnel (owner, 2026-10-28: "there is no outcome funnel and no monitoring"). Per UTC day and per user, how far
// people got, counted from rows that already exist and nothing else. A stage with no table that records it, or whose read
// failed, is null and prints "not measured"; it is never zero and never estimated.
//   searches          assistant turns labelled career_discovery / career_internship_discovery (agent_messages.meta.intent)
//   postings_shown    NOT MEASURED: no table records how many postings a reply showed
//   queued            career_apply_jobs created (an enqueue needs the person's approval hash)
//   prepared          career_apply_prepared created (the engine's dry run for the person's card)
//   approved          career_apply_prepared set to approved + career_apply_batch_approvals approved; one approval is one
//                     (person, posting) however many of those rows record it, counted once at the earliest time either does
//   submitted         career_apply_jobs the queue recorded as sent, or possibly sent (confirmed, submitted_unconfirmed,
//                     unknown_outcome), on claimed_at (else created_at)
//   confirmed         career_apply_jobs.email_confirmed_at: the employer's own email, on that time
//   replies           career_mail_events of kind rejection / interview / assessment / offer / recruiter_reply, not flagged
//   interviews        career_mail_events of kind interview / assessment / offer, not flagged
// Counts are by the day each event happened, so one application shows in several days' columns. Reads are bounded by LIMIT
// rows per stage; a stage that hit the bound is reported as truncated, not as a total.
export const STAGES = ["searches", "postings_shown", "queued", "prepared", "approved", "submitted", "confirmed", "replies", "interviews"] as const;
export type Stage = typeof STAGES[number];
export interface StageRow { user_id: string; at: string }
export interface StageRead { rows: StageRow[]; truncated?: boolean }
export type FunnelSource = Partial<Record<Stage, (fromIso: string, toIso: string) => Promise<StageRead>>>;
export type Counts = Record<Stage, number | null>;
export interface FunnelDay { day: string; totals: Counts; users: { user_id: string; counts: Counts }[] }
export interface Funnel { from: string; to: string; days: FunnelDay[]; totals: Counts; notMeasured: Partial<Record<Stage, string>>; truncated: Stage[] }

export const LIMIT = 10000;
const emptyCounts = (): Counts => Object.fromEntries(STAGES.map((s) => [s, null])) as Counts;
const bump = (c: Counts, s: Stage) => { c[s] = (c[s] ?? 0) + 1; };

export async function buildFunnel(src: FunnelSource, fromIso: string, toIso: string): Promise<Funnel> {
  const notMeasured: Partial<Record<Stage, string>> = {};
  const truncated: Stage[] = [];
  const byDay = new Map<string, Map<string, Counts>>();
  const dayTotals = new Map<string, Counts>();
  const totals = emptyCounts();
  for (const stage of STAGES) {
    const read = src[stage];
    if (!read) { notMeasured[stage] = stage === "postings_shown" ? "no table records how many postings a reply showed" : "no source wired"; continue; }
    let r: StageRead;
    try { r = await read(fromIso, toIso); } catch (e) { notMeasured[stage] = `read failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`; continue; }
    if (r.truncated) truncated.push(stage);
    totals[stage] = 0;
    for (const row of r.rows) {
      const t = Date.parse(row.at);
      if (!Number.isFinite(t) || t < Date.parse(fromIso) || t >= Date.parse(toIso)) continue;
      const day = new Date(t).toISOString().slice(0, 10);
      const users = byDay.get(day) ?? byDay.set(day, new Map()).get(day)!;
      const c = users.get(row.user_id) ?? users.set(row.user_id, emptyCounts()).get(row.user_id)!;
      const dt = dayTotals.get(day) ?? dayTotals.set(day, emptyCounts()).get(day)!;
      // A measured stage is 0 (not null) for every user/day row once any row exists.
      bump(c, stage); bump(dt, stage); totals[stage] = (totals[stage] ?? 0) + 1;
    }
  }
  const measured = STAGES.filter((s) => totals[s] !== null);
  const days: FunnelDay[] = [...byDay.keys()].sort().map((day) => {
    const t = dayTotals.get(day)!;
    for (const s of measured) t[s] ??= 0;
    const users = [...byDay.get(day)!.entries()].map(([user_id, counts]) => { for (const s of measured) counts[s] ??= 0; return { user_id, counts }; })
      .sort((a, b) => (b.counts.submitted ?? 0) - (a.counts.submitted ?? 0) || (b.counts.queued ?? 0) - (a.counts.queued ?? 0) || a.user_id.localeCompare(b.user_id));
    return { day, totals: t, users };
  });
  return { from: fromIso, to: toIso, days, totals, notMeasured, truncated };
}

const LABEL: Record<Stage, string> = { searches: "searches", postings_shown: "postings shown", queued: "applies queued", prepared: "prepared", approved: "approved", submitted: "submitted", confirmed: "confirmed by employer", replies: "replies", interviews: "interviews" };
const cell = (n: number | null) => (n === null ? "not measured" : String(n));
const line = (c: Counts) => STAGES.map((s) => `${LABEL[s]} ${cell(c[s])}`).join(", ");
export const shortUser = (id: string) => id.slice(0, 8);

// Plain text for Telegram (no parse mode). maxUsers per day bounds the message; the rest are counted, never silently dropped.
export function renderFunnel(f: Funnel, opts: { maxUsers?: number; maxDays?: number } = {}): string {
  const maxUsers = opts.maxUsers ?? 5, maxDays = opts.maxDays ?? 7;
  const out: string[] = [`Outcome funnel ${f.from.slice(0, 10)} to ${f.to.slice(0, 10)} (UTC)`, `All days: ${line(f.totals)}`];
  const shown = f.days.slice(-maxDays);
  if (!f.days.length) out.push("No funnel events in this window.");
  for (const d of shown) {
    out.push(`${d.day}: ${line(d.totals)}`);
    for (const u of d.users.slice(0, maxUsers)) out.push(`  ${shortUser(u.user_id)}: ${line(u.counts)}`);
    if (d.users.length > maxUsers) out.push(`  and ${d.users.length - maxUsers} more users`);
  }
  if (f.days.length > shown.length) out.push(`(${f.days.length - shown.length} earlier days not shown)`);
  const nm = Object.entries(f.notMeasured);
  if (nm.length) out.push(`Not measured: ${nm.map(([s, why]) => `${LABEL[s as Stage]} (${why})`).join("; ")}`);
  if (f.truncated.length) out.push(`Truncated at ${LIMIT} rows, counts are lower bounds: ${f.truncated.map((s) => LABEL[s]).join(", ")}`);
  return out.join("\n");
}

// ---- The real reads (service-role client). One function per stage; each may throw, which makes that stage "not measured".
type Admin = any;
async function pageRows(q: any, userKey: string, atKey: string): Promise<StageRead> {
  const { data, error } = await q.limit(LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((r: any) => ({ user_id: r[userKey], at: r[atKey] })).filter((r: StageRow) => r.user_id && r.at);
  return { rows, truncated: (data ?? []).length >= LIMIT };
}
export const SEARCH_INTENTS = ["career_discovery", "career_internship_discovery"];
export const WENT_STATES = ["confirmed", "submitted_unconfirmed", "unknown_outcome"];
export const REPLY_KINDS = ["rejection", "interview", "assessment", "offer", "recruiter_reply"];
export const INTERVIEW_KINDS = ["interview", "assessment", "offer"];

export function supabaseFunnelSource(admin: Admin): FunnelSource {
  return {
    async searches(from, to) {
      const { data, error } = await admin.from("agent_messages").select("thread_id,created_at").eq("role", "assistant")
        .in("meta->>intent", SEARCH_INTENTS).gte("created_at", from).lt("created_at", to).limit(LIMIT);
      if (error) throw new Error(error.message);
      const msgs = data ?? [];
      const ids = [...new Set<string>(msgs.map((m: any) => m.thread_id))];
      const owner = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 200) {
        const t = await admin.from("agent_threads").select("id,user_id").in("id", ids.slice(i, i + 200));
        if (t.error) throw new Error(t.error.message);
        for (const r of t.data ?? []) owner.set(r.id, r.user_id);
      }
      return { rows: msgs.filter((m: any) => owner.has(m.thread_id)).map((m: any) => ({ user_id: owner.get(m.thread_id)!, at: m.created_at })), truncated: msgs.length >= LIMIT };
    },
    queued: (from, to) => pageRows(admin.from("career_apply_jobs").select("user_id,created_at").gte("created_at", from).lt("created_at", to), "user_id", "created_at"),
    prepared: (from, to) => pageRows(admin.from("career_apply_prepared").select("user_id,created_at").gte("created_at", from).lt("created_at", to), "user_id", "created_at"),
    async approved(from, to) {
      const sel = async (table: string, cols: string, atKey: string, state: boolean, jobs?: string[]) => {
        let q = admin.from(table).select(cols);
        if (state) q = q.eq("state", "approved");
        q = jobs ? q.in("job_id", jobs).lt(atKey, to) : q.gte(atKey, from).lt(atKey, to);
        const { data, error } = await q.limit(LIMIT);
        if (error) throw new Error(error.message);
        return { rows: (data ?? []) as any[], truncated: (data ?? []).length >= LIMIT };
      };
      const A = ["career_apply_prepared", "user_id,job_id,updated_at", "updated_at", true] as const;
      const B = ["career_apply_batch_approvals", "user_id,job_id,approved_at", "approved_at", false] as const;
      const a = await sel(...A), b = await sel(...B);
      // One approval is one (person, posting), but the card's approval writes a prepared row and a batch-approval row for it,
      // possibly on different days. Look both tables up for every posting seen in the window and count each pair once, at the
      // earliest time either records it, and only if that time is inside the window.
      const wanted = new Set([...a.rows, ...b.rows].filter((r) => r.user_id && r.job_id).map((r) => `${r.user_id}|${r.job_id}`));
      const jobs = [...new Set([...a.rows, ...b.rows].map((r) => String(r.job_id ?? "")).filter(Boolean))];
      const first = new Map<string, string>();
      let truncated = a.truncated || b.truncated;
      for (let i = 0; i < jobs.length; i += 200) {
        for (const [table, cols, atKey, state] of [A, B]) {
          const r = await sel(table, cols, atKey, state, jobs.slice(i, i + 200));
          truncated = truncated || r.truncated;
          for (const x of r.rows) {
            const k = `${x.user_id}|${x.job_id}`, at = String(x[atKey] ?? "");
            if (wanted.has(k) && at && (!first.has(k) || Date.parse(at) < Date.parse(first.get(k)!))) first.set(k, at);
          }
        }
      }
      const rows = [...first.entries()].filter(([, at]) => at >= from && at < to).map(([k, at]) => ({ user_id: k.split("|")[0], at }));
      return { rows, truncated };
    },
    async submitted(from, to) {
      const { data, error } = await admin.from("career_apply_jobs").select("user_id,created_at,claimed_at").in("state", WENT_STATES)
        .or(`and(claimed_at.gte.${from},claimed_at.lt.${to}),and(claimed_at.is.null,created_at.gte.${from},created_at.lt.${to})`).limit(LIMIT);
      if (error) throw new Error(error.message);
      return { rows: (data ?? []).map((r: any) => ({ user_id: r.user_id, at: r.claimed_at ?? r.created_at })), truncated: (data ?? []).length >= LIMIT };
    },
    confirmed: (from, to) => pageRows(admin.from("career_apply_jobs").select("user_id,email_confirmed_at").not("email_confirmed_at", "is", null).gte("email_confirmed_at", from).lt("email_confirmed_at", to), "user_id", "email_confirmed_at"),
    replies: (from, to) => pageRows(admin.from("career_mail_events").select("user_id,mail_at").eq("flagged", false).in("kind", REPLY_KINDS).gte("mail_at", from).lt("mail_at", to), "user_id", "mail_at"),
    interviews: (from, to) => pageRows(admin.from("career_mail_events").select("user_id,mail_at").eq("flagged", false).in("kind", INTERVIEW_KINDS).gte("mail_at", from).lt("mail_at", to), "user_id", "mail_at"),
  };
}
