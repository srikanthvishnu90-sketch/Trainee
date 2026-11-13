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
  // Review of #797: `filled` is what Trainee filled in ITS OWN browser, which is closed when the run stops. The link opens the
  // employer's page in the person's browser from its start, with none of it there: person_sees says so (page_from_start; empty_form
  // when the wall is a check inside the form; nothing_to_open for the ask-once card), so no reply tells them they will find it filled.
  const base = { nothing_sent: true, filled, at_door: filled.length === 0, person_sees: "page_from_start", then: ["person_says_done", "recheck", "answers_card", "yes_to_submit"] };
  const ask = (n) => ({ kind: n.reason === "upload_needs_you" ? "upload" : "answer", what: String(n.label || "").slice(0, 160), reason: n.reason,
    ...(Array.isArray(n.options) && n.options.length ? { options: n.options.slice(0, 30).map((o) => String(o).slice(0, 60)) } : {}) });
  const extra = r.also_check ? [{ kind: "bot_check", what: "the verification check on the form" }] : [];
  if (r.reason === "bot_check") {
    const inForm = r.wall === "check_in_form";
    // The person's own answers asked beside an in-form check go on the same hand-off; an engine failure beside it means no hand-off.
    const asked = Array.isArray(r.needs) ? r.needs : [];
    if (asked.some((n) => !PERSON_REASONS.has(n.reason))) return null;
    return { ...base, ...(inForm ? { person_sees: "empty_form" } : {}), reason: inForm ? "bot_check_in_form" : "bot_check", wall: inForm ? "check_in_form" : "bot_check", link: page,
      step: inForm
        ? `Open the link and complete the verification check on ${host}'s form; Trainee never solves one. The form opens empty in your browser: what Trainee filled was in its own browser, and nothing was sent. Then say done.`
        : `Open the link and complete only the verification check ${host} shows; Trainee never solves one. Then say done.`,
      ...(asked.length ? { card: "ask_once" } : {}),
      remaining: [...asked.map(ask), { kind: "bot_check", what: String(r.check || "a verification check").slice(0, 120) }] };
  }
  // The employer's staff sign-in form (Teamtailor's "Already working at X?") is not the person's account: no hand-off to it.
  if (r.reason === "login_required" && r.wall === "employee_sign_in") return null;
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
    const remaining = [...needs.map(ask), ...extra];
    return { ...base, person_sees: "nothing_to_open", reason: "person_answer", wall: "person_answer", link: page, card: "ask_once",
      step: `Answer only ${remaining.filter((x) => x.kind !== "bot_check").length === 1 ? "this question" : `these ${remaining.filter((x) => x.kind !== "bot_check").length} questions`} on the card; every other answer for ${host}'s form comes from your confirmed facts.`,
      remaining };
  }
  return null;
}

// The person's own questions a hand-off still carries (beside an in-form check), as the apply VM asks them: label and options.
const askedQuestions = (handoff) => ((handoff && handoff.remaining) || []).filter((x) => x.kind === "answer" || x.kind === "upload")
  .map((x) => ({ label: x.what, ...(x.options ? { options: x.options } : {}) }));

