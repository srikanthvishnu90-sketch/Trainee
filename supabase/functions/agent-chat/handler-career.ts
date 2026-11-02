// Upmore agent-chat edge function — CAREER-ONLY entry handler.
//
// Owner decision 2026-10-15: "Prune the shelved finance half from the
// bundle, re-measure, then deploy" / "yes, or even remove the finance
// portion entirely." The deployed agent-chat artifact therefore contains
// ZERO finance code: this handler's static import graph reaches only the
// career chain (120 access → 130 onboarding → 142 router → 141 doorstep,
// inside 143 containment, through _shared/career_host.js) plus the small
// shared leaves the career path uses (CORS, chat input, thread ownership,
// identity redaction) and the career-only bundle
// (_shared/router_core.career.js, built by
// scripts/build-router-core.py --career-only).
//
// The finance pipeline remains in the repo, shelved behind PRODUCT_MODE in
// agent-chat/handler.ts (pivot mechanics: shelved, not deleted — tag
// finance-final); it is simply not part of this deployed artifact anymore.
//
// Behavior contract: every line below that a career turn can reach is
// copied verbatim from handler.ts (auth, bridge override, profile upsert,
// rate limiting, input parsing, thread ownership, the PRODUCT_MODE career
// branch, the redaction-note prefix). The only handler.ts machinery not
// carried over is the model-cost meter block in the wrapper. Career turns do
// call the model (the brain, drafts, the search judge), so since 2026-10-28
// every turn here leaves an agent_turn_costs row through turnLedger
// (_shared/model_gateway.ts): the calls it made, zero when it made none, or
// "unrecorded" when the sink failed. A missing row is never a zero.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { looksLikePendingSecret, redactionNote, redactPending, secretLeadIn } from "../_shared/identity_redact.ts";
import { corsFor } from "./_shared/chat_cors.ts";
import { chatInput } from "./_shared/chat_input.ts";
import { ownerThread, ChatThreadError } from "./_shared/chat_session.ts";
import { CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment, CareerBatchApply, CareerJobs, CareerProfile } from "../_shared/router_core.career.js";
import { planCareerTaskIntent, normalizeCareerTaskRequest, createCareerBoardFor, createWorkerBoardProvider, planCareerBatchIntent, planCareerBatchPrepare, normalizeCareerBatchRequest } from "../_shared/career_task_bridge.js";
import { CareerHost } from "../_shared/career_host.js";
import { CareerPool } from "../_shared/career_pool.js";
import { createCareerPersistence, careerRequestHash } from "../_shared/career_persistence.js";
import { callModel as callModelUncapped, modelConfig, newMeter, turnLedger } from "../_shared/model_gateway.ts";
// LAUNCH READINESS (2026-10-26): the daily model ceiling, the per-person turn order, the pool read only when used.
import { spendCap, spendLimitsFromEnv, supabaseDailySpend } from "../_shared/career_spend_cap.ts";
import { enterTurnGate, type TurnGate } from "../_shared/career_turn_gate.ts";
import { CONFLICT_CODES, CONFLICT_REPLY, countSend, newTurnEffects, refusedSaveReply, trackTurnEffects } from "../_shared/career_save_replies.ts";
import { poolNeeded } from "./career_pool_need.ts";
import { linkChecker } from "../_shared/link_check.ts";
import { knowledgeOn } from "../_shared/agent/knowledge/index.ts";
import { fileKindPublisher } from "../_shared/agent/research/file_publisher.ts";
import { modelDerive } from "../_shared/agent/research/derive.ts";
import { memoryGroundCache, openAiGroundSearch } from "../_shared/agent/research/ground.ts";
import { DEFAULT_SEARCH_MODEL } from "../_shared/career_people_provider.ts";
const researchCache = memoryGroundCache();
import { AGENT_BRAIN_RELEASED, chooseBrain, agentTurn, HISTORY_WINDOW, historyWindow, summaryFor } from "./career_brain.ts";
import { STAGED_TOOL_POLICY, stagedRoute } from "./career_staged.ts";
import { supabaseEventStore } from "../_shared/agent/timeline.ts";
import { CARD_ANSWER_INTENT, CARD_INTENT, cardTurn, cardWaiting, supabaseCardStore } from "../_shared/career_apply_cards.ts";
import { billingTurn, PAY_BY_CHECKOUT, stripeFromEnv, supabaseBillingStore } from "../_shared/career_billing.ts";
import { mockTurn, supabaseMockStore as supabaseMockStoreUncapped } from "../_shared/career_mock.ts";
import { hiredSourceFromEnv } from "../_shared/career_hired.ts";
import { QUESTIONS_INTENT, questionsTurn, supabaseQuestionStore } from "../_shared/career_apply_questions.ts";
import { applicationsTurn, supabaseApplications } from "../_shared/career_apply_status.ts";
import { emailStatusAsk, outreachStatusTurn } from "../_shared/career_send_rail.ts"; // "where are my emails"
import { standingTurn, supabaseStanding } from "../_shared/career_standing.ts";
// FEATURE 14: receipts
import { receiptTurn, supabaseReceipts } from "../_shared/career_apply_receipt_read.ts";
import { chatScreenFacts } from "../_shared/career_apply_gate.ts";
import { screenAnswerTurn, screenMeta, screenTapTurn, TAP_INTENT, TAP_STALE_REPLY } from "../_shared/career_apply_screen_answer.ts";
import { APPLY_QUEUE_INTENT, applyTurn, EMPLOYER_ANSWER_INTENT, EMPLOYER_ASK_INTENT, employerAnswerTurn, paceReader, paceTurn, supabaseEmployerAskStore } from "../_shared/career_apply_chat.ts";
import { confirmNotRecordedReply, correctionNotRecordedReply, type EvidenceResult, evidenceEntryCorrections, evidenceResumeConfirmation, heldEvents, heldReply, resumeConfirmationContext } from "../_shared/career_router_evidence.ts";
// FEATURE 9: account memory (stated-fact provenance, standing needs on the router path).
import { accountMemoryAfterTurn, accountMemoryOn, statedFactsBefore } from "../_shared/career_account_memory.ts";
import { cloudTurn, supabaseCloudOptinStore } from "../_shared/career_cloud_optin.ts";
import { CLOUD_CARD_INTENT, cloudCardYesTurn, personCloudCardStore } from "../_shared/career_cloud_card_chat.ts";
import { boardFetchFeed, supabasePostingsDb, searchWords } from "../_shared/career_ingest.ts"; // FEATURE E2E: boardFetchFeed
import { supabaseAlertStore } from "../_shared/career_alert_store.ts";
import { syncWatchAlerts } from "../_shared/career_watch_alerts.ts";
import { supabaseWantStore } from "../_shared/career_apply_want.ts";
import { feature1Deps, resumeOnFileReader } from "../_shared/career_apply_from_chat.ts"; // FEATURE 1; FEATURE 16: resumeOnFileReader
import { cancelTurn, prepareAfterAnswers, withPending } from "../_shared/career_hosted_prepare.ts"; // FEATURE 17
import { supabaseUndoStore, undoTurn } from "../_shared/career_undo.ts"; // C21/C22: "undo" / "cancel that"
import { statusAsk } from "../_shared/career_apply_status.ts"; // FEATURE 17
import { supabaseMemoryStore } from "../_shared/agent/memory.ts";
import { codePending, readSituation } from "../_shared/career_situation.ts";
import { statusRecordsFrom } from "../_shared/career_capabilities.ts";
import { edgeRenderer, supabasePersonaStore, supabaseResumeStore } from "../_shared/career_tailor.ts";
import { supabaseMailStore } from "../_shared/career_mail_store.ts";
import { CONFIRM_INTENT, confirmWhichTurn, supabaseConfirmStore } from "../_shared/career_apply_confirm.ts";
import { EMAIL_INTENT, emailTurn, supabaseEmailStore, supabaseResumes } from "../_shared/career_apply_email.ts";
import { CAREER_SEND_SCOPE, careerTokenFor, sendMail } from "../_shared/career_mail_gmail.ts";
import { supabaseDigestStore, supabaseInterviewStore } from "../_shared/career_brief_store.ts";
import { draftFor, outreachTurn, supabaseOutreachStore } from "../_shared/career_outreach.ts";
import { queueApprovedOutreach, sendRailOn } from "../_shared/career_send_rail.ts"; // MASS NETWORKING M1
import { repliesTurn, supabaseRepliesStore } from "../_shared/career_outreach_replies.ts"; // MASS NETWORKING M5
import { hunterVerifier, supabaseCheckCache } from "../_shared/career_contacts.ts";
import { GMAIL_SEND_SCOPE } from "../_shared/career_outreach_gmail.ts";
import { missingIntegration } from "../_shared/agent/integrations.ts";
import { documentsOf, materializeArtifacts } from "../_shared/channel_artifacts.ts";
import { askFor, judgePromptTurn, searchJudgeTurn, supabaseJudgeCache, supabaseSearchSources } from "../_shared/career_search_judge.ts"; // FEATURE 5
import { offerChatTurn } from "../_shared/career_offer_chat.ts"; // FEATURE 12
import { connectorAsk, connectorChatTurn, connectorFailure } from "../_shared/connectors.ts"; // Task 3 (FEATURE GV's disconnect included)
import { networkingTurn, siteRefusedTurn } from "../_shared/career_networking.ts"; // FEATURE 10
import { plannerOn, plannerTurn, type PlannerTurn } from "./career_planner.ts"; // TASK PLANNER
import { careerTools } from "../_shared/agent/career_tools.ts"; // TASK PLANNER: track_application, remember_instruction
import { supabaseReminderStore as supabaseTaskReminderStore } from "../_shared/task/reminders.ts"; // TASK PLANNER
import { CAREER_READ_SCOPE as PEOPLE_READ_SCOPE, supabasePeopleDeps } from "../_shared/career_people.ts"; // D-033
import { CareerWriting } from "../_shared/router_core.career.js"; // FEATURE 4
import { rewriteOn, tailorRewriteTurn } from "../_shared/career_tailor_rewrite.ts"; // FEATURE 4
// FEATURE 8: inbox check and follow-ups that can be sent.
import { careerGrant, followupTurn, gmailReadNow, mailNow, supabaseFollowupStores } from "../_shared/career_inbox_followups.ts";
import { gmailSender } from "../_shared/career_outreach_gmail.ts";
import { fileUploadFor } from "../_shared/channel_resume_upload.ts"; // FEATURE 16
import { outlookAsk, outlookChatTurn } from "../_shared/outlook_connector.ts"; // M4: Outlook
import { chunkSentences, PAGE_CHUNK_CHARS, PAGE_MAX_CHUNKS, shapeForTurn, splitLongAnswer, withoutLinks } from "../_shared/channel_shape.ts"; // REPLY SHAPE
import { applyHereTurn } from "../_shared/apply_here.ts"; // APPLY HERE: a pasted link or "apply to this" -> one line + one Apply button
import { supabaseFileStore } from "../trainee-file/store.ts";
import { createFileService, supabaseFileKindStore } from "../_shared/file_service.ts"; // FILE KINDS
import { factsForTurn, replyWriterOn, writable, writeReply, writerChannel } from "../_shared/career_reply_writer.ts"; // V1 TEXTING VOICE
import { vaultRefreshWrite } from "../_shared/oauth_vault_refresh.ts";
import { reminderTurn, supabaseReminderStore } from "../_shared/career_reminders.ts"; // REQS DOC 2: reminders
import { overviewTurn } from "../_shared/career_overview.ts"; // REQS DOC 2: "any update?", "what's waiting on me?"

// WO-033: whether the person's career Google grant carries a scope (gmail.send for outreach). Read failures say "no".
async function careerGrantHas(admin: any, userId: string, scope: string): Promise<boolean> {
  const { data, error } = await admin.from("user_oauth_connections").select("scopes").eq("user_id", userId).eq("provider", "google_career").maybeSingle();
  if (error || !data) return false;
  const scopes = Array.isArray(data.scopes) ? data.scopes : String(data.scopes ?? "").split(/[\s,]+/);
  return scopes.includes(scope);
}

// WO-106 (F5): the reply to a batch ask the router would have "handed to the browser worker": what happened, nothing more.
// LAUNCH READINESS (2026-10-26): what a person reads when their turn could not be saved, in plain words. A conflict (a
// second message, or an erase, changed the conversation while this one was answered) saves nothing; an unconfirmed save
// may or may not have landed. Anything that goes to an employer or a contact still needs their approval of exactly it.
export { CONFLICT_REPLY, refusedSaveReply };

export const UNSAVED_REPLY = "I couldn't confirm this reply was saved. Send your message again; nothing goes to an employer or a contact until you approve exactly what is sent.";
export const BATCH_NOT_STARTED_REPLY = "I haven't started that batch: nothing was searched, prepared or sent. Applying runs in the Trainee extension in your browser, one posting at a time, and it shows you each filled application before anything is sent. Tell me the role and city, and I'll find live postings you can pick from.";
const MAX_MESSAGE_LEN = 4000; // M2: cap input size (same cap as handler.ts)

type TurnCtx = { note: string | null; user: string | null; thread: string | null };
// Host routes and task/batch planners share this existing JSON reply boundary.
type CareerTurnResult = {
  intent: string; reply: string; handler?: string | null; resultStatus?: string;
  contained?: boolean; capabilities?: unknown; action?: unknown;
  result?: Record<string, unknown>; task?: unknown; batch?: unknown;
  // WO-038: the reply as separate messages (an outreach batch), each delivered whole; `reply` stays the joined text.
  parts?: string[];
};

