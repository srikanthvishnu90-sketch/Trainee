// WO-100: the person's situation, built by code every turn: every task in flight across the ~15 places the product keeps
// one (the apply queue, the chat queue, prepared applications, open questions, outreach and mail drafts, interviews, the
// tracker in every thread), each with its state, what blocks it, who acts and the exact step that unblocks it; their goal;
// today's count against the daily limit; the last list shown; the next steps in an order fixed here; what Trainee can do
// right now (career_capabilities.ts); and the sources that could not be read, which are never guessed.
// Read only. The model explains it; it never decides a state.
import { COUNTED_STATES, paceState } from "./career_apply.ts";
import { sameCompany } from "./career_mail.ts";
import { type Capability, capabilitiesFrom, type Connection } from "./career_capabilities.ts";

export type Actor = "person" | "trainee" | "extension" | "employer";
export interface Task {
  id: string;
  kind: "application" | "apply_request" | "question" | "outreach" | "mail_draft" | "interview" | "tracked";
  company: string | null; title: string | null; state: string; since: string | null;
  blocker: { what: string; who: Actor; how: string } | null;
  evidence: { confirmation_id?: string; reason?: string; url?: string; job_id?: string; stage?: string; when?: string; email_confirmed_at?: string; mail_hash?: string; sent_at?: string; open?: { label: string; options?: string[] }[] };
  source: string;
}
export interface Situation {
  as_of: string;
  goal: { roles: string[]; places: string[]; constraints: string[] };
  tasks: Task[];
  today: { used: number; limit: number | null; pace_unreadable?: string };
  last_shown: { at: string; query: string; items: { job_id: string; company: string; title: string }[] } | null;
  next: { who: Actor; what: string; say?: string; task_id?: string }[];
  capabilities: Capability[];
  unreadable: string[];
}
type Rows = any[];
// What readSituation read, one field per source (a source that failed is empty and named in unreadable).
export interface SituationRows {
  jobs: Rows; wanted: Rows; prepared: Rows; card?: { shown_at: string } | null; questions: Rows; outreach: Rows; mail_drafts: Rows; interviews: Rows;
  alerts: { prefs: any; tz?: string } | null; standing: { text: string }[]; daily_limit?: unknown;
  threads: { thread_id?: string; rows?: Rows | null }[]; connections: Connection[]; cloud: { enabled: boolean } | null;
  channel: { opted_out: boolean } | null; last_search: { at: string; subject: string; detail: any } | null; unreadable: string[];
}

const DAY = 86400000;
const ACTIVE = new Set(["queued", "driving", "needs_user"]);
const COUNTED = COUNTED_STATES; // one list with the queue and the database (G3)
const NEEDS: Record<string, [string, string]> = {
  email_code: ["the employer emailed a code", "type the code from the employer's email on the application page in your browser, never in this chat"],
  captcha: ["a verification on the form", "finish it on the application page in your browser"],
  needs_answers: ["questions on the form", 'text "what do you need from me" and answer them'],
};
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "");
const str = (x: unknown) => (x === null || x === undefined || x === "" ? null : String(x));

