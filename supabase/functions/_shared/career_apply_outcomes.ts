// COMPETITIVE-BAR G2 / B10 and B5 (owner 2026-10-27): "how are my applications doing" and "show proof for X", answered
// from state only: the queue (career_apply_jobs, which the engine and WO-032's email confirmation write) and the
// person's job mail as WO-024 filed it (career_mail_events, under job:<id>). No competitor publishes verified outcomes;
// this says exactly what is on record and nothing more:
//   - sent: the queue recorded that it reached the employer, or may have (confirmed, submitted_unconfirmed,
//     unknown_outcome);
//   - confirmed: only when the employer's own email confirmed it (email_confirmed_at), and the proof shown is that
//     email's sender line, date and the words it was read from (never a body);
//   - interview, offer, rejection, reply: only from a mail event under that application, never flagged ones.
// The same definitions as the view public.career_apply_outcomes (20261028010000), which evals and launch metrics read.
// Nothing here sends or writes.
import { sameCompany } from "./career_mail.ts";

export const OUTCOMES_INTENT = "career_apply_outcomes";
export const PROOF_INTENT = "career_apply_proof";
const DAY = 86400000;
const WENT = new Set(["confirmed", "submitted_unconfirmed", "unknown_outcome"]);
const INTERVIEW = new Set(["interview", "assessment", "offer"]);

export interface OutcomeJob {
  id: string; company: string; title?: string | null; state: string; created_at: string; claimed_at?: string | null;
  email_confirmed_at?: string | null; confirmation_mail_hash?: string | null; confirmation_id?: string | null;
}
export interface OutcomeEvent {
  application_ref: string; kind: string; company: string; evidence: string; message_hash: string; mail_at: string; flagged?: boolean;
}
export interface OutcomeRead { jobs(userId: string): Promise<OutcomeJob[]>; events(userId: string): Promise<OutcomeEvent[]> }

