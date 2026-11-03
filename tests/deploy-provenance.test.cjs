// WO-093 deploy provenance (C6: production was not built from the measured commit). scripts/launch/trainee-go-live.sh
// ships exactly the commit the owner names: it refuses a dirty tree, a missing or wrong --sha and a stale router bundle,
// stages only `git archive <sha>`, prints a provenance manifest whose hashes depend on the commit alone, fails loudly on a
// missing migration mark, writes one deploy ledger row per function and per mark, and --verify compares the ledger and
// the live marks to the manifest. Real runs here go over stub tools (supabase, psql, deno, the smoke): nothing reaches a
// network or a database. Check: node --test tests/deploy-provenance.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const SCRIPT = path.join(root, 'scripts/launch/trainee-go-live.sh');
const prov = require(path.join(root, 'scripts/launch/deploy-provenance.cjs'));

// Every temp dir this file makes (a staged commit is ~30 MB) is removed when it ends.
const made = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const REAL_PY = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const OTHER = HEAD.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
// FEATURE 16: trainee-telegram-link (Telegram's login) ships with the rest, JWT on (trainee-go-live.sh JWT_FNS).
const FNS = ['agent-chat', 'career-ingest', 'career-proactive', 'trainee-deliver', 'trainee-inbound', 'career-voice', 'trainee-telegram', 'trainee-whatsapp', 'trainee-telegram-link', 'outlook-oauth', 'career-send', 'career-cloud-runner'];

// Distinctive fakes; none may ever be printed (all labelled fake for tests/no-secrets.test.cjs).
const FAKE = {
  SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  SUPABASE_DB_URL: 'postgresql://postgres:fake-dbpass-WO93x@db.example.test:5432/postgres',
  CAREER_INGEST_SECRET: 'fake-ingest-secret-0093-IIIIIIIIIIIIIIIIIIII',
  CAREER_PROACTIVE_SECRET: 'fake-proactive-secret-0093-PPPPPPPPPPPPPPPP',
  TRAINEE_DELIVER_SECRET: 'fake-deliver-secret-0093-DDDDDDDDDDDDDDDDDD',
  TRAINEE_INBOUND_SECRET: 'fake-inbound-secret-0093-NNNNNNNNNNNNNNNNNN',
};
const SECRET_VALUES = Object.entries(FAKE).filter(([k]) => k !== 'SUPABASE_PROJECT_REF').map(([, v]) => v);

