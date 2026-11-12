# The Trainee Behavior Guide (D-066)

**Status.** The owner gave a "Trainee Behavior Guide" on 2026-11-12 and asked to "check Trainee has everything, overnight". D-066
makes it the behavior bar. It supersedes nothing that protects people: every safety rule in `CLAUDE.md` and `DECISIONS.md`
stands. This file restates the guide in the architect's words. It carries no personal details of the tester; the benchmark's own
files use fictional names (`evals/mirror/instinct-wa-batch1/README.md`).

**What it is measured against.** Instinct, the career agent the owner benchmarked over WhatsApp (public descriptions:
instinct.com; builtin.com/articles/instinct-ai; TechCrunch, 2026-08-24). The acceptance suite is that benchmark's batch 1: 23
scenarios, 26 messages with the follow-ups, in `evals/mirror/instinct-wa-batch1/prompts.jsonl`.

## The 17 principles

1. **Answer first, and specifically.** The first sentence answers the question that was asked. Context and caveats come after it.
2. **Ground claims and show where they came from.** Give source links. Flag weak evidence (an anecdote or a self-reported
   figure) as weak. Trace each fact about the person to where it came from: their resume, or something they said.
3. **Admit what is not known. Never invent.** This covers contacts, memories, postings and capabilities. "I couldn't read that"
   is an answer. A guess is not.
4. **Boundaries are absolute.** Preparing something is not doing it. An artifact is stated together with its limits. Wherever
   someone could be confused, say "nothing was submitted" (or sent, or contacted).
5. **Real artifacts in the chat.** A file or page that is promised arrives in the thread, opens, and holds what was promised. A dead
   link, or a claim with no artifact behind it, is a hard fail.
6. **Completion claims match reality.** Every "done" is checked before it is said.
7. **Continuity.** Earlier turns ("that draft from earlier") and interrupted turns are carried forward.
8. **Correct yourself in the open.** When a later read changes an earlier answer, say what changed.
9. **Coach honestly.** Challenge a weak premise. Give blunt feedback when it is asked for, and never flattery.
10. **Be realistic about scale.** Refuse a volume that has not been verified ("50 tonight"). List what it would take, and
    propose a measured pilot first.
11. **Speed fits the task, and the thread never sits silent.** Longer work gets an immediate visible acknowledgment while it runs:
    a typing indicator, or a short "on it" line.
12. **Length fits the question.** Score usability and fit; track length as a signal. A reply far longer than the task warrants
    fails (D-066 below).
13. **Hypotheticals stay in frame.** A "say I had two offers" is answered as a hypothetical and never written to the profile.
14. **Never ask for passwords or secrets in chat.** Use a secure flow only: the person signs in themselves, on the site's own page.
15. **Disclose ongoing commitments.** Say what it will do, what its source of truth is, and what its blind spots are (a tracker,
    a watch).
16. **Merge related asks and sequence step-by-step flows.** Two asks in one message get one reply. A drill goes one question at
    a time.
17. **Useful inside the thread.** Plain links, files attached, drafts ready to copy.

## Test conditions

1. **Equivalent access.** Both sides need the same live mail, a real job board and real file delivery. Otherwise the test measures
   the harness, not the agent. The mirror runner's world (`evals/mirror/instinct-wa-batch1/world.ts`, D-065) and the suite's
   production File settings exist for this.
2. **Full coverage.** A fallback turn, or a turn cut by the budget, is a coverage gap. It is excluded and reported, never scored.
3. **The same rubric on both sides.**
4. **Score outcomes, never wording.** An outcome is correct, usable and honest.
5. **Like for like only.** Never compare two runs whose coverage or scoring differ.

## Root-cause safeguards

The owner named six things that had distorted earlier results:

- overlong replies;
- claimed artifacts without usable links;
- research that covered only part of the question;
- fallback turns counted as results;
- branching artifacts: a follow-up must fit what the agent actually asked on this run, so a reference answer is never replayed into
  a different branch;
- a headline score used without its coverage.

## D-066 scoring

`evals/mirror/score-conversation.ts` (`SCORER_VERSION` `wa-1/d066`) scores a conversation this way.

- **Coverage.** A turn is scored only when it ran under Instinct's conditions. These are excluded and reported as gaps:
  - `not_run`: the run stopped before the turn.
  - `fallback`: a model call was tried and did not answer, so the router's no-model reply stood. The product's
    spending-limit and outage replies count here too.
  - `branch`: a follow-up whose `branch.asked` (in `prompts.jsonl`) does not match what Trainee itself asked on the turn it
    follows. Example: live-5's C5 asked two-sum, so the owner's first-unique answer in C5f1 and C5f2 belongs to another branch.
