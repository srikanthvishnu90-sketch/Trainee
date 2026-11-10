// WO-123 acceptance tests (architect-authored; builders make them pass, never edit them). The intelligence loop: every
// release measured on the real model's held-out sets and the Instinct tone gate (S7), a drop blocking the release like a
// failing test; real failures after a deploy coming back as redacted held-out cases; the tone gate growing with every
// Instinct transcript the owner sends; the harness parity check before any spend; a false pass found later lowering the
// recorded score. Contract in docs/architect/work-orders/WO-123-intelligence-loop.md. No model call, $0: every measurement
// here is a fixture. Synthetic data only: every name, email and phone below is fictional (.invalid and example.test domains, 555 numbers).
// Run: deno test -A --no-check tests/architect/pending/wo-123-intelligence-loop.test.ts
import assertNode from "node:assert/strict";
import { RELEASE_EVAL_SETS, RELEASE_RUN_CAP_USD, releaseEvalRequest, s7, type SetMeasurement } from "../../../scripts/launch/intelligence-gate.ts";
import { assertRedacted, caseFromConversation } from "../../../evals/career/intake.ts";
import { toneCases } from "../helpers/instinct_tone.ts";
import { harnessFits } from "../../../evals/career/harness.ts";
import { applyCorrections, correctionRow } from "../../../evals/career/score-log.ts";

const HARNESS = "parity 2026-11-10: account stores (standing, queue, outreach, alerts, interviews), seeded postings, the router's search step and apply ledger; no code-first turns";
const JUDGES = "claude-sonnet-5-5, claude-haiku-5-5; both-pass";
const m = (set: string, size: number, passes: number[], bars?: Record<string, number>): SetMeasurement => ({ set, size, passes, harness: HARNESS, judges: JUDGES, ...(bars ? { bars } : {}) });
const D054_BARS = { invented: 0, unevidenced: 0, corrections_kept: 100, sensitive_defaulted: 0, reuse_unmarked: 0 };
const deployed = { dev: m("dev", 38, [33, 34, 33, 35, 34]), "d054-items-7-9": m("d054-items-7-9", 15, [9, 9, 10, 9, 9], D054_BARS) };
const greenTone = { concluded: "success" as const, open: ["B6-C2-t3"], deployedOpen: ["B6-C2-t3"] };

Deno.test("WO-123/0 the release sets are the dev set and the D-054 set; the per-run cap is the D-054 cap", () => {
  const ids = RELEASE_EVAL_SETS.map((s) => s.id);
  assertNode.ok(ids.includes("dev"), JSON.stringify(ids));
  assertNode.ok(RELEASE_EVAL_SETS.some((s) => s.path === "evals/career/d054-items-7-9.json" && s.scorer === "d054"), JSON.stringify(RELEASE_EVAL_SETS));
  assertNode.equal(RELEASE_RUN_CAP_USD, 3);
});

Deno.test("WO-123/1 S7 blocks a drop on any release set; equal on every set with the tone gate green passes", () => {
  const drop = s7({ candidate: { ...deployed, "d054-items-7-9": m("d054-items-7-9", 15, [9, 9, 9, 9, 9], D054_BARS) }, deployed, tone: greenTone, spendApproved: true });
  assertNode.equal(drop.id, "S7");
  assertNode.equal(drop.pass, false, drop.summary);
  assertNode.match(drop.summary, /d054-items-7-9/);
  const same = s7({ candidate: deployed, deployed, tone: greenTone, spendApproved: true });
  assertNode.equal(same.pass, true, same.summary);
  console.log(`WO-123 demo: drop -> ${drop.summary}\nWO-123 demo: equal -> ${same.summary}`);
});

Deno.test("WO-123/2 no measurement, or one on another harness or judge pair, is a FAIL, never a pass", () => {
  for (const candidate of [
    { ...deployed, "d054-items-7-9": null },
    { ...deployed, dev: { ...deployed.dev, harness: "parity 2026-10-26: account stores" } },
    { ...deployed, dev: { ...deployed.dev, judges: "claude-sonnet-5-5; one judge" } },
    { ...deployed, dev: m("dev", 37, [33, 34, 33, 35, 34]) },
    { ...deployed, dev: m("dev", 38, [33, 34, 33, 35]) },
  ]) {
    const r = s7({ candidate, deployed, tone: greenTone, spendApproved: true });
    assertNode.equal(r.pass, false, r.summary);
  }
  assertNode.equal(s7({ candidate: deployed, deployed: { ...deployed, dev: null }, tone: greenTone, spendApproved: true }).pass, false);
});

