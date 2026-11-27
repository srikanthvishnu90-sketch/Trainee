// MI-106 — repost / stale-posting semantics in module 121 (Spec 2 §2.5, Crew A).
// Done-test (master list MI-106):
//   (1) a replay pair (posting closes, reappears inside 60 days) produces ONE
//       record with a reposted flag and NO second alert (poll new_postings is
//       the alert source for 151's runWatchCycle — a repost must not re-enter it);
//   (2) a first-seen posting whose source dates it >60 days old is flagged
//       possibly-stale in the reminder (121 quality flag -> 151 alert record ->
//       152 reminder record + speakLine);
//   (3) Lane A catch/false-alert numbers unmoved — pinned here by the fresh-
//       posting and beyond-window cases: a genuinely new posting still fires,
//       and a reappearance AFTER the 60-day window is a new opening, not a repost.
// Spec 2 §2.5 verbatim rules: "Store first_seen_at forever; if a job disappears
// and reappears within 60 days treat it as the same job with a 'reposted' flag.
// Flag jobs older than 60 days at first sight as 'possibly stale'."
// Check: node --test tests/career-mi106-repost-stale.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const J = require(path.join(__dirname, "..", "packages/domain/121-career-jobs.js"));
const Assign = require(path.join(__dirname, "..", "packages/domain/152-career-assign.js"));
const Watch = require(path.join(__dirname, "..", "packages/domain/151-career-alert-watch.js"));

const DAY = 86400000;
const T0 = Date.parse("2026-08-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function ghJob({ req = "REQ-1", title = "Software Engineer, New Grad", postedMs = T0 } = {}) {
  return {
    name: "Stripe",
    jobs: [{
      id: 555001, title, location: { name: "San Francisco, CA" },
      absolute_url: `https://boards.greenhouse.io/stripe/jobs/${req}`,
      first_published: iso(postedMs), updated_at: iso(postedMs),
      requisition_id: req, departments: [{ name: "Engineering" }],
      content: "&lt;p&gt;Join our team building payments in Python and React. Salary range $120,000 - $150,000.&lt;/p&gt;",
    }],
  };
}
const EMPTY = { name: "Stripe", jobs: [] };
function memStore() {
  const kv = new Map();
  return { get: (k) => kv.get(k) || null, set: (k, v) => kv.set(k, v), _kv: kv };
}
const fetchOf = (payload) => async () => ({ status: 200, json: async () => payload });
async function poll(store, payload, now) {
  return J.poll([J.feeds.greenhouse("stripe")], { fetch: fetchOf(payload), store, now });
}

// ---------- (1a) same job_id: closes, reappears inside 60 days ----------
test("MI-106 R1: same-id repost inside 60d — one record, reposted flag, no second alert", async () => {
  const store = memStore();
  const p1 = await poll(store, ghJob(), T0);
  assert.equal(p1.new_postings.length, 1, "first sight is new");
  const jobId = p1.postings[0].job_id;

  const p2 = await poll(store, EMPTY, T0 + 10 * DAY); // closed
  assert.equal(p2.postings.length, 0);

  const p3 = await poll(store, ghJob({ postedMs: T0 + 20 * DAY }), T0 + 20 * DAY); // reappears, day 20
  assert.equal(p3.postings.length, 1, "the reappearing posting is still listed once");
  assert.equal(p3.new_postings.length, 0, "a repost inside 60 days must NOT fire a second alert");
  assert.equal(p3.postings[0].reposted, true, "reposted flag on the record");
  assert.equal(p3.postings[0].repost_count, 1);
  assert.equal((p3.reposted_postings || []).length, 1, "the suppressed repost is reported as a repost, not dropped silently");
  assert.equal(p3.reposted_postings[0].job_id, jobId);

  const hist = p3.snapshot.history;
  const entries = Object.values(hist).filter((h) => h.dedupe_key === J.dedupeKey(p3.postings[0]) || h.job_ids && h.job_ids.includes(jobId));
  assert.equal(Object.keys(hist).length, 1, "one history record for the seat");
  assert.equal(hist[jobId].repost_count, 1);
  assert.equal(hist[jobId].first_seen, iso(T0), "first_seen_at stored forever (Spec 2 §2.5)");
  assert.equal(hist[jobId].present, true);
});

