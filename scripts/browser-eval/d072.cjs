"use strict";
// D-072 (item 4), owner 2026-11-12: the 99% reading of the real-postings browser benchmark. Every posting ends in exactly one of
//   (a) every field filled from confirmed facts up to the instant before Submit; or
//   (b) a wall the rules keep (a shown captcha or bot check, the employer's account sign-in, an answer only the person can give,
//       a required upload only the person can provide), reached with everything else filled, and the hand-off produced: one link
//       for the person to finish only that step themselves, after which Trainee re-checks the page and shows the exact answers
//       before any yes-to-submit (workers/career-browser/handoff.cjs);
// or it is a failure, and every stop names its real reason (`cause`). The raw "reached Submit" headline (strict.cjs `pass`) is
// still reported beside it and never replaced.
//
// classify(row) reads one strict.cjs row (or the STRICT/DIAG/NEEDS lines a bench job printed, parsed by parseLog) and returns
// { outcome: "a" | "b" | "fail", cause, wall? }. A (b) needs row.handoff (the hand-off the runner produced at that stop) with
// a link and the named step; a row from a run that produced none (every run before D-072) is "fail" with cause
// `<wall>_no_handoff`, so the before and after numbers are read the same way.
// Pure: no browser, no network. tests/career-browser-d072.test.cjs proves each cause on fixed rows.

// The answers only the person can give (ats-fill's own reasons for handing a question back): their own answer to a custom
// question, a consent they must give, an EEO choice, a choice between the board's options none of which is a confirmed fact, and
// an upload the person has to provide themselves (a cover letter, a certificate, a photo).
const PERSON_REASONS = new Set(["no_confirmed_answer", "agreement_needs_you", "eeo_needs_your_choice", "no_decline_option",
  "no_matching_option", "ambiguous_option", "upload_needs_you", "no_resume"]);
// The engine's own failures to fill a field (named by ats-fill / parallel-apply): never a wall.
const ENGINE_FIELD = {
  upload_not_accepted: "upload_not_accepted", option_covered: "option_covered", fill_error: "field_fill_error",
  label_on_form_twice: "label_on_form_twice", form_rejects_value: "form_rejects_value", readback_mismatch: "readback_mismatch",
  place_not_offered: "place_not_offered", value_dropped_before_submit: "value_dropped",
};

// Did the posting's page say it is gone? Read from where the run stopped (DIAG url/title) or the load status.
function closedPosting(row) {
  const d = row.diag || {}, url = String(d.url || ""), title = String(d.title || "");
  if (/^page_load_(404|410)$/.test(String(row.error || row.field || ""))) return "page_load_" + RegExp.$1;
  if (/[?&](error=true|not_found=true)\b/.test(url)) return "board_says_not_found";
  if (/^(job not found|page not found|404|this job is no longer available)/i.test(title)) return "board_says_not_found";
  // The board sent the posting's link back to its own job list (BambooHR /careers, Breezy /): the posting is gone.
  try {
    const want = new URL(row.url), got = new URL(url);
    if (got.host === want.host && want.pathname.length > 1 && /^\/(careers\/?)?$/.test(got.pathname) && !d.inputs) return "redirected_to_job_list";
  } catch { /* no url */ }
  return null;
}

