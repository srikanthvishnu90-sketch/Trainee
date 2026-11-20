# live-5: batch 1 on trunk 1ee06408 (D-059 to D-063, D-061 rulings), web research on

CI run 43135329449 (`.github/workflows/mirror-conversation.yml` on `ci/mirror-conversation` 57dd1447, whose tree is trunk
1ee06408 plus the runner changes in this PR), 2026-11-12. Approval D-060, cap $1.80, reserved at the shared $70 ledger
($36.0307 before) and settled to the metered **$1.8375** ($37.8682 after). PR #780 (D-064) was still open and is not in it.

Conditions: production's release flags exactly (P4), the brain `PRODUCTION_BRAIN`, the persona's three setup turns. Only the
model host and the database double were reachable. Claude's web search runs on the model host, so it was live: 7 searches. Every
other read was refused and recorded (employer boards, citadel.com, Workday, Gmail), and nothing was queued, prepared, submitted or
sent (`no_action` 26/26). The posting board was the test world's fictional board, which has no SWE postings. Production's File
settings were stood in by an `example.test` base, as `heldout/harness.ts` does.

**The cap cut the run.** The spend passed $1.80 during C17. The product refuses a model call at the cap and falls back to the
router, so C18 to C23 got the router's no-model replies, not the model's. Those 7 turns were not measured. The runner now stops
at its cap (`run-conversation.ts`). C1 alone cost $0.37 (4 web searches) and C9 $0.23.

| File | What it is |
|---|---|
| `trainee-live-5.jsonl` | The transcript: every reply, with the tool trace (tools offered and called, web searches, router intent, File). |
| `judged-live-5.json` | Same task, judged per turn (the input of `score-conversation.ts --judged`). |
| `score-live-5.json`, `score-live-5.txt` | `score-conversation.ts`'s six code checks. |
| `five-checks-live-5.json`, `five-checks-live-5.md` | The five similarity checks of MIRROR-RULINGS P5, per turn, with the reason for each judgment. |

## The five checks

Shape means answers first and a length within ±10% of Instinct's (±6 characters under 60). Process is read from the tool trace
against `docs/architect/specs/MIRROR-PROCESS.md`. Task, honesty and voice are judged by a person. The reasons are in the JSON.

**1 / 26 match (C5).** The counts that pass are task 13, process 11, shape 1 (length 1, answers first 22), honesty 17 and voice 17.

| | live-4 (D-057) | live-5 |
|---|---|---|
| Turns that pass every check | 3 / 26 (six code-and-task checks) | 1 / 26 (five similarity checks) |
| Same task, on the 19 turns live-5 measured | 11 | 13 |
| Length within ±10%, on the same 19 | 5 | 1 |
| Median length, on the same 19 (Instinct 396) | 460 | 507 |

Fixed since live-4:

- C2 now drafts with placeholders (D-059).
- C4 now cites one guide (D-063).
- C15 answers the hypothetical person (G8).
- C6 now runs `read_application_mail` and C16 runs `export_tracker` (D-062).
- C9 now runs a live web search (D-060).

Worse: length is the main loss, at a median of 1.27 times Instinct's.
