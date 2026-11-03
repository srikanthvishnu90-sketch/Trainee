#!/usr/bin/env python3
# Mutation check for FEATURE 17's TypeScript guards (strict standard: each guard has a mutant its tests turn red).
#   python3 tests/mutants/hosted_apply_ts.py [name-prefix ...]       (env DENO_ARGS adds deno flags, e.g. an import map)
# Each mutant replaces text that occurs exactly once in its file, runs tests/architect/hosted-apply-unit.test.ts, and puts
# the file back. Exit 0 only when the control is green and every mutant turns the tests red.
import os, shlex, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
S = 'supabase/functions/_shared/'
P, H, A, C, K = S + 'cloud_prepare.ts', S + 'cloud_runner_http.ts', S + 'career_hosted_prepare.ts', S + 'career_apply_receipts.ts', S + 'cloud_runner.ts'
D, W, R, L, CARDS = S + 'career_prepared_card.ts', 'workers/career-cloud/prepare-runner.ts', 'workers/career-cloud/prepare-runner.ts', S + 'career_apply_link.ts', S + 'career_apply_cards.ts'
TESTS = ['tests/architect/hosted-apply-unit.test.ts']
M = [
 # the preparation bridge and door
 (P, '!sameText(token, await prepareToken(d.secret, id, row.lease_token, sandbox))', 'false', 'bridge token'),
 (P, 'if (!row || row.state !== "running" ||', 'if (!row ||', 'bridge request running'),
 (P, 'Date.parse(row.claimed_at) <= now - 15 * 60_000 ||', 'false ||', 'bridge lease expiry'),
 (P, 'return { status: 200, body: await d.rpc(name, { p_user: user }) };', 'return { status: 200, body: await d.rpc(name, { p_user: args.p_user ?? user }) };', 'bridge person forced'),
 (P, 'if (!postings.has(String(args.p_posting_job_id ?? ""))) return refuse(403, "not one of this request\'s postings");', '', 'bridge posting scope'),
 (P, 'if (args.p_user !== undefined && args.p_user !== user) return refuse(403, "not this request\'s person");', '', 'bridge forged person'),
 (P, '.filter((c: any) => c?.user_id === user && postings.has(String(c?.job_id)))', '', 'candidates filter'),
 (P, 'return refuse(403, "not a preparation call");', 'return { status: 200, body: await d.rpc(name, args) };', 'rpc allowlist'),
 (P, 'if (!r?.accepted) return { status: 429,', 'if (false) return { status: 429,', 'door per-person'),
 (P, 'trainee-cloud-prepare.v1.', 'trainee-cloud-runner.v1.', 'token prefix'),
 (P, '&& !outcomes.some((o: { outcome: string }) => o.outcome === "asked" || o.outcome === "ready")', '', 'notice not for asked'),
 (P, 'if (d.stop) await d.stop(sandbox).catch(() => {});\n        return { status: 200, body: { state: r?.state ?? null, card, push, questions } };', 'return { status: 200, body: { state: r?.state ?? null, card, push, questions } };', 'sandbox stopped'),
 # F5: the application is the request's posting's, and its card is the application
 (P, 'payload.url !== posting.url', 'false', 'F5 prepared application tied to the posting link'),
 (P, 'if (problem) return refuse(422, `card refused: ${problem}`);', '', 'F5 card checked before storing'),
 (P, '(args.p_prepared != null || args.p_outcome === "ready")', 'false', 'F5 a try cannot link a prepared application'),
 (D, 'if (next() !== String(payload.company ?? "")) return "the card does not name the employer the application goes to";', 'next();', 'F5 card names the employer'),
 (D, 'if (typeof line !== "string" || !line.startsWith(prefix)) return `the card leaves out or reorders "${label}"`;', '', 'F5 every answer, in order'),
 (D, 'if (typeof own === "string" && own && norm(shown) === norm(own)) continue;\n    return `the card shows "${label}" as something the application does not send`;', 'continue;', 'F5 shown value is sent value or own answer'),
 (D, 'if (shown === "Yes (checked)" && (value === true || BOOL_ON.has(v))) continue;', 'if (shown === "Yes (checked)") continue;', 'F5 a checked box is a box sent checked'),
 (D, 'if (next() !== resumeCardLine(kept?.filename ?? "", sha, tag)) return "the card names another resume than the one sent";', 'next();', 'F5 the resume named is the one sent'),
 (D, 'if (!tag && !kept) return "no kept resume to name";', '', 'F5 no kept resume, no card'),
 (D, 'if (pageFields.length && next() !== `Also sent, set by the employer\'s page, unchanged: ${pageFields.join(", ")}`) return "the card leaves out what the page sets";', '', 'F5 page fields said'),
 (D, 'if (next() !== `Sends to ${String(payload.destination ?? "")}`) return "the card does not say where it is sent";', 'next();', 'F5 destination said'),
 (D, 'if (note && next() !== `Cover note: ${note}`) return "the card\'s cover note is not the one sent";', '', 'F5 cover note is the one sent'),
 (D, 'if (i !== L.length) return "the card says more than the application carries";', '', 'F5 nothing more than the application'),
 (D, 'lines.some((l) => typeof l !== "string" || l.length > 600)', 'lines.some((l) => typeof l !== "string")', 'F5 a card line is at most 600 characters'),
 (D, '/^The page runs a verification check \\(([a-z0-9 ,._-]{1,120})\\); its token carries none of your answers$/i', '/^The page runs a verification check \\((.*)\\); its token carries none of your answers$/i', 'F5 verification line has no words of its own'),
 # the runner's doors and numbers
 (H, 'if (!token || !same(req.headers.get("authorization") || "", `Bearer ${token}`)) return json(401', 'if (!token) return json(401', 'prepare token'),
 (H, 'if (env("CLOUD_PREPARE_ENABLED") !== "on") return json(503, { error: "preparation is not on" });', '', 'prepare switch'),
 (H, 'if (!env("CLOUD_DISPATCH_SECRET") || !tickSecret()) return json(401, { error: "unauthorized" });\n      if (env("CLOUD_PREPARE_ENABLED")', 'if (!env("CLOUD_DISPATCH_SECRET")) return json(401, { error: "unauthorized" });\n      if (env("CLOUD_PREPARE_ENABLED")', 'prepare tick secret'),
 (H, 'perPersonDay: opt("CLOUD_MAX_PER_PERSON_DAY"), perSiteMinute: opt("CLOUD_MAX_PER_SITE_MINUTE")', 'perSiteMinute: opt("CLOUD_MAX_PER_SITE_MINUTE")', 'send per-person to db'),
 (H, 'if (!a || a.length !== b.length) return false;', 'if (!a) return false;', 'T5 a secret\'s prefix is not the secret'),
 (H, 'if (req.method !== "POST") return json(405, { error: "POST only" });', '', 'T6 POST only'),
 (P, 'filter((x: string) => x && x.length <= 300) : [];', 'filter((x: string) => x && x.length <= 300).slice(0, 100) : [];', 'NO LIMITS: the door cuts no ids'),
 (H, 'return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;', 'return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;', 'NO LIMITS: no per-person/per-site default'),
 (H, 'CLOUD_MAX_CONCURRENT: 2, CLOUD_MAX_PER_PORTAL: 1,', 'CLOUD_MAX_CONCURRENT: 4, CLOUD_MAX_PER_PORTAL: 1,', 'F2 sizing default is the doc\'s'),
 (H, 'CLOUD_MAX_CONCURRENT: 2,', 'CLOUD_MAX_CONCURRENT: 20,', 'F2 send concurrency default is wave 1'),
 # the dispatcher and the sandbox host
 (P, 'await o.rpc("career_apply_prepare_request_notice", { p_id: r.id, p_lease: r.lease_token, p_text: RUNNER_UNAVAILABLE_TEXT }).catch(() => {});', '', 'F4 a sandbox that never starts is told'),
 (K, 'if (!/^workers\\/career-cloud\\/(sandbox|prepare)-runner\\.ts$/.test(script)) throw Error("vercel: not a runner script");', '', 'T1 runner script allowlist'),
 (K, 'return { status: 200, body: await d.rpc("career_apply_cloud_authorize_any", {', 'return { status: 200, body: await d.rpc("career_apply_message_cloud_authorize", {', 'authorize either route'),
 # the preparation sandbox
 (R, 'if (!bytes.length || sum !== r.sha256) return null;', 'if (!bytes.length) return null;', 'T2 kept resume hash'),
 (R, '!/^[^/\\\\.][^/\\\\]{0,199}$/.test(String(r.filename))', 'false', 'T3 kept resume file name'),
 (R, '  for (const k of RUNNER_ENV) env.delete(k);\n', '', 'F6 the token leaves the environment'),
 # what the person is told
 (A, 'if (!asked || asked.status !== "answered" || !ON_COMPUTER.test(asked.reply)) return "skipped";', 'if (!asked || !ON_COMPUTER.test(asked.reply)) return "skipped";', 'answered only'),
 (A, 'if ((open.data ?? []).length) {', 'if (false) {', 'open questions wait'),
 (C, 'if (reason === "bot_check") return `${company} is not finished: ${NEEDS_YOU.bot_check}. Nothing reached ${company}.${tail}`;', '', 'bot-check receipt'),
 (A, 'if (t.length > 160) return null;', '', 'cancel: long text'),
 (A, "if (!co || /^(?:it|that|this|everything|all|applying|application|applications)$/i.test(co) || co.split(\" \").length > 6) return null;", "if (!co) return null;", 'cancel: vague target'),
 (A, "/^(?:please )?(?:cancel|withdraw|stop) (?:applying|my application|the application|sending my application) (?:to|for|at|with) (.+?)(?: please)?$/i,", "/^(?:please )?(?:cancel|withdraw|stop) (?:.+?) (?:to|for|at|with) (.+?)(?: please)?$/i,", 'cancel: stop is only stop applying'),
 (A, 'if (r.error) return {', 'if (false) return {', 'cancel: failure said'),
 (A, 'd.cards_closed ? "closed its card, so a tap on it approves nothing" : ""', '""', 'cancel: card closure said'),
 (A, 'status: did ? "cancelled" : d.being_sent || sent.length ? "too_late" : "none"', 'status: did ? "cancelled" : "none"', 'cancel: too late status'),
 (A, 'if (d.being_sent) parts.push(', 'if (false) parts.push(', 'cancel: being sent said'),
 (A, 'if (sent.length) parts.push(', 'if (false) parts.push(', 'cancel: sent said'),
 (A, '${nothingWent ? ` Nothing was sent to ${co}.` : ""}', ' Nothing was sent to ${co}.', 'F4 cancel: nothing sent only when true'),
 (A, 'if (!ans || ans.intent !== "career_apply_status") return 0;', 'if (!ans) return 0;', 'status: only status replies'),
 (A, "if (!rows) { ans.reply = `${ans.reply}\\nI couldn't read the applications still being prepared just now.`; return 0; }", 'if (!rows) return 0;', 'status: unreadable said'),
 (A, 'const mine = ask.company ? rows.filter(', 'const mine = false ? rows.filter(', 'status: employer scoped'),
 (A, '    case "stopped": return', '    case "stopped-x": return', 'F4 status: STOP said'),
 (A, '    case "waiting_day_limit": return', '    case "waiting_day_limit-x": return', 'F4 status: day limit said'),
 (CARDS, "reply: 'Nothing is ready for you to approve yet. Send me a job link with \"apply me to\" and I\\'ll prepare it and send its card here; \"where are my applications\" says what is being prepared.',", 'reply: "Nothing is prepared yet. Prepare applications on your computer first; they show up here.",', 'F4 empty card list: no computer'),
]
DENO = ['deno', 'test', '-A', '--no-check'] + shlex.split(os.environ.get('DENO_ARGS', ''))
def run():
    return subprocess.run(DENO + TESTS, cwd=ROOT, capture_output=True, text=True)
only = sys.argv[1:]
base = run()
print('CONTROL', 'GREEN' if base.returncode == 0 else 'RED\n' + base.stdout[-2000:])
if base.returncode: sys.exit(1)
red, bad = 0, []
sel = [m for m in M if not only or any(m[3].startswith(o) for o in only)]
for f, old, new, name in sel:
    path = os.path.join(ROOT, f); s = open(path).read()
    if s.count(old) != 1: print(f'ANCHOR   {name}: found {s.count(old)} times'); bad.append(name); continue
    open(path, 'w').write(s.replace(old, new))
    try: r = run()
    finally: open(path, 'w').write(s)
    failed = [l for l in r.stdout.splitlines() if 'FAILED' in l][:1]
    if r.returncode != 0: red += 1; print(f'RED      {name}: {(failed[0] if failed else "")[:120]}')
    else: print(f'SURVIVED {name}'); bad.append(name)
print(f'{red}/{len(sel)} red' + (f'; not red: {", ".join(bad)}' if bad else ''))
sys.exit(0 if red == len(sel) else 1)
