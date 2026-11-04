// The mass-apply proof report (scripts/launch/mass-apply-proof-report.ts): one planted defect per proof rule must turn exactly that rule
// FAIL and take the verdict off PROVEN; the clean chain is PROVEN; a page thank-you alone (submitted_unconfirmed) is never "working".
import assert from "node:assert/strict";
import { evaluate, parseSnapshots, render, type Json } from "../../scripts/launch/mass-apply-proof-report.ts";

const H = "a".repeat(64), SHOT = "b".repeat(64), MAIL = "c".repeat(64), JOB = "11111111-1111-1111-1111-111111111111", ME = "22222222-2222-2222-2222-222222222222";
const snap = (phase: string, at: string, over: Json = {}): Json => ({
  schema: "mass-apply-proof/1", phase, taken_at: at, user_id: ME, since: "2026-11-02T15:00:00Z",
  counts: { wanted: 0, jobs: 0, wanted_since: 0, jobs_since: 0 }, kv: [],
  settings: [{ key: "CAREER_CLOUD_APPLY", value: "on" }, { key: "CAREER_CLOUD_TEXT_CARDS", value: "on" }],
  optin: { enabled: true }, waivers: [{ portal: "ashby", max_sends: 1, revoked_at: null, left: 1 }], pauses: [],
  wanted: [], prepared: [], cards: [], batch: { cards_answered_since: [], jobs_since_by_state: {} },
  jobs: [], receipts: [], receipt_files: [], cloud_events: [], outbox: [], mail_events: [], ...over,
});
const jobRow = (over: Json = {}): Json => ({
  id: JOB, job_id: "ashby:acme:123", company: "Acme", url: "https://jobs.ashbyhq.com/acme/123", state: "confirmed", source: "cloud", attempts: 1,
  payload_hash: H, approval_hash: H, hashes_agree: true, confirmation_id: "ACME-APP-9917", email_confirmed_at: "2026-11-02T16:30:00Z", confirmation_mail_hash: MAIL,
  page_confirmation: "true", http_status: "200", destination: "https://jobs.ashbyhq.com/acme/123/application", final_url: "https://jobs.ashbyhq.com/acme/123/thanks", shot_sha256: [SHOT], ...over,
});
// A clean, fully proven run: four snapshots; the final one carries the chain.
function clean(): Json[] {
  return [
    snap("before-search", "2026-11-02T15:00:00Z"),
    snap("after-search", "2026-11-02T15:01:00Z"),
    snap("after-apply", "2026-11-02T15:05:00Z", { counts: { wanted: 1, jobs: 0 }, wanted: [{ posting_key: "ashby:acme:123", state: "waiting" }] }),
    snap("final", "2026-11-02T16:40:00Z", {
      counts: { wanted: 1, jobs: 1 }, wanted: [{ posting_key: "ashby:acme:123", state: "taken" }],
      prepared: [{ id: "p1", job_id: "ashby:acme:123", state: "approved", payload_hash: H }],
      cards: [{ id: "c1", state: "answered", items_n: 1 }], batch: { cards_answered_since: [{ id: "c1", items_n: 1 }], jobs_since_by_state: { confirmed: 1 } },
      jobs: [jobRow()],
      receipts: [{ application_id: JOB, reached_employer: "yes", clicked_at: "2026-11-02T16:10:00Z", state: "submitted_unconfirmed" }],
      receipt_files: [{ application_id: JOB, kind: "after-submit", sha256: SHOT, bound: true }],
      cloud_events: [{ job_id: JOB, outcome: "submitted" }],
      outbox: [{ key: `receipt:${JOB}`, status: "delivered", has_provider_id: true, delivered_at: "2026-11-02T16:11:00Z" }],
      mail_events: [{ application_ref: `job:${JOB}`, kind: "received", flagged: false, message_hash: MAIL }],
    }),
  ];
}
const final = (s: Json[]) => s[3];
const rule = (s: Json[], id: string) => evaluate(s).rules.find((r) => r.id === id)!;
const mutate = (id: string, f: (s: Json[]) => void) => {
  const s = clean(); f(s);
  const r = evaluate(s);
  assert.equal(r.rules.find((x) => x.id === id)!.status, "FAIL", `${id} must FAIL: ${r.rules.find((x) => x.id === id)!.detail}`);
  assert.equal(r.verdict, "NOT PROVEN", `${id} planted: verdict must leave PROVEN`);
  assert.doesNotMatch(render(r), /\bworking\b/i, `${id} planted: the word working must not be printed`);
  assert.ok(r.rules.filter((x) => x.status === "FAIL").map((x) => x.id).includes(id));
};

