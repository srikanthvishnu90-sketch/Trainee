# Beta failure map, 2026-11-04

This map covers the 4 live beta cases (C01-C04) and the 100 offline checks (A1.1-A25.4) from the interim beta evidence
report (release `03edad4`). Each case was replayed through the real career handler on trunk `3defbcf`, in two
account states, using `evals/career/beta-vs-instinct/`. Failures are grouped below by root cause, with counts and
file:line locations.

Reproduce (about 75 s, no paid call, no network):

```
TMPDIR=/tmp/bvi PGBIN=/opt/homebrew/opt/postgresql@16/bin deno run -A --no-check \
  --import-map=tests/flow/supabase-npm.json evals/career/beta-vs-instinct/run.ts --label <label>
deno run -A --no-check evals/career/beta-vs-instinct/opus.ts --results evals/career/beta-vs-instinct/results/<label>.json
```

How the run is set up: `handler-career.ts handleChat` runs on the flow harness's Postgres 16 with every migration, under
the committed release config (staged brain, release flags). The postings pool has 600 synthetic rows, including 14
Chicago customer-support roles, 6 remote support roles and 6 Chicago healthcare entry roles. The model is a scripted
stand-in served in-process, so no model call leaves the machine.


> **Baseline.** Recorded on trunk `3defbcf` (`results/trunk-3defbcf.*`, scorecards and full records). Earlier runs on `e6696cb` and `4158a1a` gave the same records. File:line references are as of `e6696cb`; #493 (the CPU fix, merged since) shifts `handler-career.ts` and `142-career-router.js` by up to about 130 lines, so search by the function name. **Scoring rule (review of #516):** on a staged-brain record, `not_generic` and `not_mentions` are unmeasured, so a brain record is never counted as delivered. This took A18.3 and A18.4 out of "delivered", in both states.

## Baseline (trunk `3defbcf`)

The full scorecards are `results/trunk-3defbcf.md` (task completion) and `results/trunk-3defbcf.opus.md` (quality).

| metric | empty account | seeded account |
|---|---|---|
| **Task completion, strict.** Every requested deliverable verifiably produced. | **22.1%** (23/104) | **18.3%** (19/104) |
| Failed at least one requested deliverable | 17 | 23 |
| Unverified: the staged brain answered, so the content can't be measured offline | 64 | 62 |
| Guards held: nothing sent, nothing written, profile unchanged | 104/104 | 104/104 |
| Answered by the router / code-first / staged brain | 32 / 8 / 64 | 34 / 8 / 62 |
| With the in-flight branches measured (see FUNDAMENTAL-ISSUES, last section) | MASS 32.7%, C04 26.0%, PREP 25.0%, CPU 22.1%, PRE 22.1% | 28.8%, 22.1%, 21.2%, 18.3%, 18.3% |
| **Quality vs Opus 5.5 reference.** Pairwise, Haiku judge, position-balanced, code-answered turns only: win / tie / loss | **0 / 1 / 39** of 40 | **1 / 0 / 41** of 42 |
| Not compared (scripted brain) | 64 | 62 |
| Turns that died on CPU (546) | 0 of 208 (local CPU at most about 800 ms; live C01 died at 2,142 ms) | |

C01-C04 against Instinct's control outputs (criteria met; Instinct's numbers come from the report's descriptions):

| case | Instinct | Trainee empty | Trainee seeded | what Trainee did |
|---|---|---|---|---|
| C01 three job links | 3/4 | 2/4 | 2/4 | `career_discovery` searched for "three realistic entry-level customer support send links do contact anyone" and found nothing |
| C02 retail to healthcare | 5/5 | 3/5 | 3/5 | `company_intel` for a company named "and" (at `03edad4` this went to `career_application_fields`) |
| C03 prep File | 6/7 | 4/7 | 4/7 | `prep_brief` template: 3 inline questions, no File, no plan |
| C04 $24/h counter | 7/7 | 4/7 | 4/7 | `negotiation_draft`: "Dear the firm team", asks for the $24 already offered, never says whether to counter |

Live C01 was not a routing failure but a CPU death (HTTP 546). On trunk the same input reaches the search and fails
there instead (RC1). Both failures are real and independent: fixing either one alone still leaves the person without
links.

## Root causes, ranked by records affected

Counts are failed records out of 208 (104 prompts × 2 states). One record can have several causes. A cause counted as
"unverified" means the staged brain took the turn, so offline it is a routing finding, not a quality verdict.

