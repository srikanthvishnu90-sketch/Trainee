# Live-11 replay ($0)

All 26 turns of live-11 (e4c73fe9d), played again through the real handler with the fixes on `ag/live10-fixes`. No model and no network were used.

- `replay-input-11.json` holds each turn's tool calls and the reply that follows them.
  - The draft comes from the turn's recorded support draft (C1, C4, C11). For other turns it is live-11's final reply, with code's applications line removed.
  - Live-11 recorded arguments only for search_jobs and research_market. The other arguments came from live-10's replay (the same conversation), from C1's File text, or from the draft body for draft_followup.
- `verdicts-11.json` holds live-11's judge verdicts for each sentence. A sentence live-11 never judged gets the truth rule (`tests/architect/support-test-judge.ts`).
- Command: `run-conversation.ts --dry-run --replay replay-input-11.json --judge recorded --verdicts verdicts-11.json`.
- `score-replay-mechanical.txt` reuses live-11's outcome judgments. So C10 and C20 read as not usable there only because the dry run's tailor_resume makes no document.

Some turns cannot be replayed at $0. Live-11 did not record its research pages, and the dry run has no web:
- C4: the UC Davis guide.
- C9 and C22: the market pages.
