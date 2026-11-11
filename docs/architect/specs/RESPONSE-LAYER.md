# Response layer inventory (WO-N)

Purpose: the inventory for work order WO-N (response layer). It lists every place where the words of a chat reply a
person sees are produced or changed, says whether a model or a template writes them, which intent each serves, and which
release flag gates it. Date: 2026-11-09. Code read at trunk 8a2d67c9. Line numbers are 1-based and drift as trunk moves; the function names are the stable anchor.

Kinds: **model** = the words come from a model call; **template** = fixed or code-assembled strings; **mixed** = a model
writes part of the text, or code rewrites, cuts or appends text around model words.

Flags are read from `supabase/functions/agent-chat/release_config.ts`:
- `RELEASE_FLAGS` (served on, environment can only turn off), lines 97-112: `CAREER_TEXTING_NATIVE`,
  `CAREER_NETWORKING_DRAFT`, `CAREER_TAILOR_REWRITE`, `CAREER_MOCK_JUDGE`, `CAREER_EMAIL_SEND`, `CAREER_OUTREACH_SEND` and others.
- `PRODUCTION_BRAIN = "staged"` (line 27); rollback `CAREER_BRAIN=router` (lines 30-31).
- `RELEASE_PENDING` (off until measured), lines 138-142: `CAREER_PLANNER`, `CAREER_CRISIS_MODERATION`, `CAREER_BATCH_EXECUTOR`.
- `RELEASE_NEVER_ON`, lines 153-159: includes `CAREER_REPLY_WRITER`, `CAREER_JUDGE`, `CAREER_KNOWLEDGE`, `CAREER_MAIL_MODEL`,
  `CAREER_RESEARCH_REPLY`, `CAREER_RESEARCH_BRIEF`, `CAREER_OUTREACH_REPLIES_MODEL`, `CAREER_CONTACT_OUTREACH`, `CAREER_PEOPLE_SEARCH`.
- `CAREER_APPLY_ALL_YES` is served on by code (lines 114-123), not a release flag.

Consequence that shapes the whole inventory: `CAREER_REPLY_WRITER` is never on, so the rewriter, the readiness ask and the
Telegram reply shape (sections 1 and 7) do not run in production. In production the only model-written chat prose is the
staged brain (for the intents in `career_staged.ts` `STAGED_BRAIN_INTENTS`), outreach and email drafts, the tailor bullet
rewrite, and the mock judge's fix line. Every action turn's words are templates from the router or a `_shared` handler.

The deployed entry is `agent-chat/index-career.ts` -> `handler-career.ts` (index-career.ts lines 1-10). `handler.ts` is the
shelved finance entry; what it does is listed in section 3 only so nobody mistakes it for the career path.

---

## 1. Model reply writers

