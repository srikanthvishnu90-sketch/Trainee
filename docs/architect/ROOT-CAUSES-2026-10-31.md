# Root causes of poor reply quality: status on trunk, 2026-10-31

Trunk at `5d6857219` (merge of #348). Earlier audits named five architectural root causes. For each: does it still hold,
with file:line evidence and counts. Counts are from greps on this commit; the commands are given so they can be re-run.

| # | Root cause | Holds on trunk? | One-line evidence |
|---|---|---|---|
| 1 | Several reply brains in a hand-ordered chain | **Yes** | 27 code-first turns, then router or brain, then 2 judges, a rewriter and a writer, in one 1,216-line handler |
| 2 | Many separate apply paths | **Yes** | 8 SQL paths put a row in `career_apply_jobs` (13 functions), reached from 8 chat turns, the batch intent and the brain |
| 3 | Memory and contacts kept per thread, not per person | **Partly; this PR fixes it for everyone on a texting channel** | profile and tracker were per thread unless `CAREER_ACCOUNT_MEMORY=on` (default off; live "Y-off") |
| 4 | Many hard-coded reply strings | **Yes** | about 1,800 sentence literals in the router, about 300 in `_shared/career_*.ts`, 61 exported `*_REPLY` constants |
| 5 | Tests assert wording, not outcomes | **Yes, mostly** | 810 regex-on-reply lines in 120 of 403 architect test files; 128 exact reply equalities |

## 1. Several reply brains in a hand-ordered chain: still holds

- `supabase/functions/agent-chat/handler-career.ts` (1,216 lines) runs, in source order, **27 code-first turns** before
  any brain: `connectorChatTurn` (461), `siteRefusedTurn` (468), `outlookChatTurn` (473), `cardTurn` (478), `mockTurn`
  (483), `questionsTurn` (494), `confirmWhichTurn` (507), `emailTurn` (525), `outreachTurn` (542), `repliesTurn` (561),
  `cloudTurn` (569), `cloudCardYesTurn` (575), `paceTurn` (588), `screenTapTurn` (603), `screenAnswerTurn` (617),
  `employerAnswerTurn` (628), `billingTurn` (647), `cancelTurn` (653), `applyHereTurn` (660), `applyTurn` (667),
  `receiptTurn` (687), `followupTurn` (700), `standingTurn` (714), `applicationsTurn` (717), `networkingTurn` (729),
  `offerChatTurn` (757), `outreachStatusTurn` (766). The first that claims the message answers; order is the only
  arbiter.
- Then one of two brains: the agent brain only if `AGENT_BRAIN_RELEASED && chooseBrain(env) === "agent"` or the staged
  brain claims it (869); `AGENT_BRAIN_RELEASED = false` (`agent-chat/career_brain.ts:32`). Otherwise the regex router
  `host.runTurn` (919, 940): `packages/domain/142-career-router.js`, 16,171 lines, **123 distinct `intent:` values**,
  bundled as `_shared/router_core.career.js`.
- Then post-processors that can replace the reply: `judgePromptTurn` (936), `searchJudgeTurn` (949), `tailorRewriteTurn`
  (1021), `accountMemoryAfterTurn` (1033), the reply writer `writeReply` (1079), and the evidence/confirm rewrites on
  commit (1153-1186).
- Re-run: `grep -noE "await [a-zA-Z]+Turn\(" supabase/functions/agent-chat/handler-career.ts`.

## 2. Many separate apply paths: still holds

SQL functions (latest definitions) that insert into `career_apply_jobs`, the submit queue: `career_apply_enqueue`
(`20261027141000_career_apply_mass_submit.sql:105`), `career_apply_email_reserve_for` (same file :122),
`career_apply_record_own` (`20261021080000_career_apply_cloud.sql:162`). Callers that are their own entry points (8 paths,
13 functions):

1. apply card answer: `career_apply_card_answer_as` / `_own` (`20261020030000_career_apply_cards.sql:130,134`),
   `career_apply_card_answer_for` (`20261026210016_career_resume_required.sql`);
2. card confirm (Telegram buttons): `career_apply_card_confirm_as` / `_for` (`20261030010000_career_apply_card_confirm.sql`);
3. apply by email: `career_apply_email_reserve_as` (`20261021075000_career_apply_ops.sql:242`) / `_for`;
4. extension begin: `career_apply_extension_begin_own` (`20261024130000_career_apply_card_cloud_bridge.sql:572`);
5. extension agent begin: `career_apply_extension_begin_agent_own` (`20261024100000_career_apply_agent_contract.sql`);
6. cloud record: `career_apply_record_own`;
7. direct enqueue: `career_apply_enqueue` (from `_shared/career_apply_store.ts:39`, the workers);
8. reconcile bridge: `career_apply_reconcile_bridge` (`20261031000000_career_apply_cloud_authorize_closed.sql`).

Chat-side, eight turns lead into them (`cardTurn` 478, `emailTurn` 525, `cloudCardYesTurn` 575, `screenTapTurn` 603,
`screenAnswerTurn` 617, `employerAnswerTurn` 628, `applyHereTurn` 660, `applyTurn` 667), plus the router's batch intent
(`career_batch_turn_commit_v1`, handler 1056-1061) and the brain's `queue_applications` tool. Each path re-implements the
approval, resume and pace checks in its own function.

## 3. Memory and contacts per thread instead of per person: partly held; this PR fixes the user-visible part

What was already per person on trunk:
- stated facts ("I'm a junior majoring in CS"): account record `career_watch_kv 'career:account'.stated_facts`, merged on
  every load (`_shared/career_host.js:527-546`) and written back (`:680-697`), regardless of any switch;
- contacts: `career_account_contacts` keyed `(user_id, row_key)` (`20261027160100_career_account_contacts.sql:22-34`);
- the resume file: `career_resume_record` keyed by `user_id` (`20261026120018_career_resume_one_record.sql:38-39`);
- standing instructions: `career_watch_kv 'career:standing'` (`_shared/agent/memory.ts`).

What was per thread (the harm): the **profile** (the confirmed resume entries with their confirmation events, basics,
preferences) and the **tracker**. They ride `agent_flow_state.state->career->stores` keyed by `thread_id`
(`20261011010000_flow_state.sql:5-6`). Account scope existed (`career_host.js:188-235, 409-438, 699-723`; migration
`20261026090009_career_account_memory.sql`) but only with `CAREER_ACCOUNT_MEMORY=on`
(`agent-chat/handler-career.ts:425`), default off and live "Y-off" (`docs/architect/FEATURES.md` F35). Telegram, WhatsApp
and iMessage share one texting thread (`trainee-inbound/store.ts:72-74`), the web opens its own threads, so a resume
confirmed on Telegram was not on file on the web and an application logged on the web was unknown on WhatsApp.

Counts: of the 23 `thread_id` columns in migrations, one table holds the person's facts per thread:
`agent_flow_state` (30 per-thread stores, `career_host.js:35-60`). The others are conversation records, cards, intents,
costs and messages.

**Fixed in this PR** (largest user-visible harm, safe in one PR):
- account scope is the default for every person with a texting contact linked (every Telegram, WhatsApp or iMessage
  person), and stays on once the account holds their memory (`_shared/career_account_memory.ts accountMemoryOn`,
  read in `agent-chat/handler-career.ts` before `createTurnCtx`). `CAREER_ACCOUNT_MEMORY=on` forces it, `=off` is the
  kill switch. No change to the memory code itself: it existed (20261026090009) and was only switched off.
- one copy (`20261031050000_career_account_memory_one_copy.sql`, additive, down in its header): when an account-backed
  thread saves the profile or tracker, the copies in the person's other account-backed threads are cleared (frames kept),
  so the server readers that take "the newest thread with a profile" see the account's copy, never a stale second one.
  Found by `flow-resume-confirm-race`: with account scope, the web thread kept a draft copy after Telegram confirmed.
- why not every web-only person too: the approval fence moves when confirmed facts on the account change
  (`career_account_authority_mark`, asserted in `tests/db/career_account_memory.test.sql`). `flow-chat-journey` prepares
  payloads stamped `account_version: 0` after confirming a resume in a web-only thread; with account scope that stamp is
  stale and the test fails (6 steps). A real computer stamps the current version, so the fixture is per-thread-only. Turning
  it on for web-only people needs that fixture changed (an architect test edit, not done here).
- no new apply path, no send: external effects still need the exact-payload approval; nothing here writes a fact.

**Remains of root cause 3:**
- `career_apply_profile_for` (`20261026120018_career_resume_one_record.sql:154-166`), what server-side prepare reads,
  still picks one thread's profile copy (the one matching the confirmed resume file, else the most recently updated). With
  account scope on, every thread's copy is refreshed from the account on its next turn, so the newest copy is the
  account's; reading `memory.profile` from the account directly is the follow-up.
- A web-only person with several web threads still has per-thread profile and tracker by default (see above).
- Still per thread: `resumeTexts`/`pastedText` (a resume pasted on one channel and confirmed on another),
  `sendingAccounts`, `offer`, `plan`, `discovery`, and the legacy `contacts`/`outreachContacts` copies.
- Legacy threads: when the account already holds profile facts, a thread written before the switch does not add its own
  confirmed entries (`career_host.js:421-424`); the account copy wins. Live use is small (FEATURES F34: 1 Telegram contact).

## 4. Many hard-coded reply strings: still holds

- `packages/domain/142-career-router.js`: about **1,809** sentence-shaped string literals (capitalised, 30+ characters,
  ending in `.?!`).
- `supabase/functions/_shared/career_*.ts`: about **305** such literals; **264** `reply:` lines with a literal or template
  in 29 files; `channel_*.ts`: 24.
- **61** exported `*_REPLY*` constants in `_shared` (e.g. `CHAT_DOWN_REPLY`, `PHONE_NOT_YOURS_REPLY`).
- Handler examples: `handler-career.ts:962-963` (resume line appended to a search reply).
- The reply writer that would rewrite from verified facts is off by default (`CAREER_REPLY_WRITER`).

## 5. Tests assert wording instead of outcomes: still holds, mostly

- `tests/architect/*.ts`: 403 files, 84,110 lines; **810** lines run a regex against a reply (`/.../.test(x.reply)`), in
  **120** files; **128** exact-equality assertions on a reply across architect and root tests.
- There are also **912** database reads in architect tests (`pg.sql`, `sql(`, `num(`), so many tests check outcomes too,
  but a reworded reply still fails tests that check the right outcome.
- The test added here (`tests/architect/flow-person-memory.test.ts`) asserts the database first (the confirmed entries
  and their event ids in the web thread's profile, the texting thread's tracker, the other person's account and threads,
  nothing queued or approved); its reply checks look for the person's own data (company, school, fact), not phrasing.

## Order for the next PRs

2 (one apply entry point behind one approval check) and 1 (one brain, code-first turns as tools) carry the most
remaining harm; 4 and 5 shrink as 1 lands. The rest of 3 (above) is small and can ride the next apply PR, since
`career_apply_profile_for` is an apply read.
