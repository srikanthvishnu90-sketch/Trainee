/* Career recruiting intelligence (Doc 3: "Recruiting Intelligence + Honest Advice"; capability rows INTL-001..008,
   consumers NEGO-002 / COS-001 read CIR facts through this module's shapes).
   The brain behind the outreach and application engines: Company Intelligence Records (CIRs), the ten-part thesis,
   and the honest-advice policy. Built to Doc 3 §1's data reality: there is NO legal bulk LinkedIn data and no
   scraping, ever. CIRs are curated from public sources (official career / "how we hire" pages, engineering blogs,
   GitHub org data, DOL H-1B LCA public summaries, university outcome reports) or, later, a licensed vendor the
   owner picks (vendor + budget are an owner fill; nothing here calls a vendor).

   SCHEMA (§2.2 — this validator is the contract for all 30 CIRs; siblings build CIR JSON against it):
     company_id            slug string, e.g. "palantir"
     company_name          display string
     cohort                { role_family, level, time_window, definition } — entry-level cohorts stay separate
                           from experienced hires (§2.1 step 1)
     sample_size           integer >= 0, or null when no population sample exists (curated-qualitative CIR)
     as_of                 YYYY-MM-DD the record was built / last rebuilt
     data_sources          [{ label, url, as_of }] — at least one; url must be a real https page that was fetched
     school_dist / prior_employer_dist / major_dist / skills_dist
                           { basis: "population" | "curated-qualitative", sample_size: int|null,
                             entries: [{ label, share_pct: number|null, count: int|null, note?,
                                         source_url, as_of, sample_size? }] }
                           share_pct/count may be null ONLY when basis is "curated-qualitative" and the entry
                           carries a qualitative `note` stated as a reported pattern, never a number.
     path_patterns         [{ pattern, evidence: "observed" | "reported-norm", source_url, as_of }]
     entry_routes          [{ route, rank, accessibility_note, source_url, as_of }]
     hiring_bar_summary    fact
     screening_signals     { stated: [fact], revealed: [fact] } — stated vs revealed preferences often differ (§2.1.6)
     process_stages        [{ stage, description, kind: "process", source_url, as_of }]
     interview_styles      [fact]
     values_culture_signals [fact]
     hiring_cadence        fact (kind "hiring_status" or "process")
     compensation_notes    [fact + source_type: "official" | "government-lca" | "user-reported-anecdotal"]
     referral_weight_notes fact
     red_flags             [fact]
     thesis_text           string; every number in it must trace to a number inside this record's own facts
     confidence_level      "population-backed" | "mixed" | "curated-qualitative" | "new"
                           ("population-backed" is a validation ERROR when sample_size is null / < 50)
     known_biases_of_data  [string, ...] — non-empty (self-reported profiles skew; survivorship bias; §0, §2.2)
     last_verified_at      YYYY-MM-DD
     fact = { statement, source_url, as_of, kind, value?, unit?, sample_size?, source_type? }
     kind ∈ process | hiring_status | population | qualitative | compensation | timeline | norm
   Every fact carries source_url + as_of (§2.2, INTL-001). Staleness: process/timeline/norm facts older than
   180 days and hiring_status facts older than 90 days are flagged stale (§2.2, §5, §6: "auto-warn if older
   than 6 months"; hiring status >90 days per the INTL-001 row).

   Functions:
     validateCIR(cir, opts)          { ok, errors, warnings, stale } — schema + source/date + numeric-trace rules
     loadCIRsFromDir(dir) / loadCIRs(list) / getCIR(store, id)
                                     the CIR store over JSON files (packages/career-data/cirs/*.json)
     cohortStats(cir)                INTL-002 view: aggregates with sample size, thin label (<50), and
                                     k-anonymity suppression (<10 never shown) applied per distribution
     compareMe(cir, profile)         INTL-005: gap table vs a master-profile-shaped input + highest-leverage fix
     planPath(cir, profile, opts)    INTL-006: dated milestones (30 days / semester / year) + reminder texts
     composeThesis(cir, profile, opts)  INTL-003: the §2.3 ten-part thesis + its claim ledger (every number in
                                     the text traces to a CIR fact) + suppressed stats + the gap table + the plan
     verifyClaims(text, claims, opts)   the §5 verifier pass: an unsourced number in a thesis FAILS; a cohort
                                     stat from a sample <10 present in the text FAILS; <50 must be labeled "thin"
     verifyThesis(thesis)            verifyClaims over a composed thesis (its claims + its allowed plan numbers)
     lintAdvice(text)                INTL-004: false-precision odds and guarantee language are rejected; odds
                                     must be reasoned ranges (§3.1)
     respondToRequest(text, opts)    INTL-004 / §4.9 Q30: fabrication / cheating / impersonation requests are
                                     refused (consequences named, truthful alternative offered); protected-
                                     attribute inference is refused; distress gets warmth + safety first (§3.1)
     refreshDue(cir, now) / reportOutdated(cir, report, now)   INTL-007 maintenance view (schedule + report log)
     detectRole(text) / barForRole(cir, role)   BUG-219 / FR-376 role lens: a company-intel answer serves the
                                     bar for the ASKED role (cir.role_bars when the file carries per-role bars,
                                     else the cohort bar only when the asked role IS the file's cohort role);
                                     when the file carries no bar for the asked role it says so honestly —
                                     another role's bar is never served as if it answered the question.
     answerRoleIntel(cir, question, opts)   the composed intel answer: role-lens bar (or the honest no-bar
                                     statement) + career-KB role stats cited WITH their n via 153 (BUG-220).
   Standalone validation (any CIR file, e.g. the other 25 built in parallel branches):
     node packages/domain/125-career-intel.js validate <cir.json> [more.json ...]
     node packages/domain/125-career-intel.js validate-dir <dir>
   Pure: the clock is passed in (opts.now as YYYY-MM-DD); file IO happens only in loadCIRsFromDir and the CLI. */
