# Reply pipeline: evidence ledger, tagged draft, verify, one repair, fallback

Status: built behind `PIPELINE.on` (`supabase/functions/_shared/agent/reply_pipeline.ts`). It is **off** until the owner and the
architect switch it on after a live run. While it is off, every reply keeps the support check (`FAIL_CLOSED.support`).

Why: live-12 showed that good drafts were broken by checking after the fact. The checker had to guess which unit each sentence
stood on. When it guessed wrong, it refused true sentences, and its quote fallback then replaced them with unrelated page text.
The fix is for the drafting model to say which unit each sentence rests on, and for code to check only those units.

## Steps (one mechanism for every reply; nothing knows any test turn)

1. **Ledger.** Code numbers the evidence units before the reply is drafted:
   - The person's confirmed record, one fact per unit, and what it lacks (`Not on file: city, phone.`). These go in the system
     prompt.
   - Each tool result's units, attached to that tool result in `loop.ts` (`Ledger.fromToolResult`, chosen by the result's shape):
     - a posting's pay, one unit per place;
     - its deadline and state;
     - a search's count;
     - requirements;
     - the sign-in line;
     - a page's kept points, with host and kind;
     - a file made.
2. **Tagged draft.** `LEDGER_RULE` tells the model to end each factual sentence with the ids it rests on (`[E3]` or `[E3,E7]`).
   The intent's task contract goes in the system prompt up front. A sentence with no figure, name or date needs no tag; neither does
   a question. In code, that means `support.ts noClaim`, a closed set of shapes:
   - a gap admitted;
   - a caveat on a source;
   - "nothing was sent".
3. **Verify** (`verifyTagged`). Each clause is checked against the units the sentence cites and nothing else:
   - Clauses are split at "; ", ", and ", ", so " and ", but ".
   - Layer A runs on an index of the cited units; record units are read as one record.
   - The judge then reads the clauses, in one batch.
   - Whether something is on the record is code's check (`onRecord`), not layer A's.
   - A sentence stands only when every one of its clauses stands. No clause ever spans two units.
   - Tags are removed before the reply is sent.
4. **One repair** (`runReplyPipeline`): at most one model call, and only when something failed. The call gets:
   - each failing sentence, with code's reason in code's words (for example "'$50 an hour' is in no cited unit");
   - the length limit and the current length;
   - what the contract finds missing;
   - the ledger.

   The answer is verified again, and what still fails is dropped. A repaired first sentence goes first, so the answer still comes
   first. If the reply is still over the limit, whole sentences are dropped from the end.

   This pass replaces the shortener and the quote fallback on that turn.
5. **Fallback** (`fallbackLine`). When nothing left answers the question, code says it could not verify an answer. It then adds
   what the ledger holds for the words of the ask (a posting's pay, with its link).

## Task contract (`CONTRACTS`, per intent, never per turn)

| id | the reply must |
|---|---|
| answer_first | give the answer in its first sentence, with no preamble |
| referral | ask for the referral itself |
| requirements | list each thing needed |
| draft | say after the draft that it was not sent |

Each contract's `says` text goes to the drafting model up front. Its `missing` check feeds the repair pass.

## Fixes that apply with the pipeline off (support check)

- An abbreviation-aware sentence splitter (`splitSentences`: U.S., U.K., e.g., i.e., Inc., Jr., St., a.m./p.m., No.).
- Full dates normalized to one token ("Sunday, December 6th, 2026", "December 6, 2026" and "2026-12-06" match).
- `noClaim` sentences are not judged.
- Clause-by-clause checking.
- The record check for "X isn't on file".
- This chat's tool results are source units on research turns.
- Every research sentence's checked unit and its page link are recorded in the trace, so a $0 replay can cover research turns.
- Page fragments ("So I…", "Mostly because…") are never quoted, and page markdown is stripped.

The quote fallback itself is unchanged while the pipeline is off: the architect research-support tests require it ("every judge
failure is a quote of the page"; D73-1 "the reply is built from the kept lines"). The pipeline replaces it.

## Cost

There is one small call per reply, only when something fails. On live-12's drafts, 7 of 26 turns would need it (they had refusals
or were far over length). That is about 1.1k input and 60 output tokens per failing sentence, about $0.005 per repaired turn, or
about $0.0014 per turn on average.

## Tests

`tests/architect/pending/reply-pipeline-20261114.test.ts` covers three domains that are not in the mirror set: a finance internship
in New York, nursing pay in Texas, and a startup's culture. `tests/architect/pending/live12-support-fixes-20261114.test.ts` covers
the support-check fixes.
