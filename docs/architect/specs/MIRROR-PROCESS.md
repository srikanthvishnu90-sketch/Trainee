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
`tests/architect/pending/mirror-process-blocked.test.ts` asserts its full process and fails until the capability lands. The
test reads the summary table below and fails if a row and the test disagree.

What the benchmark could see of Instinct's process is its replies (the tools behind them are inferred from what each reply
shows: a link, a File, a PDF, "nothing was submitted"). Where Instinct read something Trainee has no copy of here (the tester's
Gmail, the web), `prompts.jsonl` marks the turn's `needs`.

## Summary

| Turn | Status | Blocker (what is missing or off) |
|---|---|---|
| C1 | OFF | `CAREER_REPLY_WRITER`: the plan File (`plan_review`) comes only from `create_file`, offered only with the reply writer on Telegram |
| C2 | EXISTS | (D-059, this PR: no recipient named is drafted with placeholders) |
| C3 | EXISTS | |
| C4 | OFF | `CAREER_KNOWLEDGE` and the gateway's web search (`WEB_SEARCH_AVAILABLE = false`): no tool cites a source for advice |
| C5 | EXISTS | |
| C6 | MISSING | email-confirmation evidence in the record reply; researched roles separated from applications |
| C5f1 | EXISTS | |
| C5f2 | EXISTS | |
| C7 | EXISTS | |
| C8 | EXISTS | |
| C9 | MISSING | general web search (press, forums) with each source labelled official or anecdotal |
| C10 | MISSING | the resume's contact email: Instinct used the linked account's; Trainee takes only one the person typed |
| C11 | MISSING | a read-only reader of a posting's apply entry flow and questions |
| C12 | EXISTS | |
| C13 | EXISTS | (D-059) |
| C14 | EXISTS | (D-059) |
| C15 | EXISTS | |
| C16 | MISSING | a tracker artifact (no tracker File kind, no Sheets export) built from email confirmations |
| C17 | EXISTS | |
| C18 | EXISTS | (this PR: `get_posting` `recheck` reads the posting's own page now) |
| C19 | OFF | `CAREER_PEOPLE_SEARCH`, `CAREER_CONTACT_OUTREACH` (D-043 not accepted) |
| C20 | MISSING | edits to a tailored resume (condense one role, expand another) |
| C21 | EXISTS | |
| C22 | MISSING | self-reported intern pay (levels.fyi) through general web search |
| C21f | EXISTS | |
| C23 | EXISTS | (this PR: a link Trainee already showed may be given again); its source comes from C9, blocked |

16 EXISTS, 10 blocked (3 OFF, 7 MISSING). The deploy the owner asked to hold waits on the 10.

## Rules every turn keeps

- Nothing is sent, submitted, queued or saved as an application on any of the 26 turns (every ask says don't send, don't apply,
  or just explain). The test holds `career_apply_*`, `career_outbox`, `career_contact_sends` and `career_outreach_drafts` empty.
- The only requests that leave the machine are posting-page reads of the open check (D-051): the search's (C3) and the asked
  re-check (C18).
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
  (4) the plan File with the links and a weekly plan - **OFF**: the `plan_review` kind exists (`file_kinds.ts`), but `create_file`
  is offered only when `o.shape` (Telegram and `CAREER_REPLY_WRITER=on`, which is in `RELEASE_NEVER_ON`).
- **Artifact:** a plan File. **Boundary:** nothing applied.

### C2 "draft a cold message to a google swe asking for a referral, don't send anything" (EXISTS)
- **Instinct:** a draft from the confirmed profile (school, Waypoint, 70+ React sites) with `[Name]` and `[job link]` placeholders;
  no question about the recipient; not sent.
- **Steps:** (1) the brain - EXISTS. (2) `draft_followup` (kind `note`, recipient empty) - EXISTS; code checks the draft
  (no invented meeting, referral, figure or name; no guessed address) and shows it as "Draft, not sent:" (`followup_draft.ts`).
  Before this PR code refused a draft with no recipient and asked who it was for; **D-059** makes it draft with placeholders and
  ask for the recipient only at send time. A greeting or sign-off word ("Best, Sam") is no longer read as a name, and a
  short form of words the person typed ("CS" for "Computer Science") is theirs.
- **Artifact:** the draft. **Boundary:** "not sent" (code's label).

### C3 "find me 5 swe internships i could actually apply to right now, chicago or remote" (EXISTS)
- **Instinct:** answered with C1's reply and File: five named postings, live, the stretch labelled.
- **Steps:** (1) code's search (`career_internship_discovery`) - EXISTS. (2) each posting shown re-checked on its own page, at
  most the count asked (D-051, `link_check.ts searchCheck`) - EXISTS. (3) the results File (`role_results.ts`, needs
  `TRAINEE_FILE_BASE_URL`) - EXISTS. (4) an honest count when fewer than 5 are found - EXISTS.
- **Artifact:** the results File. **Boundary:** "Nothing was applied for" (code).

### C4 "what should i put at the very top of my resume for swe roles, be specific" (OFF)
- **Instinct:** name and contacts, then school, degree and graduation date, then a skills line; leave the outdated 3.9 off; one
  cited guide page.
- **Steps:** (1) the brain with the confirmed profile in its prompt (`memory.ts personBlock`) and `get_profile` - EXISTS.
  (2) the outdated GPA flagged from what the person said - EXISTS (the conversation; the GPA correction is in the window).
  (3) one cited source for the advice - **OFF**: `research_career_question` is offered only with `CAREER_KNOWLEDGE=on`
  (`RELEASE_NEVER_ON`) and the gateway's web search (`model_gateway.ts WEB_SEARCH_AVAILABLE = false`). `research_market` is
  market research and is not for this.
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

### C6 "have i applied to anything yet? trying to keep track" (MISSING)
- **Instinct:** evidence from Gmail confirmations across three accounts; separates confirmed applications from tonight's
  researched roles; says what could be missing; offers a running tracker.
- **Steps:** (1) the person's records (`tracking_status`, `list_applications`) - EXISTS. (2) email confirmations - **MISSING**
  in this reply: `CAREER_MAIL_TRACKING` (ON) reads one connected Gmail into the tracker, but the record reply does not read it,
  there is no multi-account read, and the benchmark persona has no Gmail. (3) researched roles (C3's list) separated from
  applications - **MISSING**: the reply says only that the tracker is empty. (4) the tracker offer - MISSING (see C16).
- **Artifact:** none. **Boundary:** "tonight's roles were research only".

### C7 "hypothetically if i had two offers, 120k in chicago vs 140k in nyc ..." (EXISTS)
- **Instinct:** net framing, a lean, challenges the premise; nothing saved.
- **Steps:** the brain told it is a hypothetical, with every record-writing tool withheld (`turn_notes.ts hypotheticalOf`,
  `HYPOTHETICAL_WITHHELD`) - EXISTS. No offer recorded.

### C8 "what do you actually know about my work experience so far? like everything you remember" (EXISTS)
- **Instinct:** every role with its source ("per your resume", "your November update") and the gaps (conflicting dates, the
  uncertain company name, changing figures).
- **Steps:** the brain with the confirmed record in its prompt and `get_profile`, each fact with its `provenance` - EXISTS; the
  corrections are in the conversation; length "everything" (900 to 1,200 characters).

### C9 "what's citadel like for new grad swe, culture pay interview process, give me real sources" (MISSING)
- **Instinct:** four messages, each with its source: pay from the official posting, the process from Citadel's interview guide,
  culture from anonymous accounts labelled anecdotal, and the Citadel / Citadel Securities distinction from press.
- **Steps:** (1) `research_market` (ON, `CAREER_RESEARCH_REPLY`) - EXISTS, with the free first-party sources
  (`research_free_sources.ts`: company sites, SEC, BLS, ATS boards, Wikipedia, news headlines). (2) forum and press pages -
  **MISSING**: the free sources do not search them; Brave runs only with the owner's `BRAVE_SEARCH_API_KEY`. (3) each source
  labelled official or anecdotal, and the two employers kept apart - **MISSING**. (4) one message per part - EXISTS
  (`CAREER_TEXTING_NATIVE`, channel splitting).

### C10 "can you make me a tailored resume for that paypal internship, like an actual file i can download. don't apply anywhere" (MISSING)
- **Instinct:** a one-page PDF for the posting, GPA corrected, skills reordered, labelled a review draft with the unresolved
  details named; nothing submitted.
- **Steps:** (1) the posting the conversation listed handed to the brain (`turn_notes.ts postingNote`) - EXISTS.
  (2) `tailor_resume` (ON, `CAREER_TAILOR_REWRITE`) from confirmed facts, a PDF attached - EXISTS. (3) the email at the top of
  the resume - **MISSING for this persona**: Instinct used the linked account's email; Trainee takes only an email the person
  typed (`set_resume_contact` never uses the account email), so `tailor_resume` asks for it and makes no file. Either the
  persona types one, or the owner rules on the account email.
- **Artifact:** a PDF. **Boundary:** "Nothing was submitted".

### C11 "what would you need from me to actually submit that paypal application? don't apply yet just wanna know" (MISSING)
- **Instinct:** the final resume's approval, the email and address to use, a careers-account sign-in; the questions behind
  sign-in admitted unknown; "I only inspected the entry flow: no account, saved application or submission was created".
- **Steps:** (1) the brain with the posting (`named_application_needs`) and `get_posting` - EXISTS. (2) the apply flow
  inspected read only - **MISSING**: a posting's questions are known only after a preparation run (`career_apply_questions.ts`);
  Workday is the person's own account (D-050).
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

### C16 "yea set up that application tracker" (MISSING)
- **Instinct:** a Google Sheet: past applications, researched roles and the unsubmitted PayPal draft, kept up from Gmail; a
  correction of C6 ("Payroll Co" was "Golf Co").
- **Steps:** (1) the records - EXISTS. (2) a tracker artifact - **MISSING**: no tracker File kind (`file_kinds.ts`), no Sheets
  export. (3) its rows from email confirmations - MISSING (see C6). (4) the self-correction - follows from (3).

### C17 "give me a 'tell me about yourself' answer i can reuse ..." (EXISTS)
- **Steps:** the brain (`prep_serve_mismatch`) with the confirmed record and `get_profile` - EXISTS.

### C18 "is that paypal internship posting still open? check rn" (EXISTS)
- **Instinct:** a live check on the official careers site, the closing date, the link; nothing submitted.
- **Steps:** (1) the posting the conversation listed (`postingNote`) - EXISTS. (2) `get_posting` with `recheck: true`: its own
  posting page read now (`link_check.ts`, the same check as every search), `open_check.state` live, closed or unknown -
  EXISTS (this PR; before, `get_posting` read only the stored row). (3) the link in the reply - EXISTS. A check that could not
  finish is never called open. (The benchmark's posting is on Workday, which the checker fetches as a plain page.)

### C19 "find me 3 lakeshore alumni working at google or trading firms ... just research don't message anyone" (OFF)
- **Instinct:** three leads from public profile search excerpts, a caveat that current employment is unverified; nobody contacted.
- **Steps:** public people search - **OFF**: `CAREER_PEOPLE_SEARCH` and `CAREER_CONTACT_OUTREACH` (`RELEASE_NEVER_ON`, D-043
  not accepted). Today code answers with a list plan (`outreach_clarification`) and finds no one.

### C20 "actually for that paypal resume, condense the pixelforge stuff to one line and expand the waypoint part more" (MISSING)
- **Instinct:** a v2 PDF with both edits, honest wording about Waypoint, still a review draft.
- **Steps:** `tailor_resume` with edits - **MISSING**: it takes no edit instructions; `save_resume_persona` only orders or hides
  facts. (Also needs C10's PDF.)

### C21 "ok behavioral round: ask me 'tell me about a time you failed' and then roast my answer" (EXISTS)
- **Steps:** the brain asks the question; nothing is scored - EXISTS.

### C22 "what's the going rate for swe interns in chicago, hourly" (MISSING)
- **Instinct:** a practical range, PayPal's posted pay, three self-reported figures from levels.fyi, caveats; four links.
- **Steps:** (1) `get_posting` pay - EXISTS. (2) `research_market` - EXISTS (BLS figures, not intern pay). (3) self-reported
  intern pay - **MISSING**: needs general web search (see C9).

### C21f "uhh probably when one of my first agency clients didn't like the site i made ..." (EXISTS)
- **Steps:** the brain told this is the answer to roast (`turn_notes.ts roastOf`), bluntly, on ownership and cost - EXISTS.

### C23 "that citadel process from earlier, how long was it again total?" (EXISTS)
- **Instinct:** "roughly eight weeks", the caveat, the same source link as C9.
- **Steps:** the brain with C9's reply in its history; length one or two sentences - EXISTS. The same link - EXISTS (this PR:
  a link Trainee's own earlier reply showed is not removed when recalled, `career_brain.ts shownBefore`; a link nobody showed
  still is). The source itself comes from C9, which is blocked.
