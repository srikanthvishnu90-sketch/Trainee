#!/usr/bin/env node
"use strict";
// The STRICT browser benchmark (owner, 2026-11-09: "the benchmarks need to be strict"). It grades the production runner itself
// (workers/career-browser/parallel-apply.cjs applyOne), not a separate fill path, on the committed sample of real postings.
//
// A posting PASSES only when the runner, given a synthetic TEST person and resume and no answers to custom questions,
// reaches the instant before its Submit click: the page opened on an allowed host, no shown check or sign-in wall, the form
// found, every field it filled read back, nothing required left empty, the form posting to an allowed host, and the payload
// hash still matching. There it is stopped (onPhase("submitting") throws). Everything else is a failure, counted against the
// same denominator: every sampled posting, including closed, unreachable and robots-refused ones. "Ready if answered" (it
// stopped only for custom questions the person would answer) is reported beside PASS and is not a pass.
//
// Nothing is ever sent:
//   - every request but GET/HEAD/OPTIONS is aborted, except a POST whose body is a GraphQL read (every operation a `query`,
//     no `mutation`), which some boards use to load the form; each one is logged;
//   - a page script cancels every form submit, form.submit() and requestSubmit(), and counts the attempt;
//   - the runner is stopped before its click, with retries 0; robots.txt is obeyed; 1 page load a second per host.
//   node scripts/browser-eval/strict.cjs --sample scripts/browser-eval/sample.csv --label strict-1 [--max-per-provider 20] [--providers a,b]
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const lib = require("./eval-lib.cjs");
const { applyOne, payloadHash, NeedsUser } = require("../../workers/career-browser/parallel-apply.cjs");

// The hosts each provider's postings and forms live on; a redirect anywhere else is a failure (redirect_not_allowed).
const PROVIDER_HOSTS = {
  greenhouse: ["boards.greenhouse.io", "job-boards.greenhouse.io"], lever: ["jobs.lever.co"], ashby: ["jobs.ashbyhq.com"],
  smartrecruiters: ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"], workable: ["apply.workable.com"],
  recruitee: [], teamtailor: [], personio: [], bamboohr: [], breezy: [], workday: [],
};
const UPLOAD_ONLY = (needs) => Array.isArray(needs) && needs.length > 0 && needs.every((n) => n.reason === "upload_not_accepted");
const LOGIN_WORDS = /\b(log ?in|log on|sign ?in|sign on|iniciar sesi[oó]n|anmelden|einloggen|connexion|se connecter|inloggen|logga in|log ind|logg inn|prisijungti|pieteikties sist[eē]m[aā]|password|passwort|contrase[nñ]a|mot de passe|wachtwoord|l[oö]senord)\b/i;
// Why a stop at Submit is not a pass (null: it is one).
function falsePass(audit, facts) {
  if (!audit) return "no_audit";
  const person = new Set([facts.full_name, facts.first_name, facts.last_name, facts.email].filter(Boolean).map((v) => String(v).trim()));
  const ok = (audit.fields || []).some((f) => f.source === "fact" && person.has(String(f.approved).trim()) && String(f.held == null ? "" : f.held).trim() === String(f.approved).trim());
  if (!ok) return "no_person_field_read_back";
  if (LOGIN_WORDS.test(audit.submit || "")) return "submit_is_login";
  if (audit.password_field) return "password_field_shown";
  return null;
}
const CUSTOM_ONLY = (needs) => Array.isArray(needs) && needs.length > 0 && needs.every((n) => n.reason === "no_confirmed_answer");

// A board that serves every employer from subdomains of one domain (acme.recruitee.com, beta.recruitee.com) rate-limits that
// domain as a whole (run 42719264485: four Recruitee postings got 429 at 1 page a second per subdomain): paced as one host.
const SHARED_DOMAINS = ["recruitee.com"];
function paceKey(host) {
  const h = String(host).toLowerCase();
  return SHARED_DOMAINS.find((d) => h === d || h.endsWith(`.${d}`)) || h;
}

