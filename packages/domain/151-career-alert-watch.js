/* Career alert watch loop (ALERT G1, BUG-090; Spec 2 job-detection/alerts).
   THE STANDING CALLER module 121 never had. 121's engine (poll / diffNew / scoreFit)
   detects new postings in ~2ms of processing, but in the product it was only ever invoked
   on demand (the chat router when a user asks; the gauntlet harness in tests) — detection
   was a capability, "alerts the moment it posts" was not a behavior. This module is the
   watch cycle as product code at harness/host tier: the deployed host schedules
   runWatchCycle() on 121's POLL_MINUTES cadence (starred 15 min / default 60 min) and
   supplies the real fetch, the per-user snapshot store, the scoring profile and the
   delivery sink. Scheduling and the delivery channel itself are HOST concerns and are
   deliberately NOT in this module (see docs/career/alert-watch.md).

   One cycle:
     (a) loads the prior snapshot/seen-set from the injected store,
     (b) calls 121's public poll() — its real fetch/dedupe/diffNew code path, fixture or
         live feeds arriving through 121's own opts.fetch seam,
     (c) for each genuinely-new posting applies the G6 GATE (the poll path in 121 has no
         level/family gate of its own — a manager posting scored Reach 13 live on
         2026-10-13 and would have alerted): alert ONLY when
         seniority_band in {intern, new_grad} AND role_family is in the profile's watched
         families AND 121 scoreFit does not hard-exclude the posting,
     (d) composes a typed ALERT RECORD and hands it to the injected sink,
     (e) the new snapshot/seen-set is persisted by 121 poll() itself (same store + key);
         removals are counted silently — a closed posting never alerts,
     (f) returns a typed cycle result; a board failure degrades THAT board only and
         never kills the cycle (G7: a per-board hard deadline is imposed here, at the
         watch level, around the injected fetch — a drip-feeding board is cut off and
         named in errors[]).
   First cycle against an empty store is a SEED cycle: it establishes the baseline
   snapshot and alerts on nothing (the postings it sees are not new to the world, only
   to us). Pass alertOnSeed:true to override. Delivery is a sink call, nothing more:
   what the sink does (chat message, push, file) is the host's decision, and the
   approval law for anything beyond alerting the user is unchanged.
   Pure-ish domain idiom like its neighbours: all I/O arrives injected
   { feeds?, fetch, profile, store, sink, now }. */
