/* The in-page functions the apply engine runs inside the employer's page, shared by every driver that reads a form:
   scripts/career/portal-browser-helper.cjs (Playwright serializes each one into the page) and the browser extension
   (extension/lib/trainee-core.js, bundled by extension/build.ts, runs them in its content script). Each is
   self-contained: no closure over this module and no Node, so the same text runs in both. Moved here unchanged from
   the helper (WO-031) so the extension reads a form exactly as the engine does. */
"use strict";
// A challenge is something the person must do: a visible challenge frame (reCAPTCHA bframe, hCaptcha frame=challenge),
// a visible checkbox widget not yet ticked, or an interstitial. An empty widget container and the invisible
// reCAPTCHA Enterprise badge are not challenges: every captured Greenhouse and Ashby form carries the badge and every
// Lever form an empty .h-captcha div (tests/fixtures/forms-ci), and counting those stopped real forms at open.
// Frame rule after Codex's WO-009b-3 (58e7b97d); checkbox and token rules added. On a local test page only, frames from
// a loopback http://127.x.x.x/captcha-provider/ stand in for the provider.
function fnDetectChallenge() {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && rect.width > 0 && rect.height > 0;
  };
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const solved = Array.from(
    document.querySelectorAll("[name='g-recaptcha-response'],[name='h-captcha-response'],[name='cf-turnstile-response']"),
  ).some((e) => String(e.value || "").length > 0);
  for (const frame of document.querySelectorAll("iframe[src]")) {
    let src;
    try {
      src = new URL(frame.getAttribute("src"), document.baseURI);
    } catch {
      continue;
    }
    const host = src.hostname.toLowerCase();
    const test = local && /^(127\.\d+\.\d+\.\d+|localhost)$/.test(host) && src.pathname.startsWith("/captcha-provider/");
    const hcaptcha = test || host === "hcaptcha.com" || host.endsWith(".hcaptcha.com");
    const recaptcha = test || ["google.com", "recaptcha.net"].some((domain) =>
      host === domain || host.endsWith("." + domain)
    );
    const turnstile = host === "challenges.cloudflare.com";
    const params = src.search + src.hash;
    const challenge = hcaptcha && /(?:^|[?#&])frame=challenge(?:[&#]|$)/.test(params) ||
      recaptcha && /\/recaptcha\/.*\/(?:bframe|challenge)\/?$/.test(src.pathname);
    const checkbox = !solved && (
      hcaptcha && /(?:^|[?#&])frame=checkbox(?:[&#]|$)/.test(params) ||
      recaptcha && /\/recaptcha\/.*\/anchor\/?$/.test(src.pathname) && !/[?&]size=invisible(?:&|$)/.test(src.search) ||
      turnstile
    );
    if ((challenge || checkbox) && visible(frame)) return "challenge";
  }
  if (visible(document.querySelector("#challenge-form"))) return "challenge";
  const txt = ((document.body && document.body.innerText) || "").slice(0, 4000);
  if (
    /verify you are human|are you a robot|unusual traffic|press and hold|checking your browser/i
      .test(txt)
  ) return "challenge";
  return null;
}
function fnCaptchaTech() {
  const srcs = Array.from(document.querySelectorAll("script[src], iframe[src]")).map((e) => e.src || "");
  const tech = [];
  if (srcs.some((s) => /recaptcha/.test(s))) tech.push("recaptcha");
  if (srcs.some((s) => /hcaptcha/.test(s))) tech.push("hcaptcha");
  if (srcs.some((s) => /turnstile|challenges\.cloudflare/.test(s))) tech.push("cloudflare-turnstile");
  if (document.querySelector(".g-recaptcha")) tech.push("recaptcha-widget");
  if (document.querySelector(".h-captcha")) tech.push("hcaptcha-widget");
  return tech;
}
function fnDiscoverFields(includeHidden) {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 300);
  // Layout-dependent innerText includes select options differently after
  // a section is hidden. The question itself must remain the same so
  // prior-page handles can be checked without relaxing meaning checks.
  const labelText = (node) => {
    const clone = node.cloneNode(true);
    for (const control of clone.querySelectorAll("input,select,textarea,button")) control.remove();
    return clone.textContent || "";
  };
  // WO-031 review: a label that belongs to another control (its `for` names another field, or it wraps another field)
  // never names this one: "<label for=a>Phone</label><input id=a><input aria-label='Referrer phone number'>" must not
  // give the referrer's field the person's "Phone". Members of the same radio or checkbox group are not "another".
  const sameGroup = (x, el) => x === el || (!!el.name && x.name === el.name && /^(radio|checkbox)$/i.test(x.type || ""));
  const realControl = (x) => x.type !== "hidden" && !(typeof x.className === "string" && /requiredInput/.test(x.className));
  function foreign(lab, el) {
    const f = lab.getAttribute && lab.getAttribute("for");
    if (f) {
      const target = document.getElementById(f);
      if (target && !sameGroup(target, el)) return true;
    }
    return Array.from(lab.querySelectorAll ? lab.querySelectorAll("input,select,textarea") : []).some((x) => realControl(x) && !sameGroup(x, el));
  }
  function labelFor(el) {
    let t = "";
    if (el.id) { const l = document.querySelector('label[for="' + esc(el.id) + '"]'); if (l) t = labelText(l); }
    if (!t) { const wrap = el.closest("label"); if (wrap && !foreign(wrap, el)) t = labelText(wrap); }
    // The element's own accessible name comes before any label found near it (WO-031 review).
    if (!t) {
      const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const named = ids.map((i) => document.getElementById(i)).filter(Boolean).map(labelText).join(" ");
      if (named.trim()) t = named;
    }
    if (!t && el.getAttribute("aria-label")) t = el.getAttribute("aria-label");
    if (!t) {
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement; if (!node) break;
        const labs = Array.from(node.querySelectorAll(":scope > label, :scope > .field-label, :scope > .label"));
        const lab = labs.find((x) => !x.contains(el) && !foreign(x, el));
        if (lab) { t = labelText(lab); break; }
      }
    }
    // WO-031: a file input's own label is often only its button ("Attach"); the upload group it sits in names the
    // document (Greenhouse job-boards: role=group aria-labelledby="upload-label-resume" -> "Resume/CV").
    if (!t || /^(attach|upload|browse|choose( a)? file|select( a)? file|add file)$/i.test(clean(t))) {
      const g = el.closest("[role=group][aria-labelledby]");
      const lab = g && document.getElementById(g.getAttribute("aria-labelledby"));
      if (lab && labelText(lab).trim()) t = labelText(lab);
    }
    return clean(t);
  }
  // Only a placeholder names it ("Type your response"): used when nothing else does.
  const weakLabelFor = (el) => clean(el.getAttribute("placeholder") || "");
  // A label that names one option of a group (it belongs to its own radio or checkbox) is never the question.
  function optionLabel(x) {
    const id = x.getAttribute && x.getAttribute("for");
    const t = id ? document.getElementById(id) : x.querySelector && x.querySelector("input");
    return !!t && /^(radio|checkbox)$/i.test(t.type || "");
  }
  function groupLabelFor(el) {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = Array.from(fs.querySelectorAll("legend, label")).find((x) => !x.contains(el) && !optionLabel(x) && !foreign(x, el) && labelText(x).trim().length > 0);
      if (lg) return labelText(lg);
    }
    let node = el;
    // Seven levels: a Lever checkbox list (Pronouns) sits seven deep under its question's heading (WO-031).
    for (let i = 0; i < 7 && node; i++) {
      node = node.parentElement; if (!node) break;
      const heads = Array.from(node.querySelectorAll(":scope > label, :scope > .application-label, :scope > .question, :scope > h4, :scope > .field-label"));
      const head = heads.find((x) => !x.contains(el) && !optionLabel(x) && !foreign(x, el) && labelText(x).trim().length > 0);
      if (head) return labelText(head);
    }
    // A group with no heading of its own (Ashby's SMS consent: "Check Yes or No to indicate your agreement to receive text
    // message updates..." in a block just before its two radios, each labelled by its own option): the text block right
    // before the group's container is its question, unless a control sits in it (then that text is another field's).
    // Only the block before the container of the WHOLE group counts (never text beside one choice's own label).
    if (/^(radio|checkbox)$/i.test(el.type || "") && el.name) {
      const sel = 'input[name="' + esc(el.name) + '"]', members = document.querySelectorAll(sel).length;
      node = el;
      for (let i = 0; i < 3 && node; i++) {
        node = node.parentElement; if (!node) break;
        if (Array.from(node.querySelectorAll("input")).some((x) => x.name !== el.name && realControl(x))) break;
        if (node.querySelectorAll(sel).length < members) continue;
        const prev = node.previousElementSibling;
        if (!prev) continue;
        if (prev.querySelector("input,select,textarea") || foreign(prev, el)) break;
        const t = labelText(prev).trim();
        if (t) return t;
      }
    }
    return "";
  }
  function selectorFor(el, idx) {
    if (el.id) return "#" + esc(el.id);
    if (el.name) {
      const base = el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\"') + '"]';
      // Depth-E (live Neighbor/Lever defect, 2026-10-16): radio and
      // checkbox inputs SHARE one name across the whole group by
      // design, so the bare name selector matches every option in the
      // group and strict handle resolution throws — the drive died in
      // discovery before a single field was classified. The value is
      // what distinguishes group members; qualify with it. A member
      // with no value keeps the index fallback.
      const t = (el.getAttribute("type") || "").toLowerCase();
      if ((t === "radio" || t === "checkbox") && el.getAttribute("value")) {
        return base + '[value="' + el.getAttribute("value").replace(/"/g, '\\"') + '"]';
      }
      return base;
    }
    return "upmore-idx-" + idx; // resolved by index fallback below
  }
  const els = Array.from(document.querySelectorAll("input, select, textarea"));
  const out = [];
  els.forEach((el, idx) => {
    const type = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button" || type === "image") return;
    // BUG-237 (ported at the v224 combine; live liontree census,
    // 2026-10-15): react-select keeps a hidden validation dummy (class
    // *-requiredInput, type text, CSS-invisible but with layout rects)
    // next to every widget. It is plumbing, never a fillable field —
    // discovered as one, it mints a phantom def for the widget's
    // question (the Degree widget gained a second, standard
    // education_degree def that the drive then tried to fill by name,
    // into an invisible input).
    if (typeof el.className === "string" && /requiredInput/.test(el.className)) return;
    const visible = type === "file" ? true : (el.offsetParent !== null || el.getClientRects().length > 0);
    if (!visible && !includeHidden) return;
    // A honeypot: a text box kept from people (aria-hidden, or out of the tab order) and placed off the page. A browser
    // gives it a box, so it read as a field and took the person's website or phone (round 2 of the apply scenarios,
    // 2026-10-30), which marks the application as a robot's. Never a field, never filled.
    if (/^(text|email|tel|url|search|number|textarea)$/.test(type) && (el.closest("[aria-hidden='true']") || el.getAttribute("tabindex") === "-1")) {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && (r.right <= 0 || r.bottom <= 0)) return;
    }
    // D9 (BUG-066): the card/group heading is carried for EVERY field,
    // not just radio/checkbox groups — a Lever custom card's text input
    // has no <label>, and its heading is the only human label there is.
    // WO-031: so that heading is the field's label when no label element names it (before a placeholder such as
    // "Type your response"); an option of a radio or checkbox group keeps its own label, the group's is groupLabel.
    const gl = clean(groupLabelFor(el));
    const member = type === "radio" || type === "checkbox";
    // A widget's own search box (type=search: the phone country picker's) keeps its own name, never its group's question.
    const label = labelFor(el) || (!member && type !== "search" && gl) || weakLabelFor(el);
    const f = {
      domIndex: idx, selector: selectorFor(el, idx), tag: el.tagName.toLowerCase(),
      disabled: !!el.disabled, readOnly: !!el.readOnly,
      valid: !el.validity || el.validity.valid, validationMessage: clean(el.validationMessage || ""),
      inputType: type, name: el.getAttribute("name") || "", id: el.id || "", label,
      cls: typeof el.className === "string" ? el.className.slice(0, 120) : "",
      required: !!el.required || el.getAttribute("aria-required") === "true" || /(\*|✱)\s*$/.test(label) || /required/i.test(el.getAttribute("aria-label") || "") ||
        !!el.closest("[role=group][aria-required='true']"),
    };
    if (gl) f.groupLabel = gl;
    // Ashby keys each question by its container's data-field-path and marks it required on the question title's class,
    // not on the input (tests/fixtures/forms-ci: the date picker has no name or id; required titles carry _required_).
    const entry = el.closest && el.closest("[data-field-path]");
    if (entry) {
      f.fieldPath = entry.getAttribute("data-field-path") || "";
      const title = entry.querySelector("label, [class*='question-title']");
      if (title && typeof title.className === "string" && /(^|[\s_-])required([\s_-]|$)/i.test(title.className)) {
        f.required = true;
      }
    }
    if (el.tagName === "SELECT") {
      f.options = Array.from(el.options).map((o) => ({ value: o.value, label: clean(o.textContent) }));
    }
    out.push(f);
  });
  return out;
}
// WO-053: the posting's own location text, as its page shows it: Greenhouse's job header (.job__location), Lever's posting
// categories (its apply page carries them too), Ashby's "Location" section, Workday's job locations, else a schema.org
// JobPosting's jobLocation, else the location part of a Workday job URL (/job/Chicago-IL/Title_R123). Read, never
// guessed: "" when the page shows none, and the planner then asks what depends on it.
function fnPostingLocation() {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const text = (el) => (el ? clean(el.textContent) : "");
  let t = text(document.querySelector(".job__location")) || text(document.querySelector("#header .location, .app-title + .location"));
  if (!t) t = text(document.querySelector(".posting-categories .location, .posting-category.location"));
  if (!t) {
    for (const h of document.querySelectorAll(".ashby-job-posting-left-pane h2")) {
      if (/^location$/i.test(clean(h.textContent))) { t = text(h.nextElementSibling); break; }
    }
  }
  if (!t) t = text(document.querySelector("[data-automation-id='locations'] dd")) || text(document.querySelector("[data-automation-id='locations']")).replace(/^locations?\s*/i, "");
  if (!t) {
    const places = [];
    for (const s of document.querySelectorAll("script[type='application/ld+json']")) {
      let j;
      try { j = JSON.parse(s.textContent || ""); } catch { continue; }
      for (const item of [].concat(j && j["@graph"] ? j["@graph"] : j)) {
        if (!item || !/JobPosting/.test(String(item["@type"]))) continue;
        for (const l of [].concat(item.jobLocation || [])) {
          const a = (l && l.address) || {};
          const country = typeof a.addressCountry === "object" ? a.addressCountry && a.addressCountry.name : a.addressCountry;
          const one = [a.addressLocality, a.addressRegion, country].map(clean).filter(Boolean).join(", ");
          if (one) places.push(one);
        }
        if (!places.length && /TELECOMMUTE/i.test(String(item.jobLocationType || ""))) places.push("Remote");
      }
    }
    t = [...new Set(places)].join("; ");
  }
  if (!t) {
    const m = /\/job\/([^/]+)\/[^/]+_[A-Za-z0-9-]+/.exec(location.pathname);
    if (m) {
      const words = decodeURIComponent(m[1]).split("-").filter(Boolean);
      const states = words.filter((w) => /^[A-Z]{2}$/.test(w) && w !== "US");
      const us = words.filter((w) => /^(US|USA)$/.test(w));
      const city = words.filter((w) => !states.includes(w) && !us.includes(w)).join(" ");
      t = [city, ...states, ...us].filter(Boolean).join(", ");
    }
  }
  // Lever ends its location with the separator before the commitment ("Atlanta, GA /").
  return t.replace(/\s*\/\s*$/, "").slice(0, 300);
}
module.exports = { fnDetectChallenge, fnCaptchaTech, fnDiscoverFields, fnPostingLocation };
