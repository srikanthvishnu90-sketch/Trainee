// Career outreach engine (Doc 1, OUTR-001..008 / OUTE-001..013). Transports below are MOCK transports,
// labeled mock, used only inside these tests — no real email is ever sent by this suite.
// Check: node --test tests/career-outreach.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
const M = require(path.join(root, "packages/domain/124-career-outreach.js"));
const FIRM_SETS = JSON.parse(fs.readFileSync(path.join(root, "packages/career-data/firm-sets.json"), "utf8"));
const USER = { name: "Vishnu Srikanth", school: "DePaul University", year: "sophomore", year_label: "'28", experience: "running a campus investing club" };
const nowMs = Date.parse("2026-10-12T15:00:00Z");
function cand(o) {
  return Object.assign({ person_id: "p1", full_name: "Daniel Kim", current_firm: "Evercore", title: "Analyst", seniority_band: "analyst",
    geography: "NYC", office: "New York", country: "US", schools: ["DePaul University"], work_email: "daniel.kim@evercore.com",
    email_confidence: 0.9, email_verification: "verified", last_verified_at: "2026-10-01T00:00:00Z",
    personalization_facts: [{ fact: "spent a year at a search fund before joining Evercore", source_url: "https://example.com/bio", date: "2026-09-01", strength: "strong", topic: "your search-fund-to-Evercore path" }], relationship_to_user: "same school" }, o || {});
}
// T-87 replay (FIN-E-002): subject-less verb-phrase facts must render as a
// grammatical sentence in the draft — never "I saw that worked on a a …".
test("FIN-E-002 replay: draft personalization clause supplies the subject", () => {
  const deal = cand({ personalization_facts: [{ fact: "worked on a a sponsor-backed carve-out at Evercore", source_url: "https://example.com/deal", date: "2026-09-01", strength: "strong", kind: "deal", topic: "the a sponsor-backed carve-out work" }] });
  const d1 = M.draftFor(deal, USER);
  assert.match(d1.body, /I saw that you worked on a sponsor-backed carve-out at Evercore/);
  assert.doesNotMatch(d1.body, /\ba a\b|\bthe a\b/);
  const pres = cand({ personalization_facts: [{ fact: "publishes ML tooling on GitHub (TEST fact)", source_url: "https://example.com/gh", date: "2026-09-01", strength: "strong", kind: "deal", topic: "your open-source work" }] });
  assert.match(M.draftFor(pres, USER).body, /I saw that you publish ML tooling on GitHub/);
  const you = cand({ personalization_facts: [{ fact: "you love sailing", source_url: "https://example.com/s", date: "2026-09-01", strength: "strong", kind: "deal", topic: "sailing" }] });
  assert.match(M.draftFor(you, USER).body, /I saw that you love sailing/);
});

// MOCK transport (tests only): dedupes by idempotency key like a correct provider adapter must.
function mockTransport(onSend) {
  const sent = new Map(); const t = { kind: "mock", calls: 0, sent,
    hasSent: async (k) => sent.has(k),
    send: async (msg) => { t.calls++; if (onSend) await onSend(msg, sent.size); if (sent.has(msg.idempotencyKey)) return { messageId: sent.get(msg.idempotencyKey), duplicate_prevented: true }; const id = "mock-" + (sent.size + 1); sent.set(msg.idempotencyKey, id); return { messageId: id }; } };
  return t;
}
function campaignWith(n, opts) {
  opts = opts || {}; const c = M.createCampaign({ id: "camp-1", userId: "u1", approved: true });
  const entries = []; for (let i = 0; i < n; i++) entries.push({ candidate: cand({ person_id: "p" + i, full_name: "Person " + i, work_email: `person${i}@firm${i % 7}.com`, current_firm: "Firm" + (i % 7) }), draft: { subject: "s" + i, body: "b" + i, tier: "B" } });
  M.enqueue(c, entries, opts); return c;
}

// OUTE-001 / OUTR parsing
test("OUTE-001 parse: canonical prompts P1/P2/P3", () => {
  const p1 = M.parseTarget("Create me a list of 500 bulge bracket investment bankers, come up with a good networking email, then email them");
  assert.equal(p1.count, 500); assert.equal(p1.firm_set, "bulge_bracket"); assert.equal(p1.industry, "investment_banking"); assert.ok(p1.firms.includes("Goldman Sachs"));
  const p2 = M.parseTarget("Find 100 PMs at Series B-D startups in NYC who went to my school and message them", { school: "University of Michigan" });
  assert.equal(p2.count, 100); assert.equal(p2.role_family, "product_management"); assert.equal(p2.geography, "NYC"); assert.equal(p2.school_filter, "University of Michigan"); assert.deepEqual(p2.background_filters.startup_stage, ["B", "C", "D"]);
  const p3 = M.parseTarget("I want coffee chats with associates at McKinsey, Bain, BCG. Get me 40.");
  assert.equal(p3.count, 40); assert.equal(p3.firm_set, "mbb"); assert.equal(p3.seniority_band, "associate"); assert.equal(p3.industry, "consulting");
});
test("OUTE-001 vague ask gets a proposed default, shown; EU/UK exclusion is always on", () => {
  const q = M.parseTarget("email some bankers for me");
  assert.equal(q.vague, true); assert.ok(q.proposed_default && q.proposed_default.firm_set === "bulge_bracket");
  assert.ok(q.exclusions.includes("geo:EU_UK"));
});
test("firm-sets.json: BB with Credit Suisse merged-into-UBS note, boutiques, MM, MBB, FAANG+, quant, Big 4", () => {
  const cs = FIRM_SETS.sets.bulge_bracket.firms.find((f) => f.name === "Credit Suisse");
  assert.ok(cs && /merged into UBS/i.test(cs.note) && cs.status === "historical");
  for (const k of ["elite_boutique", "middle_market", "mbb", "faang_plus", "quant", "big4"]) assert.ok(FIRM_SETS.sets[k].firms.length >= 3, k);
  assert.equal(FIRM_SETS.sets.mbb.firms.length, 3);
  assert.deepEqual(Object.keys(M.FIRM_SETS.sets).sort(), Object.keys(FIRM_SETS.sets).sort());
});
test("OUTE-007/OUTR-008 decided caps: start 10-15, ceiling 30 (not 40), agent refuses to raise", () => {
  assert.ok(M.dailyCapForDay(0) >= 10 && M.dailyCapForDay(0) <= 15);
  assert.equal(M.dailyCapForDay(30), 30); assert.equal(M.CAPS.ceilingPerDay, 30); assert.equal(M.CAPS.userCanRaise, false);
  assert.equal(M.refuseRaiseCap(40).refused, true); assert.equal(M.refuseRaiseCap(500).refused, true); assert.equal(M.refuseRaiseCap(25).refused, false);
  assert.match(M.refuseRaiseCap(100).reason, /30\/day/);
});

