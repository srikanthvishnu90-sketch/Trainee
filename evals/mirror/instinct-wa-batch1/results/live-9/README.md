# live-9: batch 1 on trunk 671ba1b7 (D-071), all 26 turns run

CI run **43272797730** (`.github/workflows/mirror-conversation.yml` on `ci/mirror-conversation` f53b8ecc: a merge whose tree is
trunk 671ba1b7 exactly (d482475a), then one commit with the request only), 2026-11-12. Approval D-068 (the owner's effort budget,
with the owner's 2026-11-12 approval of $10 more), cap $4.00. The cap was reserved at the shared $70 ledger ($61.7347 recorded
then, the item 10 run's reservation included) and settled to the metered **$3.2764** (26 turns plus 3 setup turns, 76 model
calls, 7 web searches, 241 s).

Conditions: production's release flags exactly (P4), the brain `PRODUCTION_BRAIN`, the persona's three setup turns, D-065's
test world (the recorded PayPal Workday posting and the remote NVIDIA posting on the board, the stub Gmail with nine
confirmations, the research reader's public GETs live). Nothing was queued, prepared, submitted or sent (`no_action` 23/23,
`gmail_sent=0`). No turn hit the cap. One turn did not reach the model: on C8 the model API answered **503** ("upstream connect
error or disconnect/reset before headers", in the run log), and the product's no-model reply stood, so C8 is a coverage gap
(`fallback`), not a fail. The runner is unchanged from trunk (it already reads each attached document back, `trace.documents`).

| File | What it is |
|---|---|
| `trainee-live-9.jsonl` | The transcript from the run's log: every reply, the tool trace (`shorten`, `research`, `args`, `call_errors`), each File link's status and page text, and each attached document's printed text. |
| `judged-live-9.json` | The outcome judgement per turn (correct, usable, honest, why), the input of `score-conversation.ts --judged`. |
| `score-live-9.json`, `score-live-9.txt` | `score-conversation.ts` (`wa-1/d066`) on live-9. |

## Totals (wa-1/d066)

**4/23 scored turns pass (3 of 26 are coverage gaps: C5f1 and C5f2, the branch gap of live-6 to live-8, and C8, the 503).**
Outcome 17/23 (correct 17, usable 18, honest 23), far over the length bound 12/23, length target 0/23, answers first 20/23,
internal words 23/23, boundary 23/23, no action 23/23. Median length 513 on the 23 scored turns (Instinct 396).

`--compare` with live-8 refuses ("different coverage": live-8 scored C8, live-9 could not). Like for like on the 23 turns both
runs scored, from the two score files (same scorer):

| On the same 23 turns | live-8 | live-9 |
|---|---|---|
| Pass | 4 | 4 |
| Outcome (correct and usable and honest) | 16 | 17 |
| Correct / usable / honest | 17 / 19 / 22 | 17 / 18 / 23 |
| Far over the length bound | 14 | 12 |
| Answers first | 19 | 20 |
| Median length | 543 | 513 |

Gained: C13 (164, at its bound; was 242). Lost: C7 (660, bound 625: the shortener's two passes kept 660 of 687; live-8
accepted 543). Outcome turned: C20 now honest (D-071 (6): what it says changed matches v1 against v2). No longer far over:
C1 (566, was 988), C16 (523, was 659). Still far over: C4, C6, C10, C11, C12, C14, C15, C17, C18, C20, C23 (and C7 newly).

## Per turn

P = passes all checks; O = outcome; F = far over the length bound; chars = the scorer's text length; shorten = the length pass
(`trace.shorten`: outcome, passes, why; "shorter a over b" = D-071 (1): a faithful shorter text still over the kind's bound b was
used after a second pass).

| Turn | live-8 | live-9 | chars (Instinct) | bound | shorten (live-9) | Why (live-9) |
|---|---|---|---|---|---|---|
| C1 | - x F | - x . | 566 (396) | 594 | shorter, 2 passes: 1,026 to 566 (over 550) | 1 posting (PayPal, Chicago, pay with link); NVIDIA remote not returned; `create_file` refused: "sections[0].items[0].label: is over 80 characters"; no File |
| C2 | **P** O . | **P** O . | 402 (361) | 450 | skipped (draft) | referral draft, not sent |
| C3 | - x . | - x . | 229 (396) | 594 | (router) | 1 posting and its File (200); NVIDIA missing |
| C4 | - O F | - O F | 720 (432) | 625 | rejected: the caveat was dropped | header, education, GPA off, a cited university guide |
| C5 | **P** O . | **P** O . | 232 (262) | 375 | within | one question, approach and complexity first |
| C6 | - O F | - O F | 851 (430) | 625 | rejected: a figure was dropped (11) | Gmail first; 9 confirmations, counted right first time |
| C5f1 | gap | gap | | | skipped (code) | branch gap |
| C5f2 | gap | gap | | | skipped (code) | branch gap |
| C7 | **P** O . | - O F | 660 (459) | 625 | shorter, 2 passes: 687 to 660 (over 550) | NYC cost, no verified figure; 6% over the far bound |
| C8 | **P** O . | gap | | | (no model) | model API 503; the no-model reply stood |
| C9 | - x . | - x . | 367 (1144) | 1500 | not run: a research reply, laid out in code | no Citadel content though the audit kept 5 lines (below); PayPal pay without its place |
| C10 | - O F | - O F | 671 (346) | 450 | shorter, 2 passes: 1,101 to 671 (over 396) | PDF and Word keep all 9 entries, dated ones newest first; leads with Elmstead (GTM), says so |
| C11 | - O F | - O F | 1304 (458) | 625 | rejected: a figure was dropped (2029) | needs list; Chicago pay with the posting's link |
| C12 | - O F | - O F | 660 (478) | 625 | shorter, 2 passes: 763 to 660 (over 550) | won't promise 50; small batch first |
| C13 | - O F | **P** O . | 164 (109) | 164 | within | casual comp draft, not sent |
| C14 | - O F | - O F | 278 (178) | 250 | skipped (draft) | C2 shorter, not sent; 11% over |
| C15 | - O F | - O F | 636 (568) | 625 | shorter, 2 passes: 971 to 636 (over 550) | projects, outreach, tracking; 2% over |
| C16 | - O F | - O . | 523 (383) | 575 | accepted: 568 to 523 | tracker File (200) holds the 9 and PayPal as research; fails answers first |
| C17 | - O F | - O F | 756 (563) | 625 | shorter, 2 passes: 878 to 756 (over 550) | reusable answer from confirmed facts |
| C18 | - O F | - O F | 209 (135) | 203 | within (209 < 550) | open through December 6, with the link; 3% over |
| C19 | - x . | - x . | 477 (792) | 625 | within | no leads (fictional school) |
| C20 | - x F | - O F | 641 (358) | 537 | shorter, 2 passes: 762 to 641 (over 550) | v2 keeps all 9; Pixelforge one bullet; Waypoint leads, not expanded (one confirmed line), asks; fails answers first |
| C21 | - O . | - O . | 213 (241) | 362 | within | asks the question; fails answers first |
| C22 | - x . | - x . | 103 (410) | 615 | not run: a research reply | research ran (D-071 (8)), audit kept 4, result no_sources: "no verified market figure" |
| C21f | **P** O . | **P** O . | 513 (412) | 618 | within | a blunt roast |
| C23 | - x F | - x F | 206 (130) | 195 | accepted: 226 to 206 | honest: no Citadel timeline; 6% over |

## The shortener (D-071 (1), `trace.shorten`)

Ran on 12 of 26 turns. **Used a shorter text on 9**: accepted (under the bound) 2 (C16 568 to 523, C23 226 to 206); "shorter",
still over the bound after the second pass, 7 (C1 1,026 to 566, C7 687 to 660, C10 1,101 to 671, C12 763 to 660, C15 971 to 636,
C17 878 to 756, C20 762 to 641). **Rejected 3**: C4 (the caveat was dropped), C6 (a figure was dropped: "11", a date) and C11 (a
figure was dropped: "2029"). Skipped 4 (C2, C14 drafts; C5f1, C5f2 code), within the bound 6 (C5, C13, C18, C19, C21, C21f; C18 is
within the shortener's 550 though over the scorer's 203), not run 2 (C9, C22: research replies, laid out in code), none on
the router's C3 and the no-model C8. Against live-8's 2 used and 12 refused, D-071 (1) works: 6 of the 7 "shorter" texts still
miss the scorer's far bound (C7, C10, C12, C15, C17, C20 at 2% to 49% over; C1 now under), because the shortener's target is
550 characters for an answer while the scorer's far bound is the kind's bound plus 25% or 1.5 times Instinct's reply, and the
second pass stops short of 550.

## Research (D-071 (2), `trace.research`, the ResearchAudit)

| Turn | Tool and words | pages | parse | drafted | kept | from_quote | from_pages | dropped | status | What reached the person |
|---|---|---|---|---|---|---|---|---|---|---|
| C9 | `research_market`: "Citadel new grad software engineer interview process", "Citadel software engineer new grad compensation", "Citadel culture software engineer careers"; companies [Citadel] | 8 | whole | 10 | **5** | 0 | 0 | claim words not in quote 4, figure not in quote 1 | **no_sources** | "I couldn't confirm anything on Citadel this turn" |
| C22 | `research_market`: "software engineer intern hourly pay Chicago 2026", "BLS software developers wages Chicago", "software engineering internship hourly rate Chicago summer 2027" | 10 | whole | 7 | **4** | 0 | 0 | claim words not in quote 2, figure not in quote 1 | **no_sources** | "I couldn't confirm a going rate for Chicago SWE interns this turn" |

C4's `research_career_question` (one cited university guide) has no audit (that tool does not report one).

Both research turns kept lines and still returned `no_sources`. In `researchMarket` (`supabase/functions/_shared/agent/research/market.ts`)
the audit counts a line as kept in three places: a summary point (`fact`), a comparison cell (`fact` with a column) and a
condition or risk (`reading`). Only summary points and a comparison count toward an answer: `if (!points.length && !comparison)
return none()`. So the 5 (C9) and 4 (C22) kept lines were conditions, risks or comparison cells (a comparison whose rows were
then filtered out), and every summary line was dropped; the audit does not say which section a kept line came from. The
page-sentence fallback (`pageSentences`, D-071) runs only when the draft gave no line at all (`if (!audit.drafted)`), so it did
not run on a draft whose every summary line was dropped. The item 10 live run shows the same shape in `researchCompany`
(Datadog, Affirm and Toast: kept 1, the `frame`, which does not count toward `any`, so no brief).

## The owner's must-fixes, on this transcript

| Must-fix | Result | Evidence |
|---|---|---|
| (a) Every tailored version keeps every confirmed role, newest first | **Pass** (4/4 files) | Read back from the artifact store and parsed (`trace.documents`). C10 `Sam_Rivera_Resume.pdf` (1,676 B) and `.docx` (2,862 B) print, in order: Elmstead (September 2026 - present), Mindgrove (August 2026 - present), Rallyup, Waypoint, Harbor Global, Crestline Partners (2025), Pixelforge (2023-2025), Ondo, Leadership: 9/9; the dated entries are newest first (D-071 (5); undated ones keep places between them). One skills line, no GPA, education last (the technical template's order, as D-071 (5) ruled). C20 `Sam_Rivera_Resume_v2.pdf` (1,644 B) and `.docx` (2,849 B): the same 9/9, Waypoint first as asked, then the same dated order; Pixelforge cut to one bullet. Not ideal for the role: newest first puts Elmstead (GTM) at the top of a SWE resume (the C10 reply says so and offers to swap). |
| (b) C6 reads Gmail first, correct count | **Pass** | `called: read_application_mail, list_applications`; "Yes, 9 applications went, each confirmed by an employer 'Thank you for applying' email", then the 9 with dates; the count is right the first time (live-7 and live-8 said 8, then corrected to 9; D-071 (7)). |
| (c) C9/C23 research covers pay, process and culture, each with a source link | **Fail** | C9: `research_market`, 3 queries, 8 pages read, 10 lines drafted, 5 kept, 5 dropped, status `no_sources`; the reply: "I couldn't confirm anything on Citadel this turn, so I have no sourced answer for any of the three parts", no Citadel source link. C23: "You haven't given me a Citadel process length, and I couldn't confirm anything on their interview process" (honest; nothing to recall). Cause above. |
| (d) Every pay figure carries place and a source link | **Fail** (5 of 6 replies; the File passes) | Pass: setup-2 ("Chicago, IL. Pay is listed as $28-$49 hourly" + the Workday link), C1 ("Chicago, IL ... $28-$49 hourly" + link), C11 ("Chicago pay is $28-$49 hourly" + link), C3's File card ("Pay $28-49/hr · listed on the posting, Where Chicago, IL, Source Workday"). C22 and C7 carry no posted figure (C7's are the person's own). **Fail: C9** "The only pay I have is the PayPal SWE internship posting you saw earlier, listed at $28-$49 hourly" with the link but no place. |
| (e) Every File and tracker link opens and holds what the reply claims; C1's plan File is made | **Fail** (2/2 links pass; C1's File not made) | C3 roles File: 200, "Software engineer internships in chicago or remote ... PayPal Software Engineer Intern - Summer 2027 ... Pay $28-49/hr ... Chicago, IL ... Source Workday". C16 tracker: 200, "Application tracker", the 9 Gmail-confirmed applications with evidence, "Researched, not applied ... PayPal", "Drafts ... None on record", the one-account coverage note: what the reply says. **C1: `create_file` refused again**: "not created: sections[0].items[0].label: is over 80 characters" (D-071 (3)'s shape coercion held; this is a length rule), no second call, no File; the reply claims none ("there's no file to point you to"). |

## What still fails, and why (from this transcript; not yet reproduced at $0)

- **Research (C9, C22, C23; must-fix (c)).** Lines are kept and then thrown away: `researchMarket` answers `no_sources` unless a
  summary point or a comparison survives, and the page-sentence fallback runs only when the draft gave nothing. The drops are
  mostly `claim_words_not_in_quote` (4 of 5 on C9). Same shape in item 10 (Datadog, Affirm, Toast).
- **C1: no plan File.** `create_file` now refuses a label over 80 characters; the model wrote a long label and did not retry.
- **C1, C3: NVIDIA's remote posting not returned.** The brain's one query had no "or" ("software engineer intern summer 2027
  Chicago remote"), so D-071 (4)'s per-alternative relaxation never ran; the router's C3 search is the same as live-8's.
- **Length (12 of 23 far over).** The shortener now uses shorter texts (9 used), but its target (550 for an answer) is above the
  scorer's far bound on several kinds and its second pass stops short; C4, C6 and C11 were refused for dropping a caveat or a date
  figure ("11", "2029").
- **C9: PayPal's pay without its place** (must-fix (d)): the research reply's fallback sentence restates the figure with the link
  but not "Chicago".
- **C10: newest first puts a GTM role at the top of a SWE resume.** The order rule holds, the reply flags it.
- **C8: one model API 503**, a provider fault; the product said so and kept the request.
