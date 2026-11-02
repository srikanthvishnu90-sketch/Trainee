// Compound and multi-step asks (task planner P1 at the handler; ports the sound parts of PR #252, see
// _shared/task/plan.ts). With CAREER_PLANNER=on, the served brain staged or agent (brainMode: CAREER_BRAIN, or after
// D-035 the committed release config when CAREER_BRAIN is unset; CAREER_BRAIN=router is the kill switch for this too) and, when CAREER_PLANNER_USERS is set, only for those accounts: a message that
// asks for two or more actions ("find 5 frontend internships in Chicago, tailor my resume for the best 2, apply and remind
// me Friday") is planned by ONE model call into steps over registered capabilities, code checks every step, and each step
// runs, in order, through the path that already does that one thing on trunk:
//   jobs.search, resume.tailor, interview.prep, alerts.watch  -> the router (CareerHost.runTurn) on this turn's state
//   apply.queue                                               -> the apply turn (career_apply_chat.ts applyTurn): the
//                                                                resume check, the screens, the queue; nothing is sent
//                                                                until the person approves the card
//   outreach.draft                                            -> the networking turn: the person's own contacts, the
//                                                                fact-lock, drafts that wait for "send 1"
//   tracker.update, instruction.remember                      -> the agent tools track_application / remember_instruction
//                                                                (their own words-only checks)
//   reminder.set                                              -> the reminder store (_shared/task/reminders.ts): kept,
//                                                                never sent on its own
// A turn the planner does not claim (a single ask, a question, a code-first prompt waiting for its answer, a model outage,
// a plan of one step) falls through to today's chain unchanged. Every part of the message is accounted for: a step
// refused by code, a step its path did not do, and an action no step took are each named in the reply. The reply is
// each path's own reply, in order; this module writes no claim of its own.
// deno-lint-ignore-file no-explicit-any
import { actionsIn, capability, checkPlan, compoundAsk, dueDate, MAX_PICKS, MAX_REMINDERS, MAX_STEPS, PLAN_INTENT, PLAN_TOOL, planSystem, type Refused, type Step, uncovered, unsaidWords } from "../_shared/task/plan.ts";
import type { ReminderStore } from "../_shared/task/reminders.ts";
import type { ToolCtx, ToolSpec } from "../_shared/agent/loop.ts";
import { whenSaid } from "../_shared/agent/career_tools.ts";
import { documentsOf } from "../_shared/channel_artifacts.ts";
import { brainMode } from "./career_staged.ts";
import { CARD_INTENT } from "../_shared/career_apply_cards.ts";
import { MOCK_INTENT } from "../_shared/career_mock.ts";
import { QUESTIONS_INTENT } from "../_shared/career_apply_questions.ts";
import { CONFIRM_INTENT } from "../_shared/career_apply_confirm.ts";
import { EMAIL_INTENT } from "../_shared/career_apply_email.ts";
import { OUTREACH_INTENT } from "../_shared/career_outreach.ts";
import { CLOUD_CARD_INTENT } from "../_shared/career_cloud_card_chat.ts";
import { EMPLOYER_ASK_INTENT } from "../_shared/career_apply_chat.ts";
import { FOLLOWUP_CARD_INTENT } from "../_shared/career_inbox_followups.ts";
import { SIGNATURE_INTENT } from "../_shared/career_networking.ts";
import { BILLING_CANCEL_INTENT } from "../_shared/career_billing.ts";

export { PLAN_INTENT };
type Env = { get(k: string): string | undefined };

// The switch: per person and reversible, and off whenever the served brain is the router (brainMode decides what is
// served: CAREER_BRAIN, or the release config when it is unset; CAREER_BRAIN=router always rolls back).
export function plannerOn(env: Env, userId: string): boolean {
  if (String(env.get("CAREER_PLANNER") ?? "").trim().toLowerCase() !== "on") return false;
  if (brainMode(env) === "router") return false;
  const allow = String(env.get("CAREER_PLANNER_USERS") ?? "").split(/[\s,]+/).filter(Boolean);
  return !allow.length || allow.includes(userId);
}
// Today's code-first prompts that wait for the person's answer: while one is this thread's last word, the answer is
// theirs and the planner never takes it.
export const DEFER_INTENTS: readonly string[] = [CARD_INTENT, MOCK_INTENT, QUESTIONS_INTENT, CONFIRM_INTENT, EMAIL_INTENT, OUTREACH_INTENT, CLOUD_CARD_INTENT,
  EMPLOYER_ASK_INTENT, FOLLOWUP_CARD_INTENT, SIGNATURE_INTENT, BILLING_CANCEL_INTENT];
