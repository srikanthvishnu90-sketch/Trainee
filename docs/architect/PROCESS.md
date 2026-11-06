# The development flow (owner, 2026-11-04)

Why: on 2026-11-04 about 80 PRs were open, many two weeks old and conflicting; agents opened stacked PRs and merge
trains; trunk went red from clock-dependent tests and from two green PRs colliding; PRs branched from a red trunk
inherited red CI; S2 approvals were backfilled at release time; three releases rolled back on a smoke bug (fixed in
#482); a frontend change could ship only inside a 100-merge backend release. These rules keep that from recurring. They
add process around the deploy standard (D-034, S1-S6); they change none of it.

## The rules

1. **One change per PR.** One work order, one fix or one doc. A PR that needs "and" in its title is two PRs.
2. **Size cap: 800 changed lines or 25 files**, generated files excluded (router bundle, lockfiles, shard-duration
   tables, eval results, generated docs JSON: the list is `GENERATED` in `scripts/ci/pr-hygiene.cjs`). Over the cap,
   split it; when it cannot split (a migration with its tests), the reviewer adds the `size-exception` label and says why.
3. **Max age: 7 days without a new commit.** Then the author rebases it on a green trunk or it is closed. The
   `stale` label marks it; the owner or architect closes what nobody rebases within 3 more days.
4. **No stacked PRs, no merge trains, no integration branches.** Every PR targets `trunk` and is branched from a trunk
   commit. Work that depends on an unmerged PR waits for it to merge. ("Integrate #N into #M" commits are a merge train.)
5. **Branch and rebase only from a green trunk.** Green = every `ci` check on that trunk SHA concluded success. If trunk
   is red, the only PRs that merge are the ones that make it green again, and nobody rebases onto it meanwhile.
6. **Tests take the clock as an input.** A verdict never depends on the day the suite runs: pass `now` (or pin it) the
   way the repo already does: `evals/career/tasks/clock.ts` (`pinClock`, `evalNow`), `tests/flow/db_clock.ts` (database
   clock rules), `pinWallClock` in `tests/career-clock-source-guard.test.cjs`. A date literal without a year ("November
   3") is read relative to the pinned clock, never the real one (#461, #441 were this bug).
7. **Merge method: merge commit or squash, never rebase-merge.** S2 finds each PR by its first-parent merge commit
   (`Merge pull request #N` or `title (#N)`); a rebase-merge leaves commits that name no PR, and S2 fails them.
8. **WIP limit: 2 open PRs per agent** (one in review, one being built) and **15 open PRs in total**. An agent whose PR is
   red, `conflicting` or `stale` fixes that before opening another. The PR template's `Agent:` line names the agent.

## S2 is written at merge, not at release

S2 (`scripts/launch/deploy-standard.ts`) needs, for every PR merged since the last deploy, an independent approval at
the exact merged head SHA. The reviewer gives it **when the PR merges**:

1. Review the PR against its work order (CLAUDE.md "Your loop", step 3). Note the head SHA you reviewed.
2. If you can, approve it on GitHub (an APPROVED review at that head by an owner, member or collaborator who is not the
   author). That is S2 by itself.
3. Otherwise (the architect and builder push from one account, so GitHub refuses a self-review): merge, then in the same
   sitting add one line to `docs/architect/approvals.txt`, `<PR> <40-hex merged head SHA> <reviewer> [note]`, in a PR
   whose diff only adds ledger lines (exempt from needing its own approval). The reviewer is never the author and never
   the account that merged. One line per PR, written after that PR's own review; never backdated, never a backfill.
4. A push to the PR after your review needs a new review and a new line: S2 counts only the merged head.

Enforced by `.github/workflows/pr-hygiene.yml` job "S2 approvals since the last deploy": on every trunk push it runs
`deploy-standard.ts --checks S2` on the trunk tip (read only) and labels each merged PR it reports without an approval
`needs-s2-approval`, with a comment. Unlabelled trunk = S2 already holds for the next release. The deploy standard still
judges S2 itself at release; nothing here replaces it.

## Release cadence: small and often

- **Release whenever trunk is green and the S2 job shows no `needs-s2-approval` PR**, and there is something merged:
  aim for **at most 10 merges per release** and at least one release a day on days with merges. The owner pushes that
  trunk SHA to `release/production` and approves the `production` environment, exactly as today.
- Why 10: S3 lets a reply measurement stand for a candidate whose first-parent ancestors within 10 commits have the same
  reply code. A release of a few merges with no reply-code change reuses the last measurement (no eval spend, no 80-minute
  wait); a 100-merge batch never can, and a failure in it cannot be pinned to one change.
- The release PR's ledger line (`docs/architect/approvals.txt`) merges on trunk BEFORE the release PR merges (and before
  the push to `release/production`). S2 waits up to 30 minutes (`--wait-ledger 30`) for a line that is still landing, but
  that is a safety net, not the process.
- A failed release is not retried with more merges stacked on it: fix forward with one PR, or release the previous green SHA.

## Shipping a presentation-only change fast, inside the standard

"Presentation-only": `site/`, `api/file.js`, `api/connect.js`, `vercel.json`, or the File page's own markup and styles.
What it still needs, and why each part stays:

| Check | Still needed | What makes it cheap |
|---|---|---|
| S1 required CI on the SHA | yes | The released SHA is a trunk SHA whose `ci` checks already ran on its trunk push (or in the merge queue); only the preflight runs again, as on every release. |
| S2 approval at merged head | yes | Written at merge (above), so nothing is waiting at release. |
| S3 reply quality | only if reply code changed | `site/` and `api/` are not reply code (`scripts/launch/reply-code.ts`): a small release reuses the last measurement. |
| S4 Telegram acceptance | yes | Already a CI check on the SHA. |
| S5 nothing enabled and NOT_WIRED | yes | Reads secret names; seconds. |
| S6 live smoke, rollback on failure | yes | Unchanged; the false-rollback bug was fixed in #482. |

So the fast path is the small-release cadence itself: a presentation PR merged on its own and released on its own pays
no eval and no backend wait beyond go-live and the smoke. What is slow today, and proposals (not done here; each needs
the architect or owner, and none weakens S1-S6):

- **File page styles are reply code today.** `file_design.ts`, `file_page.ts`, `file_service.ts`, `file_link.ts` and
  `file_kinds.ts` are in `SHARED_REPLY_MODULES` because the brain eval's import closure reaches them, so any File page
  change needs a new reply measurement. Proposal: move the pure markup/CSS of the File page into a module the eval does
  not import. `tests/architect/deploy-evidence.test.ts` already fails if the eval's closure reaches a file not listed, so
  this cannot be gamed: whatever the eval imports stays reply code.
- **Vercel ships `site/` and `api/` on its own.** Per `RELEASE-NOTE-LIVE-SITE-2026-11-03.md` the Vercel production
  deployment is built from `release/production`. If that is Vercel's Git integration, the site goes live on the push,
  before S1-S6 judge, and a rollback in `deploy-production.yml` does not roll Vercel back. Owner to confirm; the proposal is
  to deploy the site from the deploy job after S6 (or make Vercel wait for the GitHub check), not to skip anything.
- **Go-live repeats the migration step** when no migration changed since the deployed SHA (a no-op, but minutes).
  Proposal for the go-live owner: skip it automatically when `supabase/migrations/` is identical to the deployed SHA's.
- **Review on a preview.** If Vercel previews PRs, a presentation PR links its preview URL in the template's demo
  section, so review is visual and fast.

## Merge queue and branch protection

`ci.yml` runs on `merge_group`, so a merge queue can be turned on without workflow changes: the queue tests each entry on
the commit it will land, in parallel, so two PRs that are green alone but conflict together are caught before trunk, and
the landed commit already carries every check S1 reads (same names; `jobCheckNames` reads jobs, not triggers).
`deploy-preflight.yml` has no `merge_group` trigger: it is path-filtered, so it is not a branch-protection required check,
and S1 finds it on release SHAs through `deploy-production.yml`'s `preflight` job as before. When PR #414 (path-filtered
coverage/database) lands, a `merge_group` run must run every job, as a push does.

