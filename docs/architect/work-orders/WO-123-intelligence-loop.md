# WO-123: the intelligence loop (every release measured on the real model; real failures become held-out cases)

## Why
The owner's directive (2026-11-10, in the architect's chat): "we're creating a process for incredible intelligence".
Today the reply brain's quality is measured when someone remembers to measure it, and the cases it is measured on are
written by us before the deploy:

- **The held-out sets are not a release gate.** S3 (`scripts/launch/deploy-standard.ts`) compares the dev set's pass rate
  for the candidate with the deployed SHA's, but the D-054 set (`evals/career/d054-items-7-9.json`, release items 7 and 9)
  ran twice by hand (D-054 run 42873384867, $1.630; D-055 run 42897333579, $1.686) and nothing makes a release wait for it.
  The Instinct tone gate (`tests/architect/instinct-tone-gate.test.ts`, #746) runs in the architect partition, but no
  release check names it, so a release can carry a SHA whose tone gate was never green.
- **Real conversations never come back.** After a deploy, a reply that breaks the reply rubric
  (`supabase/functions/_shared/reply_rubric.ts`) or that the owner flags is fixed (sometimes) and forgotten. It never becomes
  a case the next release is measured on, so the same failure can return.
- **The tone gate is fixed at the turns of one head-to-head** (`docs/architect/INSTINCT-HEAD-TO-HEAD.md` A.2 and B.6). Every
  Instinct transcript the owner sends after that is read once and dropped.
- **The harness measured is not the harness deployed.** #745 changed the eval harness (`evals/career/harness.ts`,
  `HARNESS = "parity 2026-11-10: ..."`: the router's search step and apply ledger). `ci/brain-eval` still holds the older
  harness, and S3 compares only rows of the same harness, so the first release after release 11 has no comparable
  deployed measurement until the deployed SHA is re-measured on the new harness. The readiness report for release 11 names a
  crash risk on that re-measure: the new harness calls `J.searchReplyParts` (`harness.ts` `searchStep`), which does not exist
  in reply code before #745, so measuring an older deployed SHA with the new harness throws instead of scoring.
- **A score is never lowered.** When a pass is found later to be false (D-054: 35 of the router's `invented_fact` hits were
  judged by hand; a judge passing a reply the rubric fails), the SCORE-LOG row keeps the old number and S3 keeps comparing
  against it.

Five changes, one loop: measure every release on the real model, block on a drop, feed real failures back as held-out
cases, grow the tone gate, and keep every recorded number honest.

## What

### 1. The intelligence release gate (S7)
- A new check **S7** in `scripts/launch/deploy-standard.ts`, implemented in `scripts/launch/intelligence-gate.ts`:
  - **Held-out sets.** The list is `RELEASE_EVAL_SETS` in `intelligence-gate.ts`: the dev set S3 already reads, and
    `evals/career/d054-items-7-9.json` (scored by `evals/career/d054-score.ts`). Each later set added by step 2 is added
    here by its own PR.
  - **The bar.** For each set, the candidate's measurement (five passes, `MEASUREMENT_PASSES`, the same harness and judge
    pair as the deployed SHA's, the rules S3 already uses to tie a measurement to a SHA) must not be below the deployed
    SHA's: the mean pass rate compared exactly (integer cross-multiplication), and for the D-054 set also each code-scored bar
    of `d054-score.ts` (invented 0, unevidenced 0, corrections_kept 100%, sensitive_defaulted 0, reuse_unmarked 0) must not
    get worse. A drop fails S7, and a failed S7 blocks the release exactly as a failing S1 test does. No tolerance; a
    tolerance needs a written owner ruling.
  - **Tone gate.** The `gate (architect)` check that ran `tests/architect/instinct-tone-gate.test.ts` concluded success on
    the candidate SHA, and its `OPEN` list did not grow against the deployed SHA's (shrink-only, as S4 treats `KNOWN_GAP`).
  - **No measurement is a FAIL**, never a pass. `--missing-measurement` names each set still missing, as it does for S3.
- **Budget (D-038a).** Every run S7 needs is one `brain-eval.yml` run with an explicit per-run `budget_usd` in
  `evals/career/eval-request.json`:
  - `releaseEvalRequest()` in `intelligence-gate.ts` writes the request: the sets, five passes, the brain the SHA serves,
    and `budget_usd` = `RELEASE_RUN_CAP_USD` ($3.00, the D-054 cap; both sets' D-054/D-055 quotes were $2.454).
  - It refuses (throws, writes nothing) when the cap is above what remains of the $70 on the shared ledger
    (`supabase/functions/_shared/model_budget.ts`, about $41.74 after D-055 by VERIFICATION-15's figures; the ledger is the
    authority), and when a set has no quote.
  - `run.ts`'s own preflight still refuses a quote over `budget_usd`; S7 adds no new spend path.
  - **Spend still needs the owner's written yes per run until the owner rules otherwise.** This order proposes, as a
    DECISIONS line for the owner, a standing approval: "each release's S7 run, at most $3.00, from the $70". Until that
    line exists, S7 prints the request and the quote and fails with "needs the owner's spend approval", never spends.
- The deploy workflow measures what S7 names the way it measures S3 today (`scripts/launch/measure-reply.sh`), after the
  owner's approval of the `production` environment. Changing `deploy-production.yml` is part of this order; changing the
  deploy standard's existing checks S1-S6 is not.

### 2. Real conversations become held-out cases
- `evals/career/intake.ts`, `caseFromConversation(conv, { reason, persona })`:
  - **Input.** A conversation exported after the deploy: turns, with the reply rubric's violations for each Trainee reply.
  - **When a case is made.** For a conversation where `checkReply` fails a reply (`reason: "rubric"`), or one the owner
    flags (`reason: "owner_flag"`, with the owner's note).
  - **What it returns.** One held-out item in the `d054-items-7-9.json` item shape (`id`, `turns`, `must`, `must_not`,
    `world`), with:
    - `source: { reason, rubric: [rule ids], flagged_at }` and no user id, thread id or message id;
    - every person-identifying value replaced from a test persona (`coverage-personas.ts`): names, emails, phone numbers,
      street addresses, employers the person named about themselves, school names, links with a handle in them; dates
      shifted by one fixed offset per case.
  - **Privacy is a hard check, not a best effort.** `assertRedacted(item, original)` fails if any token of the original's
    personal values (the person's profile facts and contact fields) is still in the item, or if any email or phone pattern
    remains that is not a persona's (`@example.test`, the 555-01xx range). `caseFromConversation` calls it and throws, so an
    unredacted case cannot be written.
  - **Where cases go.** They are written only to `evals/career/heldout-intake/<yyyy-mm-dd>-<n>.json`. Never raw
    transcripts, never real names or emails in the repo (`tests/no-secrets.test.cjs` gains the intake folder).
- `scripts/launch/intake-cases.ts` (owner-run, read only against production) exports the conversations, runs
  `caseFromConversation`, and prints the cases for review. The owner approves each case before it is committed. Reading
  production data is the owner's step; agents never run it.
- **Sealing.** A case goes into the next held-out set. The builder never tunes against it before it has been measured
  once (the sealed-set rules of `evals/career/sealed/`).

### 3. The tone gate grows with every Instinct transcript
- Each Instinct transcript the owner sends is stored, redacted by the same `assertRedacted`, as
  `evals/career/instinct-tone/<yyyy-mm-dd>-<n>.json`:
  - `{ id, source: "owner", turns: [{ say, instinct }], resume?: boolean }`;
  - `instinct` is Instinct's reply, kept as the bar's length and style only, never as wording Trainee must say.
- `tests/architect/helpers/instinct_tone.ts` `toneCases()` returns the A.2 and B.6 turns plus every file in that folder.
- `instinct-tone-gate.test.ts` (the architect amends it once, under this order) scores all of them.
- A new transcript's turns that fail the bar start in `OPEN` with the reason. `OPEN` is the ratchet the gate already has:
  an open turn that starts passing must leave the list, and the list never grows without a new transcript.

### 4. The harness parity sync, right after release 11 deploys
- Owner-run, after release 11's S6 passes (release 11 is cut at trunk 1d5ca0ff, which includes #745):
  1. Merge trunk's `evals/career/harness.ts` (the `parity 2026-11-10` harness) into `ci/brain-eval`, in a measurement-branch
     commit with no reply-code change.
  2. Re-measure the deployed SHA (release 11) on the dev set and the D-054 set with that harness: five passes each, under
     the per-run cap of section 1. This is the new S3 and S7 baseline.
  3. Record the run ids, costs and scores in `docs/architect/VERIFICATION-15.md` and `evals/career/SCORE-LOG.md`.
- **The crash risk.** The new harness calls `J.searchReplyParts`, which reply code before #745 does not export. Measuring a
  SHA without it throws inside `searchStep` and the pass crashes, with no row. Before any spend:
  - `harness.ts` checks `typeof J.searchReplyParts === "function"` (and `askFor`, `searchJudgeTurn`) once, through
    `harnessFits(J)`, at the start of a run;
  - a SHA that lacks one is refused before the first model call: the run stops with
    `NOT A SCORE: harness parity 2026-11-10 needs searchReplyParts (absent at <sha>)`, at $0.
  - Release 11 and every later SHA have it. A deployed SHA older than #745 is never re-measured on the new harness; S3 and
    S7 then fail with that reason, and the owner decides.

### 5. The honest-number rule
- A false pass found later lowers the recorded score. SCORE-LOG rows are never edited; a correction is a new line,
  `| <now> | CORRECTION | run <id> pass <n> | -<k> | <item ids> | <why> | <who> |`, written by
  `evals/career/score-log.ts` `correctionRow()`.
- `deploy-standard.ts` `parseScoreLog` returns rows with corrections applied (`applyCorrections(rows, corrections)`):
  - `passed` drops by k for that run's pass;
  - a correction naming a run that is not in the log is itself an error and fails S3 and S7;
  - a correction can only lower a score, never raise it (a fail found to be a pass is re-judged as a new run, not
    corrected).
- `VERIFICATION-15.md` and `SCORE-LOG.md` state the corrected number beside the original. The first correction to write is
  any false pass the D-054/D-055 hand review found, if one stands.

## Files
- `scripts/launch/intelligence-gate.ts` (new): `RELEASE_EVAL_SETS`, `RELEASE_RUN_CAP_USD`, `releaseEvalRequest`, `s7`.
- `scripts/launch/deploy-standard.ts`: S7 wired beside S1-S6, `--missing-measurement` names S7's sets, `parseScoreLog`
  applies corrections.
- `.github/workflows/deploy-production.yml`: measure S7's missing sets as S3's are measured; judge S7.
- `evals/career/intake.ts` (new): `caseFromConversation`, `assertRedacted`.
- `scripts/launch/intake-cases.ts` (new, owner-run).
- `evals/career/heldout-intake/` (new folder, a README line only until the first case).
- `evals/career/instinct-tone/` (new folder).
- `tests/architect/helpers/instinct_tone.ts` (new): `toneCases`.
- `evals/career/harness.ts`: `harnessFits(J)` and the refusal before the first call.
- `evals/career/run.ts`: calls `harnessFits` before the first model call.
- `evals/career/score-log.ts`: `correctionRow`, `applyCorrections`.
- `tests/no-secrets.test.cjs`: the two new folders scanned.
- `docs/architect/DECISIONS.md`: the proposed standing spend line, for the owner (not in force until the owner says yes).
- `docs/launch/TRAINEE-GO-LIVE.md`: S7 and the post-release-11 harness sync, as owner steps.
- Tests below. `instinct-tone-gate.test.ts` is amended once by the architect (to read `toneCases()`), nothing else.

## Interfaces
```ts
// scripts/launch/intelligence-gate.ts
export const RELEASE_RUN_CAP_USD = 3.0;
export interface EvalSet { id: string; path: string; scorer?: "d054" }
export const RELEASE_EVAL_SETS: EvalSet[];                       // dev (S3's) and d054-items-7-9
export interface SetMeasurement { set: string; size: number; passes: number[]; harness: string; judges: string; bars?: Record<string, number> }
export function releaseEvalRequest(o: { sha: string; brain: string; sets: EvalSet[]; remainingUsd: number; quotes: Record<string, number>; capUsd?: number }):
  { sets: string[]; passes: 5; brain: string; budget_usd: number }; // throws when a quote is missing, the cap exceeds the remainder, or a quote exceeds the cap
export function s7(o: { candidate: Record<string, SetMeasurement | null>; deployed: Record<string, SetMeasurement | null>;
  tone: { concluded: "success" | "failure" | "missing"; open: string[]; deployedOpen: string[] }; spendApproved: boolean }):
  { id: "S7"; pass: boolean; summary: string; evidence: string[] };

// evals/career/intake.ts
export type IntakeReason = "rubric" | "owner_flag";
export function caseFromConversation(conv: { turns: { role: "person" | "trainee"; text: string; violations?: string[] }[]; profile: Record<string, string>; flaggedAt?: string; note?: string },
  o: { reason: IntakeReason; persona: Record<string, string>; id: string }): HeldoutItem; // throws if assertRedacted fails
export function assertRedacted(item: unknown, original: { profile: Record<string, string> }): void;

// tests/architect/helpers/instinct_tone.ts
export function toneCases(dir?: string): { id: string; turns: { say: string; instinct: string }[] }[];

// evals/career/harness.ts
export function harnessFits(J: Record<string, unknown>): { ok: true } | { ok: false; missing: string[] };

// evals/career/score-log.ts
export function correctionRow(o: { at: string; run: string; pass: number; minus: number; items: string[]; why: string; who: string }): string;
export function applyCorrections<R extends { run: string; passed: number }>(rows: R[], corrections: { run: string; pass: number; minus: number }[]): R[];
```

## Acceptance tests (written first in `tests/architect/pending/`)
`tests/architect/pending/wo-123-intelligence-loop.test.ts`:
- **WO-123/1 S7 blocks a drop.** The candidate is one item below the deployed SHA on the D-054 set and equal on dev: S7
  fails and names the set. Equal on both, with the tone gate green: S7 passes.
- **WO-123/2 a missing measurement is a FAIL**, as is a harness, judge pair, set size or pass count that differs from the
  deployed side's.
- **WO-123/3 a worse code-scored bar fails.** `invented` 0 → 1 on the D-054 set fails although the mean is equal.
- **WO-123/4 the tone gate is part of S7.** A failed or missing `gate (architect)` fails S7, and so does an `OPEN` list that
  grew.
- **WO-123/5 budget.** `releaseEvalRequest` writes `budget_usd` 3 and five passes. It throws when the cap is above the
  ledger's remainder, when a set has no quote, or when a quote is over the cap. With `spendApproved: false`, S7 fails with
  the owner-approval reason.
- **WO-123/6 intake: privacy.** A conversation with a fictional "real-looking" name, email, phone and employer becomes an
  item with none of them; `assertRedacted` throws on an item that keeps any of them. The item carries
  `source.reason` and the rubric rule ids, and no user, thread or message ids.
- **WO-123/7 intake: what becomes a case.** A conversation whose replies all pass the rubric and is not flagged makes no
  case (`caseFromConversation` throws "no rubric failure"). An owner flag makes one with the note.
- **WO-123/8 the tone gate grows.** `toneCases(dir)` over a temp folder with one extra transcript returns the A.2/B.6 turns
  plus that transcript's turns. A transcript with an email in it is refused.
- **WO-123/9 harness fit.** `harnessFits` on an object without `searchReplyParts` returns `missing: ["searchReplyParts"]`;
  `run.ts`'s preflight stops with the NOT A SCORE reason before any model call (a scripted model records 0 calls).
- **WO-123/10 honest numbers.** `applyCorrections` lowers one pass's `passed` by k and never raises it. A correction for an
  unknown run throws. S3's rate over corrected rows is lower than over the raw rows.

## Demo (owner)
1. `deno test -A --no-check tests/architect/wo-123-intelligence-loop.test.ts`. It prints S7's verdict for a scripted drop
   (FAIL, naming `d054-items-7-9`) and for an equal candidate (PASS).
2. `deno run -A scripts/launch/deploy-standard.ts --sha <trunk sha> --checks S7 --missing-measurement`. It prints the sets
   still to measure, the request with `budget_usd` 3, and the quote. Nothing is spent.
3. After release 11 deploys: section 4's three steps. Then read the new baseline rows in SCORE-LOG.
4. Send one Instinct transcript. The next PR adds `evals/career/instinct-tone/<date>-1.json`, and the tone gate's printed
   turn count grows by its turn count.

## Out of scope
- Any spend. Every run is the owner's yes, or the standing line in section 1 once the owner writes it.
- Reading production conversations. That is the owner's script run; agents never read production data.
- Changing S1-S6, their bars, or the 95% D-030 bar.
- Changing the judges or their prompts.
- Tuning the brain against intake cases before they are measured once.
- Merging to or pushing `ci/brain-eval` or `release/production`; both are the owner's steps.

## Size cap
About 700 changed lines, excluding test fixtures and generated result files.
Split if over: (a) S7 and the budget request, then (b) intake and the tone-gate loader, then (c) harness fit and
corrections. Each part has its own tests from the pending file.

## Depends on
- Release 11 deployed (cut at trunk 1d5ca0ff) for section 4.
- The owner's spend line for section 1's standing approval.
