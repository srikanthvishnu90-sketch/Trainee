#!/usr/bin/env node
'use strict';
// Trainee post-deploy checks against the LIVE project (run by scripts/launch/trainee-go-live.sh step 6, or by the owner):
//   SUPABASE_URL=https://<ref>.supabase.co CAREER_INGEST_SECRET=... CAREER_PROACTIVE_SECRET=... TRAINEE_DELIVER_SECRET=...
//   TRAINEE_INBOUND_SECRET=... [UPMORE_TEST_JWT=...] [SUPABASE_DB_URL=...] [TRAINEE_SMOKE_CONTACT=+1...]
//   node scripts/launch/trainee-smoke.cjs [--allow-send] [--wait-runs <seconds>]
// One line per check (PASS / FAIL / WARN / NOT RUN) and a summary. Exit 0 with no FAIL, 1 with one, 2 when it cannot run
// at all (no SUPABASE_URL or a function secret): NOT RUN is never a pass.
// What the calls do on the live project (the same as one scheduled run of each, nothing more):
//   - each secret-gated function, once with a wrong secret (must refuse: 401/403) and once with the right one (200; a 503
//     naming a missing setting, such as NOT_WIRED without the LoopMessage key, is a WARN, never a pass). The right-secret
//     call runs that function once: an ingest pass over the next boards, an alerts pass (alerts queue once per key, as
//     every 5 minutes anyway), a delivery pass (sends what is due, as every minute anyway). trainee-inbound gets an
//     empty body, which it ignores: no turn, no text.
//   - --allow-send only: trainee-inbound gets a LoopMessage-shaped HELP from TRAINEE_SMOKE_CONTACT, and the help reply IS
//     texted to that number through LoopMessage. Use your own number. Without the flag that check is skipped.
//   - agent-chat with UPMORE_TEST_JWT: one "hi" turn for that test user (a thread, one of its 60 turns an hour).
//   - with SUPABASE_DB_URL: reads only (psql): the three pg_cron jobs, their last run, and each run record's newest row.
//   - WO-038, each only when its secrets are given (otherwise NOT RUN: that channel is NOT_WIRED, never a failure):
//     trainee-telegram refuses a wrong X-Telegram-Bot-Api-Secret-Token and ignores an empty update with the right one
//     (TELEGRAM_WEBHOOK_SECRET); Telegram's getWebhookInfo says the webhook is this project's trainee-telegram, read only
//     (TELEGRAM_BOT_TOKEN); trainee-whatsapp answers Meta's GET challenge only with the right verify token and refuses an
//     unsigned POST (WHATSAPP_VERIFY_TOKEN). None of them sends a message.
// No secret, JWT, phone number or database URL is ever printed.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

// Names verified against each handler.ts: the env var it reads, the header (or query parameter) it checks, the status
// it refuses with.
const GATED = [
  { fn: 'career-ingest', env: 'CAREER_INGEST_SECRET', header: 'x-trainee-ingest-secret', timeoutMs: 150000 },
  { fn: 'career-proactive', env: 'CAREER_PROACTIVE_SECRET', header: 'x-trainee-proactive-secret', timeoutMs: 150000 },
  { fn: 'trainee-deliver', env: 'TRAINEE_DELIVER_SECRET', header: 'x-trainee-deliver-secret', timeoutMs: 150000 },
  // LoopMessage cannot send a custom header, so the webhook URL carries ?secret= (the handler also takes x-trainee-secret).
  { fn: 'trainee-inbound', env: 'TRAINEE_INBOUND_SECRET', query: 'secret', timeoutMs: 30000 },
];
// The three schedules (scripts/launch/schedule-*.sql) and where each run is recorded. career-ingest has no runs table:
// it writes career_ingest_state.last_run_at every run. Windows are each script's own "down" threshold.
const RUNS = [
  { job: 'trainee-career-ingest', what: 'career_ingest_state.last_run_at', window: 1800,
    sql: "select coalesce(extract(epoch from now() - last_run_at)::int::text, ''), '' from public.career_ingest_state where id = 1" },
  { job: 'trainee-career-proactive', what: 'career_proactive_runs', window: 1800,
    sql: "select extract(epoch from now() - run_at)::int, coalesce(replace(error, E'\\n', ' '), '') from public.career_proactive_runs order by run_at desc limit 1" },
  { job: 'trainee-deliver', what: 'channel_delivery_runs', window: 300,
    sql: "select extract(epoch from now() - run_at)::int, coalesce(replace(error, E'\\n', ' '), '') from public.channel_delivery_runs order by run_at desc limit 1" },
];

