# Live-12 replays ($0)

Both replays play live-12's 26 turns again through the real handler with PIPELINE.on. Nothing was spent.
- Base command: `run-conversation.ts --dry-run --persona evals/mirror/instinct-wa-batch1/persona.json --replay replay-input-12.json --judge recorded-no --verdicts verdicts-12.json`.
  The persona file gives the three setup turns (`setup-0` to `setup-2`: the confirmed record and the GPA withdrawal); without it the
  replay starts from an empty record.
- Verdicts: a sentence live-12 kept counts as "yes", one it refused counts as "no", and anything never judged counts as "no".

## Replays

1. `replay-legacy-live-12.jsonl`. The stub model returns live-12's recorded drafts untagged, so every turn takes the legacy path
   (`pipeline: untagged`). This includes the support check and its quote fallback.
   - Compared with live-12, no turn gets worse.
   - C10 and C20 fail here because the replayed `tailor_resume` call has no valid posting input ("give the posting's job_id from
     search_jobs, or its full text"), so neither turn builds a document. They say nothing about dry-run document generation, and
     are counted from the live result.
2. `SYNTHETIC-tagged-replay-live-12.jsonl` (`--tag-synthetic`). **SYNTHETIC.**
   - A script tags each recorded sentence with the ledger unit that layer A finds for it. This stands in for the model's own tags,
     and most of live-12's paraphrased sentences find no unit.
   - The repair pass is stubbed as "no change".
   - It shows the mechanics only (drop, then code's fallback), not what a tagging model would get.

## Not replayable

- C4, C9 and C22 need pages live-12 did not record (research and apply-flow), and the dry run has no web. The trace now records
  checked units.

## Round 9 of #849 (regenerated)

Both files were regenerated at round 9 with the base command above (`--judge recorded-no`). The synthetic script tags 2 of the 26
turns (C1, C11). The tagged path now falls back on 1 turn (C1), where it fell back on 2 (C1, C11) before round 9. Against the legacy
replay, one draft sentence that legacy kept is dropped on the tagged path: C1's "The other result, NVIDIA's OpenShell, is full-time."
The recorded verdicts never judged it, so it counts as "no" (the judge's drop, not code's). With a yes judge, so that only code drops
anything, 2 sentences legacy kept are still dropped (C1, before round 9: 3):
- "Changes: Pixelforge and Rallyup lead the resume, ...". The File is a plan that recommends this; no unit says it was done.
- "... the 3.9 stays off everything this chat". Layer A reads "3.9 stays" as a count of stays.

## Round 10 of #849 (regenerated)

Advice and Trainee's own offers and needs lists are now put to the judge too (D-088: no shape skips the check). With the recorded
verdicts (`recorded-no`), C1's offer ("Want me to prepare the PayPal application for your approval?") and C11's needs list ("I need
your email, Harbor Global's dates, and Crestline's exact name.") were never judged live, so they count as "no" and drop. C11 then
falls back, so the tagged path falls back on 2 turns (C1, C11). Against the legacy replay, draft sentences legacy kept that are dropped
stay at 1 (C1's NVIDIA sentence, the judge's drop); legacy drops the needs list too. With a yes judge, both offers stand, there is no
fallback, and the 2 drops listed for round 9 are unchanged.