// ---------- (1b) new req id: the employer republishes under a fresh req ----------
test("MI-106 R2: new-req repost inside 60d folds into the original record — no second alert", async () => {
  const store = memStore();
  const p1 = await poll(store, ghJob({ req: "REQ-1" }), T0);
  const origId = p1.postings[0].job_id;
  await poll(store, EMPTY, T0 + 5 * DAY); // closed

  const p3 = await poll(store, ghJob({ req: "REQ-2", postedMs: T0 + 30 * DAY }), T0 + 30 * DAY);
  assert.equal(p3.new_postings.length, 0, "a republished req for the same seat inside 60 days is a repost, not a new opening");
  assert.equal(p3.postings.length, 1);
  assert.equal(p3.postings[0].reposted, true);
  assert.equal(p3.postings[0].canonical_job_id, origId, "the record keeps the original identity");
  const hist = p3.snapshot.history;
  assert.equal(Object.keys(hist).length, 1, "one canonical history record, not one per req id");
  assert.ok((hist[origId].job_ids || []).includes(p3.postings[0].job_id), "the new req id is recorded as an alias of the one record");
  assert.equal(hist[origId].first_seen, iso(T0));
  assert.equal(hist[origId].repost_count, 1);

  // And the alias must not re-fire on the NEXT poll either.
  const p4 = await poll(store, ghJob({ req: "REQ-2", postedMs: T0 + 30 * DAY }), T0 + 31 * DAY);
  assert.equal(p4.new_postings.length, 0);
});

// ---------- (3) beyond the window: a reappearance after 60 days IS new ----------
test("MI-106 R3: reappearance after the 60-day window is a new opening and fires", async () => {
  const store = memStore();
  await poll(store, ghJob(), T0);
  await poll(store, EMPTY, T0 + 10 * DAY); // closed at day 10
  const p3 = await poll(store, ghJob({ postedMs: T0 + 75 * DAY }), T0 + 75 * DAY); // 65 days after close
  assert.equal(p3.new_postings.length, 1, "outside 60 days the reappearance is a new opening");
  assert.notEqual(p3.postings[0].reposted, true, "not flagged as a repost");
});

// ---------- (1c) end-to-end through 151: the alert itself does not re-fire ----------
test("MI-106 R4: 151 watch cycle alerts once; the within-60d repost alerts zero times", async () => {
  const store = Watch.createMemoryStore();
  const delivered = [];
  const sink = async (r) => { delivered.push(r); };
  const profile = {
    skills: [{ name: "Python", proven: true, fact_id: "F-1" }, { name: "React", proven: true, fact_id: "F-2" }],
    level: "student", experience_years: 1,
    constraints: { work_authorization: "US citizen", needs_sponsorship: false, graduation_year: 2028, clearance: null, locations: ["San Francisco"] },
    preferences: { role_families: ["SWE"], locations: ["San Francisco"], starred_companies: [] },
  };
  let payload = EMPTY;
  const cycle = (now) => Watch.runWatchCycle({ feeds: [J.feeds.greenhouse("stripe")], fetch: fetchOf(payload), profile, store, sink, now });
  await cycle(T0); // seed: empty board
  payload = ghJob();
  const c2 = await cycle(T0 + 1 * DAY);
  assert.equal(c2.alerts_emitted, 1, "the genuine first appearance alerts");
  payload = EMPTY;
  await cycle(T0 + 10 * DAY); // closes
  payload = ghJob({ postedMs: T0 + 20 * DAY });
  const c4 = await cycle(T0 + 20 * DAY); // reappears inside 60 days
  assert.equal(c4.alerts_emitted, 0, "the repost must not alert a second time");
  assert.equal(delivered.length, 1, "exactly one alert across the whole replay");
});

// ---------- layer-boundary guard (defect found by MI-106's own first cut) ----------
// MI-106 v1 folded by dedupeKey against ANY closed record: after a simultaneous
// swap (BUG-092's shape — old req vanishes in the same poll the new req appears,
// absorbed by 151's layer, seat lives on under the new id), the dead record
// stayed a fold candidate and ate the NEXT genuinely-new req for the seat.
// Guard: a closed record never folds while its seat is live under another record.
test("MI-106 R5: after a simultaneous swap, an additional simultaneous req is still new", async () => {
  const store = memStore();
  await poll(store, ghJob({ req: "REQ-1" }), T0);
  const swap = await poll(store, ghJob({ req: "REQ-2", postedMs: T0 + 1 * DAY }), T0 + 1 * DAY); // req1 gone, req2 appears, same poll
  assert.equal(swap.new_postings.length, 1, "a simultaneous swap stays 151/BUG-092 territory at the 121 layer");
  const two = { name: "Stripe", jobs: [ghJob({ req: "REQ-2", postedMs: T0 + 1 * DAY }).jobs[0], ghJob({ req: "REQ-3", postedMs: T0 + 2 * DAY }).jobs[0]] };
  const p3 = await poll(store, two, T0 + 2 * DAY);
  assert.deepEqual(p3.new_postings.map((p) => p.req_id), ["REQ-3"], "the additional req for the live seat is a distinct opening");
});

