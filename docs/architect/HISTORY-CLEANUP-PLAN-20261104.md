# History cleanup plan (2026-11-04): remove two files of the owner's real writing from the public history

**Status: PLAN AND DRY-RUN EVIDENCE ONLY. NOTHING HAS BEEN REWRITTEN, FORCE-PUSHED OR SENT. Not done until the owner approves the exact operation below.** The repository stays PUBLIC.

## What and why
Two files built from the owner's real 2026-10-13 networking drafts are reachable in the public history: `packages/career-data/fixtures/writing-pattern-corpus.json` and `scripts/career/writing-pattern-blinded-pairs.json` (introduced by `c2219e00`; removed at the tip of trunk by `dc8e5802`, which says "A history rewrite was not performed"). Deleting branches does not remove them. They are also at the tip of `wo/076-ready-first-build` and in per-branch scrubbed copies.

## Evidence (dry run on a fresh mirror copy, 2026-11-04 ~03:30 UTC)
- Fresh mirror backup: `~/repos/trainee-backup-20261104T032928Z.git` (210 MB, 932 refs, `git fsck --connectivity-only` clean). Old tips in it: trunk `8840311e284c`, release/production `3eb2e1c30fae`.
- Blob ids of the two files across all history (non-null): `0aca232e...` (corpus) and `d1703645...` (blinded pairs).
- Command run on a COPY of the backup: `git filter-repo --force --invert-paths --path packages/career-data/fixtures/writing-pattern-corpus.json --path scripts/career/writing-pattern-blinded-pairs.json`
- Before: 72 commits touch either path; 5354 commits on all refs. After: **0** commits touch either path; 5354 commits (none dropped); 932 refs (931 changed, listed in `filter-repo/changed-refs`).
- Both blob ids are **absent** from the rewritten object database. The same blobs are not present under any other path in the old history (`git log --all --find-object=<blob>` outside the two paths: 0).
- trunk's tree is **byte-identical** before and after (`65a2c4a5731523dbc45bce44b508210624070064`). trunk `8840311e284c` -> `f3409f5f2a8b`; release/production `3eb2e1c30fae` -> `0dd583b1225d`. The full old->new map is `filter-repo/commit-map` / `ref-map` in the dry-run copy `~/repos/trainee-rewrite-20261104.git` (not committed here).
- Not checked: whether distinctive lines of the two files were copied verbatim into OTHER files (search before the real run: `git log --all -S'<a distinctive line>'` for a few lines of each old blob; do not paste the text into any document).

## What a rewrite breaks (read before approving)
1. **Every commit SHA changes** (931 refs). All ~70 open PRs get new heads; stacked PRs (#407, #406, #395, #364, #215, #204, #116) have non-trunk bases that change too. GitHub keeps PRs attached to branch names but their diffs/CI restart; force-push is required (`git push --force` per branch, never `--mirror`: `refs/pull/*` cannot be pushed).
2. **S2 ledger (`docs/architect/approvals.txt`) is keyed by each PR's merged head SHA.** After a rewrite no old line matches; a new ledger would need re-keying via the commit-map (`old head -> new head`) in a ledger-only PR, and the reviewers' records must be re-checked to refer to the same trees. Rewrite only AFTER the releases are done so S2 has nothing pending.
3. **The S3 waiver is keyed to the deployed SHA** `33f7d00d1fce216153c431f6881e3922151ce4f8` (`S3_WAIVER` in `scripts/launch/deploy-standard.ts`). A rewrite changes that SHA, so the waiver would stop applying (fail closed). After release 1 deploys, the deployed SHA is the new release SHA and the waiver is already expired; the deployed-SHA record in the live table `career_deploy_ledger` also names pre-rewrite SHAs.
4. `release/production` is rewritten too: deploy-production.yml's "previous deployed SHA" rollback and `--verify <sha>` use SHAs recorded in `career_deploy_ledger`; after the rewrite those SHAs no longer exist in the repository. Do not rewrite while a deploy is queued or running.
5. GitHub keeps what it cached: read-only `refs/pull/*/head` and `/merge` refs still reach old commits (only GitHub Support can purge them), forks and cached views. See `docs/architect/GITHUB-SUPPORT-REQUEST-20261104.md`.

## Pre-conditions (all must be true)
- Release 1 AND release 2 deployed and verified; no deploy-production run queued or in progress; the Actions queue idle.
- All other writers paused: the owner's `pr_loop.py --act` loop, every Claude/Instinct/Codex session or agent that pushes, scheduled workflows that commit (`ci/brain-eval` is written by brain-eval runs: no measurement in flight).
- The owner approves this exact operation in writing, naming the two paths and the date.

## Operation (after approval)
1. New mirror backup (`git clone --mirror`), verify `fsck`, record ref count and SHAs of trunk, release/production and every open-PR head branch.
2. Run the filter on a fresh clone of the backup (command above), re-verify the evidence (0 commits touch either path; trunk tree identical).
3. Force-push branches and tags only: `git push --force origin 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'` from the rewritten mirror (GitHub rejects `refs/pull/*`). Temporarily lift trunk branch protection if enabled, restore after.
4. Re-key: ledger-only PR with new head SHAs for S2 (if any release follows); set the next deploy's `S3` baseline from the first post-rewrite release; record the commit-map in the owner's private notes (it contains no personal text).
5. File the GitHub Support request (draft in `GITHUB-SUPPORT-REQUEST-20261104.md`) with the new SHAs.

## Recovery (if anything looks wrong)
Restore from the mirror backup: from `trainee-backup-20261104T032928Z.git` run `git push --force origin 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'`. Open PRs return to their old heads. The old objects stay on GitHub until it garbage-collects, so a restore is possible for a while but not guaranteed forever: keep the backup.

## Verification after the real run
`git clone` fresh; `git log --all -- <each path>` is empty; `git rev-list --all | wc -l` equals the backup's; the new trunk tree equals `65a2c4a5731523dbc45bce44b508210624070064` (or the then-current tree with no diff outside the two paths); CI green on the new trunk; deploy-standard S1-S5 runs against the new SHAs.
