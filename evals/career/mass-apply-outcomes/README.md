# Mass-apply outcome eval (DT-1)

Grades mass applying on **what happens to each application**, never on the wording of a reply. 24 real captured forms
(8 Greenhouse, 8 Lever, 8 Ashby) x 2 synthetic people = 48 applications, each driven offline through the product's own
functions from preparation to proof. The latest numbers are in [`results/SCORECARD.md`](results/SCORECARD.md); the full
per-application record is `results/baseline.json`.

## Run it

```sh
# Deterministic, CI-cheap (about 5 s; read permission only: no network, no subprocess, no model)
deno run --allow-read evals/career/mass-apply-outcomes/run.ts
# Its tests (also run by the gate through tests/career-mass-apply-outcomes.test.cjs)
deno test --allow-read --no-check evals/career/mass-apply-outcomes/outcomes.test.ts
# Refresh the baseline after an intended change (say why in the PR)
deno run --allow-read --allow-write evals/career/mass-apply-outcomes/run.ts --write --trunk <trunk sha>
# Exit 1 if the run differs from the committed baseline at all
deno run --allow-read evals/career/mass-apply-outcomes/run.ts --check
# OPTIONAL, off by default: a model second opinion on every wrong or contested answer (see "Judge mode")
deno run --allow-read --allow-run=claude --allow-env evals/career/mass-apply-outcomes/run.ts --judge --judge-max 40
```

The gate test is a **ratchet**, not a frozen snapshot: it fails when wrong answers, unsafe-ready applications,
unidentifiable answers or required gaps rise, when correct fills fall, or when any downstream check fails more often than
in the baseline. A PR that improves a number refreshes the baseline with `--write`. Each downstream check also ratchets its denominator
(no fewer applications may reach it), so making applications unpreparable cannot pass by shrinking what is checked.

**Reviewer checklist.** A PR that edits `gold.json` (or `personas.json` / `scenarios.json`) together with
`results/baseline.json` can move the bar it is measured against: review both diffs, and check every changed label against
the field's own wording and the person's confirmed facts, never against the planner's output.

## What each application goes through

| Stage | Product code exercised | Graded on |
|---|---|---|
| Prepare | `planForm` (`extension/src/apply_core.ts`; the planner the extension and `workers/career-browser/ats-fill.cjs` use, over `planBatch`) with only the person's confirmed facts | each field against `gold.json`: filled correctly, wrong, asked (genuinely unanswerable or not), left empty; screening/knockout fields; ready vs held for questions |
| Person answers | `planForm` again with the person's own answers saved under each question's wording | whether the application can then be prepared at all |
| Card and one yes | `cardTurn` (`career_apply_cards.ts`) and `hashApplyPayload` (`career_apply_store.ts`) | the numbers each reply approves (D-MS-1 grammar: "maybe" and a wrong count approve nothing; "yes except 2"), an item changed after it was shown is not queued |
| Enqueue | `admitApplication` (`career_apply.ts`, the TS mirror of the ledger) | approval hash = current payload hash; a stale approval refused; the same posting by other links refused (D-MS-3); a second role at one company admitted |
| Submit | `classifyOutcome` / `outcomeAfterSend` over 8 simulated employer pages (`scenarios.json` `portal`) | the recorded state, and whether a second send of the same posting is refused |
| Proof | `receiptText` (`career_apply_receipts.ts`), `planConfirmations` (`career_apply_confirm.ts`) | the receipt says only what is true; only the employer's authenticated email confirms, a look-alike never does |

**Wrong answers must be zero.** The verdict is FAIL while any wrong answer exists or any application is marked ready with
a required question no confirmed fact answers.

## Inputs

- **Forms**: the committed real question set `evals/apply/questions-ci.json` (CI capture of public Greenhouse, Lever and
  Ashby application forms, 2026-10-19), with each posting's location from `evals/apply/posting-locations.json`. Nothing is
  fetched. US-located postings were chosen, smaller forms preferred, across all three families.
- **People** (`personas.json`): A is a US citizen in Chicago with most facts and the standing consents confirmed; B is on
  F-1 OPT in Austin (authorized now, needs sponsorship, not a U.S. person for export control) with few facts and no
  consents. B is the knockout persona: a truthful answer to a screening question can cost B the job, and must still be given.
- **Gold labels** (`gold.json`): all 369 fields (355 graded per person; the other 14 are Greenhouse paste boxes), per person, written from the field's label and options and
  the person's confirmed facts **before the planner was run on this set**. Grammar: `fill:` (must be filled with one of the
  values), `either:` (fill with one of them or ask), `ask` (nothing confirmed answers it: any fill is wrong), `alt`
  (Greenhouse's paste box beside its upload, not graded), `ko` (screening question), `contested` (a fill is reported, not
  counted wrong, because a second reading is plausible). The labels are checked on every run: an accepted option that is not
  on the form, or a `$fact` the person never confirmed, stops the run.
- **Scenarios** (`scenarios.json`): the card replies, the duplicate link variants, the employer pages and the mail.
  Every expectation is written from the rules (D-MS-1, D-MS-3, D-024, `outcomeAfterSend`'s contract, the finish function in
  `20261021075000_career_apply_ops.sql`), not from the code's output.

## What is modeled, not exercised (honest limits)

- **The database.** The card store and the recording of a finished drive are in memory: the store does what
  `career_apply_card_answer_as` does (an item whose payload hash changed is `changed`), and `recordFinish` does what
  `career_apply_finish` does (a page's thank-you is `submitted_unconfirmed` with `page_confirmation`, never `confirmed`).
  Which numbers a reply approves, every hash, every admission and every duplicate decision are the product's TS code; the
  SQL twins are covered by the Postgres suites (`mass-submit-pg`, `mass-submit-handler-pg`), not here.
- **The browser.** Filling the page (`ats-fill.cjs`, `scripts/apply.ts`) is not run; the eval grades the prepared payload
  the person approves. Employer pages are simulated observations, not HTML.
- **The person's answers** to open questions are TEST values (first option, a link, a number); they are never graded.
- **Scale.** 48 applications; it measures correctness, not throughput (APL-13 is separate).

## Judge mode (optional, off by default)

`--judge` asks a model for a second opinion on each answer the grader called wrong or contested, so a gold label can be
challenged; it never changes the score. Owner rule: it calls only the `claude` CLI (`claude -p --model haiku
--output-format stream-json --verbose --tools "" --strict-mcp-config`, prompt on stdin) with `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` removed from the child's environment, and refuses any answer whose init event does not report
`apiKeySource: "none"` (subscription billing). Before the first call, a preflight reads the CLI's settings
(`~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude.json`, and the project's `.claude/settings*.json`)
and refuses the whole run if any sets `apiKeyHelper`, holds `primaryApiKey`, or puts either key in its `env`, or cannot be
parsed. CI never runs it. On the first baseline it agreed with 2 of the then 3 wrong answers and
was unsure about CesiumAstro's "U.S. Person or eligible to obtain an export license". That field is now labeled `ask` and
contested: "No" from `us_person` alone is unsupported, but reading it as "are you a U.S. person" makes "No" plausible, so it
is reported, not counted wrong.

## Files

| File | What |
|---|---|
| `harness.ts` | the stages, the grader, the scorecard |
| `run.ts` | the command line |
| `judge.ts` | the optional model second opinion |
| `outcomes.test.ts` | the grader's own tests, determinism, the baseline ratchet, the judge's billing guard |
| `gold.json`, `personas.json`, `scenarios.json` | hand-written inputs |
| `results/` | generated: `baseline.json`, `SCORECARD.md` |
