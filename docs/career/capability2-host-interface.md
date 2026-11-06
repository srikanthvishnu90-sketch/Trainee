# Capability 2 host handoff (source only, 2026-10-15)

This branch builds on release/career-v223 `afc460ec872f61eb2dcdbbca4d34140fb8b345c0`
and bundle contribution `005aae50cc2d3495c80cc4bb661114f059e66cec`.
Muse owns integration, final merge and deployment. No shared branch is changed.

## What is implemented

Module 154 is a pure recommendation/source-validation adapter, included before
144 in both generated bundles. Module 144's generic path and skill-gap plans use
it. A nine-line dispatch seam in 142 serves read-only resume/role, skill-gap,
location and current-opening requests after state ownership and pause gates.
Alert management and application/email actions retain their existing owners.

Only confirmed uniquely identified facts are cited. Legacy facts with absent
status and no confirmation flag remain accepted for compatibility with existing
curated profiles; `draft`, `rejected` and ambiguous IDs are excluded. A skill
list alone is self-report. Evidence requires confirmed work/project/credential
text or a resolvable supporting fact, never a dangling evidence string. Missing
evidence is not a finding that the person lacks the skill. Role suggestions are
hypotheses with inspectable work samples and tradeoffs; they establish neither
seniority, licensing, academic completion nor eligibility. Recipe tasks are
explicitly different from a specific employer's requirements.

The deterministic English recipe catalog covers operations, administration,
support, sales, communications, legal support, compliance, finance/accounting,
business operations, software, analytics and healthcare administration. It is
not a market dataset, an exhaustive occupation taxonomy, a career fit score or
an automatic eligibility screen. Interest, seniority, compensation and regulated
credentials need separate confirmation. No demand, salary, immigration, legal
qualification or city ranking is invented.

## Required inputs from the host

Use `CareerHost.createTurnCtx({ userId, threadId, now, snapshot, profile, postings })`.
The existing host supports these options, but `handler-career.ts` currently calls
it with the snapshot and clock only. The saved snapshot can restore a profile;
there is no fresh profile/posting/upload injection wired in that handler.

- `profile`: authenticated user's canonical master profile (122 shape), with
  stable `id` or `fact_id`, confirmation flags/status and original fact source.
  Do not treat a client-submitted profile as an already confirmed profile.
- `now`: finite epoch milliseconds from the host clock. The adapter performs
  no clock reads; a missing clock makes freshness unknown.
- `profile.preferences.locations`: normalized exact work locations, not inferred
  from residence. `constraints.remoteOnly` and `constraints.relocation` are
  explicit user constraints. Location matching is deliberately exact after
  case/whitespace normalization; normalize aliases upstream. Remote rows still
  need verified hiring geography. Residence is used as a scope only when the
  user has explicitly disallowed relocation and supplied no work preferences.
- `postings`: trusted, normalized observations from a host-owned public read
  adapter. Each row needs `id`, `title`, optional `company`, `location` or string
  `locations[]`, `mode`, and the provenance envelope below. Optional `paid:true`
  is required for a paid-only search. Free-text compensation is not parsed.

```js
{
  id: "employer-requisition-id",
  title: "Operations coordinator",
  company: "Employer",
  location: "Chicago, IL",
  mode: "onsite",              // remote only when employer explicitly says so
  paid: true,                 // only when verified; omission remains unknown
  status: "open",             // explicit observation, never inferred from a URL
  source_kind: "live_public",
  source_url: "https://employer.example/careers/requisition",
  observed_at: "2026-10-15T11:00:00Z",
  requirements: [
    { skill: "Excel", level: "required", text: "Exact employer wording" },
    { skill: "SQL", level: "preferred", text: "Exact employer wording" }
  ]
}
```

`freshness(row, now)` accepts flat envelope fields or nested
`source:{kind,url,observed_at}`. It requires HTTPS, explicit open state and an
observation no more than 24 hours old, with no future timestamps. Fixture flags,
fixture/snapshot source kinds/paths and example/test URLs always fail closed.
`openingRecommendations` supplies exclusion reasons, role fact IDs, requirement
comparisons, URL and observation time. A fresh observation establishes only
what the source showed at that time; eligibility remains unknown and openings
can close later. Structured requirements must preserve exact wording and
required/preferred/unknown level; the adapter does not infer these from token
presence in a description. Missing provenance or an empty pool returns
`no_verified_matching_openings`, explicitly spoken as unverified. There is no
filesystem job-corpus fallback in this recommendation path.

## Resume extraction and confirmation seam

`CareerRecommendations.ingestResume(ctx, input)` calls the existing plain-text
122 ingest on a clone, preserves extra profile fields, and returns draft facts,
confirmation requirements and draft-safe recommendations. It never confirms
facts or saves state. It returns typed ingest failures for PDF/DOCX/binary or
empty content, using 122's existing contract. A host extraction service may
supply extracted text with provenance; extraction does not make it confirmed.
The host must show the extracted facts for user confirmation, merge only the
confirmed facts with canonical correction precedence, and inject the resulting
profile on later turns. No handler/storage migration is included here.

