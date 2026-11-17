# Browser coverage: what the runners can do, per provider (WO-M, 2026-11-09)

Read from the code at trunk `8a2d67c9` and its fixture tests. Nothing here was measured on a real employer site yet; the
real-site numbers come from the dry-run eval below (`scripts/browser-eval/`), and go in the table at the end once run.

## The three ways an application is driven today

| Runner | Code | Who drives the page | Providers it will open |
|---|---|---|---|
| **Apply VM** (headless pool, `career_apply_vm_claim`) | `workers/career-browser/apply-vm.cjs` → `parallel-apply.cjs` → `ats-fill.cjs` | Trainee, headless Chromium | Greenhouse (`boards.` / `job-boards.greenhouse.io` only) and Lever (`jobs.lever.co`). `atsOf` (apply-vm.cjs:40-48) and the SQL `career_apply_vm_claimable` both refuse every other host as `site_not_supported` before a page opens. |
| **Cloud runner** (one sandbox per application) | `workers/career-cloud/worker.ts` → `scripts/apply.ts --submit --approved` | Trainee, headless Chromium | Greenhouse, Lever, Ashby, SmartRecruiters (`packages/domain/149-career-portal-apply.js` `ATS_HOSTS`, any subdomain of `greenhouse.io`, `lever.co`, `ashbyhq.com`, `smartrecruiters.com`). Every other host: `UNTESTED_ATS_HOST`. |
| **Extension** (the person's own browser) | `extension/` | The person; Trainee fills | Content script on Greenhouse, Lever, Ashby and Workday (`*.myworkdayjobs.com`, `*.myworkdaysite.com`, `*.myworkday.com`). |

## Per provider, per step

Legend: **yes** = code path and a fixture test; **code** = code path, no fixture of that provider; **no** = refused or no path.
"Fill" = contact facts typed and read back; "Custom" = the page's own questions answered from approved answers.

| Provider | Boards in production | Open postings | VM: open / fill / resume / custom / submit / confirm | Cloud runner: open / fill / resume / custom / submit / confirm | Extension |
|---|---|---|---|---|---|
| greenhouse | 4,622 | 140,965 | yes / yes / yes / yes / yes / fixture-only regex | yes / yes / yes / yes / yes / page text (`SUCCESS`, `ID`) | yes |
| lever | 1,543 | 55,498 | yes / yes / yes / yes / yes / fixture-only regex | yes / yes / yes / yes / yes / page text | yes |
| ashby | 3,433 | 58,646 | no (`site_not_supported`) | yes / yes / yes / yes / yes / page text | yes |
| smartrecruiters | 300 | 130,530 | no | yes / yes (open shadow roots, R9) / yes / yes / yes / page text | no |
| workday | 1,232 | 296,300 | no | no (`UNTESTED_ATS_HOST`) | fill only, person signs in and submits |
| breezy | 4,593 | 43,617 | no | no | no |
| personio | 4,229 | 33,786 | no | no | no |
| bamboohr | 3,447 | 16,899 | no | no | no |
| workable | 1,923 | 10,629 | no | no | no |
| recruitee | 1,688 | 22,022 | no | no | no |
| teamtailor | 741 | 8,788 | no | no | no |
| icims, taleo | not ingested | 0 | no | no | no |

Board counts are the owner's figures; open postings are `count(*) where closed_at is null` on `career_postings`,
read 2026-11-09. **Workday is the largest pool of open postings (296k, 36% of the 818k open) and no runner can submit to
it;** SmartRecruiters is second (130k) and only the cloud runner drives it. The VM covers at most 196k open postings (24%; fewer, since a Greenhouse posting on the employer's own domain is refused), the
cloud runner 386k (47%).

Fixture tests: `tests/fixtures/forms-ci` holds 6 captured forms each of Greenhouse, Lever, Ashby and SmartRecruiters
(`tests/career-forms-ci-coverage.test.cjs`, the Ashby verdict pack); the VM's own suites (`career-parallel-apply`,
`career-apply-vm`) run against the mock Greenhouse and Lever forms in `tests/fixtures/mock-ats-server.cjs`. No fixture
exists for the seven other providers.

## Known defects in the runners (the review of 2026-11-09, checked in code)

1. **The VM refuses Workday, iCIMS and Taleo before any page opens** (`atsOf`, apply-vm.cjs:40-48): `site_not_supported`,
   no hand-off. Fix d routes them to the sign-in hand-off (WO-L).
2. **A missing answer is recorded `needs_user`, not `not_submitted` / `needs_answers`** (apply-vm.cjs:184-186), so the
   database trigger `career_apply_reprepare_on_needs_answers` (20261101130000), which fires only on
   `not_submitted` + `needs_answers`, never re-prepares it. The cloud runner already writes `needs_answers`
   (`scripts/apply.ts` line 977).
3. **An emailed security code after Submit ends `unknown_outcome`** on the VM (parallel-apply.cjs:161, "no confirmation
   text"): the page asks for the code, the application is not in, and the posting stays blocked as "maybe applied". The
   cloud runner already reads this case (`email_code_prompt` → `needs_user` / `email_code`, `outcomeAfterSend`).
4. **VM confirmation is fixture-shaped:** `CONFIRM_RE` plus `/\b(?:GH|LV)-[A-Z0-9-]+/` (parallel-apply.cjs:58, 162): the id
   pattern only matches the mock forms' ids (`tests/fixtures/mock-ats-server.cjs`). What real pages show after a submit
   is not in the repo; fix b takes it from real page signals (URL change, heading, the employer's email), not from memory.
5. **The VM's captcha test reads the whole page source** (`BOT_RE.test(page.content())`): any page that only *loads* an
   invisible reCAPTCHA script contains the word "captcha" and stops as `needs_user` / `bot_check` before filling. The eval
   counts this as "runner BOT_RE stops" next to "captcha shown", so the gap is measured, not assumed.
   **Update 2026-11-09:** #658 made the runner judge only a shown check (SHOWN_CHECK). The 220-posting benchmark (run
   42676274898) still showed every Lever posting stopping, because Lever's hCaptcha container runs invisibly at the click and
   carries no data-size. SHOWN_CHECK now skips a container the page runs invisibly (a hidden *-captcha-response field with a
   hidden submit button, or the reCAPTCHA badge), and the eval and the dry-run worker measure with the runner's own botCheck.

## The dry-run eval (`scripts/browser-eval/`)

The sample is committed: `scripts/browser-eval/sample.csv`, 20 open postings per provider for all 11 providers (public
posting URLs and the provider only), read-only from `career_postings` on 2026-11-09 with:

```
select provider, url from (
  select provider, url, row_number() over (partition by provider order by md5(job_id || 'wo-m-2026-11-09')) rn
  from (select * from public.career_postings tablesample system (2) repeatable (20261109)
        where closed_at is null and url is not null) s) r
where rn <= 20 order by provider, rn;
```

Run it from GitHub Actions (the build sandboxes cannot reach the boards): Actions > **browser-eval** > Run workflow, with a
label. It runs only by hand, never on a push or a PR, needs no secrets, and uploads `summary.json`, `summary.md` and
`results.jsonl` for 14 days. Locally, on a machine that reaches the boards:
`node scripts/browser-eval/run.cjs --sample scripts/browser-eval/sample.csv --label <label>` (output in
`artifacts/browser-eval/<label>/`, gitignored).

Per posting it records: page opened, form found (and how: on the page, in an embedded frame, at the provider's apply
URL, or behind the page's Apply link), every question mapped to the approved-answer schema (`fact:<key>`, `resume`,
`cover_letter`, `eeo`, `agreement`, `custom`), what the TEST person's facts and the synthetic resume filled and read back,
the required questions only the person could answer, walls (sign-in, password, SSO option, emailed code, captcha shown,
captcha script only, closed posting, robots refusal), what the VM does today (`atsOf`) and whether its `BOT_RE` would
stop it, and the time. `summary.md` is the per-provider table.

What it cannot do, by construction (eval-lib.cjs header; `tests/career-browser-eval.test.cjs` proves each on local pages):
no request other than GET/HEAD/OPTIONS leaves the browser (form posts, uploads, autosaves, beacons are aborted and
counted; WebSockets closed); no submit control is ever clicked, and a page that submits its own form is cancelled in the
page (every submit event, `submit()` and `requestSubmit()`, counted as `submit_attempts`); a visible captcha, a password field or a code field stops
the posting before anything is typed; robots.txt is read first and obeyed; one request a second per host; images, fonts
and media are not fetched; at most 20 postings per provider per run.

## Baseline

Not run yet: the build sessions' network denies every employer host (proxy 403); the first run is the `browser-eval`
workflow. The table goes here with the run's date and label, and each fix PR quotes its before/after line.

## The strict benchmark (`scripts/browser-eval/strict.cjs`, owner 2026-11-09: "the benchmarks need to be strict")

It grades the production runner (`parallel-apply.cjs` `applyOne`), not the eval's own fill path. A posting passes only when
the runner reaches the instant before its Submit click: allowed host, no shown check or sign-in wall, the form found, every
filled field read back, nothing required left empty, the form posting to an allowed host, and the approval hash still
matching. The denominator is every sampled posting, including closed, unreachable and robots-refused ones. "Ready if
answered" (stopped only for custom questions the person would answer) is reported beside a pass and never counted as one.
Nothing is sent: every request but GET/HEAD/OPTIONS is aborted except a GraphQL read (no `mutation`), a page script cancels
every form submit, the runner is stopped before its click with no retries, robots.txt is obeyed, 1 request a second per host.
A result the runner reports as sent is a breach and fails the job. Production passes neither `requestGate` nor `initScript`.

## D-072 (item 4, 2026-11-12): the 99% reading and the hand-off

The strict benchmark now also prints the owner's 99% reading per posting (`D072 | provider | a|b|fail | cause | url`) and per
sample (`D072-TOTAL`), from `scripts/browser-eval/d072.cjs`; the raw "reached Submit" count (`BOTH`) is unchanged beside it.
(b) counts only a kept wall that carries the runner's hand-off (`workers/career-browser/handoff.cjs`). Runner changes measured
there: a check drawn inside the form (BambooHR) is reached with every other field filled and stops untouched (`CHECK_IN_FORM`);
a form's Submit drawn just outside its one form is that form's Submit; Workday is opened at `<posting>/apply/applyManually` and
its account page is a sign-in wall the person finishes; a closed posting is `posting_closed`; an employer page embedding
Greenhouse's `job_app` frame is opened at the frame's own address; an employee staff sign-in form still stops the run (login_required, nothing typed) but
carries no hand-off and is read as the form not reached. The bench paces per provider (every Recruitee subdomain is one provider). Root causes and counts:
`docs/architect/reports/ITEM4-ROOT-CAUSES-20261112.md`.

## Runner strict pass, 2026-11-16 (branch ag/runner-strict; local runs, nothing sent)

Measured on the owner's machine (it reaches the boards), the committed `sample.csv`, default persona, with
`node scripts/browser-eval/strict.cjs --sample scripts/browser-eval/sample.csv --max-per-provider 20 [--answered]`. Every run:
0 breaches, every non-GET aborted in the browser or answered inside it (simulated uploads), robots obeyed, paced per provider.

**The headline and the answered column.** The headline pass gives the runner no answers to the employer's own questions, so a
posting with one required custom question can never pass; 80 to 95 of 220 stop there ("ready if answered"). That number says
nothing about execution. `--answered` (`scripts/browser-eval/synth-answers.cjs`) drives each posting again with a synthetic TEST
answer to every question the runner handed back as the person's (up to three rounds) and counts the instant before Submit: whether
the runner can put a prepared answer into the page's own control and read it back. Uploads and answers that did not fit are never
answered. The headline is unchanged and never counts it.

**Dry-run guard, proved with its first wall removed.** `tests/career-browser-strict-guard.test.cjs` takes away the stop before the
click and lets the production runner press Submit on local pages (a native submit; a board script that fetches, beacons, opens a
WebSocket and calls `form.submit()`): the local employer receives nothing. Without the bench's gate and page script the same test
receives `POST /submit`. `STRICT_INIT` now also replaces `WebSocket` (a socket is not a request the gate sees).

| run | trunk / head | headline pass | ready if answered | answered: reached Submit (+ upload simulated) |
|---|---|---|---|---|
| base-sample | trunk 9b177617 | 7 | 79 | not measured |
| r1-sample | 88e04167 (Personio fix) | 7 | 95 | 36 (+8) |
| r2-sample | 653b5824 (all fixes) | 6 | 82 | 32 (+10), load average 30 to 57: 22 page loads timed out |
| r3 (Ashby, Personio, Teamtailor re-run at concurrency 3) | 653b5824 | 1 | 32 of 60 | 10 of 60; Personio 16 now stop at its Turnstile, handed off |

Failure classes of the base run (220): custom question unanswered 79; shown or in-form check 36 (SmartRecruiters DataDome 19,
BambooHR 17); form not found 26 (Personio 19: its Submit is disabled until valid, fixed; Workday 4: the guest start is a POST the dry
run blocks); the person's agreement / upload / EEO 22 (Teamtailor consent 16); Workday sign-in hand-off 13; closed 23 (404/410 9,
board says closed 11, sent to job list 3); upload simulated but not taken (Greenhouse Attach) 3; host unreachable 3; other 4.

Execution failures the answered column found and this branch fixed (each with a fixture test that fails on its parent):
Personio's disabled-until-valid Submit and `(erforderlich)` required marks (19); a box and a choice under one label (Ashby's
Phone over the texting consent: 5); a dropdown's floating list (Ashby); a Submit held by an unissued invisible Turnstile is that
check, handed off (Personio); Teamtailor's `candidate[resume_remote_url]` box carrying the stored resume (9); a styled radio /
tick box whose input takes no click at its point (8). Two of these move the answered column less than their count on the live run:
Ashby's iwoca dropdown still reads no options (its list is not a `role=listbox`; the fixture's is), and Teamtailor's next stop
after the resume box is a page-set "Search" / "Sök" value (the job id) and its `range-custom_number` box.

