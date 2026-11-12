# Mirror rulings: what makes Trainee answer like Instinct on any scenario

Architect, 2026-11-11, under the owner's instruction: "Think about what rulings would allow Trainee to be the same as
instinct, so let's say it's 1000 scenarios. Those 1000 would be identical, even 10K or 1M scenarios. Still holding the exact
same similarity. Then take those rulings and apply them, specifics as well as grand process." Recorded as D-061.

## What "identical at a million scenarios" can mean

Two language-model products never produce the same characters twice; Instinct does not even repeat itself. What can hold at
any scale is that every reply passes the same checks Instinct's reply passes. So similarity is defined per turn, on any
scenario, as all of:

1. **Same task done**: the same deliverable (answer, draft, File, PDF, re-check, recall) with the same external effects (none,
   unless the person approved that exact one).
2. **Same process**: the same kinds of steps, in order: read what is needed, verify what is claimed, produce, state the
   boundary. Measured on the tool trace, not the prose.
3. **Same shape**: answer first; the reply kind's length (±10% of Instinct's for the same kind); one topic per message when
   the reply has several sourced parts; links on their own line.
4. **Same honesty**: every claim carries its source tier; unverified things are said to be unverified; corrections are made
   out loud.
5. **Same voice**: plain, specific, opinionated when asked, blunt when asked, no filler, no internal words.

A benchmark of 26 turns cannot prove this. The rulings below are written as general rules, each traced to the turns that
showed it, and are measured on held-out scenarios Trainee was never tuned on (part B, P2).

## A. Behaviour rulings (what Trainee does on every turn)