// The router's replies that did nothing (it did not understand, or answered with advice): that step was not done.
const NOT_DONE_INTENTS = new Set(["career_catchall", "career_fallback", "career_out_of_scope", "conversation_clarify", "conversation_ack", "career_greeting"]);
// What each capability's step must have produced to count as done (its path's own intent).
const DONE_BY: Record<string, (intent: string | null) => boolean> = {
  "jobs.search": (i) => /discovery|search|shortlist|internship/.test(String(i)),
  "resume.tailor": (i) => i === "career_tailor",
  "interview.prep": (i) => /prep|interview|mock/.test(String(i)),
  "alerts.watch": (i) => /watch|alert/.test(String(i)),
};

type Turn = { reply: string; intent: string | null; status?: string | null; resultStatus?: string | null; parts?: string[]; result?: any; ask?: unknown[] };
export interface PlannerIO {
  userId: string; threadId: string; now: () => number; tz: string | null;
  model: (payload: any) => Promise<{ content: any[]; stop_reason?: string }>;
  lastIntent: () => Promise<string | null>;
  ctx: Record<string, unknown>; // this turn's host ctx: the profile, the tracker and the thread's last list live here
  router: (text: string) => Promise<Turn>;
  apply: (text: string, shortlist: any[] | null) => Promise<Turn | null>;
  networking: (text: string) => Promise<Turn | null>;
  tools: ToolSpec[];
  reminders: ReminderStore;
  defer?: readonly string[];
}
export interface StepResult { capability: string; text: string; status: "done" | "not_done" | "failed"; intent: string | null; why?: string; detail?: unknown }
export type PlannerTurn =
  | { claimed: false; why: string }
  | { claimed: true; reply: string; parts: string[]; intent: string; resultStatus: string; documents: any[]; meta: Record<string, unknown> };

const quote = (s: string) => `"${s.length > 120 ? `${s.slice(0, 117)}...` : s}"`;
const WHY: Record<Refused["why"], string> = {
  unknown_capability: "not something I can do from chat", never_automated: "I never act on LinkedIn, Indeed or Handshake",
  untrusted_source: "it named an address or link you didn't write", not_their_words: "it wasn't in your words",
  duplicate: "it repeated another part", bad_args: "I couldn't tell which postings you meant",
  over_cap: "over what I do from one message",
};
// What each cap is, said plainly when a plan went over it (plan.ts MAX_STEPS, PER_TYPE, MAX_PICKS).
const CAP_SAYS: Record<string, string> = {
  steps: `I run at most ${MAX_STEPS} steps from one message`,
  "apply.queue": "all applications from one message go on one card",
  "resume.tailor": "I tailor for postings in one step per message",
  "reminder.set": `I keep at most ${MAX_REMINDERS} reminders from one message`,
  picks: `I take at most ${MAX_PICKS} postings per step`,
};