The owner's settings (merge queue, required checks, auto-delete) are in this change's PR description. The required
checks: `gate (core)`, `gate (browser)`, `gate (architect)`, `gate (forms-ci coverage)`, `database`, `load (send rail)`,
`acceptance (telegram)` (the shard jobs are covered by their aggregates).

## What enforces what

| Rule | Mechanism |
|---|---|
| 2 size cap, 3 max age, 4 no stacking, 5 green base | `.github/workflows/pr-hygiene.yml` daily: labels `oversize`, `stale`, `conflicting`, `stacked`, `based-on-red-trunk`, one comment per new label. It never closes, merges or edits a PR (`scripts/ci/pr-hygiene.cjs` allows only label and comment calls; `tests/career-ci-process.test.cjs`). Run it by hand with "Run workflow" (dry run by default). |
| S2 at merge | same workflow, on every trunk push: `needs-s2-approval` |
| 1, 6, 7, 8 and the checklist | `.github/pull_request_template.md`; the reviewer refuses a PR that does not fill it |
| Collisions on trunk | merge queue (owner setting) with `merge_group` in `ci.yml` |
| Red trunk | required checks on trunk (owner setting); rule 5 |

Not automated, on purpose: a CI guard that fails any test reading the real clock. 226 test files make 608
`Date.now()` / `new Date()` calls, most of them timing and timeouts that are correct; a static scan cannot tell those from
a verdict reading the wall clock, so it would either cry wolf or need an allowlist every PR edits (a new conflict
hotspot). Rule 6, the existing clock guards above and review are the control. A future option is a scheduled run of the
date-sensitive suites under a shifted clock; it needs measuring before it is proposed.
