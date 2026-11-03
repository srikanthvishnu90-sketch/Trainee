#!/usr/bin/env node
'use strict';
// Hosted apply setup: which prerequisites of the cloud runner's apply path are missing, by NAME only (never a value).
// Used by `trainee-go-live.sh --verify` (reads the live switches, cron jobs and function list too) and by
// `secrets-audit.sh` (names only). Prerequisites: docs/launch/CLOUD-RUNNER.md "Secrets and numbers",
// docs/architect/mass-apply-proof-runbook.md section A, supabase/functions/_shared/cloud_runner_http.ts (503 "needs setup").
//
//   node scripts/launch/hosted-apply-setup.cjs [--secrets-file f] [--vercel-names-file f] [--settings-file f]
//                                              [--cron-file f] [--functions-file f]
//   --secrets-file / --vercel-names-file  one NAME per line (a NAME=value line is not a name and is ignored)
//   --settings-file                       KEY=value lines for the switches in career_cloud_settings (a missing key is a missing row)
//   --cron-file / --functions-file        one pg_cron job name / edge function slug per line
// A source not given is UNKNOWN: its prerequisites are listed as unchecked, never as present and never as missing.
// Exit 0: off by design, or ready, or switches unreadable (report only). Exit 1: the switches are ON and something is missing
// (the release would read as working while every claim answers 503 or "needs setup"). Exit 2: usage.
const fs = require('node:fs');

// where: fn = Supabase function secret, vercel = Vercel project env, cron = pg_cron job, function = deployed edge function.
const PREREQS = [
  { where: 'fn', name: 'VERCEL_TOKEN', why: 'sandbox host (runner answers 503 needs setup)' },
  { where: 'fn', name: 'VERCEL_TEAM_ID', why: 'sandbox host' },
  { where: 'fn', name: 'VERCEL_PROJECT_ID', why: 'sandbox host' },
  { where: 'fn', name: 'CLOUD_SANDBOX_SNAPSHOT_ID', why: 'runner snapshot (trainee-go-live.sh --build-snapshot)' },
  { where: 'fn', name: 'CLOUD_RUNNER_SECRET', why: 'job/request tokens key (runner answers 503 not configured; 32+ characters)' },
  { where: 'fn', name: 'CLOUD_DISPATCH_SECRET', why: 'the two pg_cron ticks (401 without it)' },
  { where: 'fn', name: 'CLOUD_BRIDGE_URL', why: 'sandboxes call back here (503 needs setup)' },
  { where: 'fn', name: 'CAREER_PREPARE_AHEAD_TOKEN', why: 'the chat kicks preparation with it' },
  { where: 'fn', name: 'CAREER_PREPARE_AHEAD_URL', why: 'agent-chat finds the runner by it' },
  { where: 'fn', name: 'TRAINEE_FILE_LINK_SECRET', why: 'results page links (trainee-file is not deployed without it)' },
  { where: 'fn', name: 'TRAINEE_FILE_BASE_URL', why: 'https URL the results links point to' },
  { where: 'fn', name: 'TRAINEE_BOT_URL', why: 'bot link on the results and connect pages' },
  { where: 'vercel', name: 'TRAINEE_FILE_UPSTREAM', why: '/file proxy to trainee-file (api/file.js answers 503 File pages are not set up yet)' },
  { where: 'vercel', name: 'TRAINEE_CONNECT_UPSTREAM', why: '/connect proxy to trainee-connect (api/connect.js)' },
  { where: 'function', name: 'career-cloud-runner', why: 'the runner edge function' },
  { where: 'function', name: 'trainee-file', why: 'the results page the Apply tap lives on' },
  { where: 'cron', name: 'career-cloud-dispatch', why: 'the send tick (every minute)' },
  { where: 'cron', name: 'career-cloud-prepare-dispatch', why: 'the preparation tick (every minute)' },
];
// The database switches the text-card route needs (migration 20261026230017); a missing row reads as off.
const SWITCHES = ['CAREER_AGENT_SUBMIT', 'CAREER_CLOUD_APPLY', 'CAREER_CLOUD_TEXT_CARDS'];

