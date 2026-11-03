> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# Upmore: all 256 capability contracts

Companion to [the top-to-bottom audit](upmore-capability-audit.md). Generated from the current catalog plus individually authored acceptance criteria on October 8, 2026. These criteria are proposed requirements, not assertions that tests already passed.

**How to read this:** “Current” is the `AGENT_BUILD` declaration, defaulting to planned. It is not a live verification grade. Each area specifies its required data connectors and action rails; each feature adds a distinct implementation/acceptance contract. A read-only feature needs correct inputs, rule logic and evidence; a prepare feature needs a complete reviewed draft; an executing feature additionally needs consent, idempotency, reconciliation and a receipt. Every feature inherits tenant isolation, freshness, coverage, user correction, and safe failure requirements from the main audit.

Declared counts: gated: 8, live: 1, planned: 190, prepare: 23, read: 34. All 30 cancellation merchant playbooks remain unverified; the live cancellation declaration does not mean merchant execution is available.

**Release rule:** publish supported institutions/providers, jurisdiction, history coverage and read/prepare/execute mode. Unsupported connectors must yield an honest limitation or handoff. A deep link is not submission, an application is not approval, a payment request is not payment, and expected savings are not confirmed savings.

## Income and pay (12 capabilities)

**Data/connectors required:** Payroll connector, pay stubs, employer plan documents, bank deposits; official dated wage/tax rules.

**Execution/handoff required:** Payroll/employer adapter for changes; reviewed document handoff where signatures are required.

### `income.paycheck_check` — Paycheck check

**Current:** planned. **Promised behavior:** Compares every paycheck to expected hours, rate and deductions; flags shortfalls.

**Build and accept only when:** Reconcile gross hours, overtime, rate, deductions and net deposit; test a split deposit, unpaid hours, changed rate and payroll correction without calling every deposit a paycheck.

### `income.pay_stub_reader` — Pay stub reader

**Current:** planned. **Promised behavior:** Explains every line of a pay stub in plain words.

**Build and accept only when:** Extract employer, pay period, gross/net, YTD and each deduction with document confidence; a blurry number must require correction before arithmetic or advice uses it.

### `income.withholding_tune_up` — Withholding tune-up

**Current:** planned. **Promised behavior:** Works out the right W-4 and shows the effect on the next check.

**Build and accept only when:** Use filing status, dependents, spouse/jobs, YTD withholding and remaining payroll periods; test midyear job changes and show a reviewed W-4 draft rather than silently submitting it.

**Boundary:** User submits required documents/actions; do not substitute agent consent; Year-stamped figures.

### `income.direct_deposit_split` — Direct deposit split

**Current:** planned. **Promised behavior:** Sets a percentage of pay to go straight to savings.

**Build and accept only when:** Read existing allocation, validate destination ownership, preview fixed/percentage remainder and confirm employer acceptance; test a rejected change and the first actual split paycheck.

**Boundary:** Employer portal.

### `income.income_smoothing` — Income smoothing

**Current:** planned. **Promised behavior:** Turns irregular pay into a steady weekly amount from a buffer.

**Build and accept only when:** Separate volatile income from transfers and set a reserve-funded allowance; test zero-income weeks, insufficient reserve and duplicate payout events without overdrawing.

**Boundary:** Your own accounts only.

### `income.early_pay_finder` — Early pay finder

**Current:** planned. **Promised behavior:** Flags accounts that release direct deposits early.

**Build and accept only when:** Compare dated account terms and eligible payroll timing; distinguish early availability from earned-wage loans and do not guarantee a payday the bank does not guarantee.

### `income.raise_benchmark` — Raise benchmark

**Current:** planned. **Promised behavior:** Published pay ranges for your role and city.

**Build and accept only when:** Match occupation, geography, seniority and compensation type to dated sourced ranges; reject comparisons mixing annual salary with hourly/contract gross pay.

**Boundary:** Sourced ranges only.

### `income.raise_case_builder` — Raise case builder

**Current:** planned. **Promised behavior:** Drafts the ask with the numbers behind it.

**Build and accept only when:** Combine a user's confirmed achievements with comparable pay and requested compensation; test unknown achievements so the draft invents no performance evidence.

### `income.wage_check` — Wage check

**Current:** planned. **Promised behavior:** Flags possible unpaid overtime or below-minimum pay against state rules.

**Build and accept only when:** Evaluate jurisdiction, worker classification, hours, exemptions and effective rule date; surface potential discrepancies with an official source and test interstate and overtime edge cases.

**Boundary:** Points to the state labor office; not legal advice.

### `income.final_paycheck_tracker` — Final paycheck tracker

**Current:** planned. **Promised behavior:** Tracks the legal deadline for final pay after leaving a job.

**Build and accept only when:** Record separation date/type and applicable jurisdiction; test weekend deadlines and disputed facts, with dated official rules and overdue reminders.

**Boundary:** State-specific.

### `income.unemployment_prep` — Unemployment prep

**Current:** planned. **Promised behavior:** Checks eligibility, gathers documents, reminds weekly certifications.

**Build and accept only when:** Collect work history, separation facts and relevant program documents; flag missing evidence, track certifications, and require the user to review/sign truthful attestations.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Sworn.

### `income.tip_and_cash_income_log` — Tip and cash income log

**Current:** planned. **Promised behavior:** Records income that never hits a bank.

**Build and accept only when:** Capture amount/date/source and corrections without inventing bank transactions; reconcile deposits of already-recorded cash so taxable income is not doubled.

## Self-employed and gig (10 capabilities)

**Data/connectors required:** Payroll/gig-platform APIs, Stripe/PayPal records, invoices, receipts, location consent, bank data and versioned tax rules.

**Execution/handoff required:** Authorized invoice/email adapter, approved own-account transfer rail, supported official tax-payment workflow.

### `gig.income_consolidation` — Income consolidation

**Current:** planned. **Promised behavior:** One view of Uber, DoorDash, Upwork, Stripe, PayPal and other payouts.

**Build and accept only when:** Reconcile platform gross earnings, fees, refunds and bank payouts with stable IDs; test delayed combined payouts and transfers between PayPal and checking without doubling income.

**Boundary:** Aggregator coverage.

### `gig.invoicing` — Invoicing

**Current:** planned. **Promised behavior:** Creates and sends invoices.

**Build and accept only when:** Create an invoice with client, line items, due date, taxes and payment instructions; verify authorized sending and track draft/sent/paid/void states with duplicate-send protection.

### `gig.invoice_chasing` — Invoice chasing

**Current:** planned. **Promised behavior:** Follows up at 7, 30 and 60 days late.

**Build and accept only when:** Schedule consented reminders only on unpaid balances; test partial payment, disputed invoice and client reply so reminders stop or adjust appropriately.

**Boundary:** Collecting your own money only.

### `gig.expense_categorisation` — Expense categorisation

**Current:** planned. **Promised behavior:** Separates business costs from personal.

**Build and accept only when:** Retain receipt and user-confirmed business purpose; test mixed-use purchases, reimbursement and recategorization without asserting deductibility from a merchant name alone.

### `gig.mileage_log` — Mileage log

**Current:** planned. **Promised behavior:** Builds a deductible mileage record from trips.

**Build and accept only when:** Record trip time, distance, business purpose and manual corrections under location consent; test personal detours and duplicate imports and produce a reviewable log.

**Boundary:** Location permission.

### `gig.tax_set_aside` — Tax set-aside

**Current:** planned. **Promised behavior:** Moves a set share of each payout to a tax bucket.

**Build and accept only when:** Calculate a bounded reserve from eligible net payouts and existing reserves; test reversed earnings and replayed payout events with one own-account transfer per trigger.

**Boundary:** Your own accounts.

### `gig.quarterly_estimates` — Quarterly estimates

**Current:** planned. **Promised behavior:** Calculates estimated tax and puts the deadlines on the Due tab.

**Build and accept only when:** Combine self-employment profit, other income, deductions, withholding and prior-year safe-harbor inputs; test uneven income and a changed tax year, with federal/state deadlines separated.

### `gig.estimated_tax_payment` — Estimated tax payment

**Current:** planned. **Promised behavior:** Pays the IRS through its own payment system.

**Build and accept only when:** Confirm year, jurisdiction, amount and taxpayer/payment identity through a supported official/partner method; reconcile confirmation and bank debit without submitting an uncertain attempt twice.

**Boundary:** Your bank, IRS rails.

### `gig.1099_reconciliation` — 1099 reconciliation

**Current:** planned. **Promised behavior:** Matches 1099s to payouts received and flags gaps.

**Build and accept only when:** Compare forms by payer/year to gross underlying earnings rather than net deposits; test fees, amended forms and multi-platform duplicates while preserving unexplained differences.

### `gig.freelance_rate_check` — Freelance rate check

**Current:** planned. **Promised behavior:** Published rate ranges for the work.

**Build and accept only when:** Normalize project scope, hours, fees, geography and utilization; show dated ranges and effective take-home rather than equating a posted hourly rate with annual income.

## Bills (12 capabilities)

**Data/connectors required:** Biller/property-manager statements and ledger, bank/card data, lease, payroll dates and verified recipient records.

**Execution/handoff required:** Approved bill-payment rail and biller adapters; rental reporting/request partners where supported.

### `bills.bill_calendar` — Bill calendar

**Current:** read. **Promised behavior:** Every bill, its due date and usual amount in one timeline.

**Build and accept only when:** Merge statement due dates with inferred recurrence but label the latter; test changed utility amounts, autopay, annual bills, overdue balances and a payment already posted today.

### `bills.bill_pay` — Bill pay

**Current:** gated. **Promised behavior:** Pays bills from your own card or bank.

**Build and accept only when:** Bind an unpaid invoice to a verified payee/funding account, preview fees and arrival, submit idempotently and reconcile biller application; test returns, timeout and duplicate external autopay.

**Boundary:** Partner rails; never holds funds; Current declared rail: Agent card rails; Current gate: A card-network agent program (Visa Intelligent Commerce or Mastercard Agent Pay).

### `bills.autopay_setup` — Autopay setup

**Current:** planned. **Promised behavior:** Turns on autopay at the biller.

**Build and accept only when:** Read current biller settings and preview method/date/amount rules; confirm setup from the biller and test two overlapping autopays or an expired card.

**Boundary:** Biller portal.

### `bills.due_date_alignment` — Due-date alignment

**Current:** planned. **Promised behavior:** Moves due dates to land after payday.

**Build and accept only when:** Compare allowed biller dates to real payroll cadence; disclose transition-period effects and verify the new statement date rather than changing the local calendar alone.

**Boundary:** Biller settings.

### `bills.bill_spike_explainer` — Bill spike explainer

**Current:** read. **Promised behavior:** Explains why a bill jumped, from usage and rate history.

**Build and accept only when:** Compare usage, tariff, taxes and one-time charges from statements; test a higher total with unchanged usage and a changed billing period without inventing the cause.

### `bills.budget_billing` — Budget billing

**Current:** planned. **Promised behavior:** Enrols utilities in level monthly billing.

**Build and accept only when:** Check utility eligibility, true-up terms and projected cost; require enrollment approval and test that level billing does not incorrectly count as a permanent discount.