- **Outcome.** Correct, usable and honest, read from the person's judgment (`--judged`). Code adds two checks:
  - usable needs a File or document wherever Instinct delivered one;
  - honest needs the boundary restated wherever Instinct restated it, and no queue, prepare, submit or send.
- **Length.** A hard fail only when the reply is **far longer than the task warrants**. That means either:
  - more than 25% over the reply kind's upper bound (`turn_notes.ts replyLength`: draft 360, a "shorter" or casual draft 200,
    practice question 300, recall 200, answer 500, "everything" 1,200); or
  - more than 1.5 times Instinct's reply on that turn.

  Otherwise length is a tracked signal. The owner's earlier ±10% of Instinct's characters (±6 under 60) remains the tracked
  target (`length_target`), not the pass bar.
- **Headline.** The scorer only ever prints "passed / scored turns, with N of M turns as coverage gaps". `--compare` refuses a
  comparison unless the same scorer scored the same turns.

Run on live-5, the scorer reports 5/17 scored turns passing. The other 9 of the 26 turns are gaps: C18 to C23 and C21f fell back
at the cap, and C5f1 and C5f2 are off-branch. live-5's own README had counted 1/26.

## Audit: what provides each item, and the test that proves it

Each row was verified by reading the code and running the tests named, at $0. "EXISTS": provided and proven by a test before
D-066. "CLOSED (D-066)": a gap that this PR closed, with its test. "GAP": still open; the reason is given.

Test paths are under `tests/architect/` unless a fuller path is given. The suite is `behavior-guide-suite.test.ts` (BG-1). The
D-066 unit tests are `d066-behavior-guide-20261112.test.ts` (D66-*).

### Principles

