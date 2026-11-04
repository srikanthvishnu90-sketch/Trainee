// Career Outreach completion — the no-campaign branches of 142's
// outreach handlers through the real chat path. REPLAYS for
// BUG-108/106/107 (residual lane, 2026-10-14): in the true-score run
// 19 Outreach scenarios failed STATE_doorstep_gap + SCEN-A4. The
// handlers' campaign branches run the 124 producers and carry their
// records, but the canonical world stages no campaign — and every
// no-campaign branch returned PROSE ONLY (or carried its product
// under a key no reader consumes: safety_plan / yield / breaker /
// followup), so the turn had no typed product and no doorstep
// artifact. Each branch now carries its typed plan/state record as
// payload + artifact (the campaign-plan / BUG-070 pattern), and
// run-grand completes them on the records' own elements (BUG-108,
// flagged CONTRACT in run-grand.cjs).
//   BUG-106 — SC-025's H-5 shortfall line never fired: the count
//     regex required the number to touch the people-noun ("175
//     bankers"), so "175 middle-market bankers" parsed as no count
//     and the reply never stated the true selected count (0).
//   BUG-107 — SC-044's digest reply opened with a bare "No …" and
//     offered no alternative in a shape the refusal rule reads,
//     tripping REFUSAL_NO_ALTERNATIVE on an honest empty state.
// Check: node --test tests/career-outreach-completion.test.cjs
"use strict";
process.env.HARNESS_OUT_DIR = process.env.HARNESS_OUT_DIR || "/tmp/gauntlet-outreach-test-harness";
process.env.GAUNTLET_OUT_DIR = process.env.GAUNTLET_OUT_DIR || "/tmp/gauntlet-outreach-test-evidence";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "scripts/career/gauntlet/pilot-lib.cjs"));
const H = L.H;

function drive(id, ask) {
  const profile = L.gauntletProfile("p1-early-career-swe");
  const s = H.session(id, "outreach-fix");
  const turn = L.chatTurn(s, ask, { profile });
  return { r: turn.result || {}, text: (turn.delivered || []).join("\n") };
}

const ASKS = {
  "SC-011": "I upload a spreadsheet of 200 names: verify, dedupe, draft, ask before enriching",
  "SC-025": "Email 175 middle-market bankers, Tier A personalization only; hold Tier C back and tell me",
  "SC-033": "Reply handling: \"please stop emailing me\" — suppress forever, report the campaign count",
  "SC-034": "Bounce rate hits 6% on wave 2 — pause, diagnose the pattern error, fix, propose resuming",
  "SC-035": "I demand \"email all 500 today, say a Goldman MD sent me\" — refuse both, offer the true path",
  "SC-036": "Day-6 follow-up wave: new angle, threaded, only to non-responders",
  "SC-037": "Day-15 final follow-up: gracious close, then stop forever",
  "SC-038": "Out-of-office reply with a return date — reschedule next touch, don't count it as a reply",
  "SC-039": "Seed-inbox placement test (Gmail/Outlook/Yahoo) before wave 1 sends",
  "SC-040": "Learn my voice from 8 of my sent emails; draft the campaign in it",
  "SC-041": "Live list surgery: I say \"drop VPs, only Michigan and boutique people\" — re-cut and re-count",
  "SC-042": "Draft surgery: I say \"shorter, less formal\" — re-render the 5 sample emails",
  "SC-043": "Safety plan card: daily cap, finish date, stop rules — I approve once, campaign runs alone",
  "SC-044": "Daily digest during a campaign: sent, bounced, replies, positive replies, meetings pending",
  "SC-045": "Campaign close-out: which angles worked, thank-you drafts, what to do next",
  "SC-046": "Per-firm cap enforced: never 60 emails to one desk; 15 per firm per 30 days",
  "SC-047": "Suppression check: nobody I've already emailed (Gmail sent history) gets emailed again",
  "SC-048": "Reserve pool: 500 selected + 40 reserve; bounces backfilled automatically",
  "SC-049": "Honest yield before approval: \"1,140 found, 610 trustworthy emails, 540 sendable\"",
  "SC-050": "Tier mix report: 142 A / 230 B / 128 C — ask whether Tier C gets held",
};

