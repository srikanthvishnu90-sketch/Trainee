# Item 11 (interview practice): root causes of the held-out practice sample, 2026-11-12

Ruling: D-072 (item 11), `docs/architect/DECISIONS.md`. Tests: `tests/architect/d072-item11-practice-20261112.test.ts`.

## What was measured

| | |
|---|---|
| Run | `mirror-conversation` CI run **43193882444**, request commit `13d3a8a85` on trunk **44b436f9** (before D-070 and D-071) |
| Command | `evals/mirror/heldout/live.ts --sample 6 --seed 7 --family practice --budget-usd 3.6 --label live-v95-practice` (D-068) |
| Sample | HO-0875, HO-0856, HO-0876, HO-0899, HO-0847, HO-0894: 6 conversations, 24 scored turns (12 setup turns unscored) |
| Spend | $1.4640 (ledger $52.6764 of $70 after it) |
| Result | G1 22/24, **G2 19/24**, **G3 5/24**, G12 24/24; nothing sent 24/24 |
| Worst (the run's own summary) | practice_question/agent [G3] x10; practice_review/agent [G3] x5; practice_review/agent [G2,G3] x4; practice_question/prep_brief [G1] x2; practice_review/agent [G2] x1 |

The bar from 2026-11-12 is at least 99%, which on 24 turns means 24/24 on G2 and G12, and 24/24 on G3 under D-066's rule. That
rule fails a reply only when it is FAR over its kind's bound: more than 25% over the upper end, so over 375 characters for a
practice question (window 200 to 300) and over 625 for a review (window 300 to 500).

**What could be read.** The run's per-turn file (`live-v95-practice.jsonl`) went into a one-day artifact (13932456243, expires
about 2026-11-13 09:42 UTC). The artifact host (productionresultssa0.blob.core.windows.net) is refused by this session's network
policy, so the file was not downloaded. It is held-out text in any case, sealed under P2 and git-ignored, and nobody tunes on it.
The CI log holds only the summary above.

The classification below combines three sources:
- that summary;
- each turn's kind and step from the sealed set's structure (`expect.kind`, `task`; no prompt text was read);
- a $0 dry replay of the six conversations through the real handler at the run's own commit `44b436f9`, which records the route,
  the router's intent and the length kind code chose for each turn. The same replay was run at this PR's head.

