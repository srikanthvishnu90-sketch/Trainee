/* Career tailoring + truth audit (Doc 2 §3, §3.5, §4.2, S8; capabilities
   APPL-001, APPL-002, APPE-002, APPE-003, APPE-004).
   Pipeline (Doc 2 §3.1): parse the JD (must-have vs nice-to-have, level,
   keywords) -> select profile facts ranked by relevance / recency / impact
   -> assemble bullets where EVERY output line carries its fact IDs ->
   role-family variant conventions -> truth audit as a HARD GATE -> ATS-safe
   render (single-column plain text + clean markdown; standard headings).
   TRUTH AUDIT (APPE-002): auditResume(lines, profile) maps every content
   line to >=1 CONFIRMED fact ID whose text supports it. A keyword/skill may
   appear ONLY if a profile fact evidences that skill. A number may appear
   only if a supporting fact states it. Anything unmappable is a violation,
   and tailorResume REFUSES: { ok:false, refused:true, violations, output:
   null } — a tailored resume is never shipped with an audit warning.
   Unconfirmed (needs_confirmation) facts support nothing: resume-ingested
   drafts must be confirmed by the user first.
   DOCUMENTS (CA-02, Spec 3 v2 §10.4 + §2.5): render() also returns real
   PDF + DOCX artifacts rendered from this same resume JSON by
   packages/domain/148-career-render.js (a hand-built text pipeline —
   PDF 1.4 + OOXML, no dependencies; NOT the 62-agent-documents.js vault,
   which is metadata only). Each render is parse-checked there with two
   independent parsers per format; the verdict (PASS/WARN/FAIL + reasons,
   never a numeric score) rides on rendered.parseCheck. In a runtime
   where 148 is not loaded, render() falls back to text + markdown with
   pdf/docx null and a note saying exactly that.
   AI-USE RULES (Doc 2 S8, owner ruling 2026-10-12): when the CIR input says
   the company bans AI-written application text (cir.aiPolicy === "ban" or
   cir.bansAiWrittenText), tailorResume degrades to mode:"outline" —
   outline + fact-cited bullets for the USER to write from — and no cover
   letter prose is generated at all.
   Banned phrases: shared with Doc 1 §3.2 (outreach) plus Doc 2 §3.4 cover
   letter filler. Cover letters are linted; a banned phrase is a failure,
   never shipped.
   Pure: profile, JD text and CIR are passed in. UMD. */