### `bills.bill_negotiation` — Bill negotiation

**Current:** prepare. **Promised behavior:** Calls or chats retention lines for a lower rate.

**Build and accept only when:** Use contract, promo expiry and user-approved acceptable terms; preserve a transcript and confirm new rate, duration and commitments, including a refused offer.

**Boundary:** AI disclosure, all-party recording consent; Current declared rail: Drafted script.

### `bills.late_fee_waiver` — Late fee waiver

**Current:** prepare. **Promised behavior:** Asks the biller to reverse a late fee.

**Build and accept only when:** Tie request to a specific assessed fee and reason; verify a posted reversal separately from support agreeing to consider it, including partial waivers.

**Boundary:** Current declared rail: Drafted message.

### `bills.payment_confirmation` — Payment confirmation

**Current:** read. **Promised behavior:** Confirms every payment posted and was applied.

**Build and accept only when:** Match bank settlement and biller application to the right invoice; test one bank debit covering two invoices, misapplied payments and returns.

### `bills.double_payment_guard` — Double-payment guard

**Current:** read. **Promised behavior:** Blocks paying the same bill twice.

**Build and accept only when:** Maintain unique obligation/payment linkage across manual, agent and biller-autopay attempts; test concurrent workers and a payment pending outside Upmore.

### `bills.rent_reporting` — Rent reporting

**Current:** planned. **Promised behavior:** Reports on-time rent to credit bureaus.

**Build and accept only when:** Obtain landlord/user verification and bureau-partner consent; show supported reporting scope/fees and verify acceptance, with disputed or late rent handled accurately.

**Boundary:** Reporting partner.

### `bills.roommate_split` — Roommate split

**Current:** planned. **Promised behavior:** Splits shared bills and sends payment requests.

**Build and accept only when:** Allocate a shared bill using confirmed proportions and authorized recipients; send request links without taking others' money and reconcile partial payments without treating a request as paid.

**Boundary:** Request link only; no money held.

## Subscriptions (13 capabilities)

**Data/connectors required:** Bank recurring charges, mailbox notices, merchant subscription/account data and usage confirmed by the user.

**Execution/handoff required:** Verified merchant adapters and secure sessions; platform-specific manual handoff when automation is unsupported.

### `subscriptions.subscription_finder` — Subscription finder

**Current:** read. **Promised behavior:** Finds every recurring charge across all accounts.

**Build and accept only when:** Group account-specific recurring charges and email contracts over disclosed history; test annual subscriptions, utility AUTOPAY, card replacement and two same-merchant subscriptions.

**Boundary:** Annual ones need 13 months of history.

### `subscriptions.cancel` — Cancel

**Current:** live. **Promised behavior:** Cancels and confirms no further charge.

**Build and accept only when:** Require a verified merchant adapter, exact subscription/account and authorized terms; capture cancellation effective date/receipt and test stale feeds, final invoices and renewed charges.

**Boundary:** Merchant terms, credential vault; Current declared rail: Browser session.

### `subscriptions.pause` — Pause

**Current:** planned. **Promised behavior:** Pauses instead of cancelling where offered.

**Build and accept only when:** Read permitted pause duration and restart terms; verify merchant acceptance, schedule restart notice and test a pause that preserves charges or affects access immediately.

### `subscriptions.downgrade` — Downgrade

**Current:** planned. **Promised behavior:** Moves to a cheaper tier.

**Build and accept only when:** Preview lost features, new rate and effective date; confirm the exact plan and next invoice, including prorations and rejected changes.

### `subscriptions.trial_guard` — Trial guard

**Current:** prepare. **Promised behavior:** Cancels trials before they convert unless you say keep.

**Build and accept only when:** Read the actual conversion deadline/timezone and cancellation cutoff; require a trial-specific mandate and test MFA failure and a user choosing keep before the deadline.

**Boundary:** Current declared rail: Drafted steps.

### `subscriptions.overlap_finder` — Overlap finder

**Current:** read. **Promised behavior:** Flags paying for three services that do the same job.

**Build and accept only when:** Compare service functions and household use without assuming duplicates are unwanted; show costs and let users mark intentional overlap so it stays dismissed appropriately.

### `subscriptions.rotation` — Rotation

**Current:** planned. **Promised behavior:** Keeps one streaming service at a time and swaps monthly.

**Build and accept only when:** Use a chosen service schedule and verified cancel/reactivate capabilities; test renewal overlap and content/access tradeoffs, and never claim savings if both remain billed.

### `subscriptions.annual_switch` — Annual switch

**Current:** planned. **Promised behavior:** Switches to annual billing when it's cheaper and used all year.

**Build and accept only when:** Compare total cost, usage history, refundability and liquidity; require one-time approval and test a discounted annual plan with penalties or low expected use.

**Boundary:** Only with usage history.

### `subscriptions.discount_switch` — Discount switch

**Current:** planned. **Promised behavior:** Moves to student or assistance-program pricing you qualify for.

**Build and accept only when:** Verify student/benefit eligibility through supported evidence; do not fabricate status, and verify the merchant's discounted invoice and expiry.

**Boundary:** Eligibility proof.

### `subscriptions.family_plan_merge` — Family plan merge

**Current:** planned. **Promised behavior:** Combines separate plans into one shared plan.

**Build and accept only when:** Obtain each affected member's consent and read household rules; test existing annual subscriptions and lost benefits so merging does not cause surprise charges.

**Boundary:** Other people's consent.

### `subscriptions.price_rise_alert` — Price rise alert

**Current:** read. **Promised behavior:** Flags silent price increases.

**Build and accept only when:** Distinguish plan/usage/currency changes from a merchant rate rise using notices and bills; test a tax change and a one-time fee.

### `subscriptions.prorated_refund` — Prorated refund

**Current:** prepare. **Promised behavior:** Requests a refund for the unused part of a cancelled plan.

**Build and accept only when:** Calculate only a supported policy-based request for unused service; track approval and allocated posted credit separately, including nonrefundable annual terms.

**Boundary:** Current declared rail: Drafted message.

### `subscriptions.app_store_subscriptions` — App-store subscriptions

**Current:** prepare. **Promised behavior:** Deep-links to Apple or Google subscription settings.

**Build and accept only when:** Identify the billing platform and provide the correct subscription settings handoff; test Apple-billed versus directly billed plans and report completion only with evidence.

**Boundary:** Platforms block third-party cancels; Current declared rail: Deep link.

## Shopping (15 capabilities)

**Data/connectors required:** Receipts/email/photos, exact product catalogs, retailer policy/offer APIs, carrier tracking and card benefit guides.

**Execution/handoff required:** Retailer/order/return adapters, authorized payment checkout, approved marketplaces and issuer claim workflows.

### `shopping.price_check` — Price check

**Current:** planned. **Promised behavior:** Compares a price across retailers before you buy.

**Build and accept only when:** Match exact SKU, quantity, shipping, taxes, seller quality and availability; test a cheaper different model and disclose commercial ranking incentives.

**Boundary:** Show cheapest even if unpaid.

### `shopping.price_watch` — Price watch

**Current:** planned. **Promised behavior:** Tracks an item and buys when it hits a target price.

**Build and accept only when:** Store item, maximum all-in price, seller and expiry; distinguish alert-only from purchase authorization and test price change between preview and checkout.

**Boundary:** New merchant is always T2.

### `shopping.price_adjustment` — Price adjustment

**Current:** planned. **Promised behavior:** Claims the difference when a price drops inside the window.

**Build and accept only when:** Retain original receipt and merchant policy version/deadline; match the same SKU and verify actual credit, including excluded sale items.

**Boundary:** Merchant policy.

### `shopping.cashback_activation` — Cashback activation

**Current:** planned. **Promised behavior:** Applies cashback portals and card offers at checkout.

**Build and accept only when:** Check offer eligibility, merchant restrictions and activation state; show disclosure, avoid incompatible stacking and reconcile pending versus paid rewards.

**Boundary:** Affiliate disclosure on the card.

### `shopping.promo_codes` — Promo codes

**Current:** planned. **Promised behavior:** Finds and applies valid codes.

**Build and accept only when:** Validate code on the actual basket and terms; test expired codes, minimum spend and a code that removes a larger existing discount.

### `shopping.reorders` — Reorders

**Current:** planned. **Promised behavior:** Rebuys routine items on schedule.

**Build and accept only when:** Bind exact item/quantity/destination and maximum total to a recurring mandate; test substitution, price rise and an already-placed order.

**Boundary:** Exact repeats only.

### `shopping.cheaper_equivalent` — Cheaper equivalent

**Current:** planned. **Promised behavior:** Finds the same recurring item cheaper or in a better size.

**Build and accept only when:** Compare unit pricing and genuinely identical items with delivery costs; obtain approval for changed pack size and test expiry/waste effects.

**Boundary:** Only identical items.

### `shopping.receipt_vault` — Receipt vault

**Current:** planned. **Promised behavior:** Collects receipts from email and photos.

**Build and accept only when:** Extract merchant, date, line items and totals from email/photos with provenance; test duplicated forwarded receipts and sensitive unrelated email content.

**Boundary:** Email scope rules.

### `shopping.returns` — Returns

**Current:** planned. **Promised behavior:** Starts returns inside the window and tracks the refund.

**Build and accept only when:** Track merchant window, label, dropoff/shipping and refund; test receipt-only initiation, missed dropoff and a returned item with no credit yet.

### `shopping.warranty_registration` — Warranty registration

**Current:** planned. **Promised behavior:** Registers products and stores warranty terms.

**Build and accept only when:** Identify serial number, product, owner and warranty term; confirm successful registration without enrolling in unrelated marketing or paid protection.

### `shopping.card_protection_claims` — Card protection claims

**Current:** planned. **Promised behavior:** Files purchase protection and extended warranty claims through the card.

**Build and accept only when:** Match purchase, card benefits effective on purchase date and required evidence; track claim ID and adjudication rather than promising reimbursement.

**Boundary:** Documentation.

### `shopping.lost_package_claims` — Lost package claims

**Current:** planned. **Promised behavior:** Files claims for late, lost or damaged deliveries.

**Build and accept only when:** Use tracking, delivery evidence and merchant/carrier policy; test merchant replacement versus refund and avoid duplicate compensation claims.

### `shopping.gift_card_tracker` — Gift card tracker

**Current:** planned. **Promised behavior:** Tracks balances and spends them before they expire.

**Build and accept only when:** Capture verified balance and relevant terms with masked credentials; test partial spend and a stale balance without treating estimates as cash available in checking.

### `shopping.resell` — Resell

**Current:** planned. **Promised behavior:** Lists unused items on marketplaces.

**Build and accept only when:** Confirm ownership, item condition, minimum proceeds and marketplace fees; require listing approval and track sale, shipping, dispute and payout separately.

**Boundary:** You ship.

### `shopping.big_purchase_check` — Big purchase check

**Current:** planned. **Promised behavior:** Runs the purchase against safe-to-spend before buying.

**Build and accept only when:** Use current account-specific cash forecast, obligations and user buffer; test a stale bank feed, financing offer and upcoming annual bill before asserting affordability.

## Travel and points (10 capabilities)