## Ownership and remaining integration work

Crew A owns canonical profile/memory and atomic state/alert persistence. The
browser task owns execution. This branch changes none of career_host.js,
handler-career.ts, migrations, alerts state, browser execution or credentials.
Muse must connect authenticated profile lookup/confirmation and trusted public
posting observations to the host interface above before live recommendations
can be claimed. A request body containing jobs is not a trusted source adapter.

The local ESM-only staged HTTP test uses the real entry, handler, bundle and
host, with only serve and Supabase replaced by in-memory stand-ins. It proves
saved-profile restoration and empty-pool honesty, not a real database, upload
service, public-source fetch, Deno deployment or end-user live flow. Direct host
tests separately prove fresh observations and skill gaps. No paid model call,
Browserbase, employer application, email or production write was performed.

## Independent-review follow-up (2026-10-16)

`3157b65` is **not ready**: the independent frozen cohort found 11 failures,
including the inherited module 130 cross-owner cache leak now assigned to
Crew A. This follow-up fixes the ten capability-2-owned boundaries. H20 stays
unchanged and failing in the original frozen runner; the normal regression suite
marks it as pending rather than calling it passed. The independent cohort is
22 targeted boundary assertions, not an accuracy or launch score. The original
private 50-case evaluator was not recovered or recreated.

Evidence now requires an explicit work relation and retains the exact quote,
field and offsets. A recruiter mentioning Python engineers is not Python skill
evidence. Negative statements, including contractions and zero experience, block
positive findings. Active positive/negative records produce `conflicted`, with
both IDs and the denial recorded; timestamps alone do not resolve the conflict.
Only explicit canonical supersession by confirmed records, or a corrected active
fact, removes superseded authority. This is conservative deterministic English
matching, not a general semantic proof system. Ambiguous mentions remain unknown.

Legacy `fact_id` values become the matching `id` on the ingestion clone; they
never acquire an unrelated F-number. Conflicting/missing canonical IDs are a
typed `canonical_id_required` refusal until the host resolves them. Existing
source hashes/evidence links and extra profile metadata remain intact. Extraction
still creates drafts; no host or confirmation receipt is fabricated.

Observation selection now coalesces by canonical employer/requisition identity
before matching. Numeric/string requisition aliases normalize alike. The newest
trusted closed observation suppresses old open rows; a same-time closed row wins.
Conflicting same-time open rows fail closed. The newest row never borrows old
location or requirement fields. Even without location preferences, absent or
placeholder remote geography is excluded. Parsed reserved example.com/org/net
hosts (including subdomains and trailing-dot spelling), localhost and .test
sources fail closed. Synthetic .invalid URLs are only local-test stand-ins;
a production loader must establish actual source provenance and an approved
source origin, not trust a `live_public` string sent by a client.

Mechanical design/verification, supervised electrical installation/maintenance,
teaching/instructional content, and graphic/publication design now have distinct
recipes. Work-sample and gap fields cite the applicable evidence; no license,
software brand, independent trade authority or credential is inferred.

### Minimal integration into the existing atomic path

No recommendation table or new migration is needed. The integration owner must:

1. Load the authenticated owner's canonical profile, stable IDs, active
   corrections, `profile_revision` and `privacy_epoch`. Apply account location
   corrections before recommendation. Never grant confirmation based on body
   facts, client flags or an ambient correction cache. Module 130's owner-bound
   correction/rollback repair belongs to Crew A, outside this source branch.
2. Inject validated `skill`, `hoursPerWeek`, `targetRole`, selected `posting_id`
   and explicit geography, plus the latest trusted observation per requisition.
   The recommendation route also extracts simple explicit skill/budget wording
   locally (SQL, one hour/week, 90 minutes/week, etc.). Multiple/conflicting or
   unparsed budgets require clarification. It never substitutes a generic skill
   for an explicit named one. Message-derived fields are already covered by the
   existing message turn hash; any independently supplied typed fields must be
   included in that same stable idempotency hash.
3. Preserve `out.result.artifact` and its versioned `grounding` envelope through
   the existing `career_host_commit` response receipt and idempotent replay.
   The envelope carries profile revision/epoch (null if the loader omitted them),
   fact IDs, exact supporting relations, original source hashes/spans when
   available, conflicts, posting observations and uncertainty. Null provenance
   is not a verified source. Enforce the existing bounded JSON response contract,
   and extend response validation for this read-only artifact. Persist the
   profile, artifact/provenance and reply in the same atomic transaction; do not
   introduce another save path. Erasure fences/tombstones must cover the artifact
   and cached response, not only its prose.

The current source branch deliberately leaves handler/host/storage/130 unchanged.
A local scratch composition with atomic owner commit `bfd8577` is compatibility
validation only; trusted uploads, live posting reads, canonical correction and
artifact response retention still need integration by their respective owners.
