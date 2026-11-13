// Which brain answers a career turn (WO-002, D-008): the CareerHost router unless CAREER_BRAIN=agent, and the agent turn
// itself (model + tools over the person's career state).
import type { LinkCheck } from "../_shared/link_check.ts";
import { EMPTY_AFTER_SAVE_REPLY, EMPTY_REPLY, INCOMPLETE_AFTER_SAVE_REPLY, INCOMPLETE_REPLY, MAX_STEPS_AFTER_SAVE_REPLY, MAX_STEPS_REPLY, MODEL_ERROR_AFTER_SAVE_REPLY, MODEL_ERROR_REPLY, REFUSED_FILE_TODO, runAgentTurn, type ModelFn, type TurnResult } from "../_shared/agent/loop.ts";
import { careerTools, type OutreachDeps, type TailorTools } from "../_shared/agent/career_tools.ts";
import { importContactsFile, MX_NOT_WIRED, type MxResolver, type Verifier } from "../_shared/career_contacts.ts";
import { attachAsked, attachTool } from "../_shared/agent/attach_tool.ts";
import { createFileTool } from "../_shared/agent/file_tool.ts";
import { FAMILY_FILE_TOOL, familyFileTool } from "../_shared/agent/file_family_tool.ts";
import { pathComparisonTool } from "../_shared/agent/path_comparison_tool.ts"; // D-072 (files writers)
import type { PathStore } from "../_shared/career_path_comparisons.ts";
import { FAMILY_TITLE, familyAskOf, type FamilyMakeDeps } from "../_shared/file_family_make.ts";
import type { FileService } from "../_shared/file_service.ts";
import { careerSystemPrompt, MIRROR_RULES, shapeRulesFor } from "../_shared/agent/prompt.ts";
import { alertLine, type MemoryStore, type Pipeline, personBlock, type Standing } from "../_shared/agent/memory.ts";
import type { ResearchDeps, ResearchResult } from "../_shared/agent/research/index.ts";
import { enforceResearchReply, stripUnseenLinks } from "../_shared/agent/research/reply.ts";
import { type AdviceResult, enforceAdviceReply } from "../_shared/agent/research/advice.ts";
import { enforceMarketReply, enforceMarketReplySupported, FAIL_CLOSED, type MarketDeps, type MarketResult } from "../_shared/agent/research/market.ts";
import { type CompanyResult, enforceCompanyReply, enforceCompanyReplySupported } from "../_shared/agent/research/company.ts";
import { enforceFollowupAsk } from "../_shared/followup_draft.ts";
import { urlsIn } from "../_shared/channel_shape.ts";
import { numbersIn, numEq } from "../_shared/agent/research/guard.ts";
import { knowledgeFor, type Knowledge } from "../_shared/agent/knowledge/index.ts";
import { styleBlock } from "../_shared/agent/style.ts";
import { askedPartsOf, asksForDetail, boundaryNote, boundaryOf, capacityAskOf, capacityNote, correctionNote, correctionOf, DRAFT_TOOLS, draftAskOf, draftNote, historyAskOf, historyNote, HYPOTHETICAL_WITHHELD, hypotheticalNote, hypotheticalOf, lengthNote, multiAskNote, overLimit, partsMissing, partsNote, PERSONA_WITHHELD, planSearchAskOf, planSearchNote, whileWorkingNote, postingNote, postingRefOf, REPLY_LENGTH, replyLength, roastNote, roastOf, shownPayNote, shownPayOf, shownPayPlaces, statesNothing, textLength } from "../_shared/agent/turn_notes.ts";
import { severalAsks } from "../_shared/ask_language.ts";
import { factCorrectionHints, factCorrectionNote, isOnePlace, plainAnswer, practiceAnswerNote, practiceAnswerOf, practiceAskIn, RESTORE_ASK_INTENT, restoreAnswerNote, staleFactNote, staleFactsOf } from "../_shared/agent/turn_notes.ts";
import { answersFirst } from "../_shared/reply_rubric.ts";
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
  // D-062 (1): what a posting requires and its application's questions, public pages only (posting_requirements.ts). Absent: no such tool.
  applyFlow?: ((url: string) => Promise<import("../_shared/posting_requirements.ts").ApplyFlow>) | null;
  // REPLY SHAPE: Telegram with CAREER_REPLY_WRITER=on: the shape rules in the prompt, and the attach_document tool.
  shape?: boolean;
  // FILE KINDS: create_file (a page of one of the file kinds). D-061 G11 ("a file ask gets the file"): offered whenever the
  // handler passes a File service, which it does on every channel (the link rides shape.links after the answer; where File links
  // are not set up the service refuses and the brain says so); no longer tied to the reply writer, which stays off (RELEASE_NEVER_ON).
  files?: FileService | null;
  // D-072 (files reachable): the record-backed File families (file_family_make.ts), offered as open_record_file. Absent: no such tool.
  familyFiles?: FamilyMakeDeps | null;
  // D-072 (files writers): where a path comparison the person makes in chat is kept, offered as compare_paths. Absent: no such tool.
  paths?: PathStore | null;
  // D-064 (G13): this message arrived while the previous turn (this text, the person's previous message) was still running.
  whileWorking?: string | null;
  // Review of #790: the marker the turn before returned (restore_ask) when it asked whether a set-aside fact is right again.
  restoreAsk?: { fact_id: string } | null;
  // Whether an application card is open for this person now (the handler reads it; unknown counts as open): the restore question is never asked beside one.
  cardPending?: boolean;
  // D-062: the capability tools (_shared/agent/capability_tools.ts: Gmail record and tracker, people search, answering an email),
  // under the same withholding as every other tool.
  capabilities?: import("../_shared/agent/loop.ts").ToolSpec[] | null;
}): Promise<TurnResult & { shorten?: Shorten; research?: Record<string, unknown>; knowledge?: { playbooks: string[]; unknown: string[]; stage: string | null } }> {
  // MIRROR WA-1 gaps (turn_notes.ts): what code read from this message and this conversation, for this turn only. A hypothetical
  // person is answered without their saved facts (the profile is left out of the block) and with every record tool withheld;
  // a hypothetical situation writes nothing.
  const hypo = hypotheticalOf(o.message);
  const roast = roastOf(o.message, o.history);
  const listed = (o.stores as any)?.discovery?.lastShortlist;
  const meant = hypo === "persona" ? [] : postingRefOf(o.message, Array.isArray(listed) ? listed : [], o.history);
  // D-061 G6, G9, G13: the boundary the person set, a correction said out loud, several asks each answered (turn_notes.ts).
  const boundary = boundaryOf(o.message), correction = correctionOf(o.message);
  // D-065 (live round 1): a draft ask goes through the draft tool (G10/D-059), a plan ask aimed at postings searches first (C1),
  // a research or advice ask's named parts are each covered (G3/G4, C9), an unverified pace is never affirmed (G5, C12).
  const draftAsk = draftAskOf(o.message), planSearch = !hypo && planSearchAskOf(o.message, typeof o.whileWorking === "string" ? o.whileWorking : null);
  const parts = askedPartsOf(o.message), capacity = capacityAskOf(o.message);
  const draftLength = replyLength(o.message).kind === "draft" ? replyLength(o.message) : { kind: "draft" as const, ...REPLY_LENGTH.draft };
  // D-067 (live round 2): an ask about their own applications reads the Gmail record first (G14, C6); pay this conversation already
  // showed is used for a pay ask (G7, C22); a question that states nothing about them is not offered a record write (G1, C1).
  const historyAsk = !hypo && historyAskOf(o.message), shownPay = hypo ? [] : shownPayOf(o.message, o.history);
  // D-070 (G9/D-007, live-7 setup: "the 3.9 gpa on there is outdated, don't reuse it"): a stored fact the person says is out of date
  // is set aside by code before the model runs: back to a draft (never used for a resume, an answer or a form), with when and what
  // they said; what was prepared from the old facts goes stale. The model is told, and answers the rest of the message.
  // Review of #790 (BLOCKER): only the one fact staleFactsOf's fail-closed reading names (never a role, a project or a skill; never a
  // guess). What it was is kept (`was`), so it can be put back; the reply says which fact (setAsideSaid, below). Every other message
  // that may be correcting a fact changes nothing here: the model gets a note (factCorrectionNote) and asks, or corrects it through
  // the person's yes.
  const facts0 = hypo ? [] : (o.stores as any)?.profile?.facts;
  const stale = staleFactsOf(o.message, facts0), maybe = factCorrectionHints(o.message, facts0);
  for (const f of stale as any[]) {
    f.withdrawn_by_owner = { at: new Date(o.now).toISOString(), said: String(o.message ?? "").slice(0, 200), was: { status: f.status, needs_confirmation: f.needs_confirmation } };
    f.status = "draft"; f.needs_confirmation = true;
    const pr = (o.stores as any).profile;
    pr.fact_version = (Number.isFinite(pr.fact_version) ? pr.fact_version : 0) + 1;
  }
  // D-070 (item 11, G2/G3): an answer to the practice question Trainee asked is reviewed verdict first, in one short paragraph.
  const practiceAnswer = !roast && !hypo && practiceAnswerOf(o.message, o.history);
  // Review of #790 (round 3): a plain yes or no to code's own restore question (the marker the turn before carried).
  const restoreFact = o.restoreAsk && !hypo ? ((o.stores as any)?.profile?.facts ?? []).find((f: any) => f?.id === o.restoreAsk!.fact_id && f.withdrawn_by_owner) : null;
  const restoreAnswer = restoreFact ? plainAnswer(o.message) : null;
  const turnNotes = [restoreAnswer ? restoreAnswerNote(restoreAnswer, String(restoreFact.id), String(restoreFact.text || restoreFact.title)) : "", stale.length ? staleFactNote(stale.map((f) => String(f.title || f.text))) : "", maybe.length ? factCorrectionNote(maybe.map((f) => String(f.title || f.text))) : "", practiceAnswer ? practiceAnswerNote() : "", hypo ? hypotheticalNote(hypo) : "", roast ? roastNote(roast) : "", meant.length ? postingNote(meant) : "", boundary ? boundaryNote(boundary) : "",
    correction ? correctionNote(correction) : "", typeof o.whileWorking === "string" ? whileWorkingNote(o.whileWorking) : severalAsks(o.message) ? multiAskNote() : "",
    draftAsk ? draftNote(draftLength.aim) : "", planSearch ? planSearchNote() : "", parts.length ? partsNote(parts) : "", capacity ? capacityNote() : "", historyAsk ? historyNote() : "", shownPay.length ? shownPayNote(shownPay) : "", lengthNote(replyLength(o.message, o.history))].filter(Boolean);
  const hypoWithheld = [...(hypo === "persona" ? PERSONA_WITHHELD : hypo ? HYPOTHETICAL_WITHHELD : []), ...(statesNothing(o.message) ? ["add_profile_fact"] : [])];
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
  // D-063 (C4): trace.a keeps a specific advice question's result (research/advice.ts): its one source goes on its own line.
  const trace: { r?: Extract<ResearchResult, { status: "ok" }>; m?: MarketResult | CompanyResult; a?: AdviceResult } = {};
  const ctx: any = { userId: o.userId, threadId: o.threadId, now: o.now, state: o.stores, restoreAsk: o.restoreAsk ?? null, cardPending: !!o.cardPending };
  const tools = [...withheld([...(o.toolPolicy?.withhold ?? []), ...hypoWithheld], [...careerTools({ postings: o.postings ?? (async () => []), alerts: o.alerts ?? null, memory: o.memory ?? null, events: o.events ?? null, confirmations: o.confirmations ?? null, tz: o.tz, mail: o.mail ?? null, interviews: o.interviews ?? null, digest: o.digest ?? null, outreach: o.outreach ?? null, verifier: o.verifier ?? null, tailor: o.tailor ?? null, hired: o.hired ?? null, wants: o.wants ?? null, limits: o.limits, posting: o.posting ?? null, situation: o.known?.situation ?? null, linkCheck: o.linkCheck ?? null, conversations: o.conversations ?? null, market: o.market ? { ...o.market, onResult: (r) => { if (r.status === "ok" || trace.m?.status !== "ok") trace.m = r; } } : null, postingRecheck: o.postingRecheck ?? null, applyFlow: o.applyFlow ?? null, research: o.knowledge && o.research ? { ...o.research, onResult: (r, m) => { if (r.status === "ok") trace.r = r; o.research?.onResult?.(r, m); }, onAdvice: (r) => { if (r.source || !trace.a?.source) trace.a = r; } } : null }), ...(o.capabilities ?? []), ...(o.paths ? [pathComparisonTool(o.paths)] : [])]), ...(o.shape && attachAsked(o.message) ? [attachTool()] : []), ...(o.files ? [createFileTool(o.files)] : []), ...(o.familyFiles ? [familyFileTool(o.familyFiles, o.files?.ttlHours() ?? 168)] : [])];
  const offered = new Set(tools.map((t) => t.name));
  let result = await runAgentTurn({
    process: processCheck({ draftAsk: draftAsk && DRAFT_TOOLS.some((n) => offered.has(n)), planSearch: planSearch && offered.has("search_jobs"), parts,
      planFile: planSearch && offered.has("create_file"), history: historyAsk && offered.has("read_application_mail"), mail: !hypo && offered.has("read_application_mail"), posting: meant.length > 0 && offered.has("get_posting"), shownPay,
      marketRate: !hypo && marketRateAskOf(o.message) && offered.has("research_market"), review: practiceAnswer || !!roast ? o.message : null, familyFile: !hypo && offered.has(FAMILY_FILE_TOOL) ? familyAskOf(o.message) : null }),
    system: careerSystemPrompt(localDay(o.now, o.tz)) + "\n\n" + styleBlock(o.message) + (block ? "\n\n" + block : "") + (know ? "\n\n" + know.text : "") + (o.summary ? "\n\n" + o.summary : "") + (o.toolPolicy ? "\n\n" + o.toolPolicy.note : "") + "\n\n" + MIRROR_RULES + "\n\n" + turnNotes.join("\n\n") + (o.shape ? "\n\n" + shapeRulesFor(attachAsked(o.message)) : ""),
    history: o.history.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, content: String(m.content ?? "") })),
    message: [o.message, ...notes].filter(Boolean).join("\n\n"),
    // ADVERSARIAL ROUND 2: an attached file's name and text are not the person's words: no tool reads them as said.
    said: o.message,
    shown: shownPay.map((l) => l.text),
    tools,
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
  // FAIL_CLOSED.support (off by default; support.ts): every sentence of the reply is checked by code and by the judge (o.market.judge,
  // one batched call) before it may stand in the model's words; without a judge none does.
  if (FAIL_CLOSED.support && trace.m && !trace.r && result.reply && result.stopped === "final") result = { ...result, reply: "kind" in trace.m && trace.m.kind === "company" ? await enforceCompanyReplySupported(result.reply, trace.m, { judge: o.market?.judge ?? null, ask: o.message }) : await enforceMarketReplySupported(result.reply, trace.m as MarketResult, shownPay, { judge: o.market?.judge ?? null, ask: o.message }) };
  else if (trace.m && !trace.r && result.reply && result.stopped === "final") result = { ...result, reply: "kind" in trace.m && trace.m.kind === "company" ? enforceCompanyReply(result.reply, trace.m) : enforceMarketReply(result.reply, trace.m as MarketResult, shownPay) };
  // D-073 review 2: research read pages and none supported an answer, and the model's reply did not stand (the loop removed its
  // unsourced claim, asked once more and stopped: "incomplete_reply"). The person is told what research found, in code's words: that
  // it could not be confirmed, with the pages checked. Not after a save: that failure sentence says what was saved, and stays.
  // 2026-11-13 (review of #801): the same when research kept lines (status ok): the person gets those lines with their sources, in
  // the pages' own words (code's enforcement of an empty draft), not the generic unfinished-reply line.
  else if (trace.m && !trace.r && result.stopped === "incomplete_reply" && result.reply === INCOMPLETE_REPLY && (trace.m.status === "ok" || (trace.m.status === "no_sources" && (trace.m as { checked?: unknown[] }).checked?.length)))
    result = { ...result, reply: "kind" in trace.m && trace.m.kind === "company" ? enforceCompanyReply("", trace.m) : enforceMarketReply("", trace.m as MarketResult, shownPay) };
  // Not an open career question: any link the model wrote that the turn never saw is removed (links not on the turn's allow-list).
  // MIRROR PROCESS (C23, docs/architect/specs/MIRROR-PROCESS.md): a link Trainee itself already showed in this conversation (an
  // earlier reply's source, e.g. the research answer "that citadel process from earlier" recalls) may be given again with the
  // recalled figure; it passed this same check, or was written by code, when it was first shown.
  else if (!trace.r && result.reply && result.stopped === "final") result = { ...result, reply: stripUnseenLinks(result.reply, [...(result.linksSeen ?? []), ...(result.fileLinks ?? []), ...shownBefore(o.history)]) };
  // D-063 (C4): a specific advice answer: the model's links are removed and code adds the one cited source on its own line.
  if (trace.a && !trace.r && !trace.m && result.reply && result.stopped === "final") result = { ...result, reply: enforceAdviceReply(result.reply, trace.a) };
  // MIRROR WA-1 (2026-11-11): the length of a text. On the owner's WhatsApp benchmark Instinct answered in one paragraph of about
  // 400 characters (median 396; longer only to list everything it knew or a research answer in parts); Trainee's brain wrote
  // 1,500 to 2,500 characters of numbered lists on the same asks. A reply over the limit is condensed once by the model, in
  // its own words, under guards in code: every figure and link must come from the long reply, and a turn that showed an exact
  // payload, holds an approval, carries code, or is a sourced research reply is never rewritten.
  // A research, market or company reply was laid out and sourced in code above (its citations number its sources): never condensed.
  // D-065 (G3, live round 1: the brain overshot every kind, median 507 characters against Instinct's 396): the length is enforced
  // in code. A reply more than 10% over its kind's upper end (turn_notes.ts overLimit, links apart) gets ONE shortening pass, at
  // the kind's target, under the condenser's guards plus: every link and [placeholder] kept, and the result within the bound
  // (else the reply stands as written). An open-question, market or company research reply is laid out and sourced in code and is
  // never rewritten; a specific advice answer is, and its one source goes back on its own line. An ask that itself asks for length
  // ("a detailed plan for my whole job search, everything") is the channel's to lay out in parts (telegram-loop-30,
  // long-reply-bubbles), never the shortener's. A turn whose tools wrote anything, an exact payload, an approval, or code is never
  // condensed (condensable).
  // D-070 (live-7: 13 of 24 replies far over their bound, and the trace could not say whether this pass ran): every turn records
  // what the length pass did (`shorten`: ran or not, accepted or rejected, and why). A turn whose only writes made a File or a
  // resume (tailor_resume, export_tracker, create_file; no record write, no draft, no approval) is now shortened too: its reply
  // describes what was made (the File or PDF holds the content), and its list of changes is said in one line.
  // D-071 (live-8: the pass did not run on C9 and recorded no reason): every way it does not run says why.
  let shorten: Shorten = { ran: false, outcome: "not_run", why: !result.reply ? "no reply to shorten" : result.stopped !== "final" ? `the turn did not finish (${result.stopped})`
    : trace.r || trace.m ? "a research reply, laid out and sourced in code (never rewritten)" : "" };
  if (result.reply && result.stopped === "final" && !trace.r && !trace.m) {
    const l = replyLength(o.message, o.history), bound = overLimit(l), n = textLength(result.reply);
    // D-072 (item 11): a practice turn (a question asked, or a review of their answer) is shortened like any reply unless it shows a
    // code block; the code it names (a call, an index, an operator, a complexity) is kept verbatim (codeKept). Complexity notation
    // alone ("O(n) time") is not code. Every other turn keeps D-067's rule: code in the message or the reply is never shortened.
    const practiceTurn = practiceAnswer || !!roast || (l.kind === "question" && practiceAskIn(o.message, o.history));
    const codeSkip = practiceTurn ? /```/.test(result.reply) : carriesCode(o.message) || carriesCode(result.reply);
    const fileTurn = !condensable(result, { max: -1 }) && onlyFileWrites(result);
    // A "draft" kind written in prose is not a message draft (those go through draft_followup, below): it is a rewrite of their
    // own text ("make the answer less formal"), whose length is the text's, not a draft's. A File turn's reply is not a draft.
    const why = n <= bound ? "within the bound" : l.kind === "draft" && !fileTurn ? "a draft kind (its length is the text's)" : l.kind === "everything" && asksForDetail(o.message) ? "the ask asks for detail"
      : codeSkip ? (practiceTurn ? "a practice reply with a code block" : "carries code") : !(condensable(result, { max: -1 }) || fileTurn) ? "the turn wrote a record, a draft or an approval" : "";
    if (why) shorten = { ran: false, outcome: n <= bound ? "within" : "skipped", why, chars: n, bound };
    else {
      // D-071 (live-8: 11 of 14 shortened texts were refused only for being still over the bound, and the long reply was sent; C4's
      // 602 would have passed the far bound): a shorter text that passes every preservation check (every figure, link and
      // [placeholder] kept, the boundary and the caveat kept, at most one question, a rewrite of this same reply) is used even when
      // it is still over the bound, and it gets ONE more pass toward the bound under the same checks against the original reply.
      const long = result.reply, seen = { out: "" };
      const faithful = (from: string) => (l0: string, out: string) => shortenedOk(l0, out, Number.POSITIVE_INFINITY) && shortenedOk(from, out, Number.POSITIVE_INFINITY) && (!practiceTurn || codeKept(from, out));
      // D-073 (live-9: 7 shorter texts still over the bound, the second pass stopping short of it; C4, C6, C11 refused for dropping
      // a caveat or a figure): each pass is told the number to reach (the kind's upper end, inside the scorer's D-066 kind bound)
      // and what must stay (keepList: every figure, link-free, every [placeholder], each sentence saying what was not done or is
      // not known), instead of being refused after.
      const keep = keepList(long), extra = (t: string, k: number) => [fileTurn ? FILE_TURN_CONDENSE : "", lengthTarget(textLength(t), l.upper, k), keep].filter(Boolean).join(" ");
      let short = await condenseReply(o.model, long, { max: bound, aim: l.aim }, faithful(long), extra(long, 1), seen);
      let passes = 1, why = short ? "" : shortenRejection(long, seen.out, Number.POSITIVE_INFINITY);
      if (short && textLength(short) > bound) {
        const seen2 = { out: "" };
        const second = await condenseReply(o.model, short, { max: bound, aim: l.aim }, faithful(long), extra(short, 2), seen2);
        passes = 2;
        if (second) short = second;
      }
      const after = short ? textLength(short) : null;
      if (short && after! > bound) why = `shorter but still over the bound (${after} > ${bound})`;
      shorten = { ran: true, outcome: !short ? "rejected" : after! <= bound ? "accepted" : "shorter", why, chars: n, bound, passes, ...(short ? { after: after! } : {}) };
      if (short) result = { ...result, reply: trace.a ? enforceAdviceReply(short, trace.a) : short };
    }
  }
  // D-065 (G3 for drafts): a draft shown by draft_followup (labelled "Draft, not sent." after it, D-067) over the draft bound is shortened once BEFORE it is
  // shown, only in its wording: the shorter text passes the same draft check (no invented history, figure, name or address; the
  // same recipient and document) and keeps every placeholder, or the draft stands as the tool checked it. Nothing here touches a
  // card with a payload (draft_outreach, draft_email_reply): those are never rewritten.
  const d = (ctx.turn as any)?.draft as { label: string; body: string; recheck: (b: string) => boolean } | undefined;
  if (result.show?.intent === "career_followup_draft" && d && result.reply === result.show.text) {
    const bound = overLimit(draftLength);
    if (textLength(result.reply) > bound) {
      const room = bound - textLength(d.label) - 2;
      const short = await condenseReply(o.model, d.body, { max: room, aim: draftLength.aim }, (long, out) => shortenedOk(long, out, room) && d.recheck(out));
      if (short) { const text = `${short}\n\n${d.label}`; result = { ...result, reply: text, show: { ...result.show, text } }; }
    }
  }
  // D-067 (owner, must-fix (d): "each figure carries its source link and place"): a posting's pay said in the reply comes with that
  // posting's link (search_jobs / get_posting returned both); code adds the link when the reply has the figure and not the link.
  // D-073: on every path, research turns included (their shown figure's link was added above; its place is added here).
  if (result.reply && result.stopped === "final" && !result.show) result = { ...result, reply: payWithSource(result.reply, [...(Array.isArray(result.postings) ? result.postings as any[] : []), ...(result.paySources ?? [])], shownPayPlaces(o.message, hypo ? [] : o.history)) };
  // D-067 (live-6 C9: research_market ran and the person got an empty message; D-024): the last line of every brain turn. An empty
  // or blank reply is never sent: the research's own sourced points when it found any, else the honest line that it did not finish.
  // D-071 (live-8 C6: "Your Gmail shows 8 applications ... That's 9 listed, so I miscounted 8 above"): the number of applications is
  // the record's (read_application_mail's counts), never the model's own count.
  const counted = (ctx.turn as any)?.counts?.applied;
  if (typeof counted === "number" && result.reply && result.stopped === "final" && !result.show) result = { ...result, reply: applicationCount(result.reply, counted) };
  // D-071 (live-8 C9: research ran, kept nothing, and the trace could not say why): what the research did with its pages and draft.
  const research = trace.m ? { kind: "kind" in trace.m ? "company" : "market", status: trace.m.status, ...((trace.m as any).audit ?? {}) } : null;
  result = { ...result, reply: nonEmptyReply(result, trace.m), shorten, ...(research ? { research } : {}) } as typeof result;
  // Review of #790: a fact code set aside this turn is said to the person, by name, on every path. When the reply does not carry
  // the fact's own figures, its line goes after the reply, in the fact's own words. A turn whose reply is a card (an exact payload)
  // cannot carry it, so nothing is set aside on that turn: the fact goes back as it was.
  if (stale.length) {
    // Round 4: only a card that carries a payload undoes it. Code's own restore question is not one (and is never asked on the
    // turn that set the fact aside: confirm_profile_fact refuses), so it can never undo a set-aside.
    if (result.show && result.show.intent !== RESTORE_ASK_INTENT) {
      for (const f of stale as any[]) { Object.assign(f, f.withdrawn_by_owner.was); delete f.withdrawn_by_owner; }
    } else {
      const set = (stale as any[]).map((f) => ({ id: String(f.id), text: String(f.text || f.title) }));
      result = { ...result, reply: setAsideSaid(result.reply, set.map((x) => x.text)), set_aside: set } as typeof result;
    }
  }
  // Review of #790 (round 3): the marker a later yes needs to put a set-aside fact back is the one CODE set when confirm_profile_fact
  // asked its own question (the reply is that question, shown as written); a question in the model's words never sets it. It is
  // dropped when the turn also asked for an approval, or a card is open: the person's next yes belongs to that.
  const ask = result.show?.intent === RESTORE_ASK_INTENT ? (result.show.meta as any)?.restore_ask : null;
  if (ask && !result.pending_approvals?.length && !o.cardPending) result = { ...result, restore_ask: ask } as typeof result;
  else if (ask) result = { ...result, show: { ...result.show!, meta: {} } };
  return know ? { ...result, knowledge: { playbooks: know.playbooks, unknown: know.unknown, stage: know.stage } } : result;
}

// Review of #790 (rounds 3 and 4): whenever a fact was set aside this turn, code states it itself, once, as the first line, in the
// fact's own words (the model is told not to: staleFactNote). From the model's reply only this is removed: a sentence that STATES
// that fact's status (its label or value with a status word: set aside, removed, kept, still on file, updated, using ...), and a
// general claim that nothing changed ("Nothing on your record was changed."), which the set-aside makes untrue. A question, and a
// sentence about a form, a posting or a next step that only mentions the label, stay. A turn that did not finish says what was saved.
const UNFINISHED: Record<string, string> = { [INCOMPLETE_REPLY]: INCOMPLETE_AFTER_SAVE_REPLY, [EMPTY_REPLY]: EMPTY_AFTER_SAVE_REPLY, [MODEL_ERROR_REPLY]: MODEL_ERROR_AFTER_SAVE_REPLY, [MAX_STEPS_REPLY]: MAX_STEPS_AFTER_SAVE_REPLY };
export const SET_ASIDE_LINE = "Set aside, not deleted (no longer used until you say it's right again): ";
function namesFact(sentence: string, fact: string): boolean {
  const m = /^([^:]{1,40}):\s*(.+)$/.exec(fact), label = (m ? m[1] : "").trim(), value = (m ? m[2] : fact).trim();
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (!!label && new RegExp(`(?<![A-Za-z])${esc(label)}(?![A-Za-z])`, "i").test(sentence)) || new RegExp(`(?<![\\w$.])${esc(value)}(?![\\w%]|\\.\\d)`, "i").test(sentence);
}
const STATUS_WORD = /\bset aside\b|\baside\b|\bremov(?:e|ed|ing)\b|\bkept\b|\bkeep(?:ing)? (?:using|it)\b|\bstill on (?:file|record)\b|\bupdated\b|\bchanged\b|\bsaved\b|\bdeleted\b|\busing\b|\bwill use\b|\bon your (?:record|profile)\b|\boff\b|\bno longer (?:used|use)\b|\b(?:won't|will not) (?:be used|use)\b/i;
const NOTHING_CHANGED = /\b(?:nothing|no facts?|none of your facts)\b[^.!?]*\b(?:changed|removed|updated|deleted|touched|set aside)\b|\b(?:didn't|did not|haven't|have not|hasn't|has not) (?:been )?(?:chang|remov|touch|updat|delet)\w*\b|\bunchanged\b|\bstill confirmed\b|\b(?:all|every one of) your facts\b/i;
export function setAsideSaid(reply: string, facts: string[]): string {
  if (!facts.length) return reply;
  const line = `${SET_ASIDE_LINE}${facts.join("; ")}`, r = String(reply ?? "");
  if (UNFINISHED[r] || Object.values(UNFINISHED).includes(r)) return `${line}\n\n${UNFINISHED[r] ?? r}`;
  const goes = (x: string) => !x.trim().endsWith("?") && (NOTHING_CHANGED.test(x) || (STATUS_WORD.test(x) && facts.some((f) => namesFact(x, f))));
  const kept = r.split("\n").map((l) => l.startsWith(SET_ASIDE_LINE) ? "" : l.split(/(?<=[.!?])[ \t]+/).filter((x) => !goes(x)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return kept ? `${line}\n\n${kept}` : line;
}
// D-071: "N applications" said with another number than the record's is the record's number; a sentence about having miscounted
// goes (the count was code's). Other numbers ("1 researched role") are not touched.
const NUMWORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export function applicationCount(reply: string, n: number): string {
  let changed = false;
  const out = String(reply).replace(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(\s+(?:[a-z-]+\s+){0,2}?applications?\b)/gi, (m, k: string, rest: string) => {
    const v = /^\d/.test(k) ? Number(k) : NUMWORD[k.toLowerCase()];
    if (v === n || /researched|draft/i.test(rest)) return m;
    changed = true; return `${n}${rest.replace(/\bapplication\b/i, n === 1 ? "application" : "applications")}`;
  });
  if (!changed && !/\bmiscount/i.test(out)) return reply;
  const keep = (x: string) => !/\bmiscount/i.test(x) && !/^(?:\d{1,3}|[a-z]+) is right\.?$/i.test(x.trim());
  return out.split("\n").map((line) => line.split(/(?<=[^\d\s][.!?])[ \t]+/).filter(keep).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// D-067 (d): every posting whose stated pay the reply gives (its figures, in a sentence naming its company) has its link in the reply.
// D-070 (live-7 C11: "For Chicago the pay is $28-$49 hourly", read by inspect_apply_flow, went out with no link): every tool that read
// a posting's pay this turn is a source (loop.ts paySources), not search_jobs alone; and when the turn read exactly one posting
// with pay, a sentence giving that pay is about it whether or not it names the employer again. Pay this conversation already showed
// (shownPayOf's lines, each with the link it was shown with) carries that link when the reply says it again.
// D-073 (live-9 C9, owner must-fix (d) "each figure carries its source link and place"): on every path (a posting read this turn,
// pay this conversation already showed, research turns included) a sentence giving a posting's pay names its place: when the
// sentence does not name it, the place the tool or the earlier reply gave (`place`; else the pay's own "(Chicago, Illinois)") goes
// right after the figure, in parentheses. Nothing else in the sentence changes.
const MONEY_PHRASE = /\$\s?\d[\d,.]*(?:\s?[kK])?(?:\s?(?:-|–|to)\s?\$?\s?\d[\d,.]*(?:\s?[kK])?)?(?:\s?\/\s?(?:hr|hour|yr|year)\b|\s(?:an?|per)\s(?:hour|year)\b|\s(?:hourly|annually|yearly|a year)\b)?/;
function placeOfPay(p: { pay?: string | null; place?: string | null }, figures: ReturnType<typeof numbersIn>): string | null {
  const pay = String(p?.pay ?? "");
  // Pay by place ("Chicago, IL: $28-$49; San Jose, CA: $36-$62"): the place whose range holds the figure.
  // The sentence's own figures decide; figures that sit in two places' ranges name no one place, so none is written.
  const byPlace = pay.split(/;\s*/).map((seg) => /^([^:$]{2,60}):\s*(.*)$/.exec(seg.trim())).filter(Boolean) as RegExpExecArray[];
  const held = [...new Set(byPlace.filter((m) => numbersIn(m[2]).some((y) => figures.some((n) => numEq(y, n)))).map((m) => m[1].trim()))];
  if (held.length) return held.length === 1 ? held[0] : null;
  const inPay = /\(([^()$\d]{2,60})\)/.exec(pay)?.[1]?.trim();
  return onePlace(String(p?.place ?? "")) || inPay || null;
}
// 2026-11-13 (review of #801; a missing place is acceptable, a wrong one is not): the record's location is written beside the pay
// only when it is one place. Several places ("San Jose, CA; Austin, TX", "Chicago, IL / New York, NY", "Multiple locations") or
// remote together with an office name no one place for the pay; remote alone is said as the record says it.
function onePlace(place: string): string | null {
  const t = place.replace(/\s+/g, " ").trim();
  if (!t || /[;|\/]|\b(?:or|and|multiple|various|several|locations|anywhere)\b/i.test(t)) return null;
  if (/\bremote\b/i.test(t)) return /^remote(?:\s*[-,(]\s*(?:US|USA|U\.S\.|United States)\)?)?$/i.test(t) ? t : null;
  return t;
}
// A sentence about the person's own job ("Your current job pays $40 an hour", "my last job paid $40/hr") is not a posting's.
const OWN_JOB = /\b(?:your|my|our)\b/i;
// D-073 review (item 1: "Stripe pays $40/hr. PayPal pays $40/hr." had PayPal's sentence given Stripe's place, then its own): a place
// is a fact code writes into the reply, so it goes only into the sentence(s) bound to that one posting or shown line (`binds`: the
// sentence, the figures, the place), never into every sentence that happens to give the same figure. A sentence bound to two
// different places, or naming another posting's employer, is ambiguous and gets nothing.
type PlaceBind = { key: string; figures: ReturnType<typeof numbersIn>; place: string };
function withPlace(reply: string, binds: PlaceBind[]): string {
  if (!binds.length) return reply;
  return reply.split("\n").map((line) => line.split(/(?<=[.!?])(?=\s)/).map((x) => {
    if (/https?:\/\//.test(x)) return x;
    const mine = binds.filter((b) => b.key === x.trim());
    const places = [...new Set(mine.map((b) => b.place.toLowerCase()))];
    if (places.length !== 1 || OWN_JOB.test(x)) return x;
    const place = mine[0].place, figures = mine.flatMap((b) => b.figures), city = place.split(",")[0].trim().toLowerCase();
    if (!city || x.toLowerCase().includes(city)) return x;
    const m = MONEY_PHRASE.exec(x);
    return m && numbersIn(m[0]).some((n) => figures.some((y) => numEq(y, n))) ? `${x.slice(0, m.index + m[0].length)} (${place})${x.slice(m.index + m[0].length)}` : x;
  }).join("")).join("\n");
}
const namesWord = (x: string, name: string) => !!name && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(x);
export function payWithSource(reply: string, postings: { company?: string | null; title?: string | null; pay?: string | null; url?: string | null; place?: string | null }[], shown: { text: string; url: string | null; place?: string | null }[] = []): string {
  const add: string[] = [];
  const sentences = String(reply).replace(/https?:\/\/\S+/g, " ").split(/(?<=[.!?])\s+|\n+/);
  // FAIL_CLOSED.support (review of #807, class 8: with PayPal's posting read, "the ibm role pays $40/hr." was given PayPal's city, and
  // a city read from an earlier reply's text was attached to another employer's pay): no place is written into a sentence of the
  // model's, and none is taken from reply text. A posting's place is written by code beside that posting's own link, from that
  // posting's own record (employer, title, place: all three from the one record the link is from), and only when the record names
  // one place (isOnePlace, or remote alone) and no other record with that link names another.
  if (FAIL_CLOSED.support) {
    const recs = (postings ?? []).filter((p) => numbersIn(String(p?.pay ?? "")).length && /^https:\/\//.test(String(p?.url ?? "")));
    const urls = [...new Set(recs.map((p) => String(p.url)))];
    const placeOf = (p: { place?: string | null }) => { const t = String(p?.place ?? "").replace(/[ \t]+/g, " ").trim(); return isOnePlace(t) || /^remote$/i.test(t) ? t : null; };
    for (const url of urls) {
      const mine = recs.filter((p) => String(p.url) === url), p = mine[mine.length - 1], co = String(p?.company ?? "").trim().toLowerCase(), ns = numbersIn(String(p?.pay ?? ""));
      if (!sentences.some((x) => (urls.length === 1 || (co && x.toLowerCase().includes(co))) && numbersIn(x).some((n) => ns.some((y) => numEq(y, n)))) || reply.includes(url)) continue;
      const places = mine.map(placeOf), place = places.every(Boolean) && new Set(places.map((x) => x!.toLowerCase())).size === 1 ? places[0] : null;
      const whose = [p?.company, p?.title].map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");
      add.push(place ? `${whose ? `${whose} ` : ""}(${place}): ${url}` : url);
    }
    for (const l of shown ?? []) {
      const ns = numbersIn(l.text), url = String(l.url ?? "");
      if (!ns.length || !sentences.some((x) => { const xs = numbersIn(x); return xs.length > 0 && xs.every((n) => ns.some((y) => numEq(y, n))); })) continue;
      if (/^https:\/\//.test(url) && !reply.includes(url) && !add.some((a) => a.endsWith(url))) add.push(url);
    }
    return add.length ? `${String(reply).trimEnd()}\n\n${add.join("\n")}` : String(reply);
  }
  const withPay = [...new Map((postings ?? []).filter((p) => numbersIn(String(p?.pay ?? "")).length && /^https:\/\//.test(String(p?.url ?? ""))).map((p) => [String(p.url), p])).values()];
  const only = withPay.length === 1;
  const companies = [...new Set((postings ?? []).map((p) => String(p?.company ?? "").trim().toLowerCase()).filter(Boolean))];
  const binds: PlaceBind[] = [];
  for (const p of withPay) {
    const ns = numbersIn(String(p?.pay ?? "")), url = String(p?.url ?? "");
    const co = String(p?.company ?? "").trim().toLowerCase();
    const mine = sentences.filter((x) => (only || (co && x.toLowerCase().includes(co))) && numbersIn(x).some((n) => ns.some((y) => numEq(y, n))));
    if (!mine.length) continue;
    // The place: only where the sentence is this posting's alone (it names no other posting's employer; and when it does not name
    // this employer either, the one posting read this turn, it names no one at all).
    for (const x of mine) {
      const place = placeOfPay(p, numbersIn(x).filter((n) => ns.some((y) => numEq(y, n))));
      if (!place) continue;
      if (companies.some((c) => c !== co && namesWord(x, c))) continue;
      // 2026-11-13 (review of #801: with PayPal's posting read, "IBM pays $40/hr." took PayPal's city): any other name in the
      // sentence, in capitals or all capitals, may be another employer, whether or not the sentence names this one too.
      if (otherNames(x, `${place} ${p.title ?? ""} ${p.company ?? ""}`).length) continue;
      binds.push({ key: x.trim(), figures: ns, place });
    }
    if (!reply.includes(url) && !add.includes(url)) add.push(url);
  }
  for (const l of shown ?? []) {
    const ns = numbersIn(l.text), url = String(l.url ?? "");
    if (!ns.length) continue;
    const mine = sentences.filter((x) => { const xs = numbersIn(x); return xs.length > 0 && xs.every((n) => ns.some((y) => numEq(y, n))); });
    if (!mine.length) continue;
    if (l.place) for (const x of mine) binds.push({ key: x.trim(), figures: ns, place: l.place });
    if (/^https:\/\//.test(url) && !reply.includes(url) && !add.includes(url)) add.push(url);
  }
  const out = withPlace(String(reply), binds);
  return add.length ? `${out.trimEnd()}\n\n${add.join("\n")}` : out;
}
// The names a sentence gives beyond the posting's own place, title and employer: capitalised words and (2026-11-13) all-capitals
// ones ("IBM", "NVIDIA"), other than a small closed list ("SWE", "US", months, days); a first word is one unless it is a common way
// to start a sentence. A word wrongly read as a name only means no place is added.
const STARTER = /^(?:The|A|An|For|In|At|On|It|Its|That|This|Their|They|There|Here|Pay|Base|Hourly|And|But|So|Yes|No|You|Your|With|From|To|As|Per|Each|Most|Also|Salary|Compensation|Posted|Listed|Stated)$/;
function otherNames(x: string, own: string): string[] {
  const inPlace = own.toLowerCase(), first = /^\S+/.exec(x.trim())?.[0].replace(/[^\p{L}'-]/gu, "") ?? "";
  return (x.trim().match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}'&-]+/gu) ?? []).filter((w, k) => !(k === 0 && w === first && STARTER.test(w)) && !inPlace.includes(w.toLowerCase().replace(/'s$/, "")) && !/^(?:I|I'm|I've|I'll|SWE|SDE|US|USA|USD|PTO|HR|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(w));
}
// D-067: the reply, never blank. A shown payload stands as shown; a market research result with sources gives its points (code's
// own enforcement of an empty draft: the kept points with their sources, or the plain no-source line).
export function nonEmptyReply(r: Pick<TurnResult, "reply" | "show" | "tool_calls">, m?: MarketResult | CompanyResult): string {
  if (/[\p{L}\p{N}]/u.test(String(r.reply ?? ""))) return r.reply;
  if (r.show?.text && /[\p{L}\p{N}]/u.test(r.show.text)) return r.show.text;
  if (m && !("kind" in m && m.kind === "company") && m.status === "ok") {
    const fromResearch = enforceMarketReply("", m as MarketResult);
    if (/[\p{L}\p{N}]/u.test(fromResearch)) return fromResearch;
  }
  // D-073 review 2: research read pages and none supported an answer, and the model wrote nothing: the person is still told that it
  // could not be confirmed, with the pages checked (code's enforcement of an empty draft), never the general empty line.
  if (m && m.status === "no_sources" && (m as { checked?: unknown[] }).checked?.length) return "kind" in m && m.kind === "company" ? enforceCompanyReply("", m) : enforceMarketReply("", m as MarketResult);
  return (r.tool_calls ?? []).some((c) => c.ok && c.effect === "write_own") ? EMPTY_AFTER_SAVE_REPLY : EMPTY_REPLY;
}

// D-065: the process the turn still owes before its reply stands (loop.ts `process`, asked once). Each names its ruling.
// D-071 (live-8 C22: "what's the going rate for swe interns in chicago, hourly" was answered with one posting's range and an offer
// to look; no research ran): an ask for the going, market or typical pay of a role is a research ask. The posting pay already shown
// is still given, beside a sourced benchmark.
export const MARKET_RATE_ASK = /\b(?:going|market|typical|average|usual|standard|normal|median)\s+(?:hourly\s+|annual\s+|base\s+)?(?:rate|pay|salary|salaries|wage|wages|comp(?:ensation)?)\b|\bhow\s+much\s+(?:do|does|would|will)\s+[a-z ]{2,40}?\s+(?:make|earn|get\s+paid)\b|\bwhat\s+(?:do|does)\s+[a-z ]{2,40}?\s+(?:make|earn)\b|\bpay\s+(?:range|benchmark)s?\s+for\s+(?:a\s+|an\s+)?[a-z]/i;
export function marketRateAskOf(message: string): boolean { return MARKET_RATE_ASK.test(String(message ?? "")); }
export function processCheck(o: { draftAsk: boolean; planSearch: boolean; parts: string[]; planFile?: boolean; history?: boolean; mail?: boolean; posting?: boolean; shownPay?: { text: string; url: string | null }[]; marketRate?: boolean; review?: string | null; familyFile?: keyof typeof FAMILY_TITLE | null }): ((reply: string, calls: { name: string; ok: boolean; error?: string }[]) => string | null) | null {
  if (!o.draftAsk && !o.planSearch && !o.parts.length && !o.history && !o.mail && !o.posting && !o.shownPay?.length && !o.marketRate && !o.review && !o.familyFile) return null;
  return (reply, calls: { name: string; ok: boolean; error?: string }[]) => {
    const called = (names: readonly string[]) => calls.some((c) => names.includes(c.name));
    // D-072 (files reachable, D-066 P6): an ask to see one of their record-backed Files gets that File from their records, or is told
    // plainly what is missing (the tool's own answer); it is never described from memory.
    if (o.familyFile && !called([FAMILY_FILE_TOOL])) return `They asked to see their ${FAMILY_TITLE[o.familyFile]}. Call ${FAMILY_FILE_TOOL} now with that family, then say in a sentence or two what it holds (only from its holds), or, if it was not made, what is missing. Write no link: code adds it.`;
    // G10 / D-059: the draft tool is the only path for a draft; a draft written in the reply's prose is never shown.
    if (o.draftAsk && !called(DRAFT_TOOLS)) return "They asked for a message draft and you wrote it in your reply. Call draft_followup now with the draft as body (keep [placeholders] for what you don't know); code shows its text as your reply.";
    // MIRROR-PROCESS C1: the plan stands on a search of postings they could apply to.
    if (o.planSearch && !called(["search_jobs"])) return "They asked what to do to land postings they could apply to, and no search ran. Call search_jobs now with their goal, then write the plan around what it found (say how many, and if none, what it covered).";
    // D-067 (G14, C6): their own application history is read from the record that holds it.
    if ((o.history || (o.mail && SAYS_NOT_APPLIED.test(reply))) && !called(["read_application_mail"])) return "They asked about their own applications and you did not read their record. Call read_application_mail now and answer from what it returns, saying what it covered.";
    // D-067 (G11, C1): a plan ask gets its plan as a File (the postings and the weeks in it); the reply is the short answer and says the plan is in the file.
    // D-070 (live-7 C1: create_file ran, was refused, and no File reached the person): only a File that was made counts; a refused
    // one is asked again with what refused it.
    const madeFile = calls.some((c) => c.name === "create_file" && c.ok);
    const refusedFile = [...calls].reverse().find((c) => c.name === "create_file" && !c.ok) as { error?: string } | undefined;
    // D-073 (live-9 C1): the refusal's exact error, whole (its words before the kind's shape, and the shape), and the fix it asks for.
    if (o.planFile && called(["search_jobs"]) && !madeFile) return refusedFile
      ? `${REFUSED_FILE_TODO}${refusedFile.error ? `: ${String(refusedFile.error).slice(0, 900)}` : ""}. Fix exactly what that error names${/source/i.test(String(refusedFile.error ?? "")) ? " (give every fact its source, leave out what no tool returned and they did not say)" : ""}, keep everything else as it was, and call create_file (kind plan_review) again now, then reply in a few sentences with the answer first and say the full plan is in the file. Write no link: code adds it.`
      : "They asked for a plan: put the plan (the postings the search found, with their links, and the steps by week) in a File with create_file (kind plan_review), then reply in a few sentences with the answer first and say the full plan is in the file. Write no link: code adds it.";
    // D-067 (G14, C22): a posting they named is read before research about it.
    const firstResearch = calls.findIndex((c) => c.name === "research_market"), firstRead = calls.findIndex((c) => c.name === "get_posting");
    if (o.posting && firstResearch >= 0 && (firstRead < 0 || firstRead > firstResearch)) return "They named a posting this conversation already showed, and you researched before reading it. Call get_posting on it now and answer from what the posting itself states (its pay for their place, as written) before any research figure.";
    // D-070 (live-7 C22, G7, owner must-fix (d)): a pay ask that this conversation already answered with a posting's pay gets that
    // pay, with its place and where it came from: "the only pay I have is what the posting lists" without the figure answers nothing.
    const money = (t: string) => (String(t).match(/\$\s?\d[\d,.]*(?:\s?[kK])?/g) ?? []).flatMap((x) => numbersIn(x));
    const shownNums = (o.shownPay ?? []).flatMap((l) => money(l.text));
    if (shownNums.length && !money(reply).some((n) => shownNums.some((x) => numEq(x, n)))) return `This conversation already showed pay that answers this ask: ${(o.shownPay ?? []).map((l) => `"${l.text}"`).join("; ")}. State that figure with its place, naming the posting or source it came from (a single posting's range is not a market rate: say so), alongside anything else you found. Write no link: code adds its source.`;
    // D-071 (C22): a market-rate ask tries sourced research (a benchmark with its sources), whatever pay this conversation showed.
    if (o.marketRate && !called(["research_market"])) return "They asked for the going rate, not one posting's pay. Call research_market now (format inline) for a sourced benchmark for that role and place, then answer with what it found (or say it found nothing) beside the posting pay already shown, each with where it came from. Write no link: code adds the sources.";
    // G3 / G4 (C9): every part they named is answered.
    const missing = partsMissing(reply, o.parts);
    if (missing.length) return `They asked about ${o.parts.join(", ")}, and your reply does not cover: ${missing.join(", ")}. Add each missing part from what you read this turn (call the research tool again only if needed), and where nothing covers it, say that in one plain sentence for that part.`;
    // D-072 (item 11, G2: live-7 and live-8 reviews opened "Right approach for the wrong problem." and "That's a summary of events,
    // not an interview answer.", a verdict that never says what it is a verdict on): a review of their practice answer opens with
    // the verdict ON what they said, naming their answer or approach in their own terms (reply_rubric.ts answersFirst, the G2 rule).
    if (o.review && answersFirst({ ask: o.review, reply } as any).length) return `Your first sentence is: "${String(reply).trim().split(/(?<=[.!?])\s+/)[0]?.slice(0, 200) ?? ""}". It gives a verdict without saying what it is a verdict on. Make the FIRST sentence your verdict on their answer and name what they actually said or did (their approach, their code, their story, in their own words). Keep the rest of the review, as short as it was or shorter, with at most one question at the end.`;
    return null;
  };
}

