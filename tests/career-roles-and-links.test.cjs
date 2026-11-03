// MUSE-F-001 (audit 2026-10-22, P0): discovery and batch replies named no roles and carried no links. Live on
// 2026-10-22 the apply reply was the handoff text with no roles and no links, and a discovery shortlist rendered
// names with no link anywhere (its structured payload omitted the url too). This fix reuses PR #145's surfacing:
// the batch card's url passthrough (132) and the loop-writer package's selection listing (155 speakSummary). It adds
// the discovery side: each served role is named with the posting's own link, in the reply and in the shortlist.
// Links come only from the posting itself (url or source url, http(s)); a posting without one is named without
// one, never given an invented link.
// On the base (348c2d4a): no link in either reply, no url in the shortlist, no named selection in the batch reply.
// TEST persona, synthetic postings, sandbox boards only. Check: node --test tests/career-roles-and-links.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const Portal = D("149-career-portal-apply.js");
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));
const CareerProfile = D("122-career-profile.js");

const NOW = Date.parse("2026-10-22T15:00:00.000Z");
const MODS = { CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js") };
const host = CareerHost.createCareerHost(MODS);
const profile = () => CareerProfile.profileFromData(JSON.parse(fs.readFileSync(path.join(root, "packages/career-data/fixtures/gauntlet/profiles/p1-early-career-swe/profile.json"), "utf8")));

// A discovery pool: two with their own links (one as the corpus's url, one as the KB row's source url), one with none.
const POOL = [
  { id: "lk-1", title: "Software Engineer, Backend", company: "Linkline Synthetic", location: "Chicago, IL", remote_terms: "hybrid", requirements: ["Python", "SQL"], url: "https://boards.greenhouse.io/linklinesynthetic/jobs/101" },
  { id: "lk-2", title: "Software Engineer, Platform", company: "Pathway Synthetic", location: "Chicago, IL", remote_terms: "hybrid", requirements: ["Python", "SQL"], url: "https://jobs.lever.co/pathwaysynthetic/8f3c2a1e-4b5d-4c6e-9f70-1a2b3c4d5e6f" }, // a Lever link carries a UUID
  { id: "lk-3", title: "Software Engineer, Tools", company: "Nolink Synthetic", location: "Chicago, IL", remote_terms: "hybrid", requirements: ["Python", "SQL"] },
];

test("F-001/1 discovery: each served role is named with the posting's own link, in the reply and the shortlist; no link is invented", () => {
  const ctx = host.createTurnCtx({ userId: "u-f001", threadId: "t-f001", now: NOW, profile: profile(), postings: POOL });
  const out = host.runTurn("find software engineering roles", ctx);
  const list = (out.result && out.result.shortlist) || [];
  assert.ok(list.length >= 2, `roles were served: ${out.reply}`);
  for (const r of list) {
    const p = POOL.find((x) => x.title === r.title && x.company === r.company);
    assert.ok(p, `served only pool roles: ${r.title}`);
    assert.equal(r.url ?? null, p.url ?? null, `${r.company}: the shortlist carries the posting's own link (or none)`);
    if (p.url) assert.ok(out.reply.includes(p.url), `${r.company}'s link is in the reply: ${out.reply}`);
  }
  const links = out.reply.match(/https?:\/\/\S+/g) || [];
  for (const l of links) assert.ok(POOL.some((p) => p.url && l.startsWith(p.url)), `no link the pool did not carry: ${l}`);
  if (out.reply.includes("at Nolink Synthetic")) assert.match(out.reply, /at Nolink Synthetic — /, "a posting without a link is named without one");
  for (const p of POOL.filter((x) => x.url)) if (out.reply.includes(`at ${p.company}`)) assert.ok(out.reply.includes(`at ${p.company} (${p.url}) — `), `${p.company}: its own link, whole, beside its name`);
});

// A batch market: the apply loop's in-turn path (no worker), sandbox boards.
const FAMS = ["greenhouse", "lever", "ashby"];
const posting = (n) => ({ id: `JOB-L-${n}`, job_id: `JOB-L-${n}`, canonicalKey: `${FAMS[n % 3]}:linkco${n}:software-engineering-intern`, company: `LinkCo ${n}`,
  role: "Software Engineering Intern", title: "Software Engineering Intern", url: n === 2 ? `https://jobs.ashbyhq.com/linkco${n}/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d` : `https://boards.example.test/linkco${n}/jobs/${n}`, status: "open", atsFamily: FAMS[n % 3],
  location: "Chicago, IL", posted_at: "2026-10-18", jd_text: "Software engineering intern role at a test company. JavaScript, testing, code review." });
const MARKET = [1, 2, 3, 4].map(posting);
const MASTER = { basics: { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test" },
  facts: [{ id: "F-T-001", kind: "skill", text: "JavaScript and Node.js development", confirmed: true }, { id: "F-T-003", kind: "education", text: "Computer Science student", confirmed: true }] };
const PORTAL = { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: { work_authorization: { value: "Yes — authorized to work in the US", confirmed: true }, sponsorship: { value: "No", confirmed: true } } };

test("F-001/2 batch: the apply reply names each selected role with its link and where it stands; the card carries the links; nothing submits", () => {
  const log = { records: [] };
  const ctx = host.createTurnCtx({ userId: "u-f001b", threadId: "t-f001b", now: NOW, profile: MASTER, postings: MARKET });
  ctx.portalProfile = PORTAL;
  ctx.batchDeps = { log, boardFor: (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily }), attestations: { certify_true: { value: true, explicit: true } } };
  const out = host.runTurn("apply to 3 software engineering intern roles", ctx);
  assert.equal(out.resultStatus, "awaiting_approval", out.reply);
  assert.match(out.reply, /The 3 selected:/, out.reply);
  const run = ctx.batchApplyState;
  for (const k of run.selected) {
    const a = run.apps[k];
    assert.ok(out.reply.includes(`- ${a.company} — ${a.role} — ${a.url} (ready at the final review screen)`), `${a.company} named with its link: ${out.reply}`);
    assert.ok(MARKET.some((p) => p.url === a.url), "the posting's own link");
  }
  const items = (out.result && out.result.card && out.result.card.items) || run.card.items;
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => MARKET.some((p) => p.url === i.url && p.company === i.company)), `the card carries each posting's link: ${JSON.stringify(items)}`);
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "nothing submitted before the card's yes");
});

test("F-001/3 the shipped bundles carry it", async () => {
  for (const b of ["router_core.career.js"]) {
    const src = fs.readFileSync(path.join(root, "supabase/functions/_shared", b), "utf8");
    assert.match(src, /function postingUrlOf\(p\)/, `${b}: discovery links`);
    assert.match(src, /lines\.push\(`The \$\{selApps\.length\} selected:`\)/, `${b}: the batch's named selection`);
  }
  const career = await import(path.join(root, "supabase/functions/_shared/router_core.career.js"));
  const h = CareerHost.createCareerHost(Object.fromEntries(Object.keys(MODS).map((n) => [n, career[n]])));
  const out = h.runTurn("find software engineering roles", h.createTurnCtx({ userId: "u-f001c", threadId: "t-f001c", now: NOW, profile: profile(), postings: POOL }));
  assert.ok(POOL.filter((p) => p.url).some((p) => out.reply.includes(p.url)), `the career bundle's reply carries links: ${out.reply}`);
});