Deno.test("the clean chain: every rule PASS, verdict PROVEN, the employer reference is printed", () => {
  const r = evaluate(clean());
  assert.deepEqual(r.rules.map((x) => `${x.id}:${x.status}`), ["P1:PASS", "S4:PASS", "A1:PASS", "H1:PASS", "Y1:PASS", "C1:PASS", "L1:PASS", "L2:PASS", "U1:PASS", "N1:SKIP"]);
  assert.equal(r.verdict, "PROVEN");
  assert.match(r.headline, /working/);
  assert.match(r.headline, /ACME-APP-9917/);
  assert.match(render(r), /CONFIRMED by the employer's own email \(employer reference ACME-APP-9917\)/);
});

// ---- one mutation per rule
Deno.test("P1 mutation: CAREER_CLOUD_TEXT_CARDS missing", () => mutate("P1", (s) => { s[0].settings = [{ key: "CAREER_CLOUD_APPLY", value: "on" }]; }));
Deno.test("S4 mutation: the search queued a wanted row", () => mutate("S4", (s) => { s[1].counts = { wanted: 1, jobs: 0 }; }));
Deno.test("A1 mutation: the Apply tap made an application instead of only a wanted row", () => mutate("A1", (s) => { s[2].counts = { wanted: 1, jobs: 1 }; }));
Deno.test("H1 mutation: approval hash differs from the prepared hash", () => mutate("H1", (s) => { final(s).prepared[0].payload_hash = "d".repeat(64); }));
Deno.test("Y1 mutation: the yes queued more than its card showed", () => mutate("Y1", (s) => { final(s).batch.jobs_since_by_state = { confirmed: 1, queued: 2 }; }));
Deno.test("C1 mutation: a second 'submitted' event", () => mutate("C1", (s) => { final(s).cloud_events.push({ job_id: JOB, outcome: "submitted" }); }));
Deno.test("L1 mutation: the receipt does not say the employer was reached", () => mutate("L1", (s) => { final(s).receipts[0].reached_employer = "unknown"; }));
Deno.test("L2 mutation: confirmed with no employer reference", () => mutate("L2", (s) => { final(s).jobs[0].confirmation_id = null; }));
Deno.test("U1 mutation: the summary word submitted_confirmed stored as a state", () => mutate("U1", (s) => { final(s).jobs[0].state = "submitted_confirmed"; }));
Deno.test("N1 mutation: a failed row whose receipt says reached_employer yes", () => mutate("N1", (s) => {
  const other = "33333333-3333-3333-3333-333333333333";
  final(s).jobs.push(jobRow({ id: other, job_id: "x", state: "failed" }));
  final(s).prepared.push({ id: "p2", job_id: "x", state: "approved", payload_hash: H });
  final(s).batch.jobs_since_by_state = { confirmed: 1, failed: 1 };
  final(s).batch.cards_answered_since = [{ id: "c1", items_n: 2 }];
  final(s).receipts.push({ application_id: other, reached_employer: "yes", clicked_at: "x" });
}));

// ---- the honest labels and the refusal to say "working"
Deno.test("submitted_unconfirmed (a page thank-you only) is labelled sent, unproven, and never working", () => {
  const s = clean();
  Object.assign(final(s).jobs[0], { state: "submitted_unconfirmed", confirmation_id: null, email_confirmed_at: null, confirmation_mail_hash: null });
  final(s).mail_events = [];
  const r = evaluate(s), text = render(r);
  assert.equal(r.verdict, "NOT PROVEN");
  assert.equal(rule(s, "L1").status, "PASS");
  assert.equal(rule(s, "L2").status, "SKIP");
  assert.match(text, /SUBMITTED, UNCONFIRMED/);
  assert.match(text, /sent, unproven/);
  assert.match(r.headline, /^SENT, UNPROVEN/);
  assert.doesNotMatch(text, /\bworking\b/i);
});

Deno.test("a 'confirmed' row without the email evidence is not accepted, whatever its state says", () => {
  const s = clean(); final(s).mail_events = [];
  const r = evaluate(s);
  assert.equal(r.verdict, "NOT PROVEN");
  assert.match(render(r), /CLAIMS CONFIRMED BUT THE EVIDENCE IS INCOMPLETE/);
  assert.doesNotMatch(render(r), /\bworking\b/i);
});

Deno.test("a flagged mail event, or one with another hash, does not confirm", () => {
  for (const edit of [(m: Json) => { m.flagged = true; }, (m: Json) => { m.message_hash = "e".repeat(64); }]) {
    const s = clean(); edit(final(s).mail_events[0]);
    assert.equal(rule(s, "L2").status, "FAIL");
    assert.equal(evaluate(s).verdict, "NOT PROVEN");
  }
});

Deno.test("without the before/after-search snapshots S4 is SKIP and a confirmed row is still not claimed", () => {
  const s = clean().filter((x) => x.phase === "final");
  const r = evaluate(s);
  assert.equal(r.rules.find((x) => x.id === "S4")!.status, "SKIP");
  assert.equal(r.verdict, "NOT PROVEN");
  assert.doesNotMatch(render(r), /\bworking\b/i);
});

Deno.test("unknown_outcome and an empty run say what they are", () => {
  const s = clean(); Object.assign(final(s).jobs[0], { state: "unknown_outcome", confirmation_id: null, email_confirmed_at: null, confirmation_mail_hash: null });
  assert.match(render(evaluate(s)), /UNKNOWN OUTCOME: cannot tell whether it reached the employer; never re-sent/);
  const e = evaluate([snap("final", "2026-11-02T16:40:00Z")]);
  assert.equal(e.verdict, "NOT PROVEN");
  assert.match(e.headline, /No application has reached an employer/);
});

Deno.test("input: psql tag lines are skipped, arrays are accepted, a foreign JSON or another person is refused", () => {
  assert.equal(parseSnapshots(["BEGIN\n" + JSON.stringify(snap("final", "t"))]).length, 1);
  assert.equal(parseSnapshots([JSON.stringify(clean())]).length, 4);
  assert.throws(() => parseSnapshots(['{"hello":1}']), /mass-apply-proof\/1/);
  assert.throws(() => parseSnapshots(["no json"]), /no JSON/);
  assert.throws(() => parseSnapshots([JSON.stringify(snap("a", "t")), JSON.stringify({ ...snap("b", "t"), user_id: "x" })]), /different people/);
});
