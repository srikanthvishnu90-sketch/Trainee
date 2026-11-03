// OWNER RULE (2026-10-26, "never submit applications without a real resume"; 20261026210016): an application is queued,
// prepared or carded only for a person with a confirmed resume on file (a confirmed entry and its fact_confirmed event).
// Flow tests whose person never pastes a resume in chat seed that state here, as setup. The thread it sits on is dated a
// month back, so the profile the server prepares from (career_apply_profile_for: the most recently updated thread) stays
// the one the test's own conversation builds.
// fileText: the local resume file the person's own computer prepares with (its bytes, as text). When given, the event names
// that file as the confirmed upload (detail.upload {kind:'file', sha256}), as a resume they sent and confirmed would
// (review of #194: a computer's resume hash counts only when the person confirmed that file).
export function confirmedResumeSql(userId: string, fileText?: string): string {
  const ev = `seed-resume-${userId.slice(-12)}`;
  const detail = fileText === undefined ? `'{"confirmation_event_id":"${ev}"}'`
    : `jsonb_build_object('confirmation_event_id','${ev}','upload',jsonb_build_object('kind','file','ref','TEST local resume','sha256',encode(sha256(convert_to($seedpdf$${fileText}$seedpdf$,'UTF8')),'hex')))`;
  return `with t as (insert into public.agent_threads (user_id, title) values ('${userId}', 'TEST seeded resume') returning id)
    insert into public.agent_flow_state (thread_id, user_id, state, updated_at) select id, '${userId}',
      '{"career":{"stores":{"profile":{"facts":[{"id":"seed-resume","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"${ev}","text":"TEST Analyst, TEST Co"}]}}}}',
      now() - interval '30 days' from t;
    insert into public.career_events (user_id, kind, subject, detail) values ('${userId}', 'fact_confirmed', 'TEST Analyst, TEST Co', ${detail});`;
}
