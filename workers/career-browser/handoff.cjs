"use strict";
// D-072 (item 4) and WO-L: the hand-off at a wall the rules keep. The owner (2026-11-12) approved it with this shape:
//   1. the stop: the run fills everything it can from confirmed facts, reaches the wall, and stops there with nothing sent;
//   2. one link for the person to finish ONLY that step themselves, in their own browser (a sign-in to their own account, a
//      verification check, an emailed code, a required upload only they have), or the ask-once card for an answer only they can
//      give. Trainee never signs in for them, never takes a password or a code through chat, never solves or gets around a check;
//   3. the person says done; Trainee re-checks the page (the wall is gone, every field still holds its confirmed value) and
//   4. shows the exact answers on the page as a card; only a yes to THAT card (its hash) lets the run press Submit, and the run
//      checks, right before the click, that the page still holds exactly what the card showed.
// Pure functions here (buildHandoff, answersCard, cardHash, yesMatches) and one browser step (recheck) driven through the
// runner itself (parallel-apply.cjs applyOne). Nothing in this file sends anything.
const crypto = require("node:crypto");

// The answers only the person can give (ats-fill's own reasons for handing a question back). Same set as
// scripts/browser-eval/d072.cjs PERSON_REASONS: a wall, not an engine failure.
const PERSON_REASONS = new Set(["no_confirmed_answer", "agreement_needs_you", "eeo_needs_your_choice", "no_decline_option",
  "no_matching_option", "ambiguous_option", "upload_needs_you", "no_resume"]);

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return "the employer's site"; } };
// The employer's own page, https only (a local test page on loopback is the one exception, so the hand-off is testable at $0).
const httpsLink = (u) => (/^https:\/\/[^\s]+$/.test(String(u || "")) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s]*$/.test(String(u || "")) ? String(u).slice(0, 500) : null);

// The hand-off for one runner result (applyOne's return), or null when the stop is not a wall the rules keep or when something
// other than the wall is still unfilled (an engine failure is never handed to the person as their step).
function buildHandoff(r, p = {}) {
  if (!r || r.status === "submitted_page_confirmed" || r.status === "unknown_outcome") return null;
  const page = httpsLink(r.at) || httpsLink(p.url) || httpsLink(r.url);
  const host = hostOf(r.at || p.url || r.url);
  const filled = Array.isArray(r.filled_labels) ? r.filled_labels.slice(0, 80) : [];
  const base = { nothing_sent: true, filled, at_door: filled.length === 0, then: ["person_says_done", "recheck", "answers_card", "yes_to_submit"] };
  const extra = r.also_check ? [{ kind: "bot_check", what: "the verification check on the form" }] : [];
  if (r.reason === "bot_check") {
    const inForm = r.wall === "check_in_form";
    // The person's own answers asked beside an in-form check go on the same hand-off; an engine failure beside it means no hand-off.
    const asked = Array.isArray(r.needs) ? r.needs : [];
    if (asked.some((n) => !PERSON_REASONS.has(n.reason))) return null;
    return { ...base, reason: inForm ? "bot_check_in_form" : "bot_check", wall: inForm ? "check_in_form" : "bot_check", link: page,
      step: inForm
        ? `Open the link and complete only the verification check on ${host}'s form; every other answer is already filled. Do not press Submit. Then say done.`
        : `Open the link and complete only the verification check ${host} shows; Trainee never solves one. Then say done.`,
      ...(asked.length ? { card: "ask_once" } : {}),
      remaining: [...asked.map((n) => ({ kind: n.reason === "upload_needs_you" ? "upload" : "answer", what: String(n.label || "").slice(0, 160), reason: n.reason })),
        { kind: "bot_check", what: String(r.check || "a verification check").slice(0, 120) }] };
  }
  if (r.reason === "login_required") {
    return { ...base, reason: "login_required", wall: r.wall || "sign_in", link: page,
      step: `Open the link and sign in to your own account on ${host} yourself (or create it there). Trainee never signs in for you and never asks for your password. Then say done.`,
      remaining: [{ kind: "sign_in", what: String(r.wall || "sign_in") }] };
  }
  if (r.reason === "email_code") {
    return { ...base, reason: "email_code", wall: "email_code", link: page,
      step: `Open the link and enter the code ${host} emailed you, there, yourself; never send it in chat. Then say done.`,
      remaining: [{ kind: "email_code", what: "the code the employer emailed you" }] };
  }
  if (r.reason === "missing_required_answer") {
    const needs = Array.isArray(r.needs) ? r.needs : [];
    if (!needs.length || needs.some((n) => !PERSON_REASONS.has(n.reason))) return null;
    const remaining = [...needs.map((n) => ({ kind: n.reason === "upload_needs_you" ? "upload" : "answer", what: String(n.label || "").slice(0, 160), reason: n.reason,
      ...(Array.isArray(n.options) && n.options.length ? { options: n.options.slice(0, 30).map((o) => String(o).slice(0, 60)) } : {}) })), ...extra];
    return { ...base, reason: "person_answer", wall: "person_answer", link: page, card: "ask_once",
      step: `Answer only ${remaining.filter((x) => x.kind !== "bot_check").length === 1 ? "this question" : `these ${remaining.filter((x) => x.kind !== "bot_check").length} questions`} on the card; everything else on ${host}'s form is already filled from your confirmed facts.`,
      remaining };
  }
  return null;
}

