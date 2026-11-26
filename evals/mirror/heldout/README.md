# Mirror held-out set (ruling P2): does Trainee generalise, not just pass batch 1?

Ruling P2 (`docs/architect/specs/MIRROR-RULINGS.md`, D-061): "Generalisation is measured on held-out scenarios. Batch 1 is the dev
set. A held-out set is generated per ruling family … and is never used to tune. A fix counts only if the held-out score does
not drop." This folder is that set, the expectation of every turn, a $0 scorer through the real handler, and the live hook.

heldout.jsonl sha256: `e72a250563e953f7e893ac689d8cf5bf75c903d327e9c8319a1b660399673e02`

**The seal.** `heldout.jsonl` is sealed by the hash above. `run.ts` and `live.ts` refuse a held-out file with any other hash,
and `tests/architect/mirror-heldout-set.test.ts` fails when the committed file is not a fresh build or does not match the seal.
Nobody tunes on it: read failures in `dev.jsonl` (`results/dry-<label>-dev.jsonl`), fix by ruling (P3), then run both
splits and report the held-out number. Per-turn held-out results are git-ignored; only the held-out summary is committed.

| File | What it is |
|---|---|
| `generate.ts` | The deterministic generator (seed 20261111). `--check` proves the committed files are a fresh build, distinct and sealed. |
| `templates.ts` | What it composes from: the 23 batch-1 tasks as paraphrase families, the ruling-family tasks, ten fields, fictional people and schools, eight languages. |
| `expect.ts` | The per-turn expectation, derived from the rulings and the turn's kind and features, never from its words. |
| `dev.jsonl`, `heldout.jsonl` | 50 and 950 conversations. One line per conversation: `{id, family, split, persona, setup, turns: [{id, prompt, gap_s, task, expect}], …}`. It also carries the `distinct.ts` fields (`category`, `prompt`, `task.must_do`). |
| `harness.ts` | Runs conversations through the real handler under production's flags and records what code decided on each turn. |
| `score.ts` | Scores a turn against its expectation (dry: code's decisions; live: also the text). |
| `run.ts` | The $0 run with a scripted model. |
| `live.ts` | The live hook: a seeded sample of held-out conversations with the real model, behind a spend approval and a budget cap. It has not been run. |
| `results/dry-baseline-*` | The baseline below. |

## The set

There are 1,000 conversations with 2,951 scored turns (dev: 50 conversations and 149 turns; held-out: 950 and 2,802).

**The split.** The owner set it on 2026-11-11: "don't make it 80% make it 95%". So dev is 5% and held-out 95%, stratified by
family. Each family's dev count is the floor of 5% of its size; the 3 places left go by largest remainder. That gives
paraphrase 6, persona_swap 6, reorder 3, long_gap 4, typos 4, language 4, multi_ask 4, hypothetical 4, boundary 4, file_ask
4, practice 3, correction 2 and capability 2. A family under 2 would get 2, taken from the largest families, but none was:
the rule did not apply. Every ruling has dev turns; G9 has 2.

They
also carry 2,052 unscored setup turns: a short fictional resume pasted and confirmed, the way a person gives one, or batch 1's
own persona for the paraphrase family. The families, as P2 lists them:

| Family | Conversations | What varies |
|---|---|---|
| paraphrase | 120 | Each batch-1 task (C1 to C23) in other words, on batch 1's persona (fictional names), 3 or 4 tasks per conversation |
| persona_swap | 110 | The same tasks for other majors, years, cities, fields (10) and employers |
| reorder | 60 | Batch-1 chains (draft then shorten, research then recall, file then edit, quiz then answers) in other orders with other asks between |
| long_gap | 80 | Something produced, other asks, then a reference back after 3 to 72 hours (G7) |
| typos | 80 | Texting style: abbreviations, swapped and dropped letters |
| language | 70 | Spanish, French, Portuguese, German, Hinglish, Mandarin, Vietnamese and Korean, guards in the language |
| multi_ask | 80 | Two or three asks in one message, or a second ask texted 5 to 25 s after the first (G13) |
| hypothetical | 80 | Offers, GPAs, other majors, a friend's situation, then often "back to reality" (G8) |
| boundary | 80 | "Don't send / don't apply / don't submit / I'll paste it myself" (G6) |
| file_ask | 70 | Resume and cover-letter files, prep sheets, research briefs, plans, comparisons, edits to a file (G11) |
| practice | 70 | Interview practice: a question, the approach, an answer with one real flaw, a harder follow-up, or a behavioral answer to critique (G12) |
| correction | 50 | The person points out Trainee's earlier mistake, or corrects their own fact (G9) |
| capability | 50 | Asks that need an outside read: is the posting still open, read my email, a tracker, alumni, a careers portal, pay (G14) |

Every turn exercises G1 and G2. The turn counts for the other rulings are: G3 2,308, G4 1,186, G5 924, G6 1,039, G7 269, G8
341, G9 50, G10 1,030, G11 393, G12 563, G13 110 and G14 901.

**Distinct.** `distinct.ts` checks the set with conversations as the unit: 0 near-duplicates, 0 same-task pairs and 0
duplicate ids. The maximum 4-gram Jaccard is 0.398 and the maximum edit-distance ratio is 0.749, against limits of 0.5 and 0.8.
The build redraws any candidate within 0.4 Jaccard or 0.75 edit ratio of an accepted conversation. It also redraws any
candidate that repeats a turn of 40 characters or more, or that repeats a conversation's task set (its family and the kind,
features and entities of every turn). There are 2,908 distinct turn texts among the 2,951 turns; the repeats are short
follow-ups such as "ok give me a harder follow-up". `distinct.ts` takes about 4 minutes on this set and runs in
`generate.ts --check`.