// The migrations go-live applies, from the script itself (the manifest lists exactly these, earlier ones first).
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const arrayOf = (name) => {
  const body = new RegExp(`\\n${name}=\\(([\\s\\S]*?)\\)\\n`).exec(SRC)[1];
  return name.endsWith('MARK') ? [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : body.split(/\s+/).filter((x) => x.endsWith('.sql'));
};
const MIGRATIONS = arrayOf('MIGRATIONS'), MARKS = arrayOf('MIGRATION_MARK');

function stageHead(sha = HEAD) {
  const dir = tmp('wo093-stage-');
  execFileSync('bash', ['-c', `git archive --format=tar ${sha} -- supabase scripts packages corpus | tar -x -C "${dir}"`], { cwd: root });
  return dir;
}
function migrationTsv(dir) {
  const earlier = arrayOf('EARLIER'), earlierMarks = arrayOf('EARLIER_MARK');
  const lines = [...earlier.map((f, i) => `earlier\t${f}\t${earlierMarks[i]}`), ...MIGRATIONS.map((f, i) => `trainee\t${f}\t${MARKS[i]}`)];
  const file = path.join(dir, 'migrations.tsv');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
const EXPECTED = (() => {
  const stage = stageHead();
  return prov.buildManifest({ stage, sha: HEAD, functions: FNS, migrations: prov.readMigrationList(migrationTsv(tmp('wo093-m-'))), tools: {} });
})();

// A real run over stubs. psql answers from a small table (env STUB_*), and every call is logged.
function realRun(args, { env = {}, dirty = false, stalePy = '', ledgerFunctions = '', ledgerMigrations = '' } = {}) {
  const bin = tmp('wo093-bin-');
  const calls = path.join(bin, 'calls.log');
  const sh = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${calls}"\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  const table = ['   ID | NAME | SLUG | STATUS | VERSION | UPDATED_AT (UTC)', '  ----|------|------|--------|---------|------------------',
    ...FNS.map((f, i) => `   id${i} | ${f} | ${f} | ACTIVE | ${300 + i} | 2026-10-20 22:00:00`)].join('\\n');
  sh('supabase', `if [[ "$1 $2" == "functions list" ]]; then printf "${table}\\n"; fi; exit 0`);
  sh('deno', 'exit 0');
  sh('node', `if [[ "$1" == *trainee-smoke.cjs ]]; then exit 0; fi\nexec "${process.execPath}" "$@"`);
  sh('git', `if [[ "$1" == status ]]; then ${dirty ? 'echo " M supabase/functions/trainee-deliver/handler.ts"; ' : ''}exit 0; fi\nexec "${REAL_GIT}" "$@"`);
  sh('python3', stalePy ? `if [[ "$*" == *"${stalePy}"* ]]; then echo "Router bundle is stale: supabase/functions/_shared/router_core.career.js"; exit 1; fi\nexec "${REAL_PY}" "$@"` : `exec "${REAL_PY}" "$@"`);
  fs.writeFileSync(path.join(bin, 'lf.txt'), ledgerFunctions); fs.writeFileSync(path.join(bin, 'lm.txt'), ledgerMigrations);
  fs.writeFileSync(path.join(bin, 'psql-stub.cjs'), `
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, 'psql ' + a.slice(1).join(' ') + '\\n');
const i = a.findIndex((x) => x === '-tAc' || x === '-c'); const q = i >= 0 ? a[i + 1] : '';
const e = process.env;
if (a[i] !== '-tAc') process.exit(0);
let out = 't';
if (q.includes('upmore_migration_ledger') && q.includes('case when')) out = e.STUB_LEDGER || 'missing';
else if (q.includes('count(*) from public.upmore_migration_ledger')) out = e.STUB_IN_LEDGER || '0';
else if (q.includes('distinct on (function_name)')) out = fs.readFileSync(${JSON.stringify(path.join(bin, 'lf.txt'))}, 'utf8').trim();
else if (q.includes('distinct on (migration_file)')) out = fs.readFileSync(${JSON.stringify(path.join(bin, 'lm.txt'))}, 'utf8').trim();
else if (q.startsWith('select (') && e.STUB_MISSING_MARK && q.includes(e.STUB_MISSING_MARK)) out = 'f';
process.stdout.write(out + '\\n');
`);
  // psql logs its own call (without the database URL) in psql-stub.cjs.
  fs.writeFileSync(path.join(bin, 'psql'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${path.join(bin, 'psql-stub.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'psql'), 0o755);
  const home = tmp('wo093-home-');
  const res = spawnSync('bash', [SCRIPT, ...args], { cwd: root, encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: os.tmpdir(), TRAINEE_GO_LIVE_LOG: path.join(bin, 'run.log'), ...FAKE, ...env } });
  const out = res.stdout + res.stderr;
  for (const v of SECRET_VALUES) assert.ok(!out.includes(v), `${v.slice(0, 12)}… is never printed`);
  return { code: res.status, out, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', home };
}

test('a dirty tree is refused before anything is staged or changed', () => {
  const r = realRun(['--sha', HEAD], { dirty: true });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STEP 1\/6 preflight: FAILED: the tree has uncommitted changes/);
  assert.doesNotMatch(r.calls, /git archive|secrets set|functions deploy|psql/);
});

test('--sha is required, must be the full 40 characters, and must be HEAD (dry runs too)', () => {
  const none = realRun([]);
  assert.equal(none.code, 1);
  assert.match(none.out, /FAILED: --sha <40-character commit> is required/);
  const short = realRun(['--sha', HEAD.slice(0, 8)]);
  assert.match(short.out, /FAILED: --sha must be the full 40-character commit/);
  const other = realRun(['--sha', OTHER]);
  assert.equal(other.code, 1);
  assert.match(other.out, new RegExp(`FAILED: HEAD is ${HEAD}, not the --sha ${OTHER}`));
  for (const r of [none, short, other]) assert.doesNotMatch(r.calls, /git archive|secrets set|functions deploy|psql/, 'nothing staged or changed');
  const dry = spawnSync('bash', [SCRIPT, '--dry-run', '--sha', OTHER], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('wo093-h-'), ...FAKE } });
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, /FAILED: HEAD is /);
  const dryNone = spawnSync('bash', [SCRIPT, '--dry-run'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('wo093-h-'), ...FAKE } });
  assert.match(dryNone.stdout, /--sha: not given \(a real run stops here/);
});

test('a stale router bundle in the staged commit is refused (either check), before anything changes', () => {
  for (const which of ['--career-only', 'build-router-core.py --check']) {
    const r = realRun(['--sha', HEAD], { stalePy: which });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Router bundle is stale/);
    assert.match(r.out, new RegExp(`FAILED: the router bundle at ${HEAD} is stale`));
    assert.match(r.calls, new RegExp(`git archive --format=tar ${HEAD} -- supabase scripts packages corpus`), 'checked in the staged commit');
    assert.doesNotMatch(r.calls, /secrets set|functions deploy|psql/);
  }
});

