'use strict';
// Hosted apply setup (scripts/launch/hosted-apply-setup.cjs, secrets-audit.sh tier C, trainee-go-live.sh --verify): names only;
// off by design reads as such, never as working; switches ON with a missing prerequisite fails. Check: node --test tests/hosted-apply-setup.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const { assess, PREREQS } = require(path.join(root, 'scripts/launch/hosted-apply-setup.cjs'));
const AUDIT = path.join(root, 'scripts/launch/secrets-audit.sh');
const CANARY = 'sk-canary-VALUE-0123456789abcdef';

const names = (w) => PREREQS.filter((p) => p.where === w).map((p) => p.name);
const ALL_ON = { CAREER_AGENT_SUBMIT: 'on', CAREER_CLOUD_APPLY: 'on', CAREER_CLOUD_TEXT_CARDS: 'on' };
const full = () => ({ fn: names('fn'), vercel: names('vercel'), cron: names('cron'), functions: names('function'), settings: { ...ALL_ON } });
const tmp = (lines) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')), 'f.txt'); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

test('the list covers every cloud-runner secret cloud_runner_http.ts reads, api/file.js, and the trainee-file function', () => {
  const http = fs.readFileSync(path.join(root, 'supabase/functions/_shared/cloud_runner_http.ts'), 'utf8');
  const needed = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'CLOUD_SANDBOX_SNAPSHOT_ID', 'CLOUD_BRIDGE_URL', 'CLOUD_RUNNER_SECRET', 'CLOUD_DISPATCH_SECRET', 'CAREER_PREPARE_AHEAD_TOKEN'];
  for (const n of needed) { assert.ok(http.includes(`"${n}"`), `${n} is read by cloud_runner_http.ts`); assert.ok(names('fn').includes(n), `${n} is a hosted-apply prerequisite`); }
  assert.ok(fs.readFileSync(path.join(root, 'api/file.js'), 'utf8').includes('TRAINEE_FILE_UPSTREAM') && names('vercel').includes('TRAINEE_FILE_UPSTREAM'));
  for (const n of ['TRAINEE_FILE_LINK_SECRET', 'TRAINEE_FILE_BASE_URL', 'TRAINEE_BOT_URL', 'CAREER_PREPARE_AHEAD_URL']) assert.ok(names('fn').includes(n), n);
  assert.deepEqual(names('cron'), ['career-cloud-dispatch', 'career-cloud-prepare-dispatch']);
});

test('the secrets audit manifest carries the cloud-runner names as tier C, in step with the list', () => {
  const sh = fs.readFileSync(AUDIT, 'utf8');
  const c = [...sh.matchAll(/^fn\|([A-Z0-9_]+)\|C\|/gm)].map((m) => m[1]).sort();
  const inList = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'CLOUD_SANDBOX_SNAPSHOT_ID', 'CLOUD_RUNNER_SECRET', 'CLOUD_DISPATCH_SECRET', 'CLOUD_BRIDGE_URL'].sort();
  assert.deepEqual(c, inList);
  for (const n of c) assert.ok(names('fn').includes(n));
  const known = new Set([...sh.matchAll(/^(?:fn|vercel)\|([A-Z0-9_]+)\|[RODC]\|/gm)].map((m) => m[1]));
  for (const p of PREREQS.filter((p) => p.where === 'fn' || p.where === 'vercel')) assert.ok(known.has(p.name), `${p.name} is in the audit manifest`);
});

test('switches off: "hosted apply: off by design", never green-and-working, and no failure however much is missing', () => {
  const r = assess({ fn: [], vercel: [], cron: [], functions: [], settings: { CAREER_AGENT_SUBMIT: 'off', CAREER_CLOUD_APPLY: 'off', CAREER_CLOUD_TEXT_CARDS: 'on' } });
  assert.equal(r.verdict, 'off-by-design'); assert.equal(r.fail, false);
  assert.match(r.lines[0], /^hosted apply: off by design \(CAREER_AGENT_SUBMIT is 'off'; CAREER_CLOUD_APPLY is 'off'\)/);
  assert.ok(r.missing.length === PREREQS.length, 'everything missing is still listed');
  assert.doesNotMatch(r.lines.join("\n"), /every prerequisite present|NOT READY/);
});