export function situationFrom(r: SituationRows, now: number): Situation {
  const tasks: Task[] = [];
  const add = (t: Omit<Task, "evidence"> & { evidence?: Task["evidence"] }) => tasks.push({ evidence: {}, ...t });
  const gmailSend = r.connections.some((c) => c.provider === "google_career" && c.scopes.some((s) => s.endsWith("/gmail.send")));
  const cloudOn = !!r.cloud?.enabled;
  for (const j of r.jobs) {
    // Finished work stays in view for 14 days; work still in flight always.
    if (!ACTIVE.has(j.state) && Date.parse(j.updated_at) < now - 14 * DAY) continue;
    const ev = { confirmation_id: str(j.confirmation_id) ?? undefined, reason: str(j.reason) ?? undefined, url: str(j.url) ?? undefined, job_id: str(j.job_id) ?? undefined,
      email_confirmed_at: str(j.email_confirmed_at) ?? undefined, mail_hash: str(j.confirmation_mail_hash) ?? undefined, sent_at: str(j.claimed_at) ?? undefined };
    const need = NEEDS[String(j.reason)];
    const blocker: Task["blocker"] = j.state === "needs_user" ? { what: need?.[0] ?? `help needed: ${j.reason ?? "no reason recorded"}`, who: "person", how: need?.[1] ?? "open the application in your browser" }
      : ["failed", "not_submitted"].includes(j.state) ? { what: `not sent: ${j.reason ?? "no reason recorded"}`, who: "person", how: "decide: fix it and queue it again, or apply on the employer's page yourself" }
      : ["queued", "driving"].includes(j.state) ? (cloudOn ? { what: "the cloud has not run it yet", who: "trainee", how: "nothing for you to do" } : { what: "the extension has not run it yet", who: "extension", how: "keep Chrome open with the Trainee extension signed in" })
      : ["submitted_unconfirmed", "unknown_outcome"].includes(j.state) ? { what: "waiting for the employer's confirmation", who: "employer", how: "nothing for you to do" }
      : null;
    add({ id: `job:${j.id}`, kind: "application", company: str(j.company), title: str(j.title), state: j.state, since: j.updated_at ?? null, blocker, evidence: ev, source: "career_apply_jobs" });
  }
  const seen = r.wanted.reduce((m: string | null, w) => (w.taken_at && (!m || w.taken_at > m) ? w.taken_at : m), null);
  for (const w of r.wanted.filter((x) => x.state === "waiting")) {
    const stale = Date.parse(w.queued_at) < now - DAY && (!seen || seen < w.queued_at);
    add({ id: `want:${w.posting_key}`, kind: "apply_request", company: str(w.company), title: str(w.title), state: "waiting_extension", since: w.queued_at, source: "career_apply_wanted",
      evidence: { url: str(w.url) ?? undefined, job_id: w.posting_key },
      blocker: stale ? { what: `the extension has not taken it since ${day(w.queued_at)}`, who: "person", how: 'open Chrome with the Trainee extension and press "Add Trainee\'s picks"' }
        : { what: "waiting for the extension to prepare it", who: "extension", how: "nothing yet" } });
  }
  const open = r.questions.filter((q) => q.answer === null || q.answer === undefined || q.misfit);
  for (const p of r.prepared.filter((x) => ["ready", "shown"].includes(x.state))) {
    const n = open.filter((q) => q.company && sameCompany(q.company, p.company)).length;
    add({ id: `prep:${p.id}`, kind: "application", company: str(p.company), title: null, state: "awaiting_approval", since: p.created_at ?? null, source: "career_apply_prepared",
      evidence: { url: str(p.url) ?? undefined, job_id: str(p.job_id) ?? undefined,
        open: open.filter((q) => p.job_id && Array.isArray(q.job_ids) && q.job_ids.includes(String(p.job_id))).map((q) => ({ label: String(q.label), options: Array.isArray(q.options) ? q.options.map(String) : [] })) },
      blocker: { what: `prepared, waiting for a yes${n ? `; ${n} open question${n > 1 ? "s" : ""}` : ""}`, who: "person",
        how: p.state === "shown" && r.card && Date.parse(r.card.shown_at) >= now - DAY ? 'answer the card already shown: "yes", "yes but not 2" or "no"' : 'text "show my applications", then yes or no' } });
  }
  for (const q of open) {
    add({ id: `q:${q.id}`, kind: "question", company: str(q.company), title: String(q.label), state: "open_question", since: q.created_at ?? null, source: "career_apply_questions",
      blocker: { what: String(q.label), who: "person", how: 'text "what do you need from me" and answer by number' } });
  }
  for (const d of r.outreach) {
    const live = ["shown", "approved", "sending"].includes(d.status);
    if (!live && !(d.status === "sent" && Date.parse(d.sent_at ?? d.created_at) >= now - 14 * DAY)) continue;
    const who = d.recipient?.name ? `${d.recipient.name}${d.recipient.title ? ` (${d.recipient.title})` : ""}` : "a contact";
    const blocker: Task["blocker"] = d.status === "shown"
      ? { what: `draft to ${who} waits for a yes${gmailSend ? "" : "; Gmail is not connected, so it cannot be sent"}`, who: "person", how: gmailSend ? 'text "show my drafts", then "send 1"' : 'connect Gmail (text "connect my Google"), then text "show my drafts" and approve it' }
      : d.status === "approved" && !gmailSend ? { what: "approved, but Gmail is not connected", who: "person", how: 'connect Gmail (text "connect my Google")' }
      : live ? { what: "approved, sends on the schedule", who: "trainee", how: "nothing for you to do" } : null;
    add({ id: `out:${d.id ?? d.n}`, kind: "outreach", company: str(d.recipient?.firm), title: `email to ${who}`, state: d.status === "shown" ? "awaiting_approval" : d.status, since: d.created_at ?? null, source: "career_outreach_drafts", blocker });
  }
  for (const m of r.mail_drafts.filter((x) => x.state === "drafted")) {
    add({ id: `mail:${m.id}`, kind: "mail_draft", company: str(m.company), title: `${m.kind === "thank_you" ? "thank-you" : "follow-up"} draft`, state: "drafted", since: m.created_at ?? null, source: "career_mail_drafts",
      blocker: { what: `a ${m.kind === "thank_you" ? "thank-you" : "follow-up"} draft is ready`, who: "person", how: "read it and send it from your own mail if you want" } });
  }
  for (const i of r.interviews) {
    const at = i.starts_at ?? i.interview_date ?? null;
    if (at && Date.parse(at) < now - DAY) continue;
    add({ id: `int:${i.id}`, kind: "interview", company: str(i.company), title: str(i.role), state: "upcoming", since: at, source: "career_interviews", blocker: null });
  }
  // The tracker the person keeps by text, from every one of their threads; an employer the queue already has is not repeated.
  const tracked = new Set<string>();
  for (const a of r.threads.flatMap((t) => (Array.isArray(t.rows) ? t.rows : []))) {
    if (!a?.company || tracked.has(String(a.app_id)) || tasks.some((t) => t.kind === "application" && t.company && sameCompany(t.company, a.company))) continue;
    tracked.add(String(a.app_id));
    add({ id: `track:${a.app_id}`, kind: "tracked", company: String(a.company), title: str(a.role), state: "tracked", since: a.applied_at ?? null, source: "tracker (they told Trainee)", blocker: null, evidence: { stage: String(a.stage || "Submitted"), ...(a.next_when ? { when: String(a.next_when) } : {}) } });
  }
  const prefs = r.alerts?.prefs;
  const capabilities = capabilitiesFrom({ connections: r.connections, extension_seen_at: seen, cloud: r.cloud, channel: r.channel,
    alerts: prefs ? { on: !!prefs.on, keywords: prefs.keywords ?? [] } : null, unreadable: r.unreadable });
  const ls = r.last_search;
  return {
    as_of: new Date(now).toISOString(),
    goal: { roles: prefs?.keywords ?? [], places: [...(prefs?.locations ?? []), ...(prefs?.remote_ok ? ["remote"] : [])], constraints: r.standing.map((s) => s.text) },
    tasks,
    today: { used: r.jobs.filter((j) => COUNTED.has(j.state) && Date.parse(j.created_at) > now - DAY).length, limit: paceState(r.daily_limit).pace, ...(paceState(r.daily_limit).state === "unreadable" ? { pace_unreadable: paceState(r.daily_limit).raw as string } : {}) },
    last_shown: ls && Array.isArray(ls.detail?.shown) ? { at: ls.at, query: ls.subject, items: ls.detail.shown } : null,
    next: nextSteps(tasks, prefs),
    capabilities, unreadable: r.unreadable,
  };
}