Each conversation has the same four steps: t1 Q-start (ask for one question), t2 Q-approach (the person's approach), t3 Q-answer
(their answer, with one real flaw), t4 Q-harder (ask for a harder follow-up).

**Why the count cannot go past turn-group level.** The summary gives per-group counts but does not name which reviews failed. The
24 turns therefore map exactly onto the summary's groups, and inside the review group the 9 G3 misses and 5 G2 misses cannot be
pinned to individual turns without the sealed per-turn file.

## Per-turn root cause

Columns: route and router intent are what code decided at 44b436f9. Length kind is `turn_notes.ts replyLength` at 44b436f9 and its
bound (`overLimit`). The verdict is the run's.

| Turn | Step / kind | Route at 44b436f9 (router intent) | Length kind at 44b436f9 (bound) | Live verdict | Root cause in code | Fixed by | At this PR's head |
|---|---|---|---|---|---|---|---|
| HO-0847.t1 | Q-start / question | brain (prep_mock_start) | answer, aim 300 to 500 (550) | G3 fail (one of the 10) | RC1 | D-070 (7) | question kind (330) |
| HO-0856.t1 | Q-start / question | brain (prep_brief) | answer (550) | G3 fail | RC1 | D-070 (7) | question (330) |
| HO-0875.t1 | Q-start / question | brain (prep_mock_start) | answer (550) | G3 fail | RC1 | D-070 (7) | question (330) |
| HO-0876.t1 | Q-start / question | brain (prep_mock_start) | answer (550) | G3 fail | RC1 | D-070 (7) | question (330) |
| HO-0894.t1 | Q-start / question | brain (prep_mock_start) | answer (550) | G3 fail | RC1 | D-070 (7) | question (330) |
| HO-0899.t1 | Q-start / question | brain (prep_mock_start) | answer (550) | G3 fail | RC1 | D-070 (7) | question (330) |
| HO-0856.t4 | Q-harder / question | brain (unclaimed) | answer (550) | G3 fail | RC1 | D-070 (7) (D-072 (2) also reads it in session) | question (330) |
| HO-0876.t4 | Q-harder / question | brain (unclaimed) | answer (550) | G3 fail | RC1 | D-070 (7) (D-072 (2) also reads it in session) | question (330) |
| HO-0894.t4 | Q-harder / question | brain (unclaimed) | answer (550) | G3 fail | RC1 | D-070 (7) (D-072 (2) also reads it in session) | question (330) |
| HO-0899.t4 | Q-harder / question | brain (unclaimed) | answer (550) | G3 fail | RC1 | **open** (RC1b) | **answer (550)**: its wording is not read as a next ask by D-070 or D-072's rule; not tuned (sealed) |
| HO-0847.t4 | Q-harder / question | **code** (prep_brief: a bank question) | answer | **G1 fail** (G2, G3 pass) | RC2 | D-070 (7) | brain, question (330) |
| HO-0875.t4 | Q-harder / question | **code** (prep_brief) | answer | **G1 fail** | RC2 | D-070 (7) | brain, question (330) |
| HO-0847.t2, .t3; HO-0856.t2, .t3; HO-0875.t2, .t3 (career_catchall); HO-0876.t2, .t3; HO-0894.t2, .t3; HO-0899.t2, .t3 | Q-approach, Q-answer / review | brain (unclaimed; HO-0875.t3 career_catchall) | answer, aim 300 to 500 (550), with **no review note** | 12 reviews: G3 fail 9 (5 G3 only, 4 G2+G3), G2 fail 5 (4 G2+G3, 1 G2 only), 2 clean | RC3 (G3), RC4 (G2) | D-070 (7), D-071 (1), D-072 (1), (3), (4) | review note on all 12 (D-070); review length kind on all 12; G2 check (D-072) |

## The causes

**RC1: practice questions were given the answer length, 10 turns, G3.**
- At 44b436f9 `replyKind` read only "quiz me", "ask me ... question" and "mock/behavioral/technical/coding round|question ... ask"
  as a question.
- "Give me a real ... interview question", "practice interview time: one ... question" and "harder one, same topic" fell through
  to "answer". Its turn note said "about 300 to 500 characters", and the shortener's bound was 550.
- The brain wrote a 300 to 500 character question, so every one of the 10 brain-answered questions missed the 200 to 300
  window. How many were also over 375 (D-066 far) the summary does not say.
- D-070 (7) added `practiceAskOf` (the question kind, 200 to 300, bound 330). On the dry replay at this head, 11 of the 12
  question turns get the question kind.
- RC1b: one Q-harder wording (HO-0899.t4) is still read as an answer. D-072's session rule (`practiceNextOf`, from the dev turns'
  grammar) does not catch it. It was left alone because the held-out text is sealed. The live re-measure will show whether it
  is still a miss.
- RC1c (found on dev and batch 1): the shortener skipped any reply that "carries code", and complexity notation counted as code.
  A practice question that says "aim for O(1)" was never shortened. D-072 (3) fixes it.

**RC2: the next question was served by code's bank, 2 turns, G1.**
- At 44b436f9 the router answered "harder one" as `prep_brief`, a bank question, and code kept it.
- `G1_REQUEST` did not match it, and `practiceAskOf` did not exist yet.
- D-070 (7) added `practiceAskOf` to the condition (`career_staged.ts`). At this head both turns are the brain's.

**RC3: reviews too long, 9 turns, G3.** Four parts compound:
- (a) At 44b436f9 a review had no note of its own, only the generic "one short paragraph, about 300 to 500".
- (b) The length pass was all or nothing: a faithful shorter text still over 550 was thrown away (D-071 (1) fixed this; live-8
  had 11 of 14 such refusals).
- (c) A review never reached the length pass when the reply named a complexity ("O(n) time") or the person had pasted code.
  Live-8 recorded both on batch 1's dev turns:
  - C5f1, 873 characters, skipped "carries code" only for its "O(n)";
  - C5f2, 791 characters, their code pasted.

  Both are far over 625.
- (d) The kind read from the answer's own words. A three-step approach ("the audience, the goal, then channels and a budget
  split, then how we measure", dev HO-0842.t2) read as an "everything" ask: 900 to 1,200 characters, bound 1,320. "I'd make a
  map ..." could read as a draft, which is never shortened.
- D-070 (7) added the review note. D-072 (1) fixes (d), and D-072 (3) fixes (c) under a code-verbatim guard.

**RC4: the review's first sentence was a verdict on nothing, 5 turns, G2.**
- G2 (`reply_rubric.ts answersFirst`) passes a first sentence that takes up the person's message (a shared content word), gives a
  result, or names something.
