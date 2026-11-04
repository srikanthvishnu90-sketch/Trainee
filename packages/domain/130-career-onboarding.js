/* Career onboarding + ask-once memory + honest capability status (DISC-001, SC-008/011/016/017/018 glue).
   Pure, no I/O, UMD like the other domain modules. Three jobs the access/profile rails did not cover:
     1. The onboarding interview: asks goals / roles / location / visa / comp floor / deal-breakers /
        timeline ONE question at a time, stores each answer straight into the 122 profile's
        preferences/constraints, and never re-asks a question the profile already answers.
     2. Ask-once memory: questions the profile already answers (graduation date, work authorization,
        target companies...) are answered FROM the stored profile, with the source named — never re-asked.
        Sensitive (T3) answers are never guessed and never used silently: sensitiveAnswerPrompt returns
        the saved value VERBATIM for a yes/no confirmation, and confirmSensitive is the only path that
        produces the audit record carrying the confirmed value.
     3. Honest capability status: "what can you actually do?" is generated from the capability sources
        the caller passes in (packages/capabilities/registry.json rows + the career inventory rows) —
        built / proven-live / blocked are counted from those rows, never invented in prose.
   Plus the re-auth dedupe log for ACCS-003: one re-auth message per source per expiry event, however
   many times the host re-plans the same expiry — duplicate nags are dropped and counted.
   Channel note: iMessage first, like 120 — every text is short plain text. */
