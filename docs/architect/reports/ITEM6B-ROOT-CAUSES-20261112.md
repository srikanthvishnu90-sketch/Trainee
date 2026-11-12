# Item 6(b): File page controls served, root causes and fixes (D-072, 2026-11-12)

Bar (VERIFICATION-15 "The 95% bars", item 6; owner 2026-11-12): at least 99% of the File page controls on served pages do what they
say, at 390 px and on desktop, and dead controls stay 0. Before: **156/172 (90.7%)**: `files-live-loop` 83/99 (16 shown off with a
reason), `files-live-records-loop` 73/73. After: **172/172 (100%)**, dead 0, unserved 0.

## How the 172 are counted

| Suite | What it serves | Controls | Before | After |
|---|---|---|---|---|
| `tests/architect/files-live-loop.test.ts` | the 12 served families (F-01 to F-04, F-07 to F-09, F-12 to F-15, F-14n), each a stored-view File (`createFamily(..., view)`, the family's specimen), through the real File server, 390 x 844 | 99 | 83 served, 16 off | 99 served |
| `tests/architect/files-live-records-loop.test.ts` | F-01 F-02 F-03 F-08 F-13 F-14 F-14n F-15 from records (two people: full, none), 390 x 844 | 73 | 73 | 73 |

A "control" is every `a`, `button`, `[role=button]`, `summary` and submit on the page. "Off" is a disabled button with its reason
drawn beside it (not dead, but it does nothing).

### The 99 stored-view controls by family

Every control on these pages is one of: back to chat, the menu, this File's export (`?format=json`), an https source page, a decision
that opens the chat with the question filled in, or a post served as a form (record-backed pages only). Counts, with the controls that
were shown off before:

| Family | File (as the chat question names it) | Controls | Shown off before (now: the chat with the question) |
|---|---|---|---|
| F-01 | Career brief | 9 | none |
| F-02 | Profile facts | 8 | **Review 2 conflicts**, **Stop reusing a fact** |
| F-03 | Path comparison | 7 | none |
| F-04 | Search plan | 7 | **Approve search scope** |
| F-07 | Materials | 7 | **Approve v3 for R-07**, **Compare changes** |
| F-08 | Answer library | 7 | **Review 2 answers needed**, **Use once**, **Never reuse** |
| F-09 | Application review | 8 | **Approve submission**, **Cancel** |
| F-12 | Message review | 7 | **Approve send** |
| F-13 | Interview hub | 8 | **Open prep brief** |
| F-14 | Weekly brief | 9 | **Review 2 decisions**, **Pause search** |
| F-14n | Negotiation plan | 8 | **Review draft**, **Review the counter draft** |
| F-15 | Offer comparison | 14 | none |

The 16 in bold were the ones shown off. The 73 record-backed controls are listed by `files-live-records-loop` (pages 16, each control
pressed: exports, the brief's pause/resume posts, sources, menus, chat); none was off before or after.

## The 16, each with its exact cause

Every one of the 16 sat on a stored-view page. All 16 were drawn by `supabase/functions/_shared/file_family_serve.ts servedAct`.

| # | Family | Control | Drawn as (specimen, `file_family_specimens.ts`) | Exact cause | Class |
|---|---|---|---|---|---|
| 1 | F-02 | Review 2 conflicts | `?review=conflicts` | `review` not in `ASK_KEYS`: fell to the last line, `off: NOT_YET` | A: action unwired |
| 2 | F-02 | Stop reusing a fact | `?stop=reuse` | `stop` not in `ASK_KEYS` | A |
| 3 | F-04 | Approve search scope | post `approveplan` | listed in `SERVED_POSTS`, but `answers()` is false on a stored view (no records: `rec.data.live` unset), so `servedAct` drew it off | B: no records behind the page |
| 4 | F-07 | Approve v3 for R-07 | post `approvedoc` | as 3 | B |
| 5 | F-07 | Compare changes | `?compare=v2-v3` | `compare` not in `ASK_KEYS` | A |
| 6 | F-08 | Review 2 answers needed | `?answers=needed` | `answers` not in `ASK_KEYS` | A |
| 7 | F-08 | Use once | `?use=once` | `use` not in `ASK_KEYS` | A |
| 8 | F-08 | Never reuse | `?reuse=never` | `reuse` not in `ASK_KEYS` | A |
| 9 | F-09 | Approve submission | post `approveapp` | as 3 | B |
| 10 | F-09 | Cancel | `?cancel=A-014` | `cancel` not in `ASK_KEYS` (the live F-09 page draws the same decision as `?decide=cancel`, which is served) | A |
| 11 | F-12 | Approve send | post `approvesend` | as 3 | B |
| 12 | F-13 | Open prep brief | `?brief=grid` | `brief` not in `ASK_KEYS` | A |
| 13 | F-14 | Review 2 decisions | `?decisions` | `decisions` not in `ASK_KEYS` | A |
| 14 | F-14 | Pause search | post `pause` | not in `SERVED_POSTS["F-14"]` (served is `briefpause`/`briefresume`) and no records behind the page | B |
| 15 | F-14n | Review draft | `?draft=counter` | `draft` not in `ASK_KEYS` | A |
| 16 | F-14n | Review the counter draft | `?draft=counter` | `draft` not in `ASK_KEYS` | A |

Why the product was not complete: (A) the record-backed builders (`file_family_records.ts`) had already moved every such decision
to the chat, but the family builders still accept the older query keys and the File server's chat mapping (`ASK_KEYS`) was never
extended to them, so a family page drawn from view data showed them off. (B) A stored view is a snapshot with no record behind it, so
an approval cannot be bound to a current payload hash on that page (D-MS-1). The off text said "Ask Trainee in the chat" but gave no
way to get there.

No endpoint was missing and no flag was off: every one of the 16 was a mapping gap in `servedAct`.

## Fixes (`supabase/functions/_shared/file_family_serve.ts`)

- **A (11):** `review`, `stop`, `compare`, `answers`, `use`, `reuse`, `cancel`, `brief`, `decisions`, `draft` added to `ASK_KEYS`.
  Each opens the chat with the question filled in, naming the File and the item (ruling 2), e.g.
  `About my Answer library, "<question>": Use once.` Pressing it changes no row.
- **B (5):** a post the page cannot answer is never a form. It opens the chat with
  `About my <File>: <label> (show me exactly what this covers first; nothing is approved, sent or changed until I say yes to that).`
  A POST of that action to the page is still refused (400, "Nothing was changed or sent"). Every chat yes-reader
  (`career_cloud_card_chat.ts`, `apply_all_yes.ts`, `channel_inbound.ts`, ...) is anchored at the start of the message, so a question
  starting "About my" is never read as a yes. On a record-backed page the served posts stay forms bound to the payload hash.
- With no chat link configured (`TRAINEE_BOT_URL` unset or not t.me/wa.me), both stay off with `NO_CHAT`, as before.

No control was hidden or removed; no spec says any of the 16 should not exist.

## Tests

- `tests/architect/files-live-loop.test.ts` (unedited loop): `families 12, controls 99, pressed 99, served 99 (exports 14, source pages 8, menus 12, chat 65), dead 0, unserved 0, not yet served 0` (before: pressed 83, chat 49, not yet served 16). One labelled `Architect amendment (D-072)` in its S0 hooks test: a listed post with no records behind it is asserted to open the chat with the question instead of being shown off; never a form and a post refused, unchanged, both still asserted.
- New `tests/architect/files-item6b-controls.test.ts`: each of the 16 is a chat link with its question naming the File (approvals say nothing is approved there and never read as a yes); no stored-view family page has a control shown off (99 counted); the 5 posts are refused, rows unchanged; and a 1280 px desktop pass presses each of the 16 in headless Chromium (CI's Playwright; it throws in CI without it).
- Measuring suite re-run at $0 (headless Chromium, local): files-live-loop, files-live-records-loop, files-actions-loop, files-s3-plan-materials, files-f12-live, files-review-live, files-records-families, r10-files-*.

## Not in the 172 (found while tracing)

- In production only F-09 (`file_service.ts createReview`, from `application_review_links.ts`) and the results-list families (F-05, F-06, F-10, F-11) are made from the chat. No production code calls `createFamily`, so the record-backed F-01 to F-04, F-07, F-08 and F-12 to F-15 pages (all served and passing) are reachable only once a chat path makes them. That is a separate order (agent-chat), not File page code.
- The crawlers run in headless Chromium at 390 x 844 and 1280 px, not on a physical phone.