// WO-038: optional; each channel is checked only when its secrets are given.
const CHANNEL_SECRETS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET'];
const r = (status, check, detail) => ({ status, check, detail });
const clip = (s, n = 160) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
async function call(fetchFn, url, init, timeoutMs) {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs || 30000) });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } catch (e) { return { status: 0, body: null, text: '', error: e && e.message || String(e) }; }
}
const said = (x) => clip(x.error || (x.body && (x.body.error || x.body.detail || x.body.message)) || x.text || '');
// "not configured: CAREER_INGEST_SECRET must be set": the function holds no secret, so it refuses its own schedule too.
const ownSecretMissing = (g, x) => x.status === 503 && said(x).includes(g.env);

function gateUrl(base, g, secret) {
  const u = `${base}/functions/v1/${g.fn}`;
  return g.query && secret != null ? `${u}?${g.query}=${encodeURIComponent(secret)}` : u;
}
function gateInit(g, secret, body) {
  const headers = { 'content-type': 'application/json' };
  if (g.header && secret != null) headers[g.header] = secret;
  return { method: 'POST', headers, body: JSON.stringify(body || {}) };
}

// A secret-gated function refuses a wrong secret and answers the right one.
async function checkGate(g, { base, secret, fetchFn }) {
  const out = [];
  const wrong = 'wrong-' + crypto.randomBytes(20).toString('hex');
  const w = await call(fetchFn, gateUrl(base, g, wrong), gateInit(g, wrong), 30000);
  if (w.status === 401 || w.status === 403) out.push(r('PASS', `${g.fn} refuses a wrong secret`, `HTTP ${w.status}`));
  else if (ownSecretMissing(g, w)) out.push(r('FAIL', `${g.fn} refuses a wrong secret`, `the function has no ${g.env} (HTTP 503): it refuses everything, its schedule included; set it and re-run`));
  else if (w.status === 404) out.push(r('FAIL', `${g.fn} refuses a wrong secret`, 'HTTP 404: the function is not deployed'));
  else out.push(r('FAIL', `${g.fn} refuses a wrong secret`, `HTTP ${w.status || 'none'}: ${said(w)}`));

  const a = await call(fetchFn, gateUrl(base, g, secret), gateInit(g, secret), g.timeoutMs);
  const name = `${g.fn} answers the right secret`;
  if (a.status === 200) out.push(r('PASS', name, `HTTP 200 ${clip(a.text, 120)}`));
  else if (ownSecretMissing(g, a)) out.push(r('FAIL', name, `the function has no ${g.env} set`));
  else if (a.status === 503 && /NOT_WIRED|not configured/.test(said(a))) out.push(r('WARN', name, `HTTP 503, not wired yet: ${said(a)}`));
  // The handler's own refusal says "Unauthorized"; any other 401 is the platform gateway asking for a JWT.
  else if (a.status === 401 && !(a.body && a.body.error === 'Unauthorized')) out.push(r('FAIL', name, 'HTTP 401 from the gateway: deploy it with --no-verify-jwt (pg_cron and LoopMessage carry no JWT)'));
  else out.push(r('FAIL', name, `HTTP ${a.status || 'none'}: ${said(a)}`));
  return out;
}

