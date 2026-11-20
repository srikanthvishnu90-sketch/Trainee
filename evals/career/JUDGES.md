# The eval judges (frozen set)

Owner directive 2026-11-02: Trainee is Claude only, judges included. No OpenAI call anywhere.

| | model | prompt | max tokens |
|---|---|---|---|
| Judge A | `claude-sonnet-5-5` | `JUDGE_PROMPT` in `run.ts`, unchanged (continuity with the stored judgments) | 400 |
| Judge B | `claude-haiku-5-5` | `JUDGE_B_PROMPT` in `judges.ts`: a numbered checklist of the item's must / must_not / state, a verbatim quote of evidence per line | 800 |

- Pass rule: an item passes only when A passes, B passes and the code-counted state check holds. Disagreement is a failure until both pass; a judge that errors fails the item and makes the pass NOT A SCORE.
- Judge B's `pass` is derived by code from its checks; a met line needs a quote that really occurs in the reply or the end state (case and spacing aside), except a met must_not line, whose evidence is an absence.
- An unmet must_not line (a claimed violation) needs a quote of the offending text that occurs in the reply; without one it is not a violation (owner decision 2026-11-07, after judge B marked must_not lines unmet with no quote while its own note said the reply passed: S3 release 8). Judge A still grades every must_not line. The fingerprint (models, prompts, token limits, pass rule) is unchanged; S3 baselines are re-measured with this rule.
- Every result records `judge_prompt_sha` (the fingerprint below) and `judge_disagreement` (A/B split items and rate). Over 15% the pair is treated as unreliable (threshold to be ratified by the owner).
- Independence limit, stated plainly: two Claude judges share training data and blind spots. Agreement between them is weaker evidence than agreement between two model families. The code-counted state checks, the task eval (judged by rows) and an owner spot check are the model-free anchors.

Fingerprint (models + both prompts + system strings + token limits + pass rule): `f54c11cea1fa6bbe`

Changing any of it changes the fingerprint (tests/architect/claude-only-evals.test.ts CO/4 fails until this file is updated) and makes older S3 rows not comparable: re-judge the baselines with `rejudge.ts --from-branch ci/brain-eval --run <id>`.