test('the manifest of a fixed sha is the same every time, from git archive, and names every function and migration', () => {
  const again = prov.buildManifest({ stage: stageHead(), sha: HEAD, functions: FNS, migrations: prov.readMigrationList(migrationTsv(tmp('wo093-m-'))), tools: {} });
  assert.deepEqual(prov.stablePart(again), prov.stablePart(EXPECTED), 'same sha, same hashes');
  assert.deepEqual(EXPECTED.functions.map((f) => f.name), FNS);
  for (const f of EXPECTED.functions) { assert.match(f.bundle_sha256, prov.HEX64); assert.match(f.entry_sha256, prov.HEX64); assert.ok(f.files >= 1); }
  assert.deepEqual(EXPECTED.migrations.filter((m) => m.kind === 'trainee').map((m) => m.file), MIGRATIONS);
  assert.ok(MIGRATIONS.includes('20261022120500_career_deploy_ledger.sql'), 'the ledger migration ships with go-live');
  // Each hash is the commit's own bytes: the entry and a migration, read straight from git.
  const deliver = EXPECTED.functions.find((f) => f.name === 'trainee-deliver');
  const crypto = require('node:crypto');
  const gitSha = (p) => crypto.createHash('sha256').update(execFileSync('git', ['show', `${HEAD}:${p}`], { cwd: root })).digest('hex');
  assert.equal(deliver.entry_sha256, gitSha('supabase/functions/trainee-deliver/index.ts'));
  for (const [k, v] of Object.entries(deliver.file_sha256)) assert.equal(v, gitSha(`supabase/functions/${k}`), k);
  const ledger = EXPECTED.migrations.find((m) => m.file === '20261022120500_career_deploy_ledger.sql');
  assert.equal(ledger.sha256, gitSha('supabase/migrations/20261022120500_career_deploy_ledger.sql'));
  // agent-chat's bundle is exactly what stage-career.cjs stages (index-career.ts as agent-chat/index.ts).
  const stage = stageHead();
  const staged = JSON.parse(execFileSync(process.execPath, [path.join(stage, 'scripts/career/stage-career.cjs'), tmp('wo093-sc-'), '--json'], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(EXPECTED.functions[0].file_sha256).sort(), staged.fileList.map((f) => f.path).sort());
  // One changed file changes the bundles that import it and no other.
  fs.appendFileSync(path.join(stage, 'supabase/functions/trainee-deliver/index.ts'), '\n// changed\n');
  const changed = prov.buildManifest({ stage, sha: HEAD, functions: FNS, migrations: [], tools: {} });
  for (const f of changed.functions) {
    if (f.name === 'trainee-deliver') assert.notEqual(f.bundle_sha256, deliver.bundle_sha256);
    else assert.equal(f.bundle_sha256, EXPECTED.functions.find((x) => x.name === f.name).bundle_sha256, f.name);
  }
  assert.throws(() => prov.buildManifest({ stage, sha: HEAD.slice(0, 8), functions: FNS, migrations: [], tools: {} }), /40-character/);
});

test('dry run with --sha stages the commit, runs both bundle checks there and prints the manifest', () => {
  const r = spawnSync('bash', [SCRIPT, '--dry-run', '--sha', HEAD], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('wo093-h-'), ...FAKE } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /> python3 scripts\/build-router-core\.py --check \(in the staged commit\)\n\s+Router bundle verified/);
  assert.match(out, /> python3 scripts\/build-router-core\.py --career-only --check \(in the staged commit\)\n\s+Router bundle verified/);
  assert.match(out, new RegExp(`PROVENANCE MANIFEST ${HEAD} \\(sha256 [0-9a-f]{64}\\)`));
  for (const f of EXPECTED.functions) assert.ok(out.includes(`${f.name}\t${f.bundle_sha256}`), `${f.name} bundle printed`);
  assert.match(out, /insert into public\.career_deploy_ledger one migration row per mark/);
  for (const v of SECRET_VALUES) assert.ok(!out.includes(v));
});