| Source (file:line / function) | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `_shared/career_reply_writer.ts:401` `writeReply`; prompt `VOICE_RULES` 362-368, per-channel `FORMAT` 369-375, `writerPayload` 376-391 | Every writable non-brain turn (`rewrites()` 76-78); skips `PAYLOAD_INTENTS` 46-54, `PAYLOAD_META` 56, parts, `Subject:` drafts (58-69) | mixed | `CAREER_REPLY_WRITER=on` (41); NEVER_ON | Off in production. On rejection: `templateReply` 313-338 for payload intents, else `withoutInternal` 348-358. Checks: `factCheck` 222, `voiceCheck` 271, `CANNED` 249-255, `INTERNAL` 256-259 ("router", "payload", "snapshot", "in this run"...), `BOILER` 292-299. Called from handler-career.ts 1553-1565. |
| `agent-chat/career_brain.ts:70` `agentTurn`; system prompt built at 140 | `STAGED_BRAIN_INTENTS` (career_staged.ts 41-54): unclaimed, catch-all, fallback, out_of_scope, greeting, conversation_ack/clarify, guidance, resume/cover-letter guidance, field/offer decision, life event, next step, path_answer, application_fields, recommendations, approval_rule, prep_brief, company_intel, negotiation_advice (the last two only without a sourced record, 56-67) | model | `PRODUCTION_BRAIN="staged"`; needs model key (handler-career.ts 1102); `AGENT_BRAIN_RELEASED=false` (career_brain.ts 33) keeps the full agent off | Called at handler-career.ts 1246-1315; reply is `turn.reply`, handler `"agent"` (1313). Never rewritten by the writer (career_reply_writer.ts 72, 403). |
| `_shared/agent/prompt.ts:2` `careerSystemPrompt`; `SHAPE_RULES` 166-172; `NO_ATTACH_RULE` 174 | brain turns | model (instructions) | `SHAPE_RULES` only when writer on and channel is Telegram (handler-career.ts, `shape:` in the agentTurn call, near 1275) | Says "under 700 characters" for Telegram. Off in production with the writer. |
| `_shared/agent/style.ts:8` `MANNER`; `STYLE_EXAMPLES` 18+; `styleBlock` 79 | brain turns | model (instructions + few-shot) | always with the brain | "Answer first, then the one next step. Most replies are 1 to 4 short lines." Example T03 (style.ts 23-24) itself promises "I'll look for...": a model can copy that promise. |
| `agent-chat/career_staged.ts:506` `routerAnswerBlock`; `STAGED_PROMPT_NOTE` 535-537 | brain turns that the router also answered | model (router reply passed as data) | staged brain | The router's template reply goes into the prompt as "what Trainee's built-in steps would have replied" (518). "built-in steps" is prompt-only text, never sent. |
| `_shared/agent/loop.ts:248` `runAgentTurn`; guard and repair block 333-395 | brain turns | mixed | always with the brain | One review round (352-362), then code edits: `rebuild` drops unbacked claims, figures, waiver wording (370); `stripLeaks` (376); `closedNotes` prepends (378-379); `bracketUntraced` (380); `stripSecrets` (382). `multiAsk`/`missingAck`/`unbackedPromises` are flag-only (343-345, 393). The review text says "from Upmore's code" (360): prompt-only. |
| `_shared/agent/loop.ts:51-67` fixed replies | brain failures | template | brain | `MAX_STEPS_REPLY` 51, `MODEL_ERROR_REPLY` 52, `*_AFTER_SAVE_REPLY` 54-55, `INCOMPLETE_*` 56-57, `CLAIM_UNBACKED_REPLY` "I didn't change anything this time." 65, `SECRET_DROPPED_REPLY` 67; used at 304, 371, 382. |
| `_shared/agent/career_tools.ts:53` `EMPTY_SEARCH_NOTE` | brain search tool | model (tool note) | brain | Tells the model the person sees only its reply. |
| `_shared/research_reply.ts:66` `composeResearchDraft`; `buildResearchReply` 125; `renderReport` 192; `researchTurn` 312 | market research on brain turns | mixed | `CAREER_RESEARCH_REPLY=on` (24), brief file `CAREER_RESEARCH_BRIEF`; both NEVER_ON | Off in production. Wired into agentTurn at handler-career.ts ~1292-1300. |
| `_shared/agent/research/ground.ts` (gateway search) | brain research tool | model | `CAREER_KNOWLEDGE` (NEVER_ON) and `WEB_SEARCH_AVAILABLE` (handler-career.ts ~1301) | Off in production. |
| `_shared/readiness_ask.ts:88` `writeReadinessAsk`; checks `askProblems` 41 | role search: the first blocking apply question | model | only with `CAREER_REPLY_WRITER=on` (handler-career.ts 1388) | Off in production. Appended to the search reply (1394-1395). |
| `_shared/career_tailor_rewrite.ts:223` `tailorRewriteTurn`; `rewriteResume` 179 | `career_tailor` | mixed | `CAREER_TAILOR_REWRITE` on (25, 29) | Model rewords resume bullets under `auditRewrite` (75); reply gets code line "What changed: ..." (248) or the "No bullet was reworded..." line (245). Called at handler-career.ts 1487 and 938. |
| `_shared/career_outreach.ts:560` `draftFor`; `draftText` 592; `batchMessages` 602 | outreach / networking drafts (`career_networking_draft`, `career_outreach_batch`) | mixed | `CAREER_NETWORKING_DRAFT` on; called from career_networking.ts 780, reply parts 807 | Model writes the email body under `outreachLock` (363); code writes the head and framing. Payload intents: never rewritten. |
| `_shared/career_apply_email.ts:100` prompt, 115-128 refusals; `emailTurn` (handler-career.ts 741, 1153) | `career_apply_email` | mixed | `CAREER_EMAIL_SEND` on (send); draft model passed by handler | Model writes body sentences only (16). Refusal strings are templates (115, 128). |
| `_shared/essay_draft.ts:272` `draftEssay`; `draftPayload` 230; AI-policy gate 440 | essay answers on application forms (`career-essay-draft` function) | mixed | AI policy (`ai_policy.ts` `readAiPolicy`), daily cap | Shown through the essay card (section 6). |
| `_shared/career_mock_prep.ts:522` `modelJudge`; system prompt 515-520 | `prep_mock_next`, `prep_mock_followup`, mock debrief | mixed | `CAREER_MOCK_JUDGE` on (506) | Model returns JSON `{covered, verdict, fix}`; `fix` is "one short instruction" that can reach the feedback; the rest of the feedback is template (career_mock.ts). |
| `_shared/career_search_judge.ts:227` `judgePostings`; `judgePayload` 203 | role search ranking | mixed | `CAREER_JUDGE` (handler-career.ts 1327); NEVER_ON | Off in production: fit order stands. The search reply itself is template (section 2b). |
| `_shared/career_contact_draft.ts:83` `draftContactEmail` | contact outreach | model | `CAREER_CONTACT_OUTREACH` (NEVER_ON) | Off. `contact_draft.ts:57` `contactDraft` makes no model call (template). |
| `_shared/career_mail_model.ts:192` `secondPass`; `career_outreach_replies.ts:219` `understand` | mail classification, reply reading | model (labels, not prose) | `CAREER_MAIL_MODEL`, `CAREER_OUTREACH_REPLIES_MODEL` (NEVER_ON) | Produce verdicts; reply words stay template (`nextStep` career_outreach_replies.ts 260). |
| `agent-chat/career_planner.ts` (handler-career.ts 660) | multi-ask planning | mixed | `CAREER_PLANNER` (RELEASE_PENDING) | Off. When on, its reply goes out as `handler: "planner"` (1116). |
| `_shared/flow_router.ts:353` | finance router | model | Upmore (frozen) | Not on the career path. |

---

## 2. Router templated replies

### 2a. `packages/domain/142-career-router.js` (17,532 lines)

How the counts were made: each line inside a two-space-indented `function` was scanned for a string literal right after
`reply`, `headline`, `nextStep`, `recommendation` or `text` (`:` or `=`), a `facts.push("...")`, or a long capitalised
ternary string. That gives about 1,450 reply-string sites in the file. Counts below are approximate and per group.

All router prose goes through `compose()` (479-483) -> `CareerReply.composeResult` (140-career-reply.js 275) ->
`ensureNextStepText` (472-478) -> `CareerReply.ensureNextStep` (140-career-reply.js 376-395), which appends the
`GENERIC_CLOSER` "Tell me what you'd like to do next." (140-career-reply.js 338) when the reply has no next step.
`composeResult` adds "My take: " before a recommendation (140-career-reply.js 284). Bubbles hold at most 3 sentences
(`MAX_SENTENCES_PER_BUBBLE` 13); facts are capped at 6 sentences (297). Fixed fallbacks are `FALLBACKS` 123-131.