const CareerIntel = (() => {
  const DAY = 86400000;
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const CONFIDENCE = ["population-backed", "mixed", "curated-qualitative", "new"];
  const FACT_KINDS = ["process", "hiring_status", "population", "qualitative", "compensation", "timeline", "norm"];
  const COMP_SOURCE_TYPES = ["official", "government-lca", "user-reported-anecdotal"];
  const DIST_FIELDS = ["school_dist", "prior_employer_dist", "major_dist", "skills_dist"];
  const STALE_DAYS = { process: 180, timeline: 180, norm: 180, hiring_status: 90 };
  const K_ANON = 10;      // §6: never show a cohort stat from a sample below 10
  const THIN_BELOW = 50;  // §2.1: below N=50 the answer says "thin"

  const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);
  const isDay = (s) => typeof s === "string" && ISO_DAY.test(s) && !Number.isNaN(dayMs(s));
  const ageDays = (asOf, now) => Math.round((dayMs(now) - dayMs(asOf)) / DAY);
  const addDays = (s, n) => new Date(dayMs(s) + n * DAY).toISOString().slice(0, 10);
  const isHttps = (u) => typeof u === "string" && /^https?:\/\/.+\..+/.test(u);
  const numbersIn = (text) => {
    // Strip ISO dates and "Month YYYY" so a date is never mistaken for a claim, then read every number left.
    const t = String(text || "")
      .replace(/https?:\/\/\S+/g, " ") // a URL is a pointer to a source, not a numeric claim — and its digits must never "trace" one either
      .replace(/§\s*\d+(?:\.\d+)?/g, " ") // spec section references (§2.3, §5) are citations, not claims
      .replace(/\b[A-Za-z]+-\d[A-Za-z0-9-]*\b/g, " ") // alphanumeric codes (H-1B, F-1) are identifiers, not claims
      .replace(/\bQ\d+\b/g, " ") // spec scenario references (Q26, Q30) are citations, not claims
      .replace(/\d{4}-\d{2}-\d{2}/g, " ")
      .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/g, " ");
    const out = [];
    const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(t))) out.push(Number(m[0].replace(/,/g, "")));
    return out;
  };
  const sameNum = (a, b) => Math.abs(a - b) < 1e-9;

  // ---------- INTL-001: the CIR schema validator ----------
  function validateCIR(cir, opts) {
    const o = opts || {};
    const now = o.now || (cir && cir.as_of) || null;
    const errors = [], warnings = [], stale = [];
    const err = (path, message) => errors.push({ path, message });
    if (!cir || typeof cir !== "object" || Array.isArray(cir)) return { ok: false, errors: [{ path: "$", message: "CIR must be an object" }], warnings, stale };

    const checkFact = (f, path, wantKind) => {
      if (!f || typeof f !== "object" || Array.isArray(f)) { err(path, "fact must be an object"); return; }
      if (typeof f.statement !== "string" || !f.statement.trim()) err(`${path}.statement`, "fact needs a statement");
      if (!isHttps(f.source_url)) err(`${path}.source_url`, "every fact carries a source_url (a real https page that was fetched)");
      if (!isDay(f.as_of)) err(`${path}.as_of`, "every fact carries an as_of date (YYYY-MM-DD)");
      if (f.kind !== undefined && !FACT_KINDS.includes(f.kind)) err(`${path}.kind`, `unknown fact kind "${f.kind}"`);
      if (wantKind && f.kind !== wantKind) err(`${path}.kind`, `must be "${wantKind}"`);
      if (f.value !== undefined && f.value !== null) {
        if (typeof f.value !== "number" || !Number.isFinite(f.value)) err(`${path}.value`, "a numeric fact value must be a finite number");
        else if (f.sample_size === undefined && cir.sample_size == null) warnings.push({ path: `${path}.value`, message: "numeric fact with no sample_size anywhere — state the N it rests on or drop the number" });
      }
      if (isDay(f.as_of) && isDay(now)) {
        const rule = STALE_DAYS[f.kind];
        if (rule && ageDays(f.as_of, now) > rule) stale.push({ path, kind: f.kind, as_of: f.as_of, age_days: ageDays(f.as_of, now), rule_days: rule });
      }
    };
    const checkFactList = (list, path, wantKind) => {
      if (!Array.isArray(list)) { err(path, "must be an array of facts"); return; }
      list.forEach((f, i) => checkFact(f, `${path}[${i}]`, wantKind));
    };

    for (const k of ["company_id", "company_name"]) if (typeof cir[k] !== "string" || !cir[k].trim()) err(k, "required string");
    if (typeof cir.company_id === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(cir.company_id)) err("company_id", "must be a slug (lowercase, digits, hyphens)");
    const cohort = cir.cohort;
    if (!cohort || typeof cohort !== "object") err("cohort", "required: { role_family, level, time_window, definition }");
    else for (const k of ["role_family", "level", "time_window", "definition"]) if (typeof cohort[k] !== "string" || !cohort[k].trim()) err(`cohort.${k}`, "required string");
    if (!(cir.sample_size === null || (Number.isInteger(cir.sample_size) && cir.sample_size >= 0))) err("sample_size", "integer >= 0, or null when no population sample exists");
    if (!isDay(cir.as_of)) err("as_of", "required YYYY-MM-DD");
    if (!isDay(cir.last_verified_at)) err("last_verified_at", "required YYYY-MM-DD");
    if (isDay(cir.as_of) && isDay(cir.last_verified_at) && cir.last_verified_at < cir.as_of) warnings.push({ path: "last_verified_at", message: "last_verified_at is before as_of" });

    if (!Array.isArray(cir.data_sources) || !cir.data_sources.length) err("data_sources", "at least one data source is required");
    else cir.data_sources.forEach((s, i) => {
      if (!s || typeof s !== "object") { err(`data_sources[${i}]`, "source must be an object"); return; }
      if (typeof s.label !== "string" || !s.label.trim()) err(`data_sources[${i}].label`, "required string");
      if (!isHttps(s.url)) err(`data_sources[${i}].url`, "source url must be a real https page that was fetched");
      if (!isDay(s.as_of)) err(`data_sources[${i}].as_of`, "required YYYY-MM-DD");
    });

    for (const field of DIST_FIELDS) {
      const d = cir[field];
      if (!d || typeof d !== "object" || Array.isArray(d)) { err(field, "required distribution object { basis, sample_size, entries }"); continue; }
      if (!["population", "curated-qualitative"].includes(d.basis)) err(`${field}.basis`, 'must be "population" or "curated-qualitative"');
      if (!(d.sample_size === null || (Number.isInteger(d.sample_size) && d.sample_size >= 0))) err(`${field}.sample_size`, "integer >= 0 or null");
      if (d.basis === "population" && !(d.sample_size > 0)) err(`${field}.sample_size`, "a population-basis distribution needs its sample size");
      if (!Array.isArray(d.entries)) { err(`${field}.entries`, "must be an array"); continue; }
      let shareSum = 0, sharesComplete = d.entries.length > 0;
      d.entries.forEach((e, i) => {
        const p = `${field}.entries[${i}]`;
        if (!e || typeof e !== "object") { err(p, "entry must be an object"); sharesComplete = false; return; }
        if (typeof e.label !== "string" || !e.label.trim()) err(`${p}.label`, "required string");
        if (!isHttps(e.source_url)) err(`${p}.source_url`, "every distribution entry carries a source_url");
        if (!isDay(e.as_of)) err(`${p}.as_of`, "every distribution entry carries an as_of date");
        const hasShare = e.share_pct !== null && e.share_pct !== undefined;
        const hasCount = e.count !== null && e.count !== undefined;
        if (hasShare) {
          if (typeof e.share_pct !== "number" || e.share_pct < 0 || e.share_pct > 100) err(`${p}.share_pct`, "must be a number in [0, 100] or null");
          else shareSum += e.share_pct;
          const n = e.sample_size !== undefined ? e.sample_size : d.sample_size;
          if (!(n > 0)) err(`${p}.share_pct`, "a share_pct is a population number: it needs a sample_size on the entry or the distribution");
        } else sharesComplete = false;
        if (hasCount && !(Number.isInteger(e.count) && e.count >= 0)) err(`${p}.count`, "must be an integer >= 0 or null");
        if (!hasShare && !hasCount) {
          if (d.basis !== "curated-qualitative") err(p, "a population-basis entry must carry share_pct or count — or the distribution is curated-qualitative");
          else if (typeof e.note !== "string" || !e.note.trim()) err(`${p}.note`, "a numberless curated entry must state the qualitative pattern as a reported norm in `note`");
        }
        if (isDay(e.as_of) && isDay(now) && ageDays(e.as_of, now) > 180) stale.push({ path: p, kind: "population", as_of: e.as_of, age_days: ageDays(e.as_of, now), rule_days: 180 });
      });
      if (sharesComplete && shareSum > 100.5) err(field, `entry share_pct values sum to ${shareSum}, over 100`);
    }

    if (!Array.isArray(cir.path_patterns)) err("path_patterns", "must be an array");
    else cir.path_patterns.forEach((p, i) => {
      const at = `path_patterns[${i}]`;
      if (!p || typeof p !== "object") { err(at, "pattern must be an object"); return; }
      if (typeof p.pattern !== "string" || !p.pattern.trim()) err(`${at}.pattern`, "required string");
      if (!["observed", "reported-norm"].includes(p.evidence)) err(`${at}.evidence`, 'must be "observed" or "reported-norm" — an anecdote is never stated as observed fact (§6)');
      if (!isHttps(p.source_url)) err(`${at}.source_url`, "every path pattern carries a source_url");
      if (!isDay(p.as_of)) err(`${at}.as_of`, "every path pattern carries an as_of date");
    });

    if (!Array.isArray(cir.entry_routes)) err("entry_routes", "must be an array");
    else cir.entry_routes.forEach((r, i) => {
      const at = `entry_routes[${i}]`;
      if (!r || typeof r !== "object") { err(at, "route must be an object"); return; }
      if (typeof r.route !== "string" || !r.route.trim()) err(`${at}.route`, "required string");
      if (r.rank !== undefined && !(Number.isInteger(r.rank) && r.rank >= 1)) err(`${at}.rank`, "rank must be a positive integer");
      if (typeof r.accessibility_note !== "string" || !r.accessibility_note.trim()) err(`${at}.accessibility_note`, "required string");
      if (!isHttps(r.source_url)) err(`${at}.source_url`, "every entry route carries a source_url");
      if (!isDay(r.as_of)) err(`${at}.as_of`, "every entry route carries an as_of date");
    });

    checkFact(cir.hiring_bar_summary, "hiring_bar_summary");
    // Optional per-role bars (BUG-219): a file MAY carry role_bars —
    // [{ role, bar: fact }] or { <role>: fact } — served only for that role.
    if (cir.role_bars !== undefined) {
      const entries = Array.isArray(cir.role_bars) ? cir.role_bars.map((e, i) => [e && e.role, e && (e.bar || e), `role_bars[${i}]`]) : (cir.role_bars && typeof cir.role_bars === "object" ? Object.entries(cir.role_bars).map(([k, v]) => [k, v, `role_bars.${k}`]) : null);
      if (!entries) err("role_bars", "must be an array of { role, bar } or an object keyed by role");
      else entries.forEach(([role, bar, at]) => {
        if (typeof role !== "string" || !role.trim()) err(`${at}.role`, "each role bar names its role");
        checkFact(bar, `${at}.bar`);
      });
    }
    const ss = cir.screening_signals;
    if (!ss || typeof ss !== "object") err("screening_signals", "required: { stated: [fact], revealed: [fact] }");
    else { checkFactList(ss.stated, "screening_signals.stated"); checkFactList(ss.revealed, "screening_signals.revealed"); }
    if (!Array.isArray(cir.process_stages)) err("process_stages", "must be an array of process facts");
    else cir.process_stages.forEach((s, i) => {
      const at = `process_stages[${i}]`;
      if (!s || typeof s !== "object") { err(at, "stage must be an object"); return; }
      if (typeof s.stage !== "string" || !s.stage.trim()) err(`${at}.stage`, "required string");
      if (typeof s.description !== "string" || !s.description.trim()) err(`${at}.description`, "required string");
      checkFact({ statement: s.description, source_url: s.source_url, as_of: s.as_of, kind: s.kind || "process" }, at, "process");
    });
    checkFactList(cir.interview_styles, "interview_styles");
    checkFactList(cir.values_culture_signals, "values_culture_signals");
    checkFact(cir.hiring_cadence, "hiring_cadence");
    if (!Array.isArray(cir.compensation_notes)) err("compensation_notes", "must be an array of facts");
    else cir.compensation_notes.forEach((f, i) => {
      checkFact(f, `compensation_notes[${i}]`);
      if (f && typeof f === "object" && !COMP_SOURCE_TYPES.includes(f.source_type)) err(`compensation_notes[${i}].source_type`, `compensation must label its source type: ${COMP_SOURCE_TYPES.join(" | ")} (§2.2)`);
    });
    checkFact(cir.referral_weight_notes, "referral_weight_notes");
    checkFactList(cir.red_flags, "red_flags");

    if (typeof cir.thesis_text !== "string" || !cir.thesis_text.trim()) err("thesis_text", "required string");
    else {
      // Every number in the record's own thesis text must trace to a number inside this record's facts.
      const traced = new Set();
      const harvest = (v) => {
        if (typeof v === "number") traced.add(v);
        else if (typeof v === "string") numbersIn(v).forEach((n) => traced.add(n));
        else if (Array.isArray(v)) v.forEach(harvest);
        else if (v && typeof v === "object") Object.values(v).forEach(harvest);
      };
      const { thesis_text, ...rest } = cir;
      harvest(rest);
      for (const n of numbersIn(thesis_text)) if (![...traced].some((t) => sameNum(t, n))) err("thesis_text", `number ${n} in thesis_text does not trace to any fact in this record`);
    }

    if (!CONFIDENCE.includes(cir.confidence_level)) err("confidence_level", `must be one of: ${CONFIDENCE.join(", ")}`);
    if (cir.confidence_level === "population-backed" && !(cir.sample_size >= THIN_BELOW)) err("confidence_level", `cannot claim "population-backed" with sample_size ${cir.sample_size === null ? "null" : cir.sample_size} — below ${THIN_BELOW} is thin, and no sample is curated-qualitative`);
    if (!Array.isArray(cir.known_biases_of_data) || !cir.known_biases_of_data.length || cir.known_biases_of_data.some((b) => typeof b !== "string" || !b.trim())) err("known_biases_of_data", "non-empty array of strings — every CIR states the biases of its own data (§2.2)");

    return { ok: errors.length === 0, errors, warnings, stale };
  }

  // ---------- the CIR store (INTL-001) ----------
  function loadCIRs(list) {
    if (!Array.isArray(list)) throw new Error("loadCIRs expects an array of CIR objects");
    const byId = {};
    const results = list.map((cir) => {
      const v = validateCIR(cir);
      if (cir && cir.company_id) {
        if (byId[cir.company_id]) throw new Error(`duplicate company_id "${cir.company_id}"`);
        byId[cir.company_id] = cir;
      }
      return { company_id: cir && cir.company_id, ...v };
    });
    return { byId, results, ok: results.every((r) => r.ok) };
  }
  function loadCIRsFromDir(dir) {
    const fs = require("node:fs");
    const path = require("node:path");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    return loadCIRs(files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
  }
  const getCIR = (store, id) => (store && store.byId ? store.byId[id] || null : null);

  // ---------- INTL-002: population view with k-anonymity + thin labels ----------
  function cohortStats(cir) {
    const dists = {};
    const suppressed = [];
    for (const field of DIST_FIELDS) {
      const d = cir[field];
      if (!d) continue;
      const n = d.sample_size;
      const shown = [], held = [];
      for (const e of d.entries || []) {
        const en = e.sample_size !== undefined ? e.sample_size : n;
        const numeric = e.share_pct != null || e.count != null;
        if (numeric && en != null && en < K_ANON) { held.push({ field, label: e.label, sample_size: en, reason: `sample ${en} is below the k-anonymity floor of ${K_ANON} — never shown (§6)` }); continue; }
        shown.push({ label: e.label, share_pct: e.share_pct ?? null, count: e.count ?? null, note: e.note || null, source_url: e.source_url, as_of: e.as_of });
      }
      suppressed.push(...held);
      dists[field] = { basis: d.basis, sample_size: n, thin: n != null && n < THIN_BELOW, entries: shown, suppressed_count: held.length };
    }
    return { company_id: cir.company_id, sample_size: cir.sample_size, as_of: cir.as_of, confidence_level: cir.confidence_level, distributions: dists, suppressed };
  }

  // ---------- BUG-219 / FR-376: the role lens ----------
  // A company file's headline bar belongs to its COHORT role. Serving it
  // for a different asked role ("how does Snowflake compare for PM?"
  // answered with the SWE coding bar) is a wrong-lens answer. The lens:
  // per-role bars (cir.role_bars) win for their role; the cohort bar is
  // served only when the asked role IS the cohort role; otherwise the
  // honest answer is that this file carries no bar for the asked role.
  const factText = (f) => (typeof f === "string" ? f : (f && (f.statement || f.text || f.summary)) || "");
  const ROLE_LENSES = [
    { key: "pm", label: "product management", re: /\b(pm|apm|product managers?|product management)\b/i },
    { key: "swe", label: "software engineering", re: /\b(swe|software engineers?|software engineering|software developers?|engineering)\b/i },
    { key: "data-analyst", label: "data analyst", re: /\bdata analysts?\b/i },
    { key: "data-scientist", label: "data science", re: /\b(data scientists?|data science)\b/i },
    { key: "ml", label: "machine learning engineering", re: /\b(machine learning|ml engineers?)\b/i },
    { key: "quant", label: "quantitative trading / research", re: /\b(quant|quantitative)\b/i },
    { key: "ib", label: "investment banking", re: /\b(investment banking|ibd|bankers?|banking analysts?)\b/i },
    { key: "consulting", label: "consulting", re: /\b(consultants?|consulting|management consulting)\b/i },
    { key: "design", label: "design", re: /\b(designers?|product design|ux|ui design)\b/i },
    { key: "sales", label: "sales", re: /\b(sales|account executives?)\b/i },
  ];
  function detectRole(text) {
    const t = String(text || "");
    for (const r of ROLE_LENSES) if (r.re.test(t)) return { key: r.key, label: r.label };
    return null;
  }
  function roleBarsOf(cir) {
    const rb = cir && cir.role_bars;
    if (!rb) return [];
    if (Array.isArray(rb)) return rb.filter((e) => e && e.role).map((e) => ({ role: e.role, bar: e.bar || e }));
    if (typeof rb === "object") return Object.entries(rb).map(([role, bar]) => ({ role, bar }));
    return [];
  }
  function barForRole(cir, roleAsk) {
    const asked = typeof roleAsk === "string" ? detectRole(roleAsk) || { key: null, label: roleAsk } : roleAsk;
    const cohortRole = (cir.cohort && cir.cohort.role_family) || "";
    if (!asked || !asked.label) return { status: "cohort-bar", role: cohortRole, bar: cir.hiring_bar_summary || null, text: factText(cir.hiring_bar_summary) };
    for (const e of roleBarsOf(cir)) {
      const er = detectRole(e.role);
      if ((er && asked.key && er.key === asked.key) || norm(e.role) === norm(asked.label) || norm(e.role) === norm(asked.key || "")) {
        return { status: "role-bar", role: e.role, bar: e.bar, text: factText(e.bar) };
      }
    }
    const cohortLens = detectRole(cohortRole);
    if (cohortLens && asked.key && cohortLens.key === asked.key) return { status: "cohort-bar", role: cohortRole, bar: cir.hiring_bar_summary || null, text: factText(cir.hiring_bar_summary) };
    const comp = cir.company_name || cir.company_id;
    return {
      status: "no-role-bar", role: asked.label, bar: null,
      text: `This company file for ${comp} carries a hiring bar for its ${cohortRole} cohort only — it has no ${asked.label} bar, so I won't quote the ${cohortRole} bar as if it answered a ${asked.label} question. What would answer it is a ${asked.label} company file or the role's own evidence in the career knowledge library.`,
    };
  }

  // ---------- BUG-220 / FR-377: intel answers read the career KB (153) ----------
  // Lazy at call time: in the router bundle 153 may sit after this file
  // (TDZ), and in Node the require resolves directly. Absent KB module
  // degrades to no citation, never a crash and never an invented stat.
  const getKB = () => { try { return typeof CareerKB !== "undefined" ? CareerKB : require("./153-career-kb.js"); } catch { try { return require("./153-career-kb.js"); } catch { return null; } } };
  function roleKbStats(roleAsk, opts) {
    const KB = getKB();
    if (!KB || !roleAsk) return null;
    const label = typeof roleAsk === "string" ? roleAsk : roleAsk.label;
    try { const st = KB.roleStats(label, opts || {}); return st && st.found ? st : null; } catch { return null; }
  }
  // MI-020 (Depth Lane C): the formatted, n-cited stats text for a
  // roleStats result, exposed so the router can cite the library inside
  // its own composed answers (no-file company + asked role) without
  // reaching into 153 directly.
  function kbStatsText(stats) {
    const KB = getKB();
    if (!KB || !stats) return "";
    try { return KB.formatRoleStats(stats); } catch { return ""; }
  }
  // The composed intel answer for a role question about a company:
  // role-lens bar (or the honest no-bar statement) + the library's
  // stats for the ASKED role, cited with their n. The two compose:
  // neither half may borrow the other role's evidence.
  function answerRoleIntel(cir, question, opts) {
    const o = opts || {};
    const asked = o.role ? (typeof o.role === "string" ? detectRole(o.role) || { key: null, label: o.role } : o.role) : detectRole(question) || detectRole(o.roleLabel || "");
    const lens = cir ? barForRole(cir, asked || (cir.cohort && cir.cohort.role_family)) : null;
    const stats = asked ? roleKbStats(asked.label, o) : null;
    const KB = getKB();
    const parts = [];
    if (lens) parts.push(lens.text);
    if (stats && KB) parts.push(KB.formatRoleStats(stats));
    else if (asked) parts.push(`The career knowledge library carries no stats for ${asked.label} that I can cite with a sample size, so no library numbers are quoted here.`);
    return { role: asked ? asked.label : null, lens_status: lens ? lens.status : null, lens, kb: stats, text: parts.filter(Boolean).join(" ") };
  }

  // ---------- INTL-005: compare-me gap table ----------
  const norm = (s) => String(s || "").toLowerCase().trim();
  function compareMe(cir, profile, opts) {
    const p = profile || {};
    const rows = [];
    const userSkills = (p.skills || []).map(norm);
    const wanted = [];
    for (const e of (cir.skills_dist && cir.skills_dist.entries) || []) wanted.push(e.label);
    const matchedSkills = wanted.filter((w) => userSkills.some((u) => u.includes(norm(w)) || norm(w).includes(u)));
    const missingSkills = wanted.filter((w) => !matchedSkills.includes(w));
    const internships = Array.isArray(p.internships) ? p.internships : [];
    const projects = Array.isArray(p.projects) ? p.projects : [];
    // WORDING-BACKLOG (BUG-202): this row used to print a
    // meta-instruction ("See the school pattern in this company
    // file — stated in words unless…") as if it were the pattern.
    // The row now states the file's actual school pattern — the
    // distribution's own label where the file carries one — or
    // says plainly that no school pattern is sourced in the file.
    const schoolDist = cir.school_dist || {};
    const schoolEntry = (Array.isArray(schoolDist.entries) ? schoolDist.entries : []).find((e) => e && (e.label || e.note));
    const schoolPattern = schoolEntry
      ? `${schoolEntry.label}${schoolEntry.note ? ` — ${String(schoolEntry.note).split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "")}` : ""}`
      : "No school pattern is sourced in this file — it carries no population sample of hires by school, so no school share is stated";
    rows.push({
      dimension: "school",
      user: p.school ? `${p.school}${p.school_tier ? ` (${p.school_tier})` : ""}` : "not on file",
      cohort: `${schoolPattern}; school is not in your control, so the plan routes around it.`,
      status: p.school ? "unknown" : "gap",
      controllable: false,
      fix: "Do not plan around changing schools; offset with experience, projects and referrals.",
    });
    const lens = opts && opts.role ? barForRole(cir, opts.role) : null;
    rows.push({
      dimension: "experience",
      user: internships.length ? internships.map((i) => i.role ? `${i.role} at ${i.employer || "?"}` : (i.employer || "?")).join("; ") : "no internships yet",
      // Role lens (BUG-219): with an asked role, the cohort cell is that
      // role's bar — or the honest no-bar statement — never another
      // role's bar quoted as if it were this role's.
      cohort: lens ? lens.text : (cir.hiring_bar_summary ? cir.hiring_bar_summary.statement : "not on file"),
      status: internships.length ? "matches" : "gap",
      controllable: true,
      fix: internships.length ? "Turn the internship into talkable depth: what you built or analyzed, with numbers from your own work." : "Land one real internship or role at a smaller, reachable employer first — the ladder pattern in this company file's path patterns.",
    });
    rows.push({
      dimension: "projects",
      user: projects.length ? projects.map((x) => (typeof x === "string" ? x : x.name || "?")).join("; ") : "no projects on file",
      cohort: "Revealed screen in this company file: evidence of building or analyzing real things (what the record shows they actually screen for).",
      status: projects.length ? "matches" : "gap",
      controllable: true,
      fix: projects.length ? "Write up the strongest project publicly — what problem, what you did, what changed." : "Ship one project that solves a messy real problem for a real user, and document it.",
    });
    rows.push({
      dimension: "skills",
      user: userSkills.length ? userSkills.join(", ") : "no skills on file",
      cohort: wanted.length ? wanted.join(", ") : "not on file",
      status: !wanted.length ? "unknown" : missingSkills.length === 0 ? "matches" : matchedSkills.length ? "gap" : "gap",
      controllable: true,
      fix: missingSkills.length ? `Close the named gaps first: ${missingSkills.slice(0, 3).join(", ")}.` : "Keep depth: interviewers probe the skills you list, so be able to go deep on each.",
      missing: missingSkills,
    });
    rows.push({
      dimension: "timing",
      user: p.year ? `currently: ${p.year}` : "year not on file",
      cohort: cir.hiring_cadence ? cir.hiring_cadence.statement : "not on file",
      status: "unknown",
      controllable: true,
      fix: "Work backwards from the hiring cadence in this company file; recruiting timelines move earlier than most students expect.",
    });
    rows.push({
      dimension: "authorization",
      user: p.work_authorization || "not on file",
      cohort: "Sponsorship history is a matter of public record (DOL H-1B LCA filings); this company file states only what its sources support, and immigration specifics go to the school's international office — not legal advice.",
      status: p.work_authorization ? "unknown" : "gap",
      controllable: false,
      fix: "Confirm sponsorship for this exact role family before investing a season of prep; target employers with a filing history for the role.",
    });
    const priority = ["experience", "skills", "projects", "timing", "school", "authorization"];
    const firstGap = priority.map((d) => rows.find((r) => r.dimension === d && r.status === "gap")).find(Boolean) || null;
    return { company_id: cir.company_id, rows, highest_leverage_fix: firstGap ? { dimension: firstGap.dimension, fix: firstGap.fix } : { dimension: null, fix: "No structural gap found against this company file — the leverage is interview craft and reps." } };
  }

  // ---------- INTL-006: path planner ----------
  function planPath(cir, profile, opts) {
    const o = opts || {};
    const now = o.now || cir.as_of;
    const gaps = compareMe(cir, profile, opts);
    const gapDims = new Set(gaps.rows.filter((r) => r.status === "gap").map((r) => r.dimension));
    const comp = cir.company_name || cir.company_id;
    const milestones = [];
    const add = (horizon, offsetDays, action) => milestones.push({
      horizon,
      by: offsetDays != null && isDay(now) ? addDays(now, offsetDays) : null,
      window: offsetDays != null ? null : horizon,
      action,
      reminder: null,
    });
    add("30d", 7, `Confirm this cycle's application window and deadlines for ${comp} on the official careers page — dates move, and this company file's cadence fact is the starting point, not the truth.`);
    if (gapDims.has("experience")) add("30d", 14, "Apply to a first, reachable rung: a smaller employer in the same role family (the ladder pattern in this company file's path patterns). Volume plus follow-up is the play.");
    if (gapDims.has("projects")) add("30d", 30, "Ship the first version of one real project and write it up publicly.");
    if (gapDims.has("skills")) add("30d", 21, `Start the named skill gaps from the compare-me table: ${gaps.rows.find((r) => r.dimension === "skills").missing.slice(0, 3).join(", ") || "core skills for this role family"}.`);
    add("30d", 10, "Build the coffee-chat target list from this company file's entry routes: recent hires in the same role family, alumni of your school, people one rung up the ladder.");
    add("semester", null, "Convert the semester into signal: one internship or substantial project, one visible leadership or club role in the field, and interview reps on a weekly schedule.");
    if (gapDims.has("skills")) add("semester", null, "Close the remaining named skill gaps to interview depth, not survey depth.");
    add("semester", null, `Run the coffee-chat list: short, specific asks; every conversation ends with a follow-up you actually send.`);
    add("year", null, `Be in the application pool for ${comp}'s main entry window with the ladder rung, the project write-up and the referral conversations already done — not started.`);
    add("year", null, "If the direct route misses, take the highest adjacent rung this company file names and re-aim with a year of signal (the risks-and-alternatives route in this thesis).");
    for (const m of milestones) {
      m.reminder = m.by ? `${comp} plan — by ${m.by}: ${m.action}` : `${comp} plan — this ${m.window}: ${m.action}`;
    }
    return { company_id: cir.company_id, generated_as_of: now, milestones };
  }

  // ---------- INTL-003: the thesis composer (§2.3) + claim ledger ----------
  function composeThesis(cir, profile, opts) {
    const o = opts || {};
    const now = o.now || cir.as_of;
    const v = validateCIR(cir, { now });
    const claims = [];
    const claim = (text, value, unit, fact) => {
      const c = { text, value, unit: unit || null, source_url: fact.source_url, as_of: fact.as_of, sample_size: fact.sample_size !== undefined ? fact.sample_size : cir.sample_size };
      claims.push(c);
      return c;
    };
    const stats = cohortStats(cir);
    const gaps = compareMe(cir, profile, o);
    const plan = planPath(cir, profile, { now, role: o.role });
    // Role lens (BUG-219): when a role was asked, the bottom line quotes
    // THAT role's bar — or states honestly that the file carries none —
    // never the cohort role's bar dressed as the asked role's answer.
    const lens = o.role ? barForRole(cir, o.role) : null;
    const barSentence = lens ? lens.text : cir.hiring_bar_summary.statement;
    const comp = cir.company_name || cir.company_id;
    const staleHere = v.stale.length ? ` Note: ${v.stale.length} fact(s) in this record are past their freshness window and flagged stale — re-verify before acting on them.` : "";

    // Part 2 lines: only numbers that survived k-anonymity, each one a ledger claim.
    const whoLines = [];
    for (const field of DIST_FIELDS) {
      const d = stats.distributions[field];
      if (!d) continue;
      for (const e of d.entries) {
        if (e.share_pct != null) {
          const n = d.sample_size;
          const thin = n != null && n < THIN_BELOW ? " (thin sample)" : "";
          claim(`${e.label}: ${e.share_pct}%`, e.share_pct, "%", e);
          whoLines.push(`${e.label} — ${e.share_pct}% of the ${field.replace("_dist", "").replace("_", " ")} sample (N=${n}, as of ${e.as_of})${thin}. Source: ${e.source_url}`);
        } else if (e.count != null) {
          claim(`${e.label}: ${e.count}`, e.count, "count", e);
          whoLines.push(`${e.label} — count ${e.count} in the sample (N=${d.sample_size}, as of ${e.as_of}). Source: ${e.source_url}`);
        } else if (e.note) {
          whoLines.push(`${e.label} — reported pattern, not a measured share: ${e.note} (source: ${e.source_url}, as of ${e.as_of})`);
        }
      }
    }
    if (!whoLines.length) whoLines.push("This company file is based on reported patterns, not a population sample: no population sample exists for it yet, so there are no percentages to show. What follows is the reported pattern from public sources, labeled as such.");

    const routes = [...(cir.entry_routes || [])].sort((a, b) => (a.rank || 99) - (b.rank || 99));
    const gapLines = gaps.rows.map((r) => `${r.dimension}: you — ${r.user} | cohort — ${r.cohort} | ${r.status}${r.status === "gap" ? ` | fix: ${r.fix}` : ""}`);
    const milestonesOf = (h) => plan.milestones.filter((m) => m.horizon === h);
    const planLines = (h) => milestonesOf(h).map((m) => `- ${m.action}${m.by ? ` (by ${m.by})` : ""}`);
    const oddsWord = gaps.rows.filter((r) => r.status === "gap").length >= 3 ? "low, but not zero" : gaps.rows.some((r) => r.status === "gap") ? "a real reach that the plan below is built to close" : "credible, if you execute the plan";

    const sections = {
      bottom_line: `Bottom line: for ${comp} — ${cir.cohort.role_family}, ${cir.cohort.level} — your odds through the cold application alone are ${oddsWord}. This read rests on a ${/qualitative/i.test(String(cir.confidence_level)) ? "reported-pattern" : cir.confidence_level} record as of ${cir.as_of}${cir.sample_size ? ` over a sample of ${cir.sample_size}` : " with no population sample — treat every pattern below as reported, not measured"}. ${barSentence}${staleHere}`,
      who_gets_in: `Who gets in (${cir.sample_size === null ? "no population sample — reported-pattern record" : `sample of ${cir.sample_size}`}${cir.sample_size != null && cir.sample_size >= K_ANON && cir.sample_size < THIN_BELOW ? " — thin sample" : ""}, as of ${cir.as_of}):\n${whoLines.map((l) => `- ${l}`).join("\n")}\nKnown biases of this data: ${cir.known_biases_of_data.join("; ")}. We see who got in, not who tried and failed — survivorship bias is real.`,
      stated_vs_revealed: `What ${comp} says it screens for vs what the record shows:\nStated: ${(cir.screening_signals.stated || []).map((f) => f.statement).join(" ")}\nRevealed: ${(cir.screening_signals.revealed || []).map((f) => f.statement).join(" ")}`,
      routes_ranked: `Routes in, ranked for you:\n${routes.map((r, i) => `${["First", "Second", "Third", "Fourth", "Fifth"][i] || "Also"}: ${r.route} — ${r.accessibility_note}`).join("\n")}`,
      gap_analysis: `Your gap analysis (highest-leverage fix first: ${gaps.highest_leverage_fix.dimension || "none structural"}):\n${gapLines.map((l) => `- ${l}`).join("\n")}`,
      plan: `The plan:\nNext 30 days:\n${planLines("30d").join("\n")}\nThis semester:\n${planLines("semester").join("\n")}\nThis year:\n${planLines("year").join("\n")}`,
      coffee_chat_strategy: `Coffee-chat strategy: target the profile types named in the ranked routes — recent hires in this role family, alumni of your school now inside, and people one rung up the ladder you are climbing. Ask what the interviews actually test, what surprised them after starting, and what they would do with a semester to prepare. Keep asks short and specific; send the follow-up you promised.`,
      timeline: `Timeline and key dates: ${cir.hiring_cadence.statement} (as of ${cir.hiring_cadence.as_of}; recruiting dates shift every cycle — re-check the official careers page before acting).`,
      risks_alternatives: `Risks and alternatives: ${(cir.red_flags || []).map((f) => f.statement).join(" ")} Adjacent options with similar signal: the other employers and role families whose company files share this ladder — the first rung matters more than the logo on it.`,
      offer_to_execute: `Want me to execute? I can build the coffee-chat target list from these routes, tailor your resume to this record's revealed screens (truthfully — only what you have actually done), and set the plan's reminders. Say the word and I start with the list.`,
    };
    if (cir.sample_size) claim(`sample of ${cir.sample_size}`, cir.sample_size, "sample_size", { source_url: cir.data_sources[0].url, as_of: cir.as_of, sample_size: cir.sample_size });
    // Numbers stated inside CIR facts that the text quotes (cadence, hiring bar) enter the ledger sourced to
    // those facts — the validator already forced every fact to carry source + date, so they trace by construction.
    for (const f of [cir.hiring_cadence, cir.hiring_bar_summary, ...(lens && lens.bar && lens.bar !== cir.hiring_bar_summary ? [lens.bar] : []), ...(cir.red_flags || []), ...((cir.screening_signals || {}).stated || []), ...((cir.screening_signals || {}).revealed || [])]) {
      if (!f || !f.statement) continue;
      for (const n of numbersIn(f.statement)) if (!claims.some((c) => sameNum(c.value, n))) claim(`${f.statement.slice(0, 60)}…: ${n}`, n, null, f);
    }
    // BUG-003 fix (sc-w13): the who-gets-in lines quote distribution entries (label + qualitative note) and
    // the routes section quotes entry routes (route + accessibility_note). Numbers inside those quoted
    // strings must enter the ledger too, sourced to the entry/route — otherwise verifyThesis (§5) rejects
    // theses this composer itself produced (Bain, Citadel Securities, Duolingo, BCG, KKR, HRT, et al.).
    for (const field of DIST_FIELDS) {
      for (const e of ((cir[field] || {}).entries || [])) {
        if (!e || !e.source_url) continue;
        for (const n of numbersIn(`${e.label || ""} ${e.note || ""}`)) if (!claims.some((c) => sameNum(c.value, n))) claim(`${String(e.label || "").slice(0, 60)}…: ${n}`, n, null, e);
      }
    }
    for (const r of (cir.entry_routes || [])) {
      if (!r || !r.source_url) continue;
      for (const n of numbersIn(`${r.route || ""} ${r.accessibility_note || ""}`)) if (!claims.some((c) => sameNum(c.value, n))) claim(`${String(r.route || "").slice(0, 60)}…: ${n}`, n, null, r);
    }
    // Same BUG-003 class: who_gets_in also quotes known_biases_of_data verbatim — numbers there (a sample
    // count cited inside a bias note, a "Doc 3" reference) enter the ledger sourced to the record itself.
    for (const b of (cir.known_biases_of_data || [])) {
      for (const n of numbersIn(b)) if (!claims.some((c) => sameNum(c.value, n))) claim(`${String(b).slice(0, 60)}…: ${n}`, n, null, { source_url: cir.data_sources[0].url, as_of: cir.as_of, sample_size: cir.sample_size });
    }
    const text = [sections.bottom_line, sections.who_gets_in, sections.stated_vs_revealed, sections.routes_ranked, sections.gap_analysis, sections.plan, sections.coffee_chat_strategy, sections.timeline, sections.risks_alternatives, sections.offer_to_execute].join("\n\n");
    // Allowed without a claim: the plan's own 30-day horizon (§2.3 part 6 is a plan shape, not a world claim)
    // and the stale-fact count, which is a statement about this record, computed by the validator above.
    const allowed_numbers = [30];
    if (v.stale.length) allowed_numbers.push(v.stale.length);
    return { company_id: cir.company_id, as_of: now, sections, text, claims, allowed_numbers: [...new Set(allowed_numbers)], suppressed: stats.suppressed, gaps, plan, cir_validation: { ok: v.ok, stale_count: v.stale.length } };
  }

  // ---------- §5: the claim verifier ----------
  function verifyClaims(text, claims, opts) {
    const o = opts || {};
    const errors = [];
    const ledger = Array.isArray(claims) ? claims : [];
    ledger.forEach((c, i) => {
      if (!c || typeof c !== "object") { errors.push({ claim: i, message: "claim must be an object" }); return; }
      if (!isHttps(c.source_url)) errors.push({ claim: i, message: "claim has no source_url — a number with no source record fails (§5)" });
      if (!isDay(c.as_of)) errors.push({ claim: i, message: "claim has no as_of date" });
      if (typeof c.value !== "number") errors.push({ claim: i, message: "claim value must be a number" });
      if (c.sample_size != null && c.sample_size < K_ANON) errors.push({ claim: i, message: `cohort stat from a sample of ${c.sample_size} is below the k-anonymity floor of ${K_ANON} and must be suppressed, never shown (§6)` });
      if (c.sample_size != null && c.sample_size >= K_ANON && c.sample_size < THIN_BELOW && !String(text).includes("thin")) errors.push({ claim: i, message: `cohort stat from a thin sample (${c.sample_size} < ${THIN_BELOW}) must be labeled "thin" in the text (§2.1)` });
    });
    const allowed = new Set((o.allowedNumbers || []).map(Number));
    const traced = new Set(ledger.map((c) => c.value));
    const unsourced = [];
    for (const n of numbersIn(text)) {
      if (allowed.has(n) || [...traced].some((t) => sameNum(t, n))) continue;
      unsourced.push(n);
    }
    // A percentage is never structural: any % number must trace to the ledger.
    const pctRe = /(\d+(?:\.\d+)?)\s*%/g;
    let pm;
    const pctBad = [];
    while ((pm = pctRe.exec(String(text || "")))) { const v = Number(pm[1]); if (![...traced].some((t) => sameNum(t, v))) pctBad.push(v); }
    for (const n of [...new Set([...unsourced, ...pctBad])]) errors.push({ number: n, message: `number ${n} appears in the thesis with no source record — FAILS the §5 replay rule` });
    return { ok: errors.length === 0, errors, unsourced_numbers: [...new Set([...unsourced, ...pctBad])] };
  }
  const verifyThesis = (thesis) => verifyClaims(thesis.text, thesis.claims, { allowedNumbers: thesis.allowed_numbers || [] });

  // ---------- INTL-004: honest-advice lint (§3) ----------
  function lintAdvice(text) {
    const t = String(text || "");
    const violations = [];
    const rules = [
      { id: "false-precision-decimal-percent", re: /\d+\.\d+\s*%/, why: "a decimal percentage is false precision — quantify odds in ranges with reasoning (§3.1)" },
      { id: "false-precision-odds", re: /\b\d+(?:\.\d+)?\s*%\s*(chance|probability|odds|shot)\b/i, why: "a precise percent chance is false precision — use a reasoned range (§3.1)" },
      { id: "false-precision-chance-of", re: /\b(chance|probability|odds) of \d/i, why: "a precise numeric chance is false precision — use a reasoned range (§3.1)" },
      { id: "false-precision-chance-is", re: /\b(chance|probability|odds) (is|are|sits at|:) ?\d/i, why: "a precise numeric chance is false precision — use a reasoned range (§3.1)" },
      { id: "guarantee", re: /\b(guaranteed|you will (get|land|receive|be offered))\b[^.]*\b(offer|job|interview|admission)\b/i, why: "no promises of outcomes — career advice is not a guarantee (§0, §3.1)" },
      { id: "protected-attribute-advice", re: /\b(hide|conceal|change|alter|downplay) your (race|gender|age|religion|ethnicity|disability|national origin)\b/i, why: "never advise concealing or altering protected characteristics (§0, §6)" },
    ];
    for (const r of rules) { const m = t.match(r.re); if (m) violations.push({ rule: r.id, excerpt: m[0], why: r.why }); }
    return { ok: violations.length === 0, violations };
  }

  // ---------- INTL-004 / Q30: fabrication & cheating refusal, distress protocol ----------
  function respondToRequest(text) {
    const t = String(text || "");
    if (/(kill myself|end my life|self[- ]?harm|suicidal|don't want to (be alive|live))/.test(t.toLowerCase())) {
      return { action: "support", text: "I hear you, and the career stuff can wait. Please reach out now: in the US you can call or text 988 (Suicide and Crisis Lifeline) any time, or text HOME to 741741. If you might act on this, call 911. You matter more than any application. When you're ready, I'm here — no grilling, at your pace." };
    }
    if (/(i'?m a failure|i feel like a failure|everyone is ahead of me|i'?ll never get in|hopeless about)/i.test(t)) {
      return { action: "support", text: "You're not a failure — you're early in a process whose timelines are genuinely brutal and mostly hidden. Honest version: your current position is a starting point, not a verdict, and there are routes from it. So the plan shrinks to one doable step, and here it is, picked: today, write down the one role you want next and the one person who could open a door to it. That is the whole task for today — small, real, and it counts." };
    }
    const fabrication = [
      /\b(fabricat|falsif|lie|lying|fake|make up|invent|exaggerate)\b[^.]*\b(resume|cv|experience|internship|gpa|credential|reference)\b/i,
      /\bput\b[^.]*\bon my resume\b[^.]*\b(even if|haven'?t (done|worked)|never did|not true)\b/i,
      /\bcheat\b[^.]*\b(assessment|interview|test|exam|coding)\b/i,
      /\b(someone else|a friend|pay someone) (to )?(take|do|sit)\b[^.]*\b(assessment|interview|test|exam)\b/i,
      /\bimpersonat/i,
      /\bhide\b[^.]*\b(failed|fired|expelled|disqualifier|background check)\b/i,
    ];
    if (fabrication.some((re) => re.test(t))) {
      return {
        action: "refuse",
        reason: "fabrication_or_cheating",
        text: "I won't help with that. Fabricated experience is the one move that can end this career before it starts: background checks catch it, offers get rescinded, and firms share notes — people get blacklisted for it. What I will do: present the real work you have in its strongest truthful form, and build you the fastest honest plan to gain the missing experience — a project, a smaller internship, a role one rung down that makes the claim true. Want me to start there?",
        offer: "truthful_reframing_and_experience_plan",
      };
    }
    if (/\b(infer|guess|tell me|figure out)\b[^.]*\b(race|gender|ethnicity|religion|national origin|disability)\b/i.test(t) || /\bfrom (his|her|their) (name|photo)\b/i.test(t)) {
      return { action: "refuse", reason: "protected_attribute_inference", text: "I don't infer or use protected characteristics — not from names, not from photos, not at all. Analysis here runs on experience, education and skills only. Ask me about any of those and I'll dig in." };
    }
    return { action: "proceed" };
  }

  // ---------- INTL-007: refresh schedule + outdated reports ----------
  function refreshDue(cir, now) {
    const v = validateCIR(cir, { now });
    const populationDue = isDay(cir.as_of) && isDay(now) && ageDays(cir.as_of, now) > 90;
    return {
      company_id: cir.company_id,
      as_of: now,
      status_refresh_due: v.stale.filter((s) => s.kind === "hiring_status"),
      process_refresh_due: v.stale.filter((s) => s.kind !== "hiring_status"),
      population_refresh_due: populationDue,
      schedule: "top-company status monthly, population quarterly, plus event-driven refresh on layoffs, freezes, new programs",
    };
  }
  function reportOutdated(cir, report, now) {
    // The report is logged against the record and the record's facts are re-flagged for verification (§5 feedback loop).
    const due = refreshDue(cir, now);
    return {
      company_id: cir.company_id,
      logged_at: now,
      report: String(report || ""),
      action: "flagged_for_reverification",
      facts_to_recheck: [...due.status_refresh_due, ...due.process_refresh_due].map((s) => s.path),
      note: "A user report never silently edits a company file: the flagged facts are re-verified against sources first, then the record is rebuilt with a new date.",
    };
  }

  return { CONFIDENCE, FACT_KINDS, DIST_FIELDS, K_ANON, THIN_BELOW, validateCIR, loadCIRs, loadCIRsFromDir, getCIR, cohortStats, compareMe, planPath, composeThesis, verifyClaims, verifyThesis, lintAdvice, respondToRequest, refreshDue, reportOutdated, numbersIn, detectRole, barForRole, roleKbStats, kbStatsText, answerRoleIntel, ROLE_LENSES };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerIntel;
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const [cmd, ...rest] = process.argv.slice(2);
  const files = cmd === "validate-dir" ? fs.readdirSync(rest[0]).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(rest[0], f)) : rest;
  if ((cmd === "validate" || cmd === "validate-dir") && files.length) {
    let bad = 0;
    for (const f of files) {
      const cir = JSON.parse(fs.readFileSync(f, "utf8"));
      const r = CareerIntel.validateCIR(cir, { now: new Date().toISOString().slice(0, 10) });
      console.log(`${f}: ${r.ok ? "OK" : "INVALID"} errors=${r.errors.length} warnings=${r.warnings.length} stale=${r.stale.length}`);
      for (const e of r.errors) console.log(`  ERROR ${e.path}: ${e.message}`);
      if (!r.ok) bad++;
    }
    process.exit(bad ? 1 : 0);
  } else {
    console.log("usage: node 125-career-intel.js validate <cir.json> [...] | validate-dir <dir>");
    process.exit(2);
  }
}
