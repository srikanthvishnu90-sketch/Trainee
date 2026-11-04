# Application submission for a person as the chat leaves them (2026-10-25)

Branch `arch/submit-path`, off `arch/backend-g6-receipts` 6bf3478e (which contains `arch/backend-integrated-flow`).
Repo only: nothing is deployed, no migration is applied, no real employer is reached. SUBMIT-STEER-1130 and SPLIT-1146.
This side owns the host, the executor and the database. The router's chat families are Muse's.

## The one path

The person texts → `prepare-ahead.ts` prepares on the server → the card → their own tap → `career_apply_claim_own` →
the engine submits on their computer (`approve-first.ts` `runApproved`) → `career_apply_finish_own` records it → chat
reads it back. The cloud worker runs the same engine. The agent submits; the person approves the exact answers on the
card. There is one ledger (`career_apply_ledger`, G3, `20261025100000`). Since D-MS-2/D-MS-3 (2026-10-27) there is no
limit of Trainee's own: only a pace the person sets themselves, backoff when a portal refuses, and the exact-duplicate
rule (see "Volume ceilings" below).

## What a real person lacked at 6bf3478e

Measured with the product's chat host (the router bundle agent-chat runs), not a hand-made profile:

| Input | At 6bf3478e |
|---|---|
| Resume | "yes, that's my resume" confirms 15 entries with no provenance and no event, so the executor keeps 0 of 15. The server prepare then stops at `no_resume` before it asks anything. |
| Name, email | Without them no resume can be tailored, and nothing asks for them, so the prepare returns `no_resume` every time. |
| Phone, name, email said in chat | They never reach a form. Only sponsorship and work authorization were offered back from the person's own words (G2). |
| Work authorization, sponsorship | They reach the form through G2's "use N". |
| Read-back | "did my application to Acme go through?" gets the banner. "where are my applications" reads the router's own tracker, never `career_apply_jobs`. |

## Functions (signatures for Muse)

### (a) Resume confirmation with real provenance: `_shared/career_router_evidence.ts`

```ts
evidenceResumeConfirmation(o: {
  userId: string; now: number; message: string;          // the person's yes, this turn
  before: Profile | null; after: Profile | null;          // the profile the turn started from, and the one it left
  out: { intent?: string | null; resultStatus?: string | null };  // the router's result for this turn
  shown: { text: string; message_ids: string[] } | null;  // what Trainee showed since the upload, verbatim
  upload: { kind: "message" | "file"; ref: string; sha256: string; text: string } | null;  // the person's original upload
  events: EventStore | null;                               // career_events (supabaseEventStore)
}): Promise<{ stamped: number; unshown: number; untraced: number; refused: number }>

resumeConfirmationContext(rows: { id; role; content }[] /* the thread, newest first */, after: Profile)
  : Promise<{ shown: Shown | null; upload: Upload | null }>
```

It stamps a fact only when all of these hold:
- it was a draft before this turn and is confirmed after it, on the router's own confirm (`career_resume_ingest`,
  `completed`);
- its words (`fact.text`) appear in what was shown;
- its own lines (its title and bullets) appear in the person's upload.

A stamped fact gets:
- a `fact_confirmed` event in `career_events`, recording the message hash, the shown hash, the shown message ids, and
  the upload ref and hash;
- `provenance: "owner confirmed in chat the resume entry shown to them (<at>)"`;
- `confirmation_event_id`;
- `source_ref`.

An event that is not recorded stamps nothing. agent-chat runs it after the router's turn and before the commit, on that
intent only (`handler-career.ts`).

**Muse's part (router, 142).** The confirm reply today shows a count: "I read it as 15 facts (1 education, …)". A yes to
it evidences nothing, which is honest. For the entries to reach the executor, the reply before "yes, that's my resume"
must show each entry's own words (`fact.text`). Any layout works, as long as each entry's text appears whole.
`flow-real-person.test.ts` uses `Here is what I read:\n1. <fact.text>\n2. …` as the contract.

### (b) Name, email and phone from the person's own words: `_shared/contact_draft.ts`

```ts
contactDraft(fact: "first_name" | "last_name" | "full_name" | "email" | "phone", said: { text: string; at: string }[])
  : { fact; value: string; text: string; at: string } | null
isContactFact(f: string): boolean
```

