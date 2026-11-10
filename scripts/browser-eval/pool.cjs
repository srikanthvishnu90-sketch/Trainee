#!/usr/bin/env node
"use strict";
// Release item 2: one DRY-RUN batch of real postings through the production pool (workers/career-browser/parallel-apply.cjs
// runPool), the way a mass apply runs them: one approved payload per posting, `concurrency` at once. Nothing is ever sent: the
// same guards as the strict benchmark (strict.cjs): every request but GET/HEAD/OPTIONS (and a GraphQL read) aborted, a page
// script cancelling every form submit, robots.txt obeyed, page loads paced 1 a second per host, and the runner stopped at
// the instant before its Submit click (onPhase("submitting") throws), retries 0.
//
// It counts, per posting: the outcome. Over the batch:
//   duplicates - a posting that reached Submit more than once, a posting with more than one result, or two payloads in the
//                batch for one posting (must be 0);
//   dropped    - a posting in the batch with no result (must be 0);
//   mismatches - a field, at the instant before Submit, whose approved value is not what the payload approved, or that holds
//                anything other than its approved value (must be 0).
//   node scripts/browser-eval/pool.cjs --sample scripts/browser-eval/sample.csv --n 60 --concurrency 6 --label pool-60
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const lib = require("./eval-lib.cjs");
const { graphqlRead, robotsOk, PROVIDER_HOSTS } = require("./strict.cjs");
const { runPool, payloadHash, NeedsUser } = require("../../workers/career-browser/parallel-apply.cjs");
const { factValue, answerFor, norm, DECLINE, factsFrom, holdsApproved } = require("../../workers/career-browser/ats-fill.cjs");

// Round robin over the sample's providers, in file order, until n postings: every board is in the batch.
function pickBatch(items, n) {
  const by = new Map();
  for (const x of items) { if (!by.has(x.provider)) by.set(x.provider, []); by.get(x.provider).push(x); }
  const out = [];
  for (let i = 0; out.length < n; i++) {
    let any = false;
    for (const rs of by.values()) { if (rs[i] && out.length < n) { out.push(rs[i]); any = true; } }
    if (!any) break;
  }
  return out;
}

const digits = (v) => String(v || "").replace(/\D/g, "");
// Is this field's approved value the payload's own, and does the field hold exactly it? Returns null, or why not.
// The facts are the ones the fill used: the payload's facts, and its approved answers under a contact label (ats-fill factsFrom).
function fieldMismatch(f, p) {
  let want;
  const facts = factsFrom(p.facts, p.answers);
  if (f.source === "fact") want = factValue(f.label, facts);
  else if (f.source === "answer") want = answerFor(f.label, p.answers);
  else if (f.source === "resume") want = path.basename(p.resume.path);
  else if (f.source === "eeo_policy") want = facts.eeo_policy === "decline" ? "decline" : undefined;
  if (want === undefined || String(want) !== String(f.approved)) return "approved_value_not_in_payload";
  if (f.held === null || f.held === undefined || f.gone) return "field_gone";
  const held = Array.isArray(f.held) ? f.held : [f.held];
  if (f.source === "eeo_policy") return held.length === 1 && DECLINE.test(norm(held[0])) ? null : "holds_other_than_decline";
  if (["select", "radio", "buttons", "combobox"].includes(f.kind)) return held.length === 1 && (norm(held[0]) === norm(want) || holdsApproved(f, want, facts)) ? null : "holds_other_option";
  if (f.kind === "checkgroup") {
    const parts = String(want).split(/\s*[;,]\s*/).filter(Boolean).map(norm);
    const h = held.map(norm);
    return (h.length === 1 && h[0] === norm(want)) || (h.length === parts.length && parts.every((x) => h.includes(x))) ? null : "holds_other_options";
  }
  const t = String(held[0]).trim();
  if (t === String(want).trim()) return null;
  // Lever's place box holds the place picked from its own list ("Chicago, Illinois, United States" for "Chicago, IL").
  if (f.place && holdsApproved(f, want, facts)) return null;
  // A phone box that formats the number: the same digits, or the digits less the dial code its picker shows (ats-fill phoneSame).
  if (/^\+?[\d\s().\-\/]{6,}$/.test(String(want).trim()) && digits(t) && (digits(t) === digits(want) || (String(want).trim().startsWith("+") && digits(want).endsWith(digits(t)) && digits(want).length - digits(t).length <= 3))) return null;
  return "holds_other_text";
}