export async function handleChat(req: Request): Promise<Response> {
  const ctx: TurnCtx = { note: null, user: null, thread: null };
  const res = await handleChatInner(req, ctx);
  if (!ctx.note || res.status !== 200) return res;
  try {
    const body = await res.clone().json();
    if (!body || typeof body.reply !== "string") return res;
    body.reply = `${ctx.note} ${body.reply}`;
    const headers = new Headers(res.headers); headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch { return res; }
}

async function handleChatInner(req: Request, flowCtx: TurnCtx): Promise<Response> {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const authM = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!authM) return json(cors, { error: "unauthorized" }, 401);
    // Read the body once up front: the bridge override below needs as_user_id
    // and the main flow needs thread_id/message/images.
    const body = await req.json().catch(() => ({}));

    // Service-role path (texting channel, WO-013b-2): when the bearer token is
    // EXACTLY the service_role key, our own backend (trainee-inbound) runs the
    // turn as the person a texting contact belongs to via `as_user_id`. The
    // normal user-JWT path below is completely unchanged.
    // The key itself is never logged.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isBridgeCall = serviceKey !== "" && authM[1] === serviceKey;
    const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let bridgeUserId: string | null = null;
    if (isBridgeCall) {
      const raw = typeof body.as_user_id === "string" ? body.as_user_id : "";
      if (!UUID_RX.test(raw)) return json(cors, { error: "as_user_id must be a valid UUID" }, 400);
      bridgeUserId = raw;
    }

    // The gateway already verified the JWT signature (verify_jwt=true). Extract
    // the user token and pass it EXPLICITLY: auth.getUser() with no argument
    // reads the client session, which does not exist in an edge function, so it
    // would always return null and every signed-in user would get a 401.
    let supabase: any;
    let user: { id: string; email?: string | null };
    if (bridgeUserId) {
      // Bridge path: service_role client (bypasses RLS); every query below is
      // still explicitly scoped with .eq("user_id", user.id).
      supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
      user = { id: bridgeUserId };
    } else {
      supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user: u } } = await supabase.auth.getUser(authM[1]);
      if (!u) return json(cors, { error: "unauthorized" }, 401);
      user = u;
    }

    // The rate limiter FKs to profiles — make sure a profile row exists first
    // (the app upserts on sign-in, but API/test callers may not). Without this
    // a missing profile would make the RPC error and look like rate limiting.
    const profileWrite = await supabase.from("profiles").upsert({ id: user.id }, { onConflict: "id" });
    if (profileWrite.error) throw new Error("Account profile unavailable.");

    // Rate limiting: 60 chat requests per fixed 60-minute window per user,
    // enforced on EVERY request (deterministic capabilities included) via
    // the agent_rl_bump RPC — atomic row-locked increment so concurrent
    // requests can't double-spend. A false return is a real 429 (with
    // Retry-After); an RPC *error* is a 500, never a fake "slow down".
    // Bridge path: the hardened agent_rl_bump derives the user from
    // auth.uid(), which is null for service_role callers, so it would always
    // 429. agent_rl_bump_as takes the user explicitly and is executable ONLY
    // by service_role (our own backend) — same window math, same limit.
    const rlFn = bridgeUserId ? "agent_rl_bump_as" : "agent_rl_bump";
    const RATE_LIMIT = 60;
    const { data: rlOk, error: rlErr } = await supabase.rpc(rlFn, { p_user: user.id, p_limit: RATE_LIMIT });
    if (rlErr) {
      console.error("agent_rl_bump failed:", rlErr.message);
      return json(cors, { error: "internal" }, 500);
    }
    if (!rlOk) {
      return new Response(
        JSON.stringify({ error: "rate_limited", message: "Slow down a little — try again in a bit." }),
        { status: 429, headers: { ...cors, "content-type": "application/json", "Retry-After": "3600" } }
      );
    }

    const { thread_id, message: rawMessage, images } = body as { thread_id?: unknown; message?: unknown; images?: unknown };
    // A refused save must say what the turn already did (_shared/career_save_replies.ts): the service client records
    // the turn's writes, the database's answer to a card yes, and each send, from the turn gate to the commit.
    const turnEffects = newTurnEffects();
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { global: { fetch: trackTurnEffects(turnEffects) } });
    // WO-100: the person's situation (every task in flight, the next steps, what Trainee can do), read once per turn,
    // before anything answers; a source that fails is named in it, never guessed. A code an employer emailed them, while
    // waiting, is removed from this text like a labeled one.
    const situation = await readSituation(admin, user.id, Date.now()).catch((e) => { console.error("situation:", e?.message ?? e); return null; });
    // Text, photos, or both (a photo alone is a message: spec 16 item 12).
    const input = chatInput(rawMessage, images, MAX_MESSAGE_LEN, { codePending: codePending(situation) });
    if (!input.ok) return json(cors, { error: input.error }, 400);
    let { message, userContent } = input;
    const { imageBlocks } = input;
    flowCtx.note = redactionNote(input.redacted);
    // Card or bank details in chat (battery 2026-10-30): removed above, never stored; the person is told where paying goes.
    if (flowCtx.note && input.redacted.some((r: string) => r === "card" || r === "account")) flowCtx.note = `${flowCtx.note} ${PAY_BY_CHECKOUT}`;
    // L4: thread_id must be a string when provided (non-string truthy values
    // would otherwise cause a DB error → noisy 500).
    if (thread_id !== undefined && thread_id !== null && typeof thread_id !== "string")
      return json(cors, { error: "thread_id must be a string" }, 400);

    const turnKey = body.turn_key == null ? crypto.randomUUID() : body.turn_key;
    if (typeof turnKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(turnKey)) return json(cors, { error: "invalid_turn_key" }, 400);

    // Scope both JWT and service-role bridge histories to the verified owner.
    let tid: string;
    try { tid = await ownerThread(supabase, user.id, thread_id, message); }
    catch (error) {
      if (error instanceof ChatThreadError) return json(cors, { error: error.code }, error.status);
      throw error;
    }
    flowCtx.user = user.id; flowCtx.thread = tid;
    // ADVERSARIAL ROUND 2 (2026-10-30): the second half of a split secret. When this thread's previous message ended on a
    // password or code label ("my workday password is"), this message's lone value is that secret: removed before anything
    // stores it or a model reads it, and the person is told (identity_redact.ts secretLeadIn / redactPending). Read only
    // for a message shaped like a lone value, in a thread the person owns (ownerThread, above).
    if (thread_id && !imageBlocks.length && (looksLikePendingSecret(message, "password") || looksLikePendingSecret(message, "code"))) {
      const prev = await admin.from("agent_messages").select("content").eq("thread_id", tid).eq("role", "user").order("id", { ascending: false }).limit(1);
      if (prev.error) console.error("split secret check: previous message unreadable:", prev.error.message);
      const lead = secretLeadIn(String(prev.data?.[0]?.content ?? ""));
      const red = lead ? redactPending(message, lead) : null;
      if (red) {
        message = red.text; userContent = red.text;
        flowCtx.note = redactionNote([...new Set([...input.redacted, ...red.removed])]);
      }
    }

    // GO-LIVE FLIP (2026-10-13, owner ruling: "the career version is the
    // final switch" — the money version is gone from live). Career is the
    // product served here. Career turns run the bundled chain in harness
    // order (120 access → 130 onboarding → 142 router → 141 doorstep)
    // inside 143 containment, through _shared/career_host.js — the same
    // dispatch the gauntlet grades (tests/career-http-host.test.cjs).
    // Per-thread career state rides agent_flow_state.state under the
    // "career" key, mirroring the flow router's own use of that table.
    // J8 + J9 (LOOP ACCEPTANCE): module 155's drive stage takes its
    // board adapter from ctx.batchDeps.boardFor, which the host
    // supplies from this composition root. Resolution lives in
    // career_task_bridge: createCareerBoardFor validates a provider's
    // boards against module 149's contract and converts every failure
    // mode to null — the named BOARD_NOT_WIRED stop; no board is ever
    // faked.
    // J9 installs the real provider at this call site:
    // createWorkerBoardProvider, bound to THIS request's authenticated
    // user, gated on the worker's env (UPMORE_CAREER_WORKER_URL +
    // UPMORE_CAREER_WORKER_SECRET). Behind it, the owned browser
    // worker's board service (workers/career-browser/board-service.cjs)
    // vends live module-150 board sessions. The provider needs a
    // SYNCHRONOUS transport — the drive stack (155/149/150) is
    // synchronous end to end — and this Edge runtime has none today
    // (Node composition roots inject workers/career-browser/
    // board-transport.cjs), so the factory resolves null here with or
    // without env present: the seam stays wired, the stop stays
    // honest, and no WIRED claim is made for a path that cannot vend.
    // J10 (the deployed-runtime transport, design of record in the
    // loop joins doc): the batch loop does not wait for a synchronous
    // transport in this runtime — it DELEGATES. When the worker env
    // is present, the host is built with delegateBatch and the router
    // seam hands each batch ask to the owned browser worker as a
    // committed career_batch_intent/v1 (prepare -> the worker runs
    // module 155 in its own process -> the prepared run reads back
    // through the structured career_batch status request -> the yes
    // commits an approve intent -> the worker executes). No browser
    // effect happens in a chat turn; the in-turn provider above is
    // unchanged (still null-resolving here), so the single-application
    // doorstep paths keep their exact J8/J9 behavior.
    const workerUrl = Deno.env.get("UPMORE_CAREER_WORKER_URL") ?? "";
    const workerSecret = Deno.env.get("UPMORE_CAREER_WORKER_SECRET") ?? "";
    const boardFor = createCareerBoardFor(createWorkerBoardProvider({ workerUrl, secret: workerSecret, userId: user.id }));
    const delegateBatch = workerUrl !== "" && workerSecret !== "";
    // WO-106 (F5): set only where a batch executor runs and drains career_batch_intent; unset, a batch ask is never "handed".
    const batchExecutorLive = Deno.env.get("CAREER_BATCH_EXECUTOR") === "on";
    const host = CareerHost.createCareerHost({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment, boardFor, delegateBatch });
    let careerTask;
    try { careerTask = normalizeCareerTaskRequest(body.career_task); }
    catch (_) { return json(cors, { error: "invalid_career_task", action: null, turn_key: turnKey }, 400); }
    let careerBatch;
    try { careerBatch = normalizeCareerBatchRequest(body.career_batch); }
    catch (_) { return json(cors, { error: "invalid_career_batch", action: null, turn_key: turnKey }, 400); }
    const requestHash = await careerRequestHash(rawMessage, imageBlocks, careerTask ?? (careerBatch ? { batch: careerBatch } : null));
    const persistence = createCareerPersistence(admin);
    // POOL LOADER (Lane E, Feature Depth Program v2 — closes the gap
    // diagnosed in the Lane D operator checklist §8): ctx.postings is
    // the discovery pool, a per-turn host input. Until this wiring
    // the handler never passed it, so the host defaulted the pool to
    // [] for every user on every turn and discovery answered its
    // honest-empty reply forever ("today it holds no roles at all")
    // while career_kb_postings held 21,688 real postings one read
    // away. The loader (_shared/career_pool.js) reads the KB through
    // this request's service-role client — bounded, recency-ordered,
    // mapped to the corpus shape 142 consumes, every posting
    // carrying its snapshot fetched_on (the KB is an Oct 2026
    // snapshot, not a live feed; freshness of content is the watcher
    // lane's remainder, never implied here). The loader never
    // throws: a failed read degrades to the empty pool and the
    // product's designed honest-empty reply — never a crashed turn,
    // never an invented role. The worker's postingsFor reads through
    // the same loader, so the two pools cannot disagree.
    // LAUNCH READINESS X7: every model call this turn makes goes through the person's daily ceiling
    // (_shared/career_spend_cap.ts); over it, the call is refused before any request and the reply says so. The name
    // callModel is shadowed here on purpose, so no call site below can reach the gateway around the ceiling.
    const spend = spendCap({ read: supabaseDailySpend(admin, user.id), limits: spendLimitsFromEnv(Deno.env), call: callModelUncapped });
    const callModel = spend.call;
    // 2026-10-28: this turn's cost row, always (see turnLedger): calls made, zero, or unrecorded. Written in finally, below.
    const ledger = turnLedger(admin, user.id, tid);
    // The mock-interview judge's model call goes through the same ceiling (shadowed like callModel).
    // F09: a screen Yes / No tap (body.screen_tap) is never an answer to a mock question: with a tap the mock sees no question as the last word.
    const supabaseMockStore = (a: any) => {
      const store = supabaseMockStoreUncapped(a, { callModel });
      return body.screen_tap && typeof body.screen_tap === "object" ? { ...store, lastAssistantIntent: async () => null } : store;
    };
    // LAUNCH READINESS R1: this person's turns run one at a time, in arrival order (_shared/career_turn_gate.ts). The
    // ticket is taken before the thread is read and given back after the commit, on every path (finally, below).
    let gate: TurnGate | null = null;
    const poolLoader = CareerPool.createKbPoolLoader({
      readRows: async (spec: any) => {
        let q: any = admin.from(spec.table).select(spec.select)
          .order(spec.order.column, { ascending: spec.order.ascending, nullsFirst: spec.order.nullsFirst });
        for (const f of (spec.filters ?? [])) {
          if (f.op === "ilike") q = q.ilike(f.column, f.value);
          else if (f.op === "eq") q = q.eq(f.column, f.value);
        }
        const { data, error } = await q.limit(spec.limit);
        if (error) throw new Error(`career_kb_postings read failed: ${error.message}`);
        return data ?? [];
      },
      jobs: { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml },
    });
    try {
      gate = await enterTurnGate(admin, user.id, turnKey, { thread: tid });
      const loaded = await persistence.load({ userId: user.id, threadId: tid, turnKey, requestHash });
      turnEffects.on = true;
      if (loaded.replay) { ledger.skip(); flowCtx.note = null; return json(cors, loaded.replay, 200); }
      // LAUNCH READINESS X3: the pool is read only on a turn that reaches the router and whose message the router answers
      // with postings (agent-chat/career_pool_need.ts); ensurePool() below reads it once, then puts it on the turn.
      let postings: any[] = [];
      let poolRead = false;
      // TASK PLANNER: a planned step that the router answers reads the pool for its own words (`text`); a turn the pool is
      // not needed for leaves it unread, so a later step that needs it still reads it once.
      // `message` inside readPool is the text the pool is read for: this turn's message, or a planned step's own words.
      const readPool = async (message: string) => {
        if (poolRead) return;
        if (!poolNeeded({ host, message, ctx: ctx as unknown as Record<string, unknown> }).needed) return;
        poolRead = true;
        const pool = await poolLoader.loadPool();
        if (pool.error) console.error("career pool load failed:", pool.error);
        // V240 LIVE-FIX (probe f2): the window is a discovery slice,
        // not the shelf — when the turn names a specific company/title
        // (the router's OWN parser decides; no second parser lives
        // here), supplement the window with the loader's targeted
        // lookup so a named posting the KB holds beyond the window is
        // findable in-turn. Merged by posting id; the supplement never
        // throws (loader contract), and any failure here leaves the
        // window pool standing on its own — the turn keeps its honest
        // named stop, never a crash, never an invented role.
        postings = pool.postings;
        try {
          const target = typeof (CareerRouter as any).namedRoleTargetOf === "function" ? (CareerRouter as any).namedRoleTargetOf(message, null) : null;
          if (target && target.company) {
            const extra = await poolLoader.loadTargeted(target);
            if (extra.postings.length) {
              const seen = new Set(postings.map((p: any) => p.job_id));
              postings = postings.concat(extra.postings.filter((p: any) => !seen.has(p.job_id)));
            }
          }
        } catch { /* the window pool stands on its own */ }
        (ctx as any).postings = postings;
      };
      const ensurePool = (text: string = message) => readPool(text);
      // MUSE-F-002: the thread's batch, if it has one, read back from the worker's own record so a plain-words status ask
      // answers with its true state. Read only; a failed read leaves the thread's standing state to answer.
      let batchRunRecord: unknown = null;
      const batchRunId = (loaded.snapshot as any)?.stores?.batchApplyState?.id;
      if (typeof batchRunId === "string" && batchRunId) {
        try { batchRunRecord = await persistence.readBatchRun({ userId: user.id, runId: batchRunId }); } catch (e) { console.error("career batch status: run record unreadable", (e as Error)?.message ?? e); }
      }
      // ROOT CAUSE 3: the person's profile and tracker are the account's once they use a texting channel (or already are):
      // read whether a texting contact is linked to them (null when unreadable: per-thread, as before).
      let textingLinked: boolean | null = null;
      try {
        const r: any = await admin.from("channel_contacts").select("contact").eq("user_id", user.id).limit(1);
        textingLinked = r && !r.error && Array.isArray(r.data) ? r.data.length > 0 : null;
      } catch { textingLinked = null; }
      const personMemory = accountMemoryOn(Deno.env, { textingLinked, accountHasMemory: !!(loaded.account as any)?.memory && typeof (loaded.account as any).memory === "object" });
      const ctx = host.createTurnCtx({ userId: user.id, threadId: tid, now: Date.now(), accountPersistence: true, accountMemory: personMemory /* ROOT CAUSE 3 */, snapshot: loaded.snapshot, account: loaded.account, watchState: loaded.watchState, postings: [], batchRunRecord }) as ReturnType<typeof host.createTurnCtx> & {
        _hostPatch?: Record<string, unknown>; batchApplyState?: unknown; statusRecords?: unknown; alertWatchState?: Record<string, unknown>;
      };
      // WO-100: module 120's "what's connected" reads the live grants, the extension and the phone link (no address).
      if (situation) ctx.statusRecords = statusRecordsFrom(situation.capabilities);
      // WO-002 (D-008): the agent brain answers when CAREER_BRAIN=agent; structured task/batch requests stay on the
      // router path. A model failure falls back to the router so an outage never leaves the person with nothing.
      let out: CareerTurnResult;
      let agentMeta: Record<string, unknown> | null = null;
      let turnAttachments: unknown[] = [], turnLinks: string[] | null = null, turnFileLinks: string[] = []; // REPLY SHAPE: what the agent staged; the URLs it may show
      let turnPostings: unknown[] = []; // JOB CARDS: what the turn's search found, for channels that show cards
      const events = supabaseEventStore(admin);
      // RESUME CONFIRM RACE (2026-10-30) / KNOWN GAPS (2026-10-30): every fact_confirmed event this turn makes (the router's
      // resume confirmation, a fact stated in chat, the brain's confirm_profile_fact) is held here and written by this
      // turn's own commit (career_host_commit_evidenced), in the transaction that saves the facts they evidence: a refused
      // save writes none, so no event ever names a confirmation no saved record holds.
      const confirmEvents = heldEvents();
      // WO-022: the card of prepared applications and the one text that answers it are code's, before any brain: "show my
      // applications", and "yes" / "yes but not 2" / "no" / "change 2" while the card is this thread's last word. Account
      // controls stay the host's.
      // SERIAL-1461: the id of the message this text replies to, when the channel passes one (a string or a number). A
      // text yes approves a card only in direct reply to the message that carried it.
      const replyTo = typeof body.reply_to_message_id === "string" || typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : null;
      // F09: a tap on the screen's Yes / No buttons (body.screen_tap = { qid, answer }) is an EXPLICIT answer to that one open question and
      // nothing else. Every other consumer of a text yes / no (the card's yes, an employer question, a link, outreach, billing...) is
      // skipped for it, so a button is never read as a typed word by whichever consumer happens to be waiting.
      const tapRaw = body.screen_tap && typeof body.screen_tap === "object" ? body.screen_tap as Record<string, unknown> : null;
      const tapIn = tapRaw ? { qid: String(tapRaw.qid ?? ""), answer: String(tapRaw.answer ?? "") } : null;
      // M4: Outlook (Microsoft Graph) as a peer of Gmail, from any channel: "connect my outlook" / "use my work email" makes a
      // one-time link bound to this person, channel and thread; "disconnect outlook" deletes the access and what was read
      // from it and cancels its pending sends (_shared/outlook_connector.ts). Code's, before every other turn.
      // Task 3: the connector framework (_shared/connectors.ts), before every other turn: "what's connected" (each connector,
      // its state and use, and what waits on it), "connect gmail" (a one-time link from any channel), "disconnect gmail" /
      // "disconnect outlook" (revoke where possible, erase, cancel pending sends, read back), and a task that needs a
      // connector not connected ("check my outlook"): asked once with the link, parked, resumed by the connect callback.
      const connAns = !tapIn && !careerTask && !careerBatch && connectorAsk(message)
        ? await connectorChatTurn({ admin, env: Deno.env, fetch, now: Date.now, message, userId: user.id, threadId: tid, bridge: isBridgeCall })
          .catch((e) => { console.error("connector turn:", e?.message ?? e); return connectorFailure(message); })
        : null;
      // OWNER RULE: never LinkedIn, Indeed or Handshake. An ask to apply, message or act on one of them, or a link to one,
      // is declined plainly, naming the site, before every other turn (no card, question, apply, link read or batch sees
      // it): nothing is queued and nothing is left waiting for a later "yes" (career_networking.ts siteRefusedTurn).
      const siteNo = !tapIn && !connAns && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await siteRefusedTurn({ message, userId: user.id, threadId: tid, now: Date.now(), state: ctx as unknown as Record<string, unknown>,
            store: supabaseOutreachStore(admin), events, model: null })
          .catch((e) => { console.error("site refusal turn:", e?.message ?? e); return null; })
        : null;
      const outlookAns = !tapIn && !connAns && !siteNo && !careerTask && !careerBatch && outlookAsk(message)
        ? await outlookChatTurn({ admin, message, userId: user.id, threadId: tid, bridge: isBridgeCall, now: Date.now(), env: Deno.env })
          .catch((e) => { console.error("outlook turn:", e?.message ?? e); return null; })
        : null;
      const card = !tapIn && !connAns && !outlookAns && !siteNo && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        // FEATURE 16: OWNER RULE (2026-10-26): no card without a confirmed resume on file (resumeReady).
        ? await cardTurn({ message, userId: user.id, threadId: tid, now: Date.now(), replyTo, resumeReady: resumeOnFileReader(admin, user.id), store: supabaseCardStore(admin), events })
        : null;
      // WO-025: the text mock interview, code's like the card: "mock me for <role> at <company>", "end mock", and the answers
      // while the mock's question is this thread's last word. Same guards as the card; the card goes first.
      const mock = !card && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await mockTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: supabaseMockStore(admin) })
        : null;
      // TASK PLANNER (career_planner.ts; CAREER_PLANNER=on with the brain released, default off): a message asking for two or
      // more actions is planned into steps, and each step runs through the code path that already does that one thing (the
      // router, the apply turn, the networking turn, the tracker and standing-instruction tools, the reminder store), on
      // this turn's state; every turn below is then skipped. A turn it does not claim falls through to them unchanged. It
      // runs after the card and the mock: their own commands and their prompts waiting for an answer are theirs (WO-025/14).
      let planned: Extract<PlannerTurn, { claimed: true }> | null = null;
      if (!tapIn && !connAns && !outlookAns && !siteNo && !card && !mock && !careerTask && !careerBatch && plannerOn(Deno.env, user.id) && !host.isHostControlled(message, ctx)) {
        const pMeter = ledger.track(newMeter()), pCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
        const pModel = (payload: any) => callModel(pCfg, payload, { meter: pMeter, role: "chat" });
        try {
          const pPostings = supabasePostingsDb(admin), pOutreach = supabaseOutreachStore(admin);
          const pF1 = feature1Deps({ admin, userId: user.id, env: Deno.env, fetch: (i, init) => fetch(i, init), posting: (id) => pPostings.get(id) });
          const pAsk = supabaseEmployerAskStore(admin);
          const p = await plannerTurn({
            userId: user.id, threadId: tid, now: Date.now, model: pModel, ctx: ctx as unknown as Record<string, unknown>,
            tz: await (async () => { try { const r: any = await admin.from("career_alert_prefs").select("tz").eq("user_id", user.id).maybeSingle(); return r?.data?.tz ?? null; } catch { return null; } })(),
            lastIntent: async () => {
              const r = await admin.from("agent_messages").select("meta").eq("thread_id", tid).eq("role", "assistant").order("id", { ascending: false }).limit(1);
              return r.error ? null : ((r.data?.[0]?.meta as any)?.intent ?? null);
            },
            router: async (text) => { await ensurePool(text); return host.runTurn(text, ctx) as any; },
            apply: (text, shortlist) => applyTurn({ ...pF1.apply, message: text, userId: user.id, now: Date.now(), postings: pPostings, wants: supabaseWantStore(admin),
              apps: () => supabaseApplications(admin)(user.id), facts: chatScreenFacts(CareerProfile.confirmedFacts((ctx as any).profile ?? {}), ((ctx as any).statedFacts?.facts ?? []) as any[]),
              shortlist: shortlist as any, limits: paceReader(admin, user.id), employerAnswers: () => pAsk.answers(tid) }) as any,
            networking: (text) => networkingTurn({ message: text, userId: user.id, threadId: tid, now: Date.now(), state: ctx as unknown as Record<string, unknown>, store: pOutreach, events, attachments: [],
              model: Deno.env.get("CAREER_NETWORKING_DRAFT") === "on" ? pModel : null,
              previousAsk: async () => null,
              reminderPush: Deno.env.get("CAREER_OUTREACH_FOLLOWUPS") === "on",
              textingChannel: async () => {
                const r = await admin.from("channel_contacts").select("channel").eq("user_id", user.id).eq("opted_out", false).order("home", { ascending: false }).limit(1);
                if (r.error) throw new Error(`read your texting channel: ${r.error.message}`);
                return r.data?.[0]?.channel ?? null;
              },
              people: supabasePeopleDeps(admin, { fetch, token: careerTokenFor(careerGrant(admin, Deno.env, fetch), PEOPLE_READ_SCOPE), introPush: Deno.env.get("CAREER_INTRO_REMINDERS") === "on", env: (k) => Deno.env.get(k) }) }) as any,
            tools: careerTools({ postings: (q) => pPostings.search(searchWords(q), 150), memory: supabaseMemoryStore(admin), events }),
            reminders: supabaseTaskReminderStore(admin),
          }, message);
          if (p.claimed) planned = p;
          else if (p.why !== "single_ask") console.log(`planner: not claimed (${p.why}); today's chain answers`);
        } catch (e) { console.error("planner: today's chain answers:", (e as Error)?.message ?? e); }
        finally { await ledger.record(pMeter); }
      }
      // END TASK PLANNER
      // Ask once: "what do you need from me" shows the questions only the person can answer, and the text right after
      // answers them by number. Code checks every answer against the employer's own choices; the model never decides.
      // Each of card, mock and questions answers only while its own prompt is the thread's last word, so they never overlap.
      // WO-030: "draft 2" drafts a written answer from the person's confirmed facts through the same gateway and model the
      // brain uses (the model only writes; code checks the employer's AI policy, every fact and the length), and only
      // "use 2" saves it.
      const draftMeter = ledger.track(newMeter());
      const draftCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
      const asked = !tapIn && !card && !mock && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await questionsTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: supabaseQuestionStore(admin), situation,
          draft: { model: (payload) => callModel(draftCfg, payload, { meter: draftMeter, role: "chat" }), facts: () => ((ctx as any).profile?.facts ?? []) } })
        : null;
      // FEATURE 17: hosted preparation. Their answers saved and nothing left open: their queued postings are prepared
      // again now (the hosted door), and the reply says that instead of "on your computer" (career_hosted_prepare.ts).
      if (asked) await prepareAfterAnswers(asked, { admin, userId: user.id, env: Deno.env, fetch: (i, init) => fetch(i, init) })
        .catch((e) => console.error("feature 17 prepare after answers:", (e as Error)?.message ?? e));
      // END FEATURE 17
      // WO-032: the number that says which application an employer's email confirmed (only while that ask is the thread's
      // last word), and applying by email: "apply by email to Acme" shows the whole email drafted from confirmed facts,
      // and "yes" while it is the last word sends exactly that email once from the person's Gmail, only with
      // CAREER_EMAIL_SEND=on (WO-091c; off, the yes is told so and the card is kept). Code's, like the card.
      const free = !tapIn && !card && !mock && !asked && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx);
      const which = free ? await confirmWhichTurn({ message, userId: user.id, threadId: tid, store: supabaseConfirmStore(admin) }) : null;
      const sendToken = careerTokenFor({
        env: Deno.env, fetch, now: Date.now,
        connection: async (u) => {
          const { data, error } = await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle();
          if (error) throw new Error(`read the career grant: ${error.message}`);
          return data ?? null;
        },
        readVault: async (name) => {
          const { data, error } = await admin.rpc("oauth_vault_read", { p_name: name });
          if (error) throw new Error("read the career grant's vault entry");
          return data ? String(data) : null;
        },
        writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed career grant"),
      }, CAREER_SEND_SCOPE);
      // The resume attached is WO-028's, tailored to the posting from confirmed facts, else the person's own file.
      const resumes = supabaseResumes(admin, { profile: () => ((ctx as any).profile ?? {}), tailor: { render: edgeRenderer(), resumes: supabaseResumeStore(admin) } });
      const emailed = free && !which
        ? await emailTurn({ message, userId: user.id, threadId: tid, now: Date.now(), deps: {
          store: supabaseEmailStore(admin), profile: () => ((ctx as any).profile ?? {}), resume: resumes.resume, attachment: resumes.attachment,
          draft: { model: (payload) => callModel(draftCfg, payload, { meter: draftMeter, role: "chat" }), facts: () => ((ctx as any).profile?.facts ?? []) },
          canSend: async (u) => !!(await sendToken(u)), send: countSend(turnEffects, (u: string, m: any) => sendMail({ fetch, token: sendToken }, u, m)),
          // WO-091c: email goes from people's own Gmail only once the owner turns it on, like outreach.
          sendOn: Deno.env.get("CAREER_EMAIL_SEND") === "on",
          // OWNER RULE: the same fail-closed resume check as the chat's apply turn and the card.
          resumeOnFile: resumeOnFileReader(admin, user.id),
        } })
        : null;
      await ledger.record(draftMeter);
      // WO-033: the outreach batch and the one text that answers it ("send all", "send 1-7,9", "redo 3", "skip 4", "edit 3:
      // ..."), code's like the card, only while the batch is this thread's last word. The approval binds each exact
      // message; sending is the scheduled run's. A store that cannot be read sends the text on to the brain, never a guess.
      const outreachStore = supabaseOutreachStore(admin), outreachMeter = ledger.track(newMeter());
      const outreachModel = (payload: any) => callModel({ ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" }, payload, { meter: outreachMeter, role: "chat" });
      const outreachAns = !tapIn && !card && !mock && !asked && !which && !emailed && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await outreachTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: outreachStore, events, tz: undefined,
            redraft: (d) => draftFor({ model: outreachModel, facts: ((ctx as any).profile?.facts ?? []), r: d.recipient, previous: d.body }),
            gmailConnected: () => careerGrantHas(admin, user.id, GMAIL_SEND_SCOPE), connectAsk: missingIntegration("gmail"),
            // MASS NETWORKING M1: with the sending rail on, exactly the drafts this answer approved are queued, each bound to its
            // approval hash (career_send_rail.ts re-reads and re-hashes every draft; the career-send function sends them).
            ...(sendRailOn(Deno.env) ? { onApproved: async (u: string, items: { draftId: string; approvalHash: string }[]) => {
              const res = await queueApprovedOutreach({ rpc: (name, args) => admin.rpc(name, args), drafts: (uu, ids) => outreachStore.drafts!(uu, ids) }, u, items);
              const refused = res.filter((r) => r.status === "refused");
              if (refused.length) console.error("send rail: approved drafts not queued:", refused.map((r) => r.reason).join(", "));
              return refused.map((r) => ({ draftId: r.sourceId, reason: String(r.reason ?? "") }));
            } } : {}) })
          .catch((e) => { console.error("outreach turn:", e?.message ?? e); return null; })
        : null;
      await ledger.record(outreachMeter);
      // MASS NETWORKING M5: "send all" / "send 1,3" / "send none" while follow-ups, scheduling replies or a calendar invite
      // are this thread's last word (each approved only by its exact payload's hash), "follow up after 5 days", and
      // "what's happened with my outreach" / "who replied" / "who wants to talk", read from the tracked conversations.
      const repliesStore = supabaseRepliesStore(admin);
      const repliesAns = !tapIn && !card && !mock && !asked && !which && !emailed && !outreachAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await repliesTurn({ message, userId: user.id, chatThreadId: tid, now: Date.now(), store: repliesStore,
            // Never fails the turn: an unreadable time zone is none (the replies turn says times in UTC then).
            tz: await (async () => { try { const r: any = await admin.from("career_alert_prefs").select("tz").eq("user_id", user.id).maybeSingle(); return r?.data?.tz ?? null; } catch { return null; } })() })
          .catch((e) => { console.error("outreach replies turn:", e?.message ?? e); return null; })
        : null;
      // WO-039: the cloud on and off, code's like the card: "apply for me in the cloud" shows the exact terms, a "yes" while
      // they are the thread's last word (and nothing was texted since) turns it on, and "cloud off" turns it off at any time.
      const cloud = !tapIn && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await cloudTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: supabaseCloudOptinStore(admin) })
        : null;
      // Option A (chosen 2026-10-22 under the owner's delegation): a text yes never approves or sends; only the person's
      // tap on the exact payload does. A "yes" while the cloud card is the thread's last word only opens that card, read
      // as the person. Never on a channel's service-role turn.
      const cardYes = !tapIn && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await cloudCardYesTurn({ message, threadId: tid, ownSession: !isBridgeCall, store: personCloudCardStore(supabase) })
        : null;
      // SUBMIT-STEER-1130: "did my application to Acme go through?", "where are my applications": answered from
      // career_apply_jobs, the one record of what was sent, code's like the card. Submitted is said only as recorded;
      // "confirmed" only when the employer confirmed it; an unreadable record is said, never guessed.
      // STEP 4 F1 (2026-10-25): "apply to the <role> role at <Company>" puts the open posting on file into the person's
      // own apply queue (career_apply_wanted), the queue the extension takes from and the server's prepare-ahead run
      // reads; code's, like the card. The reply says what was queued and that nothing is prepared, filled or sent by
      // it. No product ceiling (owner, 2026-10-22; CAPS-1390): only a daily pace the person set themselves is read, and
      // only on an apply ask; the once-per-employer guard and the card's approval stand.
      // SERIAL-1430 (b): "set my daily pace to N" / "no daily pace": the person's own number, kept only when the column holds
      // it (career_apply_pace_set refuses the rest and says the rule); code's, like the card.
      const paced = !tapIn && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await paceTurn({ message, userId: user.id, admin })
        : null;
      // The screens read the confirmed facts and what the person stated in chat ("I work at X" lands in statedFacts).
      // Real shapes: profile facts are { kind, text } (location, eligibility, education...), stated facts { kind, value }.
      const screenFactsNow = () => chatScreenFacts(CareerProfile.confirmedFacts((ctx as any).profile ?? {}), ((ctx as any).statedFacts?.facts ?? []) as any[]);
      const screenFacts = screenFactsNow();
      const employerAsk = supabaseEmployerAskStore(admin);
      // SERIAL-1490/1491: "is X where you work now?" is answered by the next yes or no while that question is this thread's
      // last word: no queues exactly that posting once, yes keeps it out; the same answer again is told it stands.
      const feature1 = feature1Deps({ admin, userId: user.id, env: Deno.env, fetch: (i, init) => fetch(i, init), posting: (id) => supabasePostingsDb(admin).get(id) });
      // F09: the person's answer to the posting screen's question (meta.screen_ask on the thread's last reply) is saved as a
      // confirmed profile fact, and the held postings are screened again with it (career_apply_screen_answer.ts).
      const screenAns = tapIn ? await (async () => {
          const last = await employerAsk.lastAssistant(tid);
          if (!(ctx as any).profile) (ctx as any).profile = CareerProfile.createProfile({});
          return await screenTapTurn({
            qid: tapIn.qid, answer: tapIn.answer, now: Date.now(), last: last as any, profile: (ctx as any).profile, addFact: (p: any, f: any) => CareerProfile.addFact(p, f),
            rerun: (held) => applyTurn({
              ...feature1.apply, message: "apply to all of them", userId: user.id, now: Date.now(), postings: supabasePostingsDb(admin), wants: supabaseWantStore(admin),
              apps: () => supabaseApplications(admin)(user.id), facts: screenFactsNow(), limits: paceReader(admin, user.id), employerAnswers: () => employerAsk.answers(tid),
              shortlist: held.map((h) => ({ id: h.job_id ?? undefined, title: h.title, company: h.company, location: "", url: h.url })) as any,
            }),
          });
        })().catch((e) => { console.error("screen tap turn:", e?.message ?? e); return { reply: TAP_STALE_REPLY, status: "stale", intent: TAP_INTENT, saved: [] } as any; })
        : !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await (async () => {
          const last = await employerAsk.lastAssistant(tid);
          if (!(last?.meta as any)?.screen_ask) return null;
          if (!(ctx as any).profile) (ctx as any).profile = CareerProfile.createProfile({});
          return await screenAnswerTurn({
            message, now: Date.now(), last: last as any, profile: (ctx as any).profile, addFact: (p: any, f: any) => CareerProfile.addFact(p, f),
            rerun: (held) => applyTurn({
              ...feature1.apply, message: "apply to all of them", userId: user.id, now: Date.now(), postings: supabasePostingsDb(admin), wants: supabaseWantStore(admin),
              apps: () => supabaseApplications(admin)(user.id), facts: screenFactsNow(), limits: paceReader(admin, user.id), employerAnswers: () => employerAsk.answers(tid),
              shortlist: held.map((h) => ({ id: h.job_id ?? undefined, title: h.title, company: h.company, location: "", url: h.url })) as any,
            }),
          });
        })().catch((e) => { console.error("screen answer turn:", e?.message ?? e); return null; })
        : null;
      const employerAnsOnly = !tapIn && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await employerAnswerTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: employerAsk, wants: supabaseWantStore(admin),
            apps: () => supabaseApplications(admin)(user.id), facts: screenFacts, limits: paceReader(admin, user.id), employerAnswers: () => employerAsk.answers(tid),
            posting: (id) => supabasePostingsDb(admin).get(id) })
          .catch((e) => { console.error("employer answer turn:", e?.message ?? e); return null; })
        : null;
      const employerAns = (screenAns as any) ?? employerAnsOnly;
      // FEATURE 1: apply from chat (career_apply_from_chat.ts). The apply turn below also resolves positions ("apply to 1
      // and 3", "the 2nd one") on the thread's last list, refuses a listed posting closed or not found on file and every
      // posting when no confirmed resume is on file, asks the worker's prepare-ahead for exactly the rows queued (only with
      // CAREER_PREPARE_AHEAD_URL set; off by default) and starts its reply with the coverage ("3/3 queued; ..."). After the
      // router's batch turn, an answer it recorded in chat is recorded on the matching open queue question as well
      // (career_apply_answers_for reads it). Nothing is approved or sent here: only the card's tap does that.
      // FEATURE 1 end
      // BILLING BY TEXT (owner, 2026-10-27): "what am I paying", "cancel my plan", "my invoices" (career_billing.ts). Before
      // FEATURE 17, so "cancel my plan" is billing and "cancel my application to X" stays the cancel turn's. The price and
      // dates only from the person's own user_subscriptions row; a cancel only on an exact "yes" to the exact payload the
      // ask showed (hash-bound, the thread's last word), once, at period end; receipts with Stripe's own links. The key is
      // read here and never printed; without it billing is said to be unreachable.
      const billing = !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await billingTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: supabaseBillingStore(admin), stripe: stripeFromEnv(fetch, Deno.env.get("STRIPE_SECRET_KEY")) })
          .catch((e) => { console.error("billing turn:", (e as Error)?.message ?? e); return null; })
        : null;
      // END BILLING BY TEXT
      // FEATURE 17: "cancel my application to X" / "don't apply to X": withdrawn before it is sent (career_hosted_prepare.ts).
      const cancelled = !billing && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? (await cancelTurn({ message, userId: user.id, admin }).catch((e) => { console.error("feature 17 cancel:", (e as Error)?.message ?? e); return null; }))
          // C21/C22: "undo" / "cancel that" right after an approval: the latest approved application or email, cancelled while it
          // has not gone out, else said plainly that it already went (career_undo.ts). Code's, like the cancel.
          ?? (await undoTurn({ message, userId: user.id, threadId: tid, now: Date.now(), store: supabaseUndoStore(admin) }).catch((e) => { console.error("undo turn:", (e as Error)?.message ?? e); return null; }))
        : null;
      // END FEATURE 17
      // APPLY HERE (apply_here.ts, Telegram): the link(s) or "apply to this" resolved and screened, no queueing; the tap on the one Apply
      // button queues or approves the exact payload. CAREER_APPLY_HERE=off turns off ONLY this intake (the one-line reply and the Apply button): the applyTurn below then answers as before.
      // It does NOT bring back attachments: the no-download default (attach_tool.ts, research_reply.ts attach) is separate and stays on.
      const hereOut = Deno.env.get("CAREER_APPLY_HERE") !== "off" && writerChannel((body as any)?.channel) === "telegram" && !billing && !cancelled && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await applyHereTurn({ message, now: Date.now(), db: supabasePostingsDb(admin), fetchFeed: boardFetchFeed((i, init) => fetch(i, init), { timeoutMs: 8000 }),
            apps: () => supabaseApplications(admin)(user.id), facts: screenFacts,
            last: (() => { const l = (loaded.snapshot as any)?.stores?.discovery?.lastShortlist; return Array.isArray(l) && l.length === 1 ? l[0] : null; })() })
          .catch((e) => { console.error("apply here:", (e as Error)?.message ?? e); return null; })
        : null;
      if (hereOut?.hits.length) turnPostings = hereOut.hits;
      const queued: any = hereOut ? { reply: hereOut.reply, intent: APPLY_QUEUE_INTENT, status: hereOut.status } : !billing && !cancelled && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await applyTurn({
          ...feature1.apply,
          // FEATURE E2E: a pasted posting link (or a role at a registered board) read from the ATS's public API on demand
          // and stored as the ingest stores it (career_apply_link.ts). CAREER_APPLY_LINK=off turns the read off.
          link: Deno.env.get("CAREER_APPLY_LINK") === "off" ? null
            : { db: supabasePostingsDb(admin), fetchFeed: boardFetchFeed((i, init) => fetch(i, init), { timeoutMs: 8000 }) },
          message, userId: user.id, now: Date.now(), postings: supabasePostingsDb(admin), wants: supabaseWantStore(admin),
          apps: () => supabaseApplications(admin)(user.id),
          facts: screenFacts,
          // The batch ask ("apply to these") reads the postings this thread last listed, as the router kept them.
          shortlist: (loaded.snapshot as any)?.stores?.discovery?.lastShortlist ?? null,
          limits: paceReader(admin, user.id),
          employerAnswers: () => employerAsk.answers(tid),
        })
        : null;
      // FEATURE 14: receipts (D-024, G6). "show me the receipt for Stripe", "what did you send to Acme": the receipt the
      // database wrote when the application finished (career_apply_receipts), the person's own only, read by code; what was
      // sent field by field with each answer's fact, where and when, the hashes, the employer's words, and the pictures of
      // the proof attached through the channel artifact path. Nothing is sent or changed by it.
      const receiptAns = !billing && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !queued && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await receiptTurn({ message, userId: user.id, now: Date.now(), read: supabaseReceipts(admin) }).catch((e) => { console.error("receipt turn:", e?.message ?? e); return null; })
        : null;
      // END FEATURE 14
      // WO-107 (F3): "where are my applications" / "did my application to X go through" / "where do I stand with X", "who
      // emailed me" / "any news from X", "what follow-ups are due": one read model (the queue, the mail events, every
      // thread's tracker, the mail drafts), each record's line named, an unreadable one said. The queue-only status turn
      // below stays as the fallback when the reader itself fails.
      // FEATURE 8: inbox awareness and follow-ups that can be sent (career_inbox_followups.ts). "check my email now" / "I
      // connected my Gmail": one run of the scheduled mail tracking for this person (CAREER_MAIL_TRACKING=on). "send the
      // follow-up to X": the due or drafted follow-up as one email card (outreach store, hash-bound); "yes" while it is the
      // last word sends exactly it once from their Gmail, only with CAREER_EMAIL_SEND=on and gmail.send.
      const f08Stores = supabaseFollowupStores(admin), f08Grant = careerGrant(admin, Deno.env, fetch);
      const f08 = !billing && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !queued && !receiptAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await followupTurn({ message, userId: user.id, threadId: tid, now: Date.now(), deps: {
            read: supabaseStanding(admin), outreach: outreachStore, events, lastAssistant: f08Stores.lastAssistant, addressOnRecord: f08Stores.addressOnRecord,
            name: () => ((ctx as any).profile?.basics?.name ?? null), markSent: f08Stores.markSent,
            mailOn: Deno.env.get("CAREER_MAIL_TRACKING") === "on",
            readNow: (u) => mailNow({ userId: u, now: Date.now(), store: supabaseMailStore(admin), cursor: f08Stores.cursor, read: gmailReadNow(f08Grant, fetch), confirm: supabaseConfirmStore(admin) }),
            sendOn: Deno.env.get("CAREER_EMAIL_SEND") === "on", canSend: async (u) => !!(await sendToken(u)),
            send: countSend(turnEffects, (u: string, m: any) => gmailSender({ fetch, token: (uu: string) => sendToken(uu) }).send(u, m)), connectAsk: missingIntegration("gmail"),
          } }).catch((e) => { console.error("follow-up turn:", e?.message ?? e); return null; })
        : null;
      // ROUTING SCENARIOS (2026-10-29): an email-status ask ("where are my emails", "email status", "any update on my emails")
      // is the send rail's (outreachStatus below), never the standing, application-status or networking turn's: before, "email
      // status" drafted an email to a person named "status" and "any update on my emails" read the application inbox.
      const emailAsk = emailStatusAsk(message);
      const stood = !emailAsk && !billing && !f08 && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !queued && !receiptAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await standingTurn({ message, userId: user.id, now: Date.now(), read: supabaseStanding(admin) }).catch((e) => { console.error("standing turn:", e?.message ?? e); return null; })
          // REQS DOC 2: reminders the person sets ("remind me tomorrow at 9am to ..."), and "any update?" / "what's waiting
          // on me?" from the situation read at the top of the turn; each answers only its own asks, before the router.
          ?? await reminderTurn({ message, userId: user.id, now: Date.now(), store: supabaseReminderStore(admin) }).catch((e) => { console.error("reminder turn:", e?.message ?? e); return null; })
          ?? overviewTurn({ message, situation, now: Date.now() })
        : null;
      const status = !emailAsk && !billing && !f08 && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !queued && !stood && !receiptAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await applicationsTurn({ message, userId: user.id, now: Date.now(), read: supabaseApplications(admin) })
        : null;
      // FEATURE 17: a status answer also says where each posting they asked for stands before it is on the queue.
      await withPending(stood ?? status, message, { admin, userId: user.id, statusAsk }).catch((e) => console.error("feature 17 pending:", (e as Error)?.message ?? e));
      // END FEATURE 17
      // FEATURE 10: networking from chat. A contacts CSV pasted or attached (`attachments`: [{ name, mime, text }]) is
      // imported into the thread's contacts; "who do I know at X" answers from them; "email Maya at X about ..." drafts
      // from confirmed facts (draftFor) onto the outreach batch that outreachTurn answers, one approval per exact message.
      // Only addresses in the person's own contacts; the model writes only with CAREER_NETWORKING_DRAFT=on (metered).
      // Nothing is sent here: sending stays career-proactive's, behind CAREER_OUTREACH_SEND.
      const netMeter = ledger.track(newMeter());
      const networking = !emailAsk && !billing && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !queued && !f08 && !stood && !status && !receiptAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await networkingTurn({ message, userId: user.id, threadId: tid, now: Date.now(), state: ctx as unknown as Record<string, unknown>, store: outreachStore, events,
            attachments: Array.isArray(body.attachments) ? (body.attachments as any[]).filter((a) => a && typeof a === "object").map((a) => ({ name: String(a.name ?? "contacts.csv"), mime: typeof a.mime === "string" ? a.mime : "", text: typeof a.text === "string" ? a.text : null })) : [],
            model: Deno.env.get("CAREER_NETWORKING_DRAFT") === "on" ? (payload: any) => callModel({ ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" }, payload, { meter: netMeter, role: "chat" }) : null,
            previousAsk: async () => {
              const r = await admin.from("agent_messages").select("content").eq("thread_id", tid).eq("role", "user").order("id", { ascending: false }).limit(1);
              return r.error ? null : (r.data?.[0]?.content ?? null);
            },
            // R2: a follow-up reminder is promised as a text only when the scheduled push is on AND the person has a
            // channel it can reach (career_outbox_claim delivers only through channel_target).
            reminderPush: Deno.env.get("CAREER_OUTREACH_FOLLOWUPS") === "on",
            textingChannel: async () => {
              const r = await admin.from("channel_contacts").select("channel").eq("user_id", user.id).eq("opted_out", false).order("home", { ascending: false }).limit(1);
              if (r.error) throw new Error(`read your texting channel: ${r.error.message}`);
              return r.data?.[0]?.channel ?? null;
            },
            // D-033 people finding: the LinkedIn export, Gmail correspondents (the career grant's read scope), pages, intros.
            // D-MN-3 people discovery: web search + public pages when CAREER_PEOPLE_SEARCH=on; off, the reply says so.
            people: supabasePeopleDeps(admin, { fetch, token: careerTokenFor(f08Grant, PEOPLE_READ_SCOPE), introPush: Deno.env.get("CAREER_INTRO_REMINDERS") === "on", env: (k) => Deno.env.get(k) }) })
          .catch((e) => { console.error("networking turn:", e?.message ?? e); return null; })
        : null;
      await ledger.record(netMeter);
      // END FEATURE 10
      // FEATURE 12: offers and negotiation backed by market numbers (career_offer_chat.ts). "I got an offer from X for $Y
      // as a Z in City", "is $95k good for a data analyst in Chicago", "compare my two offers", "help me negotiate": the
      // offer placed against DOL LCA, BLS OEWS and the pay open postings on file state (a median only from 5 or more), and
      // the counter drafted on a card that cites it. Code's, before the router; nothing is sent. The thread keeps its
      // offers in the offerBenchmark store, which the snapshot carries and an erase clears.
      const offered = !billing && !card && !mock && !asked && !which && !emailed && !outreachAns && !repliesAns && !cloud && !cardYes && !paced && !employerAns && !queued && !f08 && !stood && !status && !networking && !receiptAns && !siteNo && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await offerChatTurn({ message, now: Date.now(), state: (ctx as any).offerBenchmark ?? null, postings: supabasePostingsDb(admin) })
          .catch((e) => { console.error("offer turn:", e?.message ?? e); return null; })
        : null;
      if (offered?.state) (ctx as any).offerBenchmark = offered.state;
      const offerAns = offered?.answer ?? null;
      // END FEATURE 12
      // MASS NETWORKING M1: "where are my emails" / "what's the status of my emails?": the send rail's own counts
      // (career_send_status) and the approved emails not on the rail; read only, nothing is sent or changed.
      const outreachStatus = !card && !mock && !asked && !which && !emailed && !outreachAns && !cloud && !cardYes && !paced && !employerAns && !queued && !f08 && !stood && !status && !networking && !offerAns && !receiptAns && !planned && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)
        ? await outreachStatusTurn({ message, userId: user.id, rail: { rpc: (name, args) => admin.rpc(name, args) }, approvedNotQueued: async (u) => {
            const d = await admin.from("career_outreach_drafts").select("id").eq("user_id", u).eq("status", "approved").limit(1000);
            if (d.error) throw new Error(`read approved drafts: ${d.error.message}`);
            const ids = (d.data ?? []).map((r: any) => r.id);
            const onRail = new Set<string>();
            for (let i = 0; i < ids.length; i += 100) { // short request URLs: 100 ids per read
              const q = await admin.from("career_send_queue").select("source_id").eq("user_id", u).eq("kind", "outreach").in("source_id", ids.slice(i, i + 100));
              if (q.error) throw new Error(`read the send queue: ${q.error.message}`);
              for (const r of q.data ?? []) onRail.add(r.source_id);
            }
            return ids.length - onRail.size;
          } }).catch((e) => { console.error("outreach status turn:", e?.message ?? e); return null; })
        : null;
      // FEATURE 13: staged brain release. With CAREER_BRAIN=staged, a turn that every code-first turn above passed on, and
      // that the router itself would answer only with advice or conversation, goes to the brain (career_staged.ts); every
      // action stays code's and the router still answers a model failure. Unset or CAREER_BRAIN=router, it is never
      // taken and the router answers exactly as before. Read lazily, only when the brain test below is reached.
      const staged = stagedRoute({ env: Deno.env, message, ctx: ctx as unknown as Record<string, unknown>, host, structured: !!(careerTask || careerBatch) });
      // FEATURE GV (Google verification, 2026-10-26): "disconnect gmail" is answered by the connector framework above
      // (connAns), through the same _shared/google_disconnect.ts: revoked at Google, tokens, rows and mail rows deleted,
      // read back, and now pending sends cancelled. Before any other turn, on every channel.
      if (connAns) {
        out = { reply: connAns.reply, intent: connAns.intent, resultStatus: connAns.resultStatus, contained: false, handler: connAns.handler };
        if (connAns.meta) agentMeta = { ...(agentMeta || {}), ...connAns.meta };
      } else if (siteNo && !mock) { // a mock in progress keeps its answer (its guards are the card's, WO-025)
        out = { reply: siteNo.reply, intent: siteNo.intent, resultStatus: siteNo.status, contained: false, handler: "site_refused" };
      } else if (outlookAns) {
        out = { reply: outlookAns.reply, intent: outlookAns.intent, resultStatus: outlookAns.resultStatus, contained: false, handler: outlookAns.handler };
        if (outlookAns.meta) agentMeta = { ...(agentMeta || {}), ...outlookAns.meta };
      } else if (planned) { // TASK PLANNER: each step's own reply, in order; a waiting prompt a step left is the thread's last word
        out = { reply: planned.reply, intent: planned.intent, resultStatus: planned.resultStatus, contained: false, handler: "planner", parts: planned.parts,
          ...(planned.documents.length ? { result: { documents: planned.documents } } : {}) };
        agentMeta = planned.meta;
      } else if (card) {
        // A card still waiting for its answer stays this thread's last word (D-MS-1: also after "wait", an unclear reply
        // or a number not on it); an answered one does not.
        const waiting = cardWaiting(card);
        out = { reply: card.reply, intent: waiting ? CARD_INTENT : CARD_ANSWER_INTENT, resultStatus: card.status, contained: false, handler: "cards", ...(card.parts ? { parts: card.parts } : {}) };
        // SERIAL-1451: the waiting card's id rides the reply, so the next yes in this thread answers this card and no other.
        if (waiting && card.card_id) agentMeta = { card_id: card.card_id };
      } else if (mock) {
        // The mock's own intent: MOCK_INTENT while its question waits, so only then is the next text an answer.
        out = { reply: mock.reply, intent: mock.intent, resultStatus: mock.status, contained: false, handler: "mock" };
      } else if (asked) {
        // Questions shown, or some still open after an answer, stay this thread's last word so "2 yes" answers them; so does
        // every draft turn (a draft shown waits for "use 2"; a refused or failed one leaves the question open).
        const waiting = ["shown", "partial", "answered_next"].includes(asked.status) || asked.status.startsWith("draft");
        out = { reply: asked.reply, intent: waiting ? QUESTIONS_INTENT : "career_apply_questions_answer", resultStatus: asked.status, contained: false, handler: "questions" };
      } else if (which) {
        // A number not on the list leaves the ask waiting; anything else answered it.
        out = { reply: which.reply, intent: which.status === "not_on_list" ? CONFIRM_INTENT : "career_apply_confirm_answer", resultStatus: which.status, contained: false, handler: "confirm" };
      } else if (emailed) {
        // A card waiting for its yes is this thread's last word, by its id (meta.email_card): a yes counts only for the card
        // this reply showed. Anything else answered it, and leaves no email waiting.
        out = { reply: emailed.reply, intent: emailed.waiting ? EMAIL_INTENT : "career_apply_email_answer", resultStatus: emailed.status, contained: false, handler: "email" };
        if (emailed.waiting && emailed.card_id) agentMeta = { email_card: emailed.card_id };
      } else if (outreachAns) {
        out = { reply: outreachAns.reply, intent: outreachAns.intent, resultStatus: outreachAns.status, contained: false, handler: "outreach", ...(outreachAns.parts ? { parts: outreachAns.parts } : {}) };
      } else if (repliesAns) {
        out = { reply: repliesAns.reply, intent: repliesAns.intent, resultStatus: repliesAns.status, contained: false, handler: "outreach_replies" };
      } else if (cloud) {
        out = { reply: cloud.reply, intent: cloud.intent, resultStatus: cloud.status, contained: false, handler: "cloud" };
      } else if (cardYes) {
        // The card stays the last word, so the app shows it again; its Approve is the only way anything is sent.
        out = { reply: cardYes.reply, intent: CLOUD_CARD_INTENT, resultStatus: cardYes.status, contained: false, handler: "cloud_card" };
        agentMeta = { career_approval_card_id: cardYes.card_id, open_card: cardYes.card_id };
      } else if (paced) {
        out = { reply: paced.reply, intent: paced.intent, resultStatus: paced.status, contained: false, handler: "apply_pace" };
      } else if (employerAns) {
        // The question stays the thread's last word while any posting is still unanswered; the answers ride the reply.
        out = { reply: employerAns.reply, intent: employerAns.intent, resultStatus: employerAns.status, contained: false, handler: "apply_employer" };
        agentMeta = { ...(employerAns.answers?.length ? { employer_answers: employerAns.answers } : {}), ...(employerAns.pending?.length ? { employer_question: employerAns.pending } : {}), ...((employerAns as any).meta ?? {}) };
        if (employerAns.intent === EMPLOYER_ANSWER_INTENT && !employerAns.answers?.length) agentMeta = null;
      } else if (billing) {
        // A cancel waiting for its yes is this thread's last word, its exact payload on the reply (meta.billing_cancel).
        out = { reply: billing.reply, intent: billing.intent, resultStatus: billing.status, contained: false, handler: "billing" };
        if (billing.meta) agentMeta = billing.meta;
      } else if (cancelled) { // FEATURE 17
        out = { reply: cancelled.reply, intent: cancelled.intent, resultStatus: cancelled.status, contained: false, handler: "apply_cancel" };
      } else if (queued) {
        // SERIAL-1490: a posting held back by "is X where you work now?" makes the question this thread's last word, with
        // the postings it is about on the reply, so the next yes or no answers exactly them.
        const asking = !!queued.ask?.length;
        out = { reply: queued.reply, intent: asking ? EMPLOYER_ASK_INTENT : queued.intent, resultStatus: queued.status, contained: false, handler: "apply_queue" };
        if (asking) agentMeta = { employer_question: queued.ask };
        // F09: the screen's question for a fact not confirmed rides the reply, so the next message can answer it.
        const sm = screenMeta(queued.screen);
        if (sm) agentMeta = { ...(agentMeta ?? {}), ...sm };
      } else if (receiptAns) {
        // FEATURE 14: the pictures ride result.documents, materialized below like every turn document.
        out = { reply: receiptAns.reply, intent: receiptAns.intent, resultStatus: receiptAns.status, contained: false, handler: "receipt", ...(receiptAns.result ? { result: receiptAns.result as unknown as Record<string, unknown> } : {}) };
      } else if (f08) {
        // FEATURE 8: a card or a question waiting for its answer is this thread's last word by its meta.
        out = { reply: f08.reply, intent: f08.intent, resultStatus: f08.status, contained: false, handler: "followup" };
        if (f08.meta) agentMeta = f08.meta;
      } else if (stood) {
        out = { reply: stood.reply, intent: stood.intent, resultStatus: stood.status, contained: false, handler: "standing" };
      } else if (status) {
        out = { reply: status.reply, intent: status.intent, resultStatus: status.status, contained: false, handler: "status" };
      } else if (networking) {
        // FEATURE 10: a batch shown is the thread's last word (OUTREACH_INTENT), so "send 1" answers it.
        out = { reply: networking.reply, intent: networking.intent, resultStatus: networking.status, contained: false, handler: "networking", ...(networking.parts ? { parts: networking.parts } : {}) };
      } else if (offerAns) { // FEATURE 12: the offer turn's answer; the counter's card rides the reply's meta.
        out = { reply: offerAns.reply, intent: offerAns.intent, resultStatus: offerAns.status, contained: false, handler: "offer", parts: offerAns.parts };
        if (offerAns.card) agentMeta = { offer_card: offerAns.card };
      } else if (outreachStatus) {
        out = { reply: outreachStatus.reply, intent: outreachStatus.intent, resultStatus: outreachStatus.status, contained: false, handler: "outreach_status" };
      } else if (!careerTask && !careerBatch && ((AGENT_BRAIN_RELEASED && chooseBrain(Deno.env) === "agent") || staged.toBrain()) && !host.isHostControlled(message, ctx)) {
        const meter = ledger.track(newMeter());
        const cfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
        // WO-027 (B5): the last 40 messages after the latest erase; one more row says whether the thread is longer.
        const hist = await admin.from("agent_messages").select("role,content,meta").eq("thread_id", tid).order("id", { ascending: false }).limit(HISTORY_WINDOW + 1);
        if (hist.error) throw new Error(`agent history: ${hist.error.message}`);
        const win = historyWindow((hist.data || []) as any[]), history = win.history;
        const postingsDb = supabasePostingsDb(admin);
        // WO-023: what is known about the person, every turn. Standing instructions are fundamental: if they cannot be
        // read the turn fails rather than answer without them. Alerts say "could not be read" instead; the applications
        // are the situation read at the top of the turn (WO-100), which names what it could not read.
        const memory = supabaseMemoryStore(admin), alertStore = supabaseAlertStore(admin), now = Date.now();
        const standing = await memory.standing(user.id);
        const alertRow = await alertStore.get(user.id).catch((e) => { console.error("agent memory: alerts", e?.message ?? e); return null; });
        // WO-027: the account's timeline, written by the tools and read by recall; past the window, a summary of it written
        // in code. A timeline that cannot be read never fails the turn: the summary says so instead.
        const tz = alertRow?.tz;
        const recent = win.cut ? await events.recall(user.id, { limit: 200 }).catch((e) => { console.error("agent memory: events", e?.message ?? e); return null; }) : null;
        const summary = summaryFor(win.cut, recent, now, tz);
        // WO-066: the person's own daily application limit (the queue's SQL holds the same bound); unread, the default.
        const daily = await admin.rpc("career_apply_daily_limit", { p_user: user.id }).then((r: any) => r.error ? undefined : Number(r.data) || undefined, () => undefined);
        const turn = await agentTurn({ message, history, stores: ctx as unknown as Record<string, unknown>, userId: user.id, threadId: tid, now,
          model: (payload) => callModel(cfg, payload, { meter, role: "chat" }), postings: (q) => postingsDb.search(searchWords(q), 150), alerts: alertStore,
          mail: supabaseMailStore(admin), interviews: supabaseInterviewStore(admin), digest: supabaseDigestStore(admin),
          events, tz, summary, hired: hiredSourceFromEnv(Deno.env, admin), confirmations: confirmEvents,
          // WO-033: drafts from the person's lists (the model writes, the fact-lock checks), and Hunter when its key is set.
          outreach: { store: outreachStore, model: (payload) => callModel(cfg, payload, { meter, role: "chat" }) },
          conversations: repliesStore,
          // REPLY SHAPE: Telegram with the reply writer on gets the shape rules and the attach_document tool.
          shape: replyWriterOn(Deno.env) && writerChannel((body as any)?.channel) === "telegram",
          files: createFileService({ store: supabaseFileKindStore(admin), env: Deno.env, now: Date.now, records: { application: (u, id) => supabaseFileStore(admin).appRow(u, id) } }),
          verifier: hunterVerifier({ fetch, apiKey: Deno.env.get("HUNTER_API_KEY"), cache: supabaseCheckCache(admin), now: Date.now }),
          tailor: { posting: (id) => postingsDb.get(id), personas: supabasePersonaStore(admin), resumes: supabaseResumeStore(admin), render: edgeRenderer() },
          // WO-066: "apply me to these" puts the postings in the person's own queue; the extension prepares each, and each
          // goes only on its card's tap.
          wants: supabaseWantStore(admin), limits: { daily }, posting: (id) => postingsDb.get(id),
          // WO-106 (F4): each job link is checked against its board just before it is shown.
          linkCheck: linkChecker(fetch, { userAgent: `Trainee job link check (contact: ${Deno.env.get("INGEST_CONTACT_EMAIL") || "unset"})` }),
          // FEATURE 13: the staged brain answers with the actions that have a code-first owner withheld.
          toolPolicy: staged.chosen ? STAGED_TOOL_POLICY : null,
          // Situation knowledge: the context pack and playbooks (CAREER_KNOWLEDGE=on; off by default).
          knowledge: knowledgeOn(Deno.env),
          // Open career questions: cached, capped OpenAI web search (the worst case is reserved in the day's model budget). The cache is per instance
          // until a table is approved by the owner; the brief is returned as markdown until PR #280 (file kinds) supplies `publish`.
          research: knowledgeOn(Deno.env) && cfg.provider === "openai" && cfg.apiKey ? { search: openAiGroundSearch({ apiKey: cfg.apiKey, model: DEFAULT_SEARCH_MODEL }), cache: researchCache, publish: fileKindPublisher(createFileService({ store: supabaseFileKindStore(admin), env: Deno.env, now: Date.now }), user.id), derive: modelDerive(async (system, user) => { const r = await callModel(cfg, { system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], max_tokens: 200 }, { meter, role: "chat" }); return (r.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""); }) } : null,
          known: { standing, alerts: alertRow ? { prefs: alertRow.prefs, tz: alertRow.tz } : null, pipeline: null, situation }, memory });
        await ledger.record(meter);
        if (turn.stopped === "model_error" && !turn.tool_calls.some((t) => t.ok && t.effect === "write_own")) {
          console.error("agent brain: model unavailable, answering with the router");
          await ensurePool();
          out = host.runTurn(message, ctx);
        } else {
          // A batch of outreach drafts is shown by code, and its intent makes the next text an answer to it.
          turnPostings = Array.isArray(turn.postings) ? turn.postings : [];
          turnAttachments = turn.attachments ?? []; turnLinks = turn.linksSeen ?? []; turnFileLinks = turn.fileLinks ?? [];
          out = { reply: turn.reply, intent: turn.show?.intent ?? "agent", resultStatus: turn.stopped, contained: false, handler: "agent", ...(turn.show?.parts ? { parts: turn.show.parts } : {}) };
          agentMeta = { brain: staged.chosen ? "staged" : "agent", ...(staged.chosen ? { router_intent: staged.decision?.intent ?? null } : {}), tool_calls: turn.tool_calls, stopped: turn.stopped, pending_approvals: turn.pending_approvals.length, ...(turn.knowledge ? { knowledge: turn.knowledge } : {}) };
        }
      } else {
        // FEATURE 5: job search ranked by fit and judged (_shared/career_search_judge.ts). "judge prompt: ..." keeps the
        // person's own judging instructions (a standing instruction). After the router decides a turn is a role search
        // (its own parse, discovery.lastParams), the list comes from searchPostings over the live board (career_postings)
        // when it has a match, else the saved snapshot, ranked by fit; with CAREER_JUDGE=on the top N are judged by the
        // model on the fixed scale (metered, cached per posting and profile hash), else the fit order stands. The listed
        // postings become the thread's shortlist, so "apply to these" means them.
        const f5Free = !siteNo && !careerTask && !careerBatch && !host.isHostControlled(message, ctx);
        const f5JudgeOn = Deno.env.get("CAREER_JUDGE") === "on";
        const f5Prompt = f5Free ? await judgePromptTurn({ message, userId: user.id, now: Date.now(), memory: supabaseMemoryStore(admin), judgeOn: f5JudgeOn }) : null;
        if (!f5Prompt) await ensurePool();
        out = f5Prompt
          ? { reply: f5Prompt.reply, intent: f5Prompt.intent, resultStatus: f5Prompt.status, contained: false, handler: "judge_prompt" }
          : host.runTurn(message, ctx);
        // askFor: the router's search plus the parameters the message states (level, pay, season, employer, sponsorship), or a
        // role search the router did not run at all (posting_constraints.ts reads it from the message itself).
        const f5Said = f5Free && !f5Prompt ? askFor(message, out, (ctx as any).discovery) : null;
        const f5Ask = f5Said?.ask ?? null;
        if (f5Ask) {
          const f5Meter = ledger.track(newMeter());
          const f5Cfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
          try {
            const found = await searchJudgeTurn({ message, ask: f5Ask, userId: user.id, now: Date.now(), profile: (ctx as any).profile ?? null,
              sources: supabaseSearchSources(admin, { window: postings, jobs: { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml } }),
              judge: { on: f5JudgeOn, model: (payload) => callModel(f5Cfg, payload, { meter: f5Meter, role: "chat" }), cache: supabaseJudgeCache(admin),
                n: Number(Deno.env.get("CAREER_JUDGE_N")) || undefined, standing: () => supabaseMemoryStore(admin).standing(user.id) } });
            if (found) {
              // ONBOARDING ROUND 2: the router's line that nothing is sent before the resume is confirmed (an apply ask with
              // no confirmed resume) stays with the search's own reply.
              const prof = (ctx as any).profile, facts: any[] = Array.isArray(prof?.facts) && !prof?._fromStatedFacts ? prof.facts : [];
              const confirmedResume = facts.some((f) => f && ["education", "experience", "project", "leadership", "skill"].includes(f.kind) && f.needs_confirmation !== true && (f.status == null || f.status === "confirmed"));
              const askText = String(message ?? "").toLowerCase();
              const applyAsk = !/\?\s*$/.test(askText) && /\bapply\s+(?:to|for|at|me|on|now)\b|\bapply\b[^.?!]{0,40}\b(?:jobs?|roles?|postings?|positions?|internships?|openings?)\b|\bsubmit (?:my|an?) applications?\b/.test(askText);
              const resumeLine = f5Said?.append || confirmedResume || !applyAsk || /\bresume\b/i.test(found.reply) ? ""
                : facts.some((f) => f && f.source === "resume-ingest" && f.needs_confirmation === true)
                ? "\n\nAnd nothing is sent anywhere before your resume is confirmed: its entries are waiting for your word (reply \"yes, that's my resume\" if they're right)."
                : "\n\nAnd nothing is sent anywhere before your resume is confirmed: paste or attach it, confirm it, then ask again.";
              out = { ...out, reply: (f5Said?.append ? `${out.reply}\n\n${found.reply}` : found.reply) + resumeLine, resultStatus: found.status, handler: "search_judge" };
              (ctx as any).discovery = { ...((ctx as any).discovery ?? {}), lastShortlist: found.shortlist, lastSource: found.source };
            }
          } catch (e) { console.error("career search judge: the router's reply stands:", (e as Error)?.message ?? e); }
          await ledger.record(f5Meter);
        }
        // FEATURE 5 (end)
      }
      // SUBMIT-STEER-1130: the router's confirm of a pasted resume carries no confirmation event, so no application could
      // ever use it. Each fact this turn confirmed whose words Trainee showed the person, and that is in their own upload,
      // gets its persisted fact_confirmed event and an owner provenance; anything else stays unevidenced. Saved with the
      // turn below. The thread is read only on the router's resume confirm.
      // RESUME CONFIRM RACE (2026-10-30): the events are held (confirmEvents) and written by this turn's commit, in the same
      // transaction as the profile they evidence (career_host_commit_evidenced): a refused save writes none.
      let confirmEv: EvidenceResult | null = null;
      if (out.handler !== "agent" && out.intent === "career_resume_ingest" && out.resultStatus === "completed") {
        const recent = await admin.from("agent_messages").select("id,role,content,created_at").eq("thread_id", tid).order("id", { ascending: false }).limit(40);
        if (recent.error) {
          // The thread could not be read, so nothing the router confirmed can be evidenced: held, and said.
          console.error("career evidence: the thread was not read", recent.error.message);
          const ev = await evidenceResumeConfirmation({ userId: user.id, now: Date.now(), message, before: (loaded.account as any)?.memory?.profile ?? (loaded.snapshot as any)?.stores?.profile ?? null,
            after: (ctx as any).profile ?? null, out, shown: null, upload: null, events: confirmEvents });
          confirmEv = ev;
          const held = heldReply(ev);
          if (held) out = { ...out, reply: held, resultStatus: "not_confirmed" };
        } else {
          const seen = await resumeConfirmationContext((recent.data ?? []) as any[], (ctx as any).profile);
          // FEATURE 16: a resume sent as a file (Telegram): the upload recorded is the person's file, by its reference and
          // the sha256 of its bytes (career_resume_uploads), when the message that carried the entries was that file's text.
          seen.upload = await fileUploadFor(admin, user.id, seen.upload);
          // END FEATURE 16
          const ev = await evidenceResumeConfirmation({ userId: user.id, now: Date.now(), message, before: (loaded.account as any)?.memory?.profile ?? (loaded.snapshot as any)?.stores?.profile ?? null,
            after: (ctx as any).profile ?? null, out, shown: seen.shown, upload: seen.upload, said: seen.said, events: confirmEvents });
          confirmEv = ev;
          if (ev.unshown || ev.untraced || ev.refused) console.error(`career evidence: held as drafts: ${ev.unshown} not shown, ${ev.untraced} not in the upload, ${ev.refused} event not recorded`);
          // A confirmation the host could not evidence is not claimed: those facts are drafts again, and the reply says so.
          const held = heldReply(ev);
          if (held) out = { ...out, reply: held, resultStatus: ev.stamped ? "partial" : "not_confirmed" };
        }
      }
      // ONBOARDING ROUND 3: a confirmed entry the person corrected in chat gets its own held confirmation event; one that
      // cannot be evidenced goes back to the words they confirmed, and the reply says nothing changed.
      if (out.handler !== "agent" && out.intent === "career_resume_correction" && out.resultStatus === "completed") {
        const ec = await evidenceEntryCorrections({ userId: user.id, now: Date.now(), message, before: (loaded.account as any)?.memory?.profile ?? (loaded.snapshot as any)?.stores?.profile ?? null,
          after: (ctx as any).profile ?? null, out, events: confirmEvents });
        if (!ec.stamped) out = { ...out, reply: correctionNotRecordedReply, resultStatus: "not_recorded" };
      }
      // FEATURE 1: answer capture (DIAGNOSIS F1): the router's batch stack records a chat answer to a stopped application
      // on its own run; the queue executor reads career_apply_questions. The same answer goes on the person's matching
      // open question there too, checked against its choices; the reply says so only when it was recorded.
      if (out.handler !== "agent" && out.intent === "career_batch_apply") {
        const f1 = await feature1.afterRouter({ reply: out.reply, before: (loaded.snapshot as any)?.stores?.profile ?? null, after: (ctx as any).profile ?? null,
          runBefore: (loaded.snapshot as any)?.stores?.batchApplyState ?? null, runAfter: (ctx as any).batchApplyState ?? null });
        if (f1.reply !== out.reply) out = { ...out, reply: f1.reply };
      }
      // FEATURE 1 end
      // FEATURE 4: tailored resume rewrite. The router's tailored resume (select and reorder) gets its bullets reworded
      // toward the posting by the model, each one kept only if the truth audit traces every word, number and name to the
      // fact it cites; the PDF is re-rendered and the reply says what changed and why. CAREER_TAILOR_REWRITE=on only;
      // off, or a model failure, leaves today's resume. One metered call.
      if (out.handler !== "agent" && out.intent === "career_tailor" && (out as any).result?.tailorDoc) {
        const rwMeter = ledger.track(newMeter());
        const rwCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
        const voiceSamples = (ctx as any).outreach?.voiceSamples ?? null;
        const rw = await tailorRewriteTurn({ out: out as any, profile: (ctx as any).profile ?? null, on: rewriteOn(Deno.env),
          model: (payload) => callModel(rwCfg, payload, { meter: rwMeter, role: "chat" }),
          voice: Array.isArray(voiceSamples) && voiceSamples.length ? CareerWriting.extractVoiceProfile(voiceSamples) : null })
          .catch((e) => { console.error("tailor rewrite:", e?.message ?? e); return null; });
        if (rw?.summary) { out = rw.out as typeof out; agentMeta = { ...(agentMeta || {}), tailor_rewrite: rw.summary }; }
        await ledger.record(rwMeter);
      }
      // END FEATURE 4
      // FEATURE 9: account memory. After a router turn, the facts the person stated in this message get their provenance
      // event, and a standing need the router did not act on is kept on the account (_shared/career_account_memory.ts).
      // The profile and the tracker themselves ride the account record through the host seam (career_host.js).
      if (out.handler !== "agent" && !siteNo && !careerTask && !careerBatch && !host.isHostControlled(message, ctx)) {
        const mem = await accountMemoryAfterTurn({ message, userId: user.id, threadId: tid, now: Date.now(), out, ctx,
          statedBefore: statedFactsBefore(loaded.account, loaded.snapshot), events, evidence: confirmEvents, standing: supabaseMemoryStore(admin) })
          .catch((e) => { console.error("career memory:", e?.message ?? e); return null; });
        if (mem?.patch) out = { ...out, ...mem.patch };
      }
      // END FEATURE 9
      let taskIntent = null;
      let batchIntent = null;
      const pausedReadback = careerTask && ["status", "reconcile"].includes(careerTask.action) && out.intent === "career_paused" && !ctx._hostPatch;
      if (careerTask && (out.handler !== "CareerHostControl" || pausedReadback)) {
        const plan = await planCareerTaskIntent({ taskRequest: careerTask, message, userId: user.id, threadId: tid,
          turnKey, requestHash, ctx, accountVersion: loaded.accountVersion, account: loaded.account, persistence });
        out = plan.out; taskIntent = plan.intent;
      }
      // J10 batch delegation: a structured career_batch request
      // (status readback / approve) plans exactly like the task path
      // above; a plain batch ASK in delegate mode is detected from
      // the seam's outcome + the skeleton it left on ctx, and its
      // prepare intent is planned from that skeleton. Either way the
      // intent commits transactionally with the reply below, and the
      // reply never claims a state the worker has not written.
      const pausedBatchReadback = careerBatch && careerBatch.action === "status" && out.intent === "career_paused" && !ctx._hostPatch;
      if (careerBatch && (out.handler !== "CareerHostControl" || pausedBatchReadback)) {
        const plan = await planCareerBatchIntent({ batchRequest: careerBatch, message, userId: user.id, threadId: tid,
          turnKey, requestHash, ctx, accountVersion: loaded.accountVersion, account: loaded.account, persistence,
          summarizeRun: (run: unknown) => { const r = CareerBatchApply.restoreRun(run); return r ? CareerBatchApply.speakSummary(r).join("\n") : null; } });
        out = plan.out; batchIntent = plan.intent;
      } else if (delegateBatch && batchExecutorLive && !careerBatch && out.intent === "career_batch_apply" && out.result && out.result.batchDelegate && ctx.batchApplyState) {
        const plan = await planCareerBatchPrepare({ run: ctx.batchApplyState, userId: user.id, threadId: tid,
          turnKey, requestHash, accountVersion: loaded.accountVersion, account: loaded.account });
        if (plan) { batchIntent = plan.intent; out = { ...out, batch: plan.batch }; }
      } else if (!careerBatch && out.intent === "career_batch_apply" && ((out as any).result?.batchDelegate || (out as any).batchDelegate)) {
        // WO-106 (F5; live 2026-10-21, MUSE-F-001/005): "I've handed this to the browser worker" committed a prepare intent
        // that no deployed process runs (batch-executor.cjs is reached only from tests; the worker's run.cjs never loads
        // it), so the batch sat "queued" forever. Until CAREER_BATCH_EXECUTOR=on says an executor drains the intents,
        // nothing is committed, the run is not kept, and the reply says exactly what happened and where applying runs.
        delete (ctx as any).batchApplyState;
        out = { ...out, reply: BATCH_NOT_STARTED_REPLY, resultStatus: "not_started" };
      }
      // V1 TEXTING VOICE (_shared/career_reply_writer.ts; PRODUCT AUDIT 2026-10-28): the final reply, written in Trainee's
      // texting voice and checked against this turn's facts (D-007); a rejected or failed write falls back to today's reply
      // with its boilerplate and internal sentences taken out. CAREER_REPLY_WRITER=on only; turns that show an exact
      // payload the person approves are never rewritten. Nothing upstream changes.
      if (replyWriterOn(Deno.env) && writable(out, agentMeta, { structured: !!(careerTask || careerBatch) })) {
        const wMeter = ledger.track(newMeter());
        const wCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
        const written = await writeReply({ on: true, message, channel: writerChannel((body as any)?.channel),
          facts: factsForTurn({ reply: out.reply, intent: out.intent, resultStatus: out.resultStatus ?? null, effects: turnEffects, situation }),
          model: (payload) => callModel(wCfg, payload, { meter: wMeter, role: "chat" }) })
          .catch((e) => { console.error("reply writer: today's reply stands:", e?.message ?? e); return null; });
        if (written && written.text.trim()) {
          if (written.text !== out.reply) out = { ...out, reply: written.text };
          agentMeta = { ...(agentMeta || {}), reply_writer: { source: written.source, rejected: written.rejected.slice(0, 8) } };
        }
        await ledger.record(wMeter);
      }
      // REPLY SHAPE (_shared/channel_shape.ts): on Telegram with the writer on, the answer is one short paragraph, detail rides as
      // files and links as their own messages (the channel sends them in that order). A turn that shows an exact payload is untouched.
      let shapeField: { attachments: { filename: string; content: string }[]; links: string[]; more?: string[] } | null = null;
      {
        // OVERFLOW (owner, 2026-10-29): never a downloaded file. With the hosted-file service configured (TRAINEE_FILE_BASE_URL) the rest of
        // a long answer is a research_brief page, sent as a link; it needs a source the turn really had. Anything else: a second message.
        let overflowLink: string | null = null;
        const longRest = replyWriterOn(Deno.env) && writerChannel((body as any)?.channel) === "telegram" ? splitLongAnswer(withoutLinks(out.reply)) : null;
        const src = (turnLinks ?? []).find((u) => /^https:\/\//.test(u));
        if (longRest?.full && src && (Deno.env.get("TRAINEE_FILE_BASE_URL") || "").trim()) {
          const made = await createFileService({ store: supabaseFileKindStore(admin), env: Deno.env, now: Date.now }).create(user.id, "research_brief", {
            title: "More on your question", subject: "Your question", findings: chunkSentences(longRest.full, PAGE_CHUNK_CHARS, PAGE_MAX_CHUNKS).chunks.map((value, i) => ({ label: i ? `The rest of the answer (${i + 1})` : "The rest of the answer", value, source: "Reported, not verified" })), sources: [{ title: new URL(src).hostname, url: src }] }).catch(() => null);
          // TELEGRAM SCENARIOS (2026-10-30): only the signed link. A Mini App URL (webApp) opens only from Telegram's own button;
          // sent as a plain link it opened in the browser signed out, and the rest of the answer (not sent as a second message)
          // was lost. Without the signed link the rest goes as the second message.
          if (made && made.ok && made.url) overflowLink = made.url;
        }
        const sh = shapeForTurn({ overflowLink, on: replyWriterOn(Deno.env), channel: writerChannel((body as any)?.channel), reply: out.reply, attachments: turnAttachments, allowedLinks: turnLinks,
          writable: writable(out, agentMeta, { structured: !!(careerTask || careerBatch) }) });
        if (sh.reply !== out.reply) out = { ...out, reply: sh.reply };
        shapeField = sh.shape;
        // FILE KINDS: the links to the pages create_file made were minted by code; they are sent after the answer whatever the shape decided.
        if (turnFileLinks.length) shapeField = { attachments: shapeField?.attachments ?? [], links: [...(shapeField?.links ?? []), ...turnFileLinks.filter((l) => !(shapeField?.links ?? []).includes(l))] };
        if (sh.notes.length) agentMeta = { ...(agentMeta || {}), reply_shape: sh.notes.slice(0, 8) };
      }
      // ONBOARDING SCENARIOS (2026-10-29): a turn answered here, before or beside the host (a card, an apply, a connector, the
      // brain), still ends a pending resume ask's turn: a later bare yes is that turn's, not the resume's (career_host.js).
      (host as any).noteTurn?.(ctx, out.intent);
      for (const rec of ctx.containmentRecords ?? []) console.error("career containment:", JSON.stringify(rec));
      // CHANNEL-DOC-1: documents the turn produced (the tailored
      // resume PDF; the delivery handler's documents) are materialized
      // into the owner-scoped artifact store and ride the reply as
      // bytes-refs — the bytes never ride the reply itself. A document
      // that fails to store is dropped from the contract and said so
      // on the reply; it is never claimed attached.
      let artifactsField: any[] | undefined;
      let artifactNote = "";
      {
        const docs = documentsOf(out.result);
        if (docs.length) {
          const m = await materializeArtifacts(admin, { userId: user.id, threadId: tid, documents: docs });
          if (m.artifacts.length) artifactsField = m.artifacts;
          if (m.failed > 0) artifactNote = "One file from this turn couldn't be attached here — ask me to send it again and I'll rebuild it.";
        }
      }
      // LAUNCH READINESS X7: a model call refused by the daily ceiling (or an unreadable spend) is said, never hidden.
      const spendNote = spend.note();
      if (spendNote) {
        out = { ...out, reply: `${out.reply}\n${spendNote}`, ...(out.parts ? { parts: [...out.parts, spendNote] } : {}) };
        agentMeta = { ...(agentMeta || {}), model_limit: spend.refused() };
      }
      const reminders = Array.isArray(loaded.reminders) ? loaded.reminders : [];
      const reminderLines = reminders.map((r:any) => typeof r.speak_line === "string" ? r.speak_line.slice(0,2000) : "").filter(Boolean);
      const respond = () => {
        const reply = (flowCtx.note ? `${flowCtx.note} ${out.reply}` : out.reply) + (artifactNote ? `\n${artifactNote}` : "");
        const visibleReply = [reply, ...reminderLines].join("\n");
        // The same reply as separate messages for a texting channel: the note, each part whole, then the reminders.
        const parts = out.parts ? [...(flowCtx.note ? [flowCtx.note] : []), ...out.parts, ...(artifactNote ? [artifactNote] : []), ...reminderLines] : null;
        return { thread_id: tid, reply: visibleReply, action: null, capabilities: out.capabilities, turn_key: turnKey, reminders, ...(out.task ? { task: out.task } : {}), ...(out.batch ? { batch: out.batch } : {}), ...(parts ? { parts } : {}), ...(artifactsField ? { artifacts: artifactsField } : {}), ...(turnPostings.length ? { postings: turnPostings } : {}), ...(shapeField ? { shape: shapeField } : {}), meta: { career: true, intent: out.intent, result_status: out.resultStatus, contained: out.contained, ...(agentMeta || {}) } };
      };
      const commitTurn = (events: unknown[]) => persistence.commit({ userId: user.id, threadId: tid, turnKey, requestHash, revision: loaded.revision, accountVersion: loaded.accountVersion, snapshot: host.extractSnapshot(ctx), patch: ctx._hostPatch, input: userContent, response: respond(), taskIntent, batchIntent, events });
      const confirmRows = confirmEvents.rows();
      let saved;
      try {
        saved = await commitTurn(confirmRows);
      } catch (error) {
        // RESUME CONFIRM RACE (2026-10-30): the save and the confirmation's events commit together, so an event that could
        // not be written failed the whole commit. A refused save (another thread saved first) is still refused and said
        // ("send it again"). Any other failure of the evidenced commit: the confirmation is not claimed. Its entries go
        // back to drafts, the turn is saved without them, and the reply says nothing was confirmed (a failure of that
        // save as well answers as unsaved, below).
        const code = error && typeof error === "object" && "code" in error ? String((error as any).code) : "storage_unavailable";
        if (!confirmRows.length || CONFLICT_CODES.includes(code)) throw error;
        console.error("career evidence: the confirmation's events were not recorded; its entries stay drafts:", (error as Error)?.message ?? error);
        const ids = new Set(confirmRows.map((e: any) => e?.detail?.confirmation_event_id).filter(Boolean));
        const unstamped: string[] = [];
        for (const f of Array.isArray((ctx as any).profile?.facts) ? (ctx as any).profile.facts : []) {
          if (!f || !ids.has(f.confirmation_event_id)) continue;
          Object.assign(f, { status: "draft", needs_confirmation: true });
          for (const k of ["provenance", "confirmation_event_id", "confirmed_at", "source_ref"]) delete f[k];
          unstamped.push(f.id);
        }
        // KNOWN GAPS (2026-10-30): a fact stated in chat whose event was not written stays a statement on the record, never
        // called confirmed (evidenceStatedFacts' rule for an event that cannot be recorded); its reply is unchanged.
        for (const f of Array.isArray((ctx as any).statedFacts?.facts) ? (ctx as any).statedFacts.facts : []) {
          if (!f || !ids.has(f.confirmation_event_id)) continue;
          for (const k of ["provenance", "confirmation_event_id", "confirmed_at"]) delete f[k];
        }
        // The account memory and stated facts the first try put on the patch carried the stamps; extractSnapshot rebuilds them.
        if (ctx._hostPatch && ("memory" in ctx._hostPatch || "stated_facts" in ctx._hostPatch)) { const { memory: _m, stated_facts: _s, ...rest } = ctx._hostPatch; ctx._hostPatch = rest; }
        if (confirmEv) {
          const ev: EvidenceResult = { ...confirmEv, stamped: Math.max(0, confirmEv.stamped - unstamped.length), refused: confirmEv.refused + unstamped.length, held: [...confirmEv.held, ...unstamped] };
          out = { ...out, reply: (heldReply(ev) ?? out.reply) + (spendNote ? `\n${spendNote}` : ""), parts: undefined, resultStatus: ev.stamped ? "partial" : "not_confirmed" } as typeof out;
        } else if (unstamped.length) {
          // The brain's confirm_profile_fact: its reply said the fact was confirmed; it is not, so the reply says so instead.
          out = { ...out, reply: confirmNotRecordedReply(unstamped.length) + (spendNote ? `\n${spendNote}` : ""), parts: undefined, resultStatus: "not_confirmed" } as typeof out;
        }
        saved = await commitTurn([]);
      }
      // WO-028: "forget everything" also removes the tailored resumes (they carry the person's name and email); best
      // effort, after the erase is recorded, like the rest of the erase's side effects.
      if (ctx._hostPatch?.erase === true) await supabaseResumeStore(admin).removeAll(user.id).catch((e) => console.error("career erase: resumes", e?.message ?? e));
      // A job watch set, changed, paused or stopped by text is the person's alert settings, which the scheduled alerts
      // run reads (career_watch_alerts.ts). After the save: a refused save writes none; a failed write never fails it.
      await syncWatchAlerts({ userId: user.id, before: loaded.watchState, after: ctx.alertWatchState, erased: ctx._hostPatch?.erase === true, store: supabaseAlertStore(admin), now: Date.now() })
        .then((r) => { if (r.action === "refused") console.error("career watch alerts: not saved:", r.reason); })
        .catch((e) => console.error("career watch alerts:", e?.message ?? e));
      flowCtx.note = null;
      return json(cors, saved.response, 200);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "storage_unavailable";
      turnEffects.on = false;
      const conflict = CONFLICT_CODES.includes(code);
      return json(cors, { error: code, reply: conflict ? refusedSaveReply(code, turnEffects) : UNSAVED_REPLY, action: null, turn_key: turnKey,
        turn_effects: turnEffects.writes.size > 0 || turnEffects.queued > 0 || turnEffects.sent > 0 || turnEffects.sendUnknown > 0 }, conflict ? 409 : 503);
    } finally {
      await ledger.finish().catch((e) => console.error("turn cost ledger:", e?.message ?? e));
      await gate?.leave();
    }
  } catch (e) {
    console.error(e);
    return json(cors, { error: "internal" }, 500);
  }
}

function json(cors: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}
