// WO-031: the extension on an application page (Greenhouse, Lever, Ashby; Workday basic fields only). It reads every
// field the way the engine does, runs the apply stack's planner over the person's confirmed facts and saved answers, fills
// only what the planner answered, and shows the person a card with every answer exactly as it will be sent. The site's
// own Submit is clicked only after the person's one tap approved that card, and only if the form still matches it, checked
// in the same task as the click.
(() => {
  if (globalThis.__traineeContent) return;
  globalThis.__traineeContent = true;
  const C = globalThis.TraineeCore, D = C.dom;
  const portal = C.detectPortal(location.href);
  if (!portal) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m) => chrome.runtime.sendMessage(m).catch(() => ({ ok: false }));
  const HANDOFF = "A verification check is showing on the page. Finish it yourself there, then press Approve again. Trainee never answers one.";
  const NO_UNCHECKED = "No (left unchecked)";

  let form = null, ctx = null, plan = null, jobId = null, company = "", where = "", expiresAt = null, shownAt = 0;
  let reviewed = null, busy = false, submitting = false, sent = false, personAbort = false, refreshTimer = null;
  // WO-042: when each step of this application happened (epoch ms), for the 60-in-30 benchmark and the panel's own
  // "where the time went". Never part of the payload or its hash.
  const nav = performance.getEntriesByType("navigation")[0];
  const timing = {
    nav: Math.round(performance.timeOrigin),
    dcl: nav ? Math.round(performance.timeOrigin + nav.domContentLoadedEventEnd) : null,
    script: Date.now(),
    visibility_at_prepare: null,
  };
  const filled = new Map(); // name -> the value as the page showed it right after Trainee filled it
  const factIds = new Map(); // name -> the confirmed fact it came from
  const chosen = new Map(); // name -> the employer's option text a widget fill clicked, shown while the widget still shows it
  const edited = new Set(); // names the person changed themselves (trusted events only)
  // WO-048, Workday: the step this card is for, what Workday itself had set when Trainee first read it (a default, a resume
  // parse: shown as Workday's, never Trainee's, never overwritten), where a confirmed fact says otherwise, and whether the
  // step holds the person's own disability form.
  const pageSet = new Map(); // name -> the value Workday showed before Trainee filled anything
  let wd = null; // { step: {title, kind}, conflicts, personal } while this page is a Workday application step
  const inWorkday = () => portal.family === "workday" && D.isWorkdayFlow();
  // WO-048: on a Workday step, a long number that is a date (01/31/2026 on a date's spinbuttons) or the person's own
  // confirmed number (their phone, as Workday shows its national part) is not an identity number: it is shown as it is.
  const ownNumber = (v) => {
    const t = String(v ?? "").trim(), d = t.replace(/\D/g, "");
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}\/\d{4}$/.test(t)) return true;
    return d.length >= 8 && Object.values(ctx?.answers || {}).some((a) => {
      const f = String(a?.value ?? "").replace(/\D/g, "");
      return f.length >= 8 && f.endsWith(d) && d.length >= f.length - 3;
    });
  };
  const resetStep = () => {
    for (const m of [filled, factIds, chosen, edited, pageSet, drafted]) m.clear();
    reviewed = null;
    plan = null;
    wd = null;
  };
  // WO-049: written answers Trainee drafted on the card that the person put on the form with "Use this": name -> the value
  // as the page showed it right after, and the confirmed facts it came from. Only the background, on the person's own tap
  // in the panel, ever asks for one (essay-fill); nothing here drafts or asks for a draft.
  const drafted = new Map();

  // The person's own edits: a trusted input or change on a field (Trainee's own fills dispatch untrusted events). A radio
  // or checkbox Trainee clicks gets a trusted change from the browser itself, so nothing that happens while Trainee is
  // filling (busy) counts as the person's: no refresh can send a half-filled card. A value the person changes meanwhile
  // still differs from what Trainee filled, and the card blocks it as the page's. While an approved application is being
  // checked and recorded, the person's edit stops it: what they approved is no longer what is on the page (WO-031
  // review). After the click nothing on the page changes the application.
  const personEdit = (name) => {
    if (busy) return;
    if (sent) return;
    if (submitting) {
      personAbort = true;
      return;
    }
    edited.add(name);
    scheduleRefresh();
  };
  for (const t of ["input", "change"]) {
    document.addEventListener(t, (e) => {
      if (!e.isTrusted || !form) return;
      const n = D.fieldNameFor(e.target, form);
      if (n) personEdit(n);
    }, true);
  }
  // WO-048: on Workday a person may drop their file on the upload's drop zone (a trusted drop, no change on the input).
  if (portal.family === "workday") {
    document.addEventListener("drop", (e) => {
      if (!e.isTrusted || !form) return;
      const n = D.fieldNameFor(e.target, form);
      if (n) setTimeout(() => personEdit(n), 0);
    }, true);
  }
  // A choice picked in a widget menu (no input event on the field itself): the focused field's.
  // WO-048 round 3: on Workday only a press in an open list (or on the field itself) is a pick; a press elsewhere while a
  // list button still has focus (Workday focuses it after any pick, the page's own too) is not the person changing it.
  const notAPick = (e) => portal.family === "workday" && !!document.activeElement &&
    !(e.target.closest?.('[role="listbox"], [role="option"]') || document.activeElement.contains(e.target));
  document.addEventListener("mousedown", (e) => {
    if (!e.isTrusted || !form || notAPick(e)) return;
    const n = document.activeElement && D.fieldNameFor(document.activeElement, form);
    if (n && form.bindings[n]?.widget) personEdit(n);
  }, true);

  // An Ashby yes/no press: a click on the page's own button; its hidden box gets no input or change (a No leaves it
  // unchecked), so the person's press is caught here and the card is read again.
  document.addEventListener("click", (e) => {
    if (!e.isTrusted || !form || !D.yesNoPress(e.target)) return;
    const n = D.fieldNameFor(e.target, form);
    if (n) setTimeout(() => personEdit(n), 0);
  }, true);
  const scheduleRefresh = () => {
    if (!reviewed && !plan) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => (busy ? undefined : refresh().catch(() => {})), 350);
  };

  // D-MS-1 (x-audit, 2026-11-10): the one place this script writes into the employer's page before the tap. With the shipped
  // config (prefill: false) it writes nothing, so an employer that autosaves as fields are typed receives nothing before the
  // yes. extension/config.js says why; tests/architect/pending/x-audit-extension-fill-after-tap.test.ts holds it.
  async function prefillWrite(b, value, resume, choose) {
    if (ctx?.prefill !== true) return false;
    return await D.fill(b, value, resume, choose);
  }
  // Every non-empty answer on the form now, with where it came from and what the browser sends for it (apply_core.ts).
  function snapshot() {
    // WO-048: Workday's review step is read as Workday shows it (every answer of every step); the Submit is bound to it.
    if (wd?.step.kind === "review") {
      form = { raw: [], bindings: {}, schema: [] };
      return D.readWorkdayReview().filter((r) => r.value).map((r) => ({ name: r.name, label: r.label, value: r.value, source: "fixed", factId: null,
        masked: C.isIdentityField(r) || (C.looksLikeIdNumber(r.value) && !ownNumber(r.value)), detail: "", selector: "" }));
    }
    form = D.readForm();
    const out = [];
    for (const s of form.schema) {
      const b = form.bindings[s.name];
      let v = D.readValue(b);
      if (!v && filled.get(s.name) === NO_UNCHECKED && b.inputType === "checkbox") v = NO_UNCHECKED;
      if (!v) continue;
      const identity = C.isIdentityField(s);
      // A used draft stays "drafted" while the page shows it as used, or as the person edited it themselves; a value a
      // script put there instead is the page's and blocks the tap like any other.
      const d = drafted.get(s.name);
      const asDrafted = !identity && !!d && d.value === v;
      const source = !identity && filled.has(s.name) && filled.get(s.name) === v ? "trainee"
        : asDrafted || (!identity && d && edited.has(s.name)) ? "drafted" : edited.has(s.name) ? "you"
        // WO-048: what Workday itself showed when Trainee first read the step is Workday's.
        : wd && pageSet.get(s.name) === v ? "workday" : "page";
      // The employer's own option text a widget fill clicked ("United States +1"), while the widget still shows it (WO-042).
      if (source === "trainee" && chosen.has(s.name)) v = chosen.get(s.name);
      out.push({ name: s.name, label: s.label, value: v, source,
        factId: source === "trainee" ? factIds.get(s.name) ?? null : source === "drafted" ? C.draftFactId(d.factIds) : null,
        masked: identity || (source !== "trainee" && !asDrafted && C.looksLikeIdNumber(v) && !(wd && ownNumber(v))), detail: D.readDetail(b), selector: b.selector });
    }
    // Read-only fields the page set are sent too: shown and bound to the approval (WO-031 review).
    for (const f of wd ? [] : D.readFixed()) {
      out.push({ name: "fixed:" + f.name, label: f.label, value: f.value, source: "fixed", factId: null,
        masked: C.isIdentityField(f) || C.looksLikeIdNumber(f.value), detail: "", selector: f.selector });
    }
    return out;
  }
  const maskSelectors = (fields) => [
    ...fields.filter((f) => f.masked).map((f) => f.selector),
    ...form.schema.filter((s) => C.isIdentityField(s)).map((s) => form.bindings[s.name]?.selector),
  ].filter(Boolean);
  // WO-101: the fields whose options exist only on the page (a dropdown widget, a place search): the planner's answer is
  // put on the employer's own entry for it when the list opens.
  const listedNames = (f) => f.schema.filter((s) => {
    const b = f.bindings[s.name];
    return b && (b.widget || D.isPlaceSearch(D.element(b.selector)));
  }).map((s) => s.name);
  // WO-102: the planner's answers through the contract (TraineeCore.contractFill): unsupported required answers become
  // questions (asked once, and open on the card); unsupported optional ones are left empty.
  function contractPlan(plan, f, c = ctx) {
    if (!c?.manifest) return { ...plan, fill: [] }; // no manifest, no trusted facts: nothing is filled
    const r = C.contractFill({ schema: f.schema, plan, manifest: c.manifest, listed: listedNames(f), resume: c.resume ? { filename: c.resume.name, sha256: c.resume.sha256 } : null });
    const asked = new Set(plan.needs.map((n) => n.label));
    return { ...plan, fill: r.fill, needs: [...plan.needs, ...r.asks.filter((q) => !asked.has(q.label)).map((q) => ({ label: q.label, type: q.type, options: q.options }))] };
  }
  function openRequired(fields) {
    const have = new Set(fields.map((f) => f.name));
    // FRS: a cover letter pasted (or drafted and used) in the upload's own text box answers the upload.
    const pasted = new Set(C.coverLetterFiles({ schema: form.schema, fields }).filter((c) => c.pasted).map((c) => c.name));
    return form.schema.filter((s) => s.required && !have.has(s.name) && !pasted.has(s.name) && !C.fileAlternative(s, form.schema)).map((s) => C.shortLabel(s.label));
  }
  const payloadOf = (fields) =>
    C.reviewPayload({
      userId: ctx.userId, jobId, company, url: location.href, family: portal.family, fields,
      resume: ctx.resume ? { filename: ctx.resume.name, sha256: ctx.resume.sha256 } : null,
      account: { epoch: Number(ctx.account?.epoch ?? 0), version: Number(ctx.account?.version ?? 0) }, expiresAt,
      manifest: ctx.manifest ? { hash: ctx.manifest.hash, version: ctx.manifest.version } : null,
    });

  // The card: rebuilt whenever the form changes before the tap, so the person always approves what is there now.
  async function refresh() {
    if (submitting || sent || !ctx) return;
    await D.hashFiles();
    const fields = snapshot();
    const payload = payloadOf(fields);
    const hash = await C.approvalHash(payload);
    const ambiguous = plan?.ambiguous || [];
    const ambiguousNames = new Set(ambiguous.map((a) => a.name));
    const open = openRequired(fields);
    const block = C.blockers({ fields, openRequired: open, challenge: !!D.fnDetectChallenge(), family: portal.family });
    if (!ctx.account) block.push("Your Upmore account has no job settings yet. Text Trainee once so it can record your applications.");
    else if (ctx.account.paused) block.push("Your account is paused, so nothing is sent.");
    const verification = [...new Set((D.fnCaptchaTech() || []).map((t) => t.replace(/-widget$/, "")))];
    // WO-048: a Workday step's card says what its button does: Save and Continue (a draft) or the one Submit.
    const workday = wd ? { action: wd.step.kind === "review" ? "submit" : "draft", step: wd.step.title, employer: company, conflicts: wd.conflicts,
      personal: form.schema.some((s) => s.personal) } : undefined;
    // WO-054: what Trainee filled from an answer the person gave in the panel before the session is marked on the card.
    const before = C.beforeSession(fields, ctx.before || []);
    const lines = C.cardLines({ company, family: portal.family, payload, openRequired: open.filter((l) => !ambiguous.some((a) => C.shortLabel(a.label) === l)),
      identity: plan?.identity || [], blockers: block, verification, ambiguous: ambiguous.filter((a) => ambiguousNames.has(a.name)), workday,
      coverFiles: C.coverLetterFiles({ schema: form.schema, fields }), before });
    reviewed = { fields, payload, hash, text: C.payloadText(payload) };
    timing.card = Date.now();
    timing.first_card ??= timing.card;
    // WO-049: the written questions the card offers to draft (each still needed, or holding a draft the person used), with
    // the field's own length limit, and the form's other labels for the employer's AI policy. Not on Workday.
    const maxLength = {};
    for (const s of form.schema) {
      const el = D.element(form.bindings[s.name]?.selector || "");
      if (el && Number(el.maxLength) > 0) maxLength[s.name] = Number(el.maxLength);
    }
    const essays = portal.family === "workday" ? [] : C.essayQuestions({ schema: form.schema, fields, maxLength });
    const formLabels = [...new Set(form.schema.map((s) => String(s.label || "")).filter(Boolean))].slice(0, 200);
    // WO-101: the planner run again on the live form, for the check against the person's batch approval (background.js).
    const batch = ctx.agentSubmits && ctx.queued && !wd && portal.family !== "workday"
      ? C.batchPlan({ jobId, company, url: location.href, family: portal.family, schema: form.schema, challenge: !!D.fnDetectChallenge(),
        plan: C.planForm({ userId: ctx.userId, jobId, company, family: portal.family, schema: form.schema, answers: ctx.answers, saved: ctx.saved, now: Date.now(), location: where }),
        resume: ctx.resume ? { filename: ctx.resume.name, sha256: ctx.resume.sha256 } : null, listed: listedNames(form), manifest: ctx.manifest })
      : undefined;
    await send({ type: "card", card: { jobId, company, family: portal.family, url: location.href, lines, hash, payload, blockers: block, openRequired: open, timing: { ...timing }, essays, formLabels, before, batch,
      ...(workday ? { action: workday.action, step: workday.step } : {}),
      status: block.length ? "blocked" : "ready", message: block.length ? "Not ready to approve yet." : "Read every answer, then approve.", shown_at: shownAt, approved: false } });
  }

  async function prepare() {
    if (busy || submitting) return { ok: false, message: "Already working on this page." };
    if (sent) return { ok: false, message: "This application was already sent from this page." };
    busy = true;
    timing.prepare = Date.now();
    timing.visibility_at_prepare = document.visibilityState;
    try {
      // WO-048 rule 1: the person's Workday account is theirs. A sign-in, create-account, verify-password or emailed-code
      // page is never read, filled or clicked; nothing on it is kept. The next step fills itself once they are in.
      if (portal.family === "workday" && D.workdayAccountPage()) return await signInFirst();
      ctx = await send({ type: "context" });
      timing.context = Date.now();
      if (!ctx?.signedIn) {
        await send({ type: "card", card: { status: "stopped", message: ctx?.message || "Sign in first.", lines: [] } });
        return { ok: false };
      }
      if (portal.family === "workday") {
        // Workday renders its step after the page loads.
        for (let i = 0; i < 40 && !inWorkday() && D.readForm().schema.length < 2; i++) await sleep(250);
        if (D.workdayAccountPage()) return await signInFirst();
        if (inWorkday()) return await prepareWorkday();
      }
      // The form may render after the page loads.
      for (let i = 0; i < 40 && D.readForm().schema.length < 2; i++) await sleep(250);
      if (D.fnDetectChallenge()) {
        await send({ type: "card", card: { status: "stopped", message: HANDOFF, lines: [] } });
        return { ok: false };
      }
      form = D.readForm();
      timing.read = Date.now();
      if (!form.schema.length) {
        await send({ type: "card", card: { status: "stopped", message: "No application form on this page yet. Open the Apply page, then press Fill again.", lines: [] } });
        return { ok: false };
      }
      jobId = C.postingKey(location.href) || C.postingKey(document.referrer || "") || location.origin + location.pathname;
      company = C.tenantOf(jobId) || location.hostname;
      where = D.fnPostingLocation(); // WO-053: where the job is, as its page shows it
      expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
      plan = C.planForm({ userId: ctx.userId, jobId, company, family: portal.family, schema: form.schema, answers: ctx.answers, saved: ctx.saved, now: Date.now(), location: where });
      // WO-102: only answers the submission-quality contract allows are filled; the rest go back to the person as questions.
      plan = contractPlan(plan, form);
      timing.plan = Date.now();
      timing.fields = form.schema.length;
      timing.widgets = Object.values(form.bindings).filter((b) => b.widget).length;
      const resume = ctx.resume ? { name: ctx.resume.name, type: ctx.resume.type, bytes: Uint8Array.from(atob(ctx.resume.base64), (c) => c.charCodeAt(0)), sha256: ctx.resume.sha256 } : null;
      // A page still hydrating (React) can drop a value set a moment before (live run 12: Anduril's First Name, empty
      // 20 ms after it was set). Plain fields the page dropped are set once more after the rest.
      const dropped = [];
      for (const p of plan.fill) {
        const b = form.bindings[p.name];
        if (!b || edited.has(p.name)) continue; // never over what the person typed
        // A dropdown widget or a place search: its options are read when its list opens, and the planner chooses among
        // them, with the whole form beside it (an education end date is one only beside its school).
        const s = form.schema.find((x) => x.name === p.name);
        const listed = b.widget || D.isPlaceSearch(D.element(b.selector));
        // FRS: only an option that derives from the approved fact is clicked (chooseWidgetOption); a list on which none does
        // leaves a required widget to the person, asked like any question the contract turns back.
        let refused = null;
        const choose = listed && s ? (labels) => {
          const v = C.chooseWidgetOption({ userId: ctx.userId, jobId, company, family: portal.family, field: s, form: form.schema, labels, answers: ctx.answers, saved: ctx.saved, now: Date.now(), location: where, factId: p.factId });
          refused = v === null ? labels : null;
          return v;
        } : undefined;
        const t0 = Date.now();
        const ok = await prefillWrite(b, p.value, resume, choose);
        if (!ok && refused && s.required && !plan.needs.some((n) => n.label === s.label)) {
          plan.needs.push({ label: s.label, type: String(s.type || "input_text"), options: refused.length <= 60 ? refused : [] });
        }
        await sleep(20);
        // WO-042: the fields that take time (over 300 ms), named, for the benchmark's slowest-step list.
        if (Date.now() - t0 > 300) (timing.slow ??= {})[p.name] = Date.now() - t0;
        let v = D.readValue(b);
        if (ok && !v && b.inputType === "checkbox" && !/^(true|yes|y|on|checked)\b/i.test(String(p.value))) v = NO_UNCHECKED;
        const label = D.takeWidgetChoice();
        if (ok && v) {
          if (label && label !== v) chosen.set(p.name, label);
          filled.set(p.name, v);
          factIds.set(p.name, p.factId);
        } else if (ok && !listed && b.inputType !== "file") dropped.push(p);
      }
      for (const p of dropped) {
        const b = form.bindings[p.name];
        if (edited.has(p.name)) continue;
        const ok = await prefillWrite(b, p.value, resume);
        await sleep(20);
        const v = D.readValue(b);
        if (ok && v) {
          filled.set(p.name, v);
          factIds.set(p.name, p.factId);
        }
      }
      // Ask once: what only the person can answer goes to Trainee, to be asked by text and saved for every later form.
      timing.fill = Date.now();
      if (plan.needs.length && portal.family !== "workday") send({ type: "questions", jobId, company, location: where, needs: plan.needs });
      shownAt = Date.now();
      await refresh();
      return { ok: true };
    } catch (e) {
      await send({ type: "card", card: { status: "stopped", message: "This form could not be read (" + String(e.message || e).slice(0, 120) + "). Nothing was filled or sent.", lines: [] } });
      return { ok: false };
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------------------------------------------------------------ prepare (WO-054)
  // Read only, in a hidden tab the background opened for "Prepare": the form, the posting's location and the planner's
  // open questions, reported once. Nothing here fills, clicks, sends a card or stores a question; the tab is closed after.
  // A hidden tab runs timers about once a second, so the wait for a late form is the page's own mutations, not sleeps.
  async function survey() {
    const c = await send({ type: "context" });
    if (!c?.signedIn) return send({ type: "survey", ok: false, why: "signed out" });
    const f = await formReady(15000);
    if (D.fnDetectChallenge()) return send({ type: "survey", ok: false, why: "a verification check on the page" });
    if (!f.schema.length) return send({ type: "survey", ok: false, why: "no application form on the page" });
    const id = C.postingKey(location.href) || C.postingKey(document.referrer || "") || location.origin + location.pathname;
    const at = D.fnPostingLocation();
    const p = contractPlan(C.planForm({ userId: c.userId, jobId: id, company: C.tenantOf(id) || location.hostname, family: portal.family, schema: f.schema, answers: c.answers, saved: c.saved, now: Date.now(), location: at }), f, c);
    // WO-101: with agent submits on, this posting's batch entry: every answer exactly as the fill will send it, or why it
    // is left out of a batch (anything the person must answer or do first).
    const batch = c.agentSubmits ? C.batchPlan({ jobId: id, company: C.tenantOf(id) || location.hostname, url: location.href, family: portal.family, schema: f.schema, plan: p,
      challenge: false, resume: c.resume ? { filename: c.resume.name, sha256: c.resume.sha256 } : null, listed: listedNames(f), manifest: c.manifest }) : undefined;
    // 50-in-30: the form as read goes with it, so the background can plan it again after the person's answers.
    return send({ type: "survey", ok: true, jobId: id, company: C.tenantOf(id) || location.hostname, url: location.href, location: at, needs: p.needs, batch,
      schema: f.schema, listed: listedNames(f), family: portal.family });
  }
  function formReady(ms) {
    return new Promise((resolve) => {
      let queued = false, timer = null;
      const finish = () => {
        obs.disconnect();
        clearTimeout(timer);
        resolve(D.readForm());
      };
      const check = () => (queued = false, D.readForm().schema.length >= 2 && finish());
      const obs = new MutationObserver(() => !queued && (queued = true, queueMicrotask(check)));
      obs.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(finish, ms);
      check();
    });
  }

  // ------------------------------------------------------------------------------------------------ Workday (WO-048)
  async function signInFirst() {
    resetStep();
    form = null;
    await send({ type: "card", card: { status: "stopped", signIn: true, url: location.href, message: C.workdaySignIn(C.workdayEmployer(location.href)), lines: [] } });
    return { ok: false };
  }
  const yesish = (v) => /^(true|yes|y|on|checked)\b/i.test(String(v ?? "").trim());
  // Workday's value and the planner's for one field say the same thing (an option's text for its value, a box's yes or no,
  // a number's digits).
  function sameAnswer(s, pageValue, planned) {
    const shownAs = (s?.options || []).find((o) => o.value === planned)?.label ?? planned;
    const n = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (s?.type === "checkbox" && !(s.options || []).length) return yesish(pageValue) === yesish(shownAs);
    if (n(pageValue) === n(shownAs)) return true;
    // A prompt's option under categories ("Website > Careers Site") shows on the page as its leaf (round 2).
    if (/ > /.test(shownAs) && n(pageValue) === n(shownAs.split(" > ").pop())) return true;
    const d = (x) => String(x ?? "").replace(/\D/g, "");
    return !/[a-z]/i.test(pageValue + shownAs) && d(pageValue).length >= 4 && d(pageValue) === d(shownAs);
  }
  // One Workday step: Workday's own values kept apart, the rows the person's own lists need added, every field the planner
  // answers filled (never over a value already there), and the card for this step.
  async function prepareWorkday() {
    const step = D.workdayStep();
    if (wd && wd.step.title !== step.title) resetStep();
    wd = { step, conflicts: [], personal: false };
    jobId = C.postingKey(location.href) || C.postingKey(document.referrer || "") || location.origin + location.pathname;
    company = C.workdayEmployer(location.href);
    where = D.fnPostingLocation();
    expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    if (D.fnDetectChallenge()) {
      await send({ type: "card", card: { status: "stopped", message: HANDOFF, lines: [] } });
      return { ok: false };
    }
    if (step.kind === "review") {
      plan = { fill: [], needs: [], identity: [], ambiguous: [] };
      timing.read = timing.plan = timing.fill = Date.now();
      shownAt = Date.now();
      await refresh();
      return { ok: true };
    }
    D.clearWorkdayOptions();
    const resume = ctx.resume ? { name: ctx.resume.name, type: ctx.resume.type, bytes: Uint8Array.from(atob(ctx.resume.base64), (c) => c.charCodeAt(0)), sha256: ctx.resume.sha256 } : null;
    // What Workday had before Trainee touched this step is Workday's.
    form = D.readForm();
    for (const s of form.schema) {
      const v = D.readValue(form.bindings[s.name]);
      if (v && !filled.has(s.name) && !edited.has(s.name) && !pageSet.has(s.name)) pageSet.set(s.name, v);
    }
    // Rows only for the person's own entries (jobs, education, languages they stated), with Workday's own Add.
    for (const s of D.workdaySections()) {
      const n = Math.min(C.rowsToAdd(s.kind, s.anchors, ctx.answers, form.schema), 10);
      for (let i = 0; i < n; i++) if (!(await D.workdayAddRow(s.kind))) break;
    }
    const tried = new Set();
    for (let pass = 0; pass < 4; pass++) {
      form = D.readForm();
      await D.loadWorkdayOptions(form);
      form = D.readForm();
      plan = C.planForm({ userId: ctx.userId, jobId, company, family: "workday", workdayFlow: true, schema: form.schema, answers: ctx.answers, saved: ctx.saved, now: Date.now(), location: where });
      let did = 0;
      for (const p of plan.fill) {
        if (filled.has(p.name) || edited.has(p.name) || pageSet.has(p.name) || tried.has(p.name)) continue;
        const b = form.bindings[p.name];
        if (!b) continue;
        tried.add(p.name);
        if (D.readValue(b)) continue; // never over a value already on the page
        const t0 = Date.now();
        const ok = await prefillWrite(b, p.value, resume);
        await sleep(20);
        if (Date.now() - t0 > 300) (timing.slow ??= {})[p.name] = Date.now() - t0;
        let v = D.readValue(b);
        if (ok && !v && b.inputType === "checkbox" && !yesish(p.value)) v = NO_UNCHECKED;
        if (ok && v) {
          filled.set(p.name, v);
          factIds.set(p.name, p.factId);
          did++;
        }
      }
      if (!did) break;
    }
    timing.read = timing.plan = timing.fill = Date.now();
    form = D.readForm();
    timing.fields = form.schema.length;
    // Ask once (round 2), as on every other form: this step's open questions go to Trainee to be asked by text and kept for
    // later forms. Never a row of a repeating section (its answer is one job's or school's, matched by the page, not by
    // wording), never the person's disability form, never one the page already shows a value for.
    const asked = plan.needs.filter((n) => !form.schema.some((s) => s.label === n.label && (s.section || s.personal || D.readValue(form.bindings[s.name]))));
    if (asked.length) send({ type: "questions", jobId, company, location: where, needs: asked, step: step.title });
    // Where Workday's own value and the person's confirmed answer differ: side by side on the card, Workday's left.
    wd.conflicts = plan.fill.filter((p) => pageSet.has(p.name) && !sameAnswer(form.schema.find((s) => s.name === p.name), pageSet.get(p.name), p.value))
      .map((p) => {
        const s = form.schema.find((x) => x.name === p.name);
        return { label: p.label, workday: pageSet.get(p.name), yours: (s?.options || []).find((o) => o.value === p.value)?.label ?? p.value };
      });
    shownAt = Date.now();
    await refresh();
    return { ok: true };
  }
  const SAVE_WAIT_MS = 15000;
  // After the one tap on a Workday step's card: the step must still be exactly what the person approved; only then is
  // Workday's Save and Continue clicked, which sends this step to the employer as a draft. Nothing is submitted here.
  async function saveAndContinue(hash) {
    if (!reviewed || reviewed.hash !== hash) return stop("The card you approved is not the one on this page. Nothing was saved or sent.");
    submitting = true;
    personAbort = false;
    await D.hashFiles();
    const s = stillApproved();
    if (personAbort) return stop(ABORTED);
    if (!s.ok) return stop(changedMsg(s.changed));
    if (D.fnDetectChallenge()) return stop(HANDOFF);
    if (D.workdayAccountPage()) return stop(C.workdaySignIn(company));
    const button = D.workdayNextButton();
    if (!button || D.workdayStep().kind !== "page") return stop("I could not find Workday's Save and Continue. Nothing was saved or sent.");
    const ok = await send({ type: "draft", hash, payload: reviewed.payload, step: wd?.step.title || "" });
    if (!ok?.ok) {
      submitting = false;
      return;
    }
    // The last look and the click, in one task.
    const last = stillApproved();
    if (personAbort || !last.ok || D.fnDetectChallenge() || !button.isConnected) {
      return stop(personAbort ? ABORTED : last.ok ? "The page changed before Save and Continue. Nothing was saved." : changedMsg(last.changed));
    }
    const before = D.workdayStep().title, errorsBefore = D.visibleErrors();
    button.click();
    send({ type: "draft-clicked", at: Date.now() });
    // A page that moves away ends this script; the next step fills itself there. One that answers in place (Workday is one
    // page) shows the next step, or its errors.
    const end = Date.now() + SAVE_WAIT_MS;
    while (Date.now() < end) {
      await sleep(200);
      const errors = D.visibleErrors().filter((e) => !errorsBefore.includes(e));
      if (errors.length) {
        submitting = false;
        return send({ type: "stopped", message: `Workday did not save this page: ${errors.slice(0, 3).join("; ")}. Fix it on the page, then press Fill this application again. Nothing was submitted.` });
      }
      if (D.workdayAccountPage()) {
        submitting = false;
        return signInFirst();
      }
      const now = D.workdayStep();
      if (now.title && now.title !== before) {
        submitting = false;
        resetStep();
        return prepare();
      }
    }
    submitting = false;
    return send({ type: "stopped", message: "Workday did not show its next step within 15 seconds. Check the page; nothing was submitted." });
  }

  // Nothing was sent. The card says why and stays stopped until the person changes something or presses Fill again.
  async function stop(message, extra = {}) {
    submitting = false;
    personAbort = false;
    await send({ type: "stopped", message, ...extra });
  }
  const changedMsg = (changed) =>
    `A value changed after you reviewed it (${changed.map(C.shortLabel).join("; ") || "the form"}). Nothing was sent. Press Fill this application to read the form again.`;
  const ABORTED = "You changed the form after approving, so it was not sent. Press Fill this application to read it again.";
  // Person-submits mode: how long Trainee waits for the person's own press before it closes the application as not sent.
  const PERSON_WAIT_MS = 20 * 60_000;
  const PERSON_TIMEOUT = "You did not press Submit within 20 minutes, so nothing was sent. Press Fill this application to start again.";

  // Is the page still exactly the approved application? Every answer, its source, what the browser sends for it (option
  // values, checked states, the attached file's bytes), compared as the whole payload. No await: usable next to the click.
  function stillApproved() {
    const now = snapshot();
    const changed = C.changedFields(reviewed.fields, now);
    return { now, changed, ok: !changed.length && C.payloadText(payloadOf(now)) === reviewed.text };
  }

  // After the one tap: the form must still be exactly what the person approved, nothing may be asking for a verification,
  // there must be a picture of it, and the application is recorded before the site's own Submit is clicked.
  async function submit(hash) {
    if (submitting || sent) return;
    // WO-048: a Workday step that is not the review saves a draft; only the review step's card submits.
    if (wd && wd.step.kind === "page") return saveAndContinue(hash);
    // WO-042: when each step after the tap happened, for the benchmark (never part of the payload or its hash).
    const steps = { submit: Date.now() };
    if (!reviewed || reviewed.hash !== hash) return stop("The card you approved is not the one on this page. Nothing was sent.");
    submitting = true;
    personAbort = false;
    await D.hashFiles();
    let s = stillApproved();
    if (personAbort) return stop(ABORTED);
    if (!s.ok) return stop(changedMsg(s.changed));
    if (D.fnDetectChallenge()) return stop(HANDOFF);
    const button = D.findSubmit();
    if (!button) return stop("I could not find the site's own Submit button. Nothing was sent.");
    steps.checked = Date.now();
    // Proof before the click: the filled form, identity numbers covered while the picture is taken.
    const unmask = D.maskFields(maskSelectors(s.now));
    await sleep(60);
    const shot = await send({ type: "screenshot" });
    unmask();
    if (!shot?.ok) return stop("The picture of the filled form could not be taken (keep this tab in front while it sends). Nothing was sent.");
    await D.hashFiles();
    s = stillApproved();
    if (personAbort) return stop(ABORTED);
    if (!s.ok) return stop(changedMsg(s.changed));
    steps.screenshot = Date.now();
    const planned = [...filled.keys()];
    // The person's own answers to this posting's open questions, kept for later forms once this one is sent (ask once).
    const formAnswers = C.formAnswersToKeep({ jobId, company, location: where, needs: plan?.needs || [], fields: reviewed.payload.fields, answers: ctx.answers, answered: new Set(ctx.answered || []) });
    const begun = await send({ type: "begin", payload: reviewed.payload, hash, urlBefore: location.href, plannedNames: planned, formAnswers, screenshot: { sha256: shot.sha256, dataUrl: shot.dataUrl } });
    if (!begun?.ok) {
      submitting = false;
      return;
    }
    // Person-submits mode (config personSubmits, off by default): Trainee presses nothing; the person does.
    if (ctx?.personSubmits) return armForPerson(button, steps, planned);
    // The last look and the click, in one task: no page script and no person can act between them (WO-031 review).
    const last = stillApproved();
    const challenge = !!D.fnDetectChallenge();
    if (personAbort || !last.ok || challenge || !button.isConnected) {
      const why = personAbort ? ABORTED : challenge ? HANDOFF : last.ok ? "The page's Submit button changed. Nothing was sent." : changedMsg(last.changed);
      return stop(why, { finishPending: true, reason: C.BEFORE_CLICK, beforeClick: true });
    }
    const errorsBefore = D.visibleErrors(), before = location.href;
    steps.begun = Date.now();
    sent = true;
    globalThis.__traineeClicked = true; // tells the background this page is the one that clicked, not the page after it
    button.click();
    send({ type: "clicked", at: Date.now(), errorsBefore, steps });
    await watchAfterClick(errorsBefore, before, planned, last);
  }

  // Person-submits mode: everything up to the click has passed (the approved card, the unchanged form, no verification
  // showing, the picture, the recorded start). Trainee presses nothing. The person reads the filled page and presses the
  // site's own Submit; that trusted press is caught first, on window, before any page script, and the form must still be
  // exactly the approved one with no verification showing, or the press is stopped and nothing is sent. No press within
  // PERSON_WAIT_MS: nothing was sent, and the started application is closed as stopped before the click.
  function armForPerson(button, steps, planned) {
    const form = button.form || button.closest("form");
    let done = false;
    const disarm = () => {
      done = true;
      clearTimeout(timer);
      removeEventListener("click", onPress, true);
      removeEventListener("submit", onPress, true);
    };
    const onPress = (e) => {
      if (done || sent || !e.isTrusted) return;
      if (e.type === "click" ? !button.contains(e.target) : e.target !== form) return;
      const last = stillApproved();
      const challenge = !!D.fnDetectChallenge();
      if (personAbort || !last.ok || challenge || !button.isConnected) {
        e.preventDefault();
        e.stopImmediatePropagation();
        disarm();
        const why = personAbort ? ABORTED : challenge ? HANDOFF : last.ok ? "The page's Submit button changed. Nothing was sent." : changedMsg(last.changed);
        stop(why, { finishPending: true, reason: C.BEFORE_CLICK, beforeClick: true });
        return;
      }
      disarm();
      const errorsBefore = D.visibleErrors(), before = location.href;
      steps.begun = Date.now();
      sent = true;
      globalThis.__traineeClicked = true;
      send({ type: "clicked", at: Date.now(), errorsBefore, steps, byPerson: true });
      watchAfterClick(errorsBefore, before, planned, last);
    };
    const timer = setTimeout(() => {
      if (done || sent) return;
      disarm();
      stop(PERSON_TIMEOUT, { finishPending: true, reason: C.BEFORE_CLICK, beforeClick: true });
    }, PERSON_WAIT_MS);
    addEventListener("click", onPress, true);
    addEventListener("submit", onPress, true);
    send({ type: "awaiting-person" });
  }

  // After the site's own Submit (pressed by Trainee after the one tap, or by the person in person-submits mode).
  async function watchAfterClick(errorsBefore, before, planned, last) {
    // A page that answers in place (Greenhouse, Ashby) is read here; one that moves away is read by the service worker.
    // The wait ends only when the form is gone, a new error appears, or the page asks for something; otherwise after 30
    // seconds the outcome is unknown, counted as applied, never resent.
    const deadline = Date.now() + C.NO_ANSWER_WAIT_MS;
    let timedOut = true;
    while (Date.now() < deadline) {
      await sleep(250);
      const o = D.observe(before, planned);
      const fresh = o.validation_errors.filter((e) => !errorsBefore.includes(e));
      if (!o.form_present_after || fresh.length || o.captcha || o.email_code_prompt) {
        timedOut = false;
        await sleep(300);
        break;
      }
    }
    let obs = D.observe(before, planned);
    // WO-096: the page asks, in place, for the code the employer just emailed (Greenhouse's code box on the same form).
    // The service worker reads it from the person's own Gmail for this approved application and fills this frame's code
    // box; the code never comes here. Nothing is pressed (D-029 rule 5): the card asks the person to press Submit, and
    // the employer's answer is watched for two minutes, then the code step is the person's (needs_user).
    let codeStop = null;
    if (obs.email_code_prompt && !obs.captcha && obs.form_present_after && D.findCodeBox()) {
      const r = await send({ type: "email-code" });
      if (r?.typed) {
        codeStop = r.stop;
        const until = Date.now() + 120_000;
        while (Date.now() < until) {
          await sleep(250);
          const o = D.observe(before, planned);
          if (!o.form_present_after || o.captcha || o.validation_errors.some((e) => !errorsBefore.includes(e))) break;
          if (!o.email_code_prompt) break;
        }
        await sleep(300);
        obs = D.observe(before, planned);
      } else codeStop = r?.stop || "Type the code the employer emailed you on the page yourself.";
    }
    // Proof after the click: what the employer answered (or the form with its errors), identity fields covered.
    const unmaskAfter = D.maskFields(maskSelectors(last.now));
    await sleep(60);
    const after = await send({ type: "screenshot" });
    unmaskAfter();
    await send({ type: "outcome", observation: obs, errorsBefore, timedOut, codeStop, shotAfter: after?.ok ? { sha256: after.sha256, dataUrl: after.dataUrl } : null });
    submitting = false;
  }

  // WO-049: the person tapped "Use this" (or edited the used text) on the card: the text goes on the form as theirs, from
  // the draft, and the card is read again, so the approval binds exactly this text. An empty text takes a used draft back
  // off the form (Redo). Never while the application is being sent or after.
  async function useDraft(name, text, ids) {
    if (submitting || sent) return { ok: false, message: "This application is being sent or was sent, so nothing changed." };
    if (busy || !ctx) return { ok: false, message: "Trainee is still reading this form. Try again in a moment." };
    const b = form.bindings[name], s = form.schema.find((x) => x.name === name);
    if (!b || !s || !C.essayQuestions({ schema: [s], fields: [] }).length) return { ok: false, message: "That question is not on this form any more." };
    // With prefill off nothing is typed into the employer's page before the tap: the person pastes the draft themselves.
    if (ctx.prefill !== true) return { ok: false, message: "Paste this draft into the question yourself. Trainee types nothing into the employer's page before you approve." };
    busy = true;
    try {
      const ok = await prefillWrite(b, String(text), null);
      const v = D.readValue(b);
      if (String(text) === "") drafted.delete(name);
      else if (ok && v) drafted.set(name, { value: v, factIds: Array.isArray(ids) ? ids.map(String) : [] });
      else return { ok: false, message: "The form did not take the text, so nothing changed." };
      edited.delete(name);
    } finally {
      busy = false;
    }
    await refresh();
    return { ok: true, value: drafted.get(name)?.value ?? "", hash: reviewed?.hash ?? null };
  }

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (m?.type === "essay-fill") {
      // Only the frame that holds this form answers.
      if (!form || !form.bindings[m.name]) return false;
      useDraft(m.name, m.text, m.factIds).then(reply, (e) => reply({ ok: false, message: String(e?.message || e) }));
      return true;
    }
    if (m?.type === "prepare") {
      prepare().then(reply);
      return true;
    }
    if (m?.type === "agent-stop") {
      // WO-101: the person's "Stop applying": a send in progress stops at its next check before the click.
      if (submitting && !sent) personAbort = true;
      reply({ ok: true });
      return false;
    }
    if (m?.type === "submit") {
      // Answered at once: the submit may move the page away, which would close a reply still waiting (WO-031 review).
      reply({ accepted: true });
      submit(m.hash);
      return false;
    }
    return false;
  });

  // Queue mode: the next posting opens, fills and shows its card by itself. In the top frame only (an embedded
  // Greenhouse form is its own frame and is filled from the panel).
  (async () => {
    const c = await send({ type: "queued" });
    // WO-054: a tab the background opened to read a posting before the session is read and nothing more.
    if (c?.survey) return (window === window.top || portal.embedded) && survey();
    // WO-048: the next Workday step after an approved Save and Continue (or after the person signed in) fills itself.
    if ((c?.queued || c?.workdayNext) && !c.pending && (window === window.top || portal.embedded)) await prepare();
  })();
})();