| # | Ruling | Shown by |
|---|---|---|
| G1 | **The model decides; code guards.** Code answers on its own only (a) exact payload intents (an approval of a shown card, stop/pause, account controls) and (b) a reply that is a bare answer to a question code just asked. Every other message goes to the brain, with what code found (search results, records, profile facts) passed as data. Code never answers a request by matching words to a canned flow. | Batch 1: 18 of 26 turns answered by code, most with the wrong task (quiz → "tell me about yourself"; Citadel research → a coding question; a hypothetical offer saved). |
| G2 | **Answer first, then evidence, then at most one next step.** No preamble. The first sentence answers the question as asked. | Every Instinct turn. |
| G3 | **Length by kind**: draft 150–360 characters (casual or "shorter" under 200); practice question 200–300; recall one or two sentences; answer 300–500; research or "everything" long, split by topic. | instinct.jsonl lengths; D-058. |
| G4 | **Source tier on every claim**: official or live-checked ("Citadel's posting lists…"), the person's own record ("per your resume", "you told me"), anecdotal ("anonymous accounts describe… anecdotes, not proof"), or my judgement ("I'd lean…"). A figure with no source is not given. | C4, C8, C9, C22. |
| G5 | **Say what was not verified**, in the same sentence as the claim it limits. | C1, C11, C19, C22. |
| G6 | **Restate the boundary** whenever the person set one ("don't send", "don't apply") or the turn touches an external effect: "Nothing was sent." / "Nothing was submitted." | C2, C10, C11, C12, C18, C19. |
| G7 | **The thread is memory.** Anything shown earlier in the conversation (a draft, a posting, research and its source, a File) is referred to by name and reused; never asked for again. | C14, C18, C20, C23. |
| G8 | **Hypotheticals never touch the record.** "Hypothetically…", "say I'm…", "if I had…" are answered for that situation; nothing is saved and the real profile is not used unless asked. | C7, C15. |
| G9 | **Correct earlier mistakes out loud**, in the next reply that touches the subject, naming what changed. | C16 correcting C6. |
| G10 | **Do the work before asking.** Produce the draft, plan or answer with clear placeholders; ask only for what an external effect needs, at the moment it is needed. | C2 (D-059), C10, C11. |
| G11 | **A file ask gets the file**, in the chat, labelled as a review draft with the open data flags. | C10, C20. |
| G12 | **Practice sessions run like an interviewer**: one question at a time, approach before code, review the actual answer (catch the real bug), push with a harder follow-up; critique bluntly when asked. | C5, C21. |
| G13 | **Several messages while work runs**: answer each; related asks may share one deliverable, and the reply says it covers both. | C1 + C3. |
| G14 | **Capability parity**: when Instinct reads an outside source for a turn, Trainee needs a read of the same kind (web, job boards including Workday, the person's email, a tracker, public people search). Each is an owner decision (part C). Without it, the reply says plainly what it could not check, never a guess. | C1, C3, C6, C9, C16, C18, C19, C22. |

Every existing safety rule still holds (CLAUDE.md): no submit or send without a yes to the exact payload, facts only from
what the person confirmed or a cited source, no passwords in chat, no LinkedIn or Indeed automation.

## B. Process rulings (how Trainee is built and measured to stay like Instinct)

| # | Ruling |
|---|---|
| P1 | **The reference transcript is the spec.** Capture it verbatim (personal data kept out of the repo), with timing and every message of multi-message replies. |
| P2 | **Generalisation is measured on held-out scenarios.** Batch 1 is the dev set. A held-out set is generated per ruling family (paraphrase, persona swap, reordering, typos, other languages, several asks at once, hypotheticals, follow-ups across long gaps) and is never used to tune. A fix counts only if the held-out score does not drop. |
| P3 | **Fix by ruling, never by prompt.** Every fix names the G-ruling it serves. No regular expression or prompt text keyed to a benchmark prompt's wording. A new router rule must pass the 1,000-prompt mirror set with no regressions. |
| P4 | **Backtests run under production's configuration.** The release flags exactly as `release_config.ts` ships them; no test-only switch on or off (owner, 2026-11-11). |
| P5 | **Score text and process.** Each turn is scored on the five similarity checks above; the process check reads the tool trace. |
| P6 | **$0 first, then live.** Every ruling has a $0 test through the real handler with a scripted model; live runs measure only what the model itself decides, within the owner's approved spend (D-060: $10 for this effort). |
| P7 | **Ratchet.** A turn or held-out case that passes is added to CI and may not regress. |

## C. Owner decisions that the rulings need (G14)

| Capability | Turns in batch 1 | Status |
|---|---|---|
| Web research with sources | C9, C18, C22, C23 | Approved 2026-11-11 (D-060). |
| Public job boards including Workday | C1, C3, C10, C18, C20 | Not approved. |
| The person's email, read-only, for application confirmations | C6, C16 | Not approved. |
| A tracker the person can open (Sheet or File) | C16 | Not approved. |
| Public people search by web excerpts (no LinkedIn automation) | C19 | Not approved. |

Without these the ceiling on batch 1 is 18 or 19 of 26, and the same share of any larger set that needs them.

## D. Applied in product code (2026-11-11, D-061 stage 1 to 3)

Each change names its ruling in a code comment (P3); none is keyed to a benchmark or held-out prompt's wording. Tuned on the
dev split only (5%, 50 conversations); measured on the sealed held-out split (95%, seal `e72a2505…`) with
`evals/mirror/heldout/run.ts` at $0 under production's release flags (P4).

| Ruling | What changed | Where |
|---|---|---|
| G1 | The router's reading is data for the brain, not the answer, unless the turn is code's to answer alone: payload intents and approvals, a bare answer or a running session, the account's controls, refusals, an action the person asked for and did not forbid, a read of their own record, a File code built for the ask (`g1CodeAnswers`). A practice-session start, a draft code would write from words, a thread recall, a search run on a plan ask, a prep File built for a different request, and (web research on) a firm's company file go to the brain with code's answer as data. A boundary phrase inside an ask is not a stop (`career_host.js` `stopControlOf`). | `agent-chat/career_staged.ts`, `_shared/career_host.js`, `agent-chat/handler-career.ts` |
| G6 | One boundary reader (`boundaryOf`); the brain is told to restate it (`boundaryNote`); a code turn that moved nothing carries "Nothing was sent." / "Nothing was submitted." when its reply does not already say so. A "draft ..., don't send" ask is the brain's draft, not code's send-ready batch. | `_shared/agent/turn_notes.ts`, `agent-chat/handler-career.ts` |
| G8 | Hypotheticals read by grammar: someone else's situation, texting spellings, eight languages; on one, code's offer, record and networking flows stand down and the brain gets no record writer. | `_shared/agent/turn_notes.ts`, `agent-chat/handler-career.ts`, `agent-chat/career_staged.ts` |
| G9, G13 | A correction of Trainee and several asks (`severalAsks`, wider than D-058's `multiAsk`) are the brain's, with a turn note each. | `_shared/agent/turn_notes.ts`, `_shared/ask_language.ts`, `agent-chat/career_brain.ts` |
| G11 | `create_file` is offered on every channel, not only with the reply writer on; where File links are not set up the File service refuses and the brain says so. `CAREER_REPLY_WRITER` stays in `RELEASE_NEVER_ON`. Benchmark C1 moved to EXISTS. | `agent-chat/career_brain.ts`, `agent-chat/handler-career.ts` |
| G2 to G14 | The brain's instructions state every check (`MIRROR_RULES`); the empty tracker's reply answers first and names its source. | `_shared/agent/prompt.ts`, `packages/domain/142-career-router.js` |
| G5 | The empty tracker says, in the answer's own sentence, that applications sent on one's own are not checked; the router's empty search names what it read and that career sites outside it were not checked. D-064 (G5 over G3): the judged search's empty form carries "Other career sites were not checked." after "no open roles". | `packages/domain/142-career-router.js` |

Held-out, $0, trunk `6aee3c4d` against this branch (pass / scored, "model" turns excluded as the README explains):

| | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | G10 | G11 | G12 | G13 | G14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trunk | 73.3% | 97.9% | 38.3% | 84.0% | 0.9% | 57.2% | 100% | 71.8% | 0.0% | 97.3% | 36.4% | 100% | 0.0% | 76.2% |
| D-061 applied | 93.9% | 98.8% | 48.0% | 93.3% | 16.0% | 92.9% | 100% | 100% | 0.0% | 100% | 86.3% | 100% | 0.0% | 93.9% |
| D-064 applied | 93.9% | 98.8% | 48.0% | 93.3% | 80.7% | 92.9% | 100% | 100% | 0.0% | 100% | 86.3% | 100% | 0.0% | 94.5% |

The text rulings (G2 to G5, G7, G9, G10, G12) are scored at $0 only on the turns code still answers; the brain's words are the
live hook's to score (`live.ts`, not run). G9 stays at 0% on the 1 turn code still answers. G13's 19 are second messages texted seconds after the first (`rapid`): the
$0 harness sends turns back to back and records the gap without waiting it, so no message-level reader can tell them apart
without also catching every quick follow-up. D-064 builds that signal in the handler (a turn that waited on the person's previous turn
is the brain's second ask; `tests/architect/d064-while-working-20261111.test.ts`); the live hook measures it.