**Data/connectors required:** Loyalty/booking accounts, itineraries, fare/award inventory, carrier terms, travel credits and card benefit guides.

**Execution/handoff required:** Supported booking/loyalty/carrier claim adapters; user-approved rebooking with cancellation safeguards.

### `travel.points_balances` — Points balances

**Current:** planned. **Promised behavior:** One view of every airline, hotel and card program.

**Build and accept only when:** Read supported program statements/accounts and currencies; test household versus individual ownership and avoid adding unlike points as one spendable balance.

### `travel.expiring_points` — Expiring points

**Current:** planned. **Promised behavior:** Warns before points or miles expire.

**Build and accept only when:** Use each program's current expiration/activity rules and actual last eligible activity; test a redemption that does not reset expiry.

### `travel.best_redemption` — Best redemption

**Current:** planned. **Promised behavior:** Finds the highest-value use of points for a trip.

**Build and accept only when:** Compare available award inventory, cash fare, taxes, fees and transfer terms; test nonrefundable transfers and show valuation assumptions rather than universal cents-per-point.

### `travel.fare_watch_and_rebook` — Fare watch and rebook

**Current:** planned. **Promised behavior:** Rebooks when a fare drops and captures the credit.

**Build and accept only when:** Verify fare rules, ticket ownership, credit/refund terms and itinerary equivalence; test cancellation before replacement confirmation and duplicate bookings.

**Boundary:** Only on refundable or credit-back fares.

### `travel.hotel_rebook` — Hotel rebook

**Current:** planned. **Promised behavior:** Rebooks refundable stays when the price drops.

**Build and accept only when:** Check refundable deadline/timezone, room type and cancellation penalties; secure replacement before authorized cancellation and verify both reservation states.

### `travel.travel_credits` — Travel credits

**Current:** planned. **Promised behavior:** Tracks airline credits and their expiry.

**Build and accept only when:** Store passenger restrictions, voucher number, currency and travel-by versus book-by date; test partially used credits and a nontransferable family member's credit.

### `travel.delay_compensation` — Delay compensation

**Current:** planned. **Promised behavior:** Files claims for delays and cancellations.

**Build and accept only when:** Match carrier/jurisdiction, disruption cause and policy dates to evidence; require accurate user attestations and track claim decision and actual payout.

**Boundary:** Rules differ by carrier and region.

### `travel.card_travel_coverage` — Card travel coverage

**Current:** planned. **Promised behavior:** Explains the rental car, trip delay and baggage cover your cards include.

**Build and accept only when:** Read the applicable benefit guide and purchase/payment requirements; test secondary versus primary coverage and exclusions without implying guaranteed coverage.

### `travel.foreign_fee_avoidance` — Foreign fee avoidance

**Current:** planned. **Promised behavior:** Picks the card with no foreign transaction fee for a trip.

**Build and accept only when:** Use card fee schedule, acceptance and currency rules; test dynamic currency conversion and ATM costs separately from foreign transaction fees.

### `travel.trip_budget` — Trip budget

**Current:** planned. **Promised behavior:** Plans and tracks spending for a trip.

**Build and accept only when:** Plan transport/lodging/daily costs in currency-aware scenarios; reconcile actual spend and refunds without double counting prepaid bookings.

## Money recovery (20 capabilities)

**Data/connectors required:** Official property/settlement/recall portals, residence history, identity documents, receipts, bank credits and domain evidence.

**Execution/handoff required:** Portal-specific claim/dispute adapters, issuer/merchant support and authenticated user review/signature handoffs.

### `recovery.unclaimed_property_search` — Unclaimed property search

**Current:** prepare. **Promised behavior:** Searches every state lived in plus federal sources, quarterly.

**Build and accept only when:** Search current and prior residence states with name aliases and official source links; disambiguate same-name matches and track quarterly searches without claiming ownership automatically.

**Boundary:** Must stay free; Current declared rail: State databases.

### `recovery.unclaimed_property_claim` — Unclaimed property claim

**Current:** prepare. **Promised behavior:** Fills the claim and gathers the documents.

**Build and accept only when:** Build a complete claim-specific evidence packet from the same residence history; user signs required attestations, and submission requires an official claim ID/status.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Finder law; sworn; Current declared rail: State claim portal.

### `recovery.forgotten_accounts` — Forgotten accounts

**Current:** planned. **Promised behavior:** Finds old bank, brokerage and retirement accounts.

**Build and accept only when:** Use user-supplied institutions, statements and supported registries; distinguish possible leads from verified owned accounts and never reveal another person's records.

### `recovery.old_401_k_finder` — Old 401(k) finder

**Current:** planned. **Promised behavior:** Locates retirement money left at past employers.

**Build and accept only when:** Collect prior employers, dates and plan administrators; follow official plan sources and confirm participant ownership before adding balances or initiating a rollover.

### `recovery.escheated_wages` — Escheated wages

**Current:** planned. **Promised behavior:** Recovers unpaid final pay sent to the state.

**Build and accept only when:** Match employer/pay period and state property records to the user's identity; distinguish an unpaid wage demand from already-escheated property and track the actual payment.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Sworn.

### `recovery.duplicate_charge_dispute` — Duplicate charge dispute

**Current:** prepare. **Promised behavior:** Disputes double charges through the card or bank.

**Build and accept only when:** Compare same-account posted charges, not pending/posted versions or legitimate repeated purchases; prepare truthful evidence, track provisional credit and final disposition.

**Boundary:** 60-day window; Current declared rail: Drafted dispute.

### `recovery.services_not_delivered` — Services not delivered

**Current:** prepare. **Promised behavior:** Disputes charges for things that never arrived or were cancelled.

**Build and accept only when:** Collect order/service terms, attempts to resolve and issuer deadline; track dispute stages and reversals and prevent simultaneous unsupported merchant/issuer claims.

**Boundary:** Your account of events; Current declared rail: Drafted dispute.

### `recovery.bank_fee_reversal` — Bank fee reversal

**Current:** prepare. **Promised behavior:** Asks the bank to reverse overdraft and maintenance fees.

**Build and accept only when:** Tie a truthful request to exact posted fees and policy; count saved money only after credit allocation, including a partial credit and a denied waiver.

**Boundary:** Current declared rail: Drafted message.

### `recovery.settlement_matching` — Settlement matching

**Current:** planned. **Promised behavior:** Finds class actions you may qualify for from purchase history.

**Build and accept only when:** Match purchase dates/products/jurisdiction to current official class definitions; label uncertain eligibility and ignore stale or unofficial claim offers.

### `recovery.settlement_claim` — Settlement claim

**Current:** planned. **Promised behavior:** Prepares the claim with evidence.

**Build and accept only when:** Populate only supported facts, surface sworn statements for user review/signature and track official submission/decision/payment independently.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Perjury attestation; never bulk.

### `recovery.security_deposit` — Security deposit

**Current:** prepare. **Promised behavior:** Drafts the demand citing local deposit rules.

**Build and accept only when:** Use lease, move-out date, deductions and current local rules; prepare a sourced demand and track partial returns, disputes and deadlines without manufacturing damage evidence.

**Boundary:** Template, not legal advice; Current declared rail: Drafted letter.

### `recovery.medical_bill_errors` — Medical bill errors

**Current:** prepare. **Promised behavior:** Finds errors and disputes them.

**Build and accept only when:** Match bill line items, EOB, payments and prior adjustments; distinguish an insurer denial from duplicate billing and produce a specific reviewable dispute.

**Boundary:** Current declared rail: Drafted letter.

### `recovery.insurance_claims` — Insurance claims

**Current:** planned. **Promised behavior:** Files claims and chases payment.

**Build and accept only when:** Check covered event/policy dates and deductible, assemble truthful evidence and track claim ID, adjuster requests and actual payout/rejection.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Statements of fact are yours.

### `recovery.hsa_and_fsa_reimbursement` — HSA and FSA reimbursement

**Current:** planned. **Promised behavior:** Submits eligible expenses for reimbursement.

**Build and accept only when:** Verify expense eligibility, service date, participant and no prior reimbursement; test duplicate receipts across HSA/FSA and distinguish reimbursement from taxable withdrawal.

**Boundary:** Plan rules.

### `recovery.employer_reimbursements` — Employer reimbursements

**Current:** prepare. **Promised behavior:** Chases unpaid expense reports.

**Build and accept only when:** Read expense policy, approved report and submission status; test advances and card-paid expenses before chasing an amount, then confirm payroll/bank reimbursement.

**Boundary:** Current declared rail: Drafted message.

### `recovery.rebates` — Rebates

**Current:** planned. **Promised behavior:** Files manufacturer and utility efficiency rebates.

**Build and accept only when:** Use product/service eligibility, purchase/install date and required documents; track application deadline and actual rebate rather than counting advertised maximums.

### `recovery.recall_refunds` — Recall refunds

**Current:** planned. **Promised behavior:** Matches purchases to recalls and claims the remedy.

**Build and accept only when:** Match model/serial and dated official recall remedy; test repair-only remedies and ownership proof rather than promising every recall creates a cash refund.

### `recovery.missed_tax_refunds` — Missed tax refunds

**Current:** planned. **Promised behavior:** Flags years where a refund was never claimed.

**Build and accept only when:** Use filing/payment records and applicable claim deadlines by year/jurisdiction; flag cases for authorized review rather than extrapolating refunds from bank deposits alone.

**Boundary:** Three-year deadline.

### `recovery.utility_deposit_return` — Utility deposit return

**Current:** prepare. **Promised behavior:** Recovers deposits held by utilities after moving.

**Build and accept only when:** Identify utility deposit, closed service and forwarding address; test offsets for unpaid bills and verify refund allocation before marking recovery complete.

**Boundary:** Current declared rail: Drafted message.

### `recovery.store_credit_and_gift_cards` — Store credit and gift cards

**Current:** planned. **Promised behavior:** Finds and uses balances before they expire.

**Build and accept only when:** Combine receipt/account balances and expiry restrictions; distinguish noncash store credit from cash recovery and test partial redemptions without duplicated value.

## Banking and cash (13 capabilities)

**Data/connectors required:** Bank balances/transactions with complete account metadata, ownership, pending items, APY/fees and insurance structure.

**Execution/handoff required:** Approved own-account bank rail and bank-supported opening/change/closure workflows.

### `banking.fee_audit` — Fee audit

**Current:** read. **Promised behavior:** Totals every bank fee paid in a year.

**Build and accept only when:** Classify posted bank fees with account and covered period; test reversals, partial-year history and interest charges, with a reconciled annual total.

### `banking.account_comparison` — Account comparison

**Current:** planned. **Promised behavior:** Compares your accounts with better ones.

**Build and accept only when:** Compare current APY, fees, eligibility, insurance structure and user usage; compute net benefit with dated terms and disclose sponsor compensation.

**Boundary:** Show the best even if unpaid.

### `banking.open_an_account` — Open an account

**Current:** planned. **Promised behavior:** Starts the application with details prefilled.

**Build and accept only when:** Use a supported provider application, identity consent and accurate prefill; preserve application status and user-required attestations, including denial or extra verification.

**Boundary:** You complete identity checks.

### `banking.safe_account_switch` — Safe account switch

