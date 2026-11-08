// REPLY CODE: the one definition of "the code that decides what Trainee replies" (D-034, the deploy standard's S3).
// A reply-quality measurement of one commit stands for another commit only when these paths are identical in both, and
// a measurement commit on ci/brain-eval carries exactly the measured commit's copy of them. Nothing else reads its own
// list: scripts/launch/deploy-standard.ts (S3) and scripts/launch/measure-reply.sh import this file.
//
// What is in it, and why:
//   packages/domain/                         the router's source (scripts/build-router-core.py --career-only bundles it)
//   supabase/functions/_shared/router_core.career.js   the router bundle itself (what the career entry imports)
//   supabase/functions/agent-chat/           the chat entry, the agent brain (career_brain.ts), the staged split
//   supabase/functions/_shared/agent/        the brain's loop, prompt, tools, reply guards, research and knowledge
//   SHARED_REPLY_MODULES below               every other _shared module the reply path imports: the static import closure
//                                            of the brain eval (evals/career/run.ts), file by file
// tests/architect/deploy-evidence.test.ts fails when the eval's import closure reaches a supabase/ or packages/ file this
// list does not cover (a new import must be added here), and when an entry names a file or directory that no longer
// exists (the list cannot rot silently). A path here that is not reply code costs only an extra measurement; a reply
// path missing here would let a reply change ride on an older measurement, so the test errs toward inclusion.

export const REPLY_CODE_DIRS = [
  "packages/domain",
  "supabase/functions/agent-chat",
  "supabase/functions/_shared/agent",
] as const;

export const ROUTER_BUNDLE = "supabase/functions/_shared/router_core.career.js";

export const SHARED_REPLY_MODULES = [
  "ai_policy.ts", "answer_options.ts", "apply_email.ts", "apply_status_summary.ts", "career_search_judge.ts", "posting_constraints.ts", "search_correction.ts", "career_pool.js", "apply_trust.ts", "approval_words.ts", "career_account_memory.ts",
  "career_alert_store.ts", "career_alerts.ts", "career_apply.ts", "career_apply_cards.ts", "career_apply_gate.ts",
  "career_apply_screen.ts", "career_apply_status.ts", "career_apply_want.ts", "career_brief_store.ts", "career_calendar.ts",
  "career_capabilities.ts", "career_contacts.ts", "career_digest.ts", "career_floor.ts", "career_fresh.ts", "career_hired.ts",
  "career_host.js", "career_ingest.ts", "career_ingest_feeds.ts", "career_ingest_stream.ts", "career_invite.ts",
  "career_mail.ts", "career_mail_gmail.ts", "career_mail_langs.ts", "career_mail_model.ts", "career_mail_store.ts",
  "career_materials_guard.ts", "career_mock.ts", "career_mock_prep.ts", "career_reader_model.ts", "career_offer.ts", "career_outreach.ts",
  "career_outreach_gmail.ts", "career_outreach_replies.ts", "career_path.ts", "career_people_gmail.ts",
  "career_people_import.ts", "career_people_page.ts", "career_people_provider.ts", "career_people_sites.ts",
  "career_referrals.ts", "career_router_evidence.ts", "career_search.ts", "career_send_rail.ts", "career_situation.ts",
  "career_staffing_agencies.ts", "career_tailor.ts", "career_url_shape.js", "career_voice_link.ts", "channel.ts",
  "channel_adapters.ts", "channel_card_tap.ts", "channel_shape.ts", "channel_text.ts", "conversation.ts", "essay_draft.ts", "essay_draft_baseline.ts",
  "fact_quarantine.ts", "fact_schema.ts", "file_design.ts", "file_kinds.ts", "file_link.ts", "file_page.ts", "file_service.ts",
  "identity_redact.ts", "length_limit.ts", "link_check.ts", "model_budget.ts", "model_calls.ts", "model_gateway.ts", "person_claims.ts", "person_claims_baseline.ts",
  "personal_fact_source.ts", "posting_key.ts", "posting_pay.ts", "posting_place.ts", "posting_region.ts", "posting_text.ts", "question_map.ts",
  "brand.ts", "row_answer.ts", "telegram_jobs.ts", "apply_all_yes.ts", "apply_all_yes_flag.ts", "role_results.ts", "career_resume_replace.ts",
  // 2026-11-06: the staged decision reads the writer's PAYLOAD_INTENTS; the code-in-chat safety turn (handler-career.ts).
  "career_reply_writer.ts", "career_code_in_chat.ts",
  // R9-C (2026-11-07): market research on the reply path: the search provider and what it imports (sources, the research
  // reply, its report store and the artifact it is delivered as).
  "research_search.ts", "research_sources.ts", "research_reply.ts", "research_report_store.ts", "channel_artifacts.ts",
  // R9 outreach (2026-11-08): who may be written to (no-reply, role and ATS/job-board inboxes never) and the staged route's
  // reading of an ask to write to someone.
  "automated_inbox.ts", "outreach_ask.ts",
] as const;