function graphqlRead(req) {
  if (req.method() !== "POST") return false;
  let body;
  try { body = JSON.parse(req.postData() || ""); } catch { return false; }
  const ops = Array.isArray(body) ? body : [body];
  return ops.length > 0 && ops.every((op) => op && typeof op.query === "string" &&
    /^\s*(?:#[^\n]*\n\s*)*(query\b|\{)/.test(op.query) && !/\bmutation\b/.test(op.query) && !/\bsubscription\b/.test(op.query));
}

async function robotsOk(url, cache, ua) {
  const u = new URL(url);
  if (!cache.has(u.origin)) {
    let g;
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": ua }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      g = r.status >= 500 ? "deny" : r.ok ? lib.parseRobots(await r.text()) : [];
    } catch { g = "unreachable"; }
    cache.set(u.origin, g);
  }
  const g = cache.get(u.origin);
  if (g === "unreachable") return "unreachable";
  return g !== "deny" && lib.robotsAllows(g, u.pathname + u.search);
}

async function strictPosting(browser, item, o) {
  const r = { provider: item.provider, url: item.url, result: "fail", reason: null, field: null, needs: null, sent_blocked: 0, graphql_reads: 0, submit_attempts: 0, ms: 0 };
  const t0 = Date.now();
  const rb = await robotsOk(item.url, o.robots, o.ua);
  if (rb !== true) { r.reason = rb === "unreachable" ? "host_unreachable" : "robots_disallowed"; r.ms = Date.now() - t0; return r; }
  const host = new URL(item.url).hostname.toLowerCase();
  const allowHosts = [...new Set([host, ...(PROVIDER_HOSTS[item.provider] || [])])];
  const resumeSha = crypto.createHash("sha256").update(fs.readFileSync(o.resumePath)).digest("hex");
  const p = { id: `${item.provider}-${item.n ?? ""}`, ats: item.provider, url: item.url, facts: lib.TEST_FACTS, answers: {}, resume: { path: o.resumePath, sha256: resumeSha, preparedWithSha256: resumeSha } };
  p.approval = { approval_id: "strict-dry-run", hash: payloadHash(p) };
  const gate = async (req) => {
    let u; try { u = new URL(req.url()); } catch { return false; }
    if (/^(data|blob|about):$/.test(u.protocol)) return true;
    if (!/^(GET|HEAD|OPTIONS)$/.test(req.method())) {
      if (graphqlRead(req)) { r.graphql_reads++; }
      else { r.sent_blocked++; return false; }
    }
    if (["image", "media", "font"].includes(req.resourceType())) return false;
    // Polite pacing is per page load (1 a second per host), not per script or stylesheet a page loads with it.
    if (req.isNavigationRequest()) await o.pacer.wait(paceKey(u.host));
    return true;
  };
  // Coordinator ruling (2026-11-10, after Teamtailor's sign-in form "passed" run 42719264485): at the stop, a pass also needs a
  // person field (name or email) filled and read back as approved, a Submit that is not a login / sign-in / password control,
  // and no password box on the page. Anything else at that instant is a false pass, scored as a failure with its reason.
  const stop = async (phase, audit) => {
    if (phase !== "submitting") return;
    const why = falsePass(audit, p.facts);
    throw new NeedsUser(why ? `strict_false_pass:${why}` : "strict_reached_submit", audit && audit.submit);
  };
  const out = await applyOne(browser, p, { allowHosts, retries: 0, diag: true, audit: true, stepTimeoutMs: 20000, requestGate: gate, initScript: lib.SUBMIT_TRAP, onPhase: stop }).catch((e) => ({ status: "error", reason: `driver_error: ${String(e && e.message).split("\n")[0].slice(0, 140)}` }));
  r.reason = out.reason || out.status; r.error = out.error ? String(out.error).slice(0, 140) : out.check ? `shown: ${out.check}` : null; r.field = out.field ? String(out.field).slice(0, 80) : null; r.needs = out.needs || null;
  if (out.reason === "strict_reached_submit") r.result = "pass";
  else if (out.reason === "missing_required_answer" && CUSTOM_ONLY(out.needs)) r.result = "ready_if_answered";
  // Coordinator ruling: a board that uploads the resume before Submit (Teamtailor POST /uploads/presigned_data) is blocked here,
  // since a synthetic file in the employer's storage is still data leaving the browser. When the upload is the only thing left
  // (the file staged, every other field filled and read back, an upload request aborted), it is reported beside pass, never as one.
  else if (UPLOAD_ONLY(out.needs) && r.sent_blocked > 0) r.result = "ready_except_upload";
  if (out.status === "submitted_page_confirmed" || out.status === "unknown_outcome") { r.result = "fail"; r.reason = `BREACH: runner reported ${out.status}`; }
  r.diag = out.diag || null; r.check = out.check || null;
  r.ms = Date.now() - t0;
  return r;
}

function summarize(rows) {
  const by = new Map();
  for (const x of rows) { if (!by.has(x.provider)) by.set(x.provider, []); by.get(x.provider).push(x); }
  const reasons = (rs) => Object.entries(rs.filter((x) => x.result === "fail").reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const prov = [...by].sort().map(([provider, rs]) => ({ provider, sampled: rs.length, pass: rs.filter((x) => x.result === "pass").length,
    ready_if_answered: rs.filter((x) => x.result === "ready_if_answered").length, ready_except_upload: rs.filter((x) => x.result === "ready_except_upload").length, fail: rs.filter((x) => x.result === "fail").length, top_fail: reasons(rs).slice(0, 3) }));
  const all = { sampled: rows.length, pass: rows.filter((x) => x.result === "pass").length, ready_if_answered: rows.filter((x) => x.result === "ready_if_answered").length,
    ready_except_upload: rows.filter((x) => x.result === "ready_except_upload").length, false_passes: rows.filter((x) => /^strict_false_pass/.test(x.reason || "")).length,
    sends_blocked: rows.reduce((a, x) => a + x.sent_blocked, 0), graphql_reads: rows.reduce((a, x) => a + x.graphql_reads, 0),
    breaches: rows.filter((x) => /^BREACH/.test(x.reason || "")).length, top_fail: reasons(rows).slice(0, 8) };
  return { all, prov };
}

function markdown(label, s) {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const L = [`# Strict browser benchmark ${label}`, "", `Pass = the production runner reached the instant before Submit with every required field filled and read back (synthetic person, no custom answers). Denominator = every sampled posting.`, "",
    `**Pass: ${s.all.pass} / ${s.all.sampled} (${pct(s.all.pass, s.all.sampled)}).** Ready if answered (not a pass): ${s.all.ready_if_answered}. Ready except upload (not a pass; the upload needs the person's yes): ${s.all.ready_except_upload}. False passes refused (sign-in form, nothing of the person's filled): ${s.all.false_passes}. Sends blocked in the browser: ${s.all.sends_blocked}. GraphQL reads allowed: ${s.all.graphql_reads}. Breaches (anything reported as sent): ${s.all.breaches}.`, "",
    "| provider | sampled | pass | pass % | ready if answered | ready except upload | fail | top failure reasons |", "|---|---|---|---|---|---|---|---|"];
  for (const x of s.prov) L.push(`| ${x.provider} | ${x.sampled} | ${x.pass} | ${pct(x.pass, x.sampled)} | ${x.ready_if_answered} | ${x.ready_except_upload} | ${x.fail} | ${x.top_fail.map(([k, n]) => `${k} ${n}`).join("; ")} |`);
  L.push("", "Failure reasons overall: " + s.all.top_fail.map(([k, n]) => `${k} ${n}`).join("; "));
  return L.join("\n") + "\n";
}

async function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const label = String(arg("label", "strict")).replace(/[^A-Za-z0-9._-]/g, "-");
  const out = path.resolve(arg("out", path.join("artifacts", "browser-eval", label)));
  fs.mkdirSync(out, { recursive: true });
  // --providers recruitee,teamtailor: bench only those boards (the denominator is then their sampled postings).
  const providers = arg("providers", "") ? String(arg("providers")).toLowerCase().split(",").map((x) => x.trim()).filter(Boolean) : null;
  const items = lib.readSample(fs.readFileSync(arg("sample"), "utf8"), { max: arg("max-per-provider", 20), providers });
  let pw; for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const browser = await pw.chromium.launch({ headless: true });
  const o = { robots: new Map(), pacer: lib.createPacer(), ua: `Mozilla/5.0 ${lib.UA_TOKEN}`, resumePath: lib.syntheticResume(path.join(out, "fixtures")) };
  const rows = new Array(items.length); let next = 0;
  const conc = Math.max(1, Number(arg("concurrency", 6)));
  await Promise.all(Array.from({ length: conc }, async () => { while (next < items.length) { const i = next++; rows[i] = await strictPosting(browser, items[i], o);
    const x = rows[i]; console.log(["STRICT", x.provider, x.result, x.reason, x.field || x.error || "", `blocked=${x.sent_blocked}`, `gql=${x.graphql_reads}`, `${(x.ms / 1000).toFixed(1)}s`, x.url].join(" | "));
    if (x.result !== "pass" && (x.diag || x.check)) console.log("DIAG | " + x.provider + " | " + JSON.stringify({ check: x.check, ...x.diag }));
    // Why each field was handed back, and the options a choice offered (the posting's own words), for the record.
    if (x.result !== "pass" && x.needs) console.log("NEEDS | " + x.provider + " | " + x.url + " | " + JSON.stringify(x.needs.slice(0, 6).map((n) => ({ label: String(n.label || "").slice(0, 60), reason: n.reason, ...(n.options ? { options: n.options.slice(0, 12).map((o) => String(o).slice(0, 40)) } : {}) })))); } }));
  await browser.close();
  const s = summarize(rows);
  fs.writeFileSync(path.join(out, "strict.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "strict-summary.json"), JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(out, "strict-summary.md"), markdown(label, s));
  process.stdout.write(markdown(label, s));
  if (s.all.breaches) process.exit(3);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { strictPosting, graphqlRead, paceKey, falsePass, UPLOAD_ONLY, robotsOk, summarize, markdown, CUSTOM_ONLY, PROVIDER_HOSTS };
