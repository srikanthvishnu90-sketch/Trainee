# Owner setup checklist (one list)

Everything below needs an account only you hold, so no agent can do it. Names only here: never paste a value into chat, a PR or a log.
Order matters only where a row says "after". Run `bash scripts/launch/secrets-audit.sh` at any time: it lists what is still missing by
NAME (it reads names from `supabase secrets list`, drops everything else, and never prints a value).

Legend. **Where**: `FN` = Supabase function secret (`supabase secrets set NAME=... --project-ref <ref>`, or Dashboard > Edge Functions > Secrets);
`VERCEL` = Vercel project > Settings > Environment Variables (Production), then redeploy; `GH` = GitHub > Settings > Environments > `production` > secrets.
Function secrets are project-wide: every function sees every one.

## 1. Launch-blocking

| # | Name | Where | You get it from | Unlocks | Without it |
|---|---|---|---|---|---|
| 1 | `OPENAI_API_KEY` | FN, GH | platform.openai.com > project > API keys | every reply | no model |
| 2 | `LOOPMESSAGE_API_KEY` | FN, GH | LoopMessage dashboard | inbound texts, the phone-login code, deliveries | `trainee-inbound` answers 503 NOT_WIRED; smoke `inbound` NOT CERTIFIED |
| 3 | `TRAINEE_INBOUND_SECRET` | FN, GH | you choose 32+ chars (`openssl rand -hex 24`); it is also the `?secret=` in LoopMessage's webhook URL | the inbound webhook | webhook refused. Never rotate unseen: it breaks LoopMessage's URL |
| 4 | `CAREER_INGEST_SECRET`, `CAREER_PROACTIVE_SECRET`, `TRAINEE_DELIVER_SECRET` | FN, GH (go-live also stores them in Vault) | you choose; go-live can generate | the three schedules | no ingest, alerts or delivery |
| 5 | `INGEST_CONTACT_EMAIL` | FN, GH | your contact email (job boards see it) | job ingest | ingest 503 |
| 6 | `TRAINEE_FILE_LINK_SECRET` | FN | you choose 32+ chars | file page links, phone login, Apply buttons | **deploy skips `trainee-file`** (logged `gated: ... SKIPPED`) |
| 7 | `TRAINEE_FILE_BASE_URL` | FN | the public https URL of the page, e.g. `https://<your-domain>/file` | links point at your page | no link is issued |
| 8 | `TRAINEE_BOT_URL` | FN | the bot link (`https://t.me/<bot>`) | bot button on file and connect pages | pages have no way back to the bot |
| 9 | `TRAINEE_FILE_UPSTREAM` | **VERCEL** | `https://<ref>.supabase.co/functions/v1/trainee-file` | `/file` proxy | page says "File pages are not set up yet" (503) |
| 10 | `OPS_MONITOR_TOKEN` | FN | you choose 32+ chars; also used by the schedule script | `ops-monitor` alerts and digest | **deploy skips `ops-monitor`**; nothing watches production |
| 11 | `TELEGRAM_BOT_TOKEN` | FN | @BotFather | alert messages to you (and the Telegram channel) | alerts are recorded but not delivered |
| 12 | `OWNER_TELEGRAM_CHAT_ID` | FN | send your bot a message, then read `getUpdates` for `chat.id` | where alerts go | same as above |
| 13 | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_URL` | GH | Supabase > Account > Access Tokens; Project Settings > General; Connect > Session pooler URI (port 5432) | GitHub production deploy | no deploy from `release/production` |

Rows 3-4 and the ones go-live generates (it asks on a hidden prompt) are described in `docs/launch/TRAINEE-GO-LIVE.md`, "What you are asked for".

## 2. After row 10: schedule the monitor (once)

```bash
OPS_MONITOR_TOKEN=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/ops-monitor -f scripts/launch/schedule-ops-monitor.sql
```
Creates `ops-monitor-check` (every 5 minutes) and `ops-monitor-digest` (13:00 UTC). The token goes to Vault and is sent as a header only.

## 3. Optional (the feature stays honestly NOT_WIRED without it)

| Name | Where | Unlocks |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` | FN | ops-monitor 5xx-spike alerts (otherwise listed "not measured") |
| `OPS_DAILY_CAP_USD` | FN | spend alerts when no daily budget row exists |
| `TRAINEE_ALLOWED_CONTACTS` | FN | who may sign up (closed by default) |
| `CAREER_PREPARE_AHEAD_URL` + `CAREER_PREPARE_AHEAD_TOKEN` (both) | FN | phone-only preparation for real Apply (`docs/launch/CLOUD-RUNNER.md`) |
| `TRAINEE_CONNECT_LINK_SECRET` (falls back to `TRAINEE_FILE_LINK_SECRET`), `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_STATE_SECRET`; `TRAINEE_CONNECT_UPSTREAM` (VERCEL) | FN / VERCEL | Gmail connect pages |
| `HUNTER_API_KEY`, `PDL_API_KEY` | FN | outreach email checks, hired-candidate aggregates |
| `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | FN | Telegram channel (read the Telegram section of `TRAINEE-GO-LIVE.md` before setting: it re-points a live webhook) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | FN | WhatsApp channel |

## 4. Ship, then verify (each command prints PASS/FAIL, never a value)

```bash
bash scripts/launch/secrets-audit.sh                                   # exit 0 = nothing launch-blocking is missing
bash scripts/launch/trainee-go-live.sh --sha <40-char sha> --dry-run   # then without --dry-run, or push the sha to release/production
TRAINEE_FILE_BASE_URL=https://<your-domain>/file \
  bash scripts/launch/trainee-go-live.sh --sha <sha> --only-smoke --allow-send   # texts HELP to TRAINEE_SMOKE_CONTACT (your own number)
curl -s -H "x-ops-token: $OPS_MONITOR_TOKEN" "https://<ref>.supabase.co/functions/v1/ops-monitor?mode=check"   # {"ok":true,...,"not_measured":[...]}
```

## 5. What the smoke can certify

The smoke ends with one line per feature. A feature is **CERTIFIED** only when this run saw it work; NOT RUN, WARN and FAIL never certify.

| Feature | Certified when the smoke saw | Otherwise the line says |
|---|---|---|
| file endpoint | the live page (`TRAINEE_FILE_BASE_URL`) refuse a made-up link with a 4xx page | 404 = route/function missing; 503 = rows 6 and 9; not given = row 7 |
| inbound | `trainee-inbound` refuse a wrong secret, take the right one, and send HELP through LoopMessage (`--allow-send`, `TRAINEE_SMOKE_CONTACT`) | row 2 missing (WARN 503), or the send was not run |
| phone login | file endpoint and the LoopMessage send both certified (the code arriving on a real phone is not probed) | which of the two is not |
| real Apply | **never by a smoke**: it needs one real application that the employer confirmed by email. It prints the prerequisites it did see (file page, schedules, preparation host) | always `NOT CERTIFIED` until you have that receipt |

Each run also writes one counts-only row (`founder_alerts`, kind `deploy_smoke`: commit, pass/warn/fail/not-run counts, certified yes/no per feature). `ops-monitor` messages you when the latest one has a FAIL.

## 6. What ops-monitor tells you (Telegram, once per alert, deduped)

Failed deploy smoke; model spend crossing 50 / 80 / 100% of the daily cap; a 5xx spike on any function (needs `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`); a stuck queue (texts past due and undelivered for 30+ minutes, apply jobs queued 20+ minutes with no claim, or stuck driving 30+ minutes); failing or silent deliveries; stalled ingest; model budget refusals. Anything it cannot read is named under `not_measured`, never silently zero.