| Group (intent) | Main functions (line) | Approx. strings | Representative strings | Notes / rubric risk |
|---|---|---|---|---|
| Search / discovery (`career_discovery`, `career_internship_discovery`, `discovery_dead_board`, `named_role_link`) | `handleDiscovery` 519, `handleDiscoveryDelta` 653, `handleFitBuckets` 1134, `handleSalaryFilter` 1219, `handleMlForward` 1248, `handleDeadBoard` 10774, `handleFitFollowUp` 16631, `handleNamedPostingLink` 12950 | ~48 | 569: "No open roles at ${employer} on my list right now." / "I won't make any up, and I haven't put other employers' roles in their place."; 604: "I found no ${label} roles in the current list, and I will not pad it with other kinds of roles." | Search turns are usually replaced by the search judge reply (2b). "on my list", "current list" describe internals. |
| Apply / submit (`career_batch_apply`, `named_role_apply`, `career_packet`, `packet_*`, `doorstep_status`, `queue_halt`, `intent_*`) | `handleAutoApply` 5268, `handleNamedRoleApply` 12965, `handleBatchApply` 13281, `handleShortlistApply` 13419, `handleBatchStatus` 13480, `handlePacket` 1271, `handleBatchCard` 1106, `handlePacketWalkthrough` 16144, `handleApplyRules` 10104, `invalidationGate` 10883, `handleQueueCancel` 11141 | ~95 | 12989: "Plainly, about submitting applications:"; 13014: "I can't apply to the ${role} at ${company} yet — that posting is not in the list I can work from."; 13296: "I did not submit anything: your account is paused..." | 5309 "Auto-apply is off — here is the honest version of that ask." Many replies lead with process before the answer. |
| Apply status / tracking (`tracking_status`, `tracking_log`, `tracking_digest`, `season_dashboard`, `intent_followup_status`) | `handleTrackStatus` 8143, `handleTrackLog` 8040, `handleTrackMove` 8102, `handleInboxEvent` 9743, `handleApplicationStatus` 9954, `handleFunnel` 10021, `handleSeason` 10376, `handleTrackEventReport` 17103, `handleTrackerFollowUp` 2930 | ~110 | 8168: "Your offer expires ${day} — I will flag it daily until you decide."; 8180: "Thirty days of silence after a final round — that pattern is labeled ghosted." | 8168 promises a daily flag; check that a reminder is actually written (no claimed action without proof). |
| Resume / profile (`career_resume_ingest`, `career_resume_correction`, `career_resume_dispute`, `career_resume_bullet`, `profile_correction`, `profile_recall`) | `handleResumePasteIngest` 2117, `handleResumeIngestConfirm` 2390, `handleResumeDispute` 2566, `handleResumeFieldCorrection` 2670, `handleResumeBulletLoop` 3808, `handleStatedFactsReply` 16054, `handleSensitiveCorrection` 11075 | ~70 | 2154: "That looks like your resume, but it came through as one paragraph, so I can't tell where each entry starts without guessing."; 2446: "I did not confirm anything — the resume drafts on the record are not the ones I showed you." | 2446/2456 "That yes binds only to the exact resume content presented for approval" is system language. |
| Resume-confirmation tail (all non-fallback intents) | `handleChat` tail 17497-17510 | 2 | 17505-17507: "And nothing is sent anywhere before your resume is confirmed: paste or attach it, confirm it, then ask again." | **Boilerplate tail.** Appended to any reply to an apply-shaped ask when no resume is on record. The handler adds the same line again after a search (handler-career.ts 1351-1354). |
| Tailor / documents (`career_tailor`, `tailor_*`, `career_essay`, `career_tailor_diff`, `career_document_delivery`) | `handleTailor` 698, `handleEssayTailor` 964, `handleMultiTailor` 1033, `handleTailorNeedsFacts` 5592, `handleCoverLetterNeedsFacts` 5732, `handleTailorDiffAsk` 16118, `handleDocumentDelivery` 2034 | ~65 | 703: "I need the job posting to tailor against."; 710: "The truth check refused that tailoring, so nothing was saved." | "truth check" is an internal name. |
| Outreach / networking / people (`outreach_draft`, `outreach_clarification`, `people_matching_stop`, `graph_*`, `campaign_digest`, `intent_opt_out`, `calendar_proposal`) | `handleOutreach` 1508, `handleCampaignPlan` 1663, `handlePlanRecap` 4438, `handleTierMix` 4606, `handleGraphCatch` 9446, `handleKeepWarm` 5204, `handleGraphReferral` 5167, `handleSendAttempt` 3856, `handleOutreachOps` 10040, plus ~30 small handlers 4419-4890 | ~240 | 1549: "A draft to ${name} is ready." / "Approve it, edit it, or drop it — nothing goes out without your approval."; 1894-1896: "Building the list now: ${count} ${who}..." | **1895:** "Building the list now" and "The found, trustworthy, and sendable counts come back here before a single draft exists" claim work in progress; nothing in this function starts a job (it calls `persistPlan`, 1899). Claimed action without proof. |
| Research / company intel / career path (`company_intel`, `company_thesis`, `path_plan`, `career_os_*`, `career_proof_of_work`) | `handleIntel` 7156, `handleIntelGuidance` 9367, `handleCareerPath` 8992, `handleOS` 9098, `handleProofOfWork` 6265 | ~115 | 7273: "That role is not in the career knowledge library — stated plainly."; 9414: `HEADLINES` incl. "The window, checked against the record." (graduation_window), "The honest odds answer — no invented number." | **9414 graduation reply:** the headline names the method, not the answer; the fallback headline "Here is the honest answer, from the record." (9415) is the same pattern. "library", "the record" are internal. |
| Offers / negotiation (`negotiation_advice`, `negotiation_draft`, `negotiation_plan`, `negotiation_recall`, `negotiation_revision`) | `negotiationAdvice` 8598, `handleNegotiationCore` 8348, `handleNegotiationRecall` 8262, `handleOfferDetail` 4159, `handleCounterRevision` 4290, `handleDeclineDraft` 3880 | ~110 | 8608: "Offer intake: the letter becomes the log, field by field."; 8611: "Tax and legal questions get referred out — here is the line." | Headlines describe the process. Brain takes `negotiation_advice` only without an offer on record (career_staged.ts 56-67). |
| Interview / mock (`prep_brief`, `prep_plan`, `prep_mock_*`, `prep_needs_profile`, `calendar_proposal`) | `handlePrepSession` 5844, `handlePrepExtras` 6536, `handlePrepFile` 6117, `handlePrepQuestionSet` 6347, `handlePrepStart` 10491, `handlePrepAnswer` 10579, `handleMockDebrief` 10740, `handleReschedule` 10355 | ~150 | 10576: "Your mock starts now — one question at a time, scored feedback at the end." | The file with the most strings (`handlePrepExtras` ~58). |
| Alerts / watch (`career_watch_create`, `career_watch_manage`, `career_watch_affirm`, `career_watch`) | `handleWatchCreate` 11831, `handleWatchManage` 11984, `handleAlertPath` 12313, `watchListResult` 11970, `alertHistoryResult` 12281, `handleStarredWatch` 1167 | ~85 | 11383: "Job alerts are back on." / "Want the current watch list read back?" | |
| Erase / stop / pause (`career_erase_*`, `career_profile_erased`, `pause_status`, `queue_resume`, `paused_hold`, `conversation_hold`) | `handleErasePath` 3338, `handlePauseControl` 11327, `handlePauseGate` 1581, `handleHoldInstruction` 3398 | ~45 | 3347: "Nothing has been erased in this conversation."; 11396: "Done — the pause is lifted." / "Tell me what to pick back up first." | 3345 "From this conversation's record — yes." leads with provenance. |
| Eligibility (`eligibility_check`) | `handleEligibilityAsk` 16475, `handleWorkAuthThread` 3279 | ~18 | 16583: "Eligibility can't be graded without the posting — here is exactly what it takes." | **16577-16584 eligibility lecture:** a general list of what eligibility "will turn on" before the next step; does not answer the ask. "graded and spoken in that turn" (16583) is internal phrasing. |
| Onboarding / greeting (`career_greeting`, `career_onboarding_needs`, `career_application_fields`, `career_approval_rule`, `career_out_of_scope`, `career_field_decision`, `career_offer_decision`) | `greetingResult` 12929, `routeOnboardingNeeds` 12638, `routeFamily` 12818, `routeFieldDecision` 12699, `routeOfferDecision` 12731 | ~27 | 12932-12937: "Hi — I'm Trainee, your career agent." / "To start, paste your resume or attach the file — or just tell me the role you want." | Most of these intents go to the staged brain (career_staged.ts 41-54); the router text becomes prompt data. |
| Conversation / recall / catch-all / fallback (`career_catchall`, `career_fallback`, `conversation_*`, `honest_unavailable`, `career_guidance`, `career_next_step`) | `dispatchChat` 13552 (fallback 14975), `catchAllReply` 3635, `handleFrameContinuation` 2990, `handleThreadContinuation` 16932, `handleConversationRecall` 16181, `handleClarifying` 17219, `handleBareReply` 2879, `handleHonestUnavailableAction` 3470 | ~275 | 14975: `Reply.fallback("unmatched")` = "I'm Trainee, a career agent: I find roles, prepare and track your applications, and get you ready for interviews. I may have missed what you meant, so what should we work on first?" (140-career-reply.js 129); 3656: "Anytime." | Catch-all and fallback are brain intents under staged; under the router rollback these strings are sent. |
| Safety / refusal (`intent_refusal`, `safety_support`, `impersonation_refused`, `authority_refused`) | `handleRefusal` 4890, `handleAppendixSafety` 4967, `handleActAsMe` 5609, `handleAuthorityClaim` 5724 | ~17 | 4951: "I won't do that — here is what I will do instead." | Safety text is code's by design (ARCHITECTURE 3.1). |
| Multi-part asks | `handleChat` 17420; 17359, 17486, 17495 | 4 | 17359: "Still held from your earlier message: ... — say \"next\" and we continue." | Appends further parts to the first reply. |
| Billing, connectors | none in the router | 0 | | Handled in `_shared` (2c). |

