# Mail providers: one send rail, Gmail and Outlook (2026-10-27, M4)

Every email Trainee sends goes from the person's own mailbox after they approve its exact text: outreach (D-MN-1/2),
applications sent by email (APL-12), follow-ups, and any email the person asked Trainee to write. This doc is the
interface those callers use, so each one can send through whichever mailbox the person connected. M1's Gmail rail
(`feat/outreach-gmail-send-20261027`) should adopt it (see Requests below).

Code: `supabase/functions/_shared/mail_providers.ts` (the rail), `_shared/outlook_graph.ts` (Microsoft Graph, pure),
`_shared/outlook_connector.ts` (connect, tokens, rails bound to the database, chat, edge function, batches), function
`supabase/functions/outlook-oauth/`, migration `20261027230000_career_outlook_connector.sql`.
Tests: `tests/architect/m4-outlook-connector.test.ts` (real Postgres, Microsoft faked at the HTTP boundary),
`tests/db/career_outlook_connector.test.sql`.

## 1. Sending

```ts
import { approvalHashOf, gmailProvider, mailRail, outlookProvider, sendProviders } from "../_shared/mail_providers.ts";
import { outlookFor } from "../_shared/outlook_connector.ts";

const rail = mailRail({
  providers: { gmail: gmailProvider({ fetch, token: gmailSendToken }), outlook: outlookProvider(outlookFor(admin, Deno.env, fetch)) },
  which: (userId) => sendProviders(admin, userId), // connected providers that can send, most recently connected first
});
const r = await rail.send({
  userId, mail: { to, subject, text, attachment /* PDF or DOCX, applications only */ },
  idemKey: `outreach:${draftId}`,                  // stable per approved message: "apply:<job id>", "followup:<id>", ...
  purpose: "outreach",                             // outreach | application | followup | general
  approvedHash,                                    // approvalHashOf({to, subject, text}) when the person said yes
  provider: null,                                  // or "gmail" / "outlook" when the person chose for this message
});
```

`approvalHashOf` is `sha256(JSON.stringify([to, subject, text]))`, the same shape as `career_outreach.ts payloadHash`, so
a hash approved on a card or a batch verifies here unchanged.

| `r.status` | Meaning | Caller does |
|---|---|---|
| `sent` (`provider`) | Accepted by the provider (Graph: 202). | Mark sent. |
| `already_sent` | This key was sent before (Outlook ledger). | Mark sent; nothing went now. |
| `CHANGED` | The text differs from what was approved (rail), or from what was sent under this key (ledger). | Show it again for a new yes. |
| `NO_PROVIDER` / `NOT_WIRED` | No mailbox that may send. | Ask to connect ("connect my outlook" / Gmail). |
| `NEEDS_RECONNECT` | Microsoft refused the stored access (invalid_grant, 401). | Say `RECONNECT_REPLY`; keep the approval. |
| `RATE_LIMITED` (`retryAfterMs`) | Microsoft's 429, longer than this run could wait. | Try the same key after `retryAfterMs`. |
| `REFUSED` | A second address, a display name, a header break, an empty text; or the provider's 4xx. | Never retry as is. |
| `CANCELLED` | Outlook was disconnected while it waited. | Drop it. |
| `UNKNOWN` | A network break or a 5xx: it may have gone. | Never retry; say so plainly. |

`outreachSenderOf(rail)` gives `career_outreach.ts`'s `Sender` (`send(userId, {to, subject, text})`), keyed by the
approved payload's hash, so `runOutreachSends` sends through Outlook with no change to it.

### Safety the rail enforces (not the caller)
- One recipient, a plain address (`ONE_ADDRESS`); never Cc, Bcc, Reply-To or From. Graph gets `subject`, a text `body`,
  `toRecipients` with one address, and one header Trainee sets itself (`x-trainee-send`: a hash of the key; Graph only
  accepts `x-` custom headers). CR, LF, NUL, U+2028 and U+2029 in a subject are refused, never cleaned.
- Exactly once (Outlook): `career_outlook_send_begin` before Microsoft is called. `go` only for a new key, or one that
  Microsoft refused or rate-limited (nothing went). `sent`, `unknown` (in flight or broke mid-send), `cancelled` and
  `changed` never send. Gmail's exactly-once stays the caller's claim (M1), as today.
