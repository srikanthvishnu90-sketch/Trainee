# Staging package — one-command staging deploy for the Upmore career build

**Status: PREPARED, NEVER EXECUTED.** This package was built and verified offline
(syntax checks + `--dry-run` only). Nobody has created a staging project, run a
migration, deployed a function, or set a secret with it. Deploying is the owner's
hand (gauntlet ledger, Stage 4.6). Tier definitions and the rule that only
STAGING-tier results count toward release claims: `docs/career/gauntlet-ledger.md`.

## (a) What the staging environment is

A **separate Supabase project that the owner creates**, used with **test accounts
only and never production data**. It exists so the career build can be graded
through its real deployed message path (a live `agent-chat` answering real HTTP
requests), which the in-process harness cannot prove.

Hard safety property, built into every script in `staging/scripts/`:

- The production project **`mrwngntwmnaqrqhupvlt` is never touched by any
  script.** Every script checks its target ref before doing anything and
  **refuses to run if the target ref equals the production ref** (exit 64, with
  the refusal printed). The Sporv ref (`aveqjeafghmwafkbbnor`) is refused the
  same way. The check is inline in each script — grep any of them for `REFUSE`.
- No script sets, prints, or stores a secret value. Scripts check secret
  **names** only.
- No script spends anything. The only paid surface it can ever reach is the
  model-provider key the owner puts on the staging project, used by real chat
  turns the owner or the graded runner send.

## (b) Architecture

### Edge functions deployed (the career-relevant set)

Enumerated from `supabase/functions/` at the package's base commit. Exactly
three functions deploy to staging v1:

| Function | Why it is in the set | Deploy mode | verify_jwt |
| --- | --- | --- | --- |
| `agent-chat` | The chat entry: `POST /functions/v1/agent-chat {message}` → `{thread_id, reply, action}`. The career chain (packages/domain modules 120–143) is bundled into `_shared/router_core.js` by `scripts/build-router-core.py` and imported from there. | **Whole-tree** with the entrypoint workaround (below) | `true` |
| `gmail-oauth` | The career grant flow: `start_career`, purpose-routed callback, per-source `status`/`disconnect` (`supabase/functions/gmail-oauth/career.ts`, consumed by `120-career-access.js`). Provider row `google_career`, vault name `oauth_google_career_<uid>` — no migration needed for it (see `docs/career/deploy-checklist-access.md`). | Per-directory, stock `sb.py` | `true` |

JWT settings are stated as data in `deploy-functions.sh` and copied from the
production configuration documented in `docs/career/phase-a-audit-2026-10-13.md`
§1 and `supabase/config.toml` (`agent-chat` = true in config.toml and in prod;
the other two have no config.toml entry, i.e. platform default true, and the
access checklist says keep JWT verification ON for `gmail-oauth`).

**Not deployed to staging v1** (everything else in `supabase/functions/`):
finance rails (`plaid`, `plaid-sync`, `simplefin-claim`, `simplefin-proxy`,
`stripe-checkout`, `stripe-credits`, `stripe-webhook`), messaging rails
(`imessage-inbound`, `agent-message-inbound`, `agent-message-turn`,
`agent-message-worker`), `agent-payments`, `agent-proactive`, `agent-workflows`,
`broker-oauth-start`, `broker-oauth-callback`, `cancel-watcher`,
`delete-account`, `exec-vault-store`, `manual-connect`, `model-health`,
`news-feed`. None is on the career chat path; each would drag in its own
secrets and providers for zero graded value. `_shared/` is not a function — it
ships inside the `agent-chat` whole-tree bundle.

**The entrypoint workaround (implemented programmatically in
`deploy-functions.sh`):** stock `sb.py` hardcodes
`"entrypoint_path": "index.ts"`, so it cannot deploy a function whose entry is
reached as `<slug>/index.ts` from the `supabase/functions` root — and
`agent-chat` must deploy from that root, because it imports `../_shared/*`. The documented workaround (access
checklist, TOOLS.md 2026-10-12): copy `sb.py` to `/tmp`, change that one field
to `<slug>/index.ts` in the copy, deploy with the copy passing
`supabase/functions` as the directory. The script does exactly this, verifies
the rewrite landed before deploying, and never modifies the installed `sb.py`.
`gmail-oauth` imports only `./` siblings plus remote modules
(verified: zero `../` imports), so stock per-directory deploy is correct for
them — the same conclusion the access checklist reaches for `gmail-oauth`.

### Database

`migrate.sh` applies, in order:

