# Reply pipeline: evidence ledger, tagged draft, verify, one repair, fallback

Status: **on** in production (`PIPELINE.on`, ruling 2026-11-14), `supabase/functions/_shared/agent/reply_pipeline.ts`.

The drafting prompt asks for tags, and the path is chosen by the draft:
- A **tagged** draft (it carries `[E#]`) goes through this pipeline. No page quote is ever put in place of one of its sentences.
- An **untagged** draft (from a model that ignored the tags, or from a scripted test) keeps the support check unchanged, quote
  fallback included. The architect research-support tests keep testing exactly what they test today, unedited.

The trace says which path each turn took (`pipeline: tagged | untagged`, and `piped` with its repair calls, drops and fallback), so
a live run shows how often the model tags.

Why: live-12 showed that good drafts were broken by checking after the fact. The checker had to guess which unit each sentence
stood on. When it guessed wrong, it refused true sentences, and its quote fallback then replaced them with unrelated page text.
The fix is for the drafting model to say which unit each sentence rests on, and for code to check only those units.

## Steps (one mechanism for every reply; nothing knows any test turn)

1. **Ledger.** Code numbers the evidence units before the reply is drafted:
   - The person's confirmed record, one fact per unit, and what it lacks (`Not on file: city, phone.`). These go in the system
     prompt.
   - Each tool result's units, attached to that tool result in `loop.ts` (`Ledger.fromToolResult`, chosen by the result's shape):
     - a posting's pay, one unit per place (a posting with no company field, as a Workday apply flow returns, is the employer its
       URL's ATS board or host names, else "... at <Employer>" in its title; a year in the title names the role and dates no figure);
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

   Round 9 of #849 adds two shapes in `verifyTagged`, both by structure: plain advice in the imperative with no figure, name or date
   (`support.ts plainTalk`: "Keep it short", "Lead with the project closest to the role"; a third-person statement such as "Its
   analysts sit on the credit desk" is still checked), and Trainee's own offer or list of what it needs (`support.ts ownAction`: "Want
   me to prepare the PayPal application?", "I need your email and Harbor Global's dates") with no figure, date, period or status word,
   no clause that asserts something, and only names the turn's tool results, the record or the ask already hold.
3. **Verify** (`verifyTagged`). Each clause is checked against the units the sentence cites and nothing else:
   - Clauses are split at "; ", ", and ", ", so " and ", but ".
   - Layer A runs on an index of the cited units; record units are read as one record.
   - The judge then reads the clauses, in one batch.
   - Whether something is on the record is code's check (`onRecord`, `support.ts recordCheck`), not layer A's. It speaks only for the
     template alone ("X isn't on file", "I don't have X on file", `recordShape`): one clause, and X carries no figure, date, verb or
     name the record does not hold. "Citadel pays $150 an hour, but your phone isn't on file" is two clauses; the first is checked as
     any other (round 9 of #849). The untagged path honours a caller's check the same way (`recordOnly`).
   - A sentence stands only when every one of its clauses stands. No clause ever spans two units (a clause the judge reads with no
     figure is shown one unit at a time).
   - **Subjects are structural** (round 8 of #849). Every clause has a subject: the employer it names, else the one carried from the
     clause before it, across sentences, whatever words refer back ("it", "the company", "there", "this role", or none). Only a newly
     named employer changes it. A clause may stand on its subject's units, or (for a carried subject) on a unit that names no employer;
     never on another employer's, and never on a line from an earlier reply whose employer code cannot tell. The judge always reads the
     clause with its subject ("PayPal: It requires a clearance").
     Stated limit: a general sentence right after an employer's ("Software engineering interns earn $45 an hour") carries that
     employer, so a careful judge may refuse it; that fails closed, and naming the new subject avoids it.
   - A clause naming two or more employers is a comparison. When every employer's part carries a figure or date of its own, each part
     (from one employer's name to the next) must hold its figures, names and dates in a unit of that part's own employer. When any
     part carries none ("Both PayPal and Citadel pay $80", "PayPal, like Citadel, pays $80", "Citadel pays $80, the same as PayPal",
     "... and so does PayPal", "PayPal matches Citadel at $80"), the figures are shared: every employer named must hold all of them in
     its own unit, whatever the order or wording (round 9 of #849). The judge then reads the whole clause against those units.
   - An employer opening a sentence beside a full date is a name, checked like any other; only a word for the posting's own parts
     ("Applications are open through December 6, 2026") is read as the sentence's subject word (round 9 of #849).
   - What is sent is what was verified: a dropped sentence changes what the next one refers back to, so the check runs again on what
     stood until nothing more fails.
   - On the untagged path (`keepSupported`), a clause split off a refused sentence keeps the sentence's subject: a clause that names
     nothing is never read alone, and one that names something else is read with the subject the first clause names.
   - Tags are removed before the reply is sent.
4. **One repair** (`runReplyPipeline`): at most one model call, and only when something failed. The call gets:
   - each failing sentence, with code's reason in code's words (for example "'$50 an hour' is in no cited unit");
   - the length limit and the current length;
   - what the contract finds missing;
   - the ledger.

   The repaired sentences are verified where they will be sent (after what stood, with its subject carried into them; or first, when
   the opening sentence failed), and the whole is settled again; what still fails is dropped. A repaired first sentence goes first, so
   the answer still comes first. A length repair that is verified, fits the limit and still answers replaces the overlong text. If the
   reply is still over the limit, whole sentences are dropped from the end.

   This pass replaces the shortener and the quote fallback on that turn. A sentence cut for length takes its source links with it.
5. **Fallback** (`fallbackLine`). When nothing left answers the question, code says it could not verify an answer. It then adds
   what the ledger holds for the words of the ask (a posting's pay, with its link), and only the ask's subject's own posting facts:
   the employer the ask names, else the one the draft names first, else the turn's only employer. With several and none named, or a
   line whose employer code cannot tell, nothing is listed. On a one-employer turn an ask that names no one but refers back to the
   posting ("what's the pay?") lists that posting's facts; a general ask ("what do interns earn") lists nothing.

## Task contract (`CONTRACTS`, per intent, never per turn)

| id | the reply must |
|---|---|
| answer_first | give the answer in its first sentence, with no preamble |
| referral | ask for the referral itself |
| requirements | list each thing needed |
| draft | say after the draft that it was not sent |

Each contract's `says` text goes to the drafting model up front. Its `missing` check feeds the repair pass.

## Fixes on the untagged path (support check)

- An abbreviation-aware sentence splitter (`splitSentences`: U.S., U.K., e.g., i.e., Inc., Jr., St., a.m./p.m., No.).
- Full dates normalized to one token ("Sunday, December 6th, 2026", "December 6, 2026" and "2026-12-06" match).
- `noClaim` sentences are not judged.
- Clause-by-clause checking.
- The record check for "X isn't on file".
- This chat's tool results are source units on research turns.
- Every research sentence's checked unit and its page link are recorded in the trace, so a $0 replay can cover research turns.
- Page fragments ("So I…", "Mostly because…") are never quoted, and page markdown is stripped.

On the untagged path the quote fallback is unchanged. The architect research-support tests require it ("every judge failure is a
quote of the page"; D73-1 "the reply is built from the kept lines"). On the tagged path the repair pass replaces it.

## Cost

Judge calls are capped per reply (round 9 of #849, `REPLY_JUDGE_MAX_CALLS` = 4, `REPLY_JUDGE_MAX_CLAIMS` = 32; trunk's `decide` used
2 calls of 8 claims). Each verification pass puts all its new claims in one call, and a (claim, passage) pair is asked once per reply.
Past the cap a claim is not asked and counts as "no": it fails closed. The trace (`piped`) records `calls` (repair calls),
`judgeCalls`, `judgeClaims` and `judgeCapped`.

There is one small call per reply, only when something fails. On live-12's drafts, 7 of 26 turns would need it (they had refusals
or were far over length). That is about 1.1k input and 60 output tokens per failing sentence, about $0.005 per repaired turn, or
about $0.0014 per turn on average.

## Tests

`tests/architect/pending/reply-pipeline-20261114.test.ts` covers three domains that are not in the mirror set: a finance internship
in New York, nursing pay in Texas, and a startup's culture. `tests/architect/pending/live12-support-fixes-20261114.test.ts` covers
the support-check fixes. `tests/architect/pending/reply-pipeline-review9-20261115.test.ts` covers round 9 (comparisons, the record
template, the date opener, plain advice, offers and needs lists, owners from a posting's URL, the judge cap). `tests/architect/pending/reply-pipeline-turn-20261114.test.ts` runs a production-shaped turn end to end:
the real drafting prompt, evidence in a tool result, a tagged draft, one repair call and the drop. It also shows that an untagged
draft keeps the support check.
