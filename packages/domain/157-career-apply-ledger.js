/* Career apply ledger (MASS APPLY END TO END, 2026-11-04).

   Why this exists. The beta evidence of 2026-11-04 (A1/A2/A3/A14/A24) found the mass-apply path broken between the list
   and the receipt, in the words a person actually types:
     - "Apply to all those roles" fell to the catch-all: the shortlist seam (142 handleShortlistApply) knew only "all of
       them" / "them all", so "those roles" bound to nothing even with a list standing, and with no list the reply did not
       say that "those" pointed at nothing.
     - "Show my pending approvals", "Approve the second application", "Change the answer after approval", "The portal
       requires an account", "Was the application actually submitted?", "What did you send today?", "Can you distinguish
       prepared from submitted?" got the generic fallback or the catch-all: no route read the approval and submission
       state at all.
     - The approval rule said "Submitting to employers is not wired in this conversation" whenever the in-turn browser
       capability was NOT_WIRED, which is always true on the Edge host, even though real employer submission is ON (D-041)
       through the card, the queue and the cloud submitter.
   This module is the read side those answers need: one ledger of the person's applications from the records that hold
   them (the queue and prepared rows the handler reads every turn as its situation, the batch run of module 155, the
   tracker the person keeps by text), each in exactly one state, and the asks that read it. It is read only: it never
   approves, prepares, submits or sends, and it never invents a record. Approval stays where it is bound to the exact
   payload hash: the card tap or the card's text answer (D-MS-1), the batch card's structured approval (155), the email
   card's yes. Every reply here says nothing was approved or sent by it.

   Inputs (host contract, runtime only, never persisted):
     ctx.applyLedger   { asOf, tasks: Situation.tasks (career_situation.ts), unreadable: [] } from the handler
     ctx.liveSwitches  { employerSubmit: bool, emailSend: bool, batchExecutor: bool } from the handler's release config
     ctx.batchRunRecord / ctx.batchApplyState   the 155 run (worker record first, thread skeleton second)
     trackRows        the thread tracker's rows, passed in by 142 (it owns the tracker store) */