**Current:** planned. **Promised behavior:** Moves direct deposit and every autopay before closing the old account.

**Build and accept only when:** Inventory payroll and each autopay, verify new account and sufficient overlap buffer; block closure until all changes post and pending/return risks are reviewed.

**Boundary:** Nothing missed.

### `banking.close_an_account` — Close an account

**Current:** planned. **Promised behavior:** Closes only after bonus periods and pending items clear.

**Build and accept only when:** Read pending transactions, balances, obligations and bonus hold rules; require explicit closure approval and obtain bank confirmation rather than treating unlink as closure.

**Boundary:** Early-closure fees.

### `banking.overdraft_guard` — Overdraft guard

**Current:** gated. **Promised behavior:** Moves money in before a charge would overdraw.

**Build and accept only when:** Forecast the specific funding account and submit permitted own-account top-up before cutoff; test held funds, transfer delay and insufficient source funds.

**Boundary:** Your own accounts; Current declared rail: Payments partner; Current gate: A licensed payments partner (Plaid Transfer or a bank partner).

### `banking.low_balance_forecast` — Low balance forecast

**Current:** read. **Promised behavior:** Warns days ahead of a shortfall.

**Build and accept only when:** Use available cash, unpaid obligations, pending items, payroll confidence and variable spend; test today's bill, missed payday and multiple checking accounts.

### `banking.cash_buffer` — Cash buffer

**Current:** gated. **Promised behavior:** Keeps a minimum balance you set.

**Build and accept only when:** Store per-account user buffer and protected obligations; test contradictory savings rules and returns so automation cannot consume the reserved amount.

**Boundary:** Current declared rail: Payments partner; Current gate: A licensed payments partner (Plaid Transfer or a bank partner).

### `banking.idle_cash_sweep` — Idle cash sweep

**Current:** gated. **Promised behavior:** Moves spare cash to a higher-yield account.

**Build and accept only when:** Calculate genuinely spare cash after near-term obligations and transfer time; test a reversed deposit and overlapping sweep workers under a bounded mandate.

**Boundary:** Licensed payments partner; Current declared rail: Payments partner; Current gate: A licensed payments partner (Plaid Transfer or a bank partner).

### `banking.rate_watch` — Rate watch

**Current:** planned. **Promised behavior:** Alerts when the savings rate drops below good alternatives.

**Build and accept only when:** Compare live/date-stamped account APY and relevant alternatives net of fees; distinguish promotional versus ongoing rates and suppress irrelevant marginal differences.

### `banking.deposit_insurance_check` — Deposit insurance check

**Current:** read. **Promised behavior:** Flags balances above insured limits.

**Build and accept only when:** Aggregate eligible balances by legal institution and ownership category using actual account inputs; test multiple brands at one bank and unsupported pass-through assumptions.

### `banking.atm_fee_avoidance` — ATM fee avoidance

**Current:** planned. **Promised behavior:** Finds in-network ATMs and fee-free withdrawals.

**Build and accept only when:** Use current network/location data and account reimbursements; separate operator surcharge, bank fee and foreign fees and test a closed/out-of-network ATM.

### `banking.account_inventory` — Account inventory

**Current:** read. **Promised behavior:** Keeps a list of every account you hold.

**Build and accept only when:** Persist all bank connections/accounts with ownership, type and status; test relinked IDs, closed accounts and unsupported/manual records without duplicates.

## Savings and goals (8 capabilities)

**Data/connectors required:** Bank transactions/balances, goals, verified payroll/windfalls, cost calendar and current product rates.

**Execution/handoff required:** Approved own-account transfers with bounded recurring mandates; product handoff for locked savings.

### `savings.goals` — Goals

**Current:** read. **Promised behavior:** Tracks progress from real balances, not self-reports.

**Build and accept only when:** Allocate real eligible balances to goals without counting the same dollar twice; test joint ownership, manual contributions and a withdrawal reducing progress.

### `savings.payday_saving` — Payday saving

**Current:** gated. **Promised behavior:** Saves a set amount or share on payday.

**Build and accept only when:** Trigger only on identified payroll events with account/buffer constraints; test split paychecks, corrections and replay with exactly one authorized transfer.

**Boundary:** Never below buffer; Current declared rail: Payments partner; Current gate: A licensed payments partner (Plaid Transfer or a bank partner).

### `savings.round_ups` — Round-ups

**Current:** planned. **Promised behavior:** Saves spare change from purchases.

**Build and accept only when:** Compute settled-purchase deltas, exclude transfers/refunds and batch with limits; test a reversed purchase and replay without excessive microtransfer fees.

### `savings.save_the_surprise` — Save the surprise

**Current:** planned. **Promised behavior:** Saves part of refunds, bonuses and windfalls.

**Build and accept only when:** Identify eligible net windfalls and user-selected share; test provisional dispute credits, tax refunds and source-account obligations before moving money.

**Boundary:** You set the share.

### `savings.sinking_funds` — Sinking funds

**Current:** planned. **Promised behavior:** Saves ahead for known annual costs like insurance or holidays.

**Build and accept only when:** Create dated cost targets and contributions based on current reserve; test annual insurance cost changes and a payment that should reduce both reserve and obligation.

### `savings.emergency_fund_target` — Emergency fund target

**Current:** read. **Promised behavior:** Sets the target from actual fixed costs.

**Build and accept only when:** Use actual essential costs, income volatility and dependents with editable assumptions; test expenses missing from bank data and separate retirement assets from liquid reserves.

### `savings.goal_pacing` — Goal pacing

**Current:** read. **Promised behavior:** Shows the finish date and what would bring it forward.

**Build and accept only when:** Forecast contributions/yield with transparent assumptions and competing goals; test missed contributions and variable rates and show ranges where appropriate.

**Boundary:** Computed, not estimated.

### `savings.treasury_and_cd_explainer` — Treasury and CD explainer

**Current:** planned. **Promised behavior:** Explains T-bills, CDs and ladders with current rates.

**Build and accept only when:** Use current dated rates, term, liquidity, taxes and early-withdrawal rules; compare cash-equivalent needs and avoid treating locked funds as available emergency cash.

**Boundary:** Buying routes through brokerage partner.

## Debt (12 capabilities)

**Data/connectors required:** Liability partner/servicers/statements, account terms, APR schedule, minimums, due dates and bank cash forecast.

**Execution/handoff required:** Supported creditor-payment partner and lender workflow; user-approved hardship/credit changes.

### `debt.debt_inventory` — Debt inventory

**Current:** read. **Promised behavior:** Every balance, rate and minimum in one list.

**Build and accept only when:** Read creditor balance/APR/minimum/due date and distinguish revolving, installment and deferred-interest terms; flag missing/stale values and reconcile manual duplicates.

### `debt.payoff_order` — Payoff order

**Current:** read. **Promised behavior:** Orders debts by interest cost, with the arithmetic shown.

**Build and accept only when:** Simulate minimums, extra budget, promotional rate changes and user goals; show remaining balance/infeasibility rather than a false 600-month payoff.

**Boundary:** Extra payments.

### `debt.extra_payments` — Extra payments

**Current:** gated. **Promised behavior:** Pays extra toward the most expensive debt on rules you set.

**Build and accept only when:** Bind creditor, loan and principal-allocation instructions to a mandate; preserve minimums/buffer, and verify application rather than only a bank debit.

**Boundary:** Never below buffer; Current declared rail: Agent card rails or bill pay; Current gate: A card-network agent program or licensed payments partner.

### `debt.minimum_safety_net` — Minimum safety net

**Current:** planned. **Promised behavior:** Makes sure every minimum is paid on time.

**Build and accept only when:** Read actual statement minimum/due date and existing autopay; test rate changes, pending payments and one missed lender sync before submitting.

### `debt.promo_expiry` — Promo expiry

**Current:** planned. **Promised behavior:** Warns before a 0% period or deferred interest ends.

**Build and accept only when:** Model expiry date, post-promo APR and deferred-interest distinction; test partial remaining balance and notify early enough to act.

### `debt.balance_transfer_math` — Balance transfer math

**Current:** read. **Promised behavior:** Works out whether a transfer saves money after the fee.

**Build and accept only when:** Include transfer fee, available limit, promo length, eligibility and payoff schedule; test a payment insufficient to repay before expiry and hard-inquiry implications.

**Boundary:** Never arranges the loan.

### `debt.refinance_check` — Refinance check

**Current:** planned. **Promised behavior:** Compares your rate to current market rates.

**Build and accept only when:** Compare fees, remaining term, amortization, eligibility and loss of protections using dated quotes; test lower monthly payments with greater total cost.

**Boundary:** Takes no referral fee; lending brokerage is licensed.

### `debt.rate_reduction_call` — Rate reduction call

**Current:** planned. **Promised behavior:** Asks card issuers to lower the APR.

**Build and accept only when:** Use approved negotiation boundaries and lender identity; verify changed APR and duration on the account, including a retention offer with added fees.

**Boundary:** AI disclosure.

### `debt.hardship_request` — Hardship request

**Current:** prepare. **Promised behavior:** Asks lenders about hardship programs.

**Build and accept only when:** Prepare truthful income/expense context and compare program terms; require acceptance approval and flag interest, credit-reporting and account-use consequences.

**Boundary:** Debt relief rules: never charge for this; Current declared rail: Drafted message.

### `debt.buy_now_pay_later_tracker` — Buy now pay later tracker

**Current:** read. **Promised behavior:** Tracks every installment and due date.

**Build and accept only when:** Import each order/installment including autopay and merchant refunds; test overlapping providers, changed schedule and a canceled purchase with repayments still due.

### `debt.payday_loan_exit` — Payday loan exit

**Current:** planned. **Promised behavior:** Spots payday loans and shows cheaper options like credit union loans.

**Build and accept only when:** Read effective costs and rollover terms, then compare available alternatives and actual eligibility; test repayment burden without presenting unapproved credit as guaranteed.

**Boundary:** No referral fees.

### `debt.collection_letters` — Collection letters

**Current:** prepare. **Promised behavior:** Explains the letter and your rights; drafts a validation request.

**Build and accept only when:** Extract collector, debt, date and response deadlines with jurisdiction-specific official sources; draft truthful validation requests and retain mailing/delivery evidence.

**Boundary:** Template, not legal advice; Current declared rail: Drafted letter.

## Student loans (7 capabilities)

**Data/connectors required:** Borrower-authorized servicer data, official loan/program rules, income documents and employment certification.

**Execution/handoff required:** Supported servicer/form workflows with user attestation; case-based review for disputed records.

### `student_loans.loan_inventory` — Loan inventory

**Current:** planned. **Promised behavior:** Every federal and private loan, servicer, rate and status.

**Build and accept only when:** Import servicer/type/rate/status and borrower identity; reconcile transferred servicers and capitalized interest without duplicating balances.

### `student_loans.plan_comparison` — Plan comparison

**Current:** planned. **Promised behavior:** Shows the monthly cost under each repayment plan.

**Build and accept only when:** Use current official program rules, household income/size and loan eligibility; show unavailable plans and test a rule change rather than relying on stale plan names.

**Boundary:** Current plan rules only.

### `student_loans.recertification_deadlines` — Recertification deadlines

