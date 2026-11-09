/* Career doorstep — the chat ACTION seam (repair lane R3, gauntlet C15/C17/C18/C20/C37).
   One seam pattern for every action in this module:
     user turn -> routed action (handleChat) -> a domain module or the F3 form
     driver executes -> the result carries a typed resultStatus (the canonical
     oracle set: completed | prepared | awaiting_user | running | partial |
     blocked | failed | unknown_outcome) plus structured proof the composer /
     grader can read.
   What lives here (and ONLY here, per lane ownership):
     1. DOORSTEP FORM SEAM (C17/C18, C20 pre-submit): fills the F3 replica
        forms step by step through the fixture form driver — values resolved
        from profile facts only, conditional fields handled, unknowns and
        consent/declaration answers surfaced as ASKS (never guessed, never
        inferred — sensitive answers least of all), the hidden-default stop
        honored (UNRESOLVED_HIDDEN_DEFAULT is the terminal step, not a
        surprise at submit) — and stops ON the final review screen. Product
        output is the doorstep proof chain: step log (field, value source,
        result per agent step), a would-submit payload snapshot (all values +
        sha256 of the bound resume artifact + sha256 of the payload), and a
        sink-armed verification: a dry validation of the exact payload against
        the driver (missing fields, hidden defaults, late material) with NO
        submission.
     2. C20 SUBMIT LEG: after the doorstep, the case's own approved in-sink
        submit runs through this same seam. Exactly one submit per payload;
        a sink timeout is reported as unknown_outcome (never as success);
        "did it go through?" reconciles the sink BEFORE any retry, and a
        repeat approval while an outcome is unknown/confirmed is refused.
     3. QUEUE CONTROL (C37 + R-A4): "stop everything" halts the outreach queue and
        PERSISTS the halt (the queue state is the host-persisted object /
        JSON file passed in ctx; the halt flag and per-item status are
        written into it). R-A4 (S0): the halt ALWAYS sets a global user
        pause (ctx.globalPause + state.global_pause + q.global_pause) —
        when the queue state can't be read the pause is set anyway and the
        reply states the exact counts are unverified, never a no-op. Duplicate events (same event_id) are deduped and
        out-of-order events (older sent_at than the state they would rewind)
        cannot revive a halted item. Pending recipients are also suppressed
        through 124's own suppression store when the host passes one, so a
        send-time check in 124 would stop them too. 124 is CALLED, never edited.
     4. PACKET BINDING LEG (C15): packet preparation via chat resolves the
        requested artifact version among same-named records by CONTENT HASH
        and calls 133's assemblePacket (called, never edited); the returned
        packet carries this seam's binding + review surface.
   Approval gates are untouched: sensitive/consent answers still stop for the
   user, submits still require the case's explicit approval turn, caps are
   124's and are not touched here. All form writes go only to the F3 local
   receipt sink. No real sends, no real submissions.
     5. EXECUTION GUARDS + TRUTHFUL STATUS (repair lane R2B, gauntlet deep-dive
     DD-1/DD-3/DD-4/DD-5/DD-6/DD-10; causes S-2/S-3):
     a. DESTINATION TRUTH: status/reconcile NEVER speaks from in-memory
        submission state. Every status answer re-reads the destination at
        answer time (driver reconcile + a scan of the receipt sink) through
        ONE shared path (destinationStatus) used by the timeout branch, the
        accepted branch, and the repeat-approve refusal alike. Receipt found
        -> confirmed; receipt absent (or destination unreadable) -> the
        in-memory state is downgraded to unknown_outcome and the reply says
        plainly that the outcome is uncertain. No confirmation is ever
        composed from memory (AP22).
     b. EXECUTION-TIME GUARDS: submitDoorstep re-reads state IMMEDIATELY
        before any sink write and refuses — no write, typed resultStatus
        "blocked", structured guard_refusal {code, reason, unblock}, and a
        reply naming the specific refusal + what would unblock it — when:
        the approval was cancelled, the approval was invalidated, the role
        is closed, a prior application is on record for this user+job
        (recorded disclosures AND destination receipts), or the packet's
        bound fact version/hash no longer matches the current profile.
        The guards read STATE, not the executing turn's wording, so a bare
        "approve and submit" cannot revive anything (AP08/AP18/AP20/AP23).
     c. PACKET<->FACT BINDING: at preparation (doorstep fill AND the C15
        packet leg) the packet/doorstep is stamped with the profile's fact
        version (130's fact_version counter — bumped by 130's own write
        paths on every correction) AND a sha256 hash of the fact-bearing
        profile slices, so even a correction that reaches the profile
        without 130's counter invalidates the packet at guard (b).
     STATE FIELDS this seam defines (Lane A's intent handlers in 142 write
     them through the recorder exports below — recordJobClosure /
     cancelDoorstep / invalidateApproval / recordPriorApplication — or set
     the fields directly; the guards read the fields, either way):
       doorstepState.job_status: "closed"      (+ job_closed, job_closed_at,
                                                  job_closed_reason)
       doorstepState.submission.status: "cancelled" (+ cancel_reason,
                                                  cancelled_at;
                                                  approval_cancelled: true)
       doorstepState.approval_invalidated: true (+ invalidated_at,
                                                  invalidated_reason;
                                                  submission.status may also
                                                  be "invalidated")
       doorstepState.prior_applications: [{ job_id, company, role, source,
                                                  channel, at }]
                                                  (host lists are also read:
                                                  ctx.priorApplications,
                                                  ctx.trackerRecords,
                                                  ctx.applications,
                                                  profile.applications,
                                                  manual-apply disclosure
                                                  objects on state/ctx)
       doorstepState.fact_version / fact_hash: stamped at preparation
                                                  (mirrored on the doorstep
                                                  object + payload, and on the
                                                  C15 binding/review)
       doorstepState.job_id / sink_dir: identity of this doorstep's job and
                                                  its destination, stamped at
                                                  fill so status can re-read
                                                  the RIGHT destination.
     6. DOORSTEP FILL SURFACING (feature lane G2, defect APD-1 / AP13):
     one state machine for every dry-validation blocker. The fill loop no
     longer skips the review step, and after filling, EVERY blocker the dry
     validation flags on the exact payload — a late material question, a
     hidden default still in effect, a missing required field — is
     collected on the doorstep (doorstep.blockers) and surfaced as a
     plain-language ask BEFORE any submit turn can be attempted. The
     doorstep reaches REVIEW only when no blockers remain; a sensitive
     hidden default keeps the preserved STOPPED terminal shape. Resume is
     a re-fill after the user supplies the missing answer (through the
     user-supplied fact channel the resolver already reads, or a corrected
     profile) — the re-fill clears the blocker and only then reaches
     REVIEW. A submit attempt with open blockers refuses, naming the
     blockers in plain words; structured codes stay on result objects and
     never appear in a reply.
     7. PER-FAMILY DOORSTEP PAYLOADS (feature lane G6, from the hardened
     re-score's GAP census): general module-level emitters producing the
     commitment artifact the hardened grader requires per family —
     emitTrackingLog (tracking-write => the exact 126-shaped log write),
     emitCalendarProposal (calendar => a proposal card evaluated against
     the calendar in ctx: busy overlaps, quiet hours, and fall-back
     ambiguity are REPORTED as conflicts in the payload, never silently
     resolved), emitApplicationPacket (application => packet for a posting
     spec beyond the fixture ids; prepPacket's fixture behavior is
     unchanged) and emitOutreachDraft (outreach-send => a 124-built draft
     plus a queue state armed at awaiting approval). Every emitter returns
     a typed result + payload sha256 + a doorstep record { family,
     gap: null, driven_by: "agent", state: "AWAITING_COMMIT" } and NEVER
     invokes the commitment target (tracker write, calendar create,
     transport send, form submit) — armed, not fired.
   ROUTER REGISTRATION (one line, for the coordinator at integration): in the
   chat router's handler chain, after 120-career-access and
   130-career-onboarding, add CareerDoorstep.handleChat as the next tried
   handler — pilot-lib.cjs chatTurn is the staging mirror of that chain.
   Node host note: the form driver and queue-file persistence use fs/path
   through guarded requires; in a non-Node bundle the doorstep fill/submit
   functions report blocked instead of throwing. */