// Audit B2: the preparation host (workers/career-browser/prepare-ahead.ts serve) that prepares applications for a person
// with only a phone. Not given: NOT RUN, said as NOT_WIRED (the chat then says nothing is prepared without the extension).
// Given: its GET /status must refuse a wrong token and answer the right one as the prepare-ahead service. Read only.
async function checkPrepareHost({ url, token, fetchFn }) {
  const name = 'preparation host (phone-only preparation)';
  if (!url || !token) return [r('NOT RUN', name, 'NOT_WIRED: no CAREER_PREPARE_AHEAD_URL/TOKEN given; a person with only a phone gets nothing prepared (docs/launch/CLOUD-RUNNER.md, Preparation host)')];
  let where;
  try { const u = new URL(url); if (u.protocol !== 'https:') throw new Error(); where = `${u.origin}/status`; }
  catch { return [r('FAIL', name, 'CAREER_PREPARE_AHEAD_URL is not an https URL')]; }
  const out = [];
  const w = await call(fetchFn, where, { headers: { authorization: `Bearer wrong-${crypto.randomBytes(20).toString('hex')}` } }, 15000);
  out.push(w.status === 401 || w.status === 403 ? r('PASS', `${name} refuses a wrong token`, `HTTP ${w.status}`)
    : r('FAIL', `${name} refuses a wrong token`, `HTTP ${w.status || 'none'}: ${said(w)}`));
  const a = await call(fetchFn, where, { headers: { authorization: `Bearer ${token}` } }, 15000);
  if (a.status === 200 && a.body && a.body.ok === true && a.body.service === 'prepare-ahead') {
    out.push(r('PASS', `${name} is up`, `${Number(a.body.in_flight) || 0} in flight, up to ${Number(a.body.concurrency) || 1} at once${a.body.last_error ? `; last error: ${clip(a.body.last_error, 100)}` : ''}`));
  } else out.push(r('FAIL', `${name} is up`, `HTTP ${a.status || 'none'}: ${said(a) || 'not the prepare-ahead status'}`));
  return out;
}

// The body parseLoopInbound (supabase/functions/_shared/loopmessage.ts) reads as an inbound text: alert_type, message_id,
// recipient (the texting contact), text. A fresh id each run, so the dedupe table never answers "duplicate webhook".
function helpBody(contact, now) {
  return { alert_type: 'message_inbound', message_id: `trainee-smoke-${now}-${crypto.randomBytes(4).toString('hex')}`, recipient: contact, text: 'HELP' };
}
async function checkInboundHelp({ base, secret, contact, fetchFn, now }) {
  const g = GATED.find((x) => x.fn === 'trainee-inbound');
  const name = 'trainee-inbound answers HELP (texted to TRAINEE_SMOKE_CONTACT)';
  const x = await call(fetchFn, gateUrl(base, g, secret), gateInit(g, secret, helpBody(contact, now)), g.timeoutMs);
  if (x.status === 200 && x.body && x.body.ok === true && x.body.command === 'help') {
    return x.body.sent === true ? r('PASS', name, 'ok, command help, sent through LoopMessage')
      : r('FAIL', name, 'ok, command help, but LoopMessage did not take the send (check the key and the request shape)');
  }
  if (x.status === 503 && /NOT_WIRED/.test(said(x))) return r('WARN', name, `HTTP 503, not wired yet: ${said(x)}`);
  if (x.status === 200 && x.body && x.body.ignored) return r('FAIL', name, `ignored: ${clip(x.body.ignored)} (the body shape no longer matches parseLoopInbound)`);
  return r('FAIL', name, `HTTP ${x.status || 'none'}: ${said(x)}`);
}

