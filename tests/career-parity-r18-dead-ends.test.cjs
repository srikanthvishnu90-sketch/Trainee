'use strict';
// Parity audit R18 (dead ends) and failure case F1: a person asked for real postings with links and got their goal recorded
// instead; a dead end said "I didn't catch that". Through the production career bundle and host (router_core.career.js +
// career_host.js), as agent-chat runs it. Assertions are on what is WRITTEN to the person's records and on the reply's intent,
// not on wording.
//   1. "send me real postings with links" is a request to see postings now: no job watch is saved for it (a watch is an alert
//      the person asks for: "text me when", "alert me", "new ... roles", "every day").
//   2. "i want real ... postings ... with links" is a request for postings, not a career goal: nothing is recorded as the goal.
//   3. The production router carries no "I didn't catch that" reply anywhere it can answer with it.
// Controls: the alert asks the router already creates watches for still create them.
// Check: node --test tests/career-parity-r18-dead-ends.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');

let host;
async function setup() {
  if (host) return;
  const B = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/router_core.career.js')));
  const { CareerHost } = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/career_host.js')));
  host = CareerHost.createCareerHost(B);
}
const copy = (x) => JSON.parse(JSON.stringify(x ?? null));
const POSTINGS = [
  { id: 'gh:1', job_id: 'gh:1', company: 'Acme', title: 'Software Engineering Intern', location: 'Chicago, IL', url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Python', first_seen_at: '2026-10-30T00:00:00Z' },
];
function person(userId) {
  let snap = null, acct = { version: 0, epoch: 0 };
  const watch = {};
  const say = (text) => {
    const ctx = host.createTurnCtx({ userId, threadId: `t-${userId}`, now: Date.parse('2026-11-01T15:00:00Z'), accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(acct), watchState: watch, postings: POSTINGS });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    acct = { ...acct, ...copy(ctx._hostPatch || {}), version: acct.version + 1 };
    return out;
  };
  const facts = () => ((acct.statedFacts || (snap && snap.stores && snap.stores.statedFacts) || {}).facts) || [];
  // Every job watch interest saved for the person, wherever the host keeps the watch record.
  const interests = () => {
    const out = [];
    const walk = (v) => { if (!v || typeof v !== 'object') return; if (Array.isArray(v.interests)) out.push(...v.interests); for (const x of Object.values(v)) walk(x); };
    walk(watch); walk(acct.watch || null); walk(snap);
    return out;
  };
  return { say, facts, interests };
}

const PRESENT = [
  'send me real postings with links',
  'send me data analyst roles in chicago',
  'send me the links to swe internships in chicago',
  'dm me some marketing jobs in austin',
];
for (const ask of PRESENT) {
  test(`R18/F1: "${ask}" is a request to see postings now, never a job watch saved for it`, async () => {
    await setup();
    const p = person(`u-r18-${ask.length}`);
    const out = p.say(ask);
    assert.notEqual(out.intent, 'career_watch_create', `${ask} -> ${out.intent}: ${out.reply}`);
    assert.equal(p.interests().length, 0, `no watch was asked for, none is saved: ${JSON.stringify(p.interests())}`);
  });
}

test('R18/F1: "i want real ... postings ... with links" asks for postings; it is never recorded as the career goal', async () => {
  await setup();
  const p = person('u-r18-goal');
  const out = p.say('i want real software engineering internship postings in chicago with links');
  const goals = p.facts().filter((f) => f.kind === 'goal');
  assert.deepEqual(goals.map((g) => g.value), [], `nothing recorded as the goal: ${out.intent}: ${out.reply}`);
  assert.notEqual(out.intent, 'career_goal_record', out.reply);
});

test('R18 control: a stated target is still recorded as the goal', async () => {
  await setup();
  const p = person('u-r18-goal-ok');
  p.say('i want a software engineering internship in chicago');
  assert.equal(p.facts().filter((f) => f.kind === 'goal').length, 1);
});

test('R18 control: the alert asks still create a watch', async () => {
  await setup();
  for (const ask of ['text me when new data analyst roles open up', 'send me new data analyst internships every day', 'alert me for swe internships in chicago', 'notify me about finance roles', 'send me new grad roles as they get posted',
    // Review of #396: a time or a condition makes a send-me ask an alert.
    'send me data analyst roles at 9am', 'send me data analyst roles tomorrow morning', 'send me analyst jobs once they open']) {
    const out = person(`u-r18-c-${ask.length}`).say(ask);
    assert.equal(out.intent, 'career_watch_create', `${ask} -> ${out.intent}: ${out.reply}`);
  }
});

test('R18: the production router has no "I didn\'t catch that" reply', () => {
  for (const f of ['supabase/functions/_shared/router_core.career.js', 'supabase/functions/_shared/router_core.js', 'packages/domain/142-career-router.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // The retired wording may stay inside the detector that recognizes old transcripts (FALLBACK_TEXT_RE); never as a reply.
    const replies = src.split('\n').filter((l) => /didn'?t catch that/i.test(l) && !/FALLBACK_TEXT_RE|isFallbackText|^\s*\/\//.test(l));
    assert.deepEqual(replies, [], `${f} still answers with it`);
  }
});

test('R18: a request for postings that names no role is not the generic fallback: it asks for the one thing missing', async () => {
  await setup();
  const out = person('u-r18-norole').say('send me real postings with links');
  assert.doesNotMatch(String(out.reply), /not sure which part of your search|may have missed what you meant|didn'?t catch/i, out.reply);
  assert.match(String(out.reply), /\brole\b[^?]*\?/i, `asks which role: ${out.reply}`);
});

test('R18: with a goal on record, a request for postings that names no role offers to search that goal, in their words', async () => {
  await setup();
  const p = person('u-r18-hasgoal');
  p.say('i want a software engineering internship in chicago');
  const out = p.say('send me real postings with links');
  assert.match(String(out.reply), /software engineering internship in chicago/i, out.reply);
  assert.match(String(out.reply), /\?/, `asks before searching: ${out.reply}`);
  assert.equal(p.interests().length, 0, 'and saves no watch');
});

test('R18 (review #396): a send-me ask that names its role is never answered by asking for the role', async () => {
  await setup();
  for (const ask of ['send me data analyst roles at 9am', 'send me analyst jobs once they open', 'send me some barista jobs']) {
    const out = person(`u-r18-named-${ask.length}`).say(ask);
    assert.doesNotMatch(String(out.reply), /Which role should I look for/i, `${ask} -> ${out.intent}: ${out.reply}`);
  }
});
