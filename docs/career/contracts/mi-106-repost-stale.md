# CONTRACT — MI-106: repost and stale semantics absent from the feed identity model (121)

**Written:** 2026-10-16, Crew A (module 121). **Done-test source:** MI-106 on the master list.
**Spec:** Spec 2 §2.5 — "Store first_seen_at forever; if a job disappears and reappears within
60 days treat it as the same job with a 'reposted' flag. Flag jobs older than 60 days at
first sight as 'possibly stale'."

## Defect statement (mechanism)

121's snapshot keyed history by job_id alone and `diffNew` compared only the LAST
snapshot's job_ids:

1. **Sequential repost double-alerts.** A posting that closed (absent from one snapshot)
   and reappeared — even under the SAME job_id — was absent from the prior snapshot's
   job_ids, so `diffNew` fired it as new and 151's `runWatchCycle` (which alerts exactly
   `poll`'s new_postings) alerted the same seat a second time. No `closed_at` was ever
   recorded, so no 60-day window could even be measured.
2. **Republished req = brand-new record.** A repost under a NEW req id got a fresh
   history entry and a fresh `first_seen`, violating "store first_seen_at forever" and
   splitting one seat across two records.
3. **No possibly-stale verdict.** `qualityFlags` had one age verdict ("stale" at ≥60
   days, whenever evaluated). A posting first seen today but dated >60 days by its
   source — the aggregator-surfaces-old-postings case §2.5 names — carried no
   first-sight flag, and nothing carried any stale flag into the reminder (152).

## Fix shape

**121 (`packages/domain/121-career-jobs.js`)**
- History entries gain `dedupe_key`, `job_ids[]` (canonical id + folded aliases),
  and `closed_at` (set on the present→absent transition; the 60-day window is
  measured from it). `first_seen` is never overwritten.
- `classifyAgainstHistory(posting, history, now)` resolves a posting to its canonical
  record: by id/alias, or — for a fresh req id — by dedupeKey against an ALREADY-CLOSED
  record. Inside 60 days of the close: repost (fold: alias recorded, `repost_count++`,
  no new history record). After 60 days: new cycle (`cycles++`, still not new-record).
- `poll()` annotates every posting `reposted / repost_count / canonical_job_id /
  possibly_stale / first_seen_at` from the PRIOR history, excludes reposts from
  `new_postings`, and returns them separately as `reposted_postings` (suppressed
  loudly, never silently dropped). A mass-close suspect poll writes no `closed_at`
  (an outage is not a close, §2.3).
- `qualityFlags(posting, {first_seen})`: at first sight, age >60 days yields the hedged
  code `possibly_stale` ("possibly stale — first seen today but dated N days ago");
  a watched posting aging past 60 days keeps the plain `stale` code. The two never
  co-fire. `diffNew(current, prior, now)` takes the time explicitly for the window.

**Layer boundary (found by this build's own first cut — see Results):** a NEW req id
for a seat whose record is still PRESENT is not classified by 121. That shape is a
simultaneous swap (old req vanishes in the same poll the new one appears) or seat
growth, and it belongs to 151's BUG-092 alert-history layer / 152's seat layer, which
absorb a swap and record the alias they need to let a later additional req alert.
121's fold also never fires while the seat is live under another canonical record.

**Propagation (additive fields only):** 151 `composeAlert` copies `reposted /
repost_count / possibly_stale / first_seen_at` onto the alert record; 152
`normalizeCandidate` preserves them, `composeReminder` stamps `possibly_stale /
reposted / repost_count` on the reminder record, and `speakLine` names it:
"Possibly stale: this posting was first seen today but its source dates it more
than 60 days old."

## Done-test

`tests/career-mi106-repost-stale.test.cjs` (tier 2, engine under harness):
R1 same-id close→reappear inside 60d: one history record, reposted flag, zero
new_postings. R2 new-req close→reappear inside 60d: folded into the original record
(canonical_job_id, alias in job_ids, first_seen preserved), zero new_postings, and
the alias does not re-fire next poll. R3 reappear 65 days after close: fires as new,
no reposted flag. R4 end-to-end through 151 `runWatchCycle`: exactly one alert
across appear→close→reappear. R5 layer-boundary guard (below). S1–S4 possibly-stale
at the poll layer, in `qualityFlags`, and in the 152 reminder record + spoken line —
flagged, never suppressed; fresh postings carry no flag. U1/U2 snapshot/diff units.

## Results (2026-10-16, Crew A)

- **Fail-first:** the MI-106 suite ran **1/9 before the fix** (only the beyond-window
  pin passed — it pins pre-existing behavior).
- **First-cut defect (bug law):** MI-106 v1 folded against any closed dedupeKey record
  and broke BUG-092's "simultaneous second req still alerts" (Lane A alert numbers
  moved — exactly what the done-test forbids). Mechanism: after a simultaneous swap
  the dead req's closed record stayed a fold candidate while the seat lived on under
  the swap's id, and ate the next new req. Fixed by the layer boundary + live-seat
  guard above; **R5 is its permanent fail-first guard**, and an allocation request
  for this defect's BUG/FR numbers is filed in the reports log (Crew A allocation —
  lanes request, never self-allocate). The same request covers defects 1–3 above
  (the MI-106 defect cluster itself).
- **Post-fix:** MI-106 suite **11/11**; consumer suites (career-jobs,
  dedupe-clean-copy, tn1a-feed-path, alert-watch, alert-watch-scale, assign,
  discover, MI-117, prompt-injection, MI-028, router-bundle) green. Full sweep
  (`node --test tests/*.cjs`): **4,306 / 4,264 pass / 3 fail / 39 skipped** vs
  the v224 baseline record **4,295 / 4,253 / 3 / 39** — the delta is exactly
  the 11 new MI-106 tests, all passing; fail and skip counts unmoved. The 3
  failing files (portal-submit-integrity Chromium-as-root environment tests +
  the C37 gauntlet pair) fail identically on the pristine v224 tree
  (same 37/11 split on the three files, identical failing test names) —
  pre-existing, not this build.
- **Boundary kept:** no deploy, no sends, no submissions; 151/152 edits are
  additive field propagation only — no gate, suppression-window, or cadence
  behavior changed there.
