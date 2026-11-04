/* Career master profile (Doc 2 §1; capabilities DISC-002, APPE-001).
   The master profile is the single source of truth for every tailored output.
   EVERY fact carries a stable fact ID (F-001, F-002, ...): IDs are assigned once
   in insertion order from the profile's own counter, never reused, and an
   update never changes an ID, so a tailored line can cite the exact fact that
   supports it and an auditor can check nothing was invented.
   Skills: a skill fact with no evidence (empty `evidence` list and no other
   fact naming the skill) is flagged `unproven: true` — it may be shown to the
   user, but the truth audit in 123-career-tailor.js will not let it support a
   tailored line.
   Ingestion:
     - LinkedIn data archive: Connections.csv + Profile.csv (documented
       LinkedIn export formats; real headers are used in the tests). Parsed
       into profile facts + connection records, each tagged source
       "linkedin-export". Malformed rows (wrong column count) are collected
       as errors and skipped, never thrown and never silently canonised.
     - Plain-text resume: parsed into DRAFT facts, every one with
       needs_confirmation:true and status:"draft". A draft fact does not
       support tailoring until confirmFact() is called — ingestion never
       silently canonises. Ingest failures are TYPED (APD-3):
       classifyResumeIngest() returns reason classes unreadable / empty /
       unsupported and ingestResume() adds nothing on failure. A valid file
       merges under correction precedence: confirmed facts win, duplicates
       are skipped with an audit trail.
   Profile data lifecycle (SHD-3): retentionDeclaration() / RETENTION_DECLARATION
   state what is kept, where, and how long; previewProfileDeletion() lists
   exactly what a deletion would remove; deleteProfileData() performs it —
   facts, connections, sections and derived records — and returns a receipt.
   Fact-mining interview: factMiningQuestions(entry) returns the digging
   questions for a thin entry (missing stack / scale / what-it-replaced /
   metric / outcome), modelled on Doc 2 §1 ("what stack, how many users,
   what did it replace, any metric?").
   Pure: no I/O. The caller passes CSV / resume text in. UMD like the other
   domain modules. */
