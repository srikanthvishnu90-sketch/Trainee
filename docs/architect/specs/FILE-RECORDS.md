# File records: the stores the File families still lack

R10 fix 9 (WO-E), architect order of 2026-11-09. A File family is served from data that already exists wherever it can be
(read adapters, the next WO-E PR). Four families have no store anywhere: the search plan (F-04), the per-role workspace (F-06),
the answer library (F-08) and the plan Files (F-14 weekly brief, F-14n negotiation plan). This document designs those stores so
the architect can assign the migrations. Until they exist, `approveplan` and `approvedoc` stay disabled on every page
(the no-dead-buttons guard, `_shared/file_routes.ts`, landing with the WO-E stack).

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

F-07 reads the resume and letter versions WO-B is adding (`career_resume_versions`, E-40 version labels). `approvedoc`
needs one column there, not a new table: `approved_at timestamptz` and `approved_hash text` on the version row, set only by
the File's `approvedoc` action for that exact version and role (`role_job_id text`). The apply engine sends the approved
version for that role, never the newest. Until WO-B's table lands, `approvedoc` stays disabled.

## Order of work (proposal)

1. `career_answer_library` - the apply engine already has the answers; this only gives them a durable, reviewable home.
2. `career_search_plans` with `approveplan` - small, owner-only, unblocks F-04.
3. `career_role_workspaces` - needs the runner's capability check to fill `route` truthfully.
4. `career_plan_files` - after the weekly brief and negotiation planner exist as writers.
5. The `approved_*` columns on WO-B's versions table, then `approvedoc`.

Each is its own migration PR with RLS tests in `tests/db/` (owner reads own rows; another account reads nothing; anon
reads nothing; authenticated cannot write), and its adapter and family wiring in a WO-E follow-up.
