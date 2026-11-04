// scripts/launch/trainee-go-live.sh in dry-run mode (the plan, in order, nothing touched, no secret printed) and the
// checks of scripts/launch/trainee-smoke.cjs over a fake fetch and a fake database. Nothing here reaches a network.
// Check: node --test tests/trainee-go-live.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const SCRIPT = path.join(root, 'scripts/launch/trainee-go-live.sh');
const SMOKE = path.join(root, 'scripts/launch/trainee-smoke.cjs');
const smoke = require(SMOKE);

// Distinctive fakes: none of them may ever appear in the output. All are labelled fake (tests/no-secrets.test.cjs).
const FAKE = {
  SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  SUPABASE_DB_URL: 'postgresql://postgres:fake-dbpass-QZ81x@db.example.test:5432/postgres',
  CAREER_INGEST_SECRET: 'fake-ingest-secret-0000-IIIIIIIIIIIIIIIIIIII',
  CAREER_PROACTIVE_SECRET: 'fake-proactive-secret-0000-PPPPPPPPPPPPPPPP',
  TRAINEE_DELIVER_SECRET: 'fake-deliver-secret-0000-DDDDDDDDDDDDDDDDDD',
  TRAINEE_INBOUND_SECRET: 'fake-inbound-secret-0000-NNNNNNNNNNNNNNNNNN',
  LOOPMESSAGE_API_KEY: 'fake-loop-key-0000-LLLLLLLLLL',
  OPENAI_API_KEY: 'sk-proj-fake-should-never-print-0000-OOOOOOOO',
  TRAINEE_ALLOWED_CONTACTS: '+15550009876,+15550004321',
  INGEST_CONTACT_EMAIL: 'owner-fake-QZ81@example.test',
  LOOPMESSAGE_DAILY_CONTACTS: '1000',
  UPMORE_TEST_JWT: 'fake-jwt-should-never-print-0000-JJJJ',
  TRAINEE_SMOKE_CONTACT: '+15550007777',
};
const SECRET_VALUES = Object.entries(FAKE).filter(([k]) => !['SUPABASE_PROJECT_REF', 'LOOPMESSAGE_DAILY_CONTACTS'].includes(k)).map(([, v]) => v);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-go-live-test-'));
function dry(args = [], env = FAKE) {
  const res = spawnSync('bash', [SCRIPT, '--dry-run', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } });
  return { code: res.status, out: res.stdout + res.stderr };
}
function inOrder(out, steps) {
  let at = -1;
  for (const s of steps) { const i = out.indexOf(s, at + 1); assert.ok(i > at, `"${s}" comes next`); at = i; }
}
// Every migration file from the Trainee set on is applied by go-live, in file order: a new one that is not listed fails
// here (the apply pipeline's six once shipped in trunk without it; docs/playbook-drift-2026-10-19.md).
const MIGRATIONS = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f >= '20261019' && f.endsWith('.sql')).sort();

test('dry run: six steps in order, every Trainee migration in order, agent-chat staged then the four functions without JWT, the three schedules, then smoke', () => {
  const { code, out } = dry();
  assert.equal(code, 0, out);
  inOrder(out, ['STEP 1/6 preflight', 'STEP 1/6 preflight: OK', 'STEP 2/6 migrations', 'STEP 2/6 migrations: OK', 'STEP 3/6 secrets', 'STEP 3/6 secrets: OK',
    'STEP 4/6 deploy', 'STEP 4/6 deploy: OK', 'STEP 5/6 schedules', 'STEP 5/6 schedules: OK', 'STEP 6/6 smoke', 'STEP 6/6 smoke: OK']);
  inOrder(out, MIGRATIONS.map((m) => `--single-transaction -f supabase/migrations/${m}`));
  // 20261024130000 (the draft card-cloud bridge) and 20261025100000 (the one ledger) both replace career_apply_claim_own and
  // career_apply_cloud_refusal; the bridge applied after the ledger strips the ledger's approval re-check from both
  // (docs/architect/MIGRATION-SEQUENCING-BRIDGE-LEDGER.md). Go-live never applies the bridge after the ledger.
  const at = (m) => out.indexOf(`--single-transaction -f supabase/migrations/${m}`);
  const [bridge, ledger] = [at('20261024130000_career_apply_card_cloud_bridge.sql'), at('20261025100000_career_apply_one_ledger.sql')];
  assert.ok(ledger > 0, 'go-live applies the one ledger');
  assert.ok(bridge < 0 || bridge < ledger, 'go-live never applies the draft bridge after the one ledger');
  // And whatever was already live, after its migrations go-live reconciles the two and stops unless every claim guard
  // is in place (a bridge applied on its own after the ledger, or its rollback, would otherwise leave the claim without them).
  inOrder(out, [`--single-transaction -f supabase/migrations/${MIGRATIONS.at(-1)}`, '-f scripts/launch/verify-claim-guards.sql', 'STEP 2/6 migrations: OK']);
  for (const f of fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => /^2026101[56].*career/.test(f))) {
    assert.match(out, new RegExp(`check ${f} is on the live project.*never applied here`), `${f} is only checked`);
    assert.doesNotMatch(out, new RegExp(`-f supabase/migrations/${f}`), `${f} is never applied`);
  }
  inOrder(out, ['node scripts/career/stage-career.cjs', '(index-career.ts staged as agent-chat/index.ts)', 'supabase functions deploy agent-chat --project-ref abcdefghijklmnopqrst --use-docker)',
    'supabase functions deploy career-ingest --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker',
    'supabase functions deploy career-proactive --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker',
    'supabase functions deploy trainee-deliver --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker',
    'supabase functions deploy trainee-inbound --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker']);
  assert.doesNotMatch(out, /deploy agent-chat[^\n]*--no-verify-jwt/, 'agent-chat keeps the JWT check');
  const base = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';
  inOrder(out, [`CAREER_INGEST_SECRET=*** psql *** -X -q -v ON_ERROR_STOP=1 -v url=${base}/career-ingest -f scripts/launch/schedule-career-ingest.sql`,
    `CAREER_PROACTIVE_SECRET=*** psql *** -X -q -v ON_ERROR_STOP=1 -v url=${base}/career-proactive -f scripts/launch/schedule-career-proactive.sql`,
    `TRAINEE_DELIVER_SECRET=*** psql *** -X -q -v ON_ERROR_STOP=1 -v url=${base}/trainee-deliver -f scripts/launch/schedule-trainee-deliver.sql`,
    'node scripts/launch/trainee-smoke.cjs --wait-runs 420']);
  assert.doesNotMatch(out, /supabase db push/, 'never a replay of every migration');
  assert.doesNotMatch(out, /--allow-send/, 'no text goes out unless asked');
});

test('the env var each schedule script reads is the one go-live passes, and the header it sends is the one the handler checks', () => {
  const pairs = [['schedule-career-ingest.sql', 'CAREER_INGEST_SECRET', 'career-ingest'], ['schedule-career-proactive.sql', 'CAREER_PROACTIVE_SECRET', 'career-proactive'], ['schedule-trainee-deliver.sql', 'TRAINEE_DELIVER_SECRET', 'trainee-deliver']];
  for (const [file, v, fn] of pairs) {
    const sql = fs.readFileSync(path.join(root, 'scripts/launch', file), 'utf8');
    assert.match(sql, new RegExp(`printf '%s' "\\$${v}"`), `${file} reads ${v}`);
    const g = smoke.GATED.find((x) => x.fn === fn);
    assert.equal(g.env, v);
    assert.ok(sql.includes(`'${g.header}'`), `${file} sends ${g.header}`);
    const handler = fs.readFileSync(path.join(root, 'supabase/functions', fn, 'handler.ts'), 'utf8');
    assert.ok(handler.includes(`d.env.get("${v}")`) && handler.includes(`req.headers.get("${g.header}")`), `${fn}/handler.ts checks ${v} in ${g.header}`);
  }
  const inbound = fs.readFileSync(path.join(root, 'supabase/functions/trainee-inbound/handler.ts'), 'utf8');
  assert.ok(inbound.includes('d.env.get("TRAINEE_INBOUND_SECRET")') && inbound.includes('searchParams.get("secret")'));
  const files = { 'trainee-career-ingest': 'schedule-career-ingest.sql', 'trainee-career-proactive': 'schedule-career-proactive.sql', 'trainee-deliver': 'schedule-trainee-deliver.sql' };
  for (const r of smoke.RUNS) assert.ok(fs.readFileSync(path.join(root, 'scripts/launch', files[r.job]), 'utf8').includes(`cron.schedule('${r.job}'`), `${r.job} is the job name`);
});