Left, named: Workable's drawn Yes/No radios read back unheld after a full form (11); Greenhouse react-select boxes in other
languages whose options do not open or match (9); Breezy page-set hidden controls with no label (2) and its `salaryCurrency` (3);
the Greenhouse `Attach` upload under simulation (3); BambooHR's repeated Apply control (3).

**Throughput (one runner process, `scripts/browser-eval/throughput.cjs`, mock employer, 8-core 8 GB machine under a load average of
14 to 38 from other sessions, so low):** concurrency 1: 12 to 15 apps/min, p50 4.0 to 4.4 s; 4: 52; 8: 48 to 96; 16: 45 (CPU-bound
under that load). Of a single application's 4.0 s, 2.3 s is the pre-click guard (the 2 s shown-check settle window, round 2); with
it at 0 the same lane does 22.5 apps/min. On real postings a run that reached Submit took p50 23 s (load 9.5 s including the
per-provider pace, fill 1.6 s, guard 2.5 s). The apply VM has no per-person serial cap (the claim widens each person's share when
fewer people are queued) and no host cap unless the owner sets one; the limits are memory (about 450 MB a context) and each
portal's own refusals.

### Round 2 (architect rulings of 2026-11-16), measured in CI (`browser-bench`, branches `bench/browser-strict-r2` / `-r3`, never a PR)

