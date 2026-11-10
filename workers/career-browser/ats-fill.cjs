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
    // Lever's location box keeps its result list ("No location found. Try entering a different location") inside the label.
    c.querySelectorAll("input,select,textarea,button,.filename,.default-label,svg,script,style,.dropdown-container,.dropdown-results,.dropdown-no-results,.dropdown-loading-results").forEach((x) => x.remove());
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
  // A choice's own option sits in a list item of its own (li.option inside the question's li.question, batch of 60: Breezy held
  // "section_..._question_0" for "Education"): the nearest enclosing item with exactly one heading is the question's.
  const itemHeading = (el) => {
    for (let li = el.closest("li"); li; li = li.parentElement && li.parentElement.closest("li")) {
      const hs = li.querySelectorAll("h3");
      if (hs.length === 1 && !hs[0].contains(el) && nodeText(hs[0])) return hs[0];
      if (hs.length > 1) return null;
    }
    return null;
  };
  const ownControls = (a) => [...a.querySelectorAll("input, select, textarea")].filter((x) => x.type !== "hidden" && shown(x)).length;
  // A box alone in its section under the section's own heading (Breezy's "Experience Summary" over the cSummary box), when the box
  // has no name of its own: that heading.
  const HEAD = "h1, h2, h3, h4, .section-header";
  const sectionHeading = (el) => {
    for (let a = el, i = 0; a && a.parentElement && i < 3 && ownControls(a.parentElement) === 1; a = a.parentElement, i++) {
      for (let c = a.previousElementSibling; c; c = c.previousElementSibling) if (c.matches(HEAD) && nodeText(c)) return c;
    }
    return null;
  };
  // A choice with no heading of its own (Breezy's veteran status: a list of boxes after the survey's paragraphs): the words just
  // before its list, after the nearest heading above them when there is one ("Veteran Status: Please check one of the boxes below").
  const wordsBefore = (el) => {
    const list = el.closest("ul, ol") || el.parentElement;
    for (let a = list, i = 0; a && i < 3; a = a.parentElement, i++) {
      let words = "", head = "";
      for (let c = a.previousElementSibling, k = 0; c && k < 8; c = c.previousElementSibling, k++) {
        if (c.querySelector("input, select, textarea") || !shown(c)) continue;
        const t = nodeText(c);
        if (!t) continue;
        if (c.matches(HEAD)) { head = t; break; }
        if (!words) words = t;
      }
      if (words || head) return clean(head && words && head !== words ? `${head}: ${words}` : head || words).slice(0, 200);
    }
    return "";
  };
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
    /\b(gender|race|ethnicity|hispanic|latino|veteran|disabilit(?:y|ies)|sexual orientation|transgender|lgbt\w*|protected)\b/i.test(label);
  const optLabel = (inp) => {
    if (inp.id) { const l = rootOf(inp).querySelector(`label[for="${CSS.escape(inp.id)}"]`); if (l) return nodeText(l); }
    const cl = inp.closest("label");
    if (cl) return nodeText(cl);
    const nx = inp.nextElementSibling || inp.parentElement;
    return nx ? nodeText(nx) : clean(inp.value);
  };

  const out = [];
  const seen = new Set();
  // A question keeps its number across passes (an element tagged in an earlier pass keeps its tag), and a new one gets a number
  // never used before on this page: a control the board removed or hid can never share a number with a live one (strict run
  // 42737911402: a field read as empty after a re-render).
  const tagOf = (el) => (el && el.hasAttribute("data-upmore-q") ? Number(el.getAttribute("data-upmore-q")) : null);
  let qn = 1 + deepAll(document, "[data-upmore-q]").reduce((m, e) => Math.max(m, Number(e.getAttribute("data-upmore-q")) || 0), -1);
  const push = (d, el) => { const t = tagOf(el); d.q = t !== null && !out.some((x) => x.q === t) ? t : qn++; out.push(d); return d.q; };
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
    // Drawn checkboxes in one role=group (Workable's "Permanent - Full-time / Remote / ..." with no fieldset or shared name) are one
    // question's options, not each an agreement (strict run 42777082059).
    const drawnGroup = drawnChoice && !el.closest("fieldset") ? el.closest("[role=group], [role=radiogroup]") : null;
    if (type === "radio" || (type === "checkbox" && (el.closest("fieldset") || drawnGroup || (el.name && rootOf(el).querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length > 1)))) {
      const fs = el.closest("fieldset") || drawnGroup;
      const mates = all.filter((x) => x.type === type && !seen.has(x) && (drawnGroup ? !x.closest("fieldset") && x.closest("[role=group], [role=radiogroup]") === fs : fs ? x.closest("fieldset") === fs : x.name === el.name));
      mates.forEach((x) => seen.add(x));
      const byId = (ids) => (ids || "").split(/\s+/).map((id) => id && (rootOf(el).getElementById ? rootOf(el).getElementById(id) : document.getElementById(id))).find((n) => n && nodeText(n));
      const group = el.closest("[role=radiogroup], [role=group]");
      const node = (fs && fs.querySelector("legend")) || (group && byId(group.getAttribute("aria-labelledby"))) || groupLabelNode(el) || itemHeading(el);
      const label = node ? nodeText(node) : (wordsBefore(el) || clean(el.name));
      const q = push({ kind: type === "radio" ? "radio" : "checkgroup", label, name: el.name || "", required: isReq(mates, node), eeo: eeoOf(el, label), options: mates.map((m, i) => ({ i, label: optLabel(m) })), ...(drawnChoice ? { drawn: true } : {}) }, mates[0]);
      mates.forEach((m, i) => { m.setAttribute("data-upmore-q", q); m.setAttribute("data-upmore-o", i); });
      // A drawn choice (Workable's role=radio option around its aria-hidden input) is chosen where the person chooses it: the
      // option's shown words (the first text element inside its role=radio option, else the option itself) carry the option tag
      // in place of the input, so the one choice step (fillChoice) clicks them where a person clicks; the input's state, or the
      // option's aria-checked, is read back (strict run 42773229260: a forced click on the 1px hidden input never changed it,
      // and a click on a <label> is retargeted onto that input).
      if (drawnChoice) mates.forEach((m, i) => { const w = m.closest("[role=radio], [role=checkbox]"); const txt = w && w.contains(m) ? [...w.querySelectorAll("*")].find((e) => e !== m && !e.contains(m) && e.children.length === 0 && squash(e.textContent)) : null; const t = txt || (w && w.contains(m) ? w : null); if (t) { t.setAttribute("data-upmore-q", q); t.setAttribute("data-upmore-o", i); m.removeAttribute("data-upmore-o"); m.setAttribute("data-upmore-io", i); } });
      continue;
    }
    seen.add(el);
    // The box's own name (aria-label, placeholder) comes before a section's heading; the heading before the bare field id.
    const own = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
    const node = labelNode(el) || (own ? null : sectionHeading(el));
    const label = node ? nodeText(node) : own || clean(el.name || "");
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
      // Greenhouse's job-boards form puts a "Country" dial-code picker inside the phone fieldset (fieldset.phone-input >
      // .phone-input__country); it is the phone's own country, not a second "Country" question.
      d = { ...base, kind: "combobox", ...(el.closest(".phone-input__country, fieldset.phone-input") ? { phoneCountry: true } : {}) };
    } else if (type === "checkbox") {
      d = { ...base, kind: "checkbox" };
    } else if (el.tagName === "TEXTAREA") {
      d = { ...base, kind: "textarea" };
    } else {
      d = { ...base, kind: "text", inputType: type };
      // Lever's "Current location": a text box whose value counts only once one of Lever's own places is picked from its list
      // (the pick fills the hidden selectedLocation beside it). A box without that list is typed into as any other.
      const li = el.closest("li, .application-question");
      if ((el.classList.contains("location-input") || el.name === "location") && li && li.querySelector(".dropdown-results")) d.place = true;
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
      case "radio": case "checkgroup": { const on = els.filter((e) => e.checked || (!("checked" in e) && e.getAttribute("aria-checked") === "true")); const picked = [...new Set(on.map((e) => e.getAttribute("data-upmore-o") ?? e.getAttribute("data-upmore-io")))]; return { q: d.q, filled: picked.length > 0, picked }; }
      case "buttons": { const on = els.filter((e) => e.getAttribute("aria-pressed") === "true"); return { q: d.q, filled: on.length > 0, picked: on.map((e) => e.getAttribute("data-upmore-o")) }; }
      case "checkbox": return { q: d.q, filled: !!el.checked, text: el.checked ? "checked" : "" };
      case "file": return { q: d.q, filled: !!(el.files && el.files.length), text: el.files && el.files[0] ? el.files[0].name : "" };
      case "combobox": {
        const w = el.closest(".select-shell, .select__container, .field-wrapper, [class*='combobox' i]") || el.parentElement;
        const v = w && w.querySelector(".select__single-value, [class*='single-value' i], [class*='singleValue' i], [data-combobox-value]");
        // Ashby's location autocomplete has no value chip: the place picked from its list is written into the box itself
        // (strict benchmark run 42719264485). Read from the box only there, and only once its list is closed.
        const ash = !v && el.classList.contains("ashby-application-form-input-autocomplete") && el.getAttribute("aria-expanded") !== "true";
        // Workable's dropdown is a read-only box that shows the chosen option as its own value (never typed into).
        const t = squash(v ? v.textContent : el.readOnly || ash ? el.value : "");
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
  // Greenhouse job-boards' own place lookup ("Location (City)"): the confirmed place, picked from its list (matchPlace).
  [/^location city$/, "location"],
  // One "Address" box (Breezy asks it on many forms) takes the person's confirmed full address; a street line takes the street.
  [/^(your )?(home |mailing |postal |residential )?address$/, "full_address"],
  [/^(your )?(residential )?street address$|^address line 1$/, "street_address"],
  // A "State" question takes the confirmed state ("Illinois" or "IL"); a select picks it by name or by its postal code (matchState).
  [/^(state|state province|state or province|state region|state of residence|province)$/, "state"],
  // Two eligibility questions a person confirms once, answered only on a Yes/No choice (CHOICE_FACTS), never typed: work
  // authorization only where the question names the United States, sponsorship only where it names no other country.
  [/^(are you )?(currently )?(legally )?(authori[sz]ed|eligible|permitted) to (legally )?work (lawfully )?in the (u s|us|usa|united states)( of america)?$/, "work_authorization"],
  [/^(will|do|would) you (currently |now )?((now )?(or|and) (will you )?(now |in the future |at any (point|time) in the future )|in the future )?(require|need) ((visa|employment|immigration|work) ){0,3}sponsorship( (for|to obtain|in order to obtain) (an )?((employment|work|h 1b) ){0,2}(visa|status|permit|visa status))?( (by|from) (our company|the company|us|this company))?( (to (legally )?work )?in the (u s|us|usa|united states)( of america)?)?( for (this|the) (role|position|job))?$/, "sponsorship"],
];
// Facts that answer only a Yes/No choice (radio, buttons, select, combobox): typed into a text box they would be another answer.
const CHOICE_FACTS = new Set(["work_authorization", "sponsorship"]);
const CHOICE_KINDS = ["radio", "buttons", "select", "combobox"];
// ROUND 3: the person's own contact facts never answer a question about someone else ("Phone number of your reference",
// "Email of the person who referred you"): the same rule as career_apply.ts SOMEONE_ELSE.
const SOMEONE_ELSE = /\breferr|\breferen|\bteam member|\breferee|\bemergency|\bmanager|\bsupervisor|\brecruiter|\bspouse|\bparent|\bguardian|\bemployee who/;
// A standard question asked as a sentence ("What's your phone number?", "Your Full Name", "Please enter your email": Ashby
// lets each employer word its system fields, strict benchmark run 42719264485) is the same question without its lead-in.
const ASKED_AS = /^(?:(?:what is|what s|whats|please (?:enter|provide|share|give us|tell us)|enter|provide) )?(?:your )?/;
function factKey(label) {
  const n = norm(label).replace(ASKED_AS, "");
  if (!n || SOMEONE_ELSE.test(n)) return undefined;
  for (const [re, key] of FACT_RULES) if (re.test(n)) return key;
  return undefined;
}
function factValue(label, facts) {
  const n = norm(label).replace(ASKED_AS, "");
  if (!n || SOMEONE_ELSE.test(n)) return undefined;
  for (const [re, key] of FACT_RULES) {
    if (!re.test(n)) continue;
    if (key === "full_name") return facts.full_name || (facts.first_name && facts.last_name ? `${facts.first_name} ${facts.last_name}` : undefined);
    // "City" alone asks for the city: the confirmed city when there is one, else the confirmed place as before.
    if (key === "location" && /^(current |your )?city$/.test(n) && !blank(facts.city)) return facts.city;
    // An eligibility fact is only ever a confirmed Yes or No.
    if (CHOICE_FACTS.has(key)) return /^(yes|no)$/i.test(String(facts[key] || "").trim()) ? (/^y/i.test(String(facts[key]).trim()) ? "Yes" : "No") : undefined;
    return facts[key];
  }
  return undefined;
}
function answerFor(label, answers) {
  const n = norm(label);
  for (const k of Object.keys(answers || {})) if (norm(k) === n) return answers[k];
  return undefined;
}
// Item 2 batch of 60 (run 42854228451): the apply VM carries the person's approved answers by the label they were confirmed
// under ("Email", "Phone", "Location", "Country") and no facts, so a form that words the same contact question its own way
// ("Email Address", "Phone Number", "Current location"; Breezy, Lever) re-asked what the person had already confirmed. An
// approved answer whose own label is one of the contact facts (factKey) is that confirmed fact: email only to an email question,
// phone only to a phone question, a place only to a location question, and so on, by the same FACT_RULES as a confirmed fact.
// Two approved answers that name one fact with different values name none. A fact the person confirmed outright wins.
// Nothing new is ever made up: "Address" is answered only from a confirmed address, never from the place.
function factsFrom(facts, answers) {
  const derived = {}, clash = new Set();
  for (const [k, v] of Object.entries(answers || {})) {
    if (blank(v)) continue;
    const key = factKey(k);
    if (!key) continue;
    if (derived[key] !== undefined && String(derived[key]).trim() !== String(v).trim()) clash.add(key);
    else derived[key] = String(v);
  }
  for (const k of clash) delete derived[k];
  const out = { ...derived };
  for (const [k, v] of Object.entries(facts || {})) if (!blank(v) || !(k in out)) out[k] = v;
  return out;
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
// a-sensitive (2026-11-10): the person's own "prefer not to say" (the whole answer, in its usual wordings) lands on the form's
// one way not to answer ("Decline to self-identify", "I do not want to answer"); two such options, or none: asked. The same
// rule as question_map.ts declineOption.
const DECLINE_ANSWER = /^(i )?(would |d )?(prefer not to (say|answer|disclose|specify|identify|self identify)|rather not (say|answer)|decline( to (answer|state|disclose|specify|self identify))?|do not wish to (answer|disclose|self identify)|don t wish to (answer|disclose)|choose not to (answer|disclose|identify|self identify)|do not want to answer|don t want to answer)$/;
const DECLINE_OPTION = /\bdecline\b|\bprefer not\b|\bdo(?: not|n t) wish\b|\bchoose not\b|\bnot to (?:answer|disclose|say|identify|specify|self identify)\b|\bi do(?: not|n t) want to (?:answer|disclose|identify|self)/;
function matchOption(labels, value) {
  const v = norm(value), ns = labels.map(norm);
  if (DECLINE_ANSWER.test(v) && !ns.includes(v)) {
    const ix = ns.map((l, i) => (DECLINE_OPTION.test(l) ? i : -1)).filter((i) => i >= 0);
    return ix.length === 1 ? { index: ix[0] } : { error: ix.length ? "ambiguous_option" : "no_matching_option" };
  }
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
const isPhone = (d, value) => (d.inputType === "tel" || /^(phone|mobile|telephone|cell|telefon|telefoon|handy|mobil)/.test(norm(d.label).replace(ASKED_AS, "")))
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
    // A drawn choice's tagged option (its shown words, see EXTRACT) is clicked as a person clicks it; check() would retarget
    // the click onto the hidden input, which such a board ignores. An option already chosen is not clicked again.
    if (d.kind !== "buttons" && !d.drawn) await loc.check({ force: true });
    else if (d.kind === "buttons" || !(await page.evaluate(STATE, [d]).then((x) => (x[0].picked || []).includes(String(i))).catch(() => false))) {
      if (d.drawn) {
        // The board may draw its own layer over the option's words (strict run 42780366348: a 20 s actionability wait). The
        // click goes to the point a person would click only when what is drawn there belongs to this same option; anything
        // else (a banner, a dialog, another control) is reported, never clicked.
        // Centred in the window, so a bar fixed to the page's top or bottom (a cookie notice) is not over it.
        await loc.evaluate((e) => e.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => {});
        const hit = await loc.evaluate((e) => { const r = e.getBoundingClientRect(), w = e.closest("[role=radio], [role=checkbox]"), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          // What is on top is this option's own (inside it, or the option's own box that holds no other option).
          const own = w && h && (w.contains(h) || (h.contains(w) && h.querySelectorAll("[role=radio], [role=checkbox]").length === 1 && !h.querySelector("button, a[href], select, textarea, input:not([type=radio]):not([type=checkbox])")));
          return !h ? "nothing" : own ? "own" : `${h.tagName.toLowerCase()}.${String(h.className || "").slice(0, 40)} ${h.contains(w) ? "around" : w && w.parentElement && w.parentElement.contains(h) ? "beside" : "elsewhere"} "${String(h.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40)}"`; }).catch(() => "unreadable");
        if (hit !== "own") return { ok: false, reason: "option_covered", detail: `drawn there: ${hit}` };
      }
      await loc.click(d.drawn ? { force: true, timeout: 5000 } : {});
    }
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
    // Every level of that block is marked: a board that re-renders the inner wrapper (job-boards.greenhouse.io swaps the
    // Attach button group for the file name) keeps the outer levels, and the chip is read from whichever is still there.
    let box = el && el.parentElement;
    for (let i = 0; box && i < 6; i++) {
      box.setAttribute("data-upmore-fbox", q);
      const up = box.parentElement;
      if (!up || up.querySelectorAll("[data-upmore-q]").length > 1 || up.querySelectorAll("input[type=file]").length > 1) break;
      box = up;
    }
  }, [d.q]).catch(() => {});
  await page.locator(sel(d.q)).first().setInputFiles(path);
  const name = require("node:path").basename(path);
  for (let i = 0; i < 20; i++) {
    const s = await stateOf(page, d);
    if (s.filled) return { ok: true };
    if (await page.evaluate(CHIP, [[d.q, name]]).then((x) => x[0]).catch(() => false)) return { ok: true };
    await page.waitForTimeout(200);
  }
  // What the upload's block shows now (the board's own words: an error, a chip with another name), for the record.
  const detail = await page.evaluate(([q, n]) => {
    const bs = [...document.querySelectorAll(`[data-upmore-fbox="${q}"]`)];
    const b = bs[0], el = document.querySelector(`[data-upmore-q="${q}"]`);
    return `id=${el ? el.id : ""} boxes=${bs.length} input=${el ? (el.files ? el.files.length : "?") : "gone"} name_on_page=${(document.body.innerText || "").includes(n)} shows=${String(b ? b.innerText : "").replace(/\s+/g, " ").trim().slice(0, 100)}`;
  }, [d.q, name]).catch((e) => `detail_error: ${String(e && e.message).split("\n")[0].slice(0, 80)}`);
  return { ok: false, reason: "upload_not_accepted", detail: `role=${d.role} required=${!!d.required} ${detail}` };
}
// Is the resume's file name shown in its upload block (any marked level still on the page)? One answer per [q, name] pair.
function CHIP(pairs) { return pairs.map(([q, n]) => [...document.querySelectorAll(`[data-upmore-fbox="${q}"]`)].some((b) => (b.innerText || "").includes(n))); }
// The phone widget's country picker (d.phoneCountry): the confirmed country, as the option's own name alone or followed only
// by a dial code that the approved phone number itself starts with ("United States +1" for "+1 312 555 0100"). One option or
// nothing: "Canada +1" is not "United States", and "United States +1" is not chosen for a "+44" number.
function phoneCountryMatch(labels, country, phone) {
  const c = norm(country), digits = String(phone || "").trim().startsWith("+") ? digitsOf(phone) : "";
  if (!c) return { error: "no_matching_option" };
  const ix = labels.map((l, i) => {
    const n = norm(l);
    if (n === c) return i;
    const m = new RegExp(`^${c.replace(/[^a-z0-9 ]/g, "")} (\\d{1,4})$`).exec(n);
    return m && digits && digits.startsWith(m[1]) && /\+\s?\d/.test(l) ? i : -1;
  }).filter((i) => i >= 0);
  return ix.length === 1 ? { index: ix[0] } : { error: ix.length > 1 ? "ambiguous_option" : "no_matching_option" };
}
// A place the person confirmed ("Chicago, IL") is one of the board's places only when the city is the same and the next part is
// the same region, by name or by its US postal code ("Chicago, Illinois, United States"). Exactly one such place, or none.
const US_STATES = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming" };
const US_CODE = Object.fromEntries(Object.entries(US_STATES).map(([k, v]) => [v, k]));
const isUS = (c) => { const n = norm(c); return n === "united states" || (COUNTRY_NAMES[0] || []).includes(n); };
// The same US state by name or by its postal code ("IL", "Illinois"); anything else is itself (normalised).
const region = (s) => { const n = norm(s); return US_STATES[n] || n; };
const isState = (x) => US_STATES[norm(x)] !== undefined || US_CODE[norm(x)] !== undefined;
// A confirmed place ("Chicago, IL") onto a board's places ("Chicago, Illinois, United States"). The option that is the place's
// own text wins. Else exactly one option whose city is the same and whose region is the same (word for word, or the same US
// state by name or postal code), and whose country, when the option names one, is the country: the place's own third part or
// the person's confirmed `country`. `country` "" means none is confirmed, so an option naming a country is refused (Ashby);
// `country` undefined (a caller with no country to check, Lever's list) accepts only the United States after a US state.
// Never another state, never a guess between two: "Chicago, Indiana" is not "Chicago, IL", "Paris, Ile-de-France, France" is
// not "Paris, TX", and "Chicago, Illinois, United States" beside "Chicago, IL, USA" is ambiguous.
function matchPlace(labels, value, country) {
  const exact = matchOption(labels, value);
  if (!exact.error) return exact;
  const want = String(value).split(",").map((x) => x.trim()).filter(Boolean);
  if (want.length < 2 || want.length > 3) return { error: "no_matching_option" };
  const wantCountry = want[2] || (country === undefined || country === null ? undefined : String(country).trim());
  const sameCountry = (c) => (wantCountry === undefined ? isUS(c) && isState(want[1]) : !!wantCountry && (norm(c) === norm(wantCountry) || countryNames(wantCountry).includes(norm(c))));
  const ix = labels.map((l, i) => {
    const got = String(l).split(",").map((x) => x.trim()).filter(Boolean);
    if (got.length < 2 || got.length > 3 || norm(got[0]) !== norm(want[0])) return -1;
    if (got.length === 3 && !sameCountry(got[2])) return -1;
    if (norm(got[1]) === norm(want[1])) return i;
    const usOk = (got.length < 3 || isUS(got[2])) && (!wantCountry || isUS(wantCountry));
    return usOk && isState(got[1]) && isState(want[1]) && region(got[1]) === region(want[1]) ? i : -1;
  }).filter((i) => i >= 0);
  // A lookup that lists the very same words twice (Greenhouse's "Chicago, Illinois, United States" twice, strict run
  // 42780366348) offers one answer: its first row. Two different texts stay the person's choice.
  if (ix.length > 1 && ix.every((j) => norm(labels[j]) === norm(labels[ix[0]]))) return { index: ix[0] };
  return ix.length === 1 ? { index: ix[0] } : { error: ix.length ? "ambiguous_option" : "no_matching_option" };
}
// A confirmed US state ("IL" or "Illinois") onto a state list: the option that is its own text first, else the one option that
// is the same state by name or postal code. Never another state, never a guess between two.
function matchState(labels, value) {
  const exact = matchOption(labels, value);
  if (!exact.error) return exact;
  const v = norm(value);
  if (!isState(v)) return { error: "no_matching_option" };
  const ix = labels.map((l, i) => (isState(l) && region(l) === region(v) ? i : -1)).filter((i) => i >= 0);
  return ix.length === 1 ? { index: ix[0] } : { error: ix.length ? "ambiguous_option" : "no_matching_option" };
}
async function fillPlace(page, d, value, country) {
  const input = page.locator(sel(d.q)).first();
  // Only this question's own result list (the .dropdown-results inside the question that holds the box).
  const opts = () => page.locator(`li:has(${sel(d.q)}) .dropdown-results > *:visible`);
  await input.fill("");
  await input.pressSequentially(String(value), { delay: 25 });
  let list = [];
  for (let i = 0; i < 30 && !list.length; i++) { await page.waitForTimeout(200); list = (await opts().allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean); }
  if (!list.length) return { ok: false, reason: "place_not_offered" };
  const m = matchPlace(list, value, country);
  if (m.error) return { ok: false, reason: m.error, options: list.slice(0, 12) };
  await pickOption(opts, m);
  const held = await page.evaluate(([q]) => {
    const el = document.querySelector(`[data-upmore-q="${q}"]`);
    const box = el && el.closest("li, .application-question");
    const h = box && box.querySelector("input[name='selectedLocation']");
    return { text: el ? el.value : "", picked: h ? h.value : "" };
  }, [d.q]);
  return norm(held.text) === norm(list[m.index]) && String(held.picked).trim() ? { ok: true, held: list[m.index] } : { ok: false, reason: "readback_mismatch" };
}
// The same country under the names boards list it by ("USA" for a confirmed "United States"). Only these spellings, and only
// when the confirmed name itself is not offered.
const COUNTRY_NAMES = [["united states", "united states of america", "usa", "us", "u s a", "u s"], ["united kingdom", "uk", "great britain"]];
const countryNames = (v) => (COUNTRY_NAMES.find((g) => g.includes(norm(v))) || []).filter((x) => x !== norm(v));