// The next steps, in an order code fixes: what holds applications and only the person can do, then approvals, then
// decisions on failures, then work waiting on the extension or Trainee, then alerts.
function nextSteps(tasks: Task[], prefs: any): Situation["next"] {
  const out: Situation["next"] = [];
  const of = (k: Task["kind"][], f: (t: Task) => boolean) => tasks.filter((t) => k.includes(t.kind) && f(t));
  const name = (t: Task) => `${t.company ?? "an employer"}${t.title ? ` (${t.title})` : ""}`;
  const qs = of(["question"], () => true);
  if (qs.length) {
    const firms = [...new Set(qs.map((q) => q.company).filter(Boolean))];
    out.push({ who: "person", what: `answer ${qs.length} question${qs.length > 1 ? "s" : ""} holding up ${firms.join(", ") || "their applications"}`, say: "what do you need from me" });
  }
  for (const t of of(["application"], (t) => t.state === "needs_user")) out.push({ who: "person", what: `${name(t)}: ${t.blocker!.what}; ${t.blocker!.how}`, task_id: t.id });
  for (const t of of(["application"], (t) => t.state === "awaiting_approval")) out.push({ who: "person", what: `${t.company}: prepared, waiting for a yes or no`, say: "show my applications", task_id: t.id });
  for (const t of of(["outreach", "mail_draft"], (t) => t.blocker?.who === "person")) out.push({ who: "person", what: `${t.title} (${t.company ?? "no employer"}): ${t.blocker!.what}; ${t.blocker!.how}`, task_id: t.id });
  for (const t of of(["apply_request"], (t) => t.blocker?.who === "person")) out.push({ who: "person", what: `${name(t)}: ${t.blocker!.what}; ${t.blocker!.how}`, task_id: t.id });
  for (const t of of(["application"], (t) => ["failed", "not_submitted"].includes(t.state))) out.push({ who: "person", what: `${name(t)} was not sent (${t.evidence.reason ?? "no reason recorded"}): ${t.blocker!.how}`, task_id: t.id });
  const waiting = of(["application", "apply_request"], (t) => ["queued", "driving"].includes(t.state) || (t.kind === "apply_request" && t.blocker?.who === "extension"));
  if (waiting.length) out.push({ who: waiting.some((t) => t.blocker?.who === "trainee") ? "trainee" : "extension", what: `${waiting.map((t) => t.company).join(", ")}: approved or asked for, waiting to run` });
  if (prefs?.on) out.push({ who: "trainee", what: `keep watching for ${(prefs.keywords ?? []).join(", ")} postings and text new matches` });
  return out;
}