const CareerTailor = (() => {
  const Profile = typeof CareerProfile !== "undefined" ? CareerProfile : require("./122-career-profile.js");
  // Same negative D-007 predicate as _shared/fact_quarantine.ts; Node tests bundle that pure TS module and
  // compare this consumer at the ID boundaries and provenance cases. No source row is changed or deleted.
  const quarantinedFact = (f) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    // F-033 ruling (2026-10-21): the bank range is read from factId only. A chat profile numbers its own facts
    // F-001 up in id, and those are the person's own, so an id alone never quarantines a fact.
    const m = /^F-0*(\d+)$/.exec(String(f.factId == null ? "" : f.factId).trim());
    if (m && Number(m[1]) >= 27 && Number(m[1]) <= 79) return true;
    return /owner-delegated|answer-all/i.test(String(f.provenance == null ? "" : f.provenance));
  };
  const sourceLabel = (v) => typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  const deniedLabel = (v) => /^(?:agent|assistant|model|llm|ai|inferred|generated|(?:agent|assistant|model|ai)-generated|quarantined|rejected)$/.test(sourceLabel(v));
  const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const deniedRecord = (v) => v.unproven === true || v.quarantined === true || v.rejected === true ||
    sourceLabel(v.status) === "rejected" || deniedLabel(v.source) || deniedLabel(v.origin);
  // Negative metadata mirrors personal_fact_source.ts; it is never inferred from title/text/skills.
  const contentSourceDenied = (v) => record(v) && (quarantinedFact(v) || deniedRecord(v) || deniedLabel(v.provenance) || record(v.provenance) && deniedRecord(v.provenance));
  function contentProfile(profile) {
    const facts = profile && Array.isArray(profile.facts) ? profile.facts : [];
    const idsOf = (f) => [f && f.id, f && f.factId].filter((id) => typeof id === "string" && id.trim());
    const denied = new Set(), deniedIds = new Set(), known = new Set(facts.flatMap(idsOf));
    const deny = (f) => { denied.add(f); for (const id of idsOf(f)) deniedIds.add(id); };
    for (const f of facts) if (contentSourceDenied(profile) || !f || typeof f !== "object" || contentSourceDenied(f) ||
      f.needs_confirmation || f.status !== undefined && f.status !== "confirmed") deny(f);
    // A reference is bad when its parent is absent or denied by its own row; a bare id in the D-007 range is not a bank id.
    const badRef = (id) => typeof id !== "string" || !id.trim() || !known.has(id) || deniedIds.has(id);
    for (let changed = true; changed;) {
      changed = false;
      for (const f of facts) {
        if (denied.has(f)) continue;
        // Both stored derivation spellings are dependency declarations; a confirmed child cannot erase its source.
        // Domain skill evidence entries are fact-ID links too, not independent permission to repeat an excluded claim.
        const fields = ["derived_from", "derivedFrom", ...(f.kind === "skill" ? ["evidence"] : [])];
        const bad = idsOf(f).some((id) => deniedIds.has(id)) || fields.some((key) => Object.prototype.hasOwnProperty.call(f, key) &&
          (!Array.isArray(f[key]) || f[key].some(badRef)));
        if (bad) { deny(f); changed = true; }
      }
    }
    return Object.assign({}, profile || {}, { facts: facts.filter((f) => !denied.has(f)) });
  }
  // CA-02 document renderer (148) is loaded lazily, only when render()
  // runs — same global-or-require pattern as Profile above.
  let _renderMod;
  function renderModule() {
    if (_renderMod !== undefined) return _renderMod;
    _renderMod = null;
    if (typeof CareerRender !== "undefined") _renderMod = CareerRender;
    else if (typeof require !== "undefined") { try { _renderMod = require("./148-career-render.js"); } catch { _renderMod = null; } }
    return _renderMod;
  }

  const BANNED_PHRASES = [
    "i hope this email finds you well",
    "i came across your profile and was impressed",
    "pick your brain",
    "i'd love to connect",
    "i am writing to express my interest",
    "to whom it may concern",
    "passionate team player",
    "results-driven professional",
    "team player with a proven track record",
    "synergy",
    "think outside the box",
    "fast-paced environment enthusiast",
  ];
  function bannedPhrasesIn(text) {
    const t = String(text || "").toLowerCase();
    return BANNED_PHRASES.filter((p) => t.includes(p));
  }

  // Skill lexicon for JD parsing + audit keyword checks. Deliberately finite:
  // a word not in this list is ordinary prose, not a claimed skill.
  // BUG-056 (FV-10/SS-3/SS-9): the lexicon was SWE/finance/data/design only —
  // parseJD extracted ZERO requirements from every real medicine, law,
  // real-estate and consulting JD (no Epic/CNA/BLS, no Westlaw/LexisNexis,
  // no Argus/NOI/IRR/underwriting, no user stories/Agile), so relevance,
  // must-have gating and coverage all ran on keywords alone exactly where
  // credentials matter most. Extended per market, same finite discipline.
  const SKILL_LEXICON = ["Python", "JavaScript", "TypeScript", "Java", "C++", "C#", "Go", "Rust", "Ruby", "Swift", "Kotlin", "SQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "React", "Angular", "Vue", "Node.js", "Django", "Flask", "Spring", "Kubernetes", "Docker", "Terraform", "AWS", "GCP", "Azure", "Git", "Linux", "Machine Learning", "TensorFlow", "PyTorch", "Pandas", "NumPy", "Excel", "Financial Modeling", "Valuation", "Bloomberg", "Capital IQ", "PowerPoint", "Tableau", "Figma", "Photoshop", "A/B Testing", "Statistics", "Probability", "Data Structures", "Algorithms", "System Design", "CI/CD", "GraphQL", "REST", "Spark", "Hadoop", "R",
    "Patient Care", "Vital Signs", "Phlebotomy", "Epic", "EHR", "EMR", "BLS", "CNA", "Medical Assistant", "Medical Assistant Certification", "Utilization Review", "Case Management", "Clinical Documentation", "Nursing License", "RN License", "Registered Nurse",
    "Legal Research", "Legal Writing", "Westlaw", "LexisNexis", "E-Filing", "Legal Calendaring", "Contract Review", "Legal Operations",
    "Argus", "NOI", "DSC", "DSCR", "IRR", "Cap Rate", "Underwriting", "Rent Roll", "CoStar", "Asset Management", "Escrow", "Pro Forma", "Salesforce", "Real Estate License", "Real Estate",
    "User Stories", "Agile", "Jira", "Confluence", "Requirements Analysis", "Stakeholder Management", "Business Analysis", "Consulting", "Change Management", "Project Management"];
  const _lexLower = new Map(SKILL_LEXICON.map((s) => [s.toLowerCase(), s]));
  function skillsInText(text) {
    const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9+#. ]/g, " ")} `;
    const found = [];
    for (const s of SKILL_LEXICON) {
      const needle = ` ${s.toLowerCase()} `;
      // single-letter / dotted skills need token care; substring on padded text is the deterministic rule here.
      if (t.includes(needle) || t.includes(` ${s.toLowerCase()},`) || t.includes(` ${s.toLowerCase()}.`)) if (!found.includes(s)) found.push(s);
    }
    return found;
  }
  const numbersIn = (text) => (String(text || "").match(/\d[\d,.]*%?/g) || []).map((x) => x.replace(/,/g, ""));

  // ---- JD parsing (Doc 2 §3.1 step 1) ----
  // BUG-057 (FV-5/SS-8): parseJD treated the ENTIRE JD as the must-have zone,
  // so lexicon tokens in culture boilerplate, season dates and example
  // project stacks were invented as requirements ("Spring" from a graduation
  // season, "Spark" from "spark innovation", "Go" from "go lives",
  // Java/Angular from a Sample Projects paragraph describing the TEAM's
  // stack) — and the eligibility judge then enforced the inventions.
  // Extraction is now section-scoped: the JD is segmented by its own
  // headings; example/boilerplate segments never contribute must-haves; a
  // skill counts as a must-have only inside a requirements segment, or in a
  // requirement-shaped sentence / repeated mention when the JD has no
  // requirements segment; ambiguous tokens (Spring, Spark, Go, R) count only
  // with technical context in the same sentence.
  const AMBIGUOUS_SKILLS = new Set(["Spring", "Spark", "Go", "R"]);
  const REQ_SHAPE = /(required|requirements?|qualifications?|experience (with|in)|proficien|knowledge of|familiar|expertise|must (have|bring|be|hold)|you (have|bring)|looking for|strong (skills|understanding|ability)|demonstrated|ability to|skills (in|using|with)|proficient)/i;
  const TECH_CONTEXT = /(programming|language|framework|back[- ]?end|front[- ]?end|software|develop|engineer|stack|code|coding|technolog|apache|data (pipeline|engineering|platform))/i;
  const SEGMENT_HEADINGS = [
    [/sample projects|example projects|examples of projects|projects you (could|might) work on/i, "example"],
    [/about (us|the company|the team)|who we are|why join|benefits|perks|compensation|equal opportunity|equal employment|our culture|life at/i, "boilerplate"],
    [/what you.?ll do|responsibilities|position responsibilities|about the role|what you will do|your role/i, "duties"],
    [/required|requirements?|qualifications|what you|what we|we look for|who you are|you bring|you have|your background|minimum|preferred|skills/i, "requirements"],
  ];
  function jdSegments(raw) {
    const segments = [{ kind: "intro", text: "" }];
    const lines = String(raw || "").split(/\n+/);
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      let headed = false;
      if (line.length < 110) {
        for (const [re, kind] of SEGMENT_HEADINGS) {
          const m = line.match(re);
          if (m) {
            // "Requirements: Medical Assistant Certification …" — the text
            // after the colon is segment CONTENT, not part of the heading.
            const colon = line.indexOf(":");
            const rest = colon >= 0 && colon > m.index ? line.slice(colon + 1).trim() : (line.length <= 60 ? "" : line);
            segments.push({ kind, text: rest || "" });
            headed = true;
            break;
          }
        }
      }
      if (!headed) segments[segments.length - 1].text += (segments[segments.length - 1].text ? " " : "") + line;
    }
    return segments.filter((sg) => sg.text || sg.kind !== "intro");
  }
  function sentencesOf(text) { return String(text || "").split(/(?<=[.;])\s+/).map((x) => x.trim()).filter(Boolean); }
  function skillQualifies(skill, zoneSegs, inRequirementsSegment) {
    const zoneText = zoneSegs.map((sg) => sg.text).join(" ");
    const hits = [];
    for (const sg of zoneSegs) for (const sent of sentencesOf(sg.text)) if (skillsInText(sent).includes(skill)) hits.push(sent);
    if (!hits.length) return false;
    if (AMBIGUOUS_SKILLS.has(skill)) {
      // A season/verb must never become a skill: require technical context
      // NEAR the token (JD requirement lists are run-on mega-sentences, so
      // whole-sentence context lets a distant "software" vouch for a
      // graduation-season "Spring" 200 characters away).
      for (const sent of hits) {
        const low = sent.toLowerCase(), needle = skill.toLowerCase();
        let idx = low.indexOf(needle);
        while (idx >= 0) {
          const win = low.slice(Math.max(0, idx - 70), idx + needle.length + 70);
          if (TECH_CONTEXT.test(win) || skillsInText(win).some((x) => x !== skill && !AMBIGUOUS_SKILLS.has(x))) return true;
          idx = low.indexOf(needle, idx + 1);
        }
      }
      return false;
    }
    if (inRequirementsSegment) return true; // the JD's own requirements section IS the requirement shape
    const zoneCount = skillsInText(zoneText).filter((x) => x === skill).length;
    return hits.some((sent) => REQ_SHAPE.test(sent) || sent.split(/\s+/).length <= 14) || zoneCount >= 2;
  }
  // Knockout requirements carried on the parse (FV-7 fix direction: the
  // eligibility stage reads these, it does not re-guess from prose). The
  // enforcing implementation lives in 121 (detectKnockouts/evaluateKnockouts,
  // BUG-050); this is the same pattern family, surfaced for tailor callers.
  function extractKnockouts(text) {
    const out = [];
    for (const sent of sentencesOf(text)) {
      const sl = sent.toLowerCase();
      const lic = sl.match(/([a-z][a-z&' -]{0,44}?)\s(licen[cs]e|licensure)\b/);
      if (lic && /(active|unrestricted|current|valid|must|required|hold|maintain|possess|eligib|requirements?\s*:)/.test(sl)) out.push({ type: "license", requirement: `${lic[1].trim().split(/\s+/).slice(-4).join(" ")} license`, evidence: sent.slice(0, 220) });
      // Named certification knockouts (BUG-209): 121's detectKnockouts has
      // always caught this class ("Medical Assistant Certification" under a
      // Requirements heading); 123's extractor missed it, so a certification
      // knockout could be silently dropped by the tailor even though the
      // jobs module would have flagged it. Same pattern family as 121.
      const cert = sl.match(/([a-z][a-z&' -]{0,44}?)\s(certification|certificate)\b/);
      if (cert && /(requirements?\s*:|required|must (hold|have|possess|maintain|be)|certification\s*$|certification\s+\d)/.test(sl) && !/degree|bachelor|master/.test(sl)) out.push({ type: "certification", requirement: `${cert[1].trim().split(/\s+/).slice(-3).join(" ")} certification`, evidence: sent.slice(0, 220) });
      if (/\bjd\b/.test(sl) && /(law school|juris|from a|degree)/.test(sl)) out.push({ type: "degree", level: "jd", requirement: "JD (Juris Doctor) degree", evidence: sent.slice(0, 220) });
      else if (/\bdegree\b/.test(sl) && /(required|must (hold|have|possess)|is required)/.test(sl) && !/(graduating|pursuing|currently enrolled|rising (senior|junior|sophomore))/.test(sl)) out.push({ type: "degree", level: /master/.test(sl) ? "master" : /associate/.test(sl) ? "associate" : "bachelor", requirement: "conferred degree", evidence: sent.slice(0, 220) });
      const ym = sl.match(/(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d+)(?:\s*[-–]\s*\d+)?\s*\+?\s*years?\b[^.;]{0,40}?experience/) || sl.match(/(\d+)\s*\+\s*years?\s+of\s+[^.;]{0,90}?experience/) || sl.match(/(\d+)\s*[-–]\s*\d+\s*years?\s+of\s+[^.;]{0,60}?experience/);
      if (ym) out.push({ type: "min_experience", min_years: Number(ym[1]), requirement: `at least ${ym[1]} years of experience`, evidence: sent.slice(0, 220) });
    }
    return out;
  }
  function parseJD(text) {
    const raw = String(text || "");
    const low = raw.toLowerCase();
    const niceIdx = low.search(/nice to have|preferred qualifications|bonus points|plus(es)?[:\s]|preferred[:\s]/);
    const mustText = niceIdx >= 0 ? raw.slice(0, niceIdx) : raw;
    const niceText = niceIdx >= 0 ? raw.slice(niceIdx) : "";
    const segments = jdSegments(mustText);
    const reqSegs = segments.filter((sg) => sg.kind === "requirements");
    const inReq = reqSegs.length > 0;
    const zoneSegs = inReq ? reqSegs : segments.filter((sg) => sg.kind !== "example" && sg.kind !== "boilerplate");
    const zoneSkills = [...new Set(zoneSegs.flatMap((sg) => skillsInText(sg.text)))];
    const mustSkills = zoneSkills.filter((sk) => skillQualifies(sk, zoneSegs, inReq));
    // R1 C11 (Crew B Cycle 2): an AMBIGUOUS skill (Go, Spring, Spark, R)
    // named in the preferred zone under explicit preference phrasing —
    // the sentence itself says "not required" / "a plus" / "nice to
    // have" / "preferred" / "bonus" — IS a preferred skill, not a verb
    // or a season. The BUG-057 tech-context window dropped exactly that
    // case (GJ-T03: "Go listed as 'a plus, not required'"), so the gap
    // read came back empty and the tailor turn's spoken line falsely
    // asserted full coverage. The marker must be in the SAME sentence
    // as the token: a distant preference heading does not vouch for a
    // verb use elsewhere in the zone.
    const PREF_MARKER = /not required|a plus|nice to have|preferred|bonus/i;
    const niceSkills = skillsInText(niceText).filter((s) => !mustSkills.includes(s) && (!AMBIGUOUS_SKILLS.has(s) || skillQualifies(s, [{ kind: "other", text: niceText }], false) || sentencesOf(niceText).some((sent) => PREF_MARKER.test(sent) && skillsInText(sent).includes(s))));
    let level = "unspecified";
    if (/intern(ship)?\b/i.test(raw)) level = "intern";
    else if (/new grad|entry[- ]level|junior/i.test(raw)) level = "new-grad/junior";
    else if (/senior|staff|principal/i.test(raw)) level = "senior";
    else if (/manager|lead\b/i.test(raw)) level = "manager/lead";
    const keywords = [...new Set(raw.toLowerCase().replace(/[^a-z0-9+# ]/g, " ").split(/\s+/).filter((w) => w.length > 4))].slice(0, 200);
    const family = detectFamily(raw);
    return { mustHaveSkills: mustSkills, niceToHaveSkills: niceSkills, level, keywords, family, knockouts: extractKnockouts(raw), rawText: raw };
  }
  // BUG-055 (FV-4/FV-9/SS-2/SS-7): detectFamily scored each family with ONE
  // binary regex and silently fell back to "swe": a Finance & Strategy
  // title went to consulting ("strategy"), an accounting JD to swe/data_ml,
  // clinical JDs to swe (the medicine pattern required literal med-school
  // phrases), a legal-operations JD to ib_finance (the bare word "analyst"),
  // every real-estate JD to ib_finance (no RE family existed), and Capco's
  // consulting JDs to swe/ib_finance (sample-project stack tokens and a
  // bare "analyst" outvoted the firm). Detection is now a weighted count of
  // DISTINCT signals over the JD's signal segments (example/boilerplate
  // segments excluded, per BUG-057), with a head bonus, a firm-identity
  // bonus for named consultancies, no bare-"analyst" finance trigger, and
  // an explicit "general" fallback — an unmatched JD never quietly gets
  // SWE conventions again.
  const FAMILY_PATTERNS = {
    medicine: [/\bmedical assistant/, /\bnurse/, /\bnursing/, /\brn\b/, /\bpatient/, /\bclinical/, /\bhealthcare/, /\bmedical\b/, /\butilization review/, /\bcase management/, /\bphlebotom/, /\bcna\b/, /\bhospital/],
    law: [/\blegal\b/, /\bparalegal/, /\blaw firm/, /\battorney/, /\bcounsel\b/, /\blitigation/, /\blegal operations/, /\bjuris doctor/, /\blaw clerk/, /\blegal assistant/, /\bwestlaw/, /\blexisnexis/, /\bsummer associate/, /\blaw review/, /\bmoot court/],
    real_estate: [/\breal estate/, /\bcommercial real estate/, /\bunderwriting/, /\bargus/, /\bnoi\b/, /\basset management/, /\bescrow/, /\bleasing/, /\bmultifamily/, /\brent roll/, /\bcap rate/, /\bproperty management/, /\bacquisitions/],
    consulting: [/\bconsultancy/, /\bconsulting/, /\bconsultant/, /\bcase study/, /\bclient engagement/, /\bmanagement consulting/],
    ib_finance: [/\binvestment banking/, /\bm&a\b/, /\bdcf\b/, /\bvaluation/, /\bbanking/, /\bfinance\b/, /\bfinancial/, /\baccounting/, /\bcapital markets/, /\bdeal team/, /\bprivate equity/],
    quant: [/\bquant/, /\btrader/, /\bprobability/, /\bstochastic/, /\blow[- ]latency/, /\bmarket making/],
    pm: [/\bproduct manager/, /\bproduct management/, /\broadmap/, /\buser research/],
    data_ml: [/\bdata scientist/, /\bmachine learning/, /\bml engineer/, /\bdata analyst/, /\banalytics/, /\bdata science/],
    design: [/\bproduct designer/, /\bux\b/, /\bui designer/, /\bfigma/, /\bportfolio/],
    swe: [/\bsoftware engineer/, /\bback[- ]?end/, /\bfront[- ]?end/, /\bfull[- ]?stack/, /\bapi\b/, /\bdeployment/, /\bkubernetes/, /\breact\b/, /\bangular\b/, /\bjava\b/, /\btypescript/, /\bnode\.?js/, /\bsoftware development/],
  };
  const FAMILY_PRIORITY = ["medicine", "law", "real_estate", "consulting", "ib_finance", "quant", "pm", "data_ml", "design", "swe"];
  const CONSULTING_FIRMS = /\b(capco|pariveda|mckinsey|bain & company|boston consulting|bcg\b|accenture|deloitte|kpmg|pwc\b|oliver wyman|kearney|roland berger|strategy&)\b/;
  function detectFamily(text) {
    const raw = String(text || "");
    const signal = jdSegments(raw).filter((sg) => sg.kind !== "example" && sg.kind !== "boilerplate").map((sg) => sg.text).join(" ");
    const t = (signal || raw).toLowerCase();
    const head = t.slice(0, 500);
    const scores = {};
    for (const [fam, patterns] of Object.entries(FAMILY_PATTERNS)) {
      let sc = 0;
      for (const re of patterns) { if (re.test(t)) sc += 1; if (re.test(head)) sc += 1; }
      scores[fam] = sc;
    }
    // Firm identity: a named consultancy + any consulting signal ANYWHERE
    // in the document is the firm's own declaration — it outvotes
    // practice-area tokens (a Capco BA's "wealth & asset management
    // practice" is a practice, not the job). The identity check reads the
    // full text on purpose: a consultancy often declares itself only in a
    // Why-Join/About segment ("entrepreneurial consulting culture"), which
    // the segment filter correctly excludes from SKILL signal but which is
    // still the employer's identity.
    const full = raw.toLowerCase();
    const fullConsulting = FAMILY_PATTERNS.consulting.filter((re) => re.test(full)).length;
    if (fullConsulting > 0 && CONSULTING_FIRMS.test(full)) scores.consulting = Math.max(scores.consulting, fullConsulting) + 3;
    let best = "general", bestScore = 0;
    for (const fam of FAMILY_PRIORITY) if (scores[fam] > bestScore) { best = fam; bestScore = scores[fam]; }
    return bestScore > 0 ? best : "general";
  }

  // ---- role-family variants (Doc 2 §3.3) — SWE + IB/finance most fully realised ----
  const FAMILIES = {
    swe: { label: "SWE", sectionOrder: ["Skills", "Experience", "Projects", "Education", "Leadership"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Skills block first (languages, infra), projects with stack and scale, internships with measurable impact, GitHub link in header."], pageLimit: 1 },
    ib_finance: { label: "IB/finance", sectionOrder: ["Education", "Experience", "Leadership", "Projects", "Skills"], skillsBlock: "technical-line", bulletStyle: "concise-deal", conventions: ["Strict one-pager: education first for students, GPA shown, deal/transaction and modelling experience, finance club roles, skills rendered as a single 'Technical skills:' line (Excel, Bloomberg, Capital IQ only where evidenced)."], pageLimit: 1 },
    quant: { label: "Quant/trader", sectionOrder: ["Education", "Projects", "Experience", "Skills"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Competitions, research, probability/statistics coursework and data or low-latency projects lead."], pageLimit: 1 },
    consulting: { label: "Consulting", sectionOrder: ["Education", "Experience", "Leadership", "Projects", "Skills"], skillsBlock: "grouped", bulletStyle: "accomplished-x-by-y-z", conventions: ["Every bullet in 'Accomplished X by Y, resulting in Z' form, from the fact's action/method/result fields only; leadership and quantified results lead."], pageLimit: 1 },
    pm: { label: "PM", sectionOrder: ["Experience", "Projects", "Leadership", "Skills", "Education"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Shipped things, metrics moved, user research and cross-functional leadership lead."], pageLimit: 1 },
    data_ml: { label: "Data/ML", sectionOrder: ["Skills", "Projects", "Experience", "Education"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Models shipped, evaluation metrics and tooling lead; papers where present."], pageLimit: 1 },
    design: { label: "Design", sectionOrder: ["Projects", "Experience", "Skills", "Education"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Portfolio-first: projects lead and the portfolio link sits in the header."], pageLimit: 1 },
    law: { label: "Law (Big Law summer associate)", sectionOrder: ["Education", "Experience", "Leadership", "Projects", "Skills"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["CV conventions: education first with school and journal signals, then legal experience and leadership; conservative formatting, one page."], pageLimit: 1 },
    // BUG-055 (FV-9): the only medicine variant was a med-school ADMISSION
    // variant — a nursing student applying for a CNA/RN job was tailored
    // under admissions conventions. This is the healthcare-EMPLOYMENT
    // variant (Spec 3 §8B.4): credentials block first and verbatim,
    // clinical settings and hours as context, no PHI.
    medicine: { label: "Medicine (healthcare employment)", sectionOrder: ["Certifications", "Education", "Experience", "Projects", "Leadership", "Skills"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Credentials block first, copied verbatim (exact license/certification names, issuers and status — credentials dominate in healthcare); clinical experience forward with setting and hours as context; no patient-identifying information (PHI) in any line; service and leadership shown with sustained commitment."], pageLimit: 1 },
    // BUG-055 (SS-2): every real-estate JD was tailored as ib_finance.
    real_estate: { label: "Real Estate", sectionOrder: ["Education", "Experience", "Leadership", "Projects", "Certifications", "Skills"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Education first for students; experience bullets carry property and deal specifics (property types, unit counts, portfolio size, NOI/cap-rate figures only where evidenced); the skills line names Excel/Argus/CoStar only where evidenced; a license line is copied exactly where held and never implied where not held; one page."], pageLimit: 1 },
    // BUG-055 (FV-4): the silent "swe" fallback is gone — an unmatched JD
    // gets neutral conventions, surfaced as its own family.
    general: { label: "General", sectionOrder: ["Experience", "Projects", "Education", "Leadership", "Certifications", "Skills"], skillsBlock: "grouped", bulletStyle: "outcome-first", conventions: ["Neutral conventions: strongest evidenced experience first, education and credentials in their own sections; no family-specific framing is applied to an unmatched role."], pageLimit: 1 },
  };

  // Role-family skill vocabularies (Lane B depth, Crew B Cycle 2): the
  // occupation-level skills each family's facts typically evidence, in
  // the lexicon's own spellings. Used ONLY as a selection signal (a fact
  // evidencing a family skill is tailoring material for that family's
  // postings even when the posting's surviving text never named the
  // skill) — never as a claim source: a skill still reaches the page
  // only through an evidencing fact, under the audit + name rules.
  const FAMILY_SKILLS = {
    swe: ["Python", "JavaScript", "TypeScript", "Java", "C++", "C#", "Go", "Rust", "Ruby", "Swift", "Kotlin", "SQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "React", "Angular", "Vue", "Node.js", "Django", "Flask", "Spring", "Kubernetes", "Docker", "Terraform", "AWS", "GCP", "Azure", "Git", "Linux", "CI/CD", "GraphQL", "REST", "Data Structures", "Algorithms", "System Design", "Spark", "Hadoop"],
    data_ml: ["Python", "SQL", "Machine Learning", "TensorFlow", "PyTorch", "Pandas", "NumPy", "Statistics", "Probability", "A/B Testing", "Tableau", "R", "Spark", "Hadoop", "Data Structures", "Algorithms", "PostgreSQL"],
    quant: ["Python", "C++", "Java", "Statistics", "Probability", "Data Structures", "Algorithms", "Machine Learning", "SQL", "R", "Pandas", "NumPy"],
    pm: ["User Stories", "Agile", "Jira", "Confluence", "Requirements Analysis", "Stakeholder Management", "Business Analysis", "Project Management", "A/B Testing", "SQL", "Tableau"],
    design: ["Figma", "Photoshop"],
    ib_finance: ["Excel", "Financial Modeling", "Valuation", "Bloomberg", "Capital IQ", "PowerPoint", "Python", "SQL", "Tableau"],
    consulting: ["User Stories", "Agile", "Jira", "Confluence", "Requirements Analysis", "Stakeholder Management", "Business Analysis", "Consulting", "Change Management", "Project Management", "Excel", "PowerPoint", "Tableau"],
    law: ["Legal Research", "Legal Writing", "Westlaw", "LexisNexis", "E-Filing", "Legal Calendaring", "Contract Review", "Legal Operations"],
    medicine: ["Patient Care", "Vital Signs", "Phlebotomy", "Epic", "EHR", "EMR", "BLS", "CNA", "Medical Assistant", "Medical Assistant Certification", "Utilization Review", "Case Management", "Clinical Documentation", "Nursing License", "RN License", "Registered Nurse"],
    real_estate: ["Argus", "NOI", "DSC", "DSCR", "IRR", "Cap Rate", "Underwriting", "Rent Roll", "CoStar", "Asset Management", "Escrow", "Pro Forma", "Salesforce", "Real Estate License", "Real Estate", "Excel", "Financial Modeling"],
    general: [],
  };

  // ---- fact selection: relevance, then recency, then impact (Doc 2 §3.1 step 3) ----
  function scoreFact(fact, jd) {
    const wanted = [...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])];
    const fskills = (fact.skills || []).map((s) => String(s).toLowerCase());
    // Relevance reads the fact's whole stated content (title + text +
    // bullets) — the same corpus the truth audit and the grader's
    // evidence model read. Reading text alone missed skills evidenced
    // only in a bullet (Lane B depth, Crew B Cycle 2).
    const corpus = `${fact.title || ""} ${fact.text || ""} ${(fact.bullets || []).join(" ")}`.toLowerCase();
    let relevance = 0;
    for (const s of wanted) relevance += fskills.includes(s.toLowerCase()) ? 3 : (corpus.includes(s.toLowerCase()) ? 1 : 0);
    for (const kw of jd.keywords || []) if (kw.length > 5 && String(fact.text || "").toLowerCase().includes(kw)) relevance += 0.25;
    const endMs = fact.end ? Date.parse(`${fact.end}-01T00:00:00Z`) : (fact.start ? Date.parse(`${fact.start}-01T00:00:00Z`) : 0);
    const recency = Number.isFinite(endMs) && endMs ? Math.min(2, Math.max(0, (endMs / 1e12))) : 0;
    const impact = numbersIn(fact.text).length + (fact.metrics ? fact.metrics.length : 0);
    return { factId: fact.id, relevance: Math.round(relevance * 100) / 100, recency: Math.round(recency * 100) / 100, impact, total: Math.round((relevance * 10 + recency + impact) * 100) / 100 };
  }
  function selectFacts(profile, jd, opts) {
    profile = contentProfile(profile);
    const o = opts || {};
    const pool = Profile.confirmedFacts(profile).filter((f) => f.kind !== "skill");
    const scored = pool.map((f) => ({ fact: f, score: scoreFact(f, jd) }));
    // Posting-driven selection (Lane B depth, Crew B Cycle 2): the old
    // rule returned the top-(limit) of the WHOLE pool for every posting;
    // with real pools of 2–7 facts and a limit of 8 that was the entire
    // record every time, so selection was identical across postings by
    // construction (861 GENERIC_NOT_TAILORED instances in Lane B). A
    // fact is now KEPT when it has a reason to be on THIS resume:
    //  - it evidences a skill this posting names (skills[] or its
    //    title/text/bullets — scoreFact's skill component, without the
    //    keyword dust); or
    //  - it evidences a skill in this posting's role-FAMILY vocabulary
    //    (FAMILY_SKILLS above): posting texts are often truncated, and
    //    a fact carrying the occupation's own skills (a Go API on an
    //    SWE cut whose surviving JD text extracted only "Data
    //    Structures") is tailoring material, not filler; or
    //  - it is structural: education / certification / leadership —
    //    sections nearly every role-family variant carries, and a
    //    credential fact is often the degree/license evidence itself.
    // Ordinary off-target experience (no named skill, no family skill)
    // is what tailoring leaves out. Remaining facts fill only while
    // the kept set is not yet a viable document (fewer than 2 facts, or
    // no experience/project/leadership content at all), so a thin or
    // unmatched record still renders; fillers never displace a kept fact.
    const wanted = [...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])].map((s) => String(s).toLowerCase());
    const skillRelevance = (f) => {
      const fskills = (f.skills || []).map((s) => String(s).toLowerCase());
      const corpus = `${f.title || ""} ${f.text || ""} ${(f.bullets || []).join(" ")}`.toLowerCase();
      let r = 0;
      for (const s of wanted) r += fskills.includes(s) ? 3 : (corpus.includes(s) ? 1 : 0);
      return r;
    };
    const famVocab = new Set((FAMILY_SKILLS[jd.family] || []).map((s) => s.toLowerCase()));
    const familyRelevance = (f) => famVocab.size > 0 && factEvidencedSkillNames(f).some((n) => famVocab.has(n.toLowerCase()));
    const STRUCTURAL = new Set(["education", "certification", "leadership"]);
    const byTotal = (a, b) => b.score.total - a.score.total;
    const keep = scored.filter((x) => skillRelevance(x.fact) > 0 || familyRelevance(x.fact) || STRUCTURAL.has(x.fact.kind)).sort(byTotal);
    const rest = scored.filter((x) => !keep.includes(x)).sort(byTotal);
    const picked = [...keep];
    const hasContent = () => picked.some((x) => ["experience", "project", "leadership"].includes(x.fact.kind));
    // Viability floor: a larger record (pool >= 5) fills to 3 facts, a
    // small one to 2 — always with content — before tailoring stops;
    // a 6-fact record cut to 2 facts because the surviving JD text
    // extracted little is a thinner document than the record supports
    // (Lane B LB-0012 shape), while a 4-fact record's relevant core of
    // 2 is a complete cut and fills nothing.
    const minFacts = Math.min(scored.length >= 5 ? 3 : 2, scored.length);
    for (const x of rest) {
      if (picked.length >= minFacts && hasContent()) break;
      if (picked.length >= 3) break;
      picked.push(x);
    }
    return picked.slice(0, o.limit || 8);
  }
  // ---- skill-fact names + proof (BUG-210 / BUG-211) ----
  // A skill fact's name lives in different fields depending on who wrote
  // the fixture: `name`, a bare "Skill: X" text label, the `skills[]` list
  // (composite facts naming several skills), or a lexicon `title`. The old
  // provenSkills read ONLY f.name — nameless facts produced nameless rows
  // and the SKILLS line rendered as ", , ". Derivation is ordered and
  // deduped, canonicalised to the lexicon spelling where one exists.
  function skillNameParts(text) {
    const t = String(text || "").replace(/^Skill:\s*/i, "").trim();
    const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (m && m[1].trim()) return { name: m[1].trim(), name_note: m[2].trim() };
    return { name: t, name_note: "" };
  }
  const canonicalSkill = (n) => _lexLower.get(String(n || "").trim().toLowerCase()) || String(n || "").trim();
  function derivedSkillNames(fact) {
    const names = [];
    const push = (n) => { const c = canonicalSkill(n); if (c && !names.some((x) => x.toLowerCase() === c.toLowerCase())) names.push(c); };
    if (!fact) return names;
    // A `name` that is really a composite label ("Research tools (TEST)")
    // is not a skill name — the real names live in skills[] for those.
    if (fact.name && !/[()]/.test(String(fact.name)) && String(fact.name).trim().split(/\s+/).length <= 4) push(fact.name);
    if (/^Skill:\s*/i.test(String(fact.text || ""))) push(skillNameParts(fact.text).name);
    for (const s of fact.skills || []) push(s);
    if (!names.length && fact.title && _lexLower.has(String(fact.title).trim().toLowerCase())) push(fact.title);
    return names;
  }
  // A skill fact whose own text is a substantive work statement ("Uses SQL
  // and Tableau to automate recurring finance reporting", "Deployed
  // containerised services on AWS and GCP using Terraform…") evidences the
  // skills it states — the statement IS the evidence, the same treatment a
  // non-skill fact gets. A bare label ("Skill: Rust") is a claim, not a
  // statement, and never self-evidences.
  function skillFactSelfEvidences(fact, name) {
    const body = `${fact.text || ""} ${(fact.bullets || []).join(" ")}`.trim();
    if (!body || /^Skill:\s*/i.test(body)) return false;
    // Token match, punctuation-insensitive (Lane B depth, Crew B Cycle 2):
    // the old raw ` name ` substring check missed a skill mentioned at
    // the END of the fact's sentence ("…sensitivities in Excel.",
    // "…research guides in Confluence."), so a substantive statement was
    // treated as a bare claim and the skill became a false gap. Both
    // sides are normalised to bare tokens, so a trailing period/comma
    // cannot hide the mention — and a longer word containing the name
    // still cannot fake it.
    const norm = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").replace(/\s+/g, " ")} `;
    if (!norm(body).includes(norm(name))) return false;
    return body.split(/\s+/).filter(Boolean).length >= 6;
  }
  // Proof rule (BUG-211, aligned with 121's scoreFit semantics ~line 847):
  // a skill fact is proven only when it is not flagged unproven AND carries
  // evidence — an evidence LINK to a supporting fact, or its own
  // substantive statement. A bare skill fact with evidence: [] and no
  // unproven flag is NOT proven: it is excluded from the page, named as a
  // gap when a posting wants it, and may never poison a refusal decision
  // (the old code listed it as proven; the truth audit then refused the
  // whole resume over a skill the assembler itself had put on the page).
  function skillFactProven(fact, name) {
    if (!fact || fact.needs_confirmation) return false;
    if ((fact.evidence || []).length > 0 && !fact.unproven) return true;
    if (skillFactSelfEvidences(fact, name)) return true;
    return false;
  }
  function provenSkills(profile, jd) {
    profile = contentProfile(profile);
    const wanted = [...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])];
    const all = Profile.listFacts(profile, { kind: "skill" }).filter((f) => !f.needs_confirmation);
    const byName = new Map();
    for (const f of all) {
      for (const name of derivedSkillNames(f)) {
        const proven = skillFactProven(f, name);
        const key = name.toLowerCase();
        const prev = byName.get(key);
        if (!prev || (proven && !prev.proven)) byName.set(key, { name, factId: f.id, proven, evidence: f.evidence || [] });
      }
    }
    const rows = [...byName.values()];
    // Wanted skills first, then the rest, each only ever listed with its proof state.
    return rows.sort((a, b) => (wanted.includes(b.name) - wanted.includes(a.name)));
  }
  // Skills evidenced by a NON-skill fact: the fact's own skills[] list plus
  // lexicon skills stated in its title/text/bullets. The fact itself is the
  // evidence (the truth audit's factEvidencesSkill reads the same fields).
  function factEvidencedSkillNames(fact) {
    const names = [];
    const push = (n) => { const c = canonicalSkill(n); if (c && !names.some((x) => x.toLowerCase() === c.toLowerCase())) names.push(c); };
    for (const s of (fact && fact.skills) || []) push(s);
    for (const s of skillsInText(`${(fact && fact.title) || ""} ${(fact && fact.text) || ""} ${((fact && fact.bullets) || []).join(" ")}`)) push(s);
    return names;
  }
  function nonSkillSkillRows(profile, jd) {
    const wanted = new Set([...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])].map((s) => s.toLowerCase()));
    const byName = new Map();
    for (const f of Profile.confirmedFacts(profile)) {
      if (f.kind === "skill") continue;
      for (const name of factEvidencedSkillNames(f)) {
        const key = name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name, factId: f.id, proven: true, evidence: [f.id], derivedFromFact: f.kind });
      }
    }
    // Lane B depth (Crew B Cycle 2): the rows are no longer wanted-only.
    // A tailored resume's Skills section is the candidate's evidenced
    // skill vocabulary for the role family; restricting it to the terms
    // parseJD happened to extract from a (often truncated) posting text
    // left truthful, evidenced skills off the page by construction
    // (KEYWORD_ABSENT_TRUTHFUL / MISSING_REQUIREMENT for skills the
    // posting's occupation requires but its surviving text never named).
    // Every row still cites the confirmed fact that evidences it, and
    // the name-safety filter in assemble() still applies. Wanted rows
    // keep their lead position.
    const rows = [...byName.values()];
    return rows.sort((a, b) => (wanted.has(b.name.toLowerCase()) ? 1 : 0) - (wanted.has(a.name.toLowerCase()) ? 1 : 0));
  }

  // BUG-058 (FV-11/SS-12): the consulting X-by-Y-Z template concatenated the
  // fact's action/method/result fields raw — but those fields are verb
  // phrases ("built a …", "prepared 10 pages …"), producing ungrammatical
  // bullets ("Accomplished built … resulting in prepared …") on the very
  // documents where a typo is a named rejection trigger; the correctly
  // classified consulting run was the worst hit (5/5 bullets mangled).
  // The template now CONJUGATES: action and result are converted to gerund
  // form ("Accomplished — building … by modelling …, resulting in
  // preparing …"), and when a field cannot be conjugated safely (unknown
  // verb shape, passive "used by …" results) the style layer falls back to
  // the fact's own polished bullet — it may never ship a bullet less
  // grammatical than its source.
  const GERUND_IRREGULAR = { built: "building", led: "leading", ran: "running", made: "making", took: "taking", wrote: "writing", drove: "driving", grew: "growing", taught: "teaching", sold: "selling", won: "winning", held: "holding", oversaw: "overseeing", brought: "bringing", began: "beginning", spent: "spending", sent: "sending", met: "meeting", set: "setting", cut: "cutting", put: "putting", hit: "hitting", chose: "choosing", spoke: "speaking" };
  function gerundOf(word) {
    const w = String(word || "").toLowerCase();
    if (!w) return null;
    if (/ing$/.test(w)) return w;
    if (GERUND_IRREGULAR[w]) return GERUND_IRREGULAR[w];
    if (/ied$/.test(w)) return `${w.slice(0, -3)}ying`;
    if (/eed$/.test(w)) return `${w.slice(0, -1)}ing`;
    if (/ed$/.test(w)) return `${w.slice(0, -2)}ing`;
    return null; // not a past-tense verb shape we can conjugate safely
  }
  function gerundPhrase(phrase) {
    const p = String(phrase || "").trim();
    if (!p || /^(used|adopted) by\b/i.test(p)) return null; // passive results do not gerund ("using by 12 teams")
    const words = p.split(/\s+/);
    const g = gerundOf(words[0]);
    if (!g) return null;
    words[0] = g;
    return words.join(" ");
  }
  function bulletFor(fact, family) {
    const fam = FAMILIES[family] || FAMILIES.swe;
    if (fam.bulletStyle === "accomplished-x-by-y-z" && fact.action && fact.method && fact.result) {
      const a = gerundPhrase(fact.action), r = gerundPhrase(fact.result);
      if (a && r) return { text: `Accomplished — ${a} by ${fact.method}, resulting in ${r}`, factIds: [fact.id] };
    }
    const base = (fact.bullets && fact.bullets[0]) || fact.text;
    return { text: base, factIds: [fact.id] };
  }

  // Fact selection picks a role/project; a posting also needs the most relevant evidence WITHIN that entry.
  // Rank the person's own bullet strings without rewriting, dropping, or borrowing words from the employer.
  // Explicit requirements lead preferences, then task-word overlap; equal scores retain the source order.
  function bulletsForPosting(bullets, jd) {
    const must = new Set((jd.mustHaveSkills || []).map((s) => String(s).toLowerCase()));
    const nice = new Set((jd.niceToHaveSkills || []).map((s) => String(s).toLowerCase()));
    const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").split(/\s+/).filter((w) => w.length > 4);
    const generic = new Set("requirements qualifications responsibilities experience required preferred skills ability minimum candidate applicants company people position years opportunities".split(" "));
    const taskWords = new Set(jdSegments(jd.rawText || "").filter((sg) => sg.kind !== "example" && sg.kind !== "boilerplate")
      .flatMap((sg) => tokens(sg.text)).filter((w) => !generic.has(w)));
    const scored = bullets.map((text, index) => {
      const skills = new Set(skillsInText(text).map((s) => s.toLowerCase()));
      const words = new Set(tokens(text));
      return { text, index, score: [
        [...must].filter((s) => skills.has(s)).length,
        [...nice].filter((s) => skills.has(s)).length,
        [...taskWords].filter((w) => words.has(w)).length,
      ] };
    });
    scored.sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
      return a.index - b.index;
    });
    return scored.map((s) => s.text);
  }

  // ---- entry dates (BUG-2026-10-14-NDER) ----
  // An entry line prints its fact's date range, in the one-pager's proven
  // shape ("Title, Org, 2025–2029" / "…, 2025–Present" / single year when
  // start === end or only one end is known). Years only: the fact bank
  // carries years for dated entries, and a year is the granularity the
  // owner's source states. Dates come ONLY from the fact's own start/end
  // fields — the truth audit's support corpus includes those fields, so an
  // invented year is still refused.
  const yearOf = (v) => { const m = String(v == null ? "" : v).match(/\d{4}/); return m ? m[0] : null; };
  function dateRangeFor(fact) {
    if (!fact) return null;
    const s = yearOf(fact.start);
    const e = /^present$/i.test(String(fact.end || "").trim()) ? "Present" : yearOf(fact.end);
    if (s && e && s !== e) return `${s}–${e}`;
    return s || e || null;
  }
  function entryTextFor(fact) {
    const title = (fact && fact.title) || "";
    const range = dateRangeFor(fact);
    if (!range || !title || title.includes(range)) return title;
    return `${title}, ${range}`;
  }

  function assemble(profile, jd, opts) {
    profile = contentProfile(profile);
    const o = opts || {};
    const family = o.family || jd.family || "swe";
    const fam = FAMILIES[family] || FAMILIES.swe;
    const selected = selectFacts(profile, jd, o);
    const byKind = { experience: [], project: [], education: [], leadership: [], certification: [] };
    for (const { fact } of selected) if (byKind[fact.kind]) byKind[fact.kind].push(fact);
    const sections = [];
    // Skills line (BUG-210): proven skill-fact rows first (name-derived,
    // proof-filtered — an unproven row never reaches the page), then
    // JD-wanted skills evidenced by non-skill facts (their skills[] lists
    // were previously rendered nowhere, so a fact could evidence a posting
    // requirement in data while the term never reached the page).
    const skillRowByName = new Map();
    for (const s of provenSkills(profile, jd).filter((x) => x.proven && x.name)) skillRowByName.set(s.name.toLowerCase(), s);
    for (const s of nonSkillSkillRows(profile, jd)) if (!skillRowByName.has(s.name.toLowerCase())) skillRowByName.set(s.name.toLowerCase(), s);
    // Name-safety filter: a skill name may PRINT when it is attested
    // by the user's own record — either (a) every word of it appears
    // in the persona's fact prose (title/text/bullets/org of some
    // fact), or (b) the name is listed in a confirmed fact's
    // skills[] list. A name attested by NEITHER is an invention and
    // never prints.
    // OWNER RULING 2026-10-16 (MI-023, supersedes the prose-only
    // rule): skills listed in a fact's skills[] list COUNT as
    // attested for tailoring. History: a lexicon exemption for
    // skills[]-sourced names was tried in Crew B Cycle 2 and
    // REVERTED on Lane B measurement — coverage rose (0.686 ->
    // 0.961) but the grader's prose-only immutability check counted
    // 1,441 invention instances, every one a skills[]-attested name.
    // The owner ruled those names lawful: they come only from the
    // user's own record, so invention stays 0 by construction — a
    // name from neither prose nor any skills[] list still never
    // prints (the guard in tests/career-tailor-depth2.test.cjs).
    const nameCorpus = (profile.facts || []).map((f) => `${f.title || ""} ${f.text || ""} ${(f.bullets || []).join(" ")} ${f.org || ""}`).join(" ").toLowerCase();
    const attestedListed = new Set();
    for (const f of Profile.confirmedFacts(profile)) for (const s of f.skills || []) attestedListed.add(canonicalSkill(s).toLowerCase());
    const nameSafe = (name) => attestedListed.has(canonicalSkill(name).toLowerCase()) || String(name).split(/\s+/).every((w) => { const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z&.]+$/g, ""); return clean.length < 2 || nameCorpus.includes(clean.toLowerCase()); });
    const skillsProvenAll = [...skillRowByName.values()].filter((s) => nameSafe(s.name));
    // Posting-family scope (iteration lane, BUG-273): both row
    // sources above deliberately carry the record's whole evidenced
    // vocabulary (Crew B Cycle 2's answer to KEYWORD_ABSENT_TRUTHFUL),
    // so the printed line was the SAME full inventory on every
    // posting — an operations application leading with the record's
    // SWE stack, a law application carrying its Python line — the
    // residual GENERIC_NOT_TAILORED mechanism (893 flags on the
    // merged tree). Lane B's own stated intent was the evidenced
    // vocabulary "for the role family"; the scope below is that
    // intent, implemented: a name prints when THIS posting names it
    // (extracted must/nice lists), when its raw text mentions it
    // (extraction misses on truncated texts stay covered), or when
    // it belongs to this posting's role-family vocabulary
    // (FAMILY_SKILLS). Every printed name remains attested under
    // the MI-023 rule above, and gaps are computed from evidence
    // separately — scoping the line can neither invent a skill nor
    // hide a gap.
    const wantedLcScope = new Set([...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])].map((x) => String(x).toLowerCase()));
    const famVocabScope = new Set((FAMILY_SKILLS[jd.family] || []).map((x) => String(x).toLowerCase()));
    const rawLcScope = String(jd.rawText || "").toLowerCase();
    const mentionedInJd = (name) => { const n = String(name).toLowerCase(); let i = rawLcScope.indexOf(n); while (i >= 0) { const b = i === 0 ? " " : rawLcScope[i - 1]; const a = rawLcScope[i + n.length] || " "; if (!/[a-z0-9]/.test(b) && !/[a-z0-9]/.test(a)) return true; i = rawLcScope.indexOf(n, i + 1); } return false; };
    const skillsProven = skillsProvenAll.filter((s) => wantedLcScope.has(s.name.toLowerCase()) || famVocabScope.has(s.name.toLowerCase()) || mentionedInJd(s.name));
    const skillsLine = skillsProven.length ? { heading: "Skills", lines: [] } : null;
    if (skillsLine) {
      const ids = [...new Set(skillsProven.map((s) => s.factId))];
      if (fam.skillsBlock === "technical-line") {
        skillsLine.lines.push({ text: `Technical skills: ${skillsProven.map((s) => s.name).join(", ")}`, factIds: ids, type: "skills" });
      } else {
        skillsLine.lines.push({ text: skillsProven.map((s) => s.name).join(", "), factIds: ids, type: "skills" });
      }
    }
    // Operative clauses (BUG-212): when a fact carries bullets, its `text`
    // was dropped entirely — and the dropped text is often a multi-clause
    // sentence whose LAST clause carries the requirement term ("…and
    // manages legal operations for a 12-client portfolio"). Preserve any
    // clause of the fact's own text that carries a JD-wanted skill term no
    // already-rendered line for this fact carries. The clause is the fact's
    // own words, cited to the fact — nothing is paraphrased or invented.
    const wantedLower = new Set([...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])].map((s) => s.toLowerCase()));
    const operativeClauses = (fact, coveredTexts) => {
      if (!wantedLower.size || !fact.text || !(fact.bullets && fact.bullets.length)) return [];
      const covered = new Set(skillsInText((coveredTexts || []).join(" ")).map((s) => s.toLowerCase()));
      const out = [];
      for (const sent of sentencesOf(fact.text)) {
        for (let clause of sent.split(/,\s+and\s+/i)) {
          clause = clause.trim();
          if (clause.split(/\s+/).length < 3) continue;
          const fresh = skillsInText(clause).filter((s) => wantedLower.has(s.toLowerCase()) && !covered.has(s.toLowerCase()));
          if (!fresh.length) continue;
          for (const s of skillsInText(clause)) covered.add(s.toLowerCase());
          out.push({ text: clause.charAt(0).toUpperCase() + clause.slice(1), factIds: [fact.id], type: "bullet" });
        }
      }
      return out;
    };
    const mk = (heading, facts) => facts.length ? { heading, lines: facts.flatMap((f) => {
      const bullets = bulletsForPosting(f.bullets && f.bullets.length ? f.bullets : [f.text], jd).map((b) => family === "consulting" && f.action ? bulletFor(f, family) : { text: b, factIds: [f.id], type: "bullet" });
      return [{ text: entryTextFor(f), factIds: [f.id], type: "entry" }, ...bullets, ...operativeClauses(f, [entryTextFor(f), ...bullets.map((b) => b.text)])];
    }) } : null;
    // consulting: one structured bullet per fact replaces the raw bullets
    const mkSection = (heading, facts) => {
      if (!facts.length) return null;
      if (family === "consulting") return { heading, lines: facts.flatMap((f) => { const b = bulletFor(f, family); return [{ text: entryTextFor(f), factIds: [f.id], type: "entry" }, b, ...operativeClauses(f, [entryTextFor(f), b.text])]; }) };
      return mk(heading, facts);
    };
    // Certifications (BUG-2026-10-14-NDER / FV-6): selected certification
    // facts were silently dropped — byKind had no bucket for them. They
    // render as ONE title line per fact, the one-pager's proven shape; a
    // cert fact's own bullet typically restates its title ("Licenses &
    // Certifications: <title>") and would duplicate it.
    const certSection = byKind.certification.length ? { heading: "Certifications", lines: byKind.certification.map((f) => ({ text: f.title || f.text, factIds: [f.id], type: "bullet" })) } : null;
    const sectionByHeading = {
      Skills: skillsLine,
      Experience: mkSection("Experience", byKind.experience),
      Projects: mkSection("Projects", byKind.project),
      Education: mkSection("Education", byKind.education),
      Leadership: mkSection("Leadership", byKind.leadership),
      Certifications: certSection,
    };
    for (const h of fam.sectionOrder) if (sectionByHeading[h]) sections.push(sectionByHeading[h]);
    for (const h of Object.keys(sectionByHeading)) if (sectionByHeading[h] && !sections.includes(sectionByHeading[h])) sections.push(sectionByHeading[h]);
    // Dedupe (BUG-2026-10-14-NDER): a line belongs in exactly one section.
    // Two facts can carry the same line (the owner's education fact and
    // clubs fact both carry his "Involvement/Courses:" bullet); emitting
    // every selected fact's bullets printed it twice. First occurrence in
    // section order wins; every drop is recorded on the resume so the
    // packet ledger can show it. Skills lines are exempt (single line).
    const deduped = [];
    const seenLine = new Map();
    const lineKey = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/\.+$/, "");
    for (const s of sections) {
      s.lines = s.lines.filter((l) => {
        if (!l || l.type === "skills") return true;
        const k = lineKey(l.text);
        if (!k) return true;
        if (seenLine.has(k)) { deduped.push({ text: l.text, keptIn: seenLine.get(k), droppedFrom: s.heading, factIds: l.factIds || [] }); return false; }
        seenLine.set(k, s.heading);
        return true;
      });
    }
    for (let i = sections.length - 1; i >= 0; i--) if (!sections[i].lines.length) sections.splice(i, 1);
    const lines = sections.flatMap((s) => s.lines.map((l) => ({ ...l, section: s.heading })));
    return { family, familyLabel: fam.label, conventions: fam.conventions, pageLimit: fam.pageLimit, header: { name: profile.basics.name, email: profile.basics.email, location: profile.basics.location, links: profile.basics.links || {} }, sections, lines, deduped, selectedFactIds: selected.map((x) => x.fact.id) };
  }

  // ---- TRUTH AUDIT — hard gate (APPE-002) ----
  function auditResume(resume, profile) {
    const usable = contentProfile(profile), usableFacts = new Set(usable.facts);
    const lines = Array.isArray(resume) ? resume : (resume && resume.lines) || [];
    const violations = [];
    for (const line of lines) {
      const text = typeof line === "string" ? line : line.text;
      const factIds = typeof line === "string" ? [] : (line.factIds || []);
      if (!text || !String(text).trim()) continue;
      if (!factIds.length) { violations.push({ line: text, reason: "no fact ID: line maps to no profile fact", factIds: [] }); continue; }
      const facts = factIds.map((id) => Profile.getFact(profile, id));
      if (facts.some((f) => !f)) { violations.push({ line: text, reason: `unknown fact ID (${factIds.filter((_id, i) => !facts[i]).join(", ")})`, factIds }); continue; }
      if (facts.some((f) => f.needs_confirmation)) { violations.push({ line: text, reason: "supported only by an unconfirmed (needs_confirmation) fact", factIds }); continue; }
      if (facts.some((f) => !usableFacts.has(f))) violations.push({ line: text, reason: "supported by quarantined, unavailable or excluded-source evidence", factIds });
      // The fact's start/end fields are part of its support corpus: entry
      // lines print the date range from exactly those fields
      // (assemble/entryTextFor), so the years must trace here — and ONLY
      // here; a year appearing in no field of the cited fact still refuses.
      // The fact's skills[] list and (for a skill fact) its name are part of
      // the fact's own stated content — a skills line built from a cited
      // fact's skills[] must trace to that fact, so both are in the corpus.
      const supportText = facts.map((f) => `${f.title} ${f.text} ${(f.bullets || []).join(" ")} ${f.start || ""} ${f.end || ""} ${(f.skills || []).join(" ")} ${f.name || ""}`).join(" ").toLowerCase();
      // Keyword rule: any lexicon skill named in the line must be evidenced.
      // BUG-056: the evidence lookup must read the fact's BULLETS as well as
      // its text — a fact's own bullet is where the work is stated (the RE
      // persona's F-002 text summarizes, its bullets name NOI and rent-roll
      // work). 122's skillEvidence reads text+skills only, so with the
      // extended lexicon the audit refused TRUE lines from the candidate's
      // own facts (SS-G1/SS-G2 regression). Token-matched, confirmed facts
      // only — the gate's strength is unchanged for unevidenced skills.
      const factEvidencesSkill = (f, nm) => {
        if (!f || f.needs_confirmation) return false;
        // A skill fact evidences its own derived names ONLY under the same
        // proof rule the assembler uses (BUG-211): an evidence link or a
        // substantive self-statement. A bare "Skill: Rust" fact with
        // evidence: [] evidences nothing and can support no line.
        if (f.kind === "skill") return derivedSkillNames(f).some((n) => n.toLowerCase() === nm) && skillFactProven(f, nm);
        if ((f.skills || []).some((x) => String(x).toLowerCase() === nm)) return true;
        const corpus = ` ${`${f.title || ""} ${f.text || ""} ${(f.bullets || []).join(" ")}`.toLowerCase().replace(/[^a-z0-9+#. ]/g, " ")} `;
        return corpus.includes(` ${nm} `);
      };
      for (const skill of skillsInText(text)) {
        const ev = Profile.skillEvidence(usable, skill);
        const nm = skill.toLowerCase();
        const proven = ev.proven || usable.facts.some((f) => factEvidencesSkill(f, nm));
        const cited = factIds.some((id) => ev.evidenceFactIds.includes(id) || (Profile.getFact(profile, id) || {}).name === skill || factEvidencesSkill(Profile.getFact(profile, id), nm));
        const inSupport = supportText.includes(nm) && proven;
        if (!proven || (!cited && !inSupport)) violations.push({ line: text, reason: `skill "${skill}" is not evidenced by the cited fact(s)`, factIds, skill });
      }
      // Number rule: any number in the line must appear in a supporting fact.
      for (const n of numbersIn(text)) {
        if (!supportText.replace(/,/g, "").includes(n)) violations.push({ line: text, reason: `number "${n}" does not appear in any supporting fact`, factIds });
      }
      // Immutability rule (Spec 3 H3): a capitalized name mid-line — an
      // employer, title, school or tool — must appear in the cited fact(s).
      // Swapping the employer/title while keeping the rest of the line is
      // the mutation this catches; token overlap alone waves it through.
      const NAME_OK = new Set(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
      const seenNames = new Set();
      String(text).split(/\s+/).forEach((w, i) => {
        if (i === 0) return; // line-initial capitalization is positional, not a name
        const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z&.]+$/g, "");
        if (clean.length < 2 || !/^[A-Z]/.test(clean) || NAME_OK.has(clean) || seenNames.has(clean)) return;
        seenNames.add(clean);
        if (!supportText.includes(clean.toLowerCase())) violations.push({ line: text, reason: `named entity "${clean}" does not appear in the cited fact(s)`, factIds });
      });
      // Support rule: a skill-fact-only line is fine (the skills line); other
      // lines must share meaningful tokens with their supporting facts.
      // A skills-TYPE line is governed by the per-skill evidence rule above
      // (every skill it names is individually checked against its cited
      // facts) — token overlap on a bare name list, whose "Technical
      // skills:" prefix alone is two of its tokens, is not a support test.
      const lineType = typeof line === "string" ? null : line.type;
      const onlySkillFacts = facts.every((f) => f.kind === "skill") || lineType === "skills";
      if (!onlySkillFacts) {
        const tokens = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
        const hits = tokens.filter((w) => supportText.includes(w)).length;
        if (tokens.length && hits / tokens.length < 0.35) violations.push({ line: text, reason: "line text is not supported by its cited fact(s) (token overlap too low)", factIds });
      }
    }
    return { ok: violations.length === 0, violations, checked: lines.length };
  }
  const audit = auditResume;

  // ---- diff vs base resume (Doc 2 §3.1 step 8) ----
  function diffResume(baseLines, tailored, profile) {
    const base = (baseLines || []).map((l) => (typeof l === "string" ? l : l.text));
    const out = ((tailored && tailored.lines) || []).map((l) => l.text);
    const baseSet = new Map(base.map((t, i) => [t, i]));
    const outSet = new Map(out.map((t, i) => [t, i]));
    const added = [], moved = [], removed = [];
    const baseObjs = (baseLines || []).map((l) => (typeof l === "string" ? { text: l } : l));
    const consumedBase = new Set();
    const DATE_SUFFIX = /^\d{4}(–(\d{4}|Present))?$/;
    ((tailored && tailored.lines) || []).forEach((l, i) => {
      if (!baseSet.has(l.text)) {
        // A base entry re-issued with its fact's date range appended is the
        // SAME content moved, not an add + a remove (BUG-2026-10-14-NDER).
        const ids = l.factIds || [];
        const twin = ids.length === 1 ? baseObjs.find((b) => b && b.type === l.type && (b.factIds || [])[0] === ids[0] && typeof b.text === "string" && l.text.startsWith(`${b.text}, `) && DATE_SUFFIX.test(l.text.slice(b.text.length + 2))) : null;
        if (twin) { consumedBase.add(twin.text); moved.push({ text: l.text, from: baseSet.get(twin.text), to: i, reason: "entry re-issued with the date range from its fact's start/end fields — content unchanged" }); return; }
        // Reason cites the EVIDENCE behind the line, not just its own fact:
        // for a skills line that is the project/experience fact that proves
        // the skill (Doc 2 §3.1 step 8: "added Kubernetes — you deployed on
        // EKS in Project X (fact F-…)").
        const cited = new Set(l.factIds || []);
        if (profile) for (const id of l.factIds || []) { const f = Profile.getFact(profile, id); if (f && f.kind === "skill") for (const e of f.evidence || []) cited.add(e); }
        const facts = [...cited];
        const skillNames = skillsInText(l.text);
        added.push({ text: l.text, factIds: l.factIds || [], evidenceFactIds: facts, reason: skillNames.length ? `added ${skillNames.join(", ")} — evidenced by fact ${facts.join(", ")}` : `added — supported by fact ${facts.join(", ") || "none"}` });
      } else if (baseSet.get(l.text) !== i) moved.push({ text: l.text, from: baseSet.get(l.text), to: i, reason: "moved — section order follows the role-family variant" });
    });
    base.forEach((t) => { if (!outSet.has(t) && !consumedBase.has(t)) removed.push({ text: t, reason: "removed — not selected for this role (relevance/recency/impact ranking)" }); });
    const changed = added.length + removed.length;
    return { added, moved, removed, summary: `${added.length} added, ${removed.length} removed, ${moved.length} moved (${changed} content changes)` };
  }

  // ---- ATS-safe render (Doc 2 §3.1 step 6; documents: CA-02 / Spec 3 §10.4) ----
  function render(resume, opts) {
    const o = opts || {};
    const secs = resume.sections || [];
    const head = [resume.header && resume.header.name, resume.header && resume.header.email, resume.header && resume.header.location].filter(Boolean).join(" | ");
    const links = Object.values((resume.header && resume.header.links) || {}).filter(Boolean).join(" | ");
    const textParts = [head, links].filter(Boolean);
    const mdParts = [`# ${(resume.header && resume.header.name) || ""}`, [resume.header && resume.header.email, resume.header && resume.header.location].filter(Boolean).join(" | ")].filter(Boolean);
    for (const s of secs) {
      textParts.push("", s.heading.toUpperCase(), ...s.lines.map((l) => (l.type === "bullet" ? `- ${l.text}` : l.text)));
      mdParts.push("", `## ${s.heading}`, ...s.lines.map((l) => (l.type === "bullet" ? `- ${l.text}` : l.text)));
    }
    // Packet gaps (BUG-208): the honest gap section rides on the rendered
    // packet as its own field — deliberately NOT inside the resume body
    // text, whose lines are claims the truth audit (and any ATS read) must
    // be able to trust; a gap line naming an unevidenced skill inside the
    // body would read as a claim of that skill.
    const base = { text: textParts.join("\n"), markdown: mdParts.join("\n"), singleColumn: true, headings: secs.map((s) => s.heading.toUpperCase()), gaps: resume.gaps || [], gapsText: resume.gapSection ? resume.gapSection.text : null };
    const R = renderModule();
    if (!R) return { ...base, pdf: null, docx: null, filename: null, parseCheck: null, pdfNote: "Document renderer (148-career-render.js) is not loaded in this runtime; plain text is the ATS-safe extractable form and no document file was produced." };
    const pdfRes = o.format !== "docx" ? R.renderPdf(resume) : null;
    const docxRes = o.format !== "pdf" ? R.renderDocx(resume) : null;
    const pdf = pdfRes && pdfRes.ok ? R.artifact("pdf", pdfRes) : null;
    const docx = docxRes && docxRes.ok ? R.artifact("docx", docxRes) : null;
    const parseCheck = (pdf || docx) ? R.parseCheck({ resume, pdf: pdf ? pdfRes.buffer : null, docx: docx ? docxRes.buffer : null, profile: o.profile || null }) : null;
    return { ...base, ok: true, pdf, docx, filename: (pdf && pdf.filename) || (docx && docx.filename) || null, parseCheck, pdfNote: "PDF + DOCX rendered from the same resume JSON by 148-career-render.js (text pipeline, Spec 3 §10.4); parse-check verdict in parseCheck (§2.5)." };
  }

  // ---- cover letter (Doc 2 §3.4; APPL-002) ----
  function wordCount(t) { return String(t || "").trim().split(/\s+/).filter(Boolean).length; }
  // TAILORING SCENARIOS (2026-10-29; D-007): the company research is printed in the letter as written, inside the
  // person's own first-person letter. A research line that speaks about the candidate ("The candidate holds a PhD from
  // Stanford", "You led a team of 12 at Google", "I am a US citizen") was printed as if the person said it about
  // themselves. Only a line about the company itself may stand in a letter or an answer-bank entry.
  const ABOUT_CANDIDATE = /\b(?:i|i'm|i've|i'd|me|my|mine|you|your|you're|you've|yours|candidates?|applicants?|the person|the user)\b/i;
  const companyFactText = (f) => String((f && typeof f === "object" ? f.text : f) || "");
  function aboutCompany(facts) { return (facts || []).filter((f) => { const t = companyFactText(f); return !!t.trim() && !ABOUT_CANDIDATE.test(t); }); }
  function generateCoverLetter(profile, jdInput, cir, opts) {
    const o = opts || {};
    const jd = jdInput && jdInput.mustHaveSkills ? jdInput : parseJD((jdInput && jdInput.text) || jdInput || "");
    if (cir && (cir.aiPolicy === "ban" || cir.bansAiWrittenText)) {
      return { ok: false, mode: "outline", reason: "company bans AI-written application text (CIR); outline only — the user writes the letter (Doc 2 S8)", outline: coverOutline(profile, jd, cir), text: null };
    }
    const companyFacts = aboutCompany((cir && cir.facts) || []);
    if (cir && cir.company && ((cir.facts || []).length) && !companyFacts.length) return { ok: false, reason: "the company research speaks about the candidate, not the company; a letter states only the person's confirmed facts as theirs", text: null };
    if (!cir || !cir.company || !companyFacts.length) return { ok: false, reason: "no real company fact in the CIR input; a cover letter is never written from invented company facts", text: null };
    const selected = selectFacts(profile, jd, { limit: 3 });
    if (!selected.length) return { ok: false, reason: "no confirmed profile facts to prove fit", text: null };
    const proof = selected[0].fact;
    const companyFact = companyFacts[0];
    // The role as the caller names it; 123's level ("unspecified", "senior") is not a role ("I am applying for unspecified").
    const role = o.role || "the role";
    const name = profile.basics.name || "Candidate";
    const sentences = [
      `Dear ${cir.company} hiring team,`,
      `I am applying for ${role} at ${cir.company}. ${companyFact.text || companyFact}`,
      `In my own work, ${proof.text}`,
    ];
    if (selected[1]) sentences.push(`I have also done work that maps directly to this team: ${selected[1].fact.text}`);
    if (selected[2]) sentences.push(`Earlier experience adds range: ${selected[2].fact.text}`);
    sentences.push(`That combination — direct, measured work and a specific interest in ${cir.company} — is why I am applying here rather than sending the same letter everywhere. I would welcome the chance to talk through the work in detail.`);
    sentences.push(`Thank you for your time.`, `Sincerely,`, `${name}`);
    let text = sentences.join("\n\n");
    // Deterministic length control into the 150–250 window using only real facts.
    let guard = 0;
    while (wordCount(text) < 150 && guard++ < 3) {
      const extra = selected[guard % selected.length];
      if (!extra) break;
      text = text.replace("\n\nThank you", `\n\nOne further proof point from my record: ${extra.fact.text}\n\nThank you`);
    }
    const banned = bannedPhrasesIn(text);
    if (banned.length) return { ok: false, reason: `cover letter contains banned phrase(s): ${banned.join(", ")}`, text: null, banned };
    const wc = wordCount(text);
    if (wc < 150 || wc > 250) return { ok: false, reason: `cover letter is ${wc} words, outside the 150-250 window`, text: null, wordCount: wc };
    const auditResult = auditResume([{ text: proof.text, factIds: [proof.id] }], profile);
    const out = { ok: true, text, wordCount: wc, companyFact: companyFact.text || companyFact, proofFactId: proof.id, factIds: selected.map((x) => x.fact.id), banned: [], groundedAuditOk: auditResult.ok };
    // Writing-pattern scorecard (module 154, MI-097): attached ONLY
    // when the caller enables it (opts.writingPattern.enabled). The G0
    // prohibition gate runs FIRST in that mode: a blocked context
    // (e.g. a program whose rules make the statement owner-write-only)
    // degrades to the same outline-only refusal the CIR ban uses.
    // Default off: no behavior change for any existing caller.
    if (o.writingPattern && o.writingPattern.enabled) {
      let W = null;
      try { W = typeof CareerWriting !== "undefined" ? CareerWriting : require("./154-career-writing.js"); } catch { W = null; }
      if (W) {
        const wp = o.writingPattern;
        const g0 = W.gate0({ kind: wp.kind || "cover_letter", program: wp.program || null, context: wp.context || {} });
        if (!g0.allowed) return { ok: false, mode: "outline", reason: g0.explanation, outline: coverOutline(profile, jd, cir), text: null, writing: { gate0: g0 } };
        const pack = [...selected.map((x) => ({ id: x.fact.id, kind: "sender", text: x.fact.text })), ...companyFacts.map((f) => ({ kind: "recipient", text: f.text || String(f) }))];
        out.writing = { gate0: g0, scorecard: W.slopGate(text, { factPack: pack, factIds: pack.map((p) => p.id).filter(Boolean), recipient: { full_name: cir.company, current_firm: cir.company }, senderName: name, profile: wp.profile || null }) };
      }
    }
    return out;
  }
  function coverOutline(profile, jd, cir) {
    const selected = selectFacts(profile, jd, { limit: 3 });
    return {
      company: cir && cir.company,
      points: [
        `Open with the specific company fact you care about: ${((cir && cir.facts && cir.facts[0]) || {}).text || (cir && cir.facts && cir.facts[0]) || "pick one real company fact from the CIR"}`,
        ...selected.map((x) => `Proof point (fact ${x.fact.id}): ${x.fact.text}`),
        "Close in your own words: why this company, specifically.",
      ],
      instruction: "This company bans AI-written application text. Use this outline and the cited facts, and write the letter yourself.",
    };
  }

  // ---- "why this company" answer bank (Doc 2 §3.5; APPE-004) ----
  function buildAnswerBank(profile, jdInput, cir, _opts) {
    const jd = jdInput && jdInput.mustHaveSkills ? jdInput : parseJD((jdInput && jdInput.text) || jdInput || "");
    if (!cir || !cir.company || !(cir.facts || []).length) return { ok: false, reason: "answer bank entries need real CIR company facts; none passed in", entries: [] };
    const selected = selectFacts(profile, jd, { limit: 3 });
    const cf = aboutCompany(cir.facts).map(companyFactText);
    if (!cf.length) return { ok: false, reason: "the company research speaks about the candidate, not the company; no answer is written from it", entries: [] };
    const entries = [
      { theme: "why_us", company: cir.company, text: `${cir.company}: ${cf[0]} That is specific to ${cir.company}, and it connects to my record: ${selected[0] ? selected[0].fact.text : "see profile"}`, factIds: selected[0] ? [selected[0].fact.id] : [], cirFacts: [cf[0]], rewrittenForCompany: true },
      { theme: "hard_problem", company: cir.company, text: selected[1] ? selected[1].fact.text : (selected[0] ? selected[0].fact.text : ""), factIds: (selected[1] || selected[0]) ? [(selected[1] || selected[0]).fact.id] : [], cirFacts: [], rewrittenForCompany: false },
      { theme: "project_story", company: cir.company, text: selected[0] ? selected[0].fact.text : "", factIds: selected[0] ? [selected[0].fact.id] : [], cirFacts: cf.slice(0, 1), rewrittenForCompany: true },
    ].filter((e) => e.text);
    return { ok: true, entries };
  }

  // ---- GAP NAMING (BUG-208 / BUG-209) ----
  // Silence is the defect: a tailored resume used to ship with no trace of
  // the posting requirements the record cannot meet — zero-satisfiable
  // pairings shipped as if tailored, and failed knockouts (license, degree,
  // minimum years) were silently dropped. computeGaps names every such
  // item as data, computed from the SAME requirement extraction the
  // coverage is measured against (parseJD must/nice skills + knockouts +
  // level), with satisfaction judged from PROVEN facts only, mirroring
  // 121's evaluateKnockouts semantics (in-progress or negated credentials
  // do not satisfy; full-time years exclude intern/extern/volunteer time).
  const KO_FILLER = new Set(["active", "unrestricted", "current", "valid", "compact", "multistate", "state", "additional", "the", "a", "an", "in", "of", "or", "and", "required", "unexpired", "license", "licensure", "certification", "certificate"]);
  const koTokensOf = (requirement) => String(requirement || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w && !KO_FILLER.has(w));
  const gapFactCorpus = (f) => `${(f && f.title) || ""} ${(f && f.text) || ""} ${((f && f.bullets) || []).join(" ")}`.toLowerCase();
  const gapFactInProgress = (f) => /in progress|in-progress|pursuing|expected|graduating|enrolled|rising/i.test(gapFactCorpus(f));
  const gapFactNegatesCredential = (f) => /does not hold|doesn't hold|has not (yet )?(passed|obtained|earned)|not yet (passed|obtained|earned)|no (active |valid |current )?[a-z ]{0,24}licen[cs]e|unlicensed|not licensed/i.test(gapFactCorpus(f));
  function credentialSatisfied(tokens, profile) {
    if (!tokens.length) return null;
    const facts = Profile.confirmedFacts(profile);
    const hasAll = (text) => tokens.every((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    const usable = facts.filter((f) => !gapFactInProgress(f) && !gapFactNegatesCredential(f));
    for (const f of usable) if (f.kind === "certification" && hasAll(gapFactCorpus(f))) return true;
    const phrase = tokens.join(" ");
    for (const f of usable) {
      const text = gapFactCorpus(f);
      if (tokens.length >= 2 && text.includes(phrase)) return true;
      if (tokens.length === 1 && new RegExp(`\\b${tokens[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text) && /licen[cs]e|licensed|registered|certified/.test(text)) return true;
    }
    return false;
  }
  const DEGREE_RANK = { associate: 1, bachelor: 2, master: 3, jd: 4 };
  function degreeLevelOfFact(f) {
    if (!f || (f.kind !== "education" && f.kind !== "certification")) return null;
    if (gapFactInProgress(f)) return null;
    const em = String(f.end || "").match(/(\d{4})-(\d{2})/);
    if (em) { const now = new Date(); if (Number(em[1]) * 100 + Number(em[2]) > now.getFullYear() * 100 + (now.getMonth() + 1)) return null; }
    const t = gapFactCorpus(f);
    if (/juris doctor|\bjd\b/.test(t)) return "jd";
    if (/master|\bmba\b|m\.s\.|m\.a\.|m\.eng|\bmph\b|ll\.m/.test(t)) return "master";
    if (/bachelor|b\.s\.|b\.a\.|bsn|b\.b\.a|\bbba\b/.test(t)) return "bachelor";
    if (/associate|a\.a\.|a\.s\./.test(t)) return "associate";
    return null;
  }
  function degreeSatisfied(level, profile) {
    const want = level || "bachelor";
    const held = Profile.confirmedFacts(profile).map(degreeLevelOfFact).filter(Boolean);
    if (want === "jd") return held.includes("jd");
    return held.some((h) => DEGREE_RANK[h] >= (DEGREE_RANK[want] || 2));
  }
  function evidencedFullTimeYears(profile) {
    const facts = (profile && profile.facts) || [];
    let months = 0, any = false;
    const now = new Date();
    const nowMonths = now.getFullYear() * 12 + now.getMonth();
    for (const f of facts) {
      if (!f || f.kind !== "experience" || f.needs_confirmation) continue;
      if (/\b(intern|internship|extern|volunteer)\b/i.test(String(f.title || ""))) continue;
      const sm = String(f.start || "").match(/(\d{4})-(\d{2})/), em = String(f.end || "").match(/(\d{4})-(\d{2})/);
      if (!sm) continue;
      const startM = Number(sm[1]) * 12 + Number(sm[2]);
      const endM = em ? Number(em[1]) * 12 + Number(em[2]) : (/present/i.test(String(f.end || "")) ? nowMonths : startM);
      if (endM > startM) { months += endM - startM; any = true; }
    }
    return any ? Math.round((months / 12) * 10) / 10 : null;
  }
  function personaLevelOf(profile) {
    const raw = String((profile && profile.level) || "").toLowerCase();
    if (["intern", "early", "mid", "senior"].includes(raw)) return raw;
    const grad = String((profile && profile.constraints && profile.constraints.graduationDate) || "").match(/(\d{4})-(\d{2})/);
    if (grad) {
      const now = new Date();
      const gradM = Number(grad[1]) * 12 + Number(grad[2]);
      const nowM = now.getFullYear() * 12 + (now.getMonth() + 1);
      if (gradM > nowM) return "intern"; // still enrolled — a student record
      if (nowM - gradM <= 24) return "early";
    }
    return null;
  }
  function computeGaps(profile, jd) {
    profile = contentProfile(profile);
    const gaps = [];
    const skillRows = provenSkills(profile, jd);
    const provenNames = new Set(skillRows.filter((s) => s.proven).map((s) => s.name.toLowerCase()));
    const unprovenNames = new Map();
    for (const s of skillRows) if (!s.proven && !unprovenNames.has(s.name.toLowerCase())) unprovenNames.set(s.name.toLowerCase(), s);
    const factEvNames = new Set();
    for (const f of Profile.confirmedFacts(profile)) if (f.kind !== "skill") for (const n of factEvidencedSkillNames(f)) factEvNames.add(n.toLowerCase());
    const skillSatisfied = (name) => provenNames.has(name.toLowerCase()) || factEvNames.has(name.toLowerCase());
    // Knockouts first — a failed knockout is an eligibility fact, stated
    // with the posting's own requirement text and evidence sentence.
    const koCoveredSkills = new Set();
    for (const ko of jd.knockouts || []) {
      let satisfied = null, why = "";
      if (ko.type === "license" || ko.type === "certification") {
        satisfied = credentialSatisfied(koTokensOf(ko.requirement), profile);
        why = `no confirmed fact on your record evidences that ${ko.type} — an in-progress, negated or different credential does not satisfy it`;
      } else if (ko.type === "degree") {
        satisfied = degreeSatisfied(ko.level, profile);
        why = "your confirmed education facts do not evidence a conferred degree at that level (an in-progress degree is not conferred)";
      } else if (ko.type === "min_experience") {
        const years = evidencedFullTimeYears(profile);
        if (years != null) { satisfied = years >= (ko.min_years || 0); why = `your confirmed facts evidence about ${years} years of full-time experience`; }
      }
      if (satisfied === false) {
        gaps.push({ requirement: ko.requirement, kind: "knockout", type: ko.type, gapClass: "required", reasonClass: "knockout-failed", reason: `posting knockout not met — ${ko.requirement}: ${why}`, evidence: ko.evidence || null });
        for (const s of skillsInText(ko.requirement)) koCoveredSkills.add(s.toLowerCase());
      }
    }
    // Posting skills the record cannot satisfy from proven facts.
    const skillGap = (name, tier) => {
      if (skillSatisfied(name) || koCoveredSkills.has(name.toLowerCase())) return;
      if (gaps.some((g) => g.requirement.toLowerCase() === name.toLowerCase())) return;
      const unp = unprovenNames.get(name.toLowerCase());
      gaps.push({ requirement: name, kind: "skill", tier, gapClass: tier === "must-have" ? "required" : "preferred", reasonClass: "no-evidence", reason: unp
        ? `posting ${tier === "nice-to-have" ? "mentions" : "requires"} ${name}; the only record naming it is a skill fact with empty evidence (fact ${unp.factId}) — not proven, so it is not claimed`
        : `posting ${tier === "nice-to-have" ? "mentions" : "requires"} ${name}; no proven fact on your record evidences it`, evidence: null });
    };
    for (const s of jd.mustHaveSkills || []) skillGap(s, "must-have");
    for (const s of jd.niceToHaveSkills || []) skillGap(s, "nice-to-have");
    // Seniority-band mismatch (BUG-209): where BOTH level data points
    // exist — the posting's parsed band and the persona's level — a plain
    // eligibility mismatch is named, never silently shipped as a fit.
    const pl = personaLevelOf(profile);
    const band = jd.level || "unspecified";
    if (pl && (band === "senior" || band === "manager/lead") && (pl === "intern" || pl === "early")) {
      gaps.push({ requirement: `posting level (${band}) vs your level (${pl})`, kind: "level", type: "level_mismatch", gapClass: "eligibility", reasonClass: "knockout-failed", reason: `eligibility mismatch: this is a ${band} posting and your record is at ${pl} level — the tailored resume ships with this gap named, not as if the levels matched`, evidence: null });
    } else if (pl === "senior" && band === "intern") {
      gaps.push({ requirement: `posting level (intern) vs your level (senior)`, kind: "level", type: "level_mismatch", gapClass: "eligibility", reasonClass: "knockout-failed", reason: "eligibility mismatch: this is an intern posting (an enrolled-student band) and your record is at senior level — the tailored resume ships with this gap named, not as if the levels matched", evidence: null });
    }
    return gaps;
  }
  function gapSectionFor(gaps) {
    if (!gaps || !gaps.length) return null;
    return {
      heading: "Not covered by your record",
      lines: gaps.map((g) => ({ text: `${g.requirement} — ${g.reason}`, type: "gap", kind: g.kind, reasonClass: g.reasonClass })),
      text: `Not covered by your record: ${gaps.map((g) => g.requirement).join("; ")}`,
    };
  }
  // MI-025 last clause (Depth Lane C): the discrete eligibility
  // VERDICT, printed on the tailored document itself. The gap list
  // names what is missing (packet data); the verdict is the one-line
  // judgement a reader of the document alone can see. It is derived
  // only from computeGaps' classes, it names nothing the record does
  // not support (the missing items themselves stay in the gap list —
  // printing their names here would claim them), and it is attached
  // AFTER the truth audit like the gaps: it is a computed judgement
  // about the record, not a claim from it.
  function eligibilityVerdictFor(gaps) {
    const failed = (gaps || []).filter((g) => g.reasonClass === "knockout-failed");
    const required = (gaps || []).filter((g) => g.gapClass === "required");
    if (failed.length) return { status: "not_eligible", line: "Eligibility verdict: this record does not meet every hard requirement stated in the posting — the unmet requirements are named in the gap list that travels with this packet." };
    if (required.length) return { status: "eligible_with_required_gaps", line: "Eligibility verdict: this record meets the posting's hard requirements, but some required skills the posting names are not evidenced in the record — they are named in the gap list that travels with this packet." };
    return { status: "eligible", line: "Eligibility verdict: this record evidences every hard requirement and every required skill stated in the posting." };
  }

  // ---- main entry: tailor with the hard gate ----
  let versionSeq = 0;
  function tailorResume(profile, jdInput, opts) {
    profile = contentProfile(profile);
    const o = opts || {};
    const jd = jdInput && jdInput.mustHaveSkills ? jdInput : parseJD((jdInput && jdInput.text) || jdInput || "");
    const cir = o.cir || null;
    const aiBan = !!(cir && (cir.aiPolicy === "ban" || cir.bansAiWrittenText));
    const assembled = assemble(profile, jd, o);
    // Caller/user-supplied extra lines (e.g. "add Rust experience") are
    // appended BEFORE the audit, so an attempt to insert an unevidenced
    // skill or claim hits the same hard gate and refuses the whole output.
    if (Array.isArray(o.extraLines) && o.extraLines.length) {
      assembled.lines.push(...o.extraLines.map((l) => (typeof l === "string" ? { text: l, factIds: [], type: "bullet" } : l)));
      assembled.sections.push({ heading: "Additional", lines: o.extraLines.map((l) => (typeof l === "string" ? { text: l, factIds: [], type: "bullet" } : l)) });
    }
    const auditResult = auditResume(assembled, profile);
    if (!auditResult.ok) return { ok: false, refused: true, reason: "truth audit failed; tailored output refused (APPE-002 hard gate)", violations: auditResult.violations, output: null, resume: null, rendered: null };
    // Gaps are computed AFTER the hard gate, from proven facts only, and
    // attached to the document model + the version snapshot + the result —
    // a shipped resume always carries its uncovered requirements as data.
    const gaps = computeGaps(profile, jd);
    // R1 C11: gap CLASSES are first-class typed data, not a flat list a
    // caller must re-derive. requiredGaps = must-have skill gaps +
    // failed knockouts; preferredGaps = nice-to-have skill gaps only.
    // A result with preferredGaps non-empty is NOT a "no gap" result —
    // the spoken line's data source must be able to tell the classes
    // apart (level/eligibility gaps ride `gaps` + the gap section).
    const requiredGaps = gaps.filter((g) => g.gapClass === "required");
    const preferredGaps = gaps.filter((g) => g.gapClass === "preferred");
    assembled.gaps = gaps;
    assembled.requiredGaps = requiredGaps;
    assembled.preferredGaps = preferredGaps;
    assembled.gapSection = gapSectionFor(gaps);
    // MI-025: the verdict line joins the document model itself so
    // the rendered PDF/DOCX prints it. It rides as the closing note
    // line of the document's LAST section — a new heading of its own
    // would break the standing heading contracts (148's allowlist is
    // satisfied either way, but 133's ATS standard set and the R3
    // heading discipline pin the sections a tailored resume carries);
    // only a document with no sections at all gains a Summary
    // section to hold it.
    const verdict = eligibilityVerdictFor(gaps);
    assembled.eligibilityVerdict = verdict;
    {
      // The line joins the SECTION model only — never assembled.lines:
      // the flat line list carries the invariant that every line is
      // fact-cited (the truth audit's contract), and the verdict is a
      // computed judgement, not a fact claim. The gap section sets the
      // precedent: its lines likewise live outside the cited list.
      // 148 renders from sections, so the verdict still prints.
      const vLine = { text: verdict.line, type: "note", factIds: [] };
      const lastSec = assembled.sections[assembled.sections.length - 1];
      if (lastSec) { vLine.section = lastSec.heading; lastSec.lines.push(vLine); }
      else { vLine.section = "Summary"; assembled.sections.push({ heading: "Summary", lines: [vLine] }); }
    }
    const baseLines = o.baseLines || o.baseResumeLines || [];
    const diff = diffResume(baseLines, assembled, profile);
    const rendered = render(assembled, { profile });
    const version = { versionId: o.versionId || `resume-v${++versionSeq}`, jobId: o.jobId || null, company: cir && cir.company || o.company || null, date: o.date || null, family: assembled.family, diff, outcome: null, gaps, requiredGaps, preferredGaps };
    // §10.5: the approval snapshot records the exact rendered artifacts
    // (filename + sha256 + size) so a submitted resume can be reproduced.
    if (rendered && (rendered.pdf || rendered.docx)) version.artifacts = { pdf: rendered.pdf ? { filename: rendered.pdf.filename, sha256: rendered.pdf.sha256, bytes: rendered.pdf.bytes } : null, docx: rendered.docx ? { filename: rendered.docx.filename, sha256: rendered.docx.sha256, bytes: rendered.docx.bytes } : null, parseCheck: rendered.parseCheck ? rendered.parseCheck.status : null };
    if (aiBan) {
      return { ok: true, mode: "outline", reason: "company bans AI-written application text (CIR); degraded to outline+bullets for the user to write (Doc 2 S8)", outline: coverOutline(profile, jd, cir), bullets: assembled.lines, resume: assembled, rendered: null, coverLetter: null, audit: auditResult, diff, version, gaps, requiredGaps, preferredGaps, eligibilityVerdict: verdict };
    }
    const cover = o.wantCoverLetter ? generateCoverLetter(profile, jd, cir, o) : null;
    return { ok: true, mode: "full", resume: assembled, rendered, coverLetter: cover, audit: auditResult, diff, version, gaps, requiredGaps, preferredGaps, eligibilityVerdict: verdict };
  }

  return { BANNED_PHRASES, bannedPhrasesIn, SKILL_LEXICON, skillsInText, parseJD, detectFamily, FAMILIES, FAMILY_SKILLS, extractKnockouts, jdSegments, scoreFact, selectFacts, provenSkills, derivedSkillNames, skillFactProven, computeGaps, eligibilityVerdictFor, personaLevelOf, auditResume, audit, diffResume, render, generateCoverLetter, coverOutline, buildAnswerBank, tailorResume, wordCount };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerTailor;
