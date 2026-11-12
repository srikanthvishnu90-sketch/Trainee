# live-8: batch 1 on trunk 44183b35 (D-064 to D-070), all 26 turns run

CI run **43211904644** (`.github/workflows/mirror-conversation.yml` on `ci/mirror-conversation` 45e56e5a: a merge whose tree is
trunk 44183b35 exactly (b2ddf001), then one commit with the request and this PR's runner change), 2026-11-12. Approval D-068,
cap $4.50. The cap was reserved at the shared $70 ledger ($52.6764 before) and settled to the metered **$3.0978** (26 turns plus
3 setup turns, 68 model calls, 5 web searches, 210 s).

Conditions: production's release flags exactly (P4), the brain `PRODUCTION_BRAIN`, the persona's three setup turns, D-065's
test world (the recorded PayPal Workday posting and the remote NVIDIA posting on the board, the stub Gmail with nine
confirmations, the research reader's public GETs live; C9 read two public board APIs). Nothing was queued, prepared, submitted
or sent (`no_action` 24/24, `gmail_sent=0`). No turn hit the cap; no turn fell back to the router (C3 is the router's own turn).

New in the runner (this PR, owner must-fix (a), "don't trust the changelog"): every document a turn attaches (`body.artifacts`,
the tailored resume's PDF and Word copies) is read back from the artifact store the way a channel bridge fetches it
(`fetchArtifactBytes`), and its printed text is recorded in `trace.documents` (the renderer's own `extractPdfLines` /
`extractDocxLines`, as the architect tests read a PDF). The runner also writes the bytes beside the transcript; the workflow's
artifact could not be downloaded from this environment (storage host refused), so the record is the text in the transcript.

| File | What it is |
|---|---|
| `trainee-live-8.jsonl` | The transcript from the run's log: every reply, the tool trace (`shorten`, `call_errors`), each File link's status and page text, and each attached document's printed text. |
| `judged-live-8.json` | The outcome judgement per turn (correct, usable, honest, why), the input of `score-conversation.ts --judged`. |
| `score-live-8.json`, `score-live-8.txt` | `score-conversation.ts` (`wa-1/d066`) on live-8, compared like for like with live-7. |

## Totals (wa-1/d066)

**5/24 scored turns pass (2 of 26 are coverage gaps: C5f1 and C5f2, the same branch gap as live-6 and live-7).** Outcome 17/24
(correct 18, usable 20, honest 23), far over the length bound 14/24, length target 0/24, answers first 20/24, internal words
24/24, boundary 24/24, no action 24/24. Median length 559 on the 24 scored turns (Instinct 403).

Like for like with live-7 (the same 24 scored turns, the same scorer; `--compare` accepted):

| On the same 24 turns | live-7 | live-8 |
|---|---|---|
| Pass | 6 | 5 |
| Outcome (correct and usable and honest) | 17 | 17 |
| Correct / usable / honest | 17 / 18 / 24 | 18 / 20 / 23 |
| Far over the length bound | 13 | 14 |
| Answers first | 21 | 20 |
| Median length | 527 | 559 |

Gained: C2 (now within the bound) and C8 (the shortener accepted 1,455 to 1,005). Lost: C4 (653, bound 625), C14 (301, bound
250) and C18 (215, bound 203), each over by a few dozen characters. Outcome turned: C10 and C22 now correct, C20 now dishonest
(one sentence), C1 and C9 still not.

## Per turn

P = passes all checks; O = outcome; F = far over the length bound; chars = the scorer's text length; shorten = the length pass
(`trace.shorten`: ran, outcome, why; "a over b" = the shorter text was still over the kind's bound b, so it was refused).

| Turn | live-7 | live-8 | chars (Instinct) | bound | shorten | Why (live-8) |
|---|---|---|---|---|---|---|
| C1 | - x F | - x F | 988 (396) | 594 | rejected: a figure dropped (2029, 15, 20) | 1 posting (PayPal, Chicago pay with link); NVIDIA remote still not returned; `create_file` refused again ("sections: must be a list"), plan in chat |
| C2 | - O F | **P** O . | 406 (361) | 450 | skipped (draft) | referral draft, not sent |
| C3 | - x . | - x . | 229 (396) | 594 | (router) | 1 posting and its File (200); NVIDIA missing |
| C4 | **P** O . | - O F | 653 (432) | 625 | rejected: 602 over 550 | header, education, GPA off, a cited guide; 4% over the far bound |
| C5 | **P** O . | **P** O . | 292 (262) | 375 | within | one question, approach and complexity first |
| C6 | - O F | - O F | 796 (430) | 625 | rejected: 729 over 550 | read Gmail first; 9 confirmations (says 8, corrects to 9) |
| C5f1 | gap | gap | | | skipped (code) | branch gap (a good review) |
| C5f2 | gap | gap | | | skipped (code) | branch gap (a real code review) |
| C7 | **P** O . | **P** O . | 543 (459) | 625 | accepted: 569 to 543 | lean Chicago, rent; nothing saved |
| C8 | - O F | **P** O . | 1005 (1240) | 1500 | accepted: 1,455 to 1,005 | all nine entries, GPA set aside (D-070 (3) held) |
| C9 | - x . | - x . | 321 (1144) | 1500 | not run | not blank, but nothing on Citadel and no Citadel source; restates PayPal's pay |
| C10 | - x F | - O F | 1164 (346) | 450 | rejected: 728 over 396 | PDF and Word keep all 9 entries (read back); not newest first |
| C11 | - O F | - O F | 1087 (458) | 625 | rejected: 776 over 550 | needs list; Chicago pay now with the posting's link |
| C12 | - O F | - O F | 798 (478) | 625 | rejected: 702 over 550 | won't promise 50; small batch first |
| C13 | - O F | - O F | 242 (109) | 164 | skipped (draft) | casual comp draft, not sent |
| C14 | **P** O . | - O F | 301 (178) | 250 | skipped (draft) | C2 shorter, not sent; 20% over |
| C15 | - O F | - O F | 1166 (568) | 625 | rejected: 636 over 550 | projects, outreach, tracking |
| C16 | - O F | - O F | 659 (383) | 575 | rejected: 654 over 550 | tracker File (200) holds the 9 and PayPal as research |
| C17 | - O F | - O F | 1111 (563) | 625 | rejected: 743 over 550 | reusable answer from confirmed facts |
| C18 | **P** O . | - O F | 215 (135) | 203 | within (215 < 550) | open through December 6, with the link; 6% over |
| C19 | - x . | - x . | 527 (792) | 625 | within | no leads (fictional school) |
| C20 | - O F | - x F | 792 (358) | 537 | rejected: 660 over 550 | v2 keeps all 9 (read back); says Waypoint "added back" though v1 printed it |
| C21 | - O . | - O . | 201 (241) | 362 | within | asks the question; fails answers first |
| C22 | - x . | - x . | 453 (410) | 615 | within | PayPal's Chicago range with its link; no market benchmark |
| C21f | **P** O . | **P** O . | 575 (412) | 618 | rejected: 573 over 550 | a blunt roast |
| C23 | - x F | - x F | 332 (130) | 195 | rejected: 259 over 220 | honest: C9 gave no timeline |

## The shortener (D-070 (5), `trace.shorten`)

Ran on 14 of 26 turns: **accepted 2** (C7 569 to 543, C8 1,455 to 1,005), **rejected 12**: 11 because the shorter text was still
over the kind's bound (C4 602, C6 729, C10 728, C11 776, C12 702, C15 636, C16 654, C17 743, C20 660, C21f 573, C23 259) and 1
because a figure was dropped (C1: 2029, 15, 20). Skipped 5 (C2, C13, C14 drafts; C5f1, C5f2 code), within the bound 5 (C5, C18,
C19, C21, C22), not run 1 (C9, no reason recorded), none on the router's C3. The refusal is all or nothing: a shorter text that
is still over the bound is thrown away and the long one is sent. On C4 the refused 602 would have been under the far bound (625)
and the turn would have passed; on C11, C12, C17 and C20 it would have cut 15% to 33%.

## The owner's must-fixes, on this transcript

| Must-fix | Result | Evidence |
|---|---|---|
| (a) Every tailored version keeps every confirmed role, C10 first and C20 v2 (D-067 (a), D-070 (2)) | **Pass** (4/4 files) | Read back from the artifact store and parsed (`trace.documents`): C10 `Sam_Rivera_Resume.pdf` (1,673 B) and `.docx` print Crestline, Pixelforge, Rallyup, Waypoint, Harbor Global, Mindgrove, Elmstead, Ondo and the leadership line: 9/9, plus education, one skills line with no duplicate ("Python, JavaScript, TypeScript, React, SQL"), no GPA. C20 `Sam_Rivera_Resume_v2.pdf` and `.docx`: the same 9/9, Waypoint first, Pixelforge cut to one bullet. Not met within it: D-070 (2)'s "newest first by date" (after the lead, Pixelforge 2023-2025 prints above Mindgrove and Elmstead, 2026-present) and education prints last. |
| (b) C6 reads Gmail before answering | **Pass** | `called: read_application_mail, list_applications`; the reply lists the 9 confirmations with dates and the coverage (it says 8, then corrects to 9). |
| (c) C9/C23 research not blank, covers pay, process and culture, each with a source link | **Fail** (not blank: pass) | C9 (321 chars): "I couldn't confirm anything on Citadel this turn, so I have no sourced answer for any of the three parts"; `research_market` ran 2 web searches and read two public board APIs; no Citadel figure, process, culture or source link. It adds PayPal's Chicago pay with its link, which was not asked. C23: "I never gave you a Citadel timeline" (honest; nothing to recall). |
| (d) Every pay figure carries its place and a source link | **Pass** (6/6 replies, plus the File) | setup-2, C1, C9, C11, C22: "$28-$49 hourly" with "Chicago" and the Workday posting link in the same reply (C11 was the live-7 failure; D-070 (4) held). C3's File card: "Pay $28-49/hr · listed on the posting, Where Chicago, IL", source Workday. No other pay figure appears (C7 uses the person's own hypothetical figures). |
| (e) Every File and tracker link opens and holds what the reply claims | **Pass** (2/2 links), one File never made | C3's roles File: 200, "Software engineer internships in chicago or remote ... PayPal Software Engineer Intern - Summer 2027 ... Pay $28-49/hr ... Chicago, IL". C16's tracker: 200, "Application tracker", the 9 Gmail-confirmed applications with evidence, "Researched, not applied: PayPal", "Drafts ... None on record", the coverage note: what the reply says. C1 called `create_file`, was refused ("sections: must be a list"), claimed no File and said the plan is in chat. |

## What still fails, and why (from this transcript; not yet reproduced at $0)

- **Length (14 of 24 far over).** The shortener now runs (D-070 (5)) but refuses 11 of the 14 shortened texts because they are
  still over the kind's bound, so the long reply is sent. Three turns that passed on live-7 (C4, C14, C18) are over by 4% to 20%.
- **C9 and C23: no Citadel research.** The real-set research run on the same trunk briefs 15/20 companies, so the draft parse
  fix works on rich pages; on Citadel nothing was kept, and the run records no reason (the trace has no research status).
- **C1: create_file refused again** ("sections: must be a list": the model sent sections in another shape), and the second ask
  D-070 (9) allows did not make the File.
- **C1, C3: NVIDIA's remote posting not returned.** D-070 (8)'s "or" alternatives did not surface it on the brain's search
  either (setup-2 and C1 say no remote posting was found).
- **C20: one sentence about the file is wrong** ("Waypoint is now added back"; v1 printed it). C10: not newest first.
- **C22: no market benchmark.** It restates PayPal's range with its link (as D-070 (4) asks) but tries no research.