export async function plannerTurn(io: PlannerIO, message: string): Promise<PlannerTurn> {
  if (!compoundAsk(message)) return { claimed: false, why: "single_ask" };
  const last = await io.lastIntent().catch(() => null);
  if (last && (io.defer ?? DEFER_INTENTS).includes(last)) return { claimed: false, why: "code_first_last_word" };
  let raw: unknown;
  try {
    const res = await io.model({ system: planSystem(), max_tokens: 1200, tools: [PLAN_TOOL], tool_choice: { type: "tool", name: PLAN_TOOL.name },
      messages: [{ role: "user", content: `THE PERSON'S MESSAGE: ${message}` }] });
    raw = (res.content ?? []).find((b: any) => b && b.type === "tool_use" && b.name === PLAN_TOOL.name)?.input;
  } catch { return { claimed: false, why: "model_error" }; }
  const plan = checkPlan(raw, message);
  if (plan.kind !== "task") return { claimed: false, why: "not_a_task" };
  // One step and nothing refused is a single ask: today's chain does exactly that, so it answers.
  if (plan.steps.length + plan.refused.length < 2) return { claimed: false, why: "one_step" };

  const results: StepResult[] = [], parts: string[] = [], documents: any[] = [];
  let waiting: { intent: string; meta?: Record<string, unknown> } | null = null;
  for (const s of plan.steps) {
    const r = await runStep(io, s, message).catch((e): { res: StepResult; turn: Turn | null } => ({ res: { capability: s.capability, text: s.text, status: "failed", intent: null, why: String((e as Error)?.message ?? e).slice(0, 200) }, turn: null }));
    results.push(r.res);
    if (r.turn) {
      if (r.turn.reply && r.res.status === "done") parts.push(r.turn.reply);
      for (const d of documentsOf(r.turn.result)) documents.push(d);
      const ask = Array.isArray(r.turn.ask) && r.turn.ask.length ? { intent: EMPLOYER_ASK_INTENT, meta: { employer_question: r.turn.ask } } : null;
      if (ask) waiting = ask;
      else if (r.turn.intent && DEFER_INTENTS.includes(r.turn.intent)) waiting = { intent: r.turn.intent };
    }
    if (r.res.status !== "done") parts.push(`Not done: ${quote(s.text)}${r.res.why ? ` (${r.res.why})` : ""}.`);
  }
  for (const x of plan.refused.filter((r) => r.why !== "over_cap")) parts.push(`Not done: ${quote(x.text || x.capability)} (${WHY[x.why]}).`);
  // Over a cap: one line per cap, naming every part left out, so nothing over it is dropped silently.
  const over = new Map<string, Refused[]>();
  for (const x of plan.refused.filter((r) => r.why === "over_cap")) { const k = String(x.detail?.[0] ?? "steps"); over.set(k, [...(over.get(k) ?? []), x]); }
  for (const [k, xs] of over) {
    const named = k === "picks" ? xs.map((x) => `postings ${(x.detail ?? []).slice(1).join(", ")} for ${quote(x.text)}`) : xs.map((x) => quote(x.text || x.capability));
    parts.push(`Not done, ${CAP_SAYS[k] ?? WHY.over_cap}: ${named.slice(0, 10).join("; ")}${named.length > 10 ? `; and ${named.length - 10} more` : ""}. Ask me for ${xs.length === 1 && k !== "picks" ? "it" : "the rest"} in another message.`);
  }
  const left = uncovered(message, plan.steps);
  if (left.length) parts.push(`Not started from your message: the part to ${left.join(", ")}. Ask me for it on its own and I'll do it.`);
  const done = results.filter((r) => r.status === "done").length;
  return {
    claimed: true, reply: parts.join("\n\n"), parts, intent: waiting?.intent ?? PLAN_INTENT,
    resultStatus: done === results.length && !plan.refused.length && !left.length ? "completed" : done ? "partial" : "not_done",
    documents,
    meta: { ...(waiting?.meta ?? {}), planner: { asked: actionsIn(message), steps: results.map((r) => ({ capability: r.capability, status: r.status, intent: r.intent, ...(r.why ? { why: r.why } : {}), ...(r.detail ? { detail: r.detail } : {}) })),
      refused: plan.refused.map((x) => ({ capability: x.capability, why: x.why, ...(x.detail ? { detail: x.detail } : {}) })), uncovered: left } },
  };
}