// The option a react-select menu marks as selected, read by opening the menu (ArrowDown opens it without choosing anything) and
// closing it again (Escape). Used where the box shows less than the option (Greenhouse's phone picker shows only "+1").
async function menuSelected(page, d, ctl0) {
  const input = page.locator(sel(d.q)).first();
  const shell = input.locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__container") or @data-combobox or contains(@class,"ashby-application-form-field-entry")][1]');
  await input.press("ArrowDown").catch(() => {});
  await page.waitForTimeout(120);
  const ctl = (await input.getAttribute("aria-controls").catch(() => null)) || ctl0;
  const loc = ctl ? page.locator(`[id="${ctl.replace(/"/g, "")}"] [role="option"][aria-selected="true"]`) : shell.locator('[role="option"][aria-selected="true"]');
  const held = (await loc.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  await input.press("Escape").catch(() => {});
  return held;
}
async function fillCombo(page, d, value, pick, phone, country) {
  const input = page.locator(sel(d.q)).first();
  // Only this dropdown's own options: its aria-controls list, else the options inside its own shell. A phone widget's country
  // list, or any other list on the page, is never searched for an answer.
  const ctl = (await input.getAttribute("aria-controls")) || (await input.getAttribute("aria-owns"));
  const shell = input.locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__container") or @data-combobox or contains(@class,"ashby-application-form-field-entry")][1]');
  // Ashby's place box draws its list in a floating layer outside the field (strict benchmark run 42739040932): only that
  // box's own result rows (Ashby's autocomplete class, under a listbox) are read, never any other list on the page.
  const ashPlaces = !ctl && (await input.evaluate((e) => e.classList.contains("ashby-application-form-input-autocomplete")).catch(() => false));
  const opts = () => (ctl ? page.locator(`[id="${ctl.replace(/"/g, "")}"] [role="option"]:visible`)
    : ashPlaces ? page.locator('[role="listbox"] [role="option"][class*="ashby-application-form-input-autocomplete-"]:visible')
    : shell.locator('[role="option"]:visible'));
  const optionsNow = async () => (await opts().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  await input.click();
  let list = await optionsNow();
  if (!list.length) { await page.waitForTimeout(120); list = await optionsNow(); }
  // A country picker lists every country: the confirmed name is typed so the site's own filter narrows it before matching.
  // Ashby's place box fills its list from a lookup as you type: it gets up to 3 seconds to show. Any other box, 150 ms.
  const lookup = ashPlaces || pick === "place" || (await input.evaluate((e) => e.classList.contains("ashby-application-form-input-autocomplete")).catch(() => false));
  if ((!list.length || d.phoneCountry) && pick !== "decline") { await input.fill(String(value).slice(0, 40)); list = []; for (let i = 0; i < (lookup ? 20 : 1) && !list.length; i++) { await page.waitForTimeout(150); list = await optionsNow(); } }
  if (!list.length) {
    // What the page drew as a list after typing, for the record (tags and classes only, cut short): never an answer.
    const seen = await page.evaluate(() => [...document.querySelectorAll("[role=listbox], [role=option], [class*='option' i], [class*='suggest' i], [class*='result' i], [class*='menu' i]")]
      .filter((e) => e.offsetWidth || e.offsetHeight).slice(0, 6).map((e) => `${e.tagName}.${String(e.className || "").slice(0, 60)}[role=${e.getAttribute("role") || ""}] n=${e.children.length}`).join(" ; ").slice(0, 400)).catch(() => "");
    await input.press("Escape").catch(() => {});
    return { ok: false, reason: "options_not_readable", ...(seen ? { detail: seen } : {}) };
  }
  const m = pick === "decline" ? (() => { const i = list.findIndex((o) => DECLINE.test(norm(o))); return i < 0 ? { error: "no_decline_option" } : { index: i }; })()
    : d.phoneCountry && pick === "phone_country" ? phoneCountryMatch(list, value, phone)
    : pick === "state" ? matchState(list, value)
    : (ashPlaces && pick === "value") || pick === "place" ? matchPlace(list, value, blank(country) ? "" : country)
    : pick === "country" ? (() => { const x = matchOption(list, value); if (!x.error) return x; const alt = countryNames(value).find((n) => !matchOption(list, n).error); return alt ? matchOption(list, alt) : x; })()
    : matchOption(list, value);
  if (m.error) { await input.press("Escape").catch(() => {}); return { ok: false, reason: m.error, options: list.slice(0, 40), ...(d.phoneCountry || pick === "phone_country" ? { detail: `options: ${list.slice(0, 6).join(" / ").slice(0, 140)}` } : {}) }; }
  await pickOption(opts, m);
  // A board that writes the pick into the box a moment later (Ashby's place box, strict run 42782536964: read back empty while
  // its list was still closing) is read again for up to 1.5 s before the pick counts as not held.
  let s = await stateOf(page, d);
  for (let k = 0; k < 10 && !s.filled; k++) { await page.waitForTimeout(150); s = await stateOf(page, d); }
  if (s.filled && norm(s.text) === norm(list[m.index])) return { ok: true };
  // The phone's country picker shows its choice in its own words ("United States" for the option "United States +1"): it
  // holds the approved country when that shown value is itself the confirmed country, alone or with the phone's dial code.
  if (s.filled && pick === "phone_country" && !phoneCountryMatch([s.text], value, phone).error) return { ok: true };
  // Greenhouse's phone picker shows only the dial code ("+1", which Canada shares): the choice is read back from the option
  // the reopened menu marks as selected, which must be the one picked; the menu is closed again without choosing anything.
  if (s.filled && pick === "phone_country") {
    const held = await menuSelected(page, d, ctl);
    const s2 = await stateOf(page, d);
    if (held.length === 1 && norm(held[0]) === norm(list[m.index]) && s2.filled && norm(s2.text) === norm(s.text)) return { ok: true };
    return { ok: false, reason: "readback_mismatch", detail: `picked: ${String(list[m.index]).slice(0, 60)} | shows: ${String(s.text || "").slice(0, 30)} | menu selected: ${held.join(" / ").slice(0, 60)}` };
  }
  return { ok: false, reason: "readback_mismatch", detail: `picked: ${String(list[m.index]).slice(0, 60)} | shows: ${String(s.text || "").slice(0, 60)}` };
}

// The phone widget's own country picker is counted apart from a "Country" question of the form (it is the phone's country).
const labelKey = (d) => (d.phoneCountry ? `phone country|${norm(d.label)}` : norm(d.label));
const labelCounts = (qs) => { const m = new Map(); for (const d of qs) if (d.kind !== "file") m.set(labelKey(d), (m.get(labelKey(d)) || 0) + 1); return m; };
// The one click on a list option: `opts` is always the question's own list (a combobox's aria-controls list or its shell; Lever's
// location results inside the question's own <li>), never another list on the page.
async function pickOption(opts, m) { await opts().nth(m.index).click(); }
// The kinds of question under each label, so a fact is held back only when two questions that could each take it share the
// label. Ashby puts its "Phone" label over the number box and over a Yes/No texting consent (strict benchmark run 42719264485:
// 5 of 20 postings stopped on label_on_form_twice); the consent can never hold the number, so the number box is not ambiguous.
const labelKinds = (qs) => { const m = new Map(); for (const d of qs) if (d.kind !== "file") { const k = labelKey(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d.kind); } return m; };
const takesFact = (kind, label) => CHOICE_FACTS.has(factKey(label)) ? CHOICE_KINDS.includes(kind) : ["text", "textarea", "select"].includes(kind) || (kind === "combobox" && /location|city|state/i.test(label));
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
  if (ctx.labelCount && (ctx.labelCount.get(labelKey(d)) || 0) > 1) {
    if (!blank(answerFor(d.label, answers))) return { status: "ask", reason: "label_on_form_twice" };
    const kinds = ctx.labelKinds && ctx.labelKinds.get(labelKey(d));
    if (!blank(factValue(d.label, facts || {})) && (!kinds || (takesFact(d.kind, d.label) && kinds.filter((k) => takesFact(k, d.label)).length > 1))) return { status: "ask", reason: "label_on_form_twice" };
  }
  // The phone's country picker takes the confirmed country (an approved "Country" answer, else the country fact), checked
  // against the approved phone's own dial code (fillCombo): its options are "United States +1", never the bare name, so the
  // answer is never matched against them as plain text (batch of 60: 14 of 15 Greenhouse postings held "Country").
  if (d.kind === "combobox" && d.phoneCountry) {
    const ac = answerFor(d.label, answers), c = !blank(ac) ? ac : facts && facts.country;
    if (!blank(c) && !blank(facts && facts.phone)) return { status: "fill", value: String(c), pick: "phone_country", source: !blank(ac) ? "answer" : "fact", soft: true };
    return d.required ? { status: "ask", reason: "no_confirmed_answer" } : { status: "skip", reason: "optional_left_blank" };
  }
  const a = answerFor(d.label, answers);
  if (!blank(a)) return { status: "fill", value: String(a), source: "answer" };
  if (d.eeo) {
    if (facts && facts.eeo_policy === "decline" && ["select", "combobox", "radio", "buttons"].includes(d.kind)) return { status: "fill", pick: "decline", source: "eeo_policy" };
    return d.required ? { status: "ask", reason: "eeo_needs_your_choice" } : { status: "skip", reason: "eeo_left_blank" };
  }
  // A Yes/No eligibility fact goes only onto a choice; any other fact into a box, a select, or a place/country combobox.
  const ck = factKey(d.label);
  const f = CHOICE_FACTS.has(ck) ? (CHOICE_KINDS.includes(d.kind) ? factValue(d.label, facts || {}) : undefined)
    : ["text", "textarea", "select"].includes(d.kind) ? factValue(d.label, facts || {}) : d.kind === "combobox" && /location|city|country|state/i.test(d.label) ? factValue(d.label, facts || {}) : undefined;
  // A country dropdown is tried with the confirmed country; when none of its options is exactly that country it goes back to
  // the person as an unanswered question (soft), the same as before it was tried.
  if (!blank(f)) return { status: "fill", value: String(f), source: "fact", ...(d.kind === "combobox" && /country/i.test(d.label) && !/location|city/i.test(d.label) ? { soft: true } : {}) };
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
  // A confirmed fact, or an approved answer to the same question, is picked by the same exact rules (a country by its name or
  // its other spellings, a place as the same city, state and country, a state by name or postal code).
  const semantic = dec.source === "fact" || dec.source === "answer";
  if (semantic && factKey(d.label) === "country" && ["select", "radio"].includes(d.kind)) {
    const labels = d.options.map((o) => o.label);
    if (matchOption(labels, v).error) { const alt = countryNames(v).find((x) => !matchOption(labels, x).error); if (alt) return d.kind === "select" ? fillSelect(page, d, labels[matchOption(labels, alt).index]) : fillChoice(page, d, labels[matchOption(labels, alt).index], false); }
  }
  if (d.place && semantic) return fillPlace(page, d, v, ctx.facts && ctx.facts.country);
  // A state select offers the state by name or by code: the exact option first, else the one option that is the same US state.
  if (semantic && factKey(d.label) === "state" && d.kind === "select") {
    const m = matchState(d.options.map((o) => o.label), v);
    if (m.error) return { ok: false, reason: m.error, options: d.options.map((o) => o.label) };
    return fillSelect(page, d, d.options[m.index].label);
  }
  switch (d.kind) {
    case "select": return fillSelect(page, d, v);
    case "radio": case "buttons": return fillChoice(page, d, v, false);
    case "checkgroup": return fillChoice(page, d, v, true);
    case "checkbox": return YES.test(norm(v)) || /^(checked|agree|i agree|accept)/.test(norm(v)) ? fillCheckbox(page, d) : { ok: false, reason: "not_agreed" };
    case "combobox": {
      const fk = semantic ? factKey(d.label) : undefined;
      const pick = dec.pick === "phone_country" ? "phone_country" : fk === "state" ? "state" : fk === "location" ? "place" : fk === "country" ? "country" : "value";
      return fillCombo(page, d, v, pick, ctx.facts && ctx.facts.phone, ctx.facts && ctx.facts.country);
    }
    default: return fillText(page, d, v);
  }
}

// ctx: { ats, facts, answers, resumePath }. Returns { map, filled, needsUser, failed, invalid }.
async function fillForm(page, ctx0) {
  const ctx = { facts: {}, answers: {}, ...ctx0 };
  ctx.facts = factsFrom(ctx.facts, ctx.answers);
  const map = [], filled = [], needsUser = [], failed = [];
  const handled = new Set();
  for (let pass = 0; pass < 3; pass++) {
    const qs = await page.evaluate(EXTRACT);
    ctx.labelCount = labelCounts(qs);
    ctx.labelKinds = labelKinds(qs);
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
      if (dec.status === "ask") { entry.status = "needs_user"; entry.reason = dec.reason; needsUser.push({ label: d.label, reason: dec.reason, kind: d.kind, ...(d.options ? { options: d.options.map((o) => o.label).slice(0, 40) } : {}) }); continue; }
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
      // A soft try (a country picker from the confirmed country) that did not take is the question still unanswered.
      if (dec.soft) { r = { ...r, detail: `fact_not_set: ${r.reason}${r.detail ? ` | ${r.detail}` : ""}`, reason: d.required ? "no_confirmed_answer" : r.reason, options: undefined }; if (!d.required) { entry.status = "skipped"; entry.reason = "optional_left_blank"; continue; } }
      // An optional demographic question with no way to decline is left blank: a blank is the decline (boxlunch, strict run 6).
      if (r.reason === "no_decline_option" && !d.required && d.eeo) { entry.status = "skipped"; entry.reason = "eeo_left_blank_no_decline_option"; continue; }
      const notOffered = (r.reason === "no_matching_option" || r.reason === "ambiguous_option");
      const ask = d.required || notOffered;
      entry.status = ask ? "needs_user" : "failed";
      entry.reason = r.reason;
      if (r.detail) entry.detail = r.detail;
      // A required question we could not set is handed back with the reason; the person is asked, nothing is guessed.
      (ask ? needsUser : failed).push({ label: d.label, reason: r.reason, kind: d.kind, ...(r.options ? { options: r.options } : {}), ...(r.detail ? { detail: r.detail } : {}) });
    }
  }
  // A value the board dropped after it was set and read back (React re-mounting the input after hydration: strict run
  // 42737911402, "First Name" and "E-mail" empty at the end) is set again once, from the same approved value, and read back.
  {
    const qsR = await page.evaluate(EXTRACT).catch(() => []);
    const stR = qsR.length ? await page.evaluate(STATE, qsR).catch(() => []) : [];
    for (const f of filled) {
      if (!["text", "textarea", "select"].includes(f.kind) || f.source === "resume") continue;
      const now = qsR.find((x) => x.label === f.d.label && x.kind === f.d.kind && x.name === f.d.name);
      const st = now && stR.find((x) => x.q === now.q);
      if (!now || !st || st.filled) continue;
      let r; try { r = await doFill(page, now, { status: "fill", value: f.value, source: f.source }, ctx); } catch (e) { r = { ok: false }; }
      if (r.ok) { f.d = now; f.refilled = true; }
    }
  }
  // Sweep: a required question still empty that we did not already account for is handed back, not ignored.
  const accounted = new Set([...needsUser, ...failed].map((x) => x.label));
  const qsNow = await page.evaluate(EXTRACT).catch(() => []);
  const states = qsNow.length ? await page.evaluate(STATE, qsNow) : [];
  for (const d of qsNow) {
    const s = states.find((x) => x.q === d.q);
    if (d.required && s && !s.filled && !accounted.has(d.label)) { needsUser.push({ label: d.label, reason: "still_empty_after_fill", kind: d.kind }); accounted.add(d.label); }
  }
  const invalid = await page.evaluate(INVALID).catch(() => []);
  return { map, filled, needsUser, failed, invalid };
}

