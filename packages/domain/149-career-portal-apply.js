/* Career portal apply — CA-03 sandbox leg (Spec 2 §6.1 pipeline + §6.3
   browser rules, enforced as code, not prompts).
   What this module IS: the portal driver for the apply family. It drives a
   hosted application form through a page-adapter ("board") seam — analyze
   the form, fill it from CONFIRMED profile facts only, stop ON the final
   review screen (the doorstep) with an exact would-submit payload snapshot,
   and submit ONLY on an explicit owner approval, exactly once, with
   timeout -> needs_human reconciliation (§8.3). §6.3 rules are hard code:
     - employer-hosted forms on TESTED ATS families only (Greenhouse,
       Lever, Ashby, SmartRecruiters); LinkedIn / Indeed apply automation
       is refused by construction (AGGREGATOR_APPLY_FORBIDDEN);
     - one isolated session per user; a session refuses any other user;
     - a captcha / verification code at any point STOPS the run and hands
       the user the link to finish the last step (CAPTCHA_HANDOFF) — this
       module contains no solver call and no disguise technique, ever;
       the one exception (WO-096) is the code the application system
       EMAILS the person: for a drive the person approved on its card,
       runApplyWithEmailCode reads it from their own Gmail (read-only,
       with their Google consent) and fills it, then stops at the doorstep
       for the person's own Submit (D-029 rule 5: nothing is pressed);
       otherwise the run stops EMAIL_CODE_REQUIRED naming their next step;
     - legal attestation fields are never auto-answered; they need the
       user's explicit per-run confirmation. EEO defaults to
       "Decline to self-identify" unless the user chose otherwise (§6.1).
   What this module is NOT: a browser. The board seam is the page adapter;
   in this build two boards exist — createSandboxBoard below (a faithful
   Greenhouse-shaped hosted form over a LOCAL receipt sink, labeled
   SANDBOX/TEST, following the 133 makeTestBoard / F3 form-driver pattern)
   and the module-150 Playwright driver (packages/domain/
   150-career-portal-browser.js), which drives REAL hosted forms to the
   doorstep. Its submit leg is ARMED-ONLY (BUG-063 / lane defect D3): a
   browser board transmits only when submitDoorstep below arms it from
   an approval that carries the owner's batch approval reference
   (approval.approvalRef) on top of approvedByUser — approval alone, or
   a board constructed armed for the test lane, are the only other
   paths, and an unarmed board's submit() throws REAL_SUBMIT_DISABLED.
   Since MI-116 the approval must also carry the doorstep's payload
   hash (approval.payloadSha256): submitDoorstep re-builds the
   would-submit payload from the board's CURRENT answers and refuses
   APPROVAL_PAYLOAD_MISMATCH before arming if any value changed, any
   field gained an answer, or any answer was cleared since approval
   (Spec 2 §10 — changing a payload after approval invalidates it).
   The §6.3 host gate is enforced on EVERY navigation hop (BUG-060 /
   D1): a redirect off the allowlist surfaces from the driver as a typed
   HOST_REDIRECT_REFUSED stop, and a board exposing zero fillable fields
   is a typed EMPTY_FORM stop, never a doorstep (BUG-061 / D2).
   classifyTarget can recognize a real ATS URL, but runApply refuses
   any board that is neither a registered sandbox board nor the attested
   browser driver (REAL_PORTAL_NOT_WIRED). Account-walled boards
   (Workday/iCIMS/Taleo) and the owner's signed-in session remain future,
   owner-gated work — see docs/career/board-automation-map.md.
   No volume caps (owner, 2026-10-27: D-MS-2, "never set a limit"; the
   §6.4 numbers 15/day, 5/vendor/day and 1/company/30 days are gone). A
   run or submit stops only on the never-twice-to-the-same-job rule
   (§8.3, DUPLICATE_APPLICATION) or on the employer's site refusing right
   now (PORTAL_REFUSING: a rate limit it answered with, kept as a
   "portal_refused" ledger record until the time it allows again).
   That ledger never contained the user's own hand-filed applications,
   so the never-twice rule also reads what the host knows — tracker
   rows and user statements passed as manualApplications — and a match
   on the same canonical job stops ALREADY_APPLIED_BY_USER naming the
   source of the knowledge (MI-108 / G3), at the doorstep and again at
   click time.
   Pure: no network, no clock except values passed in. UMD. */