### RC1. The search parser leaves count, constraint and filler words in the role, and the search needs every word (9 failed + 3 garbled)

- `supabase/functions/_shared/posting_constraints.ts:81`: `ROLE_NOISE` has no count words (three, ten), no
  adjectives (realistic), no constraint verbs or objects (send, links, contact, anyone, do), and no "only", "current"
  or "postings". It does contain "not", "no" and "non", so negation is deleted from the role.
- `posting_constraints.ts:85-106` `searchTextOf`: only "apply" is stripped from a constraint clause (`:95`). Digits are
  thrown away instead of being read as a count (`:105`).
- `supabase/functions/_shared/career_search_judge.ts:293-297`: the live source runs a websearch `textSearch` that
  requires every lexeme, and the snapshot fallback (`:306-314`) adds one `ilike` per word. One junk word empties both.
- `career_search_judge.ts:448` writes "I found no posting for <polluted role>". `agent-chat/handler-career.ts:1117-1139`
  puts this in place of the router's reply.
- Affected: C01 (both states), A1.1 (both), A9.1 (both), A8.4 seeded, and A9.2 empty ("no posting for remote only").
  A9.4 passes but reads back "company does exist zzzsynthetic999".
- In flight, measured: no branch fixes it. The PRE snapshot makes C01 list 5 roles, but they are "Accounting
  Assistant … remote", so the relevance check fails (FUNDAMENTAL-ISSUES F59). PRE does not touch
  `posting_constraints.ts` or `career_search_judge.ts`.

### RC2. A template wins over the deliverable the person asked for (21 failed)

The router picks a family and serves that family's template. A count, a File, a timed plan, a draft or a direct answer
the person asked for is never parsed, so it is never produced.

- Prep: the brief branch of `packages/domain/142-career-router.js:5959` `handlePrepExtras` serves at most 3 questions
  (`:6227-6229`). The counted builder `handlePrepQuestionSet` (`:5770`, regex `:5816-5822`) only accepts "N interview
  questions" with a digit. `handlePrepQuestion` (`:5264-5276`) has no customer-support family in `INTERVIEW_FAMILIES`
  (`:5917-5954`), so it falls back to "Tell me about yourself" (`packages/domain/127-career-prep.js:405`).
  `handlePrepEve` (`:5588-5608`) fires on the word "tomorrow" and claims "sleep is a scored input" (`:5603`).
  Affected: C03, A15.1, A15.2 and A15.4, in both states (8).
- Negotiation: `142-career-router.js:7838-7855` in `handleNegotiation`. The company falls back to `"the firm"` (`:7841`).
  The ask is `parseOfferFigures(text)` of this turn (`:7839,7847`), so the offered $24 becomes the ask. The draft
  trigger (`:7798`) returns no "should you counter" answer. Affected: C04, both states (2).
- Networking draft: `supabase/functions/_shared/career_networking.ts:607`. With no contacts it answers "no one I can
  write to" rather than drafting with blanks or asking who it is for. A12.3 "No email should be sent" lands on the same
  handler. Affected: A12.1 and A12.3, both states (4).
- Explain-versus-do: `142-career-router.js:11370` `handleWatchManage` treats "How can I pause alerts?" as a pause
  command (A10.3). `:9387-9394` `handleTrackDigest` reports an empty record when asked what a digest is (A21.1). Both
  fail in both states (4).
- Seeded only: "Skip the first role" has no shortlist handler. `discovery.lastShortlist` is read only by ordinal apply
  phrases (`142-career-router.js:22142` in the bundle), so the reply shows one role (A1.3). "What do you remember about
  my job preferences?" reads back resume entry counts (`142-career-router.js:15558`), not the customer-support/Chicago
  preference (A18.1). (2)
- No deliverable override: `supabase/functions/agent-chat/career_staged.ts:221,282`. A File-page ask "stays a search,
  on code's path", and nothing reads "five", "one-page", "30-minute" or "for review" as a requirement.
