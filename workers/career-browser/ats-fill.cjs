"use strict";
// Form filling for Greenhouse, Lever and Ashby application pages, shared by the apply VM worker (parallel-apply.cjs) and the
// dry-run harness (dry-run.cjs). It reads the page's own questions (label, kind, required, options), answers each one only from
// the person's confirmed facts / answers, verifies every fill by reading it back, and NEVER guesses:
//  - a required question with no confirmed answer is returned in needsUser (the person is asked), never filled with a default;
//  - an optional question with no answer stays blank;
//  - EEO / self-identification questions are answered only from an explicit answer or from facts.eeo_policy === "decline"
//    (the person's own recorded choice, hash-bound with the facts); otherwise optional ones stay blank and required ones ask;
//  - agreements / consents (a lone checkbox) are accepted only from an explicit "yes" answer;
//  - only the question labelled as the resume gets the resume file; a cover letter or other upload is never given it;
//  - nothing here clicks Submit, solves a verification check, or types a password.
// The returned `map` lists every question seen, with its decision and outcome (labels and sources only, never values).

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[*✱]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// ---- page side: read every question, tag its controls with data-upmore-q / data-upmore-o --------------------------------
function EXTRACT() {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clean = (s) => squash(s).replace(/\(required\)/i, "").replace(/\s*[*✱]+\s*$/, "").replace(/\s*[*✱]+\s*$/, "").trim();
  const scope = document.querySelector("form") || document.body;
  const shown = (e) => e.type === "file" || !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const nodeText = (n) => {
    const c = n.cloneNode(true);
    c.querySelectorAll("input,select,textarea,button,.filename,.default-label,svg,script,style").forEach((x) => x.remove());
    return clean(c.textContent);
  };
  const LABEL_SEL = "legend, .application-label, .ashby-application-form-question-title, label.label, .select__label";
  const groupLabelNode = (el) => {
    for (let a = el.parentElement, i = 0; a && i < 7; a = a.parentElement, i++) {
      const n = a.querySelector(LABEL_SEL);
      if (n && !n.contains(el)) return n;
    }
    return null;
  };
  const labelNode = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && nodeText(l)) return l; }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { for (const id of lb.split(/\s+/)) { const n = document.getElementById(id); if (n && nodeText(n)) return n; } }
    const cl = el.closest("label");
    if (cl && nodeText(cl)) return cl;
    const g = groupLabelNode(el);
    if (g) return g;
    return null;
  };
  const isReq = (els, node) => {
    if (els.some((e) => e.required || e.getAttribute("aria-required") === "true")) return true;
    if (!node) return false;
    if (/[*✱]\s*$/.test(squash(node.textContent))) return true;
    return /required/i.test(node.className || "") || !!node.querySelector(".required, [class*='required' i]");
  };
  const eeoOf = (el, label) =>
    !!el.closest(".eeoc__container,[class*='eeo' i],#eeoc_fields,[data-qa*='eeo' i],[class*='demographic' i],[class*='voluntary' i],[class*='self-id' i]") ||
    /\b(gender|race|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|protected)\b/i.test(label);
  const optLabel = (inp) => {
    if (inp.id) { const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`); if (l) return nodeText(l); }
    const cl = inp.closest("label");
    if (cl) return nodeText(cl);
    const nx = inp.nextElementSibling || inp.parentElement;
    return nx ? nodeText(nx) : clean(inp.value);
  };

  const out = [];
  const seen = new Set();
  let qn = 0;
  const push = (d) => { d.q = qn++; out.push(d); return d.q; };
  const all = [...scope.querySelectorAll("input, select, textarea")];

  // Yes/No button pairs (Ashby): the hidden checkbox inside them is not a question of its own.
  for (const box of scope.querySelectorAll(".ashby-application-form-input-yesno")) {
    const btns = [...box.querySelectorAll("button")];
    const node = groupLabelNode(box);
    const label = node ? nodeText(node) : "";
    const q = push({ kind: "buttons", label, required: isReq([], node), eeo: eeoOf(box, label), options: btns.map((b, i) => ({ i, label: squash(b.textContent) })) });
    btns.forEach((b, i) => { b.setAttribute("data-upmore-q", q); b.setAttribute("data-upmore-o", i); });
    box.querySelectorAll("input").forEach((x) => seen.add(x));
  }

  for (const el of all) {
    if (seen.has(el)) continue;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
    if (type === "search" && !shown(el)) continue;
    if (!shown(el)) continue;
    if (el.closest("[aria-hidden='true'], [hidden]") && type !== "file") continue;
    // A phone widget's country flag picker takes its dial code from the number typed; an "autofill from resume" drop zone is
    // the site's own shortcut, not a question. Neither is a question we fill.
    if (el.closest(".iti__country-container, .iti__flag-container, .iti__dropdown-content") || (el.getAttribute("role") === "combobox" && el.closest(".iti") && !el.classList.contains("iti__tel-input"))) continue;
    if (el.closest("[class*='autofill' i]")) continue;
    if (type === "radio" || (type === "checkbox" && (el.closest("fieldset") || (el.name && scope.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length > 1)))) {
      const fs = el.closest("fieldset");
      const mates = all.filter((x) => x.type === type && !seen.has(x) && (fs ? x.closest("fieldset") === fs : x.name === el.name));
      mates.forEach((x) => seen.add(x));
      const node = (fs && fs.querySelector("legend")) || groupLabelNode(el);
      const label = node ? nodeText(node) : clean(el.name);
      const q = push({ kind: type === "radio" ? "radio" : "checkgroup", label, name: el.name || "", required: isReq(mates, node), eeo: eeoOf(el, label), options: mates.map((m, i) => ({ i, label: optLabel(m) })) });
      mates.forEach((m, i) => { m.setAttribute("data-upmore-q", q); m.setAttribute("data-upmore-o", i); });
      continue;
    }
    seen.add(el);
    const node = labelNode(el);
    const label = node ? nodeText(node) : clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "");
    const base = { label, name: el.name || "", required: isReq([el], node), eeo: eeoOf(el, label) };
    let d;
    if (type === "file") {
      const hay = `${label} ${el.name} ${el.id}`;
      d = { ...base, kind: "file", accept: el.accept || "", role: /cover/i.test(hay) ? "cover" : /resume|\bcv\b|curriculum/i.test(hay) ? "resume" : "other" };
    } else if (el.tagName === "SELECT") {
      const opts = [...el.options].map((o, i) => ({ i, label: squash(o.textContent), value: o.value })).filter((o) => o.value !== "" && !/^(please )?select\b|^choose\b|^--/i.test(o.label));
      d = { ...base, kind: "select", options: opts };
    } else if (el.getAttribute("role") === "combobox") {
      d = { ...base, kind: "combobox" };
    } else if (type === "checkbox") {
      d = { ...base, kind: "checkbox" };
    } else if (el.tagName === "TEXTAREA") {
      d = { ...base, kind: "textarea" };
    } else {
      d = { ...base, kind: "text", inputType: type };
    }
    const q = push(d);
    el.setAttribute("data-upmore-q", q);
  }
  return out;
}

// ---- page side: what each tagged question holds right now ------------------------------------------------------------
function STATE(qs) {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  return qs.map((d) => {
    const els = [...document.querySelectorAll(`[data-upmore-q="${d.q}"]`)];
    const el = els[0];
    if (!el) return { q: d.q, filled: false, text: "", gone: true };
    switch (d.kind) {
      case "select": { const o = el.options[el.selectedIndex]; const ph = !el.value; return { q: d.q, filled: !ph, text: ph ? "" : squash(o && o.textContent) }; }
      case "radio": case "checkgroup": { const on = els.filter((e) => e.checked); return { q: d.q, filled: on.length > 0, picked: on.map((e) => e.getAttribute("data-upmore-o")) }; }
      case "buttons": { const on = els.filter((e) => e.getAttribute("aria-pressed") === "true"); return { q: d.q, filled: on.length > 0, picked: on.map((e) => e.getAttribute("data-upmore-o")) }; }
      case "checkbox": return { q: d.q, filled: !!el.checked, text: el.checked ? "checked" : "" };
      case "file": return { q: d.q, filled: !!(el.files && el.files.length), text: el.files && el.files[0] ? el.files[0].name : "" };
      case "combobox": {
        const w = el.closest(".select-shell, .select__container, .field-wrapper, [class*='combobox' i]") || el.parentElement;
        const v = w && w.querySelector(".select__single-value, [class*='single-value' i], [class*='singleValue' i], [data-combobox-value]");
        const t = squash(v ? v.textContent : "");
        return { q: d.q, filled: !!t, text: t };
      }
      default: return { q: d.q, filled: String(el.value || "").trim() !== "", text: String(el.value || "") };
    }
  });
}

// Fields the form itself says are invalid right now (native constraint validation; nothing is submitted to learn this).
function INVALID() {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  // A required checkbox group is "at least one" in the site's own script; the browser marks each box invalid. One ticked is enough.
  const groupTicked = (e) => e.type === "checkbox" && e.name && [...document.querySelectorAll(`input[type="checkbox"]`)].some((x) => x.name === e.name && x.checked);
  return [...document.querySelectorAll("input:invalid, select:invalid, textarea:invalid")].filter((e) => !groupTicked(e)).filter((e) => e.type === "file" || e.offsetWidth || e.offsetHeight || e.getClientRects().length).map((e) => ({
    q: e.getAttribute("data-upmore-q"), name: e.name || e.id || "", message: squash(e.validationMessage).slice(0, 80),
  }));
}

// ---- answers ---------------------------------------------------------------------------------------------------------------
const FACT_RULES = [
  [/^first name\b|^given name\b/, "first_name"],
  [/^last name\b|^surname\b|^family name\b/, "last_name"],
  [/^preferred (first )?name\b/, "preferred_name"],
  [/^(full |legal |your )?name$|^full legal name\b/, "full_name"],
  [/^e ?mail\b/, "email"],
  [/^(phone|mobile|telephone|cell)\b/, "phone"],
  [/^(current )?(company|employer|organi[sz]ation)\b/, "current_company"],
  [/^(current )?(job )?title\b/, "current_title"],
  [/linkedin/, "linkedin_url"], [/github/, "github_url"],
  [/^(portfolio|website|personal (site|website)|your website)\b/, "website_url"],
  [/^(current |your )?(location|city)( of residence)?$|^where are you (currently )?(located|based)$/, "location"],
];
// ROUND 3: the person's own contact facts never answer a question about someone else ("Phone number of your reference",
// "Email of the person who referred you"): the same rule as career_apply.ts SOMEONE_ELSE.
const SOMEONE_ELSE = /\breferr|\breferen|\bteam member|\breferee|\bemergency|\bmanager|\bsupervisor|\brecruiter|\bspouse|\bparent|\bguardian|\bemployee who/;
function factValue(label, facts) {
  const n = norm(label);
  if (SOMEONE_ELSE.test(n)) return undefined;
  for (const [re, key] of FACT_RULES) {
    if (!re.test(n)) continue;
    if (key === "full_name") return facts.full_name || (facts.first_name && facts.last_name ? `${facts.first_name} ${facts.last_name}` : undefined);
    return facts[key];
  }
  return undefined;
}
function answerFor(label, answers) {
  const n = norm(label);
  for (const k of Object.keys(answers || {})) if (norm(k) === n) return answers[k];
  return undefined;
}
const DECLINE = /decline|prefer not|do(?: not|n t) wish|choose not|not to (?:answer|disclose|say|identify|specify)|i do(?: not|n t) want/;
const YES = /^(yes|y|true)$/, NO = /^(no|n|false)$/;
const blank = (v) => v === undefined || v === null || String(v).trim() === "";

// Pick the option an answer means. One clear match or an error: no_matching_option / ambiguous_option. Never "closest".
// ROUND 3 (2026-11-02): an option that only contains the approved answer among other words is another answer ("Java" is not
// "JavaScript", "Male" not "Female", "Secret" not "Top Secret", "Master" not "Master of Business Administration", "United
// States" not "United States Minor Outlying Islands"), and a yes or a no with a qualifier of its own ("No, but I will
// require sponsorship in the future") says more than the approved "No". The approved answer goes on an option only as its
// whole text, a yes or no option with no qualifier, or the option's text followed only by a bracketed clarification.
const QUALIFIED = /\b(but|however|although|except|unless|in the future)\b/;
const lowRaw = (s) => String(s == null ? "" : s).toLowerCase().replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim();
function sameWithClarification(raw, value) {
  const words = norm(value).split(" ").filter(Boolean);
  if (!words.length) return false;
  const m = new RegExp(`^[^a-z0-9]*${words.join("[^a-z0-9]+")}(?![a-z0-9])`).exec(lowRaw(raw));
  if (!m) return false;
  const rest = lowRaw(raw).slice(m[0].length).trim();
  // A bracket that qualifies the answer ("Secret (interim)", "Bachelor's (in progress)") makes it another answer.
  if (/\b(interim|in progress|pending|expired|inactive|lapsed|former|previous|previously|incomplete|expected|pursuing|current|currently|not|non|no|partial|provisional|temporary)\b/.test(rest)) return false;
  return rest === "" || /^\([^()]*\)$/.test(rest);
}
function matchOption(labels, value) {
  const v = norm(value), ns = labels.map(norm);
  const one = (pred) => { const ix = ns.map((l, i) => (pred(l, i) ? i : -1)).filter((i) => i >= 0); return ix.length === 1 ? { index: ix[0] } : ix.length > 1 ? { error: "ambiguous_option" } : null; };
  const exact = ns.map((l, i) => (l === v ? i : -1)).filter((i) => i >= 0);
  if (exact.length === 1) return { index: exact[0] };
  if (YES.test(v)) { const r = one((l) => /^yes\b/.test(l) && !QUALIFIED.test(l)); if (r) return r; }
  if (NO.test(v)) { const r = one((l) => /^no\b/.test(l) && !QUALIFIED.test(l)); if (r) return r; }
  // The option's own text with only a bracketed clarification after it ("Computer Science (BS)"); or an approved answer
  // that is the option followed by more of the person's words ("No, I do not need it" onto "No").
  if (v.length >= 2) { const r = one((l, i) => sameWithClarification(labels[i], value) || (l.length >= 2 && v.startsWith(l + " ") && !QUALIFIED.test(l))); if (r) return r; }
  return { error: exact.length > 1 ? "ambiguous_option" : "no_matching_option" };
}

// ---- fill one question, verifying by read-back ----------------------------------------------------------------------------
const sel = (q, o) => `[data-upmore-q="${q}"]${o === undefined ? "" : `[data-upmore-o="${o}"]`}`;
async function stateOf(page, d) { return (await page.evaluate(STATE, [d]))[0]; }

async function fillText(page, d, value) {
  // A number box takes a number: an answer that is not one is handed back, not typed as something else.
  if (d.inputType === "number" && !Number.isFinite(Number(String(value).trim()))) return { ok: false, reason: "answer_not_a_number" };
  await page.locator(sel(d.q)).first().fill(String(value));
  const s = await stateOf(page, d);
  return String(s.text).trim() === String(value).trim() ? { ok: true } : { ok: false, reason: "readback_mismatch" };
}
async function fillSelect(page, d, value) {
  const m = matchOption(d.options.map((o) => o.label), value);
  if (m.error) return { ok: false, reason: m.error, options: d.options.map((o) => o.label) };
  const o = d.options[m.index];
  await page.locator(sel(d.q)).first().selectOption({ value: o.value });
  const s = await stateOf(page, d);
  return s.filled && norm(s.text) === norm(o.label) ? { ok: true } : { ok: false, reason: "readback_mismatch" };
}
async function fillChoice(page, d, value, multi) {
  const labels = d.options.map((o) => o.label);
  // A multi-select answer lists its choices ("Python; Go"): each is matched on its own, unless the whole text is one option's label.
  const whole = matchOption(labels, value);
  const parts = multi && /[;,]/.test(String(value)) && (whole.error || !labels.some((l) => norm(l) === norm(value))) ? String(value).split(/\s*[;,]\s*/).filter(Boolean) : [value];
  const idx = [];
  for (const p of parts) {
    const m = matchOption(labels, p);
    if (m.error) return { ok: false, reason: m.error, options: labels };
    idx.push(m.index);
  }
  for (const i of idx) {
    const loc = page.locator(sel(d.q, i)).first();
    if (d.kind === "buttons") await loc.click();
    else await loc.check({ force: true });
  }
  const s = await stateOf(page, d);
  const want = idx.map(String).sort().join(","), got = (s.picked || []).slice().sort().join(",");
  return got === want ? { ok: true } : { ok: false, reason: "readback_mismatch" };
}
async function fillCheckbox(page, d) {
  await page.locator(sel(d.q)).first().check({ force: true });
  return (await stateOf(page, d)).filled ? { ok: true } : { ok: false, reason: "readback_mismatch" };
}
async function fillFile(page, d, path) {
  await page.locator(sel(d.q)).first().setInputFiles(path);
  return (await stateOf(page, d)).filled ? { ok: true } : { ok: false, reason: "upload_not_accepted" };
}
async function fillCombo(page, d, value, pick) {
  const input = page.locator(sel(d.q)).first();
  // Only this dropdown's own options: its aria-controls list, else the options inside its own shell. A phone widget's country
  // list, or any other list on the page, is never searched for an answer.
  const ctl = await input.getAttribute("aria-controls");
  const shell = input.locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__container") or @data-combobox][1]');
  const opts = () => (ctl ? page.locator(`[id="${ctl.replace(/"/g, "")}"] [role="option"]:visible`) : shell.locator('[role="option"]:visible'));
  const optionsNow = async () => (await opts().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  await input.click();
  let list = await optionsNow();
  if (!list.length) { await page.waitForTimeout(120); list = await optionsNow(); }
  if (!list.length && pick !== "decline") { await input.fill(String(value).slice(0, 40)); await page.waitForTimeout(150); list = await optionsNow(); }
  if (!list.length) { await input.press("Escape").catch(() => {}); return { ok: false, reason: "options_not_readable" }; }
  const m = pick === "decline" ? (() => { const i = list.findIndex((o) => DECLINE.test(norm(o))); return i < 0 ? { error: "no_decline_option" } : { index: i }; })() : matchOption(list, value);
  if (m.error) { await input.press("Escape").catch(() => {}); return { ok: false, reason: m.error, options: list.slice(0, 40) }; }
  await opts().nth(m.index).click();
  const s = await stateOf(page, d);
  return s.filled && norm(s.text) === norm(list[m.index]) ? { ok: true } : { ok: false, reason: "readback_mismatch" };
}

const labelCounts = (qs) => { const m = new Map(); for (const d of qs) if (d.kind !== "file") m.set(norm(d.label), (m.get(norm(d.label)) || 0) + 1); return m; };
// Decide what to do with one question. status: fill | ask | skip. Never invents a value.
function decide(d, ctx) {
  const { facts, answers, resumePath } = ctx;
  if (d.kind === "file") {
    if (d.role === "resume" && resumePath) return { status: "fill", source: "resume" };
    if (d.required) return { status: "ask", reason: d.role === "resume" ? "no_resume" : "upload_needs_you" };
    return { status: "skip", reason: "optional_upload_left_empty" };
  }
  // ROUND 3: one label on two questions of this form (a second "Phone" in a references block): the approved answer belongs
  // to at most one of them, so neither is filled from it; the person is asked (as the extension's planForm does).
  if (ctx.labelCount && (ctx.labelCount.get(norm(d.label)) || 0) > 1 && (!blank(answerFor(d.label, answers)) || !blank(factValue(d.label, facts || {})))) return { status: "ask", reason: "label_on_form_twice" };
  const a = answerFor(d.label, answers);
  if (!blank(a)) return { status: "fill", value: String(a), source: "answer" };
  if (d.eeo) {
    if (facts && facts.eeo_policy === "decline" && ["select", "combobox", "radio", "buttons"].includes(d.kind)) return { status: "fill", pick: "decline", source: "eeo_policy" };
    return d.required ? { status: "ask", reason: "eeo_needs_your_choice" } : { status: "skip", reason: "eeo_left_blank" };
  }
  const f = ["text", "textarea", "select"].includes(d.kind) ? factValue(d.label, facts || {}) : d.kind === "combobox" && /location|city/i.test(d.label) ? factValue(d.label, facts || {}) : undefined;
  if (!blank(f)) return { status: "fill", value: String(f), source: "fact" };
  if (d.kind === "checkbox") return d.required ? { status: "ask", reason: "agreement_needs_you" } : { status: "skip", reason: "optional_left_unchecked" };
  return d.required ? { status: "ask", reason: "no_confirmed_answer" } : { status: "skip", reason: "optional_left_blank" };
}

async function doFill(page, d, dec, ctx) {
  if (d.kind === "file") return fillFile(page, d, ctx.resumePath);
  if (dec.pick === "decline") {
    if (d.kind === "combobox") return fillCombo(page, d, "", "decline");
    const labels = d.options.map((o) => o.label);
    const ix = labels.findIndex((l) => DECLINE.test(norm(l)));
    if (ix < 0) return { ok: false, reason: "no_decline_option", options: labels };
    return d.kind === "select" ? fillSelect(page, d, labels[ix]) : fillChoice(page, d, labels[ix], false);
  }
  const v = dec.value;
  switch (d.kind) {
    case "select": return fillSelect(page, d, v);
    case "radio": case "buttons": return fillChoice(page, d, v, false);
    case "checkgroup": return fillChoice(page, d, v, true);
    case "checkbox": return YES.test(norm(v)) || /^(checked|agree|i agree|accept)/.test(norm(v)) ? fillCheckbox(page, d) : { ok: false, reason: "not_agreed" };
    case "combobox": return fillCombo(page, d, v, "value");
    default: return fillText(page, d, v);
  }
}

// ctx: { ats, facts, answers, resumePath }. Returns { map, filled, needsUser, failed, invalid }.
async function fillForm(page, ctx0) {
  const ctx = { facts: {}, answers: {}, ...ctx0 };
  const map = [], filled = [], needsUser = [], failed = [];
  const handled = new Set();
  for (let pass = 0; pass < 3; pass++) {
    const qs = await page.evaluate(EXTRACT);
    ctx.labelCount = labelCounts(qs);
    const fresh = qs.filter((d) => !handled.has(`${d.label}|${d.kind}|${d.name}`));
    if (!fresh.length) break;
    for (const d of fresh) {
      handled.add(`${d.label}|${d.kind}|${d.name}`);
      const entry = { label: d.label, kind: d.kind, required: !!d.required, eeo: !!d.eeo, options: d.options ? d.options.length : undefined };
      map.push(entry);
      const before = (await page.evaluate(STATE, [d]))[0];
      const dec = decide(d, ctx);
      entry.source = dec.source;
      if (before.filled && d.kind !== "file" && dec.status !== "fill") { entry.status = "prefilled"; continue; }
      if (dec.status === "skip") { entry.status = "skipped"; entry.reason = dec.reason; continue; }
      if (dec.status === "ask") { entry.status = "needs_user"; entry.reason = dec.reason; needsUser.push({ label: d.label, reason: dec.reason, ...(d.options ? { options: d.options.map((o) => o.label).slice(0, 40) } : {}) }); continue; }
      let r;
      try { r = await doFill(page, d, dec, ctx); } catch (e) { r = { ok: false, reason: "fill_error", detail: String(e.message).split("\n")[0].slice(0, 120) }; }
      if (r.ok) {
        entry.status = "filled"; filled.push({ label: d.label, source: dec.source, kind: d.kind });
        // What a choice question now holds, in the form's own option words (never a typed answer's text).
        if (["select", "radio", "checkgroup", "buttons", "combobox"].includes(d.kind)) {
          const st = await stateOf(page, d);
          entry.selected = st.picked ? st.picked.map((i) => (d.options[Number(i)] || {}).label) : [st.text];
        }
        continue;
      }
      entry.status = d.required ? "needs_user" : "failed";
      entry.reason = r.reason;
      if (r.detail) entry.detail = r.detail;
      // A required question we could not set is handed back with the reason; the person is asked, nothing is guessed.
      (d.required ? needsUser : failed).push({ label: d.label, reason: r.reason, ...(r.options ? { options: r.options } : {}) });
    }
  }
  // Sweep: a required question still empty that we did not already account for is handed back, not ignored.
  const accounted = new Set([...needsUser, ...failed].map((x) => x.label));
  const qsNow = await page.evaluate(EXTRACT).catch(() => []);
  const states = qsNow.length ? await page.evaluate(STATE, qsNow) : [];
  for (const d of qsNow) {
    const s = states.find((x) => x.q === d.q);
    if (d.required && s && !s.filled && !accounted.has(d.label)) { needsUser.push({ label: d.label, reason: "still_empty_after_fill" }); accounted.add(d.label); }
  }
  const invalid = await page.evaluate(INVALID).catch(() => []);
  return { map, filled, needsUser, failed, invalid };
}

module.exports = { fillForm, matchOption, factValue, answerFor, decide, labelCounts, norm, EXTRACT, STATE, DECLINE };