**Current:** planned. **Promised behavior:** Tracks income-driven plan recertification dates.

**Build and accept only when:** Use authoritative borrower-specific dates and extension notices; test changed servicer dates and timezone reminders, not only generic annual recurrence.

### `student_loans.recertification_prep` — Recertification prep

**Current:** planned. **Promised behavior:** Prepares the recertification with income documents.

**Build and accept only when:** Collect required income/household evidence and confirmed form version; user reviews/signs, with receipt and pending review status tracked.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Sworn.

### `student_loans.forgiveness_tracking` — Forgiveness tracking

**Current:** planned. **Promised behavior:** Tracks qualifying payments and employment for forgiveness programs.

**Build and accept only when:** Track qualifying employer/payment evidence and official count separately from estimates; test rejected employment certifications and transferred payment histories.

### `student_loans.grace_period_alerts` — Grace period alerts

**Current:** planned. **Promised behavior:** Warns before the first payment is due after graduation.

**Build and accept only when:** Read graduation/status change and loan-specific grace terms; test loans without grace and first-bill changes, with verified due date handoff.

### `student_loans.servicer_error_check` — Servicer error check

**Current:** planned. **Promised behavior:** Flags misapplied payments.

**Build and accept only when:** Reconcile payment allocation, interest, principal and official status; test a transfer delay and misapplied payment with a specific evidence packet.

## Credit (7 capabilities)

**Data/connectors required:** Consented bureau/report partner, dated scoring model, issuer statements and official bureau resources.

**Execution/handoff required:** Issuer-supported payments/limit requests and bureau handoffs; separate consent for inquiry-producing actions.

### `credit.report_and_score` — Report and score

**Current:** planned. **Promised behavior:** Shows the report and score through a bureau partner.

**Build and accept only when:** Use an authorized bureau partner and dated scoring model; display coverage and consent, test unavailable reports and avoid estimating a bureau score from bank spend.

**Boundary:** Your permission is the legal basis.

### `credit.score_explainer` — Score explainer

**Current:** planned. **Promised behavior:** Explains what is moving the score.

**Build and accept only when:** Tie changes to dated report factors and model limits; test simultaneous events and explain uncertain attribution rather than inventing point impacts.

**Boundary:** No promises of improvement.

### `credit.utilisation_timing` — Utilisation timing

**Current:** planned. **Promised behavior:** Pays down a card before its statement closes to lower the reported balance.

**Build and accept only when:** Read actual statement-close date and reported balance, preserve minimum payment timing and cash buffer; test a pending payment and changed credit limit.

### `credit.new_account_alerts` — New account alerts

**Current:** planned. **Promised behavior:** Flags new accounts and hard inquiries.

**Build and accept only when:** Ingest bureau events with duplicate suppression and baseline ownership; test authorized new accounts versus unknown inquiries and provide correct dispute path.

### `credit.freeze_walkthrough` — Freeze walkthrough

**Current:** prepare. **Promised behavior:** Guides you through freezing credit at each bureau.

**Build and accept only when:** Provide current official bureau steps and let users retain secure recovery access; test freeze versus fraud alert and never claim a bureau freeze without confirmation.

**Boundary:** Bureaus require you; Current declared rail: Guided steps.

### `credit.error_spotting` — Error spotting

**Current:** planned. **Promised behavior:** Points out likely errors and links the free bureau dispute.

**Build and accept only when:** Compare report fields to user evidence and other reports; flag suspected errors, require factual review and track bureau dispute case/results.

**Boundary:** No disputing for you: credit repair law.

### `credit.limit_increase_request` — Limit increase request

**Current:** planned. **Promised behavior:** Requests a higher limit on an existing card.

**Build and accept only when:** Preview requested limit, income statement and hard/soft inquiry terms; require approval and verify issuer decision rather than assuming success.

**Boundary:** May cause a hard pull; warn first.

## Investing (15 capabilities)

**Data/connectors required:** Investment aggregator, broker account/position/order/lot data, licensed market data and official company filings.

**Execution/handoff required:** Supported existing-broker trading adapter or embedded brokerage program; separately approved advisory program for discretion.

### `investing.company_teardown` — Company teardown

**Current:** planned. **Promised behavior:** Price, revenue, the ratio worked out, both cases, what to check.

**Build and accept only when:** Use dated filings/market data, explicit ratio arithmetic and both investment cases; test different share classes, missing revenue and stale prices without fabricated metrics.

**Boundary:** Same output for everyone.

### `investing.watchlist` — Watchlist

**Current:** planned. **Promised behavior:** Tracks companies you name, with price and news alerts.

**Build and accept only when:** Persist exact securities/exchanges and alert thresholds; handle splits and currency, dedupe alerts and test a ticker reused by a different company.

### `investing.earnings_calendar` — Earnings calendar

**Current:** planned. **Promised behavior:** Flags upcoming earnings for held and watched companies.

**Build and accept only when:** Map held/watched securities to announced dates/timezones and tentative status; test rescheduled earnings and duplicate symbols.

### `investing.earnings_digest` — Earnings digest

**Current:** planned. **Promised behavior:** Summarises what a company reported, with the numbers.

**Build and accept only when:** Use actual releases/filings and distinguish GAAP/non-GAAP and comparable periods; test missing figures and cite the source for every material claim.

**Boundary:** Sourced and dated.

### `investing.portfolio_view` — Portfolio view

**Current:** read. **Promised behavior:** All brokerage and retirement accounts together.

**Build and accept only when:** Aggregate account-specific positions, cash and valuation dates; test unsupported accounts, joint ownership and duplicate connections without double counting.

**Boundary:** Read-only aggregator.

### `investing.allocation_facts` — Allocation facts

**Current:** read. **Promised behavior:** Shows how concentrated the portfolio is, as figures.

**Build and accept only when:** Compute concentration by asset/security/sector across supported coverage with missing-data labels; test cash, unclassified funds and overlapping fund exposures.

**Boundary:** Facts, no verdicts.

### `investing.fee_audit` — Fee audit

**Current:** read. **Promised behavior:** Shows fund fees in dollars per year.

**Build and accept only when:** Use current expense ratios/advisory fees and holding value; separate estimates from actual charges and test stale ratios and duplicate fee categories.

### `investing.cash_drag` — Cash drag

**Current:** read. **Promised behavior:** Flags cash sitting uninvested in a brokerage account.

**Build and accept only when:** Distinguish settlement cash, reserved orders, intentional liquidity and sweep yields; test recent deposits and do not auto-invest merely because cash exists.

### `investing.dividend_tracker` — Dividend tracker

**Current:** planned. **Promised behavior:** Tracks dividends paid and upcoming.

**Build and accept only when:** Reconcile declared dates, actual payments, withholding and reinvestment; test corporate actions and do not count expected dividends as already earned cash.

### `investing.trade_execution` — Trade execution

**Current:** gated. **Promised behavior:** Buys or sells what you name.

**Build and accept only when:** Preview exact account/security/side/quantity/order type and estimated fees; enforce scope and reconcile order IDs/partial fills, market closure and timeouts without duplicate orders.

**Boundary:** Brokerage partner; first trade in a security is T2; Current declared rail: Brokerage API; Current gate: A broker-dealer partner and a securities lawyer's sign-off.

### `investing.recurring_investing` — Recurring investing

**Current:** gated. **Promised behavior:** Invests a set amount on a schedule you chose.

**Build and accept only when:** Use supported broker schedule/funding and bounded user mandate; test insufficient buying power, holidays, price changes and fractional-share support.

**Boundary:** Brokerage partner; Current declared rail: Brokerage API; Current gate: A broker-dealer partner and a securities lawyer's sign-off.

### `investing.rebalance_to_targets` — Rebalance to targets

**Current:** planned. **Promised behavior:** Rebalances to percentages you set.

**Build and accept only when:** Validate user-selected targets and account constraints, preview costs/taxes and execute bounded orders; test partial fills and holdings unavailable at one broker.

**Boundary:** If the agent sets the targets, it's advice.

### `investing.filings_view` — Filings view

**Current:** planned. **Promised behavior:** Shows institutional and insider filings with their age in days.

**Build and accept only when:** Read official filings, disclose filing/transaction/report dates and ownership context; test amended reports and avoid presenting delayed holdings as current trades.

**Boundary:** Always state staleness.

### `investing.tax_loss_harvesting` — Tax-loss harvesting

**Current:** planned. **Promised behavior:** Sells losers to offset gains and buys similar holdings.

**Build and accept only when:** Require accurate lots and cross-account/spouse wash-sale context with reviewed replacement restrictions; test unknown external activity and disallow unsupported automatic claims of tax savings.

**Boundary:** Requires a registered adviser.

### `investing.managed_portfolios` — Managed portfolios

**Current:** planned. **Promised behavior:** The agent chooses and manages the investments.

**Build and accept only when:** Treat discretionary selection as a separate approved advisory/partner program; require suitability/mandate/oversight and do not unlock it by enabling user-directed trade execution.

**Boundary:** Requires a registered adviser.

## Retirement (9 capabilities)

**Data/connectors required:** Employer/payroll/plan data, investment accounts, vesting/beneficiary documents and year-specific rules.

**Execution/handoff required:** Employer-plan workflow and supported custodian transfer/rollover process with explicit review.

### `retirement.employer_match_check` — Employer match check

**Current:** planned. **Promised behavior:** Flags free match money you aren't collecting.

**Build and accept only when:** Read plan-specific eligibility, vesting, match formula, true-up and actual payroll contributions; test front-loaded contributions and a missing plan document.

### `retirement.contribution_change` — Contribution change

**Current:** planned. **Promised behavior:** Prepares the change in the employer plan.

**Build and accept only when:** Preview percentage/dollar and payroll impact under plan limits; prepare or use a supported employer workflow and confirm the first changed paycheck.

**Boundary:** User submits required documents/actions; do not substitute agent consent; Employer portal.

### `retirement.contribution_limits` — Contribution limits

**Current:** planned. **Promised behavior:** Tracks contributions against the current year's limits.

**Build and accept only when:** Combine all relevant accounts and employer/payroll contributions by tax year and contribution type; test catch-up eligibility and multiple employers without inappropriate aggregation.

**Boundary:** Year-stamped, computed.

### `retirement.roth_or_traditional_explainer` — Roth or traditional explainer

**Current:** planned. **Promised behavior:** Shows the tradeoff with your own numbers.

**Build and accept only when:** Use current marginal taxes, eligibility and explicit future-tax assumptions; show uncertainty and test nondeductible traditional contributions and employer-plan effects.

**Boundary:** Explanation, not a pick.

### `retirement.old_plan_finder` — Old plan finder

**Current:** planned. **Promised behavior:** Finds retirement plans at past employers.

**Build and accept only when:** Use previous employers and official administrator sources; identify only verified participant accounts and distinguish potential leads from money recovered.

### `retirement.rollover` — Rollover

**Current:** planned. **Promised behavior:** Moves an old plan into an IRA or new plan.

**Build and accept only when:** Compare fees, protections, tax status and destination eligibility; require reviewed direct-rollover instructions and reconcile both accounts without accidental taxable cash-out.

**Boundary:** Custodian paperwork; you sign.

### `retirement.retirement_projection` — Retirement projection

