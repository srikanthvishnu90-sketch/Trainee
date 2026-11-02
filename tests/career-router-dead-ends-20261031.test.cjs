'use strict';
// ROUTER DEAD ENDS (2026-10-31; scorecard change 11, PRODUCT-AUDIT-2026-10-28 "also seen"). Through the production career
// bundle and host (router_core.career.js + career_host.js), as agent-chat runs it.
// A dead end is a reply that does not act on the message and offers no next step tied to it: the host's unmatched
// fallback ("I may have missed what you meant"), the catch-all's "I'm not sure which part of your search that's about",
// "did not catch", or no reply at all. Assertions are on outcomes (state written, the next step offered), not wording.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "..");

let host;
async function setup() {
  if (host) return;
  const B = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/router_core.career.js")));
  const { CareerHost } = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/career_host.js")));
  host = CareerHost.createCareerHost(B);
}
const copy = (x) => JSON.parse(JSON.stringify(x ?? null));
const RESUME = fs.readFileSync(path.join(ROOT, "packages/career-data/fixtures/test-resume.txt"), "utf8");
const POSTINGS = [
  { id: "gh:1", job_id: "gh:1", company: "Acme", title: "Data Analyst", location: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/1", description: "SQL Python dashboards", first_seen_at: "2026-10-25T00:00:00Z" },
  { id: "gh:2", job_id: "gh:2", company: "Globex", title: "Junior Data Analyst", location: "Chicago, IL", url: "https://jobs.lever.co/globex/2", description: "SQL Excel", first_seen_at: "2026-10-26T00:00:00Z" },
  { id: "gh:3", job_id: "gh:3", company: "Initech", title: "Data Analyst II", location: "Chicago, IL", url: "https://boards.greenhouse.io/initech/jobs/3", description: "SQL", first_seen_at: "2026-10-26T00:00:00Z" },
];

// A person whose thread snapshot and account record persist across turns, as agent-chat's host commit keeps them.
function person(userId = "u-dead") {
  let snap = null, acct = { version: 0, epoch: 0 };
  // opts.minutes: how long after 15:00 the turn arrives; opts.postings: the open postings this turn sees
  const say = (text, opts = {}) => {
    const ctx = host.createTurnCtx({ userId, threadId: `t-${userId}`, now: Date.parse("2026-10-31T15:00:00Z") + (opts.minutes || 0) * 60000, accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(acct), watchState: {}, postings: opts.postings || POSTINGS });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    acct = { ...acct, ...copy(ctx._hostPatch || {}), version: acct.version + 1 };
    return out;
  };
  return { say, snap: () => snap, account: () => acct };
}
const statedFacts = (p) => ((p.account().statedFacts || (p.snap() && p.snap().stores && p.snap().stores.statedFacts) || {}).facts) || [];
const threadOf = (p) => { const st = (p.snap() && p.snap().stores) || {}; for (const v of Object.values(st)) if (v && v._careerThread) return v._careerThread; return {}; };
const DEAD = /may have missed what you meant|not sure which part of your search|did not catch|didn't catch/i;
function isDeadEnd(o) {
  const r = String((o && o.reply) || "").trim();
  return !r || !o.intent || o.intent === "career_fallback" || DEAD.test(r);
}
const questions = (r) => (String(r).match(/\?/g) || []).length;

// 48 first-week messages from a college student job seeker, as typed (typos, shorthand, no punctuation).
const FIRST_WEEK = [
  "hey so im a junior at depaul looking for a summer internship", "im studying finance + cs",
  "can u find me software engineering internships in chicago", "wat jobs r there for data analyst", "i need a job asap pls",
  "how does this work", "what can u do", "do u apply for me", "how much does it cost", "is this free",
  "i dont have a resume yet", "can you make me a resume", "how do i send my resume", "my resume is kinda bad lol",
  "actually my email is jordan.lee22@gmail.com", "actually im a sophomore not a junior", "no i meant marketing not finance",
  "wait thats wrong", "remind me tomorrow to follow up with the recruiter", "remind me friday to apply to google",
  "send an email to the recruiter at acme", "email the recruiter at stripe for me", "can u reach out to someone at jpmorgan",
  "help me prep for my interview at deloitte next week", "give me some behavioral questions",
  "whats the avg salary for a data analyst in chicago", "should i do ib or consulting", "how do i network on campus",
  "write me a cover letter for goldman", "track my apps", "i applied to citadel yesterday", "i got rejected from jp morgan :(",
  "i have an interview w amazon on tuesday!!", "what should i do first", "idk where to start honestly",
  "im an international student do i need sponsorship", "remote only pls", "show me more", "the second one looks good",
  "apply to the first one", "set an alert for product manager internships", "i graduate may 2027", "thx", "ok cool", "nvm",
  "how do i delete my account", "my gpa is 3.4", "can u help me w my linkedin",
];

test("first-week messages: none gets a dead-end reply (fresh person who has stated a goal)", async () => {
  await setup();
  assert.ok(FIRST_WEEK.length >= 40);
  const dead = [];
  for (const m of FIRST_WEEK) {
    const p = person();
    p.say("i want a data analyst internship");
    const o = p.say(m);
    if (isDeadEnd(o)) dead.push(`${m} -> [${o.intent}] ${String(o.reply).slice(0, 120)}`);
  }
  assert.deepEqual(dead, [], `${dead.length}/${FIRST_WEEK.length} dead ends:\n${dead.join("\n")}`);
});

test("follow-ups on a search a new person just ran are bound to that list, not dead ends", async () => {
  await setup();
  for (const m of ["show me more", "more jobs", "the second one looks good", "tell me about the second one", "apply to the first one", "apply to the top 3", "remote only pls"]) {
    const p = person();
    p.say("find data analyst jobs in chicago");
    const o = p.say(m);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${o.reply}`);
  }
});

test("'apply to the first one' with no resume: names the bound role from the list, asks for the resume, starts nothing", async () => {
  await setup();
  const p = person();
  const s = String(p.say("find data analyst jobs in chicago").reply);
  const first = s.match(/([A-Z][A-Za-z ]+ at [A-Z][A-Za-z]+) \(https?:/);
  assert.ok(first, s);
  const o = p.say("apply to the first one");
  const r = String(o.reply);
  assert.ok(r.includes(first[1]), `the role it bound to, from the list shown: ${first[1]} / ${r}`);
  assert.match(r, /resume/i, `the missing step: ${r}`);
  assert.ok(!(o.sends > 0), "nothing sent");
  assert.ok(!o.batchRun && !o.card, "no apply run or approval card starts without a resume");
  assert.ok(!JSON.stringify(p.snap()).includes("batchApplyState\":{"), "no batch state written");
});

test("'tell me about the second one' reads the second role from the list shown, with its link", async () => {
  await setup();
  const p = person();
  const s = String(p.say("find data analyst jobs in chicago").reply);
  const shown = [...s.matchAll(/([A-Z][A-Za-z ]+ at [A-Z][A-Za-z]+) \((https?:[^)]+)\)/g)];
  assert.ok(shown.length >= 2, s);
  const r = String(p.say("tell me about the second one").reply);
  assert.ok(r.includes(shown[1][1]) && r.includes(shown[1][2]), `second role + link: ${r}`);
  assert.ok(questions(r) >= 1, `a next step is offered: ${r}`);
  // the offered next step is real: once the person sends and confirms a resume, it is tailored for that role
  p.say(`here is my resume:\n${RESUME}`);
  const t = p.say("yes thats my resume");
  assert.ok(t.artifact || (t.result && t.result.artifact), `tailored on confirmation: [${t.intent}] ${String(t.reply).slice(0, 160)}`);
  assert.ok(String(t.reply).includes(shown[1][1]), `for the role picked: ${String(t.reply).slice(0, 200)}`);
});

test("'show me more' serves the next roles from the same search, then says when the list is exhausted", async () => {
  await setup();
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `gh:m${i}`, job_id: `gh:m${i}`, company: `Firm${String.fromCharCode(65 + i)}`, title: "Data Analyst", location: "Chicago, IL", url: `https://boards.greenhouse.io/firm${i}/jobs/${i}`, description: "SQL", first_seen_at: "2026-10-26T00:00:00Z" }));
  let snap = null;
  const say = (text) => { const ctx = host.createTurnCtx({ userId: "u-more", threadId: "t-more", now: Date.parse("2026-10-31T15:00:00Z"), snapshot: copy(snap), postings: many }); const o = host.runTurn(text, ctx); snap = copy(host.extractSnapshot(ctx)); return o; };
  const urls = (r) => [...String(r).matchAll(/https:\/\/boards\.greenhouse\.io\/firm\d\/jobs\/\d/g)].map((m) => m[0]);
  const seen = new Set(urls(say("find data analyst jobs in chicago").reply));
  assert.ok(seen.size > 0 && seen.size < many.length, `precondition: the first page is not the whole list (${seen.size})`);
  let fresh = 0;
  for (let i = 0; i < 6; i++) {
    const r = String(say("show me more").reply);
    const u = urls(r);
    if (!u.length) { assert.match(r, /every match/i, r); break; }
    for (const x of u) { assert.ok(!seen.has(x), `no role shown twice: ${x}`); seen.add(x); fresh++; }
  }
  assert.ok(fresh > 0, "more roles were served");
  assert.ok(seen.size <= many.length);
});

test("'remind me ...': honest that no reminder is set, nothing scheduled, one next step; the ask is noted", async () => {
  await setup();
  const cases = [
    [[], "remind me tomorrow to follow up with the recruiter"],
    [[], "remind me friday to apply to google"],
    [["find data analyst jobs in chicago"], "remind me tomorrow to follow up"],
    [[`here is my resume:\n${RESUME}`, "yes thats my resume"], "remind me tomorrow to follow up"],
  ];
  for (const [pre, m] of cases) {
    const p = person();
    for (const x of pre) p.say(x);
    const o = p.say(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: ${r}`);
    assert.equal(o.intent, "honest_unavailable", `${m}: [${o.intent}] ${r}`);
    assert.ok(!/\b(?:I'?ll|I will) remind\b|\breminder (?:is )?(?:set|saved|scheduled)\b/i.test(r), `no reminder is claimed: ${r}`);
    assert.ok(!/Here is what I can do/.test(r) && r.length <= 320, `short, no capability dump (${r.length}): ${r}`);
    assert.equal(questions(r), 1, `one next step: ${r}`);
    const fr = (threadOf(p).frames || {}).declined;
    assert.ok(fr && fr.label === "reminder", `the declined ask is on the thread record: ${JSON.stringify(threadOf(p))}`);
  }
});

test("an offer a new reply ends on is bound: a plain yes runs it; any other turn lets it lapse", async () => {
  await setup();
  const cases = [
    ["remind me tomorrow to follow up with the recruiter", (o) => o.intent === "tracking_status"],
    ["remind me friday to apply to google", (o) => /discovery/.test(o.intent)],
    ["whats the avg salary for a data analyst in chicago", (o) => /discovery/.test(o.intent)],
    ["show me more", (o) => /discovery/.test(o.intent)],
    ["my resume is kinda bad lol", (o) => /paste|attach/i.test(String(o.reply))],
  ];
  for (const [m, ran] of cases) {
    const p = person();
    p.say("i want a data analyst internship");
    p.say(m);
    const o = p.say("yes");
    assert.ok(!isDeadEnd(o) && !/yes to what/i.test(String(o.reply)), `${m} -> yes: [${o.intent}] ${String(o.reply).slice(0, 160)}`);
    assert.ok(ran(o), `${m} -> yes ran the offered step: [${o.intent}] ${String(o.reply).slice(0, 160)}`);
  }
  const p = person();
  p.say("i want a data analyst internship");
  p.say("remind me tomorrow to follow up with the recruiter");
  p.say("thx");
  const o = p.say("yes");
  assert.notEqual(o.intent, "tracking_status", `the offer lapsed after another turn: [${o.intent}] ${String(o.reply).slice(0, 160)}`);
});

test("'email the recruiter at acme': names Acme, invents no firm, sends nothing; with a batch standing the batch is untouched", async () => {
  await setup();
  const check = (o, m) => {
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: ${r}`);
    assert.notEqual(o.intent, "career_batch_apply", `${m}: not the apply batch: ${r}`);
    assert.match(r, /acme/i, `${m}: the firm named: ${r}`);
    assert.ok(!/Goldman|Morgan Stanley|JPMorgan|bulge bracket|investment bankers/i.test(r), `${m}: no firm the person did not name: ${r}`);
    assert.ok(!/a chat yes never submits/i.test(r), r);
    assert.ok(!(o.sends > 0), "nothing sent");
    assert.equal(questions(r), 1, `${m}: one next step: ${r}`);
  };
  for (const m of ["send an email to the recruiter at acme", "email the recruiter at Acme", "message the recruiter at acme for me"]) check(person().say(m), m);
  // with an apply batch standing
  const p = person("u-batch");
  p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
  p.say("find data analyst jobs in chicago");
  p.say("apply to the top 3");
  const batchBefore = JSON.stringify(p.snap()).match(/"batchApplyState":(\{.*?"id":"[^"]+")/);
  assert.ok(batchBefore, "precondition: an apply batch stands");
  const o = p.say("send an email to the recruiter at acme");
  check(o, "with batch");
  const batchAfter = JSON.stringify(p.snap()).match(/"batchApplyState":(\{.*?"id":"[^"]+")/);
  assert.equal(batchAfter && batchAfter[1], batchBefore && batchBefore[1], "the batch record is unchanged");
});

test("corrections and stated facts get an answer, not a fallback; only the person's own facts are written", async () => {
  await setup();
  // a graduation date the person states is recorded in their words and read back
  const recorded = [
    [[], "i graduate may 2027", "graduation", "May 2027"],
    [["i want a job in marketing"], "im graduating in december 2026", "graduation", "December 2026"],
  ];
  for (const [pre, m, kind, value] of recorded) {
    const p = person();
    for (const x of pre) p.say(x);
    const o = p.say(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${r}`);
    assert.notEqual(o.intent, "company_intel", `${m}: ${r}`);
    const f = statedFacts(p).find((x) => x.kind === kind);
    assert.ok(f && f.value.toLowerCase() === value.toLowerCase(), `${m}: ${kind}=${value} stored: ${JSON.stringify(statedFacts(p))}`);
    assert.ok(r.toLowerCase().includes(value.toLowerCase()), `${m}: the recorded value is read back: ${r}`);
  }
  // an email said in chat writes nothing and claims nothing (tests/architect/handler-submit-path b1), but is answered
  const SAVED_CLAIM = /\b(saved|recorded|on file|on your record|stored)\b/i;
  for (const [pre, m, addr] of [[[], "actually my email is jordan.lee22@gmail.com", "jordan.lee22@gmail.com"], [[`here is my resume:\n${RESUME}`, "yes thats my resume"], "actually my email is jordan@x.com", "jordan@x.com"]]) {
    const p = person();
    for (const x of pre) p.say(x);
    const before = JSON.stringify(statedFacts(p));
    const o = p.say(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${r}`);
    assert.ok(!SAVED_CLAIM.test(r), `${m}: claims no write: ${r}`);
    assert.ok(r.includes(addr), `${m}: the address is acknowledged: ${r}`);
    assert.equal(JSON.stringify(statedFacts(p)), before, `${m}: nothing written`);
    const st = (p.snap() && p.snap().stores) || {};
    assert.ok(!JSON.stringify([st.profile || null, st.statedFacts || null, p.account().statedFacts || null, p.account().profile || null]).includes(addr), `${m}: the address is on no profile or fact record`);
    assert.equal(questions(r), 1, `${m}: one next step: ${r}`);
  }
  // a GPA said in chat is never recorded or repeated (architect false_memory rule); it comes from the confirmed resume
  for (const [pre, m, said, resumeGpa] of [[["i want a job in marketing"], "my gpa is 3.4", "3.4", null], [[`here is my resume:\n${RESUME}`, "yes thats my resume"], "actually my gpa is 3.6", "3.6", "3.7"]]) {
    const p = person();
    for (const x of pre) p.say(x);
    const o = p.say(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${r}`);
    assert.ok(!r.includes(said), `${m}: the chat figure is not read back: ${r}`);
    assert.ok(!statedFacts(p).some((f) => f.kind === "gpa"), `${m}: nothing written`);
    if (resumeGpa) {
      assert.ok(r.includes(resumeGpa), `${m}: the confirmed resume's figure is named: ${r}`);
      assert.ok(JSON.stringify(p.snap()).includes(`GPA ${resumeGpa}`), "the confirmed resume entry is unchanged");
    }
    assert.match(r, /resume/i, r);
    assert.equal(questions(r), 1, r);
    const y = p.say("yes");
    assert.match(String(y.reply), /paste|attach/i, `the yes leads to the resume step: ${String(y.reply).slice(0, 120)}`);
  }
});

test("a resume pasted as one paragraph is recognised as a resume, not a company question; nothing is guessed onto the record", async () => {
  await setup();
  const p = person();
  const o = p.say(RESUME.replace(/\s*\n+\s*/g, " "));
  const r = String(o.reply);
  assert.equal(o.intent, "career_resume_ingest", `[${o.intent}] ${r.slice(0, 200)}`);
  assert.equal(o.resultStatus, "awaiting_user");
  assert.ok(!/company file/i.test(r), r);
  // its entries cannot be split without guessing (one job runs into the next), so no draft is written (D-007) ...
  assert.ok(!/"source":"resume-ingest"/.test(JSON.stringify(p.snap())), "no resume entries written from a guess");
  // ... and the next step is the copy that can be read: the paste with its lines, or the file
  assert.match(r, /line breaks|attach/i, r);
  assert.equal(questions(r), 1, r);
  assert.equal(p.say(`here is my resume:\n${RESUME}`).resultStatus, "awaiting_user");
  const held = (JSON.stringify(p.snap()).match(/"source":"resume-ingest"/g) || []).length;
  assert.ok(held >= 10, `the re-paste is read into drafts: ${held}`);
  assert.equal(p.say("yes thats my resume").resultStatus, "completed", "the yes confirms them");
});

// ---------- REVIEW of #350 at 4fa66518 (request changes) ----------
test("review 1: only the person's own, definite graduation is recorded — not a third person's, a negation or a hypothetical", async () => {
  await setup();
  const NOT_THEIRS = [
    "my brother will graduate in may 2027", "my roommate is graduating in may 2027", "she graduates in may 2027", "he'll graduate in 2027",
    "they graduate in may 2027", "my friend said i graduate in may 2027", "my sister graduated in may 2027",
    "i dont graduate in 2027", "i don't graduate in may 2027", "i won't graduate in may 2027", "im not graduating in 2027", "i never graduate in 2027",
    "if i graduate in may 2027", "i might graduate in may 2027", "maybe i graduate in 2027", "i could graduate in 2027", "i hope to graduate in may 2027",
    // the subject is the person, but the statement is hedged or conditional
    "i'll graduate in may 2027 if i pass stats", "im graduating in may 2027 hopefully", "i graduate in 2027 unless i take a gap year", "i will graduate in may 2027, maybe",
  ];
  for (const m of NOT_THEIRS) {
    const p = person();
    const o = p.say(m);
    assert.ok(!statedFacts(p).some((f) => f.kind === "graduation"), `${m}: no graduation fact: ${JSON.stringify(statedFacts(p))}`);
    assert.ok(!/\brecorded\b|on your record/i.test(String(o.reply)), `${m}: nothing called recorded: ${o.reply}`);
  }
  for (const [m, v] of [["i graduate may 2027", "May 2027"], ["i'll graduate in december 2026", "December 2026"], ["actually im graduating in 2027", "2027"], ["im class of 2028", "2028"]]) {
    const p = person();
    p.say(m);
    const f = statedFacts(p).find((x) => x.kind === "graduation");
    assert.ok(f && f.value === v, `${m}: ${JSON.stringify(statedFacts(p))}`);
  }
});

test("review 2: an email said in chat is not promised back later — the reply says nothing was kept", async () => {
  await setup();
  const p = person();
  const r = String(p.say("actually my email is jordan.lee22@gmail.com").reply);
  assert.ok(!/\b(?:I'?ll|I will)\s+(?:show|use|offer|fill|remember|put)\b|\blater\b|\bwhen an application asks\b/i.test(r), `no promise nothing backs: ${r}`);
  assert.match(r, /\b(?:don'?t|do not|didn'?t|did not)\s+keep\b|\bnothing (?:was|is) kept\b/i, `says it is not kept: ${r}`);
});

test("review 3: every reminder offer runs on yes; a list reference is never read as a firm", async () => {
  await setup();
  for (const m of ["remind me tomorrow to call my mom", "remind me friday to update my linkedin", "remind me later to email my professor"]) {
    const p = person();
    p.say("i want a data analyst internship");
    const first = p.say(m);
    assert.equal(questions(first.reply), 1, `${m}: one next step: ${first.reply}`);
    const o = p.say("yes");
    assert.ok(!isDeadEnd(o) && !/yes to what/i.test(String(o.reply)), `${m} -> yes: [${o.intent}] ${String(o.reply).slice(0, 160)}`);
    assert.notEqual(o.intent, "career_catchall", `${m} -> yes ran a step, not the catch-all: ${String(o.reply).slice(0, 160)}`);
  }
  for (const m of ["remind me friday to apply to the top 3", "remind me tomorrow to apply to the first one", "remind me to apply to those jobs"]) {
    const r = String(person().say(m).reply);
    assert.ok(!/\b(?:The )?(?:Top|First|Those|Them)\b/.test(r.replace(/^[^.]*\./, "")) && !/waiting on (?:the|those|them|my)/i.test(r), `${m}: no firm made of a list reference: ${r}`);
  }
});

test("review 4a: an offer lapses after 30 minutes; inside the window a yes still runs it", async () => {
  await setup();
  for (const [mins, runs] of [[29, true], [31, false]]) {
    const p = person();
    p.say("i want a data analyst internship");
    p.say("remind me tomorrow to follow up with the recruiter");
    const o = p.say("yes", { minutes: mins });
    assert.equal(o.intent === "tracking_status", runs, `${mins} min: [${o.intent}] ${String(o.reply).slice(0, 120)}`);
  }
});

test("review 4b: with a resume on record, 'apply to the first one' never asks for a resume, even when the posting has left the list", async () => {
  await setup();
  const p = person("u-apply-gone");
  p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
  p.say("find data analyst jobs in chicago");
  const o = p.say("apply to the first one", { postings: [] });
  const r = String(o.reply);
  assert.ok(!isDeadEnd(o), `[${o.intent}] ${r}`);
  assert.ok(!/need your resume|send (?:me )?your resume|paste your resume/i.test(r), `the resume on record is not asked for again: ${r}`);
  assert.ok(!o.batchRun && !(o.sends > 0), "nothing started or sent");
  assert.equal(questions(r), 1, r);
});

// ---------- RE-REVIEW of #350 at 2ca41d4a6 ----------
test("re-review 1: with a resume, 'apply to #1' for a posting still open runs the apply flow; only a posting really gone is said to be gone", async () => {
  await setup();
  for (const m of ["apply to #1", "apply to the first one", "apply to 1"]) {
    const p = person(`u-open-${m.length}`);
    p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
    p.say("find data analyst jobs in chicago");
    const o = p.say(m); // the posting is still in the open postings this turn sees
    const r = String(o.reply);
    assert.ok(!/isn'?t in the open postings|aren'?t in the open postings|left the list/i.test(r), `${m}: no claim it has left while it is open: ${r}`);
    assert.equal(o.intent, "career_batch_apply", `${m}: the apply flow runs: [${o.intent}] ${r.slice(0, 160)}`);
    assert.ok(!(o.sends > 0), "nothing sent");
  }
  const p = person("u-gone");
  p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
  p.say("find data analyst jobs in chicago");
  const g = p.say("apply to #1", { postings: POSTINGS.slice(1) }); // the first posting has left
  assert.match(String(g.reply), /isn'?t in the open postings/i, String(g.reply));
  assert.notEqual(g.intent, "career_batch_apply", "nothing started for a posting that is gone");
});

test("re-review 2: an unsaved graduation message gets an on-topic reply, asks for the person's own date once, and that answer is saved", async () => {
  await setup();
  for (const m of ["my brother will graduate in may 2027", "i might graduate in may 2027", "i dont graduate in 2027"]) {
    const p = person();
    const o = p.say(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${r}`);
    assert.notEqual(o.intent, "company_intel", `${m}: not an eligibility answer: ${r}`);
    assert.ok(!/not stated|eligib|cutoff|company file/i.test(r), `${m}: on topic: ${r}`);
    assert.match(r, /graduat/i, `${m}: about graduation: ${r}`);
    assert.ok(!/\brecorded\b|on your record|\bsaved (?:it|that|your)/i.test(r), `${m}: nothing claimed saved: ${r}`);
    assert.ok(!statedFacts(p).some((f) => f.kind === "graduation"));
    assert.equal(questions(r), 1, `${m}: asks once: ${r}`);
    // the answer to that one question is the person's own date
    p.say("may 2028");
    const f = statedFacts(p).find((x) => x.kind === "graduation");
    assert.ok(f && f.value === "May 2028", `the answer is saved: ${JSON.stringify(statedFacts(p))}`);
    // asked once: a second unsaved message does not ask again
    const again = String(p.say("my sister graduates in 2026").reply);
    assert.equal(questions(again), 0, `not asked twice: ${again}`);
  }
  // the question is asked once even when it goes unanswered
  const u = person("u-unanswered");
  assert.equal(questions(u.say("my brother will graduate in may 2027").reply), 1);
  u.say("ok");
  const twice = String(u.say("my cousin graduates in 2026").reply);
  assert.equal(questions(twice), 0, `the unanswered question is not asked again: ${twice}`);
  // with the person's own date already on record, nothing is asked
  const q = person("u-has-grad");
  q.say("i graduate may 2028");
  const r = String(q.say("my roommate will graduate in may 2027").reply);
  assert.ok(!/when do you graduate/i.test(r), r);
  assert.equal(statedFacts(q).find((x) => x.kind === "graduation").value, "May 2028", "the person's own date is untouched");
});

module.exports = { FIRST_WEEK, isDeadEnd };
