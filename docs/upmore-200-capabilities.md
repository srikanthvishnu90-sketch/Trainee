> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# Upmore — 50 Capabilities

> **Superseded on paper trading (owner rule, 2026-10-11; noted 2026-10-12):** everything is live. There is no paper
> trading, paper account, paper label or paper fallback anywhere. Wherever this document says paper, read: the person's
> own live brokerage account (Alpaca connector, OAuth), a fresh approval for every order and the $5 per-order cap until
> the owner raises it in writing. An ask to paper-trade is answered that Upmore doesn't offer it
> (`paperTradingReply`, `tests/edge/paper-trading-answer.test.ts`).

Fifty broad capabilities. Each one is a complete feature with depth inside
it — not a sliver. Written the way you'd actually ask.

1. "trade stocks and ETFs for me" — market, limit, stop, and trailing-stop orders; fractional shares; extended-hours trading; modify or cancel open orders; every order approval-gated with a receipt.
2. "tell me how my portfolio is doing" — daily, monthly, and since-inception returns with deposits accounted for; benchmarked against the S&P 500; sector and allocation breakdowns.
3. "keep my portfolio balanced" — drift monitoring with alerts; scheduled or threshold-triggered rebalancing; respects constraints like never selling at a loss.
4. "handle the tax side of my investing" — wash-sale flags; tax-loss harvesting opportunities surfaced as facts; realized gains split short vs long-term; cost-basis tracking through splits.
5. "research any stock or the market for me" — company deep-dives; analyst ratings; earnings calendar with reminders; what happened today and why; everything cited.
6. "alert me on prices I care about" — custom thresholds on any ticker; watchlists; after-hours quotes; exactly one alert per trigger.
7. "copy top investors' trades" — Pelosi, Buffett, Ackman, Burry, and congressional trackers mirrored from public filings into your account, approval-gated per trade.
8. "manage my copy-trading risk" — per-leader and per-position caps; stop-losses; pause and resume; conflict alerts when leaders disagree; filing dates and staleness stated honestly.
9. "get me into IPOs at the offer price" — IPO calendar with ranges and dates; window-open alerts; guided allocation requests (like Oura via Coinbase); flipping-ban warnings; honest odds, never guaranteed.
10. "track pre-IPO companies for me" — OpenAI and Anthropic IPO watches with S-1 alerts; DXYZ proxy exposure with the NAV-premium math; scam-token detection before you touch anything.
11. "invest my money automatically" — recurring buys; round-ups; paycheck splits; cash sweeps above your buffer; drift-triggered buys; one kill switch pauses everything.
12. "manage my subscriptions" — find every recurring charge; cancel what you don't want; warn before trials convert; catch price hikes; verify cancellations actually went through.
13. "handle my bills" — due-date reminders with pay offers; pay-first ordering when cash is tight; overdraft protection; autopay setup; usage-spike diagnosis on utilities.
14. "negotiate my recurring costs down" — call scripts for internet, insurance, and subscriptions with competitor prices to cite; rent-on-card and fee math done with your numbers.
15. "find class-action money I qualify for" — settlement discovery matched to your life; eligibility checks; deadline tracking; proof guidance; honest payout estimates with pro-rata dilution.
16. "tell me what I'm spending money on" — auto-categorized transactions; monthly reports; merchant breakdowns; year-over-year comparisons.
17. "build and enforce my budget" — budgets from your real numbers; warnings before a category blows; subscriptions counted correctly inside it.
18. "make sure I survive to payday" — cash-flow forecasting at your burn rate; bill-vs-paycheck planning; shortfall warnings with a payment order.
19. "connect all my money accounts in one place" — banks via Plaid/SimpleFIN plus brokerages; every balance and transaction searchable; clean disconnects that don't nuke history.
20. "watch my cash flow daily" — low-balance alerts; paycheck-landing notifications; duplicate-charge detection; pending-vs-posted reconciliation when numbers disagree.
21. "brief me on my money every morning" — balances, overnight activity, what's due, what needs attention; plus a deeper weekly review.
22. "alert me to anything unusual" — spending anomalies, fees, spikes; urgency-ranked; quiet hours respected; snoozable; never the same alert twice.
23. "find me ways to make extra money" — the verified route catalog; fastest-$100 finder with exact steps; route stacking into one plan; legitimacy checks on offers you find.
24. "track my money-making progress" — bank-bonus requirement checklists; payout verification against promises; progress to your $1,000 goal.
25. "plan my taxes" — bracket positioning; quarterly estimates for 1099 income; deduction and donation tracking; Roth-vs-traditional education; deadline reminders.
26. "manage my insurance" — adequacy checks against your real exposure; gap analysis naming missing riders; renewal-shopping reminders; claims walkthroughs; deductible math.
27. "get me out of debt" — avalanche-vs-snowball run with your balances and APRs; payoff dates; balance-transfer break-even; honest calls on consolidation.
28. "build and protect my credit" — utilization tracking; score monitoring with plain explanations of what moved; late-payment recovery scripts.
29. "build my emergency fund" — target sized to your actual expenses; the gap in dollars and months; automatic contributions toward it.
30. "teach me how money works" — any term, strategy, or headline explained in plain words; money myths busted with facts.
31. "protect me from scams" — phishing triage; fake-investment detection; voided pre-IPO token warnings; stopping you before money moves to a scammer.
32. "ask my permission before moving money" — one explicit approval per action; receipts for everything; approvals that expire instead of executing late; a kill switch for all pendings.
33. "show me everything you've done" — full audit trail by day or month; every action with its receipt; "what did you do last Tuesday?" answered.
34. "help me hit my savings goals" — goals turned into weekly plans; progress tracked; wins called out, not just gaps.
35. "give me my full financial picture" — net worth trended; a financial-health grade; emergency-readiness score; the single biggest leak to fix.
36. "plan big purchases and retirement" — house and car affordability with real math; retirement projections at your current pace; windfall allocation by priority.
37. "maximize my credit card rewards" — which card for which purchase; cashback tracked; annual-fee math on whether a card earns its keep.
38. "split costs with other people" — family plans and roommates; per-person math; monthly collection reminders so you actually get paid back.
39. "close out my month" — income vs spending reconciled; biggest variances vs last month flagged; subscription, bill, and debt totals in one summary.
40. "manage my freelance money" — 1099 income tracked; quarterly tax set-asides calculated; business and personal cleanly separated.
41. "move money between my accounts smartly" — sweep rules with buffer protection; every transfer approval-gated and logged.
42. "automate my savings" — save rules on any trigger you set; round-ups; surplus sweeps; everything pausable in one tap.
43. "compare financial products for me" — funds, cards, insurance, brokers: fees and features side by side with sources; cheapest honest option shown, no steering.
44. "keep my financial documents organized" — statements, policies, tax forms, and receipts filed, searchable, and findable at tax time.
45. "track news that affects my money" — headlines translated into impact on your holdings, bills, and goals; noise filtered out.
46. "let me test ideas with paper trading" — practice any strategy with fake money; full order types and fills; graduate to real dollars when ready.
47. "run my yearly financial review" — the full checkup: spending, investing, taxes, insurance, and goals; next year's plan out of it.
48. "fight unfair charges for me" — dispute evidence assembled; message drafts written; fee-waiver requests prepared; you send them, nothing filed in your name.
49. "manage my dividend income" — payouts tracked; upcoming ex-dates and pay dates; yield on cost per holding; DRIP on or off with honest broker limits.
50. "find money owed to me" — unclaimed funds in state databases; referral bonuses tracked; cashback left on the table surfaced.
