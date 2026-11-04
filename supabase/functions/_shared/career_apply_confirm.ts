// WO-032: every application provable: the answers sent, and the employer's own email that it arrived. The mail run
// (career_proactive_run.ts runMail) reads each new message once; here code decides whether it confirms one of the
// person's applications in the queue (career_apply_jobs). Nothing is guessed:
//   - the message says it was received (or is a rejection, an interview or an offer, which also prove receipt);
//   - it comes from that employer or the applicant tracking system it applies through, naming it (fromEmployer), and Gmail
//     authenticated it as that domain's (dmarc, or dkim signed by it): a "we received your application" from any other
//     domain, or one whose From line nothing vouches for, confirms nothing;
//   - the posting title, where both the message and the application have one, shares words;
//   - the application went (or may have gone) within the 14 days before the message.
// Exactly one application fits: it is confirmed (career_apply_confirm_as sets 'confirmed', email_confirmed_at and the evidence:
// the message hash and one line, never a body). Two or more fit: none is confirmed, and the person is asked once which
// one (the ask waits on the account and is texted as the thread's last word; the answer is a number). The database
// checks the window, the owner and the once-only again, so a second run over the same mail changes nothing. The columns
// are WO-039's (email_confirmed_at, confirmation_mail_hash); the evidence line is that message's career_mail_events row,
// filed under the application (job:<id>), which WO-039's gate reads.
import { classifyMail, fromEmployer, type MailIn, roleOverlap } from "./career_mail.ts";

export const CONFIRM_KINDS = ["received", "rejection", "interview", "offer"] as const;
export type ConfirmKind = typeof CONFIRM_KINDS[number];
export const CONFIRM_WINDOW_DAYS = 14;
export const CONFIRM_INTENT = "career_apply_confirm_which";
const DAY = 86400000;
// What may be confirmed: sent and not yet confirmed by an email (a row confirmed before WO-032 by a page alone included).
const OPEN = new Set(["submitted_unconfirmed", "unknown_outcome", "confirmed"]);

export interface QueueRow {
  id: string; company: string; title?: string | null; url?: string | null; state: string;
  submitted_at: string; // when the drive (or the send) started: career_apply_jobs.claimed_at, else created_at
  confirmation_hash?: string | null; // the message that confirmed it, if one did
}
interface Base { hash: string; company: string; mail_kind: ConfirmKind; evidence: string; mail_at: string }
export type ConfirmPlan =
  | (Base & { kind: "confirm"; id: string; title?: string | null; url?: string | null })
  | (Base & { kind: "ask"; ids: string[]; text: string });

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function planConfirmations(mails: MailIn[], queue: QueueRow[]): ConfirmPlan[] {
  const rows = queue.map((r) => ({ ...r }));
  const out: ConfirmPlan[] = [];
  for (const m of [...mails].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const c = classifyMail(m);
    if (!(CONFIRM_KINDS as readonly string[]).includes(c.kind)) continue;
    if (rows.some((r) => r.confirmation_hash === m.hash)) continue; // this message confirmed one already
    const at = Date.parse(m.date);
    if (!Number.isFinite(at)) continue;
    const hits = rows.filter((r) => {
      const sent = Date.parse(r.submitted_at);
      return OPEN.has(r.state) && !r.confirmation_hash && fromEmployer(c, { company: r.company, url: r.url ?? undefined }, m.from, m.auth) &&
        Number.isFinite(sent) && sent <= at && at - sent <= CONFIRM_WINDOW_DAYS * DAY &&
        (!c.role || !r.title || roleOverlap(r.title, c.role) >= 0.5);
    });
    const base: Base = { hash: m.hash, company: hits[0]?.company ?? c.company ?? "", mail_kind: c.kind as ConfirmKind, evidence: c.evidence, mail_at: new Date(at).toISOString() };
    if (hits.length === 1) {
      hits[0].confirmation_hash = m.hash;
      out.push({ ...base, kind: "confirm", id: hits[0].id, title: hits[0].title, url: hits[0].url });
    } else if (hits.length > 1) {
      const list = [...hits].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
      out.push({ ...base, kind: "ask", ids: list.map((r) => r.id), text: askText(base.company, base.mail_at, list) });
    }
  }
  return out;
}