The questions turn (`career_apply_questions.ts`) offers it under a `fact:first_name`, `fact:last_name`, `fact:email` or
`fact:phone` question: "You told me on Oct 24: "my name is Jordan Rivera". That answers Jordan. Say "use 1"". Only
"use N" saves it, as with G2.
- **What counts:** a first-person statement only ("my name is …", "my email is …", "my phone number is …", "reach me
  at …").
- **What never counts:** someone else's details ("my sister's phone …"), a question, a hedge, or a negation.
- **Names:** a first and last name are taken only from a name of exactly two words.
- **Freshness:** the newest message about a field decides.
- **Production read:** `supabaseQuestionStore.statements` now also reads the person's messages that mention their name,
  email or phone.

`prepare-ahead.ts` asks `fact:first_name`, `fact:last_name` and `fact:email` once, when there are confirmed entries but
no name or email to print on the resume. Before, it stopped at `no_resume`. The questions are bound to the posting, so
answering them makes it a candidate again.

### (c) Read-back from `career_apply_jobs`: `_shared/career_apply_status.ts`

```ts
statusAsk(message: string): { company: string | null } | null
statusReply(message: string, rows: AppRow[] | null, now: number): { reply; status; intent: "career_apply_status" } | null
applicationsTurn(o: { message; userId; now; read: (userId) => Promise<AppRow[]> }): Promise<… | null>
supabaseApplications(admin): (userId) => Promise<AppRow[]>   // career_apply_jobs only
```

| Recorded state | Read back as |
|---|---|
| `confirmed` | "submitted, and X confirmed it (confirmation N)". Said only in this state. |
| `submitted_unconfirmed` | "submitted on <date>; X has not confirmed it yet (their page showed N)". |
| `unknown_outcome` | "I can't tell whether it reached X. It will not be sent again." |
| `queued` | "approved, not sent yet". |
| `driving` | "being sent now". |
| `failed`, `not_submitted` | "not sent (<reason>)". |
| `needs_user` | "stopped before it was sent; it needs you". |
| No row | "I have no application to X on record". |
| Unreadable | "I couldn't read your applications just now". |

agent-chat answers it in code before the router and the brain, like the card (`handler-career.ts`). If Muse would rather
the router own the wording, `statusReply` is pure and can be called with rows the handler reads.

## Tests

- `tests/architect/submit-real-person.test.ts`: 15 tests (evidence 1–1d, prepare 2–2c, own words 3–3c, read-back
  4–4c).
  - Mutations, each red on its test: M1 contact ask removed, M2 contact offers removed, M3 shown not checked, M4 upload
    not checked, M5 an unrecorded event stamps anyway, M6 "submitted, not confirmed" said as success, M7 an unreadable
    record guessed as none.
  - M8 (someone else's phone offered) stays green: it is caught a second time by the possessive check.
- `tests/architect/flow-real-person.test.ts`: real Postgres and Chromium, 10 steps.
  - **Today's router reply:** a yes to the count evidences nothing, so that person stops at `no_resume`.
  - **With the entries shown:** every entry gets its event and upload.
  - **The questions:** the prepare asks for name and email, and they are offered from the person's own words and used
    with "use N". The dry run then asks phone, sponsorship and work authorization, each offered from their words and
    used with "use N".
  - **The submit:** the prepare is ready with only the person's answers and the tailored resume. The card shows each
    answer. Their tap queues it, with one ledger row, and the read-back says "approved, not sent yet". The employer page
    receives Jordan / Rivera / email / phone / no / yes and the tailored resume byte for byte, once.
  - **The record:** `submitted_unconfirmed` REAL-7001, read back as "has not confirmed it yet".
- **Fail-first:** at 6bf3478e none of these load (the modules are new). The measured behavior is in the table above.

## Not done here (named)

- The router's resume confirm reply must show each entry (Muse's lane). Until it does, the live router path evidences
  nothing, and the executor gets only what the person answers to questions.
- The router's own replies to "my name is …" (the banner) and to "I'm a US citizen, I don't need sponsorship" (it claims
  a save and a prepared packet when neither exists, as in `tests/architect/pending/g2-workauth-honest.test.ts`) are
  Muse's.
