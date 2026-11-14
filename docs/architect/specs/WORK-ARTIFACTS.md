# Work artifacts: files the person can open, built from a model, checked by execution (spec, 2026-11-14)

Owner directive (2026-11-14, architect's chat, with benchmark pack 01, cases 0009-0023): "make sure trainee does
everything here but on a deeper level, find out what a deeper level is and implement".

The pack holds 15 multi-round practice conversations. In each, the person asks for a real file and then adds
constraints over two or three rounds. The files are:

| Case | What the person asks for |
|---|---|
| 0009 | A cohort workbook in Excel, plus a memo |
| 0010 | A SQLite take-home |
| 0011 | An offer packet |
| 0012 | An A/B test deck |
| 0013 | An interview story |
| 0014 | A Python reconciliation |
| 0015 | A capacity plan |
| 0016 | An offline portfolio |
| 0017 | A dashboard scope |
| 0018 | Application answers with character limits |
| 0019 | A Git recovery script |
| 0020 | A confidential portfolio |
| 0021 | A job triage |
| 0022 | An interview time proposal with a calendar file (ICS) |
| 0023 | A composition analysis with tests |

The pack itself says its final artifacts are evidence, not answers to copy. Each case records the limits and failures
that were still open when it ended.

The pack is not committed. This repository is public, and the pack's reading rules forbid publishing case 0020's
confidential inputs. Fixtures in tests are written fresh: fictional, and never copied from 0020.

## What Trainee has today (analysis of the repo, 2026-11-14)
- **Delivered as files:** a tailored resume in PDF or DOCX (`_shared/channel_artifacts.ts`), and plain-text attachments
  (`agent/attach_tool.ts`).
- **Hosted File pages:** fixed kinds (`agent/file_kinds.ts`), where every fact cites the person's real profile.
- **Nothing makes:** an XLSX, a PPTX, an ICS, a code bundle, a general memo DOCX or PDF, or an offline HTML file.
- **Nothing executes** code or tests. `agent-exec` is the frozen Upmore archive (D-006), so it cannot be reused.
- **No case, constraint ledger, version store or version diff.**
- **Practice inputs are not kept apart from the profile.** Only prompt rules cover them (`prompt.ts:133`,
  `turn_notes.ts:28`, `career_offer.ts` NOT_OWN). A fictional person's facts could be saved as the person's own,
  which would break D-007.

## The deeper level: nine rules
"Deeper" does not mean more polish. Each rule below closes a limit or failure the pack recorded, and each is enforced by
code and tested.

1. **D1, computed and never typed.** Every number in an artifact is a cell of the artifact's typed model, evaluated by
   code. A number in prose is a reference to that cell (`{{ref:net_cash}}`), not text the model typed. A number in a
   draft that matches no cell is refused.
   - Closes: 0011 (17,280 + 2,000 printed as 19,200, then "downstream figures stand"); 0013 (an unsupported "30%");
     0017 and 0018 (counts claimed, not computed).
2. **D2, checked by execution and never by assertion.** Before delivery:
   - Spreadsheet formulas are evaluated by an independent evaluator and compared cell by cell with the model.
   - Code bundles run their tests in the sandbox.
   - ICS files are linted.
   - Documents are rendered, and every page is checked for clipping.
   - Word, character and speaking-time counts are computed.
   A claim such as "tests pass", "no errors" or "fits one page" can come only from a check log.
   - Closes: 0010, 0014, 0019 and 0023 (tests claimed); 0015 (sheets printed clipped twice); 0022 (CLASS:PRIVATE
     missing, an unescaped ";"); 0009 (recalculation checked only in LibreOffice).
3. **D3, tests that can fail.** Every code bundle ships mutation controls: deliberately corrupted copies of its code. A
   bundle is delivered only when its tests pass on the real code and fail on every mutant. The log of both runs is part of
   the proof.
   - Closes: 0019 (the corrupted control was done by hand, once); 0023 (a Decimal(28) false pass, a hardcoded row count).
4. **D4, a constraint ledger across rounds.** Every constraint the person states becomes a ledger row: round, words,
   kind (hard, preference, permission, output), status (active, superseded, revoked), and what it supersedes. Every new
   version is checked against every active row. A revoked value is searched for in every part of the bytes, including
   metadata, filenames, alt text and derived forms (percent, before/after, rounded). The audit names categories, never the
   values.
   - Closes: 0020 (an overbroad "zero XML matches" claim); 0021 (follow-ups that override the ads); 0009 (G marked
     pending, never zero); 0013 (a correction carried to every section).
5. **D5, version diffs with invariants.** Each round's version gets a diff made by code: every changed cell and claim,
   with the round and constraint that changed it. Each round also gets invariant checks for what must not change. In
   0009 the mature baseline stays the same when G is added; checks are per row and per stage, at full precision with a
   stated tolerance, so offsetting edits are caught.
   - Closes: 0009 (aggregate checks miss offsetting edits); 0013 and 0018 (corrections that must reach everything).
6. **D6, practice isolation, enforced by code.** A case marked practice (a fictional person, or inputs the person calls
   separate from their history) has its own namespace. Nothing is read from the profile into it, and nothing is written
   from it to the profile, the stated answers or the application rails. Any attempt throws and is logged. The person's
   real profile is never named in a practice artifact.
   - Closes: every case's "isolated practice inputs" rule, and D-007.
7. **D7, delivery stays inside the channel.** A table of accepted file types per channel decides how a file is sent.
   The order is:
   1. the file itself;
   2. Trainee's own owner-scoped page for the file (`trainee-file`, signed and expiring);
   3. a plain-text builder with a SHA-256 manifest.
   No third-party upload, link sharing, publishing or account change is ever used, and a test proves that a refused type
   causes zero external tool calls. The reply says that copies already sent cannot be recalled.
   - Closes: 0010 and 0019 (WhatsApp refused the ZIP, then an unauthorised Drive upload with link access briefly opened).
8. **D8, proof and limits written by code.** Every delivered version carries a report built from the check log:
   - each check run, with its result;
   - each check not run, with the reason (for example "native Excel not tested");
   - the remaining limits, from a registry of limits for each artifact kind plus this case's own limits.
   The reply's claims are bounded by this report (D-024).
9. **D9, integrity checks the pack listed as open limits.** These checkers are built in, not left to the model:
   - funnel monotonicity (retained ≤ activated ≤ acquired);
   - dynamic ranges, so a newly mature cohort is included;
   - a cap so a refund never exceeds the paid amount (0010);
   - cash-flow feasibility over time (0011);
   - power for joint gates, and standardization or Simpson's-paradox checks (0012, 0023);
   - a capacity solver with an infeasibility proof (0015);
   - UTC offsets per date across DST, and exact buffer checks (0022);
   - per-constraint verdicts (meets, unknown, conflict) with precedence, where a newer follow-up overrides an older ad
     and "none actionable" is a valid result (0021).

## Interfaces (the acceptance tests are written against these)
`supabase/functions/_shared/work/`
- `case.ts`
  - `newCase({ owner, practice, title, now })` returns a `WorkCase`.
  - `addRound(c, { round, text, constraints[] })`.
  - `ledger(c)`.
  - `active(c)`.
  - `revoked(c)`.
  - `profileGuard(c)` returns `{ read(), write() }`. Both throw `PracticeIsolation` when `c.practice`.
- `model.ts`
  - The typed artifact model: `cells` (id, value or formula, unit, format) and `text` blocks holding `{{ref:id}}` slots.
  - `evaluate(model)` returns values.
  - `render(text, values)`. A ref with no cell throws.
  - `loose(numbers in prose)` lists the numbers that match no cell.
- `versions.ts`
  - `saveVersion(c, { kind, model, files })` returns `{ version, diff, invariants }`.
  - `diff(a, b)` returns `[{ path, before, after, round, constraint }]`.
  - `invariant(name, fn, tol)`.
- `revoke_scan.ts`
  - `scan(files: Record<name, Uint8Array>, values[])` returns hits by part. It unzips OOXML parts and checks metadata,
    filenames, alt text and derived forms.
- `deliver.ts`
  - `chooseDelivery(channel, mime)` returns `"native" | "file_page" | "text_builder"`.
  - `deliver()` uses only `channel_artifacts` and `trainee-file`.
- `proof.ts`
  - `report(checks[], limits[])` returns the report text.
  - `boundClaims(reply, report)` refuses a claim of a check that was not run.
- `xlsx.ts`
  - `writeXlsx(book)` (a book of sheets, charts and expected values, as `cohortWorkbook` returns) writes OOXML with live formulas, defined names, tables and charts.
  - `formula.ts`: the independent evaluator for the formula subset `xlsx.ts` emits (`SUM`, `SUMIFS`, `IF`, `IFERROR`,
    `ISNUMBER`, `ABS`, `AND`, `OR`, arithmetic).
- `docs.ts`
  - `writeDocx(model)` and `writePptx(deck)` (speaker notes, charts whose cached values are the model's cells). A typed number matching no cell throws `LooseNumber`.
  - `writePdf(model)`.
  - `pages(pdf)` returns `{ count, clipped }` for the clipping check; `counts(text)` returns words, characters and seconds at 150 wpm.
- `ics.ts`
  - `writeIcs(events)`.
  - `lintIcs(text)`: CRLF line ends, folding at 75 octets, escaping, UTC, CLASS, and no METHOD for a hold.
  - `offsetOn(zone, date)`.
- `bundle.ts`
  - `writeBuilder(files)` writes a text builder with a SHA-256 manifest that refuses to overwrite.
  - `runInSandbox(bundle, cmd)` returns a log.
  - `mutants(bundle)` returns the mutation controls.
- `checks/`
  - `funnel.ts`, `cashflow.ts`, `stats.ts`, `capacity.ts`, `triage.ts`.

## Rules that do not move
- No external effect: no send, no submit, no publish, no account change, no calendar import. Approval of the exact
  payload is still required (D-MS-1).
- No password or code passes through chat.
- Never automate LinkedIn or Indeed: triage reads only excerpts the person pastes.
- Spend: generating and checking artifacts is code at $0 per turn. The model calls are the turn's normal calls. The
  15-case eval is new spend, and the owner approves it.

## Open decision for the owner: where code runs (WO-126)
Two options need measuring before the owner decides:
- **(a) Pyodide (WASM Python, which includes sqlite3) inside an edge function.** No new vendor and no network, but
  memory and cold-start limits need measuring.
- **(b) An external sandbox (for example Vercel Sandbox or E2B).** A new vendor, a new credential and new spend.

WO-126 is a $0 measurement of option (a) that reports the numbers. Until the owner rules, a bundle is delivered with
"tests not run here" in its report. It is never delivered with a claim that the tests ran.