// The ask: plain text, one line per application (a link alone on its own line when there is no title), under 1,500.
export function askText(company: string, mailAt: string, rows: QueueRow[]): string {
  const co = clip(company, 80);
  const lines = rows.slice(0, 6).map((r, i) =>
    r.title ? `${i + 1}. ${clip(r.title, 80)}, sent ${day(r.submitted_at)}` : `${i + 1}. Sent ${day(r.submitted_at)}:\n${clip(r.url, 300)}`
  );
  return [
    `${co}'s email on ${day(mailAt)} confirms one of your applications there, but you sent ${rows.length} in the 14 days before it, so I haven't marked any of them confirmed. Which one was it?`,
    ...lines,
    `Reply with the number, or "neither".`,
  ].join("\n").slice(0, 1500);
}

// ------------------------------------------------------------------------------------------------ the store
export interface PendingAsk { user_id: string; hash: string; text: string; tz?: string | null; quiet_start?: number; quiet_end?: number }
export interface ConfirmStore {
  queue(userId: string): Promise<QueueRow[]>;
  // career_apply_confirm_as: 'confirmed', 'already', 'confirmed_by_another_email', 'not_sent' or 'outside_window'.
  confirm(userId: string, p: Extract<ConfirmPlan, { kind: "confirm" }>): Promise<string>;
  // false: this message was asked about before (once per message, ever).
  ask(userId: string, p: Extract<ConfirmPlan, { kind: "ask" }>): Promise<boolean>;
  // EM-08: queue one reminder text read from the person's mail (an assessment's deadline) into career_outbox, kind status,
  // delivered at `at`. false: that key was queued before (once per message, ever). It rides on this store because this is
  // the per-person writer the chat's mail read is handed (handler-career.ts wires mailNow with it); a store without it
  // queues no reminder, and the reply then promises none.
  remind?(userId: string, r: { key: string; text: string; at: number }): Promise<boolean>;
}
export interface AskStore {
  pending(): Promise<PendingAsk[]>;
  push(userId: string, hash: string, text: string): Promise<boolean>;
  lastAssistant(threadId: string): Promise<{ intent: string | null; meta: Record<string, unknown> } | null>;
  // career_apply_confirm_answer_as; throws not_on_list, no_open_ask or ask_expired.
  answer(userId: string, hash: string, n: number): Promise<{ result: string; company: string | null }>;
}