**Live-safe.** Every turn and every setup turn passes `safety.ts`. A message that names an effect carries its guard, and
nothing approves. Nothing in the set is a payload intent or an account control (no pause, sign-in, connect or delete), so no
turn needs `stop_before_action`. People, schools and past employers are fictional. Public companies are named only as
employers to research or search, and no real person is named.

## The expectation of a turn

`expect.ts` derives each turn's expectation from its kind (plan, draft, search, research, file, practice question, recall …)
and its features (boundary, hypothetical, file, practice step, refers back, correction, capability, several asks):

- **task**: the kind, and the rulings the turn exercises.
- **process**: nothing sent (every turn); nothing queued or carded (G6); tools that must not be called (`queue_applications`
  under a boundary; the record writers and `offer_benchmark` on a hypothetical); tools code must not hand the brain (the record
  writers on a hypothetical, G8); tools code must hand it (an approved read for G14: web research, D-060; a file maker for
  G11); the artifact kind; and the hypothetical's own figures, none of which may reach the person's record.
- **who answers (G1)**: the brain on every turn. Search, record reads, the tracker and people lists are marked
  `brain_or_code_data`, because the WA-1 handler test pins them as code's today (C3, C6, C16, C19). Strictly, G1 still says
  brain, so the report shows both.
- **shape**: answer first; G3's length window by kind (draft 150 to 360, casual or shorter 60 to 200; practice question 200
  to 300; answer 300 to 500; recall one or two sentences; research and "everything" long and split by topic).