// OUTE-002/004 pipeline
test("OUTE-002 identity resolution: exact merge, ambiguous and school-mismatch go to review, never the send list", () => {
  const a = cand({ source_list: ["export"] });
  const b = cand({ work_email: null, email_confidence: 0.5, source_list: ["vendor"], personalization_facts: [{ fact: "spoke at a Ross finance panel", source_url: "https://example.com/p", strength: "medium" }] });
  const r = M.resolveCandidates([a, b]);
  assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].personalization_facts.length, 2); assert.deepEqual(r.candidates[0].source_list.sort(), ["export", "vendor"]);
  const amb = M.resolveCandidates([cand({}), cand({ full_name: "Daniel Kym", work_email: "x@evercore.com" })]); // fuzzy, below hard threshold, same firm
  assert.equal(amb.candidates.length, 1); assert.equal(amb.review.length, 1); assert.equal(amb.review[0].review_reason, "ambiguous_identity");
  const mis = M.resolveCandidates([cand({}), cand({ schools: ["Other University"], work_email: "y@evercore.com" })]);
  assert.equal(mis.review.length, 1);
});
test("OUTE-002/004 buildList: hygiene exclusions, yield report, per-firm cap, review card", () => {
  const records = [];
  const NAMES = ["Aaron Voss", "Bianca Reed", "Carlos Mendez", "Dana Whitfield", "Elias Ford", "Farah Iqbal", "Gavin Holt", "Hana Sato", "Ivan Petrov", "Julia Brandt", "Kwame Mensah", "Lena Fischer", "Marco Ruiz", "Nadia Rahman", "Owen Delacroix", "Priya Natarajan", "Quentin Walsh"];
  for (let i = 0; i < 17; i++) records.push(cand({ person_id: "gs" + i, full_name: NAMES[i], current_firm: "Goldman Sachs", work_email: `gs${i}@goldmansachs.com` }));
  records.push(cand({ person_id: "own", full_name: "Oscar Wynn", current_firm: "My Firm", work_email: "a@myfirm.com" }));
  records.push(cand({ person_id: "old", full_name: "Peter Aldous", work_email: "old@evercore.com", contacted_before: true }));
  records.push(cand({ person_id: "eu", full_name: "Sofia Lindqvist", geography: "London", office: "London", country: "GB", work_email: "eu@evercore.com" }));
  records.push(cand({ person_id: "opt", full_name: "Trevor Nash", work_email: "opt@evercore.com", opt_out: true }));
  records.push(cand({ person_id: "noemail", full_name: "Uma Ferreira", work_email: null }));
  const supp = M.createSuppressionStore(); supp.suppress({ email: "sup@evercore.com", scope: "shared" });
  records.push(cand({ person_id: "sup", full_name: "Victor Hale", work_email: "sup@evercore.com" }));
  const pool = M.buildList(records, M.parseTarget("500 bulge bracket investment bankers"), { profile: { school: "DePaul University", current_employer: "My Firm" }, suppression: supp, userId: "u1", nowMs });
  assert.equal(pool.yield.found, 23); assert.equal(pool.selected.filter((c) => c.current_firm === "Goldman Sachs").length, 17); // no per-firm cap (owner NO LIMITS)
  assert.equal(pool.reserve.length, 0, "reserve existed only for the per-firm limit; with none, every sendable name is selected"); assert.equal(pool.exclusions.own_employer, 1); assert.equal(pool.exclusions.already_emailed, 1);
  assert.equal(pool.exclusions.eu_uk, 1); assert.equal(pool.exclusions.opt_out, 1); assert.equal(pool.exclusions.suppressed, 1); assert.equal(pool.exclusions.no_email, 1);
  const card = M.listReviewCard(pool, null);
  assert.ok(card.sample_rows.length <= 10); assert.match(card.text, /Found 23; trusted emails/); assert.ok(card.breakdown.by_firm["Goldman Sachs"] === 17);
});
test("OUTR-001/002 warm paths rank alumni first and show the path", () => {
  const rows = M.warmPaths([cand({ full_name: "Cold One", schools: ["Elsewhere"], relationship_to_user: "none" }), cand({ full_name: "Alum One", relationship_to_user: "same school and club" })], "Evercore", { school: "DePaul University" });
  assert.equal(rows[0].person, "Alum One"); assert.match(rows[0].path, /alumni/);
  const mem = M.relationshipMemory([{ full_name: "Alum One", stage: "call_booked", next_touch_at: "2026-10-01", last_summary: "chatted" }]);
  assert.equal(mem.talkedTo()[0].stage, "call_booked"); assert.equal(mem.dueForPing("2026-10-12").length, 1);
});

// OUTE-003 verification seam
test("OUTE-003 local verifier: syntax / no-MX invalid, catch-all risky, MX ok verified; vendor plugs into same interface", async () => {
  const dns = async (d) => d === "nomx.com" ? { mx: [] } : d === "catchall.com" ? { mx: ["mx"], catchAll: true } : { mx: ["mx1"] };
  const v = M.createVerifier({ dnsLookup: dns });
  assert.equal((await v.verify("not-an-email")).status, "invalid");
  assert.equal((await v.verify("a@nomx.com")).status, "invalid");
  assert.equal((await v.verify("a@catchall.com")).status, "risky");
  assert.equal((await v.verify("a@evercore.com")).status, "verified");
  assert.equal((await M.createVerifier({}).verify("a@evercore.com")).status, "risky"); // no DNS injected: honest risky, nothing invented
  const vendor = M.createVerifier({ vendor: { verify: async (e) => ({ email: e, status: "verified", verifier: "vendor-mock" }) } }); // mock vendor, tests only
  assert.equal(vendor.kind, "vendor"); assert.equal((await vendor.verify("a@b.com")).verifier, "vendor-mock");
});

// OUTE-005/006 drafts + gate
test("OUTE-005/006 Tier A draft: real-fact slots with why-this-line sources, <=120 words, gate passes; plain student voice default; NO opt-out line by default (owner order 2026-10-13 supersedes the old footer expectation — OPT_OUT_LINE stays exported for suppression)", () => {
  const { draft, gate, queued } = M.draftAndGate(cand({}), USER, { nowMs });
  assert.equal(draft.tier, "A"); assert.ok(draft.body.split(/\s+/).length <= 120); assert.ok(!draft.body.includes(M.OPT_OUT_LINE), "drafts carry no opt-out line by default (owner order 2026-10-13)"); assert.equal(typeof M.OPT_OUT_LINE, "string");
  assert.equal(draft.why_this_line[0].source_url, "https://example.com/bio"); assert.ok(draft.body.includes("search fund"));
  assert.deepEqual(M.VOICE_DEFAULT, { formality: 0.3, warmth: 0.6, humor: 0, directness: 0.7, plain_student_voice: true });
  assert.equal(gate.pass, true, gate.failures.join(",")); assert.equal(queued, true);
});
test("OUTE-005 fake referral can NEVER enter a draft (Doc 1 S9); unverified referral facts are dropped", () => {
  const c = cand({ personalization_facts: [{ fact: "a Goldman MD told me to reach out to you", source_url: "https://example.com/x", strength: "strong", kind: "referral", verified: false }] });
  const d = M.draftFor(c, USER);
  assert.ok(!/told me to reach out/i.test(d.body)); assert.equal(d.dropped_unsourced[0].reason, "unverified_referral_claim");
  const evil = Object.assign({}, M.draftFor(cand({}), USER), { body: M.draftFor(cand({}), USER).body + "\nA Goldman MD told me to reach out." });
  const g = M.qualityGate(evil, cand({}), { nowMs });
  assert.equal(g.pass, false); assert.ok(g.failures.includes("fabricated_referral"));
});
test("OUTE-005 stale title fails the quality gate (regression: stale title replay)", () => {
  const stale = cand({ latest_title: "Associate" }); // record title says Analyst, latest says Associate
  const { gate, queued } = M.draftAndGate(stale, USER, { nowMs });
  assert.equal(gate.pass, false); assert.ok(gate.failures.includes("stale_title")); assert.equal(queued, false);
  const flagged = cand({ title_stale: true }); assert.ok(M.qualityGate(M.draftFor(flagged, USER), flagged, { nowMs }).failures.includes("stale_title"));
});
test("OUTE-005 gate: banned phrase, duplicate body, >1 link, invented fact all fail; a missing opt-out footer does NOT fail (owner order 2026-10-13 removed missing_opt_out_footer)", () => {
  const good = M.draftFor(cand({}), USER);
  const withBanned = Object.assign({}, good, { body: good.body + " I hope this email finds you well." });
  assert.ok(M.qualityGate(withBanned, cand({}), {}).failures.some((f) => f.startsWith("banned_phrase")));
  assert.ok(M.qualityGate(good, cand({}), { batchBodies: [{ person_id: "other", body: good.body }] }).failures.includes("duplicate_body"));
  assert.ok(M.qualityGate(Object.assign({}, good, { body: good.body + " https://a.com/x https://b.com/y" }), cand({}), {}).failures.some((f) => f.startsWith("too_many_links")));
  assert.ok(!M.qualityGate(good, cand({}), {}).failures.includes("missing_opt_out_footer"), "no opt-out footer is required (owner order 2026-10-13)");
  const invented = Object.assign({}, good, { why_this_line: [{ line: "x", fact: "you love sailing", source_url: "https://example.com/nope" }] });
  assert.ok(M.qualityGate(invented, cand({}), {}).failures.some((f) => f.startsWith("fact_not_in_record")));
});
test("OUTR-003/007 referral ask needs sourced shared context; intro request carries a forwardable blurb", () => {
  assert.equal(M.draftReferralAsk(cand({}), USER, {}).ok, false);
  const ok = M.draftReferralAsk(cand({}), USER, { shared_context: { fact: "we are both DePaul finance majors", source_url: "https://example.com/dir" } });
  assert.equal(ok.ok, true); assert.ok(!ok.draft.body.includes(M.OPT_OUT_LINE), "referral asks carry no opt-out line by default (owner order 2026-10-13)");
  assert.equal(M.draftIntroRequest(cand({}), cand({ full_name: "Target Person" }), USER, "").ok, false);
  assert.ok(M.draftIntroRequest(cand({}), cand({ full_name: "Target Person" }), USER, "blurb text").draft.body.includes("blurb text"));
});