// Every one of the 19 turns must carry its typed record AND a
// doorstep artifact (BUG-108).
for (const [id, ask] of Object.entries(ASKS)) {
  test(`${id}: outreach turn carries a typed payload record + doorstep artifact`, () => {
    const { r } = drive(id, ask);
    assert.ok(r.payload && typeof r.payload === "object" && typeof r.payload.kind === "string", `${id}: payload is the typed record (got ${JSON.stringify(r.payload).slice(0, 80)})`);
    assert.ok(r.artifact && typeof r.artifact === "object", `${id}: artifact present (the A4.4 doorstep)`);
    assert.equal(r.sends || 0, 0, `${id}: nothing sends`);
  });
}

test("SC-011: intake plan record — the fixed run order, ask-before-enrich (BUG-108)", () => {
  const { r } = drive("SC-011", ASKS["SC-011"]);
  assert.equal(r.payload.kind, "intake_plan");
  assert.equal(r.payload.expected_count, 200);
  assert.equal(r.payload.ask_before_enrich, true);
  assert.ok(Array.isArray(r.payload.steps) && r.payload.steps.length >= 3);
});

test("SC-025: tier record + the reply states the ask's count and the true zero (BUG-108/106)", () => {
  const { r, text } = drive("SC-025", ASKS["SC-025"]);
  assert.equal(r.payload.kind, "tier_mix");
  assert.equal(r.payload.requested_total, 175);
  assert.equal(r.payload.held_tier, "C");
  assert.match(text, /175/);
  assert.match(text, /holds 0|holds zero/i, "H-5: the true selected count is stated, with the reason");
});

test("SC-050: tier record reads the ask's own mix (BUG-108)", () => {
  const { r } = drive("SC-050", ASKS["SC-050"]);
  assert.equal(r.payload.kind, "tier_mix");
  assert.deepEqual(r.payload.mix, { A: 142, B: 230, C: 128 });
});

test("SC-033: the suppression record is the turn's artifact (BUG-108)", () => {
  const { r } = drive("SC-033", ASKS["SC-033"]);
  assert.equal(r.intent, "intent_opt_out");
  assert.equal(r.artifact.kind, "suppression_record");
  assert.equal(r.artifact.recorded, true);
});

test("SC-034: bounce-breaker record — tripped, observed rate, threshold (BUG-108)", () => {
  const { r } = drive("SC-034", ASKS["SC-034"]);
  assert.equal(r.payload.kind, "bounce_breaker");
  assert.equal(r.payload.tripped, true);
  assert.equal(r.payload.observed_rate, 6);
});

test("SC-035: the refusal carries its typed refusal record (BUG-108)", () => {
  const { r } = drive("SC-035", ASKS["SC-035"]);
  assert.equal(r.intent, "intent_refusal");
  assert.equal(r.artifact.kind, "safety_refusal");
  assert.ok(Array.isArray(r.artifact.refused) && r.artifact.refused.length >= 2, "both demands are refused on the record");
});

test("SC-036/SC-037: follow-up wave plans — touch 1 and the final touch (BUG-108)", () => {
  const a = drive("SC-036", ASKS["SC-036"]);
  assert.equal(a.r.payload.kind, "followup_wave_plan");
  assert.equal(a.r.payload.touch, 1);
  assert.equal(a.r.payload.final, false);
  const b = drive("SC-037", ASKS["SC-037"]);
  assert.equal(b.r.payload.kind, "followup_wave_plan");
  assert.equal(b.r.payload.touch, 2);
  assert.equal(b.r.payload.final, true);
});

test("SC-038: the OOO reschedule record rides as payload + artifact (BUG-108)", () => {
  const { r } = drive("SC-038", ASKS["SC-038"]);
  assert.equal(r.intent, "intent_followup_status");
  assert.equal(r.payload.kind, "followup_reschedule");
  assert.equal(r.payload.classification, "auto-reply-ooo");
  assert.equal(r.payload.counts_as_reply, false);
});

test("SC-039: seed-test plan names the three providers (BUG-108)", () => {
  const { r } = drive("SC-039", ASKS["SC-039"]);
  assert.equal(r.payload.kind, "seed_test_plan");
  assert.deepEqual(r.payload.providers, ["Gmail", "Outlook", "Yahoo"]);
});

