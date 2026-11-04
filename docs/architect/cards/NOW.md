> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# NOW: what Codex works on next (the architect updates this; newest first)

Read this first, every time you start or finish something. The cards are in this folder; the full requirement list
and build order are in `docs/product/REQUIREMENTS.md`.

## 2026-10-20 02:00 UTC: your queue, in this order
1. **C-01 (PR #28): fix the two blocking findings in my review on #28 before anything else.**
   - (1) Module 150 puts `education_school` into a yes/no checkbox ("…publicly-funded institution…" got "TEST University"). Apply the free-text-only rule to the education keys and add that label as a trap.
   - (2) Ashby yes/no questions bound to a lone checkbox are planned "Yes"/"No" with no readback; stop them as a live widget or bind Yes as checked with a boolean readback.
   - Then merge trunk and re-pin the Ashby counts, with the reason.
2. **C-02:** the safety review of PR #25 and #27 (both merged; review them anyway) and #29 (open). Post the findings on each.
3. **C-03:** the live-assist guard (unchanged).
4. **WO-021 W2 and W3 moved to the architect** (built under WO-022, `wo/021-w2-w3`). Do not start them.
5. **C-04 moved to the architect** (PR on `wo/c04-relevance-floor`). Do not start it.

## 2026-10-20 00:00 UTC: your queue, in this order
1. **C-02:** the safety review of PR #23 (merged; review it anyway) and PR #25. Post the findings on each PR.
2. **C-01:** open the PR for the module-150 contact precision. The code is already verified at 22/22.
3. **C-03:** the live-assist guard. 120/120 on the labeled set, plus the prompt line.
4. **WO-021 W2:** the batch card shows every answer.
5. **WO-021 W3:** the texted yes ("yes", "yes but not N", "change N <field> to <value>", "stop").
6. **C-04, the relevance floor:** `docs/architect/cards/C-04-relevance-floor.md`, fully specified.

Every result you report is labeled VERIFIED (against what), REPORTED, ASSUMED or NOT_RUN.

## 2026-10-19 23:00 UTC
1. **The engine now reads all 17 captured real forms (was 6 of 17)**, and `--approved <hash>` submits an application the
   person already approved. Both are in PR #25. Merge trunk before touching anything under `scripts/` or `tests/career-apply-*`.
2. **D-014 is settled: one apply stack.** The planner (`career_apply.ts`), the queue (`career_apply_jobs`) and the engine
   (`scripts/apply.ts`). Module 155 gets no new apply features.
3. **WO-021 cards for you, after C-01, C-02 (#23 and #25) and C-03:** W2 (the batch card shows every answer) and W3
   (the texted yes: "yes", "yes but not N", "change N <field> to <value>", "stop"). Both are fully specified in
   `docs/architect/work-orders/WO-021-approve-first.md`. W1 (the approval hash per application) lands first, from the
   architect; start W2 from its output shape.

## 2026-10-19 22:00 UTC
1. **New card: C-03, the live-assist guard (D-015).** The guard gets 5 of 10 wrong today. Do C-03 after C-01's PR and
   your C-02 review of #23. It is bounded: one function, one data file, one test, one prompt line.
2. **The plan for matching Tsenta's whole product, faster and cheaper:** `docs/product/tsenta-faster-cheaper.md`. Read
   its "Order of work". The apply path defaults to the person's own browser (D-017), so nothing you build assumes a
   cloud browser.

## 2026-10-19 21:00 UTC
1. **Your detector fix is in PR #23** (ported from `58e7b97d`, credited in the code): only a visible challenge frame
   counts, plus two rules I added. A visible checkbox widget with no token is a challenge (the person must tick it).
   A token in `g-recaptcha-response`, `h-captcha-response` or `cf-turnstile-response` means it was passed.
   Once #23 merges, merge trunk into `wo/009b-3-acceptance` and keep my version of `fnDetectChallenge`. Then re-run
   your forms acceptance and report the count against the 17 forms (VERIFIED, with the command).
2. **C-02 now covers the captcha commit on #23 too.** Check these, in addition to the seven rules:
   - The provider allowlist `CAPTCHA_PROVIDER` is anchored to the host; try to get a look-alike host through it.
   - A provider can never be a page navigation.
   - The token's value is never written to evidence; only its field and length are.
   - Hand-off at submit never clicks submit again; the one-POST and body checks still decide.
   - Without `--handoff`, a challenge at the click ends `not_submitted` / `CAPTCHA_AT_SUBMIT` with nothing sent.
   Post every hole you find, or "no holes" plus what you tried.
3. **The owner's build standard is the bar for everything:** `docs/product/BUILD-STANDARD-TSENTA.md` (coming in the
   competitors PR). Every number you report carries VERIFIED, REPORTED or ASSUMED.
4. Unchanged: the daily cap is 15. Nothing on networking, interview or offers until the first real application is proven (P0).

## 2026-10-19 19:30 UTC
1. **C-02 is open: PR #23** (`WO-009b-4 engine: ...`). Review it against the seven rules and post on the PR. One of
   your tests changed there (`009b-4 a submit handler cannot change a confirmed answer`: now `not_submitted` /
   `APPROVED_BODY_MISMATCH`, still asserting nothing reached the employer); say if you see a hole in that reasoning.
2. Still: C-01 on `wo/009b-3-acceptance`, then its PR.
3. Note the daily cap is now **15, not raisable** (owner, 2026-10-19): any of your code or tests that assume 25 or 50
   is out of date.

## 2026-10-19 18:45 UTC
1. **Read `docs/product/STANDARD.md` once** (the owner's bar: real-world depth, competitor, scale, no placeholders).
   From now on every result you report is labelled VERIFIED (and against what), ASSUMED or NOT_RUN. Your 0/24 and
   CONNECT 403 reports are the model.
2. Trunk is green again (PR #19 merged at 852ea88d). Merge trunk into your branch before C-01's proofs.
3. C-01 is still the job. Then C-02 when the engine PR opens.

## 2026-10-19 17:00 UTC
1. **C-01, now.** On your branch `wo/009b-3-acceptance`: merge trunk, apply the code in C-01 exactly, run the proofs,
   open the PR. The architect ran this exact code on your branch: 22/22, portal 92/92 unchanged.
2. **Stop work on `scripts/apply.ts` and `workers/career-browser/`.** They moved to the architect (branch
   `wo/009b-4-engine`). Your `wo/009b-4-apply-cli` and `wo/009b-5-worker-pull` stay as they are; do not push to them.
3. **C-02 when the architect's engine PR opens** (title starts `WO-009b-4 engine:`): the seven-rule review.
4. **Not now:** `wo/009b-6-coverage` waits (redirected in WO-009b to read `evals/apply/questions-ci*.json`; a card
   will say exactly how). Nothing on networking, interview or offers until P0 is proven.
5. Trunk was red from 12:01 UTC today on `career-ingest` B9 (a clock bug, the architect's): PR #19 fixes it. If your
   CI shows that one failure before #19 merges, it is not yours; say so in one line and carry on.
