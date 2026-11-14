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
//   node scripts/browser-eval/strict.cjs --sample scripts/browser-eval/sample.csv --label strict-1 [--max-per-provider 20] [--providers greenhouse,lever,workable,breezy,ashby] [--persona default|full]
// --persona full (eval-lib FULL_FACTS) is a separate run and a separate column: the same synthetic person with the facts a real
// applicant confirms (city, state, US work authorization, no sponsorship need). The default persona's number is never replaced.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const lib = require("./eval-lib.cjs");
const d072 = require("./d072.cjs");
const { applyOne, payloadHash, NeedsUser } = require("../../workers/career-browser/parallel-apply.cjs");
// The apply VM's own verdict on the link (atsOf): a pass on a board the VM refuses is not one production can reach.
const { atsOf } = require("../../workers/career-browser/apply-vm.cjs");
const vmVerdict = (url) => atsOf(url).refuse || "drives";

// The hosts each provider's postings and forms live on; a redirect anywhere else is a failure (redirect_not_allowed).
const PROVIDER_HOSTS = {
  greenhouse: ["boards.greenhouse.io", "job-boards.greenhouse.io", "job-boards.eu.greenhouse.io"], lever: ["jobs.lever.co"], ashby: ["jobs.ashbyhq.com"],
  smartrecruiters: ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"], workable: ["apply.workable.com"],
  recruitee: [], teamtailor: [], personio: [], bamboohr: [], breezy: [], workday: [],
};
// Coordinator ruling (2026-11-10), a measurement aid only: the board's own resume-upload request, matched exactly by host and
// path, is answered inside the browser with a fake success (nothing leaves the browser) and logged as upload_simulated. A
// posting that needed one is never a pass: it is "ready except upload (needs the person's yes)", in its own column.
const SIMULATED_UPLOADS = [
  // job-boards.greenhouse.io posts the resume straight to its S3 bucket (strict runs 42736815031, 42737911402:
  // grnhse-prod-jben-us-east-1.s3.amazonaws.com, grnhse-prod-jben-eu-west-1.s3.eu-west-1.amazonaws.com).
  { provider: "greenhouse", host: /^grnhse-prod-jben-[a-z0-9-]+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/, path: /^\/$/, methods: ["POST", "OPTIONS"] },
  // Architect ruling on #741: Workable posts the resume to its own S3 bucket (strict r12 DIAG: workable-application-form.s3.us-east-1
  // .amazonaws.com/); blocked, the page discards its form a moment later. Answered here the same way, never sent.
  { provider: "workable", host: /^workable-application-form\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/, path: /^\/$/, methods: ["POST", "OPTIONS"] },
  // D-072 (item 4, round 2): Breezy posts the resume to its own API, https://app.breezy.hr/api/portal/<company>/upload (multipart,
  // field "file"; capture of 2026-11-12), and its portal script (portal-ga9Z0GTh.js: Rp / iS / onFileSelect) takes any 2xx whose
  // JSON has a `url` as the stored file and shows it. Answered here with {"url": <a simulated address>}, never sent.
  // D-072 (item 4, round 2): Teamtailor asks its own site for a presigned upload (POST /uploads/presigned_data, JSON {filename};
  // capture of 2026-11-12) and its careersite script (chunk-ZHRXYZOI: the resume Dropzone's accept / processFile / handleSuccess)
  // then posts the file with the answer's `fields` to the answer's `url` and reads the stored file from the Location header. Both
  // are answered here: the presigned answer names a storage address that does not exist (simulated-upload.invalid), and that
  // address's POST is answered 204 with its Location. Never sent anywhere.
  { provider: "teamtailor", host: /./, path: /^\/uploads\/presigned_data$/, methods: ["POST"], presign: true },
  { provider: "teamtailor", host: /^simulated-upload\.invalid$/, path: /^\/$/, methods: ["POST", "OPTIONS"] },
  { provider: "breezy", host: /^app\.breezy\.hr$/, path: /^\/api\/portal\/[A-Za-z0-9_-]+\/upload(?:\/file)?$/, methods: ["POST", "OPTIONS"], json: true },
];
// The simulated file's address: never fetched (simulatedFileRead below aborts any request that names it).
const SIMULATED_FILE = "https://simulated-upload.invalid/TEST-synthetic-resume.pdf";
const simulatedFileRead = (req) => { try { const t = decodeURIComponent(req.url()); return t.includes(SIMULATED_FILE) || (req.method() !== "POST" && req.method() !== "OPTIONS" && new URL(req.url()).hostname === "simulated-upload.invalid"); } catch { return false; } };
function simulatedUpload(req, provider) {
  let u; try { u = new URL(req.url()); } catch { return null; }
  const rule = SIMULATED_UPLOADS.find((x) => x.provider === provider && u.protocol === "https:" && x.host.test(u.hostname) && x.path.test(u.pathname) && x.methods.includes(req.method()));
  if (!rule) return null;
  const h = req.headers() || {};
  // The page's own origin (an XHR sent with credentials needs that exact origin and allow-credentials; "*" is refused by the browser,
  // and the page then never sees the answer: strict run 43276162667, three job-boards.greenhouse.io forms whose progress stayed 0%).
  let origin = h.origin || "";
  if (!origin) { try { origin = new URL(req.frame().url()).origin; } catch { origin = "*"; } }
  const cors = { "access-control-allow-origin": origin || "*", ...(origin && origin !== "*" ? { "access-control-allow-credentials": "true", vary: "Origin" } : {}),
    "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": h["access-control-request-headers"] || "*", "access-control-expose-headers": "ETag, Location" };
  if (req.method() === "OPTIONS") return { status: 204, headers: cors, body: "" };
  if (rule.presign) {
    // Only the page's own site (a Teamtailor career site on its own domain), never another host's path of the same name.
    let pageHost = ""; try { pageHost = new URL(req.frame().url()).hostname; } catch { /* none */ }
    if (pageHost !== u.hostname) return null;
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://simulated-upload.invalid/", fields: { key: "uploads/simulated/${filename}", acl: "private", "x-amz-algorithm": "AWS4-HMAC-SHA256", policy: "simulated", "x-amz-signature": "simulated" } }) };
  }
  if (rule.json) return { status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ url: SIMULATED_FILE, file_name: "TEST-synthetic-resume.pdf" }) };
  // An S3 form POST answers 204, or 201 with the object's key when the form asks for success_action_status 201.
  let body = ""; try { body = (req.postDataBuffer() || Buffer.alloc(0)).toString("latin1"); } catch { /* no body */ }
  const field = (n) => { const m = new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(body); return m ? m[1] : ""; };
  const key = field("key").replace("${filename}", "TEST-synthetic-resume.pdf");
  if (field("success_action_status") === "201") {
    const x = (t) => t.replace(/[<>&]/g, "");
    return { status: 201, headers: { ...cors, "content-type": "application/xml" }, body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${x(u.origin)}/${x(key)}</Location><Bucket>${x(u.hostname.split(".")[0])}</Bucket><Key>${x(key)}</Key><ETag>"0"</ETag></PostResponse>` };
  }
  return { status: 204, headers: { ...cors, ...(key ? { location: `${u.origin}/${encodeURIComponent(key)}` } : {}) }, body: "" };
}
const CUSTOM_ONLY = (needs) => Array.isArray(needs) && needs.length > 0 && needs.every((n) => n.reason === "no_confirmed_answer");

function graphqlRead(req) {
  if (req.method() !== "POST") return false;
  let body;
  try { body = JSON.parse(req.postData() || ""); } catch { return false; }
  const ops = Array.isArray(body) ? body : [body];
  return ops.length > 0 && ops.every((op) => op && typeof op.query === "string" &&
    /^\s*(?:#[^\n]*\n\s*)*(query\b|\{)/.test(op.query) && !/\bmutation\b/.test(op.query) && !/\bsubscription\b/.test(op.query));
}

// D-072: one provider serves every employer's subdomain from the same machines (Recruitee answered 429 to 10 of 20 held-out
// postings in run 43192269304, each on its own subdomain, six at once). The polite pace is per provider, not per subdomain.
const SHARED = /(?:^|\.)(recruitee\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|jobs\.personio\.de|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|lever\.co|ashbyhq\.com|greenhouse\.io)$/i;
const paceKey = (host) => { const m = SHARED.exec(String(host).toLowerCase()); return m ? m[1].toLowerCase() : String(host).toLowerCase(); };
async function robotsOk(url, cache, ua, pacer) {
  const u = new URL(url);
  if (!cache.has(u.origin)) {
    let g;
    if (pacer) await pacer.wait(paceKey(u.host));
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

// The bench's stop at the instant before the click. A Submit inside an employee sign-in form is refused (architect ruling on #741:
// Teamtailor's "Already working at X?" form was counted as a pass), never counted as reaching the application's Submit.
function strictStop() {
  return async (phase, _audit, submit) => {
    if (phase !== "submitting") return;
    if (submit && submit.signin) throw new NeedsUser("strict_signin_form", String(submit.form || "").slice(0, 80));
    throw new NeedsUser("strict_reached_submit");
  };
}
async function strictPosting(browser, item, o) {
  const persona = o.persona || "default";
  if (!lib.PERSONAS[persona]) throw new Error(`unknown persona: ${persona}`);
  const r = { provider: item.provider, url: item.url, persona, vm: vmVerdict(item.url), result: "fail", reason: null, field: null, needs: null, sent_blocked: 0, upload_simulated: 0, graphql_reads: 0, submit_attempts: 0, ms: 0 };
  const t0 = Date.now();
  const rb = await robotsOk(item.url, o.robots, o.ua, o.pacer);
  if (rb !== true) { r.reason = rb === "unreachable" ? "host_unreachable" : "robots_disallowed"; r.ms = Date.now() - t0; r.d072 = d072.classify(r); return r; }
  const host = new URL(item.url).hostname.toLowerCase();
  // The posting's own host and its www twin (sofi.com sends every visitor to www.sofi.com: the same site, not a redirect off it).
  const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const allowHosts = [...new Set([host, twin, ...(PROVIDER_HOSTS[item.provider] || [])])];
  const resumeSha = crypto.createHash("sha256").update(fs.readFileSync(o.resumePath)).digest("hex");
  const p = { id: `${item.provider}-${item.n ?? ""}`, ats: item.provider, url: item.url, facts: lib.PERSONAS[persona], answers: {}, resume: { path: o.resumePath, sha256: resumeSha, preparedWithSha256: resumeSha } };
  p.approval = { approval_id: "strict-dry-run", hash: payloadHash(p) };
  const gate = async (req) => {
    let u; try { u = new URL(req.url()); } catch { return false; }
    if (/^(data|blob|about):$/.test(u.protocol)) return true;
    if (simulatedFileRead(req)) return false;
    const sim = simulatedUpload(req, item.provider);
    if (sim) { if (req.method() === "POST") r.upload_simulated++; return { fulfill: sim }; }
    if (!/^(GET|HEAD|OPTIONS)$/.test(req.method())) {
      if (graphqlRead(req)) { r.graphql_reads++; }
      else { r.sent_blocked++; if (/\/wday\/cxs\/[^/]+\/jobpostings\//.test(u.pathname)) r.workday_start_blocked = true; if ((r.blocked = r.blocked || []).length < 8) r.blocked.push(`${req.method()} ${u.host}${u.pathname.slice(0, 60)}${u.search.slice(0, 40)}`); return false; }
    }
    if (["image", "media", "font"].includes(req.resourceType())) return false;
    // Polite pacing is per page load (1 a second per host), not per script or stylesheet a page loads with it.
    if (req.isNavigationRequest()) await o.pacer.wait(paceKey(u.host));
    return true;
  };
  const stop = strictStop();
  const out = await applyOne(browser, p, { allowHosts, retries: 0, diag: true, stepTimeoutMs: 20000, requestGate: gate, initScript: lib.SUBMIT_TRAP, onPhase: stop }).catch((e) => ({ status: "error", reason: `driver_error: ${String(e && e.message).split("\n")[0].slice(0, 140)}` }));
  r.reason = out.reason || out.status; r.error = out.error ? String(out.error).slice(0, 140) : out.check ? `shown: ${out.check}` : null; r.field = out.field ? String(out.field).slice(0, 80) : null; r.needs = out.needs || null;
  if (out.reason === "strict_reached_submit") r.result = r.upload_simulated ? "ready_except_upload" : "pass";
  else if (out.reason === "missing_required_answer" && CUSTOM_ONLY(out.needs)) r.result = "ready_if_answered";
  if (out.status === "submitted_page_confirmed" || out.status === "unknown_outcome") { r.result = "fail"; r.reason = `BREACH: runner reported ${out.status}`; }
  r.diag = out.diag || null; r.check = out.check || null;
  // D-072: the wall the run stopped at, the page it stopped on, and the hand-off the runner produced there (or none).
  r.wall = out.wall || null; r.at = out.at || null; r.handoff = out.handoff || null; r.filled_count = (out.filled_labels || []).length;
  r.d072 = d072.classify(r);
  r.ms = Date.now() - t0;
  return r;
}

function summarize(rows) {
  const by = new Map();
  for (const x of rows) { if (!by.has(x.provider)) by.set(x.provider, []); by.get(x.provider).push(x); }
  const reasons = (rs) => Object.entries(rs.filter((x) => x.result === "fail").reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const prov = [...by].sort().map(([provider, rs]) => ({ provider, sampled: rs.length, pass: rs.filter((x) => x.result === "pass").length,
    ready_if_answered: rs.filter((x) => x.result === "ready_if_answered").length, ready_except_upload: rs.filter((x) => x.result === "ready_except_upload").length, fail: rs.filter((x) => x.result === "fail").length, top_fail: reasons(rs).slice(0, 3),
    vm_drives: rs.filter((x) => (x.vm || vmVerdict(x.url)) === "drives").length, vm_pass: rs.filter((x) => x.result === "pass" && (x.vm || vmVerdict(x.url)) === "drives").length }));
  const all = { sampled: rows.length, pass: rows.filter((x) => x.result === "pass").length,
    vm_pass: rows.filter((x) => x.result === "pass" && (x.vm || vmVerdict(x.url)) === "drives").length, ready_if_answered: rows.filter((x) => x.result === "ready_if_answered").length,
    ready_except_upload: rows.filter((x) => x.result === "ready_except_upload").length, uploads_simulated: rows.reduce((a, x) => a + (x.upload_simulated || 0), 0),
    sends_blocked: rows.reduce((a, x) => a + x.sent_blocked, 0), graphql_reads: rows.reduce((a, x) => a + x.graphql_reads, 0),
    breaches: rows.filter((x) => /^BREACH/.test(x.reason || "")).length, top_fail: reasons(rows).slice(0, 8) };
  return { all, prov, d072: d072.tally(rows) };
}

function markdown(label, s, persona = "default") {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const L = [`# Strict browser benchmark ${label} (persona: ${persona})`, "", `Pass = the production runner reached the instant before Submit with every required field filled and read back (synthetic person${persona === "full" ? " with the full confirmed profile: city, state, US work authorization, no sponsorship need" : ""}, no custom answers). Denominator = every sampled posting.`, "",
    `**Pass: ${s.all.pass} / ${s.all.sampled} (${pct(s.all.pass, s.all.sampled)}). Pass the apply VM drives today (production-reachable): ${s.all.vm_pass} / ${s.all.sampled} (${pct(s.all.vm_pass, s.all.sampled)}).** Ready if answered (not a pass): ${s.all.ready_if_answered}. Ready except upload (not a pass; the resume upload was simulated in the browser and needs the person's yes): ${s.all.ready_except_upload} (uploads simulated: ${s.all.uploads_simulated}). Sends blocked in the browser: ${s.all.sends_blocked}. GraphQL reads allowed: ${s.all.graphql_reads}. Breaches (anything reported as sent): ${s.all.breaches}.`, "",
    "| provider | sampled | pass | pass % | ready if answered | ready except upload | fail | VM today | pass the VM drives | top failure reasons |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const x of s.prov) L.push(`| ${x.provider} | ${x.sampled} | ${x.pass} | ${pct(x.pass, x.sampled)} | ${x.ready_if_answered} | ${x.ready_except_upload} | ${x.fail} | ${x.vm_drives === x.sampled ? "drives" : x.vm_drives ? `drives ${x.vm_drives}/${x.sampled}` : "refuses"} | ${x.vm_pass} | ${x.top_fail.map(([k, n]) => `${k} ${n}`).join("; ")} |`);
  L.push("", "Failure reasons overall: " + s.all.top_fail.map(([k, n]) => `${k} ${n}`).join("; "));
  if (s.d072) {
    const t = s.d072;
    L.push("", `**D-072 (99% bar): (a) ${t.a} + (b) ${t.b} = ${t.a + t.b} / ${t.n}; needs ${t.need}; ${t.meets ? "meets" : "does not meet"}.** Raw reached Submit: ${t.raw_pass}.`, "",
      "| outcome | cause | count |", "|---|---|---|", ...Object.entries(t.causes).sort().map(([k, n]) => `| ${k.split("|")[0]} | ${k.split("|")[1]} | ${n} |`));
  }
  return L.join("\n") + "\n";
}

async function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const label = String(arg("label", "strict")).replace(/[^A-Za-z0-9._-]/g, "-");
  const out = path.resolve(arg("out", path.join("artifacts", "browser-eval", label)));
  fs.mkdirSync(out, { recursive: true });
  const only = arg("providers", "") ? String(arg("providers")).toLowerCase().split(",").map((x) => x.trim()).filter(Boolean) : null;
  const items = lib.readSample(fs.readFileSync(arg("sample"), "utf8"), { max: arg("max-per-provider", 20), providers: only });
  let pw; for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const browser = await pw.chromium.launch({ headless: true });
  const persona = String(arg("persona", "default"));
  if (!lib.PERSONAS[persona]) { console.error(`unknown --persona ${persona} (default|full)`); process.exit(2); }
  const o = { persona, robots: new Map(), pacer: lib.createPacer(), ua: `Mozilla/5.0 ${lib.UA_TOKEN}`, resumePath: lib.syntheticResume(path.join(out, "fixtures")) };
  const rows = new Array(items.length); let next = 0;
  const conc = Math.max(1, Number(arg("concurrency", 6)));
  await Promise.all(Array.from({ length: conc }, async () => { while (next < items.length) { const i = next++; rows[i] = await strictPosting(browser, items[i], o);
    const x = rows[i]; console.log(["STRICT", x.provider, x.result, `vm=${x.vm}`, x.reason, x.field || x.error || "", `blocked=${x.sent_blocked}`, `gql=${x.graphql_reads}`, `upload_simulated=${x.upload_simulated}`, `${(x.ms / 1000).toFixed(1)}s`, x.url, `persona=${x.persona}`].join(" | "));
    if (x.handoff) console.log("HANDOFF | " + x.provider + " | " + x.url + " | " + JSON.stringify({ reason: x.handoff.reason, wall: x.handoff.wall, link: x.handoff.link, card: x.handoff.card || null, step: x.handoff.step, filled: x.handoff.filled.length, at_door: x.handoff.at_door, remaining: x.handoff.remaining.slice(0, 6) }));
    console.log("D072 | " + x.provider + " | " + x.d072.outcome + " | " + x.d072.cause + " | " + x.url);
    if (x.result !== "pass" && (x.diag || x.check)) console.log("DIAG | " + x.provider + " | " + JSON.stringify({ check: x.check, blocked: x.blocked || [], ...x.diag }));
    // Why each field was handed back, and the options a choice offered (the posting's own words), for the record.
    if (x.result !== "pass" && x.needs) console.log("NEEDS | " + x.provider + " | " + x.url + " | " + JSON.stringify([...x.needs].sort((m, n) => (m.reason === "no_confirmed_answer") - (n.reason === "no_confirmed_answer")).slice(0, 12).map((n) => ({ label: String(n.label || "").slice(0, 60), reason: n.reason, ...(n.kind ? { kind: n.kind } : {}), ...(n.detail ? { detail: String(n.detail).slice(0, 160) } : {}), ...(n.options ? { options: n.options.slice(0, 12).map((o) => String(o).slice(0, 40)) } : {}) })))); } }));
  await browser.close();
  const s = summarize(rows); s.persona = persona;
  fs.writeFileSync(path.join(out, "strict.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "strict-summary.json"), JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(out, "strict-summary.md"), markdown(label, s, persona));
  process.stdout.write(markdown(label, s, persona));
  { const t = s.d072; console.log(`D072-TOTAL | ${label} | a ${t.a} | b ${t.b} | a+b ${t.a + t.b} / ${t.n} | need ${t.need} | ${t.meets ? "MEETS" : "BELOW"} | raw reached Submit ${t.raw_pass}`); }
  if (s.all.breaches) process.exit(3);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { strictStop, simulatedUpload, simulatedFileRead, SIMULATED_FILE, SIMULATED_UPLOADS, strictPosting, graphqlRead, robotsOk, summarize, markdown, CUSTOM_ONLY, PROVIDER_HOSTS };
