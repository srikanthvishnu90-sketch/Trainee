# live-7: batch 1 on trunk 44b436f9 (D-064 to D-069), all 26 turns run

CI run **43192119443** (`.github/workflows/mirror-conversation.yml` on `ci/mirror-conversation` fdfc2ceb, a merge whose product
code is trunk 44b436f9 exactly; the tree adds the request, this PR's runner change and the workflow's $5 request cap), 2026-11-12.
Approval D-068, cap $4.50 (live-6 ran about $0.13 a turn). The cap was reserved at the shared $70 ledger ($41.8718 before) and
settled to the metered **$3.3528** (26 turns plus 3 setup turns, 65 model calls, 5 web searches, 228 s).

Conditions: production's release flags exactly (P4), the brain `PRODUCTION_BRAIN`, the persona's three setup turns, D-065's
test world (`world.ts`: the recorded PayPal Workday posting and the remote NVIDIA posting on the board, the stub Gmail with nine
confirmations, the research reader's public GETs live). Two board listing reads were refused and recorded (C9). Nothing was
queued, prepared, submitted or sent (`no_action` 24/24, `gmail_sent=0`). No turn hit the cap; no turn fell back to the router.

New in the runner (this PR): every File link a turn returns is followed right after the turn through the real File server
(`trainee-file/handler.ts handleFile` with `deps.ts buildFileDeps` over the world's database), in the person's signed-in phone
session, and the status and page text are recorded in `trace.files`.

| File | What it is |
|---|---|
| `trainee-live-7.jsonl` | The transcript from the run's log: every reply, the tool trace, and each File link's status and page text. |
| `judged-live-7.json` | The outcome judgement per turn (correct, usable, honest, why), the input of `score-conversation.ts --judged`. |
| `score-live-7.json`, `score-live-7.txt` | `score-conversation.ts` (`wa-1/d066`) on live-7. |
| `score-live-6-rescored-d066.json` | live-6 re-scored with the same scorer and its own judgements, for the like-for-like comparison. |

## Totals (wa-1/d066)

**6/24 scored turns pass (2 of 26 are coverage gaps: C5f1 and C5f2, because Trainee's C5 asked "the first value that appears
more than once", not Instinct's "first unique", so the scripted answers belong to another branch).** Outcome 17/24 (correct 17,
usable 18, honest 24), far over the length bound 13/24, length target (±10% of Instinct) 1/24, answers first 21/24, internal
words clean 24/24, boundary 24/24, no action 24/24. Median length 527 on the 24 scored turns (Instinct 403).

Like for like with live-6 (the 22 turns both runs scored; live-6 did not run C21f and C23, and had the same two branch gaps):

| On the same 22 turns | live-6 | live-7 |
|---|---|---|
| Pass | 1 | 5 |
| Outcome (correct and usable and honest) | 15 | 16 |
| Far over the length bound | 13 | 12 |
| Answers first | 16 | 19 |
| Median length | 599 | 565 |

live-6 was judged with one `ok` per turn (it counts for correct, usable and honest); live-7 is judged on the three separately.
live-7's C10 is judged stricter than live-6's (below).

## Per turn

P = passes all checks; O = outcome; F = far over the length bound; chars = the scorer's text length; bound = the far-over bound.

| Turn | live-6 | live-7 | chars (Instinct) | bound | Why (live-7) |
|---|---|---|---|---|---|
| C1 | - x F | - x F | 790 (396) | 594 | 1 posting (PayPal; the remote NVIDIA posting not returned); `create_file` ran but no File link reached the person |
| C2 | - O . | - O F | 478 (361) | 450 | referral draft, not sent; 6% over the bound |
| C3 | - x . | - x . | 229 (396) | 594 | 1 posting and its File (opens, 200); NVIDIA missing |
| C4 | - O F | **P** O . | 515 (432) | 625 | header, education, Pixelforge, GPA off, a cited guide |
| C5 | P O . | **P** O . | 238 (262) | 375 | one question, approach and complexity first |
| C6 | - x . | - O F | 774 (430) | 625 | read Gmail: 9 confirmations (says 8, then corrects itself to 9) |
| C5f1 | gap | gap | | | branch gap (a good review of the answer) |
| C5f2 | gap | gap | | | branch gap (a real code review; D-067 (2) held) |
| C7 | - O F | **P** O . | 536 (459) | 625 | after-tax, rent, commute; nothing saved |
| C8 | - O F | - O F | 1568 (1240) | 1500 | all nine entries in the person's words, the gaps; 5% over |
| C9 | - x . | - x . | 218 (1144) | 1500 | not blank, but nothing on culture, pay or process and no source |
| C10 | - O F | - x F | 1255 (346) | 450 | PDF and Word, but 7 of 9 confirmed entries dropped and a duplicated skills line |
| C11 | - O F | - O F | 1059 (458) | 625 | what it needs; Chicago pay without the posting's link |
| C12 | - O F | - O F | 768 (478) | 625 | won't promise 50; a small batch first |
| C13 | - O F | - O F | 181 (109) | 164 | casual comp draft, not sent |
| C14 | - O . | **P** O . | 238 (178) | 250 | C2 shorter and casual |
| C15 | - O F | - O F | 1132 (568) | 625 | projects, outreach, tracking |
| C16 | - O F | - O F | 714 (383) | 575 | tracker File opens and holds the 9 applications and PayPal as research |
| C17 | - O F | - O F | 1063 (563) | 625 | reusable answer from confirmed facts |
| C18 | - O F | **P** O . | 203 (135) | 203 | checked Workday: open through December 6, with the link |
| C19 | - x . | - x . | 594 (792) | 625 | no leads (the persona's school is fictional; judged as live-6 was) |
| C20 | - x F | - O F | 1025 (358) | 537 | v2: Pixelforge one line, every dropped entry back; Waypoint one line (one detail on record) |
| C21 | - O . | - O . | 212 (241) | 362 | asks the question; fails answers first |
| C22 | - x . | - x . | 488 (410) | 615 | no going rate; PayPal's Chicago range not restated |
| C21f | not run | **P** O . | 517 (412) | 618 | a blunt roast with the concrete questions |
| C23 | not run | - x F | 339 (130) | 195 | honest that C9 gave no timeline; nothing to give |

## The owner's must-fixes, on this transcript

| Must-fix | Result | Evidence |
|---|---|---|
| C20 v2 keeps every confirmed role (D-067 (a)) | **Pass on the reply; the PDF is not inspected** | The changelog: "Pixelforge is now one line", "Waypoint now leads", "Rallyup, Harbor Global, Mindgrove, Elmstead, Ondo and your leadership line are back on this version" (Crestline led v1 and is not named as removed). The PDF and Word copies are attachments, not File links, so the runner did not open them. C10 (the first tailored version, not an edit) did drop 7 of the 9 entries. |
| C6 reads Gmail before answering (D-067 (9), (b)) | **Pass** | `read_application_mail` called; the reply lists the 9 confirmations with dates and the coverage. It first says "8" and corrects to 9 in the same reply. |
| C9 not blank and covers pay, process and culture with sources (D-067 (1), (c)) | **Fail** (not blank: pass) | 218 characters: "I couldn't confirm anything about Citadel's culture ... I have no verified pay figure ... I found no verified description of it." `research_market` ran with 2 web searches; no source link, no figure. C23 then has nothing to repeat. |
| Every pay figure carries its place and a source link (D-067 (6), (d)) | **Fail** (1 of 3 places) | C1 "in Chicago, $28-$49 hourly" with the Workday link: pass. The C3 File: "Pay $28-49/hr · listed on the posting, Where Chicago, IL" on the posting's card: pass. C11 "For Chicago the pay is $28-$49 hourly": place, no link. |
| Every File and tracker link opens and holds what the reply claims (D-067 (e)) | **Pass** (2 of 2) | C3's roles File: 200, "Software engineer internships in Chicago or remote ... PayPal Software Engineer Intern - Summer 2027 ... Chicago, IL". C16's tracker: 200, "Application tracker", the 9 Gmail-confirmed applications with their evidence, "Researched, not applied: PayPal", "Drafts: None on record", the coverage note: what the reply says. C1 called `create_file` and returned no link (and did not claim one). |

## What still fails, and why (from this transcript; not yet reproduced at $0)

- **Length (13 of 24 far over).** The answer turns without a write (C11, C12, C15, C17) run 1.2 to 2 times their bound, and every
  write turn (C10, C16, C20) carries a long changelog. D-067 (8) made the pass run on read-only turns; the trace does not record
  whether it ran or was rejected.
- **C9 and C23: research returns nothing on Citadel.** The same shape as the real-set research run (9 of 20 companies "no
  brief" from pages that hold quotable text, item 10).
- **C10: the first tailored version drops 7 of 9 confirmed entries**, prints "TypeScript/JavaScript" twice in the skills line,
  and cannot say whether the outdated 3.9 GPA prints. The setup turn that said "the 3.9 gpa on there is outdated, don't reuse
  it" was answered as an internship search and the GPA stayed confirmed (C1 and C8 say so).
- **C11: pay without its source link.** `payWithSource` did not add the posting's link on this turn.
- **C22: the shown pay was not reused.** D-067 (10)'s turn note did not lead to the PayPal range with its link.
- **C1: one posting.** The search again returned PayPal only, not the remote NVIDIA posting in the world; `create_file` ran but
  no File reached the person.