// One parallel batch of reads. A failed read is named in unreadable and its rows are empty; nothing is guessed.
// career_batch_runs_v (the report's open batch runs) does not exist on trunk (only career_batch_runs_v1, retired by
// D-014), so it is not read.
export async function readSituation(admin: any, userId: string, now: number): Promise<Situation> {
  const since = new Date(now - 14 * DAY).toISOString(), today = new Date(now - DAY).toISOString();
  const q = (t: string) => admin.from(t);
  const reads: Record<string, PromiseLike<{ data: any; error: any }>> = {
    jobs: q("career_apply_jobs").select("id,job_id,company,url,state,reason,confirmation_id,email_confirmed_at,confirmation_mail_hash,claimed_at,created_at,updated_at,title:payload->>title").eq("user_id", userId).or(`updated_at.gte.${since},state.in.(queued,driving,needs_user)`).limit(500),
    wanted: q("career_apply_wanted").select("posting_key,url,company,title,state,queued_at,taken_at").eq("user_id", userId).order("queued_at", { ascending: false }).limit(500),
    prepared: q("career_apply_prepared").select("id,job_id,company,url,state,created_at").eq("user_id", userId).in("state", ["ready", "shown"]).limit(200),
    card: q("career_apply_cards").select("shown_at").eq("user_id", userId).eq("state", "open").order("shown_at", { ascending: false }).limit(1),
    questions: q("career_apply_questions").select("id,company,label,options,job_ids,answer,misfit,created_at").eq("user_id", userId).eq("state", "open").limit(100),
    outreach: q("career_outreach_drafts").select("id,n,recipient,status,created_at,sent_at").eq("user_id", userId).or(`status.in.(shown,approved,sending),updated_at.gte.${since}`).limit(100),
    mail_drafts: q("career_mail_drafts").select("id,kind,company,state,created_at").eq("user_id", userId).eq("state", "drafted").limit(50),
    interviews: q("career_interviews").select("id,company,role,starts_at,interview_date").eq("user_id", userId).or(`starts_at.gte.${today},interview_date.gte.${today.slice(0, 10)}`).limit(20),
    alerts: q("career_alert_prefs").select("prefs,tz").eq("user_id", userId).maybeSingle(),
    kv: q("career_watch_kv").select("key,value").eq("user_id", userId).in("key", ["career:standing", "career:account"]),
    threads: q("agent_flow_state").select("thread_id,rows:state->career->stores->trackStore->rows").eq("user_id", userId).limit(200),
    connections: q("user_oauth_connections").select("provider,scopes,connected_at").eq("user_id", userId).limit(20),
    cloud: q("career_apply_cloud_optin").select("enabled").eq("user_id", userId).maybeSingle(),
    channel: q("channel_contacts").select("opted_out").eq("user_id", userId).maybeSingle(),
    last_search: q("career_events").select("at,subject,detail").eq("user_id", userId).eq("kind", "search").order("at", { ascending: false }).limit(1),
  };
  const keys = Object.keys(reads);
  const got = await Promise.all(keys.map((k) => Promise.resolve(reads[k]).then((r) => r, (e) => ({ data: null, error: e }))));
  const unreadable: string[] = [], d: Record<string, any> = {};
  keys.forEach((k, i) => { if (got[i]?.error) { unreadable.push(k); console.error(`situation: ${k}:`, got[i].error?.message ?? got[i].error); } else d[k] = got[i]?.data ?? null; });
  const kv = (key: string) => (d.kv ?? []).find((r: any) => r.key === key)?.value;
  const one = (x: any) => (Array.isArray(x) ? x[0] ?? null : x ?? null);
  return situationFrom({
    jobs: d.jobs ?? [], wanted: d.wanted ?? [], prepared: d.prepared ?? [], card: one(d.card), questions: d.questions ?? [], outreach: d.outreach ?? [],
    mail_drafts: d.mail_drafts ?? [], interviews: d.interviews ?? [], alerts: one(d.alerts), standing: kv("career:standing")?.items ?? [],
    daily_limit: kv("career:account")?.daily_limit, threads: d.threads ?? [],
    connections: (d.connections ?? []).map((c: any) => ({ provider: String(c.provider), connected_at: c.connected_at ?? null, scopes: Array.isArray(c.scopes) ? c.scopes : String(c.scopes ?? "").split(/[\s,]+/).filter(Boolean) })),
    cloud: one(d.cloud), channel: one(d.channel), last_search: one(d.last_search), unreadable,
  }, now);
}

