# Live results: Trainee on the owner's Instinct WhatsApp benchmark

Each run sent the 26 messages to Trainee's real career handler in one conversation, using the real model, through
`.github/workflows/mirror-conversation.yml`. Each run was capped and reserved at the shared $70 ledger.

Run conditions:
- The persona had fictional names.
- Every host except the model and the database double was refused, so nothing could be submitted or sent.
- The posting board was the test world's small fictional board (four analyst postings, no SWE roles).
- There was no Gmail, no Google Sheets and no web search.

The transcripts were edited after the run in one way only: a venture name the persona file had missed was replaced by its
fictional name.

| Run | Code | Spend | Turns that mirror | Same task | Length within ±10% | Median length (Instinct 396) |
|---|---|---|---|---|---|---|
| `live-3` (CI run 42975069689) | the routing fixes | $1.3950 | 0 / 26 | 13 | 0 | 936 |
| `live-4` (CI run 42977209350) | + texts condensed, + the quoted mock question | $1.4005 | 3 / 26 (11.5%) | 12 | 5 | 460 |
| [`live-5`](live-5/) (CI run 43135329449) | trunk 1ee06408 (D-059 to D-063), web research on (D-060), scored on the five P5 checks | $1.8375 | 1 / 26 (C18 to C23 cut by the cap) | 13 | 1 | 507 |

`live-1` and `live-2` cost $0 and did not reach the model. The runner set the API key after the test world had cleared it,
so every call got a 401. Both runners are fixed.

The total spent under D-057 is $2.7955 of $3. live-5 ran under D-060 ($10 for this effort).

**How a turn is scored** (`evals/mirror/score-conversation.ts`): a turn mirrors when it passes all six checks below.

- **Same task:** it did the same task, judged by a person. The reasons are in `judged-live-*.json`.
- **Length:** it is within ±10% of Instinct's text, or within ±6 characters when Instinct's text is under 60.
- **Answers first:** it answers first. This check also fails Instinct itself on 4 turns, so a turn passes it when Instinct's
  own reply fails it too.
- **No internal words.**
- **Boundary restated:** wherever Instinct said that nothing was sent or submitted, Trainee says it too.
- **No action:** nothing was queued, prepared, submitted or sent.

## Why Trainee does not mirror (live-4)

| Cause | Turns | Fixable without the owner? |
|---|---|---|
| **No web research.** Citadel pay and process, intern pay, and whether a posting is still open. The research hosts were unreachable, and in production research stays off until web search is verified live. | C9, C22, C18, C23 (C23 follows from C9) | No. The owner turns on and pays for web search. |
| **No live SWE postings.** The test board has none. In production the index covers Greenhouse, Lever, Ashby and SmartRecruiters, but not Workday, which is where PayPal's posting is. | C1, C3, C10, C20 (C20 follows from C10) | Partly. Workday ingest is a new connector. The rest is the test board, not the product. |
| **No Gmail or Sheets.** Instinct read three Gmail accounts and built a Google Sheet. | C6, C16 | No. It needs the Gmail connector and a Sheets grant. |
| **No people search.** `CAREER_PEOPLE_SEARCH` is never on, and LinkedIn is never automated. | C19 | No. It needs the owner's decision on people search. |
| **Length.** It is still over Instinct's on most turns (median 460 against 396), and within ±10% on only 5. | most | Yes. Next is a tighter condense target. |
| **Asks instead of drafting.** A referral draft to "a Google SWE" got "who is the engineer?" (R10 fix 14b, which asks for one question when the recipient is unset). Instinct drafts with a [Name] placeholder. | C2 | Needs an architect ruling on 14b. |
| **Hypothetical answered from the real profile.** "Say I'm a new grad with zero internships" was answered from the real profile. | C15 | Yes (brain prompt). |
| **The roast became a fill-in template.** | C21f | Yes (brain prompt). |
