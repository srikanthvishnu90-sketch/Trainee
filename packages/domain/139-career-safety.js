/* Career safety & honesty guards (T-80 kill switch, T-82 distress protocol, OUTE-007/008 decided caps +
   suppression, Doc 1 §9 / Doc 2 §5.3 refusals, truthful AI-use answers). Pure, no I/O, UMD like the
   other domain modules. These are the rails that must REFUSE well: a burst send, a fake referral, and
   taking an assessment for the user are never executed — each refusal names the why and offers the
   honest alternative. Suppression is severity-1: once a person opts out, no code path in this module
   lets them back into a send list. The kill switch halts every queue and resolves any in-flight item
   to a definite state — a send is either provider-confirmed sent, or it is not sent; never half-sent. */
const CareerSafety = (() => {
  const DAILY_START = 15, DAILY_CEILING = 30; // decided caps (owner, 2026-10-12): start 10–15/day, ceiling 30, users cannot raise

  // ---------- Suppression (OUTE-008): per-user + shared, forever ----------
  const keyOf = (p) => String((p && (p.email || p.name)) || "").trim().toLowerCase();
  function createSuppressionStore(seed) {
    const store = { records: [] };
    for (const r of (seed && seed.records) || []) store.records.push({ key: keyOf(r), name: r.name || null, email: r.email || null, reason: r.reason || "opt_out", at: r.at || null, scope: r.scope || "per_user" });
    return store;
  }
  function suppress(store, person, opts) {
    const o = opts || {}, key = keyOf(person);
    if (!key) return { ok: false, code: "person_required" };
    if (store.records.some((r) => r.key === key)) return { ok: true, already: true, key };
    const rec = { key, name: person.name || null, email: person.email || null, reason: o.reason || "opt_out", at: o.at || null, scope: o.scope || "per_user" };
    store.records.push(rec);
    return { ok: true, already: false, record: rec };
  }
  const isSuppressed = (store, person) => store.records.some((r) => r.key === keyOf(person));
  // Filter a candidate/send list: suppressed people come OUT, with the removal proven in the result.
  function applySuppression(store, list) {
    const kept = [], removed = [];
    for (const p of list || []) (isSuppressed(store, p) ? removed : kept).push(p);
    return { kept, removed, removed_count: removed.length, kept_count: kept.length, honored_100: removed.every((p) => isSuppressed(store, p)) && kept.every((p) => !isSuppressed(store, p)) };
  }
  // Mid-campaign opt-out: remove the person from every not-yet-sent queue entry; already-sent mail is history.
  function forceOptOut(store, campaign, person, opts) {
    const sup = suppress(store, person, opts);
    const before = (campaign.queue || []).length;
    campaign.queue = (campaign.queue || []).filter((q) => keyOf(q) !== keyOf(person));
    return { suppressed: sup, removed_from_queue: before - campaign.queue.length, queue_remaining: campaign.queue.length, person: keyOf(person) };
  }

  // ---------- Burst refusal + the safe schedule (OUTE-007) ----------
  function sendSchedule(total) {
    const days = []; let remaining = total, cap = DAILY_START, day = 0;
    while (remaining > 0 && day < 120) {
      day++;
      const today = Math.min(cap, remaining);
      days.push({ day, cap, sends: today });
      remaining -= today;
      if (day % 2 === 0) cap = Math.min(DAILY_CEILING, cap + 5); // ramp +5 per 2 days, ceiling decided
    }
    return { days, total_days: days.length, weeks: Math.ceil(days.length / 7), total };
  }
  function planSendRequest(input) {
    const o = input || {}, total = Number(o.total || 0), today = Number(o.requested_today || 0);
    if (today > DAILY_CEILING) {
      const sched = sendSchedule(total || today);
      return { ok: false, refused: true, code: "burst_refused", ceiling: DAILY_CEILING,
        text: `I won't send ${today} today — the cap is ${DAILY_CEILING}/day and it can't be talked up: blasting burns your mailbox's reputation and gets the account flagged. The safe schedule for ${sched.total} sends is about ${sched.total_days} days (~${sched.weeks} weeks) starting at ${DAILY_START}/day and ramping to ${DAILY_CEILING}/day. One approval starts it.`,
        schedule: sched };
    }
    return { ok: true, refused: false, today, ceiling: DAILY_CEILING };
  }

  // ---------- Fake-referral guard (Doc 1 §9) ----------
  // A referral claim may only be used when a stored fact supports it. profileFacts: [{id, text}].
  function referralClaimCheck(input) {
    const o = input || {}, claim = String(o.claim || "");
    const m = claim.match(/(?:told me to reach out|referred me|sent me your way|recommended I (?:contact|reach out))/i);
    if (!m) return { ok: true, claim_found: false };
    const facts = o.profileFacts || [];
    const supported = facts.some((f) => /referr|told (?:me|him|her) to reach out|introduction|intro from/i.test(String(f.text || "")) && (!o.claimed_by || String(f.text || "").toLowerCase().includes(String(o.claimed_by).toLowerCase().split(" ")[0])));
    if (supported) return { ok: true, claim_found: true, supported: true };
    const warm = (o.trueAngles || [])[0] || null;
    return { ok: false, refused: true, code: "fake_referral_refused", supported: false,
      text: `I can't say ${o.claimed_by || "someone"} told you to reach out — nothing in your profile or connections supports that, and a fake referral torches trust the moment it's checked.${warm ? ` The true warm angle you do have: ${warm}. Want the draft built on that instead?` : ""}`,
      true_angle: warm };
  }

  // ---------- Assessment refusal (Doc 2 §5.3): never taken for the user ----------
  function assessmentRequest(input) {
    const o = input || {};
    return { ok: false, refused: true, code: "assessment_not_taken",
      text: `I won't take your ${o.assessment || "assessment"} for you — that's the employer's test of you, and a mismatch between it and your interviews ends candidacies. What I will do: schedule it, remind you, and run prep — practice problems at the same difficulty, timed, with feedback on your own attempts.`,
      prep_offered: ["timed practice set at the assessment's difficulty", "review of your own attempted solutions", "scheduling + reminder so it never sneaks up"] };
  }

  // ---------- Truthful AI-use answer (Doc 2, employer AI rules) ----------
  function aiUseAnswer(input) {
    const o = input || {}, company = o.company || "the company";
    if (o.company_bans_ai_text) {
      return { truthful: true, path: "outline_only",
        draft: `AI tools helped me organize my materials, and I wrote the submitted text myself, as your policy asks. Every fact in my application is mine and I can speak to all of it.`,
        note: `${company} bans AI-written submission text, so the application itself followed the outline-only path; this answer says exactly that.` };
    }
    return { truthful: true, path: "ai_assisted_disclosed",
      draft: `Yes — I used an AI assistant to help tailor and proofread my application materials. The experience, projects, and facts are entirely mine, everything was reviewed by me, and I'm happy to walk through any of it in detail.`,
      note: "The answer discloses the AI help that actually happened (tailoring/proofreading) and claims nothing that did not." };
  }

  // ---------- Distress protocol (T-82) ----------
  const CRISIS_RE = /\b(kill myself|end it all|self[- ]?harm|suicide|don't want to (?:live|be here)|no reason to (?:live|go on))\b/i;
  function distressResponse(input) {
    const o = input || {}, text = String(o.text || "");
    const crisis = CRISIS_RE.test(text);
    const facts = o.profileFacts || [];
    const grounding = facts.length ? `Here is what is also true, from your own record: ${facts[0]}.` : "Here is what is also true: one rough stretch is not a verdict on you.";
    return {
      protocol: "distress", crisis,
      warmth_first: true, honesty_kept: true,
      text: crisis
        ? `I'm really glad you told me. Please reach out right now to someone who can help in person — in the US you can call or text 988 (Suicide and Crisis Lifeline) any time, or text HOME to 741741. You matter more than any job search; everything here can wait. ${grounding}`
        : `That sounds genuinely rough, and I'm not going to pretend a pep talk fixes it. ${grounding} Not everything is working — some of it is a brutal market for interns right now, and that's real, not a character flaw. Let's make today tiny: one step, then stop.`,
      one_step: o.oneStep || "Send the one follow-up email that's already drafted — two minutes, then you're done for today.",
      resources: crisis ? ["988 Suicide and Crisis Lifeline (US): call or text 988", "Crisis Text Line: text HOME to 741741"] : [],
      plan_shrunk_to_one_step: true,
    };
  }

  // ---------- Kill switch (T-80): halt every queue, nothing half-sent ----------
  function createQueueState(seed) {
    return { campaigns: (seed && seed.campaigns) || [], applications: (seed && seed.applications) || [], followups: (seed && seed.followups) || [], halted: false, halted_at: null };
  }
  function stopEverything(state, opts) {
    const o = opts || {};
    const report = { sent_confirmed: 0, aborted_not_sent: 0, queued_halted: 0, by_queue: {} };
    const all = [["campaigns", state.campaigns || []], ["applications", state.applications || []], ["followups", state.followups || []]];
    for (const [name, items] of all) {
      const r = { sent_confirmed: 0, aborted_not_sent: 0, queued_halted: 0 };
      for (const it of items) {
        if (it.state === "sent") { it.halt_note = "already sent (provider-confirmed) — stays sent"; r.sent_confirmed++; }
        else if (it.state === "sending") { it.state = "aborted_not_sent"; it.halt_note = "was in-flight with no provider confirmation — resolved as NOT sent, never half-sent"; r.aborted_not_sent++; }
        else if (it.state === "queued" || it.state === "scheduled") { it.state = "halted"; r.queued_halted++; }
      }
      report.by_queue[name] = r;
      report.sent_confirmed += r.sent_confirmed; report.aborted_not_sent += r.aborted_not_sent; report.queued_halted += r.queued_halted;
    }
    state.halted = true; state.halted_at = o.at || null;
    const halfSent = [...(state.campaigns || []), ...(state.applications || []), ...(state.followups || [])].filter((i) => i.state === "sending");
    return { halted: true, report, half_sent_remaining: halfSent.length,
      text: `Stopped everything. ${report.sent_confirmed} already-sent item(s) stay sent (they were provider-confirmed). ${report.aborted_not_sent} in-flight item(s) had no confirmation and are marked NOT sent — nothing is half-sent. ${report.queued_halted} queued item(s) are halted and will not move until you say resume.` };
  }

  return { DAILY_START, DAILY_CEILING, keyOf, createSuppressionStore, suppress, isSuppressed, applySuppression, forceOptOut, sendSchedule, planSendRequest, referralClaimCheck, assessmentRequest, aiUseAnswer, distressResponse, createQueueState, stopEverything };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerSafety;
