# live-6: batch 1 on trunk 6e17f371 (D-064, D-065), all 26 turns asked for, 24 run

CI run 43162338950 (`.github/workflows/mirror-conversation.yml` on `ci/mirror-conversation` ddac5b42, a merge whose tree is
trunk 6e17f371 exactly, plus the request), 2026-11-12. Approval D-060, cap $3.00 (the quote: 26 turns plus 3 setup at live.ts's
$0.10 a brain turn, $2.90). The cap was reserved at the shared $70 ledger ($38.8565 before) and settled to the metered
**$3.0153** ($41.8718 after). Under D-060 ($10 for this effort): $0.26 proof + $2.83 round 1 + $3.0153 this round = $6.1053.

Conditions: production's release flags exactly (P4), the brain `PRODUCTION_BRAIN`, the persona's three setup turns, and D-065's
test world (`world.ts`): the recorded PayPal Workday posting and the remote NVIDIA posting on the board, the stub Gmail with the
persona's nine confirmations, and the research reader's public GETs live. Claude's web search was live (7 searches). Two board
listing reads were refused and recorded (C9: `boards-api.greenhouse.io`, `api.smartrecruiters.com`). Nothing was queued,
prepared, submitted or sent (`no_action` 24/24, `gmail_sent=0`).

**The cap cut the last two turns.** This round cost about $0.13 a turn, against live-5's $0.10. The spend passed $3.00 during C22
and the runner stopped there, so C21f and C23 were not run. They are scored as not measured, which counts as a fail. The
runner checks the cap after each call, so the settled cost went $0.0153 over the cap.

| File | What it is |
|---|---|
| `trainee-live-6.jsonl` | The transcript, taken from the run's log because the artifact host was not reachable from the session: every reply, with the tool trace. |
| `judged-live-6.json` | Same task, judged per turn (the input of `score-conversation.ts --judged`). |
| `score-live-6.json`, `score-live-6.txt` | `score-conversation.ts`'s six code checks. |
| `five-checks-live-6.json`, `five-checks-live-6.md` | The five similarity checks of MIRROR-RULINGS P5, per turn, with the reasons, the cause mapped to a G-ruling, and live-5 alongside. |

## The five checks

**1 / 26 match (C5), the same as live-5.** The counts that pass are task 16 (live-5: 13), process 20 (11), shape 1 (1; length 2,
answers first 17), honesty 19 (17) and voice 20 (17).

| | live-5 | live-6 |
|---|---|---|
| Turns run on the model | 18 (C3 on the router; C18 to C23 cut) | 23 (C3 on the router; C21f, C23 cut) |
| Match | 1 | 1 |
| Task / process / honesty / voice | 13 / 11 / 17 / 17 | 16 / 20 / 19 / 20 |
| Median length on live-5's 18 model turns (Instinct 413) | 532 | 705 |

Fixed by D-064 and D-065, as live-6 shows:

- C1 now runs `search_jobs` before the plan.
- C2, C13 and C14 draft through `draft_followup`. C2's length is now within 1%.
- C12 now says the pace is not verified.
- C16's tracker File arrives with its link. It corrects C6 out loud.
- C11 corrects C1's pay out loud.
- C18 to C22 reach the model.

New failures:

- **C5f2: the length condenser's own refusal reached the person.** The reply was "there was no text to rewrite ... If you meant
  to send a career assistant's message, please paste it". D-065's shortening pass (`career_brain.ts condenseReply`) replaced the
  brain's code review with this refusal. `shortenedOk` accepted it, because it checks figures, links, placeholders and the
  boundary, not that the output is a rewrite of the reply.
- **C9: an empty reply.** `research_market` ran (2 web searches, $0.25) and nothing reached the person. One code path returns
  "" here: `enforceMarketReply` with a `format: "file"` result in which no sentence is on record (reproduced at $0 with a
  synthetic result). The runner does not record the body's shape, so the path that ran is not proven.
- **C6: Gmail was not read.** The stub Gmail held nine confirmations, but the brain answered "nothing on record" without
  calling `read_application_mail`. live-5 called it.
- **Length is worse.** No answer turn without a write came under its kind's bound: C7, C8, C11, C12, C15 and C17 are 1.2 to
  2.6 times Instinct's length. Either the shortening pass was rejected by `shortenedOk` or it did not run; the trace does not
  say which.

The worst pairs, Instinct against Trainee, are in `five-checks-live-6.md` and the PR description.