function classify(row) {
  const reason = String(row.reason || ""), handoff = row.handoff || null;
  const wallB = (wall) => (handoff && (handoff.link || handoff.card) && handoff.step && handoff.reason === wall
    ? { outcome: "b", cause: `${wall}_handed_off`, wall } : { outcome: "fail", cause: `${wall}_no_handoff`, wall });
  if (row.result === "pass") return { outcome: "a", cause: "reached_submit" };
  // The bench's simulated resume upload (strict.cjs SIMULATED_UPLOADS): every field filled, the upload answered inside the browser.
  if (row.result === "ready_except_upload") return { outcome: "a", cause: "reached_submit_upload_simulated" };
  if (/^BREACH/.test(reason)) return { outcome: "fail", cause: "breach" };
  const closed = closedPosting(row);
  if (closed) return { outcome: "fail", cause: `posting_closed:${closed}` };
  if (reason === "missing_required_answer" || reason === "field_not_filled") {
    const needs = Array.isArray(row.needs) ? row.needs : [];
    const engine = needs.find((n) => !PERSON_REASONS.has(n.reason));
    if (!needs.length) return { outcome: "fail", cause: `field_not_filled:${row.field || "unnamed"}` };
    if (engine) {
      if (/^step_did_not_advance/.test(engine.label || "")) return { outcome: "fail", cause: /resume is requir/i.test(engine.label) ? "upload_not_accepted" : "step_did_not_advance" };
      return { outcome: "fail", cause: ENGINE_FIELD[engine.reason] || `field:${engine.reason}` };
    }
    return wallB("person_answer");
  }
  if (reason === "bot_check") return wallB(row.wall === "check_in_form" ? "bot_check_in_form" : "bot_check");
  // An employee sign-in form beside the posting (Teamtailor's "Already working at X?") is not the person's wall: before D-072 the
  // runner called it login_required (wall employee_sign_in; the bench log of 43192269304 kept no wall, so a Teamtailor page whose only
  // form is that small sign-in form is read the same way). It is the application form not reached.
  if (reason === "login_required" && (row.wall === "employee_sign_in" || (!row.wall && row.provider === "teamtailor" && row.diag && row.diag.forms === 1 && row.diag.inputs <= 4)))
    return { outcome: "fail", cause: "form_not_found:employee_sign_in_only" };
  if (reason === "login_required") return wallB("login_required");
  if (reason === "posting_closed") return { outcome: "fail", cause: "posting_closed:board_says_not_found" };
  if (reason === "email_code") return wallB("email_code");
  if (reason === "retries_exhausted") {
    const e = String(row.error || row.field || "");
    if (e === "page_load_429" || /^429$/.test(String((row.diag || {}).title || ""))) return { outcome: "fail", cause: "rate_limited_429" };
    return { outcome: "fail", cause: `retries_exhausted:${e.replace(/:.*/, "").slice(0, 40) || "unknown"}` };
  }
  if (reason === "no_application_form_found") {
    const d = row.diag || {};
    if (/^429$/.test(String(d.title || ""))) return { outcome: "fail", cause: "rate_limited_429" };
    if (row.wall === "employee_sign_in_only") return { outcome: "fail", cause: "form_not_found:employee_sign_in_only" };
    if ((d.frames || []).some((f) => /greenhouse\.io\/embed\/job_app/.test(String(f)))) return { outcome: "fail", cause: "form_not_found:embedded_frame" };
    // D-072 (item 4, round 2): a Workday tenant that takes guest applications starts each one with a POST
    // (/wday/cxs/<tenant>/jobpostings/<posting>/jobapplications) and saves every answer as it is typed: the dry run blocks that POST,
    // so the page shows "Something went wrong" (capture of 2026-11-12). Not reachable in a dry run; named, never a pass.
    if (row.workday_start_blocked || [...(row.blocked || []), ...(d.blocked || [])].some((b) => /^POST \S+\/wday\/cxs\/[^/]+\/jobpostings\//.test(String(b)))) return { outcome: "fail", cause: "dry_run_blocks_send:workday_application_start" };
    if (/myworkday(jobs|site)?\.com/.test(String(row.url))) return { outcome: "fail", cause: "form_not_found:workday_apply_not_opened" };
    if ((d.apply || []).length) return { outcome: "fail", cause: "form_not_found:apply_control_not_opened" };
    if (!d.inputs && !d.forms) return { outcome: "fail", cause: "form_not_found:page_not_rendered" };
    return { outcome: "fail", cause: "form_not_found:no_submit_control" };
  }
  if (reason === "redirect_not_allowed") return { outcome: "fail", cause: "redirect_off_board" };
  if (reason === "host_unreachable") return { outcome: "fail", cause: "host_unreachable" };
  if (reason === "robots_disallowed") return { outcome: "fail", cause: "robots_disallowed" };
  if (reason === "strict_signin_form") return { outcome: "fail", cause: "employee_sign_in_form_submit" };
  return { outcome: "fail", cause: reason || "unknown" };
}

// The bench jobs' log lines (STRICT / DIAG / NEEDS, strict.cjs main) back into rows: what the report is built from when only the
// job logs are kept (the bench uploads no artifact before D-072). A DIAG or NEEDS line follows its STRICT line.
function parseLog(text, sample = "") {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "");
    if (line.startsWith("STRICT | ")) {
      const f = line.split(" | ");
      const reason = f[4], detail = f[5] || "";
      rows.push({ sample, provider: f[1], result: f[2], vm: (f[3] || "").replace(/^vm=/, ""), reason, field: detail || null,
        error: /^page_load_|^driver_error/.test(detail) ? detail : null, url: f[10], persona: (f[11] || "").replace(/^persona=/, ""),
        upload_simulated: Number((f[8] || "").replace(/\D/g, "")) || 0, needs: null, diag: null, handoff: null, wall: null });
    } else if (line.startsWith("DIAG | ") && rows.length) {
      try { const d = JSON.parse(line.slice(line.indexOf("{"))); rows[rows.length - 1].diag = d; if (d.check) rows[rows.length - 1].check = d.check; } catch { /* cut short */ }
    } else if (line.startsWith("NEEDS | ") && rows.length) {
      try { rows[rows.length - 1].needs = JSON.parse(line.slice(line.indexOf("["))); } catch { /* cut short */ }
    } else if (line.startsWith("HANDOFF | ") && rows.length) {
      try { const h = JSON.parse(line.slice(line.indexOf("{"))); rows[rows.length - 1].handoff = h; rows[rows.length - 1].wall = h.wall || null; } catch { /* cut short */ }
    }
  }
  return rows;
}

// The D-072 count for one sample: (a), (b), fail, by cause; and the bar (99% by exact integer count, D-056's reading).
function tally(rows) {
  const out = { n: rows.length, a: 0, b: 0, fail: 0, raw_pass: 0, causes: {} };
  for (const r of rows) {
    const c = classify(r);
    out[c.outcome]++;
    if (r.result === "pass") out.raw_pass++;
    const k = `${c.outcome}|${c.cause}`;
    out.causes[k] = (out.causes[k] || 0) + 1;
  }
  out.need = Math.ceil(0.99 * out.n);
  out.meets = out.a + out.b >= out.need;
  return out;
}

module.exports = { classify, parseLog, tally, closedPosting, PERSON_REASONS };
