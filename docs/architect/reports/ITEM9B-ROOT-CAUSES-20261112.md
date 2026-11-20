# Item 9(b): memory on the real model — root causes of every miss (2026-11-12)

Run: brain-eval **43194037044** (set `d054`, `evals/career/d054-items-7-9.json`; brain `staged`, model claude-sonnet-5-5;
judge A claude-sonnet-5-5, judge B claude-haiku-5-5; five passes; measured SHA 44b436f9). Results: ci/brain-eval data commit
`2ae3a5127`, `evals/career/results/d054-staged-43194037044-p1..p5.json`; SCORE-LOG rows 2026-11-12 09:44 (80.0, 93.3, 93.3,
86.7, 80.0% over all 15 items).

Item 9(b) is the ten M items × five passes = **40/50**. Bar (owner, 2026-11-12): 99%, i.e. **50/50**, every pass.
By category: sensitive 5/10 (M04 0/5, M10 5/5), corrections 21/25 (M07 4/5, M08 2/5; M01, M02, M06 5/5), reuse 9/10
(M05 4/5, M09 5/5), nothing-said 5/5 (M03). The code-checked outcome (state_check) held in all 50; every miss was a judge.

## Per case

| Case | Passes failed | Turn that failed, answered by | Judge that failed it, and what it said | Root cause in code | Class | Fix (D-072) |
|---|---|---|---|---|---|---|
| M04 | 1, 2, 3, 4, 5 | the only turn, code (`sensitive_answer_ask`), the same reply all five passes | B (haiku): "asks only for the graduation date and defers the salary question to a later turn rather than asking for both now"; A passed all five | None in the product: the reply names both answers as the person's, asks the first as its one question ("1 of 2: When do you graduate?"). That is the pinned one-question-per-reply ruling (#745, RESPONSE-RULES E3, pinned in `d054-fixes` and `d055-harness-path`). The case's line "asks the person for their graduation date and their salary expectation" did not state the ruling, so judge B read it as two questions in one reply. | judge disagreement | Ruling: the case's `must[1]` states the ruling (both named as needed, the first asked now as the one question, the second in the next reply) with a `ruling` field giving the reason. Every other line unchanged; the reply unchanged. Asking both at once would break E3 (owner's response rules), so the product is not changed. |
| M08 | 1, 4, 5 | turn 3 "do I need sponsorship?", code (`profile_recall`) | B: "correctly states the corrected answer … though it is terse and does not acknowledge the correction" (and listed "invents other facts"); A passed all five | (a) The read-back repeated the same answer in two wordings (fixed on trunk by D-070 (6) after this run). (b) A stated fact replaced by a correction overwrote the earlier value (`recordThreadFact`, single-valued kinds), so no reply could say it was a correction: the history was gone. | correction not reopening the answer (read-back) + read-back duplicates | A correction keeps what it replaced (`statedFacts.replaced`, latest 20, thread state; kept through the account merge in `career_host.js`; erased with `statedFacts`). The sponsorship read-back says "You first told me you need sponsorship, then corrected it; the corrected answer is the one I use." from that value, then the person's own words and the other fact they said ("you're a US citizen"), each once. |
| M07 | 1 | turn 3 "which school do I go to?", the model (`career_catchall`) | B: "invents a claim about a prior 'yes' and prior saved state that the conversation and end state do not support" (the reply: "Purdue was already waiting on your yes from before this chat, and Northwestern was never saved") | The brain's person block (`_shared/agent/memory.ts personBlock`) listed the router's stated-facts rows (`stated-school-0`, said in this chat two turns earlier) under "WHAT YOU KNOW … Upmore keeps this from their account, not from this chat". The model followed the heading and placed Purdue before the chat, and, with no trace of Northwestern, said it was never saved. Code gave the model a false premise. | router answers / brain context (provenance) | Each stated-facts row (`profileFromStatedFacts`) carries `said_in_chat`, `said_at` and `replaces`; the person block prints them on the row: "(they said this in this chat on 2026-10-19, and it was saved in their words; it corrects what they said before in this chat: "you go to Northwestern University"; not confirmed yet)". It stays under the drafts heading. |
| M05 | 5 | turn 2 "Use the same expected salary for the Lakefront Data application", the model | A: "never asks the user to confirm the salary for Lakefront Data and never attributes $85,000 to the Northline Health answer"; B passed | D-053 (salary expectation is asked per application; an earlier answer is a suggestion shown with its source, WO-122) was left to the model on this wording; code guarded only "use the answers from my last application" with nothing on file (D-055 M09). In 1 of 5 passes the model said it would use $85,000 "there too" without asking or naming the source. | sensitive question per application not asked (D-053) | Code's guard (`handleSalaryReuse`, in the state-change layer beside `handleAnswerReuse`): the earlier figure on file (a stated `salary_expectation` or a profile fact naming a salary and a figure, not the target's own), shown with where it was given; nothing filled in; one question "Should I use $85,000 as your expected salary for Lakefront Data too?". A yes keeps it keyed to that application only (a separate answer; Northline's is never re-keyed), a no asks for their figure, a typed figure is theirs. Stands down with no figure on file, a figure in the message, a negotiation, or no company. |
| M01 M02 M03 M06 M09 M10 | none | | | | | |

"80% answered by code": 8 of the 10 misses were in code-owned replies (M04 five, M08 three); 2 were the model's (M05, M07).
Of the code-owned ones, M04 is a ruling and M08 a missing record of what was corrected. The model's two misses were caused by
what code gave it or left to it (M07 a false provenance heading; M05 a D-053 guard not in code).

## Tests ($0, scripted model)

`tests/architect/d072-item9b-memory-20261112.test.ts`: D72-1..8 replay each case from the eval's own words through
`evals/career/run.ts makeBrain` (the path the eval runs: handleInbound, the staged decision, CareerHost, the stores), each with
the live failing reply quoted as the before; D72-9 runs M05, M07 and M08 through the real agent-chat handler on Postgres 16.
Existing pins kept: `d054-fixes`, `d055-harness-path`, `d070-live7-fixes` (D70-6), `brain-memory-*`, `loop-09-memory*`.

## Re-measure (not run here)

The same request as 43194037044: set `d054`, brains `staged`, five passes, after merge. Preflight quote ≈ $2.454 (five parallel
passes at $0.491); the last run's actual was $1.437, so expect ≈ $1.40–1.50 (M05's second turn is now code's). `budget_usd`
**2.50**: at 2.0 the preflight refuses (quote over the run's budget, `eval_budget.ts preflight`, `PREFLIGHT_SHARE = 1`).
