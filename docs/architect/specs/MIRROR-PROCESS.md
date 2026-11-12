# Mirror process, batch 1: the same process as Instinct on all 26 turns

**Owner, 2026-11-11:** "don't deploy until everything has matched. Trainee verifies all 26 convos and the process for every
convo being similar is the same." The reply text is scored elsewhere (`evals/mirror/instinct-wa-batch1/results/`). This spec is
the **process**: for each turn of the WhatsApp benchmark (`evals/mirror/instinct-wa-batch1/`), what Instinct visibly did, the
steps Trainee must take (the tools, in order), the artifact, the boundary line, and which Trainee capability provides each step
today.

- **EXISTS**: Trainee serves the step today (the tool or module is named). The turn's process is asserted at $0 through the real
  handler in `tests/architect/mirror-wa-batch1-process.test.ts`.
- **OFF**: the code exists and a release switch keeps it off (`supabase/functions/agent-chat/release_config.ts`).
- **MISSING**: what has to be built or provided.

A turn with any OFF or MISSING step is **blocked**: it is listed in the test's `BLOCKED` table with the named blocker, and
`tests/architect/mirror-process-blocked.test.ts` asserts its full process and fails until the capability lands. The
test reads the summary table below and fails if a row and the test disagree.

What the benchmark could see of Instinct's process is its replies (the tools behind them are inferred from what each reply
shows: a link, a File, a PDF, "nothing was submitted"). Where Instinct read something Trainee has no copy of here (the tester's
Gmail, the web), `prompts.jsonl` marks the turn's `needs`.

## The backtest is production's configuration

Owner, 2026-11-11: "Make sure everything is turned on in production, whenever testing." Every mirror and process test, and
every live mirror run, runs with the release configuration exactly as `release_config.ts` ships it: each `RELEASE_FLAGS` switch
at its release value (read through `releaseValue` / `releaseFlagOn`, with no environment override in either direction), every
`RELEASE_NEVER_ON` switch off, and the brain `PRODUCTION_BRAIN`. No test-only setting turns a production feature off or a
never-on one on. `tests/architect/helpers/mirror_process.ts` clears every release and never-on switch before the conversation
(the shared response world turns `CAREER_MAIL_TRACKING` off for its own tests; the mirror does not), and
`mirror-wa-batch1-process.test.ts` asserts on every one of the 29 turns (3 setup, 26 scored) that the handler's effective flags
equal `RELEASE_FLAGS`, that no never-on switch is on, and that the brain is `PRODUCTION_BRAIN`. What differs from production is
only what a $0 run must replace: the model is scripted, and every host but the database double is refused (each refused request
is recorded with its address). A turn that is blocked because a switch is off is blocked in production too: the blocker is
named, never worked around by a test-only switch.

## How we mirror a reference product

The loop, reusable for any reference (Instinct batch 2, another assistant, a human expert's transcript):

1. **Capture the reference transcript verbatim.** Every prompt in order with its timing, every reply message in order with its
   latency, and what the reference knew going in (the persona). Personal details become fictional names in the repository; the
   verbatim copy stays with the owner (`evals/mirror/instinct-wa-batch1/README.md`).
2. **Write the per-turn process spec** (this file): what the reference visibly did on each turn, the steps Trainee must take
   (tools, in order), the artifact, the boundary line, and each step's capability: EXISTS, OFF (the flag), or MISSING (what to
   build or provide).
3. **$0 process tests** through the real handler with a scripted model under production's configuration: the EXISTS turns'
   process asserted (`mirror-wa-batch1-process.test.ts`); the blocked turns' full process in a pending test that fails until
   each capability lands (`tests/architect/mirror-process-blocked.test.ts`). Never ignored, never weakened.
4. **Live run under production flags** with the real model, only on the owner's approved spend (D-057 style), through
   `.github/workflows/mirror-conversation.yml`.
5. **Score both the text and the process**: the reply against the reference's (`evals/mirror/score-conversation.ts`), and the
   process (the tools called, the artifact made, the boundary said, nothing sent) against this spec.
6. **Fix by cause**: routing, instructions, tool exposure or a missing capability. Never canned reply prose, never a test edited
   to pass; an owner ruling where the reference's behaviour changes a rule (D-059).
7. **Re-run** steps 3 to 5 until every turn matches. The deploy waits on the last blocked turn (owner, 2026-11-11).

## Summary