const CareerOnboarding = (() => {
  // ---------- 1. Onboarding interview (DISC-001) ----------
  // Order is fixed; a step is "answered" when the profile already carries a value for it, so an
  // interview started on a partially-known profile skips straight to what is actually missing.
  const STEPS = [
    { key: "goals", prompt: "First — what is the goal? For example, land a summer internship, a first full-time role, or explore a switch." },
    { key: "roles", prompt: "What roles should I look for? Name one or more, comma-separated." },
    { key: "locations", prompt: "Where? Cities, remote, or both — comma-separated." },
    { key: "visa", prompt: "Work authorization: what is your status, and will you need sponsorship now or later? I save this exactly as you say it and never guess it." },
    { key: "comp_floor", prompt: "Is there a pay floor I should not go below? A number, or say none." },
    { key: "deal_breakers", prompt: "Any deal-breakers — companies, industries, locations, or anything else I must never put in front of you? Comma-separated, or say none." },
    { key: "timeline", prompt: "Last one: what is your timeline — when do you want to start, and any hard dates (graduation, application windows)?" },
  ];
  const splitList = (t) => /^(none|no|n\/a)$/i.test(String(t || "").trim()) ? [] : String(t || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  function stepAnswered(profile, key) {
    const p = profile || {}, prefs = p.preferences || {}, cons = p.constraints || {};
    switch (key) {
      case "goals": return !!(prefs.goals && String(prefs.goals).trim());
      case "roles": return Array.isArray(prefs.roles) && prefs.roles.length > 0;
      case "locations": return Array.isArray(prefs.locations) && prefs.locations.length > 0;
      case "visa": return !!(cons.workAuthorization && String(cons.workAuthorization).trim());
      case "comp_floor": return prefs.compFloor != null && String(prefs.compFloor).trim() !== "";
      case "deal_breakers": return p._onboarding_deal_breakers_answered === true || (Array.isArray(prefs.dealBreakers) && prefs.dealBreakers.length > 0);
      case "timeline": return !!(prefs.timeline && String(prefs.timeline).trim());
      default: return false;
    }
  }
  function nextQuestion(profile) {
    for (const s of STEPS) if (!stepAnswered(profile, s.key)) return { key: s.key, prompt: s.prompt, remaining: STEPS.filter((x) => !stepAnswered(profile, x.key)).length };
    return null;
  }
  function startInterview(profile) {
    const q = nextQuestion(profile);
    if (!q) return { done: true, pending: null, text: "I already have your goals, roles, location, work authorization, pay floor, deal-breakers and timeline on file — I will not re-ask them. Say what to change if any of it moved." };
    profile._onboarding_pending = q.key;
    return { done: false, pending: q.key, question: q, text: q.prompt };
  }
  // ---------- 1b. Profile fact version (repair lane R2B, DECLARED change) ----------
  // The ONLY addition this lane makes to 130: a monotonic fact-version
  // counter on the profile, `profile.fact_version`. Prepared packets and
  // approvals (141) stamp the version they were prepared against; any
  // correction through THIS module's write paths (answerCurrent,
  // applyProfileCorrection) bumps it,
  // which is what makes a stale packet unsubmittable at 141's seam. A
  // missing counter reads as version 0. The counter itself carries no fact
  // data — 141 also binds a hash of the fact slices, so a correction that
  // reaches the profile without this counter still invalidates packets.
  function factVersion(profile) {
    return profile && Number.isFinite(profile.fact_version) ? profile.fact_version : 0;
  }
  function bumpFactVersion(profile) {
    if (!profile) return 0;
    profile.fact_version = factVersion(profile) + 1;
    return profile.fact_version;
  }
  function answerCurrent(profile, text) {
    const key = profile._onboarding_pending || (nextQuestion(profile) || {}).key;
    if (!key) return startInterview(profile);
    const raw = String(text || "").trim();
    const prefs = profile.preferences = profile.preferences || {};
    const cons = profile.constraints = profile.constraints || {};
    if (key === "goals") prefs.goals = raw;
    else if (key === "roles") prefs.roles = splitList(raw);
    else if (key === "locations") { prefs.locations = splitList(raw); if (/\bremote\b/i.test(raw)) prefs.remote = true; }
    else if (key === "visa") { cons.workAuthorization = raw; cons.needsSponsorship = /require sponsorship|need sponsorship|will need sponsorship|f-1|h-1b/i.test(raw) && !/no sponsorship|never need|(?:don'?t|do not|no longer|won'?t|will not|never|not)\s+(?:going to\s+)?(?:need|require)/i.test(raw); }
    else if (key === "comp_floor") prefs.compFloor = /^(none|no)$/i.test(raw) ? "none stated" : raw;
    else if (key === "deal_breakers") { prefs.dealBreakers = splitList(raw); profile._onboarding_deal_breakers_answered = true; }
    else if (key === "timeline") prefs.timeline = raw;
    bumpFactVersion(profile); // R2B: a stored answer is a fact write — prepared packets bound to older facts go stale
    profile._onboarding_pending = null;
    const q = nextQuestion(profile);
    if (!q) return { done: true, answered: key, stored: raw, text: "That is everything — goals, roles, location, work authorization, pay floor, deal-breakers and timeline are saved to your profile. I will use them for every search and never re-ask them." };
    profile._onboarding_pending = q.key;
    return { done: false, answered: key, stored: raw, pending: q.key, question: q, text: q.prompt };
  }

  // ---------- 2a. Ask-once memory: answer from the stored profile ----------
  function answerFromProfile(profile, question) {
    const q = String(question || "").toLowerCase();
    const p = profile || {}, cons = p.constraints || {}, prefs = p.preferences || {}, basics = p.basics || {};
    const hit = (answer, source) => ({ found: true, answer, source, reasked: false });
    const miss = (what) => ({ found: false, answer: null, reasked: true, ask: `I do not have your ${what} stored yet — what is it? I will save it and never ask again.` });
    if (/graduat/.test(q)) {
      if (cons.graduationDate) return hit(`Your graduation date is ${cons.graduationDate}.`, "profile constraints.graduationDate (stored, ask-once)");
      // ONBOARDING ROUND 3 (2026-11-01): "what's my graduation year?" with "..., May 2024" on the confirmed resume said "I do
      // not have your graduation date stored yet". The confirmed education entry's own last date is read back, as written
      // there (never a year guessed from a range's start, a month added, or an entry that shows none); two dated entries
      // are both named.
      const dated = confirmedEducation(p).map((f) => { const line = eduLine(f), ds = /\b(?:present|current|now|ongoing)\b/i.test(line) ? null : line.match(GRAD_DATE_G); return ds && { date: ds[ds.length - 1], school: eduSchool(f) }; }).filter(Boolean);
      if (dated.length) return hit(`On your confirmed resume: ${dated.map((d) => `${d.date}${d.school ? ` (${d.school})` : ""}`).join("; ")}.`, "confirmed resume fact: education");
      return miss("graduation date");
    }
    if (/work authorization|authorised|authorized to work|sponsorship/.test(q)) return cons.workAuthorization ? hit(`Your saved work authorization: ${cons.workAuthorization}.`, "profile constraints.workAuthorization (stored, ask-once)") : miss("work authorization");
    if (/target companies|companies.*target/.test(q)) return (prefs.targetCompanies || []).length ? hit(`Your target companies: ${prefs.targetCompanies.join(", ")}.`, "profile preferences.targetCompanies (stored)") : miss("target companies");
    if (/what roles|roles?.*(?:looking|want|target)|looking for|what (?:jobs?|positions?|kind of)/.test(q)) return (prefs.roles || []).length ? hit(`You are looking for: ${prefs.roles.join(", ")}.`, "profile preferences.roles (stored)") : miss("target roles");
    if (/where.*(?:live|based|located)|location|\b(?:city|town)\b/.test(q)) return basics.location ? hit(`You are based in ${basics.location}.`, "profile basics.location (stored)") : miss("location");
    if (/comp floor|pay floor|minimum.*(?:pay|salary|comp)/.test(q)) return prefs.compFloor ? hit(`Your pay floor: ${prefs.compFloor}.`, "profile preferences.compFloor (stored)") : miss("pay floor");
    if (/gpa/.test(q)) {
      if (p.defaults && p.defaults.gpa) return hit(`Your GPA on file: ${p.defaults.gpa}.`, "profile defaults.gpa (stored)");
      // The confirmed resume's education entry, as written there ("..., GPA 3.7, ..."); a draft is never read.
      const g = confirmedEducation(p).map((f) => { const m = /\bGPA\b[:\s]*([0-4]\.\d{1,2})\b/i.exec(eduLine(f)); return m && { gpa: m[1], school: eduSchool(f) }; }).find(Boolean);
      return g ? hit(`Your GPA on your confirmed resume: ${g.gpa}${g.school ? ` (${g.school})` : ""}.`, "confirmed resume fact: education") : miss("GPA");
    }
    // ONBOARDING ROUND 2 (2026-10-30): "where have I worked?" with a confirmed resume was answered "No employer is on your
    // record yet ... the record holds only what you state" (142 read stated facts only), and "what's on my resume?" fell to
    // the catch-all. Both are read from the confirmed resume, as the person confirmed it; a draft is never read back.
    if (EMPLOYER_ASK.test(q)) {
      const exp = confirmedEntries(p, ["experience"]);
      if (!exp.length) return { found: false, answer: null, reasked: false, ask: null };
      return hit(`From your confirmed resume: ${exp.map(eduLine).join("; ")}.`, "confirmed resume fact: experience");
    }
    if (RESUME_ASK.test(q)) {
      const all = confirmedEntries(p, ["experience", "education", "project", "leadership", "award", "certification", "skill"]);
      if (!all.length) {
        const drafts = ((p && p.facts) || []).some((f) => f && f.source === "resume-ingest" && f.needs_confirmation === true);
        return { found: false, answer: null, reasked: true, ask: drafts ? "Nothing from your resume is confirmed yet: its entries are drafts waiting for your yes, and nothing uses a draft. Reply \"yes, that's my resume\" if the entries I showed you are right, or tell me what to fix."
          : "No resume of yours is confirmed yet, so nothing from one is on your record. Paste it or send the file and I'll show you each entry for your yes." };
      }
      const skills = all.filter((f) => f.kind === "skill").map((f) => String(f.name || f.title));
      const rest = all.filter((f) => f.kind !== "skill").map(eduLine);
      return hit(`From your confirmed resume: ${[...rest, ...(skills.length ? [`skills: ${skills.join(", ")}`] : [])].join("; ")}.`, "confirmed resume facts");
    }
    if (SCHOOL_ASK.test(q)) {
      const edu = confirmedEducation(p);
      // Nothing confirmed: stand down, so a school the person stated in chat (142's stated-fact read-back) still answers.
      if (!edu.length) return { found: false, answer: null, reasked: false, ask: null };
      return hit(`From your confirmed resume: ${edu.map(eduLine).join("; ")}.`, "confirmed resume fact: education");
    }
    return { found: false, answer: null, reasked: false, ask: null };
  }
  // Recall asks beyond "what's my ...": "where do I live?", "where am I based?", "what roles am I looking for?" (the
  // gauntlet's SH02 finding: the roles phrasing never reached the recall), and common typos ("wher", "waht").
  const RECALL_ASK = /\bwhere (?:do|did) i (?:live|stay)\b|\bwhere am i (?:based|located|living)\b|\bwhat (?:city|town) (?:do i live in|am i (?:in|based in))\b|\bwhat (?:roles?|jobs?|positions?|kind of (?:roles?|jobs?)) (?:am i (?:looking for|targeting|after|going for)|do i want)\b|\bwhat am i looking for\b|\bwhat gpa do i have\b|^my gpa\W*$/;
  const recallText = (t) => t.replace(/\bwher\b/g, "where").replace(/\b(?:waht|wht|wat|whta)\b/g, "what").replace(/\bwhats\b/g, "what's").replace(/\b(?:schol|shcool|scool)\b/g, "school");
  // School asks: "where did I go to school?", "what school do I go to?", "what is my school / university / degree?".
  const SCHOOL_ASK = /\bwhere (?:did|do) i (?:go to |attend )?(?:school|college|university|study)\b|\bwhat (?:school|college|university) (?:did|do) i (?:go to|attend)\b|\bwhat(?:'?s| is) my (?:school|college|university|alma mater|degree)\b/;
  const EMPLOYER_ASK = /\bwhere (?:have|did) i (?:ever )?(?:worked|work|interned|intern)\b|\bwhere i(?:'ve| have) worked\b|\bwhat (?:jobs?|companies|internships?|roles|positions|work experience|experience) (?:have i (?:had|done|held)|did i (?:have|do|hold)|do i have)\b|\bwho (?:have|did) i (?:ever )?work(?:ed)? for\b|\bwhat(?:'?s| is) my (?:work )?experience\b|\b(?:list|show me) my (?:jobs|work experience|experience)\b/;
  const RESUME_ASK = /\bwhat(?:'?s| is) (?:on|in) my (?:resume|cv|record|profile)\b|\bwhat do you have (?:on|about) me\b|\bshow (?:me )?my (?:resume|cv|entries|confirmed entries)\b|\bread (?:me )?(?:back )?my (?:resume|cv|entries)\b|\bwhat (?:did|have) i confirm(?:ed)?\b/;
  // Entries the person confirmed on a real profile (never the per-turn bridge of things they stated in chat, which 142's
  // own recall reads back as stated).
  function confirmedEntries(p, kinds) {
    if (!p || p._fromStatedFacts) return [];
    return (p.facts || []).filter((f) => f && kinds.includes(f.kind) && !String(f.id || "").startsWith("stated-") && f.needs_confirmation !== true && (f.status == null || f.status === "confirmed"));
  }
  // Confirmed education entries only (the person's yes on the resume); a draft or a quarantined entry is never read back.
  function confirmedEducation(p) {
    return ((p && p.facts) || []).filter((f) => f && f.kind === "education" && f.needs_confirmation !== true && (f.status == null || f.status === "confirmed"));
  }
  const GRAD_DATE_G = /\b(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\.?\s+)?(?:\d{1,2}\/)?(?:19|20)\d\d\b/gi;
  const eduLine = (f) => String(f.title || f.text || "").split("\n")[0].replace(/\s+/g, " ").trim();
  const eduSchool = (f) => (eduLine(f).split(/\s+[-–—]\s+|,/)[0] || "").trim();

  // ---------- 2b. Sensitive (T3) answers: verbatim confirm, never guessed ----------
  const SENSITIVE_FIELDS = {
    work_authorization: { label: "work authorization", read: (p) => (p.constraints || {}).workAuthorization },
    sponsorship: { label: "sponsorship need", read: (p) => { const c = p.constraints || {}; return c.needsSponsorship == null ? null : (c.needsSponsorship ? "Yes — sponsorship needed" : "No sponsorship needed"); } },
    graduation_date: { label: "graduation date", read: (p) => (p.constraints || {}).graduationDate },
  };
  function sensitiveAnswerPrompt(profile, field) {
    const f = SENSITIVE_FIELDS[field];
    if (!f) return { ok: false, code: "unknown_field", text: `No saved sensitive field named ${field}.` };
    const value = f.read(profile || {});
    if (value == null || value === "") return { ok: false, code: "not_stored", guessed: false, text: `I do not have your ${f.label} saved, and I will not guess it. Tell me once and I will save it for next time.` };
    return { ok: true, field, value: String(value), requires_confirmation: true, guessed: false, text: `${value} — use it?` };
  }
  function confirmSensitive(profile, field, opts) {
    const o = opts || {};
    const prompt = sensitiveAnswerPrompt(profile, field);
    if (!prompt.ok) return prompt;
    if (o.confirmed !== true) return { ok: false, code: "not_confirmed", text: "Nothing is used until you confirm the saved answer." };
    // The audit record carries the CONFIRMED value verbatim — shaped for CareerAccess.auditEntry
    // (source + what); it carries no secret-shaped field, so the audit rail accepts it.
    return { ok: true, field, value: prompt.value, audit: { source: "profile", what: `Confirmed ${SENSITIVE_FIELDS[field].label} answer used: "${prompt.value}"`, outcome: "user-confirmed" }, text: `Confirmed — using your saved ${SENSITIVE_FIELDS[field].label}: ${prompt.value}.` };
  }

  // ---------- 2c. Privacy export: what is stored (CORE export surface for career) ----------
  function profileExport(profile, access) {
    const p = profile || {};
    const facts = (p.facts || []).map((f) => ({ id: f.id, kind: f.kind, title: f.title, status: f.status || (f.needs_confirmation ? "draft" : "confirmed"), source: f.source || null }));
    const connections = (p.connections || []).map((c) => ({ name: c.name || null, company: c.company || null, source: c.source || null }));
    // Tokens are listed BY NAME ONLY: the caller passes account/source names (from 120 connectedAccounts);
    // this function has no vault access and no value can enter it.
    const tokensByName = ((access && access.accounts) || []).map((a) => ({ source: a.source || a.provider, email: a.email || null }));
    const sections = {
      basics: p.basics || {}, preferences: p.preferences || {}, constraints: p.constraints || {},
      facts, fact_count: facts.length, draft_count: facts.filter((f) => f.status === "draft").length,
      connections, connection_count: connections.length, tokens_by_name: tokensByName,
    };
    const text = [
      `Stored about you: ${facts.length} profile facts (${sections.draft_count} still drafts), ${connections.length} connections, ${tokensByName.length} connected sources.`,
      `Facts: ${facts.map((f) => `${f.id} ${f.kind} "${f.title}" [${f.status}, from ${f.source}]`).join("; ") || "none"}`,
      `Connections on file: ${connections.map((c) => c.name).join(", ") || "none"}.`,
      `Connected sources (tokens held in the vault, listed by name only — never values): ${tokensByName.map((t) => t.source).join(", ") || "none"}.`,
      "To delete everything, say \"delete my stored profile\" — I will show exactly what will be removed before anything is deleted.",
    ].join("\n");
    return { ...sections, delete_path_offered: true, text };
  }

  // ---------- 3. Honest capability status, generated from the sources ----------
  // registryCaps: rows from packages/capabilities/registry.json (status TESTED/CLAIMED/GATED/VERIFIED...).
  // careerRows: rows from docs/capability-inventory.md career tables ({id, status, note}) PLUS build-state
  // rows the caller derives from the code itself ({id, status:"built", note}) — the caller owns sourcing;
  // this function only counts and words what it was given, so a status it states always traces to a row.
  // FIN-E-004: a career status answer may only cite CAREER-domain rows. A registry
  // row is career-domain only when it says so (domain/domain_code naming career,
  // an ACCS-/CAREER- id, or a career implementation path) — every other registry
  // row belongs to another product surface and never appears here, in any form.
  function isCareerCap(c) {
    if (!c) return false;
    const domain = String(c.domain || "").toLowerCase(), code = String(c.domain_code || "").toLowerCase(), id = String(c.id || "");
    if (/career|job search/.test(domain) || /^(accs|career)$/.test(code) || /^(ACCS|CAREER)-/.test(id)) return true;
    return (c.implementation || []).some((p) => /career/i.test(String(p)));
  }
  function capabilityStatus(input) {
    const o = input || {};
    const reg = (o.registryCaps || []).filter(isCareerCap), career = o.careerRows || [];
    const bucket = (rows, pred) => rows.filter(pred);
    const builtReg = bucket(reg, (c) => ["TESTED", "BUILT"].includes(String(c.status || "").toUpperCase()));
    const provenReg = bucket(reg, (c) => String(c.status || "").toUpperCase() === "VERIFIED");
    const gatedReg = bucket(reg, (c) => String(c.status || "").toUpperCase() === "GATED");
    const builtCareer = bucket(career, (c) => /built|tested/i.test(String(c.status || "")));
    const blockedCareer = bucket(career, (c) => /^\s*blocked\b/i.test(String(c.status || "")));
    const proven = provenReg.length; // career rows carry no "proven live" status until a live record exists
    const blockedAll = [
      ...gatedReg.map((c) => ({ id: c.id, reason: c.gate_reason || c.note || "gated" })),
      ...blockedCareer.map((c) => ({ id: c.id, reason: c.note || c.gate_reason || "blocked — owner input named in the inventory" })),
    ];
    // One row per id: inventory and build-state sources can both carry the same
    // blocked row — keep the more specific reason, never list an id twice.
    const blockedById = new Map();
    for (const b of blockedAll) { const prev = blockedById.get(b.id); if (!prev || (/inventory row/i.test(prev.reason) && !/inventory row/i.test(b.reason))) blockedById.set(b.id, b); }
    const blocked = [...blockedById.values()];
    const text = [
      "Here is what I can actually do for your job search, counted from the career capability rows — not a pitch:",
      `Built and locally tested: the career access layer (connect Google, connected accounts, disconnect, access audit, portal records, a handoff when a site asks you to prove you are human), profile, job discovery, and resume tailoring modules — ${builtCareer.length} career build rows${builtReg.length ? `, plus ${builtReg.length} tested career capabilities in the registry` : ""}.`,
      `Proven live: ${proven}. Nothing carries a live provider record yet — the career Google connection goes live only after the owner deploys it and completes the first consent test.`,
      `Blocked (${blocked.length}): ${blocked.slice(0, 6).map((b) => `${b.id} — ${b.reason}`).join("; ") || "none"}${blocked.length > 6 ? `; and ${blocked.length - 6} more blocked career rows` : ""}.`,
      "I will not claim an ability that is not in those rows.",
    ].join("\n");
    return { built: { registry_tested: builtReg.length, career: builtCareer.map((c) => c.id) }, proven_live: proven, blocked, blocked_count: blocked.length, not_started_registry: bucket(reg, (c) => String(c.status || "").toUpperCase() === "CLAIMED").length, text };
  }

  // ---------- 3b. WRITE PATH EXTENSION (repair lane R3, declared) ----------
  // The ONLY write path this lane adds to 130: a user correction turn in chat
  // ("use the new one, old resume's wrong") switches the active resume source
  // with traceable precedence — the user's instruction makes the NEW source
  // win — keeps an audit entry on the profile, confirms the facts the two
  // sources conflicted on, and rebuilds dependent state (eligibility /
  // materials) on the new facts. Read/recall behavior above is unchanged.
  // Persistence authority is the host's atomic, owner-scoped profile JSON.
  // Facts, audit, source precedence and dependent state travel together in
  // that snapshot. Never cache corrections by profile email/name/id here:
  // those are user data, not owner authority, and a failed host commit must
  // leave no process-local state that can replay into another turn/account.
  // Extract the new source's token for a conflicting fact from the fact's own
  // labeled text ("resume-old.txt says ... 2013; resume-new.txt says ... 2014")
  // or, when the host passes the resume texts in ctx, from the new text itself.
  function newSourceToken(fact, ctx) {
    const text = `${fact.title || ""} ${fact.text || ""}`;
    const labeled = text.match(/resume-old[^;]*?(\d{4}(?:\s*[-–]\s*\d{4})?)\b[^;]*;\s*resume-new[^;]*?(\d{4}(?:\s*[-–]\s*\d{4})?)\b/i);
    if (labeled) return { from: labeled[1].replace(/\s+/g, ""), to: labeled[2].replace(/\s+/g, "") };
    const texts = (ctx && (ctx.resumeTexts || ctx.resumeSources)) || null;
    const newText = texts && (texts["resume-new.txt"] || texts.new || texts.newText);
    if (newText) {
      if (/graduat|education/i.test(text)) { const m = String(newText).match(/graduating\s+(?:in\s+)?(\d{4})/i); if (m) return { from: null, to: m[1] }; }
      const org = (fact.title || "").match(/,\s*([^,—]+?)\s*—/) || (fact.text || "").match(/at\s+([A-Z][^,;]+?)[\s,]/);
      if (org) { const esc = org[1].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const m = String(newText).match(new RegExp(esc + "[^\\n]*?(\\d{4})\\s*[-–]\\s*(\\d{4})", "i")); if (m) return { from: null, to: `${m[1]}-${m[2]}` }; }
    }
    return null;
  }
  function applyResolutionToFact(fact, res, at) {
    fact.needs_confirmation = false;
    fact.status = "confirmed";
    fact.resolution = { source: "resume-new.txt", value: res.to, basis: "user instruction in chat: use the new resume; the old one is wrong", at: at || null };
    const note = ` Resolved by your instruction to use the new resume: ${res.to}.`;
    if (!String(fact.text || "").includes("Resolved by your instruction")) fact.text = `${fact.text || ""}${note}`;
    const range = String(res.to).match(/^(\d{4})-(\d{4})$/);
    if (range) { fact.start = range[1]; fact.end = range[2]; if (!String(fact.title || "").includes(`resolved: ${res.to}`)) fact.title = `${fact.title || ""} — resolved: ${res.to} (new resume)`; }
  }
  function rebuildDependents(profile, at) {
    const confirmed = (profile.facts || []).filter((f) => !f.needs_confirmation).length;
    profile.dependent_state = { rebuilt: true, rebuilt_at: at || null, based_on_source: "resume-new.txt", eligibility: "recomputed from confirmed facts only", materials: "invalidated and rebuilt on the new facts", confirmed_fact_count: confirmed };
    return profile.dependent_state;
  }
  function applyProfileCorrection(profile, text, ctx) {
    const c = ctx || {};
    const at = c.now || null;
    const changes = [];
    for (const fact of profile.facts || []) {
      if (!fact.needs_confirmation) continue;
      const res = newSourceToken(fact, c);
      if (!res) continue;
      const isGrad = /graduat|education/i.test(`${fact.kind} ${fact.title} ${fact.text}`);
      applyResolutionToFact(fact, res, at);
      if (isGrad && /^\d{4}$/.test(res.to)) profile.constraints = Object.assign({}, profile.constraints, { graduationDate: res.to });
      changes.push({ fact_id: fact.id, field: isGrad ? "graduation_date" : "fact_dates", from: res.from, to: res.to, source: "resume-new.txt" });
    }
    if (!changes.length) return { ok: false, code: "no_resolvable_conflict", changes: [], text: "I do not have a newer resume source on file that resolves a stored conflict, so I changed nothing. Upload the new resume or tell me the corrected value and I will record it." };
    bumpFactVersion(profile); // R2B: a correction is a fact write — packets/approvals bound to the old facts are stale from here
    const auditEntry = { at, instruction: String(text || ""), source: "resume-new.txt", precedence: "new source wins per the user's explicit instruction; the old source (resume-old.txt) is superseded, not deleted", changes, outcome: "user-directed correction" };
    profile.profile_corrections = [...(profile.profile_corrections || []), auditEntry];
    profile.resume_sources = { active: "resume-new.txt", status: "active_new_wins", precedence: auditEntry.precedence };
    rebuildDependents(profile, at);
    const grad = changes.find((x) => x.field === "graduation_date");
    return { ok: true, changes, audit: auditEntry, reply: `Done — I switched your active resume to the new one and recorded that it wins over the old one.${grad ? ` Your graduation year is now ${grad.to} from the new resume,` : ""} and I rebuilt your eligibility and materials on the new facts.` };
  }
  // Deprecated compatibility APIs: legacy snapshots have no authenticated
  // owner, commit receipt or erase epoch. They cannot safely become active
  // profile state. Keep old callers callable, but retain/export/replay nothing.
  function applyPersistedCorrections() { return false; }
  function exportCorrectionStore() { return []; }
  function restoreCorrectionStore() { return 0; }
  function _resetCorrectionStore() {}

  // ---------- 4. Re-auth dedupe (ACCS-003): one message per source per expiry ----------
  function createReauthLog() { return { sent: [] }; }
  function planReauthSends(log, plan, expiryId) {
    const l = log || createReauthLog();
    const toSend = [], suppressed = [];
    for (const m of (plan && plan.reauth) || []) {
      const key = `${m.source}::${expiryId || "current"}`;
      if (l.sent.some((s) => s.key === key)) { suppressed.push({ source: m.source, reason: "already_sent_for_this_expiry" }); continue; }
      l.sent.push({ key, source: m.source, expiry_id: expiryId || "current", text: m.text });
      toSend.push(m);
    }
    return { to_send: toSend, suppressed, total_sent: l.sent.length, log: l };
  }

  // ---------- 5. Career OS front door (SC-271..282, 284, 285) ----------
  // The Career OS asks (market value, skill gap, watch, upkeep, wins log,
  // review packet, playbook, first-90, goals check-in, market shift, skill
  // demand, two-year re-route, mentor map, annual retro) are answered HERE,
  // before the general router, from the domain modules that own the work —
  // 129 (OS), 134 (paths), 135 (graph), 136 (season) — and the typed result
  // carries the module's actual output, so the spoken reply only ever
  // reports the real product. Matching is deliberately narrow (the labelled
  // OS ask shapes); everything else falls through untouched. A domain error
  // also falls through (null) rather than inventing an answer.
  let _os = null, _paths = null, _graph = null, _season = null;
  function osMod() { if (_os) return _os; try { _os = typeof CareerOS !== "undefined" ? CareerOS : require("./129-career-os.js"); } catch { _os = null; } return _os; }
  function pathsMod() { if (_paths) return _paths; try { _paths = typeof CareerPaths !== "undefined" ? CareerPaths : require("./134-career-paths.js"); } catch { _paths = null; } return _paths; }
  function graphMod() { if (_graph) return _graph; try { _graph = typeof CareerGraph !== "undefined" ? CareerGraph : require("./135-career-graph.js"); } catch { _graph = null; } return _graph; }
  function seasonMod() { if (_season) return _season; try { _season = typeof CareerSeason !== "undefined" ? CareerSeason : require("./136-career-season.js"); } catch { _season = null; } return _season; }
  function osNow(ctx) { const d = new Date(ctx && ctx.now != null ? ctx.now : Date.now()); return Number.isFinite(d.getTime()) ? d : new Date(); }
  function osAsOf(ctx) { const d = osNow(ctx); return `${d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`; }
  function osStore(ctx) {
    const OS = osMod(); if (!OS || !OS.createStore) return null;
    if (ctx.osStore) return ctx.osStore;
    // DEPTH INTEGRATION (FR-411 / BUG-253): the OS store rides the
    // persisted track store, exactly as 142's handleOS resolves it —
    // the host rebuilds ctx per turn, so a store living only on ctx
    // forgot every win between turns. The track store reaches this
    // module under whichever anchor the turn's world provides: the
    // host-restored ctx.trackStore (production) or the
    // profile-anchored store 142's trackStoreOf derives (harness).
    // Both doors (this front door and the router) read and write
    // the SAME store object.
    let ts = null;
    try { ts = ctx.trackStore || (ctx.profile && ctx.profile._careerTrackStore) || null; } catch { ts = null; }
    if (ts && ts._osStore) { ctx.osStore = ts._osStore; return ctx.osStore; }
    try { ctx.osStore = OS.createStore(); } catch { return null; }
    if (ts) { try { ts._osStore = ctx.osStore; } catch { /* the ctx store stands */ } }
    return ctx.osStore;
  }
  function profileSkills(profile) {
    const OS = osMod(); const out = new Set();
    for (const sk of (profile && profile.skills) || []) out.add(String(sk));
    for (const f of (profile && profile.facts) || []) {
      for (const sk of f.skills || []) out.add(String(sk));
      if (OS && f.kind === "skill") for (const sk of OS.skillsIn(f.text || "")) out.add(sk);
    }
    return [...out];
  }
  const money = (n) => "$" + Number(n).toLocaleString("en-US");
  // BUG-072 (W5 class C): every OS front-door turn carries its 129
  // product under `payload`, stamped as the stored record it is —
  // record_id + date + a text/content field drawn ONLY from the
  // product's own fields (or the branch's honest summary of it) —
  // so the F8 doorstep contract can read the record the turn made.
  function osPayload(product, kind, textFallback, readIso) {
    if (!product || typeof product !== "object" || Array.isArray(product)) return undefined;
    // The product's own date wins; a dateless read is dated by the
    // read itself (the turn's clock) — that IS this record's date.
    const date = product.as_of || product.created_at || product.date || (readIso ? String(readIso).slice(0, 10) : null);
    return Object.assign({}, product, {
      record_id: product.watch_id || product.win_id || product.plan_id || product.record_id || product.id || `${kind}-${date ? String(date).slice(0, 10) : "undated"}`,
      date: product.date || (date ? String(date).slice(0, 10) : null),
      text: product.text || product.statement || textFallback || undefined,
    });
  }
  function osHandleChat(text, ctx) {
    const OS = osMod(); if (!OS) return null;
    const t = String(text || "").trim().toLowerCase();
    const c = ctx || {};
    const profile = c.profile || {};
    const postings = c.postings || [];
    const asOf = osAsOf(c);
    const iso = osNow(c).toISOString();
    const ownRecord = `Grounded in your own log and record, as of ${asOf}.`;
    try {
      // SC-271 — market value, evidence only (129 COS-001)
      if (/\bwhat am i worth\b|\bmarket value\b|\bmy worth now\b/.test(t)) {
        // DEPTH INTEGRATION (Lane B corpus C5): a turn that ALSO
        // carries a promotion/plan ask is a plan conversation, not a
        // bare worth read — stand down so the router's plan handler
        // answers both halves (it carries the honest worth state
        // inside the plan). A pure worth ask is served here as before.
        if (/\bpromotion\b|\bpromot\w*\b|\bcareer plan\b|\bgrowth plan\b|\bwhat'?s the plan\b|\bladder\b|\bnext level\b|\blevel up\b/.test(t)) return null;
        // INTEGRATION (2026-10-16): a MULTI-ASK turn (worth + a watch
        // to set + a tracker to show) belongs to the router's
        // multi-intent composition, which delivers or names every
        // part in the turn. This front door answering only the worth
        // part silently dropped the other two.
        if (!c._intentPartRun && /\bset a watch\b|\bwatch for\b|\bshow (me )?my applications\b|\bmy applications\b|\bshow (me )?my tracker\b/.test(t)) return null;
        const mv = OS.marketValue({ postings, cirs: c.cirs || [], as_of: iso.slice(0, 10) });
        const head = mv.estimate
          ? `Your market value, from sourced figures only: ${money(mv.estimate.low)}–${money(mv.estimate.high)} a year across ${mv.evidence.length} sourced figures, with a median midpoint of ${money(mv.estimate.median_midpoint)}. Every figure carries its source and date, and the estimate updates as soon as a new sourced figure lands.`
          : mv.statement;
        return { intent: "career_os_market_value", resultStatus: "completed", sends: 0, market_value: mv, payload: osPayload(mv, "market-value", undefined, iso), reply: `${head} Grounded in the postings' own stated ranges and the comp notes on file, as of ${asOf}. Want the skill-gap read against the higher-paying postings next?` };
      }
      // SC-272 — skill gap vs the higher-paying postings (129 COS-002)
      if (/\bskill gap\b|\bskills between me and\b|\bnext pay band\b/.test(t)) {
        const sg = OS.skillGap({ profileSkills: profileSkills(profile), postings, cirs: c.cirs || [] });
        // WORDING-BACKLOG (BUG-205): a three-skill ask answered by
        // two evidenced skills must SAY the third is unevidenced
        // (never padded), and a tie in the counts must be stated
        // as a tie-break, not a measured order (SC-272).
        const gaps = sg.gaps.slice(0, 3);
        const countWord = /\bthree\b|\b3\b/.test(t) ? 3 : gaps.length;
        const tie = gaps.length >= 2 && gaps[0].postings === gaps[1].postings;
        const head = gaps.length
          ? `The skills between you and the next pay band, in learn order: ${gaps.map((g) => `${g.skill} (named in ${g.postings} of the higher-paying postings)`).join(", ")}.${countWord > gaps.length ? ` Only ${gaps.length} evidenced ${gaps.length === 1 ? "skill stands" : "skills stand"} between you and the band — a ${countWord === 3 ? "third" : "further one"} is not invented to complete the count.` : ""} ${tie ? `Both lead skills are named in ${gaps[0].postings} posting${gaps[0].postings === 1 ? "" : "s"} each, so their order is a tie-break, not a measured gap: ${gaps[0].skill} first.` : "The order is by how many higher-paying postings — the ones stating a range — name each skill your profile does not list."}`
          : sg.statement;
        return { intent: "career_os_skill_gap", resultStatus: "completed", sends: 0, skill_gap: sg, payload: osPayload(sg, "skill-gap", undefined, iso), reply: `${head} Grounded in the postings on your feed with stated ranges, as of ${asOf}. ${sg.gaps.length ? `Want a learn plan for ${sg.gaps[0].skill} first?` : "Want the market-value read instead?"}` };
      }
      // SC-273 — passive watch (129 COS-003): a real stored watch record
      if (/\bpassive watch\b|\bperfect-fit role posts\b/.test(t)) {
        const store = osStore(c); if (!store) return null;
        const prefs = profile.preferences || {};
        const w = OS.createWatch(store, { companies: prefs.targetCompanies || [], role_families: [], locations: prefs.locations || [], keywords: [] }, { now: iso });
        const diff = OS.watchDiff(w, postings, postings);
        // WORDING-BACKLOG (BUG-205): the scope read as a chain of
        // "in" fragments (role in title in city in remote). One
        // clean line: role, then place/remote, then level (SC-273).
        const role = (prefs.roles || [])[0] || "Software Engineer";
        const place = (prefs.locations || [])[0] || "";
        const remote = /remote/i.test(JSON.stringify(prefs.locations || [])) || /remote/i.test(s(profile.location_preference || ""));
        const scopeLine = `It watches for ${role} roles${place ? ` in ${place}` : ""}${remote ? ", remote included" : ""} — a ping lands the moment a fitting one posts, and nothing new matches since the last snapshot.`;
        return { intent: "career_os_watch", resultStatus: "completed", sends: 0, watch: w, watch_diff: diff, payload: w, reply: `Your passive watch is set — it reads the same boards as discovery and pings you when a fitting role posts, so a perfect fit never waits for you to go looking. ${scopeLine} ${ownRecord} Want the watch widened to neighbouring titles?` };
      }
      // SC-274 — network upkeep (129 COS-004)
      if (/\bnetwork upkeep\b|\bgoing cold\b|\bwarmest contacts\b/.test(t)) {
        const store = osStore(c); if (!store) return null;
        const up = OS.networkUpkeep(store, { now: iso });
        if (!up.ranked.length) return { intent: "career_os_upkeep", resultStatus: "awaiting_user", sends: 0, upkeep: up, payload: osPayload(up, "network-upkeep", "Network upkeep over the relationship record: 0 contacts on it, so nobody is ranked going-cold.", iso), reply: `Network upkeep runs over your relationship record, and that record holds 0 contacts — so nobody can be ranked going-cold yet, and no warmth is invented for an empty record. ${ownRecord} Want to name your warmest contacts, or upload your export so the ranking has something real to read?` };
        const facts = up.ranked.slice(0, 3).map((r) => `${r.name}${r.org ? ` at ${r.org}` : ""} — last touch ${r.days_since == null ? "not dated" : `${r.days_since} days ago`}`).join("; ");
        return { intent: "career_os_upkeep", resultStatus: "prepared", sends: 0, upkeep: up, payload: osPayload(up, "network-upkeep", up.restart_draft || undefined, iso), reply: `Network upkeep, coldest first: ${facts}. ${up.coldest_warm ? `The coldest warm contact is ${up.coldest_warm.name}, and a restart draft sits on a card for your review — nothing sends from it.` : ""} ${ownRecord} Want the keep-warm draft for the coldest one prepared first?` };
      }
      // SC-276 before SC-275: the packet ask also names the wins log.
      if (/\breview packet\b|\bpromotion case\b/.test(t)) {
        const store = osStore(c); if (!store) return null;
        const rp = OS.reviewPacket(store, { now: iso });
        const head = rp.count ? `Your review packet, built from the wins log alone: ${rp.count} win${rp.count === 1 ? "" : "s"} assembled, dated, in your own words.` : "Your review packet is built from the wins log alone, and the log is empty — so the packet is empty too. It assembles only from the log, never from memory.";
        return { intent: "career_os_review_packet", resultStatus: "prepared", sends: 0, review_packet: rp, payload: rp, reply: `${head} ${ownRecord} ${rp.count ? "Want the packet exported for your review meeting?" : "Dictate the first win now — one line is enough — and the packet starts from it."}` };
      }
      // SC-275 — wins log state (129 COS-005/006 read side; nothing invented)
      // DEPTH INTEGRATION (FR-411 / BUG-253): a LOG STATEMENT is a
      // write, not a read — this read-side branch stands down for
      // statement shapes so the router's writer (142 handleOS)
      // records the win on the shared store. The read below runs on
      // that same store, so it reports wins logged through either
      // door, in the user's own words (the packet's own lines).
      if (/\bwins log\b|\blog a win\b|\bi text wins\b/.test(t)) {
        // A log STATEMENT carries the win itself after the prefix
        // ("log a win: I built the model…") — only that shape stands
        // down. The bare method phrase ("I text wins all semester")
        // is the feature's status ask (SC-275's canonical shape) and
        // is served by the read below.
        const stmt = t.match(/\b(?:log a win|add a win)\b[:\s—-]*(.*)$/);
        const carriesWin = !!(stmt && stmt[1] && stmt[1].split(/\s+/).filter(Boolean).length >= 3);
        if (carriesWin && !/\bshow\b|\blist\b|\bread\b/.test(t)) return null;
        const store = osStore(c); if (!store) return null;
        const rp = OS.reviewPacket(store, { now: iso });
        const lines = rp.count ? ` On the log: ${String(rp.text || "").split("\n").slice(0, 3).join(" ")}` : "";
        return { intent: "career_os_wins_log", resultStatus: "completed", sends: 0, review_packet: rp, wins_logged_total: rp.count, payload: rp, reply: `Your wins log is live: ${rp.count} win${rp.count === 1 ? "" : "s"} on it so far, each dated and in your own words, feeding the living resume and the review packet.${lines} Text wins as they happen and they land in that packet — nothing is back-filled or invented. ${ownRecord} ${rp.count ? "Want to add another win now?" : "Want to dictate your first win now?"}` };
      }
      // SC-277 — return-offer playbook + intern timeline (129 COS-007)
      if (/\breturn[ -]?offer playbook\b/.test(t)) {
        const pb = OS.returnOfferPlaybook({ cir: c.cir || null, offer: c.offer || null });
        const tl = OS.internTimeline({ endDate: c.internshipEnd || undefined });
        const m0 = tl.milestones[0];
        return { intent: "career_os_playbook", resultStatus: "prepared", sends: 0, playbook: pb, timeline: tl, payload: osPayload(pb, "return-offer-playbook", pb.steps && pb.steps[0], iso), reply: `Your return-offer playbook — before, during, and after. ${pb.steps[0]} ${pb.steps[2]} First dated milestone: ${m0.date} — ${m0.action} Grounded in your own internship log and the company file's sourced notes, as of ${asOf}. Name the firm and I will pin the playbook to its bar and its timeline — want to name it now?` };
      }
      // SC-278 — first-90-days plan (129 COS-007 first_90_days)
      if (/\bfirst[ -]?90\b/.test(t)) {
        const pb = OS.returnOfferPlaybook({ cir: c.cir || null, offer: c.offer || null });
        return { intent: "career_os_first90", resultStatus: "prepared", sends: 0, first_90_days: pb.first_90_days, playbook: pb, payload: osPayload(pb, "return-offer-playbook", pb.first_90_days && pb.first_90_days[0], iso), reply: `Your first-90-days plan at the new job. ${pb.first_90_days.join(" ")} ${ownRecord} Want week one pinned to your actual start date?` };
      }
      // SC-279 — quarterly goals check-in (129 COS-008)
      if (/\bquarterly check-in\b|\bgoals? check-in\b|\bcareer goals versus reality\b/.test(t)) {
        const store = osStore(c); if (!store) return null;
        const g = OS.goalsCheckin(store, { now: iso });
        const r0 = g.reality;
        const goalLine = g.stated_goals.length ? `${g.stated_goals[0].goal} — ${g.stated_goals[0].status}.` : "No measurable goal is stored yet, so this check-in is where the first target gets set — the plan adjusts from the record, not from the story we prefer.";
        return { intent: "career_os_goals", resultStatus: "prepared", sends: 0, goals: g, payload: osPayload(g, "goals-checkin", g.adjustment_prompt, iso), reply: `Your goals check-in, against your own targets. On your record right now: ${r0.applications_logged} applications, ${r0.offers_logged} offers, ${r0.wins_logged} wins, ${r0.active_watches} active watches. ${goalLine} ${ownRecord} ${g.stated_goals.length ? "Want to adjust a target, or hold the line?" : "Tell me the first target — a role, a date, a number — and the next check-in measures against it."}` };
      }
      // SC-280 — market-shift alert (129 COS-001 + COS-003 compBandShift)
      // COMPLEXITY WAVE: the gate was declaration-only ("pay band
      // moved"); the genuine question form ("has the pay band for my
      // role moved lately?") fell through to 142's generic OS status.
      if (/\bmarket-shift\b|\bpay band moved\b|\bcomp band\b|\bpay band\b[^.?!]*\b(moved|move|shift|changed|risen|dropped)\b|\bhas\b[^.?!]*\bpay band\b[^.?!]*\bmoved\b/.test(t)) {
        const mv = OS.marketValue({ postings, cirs: c.cirs || [], as_of: iso.slice(0, 10) });
        const shift = OS.compBandShift("your feed", [], postings);
        const env = mv.estimate ? `The current stated envelope on your feed is ${money(mv.estimate.low)}–${money(mv.estimate.high)} a year across ${mv.evidence.length} sourced figures.` : "No posting on your feed states a range yet, so there is no sourced envelope to compare.";
        return { intent: "career_os_market_shift", resultStatus: "prepared", sends: 0, market_value: mv, band_shift: shift, payload: osPayload(shift, "comp-band-shift", undefined, iso), reply: `Market-shift check, shown with the data. ${env} A band move needs two dated snapshots of the same postings; the record holds one snapshot, so no move is claimed — this envelope is the baseline the next snapshot gets compared against. Grounded in the postings' own stated ranges, as of ${asOf}. Want a watch set so the next snapshot is captured automatically?` };
      }
      // SC-281 — skill-demand read (129 COS-002 over the current feed)
      if (/\bskill-demand\b|\bstarted requiring\b|\bwhat postings in my field\b/.test(t)) {
        const sg = OS.skillGap({ profileSkills: profileSkills(profile), postings, cirs: c.cirs || [] });
        const head = sg.gaps.length
          ? `What postings in your field require now, counted across the higher-paying postings on your feed: ${sg.gaps.slice(0, 3).map((g) => `${g.skill} (named in ${g.postings})`).join(", ")}.`
          : "Across the higher-paying postings on your feed, every named skill is already on your profile — no new demand can be grounded from this snapshot.";
        return { intent: "career_os_skill_trend", resultStatus: "prepared", sends: 0, skill_gap: sg, payload: osPayload(sg, "skill-gap", undefined, iso), reply: `${head} A started-requiring-this-year trend needs two dated snapshots of the feed; the record holds one, so this is the current demand ranking, not a trend claim. Grounded in the postings on your feed, as of ${asOf}. Want the learn order for the top gap first?` };
      }
      // SC-282 — two-year re-route (134 answerPath, claims-verified shape)
      if (/\btwo-year re-route\b|\b2-year re-route\b|\bre-route\b/.test(t)) {
        const Paths = pathsMod(); if (!Paths || !Paths.getPath || !Paths.answerPath) return null;
        const roles = ((profile.preferences || {}).roles || []).join(" ");
        const pathId = /\bbank|financ/i.test(roles) ? "ib-ladder" : "faang-state-school";
        const path = Paths.getPath(pathId) || Paths.getPath(Paths.listPaths()[0].id);
        if (!path) return null;
        const ans = Paths.answerPath(path, null, {});
        const first = (x) => String(x || "").split(/(?<=[.!?])\s/)[0];
        // WORDING-BACKLOG (BUG-205): the old template printed the
        // rung's own "First rung:" prefix twice and spoke rung two
        // as a bare label ("Then: Proof artifacts."). Each rung now
        // carries its role, a target date inside the two years,
        // and the proof it must produce (its note) (SC-282).
        const rungName = (x) => String((x && x.step) || "").replace(/^(first|second|third|fourth) rung:\s*/i, "").replace(/^[A-Z]/, (ch) => ch.toLowerCase());
        const byWhen = (months) => { const d = new Date(osNow(c).getTime() + months * 30.44 * 864e5); return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(d); };
        const r1 = path.ladder[0] || {}; const r2 = path.ladder[1] || {};
        return { intent: "career_os_path", resultStatus: "prepared", sends: 0, path_answer: ans, payload: osPayload(ans, "career-path", ans && ans.text, iso), reply: `The two-year re-route, rung by rung from where you actually stand. Rung one, by ${byWhen(6)}: ${rungName(r1)} — ${first(r1.note)} Rung two, by ${byWhen(18)}: ${rungName(r2)} — ${first(r2.note)} ${path.plan.year[0]} Grounded in the published path record and its listed sources, as of ${asOf}. Want rung one turned into this quarter's applications?` };
      }
      // SC-284 — mentor map (135 mentorMap over the user's own graph)
      if (/\bmentor map\b/.test(t)) {
        const Graph = graphMod(); if (!Graph || !Graph.mentorMap) return null;
        const people = [];
        const push = (p) => { if (!p) return; try { people.push(Graph.normalizePerson ? Graph.normalizePerson(p) : p); } catch { people.push(p); } };
        for (const p of (c.graph && c.graph.people) || []) push(p);
        for (const p of c.contacts || []) push(p);
        for (const p of profile.connections || []) push(p);
        const store = { people, interactions: (c.graph && c.graph.interactions) || [], referrals: (c.graph && c.graph.referrals) || [], user: (c.graph && c.graph.user) || null };
        const companies = (profile.preferences || {}).targetCompanies || [];
        const mm = Graph.mentorMap(store, companies);
        if (!people.length) return { intent: "career_os_mentor_map", resultStatus: "awaiting_user", sends: 0, mentor_map: mm, graph_people: 0, payload: { record_id: `mentor-map-${iso.slice(0, 10)}`, date: iso.slice(0, 10), criteria: { graph_people: 0 }, text: "Mentor map over your graph record: 0 people on it, so the map is honestly empty." }, reply: `Your mentor map ranks people already in your network by the shared fact each path stands on — school, club, major, hometown. Your graph on file holds 0 people, so the map is honestly empty: nobody can be ranked, and nobody is invented. Grounded in your own graph record, as of ${asOf}. Upload your export or name a firm and I will rank the mentors to deepen — want to start with the export?` };
        const rows = mm.flatMap((m) => m.mentors.map((x) => `${x.name} at ${m.company} (${x.shared_fact})`));
        return { intent: "career_os_mentor_map", resultStatus: "prepared", sends: 0, mentor_map: mm, graph_people: people.length, payload: { record_id: `mentor-map-${iso.slice(0, 10)}`, date: iso.slice(0, 10), criteria: { graph_people: people.length }, text: `Mentor map over your graph record: ${people.length} people ranked by the shared fact each path stands on.` }, reply: `Your mentor map, ranked from your graph: ${rows.slice(0, 3).join("; ") || "no senior contact ranks as a mentor yet"}. Every path shows the fact it stands on, and people at your current employer are excluded by default. Grounded in your own graph record, as of ${asOf}. Want the first one's intro path prepared as a held card?` };
      }
      // SC-285 — annual career retro (136 seasonRetro over the season record)
      if (/\bannual career retro\b|\bcareer retro\b|\boutcomes versus plan\b/.test(t)) {
        const Season = seasonMod(); if (!Season || !Season.seasonRetro) return null;
        if (!Array.isArray(profile._careerSeasonStore)) { try { profile._careerSeasonStore = []; } catch { /* profile may be frozen; an empty record is the honest read */ } }
        const store = c.seasonStore || profile._careerSeasonStore || [];
        const r = Season.seasonRetro(store);
        const head = r.total
          ? `${r.what_converted} ${r.what_didnt} Next season: ${r.next_season_plan[0]}`
          : "Your season record holds 0 applications, so the retro is honest and short: no outcomes to count yet. The retro counts applications, advancement, and offers from the record — the misses included, unedited — and next year's targets get set from those same numbers, not from the story we prefer.";
        return { intent: "career_os_retro", resultStatus: "prepared", sends: 0, retro: r, payload: osPayload(r, "career-retro", r.what_converted || "Your season record holds 0 applications, so the retro counts no outcomes yet.", iso), reply: `Your career retro: outcomes versus plan, from the record. ${head} Every count comes from your own application log, as of ${asOf}. Want next year's targets drafted from this?` };
      }
    } catch { return null; }
    return null;
  }

  // ---------- chat glue: the router tries 120 first, then this ----------
  function handleChat(text, ctx) {
    const t = String(text || "").trim().toLowerCase();
    const c = ctx || {};
    // The host supplied the committed profile. Only an explicit correction
    // instruction below may resolve its conflicts; reads never replay state.
    if (c.profile && /\buse the new (one|resume|version)\b|\bswitch to the new\b|\bold resume'?s wrong\b|\buse the newer\b/.test(t)) {
      const r = applyProfileCorrection(c.profile, text, c);
      return { intent: "profile_correction", resultStatus: r.ok ? "completed" : "blocked", ok: r.ok, changes: r.changes, audit: r.audit || null, reply: r.ok ? r.reply : r.text };
    }
    if (/\bhelp me find a job\b|\bstart.*onboarding\b|\bonboard me\b/.test(t)) {
      if (!c.profile) return { intent: "onboarding", reply: "I need your profile record to start — the host passes it in." };
      const r = startInterview(c.profile);
      return { intent: "onboarding", done: r.done, pending: r.pending || null, reply: r.text };
    }
    if (c.profile && c.profile._onboarding_pending && c.interviewAnswer) {
      const r = answerCurrent(c.profile, text);
      return { intent: "onboarding_answer", done: r.done, answered: r.answered, pending: r.pending || null, reply: r.text };
    }
    const tq = recallText(t);
    // With no profile at all the answer is the same honest ask, never the catch-all (flow-scenarios-safety.test.ts: "what's
    // my GPA?" from a person with nothing on file got "I may have missed what you meant").
    if (/^(what'?s|what is) my\b/.test(tq) || SCHOOL_ASK.test(tq) || RECALL_ASK.test(tq) || EMPLOYER_ASK.test(tq) || RESUME_ASK.test(tq)) {
      const r = answerFromProfile(c.profile || {}, tq);
      // Not saved here, but maybe on the record elsewhere: work authorization (a sponsorship answer, a confirmed resume
      // line or a stated fact: 142's eligibility read-back), a location or a role the person stated in chat (142's
      // stated-fact read-back). Those answer it; this one only asks when none can.
      const stated = ((c.statedFacts && Array.isArray(c.statedFacts.facts)) ? c.statedFacts.facts : []).map((f) => f && f.kind);
      const elsewhere = !r.found && (/work authorization|authorised|authorized to work|sponsorship/.test(tq)
        || (/where|location|city|town/.test(tq) && stated.includes("geography")) || (/roles?|jobs?|positions?|looking for/.test(tq) && stated.includes("target_role")));
      if (!elsewhere && (r.found || r.ask)) return { intent: "profile_recall", found: r.found, source: r.source || null, reply: r.found ? r.answer : r.ask };
    }
    if (/\bwhat (?:can you|do you) (?:actually )?do\b.*\bjob search\b|\bwhat can you do for my (?:job|career)\b/.test(t)) {
      const r = capabilityStatus(c.capabilitySources || {});
      return { intent: "capability_status", proven_live: r.proven_live, blocked_count: r.blocked_count, reply: r.text };
    }
    if (/\bwhat do you have stored about me\b|\bwhat'?s stored about me\b|\bshow (?:me )?my stored\b/.test(t)) {
      if (!c.profile) return null;
      const r = profileExport(c.profile, c.access || {});
      return { intent: "profile_export", fact_count: r.fact_count, connection_count: r.connection_count, delete_path_offered: r.delete_path_offered, reply: r.text };
    }
    // Career OS front door (section 5): narrow OS ask shapes only; a null
    // here falls through to the general router exactly as before.
    const osResult = osHandleChat(text, c);
    if (osResult) return osResult;
    return null;
  }

  return { STEPS, stepAnswered, nextQuestion, startInterview, answerCurrent, factVersion, bumpFactVersion, answerFromProfile, SENSITIVE_FIELDS, sensitiveAnswerPrompt, confirmSensitive, profileExport, capabilityStatus, createReauthLog, planReauthSends, applyProfileCorrection, applyPersistedCorrections, exportCorrectionStore, restoreCorrectionStore, _resetCorrectionStore, handleChat };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerOnboarding;
