# Response rules: how Trainee answers a text, what it says, when it makes a File, and how any action stays one step

Status: architect ruling, 2026-11-09. Source: Instinct's APP-LAYER-15-FIXES spec (sections A.5, B.1 to B.7, C.1, C.2,
C.24, D.4, E.4 to E.6). This document turns those sections into rules the code must follow. Where Instinct conflicts with an
owner decision, the owner decision stands (no per-person AI cap, D-046; Sonnet 5.5; no downloadable extension, D-050).
`RESPONSE-LAYER.md` is the inventory of where reply text is written. This file is the ruling on what that text must be.

Every rule names its enforcement: a rubric rule in `supabase/functions/_shared/reply_rubric.ts`, a test, or "GAP", which
means nothing enforces it yet. A GAP is open work, not a pass.

---

## 1. The five properties of every reply (A.5 rubric)

| # | Property | Rule | Enforcement |
|---|---|---|---|
| R1 | Clarity | The first sentence answers the latest message in plain words. A question gets an answer; a request gets the result or the specific reason there is none. | `answers_first`; `tests/edge/reply-rubric.test.ts` |
| R2 | Brevity | Every sentence changes what the person knows or can do. A short ask (25 words or fewer) gets at most 600 characters of prose. No echo of the ask, no "let me know if", no retelling of the plan. | `channel_length`, `repeats_ask`, `boilerplate_tail` |
| R3 | Context | The role, place, seniority, document and recipient the person gave stay in force until they change them. A correction replaces the old value everywhere at once and is never answered with a different workflow (A.5 patterns 2 and 4). | GAP for cross-turn carry (see section 6); `tests/architect/stop-pause-truth-20261109.test.ts` covers the research-over-action case |
| R4 | Ownership | Trainee does the work. If it cannot, it names the one specific blocker and its evidence, then says what is done, what remains and the smallest decision needed (E.6 52, 54). It never hands back work the person already did (A.5 pattern 1). | `blocker_named`, `repeats_ask` |
| R5 | Evidence | A claim that something happened needs proof from this turn (a tool result, a row read back, an employer receipt). Opened is not submitted; found is not verified open; generated is not delivered (B.7). | `unproven_action`, `invented_fact`; D-024 |

Plus five rules that apply to every surface (D.4):

| # | Rule | Enforcement |
|---|---|---|
| R6 | No internal vocabulary: no "runner", "parse check PASS", "record", queue codes, ids, "as of" dates or flag names. | `internal`; `tests/architect/reply-jargon-guard.test.ts` |
| R7 | Times are given in the person's own zone, with the real time ("resets at 6 pm Chicago time"), never UTC or a stale date. | `time_zone`; `tests/architect/r10-wo-d-limits-replay.test.ts` |
| R8 | At most one apology, and never again on the next turn. Repeating a failure in new words is not progress (B.7). | `apology_loop` |
| R9 | No progress bubble that says nothing changed. One interim message is allowed only when work takes long enough to need one, and the next reply must hold the result or a concrete blocker (B.6 continuation 2, turn 1). Section 3.5 gives the rules in full. | `tests/architect/r-states-bubbles-loop.test.ts` (every bubble scored through the real webhook and handler); `tests/architect/telegram-typing-ack.test.ts`; `tests/architect/f13-staged-brain-handler.test.ts` (architect amendments, 2026-11-10). |
| R10 | The reply ends at the decision. If the person must choose, that choice is the last sentence and it is answerable in a word or a number. | `ends_at_decision` |

---

## 2. What to answer, by intent

Each row gives the target reply shape (quoted or condensed from section B), what the reply must contain, and what it must never
do. "File" names the File family in `supabase/functions/_shared/file_family.ts` that holds the depth.

