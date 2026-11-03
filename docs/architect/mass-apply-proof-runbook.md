# Mass-apply proof runbook (architect), written 2026-11-02 from the repo only

Goal: after a production deploy, PROVE a real application went from a Telegram role ask to an employer's confirmed receipt. Nothing here
was run against production. [O] = owner action (AGENTS.md "Never": agents do not deploy, apply migrations, create credentials; CLAUDE.md
"Rules that never move"). [A] = architect can do (read-only; SQL needs a read path the owner grants, unknown). [?] = the repo does not say.

## A. Preconditions in production
| Name | Read where | Default now | Who |
|---|---|---|---|
| `UPMORE_SCRIPT_SUBMIT_LIVE` | cloud_runner_http.ts:57, passed to sandboxes cloud_runner.ts:259 | `1` (release_config.ts:105) | [A] verify the deployed SHA carries it; rollback `=off` is the owner's (release_config.ts:148-154) |
| `CLOUD_RUNNER_ENABLED` / `CLOUD_PREPARE_ENABLED` | cloud_runner_http.ts:120 / :98,:106 | `on` / `on` (release_config.ts:106-107) | same; [?] whether either secret was set to a non-`on` value |
| `CAREER_AGENT_SUBMIT`, `CAREER_CLOUD_APPLY`, `APPLY_VM` (rows in `career_cloud_settings`) | career_apply_agent_submit_enabled (20261024090000:16), career_apply_cloud_enabled (20261021080000:125) | written `on` only if the row is missing; an existing `off` survives (release-db-switches.sql:19-24, release_config.ts:117-121) | [O] go-live; [A] read rows (C0) |
| `CAREER_CLOUD_TEXT_CARDS` row | career_apply_cloud_text_cards_enabled (20261026230017:53); refusal `cloud_switches_off` without it (:124) | NOT in `RELEASE_DB_SWITCHES`, never written by go-live (see F1) | [O] must insert `('CAREER_CLOUD_TEXT_CARDS','on')` |
| Cloud gate waiver row (`career_apply_cloud_gate_waivers`) | gate needs 3 email-confirmed own-computer sends per family (20261021080000:143-152); waiver: 1-5 sends, max 7 days (20261024120000:18-27) | none | [O] insert one row, `max_sends=1` |
| Person's cloud opt-in (`career_apply_cloud_optin.enabled`) | refusal `not_opted_in` (20261026230017:152) | off | [O] the owner texts "apply for me in the cloud", then "yes" (career_cloud_optin.ts:26-28,:32) |
| No pause rows | `career_apply_cloud_pauses` (20261026230017:153-154), `career_apply_host_backoff` (20261027140000:20) | none expected | [A] read (C0) |
| `career-cloud-runner` secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_RUNNER_SECRET` (>=32 chars) else 503 (cloud_runner_http.ts:70); `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `CLOUD_SANDBOX_SNAPSHOT_ID`, `CLOUD_BRIDGE_URL` else 503 "needs setup" (:86-90,:100); `CLOUD_DISPATCH_SECRET` (:97); `CAREER_PREPARE_AHEAD_TOKEN` (:104) | unset until the owner supplies them | [O] |
| `agent-chat` secrets `CAREER_PREPARE_AHEAD_URL` + `_TOKEN` | career_apply_from_chat.ts:125,142-144; go-live derives the URL only if `VERCEL_TOKEN` or `CLOUD_RUNNER_SECRET` is in that run's env (trainee-go-live.sh:826,1013-1014) | [?] | [O] |
| Limits | `CLOUD_MAX_CONCURRENT` 2, `CLOUD_MAX_PER_PORTAL` 1, `CLOUD_MAX_STARTS_PER_TICK` 2; per-person/per-site unset (cloud_runner_http.ts:19-20,:30-35) | as listed | [O] to change |
| Two pg_cron jobs `career-cloud-dispatch`, `career-cloud-prepare-dispatch` (every minute) | schedule-career-cloud.sql:18,:26; created only when the cloud is wired in that go-live (trainee-go-live.sh:1136) | [?] | [O]; [A] read `cron.job` |
| Runner snapshot | rebuilt on every engine change; expires 30 days after last use (CLOUD-RUNNER.md:244-245) | [?] age/SHA | [O] `--build-snapshot` |
| Results page | `TRAINEE_FILE_LINK_SECRET` (function deployed only with it, trainee-go-live.sh:439), `TRAINEE_FILE_BASE_URL` https (file_link.ts:63-64), `TRAINEE_BOT_URL` (handler.ts:315-316), Vercel `TRAINEE_FILE_UPSTREAM` + `/file` rewrite (api/file.js:4, vercel.json), `SUPABASE_ANON_KEY` (trainee-file/store.ts:86) | [?] | [O] |
| Phone sign-in | Supabase Auth SMS provider; the account's phone must be confirmed (store.ts:87-100) | [?] | [O] |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; `TRAINEE_ALLOWED_CONTACTS` [?] | [?] | [O]; [A] `secrets-audit.sh --features` (S5, :86-98) |
| Gmail read connect (for `confirmed`) + `CAREER_MAIL_TRACKING` | release flag on (release_config.ts:101); mail run matches the employer's email (20261021075000:118-131) | [?] connected | [O] |
Migrations: go-live's `MIGRATIONS` list (trainee-go-live.sh:133-266, 133 files) equals the 133 files from 20261019 on in `supabase/migrations` (compared 2026-11-02); `--verify <sha>` checks live marks (:6).

