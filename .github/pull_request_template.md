<!-- The flow: docs/architect/PROCESS.md. A PR that does not fill this in is not reviewed. -->

**Agent:** <!-- who built this: codex, claude-architect, owner, ... (WIP limit: 2 open PRs per agent) -->
**Work order / issue:** <!-- WO-NNN, a fix's failing test, or a doc finding -->

## What changed (one change)

## Checklist
- [ ] One change: the title needs no "and".
- [ ] Within the size cap (800 changed lines or 25 files, generated files excluded), or the reason it cannot split is here.
- [ ] Based on a **green** trunk SHA: `<sha>`; targets `trunk` (no stacked PR, no merge train).
- [ ] No test was skipped, disabled, weakened or edited to pass; architect tests unedited.
- [ ] New or changed tests take the clock as an input (no verdict reads the real date).
- [ ] No secret, password or one-time code in the diff, the description or logs.
- [ ] Reply code touched? (`scripts/launch/reply-code.ts`) yes / no. If yes, the next release needs a reply measurement (S3).
- [ ] Migration touched? yes / no.

## Gate / test output
<!-- the gate's SUMMARY lines, or each command run with its pass/fail counts; NOT_RUN where a tool was missing, and why -->

## Demo
<!-- the order's demo steps and what you saw; for a site/ or File page change, the preview link or a screenshot -->

## Reviewer, at merge (S2)
<!-- Approve on GitHub at the head SHA if you can. Otherwise, right after merging, add one line to
docs/architect/approvals.txt in a ledger-only PR: `<PR> <40-hex merged head SHA> <reviewer> [note]`.
Never the author, never the merging account, never a backfill. -->
- Reviewed head SHA:
- Approval: GitHub review / ledger line
