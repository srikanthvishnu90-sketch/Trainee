# Real-input measurement sets (D-068, owner 2026-11-12: "Build real sets now")

VERIFICATION-15 "The 95% bars" (PR #784) lists items 3, 5, 10, 12 and 13 as having only fixture or TEST-profile proof ("real: 0").
These sets give each one real inputs: real public employer pages, real companies, real public asks and real published pay,
with fictional people only. Nothing personal is read or stored. Each runner is offline and $0 unless it says `--live`, and
`--live` is refused without the owner's written approval (a DECISIONS.md line) in the environment. No model was called, nothing
was sent to anyone, and no live run was made for this PR.

The 95% is D-056's reading: at least 95% by exact integer count.

| Item | Set | Real inputs | $0 result | Bar | Meets? | Model-spend part (quoted, not run) |
|---|---|---|---|---|---|---|
| 3 Resumes | [`resumes/`](resumes/) | 35 real public postings (Greenhouse 14, Lever 6, Ashby 6, SmartRecruiters 5, PayPal Workday 4) × the fictional persona Alex Testcase (TEST) | **35/35** postings: 70/70 files open, copy, download, fit the page, carry the target, invent nothing (invented facts 0) | ≥ 34/35, invented 0 | **Yes** | none: the tailor is code |
| 10 Research | [`research/`](research/) | 20 real companies; the product's free search and reader run once on the live web, recorded (re-recorded for D-069) | **20/20** (sources 20/20, cited 20/20, planted lines kept 0, unread named 20/20, right company 20/20, brief made 20/20); was 16/20 before D-069 | ≥ 19/20 | **Yes** | ≈ $0.14 a case, ≈ $2.80 for 20 (`--live --budget-usd 3.5`) |
| 5 Finding people | [`people/`](people/) | 20 real school × employer asks (fictional asker); search answers scripted with fictional people | **20/20** (40/40 right leads kept, 120/120 bad proposals dropped, caveat 20/20, nobody contacted 20/20) | ≥ 19/20 | **Yes, for the guard only** | ≈ $0.08 an ask, ≈ $1.65 for 20 (`--live --budget-usd 2.5`) |
| 13 Offer math | [`offers/`](offers/) | 27 real published pay figures from 19 postings, 14 employers (including PayPal's pay by place) → 27 comparisons | **27/27** (read 27/27, yearly 27/27, compare 27/27, sourced 27/27); was 10/27 before D-069 | ≥ 26/27 | **Yes** | none |
| 12 Tracking | [`tracking/`](tracking/) | runner only: waits for the owner's Gmail after the deploy | not run (no real mail); runner self-test on the synthetic set: 323/323 precision, 323/325 recall | precision and recall ≥ 95%, N ≥ 20 | waits | none ($0; needs the owner's consent and their own read-only token) |

Inputs shared by 3 and 13: [`postings/`](postings/) (capture script, the 35 recorded bodies, `sources.json` with request, time and
sha256 for each). Every runner checks those hashes before it reads.

## Live runs (D-068, 2026-11-12, trunk 44b436f9; item 10 re-run on trunk 44183b35 and on trunk 671ba1b7)

Run through `.github/workflows/real-sets-live.yml` on `ci/real-sets-live` (the request is `run-request.json` there), each cap
reserved at the shared $70 ledger and settled to the metered cost. Results are in each set's `results/live-<CI run>/`.

| Item | CI run | Cap | Spent | Result | Bar |
|---|---|---|---|---|---|
| 10 Research (`research --live`, Claude web search + the free sources, the real model drafting) | 43192205798 | $3.50 | $2.9641 | **11/20**: sources 20/20, cited 20/20, no kept figure off its page 20/20, unread named 20/20, own board 20/20, brief 11/20 (Coinbase, Datadog, Brex, Affirm, Discord, Dropbox, Toast, Palantir, Notion: "no_sources" although 5 to 11 pages each were read) | 19/20, **BELOW** |
| 10 Research, re-run on trunk 44183b35 (D-070: draft parse, 4,000-token draft cap, quote matching) | 43212037007 | $3.50 | $2.9605 | **15/20**: sources 20/20, cited 20/20, no kept figure off its page 20/20, unread named 20/20, own board 20/20, brief 15/20 (Coinbase, Brex, Gusto, Toast, Notion: "no_sources", 5 to 10 pages read each; Datadog, Affirm, Discord, Dropbox and Palantir now brief; Gusto briefed on 43192205798) | 19/20, **BELOW** |
| 10 Research, re-run on trunk 671ba1b7 (D-071: model-worded lines, quote fallback, page sentences when the draft gives none, ResearchAudit) | 43272687366 | $3.00 | $2.9275 | **15/20**: sources 20/20, **cited 18/20** (Stripe, Plaid: a kept line under 60% of its words on its cited pages), no kept figure off its page 20/20, unread named 20/20, own board 20/20, **brief 17/20** (Datadog, Affirm, Toast: `no_sources` with the audit's kept 1 each, the `frame`, which does not count toward a brief; Coinbase, Brex, Gusto, Notion now brief). Per-case audit in `research/results/live-43272687366/results.json` (`research`) | 19/20, **BELOW** |
| 5 Finding people (`people --live`, Claude web search, the real `find_people` tool and guard) | 43193852143 | $2.50 | $1.5872 | **20/20** pass the guard checks (one search with LinkedIn and Indeed blocked, name and employer in the lead's own excerpt, caveat, nobody contacted); a lead was found on 2/20 asks (3 leads, school shown on 2; 36 proposals dropped) | 19/20, **MEETS (the guard)** |


Item 10 on trunk 671ba1b7 (run 43272687366), the ResearchAudit per case (`research`: pages read, draft parse, lines drafted, kept,
kept as the page's own sentence (`from_quote`), from the pages when the draft gave none (`from_pages`), dropped by reason):

| Case | Company | Pass | pages | parse | drafted | kept | from_quote | from_pages | dropped (claim words not in quote / figure not in quote / product angle / tension not stated / other) | Failed check |
|---|---|---|---|---|---|---|---|---|---|---|
| R01 | Stripe | **no** | 10 | whole | 23 | 4 | 0 | 0 | 12 / 1 / 3 / 2 / unknown names or figures 1 | cited |
| R02 | Airbnb | yes | 10 | whole | 25 | 5 | 0 | 0 | 10 / 3 / 3 / 2 / quote not on page 1, no quote 1 |  |
| R03 | Figma | yes | 8 | whole | 23 | 2 | 0 | 0 | 9 / 6 / 3 / 3 / 0 |  |
| R04 | Robinhood | yes | 7 | whole | 19 | 5 | 0 | 0 | 4 / 3 / 3 / 2 / unknown names or figures 2 |  |
| R05 | Coinbase | yes | 10 | whole | 22 | 3 | 0 | 0 | 9 / 5 / 3 / 1 / unknown names or figures 1 |  |
| R06 | Datadog | **no** | 9 | whole | 21 | 1 | 0 | 0 | 13 / 2 / 3 / 2 / 0 | brief |
| R07 | Duolingo | yes | 12 | whole | 17 | 4 | 0 | 0 | 7 / 2 / 2 / 1 / quote not on page 1 |  |
| R08 | Brex | yes | 10 | whole | 21 | 3 | 0 | 0 | 11 / 2 / 3 / 2 / 0 |  |
| R09 | Affirm | **no** | 11 | whole | 22 | 1 | 0 | 0 | 13 / 1 / 3 / 1 / quote not on page 1, unknown names or figures 2 | brief |
| R10 | Gusto | yes | 8 | whole | 24 | 3 | 1 | 0 | 12 / 3 / 3 / 2 / unknown names or figures 1 |  |
| R11 | Discord | yes | 8 | whole | 26 | 3 | 0 | 0 | 13 / 4 / 3 / 2 / unknown names or figures 1 |  |
| R12 | Dropbox | yes | 10 | whole | 23 | 2 | 0 | 0 | 15 / 1 / 3 / 2 / 0 |  |
| R13 | Chime | yes | 6 | whole | 19 | 3 | 0 | 0 | 7 / 5 / 2 / 2 / 0 |  |
| R14 | Toast | **no** | 8 | whole | 25 | 1 | 0 | 0 | 15 / 2 / 3 / 3 / quote not on page 1 | brief |
| R15 | Palantir | yes | 10 | whole | 25 | 4 | 0 | 0 | 14 / 1 / 3 / 3 / 0 |  |
| R16 | Spotify | yes | 7 | whole | 22 | 3 | 0 | 0 | 8 / 6 / 3 / 2 / 0 |  |
| R17 | Ramp | yes | 9 | whole | 18 | 2 | 0 | 0 | 10 / 0 / 3 / 2 / frame unsupported 1 |  |
| R18 | Notion | yes | 6 | whole | 23 | 3 | 0 | 0 | 12 / 3 / 3 / 2 / 0 |  |
| R19 | Plaid | **no** | 5 | whole | 18 | 2 | 0 | 0 | 7 / 2 / 3 / 2 / no quote 1, unknown names or figures 1 | cited |
| R20 | ServiceNow | yes | 7 | failed | 0 | 4 | 0 | 4 | 0 / 0 / 0 / 0 / 0 |  |

Totals: drafted 416, kept 58 (from_quote 1, from_pages 4); the most common drop is `claim_words_not_in_quote` (201). The three cases with no brief each kept only the `frame` (Trainee's labelled reading), which `researchCompany` does not count toward a brief (`any`), and the page-sentence fallback runs only when the draft gave no line (`!audit.drafted`). Stripe and Plaid fail the eval's independent 60%-of-words check on a kept line; the result does not keep page text, so which line cannot be re-checked here (both carry a model-worded `frame`).

The live research score is the replay's six checks on the pages the run's own reader returned, except that a live line is the
model's sentence, so "cited" checks every figure and at least 60% of the content words against the cited pages (the product's
guard keeps a line only when its quote is on its page). People: names are stored as sha256 prefixes only.

## What this environment could reach (2026-11-12)

Reachable: the public APIs of Greenhouse, Lever, Ashby and SmartRecruiters, and PayPal's Workday. Refused by the proxy: levels.fyi,
every search engine, Wikipedia and Wikidata, SEC EDGAR, BLS, GDELT, USAJOBS, company websites. There is no DNS (Deno.resolveDns
answers NotFound for every name). So there are no levels.fyi figures in item 13, and in item 10 the briefs stand on job-board pages
only. Production reaches more sources, so item 10's live run is the one that settles that bar.

## Product findings (fixed by D-069; each has a $0 test in `tests/architect/d069-real-input-fixes-20261112.test.ts`)

As found on trunk 7bbf6512. D-069 fixed all seven; item 3's `loop_rule` report went from 23/35 to 35/35.

1. **`CareerProfile.skillEvidence` matches skills by substring** (router_core.career.js). For the persona it calls "R" proven by
   every fact (each one has the letter r) and "SQL" proven by "PostgreSQL". The tailor does not print either, which is correct.
   But anything that trusts skillEvidence for a fit or gap claim would say the person knows R. Item 3 reports this as
   `loop_rule` 23/35.
2. **A non-USD offer is restated in dollars.** "Coinbase offered me AUD 87,600" gets the reply "Got it: Coinbase, analyst,
   $87,600", and PLN 272,000 becomes "$272,000" (career_offer.ts parseOfferWords, then the ask line). The person never said that
   currency.
3. **Offers outside 15 metros or a known title are never compared.** The offer turn asks for "the city" or "the job title" until
   the answer is one of its 15 metros and a role it knows. Real places (San Diego, Scottsdale, Lake Mary FL, Sydney, Warsaw) and
   real titles ("advanced analytics intern", "cybersecurity intern") are never accepted, so the offer is not kept and "compare my
   offers" answers that only one offer is on file. This is 17 of the 27 comparisons. Arithmetic is not the problem: every
   comparison the product made was exact.
4. **A stored pay figure drops ranges past 200 characters** (career_ingest.ts `PAY_MAX`). Robinhood's Zone 3 (Florida,
   $130,000–$152,000) is not stored.
5. **Workday pay by place misses the "City, State: (range)" form** (workday_posting.ts paysByPlace only reads "City, State |
   (range)"). PayPal R0137491's Scottsdale range ($100,500–$149,600) is not read; only San Jose's is.
6. **Research cites another company's job board.** The free provider tries Greenhouse, then Lever, then Ashby, then
   SmartRecruiters, and takes the first board that answers:
   - For Ramp it takes Greenhouse "ramp" (a different "RAMP" with 1 role) instead of Ramp's Ashby board (176 roles).
   - For Palantir it takes SmartRecruiters "palantir" (C# roles in Aberdeen; another company). The real Lever board is 5.9 MB,
     over the 2 MB probe cap (`JSON_MAX_BYTES`).
7. **Large Ashby boards are not read.** Notion's board (2.9 MB) is over the 2 MB probe cap, so "no public job board was found".
   Plaid's board (1.96 MB) passes the probe, but the reader refuses it as `not_text`.

## Run all

```
CI=true deno run -A --no-check evals/real-sets/resumes/run.ts      # poppler, pdfminer.six, python-docx
deno run -A --no-check evals/real-sets/offers/run.ts
deno run -A --no-check evals/real-sets/research/run.ts
deno run -A --no-check evals/real-sets/people/run.ts
deno run -A --no-check evals/real-sets/tracking/run.ts --self-test
```
Each prints one summary line and writes `results/latest.json` in its folder. It exits 1 when the set is below its bar.
