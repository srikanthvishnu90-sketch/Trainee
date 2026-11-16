// Real-task review (2026-11-16): the owner's Vista request "check my Gmail for any sign I already applied" was read as a
// disclosure of a manual application; Trainee replied "you already applied" and wrote a prior-application record that was
// not true (D-007, D-024). A request to check whether an application exists is a question: no record, no disclosure reply.
// The disclosure itself ("I already applied manually") still records, as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "scripts/career/gauntlet/pilot-lib.cjs"));
const H = L.H;
function drive(id, ask) {
  const profile = L.gauntletProfile("p1-early-career-swe");
  const s = H.session(id, "real-task");
  const turn = L.chatTurn(s, ask, { profile });
  return { r: turn.result || {}, text: (turn.delivered || []).join("\n") };
}

test("a request to check whether I already applied writes no prior-application record", () => {
  for (const ask of [
    "Prepare only for the Acme analyst internship. Open the live posting, check my Gmail for any sign I already applied, and use only facts I have told you.",
    "can you see if i already applied to the northwind role",
    "verify whether I already submitted anything to Lakefront",
    "look through my inbox for any evidence I already applied there",
  ]) {
    const { r, text } = drive("RT-1", ask);
    assert.notEqual(r.intent, "intent_prior_application", ask);
    assert.ok(!/you already applied/i.test(text), `${ask} -> ${text}`);
  }
});

test("a real disclosure still records the prior application", () => {
  const { r } = drive("RT-2", "I already applied to the Northwind role manually yesterday, don't apply again");
  assert.equal(r.intent, "intent_prior_application");
});
