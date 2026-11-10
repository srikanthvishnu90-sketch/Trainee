"use strict";
// Form filling for Greenhouse, Lever, Ashby and SmartRecruiters application pages, shared by the apply VM worker (parallel-apply.cjs) and the
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
// R9 (2026-11-07), SmartRecruiters: its form is built from web components (spl-input, spl-select, spl-radio-group, ...) whose
// label and control live in each component's OPEN shadow root, where a label's `for` resolves only inside that root. The
// page side walks open shadow roots in document order (deepAll) and reads a label from the control's own root; Playwright's
// CSS locators pierce open shadow roots, so filling and read-back are the same code as for the other three. A closed
// shadow root is never forced open: its questions are not seen, and a required one shows as still empty (asked).

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[*✱]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// ---- page side: read every question, tag its controls with data-upmore-q / data-upmore-o --------------------------------
function EXTRACT() {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clean = (s) => squash(s).replace(/\(required\)/i, "").replace(/\s*[*✱]+\s*$/, "").replace(/\s*[*✱]+\s*$/, "").trim();
  const scope = document.querySelector("form") || document.body;
  // Every match under a root, in document order, descending into open shadow roots (SmartRecruiters' components).
  const deepAll = (root, sel) => { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); if (c.shadowRoot) walk(c.shadowRoot); walk(c); } }; walk(root); return out; };
  const rootOf = (el) => (el.getRootNode ? el.getRootNode() : document);
  const up = (a) => a.parentElement || (a.parentNode && a.parentNode.host) || null;
  const shown = (e) => e.type === "file" || !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const nodeText = (n) => {
    const c = n.cloneNode(true);
    c.querySelectorAll("input,select,textarea,button,.filename,.default-label,svg,script,style").forEach((x) => x.remove());
    return clean(c.textContent);
  };
  const LABEL_SEL = "legend, .application-label, .ashby-application-form-question-title, label.label, .select__label, .c-spl-form-field__label";
  const groupLabelNode = (el) => {
    for (let a = up(el), i = 0; a && i < 7; a = up(a), i++) {
      const n = a.querySelector(LABEL_SEL);
      if (n && !n.contains(el)) return n;
    }
    return null;
  };
  // Breezy asks each custom question in its own list item, the question in that item's one heading (strict benchmark run
  // 42735825405: "section_1760116069653_question_0" was all the runner could name).
  const itemHeading = (el) => { const li = el.closest("li"); if (!li) return null; const hs = li.querySelectorAll("h3"); return hs.length === 1 && !hs[0].contains(el) && nodeText(hs[0]) ? hs[0] : null; };
  const labelNode = (el) => {
    if (el.id) { const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && nodeText(l)) return l; }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { for (const id of lb.split(/\s+/)) { const n = rootOf(el).getElementById(id) || document.getElementById(id); if (n && nodeText(n)) return n; } }
    const cl = el.closest("label");
    if (cl && nodeText(cl)) return cl;
    const g = groupLabelNode(el);
    if (g) return g;
    return itemHeading(el);
  };
  const isReq = (els, node) => {
    if (els.some((e) => e.required || e.getAttribute("aria-required") === "true")) return true;
    // Workable's dropdown: the visible combobox carries no flag; the hidden input that holds its value in the same widget is required.
    if (els.some((e) => e.getAttribute("role") === "combobox" && e.closest("[data-ui]") && e.closest("[data-ui]").querySelector("input[required][aria-hidden='true']"))) return true;
    if (!node) return false;
    if (/[*✱]\s*$/.test(squash(node.textContent))) return true;
    return /required/i.test(node.className || "") || !!node.querySelector(".required, [class*='required' i]");
  };
  const eeoOf = (el, label) =>
    !!el.closest(".eeoc__container,[class*='eeo' i],#eeoc_fields,[data-qa*='eeo' i],[class*='demographic' i],[class*='voluntary' i],[class*='self-id' i]") ||
    /\b(gender|race|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|protected)\b/i.test(label);
  const optLabel = (inp) => {
    if (inp.id) { const l = rootOf(inp).querySelector(`label[for="${CSS.escape(inp.id)}"]`); if (l) return nodeText(l); }
    const cl = inp.closest("label");
    if (cl) return nodeText(cl);
    const nx = inp.nextElementSibling || inp.parentElement;
    return nx ? nodeText(nx) : clean(inp.value);
  };

  const out = [];
  const seen = new Set();
  // A control keeps the tag an earlier read gave it, and new ones are numbered after every tag on the page: a form shown in steps
  // (Breezy) is read once per step, and a question filled on step 1 must still be the one its tag names at the last look.
  let qn = 1 + Math.max(-1, ...deepAll(document, "[data-upmore-q]").map((e) => Number(e.getAttribute("data-upmore-q")) || 0));
  const push = (d, el) => { const had = el && el.getAttribute("data-upmore-q"); d.q = had !== null && had !== undefined && had !== "" ? Number(had) : qn++; out.push(d); return d.q; };
  const all = deepAll(scope, "input, select, textarea");

  // Yes/No button pairs (Ashby): the hidden checkbox inside them is not a question of its own.
  for (const box of scope.querySelectorAll(".ashby-application-form-input-yesno")) {
    const btns = [...box.querySelectorAll("button")];
    const node = groupLabelNode(box);
    const label = node ? nodeText(node) : "";
    const q = push({ kind: "buttons", label, required: isReq([], node), eeo: eeoOf(box, label), options: btns.map((b, i) => ({ i, label: squash(b.textContent) })) }, btns[0]);
    btns.forEach((b, i) => { b.setAttribute("data-upmore-q", q); b.setAttribute("data-upmore-o", i); });
    box.querySelectorAll("input").forEach((x) => seen.add(x));
  }

  for (const el of all) {
    if (seen.has(el)) continue;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
    if (type === "search" && !shown(el)) continue;
    if (!shown(el)) continue;
    // Workable draws each choice as a role=radio option around its own radio input, which it marks aria-hidden (strict benchmark
    // run 42735825405: every Yes/No question, e.g. "Are you authorized to work in the U.S.?"). That input is the question's control.
    const drawnChoice = (type === "radio" || type === "checkbox") && el.closest("[role=radio], [role=checkbox]") && el.closest("[role=radiogroup], [role=group], fieldset");
    if (el.closest("[aria-hidden='true'], [hidden]") && type !== "file" && !(drawnChoice && !el.closest("[role=radio], [role=checkbox]").closest("[aria-hidden='true'], [hidden]"))) continue;
    // A phone widget's country flag picker takes its dial code from the number typed; an "autofill from resume" drop zone is
    // the site's own shortcut, not a question. Neither is a question we fill.
    if (el.closest(".iti__country-container, .iti__flag-container, .iti__dropdown-content") || (el.getAttribute("role") === "combobox" && el.closest(".iti") && !el.classList.contains("iti__tel-input"))) continue;
    if (el.closest("[class*='autofill' i]")) continue;
    if (type === "radio" || (type === "checkbox" && (el.closest("fieldset") || (el.name && rootOf(el).querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length > 1)))) {
      const fs = el.closest("fieldset");
      const mates = all.filter((x) => x.type === type && !seen.has(x) && (fs ? x.closest("fieldset") === fs : x.name === el.name));
      mates.forEach((x) => seen.add(x));
      const byId = (ids) => (ids || "").split(/\s+/).map((id) => id && (rootOf(el).getElementById ? rootOf(el).getElementById(id) : document.getElementById(id))).find((n) => n && nodeText(n));
      const group = el.closest("[role=radiogroup], [role=group]");
      const node = (fs && fs.querySelector("legend")) || (group && byId(group.getAttribute("aria-labelledby"))) || groupLabelNode(el) || itemHeading(el);
      const label = node ? nodeText(node) : clean(el.name);
      const q = push({ kind: type === "radio" ? "radio" : "checkgroup", label, name: el.name || "", required: isReq(mates, node), eeo: eeoOf(el, label), options: mates.map((m, i) => ({ i, label: optLabel(m) })) }, mates[0]);
      mates.forEach((m, i) => { m.setAttribute("data-upmore-q", q); m.setAttribute("data-upmore-o", i); });
      continue;
    }
    seen.add(el);
    const node = labelNode(el);
    const label = node ? nodeText(node) : clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "");
    // A file box under a question's heading (Breezy: an optional attachment beside a required written answer) is required only
    // when it says so itself; the heading's star is the written answer's.
    const fromHeading = node && type === "file" && node === itemHeading(el);
    const base = { label, name: el.name || "", required: fromHeading ? isReq([el], null) : isReq([el], node), eeo: eeoOf(el, label) };
    let d;
    if (type === "file") {
      const hay = `${label} ${el.name} ${el.id}`;
      d = { ...base, kind: "file", accept: el.accept || "", role: /cover/i.test(hay) ? "cover" : /resume|\bcv\b|curriculum/i.test(hay) ? "resume" : "other" };
    } else if (el.tagName === "SELECT") {
      const opts = [...el.options].map((o, i) => ({ i, label: squash(o.textContent), value: o.value })).filter((o) => o.value !== "" && !/^\? .* \?$/.test(o.value) && !/^(please )?select\b|^choose\b|^--/i.test(o.label));
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
    const q = push(d, el);
    el.setAttribute("data-upmore-q", q);
  }
  return out;
}