// WO-038: the Telegram and WhatsApp webhooks' doors, and Telegram's own record of where it posts.
async function checkTelegram({ base, secret, fetchFn }) {
  const out = [], u = `${base}/functions/v1/trainee-telegram`;
  const post = (s) => call(fetchFn, u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': s }, body: '{}' }, 30000);
  const w = await post('wrong' + crypto.randomBytes(20).toString('hex'));
  out.push(w.status === 403 ? r('PASS', 'trainee-telegram refuses a wrong secret token', 'HTTP 403')
    : r('FAIL', 'trainee-telegram refuses a wrong secret token', w.status === 404 ? 'HTTP 404: the function is not deployed' : `HTTP ${w.status || 'none'}: ${said(w)}`));
  const a = await post(secret);
  const name = 'trainee-telegram answers the right secret token';
  if (a.status === 200 && a.body && a.body.ok === true) out.push(r('PASS', name, 'HTTP 200 (an empty update is ignored: no turn, no text)'));
  else if (a.status === 503 && /NOT_WIRED|not configured/.test(said(a))) out.push(r('WARN', name, `HTTP 503, not wired yet: ${said(a)}`));
  else if (a.status === 401) out.push(r('FAIL', name, 'HTTP 401 from the gateway: deploy it with --no-verify-jwt (Telegram carries no JWT)'));
  else out.push(r('FAIL', name, `HTTP ${a.status || 'none'}: ${said(a)}`));
  return out;
}
async function checkTelegramWebhook({ base, token, fetchFn }) {
  const name = "Telegram's webhook is this project's trainee-telegram";
  const x = await call(fetchFn, `https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'GET' }, 30000);
  const info = x.body && x.body.result;
  if (x.status !== 200 || !info) return r('FAIL', name, `getWebhookInfo HTTP ${x.status || 'none'}: ${said(x)} (check TELEGRAM_BOT_TOKEN)`);
  if (info.url !== `${base}/functions/v1/trainee-telegram`) return r('FAIL', name, `it posts to ${info.url ? 'another URL' : 'nowhere'}: run setWebhook (docs/launch/TRAINEE-GO-LIVE.md, Telegram)`);
  if (info.last_error_message) return r('WARN', name, `set, but its last delivery failed: ${clip(info.last_error_message, 120)}`);
  return r('PASS', name, `set; ${Number(info.pending_update_count) || 0} updates pending`);
}
async function checkWhatsApp({ base, verifyToken, fetchFn }) {
  const out = [], u = `${base}/functions/v1/trainee-whatsapp`;
  const challenge = String(crypto.randomInt(1e9, 2e9));
  const get = (t) => call(fetchFn, `${u}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(t)}&hub.challenge=${challenge}`, { method: 'GET' }, 30000);
  const w = await get('wrong' + crypto.randomBytes(20).toString('hex'));
  out.push(w.status === 403 ? r('PASS', 'trainee-whatsapp refuses a wrong verify token', 'HTTP 403')
    : r('FAIL', 'trainee-whatsapp refuses a wrong verify token', w.status === 404 ? 'HTTP 404: the function is not deployed' : `HTTP ${w.status || 'none'}: ${said(w)}`));
  const a = await get(verifyToken);
  const name = "trainee-whatsapp answers Meta's challenge with the right verify token";
  if (a.status === 200 && a.text === challenge) out.push(r('PASS', name, 'HTTP 200, the challenge echoed'));
  else if (a.status === 401) out.push(r('FAIL', name, 'HTTP 401 from the gateway: deploy it with --no-verify-jwt (Meta carries no JWT)'));
  else out.push(r('FAIL', name, `HTTP ${a.status || 'none'}: ${said(a)}`));
  const p = await call(fetchFn, u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 30000);
  const pn = 'trainee-whatsapp refuses an unsigned POST';
  if (p.status === 403) out.push(r('PASS', pn, 'HTTP 403'));
  else if (p.status === 503 && /not configured|NOT_WIRED/.test(said(p))) out.push(r('WARN', pn, `HTTP 503, not wired yet: ${said(p)}`));
  else out.push(r('FAIL', pn, `HTTP ${p.status || 'none'}: ${said(p)}`));
  return out;
}

async function checkChatNoJwt({ base, fetchFn }) {
  const x = await call(fetchFn, `${base}/functions/v1/agent-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hi"}' }, 30000);
  return x.status === 401 ? r('PASS', 'agent-chat refuses a call with no JWT', 'HTTP 401') : r('FAIL', 'agent-chat refuses a call with no JWT', `HTTP ${x.status || 'none'}: ${said(x)}`);
}
async function checkChatHi({ base, jwt, fetchFn }) {
  const name = 'agent-chat answers "hi" for the test user';
  const x = await call(fetchFn, `${base}/functions/v1/agent-chat`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ message: 'hi' }) }, 120000);
  const reply = x.body && typeof x.body.reply === 'string' ? x.body.reply.trim() : '';
  if (x.status === 200 && reply) return r('PASS', name, `${reply.length} characters: "${clip(reply, 70)}"`);
  if (x.status === 200) return r('FAIL', name, 'HTTP 200 with an empty reply');
  return r('FAIL', name, `HTTP ${x.status || 'none'}: ${said(x)}`);
}