## B. The conversation (owner's own Telegram chat; resume already confirmed, cloud opt-in done)
Before step 1 run C0 and C1-before (counts of `career_apply_wanted` and `career_apply_jobs`).
1. Send: `I want software engineering internship roles that pay $30/hr` (shape: handler-career.ts:1081-1082). Expect TWO messages: a sentence ("I found N ... Here they are by fit, with Apply on each.") and the link alone (role_pay.ts:122-131; handler-career.ts:1093). A numbered text list instead means no page link (role_results.ts:66-67; handler-career.ts:1086-1087).
2. S4 invariant: the search queued nothing. It wrote only `career_watch_kv` keys `tg:job:*`, `tg:list:*`, `tg:listmeta:*` (role_results.ts:57,:62,:65; telegram_jobs.ts:722-727). `career_apply_wanted` and `career_apply_jobs` counts must equal the before-counts (C1). The acceptance suite asserts this for the numbered-list search only (telegram-acceptance.test.ts:257-258); none of its 12 STEPS (:41-54) opens the results page.
3. Tap the link. It opens a phone sign-in: number, then SMS code within 15 min, 5 tries (handler.ts:393; file_session.ts:13-14); link lives 1 day (file_link.ts:9), session 2 hours (handler.ts:331).
4. The page must show: "Made for <first name> · <date>", a "Postings checked ..." stamp, a source line ("N sources on the live board" or "a saved snapshot ... not the live board") (handler.ts:764-774), "Quick read", groups "Lists $30/hr or more (n)" / "Pay not listed" (results_page.ts:122-126). Each card: title, company, pay "listed on the posting", Where, Posted, Source, "Why it fits", Full posting, "Open on <host>", Select + black Apply (results_page.ts:91-105). LinkedIn/Indeed/Handshake rows show "Apply there", never Apply (:101). An unprepared card says "Not prepared yet. Tap Apply and I'll start getting it ready; nothing is sent." (handler.ts:753).
5. Tap Apply on ONE unprepared ATS role. Expect "Getting your application ready. Nothing is sent until you check it here and tap Apply. Refresh in a minute." (handler.ts:663) and chip "Preparing" (file_page.ts:120). C2: one `career_apply_wanted` row `waiting`, zero `career_apply_jobs`. The page's tap only queues (handler.ts:662); it does not start preparation (F2). If C3 shows no `career_apply_prepare_requests` row after 2 minutes, send in Telegram `apply me to <that role's link>` (the chat turn that kicks preparation, career_apply_from_chat.ts:253).
6. Missing-info path: if preparation stops on a question, the card says "N question(s) need your answer first." with "Answer them now" (handler.ts:751; results_page.ts:107) which opens "A few things first" (results_page.ts:155-156). Choices render as radios/select, yes/no as two radios, essays as a textarea, secrets as "Trainee never collects this" with no input (results_page.ts:147-152). "Save answers" validates, saves, re-queues and prepares again (handler.ts:716-735); success note "Saved. Getting your application ready with your answers ..." (:734). C4 shows the question `open` then `answered`.
7. Ready card: "What will be sent" lists Resume, each answer, Cover note, "Sends to <host>" (handler.ts:162-191). Any "Needs you" row removes Apply (:226,:240). The Apply button carries the first 16 hex of the prepared `payload_hash` (:240); compare with C5.
8. Tap Apply once. Expect "Approved. It's queued to be sent exactly as its card showed; the status here changes when the employer's site confirms it." (handler.ts:619); then chip `queued` -> `sending` -> `submitted` -> `confirmed` (file_page.ts:104-107). Refusals: "Changed since you opened this page, so nothing was sent." (handler.ts:618); "Already in your applications." (:270).
9. A receipt text arrives in Telegram (career_outbox key `receipt:<job id>`, RAMP-FIRST-RUN.md:62-65; wording career_apply_receipts.ts:67-97).

## C. Read-only SQL (`<me>` = owner's user id; columns verified in the cited migrations)
```sql
-- C0 switches, gate, waiver, opt-in, pauses, schedules, kept resume (never select bytes)
select key,value,updated_at from career_cloud_settings order by key;                       -- 20261021080000:114
select career_apply_cloud_open('greenhouse') g, career_apply_cloud_open('lever') l, career_apply_cloud_open('ashby') a, career_apply_cloud_runner_missing(), career_apply_guards_missing();
select id,portal,max_sends,created_at,expires_at,revoked_at,career_apply_cloud_waiver_left(user_id,portal,now()) left from career_apply_cloud_gate_waivers where user_id='<me>'; -- 20261024120000:18
select enabled,privacy_epoch,turned_on_at,turned_off_at from career_apply_cloud_optin where user_id='<me>';  -- 20261021080000:185
select scope,portal,user_id,reason,until from career_apply_cloud_pauses where until>now(); select * from career_apply_host_backoff where until>now();
select jobname,schedule,active from cron.job where jobname like 'career-cloud%';
select sha256,filename,created_at from career_apply_cloud_resumes where user_id='<me>';                    -- 20261021080000:231
-- C1 the search queued nothing (run before and after step 1; both counts must not move)
select (select count(*) from career_apply_wanted where user_id='<me>') wanted, (select count(*) from career_apply_jobs where user_id='<me>') jobs;
select key,updated_at from career_watch_kv where user_id='<me>' and key like 'tg:listmeta:%' order by updated_at desc limit 3;
select key,status,contact,delivered_at from career_outbox where user_id='<me>' and key like 'reply:tg:%' order by id desc limit 4; -- 20261019020001:14-21
-- C2/C3 after the first Apply: queued, then preparation
select posting_key,state,queued_at from career_apply_wanted where user_id='<me>' order by queued_at desc;      -- 20261022100000:7
select id,state,created_at,claimed_at,finished_at,outcome,card_id from career_apply_prepare_requests where user_id='<me>' order by created_at desc limit 3; -- 20261026230017:319
-- C4 the employer's questions and the owner's answers
select key,label,state,answer,job_ids,answered_at from career_apply_questions where user_id='<me>' order by created_at desc; -- 20261020060000:10
-- C5 the prepared payload the card shows
select id,job_id,state,left(payload_hash,16) tag,payload_hash,payload->>'destination' dest,payload->>'resume_sha256' resume from career_apply_prepared where user_id='<me>' order by created_at desc limit 3; -- 20261020030000:7
-- C6 after the Apply tap: card answered, job queued/claimed, hashes agree, text-route claim marker
select c.id,c.state,c.answered_at from career_apply_cards c where c.user_id='<me>' order by shown_at desc limit 2;
select id,job_id,state,source,attempts,reason,payload_hash=approval_hash same,claimed_at,confirmation_id,email_confirmed_at,confirmation_mail_hash,created_at,updated_at from career_apply_jobs where user_id='<me>' order by created_at desc limit 3; -- 20261020000001:2
select job_id,card_id,item_n,host,claimed_at from career_apply_cloud_text_claims where user_id='<me>';        -- 20261026230017:59
select career_apply_cloud_text_refusal(j,now(),'claim') why_not_claimed from career_apply_jobs j where j.user_id='<me>' and j.state='queued'; -- stable, no writes (:113); null = claimable
-- C7 evidence after the run
select state,evidence->>'page_confirmation' page_conf,evidence->'response'->>'status' http,evidence->'response'->>'destination' dest,evidence->'response'->>'final_url' final_url,evidence->'screenshots'->'sha256' shots,evidence->>'reason' reason from career_apply_jobs where id='<job>'; -- worker.ts:125-135
select reached_employer,state,clicked_at,finished_at,confirmation_id,left(confirmation_text,200) page_text,proof from career_apply_receipts where application_id='<job>'; -- 20261026140000:25
select kind,sha256,bound,length(bytes_b64) b64_len from career_apply_receipt_files where application_id='<job>'; -- :51
select outcome,error_kind,portal,at from career_apply_cloud_events where job_id='<job>';                     -- 20261021080000:273
select key,kind,status,contact,provider_id,delivered_at,left(text,300) from career_outbox where key='receipt:<job>';
select kind,company,stage,flagged,message_hash,mail_at from career_mail_events where user_id='<me>' and application_ref='job:<job>'; -- 20261020100000:7
```

## D. What counts as proof
- Not proof: the tap; the "Approved ... queued" note (handler.ts:619); a `queued` or `driving` row; "dispatch: started" (cloud_runner.ts:128); a card; a lone screenshot or page text; `needs_user` / `not_submitted` / `failed` (nothing reached the employer, receipts.ts:84-94); `unknown_outcome` ("cannot tell", receipts.ts:97).
- L1, submitted: `career_apply_jobs.state='submitted_unconfirmed'`, `source='cloud'`, `attempts=1`, `payload_hash=approval_hash` equal to the card's hash (C5/C6), `evidence.response.status` 2xx/3xx and a destination on the employer's host (RAMP-FIRST-RUN.md:77-78), a `career_apply_receipts` row with `reached_employer='yes'` and `clicked_at`, bound `after-submit` file whose sha256 is in `evidence.screenshots`, one `career_apply_cloud_events` row `submitted`, receipt delivered.
- L2, confirmed (the code's "submitted and confirmed" rule): `state='confirmed'` AND `email_confirmed_at` AND `confirmation_mail_hash` set, with an unflagged `career_mail_events` kind `received` whose `message_hash` equals it (trigger 20261021075000:44-52; open() 20261021080000:147-151; sender checked in career_apply_confirm_as :118+). A page's "thank you" is stored as `submitted_unconfirmed` plus `page_confirmation:true` (20261021080000:496-498); the page says "submitted ... hasn't confirmed it yet" (file_page.ts:105). Mass-apply is PROVEN only at L2, plus the owner seeing the employer's own email. L1 alone = "sent, unproven".

## E. First real submission, safely
- Posting: one Greenhouse, Lever or Ashby posting for a role the owner truly wants; the cloud refuses any other family `portal_not_cloud` (20261026230017:140) and Workday-type links are queueable but not cloud-sendable (career_apply_want.ts:54). Ashby needs `UPMORE_SCRIPT_SUBMIT_LIVE=1` (cloud_runner.ts:225-228). Precedent: Ramp on Ashby (RAMP-FIRST-RUN.md:1-4); expect a possible verification check (CLOUD-RUNNER.md:61).
- Owner's own application only: his resume, confirmed facts, his name; never a friend's account; LinkedIn/Indeed never.
- Cap of 1: waiver `max_sends=1`, expiry about 2 days (CLOUD-RUNNER.md:221-222), checked at claim and at the authorization (20261026230017:143,:148); any cloud drive, even a failed one, uses the send (career_apply_cloud_waiver_left counts `attempts > 0`, 20261024120000:32-36; 20261101130000:22-25). Tap exactly one Apply; never "Apply to selected". Also, the owner may say "set my daily pace to 1" (career_apply_want.ts:78-92).
- Hang: the sandbox times out at 13 min, the lease at 15 (cloud_runner.ts:246; CLOUD-RUNNER.md:34). `attempts` is capped at 1 (20261020000001:7), a dead drive becomes `unknown_outcome` and is never re-sent (CLOUD-RUNNER.md:31-33). Do not re-tap or re-queue. Read C6/C7, the owner checks his inbox and the employer's portal. The phrase "still checking" is not in the repo; the page words are `sending` (driving), `submitted`, `unknown` (file_page.ts:105-107,116). If `unknown_outcome` and no email in 24h, treat as not proven; a second try is the owner's new waiver and a new tap.
- Stop switch: `trainee-go-live.sh --real-submit off` (:946-951) or revoke the waiver.

## F. Gaps and risks found (each would fail or mislead the real run)
1. **Fixed in `fix/go-live-gaps-20261103`:** the row is now in `RELEASE_DB_SWITCHES` and `release-db-switches.sql` (written `on` when missing, an existing row kept). Original finding: `CAREER_CLOUD_TEXT_CARDS` is required by the text-card claim and both authorizations (20261026230017:123-124; CLOUD-RUNNER.md:159) but not written by release-db-switches.sql:19-24, absent from `RELEASE_DB_SWITCHES` (release_config.ts:117-121) and RELEASE-FLAGS-2026-11-01.md. The page and Telegram Confirm both end in `career_apply_card_confirm_as` (career_apply_cards.ts:649), so a confirmed card is a text-card job. Result: every claim returns `cloud_switches_off` unless the owner inserts it (RAMP-APPLY-TRACE-2026-10-31.md:92 lists it as owner SQL).
2. The results page's first Apply only calls `store.want` (handler.ts:662); nothing there calls `kickPrepare`. Preparation is requested only by the chat apply turn (career_apply_from_chat.ts:253), after saved answers (career_hosted_prepare.ts:33), or when a job ends `needs_answers` (20261101130000:49-52). The prepare tick only claims existing requests (cloud_prepare.ts:57). The `career_apply_wanted` sweep (20261101121000:5-16) feeds `prepare-ahead.ts daily` on a VM host (MASS-SUBMISSION.md:114), not this tick. The page then says "Refresh in a minute" while nothing is queued to prepare. [?] whether a prepare host runs.
3. S5 cannot catch an unwired runner: the feature manifest has no cloud entry (secrets-audit.sh:86-98); S6 smoke is one synthetic chat turn (DECISIONS D-034). A deploy can pass every standard and still answer 503 "needs setup" (cloud_runner_http.ts:100).
4. go-live wires the cloud, secrets, URLs and cron only when `VERCEL_TOKEN` or `CLOUD_RUNNER_SECRET` is in that run's env (trainee-go-live.sh:826,:1136), although its comment says "already on the project" (:822). [?] whether deploy-production.yml passes them.
5. The gate is closed on a fresh production (needs 3 own-computer, email-confirmed sends in `gate_user_ids`, 20261021080000:143-152): only the waiver opens it, and it is owner SQL (D-037 left "the cloud gate and its waiver" in force).
6. `confirmed` needs Gmail connected and the mail run; otherwise the row stays `submitted_unconfirmed` forever (20261021075000:44-52). The results link is the plain phone-sign-in link, not the Mini App (handler-career.ts:1091 uses `.url`); it needs an SMS provider and a confirmed phone, else "Phone sign-in isn't switched on yet" (handler.ts:397,403).
7. `APPLY_VM=on` is written but sends for nobody until `APPLY_VM_USER_IDS` names someone (20261028180000:60-70). `CAREER_BATCH_EXECUTOR` is pending, so batch asks commit intents nobody runs (release_config.ts:128). "Apply to selected" on the page works per card through `approveOne` (handler.ts:704), not that executor.
8. Per-tick throughput is 2 starts, 2 concurrent, 1 per portal (cloud_runner_http.ts:19), and a bot check pauses the family for 6 hours (CLOUD-RUNNER.md:30): a pause row in C0 explains a stuck `queued`.