### 2b. `packages/domain/141-career-doorstep.js` (1,658 lines, ~37 reply strings)

| Source | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `submitDoorstep` 673-720; `checkSubmitGuards` 488-520; `blockerRefusal` 318-326 | `doorstep_submit` | template | `UPMORE_SCRIPT_SUBMIT_LIVE` path | 707: "Submitted once to the local test sink and confirmed with receipt ${receipt_id}." **Internal words ("test sink") and an id.** 494-515: "I did not submit this application: ..." lead with the refusal (answer first). |
| `fillDoorstep` 559-575 | `doorstep_fill` | template | | 560: "The form driver is not available in this build, so I filled nothing." Internal word "build". |
| `reconcileDoorstep` 722 | `doorstep_status` | template | | |
| `haltQueue` 781-800 | `queue_halt` | template | | **795:** "Stopped everything I can reach: the global pause is now set for your account, which blocks every send path this product controls. ... Next step — the moment the queue records load, I reconcile them and report the exact counts here; you do not need to ask again." Claims a global stop on every path, and promises a later report no code in this function schedules. |
| `prepPacket` 863, `emitTrackingLog` 942, `emitCalendarProposal` 1228, `emitApplicationPacket` 1330, `emitOutreachDraft` 1458 | `packet_prep`, `tracking_log`, `calendar_proposal`, `application_packet`, `outreach_draft` | template | | |

### 2c. `_shared` handlers that answer before or instead of the router

The handler-career.ts else-if chain 1106-1245 picks the first that answers. String counts are lines with a capitalised
literal of 30+ characters.

