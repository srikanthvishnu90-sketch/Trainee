# Trainee

Trainee is a personal career agent for job seekers. Over text (Telegram, WhatsApp, iMessage/SMS) it learns who the
person is from facts they confirm, finds matching openings, prepares tailored applications, and applies **only after
the person says yes** to the exact application shown. It also drafts and, after approval, sends networking outreach
from the person's own mailbox, tracks replies, and hosts shareable "File" pages. Every action ends with proof the
person can see; the product never says something happened unless the employer's or provider's own record shows it.

Who it is for: anybody looking for work (D-004). The product name is Trainee (D-005); some code identifiers still carry
older names and are not renamed.

## What is in this repo

| Path | What it is |
|---|---|
| `supabase/functions/` | Edge functions. The Trainee ones: `agent-chat` (the conversation brain and handlers), `trainee-inbound`, `trainee-telegram`, `trainee-telegram-link`, `trainee-whatsapp`, `trainee-deliver`, `trainee-report`, `trainee-file`, `trainee-connect`, `career-ingest`, `career-proactive`, `career-send`, `career-cloud-runner`, `career-email-code`, `career-essay-draft`, `agent-exec`, `gmail-oauth`, `outlook-oauth`, `extension-sync`, `site-signup`, `site-careers`, `delete-account`, plus `_shared/`. |
| `supabase/migrations/` | Database migrations (additive; applied only by the release path). |
| `tests/architect/` | The architect's acceptance tests (Deno), one file per work order or behaviour. |
| `tests/` (`career-*.test.cjs`, `tests/edge/`, `tests/db/`) | Node suites, edge tests, and SQL migration/RLS tests. |
| `evals/career/` | The career eval harness, held-out sets and score log (`SCORE-LOG.md`). |
| `site/`, `api/`, `vercel.json` | The public site (`site/index.html`, `site/privacy.html`), and the Vercel proxies for `/file` (`api/file.js`) and `/connect` (`api/connect.js`), wired by the rewrites in `vercel.json`. |
| `extension/` | The browser extension that fills Greenhouse, Lever and Ashby applications in the person's own browser. |
| `scripts/` , `scripts/launch/` | Gate, shard and build scripts; the owner's release and go-live scripts. |
| `docs/architect/` | Architecture, `DECISIONS.md`, work orders, feature specs. |
| `docs/launch/` | Go-live and owner runbooks. |

## Where to start

- Architecture: `docs/architect/ARCHITECTURE.md`. Owner rulings: `docs/architect/DECISIONS.md`.
- Feature specs: `docs/architect/specs/` (`MASS-APPLY-SPEC-2026-10-27.md`, `NETWORKING-SPEC-2026-10-27.md`,
  `TASK-INTELLIGENCE-SPEC-2026-10-27.md`).
- Work orders and the queue: `docs/architect/work-orders/README.md`.
- Release: `docs/launch/TRAINEE-GO-LIVE.md` (owner only; agents never deploy).
- Working rules for agents: `CLAUDE.md` (architect) and `AGENTS.md` (builders).

## Checks

The CI gate is `bash scripts/gate.sh`; CI (`.github/workflows/ci.yml`) runs it partitioned (core, browser, architect,
forms-ci coverage) plus the database job (`bash tests/db/run.sh`), the send-rail load test and the Telegram
acceptance suite. See `CLAUDE.md` for the exact commands.

## Upmore (removed)

This repo began as Upmore, a finance agent. Trainee does not use the Upmore app (owner decision), and it was removed:
its finance edge functions, finance domain modules, testing evidence, finance tests and evals, `UPMORE-APP-README.md`,
`SPEC.md`, `BUILD_PLAN.md`, `PROMPT.md` and `LOOP.md`. What remains is not a product claim: the Trainee dashboard and
approval-card code still lives in the old app shell (`src/`, the root `index.html`; Vercel serves `site/` instead), a
few frozen history files (`docs/bug-ledger.md`, `docs/career/forbidden-rules.md`, `docs/instinct-spec-series/`), and
Upmore-era names on Trainee code (for example `packages/domain/*-career-*.js`, `UPMORE_*` environment variable names).
