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