// OUTE-007/008/009 queue
test("OUTE-007/008 enqueue: suppression, EU/UK, invalid rejected; follow-up needs a continue tap; per-firm enqueue cap", () => {
  const supp = M.createSuppressionStore(); supp.suppress({ email: "person0@firm0.com", scope: "shared" });
  const c = campaignWith(3, { suppression: supp });
  assert.equal(c.items.filter((i) => i.status === "queued").length, 2);
  const c2 = M.createCampaign({ id: "c2", userId: "u1", approved: true });
  const fu = M.enqueue(c2, [{ candidate: cand({}), draft: { subject: "s", body: "b" }, touch: 1 }]);
  assert.equal(fu[0].status, "rejected"); assert.equal(fu[0].reason, "followup_needs_continue_tap");
  const ok = M.enqueue(c2, [{ candidate: cand({}), draft: { subject: "s", body: "b" }, touch: 1 }], { continueTap: true }); assert.equal(ok[0].status, "queued");
  const eu = M.enqueue(c2, [{ candidate: cand({ person_id: "eu1", geography: "London", country: "GB", work_email: "e@londonbank.co.uk" }), draft: { subject: "s", body: "b" } }]);
  assert.equal(eu[0].reason, "eu_uk_excluded_v1");
});
test("OUTE-007 wave 1: top 40 over days, daily + per-domain caps and 2-8 min gaps modeled, risky <=10% of a day", () => {
  const c = campaignWith(40);
  for (let i = 0; i < 5; i++) c.items[i].verification = "risky";
  const plan = M.planWave(c, { seed: 7 });
  assert.equal(plan.wave_items, 40); assert.ok(plan.days >= 2 && plan.days <= 4, "days=" + plan.days);
  assert.ok(plan.deferred.length >= 1 && plan.deferred[0].reason === "risky_over_10pct_of_wave"); // 5 risky in a 40-wave exceeds the 10% risky rule: excess deferred, wave not stretched
  for (const d of plan.daily_caps) assert.ok(d.planned <= d.cap);
  const byDomainDay = {}; for (const s of plan.schedule) { const item = c.items.find((i) => i.id === s.item_id); const k = s.day_index + ":" + item.domain; byDomainDay[k] = (byDomainDay[k] || 0) + 1; assert.ok(s.gap_minutes_after_previous >= 2 && s.gap_minutes_after_previous <= 8); }
  for (const k of Object.keys(byDomainDay)) assert.ok(byDomainDay[k] <= 4, k);
  const day0 = plan.schedule.filter((s) => s.day_index === 0); const risky0 = day0.filter((s) => c.items.find((i) => i.id === s.item_id).verification === "risky").length;
  assert.ok(risky0 <= Math.floor(M.dailyCapForDay(0) * 0.10), `risky day0 ${risky0}`);
});
test("OUTE-007 send requires approval; under SEND_DISABLED every send refuses at the sink — retry NEVER sends at all", async () => {
  // RE-POINTED 2026-10-14 (bug-law audit §9 item 5): email sending is
  // HARD-DISABLED by owner ruling (2026-10-13) — the pre-ruling legs
  // asserted mock-transport sends. The contract now: approval is
  // still required first, and past the gate the sink refuses every
  // send with SEND_DISABLED; the transport is never invoked, so a
  // crash-retry replay can never double-send — it can never send.
  const draftCamp = M.createCampaign({ id: "cx", userId: "u1" }); M.enqueue(draftCamp, [{ candidate: cand({}), draft: { subject: "s", body: "b" } }]);
  assert.equal((await M.sendPending(draftCamp, { transport: mockTransport() })).error, "campaign_not_approved");
  const c = campaignWith(5); const t = mockTransport();
  const r1 = await M.sendPending(c, { transport: t });
  assert.equal(r1.sent, 0); assert.equal(r1.refused, true); assert.match(String(r1.error), /SEND_DISABLED/); assert.equal(t.calls, 0); assert.equal(t.sent.size, 0);
  for (const i of c.items) i.status = "queued"; // simulated retry after a crash replays the whole queue
  const r2 = await M.sendPending(c, { transport: t });
  assert.equal(r2.sent, 0); assert.equal(r2.refused, true); assert.equal(t.calls, 0); assert.equal(t.sent.size, 0);
});
test("OUTE-008 T5-style forced opt-out MID-QUEUE: 0 further sends to that person (severity-1)", async () => {
  // RE-POINTED 2026-10-14 (audit §9 item 5): the opt-out lands while
  // the campaign sits queued; under SEND_DISABLED the send run then
  // refuses at the sink — the opted-out person gets 0 sends, and so
  // does everyone else; the suppression itself is recorded and held.
  const supp = M.createSuppressionStore(); const c = campaignWith(10, { suppression: supp });
  const target = c.items[5];
  supp.suppress({ email: target.email, person_id: target.person_id, scope: "both", reason: "stop" });
  const t = mockTransport();
  const r = await M.sendPending(c, { transport: t, suppression: supp });
  assert.equal(r.sent, 0); assert.equal(r.refused, true); assert.match(String(r.error), /SEND_DISABLED/);
  assert.equal(t.calls, 0); assert.ok(![...t.sent.keys()].some((k) => k.includes(target.person_id)));
  assert.equal(supp.isSuppressed({ email: target.email, person_id: target.person_id }, c.userId), true);
});
test("OUTE-008 shared cross-user suppression: a stop anywhere suppresses for every user; only the opt-out fact is shared", () => {
  const supp = M.createSuppressionStore();
  const campA = M.createCampaign({ id: "a", userId: "userA", approved: true });
  M.handleReply(campA, { body: "Please stop emailing me." }, cand({}), { suppression: supp });
  assert.equal(supp.isSuppressed({ email: "daniel.kim@evercore.com" }, "userB"), true); // different user, same recipient: suppressed
  assert.deepEqual(Object.keys(supp.toJSON()).sort(), ["perUserEmails", "perUserIds", "sharedEmails", "sharedIds"]); // no campaign data in the shared store
});
test("OUTE-009 circuit breaker: bounce spike, 2 hostile signals, provider warning all pause with a cause for the user", () => {
  const c = M.createCampaign({ id: "cb", userId: "u1", approved: true });
  for (let i = 0; i < 100; i++) M.recordOutcome(c, { type: "sent" });
  for (let i = 0; i < 6; i++) M.recordOutcome(c, { type: "bounce" }); // 6% > 3%
  assert.equal(c.breaker.tripped, true); assert.equal(c.status, "paused"); assert.match(c.breaker.user_message, /bounce/);
  const c2 = M.createCampaign({ id: "cb2", userId: "u1", approved: true }); M.recordOutcome(c2, { type: "hostile" }); M.recordOutcome(c2, { type: "hostile" }); assert.equal(c2.breaker.tripped, true);
  const c3 = M.createCampaign({ id: "cb3", userId: "u1", approved: true }); M.recordOutcome(c3, { type: "provider_warning" }); assert.equal(c3.breaker.tripped, true);
});
test("OUTE-008 hard bounce suppresses and never retries; crash-safe export/import keeps sent state", async () => {
  // RE-POINTED 2026-10-14 (audit §9 item 5): the bounce/suppression
  // legs are unchanged; the send legs now assert the SEND_DISABLED
  // refusal — nothing is sent, so the restored state holds zero sent
  // items, and a 'sending'-stranded item is never recovered into a
  // send: the sink refuses first.
  const supp = M.createSuppressionStore(); const c = campaignWith(3, { suppression: supp });
  const item = c.items[0]; M.recordOutcome(c, { type: "hard_bounce", item, suppression: supp });
  assert.equal(item.status, "bounced"); assert.equal(item.never_retry, true); assert.equal(supp.isSuppressed({ email: item.email }, "u1"), true);
  const t = mockTransport(); const rr0 = await M.sendPending(c, { transport: t, suppression: supp });
  assert.equal(rr0.refused, true); assert.match(String(rr0.error), /SEND_DISABLED/); assert.equal(t.calls, 0);
  const restored = M.importState(M.exportState(c));
  assert.deepEqual(restored.sentKeys, c.sentKeys); assert.equal(restored.items.filter((i) => i.status === "sent").length, 0);
  const c2 = campaignWith(1); c2.items[0].status = "sending"; const t2 = mockTransport(); t2.sent.set(c2.items[0].idempotencyKey, "mock-pre");
  const rr = await M.sendPending(c2, { transport: t2 }); assert.equal(rr.refused, true); assert.match(String(rr.error), /SEND_DISABLED/); assert.equal(t2.calls, 0); assert.notEqual(c2.items[0].status, "sent");
});
test("OUTE-007 follow-ups: continue tap gates the wave; plan caps at 2 and stops on reply/bounce/opt-out", () => {
  // The scheduleFollowUps legs are send-independent and unchanged.
  // The send that used to precede them now refuses SEND_DISABLED
  // (re-pointed 2026-10-14, audit §9 item 5) — asserted inline.
  const c = campaignWith(2); return M.sendPending(c, { transport: mockTransport() }).then((sr) => {
    assert.equal(sr.refused, true); assert.match(String(sr.error), /SEND_DISABLED/);
    assert.equal(M.scheduleFollowUps(c, {}).needs_continue_tap, true);
    const ok = M.scheduleFollowUps(c, { continueTap: true }); assert.equal(ok.ok, true);
    // The plan is honestly EMPTY: its entries are built from sent
    // items, and under SEND_DISABLED nothing is ever sent. (The
    // max-2 / stop-on plan semantics apply to sent items and are
    // unreachable while sending is disabled — by design.)
    assert.equal(ok.plan.length, 0);
  });
});