const CareerPortalApply = (() => {
  const crypto = (() => { try { return require("crypto"); } catch (e) { return null; } })();
  const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

  const ATS_HOSTS = [
    { re: /(^|\.)greenhouse\.io$/, family: "greenhouse" },
    { re: /(^|\.)lever\.co$/, family: "lever" },
    { re: /(^|\.)ashbyhq\.com$/, family: "ashby" },
    { re: /(^|\.)smartrecruiters\.com$/, family: "smartrecruiters" },
  ];
  const AGGREGATOR_HOSTS = [/(^|\.)linkedin\.com$/, /(^|\.)indeed\.com$/];
  const EEO_DECLINE = "Decline to self-identify";
  // The EEO decline MEANING CLASS (DECLINE-VOCAB lane, 2026-10-21; the
  // doctrine is D8 / BUG-067 in the browser helper): the decline default
  // is ONE semantic choice worded a dozen ways across boards — the
  // dropdown-measure lane (cc2932c9) recorded the boards' own renderings
  // on 24 verified fills: "I don't wish to answer" x19, "Decline To Self
  // Identify" x4, "I prefer not to say" x1. The class is DATA in the
  // WO-020 question_map shape — ordered named pattern rules over
  // normalized text; the first that matches names why — so it can fold
  // into the shared meaning map verbatim when that lands on this line
  // (seam: docs/career/decline-vocab-2026-10-21.md). ONE home: this
  // module's export. Patterns are regex SOURCES (serializable data);
  // they are written against normMeaningText below, which is the
  // helper's normOpt verbatim (lowercase, curly quotes dropped,
  // punctuation -> space, spaces collapsed) — the same normalization
  // the on-page matcher (scripts/career/portal-browser-helper.cjs,
  // isDeclineText) evaluates, and the class's union is semantically
  // identical to that matcher's vocabulary, pinned by
  // tests/career-decline-vocab.test.cjs.
  const EEO_DECLINE_MEANING = [
    { name: "decline_word", pattern: "decline" },
    { name: "prefer_not", pattern: "prefer not" },
    { name: "wish_not", pattern: "do not wish|don t wish|dont wish" },
    { name: "not_answer", pattern: "not (to )?answer" },
    { name: "not_disclose", pattern: "not (to )?disclose" },
    { name: "no_answer", pattern: "no answer" },
    // F-024 / one-class audit (2026-10-22): the browser helper learned Lever's "I do not want to answer" while this
    // list did not, so the gate would refuse the fill the helper chose. The helper now reads THIS list (no copy), and
    // the phrasings the answer-option matcher already knew are part of the class.
    { name: "want_not", pattern: "do not want to answer|dont want to answer|don t want to answer" },
    { name: "rather_not", pattern: "rather not" },
    { name: "choose_not", pattern: "choose not" },
    { name: "not_identify", pattern: "not (to )?(self identify|identify|specify|say)" },
  ];
  // One regex source over normMeaningText's output, for callers that cannot import a module (the in-page matcher).
  const EEO_DECLINE_SOURCE = EEO_DECLINE_MEANING.map((r) => "(?:" + r.pattern + ")").join("|");
  const normMeaningText = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const EEO_DECLINE_RULES = EEO_DECLINE_MEANING.map((r) => ({ name: r.name, re: new RegExp(r.pattern) }));
  // The first rule that matches names why the text is decline-class
  // (WO-020: each rule names why it matched); null when it is not.
  function eeoDeclineMatch(text) {
    const t = normMeaningText(text);
    if (!t) return null;
    for (const r of EEO_DECLINE_RULES) if (r.re.test(t)) return r.name;
    return null;
  }
  const isEeoDeclineText = (text) => eeoDeclineMatch(text) !== null;
  // Spec 2 §6.4 caps (15/day, 5/vendor/day, 1/company/30 days; MI-110) are REMOVED: the owner, 2026-10-27, D-MS-2 and
  // "no person limit, never set a limit". Upmore sets no volume number of its own. What still stops an application:
  // the exact same posting already submitted for this person (never twice), and the employer's application site
  // refusing right now (a rate limit or a bot wall it answered with): that portal waits until it allows again.
  // MUSE-F-025: the bounded re-scan of a zero-field form read (see the
  // discover step in prepareRound and docs/apply/ROOT-CAUSE-F025-2026-10-22.md).
  const EMPTY_FORM_RESCAN_MAX_READS = 5;
  const EMPTY_FORM_RESCAN_BUDGET_MS = 10000;

  const normName = (v) => String(v == null ? "" : v).toLowerCase().replace(/\(test\)/gi, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  // ---------- §6.3 target classification ----------
  function classifyTarget(url) {
    let host = "";
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch (e) {
      return { allowed: false, code: "BAD_URL", host: "", kind: null };
    }
    if (AGGREGATOR_HOSTS.some((re) => re.test(host))) {
      return { allowed: false, code: "AGGREGATOR_APPLY_FORBIDDEN", host, kind: "aggregator",
        reason: "LinkedIn / Indeed apply automation is never built (§6.3) — the penalty would fall on the user's own account" };
    }
    const ats = ATS_HOSTS.find((a) => a.re.test(host));
    if (ats) return { allowed: true, code: null, host, kind: "employer_ats", atsFamily: ats.family };
    if (host === "localhost" || /(^|\.)test$/.test(host)) {
      return { allowed: true, code: null, host, kind: "sandbox", atsFamily: null };
    }
    return { allowed: false, code: "UNTESTED_ATS_HOST", host, kind: "unknown",
      reason: "only tested ATS families (Greenhouse, Lever, Ashby, SmartRecruiters) and registered sandbox boards may be driven (§6.3)" };
  }

  // ---------- the sandbox board (faithful hosted-form seam, TEST only) ----------
  // Greenhouse-shaped field set. Behaviors are switchable so the §11(F)
  // suite can stage a captcha, a submit timeout (with or without the
  // receipt landing), and an account name that mismatches the profile.
  const SANDBOX_FIELDS = [
    { field_id: "full_name", label: "Full name", kind: "standard", profile_key: "name", required: true },
    { field_id: "email", label: "Email", kind: "standard", profile_key: "email", required: true },
    { field_id: "phone", label: "Phone", kind: "standard", profile_key: "phone", required: false },
    { field_id: "location", label: "Location", kind: "standard", profile_key: "location", required: false },
    { field_id: "resume", label: "Resume", kind: "standard", profile_key: "resume", required: true },
    { field_id: "work_authorization", label: "Are you authorized to work in the US?", kind: "screening", question_key: "work_authorization", required: true },
    { field_id: "sponsorship", label: "Will you require sponsorship?", kind: "screening", question_key: "sponsorship", required: true },
    { field_id: "cover_note", label: "Cover note", kind: "free_text", question_key: "cover_note", required: false },
    { field_id: "gender", label: "Gender (voluntary)", kind: "eeo", question_key: "eeo_gender", required: false },
    { field_id: "certify_true", label: "I certify the above is true", kind: "attestation", question_key: "certify_true", required: true },
  ];
  function createSandboxBoard(opts) {
    const o = opts || {};
    const state = {
      answers: {}, submitted: null, confirmationSeq: 0,
      submitOutcome: o.submitOutcome || "accepted",
      captchaAt: o.captchaAt || null, // null | "open" | "review"
      // Mass submission: the site refusing for load at open ({ retryAfterS }): HTTP 429 / 503 Retry-After, before any fill.
      rateLimited: o.rateLimited || null,
      accountName: o.accountName !== undefined ? o.accountName : "Alex Testcase (TEST)",
      // WO-096: a code step at review ({ ats, expect }): the board emailed a code and its review waits until the one it
      // sent is typed. The code is the page's own state, never one of the application's answers.
      codeStep: o.codeStep || null, codeAccepted: false, codeTries: 0,
      // MUSE-F-023: extra (TEST) fields, e.g. a fixed-option select. A field carrying `options` honors module 150's
      // fill contract: only one of its own options lands; anything else is REFUSED (returns undefined, recorded in
      // fillFailures as option_not_found) — the board never picks a "closest" option for a value it does not offer.
      extraFields: Array.isArray(o.extraFields) ? o.extraFields : [], fillFailures: [],
    };
    const calls = { open: 0, fill: 0, submit: 0 };
    const optNorm = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
    const allFields = () => SANDBOX_FIELDS.concat(state.extraFields);
    return {
      kind: "sandbox", sandbox: true, atsFamily: "greenhouse",
      host: "sandbox.greenhouse-like.test",
      calls,
      get accountName() { return state.accountName; },
      setSubmitOutcome(v) { state.submitOutcome = v; },
      open() {
        calls.open += 1;
        if (state.rateLimited) return { ok: false, rateLimited: true, retryAfterS: state.rateLimited.retryAfterS ?? null };
        return { ok: true, captcha: state.captchaAt === "open" ? "challenge" : null };
      },
      form() { return { fields: allFields().map((f) => Object.assign({}, f)), captchaAt: state.captchaAt }; },
      get fillFailures() { return state.fillFailures.slice(); },
      fill(fieldId, value) {
        calls.fill += 1;
        const def = state.extraFields.find((f) => f.field_id === fieldId);
        if (def && Array.isArray(def.options) && def.options.length) {
          const hit = def.options.find((op) => optNorm(op.label) && (optNorm(op.label) === optNorm(value) || optNorm(op.value) === optNorm(value)));
          if (!hit) { state.fillFailures.push({ field_id: fieldId, reason: "option_not_found", wanted: String(value) }); return undefined; }
          state.answers[fieldId] = hit.label; return hit.label;
        }
        state.answers[fieldId] = value; return value;
      },
      answers() { return Object.assign({}, state.answers); },
      atReview() {
        if (state.captchaAt === "review") return { ok: true, captcha: "challenge" };
        if (state.codeStep && !state.codeAccepted) return { ok: true, emailCode: { ats: state.codeStep.ats || "greenhouse", rejected: state.codeTries > 0 } };
        return { ok: true, captcha: null };
      },
      fillCode(code) { state.codeTries += 1; state.codeAccepted = !!state.codeStep && code === state.codeStep.expect; return state.codeAccepted; },
      get codeAccepted() { return state.codeAccepted; },
      submit() {
        calls.submit += 1;
        if (state.codeStep && !state.codeAccepted) return { outcome: "timeout" }; // the employer holds it until its code comes
        if (state.submitOutcome === "accepted") {
          state.confirmationSeq += 1;
          state.submitted = { confirmationId: `SBX-${String(state.confirmationSeq).padStart(4, "0")}`, answers: Object.assign({}, state.answers) };
          return { outcome: "accepted", confirmationId: state.submitted.confirmationId };
        }
        if (state.submitOutcome === "timeout_receipt") {
          state.confirmationSeq += 1;
          state.submitted = { confirmationId: `SBX-${String(state.confirmationSeq).padStart(4, "0")}`, answers: Object.assign({}, state.answers) };
          return { outcome: "timeout" }; // the receipt landed; the driver cannot know yet
        }
        return { outcome: "timeout" }; // timeout_noreceipt: nothing landed
      },
      submissionState() {
        return state.submitted
          ? { submitted: true, confirmationId: state.submitted.confirmationId }
          : { submitted: false, confirmationId: null };
      },
    };
  }

  // ---------- isolated per-user session (§6.3) ----------
  let sessionSeq = 0;
  function createPortalSession(input) {
    const inp = input || {};
    if (!inp.userId) throw new Error("createPortalSession: userId is required — sessions are per-user, never shared");
    if (!inp.board) throw new Error("createPortalSession: a board (page adapter) is required");
    sessionSeq += 1;
    return {
      sessionId: `PS-${sessionSeq}`, userId: inp.userId, board: inp.board,
      doorstep: null, submission: null, needsReconcile: false,
    };
  }

  // ---------- profile contract: standard-field value resolution ----------
  // Flat keys live on the profile itself (name, email, phone, location,
  // linkedin, github, website, current_company, preferred_name, country).
  // Education keys (BUG-062 / lane defect D4) live under profile.education
  // in the fact-bank F-001 shape — { school, degree, discipline,
  // start_date, end_date, gpa, graduation_year } — with a flat
  // profile["education_<key>"] accepted as a fallback. A key that
  // resolves nowhere is an ask (no_confirmed_fact), never invented.
  const EDUCATION_KEYS = ["school", "degree", "discipline", "start_date", "end_date", "gpa", "graduation_year"];
  function profileValue(profile, key) {
    if (!profile || !key) return undefined;
    if (key === "resume") return profile.resume;
    if (key.startsWith("education_")) {
      const sub = key.slice("education_".length);
      if (profile.education && profile.education[sub] !== undefined) return profile.education[sub];
      return profile[key];
    }
    return profile[key];
  }

  // ---------- answer derivation: the answer map is DERIVED from the fact bank (BUG-238 / FR-396) ----------
  // The bug: the pipeline's answer map was hand-maintained and lagged
  // the bank — it carried only work_authorization + sponsorship, so
  // drives stopped on questions the bank already answered ("Are you 18
  // or older?" with the DOB fact on file — Claude Corps staging,
  // 2026-10-15). The map is now BUILT from the bank's confirmed facts:
  // every derived answer names the fact ID it traces to, only
  // status:"confirmed" facts feed it, and answerMapCoverage() reports
  // any bank fact KIND that neither a derivation nor a reasoned
  // exemption accounts for — the contract test
  // (tests/career-portal-answer-map.test.cjs) fails on an uncovered
  // kind, so a growing bank forces the wiring instead of silently
  // stopping drives. Hand-adding an answer key with no declared
  // fact-kind source is likewise a test failure: ANSWER_KEY_SOURCES is
  // the only place a key may be declared.
  const ANSWER_KEY_SOURCES = {
    work_authorization: ["eligibility"],
    sponsorship: ["eligibility"],
    age_18_plus: ["profile"],          // derived from the date-of-birth fact vs the run's clock
    located_in_us: ["profile"],        // derived from the country fact
    education_level: ["education"],    // the level token of the education fact's degree
    years_of_experience: ["experience"], // the span of the experience facts, in completed years
    experience_3mo_plus: ["experience"], // the same span against a 3-month threshold
  };
  // Fact kinds that are profile MATERIAL (documents, tailoring,
  // research) rather than portal screening answers — exempt from
  // answer derivation WITH the reason recorded. A kind listed nowhere
  // (not consumed, not exempt) is uncovered and fails the contract.
  const NON_ANSWER_FACT_KINDS = {
    leadership: "club/leadership record — resume and profile material, never a screening answer",
    certification: "credential record — resume/document material, never a screening answer",
    other: "interests and miscellany — profile material only",
    skill: "skill inventory — tailoring material, not a screening answer",
    research: "research record — fellowship/essay material, not a portal screening answer",
    metric: "company metrics — essay/profile material, not a screening answer",
  };
  // MUSE-F-007: the person's saved answers to application questions
  // (application_answer; application_text, the long ones) are read ONLY
  // through the WO-102 answer contract (extension/src/apply_core.ts:
  // trustedManifest + ownAnswerOnly, passed in as the bundle — never
  // copied here). Kept answers fill only the question they were given to
  // (savedAnswerFor in prepareRound). A contract of another quarantine
  // version is not read until this consumer is reviewed against it.
  const SAVED_ANSWER_KINDS = ["application_answer", "application_text"];
  const SAVED_ANSWER_CONTRACT = "d007-v1";
  const normQuestion = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  function savedAnswersOf(bank, contract, owner) {
    const facts = bank.facts.filter((f) => f && SAVED_ANSWER_KINDS.indexOf(f.kind) >= 0);
    if (!facts.length || !owner || !contract || contract.QUARANTINE_VERSION !== SAVED_ANSWER_CONTRACT
      || typeof contract.trustedManifest !== "function" || typeof contract.ownAnswerOnly !== "function") return [];
    const str = (v) => (v === undefined || v === null ? "" : String(v));
    const saved = {};
    for (const f of facts) {
      saved[str(f.id)] = Object.assign({ value: str(f.value), factId: str(f.id), confirmed: f.status === "confirmed" && f.needs_confirmation !== true,
        provenance: f.provenance, confirmation_event_id: f.confirmation_event_id, authorizes: f.authorizes === true },
      f.user_id ? { user_id: f.user_id } : {}, Array.isArray(f.derived_from) ? { derived_from: f.derived_from } : {});
    }
    const m = contract.trustedManifest({ owner, file: { user_id: owner, saved }, rows: [], resume: null });
    if (!m || m.version !== SAVED_ANSWER_CONTRACT || !m.byFactId) return [];
    const out = [];
    for (const f of facts) {
      const tf = m.byFactId[str(f.id)];
      const question = normQuestion(f.question);
      if (!tf || tf.value !== str(f.value) || !question) continue;
      if (f.kind === "application_text" && !f.company) continue; // a long answer is written for one employer
      if ((contract.ownAnswerOnly(str(f.question)) || contract.ownAnswerOnly(question)) && tf.authorizes !== true) continue;
      out.push({ question, kind: f.kind, value: tf.value, company: f.company ? str(f.company) : null, factId: tf.factId,
        confirmation_event_id: tf.event, provenance: tf.provenance, manifest_hash: m.hash, quarantine_version: m.version });
    }
    return out;
  }
  const US_STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };
  // City -> IANA zone for the bank's own residence only. A residence
  // outside this table derives NO time-zone answer (the field stays an
  // ask) — the zone is a fact about where the person lives, never a guess.
  const CITY_TIME_ZONES = { "Chicago": "America/Chicago", "Hawthorn Woods": "America/Chicago" };
  const DEGREE_LEVELS = [
    { re: /\bph\.?d\b|doctorate|doctoral/i, level: "PhD" },
    { re: /\bmaster/i, level: "Master's Degree" },
    { re: /\bbachelor/i, level: "Bachelor's Degree" },
    { re: /\bassociate/i, level: "Associate's Degree" },
    { re: /\bhigh school|secondary/i, level: "High School Diploma" },
  ];
  function fullYearsBetween(fromIso, nowMs) {
    const from = new Date(String(fromIso || ""));
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(nowMs)) return null;
    const now = new Date(nowMs);
    let years = now.getUTCFullYear() - from.getUTCFullYear();
    const m = now.getUTCMonth() - from.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < from.getUTCDate())) years -= 1;
    return years;
  }
  function monthsBetween(fromYear, nowMs) {
    const y = parseInt(String(fromYear || ""), 10);
    if (!Number.isFinite(y) || !Number.isFinite(nowMs)) return null;
    const now = new Date(nowMs);
    return (now.getUTCFullYear() - y) * 12 + now.getUTCMonth(); // start year read as January of that year
  }
  function stateFromPlace(place) {
    const tail = String(place || "").split(",").pop().trim();
    if (!tail) return null;
    if (/^[A-Za-z]{2}$/.test(tail)) return US_STATE_NAMES[tail.toUpperCase()] || null;
    return tail; // already a full state name as the owner stated it
  }
  // deriveAnswers(bank, now) -> { answers, profileFields, traces }.
  // `answers` drops straight into profile.answers (each entry carries
  // confirmed:true only when its source fact is confirmed, plus the
  // factId trace); `profileFields` carries the flat profile keys the
  // same facts answer (preferred_name, state_of_residence, time_zone,
  // country, date_of_birth, and the education block in the F-001
  // contract shape). Nothing here invents: a source fact that is
  // absent or unconfirmed yields no entry, and the field stays an ask.
  // opts.contract + opts.owner (MUSE-F-007): the WO-102 bundle and whose
  // bank this is; without them `savedAnswers` stays empty.
  function deriveAnswers(bank, now, opts) {
    const out = { answers: {}, profileFields: {}, traces: {}, savedAnswers: [] };
    if (!bank || !Array.isArray(bank.facts)) return out;
    out.savedAnswers = savedAnswersOf(bank, opts && opts.contract, opts && opts.owner);
    const nowMs = tsMs(now);
    const confirmed = (f) => f && f.status === "confirmed" && f.needs_confirmation !== true;
    const byKindName = (kind, nameRe) => bank.facts.find((f) => f.kind === kind && nameRe.test(f.name || f.title || ""));
    const put = (key, value, factId, how) => {
      out.answers[key] = { value, confirmed: true, factId };
      out.traces[key] = { factId, how };
    };
    // eligibility facts (F-020 / F-021 shape: kind eligibility, value Yes/No)
    const wa = byKindName("eligibility", /work authorization/i);
    if (confirmed(wa) && wa.value !== undefined) put("work_authorization", wa.value, wa.id, "eligibility fact value");
    const sp = byKindName("eligibility", /sponsorship/i);
    if (confirmed(sp) && sp.value !== undefined) put("sponsorship", sp.value, sp.id, "eligibility fact value");
    // profile facts: country, date of birth, hometown (F-022 / F-023 / F-024 shape)
    const country = byKindName("profile", /^country$/i);
    if (confirmed(country) && country.value) {
      out.profileFields.country = country.value;
      out.traces.country = { factId: country.id, how: "country fact value" };
      if (/^united states$/i.test(String(country.value))) put("located_in_us", "Yes", country.id, "country fact = United States");
    }
    const dob = byKindName("profile", /date of birth/i);
    if (confirmed(dob) && dob.value) {
      out.profileFields.date_of_birth = dob.value;
      out.traces.date_of_birth = { factId: dob.id, how: "date-of-birth fact value" };
      const age = fullYearsBetween(dob.value, nowMs);
      if (age !== null) put("age_18_plus", age >= 18 ? "Yes" : "No", dob.id, `age ${age} computed from the DOB fact at the run's date`);
    }
    const hometown = byKindName("profile", /hometown/i);
    const basics = bank.basics || {};
    const stateSrc = (confirmed(hometown) && hometown.value) || basics.location || null;
    const state = stateSrc ? stateFromPlace(stateSrc) : null;
    if (state) {
      out.profileFields.state_of_residence = state;
      out.traces.state_of_residence = { factId: confirmed(hometown) ? hometown.id : "basics.location", how: "state parsed from the residence the bank carries" };
    }
    const citySrc = (confirmed(hometown) && hometown.value) || basics.location || "";
    const city = String(citySrc).split(",")[0].trim();
    if (city && CITY_TIME_ZONES[city]) {
      out.profileFields.time_zone = CITY_TIME_ZONES[city];
      out.traces.time_zone = { factId: confirmed(hometown) ? hometown.id : "basics.location", how: `IANA zone of the bank's residence city (${city})` };
    }
    if (basics.name) {
      const first = String(basics.name).trim().split(/\s+/)[0];
      if (first) { out.profileFields.preferred_name = first; out.traces.preferred_name = { factId: "basics.name", how: "first token of the bank's full name (no separate preferred-name fact on file)" }; }
    }
    // education facts (F-001 shape): the level token + the education block
    const edu = bank.facts.find((f) => f.kind === "education");
    if (confirmed(edu)) {
      const degreeText = [edu.title || "", edu.text || ""].join(" ");
      const lvl = DEGREE_LEVELS.find((d) => d.re.test(degreeText));
      if (lvl) put("education_level", lvl.level, edu.id, "degree level token from the education fact");
      const block = {};
      if (edu.org) block.school = edu.org;
      const degMatch = String(edu.title || "").match(/(?:pursuing\s+)?(bachelors?[^\n,]*|masters?[^\n,]*|ph\.?d[^\n,]*)/i);
      if (degMatch) block.degree = degMatch[1].trim();
      if (block.degree) { const disc = block.degree.replace(/^(bachelors?|masters?|ph\.?d)\s+(in\s+)?/i, "").trim(); if (disc && disc !== block.degree) block.discipline = disc; }
      if (edu.start) block.start_date = String(edu.start);
      if (edu.end) { block.end_date = String(edu.end); block.graduation_year = String(edu.end); }
      if (bank.defaults && bank.defaults.gpa) block.gpa = String(bank.defaults.gpa);
      if (Object.keys(block).length) { out.profileFields.education = block; out.traces.education = { factId: edu.id, how: "education block from the education fact's structured fields" }; }
    }
    // experience facts: the span answers duration questions (F-002.. shape)
    const exps = bank.facts.filter((f) => f.kind === "experience" && confirmed(f) && f.start);
    if (exps.length) {
      const earliest = exps.reduce((a, b) => (String(a.start) <= String(b.start) ? a : b));
      const months = monthsBetween(earliest.start, nowMs);
      if (months !== null && months >= 0) {
        put("years_of_experience", Math.floor(months / 12), earliest.id, `completed years across the experience span (earliest fact ${earliest.id}, ${earliest.start} -> run date)`);
        put("experience_3mo_plus", months >= 3 ? "Yes" : "No", earliest.id, `experience span is ${months} months at the run's date`);
      }
    }
    return out;
  }
  // Coverage: every fact kind the bank carries is either consumed by a
  // derivation above or exempted with a reason in NON_ANSWER_FACT_KINDS.
  // Anything else is uncovered — the contract test fails on it, which
  // is the point: a new confirmed fact kind forces its wiring here.
  function answerMapCoverage(bank) {
    const kinds = new Set();
    if (bank && Array.isArray(bank.facts)) for (const f of bank.facts) if (f && f.kind) kinds.add(f.kind);
    if (bank && bank.basics && Object.keys(bank.basics).length) kinds.add("basics");
    const consumedKinds = new Set([].concat(...Object.values(ANSWER_KEY_SOURCES)));
    consumedKinds.add("basics"); // preferred_name / location corroboration derive from the basics block
    for (const k of SAVED_ANSWER_KINDS) consumedKinds.add(k); // savedAnswersOf, through the WO-102 contract
    const consumed = [], exempt = [], uncovered = [];
    for (const k of kinds) {
      if (consumedKinds.has(k)) consumed.push(k);
      else if (NON_ANSWER_FACT_KINDS[k]) exempt.push({ kind: k, reason: NON_ANSWER_FACT_KINDS[k] });
      else uncovered.push(k);
    }
    return { consumed: consumed.sort(), exempt: exempt.sort((a, b) => (a.kind < b.kind ? -1 : 1)), uncovered: uncovered.sort() };
  }

  // ---------- the executor's input writer: bank -> portal inputs (LOOP-INPUT) ----------
  // The batch executor (and the in-turn batch seam) drives 149 from a
  // 149-shaped profile + an attestations map. Until this composition
  // existed, NO product code produced either from the user's record:
  // the stored master carried basics null / answers null /
  // attestations null on the live account, every prepare stopped at
  // the same uncovered questions, and the loop could not move
  // (LOOP-INPUT-NO-WRITER, final set Doc 1 A3). This is the missing
  // pipeline stage — derivation, built once, keyed only to the
  // user's own stored bank. Its layers mirror the saved-answers
  // composition the extension serves (extension_sync.js
  // composeSavedAnswers — the same layers in the same order, so the
  // surfaces cannot disagree about what a bank answers):
  //   1. identity from the bank's basics, verbatim (no derivation);
  //   2. the bank's stored answers with confirmed === true, verbatim;
  //   3. deriveAnswers over the bank (confirmed facts only, each
  //      entry carrying its factId trace);
  //   4. the constraints/defaults seam for keys still unanswered
  //      (sponsorship / work authorization from the constraints the
  //      sensitive-correction path writes; pronouns from defaults;
  //      located_in_us from the residence the bank carries);
  //   5. the resume as { filename, sha256 } metadata, only when the
  //      record carries one with its sha256.
  // Attestations are NEVER derived from facts. They come from exactly
  // two sources, both the user's own explicit acts: an attestation
  // already stored on the record (explicit === true, passed through
  // verbatim), and — for certify_true — the batch approval act
  // itself, passed in as opts.approvalAct { runId, cardSha256 } by
  // the caller that holds the user's committed "Approve batch
  // <runId>" intent. No approval act, no certify_true: the field
  // stays an ask at prepare and the batch waits at its card.
  function workAuthorizationToken(text) {
    const t = String(text || "").trim();
    if (/^yes\b/i.test(t)) return "Yes";
    if (/^no\b/i.test(t)) return "No";
    if (/not authorized|not eligible to work|no work authorization/i.test(t)) return "No";
    if (/citizen|permanent resident|green card|lawful permanent|authorized to work|eligible to work|employment authorization|work permit/i.test(t)) return "Yes";
    return t;
  }
  function portalInputsFromBank(bank, opts) {
    const o = opts || {};
    const out = { profile: null, attestations: {}, traces: {} };
    if (!bank || typeof bank !== "object") return out;
    const nowMs = tsMs(o.now != null ? o.now : Date.now());
    // Derivation reads the 122 fact shape (status / needs_confirmation).
    // A looser stored shape (confirmed: true, no status) is normalized
    // on a CLONE — the stored record is never mutated, and a fact that
    // carries an explicit draft status is never promoted.
    const normBank = cloneBankForDerivation(bank);
    const b = (bank.basics && typeof bank.basics === "object") ? bank.basics : {};
    const links = (b.links && typeof b.links === "object") ? b.links : {};
    const profile = { answers: {} };
    const setP = (k, v) => { if (v !== undefined && v !== null && String(v) !== "") profile[k] = v; };
    setP("name", b.name || b.full_name || bank.name);
    setP("email", b.email || bank.email);
    setP("phone", b.phone);
    setP("location", b.location);
    setP("linkedin", links.linkedin || b.linkedin);
    setP("github", links.github || b.github);
    setP("website", links.portfolio || links.website || b.website);
    setP("current_company", b.current_company || b.currentCompany);
    const derived = deriveAnswers(normBank, Number.isFinite(nowMs) ? nowMs : Date.now());
    for (const [k, v] of Object.entries(derived.profileFields || {})) setP(k, v);
    for (const [k, t] of Object.entries(derived.traces || {})) out.traces[k] = t;
    const r = bank.resume || b.resume || null;
    if (r && r.sha256) profile.resume = { filename: r.filename || "resume.pdf", sha256: r.sha256 };

    const answers = {};
    const stored = (bank.answers && typeof bank.answers === "object") ? bank.answers : {};
    for (const [k, a] of Object.entries(stored)) {
      if (a && a.confirmed === true && a.value !== undefined && a.value !== null && String(a.value) !== "") {
        answers[k] = JSON.parse(JSON.stringify(a));
        if (a.factId) out.traces[k] = { factId: a.factId, how: "stored saved answer on the profile record" };
      }
    }
    for (const [k, a] of Object.entries(derived.answers || {})) answers[k] = a;

    const c = (bank.constraints && typeof bank.constraints === "object") ? bank.constraints : {};
    const dfl = (bank.defaults && typeof bank.defaults === "object") ? bank.defaults : {};
    const seam = (key, value, factId, how) => {
      if (answers[key] || value === undefined || value === null || String(value) === "") return;
      answers[key] = { value, confirmed: true, factId };
      out.traces[key] = { factId, how };
    };
    if (typeof c.needsSponsorship === "boolean") {
      seam("sponsorship", c.needsSponsorship ? "Yes" : "No", "profile.constraints.needsSponsorship",
        "saved sponsorship answer from the profile constraints (the sensitive-correction record)");
    }
    if (typeof c.workAuthorization === "string" && c.workAuthorization.trim()) {
      seam("work_authorization", workAuthorizationToken(c.workAuthorization), "profile.constraints.workAuthorization",
        "saved work-authorization answer from the profile constraints (the sensitive-correction record)");
    }
    if (typeof dfl.pronouns === "string" && dfl.pronouns.trim()) {
      seam("pronouns", dfl.pronouns, "profile.defaults.pronouns", "recorded pronouns default on the profile");
    }
    if (!answers.located_in_us) {
      const hometown = (normBank.facts || []).find((f) => f.kind === "profile" && /hometown/i.test(f.name || f.title || "") && f.status === "confirmed" && f.needs_confirmation !== true);
      const residence = (hometown && hometown.value) || b.location || "";
      const tail = String(residence).split(",").pop().trim().replace(/\s*\(.*?\)\s*$/, "");
      const isUs = (/^[A-Za-z]{2}$/.test(tail) && US_STATE_CODES.has(tail.toUpperCase()))
        || US_STATE_NAMES_LOWER.has(tail.toLowerCase());
      if (isUs || /^united states$/i.test(String(profile.country || ""))) {
        seam("located_in_us", "Yes", hometown ? hometown.id : "basics.location",
          "the residence the record carries is in a US state (the same source deriveAnswers reads for state_of_residence)");
      }
    }
    profile.answers = answers;
    out.profile = profile;

    const storedAtt = (bank.attestations && typeof bank.attestations === "object") ? bank.attestations : {};
    for (const [k, a] of Object.entries(storedAtt)) {
      if (a && a.explicit === true && a.value !== undefined) {
        out.attestations[k] = JSON.parse(JSON.stringify(a));
        out.traces[`attestation:${k}`] = { factId: "profile.attestations", how: "the user's own stored explicit attestation, passed through verbatim" };
      }
    }
    if (o.approvalAct && o.approvalAct.runId) {
      out.attestations.certify_true = {
        value: true, explicit: true, source: "batch_approval",
        runId: o.approvalAct.runId, cardSha256: o.approvalAct.cardSha256 || null,
      };
      out.traces["attestation:certify_true"] = { factId: "batch_approval", how: "the user's own approval of this batch's card is the attestation act — derived only under a committed approve intent for this run and card" };
    }
    return out;
  }
  const US_STATE_CODES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
  const US_STATE_NAMES_LOWER = new Set(Object.values(US_STATE_NAMES).map((n) => n.toLowerCase()).concat(["district of columbia"]));
  function cloneBankForDerivation(bank) {
    const clone = JSON.parse(JSON.stringify(bank));
    if (Array.isArray(clone.facts)) {
      for (const f of clone.facts) {
        if (!f || typeof f !== "object") continue;
        if (f.status == null && f.confirmed === true) f.status = "confirmed";
        if (f.needs_confirmation == null && typeof f.needsConfirmation === "boolean") f.needs_confirmation = f.needsConfirmation;
      }
    }
    return clone;
  }

  // ---------- §6.1 step 3: form analysis ----------
  function analyzeForm(formDef) {
    return (formDef.fields || []).map((f) => ({
      field_id: f.field_id, label: f.label || f.field_id,
      category: f.kind || "unknown", required: !!f.required,
    }));
  }

  // ---------- §6.4 caps: decided numbers, enforced (MI-110 / BUG-233) ----------
  // Counts come from the submissions ledger (log.records, status
  // "submitted") — the same records submitDoorstep writes, so the ledger
  // is the per-user record across threads wherever the host persists it.
  function tsMs(ts) {
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    const ms = Date.parse(String(ts == null ? "" : ts));
    return Number.isFinite(ms) ? ms : NaN;
  }
  function daySlice(ts) {
    if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10);
    return String(ts == null ? "" : ts).slice(0, 10);
  }
  function vendorOf(r) {
    if (!r) return null;
    if (r.vendor) return r.vendor;
    if (r.url) return classifyTarget(r.url).atsFamily || null;
    return null;
  }
  // The portal a refusal is kept against: its host when known, else its ATS family.
  function portalOf(posting, board) {
    const p = posting || {};
    let host = null;
    try { if (p.url) host = new URL(p.url).host.toLowerCase(); } catch (e) { host = null; }
    return { host: host || (board && board.host) || null, vendor: p.vendor || vendorOf(p) || (board && board.atsFamily) || null };
  }
  // What the employer's site said: it refuses until `until`. Kept as a record of the submissions ledger (status
  // "portal_refused"), so it is saved with the ledger and every later drive that reads it waits too. As long as the site
  // asked (Retry-After), else 30 s doubling on each refusal in a row, at most an hour between tries.
  const isRefusal = (r) => !!r && r.status === "portal_refused" && !!r.host;
  function recordRefusal(log, posting, board, now, retryAfterS, why, userId) {
    if (!log) return null;
    if (!Array.isArray(log.records)) log.records = [];
    const where = portalOf(posting, board), nowMs = tsMs(now);
    const base = Number.isFinite(nowMs) ? nowMs : Date.now();
    const prior = log.records.filter((r) => isRefusal(r) && r.host === where.host && tsMs(r.timestamp) > base - 2 * 3600000).length;
    const waitMs = retryAfterS != null && Number.isFinite(Number(retryAfterS)) && Number(retryAfterS) >= 0
      ? Math.min(Number(retryAfterS) * 1000, 86400000) : Math.min(3600000, 30000 * Math.pow(2, prior));
    const rec = { userId: userId || null, status: "portal_refused", canonicalKey: (posting && posting.canonicalKey) || null, host: where.host, vendor: where.vendor,
      why: why || "rate_limited", timestamp: new Date(base).toISOString(), until: new Date(base + waitMs).toISOString() };
    log.records.push(rec);
    return rec;
  }
  // No volume caps (owner, 2026-10-27). Stops only: the same posting already submitted for this person, and a portal
  // refusing right now. `counts` are reported for the record, never compared with a number.
  function capCheck(log, userId, posting, now, board) {
    const p = posting || {};
    const recs = ((log && log.records) || []).filter((r) => r.userId === userId && r.status === "submitted");
    const day = daySlice(now);
    const where = portalOf(p, board);
    const vendor = where.vendor;
    const company = p.company || null;
    const companyKey = company ? normName(company) : "";
    const nowMs = tsMs(now);
    const WINDOW30 = 30 * 24 * 3600 * 1000;
    let today = 0, vendorToday = 0, company30Days = 0;
    for (const r of recs) {
      if (day && daySlice(r.timestamp) === day) {
        today += 1;
        if (vendor && vendorOf(r) === vendor) vendorToday += 1;
      }
      if (companyKey && r.company && normName(r.company) === companyKey) {
        const ms = tsMs(r.timestamp);
        if (Number.isFinite(ms) && Number.isFinite(nowMs) && ms <= nowMs && nowMs - ms < WINDOW30) company30Days += 1;
      }
    }
    const counts = { today, vendorToday, company30Days };
    const stops = [];
    if (p.canonicalKey && recs.some((r) => r.canonicalKey === p.canonicalKey)) stops.push({ cap: "samePosting", postingKey: p.canonicalKey });
    const refusing = ((log && log.records) || []).filter((r) => isRefusal(r) && r.host === where.host && Number.isFinite(nowMs) && tsMs(r.until) > nowMs)
      .sort((x, y) => tsMs(y.until) - tsMs(x.until))[0];
    if (refusing) stops.push({ cap: "portalRefusing", host: refusing.host, vendor: refusing.vendor || vendor, until: refusing.until, why: refusing.why });
    return { ok: stops.length === 0, stops, counts, vendor, company };
  }
  // The stop a capCheck refusal becomes, in one place for every gate.
  function capStop(s) {
    if (s.cap === "samePosting") {
      return { code: "DUPLICATE_APPLICATION", extra: { reason: "this exact posting was already submitted for this person — never twice" } };
    }
    return { code: "PORTAL_REFUSING", extra: { host: s.host, until: s.until, why: s.why,
      reason: `the employer's application site is turning requests away right now (${s.why === "bot_check" ? "a verification wall" : "too many requests"}); nothing was filled or sent, and this one waits until ${s.until}` } };
  }

  // ---------- §8.3 collision check: the user's own hand-filed applications (MI-108 / G3) ----------
  // The caps above count only this module's submissions ledger — records
  // the PRODUCT wrote. An application the user filed by hand never enters
  // that ledger, so the never-twice rule was blind to it: the product
  // could apply to a job the user already holds an application at, and
  // the employer's duplicate handling merges or flags the pair (Spec 2
  // §8.3). The host passes what it knows as manualApplications — tracker
  // rows (module 126; hand applications land there via user-reported
  // updates) and user statements, normalized to
  // { company, title, stage, source, at, canonicalKey? }. A record is
  // evidence when (a) its origin is not the product itself (a
  // product-origin record is the caps' domain, not this check's), (b)
  // its stage proves an application exists (applied or beyond — a
  // saved/interested row is not an application), and (c) it names the
  // SAME canonical job: a canonical-key match is decisive; otherwise
  // company AND title must both match (title by normalized equality or
  // >= 0.75 token overlap of the smaller title, so "Software
  // Engineering Intern" matches its "(Summer)" variant but never a
  // different role at the same company). The stop names the source of
  // the knowledge — tracker or the user's own statement — never a guess.
  const APPLIED_STAGES = new Set(["applied", "submitted", "interview", "interviewing", "phone_screen", "onsite", "assessment", "oa", "offer", "rejected", "withdrawn", "closed", "hired"]);
  const PRODUCT_ORIGINS = new Set(["product", "portal", "submission", "self"]);
  function titleTokenOverlap(a, b) {
    const tok = (v) => new Set(normName(v).split(" ").filter((t) => t.length >= 3));
    const A = tok(a), B = tok(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const t of A) if (B.has(t)) hit += 1;
    return hit / Math.min(A.size, B.size);
  }
  function collisionCheck(manualApplications, posting) {
    const p = posting || {};
    const pCompany = p.company ? normName(p.company) : "";
    const pTitle = p.title || p.role || "";
    const pKey = p.canonicalKey || null;
    for (const r of manualApplications || []) {
      if (!r) continue;
      const origin = String(r.source || r.origin || "").toLowerCase();
      if (PRODUCT_ORIGINS.has(origin)) continue; // the caps' domain
      const stage = String(r.stage || r.status || "").toLowerCase();
      if (r.applied !== true && !APPLIED_STAGES.has(stage)) continue; // no application exists yet
      const rKey = r.canonicalKey || r.jobKey || null;
      let sameJob = false;
      if (pKey && rKey) sameJob = pKey === rKey;
      else if (pCompany && r.company && normName(r.company) === pCompany) {
        const rTitle = r.title || r.role || "";
        sameJob = normName(rTitle) === normName(pTitle) || titleTokenOverlap(rTitle, pTitle) >= 0.75;
      }
      if (!sameJob) continue;
      const source = /statement/.test(origin) ? "user statement"
        : /user-reported|reported/.test(origin) ? "tracker (user-reported)"
        : "tracker";
      return { collision: { company: r.company || p.company || null, title: r.title || r.role || pTitle || null,
        stage: stage || "applied", source, at: r.at || r.timestamp || null } };
    }
    return { collision: null };
  }

  function capReport(log, userId, posting, now, board) {
    const recs = (log && log.records) || [];
    const chk = capCheck(log, userId, posting, now, board);
    return {
      decisionPending: false, enforced: true, // the gates below are enforced; there is no volume number (owner, 2026-10-27)
      volumeLimit: null,
      submittedToday: chk.counts.today,
      counts: chk.counts,
      wouldStop: chk.stops,
      submittedThisPosting: recs.filter((r) => r.userId === userId && r.status === "submitted" && posting && r.canonicalKey === posting.canonicalKey).length,
    };
  }

  function qualityGateHits(filled, posting) {
    const hits = [];
    for (const [fieldId, entry] of Object.entries(filled)) {
      const v = entry.value;
      if (typeof v === "string") {
        if (/\[[^\]]*\]|\bTODO\b|\bLOREM\b/i.test(v)) hits.push({ field_id: fieldId, reason: "placeholder_text" });
        if (entry.source === "user_confirmed_draft") {
          // §6.4: generated text naming the wrong company is THE embarrassing failure.
          const mentions = v.match(/\b(?:apply|applying|join|joining) to ([A-Z][A-Za-z0-9&.' ]{2,40})/);
          if (mentions && normName(mentions[1]) && !normName(v).includes(normName(posting.company)) && normName(mentions[1]) !== normName(posting.company)) {
            hits.push({ field_id: fieldId, reason: "wrong_company_named", named: mentions[1].trim(), expected: posting.company });
          }
        }
      }
    }
    return hits;
  }

  // ---------- the exact would-submit payload, from the board's CURRENT answers ----------
  // One builder for both hash moments (MI-116): runApply hashes its
  // output at the doorstep; submitDoorstep re-builds and re-hashes at
  // click time. Same construction, same string — comparable by design.
  // Combine composition (2026-10-15): the answer/field sources are the
  // union of the board's live readback and the session's preparation
  // accumulation (Codex's multi-round prepareRound records answers from
  // earlier form rounds in preparationPayload/preparationFields; a live
  // readback at the final review may only expose the current round's
  // elements). Live answers win on conflict — the same precedence the
  // worker branch's inline construction used.
  // `overlay` (WO-094) carries the values a card-time certification WILL
  // send — used only to build the doorstep payload the card shows before
  // anything is ticked; the click-time compare reads the board without it.
  function buildPayload(board, session, overlay) {
    const formDef = board.form();
    const boardAnswers = Object.assign({}, (session && session.preparationPayload) || {}, board.answers(), overlay || {});
    // Keep first-observed form order across pages so a review hash does
    // not depend on which section is visible. Current definitions win.
    const fields = new Map();
    for (const f of [...((session && session.preparationFields) || []), ...(formDef.fields || [])]) {
      if (f) fields.set(f.field_id, f);
    }
    const payload = {};
    for (const f of fields.values()) {
      if (boardAnswers[f.field_id] === undefined) continue;
      payload[f.field_id] = f.field_id === "resume"
        ? { filename: boardAnswers[f.field_id].filename, sha256: boardAnswers[f.field_id].sha256 }
        : boardAnswers[f.field_id];
    }
    if (boardAnswers.resume && boardAnswers.resume.sha256) payload.resume_sha256 = boardAnswers.resume.sha256;
    return payload;
  }

  // ---------- WO-094: the approval card is the attestation act ----------
  // In card-approval mode (input.cardApproval, set by the batch loop) a
  // legal attestation field is neither auto-answered nor an ask: it is
  // PENDING on the doorstep. The doorstep payload shows the value the yes
  // will send, and the hash binds the certification text itself
  // (attestation_text), so a changed text is a different payload. Nothing
  // is ticked until submitDoorstep receives that one application's
  // attestation from the card's yes, bound to this payload hash.
  const attestationText = (f) => String((f && (f.label || f.field_id)) || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
  // 150 classifies attestations from checkboxes only: ticking is `true`.
  // A field offering options has no known certify value — it stays an ask.
  const attestationValue = (f) => (Array.isArray(f && f.options) && f.options.length ? undefined : true);
  function overlayOf(pending) {
    const o = {};
    for (const a of pending || []) o[a.field_id] = a.value;
    return o;
  }
  function bindAttestations(payload, pending) {
    if (!pending || !pending.length) return payload;
    const text = {};
    for (const a of pending) text[a.field_id] = a.text;
    return Object.assign({}, payload, { attestation_text: text });
  }
  function payloadMismatch(approvedHash, approvedPayload, livePayload, liveHash) {
    const changedFields = [], addedFields = [], removedFields = [];
    for (const k of Object.keys(livePayload)) {
      if (!(k in approvedPayload)) addedFields.push(k);
      else if (JSON.stringify(livePayload[k]) !== JSON.stringify(approvedPayload[k])) changedFields.push(k);
    }
    for (const k of Object.keys(approvedPayload)) if (!(k in livePayload)) removedFields.push(k);
    return { resultStatus: "blocked", code: "APPROVAL_PAYLOAD_MISMATCH",
      approvedPayloadSha256: approvedHash, livePayloadSha256: liveHash,
      changedFields, addedFields, removedFields,
      reason: !approvedHash
        ? "the approval does not bind the exact payload it approves (no payload hash) — re-approve the shown doorstep so the approval carries its payload hash (§10)"
        : `the filled payload changed after approval, so the approval is invalidated (§10) — changed: [${changedFields.join(", ")}], added: [${addedFields.join(", ")}], removed: [${removedFields.join(", ")}]; re-approve the current doorstep to submit` };
  }

  // D13 (BUG-209 / FR-365): what "missing" means for a payload value,
  // and which required fields a payload fails to carry. Ported from
  // the submit-path lineage (fix/submit-path), where the completeness
  // gate + doorstep repair were built and drive-proven on 2026-10-15;
  // this lineage's 149 never carried them — the imported guard
  // (tests/career-portal-submit-integrity.test.cjs) fails without
  // them: a required field lost at readback sailed through to a click,
  // and a hollowed doorstep payload armed. The gates below restore
  // BUG-209's enforcement on this lineage; the register/ledger
  // reconciliation (the shared register already claims FR-364/365
  // ENFORCED from the submit-path lineage) is flagged for Crew A.
  function payloadValueMissing(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return v.trim() === "";
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }
  function missingRequiredFields(fields, payload) {
    return (fields || [])
      .filter((f) => f.required && payloadValueMissing(payload[f.field_id]))
      .map((f) => ({ field_id: f.field_id, label: f.label || f.field_id }));
  }

  // ---------- WO-096: the code the application system emails, read for an approved drive ----------
  // The words the person reads when the code is not typed for them (the same as supabase/functions/_shared/
  // career_email_code.ts codeStop; tests/career-email-code-portal.test.cjs holds them equal). Never the code.
  const ATS_NAMES = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday" };
  function codeStopText(status, ats) {
    const n = ATS_NAMES[ats] || "the employer";
    if (status === "no_google_connection") return `Connect Google so I can read the code ${n} emails you, or type the code on the page yourself.`;
    if (status === "scope_missing") return `Your Google connection doesn't let me read mail. Connect Google again and allow reading mail so I can read the code ${n} emails you, or type the code on the page yourself.`;
    if (status === "ambiguous") return `Two different codes from ${n} are in your inbox, so I didn't guess. Type the newest one on the page yourself.`;
    if (status === "rejected") return `The page did not take the code from your email. Type the newest code from ${n} on the page yourself.`;
    if (status === "not_approved") return `The form asks for the code ${n} emails you. Approve the application on its card first; then I read the code from your email, or you type it on the page yourself.`;
    return `The code ${n} emails you hasn't arrived in your inbox after 3 minutes. Type the code on the page yourself when it comes.`;
  }
  function nowMs(inp) {
    if (inp && Number.isFinite(inp.nowMs)) return inp.nowMs;
    const t = inp && inp.now ? Date.parse(inp.now) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  }
  // The async leg around runApply: when the page stops on a code step, and ONLY when this drive carries the person's
  // approval of its card (input.approval.approvedByUser), readCode({ userId, ats, sinceMs }) reads the code (the worker
  // passes career_email_code.ts fetchVerificationCode, which waits up to about three minutes); a found code is filled and
  // the drive stops at the doorstep, EMAIL_CODE_FILLED: the person's own Submit (submitDoorstep) sends it (D-029 rule 5).
  // Anything else (not approved, no reader, not connected, no code yet, two codes) stays EMAIL_CODE_REQUIRED with the
  // person's next step. The code lives on the session for one fill and is cleared after.
  async function runApplyWithEmailCode(session, input, readCode) {
    const inp = input || {};
    const r = runApply(session, inp);
    if (!(r && r.resultStatus === "blocked" && r.code === "EMAIL_CODE_REQUIRED" && r.codeStatus !== "rejected")) return r;
    const approved = !!(inp.approval && inp.approval.approvedByUser === true);
    if (!approved) return Object.assign(r, { codeStatus: "not_approved", stop: codeStopText("not_approved", r.ats) });
    if (typeof readCode !== "function") return r;
    const got = await readCode({ userId: session.userId, ats: r.ats, sinceMs: r.askedAtMs });
    const status = (got && got.status) || "not_yet";
    if (status !== "found" || !got.code) {
      r.stepLog.push({ seq: r.stepLog.length + 1, action: "email_code_not_read", ats: r.ats, status });
      return Object.assign(r, { codeStatus: status, stop: got && got.stop ? got.stop : codeStopText(status, r.ats) });
    }
    r.stepLog.push({ seq: r.stepLog.length + 1, action: "email_code_read", ats: r.ats });
    session.emailCode = got.code;
    try {
      return prepareRound(session, inp, true, 1, r.stepLog);
    } finally {
      session.emailCode = null;
    }
  }

  // Coverage fraction (P2, 2026-10-22): every field on the form is
  // accounted for exactly once — filled and read back, or unfilled with
  // the rule that left it unfilled. `total` is every field the drive saw
  // across its rounds; `filled` counts fields whose readback carries a
  // value. A pending card certification is unfilled until the yes.
  function fieldCoverage(session, payload, asks) {
    const askReason = {};
    for (const a of [...((session && session.preparationAsks) || []), ...(asks || [])]) {
      if (a && a.field_id && !askReason[a.field_id]) askReason[a.field_id] = a.reason;
    }
    const pending = new Set(((session && session.pendingAttestations) || []).map((a) => a.field_id));
    const seen = new Set();
    let filled = 0;
    const unfilled = [];
    for (const f of (session && session.preparationFields) || []) {
      if (!f || seen.has(f.field_id)) continue;
      seen.add(f.field_id);
      if (pending.has(f.field_id)) { unfilled.push({ field_id: f.field_id, reason: "attestation_pending_card" }); continue; }
      if (!payloadValueMissing(payload && payload[f.field_id])) { filled += 1; continue; }
      unfilled.push({ field_id: f.field_id, reason: askReason[f.field_id] || "not_read_back" });
    }
    return { filled, total: seen.size, unfilled };
  }

  // ---------- §6.1 pipeline over the board seam ----------
  function runApply(session, input) {
    session.preparationPayload = {};
    session.preparationFields = [];
    session.pendingAttestations = [];
    session.preparationAsks = [];
    session.doorstep = null;
    session.codeFilledAts = null;
    return prepareRound(session, input, false, 0, []);
  }
  function prepareRound(session, input, continued, round, priorSteps) {
    const inp = input || {};
    const posting = inp.posting || {};
    const profile = inp.profile || {};
    const log = inp.log || { records: [] };
    const stepLog = priorSteps;
    const logStep = (action, data) => stepLog.push(Object.assign({ seq: stepLog.length + 1, action }, data || {}));
    const base = () => ({ stepLog, capReport: capReport(log, session.userId, posting, inp.now, session.board) });
    const blocked = (code, extra) => Object.assign(base(), { resultStatus: "blocked", code }, extra || {});
    // WO-096: the page asks for the code its application system just emailed the person. With the code the async leg
    // (runApplyWithEmailCode) read from the person's own Gmail for this APPROVED drive, it is typed into the page's code
    // step and the round goes on to the doorstep; the code is never an answer, never in the payload or its hash, never
    // in the step log. Without one, the run stops EMAIL_CODE_REQUIRED, saying what the person does (codeStopText).
    const emailCodeStep = (rv) => {
      if (!rv || !rv.emailCode) return null;
      const ats = rv.emailCode.ats || board.atsFamily || null;
      if (session.emailCodeAskedAtMs == null) session.emailCodeAskedAtMs = nowMs(inp);
      const code = session.emailCode;
      session.emailCode = null; // used once, whatever happens
      if (code && !rv.emailCode.rejected && typeof board.fillCode === "function") {
        board.fillCode(typeof code.reveal === "function" ? code.reveal() : String(code));
        session.codeFilledAts = ats || "employer";
        logStep("email_code_filled", { ats });
        if (round >= 7) return blocked("FORM_STEP_LIMIT", { reason: "conditional form did not stabilize within 8 observed rounds" });
        return prepareRound(session, inp, true, round + 1, stepLog);
      }
      const status = rv.emailCode.rejected ? "rejected" : "no_google_connection";
      logStep("email_code_stop", { ats, status });
      return blocked("EMAIL_CODE_REQUIRED", {
        ats, askedAtMs: session.emailCodeAskedAtMs, codeStatus: status, stop: codeStopText(status, ats),
        reason: "the form asks for the code its application system emailed the person; it is read from their own Gmail only for an application they approved, and otherwise they type it",
      });
    };

    // session binding: a session serves exactly its own user (§6.3 isolation)
    if (inp.userId && inp.userId !== session.userId) {
      logStep("session_user_refused", { sessionUser: session.userId, runUser: inp.userId });
      return blocked("SESSION_USER_MISMATCH");
    }
    const board = session.board;
    // target rules (§6.3): aggregators and untested hosts refused before any open
    const target = classifyTarget(posting.url || "");
    logStep("classify_target", { url: posting.url || null, kind: target.kind, code: target.code });
    if (!target.allowed) return blocked(target.code, { reason: target.reason || null });
    if (!board.sandbox && !(board.browserDriver === true && board.kind === "browser")) {
      // The real-browser seam (module 150) HAS landed: an attested
      // browser board may be driven, and may transmit ONLY through the
      // arming wire in submitDoorstep (approval + approvalRef, BUG-063);
      // any other non-sandbox board is still refused outright.
      return blocked("REAL_PORTAL_NOT_WIRED", { reason: "CA-03: only sandbox boards and the attested module-150 browser driver (doorstep-only, submit disabled) can be driven" });
    }
    if (target.kind === "employer_ats" && target.atsFamily && board.atsFamily && target.atsFamily !== board.atsFamily) {
      return blocked("BOARD_POSTING_MISMATCH", { reason: "the session board does not serve this posting's ATS family" });
    }
    // step 1: eligibility — posting still open (§6.1)
    if (posting.status && posting.status !== "open") {
      logStep("eligibility_stop", { reason: "posting_not_open", status: posting.status });
      return blocked("JOB_CLOSED");
    }
    // step 1/§8.3: never twice to the same job (unique (user, posting canonical key))
    const dup = (log.records || []).some((r) => r.userId === session.userId && r.canonicalKey === posting.canonicalKey && r.status === "submitted");
    if (dup) { logStep("eligibility_stop", { reason: "duplicate" }); return blocked("DUPLICATE_APPLICATION"); }

    // A site that refused and has not allowed again yet is not even opened (its refusal is in the ledger).
    {
      const held = capCheck(log, session.userId, posting, inp.now, board).stops.find((x) => x.cap === "portalRefusing");
      if (held) {
        logStep("portal_held", { host: held.host, until: held.until });
        const st = capStop(held);
        return blocked(st.code, st.extra);
      }
    }
    // open the board; a challenge here stops everything (§6.3)
    const opened = continued ? {} : board.open();
    logStep(continued ? "resume_form" : "open", { host: board.host });
    // §6.3 host gate on EVERY hop (BUG-060 / D1): the driver reports a
    // navigation that landed off the allowlist (initial URL checked
    // above is not enough — boards redirect to employer sites) as a
    // typed refusal. The run stops here: no form read, no fill, no
    // doorstep, no submit on or after the off-list page.
    if (opened && opened.rateLimited) {
      const rf = recordRefusal(log, posting, board, inp.now, opened.retryAfterS, "rate_limited", session.userId);
      logStep("portal_refused", { at: "open", host: rf && rf.host, until: rf && rf.until });
      const st = capStop({ cap: "portalRefusing", host: rf && rf.host, until: rf && rf.until, why: "rate_limited" });
      return blocked(st.code, st.extra);
    }
    if (opened && opened.code) {
      logStep("host_redirect_refused", { code: opened.code, finalUrl: opened.finalUrl || null, host: opened.host || null, at: "open" });
      return blocked(opened.code, { reason: opened.reason || "the page landed off the tested-ATS allowlist (§6.3)", finalUrl: opened.finalUrl || null, host: opened.host || null });
    }
    if (opened.captcha) {
      logStep("captcha_stop", { at: "open" });
      return blocked("CAPTCHA_HANDOFF", { handoffUrl: posting.url, screenshot_ref: opened.screenshotRef || null, reason: "a captcha/code appeared — Upmore never solves it; the user finishes the last step" });
    }
    // §11(F): the name on the board account must be the person applying
    if (board.accountName && profile.name && normName(board.accountName) !== normName(profile.name)) {
      logStep("name_mismatch_stop", { accountName: board.accountName, profileName: profile.name });
      return blocked("NAME_MISMATCH", { accountName: board.accountName, profileName: profile.name });
    }

    // steps 3+4: analyze, then fill from confirmed facts only
    // MUSE-F-025 (bounded re-scan): the first form read can land before
    // the board's client-rendered form has mounted on a slow first paint;
    // that instantaneous read legitimately returns zero fields on a
    // healthy posting, and the D2 stop below then fired on a form that
    // was not reached YET (live: batch-7ac6d3b30fa5, bracketed by drives
    // returning 27/34 fields through the same stack). A zero-field read
    // is therefore re-scanned — bounded by EMPTY_FORM_RESCAN_MAX_READS
    // total reads AND EMPTY_FORM_RESCAN_BUDGET_MS wall-clock, whichever
    // binds first; each re-read is a complete fresh discover on the
    // board, so the loop observes later paints. There is no synthetic
    // delay and no unbounded wait. inp.emptyFormRescan === false is the
    // kill switch: the exact pre-fix single read. Root cause:
    // docs/apply/ROOT-CAUSE-F025-2026-10-22.md.
    const rescanOff = inp.emptyFormRescan === false;
    const rescanT0 = Date.now();
    let formDef = board.form();
    let rescanReads = 1;
    while ((!formDef.fields || formDef.fields.length === 0) && !rescanOff
      && rescanReads < EMPTY_FORM_RESCAN_MAX_READS
      && Date.now() - rescanT0 < EMPTY_FORM_RESCAN_BUDGET_MS) {
      formDef = board.form();
      rescanReads += 1;
      logStep("empty_form_rescan", { read: rescanReads, fieldCount: (formDef.fields || []).length, elapsedMs: Date.now() - rescanT0 });
    }
    const rescanElapsedMs = Date.now() - rescanT0;
    const rescan = rescanReads > 1
      ? { reads: rescanReads, elapsedMs: rescanElapsedMs, budgetMs: EMPTY_FORM_RESCAN_BUDGET_MS, maxReads: EMPTY_FORM_RESCAN_MAX_READS, outcome: (formDef.fields || []).length ? "fields_found" : "exhausted" }
      : (rescanOff && (!formDef.fields || formDef.fields.length === 0))
        ? { reads: 1, elapsedMs: rescanElapsedMs, budgetMs: EMPTY_FORM_RESCAN_BUDGET_MS, maxReads: EMPTY_FORM_RESCAN_MAX_READS, outcome: "disabled" }
        : null;
    if (rescan && rescan.outcome === "fields_found") {
      logStep("empty_form_rescan_recovered", { reads: rescanReads, fieldCount: formDef.fields.length, elapsedMs: rescanElapsedMs });
    }
    const formAnalysis = analyzeForm(formDef);
    for (const field of formDef.fields || []) {
      if (!session.preparationFields.some((f) => f.field_id === field.field_id)) session.preparationFields.push(field);
    }
    // D2 (BUG-061): a board exposing ZERO fields is a stop, never a
    // doorstep — last night "prepared" was spoken over forms the driver
    // never actually reached, with a payload of only the resume hash.
    // F-025: the stop now consumes the bounded re-scan above; a form
    // still empty when the bound is exhausted stops exactly as before.
    if (!formDef.fields || formDef.fields.length === 0) {
      // BUG-QA-2026-10-21-03: a captcha page ALSO exposes zero fillable
      // fields — the review page after a Next click carries the
      // challenge, a submit button, and no fields at all, so this stop
      // fired before the review-stage captcha check could ever run and
      // a challenge was misreported as an empty form. A captcha present
      // on any step outranks EMPTY_FORM: probe the board's review state
      // (the helper's review command checks the challenge before any
      // click) and honor a challenge before naming the form empty.
      let rv = null;
      try { rv = typeof board.atReview === "function" ? board.atReview() : null; } catch (e) { rv = null; }
      if (rv && rv.captcha) {
        logStep("captcha_stop", { at: continued ? "review" : "form" });
        return blocked("CAPTCHA_HANDOFF", { handoffUrl: posting.url, screenshot_ref: rv.screenshotRef || null, reason: "a captcha/code appeared — Upmore never solves it; the user finishes the last step" });
      }
      logStep("empty_form_stop", { fieldCount: 0, rescanReads });
      return blocked("EMPTY_FORM", { reason: "the board exposed zero fillable fields — there is no form to prepare; this is a stop, not a doorstep", formAnalysis, rescan });
    }
    const asks = [];
    const filled = {};
    const answers = profile.answers || {};
    // MUSE-F-007: a field that would otherwise be asked takes a saved answer the contract kept, only for its exact
    // question (and, when the answer names an employer, only there); kept answers that disagree leave it asked.
    const savedAnswerFor = (f) => {
      const q = normQuestion(f.label);
      const hits = (Array.isArray(profile.savedAnswers) ? profile.savedAnswers : []).filter((s) => s && q && s.question === q
        && s.quarantine_version === SAVED_ANSWER_CONTRACT && s.factId && s.confirmation_event_id
        && (!s.company || normQuestion(s.company) === normQuestion(posting.company)));
      return hits.length && hits.every((s) => s.value === hits[0].value) ? hits[0] : null;
    };
    // MUSE-F-023: every fill goes through ONE verdict seam. The board's fill verdict is honored, never discarded: a
    // fill the board REFUSED (150 returns undefined and records state.fillFailures, e.g. option_not_found for a
    // free-text fact on a fixed-option "closest response" control; the worker bridge returns null) is NOT recorded
    // in `filled`, is logged as fill_refused, and becomes a named ask for the person — required ones gate the run as
    // awaiting_user. Nothing is mapped or guessed (D-007). A board that returns undefined WITHOUT recording a failure
    // for the field keeps the prior meaning (filled); the observation gate still checks what landed.
    // PERSISTENCE failures are not refusals: a value the board accepted but would not keep (value_did_not_persist),
    // a file input that is not mounted, or a driver error is the board's remount disease, which the person cannot
    // fix — those keep the BUG-207/209 path (carried as filled; the doorstep repair loop re-fills, and the D13 gate
    // stops INCOMPLETE_PAYLOAD if it still will not persist).
    const PERSISTENCE_FAILURE = /^(value_did_not_persist|file_input_not_mounted|fill_error:)/;
    const failuresFor = (id) => (Array.isArray(board.fillFailures) ? board.fillFailures : []).filter((x) => x && x.field_id === id);
    const attemptFill = (f, value, source, stepData) => {
      const before = failuresFor(f.field_id).length;
      const r = board.fill(f.field_id, value);
      const fresh = failuresFor(f.field_id).slice(before);
      const lastReason = fresh.length ? String(fresh[fresh.length - 1].reason || "fill_failed") : null;
      if ((r === null || (r === undefined && fresh.length)) && !(lastReason && PERSISTENCE_FAILURE.test(lastReason))) {
        const refusal = lastReason || "fill_returned_no_value";
        logStep("fill_refused", Object.assign({}, stepData, { refusal }));
        if (!asks.some((a) => a.field_id === f.field_id)) asks.push({ field_id: f.field_id, reason: "fill_refused", refusal });
        return false;
      }
      filled[f.field_id] = { value, source };
      logStep("fill", stepData);
      return true;
    };
    const fillSaved = (f, entry) => {
      const s = savedAnswerFor(f);
      if (!s) return false;
      attemptFill(f, s.value, "saved_answer", Object.assign({}, entry, { source: "saved_answer", fact_refs: [s.factId], confirmation_event_id: s.confirmation_event_id,
        derivation: "saved-answer-exact-question", manifest_hash: s.manifest_hash, quarantine_version: s.quarantine_version }));
      return true; // handled: filled, or refused and asked
    };
    for (const f of formDef.fields) {
      const entry = { field_id: f.field_id, category: f.kind };
      if (f.kind === "standard") {
        const raw = profileValue(profile, f.profile_key);
        if (raw === undefined || raw === null || raw === "") { asks.push({ field_id: f.field_id, reason: "no_confirmed_fact" }); continue; }
        const value = f.profile_key === "resume" ? { filename: raw.filename, sha256: raw.sha256 } : raw;
        attemptFill(f, value, "profile", Object.assign({}, entry, { source: "profile", profile_key: f.profile_key }));
      } else if (f.kind === "screening") {
        const a = answers[f.question_key];
        if (a && a.confirmed === true && a.value !== undefined) {
          attemptFill(f, a.value, "user_confirmed_answer", Object.assign({}, entry, { source: "user_confirmed_answer", question_key: f.question_key }));
        } else if (!fillSaved(f, entry)) { asks.push({ field_id: f.field_id, reason: a ? "answer_unconfirmed" : "no_confirmed_fact" }); }
      } else if (f.kind === "question") {
        // FDSE-QUESTION-KIND (2026-10-21, MUSE-F-026 proposed): a
        // board question with no canonical mapping (module 150 keys
        // it by its label's slug) is answered under the screening
        // contract verbatim — a confirmed stored answer or an ask.
        // Nothing is derived here either; an unanswered question
        // still stops the run, named by its field.
        const a = answers[f.question_key];
        if (a && a.confirmed === true && a.value !== undefined) {
          attemptFill(f, a.value, "user_confirmed_answer", Object.assign({}, entry, { source: "user_confirmed_answer", question_key: f.question_key }));
        } else if (!fillSaved(f, entry)) { asks.push({ field_id: f.field_id, reason: a ? "answer_unconfirmed" : "no_confirmed_fact" }); }
      } else if (f.kind === "free_text") {
        const a = answers[f.question_key];
        // WO-094: in card-approval mode a note DRAFTED for this application
        // (onCard) rides in the doorstep payload — the card shows it and the
        // hash binds it, so the yes on that exact payload confirms it.
        const onCard = !!(a && a.draft === true && a.onCard === true && inp.cardApproval === true && typeof a.value === "string" && a.value.trim());
        if (a && a.draft === true && (a.confirmed === true || onCard)) {
          const source = a.confirmed === true ? "user_confirmed_draft" : "draft_on_card";
          attemptFill(f, a.value, source, Object.assign({}, entry, { source, question_key: f.question_key }));
        } else if (!fillSaved(f, entry)) { asks.push({ field_id: f.field_id, reason: "needs_user_draft_confirmation" }); }
      } else if (f.kind === "eeo") {
        const chosen = profile.eeoChoice || null;
        const value = chosen || EEO_DECLINE;
        const source = chosen ? "user_eeo_choice" : "eeo_default_decline";
        attemptFill(f, value, source, Object.assign({}, entry, { source }));
      } else if (f.kind === "attestation") {
        const att = (inp.attestations || {})[f.field_id];
        if (att && att.explicit === true && att.value !== undefined) {
          attemptFill(f, att.value, "user_explicit_attestation", Object.assign({}, entry, { source: "user_explicit_attestation" }));
        } else if (inp.cardApproval === true && attestationValue(f) !== undefined) {
          if (!session.pendingAttestations) session.pendingAttestations = [];
          const text = attestationText(f), value = attestationValue(f);
          const at = session.pendingAttestations.findIndex((x) => x.field_id === f.field_id);
          if (at >= 0) session.pendingAttestations[at] = { field_id: f.field_id, text, value };
          else session.pendingAttestations.push({ field_id: f.field_id, text, value });
          logStep("attestation_pending_card", Object.assign({}, entry, { text }));
        } else { asks.push({ field_id: f.field_id, reason: "attestation_requires_explicit_confirmation" }); }
      } else if (!fillSaved(f, entry)) {
        asks.push({ field_id: f.field_id, reason: "unknown_field_category" });
      }
    }

    // §6.4 quality gate on everything that would be submitted
    const qHits = qualityGateHits(filled, posting);
    if (qHits.length) { logStep("quality_gate_stop", { hits: qHits }); return blocked("QUALITY_GATE", { hits: qHits }); }

    // Check observations before moving pages: a successful tool call alone
    // does not prove a required answer landed on the destination.
    const observed = board.answers();
    if (Object.keys(filled).length && !Object.keys(observed).length) return blocked("EMPTY_FORM", { reason: "no attempted answer was observed on the board", formAnalysis });
    const norm = (v) => String(v).trim().replace(/\s+/g, " ").toLowerCase();
    // F-027 (2026-10-22): per-key value equivalence at this compare
    // ONLY (the payload is never altered). A phone input is a scalar
    // fill, so the FR-395 renderedValues hatch (widget fills only)
    // never fires for it — yet boards normalize phone values on their
    // own (Lever's mask renders the US national form, dropping the
    // "+1" country prefix), and the exact compare stopped a correct
    // fill as drift (live: batch-8ef4497b16db). For fields whose
    // profile key is "phone", digit sequences are compared with a
    // single leading country "1" tolerated on either side; a
    // genuinely different number (different subscriber digits, or a
    // different country prefix) still differs and still stops. The
    // equivalence is keyed by the field's profile key — it does not
    // apply to any other key, however digit-shaped its values look.
    const digitsOf = (v) => String(v).replace(/\D+/g, "");
    const phoneDigitsEquivalent = (a, b) => {
      const strip = (d) => (d.length === 11 && d.startsWith("1") ? d.slice(1) : d);
      const da = strip(digitsOf(a)), db = strip(digitsOf(b));
      return da.length >= 7 && da === db;
    };
    // F-028 (2026-10-22): the same benign-render class on the
    // "location" profile key. A location control is a places pick —
    // scalar from this gate's perspective, so the FR-395 hatch again
    // carries nothing — and the board canonicalizes the picked place
    // by appending the country ("Chicago, IL" -> "Chicago, IL, USA";
    // live: batch-29ea020da986). The equivalence: strip ONE trailing
    // country suffix from the closed named set below, from BOTH
    // sides, after the gate's own norm; the remaining place text must
    // then match EXACTLY and be non-empty. A different city, the same
    // city name in a different state, or a longer different place
    // that merely starts with the expected text leaves a different
    // remainder and still stops. Named data, not a posting literal:
    // the set names country renderings, never places.
    const LOCATION_COUNTRY_SUFFIXES = ["usa", "u.s.a.", "us", "u.s.", "united states", "united states of america"];
    const stripLocationCountry = (v) => {
      const n = norm(v);
      for (const s of LOCATION_COUNTRY_SUFFIXES) {
        if (n.endsWith(", " + s)) return n.slice(0, n.length - s.length - 2);
      }
      return n;
    };
    const locationEquivalent = (a, b) => {
      const ra = stripLocationCountry(a), rb = stripLocationCountry(b);
      return ra.length > 0 && ra === rb;
    };
    const fieldDefOf = (fid) => (formDef.fields || []).find((x) => x.field_id === fid)
      || (session.preparationFields || []).find((x) => x.field_id === fid);
    for (const [id, planned] of Object.entries(filled)) {
      if (observed[id] === undefined) continue;
      // Composed at the v224 combine: an EMPTY readback (absent or
      // whitespace-only) is a persistence absence, not value drift —
      // the doorstep repair loop + the D13 gate (BUG-207/209) own it
      // and end it as repair or INCOMPLETE_PAYLOAD. Only a non-empty
      // observed value that DIFFERS from the confirmed fact is drift.
      if (payloadValueMissing(observed[id])) continue;
      const wanted = planned.value, actual = observed[id];
      // Composed at the v224 combine: when the board verified the fill
      // against its own rendering (FR-395 — a widget's single-value,
      // including short forms like the country dial code "+1" for
      // "United States"), the readback is compared against that
      // rendering, not the profile text. A board that renders
      // differently from BOTH is still drift and still stops here.
      // FDSE-MISMATCH (2026-10-21): the rendered value is read through
      // the board's renderedValue(fieldId) METHOD when the board
      // offers one. The property channel is a getter on the production
      // boards (150 / the worker bridge), and any wrapper that
      // snapshots own properties (an observation/logging wrapper that
      // copies non-function props once) freezes the getter at its
      // initial {} — the hatch then silently never fires and a correct
      // fill stops as drift (live: batch-5ab08dedd45c, the university
      // field). Methods survive delegation wrappers; the property
      // remains the fallback for boards that only carry it.
      const rendered = typeof board.renderedValue === "function" ? board.renderedValue(id)
        : (board.renderedValues && board.renderedValues[id]);
      const expected = rendered !== undefined ? rendered : wanted;
      // DECLINE-VOCAB (2026-10-21): an EEO fill whose intended value is
      // decline-class is the SAME answer when the board renders it in
      // any decline-class wording (EEO_DECLINE_MEANING above — the
      // measured forms are "I don't wish to answer" x19, "Decline To
      // Self Identify" x4, "I prefer not to say" x1; the old inline
      // regex lacked the wish forms and blocked 6 of 8 measured drives
      // with every fill correct). Class-vs-class ONLY, and only for EEO
      // fills (the default or the user's own EEO choice): a decline
      // intent rendered as a substantive answer — or any non-decline
      // value rendered as anything else — still mismatches below, and
      // acceptance of every non-EEO answer is exactly what it was.
      let same = typeof expected === "object" ? JSON.stringify(expected) === JSON.stringify(actual)
        : norm(expected) === norm(actual)
          || (/^(yes|no)\b/.test(norm(expected)) && norm(expected).match(/^(yes|no)\b/)[1] === norm(actual))
          || ((planned.source === "eeo_default_decline" || planned.source === "user_eeo_choice") && isEeoDeclineText(expected) && isEeoDeclineText(actual));
      // F-027: when the exact channels fail, the per-key equivalence
      // gets its say — keyed by the field's profile key, strings
      // only, and recorded in the run record when it carries the
      // acceptance (the same evidentiary standard as the hatch).
      // F-028 adds the "location" branch to this SAME block (one
      // mechanism, per-key shapes): a board-appended trailing
      // country suffix on the same place is a benign render.
      if (!same && typeof expected !== "object" && typeof actual !== "object") {
        const fd = fieldDefOf(id);
        if (fd && fd.profile_key === "phone" && phoneDigitsEquivalent(expected, actual)) {
          same = true;
          logStep("answer_observation_equivalent", { field_id: id, equivalence: "phone_digits", expected, observed: actual });
        } else if (fd && fd.profile_key === "location" && locationEquivalent(expected, actual)) {
          same = true;
          logStep("answer_observation_equivalent", { field_id: id, equivalence: "location_country_suffix", expected, observed: actual });
        }
      }
      // FR-395: hatch use is recorded in the run record — that the
      // board's rendered value was consulted as the expectation, and
      // whether the acceptance was hatch-ONLY (the raw profile value
      // alone would have mismatched the readback).
      if (rendered !== undefined) {
        logStep("answer_observation_rendered", { field_id: id, matched: !!same,
          hatch_only: !!same && typeof rendered !== "object" && typeof wanted !== "object"
            && norm(rendered) !== norm(wanted) && norm(wanted) !== norm(actual) });
      }
      if (!same) {
        // The stop record names the field AND carries both values —
        // a record that says only "the observed value differs" cannot
        // be diagnosed without re-driving the board (live:
        // batch-5ab08dedd45c's stored record named nothing).
        logStep("answer_observation_mismatch", { field_id: id, expected, observed: actual });
        return blocked("ANSWER_OBSERVATION_MISMATCH", { field_id: id, expected, observed: actual, reason: "the observed value differs from the confirmed fact; no review or submit is allowed" });
      }
    }
    for (const field of formDef.fields || []) {
      // Composed at the v224 combine: a required field that WAS filled
      // from confirmed facts (this round, or carried in the preparation
      // payload from an earlier round) but does not read back is a
      // persistence failure, not a user question — the user cannot fix
      // the board's remount disease. It falls through to the doorstep,
      // where the repair loop re-fills it and the D13 gate stops the
      // run INCOMPLETE_PAYLOAD if it still will not persist
      // (BUG-207/209, FR-364/365). The answer_not_observed ask remains
      // for required fields that were never filled at all.
      if (field.required && observed[field.field_id] === undefined && !asks.some((a) => a.field_id === field.field_id)
        && !filled[field.field_id] && !(session.preparationPayload && session.preparationPayload[field.field_id] !== undefined)
        && !(session.pendingAttestations || []).some((x) => x.field_id === field.field_id)) {
        asks.push({ field_id: field.field_id, reason: "answer_not_observed" });
      }
    }
    Object.assign(session.preparationPayload, observed);

    // required asks outstanding -> the run waits on the user (nothing invented)
    const requiredAsks = asks.filter((a) => {
      const fd = formDef.fields.find((x) => x.field_id === a.field_id);
      return fd && fd.required;
    });
    if (requiredAsks.length) {
      logStep("awaiting_user", { asks: requiredAsks.map((a) => a.field_id) });
      return Object.assign(base(), { resultStatus: "awaiting_user", asks, formAnalysis, coverage: fieldCoverage(session, session.preparationPayload, asks) });
    }

    // §8.3 collision check (MI-108 / G3): a hand-filed application to
    // this same canonical job stops the run before a doorstep is
    // presented — the caps' ledger never contained it, so without this
    // check the product would duplicate an application the user
    // already holds. submitDoorstep re-checks at click time (the
    // knowledge can arrive between doorstep and click).
    if (inp.manualApplications) session.manualApplications = inp.manualApplications;
    const collision = collisionCheck(session.manualApplications, posting);
    if (collision.collision) {
      const c0 = collision.collision;
      logStep("already_applied_stop", { company: c0.company, stage: c0.stage, source: c0.source });
      return blocked("ALREADY_APPLIED_BY_USER", { company: c0.company, title: c0.title, stage: c0.stage, source: c0.source,
        reason: `the user already holds an application at ${c0.company} for this job (stage: ${c0.stage}; source: ${c0.source}) — the product never files a duplicate (§8.3)` });
    }

    // The gate before the doorstep (no volume caps since 2026-10-27, owner): the same posting already submitted, or the
    // portal refusing right now, stops here; submitDoorstep re-checks at click time.
    const caps = capCheck(log, session.userId, posting, inp.now, board);
    if (!caps.ok) {
      const st = capStop(caps.stops[0]);
      logStep("gate_stop", { code: st.code, stops: caps.stops });
      return blocked(st.code, Object.assign({ stops: caps.stops, counts: caps.counts }, st.extra));
    }

    // the doorstep: final review, exact payload snapshot, STOP (§6.1 step 5/6 boundary)
    let review = board.atReview();
    // §6.3 hop gate at review too (BUG-060 / D1): a Next/Continue click
    // that navigated off the allowlist stops the run before any submit.
    // FORM_VALIDATION_FAILED is NOT a hop (composed at the v224
    // combine): the board never left the form — its own validation
    // rejected the page as-is, which on a remount/reset board means
    // values the drive verified were dropped after their fills. That
    // is exactly what the doorstep repair below exists for, so the
    // verdict defers: repair runs first and the review is re-checked
    // once; only a still-failing validation stops the run, under its
    // own name.
    const reviewValidationPending = !!(review && review.code === "FORM_VALIDATION_FAILED");
    if (reviewValidationPending) logStep("review_validation_deferred", { note: "the board's own validation rejects the form as-is; the doorstep repair runs before any stop is named" });
    if (review && review.code && !reviewValidationPending) {
      logStep("host_redirect_refused", { code: review.code, finalUrl: review.finalUrl || null, host: review.host || null, at: "review" });
      return blocked(review.code, { reason: review.reason || "the review step landed off the tested-ATS allowlist (§6.3)", finalUrl: review.finalUrl || null, host: review.host || null });
    }
    if (review.captcha) {
      logStep("captcha_stop", { at: "review" });
      return blocked("CAPTCHA_HANDOFF", { handoffUrl: posting.url, screenshot_ref: review.screenshotRef || null, reason: "a captcha/code appeared at the final step — Upmore never solves it; the user finishes the last step" });
    }
    const codeStep = emailCodeStep(review);
    if (codeStep) return codeStep;
    if (review.needsFields || review.advanced) {
      if (round >= 7) return blocked("FORM_STEP_LIMIT", { reason: "conditional form did not stabilize within 8 observed rounds" });
      session.preparationAsks = (session.preparationAsks || []).concat(asks);
      return prepareRound(session, inp, true, round + 1, stepLog);
    }
    if (review.atFinalReview === false && !reviewValidationPending) return blocked("FINAL_REVIEW_NOT_OBSERVED");
    // Composed at the v224 combine: the release line's buildPayload
    // signature (board, session — the union preparation state under live
    // answers) stands; the drive-blockers D11 repair loop below reassigns
    // payload per repair round, so the binding is `let`.
    const pendingAtt = (session.pendingAttestations || []).slice();
    const attOverlay = overlayOf(pendingAtt);
    let payload = buildPayload(board, session, attOverlay);
    // D2 second half (BUG-061): a payload with no actual answers in it
    // (every fill failed or read back empty) is hollow even when the
    // form had fields — it must never be spoken as a doorstep.
    if (Object.keys(payload).length === 0) {
      logStep("empty_form_stop", { fieldCount: formDef.fields.length, filledCount: 0 });
      return blocked("EMPTY_FORM", { reason: "no field value landed on the board — the would-submit payload would carry nothing but the resume hash; this is a stop, not a doorstep", formAnalysis, asks });
    }
    // D11 doorstep repair (BUG-207 / FR-364, ported from the submit-path
    // lineage): a board can drop a value AFTER its own fill verified —
    // the live board's delayed reset wiped Labelbox's name/email/
    // country/phone/location between their verified fills and the
    // doorstep readback (2026-10-15). The doorstep readback is treated
    // as a repair list: every field this run filled whose value the
    // readback no longer carries is re-filled from the same confirmed
    // value and the payload rebuilt, for up to two rounds. Repair
    // never widens what may be submitted; it only restores what was
    // already filled from confirmed facts.
    for (let round = 1; round <= 2; round++) {
      const lost = formDef.fields
        .filter((f) => filled[f.field_id] && payloadValueMissing(payload[f.field_id]))
        .map((f) => f.field_id);
      if (!lost.length) break;
      logStep("doorstep_repair", { round, fields: lost });
      for (const fieldId of lost) {
        const value = filled[fieldId].value;
        try { board.fill(fieldId, value); } catch (e) { logStep("doorstep_repair_fill_failed", { round, field_id: fieldId, code: e.code || "FILL_ERROR" }); }
      }
      payload = buildPayload(board, session, attOverlay);
    }
    // D13 (BUG-209 / FR-365, ported): the payload must carry a readback
    // value for EVERY required field. A required field missing HERE is
    // one whose value did not survive to readback even after repair —
    // a typed INCOMPLETE_PAYLOAD stop: no doorstep is recorded and no
    // approval in this run can arm a click over it.
    const missing = missingRequiredFields(formDef.fields, payload);
    if (missing.length) {
      logStep("incomplete_payload_stop", { missing: missing.map((m) => m.field_id) });
      return blocked("INCOMPLETE_PAYLOAD", { reason: "the board's readback is missing values for required fields — the fills did not persist; submitting would send a hollow application, so the run stops here", missing, formAnalysis, asks });
    }
    // Deferred review re-check (v224 combine): the payload is complete
    // and the repair has run — ask the board's validation again. Only
    // now may a FORM_VALIDATION_FAILED verdict stand, and any other
    // review outcome takes its normal path.
    if (reviewValidationPending) {
      const recheck = board.atReview();
      if (recheck && recheck.code) {
        logStep("review_validation_failed_after_repair", { code: recheck.code });
        return blocked(recheck.code, { reason: "the board's own validation still rejects the form after the doorstep repair restored every readback value — the stop is the board's, named as-is", formAnalysis, asks });
      }
      if (recheck && recheck.captcha) {
        logStep("captcha_stop", { at: "review_recheck" });
        return blocked("CAPTCHA_HANDOFF", { handoffUrl: posting.url, screenshot_ref: recheck.screenshotRef || null, reason: "a captcha/code appeared at the final step — Upmore never solves it; the user finishes the last step" });
      }
      const recheckCode = recheck && emailCodeStep(recheck);
      if (recheckCode) return recheckCode;
      if (recheck && (recheck.needsFields || recheck.advanced)) {
        if (round >= 7) return blocked("FORM_STEP_LIMIT", { reason: "conditional form did not stabilize within 8 observed rounds" });
        session.preparationAsks = (session.preparationAsks || []).concat(asks);
        return prepareRound(session, inp, true, round + 1, stepLog);
      }
      if (!recheck || recheck.atFinalReview !== true) return blocked("FINAL_REVIEW_NOT_OBSERVED");
      review = recheck;
    }
    payload = bindAttestations(payload, pendingAtt);
    const payloadSha256 = sha256(JSON.stringify(payload));
    session.doorstep = { payload, payloadSha256, postingKey: posting.canonicalKey, vendor: caps.vendor, company: posting.company || null, atFinalReview: true,
      requiredFieldIds: formDef.fields.filter((f) => f.required).map((f) => f.field_id) };
    if (pendingAtt.length) session.doorstep.attestations = pendingAtt.map((a) => Object.assign({}, a));
    logStep("doorstep_reached", { payloadSha256 });
    const prepared = Object.assign(base(), {
      resultStatus: "prepared", asks, formAnalysis, coverage: fieldCoverage(session, payload, asks),
      doorstep: Object.assign({ atFinalReview: true, payload, payloadSha256 }, pendingAtt.length ? { attestations: pendingAtt.map((a) => Object.assign({}, a)) } : {}),
    });
    // step 6: submit only on the explicit approval carried in this run.
    // MI-116 binding: an approval exercised in the same run that built
    // the payload binds to THIS payload — the step log records the
    // binding, and submitDoorstep verifies it at click time like any
    // other bound approval.
    // D-029 rule 5 (WO-096): once an emailed code was filled, nothing is pressed for the person: the doorstep waits for
    // their own Submit (submitDoorstep with their approval), whatever this run carries.
    if (session.codeFilledAts) {
      return Object.assign(prepared, { resultStatus: "awaiting_user", code: "EMAIL_CODE_FILLED",
        stop: `Filled the code ${ATS_NAMES[session.codeFilledAts] || "the employer"} emailed you. Press Submit to finish.` });
    }
    if (inp.approval && inp.approval.approvedByUser === true) {
      inp.approval.payloadSha256 = payloadSha256;
      logStep("approval_bound", { payloadSha256 });
      // The delegated result carries this run's step log + cap report
      // like every other return path (base() first, the leg's own
      // fields win) — returning the leg's bare object dropped the
      // audit trail, which hid the D11 doorstep repair from the run's
      // record (BUG-207 guards, ported from the submit-path lineage).
      return Object.assign(base(), submitDoorstep(session, inp.approval, { log, now: inp.now, posting, manualApplications: inp.manualApplications }));
    }
    return prepared;
  }

  // ---------- session reuse: resume a live prepared session (chunk 50%) ----------
  // A prepare drive's board session can outlive the drive: the board
  // service holds the filled page, still at the final review, under
  // its idle TTL. resumeApply VERIFIES that live state against the
  // stored doorstep instead of re-driving — no open() (a navigation
  // would reload the form and destroy the fills) and no fills. The
  // verification anchors, in order: the stored record must hash to
  // its own recorded hash before the board is touched at all; the
  // live board must still expose the prepared form's fields and read
  // back values that rebuild — through the SAME buildPayload MI-116
  // uses, with the session's preparation state seeded from the stored
  // payload (live answers win, exactly as at the doorstep) — to the
  // stored payload hash; and the board must still stand at the final
  // review. Success sets session.doorstep exactly as prepareRound
  // does; submitDoorstep then re-verifies the live payload hash at
  // click time, and the driver re-verifies the armed payload against
  // the live fields before the click — resume adds no trust those
  // gates do not re-check. Failures are named for the caller's
  // fallback discipline: SESSION_NOT_LIVE (the session is gone,
  // expired, or not this user's), SESSION_STATE_MISMATCH (the live
  // state differs from the prepared payload), SESSION_BINDING_INVALID
  // (the stored record is internally inconsistent). Any other stop
  // (captcha, caps, a board code) is the application's result, as a
  // fresh drive would produce it.
  const SESSION_DEATH_CODES = new Set(["SESSION_EXPIRED", "WORKER_SESSION_GONE", "WORKER_SESSION_FORBIDDEN", "BOARD_CLOSED"]);
  function resumeApply(session, input) {
    const inp = input || {};
    const posting = inp.posting || {};
    const profile = inp.profile || {};
    const log = inp.log || { records: [] };
    const stepLog = [];
    const logStep = (action, data) => stepLog.push(Object.assign({ seq: stepLog.length + 1, action }, data || {}));
    const base = () => ({ stepLog, capReport: capReport(log, session.userId, posting, inp.now, session.board) });
    const blocked = (code, extra) => Object.assign(base(), { resultStatus: "blocked", code }, extra || {});

    // session binding: a session serves exactly its own user (§6.3 isolation)
    if (inp.userId && inp.userId !== session.userId) {
      logStep("session_user_refused", { sessionUser: session.userId, runUser: inp.userId });
      return blocked("SESSION_USER_MISMATCH");
    }
    const board = session.board;
    // The stored doorstep must be internally consistent BEFORE the
    // board is addressed: a payload that does not hash to its own
    // recorded hash is never verified against and never trusted.
    const stored = inp.doorstep || null;
    if (!stored || !stored.payload || typeof stored.payload !== "object" || Array.isArray(stored.payload)
      || typeof stored.payloadSha256 !== "string"
      || sha256(JSON.stringify(stored.payload)) !== stored.payloadSha256) {
      logStep("session_binding_invalid", {});
      return blocked("SESSION_BINDING_INVALID", { reason: "the stored doorstep payload does not hash to its recorded payload hash — the binding is not trustworthy, and the session is not addressed on its word" });
    }
    // WO-094 (F-031 on trunk's design): a card-approval doorstep carries
    // its PENDING certifications — the payload holds their would-send
    // values (an overlay, never ticked on the page) and binds their text
    // (attestation_text). The resume rebuilds the payload exactly as
    // prepareRound did, so the stored hash is reproduced only when the
    // live page AND the certification text are what the card showed.
    const pendingAtt = stored.attestations == null ? [] : stored.attestations;
    if (!Array.isArray(pendingAtt) || pendingAtt.some((a) => !a || typeof a.field_id !== "string" || !a.field_id || typeof a.text !== "string" || a.value === undefined)) {
      logStep("session_binding_invalid", { cause: "attestations" });
      return blocked("SESSION_BINDING_INVALID", { reason: "the stored doorstep's pending certifications are malformed — the binding is not trustworthy, and the session is not addressed on its word" });
    }
    const pendingIds = new Set(pendingAtt.map((a) => a.field_id));
    // target rules (§6.3): the same gates prepare applies before any board use
    const target = classifyTarget(posting.url || "");
    logStep("classify_target", { url: posting.url || null, kind: target.kind, code: target.code });
    if (!target.allowed) return blocked(target.code, { reason: target.reason || null });
    if (!board.sandbox && !(board.browserDriver === true && board.kind === "browser")) {
      return blocked("REAL_PORTAL_NOT_WIRED", { reason: "CA-03: only sandbox boards and the attested module-150 browser driver (doorstep-only, submit disabled) can be driven" });
    }
    if (target.kind === "employer_ats" && target.atsFamily && board.atsFamily && target.atsFamily !== board.atsFamily) {
      return blocked("BOARD_POSTING_MISMATCH", { reason: "the session board does not serve this posting's ATS family" });
    }
    if (posting.status && posting.status !== "open") {
      logStep("eligibility_stop", { reason: "posting_not_open", status: posting.status });
      return blocked("JOB_CLOSED");
    }
    const dup = (log.records || []).some((r) => r.userId === session.userId && r.canonicalKey === posting.canonicalKey && r.status === "submitted");
    if (dup) { logStep("eligibility_stop", { reason: "duplicate" }); return blocked("DUPLICATE_APPLICATION"); }
    // §11(F): the name on the board account must be the person applying
    if (board.accountName && profile.name && normName(board.accountName) !== normName(profile.name)) {
      logStep("name_mismatch_stop", { accountName: board.accountName, profileName: profile.name });
      return blocked("NAME_MISMATCH", { accountName: board.accountName, profileName: profile.name });
    }
    try {
      // NO open(): the page is already there, filled. form() is a
      // read (discovery); answers() is a read (live readback).
      const formDef = board.form();
      const formAnalysis = analyzeForm(formDef);
      if (!formDef.fields || formDef.fields.length === 0) {
        logStep("session_state_mismatch", { cause: "empty_form" });
        return blocked("SESSION_STATE_MISMATCH", { reason: "the resumed board exposes no form — the prepared page is gone", formAnalysis });
      }
      // The resumed board must still be the prepared form's board:
      // its live field set or its live readback must carry the
      // payload's fields. A board carrying NONE of them is a
      // different page, whatever its session id claims.
      const payloadIds = Object.keys(stored.payload).filter((k) => k !== "resume_sha256" && !(pendingAtt.length && k === "attestation_text"));
      const liveIds = new Set((formDef.fields || []).map((f) => f.field_id));
      const observed = board.answers() || {};
      const covered = payloadIds.filter((id) => liveIds.has(id) || observed[id] !== undefined);
      if (payloadIds.length && covered.length === 0) {
        logStep("session_state_mismatch", { cause: "no_payload_fields_on_board" });
        return blocked("SESSION_STATE_MISMATCH", { reason: "the resumed board carries none of the prepared payload's fields — it is not the prepared page", formAnalysis });
      }
      // Rebuild the would-submit payload from the board's CURRENT
      // answers (buildPayload — the MI-116 construction), with the
      // session's preparation state seeded from the stored payload so
      // the rebuild is the same union prepare hashed at the doorstep.
      session.preparationFields = (formDef.fields || []).map((f) => ({ field_id: f.field_id, label: f.label || f.field_id, kind: f.kind, required: !!f.required, profile_key: f.profile_key || null, question_key: f.question_key || null }));
      session.preparationPayload = {};
      // a pending certification is never seeded: its value comes only
      // from the overlay, exactly as prepareRound built it
      for (const k of payloadIds) if (!pendingIds.has(k)) session.preparationPayload[k] = stored.payload[k];
      const livePayload = bindAttestations(buildPayload(board, session, overlayOf(pendingAtt)), pendingAtt);
      const liveHash = sha256(JSON.stringify(livePayload));
      if (liveHash !== stored.payloadSha256) {
        const changedFields = [], addedFields = [], removedFields = [];
        for (const k of Object.keys(livePayload)) {
          if (!(k in stored.payload)) addedFields.push(k);
          else if (JSON.stringify(livePayload[k]) !== JSON.stringify(stored.payload[k])) changedFields.push(k);
        }
        for (const k of Object.keys(stored.payload)) if (!(k in livePayload)) removedFields.push(k);
        logStep("session_state_mismatch", { changedFields, addedFields, removedFields });
        return blocked("SESSION_STATE_MISMATCH", { changedFields, addedFields, removedFields, formAnalysis,
          reason: `the resumed board's current answers differ from the prepared payload — changed: [${changedFields.join(", ")}], added: [${addedFields.join(", ")}], removed: [${removedFields.join(", ")}]; the session is discarded and a fresh drive prepares the application again` });
      }
      logStep("session_state_verified", { payloadSha256: stored.payloadSha256 });
      // Still standing at the final review? (cmdReview is read-only on
      // a page already at final review — it clicks only a "next"
      // control, and a prepared page at its doorstep has none.)
      const review = board.atReview();
      if (review && review.code) {
        logStep("host_redirect_refused", { code: review.code, finalUrl: review.finalUrl || null, host: review.host || null, at: "review" });
        return blocked(review.code, { reason: review.reason || "the review step landed off the tested-ATS allowlist (§6.3)", finalUrl: review.finalUrl || null, host: review.host || null, formAnalysis });
      }
      if (review.captcha) {
        logStep("captcha_stop", { at: "review" });
        return blocked("CAPTCHA_HANDOFF", { handoffUrl: posting.url, screenshot_ref: review.screenshotRef || null, reason: "a captcha/code appeared at the final step — Upmore never solves it; the user finishes the last step", formAnalysis });
      }
      if (review.needsFields || review.advanced) {
        logStep("session_state_mismatch", { cause: "not_at_prepared_step" });
        return blocked("SESSION_STATE_MISMATCH", { reason: "the resumed page is no longer at the prepared step — it asks for fields or advanced past the doorstep", formAnalysis });
      }
      if (review.atFinalReview === false) {
        logStep("session_state_mismatch", { cause: "not_at_final_review" });
        return blocked("SESSION_STATE_MISMATCH", { reason: "the resumed board is not at the final review the prepare drive reached", formAnalysis });
      }
      // §8.3 collision + §6.4 caps, the same re-checks prepare makes
      if (inp.manualApplications) session.manualApplications = inp.manualApplications;
      const collision = collisionCheck(session.manualApplications, posting);
      if (collision.collision) {
        const c0 = collision.collision;
        logStep("already_applied_stop", { company: c0.company, stage: c0.stage, source: c0.source });
        return blocked("ALREADY_APPLIED_BY_USER", { company: c0.company, title: c0.title, stage: c0.stage, source: c0.source,
          reason: `the user already holds an application at ${c0.company} for this job (stage: ${c0.stage}; source: ${c0.source}) — the product never files a duplicate (§8.3)` });
      }
      const caps = capCheck(log, session.userId, posting, inp.now, board);
      if (!caps.ok) {
        const st = capStop(caps.stops[0]);
        logStep("gate_stop", { code: st.code, stops: caps.stops });
        return blocked(st.code, Object.assign({ stops: caps.stops, counts: caps.counts }, st.extra));
      }
      session.doorstep = { payload: stored.payload, payloadSha256: stored.payloadSha256, postingKey: posting.canonicalKey, vendor: caps.vendor, company: posting.company || null, atFinalReview: true,
        requiredFieldIds: (formDef.fields || []).filter((f) => f.required).map((f) => f.field_id) };
      // the certifications stay PENDING on the resumed doorstep:
      // submitDoorstep ticks them only from the card's yes, bound to
      // this payload hash and text (WO-094), exactly as on a fresh one
      if (pendingAtt.length) session.doorstep.attestations = pendingAtt.map((a) => ({ field_id: a.field_id, text: a.text, value: a.value }));
      logStep("session_resumed", { payloadSha256: stored.payloadSha256 });
      return Object.assign(base(), { resultStatus: "prepared", resumed: true, formAnalysis,
        doorstep: Object.assign({ atFinalReview: true, payload: stored.payload, payloadSha256: stored.payloadSha256 }, pendingAtt.length ? { attestations: pendingAtt.map((a) => ({ field_id: a.field_id, text: a.text, value: a.value })) } : {}) });
    } catch (e) {
      if (e && SESSION_DEATH_CODES.has(e.code)) {
        logStep("session_not_live", { cause: e.code });
        return blocked("SESSION_NOT_LIVE", { cause: e.code, reason: "the board session the prepare drive left is no longer live (expired, closed, or not this user's) — a fresh drive prepares the application again" });
      }
      throw e;
    }
  }

  // continueApply: a prepare round CONTINUED on the session's live
  // page (prepareRound's continued entry — it skips open(), so the
  // page's existing fills survive). The attestation-completion seam:
  // an application that stopped at awaiting_user for its certification
  // alone is sitting filled on its board; when the certification
  // arrives, the round continues on THAT page instead of a fresh
  // board re-driving the whole form.
  function continueApply(session, input) {
    if (!session.preparationPayload) session.preparationPayload = {};
    if (!session.preparationFields) session.preparationFields = [];
    session.doorstep = null;
    return prepareRound(session, input, true, 0, []);
  }

  // ---------- the one submit leg: exactly once, reconciled, never blind ----------
  function submitDoorstep(session, approval, ctx) {
    const c = ctx || {};
    const log = c.log || { records: [] };
    if (session.needsReconcile) {
      return { resultStatus: "blocked", code: "RECONCILE_REQUIRED",
        reason: "a previous submit's outcome is unknown — read the destination state before any retry (§8.3)" };
    }
    if (session.submission && session.submission.status === "submitted") {
      return { resultStatus: "blocked", code: "ALREADY_SUBMITTED", submission: session.submission };
    }
    if (!approval || approval.approvedByUser !== true) {
      return { resultStatus: "blocked", code: "APPROVAL_REQUIRED", reason: "the doorstep stops here until the owner taps submit" };
    }
    if (!session.doorstep) {
      return { resultStatus: "blocked", code: "NO_DOORSTEP", reason: "no prepared doorstep payload in this session" };
    }
    // D13 (BUG-209 / FR-365) at the gate itself (ported from the
    // submit-path lineage): the stored doorstep payload is re-verified
    // before caps, binding, or arming — every required field the
    // doorstep was built over must still carry a value in it. A
    // hollowed payload is refused here, unarmed, unclicked.
    const gateMissing = (session.doorstep.requiredFieldIds || [])
      .filter((id) => payloadValueMissing(session.doorstep.payload[id]))
      .map((id) => ({ field_id: id }));
    if (gateMissing.length) {
      return { resultStatus: "blocked", code: "INCOMPLETE_PAYLOAD", missing: gateMissing,
        reason: "the doorstep payload is missing readback values for required fields — the submit gate refuses to arm or click over a hollow payload" };
    }
    const board = session.board;
    // Re-check at click (no volume caps since 2026-10-27): the same posting submitted since the doorstep, or the
    // portal refusing since, stops BEFORE the arming wire: such a submit never arms.
    const caps = capCheck(log, session.userId, {
      canonicalKey: session.doorstep.postingKey,
      vendor: session.doorstep.vendor || null,
      company: session.doorstep.company || (c.posting && c.posting.company) || null,
      url: (c.posting && c.posting.url) || null,
    }, c.now, board);
    if (!caps.ok) {
      const st = capStop(caps.stops[0]);
      return Object.assign({ resultStatus: "blocked", code: st.code, stops: caps.stops, counts: caps.counts }, st.extra);
    }
    // §8.3 collision re-check (MI-108 / G3): the knowledge that the
    // user already holds an application at this job can arrive between
    // doorstep and click — a duplicate must never arm. The doorstep
    // carries the canonical key + company, so the decisive match is
    // the key; company/title matching ran at the doorstep surface.
    const collision = collisionCheck(c.manualApplications || session.manualApplications, {
      canonicalKey: session.doorstep.postingKey,
      company: session.doorstep.company || (c.posting && c.posting.company) || null,
      title: (c.posting && (c.posting.title || c.posting.role)) || null,
    });
    if (collision.collision) {
      const c0 = collision.collision;
      return { resultStatus: "blocked", code: "ALREADY_APPLIED_BY_USER", company: c0.company, title: c0.title, stage: c0.stage, source: c0.source,
        reason: `the user already holds an application at ${c0.company} for this job (stage: ${c0.stage}; source: ${c0.source}) — the product never files a duplicate (§8.3)` };
    }
    // §10 payload binding (MI-116 / BUG-234): the approval binds to the
    // EXACT payload, not the job. Rebuild the would-submit payload from
    // the board's CURRENT answers and compare hashes — a value changed,
    // a field answered, or a field cleared since approval invalidates
    // the approval (Spec 2 §10). The stop lands BEFORE the arming wire:
    // a mismatched payload never arms and never clicks. An approval
    // carrying no payload hash no longer fires against a doorstep.
    const approvedHash = approval.payloadSha256 || null;
    const approvedPayload = session.doorstep.payload || {};
    // WO-094: a pending certification is ticked ONLY from this
    // application's attestation, given by the card's yes and bound to
    // this exact payload hash and certification text. No attestation, or
    // one bound to another payload, stops here: unticked, unarmed.
    const pendingAtt = session.doorstep.attestations || [];
    let attested = [];
    if (pendingAtt.length) {
      // the would-send payload first: a payload (or certification text)
      // that moved since the card is a mismatch before anything else
      const pre = bindAttestations(buildPayload(board, session, overlayOf(pendingAtt)), pendingAtt);
      const preHash = sha256(JSON.stringify(pre));
      if (!approvedHash || preHash !== approvedHash) return payloadMismatch(approvedHash, approvedPayload, pre, preHash);
      const given = approval.attestations || {};
      const lacking = pendingAtt.filter((a) => {
        const g = given[a.field_id];
        return !(g && g.explicit === true && approvedHash && g.payloadSha256 === approvedHash && g.text === a.text && JSON.stringify(g.value) === JSON.stringify(a.value));
      });
      if (lacking.length) {
        return { resultStatus: "blocked", code: "ATTESTATION_REQUIRED", fields: lacking.map((a) => ({ field_id: a.field_id, text: a.text })),
          reason: "this application's certification is given only by approving its card, bound to this exact payload — nothing is ticked or submitted without it" };
      }
      for (const a of pendingAtt) board.fill(a.field_id, a.value);
      attested = pendingAtt.map((a) => ({ field_id: a.field_id, text: a.text, value: a.value, payloadSha256: approvedHash, approvalRef: approval.approvalRef || approval.ref || c.approvalRef || null }));
    }
    const livePayload = bindAttestations(buildPayload(board, session), pendingAtt);
    const liveHash = sha256(JSON.stringify(livePayload));
    if (!approvedHash || approvedHash !== liveHash) return payloadMismatch(approvedHash, approvedPayload, livePayload, liveHash);
    // THE ARMING WIRE (BUG-063 / D3): this approval gate is the ONLY
    // place a board gets armed for a real submit. Arming requires BOTH
    // (a) this gate's pass (approvedByUser === true, checked above) AND
    // (b) an approval reference naming the owner's batch approval
    // (approval.approvalRef, or ctx.approvalRef). A board that exposes
    // no armForSubmit (the sandbox board — a local test sink) needs no
    // arming; a browser board stays unarmed without the ref and its
    // submit() throws REAL_SUBMIT_DISABLED, which propagates as before.
    const approvalRef = approval.approvalRef || approval.ref || c.approvalRef || null;
    if (board && typeof board.armForSubmit === "function") {
      board.armForSubmit({ approvedByUser: true, approvalRef, canonicalKey: session.doorstep.postingKey,
        payload: session.doorstep.payload, payloadSha256: session.doorstep.payloadSha256 });
    }
    const out = board.submit();
    if (out.outcome === "accepted") {
      session.submission = { status: "submitted", confirmationId: out.confirmationId, needsHuman: false, receiptBoard: board.kind, approvalRef, payloadSha256: approvedHash,
        confirmationText: out.confirmationText || null, screenshotRef: out.screenshotRef || null, confirmationUrl: out.finalUrl || null };
      if (attested.length) session.submission.attestations = attested;
      log.records.push({ userId: session.userId, canonicalKey: session.doorstep.postingKey, status: "submitted", timestamp: c.now || null, confirmationId: out.confirmationId, vendor: caps.vendor, company: caps.company });
      return { resultStatus: "completed", submission: session.submission, doorstep: session.doorstep };
    }
    // timeout (or any non-accept): the outcome is UNKNOWN — never spoken as sent (§8.3)
    session.needsReconcile = true;
    session.submission = { status: "unknown_outcome", needsHuman: true, receiptBoard: board.kind,
      confirmationText: out.confirmationText || null, screenshotRef: out.screenshotRef || null, confirmationUrl: out.finalUrl || null };
    return { resultStatus: "unknown_outcome", submission: session.submission,
      reason: "the board did not answer — the application may or may not have landed; check before any retry" };
  }

  // ---------- reconciliation: truth is read from the board, never from memory ----------
  function reconcile(session) {
    const st = session.board.submissionState();
    if (st.submitted) {
      session.needsReconcile = false;
      session.submission = { status: "submitted", confirmationId: st.confirmationId, needsHuman: false, receiptBoard: session.board.kind, reconciled: true,
        confirmationText: st.confirmationText || null, screenshotRef: st.screenshotRef || null };
      return { resultStatus: "completed", submission: Object.assign({ onBoard: true }, session.submission) };
    }
    if (st.unverifiable === true) {
      // The board cannot prove a negative (a real portal without account
      // access): the outcome STAYS unknown and the reconcile lock stays
      // on — a human reads the captured evidence; no retry is cleared.
      return { resultStatus: "unknown_outcome",
        submission: { status: "unknown_outcome", onBoard: null, needsHuman: true, receiptBoard: session.board.kind,
          confirmationText: st.confirmationText || null, screenshotRef: st.screenshotRef || null },
        reason: "the board's state cannot be read back — the captured confirmation evidence is attached; a human verifies before any retry" };
    }
    session.needsReconcile = false; // state is now KNOWN: nothing landed; a fresh approval may retry
    return { resultStatus: "unknown_outcome",
      submission: { status: "not_submitted", onBoard: false, needsHuman: true, receiptBoard: session.board.kind },
      reason: "the board holds no submission for this session — a retry needs a fresh approval, and the earlier attempt stays on record as an uncertain outcome" };
  }

  // ---------- MI-115 / BUG-235: unknown_outcome is not terminal — the resolver ----------
  // A bounded sweep over application records still at unknown_outcome.
  // It READS destination state (employer-side status readers) and
  // records every attempt on the record; it NEVER submits anything —
  // there is no submit path in this function. Design note (contract
  // mi-115): Spec 2 §8.3 says check the user's email first, but the
  // inbox half is NOT_WIRED — Gmail is not connected in-product
  // (MI-074 / CA-08b). An `inboxScan` seam is accepted; when it is
  // absent the attempt RECORDS inbox_unavailable instead of pretending
  // to have checked. A "submitted" claim counts only with the
  // employer's own confirmation ID attached (the BUG-208 lesson: an
  // ID-less claim is not proof). Anything unproven stays unknown and
  // gains a named userQuestion — re-presented, never silently dropped.
  function resolveUnknownOutcomes(input) {
    const inp = input || {};
    const records = inp.records || [];
    const nowMs = tsMs(inp.now);
    const minAgeMs = (inp.minAgeHours != null ? inp.minAgeHours : 24) * 3600 * 1000;
    const maxPerPass = inp.maxPerPass != null ? inp.maxPerPass : 20;
    const recId = (r) => r.appId || r.canonicalKey || null;
    const report = { attempted: 0, resolved: [], stillUnknown: [], skipped: [] };
    if (!Number.isFinite(nowMs)) {
      for (const r of records) if (r && r.status === "unknown_outcome") report.skipped.push({ id: recId(r), reason: "no_clock" });
      return report;
    }
    const eligible = records
      .filter((r) => r && r.status === "unknown_outcome")
      .sort((a, b) => (tsMs(a.timestamp) || 0) - (tsMs(b.timestamp) || 0));
    const readerFor = (rec) => {
      if (typeof inp.readers === "function") return inp.readers;
      if (inp.readers && typeof inp.readers === "object") {
        const hit = inp.readers[rec.canonicalKey] || inp.readers[rec.appId];
        if (typeof hit === "function") return hit;
        if (hit && typeof hit === "object") return () => hit;
      }
      return null;
    };
    for (const rec of eligible) {
      if (report.attempted >= maxPerPass) { report.skipped.push({ id: recId(rec), reason: "pass_bound" }); continue; }
      const ageMs = nowMs - tsMs(rec.timestamp);
      if (!Number.isFinite(ageMs) || ageMs < minAgeMs) { report.skipped.push({ id: recId(rec), reason: "too_young" }); continue; }
      const prior = rec.resolutionAttempts || [];
      const last = prior[prior.length - 1];
      if (last && Number.isFinite(tsMs(last.at)) && nowMs - tsMs(last.at) < minAgeMs) {
        report.skipped.push({ id: recId(rec), reason: "attempt_throttled" }); continue;
      }
      report.attempted += 1;
      const methodsTried = [];
      let outcome = null, method = "none_available";
      if (typeof inp.inboxScan === "function") {
        methodsTried.push("inbox_scan");
        let inboxRes = null;
        try { inboxRes = inp.inboxScan(rec); } catch (e) { inboxRes = null; }
        if (inboxRes && inboxRes.state === "submitted" && inboxRes.confirmationId) { outcome = inboxRes; method = "inbox_scan"; }
      } else {
        methodsTried.push("inbox_unavailable");
      }
      if (!outcome) {
        const reader = readerFor(rec);
        if (reader) {
          methodsTried.push("employer_status_read");
          let readerRes = null;
          try { readerRes = reader(rec); } catch (e) { readerRes = { state: "unverifiable", reason: `reader_error: ${(e && e.message) || e}` }; }
          if (readerRes) { outcome = readerRes; method = "employer_status_read"; }
        }
      }
      const attempt = { at: inp.now, method, methodsTried, result: null };
      if (methodsTried.includes("inbox_unavailable")) {
        attempt.notes = "inbox_unavailable (MI-074: Gmail not connected in-product — employer-side check only)";
      }
      if (outcome && outcome.state === "submitted" && outcome.confirmationId) {
        rec.status = "submitted";
        rec.resolvedBy = method === "inbox_scan" ? "inbox_confirmed" : "employer_confirmed";
        rec.confirmationId = outcome.confirmationId;
        rec.stillUnknown = false;
        delete rec.userQuestion;
        attempt.result = "resolved_submitted";
        report.resolved.push({ id: recId(rec), to: "submitted", resolvedBy: rec.resolvedBy, confirmationId: outcome.confirmationId });
      } else if (outcome && outcome.state === "not_submitted") {
        rec.status = "not_submitted";
        rec.resolvedBy = "employer_verified_absent";
        rec.stillUnknown = false;
        delete rec.userQuestion;
        attempt.result = "resolved_not_submitted";
        report.resolved.push({ id: recId(rec), to: "not_submitted", resolvedBy: rec.resolvedBy });
      } else {
        rec.stillUnknown = true;
        rec.userQuestion = `Did a confirmation email arrive for ${rec.company || "this application"}? The employer's board cannot prove whether the application landed, and it has stayed unknown since ${rec.timestamp || "submission"}.`;
        attempt.result = "still_unknown";
        if (outcome && outcome.state === "submitted" && !outcome.confirmationId) attempt.detail = "reader claimed submitted without a confirmation ID — not proof";
        else if (outcome && outcome.reason) attempt.detail = outcome.reason;
        report.stillUnknown.push({ id: recId(rec), userQuestion: rec.userQuestion });
      }
      if (!rec.resolutionAttempts) rec.resolutionAttempts = [];
      rec.resolutionAttempts.push(attempt);
    }
    return report;
  }

  return { classifyTarget, createSandboxBoard, createPortalSession, analyzeForm, runApply, runApplyWithEmailCode, codeStopText, submitDoorstep, reconcile, resolveUnknownOutcomes, profileValue, capCheck, collisionCheck, deriveAnswers, answerMapCoverage, ANSWER_KEY_SOURCES, NON_ANSWER_FACT_KINDS, EDUCATION_KEYS, SANDBOX_FIELDS, recordRefusal, resumeApply, continueApply, portalInputsFromBank, EEO_DECLINE_MEANING, EEO_DECLINE_SOURCE, eeoDeclineMatch, isEeoDeclineText };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerPortalApply;
