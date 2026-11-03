# Mass apply: measured time and cost per application (2026-11-01)

Source: `tests/architect/flow-mass-apply-telegram.test.ts`, run with `MASS_TIMING`.

**What the run covered.** The run used the production path a phone-only person takes:
- The Telegram webhook, then agent-chat.
- One message: "apply to the top 12 frontend internships in Chicago".
- The hosted preparation, which runs the engine's dry run on each form.
- Questions asked one at a time over Telegram.
- One card, one tap.
- The cloud dispatcher with its send sandboxes. Each sandbox runs `scripts/apply.ts --submit --approved`.

**What it ran against.** The employers were 12 postings on local Greenhouse, Lever and Ashby form servers (`tests/helpers/ats_world.ts`):
- one captcha;
- one required question added after the approval;
- one posting closed after the approval.

**Where it ran.** One shared build container with a load average of about 18 from other sessions. Treat the times as upper bounds. Nothing reached a real employer, and no model was called.

## Measured (N = 12)

| What | Measured |
|---|---|
| Ask: "top 12 … in Chicago" to 12 queued | 0.27 s |
| Preparation, from the ask to every application prepared | 147 s wall. This includes the 21 questions the TEST person answered over Telegram, every shared fact asked once. |
| Preparation sandboxes | 2 sandboxes, 139.6 s in all. That is **11.6 s of sandbox time per posting**, almost all of it the browser dry run that reads the form. |
| Send sandboxes | 11 sandboxes, 125.7 s in all. That is **11.4 s per application**, one sandbox each. |
| Sends in flight at once | 2. The dispatcher started 2 per tick in this configuration. |
| Model calls, preparation and send | **0**. Answers come only from confirmed facts and the person's own answers. |
| End to end, 12 applications including the cap step | 259 s |
| Outcomes | Submitted with the page's confirmation: 7 (1 confirmation id read). Captcha: needs_user, nothing sent. Question added after approval: not_submitted / needs_answers, nothing sent. Closed posting: not sent. Held by a portal pause: 2, nothing sent. No employer received a second application. |

**N = 10:** about 3.6 min wall, by the same per-application figures.

**N = 50: not measured.** In this harness the portal gate waiver allows at most 5 sends per portal. The projection from the measured per-application figures, at 2 sandboxes each for preparation and send:
- preparation: 50 × 11.6 s / 2, about 4.8 min;
- sending: 50 × 11.4 s / 2, about 4.8 min;
- total: about **10 min wall**, plus the person's answers.

## Cost per application (an ESTIMATE: single-run sandbox times × Vercel's published rates, not a bill)

Rates: Vercel Sandbox, Pro, iad1, from https://vercel.com/docs/sandbox/pricing (fetched 2026-11-01):
- Active CPU: $0.128 per hour.
- Memory: $0.0212 per GB-hour, with a 1-minute minimum per sandbox.
- Creations: $0.60 per million.

The sandbox is 2 vCPU and 4 GB, as `supabase/functions/_shared/cloud_runner.ts` creates it.

| Item | Per application |
|---|---|
| CPU, upper bound (assumes 100% busy): (11.6 + 11.4) s × 2 vCPU | $0.0016 |
| Memory: preparation 4 GB × 11.6 s, plus the send billed at the 1-minute minimum (4 GB × 60 s) | $0.0017 |
| Sandbox creations (about 1.2 per application) | ≈ $0.000001 |
| Model tokens | $0 |
| **Total, estimated upper bound** | **≈ $0.0033** |

**For 120 applications in one hour:**
- Cost: about **$0.40**.
- Sandbox time needed: 120 × 23 s, about 46 sandbox-minutes per hour. That is about one sandbox busy on average, so 2–4 concurrent is enough.
- Host rate: across the three ATS hosts, 120 per hour is 40 per host per hour, one every 90 s per host. That is a sane per-host rate.

**Making it cheaper:**
- Batch a person's sends into one sandbox per host round instead of one sandbox per send. That removes the 1-minute memory minimum and lowers the cost to about $0.002 per application.
- Read the form schema from the public board APIs instead of the browser dry run (design item 1, below). That removes the 11.6 s preparation sandbox per posting, leaving about $0.0015 per application.

## What stands between this and 60–120 per hour (found by this run)

1. **One failure pauses a whole ATS.**
   - The cloud throttle (`career_apply_cloud_events`) paused Lever after a single failure, a posting that closed after approval.
   - The rest of that person's Lever applications were held (`portal_paused`), or refused before Submit (`CARD_CLOUD_AUTH_REFUSED`). Nothing was sent wrongly, but 2 of 12 did not go.
   - A closed posting should not count as a portal failure.
2. **Portal gate.**
   - Until a portal has proven sends, each person needs a waiver: `career_apply_cloud_gate_waivers`, with `max_sends` from 1 to 5.
   - At most 5 per ATS per waiver blocks a 50-application batch.
3. **Dispatch rate.** The dispatcher started 2 sends per tick. With the production tick once a minute, the ceiling is 120 per hour. Starts per tick need room above 2.
4. **Two cards for one batch.**
   - A 1-item card reached the chat while the other 11 were still being prepared. Then the 12-item card came, sent 3 times as the same card.
   - Tapping the old card approves nothing, which the test checks. It is still noise. The card should wait until the batch is prepared.