// OUTE-010 classifier replay (T6-style)
const REPLIES = [
  ["Happy to chat, Thursday works for me", "positive-ready"], ["Sure, let's schedule a call next week", "positive-ready"], ["I'm free Tuesday at 5, that works", "positive-ready"],
  ["Would be happy to talk, Monday works", "positive-ready"], ["Yes, glad to chat — Wednesday works", "positive-ready"], ["Let's talk, I'm available Friday", "positive-ready"],
  ["Interested — send me more info on what you'd like to discuss", "positive-needs-info"], ["Tell me more about what you are hoping to cover", "positive-needs-info"],
  ["Send more details and I can see", "positive-needs-info"], ["I'm curious but need more context first", "positive-needs-info"], ["Can you send me more info about the chat?", "positive-needs-info"],
  ["You should talk to Priya Shah about that group", "referral-to-other"], ["Reach out to Daniel Kim, he runs that team", "referral-to-other"],
  ["Speak with Maya Patel instead, she knows it better", "referral-to-other"], ["Looping in Jordan Lee here", "referral-to-other"], ["I can connect you with Alex Chen", "referral-to-other"],
  ["Thanks but not a good time for me", "polite-decline"], ["I'm too busy right now, no thanks", "polite-decline"], ["Unfortunately I can't right now", "polite-decline"],
  ["Not able to help, sorry", "polite-decline"], ["Maybe another time, I have to pass on this", "polite-decline"],
  ["Please stop emailing me", "hard-stop"], ["Remove me from your list", "hard-stop"], ["Unsubscribe me", "hard-stop"],
  ["Do not contact me again", "hard-stop"], ["Stop contacting me", "hard-stop"], ["No more emails, please", "hard-stop"],
  ["This is spam, go away", "hostile"], ["Leave me alone", "hostile"], ["Never contact me again, this is harassment", "hostile"],
  ["I'm reporting you for spam", "hostile"], ["This is a scam, fuck off", "hostile"],
  ["I'm out of office until October 20", "auto-reply-ooo"], ["On vacation, back on November 3", "auto-reply-ooo"],
  ["I am on PTO and return January 12", "auto-reply-ooo"], ["Currently traveling with limited access to email until December 1", "auto-reply-ooo"],
  ["Delivery Status Notification: this message could not be delivered, user unknown", "bounce"], ["Undeliverable: mailbox full, delivery has failed", "bounce"],
  ["What school do you go to?", "question-about-user"], ["Can you tell me about your experience so far?", "question-about-user"],
];
test("OUTE-010 T6-style: 40 synthetic replies, 100% on stop/hostile, >=90% overall", () => {
  assert.equal(REPLIES.length, 40);
  let correct = 0; const stopHostile = REPLIES.filter(([, e]) => e === "hard-stop" || e === "hostile");
  let shCorrect = 0; const misses = [];
  for (const [body, expected] of REPLIES) { const got = M.classifyReply({ body }, { nowMs }).classification; if (got === expected) correct++; else misses.push(body + " -> " + got + " want " + expected); if ((expected === "hard-stop" || expected === "hostile") && got === expected) shCorrect++; }
  assert.equal(shCorrect, stopHostile.length, misses.join(" | "));
  assert.ok(correct / REPLIES.length >= 0.9, `only ${correct}/40: ` + misses.join(" | "));
});
test("OUTE-010 OOO parses a return date, reschedules the follow-up, and never counts as a reply", () => {
  const r = M.classifyReply({ body: "I'm out of office until October 20" }, { nowMs });
  assert.equal(r.classification, "auto-reply-ooo"); assert.equal(r.return_date, "2026-10-20"); assert.equal(r.reschedule_followup_on, "2026-10-21"); assert.equal(r.counts_as_reply, false);
  const camp = M.createCampaign({ id: "oo", userId: "u1", approved: true });
  const out = M.handleReply(camp, { body: "On vacation, back on November 3" }, cand({}), {});
  assert.equal(out.reschedule_followup_on, "2026-11-04"); assert.equal(camp.stats.replies, 0);
});