test('a missing switch row reads as off by design (the database reads anything but on as off)', () => {
  const r = assess({ ...full(), settings: { CAREER_AGENT_SUBMIT: 'on', CAREER_CLOUD_APPLY: 'on' } });
  assert.equal(r.verdict, 'off-by-design'); assert.match(r.lines[0], /CAREER_CLOUD_TEXT_CARDS has no row/);
});

test('switches ON and a prerequisite missing: NOT READY and fail, each missing name listed', () => {
  const f = full(); f.fn = f.fn.filter((n) => n !== 'VERCEL_TOKEN' && n !== 'CLOUD_BRIDGE_URL'); f.cron = ['career-cloud-dispatch'];
  const r = assess(f);
  assert.equal(r.verdict, 'not-ready'); assert.equal(r.fail, true);
  assert.deepEqual(r.missing.sort(), ['CLOUD_BRIDGE_URL', 'VERCEL_TOKEN', 'career-cloud-prepare-dispatch']);
  assert.match(r.lines[0], /switches are ON but it is NOT READY/);
});

test('switches ON and everything present: ready, with the per-person rows named as not checked', () => {
  const r = assess(full());
  assert.equal(r.verdict, 'ready'); assert.equal(r.fail, false); assert.match(r.lines[0], /waiver and each person's opt-in .* not checked/);
});

test('a source not read is UNCHECKED, never present and never missing; switches unreadable never fail', () => {
  const r = assess({ fn: names('fn'), settings: null });
  assert.equal(r.verdict, 'switches-unknown'); assert.equal(r.fail, false);
  assert.deepEqual(r.missing, []); assert.ok(r.unchecked.includes('trainee-file') && r.unchecked.includes('TRAINEE_FILE_UPSTREAM'));
  const on = assess({ fn: names('fn'), settings: { ...ALL_ON } });
  assert.equal(on.verdict, 'unverified'); assert.equal(on.fail, false);
});

test('CLI: files in, lines out, exit 1 only for ON and not ready; a NAME=value line is not a name and no value is printed', () => {
  const run = (args) => spawnSync('node', [path.join(root, 'scripts/launch/hosted-apply-setup.cjs'), ...args], { encoding: 'utf8' });
  const off = run(['--secrets-file', tmp(['OPENAI_API_KEY']), '--settings-file', tmp(['CAREER_AGENT_SUBMIT=off', 'CAREER_CLOUD_APPLY=off'])]);
  assert.equal(off.status, 0); assert.match(off.stdout, /^hosted apply: off by design/m);
  const on = run(['--secrets-file', tmp([`VERCEL_TOKEN=${CANARY}`, CANARY]), '--settings-file', tmp(Object.entries(ALL_ON).map(([k, v]) => `${k}=${v}`))]);
  assert.equal(on.status, 1); assert.match(on.stdout, /MISSING +fn +VERCEL_TOKEN/); assert.ok(!(on.stdout + on.stderr).includes(CANARY));
  assert.equal(run(['--nope']).status, 2);
});

function audit(args, names_) {
  const r = spawnSync('bash', [AUDIT, '--names-file', tmp(names_), ...args], { encoding: 'utf8', cwd: root, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  return { code: r.status, out: r.stdout + r.stderr };
}
const launch = () => { const sh = fs.readFileSync(AUDIT, 'utf8'); return [...sh.matchAll(/^fn\|([A-Z0-9_]+)\|R\|/gm)].map((m) => m[1]); };

test('secrets audit: missing cloud-runner names are tagged [hosted apply], reported, and do not change the exit code on their own', () => {
  const v = tmp(['TRAINEE_FILE_UPSTREAM', 'TRAINEE_CONNECT_UPSTREAM']);
  const r = audit(['--vercel-names-file', v], launch());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^fn +VERCEL_TOKEN +MISSING .*\[hosted apply\]/m);
  assert.match(r.out, /^hosted apply: the database switches were not read/m);
  assert.match(r.out, /MISSING +fn +CLOUD_RUNNER_SECRET/);
});

test('secrets audit: --require-hosted-apply makes a missing name launch-blocking', () => {
  const v = tmp(['TRAINEE_FILE_UPSTREAM']);
  assert.equal(audit(['--vercel-names-file', v, '--require-hosted-apply'], launch()).code, 1);
  const all = [...launch(), ...names('fn')];
  assert.equal(audit(['--vercel-names-file', v, '--require-hosted-apply', '--cloud-settings-file', tmp(['CAREER_AGENT_SUBMIT=off'])], all).code, 0);
});

test('secrets audit: given the switches, off reads "off by design" (exit 0) and ON with names missing fails', () => {
  const v = tmp(['TRAINEE_FILE_UPSTREAM']);
  const off = audit(['--vercel-names-file', v, '--cloud-settings-file', tmp(['CAREER_AGENT_SUBMIT=off', 'CAREER_CLOUD_APPLY=off', 'CAREER_CLOUD_TEXT_CARDS=on'])], launch());
  assert.equal(off.code, 0, off.out); assert.match(off.out, /^hosted apply: off by design/m);
  const on = audit(['--vercel-names-file', v, '--cloud-settings-file', tmp(Object.entries(ALL_ON).map(([k, x]) => `${k}=${x}`))], launch());
  assert.equal(on.code, 1, on.out); assert.match(on.out, /switches are ON but it is NOT READY/);
});

test('--require-switches: switches unreadable => loud UNKNOWN line and exit 1; switches known off => off by design, exit 0', () => {
  const run = (args) => spawnSync('node', [path.join(root, 'scripts/launch/hosted-apply-setup.cjs'), '--require-switches', ...args], { encoding: 'utf8' });
  const s = tmp(['OPENAI_API_KEY']);
  const unk = run(['--secrets-file', s]);
  assert.equal(unk.status, 1); assert.match(unk.stdout, /^hosted apply: UNKNOWN \(could not read switches\)$/m);
  const off = run(['--secrets-file', s, '--settings-file', tmp(['CAREER_AGENT_SUBMIT=off', 'CAREER_CLOUD_APPLY=off'])]);
  assert.equal(off.status, 0); assert.match(off.stdout, /^hosted apply: off by design/m);
  const empty = run(['--secrets-file', s, '--settings-file', tmp([])]);
  assert.equal(empty.status, 0, 'a table read that returned no rows is known (all off), not unknown');
});

test('go-live --verify with a failing settings query fails closed (stub psql)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-stub-'));
  fs.writeFileSync(path.join(dir, 'psql'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const HA = path.join(root, 'scripts/launch/hosted-apply-setup.cjs');
  const sh = fs.readFileSync(path.join(root, 'scripts/launch/trainee-go-live.sh'), 'utf8');
  assert.match(sh, /hosted-apply-setup\.cjs" --require-switches/, 'verify passes --require-switches');
  // The block as verify runs it, with HA_ARGS empty because every query failed: must exit non-zero with the UNKNOWN line.
  const r = spawnSync('bash', ['-c', `node ${HA} --require-switches; echo code=$?`], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.match(r.stdout, /hosted apply: UNKNOWN \(could not read switches\)/); assert.match(r.stdout, /code=1/);
});

test('secrets audit: --require-hosted-apply with unreadable switches fails; without it the documented behavior (exit 0) is kept', () => {
  const v = tmp(['TRAINEE_FILE_UPSTREAM']);
  const all = [...launch(), ...names('fn')];
  assert.equal(audit(['--vercel-names-file', v], all).code, 0);
  const r = audit(['--vercel-names-file', v, '--require-hosted-apply'], all);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /^hosted apply: UNKNOWN \(could not read switches\)/m);
});

test('go-live --verify runs the hosted-apply check, reads only, and fails on ON-but-not-ready', () => {
  const sh = fs.readFileSync(path.join(root, 'scripts/launch/trainee-go-live.sh'), 'utf8');
  assert.match(sh, /hosted-apply-setup\.cjs" --require-switches \$\{HA_ARGS/);
  assert.match(sh, /\(\( ha_code == 0 \)\) \|\| fail "hosted apply is switched on but not ready/);
  const verify = sh.slice(sh.indexOf('if [[ -n "$VERIFY_MODE" ]]; then\n  step "verify'), sh.indexOf('step "1/6 preflight"'));
  assert.ok(!/\b(insert|update|delete|alter|drop|create)\b[^\n]*(into|table|set)/i.test(verify.split('hosted apply setup:')[1] || ''), 'no write in the hosted-apply block');
  const dry = spawnSync('bash', [path.join(root, 'scripts/launch/trainee-go-live.sh'), '--dry-run', '--verify', spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /DRY: .*hosted-apply-setup\.cjs/);
});