Rulings applied: the apply VM drives Ashby (migration `20261116150000`, not applied live); the dry run stays strict (Personio's
Turnstile is a handed-off wall); open postings only (each row re-checked at the start of its run, closed rows reported apart);
`checkSettleMs` unchanged. CI 44021741347 measured head dd0672e8, CI 44026400136 head 951df0b3 (Teamtailor job_id and slider, Workable
drawn radio, Greenhouse react-select chips, the simulated upload's progress events). "Answered" counts reached Submit, with the
upload simulated in brackets.

| provider | sample: headline, r2 → r3 | sample answered, r2 → r3 | held-out headline, r2 → r3 | held-out answered, r2 → r3 |
|---|---|---|---|---|
| ashby | 1 → 1 | 11 → 12 | 2 → 2 | 13 → 13 |
| breezy | 0 → 0 | 1 (+8) → 1 (+8) | 0 → 0 | 0 (+10) → 0 (+10) |
| greenhouse | 0 → 0 | 0 → 0 (+13) | 1 → 0 | 1 → 0 (+14) |
| lever | 5 → 5 | 19 → 18 | 5 → 5 | 12 → 12 |
| recruitee | 0 → 0 | 2 → 1 | 0 → 0 | 0 → 0 |
| teamtailor | 0 → 0 | 0 → 0 (+3) | 0 → 0 | 0 → 0 (+8) |
| workable | 1 → 1 | 1 → 1 (+7) | 0 → 0 | 0 (+2) → 0 (+7) |
| bamboohr, personio, smartrecruiters, workday | 0 | 0 (bot check / sign-in walls, handed off) | 0 | 0 |
| **all 220** | **7 → 7** | **34 (+8) → 33 (+31)** | **8 → 7** | **26 (+12) → 25 (+39)** |
| open only | 7 / 196 | 34 (+8) → 33 (+31) of 196 | 8 / 191 | 26 (+12) → 25 (+39) of 191 |

Closed: 24 of the sample (9 at the start of the run) and 29 of the held-out (13 at the start). The headline (no custom answers) stays
where it was by construction; the answered column is where execution shows: 42 → 64 of 220 (sample) and 38 → 64 (held-out) reach the
instant before Submit once answered. Left after r3, by count: Recruitee phone reformats with other digits (`value_changed_by_page`,
11 to 16), Workable steps with no Submit word (`no_submit_control`, 3 to 4), Breezy unnamed page flags (fixed after r3, aea3d3a7) and
`salaryCurrency`, Ashby's own dropdown in the live page (still `options_not_readable`).
