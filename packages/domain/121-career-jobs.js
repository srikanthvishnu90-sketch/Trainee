/* Career job discovery + fit scoring (DISC-003..008; Doc 2 section 2 + Appendix B.2).
   Pure domain module, UMD like the other domain modules. Fetch is INJECTED (opts.fetch) so tests run
   offline on recorded-shape fixtures and the proof script (scripts/career/proof-jobs.mjs) runs the
   same code path against the REAL public ATS feeds. No deploy, no secrets: these are public,
   no-login JSON endpoints (Doc 2 Appendix A.2: Greenhouse/Lever/Ashby/SmartRecruiters = public feeds).

   Normalized posting: { job_id, company, title, role_family, seniority_band, location, remote, url,
                         posted_at, jd_text, source, sources, source_urls, department, req_id }
   job_id is stable: source+company+req id when the feed gives one, else an FNV-1a hash of the URL.

   Functions:
     feeds.greenhouse(token) / lever(company) / ashby(name) / smartrecruiters(company)
                                   feed descriptors { source, company_token, url } for Appendix B.2 endpoints
     fetchFeed(feed, {fetch})      one feed -> { status, url, postings, error? } (never throws on HTTP error)
     fetchAll(feeds, {fetch})      many feeds -> { postings (deduped), feeds: [per-feed results] }
     normalize* (per ATS)          raw feed JSON -> normalized postings
     dedupe(postings)              company + normalized title + location (+ req id when both sides have one)
     diffNew(current, prior)       DISC-004: only genuinely new job_ids vs a prior snapshot
     poll(feeds, {fetch, store, snapshotKey, now})
                                   fetch + dedupe + diff against the injectable KV snapshot store, save the
                                   new snapshot (+ repost history), return { postings, new_postings, feeds }
     qualityFlags(posting, {now, repost_count})   DISC-008 ghost/quality flags with plain-language reasons
     scoreFit(posting, profile, cir?)              DISC-005: hard filters first (a hard fail is EXCLUDED with
                                   the reason, never scored), then soft score 0-100 with reasons + gaps and a
                                   Reach/Match/Safety bucket (optional CIR bar; absent -> neutral bar 60)
     detectRestrictions(posting) / evaluateRestrictions(posting, profile)
                                   APD-2: structured restriction flags (state_residency, location_radius,
                                   work_authorization, clearance) with dispositions; unknown deciding facts
                                   become needs_user_input ask flags, never silent passes
     detectAiAuthorshipBan(posting) / applicationPrepFor(posting)
                                   APD-5: employer AI-authorship ban flag + the prep constraint it imposes
     sourceHealth(feedResults)     SHD-1 (data half): per-source queried/failed + degraded/outcome marker,
                                   also attached to fetchAll/poll results as `source_health`
     buildShortlist(scored, {limit, feedback})     DISC-006: top-N per day; yes/no feedback memory (injected
                                   store rows) nudges later scores by role_family / company / skills
     recordFeedback(store, entry)  append a yes/no row to the injected feedback store
     askRoleFamilies(text)         the role families an ASK names (PM/SWE/Data/ML/Finance/...), parsed
                                   from the ask text itself — abbreviations included (PM, SWE)
     buildShortlist(scored, {askText | families})
                                   DISC-006 domain leg (SC-065, census class (c)): when the ask names
                                   role families, the shortlist is HARD-filtered to those families
                                   BEFORE the limit applies, and the returned array carries
                                   family_filter { requested, pool_size, matched_size,
                                   dropped_cross_family }. Cross-family roles are NEVER used as
                                   padding: an ask whose family is absent from the pool returns
                                   an empty shortlist, not the best-scoring wrong-domain roles.
     shortlistForAsk(scored, askText, opts)
                                   typed wrapper over buildShortlist: { status: "ok" |
                                   "no_matching_roles" | "no_family_in_ask", requested_families,
                                   pool_size, matched_size, shortlist, reason, next_step } — on
                                   no_matching_roles, reason states the true pool fact and
                                   next_step carries exactly one next step.
     scoreFit(posting, profile, cir, { askFamilies })
                                   opt-in: a posting outside the ask's families is EXCLUDED with a
                                   role-family reason (same hard-filter channel as the other
                                   exclusions). No existing caller passes it, so default scoring
                                   is unchanged.
   Role families are SWE + Finance first (owner ruling 2026-10-12): STARTER_FEEDS weights banks, trading
   firms, fintechs and big-tech SWE boards. Poll cadence per Doc 1/2 Appendix B speed rules: starred
   companies every 15 min, the rest hourly (POLL_MINUTES) — detection, not scheduling, lives here. */
