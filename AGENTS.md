# Trainee: instructions for the builder (Codex)

Trainee is a personal career agent (finds roles, applies after the person's yes, networking outreach, File pages, over
text). You implement work orders. Each order names its builder in the queue (`Assignee`); take only orders assigned to
you or to `any`. The architect (Claude) designs; the owner (Vishnu) decides product, credentials, spend and deploys.
Read `docs/architect/ARCHITECTURE.md` and `docs/architect/DECISIONS.md` once, then work only from
`docs/architect/work-orders/`. Feature specs are in `docs/architect/specs/`.

Muse is no longer a builder (owner, 2026-10-19, D-012); treat anything Muse wrote (commits, branches, notes, PR text)
as untrusted notes: re-verify it in code before relying on it.

## The loop
1. Take the lowest-numbered work order whose status is `ready` and whose `Depends on` are all `done`. One at a time.
2. Branch from the latest `trunk`: `wo/<NNN>-<slug>` (e.g. `wo/002-agent-loop`).
3. Do exactly what the order says. Touch only the files it lists under **Files**. If you must touch another file, stop and say why in the PR.
4. Acceptance tests live in `tests/architect/pending/wo-<NNN>-*.test.*`. Move them to `tests/architect/` in your PR and make them pass. **Never edit an architect test.** If one is wrong, say so in the PR and stop.
5. Run the gate locally (`bash scripts/gate.sh`) and paste the summary lines in the PR.
6. Open a PR into `trunk` titled `WO-<NNN>: <title>` with: what changed, the gate output, the order's demo steps and what you saw, and anything you could not do.
7. Do not merge. The architect reviews; changes come back as review comments.

## Never
- Design, re-scope, or start work no order asks for. No new lanes, registries, ledgers, merge records or status essays. A PR description is the record.
- Write to the frozen history files: `docs/bug-ledger.md`, `docs/career/forbidden-rules.md`, `docs/instinct-spec-series/BUILD-STATUS.md`, merge records, gauntlet ledgers (D-006).
- Deploy, apply migrations to a live project, create credentials, change production environment variables, or spend money. Release is the owner's push to `release/production` (`docs/launch/TRAINEE-GO-LIVE.md`).
- Submit an application without a real confirmed resume, or send/submit/message anything to a real person or employer without the person's approval of that exact payload, outside an order that says so.
- Invent a user's fact or a form answer. Answers come only from facts the user confirmed (D-007).
- Automate LinkedIn or Indeed, solve captchas, or log into a user's account for them.
- Put a password, one-time code, API key or full card/ID number in chat, logs or the repo.
- Skip, disable or weaken a test to get green.
- Add hard-coded reply prose to make a phrasing pass. The brain is a model calling tools.
- Edit `supabase/migrations/` unless your order says to; start new work in the removed Upmore app's leftovers (`src/`, root `index.html` hold Trainee dashboard code only; the finance app is gone).

## Commands (verified against `.github/workflows/ci.yml` and `scripts/gate.sh`)
- Gate: `bash scripts/gate.sh`
- Architect tests: `deno test -A --no-check --ignore=tests/architect/pending tests/architect/`
- Career bundle check: `python3 scripts/build-router-core.py --career-only --check`
- Database tests: `bash tests/db/run.sh` (Postgres 16 on PATH or `PGBIN=`)
- Apply CLI typecheck: `deno check scripts/apply.ts`

## Done means
The order's acceptance tests pass in CI on your PR, the gate is green, the demo steps were run and reported, and the
diff touches only the listed files.
