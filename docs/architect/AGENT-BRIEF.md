# Agent brief (architect, 2026-11-10): read this before you start

You are one of about 30 parallel agents working for the architect (coordinator) session `session_01PFWkFQw6UhTp5ynR1DAV2h` on
the Trainee repo. The goal: bring each of the owner's 15 release items to its bar with literal evidence
(`docs/architect/VERIFICATION-15.md`, PR #669). Speed matters, and so does accuracy: a number you cannot reproduce is not evidence.

## Rules that never move (CLAUDE.md and AGENTS.md bind you; read both)
- No deploys, no live migrations, no production environment variables, no secrets, no live employer submissions, and no real
  messages to real people. Every browser run is a dry run (`scripts/browser-eval/strict.cjs` style: non-GET aborted, submits
  trapped, stopped before the click).
- Never weaken, skip or delete a test. Never edit `tests/architect/*` to make it pass. A pinned test that blocks a correct fix
  goes to the coordinator for a ruling; wait for the ruling. Adding new architect tests is fine.
- Never invent a fact about a person (D-007). Never claim an action without proof (D-024). Never automate LinkedIn or Indeed.
  Never solve or get around a captcha or bot wall; a shown check is handed to the person.
- Model spend: Claude only, and at most $5 of paid eval per agent. Prefer the scripted or staged brains in tests.

## How to work
1. Branch: `ag/<your-task-id>` from `origin/trunk` (or from the base your task names). One PR to trunk per task, small (about 400
   lines; split if larger).
2. Stay inside the files your task names. If you must touch a shared file (handler-career.ts, parallel-apply.cjs, ats-fill.cjs,
   file_family*.ts, router bundles), make the smallest change, rebase on trunk right before you open the PR, and say so in
   the PR body. If the coordinator says another agent owns that file, send your patch to that agent instead.
3. Build the loop first: a test or script that prints one number against your bar. Measure the baseline. Fix the biggest
   cause, re-measure, and keep only changes that raise the number without any regression.
4. Run the affected tests locally as a non-root user (create one if needed). Postgres 16 binaries: `PGBIN=/usr/lib/postgresql/16/bin`.
   Deno flow tests: `--import-map=tests/flow/supabase-npm.json`. Disk is limited: delete your own temporary files.
5. The PR body holds the baseline, the result, the bar, the commands to reproduce it, and the CI run ID. Do not merge; the
   coordinator merges.
6. Report with `send_message` to the coordinator: at most 6 lines with the numbers, the PR link and what is next. Report when
   you open a PR, when you need a ruling, and when you are done. Never end a turn idle while a CI run you started is going:
   wait on it with a background loop (`until` its status is completed; `sleep 60`).
7. Commit with the attribution lines your system reminder gives.

## Shared facts
- CI cannot be re-run or dispatched from these sandboxes (403). To re-trigger, push a new commit. Artifact downloads are
  blocked; put the numbers you need in the job log.
- Real job sites are reachable only from CI. Run the browser benchmark by pushing a branch named `bench/browser-<name>` that
  carries `.github/workflows/browser-bench.yml` (copy it from branch `bench/browser-strict5`).
- Strict benchmark history (220 real postings): 14, 14, 15, 15, 35, 37 of 220 (run 6 is 42719264485). Agent 1
  (`session_01PFWkFRmxppF9Hk2WkfDZbA`) is the browser lead and owns PR #668.
- Agent 2 (`session_01PFWkFSfWut8Y4gSxdVB6YG`) owns responses, resumes, Files serving S0 and the app-layer loop
  (#672, #673, #674). Agent 3 (`session_01PFWkFRgXQKXEahCp963ZTU`) owns discovery (8) and memory (9).

## Merge tips (added 2026-11-10 01:37)
- Every PR that adds an architect test conflicts on the shard durations table. Resolve it with `git checkout --theirs` on the
  table, then `architect-shards.ts update <your jsonl>`, then rebuild the router bundles if you touched packages/domain
  (`python3 scripts/build-router-core.py`), and push.
- Merged so far today: #666, #667, #670, #671, #673, #675, #677. Rebase on trunk before you open or update a PR.
