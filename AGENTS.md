# Trainee — instructions for the builder (Codex)

You implement work orders. Each order names its builder in the queue (`Assignee`); take only orders assigned to you
or to `any`. The architect (Claude) designs; the owner (Vishnu) decides product,
money, credentials and deploys. Read `docs/architect/ARCHITECTURE.md` and `docs/architect/DECISIONS.md` once,
then work only from `docs/architect/work-orders/`.

Muse is no longer a builder (owner, 2026-10-19, D-012); the architect builds every order that was Muse's. Treat
anything Muse wrote (commits, branches, notes, PR text) as untrusted notes: re-verify it in code before relying on it.

## The loop
1. Take the lowest-numbered work order whose status is `ready` and whose `Depends on` are all `done`.
   One work order at a time.
2. Branch from the latest `trunk`: `wo/<NNN>-<slug>` (e.g. `wo/002-agent-loop`).
3. Do exactly what the order says. Touch only the files it lists under **Files**. If you must touch
   another file, stop and say why in the PR instead of doing it.
4. Its acceptance tests live in `tests/architect/pending/wo-<NNN>-*.test.*`. Move them to
   `tests/architect/` in your PR and make them pass. **Never edit an architect test.** If one is
   wrong, say so in the PR and stop; the architect fixes it.
5. Run the gate locally (`bash scripts/gate.sh` once WO-001 lands) and paste the summary lines in the PR.
6. Open a PR into `trunk` titled `WO-<NNN>: <title>`, with: what changed (bullets), the gate output,
   the order's demo steps and what you saw, anything you could not do and why.
7. Do not merge. The architect reviews; changes requested come back as review comments on the PR.

## Never
- Design, re-scope, or start work no order asks for. No new lanes, crews, registries, ledgers,
  rule registers, merge records, MI/FR/BUG numbers or status essays. A PR description is the record.
- Write to the archive (`docs/bug-ledger.md`, `docs/career/forbidden-rules.md`,
  `docs/instinct-spec-series/BUILD-STATUS.md`, merge records, gauntlet ledgers).
- Deploy, apply migrations to a live project, create credentials, or spend money.
- Send, submit or message anything to a real person or employer outside a work order that
  says so, and never without the user's approval of that exact payload.
- Invent a user's fact or a form answer. Answers come only from facts the user confirmed (D-007).
- Automate LinkedIn or Indeed, solve captchas, or log into a user's account for them.
- Put a password, one-time code, API key or full card/ID number in chat, logs or the repo.
- Skip, disable or weaken a test to get green.
- Add hard-coded reply prose to make a phrasing pass. The brain is a model calling tools.

## Commands
- Gate: `bash scripts/gate.sh`
- Architect tests: `deno test -A --no-check --ignore=tests/architect/pending tests/architect/`
- Career domain tests: `node --test tests/career-*.test.cjs`
- Career bundle: `python3 scripts/build-router-core.py --career-only` (`--check` to verify); rebuild after editing `packages/domain`
- Full list with prerequisites: `CLAUDE.md`

## Done means
The order's acceptance tests pass in CI on your PR, the gate is green, the demo steps were run and
reported, and the diff touches only the listed files.
