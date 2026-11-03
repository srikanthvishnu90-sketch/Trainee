> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# Upmore: capability and connector audit

Audit date: October 8, 2026. Target: the local checkout of `srikanthvishnu90-sketch/upmore-agent`, base commit `db68fff`, including the existing uncommitted monitor/test changes. Those changes were preserved. This is a code, architecture, product, and test audit, not a certification of the deployed service. Production secrets, customer accounts, merchant actions, bank transfers, and brokerage trades were not exercised.

## 1. What Upmore must become

Upmore should maintain a reliable model of a person's financial life, notice opportunities and obligations, explain the relevant facts in messages, obtain the right authorization, carry out supported actions, and verify the result. A catalog entry, calculator, link, drafted letter, or successful HTTP request is not an end-to-end capability.

The five product jobs are **manage money, recover money, earn money, invest money, and understand money**. Each job needs the same chain:

`connect → normalize → understand → detect → propose → authorize → execute → reconcile → report → keep watching`

“Connect once” means persistent, revocable connections and remembered preferences. It cannot promise that a bank will never require reauthentication, a merchant will never require MFA, or every future action is authorized by connecting an account. Read access, payment authorization, and recurring mandates are separate objects.

The repository already specifies **256 capabilities in 27 areas**. Its build registry declares **190 planned, 34 read, 23 prepare, 8 gated, and 1 live**. These are declarations, not measured completion. The one live entry is subscription cancellation, and all **30 merchant playbooks are marked unverified**. The supervised-playbook gate is a good boundary; removing it would conceal the missing capability.

The user's 15/100 is a useful statement of the product gap. I have not converted the planned percentage into a fabricated quality score. A credible 100/100 requires explicit evidence against the rubric below and an honest supported-service boundary.

Companion: [all 256 capabilities, connector dependencies, implementation contracts, and feature-specific acceptance criteria](upmore-capability-matrix.md).

Architecture clarification: [a general obligation engine](upmore-obligation-engine.md) supplies the shared model, discovery, reasoning, authorization and execution planner for all types of money owed. NEMA/Affirm are validation examples; the design must also handle unfamiliar billers and incomplete or disputed obligations.

## 2. Connectors first: data access and action access

US-first is the working assumption because the current product centers on US banks, states, taxes, and benefits. International support requires country-specific rails, currency models, rules, and partners.