// ------------------------------------------------------------------------------------------------ the answer
const NUMBER = /^(?:#|no\.?\s*|number\s+|it was\s+|the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+one)?$/;
const NEITHER = /^(neither|none|neither of them|none of them|not sure|no idea|skip)$/;
export function parseWhich(text: string): number | null {
  const t = String(text ?? "").toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  const m = NUMBER.exec(t);
  if (m) return Number(m[1]);
  return NEITHER.test(t) ? 0 : null;
}
// One turn, before any brain: only a number or "neither", only while the ask is the thread's last word. A read that fails
// lets the turn go on without this.
export async function confirmWhichTurn(o: { message: string; userId: string; threadId: string; store: AskStore }): Promise<{ reply: string; status: string } | null> {
  const n = parseWhich(o.message);
  if (n === null) return null;
  let last;
  try { last = await o.store.lastAssistant(o.threadId); } catch { return null; }
  if (!last || last.intent !== CONFIRM_INTENT || typeof last.meta?.ask !== "string") return null;
  try {
    const r = await o.store.answer(o.userId, last.meta.ask, n);
    const co = clip(r.company, 80) || "the employer";
    if (r.result === "neither") return { reply: `Okay, I left them all unconfirmed. If ${co} writes again about one of them, I'll match it then.`, status: "neither" };
    if (r.result === "confirmed" || r.result === "already") return { reply: `Marked application ${n} confirmed, by ${co}'s email.`, status: "confirmed" };
    const why: Record<string, string> = {
      outside_window: "it was sent more than 14 days before that email, or after it",
      not_sent: "it never went to the employer",
      confirmed_by_another_email: "another email from them already confirmed it",
    };
    return { reply: `I didn't mark ${n} confirmed: ${why[r.result] ?? "it can't be matched to that email"}.`, status: r.result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not_on_list/.test(msg)) return { reply: `Reply with a number from the list, or "neither".`, status: "not_on_list" };
    if (/ask_expired|no_open_ask/.test(msg)) return { reply: "That question has closed, so nothing changed.", status: "closed" };
    console.error("confirm which: not answered", msg);
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ memory (tests)
export function memoryConfirmStore(init: { queue?: Record<string, QueueRow[]> } = {}) {
  const st = { queue: JSON.parse(JSON.stringify(init.queue ?? {})) as Record<string, QueueRow[]>, asks: {} as Record<string, any>, reminders: {} as Record<string, { key: string; text: string; at: number }>, confirmed: [] as { user: string; id: string; hash: string }[] };
  const store: ConfirmStore & AskStore & { st: typeof st; thread: Record<string, { intent: string | null; meta: any }> } = {
    st, thread: {},
    async queue(u) { return JSON.parse(JSON.stringify(st.queue[u] ?? [])); },
    async confirm(u, p) {
      const r = (st.queue[u] ?? []).find((x) => x.id === p.id);
      if (!r) throw new Error("not your application");
      if (r.confirmation_hash === p.hash) return "already";
      if (r.confirmation_hash) return "confirmed_by_another_email";
      if (!OPEN.has(r.state)) return "not_sent";
      const sent = Date.parse(r.submitted_at), at = Date.parse(p.mail_at);
      if (at < sent || at > sent + CONFIRM_WINDOW_DAYS * DAY) return "outside_window";
      r.state = "confirmed"; r.confirmation_hash = p.hash;
      st.confirmed.push({ user: u, id: p.id, hash: p.hash });
      return "confirmed";
    },
    async ask(u, p) {
      const k = `${u}:${p.hash}`;
      if (st.asks[k]) return false;
      st.asks[k] = { ...p, user_id: u, state: "pending" };
      return true;
    },
    async pending() { return Object.values(st.asks).filter((a: any) => a.state === "pending").map((a: any) => ({ user_id: a.user_id, hash: a.hash, text: a.text })); },
    async remind(u, r) {
      const k = `${u}:${r.key}`;
      if (st.reminders[k]) return false;
      st.reminders[k] = { ...r };
      return true;
    },
    async push(u, h, text) {
      const a = st.asks[`${u}:${h}`];
      if (!a || a.state !== "pending") return false;
      a.state = "asked"; a.pushed = text;
      store.thread[u] = { intent: CONFIRM_INTENT, meta: { ask: h } };
      return true;
    },
    async lastAssistant(threadId) { return store.thread[threadId] ?? null; },
    async answer(u, h, n) {
      const a = st.asks[`${u}:${h}`];
      if (!a || a.state !== "asked") throw new Error("no_open_ask");
      if (n === 0) { a.state = "answered"; return { result: "neither", company: a.company }; }
      if (n < 1 || n > a.ids.length) throw new Error("not_on_list");
      const result = await store.confirm(u, { kind: "confirm", id: a.ids[n - 1], hash: h, company: a.company, mail_kind: a.mail_kind, evidence: a.evidence, mail_at: a.mail_at });
      a.state = "answered";
      return { result, company: a.company };
    },
  };
  return store;
}

// ------------------------------------------------------------------------------------------------ Supabase
// deno-lint-ignore no-explicit-any
export function supabaseConfirmStore(admin: any): ConfirmStore & AskStore {
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    async queue(u) {
      const since = new Date(Date.now() - 45 * DAY).toISOString();
      const rows = must(await admin.from("career_apply_jobs").select("id,job_id,company,url,state,created_at,claimed_at,confirmation_mail_hash,title:payload->>title")
        .eq("user_id", u).in("state", [...OPEN]).gte("created_at", since).order("created_at", { ascending: false }).limit(500), "read applications to confirm") ?? [];
      // The posting's own title where the application does not carry one.
      const need = [...new Set(rows.filter((r: any) => !r.title).map((r: any) => r.job_id))];
      const titles = new Map<string, string>();
      if (need.length) {
        const ps = must(await admin.from("career_postings").select("job_id,title").in("job_id", need.slice(0, 100)), "read posting titles") ?? [];
        for (const p of ps) titles.set(p.job_id, p.title);
      }
      return rows.map((r: any) => ({
        id: r.id, company: r.company, url: r.url, state: r.state, title: r.title ?? titles.get(r.job_id) ?? null,
        submitted_at: r.claimed_at ?? r.created_at, confirmation_hash: r.confirmation_mail_hash ?? null,
      }));
    },
    async confirm(u, p) {
      return String(must(await admin.rpc("career_apply_confirm_as", { p_user: u, p_id: p.id, p_hash: p.hash, p_kind: p.mail_kind, p_evidence: p.evidence, p_mail_at: p.mail_at }), "confirm an application"));
    },
    async ask(u, p) {
      const value = { state: "pending", ids: p.ids, kind: p.mail_kind, evidence: p.evidence, mail_at: p.mail_at, company: p.company.slice(0, 200), text: p.text };
      const got = must(await admin.from("career_watch_kv").upsert({ user_id: u, key: `career:confirm-ask:${p.hash}`, value }, { onConflict: "user_id,key", ignoreDuplicates: true }).select("key"), "keep the question") ?? [];
      return got.length > 0;
    },
    async pending() {
      const rows = must(await admin.from("career_watch_kv").select("user_id,key,value").like("key", "career:confirm-ask:%").eq("value->>state", "pending").limit(500), "read open questions") ?? [];
      if (!rows.length) return [];
      const users = [...new Set(rows.map((r: any) => r.user_id))];
      const prefs = must(await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users), "read quiet hours") ?? [];
      const of = new Map(prefs.map((p: any) => [p.user_id, p]));
      return rows.map((r: any) => {
        const p: any = of.get(r.user_id);
        return { user_id: r.user_id, hash: String(r.key).slice("career:confirm-ask:".length), text: String(r.value?.text ?? ""), tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end };
      });
    },
    async remind(u, r) {
      if (!/^status:deadline:[a-f0-9]{64}$/.test(r.key)) throw new Error("a mail reminder's key is status:deadline:<message hash>");
      const got = await admin.from("career_outbox").insert({ user_id: u, key: r.key, kind: "status", text: String(r.text).slice(0, 4000), deliver_at: new Date(r.at).toISOString() });
      if (got.error && (got.error.code === "23505" || /duplicate key/i.test(got.error.message))) return false;
      must(got, "queue the deadline reminder");
      return true;
    },
    async push(u, h, text) { return !!must(await admin.rpc("career_apply_confirm_ask_push_as", { p_user: u, p_hash: h, p_text: text }), "ask which application"); },
    async lastAssistant(threadId) {
      const rows = must(await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply");
      const meta = rows?.[0]?.meta ?? null;
      return meta ? { intent: meta.intent ?? null, meta } : null;
    },
    async answer(u, h, n) {
      const r = must(await admin.rpc("career_apply_confirm_answer_as", { p_user: u, p_hash: h, p_n: n }), "answer which application");
      return { result: String(r?.result ?? ""), company: r?.company ?? null };
    },
  };
}
