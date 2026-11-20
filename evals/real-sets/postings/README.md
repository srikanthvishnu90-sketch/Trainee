# Recorded real postings (inputs for items 3 and 13)

35 public postings, captured once on 2026-11-12 by `capture.ts` from this build environment: Greenhouse 14, Lever 6, Ashby 6,
SmartRecruiters 5, PayPal Workday 4. They are early-career and analyst titles in US places (plus two places the filter let
through: Coinbase in Australia and Dropbox in Poland, kept as real non-USD pay). The capture made read-only GETs, plus Workday's
public search POST, one request every 1.2 s, with the user agent "Trainee measurement set (read-only; contact: unset)". There was
no sign-in and no application.

- `recorded/<provider>-<board>-<id>.json`: the posting's own API answer, byte for byte. For Ashby, the job's object is cut from the
  board's answer (a board is several MB); the board body's sha256 is in `sources.json`.
- `sources.json`: for each file, the request, the time, the HTTP status and the sha256.
- `postings.ts`: turns each file into the row the product stores, with the product's own readers: the bundle's normalizers,
  `plainText` and `boardPay` (as `ingestBoards` does), and `parseWorkdayCxs` for Workday. It refuses a file whose sha256 changed.

Re-capture (it picks the same way, the first matching postings by id, but boards change): `deno run -A --no-check evals/real-sets/postings/capture.ts`