// D-036 (release flags, agent-chat/release_config.ts RELEASE_FLAGS): the code behind every flag the release serves ON that
// changes what the person is sent, outside the eval's import closure. The release config itself is under agent-chat (so
// flipping a flag is a reply-code change); these are the modules each ON flag switches on, so changing one re-measures:
//   task/                     CAREER_PLANNER's plan and reminders (the planner itself is agent-chat/career_planner.ts)
//   channel_voice.ts, channel_registry.ts, trainee-telegram/handler.ts, trainee-inbound/handler.ts, trainee-deliver/handler.ts
//                             CAREER_TEXTING_NATIVE: how each reply is split, formatted and paced on each channel
//   career_networking.ts      CAREER_NETWORKING_DRAFT's drafted outreach
//   career_tailor_rewrite.ts  CAREER_TAILOR_REWRITE's bullets
//   career_outreach_track.ts  CAREER_OUTREACH_FOLLOWUPS' reminder words; career-proactive/index.ts wires every scheduled
//                             ON flag (CAREER_BRIEF_DIGEST, CAREER_MAIL_TRACKING, CAREER_INTRO_REMINDERS, follow-ups)
// (career_mock_prep.ts, CAREER_MOCK_JUDGE, is already in SHARED_REPLY_MODULES.) tests/architect/release-flags.test.ts
// fails when a flag enters RELEASE_FLAGS without its module here.
export const RELEASE_FLAG_PATHS = [
  "supabase/functions/_shared/task",
  "supabase/functions/_shared/channel_voice.ts",
  "supabase/functions/_shared/channel_registry.ts",
  "supabase/functions/trainee-telegram/handler.ts",
  "supabase/functions/trainee-inbound/handler.ts",
  "supabase/functions/trainee-deliver/handler.ts",
  "supabase/functions/_shared/career_networking.ts",
  "supabase/functions/_shared/career_tailor_rewrite.ts",
  "supabase/functions/_shared/career_outreach_track.ts",
  "supabase/functions/career-proactive/index.ts",
  // D-036 review: the scheduled run's whole path for its ON flags (briefs and digest, intro reminders, mail, follow-ups).
  "supabase/functions/career-proactive/switches.ts",
  "supabase/functions/career-proactive/handler.ts",
  "supabase/functions/_shared/career_proactive_run.ts",
  "supabase/functions/_shared/career_digest.ts",
  "supabase/functions/_shared/career_people_reminders.ts",
  "supabase/functions/_shared/career_inbox_followups.ts",
  // Release 9 E (proposal D-043): the contact connector's switches (CAREER_PEOPLE_SEARCH + CAREER_CONTACT_OUTREACH) are read here only.
  "supabase/functions/_shared/career_contact_pipeline.ts",
] as const;

// Every reply-code path, repository-relative, sorted. Git pathspecs: a directory covers everything under it.
export const REPLY_CODE: readonly string[] = [...new Set([
  ...REPLY_CODE_DIRS,
  ROUTER_BUNDLE,
  ...SHARED_REPLY_MODULES.map((f) => `supabase/functions/_shared/${f}`),
  ...RELEASE_FLAG_PATHS,
])].sort();

// Whether a repository-relative file is reply code.
export function isReplyCode(file: string): boolean {
  return REPLY_CODE.some((p) => file === p || file.startsWith(`${p}/`));
}

// The top-level trees a measurement commit takes whole from the measured commit (every reply-code path lies under one, so
// the measurement commit's reply code is the measured commit's, file for file; everything else, the eval harness and its
// score log, stays ci/brain-eval's).
export const MEASURE_ROOTS = ["packages", "supabase/functions"] as const;

if (import.meta.main) {
  const what = Deno.args[0];
  if (what === "paths") console.log(REPLY_CODE.join("\n"));
  else if (what === "roots") console.log(MEASURE_ROOTS.join("\n"));
  else { console.error("usage: reply-code.ts paths|roots"); Deno.exit(2); }
}