// ---------- (2a) first-seen old posting: possibly-stale at the 121 layer ----------
test("MI-106 S1: first-seen posting dated >60 days old carries the possibly_stale flag", async () => {
  const store = memStore();
  const p1 = await poll(store, ghJob({ postedMs: T0 - 75 * DAY }), T0);
  assert.equal(p1.new_postings.length, 1, "possibly-stale postings still fire — flagged, not suppressed");
  assert.equal(p1.postings[0].possibly_stale, true);
  const q = J.qualityFlags(p1.postings[0], { now: T0, first_seen: true });
  assert.ok(q.flags.some((f) => f.code === "possibly_stale"), JSON.stringify(q.flags));
  assert.match(q.summary, /possibly stale/i);
  assert.equal(q.possibly_stale, true);
});

test("MI-106 S2: a FRESH first-seen posting is not possibly-stale; a known posting aged past 60d is stale, not possibly-stale", async () => {
  const qFresh = J.qualityFlags({ posted_at: iso(T0 - 5 * DAY), jd_text: "Team. Salary range.", department: "Eng" }, { now: T0, first_seen: true });
  assert.equal(qFresh.possibly_stale, false);
  assert.ok(!qFresh.flags.some((f) => f.code === "possibly_stale"));
  const qKnown = J.qualityFlags({ posted_at: iso(T0 - 75 * DAY), jd_text: "Team. Salary range.", department: "Eng" }, { now: T0, first_seen: false });
  assert.ok(qKnown.flags.some((f) => f.code === "stale"), JSON.stringify(qKnown.flags));
  assert.ok(!qKnown.flags.some((f) => f.code === "possibly_stale"), "possibly-stale is a first-sight verdict only");
});

// ---------- (2b) the flag reaches the reminder ----------
test("MI-106 S3: possibly-stale is flagged in the reminder (152 record + spoken line)", async () => {
  const store = memStore();
  const p1 = await poll(store, ghJob({ postedMs: T0 - 75 * DAY }), T0);
  const posting = p1.postings[0];
  const wp = Assign.createWatchProfile("mi106-user", {
    interests: [{ interest_id: "int-1", role: { soc: "15-1252", title: "Software Engineer", terms: ["software engineer"] }, filters: { locations: ["San Francisco"], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] } }],
    scoring_profile: { skills: [], preferences: {} },
  });
  const res = await Assign.runAssignCycle({ watchProfile: wp, postings: [posting], store: memStore(), now: T0 });
  assert.equal(res.reminders.length, 1, JSON.stringify(res.suppressed));
  const r = res.reminders[0];
  assert.equal(r.possibly_stale, true, "the reminder record carries the flag");
  assert.match(Assign.speakLine(r), /possibly stale/i, "the spoken reminder names it");
});

test("MI-106 S4: a fresh posting's reminder carries no possibly-stale flag", async () => {
  const store = memStore();
  const p1 = await poll(store, ghJob({ postedMs: T0 - 2 * DAY }), T0);
  const wp = Assign.createWatchProfile("mi106-user2", {
    interests: [{ interest_id: "int-1", role: { soc: "15-1252", title: "Software Engineer", terms: ["software engineer"] }, filters: { locations: ["San Francisco"], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] } }],
    scoring_profile: { skills: [], preferences: {} },
  });
  const res = await Assign.runAssignCycle({ watchProfile: wp, postings: [p1.postings[0]], store: memStore(), now: T0 });
  assert.equal(res.reminders.length, 1, JSON.stringify(res.suppressed));
  assert.notEqual(res.reminders[0].possibly_stale, true);
  assert.doesNotMatch(Assign.speakLine(res.reminders[0]), /possibly stale/i);
});

// ---------- snapshot unit legs: closed_at + makeSnapshot repost folding ----------
test("MI-106 U1: makeSnapshot records closed_at and folds a same-id return inside 60d", () => {
  const [p] = J.normalizeGreenhouse(ghJob(), "stripe");
  const s1 = J.makeSnapshot([p], T0, null);
  const s2 = J.makeSnapshot([], T0 + 10 * DAY, s1.history);
  assert.equal(s2.history[p.job_id].present, false);
  assert.equal(s2.history[p.job_id].closed_at, iso(T0 + 10 * DAY), "the close time is what the 60-day window is measured from");
  const s3 = J.makeSnapshot([p], T0 + 20 * DAY, s2.history);
  assert.equal(s3.history[p.job_id].repost_count, 1);
  assert.equal(s3.history[p.job_id].first_seen, iso(T0));
});

test("MI-106 U2: diffNew does not re-fire a repost-within-60d, but fires a beyond-window return", () => {
  const [p] = J.normalizeGreenhouse(ghJob(), "stripe");
  const s1 = J.makeSnapshot([p], T0, null);
  const s2 = J.makeSnapshot([], T0 + 10 * DAY, s1.history);
  assert.deepEqual(J.diffNew([p], s2, T0 + 20 * DAY), [], "repost inside the window is not new");
  const back = J.diffNew([p], s2, T0 + 75 * DAY);
  assert.equal(back.length, 1, "return after the window is new");
});
