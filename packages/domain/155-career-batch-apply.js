"use strict";
/* 155-career-batch-apply.js — the batch-apply loop (LOOP ACCEPTANCE build,
   Crew B, 2026-10-15; joins list: ~/workspace/your_files/
   upmore-loop-acceptance-joins-2026-10-15.md).

   The owner's done-test: a user sends ONE message — "apply to 15
   <role-family> roles" — and Upmore runs the whole loop itself:
   discover -> dedupe -> eligibility/knockout screen -> tailor per
   posting -> batch approval (hash-bound) -> portal drives inside the
   code-enforced caps -> employer confirmations -> per-application
   report in the thread.

   This module is the ORCHESTRATION that did not exist. Every stage
   reuses an existing engine; nothing here reimplements one:
     discovery/dedupe/knockouts ... 121 (dedupe, evaluateKnockouts)
     screen ....................... 132 (checkCurrentEmployer) + 121
     tailor evidence .............. 123 (tailorResume)
     approval card shape .......... 132 (batchCard)
     the drive itself ............. 149 (createPortalSession, runApply,
                                    submitDoorstep — MI-110 caps and
                                    MI-116 payload binding live THERE)
     tracker write ................ injected by the caller (126/141 in
                                    the router seam; a recorder in tests)

   Hard constraints, inherited and enforced by the engines below:
   - Answers come only from confirmed facts: 149 stops a run whose
     required question has no confirmed answer (awaiting_user). This
     module NAMES that stop (UNCOVERED_QUESTION) — it never invents.
   - A captcha is a handoff (CAPTCHA_HANDOFF), never solved.
   - No stealth anything (Spec 2 §6.3): boards are reached only
     through 149/150's tested seams.
   - Caps are 149's (MI-110): enforced at doorstep time and re-checked
     at click time. This module defers what the cap stops; it never
     argues with the count.
   - The batch approval carries an approvalRef (Leg 1, 2026-10-15):
     approveRun mints it bound to the card set hash and executeRun
     passes it into submitDoorstep, because 149's arming wire arms a
     REAL board only under a ref — a hash-only approval left every
     real-board batch submit at REAL_SUBMIT_DISABLED (sandbox boards
     have no arming wire, which is why rehearsals never saw it). The
     guard is the REAL-board-double trajectories in
     tests/career-loop-acceptance.test.cjs.

   Cross-invocation design: the run object is PURE JSON (it survives
   the host snapshot via ctx.batchApplyState). Sessions are runtime
   only; on the execution turn they are rebuilt and re-prepared, and
   MI-116's rebuild-and-compare inside 149 is what makes a payload
   changed since the card stop itself (APPROVAL_PAYLOAD_MISMATCH).

   SESSION REUSE (MUSE-F-031, re-implemented on trunk's WO-094 design,
   2026-10-22): the board service holds a prepare drive's filled page
   alive under its idle TTL — what died at the prepare/approve seam was
   the HANDLE, so every application was driven twice. Prepare now
   records app.boardSession (the service session id + a local expiry
   stamp) and app.doorstep (the exact carded payload, its hash, and its
   PENDING certifications). The execution turn first resumes THAT
   session through 149's resumeApply, which verifies the live page
   against the stored payload (no open, no fills) before anything
   proceeds; submitDoorstep then ticks the certification from the
   card's yes and re-verifies the hash at click time, unchanged. Only
   RESUME_FALLBACK_CODES (session gone / differing / binding not
   trustworthy) fall back to the rebuild above, each named as a
   session_resume_fallback event — never silently. The session id is
   session material: run record only, never in events or summaries.

   Pure/sync like the other domain modules: the host (or the test
   harness) injects postings, profiles, boards and the clock via deps. */