const nameLines = (text) => (text == null ? null : text.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(l)));
function settingsOf(text) {
  if (text == null) return null;
  const m = {};
  for (const l of text.split('\n')) { const i = l.indexOf('='); if (i > 0) m[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return m;
}

// in: { fn, vercel, cron, functions: string[]|null, settings: object|null }  ->  { verdict, lines, missing, unchecked, fail }
function assess(inp) {
  const src = { fn: inp.fn ?? null, vercel: inp.vercel ?? null, cron: inp.cron ?? null, function: inp.functions ?? null };
  const missing = [], unchecked = [], present = [];
  for (const p of PREREQS) {
    const have = src[p.where];
    if (have == null) unchecked.push(p);
    else if (have.includes(p.name)) present.push(p);
    else missing.push(p);
  }
  const lines = [];
  let off = null;
  if (inp.settings != null) {
    const notOn = SWITCHES.filter((k) => inp.settings[k] !== 'on');
    off = notOn.map((k) => `${k} ${inp.settings[k] === undefined ? 'has no row' : "is '" + inp.settings[k] + "'"}`);
    if (!notOn.length) off = null;
  }
  let verdict, fail = false;
  if (inp.settings != null && off) {
    verdict = 'off-by-design';
    lines.push(`hosted apply: off by design (${off.join('; ')}). Nothing is sent through the cloud; the prerequisites below are information, not failures.`);
  } else if (inp.settings != null) {
    if (missing.length) { verdict = 'not-ready'; fail = true; lines.push(`hosted apply: switches are ON but it is NOT READY: ${missing.length} prerequisite(s) missing. Every claim would fail (503 needs setup / cloud_switches_off).`); }
    else if (unchecked.length) { verdict = 'unverified'; lines.push(`hosted apply: switches are on; nothing found missing, but ${unchecked.length} prerequisite(s) could not be checked from here.`); }
    else { verdict = 'ready'; lines.push('hosted apply: switches on and every prerequisite present (names only). A live cloud-gate waiver and each person\'s opt-in are per-person rows and are not checked here.'); }
  } else {
    verdict = 'switches-unknown';
    lines.push(`hosted apply: the database switches were not read, so on/off is unknown; ${missing.length} prerequisite(s) missing, ${unchecked.length} not checked.`);
  }
  for (const p of missing) lines.push(`  MISSING   ${p.where.padEnd(8)} ${p.name}  (${p.why})`);
  for (const p of unchecked) lines.push(`  UNCHECKED ${p.where.padEnd(8)} ${p.name}  (${p.why})`);
  for (const p of present) lines.push(`  present   ${p.where.padEnd(8)} ${p.name}`);
  return { verdict, lines, missing: missing.map((p) => p.name), unchecked: unchecked.map((p) => p.name), fail };
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); if (i < 0) return null; const p = argv[i + 1]; if (!p) throw new Error(`${f} needs a path`); return fs.readFileSync(p, 'utf8'); };
  for (const a of argv) if (a.startsWith('--') && !['--secrets-file', '--vercel-names-file', '--settings-file', '--cron-file', '--functions-file'].includes(a)) { console.error(`unknown option: ${a}`); return 2; }
  const r = assess({ fn: nameLines(get('--secrets-file')), vercel: nameLines(get('--vercel-names-file')), cron: nameLines(get('--cron-file')),
    functions: nameLines(get('--functions-file')), settings: settingsOf(get('--settings-file')) });
  for (const l of r.lines) console.log(l);
  return r.fail ? 1 : 0;
}

module.exports = { assess, PREREQS, SWITCHES, nameLines, settingsOf };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`hosted-apply-setup: ${e.message}`); process.exitCode = 2; }
}
