# Resume flow: every way in, every reader, and the one record (2026-10-26)

Goal (owner directive, 2026-10-26): a resume sent on any channel ends as one confirmed-resume record, and every apply
path uses only that record, so a brand-new person can give their resume once and apply from anywhere.

Line numbers: `trunk` is `origin/trunk` at 9d4226fc0. `#194` is `feat/telegram-e2e-20261026` at 8664fbcb4, `#206` is
`fix/telegram-resume-integrity-20261026` at cb3a008da, `#201` is `feat/resume-ingest-files-20261026` at 44d9ea43a,
`#202` is `feat/live-apply-hosting-20261026` at d74ee2035. The glue is `supabase/migrations/20261026120018_career_resume_one_record.sql`
on `feat/one-confirmed-resume-20261026` (this branch).

## 1. Where a resume comes in

Every text turn from every channel ends in the same chat handler: the web app calls agent-chat as the person; Telegram,
SMS/iMessage and WhatsApp call it with the service key and `as_user_id` (`trunk supabase/functions/_shared/channel_runtime.ts:11`
`chatThroughAgent`). The router shows the entries it read; the person's "yes, that's my resume" is evidenced by
`evidenceResumeConfirmation` (`trunk supabase/functions/_shared/career_router_evidence.ts:36`), called from
`trunk supabase/functions/agent-chat/handler-career.ts:704-722`, which writes one `fact_confirmed` row in `career_events`
per entry, naming the upload: `{kind, ref, sha256}` (`career_router_evidence.ts:62-66`). That event row is the one moment
every entry passes through, on every channel.