const CareerApplyLedger = (() => {
  const s = (v) => (v === null || v === undefined ? "" : String(v));
  const lc = (v) => s(v).toLowerCase().replace(/[’‘`]/g, "'");
  const DAY = 86400000;

  // ---------- the states, one word set (the only place they are named) ----------
  // prepared: built and shown for a yes, nothing sent. approved: the yes landed on the exact application, not sent yet.
  // submitted: the queue records it as sent (submitted_unconfirmed) or the batch's board accepted it with a confirmation;
  // "with the receipt on record" is said only when the database's receipt for it exists and says it reached the employer
  // (career_apply_receipts, D-024). confirmed: the employer confirmed it (their email matched, which the database requires).
  const STATES = {
    selected: "picked, not prepared yet",
    asked: "on your apply list, not prepared yet",
    prepared: "prepared and waiting for your approval; nothing sent",
    approved: "approved by you, not sent yet",
    submitted: "submitted; the employer hasn't confirmed it yet",
    confirmed: "submitted, and the employer confirmed it",
    sent_unconfirmed: "sent, but no confirmation is recorded, so I do not count it as submitted",
    outcome_unknown: "I can't tell whether it reached the employer; it will not be sent again",
    needs_you: "stopped before it was sent; it needs you",
    not_sent: "not sent",
    tracked: "on your tracker because you told me you applied; I did not send it",
  };
  // SENT: it reached the submit step and a record says so. An unknown outcome is never counted as sent (D-024): it is said
  // as unknown, on its own.
  const SENT = new Set(["submitted", "confirmed", "sent_unconfirmed"]);
  const NEEDS_WORDS = {
    captcha: "a verification check on the employer's page, which I never solve",
    bot_check: "a verification check on the employer's page, which I never solve",
    login_required: "the employer's site asks you to sign in to an account first; I never sign in for you",
    needs_answers: "the form asks a question you haven't answered yet",
    email_code: "the employer emailed you a code to finish it; type it on their page yourself",
  };

  function queueStateOf(t) {
    const st = s(t && t.state);
    if (t && t.kind === "tracked") return "tracked";
    if (t && t.kind === "apply_request") return "asked";
    if (st === "awaiting_approval") return "prepared";
    if (st === "queued" || st === "driving") return "approved";
    if (st === "submitted_unconfirmed") return "submitted";
    if (st === "confirmed") return "confirmed";
    if (st === "unknown_outcome") return "outcome_unknown";
    if (st === "needs_user") return "needs_you";
    if (st === "failed" || st === "not_submitted") return "not_sent";
    return null;
  }
  function batchStateOf(app, run) {
    const st = s(app && app.stage);
    if (st === "doorstep") return run && run.status === "approved" && run.approvals && run.approvals[app.postingKey] ? "approved" : "prepared";
    if (st === "submitted") return app.confirmationId ? "submitted" : "sent_unconfirmed";
    if (st === "captcha_handoff" || st === "stopped") return "needs_you";
    if (st === "deferred_refusal" || st === "deferred_count" || st === "excluded_by_user") return "not_sent";
    if (st === "selected") return "selected";
    return null;
  }

  // ---------- the ledger ----------
  function ledgerOf(ctx, trackRows) {
    const c = ctx || {};
    const entries = [];
    const unreadable = [];
    const L = c.applyLedger && typeof c.applyLedger === "object" ? c.applyLedger : null;
    // The database's receipts, by application id (a queue task's id is "job:<id>"); only one that says it reached the employer.
    const receipts = new Map();
    for (const r of L && Array.isArray(L.receipts) ? L.receipts : []) if (r && r.application_id && r.reached_employer === "yes") receipts.set(`job:${r.application_id}`, r);
    const receiptFor = (id) => receipts.get(s(id)) || null;
    if (L) {
      for (const u of Array.isArray(L.unreadable) ? L.unreadable : []) unreadable.push(s(u));
      for (const t of Array.isArray(L.tasks) ? L.tasks : []) {
        if (!t || !["application", "apply_request", "tracked"].includes(t.kind)) continue;
        const state = queueStateOf(t);
        if (!state) continue;
        const ev = t.evidence || {};
        const rc = receiptFor(t.id);
        entries.push({ source: t.kind === "tracked" ? "tracker" : "queue", company: t.company || null, role: t.title || null, state, since: t.since || null,
          reason: ev.reason || null, confirmation: ev.confirmation_id || (rc && rc.confirmation_id) || null, url: ev.url || null, key: t.id,
          // Proof and send time come only from the receipt: a row's updated_at is when anything about it last changed.
          // Architect ruling 13-Obs (2026-11-09, D-024): only the employer's email confirms; a page reference alone does not.
          byEmail: !!ev.email_confirmed_at,
          receipt: !!rc && SENT.has(state), sentAt: rc && SENT.has(state) ? (rc.clicked_at || rc.finished_at || null) : null });
      }
    }
    const rec = c.batchRunRecord && typeof c.batchRunRecord === "object" && c.batchRunRecord.run ? c.batchRunRecord.run : null;
    const run = rec || (c.batchApplyState && c.batchApplyState.id ? c.batchApplyState : null);
    if (run && run.apps) {
      const order = Array.isArray(run.selected) && run.selected.length ? run.selected : Object.keys(run.apps);
      for (const k of order) {
        const a = run.apps[k];
        const state = a ? batchStateOf(a, run) : null;
        if (!state) continue;
        entries.push({ source: "batch", company: a.company || null, role: a.role || a.title || null, state, since: null, runId: run.id, runStatus: run.status,
          reason: a.stop ? (a.stop.code || null) : null, confirmation: a.confirmationId || null, url: a.url || null, key: k, receipt: false, sentAt: null });
      }
    }
    for (const r of Array.isArray(trackRows) ? trackRows : []) {
      if (!r || !r.company) continue;
      if (entries.some((e) => e.company && lc(e.company) === lc(r.company))) continue;
      entries.push({ source: "tracker", company: r.company, role: r.role || r.title || null, state: "tracked", since: r.applied_at || r.appliedAt || null, key: r.app_id || r.id || null });
    }
    return { entries, unreadable };
  }
  function countsOf(entries) {
    const n = {};
    for (const e of entries) n[e.state] = (n[e.state] || 0) + 1;
    return n;
  }
  const nameOf = (e) => `${e.role ? `${e.role} at ` : ""}${e.company || "an employer not on record"}`;
  function lineOf(e) {
    let w = STATES[e.state] || e.state;
    if (e.state === "needs_you" && e.reason && NEEDS_WORDS[lc(e.reason)]) w = `${w}: ${NEEDS_WORDS[lc(e.reason)]}`;
    if (e.state === "confirmed" && !e.byEmail) w = `submitted; ${e.confirmation ? `their page showed ${e.confirmation}; ` : ""}the employer has not confirmed it by email yet`;
    else if (e.state === "submitted" || e.state === "confirmed") {
      if (e.confirmation) w = `${w} (confirmation ${e.confirmation})`;
    }
    if (e.state === "submitted" || e.state === "confirmed") {
      if (e.source === "queue") w = `${w}; ${e.receipt ? "the receipt is on record" : "no receipt is on record yet"}`;
    }
    return `${nameOf(e)}: ${w}`;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function countsLine(entries) {
    const n = countsOf(entries);
    const parts = [];
    if (n.prepared) parts.push(`${n.prepared} prepared and waiting for your approval`);
    if (n.approved) parts.push(`${n.approved} approved, not sent yet`);
    if (n.submitted || n.confirmed) {
      const r = entries.filter((e) => (e.state === "submitted" || e.state === "confirmed") && e.receipt).length;
      const byEmail = entries.filter((e) => e.state === "confirmed" && e.byEmail).length, pageOnly = (n.confirmed || 0) - byEmail;
      const notes = [byEmail ? `${byEmail} confirmed by the employer` : null, pageOnly ? `${pageOnly} page reference only` : null, `${r ? r : "none"} with the receipt on record`].filter(Boolean);
      parts.push(`${(n.submitted || 0) + (n.confirmed || 0)} submitted (${notes.join(", ")})`);
    }
    if (n.sent_unconfirmed) parts.push(`${n.sent_unconfirmed} sent with no confirmation recorded`);
    if (n.outcome_unknown) parts.push(`${n.outcome_unknown} with an outcome I can't confirm`);
    if (n.needs_you) parts.push(`${n.needs_you} stopped and waiting on you`);
    if (n.not_sent) parts.push(`${n.not_sent} not sent`);
    if (n.asked || n.selected) parts.push(`${(n.asked || 0) + (n.selected || 0)} not prepared yet`);
    if (n.tracked) parts.push(`${n.tracked} on your tracker that you applied to yourself`);
    return parts.length ? `On your record right now: ${parts.join("; ")}.` : null;
  }
  function unreadableFact(led) {
    return led.unreadable.length ? `Part of your record could not be read just now (${led.unreadable.join(", ")}), so anything there is not counted; I won't guess it.` : null;
  }

  // ---------- the live switches, said as they are ----------
  // What the reply may claim about submission. Known on: real submission runs after the exact-payload yes. Known off:
  // a prepared application stops at the approval. Unknown (no composition root said): no claim either way.
  function submitFact(ctx) {
    const ls = ctx && ctx.liveSwitches && typeof ctx.liveSwitches === "object" ? ctx.liveSwitches : null;
    if (!ls || typeof ls.employerSubmit !== "boolean") return null;
    return ls.employerSubmit
      ? "Real submission to employers is on for you: once you approve an application's exact card it is sent, and I call it submitted only when its record says so."
      : "Submitting to employers is switched off right now, so a prepared application stops at your approval and nothing is sent.";
  }
  function emailSendFact(ctx) {
    const ls = ctx && ctx.liveSwitches && typeof ctx.liveSwitches === "object" ? ctx.liveSwitches : null;
    if (!ls || typeof ls.emailSend !== "boolean") return null;
    return ls.emailSend
      ? "Sending is on, and your Google account allows it; each email still goes only after your yes to its exact text."
      : "Sending email is switched off right now, so an approved email is kept and not sent.";
  }

  // ---------- the asks ----------
  const ORD_WORD = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth" };
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5 };
  // A named employer ("to Acme", "at Stripe", "for the Acme role") belongs to the per-company status and receipt owners.
  const NAMES_EMPLOYER = /\b(?:to|at|with|for|from)\s+(?!me\b|my\b|you\b|it\b|them\b|this\b|that\b|the\b|a\b|an\b|all\b|each\b|every\b|employers?\b|today\b|yesterday\b|this week\b|review\b|approval\b|sending\b)[a-z0-9][a-z0-9&.'-]+/;
  function askOf(text) {
    const raw = s(text).trim();
    const t = lc(raw).replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) return null;
    // The list the person was shown, referenced as "those", "these", "them", "the ones".
    if (/^(?:(?:ok(?:ay)?|yes|sure|great|cool|please|so|then|now)[,!.]?\s+)*(?:(?:please|go ahead and|can you|could you|just)\s+)?apply (?:me )?(?:to|for) (?:all|each|every one|every single one)?\s*(?:of\s+)?(?:those|these|them|the ones)(?:\s+(?:roles?|jobs?|postings?|positions?|openings?|internships?|ones?|listings?))?(?:\s+(?:you (?:just )?(?:found|listed|showed|sent)(?: me)?|for me|please|now))*\s*[.!]?$/.test(t)) return { kind: "list_apply_all" };
    if (/\bpending\s+(?:approvals?|applications?|cards?)\b|\b(?:waiting|pending|holding)\s+(?:on|for)\s+my\s+(?:approval|yes|ok(?:ay)?|sign[- ]?off)\b|\bwhat (?:do i|needs? me to|should i) approve\b|\bwhat(?:'s| is| needs)? (?:waiting|left) (?:for me )?to approve\b|\b(?:show|list|see)\b[^.?]*\b(?:my )?approvals\b/.test(t)
      && !/\bapprove (?:it|them|all|the batch|batch)\b/.test(t)) return { kind: "pending_approvals" };
    {
      const m = t.match(/^(?:(?:please|ok(?:ay)?|yes|so)[,!.]?\s+)*(?:approve|confirm|green[- ]?light|ok(?:ay)?)\s+(?:only\s+|just\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|last)\s+(?:one|application|app|card|item|role|job|posting)\b/)
        || t.match(/^(?:(?:please|ok(?:ay)?|yes|so)[,!.]?\s+)*(?:approve|confirm)\s+(?:only\s+|just\s+)?(?:application|app|number|item|#)\s*#?(\d{1,2})\b/);
      if (m) return { kind: "approve_pick", ordinal: m[1] === "last" ? -1 : (/^\d+$/.test(m[1]) ? Number(m[1]) : ORD[m[1]]) };
    }
    if ((/\b(?:change|changes|changed|edit|edits|edited|update|updated|fix|correct|modify|modified|swap|replace)\b/.test(t) && /\bafter\b[^.?]*\b(?:approv\w*|i (?:said|say) yes|my yes|the yes|you approve|i approve)/.test(t))
      || /\bwhat (?:happens|if)\b[^.?]*\b(?:change|changes|changed|edit|edited|different|swapped|replaced)\b[^.?]*\bafter\b/.test(t)) {
      return { kind: "change_after_approval", attachment: /\battach(?:ment|ed)?\b|\bresume file\b/.test(t), email: /\be-?mail\b/.test(t) };
    }
    if (/\b(?:portal|site|website|employer|application|form|page|workday|greenhouse|lever|ashby|taleo|icims|smartrecruiters|ats)\b[^.?]*\b(?:requires?|required|needs?|asks? (?:for|me (?:to|for))|asking (?:for|me to)|wants?|makes? me|forces? me to|won'?t let me)\b[^.?]*\b(?:an? |my |another |their |its )?(?:accounts?|account'?s|sign[- ]?in|log[- ]?in|login|register|registration|sign[- ]?up|passwords?|username)\b/.test(t)
      || /\b(?:do i|should i|will you|can you)\s+(?:need to\s+)?(?:create|make|open|register)\s+(?:an? )?account\b/.test(t)) return { kind: "portal_account", password: /\bpassword/.test(t), short: SHORT_ANSWER_RE.test(t) };
    if (/\b(?:distinguish|tell apart|tell the difference|difference between|differ|separate|keep apart)\b/.test(t) && /\b(?:prepared|submitted|approved|sent)\b/.test(t)) return { kind: "prepared_vs_submitted" };
    if (/\bprepared\b[^.?]*\b(?:vs\.?|versus|or|and|from)\b[^.?]*\b(?:submitted|sent)\b/.test(t)) return { kind: "prepared_vs_submitted" };
    if (/^(?:so |and |ok |okay |but )?(?:was|were|did|has|have|is)\b[^.?]{0,60}\b(?:the|my|that|this|it|any|those|these)?\s*(?:application|applications|apps?|it|that one|they|them)?\b[^.?]{0,30}\b(?:actually|really|truly|definitely|for real)\b[^.?]{0,20}\b(?:submitted|sent|go(?:ne)? through|get (?:sent|submitted)|been (?:sent|submitted)|land(?:ed)?)\b/.test(t)
      || /^(?:so |and |ok |okay )?(?:was|were|has|have) (?:the|my) applications? (?:been )?(?:submitted|sent)(?: yet)?\s*[?.!]*$/.test(t)) {
      if (!NAMES_EMPLOYER.test(t.replace(/\b(?:actually|really|truly|definitely)\b/g, ""))) return { kind: "submitted_check" };
    }
    {
      const m = t.match(/^(?:so |and |ok |okay )?(?:what|which(?: applications?| jobs?| roles?)?|how many(?: applications?| apps| jobs)?)\s+(?:applications?\s+|apps\s+|jobs\s+)?(?:did|have|has)\s+(?:you|trainee|we)\s+(?:actually\s+|really\s+)?(?:send|sent|submit|submitted)\b(?:\s+for me)?(?:\s+(today|so far today|this morning|yesterday|this week|in the last (?:24 hours|day|week)))?\s*[?.!]*$/);
      if (m) return { kind: "sent_window", span: /yesterday/.test(m[1] || "") ? "yesterday" : /week/.test(m[1] || "") ? "week" : (m[1] ? "today" : "all"), count: /^(?:so |and |ok |okay )?how many/.test(t) };
    }
    if (/\bwho\b[^.?]*\b(?:e-?mails?|messages?)\b[^.?]*\b(?:sent|come|comes|coming|go|goes|going|be sent)\s+from\b|\b(?:what|which|whose)\s+(?:e-?mail\s+)?(?:address|account|inbox|gmail)\b[^.?]*\b(?:send|sends|sent|sending|from)\b|\bfrom (?:whose|which|what) (?:account|address|e-?mail)\b|\bwho (?:is|will be) the sender\b/.test(t)) return { kind: "email_sender" };
    if (/\bdraft\b[^.?]*\b(?:application|apply|applying)\b[^.?]*\be-?mail\b|\bdraft\b[^.?]*\be-?mail\b[^.?]*\b(?:application|apply|applying)\b/.test(t) && !/\bapply by e-?mail to [a-z]/.test(t)) return { kind: "email_draft_review" };
    if (/\b(?:apply|applying|application|applications)\b[^.?]*\b(?:by|via|over|through) e-?mail\b|\be-?mail(?:ing)? (?:an? |my |the )?applications?\b/.test(t)
      && /\b(?:explain|how|what|walk me through|tell me|without sending|works?|does it work|is it)\b/.test(t) && !/\bapply by e-?mail to [a-z]/.test(t)) return { kind: "email_explain" };
    if (/^(?:show|what(?:'s| is)|check|give me)\s+(?:me\s+)?(?:my\s+)?(?:application|applications|apply)\s+(?:status|statuses)\b|^where do i stand\b(?! with\b)/.test(t)) return { kind: "status_all" };
    return null;
  }

  // ---------- the answers (read only; each says nothing was approved or sent by it) ----------
  // Oldest first, the order the card itself lists prepared applications in (career_apply_cards.ts: created_at, then id);
  // the card may still number them differently (it shows only those that fit a text and send a resume), so a position
  // said here is never given as the card's number: the person approves on the card by the employer's name or the
  // number the card shows (review of #496).
  function prepared(led) {
    const all = led.entries.filter((e) => e.state === "prepared");
    const q = all.filter((e) => e.source === "queue").map((e, i) => ({ e, i }))
      .sort((a, b) => (s(a.e.since).localeCompare(s(b.e.since))) || a.i - b.i).map((x) => x.e);
    return [...q, ...all.filter((e) => e.source !== "queue")];
  }
  // The card's own grammar takes an employer's name ("only acme", career_apply_cards.ts parseSelection): a few plain words.
  const cardName = (e) => { const n = lc(e && e.company).replace(/[^a-z0-9&.' -]/g, " ").replace(/\s+/g, " ").trim(); return n && n.split(" ").length <= 4 && /^[a-z]/.test(n) ? n : null; };
  function approveWhere(e) {
    if (!e) return null;
    if (e.source === "batch") return "open the batch card and approve it there; that approval is bound to exactly the applications it shows";
    const n = cardName(e);
    return n ? `text "show my applications" to open the card, then reply "only ${n}" (or "only" and the number the card shows for it)`
      : "text \"show my applications\" to open the card, then reply \"only\" and the number the card shows for it";
  }
  // A person asking for a short answer ("in two lines", "short version", "keep it brief").
  const SHORT_ANSWER_RE = /\b(?:keep it (?:short|brief)|short (?:version|answer)|(?:in )?(?:one or two|one|two) (?:lines?|sentences?)|briefly|be brief|tl;?dr)\b/;
  function answer(ask, ctx, trackRows) {
    const led = ledgerOf(ctx, trackRows);
    const facts = [];
    const push = (x) => { if (x) facts.push(x); };
    const out = (intent, headline, nextStep, extra) => Object.assign({ intent, headline, facts, nextStep, resultStatus: "awaiting_user", sends: 0, ledger: { counts: countsOf(led.entries), unreadable: led.unreadable.slice() } }, extra || {});
    const pend = prepared(led);
    switch (ask.kind) {
      case "pending_approvals": {
        if (!pend.length) {
          push(countsLine(led.entries));
          push(unreadableFact(led));
          push("When an application is prepared, I show it to you exactly as it would be sent, and it goes only after your yes to that exact version.");
          return out("career_pending_approvals", "Nothing is waiting for your approval right now.", led.entries.length ? "Want me to prepare more applications?" : "Want me to find roles to apply to?");
        }
        push(`Waiting for your approval, oldest first: ${pend.map((e, i) => `(${i + 1}) ${nameOf(e)}`).join("; ")}.`);
        push("Each is prepared and not sent; this message approved nothing.");
        push(unreadableFact(led));
        return out("career_pending_approvals", `${plural(pend.length, "application is", "applications are")} waiting for your approval.`, `To approve, ${approveWhere(pend[0])}.`, { pending: pend.map((e) => ({ company: e.company, role: e.role, source: e.source })) });
      }
      case "approve_pick": {
        const i = ask.ordinal === -1 ? pend.length : ask.ordinal;
        if (!pend.length) {
          push(countsLine(led.entries));
          push(unreadableFact(led));
          return out("career_approval_select", "Nothing is waiting for your approval, so there is no application to approve; nothing was approved or sent.", "Want me to prepare some applications first?", { resultStatus: "blocked", code: "NOTHING_PENDING" });
        }
        if (!Number.isFinite(i) || i < 1 || i > pend.length) {
          push(`Waiting now: ${pend.map((e, k) => `(${k + 1}) ${nameOf(e)}`).join("; ")}.`);
          return out("career_approval_select", `Only ${plural(pend.length, "application is", "applications are")} waiting, so there is no number ${ask.ordinal} to approve; nothing was approved or sent.`, "Which of those did you mean?", { resultStatus: "blocked", code: "PICK_OUT_OF_RANGE" });
        }
        const e = pend[i - 1];
        push(`Counting oldest first, that is ${nameOf(e)}: prepared, not sent; the card may number it differently.`);
        push("I did not approve it from this message. An approval has to land on the card that shows its exact answers and resume, so what you approve is exactly what goes.");
        push(submitFact(ctx));
        return out("career_approval_select", `The ${ORD_WORD[i] || `number ${i}`} application waiting for your approval is ${nameOf(e)}.`, `To approve just that one, ${approveWhere(e)}.`, { target: { company: e.company, role: e.role, source: e.source, key: e.key, position: i } });
      }
      case "change_after_approval": {
        const live = led.entries.filter((e) => e.state === "prepared" || e.state === "approved");
        const gone = led.entries.filter((e) => SENT.has(e.state));
        const unsure = led.entries.filter((e) => e.state === "outcome_unknown");
        push(ask.email
          ? "An email's approval covers its exact recipient, subject, body and attached file; if any of them changes after your yes, it is not sent and comes back to you as a new email to approve."
          : "Your approval covers the exact application you saw: every answer and the exact resume file. If anything in it changes after your yes, it is not sent on that yes; it has to be prepared again and shown to you for a new one.");
        if (ask.attachment && !ask.email) push("The attached resume file is part of what you approve, for an application and for an emailed one: a different file than the one you approved stops the send.");
        if (live.length) push(`Still changeable now: ${live.map(nameOf).join("; ")}.`);
        if (gone.length) push(`Already sent, so I can't change it with the employer: ${gone.map(nameOf).join("; ")}.`);
        if (unsure.length) push(`I can't tell whether ${unsure.map(nameOf).join("; ")} reached the employer, so I can't change ${unsure.length === 1 ? "it" : "them"} either; ${unsure.length === 1 ? "it" : "they"} will not be sent again.`);
        return out("career_answer_change_after_approval", "Changing anything after you approve cancels that approval; nothing changed is sent on the old yes.", live.length ? "Which answer should change, and to what?" : "Want to change an answer on an application?");
      }
      case "portal_account": {
        // MIRROR-1000 gaps (2026-11-11): "in two lines" / "short version" gets the two lines.
        if (ask.short) push("I never sign in, create an account or take a password for you; a site that needs one stops that application and sends you its link.");
        else {
          push("I never create an account or sign in for you, and I never take a password in this chat.");
          push("When an employer's site needs an account, that application stops at that step and comes back to you with its link; you sign in or create the account yourself, on their page.");
        }
        const stopped = led.entries.filter((e) => e.state === "needs_you" && /login|sign|account/i.test(s(e.reason)));
        if (stopped.length) push(`Waiting on a sign-in now: ${stopped.map(nameOf).join("; ")}.`);
        if (ask.password && !ask.short) push("If a site asks for another account's password, don't type it anywhere I can see it; that sign-in is yours alone.");
        return out("career_portal_account", "An employer account is yours to sign in to; I hand that step to you.", stopped.length ? "Open its link to sign in, then tell me when you're done?" : "Want me to keep going with the applications that don't need an account?");
      }
      case "prepared_vs_submitted": {
        push("Prepared means built and shown to you for a yes, with nothing sent. Approved means your yes landed on that exact version and it has not gone yet.");
        push("Submitted means the submit step recorded it as sent, and I say whether its receipt is on record; confirmed means the employer confirmed it too, by their email; a reference shown on their page alone is not their confirmation. Without a record of the send I never call it submitted.");
        push(countsLine(led.entries) || "Nothing is on your record yet in any of those states.");
        push(unreadableFact(led));
        return out("career_status_states", "Yes: prepared, approved and submitted are separate states, and I report each from its record.", "Want the full list with each one's state?");
      }
      case "submitted_check": {
        const apps = led.entries.filter((e) => e.state !== "tracked");
        if (!apps.length) {
          push(unreadableFact(led));
          if (led.entries.length) push(`Your tracker has ${plural(led.entries.length, "application", "applications")} you told me you sent yourself; I did not submit those.`);
          return out("career_submission_check", "No application is on record as submitted by me; nothing has been sent for you.", "Want me to find roles to apply to?");
        }
        const sent = apps.filter((e) => e.state === "submitted" || e.state === "confirmed");
        const latest = apps.slice().sort((a, b) => s(b.since).localeCompare(s(a.since)))[0];
        push(`The latest: ${lineOf(latest)}.`);
        if (apps.length > 1) push(countsLine(apps));
        push(unreadableFact(led));
        const withReceipt = sent.filter((e) => e.receipt).length;
        const head = sent.length
          ? `${plural(sent.length, "application is", "applications are")} recorded as submitted; ${withReceipt === sent.length ? (sent.length === 1 ? "its receipt is" : "their receipts are") + " on record" : withReceipt ? `${withReceipt} with the receipt on record` : "no receipt is on record yet"}.`
          : "None of your applications is recorded as submitted, so none is submitted yet.";
        return out("career_submission_check", head, "Want the receipt for one of them?");
      }
      case "sent_window": {
        const now = typeof ctx.now === "number" ? ctx.now : Date.now();
        const from = ask.span === "today" ? now - DAY : ask.span === "yesterday" ? now - 2 * DAY : ask.span === "week" ? now - 7 * DAY : -Infinity;
        const to = ask.span === "yesterday" ? now - DAY : Infinity;
        const sent = led.entries.filter((e) => SENT.has(e.state));
        // By the send time on the receipt only (sentAt); a sent application with none is said, never placed in a window.
        const dated = sent.filter((e) => { const ms = Date.parse(s(e.sentAt)); return Number.isFinite(ms) ? ms >= from && ms < to : from === -Infinity; });
        const undated = sent.filter((e) => !Number.isFinite(Date.parse(s(e.sentAt))));
        const window = ask.span === "today" ? "in the last 24 hours" : ask.span === "yesterday" ? "the day before that" : ask.span === "week" ? "in the last 7 days" : "so far";
        if (dated.length) push(`Sent ${window}: ${dated.map(lineOf).join("; ")}.`);
        if (undated.length && from !== -Infinity) push(`${plural(undated.length, "sent application has", "sent applications have")} no send time on record, so I left ${undated.length === 1 ? "it" : "them"} out of the window.`);
        const unsure = led.entries.filter((e) => e.state === "outcome_unknown");
        if (unsure.length) push(`Not counted as sent: ${unsure.map(nameOf).join("; ")}, because I can't tell whether ${unsure.length === 1 ? "it" : "they"} reached the employer; ${unsure.length === 1 ? "it" : "they"} will not be sent again.`);
        const waiting = led.entries.filter((e) => e.state === "prepared" || e.state === "approved");
        if (waiting.length) push(`Not sent yet: ${plural(waiting.length, "application is", "applications are")} prepared or approved and still waiting.`);
        push(unreadableFact(led));
        return out("career_sent_activity", dated.length ? `${plural(dated.length, "application was", "applications were")} sent ${window}.` : `No application was sent ${window}.`, dated.length ? "Want the receipt for any of them?" : (waiting.length ? "Want to see what is waiting for your approval?" : "Want me to find roles to apply to?"));
      }
      case "email_explain": {
        push("Some postings ask for an emailed application. For those I draft the whole email, the recipient from the posting, a subject and a short body from facts you confirmed, with your resume attached, and show it to you.");
        push("Nothing is sent by drafting it; it goes once, from your own Gmail, only after you reply yes to that exact email.");
        push(emailSendFact(ctx));
        return out("career_apply_email_explain", "Applying by email: I draft it, you read it, and only your yes sends it.", "Which company's posting should I draft one for?");
      }
      case "email_draft_review": {
        push("Say \"apply by email to\" and the company, for a posting that takes emailed applications, and I show you the whole email: who it goes to, the subject, the body and the attached resume.");
        push("It is a draft for your review; nothing is sent unless you reply yes to that exact email, and any change shows it to you again.");
        return out("career_apply_email_draft", "I can draft it for your review only; drafting never sends.", "Which company is it for?");
      }
      case "email_sender": {
        push("It goes from your own Gmail account, never from Trainee's: Gmail sets the sender, to the one recipient you approved, with no copies to anyone else.");
        push("It needs your permission to send from your Google account; without it nothing is sent and I tell you how to allow it.");
        push(emailSendFact(ctx));
        return out("career_apply_email_sender", "Every email goes from your own account.", "Want me to check whether your Google account is connected for sending?");
      }
      case "status_all": {
        if (!led.entries.length && !led.unreadable.length) return null; // the tracker's own empty answer stands
        if (led.entries.length) push(led.entries.slice(0, 8).map(lineOf).join("; ") + (led.entries.length > 8 ? `; and ${led.entries.length - 8} more` : "") + ".");
        push(countsLine(led.entries));
        push(unreadableFact(led));
        return out("tracking_status", led.entries.length ? `Here is where each application stands, from its record.` : "I couldn't read your applications just now.", "Want the receipt for one of them?", { resultStatus: "complete" });
      }
      default:
        return null;
    }
  }

  return { askOf, answer, ledgerOf, countsOf, submitFact, emailSendFact, STATES };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CareerApplyLedger;
