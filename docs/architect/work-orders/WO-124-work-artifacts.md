# WO-124: work artifacts (files built from a model, checked by execution, delivered inside the channel)

## Why
The owner asked on 2026-11-14 that Trainee "does everything" in benchmark pack 01 (cases 0009-0023), "on a deeper level".

The spec is `docs/architect/specs/WORK-ARTIFACTS.md`, and it defines that deeper level as rules D1-D9. Each rule closes a
limit or failure the pack recorded.

Today Trainee can deliver a resume PDF or DOCX, plain text, and fixed-kind File pages. It can't build or check anything
else the pack asks for.

## Orders
This is one order per PR, in this sequence. Each PR stays within 800 changed lines or 25 files.

| Order | What | Files | Acceptance tests (written first) | Depends |
|---|---|---|---|---|
| 124a | Core: the case and its practice isolation (D6), the constraint ledger (D4), the typed model with `{{ref}}` slots and loose-number detection (D1), versions with diff and invariants (D5), the revoke scan (D4), delivery choice inside the channel (D7), and the proof report with claim bounding (D8) | `_shared/work/{case,model,versions,revoke_scan,deliver,proof}.ts` | `tests/architect/pending/work-artifacts-core-20261114.test.ts` | none |
| 124b | XLSX writer (live formulas, defined names, a chart), the independent formula evaluator, and the cohort workbook builder | `_shared/work/{xlsx,formula}.ts` | `work-artifacts-xlsx-checks-20261114.test.ts`: the workbook and baseline tests | 124a |
| 124c | Checkers: funnel, triage, capacity, cash flow; ICS writer, lint, and offset for each date | `_shared/work/checks/*.ts`, `_shared/work/ics.ts` | `work-artifacts-xlsx-checks-20261114.test.ts`: the checker tests | 124a |
| 124d | DOCX, PPTX and PDF from the model (speaker notes, charts bound to data), page clipping check, and word, character and speaking-time counts | `_shared/work/docs.ts` | added in 124d's PR, written before its code | 124a |
| 124e | A tool for the brain: `make_work_file` (opens or continues a case, records the round's constraints, builds, checks, delivers, and returns the proof report). Wired into `career_brain` behind the release flag `WORK_ARTIFACTS` (default off until the owner switches it on) | `agent/work_tool.ts`, `release_config.ts` | a production-shaped turn: a practice case in WhatsApp, a refused ZIP, and zero outside calls | 124a-d |
| 124f | Spike, $0: Pyodide (Python with sqlite3) in an edge function. Measures cold start, memory and run time on a 40-test bundle. Report only, no product code | `docs/architect/specs/SANDBOX-SPIKE.md` | numbers in the report | none |
| 124g | Code bundles: text builder with a SHA-256 manifest that refuses to overwrite; tests run in the sandbox the owner chose; mutation controls that must fail (D3) | `_shared/work/bundle.ts` | added once the owner rules on 124f | 124f, owner |
| 124h | Pack eval: the 15 cases as multi-round conversations, plus 15 held-out variants from a separate writer, scored by the checks above and the judge | `evals/work/` (fixtures written fresh; the pack itself is not committed) | the score log | 124a-e; owner approves the spend |

## Interfaces
See the spec, section "Interfaces". The tests are written against those interfaces, and the code must meet them.

## Demo the owner can run
After 124e, open a practice conversation in the text simulator and ask for "an Excel cohort workbook from these invented
numbers". Three things should happen:
- Trainee replies with an `.xlsx` the person can open, and a proof report from code: what was recomputed and the limits.
- When the person adds an immature cohort in round 2, the next version comes with its diff and the baseline invariant.
- Ask for a ZIP over WhatsApp. Trainee sends its own expiring page or a text builder. It never uploads anywhere else.

## Out of scope
- Sending, submitting or publishing anything.
- Importing into a calendar.
- Any third-party storage.
- LinkedIn or Indeed.
- Writing a practice case's facts into the profile.
- Running code before the owner rules on 124f.

## Spend
- 124a-124g cost $0, as code and tests only.
- 124h is model spend that needs the owner's written yes. The current cap is $93 (D-085), and about $3 of it is left.