// D-067 (owner, must-fix: "never say 'you haven't applied' without checking connected email first"): a reply that says they have
// not applied, or that nothing is on record, is a history answer whatever the ask was.
export const SAYS_NOT_APPLIED = /\byou(?:'ve|\s+have)?\s+(?:not|haven'?t|didn'?t|did\s+not|never)\s+(?:yet\s+)?(?:applied|submitted)\b|\byou\s+have\s+no\s+applications?\b|\bno\s+applications?\s+(?:on\s+record|yet|so\s+far|from\s+you|anywhere)\b|\bnothing\s+(?:is\s+)?on\s+record\s+yet\b|\b(?:not|haven'?t)\s+applied\s+(?:to\s+)?any(?:thing|where)\s+yet\b/i;
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
  // D-067 (G3, live-6: no answer turn that called any tool came under its bound): a read is not a write. The name test matched
  // "profile" and "resume" in read tools (get_profile, read_resume) and every effect counted, "read" included, so any turn that
  // looked something up was never shortened. A write is a call that succeeded with a writing effect, or a tool that makes a draft,
  // a file or a resume (its words can be the payload's own).
  const wrote = (r.tool_calls ?? []).some((c) => (c.ok !== false && c.effect !== null && c.effect !== undefined && c.effect !== "read") || WRITER_TOOL.test(c.name));
  return reply.length > limit.max && !r.show && !(r.pending_approvals ?? []).length && !wrote && !/```/.test(reply);
}
const WRITER_TOOL = /^(?:draft_\w+|tailor_resume|create_file|open_record_file|attach_document|export_tracker|save_resume_persona|use_resume_persona|set_resume_contact)$/;
const BOUNDARY = /\b(?:nothing|not|never|haven'?t|hasn'?t|didn'?t|wasn'?t|isn'?t|won'?t|no one|nobody)\b[^.!?\n]{0,60}\b(?:sent|submitted|applied|queued|contacted|messaged|emailed)\b|\b(?:sent|submitted|applied)\b[^.!?\n]{0,20}\b(?:nothing|nowhere)\b/i;
const CAVEAT = /\b(?:not (?:verified|confirmed|guaranteed|listed|on file)|unverified|unconfirmed|(?:i )?(?:don'?t|do not|can'?t|cannot|couldn'?t) (?:have|verify|confirm|check|tell|find)|no verified)\b/i;
const NUMBER = /\$?\d[\d,.]*(?:k|%)?/gi, LINK = /https?:\/\/\S+/g;
// D-070 (live-7 C11, C15: a numbered list's markers "1." to "5." counted as figures the shorter text had to keep, so a faithful
// shortening that wrote the list as sentences was always refused): a list marker at the start of a line is not a figure.
const figureText = (t: string) => String(t ?? "").replace(/^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+/gm, "");
// The condensed text, or null when it fails a guard (then the long reply stands): shorter, not empty, every number and link in
// it was in the long reply, at most one question.
export function condensedOk(long: string, short: string, limit: { max: number }): boolean {
  const s = String(short ?? "").trim();
  if (!s || s.length >= long.length || s.length > limit.max) return false;
  const nums = new Set((figureText(long).match(NUMBER) ?? []).map((x) => x.replace(/[,.]$/, "")));
  if ((figureText(s).match(NUMBER) ?? []).some((x) => !nums.has(x.replace(/[,.]$/, "")))) return false;
  const links = new Set(long.match(LINK) ?? []);
  if ((s.match(LINK) ?? []).some((x) => !links.has(x))) return false;
  // MIRROR WA-1 gaps: what was not done and what is not known survive the shortening: a boundary ("nothing was sent", "not
  // submitted") and a caveat ("not verified", "not confirmed", "I don't have") in the long reply must be in the short one.
  for (const keep of [BOUNDARY, CAVEAT]) if (keep.test(long) && !keep.test(s)) return false;
  return (s.match(/\?/g) ?? []).length <= 1;
}
// D-065: the stricter acceptance of the length pass: the condenser's guards (no new figure or link, the boundary and the caveat
// kept, at most one question), plus every link, figure and [placeholder] of the long text kept, and the text within the bound.
const PLACEHOLDERS = /\[[^\]\n]{1,40}\]/g;
export function shortenedOk(long: string, short: string, bound: number): boolean {
  const s = String(short ?? "").trim();
  if (!condensedOk(long, s, { max: Number.POSITIVE_INFINITY }) || textLength(s) > bound) return false;
  if ((long.match(LINK) ?? []).some((x) => !s.includes(x))) return false;
  // Facts kept: every figure of the long text is still in the short one (a shortening drops words, never a fact's number).
  const nums = new Set((figureText(s).match(NUMBER) ?? []).map((x) => x.replace(/[,.]$/, "")));
  if ((figureText(long).replace(LINK, " ").match(NUMBER) ?? []).some((x) => !nums.has(x.replace(/[,.]$/, "")))) return false;
  if (!(long.match(PLACEHOLDERS) ?? []).every((x) => s.includes(x))) return false;
  // D-067 (live-6 C5f2: the condenser answered "It looks like there was no text to rewrite ... please paste it", and that reached
  // the person in place of a code review): the shorter text must be a rewrite of THIS reply. It says nothing about the rewriting
  // itself, nearly every content word of it is the long reply's, and it keeps a real share of the long reply's content.
  return sameContent(long, s);
}
// D-067: the words of a text that carry its content (4+ letters, not filler), lower-cased, by their first five letters ("refer",
// "referral"), so a rewording of the same words still counts as the same content.
const FILLER_WORDS = new Set(["that", "this", "with", "from", "have", "your", "about", "what", "when", "will", "would", "could", "should", "there", "their", "them", "they", "then", "than", "into", "just", "also", "only", "some", "more", "most", "very", "like", "were", "been", "being", "does", "dont", "here", "want", "which", "while", "each", "both", "make"]);
const wordsOf = (t: string) => new Set((String(t ?? "").replace(LINK, " ").toLowerCase().match(/[a-z][a-z'’]{3,}/g) ?? []).map((w) => w.replace(/['’]s$/, "").replace(/s$/, "")).filter((w) => w.length >= 4 && !FILLER_WORDS.has(w)).map((w) => w.slice(0, 5)));
// A condenser's words about the job instead of the reply ("no text to rewrite", "paste the message", "here's a shorter version").
export const META_REWRITE = /\b(?:(?:no|any) (?:text|message) (?:to|for me to) (?:rewrite|shorten|condense)|nothing to (?:rewrite|shorten|condense)|(?:paste|share|send) (?:it|the (?:text|message)|me the (?:text|message))(?: here)?\b[^.?!]{0,40}\b(?:rewrite|shape|shorten)|career assistant'?s (?:message|text|reply)|(?:here(?:'s| is)|below is) (?:a |the |your )?(?:shorter|shortened|rewritten|condensed|text-?style) (?:version|text|message|reply)|i (?:can(?:'|no)?t|cannot|won'?t) (?:rewrite|shorten|condense)|as an ai\b)/i;
export function sameContent(long: string, short: string): boolean {
  if (META_REWRITE.test(short) && !META_REWRITE.test(long)) return false;
  const L = wordsOf(long), S = wordsOf(short);
  if (!S.size || !L.size) return !S.size && !L.size;
  const shared = [...S].filter((w) => L.has(w)).length;
  return shared / S.size >= 0.6 && shared / L.size >= 0.2;
}
// D-067 (G12): a practice session's code review carries code (the person's function, the fix): the shortener never touches it.
const CODE_IN = /```|`[^`\n]{2,}`|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|=>|\breturn\s+[^.\n]*[([{=]|\bnext\(|\blambda\b|\w+\(\s*\w*\s*\)\s*[:{]|\bO\(\s*(?:1|n|n\^?2|log ?n|n log ?n)\s*\)/i;
export function carriesCode(text: string): boolean { return CODE_IN.test(String(text ?? "")); }
// D-072 (item 11): the code a practice reply names, kept verbatim by its shortening: inline code, a call or an index ("next(",
// "counts["), an identifier with an underscore, an operator, a complexity ("O(n)").
const CODE_TOKEN = /`[^`\n]+`|\b[A-Za-z_][\w.]*[([]|\b[A-Za-z]+_[\w]+\b|==|!=|<=|>=|=>|\+=|-=|\bO\([^)\n]{1,20}\)/g;
export function codeKept(long: string, short: string): boolean {
  const s = String(short ?? "");
  return [...new Set(String(long ?? "").replace(LINK, " ").match(CODE_TOKEN) ?? [])].every((t) => s.includes(t));
}
// D-070: what the length pass did on a turn (recorded in the turn's meta, and by the mirror runner in its trace).
// D-071: "shorter" = a faithful shorter text was used though it is still over the bound; `passes` = how many shortening calls ran.
export interface Shorten { ran: boolean; outcome: "not_run" | "within" | "skipped" | "accepted" | "shorter" | "rejected"; why: string; chars?: number; bound?: number; after?: number; passes?: number }
// A turn's writes were only the File and resume makers (whose reply describes what was made).
const FILE_MAKERS = new Set(["tailor_resume", "export_tracker", "create_file", FAMILY_FILE_TOOL]);
export function onlyFileWrites(r: Pick<TurnResult, "reply" | "show" | "pending_approvals"> & { tool_calls?: TurnResult["tool_calls"] }): boolean {
  const reply = String(r.reply ?? "");
  const writes = (r.tool_calls ?? []).filter((c) => (c.ok !== false && c.effect !== null && c.effect !== undefined && c.effect !== "read") || WRITER_TOOL.test(c.name));
  return writes.length > 0 && writes.every((c) => FILE_MAKERS.has(c.name)) && !r.show && !(r.pending_approvals ?? []).length && !/```/.test(reply);
}
export const FILE_TURN_CONDENSE = "This reply describes a file or resume that was just made (the file holds the detail). Say what was made first; then the changes in ONE line; then what must be settled before it is sent, in one short sentence naming each item.";
// D-073: what the length pass must keep, said to it up front: every figure (list markers and links apart), every [placeholder], and
// each sentence that says what was not done, sent or verified, or what is not known (BOUNDARY, CAVEAT). The guards still check it.
export function keepList(long: string): string {
  const figs = [...new Set((figureText(long).replace(LINK, " ").match(NUMBER) ?? []).map((x) => x.replace(/[,.]$/, "")))];
  const marks = [...new Set(long.match(PLACEHOLDERS) ?? [])];
  const said = [...new Set(String(long).replace(LINK, " ").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x && (BOUNDARY.test(x) || CAVEAT.test(x))))].slice(0, 4);
  const parts = [figs.length ? `every one of these figures, exactly as written: ${figs.join(", ")}` : "", marks.length ? `these placeholders: ${marks.join(", ")}` : "",
    said.length ? `what each of these says (shorter wording is fine; keep the words that say it was not done or is not known): ${said.map((x) => `"${x}"`).join(" ")}` : ""].filter(Boolean);
  return parts.length ? `It must keep ${parts.join("; and ")}.` : "";
}
// D-073: the length the pass is to reach, as a number (the kind's upper end); the second pass is told how far the first one fell short.
export function lengthTarget(now: number, upper: number, pass: number): string {
  return `The whole message must be at most ${upper} characters, links apart. It is ${now} now${pass > 1 ? `, still over after one pass: cut at least ${Math.max(0, now - upper)} more characters by dropping whole sentences that add least` : ""}.`;
}
// Why the shorter text was refused, in the guard's own terms (for the trace).
export function shortenRejection(long: string, short: string, bound: number): string {
  const s = String(short ?? "").trim();
  if (!s) return "the condenser returned nothing";
  if (textLength(s) > bound) return `still over the bound (${textLength(s)} > ${bound})`;
  if (s.length >= long.length) return "not shorter";
  const nums = new Set((figureText(s).match(NUMBER) ?? []).map((x) => x.replace(/[,.]$/, "")));
  const lost = (figureText(long).replace(LINK, " ").match(NUMBER) ?? []).filter((x) => !nums.has(x.replace(/[,.]$/, "")));
  if (lost.length) return `a figure was dropped (${[...new Set(lost)].slice(0, 3).join(", ")})`;
  const added = (figureText(s).match(NUMBER) ?? []).filter((x) => !new Set((figureText(long).match(NUMBER) ?? []).map((y) => y.replace(/[,.]$/, ""))).has(x.replace(/[,.]$/, "")));
  if (added.length) return `a new figure (${added.slice(0, 3).join(", ")})`;
  if ((long.match(LINK) ?? []).some((x) => !s.includes(x))) return "a link was dropped";
  if (!(long.match(PLACEHOLDERS) ?? []).every((x) => s.includes(x))) return "a placeholder was dropped";
  for (const [k, re] of [["boundary", BOUNDARY], ["caveat", CAVEAT]] as const) if (re.test(long) && !re.test(s)) return `the ${k} was dropped`;
  if ((s.match(/\?/g) ?? []).length > 1) return "more than one question";
  if (!sameContent(long, s)) return "not a rewrite of the reply";
  return "refused by the guards";
}
export async function condenseReply(model: ModelFn, long: string, limit: { max: number; aim: string }, ok: (long: string, short: string) => boolean = (a, b) => condensedOk(a, b, limit), extra = "", seen?: { out: string }): Promise<string | null> {
  try {
    const res = await model({
      system: `Rewrite this text message from a career assistant so it reads like a text: ${limit.aim}, plain sentences, at most two short paragraphs. ` +
        "Keep the direct answer first. Keep every name, figure, date and link exactly as written, and every statement of what was not done, not sent, not saved or not verified. " +
        "A draft message the person can copy stays a draft they can copy: shorten it if it is long and keep its [brackets]. " +
        "Drop numbered or bulleted lists (write sentences), headings, repeated points and advice they did not ask for. Add nothing that is not in the text. At most one question, at the end. Output the message only." + (extra ? ` ${extra}` : ""),
      messages: [{ role: "user", content: [{ type: "text", text: long }] }], tools: [], max_tokens: 600, tool_choice: { type: "none" },
    } as any);
    const out = ((res as any)?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
    if (seen) seen.out = out;
    return ok(long, out) ? out : null;
  } catch { return null; }
}
