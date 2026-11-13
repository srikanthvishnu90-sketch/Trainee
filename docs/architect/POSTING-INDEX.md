# Posting index: every open role, verified live (architect, 2026-10-28)

Goal: search and mass-apply read OUR table, never a live scrape per user. Each open role carries title, company, place/remote,
pay, level (internship), requirements, deadline, apply URL, ATS type, posted/updated time, and a `last_verified_at`.

## What exists (measured, not planned)
- `board-directory.json`: 27,751 live boards across 11 ATS (greenhouse 4,622; lever 1,543; ashby 3,433; smartrecruiters 300; workable, recruitee, bamboohr, teamtailor, breezy, personio, workday). Directory-claimed `postings_seen` = 850,055, so 150K is a floor, not the target. 254 Workday tenants are discovered but unsupported.
- `career_ingest.ts` readers (public JSON/XML, keyless), ETag/Last-Modified/body-SHA skip, complete-read-only closing, URL-shape guard, 64-bucket lanes (`career_ingest_lanes.mjs`), `career_board_state`, `career_ingest_runs`. `posting_key/pay/place/region` normalize apply URL, pay, place, region.
- Gaps this PR fills: deadline, ats_type, level, requirements, last_verified_at, closed_reason, per-posting liveness, filtered-search indexes.

## Architecture
1. **Discovery** (exists: `board_discovery.ts`, Common Crawl, sitemaps, robots-first, 429 backoff): seed lists + ATS slug guessing; a board enters only on HTTP 200 with the provider's shape. Owner company lists add supply.
2. **Structured APIs first**: Greenhouse boards-api, Lever postings, Ashby, SmartRecruiters (paged), Workable widget, Recruitee, BambooHR list, Teamtailor RSS, Breezy JSON, Personio XML, Workday `/wday/cxs/.../jobs` (read-only POST). No page scraping for any of these.
3. **Headless fleet only for no-API pages** (iCIMS, Taleo, SuccessFactors, custom career sites): a small Playwright pool, one page type per recipe, run as the same `FetchFeed` interface so diffing and closing are shared. Not built; build only for employers the owner names (see "Owner provides"). Never LinkedIn, Indeed or Handshake; no captcha solving (a captcha marks the source `needs_user`).
4. **Conditional diffing**: send ETag/If-Modified-Since; fall back to body SHA-256; a 304 or same body stamps every open posting of the board `last_verified_at` with no parse or write. Per-posting `content_sig` decides rewrite vs stamp only.
5. **Liveness**: (a) every complete board read verifies all its postings for free; (b) postings on partial boards (Workday/SmartRecruiters past the page cap) or stale beyond cadence go through `verifyQueue` + `verifyPosting`: Greenhouse and Lever by id (404 = closed), others by apply URL (404/410, `error=true` redirect, "no longer available" text = closed). 403/429/5xx/ambiguous = `unknown`, closes nothing. (c) Mass-apply re-verifies the exact posting just before claim. Closed rows keep `closed_at` + `closed_reason`; a returning posting reopens with its original `first_seen_at`.
6. **Cadence**: hot boards (changed in last 24 h) hourly, others every 6 h, dead boards (3 failures) daily; verify queue cadence 24 h, pre-apply on demand.
7. **Dedupe**: key = `provider:board:ats_id` (`job_id`); cross-source duplicate = same canonical apply URL via `posting_key.postingKey`; the same role posted in several places stays one row per ATS id (apply uses the ATS id).
8. **Deadline**: ATS APIs give none; `extractDeadline` reads stated dates only ("apply by", "closes", ISO, US, D Month Y; year-less = next occurrence); null otherwise, never guessed. `requirements` = the posting's own section, capped 1,500 chars.
9. **Rate limits / ToS posture**: named User-Agent with contact, robots.txt read first per host, per-host pacer with doubling backoff and Retry-After, default 2 req/s per host (Workday and the per-tenant hosts are separate hosts), no login, no auth bypass. These are the ATS vendors' public job-board endpoints that power employers' own career pages; only Greenhouse, Lever, Ashby (posting API), SmartRecruiters and Recruitee document public use. Workable, BambooHR, Breezy and Workday are undocumented: owner accepts that risk or we ask the employer.
10. **Storage**: `career_postings` (+ migration `20261028090000_career_posting_index.sql`, not applied). Partial indexes on OPEN rows: (level, posted desc), (remote, posted desc), (role_family, posted desc), lower(company), deadline, verify queue; existing GIN `search` for text. Move `description` to a side table or rely on TOAST compression at >500K rows.

## Capacity math
| Quantity | Value | Source |
|---|---|---|
| Requests per full pass of 27,751 boards | 37,273 (Workday/SR paged) | `size-ingest.ts` rule on directory |
| Hourly full pass | 10.4 req/s global; greenhouse host 1.3 req/s | 4,622 / 3,600 |
| Daily refetch, hourly cadence worst case | 895K requests/day; ~70% answer 304/same body | 24 x 37,273 |
| Daily verify of all postings individually | avoided: 150K = 1.7 req/s only for the stale remainder | design |
| CPU per board unchanged / changed | 1.0 ms / 32.7 ms; 1.95 ms per posting | `ingest-lane-plan.json` (sandbox, 2 cores) |
| Index CPU, 150K synthetic | first read 35.5 s = 4.2K postings/s; steady pass (70% 304, 5% churn) 2.5 s | `bench-posting-index.ts` |
| Storage at 150K / 1.09M rows | 549 MB / 3.9 GB raw JSON (about 3x less compressed) | bench, 3.3 KB mean description |
| Bandwidth, uncached pass of 850K postings | about 5 GB at 6 KB; about 1.5 GB/h with 70% skipped | assumption (WO-017 6 KB) |
The sandbox has no route to ATS hosts: network latency, real 304 rates and Edge CPU are unmeasured; the owner's first live lane run produces them (`measure-ingest-lane.ts`).

## Owner provides
Named company lists (esp. no-API employers), decision on undocumented endpoints, a worker host for the headless fleet (about $20-60/mo per small VM) and proxy/egress budget if any host blocks the cloud IP range, and the go-live of the migration.