// OUTE-011/012 booking + follow-through
test("OUTE-011 slot proposal is DST-correct in the recipient timezone (spring/fall offsets differ)", () => {
  assert.equal(M.zonedTimeToUtc(2026, 10, 30, 9, 0, "America/New_York"), "2026-10-30T13:00:00.000Z"); // EDT
  assert.equal(M.zonedTimeToUtc(2026, 11, 2, 9, 0, "America/New_York"), "2026-11-02T14:00:00.000Z"); // EST after Nov 1 fallback
  assert.equal(M.zonedTimeToUtc(2026, 3, 9, 9, 0, "America/Chicago"), "2026-03-09T14:00:00.000Z"); // CDT after Mar 8 spring forward
});
test("OUTE-011 slots respect free/busy + 15-min buffer and blackout dates", () => {
  const slots = M.proposeSlots({ nowMs: Date.parse("2026-10-29T12:00:00Z"), recipientTz: "America/New_York", userTz: "America/Chicago",
    freeBusy: [{ start: "2026-10-30T13:00:00Z", end: "2026-10-30T14:30:00Z" }], blackoutDates: ["2026-11-02"], count: 3 });
  assert.equal(slots.length, 3);
  assert.ok(!slots.some((s) => s.start.startsWith("2026-11-02"))); // blacked out (recipient date)
  assert.ok(!slots.some((s) => s.start === "2026-10-30T13:00:00.000Z" || s.start === "2026-10-30T14:00:00.000Z")); // busy + buffer spill to 10:00 slot start (14:00Z is within buffered window)
  assert.ok(slots.every((s) => s.buffer_minutes === 15));
});
test("OUTE-012 prep brief from a CIR-shaped input; thank-you needs a real note; follow-up touch lands 4-8 weeks out", () => {
  const brief = M.prepBrief({ contact: cand({}), cir: { path: "Search fund -> Evercore", talking_points: ["a", "b", "c", "d"], questions: ["q1", "q2", "q3", "q4", "q5", "q6"], what_not_to_ask: ["x"] }, user_goal: "learn M&A" });
  assert.equal(brief.talking_points.length, 3); assert.equal(brief.questions.length, 5); assert.deepEqual(brief.what_not_to_ask, ["x"]); assert.match(brief.who, /Daniel Kim/);
  assert.equal(M.thankYouDraft({ contact: cand({}) }).ok, false);
  const ty = M.thankYouDraft({ contact: cand({}), note: "Your point about staffing in TMT stuck with me.", user: USER }); assert.ok(ty.draft.body.includes("staffing in TMT"));
  const touch = M.scheduleFollowUpTouch({ chatDate: "2026-10-12T00:00:00Z" }); assert.equal(touch.weeks, 6); assert.equal(touch.next_touch_at.slice(0, 10), "2026-11-23");
  assert.equal(M.scheduleFollowUpTouch({ chatDate: "2026-10-12T00:00:00Z", weeks: 99 }).weeks, 8);
});

// OUTE-013 + Gmail shape + OUTR-004 send rail shape
test("OUTE-013 metrics: yield, verified, bounce, reply, positive, meetings, referrals, per-tier rates", () => {
  const c = campaignWith(10); c.stats.replies = 2; c.stats.positive = 1; c.stats.meetings_booked = 1; c.stats.referrals = 1;
  for (const i of c.items) i.status = "sent"; c.items[0].status = "bounced";
  const m = M.campaignMetrics({ pool: { found: 100, sendable: 50, trusted_emails: 60 }, campaign: c, replies: [{ tier: "B" }, { tier: "A" }] });
  assert.equal(m.yield_pct, 50); assert.equal(m.verified_rate_pct, 60); assert.equal(m.reply_pct, 20); assert.equal(m.positive_pct, 10);
  assert.equal(m.meetings_booked, 1); assert.equal(m.referrals, 1); assert.ok(m.per_tier_reply_rates.B.rate_pct > 0);
});
test("OUTR-004 Gmail transport shape rides an injected Gmail API client; absent client is NOT_WIRED (mock API, tests only)", async () => {
  assert.equal((await M.createGmailTransport(null).send({ to: "a@b.com", subject: "s", body: "b" })).error.startsWith("NOT_WIRED"), true);
  // RE-POINTED 2026-10-14 (audit §9 item 5): with a client injected,
  // the transport is constructed DISABLED — its send refuses with
  // SEND_DISABLED and the Gmail client is never invoked.
  let seen = null; const mockGmail = { users: { messages: { send: async (req) => { seen = req; return { id: "gmail-mock-1" }; } } } }; // mock Gmail API, tests only
  const t = M.createGmailTransport(mockGmail); const r = await t.send({ to: "a@firm.com", subject: "Hi", body: "Body text" });
  assert.equal(t.disabled, true); assert.equal(r.refused, true); assert.match(String(r.error), /SEND_DISABLED/);
  assert.equal(seen, null, "the Gmail client is never invoked while sending is disabled");
  assert.equal(M.CAPS.channel, "gmail_oauth_only");
});

