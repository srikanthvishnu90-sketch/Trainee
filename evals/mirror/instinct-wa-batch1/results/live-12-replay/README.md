# Live-12 replays ($0)

Both replays play live-12's 26 turns again through the real handler with PIPELINE.on. Nothing was spent.
- Base command: `run-conversation.ts --dry-run --replay replay-input-12.json --judge recorded-no --verdicts verdicts-12.json`.
- Verdicts: a sentence live-12 kept counts as "yes", one it refused counts as "no", and anything never judged counts as "no".

## Replays

1. `replay-legacy-live-12.jsonl`. The stub model returns live-12's recorded drafts untagged, so every turn takes the legacy path
   (`pipeline: untagged`). This includes the support check and its quote fallback.
   - Compared with live-12, no turn gets worse.
   - C10 and C20 only fail here because the dry run builds no resume document. They are counted from the live result.
2. `SYNTHETIC-tagged-replay-live-12.jsonl` (`--tag-synthetic`). **SYNTHETIC.**
   - A script tags each recorded sentence with the ledger unit that layer A finds for it. This stands in for the model's own tags,
     and most of live-12's paraphrased sentences find no unit.
   - The repair pass is stubbed as "no change".
   - It shows the mechanics only (drop, then code's fallback), not what a tagging model would get.

## Not replayable

- C4, C9 and C22 need pages live-12 did not record (research and apply-flow), and the dry run has no web. The trace now records
  checked units.