// ---- page side: what each tagged question holds right now ------------------------------------------------------------
function STATE(qs) {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const deepAll = (root, sel) => { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); if (c.shadowRoot) walk(c.shadowRoot); walk(c); } }; walk(root); return out; };
  return qs.map((d) => {
    const els = deepAll(document, `[data-upmore-q="${d.q}"]`);
    const el = els[0];
    if (!el) return { q: d.q, filled: false, text: "", gone: true };
    switch (d.kind) {
      // AngularJS (Breezy) shows an unset model as its own "? undefined:undefined ?" option: nothing is chosen.
      case "select": { const o = el.options[el.selectedIndex]; const ph = !el.value || /^\? .* \?$/.test(el.value); return { q: d.q, filled: !ph, text: ph ? "" : squash(o && o.textContent) }; }
      case "radio": case "checkgroup": { const on = els.filter((e) => e.checked); return { q: d.q, filled: on.length > 0, picked: on.map((e) => e.getAttribute("data-upmore-o")) }; }
      case "buttons": { const on = els.filter((e) => e.getAttribute("aria-pressed") === "true"); return { q: d.q, filled: on.length > 0, picked: on.map((e) => e.getAttribute("data-upmore-o")) }; }
      case "checkbox": return { q: d.q, filled: !!el.checked, text: el.checked ? "checked" : "" };
      case "file": return { q: d.q, filled: !!(el.files && el.files.length), text: el.files && el.files[0] ? el.files[0].name : "" };
      case "combobox": {
        const w = el.closest(".select-shell, .select__container, .field-wrapper, [class*='combobox' i]") || el.parentElement;
        const v = w && w.querySelector(".select__single-value, [class*='single-value' i], [class*='singleValue' i], [data-combobox-value]");
        // Workable's dropdown is a read-only box that shows the chosen option as its own value (never typed into).
        const t = squash(v ? v.textContent : el.readOnly ? el.value : "");
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
  const deepAll = (root, sel) => { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); if (c.shadowRoot) walk(c.shadowRoot); walk(c); } }; walk(root); return out; };
  const groupTicked = (e) => e.type === "checkbox" && e.name && deepAll(document, `input[type="checkbox"]`).some((x) => x.name === e.name && x.checked);
  return deepAll(document, "input:invalid, select:invalid, textarea:invalid").filter((e) => !groupTicked(e)).filter((e) => e.type === "file" || e.offsetWidth || e.offsetHeight || e.getClientRects().length).map((e) => ({
    q: e.getAttribute("data-upmore-q"), name: e.name || e.id || "", message: squash(e.validationMessage).slice(0, 80),
  }));
}

