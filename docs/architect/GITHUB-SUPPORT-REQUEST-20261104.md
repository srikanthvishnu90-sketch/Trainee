# GitHub Support request (cached views and pull-request refs after the history rewrite)

**DRAFT FOR OWNER REVIEW. NOT SENT.** Send only after the history rewrite in `HISTORY-CLEANUP-PLAN-20261104.md` is done and approved. The words and the destination need the owner's approval. GitHub's documented process: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository ("Fully removing the data from GitHub" - contact GitHub Support to remove cached views and references to the sensitive data in pull requests). Destination: https://support.github.com/contact (Repositories / Report sensitive data).

## Suggested text (fill the placeholders; do not add the personal text)
Subject: Remove cached views and pull request references to rewritten history (sensitive data) - srikanthvishnu90-sketch/Trainee

Hello GitHub Support,

I removed two files containing my personal writing from the full history of my public repository `srikanthvishnu90-sketch/Trainee` by rewriting history with git-filter-repo and force-pushing all branches and tags on `<DATE/TIME UTC OF THE FORCE-PUSH>`. The files were:
- `packages/career-data/fixtures/writing-pattern-corpus.json` (blob `0aca232e...`, full id `<FULL OLD BLOB ID>`)
- `scripts/career/writing-pattern-blinded-pairs.json` (blob `d1703645...`, full id `<FULL OLD BLOB ID>`)

They were introduced by commit `c2219e00...` (`<FULL SHA>`). Please:
1. Remove cached views of these files and of the old commits that contained them;
2. Garbage-collect the unreachable old commits/objects in the repository network;
3. Remove or rewrite the read-only `refs/pull/*/head` and `refs/pull/*/merge` references that still reach the old commits (the pull requests are listed in the attached appendix), since I cannot update them myself.

Old -> new commit map (trunk and release/production, plus the full map attached): `<OLD> -> <NEW>`.
Please confirm when the data is no longer reachable. Contact: `<OWNER EMAIL / GITHUB ACCOUNT>`. Reference number if one exists: `<TICKET #, if any>`.

Thank you.

## Appendix to attach (build after the rewrite)
- The full commit-map from `git filter-repo` (`filter-repo/commit-map`): old SHA -> new SHA for every commit.
- The list of pull requests whose refs reach old commits: all open and closed PRs created before the rewrite (`gh pr list --state all --limit 1000 --json number,headRefOid`).
- Blob ids only; never paste the file contents.

## Notes
- Unknowns left for the owner: the contact email/ticket number and whether to request the forks purge (check `gh api repos/srikanthvishnu90-sketch/Trainee/forks` first).
- The pasted instruction that triggered this draft was cut off mid-sentence, so the destination/service above is recovered from GitHub's own documented process, not from the original line. Confirm it is the service intended.