| Source | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `_shared/career_search_judge.ts` `searchJudgeTurn` (empty result 452; freshness 457-460) | role search (handler `search_judge`, handler-career.ts 1357) | template | always on a search; model ranking only with `CAREER_JUDGE` | **452:** "I found no posting for ${ask}: ${liveNote}, and the saved snapshot has none either. ... Nothing was invented to fill the list. Widen the role or the place and I'll search again." "live board" (444) and "saved snapshot" are internal words; "Nothing was invented" is boilerplate. |
| `_shared/role_pay.ts:122` `resultsParts`; `role_results.ts:77` `resultsFile` | search results message + page link | template | links configured | "I found ${n} ... Here they are by fit, with Apply on each." then the link alone (role_pay.ts 126-131). |
| `_shared/apply_all_yes.ts:50-52` offer question; `PAGE_NOTE` 32 | results message ending | template | `CAREER_APPLY_ALL_YES` served on; only with a resume on file (handler-career.ts 1404) | "Reply yes and I'll apply to all ${n} shown. Each application's exact answers are on the page; I skip any with blank or sensitive answers." |
| `_shared/career_billing.ts` (63 strings; `PAY_BY_CHECKOUT` 18, `NOT_SUBSCRIBED` 307, 326) | billing | template | | handler-career.ts 1178. |
| `_shared/connectors.ts` (23; `GUARDED` 47, disconnect 222-223), `google_disconnect.ts` (8), `outlook_connector.ts` (27; 62, 67), `manual_connect.ts` (13; `NOT_WIRED_TEXT` 143) | connectors (Gmail, Outlook, manual sign-in) | template | | manual_connect.ts 143 names "Browserbase keys" and "this project": internal words. |
| `_shared/career_connector.ts:346-348` | people intros | template | | |
| `_shared/career_apply_status.ts` (status table 94-113, unreadable 177), `career_standing.ts` (122-134), `apply_status_summary.ts` | apply status, "where do I stand" | template | | handler-career.ts 1226, 1231. |
| `_shared/career_apply_cards.ts` `cardTurn` 478, `career_apply_questions.ts` (20), `career_apply_confirm.ts`, `career_apply_screen_answer.ts`, `apply_here.ts`, `career_apply_want.ts`, `career_apply_from_chat.ts` | card yes, open questions, confirm-which, screen answers, queue | template | | career_apply_questions.ts 330, 434: "type that one on the form yourself; Upmore never keeps it." **Wrong product name.** |
| `_shared/career_offer_chat.ts` (16; 143, 158, 189) | offers with market numbers (handler `offer`, 1242) | template | | 158: "So I have no market number for this one, and I won't make one up." |
| `_shared/career_mock.ts` (62) | mock interview (handler `mock`, 1141) | mixed | judge `CAREER_MOCK_JUDGE` | 249-250 "Unverified: a search summary of that page; no source check has opened the page yet." |
| `_shared/career_networking.ts` (27; `ADD_CONTACTS` 34, `NO_FINDER` 35, `SIGN_ASK` 36), `career_outreach.ts` (35), `career_outreach_track.ts` (33; 177, 248), `career_outreach_replies.ts` (45), `career_inbox_followups.ts` (30) | networking, outreach status, follow-ups | mixed (draft bodies model) | `CAREER_NETWORKING_DRAFT`, `CAREER_OUTREACH_FOLLOWUPS` | career_outreach_track.ts 177 "I'll text you a reminder ... on ${due}" is backed by `pushed: true`. |
| `_shared/career_activity.ts` (16), `career_redo.ts` (4), `career_undo.ts` (17; 52, 58, 69), `career_apply_receipt_read.ts` (15; 82, 87), `career_cloud_optin.ts` (6; 34, 96) | activity, redo, undo, receipts, cloud opt-in | template | | |
| `_shared/career_account_memory.ts:86-100` (patch replaces the reply, handler-career.ts 1497-1502) | standing instructions | template | | 100: "Kept on your account for every conversation: ... Job searches and alerts do not filter on it yet..." |
| `agent-chat/career_prep_file.ts:55, 60` (handler-career.ts 1506-1510) | interview prep File link | template | file links configured | Replaces the reply with summary + link parts. |
| `_shared/career_router_evidence.ts:146` `correctionNotRecordedReply`, 150 `heldReply`, 165 `confirmNotRecordedReply` | resume confirm / correction not evidenced | template | | Replace the router's reply (handler-career.ts 1440, 1453, 1468, 1652-1655). |
| `_shared/career_host.js:274-292, 591, 627` | `career_paused`, `career_resumed`, `career_profile_erased`, `career_preference_corrected` | template | | 627: fixed 2026-11-11 (router mirror fixes): "The browser that fills employer forms isn't connected here, so no employer form has been opened or submitted: I prepare the application, and it goes to an employer only after you approve that exact one.", placed after the answer's first line (was "Live browser execution is not wired in this handler", internal words). 284 "Existing chat/audit records may retain earlier text" is internal. |
| `packages/domain/143-career-containment.js:61` `LAST_RESORT` | any router turn that throws | template | | "Something went wrong on my end. Nothing was changed — try again in a moment and I will pick it back up." |

---

## 3. agent-chat handler code

