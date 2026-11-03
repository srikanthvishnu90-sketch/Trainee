# Mass submission — shared brief for builders (2026-10-27)

Repo: srikanthvishnu90-sketch/upmore-agent. Base branch: `trunk` (CI green at bdd51e9). Main is stale; never target it.
Read first: CLAUDE.md, AGENTS.md, docs/architect/STRICT-STANDARD.md, docs/architect/SUBMIT-PATH-2026-10-25.md
(esp. "Volume ceilings" and "Approval model"), docs/architect/HANDOFF-SUBMIT-PATH-2026-10-27.md.

## Owner decisions, in writing today (2026-10-27 13:2x CDT, Vishnu, in chat with the architect)
- D-MS-1 Approval: a texted "yes" (any channel: SMS/iMessage, WhatsApp, Telegram, web) approves exactly the
  batch that was shown to the person, each item still bound to its exact payload hash. Replaces Option A
  (`career_apply_cards.ts` text-yes refusal). Ambiguous replies ("maybe", "yes but not Acme") never approve all;
  "yes except 3" / "only 1,2" approve the stated subset. A payload that changed since it was shown is refused, not sent.
- D-MS-2 Volume: NO product volume cap. Remove the per-person daily limit (25/50), the per-card 8 cap as a
  submission limit (cards may page for readability, but one yes covers the whole shown batch), the claim-size
  bounds of 6 and the 1-at-a-time claim. Keep only safety pacing: per-portal/per-host rate pacing so we don't get
  rate-limited or flagged (no captcha solving; a captcha ends needs_user, never retried).
- D-MS-3 Duplicates: remove "one per company per 30 days". Block only exact duplicates (the same posting / same
  canonical job URL or ATS job id for the same person), and keep unique confirmation IDs and the payload-hash
  re-verify at claim.
- D-MS-4 Deploys: nobody in this session deploys, applies live migrations, uses Vercel sandboxes, or contacts
  a real employer. PRs only, into trunk. The owner runs go-live.

## Rules that never move
External effects need approval of the exact payload (hash-bound). Never invent facts. Never submit without a
real confirmed resume (do not weaken any resume gate). OpenAI only. Never automate LinkedIn/Indeed. No captcha
solving. No secrets in code, tests or PRs.

## Strict standard (summary)
Tests assert state (DB rows, events, outbox), fail-first shown (run the new test on the base, show it red),
mutation-check every guard you add (break it, a test goes red), adversarial cases, messy new-user phrasings,
plain user words in replies (no internal codes), channel parity or say what's missing, precise report.

## Environment notes
- Postgres 16 binaries: /usr/lib/postgresql/16/bin (`PGBIN=/usr/lib/postgresql/16/bin bash tests/db/run.sh`;
  must not run as root: create/use a non-root user, e.g. `useradd -m pgrun` and run via `su pgrun -c ...`, or
  `runuser`). Deno is not installed: try `npm i -g deno` (npm registry is allowed) or download from GitHub
  releases. Node 22 is present.
- The clone is shallow. Before pushing: `git fetch origin trunk` and rebase so the push is thin.
- Push your branch and open a PR to `trunk` with `gh api` REST (GraphQL is blocked):
  `gh api repos/srikanthvishnu90-sketch/upmore-agent/pulls -f title=... -f head=<branch> -f base=trunk -f body=...`
- Do NOT edit files owned by another builder in this wave (listed in your order). If you need a change there,
  write it in your report as a Request.
- New migration filenames: use timestamps 20261027140000+ with your lane's assigned range so they never collide.
</content>
</invoke>

## OpenAI key (UPDATED 15:29 CDT by the owner's assistant)
- The local key file is WITHDRAWN and deleted. Do not use any OpenAI key, do not make model calls, and do not run evals. No new model spend is approved.
- Never request, print or store any key value, in plaintext files, logs, the repo, PRs or chat.
- Do not touch GitHub/Supabase secrets, HELDOUT_SEAL_KEY or the sealed set.
