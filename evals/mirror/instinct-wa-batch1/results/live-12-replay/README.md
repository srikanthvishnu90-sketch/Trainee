# Live-12 replay ($0)

All 26 turns of live-12, played again through the real handler. Nothing was spent, and the replay ran with the pipeline flag off.
The command is `run-conversation.ts --dry-run --replay replay-input-12.json --judge recorded-no --verdicts verdicts-12.json`.

- Drafts: live-12's recorded support drafts, which now include research drafts. Where a turn has none, its final reply stands in.
- Verdicts: live-12's own recorded verdicts. A sentence live-12 kept counts as "yes", one it refused counts as "no", and anything
  never judged counts as "no".
- The repair pass can't be replayed: it is off with the pipeline, and no repair outputs were recorded.
- C4, C9 and C22 can't be replayed. Live-12 did not record its research pages or the apply-flow page, and the dry run has no web.
  The trace now records the unit each research sentence was checked against, so the next live run can be replayed.
