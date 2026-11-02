# Spec gap list: conversation brain (2026-11-02, branch spec-B-20261102)

Source: owner PRD sections 2.1-2.7, 3, 6.5, 7.1-7.2, 7.5, 7.10, 8; contract items 1-10; capabilities 01, 05, 16. Facts only; each line is code read on this branch.

## What exists
- A role ask on any channel runs askFor -> searchJudgeTurn -> resultsFile (handler-career.ts, role_results.ts). The results reply is code text (role_pay.ts resultsParts; owner-approved, page builder owns it). A search queues nothing (career_apply_wanted stays 0; telegram-acceptance and tasks T27, T38).
- The reply writer (career_reply_writer.ts, CAREER_REPLY_WRITER=on) is model-written with a D-007 fact check; it never rewrites a turn with parts or a results_file.
- Status answers (career_apply_status.ts, career_standing.ts) are code sentences over career_apply_jobs states.
- Confirmed facts: profile.facts with needs_confirmation / status, personalSourceDenied; work authorization only via a confirmed eligibility fact.

## Gaps found (before this branch)
1. Nothing computed what an application needs. Missing facts surfaced only later, at the apply screen (career_apply_screen.ts) or as a canned "nothing is sent before your resume is confirmed" line. A role ask asked no consequential question and handed the model no list (spec 2.2, contract 1, cap 01 acceptance).
2. A correction was not an update (spec 2.3). "only remote roles" ran a search for the role "remote only" in the old place and found nothing; "only individual contributor roles" went to the staged brain as chat, so no search changed. The old filter was never replaced because the effective ask was not kept on the thread (lastParams only held the router's reading).
3. Limits had no way to rule a level out (only bands to include), so "no manager roles" could not be held.
4. Status counts: countsLine/statusLine are code sentences; no structure existed for the model to write from, and nothing stopped a written reply from saying "applied" for a queued or unconfirmed row (spec 6.5, 2.6, contract 10).
5. Not done here (listed, not built): resume-less shortlist reply wording is still the canned resultsParts / resumeLine text (D-007 conflict, page builder's file); 7.10 pause wording; 8.x recovery wording; the agent brain (CAREER_BRAIN=agent) does not receive readiness; the answer-to-question capture path (router eligibility_draft) was read, not changed or exercised end to end.

## Built on this branch
- _shared/apply_readiness.ts: needs from confirmed facts only, consequence-ordered (resume, work authorization, sponsorship, remote scope, level, location, email, phone, name, salary floor if hard), `ask_now` max 2, secrets under `secure_only`, never asked.
- _shared/readiness_ask.ts: the model writes one question from that data; a question that fails its checks (not one "?", link, number, secret word, status word, canned phrase) is dropped, never replaced by canned text. Runs only with CAREER_REPLY_WRITER=on; the data is in turn meta (`readiness`) either way.
- _shared/search_correction.ts + Limits.notBands + askFor/stagedDecision/handler: a correction replaces remote/place/levels from discovery.lastAsk; the old place and manager levels are not kept; the router's wrong lastParams is overwritten.
- _shared/apply_status_summary.ts: counts from row states (prepared, approved, started, submitted and confirmed, still checking, needs you, not sent), each row once; `applied_ok` = employer-confirmed rows only; reply writer rejects "applied" or a larger confirmed count than rows allow. Summary in turn meta (`apply_summary`).
- Eval: tasks T45-T53, judge fields search / readiness / apply_summary, run.ts end-state fields; tests/architect/spec-b-brain.test.ts (14 unit tests).
