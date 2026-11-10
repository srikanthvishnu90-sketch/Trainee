# Release 10 application-layer work orders (owner order, 2026-11-09)

Source: the owner's 94-page evidence and design PDF, transcribed without personal data into
`docs/architect/specs/APP-LAYER-15-FIXES.md` (the "spec"). The fifteen fixes are in spec E.10; every acceptance
criterion is in spec E.1-E.11. The observed failures (spec A.2) happened on PRODUCTION after release 9 (deployed
931c5700, merge 7d2e8ee1). Rules that never move (CLAUDE.md) bind every order. Budget: the $70 total and the per-person
daily AI cap stay as they are; no order raises a cap or buys credits.

| Order | Fixes | Scope |
|---|---|---|
| WO-A task continuity | 1, 2, 3, 8 (+ example 4 ambiguity) | target retention, corrections as repairs, resume facts recovered, reply quality |
| WO-B real files | 4 | resume PDF/DOCX for the asked target, working download link, content inspection, honest file claims |
| WO-C search | 5, 6 | shortlist with employer/role/location/link/checked date, widening carried forward, open-check, fit vs eligibility |
| WO-D limits | 7 | at the AI-answer limit: what stopped, task kept, reset time in the person's time zone |
| WO-E Files visual system | 9 | the fifteen File families (spec C.1-C.18, C.24, C.25, D) |
| WO-F entry and connections | 10, 11 | /file and /connect recovery layout, sign-in states, connection consent/success/failure/disconnect |
| WO-G applications | 12, 13 | application review artifact, execution and proof states |
| WO-H research and drafts | 14 | sourced research brief and interview questions, follow-up drafts without invented history |
| WO-I acceptance and live replay | 15 | replay the 2 observed scenarios (5 turns) end to end, open the files, per-item pass/fail evidence, post-deploy check |

Known pointers (trunk 931c5700):
- turn 1 "There is no document file": packages/domain/142-career-router.js:2058 (document delivery claims the turn)
- turn 2 wrong role: 142-career-router.js:878 ("Picked first from the N roles": tailoring picked the first role of an old list)
- turn 3 batch help: supabase/functions/agent-chat/handler-career.ts:168/185 (BATCH_NOT_STARTED_REPLY)
- search turn 1: supabase/functions/_shared/career_search_judge.ts:452
- search turn 2: graduation-window template, 142-career-router.js:9414 HEADLINES
- limit note: supabase/functions/_shared/career_spend_cap.ts:30 (says "midnight UTC")
