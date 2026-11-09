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