**Current:** planned. **Promised behavior:** Projects balances under stated assumptions.

**Build and accept only when:** Model contributions, inflation, fees, retirement drawdown and scenario ranges; test negative returns and changing income, and identify simulation assumptions rather than implying certainty.

**Boundary:** Assumptions shown.

### `retirement.beneficiary_check` — Beneficiary check

**Current:** planned. **Promised behavior:** Flags accounts with no beneficiary named.

**Build and accept only when:** Read supported confirmed beneficiary data with sensitivity controls; flag unknown versus missing and require user-reviewed designation changes.

### `retirement.equity_compensation` — Equity compensation

**Current:** planned. **Promised behavior:** Tracks vesting of stock grants and purchase plans.

**Build and accept only when:** Track grant/vest/exercise/expiry, tax type and trading windows from employer records; test RSU withholding, options expiration and restrictions without treating unvested grants as cash.

## Tax (12 capabilities)

**Data/connectors required:** Payroll/bank records, current/prior returns, tax forms, household facts and versioned official federal/state rules.

**Execution/handoff required:** Authorized tax/e-file partner or official portal; reviewed handoff and required signatures.

### `tax.refund_or_owe_forecast` — Refund or owe forecast

**Current:** read. **Promised behavior:** Estimates the year-end result all year.

**Build and accept only when:** Use filing status, YTD income/payments, deductions/credits and applicable federal/state rules; test a spouse/job change and report missing inputs instead of a false precise refund.

**Boundary:** Labelled as an estimate.

### `tax.credit_finder` — Credit finder

**Current:** planned. **Promised behavior:** Flags credits you may qualify for: education, earned income, saver's, state credits.

**Build and accept only when:** Evaluate each sourced tax-year eligibility rule and user evidence; test income phaseouts and incompatible credits and label potential versus substantiated entitlement.

**Boundary:** Explains; the preparer decides.

### `tax.deduction_finder` — Deduction finder

**Current:** planned. **Promised behavior:** Flags deductions worth checking, with your numbers.

**Build and accept only when:** Compare applicable itemized/standard and business deductions using records; test reimbursed costs and duplicate receipts rather than categorizing every purchase as deductible.

**Boundary:** Same.

### `tax.document_collection` — Document collection

**Current:** planned. **Promised behavior:** Gathers W-2s, 1099s, 1098-T, 1098-E and similar.

**Build and accept only when:** Track expected forms by payer/year and ingest corrected versions; test missing 1099s and an amended form replacing an older one.

### `tax.donation_log` — Donation log

**Current:** planned. **Promised behavior:** Records charitable giving with receipts.

**Build and accept only when:** Record recipient, date, cash/noncash amount and receipt/appraisal needs; test refunded donations and unsupported valuations with review flags.

### `tax.hsa_tracking` — HSA tracking

**Current:** planned. **Promised behavior:** Tracks contributions and explains the tax treatment.

**Build and accept only when:** Reconcile employer/user contributions, eligibility months, distributions and catch-up; test excess contributions and expenses reimbursed elsewhere.

**Boundary:** Year-stamped limits.

### `tax.filing_handoff` — Filing handoff

**Current:** planned. **Promised behavior:** Sends the tax package to an authorised e-file partner or free VITA site.

**Build and accept only when:** Build an explicit reviewed package and send only to an authorized chosen partner/site; verify consent, version and delivery while distinguishing handoff from accepted e-filing.

**Boundary:** Upmore never prepares or signs.

### `tax.refund_tracker` — Refund tracker

**Current:** planned. **Promised behavior:** Tracks federal and state refunds until they land.

**Build and accept only when:** Use official/partner status with taxpayer consent and bank match; test offsets, reduced refunds and stale status without guessing the payment date.

### `tax.notice_explainer` — Notice explainer

**Current:** read. **Promised behavior:** Explains an IRS or state letter and the deadline to respond.

**Build and accept only when:** Extract agency, tax year, amounts, response deadline and official contact path; test scam letters and uncertain OCR, and preserve original document evidence.

**Boundary:** Points to a professional.

### `tax.payment_plan_prep` — Payment plan prep

**Current:** planned. **Promised behavior:** Prepares an IRS payment plan request.

**Build and accept only when:** Compare official eligibility, fees, interest and proposed installments using confirmed liabilities; user reviews required declarations and tracks agency acceptance separately.

**Boundary:** User submits required documents/actions; do not substitute agent consent.

### `tax.amendment_flag` — Amendment flag

**Current:** planned. **Promised behavior:** Flags past returns that may have missed money.

**Build and accept only when:** Compare prior returns/forms/rules with corrections and relevant deadlines; identify a reviewable issue, not automatically file or promise an additional refund.

**Boundary:** Three-year window.

### `tax.property_tax_appeal` — Property tax appeal

**Current:** planned. **Promised behavior:** Builds the comparables and prepares the appeal.

**Build and accept only when:** Use jurisdiction's assessment, filing window and defensible comparable properties; test noncomparable sales and retain submitted evidence/case status.

**Boundary:** User files required documents/actions; do not substitute agent consent; County deadlines.

## Insurance (8 capabilities)

**Data/connectors required:** Actual policy/endorsement documents, insurer portals, asset/household facts, EOBs and comparable quote data.

**Execution/handoff required:** Insurer claims workflows and licensed/approved insurance partners; no premature policy cancellation.

### `insurance.policy_inventory` — Policy inventory

**Current:** planned. **Promised behavior:** Every policy, premium, deductible and renewal date.

**Build and accept only when:** Extract insurer, policy ID, covered people/assets, premium, deductibles, limits and renewal from actual documents; mark uncertain/missing values and reconcile endorsements.

### `insurance.coverage_explainer` — Coverage explainer

**Current:** planned. **Promised behavior:** Explains what a policy covers, from the document.

**Build and accept only when:** Answer from the applicable policy and exclusions with page references; test a scenario excluded by an endorsement rather than describing only the marketing summary.

### `insurance.gap_finder` — Gap finder

**Current:** planned. **Promised behavior:** Flags being underinsured or doubly insured.

**Build and accept only when:** Compare user's confirmed risks/assets with limits and overlapping policies; disclose missing context and avoid recommending coverage based on invented household facts.

**Boundary:** Explanation, not a sale.

### `insurance.card_coverage_map` — Card coverage map

**Current:** planned. **Promised behavior:** Shows rental car, phone and purchase cover your cards already include.

**Build and accept only when:** Map benefits to cards and dated guides with purchase prerequisites; test discontinued benefits and secondary coverage without counting it twice.

### `insurance.renewal_alerts` — Renewal alerts

**Current:** planned. **Promised behavior:** Warns 30 days before renewal.

**Build and accept only when:** Track confirmed renewal/cancellation-notice dates and premium changes; test auto-renewal, replaced policies and notices received after the normal reminder window.

### `insurance.reshop` — Reshop

**Current:** planned. **Promised behavior:** Gets quotes through a licensed partner.

**Build and accept only when:** Use a licensed/approved quote partner and comparable limits/deductibles; obtain consent for sharing and distinguish quote, bound coverage and old-policy cancellation.

**Boundary:** Upmore never sells insurance itself.

### `insurance.claims` — Claims

**Current:** planned. **Promised behavior:** Files and chases claims.

**Build and accept only when:** Collect truthful incident evidence and policy-specific deadlines; track claim ID, adjuster requests, settlement/deductible and payout with user review of required signatures.

**Boundary:** User signs required documents/actions; do not substitute agent consent.

### `insurance.open_enrolment_compare` — Open enrolment compare

**Current:** planned. **Promised behavior:** Compares health plans on your real usage.

**Build and accept only when:** Model premiums, networks, deductible/out-of-pocket limits, prescriptions, dependents and employer funding from plan documents; test a preferred provider excluded by the cheaper plan.

## Health costs (7 capabilities)

**Data/connectors required:** Patient-authorized bills/EOBs, plan documents, provider financial policies and current pharmacy pricing.

**Execution/handoff required:** Provider/insurer/administrator dispute and reimbursement workflows with minimum necessary document sharing.

### `health.bill_and_eob_matching` — Bill and EOB matching

**Current:** planned. **Promised behavior:** Matches each medical bill to the insurer's explanation of benefits.

**Build and accept only when:** Match patient/provider/date/service codes and payments to insurer EOB; distinguish provider charge from patient responsibility and test corrected EOBs.

**Boundary:** Health data consent.

### `health.billing_error_dispute` — Billing error dispute

**Current:** planned. **Promised behavior:** Disputes overcharges and duplicate line items.

**Build and accept only when:** Identify exact disputed lines and supporting EOB/payments; request review truthfully and verify a corrected balance or refund rather than a sent letter.

### `health.surprise_bill_check` — Surprise bill check

**Current:** planned. **Promised behavior:** Flags out-of-network bills that federal surprise-billing rules may cover.

**Build and accept only when:** Determine relevant plan/provider/service facts and current official protections; flag exceptions and route disputes without guaranteeing every out-of-network charge is prohibited.

**Boundary:** Prepares; not legal advice.

### `health.financial_assistance` — Financial assistance

**Current:** planned. **Promised behavior:** Prepares hospital charity care applications.

**Build and accept only when:** Read hospital-specific policy, household evidence and application dates; require accurate user attestations and track approved adjusted balance.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Sworn income statements.

### `health.payment_plans` — Payment plans

**Current:** planned. **Promised behavior:** Negotiates interest-free payment plans.

**Build and accept only when:** Compare plan interest/fees, monthly affordability and hardship alternatives; require acceptance authorization and verify provider terms and new due dates.

### `health.hsa_and_fsa_deadlines` — HSA and FSA deadlines

**Current:** planned. **Promised behavior:** Warns before use-it-or-lose-it deadlines.

**Build and accept only when:** Use plan-specific carryover/grace/claim rules and eligible-service dates; test HSA funds that do not expire and FSA deadlines that differ from calendar year-end.

### `health.prescription_prices` — Prescription prices

**Current:** planned. **Promised behavior:** Compares pharmacy and discount-card prices.

**Build and accept only when:** Match drug, dose, form, quantity and pharmacy availability; distinguish insurance from discount-card prices and test interactions with deductible accumulation.

## Housing (8 capabilities)

**Data/connectors required:** Lease, property-manager ledger, utility records, residence history, income/cost model and local comparables/rules.

**Execution/handoff required:** Verified landlord/utility workflows and supported insurance partners; user-reviewed negotiations/demands.

### `housing.rent_tracking` — Rent tracking

**Current:** read. **Promised behavior:** Tracks rent paid and upcoming.

**Build and accept only when:** Use lease/biller obligations and match rent payments including roommate portions; test Zelle rent, prepaid rent and due-today unpaid rent with correct unit/payee.

### `housing.lease_renewal` — Lease renewal

**Current:** planned. **Promised behavior:** Warns before renewal and prepares the negotiation with local rents.

**Build and accept only when:** Read notice deadline, lease terms and comparable local rents; prepare a user-reviewed negotiation and test an automatic renewal clause and changed local terms.

### `housing.moving_checklist` — Moving checklist

**Current:** planned. **Promised behavior:** Transfers utilities and updates the address on every account.