// ---------- W3 replays (gauntlet correction program, 2026-10-13) ----------
// Each test below is a replay of a verified fail-before case against the
// generator/QA in 124, in the FIN-E-002 replay style above.
// W3 (a) replay: EVERY fact shape from scripts/career/scenarios/_w01-lib.cjs
// factFor (path/school/deal/build/panel/hometown/major/competition/github)
// renders a grammatical "I saw that you <finite verb> ..." line — no "a a",
// no "the a", no subject-less verb phrase.
test("W3 (a) replay: every _w01-lib fact shape renders a grammatical personalization line", () => {
  const shapes = [
    ["path", { fact: "moved from a prior role to Evercore as a Analyst", topic: "your path into Evercore", strength: "strong" }, "I saw that you moved from a prior role to Evercore as an Analyst"],
    ["school", { fact: "studied at State University before joining Evercore", topic: "your time at State University and the move to Evercore", strength: "medium" }, "I saw that you studied at State University before joining Evercore"],
    ["deal", { fact: "worked on a sponsor-backed carve-out at Evercore", topic: "the sponsor-backed carve-out work", strength: "strong" }, "I saw that you worked on a sponsor-backed carve-out at Evercore"],
    ["build", { fact: "built a recruiting dashboard at Evercore", topic: "building a recruiting dashboard", strength: "strong" }, "I saw that you built a recruiting dashboard at Evercore"],
    ["panel", { fact: "spoke on a alumni panel about Analyst work at Evercore", topic: "your panel comments on Analyst work", strength: "medium" }, "I saw that you spoke on an alumni panel about Analyst work at Evercore"],
    ["hometown", { fact: "grew up in Chicago, IL before Evercore", topic: "growing up in Chicago, IL and landing at Evercore", strength: "medium" }, "I saw that you grew up in Chicago, IL before Evercore"],
    ["major", { fact: "majored in Economics before joining Evercore", topic: "coming from Economics into Evercore", strength: "medium" }, "I saw that you majored in Economics before joining Evercore"],
    ["competition", { fact: "competed in competition math before joining Evercore", topic: "competition math and the move to Evercore", strength: "strong" }, "I saw that you competed in competition math before joining Evercore"],
    ["github", { fact: "publishes open-source ML tooling on GitHub while at Evercore", topic: "your GitHub work on open-source ML tooling", strength: "strong" }, "I saw that you publish open-source ML tooling on GitHub"],
  ];
  for (const [kind, f, line] of shapes) {
    const d = M.draftFor(cand({ personalization_facts: [Object.assign({ source_url: "https://example.com/" + kind, date: "2026-09-15" }, f)] }), USER);
    assert.ok(d.body.includes(line), kind + ": expected line <" + line + "> in body:\n" + d.body);
    assert.match(d.body, /I saw that you (moved|studied|worked|built|spoke|grew|majored|competed|publish)\b/, kind);
    assert.doesNotMatch(d.body, /\ba a\b|\bthe a\b/, kind);
  }
});
// W3 (b) replay: four USERS fixtures' experience strings (synthetic
// stand-ins in the _w01-lib shapes — scrub follow-up 2026-10-20). No
// body may contain "I'm currently a " (the SC-013 defect: "I'm currently a
// sophomore summer analyst stint ...").
test("W3 (b) replay: experience-line composition is grammatical for all four _w01-lib USERS fixtures", () => {
  const users = {
    alex: { name: "Alex Testcase (TEST)", school: "TEST University", year: "sophomore", year_label: "'28", experience: "building a shift-scheduling tool used by 300 students at a campus recreation center" },
    jordanWharton: { name: "Jordan Lee (TEST)", school: "Wharton School, University of Pennsylvania", year: "junior", year_label: "'27", experience: "a summer operations internship at a regional freight company, where I built routing models on three live accounts" },
    samFreshman: { name: "Sam Ortiz (TEST)", school: "large state university (TEST)", year: "freshman", year_label: "'29", experience: "a member of my school's finance club" },
    morganVP: { name: "Morgan Hale (TEST)", school: "TEST University", year: "", year_label: "", experience: "eleven years in commercial real estate, most recently as a director leading portfolio acquisitions" },
  };
  for (const [k, u] of Object.entries(users)) assert.doesNotMatch(M.draftFor(cand({}), u).body, /I'm currently a /, k);
  assert.ok(M.draftFor(cand({}), users.alex).body.includes("I'm currently building a shift-scheduling tool used by 300 students at a campus recreation center."));
  assert.ok(M.draftFor(cand({}), users.jordanWharton).body.includes("Most recently, I completed a summer operations internship at a regional freight company, where I built routing models on three live accounts."));
  assert.ok(M.draftFor(cand({}), users.samFreshman).body.includes("I'm a member of my school's finance club."));
  assert.ok(M.draftFor(cand({}), users.morganVP).body.includes("I have eleven years in commercial real estate, most recently as a director leading portfolio acquisitions."));
  assert.doesNotMatch(M.draftFor(cand({}), users.morganVP).body, /I'm currently/);
});
// W3 (c) replay: article agreement (a -> an before a vowel sound) on the
// rendered personalization line and the ask topic — Analyst, Associate,
// Engineer contexts; University keeps "a" (consonant onset).
test("W3 (c) replay: article agreement — an Analyst / an Associate / an Engineer, a university", () => {
  const mk = (title, firm) => cand({ title, current_firm: firm, work_email: "x@" + firm.toLowerCase() + ".com", personalization_facts: [{ fact: `moved from a prior role to ${firm} as a ${title}`, source_url: "https://example.com/p", date: "2026-09-15", strength: "strong", topic: `your path into ${firm}` }] });
  assert.ok(M.draftFor(mk("Analyst", "Evercore"), USER).body.includes("as an Analyst"));
  assert.ok(M.draftFor(mk("Associate", "Blackstone"), USER).body.includes("as an Associate"));
  assert.ok(M.draftFor(mk("Engineer", "Evercore"), USER).body.includes("as an Engineer"));
  const uni = M.draftFor(cand({ personalization_facts: [{ fact: "built a university mentorship program at Evercore", source_url: "https://example.com/u", date: "2026-09-15", strength: "strong", topic: "a engineering mentorship program" }] }), USER);
  assert.ok(uni.body.includes("built a university mentorship program"), uni.body);
  assert.doesNotMatch(uni.body, /an university/i);
  assert.ok(uni.body.includes("an engineering mentorship program"), "ask topic gets the same article pass: " + uni.body);
});
// W3 (d) replay: topic sanitizer — "their product" is the recipient's
// product ("your product"); a bare title / "Title at Firm" topic is not a
// topic and falls back to "your work at <firm>".
test("W3 (d) replay: topic sanitizer — their->your; title-only topic falls back to your work at <firm>", () => {
  const build = M.draftFor(cand({ personalization_facts: [{ fact: "built their product's first version at Evercore", source_url: "https://example.com/b", date: "2026-09-15", strength: "strong", topic: "building their product's first version" }] }), USER);
  assert.ok(build.body.includes("building your product's first version"), build.body);
  assert.ok(!build.body.includes("building their product"), build.body);
  for (const topic of ["Analyst at Evercore", "Analyst"]) {
    const d = M.draftFor(cand({ personalization_facts: [{ fact: "spent a year at a search fund before joining Evercore", source_url: "https://example.com/bio", date: "2026-09-01", strength: "strong", topic }] }), USER);
    assert.ok(d.body.includes("talk about your work at Evercore"), topic + " -> " + d.body);
    assert.ok(!d.body.includes("talk about Analyst at Evercore"), topic);
  }
});
// W3 (e) replay: fact/body binding — a hand-swapped body line fails
// fact_body_mismatch; a cited fact that is not among the candidate's
// sourced facts fails; a path topic over a hometown cited fact fails
// topic_not_in_fact (the owner's case).
test("W3 (e) replay: fact/body binding — swapped line and unsourced cited fact fail; hometown fact + path topic fails topic_not_in_fact", () => {
  const good = M.draftFor(cand({}), USER);
  const g0 = M.qualityGate(good, cand({}), {});
  assert.ok(!g0.failures.includes("fact_body_mismatch"), g0.failures.join(","));
  assert.ok(!g0.failures.includes("topic_not_in_fact"), g0.failures.join(","));
  const swapped = Object.assign({}, good, { body: good.body.replace("I saw that you spent a year at a search fund before joining Evercore", "I saw that you worked on a mining deal at Evercore") });
  assert.ok(M.qualityGate(swapped, cand({}), {}).failures.includes("fact_body_mismatch"));
  const invented = Object.assign({}, good, { fact_used: { fact: "you love sailing", source_url: "https://example.com/nope" } });
  assert.ok(M.qualityGate(invented, cand({}), {}).failures.includes("fact_body_mismatch"));
  const home = cand({ personalization_facts: [{ fact: "grew up in Chicago, IL before Evercore", source_url: "https://example.com/h", date: "2026-09-15", strength: "medium", topic: "growing up in Chicago, IL and landing at Evercore" }] });
  const hd = M.draftFor(home, USER);
  assert.ok(!M.qualityGate(hd, home, {}).failures.includes("topic_not_in_fact"));
  const badTopic = Object.assign({}, hd, { ask_topic: "your path into Evercore" });
  assert.ok(M.qualityGate(badTopic, home, {}).failures.includes("topic_not_in_fact"));
});
// W3 (f) replay: the bare move template is generic and can never make
// Tier A — a path-fact-only candidate is not Tier A; a deal-fact candidate
// keeps Tier A; a specific prior firm keeps a path fact specific; a school
// fact stays B.
test("W3 (f) replay: generic bare-move fact cannot make Tier A; deal fact keeps A; school fact stays B", () => {
  assert.equal(M.isGenericFact("moved from a prior role to Evercore as a Analyst"), true);
  assert.equal(M.isGenericFact("moved from Goldman Sachs to Evercore as an Analyst"), false);
  assert.equal(M.isGenericFact("worked on a sponsor-backed carve-out at Evercore"), false);
  const pathOnly = cand({ schools: [], relationship_to_user: "none", personalization_facts: [{ fact: "moved from a prior role to Evercore as a Analyst", source_url: "https://example.com/p", date: "2026-09-15", strength: "strong", topic: "your path into Evercore" }] });
  assert.notEqual(M.determineTier(pathOnly, USER), "A");
  const deal = cand({ personalization_facts: [{ fact: "worked on a sponsor-backed carve-out at Evercore", source_url: "https://example.com/d", date: "2026-09-15", strength: "strong", kind: "deal", topic: "the sponsor-backed carve-out work" }] });
  assert.equal(M.determineTier(deal, USER), "A");
  const specificPath = cand({ schools: [], relationship_to_user: "none", personalization_facts: [{ fact: "moved from Goldman Sachs to Evercore as an Analyst", source_url: "https://example.com/p2", date: "2026-09-15", strength: "strong", topic: "your path into Evercore" }] });
  assert.equal(M.determineTier(specificPath, USER), "A");
  const school = cand({ personalization_facts: [{ fact: "studied at DePaul University before joining Evercore", source_url: "https://example.com/s", date: "2026-09-15", strength: "medium", topic: "your time at DePaul University and the move to Evercore" }] });
  assert.equal(M.determineTier(school, USER), "B");
});
// W3 (g) replay: placeholder injection (brackets / BLURB / "(fact F-...)")
// is a HARD BLOCK at the gate, the draft is gate_failed, and the draft
// store's approve() refuses it. Plus production (TEST) markers and a stray
// mid-sentence capital verb.
test("W3 (g) replay: placeholder injection hard-blocks at the gate and approve() refuses the stored draft", () => {
  const evil = cand({ personalization_facts: [{ fact: "worked on [Project X] (fact F-002) at Evercore", source_url: "https://example.com/e", date: "2026-09-15", strength: "strong", topic: "the BLURB work" }] });
  const store = M.createDraftStore();
  const r = M.draftAndGate(evil, USER, { nowMs, draftStore: store });
  assert.ok(r.gate.failures.includes("placeholder_content"), r.gate.failures.join(","));
  assert.equal(r.status, "gate_failed");
  assert.ok(r.draft_id);
  const ap = store.approve(r.draft_id);
  assert.equal(ap.ok, false); assert.equal(ap.reason, "gate_failed");
  const good = M.draftFor(cand({}), USER);
  const withTest = Object.assign({}, good, { body: good.body + " (TEST)" });
  assert.ok(M.qualityGate(withTest, cand({}), { mode: "production" }).failures.includes("test_marker_in_production"));
  assert.ok(!M.qualityGate(withTest, cand({}), {}).failures.includes("test_marker_in_production"));
  const stray = Object.assign({}, good, { body: good.body + "\n\nThe team Shipped the model last spring." });
  assert.ok(M.qualityGate(stray, cand({}), {}).failures.includes("stray_mid_sentence_capital"));
  assert.ok(!M.qualityGate(good, cand({}), {}).failures.includes("stray_mid_sentence_capital"));
});
// W3 (h) replay: subject >60 chars fails at generation on EVERY draft
// path — referral asks and intro requests are capped too — and the gate
// catches a hand-made 70-char subject regardless of path.
test("W3 (h) replay: referral ask and intro request subjects are capped at 60; gate catches a 70-char subject", () => {
  const longUser = Object.assign({}, USER, { school: "Wharton School, University of Pennsylvania, Graduate Division of Arts and Sciences" });
  const ref = M.draftReferralAsk(cand({}), longUser, { shared_context: { fact: "we are both DePaul finance majors", source_url: "https://example.com/dir" } });
  assert.equal(ref.ok, true); assert.ok(ref.draft.subject.length <= 60, ref.draft.subject + " (" + ref.draft.subject.length + ")");
  const intro = M.draftIntroRequest(cand({}), cand({ full_name: "Alexandrina Featherstonehaugh-Willoughby", current_firm: "International Business Machines Corporation Worldwide" }), USER, "blurb text");
  assert.equal(intro.ok, true); assert.ok(intro.draft.subject.length <= 60, intro.draft.subject);
  const good = M.draftFor(cand({}), USER);
  const long70 = Object.assign({}, good, { subject: "S".repeat(70) });
  assert.equal(long70.subject.length, 70);
  assert.ok(M.qualityGate(long70, cand({}), {}).failures.includes("subject_too_long"));
  assert.ok(!M.qualityGate(good, cand({}), {}).failures.includes("subject_too_long"));
});
// W3 (i) replay: no opt-out line in any draft path by default (owner
// order 2026-10-13); structure variation — 5 drafts to one firm, one per
// structure, pass the batch shared-skeleton check; 2 drafts of the SAME
// structure to the same firm fail it on the second.
test("W3 (i) replay: opt-out line gone from all paths; structures vary; shared_skeleton batch gate", async () => {
  const facts = [
    { fact: "worked on a sponsor-backed carve-out at Evercore", topic: "the sponsor-backed carve-out work", strength: "strong", kind: "deal" },
    { fact: "built a recruiting dashboard at Evercore", topic: "building a recruiting dashboard", strength: "strong" },
    { fact: "competed in competition math before joining Evercore", topic: "competition math and the move to Evercore", strength: "strong" },
    { fact: "publishes open-source ML tooling on GitHub while at Evercore", topic: "your GitHub work on open-source ML tooling", strength: "strong" },
    { fact: "spoke on a alumni panel about Analyst work at Evercore", topic: "your panel comments on Analyst work", strength: "medium" },
  ];
  const mkCand = (i) => cand({ person_id: "sk" + i, full_name: "Skeleton Person" + i, work_email: `sk${i}@evercore.com`, personalization_facts: [Object.assign({ source_url: "https://example.com/sk" + i, date: "2026-09-15" }, facts[i])] });
  const drafts = facts.map((_, i) => M.draftFor(mkCand(i), USER, { structureIndex: i }));
  for (const d of drafts) assert.ok(!d.body.includes(M.OPT_OUT_LINE), d.structure);
  const swampedCount = drafts.filter((d) => d.body.includes("Totally understand if you're swamped.")).length;
  assert.ok(swampedCount <= 1, "swamped line in " + swampedCount + " structures");
  const askParas = new Set(drafts.map((d) => d.body.split("\n\n")[3]));
  assert.ok(askParas.size >= 3, "distinct ask templates: " + askParas.size);
  const intros = new Set(drafts.map((d) => d.body.split("\n\n")[1].split(". ")[0]));
  assert.ok(intros.size >= 3, "distinct self-intro framings: " + intros.size);
  for (let i = 0; i < drafts.length; i++) {
    const g = M.qualityGate(drafts[i], mkCand(i), { batchDrafts: drafts });
    assert.ok(!g.failures.some((f) => f.startsWith("shared_skeleton")), "structure " + drafts[i].structure + ": " + g.failures.join(","));
    assert.equal(g.pass, true, "structure " + drafts[i].structure + ": " + g.failures.join(","));
  }
  const same1 = M.draftFor(mkCand(0), USER, { structureIndex: 0 });
  const same2 = M.draftFor(mkCand(1), USER, { structureIndex: 0 });
  const g2 = M.qualityGate(same2, mkCand(1), { batchDrafts: [same1, same2] });
  assert.ok(g2.failures.some((f) => f.startsWith("shared_skeleton")), g2.failures.join(","));
  // follow-up drafts carry no opt-out line either — under
  // SEND_DISABLED (re-pointed 2026-10-14, audit §9 item 5) no send
  // can happen, so no follow-up can be earned: the run refuses at
  // the sink and runFollowUps honestly produces none. (Follow-up
  // DRAFT shape is guarded by the W3 (i) follow-up-path replay.)
  const camp = M.createCampaign({ id: "w3-i", userId: "u1", approved: true });
  const entries = [0, 1].map((i) => ({ candidate: mkCand(i), draft: drafts[i] }));
  M.enqueue(camp, entries);
  const sr = await M.sendPending(camp, { transport: mockTransport() });
  assert.equal(sr.refused, true); assert.match(String(sr.error), /SEND_DISABLED/);
  const fu = M.runFollowUps(camp, { touch: 1, continueTap: true });
  assert.ok(!fu.followups || fu.followups.length === 0, "no follow-ups exist when nothing was ever sent");
});
// W3 (j) replay (owner order 2026-10-13: Tier C is HELD by default — this
// supersedes any earlier expectation that a Tier C draft sits at
// awaiting_approval): a no-facts candidate is Tier C even though the
// record carries a geography (the old geography->B branch in
// determineTier was the bug the coordinator's replay surfaced), its
// draft is held with held_reason tier_c_no_sourced_fact, and approve()
// refuses it on both store paths.
test("W3 (j) replay: no-sourced-fact candidate is Tier C, held by default, approve() refuses (owner order 2026-10-13)", () => {
  const noFacts = cand({ full_name: "No Facts", schools: [], relationship_to_user: "none", personalization_facts: [] });
  assert.equal(M.determineTier(noFacts, USER), "C", "geography alone must not make a no-fact record Tier B");
  const store = M.createDraftStore();
  const r = M.draftAndGate(noFacts, USER, { nowMs, draftStore: store });
  assert.equal(r.draft.tier, "C");
  assert.equal(r.status, "held"); assert.equal(r.held_reason, "tier_c_no_sourced_fact"); assert.equal(r.queued, false);
  assert.equal(store.get(r.draft_id).status, "held");
  assert.equal(store.approve(r.draft_id).ok, false);
  const store2 = M.createDraftStore();
  const rec = store2.put(r.draft, {});
  assert.equal(rec.status, "held");
  const ap = store2.approve(rec.id);
  assert.equal(ap.ok, false); assert.equal(ap.reason, "draft_held"); assert.equal(ap.held_reason, "tier_c_no_sourced_fact");
});
// W3 (l) replay: the NW03 defect — a departed recipient (former_employer_
// note present, title_stale false, recently verified) drafted cleanly to
// awaiting_approval. Now: normalizeCandidate carries the departed fields,
// the gate fails recipient_departed, the draft is held, approve() refuses.
test("W3 (l) replay: NW03 departed recipient — gate fails recipient_departed, draft held, approve() refuses", () => {
  const norm1 = M.normalizeCandidate({ former_employer_note: "Left X June 2025", latest_title: "Engineer at OtherCo", title_stale: true });
  assert.equal(norm1.former_employer_note, "Left X June 2025"); assert.equal(norm1.latest_title, "Engineer at OtherCo"); assert.equal(norm1.title_stale, true);
  assert.equal(M.normalizeCandidate({}).former_employer_note, "");
  const departed = cand({ full_name: "Jordan Park", current_firm: "Acme Robotics (TEST)", title: "Engineer (TEST)", work_email: "jordan.park@acme.test", title_stale: false, last_verified_at: "2026-09-20T00:00:00Z",
    former_employer_note: "Left Acme Robotics (TEST) June 2025; current role unknown (TEST ground truth)",
    personalization_facts: [{ fact: "built a robotics demo at Acme Robotics (TEST)", source_url: "https://example.com/d", date: "2026-09-15", strength: "strong", topic: "your robotics work" }] });
  const store = M.createDraftStore();
  const r = M.draftAndGate(departed, USER, { nowMs, draftStore: store });
  assert.ok(r.gate.failures.includes("recipient_departed"), r.gate.failures.join(","));
  assert.equal(r.status, "held"); assert.equal(r.held_reason, "recipient_departed");
  assert.equal(store.approve(r.draft_id).ok, false);
  const staleOtherFirm = cand({ title_stale: true, latest_title: "Engineer at OtherCo" });
  assert.ok(M.qualityGate(M.draftFor(staleOtherFirm, USER), staleOtherFirm, {}).failures.includes("recipient_departed"));
});
// W3 (m) replay: relative-date phrases are QA defects (owner rule
// 2026-10-13 — dates must be absolute or verified true at send time).
// "since last fall" fails anywhere; "since September 2025" passes.
test("W3 (m) replay: relative_date_phrase fails 'since last fall'; absolute 'since September 2025' passes", () => {
  const rel = cand({ personalization_facts: [{ fact: "worked on a sponsor-backed carve-out at Evercore since last fall", source_url: "https://example.com/r", date: "2026-09-15", strength: "strong", topic: "the sponsor-backed carve-out work" }] });
  const rd = M.draftFor(rel, USER);
  assert.ok(rd.body.includes("since last fall"));
  assert.ok(M.qualityGate(rd, rel, {}).failures.includes("relative_date_phrase"));
  const abs = cand({ personalization_facts: [{ fact: "studied at DePaul University since September 2025", source_url: "https://example.com/a", date: "2026-09-15", strength: "medium", topic: "your time at DePaul University" }] });
  const ad = M.draftFor(abs, USER);
  assert.ok(ad.body.includes("since September 2025"));
  assert.ok(!M.qualityGate(ad, abs, {}).failures.includes("relative_date_phrase"));
});

// W3 (i) replay, follow-up path: runFollowUps used to emit ONE identical body
// for every recipient (and it invented a user fact — "I just finished a
// project modeling a company in your coverage area"). Bodies must now vary
// per recipient, carry no opt-out line, and assert no invented project.
test("W3 (i) replay: follow-up drafts vary per recipient — no shared skeleton, no opt-out line, no invented project claim", () => {
  const mk = (pid, name, email, touch) => ({ id: "it-" + pid, person_id: pid, email, status: "sent", touch, tier: "A",
    candidate: { person_id: pid, full_name: name, current_firm: "Evercore", title: "Analyst", work_email: email },
    draft: { subject: "Question about Analyst at Evercore", body: "orig" }, message_id: "m-" + pid, idempotencyKey: "k-" + pid });
  const camp = M.createCampaign({ approved: true });
  camp.items = [mk("pa", "Ann A", "ann@evercore.com", 0), mk("pb", "Bob B", "bob@evercore.com", 0), mk("pc", "Cat C", "cat@evercore.com", 0)];
  const r = M.runFollowUps(camp, { continueTap: true, touch: 1 });
  assert.equal(r.ok, true);
  const bodies = r.followups.map((f) => f.draft.body);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 3, "follow-up bodies must differ per recipient");
  for (const b of bodies) { assert.doesNotMatch(b, /rather not hear from me/); assert.doesNotMatch(b, /modeling a company/); }
  const camp2 = M.createCampaign({ approved: true });
  camp2.items = [mk("pa", "Ann A", "ann@evercore.com", 1), mk("pb", "Bob B", "bob@evercore.com", 1)];
  const fin = M.runFollowUps(camp2, { continueTap: true, touch: 2 });
  assert.equal(fin.final, true);
  const fb = fin.followups.map((f) => f.draft.body);
  assert.equal(fb.length, 2);
  assert.notEqual(fb[0], fb[1], "final closes vary too");
  for (const b of fb) assert.match(b, /close the loop/);
});
