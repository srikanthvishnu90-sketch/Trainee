# Item 5, finding people: 20 real school × employer asks

**$0 result on trunk 7bbf6512 (2026-11-12): PASS 20/20 (bar 19/20), for the lead guard only.**

| Check | Count |
|---|---|
| right leads kept | 40/40 (with the school match sorted first) |
| bad proposals dropped | 120/120 |
| one search, LinkedIn and Indeed blocked | 20/20 |
| every kept name and employer in its own excerpt | 20/20 |
| caveat on every lead | 20/20 |
| nobody contacted (and the reply guard adds it) | 20/20 |

## Why the search answers are scripted

`queries.json` holds 20 real asks: a real school, real employers, and the fictional asker Alex Testcase (TEST). The search answers
are scripted, for three reasons:
- a real people search is model spend (Claude's web search);
- this environment reaches no search engine;
- a recorded real answer would put real people's names in the repository.

Each scripted answer has the exact shape `webSearch` returns. It carries fictional people on reserved `example.*` hosts, and eight
proposals per ask:
- 2 a faithful guard keeps;
- 6 it must drop: a name not in the passage, an employer not in the passage, a LinkedIn page, a URL the search never returned, an
  email address as a name, and an employer the person did not ask about.

They run through the brain's `find_people` tool (capability_tools.ts, wired as handler-career wires `people`), which calls the
`searcher` and `leadsFrom` guard and `enforcePeopleReply`. This measures the code's guard on real asks. It does not measure who a
live search finds; `--live` does that.

## Live run (`--live`): model spend, not run

The same 20 asks with the real web search. It is refused without `PEOPLE_SEARCH_SPEND_APPROVED=<DECISIONS line>` and
`ANTHROPIC_API_KEY`, and capped by `--budget-usd` (at most 3). It stores counts and the guard's checks, with every name replaced by
an 8-hex sha256 prefix, so no real name is written.

Quote, per ask (one call, `PEOPLE_SEARCHES` = 2):

| Part | Cost |
|---|---|
| Search fees, 2 × $0.01 | $0.02 |
| Search result tokens, ≈ 26k input at $2/M | ≈ $0.052 |
| ≈ 1k output tokens at $10/M | ≈ $0.01 |
| **Total** | **≈ $0.08 an ask, ≈ $1.65 for 20** |

Recommended cap: `--budget-usd 2.5`. Through the full chat turn, add ≈ $0.10 a turn (≈ $3.65 for 20). The live run still sends
nothing to anyone: finding someone contacts nobody.

```
deno run -A --no-check evals/real-sets/people/run.ts
PEOPLE_SEARCH_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... deno run -A --no-check evals/real-sets/people/run.ts --live --budget-usd 2.5
```