**Build and accept only when:** Inventory actual connected accounts/providers and destination date; track each authorized change/receipt without claiming every address changed from one local edit.

**Boundary:** Each account is its own action.

### `housing.utility_setup` — Utility setup

**Current:** planned. **Promised behavior:** Starts and stops service on move dates.

**Build and accept only when:** Check service location, dates, deposits and overlap requirements; verify provider setup/termination and test a move-date change without disconnecting early.

### `housing.renters_insurance_check` — Renters insurance check

**Current:** planned. **Promised behavior:** Flags having none and explains the cost.

**Build and accept only when:** Distinguish unknown policy from no policy, compare lease requirements and confirmed coverage; hand off quotes through supported partners.

**Boundary:** No sale.

### `housing.deposit_recovery` — Deposit recovery

**Current:** prepare. **Promised behavior:** Tracks the return deadline and drafts the demand.

**Build and accept only when:** Track deposit, move-out, deductions, forwarding address and jurisdiction deadline; produce accurate demand and reconcile partial refunds with disputes.

**Boundary:** Template, not legal advice; Current declared rail: Drafted letter.

### `housing.apartment_affordability` — Apartment affordability

**Current:** planned. **Promised behavior:** Shows what rent fits your real income and fixed costs.

**Build and accept only when:** Use net reliable income, fixed costs, debts, upfront deposits/fees and buffer; test variable income and missing expenses rather than applying only a rent percentage.

### `housing.home_buying_readiness` — Home-buying readiness

**Current:** planned. **Promised behavior:** Explains down payment, closing costs and what lenders look at.

**Build and accept only when:** Estimate down payment, closing/ongoing costs, debts and lender considerations with dated assumptions; distinguish readiness illustration from mortgage preapproval.

**Boundary:** No lender referrals for fees.

## Transport (7 capabilities)

**Data/connectors required:** Vehicle/loan/policy records, transactions, current official registration/toll rules, transit fares and employer perks.

**Execution/handoff required:** Official vehicle/toll workflows, licensed quote partners and approved refinance/application handoffs.

### `transport.car_cost_view` — Car cost view

**Current:** planned. **Promised behavior:** Payment, insurance, gas, parking and maintenance in one number.

**Build and accept only when:** Combine loan, insurance, fuel, parking, tolls and maintenance without duplicate card-payment spend; separate cash costs from depreciation and test irregular repairs.

### `transport.registration_renewal` — Registration renewal

**Current:** planned. **Promised behavior:** Warns and prepares the renewal.

**Build and accept only when:** Use vehicle/jurisdiction expiration, fees and official renewal method; require accurate review, track receipt and test inspection requirements or failed renewal.

### `transport.ticket_and_toll_disputes` — Ticket and toll disputes

**Current:** planned. **Promised behavior:** Prepares disputes for wrong tickets and tolls.

**Build and accept only when:** Read notice, vehicle/time/location and official appeal deadline; prepare truthful evidence and preserve filing confirmation, including a deadline already passed.

**Boundary:** User submits required documents/actions; do not substitute agent consent.

### `transport.transit_pass_check` — Transit pass check

**Current:** planned. **Promised behavior:** Compares a monthly pass with pay-per-ride on real usage.

**Build and accept only when:** Compare actual eligible rides, current fares, employer subsidy and usage forecast; test holidays/remote work and excluded services.

### `transport.commuter_benefits` — Commuter benefits

**Current:** planned. **Promised behavior:** Checks whether the employer offers pre-tax transit or parking.

**Build and accept only when:** Read employer plan, eligibility, monthly limits and enrollment window; distinguish available benefits from actual elected deductions and verify payroll changes.

### `transport.car_insurance_reshop` — Car insurance reshop

**Current:** planned. **Promised behavior:** Reshops at renewal through a licensed partner.

**Build and accept only when:** Compare licensed quotes for the same vehicle/drivers/limits and deductibles; prevent a coverage gap and verify replacement before canceling the old policy.

### `transport.car_loan_check` — Car loan check

**Current:** planned. **Promised behavior:** Compares your auto loan rate with current rates.

**Build and accept only when:** Use remaining principal/term, fees, refinance quote and protections; test a lower payment caused only by extending the loan and show total cost.

**Boundary:** No referral fees.

## Students (8 capabilities)

**Data/connectors required:** School aid/tuition/dining ledgers, education documents, official award-year rules, deadlines and merchant eligibility.

**Execution/handoff required:** School/official form workflows with user signatures; supported resale and merchant-discount adapters.

### `students.fafsa` — FAFSA

**Current:** planned. **Promised behavior:** Tracks deadlines and gathers the documents.

**Build and accept only when:** Track relevant award-year official deadlines and required household documents; preserve user signatures/attestations and distinguish prepared, submitted and processed aid applications.

**Boundary:** User submits required documents/actions; do not substitute agent consent; Sworn.

### `students.aid_disbursement` — Aid disbursement

**Current:** planned. **Promised behavior:** Tracks when aid and refunds hit the student account.

**Build and accept only when:** Read school ledger, awarded aid, holds and disbursement/refund schedule; test delayed releases and reconcile a bank refund without treating loans as earned income.

### `students.tuition_refunds` — Tuition refunds

**Current:** planned. **Promised behavior:** Claims refunds for dropped courses inside the deadline.

**Build and accept only when:** Use school's course-drop date and refund schedule plus actual payments; confirm course action authorization and reconcile refund/aid adjustment separately.

**Boundary:** School policy.

### `students.meal_plan_balance` — Meal plan balance

**Current:** planned. **Promised behavior:** Warns before unused dining dollars expire.

**Build and accept only when:** Read supported school dining balances, rollover rules and expiry; test nonrefundable credits and stale balances without encouraging unnecessary spending.

### `students.scholarship_deadlines` — Scholarship deadlines

**Current:** planned. **Promised behavior:** Tracks scholarships you are applying to.

**Build and accept only when:** Record verified eligibility, required essays/documents and timezone deadlines; test duplicate applications and surface missing evidence without inventing achievements.

### `students.education_credits` — Education credits

**Current:** planned. **Promised behavior:** Uses the 1098-T to flag education tax credits.

**Build and accept only when:** Use 1098-T, eligible expenses, student status, dependency and income under current tax-year rules; test scholarships and credits claiming the same expense twice.

**Boundary:** Preparer decides.

### `students.textbook_resale` — Textbook resale

**Current:** planned. **Promised behavior:** Lists used books at the end of term.

**Build and accept only when:** Match ISBN/edition/condition to actual offers and marketplace fees; require listing approval and track shipped/returned books and paid proceeds.

### `students.student_pricing` — Student pricing

**Current:** planned. **Promised behavior:** Moves services to student discounts.

**Build and accept only when:** Verify enrollment through supported merchant workflows and terms; test expired eligibility and compare total annual cost after discount expiry.

**Boundary:** Enrolment proof.

## Benefits and assistance (5 capabilities)

**Data/connectors required:** Official jurisdiction-specific programs, confirmed household/income/assets, employer plans and utility records.

**Execution/handoff required:** Official program application workflows and reviewed attestations; provider-confirmed assistance outcome.

### `benefits.benefits_screen` — Benefits screen

**Current:** planned. **Promised behavior:** Checks eligibility for food, energy, phone and health assistance programs.

**Build and accept only when:** Use jurisdiction, household size, income/assets and current official program rules; distinguish screening from eligibility determination and test incomplete household inputs.

### `benefits.application_prep` — Application prep

**Current:** planned. **Promised behavior:** Prefills applications from your records.

**Build and accept only when:** Prefill the correct official form using confirmed evidence; user reviews/sworn declarations, and missing documents block unsupported submission claims.

**Boundary:** User signs required documents/actions; do not substitute agent consent; Sworn.

### `benefits.employer_perks_audit` — Employer perks audit

**Current:** planned. **Promised behavior:** Finds unused stipends, tuition help, wellness and commuter benefits.

**Build and accept only when:** Parse actual benefit policies, eligibility and remaining allowances; test reimbursement-only perks and deadlines rather than presenting advertised perks as cash owed.

### `benefits.dependent_care_accounts` — Dependent care accounts

**Current:** planned. **Promised behavior:** Explains pre-tax childcare accounts and deadlines.

**Build and accept only when:** Use employer plan and applicable year/household eligibility limits; compare benefits with related tax treatment and test overlapping reimbursements and forfeiture.

### `benefits.utility_assistance` — Utility assistance

**Current:** planned. **Promised behavior:** Applies for bill assistance and payment programs.

**Build and accept only when:** Read utility/jurisdiction program rules, income evidence and account arrears; track approved credit/payment plan and avoid double-counting another assistance grant.

**Boundary:** User signs required documents/actions; do not substitute agent consent.

## Protection and security (6 capabilities)

**Data/connectors required:** Bank anomalies, issuer controls, signed auth telemetry, trusted sender references and official security notices.

**Execution/handoff required:** Issuer/security-provider controls under narrow authorization; guided recovery for unsupported providers.

### `protection.fraud_alerts` — Fraud alerts

**Current:** read. **Promised behavior:** Flags unusual charges and card-testing patterns.

**Build and accept only when:** Detect explainable account-specific anomalies and card testing with user confirmation; test travel/legitimate recurring charges and distinguish suspicion from proven fraud.

### `protection.card_freeze` — Card freeze

**Current:** planned. **Promised behavior:** Freezes a card when fraud is likely.

**Build and accept only when:** Use issuer-supported card controls and a card-specific emergency mandate or approval; verify freeze/unfreeze, test unsupported issuers and disclose effects on recurring charges.

**Boundary:** Reversible.

### `protection.scam_check` — Scam check

**Current:** read. **Promised behavior:** Checks whether a bill, text or email asking for money is real.

**Build and accept only when:** Check sender/domain/payment destination against trusted sources and suspicious patterns; isolate malicious instructions and never let a message change a payee or consent.

### `protection.breach_response` — Breach response

**Current:** prepare. **Promised behavior:** Walks through freezes and resets after a data breach.

**Build and accept only when:** Create source-specific reset/freeze/recovery actions and track evidence; test phishing breach notices and prioritize actual exposure without claiming resets are complete from links alone.

**Boundary:** Current declared rail: Guided steps.

### `protection.new_login_alerts` — New login alerts

**Current:** planned. **Promised behavior:** Flags new devices on connected accounts.

**Build and accept only when:** Use provider or Upmore authentication events with verified device metadata; distinguish unavailable external telemetry from no suspicious logins and test user-recognized devices.

**Boundary:** Where partners expose it.

### `protection.replacement_card` — Replacement card

**Current:** planned. **Promised behavior:** Updates every merchant with the new card number after a replacement.

**Build and accept only when:** Use approved token updater/merchant workflows with minimum credential exposure; test subscriptions on issuer-updated tokens and report merchants still requiring manual changes.

**Boundary:** Each merchant is its own action.

## Household and shared money (5 capabilities)

**Data/connectors required:** Participant-approved expense ledger, bank matches, ownership shares and explicit field/account sharing permissions.

**Execution/handoff required:** Authorized request-link/payment partners; server-enforced household visibility and revocation.

### `household.shared_expenses` — Shared expenses

