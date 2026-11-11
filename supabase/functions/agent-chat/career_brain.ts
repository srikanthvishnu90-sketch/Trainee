// Which brain answers a career turn (WO-002, D-008): the CareerHost router unless CAREER_BRAIN=agent, and the agent turn
// itself (model + tools over the person's career state).
import type { LinkCheck } from "../_shared/link_check.ts";
import { runAgentTurn, type ModelFn, type TurnResult } from "../_shared/agent/loop.ts";
import { careerTools, type OutreachDeps, type TailorTools } from "../_shared/agent/career_tools.ts";
import { importContactsFile, MX_NOT_WIRED, type MxResolver, type Verifier } from "../_shared/career_contacts.ts";
import { attachAsked, attachTool } from "../_shared/agent/attach_tool.ts";
import { createFileTool } from "../_shared/agent/file_tool.ts";
import type { FileService } from "../_shared/file_service.ts";
import { careerSystemPrompt, shapeRulesFor } from "../_shared/agent/prompt.ts";
import { alertLine, type MemoryStore, type Pipeline, personBlock, type Standing } from "../_shared/agent/memory.ts";
import type { ResearchDeps, ResearchResult } from "../_shared/agent/research/index.ts";
import { enforceResearchReply, stripUnseenLinks } from "../_shared/agent/research/reply.ts";
import { enforceMarketReply, type MarketDeps, type MarketResult } from "../_shared/agent/research/market.ts";
import { type CompanyResult, enforceCompanyReply } from "../_shared/agent/research/company.ts";
import { enforceFollowupAsk } from "../_shared/followup_draft.ts";
import { urlsIn } from "../_shared/channel_shape.ts";
import { knowledgeFor, type Knowledge } from "../_shared/agent/knowledge/index.ts";
import { styleBlock } from "../_shared/agent/style.ts";
import { HYPOTHETICAL_WITHHELD, hypotheticalNote, hypotheticalOf, lengthNote, PERSONA_WITHHELD, postingNote, postingRefOf, REPLY_LENGTH, replyLength, roastNote, roastOf } from "../_shared/agent/turn_notes.ts";
import type { AlertStore } from "../_shared/career_alert_store.ts";
import type { HiredSource } from "../_shared/career_hired.ts";
import type { WantStore } from "../_shared/career_apply_want.ts";
import type { Limits } from "../_shared/career_apply.ts";
import type { MailStore } from "../_shared/career_mail_store.ts";
import type { DigestStore, InterviewStore } from "../_shared/career_brief_store.ts";
import type { AlertPrefs } from "../_shared/career_alerts.ts";
import type { Situation } from "../_shared/career_situation.ts";
import { type CareerEvent, type EventStore, SUMMARY_UNREADABLE, threadSummary } from "../_shared/agent/timeline.ts";

// Release pin (2026-10-22 candidate, the parent's gate): the deployed agent-chat cannot select the agent brain, whatever
// CAREER_BRAIN holds. The brain stays off until it meets the 95% two-judge held-out bar; turning this on is a separate,
// reviewed change, never a secret flip. chooseBrain still states the rule the switch would follow.
// FEATURE 13 (owner, 2026-10-25): the staged release is the reviewed path past this pin. CAREER_BRAIN=staged sends only
// question, advice and conversation turns to the brain, with the tool policy in career_staged.ts; every action stays
// code's. The full brain (CAREER_BRAIN=agent, every turn) stays pinned off here.
export const AGENT_BRAIN_RELEASED = false;

export function chooseBrain(env: { get(k: string): string | undefined }): "agent" | "router" {
  return env.get("CAREER_BRAIN") === "agent" ? "agent" : "router";
}

// What a person erased never reaches the model again: newest-first rows are cut at the latest erase confirmation (the
// host's career_profile_erased turn), which is itself left out.
export function afterErase<T extends { meta?: unknown }>(newestFirst: T[]): T[] {
  const i = newestFirst.findIndex((m) => (m.meta as any)?.intent === "career_profile_erased");
  return i < 0 ? newestFirst : newestFirst.slice(0, i);
}

