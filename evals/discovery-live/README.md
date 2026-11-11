# Discovery on live job boards (VERIFICATION-15 item 8, B)

Release item 8, job discovery, has this bar: current openings verified on the employer page, matched to the person, an honest count, and a scope given when the result is empty.

This harness tests that bar against **live public job boards**. Everything it does is read-only and costs $0: no model is called, and nothing is applied for, queued or sent.

## What runs

1. **Index.** The product's own ingest (`ingestBoards` + `boardFetchFeed` in `supabase/functions/_shared/career_ingest.ts`) reads the 61 public boards in `boards.json` once each, 4 at a time. They are 34 Greenhouse, 10 Lever, 9 Ashby and 8 SmartRecruiters boards. The postings are loaded into a throwaway Postgres 16 that has every migration (`tests/flow/pg.ts`).
2. **Search.** The 22 searches in `run.ts` go through the real handler, `handleChat` in agent-chat, via `tests/flow/handler.ts`. It runs with the shipped flags and the staged brain, and a scripted model sits on the Anthropic wire. 4 of the 22 are expected to come back empty. The product's open check reads each posting it shows on that posting's own page, over the real network. Any outbound host other than the board hosts is refused and counted.
3. **Re-check.** After each reply, the harness fetches every shown link again by id, on its own. So "open now" is the harness's read, not the product's claim. For Ashby, the page must carry `"posting":{"id":"<id>"}`; a removed posting answers 404 or carries `"posting":null`.

The bar is a sum that must be 0: `invented + dead_now + unmarked_unchecked + count_dishonest + empty_no_scope == 0`. On top of that, each search may make at most 10 posting reads and no board listing read, and nothing may be queued or sent. `off_scope` (title, level or place outside the ask, judged by the keyword rules in `SEARCHES`) and `unknown_now` are reported, but they do not fail the bar.

## Run

```
deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/discovery-live/run.ts [--out <dir>] [--ingest-only]
```

It needs Postgres 16 binaries; as root, it runs them through `runuser`, like the flow tests do. Each run writes `runs/<timestamp>/results.json` and `transcripts.md`.

## Result: run 2026-11-11T06-24-22-359Z, base 4645fa196, PASS

### Index

| | Count |
|---|---|
| Boards read | 61 (60 ok, 1 failed: `lever:veeva` timed out after 15 s) |
| Open postings | 14,473 |
| By provider | Greenhouse 7,287 / SmartRecruiters 3,899 / Ashby 1,761 / Lever 1,526 |
| Time | 28.2 s |

### Searches

| Measure | Value |
|---|---|
| Searches | 22 |
| Postings shown | 71 |
| Marked "Checked: open" | 71 |
| Open now on independent re-check | 71 |
| Dead now | 0 |
| Unknown now | 0 |
| Invented | 0 |
| Unmarked unchecked | 0 |
| Count dishonest | 0 |
| Empty results | 4 (4 expected, all 4 empty) |
| Empty without scope | 0 |
| Off scope (reported) | 2 |
| Posting-page reads | 71 (most in one search: 8) |
| Listing reads during search | 0 |
| Outbound refused | 0 |
| Effects (apply jobs / wanted / send queue), before and after | 0/0/0 both |

What the replies did:

- **Searches that found fewer than asked** said so. Data analyst internships in Chicago found 1 of 3, and business analyst internships in Chicago found 1 of 2. Both replies said "I did not find N within the scope checked", and both gave how many postings were left out and why.
- **Every empty reply gave its scope and a widening.** For example: "I checked marine biologist in Boise, on the live board (last refreshed …) and the saved snapshot of job boards: none was found … The most useful widening is remote roles in the US".
- **The 2 off-scope rows** were both in "product manager, remote US": Stripe's "Engineering Manager, Billing Products" and "Engineering Manager, Mobile Development Productivity". Both are open and remote US, but they are engineering-manager titles, not product-manager roles. This is a matching-precision finding, not a bar failure.

### Notes

- The throwaway cluster's `server_encoding` is `SQL_ASCII`, so `char_length` there counts bytes. The harness therefore cuts each field to its column limit in UTF-8 bytes. Without that, a posting whose pay text has en dashes fails a check that the live UTF8 database passes.
- A board's posting API (Greenhouse, Lever, SmartRecruiters) returns 404 for an unknown id. An Ashby posting page that was removed answers 404 live.