test('a migration mark missing on the live schema fails the run loudly, named, before any deploy (a ledger row is not the schema)', () => {
  const target = '20261022100000_career_apply_wanted.sql';
  const mark = MARKS[MIGRATIONS.indexOf(target)];
  // The migration ledger says every file was applied; the live schema lacks one: the packet whose migrations never landed.
  const r = realRun(['--sha', HEAD], { env: { STUB_LEDGER: 'ok', STUB_IN_LEDGER: '1', STUB_MISSING_MARK: "public.career_apply_wanted" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`MISSING on the live schema: ${target}: ${mark.replace(/[()'.]/g, '\\$&')}`));
  assert.match(r.out, /STEP 2\/6 migrations: FAILED: 1 of \d+ migration marks are missing on the live project/);
  assert.match(r.out, new RegExp(`${target}: applied before \\(ledger\\), skipped`), 'the ledger alone would have skipped it silently');
  assert.doesNotMatch(r.calls, /secrets set|functions deploy|insert into public\.career_deploy_ledger/);
  // --skip-migrations still reads every mark before deploying.
  const skip = realRun(['--sha', HEAD, '--skip-migrations'], { env: { STUB_MISSING_MARK: "public.career_apply_wanted" } });
  assert.equal(skip.code, 1);
  assert.match(skip.out, /STEP 4\/6 deploy: FAILED: 1 of \d+ migration marks are missing/);
  assert.doesNotMatch(skip.calls, /functions deploy/);
});

test('a full run ships from the staged commit and writes one ledger row per mark and per function deployed, with the manifest hash', () => {
  const r = realRun(['--sha', HEAD, '--label', 'owner shell', '--no-wait']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /marks: all \d+ read true on the live project/);
  const lines = r.calls.split('\n');
  const migRow = lines.find((l) => l.includes('insert into public.career_deploy_ledger(sha,kind,migration_file'));
  assert.ok(migRow, 'the migration rows');
  for (const m of EXPECTED.migrations) assert.ok(migRow.includes(`('${HEAD}','migration','${m.file}','${m.sha256}',`), m.file);
  for (const [i, f] of EXPECTED.functions.entries()) {
    const dep = lines.findIndex((l) => l.startsWith(`supabase functions deploy ${f.name} `));
    const row = lines.findIndex((l) => l.includes(`values ('${HEAD}','function','${f.name}','${f.bundle_sha256}',${300 + i},`) && l.includes("'owner shell')"));
    assert.ok(dep >= 0 && row > dep, `${f.name}: deployed, then its ledger row (with the platform version)`);
  }
  assert.equal(lines.filter((l) => l.includes("'function'")).length, FNS.length, 'one row per function deployed');
  assert.match(r.out, new RegExp(`provenance: shipped ${HEAD} \\(manifest sha256 [0-9a-f]{64}\\); check it any time: bash scripts/launch/trainee-go-live.sh --verify ${HEAD}`));
  const kept = fs.readdirSync(path.join(r.home, 'trainee-provenance'));
  assert.equal(kept.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(r.home, 'trainee-provenance', kept[0]), 'utf8'));
  assert.deepEqual(prov.stablePart(saved), prov.stablePart(EXPECTED), 'the kept manifest is the commit\'s');
  assert.ok(saved.tools && saved.created_at, 'with the time and the tool versions');
});

