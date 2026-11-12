# Item 10, research: 20 real companies

**$0 result on trunk 7bbf6512 (2026-11-12): PASS 16/20 (bar 19/20). BELOW.**

| Check | Count |
|---|---|
| every listed source is a fetched page | 20/20 |
| every kept line is on the page it cites | 20/20 |
| planted lines kept | 0 of 72 (4 in each of the 18 cases with pages; the guard dropped every one) |
| pages the reader could not open are named | 20/20 |
| the job board cited is the company's own | 18/20 |
| a brief was made | 18/20 |

The four failures are product findings 6 and 7 in `../README.md`:
- Ramp and Palantir: another company's job board is cited.
- Notion: its board is over the 2 MB cap.
- Plaid: its board is refused as `not_text`.

## Recorded once (`--capture`)

The product's free provider and free reader (`research_free_sources.ts`, what the chat uses with no key) ran once per case over the
real network on 2026-11-12. They returned 45 pages, all from job-board APIs, and refused 121 pages, each with a reason: robots.txt
unreadable, unreachable, not text.

This environment has no DNS. The reader checks the resolved addresses of every hop, so for the capture only it was given a
stand-in resolver: every name "resolves" to 8.8.8.8, and each recording says so in its `resolver` field. Everything else is the
reader as shipped (https only, the never-list, robots.txt, caps, conversion). The bytes came from the real hosts through the
proxy. `recorded/<id>.json` holds what the search and the reader returned.

## $0 replay (default)

The recordings are replayed into `researchCompany` (agent/research/company.ts). The draft is a scripted model:
- three lines copied word for word from the fetched pages;
- four planted lines a faithful guard must drop: a figure no page has, a page that was never fetched, a date the page does not
  carry, and a competitor the quote does not name.

Code decides what stands, and the checks above are code checks. In this environment the briefs stand on job-board pages only, so
"role-specific" and "dated" are not measured here; they need the live run.

## Live run (`--live`): model spend, not run

The same 20 asks run with Claude's web search added to the free sources (D-060) and the real model drafting. The wiring is the
same as handler-career.ts's `market` with web research on. It is refused without `WEB_RESEARCH_SPEND_APPROVED=<DECISIONS line>`
and `ANTHROPIC_API_KEY`, and capped by `--budget-usd` (at most 5).

Quote, per case:

| Part | Basis | Cost |
|---|---|---|
| Web search call (`WEB_RESEARCH_SEARCHES` = 2) | One search measured $0.04364 (D-060 run 43069018220: 13,720 input + 620 output tokens + $0.01 fee) | ≈ $0.09 |
| Draft call | ≈ 12k input tokens at $2/M, at most 1,800 output tokens at $10/M | ≈ $0.05 |
| **Total** | | **≈ $0.14 a case, ≈ $2.80 for 20** |

Recommended cap: `--budget-usd 3.5`. Through the full chat turn (the brain's own call, ≈ $0.10) it would be ≈ $0.24 a case,
≈ $4.80 for 20.

```
deno run -A --no-check evals/real-sets/research/run.ts                 # $0 replay
deno run -A --no-check evals/real-sets/research/run.ts --capture       # re-record (public GETs, no model)
WEB_RESEARCH_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... deno run -A --no-check evals/real-sets/research/run.ts --live --budget-usd 3.5
```