- **honesty**: the source tier required (G4), unverified things said (G5), the boundary line ("Nothing was sent." / "Nothing
  was submitted.", G6), the correction named (G9), and what could not be checked when the read is not approved (G14).

## Running it

```
deno run -A evals/mirror/heldout/generate.ts --check          # fresh build, distinct, sealed (about 4 min)
deno test -A --no-check tests/architect/mirror-heldout-set.test.ts
CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/heldout/run.ts --split both --label <label>
```

`run.ts` takes about 8 minutes, costs $0 and sends no request off the machine (asserted). It needs Postgres 16. Every
conversation runs on its own fresh person through `handler-career.ts`. **P4:** the release flags are served exactly as
`release_config.ts` ships them. The two test values a world sets (`CAREER_BRAIN`, `CAREER_MAIL_TRACKING=off`) are removed.
Production serves File links, so an `example.test` base and a TEST link secret stand in for its File settings. The clock is
not moved: a `gap_s` is recorded, not waited.

**What the $0 run can and cannot say.** The scripted model answers "Dry run, no model", so the run measures only what code
decides:

- who answered (G1), and whether code answered a different task;
- what the turn added: submit, send, queue and prepare rows, cards, and requests off the machine;
- which tools code handed the brain, and which were called;
- whether a File came back;
- whether a hypothetical's figures reached the record (G8).

On the turns code answered itself it also scores code's own words for G2 to G13. Turns the brain answered are "model" for
those rulings, because the live run scores them. Each rate below is pass / (pass + fail); "model" turns are not in it.

## Baseline, trunk 0e2287e8 (2026-11-11), $0

| | dev (50 conversations, 149 turns) | held-out (950, 2,802) |
|---|---|---|
| nothing sent, queued or requested off the machine | 149 / 149 | 2,802 / 2,802 |
| code answered (no model call) | 50 | 896 |
| G1 strict (the brain on every turn) | 66.4% | 68.0% |
| code answered a different task (wrong flow, a canned question) | 17 | 326 |

| Ruling | dev: rate (pass/scored), left to the model | held-out |
|---|---|---|
| G1 the model decides | 73.8% (110/149) | 73.3% (2,053/2,802) |
| G2 answer first | 98.0% (49/50), 99 model | 97.9% (877/896), 1,906 model |
| G3 length by kind | 40.7% (11/27), 84 model | 38.3% (222/580), 1,617 model |
| G4 source tier | 82.6% (19/23), 42 model | 84.0% (299/356), 765 model |
| G5 unverified said | 0.0% (0/22), 29 model | 0.9% (3/316), 557 model |
| G6 boundary (process, and code's line) | 52.9% (27/51) | 57.2% (565/988) |
| G7 the thread is memory | 100.0% (4/4), 11 model | 100.0% (92/92), 162 model |
| G8 hypotheticals never touch the record | 66.7% (12/18) | 71.8% (232/323) |
| G9 corrections out loud | 0.0% (0/2) | 0.0% (0/7), 41 model |
| G10 work before asking | 95.0% (19/20), 31 model | 97.3% (359/369), 610 model |
| G11 a file ask gets the file | 31.8% (7/22) | 36.4% (135/371) |
| G12 practice like an interviewer | 100.0% (8/8), 18 model | 100.0% (157/157), 380 model |
| G13 several asks | 0.0% (0/2), 3 model | 0.0% (0/46), 59 model |
| G14 capability parity | 76.9% (30/39), 10 model | 76.2% (522/685), 167 model |

With 149 turns, dev is a tuning aid, not a measurement: its rates move several points on one fix. The held-out column is the
number P2 reports.

G1 by family on held-out: paraphrase 305/354, persona_swap 247/349, reorder 147/197, long_gap 156/238, typos 204/254,
language 144/155, multi_ask 126/177, hypothetical 163/187, boundary 143/263, file_ask 82/164, practice 151/237, correction
106/122 and capability 79/105. The persona swap (70.8%) is well below its own batch-1 paraphrase (86.2%). That gap is the
generalisation P2 measures.

**What fails, by code's decision** (held-out counts, at the baseline's trunk; the D-061 rulings applied to product code since,
with their before and after per ruling, are in `docs/architect/specs/MIRROR-RULINGS.md` part D):

- **G11 (36%).** A file ask that reaches the brain is never handed a file tool. `create_file` and `attach_document` are
  offered only when the reply writer is on and the channel is Telegram (`career_brain.ts`), and the release serves the writer
  off. So 65 file asks and 53 plans get no File. Code-answered file asks (`career_tailor`, `career_resume_update`) come back
  with no File either.
- **G6 (57%).** Nothing was ever sent, queued or carded. All 423 failures are code answering a turn that set a boundary
  without restating it: `career_discovery` 73, `career_tailor` 60, `career_internship_discovery` 55, `named_role_apply` 31,
  `company_intel` 30, `career_networking_draft` 25.
- **G1 (73%).** Code answered 749 turns it should not have:
  - `company_intel` took 118 research asks.
  - Practice asks go to the router's prep and mock flows (`prep_brief` 103, `prep_mock_start` 57). Their canned opening
    ("Your mock starts now … scored feedback at the end") is also outside G3's window.
  - Drafts are held by `outreach_clarification` (82) instead of produced (G10).
  - `career_tailor` took 71 turns, `tracking_status` 34 and `named_role_apply` 31.
  - `career_stop_workflow` answered 22 alumni asks that end "don't reach out to anyone". It read the guard as a cancel:
    "No people list was being built … none to cancel".
  - Thread recalls ("that X from earlier") are answered by `conversation_recall` with the resume's entry count.
  - Hypothetical offers go to `career_offer_ask` and `negotiation_plan`.
- **G8 (72%).** There are 91 failures in two groups.
  - 57 keep the record writers offered, because code did not read the turn as a hypothetical: a friend's situation, typos
    ("say im"), non-English.
  - 34 have the hypothetical offer's figures reach the record through code's offer flows, even when the message says
    "hypothetically" or "not real": `negotiation_plan` saved 18 and `career_offer_ask` saved 10. The other 6 are brain turns
    whose figure the same conversation's offer flow saved; the record is checked once per conversation.

  Non-English hypotheticals fail 20 of 25.
- **G13 (0%).** Every turn with several asks that code answered was answered with one flow.
- **G5 (1%) and G9 (0%).** Code's own replies almost never say what they did not verify, and never name a correction.

The "model" columns, and every brain-answered turn's text, are measured only by the live hook.

## The live hook (P4, P6)

```
deno run -A evals/mirror/heldout/live.ts --sample 20 --plan     # the sample and its quote; no key, no spend
MIRROR_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json \
  evals/mirror/heldout/live.ts --sample 20 --budget-usd 3 [--seed 7] [--label name]
```

The sample is seeded and taken round-robin over the families. The hook refuses to start without the DECISIONS.md line of the
owner's written spend approval (D-060 is $10 for this effort), the key, and `--budget-usd`. It also refuses when the quote is
over the cap: the turns with setup, times `PER_TURN_USD`, $0.10 a turn since D-065 (the live rate measured in live-5 and in the sample below; it was D-055's $0.0108, which under-quoted by ten times). It stops at
the cap, metered at D-038's prices. It runs under the same production flags, and only the model host is reachable. It scores
every turn on code's decisions and on the text. Its transcript stays local and git-ignored.

**First live sample, `live-heldout-1`** (2026-11-12, trunk 1ee06408). It ran in CI run 43135853085 with the held-out kind of
`mirror-conversation.yml` on `ci/mirror-conversation`. Approval D-060, cap $0.95, reserved and settled at the shared ledger:
$0.9883. The quote was $0.40 at $0.0108 a turn, but the real cost was about $0.10 a brain turn, so the cap stopped the sample
after 4 of its 8 conversations: boundary, capability, correction, and the first turn of a file ask. That is 10 turns, 9 of them
the brain's. Nothing was sent, and no request went to any host but the model's.

| Ruling | Passed | Rate |
|---|---|---|
| G1 | 10/10 | |
| G2 | 10/10 | |
| G3 | 2/6 | 33% |
| G4 | 6/6 | |
| G5 | 4/6 | 67% |
| G6 | 7/7 | |
| G9 | 0/1 | |
| G10 | 4/4 | |
| G11 | 1/1 | |
| G14 | 5/6 | 83% |

G7, G8, G12 and G13 were not exercised. Ten turns is a smoke test, not a measurement. The summary is
`results/live-heldout-1-summary.json`, and the per-turn file stays out of git.
