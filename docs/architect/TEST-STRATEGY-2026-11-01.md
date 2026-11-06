# Test strategy: the ladder (2026-11-01)

Owner ask: "analyze and create the best/cheapest overall way to test and go through the product end to end."

Each rung runs only when every cheaper rung has passed. The cheap rungs run on every change and catch nearly all
regressions. The expensive rungs only check what the cheap ones cannot see: the deployed system, real employer pages,
real model spend and real outcomes. Figures marked *(estimate)* are mine and have not been measured. Everything else was
checked against trunk `8dee444db`.

| Rung | When | Cost per run | What runs | Status |
|---|---|---|---|---|
| R0 | every PR | $0 (runner minutes) | the gate: unit tests, real-Postgres handler flows with the fake model, fixture servers, the Telegram acceptance suite | in CI |
| R1 | every PR | $0 | task-completion eval, fake model, judged by DB state | in CI (`gate (architect)`, since #362) |
| R2 | every deploy candidate | ~$0.6-0.75 *(estimate)* | 38-item held-out set, 5 passes, served brain vs deployed (D-034 S3) | in CI, manual trigger |
| R3 | after every deploy | ~$0 | live synthetic Telegram journeys against production | **new: this PR** |
| R4 | daily | $0 (runner minutes) | live-form dry run on 3 real postings, never submits | **new: this PR** |
| R5 | weekly or on brain changes | ~$1-3 + up to $8 | sealed held-out eval; paid task-completion eval | manual trigger |
| R6 | major releases | owner time | 10 journeys in Telegram Web; real outcomes | manual |

## R0: every PR, $0

**What it proves.** The code paths are correct against a real Postgres 16 with every migration, behind the PostgREST
double (`tests/flow/`). That includes the real `agent-chat` career handler, the real channel webhooks and the
approval-binding SQL. It also proves the apply fill engine works on Greenhouse, Lever and Ashby markup. That covers the
hand-built fixtures in `tests/fixtures/apply-dryrun`, the captured real forms in `tests/fixtures/forms-ci`, which are
40 forms run in `gate (forms-ci coverage)`, and the `tests/fixtures/mock-ats-server.cjs` employer.

**What it cannot prove.**
- Anything about the deployed project: secrets, the webhook registration, pg_cron, Supabase platform behaviour such as
  storage triggers.
- What a real model says.
- What a real employer page looks like today.

**CI checks against the design.** The Telegram acceptance suite is its own required check, `acceptance (telegram)`
(D-034 S4). Every other architect test runs in `gate (architect)`, which has 6 shards. Fixture coverage by provider,
counted by test files that fake the host:

| Provider | Faked in | Status |
|---|---|---|
| Telegram Bot API | `tests/architect/scenarios/telegram-bot-api.ts`, 15 architect files | yes |
| WhatsApp Cloud API (graph.facebook.com) | 6 architect files | yes |
| LoopMessage (iMessage) | 11 architect, 2 node, 4 edge files | yes |
| Gmail | 15 architect files | yes |
| Outlook / Graph | `tests/architect/outlook-fixture.ts`, 3 files | yes |
| Greenhouse / Lever / Ashby forms | fixtures above | yes |
| Workday / SmartRecruiters | fixtures in node and architect suites | yes |
| OpenAI | scripted stand-in at api.openai.com, 28 architect files | yes |
| Vercel Sandbox (cloud runner) | scripted engine stand-in, `tests/architect/cloud-runner.test.ts` | stand-in only |

**R0 gaps found:**
1. **No mutation checks on guards in CI.** `scripts/build-mutation-report.cjs` covers only the old
   `packages/domain` modules and no workflow runs it. Career guards are proven only where a test was written to show the
   guard bites. The two new suites here do that, and I also mutated the R3 scope guard and marker guard once by hand:
   both mutants were caught. *Proposal:* a `evals/depth`-style planted-defect file for each guard in
   `channel_inbound.ts`, `career_apply_cards.ts` and `career_outreach.ts`, run in CI.
2. **Only Telegram has an end-to-end acceptance gate.** WhatsApp and iMessage have flow scenarios
   (`flow-scenarios-channel-delivery`, `-identity`, `-channel-r2`) but nothing equivalent to S4, and R3 is Telegram-only.
   *Proposal:* parametrize `telegram-acceptance.test.ts` over the WhatsApp and LoopMessage adapters.
3. **The cloud preparation worker is never exercised against its real dependency** (a Vercel Sandbox starting the
   engine). R0 uses a stand-in, and R3 seeds the worker's output (see R3).

## R1: every PR, $0 (in CI since #362)

The state-judged task-completion eval landed with #362. It runs the tasks in `evals/career/tasks/tasks.json` (44 today)
through the real `agent-chat` handler on a throwaway Postgres and judges each by the person's rows (`judge.ts`), never by
the reply's wording. `tests/architect/task-completion-eval.test.ts` runs it with the fake model (`fake_model.ts`) for every
brain inside `gate (architect)`, so it gates **every** PR rather than only those touching reply code. That is free and
simpler than a path filter, and the shard balancing absorbs the time.

**What it proves:** compound asks reach the right end state on the code paths when the model plans right.

**What it cannot prove:** that the real model plans right (R5's paid run does that).

## R2: every deploy candidate, ~$0.6-0.75 per measurement (estimate)

`brain-eval.yml` runs the 38-item set (`evals/career/heldout-live.json`, 38 items) for 5 passes of the served brain plus
1 router pass. The workflow's own comment prices a pass at about $0.12, which gives 6 × $0.12 ≈ $0.72 *(estimate)*.
D-034 S3 then compares the candidate's mean with the deployed SHA's.

**Two corrections to the design:**
- **`EVAL_BUDGET_USD` is not a per-run cap.** It is a cumulative cap, currently `"35.50"`, counted against every spend
  already recorded in `evals/career/results/*.json`. A run that would cross it stops, and a stopped run is not a score.
  The per-run cost is bounded only by the set size × passes.
- **Nothing triggers R2 automatically for a deploy candidate.** `brain-eval` runs on a push to `ci/brain-eval` (or by
  manual dispatch), and S3 fails when the candidate has no measurement. Someone, today the architect, has to push the
  candidate to `ci/brain-eval` before cutting `release/production`.

**What it proves:** reply quality on the real model did not regress against the live build.

**What it cannot prove:** end-to-end state on production (that is R3), or the 38 items' blind spots.

## R3: after every deploy, ~$0 (new: `scripts/launch/live-journeys.ts`)

**What it does.** S6 in `deploy-production.yml`, after the live smoke and inside the same step, runs
`deno run -A scripts/launch/live-journeys.ts --live`. Running it inside the smoke step means the existing rollback
condition covers it unchanged. Its FAIL triggers the D-034 rollback to the previous deployed SHA.

The script posts Telegram-shaped updates to `<project>/functions/v1/trainee-telegram`, signed with the
`X-Telegram-Bot-Api-Secret-Token` header (`TELEGRAM_WEBHOOK_SECRET`), for one synthetic chat. It reads the production
database through psql (`SUPABASE_DB_URL`). Every statement must name the synthetic account's user id, contact or login,
or this run's sandbox posting. Anything else is refused before it is sent, and a read that writes is refused too.

**Steps**, each asserted on DB rows:
1. `preflight-synthetic-only`
2. `preflight-stale-postings-swept`: a killed run never reaches its clean-up, so every earlier run's sandbox posting
   (board `trainee-sandbox-*`, link on the `.invalid` host) is deleted here. Anything the synthetic account held that
   pointed at one goes with that account in step 1.
3. `new-account-from-hi`
4. `resume-confirm-one-record`
5. `search-lists-sandbox-posting`, with the posting's own link
6. `fit-confirmed-facts-only`
7. `fit-question-answered`: a KNOWN_GAP, shared with S4 and shrink-only
8. `approval-card-exact-payload`: the card is bound to the payload hash
9. `approve-tap-queues-sandbox-job`: the real `tca:` button tap, one queued job, 0 attempts, no receipt, no cloud
   opt-in, and a second tap adds nothing
10. `status-matches-db`
11. `outreach-draft-not-sent`: a draft only to the person's own imported contact, never approved, send rail empty
12. `reminder-scheduled`: `career:outreach:followups.next_due_at` about 3 days out
13. `alerts-watch-saved`: `career_alert_prefs` on, with the person's words
14. `stop-opts-out`: `channel_contacts.opted_out`
15. `sandbox-posting-private`: no other account has any row, outbox text included, pointing at the sandbox posting
16. `replies-delivered`
17. `cleanup-erases-everything`

**Dry mode** (`--dry`, and `tests/architect/live-journeys.test.ts` in `gate (architect)`) runs the same code over real
HTTP. The target is the real `handleTelegram`, composed as `index.ts` composes it, on loopback, with real `agent-chat`
on a throwaway Postgres, the fake Bot API and the scripted model. A wrong secret header must get a 403. Measured locally:
all 16 journey steps pass (`fit-question-answered` is the expected KNOWN_GAP), 0 outbound requests, 0 Bot API
violations, about 17 s warm. The dry test first runs a journey that is killed just after its prepared application is
written, so its clean-up never runs. The next run's preflight removes that run's account and posting, and nothing
anywhere still points at the posting. A second dry test gives another account a row pointing at the posting, and the
run fails on `sandbox-posting-private`. The posting's privacy is asserted on the stored row and its search vector, not
on the script's text.

The dry run also puts two real-looking people in the same database: a Telegram user made by the product (hi, resume,
yes) and a seeded web sign-up with a Gmail address and a phone. While the sandbox posting is live, the Telegram one
runs five ordinary searches. Those searches must find a real-looking decoy posting, so they are not empty, and must
never list the sandbox posting. After the run and its clean-up, neither person may have a single row, contact or chat
message changed. Mutants run by hand: an erase that deletes every user's rows, and a sandbox posting with real words in
it. Both were caught. The same suite shows each guard bites: an unscoped query, a write disguised as a read, a
real-ATS sandbox host, an unmarked account on the chat, and missing inputs.

**Changes to the design, because the code says otherwise:**
- **Rollback wiring.** R3 lives inside the `smoke` step rather than a new step. `tests/architect/deploy-standard.test.ts`
  evaluates the rollback `if:` with only `golive` and `smoke` known, so a new step id in that condition would break it,
  and that file may not be edited. The step timeout went from 15 to 30 minutes, and 75 + 30 + 35 + 10 ≤ 150 still holds.
- **The sandbox employer is a reserved `.invalid` host (`sandbox-employer.trainee.invalid`, RFC 2606), not a hosted
  fixture.** R3 never fetches the employer page. The approved job stays `queued` because the synthetic person has no
  cloud opt-in and no extension. A host that can never resolve is therefore free and strictly safer. If anything ever
  tried to submit, it would fail at DNS. A hosted fixture is only needed if R3 later drives the cloud preparer. The
  script refuses any sandbox URL on a known ATS host, LinkedIn, Indeed or Handshake.
- **The sandbox posting is private by construction.** Search is a full-text match on title, company, location and
  description that requires every word asked for. So all four fields are nonsense tokens made from the run id
  (`privateTokens`, for example `Zqcpvygxbm`), and only the synthetic account searches for them. No alert keyword can
  match them either. Step `sandbox-posting-private` fails the run if any other account holds a row pointing at the
  posting anyway. A per-account visibility column would be stronger, but it needs a migration and a change to the
  search code, so it is left as a proposal.
- **The preparation worker's output is seeded**, exactly as the S4 suite seeds it: a `career_apply_prepared` row plus
  the `storage.objects` row its trigger requires. The worker drives a browser, so R0 and R4 cover it. This is the one
  seam.
- **"sendMessage got 200" is read from the database, not the chat.** A reply is `delivered` with
  `career_outbox.provider_ids` only after Telegram answered 200 with a message id. A bot cannot read back its own chat.
  STOP's reply is a fixed webhook answer, not an outbox row, so STOP is asserted by `opted_out` only.
- **Without the owner's test chat** the run uses `SYNTHETIC_CHAT` = 2^52 − 1000. Telegram ids have at most 52 bits and
  are assigned upward from small numbers, so no person can receive messages at that id. It asserts each reply's outbox
  row and prints `delivery UNVERIFIED`.
- **Clean-up is a separate verdict.** The synthetic account carries a marker row (`career_watch_kv`
  `synthetic:live-journey`), written the moment the account exists. Clean-up erases only a marked account whose login is
  the chat's own `tg-<id>@users.trainee.invalid`. It deletes every public table's rows for that user id (found from the
  catalog), the storage rows, the contact, the login, and this run's sandbox posting, then proves nothing is left. A
  clean-up that leaves rows exits 3: a warning, not a rollback. The product's journeys passed, and the next run's
  preflight erases the leftovers. If the chat belongs to an unmarked account, the run is refused and nothing is touched.

**What R3 writes to production:** one synthetic account, its turns (about 16 of the 60-per-hour turn limit), one sandbox
posting, and one seeded prepared application. The sandbox posting is dated 30 days before it is first seen, so the alert
planner never treats it as news for anyone. Everything is erased at the end.

**What R3 never does:** submit to an employer, send an email, act on LinkedIn or Indeed, or make a model call beyond what
the deployed router makes itself (one short networking draft, < $0.01 *(estimate)*).

**What it proves:** the deployed functions, secrets, webhook, migrations and pg_cron-independent paths work together for
a whole first week, on the real project.

**What it cannot prove:**
- That replies read well (R2 and R6 cover that).
- That the cloud preparer or a real submission works (R4 and R6).
- Other channels.

**Exit codes:** 0 PASS, 1 FAIL (rollback), 2 NOT RUN (a warning, never a pass), 3 PASS with clean-up incomplete
(a warning). NOT RUN covers both an input missing and `LIVE_JOURNEY_ENABLED` not set to `true`.

## R4: daily, ~$0 (new: `scripts/launch/live-form-dryrun.ts`, `.github/workflows/live-form-dryrun.yml`)

**What it does.** Once a day, `pick-form-sources.cjs` picks one real public posting each on Greenhouse, Lever and Ashby
(the biggest boards' first postings, so the employers stay stable). Chromium opens each application page. The worker's
own fill code (`ats-fill.cjs`) fills only a synthetic person's facts: name, email, phone and a synthetic resume. No
employer question is answered. That person is pinned: Casey Dryrun, `casey.dryrun@example.invalid`, the fictional
`+1 555 010 0199`. The script refuses to start with anything else. The test pins the values, checks that a real-looking
address, phone or name is refused, and reads back every value typed into the fixture pages. The run then screenshots the page, finds the submit control and stops.

**Three independent locks against submitting:**
1. The network allows only GET and HEAD, plus Ashby's read-only GraphQL queries (`render-form.cjs readOnly`). Every
   post, mutation, upload and autosave is aborted and listed. That includes the page's own background fetch, XHR,
   beacon and PUT; the test has a page that sends all four on load and on every keystroke. No service worker may run
   (`serviceWorkers: "block"`). The test page's worker POSTs on its own, and a control test shows it does run when
   workers are allowed.
2. An init script cancels and counts every submit event, every click on a submit control, and every
   `form.submit()`/`requestSubmit()`. Any count above zero fails the run.
3. The script's source contains no click, press, tap, keyboard or submit call. `tests/architect/live-form-dryrun.test.ts`
   checks this and runs the guard against local fixtures. Those fixtures report every press of their submit button and
   every Enter in a field by pointerdown and keydown, before the guard. The test also includes a Greenhouse form whose
   submission would be a GET (one the network rule alone would let through) and a page that submits itself while being
   filled.

**Drift** fails the run. It means any of the following: no form; no email field or no resume upload; no submit control;
a fact that did not land; a read-back or fill error; an unknown question kind; or the posting's field set differing from
yesterday's (kept in the Actions cache). A bot check or a closed posting is reported, not counted as drift. Drift is
reported once: today's field set becomes tomorrow's baseline.

**Change to the design:** R4 runs on a **GitHub-hosted runner, not Vercel Sandbox minutes**. `form-capture.yml` already
shows CI can reach the job sites, and a GitHub runner costs nothing within the included minutes. Fall back to Vercel
Sandbox only if datacenter IPs start getting bot-checked.

**Not verified live from here:** this sandbox's proxy refuses the job sites (403), so the first real run is the first
scheduled run.

**What it proves:** the fill engine still reads today's real forms.

**What it cannot prove:** that a submission is accepted (R6), or that custom questions are answered well.

## R5: weekly or on brain changes, ~$1-3

- **Sealed held-out set:** `sealed-set-rewrap.yml` and PR #269.
- **Paid task-completion eval:** `brain-eval.yml -f suite=tasks` (on trunk since #362) runs the router, staged, planner
  and agent brains on the real model. Each brain is capped by `TASKS_BUDGET_USD` (`"2.00"`), so one run costs up to $8.
  Each brain's command ends in `|| true`, so a brain that stops at its cap or errors does not fail the workflow. Its
  result file says so; a stopped run is not a score, and the result files must be read.

**What it proves:** the brain on unseen sentences, and real task completion on the real model.

## R6: human, major releases only

The architect drives Telegram Web in the owner's signed-in browser through the 10 journeys: R3's first week plus files,
voice, a WhatsApp/iMessage hand-off and an interview prep. The owner produces the real outcomes himself: his own
applications through the product, and a real outreach email from his own mailbox.

**What it proves:** the product does the job for a real person. Nothing cheaper can prove that.

## Cost per month (all estimates)

Assumptions: about 60 PRs, 10 deploys, 30 days and 4 weeks a month.

| Rung | Per run | Per month |
|---|---|---|
| R0 + R1 | ~100-150 runner-min per PR (8 gate jobs + acceptance + typechecks) | $0 inside GitHub's included minutes; past them ~$0.8-1.2 per PR at about $0.008/min |
| R2 | ~$0.72 | ~$7 |
| R3 | <$0.01 model + negligible function invocations | <$0.10 |
| R4 | ~3-5 runner-min | ~100-150 runner-min, $0 inside the included minutes |
| R5 | ~$1-3 held-out + up to $8 tasks | ~$4-12 + up to $32 |
| R6 | owner and architect time | $0 money |

**Total:** roughly **$11-20 a month of model spend** without the weekly paid task eval, and up to about **$52** with it,
plus runner minutes.

## Owner inputs needed

1. **Allow the synthetic chat to sign up, then turn R3 on.** R3 is **off until you switch it on**: without the
   `production` environment secret `LIVE_JOURNEY_ENABLED=true` it prints NOT RUN and never rolls back. To turn it on:
   - Add `telegram:4503599627369496` (the `SYNTHETIC_CHAT`), or your test chat's id, to the production secret
     `TRAINEE_ALLOWED_CONTACTS`, then let go-live push secrets. Alternatively set `TRAINEE_SIGNUP=open`.
   - Then set `LIVE_JOURNEY_ENABLED=true`.

   Switched on without the allowlist entry, R3 fails at its first step and the deploy rolls back.
2. **Optional, for verified delivery.** Make a second Telegram account, press Start on the bot, and store its chat id as
   the `production` environment secret `LIVE_JOURNEY_TELEGRAM_CHAT_ID`. Also add `telegram:<that id>` to
   `TRAINEE_ALLOWED_CONTACTS`. Without it R3 runs with delivery UNVERIFIED.
3. **No other new secret.** R3 also reuses `SUPABASE_PROJECT_REF`, `TELEGRAM_WEBHOOK_SECRET` and `SUPABASE_DB_URL`. R4
   needs no secret.
4. **R6:** your time on major releases.