| Source | Intent(s) | Kind | Gate/flag | Rewrites / appends / checks |
|---|---|---|---|---|
| `handler-career.ts:165` `UNSAVED_REPLY` | save failed | template | | Replaces the turn (1673). |
| `_shared/career_save_replies.ts:84` `refusedSaveReply`, `CONFLICT_REPLY` 107, leads 68-71 | save conflict | template | | Replaces the turn (1673). |
| `handler-career.ts:170` `BATCH_NOT_STARTED_REPLY`; `batchNotStartedReply` 181-187 | `career_batch_apply` with a delegate batch | template | `CAREER_BATCH_EXECUTOR` (pending, off) | Replaces the reply (1543). **"the runner for that kind of ask is not switched on": internal word "runner"**, and the reply is long (about 440 characters) with a how-to. |
| `agent-chat/crisis.ts:15` `crisisReply`; `CRISIS_INTENT` 28 | `safety_support` | template (988 text from `CareerIntel`/`CareerSafety`) | staged brain | Before every action turn (handler-career.ts 646-651) and after the router (1419-1421). Never rewritten. |
| `_shared/career_code_in_chat.ts:17` `CODE_IN_CHAT_REPLY`; `noteForCodeTurn` | `career_code_in_chat` | template | always | 656-658, 1115; excluded from the writer (1553). |
| `_shared/identity_redact.ts:214` `redactionNote` -> `flowCtx.note` (handler-career.ts 305-379) | any turn with a redacted card/account/password/code | template | always | **Prepended** to the reply (1613, and `handleChat` 202-212). 219-220: "Upmore never needs it here" / "Upmore's secure link". **Wrong product name in a Trainee reply.** `PAY_BY_CHECKOUT` appended for card/account (308). |
| `handler-career.ts:1136, 1192, 1206, 1211` joins | card + waiting email; queue + networking; tailor + queue | template | | Append a second handler's reply: "The email you asked for in the same message is still waiting for your approval:" (1136). |
| `handler-career.ts:1351-1354` `resumeLine` | role search on an apply ask without a confirmed resume | template | | **Appends** the resume-confirmation line to the search reply and as its own part (1376). Same text as router 17505-17507. |
| `handler-career.ts:1601` `artifactNote` | turn whose document failed to store | template | | **Appends** "One file from this turn couldn't be attached here — ask me to send it again and I'll rebuild it." (1613). |
| `handler-career.ts:1605-1608` `spendNote` | any turn with a refused model call | template (`model_budget.ts` 51-55) | global budget | **Appends** to reply and parts (section 5). |
| `handler-career.ts:1611-1614` `reminderLines` | any turn with due reminders | template (`speak_line` rows) | | **Appends** each reminder after the reply. |
| `_shared/agent/reply_guards.ts` (548 lines) via loop.ts 8 | brain turns | mixed | brain | See loop.ts row in section 1: `rebuild`, `stripLeaks`, `bracketUntraced`, `stripSecrets`, `closedNotes` rewrite; `multiAsk`, `missingAck`, `unbackedPromises` only check. |
| `_shared/claim_guard.ts:18` `CORRECTION`, 20 `guardMoneyClaim`; 41 `SECRET_SAFE`, 43 `guardSecretAsk` | finance replies | template, **appends** (23, 56) | `handler.ts` only (7, 557, 1227-1229) | Not on the career path (index-career.ts). `SECRET_SAFE` names "Upmore's secure link". |
| `_shared/conversation.ts:27` `SAFE_ERROR_REPLY` (207) | `runConversation` brain failure | template | conversation path | "Something went wrong on my side, so nothing was saved, sent or submitted. Send that again in a minute." |
| "You've reached today's limit on AI-written answers..." | — | — | — | **Not found** anywhere in `supabase/` or `packages/` at this date. The per-person cap was removed (D-046, career_spend_cap.ts comments). The nearest texts are section 5 and career_essay_card.ts 74. |

---

## 4. Acks and interims

| Source | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `_shared/channel_voice.ts:293-305` `ackFor` | any slow turn | template | sent after `FAST_ACK_MS` = 6000 ms (309); typing every `TYPING_EVERY_MS` = 4000 ms (308) | Lines: "on it — looking for roles now", "on it — checking your applications", "on it — getting that ready", "on it — reading that now", "on it — writing that now", "on it — setting that up now", default "on it — working on that now". At most one per message (`ackOnce` 334). |
| `_shared/channel_inbound.ts:288-292` `interim`; called at 523 (`ackFor("resume")` for a file) and 588 (`ackFor(said)`) | Telegram, WhatsApp, iMessage inbound | template | | Rendered with the channel's `render`; stopped before the answer (614). |
| `_shared/channel_inbound.ts:34` `CHAT_DOWN_REPLY` (591, 611, 703) | agent-chat failed or returned empty | template | | "I couldn't answer that just now. Try again in a minute." |
| `_shared/channel_inbound.ts:26-123` linking and media replies (about 30 constants, e.g. `SIGNUP_CLOSED_REPLY` 26, `FILE_NOT_READ_REPLY` 78, `PHOTO_NOT_READ_REPLY` 80, `VOICE_NOT_READ_REPLY` 81, `MEDIA_CAPTION_NOTE` 84, long-message cut note 100, Telegram link replies 51-77, 116-123) | channel linking, files, media | template | | `notesFirst` (242) **prepends** notes (media, cut, file) before the reply (607). |
| `_shared/channel_inbound.ts:264` `SCREEN_REPLY_YES_NO`; "Yes or no?" (650) | screen question after the reply | template | | Sent as an extra message. |
| `_shared/channel_inbound.ts:595` `needsReplyTextFor` (career_apply_cards.ts 442-450) | `CARD_NEEDS_REPLY_STATUS` | template | | Replaces the reply with channel-specific "Nothing was approved. To approve, ..." text. |
| `_shared/channel.ts:39-43` `CHANNEL_REPLIES` (stop, start, help); start prefix at channel_inbound.ts 603-606 | STOP / START / HELP | template | | START text is **prepended** to the first reply after /start. |
| `_shared/channel_inbound.ts:332, 492, 503` callback toasts | button taps | template | | "This button isn't for this chat. Nothing was approved." |

---

## 5. Error and limit notes

| Source | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `_shared/model_budget.ts:51-55` `GLOBAL_LIMIT_REPLY`, `BUDGET_BEFORE_REPLY`, `BUDGET_AFTER_REPLY`, `BUDGET_PAUSED_REPLY`, `BUDGET_UNAVAILABLE_REPLY`; `budgetReply` 58 | any turn whose model call the global budget refused | template | `MODEL_BUDGET_TARGET_USD` / `MODEL_BUDGET_HARD_USD` (67-77; default $70) | "Trainee has used up its AI budget, so I didn't use the AI for this reply." Appended by handler-career.ts 1607. "the owner's approval" (53) is internal to the operator. |
| `_shared/career_spend_cap.ts:60` `note()` | same | template | global only (D-046) | Wraps every model call of the turn (handler-career.ts 465). |
| `_shared/model_health.ts` | health endpoint | none | `HEALTH_CHECK_TOKEN` | JSON for operators; no chat words. |
| `_shared/ai_policy.ts` | employer AI policy on forms | none directly | | Decides whether essay_draft/career_apply_questions may draft; the words are in essay_draft.ts 440 and career_essay_card.ts 78: "This application doesn't allow AI-written answers." |
| `_shared/channel_present.ts:76-80` `VOICE.empty`, `VOICE.error`, `VOICE.rateLimited` | channel bridge errors | template | | "You've reached the limit of 60 messages an hour, so I didn't read that message and nothing was changed." |
| `_shared/channel_shape.ts:96` `PARTS_LEFT_NOTE` | answers longer than 4 parts | template | writer on + Telegram | "This answer is longer than 4 messages, so it stops here..." Off in production. |
| `_shared/conversation.ts:101` `CUT_NOTE` via `fitOutbox` 132-138 | any outbox text over 4,000 chars | template | | **Appends** "(That's where I had to stop. Ask me for the rest.)" after cutting (channel_inbound.ts 636-637). |

