# File records: the stores the File families still lack

R10 fix 9 (WO-E), architect order of 2026-11-09. A File family is served from data that already exists wherever it can be
(read adapters, the next WO-E PR). Four families have no store anywhere: the search plan (F-04), the per-role workspace (F-06),
the answer library (F-08) and the plan Files (F-14 weekly brief, F-14n negotiation plan). This document designs those stores so
the architect can assign the migrations. Sections 1 and 5 are built (item 6 S3, migration 20261110160000; the F-04 and F-07 Files
are drawn from those rows by `_shared/file_family_records_materials.ts`, and `approveplan` and `approvedoc` are served there). The others
stay disabled on every page until their stores exist.

## Rules every table here follows

- **Owner only.** Every row has `user_id uuid not null references auth.users(id) on delete cascade`. RLS is enabled; the
  only policy is `select to authenticated using ((select auth.uid()) = user_id)` (the `career_interviews` pattern,
  20261021050000). `revoke all ... from public, anon, authenticated; grant select ... to authenticated; grant all ... to
  service_role`. No client ever writes; every write is the service role, from the code named below.
- **Facts only from confirmed facts (D-007).** A row stores references to facts and their sources, never a value the person
  did not confirm. Where a value is the person's own estimate or an inference, its kind is stored beside it.
- **Approval binds a hash.** Anything that authorizes an effect stores the exact payload hash it was approved against, and
  the time. A changed payload has a new hash and needs a new approval (D-MS-1).
- **Versions, not overwrites.** A record that the person approves keeps every version; the approved one is named
  explicitly. "Newest" is never "approved".
- **Delete with the account.** `on delete cascade` from `auth.users`; `delete-account` needs no new code.
- **Rollback.** Each migration ships its `.rollback.sql` and is listed in the go-live migration list
  (`scripts/launch/`), as every migration is.

## 1. `career_search_plans` (F-04 Search plan)

| column | type | notes |
| --- | --- | --- |
| id | bigserial pk | |
| user_id | uuid | owner |
| version | int not null | 1, 2, ... per person; unique (user_id, version) |
| title | text not null | "Climate operations search" |
| hard | jsonb not null | `[{ k, v, src: { kind: "you" \| "resume" \| "brief", fact_id? } }]` - cannot be overridden by fit |
| prefs | jsonb not null | same shape - influence ranking, never gate |
| batch_cap | int not null | first batch maximum |
| watch | jsonb | `{ active, cadence, stops_at }` or null |
| payload_hash | text not null | sha256 of the canonical (hard, prefs, batch_cap, watch) |
| approved_at | timestamptz | null until the person approves this version |
| approved_hash | text | the hash approved; must equal payload_hash |
| created_at | timestamptz default now() | |

- **Built** (20261110160000): as above, with `watch` stored as `{ text, active }`; `payload_hash` is computed on insert from the
  content; `career_search_plan_approve_as` answers `approved`, `already`, `stale` (another hash), `superseded` (a newer version
  exists) or `missing`. The plan-step writer is not built yet.
- **Writes:** the career brain's plan step (agent-chat) inserts a new version; the File's `approveplan` action sets
  `approved_at`/`approved_hash` for that exact version through the trainee-file handler (it changes only this person's
  own row - the architect's condition for `approveplan` being WO-E's).
- **Reads:** F-04 adapter; the search reads only the newest approved version. Approval authorizes searching and
  shortlisting only (E-66); nothing here can queue an application.

## 2. `career_role_workspaces` (F-06 Role workspace)

| column | type | notes |
| --- | --- | --- |
| id | bigserial pk | |
| user_id | uuid | owner |
| job_id | text not null | the posting (`career_postings.job_id`); unique (user_id, job_id) |
| rid | text | stable short id (R-07) |
| eligibility | jsonb not null | `[{ text, state: met\|partial\|missing\|unknown, hard: true, src }]` - mandatory, from the posting |
| fit | jsonb not null | same shape, `hard: false` - preferences |
| route | jsonb not null | `{ supported, text, you: [step] }` - what the extension or runner can do, and what only the person can |
| materials | jsonb not null | `[{ k, version_id, approved }]` - references to resume and letter versions, never copies |
| declaration | text | the posting's attestation, verbatim, if any |
| checked_at | timestamptz | when the posting was last read live |
| updated_at | timestamptz default now() | |