| Intent (example text) | Target reply | Must contain | Never | File |
|---|---|---|---|---|
| Edit the resume ("make it more like a data analyst resume, one page") | "I will put the Python screening project and analysis skills first, keep the page to one sheet, and leave the experience itself unchanged. The source is your saved intake, not the original uploaded resume. I still need your correct GPA and contact details before this is ready to send outside this chat." | What changes, the source used, what is still missing. | Add a job, tool, number or credential; regenerate everything silently. | F-07 |
| "What did you change?" | The actual edits ("moved the Python screening work above the finance material, shortened repeated wording"), plus what was not added. | Real diff in words. | A generic "ATS-optimised" promise. | F-07 (change note) |
| Rewrite one bullet | "Proposed replacement: …" with the new bullet next to the old one, plus any fact the person must confirm ("if 100+ is not accurate, tell me the supported count"). | The bullet itself, verbatim. | Rewrite other bullets. | none (inline) |
| "Give me the PDF" | "Here is the revised one-page PDF. GPA is omitted, the first bullet is shorter, and the contact placeholders still need filling. This is a review draft, not ready for an employer." | The attachment, in the same turn. | Say "attached" when no file was produced (C.24 Error). | F-07 |
| Search ("find five data analyst internships in Chicago, do not apply") | Either the shortlist, or one line on the scope being checked followed by the shortlist in the next reply. "I will return fewer than five if I cannot verify five." | The verified count; each role with an inspected employer link; the pick and its condition. | Pad the list; invent a link; count a target as an application. | F-05 |
| Empty search | "No verified roles matched [scope]. I checked [boards and employer pages, count]. The nearest change that would find roles is [one variation]." | The scope checked and one specific next choice (C.24 Empty). | "Widen the role or the place" with no scope (A.5 pattern 5). | F-05 (empty state) |
| "Which is best for me?" | A pick with its condition: "Lakefront first, if you can work onsite on Tuesdays and Thursdays…" then the second and third with their reasons. | A decision. | "It depends" with no pick; treat a preference as a hard rule. | F-05 |
| A constraint changes ("remote only") | What the change removes, what remains, and what Trainee will do next: "That removes Lakefront and Northline… I would keep searching for remote-US roles rather than fill the list with onsite jobs." | Kept, removed-with-reason, next search. | Reset to the old search; re-run intake. | F-05 (revised) |
| "Why not [role]?" | The real sourced constraint ("the inspected page lists New York, Seattle and South San Francisco… graduation in December 2027…") and what is unknown about the person. | The source. | A guess. | none |
| Apply to the top N | "I can prepare the N applications. Before any submission I will show you the role, the resume and the exact answers for each employer. Still needed: [named facts]." | The exact facts missing, by name. | Submit; ask for facts already given; choose legal status or dates for the person. | F-09 / F-10 |
| "Can you just pick the best answers?" | "I can improve wording, but I cannot choose your legal work status or graduation date. Those need to be your answers." | The line between wording and facts. | Pick a sensitive fact (D-007, D.4 6). | F-08 |
| Approves one paragraph ("use that") | "I will use that version. The graduation, availability and work-authorization fields are still unanswered." | What the yes covered and what it did not. | Treat a paragraph yes as a submit yes. | F-09 |
| Yes to an exact application or batch | One receipt per submission plus one closeout listing every role and its state (submitted and confirmed, submitted and awaiting employer, uncertain, held with reason). | The real state per role. | A green "done" before employer evidence (C.24 Confirmed). | F-10 |
| Ambiguous referent ("send this one") | "The revised resume PDF, or the application packet? And do you want it here or sent to someone?" | Two concrete choices. | Act before the referent is settled (E.4 36). | none |
| "Send it to Maya" with no address | "Which Maya, and where should I send it?" then, if still unclear, "I can draft a short note while you find it." | A narrow question plus useful work. | Turn a company into a guessed personal email (E.4 41). | F-12 |
| Draft a message, then restyle it | The full draft each time, changed only in style. | Recipient state and attachment name. | Invent a meeting, referral or relationship. | F-12 |
| Company research ("Stripe analyst interview") | Ask for the team if it changes the answer; otherwise the thesis first, then sourced facts, then questions to ask. Label interpretation as interpretation; keep volume distinct from revenue and a forecast distinct from a result. | Sources beside facts; dated recent items. | A list of links with no synthesis; an invented initiative, quote or metric (E.5). | F-01 / research brief |
| "Does this mean I qualify?" | "No. The inspected page has a specific graduation window and office locations. I have not confirmed your graduation date…" | What is unknown. | Imply eligibility. | none |
| Stop or pause ("pause everything") | The state actually reached, read back: "I paused your account: [what stopped, what was already sent]." If the state cannot be read: "I have not paused your account. I could not read the queue's own records…" | Real state. | Claim a global pause that did not happen (F.3). | none |
| AI-answer limit reached | "I couldn't finish this without the AI: "[the ask]". I kept it. Trainee's AI budget for today is used up. It resets at midnight Chicago time; say "continue" after that and I'll pick it up. Nothing was applied for, and searching postings still works now." | What stopped, the kept task, the real reset time in the person's zone, and what still works (E6). The day's cap resets when the budget day turns (midnight US Central, said in the person's zone: "which is 10 PM Los Angeles time"). A provider refusal gives the time only when the provider gave a retry-after. The $70 total and the pause have no reset time, so none is given; the next step is the owner's approval or "later". UTC only when the zone is unknown, and then the reply says so. | Unrelated templates, old dates, or a made-up time (E.6 50). | none; `limit_stop.ts`; `tests/architect/r10-wo-d-limits-replay.test.ts`, `tests/architect/r-states-bubbles-loop.test.ts` |
| A turn that runs long | One interim after 6 s that says what Trainee is doing ("on it — looking for roles now"), then the result. | Exactly one interim, then the result or a named blocker. | A second interim; an interim on a fast turn; an interim that claims a result. | none |
| The model fails (outage) | The router answers only when it has a real intent for this message. Otherwise: "I couldn't finish this without the AI: "[the ask]". I kept it. The AI service failed on this one (an error on its side, not a limit). Say "continue" in a minute and I'll pick it up." | What stopped, the kept task, one next step. | The router's catch-all answering a different question (architect amendment, 2026-11-10). | none |
| agent-chat fails after the interim | "I couldn't finish "[the ask]": Trainee hit an error on its side, so I can't confirm how far it got. Send it again and I'll retry." A second failure in a row is said as the second. A fast failure with no interim keeps "I couldn't answer that just now". | The blocker, the ask, no claim about what got done, one next step. | The bare "couldn't answer" after "on it". | none |
| The turn runs past 2 minutes | "I couldn't finish this in time: it ran past 2 minutes, so I stopped waiting, and I can't confirm how far it got. Send it again and I'll retry." A second time-out in a row: "That ran past 2 minutes again…" with one way to make it finish. | What stopped; that the outcome is unconfirmed (D-024). | "I couldn't answer that just now"; the same words for the second failure. | none |
| A batch partly fails | The yes: "N approved exactly as shown; M of the T not sent, each below with why", one line per item. The closeout, from the records: each item in its one state (section 3.5), the held one with its one question. | Every item's real state; the items the blocker does not touch go ahead (E6). | One failure holding back the rest; a failed item shown as sent. | F-10 |
| Off-topic or small talk | One plain sentence, then back to the open decision if one exists. | Nothing else. | A menu of capabilities. | none |

---

## 3. When a File is made, and how it looks

### 3.1 When

- A File is made when the result has more than one item, more than about 600 characters of substance, a document to inspect,
  or an action the person must approve (an application, a batch, a message to someone else). Otherwise the answer stays in chat.
- One File card per result in chat (C.2). Never paste a list of raw links into chat.
- A File that changes is versioned ("Review v3"). An approved version is never overwritten (E.4 40).

### 3.2 Anatomy (C.1; the code is `file_family.ts`)

1. Header: back button, serif title, a one-line subtitle stating the effect boundary (`FAMILIES[id].boundary`, for example
   "Plan - searching is not applying"), and an overflow menu.
2. Hero: kicker with family and version ("ROLES FILE - BATCH B-01 - REVIEW V1"), title, then freshness with a real time and
   its source ("Updated Today 9:32 AM. Source: your resume + chat"). Count chips use real item states that are mutually
   exclusive and sum to the total (D.4 4).
3. Content cards: each value carries its source or kind beside it ("Chicago, IL - you confirmed"). Unknown is written as
   "unknown" (`UNCONFIRMED`, `claimHtml`). Sensitive fields are answered per application by the person, never reused silently.
4. Callouts: lavender for scope, amber for unknowns, red for conflicts and an uncertain submission.
5. Action bar: one primary button named for the exact decision ("Approve v3 for R-07") and at most two secondaries.
   Download never looks like submit (D.4 5). An action that cannot work is not shown, or is shown disabled with the reason
   (`Act.off`); there is no dead button.

### 3.3 States (C.24)

Every File shows exactly one of: Loading, Empty, Needs input, Prepared, In progress, Uncertain, Confirmed, Error, Expired.
Prepared is never shown as submitted; In progress has no green badge; Uncertain stops a blind retry; Confirmed requires
employer evidence (`email_confirmed_at` and the mail hash; a page reference alone is not confirmation, ruling 13-Obs).

### 3.4 The chat card (C.2)

Kicker, title, a freshness line with real counts ("Updated 9:40 AM - 14 ready to prepare - 2 need answers - 1 closed"), up to
three state chips, one button ("Review roles"), and the caption "Opens your private File - nothing is submitted from chat."
The chat bubble after it names the exact decision ("Two roles need one answer from you. The File shows exactly which.").

### 3.5 Progress bubbles and state messages in chat (R9, C.24)

Every message a person sees counts, not only the final reply. `tests/architect/r-states-bubbles-loop.test.ts` drives slow
tools, a time-out, every limit, a provider error and a partly failed batch through the Telegram webhook, the real inbound core
and the real agent-chat handler, and scores each bubble. Its bar is 0 on each count below.

| Count | Rule |
|---|---|
| empty | No bubble without words. |
| repeated | No bubble twice in a turn. An interim is never the reply. The same interim and the same reply as the turn before means nothing changed, so a failure that repeats is said as repeated. |
| extra | At most one interim a turn, even when a file is read first. |
| early | No interim on a turn that finishes inside the 6 s budget (`FAST_ACK_MS`). |
| hollow | After an interim, the reply holds the result or names what stopped. "I couldn't answer that just now" is not a blocker. |
| no_reset | A daily-limit reply gives the real reset time in the person's zone. A limit with no known reset gives no time. UTC never goes to a person whose zone is known. |
| not_kept | A limit reply says the task is kept and what still works (E6). |

The chat words for each C.24 state:

| State | What the chat says | Never | Enforcement |
|---|---|---|---|
| Loading | The one interim: what Trainee is doing (`ackFor`). | A result, a count, or "one sec". | `telegram-typing-ack.test.ts`; the loop |
| Empty | The scope checked and one specific change (section 2, empty search). | A bare "widen the search". | `r10-files-shell.test.ts` |
| Needs input | One fact, by name, with why it matters; the prepared draft stays (E3, E4). | Two questions, or a discarded draft. | `r10-fix-12-review.test.ts` (pending) |
| Prepared | Ready for review, not sent. | "Submitted" or "done". | `wo-g-application-review.test.ts` |
| In progress | "approved; it is sent next" (`career_apply_cards.ts` RESULT). | A green badge, or "sent" before the send. | `mass-submit-handler-pg.test.ts`; the loop's batch test |
| Uncertain | Sent but not confirmed, with the proof to look for; no blind retry. | "Confirmed" from a page alone. | `wo-g-batch-closeout-pg.test.ts` |
| Confirmed | Only with the employer's email (`email_confirmed_at` and the mail hash). | A page reference alone (ruling 13-Obs). | `apply-outcomes.test.ts` |
| Error | The step that failed and what is unconfirmed (time-out, outage, a file not made). | "Attached" with no file; "couldn't answer" with no cause. | the loop; `channel-inbound.test.ts` |
| Expired | Why it lapsed: the card or the posting changed or went out of date, so the old yes does not cover it. | Sending on an old yes. | `wo-022-cards.test.ts` (stale and out-of-date cards); `mass-submit-handler-pg.test.ts` |

---

## 4. Making any action easy

| # | Rule | Enforcement |
|---|---|---|
| E1 | One yes approves exactly what was shown, by payload hash. A batch yes approves every application in the batch shown and sends all of them; each gets its own receipt and the batch gets one closeout (owner ruling; D-MS-1, D-MN-2). | approval hash tests; `tests/architect/wo-g-batch-closeout-pg.test.ts` |
| E2 | Numbered references persist: "apply to 2 and 4" means items 2 and 4 of the list last shown, until a new list is shown. | GAP: no test pins persistence across a constraint change |
| E3 | A question is narrow: one fact, by name, with why it matters ("Graduation date needed: the posting requires December 2027 or later"). Two concrete choices beat an open question. | `blocker_named`; GAP for the "why it matters" clause |
| E4 | Asking never discards work: the prepared draft stays visible while one field is missing (C.24 Needs input). | `tests/architect/pending/r10-app-layer/r10-fix-12-review.test.ts` |
| E5 | Applying needs only a chat message and a yes; the cloud browser does the rest. Nothing is downloaded or installed (D-050). An employer account is created only after the yes to that exact application (D-051, pending the owner's wording). | `supabase/functions/_shared/submit_capability.ts` (host list in #666) |
| E6 | Work that does not depend on a blocker keeps moving; the reply says so. At a limit the reply keeps the task and says what still works ("searching postings still works now"); in a batch the items a question does not hold are sent and each held one is named with its question. | `not_kept` in `tests/architect/r-states-bubbles-loop.test.ts` (live at every limit); the batch test there over `answerText` and `batchCloseoutText`; `tests/architect/wo-g-batch-closeout-pg.test.ts` |
| E7 | A link in chat is a File link or an inspected employer link. No bearer link is sent when files are attached (ruling on #634). | `tests/architect/r9-resume-fit-send-20261108.test.ts` |

---

## 5. Order of a reply

1. The answer or result (R1).
2. What it rests on, only if it changes trust: the source, what was not used, what is unknown (R5).
3. The File card, if a File was made (section 3.1).
4. The single decision, last (R10).

Nothing comes after the decision: no tails, no offers of more help, no capability lists.

---

## 6. Gaps, ordered by user harm

1. R3 cross-turn carry: nothing checks that a corrected role, place or recipient survives the next three turns. Needed: a
   scenario battery over B.6 continuations 1 to 4, run turn by turn, asserting the carried values.
2. File serving and the chat card (C.1, C.2): `file_family.ts` defines the families and helpers, but serving every family and
   the chat card are not shipped (WO-E branches e4 to e8). Until they ship, replies that should point to a File fall back to
   inline text, which breaks R2 for long results. Measured by `tests/architect/files-actions-loop.test.ts` (every family,
   state and the live roles page at 390 px, every control pressed): 0 dead controls and 0 C.1 or C.24 failures are asserted;
   the actions no File server answers yet are counted as "unserved" (99 of 226 at trunk 3d4e1361; the live roles page 0 of 61).
3. E2 numbered references across a constraint change.
4. R9 and E6 are closed (sections 3.5 and 4): the loop scores 0 on every count. Architect amendments of 2026-11-10 changed two
   pinned assertions: after an interim, a failure names what stopped (`telegram-typing-ack.test.ts`); a model outage is held,
   never answered by the router's catch-all (`f13-staged-brain-handler.test.ts`).

A rubric sweep over every templated reply in `RESPONSE-LAYER.md` sections 2 to 6 is the measurement. It is blocked locally
by disk space and will run in CI. Each violation becomes a fix in the file that writes the text, never an exception added to
the rubric.

## 7. What does not count as a pass

- A test that checks one phrase while the reply breaks R1 to R10.
- Repeated fallback messages counted as new coverage (E.6 53).
- The five worked examples counted as five successful runs (B.7).
- A File that was generated but not opened and visually checked in its delivered version (D.4 11).