// The exact answers on the page at the re-check (ats-fill heldNow, the instant before Submit), as the card the person says yes to.
// Values are what the page holds now, never what was planned. The hash binds a yes to exactly this card.
function cardHash(card) {
  const rows = (card.answers || []).map((a) => [String(a.field), a.value === null || a.value === undefined ? null : String(a.value)]);
  return crypto.createHash("sha256").update(JSON.stringify([card.url, card.payload_hash, rows])).digest("hex");
}
function answersCard({ url, payload_hash, fields }) {
  const answers = (fields || []).map((f) => ({ field: f.label, value: Array.isArray(f.held) ? f.held.join(", ") : f.held, source: f.source || null }))
    .filter((a) => a.value !== null && a.value !== undefined && a.value !== "");
  const card = { url, payload_hash, answers };
  card.hash = cardHash(card);
  return card;
}
// A yes approves exactly the card it answers: the same hash. Anything else (no hash, an older card, a changed page) is not a yes.
const yesMatches = (card, yes) => !!card && !!yes && typeof yes.card_hash === "string" && yes.card_hash === card.hash && cardHash(card) === card.hash;

// The re-check after the person said done: the same runner, the same approved payload, stopped at the instant before Submit.
// Returns { state: "ready_for_yes", card } when the wall is gone and every field holds its value; { state: "still_walled",
// handoff } when the same (or another) kept wall is still there; { state: "stopped", reason } otherwise. Nothing is sent.
// With `yes` (the person's yes to an earlier card), the run goes on to Submit only if the page holds exactly that card now.
async function recheck(browser, p, opts = {}, deps = {}) {
  const { applyOne, NeedsUser } = deps.runner || require("./parallel-apply.cjs");
  let card = null, refused = null;
  const onPhase = async (phase, audit) => {
    // The caller's own phase record (the VM's lease heartbeat) hears "submitting" only when Submit is really about to be pressed: a
    // re-check that stops before it never records a submitting phase (which would mark the row as possibly clicked).
    if (phase !== "submitting") { if (opts.onPhase) await opts.onPhase(phase); return; }
    card = answersCard({ url: p.url, payload_hash: p.approval && p.approval.hash, fields: audit ? audit.fields : [] });
    if (opts.yes && yesMatches(card, opts.yes)) { if (opts.onPhase) await opts.onPhase(phase); return; } // the yes is to this exact card: Submit
    if (opts.yes) { refused = "card_changed"; throw new NeedsUser("APPROVED_APPLICATION_CHANGED", "the page no longer holds the answers you said yes to"); }
    throw new NeedsUser("recheck_ready_for_yes");
  };
  const res = await applyOne(browser, p, { ...opts, retries: 0, audit: true, onPhase });
  if (res.status === "submitted_page_confirmed" || res.status === "unknown_outcome") return { state: "submitted", result: res, card };
  if (res.reason === "recheck_ready_for_yes" && card) return { state: "ready_for_yes", card };
  if (refused) return { state: "stopped", reason: "APPROVED_APPLICATION_CHANGED", card };
  if (res.handoff) return { state: "still_walled", handoff: res.handoff };
  return { state: "stopped", reason: res.reason || res.status, field: res.field || null };
}

module.exports = { buildHandoff, answersCard, cardHash, yesMatches, recheck, PERSON_REASONS };