| Entry | Where the bytes arrive | What the confirmation names as the upload | Before this branch |
|---|---|---|---|
| Web paste | `handler-career.ts:704` (trunk) | `{kind:"message", ref:"agent_messages:<id>", sha256(stored message)}` (`career_router_evidence.ts:135-149`) | entries in the thread's profile only |
| Web file (PDF, DOCX, RTF) | `#201 handler-career.ts:209-224` `resumeFileIntake` (`#201 career_resume_intake.ts:37`), read by `#201 career_resume_ingest_files.ts:98` | `{kind:"file", ref:<channel ref>, sha256(file bytes)}` via `#201 career_resume_intake.ts:176` `fileUploadFor` (`#201 handler-career.ts:753`) | bytes are not stored anywhere |
| Telegram document | `#194 telegram.ts:71-84` (document parsed), `#194 channel_inbound.ts:230-235` -> `#194 trainee-telegram/handler.ts:31-32` -> `#194 channel_resume_upload.ts` `ingestResumeFile` (download, own PDF/DOCX reader, store) | `{kind:"file", ref:"telegram:<unique> (career_resume_uploads:<id>)", sha256(file bytes)}` via `#194 handler-career.ts:719` -> `channel_resume_upload.ts` `fileUploadFor` | bytes in `career_resume_uploads` (`#194 20261026210016:106`); never reach `career_apply_cloud_resumes` (#202's reported gap) |
| Telegram paste | `channel_runtime.ts:11` -> handler (as web paste) | as web paste | as web paste |
| SMS / iMessage paste | `trainee-inbound` -> `channel_runtime.ts:11` -> handler | as web paste | as web paste |
| MMS attachment | not on trunk; in progress on `feat/sms-resume-attachments-20261026` (stacked on #201; its files: `loopmessage.ts`, `loopmessage_adapter.ts`, `trainee-inbound/handler.ts`, `career_resume_ingest_files.ts`) | will be #201's `{kind:"file"}` | none |
| Cloud resume from the web app ("turn the cloud on") | `trunk 20261021080000_career_apply_cloud.sql:240` `career_apply_cloud_resume_put_own` | none (no confirmation) | a second, separate resume store |

## 2. Where an apply path reads a resume

| Reader | Where | What it read before this branch |
|---|---|---|
| Chat apply ("apply to the X role at Y") | `trunk career_apply_chat.ts:243,267` `noResume` -> `career_apply_from_chat.ts:91` `resumeOnFileReader` -> `career_apply_profile_for` (`20261025120000:168`); `#206` reads `career_resume_on_file` first | the newest thread's profile: any confirmed fact with an event id |
| Server prepare (prepare-ahead) | `trunk career_prepare_ahead.ts:120` (resume on file), `workers/career-browser/prepare-ahead.ts:112` (`resumeFor`: a render tailored from `storedProfile` = `career_apply_profile_for`), `:147` (binds its sha256) | the newest thread's facts; the render in `career-resumes/<user>/<sha256>.pdf` |
| Card apply (web tap, text yes) | `trunk career_apply_cards.ts:279` -> `career_apply_card_answer_for` -> `career_apply_enqueue` (`20261025140000:33`) | the prepared payload's `resume_sha256`, whatever it was |
| Person's own computer | `workers/career-browser/approve-first.ts:462` (`career_apply_claim_own`), `:347` (local file must hash to the payload) | any local file the payload names |
| Extension | `extension/src/apply_core.ts:342`, `extension/background.js:1042` (`career_apply_extension_begin_own`) | the file the extension holds |
| Cloud runner (send) | `trunk cloud_runner.ts:178` -> `career_apply_cloud_resume` (`20261021080000:470`) -> `workers/career-cloud/worker.ts:161`; `#202 20261026230017:150-152` (`resume_not_in_cloud`) | `career_apply_cloud_resumes` by the payload's sha256 |
| Cloud runner (hosted prepare) | `#202 workers/career-cloud/prepare-runner.ts:38-40` `keptResume` -> `career_apply_cloud_resume_kept_for` (`#202 20261026230017:265`: the newest kept file) | the newest row of `career_apply_cloud_resumes` |
| Engine | `scripts/apply.ts:405` (hashes `--resume`), `:1092` (`RESUME_SHA_MISMATCH`) | the file it is given; it trusts the caller |
| Email apply | `career_apply_email.ts` (attaches a render from `career-resumes`; payload `attachment.sha256`) | a render |

Before: five places held "a resume" (profile entries, cloud file, renders, Telegram upload, the person's disk), nothing
tied them, a new resume left the old one live everywhere, and approvals made with the old one stayed good.

## 3. The glue (this branch)

One migration, one small chat turn. No file that #194 or #206 changes is touched.

1. **The record** `career_resume_record` (one row per person): `confirmed` with the sha256 of the bytes the person gave,
   `kind` file or paste, the confirmation event, `confirmed_at`, a generation; the bytes only when the database itself
   hashed them to that sha256 (a check constraint). `deleted` keeps no content.
2. **One door for every entry**: an `AFTER INSERT` trigger on `career_events` (`career_resume_from_event` ->
   `career_resume_take` -> `career_resume_put`). It checks the upload in the database, never on the event's word: a
   paste must be the person's own stored message (their thread, role user) hashing to the event's sha256; a Telegram file
   must be bytes in `career_resume_uploads` (read only when that table exists) for this person hashing to it; a file the
   database holds no bytes for (#201's web read) is recorded by its sha256 with no copy. The cloud put from the person's
   signed-in computer (`career_apply_cloud_resume_put_own`) goes through the same door (`career_resume_from_cloud_put`).
   The same resume again changes nothing.
3. **A change stops the old one**: everything made before the new confirmation that does not carry the new file is
   stopped: approved-but-not-handed-out applications are removed from the queue (so the posting can be approved again
   with the new resume), prepared ones are discarded with their prepare tries (so they are prepared again), ones being
   sent are counted; what they carried is retired (`career_resume_retired`) and never carried again. The cloud keeps
   exactly the new file (or nothing, for a paste). One timeline note says what stopped.
4. **The readers** (`career_resume_allowed`, three triggers, one function):
   - `career_apply_profile_for` (chat apply, server prepare, own-computer prepare, #202's hosted prepare, #206's
     `career_resume_on_file`): for a person with a record, the thread whose profile holds the record's entries comes
     first (Telegram, then the web), and only the entries from the record's upload are returned; none when deleted.
   - `career_apply_jobs` (insert queued or driving; a claim queued -> driving is skipped; any other way into driving is
     refused) and `career_apply_prepared` (insert, payload change): the resume carried must be allowed. Refusals read
     `no_resume: ...` (#194's card answer maps that word to `no_resume`).
   - Allowed: no record -> unchanged while the owner's switch is off; deleted -> never; retired -> never; the record's
     own sha256 -> only for a file (a paste's text is never the file); a render stored in `career-resumes` after the
     confirmation -> yes; any other sha256 -> only while the switch is off (the in-memory render stores the existing
     tests use are invisible to the database).
5. **Delete and erase**: "delete my resume" (`career_resume_delete_as`) and an account erase (epoch bump) remove the
   record's content, every kept cloud file and every upload, then stop what was bound as in 3.
6. **The switch** `career_resume_everyone_on()` (database owner only): records the resume of each person who confirmed one
   before this migration (the same checks), turns the strict rule on for everyone (no record -> nothing prepared or
   sent; unprovable renders refused), and closes earlier unbound queued rows as `not_submitted` with the reason, as
   20261026210016 does for its rule. Off until the owner runs it.
7. **The chat** (`supabase/functions/_shared/career_resume_record.ts`, reached through `cloudTurn` in
   `career_cloud_optin.ts`, which every channel's text reaches before any brain): "what resume do you have", "do you have
   my resume", "delete my resume (pls)" and close phrasings, answered from the record.

## 4. #194 and #201: one file-intake design

Both PRs are labelled FEATURE 16 and both read resume files. Keep #201's extraction path; keep #194's Telegram download
and its resume-rule gates, feeding #201's path. Patch notes, to forward as written:

**To the #194 builder (also #206, stacked on it)**
1. Keep: `telegram.ts:71-84` (the document parsed), the adapter's `fetchFile` (`channel_adapters.ts:102`,
   `telegram.ts`), the 10 MB cap, and every gate (`20261026210016` triggers, `cardTurn` `resumeReady`
   `handler-career.ts:365`, `approve-first.ts`, `worker.ts`), and `career_resume_uploads` with
   `career_resume_upload_record_as` (`#206 20261026210016:95,117`).
2. Remove the second extraction path: `channel_resume_upload.ts` `fileKind`, `fileText`, `resumeMessage`,
   `ingestResumeFile` (`:36-101` at #194) and its "here is my resume:\n" framing; `channel_inbound.ts:81-83` (`resumeFile`
   dep) and `:230-235` (`fileMessage`); `trainee-telegram/handler.ts:10,31-32`.
3. Instead, in the Telegram adapter, download the document with `fetchFile` and set #201's `msg.upload`
   (`#201 channel_adapters.ts:57-59`: `{ bytes, name, mime, ref: "telegram:<file_unique_id>", sha256 }`); #201's
   `channel_inbound.ts:127-131,211` and `channel_runtime.ts:25-26` then carry it to the turn as `resume_file`.
4. Remove `fileUploadFor` from `channel_resume_upload.ts` (`:116-127`) and its call at `handler-career.ts:84,719`; #201's
   `fileUploadFor` (`career_resume_intake.ts:176`, called at `#201 handler-career.ts:753`) names the file instead.
5. Keep storing the bytes, from #201's path: see 2. below for #201; the ref recorded must end in
   ` (career_resume_uploads:<id>)` so the record keeps a verified copy (this branch's trigger reads it).
6. Rebase on #201 once it merges; `handler-career.ts` then carries only #194's `resumeOnFileReader` import and the
   `cardTurn` change.

**To the #201 builder (and the SMS/MMS builder stacked on it)**
1. Keep everything in `career_resume_ingest_files.ts` and `career_resume_intake.ts`, the handler blocks
   (`handler-career.ts:209-224,367-388,753,797-803`) and the channel plumbing (`channel_adapters.ts:57-59`,
   `channel_inbound.ts:127-131,211`, `channel_runtime.ts:25-26`).
2. Add one call after a file is read (`resumeFileIntake` ok, `handler-career.ts:~224`): store the original bytes with
   #194's `career_resume_upload_record_as(p_user, p_channel, p_ref, p_filename, p_mime, p_bytes, p_sha256,
   p_content_b64, p_message_sha256)` (channel `web` for the app, `telegram` for a bridge turn from Telegram; the MMS
   builder needs `sms` or `imessage` added to that table's channel check), with `p_message_sha256` = sha256 of the
   stored `userContent`, and keep the returned id on `HeldUpload` so `fileUploadFor` (`career_resume_intake.ts:176`)
   returns `ref: "<ref> (career_resume_uploads:<id>)"`. Without it a web file is recorded with no copy: the cloud
   cannot attach it (fail closed, said in the status reply).
3. Nothing else changes; this branch merges cleanly with #201 as it stands (`git merge-tree`, section 6).

## 5. The cloud runner (#202) and people with only a phone

A person with only a phone has no computer and no extension: only the cloud sends for them, and it runs as the service
for one job at a time (lease, `career_apply_cloud_resume` checks the job's person, epoch and sha256). With this branch:
- the record's file is the only row in `career_apply_cloud_resumes` for the person (put on confirm, every other row
  removed; removed on change, delete and erase), so #202's `career_apply_cloud_resume_kept_for`
  (`#202 20261026230017:265`, the newest kept file) returns the record's file, and #202's claim check
  `resume_not_in_cloud` (`:150-152`) passes only for it (same epoch, bytes hash);
- a Telegram file (once #194 stores bytes as above) reaches the cloud with no extra step: the gap #202 reported is closed
  by the trigger, not by a call in #202;
- a paste or a web file with no kept copy leaves the cloud nothing to attach: #202's hosted prepare records `no_resume`
  and says "I don't have your resume file to attach. Send it here as a PDF or Word file." (`#202 career_hosted_prepare.ts:43`);
  the status reply here says the same in its own words.
- Not solved here (item 2 of the readiness analysis): nothing yet sends as the person for an account that only texts; the
  cloud is the only sender and it is off until the owner's switches (`CAREER_CLOUD_APPLY`, #202's `CAREER_CLOUD_TEXT_CARDS`).

## 6. Merge and tests

This branch's own change, applied on the PRs' base (9d4226fc0), merges with no conflict (`git merge-tree --write-tree`)
with #194 (82ec2e688, its head at the time of the check), #206 (cb3a008da), #201 (44d9ea43a) and #202 (d74ee2035).
Against today's trunk (with #197 and #207 merged) #194, #206 and #202 already conflict in `trainee-go-live.sh`,
`rehearse_live_migrations.sh` and `tests/db/run.sh`; this branch adds no conflict of its own there (its lines sit away
from theirs: the migration list before `20261026140000`, the mark before `career_apply_receipt_files`, and the rehearsal's
not-live list at its first line). Files touched: the migration, `career_resume_record.ts` (new), `career_cloud_optin.ts`
(+9 lines), `trainee-go-live.sh` (+2 lines), `rehearse_live_migrations.sh` (+1 -1 and a comment), this document, two tests.

Tests: `tests/architect/one-resume-record.test.ts` (database, 8 steps, plus the chat's phrasings and replies) and
`tests/architect/flow-one-resume.test.ts` (the real chat handler, 7 steps). The PR body carries the fail-first output on
trunk, the mutation table and what is not proven.

## 7. Gaps seen and not closed here

- The same resume content in a new file: the router says the entries are already on record and records no new
  confirmation, so the record keeps the earlier upload (an older PDF stays the one the cloud attaches). Needs a router or
  intake change (files #194 and #201 own).
- After a refused apply in a texting thread, pasting the resume again in that same thread was answered "I did not catch
  what to do with that one" (seen in the flow test; the same paste on the web was read). Cause not isolated.
- A web file (#201) keeps no bytes until #201 stores them (section 4, #201 note 2): such a record has no copy for the cloud.
- With the switch off, a render the database cannot see (kept outside storage) and a local file on the person's own
  computer are not refused for a person with a record; only `career_resume_everyone_on()` makes that strict.
