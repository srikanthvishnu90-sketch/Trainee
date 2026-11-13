# Research support check: turning it on

Owner decision (2026-11-13): `FAIL_CLOSED.support` (`supabase/functions/_shared/agent/research/market.ts`) is switched on after a
paid measurement of the real judge. This page holds the two things that switch needs: the measurement, prepared and not run, and the
existing architect tests that fail with the switch on, each with the assertion it fails and the amendment proposed (the owner
approved amending them as part of turning the check on). Measured on branch `ag/research-support-round4`.

## 0. Status (2026-11-13, branch `ag/research-support-round11`, round 13)

Not switched on yet: `FAIL_CLOSED.support` is still `false`. The three live judge runs: D-079 run 1 ($0.0698), D-080 run 2 ($0.116:
true kept 54/61 by the judge, 3 false through), D-082 run 3 ($0.129: 55/61, 4 false through). With the switch on, this round
measured **58 failing tests in 22 architect files** (section 2's table of 53, measured at round 4, is out of date):
injecting a judge (`tests/architect/support-test-judge.ts`, a deterministic word-and-negation judge, not always-yes) fixes only a
few; the rest pin the model's words, the sync `enforceMarketReply` on a hand-built result (no judge: fails closed), places in the
model's sentence, or old drop reasons, and each needs its expectation rewritten and checked against the safety it pins.
`research-brief-browser.test.ts` needs the gate's Playwright browser (CI only), not an amendment.

| File | Failing | Tests |
|---|---|---|
| `d067-live-round2-20261112.test.ts` | 2 | D67-1 C9 (D-024): a file research reply with no sentence on record is its thesis; a blank ; D67-10 C22 (G7): pay already shown in the conversation is used; a named posting is read be |
| `d070-live7-fixes-20261112.test.ts` | 2 | D70-4 C11, C22 (D-067 (6), must-fix (d)): pay from any posting read carries its link; show |
| `d071-live8-fixes-20261112.test.ts` | 3 | D71-8 C22: a going-rate ask runs sourced research beside the posting pay already shown |
| `d073-live9-fixes-20261112.test.ts` | 3 | D73-6 C9: pay said again from an earlier reply carries its place and link, on the research |
| `d073-review-fixes-20261113.test.ts` | 3 | R1 a place goes only into the sentence bound to that posting's pay; an ambiguous sentence ; R2 a model-worded reading with a figure is never the verified answer unless a sentence of ; R2 nothing verified: the reply says it could not confirm, with the sources checked; never  |
| `d073-review2-fixes-20261113.test.ts` | 3 | G1 market: pages read, nothing verified: the reply always says it could not be confirmed a; G1 company research: pages opened and nothing quotable: the reply says so and lists the pa |
| `flow-scenarios-research-r3.test.ts` | 1 |  |
| `loop-10-research.test.ts` | 1 | item 10 loop: 15 research asks at the real handler; every claim sourced, dated, meaning ke |
| `mirror-wa-batch1-process.test.ts` | 1 | MP-1 the EXISTS turns follow Instinct's process: the tools offered and called, the artifac |
| `research-brief-browser.test.ts` | 1 | market research brief in Chromium: 390 and 1280 px, light and dark |
| `research-company-brief-20261109.test.ts` | 5 | WO-H/1 turn 1, role unknown: the brief overview is made meanwhile and the reply asks ONLY ; WO-H/2 the brief: facts, reading and unknowns separate; dated developments keep their mean; WO-H/3 turns 2 and 3: the role is used without asking again; 'less generic' expands the qu; WO-H/5 guards on their own: dates, metric meaning, source limits, reply enforcement; WO-H/6 the person's side: confirmed facts tie to what the role page asks, never stretched; |
| `research-company-f2-20261109.test.ts` | 1 | F.2 replay with research on: a sourced chat answer, interpretation labelled, grounded ques |
| `research-company-review-20261109.test.ts` | 4 | F2-file-off: with no research File (publish off or failing), F2A is answered in chat with ; SEC: another company's filing that names a private company is never its source; with no de |
| `research-figures-failclosed-20261113.test.ts` | 8 | item 1 (A): a figure whose page sentence denies it, or says it of someone else, is never s; item 1 (A): a model-worded line with no number does not stand on a sentence of the other p; item 3 (B): a reply sentence cannot move a kept figure onto someone else; the kept page se; item 7 (D): a page's pay sentence is about the role asked by its own words, never by the p; item 5 (E): nothing verified: one sentence that only says so, then the pages checked; no o; item 6 (F): the reply came back unfinished and research kept lines: the person gets those ; item 4 (G): one posting read this turn: a sentence about another employer or the person's  |
| `research-free-brief.test.ts` | 4 | a research brief File from free sources: the ATS count is cited to the board it came from,; the cover thesis names its sources, or says it summarizes the cited sections; a long host ; facts guard: a heading or form name is never a fact; a filing's form code is not a number; when two cited sources differ on a figure, the brief shows both with their sources and say |
| `research-market-reply.test.ts` | 5 | example 1, 'what would change the market for X': a research brief File, every claim cited ; example 2, 'compare these 3 companies': a brief with the comparison table; a cell no page ; the format: a File only when the brain asks and a publisher exists (CAREER_RESEARCH_BRIEF); no source could be opened, or none supports an answer: the reply says so and carries no fi |
| `research-market-review.test.ts` | 2 | review: a claim stands only on a quote that says it; review: an inline sentence's figures come from the points its own citations name |
| `research-market-subject-review.test.ts` | 2 | review: a comparison cell's figure is that column's company's, never another's; review: an inline sentence names only who its cited points name |
| `research-no-sources-review.test.ts` | 2 | review: a fact never names another employer than its quote; review: failed research never sounds certain |
| `research-review-fixes-589.test.ts` | 1 | research_market's effect is write_own when it published a File, read when it answered inli |
| `web-research-d060.test.ts` | 3 | D-060 research: a passage the search quoted stands for a page the reader could not open; t |
| `workday-posting-d062.test.ts` | 1 | D-062/MP-W C11 and C18 on Workday through the real handler: read only, the posting's own p |

## 1. The live measurement (not run)

- Script: `evals/research-support/judge-measure.ts`. Without `--live` it prints the case count and an estimate and sends nothing.
  Today: 353 cases, 179 reach the judge, estimated $0.05 to $0.21 in all.
- Workflow: `.github/workflows/research-support-live.yml`, on the pattern trunk set for live eval runners in #824
  (`real-sets-live.yml`). It runs only on a push to `ci/research-support-live` that changes
  `evals/research-support/run-request.json`. Its first step checks the request (`approval` must be a `D-xxx` line,
  `0 < budget_usd <= 1`); the run step gets the key and the ledger secrets. The script itself refuses unless the approval is a row of
  `docs/architect/DECISIONS.md` written for it: the row must name `judge-measure` and give a dollar cap at least the run's
  `--budget-usd` (`evals/research-support/approval.ts`; any other row is refused). It then reserves the cap at the shared $80 ledger (`eval_budget.ts openLiveRunLedger`,
  `EVAL_LEDGER=shared`; refused if it does not fit what remains), puts the same cap as an in-process gate on every judge call (a
  call that does not fit is refused before it is sent), and settles the ledger to the metered cost at the end, also on error. It
  writes `result.json` (confusion table, wrong cases, latency per call, `spent_usd`) and the workflow uploads it.
- To run, after the owner writes the DECISIONS row (for example `| D-0xx | **Owner approves the live judge-measure run of the support judge, cap $0.50.** | settled | owner | 2026-11-xx |`; the row must be the owner's, approve judge-measure with no "not" or refusal in it, and give a cap at least the run's): set `approval` in `evals/research-support/run-request.json` to it (it is
  `PENDING` now, which the first step refuses), then `git push origin HEAD:ci/research-support-live`. Suggested cap: `0.5`.
- By hand instead (same refusals, same ledger):
  `SUPPORT_JUDGE_SPEND_APPROVED=D-xxx ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/research-support/judge-measure.ts --live --budget-usd 0.5 --out out/`

## 2. Existing tests that fail with the switch on (53)

Run: the 55 architect files that touch research or the brain, with `FAIL_CLOSED.support = true` (flag off: all pass), plus the
two real-handler files that need Postgres 16 (run as root with `CI=true PGBIN=/usr/lib/postgresql/16/bin`; rows 53 and 54). Row 7 passes since round 5 (an outage now shows the pages' own units), so 53 fail today. The failing
line is the first assertion that fails in each test; a test may fail again further down once that line is amended.

Codes: **J** the test builds research with no judge, so with the switch on every line fails closed: add `judge` to its deps (a test
judge `quoteYes` that says yes only to "the marked text is the page's own statement…", plus yes for the claims the test calls true);
with an always-yes judge only 6 of these pass outright. **Q** the expected line is the model's words; with the switch on it is the
page's unit in quotation marks (`From <host>, a page about <Employer>: "…"` when the employer comes from the page). **S** the test
calls the synchronous `enforceMarketReply`/`enforceCompanyReply` with a model reply, which with the switch on lets no model sentence
through: call the awaited `…Supported` form with the judge and the ask, and use the closed could-not-confirm form ("I couldn't
confirm it." / "I couldn't find a source for it.") or expect code's own line. **P** a place is no longer written into the model's
sentence; it goes on the posting's link line from that posting's record. **A** the support path records one drop reason,
`unsupported`. **O** the test needs a judge that says no (an always-yes judge passes a denied reading). **E** File comparison labels.

| # | Fails at | Assertion | Proposed amendment |
|---|---|---|---|
| 1 | `d067-live-round2-20261112.test.ts:76` | `eq(r, C9_FILE.thesis, "the thesis, which code kept, stands for the brief; the File link follows it from code");` | J+S: build `C9_FILE` with `judge: quoteYes`; expect the thesis as the page's unit in quotation marks (`"…"`), read via `enforceMarketReplySupported`. |
| 2 | `d067-live-round2-20261112.test.ts:286` | `eq(enforceMarketReply(said, none, shownPayOf(P.C22, shown)), `${said}\nhttps://paypal.wd1.myworkdayjobs.com/x`, "the figure already shown stands, with its source link and the ho…` | S: call `await enforceMarketReplySupported(said, none, shown, { judge, ask })`; the shown line stands whole with its own link; change the second sentence to the closed form `I couldn't confirm it.` (or expect code's could-not-confirm line). |
| 3 | `d070-live7-fixes-20261112.test.ts:95` | `eq(r.status, "ok", JSON.stringify(r).slice(0, 300));` | J: add `judge: quoteYes` to the company deps; then `status` is `ok`. |
| 4 | `d070-live7-fixes-20261112.test.ts:219` | `ok(r.reply.includes(p.url) && /\$28-\$49/.test(r.reply), r.reply);` | P+J: no judge, so the model's pay sentence is replaced by the posting's record line; expect `/\$28- ?\$49/` and the link (or inject a judge that says yes to the model's pay sentence). |
| 5 | `d071-live8-fixes-20261112.test.ts:116` | `ok(/research reply/.test(m.r.shorten.why), m.r.shorten.why);` | J: give the brain `market: { judge }`; re-measure `shorten.why` (with no judge the research turn ends `incomplete_reply`). |
| 6 | `d071-live8-fixes-20261112.test.ts:162` | `eq(r.status, "ok", JSON.stringify(r).slice(0, 400));` | J+Q: inject the judge; expect each kept line as its page unit in quotation marks. |
| 7 | `d071-live8-fixes-20261112.test.ts:340` | `ok(/\$32/.test(r.reply) && r.reply.includes(levels[0].url), r.reply);` | J: inject the judge (passes with a yes judge). **Passes since round 5.** |
| 8 | `d073-live9-fixes-20261112.test.ts:109` | `eq(r.status, "ok");` | J+A: inject the judge; expect the audit's drop reason `unsupported` (the support path has one reason) and the new counts. |
| 9 | `d073-live9-fixes-20261112.test.ts:187` | `eq(withS.audit.samples[0], { section: "summary", why: "claim_words_not_in_quote", text: "Citadel pays new grads generously.", quote: "The base salary range for this role is $235…` | A: expect `why: "unsupported"` in the audit sample. |
| 10 | `d073-live9-fixes-20261112.test.ts:328` | `ok(out.includes("$28-$49 hourly (Chicago, IL), and that isn't Citadel.") && out.includes(POSTINGS[0].url), out);` | P: the place is no longer written into the model's sentence; expect `(Chicago, IL)` on the posting's link line (`PayPal, SWE Intern (Chicago, IL): <url>`). |
| 11 | `d073-review-fixes-20261113.test.ts:31` | `eq(two.split("\n")[0], "Stripe pays $40/hr (Chicago, IL). PayPal pays $40/hr (Seattle, WA).");` | P: expect `Stripe pays $40/hr. PayPal pays $40/hr.` and each place on its own link line from that posting's record. |
| 12 | `d073-review-fixes-20261113.test.ts:74` | `eq(r.status, "ok");` | J+O: inject an oracle judge that says no to the denied reading (an always-yes judge passes it); then `status` and `answerable` as pinned. |
| 13 | `d073-review-fixes-20261113.test.ts:113` | `eq(a, "I looked for Citadel's intern pay and couldn't confirm it from the pages I read.\n\n[1] Citadel compensation notes: https://citadel.example/pay (read Nov 13, 2026)");` | S: the sentence is not in the closed could-not-confirm form; expect code's line (`NOT_CONFIRMED`) with the pages listed, or change the model sentence to `I couldn't confirm it.` |
| 14 | `d073-review2-fixes-20261113.test.ts:42` | `eq(enforceMarketReply("I looked for Citadel's intern pay and couldn't confirm it from the pages I read.", r), `I looked for Citadel's intern pay and couldn't confirm it from the…` | S: as above (`enforceMarketReplySupported`; closed-form sentence or `NOT_CONFIRMED`). |
| 15 | `d073-review2-fixes-20261113.test.ts:78` | `eq(enforceCompanyReply("I couldn't find anything I could quote about Zentrafin.", r), `I couldn't find anything I could quote about Zentrafin.\n\n${list}`);` | S: company path: expect code's blocker sentence with the pages, or change the model sentence to `I couldn't find it.` |
| 16 | `d073-review2-fixes-20261113.test.ts:99` | `eq([r.status, r.format, published.length], ["ok", "file", 1]);` | J: inject the judge so the File is published; expect quoted conditions/risks. |
| 17 | `research-company-brief-20261109.test.ts:42` | `eq([call.ok, call.effect], [true, "write_own"], "a published File is a write to the person's own account");` | J: inject the judge so the brief File is published (`effect` is `write_own` only when a File was made). |
| 18 | `research-company-brief-20261109.test.ts:54` | `eq(r.status, "ok");` | J+Q: inject the judge; expect developments as `"<unit>"`, lent ones as `From stripe.example, a page about Stripe: "…"`. |
| 19 | `research-company-brief-20261109.test.ts:98` | `eq([d2.role, d2.role_asked, d2.role_asks.length > 0], ["Data analyst internship", undefined, true]);` | J+Q: inject the judge; role lines are quoted units (assert on `role_asks.length` after judging). |
| 20 | `research-company-brief-20261109.test.ts:129` | `eq(enforceCompanyReply("Stripe grew 80% last year. Billing handles subscriptions. Which role is it for? What date is the interview?", r), "Billing handles subscriptions. Which r…` | S: build `r` with the judge and call `enforceCompanyReplySupported`; the role question must be the closed form (`Which role are you interviewing for?`), so amend the reply or the expectation. |
| 21 | `research-company-brief-20261109.test.ts:136` | `eq(r.project.ties.map((t: any) => t.fact), ["skill: SQL and dashboards in Tableau"], "only the fact that shares what the role page asks");` | J+Q: inject the judge; ties are made from the judged role lines (re-pin the tie list on the quoted text). |
| 22 | `research-company-f2-20261109.test.ts:57` | `ok(/Stripe Billing lets businesses bill customers with subscriptions and invoices \[\d\]\./.test(r), r);` | J+Q: inject the judge; expect `"Stripe Billing lets businesses bill customers with subscriptions and invoices." [1].` |
| 23 | `research-company-review-20261109.test.ts:53` | `eq(r.status, "ok");` | J: inject the judge. |
| 24 | `research-company-review-20261109.test.ts:62` | `eq([r.status, r.format, r.file_url], ["ok", "inline", null]);` | J: inject the judge. |
| 25 | `research-company-review-20261109.test.ts:71` | `const paywalled = r.sources.find((s: any) => s.limit === "paywalled").n;` | J+O: inject an oracle judge that says yes to the paywalled source's line so the source is cited. |
| 26 | `research-company-review-20261109.test.ts:89` | `ok(/SEC filings were not read: SEC asks every reader to declare a contact/.test(enforceCompanyReply("Zentrafin launched instant payouts for marketplaces [1].", r)), JSON.stringi…` | J: inject the judge (passes with a yes judge). |
| 27 | `research-figures-failclosed-20261113.test.ts:66` | `eq([r.status, r.points.map((p: any) => p.text)], ["ok", ["Citadel interns do not earn $5,000 a week."]]);` | J+Q: inject the judge; expect `["ok", ['"Citadel interns do not earn $5,000 a week."']]`. |
| 28 | `research-figures-failclosed-20261113.test.ts:78` | `eq(r2.answerable, [same]);` | O: an oracle judge that says no to the negated reading; `answerable` then holds the quoted unit, not the model's words. |
| 29 | `research-figures-failclosed-20261113.test.ts:84` | `eq(r.points.map((p: any) => p.text), [kept]);` | J+Q: expect the kept line as `"Senior traders at Citadel received a signing bonus of $5,000."`. |
| 30 | `research-figures-failclosed-20261113.test.ts:104` | `eq([r.status, r.format, published.length], ["ok", "file", 1]);` | J: inject the judge so the File is published. |
| 31 | `research-figures-failclosed-20261113.test.ts:140` | `ok(enforceMarketReply("", r3).includes("Software engineering interns at Citadel earn $120 an hour [1]."), enforceMarketReply("", r3));` | Q: expect `"Software engineering interns at Citadel earn $120 an hour." [1].` |
| 32 | `research-figures-failclosed-20261113.test.ts:161` | `eq(enforceMarketReply(own, r), `${own}\n\n${LISTED}`);` | S: closed-form sentence or `NOT_CONFIRMED`, via `enforceMarketReplySupported`. |
| 33 | `research-figures-failclosed-20261113.test.ts:176` | `ok(t.reply !== INCOMPLETE_REPLY && t.reply.includes("Software engineering interns at Citadel earn $120 an hour [1].") && t.reply.includes(URL1) && !/9,999/.test(t.reply), t.reply);` | J+Q: give the brain `market.judge`; expect the quoted unit `"Software engineering interns at Citadel earn $120 an hour." [1].` |
| 34 | `research-figures-failclosed-20261113.test.ts:195` | `eq(payWithSource("PayPal pays $40/hr.", [paypal]).split("\n")[0], "PayPal pays $40/hr (Chicago, IL).");` | P: expect `PayPal pays $40/hr.` and `PayPal, SWE Intern (Chicago, IL): <url>` on the link line. |
| 35 | `research-free-brief.test.ts:30` | `eq([r.status, r.format, (r as any).dropped], ["ok", "file", 1], "the 9,000 claim is dropped: its number is not in its quote");` | J+Q: inject the judge; re-pin `dropped` (the support path counts each refused line) and expect the File. |
| 36 | `research-free-brief.test.ts:53` | `ok(v.ok, JSON.stringify(v));` | J: inject the judge so the File data exists. |
| 37 | `research-free-brief.test.ts:82` | `eq([r.points.map((p: any) => p.text), r.dropped], [["Hollow Oak Logistics operates 14 distribution centers in the Midwest."], 1]);` | J+Q: inject the judge; expect the quoted unit (round 4 also keeps the `Form 10-K` heading out: no predicate, no line). |
| 38 | `research-free-brief.test.ts:104` | `eq(r.disagreements, [{ label: "Headcount, Hollow Oak Logistics", values: [{ value: "600", cite: [1] }, { value: "3,900", cite: [2] }] }]);` | J: inject the judge (round 4 compares the pages' own figures, so the disagreement is found on quoted lines). |
| 39 | `research-market-reply.test.ts:63` | `eq(published.length, 1);` | J: inject the judge so the File is published. |
| 40 | `research-market-reply.test.ts:87` | `eq(data.comparison.options.map((o: any) => o.name), ["Acme Energy", "Globex Power", "Initech Grid"]);` | J: as above; the comparison labels must be the ask's words or a cell unit's opening words. |
| 41 | `research-market-reply.test.ts:106` | `ok(/\$180,000 a year \[1\], against \$150,000 nationally \[2\]\./.test(body) && !/400,000\|levels\.example\|\[3\]/.test(out.reply), out.reply);` | J+Q: inject the judge; source [2]'s figure is its unit in quotation marks. |
| 42 | `research-market-reply.test.ts:116` | `ok(r.status === "ok" && r.format === "inline" && r.asked === "file" && r.notes.some((n) => /not switched on/.test(n)));` | J: inject the judge (passes with a yes judge). |
| 43 | `research-market-reply.test.ts:130` | `eq(enforceMarketReply("Batteries will grow 35% a year. I couldn't open a source for that.", r), "I couldn't open a source for that.");` | S: `I couldn't open a source for that.` is outside the closed form; expect `NO_SOURCES`, or change it to `I couldn't find a source for it.` |
| 44 | `research-market-review.test.ts:29` | `ok(r.status === "ok", JSON.stringify(r));` | J+Q: inject the judge; expect the page units in quotation marks. |
| 45 | `research-market-review.test.ts:44` | `ok(r.status === "ok" && r.sources.length === 2, JSON.stringify(r));` | J+Q: as above. |
| 46 | `research-market-subject-review.test.ts:34` | `ok(r.status === "ok" && r.comparison, JSON.stringify(r));` | J+E: inject the judge; a comparison needs judged cells and labels from the ask or the unit. |
| 47 | `research-market-subject-review.test.ts:46` | `ok(r.status === "ok" && r.sources.length === 2, JSON.stringify(r));` | J+Q: inject the judge; expect quotes. |
| 48 | `research-no-sources-review.test.ts:28` | `ok(r.status === "ok", JSON.stringify(r));` | J+Q: inject the judge; expect the quoted Acme unit (and only Acme's). |
| 49 | `research-no-sources-review.test.ts:39` | `eq(enforceMarketReply("Demand is rising. I couldn’t confirm an answer from any page I could open.", r), "I couldn’t confirm an answer from any page I could open.");` | S: `…from any page I could open.` is outside the closed form; expect `NO_SOURCES`, or change it to `I couldn't confirm an answer.` |
| 50 | `research-review-fixes-589.test.ts:59` | `eq((await run("file")).effect, "write_own");` | J: inject the judge so the File is published (`write_own`). |
| 51 | `web-research-d060.test.ts:120` | `eq(out, [` | S+Q: messages layout through `enforceMarketReplySupported` with the judge; expect each paragraph as judged words or quoted units. |
| 52 | `web-research-d060.test.ts:144` | `ok(r.status === "ok", JSON.stringify(r));` | J+Q: inject the judge; expect `"Anonymous posters describe 70-hour weeks at Citadel."`. |
| 53 | `mirror-wa-batch1-process.test.ts:177` | `ok(… official and anecdotal sources told apart …)` (MP-1, C9) | Flag on, "official" needs the employer's own domain from the record (the plan's `sites` or the search's `found.sites`); the mirror script's search gives none, so citadel.com reads "reported". Amend the script's search answer to carry `sites: ["citadel.com"]` (the record), or expect "reported". |
| 54 | `web-research-d060.test.ts:294` | `ok(…)` on the real handler's reply (D-060 at the real handler) | The handler's real judge goes through the test's Anthropic stub, which answers the judge's call with the brain's next scripted step (not a JSON array): the judge "fails", every line falls to the outage path (quoted units plus the not-checked clause), and the script is one step out of line, which is the crash the review saw on a no_sources result. Amend the stub to answer any request whose system prompt starts "You check claims against passages" with a JSON array (yes for the quote candidates and for its true lines) without advancing the script; then expect the quoted units in Instinct's layout (row 50's amendment). |