---

## 6. Card texts

| Source | Intent(s) | Kind | Gate/flag | Notes |
|---|---|---|---|---|
| `workers/career-browser/approve-first.ts:128-143` card lines; `_shared/career_prepared_card.ts:20-27` `CARD_MARK`, `resumeCardLine`, checks 60-70 | prepared application card | template | `CAREER_CLOUD_TEXT_CARDS` DB switch | Lines: company, one per answer ("You agree: ", "Your statement: ", "About this job: "), resume, "Also sent, set by the employer's page, unchanged: ...", "Sends to ${destination}". **`resumeCardLine` shows the first 12 hex characters of the resume hash** (25-26): an internal id on the card. |
| `_shared/career_apply_cards.ts` `cardTurn` 478; needs-reply texts 442-450; stale card 636, 665; skipped 349; list 401-408 | `career_apply_card` and card answers | template | | "That card was shown more than 10 minutes ago, so a text yes can't approve it; nothing was sent." |
| `_shared/career_essay_card.ts:65-78` `cardMessage` | essay draft card | mixed (draft is model, frame is template) | daily cap `DAILY_DRAFTS` | 70: "Drafted by Trainee only from your confirmed facts. ... It goes on the form only if you tap Use this."; 218 "Sign in to Upmore first." **Wrong product name.** |
| `_shared/career_cloud_card_chat.ts:31` `TAP_TO_SEND`; 41-43 | `career_message_approval` (text yes on a cloud card) | template | | "A text yes doesn't send anything. Tap Approve on the card above..." |
| `_shared/channel_card_tap.ts:39-41` `TAP_UNKNOWN`, `TAP_CHANGED`, `TAP_ANSWERED` | card taps | template | | |
| `_shared/channel_present.ts:75-90` `VOICE` | batch approval cards | template | | `approvalPrompt: "Batch ${runId} is waiting on your yes."` (86): **internal run id in the text.** `approvalAck: "Got it ✓"`. |
| `_shared/apply_all_yes.ts:50-52` | `career_apply_all_yes` offer | template | `CAREER_APPLY_ALL_YES` | See 2c. |

---

## 7. Channel shaping and bubbles (changes words, writes none, except the notes marked)

| Source | Channel | What it does | Limits |
|---|---|---|---|
| `_shared/channel_voice.ts:215` `formatForChannel` | all | Strips `<!-- -->`, puts links on their own line (`linksOnOwnLine` 26), removes part counters (`stripCounters` 56); SMS/iMessage no markdown (197), WhatsApp `*bold*` (211), Telegram HTML (203), web headings to bold | |
| `_shared/channel_voice.ts:237` `splitNatural`; `nativeRender` 280; `imessageNativeRender` 285 | Telegram, WhatsApp, iMessage | Splits by paragraph, line, sentence; never inside a link; formats after splitting | uses each adapter's `packChars` |
| `_shared/channel_adapters.ts:162` `packMessages` | Telegram, WhatsApp when `CAREER_TEXTING_NATIVE` is off | Packs paragraphs into messages up to max | `packChars` |
| `_shared/telegram.ts:27, 52, 266-268` | Telegram | `nativeRender("telegram", 1500)` when native, else `packMessages` | chars 4096, packChars 1500, 1 s per chat, 30/s overall |
| `_shared/whatsapp.ts:35, 39, 151-153`; window `channel_adapters.ts:212` | WhatsApp | same, `"whatsapp"` | chars 4096, packChars 1500, 1 s per chat, 50/s, service window 24 h minus 10 min |
| `_shared/loopmessage_adapter.ts:19-21`; `conversation.ts:140` `toBubbles`, `packBubbles` 104, 32-35 | iMessage | `imessageNativeRender` when native, else `toBubbles`; each bare link its own bubble; more than 2 links: no preview bubbles (149) | chars 5000, packChars 700, 250 ms per chat; `BUBBLE_CHARS` 700, `MAX_BUBBLES` 16, `OUTBOX_CHARS` 4000 |
| `_shared/channel_inbound.ts:232` `replyParts`; 635-637 outbox rows; `fitOutbox` 635-637 | all texting channels | Each part is one outbox row; a part over 4,000 is packed; a single reply over 4,000 is cut with `CUT_NOTE` | 4,000 per row; input read cap `CHAT_MAX` 4000 (88) |
| `_shared/channel_shape.ts:237` `shapeForTurn`; `shapeReply` 158; `answerParts` 114 | Telegram, writer on only (239) | One short paragraph, detail to files, links as own messages | `ANSWER_MAX_CHARS` 700, `FILE_MAX_BYTES` 6144, `MAX_FILES` 5, `MAX_LINKS` 5, `PART_MAX_CHARS` 4000, `MAX_ANSWER_PARTS` 4. Off in production. |
| `packages/domain/140-career-reply.js:275` `composeResult`, `splitBubbles` | router replies | Sentence caps; "My take: "; generic closer | 3 sentences per bubble, 6 fact sentences |
| web | web chat | `formatForChannel(..., "web")`; no split | none |