- In flight, measured: `feat/prep-file-artifact` delivers C03, A15.1 and A15.2 (a File, 5 questions, a 30-minute plan;
  C03 7/7 against Instinct's 6/7). The `fix/draft-deliverables-c04` snapshot delivers C04 ("Yes, counter once, in
  writing, at $26 an hour"), plus A7.1, A7.3 and A12.2. The PRE snapshot moves C03, C04 and A15.1 to the brain, which
  would undo both if merged first. Still open on every branch: A15.4, A12.1, A12.3, A10.3, A21.1, A1.3 and A18.1.

### RC3. Bag-of-words matchers: negation and question shape are not read (10 failed + live C02)

- `142-career-router.js:14007`: any "?" or "what" sends the turn into `handleIntel`. Then `companyFromText`
  (`:4643-4644`) mints the company "and" from "look at and", because the negated "contact anyone" passes its
  people-context test (C02 on trunk). `:6638` takes any capitalised word after "on" as a company ("Telegram has no
  company file", A20.2). The reply is built at `:6727`.
- `142-career-router.js:12232` `routeFamily`: `career_application_fields` is matched by apply/form + ask/need +
  what/which, all as plain word presence. This was live C02's route at `03edad4`. The same line is still on trunk.
- `142-career-router.js:4413` `handleRefusal`: "Do not invent SQL experience" is read as a request to fabricate, and the
  reply serves an outreach refusal about shortlists and verified emails (`:4463,4466`). A6.2, both states.
- `packages/domain/120-career-access.js:461`: "cloud browser" goes to `connect_browser_source`, which defaults to
  LinkedIn (`:361`). A4.2, both states.
- `142-career-router.js:3171` `handleErasePath`: "Explain how to delete my data without doing it" arms the erase
  confirmation (A22.4). It passes this benchmark's guards because nothing is deleted until "yes, erase it", but the
  person asked for an explanation.
- `142-career-router.js:13435` and `:9477`: any "portal … account" is read as a create-account ask, and the reply says
  Trainee creates the login on a card confirm. A3.3 and A23.4, seeded (2).
- Negation handling exists only for sponsorship facts (`142-career-router.js:10418,15051`) and the File-page hand-off
  (`career_staged.ts:216-232`).
- In flight: `fix/router-constraint-deliverable-prepass` is the right place for this. Its pre-pass must cover at least
  `:12232`, `:4413`, `:4643` and `:6638`, or they survive.

### RC4. The wrong target is bound (5 failed)

- `142-career-router.js:1186` `handlePacket`: the descriptor defaults to `"backend"`, so "Prepare this Greenhouse
  application" with a support list on record answers "no backend role in the current list" (A3.1 seeded).
- `142-career-router.js:13724-13728` dispatches tailoring through `handleDiscovery`, and neither `discoveryFamilies` nor
  `askRoleFamilies` (`142-career-router.js:481-489`, `packages/domain/121-career-jobs.js:88-127`) has a
  customer-support family. "Tailor my resume for customer support" therefore tailored for "Software Engineer Intern at
  Synthco 232" (A6.1 seeded). The empty account has no resume, and its reply does not say so plainly (A6.1 empty).
- Offer parsing: `supabase/functions/_shared/career_offer.ts:104-110`. `ROLE_WORDS` has no "support" or "specialist",
  so the title in the sentence is re-asked. `:157` turns $24/hour into $49,920 a year, and
  `career_offer_chat.ts:58-63` reads it back that way. These are the seed turns, recorded in every seeded record's
  `setup`.

### RC5. No File path for most turns (4 failed + 126 brain turns with no File tool)

- `supabase/functions/agent-chat/career_brain.ts:142`: `create_file` is added only when `o.shape && o.files`, and
  `attach_document` only on `attachAsked`. `shape` is `replyWriterOn && telegram` (`handler-career.ts:1072`), and
  `CAREER_REPLY_WRITER` is in `RELEASE_NEVER_ON` (`agent-chat/release_config.ts:149-155`). The benchmark observed **0 of
  126 brain turns offered a File tool**.
- The router's prep builders never mint a File (RC2). Only tailoring (`career_document_delivery`) and the search
  results page attach a document.
- Affected: C03 and A15.1 in both states. A6.1 and A6.4 seeded pass, because the tailored PDF does attach.
- In flight, measured: `feat/prep-file-artifact` mints the prep File (it needs `TRAINEE_FILE_BASE_URL` and
  `TRAINEE_FILE_LINK_SECRET`; the harness sets test values for them). The brain still has no File tool at release.

### RC6. Most asks are not handled by code, and the staged brain gets them (126 of 208 records unverified; MASS moves 22 of them to code)

- `career_staged.ts:36-45` hands over `career_catchall` (76 records), `unclaimed` (40, the containment null result),
  and also `company_intel`, `negotiation_advice`, `outreach_clarification` and `career_resume_guidance`. That is every
  A2 approval, A7 written-answer, A13 warm-intro, A20 channel, A23 portal-code and A24 apply-by-email prompt.
- At `03edad4` with no model key, these were the "I'm Trainee, a career agent" containment text (44 of 100 offline
  checks; `packages/domain/140-career-reply.js:129`, `143-career-containment.js:154`) or the catchall
  (`142-career-router.js:3508`).
- With a key, the brain answers, but its tools are withheld: `queue_applications`, `set_job_alerts`, `stop_job_alerts`
  and `verify_contacts` (`career_staged.ts:296`). Nor does it have any approve, pending-approvals, batch, export or
  File tool (observed tool list in `results/trunk-3defbcf.json`). So "show my pending approvals", "approve the second
  application", "how do I export my data" and "draft an application email" have **no code path that can complete
  them**, whoever answers.
- Offline this can't be scored for quality. The Opus arm compares only code-answered turns.

### RC7. CPU: three router runs and a 600-row pool per turn, with no budget (live C01: 546)

- Three runs of the 3.0 MB router bundle per router turn: the staged probe (`career_staged.ts:271`, a deep copy), the
  pool-need probe (`career_pool_need.ts:23-30`, another deep copy), then the real run (`handler-career.ts:1114`). The
  benchmark trace confirms 3 runs on 65 records.
- The pool: `_shared/career_pool.js:58` `DEFAULT_LIMIT = 600`. `loadPool` (`:135-156`) maps every row synchronously
  (`stripHtml`, `roleFamily`, `seniorityBand`, `:89-119`).
- There is no CPU or time guard in `handler-career.ts`, `career_host.js` or `career_pool.js`. A `timeout` fallback text
  exists, but nothing triggers it.
- Locally C01 is among the heaviest turns (428-790 ms CPU across runs, about 290 ms of it in router runs). Live, the same turn hit 2,142 ms. The
  difference is the cold edge isolate plus remote I/O, and it remains unproven.
- In flight, measured: `fix/c01-agent-chat-cpu-budget` brings local C01 CPU to 281/126 ms (empty/seeded), against
  428-790 ms on trunk (local CPU is noisy). It changes no deliverable. It still makes 3 router runs per turn.

### RC8. Read-only turns still write (no user-visible failure; 208 of 208 turns)

- `supabase/migrations/20261026090009_career_account_memory.sql:97-111` `career_host_commit` writes on every turn. It
  bumps `career:account` version, revises `agent_flow_state`, inserts two messages and inserts a `career:turn` receipt.
  A concurrent turn holding the older version gets `revision_conflict` (`:46`).
- The benchmark's `no_write` guard ignores this bookkeeping (`score.ts IGNORE_WRITE`). The table-level count of
  `career_watch_kv` was a false positive in the earlier draft of this harness and is fixed.

## Not reproduced offline

- **C01's CPU death.** No local turn exceeds about 900 ms. Stage timing needs the live isolate; `fix/c01-agent-chat-cpu-budget`
  adds `turn_clock.ts` for this.
- **The model warning.** `_shared/model_gateway.ts:32-41` warns "MODEL_PROVIDER=openai is ignored … using
  claude-haiku-5-5" for `modelConfig()` callers (people provider, model health). The career brain uses
  `release_model.ts:22-34` `careerModel`, which serves Sonnet 5.5 when production sets `CAREER_REPLY_MODEL`. The warning
  names the wrong model for the brain; nothing was substituted.
- **Brain reply quality** for the 126 brain turns. It needs a live-model run (S3), which this benchmark never makes.

## Scoring notes

- Deterministic first. Every judge criterion has a coarse regex proxy in `cases.json` (`det`, `det_not`, `det_min`,
  `det_all`, `det_words_max`). `--judge` replaces the proxy with Claude Haiku through the Claude CLI on the owner's
  subscription, quote-checked.
- The Opus arm (`opus.ts`) writes references with `claude -p --model opus` and judges pairwise with Haiku, both through
  the CLI with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed. It checks `apiKeySource: none` before the first
  call. References and verdicts are cached in the repo (`opus-refs.json`, `pairwise-cache.json`), so a rerun of an
  unchanged reply is free.
- C01's exact live text is not in the report. Its input is reconstructed from the title and the C02 safety framing.