- **Writes:** the preparation step (prepare-ahead / career_apply_prepare) upserts after it reads the posting; the route
  comes from the runner's own capability check (BROWSER-COVERAGE.md), never from the model.
- **Reads:** F-06 adapter. A fit label is never drawn while a hard row is not `met` (E-68).

## 3. `career_answer_library` (F-08 Answer library)

| column | type | notes |
| --- | --- | --- |
| id | bigserial pk | |
| user_id | uuid | owner |
| question_key | text not null | normalized question (row_answer.ts key) |
| kind | text not null | `factual` \| `role_specific` \| `scoped` \| `declaration` \| `sensitive` |
| answer | text | verbatim; null for `sensitive` (never stored as reusable) and for an unreviewed `declaration` |
| scope | jsonb | `{ roles?, places?, until? }` - outside it, the question is asked again |
| source | jsonb not null | `{ kind: "you" \| "resume" \| "approved_application", at, ref }` |
| reviewed_at | timestamptz | declarations block until set; never pre-set |
| updated_at | timestamptz default now() | |
| | | unique (user_id, question_key, kind) |

- **Writes:** the employer-question answer path (`career_apply_questions` answers the person gave, row_answer.ts) and the
  person's own review in the File. A sensitive field (work authorization, sponsorship, demographics, disability, veteran
  status, graduation date, GPA) is never written with an answer: it is answered per application (D.4-6).
- **Reads:** F-08 adapter; the apply engine reads `factual` and in-scope `scoped` answers only.
- **`approvedoc`** is not this table (see 5).

## 4. `career_plan_files` (F-14 Weekly brief, F-14n Negotiation plan)

| column | type | notes |
| --- | --- | --- |
| id | bigserial pk | |
| user_id | uuid | owner |
| kind | text not null | `weekly_brief` \| `negotiation` |
| period | text | weekly: the ISO week; negotiation: the offer id |
| version | int not null | unique (user_id, kind, period, version) |
| body | jsonb not null | weekly: `{ changed[], decisions[], blockers[], urgent? }`; negotiation: `{ position[], history[{ v, written, text, src }], ask }` |
| sources | jsonb not null | every number or term in `body` points here: `[{ id, label, href?, at }]` |
| generated_at | timestamptz not null | |
| paused | boolean not null default false | Pause keeps records; nothing new is generated while true |

- **Writes:** the weekly brief job (career-proactive, `CAREER_BRIEF_DIGEST`) and the negotiation planner (agent-chat).
  A competing offer, deadline or acceptance intent is written only with a document source (E-77). Approving a
  negotiation plan writes nothing else and sends nothing; the counter goes through the message review (F-12).
- **Reads:** F-14 and F-14n adapters.

## 5. Material versions and `approvedoc` (F-07)

Built (item 6 S3, migration 20261110160000): WO-B's versions table never landed, so the versions live in
`career_material_versions` (one row per version of one document `doc_key`: `doc_kind` resume or letter, `version`, a human
`label` such as "the one-page data analyst draft" (E.4 40), `based_on`, `role_job_id` and `rid`, the `changes` summary,
`format_check`, the file (`file_name`, `file_bytes`, `file_sha256`, checked against the bytes), `payload_hash` computed on
insert from the content, and `approved_at`/`approved_hash`/`approved_role`). A row's content never changes after insert, and an
approved row is never changed or deleted while its owner exists (a trigger). `approvedoc` (`career_material_version_approve_as`)
approves the exact version for the role it was made for: a stale hash is `stale`, another role `wrong_role`, and approving a
newer version leaves every approved one as it was. The apply engine must send the approved version for that role, never the
newest (wiring the engine to read it is not part of S3).

## Order of work (proposal)

1. `career_answer_library` - the apply engine already has the answers; this only gives them a durable, reviewable home.
2. `career_search_plans` with `approveplan` - small, owner-only, unblocks F-04.
3. `career_role_workspaces` - needs the runner's capability check to fill `route` truthfully.
4. `career_plan_files` - after the weekly brief and negotiation planner exist as writers.
5. The `approved_*` columns on WO-B's versions table, then `approvedoc`.

Each is its own migration PR with RLS tests in `tests/db/` (owner reads own rows; another account reads nothing; anon
reads nothing; authenticated cannot write), and its adapter and family wiring in a WO-E follow-up.

## 6. How each File family is reached from the chat (D-072, files reachable)