// What each filled question holds right now, in the page's own words (a choice: its option labels), for a last look before the
// click. Read only.
async function heldNow(page, filled, { menus = true } = {}) {
  const ds = filled.map((f) => f.d);
  const st = ds.length ? await page.evaluate(STATE, ds) : [];
  // An upload whose input the board swapped for a chip (fillFile) is read from that chip: the resume's own name, or nothing.
  const chips = await page.evaluate(CHIP, filled.map((f) => [f.d.q, String(f.value)])).catch(() => []);
  const out = filled.map((f, i) => {
    const s = { ...(st[i] || {}) };
    // The board's own chip naming the resume's file stands for the upload once the board has swapped its input for it: the
    // upload is held (not gone). No chip and no input: gone.
    const chip = f.kind === "file" && !s.text && chips[i];
    if (chip) s.text = String(f.value);
    const held = s.picked ? s.picked.map((o) => ((f.d.options || [])[Number(o)] || {}).label) : s.text;
    return { label: f.label, kind: f.kind, source: f.source, approved: f.value, held: held === undefined ? null : held, gone: !!s.gone && !chip,
      ...(f.d.phoneCountry ? { phoneCountry: true } : {}), ...(f.d.place ? { place: true } : {}) };
  });
  // The phone's country picker shows only the dial code ("+1", which Canada shares): what it holds is the option its menu marks
  // as selected, read as fillCombo read it, and only while the box still shows what it showed then.
  for (const [i, f] of filled.entries()) {
    if (!menus || !f.d.phoneCountry || out[i].gone || !out[i].held) continue;
    const sel1 = await menuSelected(page, f.d).catch(() => []);
    const now = (await stateOf(page, f.d).catch(() => ({}))).text;
    if (sel1.length === 1 && norm(now) === norm(out[i].held)) out[i].held = sel1[0];
  }
  return out;
}
// The last look before the click (parallel-apply.cjs, every run, not only a dry run's audit): once the page has settled (its
// requests done, then a moment), every filled question must still hold something. A board that re-mounts its inputs after
// they were set (batch of 60, run on ag/batch60-fixes: two Personio forms held "Vorname", "Nachname", "E-Mail" empty at the
// instant before Submit, after the resume upload) gets each dropped value set once more from the same approved value and read
// back; a question still empty after that, or an upload no longer held, is returned by label: the run stops there, unsent.
async function recheckFilled(page, filled, ctx0, { settleMs = 300 } = {}) {
  const ctx = { facts: {}, answers: {}, ...ctx0 };
  ctx.facts = factsFrom(ctx.facts, ctx.answers);
  const settle = async () => { await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(settleMs); };
  const empty = (h) => h.gone || h.held === null || h.held === undefined || (Array.isArray(h.held) ? h.held.length === 0 : String(h.held).trim() === "");
  const dropped = async () => { const held = await heldNow(page, filled, { menus: false }); return filled.filter((f, i) => empty(held[i] || { gone: true })); };
  await settle();
  let lost = await dropped();
  if (!lost.length) return [];
  const qs = await page.evaluate(EXTRACT).catch(() => []);
  for (const f of lost) {
    if (!["text", "textarea", "select"].includes(f.kind)) continue;
    const now = qs.find((x) => x.label === f.d.label && x.kind === f.d.kind && x.name === f.d.name);
    if (!now) continue;
    let r; try { r = await doFill(page, now, { status: "fill", value: f.value, source: f.source }, ctx); } catch { r = { ok: false }; }
    if (r.ok) { f.d = now; f.refilled = true; }
  }
  await settle();
  lost = await dropped();
  return lost.map((f) => f.label);
}
// Does a field's one held value say the approved answer, by the same exact rule the fill chose it by? A country by its name or
// its listed other spellings, a place as the same city, state and country (matchPlace), a state by name or postal code, the
// phone's country picker as the country with the approved phone's own dial code. Anything else: only the same words.
function holdsApproved(f, want, facts = {}) {
  const h = Array.isArray(f.held) ? f.held : [f.held];
  if (h.length !== 1 || blank(h[0]) || blank(want)) return false;
  const held = String(h[0]);
  if (norm(held) === norm(want)) return true;
  if (f.phoneCountry) return !phoneCountryMatch([held], want, facts.phone).error;
  const key = factKey(f.label);
  if (key === "location" && f.place) return !matchPlace([held], want, facts.country).error;
  if (key === "location" && f.kind === "combobox") return !matchPlace([held], want, blank(facts.country) ? "" : facts.country).error;
  if (key === "country") return !matchOption([held], want).error || countryNames(want).some((n) => !matchOption([held], n).error);
  if (key === "state") return !matchState([held], want).error;
  return false;
}
module.exports = { heldNow, recheckFilled, holdsApproved, factsFrom, fillForm, matchOption, matchPlace, matchState, countryNames, phoneCountryMatch, factKey, factValue, answerFor, decide, labelCounts, labelKinds, norm, EXTRACT, STATE, DECLINE };