// Whether an employer's emailed code is waiting: a bare code in the person's next text is that code (identity_redact.ts).
export const codePending = (s: Situation | null) => !!s?.tasks.some((t) => t.state === "needs_user" && t.evidence.reason === "email_code");

const STATE_WORDS: Record<string, string> = {
  confirmed: "sent; the employer confirmed it", submitted_unconfirmed: "sent; not confirmed yet", unknown_outcome: "outcome unknown; not resent",
  needs_user: "stopped, needs them", failed: "NOT sent (failed)", not_submitted: "NOT sent", queued: "approved, waiting to run", driving: "running now",
  waiting_extension: "asked for, not prepared yet", awaiting_approval: "waiting for a yes", open_question: "open question", drafted: "drafted",
  upcoming: "interview coming up", tracked: "they told Trainee", approved: "approved", sending: "sending", sent: "sent",
};
const WHO: Record<Actor, string> = { person: "them", trainee: "Trainee", extension: "the extension", employer: "the employer" };
function taskLine(t: Task, how = true): string {
  const e = t.evidence, b = t.blocker;
  return `- ${t.company ?? "?"}${t.title ? ` (${t.title})` : ""}: ${STATE_WORDS[t.state] ?? t.state}${e.stage ? ` (stage: ${e.stage})` : ""}${e.when ? ` (next: ${e.when}, as they said it)` : ""}${e.confirmation_id ? `; confirmation ${e.confirmation_id}` : ""}` +
    `${b ? `; blocker: ${b.what}; who acts: ${WHO[b.who]}${how ? `; how: ${b.how}` : ""}` : ""}${t.since ? ` (since ${day(t.since)})` : ""}`;
}
const nextLine = (n: Situation["next"][number], i: number) => `${i + 1}. [${WHO[n.who]}] ${n.what}${n.say ? ` (they text: "${n.say}")` : ""}`;
// WO-106 (F2): this goal is the job alerts' only. "Goal: not stated" here sat beside the goal they had told the chat (kept in
// their profile, "Their goal") and the model was handed both; it now says which goal it is.
const goalLine = (s: Situation) => (s.goal.roles.length || s.goal.places.length
  ? `Job-alert goal: ${s.goal.roles.join(", ") || "any role"}${s.goal.places.length ? ` in ${s.goal.places.join(" or ")}` : ""}`
  : "Job-alert goal: no alerts set (the goal they told you is under \"Their goal\")") + `${s.goal.constraints.length ? `; must hold: ${s.goal.constraints.join("; ")}` : ""}.`;

