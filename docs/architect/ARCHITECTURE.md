# Trainee — architecture (the one design)

Owner: the architect (Claude). Changed only by the architect, through a commit on `trunk` that names the reason.
Codex builds from work orders in `docs/architect/work-orders/`; it never edits this file.
Owner rulings live in `DECISIONS.md`. Everything under `docs/` older than 2026-10-18 is archive (see "Archive" below).

## 1. What we are building

A career agent that takes a job seeker from "I need a job" to a signed offer, mostly over text:
it learns who they are, finds the right openings the minute they post, writes truthful tailored
applications, applies at volume with one approval per batch, preps them, tracks everything, and
tells them plainly where they stand. Goal: measurable outcomes (interviews, offers) for millions
of people, not a demo.

Users: any job seeker. First cohort: see D-004.

## 2. How we measure (the only numbers that count)

| Metric | Definition | Source |
|---|---|---|
| **Outcome rate** | interviews and offers per active user per 30 days | tracker rows the user confirmed or the inbox proved |
| **Applications submitted** | applications that reached the employer, proven by the employer's confirmation | apply worker receipts |
| **Answer quality** | pass rate on the eval set (`evals/career/`) graded by the rubric judge, plus a weekly human-read sample of 30 real transcripts | eval runner |
| **Fallback rate (live)** | share of live turns where the agent did not do what was asked | live transcripts |
| **Cost per active user per month** | model + browser + data spend / active users | provider bills |

Corpus pass rates written by the builders are not product metrics. A number without real users behind it is labeled as such.

## 3. System

Every channel goes through one conversation interface (`_shared/conversation.ts`, WO-004): a contact texts, the
person is found or created, the brain answers, the reply is split into bubbles; agent-initiated messages (alerts,
reports, nudges) are queued per person and delivered through the same path. The text simulator drives this
interface from a terminal, so every capability is built and tested exactly as it will be texted. The real channel
(LoopMessage, D-009) is a thin adapter built last.

```
 Channels: iMessage/SMS (agent-message-*), web app (src/ -> index.html)
        │
        ▼
 agent-chat (career)  ── auth, rate limit, thread, load state ──┐
        │                                                        │
        ▼                                                        │
 BRAIN: agent loop (_shared/agent/loop.ts)                       │
   model (gateway, OpenAI) decides what to do                    │
   tools (_shared/agent/career_tools.ts) do it                   │
   policy at the tool boundary enforces the rules                │
        │                                                        │
        ▼                                                        ▼
 TOOLS wrap the domain modules (packages/domain/12x–15x)     STATE (Supabase)
   profile + fact bank (122, 146)                              profile/facts, applications,
   jobs: search, rank, explain (121, 131)                      postings, watches, approvals,
   tailor + render resume/cover letter (123, 148, 154)         thread history
   tracker (126)          prep banks + scoring (127)
   outreach drafts (124)  negotiation math (128)
        │
        ▼
 WORKERS (cloud, scheduled, never on a laptop)
   job ingestion: ATS boards -> postings table (121 fetchers)
   alerts + daily report: rank new postings per user -> message
   apply worker: hosted browser drives approved applications (149/150/155)
```

### 3.1 The brain: the model decides, code enforces
- Every turn runs `runAgentTurn` (WO-002): the model reads the conversation and the user's
  state, calls tools, and writes the reply. There is no regex intent router on this path.
  `142-career-router.js` is retired once the agent brain passes the eval bar (WO-002 flag, then
  removal).
- **Truth comes from data, not from the model.** Facts about the user come only from their
  confirmed fact bank; facts about a job only from the posting; facts about a company only from
  a sourced record. Tools return data; the model explains it. The system prompt says so and the
  eval checks it.
- **Policy lives at the tool boundary, in code.** Each tool declares an effect:
  - `read` — runs freely.
  - `write_own` — changes only this user's own state; runs freely; reversible.
  - `external` — touches the world (send an email, submit an application, message a person).
    Never runs inside the loop. It becomes a pending approval with an exact preview; it runs only
    after the user approves that exact payload (hash-bound), under daily caps.
- No canned prose. The only fixed strings are the safety and failure sentences: in `loop.ts`; the research failure lines in `_shared/research_reply.ts` (`NO_SOURCES`, `NOT_CONFIRMED`, `UNSUPPORTED`, said when no source could be opened or none supports an answer); and the company research blocker line in `agent/research/company.ts` (`enforceCompanyReply`: "I couldn't do this research: ... Nothing was applied for or sent.").

### 3.2 Jobs
- Ingestion is a scheduled cloud job that polls public ATS boards (Greenhouse, Lever, Ashby,
  SmartRecruiters; Workday later) into a `postings` table, de-duplicated, with first-seen time.
- Coverage grows by data (more boards), not code. A paid aggregator API is optional (D-003).
- Per user: rank new postings against the profile, send alerts for strong matches within minutes,
  and a daily/weekly report with reasons and links.

### 3.3 Applying at volume
- Targeted volume: many tailored applications a day, approved per batch from one card, capped
  per user/day and per company. Never LinkedIn or Indeed automation. No captcha solving (the
  user finishes a captcha themselves).
- An application counts as submitted only with the employer's confirmation (page or email).
- Answers on forms come only from the user's confirmed facts. Never invent an answer, ever.

### 3.4 Training
- Mock interviews run by the model, grounded in the question banks (`packages/career-data/`),
  graded against the bank's answer keys; weak spots recorded and drilled.

## 4. What stays, what goes

| Keep (as tools/data) | Retire |
|---|---|
| 121 jobs fetchers, 122 profile/facts, 123 tailor truth audit, 124 outreach, 126 tracker, 127 prep banks, 128 negotiation math, 131 discover, 133 packets, 146 intake, 148 render, 149/150/155 apply drivers, 151 alert watch, career-data banks and company records | 142 router, 143 containment, 141 doorstep prose, the governance registers, all finance modules and finance edge functions (WO later) |

## 5. Roadmap (milestones; each ends in a demo the owner runs himself)

| M | Outcome the owner can try | Work orders |
|---|---|---|
| M0 | One trunk, green CI, Codex working from orders | WO-001 |
| M1 | In the text simulator, text the agent anything career-related and get a real, specific answer; approve by replying yes (AI brain, eval ≥ bar) | WO-002..005 |
| M2 | Real jobs: new postings from 500+ boards land in minutes; daily report and instant alerts by text | WO-005.. |
| M3 | Resume and cover letter tailored per job from confirmed facts, PDF out | |
| M4 | Batch apply: approve 10 tailored applications in one tap; proven submissions on Greenhouse/Lever/Ashby | |
| M5 | Training: mock interviews graded, weak spots drilled | |
| M6 | Real texting over LoopMessage (then SMS), the Trainee web app, 10 then 100 real users; outcome rate measured | WO-011..014 |

## 6. Archive
`docs/bug-ledger.md`, `docs/career/forbidden-rules.md`, `docs/instinct-spec-series/BUILD-STATUS.md`,
the merge records, gauntlet ledgers and MI/FR/BUG registries are frozen as of 2026-10-18. Nobody
writes to them. A rule that still matters becomes a test.
