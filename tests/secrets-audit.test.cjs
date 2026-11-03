'use strict';
// scripts/launch/secrets-audit.sh: names only, never a value; exit 0/1/2 as documented. A stub supabase CLI stands in for the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const SH = path.join(root, 'scripts/launch/secrets-audit.sh');
const CANARY = 'sk-canary-VALUE-0123456789abcdef', DIGEST = 'deadbeefdigest0123456789';

function run(args, env = {}, stubJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  if (stubJson !== undefined) { const f = path.join(dir, 'supabase'); fs.writeFileSync(f, `#!/usr/bin/env bash\necho '${stubJson}'\n`, { mode: 0o755 }); }
  const r = spawnSync('bash', [SH, ...args], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...env }, cwd: root });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}
const namesFile = (lines) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'names-')), 'n.txt'); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

test('missing launch secrets are listed by name with what they unlock; exit 1', () => {
  const r = run(['--names-file', namesFile(['ANTHROPIC_API_KEY', 'TRAINEE_FILE_LINK_SECRET'])]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^fn +LOOPMESSAGE_API_KEY +MISSING .*phone-login code/m);
  assert.match(r.out, /^fn +OPS_MONITOR_TOKEN +MISSING /m);
  assert.match(r.out, /^fn +OWNER_TELEGRAM_CHAT_ID +MISSING /m);
  assert.match(r.out, /^vercel +TRAINEE_FILE_UPSTREAM +UNKNOWN /m);
  assert.doesNotMatch(r.out, /^fn +ANTHROPIC_API_KEY /m, 'a secret that is set is not listed');
});

test('a name file line that carries a value (NAME=value) is ignored, and no value ever reaches the output', () => {
  const r = run(['--names-file', namesFile([`ANTHROPIC_API_KEY=${CANARY}`, CANARY, 'LOOPMESSAGE_API_KEY'])]);
  assert.ok(!r.out.includes(CANARY));
  assert.match(r.out, /ANTHROPIC_API_KEY +MISSING/, 'a NAME=value line is not trusted as a name');
});

test('the supabase CLI output is reduced to names: values and digests are dropped', () => {
  const json = JSON.stringify([{ name: 'ANTHROPIC_API_KEY', value: DIGEST + CANARY }, { name: 'LOOPMESSAGE_API_KEY', value: DIGEST }]);
  const r = run([], { SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }, json);
  assert.ok(!r.out.includes(DIGEST) && !r.out.includes(CANARY));
  assert.doesNotMatch(r.out, /^fn +LOOPMESSAGE_API_KEY /m);
  assert.match(r.out, /^fn +TRAINEE_INBOUND_SECRET +MISSING /m);
});

test('all launch secrets present (vercel names given) exits 0; --strict also needs the optional ones', () => {
  const sh = fs.readFileSync(SH, 'utf8');
  const launch = [...sh.matchAll(/^fn\|([A-Z0-9_]+)\|R\|/gm)].map((m) => m[1]);
  const opt = [...sh.matchAll(/^fn\|([A-Z0-9_]+)\|O\|/gm)].map((m) => m[1]);
  const v = namesFile(['TRAINEE_FILE_UPSTREAM', 'TRAINEE_CONNECT_UPSTREAM']);
  assert.ok(launch.includes('OPS_MONITOR_TOKEN') && launch.includes('TRAINEE_FILE_LINK_SECRET') && launch.includes('TRAINEE_BOT_URL') && launch.includes('TRAINEE_FILE_BASE_URL'));
  assert.equal(run(['--names-file', namesFile(launch), '--vercel-names-file', v]).code, 0);
  assert.equal(run(['--names-file', namesFile(launch), '--vercel-names-file', v, '--strict']).code, 1);
  assert.equal(run(['--names-file', namesFile([...launch, ...opt]), '--vercel-names-file', v, '--strict']).code, 0);
});

test('names it cannot read: exit 2 and nothing is reported as present', () => {
  const r = run([], { SUPABASE_PROJECT_REF: '' });
  assert.equal(r.code, 2); assert.match(r.out, /^NOT RUN: could not read/m);
  assert.doesNotMatch(r.out, /MISSING/);
});
