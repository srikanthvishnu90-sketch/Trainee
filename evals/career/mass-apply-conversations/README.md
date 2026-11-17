# Mass-apply conversations (10/10 rubric)

What a 10/10 mass-apply conversation is, written as yes/no checks, and a runner that drives the real product through each
one. The outcome eval next door (`../mass-apply-outcomes/`) grades each prepared *form field*; this one grades the
*conversation*: does Trainee act on one message, show the right card, collect only what it must, approve exactly what the
person said, send each application once, and read the truth back.

Instinct (the competitor) is the 6/10 bar (`evals/mirror/instinct-wa-batch1`). Everything here is fictional: one synthetic
person per scenario (the e2e fixture resume, "Alex Testcase (TEST)"), made-up employers on made-up boards, a stub ATS on
127.0.0.1. Nothing reaches a real employer, inbox or person.

## Files

| File | What |
|---|---|
| `rubric.json` | 15 scenarios (MA01 to MA15), each with its turns, what a 10/10 does (`ten`), and its checks (MUST / NICE, `code` or `judge`) |
| `world.json` | the postings this eval adds to the e2e world's 20 (10 for the scenarios, 122 for SCALE) |
| `grade.ts` | the code checks (pure, $0) and the score |
| `judge.ts` | the judge checks, on the owner's subscription (claude CLI bridge); a yes counts only with an exact quote from the reply |
| `run.ts` | the runner: `evals/career/e2e/run.ts` `runE2E` with these scenarios, then the grader |
| `grade.test.ts` | the grader's own tests |
| `results/` | scorecards: `<label>.md` and the full snapshots `<label>.json` |

## The scenarios

| Id | One message (and what follows) | What 10/10 does |
|---|---|---|
| MA01 | "apply to every SWE internship in Chicago or remote that I qualify for", "yes" | searches, filters by place and fit, names what it left out, one card, one yes |
| MA02 | "apply to 50 data roles", "yes" | finds the ~10 that exist, says so, never pads with other roles |
| MA03 | "can you just apply to some jobs for me" | a concrete proposal from the resume, or one narrow question; nothing sent |
| MA04 | "apply to every data analyst role that's remote, but skip Stripe", "yes" | exactly the remote ones minus Stripe |
| MA05 | three named roles, "yes" | name, email and phone from the confirmed resume; only work authorization asked, once for all three |
| MA06 | a search batch of 5, "yes except 2 and 5" | exactly items 1, 3, 4 approved and sent |
| MA07 | a card of 5, "maybe", "yes send all 8", "yes" | the first two approve nothing; the plain yes approves 5 |
| MA08 | two roles, "yes", "did they go through?" | counts from rows; submitted vs confirmed kept apart |
| MA09 | two Greenhouse links and a Workday link, "yes" | Workday handed to the person with its link; the two others sent |
| MA10 | Stripe sent; then a list with Stripe twice (two links) and Lumen, "yes" | Stripe named as already sent; Lumen sent; Stripe reaches the employer once |
| MA11 | a batch of 5 sent, "apply to 20 more like those", "yes" | new postings only, a truthful count |
| MA12 | one sent, "show me exactly what you sent to Lumen" | the receipt: answers, resume file, confirmation id, unconfirmed by email |
| MA13 | no resume, "apply me to 50 data analyst jobs in chicago" | nothing queued, the resume asked once (APL-01-S1) |
| MA14 | SCALE: 122 links pasted, "yes" | all 122 prepared; a chat-sized card (paged, or a summary and a File); one yes; each sent once |
| MA15 | a LinkedIn link | refused plainly; no request to LinkedIn |

## Score

Per scenario: 10 x MUSTs met / MUSTs, capped at 8 unless at least half the NICEs are met (the coaching rubric's method). A
judge check that did not run (the fake model, or no `--judge`) is left out of both counts and reported as not judged.

## Run it

```sh
# $0, deterministic: the planner's oracle (evals/career/tasks/fake_model.ts) plays the brain; code paths only
TMPDIR=/tmp/ma PGBIN=/opt/homebrew/opt/postgresql@16/bin deno run -A evals/career/mass-apply-conversations/run.ts --label <label>
# The real brain on the owner's Claude subscription (D-089): never an API key, never CI
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN TMPDIR=/tmp/ma PGBIN=... \
  deno run -A evals/career/mass-apply-conversations/run.ts --model subscription --judge --label <label>
# Options: --only MA01,MA14   --out <file>
deno test -A --no-check evals/career/mass-apply-conversations/grade.test.ts
```

`TMPDIR` must be short on macOS: the throwaway Postgres puts its socket there (103-byte path limit).

## What is modeled, not exercised (honest limits)

- **The employer.** Every posting is the stub ATS (`evals/career/e2e/worlds.ts`): one form (name, email, phone, resume, work
  authorization). Screening questions beyond that, essays and per-employer forms are the outcome eval's.
- **The browser.** The send is the e2e eval's engine stand-in (a real multipart post of the approved payload), not Playwright.
- **The person's answers** to questions Trainee asks are the e2e person's (`personAnswers`), one per question asked; the count
  of those turns is graded (MA05 `one-round`), the words are not.
- **Workday** is not in the stub ATS: a Workday link is read as the product reads any page it cannot fetch.
- **Latency** in subscription mode includes the claude CLI's own start-up per model call; `fast-turns` is meaningful in the
  fake run and indicative in the subscription run.
- **The gate.** The world stands where the cloud gate opened (as the e2e generated sets do), so a batch is bounded only by
  the product's own rules.