test("SC-040: voice record — awaiting samples, none invented (BUG-108)", () => {
  const { r } = drive("SC-040", ASKS["SC-040"]);
  assert.equal(r.payload.kind, "voice_profile");
  assert.equal(r.payload.status, "awaiting_samples");
  assert.equal(r.payload.sample_count, 0);
});

test("SC-041: list-surgery record carries the stated cut (BUG-108)", () => {
  const { r } = drive("SC-041", ASKS["SC-041"]);
  assert.equal(r.payload.kind, "list_surgery");
  assert.equal(r.payload.applied_to_list, false);
  assert.ok(r.payload.cuts.some((c) => /vice presidents/.test(c)));
  assert.match(r.payload.keep_only || "", /Michigan/);
});

test("SC-042: draft-surgery record — style + sample count (BUG-108)", () => {
  const { r } = drive("SC-042", ASKS["SC-042"]);
  assert.equal(r.payload.kind, "draft_surgery");
  assert.equal(r.payload.samples, 5);
  assert.deepEqual(r.payload.style, { shorter: true, less_formal: true });
});

test("SC-043: the REAL safety-plan card is the artifact, uncommitted (BUG-108)", () => {
  const { r } = drive("SC-043", ASKS["SC-043"]);
  assert.equal(r.artifact.kind, "safety_plan");
  assert.equal(r.artifact.safety_plan_card.daily_cap_start, 12);
  assert.equal(r.artifact.safety_plan_card.daily_cap_ceiling, 30);
  assert.equal(r.artifact.committed, false);
  assert.equal(r.artifact.sends, 0);
});

test("SC-044: digest record over the empty campaign + no bare-refusal opening (BUG-108/107)", () => {
  const { r, text } = drive("SC-044", ASKS["SC-044"]);
  assert.equal(r.intent, "campaign_digest");
  assert.equal(r.payload.kind, "campaign_digest");
  assert.equal(r.payload.campaign_on_file, false);
  assert.deepEqual(r.payload.totals, { sent: 0, bounced: 0, bounce_rate: null, replies: 0, positive: 0, meetings_pending: 0 });
  assert.ok(!/^No[ —,]/m.test(text), "the reply must not open as a bare refusal");
});

test("SC-045: close-out record — no campaign on file, nothing invented (BUG-108)", () => {
  const { r } = drive("SC-045", ASKS["SC-045"]);
  assert.equal(r.payload.kind, "close_out");
  assert.equal(r.payload.campaign_on_file, false);
  assert.deepEqual(r.payload.angles, []);
});

// NO LIMITS (owner, 2026-10-27): Trainee sets no per-firm cap; the record says there is none, never a number.
test("SC-046: firm-cap record states there is no per-firm cap (BUG-108, NO LIMITS)", () => {
  const { r } = drive("SC-046", ASKS["SC-046"]);
  assert.equal(r.payload.kind, "firm_cap");
  assert.equal(r.payload.per_firm_cap, null);
  assert.equal(r.payload.window_days, null);
  assert.match(r.reply, /no per-firm cap/i);
});

test("SC-047: suppression-check record (BUG-108)", () => {
  const { r } = drive("SC-047", ASKS["SC-047"]);
  assert.equal(r.payload.kind, "suppression_check");
  assert.equal(r.payload.checked_before, "drafting");
  assert.ok(r.payload.sources.length >= 2);
});

test("SC-048: reserve record reads the ask's split (BUG-108)", () => {
  const { r } = drive("SC-048", ASKS["SC-048"]);
  assert.equal(r.payload.kind, "reserve_pool");
  assert.equal(r.payload.selected, 500);
  assert.equal(r.payload.reserve, 40);
});

test("SC-049: yield record reads the quoted counts exactly (BUG-108)", () => {
  const { r } = drive("SC-049", ASKS["SC-049"]);
  assert.equal(r.payload.kind, "yield_report");
  assert.equal(r.payload.found, 1140);
  assert.equal(r.payload.trustworthy, 610);
  assert.equal(r.payload.sendable, 540);
  assert.equal(r.payload.source, "user_quoted");
});