| Connector | Features unlocked | What it does not establish | Recommended implementation |
|---|---|---|---|
| Bank data: Plaid Transactions or SimpleFIN | Balances, transactions, recurring charges, income detection, budgets, cash forecasts, fee discovery, refund matching | Permission to send money; complete bill statements; authoritative rent due dates | One canonical account/transaction model. Store connection IDs per institution, account IDs, type, currency, pending state, available balance, history coverage, provider errors, and source timestamps. Use incremental sync and correction handling. SimpleFIN is a useful read connector, not a payment rail. |
| Investment data: Plaid Investments or SnapTrade read access | Portfolio aggregation, allocation, fees, dividends, retirement balances | Ability to trade at every connected brokerage | Normalize securities, lots where available, cash, holdings dates, fees, and account ownership. Report unsupported institutions and stale positions. [Plaid Investments](https://plaid.com/docs/investments/) |
| Existing brokerage trading: SnapTrade trading access | User-directed trades, recurring orders, target rebalancing at supported brokers | Universal coverage or discretion to manage investments | Check institution-specific support before showing execution. Default read connections require a separate trading authorization/reconnection. Implement previews, order IDs, partial fills, cancellation, and reconciliation. [Trading](https://docs.snaptrade.com/docs/trading-with-snaptrade), [coverage](https://docs.snaptrade.com/docs/broker-access-guide) |
| Embedded brokerage: Alpaca Broker API | Opening and operating accounts in a partner brokerage program | Trading in a user's unrelated existing accounts | Treat as a separate product choice with account opening, program approval, funding, disclosures, and servicing. [Broker API](https://docs.alpaca.markets/us/docs/about-broker-api) |
| Bank movement/payment partner: candidate Dwolla or an approved Plaid Transfer configuration | Own-account transfers, savings automation, some approved payee flows | Arbitrary consumer payments to any landlord | Obtain provider approval for the exact funds flow. Model sender/recipient funding sources, account validation, limits, returns, cutoffs, mandates, and settlement. [Dwolla integration](https://www.dwolla.com/p/customer-integration-guide/) |
| Debt data/payment partner: candidate Method | Liability discovery, creditor balances, minimums, payments to supported creditors | Generic rent, all lenders, all payment methods | Validate creditor coverage, correct allocation, payoff quotes, returned payments, and borrower authorization. [Method](https://methodfi.com/), [end-user terms](https://methodfi.com/legal/terms-of-service-for-end-users) |
| Landlord/property-manager and biller connector | Exact rent/bill amount, due date, ledger, payee identity, payment receipt | Coverage merely because the bank is connected | Integrate supported portals/partners or verified recipient enrollment. Keep an honest manual handoff for unsupported payees. Never substitute a historical debit for a current invoice. |
| Payroll: candidate Argyle, employer/benefits portals, pay-stub uploads | Paycheck checks, deductions, pay schedules, gig income, deposit switching, match checks | Every employer's support or authorization to change payroll | Institution coverage, hours/rates, gross/net, YTD deductions, employer benefits, explicit change approval, and resulting payroll confirmation. [Argyle FAQ](https://www.argyle.com/faq) |
| Email: Gmail/Outlook with explicit mailbox consent | Bills, trial conversion notices, receipts, refunds, travel credits, documents | Google login is not Gmail access | Purpose-limited ingestion, provenance, document extraction and deletion controls. Gmail read scopes are restricted and server handling can require a security assessment. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) |
| Documents/photos and optional calendar | Leases, EOBs, tax documents, renewal dates, mileage evidence, appointments | A parsed document is not authenticated proof | Encrypted object storage, scanning, structured extraction with confidence, user correction, retention, signed download URLs, and deadline timezone. Calendar is a destination for confirmed deadlines, not the sole source of truth. |
| Merchant sessions/support channels | Cancellation, returns, refunds, negotiations, account changes | Any arbitrary site is safe or automatable | Verified per-merchant adapters, bounded browser sessions, secure credential/session custody, MFA handoff, terms preview, receipts, and post-action checks. Merchant email/call/chat is separately authorized. |
| Credit bureau/report partner | Reports, scores, inquiries, utilization, error discovery | Bank transactions reveal the user's credit score | Permissioned report access, report model/version, inquiry implications, attribution, and dispute handoffs. |
| Insurance/health partners and documents | Policies, renewal comparisons, EOB matching, claims, reimbursement | Generic finance aggregation covers insurance/health accounts | Policy/EOB ingestion plus licensed quote/placement partners where necessary; consent and restricted sharing. |
| Government/program sources and portals | Unclaimed property, benefits, tax, student loans, rebates, assistance | Discovery equals eligibility or a submitted claim | Dated official rules, jurisdiction and identity matching, evidence packets, portal-specific integrations, human signatures/attestations where required, and claim IDs. |
| Commerce/travel/rewards/earning partners | Price checks, return tracking, points, credits, cashback, bonuses, studies, resale | Scraped offers are current or users qualify | SKU/fare/program identity, terms and expiry version, net benefit after fees/taxes, offer freshness, availability, eligibility, disclosure, and outcome tracking. |
| Messaging transport | Incoming requests, proactive alerts, approvals, task updates | A web chat UI is an iMessage service | Verify an actual Apple-supported route and its conversation rules. Apple's iMessage extension framework and Messages for Business are distinct products. SMS/RCS appearing in Messages is a separate transport choice. [iMessage framework](https://developer.apple.com/imessage/), [Messages for Business](https://support.apple.com/en-us/102053), [Twilio channels](https://www.twilio.com/docs/messaging/channels) |

Do not select payment providers by name alone. Plaid's recurring-transfer product supports specified fixed schedules but is not interchangeable with Platform Payments; Platform Payments documentation describes merchant-originator onboarding and a particular platform funds flow. Establish whether the exact consumer-to-landlord use case is supported before building around it. [Recurring transfers](https://plaid.com/docs/transfer/recurring-transfers/), [Platform Payments](https://plaid.com/docs/transfer/platform-payments/), [transfer authorization](https://plaid.com/docs/transfer/creating-transfers/).

Start with bank data, supported investment data, documents/email, a validated messaging channel, and one approved action rail. Build one complete rent or savings flow before adding ten more connector logos. Provider fallback must preserve user ownership and never silently substitute another user's account.

## 3. Findings that must be fixed before financial execution expands

Severity definitions: **P0** blocks handling real customer financial data/actions; **P1** causes wrong financial conclusions or unreliable actions; **P2** limits breadth, usability, maintainability, or scale. Security findings below are static findings, not claims that customer accounts were exploited.

| Priority / finding | Evidence and consequence | Required fix and verification |
|---|---|---|
| P0: bank secret fallback crosses ownership boundaries | `supabase/functions/simplefin-proxy/index.ts:18,38–41` tries a user-specific secret and then the shared legacy `simplefin_access_url`. A user's connection row does not make the fallback secret theirs. | Remove global fallback. Explicitly migrate its verified owner. Missing user secret must fail closed. Test A and B with A's token, B's connection row, and no B token; B gets no A data. |
| P0: writable credential references are trusted by privileged code | `supabase/migrations/20260926_000001_agent_exec.sql:35–64` gives owners `FOR ALL` on credential-reference rows. `agent-exec/index.ts:1147–1162` reads the supplied vault name with service privileges. Stop/delete paths also trust the reference for deletion. | Make secret references server-written; derive and validate the exact user/connection namespace at every read/delete. Test synthetic cross-user reference injection, including stop and account deletion. Never log secret values. |
| P0: approval records are not sufficiently immutable | Same migration gives owner `FOR ALL` access on `exec_approvals`. Row ownership alone does not enforce allowed approval-field edits or status transitions. | Server controls authorization transitions. Bind consent to immutable action, recipient, amount/currency, funding account, constraints, expiry, and payload hash. Test field tampering, replay, stale consent, and stop/execute races. |
| P0: financial local storage is shared across signed-in identities | Unscoped `cfo_*`, holdings, addresses, goals, and agent-memory keys; sign-out paths reload without clearing the financial cache. | Namespace by authenticated user, clear on sign-out/account switch, encrypt/limit retained data, and move durable authoritative state server-side. Test user A→sign out→user B on one device and multiple tabs. |
| P1: deletion can report success despite failure | `src/modules/10-you-extras.js:183–207` ignores function failures and proceeds to the welcome state. `delete-account/index.ts` lacks normal preflight handling and does best-effort cleanup. | Deletion job with visible pending/failed/completed states, checked results, retryable cleanup, provider revocation, billing/session handling, and documented retention. Test preflight, auth failure, DB failure, and partial provider failure; never show “deleted” prematurely. |
| P1: multiple institutions cannot be safely represented by a single token | `supabase/functions/plaid/index.ts:72` uses one Plaid vault name per user. Repeated exchanges target that name. | Credentials belong to a connection/item, not just a user. Link two institutions, sync both, reconnect one, then disconnect one without altering the other. |
| P1: forecasts mix accounts and use an arbitrary balance | `agent-nightly/index.ts:227` and app loop use the first bank account; the app transaction mapping drops account IDs. | Preserve account identity; designate funding accounts; distinguish checking/savings/credit liabilities and available/current balance. Forecast obligations by funding account and currency. Test two checking accounts plus a credit card. |
| P1: real bills are classified away as transfers | Broad `AUTOPAY` filters in `21-track-engines.js` and `33-agent-monitors.js`; Zelle can also represent rent. Reproduction: monthly utility AUTOPAY produces no recurring bill. | Detect own-account transfers through account pairing and evidence, not generic memo words. Preserve real merchant debits, rent, and card-funded expenses; avoid counting both card purchases and card payments as spending. |
| P1: today's liabilities can vanish | `33-agent-monitors.js:261` advances dates while `d <= today`. Reproduction: a $200 bill due today against $250 balance/$100 buffer yields no low-balance warning. | Distinguish paid, pending, unpaid, and overdue obligations. Include due-today unpaid bills; avoid double counting already-posted bills. Test timezone, same-day debits, and an already-low balance. |
| P1: history cannot substantiate annual promises | Bank reads use a 90-day window while subscription discovery and fee audits promise annual coverage. | Retain sufficient normalized history, track gaps, and request supported provider history. Annual recurrence needs more than three months. A partial-year fee total must be labeled partial. Plaid supports up to 24 months subject to availability. [Transactions API](https://plaid.com/docs/api/products/transactions/) |
| P1: cancellation confirmation substitutes today for data freshness | `agent-nightly/index.ts:274` calls `cancelClaimVerdict(..., today, today)` without proving transaction coverage through today. | Carry provider/account covered-through timestamps, error status, receipt and expected next-charge date. No-charge verification remains inconclusive on stale/partial feeds. Test HTTP success with stale data, broken account sync, and charge recurrence. |
| P1: refunds can be claimed twice | `recoveryVerdict` matches by merchant/amount/date without exclusive allocation. Reproduction: one $25 credit resolves two $25 requests. | Allocate a transaction to a recovery ledger atomically; handle partial/provisional refunds and reversals. Test one credit/two requests, split credits, and duplicate webhooks. |
| P1: account context is missing in financial matching | Recurring groups merge merchants across accounts; duplicate/refund matching can ignore funding account. | Canonical transaction IDs, account/currency keys, merchant normalization with confidence, explicit obligation links, and explainable matches. Test identical charges on two family accounts. |
| P1: claim address sources disagree | `08-claim.js:9–10` stores `claim_addresses`, but claim packet construction at line 195 reads `claim_addrs`; nightly search uses narrower profile geography than the UI. | One server-backed residence history model with dates and identity aliases. Shared search cadence and state coverage. Test current plus three prior states and the claim packet's actual address list. |
| P1: net worth omits recorded debt | `25-spec09.js:669` reads `cfo_debt_debts[].balance`; debt tool writes `cfo_debts[].bal`. Connected brokerage positions are not unified into the net-worth calculation. | Canonical assets/liabilities, one valuation date, correct signs, ownership shares, duplicate suppression, and server snapshots. Test a bank account, brokerage, manual asset, mortgage, card debt, and repeated link. |
| P1: debt simulation can imply a false payoff | Debt simulator stops at 600 months without a distinct unpaid outcome; fixed APR ordering does not fully follow promotional APR changes. | Return remaining balance and infeasible/negative-amortization states. Reorder at relevant rate changes; model deferred interest separately. Test payment below interest, minimums above budget, expiring 0%, and exact final payment. |
| P1: tax facts disagree across product surfaces | Server `agent-chat/_shared/finance_facts.ts` labels 2025 bracket endpoints as 2026; UI uses different values. RMD helper clamps ages above 90 to age 90. | One versioned rules package for chat/UI/jobs, official source and effective date. 2026 first bracket boundaries are $12,400/$24,800; Table III age 91 divisor differs from 90. [IRS 2026](https://www.irs.gov/publications/p505), [IRS RMD tables](https://www.irs.gov/publications/p590b). Test all filing statuses, year rollover, ages 90/91/100, and applicable alternate tables. |
| P1: estimates are presented beyond their inputs | Gig estimates, cash yield and retirement simulations omit material variables; some cash aggregation uses unnormalized balance values. | Normalize numeric cents and account types. State covered inputs and assumptions. Tax forecasts need YTD payments, filing status, deductions/credits, state rules and safe-harbor treatment; retirement needs drawdown/inflation/scenario limitations. Do not call illustrative output a complete forecast. |
| P1: execution outcomes can partially commit or race stop | `agent-exec/index.ts:873` completion updates and follow-on ledger/watch writes are not one checked transition. Stop checks cannot retract an already-submitted merchant action. | Versioned compare-and-set transitions, durable evidence/outbox, terminal-state protection, idempotent completion and explicit “submitted before stop” outcome. Test concurrent stop/finish and receipt-write failure. |
| P1: Stripe credits can be duplicated | `stripe-webhook/index.ts:52–72` reads unapplied credits, creates a balance transaction, then marks applied, without a provider idempotency key or atomic claim. | Unique reward obligation, transactional reservation, stable Stripe idempotency key, event dedupe and checked DB result. Verify qualification from actual payment, not merely session completion. Test duplicate/concurrent/out-of-order events and a failure after provider success. |
| P1: no complete messages-to-action path | Web `agent-chat` has guidance/static context, not an authenticated financial tool layer. `AgentIntents.match` returns null for rent payment, VOO purchase, and payday savings requests. No durable inbound/outbound messaging adapter is established. | Shared server orchestrator used by web and messages, verified channel identity, structured tool calls, bounded authorization, outbox, delivery callbacks and task-bound replies. Test ambiguous “yes”, number change, provider replay, delivery failure, and revoked mandates. |
| P1: nightly endpoint is not durable automation | No deployed scheduler wiring is established by the repository. Nightly processes limited batches, focuses on bank/cancellation users, runs sequentially, and does not deliver messages or run recurring payments. Deposit-insurance monitor receives no accounts from main callers. | Real queue/scheduler configuration, pagination, leases, per-user timezone, deadlines, retries, provider timeouts, all-user eligibility and observable delivery. Wire all monitor inputs. Test >500 users, nonbank deadlines, stale sources and missed jobs. |
| P2: export is incomplete and can silently fail | `10-you-extras.js` helper queries `user_id` for profiles, catches errors as empty arrays, and has bounded/unpaged fetches. Local-only state is not a complete server export. | Schema-specific export, pagination, documented inclusion list, machine-readable manifest and errors. Test >1,000 records, profile keyed by `id`, and an unavailable table. |
| P2: UI DOM identifiers collide | `upmore-app-template.html` repeats `agentBody` at 1347/1654 and `agentSheet` at 1548/1651. `getElementById` cannot distinguish the intended surfaces. | Unique IDs and component ownership; dialog semantics/focus management, keyboard operation, accessible status updates. Browser verification remains required. Existing focus-visible/reduced-motion CSS is useful. |
| P2: delivery is heavy and deployment is not reproducible enough | Generated HTML is approximately 8.05 MB, 1.45 MB gzip. No checked-in GitHub CI workflow; DB test harness supplies prerequisite stub tables. Existing build-plan checkboxes and the old connector audit disagree with current code. | Route/data splitting, defer catalogs, size budget, reproducible full-schema migrations, CI build/test/security checks, environment validation, and docs derived from verified behavior. Verify cold-load and offline/update behavior on mobile. |
| P2: operational integrations rely on special infrastructure | Worker references a specific `/home/hatch/workspace/.../sb.py` path; network calls lack consistent bounded timeouts. Literal-IP URL checks alone do not validate DNS/redirect destinations. | Containerize/configure dependencies, validated egress destinations and redirects, deadlines, cancellation, redacted traces and per-provider circuit breakers. Test unavailable helpers, timeout and redirect behavior. |

### Vercel deployment and repository drift

The user confirmed the app is connected to Vercel. This repo's README says production deploys from the separate `srikanthvishnu90-sketch/Upmore` repository, with changes built here and synchronized there. The locally available `Upmore` checkout is at `f5b6987` (September 25); its `index.html`, `sw.js`, template, and SimpleFIN proxy differ from this checkout. It does not contain this checkout's `agent-exec` function or `33-agent-monitors.js`. These are local comparisons, not a claim about the latest remote branch or live Vercel deployment.

`vercel.json` configures clean URLs and asset cache headers; it does not establish a build command, scheduler, or backend deployment. `.vercelignore` excludes only `qa/`. No local Vercel project metadata was found. The authoritative live domain, deployed commit, Vercel project settings, and Supabase deployed function/migration versions were not verified.

**Required deployment contract:** select one release source; run catalog/core/app generation deterministically; publish matching `index.html` and versioned `sw.js`; deploy required Supabase migrations/functions; verify public configuration and server secrets by name without exposing values; then run authenticated smoke tests against the preview environment. Static files hosted by Vercel do not deploy Supabase functions automatically. Avoid a release where the browser expects a newer API/schema than production provides. Compare release manifests containing frontend commit, core version, function versions, migration level and scheduler configuration. Validate OAuth callback domains, CORS, Stripe webhook target, provider redirect URLs and PWA cache upgrades against the actual production origin.

For a static-root deployment, audit the public output allowlist: `.vercelignore` alone does not express an intended public-file boundary for docs, tests, source, worker files and operational artifacts. Verify what Vercel actually serves before treating that as an exposure finding. No production sync, push, or deployment was performed in this audit.

## 4. Rent: the full capability, not just a reminder

Scope clarification from the user: **general bill payment is the first execution workflow**. NEMA Chicago rent and Affirm installments are initial examples, not the boundary of the product. See [the shared bill-payment specification](upmore-bill-payment-spec.md). The common obligation/authorization/payment system must support provider-specific adapters for rent, utilities, cards, loans and BNPL. Connecting bank data alone cannot reveal every future unpaid bill or authorize its repayment.

### Initial connection and setup

1. Verify the messaging identity and associate it with the authenticated user. Collect timezone, preferred name, quiet hours and notification choices.
2. Link bank data. Ask which account funds rent. Connect a supported payment rail separately; verify account ownership and available funds.
3. Import the lease/biller ledger or let the user confirm amount, due day, grace period, recipient, unit/account number, permitted method and fees. A recurring bank debit is a suggestion, not proof of the current lease.
4. Verify the recipient and whether the landlord accepts the proposed method. If unsupported, provide a clearly labeled handoff rather than promising payment.
5. Offer either approval each time or a recurring mandate: named payee, funding account, amount cap, frequency, start/end date, fee cap, buffer and change rules. Store consent text/version and revocation history.

### First payment

“Your $1,800 rent is due October 9. Checking •1234 has $2,460 available as of 8:40 AM. After rent and known bills, the projected buffer is $310. Pay through [supported method] with a $0 fee?” This message is only valid if those are verified facts; otherwise say what is missing.

The reply must bind to a specific proposal. If two proposals are active, “yes” requires disambiguation. Recheck balance freshness, unpaid invoice status, mandate, payee, fee, rail cutoff and earliest expected posting before submission. Approval tomorrow is not approval to pay a changed amount next month.

Create one unique obligation and one payment attempt with an idempotency key. Distinguish `scheduled`, `submitted`, `processing`, `settled`, `applied_to_rent`, `returned`, `failed`, `canceled`, and `unknown`. A provider HTTP 200 is not “rent paid.” Keep the provider transaction ID and biller receipt, reconcile both sides, and report late-arrival risk before the user approves.

### Every subsequent month

Revalidate the invoice and mandate; schedule early enough for the rail's cutoffs; check available balance and competing obligations; respect changed rent, returned payments, revoked consent, disconnected accounts and expired credentials. Notify about the outcome, not every routine intermediate step. If execution is uncertain, investigate the original attempt rather than retrying a second payment blindly. On a return, disclose reversal and unpaid rent and propose the next step.

Required cases: already enabled landlord autopay; roommate pays part; new bank; lease increase; February/31st schedule; bank holiday; late source data; insufficient funds; duplicate webhook; processor timeout after submission; mandate revoked before run; recipient bank change; and biller posts payment to the wrong unit.

This implementation pattern also applies to utilities, debt minimums, savings transfers and recurring investment orders, with domain-specific rails and final confirmation.

## 5. Shared platform that all 256 capabilities depend on

### Authoritative financial model

Use server-owned entities for `connection`, `account`, `transaction`, `security`, `holding`, `tax_lot`, `liability`, `income_stream`, `obligation`, `document`, `claim`, `offer`, `household_share`, and `financial_fact`. Every financial fact needs user/source identity, observed date, effective dates, confidence, freshness and correction history. Store money as integer minor units with currency; never use display strings as arithmetic inputs. Pending transactions can become posted transactions or disappear; corrections must update derived facts without duplicating money.

Separate spendable cash from assets, credit limits and liabilities. Keep own-account transfers neutral, expenses recorded once, refunds allocated once, and manual entries marked as such. Persist history and snapshots server-side. A partial connection should produce a partial answer with visible coverage.

### Durable memory and personalization

Current agent memory is primarily local structured facts/dismissals, not a persistent complete financial model. Store explicit preferences and inferred facts separately: rent, pay schedules, buffer, goals, tax situation, risk preferences, never-sell holdings, trusted payees, household permissions and past task outcomes. Let users inspect, correct and forget them. Resolve conflicts by source authority and recency, not by whichever chat message appeared last.

Every proactive alert needs a trigger, monetary relevance, confidence, freshness, deadline, suggested next action and dedupe key. Quiet hours, urgency overrides, household privacy and snoozes matter. Measure useful outcomes and notification fatigue. “Personalized” means the right account, obligation and constraints affected the recommendation, not merely inserting a first name.

### Action and authorization model

`task → proposal → authorization/mandate → attempt → external event → reconciliation → evidence → outcome`

Implement a separate adapter contract for each rail: supported actions, required inputs, preview, authorization checks, idempotent submit, status, cancel if supported, reconcile, and evidence. Transactional outbox/inbox handles retries and webhooks. Leases prevent concurrent workers. Unknown outcomes remain unknown until reconciled. Stop prevents future actions where possible and clearly reports any action already irreversibly submitted.

Treat recurring authorization as bounded permission, not “the agent may manage all money.” New recipient, changed amount beyond limit, new fee, risky trade, changed terms and expired permission require the appropriate new authorization. Domain restrictions in `userAct` and the policy catalog remain enforced server-side.

### Messaging and security

Validate the actual iMessage integration path before promising blue-bubble automation. Transport adapters need verified inbound signatures, message dedupe, durable conversation/task IDs, delivery status, opt-out, quiet hours and attachments. Phone numbers are not permanent proof of financial-account identity. Sensitive documents and high-risk approvals can use short-lived authenticated links. Treat inbound emails/documents/sites as data; they cannot override user authorization or redirect funds.

Credential ownership, access policies, secret-reference integrity, recovery access, audit trails, encrypted storage and deletion are launch dependencies. Track provider health and degraded coverage. Product support must see task IDs and redacted evidence, not unrestricted banking secrets.

## 6. Feature coverage and genuine gaps beyond the catalog

The companion matrix reviews each catalog capability individually. The catalog is already broad; the missing depth is often data, exact rule logic, execution, and proof. Add explicit platform capabilities that the registry does not sufficiently expose:

- Connection repair, multi-institution linking, source freshness, history coverage, currency/ownership normalization and account retirement.
- Current versus pending balances, upcoming versus paid obligations, charge corrections, transaction categorization overrides, unmatched-data review and accounting reconciliation.
- Recurring mandate creation/change/revocation, account/payee verification, fee previews, payment cutoffs, returns, reversals, duplicate protection and unknown-outcome resolution.
- Task-specific message approvals, secure identity recovery, channel changes, quiet hours, delivery failure recovery and accessible handoff.
- Document confidence/correction, rule-version updates, tax-year rollover, evidence provenance and household sharing/revocation.
- Notification dedupe, outcome measurement, saved-versus-potential money accounting, user-visible incident handling and complete portability/deletion.

## 7. Evidence and verification limits

Tests ran in an isolated copy so generated files did not overwrite this checkout. Build succeeded. Unit suites passed: drafts 13, intents 8, ledger 7, monitors 44, policy 39, plus investment-engine checks. Agent100 validator accepted 100 cases; the dry run reported 103/103 cases. Its 334 step results include 321 executed and 13 skipped backend steps, with **zero API calls**. Dry guide/static/calculation checks do not verify payment, messaging, cancellation, trading, or real provider integration.

Baseline database tests passed with a temporary PostgreSQL instance after locale/shared-memory setup. These exercise the foundation/exec migrations against harness stubs; they do not certify the complete deployed schema or the isolation issues above. Deno type checks passed for stop/nightly functions. No available browser could be attached, so visual layout, real keyboard flow, screen-reader behavior, mobile usability, OAuth popups and live browser tasks remain unverified.

Targeted deterministic checks reproduced: unhandled rent/trade/savings intents; AUTOPAY excluded from recurring bills; due-today forecast omission; cancellation confirmation dependent on supplied coverage; and duplicate allocation of a refund credit. Other findings are identified from code paths and schema, with proposed tests explicitly distinguished from tests already run.

## 8. Build order and release gates

| Stage | Concrete deliverable | Exit gate |
|---|---|---|
| A: trustworthy foundation | Fix ownership/approval/deletion/cache issues; canonical multi-account model; versioned rules; migrations and CI | Tenant-isolation and approval-tampering tests pass; complete clean deployment; no silent data substitution; account switch/export/delete verified |
| B: real understanding | Correct bills/recurrence, income, debts, net worth, fresh cash forecast, refund tracking | Account-specific fixture truth sets, pending/posted correction, partial-history labeling, multi-source reconciliation and financial edge cases pass |
| C: messages and memory | Validated channel, shared orchestrator, server memory, proactive event queue, bounded proposal replies | Inbound/outbound/replay/opt-out/delivery failure tests; explainable personalized alerts; user correction and consent revocation work |
| D: general bill-payment foundation | Shared obligation/payment engine with NEMA Chicago rent and Affirm as initial adapter targets; supported execution methods validated independently | Sandbox then supervised supported real flow; correct bill/loan allocation, autopay collision protection, idempotency, timeout, returns, stop and final receipts tested |
| E: recovery and merchant depth | Verified cancellations and selected disputes/refunds/claims | Per-merchant/provider supervised verification, honest handoffs, exclusive refund allocation and measured recovered outcomes |
| F: investing, payroll, health and breadth | Add domain adapters and exact rules feature by feature | Each matrix acceptance criterion passes within declared coverage; appropriate partner/program approvals; no unsupported automatic action |

No schedule estimate is credible without provider contracts, team capacity and the chosen initial supported market. Complete stages by evidence, not by checking catalog boxes.

## 9. A usable 100-point rubric

| Dimension | Points | Evidence needed for full credit |
|---|---:|---|
| Data coverage and financial correctness | 20 | Multi-account, complete disclosed coverage, accurate arithmetic/rules, freshness, corrections and reconciliation |
| Authorized reliable execution | 20 | Supported rails, scoped mandates, idempotency, returns, race handling, receipts and verified outcomes |
| Personalization and proactive messages | 15 | Durable correct memory, relevant event triggers, reliable delivery, bounded replies and user controls |
| Capability depth within declared coverage | 15 | Each shipped feature meets its individual matrix criterion; prepare/read/execute coverage is truthful |
| Security, identity and privacy | 15 | Isolation, tamper resistance, secret custody, deletion/export, household permissions and recovery |
| Reliability, observability and deployment | 10 | Reproducible deploy, CI, queues, retries, provider degradation, paging and incident diagnosis |
| Usability and accessibility | 5 | Clear connection/approval/outcome states, mobile performance, keyboard/screen-reader and live-flow checks |
| **Total** | **100** | A measured release assessment, not a promise of universal financial automation |

Any unresolved P0 finding blocks launch of affected handling/actions regardless of the numeric score. For an initial release, publish a narrow supported matrix and execute those jobs completely. A later broad release must actually validate the additional domains; deleting them from the promises does not make them implemented.