const CareerJobs = (() => {
  const DAY = 86400000;
  const POLL_MINUTES = { starred: 15, default: 60 };
  const NEUTRAL_BAR = 60;

  // ---------- helpers ----------
  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();
  function hash(str) { // FNV-1a 32-bit, deterministic across runs/machines
    let h = 0x811c9dc5;
    const t = s(str);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }
  function stripHtml(html) {
    return s(html).replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  const normName = (v) => lc(v).replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\b(inc|llc|ltd|corp|corporation|company|co|the)\b/g, " ").replace(/\s+/g, " ").trim();
  const normTitle = (v) => lc(v).replace(/[^a-z0-9 ]/g, " ").replace(/\b(senior|sr|junior|jr|lead|staff|principal|i|ii|iii|iv)\b/g, " ").replace(/\s+/g, " ").trim();
  const normLoc = (v) => lc(v).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().replace(/\bnyc\b/g, "new york").split(" ").slice(0, 3).join(" ");
  const locationIsStated = (v) => !!s(v).trim() && lc(v).trim() !== "location not stated";
  const iso = (v) => { if (!v) return null; const d = new Date(typeof v === "number" ? v : Date.parse(v)); return isNaN(d) ? null : d.toISOString(); };

  // ---------- classification ----------
  const FAMILY_RULES = [
    // BUG-051 (FV-1/FV-2/SS-1): Medicine, Law and Real Estate had NO rule at
    // all — clinical titles classified Other or SWE (via company boilerplate
    // in the JD fallback), legal titles Operations/Marketing/Other, and RE
    // titles Finance via the bare-analyst fallback. These three rules sit
    // FIRST so a decided title can never be outvoted by JD boilerplate.
    ["Medicine", /\b(nurse|nursing|medical assistant|patient care|clinical|phlebotom|medical scribe|radiologic|respiratory therapist|pharmacy technician|nurse practitioner|physician assistant|registered nurse|healthcare|health care|cna|rn)\b/],
    ["Law", /\b(paralegal|legal|law clerk|attorney|counsel|litigation|juris)\b/],
    ["Real Estate", /\b(real estate|acquisitions|asset management|leasing|brokerage|property management|multifamily|commercial real estate|mortgage|escrow)\b/],
    ["Finance", /\b(quant|trader|trading|investment bank|banking analyst|private equity|equity research|portfolio|fp&a|financial analyst|finance|accounting|audit|treasury|capital markets|wealth|risk analyst|actuar|underwrit)/],
    ["SWE", /\b(software|backend|back end|frontend|front end|full stack|fullstack|mobile|ios|android|devops|sre|site reliability|platform engineer|infrastructure|systems engineer|firmware|embedded|web developer|engineer,? software|application engineer|quality engineer|qa engineer|security engineer)/],
    ["Data/ML", /\b(data scien|machine learning|ml engineer|ai engineer|data engineer|data analyst|analytics engineer|research scien)/],
    ["PM", /\b(product manager|program manager|product management|technical program)/],
    ["Design", /\b(designer|design|ux|ui\b|user research)/],
    ["Consulting", /\b(consultant|consultancy|consulting|advisory associate|strategy associate)/],
    ["Operations", /\b(operations|business operations|bizops|supply chain|logistics)/],
    ["Marketing", /\b(marketing|growth|brand|content strateg)/],
    ["Sales", /\b(account executive|sales|business development|bd representative|sdr|bdr)\b/],
  ];
  // ---------- ask-side family parsing (SC-065 domain leg) ----------
  // The families an ASK names, in FAMILY_RULES order. Title rules alone miss
  // the abbreviations users actually type ("PM internships", "SWE roles") and
  // bare domain nouns ("data roles"), so those are matched explicitly.
  // "data entry" is operations work, not Data/ML — it suppresses the bare
  // "data" match and lands on Operations instead.
  function askRoleFamilies(text) {
    const t = lc(text);
    if (!t) return [];
    const dataEntry = /\bdata entry\b/.test(t);
    const out = [];
    for (const [fam, re] of FAMILY_RULES) {
      let hit = re.test(t);
      if (!hit && fam === "PM") hit = /\bpm\b/.test(t) || /\bproduct\s+(roles?|jobs?|internships?|positions?|openings)\b/.test(t);
      if (!hit && fam === "SWE") hit = /\bswe\b/.test(t);
      if (!hit && fam === "Data/ML") hit = (!dataEntry && /\bdata\b/.test(t)) || /\b(ai|ml)\b/.test(t);
      if (!hit && fam === "Operations" && dataEntry) hit = true;
      if (hit) out.push(fam);
    }
    return out;
  }
  function roleFamily(title, jd) {
    const t = lc(title);
    for (const [fam, re] of FAMILY_RULES) if (re.test(t)) return fam;
    // BUG-051 (SS-6): firm-identity pass. A consultancy's own declaration in
    // the JD ("global technology and management consultancy", "consulting
    // methodologies", "consulting culture") is the firm's identity and
    // outranks practice-area tokens in the generic JD fallback — the Capco
    // BA sits in a "Wealth & Asset Management" PRACTICE, but the job is at a
    // consultancy; "consultancy" also never matched /\bconsulting/ before.
    if (/\b(consultancy|management consulting|consulting firm|consulting culture|consulting methodologies)\b/.test(lc(jd).slice(0, 3000))) return "Consulting";
    const j = lc(jd).slice(0, 600);
    for (const [fam, re] of FAMILY_RULES) if (re.test(j)) return fam;
    if (/\bengineer/.test(t)) return "SWE";
    if (/\banalyst/.test(t)) return "Finance";
    return "Other";
  }
  // MUSE-F-006 (DISCO-QUALITY root cause 583cc918): band tokens were matched as exact surface words between hard
  // boundaries, so "internships", "entry-level" and "early careers" bound nothing and fell to "mid" (15/30 cells of the
  // phrase matrix). One normalizer for every site: lowercase, hyphens/slashes/dashes to spaces, and a plural band word
  // to its stem. Then one intern matcher serves the title and the JD head (they had drifted: only one knew "co-op").
  // Precedence is unchanged.
  const BAND_STEMS = new Set(["intern", "internship", "op", "grad", "graduate", "career", "program", "apprenticeship", "traineeship", "fellowship", "university"]);
  function bandText(x) {
    // Separators become ONE space ("Co / op" -> "co op"), so a spaced slash or dash still binds.
    return lc(x).replace(/\s*[-‐‑–—_/]+\s*/g, " ").replace(/\s+/g, " ").replace(/[a-z]+/g, (w) => {
      if (w.length > 3 && w.endsWith("ies") && BAND_STEMS.has(w.slice(0, -3) + "y")) return w.slice(0, -3) + "y";
      if (w.length > 2 && w.endsWith("s") && BAND_STEMS.has(w.slice(0, -1))) return w.slice(0, -1);
      return w;
    });
  }
  const INTERN_BAND = /\b(intern|internship|co op)\b/;
  // Feature 6: only the first 400 characters of the normalized JD are read below, so a long JD is normalized from its
  // first 4,000 characters when that prefix already yields whole words past position 400 (the same 400 characters as
  // normalizing it all); otherwise all of it. Normalizing whole JDs was 12% of ingest CPU (measured).
  function bandHead(jd) {
    const raw = s(jd);
    if (raw.length <= 4000) return bandText(raw);
    const h = bandText(raw.slice(0, 4000));
    return h.lastIndexOf(" ") > 401 ? h : bandText(raw);
  }
  function seniorityBand(title, jd) {
    const t = bandText(title), j = bandHead(jd);
    if (INTERN_BAND.test(t)) return "intern";
    // BUG-229 (MI-094): the seasonal-analyst internship convention — "Summer
    // Analyst" / "Summer Associate" / "Summer Business Analyst" (and the
    // winter forms) ARE the finance/consulting internship titles and carry no
    // intern token; without this they fell through to "mid" and intern-band
    // watches silently missed them (witness: Lane A seed LA-0043). The
    // analyst-track noun is required — seasonal titles without it are
    // seasonal JOBS (customer service, housekeeping), never internships. A
    // title that also names a management role ("Summer Analyst Program
    // Manager") is the manager's posting and falls through to the checks
    // below.
    if (/\b(summer|winter)\s+(business\s+)?(analyst|associate)\b/.test(t)
        && !/\b(manager|director|vp|vice president|head of|chief)\b/.test(t)) return "intern";
    if (/\b(director|vp|vice president|head of|chief)\b/.test(t)) return "director";
    if (/\bmanager\b/.test(t)) return "manager";
    if (/\b(staff|principal)\b/.test(t)) return "staff";
    if (/\b(senior|sr\.?)\b/.test(t)) return "senior";
    if (/\b(new grad|new graduate|recent graduate|early career|entry level|graduate program|rotational|university)\b/.test(t + " " + j.slice(0, 400))) return "new_grad";
    if (/\b(junior|jr\.?|associate)\b/.test(t)) return "junior";
    if (INTERN_BAND.test(j.slice(0, 300))) return "intern";
    return "mid";
  }
  function remoteOf(location, jd) {
    const t = lc(location) + " " + lc(jd).slice(0, 500);
    if (/\bhybrid\b/.test(t)) return "hybrid";
    if (/\bremote\b/.test(t)) return "remote";
    return "onsite";
  }

  // ---------- posting restrictions + employer rules (APD-2 / APD-5, gauntlet G5) ----------
  // Restrictions are computed AT TARGETING, from the posting's own text, and carried as
  // structured data on the posting record — never only as prose a composer might drop.
  // Classes: state_residency, location_radius, work_authorization, clearance, plus the
  // employer ai_authorship_ban rule (APD-5). Dispositions are decided against the
  // profile's KNOWN facts in evaluateRestrictions(): a known mismatch excludes (the
  // reason travels in data); an UNKNOWN fact for the new classes (residency / radius)
  // is never silently passed — it becomes a needs_user_input ask flag + a shortlist
  // demotion. Legacy classes (work-auth citizens-only, clearance) keep the exact
  // dispositions hardFilters has always applied, now also expressed as flags.
  const US_STATES = [["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"], ["California", "CA"], ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"], ["District of Columbia", "DC"], ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"], ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"], ["Kentucky", "KY"], ["Louisiana", "LA"], ["Maine", "ME"], ["Maryland", "MD"], ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"], ["Mississippi", "MS"], ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"], ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"], ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"], ["Oregon", "OR"], ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"], ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"], ["Vermont", "VT"], ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"], ["Wisconsin", "WI"], ["Wyoming", "WY"]];
  const _STATE_BY_NAME = new Map(US_STATES.map(([n, a]) => [n.toLowerCase(), { name: n, abbr: a }]));
  const _STATE_BY_ABBR = new Map(US_STATES.map(([n, a]) => [a, { name: n, abbr: a }]));
  // C01 (beta 2026-11-04): compiled once, not 102 times a call (once per posting per search turn); same patterns, no g flag,
  // so a .test() keeps no state between calls.
  const _STATE_RES = US_STATES.map(([name, abbr]) => [name, abbr, new RegExp(`\\b${name}\\b`, "i"), new RegExp(`,\\s*${abbr}\\b`)]);
  function statesInText(text) {
    const found = [], seen = new Set();
    const t = ` ${s(text)} `;
    for (const [name, abbr, byName, byAbbr] of _STATE_RES) {
      if (byName.test(t) || byAbbr.test(t)) {
        if (!seen.has(abbr)) { seen.add(abbr); found.push({ name, abbr }); }
      }
    }
    return found;
  }
  function postingText(posting) {
    const reqs = Array.isArray(posting && posting.requirements) ? posting.requirements.join("; ") : "";
    return [posting && posting.location, posting && posting.remote_terms, reqs, posting && posting.jd_text].filter(Boolean).join(" ");
  }
  function sentenceAround(text, re) {
    for (const sent of s(text).split(/(?<=[.;])\s+/)) if (re.test(sent)) return sent.trim().slice(0, 300);
    const m = s(text).match(re); return m ? m[0].slice(0, 300) : "";
  }
  function detectRestrictions(posting) {
    const text = postingText(posting || {});
    const out = [];
    // state residency: "Colorado residents only", "must reside in Colorado", "authorized only from Colorado"
    const resPhrases = [];
    for (const m of text.matchAll(/\b([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?) residents only\b/g)) resPhrases.push(m[1]);
    for (const m of text.matchAll(/\bresidents of ([A-Za-z ,/and]+?)(?: only| may apply| are eligible|\.|;|$)/gi)) resPhrases.push(m[1]);
    for (const m of text.matchAll(/\bmust (?:reside|live) in ([A-Za-z ,/and]+?)(?: for the entire| for | during|\.|;|,|$)/gi)) resPhrases.push(m[1]);
    for (const m of text.matchAll(/\bremote work is authorized only from ([A-Za-z ]+?)(?:\.|;|$)/gi)) resPhrases.push(m[1]);
    const resStates = [];
    for (const phrase of resPhrases) for (const st of statesInText(phrase)) if (!resStates.some((x) => x.abbr === st.abbr)) resStates.push(st);
    if (resStates.length) out.push({ type: "state_residency", states: resStates.map((x) => x.abbr), state_names: resStates.map((x) => x.name), requirement: `must reside in ${resStates.map((x) => x.name).join(" or ")}`, evidence: sentenceAround(text, /residents only|residents of|must (reside|live) in|authorized only from/i) });
    // location radius: "within 25 miles of Denver, CO"
    const rad = text.match(/\bwithin (?:a )?(\d+)[- ]miles?(?: radius)? of ([A-Za-z .,]+?)(?:\.|;|$)/i) || text.match(/\bwithin (?:a )?(\d+)[- ]mile radius of ([A-Za-z .,]+?)(?:\.|;|$)/i);
    if (rad) {
      const center = rad[2].trim();
      const cStates = statesInText(center);
      out.push({ type: "location_radius", miles: Number(rad[1]), center, center_states: cStates.map((x) => x.abbr), requirement: `must live within ${rad[1]} miles of ${center}`, evidence: sentenceAround(text, /within (?:a )?\d+[- ]miles?/i) });
    }
    // work authorization (peer class; same phrases hardFilters has always used)
    if (/\b(u\.?s\.? citizens? only|must be a u\.?s\.? citizen|requires? u\.?s\.? citizenship|us citizenship required)\b/i.test(text))
      out.push({ type: "work_authorization", detail: "us_citizens_only", requirement: "US citizenship required", evidence: sentenceAround(text, /citizens? only|citizenship/i) });
    else if (/\b(no sponsorship|will not sponsor|cannot sponsor|unable to sponsor|without sponsorship|does not offer sponsorship)\b/i.test(text))
      out.push({ type: "work_authorization", detail: "no_sponsorship", requirement: "no sponsorship offered", evidence: sentenceAround(text, /sponsor/i) });
    // clearance (peer class)
    const clr = text.match(/\b(ts\/sci|top secret|secret clearance|security clearance)\b/i);
    if (clr) out.push({ type: "clearance", detail: lc(clr[1]), requirement: `requires a security clearance (${clr[1]})`, evidence: sentenceAround(text, /clearance|ts\/sci|top secret/i) });
    return out;
  }
  // APD-5: an employer's ban on AI-authored application responses. Detection requires an
  // authorship/prohibition signal in an application context — a malicious instruction in
  // a JD (AP15) or a generic "we use AI" line is NOT a ban and must not flag.
  function detectAiAuthorshipBan(posting) {
    const text = postingText(posting || {});
    const sentences = s(text).split(/(?<=[.;])\s+/);
    for (const sent of sentences) {
      const aiAuthored = /ai[- ](authored|generated|written)/i.test(sent);
      const mustOwnWords = /applicants must write|must write all application answers themselves|write .* in (their|your) own words/i.test(sent) && /application|answers/i.test(sent);
      const aiToolBan = /\b(chatgpt|generative ai|large language models?|llms?)\b/i.test(sent) && /prohibit|banned|not (allowed|permitted)|forbidden/i.test(sent);
      const prohibited = /prohibit|banned|not (allowed|permitted)|forbidden|grounds for rejection/i.test(sent);
      if ((aiAuthored && prohibited) || mustOwnWords || aiToolBan) {
        return { banned: true, type: "ai_authorship_ban", scope: "application_responses", evidence: sent.trim().slice(0, 300), consequence: /grounds for rejection/i.test(sent) ? "grounds for rejection" : null };
      }
    }
    return null;
  }
  function profileResidence(profile) {
    const p = profile || {};
    const text = s(p.residence || (p.basics && p.basics.location) || p.current_location || (p.constraints && (p.constraints.residence || p.constraints.residence_location)) || "");
    // The primary segment ("Chicago, IL" in "Chicago, IL — studying; preference Austin")
    // is the residence; later segments name preferences, not where the candidate lives.
    const primary = text.split(/[(—;]/)[0];
    const primaryStates = statesInText(primary);
    return { text, states: primaryStates.length ? primaryStates : statesInText(text) };
  }
  function evaluateRestrictions(posting, profile) {
    const restrictions = detectRestrictions(posting);
    const c = (profile && profile.constraints) || {};
    const residence = profileResidence(profile);
    const exclusion_reasons = [], needs_user_input = [];
    for (const r of restrictions) {
      if (r.type === "state_residency") {
        const names = r.state_names.join(" or ");
        if (residence.states.length) {
          if (residence.states.some((st) => r.states.includes(st.abbr))) r.disposition = "satisfied";
          else { r.disposition = "excluded"; exclusion_reasons.push(`state residency: posting is limited to ${names} residents; your profile residence is ${residence.text || residence.states.map((x) => x.name).join(", ")}`); }
        } else {
          r.disposition = "needs_user_input";
          needs_user_input.push({ type: "state_residency", missing_fact: "residence_state", restriction: r, question: `Do you currently reside in ${names}? This posting is limited to ${names} residents, and your profile does not state where you reside.`, reason: `state residency restriction (${names} residents only) cannot be checked: no residence on your profile` });
        }
      } else if (r.type === "location_radius") {
        if (residence.text) {
          if (lc(residence.text).includes(lc(r.center.split(",")[0].trim()))) r.disposition = "satisfied";
          else if (r.center_states.length && residence.states.length && !residence.states.some((st) => r.center_states.includes(st.abbr))) { r.disposition = "excluded"; exclusion_reasons.push(`location radius: posting requires living within ${r.miles} miles of ${r.center}; your profile residence is ${residence.text}`); }
          else { r.disposition = "needs_user_input"; needs_user_input.push({ type: "location_radius", missing_fact: "distance_to_center", restriction: r, question: `Do you live within ${r.miles} miles of ${r.center}? This posting requires it, and your profile location is not precise enough to check.`, reason: `location radius (${r.miles} miles of ${r.center}) cannot be verified from your profile location` }); }
        } else {
          r.disposition = "needs_user_input";
          needs_user_input.push({ type: "location_radius", missing_fact: "residence_location", restriction: r, question: `Do you live within ${r.miles} miles of ${r.center}? This posting requires it, and your profile does not state where you reside.`, reason: `location radius (${r.miles} miles of ${r.center}) cannot be checked: no residence on your profile` });
        }
      } else if (r.type === "work_authorization") {
        const wa = s(c.work_authorization), needs = c.needs_sponsorship;
        if (r.detail === "us_citizens_only") {
          if (/citizen/i.test(wa) && !needs) r.disposition = "satisfied";
          else r.disposition = "excluded"; // legacy hardFilters disposition: unknown is not a citizen on record
        } else { // no_sponsorship
          if (needs === true || /sponsor/i.test(wa)) r.disposition = "excluded";
          else if (needs === false || wa) r.disposition = "satisfied";
          else { r.disposition = "needs_user_input"; needs_user_input.push({ type: "work_authorization", missing_fact: "needs_sponsorship", restriction: r, question: "This posting offers no sponsorship. Do you need sponsorship to work for this employer?", reason: "no-sponsorship restriction cannot be checked: your profile does not state whether you need sponsorship" }); }
        }
      } else if (r.type === "clearance") {
        r.disposition = (c.clearance && !/none|no\b/i.test(s(c.clearance))) ? "satisfied" : "excluded"; // legacy: none recorded = none held
      }
    }
    return { restrictions, excluded: restrictions.some((r) => r.disposition === "excluded"), exclusion_reasons, needs_user_input, unresolved: needs_user_input.length > 0 };
  }
  // ---------- hard knockouts (BUG-050; FV-7 / SS-4 / SS-5) ----------
  // Eligibility never read the JD's own knockout lines: a license, a named
  // certification, a conferred degree, or a stated minimum of years. An
  // unlicensed nursing student was judged "submit" for RN-licensed roles, a
  // pre-law undergraduate for a JD-required role, an unlicensed persona for a
  // Texas real-estate-license role, and a zero-experience student for a
  // "Minimum 5 years" role. detectKnockouts extracts those requirements from
  // the posting's own sentences as structured data (carried on the posting,
  // like APD-2 restrictions); evaluateKnockouts compares them against the
  // candidate's CONFIRMED facts only — an in-progress credential never
  // satisfies a completed-credential requirement, and target roles the user
  // merely wants (preferences.roles) are not credentials.
  const KNOCKOUT_FILLER = new Set(["active", "unrestricted", "current", "valid", "compact", "multistate", "state", "additional", "the", "a", "an", "in", "of", "or", "and", "required", "unexpired"]);
  function knockoutSentences(text) {
    return s(text).split(/(?<=[.;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  }
  function credentialTokens(phraseWords) {
    return phraseWords.filter((w) => w && !KNOCKOUT_FILLER.has(w));
  }
  function detectKnockouts(posting) {
    const out = [];
    const seen = new Set();
    const push = (ko) => { const k = `${ko.type}|${ko.credential || ko.level || ko.min_years}`; if (!seen.has(k)) { seen.add(k); out.push(ko); } };
    for (const rawSent of knockoutSentences(posting && posting.jd_text)) {
      const sent = lc(rawSent);
      // license / licensure
      // Feature 6: each pattern below scans every position of the sentence with a lazy 45-character window (41% of
      // ingest CPU, measured); it can only match where its keyword stands, so it runs only then (same result).
      const lic = sent.includes("licen") ? sent.match(/([a-z][a-z&' -]{0,44}?)\s(licen[cs]e|licensure)\b/) : null;
      if (lic && /(active|unrestricted|current|valid|must|required|hold|maintain|possess|eligib|requirements?\s*:)/.test(sent)) {
        const words = lic[1].replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).slice(-4);
        const tokens = credentialTokens(words);
        if (tokens.length) push({ type: "license", credential: `${tokens.join(" ")} license`, tokens, requirement: `a ${tokens.join(" ")} license`, evidence: rawSent.slice(0, 220) });
      }
      // named certification (e.g. "Medical Assistant Certification" under a Requirements heading)
      const cert = sent.includes("certific") ? sent.match(/([a-z][a-z&' -]{0,44}?)\s(certification|certificate)\b/) : null;
      if (cert && /(requirements?\s*:|required|must (hold|have|possess|maintain|be)|certification\s*$|certification\s+\d)/.test(sent) && !/degree|bachelor|master/.test(sent)) {
        const words = cert[1].replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).slice(-3);
        const tokens = credentialTokens(words);
        if (tokens.length >= 2) push({ type: "certification", credential: `${tokens.join(" ")} certification`, tokens, requirement: `a ${tokens.join(" ")} certification`, evidence: rawSent.slice(0, 220) });
      }
      // degree knockouts: a named professional degree, or a degree line that says required.
      if (/\bjd\b/.test(sent) && /(law school|juris|from a|degree)/.test(sent)) push({ type: "degree", level: "jd", requirement: "a JD (Juris Doctor) degree", evidence: rawSent.slice(0, 220) });
      else if (/\bdegree\b/.test(sent) && /(required|must (hold|have|possess)|is required)/.test(sent) && !/(graduating|pursuing|currently enrolled|rising (senior|junior|sophomore)|students? (currently|pursuing|enrolled))/.test(sent)) {
        // A degree the same sentence says the candidate is still pursuing /
        // graduating into (intern postings: "Bachelor's degree … Must be
        // graduating in 2028") is an enrollment requirement, NOT a
        // conferred-degree knockout.
        const level = /master/.test(sent) ? "master" : /associate/.test(sent) ? "associate" : "bachelor";
        push({ type: "degree", level, requirement: level === "bachelor" ? "a conferred bachelor's (four-year) degree" : `a conferred ${level}'s degree`, evidence: rawSent.slice(0, 220) });
      }
      // minimum years of experience (explicit requirement phrasings only)
      const ym = sent.match(/(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d+)(?:\s*[-–]\s*\d+)?\s*\+?\s*years?\b[^.;]{0,40}?experience/)
        || sent.match(/(\d+)\s*\+\s*years?\s+of\s+[^.;]{0,90}?experience/)
        || sent.match(/(\d+)\s*[-–]\s*\d+\s*years?\s+of\s+[^.;]{0,60}?experience/);
      if (ym) push({ type: "min_experience", min_years: Number(ym[1]), requirement: `at least ${ym[1]} years of experience`, evidence: rawSent.slice(0, 220) });
    }
    return out;
  }
  function factCorpusText(f) { return lc(`${(f && f.title) || ""} ${(f && f.text) || ""} ${((f && f.bullets) || []).join(" ")}`); }
  function factInProgress(f) { return /in progress|in-progress|pursuing|expected|graduating|enrolled|rising/i.test(factCorpusText(f)); }
  function evidencedFullTimeYears(profile) {
    if (profile && typeof profile.experience_years === "number") return profile.experience_years;
    const facts = (profile && profile.facts) || null;
    if (!Array.isArray(facts)) return null; // unknown: a minimum-years knockout cannot be decided, so it does not fire
    let months = 0;
    const now = new Date();
    const nowMonths = now.getFullYear() * 12 + now.getMonth();
    for (const f of facts) {
      if (!f || f.kind !== "experience" || f.needs_confirmation) continue;
      if (/\b(intern|internship|extern|volunteer)\b/i.test(s(f.title))) continue; // knockouts ask FULL-TIME professional years
      const sm = s(f.start).match(/(\d{4})-(\d{2})/), em = s(f.end).match(/(\d{4})-(\d{2})/);
      if (!sm) continue;
      const startM = Number(sm[1]) * 12 + Number(sm[2]);
      const endM = em ? Number(em[1]) * 12 + Number(em[2]) : (/present/i.test(s(f.end)) ? nowMonths : startM);
      if (endM > startM) months += endM - startM;
    }
    return Math.round((months / 12) * 10) / 10;
  }
  function credentialSatisfied(ko, profile) {
    const facts = ((profile && profile.facts) || []).filter((f) => f && !f.needs_confirmation);
    const certFacts = facts.filter((f) => f.kind === "certification" && !factInProgress(f));
    const hasAll = (text) => ko.tokens.every((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    for (const f of certFacts) if (hasAll(factCorpusText(f))) return true;
    const phrase = ko.tokens.join(" ");
    for (const f of facts) {
      if (factInProgress(f)) continue;
      const text = factCorpusText(f);
      if (ko.tokens.length >= 2 && text.includes(phrase)) return true;
      if (ko.tokens.length === 1 && new RegExp(`\\b${ko.tokens[0]}\\b`).test(text) && /licen[cs]e|licensed|registered|certified/.test(text)) return true;
    }
    // 121-shape profiles: proven skill names + degree string can evidence a credential.
    const skillNames = profileSkills(profile).filter((x) => x.proven).map((x) => lc(x.name));
    if (skillNames.some((n) => hasAll(` ${n} `))) return true;
    return false;
  }
  function degreeSatisfied(ko, profile) {
    const facts = ((profile && profile.facts) || []).filter((f) => f && !f.needs_confirmation);
    const markers = { jd: /juris doctor|\bjd\b/, bachelor: /bachelor|b\.?s\.?\b|b\.?a\.?\b|four-year|undergraduate degree/, master: /master|m\.?s\.?\b|m\.?a\.?\b|ph\.?d/, associate: /associate/ };
    const marker = markers[ko.level] || markers.bachelor;
    const nowYM = (() => { const d = new Date(); return d.getFullYear() * 100 + (d.getMonth() + 1); })();
    for (const f of facts) {
      if (f.kind !== "education" && f.kind !== "certification") continue;
      if (!marker.test(factCorpusText(f))) continue;
      if (factInProgress(f)) continue; // an in-progress degree is not a conferred degree
      const em = s(f.end).match(/(\d{4})-(\d{2})/);
      if (em && Number(em[1]) * 100 + Number(em[2]) > nowYM) continue; // confers in the future
      return true;
    }
    // 121-shape profiles: profile.degree + a KNOWN graduation year decide conferral.
    const c = (profile && profile.constraints) || {};
    const degText = lc(profile && (profile.degree || c.degree || ""));
    if (degText && marker.test(degText)) {
      const gy = c.graduation_year || (c.graduation_date ? Number(s(c.graduation_date).slice(0, 4)) : null);
      if (!gy || gy <= new Date().getFullYear()) return true;
    }
    return false;
  }
  function evaluateKnockouts(posting, profile) {
    const knockouts = (posting && posting.knockouts) || detectKnockouts(posting || {});
    const unmet = [];
    for (const ko of knockouts) {
      if (ko.type === "license" || ko.type === "certification") {
        if (!credentialSatisfied(ko, profile || {})) unmet.push({ knockout: ko, reason: `credential knockout: posting requires ${ko.requirement}; no confirmed fact on your profile evidences that ${ko.type} (an in-progress or different credential does not satisfy it)` });
      } else if (ko.type === "degree") {
        if (!degreeSatisfied(ko, profile || {})) unmet.push({ knockout: ko, reason: `degree knockout: posting requires ${ko.requirement}; your confirmed education facts do not evidence a conferred degree at that level` });
      } else if (ko.type === "min_experience") {
        const years = evidencedFullTimeYears(profile || {});
        if (years != null && years < ko.min_years) unmet.push({ knockout: ko, reason: `experience knockout: posting requires ${ko.requirement}; your confirmed facts evidence about ${years} years of full-time experience` });
      }
    }
    return { knockouts, unmet, excluded: unmet.length > 0 };
  }
  // Application-prep constraint carried in data whenever the employer's ban flags:
  // downstream prep can read this instead of proceeding as if the ban were absent.
  function applicationPrepFor(posting) {
    const ban = detectAiAuthorshipBan(posting);
    if (!ban) return { ai_authorship_banned: false, ai_authored_responses_allowed: true, allowed_prep: ["ai_drafted_application_responses"], ban: null };
    return { ai_authorship_banned: true, ai_authored_responses_allowed: false, allowed_prep: ["organize_candidate_facts", "bullet_points_for_candidate_to_write_from", "factual_qa_about_the_posting"], blocked_prep: ["ai_authored_application_responses", "ai_generated_cover_letter_text"], ban };
  }
  // ---------- source health (SHD-1, data half) ----------
  // Health is part of the RESULT DATA: a healthy no-match and an outage both return
  // zero postings, so callers distinguish them only through this object.
  function sourceHealth(feedResults) {
    const queried = (feedResults || []).map((r) => {
      const ok = !r.error && r.status >= 200 && r.status < 300;
      return { source: r.source || null, company_token: r.company_token || null, url: r.url || null, status: r.skipped ? "dead" : (r.status != null ? r.status : 0), ok, skipped: !!r.skipped, error: r.error || null, postings: (r.postings || []).length };
    });
    const succeeded = queried.filter((q) => q.ok), failed = queried.filter((q) => !q.ok);
    const outcome = !queried.length ? "no_sources" : !succeeded.length ? "outage" : failed.length ? "degraded" : "ok";
    return { queried, succeeded, failed, total: queried.length, ok_count: succeeded.length, failed_count: failed.length, degraded: failed.length > 0, all_down: queried.length > 0 && succeeded.length === 0, outcome };
  }

  // TN-1a FEED PATH (BUG-226, FR-384): a posting's company comes only
  // from a source that NAMES it — the payload itself, or the feed
  // descriptor's stated company (registry boards carry one). The board
  // token is an address, never a company: when neither source names a
  // company the posting arrives company-less (null + the not-stated
  // marker), per the owner's TN-1a ruling — never invented.
  const companyOf = (payloadName, statedCompany) => s(payloadName) || s(statedCompany) || null;

  // F-013: retain location text from the ATS's stated primary/secondary values.
  // Never stringify an object into a location or substitute the company/board as geography.
  function locationText(value) {
    const out = [], seen = new Set();
    const plain = (v) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    const add = (v) => { const t = plain(v), key = t.toLowerCase(); if (t && !seen.has(key)) { seen.add(key); out.push(t); } return !!t; };
    function read(v, depth) {
      if (depth > 6 || v == null) return false;
      if (typeof v === "string") return add(v);
      if (Array.isArray(v)) { let found = false; for (const item of v) found = read(item, depth + 1) || found; return found; }
      if (typeof v !== "object") return false;
      let named = false;
      for (const name of ["location", "locationName", "name"]) if (v[name] !== undefined) named = read(v[name], depth + 1) || named;
      // A named location is the source's own label; its address is only a fallback.
      if (named) return true;
      const address = v.postalAddress || (v.address && (v.address.postalAddress || v.address)) || v;
      const parts = [address.city || address.addressLocality, address.region || address.state || address.addressRegion, address.country || address.addressCountry].map(plain).filter(Boolean);
      return parts.length ? add([...new Set(parts)].join(", ")) : false;
    }
    read(value, 0);
    return out.join("; ");
  }

  function basePosting(p) {
    const req = p.req_id ? s(p.req_id) : "";
    const job_id = req ? `${p.source}:${normName(p.company)}:${req}`.replace(/\s+/g, "-")
                       : `${p.source}:${normName(p.company)}:${hash(p.url)}`.replace(/\s+/g, "-");
    const jd_text = stripHtml(p.jd_text || "");
    const posting = {
      job_id, company: p.company ? s(p.company) : null, company_not_stated: !p.company, title: s(p.title),
      role_family: roleFamily(p.title, jd_text), seniority_band: seniorityBand(p.title, jd_text),
      location: s(p.location || ""), remote: remoteOf(p.location, jd_text),
      url: s(p.url), posted_at: iso(p.posted_at), jd_text,
      source: p.source, sources: [p.source], source_urls: [s(p.url)],
      department: s(p.department || ""), req_id: req || null,
    };
    // APD-2/APD-5: restrictions + employer AI-authorship ban ride on the posting record.
    posting.restrictions = detectRestrictions(posting);
    posting.ai_authorship_ban = detectAiAuthorshipBan(posting);
    // BUG-050: hard knockouts (license / certification / degree / minimum years) ride on the record too.
    posting.knockouts = detectKnockouts(posting);
    return posting;
  }

  // ---------- per-ATS normalization (recorded shapes; see tests) ----------
  function normalizeGreenhouse(json, token, statedCompany) {
    const company = companyOf(json && json.name, statedCompany);
    return ((json && json.jobs) || []).map((j) => basePosting({
      // BUG-005 (SC-032): Stripe's board returns requisition_id "See Opening ID" for ALL 721 jobs —
      // using it as the req id collapsed every Stripe posting onto ONE job_id. A requisition id
      // that is a placeholder (or shared text, not an identifier) must fall back to the numeric id.
      source: "greenhouse", company, title: j.title, req_id: (j.requisition_id && !/see opening/i.test(String(j.requisition_id))) ? j.requisition_id : j.id,
      location: (j.location && j.location.name) || (j.offices && j.offices[0] && j.offices[0].name) || "",
      url: j.absolute_url, posted_at: j.first_published || j.updated_at || j.created_at,
      jd_text: j.content || "", department: (j.departments && j.departments[0] && j.departments[0].name) || "",
    }));
  }
  function normalizeLever(json, companyToken, statedCompany) {
    return (Array.isArray(json) ? json : []).map((j) => basePosting({
      source: "lever", company: companyOf(null, statedCompany), title: j.text, req_id: j.id,
      location: (j.categories && j.categories.location) || "", url: j.hostedUrl || j.applyUrl,
      posted_at: j.createdAt, jd_text: j.descriptionPlain || j.description || "",
      department: (j.categories && (j.categories.team || j.categories.department)) || "",
    }));
  }
  function normalizeAshby(json, name, statedCompany) {
    return ((json && json.jobs) || []).map((j) => basePosting({
      source: "ashby", company: companyOf(json && json.name, statedCompany), title: j.title, req_id: j.id,
      location: locationText([j.location, j.locationName, j.locations, j.secondaryLocations]) || "Location not stated", url: j.jobUrl || j.applyUrl,
      posted_at: j.publishedAt || j.createdAt, jd_text: j.descriptionPlain || j.descriptionHtml || "",
      department: j.departmentName || j.teamName || "",
    }));
  }
  function normalizeSmartRecruiters(json, companyToken, statedCompany) {
    return ((json && json.content) || []).map((j) => {
      const loc = j.location || {};
      const location = [loc.city, loc.region, loc.country].filter(Boolean).join(", ") + (loc.remote ? " (Remote)" : loc.hybrid ? " (Hybrid)" : "");
      const sections = j.jobAd && j.jobAd.sections ? Object.values(j.jobAd.sections).map((x) => (x && (x.text || "")) || "").join(" ") : "";
      return basePosting({
        source: "smartrecruiters", company: companyOf(j.company && j.company.name, statedCompany), title: j.name, req_id: j.ref || j.id,
        location, url: `https://jobs.smartrecruiters.com/${companyToken}/${j.id}`,
        posted_at: j.releasedDate || j.createdOn, jd_text: sections, department: (j.department && j.department.label) || "",
      });
    });
  }
  const NORMALIZERS = { greenhouse: normalizeGreenhouse, lever: normalizeLever, ashby: normalizeAshby, smartrecruiters: normalizeSmartRecruiters };

  // ---------- feeds (Doc 2 Appendix B.2, exact endpoints) ----------
  const feeds = {
    greenhouse: (token) => ({ source: "greenhouse", company_token: token, url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true` }),
    lever: (company) => ({ source: "lever", company_token: company, url: `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json` }),
    ashby: (name) => ({ source: "ashby", company_token: name, url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}` }),
    smartrecruiters: (company) => ({ source: "smartrecruiters", company_token: company, url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings` }),
  };
  // Starter boards, SWE + Finance first (owner ruling 2026-10-12).
  const STARTER_FEEDS = [
    feeds.greenhouse("stripe"), feeds.greenhouse("robinhood"), feeds.greenhouse("coinbase"),
    feeds.greenhouse("datadog"), feeds.greenhouse("airbnb"), feeds.greenhouse("figma"),
    feeds.lever("leverdemo"), feeds.ashby("ramp"), feeds.ashby("openai"), feeds.ashby("ashby"),
    feeds.smartrecruiters("Square"), feeds.smartrecruiters("BoschGroup"),
  ];

  // ---------- canonical board registry (REPLY-QUALITY PASS, 2026-10-13) ----------
  // This is THE company->board registry: scripts/career/proof-jobs.mjs pulls from it and
  // 131-career-discover plans discovery from it. Every entry carries an explicit status.
  // An entry is 'live' ONLY if a real fetch from this machine returned postings JSON
  // (evidence: docs/career/board-registry-fix-2026-10-13.md). A board whose public ATS
  // endpoints all 404 — or answer with an empty body indistinguishable from a nonexistent
  // company — is 'dead': it is never fetched, and callers report it in deadBoards.
  const CHECKED_AT = "2026-10-13";
  const liveBoard = (company, provider, board, note) => Object.assign(feeds[provider](board),
    { company, provider, board, status: "live", checkedAt: CHECKED_AT, note });
  const deadBoard = (company, board, note) => ({ source: "custom", company_token: board, url: null,
    company, provider: "custom/no-public-api", board, status: "dead", checkedAt: CHECKED_AT, note });
  const BOARD_REGISTRY = [
    liveBoard("Stripe", "greenhouse", "stripe", "verified live 2026-10-13: HTTP 200, 722 postings"),
    liveBoard("Robinhood", "greenhouse", "robinhood", "verified live 2026-10-13: HTTP 200, 178 postings"),
    liveBoard("Airbnb", "greenhouse", "airbnb", "verified live 2026-10-13: HTTP 200, 164 postings"),
    liveBoard("Datadog", "greenhouse", "datadog", "verified live 2026-10-13: HTTP 200, 437 postings"),
    liveBoard("Coinbase", "greenhouse", "coinbase", "verified live 2026-10-13: HTTP 200, 225 postings"),
    liveBoard("Figma", "greenhouse", "figma", "verified live 2026-10-13: HTTP 200, 148 postings"),
    liveBoard("Jane Street", "greenhouse", "janestreet", "verified live 2026-10-13: HTTP 200, 229 postings"),
    deadBoard("Goldman Sachs", "goldmansachs", "no public ATS API: Greenhouse boards goldmansachs/goldman/goldmansachsembassy/gs/goldman-sachs all HTTP 404, Lever goldmansachs 404, Ashby goldmansachs/goldman-sachs 404, SmartRecruiters GoldmanSachs 200 with totalFound 0 (identical to a gibberish token); careers site is a custom surface (goldmansachs.com/careers, HTTP 200 HTML, no public postings JSON) — checked 2026-10-13"),
    liveBoard("Lever (demo board)", "lever", "leverdemo", "verified live 2026-10-13: HTTP 200, 10 postings"),
    deadBoard("Netflix", "netflix", "no public ATS API: Lever netflix/netflixjobs HTTP 404, Ashby netflix 404, Greenhouse netflix 404; jobs.netflix.com / explore.jobs.netflix.net are custom surfaces (HTTP 200 HTML, no public postings JSON) — checked 2026-10-13"),
    liveBoard("Ashby", "ashby", "ashby", "verified live 2026-10-13: HTTP 200, 66 postings"),
    liveBoard("Ramp", "ashby", "ramp", "FIXED 2026-10-13: was Lever (api.lever.co/v0/postings/ramp = HTTP 404); Ramp's real board is Ashby — HTTP 200, 165 postings"),
    liveBoard("OpenAI", "ashby", "openai", "verified live 2026-10-13: HTTP 200, 805 postings"),
    liveBoard("Linear", "ashby", "linear", "verified live 2026-10-13: HTTP 200, 31 postings"),
    // BUG-059 (W7 alert-speed gap G3): six more boards verified live
    // 2026-10-13/14 by the alert-speed lane's overnight watch — they worked
    // through the generic feeds builders but were invisible to
    // boardFeeds()/131 discovery planning until registered here.
    liveBoard("Gusto", "greenhouse", "gusto", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 99 postings"),
    liveBoard("Gemini", "greenhouse", "gemini", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 33 postings"),
    liveBoard("Virtu Financial", "greenhouse", "virtu", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 48 postings"),
    liveBoard("Scale AI", "greenhouse", "scaleai", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 183 postings"),
    liveBoard("Notion", "ashby", "notion", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 131 postings"),
    liveBoard("Old Mission Capital", "greenhouse", "oldmissioncapital", "verified live 2026-10-13/14 (alert-speed lane): HTTP 200, 41 postings"),
    deadBoard("Square", "Square", "SmartRecruiters endpoint answers HTTP 200 with totalFound 0 and zero postings (run 1 and 2026-10-13); SmartRecruiters returns the identical 200/totalFound 0 body for a gibberish company token, so the 200 evidences no real board and no postings have ever been pulled from it — checked 2026-10-13"),
    liveBoard("Bosch Group", "smartrecruiters", "BoschGroup", "verified live 2026-10-13: HTTP 200, 100 postings on first page, totalFound 4948"),
    deadBoard("Visa", "Visa", "SmartRecruiters endpoint answers HTTP 200 with totalFound 0 and zero postings (run 1 and 2026-10-13); SmartRecruiters returns the identical 200/totalFound 0 body for a gibberish company token, so the 200 evidences no real board and no postings have ever been pulled from it — checked 2026-10-13"),
  ];
  const liveBoards = () => BOARD_REGISTRY.filter((b) => b.status === "live");
  const deadBoards = () => BOARD_REGISTRY.filter((b) => b.status === "dead")
    .map((b) => ({ company: b.company, provider: b.provider, board: b.board, status: b.status, checkedAt: b.checkedAt, reason: b.note }));
  // Feed descriptors for the live boards only — dead boards produce no fetchable feed.
  const boardFeeds = () => liveBoards().map((b) => ({ source: b.source, company_token: b.company_token, url: b.url, company: b.company, provider: b.provider, board: b.board, status: b.status, checkedAt: b.checkedAt, note: b.note }));

  const realFetch = (url) => (typeof fetch !== "undefined" ? fetch(url, { headers: { accept: "application/json" } }) : Promise.reject(new Error("no fetch available; inject opts.fetch")));

  async function fetchFeed(feed, opts) {
    // Dead boards are never fetched: no silent 404s, the skip is the result.
    if (feed && feed.status === "dead") return { source: feed.source, company_token: feed.company_token, url: feed.url || null, status: 0, postings: [], skipped: true, error: `board marked dead (${(feed.company || feed.company_token || "?")}: ${feed.note || "no public API"})` };
    const f = (opts && opts.fetch) || realFetch;
    try {
      const res = await f(feed.url);
      const status = res.status != null ? res.status : (res.ok ? 200 : 0);
      if (status < 200 || status >= 300) return { source: feed.source, company_token: feed.company_token, url: feed.url, status, postings: [], error: `HTTP ${status}` };
      const json = typeof res.json === "function" ? await res.json() : res;
      const postings = NORMALIZERS[feed.source](json, feed.company_token, feed.company);
      return { source: feed.source, company_token: feed.company_token, url: feed.url, status, postings };
    } catch (e) {
      return { source: feed.source, company_token: feed.company_token, url: feed.url, status: 0, postings: [], error: s(e && e.message || e) };
    }
  }

  // ---------- dedupe ----------
  // City segment only: "San Francisco, CA" and "San Francisco, California" are the same place to a feed.
  function dedupeKey(p) { return `${normName(p.company)}|${normTitle(p.title)}|${normLoc(s(p.location).split(",")[0])}`; }
  // BUG-228 (MI-031, FR-386): dedupe identity has a recency bound and a
  // quality survivor. Copies posted more than 14 days apart are distinct
  // openings of a recurring role, never one posting — LA-0016's new
  // Lever posting merged into a month-old record, kept the old job_id,
  // and diffNew never fired. And when copies do merge, the cleaner copy
  // (JD substance, then department) supplies the identity, in either
  // arrival order — first-seen-wins kept the worse record.
  const DEDUPE_RECENCY_MS = 14 * 86400000;
  const postedFarApart = (a, b) => {
    const ta = Date.parse(a.posted_at || ""), tb = Date.parse(b.posted_at || "");
    return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > DEDUPE_RECENCY_MS;
  };
  const copyQuality = (p) => (p.jd_text || "").length + (p.department ? 500 : 0);
  // MI-051/LA-0016 (2026-10-15): copies merge only when their JD texts
  // are the same document (whitespace/case-normalized) or one side
  // carries no text. Two boards can carry the same role with DIFFERENT
  // text — LA-0016's Greenhouse twin carried a license-knockout
  // sentence its Lever twin lacked; merging them (and keeping the
  // longer text) poisoned the survivor and the gate killed a posting
  // that should have reminded. A syndicated copy of one opening
  // carries the employer's text; different text is a different record
  // for every downstream verdict (gate, fit, deadline).
  const jdNorm = (p) => (p.jd_text || "").toLowerCase().replace(/\s+/g, " ").trim();
  const sameJdText = (a, b) => { const x = jdNorm(a), y = jdNorm(b); return !x || !y || x === y || x.includes(y) || y.includes(x); };
  // A shared req id is the employer's own identity for the opening —
  // the same req on two boards is one posting however differently the
  // boards render its text (the gauntlet mirror pair GJ-X02/GJ-X03,
  // same req OPS-4471, requirement text rendered per board). Different
  // reqs fall back to the same-text test above.
  const sameOpening = (a, b) => (a.req_id && b.req_id && a.req_id === b.req_id) || sameJdText(a, b);
  function dedupe(postings) {
    const groups = new Map();
    for (const p of postings || []) {
      const key = dedupeKey(p);
      // Req ids are source-scoped: two DIFFERENT boards carrying the same role merge even though
      // their req ids differ; two postings on the SAME board with different req ids are distinct roles.
      const group = groups.get(key) || [];
      const hit = group.find((g) => (g.source !== p.source || !(g.req_id && p.req_id && g.req_id !== p.req_id)) && !postedFarApart(g, p) && sameOpening(g, p));
      if (!hit) { group.push(Object.assign({}, p, { sources: [...(p.sources || [p.source])], source_urls: [...(p.source_urls || [p.url])] })); groups.set(key, group); continue; }
      const winner = copyQuality(p) > copyQuality(hit) ? p : hit;
      const loser = winner === p ? hit : p;
      group[group.indexOf(hit)] = Object.assign({}, winner, {
        sources: [...new Set([...(hit.sources || [hit.source]), ...(p.sources || [p.source])])],
        source_urls: [...new Set([...(hit.source_urls || [hit.url]), ...(p.source_urls || [p.url])])],
        jd_text: (loser.jd_text || "").length > (winner.jd_text || "").length ? loser.jd_text : (winner.jd_text || ""),
        posted_at: [hit.posted_at, p.posted_at].filter(Boolean).sort()[0] || winner.posted_at || null,
        department: winner.department || loser.department || "",
      });
    }
    return [...groups.values()].flat();
  }

  // ---------- new-posting detection (DISC-004) ----------
  function diffNew(current, prior) {
    const seen = new Set((prior && prior.job_ids) || []);
    return (current || []).filter((p) => !seen.has(p.job_id));
  }
  function makeSnapshot(postings, now, priorHistory) {
    const history = Object.assign({}, (priorHistory || {}));
    const at = new Date(now || Date.now()).toISOString();
    for (const p of postings) {
      const h = history[p.job_id];
      if (!h) history[p.job_id] = { first_seen: at, last_seen: at, repost_count: 0, present: true };
      else { if (!h.present) h.repost_count = (h.repost_count || 0) + 1; h.last_seen = at; h.present = true; }
    }
    for (const id of Object.keys(history)) if (!postings.some((p) => p.job_id === id)) history[id].present = false;
    return { saved_at: at, job_ids: postings.map((p) => p.job_id), history };
  }
  // Injectable KV: { get(key), set(key, value) } — sync or async, plain JSON values.
  async function poll(feedList, opts) {
    opts = opts || {};
    const store = opts.store, key = opts.snapshotKey || "career:jobs:snapshot";
    const prior = store ? await store.get(key) : null;
    const results = [];
    for (const fd of feedList) results.push(await fetchFeed(fd, opts));
    const postings = dedupe(results.flatMap((r) => r.postings));
    const new_postings = diffNew(postings, prior);
    // Spec 2 §2.3 mass-close safety: a poll returning zero postings, or
    // fewer than half the prior snapshot, must NOT fire closed events —
    // that shape is a feed outage or a moved board until a later poll
    // proves otherwise ("never as 'all jobs closed'"). Presence state is
    // preserved, the differ's memory (job_ids) is kept so the same jobs
    // do not re-fire as new, and the anomaly is flagged on the result.
    const priorIds = (prior && prior.job_ids) || [];
    const massCloseSuspect = priorIds.length >= 4 && postings.length < priorIds.length / 2;
    const snapshot = makeSnapshot(postings, opts.now, prior && prior.history);
    if (massCloseSuspect) {
      for (const id of priorIds) if (snapshot.history[id]) snapshot.history[id].present = true;
      snapshot.job_ids = priorIds.slice();
      snapshot.mass_close_suspect = { prior_count: priorIds.length, current_count: postings.length };
    }
    if (store) await store.set(key, snapshot);
    const skippedDead = (feedList || []).filter((fd) => fd && fd.status === "dead")
      .map((fd) => ({ company: fd.company || fd.company_token, provider: fd.provider || fd.source, board: fd.board || fd.company_token, status: "dead", reason: fd.note || "board marked dead" }));
    return { postings, new_postings, feeds: results, snapshot, deadBoards: skippedDead, source_health: sourceHealth(results), mass_close_suspect: massCloseSuspect ? { prior_count: priorIds.length, current_count: postings.length } : null };
  }

  // ---------- ghost / quality flags (DISC-008) ----------
  function qualityFlags(posting, opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const age_days = posting.posted_at ? Math.max(0, Math.floor((now - Date.parse(posting.posted_at)) / DAY)) : null;
    const repost_count = opts.repost_count || 0;
    const jd = lc(posting.jd_text);
    const flags = [];
    if (age_days != null && age_days >= 60) flags.push({ code: "stale", reason: `open ${age_days} days` });
    else if (age_days != null && age_days >= 30) flags.push({ code: "aging", reason: `open ${age_days} days` });
    if (repost_count >= 1) flags.push({ code: "reposted", reason: `reposted ${repost_count === 1 ? "once" : repost_count + " times"}` });
    if (!posting.department && !/\b(team|group|organization|org)\b/.test(jd.slice(0, 800))) flags.push({ code: "missing_team", reason: "no named team in the posting" });
    if (!/(\$\s?\d|salary|compensation range|pay range|base salary)/.test(jd)) flags.push({ code: "missing_salary", reason: "no salary or compensation range shown" });
    const bad = flags.some((f) => f.code === "stale" || f.code === "reposted");
    const summary = flags.length ? `${flags.map((f) => f.reason).join(", ")}${bad ? " — lower odds" : ""}` : "no quality flags";
    return { age_days, repost_count, flags, summary, lower_odds: bad };
  }

  // ---------- fit scoring (DISC-005) ----------
  function profileSkills(profile) {
    let raw = (profile && (profile.skills || (profile.facts && profile.facts.skills))) || [];
    // BUG-054 (SS-10): the fit verdict depended on the CALLER's input shape —
    // a canonical profileFromData profile carries its skills as kind:"skill"
    // FACTS, and a caller who did not pre-attach profile.skills in the
    // 132-judge shape silently got score 0 / matched [] for a user who does
    // match. Derive the skills from the profile's own facts when no skills
    // array is attached, so every caller gets the same verdict.
    if ((!raw || !raw.length) && profile && Array.isArray(profile.facts)) {
      raw = profile.facts.filter((f) => f && f.kind === "skill").map((f) => ({ name: f.name || String(f.text || "").replace(/^Skill:\s*/i, ""), proven: !f.unproven }));
    }
    return raw.map((x) => typeof x === "string" ? { name: x, proven: true } : { name: s(x.name || x.skill), proven: x.proven !== false && !x.unproven }).filter((x) => x.name);
  }
  function hardFilters(posting, profile) {
    const fails = [];
    const c = (profile && profile.constraints) || {};
    const prefs = (profile && profile.preferences) || {};
    const jd = lc(posting.jd_text), title = lc(posting.title);
    // excluded company = a stated deal-breaker
    const excluded = (prefs.excluded_companies || []).map(normName);
    if (excluded.includes(normName(posting.company))) fails.push(`company: ${posting.company} is on your excluded list`);
    // location
    const wantLocs = (c.locations || prefs.locations || []).map(normLoc).filter(Boolean);
    if (wantLocs.length && posting.remote !== "remote") {
      if (!locationMatches(posting.location, c.locations || prefs.locations || [])) fails.push(locationIsStated(posting.location)
        ? `location: posting is in ${posting.location}; you want ${[...(c.locations || prefs.locations)].join(", ")}`
        : `location: posting does not state a location; you want ${[...(c.locations || prefs.locations)].join(", ")}`);
    }
    if (prefs.remote_only && posting.remote === "onsite") fails.push(locationIsStated(posting.location)
      ? `location: posting is on-site in ${posting.location}; you want remote`
      : "location: posting does not confirm remote work; you want remote");
    // work authorization (Doc 2 section 2 example: "requires US citizenship; you said you need sponsorship")
    const needsSponsorship = c.needs_sponsorship === true || /sponsor/i.test(s(c.work_authorization));
    const citizenOnly = /\b(u\.?s\.? citizens? only|must be a u\.?s\.? citizen|requires? u\.?s\.? citizenship|us citizenship required)\b/.test(jd);
    const noSponsor = /\b(no sponsorship|will not sponsor|cannot sponsor|unable to sponsor|without sponsorship|does not offer sponsorship)\b/.test(jd);
    if (citizenOnly && !/citizen/i.test(s(c.work_authorization))) fails.push(`work authorization: posting requires US citizenship; your profile says ${s(c.work_authorization) || "not a US citizen"}`);
    else if (needsSponsorship && noSponsor) fails.push(`work authorization: posting offers no sponsorship; you said you need sponsorship`);
    else if (needsSponsorship && citizenOnly) fails.push(`work authorization: posting requires US citizenship; you said you need sponsorship`);
    // clearance
    const needsClearance = /\b(ts\/sci|top secret|security clearance|secret clearance)\b/.test(jd);
    if (needsClearance && (!c.clearance || /none|no\b/i.test(s(c.clearance)))) fails.push(`clearance: posting requires a security clearance; none on your profile`);
    // graduation window
    const gradYear = c.graduation_year || (c.graduation_date ? Number(s(c.graduation_date).slice(0, 4)) : null);
    const jdGradYears = [...new Set([...jd.matchAll(/\b(?:graduat\w*|class of)\D{0,12}(20\d\d)\b/g)].map((m) => Number(m[1])))];
    if (gradYear && jdGradYears.length && /\b(intern|new grad|early career|university)\b/.test(title + " " + jd.slice(0, 300)) && !jdGradYears.includes(gradYear))
      fails.push(`graduation window: posting targets ${jdGradYears.join("/")}; you graduate ${gradYear}`);
    // seniority
    const years = typeof profile.experience_years === "number" ? profile.experience_years : null;
    const level = lc(profile.level || c.level || "");
    if ((posting.seniority_band === "senior" || posting.seniority_band === "staff" || posting.seniority_band === "director") && (level === "new_grad" || level === "student" || (years != null && years < 2)))
      fails.push(`seniority: posting is ${posting.seniority_band}-level; your profile is ${level || years + " yrs experience"}`);
    if (posting.seniority_band === "intern" && years != null && years >= 3 && level !== "student") fails.push(`seniority: posting is an internship; your profile shows ${years} yrs experience`);
    const reqYears = jd.match(/\b(\d+)\+?\s*(?:years|yrs)(?:\s*of)?\s*(?:experience|exp)\b/);
    if (reqYears && years != null && years + 1 < Number(reqYears[1])) fails.push(`seniority: posting asks ${reqYears[1]}+ years of experience; your profile shows ${years}`);
    // posting restrictions (APD-2): state residency + location radius are hard filters
    // when the profile's known facts decide them; when the deciding fact is unknown the
    // restriction does NOT fail here — scoreFit surfaces it as a needs_user_input flag.
    for (const reason of evaluateRestrictions(posting, profile).exclusion_reasons) fails.push(reason);
    // hard knockouts (BUG-050): license / certification / degree / minimum-years
    // requirements stated in the posting, checked against confirmed facts. An
    // unmet knockout is a hard fail with the gap named — never a bare pass.
    for (const u of evaluateKnockouts(posting, profile).unmet) fails.push(u.reason);
    // degree
    const deg = lc(profile.degree || c.degree || "");
    if (/\bph\.?d\.?\b/.test(jd.slice(0, 1200)) && /\brequired\b/.test(jd.slice(0, 1200)) && !/ph/.test(deg)) fails.push(`degree: posting requires a PhD; your profile degree is ${deg || "not listed"}`);
    if (/\bmaster'?s\b/.test(jd.slice(0, 1200)) && /\brequired\b/.test(jd.slice(0, 1200)) && deg && !/master|ph/.test(deg)) fails.push(`degree: posting requires a master's; your profile degree is ${deg}`);
    return fails;
  }

  // BUG-052 (FV-3): the location filter treated a multi-office location
  // string as ONE place (normLoc kept only its first 3 words), so a posting
  // listing the user's own city among several offices — or behind a
  // "Hybrid - " prefix — was hard-excluded at pipeline step 1. Matching now
  // splits the posting location into candidate places (on ; • | and on
  // commas), strips work-mode prefixes per candidate, and matches if ANY
  // candidate matches ANY wanted location (city-level match included, so
  // "New York City" satisfies a "New York, NY" want).
  function locationMatches(postingLoc, wantsRaw) {
    const wants = (wantsRaw || []).map(normLoc).filter(Boolean);
    if (!wants.length) return true;
    if (!locationIsStated(postingLoc)) return false;
    const segments = s(postingLoc).split(/[;•|]/).map((x) => x.replace(/^\s*(hybrid|remote|on-site|onsite|in-office)\s*[-–—:]\s*/i, "").trim()).filter(Boolean);
    const candidates = new Set();
    for (const seg of segments) {
      const n = normLoc(seg); if (n) candidates.add(n);
      for (const part of seg.split(",")) { const p = normLoc(part); if (p) candidates.add(p); }
    }
    // A bare state-abbreviation fragment ("co" from "Denver, CO") is not a
    // place: substring matching would let it "match" any want containing
    // those letters ("chicago" contains "co") and wave a Denver posting
    // through for a Chicago user (caught by DISC-005 the same day).
    for (const cand of [...candidates]) if (/^[a-z]{2}$/.test(cand) && _STATE_BY_ABBR.has(cand.toUpperCase())) candidates.delete(cand);
    const cityOf = (w) => { const words = w.split(" "); return words.length > 1 && /^[a-z]{2}$/.test(words[words.length - 1]) ? words.slice(0, -1).join(" ") : w; };
    for (const w of wants) {
      const city = cityOf(w);
      for (const cand of candidates) {
        if (cand.includes(w) || w.includes(cand) || cand === city || cand.startsWith(`${city} `) || city.startsWith(`${cand} `)) return true;
      }
    }
    return false;
  }

  function scoreFit(posting, profile, cir, opts) {
    const fails = hardFilters(posting, profile || {});
    // SC-065 domain leg (opt-in): when the caller carries the ASK's families,
    // a cross-family posting is a hard exclusion with the reason in data —
    // it can never surface as a "closest fit" for a different-domain ask.
    const askFams = opts && Array.isArray(opts.askFamilies) ? opts.askFamilies : null;
    if (askFams && askFams.length && !askFams.includes(posting.role_family))
      fails.push(`role family: posting is a ${posting.role_family} role; the ask is for ${askFams.join(" or ")} roles`);
    // APD-2/APD-5 data, computed for every scored posting, excluded or not.
    const restrictionEval = evaluateRestrictions(posting, profile || {});
    const aiBan = detectAiAuthorshipBan(posting);
    const prep = applicationPrepFor(posting);
    if (fails.length) return { job_id: posting.job_id, excluded: true, score: null, bucket: null, reasons: fails, gaps: fails, matched_skills: [], missing_skills: [], hard_fails: fails, restrictions: restrictionEval.restrictions, needs_user_input: restrictionEval.needs_user_input, restriction_unresolved: restrictionEval.unresolved, ai_authorship_ban: aiBan, application_prep: prep };
    const prefs = (profile && profile.preferences) || {};
    const jd = lc(posting.title + " " + posting.jd_text);
    const skills = profileSkills(profile);
    // Proven-only matching (SC-037, BUG-002): a skill with no evidence link on the profile must NOT
    // earn score or appear as a match — it is named as a gap instead. Before this fix an unproven
    // skill (e.g. Rust on the TEST persona) counted toward skillScore exactly like an evidenced one.
    // BUG-053 (FV-8/SS-13): skill matching was raw substring — "Go" matched
    // inside "going"/"governance" and was reported as a real match on an
    // accounting JD and a wealth-management BA JD containing zero standalone
    // "Go". Match on TOKENS (word boundaries), keeping symbol-bearing skills
    // ("C++", "Node.js") intact.
    const jdTokens = ` ${jd.split(/[^a-z0-9+#.]+/).map((t) => t.replace(/\.+$/, "")).filter(Boolean).join(" ")} `;
    const mentioned = (name) => jdTokens.includes(` ${lc(name)} `);
    const matchedAll = skills.filter((x) => mentioned(x.name));
    const matched = matchedAll.filter((x) => x.proven);
    const unprovenMatched = matchedAll.filter((x) => !x.proven);
    const missing = skills.filter((x) => !mentioned(x.name));
    const reasons = [], gaps = [];
    // skills overlap: 0-50
    let skillScore = 0;
    if (skills.length) { skillScore = Math.round(50 * matched.length / Math.max(3, Math.min(skills.length, 10))); }
    if (matched.length) reasons.push(`skills match: ${matched.slice(0, 6).map((x) => x.name).join(", ")}`);
    if (unprovenMatched.length) gaps.push(`not counted — no evidence on your profile for: ${unprovenMatched.map((x) => x.name).join(", ")} (the posting mentions it, but only evidenced skills match)`);
    // experience relevance: 0-25 (role-family preference + keyword overlap with the profile's own words)
    let expScore = 0;
    const wantFamilies = (prefs.role_families || prefs.roles || []).map(lc);
    if (wantFamilies.includes(lc(posting.role_family))) { expScore += 12; reasons.push(`role family ${posting.role_family} is one you asked for`); }
    const profileWords = new Set(lc([profile.experience_text || "", profile.summary || "", skills.filter((x) => x.proven).map((x) => x.name).join(" ")].join(" ")).split(/[^a-z0-9+#.]+/).filter((w) => w.length > 3));
    const jdWords = new Set(jd.split(/[^a-z0-9+#.]+/).filter((w) => w.length > 3));
    const overlap = [...profileWords].filter((w) => jdWords.has(w)).length;
    expScore += Math.min(13, overlap);
    if (overlap >= 5) reasons.push(`your own experience wording shares ${overlap} terms with this posting's text`);
    else gaps.push(`little overlap between your experience wording and this posting's text (${overlap} shared terms)`);
    if (missing.length && matched.length) gaps.push(`your other profile skills not mentioned here: ${missing.slice(0, 5).map((x) => x.name).join(", ")}`);
    // company preference: 0-15, starred first
    let companyScore = 0;
    const starred = (prefs.starred_companies || []).map(normName);
    if (starred.includes(normName(posting.company))) { companyScore = 15; reasons.push(`${posting.company} is a company you starred`); }
    // role-family / location soft points: 0-10 combined into experience bucket cap check below
    let score = Math.max(0, Math.min(100, skillScore + expScore + companyScore + (posting.remote === "remote" && prefs.remote_ok !== false ? 3 : 0)));
    score = Math.max(0, Math.min(100, score));
    // bucket from the CIR bar (optional plain object: { bar } or { bar_score } or { competitiveness: 0-100 })
    const bar = cir && typeof cir === "object" ? (typeof cir.bar === "number" ? cir.bar : typeof cir.bar_score === "number" ? cir.bar_score : typeof cir.competitiveness === "number" ? cir.competitiveness : NEUTRAL_BAR) : NEUTRAL_BAR;
    const diff = score - bar;
    const bucket = diff >= 15 ? "Safety" : diff >= -10 ? "Match" : "Reach";
    reasons.push(`bucket ${bucket}: score ${score} vs bar ${bar}${cir ? " (company bar)" : " (neutral bar; no company record yet)"}`);
    // APD-2: an unresolved restriction is named as a gap and demotes the posting in
    // shortlist ordering — it is never silently passed as a clean fit.
    for (const q of restrictionEval.needs_user_input) gaps.push(`needs your input: ${q.reason}`);
    return { job_id: posting.job_id, excluded: false, score, bucket, bar, reasons, gaps, matched_skills: matched.map((x) => x.name), unproven_skills: unprovenMatched.map((x) => x.name), missing_skills: missing.map((x) => x.name), hard_fails: [], restrictions: restrictionEval.restrictions, needs_user_input: restrictionEval.needs_user_input, restriction_unresolved: restrictionEval.unresolved, demoted: restrictionEval.unresolved, ai_authorship_ban: aiBan, application_prep: prep };
  }

  // ---------- APPE-001 persona fixture -> scoring profile ----------
  // The master profile holds facts with IDs (Doc 2 section 1); this adapts that fact shape
  // (packages/career-data/fixtures/test-persona.json, a synthetic TEST persona) into the profile
  // shape scoreFit consumes, citing fact IDs so a score can be traced back to profile facts.
  // BUG-097 (alert-speed gap G5): a skill FACT's text can carry an annotation in
  // parentheses ("SQL (listed in the resume's Skills line; ...)"). The annotation is
  // provenance, not part of the skill's name — baked into the name it can never match
  // a JD token, so scoreFit's honest unproven-skill gap line silently never fired.
  // Split it out: name is the bare skill, the annotation rides along as name_note.
  function skillNameParts(text) {
    const t = s(text).replace(/^Skill:\s*/i, "").trim();
    const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (m && m[1].trim()) return { name: m[1].trim(), name_note: m[2].trim() };
    return { name: t, name_note: "" };
  }
  function profileFromPersona(persona) {
    const facts = (persona && persona.facts) || [];
    const byKind = (k) => facts.filter((f) => f.kind === k);
    const skills = byKind("skill").map((f) => { const p = skillNameParts(f.text); return Object.assign({ name: p.name, proven: !f.unproven && (f.evidence || []).length > 0, fact_id: f.fact_id }, p.name_note ? { name_note: p.name_note } : {}); });
    const constraintText = byKind("constraint").map((f) => f.text).join(" ");
    const prefText = byKind("preference").map((f) => f.text).join(" ");
    const grad = constraintText.match(/graduat\w*[^0-9]*(20\d\d)/i) || byKind("education").map((f) => f.text).join(" ").match(/class of (20\d\d)/i);
    const starred = (prefText.match(/starred companies:\s*([^.;]+)/i) || [])[1];
    const locations = ["New York", "NYC", "Chicago", "San Francisco", "Seattle", "Austin", "Boston", "Remote"].filter((l) => new RegExp(l, "i").test(prefText));
    // Canonical master-profile schema (122-career-profile): structured basics/constraints/preferences
    // win over prose parsing when present. Added at integration 2026-10-12 so ONE persona fixture
    // serves both the profile store and fit scoring.
    const canonSkills = byKind("skill").map((f) => { const p = skillNameParts(f.text); return Object.assign({ name: p.name, proven: !f.unproven && (f.evidence || []).length > 0, fact_id: f.id || f.fact_id }, p.name_note ? { name_note: p.name_note } : {}); });
    const canonGradYear = persona && persona.constraints && persona.constraints.graduationDate ? Number(String(persona.constraints.graduationDate).slice(0, 4)) : null;
    const canonStarred = persona && persona.preferences && Array.isArray(persona.preferences.targetCompanies) ? persona.preferences.targetCompanies : null;
    const canonLocations = persona && persona.preferences && Array.isArray(persona.preferences.locations) ? persona.preferences.locations : null;
    const prof0 = {
      persona_id: persona && persona.persona_id, label: persona && persona.label,
      skills: (persona && persona.constraints) ? canonSkills : skills,
      degree: (byKind("education")[0] || {}).text || "",
      level: /sophomore|student|class of/i.test(byKind("education").map((f) => f.text).join(" ")) ? "student" : "",
      experience_years: 1,
      experience_text: facts.filter((f) => ["experience", "project", "leadership"].includes(f.kind)).map((f) => f.text).join(" "),
      constraints: {
        work_authorization: /us citizen/i.test(constraintText) ? "US citizen" : constraintText,
        needs_sponsorship: /without sponsorship/i.test(constraintText) ? false : /need sponsorship|requires sponsorship/i.test(constraintText),
        graduation_year: grad ? Number(grad[1]) : null,
        graduation_date: grad ? `${grad[1]}-05` : null,
        clearance: /clearance/i.test(constraintText) ? constraintText : null,
        locations,
      },
      preferences: {
        role_families: [/swe|software/i.test(prefText) ? "SWE" : null, /finance|quant|bank/i.test(prefText) ? "Finance" : null].filter(Boolean),
        locations, starred_companies: starred ? starred.split(",").map((x) => x.trim()).filter(Boolean) : [],
      },
    };
    // APD-2: residence is a targeting fact in its own right (where the candidate
    // actually lives/studies), distinct from preferred locations.
    if (persona && persona.basics && persona.basics.location) { prof0.residence = String(persona.basics.location); prof0.basics = { location: String(persona.basics.location) }; prof0.constraints.residence = String(persona.basics.location); }
    if (persona && persona.constraints) {
      if (canonGradYear) { prof0.constraints.graduation_year = canonGradYear; prof0.constraints.graduation_date = String(persona.constraints.graduationDate); }
      if (typeof persona.constraints.needsSponsorship === "boolean") prof0.constraints.needs_sponsorship = persona.constraints.needsSponsorship;
      if (persona.constraints.workAuthorization) prof0.constraints.work_authorization = persona.constraints.workAuthorization;
    }
    if (canonStarred) prof0.preferences.starred_companies = canonStarred;
    if (canonLocations) { prof0.preferences.locations = canonLocations; prof0.constraints.locations = canonLocations; }
    // Canonical preferences.roles (SC-034, BUG-003): variant personas state roles only in the
    // structured preferences block ("Data Analyst", "Software Engineer"); the prose parser above
    // never saw them, so their role-family preference silently never fired. Derive families with
    // the same classifier the postings use.
    if (persona && persona.preferences && Array.isArray(persona.preferences.roles) && persona.preferences.roles.length) {
      const fams = [...new Set(persona.preferences.roles.map((r) => roleFamily(r, "")).filter((f) => f && f !== "Other"))];
      if (fams.length) prof0.preferences.role_families = fams;
    }
    return prof0;
  }

  // ---------- shortlist + feedback memory (DISC-006) ----------
  function feedbackNudge(feedbackRows, posting) {
    let nudge = 0; const why = [];
    for (const r of feedbackRows || []) {
      const yes = r.decision === "yes";
      if (r.role_family && lc(r.role_family) === lc(posting.role_family)) { nudge += yes ? 4 : -6; why.push(`${yes ? "you said yes to" : "you passed on"} a ${posting.role_family} role before (${yes ? "+4" : "-6"})`); }
      if (r.company && normName(r.company) === normName(posting.company)) { nudge += yes ? 5 : -8; why.push(`${yes ? "you said yes to" : "you passed on"} ${posting.company} before (${yes ? "+5" : "-8"})`); }
      for (const sk of r.skills || []) if ((posting.matched_skills || []).some((m) => lc(m) === lc(sk))) { nudge += yes ? 1 : -1; }
    }
    return { nudge: Math.max(-20, Math.min(20, nudge)), why: [...new Set(why)] };
  }
  async function feedbackRowsOf(store) {
    if (!store) return [];
    if (Array.isArray(store)) return store;
    if (typeof store.get === "function") return (await store.get("career:jobs:feedback")) || [];
    if (Array.isArray(store.rows)) return store.rows;
    return [];
  }
  async function recordFeedback(store, entry) {
    const row = { decision: entry.decision, role_family: entry.role_family || null, company: entry.company || null, skills: entry.skills || [], job_id: entry.job_id || null, at: entry.at || new Date().toISOString() };
    if (Array.isArray(store)) { store.push(row); return row; }
    if (store && typeof store.get === "function" && typeof store.set === "function") { const rows = (await store.get("career:jobs:feedback")) || []; rows.push(row); await store.set("career:jobs:feedback", rows); return row; }
    if (store && Array.isArray(store.rows)) { store.rows.push(row); return row; }
    throw new Error("feedback store must be an array, {rows}, or a KV {get,set}");
  }
  async function buildShortlist(scored, opts) {
    opts = opts || {};
    const limit = opts.limit || opts.perDay || 10;
    const rows = await feedbackRowsOf(opts.feedbackStore || opts.feedback);
    const enriched = [];
    for (const item of scored || []) {
      if (item.excluded || item.score == null) continue;
      const posting = item.posting || item;
      const merged = Object.assign({}, posting, { matched_skills: item.matched_skills || [] });
      const fb = feedbackNudge(rows, merged);
      enriched.push({ posting, score: item.score, adjusted_score: Math.max(0, Math.min(100, item.score + fb.nudge)), bucket: item.bucket, reasons: [...(item.reasons || []), ...fb.why], gaps: item.gaps || [], feedback_nudge: fb.nudge, restrictions: item.restrictions || posting.restrictions || [], needs_user_input: item.needs_user_input || [], restriction_unresolved: !!item.restriction_unresolved, ai_authorship_ban: item.ai_authorship_ban || posting.ai_authorship_ban || null, application_prep: item.application_prep || null });
    }
    // SC-065 domain leg: when the ask names role families (opts.askText or
    // opts.families), filter BEFORE ranking/limit — a shortlist is the best
    // roles OF THE ASKED DOMAIN, never the best-scoring roles overall with
    // cross-family padding. The filter outcome rides on the returned array
    // as family_filter so callers can state the true reason for an empty list.
    const requested = Array.isArray(opts.families) ? [...new Set(opts.families)] : (opts.askText ? askRoleFamilies(opts.askText) : []);
    let pool = enriched, familyFilter = null;
    if (requested.length) {
      pool = enriched.filter((x) => requested.includes(x.posting.role_family || roleFamily(x.posting.title, x.posting.jd_text)));
      familyFilter = { requested, pool_size: enriched.length, matched_size: pool.length, dropped_cross_family: enriched.length - pool.length };
    }
    // APD-2 demotion: postings with an unresolved restriction rank below every
    // resolved posting, whatever their skill score — never a silent top fit.
    pool.sort((a, b) => (Number(a.restriction_unresolved) - Number(b.restriction_unresolved)) || b.adjusted_score - a.adjusted_score || s(b.posting.posted_at).localeCompare(s(a.posting.posted_at)));
    const out = pool.slice(0, limit);
    if (familyFilter) out.family_filter = familyFilter;
    return out;
  }

  // Typed discovery result for one ASK (SC-065 domain leg). The honest
  // zero-result is a first-class outcome: when the pool carries no role of
  // the asked family, status is "no_matching_roles", the shortlist is empty
  // (never padded cross-family), reason states the true pool fact, and
  // next_step carries exactly one next step.
  async function shortlistForAsk(scored, askText, opts) {
    opts = opts || {};
    const requested = Array.isArray(opts.families) ? [...new Set(opts.families)] : askRoleFamilies(askText);
    const shortlist = await buildShortlist(scored, Object.assign({}, opts, { families: requested }));
    if (!requested.length) return { status: "no_family_in_ask", requested_families: [], pool_size: null, matched_size: null, shortlist, reason: null, next_step: null };
    const ff = shortlist.family_filter || { requested, pool_size: 0, matched_size: 0, dropped_cross_family: 0 };
    if (!ff.matched_size) return { status: "no_matching_roles", requested_families: requested, pool_size: ff.pool_size, matched_size: 0, shortlist, reason: `the current pool has ${ff.pool_size} scored role${ff.pool_size === 1 ? "" : "s"} and none of them are ${requested.join(" or ")} roles — cross-family roles were not substituted`, next_step: `Add boards that carry ${requested.join("/")} roles, or widen the ask to a neighbouring role family, and I will search again.` };
    return { status: "ok", requested_families: requested, pool_size: ff.pool_size, matched_size: ff.matched_size, shortlist, reason: null, next_step: null };
  }

  return { POLL_MINUTES, NEUTRAL_BAR, STARTER_FEEDS, BOARD_REGISTRY, liveBoards, deadBoards, boardFeeds, feeds, fetchFeed, fetchAll: async (fl, o) => { const r = []; for (const f of fl) r.push(await fetchFeed(f, o)); return { feeds: r, postings: dedupe(r.flatMap((x) => x.postings)), source_health: sourceHealth(r), deadBoards: (fl || []).filter((fd) => fd && fd.status === "dead").map((fd) => ({ company: fd.company || fd.company_token, provider: fd.provider || fd.source, board: fd.board || fd.company_token, status: "dead", reason: fd.note || "board marked dead" })) }; },
    normalizeGreenhouse, normalizeLever, normalizeAshby, normalizeSmartRecruiters,
    dedupe, dedupeKey, diffNew, makeSnapshot, poll, qualityFlags, hardFilters, scoreFit, profileFromPersona, buildShortlist, shortlistForAsk, askRoleFamilies, recordFeedback, feedbackNudge,
    detectRestrictions, evaluateRestrictions, detectAiAuthorshipBan, applicationPrepFor, sourceHealth, profileResidence,
    detectKnockouts, evaluateKnockouts, evidencedFullTimeYears,
    roleFamily, seniorityBand, locationText, stripHtml, hash };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerJobs;
