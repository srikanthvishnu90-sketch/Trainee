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
| 10 Research | [`research/`](research/) | 20 real companies; the product's free search and reader run once on the live web, recorded | **16/20** (sources 20/20, cited 20/20, planted lines kept 0, unread named 20/20, right company 18/20, brief made 18/20) | ≥ 19/20 | **No** | ≈ $0.14 a case, ≈ $2.80 for 20 (`--live --budget-usd 3.5`) |
| 5 Finding people | [`people/`](people/) | 20 real school × employer asks (fictional asker); search answers scripted with fictional people | **20/20** (40/40 right leads kept, 120/120 bad proposals dropped, caveat 20/20, nobody contacted 20/20) | ≥ 19/20 | **Yes, for the guard only** | ≈ $0.08 an ask, ≈ $1.65 for 20 (`--live --budget-usd 2.5`) |
| 13 Offer math | [`offers/`](offers/) | 27 real published pay figures from 19 postings, 14 employers (including PayPal's pay by place) → 27 comparisons | **10/27** (read 25/27, yearly 27/27, compare 10/27, sourced 27/27; the comparisons it made are exact, 10/10) | ≥ 26/27 | **No** | none |
| 12 Tracking | [`tracking/`](tracking/) | runner only: waits for the owner's Gmail after the deploy | not run (no real mail); runner self-test on the synthetic set: 323/323 precision, 323/325 recall | precision and recall ≥ 95%, N ≥ 20 | waits | none ($0; needs the owner's consent and their own read-only token) |

Inputs shared by 3 and 13: [`postings/`](postings/) (capture script, the 35 recorded bodies, `sources.json` with request, time and
sha256 for each). Every runner checks those hashes before it reads.

## What this environment could reach (2026-11-12)

Reachable: the public APIs of Greenhouse, Lever, Ashby and SmartRecruiters, and PayPal's Workday. Refused by the proxy: levels.fyi,
every search engine, Wikipedia and Wikidata, SEC EDGAR, BLS, GDELT, USAJOBS, company websites. There is no DNS (Deno.resolveDns
answers NotFound for every name). So there are no levels.fyi figures in item 13, and in item 10 the briefs stand on job-board pages
only. Production reaches more sources, so item 10's live run is the one that settles that bar.

## Product findings (for the product builders; no product code was changed here)

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