// WO-023 B5 / WO-027: the model sees the last 40 messages. The handler reads 41 rows newest first; past the latest erase
// nothing is kept (afterErase), and when more than 40 remain the thread is longer than the window, so a summary written
// in code from the account's events goes into the system prompt after the person block.
export const HISTORY_WINDOW = 40;
export function historyWindow(newestFirst: { role: string; content: unknown; meta?: unknown }[]): { history: { role: "user" | "assistant"; content: string }[]; cut: boolean } {
  const kept = afterErase(newestFirst);
  return {
    cut: kept.length > HISTORY_WINDOW,
    history: kept.slice(0, HISTORY_WINDOW).reverse()
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
  };
}
// The summary when the window cut the thread, from the account's events (null: they could not be read, which is said).
export function summaryFor(cut: boolean, events: CareerEvent[] | null, now: number, tz?: string): string | null {
  if (!cut) return null;
  return events ? threadSummary(events, now, tz) : SUMMARY_UNREADABLE;
}

export function localDay(now: number, tz = "America/New_York"): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)); }
  catch { return new Date(now).toISOString().slice(0, 10); }
}

export async function agentTurn(o: {
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  stores: Record<string, unknown>;
  userId: string; threadId: string; now: number;
  model: ModelFn;
  postings?: (query: string) => Promise<any[]>;
  alerts?: AlertStore | null;
  tz?: string;
  // WO-023: what is known about the person, put in the system prompt every turn (built in code, never by the model),
  // and where standing instructions are kept.
  // WO-100: the situation (every task in flight, the next steps, what Trainee can do), read once per turn by the handler;
  // it is in the block and behind get_situation, list_applications and where_do_i_stand.
  known?: { standing: Standing[]; alerts: { prefs: AlertPrefs; tz: string } | null; pipeline: Pipeline | null; situation?: Situation | null };
  memory?: MemoryStore | null;
  // WO-024: applications and the status events found in the person's mail, for where_do_i_stand.
  mail?: Pick<MailStore, "applications" | "events"> | null;
  // WO-027: the account's timeline (written by the tools, read by recall), and the summary of what the window cut.
  events?: EventStore | null;
  // KNOWN GAPS (2026-10-30): where confirm_profile_fact's fact_confirmed events go. agent-chat passes the turn's held store
  // (career_router_evidence.ts heldEvents), so they are written by the turn's own commit (career_host_commit_evidenced) or
  // not at all; absent, the timeline above, as before.
  confirmations?: EventStore | null;
  summary?: string | null;
  // WO-034: a pasted invite is kept here (brief_from_invite), and the weekly digest's settings (set_weekly_digest).
  interviews?: InterviewStore | null;
  digest?: DigestStore | null;
  // WO-033: outreach drafts and settings, and the files the person attached. A contacts CSV is imported and checked by
  // code before the model runs (a 2,000-row export never goes through the model); the model is told what was imported.
  outreach?: OutreachDeps | null;
  conversations?: import("../_shared/career_outreach_replies.ts").RepliesStore | null; // MASS NETWORKING M5
  attachments?: { name: string; mime: string; text: string | null }[];
  mx?: MxResolver;
  verifier?: Verifier | null; // the paid independent check (Hunter), run by verify_contacts; absent: NOT_WIRED
  // WO-028: the posting by id, personas, the private resume store and the PDF renderer.
  tailor?: TailorTools | null;
  // WO-036: who a firm hired, from People Data Labs aggregates (NOT_WIRED without the owner's PDL_API_KEY).
  hired?: HiredSource | null;
  // WO-066: the person's own apply queue (the extension takes it) and their daily application limit.
  wants?: WantStore | null;
  limits?: Limits;
  // WO-068: one posting in full by job_id (get_posting); absent, the tailor's own posting reader.
  posting?: ((jobId: string) => Promise<any | null>) | null;
  // WO-106 (F4): every job link checked just before it is shown.
  linkCheck?: LinkCheck | null;
  // FEATURE 13: the staged release's tool policy: tools withheld by name, and a note on what code does instead.
  toolPolicy?: { withhold: readonly string[]; note: string } | null;
  // Situation knowledge (CAREER_KNOWLEDGE=on, off by default): the Person Context Pack and the 1 to 3 playbooks that fit it
  // go in the system prompt (_shared/agent/knowledge). Off, the prompt is exactly what it was.
  knowledge?: boolean;
  // Open-question research (only with knowledge on): the cached, capped web search and where the brief file goes.
  research?: ResearchDeps | null;
  // R9-C market research (CAREER_RESEARCH_REPLY=on): the research_market tool; its reply is enforced in code (enforceMarketReply).
  market?: MarketDeps | null;
  // D-060 (C18) web research on: the live re-check of a named posting page (research_web.ts recheckPosting). Absent: no such tool.
  postingRecheck?: ((url: string) => Promise<import("../_shared/research_web.ts").PostingRecheck>) | null;
  // REPLY SHAPE: Telegram with CAREER_REPLY_WRITER=on: the shape rules in the prompt, and the attach_document tool.
  shape?: boolean;
  // FILE KINDS: create_file (a page of one of the file kinds); present only with the shape on.
  files?: FileService | null;
  // D-062: the capability tools (_shared/agent/capability_tools.ts: Gmail record and tracker, people search, answering an email),
  // under the same withholding as every other tool.
  capabilities?: import("../_shared/agent/loop.ts").ToolSpec[] | null;
}): Promise<TurnResult & { knowledge?: { playbooks: string[]; unknown: string[]; stage: string | null } }> {
  // MIRROR WA-1 gaps (turn_notes.ts): what code read from this message and this conversation, for this turn only. A hypothetical
  // person is answered without their saved facts (the profile is left out of the block) and with every record tool withheld;
  // a hypothetical situation writes nothing.
  const hypo = hypotheticalOf(o.message);
  const roast = roastOf(o.message, o.history);
  const listed = (o.stores as any)?.discovery?.lastShortlist;
  const meant = hypo === "persona" ? [] : postingRefOf(o.message, Array.isArray(listed) ? listed : [], o.history);
  const turnNotes = [hypo ? hypotheticalNote(hypo) : "", roast ? roastNote(roast) : "", meant.length ? postingNote(meant) : "", lengthNote(replyLength(o.message))].filter(Boolean);
  const hypoWithheld = hypo === "persona" ? PERSONA_WITHHELD : hypo ? HYPOTHETICAL_WITHHELD : [];
  const block = o.known ? personBlock({ profile: hypo === "persona" ? null : o.stores.profile, ...o.known }) : null;
  const notes: string[] = [];
  for (const f of o.attachments ?? []) {
    const csv = /\.csv$/i.test(f.name) || /csv/.test(f.mime);
    notes.push(csv ? `[Attached file: ${(await importContactsFile(o.stores, f, o.mx ?? MX_NOT_WIRED)).note}]` : f.text !== null ? `[Attached file: ${f.name}]\n${f.text}` : `[Attached file: ${f.name} (${f.mime}): this file type can't be read yet]`);
  }
  const know: Knowledge | null = o.knowledge
    // D-060 (knowledge on): a hypothetical person is answered without their saved facts here too (MIRROR WA-1 gaps).
    ? knowledgeFor(hypo === "persona" ? { profile: null, standing: null, alertsLine: null, situation: null, history: [], message: o.message } as any : { profile: o.stores.profile, standing: o.known?.standing, alertsLine: o.known ? alertLine(o.known.alerts) : null, situation: o.known?.situation ?? null, history: o.history, message: o.message })
    : null;
  // D-060: trace.m keeps the turn's sourced result: a later research call that found nothing (the turn's one web search was
  // already used) never replaces it.
  const trace: { r?: Extract<ResearchResult, { status: "ok" }>; m?: MarketResult | CompanyResult } = {};
  const ctx: any = { userId: o.userId, threadId: o.threadId, now: o.now, state: o.stores };
  let result = await runAgentTurn({
    system: careerSystemPrompt(localDay(o.now, o.tz)) + "\n\n" + styleBlock(o.message) + (block ? "\n\n" + block : "") + (know ? "\n\n" + know.text : "") + (o.summary ? "\n\n" + o.summary : "") + (o.toolPolicy ? "\n\n" + o.toolPolicy.note : "") + "\n\n" + turnNotes.join("\n\n") + (o.shape ? "\n\n" + shapeRulesFor(attachAsked(o.message)) : ""),
    history: o.history.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, content: String(m.content ?? "") })),
    message: [o.message, ...notes].filter(Boolean).join("\n\n"),
    // ADVERSARIAL ROUND 2: an attached file's name and text are not the person's words: no tool reads them as said.
    said: o.message,
    tools: [...withheld([...(o.toolPolicy?.withhold ?? []), ...hypoWithheld], [...careerTools({ postings: o.postings ?? (async () => []), alerts: o.alerts ?? null, memory: o.memory ?? null, events: o.events ?? null, confirmations: o.confirmations ?? null, tz: o.tz, mail: o.mail ?? null, interviews: o.interviews ?? null, digest: o.digest ?? null, outreach: o.outreach ?? null, verifier: o.verifier ?? null, tailor: o.tailor ?? null, hired: o.hired ?? null, wants: o.wants ?? null, limits: o.limits, posting: o.posting ?? null, situation: o.known?.situation ?? null, linkCheck: o.linkCheck ?? null, conversations: o.conversations ?? null, market: o.market ? { ...o.market, onResult: (r) => { if (r.status === "ok" || trace.m?.status !== "ok") trace.m = r; } } : null, postingRecheck: o.postingRecheck ?? null, research: o.knowledge && o.research ? { ...o.research, onResult: (r, m) => { if (r.status === "ok") trace.r = r; o.research?.onResult?.(r, m); } } : null }), ...(o.capabilities ?? [])]), ...(o.shape && attachAsked(o.message) ? [attachTool()] : []), ...(o.shape && o.files ? [createFileTool(o.files)] : [])],
    model: o.model,
    ctx,
  });
  // R10 WO-H fix 14b: a draft that could not be written without settling which document or recipient: the reply is that one
  // question, and nothing else (no draft, no second question). Without a question in the reply, it stands as written.
  if (ctx.turn?.askOnly && !ctx.turn?.show && result.reply && result.stopped === "final") result = { ...result, reply: enforceFollowupAsk(result.reply) ?? result.reply };
  // An open career question: the reply is enforced in code, not just asked for in the tool note (research/reply.ts).
  if (trace.r && result.reply && result.stopped === "final") {
    const fixed = await enforceResearchReply({ reply: result.reply, result: trace.r, message: o.message, regenerate: async (problems) => {
      const res = await o.model({ system: "Rewrite the paragraph so it fixes every problem listed. Keep it ONE plain paragraph of about 60 to 90 words: first the honest verdict for this person (what is realistic now, then what comes later), then one concrete thing to do this week, then that the full plan, timeline and honest odds are in the file (only if a file exists). No link, no list, no opener, no filler, no exclamation mark, at most one question. Use no figure, date or name that is not in the person's facts or the sources. Output the paragraph only.",
        messages: [{ role: "user", content: [{ type: "text", text: `Person's question: ${o.message}\nVerdict material: ${trace.r!.verdict.now} ${trace.r!.verdict.later}\nFile exists: ${trace.r!.file_url ? "yes" : "no"}\nDraft: ${result.reply}\nProblems: ${problems.join("; ")}` }] }], tools: [], max_tokens: 500, tool_choice: { type: "none" } });
      return (res.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim() || null;
    } });
    result = { ...result, reply: fixed.reply };
  }
  // Market research: the sources or the file link come from code; the model's links and unsourced figures do not reach the person.
  // R10 WO-H: company research has its own rules (one role question when the role is unknown; a focus keeps that area only).
  if (trace.m && !trace.r && result.reply && result.stopped === "final") result = { ...result, reply: "kind" in trace.m && trace.m.kind === "company" ? enforceCompanyReply(result.reply, trace.m) : enforceMarketReply(result.reply, trace.m as MarketResult) };
  // Not an open career question: any link the model wrote that the turn never saw is removed (links not on the turn's allow-list).
  // MIRROR PROCESS (C23, docs/architect/specs/MIRROR-PROCESS.md): a link Trainee itself already showed in this conversation (an
  // earlier reply's source, e.g. the research answer "that citadel process from earlier" recalls) may be given again with the
  // recalled figure; it passed this same check, or was written by code, when it was first shown.
  else if (!trace.r && result.reply && result.stopped === "final") result = { ...result, reply: stripUnseenLinks(result.reply, [...(result.linksSeen ?? []), ...(result.fileLinks ?? []), ...shownBefore(o.history)]) };
  // MIRROR WA-1 (2026-11-11): the length of a text. On the owner's WhatsApp benchmark Instinct answered in one paragraph of about
  // 400 characters (median 396; longer only to list everything it knew or a research answer in parts); Trainee's brain wrote
  // 1,500 to 2,500 characters of numbered lists on the same asks. A reply over the limit is condensed once by the model, in
  // its own words, under guards in code: every figure and link must come from the long reply, and a turn that showed an exact
  // payload, holds an approval, carries code, or is a sourced research reply is never rewritten.
  // A research, market or company reply was laid out and sourced in code above (its citations number its sources): never condensed.
  if (result.reply && result.stopped === "final" && !trace.r && !trace.m) {
    const limit = condenseLimit(o.message);
    // An ask for everything, or for the detail ("give me a detailed plan for my whole job search, everything"; "like everything
    // you remember") is a deliberate long deliverable: the channel lays it out in several messages (channel_shape.ts), and a
    // rewrite to a text's length would drop what was asked for (tests/architect/telegram-loop-30.test.ts, long-reply-bubbles).
    // Its length is the prompt's to guide, never the shortener's.
    if (limit !== REPLY_TARGET.long && condensable(result, limit)) {
      const short = await condenseReply(o.model, result.reply, limit);
      if (short) result = { ...result, reply: short };
    }
  }
  return know ? { ...result, knowledge: { playbooks: know.playbooks, unknown: know.unknown, stage: know.stage } } : result;
}

