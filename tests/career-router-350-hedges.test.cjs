'use strict';
// Review of #350 at 0666c3bfc (2026-11-01), through the production career bundle and host as agent-chat runs it.
// 1. D-007: a hedged or two-way graduation date is not the person's definite fact, so nothing is saved ("i think i graduate
//    may 2027", "prob may 2027", "idk maybe may 2027", "tentatively may 2027", "i guess may 2027", "may 2027 or dec 2027"),
//    whether said on its own or as the answer to "When do you graduate?". A plain date is still saved.
// 2. "apply to the top one" for a posting that has left the open postings gets the same honest reply as "apply to #1":
//    named as not open, nothing started, the search offered again; never a dead end and never a resume ask.
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
function person(userId) {
  let snap = null, acct = { version: 0, epoch: 0 };
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
const grad = (p) => statedFacts(p).find((f) => f.kind === "graduation");
const DEAD = /may have missed what you meant|not sure which part of your search|did not catch|didn't catch/i;
const isDeadEnd = (o) => { const r = String((o && o.reply) || "").trim(); return !r || !o.intent || o.intent === "career_fallback" || DEAD.test(r); };

const HEDGED = [
  "i think i graduate may 2027", "i think im graduating in may 2027", "i graduate may 2027 i think", "prob may 2027", "i prob graduate may 2027",
  "i probably graduate in may 2027", "idk maybe may 2027", "idk i graduate may 2027", "i graduate may 2027 idk", "tentatively may 2027",
  "i graduate may 2027 tentatively", "im tentatively graduating in may 2027", "i guess may 2027", "i guess i graduate may 2027",
  "maybe may 2027", "i graduate may 2027 maybe", "may 2027 or dec 2027", "i graduate may 2027 or dec 2027", "im graduating in may or december 2027",
  "i graduate in 2027 or 2028", "i graduate may 2027/dec 2027", "i graduate may 2027 prob", "i graduate may 2027 probs", "i graduate may 2027?? not sure",
  "i graduate may 2027 not sure", "im not sure, may 2027", "i graduate may 2027 i believe", "i graduate around may 2027", "i graduate may 2027 ish",
  "i graduate may 2027 i guess", "i graduate may 2027 i suppose", "i graduate 2027ish", "i graduate may 2027 likely", "i graduate may 2027 possibly",
  "i graduate may 2027, or maybe later", "i graduate spring or fall 2027",
  // re-review at 1aea792d: a hedge in another sentence of the same message, and the words that still saved
  "i graduate may 2027. i think", "i graduate may 2027! i think", "i graduate may 2027; maybe", "i graduate may 2027, not sure",
  "not sure - i graduate may 2027", "idk. i graduate may 2027", "i graduate may 2027. not 100% sure though", "i graduate may 2027. probably",
  "i graduate may 2027. or dec 2027", "maybe. i graduate may 2027", "i graduate may 2027\ni think", "i graduate may 2027 — i guess",
  "i prolly graduate may 2027", "i graduate may 2027 prolly", "i graduate may 2027 or december", "i graduate may 2027 or dec 27",
  "i graduate may 2027 or thereabouts", "i graduate may 2027 or dec '27", "i graduate may 2027. or thereabouts",
];

test("review 1 (D-007): a hedged or two-way graduation date is never saved, said on its own", async () => {
  await setup();
  for (const m of HEDGED) {
    const p = person(`u-h-${m}`);
    const o = p.say(m);
    assert.ok(!grad(p), `${m}: nothing saved: ${JSON.stringify(statedFacts(p))}`);
    // a graduation statement that is not saved is still answered on topic (the one "When do you graduate?" ask)
    if (/graduat/.test(m)) assert.ok(!isDeadEnd(o) && /graduat/i.test(String(o.reply)), `${m}: [${o.intent}] ${o.reply}`);
  }
});

test("review 1 (D-007): a hedged answer to 'When do you graduate?' is never saved; a plain one is", async () => {
  await setup();
  for (const ans of ["prob may 2027", "idk maybe may 2027", "may 2027 or dec 2027", "i think may 2027", "tentatively may 2027", "i guess may 2027", "maybe may 2027", "may 2027 i think", "probably may 2027", "may or dec 2027"]) {
    const p = person(`u-a-${ans}`);
    p.say("my brother will graduate in may 2027"); // asks "When do you graduate?" once
    p.say(ans);
    assert.ok(!grad(p), `${ans}: nothing saved: ${JSON.stringify(statedFacts(p))}`);
  }
  for (const [ans, v] of [["may 2028", "May 2028"], ["in may 2028", "May 2028"], ["2028", "2028"]]) {
    const p = person(`u-ok-${ans}`);
    p.say("my brother will graduate in may 2027");
    p.say(ans);
    assert.equal(grad(p) && grad(p).value, v, `${ans}: saved`);
  }
  for (const [m, v] of [["i graduate may 2027", "May 2027"], ["im graduating in december 2026", "December 2026"], ["actually im graduating in 2027", "2027"], ["im class of 2028", "2028"]]) {
    const p = person(`u-plain-${m}`);
    p.say(m);
    assert.equal(grad(p) && grad(p).value, v, `${m}: saved`);
  }
});

test("review 2: 'apply to the top one' for a posting that has left gets the same honest reply as 'apply to #1'", async () => {
  await setup();
  const replyFor = (m) => {
    const p = person(`u-gone-${m}`);
    p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
    p.say("find data analyst jobs in chicago");
    return p.say(m, { postings: POSTINGS.slice(1) }); // the first posting has left
  };
  const ref = replyFor("apply to #1");
  assert.match(String(ref.reply), /isn'?t in the open postings/i, String(ref.reply));
  for (const m of ["apply to the top one", "apply to the top 1", "apply to top one", "apply for the top one"]) {
    const o = replyFor(m);
    const r = String(o.reply);
    assert.ok(!isDeadEnd(o), `${m}: [${o.intent}] ${r}`);
    assert.equal(r, String(ref.reply), `${m}: the same reply as "apply to #1"`);
    assert.equal(o.intent, ref.intent, m);
    assert.ok(!o.batchRun && !(o.sends > 0), `${m}: nothing started`);
    assert.ok(!/need your resume|send (?:me )?your resume|paste your resume/i.test(r), `${m}: ${r}`);
  }
  // "which is the best one" is a question, never a pick of the first role
  const b = person("u-best");
  b.say(`here is my resume:\n${RESUME}`); b.say("yes thats my resume");
  b.say("find data analyst jobs in chicago");
  const best = b.say("apply to the best one", { postings: POSTINGS.slice(1) });
  assert.ok(!/Data Analyst at Acme isn'?t in the open postings/.test(String(best.reply)), `"best one" is not read as the first: ${best.reply}`);
  // still open: the top one runs the apply flow
  const p = person("u-top-open");
  p.say(`here is my resume:\n${RESUME}`); p.say("yes thats my resume");
  p.say("find data analyst jobs in chicago");
  const o = p.say("apply to the top one");
  assert.equal(o.intent, "career_batch_apply", `[${o.intent}] ${String(o.reply).slice(0, 160)}`);
});
