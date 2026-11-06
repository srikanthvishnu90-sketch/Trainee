/* Evidence-grounded capability 2. Pure, no I/O, credentials, clocks or writes.
   Role recipes are exploration hypotheses, not labor-market statistics or
   employer requirements. Host-supplied postings need provenance + freshness;
   fixture/snapshot rows are never current openings. */
const CareerRecommendations = (() => {
  const VERSION = "2026-10-16";
  const str = (v) => typeof v === "string" ? v : "";
  const list = (v) => Array.isArray(v) ? v : [];
  const unique = (v) => [...new Set(v)];
  const label = (v) => str(v).replace(/\s+/g, " ").slice(0, 180);
  const factId = (f) => str(f.id || f.fact_id);
  const confirmed = (p) => {
    const facts = list(p && p.facts).filter((f) => f && typeof f === "object");
    return facts.filter((f) => factId(f) && !(f.id && f.fact_id && f.id !== f.fact_id) && facts.filter((x) => factId(x) === factId(f)).length === 1 && !f.needs_confirmation && (!f.status || f.status === "confirmed"));
  };
  const factText = (f) => [f.name, f.title, f.text, ...list(f.bullets), ...list(f.skills)].filter(Boolean).join(" ");
  // Negative statements and instructions in source documents are not positive
  // qualification evidence. Conservative exclusion beats inventing a skill.
  const usable = (f) => !/\b(no|not|never|without|lack|lacking|ignore|pretend|invent|unfamiliar|learning|beginner)\b/i.test(factText(f));
  const matches = (text, term) => new RegExp("(?:^|[^a-z0-9])" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[^a-z0-9])", "i").test(text);
  function citations(profile, ids) {
    return confirmed(profile).filter((f) => ids.includes(factId(f))).map((f) => ({ type: "profile_fact", fact_id: factId(f), label: label(f.title || f.name || f.kind), source: f.source || "user-confirmed profile", as_of: f.confirmed_at || null }));
  }
  const ALIASES = {
    scheduling: ["scheduling", "scheduled", "schedule"], editing: ["editing", "edited", "edit"],
    reconciliation: ["reconciliation", "reconciled", "reconcile"],
    "circuit installation": ["circuit installation", "installed residential circuits", "installed circuits"],
    "fault diagnosis": ["fault diagnosis", "diagnosed electrical faults", "diagnosed faults"],
    "instructional delivery": ["instructional delivery", "taught algebra", "taught", "teaching"],
    "learning assessment": ["learning assessment", "assessed learning outcomes", "assessed"],
    "vector illustration": ["vector illustration", "vector illustrations"],
    "accessible layout": ["accessible layout", "accessibility-tested publication layouts", "accessible layouts"],
  };
  const mentions = (text, term) => (ALIASES[str(term).toLowerCase()] || [str(term)]).some((t) => t && matches(text, t));
  // Evidence is a relation to performed work, not a word in a resume. Preserve
  // exact quotes and offsets; no inferred span/hash is presented as provenance.
  function relations(f, term) {
    const parts = ["text", "title"].filter((field) => str(f[field])).map((field) => ({ field, text: f[field] }));
    parts.push(...list(f.bullets).map((text, i) => ({ field: `bullets[${i}]`, text: str(text) })));
    const out = [];
    for (const part of parts) for (const m of part.text.matchAll(/[^.;\n!?]+/g)) {
      const quote = m[0], t = quote.toLowerCase().replace(/[’‘]/g, "'");
      if (!mentions(t, term)) continue;
      const negative = /\b(no|zero|never|without|lack|lacking|unfamiliar|unable|cannot|can't|haven't|hasn't|hadn't|don't|doesn't|didn't|isn't|wasn't|not|yet to|beginner)\b/.test(t);
      const studying = /\blearning\b/.test(t) && !/learning (assessment|outcomes)/.test(t);
      const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliases = (ALIASES[str(term).toLowerCase()] || [str(term)]).map(escape).join("|");
      const token = `(?:${aliases})`;
      const toolRelation = new RegExp(`\\b(?:used?|using|with|in|via)\\s+(?:(?:a|an|the)\\s+)?${token}(?:$|[^a-z0-9])`, "i").test(t);
      const builtRelation = new RegExp(`\\b(?:built|developed|implemented|coded|programmed|wrote|queried|automated|debugged|tested|added|taught)\\b(?:\\s+(?!for\\b|about\\b|of\\b)[a-z0-9-]+){0,7}\\s+${token}(?:$|[^a-z0-9])`, "i").test(t);
      const otherPeople = new RegExp(`\\b(?:for|of|about)\\s+(?:[a-z0-9-]+\\s+){0,4}${token}\\s+(?:engineers?|developers?|candidates?|students?|teams?|designers?|drafters?)\\b`, "i").test(t)
        || new RegExp(`${token}\\s+(?:engineers?|developers?|candidates?|designers?|drafters?)\\b`, "i").test(t)
        || /\b(interviewed|hired|recruited|screened)\b/.test(t);
      const action = /\b(built|build|developed|implemented|coded|programmed|wrote|used|using|with|tested|testing|verified|validated|designed|created|maintained|performed|prepared|reviewed|resolved|documented|coordinated|managed|scheduled|scheduling|edited|editing|reconciled|installed|diagnosed|taught|assessed|analyzed|analysed|queried|automated|added)\b/.test(t);
      const technical = /^(python|sql|rust|go|golang|java|javascript|typescript|c\+\+|react|excel|crm|cad)$/i.test(term);
      const demonstrated = !/\b(ignore|pretend|invent)\b/.test(t) && !otherPeople && action && (!technical || toolRelation || builtRelation);
      out.push({ fact_id: factId(f), quote, field: part.field, start: m.index, end: m.index + quote.length,
        relation: negative || studying ? "explicit_denial_or_unproven" : demonstrated ? "performed_work" : "mention_only",
        source: f.source || "canonical profile", artifact_hash: f.artifact_hash || f.source_hash || null, source_span: f.source_span || null });
    }
    return out;
  }
  function evidence(profile, term) {
    const all = confirmed(profile);
    const superseded = new Set(all.flatMap((f) => list(f.supersedes)));
    const facts = all.filter((f) => !superseded.has(factId(f)) && !(f.superseded_by && all.some((n) => factId(n) === f.superseded_by)));
    const links = facts.filter((f) => ["experience", "project", "leadership", "publication", "certification"].includes(f.kind)).flatMap((f) => relations(f, term));
    const negative = facts.flatMap((f) => relations(f, term)).filter((r) => r.relation === "explicit_denial_or_unproven");
    const positive = links.filter((r) => r.relation === "performed_work");
    const claimed = facts.filter((f) => f.kind === "skill" && str(f.name || f.title).toLowerCase() === str(term).toLowerCase());
    if (negative.length) return { status: positive.length || claimed.length ? "conflicted" : "not_evidenced", factIds: unique([...positive, ...negative].map((r) => r.fact_id)), supportingRelations: [], conflicts: negative, unknowns: ["An active denial or unproven statement prevents a positive finding; confirm the canonical correction."] };
    const ids = unique(positive.map((r) => r.fact_id));
    return { status: ids.length ? "evidence_present" : claimed.length ? "self_reported_only" : "not_evidenced", factIds: ids.length ? ids : claimed.map(factId), supportingRelations: positive, conflicts: [], mentionFactIds: unique(links.filter((r) => r.relation === "mention_only").map((r) => r.fact_id)) };
  }
  // These samples deliberately describe work products, not licenses or
  // employer eligibility. Every role still needs a particular posting check.
  const ROLES = [
    { id: "operations", title: "Operations coordinator", signals: ["operations", "inventory", "scheduling", "logistics", "shift", "dispatch"], skills: ["scheduling", "Excel"], sample: "map a scheduling or inventory workflow and propose one measurable improvement", tradeoffs: "confirm shift hours, physical requirements and scope in each posting" },
    { id: "customer-support", title: "Customer support specialist", signals: ["customer support", "customer service", "tickets", "help desk", "retail"], skills: ["ticket triage", "written communication"], sample: "draft replies to three fictional customer issues and a short escalation guide", tradeoffs: "confirm channel, workload, schedule and escalation responsibilities" },
    { id: "administration", title: "Administrative coordinator", signals: ["administrative", "scheduling", "calendar", "office", "records"], skills: ["scheduling", "record keeping"], sample: "create a fictional meeting schedule and an error-checked records checklist", tradeoffs: "confirm office attendance and confidentiality requirements" },
    { id: "sales", title: "Sales or account coordinator", signals: ["sales", "crm", "account management", "customer", "retail"], skills: ["CRM", "written communication"], sample: "write a fictional customer handoff and an account follow-up plan", tradeoffs: "check targets, compensation structure and whether outbound selling suits you" },
    { id: "communications", title: "Communications or content assistant", signals: ["writing", "editor", "journalism", "communications", "content", "english"], skills: ["editing", "audience research"], sample: "edit a public announcement for two audiences and explain the changes", tradeoffs: "review portfolio expectations and the amount of writing versus coordination" },
    { id: "legal-support", title: "Legal support or legal operations", signals: ["legal", "law", "juris doctor", "jd", "paralegal", "litigation", "contracts"], skills: ["legal research", "document review"], sample: "summarize a public case and build a fictional document-review checklist", tradeoffs: "verify jurisdiction, role scope and any stated credential; no bar admission is inferred" },
    { id: "compliance", title: "Compliance operations analyst", signals: ["compliance", "legal", "audit", "contracts", "law", "risk"], skills: ["policy review", "risk documentation"], sample: "compare two public policies and document a fictional exception-review process", tradeoffs: "check domain-specific requirements; a law degree does not establish regulated-role eligibility" },
    { id: "finance", title: "Finance or accounting analyst", signals: ["finance", "accounting", "valuation", "reconciliation", "bookkeeping", "financial"], skills: ["Excel", "reconciliation"], sample: "build a fictional budget-versus-actual workbook and explain its assumptions", tradeoffs: "verify seniority, accounting knowledge and any certification in the specific posting" },
    { id: "business-operations", title: "Business operations assistant", signals: ["excel", "finance", "budget", "operations", "business", "analysis"], skills: ["Excel", "process documentation"], sample: "write a one-page decision memo using a small fictional operating budget", tradeoffs: "check whether the role is primarily coordination, analysis or stakeholder work" },
    { id: "software-engineering", title: "Software engineering", signals: ["computer science", "python", "javascript", "typescript", "software", "java", "c++"], skills: ["testing", "version control"], sample: "build a small software feature, document one design tradeoff and add runnable tests", tradeoffs: "degree or coursework alone does not establish production coding experience" },
    { id: "data-analytics", title: "Data / analytics", signals: ["sql", "statistics", "analytics", "python", "data analysis", "data science"], skills: ["SQL", "data validation"], sample: "answer a question from a public dataset and write the limitations alongside the result", tradeoffs: "check quantitative and tool requirements; programming alone does not prove statistical depth" },
    { id: "health-operations", title: "Healthcare administration or coordination", signals: ["nursing", "patient", "clinical", "healthcare", "medical"], skills: ["scheduling", "record keeping"], sample: "map a fictional appointment workflow without using any patient information", tradeoffs: "verify local credentials for clinical duties; none are inferred from this administrative hypothesis" },
    { id: "mechanical-design", title: "Mechanical design engineering", signals: ["mechanical engineering", "hydraulic", "CAD", "load calculations"], skills: ["CAD", "load calculations"], sample: "document a fictional component design with load assumptions and a review checklist", tradeoffs: "verify seniority, safety review and local credential requirements; none are inferred" },
    { id: "manufacturing-quality", title: "Manufacturing or design verification", signals: ["hydraulic", "load calculations", "manufacturing", "mechanical engineering"], skills: ["load calculations", "test documentation"], sample: "write a fictional component verification plan with measurable acceptance criteria", tradeoffs: "check quality-system experience and supervision requirements" },
    { id: "electrical-trades", title: "Electrical installation under appropriate supervision", signals: ["electrical", "circuits", "electrician", "apprenticeship"], skills: ["circuit installation", "fault diagnosis"], sample: "document a fictional installation inspection checklist for review by a qualified supervisor", tradeoffs: "confirm jurisdiction, apprenticeship level and permitted duties; no independent license is inferred" },
    { id: "electrical-maintenance", title: "Electrical maintenance technician", signals: ["electrical", "circuits", "faults", "apprenticeship"], skills: ["fault diagnosis", "maintenance documentation"], sample: "outline a fictional fault-report workflow for review without performing electrical work", tradeoffs: "verify safety training, supervision and employer-specific credentials" },
    { id: "teaching", title: "Teaching or tutoring", signals: ["taught", "algebra", "education", "students"], skills: ["instructional delivery", "learning assessment"], sample: "prepare a short fictional algebra lesson and an assessment rubric", tradeoffs: "check age group, subject depth and local teaching credentials; no teaching license is inferred" },
    { id: "instructional-content", title: "Instructional content development", signals: ["taught", "algebra", "learning outcomes", "education"], skills: ["learning assessment", "curriculum design"], sample: "write an annotated learning activity with an answer key and accessibility review", tradeoffs: "check curriculum ownership, portfolio and subject requirements" },
    { id: "graphic-design", title: "Graphic design", signals: ["vector illustrations", "publication layouts", "graphic design", "typography"], skills: ["vector illustration", "accessible layout"], sample: "prepare a fictional poster and explain visual hierarchy and accessibility choices", tradeoffs: "verify portfolio, software and production requirements without assuming a specific tool" },
    { id: "publication-design", title: "Publication or production design", signals: ["publication layouts", "vector illustrations", "public exhibits", "graphic design"], skills: ["accessible layout", "production handoff"], sample: "create an annotated publication handoff checklist with print and digital checks", tradeoffs: "confirm prepress, digital accessibility and employer workflow requirements" },
  ];
  function roleHypotheses(ctx) {
    const p = ctx.profile || {};
    const facts = confirmed(p);
    const ranked = ROLES.map((r) => {
      const anchors = facts.filter((f) => r.signals.some((term) => mentions(factText(f), term) && (f.kind === "education" && usable(f) || ["evidence_present", "self_reported_only"].includes(evidence(p, term).status))));
      return { ...r, score: anchors.length, factIds: unique(anchors.map(factId)) };
    }).filter((r) => r.score).sort((a, b) => b.score - a.score || ROLES.findIndex((r) => r.id === a.id) - ROLES.findIndex((r) => r.id === b.id));
    let selected = ranked.slice(0, 3);
    if (selected.length < 2) {
      for (const id of ["operations", "communications"]) {
        if (selected.length >= 2) break;
        if (!selected.some((r) => r.id === id)) selected.push({ ...ROLES.find((r) => r.id === id), score: 0, factIds: [] });
      }
    }
    // An education-only record anchors exploration context, never a skill claim.
    const contextIds = facts.filter((f) => f.kind === "education").map(factId);
    return selected.map((r) => ({ ...r, signals: r.signals.slice(), skills: r.skills.slice(), status: "hypothesis", evidenceLevel: r.score ? "record_signal" : "exploration_only", factIds: r.factIds.length ? r.factIds : contextIds, why: r.score ? `Confirmed record signals [${r.factIds.join(", ")}] suggest work to test; this does not establish qualification` : `An exploration option; ${contextIds.length ? `education context [${contextIds.join(", ")}] establishes no role skills` : "no confirmed role evidence is available"}`, supportingRelations: r.signals.flatMap((term) => list(evidence(p, term).supportingRelations)), gaps: r.skills.map((skill) => ({ skill, basis: "exploration_recipe_not_employer_requirement", ...evidence(p, skill) })) }));
  }
  function locationScope(ctx) {
    const p = ctx.profile || {}, prefs = p.preferences || {}, cons = { ...(p.constraints || {}), ...(ctx.constraints || {}) };
    let locations = unique(list(ctx.locations || prefs.locations).map(str).filter(Boolean));
    if (cons.relocation === false && !locations.length && p.basics && p.basics.location) locations = [str(p.basics.location)];
    const remoteOnly = ctx.remoteOnly === true || cons.remoteOnly === true || prefs.remote === "only" || prefs.remote === "remote_only";
    return { locations, remoteOnly, relocation: typeof cons.relocation === "boolean" ? cons.relocation : null, basis: "user-supplied preferences/constraints; residence alone is not relocation consent", unknowns: [...(!locations.length ? ["Preferred work locations are unknown."] : []), "Remote hiring geography and work authorization need each employer's wording; remote does not mean work from anywhere.", "No local market volume, salary or cost comparison is available."] };
  }
  function reservedSource(url) {
    try { const host = new URL(str(url)).hostname.toLowerCase().replace(/\.$/, ""); return /(^|\.)(example\.(com|org|net|test)|localhost)$/.test(host) || /\.test$/.test(host); }
    catch { return true; }
  }
  function latestObservations(rows, now) {
    const groups = new Map(), excluded = [];
    for (const row of list(rows)) {
      if (!row || typeof row !== "object") continue;
      const trust = freshness({ ...row, status: "open" }, now);
      if (!trust.current) { excluded.push({ id: row.id || null, reason: trust.reason }); continue; }
      const rawReq = row.requisition_id ?? row.id;
      const req = typeof rawReq === "string" || typeof rawReq === "number" && Number.isFinite(rawReq) ? String(rawReq) : "";
      if (!req) { excluded.push({ id: null, reason: "missing_requisition_identity" }); continue; }
      const employer = row.employer_id || str(row.company).trim().toLowerCase() || new URL(trust.url).hostname;
      const key = JSON.stringify([employer, req]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const latest = [];
    for (const group of groups.values()) {
      const at = (row) => Date.parse(row.observed_at || (row.source || {}).observed_at);
      const newest = Math.max(...group.map(at)), winners = group.filter((row) => at(row) === newest);
      const closed = winners.find((row) => row.status === "closed");
      if (closed) latest.push(closed);
      else if (new Set(winners.map((row) => JSON.stringify(row))).size > 1) excluded.push({ id: winners[0].id, reason: "conflicting_latest_observation" });
      else latest.push(winners[0]);
      excluded.push(...group.filter((row) => at(row) !== newest).map((row) => ({ id: row.id, reason: "superseded_observation" })));
    }
    return { latest, excluded };
  }
  function freshness(row, now) {
    const source = row.source || {};
    const kind = row.source_kind || source.kind;
    const url = row.source_url || source.url || row.url;
    const observed = row.observed_at || source.observed_at;
    const age = typeof now === "number" ? now - Date.parse(observed) : NaN;
    const fixture = reservedSource(url) || row.isTestFixture || row.fixture || row.is_fixture || kind !== "live_public" || /fixture|snapshot|example\.(test|com)|localhost/i.test([url, row.id, row.source_path].join(" "));
    let reason = null;
    if (fixture) reason = "fixture_or_unverified_source";
    else if (!/^https:\/\//i.test(str(url))) reason = "missing_source_url";
    else if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) reason = "stale_or_unknown_observation";
    else if (row.status !== "open") reason = "not_confirmed_open";
    return { current: !reason, reason, url: url || null, observed_at: observed || null, source_kind: kind || "unknown" };
  }
  function requirementGaps(profile, posting) {
    return list(posting && posting.requirements).filter((r) => r && typeof r.skill === "string" && r.skill.trim()).map((r) => ({ skill: r.skill, level: ["required", "preferred"].includes(r.level) ? r.level : "unknown", quote: r.text || null, source: { posting_id: posting.id || null, url: posting.source_url || (posting.source || {}).url || posting.url || null }, ...evidence(profile, r.skill) }));
  }
  function openingRecommendations(ctx, paths, scope) {
    const observations = latestObservations(ctx.postings, ctx.now);
    const excluded = observations.excluded.slice(), candidates = [], hypotheses = paths || roleHypotheses(ctx);
    for (const row of observations.latest) {
      if (!row || typeof row !== "object") continue;
      const fresh = freshness(row, ctx.now);
      if (!fresh.current) { excluded.push({ id: row.id || null, reason: fresh.reason }); continue; }
      const title = str(row.title), mode = str(row.mode || row.workplace_type).toLowerCase();
      if (scope.remoteOnly && mode !== "remote") { excluded.push({ id: row.id, reason: "remote_constraint" }); continue; }
      const places = unique([str(row.location), ...list(row.locations).map((v) => typeof v === "string" ? v : str(v && v.name))].filter(Boolean));
      // Exact normalized location matching avoids York matching New York, or
      // remote US silently matching a different jurisdiction. Host normalizes.
      const norm = (v) => str(v).trim().toLowerCase();
      if (!places.length || places.every((v) => /^(remote|anywhere|worldwide|global)$/i.test(v.trim()) || /unknown|unspecified|not (specified|provided)|tbd|worldwide|anywhere/i.test(v))) { excluded.push({ id: row.id, reason: "hiring_geography_unverified" }); continue; }
      if (scope.locations.length && !places.some((v) => scope.locations.some((l) => norm(v) === norm(l)))) { excluded.push({ id: row.id, reason: "location_unverified_or_mismatch" }); continue; }
      const cons = { ...((ctx.profile || {}).constraints || {}), ...(ctx.constraints || {}) };
      if ((ctx.needsIncome || cons.needsIncome) && row.paid !== true) { excluded.push({ id: row.id, reason: "paid_status_unverified" }); continue; }
      const aligned = hypotheses.filter((p) => [p.title, ...p.signals].some((term) => matches(title, term)));
      if (!aligned.length || !aligned.some((p) => p.evidenceLevel === "record_signal")) { excluded.push({ id: row.id, reason: "no_evidenced_role_alignment" }); continue; }
      candidates.push({ id: row.id || null, title, company: label(row.company), source: fresh, roleHypotheses: aligned.map((p) => p.id), factIds: unique(aligned.flatMap((p) => p.factIds)), gaps: requirementGaps(ctx.profile, row), eligibility: "unknown_until_employer_requirements_checked", location: places, mode });
    }
    return { status: candidates.length ? "sourced_openings_for_review" : "no_verified_matching_openings", openings: candidates, excluded, as_of: typeof ctx.now === "number" && Number.isFinite(ctx.now) ? new Date(ctx.now).toISOString() : null, policy: "live_public + HTTPS + explicit open + observed within 24 hours; host must verify source; no fixture fallback" };
  }
  function planPaths(ctx) {
    const c = ctx || {}, paths = roleHypotheses(c), scope = locationScope(c), openings = openingRecommendations(c, paths, scope);
    const ids = unique(paths.flatMap((p) => p.factIds));
    const sources = citations(c.profile, ids);
    sources.push({ type: "exploration_recipes", label: "Authored work-sample hypotheses; not employer requirements or market evidence", as_of: VERSION });
    const plan = paths.slice(0, 2).map((p) => ({ action: `Test ${p.title}: ${p.sample}`, timeframe: "one short session this week" }));
    plan.push({ action: "Compare the work samples for interest and difficulty, then verify one employer posting's requirements", timeframe: "after both samples" });
    const text = ["Two plausible paths to test; the record supports hypotheses, not a qualification verdict.", ...paths.slice(0, 2).map((p) => `${p.title}: ${p.why}; try ${p.sample}.`), `Location scope: ${scope.locations.join(" / ") || "not stated"}${scope.remoteOnly ? "; remote only" : ""}; no local demand ranking is known.`, openings.openings.length ? `Verified source observations: ${openings.openings.length} matching opening(s) for review; eligibility remains unknown.` : "Current openings are unverified: no fresh matching source observation is available; fixture jobs are excluded.", "Which work sample would you like to try first?"].join("\n");
    return { ok: true, kind: "plan_paths", text, paths, deterministicVerdict: null, factIds: ids, sources, as_of: VERSION, basis: { source_class: "confirmed profile facts plus authored exploration recipes", as_of: VERSION, as_of_covers: "recipe revision only; user facts and openings retain their own timestamps" }, locationScope: scope, currentOpenings: openings, experiment: { task: `Try two work samples: ${paths.slice(0, 2).map((p) => p.sample).join("; then ")}`, discriminates: paths.slice(0, 2).map((p) => p.id), cost: "time only; no purchase required" }, plan, action_plan: plan, unknowns: ["Which role fits your interests, seniority and actual employer requirements remains unknown.", ...scope.unknowns], nextStep: "Which work sample would you like to try first?" };
  }
  function quantEvidence(ctx) {
    const facts = confirmed(ctx.profile).filter(usable).filter((f) => ["education", "project", "experience"].includes(f.kind));
    return { factIds: facts.map(factId), sources: citations(ctx.profile, facts.map(factId)), text: facts.length ? `Your confirmed record contains ${facts.slice(0, 3).map((f) => `[${factId(f)}] ${label(f.title || f.kind)}`).join("; ")}; those facts alone do not establish research readiness or trading temperament.` : "No confirmed education, coding or project evidence is available; research readiness and trading temperament cannot be inferred from missing evidence." };
  }
  function skillGapPlan(ctx) {
    const c = ctx || {}, p = c.profile || {}, skill = str(c.skill).trim();
    const posting = c.posting || null;
    if (!skill && !list(posting && posting.requirements).length) {
      const paths = roleHypotheses(c).slice(0, 2);
      const gaps = paths.flatMap((r) => r.gaps.map((g) => ({ ...g, role: r.title, level: "unknown", basis: "exploration_recipe_not_employer_requirement" })));
      const ids = unique(gaps.flatMap((g) => g.factIds));
      const plan = [
        { action: "Choose one role hypothesis and obtain its exact posting requirements", timeframe: "this week" },
        { action: "Build a fictional work sample for one missing-evidence task", timeframe: "one short session this week" },
        { action: "Ask a practitioner to review the sample and update confirmed facts only after review", timeframe: "after the sample" },
      ];
      const minutes = Number.isFinite(c.hoursPerWeek) && c.hoursPerWeek > 0 ? Math.floor(c.hoursPerWeek * 60) : null;
      const phases = minutes === null ? [] : plan.map((p, i) => ({ task: p.action, minutes: i < 2 ? Math.floor(minutes / 3) : minutes - 2 * Math.floor(minutes / 3) }));
      const text = ["These are work-sample gaps for role hypotheses; employer requirements remain unknown.", ...(minutes === null ? [] : [`Budget: ${minutes} total minutes per week across the three steps.`]), ...paths.map((r) => `${r.title}: ${r.gaps.map((g) => `${g.skill} — ${g.status}${g.factIds.length ? ` [${g.factIds.join(", ")}]` : ""}`).join("; ")}; try ${r.sample}.`), "Missing evidence does not prove a lack of ability; no skill is added to your profile.", "What exact posting task should the work sample demonstrate?"].join("\n");
      return { ok: true, kind: "skill_gap_plan", text, gaps, factIds: ids, totalMinutesPerWeek: minutes, phases, alreadyHasSkill: false, requirementLevel: "unknown", sources: [...citations(p, ids), { type: "exploration_recipes", label: "Work-sample hypotheses, not employer requirements", as_of: VERSION }], basis: { source_class: "confirmed evidence plus explicitly hypothetical work-sample tasks", as_of: VERSION }, as_of: VERSION, plan, unknowns: ["The target employer requirements and screening weight are unknown."], nextStep: "What exact posting task should the work sample demonstrate?" };
    }
    let gaps = requirementGaps(p, posting);
    if (skill && !gaps.some((g) => g.skill.toLowerCase() === skill.toLowerCase())) gaps.push({ skill, level: ["required", "preferred", "preferred_not_required"].includes(c.requirementLevel) ? c.requirementLevel : "unknown", quote: null, source: { type: "caller_supplied_requirement", verified: false }, ...evidence(p, skill) });
    const target = gaps.find((g) => g.skill.toLowerCase() === skill.toLowerCase()) || gaps[0];
    const chosen = target ? target.skill : "a skill from a specific posting";
    const hours = Number.isFinite(Number(c.hoursPerWeek)) && Number(c.hoursPerWeek) > 0 ? Math.min(Number(c.hoursPerWeek), 40) : 2;
    const minutes = Math.floor(hours * 60), a = Math.floor(minutes / 3), b = Math.floor(minutes / 3);
    const technical = /\b(python|sql|go|java|javascript|typescript|testing|version control|react|c\+\+)\b/i.test(chosen);
    const artifact = technical ? `a small ${chosen} exercise with README, runnable tests and an explanation of limitations` : `a fictional ${chosen} work sample with a checklist, assumptions and a written review`;
    const phases = [{ id: "learn-basics", task: `Review the exact ${chosen} task and one relevant learning source`, minutes: a }, { id: "build-artifact", task: `Build ${artifact}`, minutes: b }, { id: "document-review", task: "Ask a practitioner to review the sample against the task checklist", minutes: minutes - a - b }];
    const alreadyHasSkill = !!target && target.status === "evidence_present";
    const level = target ? target.level : "unknown";
    const text = [`${chosen}: ${target ? `${target.status} [${target.factIds.join(", ") || "no supporting fact"}]` : "no posting requirement was supplied"}.`, `Requirement level: ${level === "preferred_not_required" || level === "preferred" ? "preferred, not required (as supplied)" : level}; missing evidence is not proof that you lack the skill.`, `Build ${artifact} inside ${hours} hours per week, then get a practitioner review; completion supplies a sample, not employer approval.`, "What exact posting task should the work sample demonstrate?"].join("\n");
    const ids = unique(gaps.flatMap((g) => g.factIds));
    return { ok: true, kind: "skill_gap_plan", text, gaps, alreadyHasSkill, requirementLevel: level, factIds: ids, sources: [...citations(p, ids), { type: "supplied_requirement", label: posting ? `Posting ${posting.id || "supplied"}; requirement wording supplied by caller` : "Caller-supplied skill; employer requirement unverified", url: posting && (posting.source_url || posting.url) || null, as_of: posting && posting.observed_at || null }], basis: { source_class: "confirmed evidence and supplied requirements; no invented employer screen", as_of: VERSION }, as_of: VERSION, artifact, phases, totalMinutesPerWeek: minutes, plan: phases.map((x) => ({ action: x.task, timeframe: `${x.minutes} minutes per week` })), reviewMethod: "Practitioner review against the stated task checklist.", stoppingCondition: "Stop when the sample and its checklist are reviewed; keep employer eligibility unknown until verified.", unknowns: ["Employer screening weight and unstated requirements are unknown.", ...(!target ? ["The target skill and requirement level are unknown."] : [])], nextStep: "What exact posting task should the work sample demonstrate?" };
  }
  // Non-mutating adapter: extraction never confirms a resume or changes the
  // caller's profile. The host must collect explicit fact confirmations.
  function ingestResume(ctx, input) {
    const P = typeof CareerProfile !== "undefined" ? CareerProfile : require("./122-career-profile.js");
    const existing = JSON.parse(JSON.stringify((ctx || {}).profile || {}));
    const existingFacts = list(existing.facts);
    if (existingFacts.some((f) => !f || !factId(f) || f.id && f.fact_id && f.id !== f.fact_id)) return { ok: false, code: "canonical_id_required", profile: existing, confirmationRequired: true, unknowns: ["Existing fact IDs must be canonical and unambiguous before ingestion."] };
    for (const f of existingFacts) if (!f.id) f.id = f.fact_id;
    const profile = { ...existing, ...P.createProfile(existing) };
    const result = P.ingestResume(profile, input, { now: (ctx || {}).now || null });
    return { ...result, profile, confirmationRequired: true, recommendations: planPaths({ ...(ctx || {}), profile }) };
  }
  function intentFor(text) {
    const t = str(text).toLowerCase();
    // Combine repair (2026-10-15): tailor/packet asks belong to the tailor and
    // discovery branches (the SC-111 + named-target contracts in 142) — the
    // read-only exclusion mirrors the existing apply/email/watch exclusions,
    // and a bare resume x role co-occurrence no longer claims resume_roles
    // without a recommendation signal (fit/recommend/suit/qualified/match).
    if (/\b(apply|submit|send|email|watch|watches|watching|alerts?|pause|stop|delete|tailor|tailored|packet)\b/.test(t)) return null;
    // LF-02 (v223 live regression, lane A): a question about the user's OWN
    // tracked applications — their status, what is out, the pipeline — is
    // tracker state, never a current-openings recommendation. The probe
    // "What job applications do I have out right now, and what is their
    // status?" matched the current_openings branch on "job" + "right now"
    // and the tracker never saw the turn (receipt intent proved it).
    // First-person possession of applications + a state word (status /
    // out / pipeline / tracker) excludes the turn here so 142's tracker
    // family owns it; a genuine openings ask carries no such possession.
    if (/\btracker\b|\bmy pipeline\b|\bmy applications?\b[^.?!]*\b(status|stage|state|out|open|pending|progress)\b|\bapplications?\b[^.?!]*\bdo i have out\b|\bhave out\b[^.?!]*\b(applications?|apps?)\b|\bstatus of my\b[^.?!]*\bapplications?\b/.test(t)) return null;
    if (/\b(skill gaps?|missing skills?)\b/.test(t)) return "skill_gaps";
    if (/\b(current|fresh|live|today|right now)\b/.test(t) && /\b(openings?|jobs?|roles?|hiring)\b/.test(t)) return "current_openings";
    if (/\b(resume|résumé|cv|background|profile)\b/.test(t) && /\b(fit|recommend|recommendations?|suit|suited|qualified|match)\b/.test(t)) return "resume_roles";
    if (/\b(what|which)\b[^?]*\b(roles?|jobs?|careers?)\b[^?]*\b(fit|suit|recommend|qualified)\b|\brecommend\b[^?]*\b(roles?|jobs?|careers?)\b/.test(t)) return "resume_roles";
    if (/\b(where should i (work|look)|which (cities|locations)|location recommendations?)\b/.test(t)) return "locations";
    return null;
  }
  // Conservative local extraction for explicit, simple conversation fields.
  // The host may supply validated typed fields; conflicting/multiple values
  // require clarification rather than a generic target or silent budget.
  function extractQuery(text, ctx) {
    const c = ctx || {}, t = str(text), ambiguities = [], typed = {};
    const m = t.match(/\b(?:what|which)\s+(.{1,80}?)\s+skill gaps?\b/i)
      || t.match(/\bskill gaps?\s+(?:in|for)\s+([^?;.]{1,80})/i)
      || t.match(/\b(?:the|my)\s+([^?;.]{1,60}?)\s+skill gaps?\b/i)
      || t.match(/\b(?:recommend|close|assess|identify)\s+(?:(?:the|my)\s+)?([^?;.]{1,60}?)\s+skill gaps?\b/i);
    const named = m ? m[1].trim() : "";
    if (named && /\band\b|\bor\b|[,/]/i.test(named)) ambiguities.push("multiple_target_skills");
    else if (named && c.skill && str(c.skill).toLowerCase() !== named.toLowerCase()) ambiguities.push("conflicting_target_skills");
    else if (c.skill || named) typed.skill = str(c.skill || named);
    const nums = { zero: 0, half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const budgets = [...t.matchAll(/\b(\d+(?:\.\d+)?|zero|half|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:an?\s+)?(hours?|hrs?|minutes?|mins?)\s*(?:(?:per|a|each|\/)\s*week|weekly)\b/gi)].map((x) => (nums[x[1].toLowerCase()] ?? Number(x[1])) / (/^(min)/i.test(x[2]) ? 60 : 1));
    if (!budgets.length && c.hoursPerWeek === undefined && /\b(hours?|hrs?|minutes?|mins?)\b[^?.;]{0,25}\b(week|weekly)\b/i.test(t)) ambiguities.push("unparsed_weekly_budget");
    if (new Set(budgets).size > 1) ambiguities.push("multiple_weekly_budgets");
    const hours = c.hoursPerWeek !== undefined ? Number(c.hoursPerWeek) : budgets[0];
    if (hours !== undefined) {
      if (!Number.isFinite(hours) || hours <= 0 || hours > 40) ambiguities.push("invalid_weekly_budget");
      else if (budgets.length && c.hoursPerWeek !== undefined && budgets[0] !== hours) ambiguities.push("conflicting_weekly_budgets");
      else typed.hoursPerWeek = hours;
    }
    if (c.targetRole) typed.targetRole = str(c.targetRole);
    if (c.posting_id) typed.posting_id = str(c.posting_id);
    return { typed, ambiguities, source: "explicit_user_query_or_validated_host_fields" };
  }
  function recommend(ctx) {
    const query = extractQuery((ctx || {}).text, ctx);
    const c = { ...(ctx || {}), ...query.typed };
    if (query.ambiguities.length) return { ok: false, kind: "recommendation_clarification", query, unknowns: query.ambiguities, text: "Which single skill and weekly time budget should I use?", nextStep: "Which single skill and weekly time budget should I use?" };
    if (c.recommendationIntent === "skill_gaps") return attachGrounding(skillGapPlan(c), c, query);
    const out = planPaths(c);
    if (c.recommendationIntent === "current_openings") {
      out.kind = "current_openings";
      out.sources.push(...out.currentOpenings.openings.map((o) => ({ type: "public_posting_observation", label: o.title, url: o.source.url, as_of: o.source.observed_at })));
      out.text = out.currentOpenings.openings.length ? out.currentOpenings.openings.slice(0, 5).map((o) => `${o.title} — ${o.company || "employer unspecified"}: source ${o.source.url}, observed ${o.source.observed_at}; record signals [${o.factIds.join(", ")}]; eligibility unknown; ${o.gaps.filter((g) => g.status !== "evidence_present").map((g) => `${g.skill}: ${g.status} (${g.level})`).join("; ") || "requirements still need review"}.`).join("\n") : "Current openings are unverified: no fresh matching public source observation is available; fixture and stale jobs are excluded.";
      out.text += "\nWhich employer source and preferred work location should we check next?";
      out.nextStep = "Which employer source and preferred work location should we check next?";
    }
    if (c.recommendationIntent === "locations") {
      out.kind = "location_recommendations";
      out.text = `Location scope: ${out.locationScope.locations.join(" / ") || "not stated"}${out.locationScope.remoteOnly ? "; remote only" : ""}. Preferences guide the search; no evidence supports ranking cities by demand or pay. Remote hiring geography and work authorization remain employer-specific.\nWhich work locations and relocation limits should I use?`;
      out.nextStep = "Which work locations and relocation limits should I use?";
    }
    return attachGrounding(out, c, query);
  }
  function attachGrounding(out, ctx, query) {
    out.query = query;
    const gaps = [...list(out.gaps), ...list(out.paths).flatMap((p) => list(p.gaps)), ...list(out.currentOpenings && out.currentOpenings.openings).flatMap((p) => list(p.gaps))];
    out.grounding = { schema_version: 1, profile_revision: ctx.profile_revision ?? null, privacy_epoch: ctx.privacy_epoch ?? null,
      fact_ids: list(out.factIds), sources: list(out.sources), supporting_relations: [...gaps.flatMap((g) => list(g.supportingRelations)), ...list(out.paths).flatMap((p) => list(p.supportingRelations))], conflicts: gaps.flatMap((g) => list(g.conflicts)),
      posting_observations: out.currentOpenings || null, unknowns: list(out.unknowns) };
    return out;
  }
  return { confirmed, evidence, citations, relations, latestObservations, extractQuery, roleHypotheses, locationScope, freshness, requirementGaps, openingRecommendations, planPaths, quantEvidence, skillGapPlan, ingestResume, intentFor, recommend };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerRecommendations;