Deno.test("WO-123/3 a worse code-scored bar on the D-054 set fails although the mean is equal", () => {
  for (const [bar, worse] of [["invented", 1], ["unevidenced", 1], ["corrections_kept", 83], ["sensitive_defaulted", 1], ["reuse_unmarked", 2]] as const) {
    const r = s7({ candidate: { ...deployed, "d054-items-7-9": m("d054-items-7-9", 15, [9, 9, 10, 9, 9], { ...D054_BARS, [bar]: worse }) }, deployed, tone: greenTone, spendApproved: true });
    assertNode.equal(r.pass, false, `${bar}: ${r.summary}`);
    assertNode.match(r.summary + r.evidence.join(" "), new RegExp(bar));
  }
});

Deno.test("WO-123/4 the Instinct tone gate is part of S7: failed, missing, or an OPEN list that grew fails", () => {
  for (const tone of [
    { ...greenTone, concluded: "failure" as const },
    { ...greenTone, concluded: "missing" as const },
    { ...greenTone, open: ["B6-C2-t3", "A2-t4"] },
  ]) {
    const r = s7({ candidate: deployed, deployed, tone, spendApproved: true });
    assertNode.equal(r.pass, false, JSON.stringify(tone));
    assertNode.match(r.summary + r.evidence.join(" "), /tone/i);
  }
  // A shrinking OPEN list is the ratchet working: it passes.
  assertNode.equal(s7({ candidate: deployed, deployed, tone: { ...greenTone, open: [] }, spendApproved: true }).pass, true);
});

Deno.test("WO-123/5 budget: one request per release run, budget_usd 3, refused over the $70's remainder; no spend without the owner", () => {
  const sets = RELEASE_EVAL_SETS;
  const quotes = Object.fromEntries(sets.map((s) => [s.id, 2.454]));
  const req = releaseEvalRequest({ sha: "a".repeat(40), brain: "staged", sets, remainingUsd: 41.74, quotes });
  assertNode.equal(req.budget_usd, 3);
  assertNode.equal(req.passes, 5);
  assertNode.equal(req.brain, "staged");
  assertNode.deepStrictEqual([...req.sets].sort(), sets.map((s) => s.id).sort());
  assertNode.throws(() => releaseEvalRequest({ sha: "a".repeat(40), brain: "staged", sets, remainingUsd: 2.99, quotes }), /remain/i);
  assertNode.throws(() => releaseEvalRequest({ sha: "a".repeat(40), brain: "staged", sets, remainingUsd: 41.74, quotes: {} }), /quote/i);
  assertNode.throws(() => releaseEvalRequest({ sha: "a".repeat(40), brain: "staged", sets, remainingUsd: 41.74, quotes: { ...quotes, dev: 3.2 } }), /cap|budget/i);
  const r = s7({ candidate: deployed, deployed, tone: greenTone, spendApproved: false });
  assertNode.equal(r.pass, false);
  assertNode.match(r.summary, /owner/i);
});

// A fictional conversation after the deploy (every value invented for this test).
const PROFILE = { full_name: "Marisol Quintanilla-Brookfield", email: "marisol.qb@mailhost.invalid", phone: "+1 555 867 4410", current_employer: "Halvorsen Logistics", school: "Northgate Polytechnic" };
const PERSONA = { full_name: "Avery Fixture", email: "avery@example.test", phone: "+1 555 010 0000", current_employer: "TEST Advisory", school: "TEST State University" };
const conv = (violations: string[] = ["answers_first"]) => ({
  profile: PROFILE,
  turns: [
    { role: "person" as const, text: "Hi, I'm Marisol Quintanilla-Brookfield, marisol.qb@mailhost.invalid, +1 555 867 4410. I work at Halvorsen Logistics." },
    { role: "trainee" as const, text: "Thanks Marisol. Tell me what you'd like to do next.", violations },
    { role: "person" as const, text: "Did my Northgate Polytechnic transcript upload work?" },
    { role: "trainee" as const, text: "I can't see that yet.", violations: [] },
  ],
});