// The block for the system prompt. Next steps, tasks waiting on the person and what Trainee can do are never cut for
// length; past the budget the other task lines go first (from the end), then the last list shown, and the cut is said.
export const SITUATION_BUDGET = 5000;
export function situationBlock(s: Situation, budget = SITUATION_BUDGET): string {
  const ls = s.last_shown, line = (t: Task) => taskLine(t, false);
  const L: [string, boolean][] = [
    [`SITUATION (built by code from their account at ${s.as_of.slice(0, 16).replace("T", " ")} UTC: every task in flight, its state, what blocks it and who acts. It is the truth about their tasks.)`, true],
    [goalLine(s), true], [s.today.pace_unreadable !== undefined ? `Today: ${s.today.used} applications in the last 24 hours (their saved daily pace could not be read: it says ${JSON.stringify(s.today.pace_unreadable)}; nothing more is queued until they say "set my daily pace to N" or "no daily pace").` : s.today.limit === null ? `Today: ${s.today.used} applications in the last 24 hours (no daily limit; they may set their own pace).` : `Today: ${s.today.used} of ${s.today.limit} applications used (last 24 hours).`, true],
    ["Next steps, in order (how is the exact step):", true], ...(s.next.length ? s.next.map(nextLine) : ["- nothing in flight"]).map((x): [string, boolean] => [x, true]),
    ...(ls ? [[`Last list shown (${day(ls.at)}, "${ls.query}"): ${ls.items.map((x, i) => `${i + 1}. ${x.company}, ${x.title} (${x.job_id})`).join("; ")}`, false] as [string, boolean]] : []),
    ["Tasks:", true],
    // WO-061 fix (b): an empty account says so in words the brain can repeat, never a bare heading it reads as unknown.
    ...(s.tasks.some((t) => t.kind !== "question") ? [] : [["- none on file: no applications (queued, prepared, sent or failed), no postings saved to apply to, no drafts, no interviews. Asked about any of these, say plainly there are none yet and the one step that starts one.", true] as [string, boolean]]),
    ...s.tasks.filter((t) => t.kind !== "question" && t.blocker?.who === "person").map((t): [string, boolean] => [line(t), true]),
    ...s.tasks.filter((t) => t.kind !== "question" && t.blocker?.who !== "person").map((t): [string, boolean] => [line(t), false]),
    ["What Trainee can and cannot do right now:", true],
    ...s.capabilities.map((c): [string, boolean] => [`- ${c.line}${c.unlock && c.status !== "on" ? ` (to turn on: ${c.unlock})` : ""}`, true]),
    ...(s.unreadable.length ? [[`Could not be read this turn (never guess these): ${s.unreadable.join(", ")}`, true] as [string, boolean]] : []),
  ];
  let size = L.reduce((n, [x]) => n + x.length + 1, 0), dropped = 0;
  for (let i = L.length - 1; i >= 0 && size > budget; i--) if (!L[i][1]) { size -= L[i][0].length + 1; L.splice(i, 1); dropped++; }
  return [...L.map(([x]) => x), ...(dropped ? [`(${dropped} more lines left out for length; call get_situation for them.)`] : [])].join("\n");
}

// Every thing only the person can do, in the fixed order; null when there is none. questionsShown leaves out the
// questions (the questions reply has just numbered them).
export function needsText(s: Situation, o: { questionsShown?: boolean } = {}): string | null {
  const mine = s.next.filter((n) => n.who === "person" && !(o.questionsShown && n.say === "what do you need from me"));
  if (!mine.length) return null;
  return [o.questionsShown ? "Also waiting on you:" : "Waiting on you:", ...mine.map((n, i) => `${i + 1}. ${n.what}${n.say ? ` (text "${n.say}")` : ""}`)].join("\n");
}

// The status in code's words: one employer, or everything in flight.
export function statusText(s: Situation, company?: string | null): string {
  const lost = s.unreadable.length ? ` (could not be read just now: ${s.unreadable.join(", ")})` : "";
  if (company) {
    const ts = s.tasks.filter((t) => t.company && sameCompany(t.company, company));
    if (!ts.length) return `Nothing for ${company} on their account${lost}.`;
    return ts.map((t) => taskLine(t).slice(2) + (t.evidence.reason && !t.blocker ? `; reason: ${t.evidence.reason}` : "")).join("\n");
  }
  const mine = needsText(s);
  return [goalLine(s), s.today.pace_unreadable !== undefined ? `Today: ${s.today.used} applications in the last 24 hours (saved daily pace unreadable: ${JSON.stringify(s.today.pace_unreadable)}).` : s.today.limit === null ? `Today: ${s.today.used} applications in the last 24 hours (no daily limit).` : `Today: ${s.today.used} of ${s.today.limit} applications used.`,
    ...s.tasks.filter((t) => t.kind !== "question").map((t) => taskLine(t)), ...(mine ? [mine] : []),
    "What Trainee can and cannot do right now:", ...s.capabilities.map((c) => `- ${c.line}${c.unlock && c.status !== "on" ? ` (to turn on: ${c.unlock})` : ""}`),
    ...(lost ? [`Not read${lost}.`] : [])].join("\n");
}
