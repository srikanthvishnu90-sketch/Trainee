# Trainee

Trainee is a personal career agent. A job seeker texts it (Telegram, iMessage, WhatsApp) and it learns who they are,
finds openings the minute they post, writes truthful tailored applications, applies at volume with one approval per
batch, runs networking outreach, keeps the tracker, and tells them plainly where they stand. Live site:
trainee-six.vercel.app (`/`, `/file`, `/connect`, `/privacy`, `/terms`).

## What it does

- **Mass apply.** Matching postings are found from the job index, applications are prepared before the person asks
  (answers only from confirmed facts, tailored resume), and one approval covers a batch. Submission runs through the
  apply engine (`scripts/apply.ts`, `workers/`) or the browser extension (`extension/`).
- **Networking.** Outreach and introduction drafts, follow-ups and reminders, sent only after the person approves the
  exact message.
- **Task intelligence.** The agent brain (`supabase/functions/agent-chat`, model plus tools, code-enforced rules)
  answers questions, prepares interviews, negotiation and offers, and runs alerts, briefs and the tracker.
- **Hosted File.** `/file` (`supabase/functions/trainee-file`, `api/file.js`) is the signed-link page where a person
  sees their applications, results and documents. `/connect` links Gmail or Outlook.

## Layout

| Path | What |
|---|---|
| `supabase/functions/` | Edge functions: `agent-chat`, `trainee-*` channels and pages, `career-*`, `stripe-webhook` (Trainee checkout), `delete-account` |
| `supabase/migrations/` | Every database migration. Never delete or edit an applied one |
| `packages/domain/` | Career domain modules (`12x` to `16x`), bundled for the edge by `scripts/build-router-core.py` |
| `packages/career-data/`, `packages/extension/` | Company files, interview banks, datasets; extension shared code |
| `workers/` | Apply browser worker (`career-browser`) and cloud runner (`career-cloud`) |
| `extension/` | The browser extension |
| `site/`, `api/`, `vercel.json` | What Vercel serves (Output Directory `site`; `api/` proxies `/file` and `/connect`) |
| `tests/`, `evals/` | Gate tests, architect acceptance tests (`tests/architect`), database tests, evals |
| `docs/architect/` | Architecture, decisions, features, work orders |
| `src/`, `index.html`, `connect/`, `img/` | Web-app source and its build (see below) |

## Web-app source

`src/upmore-app-template.html` plus `src/build-app.py` still build the root `index.html`, which carries the career
dashboard and approval-card code that gated tests exercise. Vercel does not serve it. The finance parts of that
template are dead code awaiting a split; do not build features there.

## Commands

See `CLAUDE.md` for the verified list. The one gate: `bash scripts/gate.sh` (needs Node 22, Deno 2.9, Python 3,
`npm ci --prefix tools`).

## Rules

Owner rules live in `docs/architect/DECISIONS.md`. In short: external effects need the person's approval of the exact
payload; facts about the person come only from what they confirmed; no LinkedIn or Indeed automation; no deploys,
live migrations or spend without the owner.
