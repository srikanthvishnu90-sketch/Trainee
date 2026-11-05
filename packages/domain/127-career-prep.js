/* Career interview prep (PREP-001..008; starter pack section 3.5).
   Pure domain module, UMD like the other domain modules. NO network, NO invented facts:
   every company claim comes from a merged Company Intelligence Record (CIR) in
   packages/career-data/cirs/ and keeps its source label (official / reported / anecdotal).
   If no CIR is on file for a company, functions say so (status NO_CIR) and ground only in
   JD text the caller supplies — they never fabricate stages, bars, comp or selectivity.

   OWNER RULING (binding, 2026-10-12): live interview assist is OFF. liveAssistGuard()
   refuses any request to feed answers during a real interview and offers prep instead.
   Voice mocks are NOT wired for prep: voiceMockAvailability() reports that honestly and
   the text mock is the fallback (SC-174).

   Persistence is via injected stores: makePrepStore() -> { stories, mocks, debriefs,
   packs, drills } (plain arrays the caller owns; a KV {get,set} adapter also works for
   the story bank via storyStoreRows()).

   Functions:
     normalizeCir(cir)                 tolerant reader for the 15 merged CIR shapes
     cirLibrary()                      every company record on file (disk in Node, embedded in the bundle)
     interviewPatterns()               the 50 firms the mock covers and their sourced interview patterns (WO-035)
     composeBrief({cir, jdText, role, round})   PREP-001 brief: bar, stages, emphasis
     questionBank({cir, roleFamily, round, stories})  PREP-002 questions, each CIR-tagged;
                                       for a named sector the wired interview bank
                                       (packages/career-data/interview-banks/*.md, BUG-218)
                                       is served per sector — interviewBanks() /
                                       parseInterviewBank() / bankSectorFor() below
     mineStories(facts)                PREP-004 STAR drafts mined from profile facts
     captureStory(store, story) / findStories(store, query)
     scoreAnswer(answer, {family}?)    rubric: structure / evidence / specificity (0-5 each);
                                       an optional role family scores specificity on that role's
                                       own details (RUBRIC_FAMILIES); without one it is unchanged;
                                       domain-checked against the graded drills where they exist
                                       (MID-1), no length/brevity points (MID-2), missing result
                                       metric named as top fix on ties (MID-3), framework recitation
                                       without a decision diagnosed (MID-4), memorized solutions get
                                       a transfer variant (generateVariant)
     detectContradiction(answer, profile) / checkAnswerClaims(...)  corrected, route-ready version of
                                       142's flagger: sentence-start words and user-disclosed names are
                                       never fabrications (MID-5)
     handlePrepTurn(text, opts) / makeShareableExample(source) / captureStory flags
                                       confidential disclosures and shareable-artifact requests are
                                       handled as what they are, never graded as answers (MID-6)
     accessibilityMode(text)           PREP text-only / slower-pace mode, explicitly set up (MID-7)
     recordingConsent(text)            recording opt-out acknowledged with its effect (MID-8)
     startMock(store, {bank, count}) / answerMock(store, id, answer) / answerProbe(store, id, answer) / mockSummary(store, id)  PREP-003
     technicalDrills({cir, roleFamily})  PREP-005 coding + system-design sets from CIR round types
     financeDrill() / quantDrill() / gradeDrillAnswer(set, id, answer)   graded drills (SC-169/170)
     caseSession({cir}) / scoreCaseResponse(resp)   consulting case practice (SC-168)
     interviewerBrief({name, role, company, publicFacts})  PREP-006 public-facts-only; unknown stays unknown
     captureDebrief(store, d) / thankYouDraft({company, interviewer, debrief})  PREP-007
     salaryPrep({cir})                 comp ranges ONLY from CIR comp notes, source-labeled; script
     coffeeChatBrief({contact, cir})   lighter chat brief (OUTE-012 seam, SC-173)
     twoInterviewPlan(items)           ordered briefs + gap plan for same-day interviews (SC-176)
     rejectionPivot({funnel, cir, similar})  tightening plan; NO_CIR when the bar is unsourced (SC-177)
     assemblePack(store, parts)        PREP-001..007 pack with per-section traceability (SC-180)
     liveAssistGuard(text)             PREP-008: refusal + prep offer (owner OFF ruling)
     voiceMockAvailability()           honest capability report for SC-174
*/
const CareerPrep = (() => {
  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();
  function hash(str) { let h = 0x811c9dc5; const t = s(str); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }

  // ---------- CIR normalization (accepts BOTH the batch dialects and the canonical
  // 125-validator schema the corpus was normalized to at integration, 2026-10-13) ----------
  function factText(x) { if (!x) return ""; if (typeof x === "string") return x; return s(x.statement || x.claim || x.signal || x.summary || x.text || x.style || x.pattern || x.note || ""); }
  function factSource(x) { if (!x || typeof x !== "object") return null; const f = x.fact || x.basis || x; return { source_type: s(f.source_type || x.source_type || "unspecified"), source_url: s(f.source_url || x.source_url || "") || null, as_of: s(f.as_of || x.as_of || "") || null }; }
  function stageList(cir) {
    const ps = cir && cir.process_stages; if (!ps) return [];
    const raw = Array.isArray(ps) ? ps : (ps.stages || []);
    return raw.map((st) => {
      if (typeof st === "string") return { name: st, source: factSource(ps.basis) };
      return { name: s(st.stage || st.claim || st.name), detail: s(st.description || ""), source: factSource(st) };
    }).filter((x) => x.name);
  }
  function normalizeCir(cir) {
    if (!cir || typeof cir !== "object") return null;
    const barRaw = cir.hiring_bar_summary;
    const bar = typeof barRaw === "string" ? barRaw : factText(barRaw);
    const sigRaw = cir.screening_signals;
    const sigList = Array.isArray(sigRaw) ? sigRaw : [].concat((sigRaw && sigRaw.stated) || [], (sigRaw && sigRaw.revealed) || []);
    const compNotes = (cir.compensation_notes || []).map((c) => {
      const f = c.fact || c;
      return { text: factText(f) || factText(c), label: s(c.label || c.source_type || (f && f.source_type) || "company file comp note"), source: factSource(c) };
    }).filter((x) => x.text);
    return {
      company_id: s(cir.company_id), company_name: s(cir.company_name || cir.company_id),
      as_of: s(cir.as_of || cir.last_verified_at || "") || null,
      bar, stages: stageList(cir),
      signals: sigList.map((x) => ({ text: factText(x), source: factSource(x) })).filter((x) => x.text),
      styles: (cir.interview_styles || []).map((x) => ({ text: factText(x), source: factSource(x) })).filter((x) => x.text),
      values: (cir.values_culture_signals || []).map((x) => ({ text: factText(x), source: factSource(x) })).filter((x) => x.text),
      compNotes,
      redFlags: (cir.red_flags || []).map((x) => factText(x) || s(x)).filter(Boolean),
    };
  }
  function findCir(cirs, company) {
    const want = lc(company).replace(/[^a-z0-9]/g, "");
    for (const c of cirs || []) { const n = normalizeCir(c); if (n && (lc(n.company_id).replace(/[^a-z0-9]/g, "") === want || lc(n.company_name).replace(/[^a-z0-9]/g, "").includes(want) || want.includes(lc(n.company_id).replace(/[^a-z0-9]/g, "")))) return c; }
    return null;
  }

  // ---------- The company-file library (WO-025) ----------
  // Every company record on file, read lazily on the BUG-174 pattern: from
  // packages/career-data/cirs/ in Node, from the CAREER_CIRS_JSON const the
  // bundle build appends in Deno (readable only at call time). An empty
  // result is not cached, so a later call can still pick the const up.
  let _cirLib = null;
  function cirLibrary() {
    if (_cirLib && _cirLib.length) return _cirLib;
    let list = [];
    try {
      const fs = require("fs"); const path = require("path");
      const dir = path.join(__dirname, "..", "career-data", "cirs");
      list = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch { list = []; }
    if (!list.length) {
      try { if (typeof CAREER_CIRS_JSON !== "undefined" && Array.isArray(CAREER_CIRS_JSON)) list = CAREER_CIRS_JSON; } catch { list = []; }
    }
    if (list.length) _cirLib = list;
    return list;
  }

  // ---------- The 50 firms' interview patterns (WO-035) ----------
  // packages/career-data/interview-patterns.json, read the same way: from disk
  // in Node, from the CAREER_PATTERNS_JSON const in the bundle. A firm with a
  // full record (cirLibrary) takes its patterns from that record; the firms
  // without one carry their own sourced patterns here. A question is listed
  // under a firm only when a source attributes it to that firm.
  let _patterns = null;
  function interviewPatterns() {
    if (_patterns) return _patterns;
    let data = null;
    try {
      const fs = require("fs"); const path = require("path");
      data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "career-data", "interview-patterns.json"), "utf8"));
    } catch { data = null; }
    if (!data) {
      try { if (typeof CAREER_PATTERNS_JSON !== "undefined" && CAREER_PATTERNS_JSON && Array.isArray(CAREER_PATTERNS_JSON.firms)) data = CAREER_PATTERNS_JSON; } catch { data = null; }
    }
    if (data && Array.isArray(data.firms)) { _patterns = data; return data; }
    return { version: 1, firms: [] };
  }

  // ---------- JD emphasis (grounded only in text the caller supplies) ----------
  const JD_KEYS = ["python", "java", "go", "rust", "javascript", "react", "sql", "postgres", "kubernetes", "aws", "distributed", "system design", "data structures", "algorithms", "machine learning", "probability", "statistics", "excel", "financial model", "dcf", "trading", "leadership", "teamwork", "communication", "product", "experimentation", "mentoring"];
  function jdKeywords(jdText) { const t = lc(jdText); return JD_KEYS.filter((k) => t.includes(k)); }

  // ---------- PREP-001 brief ----------
  // GATE-3 record completion (03 F5 doorstep): the brief record carries the
  // user's own stories mapped to this brief's questions — or an explicit
  // no-fit statement when none map. The mapping is computed by this
  // module's own question bank (each question's matched_story, from
  // findStories over the supplied story bank); stories are taken from
  // opts.stories, or mined from opts.facts / opts.profile.facts. When no
  // stories are supplied at all, the no-fit is stated plainly — a story is
  // never invented to fill the field.
  function storyMapping(opts) {
    let stories = opts.stories || null;
    if (!stories && (opts.facts || (opts.profile && opts.profile.facts))) stories = mineStories(opts.facts || opts.profile.facts);
    if (!stories || !stories.length) {
      return { story_map: [], stories_mapped: [], no_fit_statement: true,
        stories_note: "No user stories were supplied with this brief, so no story is mapped to its questions — an explicit no-fit, not an omission: pass the story bank (or profile facts) and the mapping is computed from them. No story was invented." };
    }
    const bank = questionBank({ cir: opts.cir, role: opts.role, roleFamily: opts.roleFamily, round: opts.round, stories });
    const byId = new Map();
    for (const q of bank.questions || []) {
      if (!q.matched_story) continue;
      const e = byId.get(q.matched_story.story_id) || { story_id: q.matched_story.story_id, title: q.matched_story.title, mapped_to_questions: [] };
      e.mapped_to_questions.push(q.q);
      byId.set(q.matched_story.story_id, e);
    }
    const map = [...byId.values()];
    if (!map.length) {
      return { story_map: [], stories_mapped: [], no_fit_statement: true,
        stories_note: `${stories.length} supplied ${stories.length === 1 ? "story" : "stories"} did not map to any question in this company's brief — an explicit no-fit: no story is claimed to fit a question it does not match.` };
    }
    return { story_map: map, stories_mapped: map, no_fit_statement: false, stories_note: null };
  }
  function composeBrief(opts, postingArg, cirArg) {
    // Chat-path shape (142 handlePrepExtras, the entry the router actually
    // calls): composeBrief(profile, { title, company }, cir) — the first
    // argument is a 122 profile, the second the posting stub, the third
    // the company file. BUG-073 (W5): the CIR used to die here — the
    // normalization below rebuilt opts without it, so every chat-path
    // brief came back NO_CIR (sources: [], no bar/stages) no matter
    // what 142 passed. The third argument is now threaded through.
    if (postingArg && typeof postingArg === "object" && opts && typeof opts === "object"
      && !opts.cir && !opts.jdText && opts.company == null && (opts.facts || opts.basics || opts.id)) {
      opts = { profile: opts, facts: opts.facts, company: postingArg.company || "", role: postingArg.title || postingArg.role || "", jdText: postingArg.jdText || "", cir: cirArg || undefined };
    }
    opts = opts || {};
    if (!opts.facts && opts.profile && opts.profile.facts) opts = { ...opts, facts: opts.profile.facts };
    const company = s(opts.company || (opts.cir && opts.cir.company_name) || "");
    const n = normalizeCir(opts.cir);
    const jdKw = jdKeywords(opts.jdText);
    if (!n) {
      const bankStories = opts.stories || (opts.facts ? mineStories(opts.facts) : []);
      const bank = questionBank({ role: opts.role, roleFamily: opts.roleFamily, round: opts.round, stories: bankStories });
      return { status: "NO_CIR", company, role: s(opts.role || "") || null, round: s(opts.round || "") || null,
        bar: null, stages: [], emphasis: jdKw.map((k) => ({ point: `JD mentions: ${k}`, source: { type: "jd_text_supplied_by_user" } })),
        questions: bank.questions, likely_questions: bank.questions.map((q) => q.q),
        gaps: [`No company file on file for ${company || "this company"} — process stages, hiring bar and comp are not claimed.`, "Supply the JD text or add a company file for this company to ground a full brief."],
        sources: [], ...storyMapping(opts) };
    }
    const emphasis = [
      ...n.signals.slice(0, 4).map((x) => ({ point: x.text, source: { type: "CIR screening_signals", source_type: x.source && x.source.source_type, source_url: x.source && x.source.source_url } })),
      ...jdKw.slice(0, 4).map((k) => ({ point: `JD emphasis: ${k}`, source: { type: "jd_text_supplied_by_user" } })),
    ];
    const bankStories = opts.stories || (opts.facts ? mineStories(opts.facts) : []);
    const bank = questionBank({ cir: opts.cir, role: opts.role, roleFamily: opts.roleFamily, round: opts.round, stories: bankStories });
    return { status: "OK", company: n.company_name, company_id: n.company_id, role: s(opts.role || "") || null, round: s(opts.round || "") || null,
      bar: n.bar || null, stages: n.stages, emphasis, styles: n.styles, values: n.values.slice(0, 3),
      compNotes: n.compNotes, redFlags: n.redFlags.slice(0, 3),
      questions: bank.questions, likely_questions: bank.questions.map((q) => q.q),
      gaps: n.bar ? [] : ["The company file has no hiring-bar summary; bar not claimed."],
      sources: [{ type: "CIR", company_id: n.company_id, as_of: n.as_of }], ...storyMapping(opts) };
  }

  // ---------- PREP-004 story bank ----------
  function makePrepStore() { return { stories: [], mocks: [], debriefs: [], packs: [], drills: [], sent: [] }; }
  function mineStories(facts) {
    return (facts || []).filter((f) => f && (f.action || f.result) && ["experience", "project", "leadership"].includes(f.kind))
      .map((f) => ({
        story_id: "story-" + hash(f.id || f.title), fact_id: f.id || null, title: s(f.title),
        situation: s(f.text || ""), task: s(f.title), action: s(f.action || ""), result: s(f.result || ""),
        method: s(f.method || ""), metrics: f.metrics || [], skills: f.skills || [],
        tags: storyTags(f), source: "profile_fact:" + s(f.id || "unknown"),
      }));
  }
  function storyTags(f) {
    const t = lc([f.title, f.text, f.action, f.method].join(" "));
    const tags = [];
    if (/\b(led|lead|president|organis|organiz|mentor|team|club|participants|members|users)\b/.test(t)) tags.push("teamwork", "leadership");
    if (/\b(cut|reduc|improv|automat|replac)/.test(t)) tags.push("impact", "initiative");
    if (/\b(model|dcf|valuation|financial)/.test(t)) tags.push("finance", "analysis");
    if (/\b(built|deploy|dashboard|kubernetes|go\b|react)/.test(t)) tags.push("technical", "building");
    if (/\b(present|pitch|competition)/.test(t)) tags.push("communication");
    return [...new Set(tags)];
  }
  const CONF_RE = /\b(confidential|keep it out|do not share|don't share|unreleased|internal (?:tool|project|only)|not (?:for|to be) shar\w*)\b/i;
  function isConfidentialText(t) { return CONF_RE.test(s(t)); }
  function captureStory(store, story) {
    // MID-6: a story the user marks confidential is stored flagged non-shareable.
    const confidential = !!(story.confidential || isConfidentialText([story.title, story.situation, story.task, story.action, story.result].join(" ")));
    const row = { story_id: story.story_id || "story-" + hash(s(story.title) + s(story.action)), title: s(story.title),
      situation: s(story.situation), task: s(story.task), action: s(story.action), result: s(story.result),
      metrics: story.metrics || [], skills: story.skills || [], tags: story.tags || storyTags(story), fact_id: story.fact_id || null,
      confidential, shareable: confidential ? false : story.shareable !== false,
      source: story.source || "user_capture", captured_at: new Date().toISOString() };
    store.stories.push(row); return row;
  }
  // STAR bank (SC-180): the chat router's STAR-bank branch is guarded on
  // Prep.buildStoryBank(profile) — this is that entry. Stories are mined
  // ONLY from profile facts that carry an action and a result (mineStories);
  // a fact without both never becomes a story, and an empty bank says so.
  function buildStoryBank(input) {
    let facts = null, existing = null;
    if (Array.isArray(input)) facts = input;
    else if (input && Array.isArray(input.stories)) existing = input.stories;
    else if (input && Array.isArray(input.facts)) facts = input.facts;
    else if (input && input.profile && Array.isArray(input.profile.facts)) facts = input.profile.facts;
    const stories = existing || (facts ? mineStories(facts) : []);
    return { kind: "star_bank", stories, count: stories.length,
      note: stories.length
        ? "Mined only from profile facts that carry an action and a result — no story is invented or padded."
        : "No story yet: no profile fact on file carries both an action and a result, so the bank is honestly empty. Capture one real experience with what you did and what changed, and it mines from that." };
  }
  function findStories(store, query) {
    const q = lc(query); const rows = (store && store.stories) || [];
    return rows.map((r) => { const hay = lc([r.title, r.action, r.result, (r.tags || []).join(" ")].join(" "));
      const score = q.split(/\W+/).filter(Boolean).reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) + ((r.tags || []).some((t) => q.includes(t)) ? 2 : 0);
      return { story: r, score }; }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.story);
  }

  // ---------- Interview banks (BUG-218) ----------
  // The researched banks live as product data in
  // packages/career-data/interview-banks/*.md (304 cited canonical items
  // across 9 sectors, verbatim copies of the research files, citations
  // intact). They load LAZILY, exactly on the BUG-174 pattern of 124's
  // firmSets() / 142's cirListOf(): in Node the .md files are read from
  // disk at call time; in the shipped bundle there is no career-data
  // directory, so the build embeds the same files as
  // CAREER_INTERVIEW_BANKS_JSON (an object keyed by sector — or by file
  // name — with the raw markdown as values), appended after the modules
  // and therefore readable only at call time, never at load time. An
  // empty result is NOT cached, so a later call can still pick the
  // embedded const up. Parsing is deterministic: canonical items are
  // the numbered entries of the lettered sections; format-facts,
  // worked-example, bookshelf and standardisation sections never yield
  // items, and ### model-answer / worked-example subsections attach to
  // their item as the item's full answer (the DCF outline, the paper
  // LBO) instead of being served as questions.
  const BANK_FILES = { finance: "ib-finance.md", quant: "quant-trading.md", swe: "swe.md", data: "data.md", pm: "pm.md", consulting: "consulting.md", law: "law.md", medicine: "medicine.md", real_estate: "real-estate.md" };
  const BANK_SKIP_SECTION = /^(format facts|worked|standardisation|standardization|count and honesty|source key|canonical bookshelf|dropped|ai-flag|how to read)/i;
  function parseInterviewBank(md) {
    const items = [], modelAnswers = [];
    let section = "", skip = false, cur = null, ma = null;
    const flushMA = () => { if (ma) { ma.body = ma.lines.join("\n").trim(); delete ma.lines; modelAnswers.push(ma); ma = null; } };
    for (const line of s(md).split(/\r?\n/)) {
      const h2 = line.match(/^##\s+(.*)$/);
      const h3 = line.match(/^###\s+(.*)$/);
      if (h2) { flushMA(); section = h2[1].trim(); skip = BANK_SKIP_SECTION.test(section); cur = null; continue; }
      if (h3) { flushMA(); const head = h3[1].trim(); if (/model[ -]answer|worked example/i.test(head)) ma = { heading: head, lines: [] }; cur = null; continue; }
      if (ma) { ma.lines.push(line); continue; }
      if (skip) continue;
      const m = line.match(/^(\d+)\.\s+(.*)$/);
      if (m) { cur = { n: Number(m[1]), raw: m[2].trim(), section, extra: [] }; items.push(cur); continue; }
      if (cur && line.trim()) cur.extra.push(line.trim());
    }
    flushMA();
    const shaped = items.map((it) => {
      let title = it.raw, detail = "";
      const bold = it.raw.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      if (bold) { title = bold[1].trim(); detail = (bold[2] || "").replace(/^—\s*/, "").trim(); }
      const srcSplit = detail.split(/\s+Sources?:\s+/);
      let sourceNote = srcSplit.length > 1 ? "Sources: " + srcSplit.slice(1).join(" Sources: ") : null;
      detail = srcSplit[0].trim();
      for (const x of it.extra) {
        if (/^Sources?:\s+/.test(x)) { if (!sourceNote) sourceNote = x; continue; }
        if (/^\*.*\*$/.test(x) || /^---$/.test(x)) continue;
        detail = detail ? detail + " " + x : x;
      }
      title = title.replace(/\s+—\s+REQUIRED.*$/i, "").replace(/,?\s+full (?:model-answer )?outline below\.?$/i, "").trim();
      return { n: it.n, q: title, detail: detail || null, section: it.section, source_note: sourceNote ? sourceNote.slice(0, 400) : null, answer: null };
    }).filter((x) => x.q);
    for (const ans of modelAnswers) {
      if (!ans.body) continue;
      let target = null;
      const ref = ans.heading.match(/\(Item (\d+)/i);
      if (ref) target = shaped.find((x) => x.n === Number(ref[1])) || null;
      if (!target) {
        const rules = [[/dcf/i, /\bdcf\b/i], [/paper lbo/i, /paper lbo/i], [/enterprise value/i, /enterprise value/i], [/accretion/i, /accretive|accretion/i], [/depreciation/i, /depreciation/i]];
        for (const [hre, qre] of rules) if (hre.test(ans.heading)) { target = shaped.find((x) => qre.test(x.q)) || null; if (target) break; }
      }
      if (!target) { // generic fallback: the item sharing the most heading words
        const words = lc(ans.heading).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["worked", "example", "model", "answer", "required"].includes(w));
        let best = 0;
        for (const x of shaped) { const score = words.filter((w) => lc(x.q).includes(w)).length; if (score > best) { best = score; target = x; } }
        if (best < 2) target = null;
      }
      if (target) target.answer = target.answer ? target.answer + "\n\n" + ans.body : ans.body;
    }
    return { items: shaped, model_answers: modelAnswers.map((a) => ({ heading: a.heading, body: a.body })) };
  }
  let _banksCache = null;
  function interviewBanks() {
    if (_banksCache && Object.keys(_banksCache).length) return _banksCache;
    let raw = null;
    try {
      const fs = require("fs"); const path = require("path");
      const dir = path.join(__dirname, "..", "career-data", "interview-banks");
      const found = {};
      for (const [sector, file] of Object.entries(BANK_FILES)) { try { const t = fs.readFileSync(path.join(dir, file), "utf8"); if (t) found[sector] = t; } catch { /* a missing file is that sector's absence, stated by the caller */ } }
      if (Object.keys(found).length) raw = found;
    } catch { raw = null; }
    if (!raw) {
      try {
        if (typeof CAREER_INTERVIEW_BANKS_JSON !== "undefined" && CAREER_INTERVIEW_BANKS_JSON && typeof CAREER_INTERVIEW_BANKS_JSON === "object") {
          raw = {};
          for (const [k, v] of Object.entries(CAREER_INTERVIEW_BANKS_JSON)) {
            const key = k.replace(/\.md$/i, "");
            const sector = BANK_FILES[key] ? key : Object.keys(BANK_FILES).find((sk) => BANK_FILES[sk].replace(/\.md$/i, "") === key);
            if (sector && typeof v === "string") raw[sector] = v;
          }
          if (!Object.keys(raw).length) raw = null;
        }
      } catch { /* embedded const not yet evaluated at load time */ }
    }
    if (!raw || !Object.keys(raw).length) return {};
    const parsed = {};
    for (const [sector, text] of Object.entries(raw)) parsed[sector] = { sector, file: BANK_FILES[sector] || (sector + ".md"), ...parseInterviewBank(text) };
    _banksCache = parsed;
    return parsed;
  }
  // The sector a prep ask names — from whichever of sector / track /
  // roleFamily / role the caller supplied. Quant is checked before
  // finance (a quant ask inside the finance family is a quant ask),
  // data before finance (a "data analyst" is not a banking analyst).
  function bankSectorFor(opts) {
    const t = lc([opts.sector, opts.track, opts.roleFamily, opts.role].filter(Boolean).join(" "));
    if (!t.trim()) return null;
    if (/quant|trading/.test(t)) return "quant";
    if (/real[ _-]?estate|realestate/.test(t)) return "real_estate";
    if (/medicine|medical|residency|pre[ -]?med|\bmmi\b/.test(t)) return "medicine";
    if (/\blaw\b|legal|attorney|lawyer/.test(t)) return "law";
    if (/consult/.test(t)) return "consulting";
    if (/\bdata\b|analytics|data scien/.test(t)) return "data";
    if (/product|\bpm\b/.test(t)) return "pm";
    if (/swe|software|coding|engineering|developer/.test(t)) return "swe";
    if (/finance|banking|investment|\bib\b|analyst/.test(t)) return "finance";
    return null;
  }
  // Focus/weakness ordering: items whose question or detail shares words
  // with the stated focus lead the bank's segment — the weakness the
  // user named is drilled first, never dropped (BUG-218; the thread's
  // prep state itself is the router's, this is the bank-side seam).
  function focusScore(item, focusWords) {
    const hay = lc(item.q + " " + (item.detail || ""));
    return focusWords.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  }

  // ---------- PREP-002 question bank ----------
  const GENERIC_BEHAVIORAL = [
    "Tell me about yourself and why this role.",
    "Tell me about a time you worked with a team under a deadline.",
    "Tell me about a hard problem you solved and how you approached it.",
    "Tell me about a failure and what you changed afterward.",
    "Why this company, specifically?",
  ];
  function questionBank(opts) {
    opts = opts || {};
    const n = normalizeCir(opts.cir);
    const stories = opts.stories || [];
    const qs = [];
    const push = (q, round, source) => { const match = findStories({ stories }, q)[0] || null;
      qs.push({ q, round: round || "any", source, matched_story: match ? { story_id: match.story_id, title: match.title } : null }); };
    if (n) {
      for (const st of n.stages) push(`[${n.company_name} stage] Walk me through how you will handle: ${st.name}`, st.name, { type: "CIR process_stages", company_id: n.company_id, source_type: st.source && st.source.source_type, source_url: st.source && st.source.source_url });
      for (const sg of n.signals.slice(0, 3)) push(`Evidence check (${n.company_name} screens for this): ${sg.text} — give a concrete example.`, opts.round || "screen", { type: "CIR screening_signals", company_id: n.company_id, source_type: sg.source && sg.source.source_type });
      for (const st of n.styles.slice(0, 2)) push(`Style drill (${n.company_name}): ${st.text}`, opts.round || "loop", { type: "CIR interview_styles", company_id: n.company_id, source_type: st.source && st.source.source_type });
    }
    for (const g of GENERIC_BEHAVIORAL) push(g, "behavioral", { type: "generic_behavioral_bank", company_id: null });
    if (/quant|trading|finance/i.test(s(opts.roleFamily) + " " + s(opts.role))) {
      // WORDING-BACKLOG (BUG-133): a quant ask gets the quant drills
      // themselves FIRST — probability, a market-making game, mental
      // math — not the banking technicals wearing a quant headline.
      // WORDING-BACKLOG (BUG-195): a quant set is ONLY quant — the
      // banking technicals no longer ride it at all; and every drill
      // is ONE sentence, because the composer speaks one sentence
      // per fact and a two-sentence drill lost its actual question.
      const isQuant = /quant/i.test(s(opts.role));
      if (isQuant) {
        push("How many flips do you expect before a fair coin lands two heads in a row?", "technical", { type: "quant_drill_bank", company_id: n && n.company_id || null });
        push("Quote your bid and ask as you make a market on a fair die roll — the roll comes up 2, so what do you do and what is your position worth now?", "technical", { type: "quant_drill_bank", company_id: n && n.company_id || null });
        push("Mental math, no paper: what is 17 times 24, and 15% of 840 — talk through the method as you go?", "technical", { type: "quant_drill_bank", company_id: n && n.company_id || null });
      } else {
        // BUG-117: the finance drill set covers the canonical technicals
        // the asks name — three statements, DCF, comps, LBO basics —
        // not just the DCF prompt.
        push("Walk me through the three financial statements and how they link.", "technical", { type: "finance_drill_bank", company_id: n && n.company_id || null });
        push("Walk me through a DCF.", "technical", { type: "finance_drill_bank", company_id: n && n.company_id || null });
        push("How do you build a set of trading comps, and which multiples do you reach for first?", "technical", { type: "finance_drill_bank", company_id: n && n.company_id || null });
        push("Walk me through an LBO: sources and uses, and what actually drives the returns.", "technical", { type: "finance_drill_bank", company_id: n && n.company_id || null });
        push("How many flips do you expect before a fair coin lands two heads in a row?", "technical", { type: "quant_drill_bank", company_id: n && n.company_id || null });
      }
    }
    if (/product/i.test(s(opts.roleFamily))) {
      // WORDING-BACKLOG (BUG-133): the PM drill set — product sense
      // through the candidate's own shipped work, an execution
      // scenario, and an estimation tree. Before this, a PM prep ask
      // was served the generic behavioral bank.
      push("Pick a product you use every day: how would you improve it, and how would you know the improvement worked?", "product_sense", { type: "pm_drill_bank", company_id: null });
      push("Your flagship metric drops 20% overnight — walk me through your first day.", "execution", { type: "pm_drill_bank", company_id: null });
      push("Tell me about the thing you shipped: what it was, who it was for, and the number that proves it mattered.", "product_behavioral", { type: "pm_drill_bank", company_id: null });
      push("Estimate how many rides a ride-hailing service completes in one city in a day — talk through the tree out loud.", "estimation", { type: "pm_drill_bank", company_id: null });
    }
    if (/swe|software|coding|engineering/i.test(s(opts.roleFamily) + " " + s(opts.role))) {
      // BUG-117: the SWE coding set — before this, a coding ask was
      // served the generic behavioral bank because no coding set
      // existed in the product at all.
      push("Given an array of integers and a target, return the two numbers that sum to it — then optimize your solution.", "coding", { type: "swe_coding_bank", company_id: n && n.company_id || null });
      push("Reverse a linked list, talking through your approach before you code it.", "coding", { type: "swe_coding_bank", company_id: n && n.company_id || null });
      push("Design a URL shortener: the data model, the API, and how it scales.", "system_design", { type: "swe_coding_bank", company_id: n && n.company_id || null });
      push("How does a hash map handle collisions, and what are the trade-offs?", "fundamentals", { type: "swe_coding_bank", company_id: n && n.company_id || null });
    }
    // BUG-218: the wired interview bank for the asked sector. Items are
    // drawn ONLY from that sector's bank file — sector isolation is by
    // construction (one file per sector, selected by bankSectorFor).
    // An item whose question duplicates an inline BUG-117 drill merges
    // into it instead of duplicating: the bank's detail and full model
    // answer (where the bank carries one — the DCF outline, the paper
    // LBO, EV/equity, accretion, the $10 depreciation) ride the inline
    // item, so the DCF question serves the MODEL ANSWER, not the old
    // keyword prompt. A stated focus/weakness re-orders the bank
    // segment so the named weakness is drilled first.
    const sector = bankSectorFor(opts);
    let bankMeta = null;
    if (sector) {
      const bankData = interviewBanks()[sector] || null;
      if (bankData && bankData.items && bankData.items.length) {
        const focusText = s(opts.focus || opts.weakness || (Array.isArray(opts.weaknesses) ? opts.weaknesses.join(" ") : "") || "");
        const focusWords = [...new Set(lc(focusText).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["case", "cases", "weak", "weakest", "focus", "drill", "drills", "question", "questions", "with", "that", "this"].includes(w)))];
        const ordered = bankData.items.map((it, i) => ({ it, i, fs: focusWords.length ? focusScore(it, focusWords) : 0 }));
        if (focusWords.length) ordered.sort((a, b) => (b.fs - a.fs) || (a.i - b.i));
        const normQ = (x) => lc(x).replace(/[^a-z0-9]+/g, " ").trim();
        const seen = new Map(qs.map((x) => [normQ(x.q), x]));
        let served = 0;
        for (const { it, fs } of ordered) {
          const existing = seen.get(normQ(it.q));
          if (existing) {
            if (it.answer && !existing.answer) { existing.answer = it.answer; existing.model_answer = it.answer; }
            if (it.detail && !existing.detail) existing.detail = it.detail;
            existing.bank_item = { bank_file: bankData.file, item_n: it.n, sector };
            served += 1;
            continue;
          }
          const match = findStories({ stories }, it.q)[0] || null;
          const row = { q: it.q, round: it.section ? it.section.replace(/^[A-Z]\.\s*/, "").replace(/\s*\([^)]*\)\s*$/, "") : "interview_bank",
            source: { type: "interview_bank_" + sector, bank_file: bankData.file, company_id: null, sector, item_n: it.n, section: it.section },
            matched_story: match ? { story_id: match.story_id, title: match.title } : null,
            detail: it.detail, source_note: it.source_note,
            answer: it.answer, model_answer: it.answer, focus_match: focusWords.length ? fs > 0 : null };
          qs.push(row); seen.set(normQ(it.q), row); served += 1;
        }
        bankMeta = { sector, file: bankData.file, count: served, total_items: bankData.items.length, focus_applied: focusText || null };
      } else {
        bankMeta = { sector, file: BANK_FILES[sector] || null, count: 0, total_items: 0, focus_applied: null, note: "No interview bank file is wired for this sector in this build — the inline sets above are all the product holds for it." };
      }
    }
    // BUG-117: the story-mapping state rides the record itself — how
    // many mineable stories the profile holds, and when there are
    // none, the reason questions ship unmapped (never an invented
    // match).
    return { company: n ? n.company_name : (s(opts.company) || null), cir_grounded: !!n, questions: qs,
      interview_bank: bankMeta, focus_applied: bankMeta ? bankMeta.focus_applied : null,
      stories_on_file: stories.length,
      stories_note: stories.length ? null : "No mineable story on the profile yet — stories mine only from facts carrying an action and a result, so the questions ship unmapped rather than inventing a match." };
  }

  // ---------- G3 (MID-1..8): ground truth, judgment, variants, disclosure ----------
  // MID-1: directional ground truth from the graded drills (FINANCE_DRILL fin-1/fin-5).
  function domainCheck(a) {
    const low = lc(a);
    if (/depreciation/.test(low) && /\b(net income|cash flow|balance sheet)\b/.test(low)) {
      const drill = (typeof FINANCE_DRILL !== "undefined" ? FINANCE_DRILL : []).find((d) => d.id === "fin-1");
      const wrong = [];
      if (/net income (rises|rose|increases|increased|goes up|grows|grew)\b/.test(low) || /net income (falls|fell|drops|decreases|declines) by (10|ten)\b/.test(low)) wrong.push("net income direction/amount");
      if (/cash flow (falls|fell|drops|decreases|declines|goes down)\b/.test(low) || /cash flow (rises|increases) by (10|ten)\b/.test(low)) wrong.push("cash flow direction/amount");
      if (/equity (grows|grew|increases|increased)\b/.test(low)) wrong.push("equity claim");
      const correctMarkers = [/net income (falls|fell|drops|decreases|declines)[^.]{0,30}\b6\b/, /cash flow[^.]{0,40}\b4\b/, /added back/];
      const hitsCorrect = correctMarkers.filter((re) => re.test(low)).length;
      if (wrong.length) return { drill_id: "fin-1", topic: "accounting", correct: false, wrong_claims: wrong,
        correction: "Correction: a $10 increase in depreciation lowers net income by $6 after the 40% tax (net income falls by $6, not rises by $10), and cash flow rises by a net $4 — the $10 non-cash charge is added back, less the tax shield. Depreciation is non-cash, but it still reduces reported profit, so the wrong claim about depreciation and net income cannot earn evidence points. Ground truth (fin-1): " + (drill ? drill.expect : "IS: NI down $6; CFS: +$4 net (add back $10, tax shield); BS balances.") };
      if (hitsCorrect >= 1) return { drill_id: "fin-1", topic: "accounting", correct: true, wrong_claims: [], correction: null };
      return { drill_id: "fin-1", topic: "accounting", correct: null, wrong_claims: [], correction: null };
    }
    if (/working capital (increases|increased|goes up|rose)\b/.test(low) && /cash flow/.test(low)) {
      const drill = (typeof FINANCE_DRILL !== "undefined" ? FINANCE_DRILL : []).find((d) => d.id === "fin-5");
      if (/cash flow (rises|increases|improves|goes up)\b/.test(low)) return { drill_id: "fin-5", topic: "accounting", correct: false, wrong_claims: ["cash flow direction"],
        correction: "Correction: when working capital increases, cash flow decreases — cash is tied up in inventory and receivables. Ground truth (fin-5): " + (drill ? drill.expect : "Cash flow decreases.") };
      if (/cash flow (falls|decreases|drops|declines)\b/.test(low)) return { drill_id: "fin-5", topic: "accounting", correct: true, wrong_claims: [], correction: null };
    }
    return null;
  }
  // MID-4 (MI07): framework steps named, but no actual decision/choice/trade-off made.
  function frameworkCheck(a) {
    const low = lc(a);
    const signals = [/clarify/, /structure|branches|split/, /hypothes/, /analy[sz]e|analyze the data/, /synthesi[sz]e|recommendation/, /framework/, /risks|next steps/]
      .filter((re) => re.test(low)).length;
    const decision = /\b(i|we) (decided|chose|choose|recommended|prioritised|prioritized|cut|dropped|priced)\b/.test(low)
      || /recommendation (is|was) to\b/.test(low) || /the decision (is|was)\b/.test(low) || /\bi would (recommend|choose|decide)\b/.test(low);
    return { framework_signals: signals, decision_made: decision, missing_judgment: signals >= 3 && !decision };
  }
  // MID-4 (MI08): a memorized/known solution is transfer-tested, never accepted as mastery.
  function generateVariant(answer) {
    const low = lc(answer);
    if (/two[- ]?sum/.test(low) || (/hash map/.test(low) && /complement/.test(low))) {
      return { problem: "two-sum", tests_transfer: true,
        changed_constraints: ["the input is already sorted, so only O(1) extra space is allowed", "duplicates can appear and every matching pair must be reported", "the input arrives as a stream too large to store"],
        variant: "Variant (two-sum, changed constraints): the array is now sorted and you may use only O(1) extra space; duplicates can appear and every matching pair counts; then the same values arrive as a stream too large to store. Solve it again out loud: what changes, what breaks in the memorized hash-map version, and what are the new time and space costs?",
        follow_up: "Do not repeat the memorized solution — adapt it to the changed constraints and name the trade-off you accept." };
    }
    if (/memoriz|same pattern|exactly this way/.test(low) || /\b(binary search|sliding window|dynamic programming|bfs|dfs|two pointers)\b/.test(low)) {
      return { problem: "memorized-pattern", tests_transfer: true,
        changed_constraints: ["the input is already sorted", "the input arrives as a stream too large to store", "duplicates can appear"],
        variant: "Variant (changed constraints): the input is now already sorted, duplicates can appear, and it then arrives as a stream too large to store. Solve it again out loud: what changes, what breaks in the memorized pattern, and what are the new time and space costs?",
        follow_up: "Do not repeat the memorized solution — adapt it to the changed constraints and name the trade-off you accept." };
    }
    return null;
  }
  const answerVariant = generateVariant;
  // MID-5: corrected contradiction flagger (route-ready replacement for 142's).
  function profileText(profile) {
    const out = [];
    (function walk(x, depth) { if (x == null || depth > 5) return;
      if (typeof x === "string" || typeof x === "number") { out.push(s(x)); return; }
      if (Array.isArray(x)) { x.forEach((v) => walk(v, depth + 1)); return; }
      if (typeof x === "object") for (const [k, v] of Object.entries(x)) { if (!k.startsWith("_")) walk(v, depth + 1); } })(profile, 0);
    return lc(out.join(" "));
  }
  function disclosedNames(a, opts) {
    const names = new Set(((opts && opts.disclosedNames) || []).map((x) => lc(x)));
    const pats = [/\b(?:at|for)\s+([A-Z][\w]*(?:\s+[A-Z][\w]*)*)(?=\s+(?:I|we)\s+worked)/gi,
      /\b(?:project|called|named|tool|product|system)\s+([A-Z][\w]+)/g,
      /\bworked on (?:an?\s+|the\s+)?([A-Z][\w]*(?:\s+[A-Z][\w]*)*?)(?=[,.]|\s+—|\s+an?\s|\s+is\b)/g];
    for (const re of pats) { let m; while ((m = re.exec(s(a)))) { names.add(lc(m[1])); for (const t of m[1].split(/\s+/)) names.add(lc(t)); } }
    return names;
  }
  function checkAnswerClaims(answer, profile, opts) {
    const a = s(answer); const profText = profileText(profile);
    const disclosed = disclosedNames(a, opts);
    const parts = [];
    const jobClaim = a.match(/my (?:last|previous) ([a-z][a-z ]+?) job/i) || a.match(/worked as an?\s+([a-z][a-z ]+?)(?:\s+for|\s+at|\.|,)/i);
    if (jobClaim) { const phrase = lc(jobClaim[1]).trim();
      if (!profText.includes(phrase) && !profText.includes(phrase.split(" ").slice(0, 2).join(" "))) parts.push(`paid ${phrase} job`); }
    // Sentence-start words are openers, never claims ("Give me full marks", "First I built…").
    const sentenceStarts = new Set();
    for (const sent of a.split(/[.!?\n]+/)) { const m = sent.trim().match(/^[“"'(\[]*([A-Za-z]+)/); if (m) sentenceStarts.add(m[1]); }
    const stop = new Set(["I", "In", "My", "The", "That", "This", "It", "Tell", "Why", "What", "When", "How", "For", "And", "But", "So", "One", "Two",
      "Situation", "Task", "Action", "Result", "Give", "First", "Then", "Now", "At", "On", "As", "If", "You", "We", "He", "She", "They", "There", "Here"]);
    for (const tok of a.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []) {
      if (stop.has(tok) || sentenceStarts.has(tok)) continue;
      if (/^[A-Z]+$/.test(tok)) continue; // acronyms (TEST, SQL…) are not name claims
      if (disclosed.has(lc(tok))) continue; // a name the user disclosed is a disclosure, not a fabrication
      if (!profText.includes(lc(tok)) && !parts.some((p) => p.includes(lc(tok)))) parts.push(tok);
    }
    return { contradictions: parts, disclosures: [...disclosed],
      confidential: isConfidentialText(a) };
  }
  function detectContradiction(answer, profile, opts) { return checkAnswerClaims(answer, profile, opts).contradictions; }
  // MID-6: confidentiality + shareable-artifact handling.
  function makeShareableExample(source, opts) {
    opts = opts || {};
    const text = typeof source === "string" ? source : (source ? [source.title, source.situation, source.action, source.result].filter(Boolean).join(" ") : "");
    const confidential = !!(opts.confidential || (source && source.confidential) || (source && source.shareable === false) || isConfidentialText(text));
    if (confidential) return { status: "WITHHELD_CONFIDENTIAL", kind: "shareable_example_request", is_answer: false, shareable_text: null,
      message: "I can't make a shareable example from that story: you marked it confidential, so I will keep the confidential material out of any shareable example. Pick a story you are cleared to share, or tell me the cleared version, and I will build the example from that." };
    if (!text) return { status: "NEEDS_STORY", kind: "shareable_example_request", is_answer: false, shareable_text: null,
      message: "Tell me the story you want turned into a shareable example — one you are cleared to share — and I will build it from that." };
    return { status: "OK", kind: "shareable_example_request", is_answer: false, shareable_text: text,
      message: "Here is a shareable example built only from the story you supplied — nothing confidential was added." };
  }
  // MID-7: accessibility mode (text mock is substantively equivalent; the mode itself is set up here).
  function accessibilityMode(textOrOpts) {
    const t = typeof textOrOpts === "string" ? textOrOpts : "";
    const o = (textOrOpts && typeof textOrOpts === "object") ? textOrOpts : {};
    const asked = o.textOnly === true || o.text_only === true || /\b(accessible|accessibility|text only|text-only|slower pace|no audio|no video)\b/i.test(t);
    if (!asked) return { status: "NOT_REQUESTED", mode: null, acknowledgement: null };
    return { status: "SET", mode: { text_only: true, slower_pace: true, audio: false, video: false, voice: false },
      acknowledgement: "Accessibility mode set for this session: text only, slower pace, no audio or video — one question at a time, with as long as you need on each answer. The questions and the rubric are exactly the same as any other mock, and nothing is deducted for delivery or pace." };
  }
  // MID-8: recording consent.
  function recordingConsent(text) {
    if (/\b(opt out of recording|do not record|don't record|no recording|stop recording|not be recorded)\b/i.test(s(text))) {
      return { status: "OPTED_OUT", recording: false, background_capture: false, practice_proceeds: true,
        acknowledgement: "Recording opt-out acknowledged: I will not record this practice session in any form — no recording and no background capture for this session. Practice proceeds in text; you see every score and note that is kept in the mock." };
    }
    return { status: "NO_REQUEST", recording: null, background_capture: null, practice_proceeds: true, acknowledgement: null };
  }
  // Route-ready turn classifier: non-answer turns are handled as what they are, never graded.
  function handlePrepTurn(text, opts) {
    opts = opts || {};
    const guard = liveAssistGuard(text); // PREP-008 hard stop stays absolute, checked first
    if (guard.refused) return { kind: "live_assist_refusal", is_answer: false, refused: true, ...guard };
    const consent = recordingConsent(text);
    if (consent.status === "OPTED_OUT") return { kind: "recording_opt_out", is_answer: false, ...consent, message: consent.acknowledgement };
    const access = accessibilityMode(text);
    if (access.status === "SET") return { kind: "accessibility_mode", is_answer: false, ...access, message: access.acknowledgement };
    if (/\bshareable\b/i.test(s(text)) && /\b(make|create|write|turn|give)\b/i.test(s(text))) {
      const priorConfidential = isConfidentialText(opts.priorText || "") || !!(opts.store && (opts.store.stories || []).some((x) => x.confidential));
      return makeShareableExample(opts.story || opts.sourceText || "", { confidential: priorConfidential || !!opts.confidential });
    }
    if (isConfidentialText(text) && /\b(worked|project|story|employer|internal|unreleased)\b/i.test(s(text))) {
      const claims = checkAnswerClaims(text, opts.profile, opts);
      return { kind: "confidential_disclosure", is_answer: false, confidential: true, shareable: false,
        contradictions: [], disclosures: claims.disclosures, graded: null,
        message: "Acknowledged — that detail is confidential, so I am treating it as a disclosure, not an interview answer and not a fabrication: it stays out of any shareable example, and I will not grade it or build reusable material from it. We can coach from a story you are cleared to share." };
    }
    const graded = scoreAnswer(text);
    return { kind: "answer", is_answer: true, graded, contradictions: detectContradiction(text, opts.profile, opts) };
  }

  // ---------- PREP-003 mock engine + rubric ----------
  // 2026-10-23: specificity by role family. The default counts tech details (python, react, sql ...) and told every
  // answer, a nurse's included, to "name the tool". With a family, that role's own details count and the advice names
  // them. Without one, the rubric is unchanged for every existing caller.
  const TECH_DETAIL_RE = /\b(python|react|go|excel|sql|sqlite|flask|postgres|kubernetes|docker|javascript)\b/;
  const RUBRIC_FAMILIES = {
    tech: { re: TECH_DETAIL_RE, fix: "Specificity: name the tool, the constraint and your exact role — drop vague words like 'various things'." },
    clinical: { re: /\b(patients?|unit|floor|icu|er|ed|cardiac|telemetry|medications?|meds|dose|vitals|charting|handoff|falls?|sepsis|discharge|triage|bedside|wound|iv|physician|clinical|ward)\b/, fix: "Specificity: name the clinical detail — the unit, the patient's situation, what you checked or changed, and your exact part." },
    consulting: { re: /\b(clients?|revenue|margins?|costs?|market|stakeholders?|engagement|recommend\w*|workstream|savings|profit\w*|pricing)\b/, fix: "Specificity: name the client's situation and its numbers — the size of the problem, what you recommended, and your exact part." },
    finance: { re: /\b(model|dcf|valuation|revenue|ebitda|margins?|deal|portfolio|excel|forecast|variance|budget|lbo|comps)\b/, fix: "Specificity: name the deal, model or figures you worked on, and your exact part." },
    teaching: { re: /\b(students?|class|classroom|lesson|grades?|curriculum|reading|test scores?|parents?|iep)\b/, fix: "Specificity: name the class, the students' situation, what you changed, and how you knew it worked." },
    sales: { re: /\b(quota|pipeline|deals?|accounts?|prospects?|calls|close rate|crm|salesforce|territory)\b/, fix: "Specificity: name the account or territory, the numbers (quota, pipeline, close rate), and your exact part." },
    marketing: { re: /\b(campaign|audience|conversion|ctr|open rate|engagement|followers|channel|seo|leads?)\b/, fix: "Specificity: name the campaign, its audience and channel, and your exact part." },
    pm: { re: /\b(users?|metric|roadmap|engineers?|designers?|launch|feature|retention|experiment|a\/b)\b/, fix: "Specificity: name the users, the metric you moved, and your exact part with engineering and design." },
    law: { re: /\b(clients?|brief|motion|matter|research|filing|court|contract|memo|statute)\b/, fix: "Specificity: name the kind of matter, what you researched or drafted, and your exact part." },
    general: { re: /\b(team|customers?|clients?|manager|project|deadline|budget|process|schedule|store|office)\b/, fix: "Specificity: name the setting, the constraint and your exact part — drop vague words like 'various things'." },
  };
  function scoreAnswer(answer, opts) {
    const a = s(answer); const low = lc(a);
    const fam = opts && opts.family && RUBRIC_FAMILIES[opts.family] ? RUBRIC_FAMILIES[opts.family] : null;
    const has = (re) => re.test(low);
    let structure = 1;
    // 2026-10-23: with a role family, the actions and outcomes of that work count too (a nurse "held the dose" and
    // "caught" sepsis; a consultant "recommended"); the default verb list (built, wrote, designed ...) is unchanged.
    const FAM_ACTION = "split|found|recommended|held|called|caught|taught|sold|managed|organized|organised|analyzed|analysed|launched|negotiated|trained|noticed|paused|escalated|closed|presented|planned|consolidated|advocated|coordinated|prioritized|prioritised";
    if (has(/\b(first|started|began|situation|context)\b/)) structure += 1;
    if (has(fam ? new RegExp(`\\b(then|next|after that|so i|i (built|wrote|led|designed|modelled|modeled|created|${FAM_ACTION}))\\b`) : /\b(then|next|after that|so i|i (built|wrote|led|designed|modelled|modeled|created))\b/)) structure += 1;
    if (has(/\b(result|ended|outcome|in the end|led to)\b/)) structure += 1;
    // MID-2: NO length points. A complete short answer (a named action + a result/outcome)
    // earns the completeness point at any word count; padding past 60 words earns nothing.
    const hasAction = has(/\b(i|we) (built|wrote|led|designed|modelled|modeled|created|helped|wrote|ran|shipped)\b/) || has(/\bby (writing|building|creating|designing|leading)\b/) || (!!fam && has(new RegExp(`\\b(i|we) (${FAM_ACTION})\\b`)));
    const hasOutcome = /\d/.test(a) || has(/\b(used it|users|classmates used|saved|cut|reduced|improved|increased)\b/) || (!!fam && has(/\b(stable|dropped|fell|rose|grew|won|closed|caught|recovered|discharged|passed|save)\b/));
    if (hasAction && hasOutcome) structure += 1;
    let evidence = 0;
    if (/\d/.test(a)) evidence += 2;
    if (has(/\b(because|measured|compared|data|users|members|percent|%)\b/)) evidence += 1;
    if (has(/\b(specifically|for example|for instance)\b/)) evidence += 1;
    if (/\d+\s*(%|users|members|people|teams|pages|companies|participants|classmates)/.test(low)) evidence += 1;
    let specificity = 0;
    if (has(/\b(i|my|we)\b/)) specificity += 1;
    if (has(fam ? fam.re : TECH_DETAIL_RE)) specificity += 1;
    if (has(fam ? /\b(weeks?|months?|deadline|semester|summer|shifts?|night|morning|quarters?|years?)\b/ : /\b(week|month|deadline|semester|summer)\b/)) specificity += 1;
    if (has(/\b(studyboard)\b/) || /[A-Z][a-z]+(?:[A-Z][a-z]+)/.test(a)) specificity += 1; // a named product/system is specific at any length
    if (has(/\b(something|stuff|things|various|etc)\b/)) specificity = Math.max(0, specificity - 1);
    // MID-1: a confidently wrong ground-truth answer earns no evidence for its wrong numbers.
    const domain = domainCheck(a);
    if (domain && domain.correct === false) { evidence = Math.min(evidence, 1); specificity = Math.min(specificity, 2); structure = Math.min(structure, 2); }
    // MID-4: framework recitation without a decision earns no structure reward.
    const judgment = frameworkCheck(a);
    if (judgment.missing_judgment) structure = Math.min(structure, 2);
    const variant = generateVariant(a);
    const clamp = (x) => Math.max(0, Math.min(5, x));
    const sc = { structure: clamp(structure), evidence: clamp(evidence), specificity: clamp(specificity) };
    sc.total = sc.structure + sc.evidence + sc.specificity;
    const gaps = [];
    if (domain && domain.correct === false) gaps.push("domain_error:" + domain.drill_id);
    if (judgment.missing_judgment) gaps.push("missing_judgment");
    if (variant) gaps.push("transfer_not_tested");
    // MID-3: the missing result metric is the top fix whenever the result carries no
    // number/how-it-is-known — including when evidence merely ties as weakest.
    // (suppressed when judgment/transfer is the diagnosed gap — a coding or framework
    // answer is not missing a story metric, it is missing a decision or an adaptation)
    const missingMetric = !judgment.missing_judgment && !variant && !/\d|%/.test(a) && sc.evidence < 4;
    if (missingMetric) gaps.push("missing_result_metric");
    const priority = { evidence: 0, specificity: 1, structure: 2 };
    const fix_first = ["structure", "evidence", "specificity"].sort((x, y) => (sc[x] - sc[y]) || (priority[x] - priority[y]))[0];
    const feedback = [];
    if (domain && domain.correct === false) feedback.push(domain.correction);
    if (judgment.missing_judgment) feedback.push("Judgment: this recites a framework but makes no decision — naming the steps (clarify, structure, hypothesise, analyse, synthesise) is not judgment. Say what you would actually decide in this case, why, what data would change your mind, and what trade-off you accept.");
    if (missingMetric) feedback.push("Evidence — missing result metric: you have not named a result metric (a number, a %, or a time saved, and how you know it), and that missing metric is the top fix. Ask yourself how big the result was and how it was measured — or say plainly that it was not measured, which is coachable, instead of leaving the result as 'it helped'.");
    if (variant) feedback.push("Transfer: a memorized solution is not mastery yet — " + variant.variant);
    const dimFeedback = {
      structure: "Structure: order it Situation -> Task -> Action -> Result so the interviewer never has to reconstruct it.",
      evidence: fam ? (/\d/.test(a) ? "Evidence: say how you know the result — what was measured, and over what period." : "Evidence: add a number (how many, how much, how often) and how you know it.") : "Evidence: add a number (users, %, time saved) and how you know it.",
      specificity: fam ? fam.fix : "Specificity: name the tool, the constraint and your exact role — drop vague words like 'various things'." };
    for (const dim of ["evidence", "specificity", "structure"].sort((x, y) => (sc[x] - sc[y]) || (priority[x] - priority[y]))) {
      if (sc[dim] < 4 && !(dim === "evidence" && missingMetric) && !feedback.includes(dimFeedback[dim])) feedback.push(dimFeedback[dim]);
    }
    if (!feedback.length) feedback.push("Landed: clear structure, quantified evidence, specific ownership. Keep this story as a primary.");
    const follow_up = judgment.missing_judgment
      ? "Decision probe: pick one branch of this problem — what would you decide, what data would change your mind, and what trade-off do you accept?"
      : (variant ? variant.follow_up : null);
    return { scores: sc, feedback, fix_first, top_fix: fix_first, gaps, domain_check: domain, judgment, variant, missing_result_metric: missingMetric, follow_up };
  }
  function startMock(store, opts) {
    opts = opts || {};
    const bank = opts.bank || questionBank({});
    const qs = (bank.questions || []).slice(0, opts.count || 5);
    const m = { mock_id: "mock-" + hash(Date.now() + ":" + qs.length + ":" + (store.mocks.length + 1)), company: bank.company || null,
      questions: qs, idx: 0, answers: [], status: "in_progress", started_at: new Date().toISOString() };
    store.mocks.push(m); store.drills.push({ kind: "mock", mock_id: m.mock_id, at: m.started_at });
    return m;
  }
  function answerMock(store, mockId, answer) {
    const m = store.mocks.find((x) => x.mock_id === mockId); if (!m) throw new Error("mock not found: " + mockId);
    const q = m.questions[m.idx]; if (!q) throw new Error("mock already complete");
    const graded = scoreAnswer(answer);
    m.answers.push({ q: q.q, answer: s(answer), scores: graded.scores, feedback: graded.feedback });
    m.idx += 1;
    if (m.idx >= m.questions.length) { m.status = "complete"; m.finished_at = new Date().toISOString(); }
    return { mock: m, graded, next_question: m.status === "complete" ? null : m.questions[m.idx].q, done: m.status === "complete" };
  }
  // 2026-10-23 (Muse's 4th bug): a follow-up (probe) answer belongs to the question it
  // followed. It is kept on that question's recorded answer and never advances the mock:
  // only a main answer moves the index. Before this, the probe answer went through
  // answerMock, was graded as the next question's answer (which was then never asked), and
  // after the last question threw "mock already complete".
  function answerProbe(store, mockId, answer) {
    const m = store.mocks.find((x) => x.mock_id === mockId); if (!m) throw new Error("mock not found: " + mockId);
    const last = m.answers[m.answers.length - 1]; if (!last) throw new Error("no answer to follow up");
    const graded = scoreAnswer(answer);
    last.probe = { answer: s(answer), scores: graded.scores, feedback: graded.feedback };
    const done = m.idx >= m.questions.length;
    return { mock: m, graded, next_question: done ? null : m.questions[m.idx].q, done };
  }
  function mockSummary(store, mockId) {
    const m = store.mocks.find((x) => x.mock_id === mockId); if (!m) return null;
    const n = m.answers.length || 1;
    const avg = { structure: 0, evidence: 0, specificity: 0, total: 0 };
    for (const a of m.answers) for (const k of Object.keys(avg)) avg[k] += a.scores[k] / n;
    for (const k of Object.keys(avg)) avg[k] = Math.round(avg[k] * 10) / 10;
    // MID-3 tie-break: on a tie the substantive gap (evidence, then specificity) is
    // named before form (structure) — structure no longer wins ties by default.
    const tiePriority = { evidence: 0, specificity: 1, structure: 2 };
    const weakest = ["structure", "evidence", "specificity"].sort((a, b) => (avg[a] - avg[b]) || (tiePriority[a] - tiePriority[b]))[0];
    return { mock_id: m.mock_id, company: m.company, status: m.status, answered: m.answers.length, average_scores: avg,
      what_landed: m.answers.filter((a) => a.scores.total >= 12).map((a) => a.q),
      what_didnt: m.answers.filter((a) => a.scores.total < 12).map((a) => ({ q: a.q, scores: a.scores, fix: a.feedback })),
      fix_first: weakest };
  }

  // ---------- PREP-005 + drills ----------
  function technicalDrills(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    const stageNames = n ? n.stages.map((x) => x.name).join(" | ") : "";
    const sets = [];
    if (/coding|technical screen|online coding/i.test(stageNames) || !n) sets.push({ type: "coding", source: n ? { type: "CIR process_stages", company_id: n.company_id } : { type: "generic_swe_bank" },
      prompts: ["Reverse a linked list in place, then handle cycles.", "Given a stream of events, return the top-K most frequent in the last hour.", "Implement an LRU cache with O(1) get/put."] });
    if (/design/i.test(stageNames)) sets.push({ type: "system_design", source: { type: "CIR process_stages", company_id: n.company_id },
      prompts: ["Design a notification system for 10M users (a design prompt shape reported for this company's loops — labeled anecdotal in the company file where applicable).", "Design a multi-tenant quota service.", "Design a URL shortener, then scale reads 100x."] });
    if (/code.review|pair/i.test(JSON.stringify(n ? [...n.styles.map((x) => x.text), n.bar] : []))) sets.push({ type: "code_review_pairing", source: { type: "CIR interview_styles+hiring_bar_summary", company_id: n.company_id },
      prompts: ["Review a provided diff: find the correctness bug before style issues, say why, propose the fix.", "Pair on a production-like codebase task; narrate trade-offs aloud."] });
    if (!sets.length) sets.push({ type: "coding", source: { type: "generic_swe_bank" }, prompts: ["Two-sum variants with follow-ups toward performance/trade-off discussion."] });
    return { company: n ? n.company_name : null, cir_grounded: !!n, sets };
  }
  const FINANCE_DRILL = [
    { id: "fin-1", topic: "accounting", q: "Walk me through the three financial statements and how a $10 increase in depreciation flows through them (40% tax).", key: ["income", "depreciation", "net income", "cash flow", "balance sheet", "6", "4"], expect: "IS: NI down $6; CFS: +$4 net (add back $10, tax shield); BS balances." },
    { id: "fin-2", topic: "dcf", q: "What drives a DCF's value most: WACC or terminal growth? How do you sanity-check it?", key: ["terminal", "wacc", "sensitivity", "multiple"], expect: "Terminal value usually dominates; sanity-check vs trading multiples and sensitivity tables." },
    { id: "fin-3", topic: "comps", q: "Why might two similar companies trade at different EV/EBITDA multiples?", key: ["growth", "margin", "risk", "capital"], expect: "Growth, margins, risk, capital intensity / returns on capital." },
    { id: "fin-4", topic: "lbo", q: "In an LBO, name the three main sources of returns.", key: ["debt paydown", "multiple expansion", "ebitda growth"], expect: "EBITDA growth, debt paydown (equity build), multiple expansion." },
    { id: "fin-5", topic: "accounting", q: "If working capital increases, what happens to cash flow and why?", key: ["decrease", "cash", "inventory", "receivables"], expect: "Cash flow decreases — cash is tied up in inventory/receivables." },
  ];
  const QUANT_DRILL = [
    { id: "q-1", topic: "probability", q: "Expected number of fair-coin flips to get two heads in a row?", answer: 6, tol: 0.01, expect: "6 (states: E0=1+E1/2+E0/2 etc.)." },
    { id: "q-2", topic: "probability", q: "Roll two dice. Probability the sum is 8?", answer: 5 / 36, tol: 0.01, expect: "5/36 ≈ 0.139." },
    { id: "q-3", topic: "mental_math", q: "What is 17 x 24?", answer: 408, tol: 0, expect: "408." },
    { id: "q-4", topic: "expected_value", q: "A game pays $10 with probability 0.3 and $0 otherwise, and costs $2 to play. Expected value of playing?", answer: 1, tol: 0.01, expect: "0.3*10 - 2 = +$1." },
    { id: "q-5", topic: "probability", q: "Three cards are drawn without replacement from a standard deck. Probability all three are aces? (decimal)", answer: (4 / 52) * (3 / 51) * (2 / 50), tol: 0.001, expect: "≈ 0.00018." },
  ];
  function financeDrill() {
    // BUG-218: the DCF drill (fin-2) carries the bank's full model answer
    // alongside its keyword expect — the drill's answer is the researched
    // outline in ib-finance.md §C, not a one-line keyword summary.
    let dcfModel = null;
    try { const fin = interviewBanks().finance; const dcfItem = fin && fin.items.find((x) => /\bdcf\b/i.test(x.q) && x.answer); if (dcfItem) dcfModel = dcfItem.answer; } catch { dcfModel = null; }
    return { kind: "finance", questions: FINANCE_DRILL.map(({ id, topic, q, expect }) => ({ id, topic, q, expect, ...(topic === "dcf" && dcfModel ? { model_answer: dcfModel } : {}) })) };
  }
  function quantDrill() { return { kind: "quant", questions: QUANT_DRILL.map(({ id, topic, q, expect }) => ({ id, topic, q, expect })) }; }
  function gradeDrillAnswer(kind, id, answer) {
    if (kind === "finance") { const d = FINANCE_DRILL.find((x) => x.id === id); if (!d) return null;
      const low = lc(answer); const hits = d.key.filter((k) => low.includes(k)); const score = Math.round((hits.length / d.key.length) * 5);
      return { id, topic: d.topic, score_0_5: score, hits, missed: d.key.filter((k) => !low.includes(k)), answer_key: d.expect, gap: score >= 4 ? null : `Missing: ${d.key.filter((k) => !low.includes(k)).join(", ")}` }; }
    const d = QUANT_DRILL.find((x) => x.id === id); if (!d) return null;
    const cleaned = s(answer).replace(/[^0-9.\-\/]/g, "");
    let num = NaN;
    if (/^-?\d+(\.\d+)?\/\d+(\.\d+)?$/.test(cleaned)) { const [a, b] = cleaned.split("/"); num = parseFloat(a) / parseFloat(b); }
    else num = parseFloat(cleaned.replace(/\//g, ""));
    const ok = !isNaN(num) && Math.abs(num - d.answer) <= Math.max(d.tol, Math.abs(d.answer) * 0.02);
    return { id, topic: d.topic, correct: ok, your_answer: isNaN(num) ? s(answer) : num, answer_key: d.expect, score_0_5: ok ? 5 : 0 };
  }
  function runDrill(store, kind, answers) {
    const set = kind === "finance" ? financeDrill() : quantDrill();
    const graded = set.questions.map((q) => gradeDrillAnswer(kind, q.id, (answers || {})[q.id] || ""));
    const row = { kind, graded, total: graded.reduce((n, g) => n + (g ? g.score_0_5 : 0), 0), max: graded.length * 5, at: new Date().toISOString(),
      gaps: graded.filter((g) => g && g.score_0_5 < 4).map((g) => g.gap || `${g.topic}: expected ${g.answer_key}`) };
    store.drills.push(row); return row;
  }

  // ---------- case prep ----------
  function caseSession(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    const style = n && n.styles[0] ? n.styles[0] : null;
    return { company: n ? n.company_name : (s(opts.company) || null), cir_grounded: !!n,
      practice_norms_label: n ? "Norms below are from the company file on file and keep their source labels; community practice-count advice is folklore and is NOT quantified." : "No company file on file for this company — generic case framework only; no company-specific norms claimed.",
      style: style ? { text: style.text, source_type: style.source && style.source.source_type } : null,
      case_prompt: "Your client is a regional grocery chain whose profits fell 15% last year while revenue grew 5%. Find out why and recommend what to do.",
      framework: ["Clarify the objective and constraints", "Structure: revenue (price x volume x mix) vs costs (COGS, labour, logistics, shrink)", "Hypothesise, then ask for the data that discriminates", "Synthesise: recommendation, risks, next steps"] };
  }
  // Case prep plan (SC-185 canonical): the 30-50 practice-case norm is community
  // folklore, labeled as such; every plan line is plain prose — no function names.
  function casePrepPlan(opts) {
    opts = opts || {}; const session = caseSession(opts);
    const weeks = opts.weeks || 6, perWeek = opts.casesPerWeek || 7;
    const focuses = ["framework + structuring drills first", "mix of interviewer-led cases + mental-math/market-sizing drills", "mix of interviewer-led cases + mental-math/market-sizing drills", "mix of interviewer-led cases + mental-math/market-sizing drills", "mix of interviewer-led cases + mental-math/market-sizing drills", "timed, interviewer-led, full feedback loop"];
    const plan = [];
    for (let w = 1; w <= weeks; w++) plan.push(`Week ${w}: ${perWeek} cases (${focuses[Math.min(w - 1, focuses.length - 1)]}), each answer scored against the case rubric and the gaps re-drilled next session`);
    return { kind: "case_prep_plan", company: session.company, cir_grounded: session.cir_grounded, company_file_grounded: session.cir_grounded,
      style: session.style, framework: session.framework, case_prompt: session.case_prompt,
      practice_norm: { low: 30, high: 50, unit: "full practice cases before interviews", label: "community-reported", official: false,
        note: "This count is community-reported preparation folklore passed on by candidates and prep communities — it is NOT published or endorsed by any MBB firm, and the company files do not quantify it. It is a planning target, not a requirement." },
      schedule: { weeks, sessions_per_week: perWeek, total_cases: weeks * perWeek, inside_norm: weeks * perWeek >= 30 && weeks * perWeek <= 50, plan },
      text: `Practice norm, labeled honestly: 30-50 full practice cases before interviews (community-reported, not official). Schedule: ${weeks} weeks, ${perWeek} cases a week, ${weeks * perWeek} total.` };
  }
  function scoreCaseResponse(resp) {
    const low = lc(resp); const checks = {
      clarified_objective: /\b(objective|goal|clarify|profit|question)\b/.test(low),
      structured: /\b(first|second|branch|split|structure|revenue|cost)\b/.test(low),
      hypothesis_led: /\b(hypothesis|hypothesise|hypothesize|because|driver)\b/.test(low),
      asked_for_data: /\b(data|numbers|breakdown|segment|trend|compare)\b/.test(low),
      recommendation: /\b(recommend|therefore|so the|next step)\b/.test(low),
    };
    const score = Object.values(checks).filter(Boolean).length;
    const judgment = frameworkCheck(resp);
    const feedback = Object.entries(checks).filter(([, v]) => !v).map(([k]) => `Missing: ${k.replace(/_/g, " ")}`);
    if (judgment.missing_judgment) feedback.push("Missing judgment: the framework is recited but no actual decision or recommendation for this case is made.");
    return { score_0_5: score, checks, judgment, feedback };
  }

  // ---------- PREP-006 interviewer research (public facts only, supplied by caller) ----------
  function interviewerBrief(person) {
    person = person || {};
    const facts = (person.publicFacts || []).filter((f) => f && s(f.text));
    if (!facts.length) return { name: s(person.name), role: s(person.role || "") || null, company: s(person.company || "") || null,
      status: "UNKNOWN", known: [s(person.role || ""), s(person.company || "")].filter(Boolean),
      brief: [], unknown: ["background and prior roles", "team and focus areas", "public talks or posts"],
      note: "No public professional facts were supplied for this person, so no bio is invented. Prep from the role and the company file instead." };
    return { name: s(person.name), role: s(person.role || "") || null, company: s(person.company || "") || null, status: "OK",
      brief: facts.map((f) => ({ text: s(f.text), source: s(f.source || "provided public fact") })), unknown: [],
      note: "Built only from the public professional facts supplied; nothing inferred about private life." };
  }

  // ---------- PREP-007 debrief + thank-you ----------
  function captureDebrief(store, d) {
    const row = { debrief_id: "debrief-" + hash(s(d.company) + s(d.at || "") + store.debriefs.length), company: s(d.company), role: s(d.role || ""),
      interviewer: s(d.interviewer || ""), went_well: d.wentWell || [], stumbled: d.stumbled || [], questions_asked: d.questionsAsked || [],
      follow_up_by: s(d.followUpBy || "same day"), at: d.at || new Date().toISOString() };
    store.debriefs.push(row); return row;
  }
  function thankYouDraft(opts) {
    opts = opts || {}; const d = opts.debrief || {};
    const specific = (d.went_well && d.went_well[0]) || (d.questions_asked && d.questions_asked[0]) || "our conversation";
    return { to: s(opts.interviewer || d.interviewer || ""), subject: `Thank you — ${s(opts.company || d.company)} ${s(opts.role || d.role || "")} conversation`.trim(),
      body: `Hi ${s((opts.interviewer || d.interviewer || "").split(" ")[0] || "there")},\n\nThank you for your time today. I especially enjoyed discussing ${specific} — it sharpened how I think about the work your team is doing at ${s(opts.company || d.company)}.\n\nI'd welcome the chance to continue the conversation. Thanks again for considering me.\n\nBest,\n${s(opts.senderName || "")}`,
      status: "draft_only", note: "Draft on a card for the user's approval — never auto-sent." };
  }

  // ---------- salary-talk prep (NEGO-002 seam) ----------
  function salaryPrep(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    if (!n) return { status: "NO_CIR", company: s(opts.company || ""), ranges: [], script: null, note: "No company file on file — no comp numbers are claimed or invented." };
    const withFigures = n.compNotes.filter((c) => /\$\s?\d/.test(c.text));
    return { status: withFigures.length ? "OK" : "NO_SOURCED_FIGURE", company: n.company_name,
      ranges: withFigures.map((c) => ({ text: c.text, label: c.label, source_type: c.source && c.source.source_type, source_url: c.source && c.source.source_url })),
      all_comp_notes: n.compNotes.map((c) => ({ text: c.text, label: c.label })),
      script: "“I'm focused on finding the right role and team first. Based on the range published for this role [cite the sourced figure above], I'm comfortable discussing a package in that band once we get there — could you share the band budgeted for this level?”",
      note: withFigures.length ? "Every figure above is copied from the company file comp notes with its source label; nothing is estimated." : "The company file explicitly records that no figure is published for this company — say so, anchor on the role's posted band if the employer shares one, and do not invent a number." };
  }

  // Coffee-chat prep (SC-182 canonical): who/path/talking points/questions,
  // grounded in the company file's own values; plain prose only.
  function coffeeChatPrep(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const c = opts.contact || {};
    const pathIn = opts.path || [s(c.path || "")].filter(Boolean);
    const value = n && n.values[0] ? n.values[0].text : null;
    const talking = [];
    if (value) talking.push(`What the company says it optimizes for: ${value}`);
    if (pathIn.length) talking.push(`Their path in: ${pathIn.join(" -> ")} — ask what each step actually taught them.`);
    if (opts.sharedGround) talking.push(`Real shared ground: ${opts.sharedGround} — open there, briefly, then get out of the way.`);
    while (talking.length < 3) talking.push("What their team actually spends its week on, and what surprised them most after joining.");
    const questions = [
      "What does your team actually spend its week on — and what would surprise an outsider about that split?",
      n && n.bar ? `The company's stated bar is: ${n.bar} — what separates people who do well from people who prepare generically?` : "What separates people who do well in the interviews from people who prepare generically?",
      "What did you misunderstand about this role before you started, and when did it click?",
      "If you were starting again from my seat this semester, what would you do in the next 30 days — and what would you stop doing?",
      "Who else should I learn from, and may I mention you connected us?",
    ];
    return { kind: "coffee_chat_prep", who: { name: s(c.name), role: s(c.role || ""), company: s(c.company || (n && n.company_name) || "") },
      path: pathIn, talking_points: talking.slice(0, 3), questions,
      do_not_ask: ["Do not ask for a referral in a first chat — earn the second conversation instead", "Do not ask anything they would have to keep confidential (unreleased products, internal comp, other candidates)", "Do not ask what the role pays — comp questions go to the recruiter, with ranges sourced from the company file only", "Do not pitch yourself for more than 60 seconds total"],
      company_file_grounded: !!n, cir_grounded: !!n };
  }

  // ---------- coffee chat + two-interview + pivot + pack ----------
  function coffeeChatBrief(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const c = opts.contact || {};
    return { kind: "coffee_chat", lighter_than_interview_prep: true, contact: { name: s(c.name), role: s(c.role || ""), company: s(c.company || (n && n.company_name) || "") },
      company_context: n ? { bar: n.bar, values: n.values.slice(0, 2), source: { type: "CIR", company_id: n.company_id } } : null,
      good_questions: ["What does your team actually spend its week on?", "What surprised you most after joining?", "What would you tell someone my year about the application process?", "Who else would you recommend I learn from?"],
      do_not: ["Do not pitch for a referral in a first chat", "Do not ask anything you'd expect them to keep confidential"],
      cir_grounded: !!n };
  }
  function twoInterviewPlan(items) {
    const sorted = [...(items || [])].sort((a, b) => s(a.time).localeCompare(s(b.time)));
    return { ordered: sorted.map((x, i) => ({ order: i + 1, time: x.time, company: x.brief.company || x.company, brief_status: x.brief.status || "OK" })),
      gap_plan: sorted.length > 1 ? `Between ${sorted[0].time} and ${sorted[sorted.length - 1].time}: 20 min reset (no new material), re-read the second company's bar + your two matched stories, eat, and travel/buffer 30 min.` : "Single interview — standard prep.",
      note: "Briefs are delivered in interview order; each brief keeps its own company-file grounding and gaps." };
  }
  function rejectionPivot(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const f = opts.funnel || {};
    const plan = [`Stage reached: ${s(f.stage || "unknown")} at ${s(f.company || "")} — tighten the exact skill that stage tests (timed, scored drills, not re-reading).`,
      "Re-run a scored mock focused on that stage within 48 hours while the experience is fresh.",
      "Keep the story bank — stories transfer; only the stage skill changes."];
    return { status: n ? "OK" : "NO_CIR", company: s(f.company || ""), stage: s(f.stage || "") || null,
      cir_bar: n ? n.bar : null, plan,
      gaps: n ? [] : [`No company file on file for ${s(f.company || "this company")} — the company-specific bar cannot be cited; the plan above is stage-based only.`],
      similar_roles: (opts.similar || []).map((x) => ({ company: x.company, cir_grounded: !!x.cir })) };
  }
  function assemblePack(store, parts) {
    parts = parts || {};
    const sections = [];
    const add = (name, rail, present, payload) => sections.push({ section: name, rail, present: !!present, payload: present ? payload : null });
    add("brief", "PREP-001", parts.brief && parts.brief.status === "OK", parts.brief);
    add("questions", "PREP-002", parts.bank && parts.bank.questions && parts.bank.questions.length, parts.bank);
    add("stories", "PREP-004", parts.stories && parts.stories.length, parts.stories);
    add("interviewer_notes", "PREP-006", parts.interviewers && parts.interviewers.length, parts.interviewers);
    add("logistics", "calendar", parts.logistics, parts.logistics || null);
    const pack = { pack_id: "pack-" + hash(JSON.stringify(sections.map((x) => x.section + x.present))), company: s(parts.company || ""), when: s(parts.when || ""),
      sections, complete: sections.every((x) => x.present), missing: sections.filter((x) => !x.present).map((x) => x.section),
      traceability: sections.map((x) => `${x.section} <- ${x.rail}`) };
    store.packs.push(pack); return pack;
  }

  // ---------- FIN-A1 additions (canonical SC-181..190, 2026-10-13) ----------
  function sharedGround(person, profile) {
    profile = profile || {}; const out = [];
    const factsText = ((person && person.publicFacts) || []).map((f) => s(f.text)).join(" ");
    const low = lc(factsText);
    const check = (label, val) => { if (val && low.includes(lc(val))) out.push({ ground: label, basis: val }); };
    check("same school", profile.school); check("same club", (profile.clubs || [])[0]);
    check("same hometown", s(profile.hometown).replace(/\s*\(TEST\)\s*/g, "")); check("same major", profile.major);
    for (const sk of profile.skills || []) check("shared skill: " + sk, sk);
    return out;
  }
  function interviewerResearch(opts, profileArg) {
    // Chat-path overload (142): interviewerResearch(peopleArray, profile, {})
    if (Array.isArray(opts)) opts = { people: opts, profile: profileArg };
    opts = opts || {};
    const people = (opts.people || []).map((p) => { const b = interviewerBrief(p);
      const whois_line = [b.name, b.role, b.company].filter(Boolean).length
        ? `${b.name}${b.role ? ` — ${b.role}` : ""}${b.company ? ` at ${b.company}` : ""}` : null;
      return { name: b.name, role: b.role, company: b.company, whois_line, team: s(p.team || "") || null, path: p.path || [], status: b.status,
        brief: b.brief, unknown: b.unknown, shared_ground: b.status === "OK" ? sharedGround(p, opts.profile) : [], note: b.note }; });
    return { kind: "interviewer_research", people, grounded: people.filter((p) => p.status === "OK").length,
      note: "Paths, teams and shared ground come only from the public professional facts supplied per person (TEST fixtures in scenario runs); a person with no supplied facts stays UNKNOWN — no bio is invented." };
  }
  function coffeeChatPrep(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const c = opts.contact || {};
    const path = c.path || []; const shared = sharedGround({ publicFacts: c.publicFacts || [] }, opts.profile);
    const cirPoint = n && n.values[0] ? n.values[0].text : (n && n.bar ? n.bar : null);
    const talking_points = [
      cirPoint ? `What the company says it optimizes for: ${cirPoint}` : "Your own shipped work — the thing on your profile with real users and a real number attached.",
      path.length ? `Their path in: ${path.join(" -> ")} — ask what each step actually taught them.` : "How they got into this seat — the step that mattered most is rarely the first one.",
      shared.length ? `Real shared ground: ${shared.map((g) => g.basis).join("; ")} — open there, briefly, then get out of the way.` : "Your current project and the one decision in it you are still unsure about — specific beats impressive."];
    const stylePoint = n && n.styles[0] ? n.styles[0].text : null;
    const questions = [
      "What does your team actually spend its week on — and what would surprise an outsider about that split?",
      stylePoint ? `Your firm's signature round is described as: ${stylePoint.length > 140 ? stylePoint.slice(0, 140).replace(/\s+\S*$/, "") : stylePoint} — what separates people who do well in it from people who prepare generically?` : "Which round or conversation in your process separates strong candidates, and what does 'strong' look like in it?",
      "What did you misunderstand about this role before you started, and when did it click?",
      "If you were starting again from my seat this semester, what would you do in the next 30 days — and what would you stop doing?",
      "Who else should I learn from, and may I mention you connected us?"];
    return { kind: "coffee_chat_prep", who: { name: s(c.name), role: s(c.role || ""), company: s(c.company || (n && n.company_name) || "") },
      path, talking_points, questions,
      do_not_ask: ["Do not ask for a referral in a first chat — earn the second conversation instead", "Do not ask anything they would have to keep confidential (unreleased products, internal comp, other candidates)", "Do not ask what the role pays — comp questions go to the recruiter, with company-file-sourced ranges only", "Do not pitch yourself for more than 60 seconds total"],
      shared_ground: shared, cir_grounded: !!n, cir_source: n ? { type: "CIR", company_id: n.company_id, as_of: n.as_of } : null };
  }
  function systemDesignPrep(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    const drills = technicalDrills(opts); const sd = drills.sets.find((x) => x.type === "system_design");
    return { kind: "system_design_prep", company: n ? n.company_name : null, cir_grounded: !!n, level: s(opts.level || "experienced-hire"),
      prompts: sd ? sd.prompts : ["Design a notification system for 10M users.", "Design a multi-tenant quota service.", "Design a URL shortener, then scale reads 100x."],
      prompt_source: sd ? sd.source : { type: "generic_system_design_bank" },
      framework: ["Clarify requirements and scale numbers out loud before drawing anything", "High-level design: API, data model, core components", "Deep-dive the bottleneck the interviewer steers to; name the trade-off of each choice", "Scale and failure: caching, queues, partitioning, backpressure, observability", "Close with what you would build differently at 10x and why"],
      level_notes: ["Experienced-hire bar: you drive the design — the interviewer should mostly react", "Ground choices in a system you have actually run where you honestly can; say so when you cannot", "Every claim gets a number: QPS, storage, latency budget"] };
  }
  function casePrepPlan(opts) {
    opts = opts || {};
    // BUG-073 (W5): an MBB ask names THREE company files, not one —
    // when the caller passes the file set (opts.cirs), the plan
    // grounds on all of them: sources from each file (each with its
    // own as-of), stages/style from the first, company named as the
    // set it is. A single-file ask keeps the single-file shape.
    const cirSet = Array.isArray(opts.cirs) && opts.cirs.length ? opts.cirs : null;
    const n = normalizeCir(cirSet ? cirSet[0] : opts.cir); const sess = caseSession(opts);
    const weeks = Math.max(2, Math.min(10, opts.weeks || 6));
    const perWeek = Math.max(5, Math.round(40 / weeks)); const total = perWeek * weeks;
    // BUG-092 (template-breakup lane): the plan's spoken text names
    // the SAME target as the record's company field. It used to name
    // n — the set's FIRST file — so an MBB-wide ask was answered as a
    // plan "for Bain & Company", a firm the user never singled out
    // (SC-185). A set is named as the set; a single firm is named
    // only when the ask named that firm.
    const companyLabel = cirSet ? `MBB — ${cirSet.map((c) => (normalizeCir(c) || {}).company_name).filter(Boolean).join(", ")}` : n ? n.company_name : (s(opts.company) || null);
    return { kind: "case_prep_plan", company: companyLabel, cir_grounded: !!n, style: sess.style, framework: sess.framework,
      // BUG-073 (W5): the plan is a prep RECORD — it carries the same
      // status/stages/story-note elements composeBrief's records carry,
      // so the F5 doorstep contract can read it (status mirrors the
      // brief's OK / NO_CIR semantics; stages come from the file).
      status: n ? "OK" : "NO_CIR", stages: n ? n.stages : [],
      company_files: cirSet ? cirSet.map((c) => (normalizeCir(c) || {}).company_id).filter(Boolean) : undefined,
      stories_note: "Story mapping lives in the interview brief, not the case plan — this record maps no stories, and none are invented for it.",
      practice_norm: { low: 30, high: 50, unit: "full practice cases before interviews", label: "community-reported", official: false,
        note: "This count is community-reported preparation folklore passed on by candidates and prep communities — it is NOT published or endorsed by any MBB firm, and the company files do not quantify it. It is a planning target, not a requirement." },
      sources: cirSet ? cirSet.map((c) => { const cn = normalizeCir(c) || {}; return { type: "CIR", company_id: cn.company_id, as_of: cn.as_of }; }) : n ? [{ type: "CIR", company_id: n.company_id, as_of: n.as_of }] : [{ type: "generic_case_framework", label: "No company file on file — generic case framework only; the practice norm is community-reported, not sourced from any firm", as_of: null }],
      text: `Case prep plan${companyLabel ? ` for ${companyLabel}` : ""}: ${total} full practice cases over ${weeks} weeks. Practice norm, labeled honestly: 30-50 full practice cases before interviews (community-reported, not official).`,
      schedule: { weeks, sessions_per_week: perWeek, total_cases: total, inside_norm: total >= 30 && total <= 50,
        plan: Array.from({ length: weeks }, (_, i) => `Week ${i + 1}: ${perWeek} cases (${i === 0 ? "framework + structuring drills first" : i === weeks - 1 ? "timed, interviewer-led, full feedback loop" : "mix of interviewer-led cases + mental-math/market-sizing drills"}), each answer scored against the case rubric and the gaps re-drilled next session`) } };
  }
  const MM_DRILL = [
    { id: "mm-1", topic: "market_making", q: "A stock's fair value you estimate at $10.00. How do you quote, and what moves your spread?", key: ["bid", "ask", "fair value", "spread", "inventory", "informed"], expect: "Bid below / ask above your fair-value estimate; widen with inventory risk, volatility, or informed (adverse-selection) flow." },
    { id: "mm-2", topic: "market_making", q: "You are long 500 shares from fills and a big buy order arrives. What do you do to your quotes and why?", key: ["skew", "lower", "inventory", "sell"], expect: "Skew quotes down (cheaper ask, lower bid) to shed inventory and discourage more buys — you are paid to provide liquidity, not to accumulate directional risk." }];
  function marketMakingDrill() { return { kind: "market_making", questions: MM_DRILL.map(({ id, topic, q, expect }) => ({ id, topic, q, expect })) }; }
  function gradeMarketMaking(id, answer) {
    const d = MM_DRILL.find((x) => x.id === id); if (!d) return null;
    const low = lc(answer); const hits = d.key.filter((k) => low.includes(k)); const score = Math.round((hits.length / d.key.length) * 5);
    return { id, topic: d.topic, score_0_5: score, hits, missed: d.key.filter((k) => !low.includes(k)), answer_key: d.expect, gap: score >= 4 ? null : `Missing: ${d.key.filter((k) => !low.includes(k)).join(", ")}` };
  }
  function quantPrepSet(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const q = quantDrill();
    return { kind: "quant_prep", company: n ? n.company_name : null, cir_grounded: !!n,
      topics: [...new Set([...q.questions.map((x) => x.topic), "market_making"])],
      probability_and_ev: q.questions, market_making: marketMakingDrill().questions,
      drills_note: "Probability/EV/mental-math items are auto-graded numerically (gradeDrillAnswer); market-making items are keyword-graded (gradeMarketMaking). Company framing, where claimed, comes only from the CIR on file." };
  }
  function pmPrep(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const stories = opts.stories || [];
    const shipped = stories.filter((x) => (x.metrics || []).length).sort((a, b) => (b.metrics || []).length - (a.metrics || []).length)[0] || stories[0] || null;
    return { kind: "pm_prep", company: n ? n.company_name : null, cir_grounded: !!n,
      styles: n ? n.styles : [],
      shipped_thing: shipped ? { title: shipped.title, action: shipped.action, result: shipped.result, metrics: shipped.metrics || [], story_id: shipped.story_id } : null,
      product_sense_walkthrough: shipped ? [`Open with the shipped thing: ${shipped.title} — ${shipped.action}; result: ${shipped.result}.`, "Walk it as a product: who the user is, the painful workflow it replaced, the one metric that proved it worked.", "Name a decision you reversed from usage evidence — PM interviewers probe for that specifically."] : ["No shipped story mined from the profile yet — mine one before product-sense prep can anchor."],
      product_sense_questions: ["How would you improve the product you shipped — and what would you measure before building anything?", "Pick a product you use daily: what is its north-star metric, and what input metrics actually move it?", "Your key metric drops 20% week over week. Walk me through your first hour.", "Design this company's product for a user segment it does not serve today."],
      metrics_ready: shipped ? (shipped.metrics || []).map((m) => `${shipped.title}: ${m}`) : [],
      note: "Metrics listed are copied from the user's own profile facts — none are invented for polish." };
  }
  function sendThankYou(store, draft, opts) {
    opts = opts || {};
    if (!draft || draft.status !== "draft_only") return { status: "not_sent", reason: "Only a thankYouDraft (draft_only) can be sent." };
    if (opts.approved !== true) return { status: "not_sent", reason: "Approval card gate: nothing sends without the user's explicit yes." };
    if (!store.sent) store.sent = [];
    const row = { kind: "thank_you", to: draft.to, subject: draft.subject, body: draft.body, status: "sent", sent_at: new Date().toISOString(), rail: "approval_card_approved" };
    store.sent.push(row); return { status: "sent", row };
  }

  // ---------- PREP-008 live assist OFF + voice honesty ----------
  function liveAssistGuard(text) {
    const t = s(text).toLowerCase().replace(/[’‘]/g, "'")
      .replace(/\binterv(?:eiw|ew)\b/g, "interview")
      .replace(/\bansers?\b/g, (word) => word === "anser" ? "answer" : "answers");
    const covert = /\b(hidden|secret(?:ly)?|whisper(?:ing)?|earpiece|overlay|second screen)\b|\bwithout them knowing\b/.test(t);
    const preparation = /\b(practi[cs](?:e|ing)|mock|rehears(?:e|al|ing)|prep|prepar(?:e|ing|ation)|before|after|debrief|review)\b|\bhow did i do\b/.test(t);
    const interview = /\b(interview(?:er|ing)?|onsite|hirevue|coding round|panel)\b/.test(t);
    const streamingQuestions = /\bquestions?\b/.test(t) && /\bas (?:they|my interviewer) ask\b/.test(t);
    const inProgress = streamingQuestions || /\bon (?:the |my )?(?:interview )?call\b/.test(t) || (interview &&
      /\b(during|live|right now|in progress|underway|happening now|has started|is waiting|listen in)\b|\b(?:i'm|i am|im) (?:in|at|taking|doing|recording|interviewing)\b|\b(?:my|the) interviewer (?:just )?(?:ask(?:s|ed)?|is asking)\b|\bin the room\b|\bon (?:zoom|teams|(?:google )?meet)\b/.test(t));
    const asksForHelp = /\b(answers?|say|help|copilot|feed|assist|respond|responses?|solutions?|solve)\b|\btell me\b/.test(t);
    if (asksForHelp && (covert || (inProgress && !preparation))) {
      return { refused: true, ruling: "Owner ruling 2026-10-12: live interview assist is OFF (PREP-008).",
        message: "I can't feed you answers during a real interview — that's off, by decision, not by limitation. What I can do is get you ready: a brief, a scored mock, and drills on the exact round, today.",
        prep_offer: ["a company brief", "a scored mock", "drills on the exact round"] };
    }
    return { refused: false };
  }
  function voiceMockAvailability() {
    return { available: false, reason: "No voice rail is wired for interview prep in this build.", fallback: "text mock (PREP-003) — same questions, same rubric, scores stored the same way." };
  }

  // ---------- finisher A2 additions (SC-191..200, BUG-A2-01..10) ----------
  function videoInterviewPractice(store, opts) {
    opts = opts || {}; const qs = opts.questions || []; const answers = opts.answers || [];
    const feedback = qs.map((q, i) => { const g = scoreAnswer(answers[i] || ""); return { q, scores: g.scores, feedback: g.feedback }; });
    const avg = feedback.length ? Math.round(feedback.reduce((n, f) => n + f.scores.total, 0) / feedback.length * 10) / 10 : 0;
    const row = { kind: "video_practice", company: s(opts.company || ""), count: feedback.length, average_total: avg, at: new Date().toISOString() };
    if (store && store.drills) store.drills.push(row);
    return { kind: "video_interview_practice", label: "TEST recorded-answer practice (transcript supplied in chat; no real camera or employer portal)", company: row.company, feedback, average_total: avg, submitted: false, submission_attempted: false, note: "Practice only — answers are scored on content here and are NEVER submitted to any employer by the agent. Submission, if any, is the user's own act in the employer's portal." };
  }
  function takeHomePlan(opts) {
    opts = opts || {}; const deliverables = opts.deliverables || []; const available = opts.available || [];
    const total_est_min = deliverables.reduce((n, d) => n + (d.est_min || 0), 0);
    const total_available_min = available.reduce((n, b) => n + (b.minutes || 0), 0);
    const schedule = []; let bi = 0, left = available.length ? available[0].minutes : 0;
    for (const d of deliverables) { let need = d.est_min || 0; const parts = [];
      while (need > 0 && bi < available.length) { const use = Math.min(need, left); parts.push(`${available[bi].label}: ${use} min`); need -= use; left -= use; if (left === 0) { bi += 1; left = bi < available.length ? available[bi].minutes : 0; } }
      schedule.push({ deliverable: d.name, est_min: d.est_min || 0, blocks: parts, unscheduled_min: need }); }
    const fits = total_est_min <= total_available_min;
    return { title: s(opts.title || "Take-home"), total_est_min, total_available_min, fits, warning: fits ? null : `Scope is ${total_est_min - total_available_min} min over the time you said you have — cut scope or add a block before starting; do not plan an all-nighter by default.`, schedule, checkpoints: ["After the first deliverable: re-estimate the rest against actual pace", "30 min before the deadline: stop building, write up and check the submission format yourself"], work_stays_mine: true, agent_does_work: false, note: "Plan only. The agent scopes and schedules; it does not do, draft or submit the take-home — the work stays yours." };
  }
  function finalRoundDelta(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    if (!n) return { status: "NO_CIR", company: s(opts.company || ""), final_stage: null, earlier_stages: [], changes: [], gaps: ["No company file is on record for this round — what changes in the final round cannot be claimed."] };
    let fi = n.stages.length - 1; for (let i = n.stages.length - 1; i >= 0; i--) { if (/final|superday|onsite|interview|loop/i.test(n.stages[i].name)) { fi = i; break; } }
    const final = n.stages[fi] || null; const earlier = n.stages.slice(0, fi);
    const changes = [];
    if (final) changes.push(`The final stage on record is "${final.name}"${final.detail ? `: ${final.detail}` : ""} — earlier stages (${earlier.map((x) => x.name).join("; ") || "none recorded"}) are screens; this one is the decision round.`);
    for (const st of n.styles.slice(0, 2)) changes.push(`Format signal for the final round (CIR interview_styles): ${st.text}`);
    changes.push("What changes in practice: breadth screens give way to depth — expect follow-ups on your own resume/stories and the technical core of the role, with several interviewers rather than one screener (grounded only in the stage/style records above).");
    return { status: "OK", company: n.company_name, final_stage: final, earlier_stages: earlier, changes, bar: n.bar, sources: [{ type: "CIR", company_id: n.company_id, as_of: n.as_of }] };
  }
  function salaryDeflectionScripts(opts) {
    const prep = salaryPrep(opts || {});
    const scripts = [
      { when: "early screen", text: "I'm focused on the role and the team first, and I'd rather not anchor on a number before I understand the full scope. Could you share the band budgeted for this level?" },
      { when: "pressed for a number", text: "I don't have a fixed number at this stage — my priority is fit, and I'm confident we can land somewhere fair inside the band for this level once we're both sure it's right." },
      { when: "they share a band", text: "Thanks for sharing that — that's helpful context. I'd like to keep the conversation on the role for now and revisit comp once we're further along." }];
    return { status: prep.status, company: prep.company, ranges: prep.ranges || [], scripts, anchor_rule: "Do not anchor early: never name the first number inside an interview; ask for the employer's band, and cite only a company-file-sourced figure if one exists.", note: prep.note };
  }
  function questionsToAsk(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir); const iv = opts.interviewer || {};
    const brief = interviewerBrief(iv); const team = s(iv.team || "");
    const teamFact = (iv.publicFacts || []).find((f) => /team/i.test(s(f.text)));
    const questions = [];
    if (team) questions.push({ text: `What does the ${team} team actually spend its week on, and what does a strong first project look like on it?`, source: { type: "interviewer_team_supplied", team } });
    else if (teamFact) questions.push({ text: `Your background notes mention: ${teamFact.text} — what is that team focused on this year?`, source: { type: "interviewer_public_fact", source: teamFact.source || "supplied" } });
    if (n) { const fin = n.stages[n.stages.length - 1];
      if (fin) questions.push({ text: `For someone coming through the ${fin.name} stage, what separates the people who thrive here in the first six months?`, source: { type: "CIR process_stages", company_id: n.company_id } });
      for (const v of n.values.slice(0, 2)) questions.push({ text: `The record for this company stresses: ${v.text} — how does that show up in your team's day-to-day decisions?`, source: { type: "CIR values_culture_signals", company_id: n.company_id } });
      for (const sg of n.signals.slice(0, 1)) questions.push({ text: `You screen for ${sg.text} — what does great look like on that in this team specifically?`, source: { type: "CIR screening_signals", company_id: n.company_id } }); }
    questions.push({ text: "What would you want someone in this seat to have accomplished by the end of the first term?", source: { type: "generic_good_question" } });
    // WORDING-BACKLOG (BUG-194): with no team and no company file,
    // the deliverable is the round's STANDARD SET — delivered whole,
    // the team question itself included — and the note says exactly
    // that. The old set shipped one question and claimed company-
    // file grounding the same record elsewhere denied.
    if (!team && !teamFact && !n) {
      questions.unshift({ text: "What does this team's next term look like, and where does this seat plug into it?", source: { type: "standard_set" } });
      questions.push({ text: "What separates the people who thrive here in the first six months from the people who stall?", source: { type: "standard_set" } });
      questions.push({ text: "How is this seat's success measured at the first review, and by whom?", source: { type: "standard_set" } });
    }
    return { company: n ? n.company_name : s(opts.company || ""), interviewer: { name: s(iv.name), role: s(iv.role || "") || null, team: team || null }, team_unknown: !team && !teamFact, interviewer_status: brief.status, questions, note: !team && !teamFact ? (n ? "No team fact was supplied for this interviewer, so no team is invented — the questions are grounded in the company file on record." : "No team or company file was supplied for this interviewer, so no team is invented — these are the round's standard questions, none written for a team or company that isn't named.") : "Team-tailored question is first; the rest are grounded in the company CIR." };
  }
  function failureStoryFromFacts(opts) {
    opts = opts || {};
    // Facts arrive as opts.facts, opts.profile.facts, a bare facts array, or
    // a whole 122 profile (the chat router passes the profile itself).
    const facts = opts.facts || (opts.profile && opts.profile.facts) || (Array.isArray(opts) ? opts : []);
    const hit = facts.find((f) => /\b(fail|failure|setback|missed|broke|broken|rejected|rejection|lost|delay|delayed|dropped|mistake|wrong)\b/i.test([f.title, f.text, f.action, f.result].join(" ")));
    if (!hit) return { status: "NO_SETBACK_FACT", ok: false, story: null, beats: [], ask: ["Tell me about a real setback in your own words: what went wrong, on what (course, project, team)?", "What did you change afterward, and what is different now because of it?", "Is there a number or a before/after I can cite, so the story carries evidence?"], note: "No confirmed fact in the profile describes a setback or failure, so no failure story is built and nothing is invented. The story gets built from your answer, captured with its fact source." };
    const story = { fact_id: hit.id || null, title: s(hit.title), situation: s(hit.text), task: s(hit.title), action: s(hit.action || ""), result: s(hit.result || ""), source: "profile_fact:" + s(hit.id || "unknown") };
    // ok + beats are the shape the chat router reads (st.ok, st.beats): the
    // story's own lines, copied from the fact — never added to.
    const beats = [story.situation, story.action, story.result].filter(Boolean);
    return { status: "OK", ok: true, story, beats, ask: [] };
  }
  function structureDrill(opts) {
    opts = opts || {}; const g = scoreAnswer(opts.answer || "");
    // SC-197: the drill turn ENTERS the drill — a typed start with the exact
    // fix scaffold and the re-mock question issued now, not a description
    // of a drill the user could take later.
    return { kind: "structure_drill", status: "DRILL_STARTED", drill_started: true,
      fix_first: "structure", before_scores: g.scores, scaffold: ["First, the situation: <one line — where, what was at stake>", "My task was: <your specific job, not the team's>", "So I: <2-3 actions, named tools, specifically …>", "In the end, the result was: <a number, measured how, over what period>"], drill: "Re-answer the same question using exactly those four signposts, in order, with no new facts — structure only. Then re-mock and compare the structure score.",
      re_mock: { question: GENERIC_BEHAVIORAL[1], instruction: "Answer this question now using exactly the four scaffold signposts, in order, with no new facts. The re-mock scores structure against the before scores above." },
      note: "The drill changes ordering and signposting only; it never adds facts to a story." };
  }
  function dayOfChecklist(opts, legacyOpts) {
    // Chat-path shape (142): dayOfChecklist(profile, opts) — first argument
    // is a 122 profile, the checklist inputs ride in the second argument.
    if (opts && typeof opts === "object" && legacyOpts && typeof legacyOpts === "object"
      && !opts.when && !opts.link && !opts.company && !opts.cir && (opts.basics || opts.facts || opts.id)) opts = legacyOpts;
    opts = opts || {}; const n = normalizeCir(opts.cir); const missing = [];
    if (!opts.when) missing.push("when"); if (!opts.link) missing.push("link"); if (!opts.company && !n) missing.push("company");
    const groups = {
      logistics: [`When: ${opts.when ? s(opts.when) : "not supplied yet — flagged, not invented"}`, `Company: ${n ? n.company_name : opts.company ? s(opts.company) : "not supplied yet — flagged, not invented"}${n && n.stages.length ? " — stage on record: " + n.stages[n.stages.length - 1].name : ""}`, `Location/joining: ${opts.location || opts.link ? s(opts.location || opts.link) : "not supplied yet — flagged, not invented"}`, "Arrive / join 10 minutes early; ID and a quiet room if in person (TEST plan)"],
      links: opts.link ? [`Interview link (supplied, TEST-labeled where marked): ${opts.link}`, "Open the link once now to confirm it loads; keep it pinned, not buried in email"] : ["NO LINK SUPPLIED — flagged, not invented"],
      tech_check: ["Camera, mic and speaker test in the actual app", "Charger plugged in; notifications off; backup: phone hotspot ready", "Close heavy tabs; water within reach"],
      materials: [...(opts.materials || ["Resume (one page)", "Your two primary STAR stories, one line each", "Your questions-to-ask list", "Pen + paper for names and follow-ups"])] };
    const items = [...groups.logistics, ...groups.links, ...groups.tech_check, ...groups.materials];
    return { company: n ? n.company_name : s(opts.company || ""), when: s(opts.when || "") || null, groups, items, checklist: items, missing, note: "Checklist built from the supplied logistics/link/materials and the CIR stage on record; nothing about the employer's systems is claimed beyond that." };
  }
  function debriefRetro(storeOrOpts) {
    const debriefs = (storeOrOpts && storeOrOpts.debriefs) || (storeOrOpts && storeOrOpts.debriefs === undefined && storeOrOpts.all) || [];
    const rows = Array.isArray(storeOrOpts) ? storeOrOpts : debriefs;
    const buckets = [
      { theme: "technical / valuation depth", re: /technical|valuation|dcf|model|accounting|math|accretion/i },
      { theme: "answer structure", re: /structure|ramble|rambling|organ|order/i },
      { theme: "specificity / evidence", re: /vague|specific|number|evidence|detail/i },
      { theme: "company / role knowledge", re: /company|why here|role knowledge|research/i },
      { theme: "timing / pace", re: /time|slow|rushed|pace/i }];
    const patterns = buckets.map((b) => { const hits = rows.filter((d) => (d.stumbled || []).some((x) => b.re.test(s(x)))); return { theme: b.theme, count: hits.length, companies: hits.map((d) => d.company) }; }).filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
    return { total_debriefs: rows.length, patterns, recurring: patterns.filter((p) => p.count >= 2), top_miss: patterns.length ? patterns[0].theme : null, note: rows.length ? "Mined only from the debriefs stored in the prep store (labeled TEST fixtures in this run); a theme counts once per debrief." : "No debriefs stored — nothing to mine." };
  }
  function superdayPlan(opts) {
    opts = opts || {}; const n = normalizeCir(opts.cir);
    if (!n) return { status: "NO_CIR", company: s(opts.company || ""), final_stage: null, schedule: [], drill_topics: [], gaps: ["No company file is on record for this round — no company-specific superday plan is claimed."] };
    const fin = financeDrill(); const delta = finalRoundDelta({ cir: opts.cir });
    return { status: "OK", company: n.company_name, when: s(opts.when || "") || null, final_stage: delta.final_stage, earlier_stages: delta.earlier_stages,
      drill_topics: fin.questions.map((q) => q.topic + ": " + q.q),
      schedule: [{ at: "T-60 min", block: "Arrive area early; no new material — re-read the bar and your two finance stories (F-004/F-006 pattern)" }, { at: "T-15 min", block: "Tech/room check if virtual, water, pen + paper; phone on silent" }, { at: "Between interviews", block: "2-minute reset: write down each interviewer's name + one specific from the conversation (feeds your thank-yous); do not replay mistakes" }, { at: "Midday", block: "Eat something real; the afternoon technicals (accounting / DCF / LBO topics in the drill set) are the known pressure point" }, { at: "After the last interview", block: "Capture a debrief per interviewer while fresh (went well / stumbled / questions asked) — that is what the retro mines later" }],
      survival_rules: ["Depth over breadth in the final round: follow-ups on your own resume are the test, per the CIR stage record", "If a technical stalls, state your structure out loud and work it — silent freezing is the failure mode, not a wrong first step", "Names + one specific per interviewer, written down immediately"], sources: [{ type: "CIR", company_id: n.company_id, as_of: n.as_of }] };
  }

  // ---------- PREP FILE (beta C03 / A15.1, 2026-11-04): the one-page interview prep File, built from code ----------
  // "Make a one-page interview prep File with five questions and a 30-minute plan" was answered with chat text (one
  // question, "tonight, then stop") and no File: no prep path produced a page. These two pure functions are that path.
  //   prepFileRequest(text)  -> null (not a prep File ask) | { ok, questions, minutes, defaults, problem? }
  //   prepFileData(opts)     -> plan_review data (variant interview_prep) for file_kinds.ts, built only from:
  //       the question bank above (generic + the named role's sector bank), a timed plan whose blocks add up to exactly
  //       the minutes asked, the interview details the person stated in this message, and their CONFIRMED profile facts.
  // Nothing about a company is written (a named company is repeated as the person said it, and its absence of a file is
  // said); what is not known (company, when, where) is listed as not on file, never filled in. One page: at most
  // PREP_FILE_MAX_QUESTIONS questions, at most 5 plan blocks, 3 facts, 4 gaps, short lines, no images.
  const PREP_FILE_MAX_QUESTIONS = 10;
  const PREP_FILE_MIN_MINUTES = 5, PREP_FILE_MAX_MINUTES = 180;
  const PREP_FILE_SOURCE = "Made by Trainee"; // file_kinds.ts MADE: allowed only on code-built (trusted) data
  // More general questions past the five in GENERIC_BEHAVIORAL: role-agnostic, about no company.
  const PREP_FILE_EXTRA = [
    "Tell me about a time you had to learn something new quickly.",
    "Tell me about a time you handled a difficult customer, classmate or coworker.",
    "Tell me about feedback you received and what you did with it.",
    "What would you focus on in your first 30 days in this role?",
    "Where do you want to be in two or three years?",
    "Tell me about a time you had to prioritize several things at once.",
    "What is something you are proud of, and why?",
  ];
  // A support, service or retail role gets customer-facing practice questions (general ones, about no company).
  const PREP_FILE_CUSTOMER = [
    "Tell me about a time you turned an upset customer around.",
    "What do you do when a customer asks something you don't know the answer to?",
    "How do you handle several people needing help at the same time?",
  ];
  const andList = (xs) => (xs.length <= 1 ? s(xs[0] || "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fortyfive: 45, sixty: 60, ninety: 90 };
  const numOf = (w) => { const x = lc(w).replace(/\s+/g, "-"); if (/^\d+$/.test(x)) return Number(x); return NUM_WORDS[x] !== undefined ? NUM_WORDS[x] : null; };
  const NUM = String.raw`(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[- ]?five|forty|sixty|ninety)`;
  // A prep File ask: a page/File/one-pager/sheet, an interview, and a making verb (or the noun phrase alone). Questions
  // ABOUT a prep file ("what goes in a prep file?") and the person's own record ("what's on file") are not asks.
  function prepFileRequest(text) {
    const raw = s(text).replace(/[’`]/g, "'");
    const t = lc(raw);
    if (!/\binterview/.test(t)) return null;
    const doc = /\b(?:prep|preparation|interview)[- ](?:file|page|sheet|doc|document|one[- ]pager)\b|\bone[- ]pag(?:e|er)\b[^.?!]{0,60}\b(?:prep|interview)|\b(?:prep|interview)\b[^.?!]{0,40}\bone[- ]pag(?:e|er)\b|\bcheat[- ]?sheet\b|\bfile\b/.test(t)
      && !/\bon file\b|\bfile (?:a|my|an) (?:complaint|claim|report|taxes)\b/.test(t.replace(/\bprep file\b/g, ""));
    if (!doc) return null;
    if (!/\b(?:make|create|build|put together|give|send|draft|write|prepare|generate|get|need|want|turn|do)\b/.test(t) && !/^\s*(?:an?\s+)?one[- ]page\b/.test(t)) return null;
    if (/^\s*(?:what|how|why|which|should|is|are|does|do)\b/.test(t) && !/\b(?:make|create|build|give|send|put together|generate)\s+(?:me|us)\b/.test(t)) return null;
    const qm = t.match(new RegExp(String.raw`\b${NUM}\s+(?:practice\s+|interview\s+|behaviou?ral\s+|mock\s+|likely\s+|common\s+|sample\s+|key\s+)*questions?\b`)) || t.match(/\b(a dozen|a couple of|a few)\s+(?:\w+\s+)?questions?\b/);
    const mm = t.match(new RegExp(String.raw`\b${NUM}[- ]?(?:minutes?|mins?)\b`)) || t.match(/\b(half[- ]an?[- ]hour|half[- ]hour|an hour|one hour|1 hour|two hours|2 hours|an hour and a half|1\.5 hours?)\b/);
    let questions = 5, minutes = 30;
    const defaults = [];
    if (qm) { const w = lc(qm[1]); questions = w === "a dozen" ? 12 : w === "a couple of" ? 2 : w === "a few" ? 3 : numOf(w); } else defaults.push("questions");
    if (mm) {
      const w = lc(mm[1]);
      minutes = /half/.test(w) && /hour/.test(w) && !/and a half/.test(w) ? 30 : /and a half|1\.5/.test(w) ? 90 : /two|^2/.test(w) && /hour/.test(w) ? 120 : /hour/.test(w) ? 60 : numOf(w);
    } else defaults.push("minutes");
    if (!Number.isFinite(questions) || questions < 1 || questions > PREP_FILE_MAX_QUESTIONS) return { ok: false, questions, minutes, defaults, problem: "questions" };
    if (!Number.isFinite(minutes) || minutes < PREP_FILE_MIN_MINUTES || minutes > PREP_FILE_MAX_MINUTES) return { ok: false, questions, minutes, defaults, problem: "minutes" };
    if (minutes < questions + 2) return { ok: false, questions, minutes, defaults, problem: "fit" };
    return { ok: true, questions, minutes, defaults };
  }
  // The timed plan: blocks whose minutes add up to exactly `minutes`, each at least one minute. The out-loud block gets
  // at least one minute per question; the warm-up, logistics, questions-to-ask and last-pass blocks are a share of the
  // rest and appear only when the time allows them.
  function prepFilePlan(minutes, questions, o) {
    o = o || {};
    const M = minutes, N = questions;
    let warm = Math.max(1, Math.round(M * 0.1));
    let logistics = M >= 10 ? Math.max(1, Math.round(M * 0.1)) : 0;
    let ask = M >= 15 ? Math.max(1, Math.round(M * 0.1)) : 0;
    let last = M >= 20 ? Math.max(1, Math.round(M * 0.15)) : 0;
    // Give back from the optional blocks until the out-loud block has a minute a question.
    const outLoud = () => M - warm - logistics - ask - last;
    for (const take of ["last", "ask", "logistics", "warm"]) {
      while (outLoud() < N) {
        if (take === "last" && last > 0) last -= 1; else if (take === "ask" && ask > 0) ask -= 1; else if (take === "logistics" && logistics > 0) logistics -= 1; else if (take === "warm" && warm > 1) warm -= 1; else break;
      }
    }
    const P = outLoud();
    const per = Math.floor(P / N), extra = P % N;
    const perText = extra === 0 ? `${per} min each` : extra === 1 ? `${per + 1} min for question 1, ${per} min each for the rest` : `${per + 1} min each for questions 1 to ${extra}, ${per} min each for the rest`;
    const blocks = [];
    blocks.push({ min: warm, text: o.facts ? "Read this page; pick one real example from your record below for the \"tell me about a time\" questions." : "Read this page; jot down one real example from work, school or volunteering for the \"tell me about a time\" questions." });
    blocks.push({ min: P, text: `Answer the ${N === 1 ? "question" : `${N} questions`} out loud, ${N === 1 ? `${P} min` : perText}: the situation, what you did, how it turned out.` });
    if (logistics) blocks.push({ min: logistics, text: o.gaps && o.gaps.length ? `Find ${andList(o.gaps)} in your invite, or ask the recruiter.` : "Re-read your invite: the time, the place or call link, and who you are meeting." });
    if (ask) blocks.push({ min: ask, text: "Write two questions to ask them (e.g. what a strong first month looks like)." });
    if (last) blocks.push({ min: last, text: "Redo your weakest answer, shorter. Then stop." });
    let at = 0;
    return blocks.map((b) => { const from = at; at += b.min; return { from, to: at, min: b.min, text: b.text }; });
  }
  // The interview details the person stated in this message: when, where/how, the role, the company. Each is the
  // person's own words, never a lookup.
  function prepFileStated(text, named) {
    const raw = s(text).replace(/[’`]/g, "'");
    const t = lc(raw);
    const out = {};
    const when = t.match(/\b(today|tonight|tomorrow(?: morning| afternoon| evening)?|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: morning| afternoon| evening)?|on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2})\b(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/);
    if (when) out.when = when[0].replace(/^on /, "");
    const how = t.match(/\b(phone screen|phone interview|phone call|video call|video interview|zoom|teams call|google meet|on[- ]?site|in[- ]person|virtual)\b/);
    if (how) out.format = how[1];
    const role = raw.match(/\b(?:for|as)\s+(?:an?|the|my)\s+([A-Za-z][A-Za-z /&+-]{2,40}?)\s+(?:role|job|position|interview|internship)\b/i) || raw.match(/\b(?:my|an?|the)\s+([A-Za-z][A-Za-z /&+-]{2,40}?)\s+interview\b/i);
    if (role) {
      const r = role[1].trim().replace(/^(?:one[- ]page|first[- ]round|final[- ]round|phone|video|virtual|in[- ]person|onsite|on-site)\s+/i, "");
      if (r && !/^(?:one[- ]page|first|final|second|third|next|upcoming|big|real|job|prep|practice|mock|the|this|that|phone|video)$/i.test(r) && !/\b(?:prep|file|page|questions?|plan|round|screen)\b/i.test(r)) out.role = r.toLowerCase();
    }
    if (named && named.company) out.company = s(named.company);
    return out;
  }
  // The person's confirmed facts: a fact still awaiting their word (needs_confirmation, or a status other than
  // confirmed) is never used. A profile built from chat statements is "From you"; a resume's is "From your resume".
  function prepFileFacts(profile) {
    const p = profile && typeof profile === "object" ? profile : null;
    if (!p || !Array.isArray(p.facts)) return [];
    const fromChat = p._fromStatedFacts === true;
    const kindLabel = { experience: "Experience", project: "Project", leadership: "Leadership", education: "Education", skill: "Skills", school: "School", majors: "Study", year: "Year" };
    const order = { experience: 0, project: 1, leadership: 2, education: 3, school: 3, majors: 4, skill: 5, year: 6 };
    return p.facts
      .filter((f) => f && typeof f === "object" && f.needs_confirmation !== true && (f.status == null || f.status === "confirmed") && kindLabel[f.kind])
      .map((f) => ({ kind: f.kind, label: kindLabel[f.kind], text: s(f.text || (f.title ? `${f.title}${f.action ? `: ${f.action}` : ""}` : "") || f.value || "").replace(/\s+/g, " ").trim() }))
      .filter((f) => f.text.length > 3)
      .sort((a, b) => order[a.kind] - order[b.kind])
      .slice(0, 3)
      .map((f) => ({ label: f.label, value: f.text.length > 170 ? `${f.text.slice(0, 168).replace(/\s+\S*$/, "")}…` : f.text, source: fromChat ? "From you" : "From your resume" }));
  }
  function prepFileQuestions(n, o) {
    o = o || {};
    let bank = null;
    try { bank = questionBank({ role: o.role || undefined, roleFamily: o.role || undefined }); } catch { bank = null; }
    const norm = (q) => lc(q).replace(/[^a-z0-9]+/g, " ").trim();
    const generic = new Set(GENERIC_BEHAVIORAL.map(norm));
    const roleQs = ((bank && bank.questions) || []).map((x) => s(x.q)).filter((q) => q && !generic.has(norm(q)) && q.length <= 220);
    if (/\b(?:support|customer|service|retail|cashier|call center|help ?desk|front desk|reception|barista|server|sales associate)\b/i.test(s(o.role))) roleQs.unshift(...PREP_FILE_CUSTOMER);
    const pool = [GENERIC_BEHAVIORAL[0], ...roleQs.slice(0, Math.max(0, n - 2)), ...GENERIC_BEHAVIORAL.slice(1), ...PREP_FILE_EXTRA];
    const seen = new Set(), out = [];
    for (const q of pool) { const k = norm(q); if (!q || seen.has(k)) continue; if (!o.company && /^why this company/i.test(q)) continue; seen.add(k); out.push(q); if (out.length === n) break; }
    return { questions: out, roleBank: roleQs.length > 0 };
  }
  function prepFileData(opts) {
    opts = opts || {};
    const N = opts.questions, M = opts.minutes;
    const stated = opts.stated || {};
    const facts = prepFileFacts(opts.profile);
    const gaps = [];
    if (!stated.company) gaps.push("the company");
    if (!stated.when) gaps.push("the date and time");
    if (!stated.format) gaps.push("where it is or how you join");
    if (!stated.role) gaps.push("the role");
    const qs = prepFileQuestions(N, { role: stated.role, company: stated.company });
    if (qs.questions.length !== N) return null;
    const plan = prepFilePlan(M, N, { facts: facts.length > 0, gaps: gaps.filter((g) => g !== "the role").slice(0, 3) });
    const said = [];
    if (stated.role) said.push({ label: "Role", value: stated.role, source: "From you" });
    if (stated.company) said.push({ label: "Company", value: `${stated.company}. Nothing on this page is about how ${stated.company} interviews${opts.companyFile ? "" : ": no company file is on record for it"}.`, source: "From you" });
    if (stated.when) said.push({ label: "When", value: stated.when, source: "From you" });
    if (stated.format) said.push({ label: "Format", value: stated.format, source: "From you" });
    const GAP_LABEL = { "the company": "Company", "the date and time": "When", "where it is or how you join": "Where", "the role": "Role" };
    const sections = [];
    if (said.length) sections.push({ heading: "Your interview, as you said it", items: said });
    sections.push({ heading: `${N} practice ${N === 1 ? "question" : "questions"}`, items: qs.questions.map((q, i) => ({ label: `Question ${i + 1}`, value: q, source: PREP_FILE_SOURCE })) });
    sections.push({ heading: `Your ${M}-minute plan`, items: plan.map((b) => ({ label: `Minute ${b.from} to ${b.to} (${b.min} min)`, value: b.text, source: PREP_FILE_SOURCE })) });
    if (facts.length) sections.push({ heading: "From your record (confirmed facts only)", items: facts });
    if (gaps.length) sections.push({ heading: "Not on file yet", items: gaps.slice(0, 4).map((g) => ({ label: GAP_LABEL[g], value: g === "the company" ? "You didn't name it, so nothing here is about a specific company." : g === "the role" ? "Not named, so the questions are general." : g === "the date and time" ? "You didn't say when." : "You didn't say where or how you join.", source: PREP_FILE_SOURCE })) });
    const title = `Interview prep: ${N} ${N === 1 ? "question" : "questions"}, ${M} minutes`;
    return {
      data: { title, variant: "interview_prep", period: "General practice, not facts about any company.", sections },
      summary: { questions: N, minutes: M, plan_minutes: plan.map((b) => b.min), facts: facts.length, gaps: gaps.slice(0, 4), role_bank: qs.roleBank, defaults: opts.defaults || [] },
    };
  }

  return { normalizeCir, findCir, cirLibrary, interviewPatterns,jdKeywords, composeBrief, questionBank,
    prepFileRequest, prepFileData, prepFilePlan, prepFileStated, prepFileAndList: andList, PREP_FILE_MAX_QUESTIONS, PREP_FILE_MIN_MINUTES, PREP_FILE_MAX_MINUTES, PREP_FILE_SOURCE, videoInterviewPractice, takeHomePlan, finalRoundDelta, salaryDeflectionScripts, questionsToAsk, failureStoryFromFacts, structureDrill, dayOfChecklist, debriefRetro, superdayPlan,
    makePrepStore, mineStories, captureStory, findStories, buildStoryBank, storyTags,
    scoreAnswer, startMock, answerMock, answerProbe, mockSummary,
    domainCheck, frameworkCheck, generateVariant, answerVariant, checkAnswerClaims, detectContradiction,
    isConfidentialText, makeShareableExample, accessibilityMode, recordingConsent, handlePrepTurn,
    technicalDrills, financeDrill, quantDrill, gradeDrillAnswer, runDrill,
    caseSession, scoreCaseResponse, interviewerBrief, captureDebrief, thankYouDraft,
    salaryPrep, coffeeChatBrief, twoInterviewPlan, rejectionPivot, assemblePack,
    interviewerResearch, sharedGround, coffeeChatPrep, systemDesignPrep, casePrepPlan,
    quantPrepSet, marketMakingDrill, gradeMarketMaking, pmPrep, sendThankYou,
    liveAssistGuard, voiceMockAvailability, GENERIC_BEHAVIORAL,
    interviewBanks, parseInterviewBank, bankSectorFor, BANK_FILES };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerPrep;
