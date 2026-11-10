# WO-122: a reused sensitive answer says where it came from, on the card and in the hash

## Why
Coordinator ruling on a-sensitive (2026-11-10, PR #693, D.4 6: never reused "silently"). Work authorization,
sponsorship, GPA and graduation may travel from one application to the next as the person's confirmed answers,
scoped to the same country and the same 4.0 scale (#693 holds that scope). They may not travel silently. Each reused
answer must appear on that application's review card labelled with its source, and the yes to that exact payload
must cover it. A batch yes covers it only because the batch card lists it.

Measured on #693 (`evals/apply/sensitive-loop.ts`, the `REUSED` line), 27 real questions take a reused answer.
- 27/27 are on the card: `preparedCardProblem` refuses a card that leaves one out.
- 27/27 are in the payload hash: another value gives another hash.
- 0/27 say where the answer came from. A card line is `<label>: <value>`, and the payload carries no date for the answer.

`career_apply_questions.answered_at` exists, and `career_apply_answers_own()` already returns it. The worker drops it
before the engine sees it.

## What
1. **The date travels inside the hash.**
   - `TextAnswer` (`workers/career-browser/ask-once.ts`) takes an optional `at` (ISO 8601) from `answered_at`.
   - The engine's trusted source for a texted answer carries it: `scripts/apply.ts` `approvalSources` adds `at`, and
     the manifest row keeps it. It reaches `payload.fields[].source.at` (`approve-first.ts` `sourceOf`), so it is in
     the payload hash and in the engine approval hash.
   - `factsFromPayload` gives `at` back to the rebuilt `text_answers`, so `engineApprovalFromPayload` computes the
     same manifest. An approved payload without `at` (prepared before this order) stays valid and shows the no-date
     suffix.
2. **The card line takes the suffix, only for a reused sensitive answer.**
   - A field counts as reused and sensitive when two things hold:
     - its question maps to `work_authorization`, `sponsorship`, `us_person`, `citizenship`, `gpa` or
       `graduation_date` (`mapQuestion`);
     - its answer was not given for this application, meaning its source is not this posting's `job:` key and the
       answer's question row does not list this posting in `job_ids`.
   - Its line is `<prefix><label>: <shown> (from your answer on <Mon D>)`, with `<Mon D>` from `source.at`, for
     example "Nov 9". With no date stored, the line ends ` (from your confirmed facts)`.
   - One shared function, `reusedSourceSuffix(field, postingJobId, tz?)` in
     `supabase/functions/_shared/career_prepared_card.ts`, makes the suffix. Both of these use it:
     - the worker card (`approve-first.ts` `prepare`);
     - the extension card (`extension/src/apply_core.ts` `cardLines`, source `trainee`).
   - The date is in the person's own IANA time zone (R7, the time_zone rule), which the payload carries as
     `payload.tz` (inside the hash). It is never UTC: with no zone stored, the line shows no date and ends
     ` (from your confirmed facts)`, because a UTC date can be the wrong day. The function is the only formatter.
   - Every other card line stays byte-identical. A line for an answer given fresh in this application takes no
     suffix.
3. **The server accepts exactly that suffix.**
   - `preparedCardProblem` accepts a field line equal to the unsuffixed line plus
     `reusedSourceSuffix(field, payload.job_id, payload.tz)`, and nothing else.
   - It refuses these: a suffix on a fresh or non-sensitive field, a missing suffix on a reused sensitive field, and
     a date that is not the field's own `source.at`.
4. **Which answers are fresh.**
   - A new additive function, `career_apply_answers_own_v2()`, returns `job_ids` beside the v1 columns. v1 is
     unchanged. The migration is approved under this order (coordinator, 2026-11-10). It is timestamped after
     20261110130000, and it ships with a rollback, a db test (`tests/db/`) and a go-live MIGRATIONS entry with its
     mark. Agents never apply it live.
   - The worker reads v2 and falls back to v1 when v2 is not deployed. Under v1, a texted answer's freshness is
     unknown, so its line takes no suffix (it fails toward the ruling's "fresh takes none"). The loop reports that
     gap.

## Files
- `workers/career-browser/ask-once.ts`
- `workers/career-browser/approve-first.ts`
- `scripts/apply.ts`
- `supabase/functions/_shared/career_prepared_card.ts`
- `extension/src/apply_core.ts`, plus the regenerated `extension/lib/trainee-core.js`
- `evals/apply/sensitive-loop.ts`
- one migration, `supabase/migrations/<ts>_career_apply_answers_own_v2.sql` (ts after 20261110130000), with its
  rollback, its db test and its go-live MIGRATIONS entry and mark. It is additive and applies to no live database
  without the owner.
- tests below

## Acceptance tests (written first in `tests/architect/pending/`)
`tests/architect/wo-122-reused-answer-source.test.ts`:
- **Sources and dates.**
  - A texted sponsorship answer from application A, reused at B, shows on B's card with
    ` (from your answer on Nov 9)`.
  - A facts-file GPA shows with ` (from your confirmed facts)`.
  - A texted answer with no time zone stored shows ` (from your confirmed facts)` and no date. No UTC date is ever
    shown.
  - The same answer, given for B itself, has no suffix.
  - A non-sensitive reused answer (city, how heard) has no suffix.
- **Hash.**
  - Changing `source.at` changes the payload hash and the engine approval hash.
  - `engineApprovalFromPayload` still matches after the round trip.
  - A legacy payload without `at` validates.
- **Migration.** `tests/db/` covers v2: it returns `job_ids`, only the caller's rows are returned, v1 is
  unchanged, and the rollback removes v2.
- **Server check.**
  - `preparedCardProblem` accepts each correct suffix.
  - It refuses a suffix on a fresh field, a missing suffix on a reused one, another date, and extra words.
- **The loop.** `sensitive-loop.ts` `labelled with source` is 27/27, with every other number unchanged (90/90, 5/5,
  27/27 on the card and in the hash).

## Pinned card-line tests (coordinator ruling)
An existing test that pins a card line for a reused sensitive answer may be amended to accept exactly the suffix.
Each one is listed in the PR body as "architect amendment, D.4 6 source label". No other pinned line changes.

## Demo (owner)
1. Run `deno run -A --no-check evals/apply/sensitive-loop.ts` and read the `REUSED ... labelled with source 27/27`
   line.
2. Run `deno test -A --no-check tests/architect/wo-122-reused-answer-source.test.ts`, which prints the B card with the
   suffix.

## Out of scope
- Workday's step cards: their answers are the page's.
- Labelling non-sensitive reused answers.
- Changing which facts may travel (#693 holds the scope).
- Applying the v2 migration live (the owner's).

## Size cap
About 400 changed lines, excluding the generated bundle. Split the extension card into its own PR if it goes over.

## Depends on
#693 merged.