// ---- answers ---------------------------------------------------------------------------------------------------------------
const FACT_RULES = [
  [/^first name\b|^given name\b|^vorname\b|^voornaam\b|^pr nom\b|^nombre$/, "first_name"],
  [/^last name\b|^surname\b|^family name\b|^nachname\b|^achternaam\b|^apellidos?\b|^nom de famille\b/, "last_name"],
  [/^preferred (first )?name\b/, "preferred_name"],
  [/^(full |legal |your )?name$|^full legal name\b/, "full_name"],
  // The same question in the languages the benchmark's boards ask it in (German, Dutch, Spanish, French, Portuguese, Swedish).
  [/^(vor und nachname|vollst ndiger name|volledige naam|nombre completo|nombre y apellidos?|nom complet|nome completo|fullst ndigt namn|namn)$/, "full_name"],
  [/^e ?mail\b|^(e ?mail adresse|e ?mail adres|correo electr nico|direcci n de correo electr nico|adresse e ?mail|adresse (de )?courriel|e ?post(adress)?)$/, "email"],
  // R9: SmartRecruiters (and others) ask for the address twice; the second box takes the same confirmed address.
  [/^(confirm|re ?enter|retype|repeat|verify) (your )?e ?mail( address)?$/, "email"],
  [/^(phone|mobile|telephone|cell)\b|^(telefon(nummer)?|telefoonnummer|tel fono|t l phone|handynummer|mobilnummer)$/, "phone"],
  [/^(country|country of residence|land|pays|pa s)$/, "country"],
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
const YES = /^(yes|y|true)$/; // an agreement checkbox only
const NO = /^(no|n|false)$/;
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
  // #340 (kept over round 3's yes-like rule): a "Yes" or a "No" is never an option that merely STARTS with it ("Yes, with
  // sponsorship", "No, I need work authorization"): those are other answers, so the question goes back to the person.
  // The option's own text with only a bracketed clarification after it ("Computer Science (BS)"); or an approved answer
  // that is the option followed by more of the person's words ("No, I do not need it" onto "No").
  if (v.length >= 2) { const r = one((l, i) => sameWithClarification(labels[i], value) || (l.length >= 2 && !/^(yes|no)$/.test(l) && v.startsWith(l + " ") && !QUALIFIED.test(v))); if (r) return r; }
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
  if (String(s.text).trim() === String(value).trim()) return { ok: true };
  if (isPhone(d, value) && await phoneSame(page, d, value, s.text)) return { ok: true };
  return { ok: false, reason: "readback_mismatch" };
}
// A phone box that reformats what is typed (Workable, intl-tel-input: "+1 312 555 0100" reads back as "(312) 555-0100" beside a
// "+1" country picker; strict benchmark run 42707036468, 12 Workable forms) holds the same number when its digits are the
// approved digits, or the approved digits less a dial code that the field's own country picker shows. Any other digit is a
// mismatch: nothing but the approved number is ever accepted.
const digitsOf = (v) => String(v || "").replace(/\D/g, "");
const isPhone = (d, value) => (d.inputType === "tel" || /^(phone|mobile|telephone|cell|telefon|telefoon|handy|mobil)/.test(norm(d.label)))
  && /^\+?[\d\s().\-\/]{6,}$/.test(String(value).trim());