Deno.test("WO-123/6 intake: a failed reply becomes a held-out case with no real name, email, phone or employer in it", () => {
  const item: any = caseFromConversation(conv(), { reason: "rubric", persona: PERSONA, id: "intake-2026-11-11-1" });
  const text = JSON.stringify(item);
  for (const v of [...Object.values(PROFILE), "Marisol", "Quintanilla", "Brookfield", "mailhost.invalid", "867 4410", "Halvorsen", "Northgate"]) {
    assertNode.ok(!text.includes(v), `"${v}" left in the case`);
  }
  assertNode.ok(text.includes("Avery") && text.includes("avery@example.test"), "the persona stands in");
  assertNode.equal(item.source.reason, "rubric");
  assertNode.deepStrictEqual(item.source.rubric, ["answers_first"]);
  assertNode.ok(!/user_id|thread_id|message_id/.test(text), "no production ids");
  assertNode.ok(Array.isArray(item.turns) && item.id === "intake-2026-11-11-1");
  // The check is hard: an item that kept any personal value is refused.
  assertNode.throws(() => assertRedacted({ ...item, turns: [{ say: "I work at Halvorsen Logistics" }] }, { profile: PROFILE }));
  assertNode.throws(() => assertRedacted({ ...item, turns: [{ say: "write to someone@mailbox.invalid" }] }, { profile: PROFILE }), /email/i);
  assertNode.throws(() => assertRedacted({ ...item, turns: [{ say: "call +1 555 777 2040" }] }, { profile: PROFILE }), /phone/i);
});

Deno.test("WO-123/7 intake: a clean, unflagged conversation makes no case; an owner flag makes one with the note", () => {
  const clean = conv([]);
  assertNode.throws(() => caseFromConversation(clean, { reason: "rubric", persona: PERSONA, id: "x" }), /no rubric failure/i);
  const flagged: any = caseFromConversation({ ...clean, flaggedAt: "2026-11-11T16:00:00Z", note: "the reply did not say whether the upload worked" },
    { reason: "owner_flag", persona: PERSONA, id: "intake-2026-11-11-2" });
  assertNode.equal(flagged.source.reason, "owner_flag");
  assertNode.equal(flagged.source.flagged_at, "2026-11-11T16:00:00Z");
  assertNode.match(JSON.stringify(flagged), /did not say whether the upload worked/);
});

Deno.test("WO-123/8 the tone gate grows with every transcript the owner sends; a transcript with personal data is refused", async () => {
  const base = toneCases();
  const baseTurns = base.reduce((n, c) => n + c.turns.length, 0);
  assertNode.ok(baseTurns > 0 && base.some((c) => /^B6-/.test(c.id)) && base.some((c) => /^A2/.test(c.id)), JSON.stringify(base.map((c) => c.id)));
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/2026-11-11-1.json`, JSON.stringify({ id: "owner-2026-11-11-1", source: "owner", turns: [
      { say: "Find me remote data roles.", instinct: "Here are three remote data roles open now." },
      { say: "Only the first one.", instinct: "Kept the first: TEST Analytics, remote US." },
    ] }));
    const grown = toneCases(dir);
    assertNode.equal(grown.reduce((n, c) => n + c.turns.length, 0), baseTurns + 2);
    assertNode.ok(grown.some((c) => c.id === "owner-2026-11-11-1"));
    await Deno.writeTextFile(`${dir}/2026-11-11-2.json`, JSON.stringify({ id: "owner-2026-11-11-2", source: "owner", turns: [{ say: "email me at real.person@mailbox.invalid", instinct: "Done." }] }));
    assertNode.throws(() => toneCases(dir), /email/i);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("WO-123/9 the parity harness refuses a SHA without searchReplyParts before any model call", () => {
  assertNode.deepStrictEqual(harnessFits({ askFor() {}, searchJudgeTurn() {}, searchReplyParts() {} }), { ok: true });
  const r = harnessFits({ askFor() {}, searchJudgeTurn() {} });
  assertNode.equal(r.ok, false);
  if (!r.ok) assertNode.deepStrictEqual(r.missing, ["searchReplyParts"]);
});

Deno.test("WO-123/10 honest numbers: a false pass found later lowers the recorded score, never raises it", () => {
  const rows = [{ run: "42897333579", pass: 1, passed: 10 }, { run: "42897333579", pass: 2, passed: 9 }, { run: "42873384867", pass: 1, passed: 5 }];
  const fixed = applyCorrections(rows as any, [{ run: "42897333579", pass: 1, minus: 2 }]);
  assertNode.deepStrictEqual(fixed.map((r: any) => r.passed), [8, 9, 5]);
  assertNode.deepStrictEqual(rows.map((r) => r.passed), [10, 9, 5], "the log's own rows are not edited");
  assertNode.throws(() => applyCorrections(rows as any, [{ run: "1", pass: 1, minus: 1 }]), /unknown run|not in the log/i);
  assertNode.throws(() => applyCorrections(rows as any, [{ run: "42897333579", pass: 1, minus: -1 }]), /lower|raise/i);
  const line = correctionRow({ at: "2026-11-11 16:00:00", run: "42897333579", pass: 1, minus: 2, items: ["R03", "M02"], why: "judge passed a capability pitch", who: "architect" });
  assertNode.match(line, /^\| 2026-11-11 16:00:00 \| CORRECTION \| run 42897333579 pass 1 \| -2 \| R03, M02 \|/);
});