const CareerAlertWatch = (() => {
  const Jobs = (typeof require !== "undefined")
    ? (() => { try { return require("./121-career-jobs.js"); } catch { return null; } })()
    : (typeof CareerJobs !== "undefined" ? CareerJobs : null);

  const ALERT_BANDS = ["intern", "new_grad"];
  const DEFAULT_SNAPSHOT_KEY = "career:jobs:snapshot";
  // G7: the overnight watch's sick board drip-fed for ~14 minutes despite a socket
  // timeout. 100s per board is the deadline the restarted watcher proved with.
  const DEFAULT_BOARD_DEADLINE_MS = 100000;

  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();

  function nowMs(now) {
    const v = typeof now === "function" ? now() : now;
    if (v == null) return Date.now();
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    const p = Date.parse(v);
    return isNaN(p) ? Date.now() : p;
  }

  // G7 deadline wrapper: race the injected fetch against a wall-clock timer per call.
  // 121 calls the fetch once per feed, so one call == one board.
  // BUG-105: the race must bound the BODY READ too, not just time-to-headers —
  // fetch resolves when headers land, and a drip-feeding body then stalls the
  // cycle forever (measured live 2026-10-14: cycles stuck 7-12 min). The
  // returned response's json()/text() race the REMAINING deadline budget.
  function withDeadline(fetchFn, ms) {
    if (!fetchFn || !ms) return fetchFn;
    return async (url) => {
      const startedAt = Date.now();
      let timer = null;
      const deadlineError = () => new Error(`board fetch deadline exceeded after ${ms}ms (G7 hard deadline)`);
      const arm = (budget) => new Promise((_, reject) => {
        // This timer must keep an otherwise idle process alive until the
        // pending fetch settles or times out. Both races clear it in finally.
        timer = setTimeout(() => reject(deadlineError()), Math.max(0, budget));
      });
      try {
        const res = await Promise.race([Promise.resolve().then(() => fetchFn(url)), arm(ms)]);
        if (!res || (typeof res.json !== "function" && typeof res.text !== "function")) return res;
        const bound = (fn) => async (...a) => {
          let bodyTimer = null;
          try {
            return await Promise.race([
              Promise.resolve().then(() => fn(...a)),
              new Promise((_, reject) => {
                bodyTimer = setTimeout(() => reject(deadlineError()), Math.max(0, ms - (Date.now() - startedAt)));
              }),
            ]);
          } finally { if (bodyTimer) clearTimeout(bodyTimer); }
        };
        const wrapped = { status: res.status, ok: res.ok, headers: res.headers };
        if (typeof res.json === "function") wrapped.json = bound(res.json.bind(res));
        if (typeof res.text === "function") wrapped.text = bound(res.text.bind(res));
        return wrapped;
      } finally { if (timer) clearTimeout(timer); }
    };
  }

  // In-memory KV with 121's store contract ({ get, set }, sync or async) — for the
  // host-tier runner and tests; the deployed host injects its durable store instead.
  function createMemoryStore() {
    const kv = new Map();
    return { get: (k) => (kv.has(k) ? kv.get(k) : null), set: (k, v) => { kv.set(k, v); }, _kv: kv };
  }

  function watchedFamiliesOf(profile, deps) {
    if (deps && Array.isArray(deps.watchedFamilies) && deps.watchedFamilies.length) return deps.watchedFamilies;
    const prefs = (profile && profile.preferences) || {};
    return prefs.role_families || prefs.roles_families || [];
  }

  function watchedOccupationsOf(profile) {
    const prefs = (profile && profile.preferences) || {};
    return Array.isArray(prefs.watched_occupations) ? prefs.watched_occupations : [];
  }
  const termRe = (t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  // MI-095: occupation identity is established from title + JD evidence, not
  // the title string alone. A convention-form title ("Summer Analyst") whose
  // JD opening names the division/occupation ("Our investment banking
  // division hosts this summer analyst program") IS that occupation's
  // posting — 152's roleMatch has always accepted exactly this evidence
  // (its jd_head leg), but the watch gate matched the title only, so the
  // alert never fired and the reminder was gated here (Lane A seed LA-0043).
  // Precision law (Lane A's false-alert rate is 0 and stays 0): JD evidence
  // counts ONLY when a MULTIWORD occupation term matches on word boundaries
  // within the JD's opening 500 chars — the same head 152 reads, so a gate
  // pass on JD evidence is always confirmable downstream. A single-word term
  // in the body, finance words merely co-occurring, or the phrase buried in
  // late boilerplate never establishes identity. The returned detail
  // { occupation, basis, term, evidence } makes every match auditable; it
  // rides the gate result and the alert record.
  const JD_HEAD_CHARS = 500;
  function occupationHit(posting, occupations) {
    const title = lc(posting && posting.title);
    for (const occ of occupations || []) {
      for (const term of (occ && occ.terms) || []) {
        const t = lc(term).trim();
        if (t && termRe(t).test(title)) return { occupation: occ.occupation || t, basis: "title", term: t };
      }
    }
    const jd = s(posting && posting.jd_text);
    const head = lc(jd).slice(0, JD_HEAD_CHARS);
    if (head) {
      for (const occ of occupations || []) {
        for (const term of (occ && occ.terms) || []) {
          const t = lc(term).trim();
          if (!t || !t.includes(" ")) continue; // JD evidence must NAME the occupation family, not co-occur
          const m = termRe(t).exec(head);
          if (m) {
            const at = m.index + (m[1] ? m[1].length : 0);
            return { occupation: occ.occupation || t, basis: "jd_head", term: t, evidence: jd.slice(Math.max(0, at - 40), at + t.length + 40).trim() };
          }
        }
      }
    }
    return null;
  }

  // The G6 gate, exported so it can be graded on its own. Returns typed reasons either way.
  // BUG-095: the gate was hardcoded to a student (bands intern/new_grad, 121's 13
  // families) — a user watching any of the other ~890 occupations could never be
  // alerted, by construction. Bands now come from the profile
  // (preferences.alert_bands, defaulting to the student bands), and a posting also
  // passes the watch leg when a watched occupation's terms match the posting's
  // title — or, per MI-095, its JD opening (see occupationHit) —
  // (preferences.watched_occupations: [{occupation, terms}]) — the bridge from the
  // ~900-occupation taxonomy to 121's family classifier.
  function gatePosting(posting, profile, fit, watchedFamilies) {
    const reasons = [];
    const prefs = (profile && profile.preferences) || {};
    const bands = Array.isArray(prefs.alert_bands) && prefs.alert_bands.length ? prefs.alert_bands : ALERT_BANDS;
    if (!bands.includes(posting.seniority_band))
      reasons.push(`seniority_band is ${posting.seniority_band || "unknown"}; alerts fire only for ${bands.join(" / ")}`);
    const watched = watchedFamilies || [];
    const occs = watchedOccupationsOf(profile);
    const occHit = occupationHit(posting, occs);
    if (!watched.includes(posting.role_family) && !occHit) {
      let r = `role_family ${posting.role_family || "unknown"} is not in the profile's watched families (${watched.join(", ") || "none set"})`;
      if (occs.length) r += ` and neither the title nor the JD opening names a watched occupation (${occs.map((o) => o.occupation).join(", ")})`;
      reasons.push(r);
    }
    if (fit && fit.excluded)
      reasons.push(...(fit.hard_fails || fit.reasons || []).map((r) => `scoreFit hard-excluded: ${r}`));
    return { pass: reasons.length === 0, reasons, occupation_match: occHit ? occHit.occupation : null, occupation_match_detail: occHit };
  }

  // BUG-207: proven-skill derivation for fit lines. 121 scoreFit matches skills from
  // BOTH profile shapes — the pre-derived profile.skills array AND the canonical
  // facts shape (kind:"skill" facts, via 121 profileSkills' facts fallback) — but
  // the hand-rolled filter that used to live in composeAlert read ONLY
  // profile.skills, so a facts-shaped profile scored matches it could never explain
  // (zero fit lines for a user whose proven skill the JD names). 121 does not
  // export profileSkills, so this mirrors its semantics faithfully, with the
  // fact-citation strictness of 121's own profileFromPersona builders: a facts-held
  // skill is proven only when it is not flagged unproven AND carries evidence, and
  // its citation id is fact_id || id. Pre-derived skills entries keep their existing
  // verdict (their proven flag already encodes the evidence check), except an
  // explicitly empty evidence array, which is itself a statement of no evidence.
  function skillNameOf(text) {
    const t = s(text).replace(/^Skill:\s*/i, "").trim();
    const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/); // annotation is provenance, not the name (121 BUG-097)
    return m && m[1].trim() ? m[1].trim() : t;
  }
  function provenSkillFacts(profile) {
    const out = [];
    const seen = new Set();
    const push = (name, proven, factId) => {
      const n = s(name).trim();
      if (!n || !proven || !factId || seen.has(lc(n))) return;
      seen.add(lc(n));
      out.push({ name: n, fact_id: factId });
    };
    const fromEntry = (x) => {
      if (!x || typeof x === "string") return;
      push(x.name || x.skill,
        x.proven !== false && !x.unproven && !(Array.isArray(x.evidence) && x.evidence.length === 0),
        x.fact_id || x.id);
    };
    for (const x of (profile && profile.skills) || []) fromEntry(x);
    const facts = profile && profile.facts;
    if (Array.isArray(facts)) {
      for (const f of facts) {
        if (!f || f.kind !== "skill") continue;
        push(f.name || skillNameOf(f.text || ""),
          !f.unproven && f.proven !== false && (f.evidence || []).length > 0,
          f.fact_id || f.id);
      }
    } else if (facts && Array.isArray(facts.skills)) {
      for (const x of facts.skills) fromEntry(x); // 121 profileSkills' facts.skills shape: skill entries, not facts
    }
    return out;
  }

  // Typed alert record (G2's artifact, at watch tier): identity + board timestamps +
  // latency + fit lines sourced ONLY from the profile's proven facts, each citing its
  // fact ID (scoreFit already refuses unproven skills any match credit — BUG-002 — and
  // the fit lines inherit that: an unproven skill can never source a line here).
  function composeAlert(posting, fit, profile, detectedMs) {
    const detected_at = new Date(detectedMs).toISOString();
    const postedMs = posting.posted_at ? Date.parse(posting.posted_at) : NaN;
    const latency_seconds = isNaN(postedMs) ? null : Math.max(0, Math.round((detectedMs - postedMs) / 1000));
    // BUG-094: boards can backdate first_published (republished reqs, ATS migrations
    // importing history). A 40-day-old timestamp at first sight is a board-clock
    // artifact, not a 40-day detection latency — flag it so latency statistics and
    // the reader never mistake one for the other.
    const posted_at_quality = isNaN(postedMs) ? "missing" : (detectedMs - postedMs <= 48 * 3600 * 1000 ? "fresh" : "backdated");
    const matchedNames = (fit && fit.matched_skills) || [];
    const matchedFacts = provenSkillFacts(profile).filter((x) =>
      matchedNames.some((m) => lc(m) === lc(x.name)));
    const fit_lines = matchedFacts.map((x) => `proven skill ${x.name} (fact ${x.fact_id}) matches this posting`);
    for (const r of (fit && fit.reasons) || [])
      if (/role family .* is one you asked for|is a company you starred/.test(r)) fit_lines.push(r);
    return {
      type: "career_job_alert",
      job_id: posting.job_id,
      company: posting.company,
      title: posting.title,
      url: posting.url,
      location: posting.location || null,
      role_family: posting.role_family,
      seniority_band: posting.seniority_band,
      source: posting.source,
      // BUG-207 / FR-364: the posting's own text rides the alert record verbatim
      // (the text 121 normalized, nothing rewritten). Without it the 152 reminder
      // path had no posting text to quote a deadline from or match a JD head
      // against — every alert-fed reminder silently lost its stated deadline.
      jd_text: posting.jd_text || "",
      posted_at: posting.posted_at || null,
      posted_at_quality,
      // MI-106 (121, Spec 2 §2.5): the repost/stale verdicts 121 annotated on
      // the posting ride the alert record so the reminder (152) can flag a
      // possibly-stale first-sight posting instead of presenting it as fresh.
      reposted: posting.reposted === true,
      repost_count: posting.repost_count || 0,
      possibly_stale: posting.possibly_stale === true,
      first_seen_at: posting.first_seen_at || null,
      detected_at,
      latency_seconds,
      fit_lines,
      matched_fact_ids: matchedFacts.map((x) => x.fact_id),
      fit: fit ? { score: fit.score, bucket: fit.bucket, reasons: fit.reasons || [], gaps: fit.gaps || [], matched_skills: matchedNames } : null,
    };
  }

  // MI-028 (loss point L3): the gate's occupation match used to ride the
  // alert record as data (occupation_match) but never as a fit line, and
  // composeAlert's line derivation (proven skills + role-family/starred
  // reasons) fires on neither when the profile watches occupations rather
  // than 121 families — so an alert whose ONLY true basis is the watched
  // occupation match carried zero fit lines, and 152 inherited the emptiness.
  // This renders that basis as a line, labeled "match basis:", from the
  // gate detail alone: the watched occupation, its term, where it matched
  // (title, or the JD opening quoted verbatim from the gate's evidence).
  function matchBasisLine(detail) {
    if (!detail || !detail.term) return null;
    const occ = detail.occupation || detail.term;
    if (detail.basis === "jd_head" && detail.evidence)
      return `match basis: watched occupation "${occ}" — its term "${detail.term}" matches this posting's opening text: "${detail.evidence}"`;
    return `match basis: watched occupation "${occ}" — its term "${detail.term}" matches this posting's title`;
  }

  async function deliver(sink, record) {
    if (typeof sink === "function") return sink(record);
    if (sink && typeof sink.emit === "function") return sink.emit(record);
    if (sink && typeof sink.record === "function") return sink.record(record);
    if (sink && typeof sink.send === "function") return sink.send(record);
    if (sink && typeof sink.push === "function") return sink.push(record);
    throw new Error("sink must be a function or expose emit/record/send/push");
  }

  async function runWatchCycle(deps) {
    if (!Jobs) throw new Error("151 requires 121-career-jobs alongside it");
    deps = deps || {};
    const { profile, store, sink } = deps;
    if (!store || typeof store.get !== "function" || typeof store.set !== "function")
      throw new Error("151 runWatchCycle requires an injected store {get,set} (121's snapshot KV contract)");
    if (!sink) throw new Error("151 runWatchCycle requires an injected sink (function or {emit|record|send|push})");
    if (!profile) throw new Error("151 runWatchCycle requires the scoring profile (121 scoreFit shape)");
    const detectedMs = nowMs(deps.now);
    const key = deps.snapshotKey || DEFAULT_SNAPSHOT_KEY;
    const feeds = deps.feeds || Jobs.boardFeeds();
    const deadlineMs = deps.boardDeadlineMs == null ? DEFAULT_BOARD_DEADLINE_MS : deps.boardDeadlineMs;
    const fetchFn = withDeadline(deps.fetch || null, deadlineMs);

    // (a) prior snapshot/seen-set — read BEFORE poll overwrites it (removals + seeding).
    const prior = await store.get(key);
    const seeded = !(prior && Array.isArray(prior.job_ids));
    const priorIds = seeded ? [] : prior.job_ids.slice();

    // (b)+(e) 121's real poll: fetch + dedupe + diffNew vs the stored snapshot, then
    // poll persists the new snapshot to the same store/key itself.
    const result = await Jobs.poll(feeds, { fetch: fetchFn || undefined, store, snapshotKey: key, now: detectedMs });

    // Per-board failures degrade, never kill (121 fetchFeed already records them).
    const errors = [];
    for (const r of result.feeds || [])
      if (r.error) errors.push({ board: r.company_token || null, source: r.source || null, error: s(r.error) });

    // Removals: in the prior seen-set, absent now. Counted, never alerted. Under a
    // mass-close suspect shape (feed outage masquerading as closures) 121 preserves
    // presence — removals are not counted from an outage either.
    const currentIds = new Set((result.postings || []).map((p) => p.job_id));
    const removed = (seeded || result.mass_close_suspect) ? 0 : priorIds.filter((id) => !currentIds.has(id)).length;

    // (c)+(d) gate, compose, deliver.
    const watched = watchedFamiliesOf(profile, deps);
    const alerts = [], gated = [];
    let alerts_emitted = 0;
    // MI-029 (BUG-260) — the gate evidence pass. The scale path polls the
    // board directory LIST-FIRST (feedsFromDirectory drops ?content=true at
    // ~1/100th the payload), so a posting can reach this gate with jd_text ""
    // — and MI-095's JD-head occupation leg then reads an empty string and
    // can never fire. Lane A counted 18 postings killed this way (class
    // gated_at_151): convention-form titles whose own job text names the
    // watched occupation. The gate was correct; its evidence never arrived.
    // So: a NEW posting that fails the gate on the watch leg (role_family /
    // watched occupation) with no JD text earns ONE full-text fetch of its
    // board — 121's own content feed, through the same deadline-bounded
    // seam, at most once per board per cycle — and is re-gated on the
    // enriched record. The same gatePosting decides both times; a posting
    // whose full text does not establish the occupation stays gated, so the
    // false-alert rate cannot move.
    const fullTextByBoard = new Map();
    let gateEvidenceRecovered = 0;
    const fullTextFor = async (posting) => {
      // job_id's middle segment is the normalized COMPANY name (121
      // basePosting), not the board token — so match by trying each
      // same-source feed's full-text payload (cached per board) until the
      // posting's own job_id is found.
      for (const feed of feeds) {
        if (!feed || feed.source !== posting.source || !Jobs.feeds[posting.source]) continue;
        const boardKey = `${posting.source}:${feed.company_token}`;
        if (!fullTextByBoard.has(boardKey)) {
          const fullFeed = Jobs.feeds[posting.source](feed.company_token);
          let byId = null;
          if (fullFeed && fullFeed.url !== feed.url) {
            try {
              const r = await Jobs.fetchFeed(fullFeed, { fetch: fetchFn || undefined });
              byId = new Map((r.postings || []).map((p) => [p.job_id, p]));
            } catch { byId = null; }
          }
          fullTextByBoard.set(boardKey, byId);
        }
        const byId = fullTextByBoard.get(boardKey);
        if (byId && byId.has(posting.job_id)) return byId.get(posting.job_id);
      }
      return null;
    };
    for (const posting of result.new_postings || []) {
      if (seeded && !deps.alertOnSeed) continue; // baseline only — named by `seeded` on the result
      let candidate = posting;
      let fit = Jobs.scoreFit(candidate, profile);
      let gate = gatePosting(candidate, profile, fit, watched);
      if (!gate.pass && !candidate.jd_text && gate.reasons.some((r) => /role_family|watched occupation/.test(r))) {
        const enriched = await fullTextFor(candidate);
        if (enriched && enriched.jd_text) {
          const fit2 = Jobs.scoreFit(enriched, profile);
          const gate2 = gatePosting(enriched, profile, fit2, watched);
          if (gate2.pass) { candidate = enriched; fit = fit2; gate = gate2; gateEvidenceRecovered += 1; }
        }
      }
      if (!gate.pass) { gated.push({ job_id: posting.job_id, reasons: gate.reasons }); continue; }
      const record = composeAlert(candidate, fit, profile, detectedMs);
      // MI-095 audit: when the watch leg passed on a watched occupation, the
      // alert record carries why it matched (occupation, basis, term, and —
      // for JD evidence — the JD fragment that named it).
      if (gate.occupation_match_detail) record.occupation_match = gate.occupation_match_detail;
      // MI-028: the same basis also becomes a fit line on the alert, so the
      // alert record itself explains the match and 152's inherited lines are
      // never empty for an occupation-matched alert.
      const mbLine = matchBasisLine(gate.occupation_match_detail);
      if (mbLine && !record.fit_lines.includes(mbLine)) record.fit_lines.push(mbLine);
      try {
        await deliver(sink, record);
        alerts_emitted += 1;
        alerts.push(record);
      } catch (e) {
        errors.push({ stage: "sink", job_id: posting.job_id, error: s(e && e.message || e) });
      }
    }

    const health = result.source_health || null;
    const status = errors.some((e) => e.stage === "sink") ? "degraded"
      : health && health.outcome === "outage" ? "outage"
      : errors.length ? "degraded" : "ok";
    return {
      type: "career_watch_cycle",
      status,
      seeded,
      snapshot_key: key,
      detected_at: new Date(detectedMs).toISOString(),
      polled: (result.postings || []).length,
      feeds_polled: (result.feeds || []).length,
      new_seen: (result.new_postings || []).length,
      alerts_emitted,
      alerts,
      gated_out: gated.length,
      gated,
      gate_evidence_recovered: gateEvidenceRecovered,
      removed,
      errors,
      source_health: health,
      mass_close_suspect: result.mass_close_suspect || null,
      // Per-feed summary (additive): the adaptive scheduler (below) keeps per-board
      // health/velocity state and needs each board's own outcome, not just totals.
      feed_results: (result.feeds || []).map((r) => ({ source: r.source || null, company_token: r.company_token || null, status: r.status || 0, postings: (r.postings || []).length, error: r.error || null })),
    };
  }

  // ================= SCALE WAVE (BUG-091..096) =================
  // The watch outgrows the hardcoded registry: boards come from a verified
  // product-data directory (packages/career-data/board-directory.json, produced by
  // scripts/career/board-discovery.mjs), each board polls on its OWN cadence and
  // keeps its OWN snapshot, and a suppression layer sits between detection and
  // delivery for the three ways "new" lies at scale: reposts, recovery bursts,
  // and cross-board duplicates.

  const CADENCE = { hot: 5, active: 15, standard: 60, quiet: 240 }; // minutes
  const DEFAULT_STATE_KEY = "career:jobs:watch-state";
  const REPOST_WINDOW_MS = 14 * 24 * 3600 * 1000;
  const RECOVERY_SLACK_MS = 5 * 60 * 1000;

  // Pure cadence planner: observed posting velocity -> poll interval. A board
  // earns a faster cadence by publishing; a quiet board decays to the 4h tier
  // so the request budget concentrates where postings actually appear. Errors
  // back off (one error doubles, two park at the cap) — the polite response to
  // a sick or rate-limiting board, and the one that keeps us unbanned.
  function planCadence(obs) {
    obs = obs || {};
    const errors = obs.consecutive_errors || 0;
    let tier, base, why;
    if (!obs.cycles_observed) { tier = "standard"; base = CADENCE.standard; why = "unobserved board: standard cadence until its velocity is known"; }
    else if (obs.cycles_observed < 3) { tier = "standard"; base = CADENCE.standard; why = "insufficient history (<3 cycles): velocity is unknown, not zero — hold standard cadence"; }
    else if (obs.ewma_new_per_day >= 2) { tier = "hot"; base = CADENCE.hot; why = `${obs.ewma_new_per_day.toFixed(2)} new/day: hot tier`; }
    else if (obs.ewma_new_per_day >= 0.25) { tier = "active"; base = CADENCE.active; why = `${obs.ewma_new_per_day.toFixed(2)} new/day: active tier`; }
    else if (obs.ewma_new_per_day >= 0.02) { tier = "standard"; base = CADENCE.standard; why = `${obs.ewma_new_per_day.toFixed(2)} new/day: standard tier`; }
    else { tier = "quiet"; base = CADENCE.quiet; why = "no new postings observed: quiet tier"; }
    if (obs.starred && base > CADENCE.active) { base = CADENCE.active; tier = "active"; why += "; starred company capped at 15 min"; }
    // MI-033 (BUG-261): the error backoff must distinguish WHY the board
    // failed. A TRANSPORT error (no HTTP response at all — DNS, reset,
    // timeout) is not a sick or rate-limiting board; doubling its interval
    // (60 -> 120) and parking it at 240 pushed retries past MT2's Window 2
    // and manufactured 8 delayed-not-lost misses from a 29% transport error
    // tax. Transport retries on the short cycle; sustained transport failure
    // (3+) settles at no less than standard cadence — a dead board is not
    // hammered every 15 minutes, and never parked at the HTTP cap. HTTP
    // errors (429 above all) keep the polite backoff below, untouched.
    const transportCount = obs.consecutive_transport_errors || 0;
    if (obs.error_kind === "transport" && transportCount < 3) {
      base = Math.min(base, CADENCE.active);
      why += "; transport error (no HTTP response): short retry cycle — a network failure is not a sick board (MI-033)";
    } else if (obs.error_kind === "transport") {
      if (base < CADENCE.standard) base = CADENCE.standard;
      why += "; sustained transport failure (3+): hold at no less than standard cadence — unreachable is not rate-limiting (MI-033)";
    }
    else if (errors === 1) { base = Math.min(CADENCE.quiet, base * 2); why += "; one consecutive error: interval doubled"; }
    else if (errors >= 2) { base = CADENCE.quiet; tier = "quiet"; why += "; repeated errors: parked at the cap"; }
    return { tier, interval_minutes: base, reason: why };
  }

  const boardIdOf = (feed) => `${feed.source}:${feed.company_token}`;
  const boardSnapshotKey = (feed) => `career:jobs:snapshot:board:${feed.source}:${feed.company_token}`;

  // BUG-096: feeds from the verified board directory (product data), not a
  // hardcoded list. Detection polls run LIST-FIRST (gap G4): the Greenhouse
  // list endpoint without ?content=true carries id/title/location/first_published
  // at ~1/100th the payload of the full-text pull; full text is fetched only for
  // postings that survive the diff (a host concern), or when a caller passes
  // { content: true }.
  function feedsFromDirectory(entries, opts) {
    opts = opts || {};
    const out = [];
    for (const e of entries || []) {
      if (!e || e.status !== "live") continue;
      const token = e.board_token || e.board;
      if (!token || !Jobs.feeds[e.provider]) continue;
      let feed;
      if (e.provider === "greenhouse" && !opts.content)
        feed = { source: "greenhouse", company_token: token, url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs` };
      else feed = Jobs.feeds[e.provider](token);
      out.push(Object.assign(feed, { company: e.company || token, provider: e.provider, board: token, status: "live", checkedAt: e.last_verified || null, directory: true }));
    }
    return out;
  }

  // The adaptive cycle: due boards only, one board per 121 poll under that
  // board's own snapshot key (BUG-091: a shared snapshot + subset polling
  // corrupts the seen-set — unpolled boards' ids fall out of the snapshot and
  // their postings re-fire as "new"; per-board keys make cadence free to vary).
  // Detections collect first; the suppression layer (repost / recovery /
  // cross-board) runs over the whole cycle's candidates; survivors deliver.
  async function runAdaptiveCycle(deps) {
    if (!Jobs) throw new Error("151 requires 121-career-jobs alongside it");
    deps = deps || {};
    const { profile, store, sink } = deps;
    if (!store || typeof store.get !== "function" || typeof store.set !== "function")
      throw new Error("151 runAdaptiveCycle requires an injected store {get,set}");
    if (!sink) throw new Error("151 runAdaptiveCycle requires an injected sink");
    if (!profile) throw new Error("151 runAdaptiveCycle requires the scoring profile");
    const feeds = deps.feeds || [];
    const now = nowMs(deps.now);
    const stateKey = deps.stateKey || DEFAULT_STATE_KEY;
    const doc = (await store.get(stateKey)) || {};
    const boardsState = doc.boards || {};
    const alertHistory = doc.alert_history || {};
    const starred = ((profile.preferences || {}).starred_companies || []).map(lc);

    const dueIds = Array.isArray(deps.dueBoardIds) ? new Set(deps.dueBoardIds) : null;
    const due = [], notDue = [];
    for (const feed of feeds) {
      const id = boardIdOf(feed);
      if (dueIds) { (dueIds.has(id) ? due : notDue).push(feed); continue; }
      const st = boardsState[id];
      const interval = (st && st.interval_minutes) || CADENCE.standard;
      if (!st || !st.last_polled_at || now - st.last_polled_at >= interval * 60000) due.push(feed); else notDue.push(feed);
    }

    const candidates = []; // { record, board_id }
    const suppressed = { reposts: [], recovered_absorbed: [], cross_board_duplicates: [] };
    const boardSummary = {};
    const cycleErrors = [];
    for (const feed of due) {
      const id = boardIdOf(feed);
      const prev = boardsState[id] || {};
      const collected = [];
      let res = null;
      try {
        res = await runWatchCycle({ feeds: [feed], fetch: deps.fetch, profile, store, sink: async (r) => { collected.push(r); }, now, snapshotKey: boardSnapshotKey(feed), boardDeadlineMs: deps.boardDeadlineMs });
      } catch (e) {
        cycleErrors.push({ board: id, error: s(e && e.message || e) });
      }
      const failed = !res || (res.errors || []).length > 0;
      const st = Object.assign({}, prev);
      st.cycles_observed = (prev.cycles_observed || 0) + 1;
      st.last_polled_at = now;
      if (st.first_attempt_at == null) st.first_attempt_at = now;
      st.consecutive_errors = failed ? (prev.consecutive_errors || 0) + 1 : 0;
      // MI-033: classify this cycle's failure for planCadence. The board's
      // own feed status is the evidence: 0/null means no HTTP response ever
      // arrived (transport); a real status — 429 above all — is the board
      // answering, and keeps the polite backoff.
      const feedStatus = res && res.feed_results && res.feed_results[0] ? res.feed_results[0].status : null;
      const errorKind = !failed ? null : (feedStatus ? "http" : "transport");
      st.consecutive_transport_errors = errorKind === "transport" ? (prev.consecutive_transport_errors || 0) + 1 : 0;
      st.last_error_kind = errorKind;
      if (!failed) st.last_ok_at = now;
      const newSeen = res ? res.new_seen : 0;
      if (res && !res.seeded) {
        const intervalUsed = prev.interval_minutes || CADENCE.standard;
        const sample = newSeen * (1440 / Math.max(1, intervalUsed)); // new/day at this cadence
        st.ewma_new_per_day = prev.ewma_new_per_day == null ? sample : 0.7 * prev.ewma_new_per_day + 0.3 * sample;
      } else if (st.ewma_new_per_day == null) st.ewma_new_per_day = 0;
      const plan = planCadence({ cycles_observed: st.cycles_observed, ewma_new_per_day: st.ewma_new_per_day, consecutive_errors: st.consecutive_errors, error_kind: errorKind, consecutive_transport_errors: st.consecutive_transport_errors, starred: starred.includes(lc(feed.company)) });
      st.interval_minutes = plan.interval_minutes; st.tier = plan.tier;
      boardsState[id] = st;
      boardSummary[id] = { tier: st.tier, interval_minutes: st.interval_minutes, last_status: failed ? "error" : "ok", ewma_new_per_day: Math.round((st.ewma_new_per_day || 0) * 100) / 100, new_seen: newSeen, removed: res ? res.removed : 0 };
      if (res) for (const e of res.errors || []) cycleErrors.push({ board: id, error: e.error });
      // BUG-093 recovery rule: judged against the board's state BEFORE this cycle.
      // A posting whose board timestamp predates the last moment we could see the
      // board (last_ok_at, or our first-ever attempt) is back-catalog the board is
      // showing us late — absorb it into the baseline; it was never provably new.
      const blindStart = prev.last_ok_at != null ? prev.last_ok_at : (prev.first_attempt_at != null ? prev.first_attempt_at : null);
      for (const record of collected) {
        const postedMs = record.posted_at ? Date.parse(record.posted_at) : NaN;
        if (blindStart != null && !isNaN(postedMs) && postedMs < blindStart - RECOVERY_SLACK_MS)
          suppressed.recovered_absorbed.push({ job_id: record.job_id, board: id, posted_at: record.posted_at });
        else candidates.push({ record, board_id: id });
      }
    }

    // Presence set: every job_id any board's current snapshot holds (post-cycle).
    const presentIds = new Set();
    for (const feed of feeds) {
      const snap = await store.get(boardSnapshotKey(feed));
      for (const jid of (snap && snap.job_ids) || []) presentIds.add(jid);
    }

    // BUG-092 repost rule + cross-board duplicate rule (see header of this section).
    // Company identity comes from the BOARD's directory entry, never from the
    // posting payload: Greenhouse names the company in its payload while Lever
    // postings carry only the board token, so payload-keyed dedupe would never
    // recognize the same seat across the two boards.
    const feedById = new Map(feeds.map((f) => [boardIdOf(f), f]));
    const keyOf = (c) => Jobs.dedupeKey({ company: (feedById.get(c.board_id) || {}).company || c.record.company, title: c.record.title, location: c.record.location || "" });
    const afterRepost = [];
    for (const c of candidates) {
      const key = keyOf(c);
      const hist = alertHistory[key];
      const knownIds = hist ? (hist.job_ids || [hist.job_id]) : [];
      if (hist && now - hist.alerted_at < REPOST_WINDOW_MS && !knownIds.includes(c.record.job_id) && !knownIds.some((id) => presentIds.has(id))) {
        // The seat we alerted is gone and this req is its replacement identity:
        // a repost, not a new opening. Absorb the new id so a LATER additional
        // req (seat count growing while this one is live) still alerts.
        suppressed.reposts.push({ job_id: c.record.job_id, board: c.board_id, prior_job_ids: knownIds.slice(), key });
        hist.job_ids = knownIds.concat([c.record.job_id]);
        continue;
      }
      if (hist && knownIds.includes(c.record.job_id)) { suppressed.reposts.push({ job_id: c.record.job_id, board: c.board_id, prior_job_ids: knownIds.slice(), key, reason: "same req re-presented" }); continue; }
      afterRepost.push(c);
    }
    const byKey = new Map();
    for (const c of afterRepost) { const k = keyOf(c); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
    const survivors = [];
    for (const [key, group] of byKey) {
      const sources = new Set(group.map((c) => c.record.source));
      if (sources.size <= 1) { survivors.push(...group); continue; }
      const best = group.slice().sort((a, b) => (((b.record.fit || {}).score || 0) - ((a.record.fit || {}).score || 0)))[0];
      for (const c of group) {
        if (c.record.source === best.record.source) survivors.push(c);
        else suppressed.cross_board_duplicates.push({ job_id: c.record.job_id, board: c.board_id, kept_source: best.record.source, key });
      }
    }

    const delivered = [];
    for (const c of survivors) {
      try {
        await deliver(sink, c.record); delivered.push(c.record);
        const key = keyOf(c); const hist = alertHistory[key];
        const ids = new Set(hist ? (hist.job_ids || [hist.job_id]) : []); ids.add(c.record.job_id);
        alertHistory[key] = { job_ids: [...ids], alerted_at: now };
      }
      catch (e) { cycleErrors.push({ stage: "sink", job_id: c.record.job_id, error: s(e && e.message || e) }); }
    }
    await store.set(stateKey, { boards: boardsState, alert_history: alertHistory, updated_at: new Date(now).toISOString() });

    return {
      type: "career_adaptive_watch_cycle",
      at: new Date(now).toISOString(),
      boards_total: feeds.length,
      boards_due: due.length,
      boards_polled: due.length,
      boards_skipped_not_due: notDue.map(boardIdOf),
      alerts_delivered: delivered.length,
      alerts: delivered,
      suppressed,
      boards: boardSummary,
      errors: cycleErrors,
    };
  }

  return { runWatchCycle, watchCycle: runWatchCycle, runAdaptiveCycle, gatePosting, composeAlert, matchBasisLine, createMemoryStore, withDeadline,
    planCadence, feedsFromDirectory, boardIdOf, boardSnapshotKey, CADENCE,
    ALERT_BANDS, DEFAULT_SNAPSHOT_KEY, DEFAULT_BOARD_DEADLINE_MS, DEFAULT_STATE_KEY,
    POLL_MINUTES: Jobs ? Jobs.POLL_MINUTES : { starred: 15, default: 60 } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerAlertWatch;