test('dry run: no secret value is ever printed, only names and ***', () => {
  for (const args of [[], ['--brain', 'agent', '--allow-send'], ['--only-smoke'], ['--skip-deploy', '--skip-migrations']]) {
    const { code, out } = dry(args);
    assert.equal(code, 0, out);
    for (const v of SECRET_VALUES) assert.ok(!out.includes(v), `${v.slice(0, 12)}… is not printed (${args.join(' ')})`);
    assert.doesNotMatch(out, /fake-dbpass|QZ81|NNNNNNNN|IIIIIIII/);
  }
  const { out } = dry();
  assert.match(out, /supabase secrets set --project-ref abcdefghijklmnopqrst --env-file <0600 temp file: CAREER_INGEST_SECRET=\*\*\* CAREER_PROACTIVE_SECRET=\*\*\* TRAINEE_DELIVER_SECRET=\*\*\* TRAINEE_INBOUND_SECRET=\*\*\* INGEST_CONTACT_EMAIL=\*\*\* LOOPMESSAGE_API_KEY=\*\*\* LOOPMESSAGE_DAILY_CONTACTS=\*\*\* TRAINEE_ALLOWED_CONTACTS=\*\*\* OPENAI_API_KEY=\*\*\* MODEL_PROVIDER=openai CAREER_OUTREACH_FOLLOWUPS=on>/);
});

test('networking follow-up reminders are switched on at launch (R2: the chat promises a texted reminder only when they run)', () => {
  for (const args of [[], ['--brain', 'agent'], ['--brain', 'router'], ['--skip-deploy', '--skip-migrations']]) {
    const { code, out } = dry(args);
    assert.equal(code, 0, out);
    assert.match(out, /--env-file <0600 temp file: [^>]*\bCAREER_OUTREACH_FOLLOWUPS=on\b[^>]*>/, args.join(' '));
  }
  assert.doesNotMatch(dry(['--only-smoke']).out, /CAREER_OUTREACH_FOLLOWUPS/, '--only-smoke changes no secret');
});

test('CAREER_BRAIN=agent is set only with --brain agent; --brain router unsets it; otherwise it is not touched', () => {
  const plain = dry([], { ...FAKE, CAREER_BRAIN: 'agent' }).out; // the environment never decides the brain
  assert.doesNotMatch(plain, /CAREER_BRAIN=agent/);
  assert.doesNotMatch(plain, /secrets unset CAREER_BRAIN/);
  assert.match(plain, /CAREER_BRAIN not touched/);
  const agent = dry(['--brain', 'agent']).out;
  assert.match(agent, /--env-file <0600 temp file: [^>]*CAREER_BRAIN=agent>/);
  const router = dry(['--brain=router']).out;
  assert.doesNotMatch(router, /CAREER_BRAIN=agent/);
  assert.match(router, /DRY: supabase secrets unset CAREER_BRAIN --project-ref abcdefghijklmnopqrst/);
  assert.notEqual(dry(['--brain', 'gpt']).code, 0, 'only agent or router');
});

test('flags: --skip-migrations, --skip-deploy and --only-smoke skip their steps; --allow-send and --no-wait reach the smoke', () => {
  const noMig = dry(['--skip-migrations']).out;
  assert.match(noMig, /STEP 2\/6 migrations: SKIPPED \(--skip-migrations\)/);
  assert.doesNotMatch(noMig, /-f supabase\/migrations\//);
  assert.match(noMig, /supabase functions deploy trainee-inbound/);
  const noDeploy = dry(['--skip-deploy']).out;
  assert.match(noDeploy, /STEP 4\/6 deploy: SKIPPED \(--skip-deploy\)/);
  assert.doesNotMatch(noDeploy, /functions deploy|deno check/);
  assert.match(noDeploy, /schedule-trainee-deliver\.sql/);
  const only = dry(['--only-smoke', '--allow-send']).out;
  for (const s of ['2/6 migrations', '3/6 secrets', '4/6 deploy', '5/6 schedules']) assert.match(only, new RegExp(`STEP ${s}: SKIPPED \\(--only-smoke\\)`));
  assert.doesNotMatch(only, /secrets set|functions deploy|psql \*\*\* -X -q -v ON_ERROR_STOP=1 -v url/);
  assert.match(only, /TRAINEE_SMOKE_CONTACT=\*\*\* node scripts\/launch\/trainee-smoke\.cjs --allow-send$/m, 'no wait: the schedules fired long ago');
  assert.match(dry(['--no-wait']).out, /node scripts\/launch\/trainee-smoke\.cjs$/m);
  assert.equal(dry(['--bogus']).code, 64);
  const badRef = dry([], { ...FAKE, SUPABASE_PROJECT_REF: 'not-a-ref' });
  assert.equal(badRef.code, 1);
  assert.match(badRef.out, /STEP 1\/6 preflight: FAILED: SUPABASE_PROJECT_REF is not a project ref/);
  const badSecret = dry([], { ...FAKE, TRAINEE_INBOUND_SECRET: 'too-short-fake' });
  assert.match(badSecret.out, /FAILED: TRAINEE_INBOUND_SECRET must be 32 or more/);
  assert.ok(!badSecret.out.includes('too-short-fake'));
});

test('the script is the owner\'s: it prompts on hidden reads, never writes a secret to a file except the 0600 env file it removes', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /read -rs "\$v" <\/dev\/tty/);
  assert.match(src, /openssl rand -hex 24/);
  assert.match(src, /rm -f "\$ENVF"/);
  assert.match(src, /printf '  %s=%s\\n' "\$v" "\$\{!v\}" >\/dev\/tty/, 'a generated secret is shown only on the terminal, never the log');
  assert.doesNotMatch(src, /set -x/);
  execFileSync('bash', ['-n', SCRIPT]);
});

test('trainee-smoke with no environment: NOT RUN, exit 2, says what is missing, calls nothing', () => {
  const res = spawnSync(process.execPath, [SMOKE], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /^NOT RUN trainee smoke: missing SUPABASE_URL, CAREER_INGEST_SECRET, CAREER_PROACTIVE_SECRET, TRAINEE_DELIVER_SECRET, TRAINEE_INBOUND_SECRET/);
});

// A fake fetch: answers by (function, which secret) from a table, and records every call.
const BASE = 'https://abcdefghijklmnopqrst.supabase.co';
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url), fn = u.pathname.split('/').pop();
    const g = smoke.GATED.find((x) => x.fn === fn);
    const got = g ? (g.query ? u.searchParams.get(g.query) : init.headers[g.header]) : null;
    const call = { fn, url, init, secretOk: g ? got === FAKE[g.env] : null, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const [status, body] = answer(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}
const handlerLike = (call) => {
  const refuse = call.fn === 'trainee-inbound' ? [403, { error: 'forbidden' }] : [401, { error: 'Unauthorized' }];
  return call.secretOk ? [200, { ok: true }] : refuse;
};

test('checkGate: refuses wrong (401/403) and answers right (200) pass; NOT_WIRED is a WARN; no secret on the function, a gateway JWT wall or an open door fail', async () => {
  for (const g of smoke.GATED) {
    const f = fakeFetch(handlerLike);
    const res = await smoke.checkGate(g, { base: BASE, secret: FAKE[g.env], fetchFn: f });
    assert.deepEqual(res.map((x) => x.status), ['PASS', 'PASS'], `${g.fn}: ${JSON.stringify(res)}`);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].secretOk, false); assert.equal(f.calls[1].secretOk, true);
    assert.equal(f.calls[1].init.method, 'POST');
    if (g.query) assert.match(f.calls[1].url, /\?secret=/); else assert.ok(!f.calls[1].url.includes('?'), 'scheduler secrets go in the header');
  }
  const deliver = smoke.GATED.find((x) => x.fn === 'trainee-deliver');
  const notWired = await smoke.checkGate(deliver, { base: BASE, secret: FAKE.TRAINEE_DELIVER_SECRET, fetchFn: fakeFetch((c) => c.secretOk ? [503, { error: 'NOT_WIRED: LOOPMESSAGE_API_KEY is not set; nothing was sent' }] : [401, { error: 'Unauthorized' }]) });
  assert.deepEqual(notWired.map((x) => x.status), ['PASS', 'WARN']);
  assert.match(notWired[1].detail, /LOOPMESSAGE_API_KEY/);
  const ingest = smoke.GATED.find((x) => x.fn === 'career-ingest');
  const noContact = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: fakeFetch((c) => c.secretOk ? [503, { error: 'not configured: INGEST_CONTACT_EMAIL is not set (boards are told who is reading them)' }] : [401, { error: 'Unauthorized' }]) });
  assert.deepEqual(noContact.map((x) => x.status), ['PASS', 'WARN']);
  const noSecret = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: fakeFetch(() => [503, { error: 'not configured: CAREER_INGEST_SECRET must be set, 32 characters or more' }]) });
  assert.deepEqual(noSecret.map((x) => x.status), ['FAIL', 'FAIL']);
  const gateway = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: fakeFetch(() => [401, { code: 401, message: 'Missing authorization header' }]) });
  assert.equal(gateway[1].status, 'FAIL'); assert.match(gateway[1].detail, /--no-verify-jwt/);
  const open = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: fakeFetch(() => [200, {}]) });
  assert.equal(open[0].status, 'FAIL', 'answering a wrong secret is a failure');
  const crashed = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: fakeFetch((c) => c.secretOk ? [500, { error: 'ingest failed', detail: 'boom' }] : [401, { error: 'Unauthorized' }]) });
  assert.equal(crashed[1].status, 'FAIL');
  const down = await smoke.checkGate(ingest, { base: BASE, secret: FAKE.CAREER_INGEST_SECRET, fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.deepEqual(down.map((x) => x.status), ['FAIL', 'FAIL']);
});

