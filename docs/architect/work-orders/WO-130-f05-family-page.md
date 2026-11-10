# WO-130: serve the roles page (F-05) as the File family page

Status: drafting (after this release). Coordinator ruling, 2026-11-10 (item 6 S4): F-05 stays on `renderResults` for this
release. It is live, heavily pinned and measured. Only the content-rule gaps the Files loop flags are fixed inside
`renderResults`.

## Why
F-06, F-10 and F-11 are served in the File family design (`_shared/file_family.ts`), drawn live from the results list's own
records (`_shared/file_family_records_feed.ts`). F-05, which links to them, is still the older `results_page.ts` markup, so
C.1 (header, hero, action bar anatomy) cannot be measured on it as served. Its family twin, `liveShortlistPage`
(`_shared/file_family_live.ts`), already draws every control F-05 has (`tests/architect/r10-files-live-parity.test.ts`) and
passes the Files loop and the R10 visual checker. It is not served.

## Change
In `trainee-file/handler.ts` handleResults, draw `liveShortlistPage(rf, ctx)` in place of `renderResults(rf)`. `renderThings`
(the questions page) is out of scope. Nothing else in the handler changes: the feed, the actions and the posts stay the same.

## Pinned tests that read `renderResults` markup
These assert `results_page.ts` classes or structure (`<li class="card" id="r-">`, `<header class="filehead">`, `class="apply"`,
`refIn` and `cardOf` in `tests/helpers/results_world.ts`). Each needs the architect's rewrite against the family markup
(`<article class="ff-card ff-role" id="r-">`, `.ff-head`, `.ff-pri`) **before** the switch. No builder edits them to pass.

- `tests/helpers/results_world.ts` (`refIn`, `cardOf`)
- `tests/architect/apply-page.test.ts`
- `tests/architect/file-page-signin.test.ts`
- `tests/architect/file-states-phone.test.ts`
- `tests/architect/missing-info-e2e.test.ts`
- `tests/architect/r10-entry-signin-binding.test.ts`
- `tests/architect/r10-files-live-parity.test.ts` (becomes moot: one renderer)
- `tests/architect/results-batch-file.test.ts`
- `tests/architect/results-page-design.test.ts`
- `tests/architect/results-page-spec.test.ts`
- `tests/architect/results-page-stamp.test.ts`
- `tests/architect/role-pay-results.test.ts`, `-handler`, `-hardening`, `-header`, `-review2`, `-review3`
- `tests/architect/role-pay-results-browser.test.ts` (Chromium, CI only)
- `tests/architect/yes-approves-batch.test.ts`
- `tests/architect/files-records-loop.test.ts` (its F-05 content test reads `renderResults` markup)

To recheck the list before the switch: `grep -lE "renderResults|class=\"card\"|class=\"filehead\"|refIn\(|cardOf\(" tests/`.

## Acceptance
- `tests/architect/files-records-loop.test.ts` runs C.1 on F-05 as served: 0 failures, dead 0, unserved 0.
- Every rewritten pinned test passes against the family page, with the same behaviour asserted (hash-bound approvals, pause,
  dismiss, the questions flow, the sign-in binding).
- The R10 visual checker passes on the served F-05 at 390 and 1280 px.

## Out of scope
Any new action, any change to what a post does, and the questions page.

## Size cap
About 400 changed lines, the test rewrites excluded (they are the architect's).