Note on lengths: Telegram and WhatsApp send at most 1,500 characters per message and iMessage at most 700 per bubble. A
router reply has no length cap of its own, so a long template reply arrives as several messages (or, on iMessage, up
to 16 bubbles).

---

## Order of the final reply (handler-career.ts)

The order in which code produces and changes the reply on one career turn, from the first writer to the channel bubbles.

1. **Input notes.** A redacted card, account, password or code sets `flowCtx.note` (305-379, `redactionNote`); a code or
   password in chat sets the code-in-chat turn (`codeFirst`, 652-658).
2. **Safety first.** Under the staged brain, `crisisReply` claims the turn before the planner and every action
   (646-651); else the code-in-chat text (656-658). The planner (660) runs only with `CAREER_PLANNER` (pending, off).
3. **Code-first handlers.** The else-if chain 1106-1245 takes the first that answered: connectors (1107), site refusal
   (1110), Outlook (1112), planned/crisis/code (1116), card (1123, with a waiting email appended at 1136), mock (1141),
   questions (1146), confirm (1149), email (1153), outreach (1156-1158), cloud (1160), apply-all yes (1163), cloud card
   (1167), pace (1170), employer ask (1173), billing (1178), cancel (1181), queue (1186; with networking 1192, tailor
   1206-1211), receipt (1218), follow-up (1221), standing (1226), status (1231), networking (1236), activity (1238),
   redo (1240), offer (1242), outreach status (1245).
4. **Staged brain.** Else, if the staged route sends the turn to the brain (`stagedRoute` 1100, ready 1102), `agentTurn`
   (1246-1315). Inside it the loop's guards rewrite the model text (loop.ts 333-395). Handler becomes `"agent"`.
5. **Router.** Else, the judge-prompt turn (1328-1331) or the router `host.runTurn` (1332). Inside the router: the
   handler's `compose()` text, then `handleChat`'s multi-part additions (142 17486-17495), the resume-confirmation tail
   (17505-17507), and `ensureNextStepText` with the generic closer (17510). A throw gives containment's `LAST_RESORT`.
6. **Search replacement.** If the turn is a role search (`askFor`, 1335-1336): `searchJudgeTurn` replaces the router's
   reply (1357) and appends `resumeLine` (1351-1354); the results page then replaces it with two sentences + link as
   parts (1374-1376); a readiness question is appended only with the writer on (1386-1399); the apply-all question is
   appended last (1404-1407).
7. **Crisis override after the router** (1419-1421).
8. **Evidence and memory replacements** (router turns only): resume confirmation held (`heldReply` 1440, 1453) or
   replaced-resume lines appended (1459); correction not recorded (1468); batch answer capture (1474-1476); tailor bullet
   rewrite and "What changed" line (1482-1491); account memory patch (1497-1502); prep File link (1506-1510).
9. **Task and batch planners** replace the reply for structured requests (1515-1538); an undeployed batch gets
   `batchNotStartedReply` (1543).
10. **Reply writer** (1553-1565): `CAREER_REPLY_WRITER` only (off).
11. **Reply shape** (1573-1584): Telegram with the writer on only (off); file links are kept either way (1581).
12. **Appended notes:** artifact failure note (1597-1601), spend note to reply and parts (1605-1608).
13. **respond()** (1612-1617): `flowCtx.note` prefixed, artifact note, then reminder lines (1611, 1614); parts get the same
    order. Commit (1619); if the evidenced commit fails, the reply is replaced again (1648-1656); any other failure gives
    `UNSAVED_REPLY` or `refusedSaveReply` (1673). `handleChat` (202-212) prefixes `ctx.note` once more only if it was not
    cleared (1667).
14. **Channel inbound** (channel_inbound.ts): `CHAT_DOWN_REPLY` for an empty reply (591); card-needs-reply text (595);
    START prefix (603-606); notes first (607); interim ack stopped (614); outbox rows from parts or `fitOutbox` (635-637);
    then the channel's `render` (section 7) makes the bubbles. Extra messages after: screen yes/no (647-651), job cards
    (654-657), documents (660).

---

## Main findings for the rubric

- Answers the ask first: router headlines often name the method ("The window, checked against the record." 142:9414;
  "Eligibility can't be graded without the posting — here is exactly what it takes." 142:16583; "Offer intake: the
  letter becomes the log, field by field." 142:8608) rather than the answer.
- Boilerplate tails: the resume-confirmation line is appended in two places (142:17505-17507; handler-career.ts 1351-1354);
  `GENERIC_CLOSER` "Tell me what you'd like to do next." (140:338, via 142:17510); "Nothing was invented to fill the list."
  (career_search_judge.ts 452).
- Claimed action without proof: "Building the list now" (142:1894-1896); doorstep global pause "blocks every send path
  this product controls ... I reconcile them and report the exact counts here; you do not need to ask again" (141:795);
  "I will flag it daily" (142:8168) needs a check that a reminder is written.
- Internal words and ids: "runner" (handler-career.ts 170), "live board" / "saved snapshot" (career_search_judge.ts 444,
  452), "in this handler" (career_host.js 627), "local test sink" + receipt id (141:707), "Batch ${runId}"
  (channel_present.ts 86), resume hash prefix on the card (career_prepared_card.ts 25-26), "Browserbase keys"
  (manual_connect.ts 143), "truth check" (142:710).
- Wrong product name "Upmore" in Trainee replies: identity_redact.ts 219-220 (prepended to any redacted turn),
  career_apply_questions.ts 330, 434, career_essay_card.ts 218.
- The only output-side voice layer (`CAREER_REPLY_WRITER`) is never on, so the rubric is enforced today only on staged
  brain turns (loop.ts guards). Every action turn ships its template as written, shaped only by channel splitting.
- Channel length: Telegram/WhatsApp 1,500 chars per message, iMessage 700 per bubble (max 16), outbox 4,000 per row with
  `CUT_NOTE`. Router replies have no length cap; `BATCH_NOT_STARTED_REPLY` is about 440 characters.
- The "today's limit on AI-written answers" note does not exist at this date; limit text is `model_budget.ts` 51-55.