// Review of #797: what EVERY control of the form holds (parallel-apply CONTROLS: { name, label, type, option, value, touched,
// hidden }), not only the questions the engine filled: a box the page ticked itself, a defaulted select and a prefilled input are
// sent with the form too. One row per control: a radio or checkbox by its own option, value null when unset.
// Hidden inputs are never shown. Whether they are stable between two loads of a posting is not measured yet (draft #710's
// two-load benchmark; its per-load pattern is PER_LOAD_TOKEN), and the card's yes is checked on a LATER load, so the card's hash
// leaves them out and the card says how many (hidden_not_hashed). Within one load (the read at the card and the read right
// before the click) they are compared, less the per-load tokens.
const PER_LOAD_TOKEN = /csrf|xsrf|authenticity|nonce|(^|_)token$|captcha|recaptcha|turnstile|-captcha-response/i;
const DEMOGRAPHIC = /gender|\brace\b|ethnic|veteran|disab|hispanic|latino|pronoun|sexual orientation/i;
const CONSENT = /agree|consent|accept|acknowledg|authori[sz]|privacy|terms|certif|sponsor|eligib|legally|right to work|opt.?in|subscribe|marketing|newsletter/i;
const set = (c) => c.value !== null && c.value !== undefined && c.value !== "";
function pageRows(controls, { hidden = false } = {}) {
  return (controls || []).filter((c) => (c.hidden ? hidden && !PER_LOAD_TOKEN.test(c.name || "") : true))
    .map((c) => [String(c.name || c.label || ""), String(c.type || ""), c.option === null || c.option === undefined ? null : String(c.option), set(c) ? String(c.value) : null]);
}
const pageDigest = (controls, o) => crypto.createHash("sha256").update(JSON.stringify(pageRows(controls, o))).digest("hex");
// A choice the page made and the person never confirmed (the engine did not set it): every ticked box or radio, and a select
// already on a consent, authorisation or demographic answer. Asked of the person (PERSON_REASONS), never sent as it stands.
function unconfirmedDefaults(controls) {
  const out = [], seen = new Set();
  for (const c of controls || []) {
    if (c.hidden || c.touched || !set(c)) continue;
    const label = String(c.label || c.name || c.option || "").slice(0, 200), box = c.type === "checkbox" || c.type === "radio";
    if (!box && !(/^select/.test(String(c.type)) && (DEMOGRAPHIC.test(label) || CONSENT.test(label)))) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, reason: DEMOGRAPHIC.test(label) ? "eeo_needs_your_choice" : "agreement_needs_you", kind: c.type, detail: `set by the page, not confirmed by you: ${String(c.value).slice(0, 80)}` });
  }
  return out;
}

// The exact answers on the page at the re-check (ats-fill heldNow, the instant before Submit), as the card the person says yes to.
// Values are what the page holds now, never what was planned. The hash binds a yes to exactly this card. With the page's controls
// (page_digest) the hash covers every non-hidden control; a card recorded without them hashes as before.
function cardHash(card) {
  const rows = (card.answers || []).map((a) => [String(a.field), a.value === null || a.value === undefined ? null : String(a.value)]);
  return crypto.createHash("sha256").update(JSON.stringify(card.page_digest ? [card.url, card.payload_hash, rows, card.page_digest] : [card.url, card.payload_hash, rows])).digest("hex");
}
function answersCard({ url, payload_hash, fields, controls }) {
  const answers = (fields || []).map((f) => ({ field: f.label, value: Array.isArray(f.held) ? f.held.join(", ") : f.held, source: f.source || null }))
    .filter((a) => a.value !== null && a.value !== undefined && a.value !== "");
  // A value the page holds that the engine did not set (a prefilled box, a defaulted select): shown, marked as the page's own.
  const have = new Set(answers.map((a) => String(a.field).toLowerCase()));
  for (const c of controls || []) {
    const field = String(c.label || c.name || c.type || "");
    if (c.hidden || c.touched || !set(c) || have.has(field.toLowerCase())) continue;
    have.add(field.toLowerCase());
    answers.push({ field, value: String(c.value), source: "page_default" });
  }
  const card = { url, payload_hash, answers, ...(controls ? { page_digest: pageDigest(controls), hidden_not_hashed: controls.filter((c) => c.hidden).length } : {}) };
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
    card = answersCard({ url: p.url, payload_hash: p.approval && p.approval.hash, fields: audit ? audit.fields : [], controls: audit ? audit.controls : undefined });
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

module.exports = { buildHandoff, askedQuestions, answersCard, cardHash, yesMatches, pageRows, pageDigest, unconfirmedDefaults, recheck, PERSON_REASONS, PER_LOAD_TOKEN };