5. **Preparation is a browser per posting.** This is the 11.6 s and the main compute cost. Greenhouse's boards API (`?questions=true`) already describes the form; see `scripts/career/capture-greenhouse-questions.cjs`. The Lever and Ashby posting APIs do the same. Reading the schema from them, cached, would need no browser.
6. **Confirmation ids.** The page's confirmation was recorded for every send, but the id was read only on Ashby's page (1 of 7). The Greenhouse and Lever confirmation texts are not parsed into an id.
7. **The person's own browser (extension, tier a).** Not measured here. It costs us zero compute. It is the cheapest tier for people whose computer is on.

## The design to build toward (coordinator, 2026-11-01), checked against the code

| Design | Today in the code | Gap |
|---|---|---|
| Form schemas from the public board APIs, cached | The browser dry run reads every form (`prepare-runner.ts` → `approve-first.ts prepare`) | Not built. The board readers exist only for discovery (`packages/domain/121-career-jobs.js`) and question capture (`scripts/career/capture-greenhouse-questions.cjs`). |
| Answers deterministic from confirmed facts and an answer bank, asked once | Built: 21 questions for 12 applications, no question twice, 0 model calls | Ashby's per-posting essay ("something you've built") is asked once per posting |
| Model only for genuinely new free text, cheapest model, cached by question | Cover letters only, opt-in (`prepare-ahead.ts --draft-cover-letters`, gpt-5-nano default in `model_gateway.ts`) | No cache by normalized question for essays |
| Tailoring per role cluster | Per posting (`career_tailor.ts`) | Not built |
| One batch card, one yes | Built (one tap approved 12, bound to each hash) | The early 1-item card (gap 4 above) |
| Tiers: extension, then cloud, then needs_user | Cloud built and measured here; needs_user for captcha proven; extension person-submits proven on captured forms | Extension submit for Ashby untested (RAMP-APPLY-TRACE) |

## Follow-up (feat/mass-apply-throughput-20261101): the gaps, measured

| Gap | Before | After |
|---|---|---|
| 1. One closed posting paused a whole ATS | A 404 posting was recorded `error`. The throttle paused the ATS for 6 h after one error in a small window. Measured: 2 of 12 held. | The engine reports `POSTING_CLOSED` at open, before anything is filled. The worker records it as `not_sent`. The failure-rate rule now needs ≥ 20 attempts (migration 20261101120000). The bot-check rules are unchanged. Measured: the closed posting held nothing. |
| 2. Waiver max 5 | — | Kept: the owner's D-010 safety cap, the first test batch per portal until 3 confirmed applications open the gate. Not a scale limit once a portal's gate is open. |
| 3. 2 sends per tick | `LIMIT_DEFAULTS` are infrastructure sizing for the first rollout wave (2 starts per tick, 2 at once, 1 per portal) | Unchanged defaults. Mass settings come from env: `CLOUD_MAX_STARTS_PER_TICK`, `CLOUD_MAX_CONCURRENT`, `CLOUD_MAX_PER_PORTAL`. The e2e runs at 4/4/2. Throughput at the 1-minute production tick: starts per tick × 60 per hour. 120 per hour needs ≥ 2 per tick, with at most `CLOUD_MAX_PER_PORTAL` on one ATS at once. |
| 4. Early 1-item card | Measured: 2 distinct cards per batch. Cause: the card push caps text at 4,000 characters, so a 12-item ready set fitted 1. | The push is held while a question is open or another posting is still waiting to be prepared. A ready set that does not fit one message gets "All N are ready, say show my applications" instead. Measured: 1 distinct card. |
| 5. Browser per posting for the schema | Measured with `MASS_NO_SCHEMA=1`: 24 browser dry runs for 12 postings, 174.7 s of preparation sandbox time (14.6 s per posting) | Wired as the safe version: Greenhouse's boards-API schema (33 ms, cached) asks the shared `fact:*` questions with no browser pass; the browser still builds the payload once. Measured: **20 browser runs** (one pass saved per Greenhouse posting in ask-then-ready) and 109.0 s of preparation sandbox time (9.1 s per posting). Lever and Ashby fall back to the browser. |

The before and after runs were on the same day and container, at different load averages. The browser-run count (24 → 20) is the load-independent figure. **Estimated cost per application after:** preparation 9.1 s + send 13.8 s (166.1 s / 12 sends) on 2 vCPU / 4 GB, with the send billed at the 1-minute memory minimum, comes to about $0.0031. That is an estimate from these single-run times and the published rates, not a bill.

### Review round (browser crashes, consecutive failures): three local runs on one head, one at a time

| Run | Head | Load (1 min) | Total | Engine starts for 12 sends | Browser preparation runs | Model calls |
|---|---|---|---|---|---|---|
| 1 | 630e5da9 | 12.2 | 323.8 s | 12 | 20 | 0 |
| 2 | 4479fb4f | 27.8 | 378.6 s | 15 | 21 | 0 |
| 3 | 4479fb4f | 7.3 | 257.9 s | 12 | 20 | 0 |

Root cause of the earlier `DRIVER_ERROR` failures: the container ran out of memory and CPU (load up to ~117 while other
suites ran beside the e2e); Chromium died or timed out. Nothing in the flow was wrong. The engine now records the
browser's own error (`driver_error`) in the evidence, so the cause is visible on the row. Run 2 shows the guard working:
3 sends crashed before Submit was authorized (nothing reached the employer) and were driven once more (15 engine starts,
12 sends, all exactly once). A crash after Submit was authorized is never resent: it is `unknown_outcome` and the
person is asked. A preparation crash is recorded `error` and tried again after 30 minutes, not parked for 7 days.
