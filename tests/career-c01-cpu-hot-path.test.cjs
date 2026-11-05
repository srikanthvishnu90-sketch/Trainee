"use strict";
// C01 (beta 2026-11-04, HTTP 546 CPU Time exceeded): the hot path was the router re-parsing every posting of the 600-posting
// pool on every rank (123 parseJD -> skillsInText / skillQualifies / extractKnockouts), 121's statesInText compiling 102
// regexes a call, and 142's company-name lexicon (an O(n^2) dedupe and one regex per posting company per call). Each was made
// cheaper without changing what it returns. These tests hold the "without changing what it returns" half against the
// implementations they replaced (kept here verbatim as references); tests/architect/c01-cpu-budget-pg.test.ts holds the
// "cheaper" half through the real handler.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Tailor = require("../packages/domain/123-career-tailor.js");
const Jobs = require("../packages/domain/121-career-jobs.js");

// ---- the replaced implementations, verbatim
function skillsInTextRef(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9+#. ]/g, " ")} `;
  const found = [];
  for (const s of Tailor.SKILL_LEXICON) {
    const needle = ` ${s.toLowerCase()} `;
    if (t.includes(needle) || t.includes(` ${s.toLowerCase()},`) || t.includes(` ${s.toLowerCase()}.`)) if (!found.includes(s)) found.push(s);
  }
  return found;
}
const US_STATES_REF = [["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"], ["California", "CA"], ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"], ["District of Columbia", "DC"], ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"], ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"], ["Kentucky", "KY"], ["Louisiana", "LA"], ["Maine", "ME"], ["Maryland", "MD"], ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"], ["Mississippi", "MS"], ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"], ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"], ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"], ["Oregon", "OR"], ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"], ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"], ["Vermont", "VT"], ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"], ["Wisconsin", "WI"], ["Wyoming", "WY"]];

// ---- inputs: real posting texts on file, plus seeded noise built from the lexicon, punctuation and dotted words
function corpus() {
  const out = [];
  const roots = [path.join(__dirname, "../packages/career-data"), path.join(__dirname, "fixtures")];
  const walk = (d, depth) => { if (depth > 4 || !fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (/\.(json|txt|md)$/.test(f) && st.size < 2e6) out.push(fs.readFileSync(p, "utf8")); } };
  for (const r of roots) walk(r, 0);
  const texts = [];
  for (const raw of out) {
    for (const m of raw.matchAll(/"(?:jd_text|description|text_excerpt|text)"\s*:\s*"((?:[^"\\]|\\.){40,})"/g)) { try { texts.push(JSON.parse(`"${m[1]}"`)); } catch { /* not a JSON string */ } }
    if (!raw.trimStart().startsWith("{") && !raw.trimStart().startsWith("[")) texts.push(raw.slice(0, 6000));
  }
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const bits = [...Tailor.SKILL_LEXICON, ...Tailor.SKILL_LEXICON.map((s) => s.toUpperCase()), "node.js", "c++.", "go.", "r.", ".net", "a/b", "ci/cd", "spring,", "x.y.z", "Python.Pandas", "excel.", "sql;", "(sql)", "aws/gcp", "\n", "\t", "  ", ",", ".", "-", "going", "governance", "spark innovation", "Chicago, IL", "Remote", "Texas", "District of Columbia"];
  for (let i = 0; i < 3000; i++) { const n = 1 + rnd(25); const w = []; for (let k = 0; k < n; k++) w.push(bits[rnd(bits.length)]); texts.push(w.join(rnd(3) ? " " : "")); }
  return texts;
}
const TEXTS = corpus();

test("C01 skillsInText: the word lookup finds exactly what the three substring scans found, on real postings and seeded noise", () => {
  assert.ok(TEXTS.length > 3000, `inputs: ${TEXTS.length}`);
  for (const t of TEXTS) {
    assert.deepEqual(Tailor.skillsInText(t), skillsInTextRef(t), JSON.stringify(t).slice(0, 300));
    // sentences too, the memoized length
    for (const sent of String(t).split(/(?<=[.;])\s+/).slice(0, 20)) assert.deepEqual(Tailor.skillsInText(sent), skillsInTextRef(sent), sent.slice(0, 200));
  }
});

test("C01 skillsInText: each caller gets its own array (the memo cannot be changed through a result)", () => {
  const a = Tailor.skillsInText("Python and SQL required.");
  a.push("Invented");
  assert.deepEqual(Tailor.skillsInText("Python and SQL required."), ["Python", "SQL"]);
});

