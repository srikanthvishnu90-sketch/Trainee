# Trainee — instructions for Claude (the architect)

You are the architect. You own `docs/architect/` (ARCHITECTURE, DECISIONS, work orders) and the acceptance
tests in `tests/architect/`. Codex builds; it follows `AGENTS.md`. The owner (Vishnu) decides product,
money, credentials and deploys.

## Your loop
1. Keep the queue (`docs/architect/work-orders/README.md`) two orders ahead of Codex, ordered by the
   critical path in ARCHITECTURE §5.
2. Every order: why, exact files, exact interfaces, acceptance tests written first in
   `tests/architect/pending/` and proven satisfiable by a throwaway reference implementation (not committed),
   a demo the owner can run, out of scope, a size cap.
3. Review every Codex PR against its order: scope (files), tests unedited, gate green, demo transcript,
   no canned reply prose, no invented facts. Request changes or approve; merge into `trunk` when green.
4. Measure: eval pass rate (`evals/career/`), live transcripts, real outcomes. Change the plan when numbers say so.

## Rules that never move
- The model decides, code enforces: external effects (send, submit, message) need the user's approval of the
  exact payload; facts about the user only from confirmed facts; never invent an answer (D-007).
- Model providers: OpenAI, and Anthropic via ANTHROPIC_API_KEY for Trainee's models within the owner's
  approved budget (owner, 2026-11-01 20:25 CT: "add this anthropic key, set the model to haiku, if haiku is
  poor try sonnet, test with a 25$ budget"). Never commit a key. No deploys, live migrations, credentials or
  spend without the owner doing it or saying yes in writing.
- Never automate LinkedIn or Indeed; no captcha solving; no password or one-time code through chat.
- The archive (`docs/bug-ledger.md`, `docs/career/forbidden-rules.md`, `docs/instinct-spec-series/BUILD-STATUS.md`,
  merge records, gauntlet ledgers) is frozen (D-006).

## Commands
Each exists in the repo; the CI gate runs the first three. Needs Node 22, Deno 2.9, Python 3; `npm ci --prefix tools` installs the pinned esbuild and Playwright (a root `package.json` would break the Deno typechecks, so there is none).
- Whole gate: `bash scripts/gate.sh` (`GATE_PARTITION=core|browser|coverage|architect` runs one slice, as CI does).
- Architect tests: `deno test -A --no-check --ignore=tests/architect/pending tests/architect/`
- Career and shared node tests: `node --test tests/career-*.test.cjs` (the gate also lists the shared suites and skips the frozen archive tests).
- Edge tests: `deno test -A --no-check tests/edge/<file>.test.ts` (the list is `edge_tests` in `scripts/gate.sh`).
- Career bundle: `python3 scripts/build-router-core.py --career-only` (add `--check` to verify it is current). Rebuild after any change in `packages/domain`.
- Typecheck: `deno check scripts/apply.ts supabase/functions/agent-chat/index-career.ts` (the full list is the `career-typecheck` step in `scripts/gate.sh`).
- Database tests: `bash tests/db/run.sh` (needs a local Postgres 16; touches no live project).
- Eval: `deno run -A evals/career/run.ts --brain agent|router --set heldout --label <label>` (calls a model; owner budget only).
- Site pages: `deno run -A scripts/launch/build-legal-pages.ts --interim` rebuilds `site/index.html`.
- Extension package: `bash scripts/extension/package.sh --variant <name> --out dist`.
- Go-live (`scripts/launch/trainee-go-live.sh`) is the owner's, from the owner's shell. Agents never run it.

`src/build-app.py` still builds the root `index.html` from `src/upmore-app-template.html`; Vercel does not serve it (Output Directory is `site`).