- Nothing is applied or deployed. The handler changes reach people only on the owner's deploy.

## Running the real flows yourself (JOIN-1202)

`bash tests/flow/run-real-flow.sh` runs `flow-real-person.test.ts` and `flow-connected.test.ts` on a throwaway
Postgres 16 with CI's migration order and a sandboxed Chromium. It sets `CI=true`, so a missing Postgres or browser
fails the run; it never prints NOT_RUN and passes. As root it re-runs itself as the `postgres` account, because
Chromium's sandbox refuses root.

Needs:
- **Postgres 16:** `/usr/lib/postgresql/16/bin`, or `PGBIN=`.
- **Deno and Node:** Deno 2.9.6 and Node 22 on `PATH`.
- **Playwright 1.64.1:** `npm ci --prefix tools`.
- **A Chromium:** `UPMORE_CHROMIUM_PATH=` (CI uses the runner's `google-chrome`). Otherwise Playwright's own, from
  `(cd tools && npx --no-install playwright install chromium)`.
- **Network once:** to fetch the tests' imports.

Measured at 455da675, warm: 3 tests and 24 steps in 1m23s. flow-real-person took about 28s, flow-connected G1 25s and
G4 37 to 44s. The gate also runs both under `CI=true` in GitHub Actions (`architect-tests`).

Exact local environment used:

```
UPMORE_PLAYWRIGHT_PATH=<checkout>/tools/node_modules/playwright
UPMORE_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome   (Chromium 141)
PGBIN=/usr/lib/postgresql/16/bin   (PostgreSQL 16.15)
deno 2.9.6
node 22
```

## Handler-level contract (JOIN-1215)

The contract is the agent-chat request and what follows from it, not a ctx seam. The router (142) stays synchronous and
pure, and never calls a host writer or reader. The handler `supabase/functions/agent-chat/handler-career.ts`
(`handleChat`) runs the host steps around the router's turn, in this order:

| # | When | Call (file:line) | Reads / writes | What the person reads |
|---|---|---|---|---|
| 1 | before the router, when the text answers the questions | `questionsTurn` (handler-career.ts:359 → `_shared/career_apply_questions.ts`) | **Offers:** their own message about name, email, phone (`contact_draft.ts` `contactDraft`), sponsorship or work authorization (`eligibility_draft.ts`). **Writes:** only on "use N", through `career_apply_question_answer_as` | the offer quoted with its date; "Saved, as drafted" only after the write returned. A failed write gives the 503 "I could not confirm that your career reply or changes were saved" |
| 2 | before the router, when the text is a status question | `applicationsTurn` (handler-career.ts:428 → `_shared/career_apply_status.ts`, `supabaseApplications`) | reads `career_apply_jobs` only | each application in its recorded state. "X confirmed it" only for state `confirmed`. "I couldn't read your applications" when the read fails |
| 3 | the router's turn | `host.runTurn(message, ctx)` (:501, :508) | the thread's career state | the router's reply |
| 4 | after the router, on `career_resume_ingest` + `completed` only | `resumeConfirmationContext` (:524) then `evidenceResumeConfirmation` (:525), `heldReply` (:529) → `_shared/career_router_evidence.ts` | **Reads:** the thread's last 40 messages, i.e. what was shown since the upload, and the upload. **Writes:** a `career_events` `fact_confirmed` row per evidenced entry, and the entry's provenance, `confirmation_event_id` and `source_ref`. An entry it cannot evidence goes back to draft | when anything is held: what is confirmed and what stays a draft, and why, **in place of** the router's "Confirmed" |
| 5 | the commit | `persistence.commit` (:590) | the thread's state, including the stamps and holds from step 4 | — |

Signatures (career_router_evidence.ts):
- `:36` `evidenceResumeConfirmation(o: { userId, now, message, before, after, out, shown: Shown | null, upload: Upload | null, events }): Promise<EvidenceResult>`
- `:25` `EvidenceResult { stamped, unshown, untraced, refused, held: string[] }`
- `:79` `heldReply(r): string | null`
- `:95` `resumeConfirmationContext(rows /* newest first */, after): Promise<{ shown, upload }>`

What the router must render for step 4 to evidence anything: the reply before "yes, that's my resume" shows each
entry's `fact.text` whole. A count is not enough.

**Tests, through `handleChat` on a real Postgres** (`tests/flow/handler.ts`, `tests/flow/postgrest.ts`: the real
supabase-js client, Supabase-parity grants and RLS, the HTTP hop answered over the same database):
- `tests/architect/handler-submit-path.test.ts`: 9 tests.
  - **(a2)** A yes to a count is held as drafts and never called confirmed: no event, and the executor gets 0.
  - **(b1)** Name, email and phone said in chat write nothing and claim nothing. They reach the form only through "use
    N", exactly as typed.
  - **(b2)** A failed write is never called saved.
  - **(c1)** Work authorization and sponsorship come from their own words through "use N".
  - **(c2)** Citizenship answers neither.
  - **(d1–d3)** Read-back from `career_apply_jobs`; never a success without the recorded confirmation; an unreadable
    record is said.
- `tests/architect/pending/handler-submit-router.test.ts`: 3 tests, red until the router changes.
  - **(a1)** The entries are shown, then one event per entry, then the executor gets exactly those.
  - **(a3)** The entries are shown and the event write fails: nothing is confirmed, and the reply says so.
  - **(c)** No "saved" and no "prepared packet" that does not exist.
- Locally, where esm.sh is unreachable: `--import-map=tests/flow/supabase-npm.json`, the same supabase-js 2.117.1 from
  npm.

| Head | handler-submit-path | pending router |
|---|---|---|
| 6bf3478e (before) | 4 passed, 5 failed (a2, b1, d1, d2, d3) | — |
| 455da675 | 8 passed, 1 failed (a2: "Confirmed — your resume facts are on your record.") | — |
| this commit | 9 passed | 3 red: a1 "15 of 15 not shown"; a3 its precondition; c "Updated — I saved your corrected sponsorship answer" |
| join eea59b6e | 8 passed, 1 failed (a2; the join predates this commit) | 3 red, same messages |

## Volume ceilings on the chosen path (D-MS-2 and D-MS-3, owner, 2026-10-27)

There is no volume limit of Trainee's own anywhere (owner, 19:55 CDT: "no person limit, never set a limit"). The changes
are in two migrations:
- `20261027140000_career_apply_host_backoff.sql`: a portal's refusal is the only thing that holds work back.
- `20261027141000_career_apply_mass_submit.sql`: the bounds are removed, the exact-duplicate rule replaces the company
  rule, and every claim is fair and parallel.

The TS mirrors follow. Neither migration is applied: the owner applies migrations (D-MS-4).

| Was | Now | Where |
|---|---|---|
| The person's daily limit: 25 by default, 50 at most | None. A pace the person sets themselves still holds, with no maximum. An unreadable saved pace refuses by name. | `career_apply_pace_state` (`20261025160000`); `career_apply_ledger_refusal` (7 args, `20261027141000`) |
| Enqueue's `p_daily`: 1..50 | Any value, or none. It is never a ceiling. | `career_apply_enqueue` |
| Cloud claim: `least(coalesce(o.daily, 25), …)`, plus the bridge's 15 | Only the person's own pace | `career_apply_cloud_refusal`, rewritten wherever it is installed (`career_apply_mass_submit_install`) |
| Cloud opt-in: 15 (bridge), 1..50 earlier | Carries the person's own pace, or null. The default of 15 is dropped. | `career_apply_cloud_optin_as` / `_get` |
| Bridge authorize-before-effect: 15 and the company rule | The person's own pace and the exact-posting rule | `career_apply_message_cloud_authorize` (when the bridge is installed) |
| Claim batch: `least(6, p_limit)` | The worker's own batch size, as given | `career_apply_claim_own`, `career_apply_claim`, `career_apply_cloud_claim_at` |
| Dispatcher: 6 at a time, 500 a call | Each family's share in one call. No upper bound on the worker's numbers. | `career_apply_cloud_dispatch_claim` |
| Store-side claim: `limit > 6` refused | Any whole number ≥ 0 | `supabase/functions/_shared/career_apply_store.ts` |
| Applications per card: 8 | Any number on one card (tested with 500). One answer covers all of them, each refused by name if its payload changed since it was shown. | `career_apply_cards_items_check`, `career_apply_card_open_for`, `career_apply_card_push_for`. TS `MAX_PER_CARD` is in `career_apply_cards.ts` (builder B's lane). |
| The chat's apply queue: 100 at once | Any number | `career_apply_want_put_for` |
| One per company per 30 days (`company_cooldown`), and its copy in the erase tombstone (`20261026230100`) | Gone. Only the exact same posting, already sent or in flight, is refused (`duplicate_job`). No employer hash is kept after an erase. | `career_apply_posting_sent`, `career_apply_posting_key`, `career_apply_erased_guard`; the queue, apply-by-email, the apply queue, the server prepare, the cloud check, the claim's re-check |
| Safety pacing (a default spacing, a per-host count) | None. Back off only on a portal refusal (below). | `career_apply_host_backoff` |
| The person's computer claims one at a time | Unchanged in the worker (builder C's lane). The database takes any number. | `workers/career-browser/approve-first.ts` |
| Cloud worker concurrency `min(6, …)` | Unchanged in the worker (builder C's lane) | `workers/career-cloud/worker.ts` |
| TS mirror | `admitApplication`: exact posting only (`postingKey`, the SQL's canonical link), no company rule, only the person's own pace | `supabase/functions/_shared/career_apply.ts` |

**Refusal backoff (`20261027140000`).** A drive that meets a 429 or rate-limit page (`rate_limited`), a bot wall
(`bot_wall`; that drive ends `needs_user` and is never retried) or a 503 (`server_busy`) reports it. The service calls
`career_apply_host_refused_for(job, lease, reason, retry_after, now)`; the person's computer calls
`career_apply_host_refused_own(job, lease, reason, retry_after)`. That host then waits, in that address's scope (`cloud`,
or the person's own id), for the portal's Retry-After. Without one it waits 30 s, doubling up to an hour. Every claim
skips a waiting host and its applications stay queued. The first accepted request resumes it:
`career_apply_host_ok_for` / `_own`. `career_apply_host_wait(url, scope, now)` and `career_apply_host_wait_own(url)` say
whether a host is waiting, until when and why, so the chat can tell the person.

**Scale.** Every claim is:
- **Fair:** `career_apply_claim_turns`, kept by a trigger. The longest-waiting people go first, each with an equal share,
  so one heavy person never starves the rest.
- **Parallel:** `FOR UPDATE SKIP LOCKED` on people and on rows, with no global lock.
- **Bounded and indexed:** `career_apply_jobs_queued_user`, `career_apply_claim_turns_ready`. A claim re-checks the hash
  of only the rows it hands out.
- **Leased:** 15 minutes, then `career_apply_sweep` (SKIP LOCKED, 10,000 a call) records `unknown_outcome`, never re-sent.

`tests/db/career_apply_claim_load.py` runs in the database job: 10,000 people × 50 approved applications plus one person
with 2,000, claimed by 20 concurrent workers. It asserts exactly-once (every row once, its own lease, none left), fairness
(the first round serves one each, and the heavy person does not delay anyone) and prints the measured throughput and
latency.

Kept unchanged:
- **Unique confirmation IDs:** `career_apply_jobs_confirmation`.
- **Payload-hash re-verify at every claim:** `career_apply_void_unsendable`'s rules, applied to the rows each claim hands
  out; `career_apply_jobs_fixed`.
- **Every resume check:** the message card's prepared-resume requirement, the cloud's resume by hash.
- **Every approval and hash check in enqueue.**

`career_apply_guards_missing()` reads non-empty if any claim or cloud check keeps a product bound or the company rule.
The reconcile the launch scripts run after every apply ends with `career_apply_mass_submit_install()`, so no apply order
of the bridge draft, its rollback, the one-ledger file or the erase file brings one back.

## Approval model on the chosen path (APPROVAL-1226; changed 2026-10-27 by D-MS-1)

- **A batch, by the person's own call.** `career_apply_card_answer_own(p_card, p_approve int[])` approves every listed
  item of one card in one call (`20261020030000_career_apply_cards.sql:130`, body
  `20261020050000_career_apply_daily_limit.sql` `career_apply_card_answer_for`). A card holds up to `MAX_PER_CARD = 8`
  applications.
- **Each approval is bound to the exact payload.** The card stores each item's `payload_hash`. At the answer, an item
  whose prepared payload no longer hashes to it is `changed`, not queued (the same function). Enqueue requires
  `approval = payload hash = career_apply_payload_hash(payload)` (`20261025100000…:162-163`). The claim closes any job
  whose payload no longer hashes to its approval as not sent (`career_apply_void_unsendable`).
- **(Superseded 2026-10-27 by D-MS-1, below.)** ~~A chat "yes" does not approve (Option A, 2026-10-22).~~ A text "yes"
  to the card replied "A text yes doesn't send anything … tap Approve"; later (SERIAL-1461) only a yes in direct reply to
  the card's message counted.
- **(Resolved 2026-10-27 by the owner, D-MS-1.)** The tension between "a yes does handle a batch of submissions" and
  Option A is closed in favour of the texted yes.

### Approval model from 2026-10-27 (D-MS-1, mass submission, chat side)

- **A texted yes approves exactly the batch shown, on any channel** (SMS/iMessage, WhatsApp, Telegram, the web app).
  `cardTurn` (`supabase/functions/_shared/career_apply_cards.ts`) calls the existing batch approval once,
  `career_apply_card_answer_as(p_user, p_card, p_approve int[])` with the card's numbers: the same function the tap uses
  (`_own`), no new trust path. The database still decides per item: an item whose prepared payload no longer hashes to
  the hash the card carries is `changed`, not queued, and the rest go on; the reply names it ("2. Beta Labs: not sent: it
  changed after the card was shown") and says how to see it again.
- **Which card a yes is about.** The card this thread showed, while it is still the thread's last word (the plain yes
  that iMessage, SMS and the web app send), or the card whose message the text replies to (Telegram, WhatsApp Cloud). A
  reply to any other message approves nothing and says how. Of two cards shown only the latest is open (opening a card
  closes the older one in `career_apply_card_open_for`): a yes to the older one is "out of date", nothing approved.
  Within 10 minutes of the showing (the chat and `career_apply_card_answer_for`'s `card_stale`), once (`card_answered`).
- **What a reply means.** "yes", "yes to all", "approve all", "send them", "go ahead": the whole card. "yes except 3",
  "yes but not Acme", "approve, skip 2": all but those. "only 1, 2 and 5", "just 1 and 2", "1, 2 and 5", "send 1 and
  3": exactly those. "not Acme" alone: confirmed first ("Reply "yes except 1" to send the other 5"), nothing approved.
  "no": declines all. "wait", "hold on", "not yet": holds, nothing approved, the card still waits. "maybe", "ok", "sure",
  "yes?", "1 or 2", "approve 2", "yes 3", "yes acme", "yes but not the one in Ohio": unclear, nothing approved, the card
  asks again in plain words. A number not on the card, an employer not on it, "yes send all 60" on a card of 3, or a
  subset that leaves nothing: refused, nothing approved. "stop" stays the carrier's opt-out, never a card answer.
- **No 8-per-card limit (D-MS-2).** "show my applications" puts the whole batch on one card, paged into messages of at
  most 3,800 characters for reading (`batchFor`; the reply's `parts`, delivered whole on every channel), and one yes
  covers every page; the answer says plainly how many were approved and lists each not sent with why. A batch past 20
  pages (a transport bound for one reply) shows what fits and says "N more are ready; they come on the next card". The
  scheduled push (`cardFor`) is still one text. **Until builder A's D-MS-2 migration** drops the database's
  `between 1 and 8` (`career_apply_card_open_for`, the `items` check), the database refuses a larger card: the chat then
  shows 8 and says how many more wait, and the next card holds the rest.
- **Mass asks.** "apply me to all of them", "apply to the top 50", "apply to all remote ones", "apply to every SWE intern
  role you found" queue the listed postings (a filter is read against the listed titles and locations) as one batch
  (`career_apply_chat.ts` `applyManyAsk` / `applyManyTurn`). The resume rule is unchanged: no confirmed resume, nothing
  queued, the reply asks for it.
- **Tests:** `tests/architect/mass-submit-chat.test.ts`, `mass-submit-channels.test.ts` (iMessage, Telegram, WhatsApp
  through their real webhook handlers), `mass-submit-handler-pg.test.ts` (the production handler on Postgres, the web
  app's turn; `career_apply_jobs` asserted).