**Current:** planned. **Promised behavior:** Tracks shared costs with roommates or a partner.

**Build and accept only when:** Record payer, participants, proportions and currency with participant permissions; test personal expenses and refunds so a partner cannot see unshared transactions.

**Boundary:** Each person's own consent.

### `household.split_and_request` — Split and request

**Current:** planned. **Promised behavior:** Splits a cost and sends a payment request.

**Build and accept only when:** Bind requested amount to a shared expense and verified recipient; require consent for sending and track partial/declined payments without treating a request as settled.

**Boundary:** Request link only.

### `household.iou_tracker` — IOU tracker

**Current:** planned. **Promised behavior:** Tracks who owes whom.

**Build and accept only when:** Keep a ledger of principal, partial repayments and mutually confirmed adjustments; test duplicate imported repayments and disputed entries.

### `household.shared_goals` — Shared goals

**Current:** planned. **Promised behavior:** Tracks a goal two people save toward.

**Build and accept only when:** Allocate contributed funds by owner and shared permissions; test withdrawal, separation and revoked sharing without duplicating one balance into both members' net worth.

**Boundary:** Both must opt in.

### `household.couple_view` — Couple view

**Current:** planned. **Promised behavior:** A joint picture that each person chooses to share into.

**Build and accept only when:** Let each person choose account/field granularity and revoke access; test separation, export and notification privacy with no implicit access from a shared phone number.

**Boundary:** No one sees what isn't shared.

## Planning and reporting (10 capabilities)

**Data/connectors required:** Canonical complete/disclosed financial model, fresh balances, obligations, income, liabilities and outcome ledger.

**Execution/handoff required:** Read/calculation engine and scenario isolation; an action requires a separate authorized task.

### `planning.safe_to_spend` — Safe to spend

**Current:** read. **Promised behavior:** Money free until payday, as a total and per day.

**Build and accept only when:** Deduct unpaid obligations, buffer, pending transactions and realistic variable costs from eligible cash until verified payday; test no known payday and stale accounts with uncertainty shown.

**Boundary:** Computed from rows.

### `planning.monthly_close` — Monthly close

**Current:** read. **Promised behavior:** In, out, what changed, what's coming — in ninety seconds.

**Build and accept only when:** Reconcile inflows/outflows/transfers/refunds and coverage to actual balances; explain material changes with transactions and test incomplete month data without calling it final.

### `planning.net_worth` — Net worth

**Current:** read. **Promised behavior:** Everything owned minus everything owed, over time.

**Build and accept only when:** Combine valued assets and signed liabilities using one canonical model/date; test the current debt-key mismatch, brokerage duplication, ownership shares and currency conversion.

### `planning.cash_flow_forecast` — Cash flow forecast

**Current:** read. **Promised behavior:** Balance projected 90 days ahead.

**Build and accept only when:** Project account-specific available balances over 90 days with expected income/bills/variable spend and confidence; test payroll interruption, today's bill and annual obligations.

**Boundary:** Assumptions shown.

### `planning.runway` — Runway

**Current:** read. **Promised behavior:** How long you could last on current cash.

**Build and accept only when:** Use liquid accessible cash and actual essential burn, excluding credit limits/locked assets; test zero/negative burn and uncertain income rather than returning meaningless infinity.

### `planning.affordability` — Affordability

**Current:** planned. **Promised behavior:** Whether a purchase fits, and when it would.

**Build and accept only when:** Evaluate all-in purchase and financing costs against goals, buffer and upcoming obligations; test refundable versus irreversible purchases and incomplete connected coverage.

### `planning.scenarios` — Scenarios

**Current:** planned. **Promised behavior:** What changes if you cancel, move or earn something.

**Build and accept only when:** Run changes on a copy of the model with stated effective dates and assumptions; compare baseline/delta and ensure a hypothetical cancellation never becomes an actual task.

**Boundary:** Every figure from a function.

### `planning.big_purchase_plan` — Big purchase plan

**Current:** planned. **Promised behavior:** A savings plan and date for a car, deposit or trip.

**Build and accept only when:** Set total upfront/ongoing cost, target date and competing savings obligations; test price change and a missed contribution, updating a realistic earliest date.

### `planning.year_in_money` — Year in money

**Current:** planned. **Promised behavior:** Annual review of where money went and what Upmore recovered.

**Build and accept only when:** Use full covered-year data and audited outcome ledger; separate confirmed recovered/saved money from potential/estimated opportunities and avoid counting the same benefit twice.

**Boundary:** Confirmed amounts only.

### `planning.spending_patterns` — Spending patterns

**Current:** read. **Promised behavior:** Explains patterns with the numbers behind them.

**Build and accept only when:** Quantify changes by account/category/period with correction support; test seasonal spending, transfers and category uncertainty without inventing causes.

**Boundary:** No judgement.

## Documents and admin (5 capabilities)

**Data/connectors required:** Scoped encrypted object storage, bank/payroll documents, consented mail/photo ingestion and complete server records.

**Execution/handoff required:** Document/export service with authenticated access, signed URLs, pagination and audit trail.

### `documents.document_vault` — Document vault

**Current:** planned. **Promised behavior:** Statements, tax forms, policies, leases, warranties in one place.

**Build and accept only when:** Store encrypted scoped files with source/date/type, access audit and retention; test malicious uploads, expired signed links and cross-user access.

**Boundary:** Encrypted.

### `documents.receipt_capture` — Receipt capture

**Current:** planned. **Promised behavior:** Saves receipts from email or photos.

**Build and accept only when:** Deduplicate photo/email receipts and link to purchases using confidence; test split payments, OCR error and missing transaction without forcing a false match.

### `documents.proof_of_income` — Proof of income

**Current:** prepare. **Promised behavior:** Produces a statement of income for a landlord or lender.

**Build and accept only when:** Produce a dated sourced statement with covered accounts and exclusions; distinguish user-provided data from verified payroll and test gig gross versus net income.

**Boundary:** You share it; Current declared rail: Generated statement.

### `documents.account_inventory` — Account inventory

**Current:** planned. **Promised behavior:** A list of every financial account, for you or a trusted person.

**Build and accept only when:** Export ownership/type/provider/status and chosen trusted-person access; never include reusable credentials, and test revoked delegate access and closed accounts.

### `documents.full_export` — Full export

**Current:** read. **Promised behavior:** Everything Upmore holds, downloadable.

**Build and accept only when:** Page through every relevant server/local record and include readable documents plus manifest; test >1,000 rows, table failure and profiles keyed by id, with errors visible.

## Earning (5 capabilities)

**Data/connectors required:** Current official offers, eligibility evidence, commerce/reward APIs, marketplace records and qualifying referral events.

**Execution/handoff required:** Approved offer/marketplace/reward adapters; unique payment/credit ledger and explicit sharing consent.

### `earning.bank_bonuses` — Bank bonuses

**Current:** planned. **Promised behavior:** Matches verified bonuses you qualify for and tracks requirements.

**Build and accept only when:** Use current official offer terms, eligibility lookback, deposit definition, hold periods and tax/fees; track each requirement and posted bonus without risking necessary cash.

**Boundary:** Terms verified and dated.

### `earning.paid_studies_and_testing` — Paid studies and testing

**Current:** planned. **Promised behavior:** Surfaces studies you are eligible for.

**Build and accept only when:** Verify legitimate paid opportunities, location/demographic eligibility and data-sharing terms; distinguish application, acceptance, completion and actual payment.

**Boundary:** Honest screeners only.

### `earning.cashback` — Cashback

**Current:** planned. **Promised behavior:** Tracks and redeems cashback across cards and portals.

**Build and accept only when:** Reconcile card/portal rewards, thresholds, reversals and redemption destinations; test pending versus payable rewards and count each redemption once.

### `earning.sell_what_you_own` — Sell what you own

**Current:** planned. **Promised behavior:** Lists items you no longer need.

**Build and accept only when:** Estimate realistic net proceeds and approved listing scope from confirmed ownership; test fees, shipping, returns and unsold listings before recognizing earnings.

### `earning.referral_earnings` — Referral earnings

**Current:** planned. **Promised behavior:** Tracks Upmore referral rewards and tax reporting.

**Build and accept only when:** Use qualifying paid-user events and a unique reward ledger; test Stripe event replay, zero-paid sessions and payout/credit failure, with appropriate reporting data.

**Boundary:** Tax forms at threshold.

## How the agent communicates (7 capabilities)

**Data/connectors required:** Verified task identity, provider contact/channel details, shared task ledger, user constraints and scoped documents.

**Execution/handoff required:** Messaging/email/telephony/calendar and verified browser adapters with task-specific send/act permission.

### `comms.phone_calls` — Phone calls

**Current:** prepare. **Promised behavior:** Calls companies, waits on hold, negotiates, reports back.

**Build and accept only when:** Use a verified telephony partner, user-authorized company/task and negotiation boundaries; handle identity checks, recording rules, hold time and a reviewable transcript/outcome.

**Boundary:** Discloses it's an AI; no recording without all-party consent; Current declared rail: Drafted script.

### `comms.support_chats` — Support chats

**Current:** planned. **Promised behavior:** Handles merchant and bank chat support.

**Build and accept only when:** Use a verified provider/merchant session with bounded task authority; test MFA, agent handoff and an offer outside allowed terms without accepting it automatically.

### `comms.emails_and_letters` — Emails and letters

**Current:** prepare. **Promised behavior:** Drafts and sends from your own address.

**Build and accept only when:** Separate draft from authorized send, validate recipient and attachment scope, record delivery/mailing evidence; test wrong address and reply threading without leaking documents.

**Boundary:** Sent in your name, so T2 by default; Current declared rail: Drafted message.

### `comms.form_filling` — Form filling

**Current:** prepare. **Promised behavior:** Completes online forms.

**Build and accept only when:** Map confirmed facts to a versioned form and surface signatures/attestations; test hidden fees, changed form fields and prompt injection without silently submitting.

**Boundary:** Never the attestation box; Current declared rail: Prepared form.

### `comms.follow_ups` — Follow-ups

**Current:** planned. **Promised behavior:** Keeps chasing until the task is resolved.

**Build and accept only when:** Maintain case IDs, next-action dates and resolution evidence across channels; stop on resolved/disputed/opt-out state and test duplicate replies and missed deadlines.

### `comms.multi_step_errands` — Multi-step errands

**Current:** planned. **Promised behavior:** "Move all my autopays to the new bank" as one task.

**Build and accept only when:** Model dependencies and per-step authority for tasks such as bank switching; test partial failure, compensation/handoff and report exactly which steps completed.

**Boundary:** Each step logged.

### `comms.scheduling` — Scheduling

**Current:** planned. **Promised behavior:** Books callbacks and appointments with providers.

**Build and accept only when:** Use confirmed timezone, availability, provider restrictions and user consent; test reschedules and duplicate bookings and verify the actual appointment confirmation.

## Matrix maintenance

Update SPEC.md and the generated catalog through their build scripts. Keep build declarations separate from tested connector coverage. Record the exact fixture/contract/live test, date, provider, jurisdiction, outcome and remaining failure cases before changing a feature to shipped. Do not mark planned features implemented solely because a related calculator, generic LLM response or draft exists.
