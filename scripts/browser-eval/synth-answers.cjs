"use strict";
// The strict benchmark's "answered" column (--answered): what the runner does once the person has answered.
//
// The headline pass gives the runner no answers to the employer's own questions, so a form with one required custom question can
// never pass (it is "ready if answered"). That number says nothing about execution: whether the runner, handed the person's
// answers by the preparation side (approved answers keyed by the question's label, exactly as the apply VM receives them), can
// put each one into the page's own control and read it back. This column measures that: the runner's first stop names every
// question it handed back (label, kind, the page's own options); each gets a SYNTHETIC answer for the TEST person below, and the
// same posting is driven again with those answers, up to three rounds (a later step or a conditional question asks more).
//
// It never replaces the headline pass, which stays "no custom answers". A synthetic answer is never a fact about anyone: it is
// the TEST person's, chosen only to exercise the control (a choice: the page's first real option, or its decline option for a
// demographic question; a box: a word that type of box accepts). Nothing is sent, exactly as in the headline run.
const { isPlaceholderOption } = require("../../workers/career-browser/ats-fill.cjs");

// The reasons a stop is the person's to answer (handoff.cjs PERSON_REASONS less the uploads and the resume, which the answers
// map does not carry, and less no_matching_option / ambiguous_option: those are answers given that did not fit, an engine fact).
const ANSWERABLE = new Set(["no_confirmed_answer", "agreement_needs_you", "eeo_needs_your_choice", "no_decline_option"]);
const DECLINE = /decline|prefer not|do(?:n't| not) wish|choose not|not to (?:answer|disclose|say|identify|specify)/i;
const NONE_LIKE = /^(none|none of the above|n\/a|other)$/i;

// A synthetic answer for a box, by what the question asks for (its words) so the page's own check accepts it.
function textAnswer(label, kind) {
  const l = String(label || "").toLowerCase();
  if (/linkedin/.test(l)) return "https://www.linkedin.com/in/test-person-synthetic";
  if (/github/.test(l)) return "https://github.com/test-person-synthetic";
  if (/\b(url|website|portfolio|link)\b/.test(l)) return "https://example.com/test-person";
  if (/e-?mail/.test(l)) return "test.person@example.com";
  if (/salary|compensation|pay\b|ote|rate/.test(l)) return "100000";
  if (/\byears?\b|how many|number of/.test(l)) return "3";
  if (/zip|postal|post code|postcode/.test(l)) return "94105";
  // A date box (often type=date, which takes only yyyy-mm-dd): an ISO date.
  if (/birth|\bdob\b/.test(l)) return "1990-01-01";
  if (/\bdate\b/.test(l)) return "2026-12-01";
  if (/start|available|notice|availability/.test(l)) return kind === "textarea" ? "Available two weeks after an offer." : "2 weeks";
  if (/\bcity\b/.test(l)) return "San Francisco";
  if (/address/.test(l)) return "1 Test Street, San Francisco, CA 94105";
  if (/\bname\b/.test(l)) return "Test Synthetic";
  if (/signature|sign/.test(l)) return "Test Person";
  if (kind === "textarea") return "This is a synthetic answer for a dry-run test of the form. Nothing is sent.";
  return "Test answer";
}

// The page's own option for a choice: the first real one (not a placeholder, not "None"/"Other" when another exists); for a
// demographic question its one decline option when it has one.
function choiceAnswer(n) {
  const opts = (n.options || []).map((o) => String(o)).filter((o) => o.trim() && !isPlaceholderOption(o, false));
  if (!opts.length) return null;
  if (n.reason === "eeo_needs_your_choice" || n.reason === "no_decline_option") {
    const d = opts.filter((o) => DECLINE.test(o));
    if (d.length === 1) return d[0];
  }
  const yes = opts.find((o) => /^yes\b/i.test(o.trim()) && opts.length <= 4);
  if (yes && n.reason === "agreement_needs_you") return yes;
  return opts.find((o) => !NONE_LIKE.test(o.trim()) && !DECLINE.test(o)) || opts[0];
}

// needs: the runner's handed-back list (applyOne `needs`). Returns { answers, unanswerable } where answers is keyed by the
// question's own label (ats-fill answerFor matches it by normalized label), never overwriting an answer already given.
function synthesize(needs, prior = {}) {
  const answers = { ...prior }, unanswerable = [];
  for (const n of needs || []) {
    if (!n || !n.label) continue;
    if (!ANSWERABLE.has(n.reason)) { unanswerable.push({ label: n.label, reason: n.reason }); continue; }
    if (Object.prototype.hasOwnProperty.call(answers, n.label)) { unanswerable.push({ label: n.label, reason: "answered_still_asked" }); continue; }
    let v;
    if (n.kind === "checkbox") v = "Yes";
    else if (["radio", "buttons", "select", "checkgroup"].includes(n.kind) || (n.options && n.options.length)) v = choiceAnswer(n);
    else v = textAnswer(n.label, n.kind);
    if (v === null || v === undefined || v === "") { unanswerable.push({ label: n.label, reason: "no_option_to_pick" }); continue; }
    answers[n.label] = v;
  }
  return { answers, unanswerable };
}

module.exports = { synthesize, textAnswer, choiceAnswer, ANSWERABLE };
