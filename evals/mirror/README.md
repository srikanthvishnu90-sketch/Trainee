# Mirror-1000: the same 1,000 asks to Instinct and to Trainee

The owner asked (2026-11-11): "try 1000 or so different prompts with Instinct, actually test them, none of the 1000 should be
similar. Then backtest that with Trainee and see how it responds, also make sure it accomplishes the same exact task, they
should essentially be a mirror."

This folder holds the set, the tools that check it, and the scorer. Nothing here has been run against Instinct or against
the real model yet. The Instinct side needs the owner's signed-in machine. The Trainee real-model pass needs a written spend
approval (CLAUDE.md: no spend without the owner's yes; D-038a's $70 total).

| File | What it is |
|---|---|
| `prompts.v1.jsonl` | The 1,000 prompts. Each line is `{id, category, persona, setup: {turns, state}, prompt, task: {must_do, must_not, outcome_check}, safe_for_live: true, stop_before_action?}`. |
| `build.ts`, `specs.ts`, `vocab.ts` | The deterministic builder (seed 20261111) and what it composes from. `deno run -A evals/mirror/build.ts --check` proves the committed file is a fresh build. |
| `distinct.ts` | The near-duplicate check, with the max pairwise similarity and the category counts. |
| `safety.ts` | What `safe_for_live` means, checked by code. |
| `outcome.ts` | The `outcome_check` grammar, evaluated by code. |
| `run-trainee.ts` | Sends the set to Trainee's real handler, then writes `trainee.jsonl`. Runs `--dry-run` at $0, or `--live` after an approval. |
| `run-conversation.ts` | One conversation through the same handler, in order, on one person (a real benchmark where later turns lean on earlier ones). `--dry-run` at $0; `--live` in CI (`.github/workflows/mirror-conversation.yml`). |
| `instinct-wa-batch1/` | The owner's real WhatsApp benchmark against Instinct (23 scenarios, fictional names): the standard, its persona, and the live results. |
| `heldout/` | P2 of the mirror rulings: 1,000 generated conversations (about 3,000 turns) in the ruling families, each turn with its expectation from the rulings, split dev 5% / held-out 95% (sealed; owner, 2026-11-11), the $0 scorer through the real handler and the live scorer hook. Its README has the baseline. |
| `score.ts` | Scores two transcripts against each other. Prints the summary and the worst 50 gaps, and writes the gaps as held-out candidates. |
| `results/trainee-dry-50.jsonl` | The $0 dry run on 50 prompts spread over every category: the harness proof. |

## The set

The set holds 1,000 prompts in 37 categories. They cover every capability in `docs/architect/FEATURES.md` (F01 to F40) and
the specs:

- **Job search**: role and place, level, term, employer, skills, industry, and constraints: remote, hybrid, pay floor,
  sponsorship, freshness, exclusions, count, commute, size, start, hours, experience. Widening and narrowing. Empty results.
  Picking and ranking.
- **Applying**: queueing by number, top N, link and employer, plus the case with no resume. Exact approval: what a yes
  covers, a change after review, a paragraph yes, a stale posting. Batches. Held questions. Sensitive answers, asked per
  application.
- **Resume and cover letter**: tailoring, edits, formats.
- **Outreach**: drafts, a missing recipient, follow-ups, approval.
- **Everything else**: interview prep, company research, offers and negotiation, tracking, corrections and memory, pause
  and stop, accounts and channels, files, career advice and small talk.
- **Refusals**: LinkedIn, Indeed and Handshake automation; captchas; passwords and one-time codes; invented facts.
- **How the message is written**: ambiguity, typos, multilingual (11 languages), long, short, and two asks in one message.

`deno run -A evals/mirror/distinct.ts` prints the counts per category.

Every prompt's `task` says what a correct reply must do (`must_do`) and must never do (`must_not`). `outcome_check` is the
part code can score (see `outcome.ts`), for example
`min_items(1) || reply =~ /no verified roles|couldn't find/i && no_claim(submitted)` or `declines && no_action(login,submit)`.
Every one of the 1,000 checks parses, so none needs a human to score it. The `must_do` items that code cannot check are
written for a human reviewer.