test('the HELP body is one the real parseLoopInbound reads as an inbound text from the contact', async () => {
  const { stripTypeScriptTypes } = require('node:module');
  const src = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'supabase/functions/_shared/loopmessage.ts'), 'utf8'), { mode: 'strip' });
  const { parseLoopInbound } = await import('data:text/javascript,' + encodeURIComponent(src));
  const body = smoke.helpBody(FAKE.TRAINEE_SMOKE_CONTACT, 1760000000000);
  const m = parseLoopInbound(body);
  assert.equal(m.kind, 'text'); assert.equal(m.text, 'HELP'); assert.equal(m.sender, FAKE.TRAINEE_SMOKE_CONTACT);
  assert.ok(m.messageId && m.messageId !== smoke.helpBody(FAKE.TRAINEE_SMOKE_CONTACT, 1760000000000).message_id, 'a fresh message id each run');
  assert.equal(parseLoopInbound({}).kind, 'ignored', 'the right-secret gate call (empty body) runs no turn');
});

test('checkInboundHelp: ok + command help + sent passes; not sent, ignored or NOT_WIRED do not', async () => {
  const args = (fetchFn) => ({ base: BASE, secret: FAKE.TRAINEE_INBOUND_SECRET, contact: FAKE.TRAINEE_SMOKE_CONTACT, fetchFn, now: 1 });
  const f = fakeFetch((c) => [200, { ok: true, command: c.body.text.toLowerCase(), sent: true }]);
  assert.equal((await smoke.checkInboundHelp(args(f))).status, 'PASS');
  assert.equal(f.calls[0].secretOk, true);
  assert.equal(f.calls[0].body.recipient, FAKE.TRAINEE_SMOKE_CONTACT);
  assert.equal((await smoke.checkInboundHelp(args(fakeFetch(() => [200, { ok: true, command: 'help', sent: false }])))).status, 'FAIL');
  assert.equal((await smoke.checkInboundHelp(args(fakeFetch(() => [200, { ok: true, ignored: 'no sender' }])))).status, 'FAIL');
  assert.equal((await smoke.checkInboundHelp(args(fakeFetch(() => [503, { error: 'NOT_WIRED: LOOPMESSAGE_API_KEY is not set; no turn was run' }])))).status, 'WARN');
});