1. `staging/sql/000-bootstrap-preexisting-tables.sql` — **read its header before
   running anything.** Eight tables the functions use are created by no
   migration in this repo (they predate production's migration history), and the
   very first migration references `public.profiles(id)`, so a fresh project
   fails immediately without a bootstrap. The bootstrap creates the six the
   career set needs (`profiles`, `agent_threads`, `agent_messages`, `routes`,
   `listings`, `route_reminders`) with minimum columns + owner RLS inferred
   from code reads. This is gap **G3** below — it is an inference, not a copy
   of production's schema.
2. Every file in `supabase/migrations/` in `ls` (lexical) order — 69 files at
   the base commit, first `20260923_000001_agent_rate_limits.sql`, last
   `20261012060000_oauth_vault_cascade.sql`. Application is one `sb.py query`
   call per whole file, stops on first failure, and is tracked in a
   package-local ledger table (`public.upmore_staging_migrations`) because the
   Management API query path has no migration ledger of its own. End
   verification: the ledger tops at the last migration file and a
   tables-exist probe returns 6/6.

Assumption (gap G8): a fresh supabase.com project provides the `auth` schema,
the `vault` schema/secrets table, and the `supabase_realtime` publication that
several migrations reference. True for hosted Supabase; the migrations were
only ever tested locally against `tests/db/stubs.sql` recreating those.

### Secrets — required BY NAME ONLY

Derived from the deployed code's env reads (never invented; values are the
owner's and appear nowhere in this package):

| Secret name | Read by | Where the owner obtains it |
| --- | --- | --- |
| `OPENAI_API_KEY` | `_shared/model_gateway.ts` (default provider is OpenAI; a missing key fails as OpenAI, by design) | Owner's OpenAI account → platform.openai.com → API keys. This is a staging-only key spend-wise: real chat turns on staging bill to it. |
| `GOOGLE_OAUTH_CLIENT_ID` | `gmail-oauth/index.ts` | Google Cloud Console → the project holding the existing Upmore OAuth client → Credentials. See the staging-client decision in `OWNER-CHECKLIST.md` (recommended: a separate staging client whose redirect URI is `https://<staging-ref>.supabase.co/functions/v1/gmail-oauth`). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `gmail-oauth/index.ts` | Same place as the client ID. |
| `OAUTH_STATE_SECRET` | `gmail-oauth/index.ts` (HMAC-signs the OAuth state) | Owner generates it: `openssl rand -hex 32`. |

Platform-provided on every Supabase project — **never set by hand**:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

Optional, deliberately NOT required for staging v1: `MODEL_PROVIDER` (leave
unset — defaults to OpenAI; the owner ruled 2026-10-12 that this app runs on
OpenAI only, `model_gateway.ts`), `OPENAI_MODEL` / `OPENAI_ROUTER_MODEL` /
`OPENAI_REASONING_EFFORT` (code defaults exist), `ANTHROPIC_API_KEY` (only read
if `MODEL_PROVIDER=anthropic` — do not set), `BROWSERBASE_API_KEY` /
`BROWSERBASE_PROJECT_ID` (browser execution, formerly read by the removed `agent-exec`; the chat
smoke and reply grading do not need them — add only when doorstep/apply flows
are graded at STAGING tier).

Scope check the owner must also do (from the access checklist): the staging
Google client's consent screen must allow `gmail.readonly`, `gmail.send`,
`calendar.freebusy`, `calendar.events`; if the client is in Google "testing"
mode, the gauntlet test user must be on its test-user list, or the career
consent fails with an unverified-scope error.

### Frontend surface — the honest option

**Picked: a local app build against the staging function URL.** Reason, and
why the alternative is dangerous: the app template hardcodes the **production**
backend (`src/upmore-app-template.html`: `UPMORE_BACKEND_URL =
"https://mrwngntwmnaqrqhupvlt.supabase.co"` plus the production anon key, and
`src/build-app.py` has no environment parameterization). A Vercel git preview
would therefore render the career UI while silently talking to **production** —
the worst possible staging property. So:

1. In a staging checkout, change exactly those two constants in
   `src/upmore-app-template.html` to the staging project URL and the staging
   anon key (dashboard → Settings → API).
2. `python3 src/build-app.py` (regenerates `index.html`, per AGENTS.md — never
   edit `index.html` directly).
3. Serve the repo root at `http://localhost:8000` (`python3 -m http.server
   8000`). Port 8000 is not arbitrary: `localhost:8000` is in the hardcoded
   CORS allowlists of both deployed functions (`agent-chat/_shared/
   chat_cors.ts`, `gmail-oauth/index.ts`).

The graded runner does not need the frontend at all — it talks HTTP to
`agent-chat` directly (see `RUNNER-REPOINT.md`). The frontend is only for the
owner's own eyes. One known wart (gap G5): `gmail-oauth`'s post-consent landing
(`APP_URL`) is hardcoded to the production app URL, so after a staging career
grant the browser lands on the production app page; the grant itself is
recorded server-side in the staging project before the redirect.

## (c) The exact single command + pre-flight

Pre-flight — each step one line, in order:

1. Create the staging Supabase project (dashboard, owner's org) → note its ref.
2. Create the staging Google OAuth client (or add the staging redirect URI) → have its client ID + secret ready.
3. Generate the state secret: `openssl rand -hex 32` → have it ready.
4. Set the four required secrets on the staging project (dashboard → Edge Functions → Secrets, or `sb.py secrets-set` with `SUPABASE_REF` = the staging ref — never the default).
5. Run the one command below.
6. Read the smoke result it prints last (`PASS smoke` / `FAIL smoke`).

The exact single command (one line, from the repo root of a checkout of the
branch carrying this package):

```
STAGING_REF=<staging-project-ref> bash staging/scripts/staging-up.sh
```

It runs, in order: secret-name presence check (stops before touching anything
if a required name is missing) → `migrate.sh` → `deploy-functions.sh` →
`seed.sh` → `smoke.sh`. Add `--dry-run` to the same line to print every step
without executing. The test-account password for the run is generated inside
the one command and printed once (test account only).

## (d) What happens after

Once the smoke passes, the graded suites re-point at staging per
`staging/RUNNER-REPOINT.md`: the env contract is `UPMORE_CHAT_URL` /
`UPMORE_TEST_JWT` (the repo's existing live-gauntlet convention), the 16 pilot
cases re-run first, then the grand re-run's worst cases, then the full set —
and every record from then on carries `tier: "STAGING"` or `tier: "HARNESS"`
forever. Harness results never count toward release claims again.

## Gaps and undecided points (named, not papered over)

- **G1 — staging deploys the finance handler, not a career chat path (the big
  one).** Audit D-10: the production `agent-chat/handler.ts` has **no career
  route and no composer** (`grep -i career` over the production chat sources =
  zero matches). This package deploys that same handler to staging. The smoke
  therefore proves transport + auth + reply hygiene only; a career message is
  answered by the finance/model path. Closing D-10 (handler wiring) is a
  separate, owner-gated change — until it lands, STAGING-tier *career* grading
  cannot start no matter how green the smoke is.
- **G2 — modules 130/141/143 are not in the deployed bundle.**
  `scripts/build-router-core.py`'s module list ends at `142-career-router.js`;
  `130-career-onboarding.js`, `141-career-doorstep.js` and
  `143-career-containment.js` are absent from `router_core.js`. The harness
  loads them directly from `packages/domain/`; a handler wired only through
  `router_core.js` would not have them. Bundle list must be extended (and the
  bundle rebuilt + `--check` re-run) as part of closing G1.
- **G3 — pre-existing production tables are not in any migration.** Bootstrap
  SQL is minimum-inferred from code reads (see its header). Production's exact
  columns, indexes and RLS policies for `profiles`, `agent_threads`,
  `agent_messages`, `routes`, `listings`, `route_reminders` exist nowhere in
  this repo. If a staging turn fails on a missing column, the fix is to extend
  the bootstrap from the error — do not "fix" it by pointing at production.
- **G4 — frontend backend constants are hardcoded to production** (template
  lines for `UPMORE_BACKEND_URL` / `UPMORE_ANON_KEY`; `build-app.py` takes no
  env). The local-build recipe above is a manual two-line change per staging
  checkout; parameterizing the build is an undecided code change.
- **G5 — `gmail-oauth` landing URL is hardcoded to the production app**
  (`APP_URL` in `gmail-oauth/index.ts`). Staging grants record correctly but
  land the browser on the production app.
- **G6 — `sb.py query` surfaces only one statement's result** for
  multi-statement input (repo-known quirk). `migrate.sh` therefore applies one
  whole file per call and verifies via the ledger + probes in following calls,
  not via the apply call's own output.
- **G7 — no migration ledger exists on the Management API path.** The
  package-local ledger table is the record; if the owner ever also runs the
  Supabase CLI against staging, the two ledgers will disagree (CLI tracks
  `supabase_migrations.schema_migrations`). Pick one tool per project:
  this package.
- **G8 — fresh-project platform assumptions** (auth/vault schemas, realtime
  publication) are stated in §Database; they hold for hosted Supabase and are
  unverifiable offline.
- **G9 — the default test email `gauntlet-staging@example.test`** uses a
  reserved TLD; GoTrue admin create with `email_confirm: true` should accept
  it, but this is unverified offline. Fallback is one env var
  (`STAGING_TEST_EMAIL=<owner's +alias address>`) — decided by whoever runs
  seed first, no code change.
- **Decisions left to the owner** (with recommended defaults) are listed in
  `staging/OWNER-CHECKLIST.md`: staging OAuth client vs. shared client,
  LoopMessage number (recommended NO for v1), project tier/region.