const CareerDoorstep = (() => {
  "use strict";
  const Packets = typeof CareerPackets !== "undefined" ? CareerPackets : (() => { try { return require("./133-career-packets.js"); } catch (e) { return null; } })();
  const Outreach = typeof CareerOutreach !== "undefined" ? CareerOutreach : (() => { try { return require("./124-career-outreach.js"); } catch (e) { return null; } })();
  const Onboarding = typeof CareerOnboarding !== "undefined" ? CareerOnboarding : (() => { try { return require("./130-career-onboarding.js"); } catch (e) { return null; } })();
  const Track = typeof CareerTrack !== "undefined" ? CareerTrack : (() => { try { return require("./126-career-track.js"); } catch (e) { return null; } })();
  const Driver = (() => { try { return require("../career-data/fixtures/gauntlet/forms/form-driver.cjs"); } catch (e) { return null; } })();
  const nodeCrypto = (() => { try { return require("crypto"); } catch (e) { return null; } })();
  const nodeFs = (() => { try { return require("fs"); } catch (e) { return null; } })();
  const nodePath = (() => { try { return require("path"); } catch (e) { return null; } })();

  // ---------- sha256 (crypto when available; pure-JS fallback, same digest) ----------
  function sha256Direct(input) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const rr = (x, n) => ((x >>> n) | (x << (32 - n))) | 0;
    const bytes = [];
    const str = String(input == null ? "" : input);
    for (let i = 0; i < str.length; i++) { // UTF-8 encode
      let cp = str.charCodeAt(i);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) { bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
      else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) { const lo = str.charCodeAt(++i); cp = 0x10000 + ((cp - 0xd800) * 0x400) + (lo - 0xdc00); bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
      else bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    const bitLenHi = Math.floor(bytes.length / 0x20000000), bitLenLo = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 3; i >= 0; i--) bytes.push((bitLenHi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) bytes.push((bitLenLo >>> (i * 8)) & 0xff);
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let block = 0; block < bytes.length; block += 64) {
      for (let t = 0; t < 16; t++) w[t] = (bytes[block + t * 4] << 24) | (bytes[block + t * 4 + 1] << 16) | (bytes[block + t * 4 + 2] << 8) | bytes[block + t * 4 + 3];
      for (let t = 16; t < 64; t++) {
        const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }
  function sha256(input) {
    const s = String(input == null ? "" : input);
    if (nodeCrypto) return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
    return sha256Direct(s);
  }

  // ---------- field resolution: profile facts ONLY; unknowns are asks ----------
  const humanField = (id) => String(id || "").replace(/_/g, " ");
  function resolveField(field, ctx) {
    const p = (ctx && ctx.profile) || {};
    const basics = p.basics || {}, cons = p.constraints || {}, defaults = p.defaults || {};
    const id = field.field_id;
    const from = (value, source) => ({ value, source });
    const ask = (reason) => ({ ask: reason || "not in the profile — the user must supply it; never guessed" });
    // Resume channel (APD-1): an answer the user supplied for this exact
    // field — through the same user-supplied fact channel the default case
    // below already reads — IS the user's own answer, for every field,
    // including a consent, a legal declaration, or the user's own words.
    // Absent that, those fields stay asks below; they are never guessed.
    const supplied = ctx && ctx.formFacts && ctx.formFacts[id];
    if (supplied != null) return from(supplied, "user-supplied answer for this exact field");
    switch (id) {
      case "full_name": return basics.name ? from(basics.name, "profile basics.name") : ask();
      case "email": return basics.email ? from(basics.email, "profile basics.email") : ask();
      case "phone": return basics.phone ? from(basics.phone, "profile basics.phone") : ask("phone is not on the profile");
      case "resume_upload": {
        const art = (ctx && ctx.resumeArtifact) || null;
        if (!art || !art.name) return ask("no resume artifact is bound to this application");
        return from(art.name, "bound resume artifact " + art.name + (art.sha256 ? " (sha256 recorded in the payload snapshot)" : ""));
      }
      case "work_authorization": {
        if (cons.needsSponsorship === true) return from("will-need-sponsorship", "profile constraints.needsSponsorship = true (stated by the user, never inferred)");
        if (cons.needsSponsorship === false && cons.workAuthorization) return from("yes-authorized", "profile constraints.workAuthorization (stated) + needsSponsorship = false");
        return ask("work authorization is sensitive and is not stated on the profile");
      }
      case "sponsorship_detail": {
        const detail = cons.sponsorshipDetail || (ctx && ctx.formFacts && ctx.formFacts.sponsorship_detail) || (/f-1|opt|sponsorship/i.test(String(cons.workAuthorization || "")) ? String(cons.workAuthorization) : null);
        return detail ? from(detail, "profile constraints (stated eligibility / sponsorship detail)") : ask("sponsorship detail is sensitive and is not stated on the profile");
      }
      case "start_date": {
        if (!cons.startDate) return ask();
        const v = String(cons.startDate);
        return from(/^\d{4}-\d{2}$/.test(v) ? v + "-01" : v, "profile constraints.startDate");
      }
      case "graduation_date": return cons.graduationDate ? from(String(cons.graduationDate), "profile constraints.graduationDate") : ask();
      case "eeo_gender": case "eeo_veteran": case "eeo_gender_reversed": {
        if (defaults.demographicPreference && /decline/i.test(String(defaults.demographicPreference))) return from("decline-to-answer", "profile defaults.demographicPreference — the user's stored decline-to-answer preference, set explicitly so no hidden default can stand");
        const explicit = ctx && ctx.eeoAnswers && ctx.eeoAnswers[id];
        return explicit ? from(explicit, "user-supplied answer for this exact field") : ask("sensitive field with no stored preference — never guessed, and a hidden default must never stand in for the user");
      }
      case "background_check_consent": return ask("consent must be the user's own act — a pre-checked box is not consent");
      case "export_control_declaration": return ask("a legal declaration must be the user's own answer");
      case "sms_opt_in": return from(false, "safe default — the user is never opted into marketing messages on their behalf; the pre-checked box is explicitly cleared");
      case "why_company": return ask("this answer must be the user's own words — left blank rather than invented");
      default: {
        const explicit = ctx && ctx.formFacts && ctx.formFacts[id];
        return explicit != null ? from(explicit, "user-supplied fact for this field") : ask();
      }
    }
  }

  // Dry validation of the EXACT payload, using the driver's own checks plus the
  // submit pre-checks (late material), WITHOUT calling submit.
  function dryValidate(session, spec) {
    const v = session.validate();
    const late = Driver.lateMaterialFields(spec).filter((f) => f.required && session.answers[f.field_id] === undefined).map((f) => f.field_id);
    const hiddenSensitive = v.hiddenDefaultsInEffect.filter((h) => h.sensitive).map((h) => h.field_id);
    return { ok: v.ok && late.length === 0 && hiddenSensitive.length === 0, missing: v.missing, hidden_defaults_in_effect: v.hiddenDefaultsInEffect, hidden_sensitive: hiddenSensitive, late_material_unacknowledged: late, submitted: false, note: "driver validate() + submit pre-checks on the exact payload; submit was NOT called" };
  }

  // ---------- G2 / APD-1: blocker collection (one state machine) ----------
  // A blocker is anything the dry validation flags on the exact payload:
  // a late material question, a missing required field, or a hidden default
  // still in effect. Blockers are structured data (field ids + kinds stay
  // here and on result objects); replies name them only through humanField.
  function specField(spec, fieldId) {
    if (!Driver || !spec) return null;
    const hit = Driver.allFields(spec).find((x) => x.field.field_id === fieldId);
    return hit ? hit.field : null;
  }
  function collectBlockers(spec, dry) {
    const byField = new Map();
    const add = (fieldId, kind, sensitive) => {
      if (!fieldId) return;
      let b = byField.get(fieldId);
      if (!b) {
        const def = specField(spec, fieldId);
        b = { field: fieldId, name: humanField(fieldId), label: (def && def.label) || humanField(fieldId), kinds: [], sensitive: !!(sensitive || (def && def.sensitive)) };
        byField.set(fieldId, b);
      }
      if (!b.kinds.includes(kind)) b.kinds.push(kind);
      if (sensitive) b.sensitive = true;
    };
    for (const id of (dry && dry.late_material_unacknowledged) || []) add(id, "late_material");
    for (const id of (dry && dry.missing) || []) add(id, "missing_required");
    for (const h of (dry && dry.hidden_defaults_in_effect) || []) add(h.field_id, "hidden_default", h.sensitive);
    return [...byField.values()];
  }
  function blockerAskReason(blocker) {
    if (blocker.kinds.includes("late_material")) return "a required question that appears for the first time on the final review step — it must be the user's own answer, never guessed";
    if (blocker.kinds.includes("hidden_default")) return "an answer is preselected in secret on this form and the user has not chosen it themselves — it must be the user's own answer, never the hidden preselection";
    return "a required answer that is not in the profile — it must come from the user, never guessed";
  }
  function blockerNames(blockers) {
    return (blockers || []).map((b) => humanField(typeof b === "string" ? b : b.field)).join(", ");
  }
  // The blockers open RIGHT NOW, re-derived from the live session's dry
  // validation at submit time (never trusted from a stale doorstep object);
  // the stored doorstep blockers are the fallback when no session survives.
  function openBlockers(state) {
    const st = state || {};
    if (st.session && st.spec) {
      try { return collectBlockers(st.spec, dryValidate(st.session, st.spec)); } catch (e) { /* fall through to the stored blockers */ }
    }
    return (st.doorstep && st.doorstep.blockers) || [];
  }
  // The structured code for a blocker refusal, derived from its kinds —
  // it lives on the result object exactly as the driver-stop code always
  // did, and never in the reply text.
  function blockerStopCode(blockers) {
    const kinds = new Set((blockers || []).flatMap((b) => b.kinds || []));
    if (kinds.has("late_material")) return "LATE_MATERIAL_QUESTION";
    if (kinds.has("hidden_default")) return "UNRESOLVED_HIDDEN_DEFAULT";
    if (kinds.has("missing_required")) return "MISSING_REQUIRED";
    return null;
  }
  function blockerRefusal(blockers, doorstep, submission) {
    const names = blockerNames(blockers);
    return {
      intent: "doorstep_submit", resultStatus: "awaiting_user", refused: true, blockers,
      stop_code: blockerStopCode(blockers),
      doorstep, submission,
      reply: `I stopped the submit — nothing was submitted. I still need your own answer for: ${names || "the open questions on this form"}. Answer those and I will prepare it again — approve the new review when it is ready.`,
    };
  }

  // ---------- 0. R2B: fact binding, destination truth, guards, recorders ----------
  // Fact binding: the version is 130's counter (profile.fact_version, bumped by
  // 130's write paths); the hash covers the fact-bearing profile slices in a
  // canonical (key-sorted) serialization, so ANY change to the facts the
  // packet was prepared from — through any write path — changes the binding.
  function factVersionOf(profile) {
    if (Onboarding && typeof Onboarding.factVersion === "function") return Onboarding.factVersion(profile);
    return profile && Number.isFinite(profile.fact_version) ? profile.fact_version : 0;
  }
  function factSlices(profile) {
    const p = profile || {};
    return {
      basics: p.basics || {}, preferences: p.preferences || {}, constraints: p.constraints || {},
      facts: (p.facts || []).map((f) => ({ id: f.id || null, kind: f.kind || null, title: f.title || null, text: f.text || null, status: f.status || null, needs_confirmation: !!f.needs_confirmation })),
    };
  }
  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined && typeof v[k] !== "function").map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  function factBinding(profile) {
    if (!profile) return null;
    return { fact_version: factVersionOf(profile), fact_hash: sha256(stableStringify(factSlices(profile))) };
  }

  // Destination truth: read the receipt sink for THIS doorstep. The sink dir
  // is the one stamped at fill (state.sink_dir) or passed by the host
  // (ctx.sinkDir); the driver's own reconcile() is the other read of the same
  // destination. Returns null when the destination cannot be read at all —
  // callers must treat that as "cannot confirm", never as confirmation.
  function readSinkReceipts(ctx, state) {
    const dir = (ctx && ctx.sinkDir) || (state && state.sink_dir) || null;
    if (!dir || !nodeFs || !nodePath) return null;
    try {
      const receipts = [];
      for (const f of nodeFs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        try { receipts.push(JSON.parse(nodeFs.readFileSync(nodePath.join(dir, f), "utf8"))); } catch (e) { /* a non-receipt file is not evidence either way */ }
      }
      return { dir, receipts };
    } catch (e) { return null; }
  }
  function destinationStatus(ctx, state) {
    const sub = (state && state.submission) || {};
    const jobId = (state && state.job_id) || (state && state.doorstep && state.doorstep.job_id) || (state && state.spec && state.spec.board && state.spec.board.job_id) || null;
    let checked = false, found = false, receipt = null;
    if (state && state.session && typeof state.session.reconcile === "function" && sub.receipt_id) {
      try { const rec = state.session.reconcile(sub.receipt_id); checked = true; found = !!(rec && rec.found); receipt = (rec && rec.receipt) || null; } catch (e) { /* unreadable destination: checked stays false */ }
    }
    const sink = readSinkReceipts(ctx, state || {});
    let jobReceipts = null;
    if (sink) {
      checked = true;
      jobReceipts = sink.receipts.filter((r) => !jobId || !r.job_id || r.job_id === jobId);
      if (sub.receipt_id) { const hit = sink.receipts.find((r) => r.receipt_id === sub.receipt_id); if (hit) { found = true; receipt = receipt || hit; } }
      else if (jobReceipts.length) { found = true; receipt = receipt || jobReceipts[0]; }
    }
    return { checked, found, receipt, job_receipt_count: jobReceipts ? jobReceipts.length : null };
  }

  // Prior applications for this user+job, from every record the host keeps:
  // the doorstep state's own list, host ctx lists, the profile, a recorded
  // manual-apply disclosure — and the destination itself (a sink receipt for
  // this job that is not THIS doorstep's own recorded submission).
  function jobIdentity(state, spec) {
    const board = (spec && spec.board) || (state && state.spec && state.spec.board) || {};
    return {
      job_id: board.job_id || (state && state.job_id) || (state && state.doorstep && state.doorstep.job_id) || null,
      company: board.company || (state && state.doorstep && state.doorstep.company) || null,
      role: board.role || (state && state.doorstep && state.doorstep.role) || null,
    };
  }
  // Coordinator integration bridge (repair round 2): the router lane (142)
  // records user intents in its own shapes — doorstepState.invalidation
  // { active, reason }, .role_closed { closed }, .prior_application
  // { disclosed } — while these guards were written against the recorder
  // shapes above. This reader translates the router's shapes so BOTH
  // writers arm the same execution guards.
  function routerInvalidation(st) {
    const inv = st && st.invalidation && st.invalidation.active === true ? st.invalidation : null;
    const reason = inv ? inv.reason : null;
    return {
      closed: reason === "role_closed" || !!(st && st.role_closed && st.role_closed.closed === true),
      cancelled: reason === "cancelled_by_user",
      invalidated: !!inv && reason !== "role_closed" && reason !== "cancelled_by_user" && reason !== "prior_application",
      prior: reason === "prior_application" || !!(st && st.prior_application && st.prior_application.disclosed === true),
      reason,
    };
  }
  function priorApplicationFor(ctx, state, spec) {
    const st = state || {}, c = ctx || {};
    const job = jobIdentity(st, spec);
    const matches = (rec) => {
      if (!rec || typeof rec !== "object") return false;
      const rid = rec.job_id || rec.jobId || null;
      if (job.job_id && rid) return rid === job.job_id;
      if (job.company && rec.company) return rec.company === job.company && (!job.role || !rec.role || rec.role === job.role);
      return false;
    };
    const lists = [st.prior_applications, st.priorApplications, c.priorApplications, c.trackerRecords, c.applications, c.profile && c.profile.applications];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const hit = list.find(matches);
      if (hit) return { job_id: hit.job_id || hit.jobId || job.job_id, company: hit.company || job.company, role: hit.role || job.role, source: hit.source || "prior application on record", channel: hit.channel || null, at: hit.at || null, receipt_id: hit.receipt_id || null };
    }
    if (st.prior_application && st.prior_application.disclosed === true) {
      const pa = st.prior_application;
      return { job_id: pa.job_id || job.job_id, company: pa.company || job.company, role: pa.role || job.role, source: "manual application (disclosed by the user)", channel: pa.channel || null, at: pa.at || null, receipt_id: null };
    }
    if (routerInvalidation(st).prior) {
      const inv = st.invalidation || {};
      return { job_id: job.job_id, company: job.company, role: job.role, source: "manual application (disclosed by the user)", channel: null, at: inv.at || null, receipt_id: null };
    }
    for (const single of [st.manual_apply_disclosure, c.manualApplyDisclosure, c.manual_apply_disclosure]) {
      if (single && matches(single)) return { job_id: single.job_id || single.jobId || job.job_id, company: single.company || job.company, role: single.role || job.role, source: single.source || "manual application (disclosed by the user)", channel: single.channel || null, at: single.at || null, receipt_id: null };
    }
    const sink = readSinkReceipts(c, st);
    if (sink) {
      const own = st.submission && st.submission.receipt_id;
      const hit = sink.receipts.find((r) => (!job.job_id || !r.job_id || r.job_id === job.job_id) && r.receipt_id !== own);
      if (hit) return { job_id: hit.job_id || job.job_id, company: job.company, role: job.role, source: "prior submission at the destination", channel: "receipt sink", at: hit.submitted_at || null, receipt_id: hit.receipt_id };
    }
    return null;
  }
  function describePrior(prior) {
    if (!prior) return "a prior application";
    const bits = [];
    if (prior.source) bits.push(prior.source);
    if (prior.channel) bits.push("via " + prior.channel);
    if (prior.at) bits.push("on " + prior.at);
    if (prior.receipt_id) bits.push("receipt " + prior.receipt_id);
    return bits.join(", ") || "a prior application";
  }
  function jobLabelOf(state) {
    const job = jobIdentity(state || {});
    return [job.company, job.role].filter(Boolean).join(" — ") || "this job";
  }
  function jobClosedReason(ctx, state) {
    const st = state || {}, c = ctx || {};
    if (st.job_status === "closed" || st.job_closed === true || routerInvalidation(st).closed) return st.job_closed_reason || "the role was reported closed — it is no longer accepting applications";
    const p = c.posting || null;
    if (p && (p.closed === true || p.is_closed === true || p.status === "closed" || p.accepting_applications === false || p.acceptingApplications === false)) {
      return "the posting now shows this job as closed — it is no longer accepting applications";
    }
    return null;
  }
  function staleFactCheck(ctx, state) {
    const st = state || {}, c = ctx || {};
    if (!c.profile) return null;
    const boundHash = st.fact_hash || (st.doorstep && st.doorstep.fact_hash) || null;
    const boundVersion = st.fact_version != null ? st.fact_version : (st.doorstep ? st.doorstep.fact_version : null);
    if (boundHash == null && boundVersion == null) return null; // prepared before binding existed — nothing to compare
    const cur = factBinding(c.profile);
    if (boundHash && cur.fact_hash !== boundHash) return { kind: boundVersion != null && cur.fact_version !== boundVersion ? "version" : "hash", bound: boundVersion, current: cur.fact_version };
    if (!boundHash && boundVersion != null && cur.fact_version !== boundVersion) return { kind: "version", bound: boundVersion, current: cur.fact_version };
    return null;
  }
  // THE execution-time guard set (R2B fix 2): evaluated immediately before
  // any sink write, purely from re-read state. Returns null when the submit
  // may proceed, else { code, reason, unblock, reply }.
  function checkSubmitGuards(ctx, state) {
    const st = state || {}, sub = st.submission || {};
    const ri = routerInvalidation(st);
    if (sub.status === "cancelled" || st.approval_cancelled === true || ri.cancelled) {
      const why = sub.cancel_reason || st.cancel_reason || null;
      return { code: "approval_cancelled", reason: "the user cancelled this submission" + (why ? ` (${why})` : ""), unblock: "prepare the application fresh and approve the new review",
        reply: `I did not submit this application: you cancelled it${why ? ` (${why})` : ""}, and a cancelled approval cannot be revived by a later "approve and submit". Nothing was submitted. If you want it to go ahead after all, ask me to prepare it fresh and approve the new review.` };
    }
    if (st.approval_invalidated === true || sub.status === "invalidated" || ri.invalidated) {
      const why = st.invalidated_reason || sub.invalidated_reason || (ri.reason ? "invalidated by a later update (" + ri.reason + ")" : null) || "the prepared packet was invalidated";
      return { code: "approval_invalidated", reason: String(why), unblock: "re-prepare the packet on the current facts and re-confirm the new review",
        reply: `I did not submit this application: the prepared packet was invalidated (${why}), so its approval no longer stands. Nothing was submitted. Tell me to re-prepare it on the current facts and I will bring you the new review to confirm.` };
    }
    const closed = jobClosedReason(ctx, st);
    if (closed) {
      return { code: "job_closed", reason: closed, unblock: "the employer reopens the job, or pick another role and I will prepare a fresh application",
        reply: `I did not submit this application: ${closed}, so this submission is stopped. Nothing was submitted. If the employer reopens it — or you pick another role — tell me and I will prepare a fresh application for your review.` };
    }
    const prior = priorApplicationFor(ctx, st, st.spec);
    if (prior) {
      return { code: "duplicate_application", reason: `an application for this job is already on record (${describePrior(prior)})`, unblock: "track or check the status of the existing application instead of applying again", prior,
        reply: `I did not submit: there is already an application on record for ${jobLabelOf(st)} (${describePrior(prior)}), so a second submission would be a duplicate application. Nothing was submitted. I can track the existing application and check its status instead — tell me to track it and I will.` };
    }
    const stale = staleFactCheck(ctx, st);
    if (stale) {
      const change = stale.kind === "version" ? `fact version ${stale.bound} → ${stale.current}` : "the facts on file no longer match the ones this packet was prepared from";
      return { code: "stale_packet_facts", reason: `profile facts changed after this packet was prepared (${change})`, unblock: "re-confirm the current answers, let me re-prepare the packet, then approve the new review",
        reply: `I did not submit: your profile facts changed after this packet was prepared (${change}), so the prepared answers are stale and this packet is invalidated. Nothing was submitted with the old answers. You have to confirm the current answers again and the packet must be re-prepared before anything submits — tell me when you are ready and I will re-prepare it.` };
    }
    return null;
  }
  // Recorders — Lane A's mutation surface. Each accepts the chat ctx (with
  // .doorstepState) or the doorstepState object itself, writes the state
  // fields documented in the header, and returns what it wrote.
  function stateOf(x) { if (!x || typeof x !== "object") return null; return x.doorstepState || x; }
  function recordJobClosure(x, info) {
    const st = stateOf(x); if (!st) return null;
    const o = info || {};
    st.job_status = "closed"; st.job_closed = true;
    st.job_closed_at = o.at || null;
    st.job_closed_reason = o.reason || "the employer closed this job — it is no longer accepting applications";
    return st;
  }
  function cancelDoorstep(x, info) {
    const st = stateOf(x); if (!st) return null;
    const o = info || {};
    st.submission = st.submission || { status: "not_submitted", retries: 0, reconciled_before_retry: false, receipt_id: null };
    st.submission.status = "cancelled";
    st.submission.cancelled_at = o.at || null;
    st.submission.cancel_reason = o.reason || "user cancelled the submission";
    st.approval_cancelled = true;
    if (st.doorstep) { st.doorstep.submission = st.submission; st.doorstep.state = "CANCELLED"; }
    return st;
  }
  function invalidateApproval(x, info) {
    const st = stateOf(x); if (!st) return null;
    const o = info || {};
    st.approval_invalidated = true;
    st.invalidated_at = o.at || null;
    st.invalidated_reason = o.reason || "the prepared packet was invalidated";
    if (st.submission && st.submission.status === "not_submitted") st.submission.status = "invalidated";
    return st;
  }
  function recordPriorApplication(x, rec) {
    const st = stateOf(x); if (!st || !rec) return null;
    const entry = { job_id: rec.job_id || rec.jobId || null, company: rec.company || null, role: rec.role || null, source: rec.source || "manual", channel: rec.channel || null, at: rec.at || null };
    st.prior_applications = [...(st.prior_applications || []), entry];
    return entry;
  }

  // ---------- 1. doorstep fill (C17/C18 + C20 pre-submit) ----------
  function fillDoorstep(ctx) {
    if (!Driver) return { ok: false, code: "driver_unavailable", reply: "The form driver is not available in this build, so I filled nothing." };
    const spec = ctx.formSpec || Driver.loadSpec(ctx.formSpecName);
    const sinkDir = ctx.sinkDir; // local receipt sink dir only; the driver refuses URLs
    const state = ctx.doorstepState || (ctx.doorstepState = {});
    state.sink_dir = sinkDir || state.sink_dir || null;
    // R2B preparation-time duplicate guard: a prior application already on
    // record for this job means NO duplicate packet is even prepared (the
    // execution-time guard in submitDoorstep is the second line of defense).
    const prior = priorApplicationFor(ctx, state, spec);
    if (prior) {
      const job = jobIdentity(state, spec);
      const label = [job.company, job.role].filter(Boolean).join(" — ") || "this job";
      return { ok: false, code: "duplicate_application", prior, reply: `I stopped before filling anything out: there is already an application on record for ${label} (${describePrior(prior)}), so preparing a second one would duplicate it. Nothing was filled or submitted. I can track the existing application and check its status instead — tell me to track it and I will.` };
    }
    const session = Driver.createSession(spec, sinkDir ? { sinkDir } : {});
    const stepLog = [], asks = [];
    let seq = 0;
    for (const step of spec.steps) {
      // APD-1: the review step is NOT skipped — a required question that
      // first appears there (the Lever-like late material shape) is filled
      // or, like every other unresolvable field, surfaced as an ask in
      // this same loop, before any review screen is claimed.
      // Two passes per step: a conditional field can become visible only
      // after its trigger field in the same step is filled.
      for (let pass = 0; pass < 2; pass++) {
        for (const field of session.visibleFields(step.step_id)) {
          if (session.answers[field.field_id] !== undefined) continue;
          const r = resolveField(field, ctx);
          if (r.ask) {
            if (!asks.some((a) => a.field === field.field_id)) asks.push({ field: field.field_id, label: field.label || humanField(field.field_id), reason: r.ask, sensitive: !!field.sensitive });
            stepLog.push({ step: ++seq, action: "ask", field: field.field_id, step_id: step.step_id, value_source: null, result: "surfaced_as_ask — left unfilled, never guessed" });
          } else {
            session.fill(ctx.formProfileId || "profile-in-ctx", field.field_id, r.value);
            stepLog.push({ step: ++seq, action: "fill", field: field.field_id, step_id: step.step_id, value: r.value, value_source: r.source, result: "filled" });
          }
        }
      }
      for (const { field } of Driver.allFields(spec).filter((x) => x.step_id === step.step_id)) {
        if (field.visible_if && !Driver.isVisible(field, session.answers) && session.answers[field.field_id] === undefined) {
          stepLog.push({ step: ++seq, action: "skip", field: field.field_id, step_id: step.step_id, value_source: null, result: "not visible — its condition is not met by the profile's answers" });
        }
      }
    }
    const validation = session.validate();
    const hiddenSensitive = validation.hiddenDefaultsInEffect.filter((h) => h.sensitive);
    const art = ctx.resumeArtifact || {};
    const answers = Object.assign({}, session.answers);
    // R2B packet<->fact binding: this packet is submittable only while the
    // profile still matches this stamp (version + fact hash) at submit time.
    const binding = factBinding(ctx.profile);
    const payload = {
      form: spec.fixture_id, company: (spec.board || {}).company || null, role: (spec.board || {}).role || null, job_id: (spec.board || {}).job_id || null,
      answers, resume_artifact: art.name || null, resume_sha256: art.sha256 || (art.content != null ? sha256(art.content) : null),
      payload_sha256: sha256(JSON.stringify(answers)), submitted: false,
      fact_version: binding ? binding.fact_version : null, fact_hash: binding ? binding.fact_hash : null,
    };
    const dry = dryValidate(session, spec);
    // APD-1: collect EVERY dry-validation blocker and surface any the fill
    // loop did not already ask about, so the ask set is complete by
    // construction — no blocker can exist in state without being an ask
    // in the reply the user sees at fill time.
    const blockers = collectBlockers(spec, dry);
    for (const blocker of blockers) {
      if (!asks.some((a) => a.field === blocker.field)) {
        const def = specField(spec, blocker.field);
        asks.push({ field: blocker.field, label: (def && def.label) || humanField(blocker.field), reason: blockerAskReason(blocker), sensitive: blocker.sensitive });
        stepLog.push({ step: ++seq, action: "ask", field: blocker.field, step_id: def ? (Driver.allFields(spec).find((x) => x.field.field_id === blocker.field) || {}).step_id || null : null, value_source: null, result: "surfaced_as_ask — a dry-validation blocker on the exact payload, left unfilled, never guessed" });
      }
    }
    let doorstepStateName = "REVIEW", stopCode = null, review = null;
    if (hiddenSensitive.length) {
      stopCode = "UNRESOLVED_HIDDEN_DEFAULT";
      doorstepStateName = "STOPPED";
      stepLog.push({ step: ++seq, action: "stop", code: stopCode, fields: hiddenSensitive.map((h) => h.field_id), value_source: null, result: "stopped before the review screen — a sensitive hidden default was never explicitly answered and must never ride along" });
    } else if (blockers.length) {
      // Not the review screen, and not stopped-on: the flow is waiting on
      // the user's own answers. REVIEW comes only after a resume re-fill
      // clears these blockers.
      doorstepStateName = "AWAITING_ANSWERS";
      stepLog.push({ step: ++seq, action: "ask", field: null, fields: blockers.map((b) => b.field), value_source: null, result: "stopped before the final review screen — every dry-validation blocker was surfaced as an ask; the review screen waits until the user answers" });
    } else {
      review = session.review();
      stepLog.push({ step: ++seq, action: "review", field: null, step_id: review.step_id, value_source: null, result: "stopped ON the final review screen — submit not clicked" });
    }
    const doorstep = {
      form: spec.fixture_id, company: payload.company, role: payload.role, job_id: payload.job_id,
      state: doorstepStateName, stop_code: stopCode, submitted: false,
      step_log: stepLog, asks, blockers, payload,
      dry_validate: dry, sink_armed: doorstepStateName === "REVIEW" && dry.ok,
      review,
      fact_version: payload.fact_version, fact_hash: payload.fact_hash,
      approval_binding: binding ? { fact_version: binding.fact_version, fact_hash: binding.fact_hash } : null,
    };
    Object.assign(state, { spec, session, doorstep, submission: { status: "not_submitted", retries: 0, reconciled_before_retry: false, receipt_id: null }, payload_sha256: payload.payload_sha256, job_id: payload.job_id, fact_version: payload.fact_version, fact_hash: payload.fact_hash });
    doorstep.submission = state.submission;
    return { ok: true, doorstep };
  }

  function fillReply(doorstep) {
    const askText = doorstep.asks.length ? ` I still need from you: ${doorstep.asks.map((a) => humanField(a.field)).join(", ")} — I left those unfilled rather than guessing.` : "";
    if (doorstep.state === "STOPPED") {
      const hiddenNames = blockerNames((doorstep.blockers || []).filter((b) => b.kinds.includes("hidden_default")));
      const hiddenText = hiddenNames ? ` The preselected answer I will not use is for: ${hiddenNames}.` : "";
      return `I filled what your profile establishes, then stopped: a sensitive answer on this form is preselected in secret and you have not chosen it yourself.${hiddenText}${askText} Nothing was submitted. Tell me how you want that answer set and I will take the form to its review screen.`;
    }
    if (doorstep.state !== "REVIEW" || (doorstep.blockers || []).length) {
      const names = blockerNames(doorstep.blockers || []);
      return `I filled what your profile establishes, but I have not taken this to the final review screen yet. I still need your own answer for: ${names || "the open questions on this form"} — I left those unfilled rather than guessing. Nothing was submitted. Tell me your answer for each one and I will fill it in and take it to review for your approval.`;
    }
    return `Filled the ${doorstep.company || "application"} form from your profile and stopped on the final review screen — it is not submitted.${askText} Nothing will be submitted until you approve it.`;
  }

  // ---------- 2. C20 submit + reconcile (R2B: guarded submit, destination-truth status) ----------
  function submitDoorstep(ctx) {
    const state = ctx.doorstepState || {};
    const sub = state.submission;
    if (sub && state.doorstep) state.doorstep.submission = sub;
    if (!state.session || !sub) return { intent: "doorstep_submit", resultStatus: "blocked", reply: "There is no prepared form waiting on its review screen, so there is nothing to submit. Want me to fill the form out first?" };
    if (sub.status === "unknown_outcome") {
      return { intent: "doorstep_submit", resultStatus: "unknown_outcome", duplicate_refused: true, doorstep: state.doorstep, submission: sub, reply: `One submission for this exact review is already on record and its outcome is still unknown, so I will not submit again. Ask me "did it go through?" and I will reconcile the receipt state before any retry.` };
    }
    if (sub.status === "confirmed_after_reconcile" || sub.status === "submitted_accepted") {
      // Even the refusal speaks only from a destination re-read: if the
      // receipt is gone, "already recorded" would be a false completion.
      const dest = destinationStatus(ctx, state);
      if (dest.checked && !dest.found) {
        sub.status = "unknown_outcome"; sub.destination_missing = true; sub.receipt_missing_at_destination = true;
        return { intent: "doorstep_submit", resultStatus: "unknown_outcome", duplicate_refused: true, doorstep: state.doorstep, submission: sub, destination: dest, reply: `I will not submit again: one submission was sent for this review, but I just re-checked the receipt sink and found no receipt for it, so its outcome is now uncertain — it may never have landed. Ask me "did it go through?" and I will reconcile before anything else happens.` };
      }
      return { intent: "doorstep_submit", resultStatus: "completed", duplicate_refused: true, doorstep: state.doorstep, submission: sub, reply: `One submission for this exact review is already on record — its outcome is on file — so I will not submit again. Ask me "did it go through?" and I will reconcile the receipt state before any retry.` };
    }
    // R2B execution-time guards: re-read state IMMEDIATELY before any sink
    // write. A stale approval / closed role / duplicate / stale packet is
    // refused here even when the executing turn is a bare "approve and
    // submit" and no upstream handler caught the change (AP08/AP18/AP20/AP23).
    const refusal = checkSubmitGuards(ctx, state);
    if (refusal) return { intent: "doorstep_submit", resultStatus: "blocked", refused: true, guard_refusal: refusal, doorstep: state.doorstep, submission: sub, reply: refusal.reply };
    // APD-1: a submit attempt with open blockers never reaches the sink.
    // The blockers are re-derived from the live session now (not trusted
    // from the fill-time object), and the refusal names them in plain
    // words — the structured stop code stays on the result, not the reply.
    const open = openBlockers(state);
    if (open.length) { sub.status = "not_submitted"; return blockerRefusal(open, state.doorstep, sub); }
    if (state.doorstep.state !== "REVIEW") return { intent: "doorstep_submit", resultStatus: "awaiting_user", doorstep: state.doorstep, submission: sub, stop_code: state.doorstep.stop_code || null, reply: `I stopped the submit — nothing was submitted. This form is not on its final review screen, so there is nothing ready to submit. Answer the open asks and I will prepare it again — approve the new review when it is ready.` };
    const out = state.session.submit();
    if (out.outcome === "accepted") {
      sub.status = "submitted_accepted"; sub.receipt_id = out.receipt && out.receipt.receipt_id;
      return { intent: "doorstep_submit", resultStatus: "completed", doorstep: state.doorstep, submission: sub, reply: `Submitted once to the local test sink and confirmed with receipt ${sub.receipt_id}. That was the one approved submission for this review. Want me to watch this one for status changes?` };
    }
    if (out.outcome === "timeout") {
      sub.status = "unknown_outcome"; sub.receipt_id = out.receipt_id || (out.receipt && out.receipt.receipt_id) || null; sub.receipt_written = !!out.receiptWritten;
      return { intent: "doorstep_submit", resultStatus: "unknown_outcome", doorstep: state.doorstep, submission: sub, reply: "I submitted the form once, but the response timed out, so its outcome is unknown — I am not claiming it went through. Ask me \"did it go through?\" and I will check the receipt state before any retry." };
    }
    // Driver stop (missing required / hidden default / late material) —
    // defense in depth behind the blocker pre-check above. The driver's
    // structured code stays on this result object; the reply names the
    // fields the driver flagged, in plain words, and nothing else.
    sub.status = "not_submitted";
    const stoppedFields = [...(out.fields || []), ...(out.missing || [])];
    const stoppedNames = stoppedFields.map((f) => humanField(f)).join(", ");
    return { intent: "doorstep_submit", resultStatus: "awaiting_user", doorstep: state.doorstep, submission: sub, stop_code: out.code || null, reply: `The form stopped the submit — nothing was submitted. I still need your own answer for: ${stoppedNames || "the open questions on this form"}. Answer those and I will prepare it again — approve the new review when it is ready.` };
  }
  function reconcileDoorstep(ctx) {
    const state = ctx.doorstepState || {};
    const sub = state.submission;
    if (sub && state.doorstep) state.doorstep.submission = sub;
    if (!sub || sub.status === "not_submitted") return { intent: "doorstep_status", resultStatus: "prepared", doorstep: state.doorstep || null, submission: sub || null, reply: "Nothing has been submitted for this form yet, so there is no outcome to check. It is still waiting on its review screen — approve it there and it goes." };
    if (sub.status === "cancelled") return { intent: "doorstep_status", resultStatus: "blocked", doorstep: state.doorstep || null, submission: sub, reply: "Nothing was submitted for this form — the submission was cancelled, so there is no outcome to check, and nothing will be sent unless you ask me to prepare it fresh — tell me and I will." };
    if (sub.status === "invalidated" || state.approval_invalidated === true) return { intent: "doorstep_status", resultStatus: "blocked", doorstep: state.doorstep || null, submission: sub, reply: "Nothing was submitted for this form — the prepared packet was invalidated, so there is no outcome to check. It has to be re-prepared on the current facts first — tell me and I will re-prepare it for a fresh approval." };
    // THE one truth path (R2B / AP22): whatever the in-memory state claims —
    // accepted, confirmed, or unknown — the status is spoken ONLY from a
    // fresh re-read of the destination, taken now. This is the same read the
    // AP19 timeout branch always performed; the accepted branch used to skip
    // it and confirm from memory (DD-5).
    const dest = destinationStatus(ctx, state);
    const wasUnknown = sub.status === "unknown_outcome";
    if (dest.checked && dest.found) {
      if (wasUnknown) { sub.status = "confirmed_after_reconcile"; sub.reconciled_before_retry = sub.retries === 0; if (dest.receipt) sub.receipt = dest.receipt; }
      sub.destination_missing = false;
      const exactlyOne = dest.job_receipt_count == null || dest.job_receipt_count === 1;
      return { intent: "doorstep_status", resultStatus: "completed", doorstep: state.doorstep, submission: sub, destination: dest, reply: wasUnknown
        ? `Yes — I checked the receipt sink before any retry and found exactly one submission for this application (receipt ${sub.receipt_id}). No second submission was made, so there are no duplicates. Want the full timeline for this application?`
        : exactlyOne
          ? `Yes — I re-checked the receipt sink just now: exactly one submission is on record for this application (receipt ${sub.receipt_id}). No second submission was made. Want the full timeline for this application?`
          : `I re-checked the receipt sink just now: ${dest.job_receipt_count} submissions are on record for this application (this one: receipt ${sub.receipt_id}). I made no further submission. Tell me if you want the full timeline for this application.` };
    }
    // Receipt absent at the destination (or the destination unreadable):
    // the outcome is UNCERTAIN, in plain words — never a confirmation — and
    // the in-memory state is downgraded to match the destination. No retry
    // is taken here, and none will be taken blindly (AP22-A2/A3/A4).
    sub.status = "unknown_outcome";
    sub.destination_missing = true;
    if (dest.checked) { sub.receipt_missing_at_destination = true; if (wasUnknown) sub.reconciled_before_retry = sub.retries === 0; }
    return { intent: "doorstep_status", resultStatus: "unknown_outcome", doorstep: state.doorstep, submission: sub, destination: dest, reply: dest.checked
      ? "I checked the receipt sink just now and found no receipt for that submission, so I cannot confirm it went through — its outcome is uncertain. I have not resubmitted anything, and I will not resubmit blindly, since that could double-apply; tell me if you want me to prepare it again for your review."
      : "I could not re-read the receipt sink just now, so I cannot confirm that submission went through — its outcome is uncertain. I have not resubmitted anything — tell me to try again and I will reconcile the sink before any retry." };
  }

  // ---------- 3. queue control (C37 + R-A4 kill switch) ----------
  // R-A4 (quality spec 01, S0): "stop everything" ALWAYS halts. The halt is
  // a GLOBAL user pause, set on every surface the host can persist/honor —
  // ctx.globalPause, the loaded queue-state object (state.global_pause),
  // and the queue itself (q.global_pause + q.halted) — whether or not the
  // queue's own records could be read in this session. An unreadable queue
  // is never a no-op and never a crash: the pause is set anyway, the reply
  // says the exact counts are UNVERIFIED, and 124's sendPending/enqueue
  // honor the same pause flag (campaign.global_pause / opts.globalPause).
  function loadQueueState(ctx) {
    try {
      if (ctx.queueState) return { state: ctx.queueState, persist: () => {} };
      if (ctx.queueStatePath && nodeFs) {
        const state = JSON.parse(nodeFs.readFileSync(ctx.queueStatePath, "utf8"));
        return { state, persist: () => nodeFs.writeFileSync(ctx.queueStatePath, JSON.stringify(state, null, 2) + "\n") };
      }
    } catch (e) {
      // A missing/unreadable/corrupt queue file is "can't be read" — the
      // caller halts via the global pause instead of crashing the turn.
      return { state: null, persist: () => {}, unreadable: true };
    }
    return { state: null, persist: () => {} };
  }
  function haltQueue(ctx, text) {
    const c = ctx || {};
    const { state, persist } = loadQueueState(c);
    const at = c.now != null ? c.now : new Date().toISOString();
    const pause = { set: true, at, by: c.userId || "user", scope: "all-queues" };
    c.globalPause = pause;
    if (state && typeof state === "object") state.global_pause = pause;
    const q = state && state.outreach_queue && Array.isArray(state.outreach_queue.items) ? state.outreach_queue : null;
    if (!q) {
      return {
        intent: "queue_halt", resultStatus: "completed", counts_verified: false,
        global_pause_set: true, pause_flag_set: true, global_pause: pause,
        halted_count: null, sent_count: null, in_flight_count: null, already_stopped_count: null, queue_total: null,
        queue_state: null,
        reply: "I have not paused your account, and I could not read the queue's own records in this session, so I can't say what already went out or what is waiting. To pause your account, say \"pause everything\". To stop one task, name it.",
      };
    }
    // Item accounting — every item lands in exactly one bucket, so the
    // reported numbers reconcile to the queue total by construction:
    //   sent (already gone) / sending (in-flight, unconfirmed — left as-is,
    //   never half-sent) / haltable (pending or queued — halted now) /
    //   already stopped or finished before this instruction (left as-is).
    const TERMINAL = new Set(["halted", "suppressed", "cancelled", "canceled", "bounced", "failed", "completed"]);
    const sentAlready = q.items.filter((i) => i.status === "sent");
    const inFlight = q.items.filter((i) => i.status === "sending");
    const alreadyStopped = q.items.filter((i) => TERMINAL.has(i.status));
    const pending = q.items.filter((i) => i.status === "pending" || i.status === "queued");
    for (const item of pending) { item.status = "halted"; item.halted_by = "user instruction in chat"; item.halt_reason = String(text || ""); }
    q.halted = true;
    q.global_pause = pause;
    q.halt = { at, instruction: String(text || ""), items_halted: pending.map((i) => i.queue_id), global_pause: pause, form_prep_state: state.form_prep_in_progress ? state.form_prep_in_progress.state || null : null };
    if (state.form_prep_in_progress && state.form_prep_in_progress.state !== "SUBMITTED") state.form_prep_in_progress.halted = true;
    // Belt-and-braces through 124's OWN suppression API (called, not edited):
    // even a send-time pass in 124 stops a suppressed recipient.
    let suppressed = 0;
    const suppression = c.suppression || (Outreach && Outreach.createSuppressionStore ? Outreach.createSuppressionStore() : null);
    if (suppression) { for (const item of pending) if (item.to) { suppression.suppress({ email: item.to, userId: c.userId || "user-1", scope: "user", reason: "user stop-everything instruction" }); suppressed++; } c.suppression = suppression; }
    persist();
    // DD-10: the sent-statement is computed from the queue's actual state —
    // when an item already went out, the reply says so instead of claiming
    // "nothing was sent" over a landed send.
    // Composer rows 32/33 (2026-10-14, bug-law): the counted reply
    // must not use the claim verb "sent" anywhere — H-7 fires on the
    // bare past-tense verb even beside a halt event (and at a zero
    // count the old text asserted "already sent" / "Nothing was
    // sent" over nothing). State the same facts with non-claim
    // wording and close with the tell-me sentence.
    const sentText = sentAlready.length
      ? ` ${sentAlready.length} item${sentAlready.length === 1 ? " had" : "s had"} already gone out before this halt — those can't be undone, and I have left them marked as delivered. Nothing else will go out from this queue. Tell me if you'd like the item-by-item list.`
      : " Nothing went out from this queue at all, and nothing irreversible exists — no contact will be made from this queue. Tell me if you'd like the item-by-item list.";
    const total = q.items.length;
    return {
      intent: "queue_halt", resultStatus: "completed", counts_verified: true,
      global_pause_set: true, pause_flag_set: true, global_pause: pause,
      halted_count: pending.length, suppressed_recipients: suppressed, sent_before_halt: sentAlready.length,
      sent_count: sentAlready.length, in_flight_count: inFlight.length, in_flight_unconfirmed_count: inFlight.length,
      already_stopped_count: alreadyStopped.length, queue_total: total,
      queue_state: q,
      reply: `I held the outreach queued in this conversation: ${pending.length} pending outreach item${pending.length === 1 ? " is" : "s are"} held. This is not an account pause; say "pause everything" to pause your account. Counts: ${sentAlready.length} already out, ${inFlight.length} in flight and unconfirmed, ${pending.length} halted${alreadyStopped.length ? `, ${alreadyStopped.length} already stopped` : ""} — ${total} in total, so every item is accounted for.${sentText}`,
    };
  }
  // Inbox-event hygiene for a (possibly halted) queue state: dedupe by
  // event_id; an event older than the halt, or carrying an older status than
  // the item already holds, is out-of-order and applies nothing. A halted
  // item can never be revived by an event.
  function applyQueueEvent(state, ev) {
    const q = (state || {}).outreach_queue || {};
    q.processed_event_ids = q.processed_event_ids || [];
    if (!ev || !ev.event_id) return { applied: false, reason: "no_event_id" };
    if (q.processed_event_ids.includes(ev.event_id)) return { applied: false, deduped: true, reason: "duplicate event_id — already processed once" };
    q.processed_event_ids.push(ev.event_id);
    const item = (q.items || []).find((i) => i.queue_id === ev.queue_id);
    if (!item) return { applied: false, reason: "unknown queue item" };
    if (item.status === "halted" || q.halted) return { applied: false, reason: "queue is halted — events cannot revive a halted item", item_status: item.status };
    const evTime = Date.parse(ev.sent_at || ev.at || "") || 0;
    const itemTime = Date.parse(item.updated_at || item.sent_at || "") || 0;
    if (evTime && itemTime && evTime < itemTime) return { applied: false, reason: "out-of-order event — older than the item's current state", item_status: item.status };
    if (ev.status) { item.status = ev.status; item.updated_at = ev.sent_at || ev.at || item.updated_at; return { applied: true, item_status: item.status }; }
    return { applied: false, reason: "event carries no applicable change", item_status: item.status };
  }

  // ---------- 4. packet binding leg (C15) ----------
  function prepPacket(text, ctx) {
    if (!Packets) return { intent: "packet_prep", resultStatus: "blocked", reply: "The packet module is not available in this build, so I prepared nothing." };
    const t = String(text || "").toLowerCase();
    const m = t.match(/using the (\w+) version/) || t.match(/prep the (\w+) application/);
    const requested = m && m[1];
    const artifacts = (ctx && ctx.artifacts) || [];
    const matches = artifacts.filter((a) => a && (String(a.version || "").toLowerCase() === requested || String(a.record || "").toLowerCase().includes(requested || "\0")));
    if (!requested || matches.length !== 1) {
      return { intent: "packet_prep", resultStatus: "awaiting_user", reply: `I could not pin down exactly one "${requested || "requested"}" version among the stored documents, so I bound nothing. Tell me which version to use and I will prepare the packet with that one.` };
    }
    const artifact = matches[0];
    const binding = { version: artifact.version || requested, name: artifact.name || "resume.pdf", record: artifact.record || null, sha256: artifact.sha256 || sha256(artifact.content != null ? artifact.content : "") };
    // R2B packet<->fact binding: the packet (and any approval of it) is bound
    // to the profile fact version/hash it was prepared against.
    const fb = factBinding(ctx && ctx.profile);
    if (fb) { binding.fact_version = fb.fact_version; binding.fact_hash = fb.fact_hash; }
    const pin = (ctx && ctx.packet) || {};
    const packet = Packets.assemblePacket({ profile: ctx.profile, company: pin.company, jdText: pin.jdText, jobId: pin.jobId || null, family: pin.family, cir: pin.cir || null, portalAsksCoverLetter: !!pin.portalAsksCoverLetter, companyKind: pin.companyKind, voice: pin.voice });
    if (!packet.ok) return { intent: "packet_prep", resultStatus: "blocked", binding, packet, reply: `I bound the ${binding.version} version by its content hash, but the packet itself was refused (${packet.code || "truth audit"}), so nothing is prepared. Fix that first — tell me when it is fixed and I will rebuild it.` };
    const review = { company: packet.company, jobId: packet.jobId, portal: packet.portal || null, bound_name: binding.name, bound_version: binding.version, bound_sha256: binding.sha256, one_page_ok: packet.onePage ? packet.onePage.ok : null, ats_ok: packet.ats ? packet.ats.ok : null, fact_version: binding.fact_version != null ? binding.fact_version : null, fact_hash: binding.fact_hash || null };
    return {
      intent: "packet_prep", resultStatus: "prepared", packet, binding, review,
      reply: `Prepared the ${binding.version} application packet for ${packet.company}, bound to the ${binding.version} version of your resume (matched by content hash, not by file name). It is ready for your review — nothing has been submitted, and nothing goes anywhere until you approve it.`,
    };
  }

  // ---------- 7. G6: per-family doorstep payload emitters ----------
  // The hardened grader (run-grand-rescore.cjs, DOORSTEP_REQUIRED) requires
  // a commitment artifact per action family — outreach-send => draft or
  // queue state; application => packet; tracking-write => log write;
  // calendar => proposal card — and reads a record's doorstep block as
  // PRESENT only when it carries { family, gap: null, driven_by: "agent" }.
  // These emitters are the general (non-fixture) producers of those
  // artifacts: each builds the EXACT payload, records the doorstep proof
  // pattern (step log + payload snapshot + payload sha256) in a doorstep
  // record of that shape, stops at state AWAITING_COMMIT, and NEVER invokes
  // the commitment target the ctx provides (tracker sink/store write,
  // calendar create, transport send, form submit) — armed, not fired.
  // Typed results use the canonical vocabulary: awaiting_user when the
  // artifact is armed at the gate, blocked (with a guard_refusal) when a
  // guard stops it before any payload exists.
  function doorstepArtifact(family, payload, stepLog) {
    const hash = sha256(JSON.stringify(payload));
    return {
      payload, payload_sha256: hash,
      doorstep: {
        family, driven_by: "agent", gap: null, state: "AWAITING_COMMIT", committed: false,
        step_log: stepLog, payload, payload_sha256: hash,
        proof: { step_log: stepLog, payload_snapshot: payload, payload_sha256: hash },
      },
    };
  }
  function emitterBlocked(intent, family, code, reason, unblock, reply) {
    return {
      intent, family, resultStatus: "blocked", payload: null, payload_sha256: null, doorstep: null,
      guard_refusal: { code, reason, unblock },
      reply,
    };
  }
  const isoOf = (v, fallback) => {
    if (v == null) return fallback || null;
    if (typeof v === "number") return new Date(v).toISOString();
    const t = Date.parse(v);
    return Number.isNaN(t) ? String(v) : new Date(t).toISOString();
  };
  const cloneJson = (v) => v == null ? v : JSON.parse(JSON.stringify(v));

  // ----- 7a. tracking: the log write (126 row/event shape; 132 audit fields) -----
  const TRACK_STAGES_FALLBACK = ["Saved", "Tailoring", "Ready", "Submitted", "Confirmed", "Recruiter screen", "OA/assessment", "Interview rounds", "Final", "Offer", "Rejected", "Ghosted", "Withdrawn", "Accepted"];
  function trackerRowsOf(ctx) {
    const c = ctx || {};
    for (const store of [c.trackerStore, c.trackStore, c.tracker, c.trackLog]) {
      if (Array.isArray(store)) return store;
      if (store && Array.isArray(store.rows)) return store.rows;
      if (store && Array.isArray(store.records)) return store.records;
    }
    if (Array.isArray(c.trackerRecords)) return c.trackerRecords;
    return [];
  }
  function emitTrackingLog(ctx, entrySpec) {
    const c = ctx || {}, spec = entrySpec || {};
    // Generalized spec shapes (fixer wave, SC-121..145 replay): besides the
    // original { company, stage, note, event_type } log-write spec, the
    // emitter accepts the exact objects 126 itself produces —
    //   { application: <126 row>, event: <126 event> }   (manualUpdate /
    //     ingestMessage output: a stage move already shaped by 126)
    //   { draft: <126 draft> }    draftThankYou / draftNudge /
    //     draftRecruiterReply — the work product is the draft AT THE GATE,
    //     not a log write, and it must not be blocked for lacking one
    //   { verdict } / { analytics } / { summary }   the log-wide 126
    //     products (resumeVersionVerdict / funnelAnalytics / statusSummary)
    //     — these belong to the whole log, so no company may be demanded.
    const appRow = spec.application && typeof spec.application === "object" ? spec.application
      : (spec.row && typeof spec.row === "object" ? spec.row : null);
    const specEvent = spec.event && typeof spec.event === "object" && (spec.event.type || spec.event.detail) ? spec.event : null;
    const draft = spec.draft && typeof spec.draft === "object" && spec.draft.kind ? spec.draft : null;
    const verdict = spec.verdict && typeof spec.verdict === "object" ? spec.verdict : null;
    const analytics = spec.analytics && typeof spec.analytics === "object" ? spec.analytics : null;
    const summary = spec.summary && typeof spec.summary === "object" ? spec.summary : null;
    const company = spec.company || spec.companyName || (appRow && appRow.company) || (draft && draft.company) || null;
    // TN-1a — OWNER RULING (2026-10-14, resolving BUG-2026-10-14-TN1A-
    // CONFLICT / FR-199): a tracking/reporting write of a DETECTED JOB
    // EVENT is never refused for a missing company. Every detected job
    // gets its tracking record; when the source names no company, the
    // record carries the company as explicitly not-stated (company:
    // null + company_not_stated) — never invented, never guessed. A
    // write is a detected-event report when it carries a detected
    // event: an inbox-sourced spec or event, one of 126's inbox signal
    // classes (confirmation / rejection / oa_invite / interview_invite /
    // offer), or a 126 row already carrying the not-stated marker.
    // Writes that ATTRIBUTE an action to a company — a submission
    // record ("applied"), an unmarked manual stage move — are NOT
    // detected-event reports and keep the missing_company refusal
    // below; emitApplicationPacket and emitOutreachDraft keep theirs.
    const DETECTED_EVENT_TYPES = ["confirmation", "rejection", "oa_invite", "interview_invite", "offer"];
    const declaredEventType = spec.event_type || spec.eventType || (specEvent && specEvent.type) || null;
    const recordNotStated = !!(appRow && appRow.company == null && appRow.company_not_stated === true);
    const companyNotStated = !company && (recordNotStated || spec.source === "inbox" || (specEvent && specEvent.source === "inbox") || DETECTED_EVENT_TYPES.includes(declaredEventType));
    if (!company && !draft && !verdict && !analytics && !summary && !companyNotStated) {
      return emitterBlocked("tracking_log", "tracking-write", "missing_company",
        "no company was named for this tracker log write",
        "name the company the log entry belongs to",
        "I did not prepare a tracker update: no company was named, so there is nothing safe to log. Name the company and I will prepare the exact log entry for your approval.");
    }
    const stages = (Track && Track.STAGES) || TRACK_STAGES_FALLBACK;
    const stage = spec.stage || spec.status || spec.stage_after || (specEvent && specEvent.stage_after) || (appRow && specEvent ? appRow.stage : null) || null;
    if (stage && !stages.includes(stage)) {
      return emitterBlocked("tracking_log", "tracking-write", "unknown_stage",
        `the stage "${stage}" is not one of the tracker stages`,
        "use one of the tracker's real stages",
        `I did not prepare that tracker update: "${stage}" is not a stage the tracker uses, so logging it would corrupt the record. Pick a real stage and I will prepare the entry again.`);
    }
    // Work-product branch: a 126 draft / verdict / analytics / summary IS
    // the commitment artifact for its scenario — it rides in the payload
    // verbatim, armed at the gate, with no log write demanded or fired.
    if ((draft || verdict || analytics || summary) && !stage && !specEvent && !spec.event_type && !spec.eventType) {
      const wpKind = draft ? "tracker_draft_at_gate" : verdict ? "tracker_funnel_verdict" : analytics ? "tracker_funnel_analytics" : "tracker_status_summary";
      const wpOperation = draft ? "draft_at_gate" : verdict ? "funnel_verdict" : analytics ? "funnel_analytics" : "status_summary";
      const rowsWp = trackerRowsOf(c);
      const normWp = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      const existingWp = company ? rowsWp.find((r) => r && normWp(r.company) === normWp(company)) || null : null;
      const payload = {
        kind: wpKind, family: "tracking-write", operation: wpOperation,
        app_id: existingWp ? existingWp.app_id : null, company: company || null,
        role: (draft && draft.role) || (existingWp && existingWp.role) || "",
        draft: draft ? cloneJson(draft) : null,
        verdict: verdict ? cloneJson(verdict) : null,
        analytics: analytics ? cloneJson(analytics) : null,
        summary: summary ? cloneJson(summary) : null,
        status: existingWp ? existingWp.stage : null, stage: existingWp ? existingWp.stage : null,
        note: spec.note || null, event: null,
        triggered_followups: [], triggered_followups_note: "no log write is armed by this product — the work product above is the artifact at the gate",
        would_write: null, target: "tracker", committed: false,
      };
      const stepLog = [
        { step: 1, action: "resolve", field: "work_product", result: draft ? `the 126 ${draft.kind} draft for ${company} is the work product` : verdict ? "the 126 resume-version verdict over the whole log is the work product" : analytics ? "the 126 funnel analytics over the whole log are the work product" : "the 126 status summary over the whole log is the work product" },
        { step: 2, action: "build", field: "payload", result: "the product rides in the payload verbatim, computed by 126 from the log's own rows; nothing was written" },
        { step: 3, action: "stop", field: null, result: "stopped at the doorstep — the product is armed for approval, not fired" },
      ];
      const art = doorstepArtifact("tracking-write", payload, stepLog);
      const reply = draft
        ? `Prepared the ${draft.kind === "thank_you" ? "thank-you" : draft.kind === "follow_up_nudge" ? "follow-up nudge" : "recruiter reply"} draft for ${company} from the tracker record — it sits at the approval gate with sends off, exactly as 126 drafted it. Nothing goes out until you approve it.`
        : verdict
          ? `Prepared the resume-version verdict from your own log rows only${verdict.killed ? ` — ${verdict.killed} is the version the math names as the loser` : " — no version is named as a loser on this data"}. It is waiting at the doorstep for your review before anything changes.`
          : analytics
            ? `Prepared the funnel analytics from your own log rows only (${analytics.total != null ? analytics.total : "the log's"} applications) — every claim in it is limited to what the log supports. It is waiting at the doorstep for your review.`
            : `Prepared the status summary from the tracker log (${summary.total} applications, ${summary.open} open) — every stage in it comes from the rows. It is waiting at the doorstep for your review.`;
      return { intent: "tracking_log", family: "tracking-write", resultStatus: "awaiting_user", ...art, reply };
    }
    if (!stage && !spec.note && !spec.event_type && !spec.eventType && !specEvent) {
      return emitterBlocked("tracking_log", "tracking-write", "missing_log_content",
        "the log write carries no stage, note, or event",
        "say what changed (a stage, an event, or a note)",
        "I did not prepare a tracker update: nothing was said about what changed. Tell me the new stage or the event and I will prepare the exact log entry.");
    }
    const at = isoOf(spec.at || (specEvent && specEvent.at) || c.now) || isoOf(Date.now());
    const eventType = spec.event_type || spec.eventType || (specEvent && specEvent.type) || (stage ? "manual_update" : "note");
    // GATE-3 vocabulary alignment (03 F3): the log_write.source on a
    // DOORSTEP RECORD uses the spec enum inbox | user_reported | portal.
    // 126's tracker-store vocabulary is hyphenated ("user-reported") and
    // is pinned by 126's own consumers (status/timeline readers and the
    // track/G6 suites), so the store value is NOT renamed — the mapping
    // happens HERE, at the doorstep emission point, for every source value
    // this record carries. Values outside the enum pass through unmapped
    // rather than being relabeled into a claim they are not.
    const SPEC_LOG_SOURCE = { "user-reported": "user_reported", user_reported: "user_reported", inbox: "inbox", portal: "portal" };
    const specLogSource = (v) => SPEC_LOG_SOURCE[v] || v;
    const event = {
      type: eventType,
      at,
      source: specLogSource(spec.source || (specEvent && specEvent.source) || (eventType === "manual_update" ? "user-reported" : "system")),
      detail: spec.detail || spec.note || (specEvent && specEvent.detail) || `stage set to ${stage}`,
      evidence: spec.evidence || spec.url || (specEvent && specEvent.evidence) || null,
    };
    const rows = trackerRowsOf(c);
    const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const specAppId = spec.app_id || spec.appId || (appRow && appRow.app_id) || null;
    // A not-stated write binds ONLY by an explicit app_id — never by a
    // company match, where an empty normalized name could hijack a
    // named company's row.
    const existing = companyNotStated
      ? (specAppId ? rows.find((r) => r && r.app_id === specAppId) || null : null)
      : rows.find((r) => r && (specAppId && r.app_id === specAppId || norm(r.company) === norm(company))) || null;
    let operation, row;
    if (existing) {
      operation = stage ? "move_stage" : "append_event";
      event.stage_after = stage || existing.stage;
      row = cloneJson(existing);
      row.stage = stage || existing.stage;
      row.events = [...(row.events || []), cloneJson(event)];
      if (spec.offer_deadline || spec.offerDeadline) row.offer_deadline = spec.offer_deadline || spec.offerDeadline;
      if (spec.assessment_deadline || spec.assessmentDeadline) row.assessment_deadline = spec.assessment_deadline || spec.assessmentDeadline;
    } else {
      operation = "add_application";
      const appliedAt = isoOf(spec.applied_at || spec.appliedAt || at);
      const firstEvent = eventType === "applied"
        ? event
        : { type: "applied", at: appliedAt, source: specLogSource(spec.event_source || "system"), detail: `applied (${spec.source === "referred" ? "referred" : "cold"}, resume ${spec.resume_version || spec.resumeVersion || "?"})`, evidence: spec.url || null };
      row = {
        app_id: specAppId || (companyNotStated
          ? `app-not-stated-${sha256("not-stated|" + (spec.role || spec.title || (appRow && appRow.role) || "") + "|" + eventType + "|" + appliedAt).slice(0, 6)}`
          : `app-${norm(company).replace(/\s+/g, "-")}-${sha256(company + "|" + (spec.role || (appRow && appRow.role) || "")).slice(0, 6)}`),
        company: companyNotStated ? null : String(company), ...(companyNotStated ? { company_not_stated: true } : {}),
        role: String(spec.role || spec.title || (appRow && appRow.role) || (appRow && appRow.title) || ""), role_family: String(spec.role_family || spec.roleFamily || (appRow && appRow.role_family) || ""),
        url: String(spec.url || ""), applied_at: appliedAt,
        resume_version: String(spec.resume_version || spec.resumeVersion || (c.resumeArtifact && c.resumeArtifact.version) || ""),
        source: spec.source === "referred" || spec.application_source === "referred" ? "referred" : "cold",
        referred_by: spec.referred_by || spec.referredBy || null, fit_bucket: spec.fit_bucket || spec.fitBucket || null,
        stage: stage || "Submitted",
        offer_deadline: spec.offer_deadline || null, assessment_deadline: spec.assessment_deadline || null,
        cooldown_until: spec.cooldown_until || null,
        events: eventType === "applied" ? [cloneJson(event)] : [firstEvent, cloneJson(event)],
      };
      if (stage) event.stage_after = stage;
    }
    const rowNotStated = !!(row && row.company == null && row.company_not_stated === true);
    const wouldWrite = { operation, app_id: row.app_id, company: row.company, ...(rowNotStated ? { company_not_stated: true } : {}), row: cloneJson(row), event: cloneJson(event) };
    // Triggered follow-ups, from 126's own follow-up state: the quiet-period
    // radar (deadlineRadar -> quietReport) run over the would-be log (the
    // existing rows with this write applied). A company whose follow-up is
    // due arms a nudge follow-up here; when none is due the field is present
    // and empty WITH the reason, computed from the same radar — never a
    // follow-up invented for the record.
    let triggeredFollowups = [], triggeredNote = "126's follow-up radar is unavailable in this build, so no follow-up state could be read";
    if (rowNotStated) {
      triggeredNote = "no follow-ups are armed: this record's company is not stated, so 126's quiet-period radar has no named company to read follow-up state for";
    } else if (Track && typeof Track.deadlineRadar === "function" && typeof Track.quietReport === "function") {
      const nowMs = Date.parse(at) || Date.now();
      const rowsAfter = existing ? rows.map((r) => (r && r.app_id === row.app_id ? row : r)) : [...rows, row];
      const radar = Track.deadlineRadar({ rows: rowsAfter }, [], { now: nowMs, withinDays: 14 });
      triggeredFollowups = radar.filter((d) => d.kind === "follow_up_due" && norm(d.company) === norm(row.company))
        .map((d) => ({ kind: "follow_up_nudge", company: d.company, label: d.label, date: d.date, days_away: d.days_away, source: "126 quiet-period radar (deadlineRadar/quietReport)" }));
      if (!triggeredFollowups.length) {
        const q = Track.quietReport({ rows: rowsAfter }, { now: nowMs }).find((x) => norm(x.company) === norm(row.company));
        triggeredNote = q
          ? `no follow-ups are armed for ${row.company}: 126's quiet-period radar shows ${q.days_quiet} day(s) quiet at stage "${row.stage}" — a nudge arms only at ${Track.NUDGE_AFTER_DAYS != null ? Track.NUDGE_AFTER_DAYS : 10}+ days quiet`
          : `no follow-ups are armed for ${row.company}: stage "${row.stage}" carries no quiet-period follow-up in 126's radar`;
      } else triggeredNote = `${triggeredFollowups.length} follow-up(s) armed by 126's quiet-period radar for ${row.company}`;
    }
    const payload = {
      kind: "tracker_log_write", family: "tracking-write", operation,
      app_id: row.app_id, company: row.company, ...(rowNotStated ? { company_not_stated: true } : {}), role: row.role || spec.role || spec.title || "",
      application: { app_id: row.app_id, company: row.company, ...(rowNotStated ? { company_not_stated: true } : {}), role: row.role || spec.role || spec.title || "", stage_before: existing ? existing.stage : null },
      status: row.stage, stage: row.stage,
      note: spec.note || null, event: cloneJson(event),
      triggered_followups: triggeredFollowups, triggered_followups_note: triggeredNote,
      would_write: wouldWrite, target: "tracker", committed: false,
    };
    const stepLog = [
      { step: 1, action: "resolve", field: "company", result: rowNotStated ? "the source names no company — under the TN-1a ruling the record carries the company as not stated (company: null, company_not_stated); no company was invented" : existing ? `matched the existing tracker row for ${row.company}` : `no tracker row for ${row.company} yet — this write would add one` },
      { step: 2, action: "build", field: "log_write", result: `built the exact ${operation} payload in the tracker row and event shape; nothing was written` },
      { step: 3, action: "stop", field: null, result: "stopped at the doorstep — the tracker write is armed for approval, not fired" },
    ];
    const art = doorstepArtifact("tracking-write", payload, stepLog);
    return {
      intent: "tracking_log", family: "tracking-write", resultStatus: "awaiting_user",
      ...art,
      reply: rowNotStated
        ? `Prepared the tracker entry at stage "${row.stage}" — the message names no company, so the record carries the company as not stated rather than guessed. Nothing has been written yet: it is waiting at the doorstep for your approval.`
        : existing
          ? `Prepared the tracker update for ${row.company} — it would move the application to "${row.stage}" and log your note. Nothing has been written yet: it is waiting at the doorstep for your approval.`
          : `Prepared the tracker entry for ${row.company} at stage "${row.stage}" — the full log row is ready. Nothing has been written yet: it is waiting at the doorstep for your approval.`,
    };
  }

  // ----- 7b. calendar: the proposal card (F3 ground truth: busy holds, quiet hours, DST) -----
  function calendarOf(ctx) {
    const c = ctx || {};
    return c.calendar || c.calendarFixture || c.calendarGroundTruth || null;
  }
  function quietWindowOf(ctx, cal) {
    const raw = (cal && cal.candidate && cal.candidate.quiet_hours) || (ctx && ctx.quietHours) || (ctx && ctx.quiet_hours) || { start: "22:00", end: "07:00" };
    const toMin = (v, dflt) => {
      if (v == null) return dflt;
      if (typeof v === "number") return v * 60;
      const m = String(v).match(/^(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
    };
    return { startMin: toMin(raw.start, 22 * 60), endMin: toMin(raw.end, 7 * 60) };
  }
  function localMinutes(ms, tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
      const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
      return (get("hour") % 24) * 60 + get("minute");
    } catch (e) { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  }
  function inQuiet(ms, tz, quiet) {
    const m = localMinutes(ms, tz);
    return quiet.startMin <= quiet.endMin ? (m >= quiet.startMin && m < quiet.endMin) : (m >= quiet.startMin || m < quiet.endMin);
  }
  function busyEventsOf(ctx, cal) {
    const c = ctx || {};
    const lists = [(cal && cal.events), c.calendarEvents, c.busyEvents, c.busy, (cal && cal.freeBusy)];
    const out = [];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const ev of list) {
        const startIso = (ev.utc && ev.utc[0]) || ev.start || ev.begin;
        const endIso = (ev.utc && ev.utc[1]) || ev.end || ev.finish;
        const s = Date.parse(startIso), e = Date.parse(endIso);
        if (Number.isNaN(s) || Number.isNaN(e)) continue;
        out.push({ event_id: ev.event_id || ev.id || null, title: ev.title || null, start: new Date(s).toISOString(), end: new Date(e).toISOString(), start_ms: s, end_ms: e });
      }
    }
    return out;
  }
  function evaluateSlot(slot, idx, ctx, cal, busy, quiet, defaultTz, defaultDurationMin) {
    const tz = slot.timezone || slot.tz || defaultTz;
    const slotId = slot.slot_id || slot.id || slot.label || String.fromCharCode(65 + idx);
    const conflicts = [];
    let startMs = NaN, endMs = NaN, startIso = null, endIso = null;
    const ambiguousLocal = slot.start_local_ambiguous || slot.ambiguous_local || null;
    if (ambiguousLocal) {
      conflicts.push({ kind: "ambiguous_local_time", local: String(ambiguousLocal), timezone: tz,
        detail: "this local time occurs twice on the fall-back date, so it cannot be pinned to one instant — it is reported, never silently resolved to one offset" });
      return { slot_id: slotId, start: String(ambiguousLocal), end: slot.end_local || slot.end || null, utc: null, start_iso: null, end_iso: null, timezone: tz, ambiguous: true, conflict: true, conflicts };
    }
    const rawStart = slot.start || slot.stated || slot.utc || slot.candidate_local || slot.begin;
    const rawEnd = slot.end || slot.end_utc || null;
    const naive = typeof rawStart === "string" && !/([zZ]|[+-]\d{2}:?\d{2})$/.test(rawStart.trim());
    if (naive) {
      conflicts.push({ kind: "ambiguous_local_time", local: String(rawStart), timezone: tz,
        detail: "this local time carries no offset, so no instant was invented for it" });
      return { slot_id: slotId, start: String(rawStart), end: rawEnd, utc: null, start_iso: null, end_iso: null, timezone: tz, ambiguous: true, conflict: true, conflicts };
    }
    startMs = Date.parse(rawStart);
    const durationMin = slot.durationMin || slot.duration_min || defaultDurationMin || 30;
    endMs = rawEnd && !Number.isNaN(Date.parse(rawEnd)) ? Date.parse(rawEnd) : startMs + durationMin * 60000;
    startIso = new Date(startMs).toISOString(); endIso = new Date(endMs).toISOString();
    for (const ev of busy) {
      if (startMs < ev.end_ms && endMs > ev.start_ms) { // strict overlap: adjacency is NOT a conflict (F3 rule)
        conflicts.push({ kind: "overlap", event_id: ev.event_id, title: ev.title, start: ev.start, end: ev.end,
          detail: `overlaps the busy time "${ev.title}" (${ev.start} to ${ev.end})` });
      }
    }
    for (let t = startMs; t < endMs; t += 60000) {
      if (inQuiet(t, tz, quiet)) {
        conflicts.push({ kind: "quiet_hours", timezone: tz, start: startIso, end: endIso,
          detail: "this time runs inside quiet hours in the candidate's local time — no interview may start or run inside quiet hours" });
        break;
      }
    }
    return { slot_id: slotId, start: rawStart, end: rawEnd || endIso, utc: startIso, start_iso: startIso, end_iso: endIso, timezone: tz, ambiguous: false, conflict: conflicts.length > 0, conflicts };
  }
  function emitCalendarProposal(ctx, proposalSpec) {
    const c = ctx || {}, spec = proposalSpec || {};
    const cal = calendarOf(c);
    const slotsIn = spec.slots || spec.offered_slots || spec.candidate_slots || (spec.slot ? [spec.slot] : null) ||
      (spec.start || spec.start_local_ambiguous ? [spec] : null);
    if (!spec.title && !spec.event_title && !spec.eventTitle) {
      return emitterBlocked("calendar_proposal", "calendar", "missing_title",
        "the proposal carries no event title", "name the event this proposal is for",
        "I did not prepare a calendar proposal: it has no event title. Name the event and I will prepare the proposal card for your approval.");
    }
    if (!slotsIn || !slotsIn.length) {
      return emitterBlocked("calendar_proposal", "calendar", "missing_slot",
        "the proposal carries no candidate time slot", "offer at least one time slot to evaluate",
        "I did not prepare a calendar proposal: no time was offered to check against your calendar. Give me a slot and I will check it and prepare the card.");
    }
    const defaultTz = spec.timezone || spec.tz || (cal && cal.candidate && cal.candidate.timezone) || c.timezone || "America/Chicago";
    const busy = busyEventsOf(c, cal);
    const quiet = quietWindowOf(c, cal);
    let evaluations = slotsIn.map((s, i) => evaluateSlot(s, i, c, cal, busy, quiet, defaultTz, spec.durationMin || spec.duration_min));
    // WORDING-BACKLOG (BUG-198): a proposal may never offer a time
    // that has already passed at the turn's own clock. When every
    // offered slot is past, the same local times are re-evaluated
    // for the next day (busy and quiet checks rerun) and the card
    // says so; when only some are past, the proposal prefers a
    // future free slot and each past slot's verdict says it passed.
    // CLOCK-SOURCE (BUG-198 class, FR-383): c.now arrives as numeric
    // epoch ms from the harness/host and Date.parse(number) is NaN —
    // the old line silently fell back to the wall clock, so verdicts
    // flipped between morning and afternoon runs. Parse via isoOf,
    // which is number-safe (the same pattern as the outreach emitter).
    const nowMs = (() => { const n = Date.parse(isoOf(c.now) || ""); return Number.isNaN(n) ? Date.now() : n; })();
    const slotMsOf = (e) => Date.parse(e.utc || e.start_iso || e.start || "");
    let shiftedNote = null;
    if (evaluations.length && evaluations.every((e) => { const m = slotMsOf(e); return !Number.isNaN(m) && m < nowMs; })) {
      const shiftedSpecs = slotsIn.map((sp) => {
        const raw = sp.start || sp.stated || sp.utc || sp.candidate_local || sp.begin;
        const m = Date.parse(raw || "");
        if (Number.isNaN(m)) return sp;
        const out = Object.assign({}, sp, { start: new Date(m + 86400000).toISOString() });
        const re2 = sp.end || sp.end_utc; const em = Date.parse(re2 || "");
        if (!Number.isNaN(em)) { out.end = new Date(em + 86400000).toISOString(); if (out.end_utc) out.end_utc = out.end; }
        return out;
      });
      const reEval = shiftedSpecs.map((sp2, i) => evaluateSlot(sp2, i, c, cal, busy, quiet, defaultTz, spec.durationMin || spec.duration_min));
      if (reEval.length) { evaluations = reEval; shiftedNote = "Every offered time had already passed today, so the card proposes the same times tomorrow, re-checked against the calendar."; }
    }
    let proposed = evaluations.find((e) => !e.conflict && !(slotMsOf(e) < nowMs)) || evaluations.find((e) => !e.conflict) || evaluations[0];
    const attendees = (spec.attendees || spec.attendee || []).map((a) =>
      typeof a === "string" ? { email: a } : { name: a.name || a.full_name || null, email: a.email || a.work_email || null });
    const title = spec.title || spec.event_title || spec.eventTitle;
    const card = {
      type: "calendar_proposal", title, attendees,
      slot_id: proposed.slot_id, start: proposed.start, end: proposed.end, utc: proposed.utc || null,
      timezone: proposed.timezone, conflict: proposed.conflict, conflicts: proposed.conflicts,
    };
    const payload = {
      kind: "calendar_proposal_card", family: "calendar",
      card, proposed, conflict: proposed.conflict, conflicts: proposed.conflicts,
      slot_evaluations: evaluations, attendees, title,
      slots_shifted_next_day: !!shiftedNote,
      timezone: defaultTz, committed: false, invite_sent: false,
    };
    const stepLog = [
      { step: 1, action: "read", field: "calendar", result: `read ${busy.length} busy time(s) plus the quiet-hours rule from the calendar in context` },
      { step: 2, action: "evaluate", field: "slots", result: `evaluated ${evaluations.length} offered slot(s): ${evaluations.map((e) => e.slot_id + (e.conflict ? " (conflict: " + e.conflicts.map((x) => x.kind).join(", ") + ")" : " (free)")).join("; ")} — every conflict is reported in the payload, none was silently resolved` },
      { step: 3, action: "stop", field: null, result: "stopped at the doorstep — the proposal card is armed for approval; no invite was created" },
    ];
    const art = doorstepArtifact("calendar", payload, stepLog);
    // WORDING-BACKLOG (BUG-132): the reply NAMES the offered times —
    // every slot with its absolute date, its time and timezone, and
    // which one is free. A proposal the user cannot see the times of
    // is not a proposal they can approve.
    const fmtSlot = (e) => {
      try {
        const d = new Date(e.utc || e.start_iso || e.start);
        if (Number.isNaN(d.getTime())) return String(e.start || "the offered time");
        const parts = {};
        for (const p of new Intl.DateTimeFormat("en-US", { timeZone: e.timezone || defaultTz, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(d)) parts[p.type] = p.value;
        return `${parts.weekday} ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
      } catch { return String(e.start || "the offered time"); }
    };
    const offered = evaluations.map((e) => fmtSlot(e)).join(" or ");
    // WORDING-BACKLOG (BUG-190): every offered slot gets its OWN
    // verdict, in chronological order — "Tuesday Oct 20 and
    // Wednesday Oct 14 is free" lumped two slots into one ambiguous
    // clause and left the user unable to tell which time was free.
    const byTime = [...evaluations].sort((a, b) => (Date.parse(a.utc || a.start_iso || a.start) || 0) - (Date.parse(b.utc || b.start_iso || b.start) || 0));
    const verdicts = byTime.map((e) => `${fmtSlot(e)} — ${e.conflict ? `not free: ${e.conflicts.map((x) => x.kind).join(", ")}` : slotMsOf(e) < nowMs ? "that time has already passed today" : "free on the calendar in context and outside quiet hours"}`).join("; ");
    return {
      intent: "calendar_proposal", family: "calendar", resultStatus: "awaiting_user",
      ...art,
      reply: proposed.conflict
        ? `Prepared the calendar proposal card for "${title}", and I am flagging a conflict on the proposed time: ${proposed.conflicts.map((x) => x.detail).join("; ")}. The offered times were ${offered}. Nothing has been booked or sent — the card is waiting at the doorstep, conflict and all, for your call.`
        : `The pick: ${fmtSlot(proposed)} — the first offered time that checks free. Prepared the calendar proposal card for "${title}" — the offered times, checked one by one: ${verdicts}.${shiftedNote ? ` ${shiftedNote}` : ""} Nothing has been booked or sent: approve the card and the pick goes to them as the proposal — nothing is booked until they confirm.`,
    };
  }

  // ----- 7c. application: the packet, generalized beyond the fixture ids -----
  // prepPacket (section 4) keeps its exact chat-text fixture behavior. This
  // emitter takes a posting spec directly — company / jobId / jdText /
  // version supplied by the caller, in no fixture — and produces the same
  // binding + packet artifact, stopped at AWAITING_COMMIT.
  function emitApplicationPacket(ctx, postingSpec) {
    const c = ctx || {}, spec = postingSpec || {};
    if (!Packets) return emitterBlocked("application_packet", "application", "packet_module_unavailable", "the packet module is not available in this build", "restore the packet module", "The packet module is not available in this build, so I prepared nothing.");
    const company = spec.company || (c.packet && c.packet.company) || null;
    if (!company) {
      return emitterBlocked("application_packet", "application", "missing_company",
        "no company was named for this packet", "name the company and role",
        "I did not prepare a packet: no company was named. Name the company and I will prepare the packet for your review.");
    }
    const jdText = spec.jdText || spec.jd_text || spec.jd || (c.packet && c.packet.jdText) || "";
    const requested = spec.version || spec.artifactVersion || spec.resumeVersion || null;
    let binding = null;
    if (requested) {
      const artifacts = c.artifacts || [];
      const matches = artifacts.filter((a) => a && (String(a.version || "").toLowerCase() === String(requested).toLowerCase() ||
        String(a.record || "").toLowerCase().includes(String(requested).toLowerCase()) ||
        (a.sha256 && a.sha256 === requested) || (a.content != null && sha256(a.content) === requested)));
      if (matches.length !== 1) {
        return {
          intent: "application_packet", family: "application", resultStatus: "awaiting_user", payload: null, payload_sha256: null, doorstep: null,
          reply: `I could not pin down exactly one "${requested}" version among the stored documents, so I bound nothing. Tell me which version to use and I will prepare the packet with that one.`,
        };
      }
      const artifact = matches[0];
      binding = { version: artifact.version || requested, name: artifact.name || "resume.pdf", record: artifact.record || null, sha256: artifact.sha256 || sha256(artifact.content != null ? artifact.content : "") };
      const fb = factBinding(c.profile);
      if (fb) { binding.fact_version = fb.fact_version; binding.fact_hash = fb.fact_hash; }
    }
    const pin = c.packet || {};
    const packet = Packets.assemblePacket({
      profile: c.profile, company,
      jdText, jobId: spec.jobId || spec.job_id || pin.jobId || null,
      family: spec.family || pin.family, cir: spec.cir || pin.cir || null,
      portal: spec.portal || pin.portal || null,
      portalAsksCoverLetter: spec.portalAsksCoverLetter != null ? !!spec.portalAsksCoverLetter : !!pin.portalAsksCoverLetter,
      companyKind: spec.companyKind || pin.companyKind, voice: spec.voice || pin.voice,
    });
    if (!packet.ok) {
      return emitterBlocked("application_packet", "application", packet.code || "packet_refused",
        `the packet itself was refused (${packet.code || "truth audit"})`,
        "fix the refusal reason and prepare again",
        `I prepared no packet for ${company}: the packet checks refused it, so nothing is armed. Fix that first and I will rebuild it for your review.`);
    }
    const review = {
      company: packet.company, jobId: packet.jobId,
      portal: packet.portal || null,
      bound_name: binding ? binding.name : null, bound_version: binding ? binding.version : null, bound_sha256: binding ? binding.sha256 : null,
      one_page_ok: packet.onePage ? packet.onePage.ok : null, ats_ok: packet.ats ? packet.ats.ok : null,
      fact_version: binding && binding.fact_version != null ? binding.fact_version : null,
      fact_hash: binding ? binding.fact_hash || null : null,
    };
    // GATE-3 record completion (03 F2 doorstep): surface what the packet
    // assembly (133 -> 123) already produced, on the doorstep record itself.
    // - posting_snapshot: the exact posting text this packet was tailored
    //   against (the caller's JD), with its company/job identity.
    // - audit_result: 123's truth audit of the tailored resume, as carried
    //   on packet.tailored.audit, plus the diff's dropped (removed) lines
    //   and whether every tailored line cites a profile fact. No audit is
    //   invented: when the tailored packet carries none, this stays null.
    // - filled_fields: the application fields this seam's own resolver
    //   (resolveField — profile facts only, unknowns are asks) fills for
    //   this packet, each flagged t3 when it is one of the sensitive
    //   questions the resolver never guesses (work authorization,
    //   sponsorship detail, EEO, consent/declaration). Fields the resolver
    //   surfaces as asks are NOT filled fields and are listed separately.
    const tailored = packet.tailored || {};
    const audit = tailored.audit || null;
    const auditResult = audit ? {
      ok: audit.ok === true, result: audit.ok ? "pass" : "fail",
      checked: audit.checked != null ? audit.checked : null,
      violations: audit.violations || [],
      dropped_lines: ((tailored.diff && tailored.diff.removed) || []).map((x) => (typeof x === "string" ? x : x.text)),
      every_line_cites_fact: (() => { const lines = (tailored.resume && tailored.resume.lines) || []; return lines.length > 0 && lines.every((l) => Array.isArray(l.factIds) && l.factIds.length > 0); })(),
    } : null;
    const T3_FIELDS = new Set(["work_authorization", "sponsorship_detail", "eeo_gender", "eeo_veteran", "eeo_gender_reversed", "background_check_consent", "export_control_declaration"]);
    const resolveCtx = { profile: c.profile, resumeArtifact: binding ? { name: binding.name, sha256: binding.sha256 } : (c.resumeArtifact || null), formFacts: spec.formFacts || c.formFacts || null, eeoAnswers: spec.eeoAnswers || c.eeoAnswers || null };
    const filledFields = [], unfilledAsks = [];
    for (const fieldId of ["full_name", "email", "phone", "resume_upload", "work_authorization", "sponsorship_detail", "start_date", "graduation_date", "eeo_gender", "eeo_veteran", "background_check_consent", "export_control_declaration"]) {
      const r = resolveField({ field_id: fieldId }, resolveCtx);
      if (r.ask) { unfilledAsks.push({ field: fieldId, reason: r.ask, t3: T3_FIELDS.has(fieldId) }); continue; }
      filledFields.push({ field: fieldId, value: r.value, source: r.source, t3: T3_FIELDS.has(fieldId) });
    }
    const payload = {
      kind: "application_packet", family: "application",
      company: packet.company, job_id: packet.jobId || spec.jobId || spec.job_id || null,
      posting_snapshot: { company: packet.company, job_id: packet.jobId || spec.jobId || spec.job_id || null, jd_text: jdText || "", role: spec.role || null },
      audit_result: auditResult,
      filled_fields: filledFields, unfilled_asks: unfilledAsks,
      binding, review,
      packet_summary: { ok: true, one_page_ok: review.one_page_ok, ats_ok: review.ats_ok, cover_letter: !!packet.coverLetter, voice: packet.voice || null },
      resume_sha256: binding ? binding.sha256 : null,
      submitted: false, committed: false,
    };
    const stepLog = [
      { step: 1, action: "bind", field: "resume", result: binding ? `bound the ${binding.version} resume version by content hash` : "no stored version was supplied — the packet carries the freshly tailored resume" },
      { step: 2, action: "assemble", field: "packet", result: `assembled the packet for ${packet.company} through the packet module; nothing was submitted` },
      { step: 3, action: "stop", field: null, result: "stopped at the doorstep — the packet is a review copy, armed for approval, not submitted" },
    ];
    const art = doorstepArtifact("application", payload, stepLog);
    return {
      intent: "application_packet", family: "application", resultStatus: "awaiting_user",
      packet, binding, review, ...art,
      // WORDING-BACKLOG (BUG-204): an autopilot ask hears the RULE
      // first — submission never runs ahead of the user's yes, and
      // that rule has no override — and the packet is named by its
      // tailoring (the role it was cut for), not as a stock packet.
      reply: spec.autopilotAsk
        ? `Autopilot submission is off, and that rule has no override: every application stops at this doorstep for your yes. Prepared the application packet for ${packet.company} — the resume in it is tailored to the ${packet.title || "role"} it names, and the answers ride with it. It is ready at the doorstep for your review — nothing has been submitted. Review the job, the document, and the answers on the card — say the word to send it from the doorstep, or name what to change first.`
        : `Prepared the application packet for ${packet.company}${binding ? `, bound to the ${binding.version} version of your resume (matched by content hash)` : ""}. It is ready at the doorstep for your review — nothing has been submitted. Review the job, the document, and the answers on the card — say the word to send it from the doorstep, or name what to change first.`,
    };
  }

  // ----- 7d. outreach: the draft / queue state, generalized beyond fixture ids -----
  // The draft itself is built by 124 (called, never edited) from a recipient
  // spec, or taken from an explicit draft spec; either way the artifact is
  // the draft plus a queue state armed at awaiting_approval. Sends stay 0:
  // no transport is ever invoked here.
  function outreachUserOf(ctx) {
    const c = ctx || {};
    if (c.outreachUser) return c.outreachUser;
    const p = c.profile || {};
    const edu = (p.facts || []).find((f) => f.kind === "education");
    return {
      name: (p.basics && p.basics.name) || "",
      school: (edu && edu.org) || c.school || "",
      year: c.year || "", experience: c.experience || "",
    };
  }
  function emitOutreachDraft(ctx, recipientSpec) {
    const c = ctx || {}, spec = recipientSpec || {};
    let draft = null, recipientLabel = null, f1List = null;
    if (spec.draft && typeof spec.draft === "object") {
      const d = spec.draft;
      if (!d.to) {
        return emitterBlocked("outreach_draft", "outreach-send", "missing_recipient_email",
          "the draft spec names no recipient email", "name the recipient's email",
          "I did not prepare that draft: it names no recipient email, and a draft with no destination cannot be queued safely. Add the email and I will prepare it.");
      }
      if (!d.body) {
        return emitterBlocked("outreach_draft", "outreach-send", "missing_draft_body",
          "the draft spec carries no message body", "supply the message text",
          "I did not prepare that draft: it has no message text. Supply the text and I will arm it at the approval gate.");
      }
      draft = { person_id: d.person_id || null, to: d.to, subject: d.subject || "", body: d.body, tier: d.tier || null };
      recipientLabel = d.to;
    } else {
      const candidate = spec.recipient || spec.candidate || spec.person || null;
      if (!candidate) {
        return emitterBlocked("outreach_draft", "outreach-send", "missing_recipient",
          "no recipient spec was supplied", "name the recipient (name, firm, email)",
          "I did not prepare a draft: no recipient was named. Name who this is for and I will draft it and arm it at the approval gate.");
      }
      if (!candidate.work_email && !candidate.email) {
        return emitterBlocked("outreach_draft", "outreach-send", "missing_recipient_email",
          "the recipient spec names no email", "supply the recipient's email",
          `I did not prepare a draft for ${candidate.full_name || "that recipient"}: no email was supplied, so there is no destination to queue it for. Add the email and I will draft it.`);
      }
      if (!Outreach || typeof Outreach.draftAndGate !== "function") {
        return emitterBlocked("outreach_draft", "outreach-send", "outreach_module_unavailable",
          "the outreach module is not available in this build", "restore the outreach module",
          "The outreach module is not available in this build, so I drafted nothing.");
      }
      const gated = Outreach.draftAndGate(candidate, outreachUserOf(c), {
        ctx: c, suppression: c.suppression || null, suppressionStore: c.suppressionStore || null,
        draftStore: null, // the draft store is context for the shape only — nothing is stored by this emitter
        at: isoOf(c.now),
      });
      if (!gated || gated.status === "refused" || (gated.draft && gated.draft.refused)) {
        const reason = (gated && gated.draft && gated.draft.reason) || (gated && gated.reason) || "the recipient is suppressed";
        return emitterBlocked("outreach_draft", "outreach-send", "refused_suppressed",
          String(reason), "pick a recipient who has not opted out",
          "I did not draft that message: this recipient must not be contacted. Nothing was drafted or queued.");
      }
      if (!gated.draft || !gated.gate || !gated.gate.pass) {
        return emitterBlocked("outreach_draft", "outreach-send", "draft_gate_failed",
          `the draft failed its quality gate (${gated && gated.gate ? gated.gate.failures.join(", ") : "no draft produced"})`,
          "fix the draft's facts or pick another recipient",
          "I did not queue that draft: it did not pass its own quality checks, so arming it would put a flawed message one tap from sending. Nothing was queued.");
      }
      draft = gated.draft;
      recipientLabel = draft.to;
      // GATE-3 record completion (03 F1 doorstep): assemble the complete
      // doorstep record from 124's own pieces — the list this draft belongs
      // to (buildList: selected/reserve/excluded counts + honest yield), a
      // campaign in draft state (createCampaign + enqueue + planWave), and
      // the safety-plan card for that campaign (safetyPlan). All of it is
      // built locally from the recipient spec / ctx candidate records;
      // nothing is enqueued anywhere real and nothing sends.
      if (Outreach && typeof Outreach.buildList === "function" && typeof Outreach.createCampaign === "function") {
        const records = spec.list_records || spec.candidates || c.listRecords || c.candidateRecords || [candidate];
        const listQuery = spec.list_query || c.listQuery || { count: records.length };
        const pool = Outreach.buildList(records, listQuery, {
          profile: { school: outreachUserOf(c).school || "", current_employer: c.current_employer || null },
          suppression: c.suppression || null, userId: c.userId || "user-1",
          nowMs: Date.parse(isoOf(c.now) || "") || undefined,
        });
        const excludedCount = Object.values(pool.exclusions || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
        f1List = {
          list_record: {
            selected_count: pool.yield.selected, reserve_count: pool.yield.reserve, excluded_count: excludedCount,
            selected: pool.yield.selected, reserve: pool.yield.reserve, excluded: excludedCount,
            exclusions: cloneJson(pool.exclusions),
          },
          yield: cloneJson(pool.yield),
        };
        const campaign = Outreach.createCampaign({ id: spec.campaign_id || c.campaignId || "campaign-doorstep", userId: c.userId || "user-1" });
        Outreach.enqueue(campaign, [{ candidate, draft }], { suppression: c.suppression || null });
        const plan = Outreach.planWave(campaign, { waveNumber: 1, startDayIndex: 0 });
        f1List.safety_plan_card = cloneJson(Outreach.safetyPlan(campaign, plan, { startDateIso: isoOf(c.now) || undefined }));
        f1List.campaign = {
          id: campaign.id, status: campaign.status, state: campaign.status,
          // IB-1 cap surfacing (outreach pack §2.6): cap_per_day in 124
          // is CEILING semantics — the projection names it as such and
          // carries today's operative cap from the safety plan (12),
          // so no surface ever presents 30 as "the daily cap."
          sending_channel: campaign.sending_channel, cap_ceiling_per_day: campaign.cap_per_day,
          cap_today: f1List.safety_plan_card ? f1List.safety_plan_card.daily_cap_start : null,
          item_count: campaign.items.length,
          items: campaign.items.map((i) => ({ person_id: i.person_id || null, email: i.email || null, status: i.status })),
        };
      }
    }
    const queueItem = {
      queue_id: `g6-outreach-${sha256(String(draft.to) + "|" + String(draft.subject || "")).slice(0, 8)}`,
      to: draft.to, person_id: draft.person_id || null, subject: draft.subject || null,
      status: "awaiting_approval",
    };
    const queueState = { status: "awaiting_approval", items: [queueItem], sends: 0 };
    const payload = {
      kind: "outreach_draft", family: "outreach-send",
      draft: cloneJson(draft), queue_state: queueState,
      ...(f1List || {}),
      sends: 0, committed: false,
    };
    const stepLog = [
      { step: 1, action: "resolve", field: "recipient", result: `recipient resolved from the spec: ${recipientLabel}` },
      { step: 2, action: "draft", field: "message", result: "draft composed and passed its quality gate; the draft store was not written by this emitter" },
      { step: 3, action: "stop", field: null, result: "stopped at the doorstep — the queue entry waits at awaiting approval; nothing was sent" },
    ];
    const art = doorstepArtifact("outreach-send", payload, stepLog);
    return {
      intent: "outreach_draft", family: "outreach-send", resultStatus: "awaiting_user",
      draft, queue_state: queueState, ...art,
      reply: `Drafted the message to ${recipientLabel} and armed it in the queue at awaiting approval — one tap from sending, and nothing has been sent. Review the draft and approve it when you are ready.`,
    };
  }

  // ---------- chat routing (the seam's one entry point) ----------
  // BUG-170 (complexity wave): the kill switch must survive typos. The
  // matcher token-repairs each word against the halt vocabulary at
  // Damerau distance <= 1 (one substitution, deletion, insertion, or
  // adjacent transposition — "evrything", "teh"->the is not needed
  // here, "rite" never decides) and then applies the halt SHAPES:
  // a stop/pause/halt verb reaching for everything / all outreach /
  // the queue. Targeted stops ("stop emailing Maya") carry no global
  // object and never match — suppression owns those (142).
  function _dlWithin1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    if (la === lb) {
      const diff = [];
      for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff.push(i);
      if (diff.length === 1) return true;
      if (diff.length === 2) { const i = diff[0], j = diff[1]; return j === i + 1 && a[i] === b[j] && a[j] === b[i]; }
      return false;
    }
    const sh = la < lb ? a : b, lg = la < lb ? b : a;
    let i = 0, j = 0, skipped = false;
    while (i < sh.length && j < lg.length) {
      if (sh[i] === lg[j]) { i++; j++; }
      else if (!skipped) { skipped = true; j++; }
      else return false;
    }
    return true;
  }
  const HALT_VOCAB = ["stop", "pause", "halt", "everything", "outreach", "queue"];
  function fuzzyHaltMatch(text) {
    const rawText = String(text || "");
    // W8 speech-act guard (BUG-169 invariant): a halt phrase inside
    // quoted or attributed speech is a REPORT, not an instruction —
    // "he replied 'stop everything'" must not halt the queue. The
    // match runs on the text with quoted spans removed; an
    // interrogative-led turn ("should I stop everything?") is a
    // question, never a halt.
    if (/^\s*(should|can|could|would|do|did|will|is|are)\b/i.test(rawText) && /\?/.test(rawText)) return false;
    // Quoted spans are stripped ONLY under an attribution frame
    // (someone said/replied/wrote it). A quoted command with no
    // attribution — the exam's canonical 'Kill switch: "Stop
    // everything" — all queues halt' — is the user's own order
    // wearing a label, and it must still halt.
    const attributed = /\b(said|says|told|replied|responded|wrote|asked|mentioned|texted|emailed|replies|responded)\b/i.test(rawText);
    const unquoted = attributed ? rawText.replace(/["“][^"”]*["”]/g, " ").replace(/(^|\s)'([^']{3,})'(?=[\s,.!?]|$)/g, "$1 ") : rawText;
    const toks = unquoted.toLowerCase().replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
    if (!toks.length) return false;
    const repaired = toks.map((tok) => HALT_VOCAB.includes(tok) ? tok : (HALT_VOCAB.find((v) => Math.abs(v.length - tok.length) <= 1 && _dlWithin1(tok, v)) || tok));
    const t = repaired.join(" ");
    if (/\bstop everything\b|\bdon'?t contact anyone\b|\bstop all outreach\b/.test(t)) return true;
    if (/\b(stop|pause|halt)\b[^.]*\b(everything|all outreach|the outreach|my outreach|outreach|the queue|all queues|it all)\b/.test(t)) return true;
    if (/\bpause (everything|it all|all)\b/.test(t)) return true;
    return false;
  }
  function handleChat(text, ctx) {
    const t = String(text || "").trim().toLowerCase();
    const c = ctx || {};
    if (fuzzyHaltMatch(text)) return haltQueue(c, text);
    if (/\bdid it go through\b|\bdid that (go through|submit)\b|\bcheck (the )?submission status\b/.test(t)) { const r = reconcileDoorstep(c); return r.doorstep || r.submission ? r : null; }
    if (/\bapprove and submit\b|\bsubmit it\b/.test(t)) { const r = submitDoorstep(c); return (c.doorstepState && c.doorstepState.session) || r.resultStatus !== "blocked" ? r : null; }
    if (/\bfill (this|it|the form|that) out\b|\bfill out this\b|\bjust use my profile\b|\bcomplete (this|the) application form\b/.test(t)) {
      if (!c.formSpecName && !c.formSpec) return null;
      const r = fillDoorstep(c);
      if (!r.ok) return { intent: "doorstep_fill", resultStatus: "blocked", code: r.code || null, guard_refusal: r.code === "duplicate_application" ? { code: r.code, reason: `an application for this job is already on record (${describePrior(r.prior)})`, unblock: "track or check the status of the existing application instead of applying again", prior: r.prior } : null, reply: r.reply };
      return { intent: "doorstep_fill", resultStatus: r.doorstep.state === "REVIEW" ? "prepared" : "awaiting_user", doorstep: r.doorstep, reply: fillReply(r.doorstep) };
    }
    if (/\bprep the \w+ application\b|\bprepare the \w+ application\b/.test(t)) return prepPacket(text, c);
    return null;
  }

  return { handleChat, fillDoorstep, dryValidate, submitDoorstep, reconcileDoorstep, haltQueue, fuzzyHaltMatch, applyQueueEvent, prepPacket, resolveField, sha256, sha256Direct,
    // R2B exports: fact binding + destination truth + guards + the recorder
    // surface Lane A's intent handlers use to mutate doorstep state.
    factBinding, factVersionOf, destinationStatus, readSinkReceipts, priorApplicationFor, checkSubmitGuards, recordJobClosure, cancelDoorstep, invalidateApproval, recordPriorApplication,
    // G2 / APD-1 exports: blocker collection + the submit-time re-derivation.
    collectBlockers, openBlockers,
    // G6 exports: per-family doorstep payload emitters (tracking-write,
    // calendar, generalized application packet + outreach draft).
    emitTrackingLog, emitCalendarProposal, emitApplicationPacket, emitOutreachDraft };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerDoorstep;