const CareerBatchApply = (() => {
  const req = (p) => { try { return typeof require !== "undefined" ? require(p) : null; } catch { return null; } };
  const getJobs = () => (typeof CareerJobs !== "undefined" ? CareerJobs : req("./121-career-jobs.js"));
  const getApply = () => (typeof CareerApply !== "undefined" ? CareerApply : req("./132-career-apply.js"));
  const getTailor = () => (typeof CareerTailor !== "undefined" ? CareerTailor : req("./123-career-tailor.js"));
  const getPortal = () => { try { return typeof CareerPortalApply !== "undefined" ? CareerPortalApply : req("./149-career-portal-apply.js"); } catch { return req("./149-career-portal-apply.js"); } };
  const crypto = (() => { try { return typeof require !== "undefined" ? require("node:crypto") : null; } catch { return null; } })();

  function sha256(text) {
    if (crypto && crypto.createHash) return crypto.createHash("sha256").update(String(text)).digest("hex");
    // Bundle fallback: FNV-1a — used only for run ids / card fingerprints
    // inside the chat bundle; 149's own payload hashes (the security
    // binding) are computed by 149 with its real sha256.
    let h = 0x811c9dc5;
    const str = String(text);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `fnv1a-${h.toString(16)}`;
  }
  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();
  const dayMs = 24 * 60 * 60 * 1000;

  // ---------------- J7: the apply-verb parse ----------------
  const WORD_COUNTS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, "twenty five": 25, twentyfive: 25, thirty: 30 };
  // "apply to 15 investment banking intern roles" / "apply for 15
  // nursing roles" / "apply to fifteen software engineering roles".
  // A count is REQUIRED — the owner's bar names one; count-less apply
  // asks keep the routes they have today and are not claimed here.
  function parseApplyAsk(text) {
    const t = lc(text).replace(/\s+/g, " ").trim();
    const m = t.match(/\bapply\s+(?:to|for)\s+(\d{1,3}|twenty five|twentyfive|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)\s+(.+?)\s+(roles|jobs|positions|openings)\b/);
    if (!m) return null;
    const count = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_COUNTS[m[1]];
    if (!count || count < 1) return null;
    const familyText = m[2].trim();
    if (!familyText || familyText.length < 2) return null;
    if (/^(a|an|the|some|any)$/.test(familyText)) return null;
    return { count, familyText, unit: m[3] };
  }

  // ---------------- J2: the run object (pure JSON) ----------------
  let runSeq = 0;
  function createRun(input) {
    const inp = input || {};
    runSeq += 1;
    const now = inp.now != null ? inp.now : Date.now();
    return {
      id: `batch-${sha256(`${inp.userId}|${inp.familyText}|${inp.count}|${now}|${runSeq}`).slice(0, 12)}`,
      userId: inp.userId || null,
      familyText: inp.familyText || "",
      requested: inp.count || 0,
      status: "new", // new -> prepared(awaiting_approval) -> approved -> completed | completed_with_stops
      createdAt: now,
      found: 0,
      duplicatesRemoved: 0,
      screenedOut: [], // {postingKey, company, role, code, reasons[]}
      eligible: 0,
      selected: [], // postingKeys chosen by count, in discovery order
      deferred: [], // {postingKey, company, role, code, reason, resumeOn}
      postings: {}, // postingKey -> posting (discovery data, JSON)
      apps: {}, // postingKey -> app state (below)
      approvals: {}, // postingKey -> payloadSha256 approved on the card
      approvalRef: null, // minted by approveRun at the card's one yes,
      // bound to the card set hash — 149's arming wire requires it
      // before a REAL board (module 150) may fire (Leg 1 seam fix)
      card: null,
      cardSha256: null,
      events: [],
      summary: null,
    };
  }
  // app state: { postingKey, company, role, url, stage, stop, payloadSha256,
  //              confirmationId, tailored }
  // stages: selected | doorstep | stopped | captcha_handoff |
  //         deferred_refusal | deferred_count | submitted
  function event(run, type, data) {
    run.events.push(Object.assign({ seq: run.events.length + 1, type }, data || {}));
  }
  function appOf(run, posting) {
    const key = postingKeyOf(posting);
    if (!run.apps[key]) {
      run.apps[key] = {
        postingKey: key, company: posting.company || null, role: posting.title || posting.role || null,
        // MUSE-F-001: the posting's own link (its url, else its first http(s) source url), never an invented one.
        url: posting.url || (Array.isArray(posting.source_urls) ? posting.source_urls.find((u) => /^https?:\/\/\S+$/i.test(String(u || ""))) : null) || null, stage: "selected", stop: null, payloadSha256: null,
        confirmationId: null, tailored: null,
        doorstep: null, // { payload, payloadSha256, attestations } — the exact
        // carded payload, kept so an execution-turn resume can verify the
        // live board against it (149 resumeApply)
        boardSession: null, // { sessionId, atsFamily, host, preparedAt,
        // expiresAt } — the board-service session the prepare drive left
        // live; session material, run-record only, never logged
      };
    }
    return run.apps[key];
  }

  // ---------------- session reuse (F-031) ----------------
  // The reuse window mirrors the board service's idle session TTL
  // (workers/career-browser/board-service.cjs, 10 minutes, refreshed by
  // each board call). The stamp is only a local pre-check — the
  // service's own expiry (410) is the hard gate, and 149's
  // SESSION_NOT_LIVE is its verdict here.
  const SESSION_REUSE_TTL_MS = 10 * 60 * 1000;
  // 149 resume verdicts that mean "this session cannot carry the
  // approval" — and ONLY these — discard the resumed board and fall
  // back to a fresh drive. Any other stop (captcha, caps, a board code)
  // is the application's result, exactly as a fresh drive would name it.
  const RESUME_FALLBACK_CODES = new Set(["SESSION_NOT_LIVE", "SESSION_STATE_MISMATCH", "SESSION_BINDING_INVALID"]);
  const SESSION_DEATH_CODES = new Set(["SESSION_EXPIRED", "WORKER_SESSION_GONE", "WORKER_SESSION_FORBIDDEN", "BOARD_CLOSED"]);
  function recordBoardSession(run, app, board, res, now) {
    if (app.stage !== "doorstep" || !res || !res.doorstep || !res.doorstep.payload) return;
    if (!board || typeof board.workerSessionId !== "string" || !board.workerSessionId) return;
    const nowMs = typeof now === "number" ? now : (Date.parse(now) || Date.now());
    app.boardSession = {
      sessionId: board.workerSessionId, atsFamily: board.atsFamily || null, host: board.host || null,
      preparedAt: nowMs, expiresAt: nowMs + SESSION_REUSE_TTL_MS,
    };
    app.doorstep = {
      payload: res.doorstep.payload, payloadSha256: res.doorstep.payloadSha256,
      attestations: (res.doorstep.attestations || []).map((a) => ({ field_id: a.field_id, text: a.text, value: a.value })),
    };
    event(run, "board_session_recorded", { postingKey: app.postingKey, expiresAt: app.boardSession.expiresAt });
  }
  // Try to resume the prepare session for an approved application.
  // Returns the live portal session (verified at the doorstep), or null
  // after recording WHY it fell back; returns false when 149 named a
  // non-fallback stop that is this application's result (already
  // absorbed). Nothing is sent here: resumeApply only reads the page.
  function tryResume(run, app, d, posting, approvedSha, ctx) {
    const Portal = ctx.Portal;
    const b = app.boardSession;
    if (!b || typeof b.sessionId !== "string" || !b.sessionId) return null;
    if (typeof d.boardFor !== "function" || typeof Portal.resumeApply !== "function") return null;
    const nowMs = typeof ctx.now === "number" ? ctx.now : Date.parse(ctx.now);
    // an expired binding is not addressed at all — the fresh drive is the path
    if (Number.isFinite(nowMs) && typeof b.expiresAt === "number" && nowMs >= b.expiresAt) return null;
    const fallback = (code, cause) => { event(run, "session_resume_fallback", Object.assign({ postingKey: app.postingKey, code }, cause ? { cause } : {})); return null; };
    // the stored payload must be the one the card's yes approved — a
    // differing hash is refused before the board is even addressed
    if (!app.doorstep || app.doorstep.payloadSha256 !== approvedSha) return fallback("SESSION_BINDING_INVALID");
    let board = null;
    try { board = d.boardFor(posting, { resumeSessionId: b.sessionId, atsFamily: b.atsFamily || null, host: b.host || null }); }
    catch (e) { return fallback("SESSION_NOT_LIVE", (e && e.code) || "RESUME_BOARD_REFUSED"); }
    if (!board) return fallback("SESSION_NOT_LIVE", (d.boardFor.lastRefusal && d.boardFor.lastRefusal.code) || "RESUME_BOARD_UNAVAILABLE");
    const discard = () => { try { if (typeof board.close === "function") board.close(); } catch (_) { /* best effort; the service reaps by TTL */ } };
    let res = null;
    try {
      const session = Portal.createPortalSession({ userId: run.userId, board });
      res = Portal.resumeApply(session, { posting, profile: ctx.profile, log: ctx.log, userId: run.userId, now: ctx.now, doorstep: app.doorstep });
      if (res && res.resultStatus === "prepared" && res.doorstep && res.doorstep.payloadSha256 === approvedSha) {
        event(run, "session_resumed", { postingKey: app.postingKey, via: "execute" });
        return session;
      }
    } catch (e) {
      discard();
      if (e && SESSION_DEATH_CODES.has(e.code)) return fallback("SESSION_NOT_LIVE", e.code);
      throw e;
    }
    discard();
    if (res && res.resultStatus === "blocked" && RESUME_FALLBACK_CODES.has(res.code)) return fallback(res.code);
    if (res && res.resultStatus === "prepared") return fallback("SESSION_BINDING_INVALID");
    absorbPrepareResult(run, app, res);
    return false;
  }
  function postingKeyOf(posting) {
    if (posting && posting.canonicalKey) return posting.canonicalKey;
    const Jobs = getJobs();
    if (Jobs && Jobs.dedupeKey) { try { return Jobs.dedupeKey(posting); } catch { /* fall through */ } }
    return `${lc(posting && posting.company)}::${lc(posting && (posting.title || posting.role))}::${s(posting && posting.url)}`;
  }

  // Runtime-only state (sessions + per-posting profiles): never on the run.
  const RUNTIME = new Map(); // runId -> { sessions: {key: session}, profiles: {key: profile} }
  function runtimeFor(run) {
    if (!RUNTIME.has(run.id)) RUNTIME.set(run.id, { sessions: {}, profiles: {} });
    return RUNTIME.get(run.id);
  }

  // F-035 (bench-60 fix round, 2026-10-22): resolve a fresh board
  // for one application, or record its stop and return null. A
  // boardFor that resolves through the worker bridge records the
  // worker's coded refusal on itself (careerBoardFor.lastRefusal)
  // when it returns null; a boardFor that throws a coded error
  // directly is treated the same. The naming rule (stopForRefusal):
  // an ANSWERED refusal — the service heard the ask and decided
  // (SESSION_LIMIT, DRIVER_HOST_REFUSED, FAMILY_NOT_DRIVEABLE, …) —
  // names the stop by its own code, with the code also carried as
  // workerRefusal. A TRANSPORT-family failure — no answer ever
  // arrived (WORKER_UNREACHABLE, WORKER_TRANSPORT_TIMEOUT,
  // WORKER_TRANSPORT_CLOSED, WORKER_PROTOCOL) — is the not-wired
  // degradation the loop has always named BOARD_NOT_WIRED
  // (loop-acceptance's standing guard: a down worker stops every
  // drive BOARD_NOT_WIRED); its code is still carried as
  // workerRefusal evidence. BOARD_NOT_WIRED without a workerRefusal
  // means no board adapter exists for this posting's family at all.
  const TRANSPORT_REFUSAL_CODES = new Set(["WORKER_UNREACHABLE", "WORKER_TRANSPORT_TIMEOUT", "WORKER_TRANSPORT_CLOSED", "WORKER_PROTOCOL"]);
  function stopForRefusal(run, app, code, message) {
    if (TRANSPORT_REFUSAL_CODES.has(code)) {
      stopApp(run, app, "BOARD_NOT_WIRED", "no board adapter is wired for this posting's family in this run", { workerRefusal: code });
      return;
    }
    stopApp(run, app, code, message || `the board worker refused this session (${code})`, { workerRefusal: code });
  }
  function boardOrStop(run, app, d, posting) {
    let board = null;
    try { board = typeof d.boardFor === "function" ? d.boardFor(posting) : null; }
    catch (e) {
      if (e && e.code) { stopForRefusal(run, app, e.code, String((e && e.message) || e).slice(0, 300)); return null; }
      board = null;
    }
    if (board) return board;
    const refusal = (typeof d.boardFor === "function" && d.boardFor.lastRefusal) || null;
    if (refusal && refusal.code) { stopForRefusal(run, app, refusal.code, refusal.message); return null; }
    stopApp(run, app, "BOARD_NOT_WIRED", "no board adapter is wired for this posting's family in this run");
    return null;
  }

  // F-036 (bench-60 fix round, 2026-10-22): a board throw mid-drive
  // (measured signature: module 150's coded DRIVER_ERROR, "Target
  // crashed") becomes THIS application's named stop — never an
  // escape that blocks the intent and erases the run record. The
  // stop carries the verbatim error and the fills the board had
  // already rendered (its own renderedValues — preserved, never
  // reconstructed).
  function stopDriveThrow(run, app, board, e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    const detail = { error: msg };
    try {
      const rv = board && board.renderedValues;
      if (rv && typeof rv === "object" && !Array.isArray(rv) && Object.keys(rv).length) {
        detail.fills = JSON.parse(JSON.stringify(rv));
      }
    } catch (_) { /* a board that cannot report its fills loses nothing else */ }
    stopApp(run, app, (e && e.code) || "DRIVER_ERROR", `the portal drive threw before it could name an outcome: ${msg}`, detail);
  }

  // ---------------- prepare: discover -> screen -> tailor -> doorsteps ----
  function prepareRun(run, deps) {
    const d = deps || {};
    const Portal = getPortal();
    const Jobs = getJobs();
    const Apply = getApply();
    const Tailor = getTailor();
    const log = d.log || { records: [] };
    const now = d.now != null ? d.now : Date.now();
    const raw = Array.isArray(d.postings) ? d.postings : [];
    run.found = raw.length;
    event(run, "discovered", { found: raw.length, familyText: run.familyText });

    // dedupe (121, MI-031 identity rules: same opening merges, different
    // req ids on one board stay distinct)
    const deduped = Jobs && Jobs.dedupe ? Jobs.dedupe(raw) : raw.slice();
    run.duplicatesRemoved = raw.length - deduped.length;
    if (run.duplicatesRemoved) event(run, "deduped", { removed: run.duplicatesRemoved });

    // screen: closed -> knockouts (121) -> current employer (132) ->
    // triageBatch hard filters when a scoring profile is supplied.
    const triage = d.scoringProfile && Apply && Apply.triageBatch
      ? new Map(Apply.triageBatch(deduped, { log, profile: d.profileMaster || null, scoringProfile: d.scoringProfile }).map((x) => [x.job_id, x]))
      : null;
    const eligiblePool = [];
    for (const posting of deduped) {
      const key = postingKeyOf(posting);
      run.postings[key] = posting;
      const out = (code, reasons) => run.screenedOut.push({ postingKey: key, company: posting.company || null, role: posting.title || posting.role || null, code, reasons });
      if (posting.status && posting.status !== "open") { out("JOB_CLOSED", [`posting status is "${posting.status}" — not open`]); continue; }
      if (Jobs && Jobs.evaluateKnockouts && d.profileMaster) {
        let ko = null;
        try { ko = Jobs.evaluateKnockouts(posting, d.profileMaster); } catch { ko = null; }
        const unmet = (ko && ko.unmet) || [];
        if (unmet.length) { out("KNOCKOUT_UNMET", unmet.map((u) => u.reason || `unmet knockout: ${u.knockout && u.knockout.requirement}`)); continue; }
      }
      if (Apply && Apply.checkCurrentEmployer && d.profileMaster) {
        const emp = Apply.checkCurrentEmployer(d.profileMaster, posting.company);
        if (emp && emp.blocked) { out("CURRENT_EMPLOYER", [emp.reason || "current employer"]); continue; }
      }
      if (triage) {
        const dec = triage.get(posting.job_id);
        if (dec && dec.decision === "skip") { out("SCREEN_SKIP", dec.reasons || []); continue; }
        if (dec && dec.decision === "ask") { out("SCREEN_ASK", dec.reasons || []); continue; }
      }
      eligiblePool.push(posting);
    }
    run.eligible = eligiblePool.length;
    event(run, "screened", { eligible: run.eligible, screenedOut: run.screenedOut.length });

    // count selection: the first N eligible, in discovery order; the
    // rest stay eligible and are deferred BY COUNT — named, never dropped.
    const chosen = eligiblePool.slice(0, run.requested);
    const overflow = eligiblePool.slice(run.requested);
    run.selected = chosen.map(postingKeyOf);
    for (const posting of overflow) {
      const key = postingKeyOf(posting);
      appOf(run, posting).stage = "deferred_count";
      run.deferred.push({ postingKey: key, company: posting.company || null, role: posting.title || posting.role || null, code: "COUNT_DEFERRED", reason: `eligible, but beyond the ${run.requested} you named — it stays in the queue, it is not dropped`, resumeOn: null });
    }

    // per selected posting: tailor evidence (123), portal profile, drive
    // to the doorstep through 149. The doorstep is a STOP (Spec 2 §6.1):
    // nothing submits in prepare, ever.
    const rt = runtimeFor(run);
    for (const posting of chosen) {
      const key = postingKeyOf(posting);
      const app = appOf(run, posting);
      if (Tailor && Tailor.tailorResume && d.profileMaster) {
        try {
          const jdText = posting.jd_text || posting.jdText || `${posting.title || ""} at ${posting.company || ""}`;
          const t = Tailor.tailorResume(d.profileMaster, jdText, {});
          app.tailored = { ran: true, version: (t && t.version) || null, gaps: t && t.gaps ? t.gaps.length : null };
        } catch { app.tailored = { ran: false }; }
      }
      let profile = profileFor(d, posting);
      // SUBMIT-STEER-1130: answers recorded for THIS application only
      // (chat capture, carried in deps.appAnswers) ride this posting's
      // own profile composition and are stamped on its app record —
      // never the shared profile, never a sibling's.
      const carried = (d.appAnswers || {})[key];
      if (carried && Object.keys(carried).length) {
        app.answers = JSON.parse(JSON.stringify(carried));
        profile = Object.assign({}, profile, { answers: Object.assign({}, profile.answers || {}, JSON.parse(JSON.stringify(carried))) });
      }
      rt.profiles[key] = profile;
      const board = boardOrStop(run, app, d, posting);
      if (!board) continue;
      let res = null;
      try {
        const session = Portal.createPortalSession({ userId: run.userId, board });
        rt.sessions[key] = session;
        // WO-094: no standing attestation rides into a drive (deps.attestations
        // is not read). In card-approval mode 149 leaves a certification
        // PENDING on the doorstep; the card's yes is the attestation act.
        res = Portal.runApply(session, { posting, profile, log, userId: run.userId, now, attestations: {}, cardApproval: true });
      } catch (e) {
        // F-036: the throw is this application's outcome — stop it
        // named, keep the run record, drive the next application.
        stopDriveThrow(run, app, board, e);
        continue;
      }
      absorbPrepareResult(run, app, res);
      // SUBMIT-STEER-1130: an UNCOVERED_QUESTION stop carries the
      // question descriptors the chat path asks and binds answers to.
      if (app.stop && app.stop.code === "UNCOVERED_QUESTION") app.stop.questions = stopQuestions(res, board);
      // F-031: a doorstep application's page is still live on its board
      // session — leave the execution turn its handle + the exact payload.
      recordBoardSession(run, app, board, res, now);
    }

    // the card (132's shape) covers doorstep-ready applications only;
    // stops and defers are reported beside it, never hidden inside it.
    const doorstepApps = run.selected.map((k) => run.apps[k]).filter((a) => a.stage === "doorstep");
    if (Apply && Apply.batchCard && doorstepApps.length) {
      run.card = Apply.batchCard(doorstepApps.map((a) => ({ company: a.company, role: a.role, url: a.url, fit: null })), { title: `Apply to ${doorstepApps.length} ${run.familyText} roles?` });
      // WO-094: the card shows each application's certification text — the
      // words the yes signs, for that application only (inside its hash).
      run.card.certifications = [];
      for (const a of doorstepApps) {
        for (const at of a.attestations || []) run.card.certifications.push({ postingKey: a.postingKey, company: a.company, role: a.role, field_id: at.field_id, text: at.text });
      }
    }
    run.cardSha256 = cardSha(run);
    // APPROVAL INVALIDATION (2026-10-24): the card binds a yes only
    // while (a) it is inside its validity window and (b) the profile
    // its answers were built from still stands. The window is the
    // module's own session-reuse window: prepared forms are the
    // product of that window, and a yes landing hours later on forms
    // prepared hours earlier is exactly what approveRun must refuse.
    // The profile digest covers the answer-bearing profile the
    // drives consumed (deps.profile, pre-cover-note), canonicalized
    // so key order cannot fake a change or hide one.
    run.cardExpiresAt = doorstepApps.length ? now + SESSION_REUSE_TTL_MS : null;
    run.profileSha256 = doorstepApps.length ? profileDigestOf(d.profile || {}) : null;
    run.status = doorstepApps.length ? "awaiting_approval" : "completed";
    run.summary = summarizeRun(run);
    // Coverage fraction first: how many of the selected came through,
    // and every selected application once, with its stage and code.
    const acc = run.summary.accounting;
    event(run, "prepared", { doorstep: doorstepApps.length, status: run.status, coverage: `${acc.through}/${acc.total}`,
      outcomes: acc.outcomes.map((o) => ({ postingKey: o.postingKey, stage: o.stage, code: o.code })) });
    return run;
  }

  function profileFor(d, posting) {
    const base = d.profile || {};
    const p = typeof d.profileFor === "function" ? (d.profileFor(posting, base) || base) : base;
    // WO-094: a cover note only from a note DRAFTED for this application
    // (deps.coverNoteFor) — it rides in the doorstep payload the card
    // shows and the hash binds; without one the note stays uncovered.
    const draft = typeof d.coverNoteFor === "function" ? d.coverNoteFor(posting) : null;
    if (typeof draft !== "string" || !draft.trim()) return p;
    const out = Object.assign({}, p, { answers: Object.assign({}, p.answers || {}) });
    out.answers.cover_note = { value: draft.trim(), draft: true, onCard: true };
    return out;
  }

  function absorbPrepareResult(run, app, res) {
    if (!res) { stopApp(run, app, "NO_RESULT", "the portal run returned nothing"); return; }
    // field-level coverage from 149: fields filled and read back / fields on the form
    if (res.coverage && typeof res.coverage.total === "number") app.coverage = { filled: res.coverage.filled, total: res.coverage.total, unfilled: (res.coverage.unfilled || []).slice() };
    if (res.resultStatus === "prepared" && res.doorstep) {
      app.stage = "doorstep";
      app.payloadSha256 = res.doorstep.payloadSha256;
      app.attestations = (res.doorstep.attestations || []).map((a) => ({ field_id: a.field_id, text: a.text, value: a.value }));
      event(run, "doorstep", { postingKey: app.postingKey, company: app.company });
      return;
    }
    if (res.resultStatus === "awaiting_user") {
      // 149's required-ask gate: a required question has no confirmed
      // fact. Named here, carried verbatim — never invented around.
      stopApp(run, app, "UNCOVERED_QUESTION", "a required question has no confirmed fact — nothing was invented to fill it", { asks: res.asks || [] });
      return;
    }
    // No volume caps (owner, 2026-10-27). The employer's site refusing right now (a rate limit): this one waits until the
    // time the site allows, then resumes; nothing was filled or sent.
    if (res.resultStatus === "blocked" && res.code === "PORTAL_REFUSING") {
      app.stage = "deferred_refusal";
      run.deferred.push({ postingKey: app.postingKey, company: app.company, role: app.role, code: "PORTAL_REFUSING", reason: res.reason || "the employer's site is turning requests away right now", resumeOn: res.until || null });
      event(run, "deferred_refusal", { postingKey: app.postingKey, host: res.host || null, until: res.until || null });
      return;
    }
    if (res.resultStatus === "blocked" && res.code === "CAPTCHA_HANDOFF") {
      app.stage = "captcha_handoff";
      app.stop = { code: "CAPTCHA_HANDOFF", reason: res.reason || "a captcha appeared — Upmore never solves it", handoffUrl: res.handoffUrl || app.url };
      event(run, "captcha_handoff", { postingKey: app.postingKey });
      return;
    }
    if (res.resultStatus === "blocked") { stopApp(run, app, res.code || "BLOCKED", res.reason || "the portal run stopped", stopDetailOf(res)); return; }
    stopApp(run, app, res.code || "UNEXPECTED_RESULT", `unexpected portal result: ${res.resultStatus || "unknown"}`);
  }

  // FDSE-MISMATCH (2026-10-21): a portal stop's diagnostic detail
  // (the field an observation mismatch names, and the expected /
  // observed values) must survive into the stored app record — the
  // generic blocked paths used to forward only code + reason, so the
  // live record for batch-5ab08dedd45c could not name the field 149
  // had already identified. Carriage is whitelisted to these three
  // keys: arbitrary portal extras do not leak into the run record.
  function stopDetailOf(res) {
    if (!res) return undefined;
    const d = {};
    for (const k of ["field_id", "expected", "observed"]) if (res[k] !== undefined) d[k] = res[k];
    return Object.keys(d).length ? d : undefined;
  }

  function stopApp(run, app, code, reason, extra) {
    app.stage = "stopped";
    app.stop = Object.assign({ code, reason }, extra || {});
    event(run, "stopped", { postingKey: app.postingKey, code });
  }

  // SUBMIT-STEER-1130 (answer capture): the question descriptors an
  // UNCOVERED_QUESTION stop is waiting on — built from the drive's
  // own asks and the board's own form definition (the standard field
  // set when the board does not expose one). A descriptor exists only
  // for a REQUIRED field the person answers in words (screening /
  // question kinds): files, cover-note drafts and attestations are
  // never chat questions (an attestation is never taken from chat
  // text at all). Scope: a field of the standard form is answered
  // once, on the profile; a field only this posting's form carries
  // belongs to this application alone.
  function stopQuestions(res, board) {
    const Portal = getPortal();
    const standard = (Portal && Portal.SANDBOX_FIELDS) || [];
    const stdIds = new Set(standard.map((f) => f.field_id));
    const defs = new Map();
    for (const f of standard) if (f && f.field_id) defs.set(f.field_id, f);
    try {
      const form = board && typeof board.form === "function" ? board.form() : null;
      for (const f of (form && form.fields) || []) if (f && f.field_id) defs.set(f.field_id, f);
    } catch { /* the standard set + the form analysis still name the standard questions */ }
    const analysis = new Map(((res && res.formAnalysis) || []).map((f) => [f.field_id, f]));
    const out = [];
    const seen = new Set();
    for (const ask of (res && res.asks) || []) {
      if (!ask || !ask.field_id || seen.has(ask.field_id)) continue;
      const def = defs.get(ask.field_id) || null;
      const an = analysis.get(ask.field_id) || null;
      const kind = (def && def.kind) || (an && an.category) || null;
      const required = def ? !!def.required : !!(an && an.required);
      if (!required || (kind !== "screening" && kind !== "question")) continue;
      seen.add(ask.field_id);
      out.push({
        field_id: ask.field_id,
        question_key: (def && def.question_key) || ask.field_id,
        label: (def && def.label) || (an && an.label) || ask.field_id,
        kind,
        scope: stdIds.has(ask.field_id) ? "profile" : "posting",
      });
    }
    return out;
  }

  // The run's open chat questions, in the order they are asked: the
  // first stopped application (in selection order) and its first
  // unanswered question is the pending one; the rest queue behind it.
  function openQuestions(run) {
    const out = [];
    for (const key of (run && run.selected) || []) {
      const app = run.apps && run.apps[key];
      if (!app || !app.stop || app.stop.code !== "UNCOVERED_QUESTION" || !Array.isArray(app.stop.questions)) continue;
      for (const q of app.stop.questions) out.push({ postingKey: key, company: app.company || null, role: app.role || null, question: q });
    }
    return out;
  }
  function firstOpenQuestion(run) { const all = openQuestions(run); return all.length ? all[0] : null; }

  function cardSha(run) {
    const pairs = run.selected
      .map((k) => run.apps[k])
      .filter((a) => a && a.stage === "doorstep")
      .map((a) => `${a.postingKey}:${a.payloadSha256}`)
      .sort();
    return pairs.length ? sha256(pairs.join("|")) : null;
  }

  // Canonical digest of the answer-bearing profile: recursively
  // key-sorted JSON, hashed. Both sides of an approval compute it
  // the same way — prepareRun stores it on the run; the router
  // recomputes it over the CURRENT profile at the approval turn
  // and hands it to approveRun inside the approval object.
  function profileDigestOf(profile) {
    const canon = (v) => {
      if (Array.isArray(v)) return v.map(canon);
      if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; }
      return v;
    };
    return sha256(JSON.stringify(canon(profile || {})));
  }

  // ---------------- J3: one yes -> per-application hash-bound approvals ----
  function approveRun(run, approval) {
    if (!run || run.status !== "awaiting_approval") {
      return { ok: false, code: "NO_RUN_AWAITING_APPROVAL", reason: "there is no prepared batch waiting for a yes" };
    }
    if (!approval || approval.approvedByUser !== true) {
      return { ok: false, code: "APPROVAL_REQUIRED", reason: "the batch stops at the card until the owner says yes" };
    }
    // ACCOUNT BINDING (2026-10-24): the run stores its owner at
    // creation (createRun's run.userId, from the creating ctx).
    // An approval arriving as a DIFFERENT account does not bind —
    // checked before the set hash, the expiry and the digest are
    // consulted, because a digest binds a profile, never an
    // identity: two accounts can hold identical profiles, and
    // only the owner comparison separates them.
    // FAIL CLOSED on a MISSING owner (coordinator, 2026-10-24):
    // the comparison above only refused when BOTH sides named an
    // owner — a run or an approval carrying no userId bound
    // anyway, the same hole shape as the absent expiry/digest.
    // No owner on either side = not bindable, same re-review line.
    if (!run.userId || !approval.userId) {
      return { ok: false, code: "APPROVAL_REVIEW_NEEDED", reason: "re-review needed: I will re-prepare and show a fresh card — this card or this approval names no owning account, and a yes can only land on a card bound to the account approving it" };
    }
    if (approval.userId !== run.userId) {
      return { ok: false, code: "APPROVAL_ACCOUNT_MISMATCH", reason: "this batch was prepared for a different account than the one approving — a card can only be approved by the account it was prepared for. Nothing was submitted; ask me to prepare the batch on this account and approve that card instead" };
    }
    const nowSha = cardSha(run);
    if (!nowSha || nowSha !== run.cardSha256) {
      return { ok: false, code: "APPROVAL_SET_CHANGED", reason: "the doorstep set or a payload changed since the card was shown — the batch must be re-prepared and re-approved, never silently re-pointed" };
    }
    // FAIL CLOSED (2026-10-24): the two checks below are only as
    // strong as their inputs. A run that does not CARRY the fields
    // (prepared before they existed — legacy runs exist) or an
    // approval that does not SUPPLY them is not a card a yes can
    // land on: absent or unparseable expiry/digest refuses here,
    // never skips. The refusal's first move is always the same:
    // re-review needed: I will re-prepare and show a fresh card.
    if (!Number.isFinite(run.cardExpiresAt) || typeof approval.now !== "number" || !Number.isFinite(approval.now) || !run.profileSha256 || !approval.profileSha256) {
      return { ok: false, code: "APPROVAL_REVIEW_NEEDED", reason: "re-review needed: I will re-prepare and show a fresh card — this card does not carry the verifiable expiry and profile binding an approval must land on, so no approval can bind to it" };
    }
    // EXPIRY (2026-10-24): a yes that arrives after the card's
    // window does not bind. The window rides the run
    // (cardExpiresAt, set at prepare from the session-reuse TTL);
    // presence is guaranteed by the fail-closed check above.
    if (typeof approval.now === "number" && run.cardExpiresAt && approval.now >= run.cardExpiresAt) {
      return { ok: false, code: "APPROVAL_CARD_EXPIRED", reason: "this review card has expired — prepared applications are held only for a short window, so a yes can't land on forms prepared earlier. The batch must be re-prepared, and the new card is the one a yes can bind to" };
    }
    // PROFILE CHANGE (2026-10-24): the card's answers were built
    // from the profile as it stood at prepare; if the profile has
    // changed since — an edited answer, a corrected fact — the yes
    // was given against answers that no longer stand, and it does
    // not bind. Presence on both sides is guaranteed by the
    // fail-closed check above; this is the value comparison.
    if (run.profileSha256 && approval.profileSha256 && approval.profileSha256 !== run.profileSha256) {
      return { ok: false, code: "APPROVAL_PROFILE_CHANGED", reason: "your profile changed since this card was prepared, so its answers were built from facts that no longer stand — the batch must be re-prepared from your current profile and re-approved" };
    }
    // P1 text yes ("yes but not 2"): the owner may leave applications
    // OFF the card he was shown — never add one. Every excluded key must
    // be a doorstep application of THIS card, and at least one must
    // remain; anything else refuses before a single approval is minted.
    const doorKeys = run.selected.filter((k) => run.apps[k] && run.apps[k].stage === "doorstep");
    const exclude = approval.exclude == null ? [] : approval.exclude;
    if (!Array.isArray(exclude) || exclude.some((k) => typeof k !== "string" || !doorKeys.includes(k)) || new Set(exclude).size !== exclude.length) {
      return { ok: false, code: "APPROVAL_EXCLUDE_INVALID", reason: "an excluded application is not on the card that was approved — nothing was approved" };
    }
    if (exclude.length >= doorKeys.length) {
      return { ok: false, code: "APPROVAL_EXCLUDE_ALL", reason: "every application on the card was left out — there is nothing to approve" };
    }
    run.approvals = {};
    for (const key of doorKeys) {
      if (exclude.includes(key)) continue;
      run.approvals[key] = run.apps[key].payloadSha256;
    }
    // THE APPROVALREF (Leg 1): minted here, at the batch card's one
    // yes, and bound to the card set hash that was just re-verified —
    // the ref names THIS run's approval of THIS doorstep set. 149's
    // arming wire (BUG-063/D3) arms a real board only with a non-empty
    // approvalRef on top of approvedByUser; without one a browser
    // board's submit() throws REAL_SUBMIT_DISABLED. Deterministic in
    // (run.id, cardSha256): re-approving the identical set re-mints
    // the identical ref, and a changed set can never reuse it (the
    // set-hash check above refuses first).
    // A partial yes names what it left out inside the ref, so a ref for
    // "all of the card" and one for "the card minus 2" never coincide.
    run.approvalRef = `batch:${run.id}:${nowSha}` + (exclude.length ? `:x-${sha256(exclude.slice().sort().join("|")).slice(0, 16)}` : "");
    // WO-094: the card's yes IS the attestation act — recorded per
    // application, bound to that application's approved payload hash
    // (which already covers the certification text). Never standing.
    run.attestations = {};
    for (const key of Object.keys(run.approvals)) {
      const app = run.apps[key];
      if (!app || !Array.isArray(app.attestations) || !app.attestations.length) continue;
      run.attestations[key] = {};
      for (const a of app.attestations) {
        run.attestations[key][a.field_id] = { explicit: true, value: a.value, text: a.text, payloadSha256: run.approvals[key], approvalRef: run.approvalRef };
      }
    }
    run.status = "approved";
    // Each approval is on the run record, one event per application,
    // bound to the exact payload hash it approves; each exclusion is
    // named the same way (the app is marked so it is never driven).
    for (const key of Object.keys(run.approvals)) event(run, "app_approved", { postingKey: key, payloadSha256: run.approvals[key] });
    for (const key of exclude) {
      const app = run.apps[key];
      app.stage = "excluded_by_user";
      event(run, "app_excluded", { postingKey: key });
    }
    event(run, "approved", { count: Object.keys(run.approvals).length, approvalRef: run.approvalRef, ...(exclude.length ? { excluded: exclude.length } : {}) });
    return { ok: true, approved: Object.keys(run.approvals).length, approvalRef: run.approvalRef };
  }

  // ---------------- J4: the execution loop ----------------
  function executeRun(run, deps) {
    const d = deps || {};
    const Portal = getPortal();
    const log = d.log || { records: [] };
    const now = d.now != null ? d.now : Date.now();
    const rt = runtimeFor(run);
    if (run.status !== "approved") {
      return { ok: false, code: "RUN_NOT_APPROVED", reason: "execution requires an approved batch" };
    }
    for (const key of run.selected) {
      const app = run.apps[key];
      const approvedSha = run.approvals[key];
      if (!app || !approvedSha) continue;
      const posting = run.postings[key];
      let session = rt.sessions[key];
      try {
        if (!session) {
          // F-031: resume the prepare session first — one drive per
          // application. A resume that cannot carry the approval falls
          // back below, named; a non-fallback stop is the app's result.
          const profile = rt.profiles[key] || profileFor(d, posting);
          const resumed = tryResume(run, app, d, posting, approvedSha, { Portal, log, now, profile });
          if (resumed === false) continue;
          if (resumed) { session = resumed; rt.sessions[key] = session; }
        }
        if (!session) {
          // Cross-invocation rebuild: a fresh session re-prepares the
          // doorstep; 149's click-time hash verification is the guard
          // that a changed payload stops (APPROVAL_PAYLOAD_MISMATCH).
          // F-035: a coded worker refusal is named, not flattened to BOARD_NOT_WIRED.
          const board = boardOrStop(run, app, d, posting);
          if (!board) continue;
          session = Portal.createPortalSession({ userId: run.userId, board });
          rt.sessions[key] = session;
          const profile = rt.profiles[key] || profileFor(d, posting);
          const prep = Portal.runApply(session, { posting, profile, log, userId: run.userId, now, attestations: {}, cardApproval: true });
          if (!prep || prep.resultStatus !== "prepared") { absorbPrepareResult(run, app, prep); continue; }
        }
        // The approval carries the batch approvalRef minted at the
        // card's yes (Leg 1): 149 reads approval.approvalRef (or
        // ctx.approvalRef) at its arming wire — a real board arms
        // only under it. A run approved in the pre-fix shape (hashes
        // only, approvalRef null) still stops at the board, named.
        const attestations = (run.attestations && run.attestations[key]) || {};
        const out = Portal.submitDoorstep(session, { approvedByUser: true, payloadSha256: approvedSha, approvalRef: run.approvalRef || null, attestations }, { log, now, posting, approvalRef: run.approvalRef || null });
        absorbSubmitResult(run, app, out, d);
      } catch (err) {
        stopApp(run, app, "EXECUTION_ERROR", `the drive threw: ${err && err.message ? err.message.slice(0, 160) : "unknown error"}`);
      }
    }
    const anyStopped = run.selected.some((k) => ["stopped", "captcha_handoff", "deferred_refusal"].includes(run.apps[k].stage));
    run.status = anyStopped ? "completed_with_stops" : "completed";
    run.summary = summarizeRun(run);
    event(run, "executed", { status: run.status });
    return { ok: true, summary: run.summary };
  }

  function absorbSubmitResult(run, app, out, d) {
    if (out && out.resultStatus === "completed" && out.submission) {
      app.stage = "submitted";
      app.confirmationId = out.submission.confirmationId || null;
      event(run, "submitted", { postingKey: app.postingKey, confirmationId: app.confirmationId });
      if (typeof d.track === "function") {
        try { d.track({ postingKey: app.postingKey, company: app.company, role: app.role, confirmationId: app.confirmationId, status: "submitted" }); } catch { /* the submission stands; tracking is the caller's record */ }
      }
      return;
    }
    if (out && out.resultStatus === "blocked" && out.code === "PORTAL_REFUSING") {
      app.stage = "deferred_refusal";
      run.deferred.push({ postingKey: app.postingKey, company: app.company, role: app.role, code: "PORTAL_REFUSING", reason: out.reason || "the employer's site was turning requests away at click time", resumeOn: out.until || null });
      event(run, "deferred_refusal", { postingKey: app.postingKey, at: "click", until: out.until || null });
      return;
    }
    if (out && out.resultStatus === "blocked" && out.code === "CAPTCHA_HANDOFF") {
      app.stage = "captcha_handoff";
      app.stop = { code: "CAPTCHA_HANDOFF", reason: out.reason || "a captcha appeared at submit — the user finishes the last step", handoffUrl: out.handoffUrl || app.url };
      event(run, "captcha_handoff", { postingKey: app.postingKey, at: "submit" });
      return;
    }
    if (out && out.resultStatus === "blocked") {
      stopApp(run, app, out.code || "SUBMIT_BLOCKED", out.reason || "the submit gate stopped this application", stopDetailOf(out));
      return;
    }
    stopApp(run, app, "UNKNOWN_OUTCOME", "the submit returned no readable end state — it is recorded unknown, never retried blind (MI-115's resolver owns it from here)");
  }

  // ---------------- J5: the report ----------------
  // Coverage fraction + drop reasons (P2, 2026-10-22): every selected
  // application is accounted for exactly once — through (ready for the
  // yes, or submitted once the yes was given) or not, with its code and
  // reason. Before the yes, "through" is the doorstep; after it, a
  // submission. Never reduced: 0/0 when nothing was selected.
  const PENDING_REASONS = {
    selected: { code: "NOT_PREPARED", reason: "selected, but the drive to the final review has not run yet" },
    doorstep: { code: "NOT_SUBMITTED", reason: "it reached the final review, but it was not in the approved set, so it was not submitted" },
  };
  function accountRun(run) {
    const afterYes = !!run.approvalRef;
    const capByKey = {};
    for (const x of run.deferred || []) if (x && x.code === "PORTAL_REFUSING") capByKey[x.postingKey] = x;
    const outcomes = [];
    let through = 0;
    for (const key of run.selected || []) {
      const a = (run.apps || {})[key] || { postingKey: key, stage: "missing" };
      const o = { postingKey: key, company: a.company || null, role: a.role || null, stage: a.stage, through: false, code: null, reason: null };
      if (a.coverage) o.fields = { filled: a.coverage.filled, total: a.coverage.total };
      if (a.stage === "submitted" || (!afterYes && a.stage === "doorstep")) { o.through = true; through += 1; }
      else if ((a.stage === "stopped" || a.stage === "captcha_handoff") && a.stop) { o.code = a.stop.code; o.reason = a.stop.reason; }
      else if (a.stage === "deferred_refusal") {
        const c = capByKey[key];
        o.code = "PORTAL_REFUSING";
        o.reason = `${(c && c.reason) || "the employer's site is turning requests away right now"} — it resumes ${(c && c.resumeOn) ? `at ${c.resumeOn}` : "when the site allows"}`;
      } else if (PENDING_REASONS[a.stage]) { o.code = PENDING_REASONS[a.stage].code; o.reason = PENDING_REASONS[a.stage].reason; }
      else { o.code = "NO_RECORD"; o.reason = "the run holds no application record for this selection"; }
      outcomes.push(o);
    }
    return { total: outcomes.length, through, phase: afterYes ? "submitted" : "ready", outcomes };
  }

  // The exactly-once invariant over a summary's outcome groups: every
  // selected key appears in exactly one of ready / submitted / stops /
  // cap deferrals / pending, and no group names a key outside the
  // selection. Returns the breakage; assertAccounted throws on it.
  function checkAccounted(run, summary) {
    const sm = summary || run.summary || summarizeRun(run);
    const seen = new Map();
    const note = (k) => seen.set(k, (seen.get(k) || 0) + 1);
    for (const x of sm.ready || []) note(x.postingKey);
    for (const x of sm.confirmations || []) note(x.postingKey);
    for (const x of sm.sentUnconfirmed || []) note(x.postingKey);
    for (const x of sm.stops || []) note(x.postingKey);
    for (const x of sm.deferred || []) if (x.code !== "COUNT_DEFERRED") note(x.postingKey);
    for (const x of sm.pending || []) note(x.postingKey);
    const selected = new Set(run.selected || []);
    const missing = [...selected].filter((k) => !seen.has(k));
    const duplicated = [...seen].filter(([k, n]) => selected.has(k) && n > 1).map(([k]) => k);
    const unknown = [...seen.keys()].filter((k) => !selected.has(k));
    return { ok: !missing.length && !duplicated.length && !unknown.length, missing, duplicated, unknown };
  }
  function assertAccounted(run, summary) {
    const r = checkAccounted(run, summary);
    if (!r.ok) {
      const e = new Error(`batch run ${run && run.id} does not account for every selected application exactly once — missing: [${r.missing.join(", ")}], duplicated: [${r.duplicated.join(", ")}], not selected: [${r.unknown.join(", ")}]`);
      e.code = "ACCOUNTING_BROKEN"; e.detail = r;
      throw e;
    }
    return r;
  }

  function summarizeRun(run) {
    const apps = run.selected.map((k) => run.apps[k]).filter(Boolean);
    const submitted = apps.filter((a) => a.stage === "submitted");
    const stops = [];
    for (const a of apps) {
      if (a.stage === "stopped" && a.stop) stops.push(Object.assign({ postingKey: a.postingKey, company: a.company, role: a.role, code: a.stop.code, reason: a.stop.reason }, a.stop.field_id !== undefined ? { field_id: a.stop.field_id } : {}));
      if (a.stage === "captcha_handoff") stops.push({ postingKey: a.postingKey, company: a.company, role: a.role, code: "CAPTCHA_HANDOFF", reason: a.stop ? a.stop.reason : "a captcha appeared", handoffUrl: a.stop ? a.stop.handoffUrl : a.url });
    }
    return {
      runId: run.id, familyText: run.familyText, requested: run.requested, status: run.status,
      approvalRef: run.approvalRef || null,
      found: run.found, duplicatesRemoved: run.duplicatesRemoved,
      screenedOut: run.screenedOut.slice(),
      eligible: run.eligible, selected: run.selected.length,
      doorstep: apps.filter((a) => a.stage === "doorstep").length,
      submitted: submitted.length,
      // SPLIT-1146 (d): the confirmations list holds only RECORDED
      // employer confirmations. A submission the board accepted with
      // no confirmation id is a separate group — sent, unconfirmed —
      // never an entry here with a null id.
      confirmations: submitted.filter((a) => a.confirmationId).map((a) => ({ postingKey: a.postingKey, company: a.company, role: a.role, confirmationId: a.confirmationId })),
      sentUnconfirmed: submitted.filter((a) => !a.confirmationId).map((a) => ({ postingKey: a.postingKey, company: a.company, role: a.role })),
      stops,
      deferred: run.deferred.slice(),
      ready: apps.filter((a) => a.stage === "doorstep").map((a) => ({ postingKey: a.postingKey, company: a.company, role: a.role })),
      pending: apps.filter((a) => a.stage === "selected").map((a) => ({ postingKey: a.postingKey, company: a.company, role: a.role, code: "NOT_PREPARED" })),
      accounting: accountRun(run),
    };
  }

  // Launch readiness Q3 (2026-10-26): a stop reaches the person in plain
  // words; its code stays on the record (app.stop.code, the summary's
  // stops), never in the reply. A code with no sentence here says only
  // what is always true of a stop.
  const STOP_WORDS = {
    BOARD_NOT_WIRED: "Trainee can't reach this employer's application site from here, so nothing was filled or sent",
    UNCOVERED_QUESTION: "a required question has no confirmed fact on your profile, so I stopped instead of inventing an answer",
    CAPTCHA_HANDOFF: "a captcha appeared, so the last step is yours",
    EXECUTION_ERROR: "it stopped with an error, so it is not counted as submitted",
    DRIVER_ERROR: "it stopped with an error before it was submitted",
    NO_RESULT: "the employer's site gave no result, so it is not counted as submitted",
    UNKNOWN_OUTCOME: "the submit gave no readable result, so it is recorded as unknown and will not be sent again on its own",
    NOT_PREPARED: "it is selected but not prepared yet",
    NOT_SUBMITTED: "it reached the final review but was not in what you approved, so it was not sent",
    PORTAL_REFUSING: "the employer's site was turning requests away for a while, so it waits until the site allows and then goes on its own; nothing was sent",
    COUNT_DEFERRED: "it is beyond the number you asked for, so it stays in the queue",
    KNOCKOUT_UNMET: "it has a requirement you don't meet",
    JOB_CLOSED: "the posting is closed",
  };
  function plainStop(code) {
    return STOP_WORDS[code] || "it was stopped, so it is not counted as submitted";
  }
  // "Found 1 role", "Found 3 data analyst roles": the family is a noun
  // phrase that may already end in role(s).
  function rolesPhrase(n, familyText) {
    const fam = String(familyText || "").replace(/\s*\broles?$/i, "").trim();
    return `${n} ${fam ? `${fam} ` : ""}${n === 1 ? "role" : "roles"}`;
  }

  // The first line of every batch reply: the fraction that came
  // through, then each one that did not, named once in plain words.
  function coverageLines(run) {
    const acc = accountRun(run);
    const verb = acc.phase === "submitted" ? "submitted" : "ready for your yes";
    const lines = [`${acc.through}/${acc.total} applications ${verb}.`];
    // SPLIT-1146 (d): after the yes, a selected application whose
    // stage is "submitted" but which carries NO recorded employer
    // confirmation is not counted as submitted in the headline —
    // the headline counts only confirmed submissions, and each
    // unconfirmed one is named with its own code and reason.
    if (acc.phase === "submitted") {
      const selApps = (run.selected || []).map((k) => (run.apps || {})[k]).filter(Boolean);
      const unconfirmed = selApps.filter((a) => a.stage === "submitted" && !a.confirmationId);
      if (unconfirmed.length) {
        const confirmed = selApps.filter((a) => a.stage === "submitted" && a.confirmationId).length;
        lines[0] = `${confirmed}/${acc.total} applications submitted with employer confirmations.`;
        for (const a of unconfirmed) lines.push(`- ${a.company || "a company"} — ${a.role || "a role"}: the employer's system took the application but recorded no confirmation, so it is not counted as submitted.`);
      }
    }
    for (const o of acc.outcomes) {
      if (o.through) continue;
      lines.push(`- ${o.company || "a company"} — ${o.role || "a role"}: ${plainStop(o.code)}.`);
    }
    return lines;
  }

  function speakSummary(run) {
    const sm = run.summary || summarizeRun(run);
    const lines = coverageLines(run);
    lines.push(`Found ${rolesPhrase(sm.found, run.familyText)}${sm.duplicatesRemoved ? ` — ${sm.duplicatesRemoved} duplicate${sm.duplicatesRemoved === 1 ? "" : "s"} removed` : ""}.`);
    if (sm.screenedOut.length) lines.push(`Screened out ${sm.screenedOut.length}: ${sm.screenedOut.map((x) => `${x.company || "a posting"} (${x.code === "KNOCKOUT_UNMET" ? "knockout requirement you don't meet" : x.code === "JOB_CLOSED" ? "posting closed" : plainStop(x.code)})`).join("; ")}.`);
    lines.push(`${sm.eligible} ${sm.eligible === 1 ? "was" : "were"} eligible; I took the ${sm.selected} you named.`);
    // MUSE-F-001 (ported from the loop-writer package, muse/2026-10-20-loop-writer): the selection by name — company,
    // role, the posting's own link and where each one stands — from the run's own application records, never re-derived.
    const selApps = (run.selected || []).map((k) => run.apps[k]).filter(Boolean);
    if (selApps.length) {
      lines.push(`The ${selApps.length} selected:`);
      for (const a of selApps) {
        const stage = a.stage === "doorstep" ? "ready at the final review screen"
          : a.stage === "submitted" ? (a.confirmationId ? `submitted — confirmation ${a.confirmationId}` : "sent — no confirmation from the employer is recorded, so this is not counted as submitted")
          : a.stage === "captcha_handoff" ? "a captcha appeared — the last step is yours"
          : a.stage === "stopped" ? "stopped (named below)"
          : a.stage === "deferred_refusal" ? "waiting for the employer's site to allow it"
          : a.stage === "selected" ? "selected, not prepared yet"
          : a.stage === "excluded_by_user" ? "left out by your yes — not sent"
          : a.stage;
        lines.push(`- ${a.company || "a company"} — ${a.role || "a role"}${a.url ? ` — ${a.url}` : ""} (${stage})`);
      }
    }
    if (sm.status === "awaiting_approval" || run.status === "awaiting_approval") {
      lines.push(`${sm.doorstep} are tailored and sitting at the final review screen — the card shows each one with the exact answers it will send. Nothing submits until your yes.`);
      // WO-094: the certification each form asks for is signed by this yes,
      // per application — its own words are shown, never paraphrased.
      const certs = (run.card && Array.isArray(run.card.certifications)) ? run.card.certifications : [];
      if (certs.length) {
        const texts = Array.from(new Set(certs.map((c) => c.text)));
        lines.push(`Your yes also gives each of these applications its own certification, for that application only: ${texts.map((t) => `"${t}"`).join("; ")}.`);
      }
    }
    if (sm.confirmations.length) lines.push(`Submitted ${sm.confirmations.length} with employer confirmations: ${sm.confirmations.map((c) => `${c.company} (${c.confirmationId})`).join("; ")}.`);
    for (const st of sm.stops) lines.push(`Stopped — ${st.company || "a role"}: ${st.code === "UNCOVERED_QUESTION" ? "a required question has no confirmed fact on your profile, so I stopped instead of inventing an answer" : st.code === "CAPTCHA_HANDOFF" ? `a captcha appeared; the last step is yours here: ${st.handoffUrl || ""}` : `${plainStop(st.code)}.`}`);
    const capDef = sm.deferred.filter((x) => x.code === "PORTAL_REFUSING");
    const countDef = sm.deferred.filter((x) => x.code === "COUNT_DEFERRED");
    if (capDef.length) lines.push(`${capDef.length} wait because the employer's site was turning requests away for a while; they resume ${capDef[0].resumeOn ? `at ${capDef[0].resumeOn}` : "when it allows"} on their own, and nothing of them was sent.`);
    if (countDef.length) lines.push(`${countDef.length} more were eligible beyond the ${run.requested} you named; they stay in the queue.`);
    return lines;
  }

  // The serializable run is the whole run object by construction;
  // this exists so callers never reach for runtime state by accident.
  function serializeRun(run) { return JSON.parse(JSON.stringify(run)); }
  function restoreRun(json) { return json && json.id ? json : null; }

  return { parseApplyAsk, createRun, prepareRun, approveRun, executeRun, summarizeRun, speakSummary, coverageLines, accountRun, checkAccounted, assertAccounted, serializeRun, restoreRun, postingKeyOf, profileDigestOf, openQuestions, firstOpenQuestion, SESSION_REUSE_TTL_MS, RESUME_FALLBACK_CODES, _runtime: RUNTIME };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CareerBatchApply;