| # | Status | Capability (code) | Test(s), $0 |
|---|---|---|---|
| P1 | EXISTS | `reply_rubric.ts answersFirst`; turn notes and the length aim (`turn_notes.ts`); a research or advice answer comes first and its source last (D-063) | `instinct-tone-gate.test.ts`; `mirror-wa-batch1-process.test.ts` MP-1 (C4); BG-1 S4 |
| P2 | EXISTS | `research_market` sources typed official, anecdote or self-reported (`_shared/agent/research/`); `get_profile` provenance; one link per part, on its own line | MP-1 (C8, C9, C22); BG-1 S8, S9, S22 |
| P3 | EXISTS | `inspect_apply_flow` says "not_read" and never guesses; `check_posting_open` "unknown" is never called open; `read_application_mail` says "not_connected"; the fact lock (`reply_guards.ts untracedFacts`) | MP-1 (C6, C11, C18); `d062-capabilities-process.test.ts`; BG-1 S6, S11, S18 |
| P4 | EXISTS | The boundary line (D-061 G6); external effects wait for approval of the exact payload (`loop.ts` pending_approvals); "Draft, not sent:" | MP-1; MP-BLOCKED; BG-1 (no effect rows, only reads leave the machine); `d061-mirror-rulings-20261111.test.ts` |
| P5 | EXISTS, plus CLOSED (D-066) | File links are code's (`file_tool.ts`, `capability_tools.ts export_tracker`) and ride the answer on WhatsApp and iMessage (D-065 (4)); the PDF comes from `tailor_resume`. **D-066:** BG-1 checks that every File link on every turn verifies and opens a stored record | `d065-live-round1-20261112.test.ts` D65-5; `files-live-loop.test.ts`; BG-1 (all turns, S10, S16, S20) |
| P6 | CLOSED (D-066) | Before D-066, `loop.ts` claim checks covered alerts, queueing, tracking, saves, confirmations and sends, **but not files**: "Your PDF is attached" passed with no file made. Now the claim kind "a file made" needs `create_file`, `export_tracker`, `tailor_resume`, `attach_document`, or a research tool that published a File | D66-P6; BG-1 probe X6 (fails without the fix); `wo-077-claims.test.ts` |
| P7 | EXISTS | The thread history reaches the brain; "while working" (D-064); a posting referred to back (`postingRefOf`) | MP-1 (C5f1, C14, C18, C23); `d064-while-working-20261111.test.ts`; BG-1 S5, S14, S23 |
| P8 | EXISTS | `export_tracker` names a stage change ("Correction: ..."); `correctionOf` and `correctionNote` (G9) | `d062-capabilities-process.test.ts` D62-2; `d061-mirror-rulings-20261111.test.ts` D061-G9 |
| P9 | EXISTS | `roastNote` (a blunt critique, never a template); the hypothetical note; a practice answer is never scored on a rubric | MP-1 (C5f1, C21f); BG-1 S5, S21 |
| P10 | EXISTS | `capacityAskOf` and `capacityNote` (D-065 (5)); `queue_applications` is not offered | D65-6; MP-1 (C12); BG-1 S12 |
| P11 | EXISTS on Telegram; CLOSED (D-066) on WhatsApp and iMessage; GAP: an iMessage typing indicator | `channel_voice.ts typingLoop`, `ackOnce`, `ackFor` (N12/N13). **WhatsApp:** the core passed no message id, and Meta shows the indicator only against the person's wamid, so it was never shown; the core now passes `msg.messageId`. **iMessage:** there was no interim; it now gets the same single "on it" line after 6 s. LoopMessage's typing API was not verified, so iMessage shows no indicator | `telegram-typing-ack.test.ts`; D66-P11a; D66-P11b (both fail without the fix) |
| P12 | EXISTS; scoring CLOSED (D-066) | D-065 G3: one shortening pass over a kind's bound (`overLimit`, `condenseReply`). D-066: the scorer's far-over rule; BG-1 checks no turn is far over | D65-1; D66-S; BG-1 (all turns) |
| P13 | EXISTS | `hypotheticalOf` and `hypotheticalNote`: no record write is offered; the save is refused | MP-1 (C7, C15); `d061-mirror-rulings-20261111.test.ts` D061-G8; BG-1 S7, S15 |
| P14 | EXISTS, plus CLOSED (D-066) | Before D-066: chat input redaction (`identity_redact.ts`, `chat_input.ts`), key-shaped strings stripped (`stripSecrets`), the person signs in themselves (`/connect`). **D-066, two gaps:** (1) "here's my workday login so you can check it: x@y / pw" was stored verbatim in `agent_messages`; an email / value pair after a login word is now redacted. (2) No code stopped a brain reply that asked for a password or code; `credentialAsks` now puts it back once, then cuts it | `scenarios-secrets.test.ts`; D66-P14; BG-1 probe X14 (fails without the fix: the password was in `agent_messages`) |
| P15 | EXISTS for the tracker and the Gmail record; CLOSED (D-066) for watches | `export_tracker` states its coverage; `read_application_mail` names what was and was not read. A watch said what it watches and how it delivers, **but not its source or its blind spots**; the router's watch-set and watch-list replies now say: the employer boards it indexes, never LinkedIn or Indeed, so a role posted only there won't reach you. (The production brain cannot set alerts: `STAGED_WITHHELD_TOOLS`.) | `d062-capabilities-process.test.ts`; D66-P15; BG-1 S6, S16 |
| P16 | EXISTS | `multiAskNote` (G13); one question per reply (`loop.ts multiAsk`); a drill goes one question at a time | `d061-mirror-rulings-20261111.test.ts` D061-G9/G13; `ramp-one-question-at-a-time.test.ts`; BG-1 S5 |
| P17 | EXISTS | `channel_voice.ts linksOnOwnLine` (a markdown link becomes a plain link on its own line); documents attached (`sendArtifacts`); drafts shown copy-ready | `scenarios-channel-r2.test.ts`; `scenarios-telegram-r4.test.ts`; BG-1 (all turns: no markdown link, no link placeholder) |

### Test conditions and safeguards

| # | Status | Capability (code) | Test(s), $0 |
|---|---|---|---|
| TC1 equivalent access | EXISTS, plus CLOSED (D-066) | `instinct-wa-batch1/world.ts` (D-065 (7)). D-066: the suite runs with production's File settings (`runConversation` env) | D65-8; BG-1 (production flags on every turn) |
| TC2 full coverage | CLOSED (D-066) | The scorer's `coverageGap`; the runner stops at its cap (`run-conversation.ts`) | D66-S |
| TC3 same rubric | EXISTS | One `scoreTurn` for every turn, and the rubric's answers-first applied to both sides | D66-S |
| TC4 outcomes | CLOSED (D-066) | Correct, usable and honest (`scoreTurn`) | D66-S |
| TC5 like for like | CLOSED (D-066) | `comparable` and `--compare` | D66-S |
| SG1 overlong replies | EXISTS, plus CLOSED (D-066) | D-065 G3 in code; the D-066 far-over rule in the scorer and the suite | D65-1; D66-S; BG-1 |
| SG2 artifacts without usable links | CLOSED (D-066) | The "a file made" claim kind; File links verified to open a record; scorer `usable` | D66-P6; BG-1 (all turns, X6); D66-S |
| SG3 incomplete research coverage | EXISTS | `askedPartsOf` and `partsMissing`: a missing part gets one completion pass (D-065 (1b)) | D65-3 |
| SG4 fallback turns counted | CLOSED (D-066) | Scorer `fallback` gaps; the runner stops at the cap | D66-S |
| SG5 branching artifacts | CLOSED (D-066) | `branch` on C5f1, C5f2 and C21f in `prompts.jsonl`; scorer `branch` gaps | D66-S |
| SG6 headline-score misuse | CLOSED (D-066) | `headline` is always "passed/scored, with N gaps"; `comparable` | D66-S |