const CareerProfile = (() => {
  // WO-106: "goal" and "location" are kinds the agent saves (its add_profile_fact offers them); without them every stated
  // goal and place was kept as "other" and could not be found again.
  const KINDS = ["experience", "project", "skill", "education", "award", "leadership", "publication", "certification", "language", "preference", "goal", "location", "eligibility", "profile", "other"];

  function nextId(profile) {
    profile._seq = (profile._seq || 0) + 1;
    return `F-${String(profile._seq).padStart(3, "0")}`;
  }
  function bumpSeqForId(profile, id) {
    const n = Number(String(id || "").replace(/^F-/, ""));
    if (Number.isFinite(n) && n > (profile._seq || 0)) profile._seq = n;
  }

  function createProfile(seed) {
    const s = seed || {};
    const p = {
      id: s.id || "profile-1",
      label: s.label || null,
      isTestFixture: !!s.isTestFixture,
      basics: Object.assign({ name: null, email: null, phone: null, location: null, links: {} }, s.basics || {}),
      preferences: Object.assign({ roles: [], industries: [], locations: [], remote: null, companySize: null, compFloor: null, dealBreakers: [], targetCompanies: [], excludedCompanies: [] }, s.preferences || {}),
      constraints: Object.assign({ graduationDate: null, startDate: null, workAuthorization: null, needsSponsorship: null, relocation: null, securityClearance: null }, s.constraints || {}),
      defaults: Object.assign({ pronouns: null, demographicPreference: "decline to answer", gpa: null }, s.defaults || {}),
      facts: [],
      connections: [],
      _seq: 0,
    };
    // Preserve an explicitly supplied owner for the source-bound application adapter; never infer one.
    if (typeof s.user_id === "string") p.user_id = s.user_id;
    for (const f of s.facts || []) addFact(p, f, { keepId: true });
    for (const c of s.connections || []) p.connections.push(Object.assign({}, c));
    return p;
  }

  // profileFromData is createProfile with the fixture/JSON shape kept verbatim.
  function profileFromData(data) { return createProfile(data || {}); }

  function normalizeFact(profile, input, opts) {
    const o = opts || {};
    const f = Object.assign({}, input || {});
    f.id = o.keepId && f.id ? String(f.id) : nextId(profile);
    if (o.keepId) bumpSeqForId(profile, f.id);
    f.kind = KINDS.includes(f.kind) ? f.kind : "other";
    f.title = f.title || f.name || "";
    f.text = f.text || f.title || "";
    f.bullets = Array.isArray(f.bullets) ? f.bullets.slice() : [];
    f.skills = Array.isArray(f.skills) ? f.skills.slice() : (f.name && f.kind === "skill" ? [f.name] : []);
    f.evidence = Array.isArray(f.evidence) ? f.evidence.slice() : [];
    f.source = f.source || "user";
    f.needs_confirmation = !!f.needs_confirmation;
    f.status = f.needs_confirmation ? "draft" : (f.status || "confirmed");
    if (f.kind === "skill") {
      f.name = f.name || f.title;
      f.unproven = f.evidence.length === 0;
    }
    return f;
  }

  function addFact(profile, input, opts) {
    const f = normalizeFact(profile, input, opts);
    // A skill is proven if another already-stored fact evidences it by name,
    // even when its own evidence list is empty at insert time; recompute on add.
    profile.facts.push(f);
    refreshSkillFlags(profile);
    return f;
  }
  function refreshSkillFlags(profile) {
    for (const f of profile.facts) {
      if (f.kind !== "skill") continue;
      const name = (f.name || "").toLowerCase();
      const evidencedByFactText = profile.facts.some((x) => x.id !== f.id && x.kind !== "skill" && ((x.skills || []).some((s) => String(s).toLowerCase() === name) || String(x.text || "").toLowerCase().includes(name)));
      f.unproven = !(f.evidence && f.evidence.length) && !evidencedByFactText;
    }
  }
  function updateFact(profile, id, patch) {
    const f = getFact(profile, id);
    if (!f) return null;
    const keepId = f.id;
    Object.assign(f, patch || {});
    f.id = keepId; // IDs are stable: an update never reassigns one.
    if (f.kind === "skill") f.unproven = !(f.evidence && f.evidence.length);
    refreshSkillFlags(profile);
    return f;
  }
  function getFact(profile, id) { return (profile.facts || []).find((f) => f.id === id) || null; }
  function listFacts(profile, filter) {
    return (profile.facts || []).filter((f) => !filter || Object.entries(filter).every(([k, v]) => f[k] === v));
  }
  function confirmFact(profile, id) {
    const f = getFact(profile, id);
    if (!f) return null;
    f.needs_confirmation = false; f.status = "confirmed";
    return f;
  }
  // D-007 (docs/architect/DECISIONS.md): the 47 agent-invented "confirmed" facts from the owner's answer-all delegation
  // never feed anything written for a person (essay, resume, cover letter, cold email, form answer). One reader decides,
  // the same rule as the extension's contract (extension/src/apply_core.ts quarantinedFact): a fact flagged quarantined,
  // or one whose provenance/source names the delegation, or the bank's own ids F-027..F-079 — read only from the bank's id
  // field (factId), because every chat profile numbers its own facts F-001 up and those are the person's own.
  const QUARANTINE_VERSION = "d007-v1";
  const DELEGATED = /owner-delegated|answer-all|delegated[- _]answers|mi-038/i;
  function quarantinedFact(f) {
    if (!f || typeof f !== "object") return false;
    if (f.quarantine || f.quarantined) return true;
    if (["provenance", "source", "origin"].some((k) => DELEGATED.test(String(f[k] == null ? "" : f[k])))) return true;
    const m = /^F-0*(\d+)$/.exec(String(f.factId == null ? "" : f.factId).trim());
    return !!m && Number(m[1]) >= 27 && Number(m[1]) <= 79;
  }
  function confirmedFacts(profile) { return (profile.facts || []).filter((f) => !f.needs_confirmation && !quarantinedFact(f)); }
  function unprovenSkills(profile) { refreshSkillFlags(profile); return (profile.facts || []).filter((f) => f.kind === "skill" && f.unproven); }
  function skillEvidence(profile, skillName) {
    const name = String(skillName || "").toLowerCase();
    const skill = (profile.facts || []).find((f) => f.kind === "skill" && (f.name || "").toLowerCase() === name);
    const supporting = (profile.facts || []).filter((f) => !f.needs_confirmation && f.kind !== "skill" && ((f.skills || []).some((s) => String(s).toLowerCase() === name) || String(f.text || "").toLowerCase().includes(name)));
    const evidenceIds = new Set([].concat((skill && skill.evidence) || [], supporting.map((f) => f.id)));
    return { skill: skill || null, proven: evidenceIds.size > 0 && (skill ? !skill.unproven || supporting.length > 0 : supporting.length > 0), evidenceFactIds: [...evidenceIds], supportingFactIds: supporting.map((f) => f.id) };
  }

  // ---- fact-mining interview (Doc 2 §1) ----
  const METRIC_RE = /\b\d+(\.\d+)?\s*(%|users?|customers?|teams?|members?|people|hours?|minutes?|pages?|companies|participants|requests|ms\b|x\b)/i;
  const NUMBER_RE = /\b\d[\d,.]*\b/;
  function factMiningQuestions(entry) {
    const e = entry || {};
    const text = [e.title, e.text, ...(e.bullets || [])].filter(Boolean).join(" ");
    const stack = (e.skills && e.skills.length) || /\b(react|python|java|javascript|typescript|go|sql|excel|kubernetes|docker|aws|node)\b/i.test(text);
    const qs = [];
    if (!stack) qs.push("What stack or tools did you use for this — languages, frameworks, and infrastructure?");
    if (!/\b\d+\s+(?:\w+\s+)?(users?|customers?|teams?|members?|people|participants)\b/i.test(text)) qs.push("How many users, teams, or people used or were affected by this?");
    if (!/replac|instead of|manual|spreadsheet|previously|before this/i.test(text)) qs.push("What did this replace, or what was done manually before it?");
    if (!METRIC_RE.test(text) && !NUMBER_RE.test(text)) qs.push("Is there any metric — a percentage, a time saved, a count, or a result you can point to?");
    if (!/result|outcome|cut |increased|reduced|improved|led to|shipped|launched/i.test(text)) qs.push("What changed because of this work — what was the outcome?");
    if (!(e.start || e.end || /\b(19|20)\d{2}\b/.test(text))) qs.push("When did you do this, and for how long?");
    return qs;
  }
  const isThin = (entry) => factMiningQuestions(entry).length >= 2;

  // ---- CSV (LinkedIn exports use quoted fields with embedded commas) ----
  function parseCsv(text) {
    const rows = []; let row = [], cur = "", inQ = false;
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.some((x) => String(x).trim() !== "")) rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.some((x) => String(x).trim() !== "")) rows.push(row);
    return rows;
  }
  function rowsToObjects(text, headerNeedle) {
    const rows = parseCsv(text);
    const hi = rows.findIndex((r) => r.some((c) => String(c).trim().toLowerCase() === headerNeedle));
    if (hi < 0) return { headers: [], objects: [], errors: [{ row: 0, reason: `header row containing "${headerNeedle}" not found` }], preamble: rows.length };
    const headers = rows[hi].map((h) => String(h).trim());
    const objects = [], errors = [];
    rows.slice(hi + 1).forEach((r, idx) => {
      if (r.length !== headers.length) { errors.push({ row: hi + 2 + idx, reason: `expected ${headers.length} columns, got ${r.length}`, raw: r }); return; }
      const obj = {}; headers.forEach((h, j) => { obj[h] = String(r[j] == null ? "" : r[j]).trim(); });
      objects.push(obj);
    });
    return { headers, objects, errors, preamble: hi };
  }

  // LinkedIn Connections.csv headers (real export):
  // First Name,Last Name,URL,Email Address,Company,Position,Connected On
  function parseLinkedInConnections(csvText) {
    const { objects, errors } = rowsToObjects(csvText, "first name");
    const connections = objects.map((o) => ({
      firstName: o["First Name"] || "", lastName: o["Last Name"] || "",
      name: `${o["First Name"] || ""} ${o["Last Name"] || ""}`.trim(),
      url: o["URL"] || null, email: o["Email Address"] || null,
      company: o["Company"] || null, position: o["Position"] || null,
      connectedOn: o["Connected On"] || null, source: "linkedin-export",
    })).filter((c) => c.name);
    return { connections, errors };
  }
  // LinkedIn Profile.csv headers (real export):
  // First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers
  function parseLinkedInProfile(csvText) {
    const { objects, errors } = rowsToObjects(csvText, "first name");
    if (!objects.length) return { profileRow: null, errors };
    const o = objects[0];
    return {
      profileRow: {
        firstName: o["First Name"] || "", lastName: o["Last Name"] || "",
        headline: o["Headline"] || null, summary: o["Summary"] || null,
        industry: o["Industry"] || null, geoLocation: o["Geo Location"] || null,
        websites: o["Websites"] || null, source: "linkedin-export",
      },
      errors,
    };
  }
  function ingestLinkedIn(profile, input) {
    const inp = input || {};
    const addedFacts = [], errors = [];
    if (inp.connectionsCsv) {
      const r = parseLinkedInConnections(inp.connectionsCsv);
      errors.push(...r.errors.map((e) => ({ ...e, file: "Connections.csv" })));
      for (const c of r.connections) profile.connections.push(c);
      if (r.connections.length) addedFacts.push(addFact(profile, { kind: "other", title: `LinkedIn connections (${r.connections.length})`, text: `Imported ${r.connections.length} LinkedIn connections from a LinkedIn data export.`, source: "linkedin-export" }));
    }
    if (inp.profileCsv) {
      const r = parseLinkedInProfile(inp.profileCsv);
      errors.push(...r.errors.map((e) => ({ ...e, file: "Profile.csv" })));
      if (r.profileRow) {
        const pr = r.profileRow;
        if (pr.firstName || pr.lastName) profile.basics.name = profile.basics.name || `${pr.firstName} ${pr.lastName}`.trim();
        if (pr.geoLocation) profile.basics.location = profile.basics.location || pr.geoLocation;
        addedFacts.push(addFact(profile, { kind: "other", title: pr.headline || "LinkedIn headline", text: [pr.headline, pr.summary].filter(Boolean).join(" — ") || "LinkedIn profile imported.", source: "linkedin-export" }));
      }
    }
    return { addedFacts, connections: profile.connections.slice(), errors };
  }

  // ---- plain-text resume ingestion -> DRAFT facts only ----
  const SECTION_KIND = { education: "education", experience: "experience", "work experience": "experience", employment: "experience", projects: "project", "personal projects": "project", leadership: "leadership", awards: "award", certifications: "certification", skills: "skill", "technical skills": "skill" };
  // ONBOARDING SCENARIOS (2026-10-29, tests/architect/scenarios-onboarding.test.ts): a heading this parser did not know
  // ("PROFESSIONAL EXPERIENCE", "Volunteer Experience", "HONORS", "SUMMARY") was read as an ENTRY of the section above it,
  // so an internship under "PROFESSIONAL EXPERIENCE" became an education fact (and the heading itself one), and the
  // person was asked to confirm a record that misfiled them. A line that is a heading now opens its own section: a known
  // kind by its head noun, or, for a heading that holds no entries (summary, objective, interests...) or one this parser
  // cannot place, a section that is NOT read, named back to the person so nothing is silently dropped or misfiled.
  const HEAD_NOUNS = [
    [/\b(?:volunteer(?:ing)?|leadership|activities|involvement|extracurriculars?|affiliations|memberships|community service)\b/, "leadership"],
    [/\b(?:experience|employment|internships?|work history|positions)\b/, "experience"], [/\bprojects?\b/, "project"],
    [/\b(?:skills|technologies|tools|technical proficiencies)\b/, "skill"], [/\b(?:education|academics|academic background)\b/, "education"],
    [/\b(?:awards?|honou?rs|achievements|accomplishments|scholarships)\b/, "award"],
    [/\b(?:certifications?|certificates?|licenses?)\b/, "certification"], [/\b(?:publications?|papers|presentations)\b/, "publication"], [/\blanguages\b/, "language"],
  ];
  const SKIP_NOUNS = /\b(?:summary|objective|profile|interests|hobbies|references|coursework|highlights|qualifications|information|about me|overview|contact)\b/;
  const HEADER_WORDS = new Set(["professional", "relevant", "work", "technical", "academic", "selected", "select", "personal", "additional", "other", "core", "key", "research", "teaching", "military", "volunteer", "volunteering", "community", "campus", "leadership", "and", "related", "career", "honors", "honours", "awards", "experience", "experiences", "employment", "history", "internship", "internships", "projects", "project", "skills", "education", "activities", "involvement", "extracurricular", "extracurriculars", "certifications", "certificates", "licenses", "publications", "languages", "summary", "objective", "profile", "interests", "hobbies", "references", "coursework", "highlights", "qualifications", "achievements", "accomplishments", "affiliations", "memberships", "service", "information", "overview", "tools", "technologies", "background", "of"]);
  function sectionOf(line) {
    const raw = String(line || "").trim();
    const h = raw.replace(/:\s*$/, "").trim();
    if (!h || h.length > 40 || /\d/.test(h)) return null;
    const k = h.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
    const known = SECTION_KIND[k] || SECTION_KIND[k.replace(/ and /g, " & ")];
    if (known) return { kind: known };
    const words = k.split(/[\s/,-]+/).filter(Boolean);
    // A heading is made of heading words only ("PROFESSIONAL EXPERIENCE", "Honors and Awards"), or ends in one with a colon
    // ("Campus Involvement:"); an entry ("PROJECT MANAGER", "Research Assistant") is not.
    const headerish = words.length <= 5 && (words.every((w) => HEADER_WORDS.has(w)) || (/:\s*$/.test(raw) && HEADER_WORDS.has(words[words.length - 1])));
    if (!headerish) return null;
    for (const [re, kind] of HEAD_NOUNS) if (re.test(k)) return { kind };
    if (SKIP_NOUNS.test(k)) return { skip: true, label: h };
    return null;
  }
  function parseResumeText(text) { return parseResumeSections(text).drafts; }
  function parseResumeSections(text) {
    // CHAT PASTE SHAPE (text-path measurement 2026-10-24): a resume
    // pasted into a chat is often ONE paragraph with its section
    // headers inline ("... Experience: Data Analyst at ... Skills:
    // SQL, ... Education: ..."). The line parser below reads a
    // header only as a whole line, so such a paste produced zero
    // drafts and the ingest honestly reported "empty" for a full
    // resume. A line carrying TWO OR MORE inline section markers is
    // segmented at those markers before parsing; a single stray
    // marker inside prose changes nothing, and multi-line resumes
    // parse exactly as before.
    const markerKeys = [...Object.keys(SECTION_KIND), "summary", "objective"].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const markerRe = new RegExp(`(^|[.!?]\\s+|\\s)(${markerKeys.join("|")})\\s*:`, "gi");
    const lines = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const marks = [...rawLine.matchAll(markerRe)];
      if (marks.length < 2) { lines.push(rawLine); continue; }
      const firstHead = marks[0].index + marks[0][1].length;
      const pre = rawLine.slice(0, firstHead).trim();
      if (pre) {
        // HELD-OUT (2026-10-24): the lead of a segmented paste is
        // usually name + the CURRENT ROLE narrated in prose ("…
        // Marketing Coordinator at Brightpath Media. Ran email
        // campaigns…") with no "Experience:" marker of its own —
        // the line parser below would drop it as a header block
        // and the role the user leads with would vanish. When the
        // lead carries a role-at-company shape with narrative
        // after it, it IS the experience section: emit it as one,
        // with a leading "Name - " segment stripped. A lead that
        // is only a name/contact line does not match and parses
        // exactly as before.
        const nameStrip = pre.match(/^([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s+[-—]\s+(.+)$/);
        const leadBody = nameStrip ? nameStrip[2] : pre;
        if (/\b(?:at|@)\s+[A-Z][\w&.'-]+/.test(leadBody) && /[.!?]\s+\S/.test(leadBody)) {
          lines.push("Experience:");
          lines.push(leadBody);
        } else lines.push(pre);
      }
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        const contentStart = m.index + m[0].length;
        const contentEnd = i + 1 < marks.length ? marks[i + 1].index + marks[i + 1][1].length : rawLine.length;
        lines.push(`${m[2].trim()}:`);
        const content = rawLine.slice(contentStart, contentEnd).trim();
        if (content) lines.push(content);
      }
    }
    const drafts = [], unread = [];
    let section = null, current = null;
    const flush = () => { if (current) { drafts.push(current); current = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^test resume/i.test(line)) continue;
      const head = sectionOf(line);
      if (head) {
        flush();
        if (head.skip) { section = null; if (!unread.includes(head.label)) unread.push(head.label); } else section = head.kind;
        continue;
      }
      if (!section) continue; // header/contact block (or a section that holds no entries) is not a fact
      if (section === "skill") {
        for (const name of line.split(/[,;•|]/).map((x) => x.trim()).filter(Boolean)) {
          drafts.push({ kind: "skill", name, title: name, text: `Skill: ${name}`, skills: [name], evidence: [], source: "resume-ingest", needs_confirmation: true, status: "draft" });
        }
        continue;
      }
      const bullet = line.match(/^[-•*]\s+(.*)$/);
      if (bullet && current) { current.bullets.push(bullet[1]); current.text += ` ${bullet[1]}`; continue; }
      if (bullet && !current) { current = { kind: section, title: bullet[1], text: bullet[1], bullets: [], source: "resume-ingest", needs_confirmation: true, status: "draft" }; continue; }
      flush();
      current = { kind: section, title: line, text: line, bullets: [], source: "resume-ingest", needs_confirmation: true, status: "draft" };
    }
    flush();
    return { drafts, unread };
  }
  // ---- typed ingest failures (APD-3, module half) ----
  // A corrupt, empty, or unsupported upload is a TYPED failure the caller can speak
  // honestly — never a silent fall-through to profile-only tailoring, and a failed
  // ingest adds NOTHING to the profile. Reason classes are exactly:
  //   "unreadable"  — bytes/text that cannot be read as text (binary, corrupt)
  //   "empty"       — no text at all, or no resume content extractable from it
  //   "unsupported" — a format this plain-text ingest cannot read (.pdf/.docx/images…)
  // A valid file merges under the SAME precedence as corrections (130's rule: an
  // explicit confirmed record wins): resume facts arrive as DRAFTS, a draft never
  // displaces or duplicates a CONFIRMED fact, and every merge decision is audited.
  const SUPPORTED_RESUME_FORMATS = { extensions: [".txt", ".md", ".text"], mimeTypes: ["text/plain", "text/markdown", "text/x-markdown"] };
  const UNSUPPORTED_EXTS = [".pdf", ".docx", ".doc", ".rtf", ".odt", ".pages", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".zip"];
  const UNSUPPORTED_MIMES = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/rtf", "application/zip"];
  function ingestInputInfo(input) {
    if (input == null || typeof input === "string") return { text: input == null ? null : String(input), fileName: null, mimeType: null };
    const fileName = input.fileName || input.filename || input.name || null;
    return { text: input.text != null ? String(input.text) : (input.content != null ? String(input.content) : (input.resumeText != null ? String(input.resumeText) : null)), fileName, mimeType: input.mimeType || input.type || null };
  }
  function looksUnreadable(text) {
    const t = String(text || "");
    if (t.includes("\u0000")) return true;
    if (/^%PDF-/.test(t) || t.startsWith("PK\u0003\u0004")) return true; // raw PDF / ZIP containers handed over as "text"
    if (t.length >= 20) {
      let bad = 0; for (const ch of t) { const cp = ch.codePointAt(0); if (ch === "\uFFFD" || (cp < 32 && !"\n\r\t".includes(ch))) bad++; }
      if (bad / t.length > 0.02) return true;
    }
    return false;
  }
  function classifyResumeIngest(input) {
    const info = ingestInputInfo(input);
    const ext = info.fileName ? (String(info.fileName).toLowerCase().match(/\.[a-z0-9]+$/) || [null])[0] : null;
    const mime = info.mimeType ? String(info.mimeType).toLowerCase() : null;
    // Content readability is checked FIRST: a corrupt/binary blob is "unreadable"
    // whatever its filename claims; a readable-but-wrong-format file is "unsupported".
    if (info.text != null && String(info.text).trim() !== "" && looksUnreadable(info.text)) {
      return { ok: false, reason_class: "unreadable", file_name: info.fileName, reason: "the file could not be read as text — it looks like binary or corrupt data, so nothing could be extracted from it", next_step: "Re-save or re-export the resume as plain text and upload it again.", supported_formats: SUPPORTED_RESUME_FORMATS };
    }
    if ((ext && UNSUPPORTED_EXTS.includes(ext)) || (mime && (UNSUPPORTED_MIMES.includes(mime) || mime.startsWith("image/")))) {
      const fmt = ext || mime;
      return { ok: false, reason_class: "unsupported", file_name: info.fileName, reason: `the file format (${fmt}) cannot be read by this resume ingest, which reads plain text only`, next_step: "Upload a plain-text version (.txt or .md), or paste the resume text instead.", supported_formats: SUPPORTED_RESUME_FORMATS };
    }
    if (info.text == null || String(info.text).trim() === "") {
      return { ok: false, reason_class: "empty", file_name: info.fileName, reason: "the uploaded file contained no text", next_step: "Re-upload a non-empty resume file, or paste the resume text instead.", supported_formats: SUPPORTED_RESUME_FORMATS };
    }
    return { ok: true, file_name: info.fileName, text: info.text };
  }
  function ingestFailure(cls) {
    return { ok: false, failure: { kind: "ingest_failure", reason_class: cls.reason_class, reason: cls.reason, file_name: cls.file_name || null, next_step: cls.next_step, supported_formats: cls.supported_formats }, drafts: [], factIds: [], added_fact_ids: [], skipped_duplicates: [], audit: [] };
  }
  const normKeyText = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  function draftKey(d) { return d.kind === "skill" ? `skill|${normKeyText(d.name || d.title)}` : `${d.kind}|${normKeyText(d.title || d.text)}`; }
  function ingestResume(profile, input, opts) {
    const cls = classifyResumeIngest(input);
    if (!cls.ok) return ingestFailure(cls);
    const { drafts: parsed, unread } = parseResumeSections(cls.text);
    if (!parsed.length) return ingestFailure({ reason_class: "empty", file_name: cls.file_name, reason: "no resume content could be extracted from the file — no sections or entries were found in it", next_step: "Upload the resume as plain text with its sections (Experience, Skills, Education), or paste the text instead.", supported_formats: SUPPORTED_RESUME_FORMATS });
    // ONBOARDING SCENARIOS (2026-10-29): a resume given again is the WHOLE resume, never a patch on the last one.
    //   - The same resume as the one confirmed (every entry, word for word) changes nothing: no second copy of any entry.
    //   - Drafts of an earlier paste that was never confirmed are replaced by this paste's (they stood beside it, so a later
    //     yes could confirm two copies, or the earlier paste's entries).
    //   - A different resume arrives whole, as drafts: an entry it shares with the confirmed one is a draft of THIS resume
    //     (it was skipped as a duplicate, so the new resume read back partial and the record bound to it lost the entry).
    //     The confirmed one stays in force until this one is confirmed (supersedeResume, at the person's yes).
    // A confirmed fact that did not come from a resume (one they stated or corrected) still wins over a resume draft.
    const fromResume = (f) => f && f.source === "resume-ingest";
    const textKey = (f) => `${draftKey(f)}|${normKeyText(f.text)}`;
    const replaced = (profile.facts || []).filter((f) => fromResume(f) && f.needs_confirmation).map((f) => f.id);
    if (replaced.length) profile.facts = profile.facts.filter((f) => !replaced.includes(f.id));
    const standing = (profile.facts || []).filter((f) => fromResume(f) && !f.needs_confirmation && !quarantinedFact(f));
    const inFile = [...new Map(parsed.map((d) => [draftKey(d), d])).values()];
    if (standing.length && standing.length === inFile.length) {
      const have = new Set(standing.map(textKey));
      if (inFile.every((d) => have.has(textKey(d)))) {
        return { ok: true, failure: null, same_as_confirmed: true, drafts: [], factIds: [], added_fact_ids: [], skipped_duplicates: [], audit: [{ action: "same_as_confirmed", fact_ids: standing.map((f) => f.id) }, ...(replaced.length ? [{ action: "replaced_unconfirmed_drafts", fact_ids: replaced }] : [])], unread_sections: unread, replaced_drafts: replaced };
      }
    }
    // Merge with correction precedence: CONFIRMED facts win. A parsed draft that
    // duplicates a confirmed fact the person gave outside a resume (or an earlier
    // draft from this same file) is skipped and audited, never added as a shadow copy.
    const confirmedByKey = new Map();
    for (const f of profile.facts || []) if (!f.needs_confirmation && !fromResume(f)) confirmedByKey.set(f.kind === "skill" ? `skill|${normKeyText(f.name || f.title)}` : `${f.kind}|${normKeyText(f.title || f.text)}`, f);
    const seen = new Set(), drafts = [], skipped_duplicates = [], audit = replaced.length ? [{ action: "replaced_unconfirmed_drafts", fact_ids: replaced }] : [];
    for (const d of parsed) {
      const key = draftKey(d);
      const confirmed = confirmedByKey.get(key);
      if (confirmed) { const entry = { title: d.title || d.name || "", name: d.name || null, kind: d.kind, existing_fact_id: confirmed.id, reason: "a confirmed fact already covers this — a resume draft never overrides or duplicates a confirmed fact" }; skipped_duplicates.push(entry); audit.push({ action: "skipped_duplicate_of_confirmed", ...entry }); continue; }
      if (seen.has(key)) { const entry = { title: d.title || d.name || "", name: d.name || null, kind: d.kind, existing_fact_id: null, reason: "duplicate within the uploaded file" }; skipped_duplicates.push(entry); audit.push({ action: "skipped_duplicate_in_file", ...entry }); continue; }
      seen.add(key);
      const f = addFact(profile, d);
      f.needs_confirmation = true; f.status = "draft"; // a resume draft can never arrive confirmed by accident
      drafts.push(f);
      audit.push({ action: "added_draft", fact_id: f.id, kind: f.kind, source: "resume-ingest", precedence: "draft — needs confirmation; confirmed facts win" });
    }
    refreshSkillFlags(profile);
    const record = { at: (opts && opts.now) || null, file_name: cls.file_name || null, added_fact_ids: drafts.map((f) => f.id), skipped_duplicates, outcome: "ingested_as_drafts", ...(unread.length ? { unread_sections: unread.slice() } : {}), ...(replaced.length ? { replaced_drafts: replaced } : {}) };
    profile.profile_ingest_audit = [...(profile.profile_ingest_audit || []), record];
    return { ok: true, failure: null, drafts, factIds: drafts.map((f) => f.id), added_fact_ids: drafts.map((f) => f.id), skipped_duplicates, audit, unread_sections: unread, replaced_drafts: replaced };
  }
  // The person confirmed a resume (keepIds: its entries): every other CONFIRMED entry that came from a resume is an earlier
  // resume's and leaves the profile, so nothing reads it again (no answer, tailoring, form or application). A draft is
  // left as it is (it feeds nothing, and a paste already replaced the drafts of the one before it); facts they gave
  // outside a resume stay. Returns the ids removed, and keeps their ids and titles in the ingest audit.
  function supersedeResume(profile, keepIds, opts) {
    const keep = new Set(keepIds || []);
    const gone = (profile.facts || []).filter((f) => f && f.source === "resume-ingest" && !f.needs_confirmation && !keep.has(f.id));
    if (!gone.length) return [];
    const ids = gone.map((f) => f.id);
    profile.facts = profile.facts.filter((f) => !ids.includes(f.id));
    refreshSkillFlags(profile);
    profile.profile_ingest_audit = [...(profile.profile_ingest_audit || []), { at: (opts && opts.now) || null, outcome: "superseded_by_confirmed_resume", removed_fact_ids: ids, removed: gone.map((f) => ({ id: f.id, kind: f.kind, title: String(f.title || f.name || "").slice(0, 120) })) }];
    return ids;
  }

  // ---- the person's reply to entries shown for their confirmation (D-007) ----
  // Only a plain yes confirms. A question ("yes?", "correct?"), a hedge ("yeah maybe", "looks ok I guess", "I think so"),
  // a pause ("wait", "hold on"), an emoji, a yes carrying anything more ("yes but...", "yes and apply to Stripe") confirms
  // nothing. A correction ("my title was X not Y", "change Y to X", "not Y, X") names exactly what changes. Returns
  //   { kind: "yes" } | { kind: "no" } | { kind: "correction", from, to } | { kind: "unclear", why } | { kind: "other" }
  // where "other" is a message that is not a reply to the question at all (a new ask), which the caller leaves alone.
  const YES_LEAD = "(?:yes+|yse|yeah|yep|yup|yea|ya|ok(?:ay)?|sure)";
  const YES_CORE = [
    "yes+", "yse", "yeah", "yep", "yup", "yea", "yes please", "correct", "all correct", "confirmed", "confirm", "i confirm", "confirm (?:it|them|all|that|those|everything|my resume|the resume)",
    "all good", "all right", "that'?s right", "that is right", "that'?s correct", "that is correct", "that'?s it", "that'?s me", "that'?s all correct", "that'?s all right",
    "(?:that|this|it)(?:'?s| is) (?:my|the) (?:resume|cv)", "(?:that|this|it)(?:'?s| is) (?:my|the) (?:resume|cv) (?:alright|all right)", "it is", "it'?s right", "it'?s correct", "it'?s all (?:correct|right)",
    "looks (?:good|right|correct|great|perfect)(?: to me)?", "lgtm","(?:they|those|these) look (?:good|right|correct)", "(?:everything|all of it|all of them|every entry|each one)(?:'?s| is| are) (?:right|correct|accurate)",
    "perfect", "exactly", "accurate", "do it", "yes it is", "spot on",
  ].join("|");
  const YES_RE = new RegExp(`^(?:${YES_LEAD}[,!.]*\\s*[-—–]?\\s*)?(?:${YES_CORE})(?:[,!.]*\\s*(?:${YES_CORE}))?(?:[,!.]*\\s*(?:thanks|thank you|ty|thx))?$`);
  const NO_RE = /^(?:no+|nope|nah|not quite|not really|not right|not correct|wrong|incorrect|that'?s wrong|that is wrong|that'?s not (?:right|correct|it|me|mine|my resume)|(?:this|it)(?:'?s| is) not (?:right|correct|mine|my resume)|not mine|not my resume|none of (?:it|that|them)|no,? (?:that'?s|it'?s) (?:wrong|not right|not correct|not mine)|no,? (?:that|it) is not (?:right|correct|mine))$/;
  const HEDGE = /\b(?:maybe|i guess|guess so|i think|think so|probably|kinda|kind of|sort of|not sure|unsure|idk|i don'?t know|dunno|wait|hold on|hang on|hmm+|h+m+|uh+|um+|erm|later|let me (?:check|look|see|think)|one sec|a sec|not yet|almost|mostly|i suppose|suppose so|i believe|perhaps|possibly|might|could be|ish|i hope|hopefully|if you say so|whatever|fine i guess|seems)\b/;
  const REPLYISH = /\b(?:yes+|yse|yeah|yep|yup|yea|ya|no+|nope|nah|ok(?:ay)?|k|sure|fine|correct|right|wrong|good|looks?|confirm\w*|accurate|true|maybe|guess|think|probably|wait|hold|hang|hmm+|idk|perfect|great|cool|alright|fair|close|resume|cv|entry|entries|all of it)\b/;
  // A new ask ("find me jobs in Denver", "maybe apply to Stripe") is not a reply to the entries, whatever words ride it.
  const TASK = /\b(?:find|search|look for|apply|show me|write|draft|tailor|send|email|message|dm|watch|alert|remind|schedule|prep|prepare|mock|interview|track|list|connect|help me)\b/;
  const CORR_LEAD =/^(?:(?:no+|nope|nah|yes|yeah|yep|almost|close|mostly|actually|oh|oops|sorry|one thing|small fix|quick fix|fix|correction|but|except|wait)\b[\s,:;.!—–-]*)+/i;
  const VAGUE = /^(?:it|that|this|those|these|them|one|the (?:title|role|school|date|dates|gpa|company|name|job|entry))$/i;
  // Quotes and trailing punctuation off; a parenthesis only when it is unbalanced ("Northwind (TEST)" keeps its own).
  const clean = (x) => {
    let v = String(x || "").trim().replace(/^["'“‘]+|["'”’.,;:!]+$/g, "").trim();
    const count = (c) => (v.match(c === "(" ? /\(/g : /\)/g) || []).length;
    while (v.endsWith(")") && count(")") > count("(")) v = v.slice(0, -1).trim();
    while (v.startsWith("(") && count("(") > count(")")) v = v.slice(1).trim();
    return v.replace(/["'”’.,;:!]+$/g, "").trim();
  };
  function correctionOf(text) {
    let t = String(text || "").trim().replace(/[’`]/g, "'").replace(/[.!]+$/, "").trim();
    t = t.replace(CORR_LEAD, "").trim();
    if (!t) return null;
    const pats = [
      // "my title was X not Y", "the GPA should be X, not Y", "my school is X instead of Y"
      /^(?:my|the)\s+(?:[\w.'& -]{1,40}?\s+)?(?:was|is|were|are|should be|should say|should read)\s+(?<to>.+?)\s*,?\s+(?:and )?(?:not|instead of|rather than)\s+(?<from>.+)$/i,
      // "it's X not Y", "that should say X instead of Y"
      /^(?:it|that|this)(?:'s|\s+is|\s+was|\s+should be|\s+should say|\s+should read)\s+(?<to>.+?)\s*,?\s+(?:and )?(?:not|instead of|rather than)\s+(?<from>.+)$/i,
      // "not Y, X", "not Y but X", "not Y — it was X"
      /^not\s+(?<from>.+?)\s*(?:[,;—–-]+\s*|\s+but\s+)(?:it'?s\s+|it is\s+|it was\s+|it should be\s+)?(?<to>.+)$/i,
      // "change Y to X", "replace Y with X", "swap Y for X"
      /^(?:please\s+)?(?:change|replace|swap|switch|update|correct|fix|make)\s+(?<from>.+?)\s+(?:to|with|for|into|->|→)\s+(?<to>.+)$/i,
      // "Y should be X"
      /^(?<from>.+?)\s+should (?:be|say|read)\s+(?<to>.+)$/i,
      // "X, not Y"
      /^(?<to>[^,]+?),\s*not\s+(?<from>[^,]+)$/i,
    ];
    for (const re of pats) {
      const m = re.exec(t);
      if (!m || !m.groups) continue;
      const from = clean(m.groups.from), to = clean(m.groups.to);
      if (!from || !to || from.length > 80 || to.length > 80 || from.toLowerCase() === to.toLowerCase() || VAGUE.test(from) || VAGUE.test(to)) continue;
      return { from, to };
    }
    return null;
  }
  function confirmationReply(text) {
    const raw = String(text == null ? "" : text);
    const t = raw.normalize("NFKC").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(t)) return { kind: "unclear", why: t ? "no words (an emoji or punctuation only)" : "empty" };
    const q = /\?/.test(t);
    const bare = t.replace(/[.!]+$/, "").trim();
    if (!q) {
      const corr = correctionOf(raw);
      if (corr) return { kind: "correction", from: corr.from, to: corr.to };
    }
    if (!q && !HEDGE.test(bare) && YES_RE.test(bare)) return { kind: "yes" };
    if (!q && NO_RE.test(bare)) return { kind: "no" };
    const n = bare.split(/\s+/).length;
    // A question or a hedge about the entries ("correct?", "is the GPA right?", "yeah maybe") is a reply that confirms
    // nothing; a question about something else ("how long does it take?") is not a reply at all.
    if (TASK.test(bare) && !/\b(?:resume|cv|entr(?:y|ies)|title|gpa|school|dates?)\b/.test(bare)) return { kind: "other" };
    if ((HEDGE.test(bare) || REPLYISH.test(bare)) && n <= 12) return { kind: "unclear", why: q ? "a question" : HEDGE.test(bare) ? "a hedge" : "not a plain yes" };
    return { kind: "other" };
  }

  // ---- profile data lifecycle: retention declaration + real deletion (SHD-3) ----
  // The export surface (130.profileExport) offers "delete my stored profile"; these
  // functions make that offer true at module level: an exact preview, a deletion
  // that removes everything this module owns, a receipt listing what was removed,
  // and the retention declaration the export surface can quote verbatim.
  const RETENTION_DECLARATION = {
    module: "122-career-profile",
    scope: "the career master profile held by the caller — this module is pure and writes nothing to disk, network, backups, or any processor itself",
    keeps: [
      { data: "profile facts (experience, projects, skills, education and the rest, drafts included)", where: "the in-memory profile object held by the caller/host store", retention: "kept until deleteProfileData(profile) is called or the caller discards the profile object; no time-based expiry is applied by this module" },
      { data: "profile sections (basics, preferences, constraints, defaults)", where: "the same profile object", retention: "kept until deleteProfileData(profile) is called or the caller discards the profile object" },
      { data: "imported connections (e.g. LinkedIn export rows)", where: "the same profile object (profile.connections)", retention: "kept until deleteProfileData(profile) is called or the caller discards the profile object" },
      { data: "derived records stored on the profile (ingest audit, corrections, resume-source record, dependent state)", where: "the same profile object", retention: "kept with the profile and removed by deleteProfileData(profile) together with the facts they describe" },
    ],
    backups: "none — this module creates no backups and keeps no copy after deletion",
    processors: "none — this module sends profile data to no outside processor",
    deletion: { function: "deleteProfileData(profile)", preview_function: "previewProfileDeletion(profile)", receipt: "the deletion returns a receipt listing every removed fact ID, the connection count, the sections cleared, and the derived records removed; nothing is deleted by the preview" },
    text: "Your career profile (facts, basics, preferences, constraints, imported connections, and the records derived from them) is kept in your profile record until you delete it — this module makes no backups and sends it to no outside processor. Deleting removes all of it and returns a receipt listing exactly what was removed; a preview first shows exactly what would be removed before anything is deleted.",
  };
  function retentionDeclaration() { return JSON.parse(JSON.stringify(RETENTION_DECLARATION)); }
  const DERIVED_KEYS = ["profile_corrections", "resume_sources", "dependent_state", "profile_ingest_audit"];
  function deletionReceipt(profile, deleted, opts) {
    const p = profile || {};
    return {
      deleted: !!deleted,
      profile_id: p.id || null,
      at: (opts && opts.now) || null,
      removed: {
        fact_ids: (p.facts || []).map((f) => f.id),
        fact_count: (p.facts || []).length,
        facts: (p.facts || []).map((f) => ({ id: f.id, kind: f.kind, title: f.title || f.name || "" })),
        connection_count: (p.connections || []).length,
        connections: (p.connections || []).map((c) => c.name || null),
        sections_cleared: ["basics", "preferences", "constraints", "defaults"],
        derived_records: DERIVED_KEYS.filter((k) => p[k] !== undefined),
      },
      removed_counts: { facts: (p.facts || []).length, connections: (p.connections || []).length, derived_records: DERIVED_KEYS.filter((k) => p[k] !== undefined).length },
      remaining: deleted ? { fact_count: 0, connection_count: 0 } : { fact_count: (p.facts || []).length, connection_count: (p.connections || []).length },
    };
  }
  function previewProfileDeletion(profile) { return deletionReceipt(profile, false); }
  function deleteProfileData(profile, opts) {
    if (!profile) return { deleted: false, profile_id: null, at: (opts && opts.now) || null, removed: { fact_ids: [], fact_count: 0, facts: [], connection_count: 0, connections: [], sections_cleared: [], derived_records: [] }, removed_counts: { facts: 0, connections: 0, derived_records: 0 }, remaining: { fact_count: 0, connection_count: 0 } };
    const receipt = deletionReceipt(profile, true, opts);
    const fresh = createProfile({ id: profile.id });
    profile.basics = fresh.basics; profile.preferences = fresh.preferences;
    profile.constraints = fresh.constraints; profile.defaults = fresh.defaults;
    profile.facts = []; profile.connections = [];
    profile.label = null; profile.isTestFixture = false; profile._seq = 0;
    for (const k of DERIVED_KEYS) delete profile[k];
    return receipt;
  }

  return { KINDS, createProfile, profileFromData, addFact, updateFact, getFact, listFacts, confirmFact, confirmedFacts, quarantinedFact, QUARANTINE_VERSION, unprovenSkills, skillEvidence, factMiningQuestions, isThin, parseCsv, parseLinkedInConnections, parseLinkedInProfile, ingestLinkedIn, parseResumeText, parseResumeSections, ingestResume, supersedeResume, confirmationReply, classifyResumeIngest, SUPPORTED_RESUME_FORMATS, refreshSkillFlags, RETENTION_DECLARATION, retentionDeclaration, previewProfileDeletion, deleteProfileData };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerProfile;
