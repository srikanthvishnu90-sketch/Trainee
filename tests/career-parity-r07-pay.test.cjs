'use strict';
// Parity audit R07 (unknowns shown as values): "pay for a posting without pay -> 'not listed'"; negative: no invented numbers,
// no hidden unknowns. Through the production career bundle and host. On trunk, "what does the first one pay" repeated the role
// with nothing about pay, and "what is the pay for that role" was answered as a question about Trainee's own pricing.
// Check: node --test tests/career-parity-r07-pay.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
  { id: 'gh:1', job_id: 'gh:1', company: 'Acme', title: 'Software Engineering Intern', location: 'Chicago, IL', url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Build services in Python. Summer 2027.', first_seen_at: '2026-10-30T00:00:00Z' },
  { id: 'gh:2', job_id: 'gh:2', company: 'Globex', title: 'Software Engineering Intern', location: 'Chicago, IL', url: 'https://jobs.lever.co/globex/2', description: 'Work on our data platform. The pay for this role is $30 - $35 per hour. Summer 2027.', first_seen_at: '2026-10-30T00:00:00Z' },
];
function person(userId) {
  let snap = null, acct = { version: 0, epoch: 0 };
  const say = (text) => {
    const ctx = host.createTurnCtx({ userId, threadId: `t-${userId}`, now: Date.parse('2026-11-01T15:00:00Z'), accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(acct), watchState: {}, postings: POSTINGS });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    acct = { ...acct, ...copy(ctx._hostPatch || {}), version: acct.version + 1 };
    return out;
  };
  return { say };
}
const NOT_LISTED = /\b(?:not listed|isn'?t listed|doesn'?t (?:list|say|state)|does not (?:list|say|state)|no pay (?:is )?listed)\b/i;
const listed = (p) => {
  const out = p.say('software engineering internships in chicago');
  assert.match(String(out.reply), /Acme/);
  assert.match(String(out.reply), /Globex/);
  const acmeFirst = String(out.reply).indexOf('Acme') < String(out.reply).indexOf('Globex');
  return acmeFirst ? { acme: 'first', globex: 'second' } : { acme: 'second', globex: 'first' };
};

test('R07: pay for a posting that lists none is said as "not listed", with no number', async () => {
  await setup();
  const p = person('u-r07-a');
  const at = listed(p);
  const out = p.say(`what does the ${at.acme} one pay`);
  assert.match(String(out.reply), NOT_LISTED, out.reply);
  assert.match(String(out.reply), /Acme/, 'names which posting');
  assert.doesNotMatch(String(out.reply), /\$\s?\d/, `no invented figure: ${out.reply}`);
});

test('R07: pay a posting does list is quoted as the posting states it', async () => {
  await setup();
  const p = person('u-r07-b');
  const at = listed(p);
  for (const ask of [`how much does the ${at.globex} one pay`, 'what does the globex internship pay']) {
    const out = p.say(ask);
    assert.match(String(out.reply), /\$30\s*-\s*\$35 per hour/, `${ask}: ${out.reply}`);
    assert.doesNotMatch(String(out.reply), NOT_LISTED, out.reply);
  }
});

test('R07: "the pay for that role" with two shown asks which one; it is never read as Trainee\'s own pricing', async () => {
  await setup();
  const p = person('u-r07-c');
  listed(p);
  const out = p.say('what is the pay for that role');
  assert.doesNotMatch(String(out.reply), /pricing or billing/i, out.reply);
  assert.match(String(out.reply), /Acme/, out.reply);
  assert.match(String(out.reply), /Globex/, out.reply);
  assert.match(String(out.reply), /\?/, 'asks which');
});

test('R07: with no list shown, a role pay question is still not a pricing answer', async () => {
  await setup();
  const out = person('u-r07-d').say('what is the pay for that role');
  assert.doesNotMatch(String(out.reply), /pricing or billing/i, out.reply);
});