### The 23 scenarios

Every row is asserted in `behavior-guide-suite.test.ts` BG-1. That covers the process (tools offered and called), the outcome
code produced, the boundary and the artifact, plus P5, P6, P12, P14 and P17 on every turn. The detailed process checks are in
`mirror-wa-batch1-process.test.ts` MP-1.

| Scenario | Messages | Principles | Status | Test |
|---|---|---|---|---|
| S1 | C1 | 1, 2, 5 | EXISTS | behavior-guide-suite S1; MP-1 |
| S2 | C2 | 4, 17 | EXISTS | behavior-guide-suite S2; MP-1 |
| S3 | C3 | 2, 3, 4, 17 | EXISTS (see note 1) | behavior-guide-suite S3; MP-1 |
| S4 | C4 | 1, 2 | EXISTS | behavior-guide-suite S4; MP-1 |
| S5 | C5, C5f1, C5f2 | 7, 9, 16 | EXISTS | behavior-guide-suite S5; MP-1 |
| S6 | C6 | 2, 3, 15 | EXISTS | behavior-guide-suite S6; MP-1; D62-4 |
| S7 | C7 | 9, 13 | EXISTS | behavior-guide-suite S7; MP-1 |
| S8 | C8 | 2, 3 | EXISTS | behavior-guide-suite S8; MP-1 |
| S9 | C9 | 2, 17 | EXISTS | behavior-guide-suite S9; MP-1 |
| S10 | C10 | 4, 5, 6 | EXISTS | behavior-guide-suite S10; MP-1 |
| S11 | C11 | 3, 4 | EXISTS | behavior-guide-suite S11; MP-1 |
| S12 | C12 | 4, 10 | EXISTS | behavior-guide-suite S12; MP-1; D65-6 |
| S13 | C13 | 4, 12, 17 | EXISTS | behavior-guide-suite S13; MP-1 |
| S14 | C14 | 7, 12 | EXISTS | behavior-guide-suite S14; MP-1 |
| S15 | C15 | 9, 13 | EXISTS | behavior-guide-suite S15; MP-1 |
| S16 | C16 | 5, 6, 15 | EXISTS | behavior-guide-suite S16; MP-1; D62-2 |
| S17 | C17 | 2, 3 | EXISTS | behavior-guide-suite S17; MP-1 |
| S18 | C18 | 2, 3, 6 | EXISTS | behavior-guide-suite S18; MP-1 |
| S19 | C19 | 2, 3, 4 | EXISTS | behavior-guide-suite S19; MP-1; D62-5 |
| S20 | C20 | 5, 6, 7 | EXISTS | behavior-guide-suite S20; MP-1 |
| S21 | C21, C21f | 7, 9 | EXISTS | behavior-guide-suite S21; MP-1 |
| S22 | C22 | 2, 3 | EXISTS | behavior-guide-suite S22; MP-1 |
| S23 | C23 | 2, 7 | EXISTS | behavior-guide-suite S23; MP-1; MP-2 |

**What $0 does not prove.** The model's own words, and the judged outcome of each turn, are measured on a live run
(`evals/mirror/instinct-wa-batch1/results/`, scored with D-066's scorer). Code proves what code decides: the tools, the records,
the boundary, the artifacts and the links.

**Notes and open items.**

1. **C3 and the boundary line.** With production's File settings, C3's postings ride their list page ("Here it is, with Apply on
   it"). Without them, the reply says "Nothing was applied for", but with them it does not. The ask carried no "don't apply", so
   this is not asserted. It is flagged for the architect under P4 ("where confusion is possible").
2. **An iMessage typing indicator** is open until LoopMessage's typing API is verified against its documentation (P11).