Owner standard (behavior guide P5/P17, "complete product"): every File family the product defines is reachable from the chat
when the person's ask calls for it, made from their real records, and a "made" claim needs a made File that opens (D-066 P6,
D-067). Before D-072 no production code called `createFamily`, so the record-backed pages below were served and tested but
unreachable (item 6b report, `docs/architect/reports/ITEM6B-ROOT-CAUSES-20261112.md`).

The chat path for the eleven record-backed families: the person's ask (`_shared/file_family_ask.ts familyAskOf`) routes the
turn to the brain in staged mode (`career_staged.ts`, reason `file_family_ask`; an exact payload, an approval, a control such as
"pause my weekly brief" and a bare reply stay code's). The brain calls `open_record_file` with the family's name only
(`_shared/agent/file_family_tool.ts`); code reads the person's records through the same `FamilyRecords` the File server draws
the page from (`_shared/file_family_make.ts makeFamilyFile`, `supabaseFamilyMaker`), and makes the File with
`createFamily(userId, family, title, null, { ref })` only when the records hold something: no view is stored, the page reads the
records on every open. The link is minted by code and rides the reply (`fileLinks`); the tool returns what the page holds
(`holds`, from the page's own view), and the reply says only that. Nothing on record: no File is made and the reply says what
is missing (never a hollow File). Records unreadable: nothing is made. If the model answers the ask without the tool, the
process check asks it once (`career_brain.ts processCheck familyFile`). Approvals on these pages stay POST forms bound to the
payload hash shown (D-MS-1, D-MN-2).

| Family | File | The ask (examples) | Creator | Records the page reads | Before D-072 | After |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | Career brief | "show me my career brief" | `open_record_file` career_brief | account (stated facts, confirmed resume), standing, events | unreachable | reachable (drawn for everyone: what is not on record is named "Not set yet" / Unknown) |
| F-02 | Profile facts | "show me my profile facts", "give me the page with my profile" | `open_record_file` profile_facts | account, standing | unreachable | reachable (drawn for everyone, Unknowns named) |
| F-03 | Path comparison | "open my path comparison" | `open_record_file` path_comparison | none: no store of compared directions exists | unreachable | wired; answers "nothing on record" and makes no File until a store exists |
| F-04 | Search plan | "show me my search plan" | `open_record_file` search_plan | `career_search_plans` (newest version) | unreachable | reachable when a plan row exists (the plan-step writer, section 1, is not built) |
| F-05, F-06, F-10, F-11 | Roles list, role workspace, batch, pipeline | a search ("find me analyst internships in Chicago") | the results list (`role_results.ts`, `file_family_live.ts`) | the results list | reachable | unchanged |
| F-07 | Materials | "open my materials page" | `open_record_file` materials | `career_material_versions` (the newest document) | unreachable | reachable when a version row exists (no production writer yet, section 5) |
| F-08 | Answer library | "what's in my answer library?", "show me my answers page" | `open_record_file` answer_library | `career_apply_questions` | unreachable | reachable |
| F-09 | Application review | the card's review link | `createReview` (`application_review_links.ts`) | the prepared application | reachable | unchanged |
| F-12 | Message review | "show me the message review" | `open_record_file` message_review | `career_outreach_drafts` (newest waiting for a decision, else newest) | unreachable | reachable |
| F-13 | Interview hub | "pull up my interview hub", "show me my interviews page" | `open_record_file` interview_hub | `career_interviews` | unreachable | reachable |
| F-14 | Weekly brief | "send me my weekly brief", "where's my weekly summary" | `open_record_file` weekly_brief | `career_digest_prefs`, `career_events`, questions, interviews | unreachable | reachable (drawn for everyone: a quiet week says so) |
| F-14n | Negotiation plan | "show me my negotiation plan" | `open_record_file` negotiation_plan | the offers the person told Trainee | unreachable | reachable |
| F-15 | Offer comparison | "show me my offer comparison", "give me a file comparing my offers" | `open_record_file` offer_comparison | the offers the person told Trainee | unreachable | reachable |

Tests: `tests/architect/files-reachable-d072.test.ts` (each family from its ask through the real brain turn and File server,
nothing on record, hash-bound approvals, the process check) and `tests/architect/files-reachable-d072-pg.test.ts` (the real
agent-chat handler on Postgres 16, the link opened through the deployed File server's dependencies).