- Practice reviews open with bare verdicts: "Right approach for the wrong problem." (live-7 C5f1), "Short answer: that's a
  different problem ..." and "That's still the wrong problem ..." (live-8 C5f1, C5f2), "That's a plot summary, not an interview
  answer." (live-7 C21f). These are verdicts that do not say what they judge, so they fail the rule.
- At 44b436f9 there was no review note at all.
- D-070's note asks for the verdict first but not what it is a verdict on. A model that obeys it with "Right." still fails,
  because a bare "right" is one of the rubric's non-answers.
- Two more gaps on the dev turns:
  - An answer that ends "— thoughts?" (HO-0859.t2) was read as a new ask, so it got no note.
  - An answer that follows a review ending in an instruction ("Now write it.") rather than a "?" was not read as an answer.
- D-072 (2) and (4) fix these.

## The fixes (D-072), each replayed at $0

| # | Fix | Code | Test |
|---|---|---|---|
| (1) | Inside a practice session, an answer is the review kind (300 to 500, bound 550), whatever its words look like | `turn_notes.ts replyKind(message, history)`, `replyLength(message, history)`; `career_brain.ts` passes the history | D72-1, D72-5 (HO-0842.t2: "everything" before, the review length after) |
| (2) | An ask for the next question inside a session ("ok next", "another one, harder", "cool, harder one, same topic") is the question kind; a check-in ("thoughts?", "right?") does not make an answer a new ask; a "?" inside pasted code is code; a review ending on an instruction waits for the answer | `practiceNextOf`, `practiceAskIn`, `practiceAnswerOf` (CHECK_IN, CODE_LIKE, INVITES_ANSWER) | D72-1 (dev HO-0858.t3/t4, HO-0859.t2/t3/t4), D72-5 |
| (3) | A practice turn (question or review) is shortened unless it shows a code block. Every code token of the reply (inline code, a call or an index, an underscore name, an operator, a complexity) is kept verbatim, or the shorter text is refused. Complexity notation alone is not code. Non-practice turns keep D-067's rule. | `career_brain.ts` length pass (`practiceTurn`, `codeKept`) | D72-2 (live-8 C5f1: skipped, then 873 to 550 or under), D72-3 (live-8 C5f2: 791 to 625 or under with `next(...)`, `first_unique`, `[2, 1, 2, 1]`, `O(n)` kept; a text that changes `next(...)` is refused; a code block is never shortened; a non-practice code turn is still "carries code"), D72-5 |
| (4) | A review of a practice answer (or a roast) whose first sentence fails answers-first is put back to the model ONCE (the process check, tools on, never shown to the person): the first sentence is the verdict on what they said, named in their own terms. D-070's note also says so. | `career_brain.ts processCheck({ review })`, `turn_notes.ts practiceAnswerNote` | D72-2 (live-8 C5f1), D72-3 (live-8 C5f2), D72-4 (live-7 C21f; D-070's "Partly right: counting works ..." is not asked again) |

None of this writes any reply prose. The model writes every word: code only reads, measures and asks once. Nothing is sent,
submitted or queued, and the tests assert no tool call on these turns.

## The live re-measure (quoted, NOT run)

- **Command:** the same sample as run 43193882444, so the comparison is like for like: `live.ts --sample 6 --seed 7 --family
  practice`, label `live-d072-practice`, through `evals/mirror/run-request.json` (`kind: "heldout"`, `sample: 6`,
  `seed: 7`, `family: "practice"`) under the owner's written spend approval line.
- **Expected spend:** about **$1.60 to $1.80**:
  - run 43193882444 metered $1.4640 for the same 36 turns (setup included);
  - D-072 adds at most one review rewrite on each of the 12 review turns, about $0.01 to $0.02 each;
  - shortening passes add about $0.005 each.
- **The cap:** live.ts's preflight quotes 36 turns x $0.10 = $3.60 and refuses a `--budget-usd` under its quote. A $2 cap is
  therefore refused at the preflight unless `PER_TURN_USD` is lowered, which is not done here. Run it with `--budget-usd 3.6`, as
  run 43193882444 did: the ledger reserves the cap and settles at the metered spend, and the harness stops at the cap.
- **What it measures:**
  - G2 and G12 at 24/24;
  - G3 under D-066's far rule (questions at most 375 characters, reviews at most 625; the strict-window count is reported
    beside it);
  - G1;
  - whether RC1b (HO-0899.t4's wording) still misses.