test('--verify: the ledger and every live mark match the manifest, or each mismatch is listed and it exits 1', () => {
  const lf = EXPECTED.functions.map((f, i) => `${f.name}|${HEAD}|${f.bundle_sha256}|2026-10-20T22:00:00Z|${300 + i}`).join('\n');
  const lm = EXPECTED.migrations.map((m) => `${m.file}|${HEAD}|${m.sha256}|2026-10-20T22:00:00Z`).join('\n');
  const good = realRun(['--verify', HEAD], { ledgerFunctions: lf, ledgerMigrations: lm });
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, new RegExp(`VERIFIED: the live project matches ${HEAD}`));
  assert.doesNotMatch(good.calls, /functions deploy|secrets set|insert into|-f /, 'verify only reads');
  const bad = realRun(['--verify', HEAD], { ledgerFunctions: lf.replace(`trainee-deliver|${HEAD}`, `trainee-deliver|${OTHER}`), ledgerMigrations: lm, env: { STUB_MISSING_MARK: 'public.career_board_state' } });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, new RegExp(`MISMATCH function trainee-deliver: live is ${OTHER}`));
  assert.match(bad.out, /MISMATCH migration 20261021110000_career_board_state\.sql: its mark is false on the live schema/);
  assert.match(bad.out, /VERIFY FAILED: 2 mismatch\(es\)/);
  assert.match(bad.out, /STEP verify [0-9a-f]{40}: FAILED: the live project does not match/);
  assert.equal(realRun(['--verify', HEAD.slice(0, 7)]).code, 64, 'the full sha only');
});

