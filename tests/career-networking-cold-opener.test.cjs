"use strict";
/* NETWORKING COLD OPENER (2026-10-30, live finding): "who can I network with at Google?" was answered "Building the list
 * now: analyst at Google in San Francisco" (role and city lifted from old facts) and a long policy paragraph. Now: one
 * short natural paragraph, where names can come from, ONE next step, nothing lifted from old facts, nothing sent.
 * Also pins the per-firm cap wording to the code (no send cap; a list pass keeps 15 names per firm, the rest in reserve).
 * Check: node --test tests/career-networking-cold-opener.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const host = CareerHost.createCareerHost({ CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js") });
const NOW = Date.parse("2026-10-30T22:00:00Z");
const OLD = [
  { kind: "level", value: "analyst", evidence: "I'm an analyst", at: "2026-09-01T00:00:00Z" },
  { kind: "geography", value: "San Francisco", evidence: "in SF", at: "2026-09-01T00:00:00Z" },
  { kind: "target_firm", value: "Meridian Capital", evidence: "targeting Meridian Capital", at: "2026-09-01T00:00:00Z" },
];
let n = 0;
function turn(text, facts) {
  n += 1;
  const ctx = host.createTurnCtx({ userId: "u-cold", threadId: "t" + n, now: NOW, accountPersistence: true, snapshot: null, account: { paused: false, stated_facts: { facts: facts || [], updated_at: "2026-09-01T00:00:00Z" } }, watchState: {}, postings: [] });
  return host.runTurn(text, ctx);
}

// [phrasing, expected target in the reply (firm or field) or null]
const FIRMS = [
  ["who can I network with at Google?", "Google"], ["who should I network with at Stripe", "Stripe"], ["who can I reach out to at Goldman Sachs?", "Goldman Sachs"],
  ["who could I connect with at McKinsey", "McKinsey"], ["who do I network with at Pfizer", "Pfizer"], ["who would I reach out to at the Mayo Clinic", "Mayo Clinic"],
  ["who can I network with at Netflix?", "Netflix"], ["who should I connect with at Cravath", "Cravath"], ["who can I network with at Deloitte", "Deloitte"],
  ["who can I reach out to at NASA", "NASA"], ["who can I connect with at Tesla", "Tesla"], ["who can I network with at Spotify?", "Spotify"],
  ["who should I reach out to at Jane Street", "Jane Street"], ["who can I network with at Teach For America", "Teach For America"], ["who can I network with at Nike", "Nike"],
  ["who can I network with at Airbnb", "Airbnb"], ["who can I network with at Moderna", "Moderna"], ["I want to network at Amazon", "Amazon"],
  ["I want to network with people at Microsoft", "Microsoft"], ["I want to reach people at Adobe", "Adobe"], ["help me network at Salesforce", "Salesforce"],
  ["can you help me network into Google", "Google"], ["find people to network with at Apple", "Apple"], ["find me contacts at Oracle", "Oracle"],
  ["build me a networking list at Intel", "Intel"], ["Hey, who can I network with at Meta?", "Meta"],
];
const FIELDS = [
  ["who should I network with for banking?", "banking"], ["who should I network with for consulting", "consulting"], ["who can I network with in biotech", "biotech"],
  ["who can I network with in marketing", "marketing"], ["who can I network with in law", "law"], ["who can I network with for product management?", "product management"],
  ["who can I network with in healthcare", "healthcare"], ["who can I network with in civil engineering", "civil engineering"], ["who can I network with in journalism", "journalism"],
  ["who can I connect with for a design job", "design"],
];
const NONE = ["who can I network with", "who should I be networking with?", "who can I reach out to?"];

function checkShort(reply, q) {
  assert.ok(reply.length < 520, `short, not a policy paragraph (${reply.length}): ${q}\n${reply}`);
  assert.ok(!/Building the list now/i.test(reply), `no plan headline: ${q}`);
  assert.ok(!/\b(analyst|San Francisco|SF|Denver|Meridian|\b40\b)\b/.test(reply), `nothing lifted from old facts: ${q}\n${reply}`);
  assert.ok(!/per-firm|daily|ramp|\d+ a day|volume limit|hard filter|Gmail's own/i.test(reply), `no policy paragraph: ${q}`);
  assert.ok(/paste/i.test(reply) && /LinkedIn export/i.test(reply), `one clear next step (paste names / export): ${q}`);
  assert.ok(/guessed address/.test(reply) && /approval/.test(reply) && /source/.test(reply), `source, no guessed address, approval: ${q}`);
  assert.equal((reply.match(/\?/g) || []).length <= 1, true, `at most one question: ${q}`);
}

for (const [q, target] of [...FIRMS.map(([q, t]) => [q, `at ${t}`]), ...FIELDS.map(([q, t]) => [q, `in ${t}`]), ...NONE.map((q) => [q, null])]) {
  test(`cold opener: ${q}`, () => {
    for (const facts of [OLD, []]) {
      const o = turn(q, facts);
      assert.equal(o.intent, "outreach_clarification", q);
      assert.ok(!o.sends, "nothing sent");
      checkShort(String(o.reply), q);
      if (target) assert.ok(String(o.reply).includes(target), `${q} names ${target}: ${o.reply}`);
      assert.ok(!o.committed && o.resultStatus !== "sent", "nothing committed");
    }
  });
}

test("an ask that carries its own count, role, place or year still gets the plan, and old facts do not leak into it", () => {
  for (const q of ["find 40 analysts at Google", "who can I network with at Google in SF", "find 25 engineers at Stripe", "who can I network with at Google as a sophomore"]) {
    const o = turn(q, OLD);
    assert.ok(/Building the list now/.test(o.reply), q + ": " + o.reply);
    assert.ok(!/San Francisco|Denver/.test(o.reply) || /SF|San Francisco/.test(q), `old city not assumed: ${q}: ${o.reply}`);
  }
  const o = turn("find 40 analysts at Google", OLD);
  assert.ok(!/San Francisco/.test(o.reply), o.reply);
});

test("a fact stated this sitting still rides into a plan; one from an old sitting does not", () => {
  const fresh = [{ kind: "geography", value: "Chicago", evidence: "in Chicago", at: new Date(NOW - 600000).toISOString() }];
  assert.ok(/Chicago/.test(turn("find 40 analysts at Google", fresh).reply));
  const stale = [{ kind: "geography", value: "Chicago", evidence: "in Chicago", at: "2026-08-01T00:00:00Z" }];
  assert.ok(!/Chicago/.test(turn("find 40 analysts at Google", stale).reply));
});

test("per-firm cap wording and code agree: the reply says there is none, and no code limits a firm", () => {
  const fs = require("node:fs");
  const O = D("124-career-outreach.js");
  const NAMES = ["Aaron Voss", "Bianca Reed", "Carlos Mendez", "Dana Whitfield", "Elias Ford", "Farah Iqbal", "Gavin Holt", "Hana Sato", "Ivan Petrov", "Julia Brandt", "Kwame Mensah", "Lena Fischer", "Marco Ruiz", "Nadia Rahman", "Owen Delacroix", "Priya Natarajan", "Quentin Walsh", "Rosa Lindgren", "Samir Haddad", "Tessa Okafor"];
  const cand = (i) => ({ person_id: "p" + i, full_name: NAMES[i], current_firm: "Goldman Sachs", title: "Analyst", seniority_band: "analyst", geography: "NYC", office: "New York", country: "US", schools: ["DePaul University"], work_email: `p${i}@goldmansachs.com`, email_confidence: 0.9, email_verification: "verified", last_verified_at: "2026-10-01T00:00:00Z" });
  const pool = Array.from({ length: 20 }, (_, i) => cand(i));
  const built = O.buildList(pool, O.parseTarget("20 bulge bracket investment bankers"), { profile: { school: "DePaul University" }, nowMs: Date.parse("2026-10-12T15:00:00Z") });
  assert.equal(built.selected.length, 20, "a list takes every name asked for at one firm");
  const camp = O.createCampaign({ id: "c", userId: "u1", approved: true });
  const res = O.enqueue(camp, pool.map((c) => ({ candidate: c, draft: { subject: "s", body: "b" } })));
  assert.equal(res.filter((r) => r.status === "queued").length, 20, "the queue takes the 16th and 20th at one firm");
  assert.ok(!res.some((r) => /firm_cap/.test(String(r.reason))));
  const src = fs.readFileSync(path.join(ROOT, "packages/domain/124-career-outreach.js"), "utf8");
  assert.ok(!/perFirm/.test(src) && !/per_firm_cap/.test(src), "no per-firm limit in 124");
  assert.equal(O.safetyPlan(camp, null, {}).per_firm_per_30_days, null);
  const g = fs.readFileSync(path.join(ROOT, "packages/domain/135-career-graph.js"), "utf8");
  assert.ok(!/15 sends to one firm/.test(g));
  for (const q of ["is there a per-firm cap?", "what's the per-firm cap"]) {
    const o = turn(q, []);
    assert.ok(/no per-firm cap/i.test(o.reply) && !/at most 15|15 names|reserve/.test(o.reply), o.reply);
  }
});

test("reserve is the rank-ordered remainder when fewer are asked for than are sendable", () => {
  const O = D("124-career-outreach.js");
  const NAMES = ["Aaron Voss", "Bianca Reed", "Carlos Mendez", "Dana Whitfield", "Elias Ford", "Farah Iqbal", "Gavin Holt", "Hana Sato", "Ivan Petrov", "Julia Brandt", "Kwame Mensah", "Lena Fischer"];
  const pool = NAMES.map((n, i) => ({ person_id: "p" + i, full_name: n, current_firm: "Goldman Sachs", title: "Analyst", seniority_band: "analyst", geography: "NYC", office: "New York", country: "US",
    schools: i % 3 === 0 ? ["DePaul University"] : ["Other College"], work_email: `p${i}@goldmansachs.com`, email_confidence: 0.6 + (i % 4) * 0.1, email_verification: "verified", last_verified_at: "2026-10-01T00:00:00Z",
    personalization_facts: i % 2 ? [{ fact: "moved from a prior role", source_url: "https://example.com/" + i, date: "2026-09-15", strength: "strong", topic: "your path" }] : [], relationship_to_user: i % 3 === 0 ? "same school" : "" }));
  const built = O.buildList(pool, O.parseTarget("5 bulge bracket investment bankers"), { profile: { school: "DePaul University" }, nowMs: Date.parse("2026-10-12T15:00:00Z") });
  assert.equal(built.selected.length, 5);
  assert.equal(built.reserve.length, 7, "every other sendable name waits in reserve");
  const total = (c) => c.scores.total;
  assert.ok(Math.min(...built.selected.map(total)) >= Math.max(...built.reserve.map(total)), "nothing in reserve outranks a selected name");
  const sorted = [...built.reserve].sort((a, b) => total(b) - total(a));
  assert.deepEqual(built.reserve.map((c) => c.person_id), sorted.map((c) => c.person_id), "reserve stays in rank order");
  assert.ok(new Set(built.selected.concat(built.reserve).map((c) => c.person_id)).size === 12, "selected plus reserve is the whole sendable list, no name twice");
});
