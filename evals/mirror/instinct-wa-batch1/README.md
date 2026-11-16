# Instinct WhatsApp benchmark, batch 1: the standard Trainee is held to

**Source.** The owner's real run of Instinct over WhatsApp, on his own linked account, 2026-11-10, 11:08 PM to 11:45 PM CT:
23 career scenarios (26 messages with the follow-ups), the replies Instinct sent, and their latencies. The owner wrote the
prompts for the evaluation, in his own texting style. Nothing in it was simulated.

**What is in the repository, and what is not.** The repository is public, so the files here carry **fictional names** in place
of every personal detail: the tester (Sam Rivera), the school (Lakeshore University), his companies and roles, the employers in
his past applications, and the tester's own startup (Waypoint, so it is never confused with Trainee). Public companies and
public pages (PayPal, Google, Citadel, its interview guide, levels.fyi) are kept as they were. Two of Instinct's replies are
redacted outright: the Google Sheet link (it carried an email address) and the three alumni leads in C19 (real people's names and
profile links). The verbatim transcript stays with the owner.

| File | What it is |
|---|---|
| `prompts.jsonl` | The 26 messages in the order sent: `{id, sent_at_ct, gap_s, prompt, task, needs?}`. `needs` marks a turn Instinct answered from something Trainee does not have here (`gmail`, `gmail+sheets`, `web`). |
| `instinct.jsonl` | Instinct's replies per turn, every message of a multi-message reply in order, and the latency. C1 and C3 were answered by one merged reply and one File. |
| `persona.json` | What Instinct knew about the tester, as three unscored setup turns: the resume pasted, "yes, that's my resume", and the corrections he had told it (the outdated GPA, the conflicting dates, the uncertain company name). Gmail and Sheets were not seeded before D-065. |
| `world.ts` | D-065: the runner's test world, like Instinct's: the recorded PayPal Workday posting and the recorded remote NVIDIA posting on the board (served from `tests/fixtures/posting-reads/`), a stub Gmail with the persona's fictional application confirmations, and on live runs only the research reader's public GETs. Everything else is refused and recorded. |
| `rubric.json` | The 10/10 standard: per scenario the yes/no elements (MUST for a 10, NICE for depth; groups acts, specifics, depth, honesty, form), the cross-scenario standard and the grading rule. Instinct is 6/10 on every turn (owner's ruling). An element's `check` is what code decides from the reply and tool trace; the rest goes to a judge. |
| `results/` | The live runs: Trainee's transcript and the score of each turn against Instinct's. |

**Limits the benchmark states (from the owner's write-up).** One account with its full history: this is one user with context,
not 1,000 fresh users. Applying, batch applying and outreach were tested only to the preparation boundary. The tracker sheet was
checked directly; the two resume PDFs were delivered but their contents were not inspected. One factual error was observed and
later self-corrected by Instinct (C6, corrected in C16). The WhatsApp session logged out after C23.

## Running it

At $0, the real handler with a scripted model (what code decides, not what the model says):

```
CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/mirror-wa-batch1-handler.test.ts
CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/run-conversation.ts --dry-run \
  --conv evals/mirror/instinct-wa-batch1/prompts.jsonl --persona evals/mirror/instinct-wa-batch1/persona.json
```

With the real model: a push to `ci/mirror-conversation` runs `.github/workflows/mirror-conversation.yml` on the request in
`evals/mirror/run-request.json` (approval `D-057`, at most $3 in total, reserved at the shared $70 ledger first).

## Grading against the 10/10 rubric

`evals/mirror/score-rubric.ts` grades a transcript (run-conversation.ts's output, or `instinct.jsonl`) element by element:

```
# $0, code checks only (judge elements count as "unjudged", which is no):
deno run -A --no-check evals/mirror/score-rubric.ts --transcript <trainee.jsonl> [--json out.json] [--only C1,C18]
# with the judge, on the owner's Claude subscription only (needs evals/subscription/claude_cli.ts, PR #853):
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN deno run -A --no-check evals/mirror/score-rubric.ts \
  --transcript <trainee.jsonl> --judge subscription [--model claude-sonnet-5-5] [--hand <{id: score}.json>]
```

- Code first: a tool ran with the required inputs and no call error, a File or posting link was delivered, the prose is under
  the element's length, a date is present, "not sent" is stated, nothing was queued or sent, no claim of an act the trace does
  not prove. A failed check is a no and never reaches the judge; a check marked `judge: true` that passes goes on to the judge.
- The judge gets one call per turn and answers yes or no per element, quoting the reply (or its File or document text). A yes
  whose quote is not found there is a no. It refuses to start while `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set.
- Score per turn = 10 x MUST met / MUST total, capped at 8 unless at least half the NICEs are met. The output lists every
  element with its evidence and ends with a table against Instinct's 6. Tests: `tests/architect/mirror-rubric-grader-20261116.test.ts`.