test("C01 parseJD: the memoized parse equals a fresh one, and a caller's edits never reach the next caller", () => {
  for (const t of TEXTS.slice(0, 400)) {
    Tailor.resetParseMemos();
    const fresh = Tailor.parseJD(t);
    const again = Tailor.parseJD(t);
    assert.deepEqual(again, fresh);
    fresh.mustHaveSkills.push("Invented"); fresh.niceToHaveSkills.push("Invented"); fresh.keywords.push("invented");
    for (const k of fresh.knockouts) k.requirement = "invented";
    fresh.knockouts.push({ type: "license" });
    const third = Tailor.parseJD(t);
    assert.deepEqual(third, again);
    assert.ok(!third.mustHaveSkills.includes("Invented") && !third.knockouts.some((k) => k.requirement === "invented"));
  }
});

test("C01 parseJD: the memo is bounded, and parseMemoStats counts the texts parsed since the reset", () => {
  Tailor.resetParseMemos();
  for (let i = 0; i < 2600; i++) Tailor.parseJD(`Requirements: ${i} years of SQL.`);
  const st = Tailor.parseMemoStats();
  assert.equal(st.parsed, 2600);
  assert.ok(st.held <= 2000, `held ${st.held}`);
  Tailor.parseJD("Requirements: 2599 years of SQL.");
  assert.equal(Tailor.parseMemoStats().parsed, 2600, "a held text is not parsed again");
});

test("C01 extractKnockouts: the literal-word gates change no knockout", () => {
  const extra = ["Active RN license required.", "Must hold a valid CPA licence.", "Real estate licensure is required.", "Requirements: Medical Assistant Certification",
    "BLS certificate required.", "Minimum of 3 years experience.", "5+ years of SQL experience.", "2-4 years of relevant experience.", "At least 2 Years of hands-on Experience.",
    "JD from an accredited law school.", "Bachelor's degree is required."];
  for (const t of [...TEXTS.slice(0, 1500), ...extra]) {
    // Reference: the same function with the gates lifted (every pattern run on every sentence).
    const ref = [];
    for (const sent of String(t || "").split(/(?<=[.;])\s+/).map((x) => x.trim()).filter(Boolean)) {
      const sl = sent.toLowerCase();
      const lic = sl.match(/([a-z][a-z&' -]{0,44}?)\s(licen[cs]e|licensure)\b/);
      if (lic && /(active|unrestricted|current|valid|must|required|hold|maintain|possess|eligib|requirements?\s*:)/.test(sl)) ref.push("license");
      const cert = sl.match(/([a-z][a-z&' -]{0,44}?)\s(certification|certificate)\b/);
      if (cert && /(requirements?\s*:|required|must (hold|have|possess|maintain|be)|certification\s*$|certification\s+\d)/.test(sl) && !/degree|bachelor|master/.test(sl)) ref.push("certification");
      if (/\bjd\b/.test(sl) && /(law school|juris|from a|degree)/.test(sl)) ref.push("degree");
      else if (/\bdegree\b/.test(sl) && /(required|must (hold|have|possess)|is required)/.test(sl) && !/(graduating|pursuing|currently enrolled|rising (senior|junior|sophomore))/.test(sl)) ref.push("degree");
      const ym = sl.match(/(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d+)(?:\s*[-–]\s*\d+)?\s*\+?\s*years?\b[^.;]{0,40}?experience/) || sl.match(/(\d+)\s*\+\s*years?\s+of\s+[^.;]{0,90}?experience/) || sl.match(/(\d+)\s*[-–]\s*\d+\s*years?\s+of\s+[^.;]{0,60}?experience/);
      if (ym) ref.push(`min_experience:${ym[1]}`);
    }
    const got = Tailor.extractKnockouts(t).map((k) => k.type === "min_experience" ? `min_experience:${k.min_years}` : k.type);
    assert.deepEqual(got, ref, String(t).slice(0, 200));
  }
});

test("C01 statesInText (through profileResidence): the compiled-once patterns find exactly what the per-call patterns found", () => {
  const ref = (text) => { const found = [], seen = new Set(); const t = ` ${String(text ?? "")} `; for (const [name, abbr] of US_STATES_REF) if (new RegExp(`\\b${name}\\b`, "i").test(t) || new RegExp(`,\\s*${abbr}\\b`).test(t)) { if (!seen.has(abbr)) { seen.add(abbr); found.push({ name, abbr }); } } return found; };
  for (const t of [...TEXTS.slice(0, 1500), "Chicago, IL", "Austin,TX or remote in new york", "Colorado residents only", "Washington, DC", "west virginia"]) {
    // statesInText is internal; profileResidence is its exported reader (the primary segment, else the whole text).
    const primary = String(t).split(/[(—;]/)[0], ps = ref(primary);
    assert.deepEqual(Jobs.profileResidence({ residence: t }).states, ps.length ? ps : ref(t), String(t).slice(0, 200));
  }
  // Called twice on the same text: no regex state carried between calls.
  assert.deepEqual(Jobs.profileResidence({ residence: "Chicago, IL" }), Jobs.profileResidence({ residence: "Chicago, IL" }));
});