async function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const label = String(arg("label", "pool")).replace(/[^A-Za-z0-9._-]/g, "-");
  const out = path.resolve(arg("out", path.join("artifacts", "browser-eval", label)));
  fs.mkdirSync(out, { recursive: true });
  const n = Number(arg("n", 60));
  const batch = pickBatch(lib.readSample(fs.readFileSync(arg("sample"), "utf8"), { max: 20 }), n);
  let pw; for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const ua = `Mozilla/5.0 ${lib.UA_TOKEN}`, robots = new Map(), pacer = lib.createPacer();
  const resumePath = lib.syntheticResume(path.join(out, "fixtures"));
  const resumeSha = crypto.createHash("sha256").update(fs.readFileSync(resumePath)).digest("hex");

  // One approved payload per posting. robots.txt first: a refused posting is not driven, and its outcome says so.
  const payloads = [], pre = new Map(), hosts = new Set();
  for (const [i, item] of batch.entries()) {
    const id = `pool-${String(i + 1).padStart(2, "0")}-${item.provider}`;
    const rb = await robotsOk(item.url, robots, ua);
    if (rb !== true) { pre.set(id, rb === "unreachable" ? "host_unreachable" : "robots_disallowed"); continue; }
    hosts.add(new URL(item.url).hostname.toLowerCase());
    for (const h of PROVIDER_HOSTS[item.provider] || []) hosts.add(h);
    const p = { id, ats: item.provider, url: item.url, facts: lib.TEST_FACTS, answers: {}, resume: { path: resumePath, sha256: resumeSha, preparedWithSha256: resumeSha } };
    p.approval = { approval_id: `pool-dry-run-${id}`, hash: payloadHash(p) };
    payloads.push(p);
  }
  const counts = { sends_blocked: 0, graphql_reads: 0 };
  const gate = async (req) => {
    let u; try { u = new URL(req.url()); } catch { return false; }
    if (/^(data|blob|about):$/.test(u.protocol)) return true;
    if (!/^(GET|HEAD|OPTIONS)$/.test(req.method())) { if (graphqlRead(req)) counts.graphql_reads++; else { counts.sends_blocked++; return false; } }
    if (["image", "media", "font"].includes(req.resourceType())) return false;
    if (req.isNavigationRequest()) await pacer.wait(u.host);
    return true;
  };
  const reached = new Map(), audits = new Map();
  const stop = async (phase, audit) => {
    if (phase !== "submitting") return;
    const id = audit && audit.id;
    reached.set(id, (reached.get(id) || 0) + 1);
    audits.set(id, audit ? audit.fields : null);
    throw new NeedsUser("strict_reached_submit");
  };
  const browser = await pw.chromium.launch({ headless: true });
  const t0 = Date.now();
  const pool = await runPool(browser, payloads, { concurrency: Number(arg("concurrency", 6)), allowHosts: [...hosts], retries: 0, stepTimeoutMs: 20000,
    requestGate: gate, initScript: lib.SUBMIT_TRAP, onPhase: stop, audit: true });
  await browser.close();

  // Per posting: exactly one outcome.
  const resultsById = new Map();
  for (const r of pool.results) { if (!r) continue; resultsById.set(r.id, [...(resultsById.get(r.id) || []), r]); }
  const rows = [];
  let duplicates = 0, dropped = 0, mismatches = 0;
  const urls = new Map();
  for (const item of batch) urls.set(item.url, (urls.get(item.url) || 0) + 1);
  duplicates += [...urls.values()].filter((c) => c > 1).length;
  for (const [i, item] of batch.entries()) {
    const id = `pool-${String(i + 1).padStart(2, "0")}-${item.provider}`;
    if (pre.has(id)) { rows.push({ id, provider: item.provider, url: item.url, outcome: pre.get(id), driven: false }); continue; }
    const rs = resultsById.get(id) || [];
    if (!rs.length) { dropped++; rows.push({ id, provider: item.provider, url: item.url, outcome: "DROPPED" }); continue; }
    if (rs.length > 1 || (reached.get(id) || 0) > 1) duplicates++;
    const r = rs[0];
    const row = { id, provider: item.provider, url: item.url, outcome: r.reason === "strict_reached_submit" ? "reached_submit" : (r.reason || r.status), field: r.field || null, attempts: r.attempts, reached_submit: reached.get(id) || 0 };
    if (r.status === "submitted_page_confirmed" || r.status === "unknown_outcome") row.outcome = `BREACH: ${r.status}`;
    if (row.outcome === "reached_submit") {
      const fields = audits.get(id) || [];
      row.fields = fields.length;
      row.mismatches = fields.map((f) => ({ label: f.label, why: fieldMismatch(f, payloads.find((p) => p.id === id)) })).filter((x) => x.why);
      if (!fields.length) row.mismatches.push({ label: "(none)", why: "no_fields_audited" });
      mismatches += row.mismatches.length;
    }
    rows.push(row);
  }
  const breaches = rows.filter((x) => /^BREACH/.test(x.outcome)).length;
  const byOutcome = rows.reduce((m, x) => ((m[x.outcome] = (m[x.outcome] || 0) + 1), m), {});
  const summary = { batch: batch.length, driven: payloads.length, results: pool.results.filter(Boolean).length, reached_submit: rows.filter((x) => x.outcome === "reached_submit").length,
    duplicates, dropped, mismatches, breaches, ...counts, wall_s: Math.round((Date.now() - t0) / 1000), concurrency: pool.concurrency, by_outcome: byOutcome };
  for (const x of rows) console.log(["POOL", x.id, x.outcome, x.field || "", x.fields !== undefined ? `fields=${x.fields}` : "", x.mismatches ? `mismatch=${x.mismatches.length}${x.mismatches.length ? " " + JSON.stringify(x.mismatches.slice(0, 3)) : ""}` : "", x.url].join(" | "));
  console.log("POOL-SUMMARY " + JSON.stringify(summary));
  fs.writeFileSync(path.join(out, "pool.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "pool-summary.json"), JSON.stringify(summary, null, 2));
  if (breaches || duplicates || dropped || mismatches) process.exit(3);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { pickBatch, fieldMismatch };