export type OutcomesAsk = { kind: "funnel" } | { kind: "proof"; company: string };
const clean = (t: string) => String(t ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim();
export function outcomesAsk(message: string): OutcomesAsk | null {
  const t = clean(message);
  const proof = /^(?:can you |please )?(?:show|send|give)(?: me)? (?:the |my )?proof (?:for|of|that|from)\s+(?:i applied to |my application to |my |the )?(.+?)(?: (?:got|received) (?:it|my application))?$/.exec(t)
    ?? /^(?:can you )?prove (?:that )?(?:i applied to |my application (?:to|reached) )(.+)$/.exec(t)
    ?? /^(?:what(?:'s| is) )?(?:the )?proof (?:that )?(?:i applied to|my application (?:to|reached)) (.+)$/.exec(t)
    ?? /^did (.+?) (?:get|receive) my application$/.exec(t);
  if (proof) {
    const company = proof[1].replace(/^(?:the |my )/, "").replace(/\s+(?:application|one|job|role)$/, "").trim();
    if (company && company.length <= 80) return { kind: "proof", company };
  }
  if (/^how(?:'s| is| are) (?:my|the) (?:applications?|job (?:search|hunt)|apps)(?: (?:doing|going))?(?: so far| this week)?$/.test(t) ||
      /^how (?:are|is) (?:my )?(?:applications?|job (?:search|hunt)) (?:doing|going)/.test(t) ||
      /^(?:show me |what are )?my (?:application |job search )?(?:numbers|stats|results|funnel|outcomes)$/.test(t) ||
      /^how many (?:interviews|confirmations|replies) (?:have i|did i|do i)/.test(t)) return { kind: "funnel" };
  return null;
}

export interface Funnel {
  sent: number; confirmed: number; interviews: number; offers: number; rejections: number; replies: number;
  sent_7d: number; confirmed_7d: number; interviews_7d: number;
  per100: { confirmed: number | null; interviews: number | null; offers: number | null; replies: number | null };
}
const per100 = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
export function funnelOf(jobs: OutcomeJob[], events: OutcomeEvent[], now: number): Funnel {
  const byJob = new Map<string, OutcomeEvent[]>();
  for (const e of events) {
    if (e.flagged || !e.application_ref.startsWith("job:")) continue;
    const k = e.application_ref.slice(4);
    (byJob.get(k) ?? byJob.set(k, []).get(k)!).push(e);
  }
  const f: Funnel = { sent: 0, confirmed: 0, interviews: 0, offers: 0, rejections: 0, replies: 0, sent_7d: 0, confirmed_7d: 0, interviews_7d: 0, per100: { confirmed: null, interviews: null, offers: null, replies: null } };
  const week = now - 7 * DAY;
  for (const j of jobs) {
    if (!WENT.has(j.state)) continue;
    f.sent++;
    if (Date.parse(j.claimed_at ?? j.created_at) > week) f.sent_7d++;
    if (j.email_confirmed_at) { f.confirmed++; if (Date.parse(j.email_confirmed_at) > week) f.confirmed_7d++; }
    const ev = byJob.get(String(j.id)) ?? [];
    const iv = ev.filter((e) => INTERVIEW.has(e.kind)).map((e) => Date.parse(e.mail_at)).sort((a, b) => a - b)[0];
    if (iv !== undefined) { f.interviews++; if (iv > week) f.interviews_7d++; }
    if (ev.some((e) => e.kind === "offer")) f.offers++;
    if (ev.some((e) => e.kind === "rejection")) f.rejections++;
    if (ev.some((e) => e.kind !== "received")) f.replies++;
  }
  f.per100 = { confirmed: per100(f.confirmed, f.sent), interviews: per100(f.interviews, f.sent), offers: per100(f.offers, f.sent), replies: per100(f.replies, f.sent) };
  return f;
}

const n = (x: number, w: string, ws = `${w}s`) => `${x} ${x === 1 ? w : ws}`;
const fmt = (x: number | null) => (x === null ? "0" : Number.isInteger(x) ? String(x) : x.toFixed(1));
export function funnelText(f: Funnel): string {
  if (!f.sent) return "No application has gone to an employer yet, so there is nothing to measure. When one goes, I'll track whether the employer confirms it and what they reply.";
  const lines = [
    `This week: ${n(f.sent_7d, "application")} sent, ${f.confirmed_7d} confirmed by the employer's email, ${n(f.interviews_7d, "interview")}.`,
    `All time: ${n(f.sent, "application")} sent, ${f.confirmed} confirmed, ${n(f.interviews, "interview")}, ${n(f.offers, "offer")}, ${n(f.rejections, "rejection")}.`,
    `Per 100 applications: ${fmt(f.per100.confirmed)} confirmed, ${fmt(f.per100.interviews)} interviews, ${fmt(f.per100.replies)} replies.`,
  ];
  const waiting = f.sent - f.confirmed;
  if (waiting) lines.push(`${waiting === 1 ? "1 is" : `${waiting} are`} sent but not confirmed by the employer yet; I count one as confirmed only when their email says so. Say "show proof for <company>" to see any one.`);
  return lines.join("\n");
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const one = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const KIND_WORD: Record<string, string> = { received: "confirmed they received it", rejection: "said no", interview: "asked you to interview", assessment: "sent an assessment", offer: "made an offer", recruiter_reply: "replied" };
export function proofText(company: string, jobs: OutcomeJob[], events: OutcomeEvent[]): string {
  const mine = jobs.filter((j) => sameCompany(j.company, company)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!mine.length) return `I have no application to ${company} on record, so there is no proof to show. If you applied on your own, it isn't one I sent or tracked.`;
  const out: string[] = [];
  for (const j of mine.slice(0, 3)) {
    const role = j.title ? ` (${one(j.title, 80)})` : "";
    const sent = day(j.claimed_at ?? j.created_at);
    const ev = events.filter((e) => e.application_ref === `job:${j.id}` && !e.flagged).sort((a, b) => a.mail_at.localeCompare(b.mail_at));
    if (!WENT.has(j.state)) { out.push(`${j.company}${role}: not sent (${j.state.replace(/_/g, " ")}), so there is no proof of arrival.`); continue; }
    const conf = j.confirmation_mail_hash ? ev.find((e) => e.message_hash === j.confirmation_mail_hash) : undefined;
    if (j.email_confirmed_at) {
      out.push(`${j.company}${role}: sent ${sent}. Confirmed by ${j.company}'s own email on ${day(j.email_confirmed_at)}${conf ? `: "${one(conf.evidence, 200)}"` : ""}.`);
    } else {
      out.push(`${j.company}${role}: sent ${sent} (${j.state === "unknown_outcome" ? "the submit's result was unclear" : "the submit went through"}). No email from ${j.company} confirming it yet, so it is not confirmed.`);
    }
    if (j.confirmation_id) out.push(`  Their confirmation number on the page: ${one(j.confirmation_id, 80)}.`);
    for (const e of ev) if (e !== conf) out.push(`  ${day(e.mail_at)}: ${j.company} ${KIND_WORD[e.kind] ?? "wrote"}: "${one(e.evidence, 160)}"`);
  }
  if (mine.length > 3) out.push(`(${mine.length - 3} older application${mine.length - 3 === 1 ? "" : "s"} to ${mine[0].company} not shown.)`);
  out.push(`Say "show my receipt for ${mine[0].company}" for the answers that were sent and the screenshots.`);
  return out.join("\n");
}

export async function outcomesTurn(o: { message: string; userId: string; now: number; read: OutcomeRead }): Promise<{ reply: string; status: string; intent: string } | null> {
  const ask = outcomesAsk(o.message);
  if (!ask) return null;
  let jobs: OutcomeJob[], events: OutcomeEvent[];
  try { [jobs, events] = await Promise.all([o.read.jobs(o.userId), o.read.events(o.userId)]); }
  catch (e) {
    console.error("outcomes:", e instanceof Error ? e.message : String(e));
    return { reply: "I couldn't read your applications just now, so I won't guess. Ask again in a minute.", status: "unreadable", intent: ask.kind === "proof" ? PROOF_INTENT : OUTCOMES_INTENT };
  }
  if (ask.kind === "proof") return { reply: proofText(ask.company, jobs, events), status: "shown", intent: PROOF_INTENT };
  return { reply: funnelText(funnelOf(jobs, events, o.now)), status: "shown", intent: OUTCOMES_INTENT };
}

// deno-lint-ignore no-explicit-any
export function supabaseOutcomes(admin: any): OutcomeRead {
  return {
    async jobs(userId) {
      const r = await admin.from("career_apply_jobs").select("id,company,state,created_at,claimed_at,email_confirmed_at,confirmation_mail_hash,confirmation_id,title:payload->>title")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(5000);
      if (r.error) throw new Error(`read the applications: ${r.error.message}`);
      return (r.data ?? []) as OutcomeJob[];
    },
    async events(userId) {
      const r = await admin.from("career_mail_events").select("application_ref,kind,company,evidence,message_hash,mail_at,flagged")
        .eq("user_id", userId).like("application_ref", "job:%").order("mail_at", { ascending: true }).limit(10000);
      if (r.error) throw new Error(`read the job mail: ${r.error.message}`);
      return (r.data ?? []) as OutcomeEvent[];
    },
  };
}