test('compare: every kind of mismatch is named', () => {
  const m = { sha: HEAD, functions: [{ name: 'a', bundle_sha256: 'a'.repeat(64) }, { name: 'b', bundle_sha256: 'b'.repeat(64) }, { name: 'c', bundle_sha256: 'c'.repeat(64) }],
    migrations: [{ file: '1_x.sql', sha256: '1'.repeat(64), mark: 'm1' }, { file: '2_y.sql', sha256: '2'.repeat(64), mark: 'm2' }] };
  const lf = `a|${HEAD}|${'a'.repeat(64)}|t|5\nb|${HEAD}|${'f'.repeat(64)}|t|\n`;
  const lm = `1_x.sql|${HEAD}|${'1'.repeat(64)}|t\n2_y.sql|${OTHER}|${'9'.repeat(64)}|t\n`;
  const r = prov.compare({ manifest: m, ledgerFunctions: lf, ledgerMigrations: lm, marks: '1_x.sql|t\n2_y.sql|f\n', platform: new Map([['a', 6]]) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, [
    'function a: the platform runs version 6, the ledger recorded 5 (a deploy no ledger row explains)',
    `function b: ledger bundle ${'f'.repeat(64)} != manifest bundle ${'b'.repeat(64)}`,
    "function b: not in the platform's function list",
    'function c: no deploy ledger row (deployed outside go-live, or never)',
    'migration 2_y.sql: its mark is false on the live schema (m2)',
    `migration 2_y.sql: ledger sha256 ${'9'.repeat(64)} (from ${OTHER.slice(0, 12)}) != this commit's ${'2'.repeat(64)}`,
  ]);
  const ok = prov.compare({ manifest: { ...m, functions: m.functions.slice(0, 1), migrations: m.migrations.slice(0, 1) }, ledgerFunctions: lf, ledgerMigrations: lm, marks: '1_x.sql|t', platform: null });
  assert.equal(ok.ok, true, ok.lines.join('\n'));
  assert.match(ok.lines.join('\n'), /WARN {5}the platform's function versions were not read/);
});

test('platform versions are read from `supabase functions list` by their header names', () => {
  const v = prov.parsePlatformVersions('   ID | NAME | SLUG | STATUS | VERSION | UPDATED_AT (UTC)\n  ---|---|---|---|---|---\n   1 | agent-chat | agent-chat | ACTIVE | 247 | 2026-10-20\n');
  assert.equal(v.get('agent-chat'), 247);
  assert.equal(prov.parsePlatformVersions('nothing here'), null);
});

test('the deploy ledger migration: service role only, RLS on, no client access, append-only, idempotent', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261022120500_career_deploy_ledger.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.career_deploy_ledger/);
  assert.match(sql, /enable row level security/);
  assert.doesNotMatch(sql, /create policy/, 'no policy: no client reads a row');
  assert.match(sql, /revoke all on public\.career_deploy_ledger from public, anon, authenticated, service_role;/);
  assert.match(sql, /grant select, insert on public\.career_deploy_ledger to service_role;/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /grant [^;]*to (anon|authenticated)/);
  for (const c of ['sha', 'function_name', 'bundle_sha256', 'deployed_at', 'deployed_by_label']) assert.match(sql, new RegExp(`\\n  ${c} `), c);
  assert.match(fs.readFileSync(path.join(root, 'tests/db/run.sh'), 'utf8'), /20261022120500_career_deploy_ledger\.sql"\n"\$\{QUIET\[@\]\}" -f "\$ROOT\/supabase\/migrations\/20261022120500_career_deploy_ledger\.sql"/, 'applied twice in tests/db/run.sh');
  assert.ok(fs.existsSync(path.join(root, 'tests/db/career_deploy_ledger.test.sql')));
});

// Parallel lanes keep picking the same migration version (20261022120000 was taken by three branches at once). Supabase
// keys a migration by the digits before its first "_", so two files with one version mean one is refused or skipped on
// deploy. Every file from 20261020000000 on must have its own version; the frozen 2026-09 / early-10 YYYYMMDD_00000N
// groups are applied history and exempt.
function sharedVersions(files) {
  const byVersion = new Map();
  for (const f of files) {
    const v = /^([0-9]+)_/.exec(f)?.[1];
    if (!v || v < '20261020000000') continue;
    byVersion.set(v, [...(byVersion.get(v) || []), f]);
  }
  return [...byVersion].filter(([, fs]) => fs.length > 1).map(([v, fs]) => `${v}: ${fs.join(', ')}`);
}

test('no two migrations from 20261020000000 on share a version (the digits before the first "_")', () => {
  assert.deepEqual(sharedVersions(['20261022120000_career_control_state.sql', '20261022120000_career_deploy_ledger.sql', '20261022120500_x.sql']),
    ['20261022120000: 20261022120000_career_control_state.sql, 20261022120000_career_deploy_ledger.sql'], 'the guard catches a collision');
  assert.deepEqual(sharedVersions(['20260923_000001_a.sql', '20260923_000002_b.sql', '20261008_000001_c.sql', '20261008_000002_d.sql']), [], 'frozen history is exempt');
  const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
  assert.deepEqual(sharedVersions(files), [], 'rename the newer file to a free version (and every reference to it)');
  assert.ok(files.includes('20261022120500_career_deploy_ledger.sql'));
});
