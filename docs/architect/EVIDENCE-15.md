# Evidence for the 15 release items: before-and-after exchanges

Companion to `docs/architect/VERIFICATION-15.md`. For each item: the ledger status today, what the measured bar is and what
the PRs move it to, one or two exchanges, and why the score rises.

**These are test transcripts and production-before quotes, not live conversations after a fix.** Every "After" below
comes from a test fixture or assertion, or from a PR body that quotes what the test printed. Every "Before" is either
production before the fix (quoted in `docs/architect/specs/APP-LAYER-15-FIXES.md` A.2, A.5 or F) or what the same test
saw on trunk. Nothing here is a reply written for this document. Where no real "after" text exists, the item says so.
None of this is live proof (C): per the ledger, a status reaches Verified only with a production record after the deploy.
Merging the open PRs adds A and B evidence at most, so the best an item reaches on merge is **Partial**.

Labels: `path:line @ branch` is a test fixture or assertion; `#n` is a PR body; `spec A.2` etc. is production before the fix.
Merged to trunk: #668 #670 #671 #672 #673 #676 #680 #683 #685 #688 #696 #701. All other PRs named here are open.

---

## 1. Application layer (#674 #693 #698 #719)
Status: Partial. Bars, trunk to PR head: role named on the card 0/5 to 10/10; hash prefix on the resume line 5/5 to 0/10;
open questions on the card 0/3 to 3/3 (#674); sensitive questions 56/90 to 90/90 (#693). On merge: still Partial (no C).
- Person: `apply to 3` (after a list of 5) (#698 demo)
  - Before: `[career_list_reference] To apply to Data Analyst Intern at TEST Queue D, I need your resume first …`, 0 rows queued, though a confirmed resume was on file.
  - After: `[career_apply_queue] 1/1 queued … Data Analyst Intern at TEST Queue D`, and `career_apply_wanted` holds exactly that posting.
- The review card's resume line (no person turn; the card shown before the yes)
  - Before: `Resume: banking, tailored for this role (bbbbbbbbbbbb)` (`tests/architect/wo-028-tailor.test.ts:241 @ trunk`)
  - After: `Resume: banking, tailored for this role` (`tests/architect/wo-028-tailor.test.ts:243 @ agent2/app-layer`, #674); the 64-hex hash stays in the payload.
Why it rises: the card now shows what the yes approves in plain words (role 10/10, open questions 3/3) and a date of
birth is no longer carried to the next employer (filled from another application 1 to 0, #674).

## 2. Sixty applications in one batch (#679 #691)
Status: Not verified. Bars (#679, CI run 42736627702): fixture of 60 gives 60 outcomes, 0 duplicates, 0 dropped, 0 fields
off the approved payload, 60 receipts and 1 closeout. Real 60 in dry run: 48 of 60 `site_not_supported`. On merge: Partial at most.
- No chat exchange exists in these PRs or their tests. The real "before and after" is the runner's outcome mix:
  - Before (#679, real 60 through the VM): `48 site_not_supported, 5 needs_answers, 4 needs_user:field_not_filled: Country, 1 no_application_form_found, 2 dry_run_stopped_before_submit`.
  - After (#691): the VM drives Personio and Breezy too; its re-run (run 42737585019) had not reported when #691 was opened, so no after number exists yet.
Why it rises: the batch accounting bar (one outcome each, 0 duplicates, 0 dropped) is met on the fixture; the real-postings
bar still waits on item 4.

## 3. Resumes (#670 #673 #708)
Status: Partial. Bars: files opened 105/126 to 162/162 (#670); confirmed listed skills shown 156/594 to 594/594 (#673);
design checks (identity 135, chronology 150, ATS order 108, DOCX = PDF 108) to 162/162 each (#708). On merge: Partial.
- Person: "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF." (spec A.2, turn 2)
  - Before (production): "Your resume is tailored for Ads Conversion Modeling, Machine Learning Engineering Manager at reddit. … Saved as PDF and DOCX files, attached for your review — parse check PASS."
  - After: no real after text for this exact ask exists in the repo.
- The p09 UX Designer resume (resume loop fixture, #673): Before: the Skills section was gone. After: it prints `Figma, Prototyping, Usability Testing, Illustrator`.
Why it rises: every delivered PDF and DOCX now opens and matches confirmed facts with 0 invented (162/162), the bar item 3 names.

## 4. Browser capability (#668 #683 #707 #713 #715 #716 #717)
Status: Not verified (15/220). Strict benchmark on #668's runner (run 42737077013): 37/220 tuned sample, 39/220 held-out;
re-scored under the stricter false-pass rule 33/220 (run 42737427568, #707). Per-board PRs: Recruitee 0 to 3/20 (#707),
Lever 3 to 4/20 (#715), Ashby 1 to 2/20 (#717), Workable and Breezy passes unchanged (#716). No combined run of all of them.
- No chat exchange exists: this is the browser runner, measured on job sites, not on replies. The real before and after are the runner's verdicts:
  - Before (#707, Teamtailor): the runner took the page's Connect sign-in form for the application and marked **Log in** as the Submit control; all 4 Teamtailor "passes" in run 6 were this.
  - After (#707): a run that filled nothing is reported as `no_application_form_found`; Teamtailor 0 honest passes, 1 `ready_except_upload`.
  - Before (#668): every Lever posting stopped on an invisible hCaptcha counted as a shown check. After: it is skipped; a visible check still stops and goes to the person.
Why it rises: the pass count is honest and higher (15 to 33 under the strict rule, 0 breaches), and the held-out 39/220 shows it is not overfit.

## 5. Networking and email (#695 #722)
Status: Not verified. Bars: loop 05, baseline (both flags on) 6 invented mails sent, 8/9 exact sends; PR 0 invented,
0 guessed, 11/11 exact sends (#695), then 12/12 over 27 journeys (#722); drafts for unknown recipients 0/34 to 34/34 (#722).
- Person: `draft a note to Elena at Northline Health Data about the software engineering intern role` (#722 demo)
  - Before (#706, #722): "You haven't sent me any contacts yet", and no draft.
  - After (#722): "Here's a draft to Elena at Northline Health Data. Recipient not set: I don't have Elena's address and I won't guess one, so nothing is saved or sent. Fill in the [brackets] before it goes anywhere. … What are Elena's full name and work email? Reply like "email Elena <last name> at <their work email>" and I'll read it back to you before anything is written to them."
- Person: `email Maya Chen at maya.chen@acme-s1.example about the analyst role` (#695, journey J21)
  - Before (#695 baseline, both flags on): drafts saying "It was great meeting you at the … meetup" or "As your former colleague" passed every check and reached Gmail.
  - After (#695): "Before I write anything, check this is right: Maya Chen · maya.chen@acme-s1.example (about the analyst role). Say yes and I'll save them as your contact and draft the email for you to approve; nothing is sent until you approve that exact email."
Why it rises: invented ties 6 to 0 and exact sends 100% move the "nothing invented, only the approved exact message" bar.

## 6. File design and capability (#671 #676 #678 #680 #686 #689 #696 #697 #700)
Status: Not verified. Bars: dead controls 0 (#671); served family pages: unserved 99 to 0 (#676, 101 controls pressed,
24 shown off with a reason); F-09 approve bound to the shown hash (#696); chat card rules 31741/31741 held (#686). On merge: Partial.
- No full exchange exists in these PRs. The real before and after are the parts of the message:
  - Before (#686 baseline): "File turns send the link alone", so 0 of the C.2 card rules are met.
  - After (#686): a card with the counts line `Updated 9:40 AM - 14 ready to prepare - 2 need answers - 1 closed` and the caption `Opens your private File - nothing is submitted from chat`.
  - A decision on a File opens the chat with the question filled in, for example `About my Career brief, "Earliest start date": Answer.` (#676).
Why it rises: the link-and-action crawler now finds 0 dead and 0 unserved controls on served pages, the bar item 6 names.

## 7. Bot responses (#672 #687 #706)
Status: Partial. Bars: sweep violations 63 in 98 replies to 0 in 99 (#672); bubbles empty, repeated or hollow 0/1/3 to 0/0/0
(#687); battery of 1,000 asks, staged rubric violations 123 to 6, Never hits 3 to 0 (#706). On merge: Partial.
- Person: "Stop the people list. … Don't contact anyone or start any new work. … Leave everything unsent." (spec F.3)
  - Before (production): "Stopped everything I can reach: the global pause is now set for your account …" (the account record showed no pause).
  - After (#706, the ruled wording when the state cannot be read): "I have not paused your account. I couldn't check what has already gone out or what is waiting, so that is unverified. Next step: …"
- A turn that runs past 2 minutes (#687 demo)
  - Before: no quoted text; on trunk the loop counted 1 repeated and 3 hollow bubbles.
  - After: "I couldn't finish this in time: it ran past 2 minutes, so I stopped waiting, and I can't confirm how far it got. Send it again and I'll retry."
Why it rises: the rubric sweep now runs (0 violations in 99 templated replies) and every failure after an interim names what stopped.

## 8. Job discovery (#719, spec F.1)
Status: Partial. Bar: widening after a non-search turn widens the last search (#719, scripts 41 to 56 added to the
ask-to-queue loop). On merge: Partial; the F.1 live replay is still owed.
- Person: "Find me data analyst internships in Chicago." / "tell me more about the second one" / "include remote US internships too" (#719, script 41)
  - Before: `I checked include too internships in Chicago …`, nothing listed, and the next "apply to 2 and 4" found no list.
  - After: 7 listed (Chicago plus remote US). No exact reply text is quoted for this case.
- A widening that finds nothing new
  - Before (spec A.2 turn 4, production): "Nothing was invented to fill the list. Widen the role or the place and I'll search again."
  - After: "Widening to include business analyst found nothing new: no other open role matched, so the 2 I listed before stand, under the same numbers." (`tests/architect/ask-to-queue-20261110.test.ts:162 @ ag/a-widen-after-turn`)
Why it rises: the widened scope and an honest "nothing new" keep the shown list, moving "an honest count, a scope when empty".

## 9. Profile and memory (#720)
Status: Partial. Bar (#720): a fact corrected in chat changes all 7 places it is used. On merge: Partial.
- Person: "actually I graduate May 2027, not 2026" (#720 end-to-end test)
  - Before (#720 finding): the answer library kept "May 2026", and both prepare-ahead and the cloud card handed it to later forms.
  - After (#720): the old answer is reopened with the reason "you corrected this on <date>" and the person is asked again; it is never rewritten. No reply text is quoted.
- Related (#706): before, a stated graduation correction got "I haven't changed your graduation date, which is May 2027"; it is now saved. No after text is quoted.
Why it rises: "a live correction that is kept" now holds in every reader of the fact, not only the profile.

## 10. Company and role research (#701)
Status: Partial. Bar (loop 10, 15 asks): briefs passing 0/15 to 15/15; unsourced claims 14 to 0; invented 12 to 0. On merge (merged): Partial.
- Person: "What's Stripe like to work for as a data analyst intern? … Don't apply or contact anyone." (spec F.2)
  - Before (production): "on it — looking for roles now" then the batch reply "I haven't started that batch … runner …"
  - After: no real reply text is quoted in #701 (the loop prints replies only with `LOOP10_SHOW=1`). The fix routed asks like "…and 5 good questions to ask" to `research_company` (6 of 15 asks had never reached research).
Why it rises: the sourced-and-nothing-invented bar is met on 15/15 loop asks.

## 11. Interview preparation (#685)
Status: Not verified. Bar (loop 11): journeys 0/12 to 12/12; questions tied to the posting 42.9% to 100%; invented 0. On merge (merged): Partial.
- Person: `prep me for my upcoming interview` (#685, journey 3)
  - Before: no quoted text; the mock was not bound to the interview on file (0/12 journeys).
  - After: "Mock interview: Product Analyst at Initech, built from the posting on your applications. … This is practice for your Initech interview for Product Analyst: the invite says "Sunday, November 15 at 11am CT", phone. A suggestion, not booked anywhere: …"
Why it rises: practice is now tied to a real scheduled interview and its posting, 72/72 questions.

## 12. Tracking and follow-through (#702)
Status: Not verified. Bar (loop 12): wrong statuses 6 to 0; replies without exactly one `Next:` line 10 to 0. On merge: Partial.
- Person: `did my application to Globex go through?` (Globex has sent an interview invitation)
  - Before: the reply says "Globex has not confirmed it yet" (`tests/architect/flow-standing.test.ts:58 @ trunk`).
  - After: the reply says "Globex invited you to interview" (`tests/architect/flow-standing.test.ts:59 @ ag/k-tracking`, #702).
- Person: "where are my applications?" (#702 demo, after only)
  - After: "- Birch Labs (Data Analyst): submitted; Birch Labs turned it down (their email, Nov 8). … Next: answer Cobalt Systems's email to set up your interview."
Why it rises: statuses now read the employer's latest answer (wrong 6 to 0) and end on one next action.

## 13. Offers and negotiation (#709)
Status: Not verified. Bar (loop 13, 20 hand-computed cases): 0/20 to 20/20 fully correct. On merge: Partial.
- No chat exchange is quoted in #709. The real before is a parse bug: "a 4% 401k match on a $90,000 salary" was read as a
  $401,000 base, and a "$15k target bonus" was counted as guaranteed cash. No after reply text exists in the PR body.
Why it rises: comparison math is exact on 20/20 and every value carries its source.

## 14. Accounts and channels (#682 #684 #688)
Status: Not verified. Bars: Telegram loop of 30 conversations (#688); channel parity 18/20 to 19/20, secrets 0 (#684);
accounts loop leaks, unrefused and dead links measured (#682). On merge: Partial; a live round trip is still owed.
- Person: `hello, I need a job` (first message on Telegram)
  - Before (#688): searched as the role "hello": "I checked hello in any location … none was found".
  - After: no exact text is quoted; the test asserts the first answer names Trainee or asks for the resume (`tests/architect/telegram-loop-30.test.ts:202-204 @ trunk`).
- Person sends an iMessage that is only a file
  - Before (#684): no reply at all.
  - After (#684): "I haven't read that file because I can't open files sent here yet. Paste your resume as text in this chat and I'll read it now." (`FILE_NOT_READ_REPLY`, `supabase/functions/_shared/channel_inbound.ts:78`)
Why it rises: both channels that are on at release answer the same 19 of 20 scripts the same way, with 0 secrets.

## 15. Release readiness (#704 #711 #712)
Status: Not verified. These PRs add release checks, not replies: two untested rollbacks exercised (#704), the gmail-oauth
wrapper driven end to end in CI (#711), and a delivery bug fixed (#712). On merge: still Not verified until the Production gate.
- No chat exchange exists. The real before and after is a delivery record (#712):
  - Before: a digest partly sent on Telegram and then claimed for iMessage left words 0 to 79 on Telegram and 40 to 118 on iMessage, and the row was marked delivered.
  - After: the row goes whole to the new chat; the new test fails on trunk and passes with the migration.
Why it rises: fewer untested release paths, but the item stays unchecked until the release is cut and passes every gate.