| Turn | Status | Blocker (what is missing or off) |
|---|---|---|
| C1 | EXISTS | `search_jobs` and `create_file` (`plan_review`) are both offered to the brain with the reply writer off (D-061 G11); the File holds the checked postings and the weekly plan |
| C2 | EXISTS | (D-059, this PR: no recipient named is drafted with placeholders) |
| C3 | EXISTS | |
| C4 | EXISTS | (D-063: `research_career_question` kind `advice`, one cited guide, its link on its own line; the header education line read as drafts) |
| C5 | EXISTS | |
| C6 | EXISTS | D-062: `read_application_mail` (the person's Gmail confirmations, researched roles and drafts kept apart, coverage) |
| C5f1 | EXISTS | |
| C5f2 | EXISTS | |
| C7 | EXISTS | |
| C8 | EXISTS | |
| C9 | EXISTS | (D-060 web research: `research_market` with Claude's web search) |
| C10 | EXISTS | (D-063: no email on the confirmed resume or typed prints a visible `[your email]` placeholder in a chat review draft, never the account's) |
| C11 | EXISTS | (D-062: `inspect_apply_flow`, the posting and its form read from public pages only; Workday's questions named as behind sign-in) |
| C12 | EXISTS | |
| C13 | EXISTS | (D-059) |
| C14 | EXISTS | (D-059) |
| C15 | EXISTS | |
| C16 | EXISTS | D-062: `export_tracker` (the tracker File kind, built by code, corrections named) |
| C17 | EXISTS | |
| C18 | EXISTS | (D-060 `check_posting_open`; since D-062 a Workday posting is read from its own CXS data, with its stated deadline) |
| C19 | EXISTS | D-062: `find_people` (web search excerpts; `CAREER_PEOPLE_SEARCH` and `CAREER_CONTACT_OUTREACH` in RELEASE_FLAGS) |
| C20 | EXISTS | (D-063: `tailor_resume` `edits`, condense and expand from confirmed details only, a v2 PDF) |
| C21 | EXISTS | |
| C22 | EXISTS | (D-060: `get_posting` pay, then `research_market`, self-reported figures labelled) |
| C21f | EXISTS | |
| C23 | EXISTS | (D-060: the earlier search from the cache, same source; and this PR: a link Trainee already showed is kept on recall) |

25 EXISTS, 1 blocked (C1, OFF): D-062 (1) moved C11 to EXISTS (the read-only apply-flow reader); D-062 (#777) moved C6, C16 and C19
(the Gmail record, the tracker, public people search); D-063 moved C4, C10 and C20 (asserted in MP-1). Before them: 18 EXISTS, 8 blocked,
after D-060 (web research on, merged 2026-11-11) was verified turn by turn here: C9, C22 and C23 moved to EXISTS; C4 did not then (the
research path answered a different question); C1's plan page is not the File Instinct made. The deploy the owner asked to hold waits on C1.

## Rules every turn keeps

- Nothing is sent, submitted, queued or saved as an application on any of the 26 turns (every ask says don't send, don't apply,
  or just explain). The test holds `career_apply_*`, `career_outbox`, `career_contact_sends` and `career_outreach_drafts` empty.
- The only requests that leave the machine are reads: posting-page reads of the open check (D-051), the search's (C3), the
  asked re-check (C18) and the apply-flow read (C11: the posting's own page and its public form; on Ashby the one read-only
  GraphQL query its page makes), and on the research turns (C9, C22, C23) the research reader's GETs of public pages and boards. In the $0
  test each is refused and recorded, and the web search itself is a stub on the model host (D-060's live proof is
  `evals/research-live/`).
- Facts about the person come only from confirmed facts and this conversation (D-007). A hypothetical (C7, C15) writes nothing.
- "Boundary line": the sentence that says what was not done ("Nothing was submitted", "Nobody was contacted", "not sent"). Where
  code writes it, it is asserted; where the brain writes it, the prompt asks for it and the condenser keeps it
  (`career_brain.ts condensedOk`).

## Per turn

Format: **Instinct** (what it visibly did) / **Steps** (Trainee's tools, in order, each with its capability) / **Artifact** /
**Boundary**.

### C1 "i need to lock in for recruiting, what should i actually be doing rn to land a swe internship for next summer" (OFF)
- **Instinct:** a live search; each of five postings verified open; one merged reply with C3: priorities (fix the outdated GPA,
  apply to these), the stretch role labelled; a File with the links and a weekly plan.
- **Steps:** (1) the brain (staged; reason `question`) - EXISTS. (2) `search_jobs` with the person's goal - EXISTS
  (`career_tools.ts`). (3) each posting re-checked before it is shown - EXISTS (`link_check.ts liveOnly`, WO-106/D-051).
  (4) one File with the links and a weekly plan - **OFF**: the `plan_review` kind exists (`file_kinds.ts`), but `create_file`
  is offered only when `o.shape` (Telegram and `CAREER_REPLY_WRITER=on`, which is in `RELEASE_NEVER_ON`). Since D-060
  `research_career_question` is offered and publishes a plan page, but that page holds no postings.
- **Artifact:** a plan File. **Boundary:** nothing applied.
- **D-065:** live round 1 wrote the plan without a search and saved two profile facts from the question. Now the plan ask aimed
  at postings (`turn_notes.ts planSearchAskOf`, on the message or the one it arrived during) carries a turn note and a process
  check: `search_jobs` runs before the plan; and a message that asks writes no fact beyond its own first-person statements.

### C2 "draft a cold message to a google swe asking for a referral, don't send anything" (EXISTS)
- **Instinct:** a draft from the confirmed profile (school, Waypoint, 70+ React sites) with `[Name]` and `[job link]` placeholders;
  no question about the recipient; not sent.
- **Steps:** (1) the brain - EXISTS. (2) `draft_followup` (kind `note`, recipient empty) - EXISTS; code checks the draft
  (no invented meeting, referral, figure or name; no guessed address) and shows it as "Draft, not sent:" (`followup_draft.ts`).
  Before this PR code refused a draft with no recipient and asked who it was for; **D-059** makes it draft with placeholders and
  ask for the recipient only at send time. A greeting or sign-off word ("Best, Sam") is no longer read as a name, and a
  short form of words the person typed ("CS" for "Computer Science") is theirs.
- **Artifact:** the draft. **Boundary:** "not sent" (code's label).
- **D-065:** live round 1 (C2, C13, C14) wrote the drafts as prose. A draft ask (`draftAskOf`) now carries a turn note and a
  process check (one review asking for `draft_followup`); the reply is the tool's text, shortened only in its wording before it
  is shown when over the draft bound, and re-checked.

### C3 "find me 5 swe internships i could actually apply to right now, chicago or remote" (EXISTS)
- **Instinct:** answered with C1's reply and File: five named postings, live, the stretch labelled.
- **Steps:** (1) code's search (`career_internship_discovery`) - EXISTS. (2) each posting shown re-checked on its own page, at
  most the count asked (D-051, `link_check.ts searchCheck`) - EXISTS. (3) the results File (`role_results.ts`, needs
  `TRAINEE_FILE_BASE_URL`) - EXISTS. (4) an honest count when fewer than 5 are found - EXISTS.
- **Artifact:** the results File. **Boundary:** "Nothing was applied for" (code).

### C4 "what should i put at the very top of my resume for swe roles, be specific" (EXISTS)
- **Instinct:** name and contacts, then school, degree and graduation date, then a skills line; leave the outdated 3.9 off; one
  cited guide page.
- **Steps:** (1) the brain with the confirmed profile in its prompt (`memory.ts personBlock`) and `get_profile` - EXISTS.
  (2) the outdated GPA flagged from what the person said - EXISTS (the conversation; the GPA correction is in the window).
  (3) one cited source for the advice - EXISTS since D-063 (was MISSING). Verified after D-060 at $0 with a stubbed search: `research_career_question`
  is now offered, but it answers the question as a career-entry plan ("the way in is shipped projects ... This week: build one
  small tool") with no source link, i.e. a different task; `research_market` is market research. Needed: a sourced answer to a
  specific advice question (one guide, its link).
  **D-063:** `research_career_question` with `kind: "advice"` (the model's choice, G1): one web search (D-060's searcher, cached),
  passages kept by the guard, one source chosen by code (school, government, non-profit guides first), the answer first and the
  source link alone on the last line, written by code (`research/advice.ts`, `career_brain.ts`). With no source, no link and the
  answer says it is judgement. The persona's education line, which sits under the name with no "Education" heading, is now
  read as education and GPA drafts for the person's yes (`122-career-profile.js headerEducation`), so the school, degree and
  date the answer names are confirmed facts.
- **Artifact:** none. **Boundary:** none needed.

### C5 "quiz me on a python question like it's a real interview, one at a time" (EXISTS)
- **Instinct:** one coding question; "talk me through your approach before writing code".
- **Steps:** the brain (`prep_serve_mismatch`, WA1-2), no bank question served, nothing scored; the prompt's length note says
  "the question and one line on how to answer it" (`turn_notes.ts`) - EXISTS.
- **Artifact:** none. **Boundary:** none needed.

### C5f1 "i'd count each number with a dict ... o👎 time, o👎 space" (EXISTS)
- **Instinct:** affirms the approach, reads the emoji as "(n)", asks for the code including the empty list.
- **Steps:** the brain with the question it asked in its history; no rubric score (`prep_rubric_read`) - EXISTS.

### C5f2 "def first_unique(nums): ..." (EXISTS)
- **Instinct:** code review: catches the StopIteration on no unique number, gives the fix, asks a harder follow-up.
- **Steps:** the brain with the conversation; no rubric score - EXISTS. (No code is executed; Instinct showed none either.)

### C6 "have i applied to anything yet? trying to keep track" (EXISTS, D-062)
- **Instinct:** evidence from Gmail confirmations across three accounts; separates confirmed applications from tonight's
  researched roles; says what could be missing; offers a running tracker.
- **Steps:** (1) the staged route sends the ask to the brain (`career_staged.ts applicationRecordAsk`, with
  `CAREER_MAIL_TRACKING` on). (2) `read_application_mail` (`_shared/agent/capability_tools.ts`,
  `_shared/career_application_record.ts`): one mail run for this person now over every connected account (the scheduled run's own code), then the
  applications with their evidence (the employer's email, Trainee's submission record, or the person's word), the roles this
  conversation listed kept apart as research, unsubmitted drafts, the coverage (one connected Gmail; another address or a
  portal-only status is missed), and what changed since last shown. (3) No Gmail connected: said, with the connect link (the
  person signs in to Google themselves). **Several Gmail accounts** (D-062, migration 20261111120000): connecting another
  Google account adds it (`career_google_accounts`); every account is read, each piece of evidence names the account it came
  from, and the coverage says how many accounts were read (`tests/architect/d062-google-accounts.test.ts`).
- **Artifact:** none. **Boundary:** "tonight's roles were research only". Asserted in MP-1 (no Gmail) and in
  `tests/architect/d062-capabilities-process.test.ts` D62-1 (a stub Gmail with an employer's confirmation).

### C7 "hypothetically if i had two offers, 120k in chicago vs 140k in nyc ..." (EXISTS)
- **Instinct:** net framing, a lean, challenges the premise; nothing saved.
- **Steps:** the brain told it is a hypothetical, with every record-writing tool withheld (`turn_notes.ts hypotheticalOf`,
  `HYPOTHETICAL_WITHHELD`) - EXISTS. No offer recorded.

### C8 "what do you actually know about my work experience so far? like everything you remember" (EXISTS)
- **Instinct:** every role with its source ("per your resume", "your November update") and the gaps (conflicting dates, the
  uncertain company name, changing figures).
- **Steps:** the brain with the confirmed record in its prompt and `get_profile`, each fact with its `provenance` - EXISTS; the
  corrections are in the conversation; length "everything" (900 to 1,200 characters).

### C9 "what's citadel like for new grad swe, culture pay interview process, give me real sources" (EXISTS)
- **Instinct:** four messages, each with its source: pay from the official posting, the process from Citadel's interview guide,
  culture from anonymous accounts labelled anecdotal, and the Citadel / Citadel Securities distinction from press.
- **Steps:** (1) the brain - EXISTS. (2) `research_market` (inline) with Claude's web search (D-060, `research_web.ts`): one
  search per turn, official sources first - EXISTS. (3) each source typed `official`, `anecdote`, `self_reported` or other
  (`sourceKind`; Citadel Securities is not Citadel's official source) and the reply rules (anecdotes labelled, the two employers
  kept apart) - EXISTS. (4) one topic per message with its link on its own line (`enforceMarketReply`, `layout: "messages"`) -
  EXISTS. Asserted in MP-1 with a stubbed search.
- **Artifact:** none. **Boundary:** none needed.

### C10 "can you make me a tailored resume for that paypal internship, like an actual file i can download. don't apply anywhere" (EXISTS)
- **Instinct:** a one-page PDF for the posting, GPA corrected, skills reordered, labelled a review draft with the unresolved
  details named; nothing submitted.
- **Steps:** (1) the posting the conversation listed handed to the brain (`turn_notes.ts postingNote`) - EXISTS.
  (2) `tailor_resume` (ON, `CAREER_TAILOR_REWRITE`) from confirmed facts, a PDF attached - EXISTS. (3) the email at the top of
  the resume - EXISTS since D-063 (was MISSING for this persona): Instinct used the linked account's email; Trainee takes only an email the person
  typed (`set_resume_contact` never uses the account email), so `tailor_resume` asks for it and makes no file. Either the
  persona types one, or the owner rules on the account email.
  **D-063 (architect ruling):** the email is the confirmed resume's or one the person typed, never the channel's or the account's;
  with none, the file that rides the chat is a review draft with a visible `[your email]` placeholder, the reply flags it, and the
  draft is not stored for any application (every apply path still refuses without an email). A slash-listed skill
  ("TypeScript/JavaScript") no longer fails the truth check on the person's own Skills line.
- **Artifact:** a PDF. **Boundary:** "Nothing was submitted".

### C11 "what would you need from me to actually submit that paypal application? don't apply yet just wanna know" (EXISTS)
- **Instinct:** the final resume's approval, the email and address to use, a careers-account sign-in; the questions behind
  sign-in admitted unknown; "I only inspected the entry flow: no account, saved application or submission was created".
- **Steps:** (1) the brain with the posting (`named_application_needs`) and `get_posting` - EXISTS. (2) the apply flow
  inspected read only - EXISTS since D-062 (1): `inspect_apply_flow` (`_shared/posting_requirements.ts readApplyFlow`) reads the
  posting and its form from public pages only: the requirements in the posting's words, every question the form shows without
  signing in (Greenhouse's posting API with `questions=true`, Lever's apply page, Ashby's read-only `ApiJobPosting` query),
  SmartRecruiters' questions named as not public, and on Workday (`_shared/workday_posting.ts`, the posting's CXS data: title,
  places, pay as stated, requirements, deadline when stated, open/closed) the questions named as behind the person's own sign-in
  on the employer's careers site (D-050), never guessed. Every request is returned with the result. (3) the boundary: the tool
  says to end with "no account, saved application or submission was created". Asserted in MP-1 (the harness's Greenhouse posting,
  network refused: the questions said to be not read) and on Workday from recorded public pages in
  `tests/architect/workday-posting-d062.test.ts`.
- **Boundary:** "no account, saved application or submission was created".

### C12 "could you realistically apply to like 50 internships for me in one night? ..." (EXISTS)
- **Instinct:** won't promise 50; what it would take; a small approved batch first; nothing applied.
- **Steps:** the brain; `queue_applications` withheld (`STAGED_WITHHELD_TOOLS`); nothing queued - EXISTS.

### C13 "draft a message to a recruiter asking if the comp range on a role is negotiable, keep it casual, don't send" (EXISTS)
- **Instinct:** a two-sentence casual draft, no name; not sent.
- **Steps:** `draft_followup` with no recipient (D-059), shown "Draft, not sent:" - EXISTS; length "under about 200 characters".

### C14 "actually that referral draft from earlier, make it way shorter and less formal" (EXISTS)
- **Instinct:** C2's draft, shorter, placeholders kept; not sent.
- **Steps:** the brain with C2's draft in its history; `draft_followup` (tone "shorter, less formal") - EXISTS.

### C15 "say i'm a new grad with zero internships and a mid gpa, how do i even get interviews" (EXISTS)
- **Steps:** the brain told it is a hypothetical PERSON: their saved facts left out, every record tool withheld - EXISTS.

### C16 "yea set up that application tracker" (EXISTS, D-062)
- **Instinct:** a Google Sheet: past applications, researched roles and the unsubmitted PayPal draft, kept up from Gmail; a
  correction of C6 ("Payroll Co" was "Golf Co").
- **Steps:** (1) the staged route (`applicationRecordAsk`). (2) `export_tracker`: the same record as a tracker File (kind
  `tracker` in `file_kinds.ts`, built by code only, never by `create_file`): applications with evidence and dates, researched
  roles, drafts, each with its status, and the coverage. (3) G9: what changed since the record was last shown (kept per person
  in `career_watch_kv`, erased with everything else) is named in the File and the reply. No Sheets export (a File page instead).
- **Artifact:** the tracker File. Asserted in D62-2 (with a stage corrected by a later email).
- **D-065:** live round 1 said "Your tracker page is made" with no link: the link rode only the channel's link messages (Telegram
  only). On a channel without its own link messages (WhatsApp, iMessage), the page's link now rides the answer (D-024,
  `channel_inbound.ts`).

### C17 "give me a 'tell me about yourself' answer i can reuse ..." (EXISTS)
- **Steps:** the brain (`prep_serve_mismatch`) with the confirmed record and `get_profile` - EXISTS.

### C18 "is that paypal internship posting still open? check rn" (EXISTS)
- **Instinct:** a live check on the official careers site, the closing date, the link; nothing submitted.
- **Steps:** (1) the posting the conversation listed (`postingNote`) - EXISTS. (2) `check_posting_open` (D-060,
  `research_web.ts recheckPosting`): the posting checked live on the boards Trainee reads; a check that cannot finish is
  "not known", and a host Trainee does not read is named, never guessed - EXISTS. Since D-062 the benchmark's Workday page is
  read: its CXS data by the posting's path (open, closed on HTTP 404/410 or Workday's errorCode S21/S22 or canApply false, and
  the application deadline when the posting states one; `workday_posting.ts`), asserted in `workday-posting-d062.test.ts`. (3) the link on
  its own line and "nothing was applied for" - EXISTS. (This PR first added a `recheck` to `get_posting`; D-060's tool does the
  same job, so the `get_posting` change was dropped at the merge.)

### C19 "find me 3 lakeshore alumni working at google or trading firms ... just research don't message anyone" (EXISTS, D-062)
- **Instinct:** three leads from public profile search excerpts, a caveat that current employment is unverified; nobody contacted.
- **Steps:** (1) the staged route (`career_staged.ts alumniSearchAsk`, `CAREER_PEOPLE_SEARCH` on). (2) `find_people`
  (`_shared/career_alumni_search.ts`): one web search call (at most 2 searches, cached 24 hours), LinkedIn, Indeed, Handshake
  and the never-list blocked in the search itself, no page fetched; a lead stands only when its name and employer are in its
  own page's quoted words; the school shown or not; one lead to start with and why; each "not verified; current employment
  needs confirming". (3) Code keeps the caveat and "Nobody was contacted." in the reply (`enforcePeopleReply`).
- **Boundary:** "Nobody was contacted." Asserted in MP-1 and D62-5.

### C20 "actually for that paypal resume, condense the pixelforge stuff to one line and expand the waypoint part more" (EXISTS)
- **Instinct:** a v2 PDF with both edits, honest wording about Waypoint, still a review draft.
- **Steps:** `tailor_resume` with edits - EXISTS since D-063 (was MISSING): it takes no edit instructions; `save_resume_persona` only orders or hides
  facts. (Also needs C10's PDF.)
  **D-063:** `tailor_resume` takes `edits` (`[{ role, lines }]`): an entry condensed to N detail lines, or expanded (and led) from
  its own confirmed details only; when the record holds fewer than asked it says so (`expand_short`) and nothing is written; the
  file is `_v2`, still a review draft with its open flags (`edits_done`, `review_draft`).

### C21 "ok behavioral round: ask me 'tell me about a time you failed' and then roast my answer" (EXISTS)
- **Steps:** the brain asks the question; nothing is scored - EXISTS.

### C22 "what's the going rate for swe interns in chicago, hourly" (EXISTS)
- **Instinct:** a practical range, PayPal's posted pay, three self-reported figures from levels.fyi, caveats; four links.
- **Steps:** (1) `get_posting` for the posting's own pay - EXISTS. (2) `research_market` with one web search (D-060) - EXISTS;
  self-reported sources typed `self_reported` and said to lag, a range called a benchmark, never a median - EXISTS.

### C21f "uhh probably when one of my first agency clients didn't like the site i made ..." (EXISTS)
- **Steps:** the brain told this is the answer to roast (`turn_notes.ts roastOf`), bluntly, on ownership and cost - EXISTS.

### C23 "that citadel process from earlier, how long was it again total?" (EXISTS)
- **Instinct:** "roughly eight weeks", the caveat, the same source link as C9.
- **Steps:** the brain calls `research_market` again; the earlier search answers from the cache (no new search) with the same
  source (D-060) - EXISTS. If the brain recalls it from the conversation instead, the link Trainee's own earlier reply showed is
  kept (`career_brain.ts shownBefore`, this PR); a link nobody showed is still removed.
