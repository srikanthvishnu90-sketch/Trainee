# Situation-knowledge rubric (0-5)

Owner requirement (2026-10-28): the chat must understand any situation (year in school, major, resume, experience, constraints, location, visa,
goals, confidence, and the rest) and write a compelling, specific answer, not generic advice. Example: a college freshman asking how to get
internships at smaller firms and startups gets concrete, truthful, personalized steps: where to look, how to approach small firms, what to build,
timing, the cold-email and referral approach, and what to say.

Fixtures: `situations.json` (130 synthetic people and asks; 21 are "deep", hand-checked). Each has the confirmed facts the Person Context Pack is
built from, any standing instructions, earlier turns, the message, the playbooks that must be picked, and the checks below.
No real person, company or posting appears in a fixture.

## Three things are measured, in order of cost

1. **Retrieval (free, offline, run on every PR).** `deno run -A evals/career/situations/situation-knowledge.ts`. For every situation the pack is
   built and 1 to 3 playbooks are chosen; every `expect_playbooks` id must be among them and no `none_of` id may be. Reports the share of situations
   that pass and the situations that pick none.
2. **Reply checks (deterministic, no model judge).** `--replay replies.json` scores recorded replies; `--brain agent --arm knowledge|baseline` collects them
   (needs `OPENAI_API_KEY`; the model is the only spend). Dimensions, each `5 x passed / (passed + failed)`:

| Dimension | 5 (flawless) | What is checked |
|---|---|---|
| **specific** | Names this person's own facts and covers the substance their situation needs | each `must_use` group (their stated facts) and `must_cover` group (the method concepts) appears |
| **truthful** | Nothing invented | no pay or percent figure, date, company, program or proper name that nobody gave; no "I sent / applied"; none of the situation's `forbid` claims (hard) |
| **actionable** | A plan they can start | two or more steps (or a three-sentence plan); a time anchor (this week, today, first, next step) |
| **question** | At most one, never one the facts answer | at most one question to the person; none of the situation's `must_not_ask` patterns (hard) |
| **natural** | Plain, text-message prose | no canned filler ("best of luck", "reach out to your network", "leverage your"), no internal words or leaked tokens, 25 to 380 words, no echo opener, no repeated words |

A **hard** check is a trust break; one failure caps its dimension at 2.0. A situation is *clean* only when no check fails. The exit code is 0 only when
every scored situation is clean and none is missing a reply.
3. **Model judge (paid, later).** `--emit-judge batch.json` writes one judge request per reply from `judge-prompt.md` (no call is made). Run it with two
   different OpenAI models; an item passes only when both pass (the existing two-judge rule). The judge reads for what code cannot: is this the answer a
   sharp mentor would give *this* person, is the realistic read of their odds right, is anything misleading.

## What this does not tell you

- Passing the deterministic floor proves nothing was caught, not that the answer is excellent. Read the 10 best and 10 worst by hand every run.
- Retrieval was tuned against these 130 situations: the live bot's own transcripts (below) are the held-out set.
- Whether the playbooks' advice is *right* for a real employer is not testable offline; that is why they name none.

## Live measurement (when the owner turns the flag on)

With `CAREER_KNOWLEDGE=on` each agent turn's response meta carries `knowledge: { playbooks, unknown, stage }`. Pull a week of live threads, then:
(a) share of advice turns that picked a playbook and share that picked none (gap list = the none-picked messages, which become new playbooks);
(b) replay the recorded replies through `--replay` for the five dimensions; (c) A/B the same prompts `--arm baseline` vs `--arm knowledge`;
(d) outcome signals per person: replies per 100 emails sent from a drafted note, interviews per 100 applications, and whether the person came back.