// The links Trainee's own earlier replies in the window showed the person (assistant messages only; never a link the person typed,
// which linksSeen already holds, and never one from a tool the model saw but did not show).
export function shownBefore(history: { role: string; content: unknown }[]): string[] {
  return history.filter((m) => m?.role === "assistant" && typeof m.content === "string").flatMap((m) => urlsIn(m.content as string));
}

// FEATURE 13: the tools left after a policy withholds some by name (none withheld: every tool).
export function withheld<T extends { name: string }>(names: readonly string[] | undefined, tools: T[]): T[] {
  return names && names.length ? tools.filter((t) => !names.includes(t.name)) : tools;
}

// MIRROR WA-1: how long a text may be before it is condensed, and the condensing. EVERYTHING asks ("everything you remember",
// "give me real sources", several topics in one ask) may run to a long text; everything else is one short paragraph.
// MIRROR WA-1 gaps: by the kind of ask (turn_notes.ts replyLength, from Instinct's lengths per kind): a draft, a practice question
// and a recall are shorter than an answer; "everything" and research are long.
export const REPLY_TARGET = { short: REPLY_LENGTH.answer, long: REPLY_LENGTH.everything } as const;
export function condenseLimit(message: string): { max: number; aim: string } {
  const l = replyLength(String(message ?? ""));
  return l.kind === "everything" ? REPLY_TARGET.long : l.kind === "answer" ? REPLY_TARGET.short : { max: l.max, aim: l.aim };
}
// A turn whose tools wrote anything (a draft, a fact, a file, a queue entry: any call with an effect, or any draft tool) is never
// condensed: its reply can be the stored payload's own words, which the turn's commit checks against what was written.
export function condensable(r: Pick<TurnResult, "reply" | "show" | "pending_approvals"> & { tool_calls?: TurnResult["tool_calls"] }, limit: { max: number }): boolean {
  const reply = String(r.reply ?? "");
  const wrote = (r.tool_calls ?? []).some((c) => c.effect !== null && c.effect !== undefined || /draft|tailor|file|attach|resume/i.test(c.name));
  return reply.length > limit.max && !r.show && !(r.pending_approvals ?? []).length && !wrote && !/```/.test(reply);
}
const BOUNDARY = /\b(?:nothing|not|never|haven'?t|hasn'?t|didn'?t|wasn'?t|isn'?t|won'?t|no one|nobody)\b[^.!?\n]{0,60}\b(?:sent|submitted|applied|queued|contacted|messaged|emailed)\b|\b(?:sent|submitted|applied)\b[^.!?\n]{0,20}\b(?:nothing|nowhere)\b/i;
const CAVEAT = /\b(?:not (?:verified|confirmed|guaranteed|listed|on file)|unverified|unconfirmed|(?:i )?(?:don'?t|do not|can'?t|cannot|couldn'?t) (?:have|verify|confirm|check|tell|find)|no verified)\b/i;
const NUMBER = /\$?\d[\d,.]*(?:k|%)?/gi, LINK = /https?:\/\/\S+/g;
// The condensed text, or null when it fails a guard (then the long reply stands): shorter, not empty, every number and link in
// it was in the long reply, at most one question.
export function condensedOk(long: string, short: string, limit: { max: number }): boolean {
  const s = String(short ?? "").trim();
  if (!s || s.length >= long.length || s.length > limit.max) return false;
  const nums = new Set((long.match(NUMBER) ?? []).map((x) => x.replace(/[,.]$/, "")));
  if ((s.match(NUMBER) ?? []).some((x) => !nums.has(x.replace(/[,.]$/, "")))) return false;
  const links = new Set(long.match(LINK) ?? []);
  if ((s.match(LINK) ?? []).some((x) => !links.has(x))) return false;
  // MIRROR WA-1 gaps: what was not done and what is not known survive the shortening: a boundary ("nothing was sent", "not
  // submitted") and a caveat ("not verified", "not confirmed", "I don't have") in the long reply must be in the short one.
  for (const keep of [BOUNDARY, CAVEAT]) if (keep.test(long) && !keep.test(s)) return false;
  return (s.match(/\?/g) ?? []).length <= 1;
}
export async function condenseReply(model: ModelFn, long: string, limit: { max: number; aim: string }): Promise<string | null> {
  try {
    const res = await model({
      system: `Rewrite this text message from a career assistant so it reads like a text: ${limit.aim}, plain sentences, at most two short paragraphs. ` +
        "Keep the direct answer first. Keep every name, figure, date and link exactly as written, and every statement of what was not done, not sent, not saved or not verified. " +
        "A draft message the person can copy stays a draft they can copy: shorten it if it is long and keep its [brackets]. " +
        "Drop numbered or bulleted lists (write sentences), headings, repeated points and advice they did not ask for. Add nothing that is not in the text. At most one question, at the end. Output the message only.",
      messages: [{ role: "user", content: [{ type: "text", text: long }] }], tools: [], max_tokens: 600, tool_choice: { type: "none" },
    } as any);
    const out = ((res as any)?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
    return condensedOk(long, out, limit) ? out : null;
  } catch { return null; }
}
