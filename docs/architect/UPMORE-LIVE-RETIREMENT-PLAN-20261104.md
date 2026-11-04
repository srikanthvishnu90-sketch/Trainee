# Upmore live retirement plan (2026-11-04)

**DRAFT - nothing run - the owner decides retirement.**

Nothing in this file was executed. The live Supabase project, its functions, its cron jobs, its secrets and Vercel were NOT read or touched while writing it. Everything below is derived from the repository only (trunk `be8d70e7`), so it says what MAY be running, not what IS. Step 0 below is how the owner finds out. Every command is for the owner to run himself, after he has decided. The PR that removes the code from the repository (#452) deploys and undeploys nothing; this plan is the separate, live half.

## Sources used (repo only)
- `UPMORE_ONLY_FNS` in `scripts/launch/trainee-go-live.sh` (20 names; go-live refuses to deploy any of them).
- `docs/architect/REMOVAL-LIST-2026-10-28.md` section 3 ("about 16 still ACTIVE live", the 3 legacy cron jobs) and `docs/architect/BACKEND-GAP-MAP-2026-10-23.md` (cron jobs listed as `cancel-watcher-daily`, `plaid-sync-6h`, `upmore-proactive`).
- The deleted finance deploy script `scripts/launch/go-live.sh` (on trunk; removed by #452), which deployed `agent-chat`, `broker-oauth-start`, `broker-oauth-callback`, `model-health`, `agent-proactive`, `exec-vault-store`, `agent-exec`, `manual-connect`, and `scripts/launch/schedule-proactive.sql` (job `upmore-proactive`, minute 7 hourly).
- Git history: first commit of each function (`git log --diff-filter=A -- supabase/functions/<fn>/index.ts`), `supabase/config.toml` `verify_jwt` blocks on trunk, `Deno.env.get` names in each function's source.
- `scripts/launch/unschedule-legacy-finance.sql` (the owner-run allowlist unschedule) and `scripts/launch/secrets-audit.sh` (it lists no Upmore finance secret: the Trainee audit does not know them).
- `docs/architect/FEATURES.md` line 365: "stripe-checkout, stripe-credits and stripe-webhook are Upmore finance functions the go-live refuses to deploy (live v46/v47 are legacy)".

Not available from the repo: which of these are deployed right now, their live versions, the live `cron.job` rows, the live secret names, Stripe's and Plaid's webhook endpoint settings. All of these are steps the owner does himself.

## Step 0 - read-only inventory (owner runs; changes nothing)
```
supabase functions list --project-ref <ref>                       # which of the 20 exist, and their versions
psql "$SUPABASE_DB_URL" -X -c "select jobid, jobname, schedule from cron.job order by jobname"   # prints no command text (a command can hold a token)
supabase secrets list --project-ref <ref>                          # names only
```
Stripe dashboard > Developers > Webhooks: which endpoint URLs point at `/functions/v1/stripe-webhook`. Plaid dashboard: any webhook URL. Compare with the table below, then decide per row.

## Before anything is retired: keep a way back
The code for every function below is deleted from trunk by #452. A function deleted on the live project can only be redeployed from code that still exists, so create the archive tag first (see `UPMORE-ARCHIVE-TAG` section at the end) and confirm it resolves. Rollback for every row = `git checkout upmore-archive-2026-11-04 -- supabase/functions/<fn> supabase/functions/_shared` into a scratch clone, then `supabase functions deploy <fn> --project-ref <ref>` (with `--no-verify-jwt` for those marked "no JWT"), then re-add its cron job and secrets. Secrets are never recoverable from the repo; if one was deleted, it has to be re-created from the provider.

## The functions

Columns: what it did, whether Trainee needs it, risk of retiring it, deploy flag it needs on redeploy (from `supabase/config.toml` on trunk / its header).

| # | Function | What it did (from its source) | Trainee needs it? | Risk of retiring |
|---|---|---|---|---|
| 1 | `agent-exec` | Upmore real-world execution agent: runs a merchant cancel playbook in Browserbase; reads a Gmail grant (`GOOGLE_OAUTH_*`, `BROWSERBASE_*`). JWT required. | No. Trainee never calls it. `gmail-oauth/career.ts` comments name it as "a finance-era leftover the owner may retire". | Low. Only the Upmore app calls it; the app shell is not served (to confirm, see #452 body). Any Gmail grants issued with the legacy purpose stay in their tables; nothing reads them after. |
| 2 | `agent-message-inbound` | Upmore LoopMessage webhook endpoint (`UPMORE_MESSAGE_WEBHOOK_SECRET`, `LOOPMESSAGE_UPMORE_ORGANIZATION_ID`). No JWT. Header comment: "configure in the provider only after verified". | No. Trainee texts arrive at `trainee-inbound`. | Medium if a LoopMessage webhook still points at it: LoopMessage would get 404 and retry/disable. Check LoopMessage's webhook URL first. |
| 3 | `agent-message-turn` | Upmore message turn (bundles the old finance brain `agent-chat/handler.ts`). No JWT. | No. | Low. Called by the Upmore message worker only. |
| 4 | `agent-message-worker` | Upmore outbox/inbox worker (`AGENT_MESSAGE_WORKER_SECRET`), delivery through message transports. No JWT. | No. Trainee delivery is `trainee-deliver`. | Medium if a cron job or provider calls it on a schedule; Step 0 shows. |
| 5 | `agent-payments` | Scheduler-only payment worker; "unconfigured production routes remain disabled and cannot move money" (`AGENT_PAYMENT_WORKER_SECRET`). No JWT. | No. AGENTS.md: money paths stay gated. | Low (it cannot move money by its own header). Retiring REMOVES a money-path surface. |
| 6 | `agent-proactive` | Hourly "agent speaks first" run: alerts, weekly recap, morning brief, manual-connect health, into the Upmore chat. Called by pg_cron job **`upmore-proactive`** (`7 * * * *`) with a bearer/secret header read from Vault (`upmore_proactive_secret`, per the deleted `schedule-proactive.sql`). No JWT. | No. Trainee's equivalent is `career-proactive`. | **Cron calls it hourly**: retire the cron job FIRST, else pg_net logs a 404 every hour. Header token is read from Vault; one job embeds a bearer token (REMOVAL-LIST SEC9). |
| 7 | `agent-workflows` | Upmore bill/subscription workflow API for the app (`UPMORE_ALLOWED_ORIGINS`; CORS for upmore Vercel origins). JWT required. | No. | Low. Callers: the Upmore app shell only (`src/bill-workflow-ui.js`, `src/financial-review.js`, still in the repo but not served as far as the repo shows). |
| 8 | `broker-oauth-callback` | Brokerage connect step 2 (redirect target of the broker's OAuth). No JWT; signed state is the auth. | No. | Medium: a broker OAuth app registered with this redirect URL would fail for anyone mid-flow. No Trainee user can be mid-flow. |
| 9 | `broker-oauth-start` | Brokerage connect step 1 (returns the broker's approval URL). JWT required. | No. | Low. |
| 10 | `cancel-watcher` | Server-side billing-cycle confirmation for cancel claims against synced SimpleFIN transactions (`CANCEL_WATCHER_SECRET`). Called by pg_cron job **`cancel-watcher-daily`**. | No. | **Cron calls it daily.** Retire the job first. |
| 11 | `exec-vault-store` | Stores the email used to sign in to a merchant in Supabase Vault (never a password). JWT required. | No. | Low. Existing Vault rows are untouched by deleting the function. |
| 12 | `manual-connect` | Guided manual connect: Browserbase live sign-in window and Vault session store. JWT required. `packages/domain/78-manual-connect.js` (kept) only describes it in a comment. | No (Trainee's Connect page is `trainee-connect`). | Low. |
| 13 | `news-feed` | Finance headlines + market snapshot (GET, no secrets, no JWT). | No. | Low. Public GET; anything calling it gets 404. The kept app shell contains a URL to it (dead code). |
| 14 | `plaid` | Server-side Plaid integration (link_token, status, spend cap; `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`). | No. | Medium: if a Plaid webhook URL targets it, Plaid will see failures. Check Plaid dashboard. |
| 15 | `plaid-sync` | Background Plaid sync every 6 h (`PLAID_SYNC_SECRET`). Called by pg_cron job **`plaid-sync-6h`** (REMOVAL-LIST: answers 401 on every run, O2). | No. | **Cron calls it every 6 h.** Retire the job first. |
| 16 | `simplefin-claim` | One-time SimpleFIN Setup Token claim; stores the Access URL in Vault. JWT required. | No. | Low. |
| 17 | `simplefin-proxy` | SimpleFIN proxy: reads the vaulted Access URL, returns sanitized accounts/transactions. JWT required. | No. | Low. |
| 18 | `stripe-checkout` | Creates a Stripe Checkout session for the $10/mo subscription (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`); CORS allow-list is the Upmore Vercel origin + localhost. JWT required. | **Not found calling it** in site/, api/, extension, workers, any Trainee function. FEATURES.md 365: "There is no Trainee checkout". But `career_billing.ts` tells users to "use the Subscribe button, which opens Stripe's secure checkout": the repo contains no Trainee Subscribe button and no function that creates the session apart from this one. **QUESTION for the owner.** | Medium: if real subscribers were created through it, removing the only checkout creator stops new subscriptions. |
| 19 | `stripe-credits` | Pushes unapplied referral credits to the Stripe Customer Balance; called by the Upmore frontend after `qualify_referral()` succeeds. JWT required. | No Trainee caller. Trainee's referral credit logic is inside `stripe_webhook.ts` (`credit_pending_referral`). | Low. |
| 20 | `stripe-webhook` | Stripe events -> `billing_sync_subscription`; referral credits (signature check, `STRIPE_WEBHOOK_SECRET`). No JWT. | **Its code is Trainee's billing** (`_shared/stripe_webhook.ts` is exercised by `tests/architect/scenarios-billing-*.test.ts`, `flow-scenarios-billing-*.test.ts`, `tests/db/billing_webhook_sync.test.sql`; `career_billing.ts` and `account_delete.ts` rely on its semantics). #452 KEEPS the code. But it is in `UPMORE_ONLY_FNS`, so go-live refuses to deploy it. See the question below. | **High.** If a Stripe endpoint points at it, deleting it makes Stripe retry for days and then disable the endpoint; subscription state stops syncing, cancels/renewals drift. Do NOT retire without an owner decision on where Stripe events go. |

### Open question (owner) - stripe-webhook
Go-live refuses to deploy `stripe-webhook` (it is in `UPMORE_ONLY_FNS`) and FEATURES.md calls it an Upmore finance function whose live version is "legacy", yet trunk carries a large Trainee billing implementation behind it (billing-by-text, cancel-at-period-end, round 2, referral credits). Decide one of: (a) Trainee launches billing: move `stripe-webhook` out of `UPMORE_ONLY_FNS`, add it to `DEPLOY_FNS`, deploy it from trunk, and never delete it; or (b) Trainee has no billing at launch: retire it with the others and leave the billing code dormant. This plan keeps row 20 OUT of the default retirement batch until you answer.

## Cron jobs (pg_cron) that may exist
Per the repo (REMOVAL-LIST, BACKEND-GAP-MAP, `unschedule-legacy-finance.sql`), the live `cron.job` held exactly three legacy jobs and no migration in `supabase/migrations/` schedules any of them (they were created by hand / the deleted `schedule-proactive.sql`):

| Job name | Schedule | Calls | Notes |
|---|---|---|---|
| `upmore-proactive` | `7 * * * *` (hourly) | `agent-proactive` | secret from Vault `upmore_proactive_secret` (deleted `schedule-proactive.sql`) |
| `plaid-sync-6h` | every 6 h | `plaid-sync` | answers 401 on each run (REMOVAL-LIST O2) |
| `cancel-watcher-daily` | daily | `cancel-watcher` | |

Trainee's own jobs (do NOT touch): see `scripts/launch/schedule-career-ingest.sql`, `schedule-career-proactive.sql`, `schedule-career-cloud.sql`, `schedule-trainee-deliver.sql`, `schedule-ops-monitor.sql`.

## Secrets that may exist for these functions (names only, from source)
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_SYNC_SECRET`, `CANCEL_WATCHER_SECRET`, `AGENT_PAYMENT_WORKER_SECRET`, `AGENT_MESSAGE_WORKER_SECRET`, `UPMORE_MESSAGE_WEBHOOK_SECRET`, `LOOPMESSAGE_UPMORE_ORGANIZATION_ID`, `UPMORE_ALLOWED_ORIGINS`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`; Vault secret `upmore_proactive_secret`; per-user Vault rows `exec_cred_<userId>_*`. Shared with Trainee (do NOT delete): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (Gmail connect), `SUPABASE_*`; `STRIPE_*` too if row 20 is kept. `scripts/launch/secrets-audit.sh` does not list any of the Upmore-only ones.

## Suggested order (owner runs; each step independent and reversible except the deletions)
1. Step 0 inventory. Create and push the archive tag (below) and verify it.
2. Decide the stripe-webhook question and the stripe-checkout question.
3. Stop the callers: unschedule the three cron jobs. Using the repo's own allowlist script (it prints names and schedules only; it touches nothing not named):
```
psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 \
  -v allow=upmore-proactive,plaid-sync-6h,cancel-watcher-daily \
  -f scripts/launch/unschedule-legacy-finance.sql
```
   Verify: `psql "$SUPABASE_DB_URL" -X -c "select jobname, schedule from cron.job order by jobname"` lists none of the three and still lists the Trainee jobs. Rollback: re-run the original schedule file from the archive tag (`git show upmore-archive-2026-11-04:scripts/launch/schedule-proactive.sql` for `upmore-proactive`; the other two were created by hand, so note their command from Step 0 before removing them: `select jobname, schedule, command from cron.job` shows the command; keep it private, it can hold a token).
4. Point external webhooks away or confirm none: Stripe endpoint list, Plaid, LoopMessage, broker OAuth redirect URIs.
5. Watch for a day (Supabase function logs for 404s on the retired names, `net._http_response` for cron errors) before deleting.
6. Delete the functions, in this order: schedulers/workers first, then the rest. Run only the rows you decided on:
```
supabase functions delete agent-proactive          --project-ref <ref>
supabase functions delete plaid-sync               --project-ref <ref>
supabase functions delete cancel-watcher           --project-ref <ref>
supabase functions delete agent-message-worker     --project-ref <ref>
supabase functions delete agent-message-inbound    --project-ref <ref>
supabase functions delete agent-message-turn       --project-ref <ref>
supabase functions delete agent-payments           --project-ref <ref>
supabase functions delete agent-workflows          --project-ref <ref>
supabase functions delete agent-exec               --project-ref <ref>
supabase functions delete exec-vault-store         --project-ref <ref>
supabase functions delete manual-connect           --project-ref <ref>
supabase functions delete broker-oauth-start       --project-ref <ref>
supabase functions delete broker-oauth-callback    --project-ref <ref>
supabase functions delete plaid                    --project-ref <ref>
supabase functions delete simplefin-claim          --project-ref <ref>
supabase functions delete simplefin-proxy          --project-ref <ref>
supabase functions delete news-feed                --project-ref <ref>
supabase functions delete stripe-credits           --project-ref <ref>
# only after the questions above are answered:
supabase functions delete stripe-checkout          --project-ref <ref>
# supabase functions delete stripe-webhook         --project-ref <ref>   # HOLD: see open question
```
   Verify: `supabase functions list --project-ref <ref>` shows only Trainee functions (the `DEPLOY_FNS` set printed by `bash scripts/launch/trainee-go-live.sh --dry-run ...`), then `node scripts/launch/trainee-smoke.cjs` as go-live runs it. Rollback: per the "keep a way back" section.
7. Secrets last, after a quiet week: `supabase secrets unset <NAME> --project-ref <ref>` for names only the retired functions read (list above; never the shared ones). Rollback: the value comes from the provider's dashboard, not the repo.
8. Database objects (finance tables, definer functions with anon grants - audit SEC2) are NOT covered here: migrations must stay (the DB harness applies them). Dropping tables is a separate decision.

## Not covered / risks to remember
- Function deletion on Supabase is not reversible except by redeploying code: the tag is the only copy once a history rewrite lands (see below).
- Any Stripe subscription created through the legacy checkout keeps charging whether or not these functions exist. Retiring the code does not cancel anyone.
- `docs/architect/HISTORY-CLEANUP-PLAN-20261104.md` rewrites every SHA. Tag AFTER that rewrite (or re-tag with the commit-map), otherwise the tag points at a commit that no longer exists on the rewritten history.

## UPMORE-ARCHIVE-TAG (DRAFT - do not run)
Where it should live: **a tag in this repository** (recommended), not a separate archive repository.
- Tag in this repo: keeps the full finance history reachable from one URL, costs nothing, `git checkout upmore-archive-2026-11-04 -- supabase/functions/<fn>` is the rollback path used above, and the code stays beside the migrations that still apply. Trade-off: the repository stays public and heavy (the finance code is in every clone) and a tag name is only as durable as the history: a rewrite changes the SHA the tag points at.
- Separate archive repository (e.g. private `Trainee-upmore-archive`, a `git push --mirror`-style copy of trunk at that commit): keeps Trainee's working repo free of finance reachability only if combined with a rewrite that drops it, and it survives a rewrite of this repo unchanged. Trade-off: a second place to keep secure and in sync, and rollback becomes a clone-and-copy.
- Recommended: tag here now, and ALSO push the same commit to a private archive repo if the history rewrite is going ahead, since the rewrite is what can orphan the tag.

Commands (DRAFT; the tag points at trunk as it is BEFORE #452 merges; take the SHA from trunk at that moment):
```
git fetch origin
git rev-parse origin/trunk                      # note this SHA; it must be the last commit that still has the Upmore code
git tag -a upmore-archive-2026-11-04 origin/trunk \
  -m "Upmore finance agent, last trunk commit before its removal (PR #452). Archive for rollback of live Upmore functions; see docs/architect/UPMORE-LIVE-RETIREMENT-PLAN-20261104.md"
git show upmore-archive-2026-11-04 --stat | head       # verify it is annotated and points where intended
git push origin refs/tags/upmore-archive-2026-11-04   # a single tag; never --tags
# optional private archive repo (create it first, empty, private):
git push git@github.com:srikanthvishnu90-sketch/<archive-repo>.git refs/tags/upmore-archive-2026-11-04:refs/tags/upmore-archive-2026-11-04
```
If #452 merges first, tag the merge's first parent instead (`git rev-parse <merge-sha>^1`) so the tag still has the Upmore code; check with `git cat-file -e <tag>:supabase/functions/plaid/index.ts`.
Interaction with the history rewrite: a `git filter-repo` run changes every SHA; the tag would then point to a commit that exists only in the old objects. Order: (1) tag, (2) rewrite, (3) re-create the tag from the commit-map (`git tag -f -a upmore-archive-2026-11-04 <new-sha> -m ...` and a force-push of that one tag, which is the owner's call) or tag only after the rewrite; GitHub keeps the old commit reachable through cached pull refs, not through anything you can rely on.
