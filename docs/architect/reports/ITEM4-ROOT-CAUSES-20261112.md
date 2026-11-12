# Item 4 (browser runner): why it does not reach the 99% bar, and what this PR changed (D-072 (item 4), 2026-11-12)

The bar (owner, 2026-11-12, D-072): on the strict real-postings benchmark (`scripts/browser-eval/strict.cjs`, 220 real postings ×
4 samples: tuned sample and held-out, default and full persona) and the held-out 60 (`batch60.cjs`), at least 99% of postings per
sample, **218/220** and **60/60** by exact integer count, end in (a) every field filled from confirmed facts up to the instant
before Submit, or (b) a kept wall (a shown check, the employer's account sign-in, an answer only the person can give, a required
upload only they have) reached with everything else filled and the hand-off produced. Every stop names its real reason.

Every number below is a dry run on real public postings: nothing was submitted, every non-GET request was aborted in the browser,
no check was solved or touched, nobody was signed in, no account was made, LinkedIn and Indeed were never opened. $0, no model.

## How the causes were read

Every posting of every sample was classified by `scripts/browser-eval/d072.cjs` (`classify`), from the bench's own per-posting
lines (`STRICT`, `DIAG`, `NEEDS`, and since this PR `HANDOFF` and `D072`). Before: bench run **43192269304** (branch
`bench/browser-v95-44b436f9`, trunk 44b436f9), the run VERIFICATION-15 quotes (33/33/32/34 of 220). After: bench run
**43276162667** (branch `bench/browser-v95-8d948f64`, this PR's head + the bench workflow, never a PR). An intermediate run of
this branch, **43273066955**, found the BambooHR Submit drawn outside its form (fixed in the head) and a crash on a robots stop in
two jobs (fixed).

## Totals per sample

| | sample-default | sample-full | held-out-default | held-out-full |
|---|---|---|---|---|
| Raw reached Submit, before (43192269304) | 33 | 32 | 33 | 34 |
| Raw reached Submit, after (43276162667) | 32 | 33 | 37 | 39 |
| D-072 (a) + (b), before | 33 | 32 | 36 | 37 |
| D-072 (a) + (b), after | **164** | **158** | **167** | **169** |
| Bar (99%) | 218 | 218 | 218 | 218 |
| Meets | no | no | no | no |

The same counts read both ways (the bar is unchanged; leaving closed postings out of the denominator is the owner's ruling to make,
not made here):

| After (43276162667) | sample-default | sample-full | held-out-default | held-out-full | held-out 60 |
|---|---|---|---|---|---|
| With closed postings (the bar as set) | 164 / 220, need 218 | 158 / 220, need 218 | 167 / 220, need 218 | 169 / 220, need 218 | ≤ 50 / 60, need 60 |
| Closed postings | 11 | 11 | 12 | 12 | 4 |
| Without closed postings (not the bar) | 164 / 209, need 207 | 158 / 209, need 207 | 167 / 208, need 206 | 169 / 208, need 206 | ≤ 50 / 56, need 56 |

Neither reading meets 99%.

Before, no hand-off existed, so no wall counted as (b): (a) only (36 and 37 on held-out include 3 Workable postings filled to Submit
with the resume upload answered inside the browser, `reached_submit_upload_simulated`). After: (a) 32/33/40/42, (b) 132/125/127/127.
Raw moves of ±1 to 5 between runs are live boards changing (postings closing, forms changing) as well as the fixes (Recruitee
pacing: held-out 3 to 6 passes).

Held-out 60 (`batch60`, the VM's Greenhouse and Lever rows): before 18 reached Submit, 34 needs_answers; after (43276162667)
18 reached Submit + 32 needs_answers = **at most 50/60** (bar 60/60; the batch log prints the questions, not the
hand-off the VM now records with each, so the 32 are (b) only where every question is the person's); 4 posting closed, 1 redirect off the board,
1 no form, 4 field not filled (step did not advance, Phone Number, Current location, Attach).

## Root causes, every posting, before (run 43192269304)

Columns: sample-default, sample-full, held-out-default, held-out-full. `*_no_handoff` is a kept wall with no hand-off (none
existed): it becomes (b) once the hand-off is produced, if everything else was filled.

| outcome | cause | s-def | s-full | h-def | h-full |
|---|---|---|---|---|---|
| a | reached_submit | 33 | 32 | 33 | 34 |
| a | reached_submit_upload_simulated | 0 | 0 | 3 | 3 |
| fail | bot_check_no_handoff | 33 | 33 | 37 | 37 |
| fail | field_fill_error | 2 | 2 | 0 | 1 |
| fail | form_not_found:apply_control_not_opened | 3 | 3 | 1 | 1 |
| fail | form_not_found:embedded_frame | 2 | 2 | 0 | 0 |
| fail | form_not_found:employee_sign_in_only | 4 | 4 | 5 | 5 |
| fail | form_not_found:no_submit_control | 10 | 10 | 11 | 10 |
| fail | form_not_found:page_not_rendered | 1 | 2 | 1 | 1 |
| fail | form_not_found:workday_apply_not_opened | 18 | 18 | 20 | 20 |
| fail | form_rejects_value | 2 | 2 | 0 | 0 |
| fail | host_unreachable | 3 | 3 | 0 | 0 |
| fail | label_on_form_twice | 0 | 0 | 1 | 1 |
| fail | option_covered | 0 | 5 | 0 | 2 |
| fail | person_answer_no_handoff | 76 | 74 | 77 | 72 |
| fail | place_not_offered | 1 | 0 | 2 | 3 |
| fail | posting_closed:board_says_not_found | 4 | 4 | 1 | 1 |
| fail | posting_closed:page_load_404 | 2 | 2 | 5 | 7 |
| fail | posting_closed:page_load_410 | 2 | 2 | 0 | 0 |
| fail | posting_closed:redirected_to_job_list | 2 | 2 | 0 | 0 |
| fail | rate_limited_429 | 4 | 2 | 10 | 8 |
| fail | redirect_off_board | 2 | 2 | 2 | 2 |
| fail | retries_exhausted:page.goto | 0 | 0 | 0 | 1 |
| fail | robots_disallowed | 2 | 2 | 0 | 0 |
| fail | upload_not_accepted | 14 | 14 | 11 | 11 |

By provider (all four samples, 880 postings): Workday 76 form not found (Apply and Apply Manually lead to different addresses, so
no control was opened) + 4 robots; BambooHR 76 stopped on load at the reCAPTCHA checkbox drawn inside the form + 4 closed;
SmartRecruiters 64 DataDome / Cloudflare challenge over the whole page + 16 no form (the page's Apply control not opened);
Teamtailor 32 resume upload refused (the dry run blocks `POST /uploads/presigned_data`), 18 "login_required" that was the
employer's staff sign-in form (`Already working at X?`), not the person's wall, 18 form not found, 4 phone format, 4 closed (410);
Recruitee 22 rate limited (429: every subdomain is one provider; the bench paced per subdomain, six at once), 11 no Submit control,
6 unreachable from CI, 6 closed; Greenhouse 10 upload not accepted (`Attach`, the simulated upload not shown), 6 closed
(`?error=true`), 4 the form embedded in the employer's own page (`job_app` frame), 4 redirected off the board, 3 fill timeouts;
Workable 7 option covered by an overlay, 4 closed (`?not_found=true`), 4 redirect; Lever 8 closed (404), 6 location lookup offered
nothing; Breezy 8 resume required at a step (upload blocked by the dry run), 2 phone label twice, 4 form not reached; Personio 2
closed, 2 Apply not opened. Every other stop: answers only the person can give (325 rows over the four samples).

## What this PR fixed (engine, $0, each on a recorded local page in `tests/career-browser-d072.test.cjs`)

1. **The hand-off (WO-L)**, `workers/career-browser/handoff.cjs`: at a kept wall the runner returns `handoff` (the reason, the
   one step in words, one https link to the employer's page the stop happened on, or the ask-once card for answers; what was
   filled; what remains; nothing sent). Never for an engine failure. The apply VM records it, re-checks a row the person finished
   (`handoff_done_at`) without pressing Submit (`needs_user` / `ready_for_yes` with the exact answers the page holds as a card and
   its hash), and presses Submit only on a yes to that card's hash while the page still holds exactly it. Tested end to end through
   the real VM worker (`createWorker`) and runner: wall, link, done, re-check (no submitting phase recorded, 0 POSTs), a yes to
   another card refused (0 POSTs), the yes to the card: exactly one POST.
2. **A check inside the form** (BambooHR): everything else filled and read back, then the stop at the check, untouched
   (`CHECK_IN_FORM`, wall `check_in_form`). A check over the whole page still stops at the door. 70 rows now (b).
3. **A form's Submit drawn outside its one form** (BambooHR): that control is the form's Submit.
4. **Workday**: opened at `<posting>/apply/applyManually`; its account page is a sign-in wall the person finishes. 54 rows now (b).
5. **Closed postings named** `posting_closed` (Greenhouse `?error=true`, Workable `?not_found=true`, a posting link sent back to the
   job list), instead of "no application form found".
6. **Employer-embedded Greenhouse** (`job_app` frame on bitwarden.com, lucidmotors.com): opened at the frame's own address.
7. **Teamtailor's staff sign-in form** still stops as a sign-in wall exactly as the pinned tests require (needs_user /
   login_required, wall employee_sign_in, nothing typed, never a pass), but it is not the person's account: it gets no hand-off,
   and the 99% reading names it `form_not_found:employee_sign_in_only`.
8. **Bench pacing per provider** (Recruitee 429s: 10 held-out before, 0 after), robots reads paced; a posting's www twin allowed.

## Root causes, every posting, after (run 43276162667)

| outcome | cause | s-def | s-full | h-def | h-full |
|---|---|---|---|---|---|
| a | reached_submit | 32 | 33 | 37 | 39 |
| a | reached_submit_upload_simulated | 0 | 0 | 3 | 3 |
| b | bot_check_handed_off | 15 | 15 | 16 | 16 |
| b | bot_check_in_form_handed_off | 17 | 17 | 18 | 18 |
| b | login_required_handed_off | 13 | 13 | 13 | 15 |
| b | person_answer_handed_off | 87 | 80 | 80 | 78 |
| fail | field_fill_error | 1 | 3 | 1 | 1 |
| fail | form_not_found:apply_control_not_opened | 3 | 3 | 3 | 3 |
| fail | form_not_found:employee_sign_in_only | 4 | 4 | 4 | 4 |
| fail | form_not_found:no_submit_control | 7 | 7 | 9 | 9 |
| fail | form_not_found:page_not_rendered | 1 | 1 | 0 | 0 |
| fail | form_not_found:workday_apply_not_opened | 5 | 5 | 7 | 5 |
| fail | form_rejects_value | 2 | 2 | 0 | 0 |
| fail | host_unreachable | 3 | 3 | 0 | 0 |
| fail | label_on_form_twice | 0 | 0 | 2 | 2 |
| fail | option_covered | 0 | 5 | 0 | 2 |
| fail | person_answer_no_handoff | 1 | 1 | 0 | 0 |
| fail | place_not_offered | 1 | 0 | 1 | 0 |
| fail | posting_closed:board_says_not_found | 4 | 4 | 2 | 2 |
| fail | posting_closed:page_load_404 | 2 | 2 | 7 | 7 |
| fail | posting_closed:page_load_410 | 2 | 2 | 1 | 1 |
| fail | posting_closed:redirected_to_job_list | 3 | 3 | 2 | 2 |
| fail | redirect_off_board | 1 | 1 | 3 | 2 |
| fail | robots_disallowed | 2 | 2 | 0 | 0 |
| fail | upload_not_accepted | 14 | 14 | 11 | 11 |

Remaining failures per sample (sample-default / sample-full / held-out-default / held-out-full): **posting closed 11 / 11 / 12 / 12**;
resume upload refused by the dry run 14 / 14 / 11 / 11 (Teamtailor 32 over four samples, Greenhouse `Attach` 10, Breezy 8);
form not found 20 / 20 / 23 / 21 (Workday 22 where Apply Manually still draws neither form nor sign-in in 12 s, Teamtailor 34
(18 where the Apply control is in Norwegian / Swedish / Danish words the runner does not know, e.g. "Søk på denne stillingen",
16 pages whose only form is the staff sign-in), SmartRecruiters 18 whose "I'm interested" control is not opened, Recruitee 4, Breezy 4, Personio 2);
field mapping 4 / 10 / 4 / 5 (Workable options under an overlay, Greenhouse fill timeouts, phone format, Lever location lookup);
unreachable, robots or off the board 6 / 6 / 3 / 2; a person-only EEO choice routed as a fill failure 1 / 1 / 0 / 0.

## Why 99% is not reachable on these samples, literally

- **Closed postings: 11 to 12 of 220 per sample (5%)** and 4 of 60 in the held-out 60. A closed posting can be neither (a) nor
  (b); the samples were drawn 2026-11-09 and the boards have closed them since. With them in the denominator the ceiling is
  208 to 209 of 220 (94.5% to 95.0%) and 56 of 60, below 218 and 60 whatever the runner does. Read honestly, the bar needs a
  sample of postings open on the day of the run (a re-drawn sample is the owner's or architect's call; it is not done here).
- **Uploads in a dry run**: the bench blocks every POST, so a board that uploads the resume before Submit (Teamtailor's
  `presigned_data`, Breezy, some Greenhouse forms) cannot show the file. Production sends the upload; the bench can simulate it only
  for an exact host and path whose answer it knows (Greenhouse S3, Workable S3). Teamtailor's presigned answer is not known from the
  logs, so 32 rows stay failures rather than being guessed.
- **What the rules keep** is now (b), not a failure: 325 answers only the person can give, 70 in-form checks, 62 whole-page checks,
  54 Workday sign-ins over the four samples. Nothing at those walls is solved, bypassed or signed into.
- **Live hand-off wiring still owed**: setting `handoff_done_at` / `handoff_yes` on a row when the person says done or yes is a
  database and chat change (a migration the owner applies), and finishing a cloud run's wall needs a browser the person can use
  that Trainee then re-checks: the person's own browser through the extension (Greenhouse, Lever, Ashby, Workday) or a kept-alive
  live window (the guided-connect Browserbase session: the owner's credentials and spend).

## Next engine fixes the after-run names (not in this PR, not measured)

Teamtailor's Apply words in Nordic languages (up to 34 rows); SmartRecruiters' "I'm interested" (18); Workday pages that draw nothing in
12 s (22); the Teamtailor upload simulation once its answer is recorded (32); Workable's covered options (7); an EEO choice with no
decline option routed to the person (2).