// The apply turn's own words for positions on the list: "apply to the first one", "apply to 1 and 3", "apply to 1, 2 and 4".
const ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
export function positionsAsk(picks: number[]): string {
  const ns = [...new Set(picks)];
  if (ns.length === 1) return ns[0] <= ORD.length ? `apply to the ${ORD[ns[0] - 1]} one` : `apply to number ${ns[0]}`;
  return `apply to ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}
const shortlistOf = (ctx: Record<string, unknown>): any[] => {
  const l = (ctx as any).discovery?.lastShortlist;
  return Array.isArray(l) ? l : [];
};
const picksOf = (s: Step): number[] | null => Array.isArray(s.args.picks) ? (s.args.picks as number[]) : null;

async function runStep(io: PlannerIO, s: Step, message: string): Promise<{ res: StepResult; turn: Turn | null }> {
  const cap = capability(s.capability)!;
  const res = (status: StepResult["status"], intent: string | null, why?: string): StepResult => ({ capability: s.capability, text: s.text, status, intent, ...(why ? { why } : {}) });
  if (cap.route === "router") {
    const picks = s.capability === "resume.tailor" ? picksOf(s) : null;
    if (picks) {
      // Each pick is a posting the search step listed (the thread's last list, code's record), named to the router.
      const list = shortlistOf(io.ctx), turns: Turn[] = [];
      const missing = picks.filter((n) => !list[n - 1]);
      if (missing.length) return { res: res("not_done", null, `there was no posting ${missing.join(", ")} in the list`), turn: null };
      for (const n of picks) {
        const p = list[n - 1];
        turns.push(await io.router(`tailor my resume for the ${String(p.title ?? "").replace(/,/g, " ")} role at ${String(p.company ?? "")}`));
      }
      const ok = turns.filter((t) => t.intent === "career_tailor");
      const tailored = [...new Set(ok.map((t) => String(t.result?.artifact?.jobId ?? "")).filter(Boolean))];
      const turn: Turn = { reply: turns.map((t) => t.reply).join("\n\n"), intent: ok.length ? "career_tailor" : turns.at(-1)?.intent ?? null, result: { documents: turns.flatMap((t) => documentsOf(t.result)) } };
      return { res: { ...res(ok.length ? "done" : "not_done", turn.intent, ok.length < turns.length ? `${turns.length - ok.length} of ${turns.length} not tailored` : undefined), detail: { tailored } }, turn };
    }
    const t = await io.router(s.text);
    const did = !NOT_DONE_INTENTS.has(String(t.intent)) && (DONE_BY[s.capability] ? DONE_BY[s.capability](t.intent) : true);
    return { res: res(did ? "done" : "not_done", t.intent, did ? undefined : "I couldn't do that part from this message"), turn: t };
  }
  if (cap.route === "apply") {
    const picks = picksOf(s), list = shortlistOf(io.ctx);
    if (picks && !list.length) return { res: res("not_done", null, "there was no list of postings to pick from"), turn: null };
    // Positions on the thread's last list are the apply turn's own grammar ("apply to 1 and 3").
    const text = picks ? positionsAsk(picks) : s.text;
    const t = await io.apply(text, picks ? list : (list.length ? list : null));
    if (!t) return { res: res("not_done", null, "no open posting on file matched it"), turn: null };
    const st = String(t.status ?? t.resultStatus ?? "");
    return { res: res(/queued|already|partial|ask|which/.test(st) || (Array.isArray(t.ask) && t.ask.length) ? "done" : "not_done", t.intent, /queued|already/.test(st) ? undefined : st || undefined), turn: { ...t, resultStatus: st } };
  }
  if (cap.route === "networking") {
    const t = await io.networking(s.text);
    if (!t) return { res: res("not_done", null, "I couldn't tell who to write to"), turn: null };
    const st = String(t.status ?? "");
    return { res: res(/drafted|shown|needs_signature|batch/.test(st) || t.intent === OUTREACH_INTENT || t.intent === SIGNATURE_INTENT ? "done" : "not_done", t.intent, undefined), turn: t };
  }
  if (cap.route === "tool") {
    const name = s.capability === "tracker.update" ? "track_application" : "remember_instruction";
    const tool = io.tools.find((x) => x.name === name);
    if (!tool) return { res: res("failed", null, "not connected here"), turn: null };
    const c: ToolCtx = { userId: io.userId, threadId: io.threadId, now: io.now(), state: io.ctx, turn: { message, added: [] } };
    const input: Record<string, any> = s.capability === "tracker.update"
      ? { company: s.args.company, role: s.args.role, stage: s.args.stage ?? "Saved", ...(s.args.when ? { when: s.args.when } : {}) }
      : { instruction: s.args.instruction ?? s.text, quote: s.args.quote ?? s.text };
    // The tool's own checks hold: the employer and day only as they said them, the rule only in their words.
    if (s.capability === "tracker.update" && unsaidWords(message, String(input.company ?? "")).length) return { res: res("not_done", null, "that employer wasn't in your message"), turn: null };
    const out: any = await tool.run(input, c);
    const reply = s.capability === "tracker.update"
      ? `On your tracker: ${out.application?.company ?? input.company}${out.application?.role && !/user-reported/.test(out.application.role) ? `, ${out.application.role}` : ""}, ${out.application?.stage ?? input.stage}${out.when_kept ? `, next: ${out.when_kept}` : ""}.`
      : `Kept for every chat: ${out.kept?.text ?? input.instruction}.`;
    return { res: res("done", name), turn: { reply, intent: name } };
  }
  // reminder.set: the day only from the person's own words, counted in their time zone (UTC when none is on file).
  const when = String(s.args.when ?? "").trim() || s.text;
  const said = whenSaid(message, when);
  const due = said ? dueDate(said, io.now(), io.tz) : null;
  if (!said || !due) return { res: res("not_done", null, "I couldn't tell which day you meant"), turn: null };
  const what = String(s.args.what ?? "").trim();
  const text = what && !unsaidWords(message, what).length ? what : s.text;
  const r = await io.reminders.add(io.userId, { id: crypto.randomUUID(), what: text.slice(0, 200), when: said, due_date: due, tz: io.tz, created_at: new Date(io.now()).toISOString(), source: "plan" });
  return { res: res("done", "reminder_set"), turn: { reply: `${r.added ? "Reminder kept" : "That reminder was already kept"} for ${said} (${due}): ${text.slice(0, 200)}. It's kept on your account; I don't send reminder texts on my own yet.`, intent: "reminder_set" } };
}