async function phoneSame(page, d, value, text) {
  const want = digitsOf(value), got = digitsOf(text);
  if (!got) return false;
  if (got === want) return true;
  if (!String(value).trim().startsWith("+") || got.length >= want.length || !want.endsWith(got)) return false;
  const dial = want.slice(0, want.length - got.length);
  if (dial.length > 3) return false;
  const shown = await page.evaluate(([q]) => {
    const el = document.querySelector(`[data-upmore-q="${q}"]`);
    if (!el) return "";
    // The phone field's own shell: never one that holds another question (its country picker is not one of ours).
    let box = el.closest(".iti, [class*='phone' i]");
    if (!box || box.querySelectorAll("[data-upmore-q]").length > 1) box = el.parentElement;
    const bits = [];
    for (const n of (box ? [box, ...box.querySelectorAll("*")] : [])) {
      if (n === el || n.tagName === "OPTION") continue;
      if (n.matches && n.matches("ul, [role=listbox], .iti__country-list, .iti__dropdown-content")) continue;
      if (n.closest && n.closest("ul, [role=listbox], .iti__country-list, .iti__dropdown-content")) continue;
      bits.push(n.getAttribute("aria-label") || "", n.getAttribute("title") || "", n.children.length ? "" : n.textContent || "", n.tagName === "SELECT" ? (n.options[n.selectedIndex] || {}).textContent || "" : "");
    }
    return bits.join(" | ");
  }, [d.q]).catch(() => "");
  return new RegExp(`\\+\\s?${dial}(?!\\d)`).test(shown);
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
  // The upload's own block (the input's nearest ancestor that holds no other question), marked before the file is set: a board
  // that swaps the input for a chip naming the file once it has it (Greenhouse's "Attach": the input is replaced, strict
  // benchmark run 42712892939) is read back from that chip. Only the resume's own file name, in that block, counts.
  await page.evaluate(([q]) => {
    const el = document.querySelector(`[data-upmore-q="${q}"]`);
    let box = el && el.parentElement;
    for (let i = 0; box && i < 3; i++) {
      const up = box.parentElement;
      if (!up || up.querySelectorAll("[data-upmore-q]").length > 1 || up.querySelectorAll("input[type=file]").length > 1) break;
      box = up;
    }
    if (box) box.setAttribute("data-upmore-fbox", q);
  }, [d.q]).catch(() => {});
  await page.locator(sel(d.q)).first().setInputFiles(path);
  const name = require("node:path").basename(path);
  for (let i = 0; i < 8; i++) {
    const s = await stateOf(page, d);
    if (s.filled) return { ok: true };
    const chip = await page.evaluate(([q, n]) => {
      const b = document.querySelector(`[data-upmore-fbox="${q}"]`);
      return !!b && (b.innerText || "").includes(n);
    }, [d.q, name]).catch(() => false);
    if (chip) return { ok: true };
    await page.waitForTimeout(200);
  }
  return { ok: false, reason: "upload_not_accepted" };
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
        entry.status = "filled"; filled.push({ label: d.label, source: dec.source, kind: d.kind, value: dec.pick === "decline" ? "decline" : dec.source === "resume" ? require("node:path").basename(ctx.resumePath) : dec.value, d });
        // What a choice question now holds, in the form's own option words (never a typed answer's text).
        if (["select", "radio", "checkgroup", "buttons", "combobox"].includes(d.kind)) {
          const st = await stateOf(page, d);
          entry.selected = st.picked ? st.picked.map((i) => (d.options[Number(i)] || {}).label) : [st.text];
        }
        continue;
      }
      // #340: an approved answer or fact that is not exactly one of the page's options is handed back even when the question is
      // optional: leaving it out, or picking another option, would post something other than what was approved.
      const notOffered = (r.reason === "no_matching_option" || r.reason === "ambiguous_option");
      const ask = d.required || notOffered;
      entry.status = ask ? "needs_user" : "failed";
      entry.reason = r.reason;
      if (r.detail) entry.detail = r.detail;
      // A required question we could not set is handed back with the reason; the person is asked, nothing is guessed.
      (ask ? needsUser : failed).push({ label: d.label, reason: r.reason, ...(r.options ? { options: r.options } : {}) });
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

// What each filled question holds right now, in the page's own words (a choice: its option labels), for a last look before the
// click. Read only.
async function heldNow(page, filled) {
  const ds = filled.map((f) => f.d);
  const st = ds.length ? await page.evaluate(STATE, ds) : [];
  // An upload whose input the board swapped for a chip (fillFile) is read from that chip: the resume's own name, or nothing.
  const chips = await page.evaluate((qs) => qs.map(([q, n]) => { const b = document.querySelector(`[data-upmore-fbox="${q}"]`); return !!b && (b.innerText || "").includes(n); }),
    filled.map((f) => [f.d.q, String(f.value)])).catch(() => []);
  return filled.map((f, i) => {
    const s = { ...(st[i] || {}) };
    if (f.kind === "file" && !s.text && chips[i]) s.text = String(f.value);
    const held = s.picked ? s.picked.map((o) => ((f.d.options || [])[Number(o)] || {}).label) : s.text;
    return { label: f.label, kind: f.kind, source: f.source, approved: f.value, held: held === undefined ? null : held, gone: !!s.gone };
  });
}
module.exports = { heldNow, fillForm, matchOption, factValue, answerFor, decide, labelCounts, norm, EXTRACT, STATE, DECLINE };