- No volume limit of Trainee's own. A 429 is waited out for exactly `Retry-After`, as long as the run can wait (`waitMs`,
  30 s by default: a runtime limit, not a volume one); past that it is `RATE_LIMITED` with Microsoft's wait.
- A disconnect cancels every Outlook send not yet made (trigger), and `send_begin` answers `not_connected` after it.

## 2. Reading mail (reply tracking)

`outlookFor(...).readInbox(userId)` runs one delta round on the inbox (`/me/mailFolders/inbox/messages/delta`, `$select`
of from, subject, bodyPreview, receivedDateTime, conversationId; the first round filtered to mail since the connection),
follows every `@odata.nextLink`, keeps the `@odata.deltaLink` in `career_outlook_state`, and stores each message once in
`career_outlook_messages` (ids only as hashes; sender address, subject, Graph's preview). The pure reader
`readInboxDelta` returns `career_mail.ts`'s `MailIn` shape (hash, from, subject, snippet, date, auth = []), so the existing
classifier (interested, not interested, wants a call, out of office, bounce) reads Outlook mail unchanged. A 410 restarts
the round; a 429 keeps the place reached and Microsoft's wait.

## 3. Calendar (for M5)

```ts
const rails = outlookFor(admin, Deno.env, fetch);
await rails.outlookFreeBusy(userId, { start: "2026-10-29T00:00:00Z", end: "2026-10-31T00:00:00Z" });
// -> { status: "ok", source: "calendarView", busy: [{ start, end, status: "busy" | "tentative" | "oof" }] } (UTC, sorted)
await rails.outlookCreateEvent(userId, { subject, start, end, attendees: [email], body, online: true, idemKey: "call:<id>" }, approvedHash);
// approvedHash = eventHashOf(event) when the person approved it; any other event is REFUSED
// -> { status: "created", id, joinUrl, teams, note } | NOT_WIRED | NEEDS_RECONNECT | REFUSED | RATE_LIMITED | UNKNOWN
```
- Free/busy reads `/me/calendarView` (works for work, school and personal accounts; `calendar/getSchedule` does not support
  personal accounts). free, workingElsewhere and cancelled events are free.
- Event create posts `/me/events` with a `transactionId` derived from `idemKey`. A Teams link is added only when the
  calendar's `allowedOnlineMeetingProviders` include `teamsForBusiness`; otherwise there is no link and `note` says so.
  Attendees get Outlook's own invitation.

## 4. Scale

Token refresh and inbox sync run as leased batches: `career_outlook_claim(kind, worker, now, lease_seconds, batch)` takes
up to `batch` people (FOR UPDATE SKIP LOCKED over partial indexes; an expired lease is taken over; a person with
`needs_reconnect_at` or a future `retry_after` is skipped), `career_outlook_release` gives each back only by the worker
holding it. `runOutlookBatch` is one worker's run; the `outlook-oauth` function runs one per `POST {"kind":"sync"|"refresh",
"batch":N}` with `x-outlook-jobs-secret`. Any number of schedulers or workers can call it at once. Measured in the test:
600 people, 12 concurrent workers, each person claimed exactly once.

## 5. Requests (other lanes' files)
- **M1** (`career_outreach*`, send rail): send through `mailRail(...)` / `outreachSenderOf(rail)` instead of `gmailSender`
  directly, so a person with Outlook connected sends from Outlook; map `NEEDS_RECONNECT` and `CHANGED` as above; on Gmail
  or Outlook disconnect, stop that person's approved-but-unsent drafts (Outlook's own ledger is cancelled by the trigger,
  but `career_outreach_drafts` rows are M1's).
- **M2 / reply tracking**: read `career_outlook_messages` (or call `readInbox`) next to Gmail's reader; match replies to
  outreach by sender address and subject (Graph's `sendMail` returns no message id).
- **M5 / scheduling**: use `outlookFreeBusy` / `outlookCreateEvent` for people whose calendar is Outlook.
- **Applications by email (APL-12)**: `rail.send({ purpose: "application", idemKey: "apply:<job id>", mail: {..., attachment} })`.
- **#191 (connectors)**: when it lands, `outlook` can become one more `Connector` there; the link table here is separate
  so this does not depend on #191's migration.
- **Scheduler**: a pg_cron job (go-live step 5 owner) that POSTs `{"kind":"refresh","batch":200}` and
  `{"kind":"sync","batch":200}` to `outlook-oauth` every few minutes with `OUTLOOK_JOBS_SECRET`.
