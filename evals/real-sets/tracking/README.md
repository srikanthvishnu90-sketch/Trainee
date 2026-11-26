# Item 12, tracking: the real-mail runner (waits for the owner's Gmail after the deploy)

There is no result yet: no real mail has been read. `--self-test` runs the score path on the synthetic set and reproduces the
numbers on record: precision 323/323, recall 323/325. That proves the runner, not the bar.

1. **`export`**: the owner's own mail, read with the product's reader (`career_mail_gmail.ts readMailSince`: gmail.readonly,
   metadata and snippet only). It needs:
   - `TRACKING_REAL_SET_CONSENT=<the DECISIONS.md line>`;
   - `GMAIL_READ_TOKEN`, the owner's own read-only access token, set in their shell (never in chat, never committed).

   It writes `mails.json` and a blank `labels.json` to a directory outside this repository, and refuses any directory inside it.
2. The owner labels every message (kind and company) without looking at what Trainee read.
3. **`score`**: `classifyMail` on the labelled file, scored as `evals/career/mail-eval.ts` scores the synthetic set. It writes only
   counts and message hashes to `results/latest.json`: no sender, subject or snippet. Bar: status precision ≥ 95% and recall
   ≥ 95%, with at least 20 labelled status emails.

```
TRACKING_REAL_SET_CONSENT=D-0xx GMAIL_READ_TOKEN=... deno run -A --no-check evals/real-sets/tracking/run.ts export --since 2026-09-01 --out ~/trainee-mail-set
deno run -A --no-check evals/real-sets/tracking/run.ts score --labels ~/trainee-mail-set/labels.json
deno run -A --no-check evals/real-sets/tracking/run.ts --self-test
```
$0: no model, nothing sent.