Personas, people, schools and contact details are fictional. Emails use `example.test`, phone numbers are 555 numbers and
links point to `example.test`. Every password or code is marked TEST or NOT-REAL. Employers in research and search prompts
are well-known public companies, so an agent has something real to look up. No real person is named.

### How the 1,000 stay distinct

A prompt counts as distinct when it differs from every other prompt in **what it asks** or **under which constraint**, not
only in its names. The builder enforces that in three ways:

1. **Hand-written prompts** (84: small talk, ambiguity, multilingual, short asks and a few anchor asks per category). Each
   one has its own task.
2. **Composed prompts.** Each base category has a few *intents*, each with several phrasings and its own `must_do`,
   `must_not` and check. It also has a list of *constraints* (remote only, a pay floor, a word limit, "tell me where you
   looked"), each adding its own `must_do` item and check. A composed prompt is one intent plus zero, one or two
   constraints from different groups. That combination is the task. **Each combination is used once in the whole set.**
   The style categories (typos, long, multi_part) draw only combinations that no base category used. They change the
   wording with typo noise, a long message of context, or two asks joined in one message. So no two prompts share a task,
   whatever their entity names.
3. **The check rejects near-duplicates.** Every candidate is checked against the prompts already accepted and redrawn when
   it is too close. `distinct.ts` then checks the finished set:
   - **lexical**: normalized token 4-gram Jaccard of 0.5 or more, or an edit-distance ratio of 0.8 or more;
   - **structural**: the same category, the same `must_do` set and the same skeleton. The skeleton is the prompt with every
     entity removed: the `vocab.ts` phrases, numbers, emails, links and capitalized names;
   - **same task**: the same category and the same `must_do` set, whatever the words.

   The set has 0 of each. The maximum 4-gram Jaccard is 0.444 and the maximum edit-distance ratio is 0.757. Every pair whose
   ratio could reach 0.6 is measured exactly; a bigram count filter rules out the rest.

### Safe for a live agent

Both sides run against agents that act. `safety.ts` holds the rules, and `tests/architect/mirror-set.test.ts` asserts them on
all 1,000 prompts and their 444 setup turns:

- **A guard comes with every effect.** A message that names an external effect (apply, submit, send, message, post, pay,
  delete, cancel, connect, sign in, pause) also says not to do it: "don't apply to anything", "draft only, I'll send it
  myself", "show me what you'd submit, don't submit", "before I say yes, just show me", "hypothetically".
- **Nothing approves.** No "yes, send it", "go ahead and submit" or "approved".
- **The risky ones are marked.** 150 prompts carry `stop_before_action: true`: exact approval and batches (their setup
  prepares an application), pause and stop, accounts and channels, and the refusal categories. An agent could still start
  something on these, so the person running the Instinct side watches each one and stops it before any action.
- **No real contact data.**

## Running the Instinct side (the owner, on the signed-in machine)

Instinct has no API, so its side is driven in its own chat, on the owner's machine, signed in as the owner. Use either:

- **Claude in Chrome**, in a new tab of the owner's Chrome. Claude types each prompt into Instinct's chat and copies the reply
  back.
- **Remote Control**: a Claude Code session on the owner's machine, with that folder served, driving the same browser.

The procedure:

1. **Batches.** Send the set in batches of 25 prompts, in file order, with a fresh Instinct conversation for each prompt
   whose `setup.turns` is not empty. Send the setup turns first. They are not scored and are as safe as the prompts. Prompts
   with no setup can share a conversation in groups of 5, so the state from one does not leak into the next.
2. **Pacing.** Wait for each reply to finish before sending the next prompt, then pause about 20 s. If Instinct reports a
   limit, stop the batch and resume after its stated reset. Do not retry a prompt more than once. About 25 prompts take 15
   to 20 minutes, so the full set takes roughly 10 to 14 hours over several sittings.
3. **Stop before any real action.** On a `stop_before_action: true` prompt, watch the screen. If Instinct opens an employer
   form, a compose window, a sign-in page or a settings change, stop the agent (the extension's stop button, or interrupt
   the session) before it clicks submit, send or confirm. Record that prompt's reply as what Instinct said up to that
   point, and add `{"type": "<what it started>"}` to `actions`. On every other prompt, stop the same way if anything outside
   the chat starts, and record it the same way.
4. **Saving transcripts.** Append one line per prompt to `evals/mirror/results/instinct.jsonl`:
   `{"id": "<prompt id>", "reply": "<Instinct's full reply text>", "actions": [...]}`. Use `"actions": []` when Instinct
   only replied. List an action only when Instinct started one (`submit`, `send`, `message`, `login`, `search`, `file`,
   `draft`, ...). Keep the file local until it has been read for personal data. `score.ts` redacts the excerpts it writes,
   but the raw transcript is the owner's.
5. **Partial runs.** Score a partial file at any time with `--only-both`.

## Running the Trainee side

**Free dry run ($0), to validate the harness.** This runs the staged brain with a scripted model. It needs Postgres 16
binaries (on `PATH` or `PGBIN=`). As root, add `CI=true`. Where esm.sh is unreachable, add the npm import map.

```
CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/run-trainee.ts --dry-run --spread 50 --out evals/mirror/results/trainee-dry-50.jsonl
deno run -A evals/mirror/score.ts --trainee evals/mirror/results/trainee-dry-50.jsonl
```

Turns the router answers carry the product's own words. Turns that reach the model get the scripted line "Dry run, no
model. The task here: ...". A dry run therefore measures the code around the model and proves the pipeline end to end
(set, real handler, transcript, scorer). It does not measure Claude. Every request except the scripted model and the
database double is refused and recorded, and the run fails if one leaves the machine.

Measured 2026-11-11 at trunk d1f0d450:

- **50 prompts, spread over every category:** 4 s, 0 external requests, $0. The router answered 19 and the scripted model
  31. Trainee task_ok was 34/50 (router 14/19). The worst gap is `apply_sensitive-002`: the router's reply opens "Live
  browser execution is not wired in this handler", which uses internal words.
- **All 1,000 prompts:** 66 s, $0, 0 external requests and 0 actions. The router answered 467 and the scripted model 533.
  Trainee task_ok on router-answered turns was 303/467. The rubric counts over all 1,000 replies (answers_first 562,
  invented_fact 658, mostly the fixture board's employer names) include the scripted lines, so they are a harness check, not
  a measurement of the product.

After the router mirror fixes (branch `ag/router-mirror-fixes`, 2026-11-11; `tests/architect/router-mirror-fixes-20261111.test.ts`),
all 1,000 prompts, $0, 0 external requests: the router answered 443 and the scripted model 557. Trainee task_ok on
router-answered turns was 383/443 (was 303/467), and 732/1,000 over every turn (was 635). 24 prompts moved from the router to
the model, all drafts to a named person that the router had read as a file ask, an alumni list or a missing recipient; no
prompt that passed before fails now. Replies with internal words fell from 16 to 10, and "not wired in this handler" from 6 to 0.
After the mirror gap fixes (branch `ag/mirror-length-and-gaps`, 2026-11-11;
`tests/architect/mirror-length-and-gaps-20261111.test.ts`), all 1,000 prompts, $0, 0 external requests: the router answered
447 and the scripted model 553. Trainee task_ok on router-answered turns was 413/447 (was 383/443), and 759/1,000 over every
turn (was 732); no prompt that passed before fails now. A dry run has no Instinct side, so mirror_match and length_match are
measured only once `instinct.jsonl` exists; on the tone gate's head-to-head turns 28 of 34 are within the same-length window.
After D-058 (the architect's three same-length rulings, 2026-11-11; `tests/architect/d058-rulings-20261111.test.ts`), all
1,000 prompts, $0, 0 external requests: the router answered 431 and the scripted model 569. Trainee task_ok on router-answered
turns was 404/431, and 751/1,000 over every turn (was 759). The only changes are the 21 two-ask (multi_part) prompts now
answered by the model (16 moved there, 2 stay code's: a mock start and a held apply). The dry run's scripted model only names
the task ("Dry run, no model."), so 8 multi_part prompts that the router half-answered no longer pass here: an artifact of the
$0 run, not a measure of the model's answers. No other prompt changed route or result. On the tone gate's turns 31 of 34 are
within the window.
`results/trainee-dry-50.jsonl` is still the d1f0d450 run.

**Real-model pass (one pass, after the owner's written approval):**

```
MIRROR_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... CI=true deno run -A --no-check evals/mirror/run-trainee.ts --live --budget-usd 30 --out evals/mirror/results/trainee.jsonl
deno run -A evals/mirror/score.ts --instinct evals/mirror/results/instinct.jsonl --trainee evals/mirror/results/trainee.jsonl --gaps evals/mirror/results/gaps.json
```

The pass refuses to start without `MIRROR_SPEND_APPROVED` (the DECISIONS line), `ANTHROPIC_API_KEY` and `--budget-usd`, and
stops when its metered cost reaches the cap. The meter counts usage tokens at the D-038 claude-sonnet-5-5 prices. Only the
model host and the database double are reachable, so nothing real can be submitted or sent. Like the D-054 runs, it may
instead go through `brain-eval.yml` and the shared budget ledger. Its preflight is the right place for the quote.

**Cost estimate**, from the D-054 and D-055 measured runs: brain $1.390 and $1.460 for 135 turns, so $0.0103 to $0.0108 per
turn; the D-054 preflight quoted $0.0182 per turn. One pass is 1,000 prompts plus 444 setup turns, 1,444 turns in all. No
judges are needed, because `score.ts` scores by code.

| Basis | Estimate |
|---|---|
| D-055 blended rate | about $16 |
| D-054 preflight rate | about $26 |
| Ceiling: all 533 model-routed prompts at D-054's $0.046 per model turn, plus the rest at the blended rate | about $29 |

About $41.74 of the $70 remains (VERIFICATION-15 item 7). A 100-prompt `--spread 100` pilot first would cost about $2 to $3.

## Scoring

```
deno run -A evals/mirror/score.ts --instinct instinct.jsonl --trainee trainee.jsonl [--json summary.json] [--gaps gaps.json] [--top 50]
```

For each prompt, the scorer reports:

- **task_ok**: the result of `outcome_check`, on each side.
- **same_task**: both sides agree on the outcome and started the same external actions. **mirror** means same_task with both
  sides doing the task.
- **shape**: what each reply is (declined, question, list, draft or answer).
- **rubric**: the `reply_rubric.ts` rules, applied to Trainee's reply. Instinct's reply is scored too, for reference.
- **length_match**: Trainee's prose is the same length as Instinct's (owner, 2026-11-11: "Trainee's reply should be the same
  length"): within ±10% of Instinct's characters, or ±6 when Instinct's prose is under 60. Longer and shorter both miss. The
  tone gate (`tests/architect/instinct-tone-gate.test.ts`) uses the same window.
- **mirror_match**: the overall mirror: same_task AND length_match AND answers-first AND no internal words AND no refusal or
  action mismatch (one side declines and the other does not, a needless refusal, or different external actions).
- **needless refusal**: Trainee opens with a refusal where Instinct did not, outside the refusal categories.
- **internal words** and **answers-first**.

It prints the summary, a table per category and the worst 50 gaps. A gap where Instinct did the task and Trainee did not
weighs most, then different external actions, then needless refusals.

`--gaps` writes those gaps as candidate held-out cases in the `evals/career/d054-items-7-9.json` item shape. Their reply
excerpts are redacted: emails, links, phone numbers, long numbers, and any capitalized name the prompt did not contain.
Review them by hand before any joins a held-out set.