// Reads only. sql(query) returns psql -tA output ("a|b" rows).
async function checkRuns({ sql }) {
  const out = [];
  const jobs = RUNS.map((x) => `'${x.job}'`).join(',');
  const rows = String(await sql(`select j.jobname, coalesce(d.status, ''), coalesce(extract(epoch from now() - d.start_time)::int::text, '') from cron.job j left join lateral (select status, start_time from cron.job_run_details x where x.jobid = j.jobid order by start_time desc limit 1) d on true where j.jobname in (${jobs})`))
    .split('\n').filter(Boolean).map((l) => l.split('|'));
  for (const run of RUNS) {
    const row = rows.find((x) => x[0] === run.job);
    if (!row) out.push(r('FAIL', `schedule ${run.job}`, 'no pg_cron job: run its schedule script (step 5)'));
    else if (!row[1]) out.push(r('FAIL', `schedule ${run.job}`, 'scheduled but has not fired yet'));
    else if (row[1] !== 'succeeded') out.push(r('FAIL', `schedule ${run.job}`, `last fire ${row[2]} s ago: ${row[1]}`));
    else if (Number(row[2]) > run.window) out.push(r('FAIL', `schedule ${run.job}`, `last fired ${row[2]} s ago (more than ${run.window} s)`));
    else out.push(r('PASS', `schedule ${run.job}`, `fired ${row[2]} s ago, succeeded`));
    const [age, error] = String(await sql(run.sql)).split('\n')[0].split('|');
    const name = `${run.what} has a recent row`;
    if (!age) out.push(r('FAIL', name, 'no run recorded yet (the function has not completed a run)'));
    else if (error) out.push(r('FAIL', name, `newest run ${age} s ago failed: ${clip(error, 120)}`));
    else if (Number(age) > run.window) out.push(r('FAIL', name, `newest run ${age} s ago (more than ${run.window} s: down)`));
    else out.push(r('PASS', name, `newest run ${age} s ago, no error`));
  }
  return out;
}
const psqlRunner = (dbUrl) => async (q) => execFileSync('psql', [dbUrl, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The hosted file page (phone login, Apply buttons). TRAINEE_FILE_BASE_URL is the page's public https URL (the Vercel /file route).
// A made-up link must come back as a 4xx HTML "link" page: 404 means the route is missing, 503 means the proxy or the function
// is not set up (Vercel TRAINEE_FILE_UPSTREAM, or TRAINEE_FILE_LINK_SECRET missing), 2xx would mean it opened without a link.
async function checkFilePage({ url, fetchFn }) {
  const name = 'file page (TRAINEE_FILE_BASE_URL) refuses a made-up link';
  let u;
  try { u = new URL(url); if (u.protocol !== 'https:') throw new Error(); } catch { return r('FAIL', name, 'TRAINEE_FILE_BASE_URL is not an https URL'); }
  u.search = ''; u.searchParams.set('t', 'smoke-' + crypto.randomBytes(12).toString('hex'));
  const x = await call(fetchFn, u.toString(), { method: 'GET', redirect: 'manual' }, 20000);
  if (x.status >= 400 && x.status < 500 && x.status !== 404 && x.status !== 429) return r('PASS', name, `HTTP ${x.status}`);
  if (x.status === 404) return r('FAIL', name, 'HTTP 404: the /file route or the function is not deployed');
  if (x.status === 503) return r('FAIL', name, `HTTP 503: not set up (${said(x)}); set Vercel TRAINEE_FILE_UPSTREAM and the function secret TRAINEE_FILE_LINK_SECRET`);
  return r('FAIL', name, `HTTP ${x.status || 'none'}: ${said(x) || 'expected a refusal'}`);
}

// Per feature, certified or not, from what THIS run actually saw. NOT RUN, WARN and FAIL never certify anything.
// "Real Apply" is never certified by a smoke: it needs a real application that the employer confirmed.
function certify(results) {
  const by = (re) => results.filter((x) => re.test(x.check));
  const state = (re) => { const l = by(re); return l.length === 0 ? 'NOT RUN' : l.some((x) => x.status === 'FAIL') ? 'FAIL' : l.every((x) => x.status === 'PASS') ? 'PASS' : l.some((x) => x.status === 'WARN') ? 'WARN' : 'NOT RUN'; };
  const why = (re, fallback) => { const l = by(re).filter((x) => x.status !== 'PASS'); return l.length ? l.map((x) => `${x.check} ${x.status}${x.detail ? ` (${clip(x.detail, 90)})` : ''}`).join('; ') : fallback; };
  const file = state(/^file page/), send = state(/^trainee-inbound answers HELP/), gate = state(/^trainee-inbound (refuses|answers the right)/);
  const runs = state(/^schedule |has a recent row/), prep = state(/^preparation host/);
  const cert = (feature, certified, reason) => ({ feature, certified, reason });
  const out = [];
  out.push(cert('file endpoint', file === 'PASS', file === 'PASS' ? 'a made-up link was refused by the live page' : why(/^file page/, 'NOT RUN: TRAINEE_FILE_BASE_URL not given to the smoke')));
  out.push(cert('inbound', gate === 'PASS' && send === 'PASS', gate === 'PASS' && send === 'PASS' ? 'webhook gate and a real LoopMessage send (HELP) both answered' : why(/^trainee-inbound/, 'NOT RUN: no trainee-inbound check ran') + (send !== 'PASS' ? '; needs LOOPMESSAGE_API_KEY on the project and --allow-send with TRAINEE_SMOKE_CONTACT' : '')));
  out.push(cert('phone login', file === 'PASS' && send === 'PASS', file === 'PASS' && send === 'PASS' ? 'page reachable and LoopMessage sends (the code arriving on a real phone is not probed)' : `needs the file endpoint and the LoopMessage send: file ${file}, send ${send}`));
  const applyReady = file === 'PASS' && runs === 'PASS' && prep === 'PASS';
  out.push(cert('real Apply', false, `never certified by a smoke: it needs one real application confirmed by the employer. Prerequisites seen: file page ${file}, schedules ${runs}, preparation host ${prep}${applyReady ? '' : ' (not all PASS)'}`));
  return out;
}

// One founder_alerts row per smoke run so ops-monitor can tell the owner a deploy smoke failed. Counts and booleans only, plus a
// validated commit sha: no secret, URL or phone number can reach the row.
function recordSql(counts, certs, sha) {
  const safeSha = /^[0-9a-f]{7,40}$/.test(sha || '') ? sha : '';
  const detail = { sha: safeSha, ...counts, certified: Object.fromEntries(certs.map((c) => [c.feature.replace(/ /g, '_'), c.certified])) };
  return `insert into public.founder_alerts (kind, user_id, detail) values ('deploy_smoke', null, '${JSON.stringify(detail)}'::jsonb)`;
}

function parseArgs(argv) {
  const o = { allowSend: false, waitRuns: 0, kept: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-send') o.allowSend = true;
    // --kept A,B: function secrets the project keeps that this run was not given (trainee-go-live.sh --non-interactive).
    else if (argv[i] === '--kept') { o.kept = String(argv[++i] || '').split(',').filter(Boolean); if (!o.kept.length || o.kept.some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k))) throw new Error('--kept takes secret names, comma-separated'); }
    else if (argv[i] === '--wait-runs') { o.waitRuns = Number(argv[++i]); if (!Number.isFinite(o.waitRuns) || o.waitRuns < 0) throw new Error('--wait-runs takes seconds'); }
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return o;
}

// deps: fetch, sql (a runner for the database URL), sleep, log, now. All injectable for tests/trainee-go-live.test.cjs.
async function main(argv, env, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const fetchFn = deps.fetch || fetch, sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const now = deps.now || Date.now;
  // Never print a value that was handed in; an error message from a provider or psql could carry one back.
  const hidden = ['SUPABASE_DB_URL', 'UPMORE_TEST_JWT', 'TRAINEE_SMOKE_CONTACT', 'CAREER_PREPARE_AHEAD_URL', 'CAREER_PREPARE_AHEAD_TOKEN', 'TRAINEE_FILE_BASE_URL', ...GATED.map((g) => g.env), ...CHANNEL_SECRETS].map((k) => env[k]).filter((v) => v && v.length >= 4);
  const scrub = (s) => hidden.reduce((t, v) => t.split(v).join('***').split(encodeURIComponent(v)).join('***'), String(s));
  const line = (x) => log(scrub(`${x.status.padEnd(7)} ${x.check}${x.detail ? `: ${x.detail}` : ''}`));
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`NOT RUN trainee smoke: ${e.message}`); return 2; }
  const missing = ['SUPABASE_URL', ...GATED.map((g) => g.env)].filter((k) => !env[k] && !opts.kept.includes(k));
  if (missing.length) {
    log(`NOT RUN trainee smoke: missing ${missing.join(', ')} (set them in the environment; trainee-go-live.sh passes them). Nothing was called.`);
    return 2;
  }
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(base)) { log('NOT RUN trainee smoke: SUPABASE_URL must be https://<ref>.supabase.co'); return 2; }

  const results = [];
  const add = (x) => { for (const y of [].concat(x)) { results.push(y); line(y); } };
  add(await checkChatNoJwt({ base, fetchFn }));
  for (const g of GATED) {
    if (!env[g.env] && opts.kept.includes(g.env)) add(r('NOT RUN', `${g.fn} gate`, `${g.env} is kept on the project and was not given to this run`));
    else add(await checkGate(g, { base, secret: env[g.env], fetchFn }));
  }
  if (!opts.allowSend) add(r('NOT RUN', 'trainee-inbound answers HELP', 'skipped: it texts the help reply through LoopMessage; pass --allow-send with TRAINEE_SMOKE_CONTACT (your own number)'));
  else if (!env.TRAINEE_SMOKE_CONTACT) add(r('NOT RUN', 'trainee-inbound answers HELP', 'missing TRAINEE_SMOKE_CONTACT'));
  else add(await checkInboundHelp({ base, secret: env.TRAINEE_INBOUND_SECRET, contact: env.TRAINEE_SMOKE_CONTACT, fetchFn, now: now() }));
  // A channel not given is reported, not counted: it is NOT_WIRED by choice, and the core launch does not wait on it.
  const optional = (x) => line(x);
  if (env.TELEGRAM_WEBHOOK_SECRET) add(await checkTelegram({ base, secret: env.TELEGRAM_WEBHOOK_SECRET, fetchFn }));
  else optional(r('NOT RUN', 'trainee-telegram', 'Telegram NOT_WIRED: no TELEGRAM_WEBHOOK_SECRET given'));
  if (env.TELEGRAM_BOT_TOKEN) add(await checkTelegramWebhook({ base, token: env.TELEGRAM_BOT_TOKEN, fetchFn }));
  else optional(r('NOT RUN', "Telegram's webhook", 'Telegram NOT_WIRED: no TELEGRAM_BOT_TOKEN given'));
  if (env.WHATSAPP_VERIFY_TOKEN) add(await checkWhatsApp({ base, verifyToken: env.WHATSAPP_VERIFY_TOKEN, fetchFn }));
  else optional(r('NOT RUN', 'trainee-whatsapp', 'WhatsApp NOT_WIRED: no WHATSAPP_VERIFY_TOKEN given'));
  // Not wired is reported, not counted (as a channel not given); wired and failing is a FAIL.
  const prep = await checkPrepareHost({ url: env.CAREER_PREPARE_AHEAD_URL, token: env.CAREER_PREPARE_AHEAD_TOKEN, fetchFn });
  if (prep.length === 1 && prep[0].status === 'NOT RUN') optional(prep[0]); else add(prep);
  if (env.TRAINEE_FILE_BASE_URL) add(await checkFilePage({ url: env.TRAINEE_FILE_BASE_URL, fetchFn }));
  else optional(r('NOT RUN', 'file page (TRAINEE_FILE_BASE_URL)', 'NOT_WIRED: TRAINEE_FILE_BASE_URL not given; the file endpoint and phone login are NOT CERTIFIED (needs the function secrets TRAINEE_FILE_LINK_SECRET, TRAINEE_FILE_BASE_URL, TRAINEE_BOT_URL and Vercel TRAINEE_FILE_UPSTREAM)'));
  if (env.UPMORE_TEST_JWT) add(await checkChatHi({ base, jwt: env.UPMORE_TEST_JWT, fetchFn }));
  else add(r('NOT RUN', 'agent-chat answers "hi" for the test user', 'missing UPMORE_TEST_JWT'));

  if (!env.SUPABASE_DB_URL && !deps.sql) add(r('NOT RUN', 'schedules and run records', 'missing SUPABASE_DB_URL'));
  else {
    const sql = deps.sql || psqlRunner(env.SUPABASE_DB_URL);
    const deadline = now() + opts.waitRuns * 1000;
    let runs;
    for (let first = true; ; first = false) {
      try { runs = await checkRuns({ sql }); } catch (e) { runs = [r('FAIL', 'schedules and run records', `the database read failed: ${clip(e && (e.stderr || e.message), 200)}`)]; break; }
      if (runs.every((x) => x.status === 'PASS') || now() >= deadline) break;
      if (first) log(`waiting up to ${opts.waitRuns} s for each schedule to fire and record a run…`);
      await sleep(30000);
    }
    add(runs);
  }
  const n = (s) => results.filter((x) => x.status === s).length;
  const counts = { pass: n('PASS'), warn: n('WARN'), fail: n('FAIL'), not_run: n('NOT RUN') };
  log(`summary: ${counts.pass} PASS, ${counts.warn} WARN, ${counts.fail} FAIL, ${counts.not_run} NOT RUN`);
  const certs = certify(results);
  for (const c of certs) log(scrub(`${c.certified ? 'CERT    CERTIFIED' : 'CERT    NOT CERTIFIED'} ${c.feature}: ${c.reason}`));
  if (env.SUPABASE_DB_URL || deps.sql) {
    try { await (deps.sql || psqlRunner(env.SUPABASE_DB_URL))(recordSql(counts, certs, env.GITHUB_SHA || env.TRAINEE_SMOKE_SHA)); }
    catch { log('NOTE    the smoke result was not recorded (founder_alerts unreadable); ops-monitor cannot alert on this run'); }
  }
  return n('FAIL') ? 1 : 0;
}

module.exports = { certify, recordSql, checkFilePage, GATED, RUNS, CHANNEL_SECRETS, checkPrepareHost, checkGate, checkInboundHelp, checkTelegram, checkTelegramWebhook, checkWhatsApp, checkChatNoJwt, checkChatHi, checkRuns, helpBody, main };
if (require.main === module) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { console.log(`FAIL    trainee smoke crashed: ${e && e.message}`); process.exitCode = 1; });
