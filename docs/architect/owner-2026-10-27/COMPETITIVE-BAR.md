# Competitive bar for Trainee (2026-10-27)

Scope: the auto-apply, networking and texting-native career agents in market as of October 2026, compared against the specs on `docs/feature-specs-20261027` (MASS-APPLY, NETWORKING, TASK-INTELLIGENCE). Many review sources are written by competitors, which is flagged as **[competitor source]**. Vendor numbers are labeled **claimed**.

`docs/competition/parity-matrix.md` on trunk tracks fintech and wallet apps: 241 seeds, all `DISCOVERED`. Its only career row is `PR-017 Job and gig discovery`. No career competitor is tracked there today.

## 1. Comparison

| Product | What, channel | Approval | Volume | Results (claimed) | Price | Top complaints / where it fails |
|---|---|---|---|---|---|---|
| **Simplify** | Browser extension autofill and tracker | Human clicks submit | 1 at a time | none found | Free; paid ~$39.99/mo [1] | Autofill depends on the site; AI resume quality is weak; no refunds [1] [competitor source] |
| **LazyApply** | Chrome bot on LinkedIn, Indeed, ZipRecruiter, Glassdoor | None (bot runs) | 150 / 300 / 750 per day [2] | none | $99 / $149 / $249 lifetime [2] | Trustpilot ~2.1–2.4 [2][3]. Wrong screening answers, half-finished forms, browser crashes, refund friction, LinkedIn account risk [4][3] |
| **JobCopilot** | Hosted "autopilot" | Minimal | up to 50/day (Elite) [5] | none quantified | $8.90–12.90/wk; ~$28–56/mo [6][5] | Ignores the filters set; applies abroad; scam and filled roles; duplicate applications; generic answers; double charges [5][6] [competitor source] |
| **Jobright** | Web and app; matching, auto-apply, "insider connections" | Unclear | "hundreds a day" (claimed) | 3M users; "3x interviews"; "4x" with a referral (claimed) [7][8] | Not published to job seekers [7] | AI bullets add metrics the user never gave; unfocused volume; US-centric [7] |
| **Massive** | Hosted service; writes a resume and cover letter per job | Preview is possible; marketed as "set and forget" | 50–200 per month | "1–2 interviews per 100 applications" (claimed) [9] | $49 / $99 per month [10] | Trustpilot 1.7 (43 reviews). Invented skills; a wrong sponsorship answer; the same job applied to 100+ times; applications weeks late; a proxy email address; trial-billing surprises [9] [competitor source] |
| **Sonara** (BOLD) | Hosted auto-apply | Reviews a few trial applications, then automatic | recommends at least 100 | none | $2.95 trial, then $23.95/mo [11] | Irrelevant matches; uneven quality. The 2024 shutdown locked users out of their history [11][3] |
| **AIApply** | Auto-apply plus interview tools | Not stated | tiered | anecdotal | $12–23/wk [12] | Slow; inconsistent results; poor location and language targeting [12] |
| **Huntr / Teal / Careerflow** | Tracker plus autofill extension | Human submits | manual | none | Huntr $40/mo; Teal $29/30 days; Careerflow $23.99/mo [13] | No auto-apply; no email-based tracking; no networking [13] |
| **Jack & Jill** | AI agent by voice, email and WhatsApp; agent-to-agent matching; intros to the hiring manager | Both agents must agree | ~5,000 interviews a month network-wide | 350k candidates; 25k interviews arranged; no hire rate disclosed [14] | Not disclosed | Only employers in its own network (5,000) [14] |
| **Boardy** | Calls you by phone; double opt-in intros | Both sides opt in | low | none | Not published | Thin coverage in some industries and regions; no follow-through after the intro [15][16] [competitor source] |
| **Clera** | iMessage and WhatsApp talent agent | Intros only | low | none | Not stated | Makes intros only; does not apply [17] |
| **DIY outreach (Apollo, Hunter, lemlist)** | Email finder plus sequencer | User | per plan | Recruiting cold email averages ~7.5% replies; hybrid AI plus human emails 14.7% vs AI-only 4.1% [18] | Hunter $34–349/mo; Apollo $49–149/mo [19] | Up to 30% of unverified Apollo emails bounce [19]; consumer Gmail fits only 10–20 cold emails a day [20] |

Three patterns run across all of them:

1. **Volume tools lose on accuracy and trust.** Wrong answers, invented skills, duplicates, scam or stale postings, and billing are the five recurring complaints.
2. **Agent and intro tools lose on reach.** They cover only their own network, and none of them applies for you.
3. **No product does both** mass apply and own-mailbox networking from a text thread, with proof. Market context: LinkedIn reports ~11,000 applications a minute (+45% year over year), and 67% of hiring managers say AI-generated applications slow hiring [3]. Spray volume alone is losing value.

## 2. The 15 bars Trainee must hit

Status values are read against the specs on the branch:

- **Covered:** a spec rule plus an acceptance test.
- **Partial:** a mechanism exists, but no test or target.
- **Gap:** not in the specs.

| # | Bar (testable) | Beats | Status |
|---|---|---|---|
| B1 | No application is ever sent with an untraced answer. Every form answer maps to a confirmed fact id or to the person's own words; EEO answers default to decline. | LazyApply, Massive wrong answers | **Covered**: rule 4, APL-04, D-007 |
| B2 | A tailored resume or cover letter adds no skill, metric, employer or title outside confirmed facts (mutation test: an injected "led a team of 12" is refused). | Massive and Jobright invented content | **Partial**: `materials.tailor_resume` has an audit trace; no acceptance test in APL |
| B3 | One yes approves exactly the payloads shown, hash-bound, on every channel. A changed payload is refused by number. | "set and forget" tools | **Covered**: APL-05, NET-06, D-MS-1 / D-MN-2 |
| B4 | 0 exact duplicates, including the same posting reached by two URLs or two boards. | Massive's "100+ times"; JobCopilot | **Covered**: APL-06 (canonical key; aggregator-vs-ATS mirrors untested) |
| B5 | "Submitted" requires the engine's record; "confirmed" requires the employer's page or email. The person can see the proof (receipt, screenshot, confirmation id). | Every tool (none prove it) | **Covered**: APL-09, D-024 |
| B6 | Before a posting enters a batch, the fit and eligibility gate passes on every item: the posting is open, it is younger than the freshness limit, it is not scam or ghost-flagged, and its knock-outs (location, work authorization or sponsorship, years, degree) are checked against confirmed facts. Each card item shows why it fits. | JobCopilot (abroad, scam, filled), Massive (weeks late), Sonara (irrelevant) | **Gap**: APL-02 drops only closed or unknown postings |
| B7 | Applications go out under the person's own email and phone. There is no proxy inbox, and employer replies land in the person's mail. | Massive proxy email | **Covered (implicit)**: APL-01 contact facts; not stated as a rule |
| B8 | A measured share of real postings is drivable end-to-end per ATS family: Greenhouse, Lever, Ashby, Workday, iCIMS, SuccessFactors, Taleo. The rest get a truthful hand-back. | Massive limits ATS coverage to its paid tier | **Gap**: `apply.portals_gated` missing or partial; no coverage target |
| B9 | A phone-only person gets the whole loop (resume, batch, yes, status) over SMS, iMessage, WhatsApp and Telegram, with no computer. | Simplify, LazyApply and Huntr are desktop-only | **Partial**: APL-03 needs the owner's preparation host; channel parity rule 8 |
| B10 | Outcomes are measured and shown: per person and in evals, confirmations per 100 applications, interviews per 100 applications, and replies per 100 emails. The product sets a target to beat Massive's claimed 1–2 interviews per 100. | Nobody publishes verified outcomes | **Gap**: specs measure states, not outcomes |
| B11 | Only verified addresses are emailed. Hard bounces stay under 3% per batch, and a bounced address is never retried. | Apollo's 30% unverified bounces | **Covered**: rule 6 and NET-04 (mechanism); the bounce target is missing |
| B12 | The person's own mailbox stays healthy: List-Unsubscribe header and opt-out, bounce and complaint signals monitored, and an automatic pause on outside reputation signals. The consumer-Gmail ceiling (500/day) is said up front. | Cold email from consumer Gmail is unsafe beyond ~10–20/day [20]; Google's 0.3% spam threshold | **Gap**: NO LIMITS removes warm-up and spacing; only quota errors trigger back-off |
| B13 | Every email carries at least 2 recipient-specific facts with a cited source. No AI-only boilerplate; the reply rate is measured against the 7.5% recruiting benchmark. | AI-only email gets 4.1% replies vs 14.7% for hybrid [18] | **Partial**: NET-05 fact-lock; no personalization or reply-rate bar |
| B14 | The reply-to-call loop closes in the thread: classify the reply, propose free slots, send an approved invite from the person's calendar, and show the event id. | Boardy and Clera stop at the intro | **Covered in spec**: NET-07 and NET-09 (no Calendar API call in code yet) |
| B15 | Networking feeds applications: each application can trigger a referral or hiring-team ask tied to that posting, with a recorded result per company. | Jobright insider connections | **Partial**: NET-14 and NET-15 are PROPOSED |