test('agent-chat: no JWT must be 401; "hi" with the test JWT needs a non-empty reply', async () => {
  assert.equal((await smoke.checkChatNoJwt({ base: BASE, fetchFn: fakeFetch(() => [401, { error: 'unauthorized' }]) })).status, 'PASS');
  assert.equal((await smoke.checkChatNoJwt({ base: BASE, fetchFn: fakeFetch(() => [200, { reply: 'x' }]) })).status, 'FAIL');
  const f = fakeFetch(() => [200, { reply: 'Hi, I find jobs and text you the good ones.', thread_id: 't' }]);
  assert.equal((await smoke.checkChatHi({ base: BASE, jwt: FAKE.UPMORE_TEST_JWT, fetchFn: f })).status, 'PASS');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${FAKE.UPMORE_TEST_JWT}`);
  assert.deepEqual(f.calls[0].body, { message: 'hi' });
  assert.equal((await smoke.checkChatHi({ base: BASE, jwt: 'x', fetchFn: fakeFetch(() => [200, { reply: '  ' }]) })).status, 'FAIL');
  assert.equal((await smoke.checkChatHi({ base: BASE, jwt: 'x', fetchFn: fakeFetch(() => [429, { message: 'slow down' }]) })).status, 'FAIL');
});

// A fake database: the cron query answers from `jobs`, each run query from `runs` (keyed by its table).
function fakeSql(jobs, runs) {
  return async (q) => {
    if (q.includes('cron.job')) return jobs.map((j) => j.join('|')).join('\n') + '\n';
    const key = Object.keys(runs).find((k) => q.includes(k));
    return runs[key] == null ? '' : runs[key] + '\n';
  };
}
const goodJobs = [['trainee-career-ingest', 'succeeded', '120'], ['trainee-career-proactive', 'succeeded', '60'], ['trainee-deliver', 'succeeded', '20']];
const goodRuns = { career_ingest_state: '90|', career_proactive_runs: '50|', channel_delivery_runs: '15|' };

test('checkRuns: each schedule fired and each run record has a fresh row without an error; missing, stale or failed ones fail', async () => {
  assert.deepEqual((await smoke.checkRuns({ sql: fakeSql(goodJobs, goodRuns) })).map((x) => x.status), Array(6).fill('PASS'));
  const missingJob = await smoke.checkRuns({ sql: fakeSql(goodJobs.slice(0, 2), goodRuns) });
  assert.equal(missingJob.find((x) => x.check === 'schedule trainee-deliver').status, 'FAIL');
  const stale = await smoke.checkRuns({ sql: fakeSql(goodJobs, { ...goodRuns, channel_delivery_runs: '900|' }) });
  assert.equal(stale.find((x) => x.check === 'channel_delivery_runs has a recent row').status, 'FAIL');
  const errored = await smoke.checkRuns({ sql: fakeSql(goodJobs, { ...goodRuns, career_proactive_runs: '30|record run: permission denied' }) });
  assert.match(errored.find((x) => x.check === 'career_proactive_runs has a recent row').detail, /permission denied/);
  const never = await smoke.checkRuns({ sql: fakeSql([['trainee-career-ingest', '', ''], ...goodJobs.slice(1)], { ...goodRuns, career_ingest_state: '|' }) });
  assert.deepEqual(never.slice(0, 2).map((x) => x.status), ['FAIL', 'FAIL']);
  const failedFire = await smoke.checkRuns({ sql: fakeSql([['trainee-career-ingest', 'failed', '30'], ...goodJobs.slice(1)], goodRuns) });
  assert.equal(failedFire[0].status, 'FAIL');
});

test('main: one line per check and a summary, waits for the schedules when asked, exit 1 on a FAIL, and never prints a secret', async () => {
  const env = { SUPABASE_URL: BASE + '/', ...FAKE };
  const lines = [];
  let polls = 0, clock = 0;
  const sql = async (q) => { if (q.includes('cron.job')) polls++; return fakeSql(polls < 3 ? goodJobs.slice(0, 2) : goodJobs, goodRuns)(q); };
  const echoFetch = fakeFetch((c) => c.fn === 'agent-chat'
    ? (c.init.headers.Authorization ? [200, { reply: `echo ${FAKE.UPMORE_TEST_JWT}` }] : [401, { error: 'unauthorized' }])
    : c.fn === 'trainee-inbound' && c.body && c.body.text ? [200, { ok: true, command: 'help', sent: true }]
    : c.secretOk ? [200, { ok: true, echoed: c.url }] : [c.fn === 'trainee-inbound' ? 403 : 401, { error: `refused ${FAKE.TRAINEE_INBOUND_SECRET}` }]);
  const code = await smoke.main(['--allow-send', '--wait-runs', '120'], env, { fetch: echoFetch, sql, log: (s) => lines.push(s), sleep: async (ms) => { clock += ms; }, now: () => clock });
  const out = lines.join('\n');
  assert.equal(code, 0, out);
  assert.equal(polls, 3, 'polled until every schedule had fired');
  assert.match(out, /waiting up to 120 s/);
  assert.match(out, /^summary: 17 PASS, 0 WARN, 0 FAIL, 0 NOT RUN$/m);
  for (const l of lines.filter((l) => !/^summary|^waiting/.test(l))) assert.match(l, /^(PASS|FAIL|WARN|NOT RUN|CERT|NOTE) /);
  for (const v of SECRET_VALUES) assert.ok(!out.includes(v) && !out.includes(encodeURIComponent(v)), `${v.slice(0, 12)}… is not printed`);

  const bare = [];
  const code2 = await smoke.main([], { SUPABASE_URL: BASE, CAREER_INGEST_SECRET: FAKE.CAREER_INGEST_SECRET, CAREER_PROACTIVE_SECRET: FAKE.CAREER_PROACTIVE_SECRET, TRAINEE_DELIVER_SECRET: FAKE.TRAINEE_DELIVER_SECRET, TRAINEE_INBOUND_SECRET: FAKE.TRAINEE_INBOUND_SECRET },
    { fetch: fakeFetch((c) => c.fn === 'trainee-deliver' && c.secretOk ? [500, { error: 'delivery run failed' }] : c.fn === 'agent-chat' ? [401, {}] : handlerLike(c)), log: (s) => bare.push(s) });
  assert.equal(code2, 1);
  assert.match(bare.join('\n'), /^NOT RUN trainee-inbound answers HELP: skipped: it texts the help reply/m);
  assert.match(bare.join('\n'), /^NOT RUN agent-chat answers "hi" for the test user: missing UPMORE_TEST_JWT/m);
  assert.match(bare.join('\n'), /^NOT RUN schedules and run records: missing SUPABASE_DB_URL/m);
  assert.match(bare.join('\n'), /^FAIL    trainee-deliver answers the right secret: HTTP 500/m);
  assert.equal(await smoke.main([], { ...env, SUPABASE_URL: 'http://plain.example.test' }, { log: () => {} }), 2, 'https only');
});

// A real (not dry) run over stub tools, without a terminal: pressing Enter for the inbound secret must not replace one
// LoopMessage's webhook URL already carries, unless the owner asks for the rotation.
const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
function stubbed(env) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-go-live-bin-'));
  const calls = path.join(bin, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  stub('supabase', 'if [[ "$1 $2" == "secrets list" ]]; then printf "NAME | DIGEST\\nTRAINEE_INBOUND_SECRET | 0f0f\\n"; fi; exit 0');
  stub('psql', 'exit 0'); stub('deno', 'exit 0');
  // WO-093: a real run ships exactly --sha (HEAD here) from git archive, so git and node are the real ones, but for a
  // clean tree (this checkout may have edits) and the smoke (no network in a test).
  stub('node', `if [[ "$1" == *trainee-smoke.cjs ]]; then exit 0; fi\nexec "${process.execPath}" "$@"`);
  stub('git', `if [[ "$1" == status ]]; then exit 0; fi\nexec "${REAL_GIT}" "$@"`);
  const res = spawnSync('bash', [SCRIPT, '--sha', HEAD_SHA], { cwd: root, encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TRAINEE_GO_LIVE_LOG: path.join(bin, 'run.log'), ...env } });
  return { code: res.status, out: res.stdout + res.stderr, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('an inbound secret already on the project is never replaced by an Enter; TRAINEE_ROTATE_INBOUND=1 replaces it on purpose', () => {
  const { TRAINEE_INBOUND_SECRET, ...rest } = FAKE;
  const kept = stubbed(rest);
  assert.equal(kept.code, 1, kept.out);
  assert.match(kept.out, /STEP 1\/6 preflight: FAILED: TRAINEE_INBOUND_SECRET is already set on the project/);
  assert.doesNotMatch(kept.calls, /secrets set|functions deploy/, 'nothing changed on the project');
  const rotated = stubbed({ ...rest, TRAINEE_ROTATE_INBOUND: '1' });
  assert.match(rotated.out, /STEP 1\/6 preflight: OK/, rotated.out);
  for (const v of SECRET_VALUES) assert.ok(!rotated.out.includes(v) && !kept.out.includes(v), 'no secret printed');
});

// --non-interactive (the production workflow, .github/workflows/deploy-production.yml): no terminal is ever opened and
// nothing is asked. The same stub tools as above; `secrets list` answers with the names in `live` (never values).
function nonint(args, env, { live = ['TRAINEE_INBOUND_SECRET'], listFails = false, bundleOk = false } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-go-live-nonint-'));
  const calls = path.join(bin, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  const rows = live.map((n) => `${n} | 0f0f`).join('\\n');
  stub('supabase', `if [[ "$1 $2" == "secrets list" ]]; then ${listFails ? 'echo "Access token not provided" >&2; exit 1' : `printf "NAME | DIGEST\\n${rows}\\n"`}; fi; exit 0`);
  stub('psql', 'exit 0'); stub('deno', 'exit 0');
  if (bundleOk) stub('python3', 'exit 0'); // the router-bundle freshness check is not what this case tests
  stub('node', `if [[ "$1" == *trainee-smoke.cjs ]]; then exit 0; fi\nexec "${process.execPath}" "$@"`);
  stub('git', `if [[ "$1" == status ]]; then exit 0; fi\nexec "${REAL_GIT}" "$@"`);
  const res = spawnSync('bash', [SCRIPT, '--non-interactive', ...args], { cwd: root, encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TRAINEE_GO_LIVE_LOG: path.join(bin, 'run.log'), ...env } });
  const log = fs.existsSync(path.join(bin, 'run.log')) ? fs.readFileSync(path.join(bin, 'run.log'), 'utf8') : '';
  return { code: res.status, out: res.stdout + res.stderr, log, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}
const CI_ENV = { ...FAKE, SUPABASE_ACCESS_TOKEN: 'sbp_fake-access-token-0000-AAAAAAAAAAAAAAAA' };

test('--non-interactive: every missing required value fails preflight at once, each named; nothing is asked or changed', () => {
  const { SUPABASE_DB_URL, SUPABASE_ACCESS_TOKEN, ...rest } = CI_ENV;
  const r = nonint([], rest);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STEP 1\/6 preflight: FAILED: --non-interactive: required and not set: SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL --sha$/m);
  assert.doesNotMatch(r.calls, /secrets (list|set)|functions deploy|psql/, 'stops before any tool touches the project');
  const noRef = nonint(['--sha', HEAD_SHA], { ...CI_ENV, SUPABASE_PROJECT_REF: '' });
  assert.match(noRef.out, /FAILED: --non-interactive: required and not set: SUPABASE_PROJECT_REF$/m);
  // The interactive path is unchanged: the same script without the flag still prompts on a hidden read.
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /\[\[ -n "\$NONINT" \]\] && nonint_absent/);
  const envFlag = nonint([], { ...rest, TRAINEE_NON_INTERACTIVE: '1' });
  assert.match(envFlag.out, /required and not set: SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL --sha/, 'TRAINEE_NON_INTERACTIVE=1 is the same mode');
});

test('--non-interactive: a function secret set on the project is kept (never generated or rotated), one not set is generated, optional values keep what is set', () => {
  const { CAREER_INGEST_SECRET, CAREER_PROACTIVE_SECRET, TRAINEE_DELIVER_SECRET, TRAINEE_INBOUND_SECRET, OPENAI_API_KEY, LOOPMESSAGE_API_KEY, PDL_API_KEY, ...rest } = CI_ENV;
  const r = nonint(['--sha', HEAD_SHA, '--skip-migrations', '--skip-deploy'], rest, { live: ['CAREER_INGEST_SECRET', 'TRAINEE_INBOUND_SECRET', 'OPENAI_API_KEY'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kept: CAREER_INGEST_SECRET \(not given; set on the project, so it is neither generated nor rotated\)/);
  assert.match(r.out, /kept: TRAINEE_INBOUND_SECRET \(not given; set on the project/);
  assert.match(r.out, /generated: CAREER_PROACTIVE_SECRET TRAINEE_DELIVER_SECRET \(48 characters each; kept only in this process; --non-interactive never shows them/);
  assert.match(r.out, /not given: OPENAI_API_KEY \(--non-interactive: what the project has stays\)/);
  assert.match(r.out, /kept: OPENAI_API_KEY \(not given; an already-set key stays as it is\)/);
  // The env file names only what this run sets: the two generated secrets and the values given, never a kept one.
  const set = r.out.match(/supabase secrets set --project-ref abcdefghijklmnopqrst --env-file <0600 temp file: ([^>]*)>/);
  assert.ok(set, r.out);
  assert.deepEqual(set[1].split(' ').map((x) => x.split('=')[0]).filter((n) => /SECRET|OPENAI|LOOPMESSAGE_API/.test(n)), ['CAREER_PROACTIVE_SECRET', 'TRAINEE_DELIVER_SECRET']);
  // A kept secret's schedule and Vault copy are left alone; the generated ones are scheduled with their new value.
  assert.match(r.out, /kept: the career-ingest schedule and its Vault secret \(CAREER_INGEST_SECRET not given\)/);
  assert.doesNotMatch(r.calls, /schedule-career-ingest\.sql/);
  assert.match(r.calls, /schedule-career-proactive\.sql/); assert.match(r.calls, /schedule-trainee-deliver\.sql/);
  assert.match(r.calls, /trainee-smoke\.cjs --kept CAREER_INGEST_SECRET,TRAINEE_INBOUND_SECRET --wait-runs 420/);
  assert.equal((r.calls.match(/secrets list/g) || []).length, 1, 'the names are read once');
  for (const v of [...SECRET_VALUES, CI_ENV.SUPABASE_ACCESS_TOKEN]) assert.ok(!r.out.includes(v) && !r.log.includes(v), `${v.slice(0, 12)}… is not printed or logged`);
  assert.doesNotMatch(r.out + r.log, /0f0f/, 'the secrets list itself is never printed');
});

test('--non-interactive: a secret that also lives outside the project is never generated; an unreadable secrets list stops the run', () => {
  const { TRAINEE_INBOUND_SECRET, ...rest } = CI_ENV;
  const r = nonint(['--sha', HEAD_SHA], rest, { live: [] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STEP 1\/6 preflight: FAILED: TRAINEE_INBOUND_SECRET is not given and not set on the project; --non-interactive never generates it/);
  assert.doesNotMatch(r.calls, /secrets set|functions deploy/);
  const tg = nonint(['--sha', HEAD_SHA], { ...CI_ENV, TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-0000-TTTTTTTT' }, { live: [] });
  assert.match(tg.out, /FAILED: TELEGRAM_WEBHOOK_SECRET is not given and not set on the project/);
  const tgKept = nonint(['--sha', HEAD_SHA, '--skip-migrations', '--skip-deploy'], { ...CI_ENV, TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-0000-TTTTTTTT' }, { live: ['TELEGRAM_WEBHOOK_SECRET'] });
  assert.match(tgKept.out, /kept: TELEGRAM_WEBHOOK_SECRET \(not given; set on the project/, 'the live webhook secret (telegram-inbound reads it too) is never replaced');
  assert.doesNotMatch(tgKept.out, /TELEGRAM_WEBHOOK_SECRET=\*\*\*/);
  const { CAREER_INGEST_SECRET, ...noIngest } = CI_ENV;
  const blind = nonint(['--sha', HEAD_SHA], noIngest, { listFails: true });
  assert.equal(blind.code, 1);
  assert.match(blind.out, /FAILED: could not read the project's secret names/);
  assert.doesNotMatch(blind.out, /generated:/);
  assert.doesNotMatch(blind.calls, /secrets set/);
});

test('--non-interactive --dry-run (the PR preflight): runs without any secret, says what a real run would need', () => {
  const r = spawnSync('bash', [SCRIPT, '--dry-run', '--non-interactive'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /--non-interactive: a real run stops here; not set: SUPABASE_PROJECT_REF SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL --sha/);
  assert.match(r.stdout, /STEP 6\/6 smoke: OK/);
});

test('trainee-smoke --kept: a gate whose secret the project keeps is NOT RUN, not a refusal to run; anything else still needs its secret', async () => {
  const { CAREER_INGEST_SECRET, TRAINEE_INBOUND_SECRET, ...given } = FAKE;
  const lines = [];
  const f = fakeFetch((c) => c.fn === 'agent-chat' ? [401, {}] : handlerLike(c));
  const code = await smoke.main(['--kept', 'CAREER_INGEST_SECRET,TRAINEE_INBOUND_SECRET'], { SUPABASE_URL: BASE, CAREER_PROACTIVE_SECRET: given.CAREER_PROACTIVE_SECRET, TRAINEE_DELIVER_SECRET: given.TRAINEE_DELIVER_SECRET }, { fetch: f, log: (s) => lines.push(s) });
  const out = lines.join('\n');
  assert.equal(code, 0, out);
  assert.match(out, /^NOT RUN career-ingest gate: CAREER_INGEST_SECRET is kept on the project and was not given to this run$/m);
  assert.match(out, /^NOT RUN trainee-inbound gate: TRAINEE_INBOUND_SECRET is kept/m);
  assert.match(out, /^PASS    trainee-deliver answers the right secret/m);
  assert.ok(!f.calls.some((c) => c.fn === 'career-ingest' || c.fn === 'trainee-inbound'), 'a kept gate is not called');
  assert.equal(await smoke.main(['--kept', 'CAREER_INGEST_SECRET'], { SUPABASE_URL: BASE }, { log: () => {} }), 2, 'the others are still required');
  assert.equal(await smoke.main(['--kept', 'bad name'], { SUPABASE_URL: BASE }, { log: () => {} }), 2);
});

// The production workflow: a push to release/production only, in the `production` environment (the owner's approval),
// the exact pushed commit, non-interactive, every value the script reads from the environment's secrets.
test('deploy-production.yml: push to release/production only, environment production, the go-live script at $GITHUB_SHA, every input from a secret', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/deploy-production.yml'), 'utf8');
  const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
  assert.equal(on, '\non:\n  push:\n    branches: [release/production]', 'no pull_request, schedule, workflow_dispatch or other branch');
  assert.match(wf, /^ {4}environment: production$/m);
  assert.match(wf, /^ {2}contents: read$/m);
  assert.match(wf, /cancel-in-progress: false/, 'a deploy is never cut off halfway by the next push');
  assert.match(wf, /bash scripts\/launch\/trainee-go-live\.sh --sha "\$GITHUB_SHA" --non-interactive/);
  assert.doesNotMatch(wf, /--allow-send|--brain|TRAINEE_ROTATE|--force/, 'no text is sent, the brain and the webhook secrets are not touched');
  assert.match(wf, /supabase\/setup-cli@v1\n\s+with: \{ version: "\d+\.\d+\.\d+" \}/, 'a pinned supabase CLI');
  assert.match(wf, /deno-version: "v2\.9\.6"/, 'the pinned deno');
  assert.match(wf, /postgresql-client/);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const read = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_DB_URL', 'CAREER_INGEST_SECRET', 'CAREER_PROACTIVE_SECRET', 'TRAINEE_DELIVER_SECRET',
    'TRAINEE_INBOUND_SECRET', 'OPENAI_API_KEY', 'LOOPMESSAGE_API_KEY', 'INGEST_CONTACT_EMAIL', 'TRAINEE_ALLOWED_CONTACTS', 'LOOPMESSAGE_DAILY_CONTACTS',
    'PDL_API_KEY', 'UPMORE_TEST_JWT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_TEMPLATE_UPDATES', 'WHATSAPP_TEMPLATE_LANGUAGE', 'WHATSAPP_DAILY_TEMPLATES'];
  for (const v of read) {
    assert.ok(src.includes(v), `the script reads ${v}`);
    assert.match(wf, new RegExp(`^ {10}${v}: \\$\\{\\{ secrets\\.${v} \\}\\}$`, 'm'), `${v} comes from the secret of the same name`);
  }
  // Every hidden value the script masks is masked again in the collected artifacts.
  const hidden = [...src.match(/for v in SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL[^;]*;/)[0].matchAll(/[A-Z][A-Z0-9_]{3,}/g)].map((m) => m[0])
    .filter((v) => !['TRAINEE_SMOKE_CONTACT'].includes(v));
  for (const v of hidden) assert.match(wf, new RegExp(`MASK_\\d+: \\$\\{\\{ secrets\\.${v} \\}\\}`), `${v} is masked in the artifacts`);
  assert.match(wf, /actions\/upload-artifact@v4/);
  assert.match(wf, /python3 scripts\/launch\/mask-artifacts\.py "\$out"\n[\s\S]*upload-artifact/, 'masked before upload');
  assert.ok(!/\$\{\{ (github\.event|inputs)\./.test(wf.split('\n').filter((l) => /run:|^\s{10}[a-z]/.test(l)).join('\n')), 'no untrusted event text in a command');
});

test('deploy-preflight.yml: on PRs touching supabase/ or scripts/launch, the dry run at the PR head and the live-shaped migration rehearsal', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/deploy-preflight.yml'), 'utf8');
  assert.match(wf, /^on:\n {2}pull_request:\n {4}paths:\n(?: {6}- ".+"\n)+/m);
  assert.match(wf, /- "supabase\/\*\*"/); assert.match(wf, /- "scripts\/launch\/\*\*"/);
  assert.doesNotMatch(wf, /secrets\.|environment:/, 'the preflight has no secret and no environment');
  assert.match(wf, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(wf, /trainee-go-live\.sh --dry-run --non-interactive --sha "\$HEAD_SHA"/);
  assert.match(wf, /bash tests\/db\/rehearse_live_migrations\.sh/);
});

test('mask-artifacts.py replaces every given secret (and a database URL\'s password alone) with ***, and prints only counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-mask-'));
  fs.mkdirSync(path.join(dir, 'rollback'));
  fs.writeFileSync(path.join(dir, 'go-live.log'), `x ${FAKE.OPENAI_API_KEY} y\npassword fake-dbpass-QZ81x and url ${FAKE.SUPABASE_DB_URL}\nplain line\n`);
  fs.writeFileSync(path.join(dir, 'rollback', 'index.ts'), `const k = "${FAKE.TRAINEE_INBOUND_SECRET}";\n`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"sha":"abc"}\n');
  const res = spawnSync('python3', [path.join(root, 'scripts/launch/mask-artifacts.py'), dir], { encoding: 'utf8',
    env: { PATH: process.env.PATH, MASK_1: FAKE.OPENAI_API_KEY, MASK_2: FAKE.SUPABASE_DB_URL, MASK_3: FAKE.TRAINEE_INBOUND_SECRET, MASK_4: '', MASK_5: 'abc' } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'masked: 3 files checked, 2 had a secret value replaced by ***');
  const log = fs.readFileSync(path.join(dir, 'go-live.log'), 'utf8');
  assert.equal(log, 'x *** y\npassword *** and url ***\nplain line\n');
  assert.equal(fs.readFileSync(path.join(dir, 'rollback', 'index.ts'), 'utf8'), 'const k = "***";\n');
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), '{"sha":"abc"}\n', 'a value under 4 characters is never matched');
  for (const v of SECRET_VALUES) assert.ok(!res.stdout.includes(v));
});

test('the migration rehearsal reads go-live\'s own lists and checks every mark after a full apply', () => {
  const sh = fs.readFileSync(path.join(root, 'tests/db/rehearse_live_migrations.sh'), 'utf8');
  assert.match(sh, /eval "\$\(sed -n '\/\^MIGRATIONS=\(\/,\/\^\)\/p; \/\^MIGRATION_MARK=\(\/,\/\^\)\/p' "\$GO_LIVE"\)"/);
  assert.match(sh, /--single-transaction -f "\$src"/);
  assert.match(sh, /verify-claim-guards\.sql/);
  execFileSync('bash', ['-n', path.join(root, 'tests/db/rehearse_live_migrations.sh')]);
  // Each mark names an object its own file creates and no later file redefines away (a full apply read every mark true).
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /proname = 'career_apply_ledger_refusal' and prosrc like '%own is not null%'/, '20261025160000 redefines it without that text');
});

// Q3 (2026-10-28): step 5 removes no cron job by default. Only the exact job names the owner passes with --unschedule-cron
// are unscheduled (coordinator, 2026-10-28: the live jobs are not go-live jobs; removal is an explicit allowlist). The SQL
// runs against Postgres in tests/db/legacy_finance_unschedule.test.sql.
test('cron: step 5 removes nothing by default; --unschedule-cron names exact jobs, validated; --only-smoke never touches cron', () => {
  const { code, out } = dry();
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /unschedule-legacy-finance\.sql/, 'no unschedule command without the flag');
  assert.match(out, /kept: every other pg_cron job \(none named with --unschedule-cron\)/);
  const base = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';
  const named = dry(['--unschedule-cron', 'plaid-sync-6h,cancel-watcher-daily']);
  assert.equal(named.code, 0, named.out);
  inOrder(named.out, ['STEP 5/6 schedules', `-v url=${base}/trainee-deliver -f scripts/launch/schedule-trainee-deliver.sql`,
    'DRY: psql *** -X -q -v ON_ERROR_STOP=1 -v allow=plaid-sync-6h,cancel-watcher-daily -f scripts/launch/unschedule-legacy-finance.sql (unschedules only: plaid-sync-6h,cancel-watcher-daily)',
    'STEP 5/6 schedules: OK']);
  assert.equal(dry(['--unschedule-cron=upmore-proactive']).code, 0);
  for (const bad of ['a b', 'x;drop', 'a,,b', ',a', 'a,', "x'y"]) {
    const r = dry(['--unschedule-cron', bad]);
    assert.equal(r.code, 64, `${bad}: ${r.out}`);
    assert.match(r.out, /--unschedule-cron takes exact job names/);
  }
  assert.doesNotMatch(dry(['--only-smoke', '--unschedule-cron', 'x']).out, /unschedule-legacy-finance\.sql/);
  const sql = fs.readFileSync(path.join(root, 'scripts/launch/unschedule-legacy-finance.sql'), 'utf8');
  const code_ = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code_, /jobname = any \(names\)/, 'matches exact job names only');
  assert.doesNotMatch(code_, /\bcommand\b/, 'never matches on a job command');
  for (const verb of [/\bdrop\b/i, /\bdelete\b/i, /\btruncate\b/i, /\bupdate\b/i, /\binsert\b/i, /vault\./i, /cron\.schedule\(/])
    assert.doesNotMatch(code_, verb, `the file only unschedules (${verb})`);
  for (const job of ['upmore-proactive', 'plaid-sync-6h', 'cancel-watcher-daily', 'career-ingest', 'trainee-deliver']) assert.ok(!code_.includes(job), `${job} is never hard-coded`);
});

test('go-live never deploys an Upmore-only function: no deploy line names one, and a DEPLOY_FNS that did would stop the run', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const list = script.match(/UPMORE_ONLY_FNS=\(([^)]*)\)/);
  assert.ok(list, 'UPMORE_ONLY_FNS is declared');
  const upmoreOnly = list[1].split(/\s+/).filter(Boolean);
  for (const fn of ['agent-proactive', 'plaid-sync', 'cancel-watcher', 'agent-payments', 'stripe-webhook', 'broker-oauth-start', 'news-feed'])
    assert.ok(upmoreOnly.includes(fn), `${fn} is listed as Upmore-only`);
  for (const fn of upmoreOnly) assert.ok(fs.existsSync(path.join(root, 'supabase/functions', fn)), `${fn} is a real function directory`);
  const { code, out } = dry();
  assert.equal(code, 0, out);
  const deployed = [...out.matchAll(/supabase functions deploy ([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(deployed.includes('agent-chat') && deployed.includes('trainee-deliver'), deployed.join(','));
  for (const fn of deployed) assert.ok(!upmoreOnly.includes(fn), `${fn} is deployed and is not Upmore-only`);
  // The guard itself: a copy of the script whose DEPLOY_FNS names an Upmore-only function refuses to run.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-go-live-guard-'));
  const bad = path.join(tmp, 'go-live.sh');
  fs.writeFileSync(bad, script.replace(/^cd "\$\(dirname "\$0"\)\/\.\.\/\.\."$/m, `cd ${JSON.stringify(root)}`)
    .replace(/^DEPLOY_FNS=\(agent-chat /m, 'DEPLOY_FNS=(agent-chat plaid-sync '));
  const res = spawnSync('bash', [bad, '--dry-run'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...FAKE } });
  assert.equal(res.status, 64, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /plaid-sync is an Upmore finance function; Trainee never deploys it/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// FEATURE 17: the cloud runner ships with go-live (preparation and sending without anyone's computer).
const CLOUD = { ...FAKE, VERCEL_TOKEN: 'fake-vercel-token-0000-VVVVVVVVVVVVVVVV', VERCEL_TEAM_ID: 'team_fake0000TEAM', VERCEL_PROJECT_ID: 'prj_fake0000PROJ',
  CLOUD_SANDBOX_SNAPSHOT_ID: 'snap_fake0000SNAP', CLOUD_RUNNER_SECRET: 'fake-runner-secret-0000-RRRRRRRRRRRRRRRRRR',
  CLOUD_DISPATCH_SECRET: 'fake-dispatch-secret-0000-XXXXXXXXXXXXXXXXX', CAREER_PREPARE_AHEAD_TOKEN: 'fake-prepare-token-0000-KKKKKKKKKKKKKKKKKK',
  CLOUD_MAX_CONCURRENT: '5', CLOUD_MAX_PER_PORTAL: '2', CLOUD_MAX_PER_PERSON_DAY: '3', CLOUD_MAX_PER_SITE_MINUTE: '1',
  CLOUD_PREPARE_MAX_CONCURRENT: '3', CLOUD_PREPARE_PER_PERSON_DAY: '10', CLOUD_PREPARE_PER_SITE_MINUTE: '4' };
test('FEATURE 17 dry run: the cloud runner is deployed without JWT, its secrets and numbers set by name, its two ticks scheduled; no value printed', () => {
  const { code, out } = dry([], CLOUD);
  assert.equal(code, 0, out);
  const base = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';
  assert.match(out, /deno check [^\n]*supabase\/functions\/career-cloud-runner\/index\.ts/);
  assert.match(out, /-f supabase\/migrations\/20261026230017_career_cloud_hosted_apply\.sql/);
  const set = out.match(/supabase secrets set --project-ref abcdefghijklmnopqrst --env-file <0600 temp file: ([^>]*)>/)[1].split(' ');
  for (const n of ['CLOUD_RUNNER_SECRET=***', 'CLOUD_DISPATCH_SECRET=***', 'CAREER_PREPARE_AHEAD_TOKEN=***', 'VERCEL_TOKEN=***', 'VERCEL_TEAM_ID=team_fake0000TEAM',
    'VERCEL_PROJECT_ID=prj_fake0000PROJ', 'CLOUD_SANDBOX_SNAPSHOT_ID=snap_fake0000SNAP', 'CLOUD_MAX_CONCURRENT=5', 'CLOUD_MAX_PER_PORTAL=2', 'CLOUD_MAX_PER_PERSON_DAY=3',
    'CLOUD_MAX_PER_SITE_MINUTE=1', 'CLOUD_PREPARE_MAX_CONCURRENT=3', 'CLOUD_PREPARE_PER_PERSON_DAY=10', 'CLOUD_PREPARE_PER_SITE_MINUTE=4',
    `CLOUD_BRIDGE_URL=${base}/career-cloud-runner`, `CAREER_PREPARE_AHEAD_URL=${base}/career-cloud-runner/prepare`]) assert.ok(set.includes(n), `${n} in ${set.join(' ')}`);
  assert.ok(!set.some((n) => /^CLOUD_(RUNNER|PREPARE)_ENABLED=/.test(n)), 'the switches are not touched unless given');
  inOrder(out, ['supabase functions deploy trainee-whatsapp --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker',
    'supabase functions deploy career-cloud-runner --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker',
    `CLOUD_DISPATCH_SECRET=*** psql *** -X -q -v ON_ERROR_STOP=1 -v url=${base}/career-cloud-runner -f scripts/launch/schedule-career-cloud.sql`, 'STEP 5/6 schedules: OK']);
  for (const v of [CLOUD.VERCEL_TOKEN, CLOUD.CLOUD_RUNNER_SECRET, CLOUD.CLOUD_DISPATCH_SECRET, CLOUD.CAREER_PREPARE_AHEAD_TOKEN, ...SECRET_VALUES]) assert.ok(!out.includes(v), `${v.slice(0, 14)}… is not printed`);
  assert.doesNotMatch(out, /build-snapshot\.ts/, 'no snapshot is built (spend) unless asked');
});
test('FEATURE 17 dry run: without VERCEL_TOKEN the cloud runner is not wired (deployed, answering 503), nothing of it set or scheduled; bad numbers stop the run', () => {
  const { code, out } = dry();
  assert.equal(code, 0, out);
  assert.match(out, /cloud runner: not wired now \(VERCEL_TOKEN not given\)/);
  assert.match(out, /supabase functions deploy career-cloud-runner --project-ref abcdefghijklmnopqrst --no-verify-jwt --use-docker/);
  assert.doesNotMatch(out, /CLOUD_RUNNER_SECRET=|CAREER_PREPARE_AHEAD_URL=|schedule-career-cloud\.sql/);
  assert.match(out, /cloud runner schedules: not touched/);
  // NO LIMITS (owner, 2026-10-27): a per-person number someone sets is taken at any size; a non-number still stops the run.
  const big = dry([], { ...CLOUD, CLOUD_MAX_PER_PERSON_DAY: '500' });
  assert.equal(big.code, 0, big.out); assert.ok(big.out.includes('CLOUD_MAX_PER_PERSON_DAY=500'), 'a per-person number is set as given, any size');
  const bad = dry([], { ...CLOUD, CLOUD_MAX_PER_PERSON_DAY: 'lots' });
  assert.notEqual(bad.code, 0); assert.match(bad.out, /CLOUD_MAX_PER_PERSON_DAY must be a whole number from 1/);
  const sw = dry([], { ...CLOUD, CLOUD_RUNNER_ENABLED: 'yes' });
  assert.notEqual(sw.code, 0); assert.match(sw.out, /CLOUD_RUNNER_ENABLED takes on or off/);
  const snap = dry(['--build-snapshot'], { ...CLOUD, CLOUD_SANDBOX_SNAPSHOT_ID: '' });
  assert.equal(snap.code, 0, snap.out);
  assert.match(snap.out, /DRY: VERCEL_TOKEN=\*\*\* [^\n]*deno run -A scripts\/cloud-runner\/build-snapshot\.ts/, 'the snapshot step only with --build-snapshot');
  assert.ok(!snap.out.includes(CLOUD.VERCEL_TOKEN));
});
test('FEATURE 17: sizing not given is set to the runner\'s default; a per-person or per-site number not given is never set (NO LIMITS)', () => {
  const { code, out } = dry([], { ...CLOUD, CLOUD_MAX_CONCURRENT: '', CLOUD_MAX_PER_PORTAL: '', CLOUD_MAX_PER_PERSON_DAY: '', CLOUD_MAX_PER_SITE_MINUTE: '',
    CLOUD_PREPARE_MAX_CONCURRENT: '', CLOUD_PREPARE_PER_PERSON_DAY: '', CLOUD_PREPARE_PER_SITE_MINUTE: '' });
  assert.equal(code, 0, out);
  const set = out.match(/supabase secrets set --project-ref abcdefghijklmnopqrst --env-file <0600 temp file: ([^>]*)>/)[1].split(' ');
  const wave1 = { CLOUD_MAX_CONCURRENT: 2, CLOUD_MAX_PER_PORTAL: 1, CLOUD_MAX_STARTS_PER_TICK: 2, CLOUD_PREPARE_MAX_CONCURRENT: 2, CLOUD_PREPARE_STARTS_PER_TICK: 2 };
  for (const [k, v] of Object.entries(wave1)) assert.ok(set.includes(`${k}=${v}`), `${k}=${v} in ${set.join(' ')}`);
  for (const k of ['CLOUD_MAX_PER_PERSON_DAY', 'CLOUD_MAX_PER_SITE_MINUTE', 'CLOUD_PREPARE_PER_PERSON_DAY', 'CLOUD_PREPARE_PER_SITE_MINUTE']) {
    assert.ok(!set.some((x) => x.startsWith(`${k}=`)), `${k} is not set when not given: ${set.join(' ')}`);
  }
  const http = fs.readFileSync(path.join(root, 'supabase/functions/_shared/cloud_runner_http.ts'), 'utf8');
  for (const [k, v] of Object.entries(wave1)) assert.match(http, new RegExp(`\\b${k}: ${v},`), `the runner's default for ${k} is ${v}`);
  const given = dry([], CLOUD);
  assert.ok(given.out.includes('CLOUD_MAX_CONCURRENT=5') && !given.out.includes('CLOUD_MAX_CONCURRENT=2'), 'a number given is set as given');
});
test('FEATURE 17: the cloud schedule reads CLOUD_DISPATCH_SECRET into Vault and sends the header the runner checks, on both routes; the workflow passes every name', () => {
  const sql = fs.readFileSync(path.join(root, 'scripts/launch/schedule-career-cloud.sql'), 'utf8');
  assert.match(sql, /printf '%s' "\$CLOUD_DISPATCH_SECRET"/);
  assert.match(sql, /cron\.schedule\('career-cloud-dispatch'[\s\S]*'x-cloud-dispatch-secret'[\s\S]*'\/dispatch'/);
  assert.match(sql, /cron\.schedule\('career-cloud-prepare-dispatch'[\s\S]*'x-cloud-dispatch-secret'[\s\S]*'\/prepare-dispatch'/);
  const http = fs.readFileSync(path.join(root, 'supabase/functions/_shared/cloud_runner_http.ts'), 'utf8');
  assert.ok(http.includes('req.headers.get("x-cloud-dispatch-secret")') && http.includes('env("CLOUD_DISPATCH_SECRET")'), 'the runner checks that header against that secret');
  assert.ok(http.includes('`Bearer ${token}`') && http.includes('env("CAREER_PREPARE_AHEAD_TOKEN")'), 'and the chat kick against its token');
  const kick = fs.readFileSync(path.join(root, 'supabase/functions/_shared/career_apply_from_chat.ts'), 'utf8');
  assert.ok(kick.includes('authorization: `Bearer ${token}`') && kick.includes('"CAREER_PREPARE_AHEAD_TOKEN"'), 'the chat sends that token');
  const wf = fs.readFileSync(path.join(root, '.github/workflows/deploy-production.yml'), 'utf8');
  for (const v of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'CLOUD_SANDBOX_SNAPSHOT_ID', 'CLOUD_RUNNER_SECRET', 'CLOUD_DISPATCH_SECRET', 'CAREER_PREPARE_AHEAD_TOKEN',
    'CLOUD_MAX_CONCURRENT', 'CLOUD_MAX_PER_PORTAL', 'CLOUD_MAX_STARTS_PER_TICK', 'CLOUD_MAX_PER_PERSON_DAY', 'CLOUD_MAX_PER_SITE_MINUTE', 'CLOUD_PREPARE_MAX_CONCURRENT',
    'CLOUD_PREPARE_STARTS_PER_TICK', 'CLOUD_PREPARE_PER_PERSON_DAY', 'CLOUD_PREPARE_PER_SITE_MINUTE', 'CLOUD_RUNNER_ENABLED', 'CLOUD_PREPARE_ENABLED']) {
    assert.match(wf, new RegExp(`^ {10}${v}: \\$\\{\\{ secrets\\.${v} \\}\\}$`, 'm'), `${v} from the secret of the same name`);
  }
  const snap = fs.readFileSync(path.join(root, 'scripts/cloud-runner/build-snapshot.ts'), 'utf8');
  assert.match(snap, /deno cache [^"]*workers\/career-cloud\/prepare-runner\.ts/, 'the snapshot caches the preparation runner too');
});

// trainee-file (hosted list page) and ops-monitor are public (verify_jwt = false in supabase/config.toml) and secret-gated:
// deployed only when TRAINEE_FILE_LINK_SECRET / OPS_MONITOR_TOKEN is among the function secrets; absent = skipped, never a failure.
test('gated functions: deployed with --no-verify-jwt only when their secret is set; absent is a log line, not a failure', () => {
  const cfg = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
  for (const fn of ['trainee-file', 'ops-monitor']) assert.match(cfg, new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = false`));
  const off = dry();
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /gated: trainee-file SKIPPED \(TRAINEE_FILE_LINK_SECRET is not among the function secrets\)/);
  assert.match(off.out, /gated: ops-monitor SKIPPED \(OPS_MONITOR_TOKEN is not among the function secrets\)/);
  assert.doesNotMatch(off.out, /functions deploy (trainee-file|ops-monitor)/);
  const on = dry([], { ...FAKE, TRAINEE_FILE_LINK_SECRET: 'fake-file-link-secret-0000-FFFFFFFFFFFFFFFF', OPS_MONITOR_TOKEN: 'fake-ops-monitor-token-0000-OOOOOOOOOOOOOOO' });
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /supabase functions deploy trainee-file --project-ref \S+ --no-verify-jwt --use-docker/);
  assert.match(on.out, /supabase functions deploy ops-monitor --project-ref \S+ --no-verify-jwt --use-docker/);
  assert.match(on.out, /deno check [^\n]*trainee-file\/index\.ts [^\n]*ops-monitor\/index\.ts/);
  assert.doesNotMatch(on.out, /trainee-connect/);
  const only = dry([], { ...FAKE, OPS_MONITOR_TOKEN: 'fake-ops-monitor-token-0000-OOOOOOOOOOOOOOO' });
  assert.match(only.out, /gated: trainee-file SKIPPED/);
  assert.match(only.out, /functions deploy ops-monitor /);
  assert.doesNotMatch(only.out, /functions deploy trainee-file/);
});

test('gated functions: a failed secrets listing skips both with a log line, never deploys them ungated, and does not abort the run', () => {
  const r = nonint(['--sha', HEAD_SHA, '--skip-migrations'], CI_ENV, { listFails: true, bundleOk: true });
  assert.match(r.out, /gated: trainee-file SKIPPED \(secrets list unavailable\)/, r.out);
  assert.match(r.out, /gated: ops-monitor SKIPPED \(secrets list unavailable\)/);
  assert.doesNotMatch(r.calls, /functions deploy (trainee-file|ops-monitor)/);
  assert.doesNotMatch(r.out, /gated: \S+ will be deployed/);
});

test('--verify with no project ref: the gated-secrets lookup is skipped (no secrets list call) and does not abort', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trainee-go-live-verify-'));
  const calls = path.join(bin, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  stub('supabase', 'exit 1'); stub('psql', 'exit 0'); stub('deno', 'exit 0');
  const { SUPABASE_PROJECT_REF, ...noRef } = FAKE;
  const res = spawnSync('bash', [SCRIPT, '--verify', HEAD_SHA], { cwd: root, encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TRAINEE_GO_LIVE_LOG: path.join(bin, 'run.log'), ...noRef } });
  const out = res.stdout + res.stderr;
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /secrets list/, 'no lookup without a ref');
  assert.doesNotMatch(out, /could not read the project's secret names/);
  assert.match(out, /gated: trainee-file SKIPPED \(secrets list unavailable: no project ref\)/, out);
});

// ---- OPS: certification, explicit NOT RUN reasons, and the recorded smoke result ----
const FILE_URL = 'https://app.example.test/file';
test('checkFilePage: a made-up link refused with a 4xx page passes; 404, 503 not-set-up, and an open page fail with the fix named', async () => {
  const f = fakeFetch(() => [410, { error: 'expired' }]);
  assert.equal((await smoke.checkFilePage({ url: FILE_URL, fetchFn: f })).status, 'PASS');
  assert.match(f.calls[0].url, /^https:\/\/app\.example\.test\/file\?t=smoke-/);
  const nf = await smoke.checkFilePage({ url: FILE_URL, fetchFn: fakeFetch(() => [404, {}]) });
  assert.equal(nf.status, 'FAIL'); assert.match(nf.detail, /not deployed/);
  const ns = await smoke.checkFilePage({ url: FILE_URL, fetchFn: fakeFetch(() => [503, { error: 'File pages are not set up yet.' }]) });
  assert.equal(ns.status, 'FAIL'); assert.match(ns.detail, /TRAINEE_FILE_UPSTREAM/); assert.match(ns.detail, /TRAINEE_FILE_LINK_SECRET/);
  assert.equal((await smoke.checkFilePage({ url: FILE_URL, fetchFn: fakeFetch(() => [200, {}]) })).status, 'FAIL');
  assert.equal((await smoke.checkFilePage({ url: 'http://plain.test/file', fetchFn: fakeFetch(() => [410, {}]) })).status, 'FAIL');
});

test('certify: only a live PASS certifies; real Apply is never certified by a smoke; every uncertified line says why', () => {
  const p = (check) => ({ status: 'PASS', check, detail: '' });
  const all = [p('file page (TRAINEE_FILE_BASE_URL) refuses a made-up link'), p('trainee-inbound refuses a wrong secret'), p('trainee-inbound answers the right secret'),
    p('trainee-inbound answers HELP (texted to TRAINEE_SMOKE_CONTACT)'), p('schedule trainee-deliver'), p('preparation host (phone-only preparation) is up')];
  const c = Object.fromEntries(smoke.certify(all).map((x) => [x.feature, x]));
  assert.ok(c['file endpoint'].certified && c.inbound.certified && c['phone login'].certified);
  assert.equal(c['real Apply'].certified, false); assert.match(c['real Apply'].reason, /confirmed by the employer/);
  const none = Object.fromEntries(smoke.certify([{ status: 'NOT RUN', check: 'trainee-inbound answers HELP', detail: 'skipped' }, { status: 'WARN', check: 'trainee-inbound answers HELP (texted to X)', detail: 'HTTP 503, not wired yet: NOT_WIRED: LOOPMESSAGE_API_KEY is not set' }]).map((x) => [x.feature, x]));
  for (const f of ['file endpoint', 'inbound', 'phone login', 'real Apply']) { assert.equal(none[f].certified, false, f); assert.ok(none[f].reason.length > 20, f); }
  assert.match(none.inbound.reason, /LOOPMESSAGE_API_KEY/); assert.match(none['file endpoint'].reason, /TRAINEE_FILE_BASE_URL/);
  const failed = smoke.certify([{ status: 'FAIL', check: 'file page (TRAINEE_FILE_BASE_URL) refuses a made-up link', detail: 'HTTP 404' }, p('trainee-inbound answers HELP (x)')]);
  assert.equal(failed.find((x) => x.feature === 'phone login').certified, false);
});

test('main: prints a certified / not certified line per feature, names why each NOT RUN, records one counts-only row, and survives an unrecordable result', async () => {
  const env = { SUPABASE_URL: BASE, ...FAKE, GITHUB_SHA: '0768a16' + 'a'.repeat(33), TRAINEE_FILE_BASE_URL: FILE_URL };
  const fetchFn = fakeFetch((c) => c.fn === 'file' ? [410, {}] : c.fn === 'agent-chat' ? (c.init.headers.Authorization ? [200, { reply: 'hello there' }] : [401, {}]) : c.fn === 'trainee-inbound' && c.body && c.body.text ? [503, { error: 'NOT_WIRED: LOOPMESSAGE_API_KEY is not set; no turn was run' }] : handlerLike(c));
  const lines = [], sqls = [];
  const sql = async (q) => { sqls.push(q); return q.includes('cron.job') ? goodJobs.map((j) => j.join('|')).join('\n') : q.startsWith('insert') ? '' : fakeSql(goodJobs, goodRuns)(q); };
  const code = await smoke.main(['--allow-send'], env, { fetch: fetchFn, sql, log: (s) => lines.push(s) });
  const out = lines.join('\n');
  assert.equal(code, 0, out);
  assert.match(out, /^CERT +CERTIFIED file endpoint: /m);
  assert.match(out, /^CERT +NOT CERTIFIED inbound: .*LOOPMESSAGE_API_KEY/m);
  assert.match(out, /^CERT +NOT CERTIFIED phone login: /m);
  assert.match(out, /^CERT +NOT CERTIFIED real Apply: .*confirmed by the employer/m);
  const ins = sqls.filter((q) => q.startsWith('insert'));
  assert.equal(ins.length, 1);
  assert.match(ins[0], /'deploy_smoke'/); assert.match(ins[0], /"fail":0/); assert.match(ins[0], /"sha":"0768a16/);
  for (const v of Object.values(FAKE)) assert.ok(!ins[0].includes(v) && !out.includes(v), 'no secret in the row or the log');
  const bare = [];
  await smoke.main([], { SUPABASE_URL: BASE, ...FAKE }, { fetch: fakeFetch((c) => c.fn === 'agent-chat' ? [401, {}] : handlerLike(c)), sql: async () => { throw new Error('db down'); }, log: (s) => bare.push(s) });
  const b = bare.join('\n');
  assert.match(b, /^NOT RUN file page \(TRAINEE_FILE_BASE_URL\): NOT_WIRED: .*TRAINEE_FILE_LINK_SECRET.*TRAINEE_FILE_UPSTREAM/m);
  assert.match(b, /^CERT +NOT CERTIFIED file endpoint: .*TRAINEE_FILE_BASE_URL/m);
});

test('recordSql: only counts, booleans and a validated sha reach the row', () => {
  const q = smoke.recordSql({ pass: 1, warn: 0, fail: 2, not_run: 3 }, [{ feature: 'phone login', certified: false, reason: "x'; drop table founder_alerts; --" }], "0768a16'; drop");
  assert.ok(!q.includes('drop') && q.includes('"sha":""') && q.includes('"phone_login":false'));
});