Also worth tracking:

- **Exactly-once under a crash** (APL-07, NET-06-S4) is covered.
- **Data export, so a shutdown does not lock users out the way Sonara's did:** export is not in the specs.
- **Transparent billing and cancel-by-text** (the top complaint for Massive and JobCopilot) is the owner's area and not in the specs.
- **Follow-up depth:** sequencing data shows 3 touches capture most replies [18], but NET-08 allows one follow-up. This is a deliberate recipient protection and needs an owner decision.

Totals: 7 Covered, 4 Partial, 4 Gap.

## 3. The five highest-leverage gaps to build next

1. **G1: fit, eligibility and freshness gate (B6).** This is the top complaint across every volume tool. Run knock-out checks (location, sponsorship, years, degree) against confirmed facts, apply a posting-age limit, add scam and ghost signals, and show a "why it fits" line on each card item. It is cheap and inside APL-02 and `fit.score`.
2. **G2: outcome funnel and targets (B10, B13).** Track confirmed, interview, reply and call per 100, both per person ("this week: 120 sent, 97 confirmed, 4 interviews") and as an eval and launch metric. Without it Trainee cannot claim "better", and no competitor publishes verified numbers.
3. **G3: mailbox-reputation guard (B12, B11 target).** Add a List-Unsubscribe header, bounce and complaint monitoring with an automatic pause, and an up-front statement of the consumer-Gmail ceiling.
   - Under NO LIMITS this is framed as backing off on outside signals, not as a Trainee cap. The owner must confirm.
   - Note: `gmail.send` is a *sensitive* scope (verification only), but `gmail.readonly`, which reply tracking and confirmation-by-email need, is *restricted*. It requires a security assessment that costs $15k–75k and takes weeks to months [21].
4. **G4: ATS coverage target (B8).** Measure what share of postings the engine can drive end-to-end per ATS family on fixtures. Close the Workday, iCIMS, SuccessFactors and Taleo gaps in that order. Report coverage honestly on the card.
5. **G5: networking tied to applications (B15, plus B2's test).** Promote NET-14 (referral ask per applied posting) and NET-15 (target-company and alumni lists) from PROPOSED. Add the tailored-resume fact-lock acceptance test. This combination of apply and warm intro with proof is the one thing no competitor has.

## Sources

1. https://jobright.ai/blog/?p=5309
2. https://aitoolsatlas.ai/tools/lazyapply
3. https://www.hiration.com/blog/ai-auto-apply-bots/
4. https://blog.loopcv.pro/lazyapply-review/
5. https://blog.theinterviewguys.com/?p=10535
6. https://blog.loopcv.pro/jobcopilot-review/
7. https://atsverification.com/blog/jobright-ai-review-2026/
8. https://jobright.ai/job-referral
9. https://scoutify.com/blog/massive-review/
10. https://tsenta.com/blog/tsenta-vs-massive
11. https://jobright.ai/blog/?p=6527
12. https://jobright.ai/blog/aiapply-review-2026-how-it-works-pricing-and-honest-user-experiences/
13. https://jobshinobi.com/compare/huntr-vs-teal-vs-careerflow-job-tracker
14. https://thenextweb.com/news/jack-and-jill-40m-series-a
15. https://www.goodword.com/blog/boardy-ai-alternative-can-ai-really-manage-your-network
16. https://www.bestaitools.com/tool/boardy/
17. https://feedbagel.com/post/clera-an-ai-talent-agent-that-matches-candidates-to-roles-via-imessage-and-whats
18. https://www.herohunt.ai/blog/recruiting-outreach-benchmarks-2026-reply-rates/
19. https://bouncezero.io/hunter-vs-apollo-2026
20. https://firstsales.io/blog/gmail-sending-limit-2026
21. https://www.nylas.com/blog/google-oauth-app-verification/
