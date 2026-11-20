/* Career assignment layer (Mega Task 2, assigning half; owner direction
   2026-10-14: "we need a system for knowing everything. once we have that, we
   can properly assign jobs for people interested in that position.").
   Module 151 watches boards and emits typed alert records, but an alert is
   composed against ONE injected profile inside the watch cycle — nothing held
   a user's stated interests as durable data, matched detections against them,
   or queued the result as a reminder a channel can deliver. This module is
   that half, at the same host tier as 151 (the router bundle does not carry
   it; the host schedules runAssignCycle after 151's cycle and drains the
   reminder queue through its channel):

     watch profile (per-USER record, key career:watch-profile:<user_id> in the
       injected {get,set} store — 121's KV contract; the record is user-scoped
       by construction, never keyed to a chat thread)
       -> interests: taxonomy roles (849 base occupations by SOC + the market
          splits of 00-taxonomy.md §A2) with title-variant terms, seniority
          blockers and optional filters (locations, remote, bands, firm lists)
     matcher: a candidate (a 151 alert record, or a raw 121 new posting) is
       scored against every interest — role terms, band gate, location gate,
       firm lists, opt-out — and 121 scoreFit's HARD EXCLUSION always wins
       over a title match (an alert never recommends a job the user's
       confirmed facts disqualify them from; methodology §6)
     suppression: the same seat rules 151 defines bind here (121 dedupeKey;
       14-day seat window; a re-presented req never re-reminds; a replacement
       req for a gone seat is absorbed) — persisted per user, so consuming
       raw diffs instead of 151's already-suppressed alerts cannot double-fire
     reminder: a typed career_job_reminder (the methodology §6 contract:
       role, company — or honestly not-stated under the TN-1a ruling, a
       posting with no stated company still matches and still reminds —
       deadline quoted in the posting's own words, fit lines sourced only
       from proven facts citing their fact IDs, the apply link) enqueued on a
       persisted per-user queue the host drains exactly once per record.

   Delivery itself (scheduler + channel send) is HOST wiring and is
   deliberately NOT in this module, exactly as in 151. Pure-ish domain idiom:
   all I/O arrives injected { postings | alerts, watchProfile, store, now }. */
const CareerAssign = (() => {
  const Jobs = (typeof require !== "undefined")
    ? (() => { try { return require("./121-career-jobs.js"); } catch { return null; } })()
    : (typeof CareerJobs !== "undefined" ? CareerJobs : null);
  const Watch = (typeof require !== "undefined")
    ? (() => { try { return require("./151-career-alert-watch.js"); } catch { return null; } })()
    : (typeof CareerAlertWatch !== "undefined" ? CareerAlertWatch : null);

  const SEAT_WINDOW_MS = 14 * 24 * 3600 * 1000; // 151 BUG-092's window, binding here too
  const PROFILE_KEY = (uid) => `career:watch-profile:${uid}`;
  const QUEUE_KEY = (uid) => `career:reminder-queue:${uid}`;
  const HISTORY_KEY = (uid) => `career:reminder-history:${uid}`;

  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const termIn = (text, term) => new RegExp(`(^|[^a-z0-9])${esc(term)}([^a-z0-9]|$)`).test(lc(text));

  function nowMs(now) {
    const v = typeof now === "function" ? now() : now;
    if (v == null) return Date.now();
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    const p = Date.parse(v);
    return isNaN(p) ? Date.now() : p;
  }

  // ---- role specs: the taxonomy bridge -------------------------------------
  // Curated title-variant + blocker sets for the market splits approved in
  // 00-taxonomy.md §A2 (a split exists only where the hiring recipe differs).
  // Any of the 849 base occupations gets a derived spec: its own title is the
  // term set; entry-band interests inherit the seniority blockers so a derived
  // spec can never fire on an executive title either (ASG-1).
  const ENTRY_BLOCKERS = ["senior", "sr.", "lead", "head of", "director", "vp", "vice president", "manager", "principal", "chief", "staff"];
  const SPLITS = {
    "Investment Banking Analyst": { soc: "13-2051", terms: ["investment banking"], blockers: ENTRY_BLOCKERS },
    "Private Equity Analyst": { soc: "13-2051", terms: ["private equity"], blockers: ENTRY_BLOCKERS },
    "Equity Research Analyst": { soc: "13-2051", terms: ["equity research"], blockers: ENTRY_BLOCKERS },
    "Corporate Banking Analyst": { soc: "13-2051", terms: ["corporate banking"], blockers: ENTRY_BLOCKERS },
    "Quantitative Trader": { soc: "41-3031", terms: ["quantitative trader", "quant trader"], blockers: ENTRY_BLOCKERS },
    "Software Engineering Intern / New-Grad": { soc: "15-1252", terms: ["software engineer", "software engineering"], blockers: ENTRY_BLOCKERS },
    "Machine Learning Engineer": { soc: "15-1252", terms: ["machine learning engineer", "ml engineer"], blockers: ENTRY_BLOCKERS },
    "Data Analyst": { soc: "15-2051", terms: ["data analyst"], blockers: ENTRY_BLOCKERS },
    "Product Manager": { soc: null, terms: ["product manager"], blockers: ENTRY_BLOCKERS },
    "Corporate Law Associate": { soc: "23-1011", terms: ["corporate associate", "law associate"], blockers: ENTRY_BLOCKERS },
    "Management Consultant Analyst": { soc: "13-1111", terms: ["management consultant", "consulting analyst"], blockers: ENTRY_BLOCKERS },
    "Real Estate Analyst": { soc: "13-2051", terms: ["real estate analyst", "acquisitions analyst"], blockers: ENTRY_BLOCKERS },
  };

  function roleSpecFor(input) {
    input = input || {};
    if (input.split && SPLITS[input.split]) {
      const sp = SPLITS[input.split];
      return { soc: input.soc || sp.soc, split: input.split, title: input.split, terms: sp.terms.slice(), blockers: sp.blockers.slice(), derived: false };
    }
    const title = s(input.title || input.split || "").trim();
    const base = lc(title).replace(/,?\s+all other$/, "").trim();
    const terms = base ? [base] : [];
    // plural/singular twin so "Boilermakers" also matches a "Boilermaker" title
    if (base.endsWith("s")) terms.push(base.slice(0, -1)); else if (base) terms.push(base + "s");
    return { soc: input.soc || null, split: input.split || null, title, terms: [...new Set(terms)], blockers: ENTRY_BLOCKERS.slice(), derived: true };
  }

  // ---- watch profile --------------------------------------------------------
  function createWatchProfile(userId, seed) {
    seed = seed || {};
    return {
      type: "career_watch_profile",
      version: 1,
      user_id: s(userId),
      interests: (seed.interests || []).map((i) => ({
        interest_id: s(i.interest_id),
        role: i.role,
        filters: Object.assign({ locations: [], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] }, i.filters || {}),
        created_at: i.created_at || null,
      })),
      opt_out: Object.assign({ global: false, companies: [] }, seed.opt_out || {}),
      scoring_profile: seed.scoring_profile || null, // the 121 scoreFit shape (proven-fact skills etc.)
      updated_at: seed.updated_at || null,
    };
  }

  function validateWatchProfile(wp) {
    const errors = [];
    if (!wp || wp.type !== "career_watch_profile") errors.push("not a career_watch_profile record");
    if (!wp || !s(wp.user_id)) errors.push("user_id is required (profiles are per-user, never per-thread)");
    for (const i of (wp && wp.interests) || []) {
      if (!i.interest_id) errors.push("an interest is missing its interest_id");
      const role = i.role || {};
      // SOC: a present code must be well-formed, and a curated/split
      // spec must carry one. ONE exception (alert path, 2026-10-24): a
      // DERIVED spec — the user's own stated words as title + terms,
      // built by roleSpecFor's derived shape — may carry no SOC. No code
      // is ever invented to fill the slot; the derived spec still
      // carries its entry blockers, and matching runs on its terms.
      // The same for a role the person named in their own words ("golang backend"), marked stated: it is stated, not inferred.
      if (role.soc) { if (!/^\d{2}-\d{4}$/.test(role.soc)) errors.push(`interest ${i.interest_id || "?"}: role.soc must be a SOC code (NN-NNNN)`); }
      else if (role.derived !== true && role.stated !== true) errors.push(`interest ${i.interest_id || "?"}: role.soc must be a SOC code (NN-NNNN)`);
      if (!role.title) errors.push(`interest ${i.interest_id || "?"}: role.title is required`);
      if (!Array.isArray(role.terms) || !role.terms.length) errors.push(`interest ${i.interest_id || "?"}: role.terms must carry at least one title term`);
      const f = i.filters || {};
      if (!Array.isArray(f.locations) || !Array.isArray(f.bands)) errors.push(`interest ${i.interest_id || "?"}: filters.locations and filters.bands must be arrays`);
    }
    return { ok: errors.length === 0, errors };
  }

  function upsertInterest(wp, interest) {
    const ix = wp.interests.findIndex((i) => i.interest_id === interest.interest_id);
    if (ix >= 0) wp.interests[ix] = interest; else wp.interests.push(interest);
    return wp;
  }
  function removeInterest(wp, interestId) {
    wp.interests = wp.interests.filter((i) => i.interest_id !== interestId);
    return wp;
  }
  function setOptOut(wp, optOut) { wp.opt_out = Object.assign({ global: false, companies: [] }, optOut || {}); return wp; }

  async function saveWatchProfile(store, wp) {
    const v = validateWatchProfile(wp);
    if (!v.ok) throw new Error(`invalid watch profile: ${v.errors.join("; ")}`);
    wp.updated_at = new Date().toISOString();
    await store.set(PROFILE_KEY(wp.user_id), wp);
    return wp;
  }
  async function loadWatchProfile(store, userId) {
    const wp = await store.get(PROFILE_KEY(userId));
    return wp || null;
  }

  // ---- matching --------------------------------------------------------------
  function roleMatch(posting, role) {
    const title = lc(posting.title);
    for (const b of role.blockers || []) if (termIn(title, lc(b))) return { hit: false, blocker: b };
    for (const t of role.terms || []) if (termIn(title, lc(t))) return { hit: true, basis: "title", term: t };
    // Multiword role terms also match in the posting's own opening text — a
    // "Summer Analyst" req whose body names the desk is a real match, labeled.
    // MI-028: a jd_head hit also returns the posting's own words around the
    // term as evidence, so the match-basis line can QUOTE the basis instead
    // of merely asserting it (same ±40-char window 151's occupationHit uses).
    const head = lc(posting.jd_text || "").slice(0, 500);
    for (const t of role.terms || []) {
      if (!t.includes(" ")) continue;
      const m = new RegExp(`(^|[^a-z0-9])${esc(lc(t))}([^a-z0-9]|$)`).exec(head);
      if (m) {
        const at = m.index + (m[1] ? m[1].length : 0);
        const evidence = s(posting.jd_text || "").slice(0, 500).slice(Math.max(0, at - 40), at + t.length + 40).trim();
        return { hit: true, basis: "jd_head", term: t, evidence };
      }
    }
    return { hit: false };
  }

  // Boards abbreviate cities freely ("NYC", "CHI", "SF, SEA, CHI, NYC" on one
  // real Stripe location string). Matching only the spelled-out city name
  // would reject a posting in the user's own city — a silent miss class
  // (ASG-9). Canonicalize known abbreviations token-wise before comparing.
  const CITY_ALIASES = { nyc: "new york", chi: "chicago", sf: "san francisco", sea: "seattle", la: "los angeles", philly: "philadelphia", atl: "atlanta", dfw: "dallas", dc: "washington" };
  const canonLoc = (txt) => lc(txt).split(/[^a-z0-9]+/).map((t) => CITY_ALIASES[t] || t).join(" ");
  // SERIAL-1530: where a posting is open, and whether the person is there (the mirror of
  // supabase/functions/_shared/posting_region.ts: the same REGION_TABLE, the same decision; the architect's test pins the
  // two to each other). A remote posting passed any watch whose remote preference was not "no"; now its stated country
  // or bloc ("Remote - US", "Spain (Remote)") and any restriction in its text ("authorized to work in the United States",
  // "UK residents only") are screened against the person's STATED location; with none on record it is held, never
  // passed, and nothing is inferred about where they are or what they are authorized for.
  const REGION_TABLE = [
    ["us", ["us", "u.s.", "u.s", "usa", "u.s.a.", "united states", "united states of america", "america", "stateside"]],
    ["canada", ["canada", "canadian"]],
    ["uk", ["uk", "u.k.", "united kingdom", "britain", "great britain", "england", "scotland", "wales", "northern ireland"]],
    ["ireland", ["ireland", "republic of ireland"]],
    ["germany", ["germany", "deutschland"]], ["france", ["france"]], ["spain", ["spain"]], ["italy", ["italy"]],
    ["netherlands", ["netherlands", "the netherlands", "holland"]], ["belgium", ["belgium"]], ["austria", ["austria"]],
    ["switzerland", ["switzerland"]], ["sweden", ["sweden"]], ["denmark", ["denmark"]], ["finland", ["finland"]], ["norway", ["norway"]],
    ["poland", ["poland"]], ["portugal", ["portugal"]], ["czechia", ["czechia", "czech republic"]],
    ["india", ["india"]], ["australia", ["australia"]], ["new zealand", ["new zealand"]], ["singapore", ["singapore"]], ["japan", ["japan"]],
    ["mexico", ["mexico"]], ["brazil", ["brazil"]], ["argentina", ["argentina"]], ["israel", ["israel"]], ["uae", ["uae", "united arab emirates", "dubai"]],
    ["eu", ["eu", "european union", "europe", "emea", "eea"]], ["apac", ["apac", "asia pacific", "asia-pacific"]], ["latam", ["latam", "latin america"]],
  ];
  const EU_MEMBERS = new Set(["ireland", "germany", "france", "spain", "italy", "netherlands", "belgium", "austria", "sweden", "denmark", "finland", "poland", "portugal", "czechia"]);
  const US_STATES = new Set("al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy".split(" "));
  const US_STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/;
  const CA_CODE = /,\s*(on|bc|qc|ab|ns|mb|sk|nb|pe|nl)\b/;
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const TABLE_RE = REGION_TABLE.map(([k, words]) => [k, new RegExp(`(^|[^a-z0-9.])(${words.map(escRe).join("|")})(?=$|[^a-z0-9])`, "i")]);
  function regionsOf(text) {
    const t = lc(text).replace(/\s+/g, " ").trim();
    if (!t) return [];
    const out = new Set();
    for (const [k, re] of TABLE_RE) if (re.test(` ${t} `)) out.add(k);
    if (!out.has("us")) {
      const code = /,\s*([a-z]{2})\b/.exec(t);
      if ((code && US_STATES.has(code[1]) && !CA_CODE.test(t)) || US_STATE_NAMES.test(t)) out.add("us");
    }
    if (!out.size && CA_CODE.test(t)) out.add("canada");
    return [...out];
  }
  const RESTRICT = /(?:(?:authori[sz]ed|eligible|legally (?:able|permitted|entitled)|permitted|entitled|right|work authori[sz]ation) to work (?:in|within)|(?:must|need to|required to|should|have to) (?:reside|be (?:located|based|living|resident)|live|work|be) (?:in|within)|(?:candidates?|applicants?|you) (?:must be|should be|are|need to be) (?:located|based|living|resident) (?:in|within)|open (?:only )?to (?:candidates|applicants|residents|those)? ?(?:in|of|within)|only (?:for|to) (?:candidates|applicants|residents) (?:in|of|within))\s+(?:the\s+)?([a-z .&'-]{2,40}?)(?=\s*(?:[.;:,)\n]|$|\s+(?:only|and|or|at|for|who|with|to|are|is)\b))/gi;
  const ONLY_RE = /\b([a-z. ]{2,30}?)\s+(?:residents\s+)?only\b/gi;
  // "must be US-based", "US-based candidates only": the candidate, never the employer ("a Chicago-based company").
  const BASED_RE = /\b(?:(?:must|should|need to) be|candidates? (?:must be|should be|are)|you are|you must be)\s+([a-z.]{2,15})-based\b|\b([a-z.]{2,15})-based\s+(?:candidates?|applicants?|residents?|only)\b/gi;
  function restrictionsOf(text) {
    const t = lc(text).replace(/\s+/g, " ").trim();
    if (!t) return [];
    const out = new Set();
    for (const re of [RESTRICT, ONLY_RE, BASED_RE]) { re.lastIndex = 0; for (const m of t.matchAll(re)) for (const k of regionsOf(m[1] || m[2])) out.add(k); }
    return [...out];
  }
  const isRemotePosting = (p) => p.remote === "remote" || /\bremote\b/i.test(s(p.location));
  function postingScope(p) {
    const out = new Set();
    const loc = s(p.location);
    if (isRemotePosting(p)) for (const seg of loc.split(/[;|•·\n]/)) if (/\bremote\b/i.test(seg)) for (const k of regionsOf(seg.replace(/\bremote\b/gi, " "))) out.add(k);
    for (const k of restrictionsOf(p.jd_text || p.description || "")) out.add(k);
    return [...out];
  }
  const inScope = (home, scope) => home.some((h) => scope.includes(h) || (scope.includes("eu") && (EU_MEMBERS.has(h) || h === "eu")));
  const sayRegions = (ks) => ks.map((k) => k === "us" ? "the US" : k === "uk" ? "the UK" : k === "eu" ? "the EU" : k === "uae" ? "the UAE" : k.replace(/\b\w/g, (c) => c.toUpperCase())).join(" or ");
  function locationOk(posting, filters, home) {
    const scope = postingScope(posting), mine = regionsOf(home);
    const held = (what) => ({ ok: false, why: `${what}, and your location is not on record: tell me your city and country and I will match it` });
    if (isRemotePosting(posting)) {
      if (filters.remote_ok === false) return { ok: false, why: "remote postings are left out of this watch" };
      if (!scope.length) return { ok: true, via: "remote" };
      if (!mine.length) return held(`remote within ${sayRegions(scope)} only`);
      if (inScope(mine, scope)) return { ok: true, via: `remote within ${sayRegions(scope)}` };
      return { ok: false, why: `remote within ${sayRegions(scope)} only; your location is ${sayRegions(mine)}` };
    }
    const loc = canonLoc(posting.location || "");
    let place = null;
    for (const want of filters.locations || []) {
      const w = canonLoc(want).split(",")[0].trim();
      // MI-028: carry WHICH watched location matched (`want`) — the true
      // location basis of the match, previously discarded by matchInterest.
      if (w && loc.includes(w)) { place = { ok: true, via: `location ${want}`, want }; break; }
    }
    if (!place && !(filters.locations || []).length && filters.remote_ok === false) place = { ok: true, via: "no location filter" };
    if (!place) return { ok: false };
    if (scope.length) {
      if (!mine.length) return held(`open to ${sayRegions(scope)} only`);
      if (!inScope(mine, scope)) return { ok: false, why: `open to ${sayRegions(scope)} only; your location is ${sayRegions(mine)}` };
    }
    return place;
  }

  // Deadline in the posting's own words (methodology §6: quoted, never converted).
  function extractDeadline(posting) {
    const text = s(posting.jd_text || "");
    const m = text.match(/(applications? (?:close|deadline)|apply by|deadline|closing date)\s*(?:is|:|on)?\s*([A-Z][a-z]+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (!m) return null;
    return { text: m[0].trim(), at: deadlineDayUtc(m[2]) };
  }

  // A posted deadline is a calendar day, not an instant on this server's clock. Date.parse read "2026-11-02" as UTC
  // midnight but "November 2, 2026" and "11/2/2026" as the HOST's local midnight, so the same deadline moved by the
  // server's offset (06:00Z on a Chicago host, 00:00Z on a UTC one). Every form becomes that day at 00:00Z.
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  function deadlineDayUtc(raw) {
    const t = String(raw).trim();
    let y, mo, d;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
    else if ((m = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(t))) {
      const i = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase()) && m[1].length >= 3);
      if (i < 0) return null;
      mo = i + 1; d = +m[2]; y = +m[3];
    } else return null;
    const at = Date.UTC(y, mo - 1, d);
    const back = new Date(at);
    // A day that does not exist ("February 30") is no deadline at all, never a rolled-over one.
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return back.toISOString();
  }

  // One posting x one interest. Returns { matched, reasons[], fit } — reasons
  // are data, so a no-match can always SAY why (the negative-proof contract).
  function matchInterest(posting, interest, scoringProfile) {
    const reasons = [];
    const role = interest.role || {};
    const f = interest.filters || {};
    const rm = roleMatch(posting, role);
    if (rm.blocker) reasons.push(`title carries the seniority blocker "${rm.blocker}" — not a ${role.title} posting`);
    else if (!rm.hit) reasons.push(`title matches no term for ${role.title}`);
    const band = posting.seniority_band || (Jobs ? Jobs.seniorityBand(posting.title || "", posting.jd_text || "") : "unknown");
    if ((f.bands || []).length && !f.bands.includes(band)) reasons.push(`seniority band is ${band}; this interest watches ${(f.bands || []).join(" / ")}`);
    const loc = locationOk(posting, f, scoringProfile && scoringProfile.location);
    if (!loc.ok) reasons.push(loc.why ? `location: ${loc.why}` : `location ${posting.location || "unstated"} is outside this interest's locations (${(f.locations || []).join(", ") || "none"}${f.remote_ok === false ? "" : " + remote"})`);
    const company = s(posting.company);
    if ((f.firms_include || []).length) {
      if (!company) reasons.push("interest is limited to named firms and this posting states no company (cannot verify the firm)");
      else if (!f.firms_include.some((x) => lc(x) === lc(company))) reasons.push(`${company} is not in this interest's firm list`);
    }
    if (company && (f.firms_exclude || []).some((x) => lc(x) === lc(company))) reasons.push(`${company} is excluded by this interest`);
    let fit = null;
    if (!reasons.length) {
      // A 151 alert record was already gated + scored at the watch tier; its
      // fit is inherited, never recomputed against a shadow of the posting.
      fit = posting._inherited_fit || (Jobs && scoringProfile ? Jobs.scoreFit(posting, scoringProfile) : null);
      if (fit && fit.excluded) reasons.push(...(fit.hard_fails || fit.reasons || []).map((r) => `scoreFit hard-excluded: ${r}`));
    }
    // MI-028 (loss point L1): the match's TRUE basis used to die here —
    // roleMatch's term (and jd_head evidence), locationOk's via/want, and the
    // band the interest watches were all computed, used as gates, and then
    // thrown away; only the bare basis enum survived, so composeReminder had
    // nothing truthful to render as a fit line for the 94% of reminders with
    // no proven-skill match. match_detail carries them to the reminder.
    const match_detail = reasons.length === 0 && rm.hit ? {
      term: rm.term || null,
      basis: rm.basis || null,
      evidence: rm.evidence || null,
      location_via: loc.ok ? loc.via : null,
      location_want: loc.want || null,
      band,
      bands_watched: (f.bands || []).slice(),
    } : null;
    return { matched: reasons.length === 0, reasons, fit, band, match_basis: rm.basis || null, match_detail };
  }

  // ---- reminder ---------------------------------------------------------------
  // MI-028 (loss points L2/L3): match-basis lines. A reminder's fit lines used
  // to come ONLY from proven-skill derivation (151 composeAlert / inherited
  // alert lines); when no proven skill matched — 808 of 858 Lane A reminders,
  // 644 of them for profiles holding no skills at all — the reminder carried
  // NO basis even though the match itself was fully evidenced. These lines
  // state the match's own true basis, labeled "match basis:", built only from
  // facts the matcher actually verified for THIS posting x interest: the
  // watched role term and where it matched (title, or the JD opening quoted
  // verbatim), the watched location (or accepted remote), and the watched
  // band. A line is emitted only when its basis was a real criterion of the
  // interest (no band line when the interest watches no bands; no location
  // line when location was not how it matched). Nothing here invents a skill
  // or a fact ID — proven-skill lines keep their own fact-cited form above.
  function matchBasisLines(posting, interest, verdict) {
    const d = (verdict && verdict.match_detail) || null;
    if (!d || !d.term) return [];
    const lines = [];
    const roleTitle = (interest.role || {}).title || "";
    if (d.basis === "jd_head" && d.evidence)
      lines.push(`match basis: watched role term "${d.term}" matches this posting's opening text — "${d.evidence}" (watched role: ${roleTitle})`);
    else
      lines.push(`match basis: watched role term "${d.term}" matches this posting's title (watched role: ${roleTitle})`);
    if (d.location_via === "remote")
      lines.push("match basis: this posting is remote and this interest accepts remote postings");
    else if (d.location_want)
      lines.push(`match basis: posting location "${posting.location || ""}" matches watched location "${d.location_want}"`);
    if ((d.bands_watched || []).length && d.band)
      lines.push(`match basis: seniority band "${d.band}" is one this interest watches`);
    return lines;
  }

  function composeReminder(posting, interest, verdict, wp, now) {
    const fit = verdict.fit || posting._inherited_fit || null;
    let fitLines = [], factIds = [], score = null, bucket = null;
    if (posting._inherited_fit_lines) { // a 151 alert record: lines already fact-cited at the watch tier
      fitLines = posting._inherited_fit_lines.slice();
      factIds = (posting._inherited_fact_ids || []).slice();
      if (fit) { score = fit.score; bucket = fit.bucket; }
    } else if (fit) {
      // Reuse 151's composer so the fact-citation law has ONE implementation.
      const rec = Watch ? Watch.composeAlert(posting, fit, wp.scoring_profile || {}, now) : null;
      if (rec) { fitLines = rec.fit_lines; factIds = rec.matched_fact_ids; }
      score = fit.score; bucket = fit.bucket;
    }
    // MI-028: append the match-basis lines after any proven-skill lines.
    // Dedupe: an inherited 151 match-basis role line already citing the same
    // term covers the role basis (never state the same basis twice); the
    // location/band lines are 152-only and always append when true.
    for (const line of matchBasisLines(posting, interest, verdict)) {
      if (fitLines.includes(line)) continue;
      const term = verdict.match_detail && verdict.match_detail.term;
      if (term && /^match basis: watched role term /.test(line)
        && fitLines.some((l) => /^match basis:/.test(l) && lc(l).includes(`"${lc(term)}"`))) continue;
      fitLines.push(line);
    }
    const company = s(posting.company) || null;
    return {
      type: "career_job_reminder",
      reminder_id: null, // set at enqueue from the seat key + job id
      user_id: wp.user_id,
      interest_id: interest.interest_id,
      role_title: interest.role.title,
      soc: interest.role.soc || null,
      job_id: posting.job_id,
      company,
      company_stated: !!company, // TN-1a: unstated is a value, never a drop and never an invention
      title: posting.title,
      location: posting.location || null,
      remote: posting.remote || null,
      url: posting.url,
      source: posting.source,
      posted_at: posting.posted_at || null,
      // MI-106 (Spec 2 §2.5): a first-seen posting the source dates >60 days
      // old is flagged possibly-stale IN the reminder; a repost is flagged
      // reposted. Both come from 121's verdict on the posting/alert record —
      // never re-derived here from the raw date alone.
      possibly_stale: posting.possibly_stale === true,
      reposted: posting.reposted === true,
      repost_count: posting.repost_count || 0,
      detected_at: new Date(now).toISOString(),
      deadline: extractDeadline(posting),
      fit: { score, bucket, lines: fitLines, matched_fact_ids: factIds },
      match_basis: verdict.match_basis || null,
      match_detail: verdict.match_detail || null, // MI-028: the auditable basis behind the match-basis fit lines
      dedupe_key: Jobs ? Jobs.dedupeKey({ company: company || "not-stated", title: posting.title, location: posting.location || "" }) : `${company || "not-stated"}|${posting.title}`,
      status: "queued",
      queued_at: new Date(now).toISOString(),
    };
  }

  function speakLine(r) {
    const who = r.company_stated ? r.company : "an employer whose name is not stated in the posting";
    const dl = r.deadline ? ` Deadline, in the posting's own words: "${r.deadline.text}".` : "";
    const fit = r.fit && r.fit.lines && r.fit.lines.length ? ` ${r.fit.lines[0]}.` : "";
    const stale = r.possibly_stale ? " Possibly stale: this posting was first seen today but its source dates it more than 60 days old." : "";
    return `New ${r.role_title} posting: ${r.title} at ${who}${r.location ? ` — ${r.location}` : ""}.${fit}${dl}${stale} Apply: ${r.url}`;
  }

  // ---- reminder queue (the delivery contract) ----------------------------------
  function createReminderQueue(store, userId) {
    const key = QUEUE_KEY(userId);
    const read = async () => (await store.get(key)) || [];
    const write = async (rows) => { await store.set(key, rows); };
    return {
      key,
      async enqueue(reminder) {
        const rows = await read();
        if (rows.some((x) => x.reminder_id === reminder.reminder_id)) return false;
        rows.push(reminder);
        await write(rows);
        return true;
      },
      async peek(limit) { const rows = await read(); return limit ? rows.slice(0, limit) : rows.slice(); },
      async size() { return (await read()).length; },
      // Drain = the host's delivery pull: returns the oldest records and
      // removes exactly those; a record is never delivered twice by the queue.
      async drain(limit) {
        const rows = await read();
        const n = limit == null ? rows.length : Math.min(limit, rows.length);
        const out = rows.slice(0, n);
        await write(rows.slice(n));
        return out.map((r) => Object.assign({}, r, { status: "drained", drained_at: new Date().toISOString() }));
      },
    };
  }

  // ---- MI-117 fatigue policy (Spec 2 §4.1/§4.4 — the delivery layer) --------
  // Until this build the delivery layer had no throttle of any kind: the day
  // the scheduler landed, every reminder the queue produced would have been
  // delivered the moment it was composed, at any hour, in any volume. The
  // policy, in the spec's own numbers:
  //   - quiet hours 22:00–08:00 in the USER's timezone; nothing delivers
  //     inside them unless the user opted into night alerts;
  //   - at most 5 instant alerts per day (user-raisable via opts.instantCap);
  //     further matches FOLD into the morning digest regardless of score;
  //   - near-simultaneous openings at one company — arrivals chained within
  //     a 10-minute window — collapse into ONE batched alert that counts
  //     once against the budget;
  //   - the digest flushes as ONE delivery at the first plan on a new day
  //     outside quiet hours (08:00 is quiet's end — the morning digest);
  //   - a skip is a delivered alert with no open (reported back through
  //     noteDeliveryOutcome / recordDeliveryOutcome); 3 consecutive skips
  //     TIGHTEN: the instant threshold rises one bucket tier (Reach-bucket
  //     units fold to the digest even with budget left) and the daily cap
  //     drops 5 -> 3, announced in exactly one sentence carried on the next
  //     delivered unit; 3 consecutive opens restore the standard policy.
  // planDeliveries is pure — state in, plan out; the host persists the state
  // under DELIVERY_KEY in the same per-user store and delivers exactly the
  // units the plan returns (a unit's members are delivered together, under
  // the unit's own record). Nothing here invents engagement: skips and opens
  // exist only when the product reports them.
  const DELIVERY_KEY = (uid) => `career:delivery-state:${uid}`;
  const FATIGUE = {
    instantCapPerDay: 5,
    tightenedCapPerDay: 3,
    skipStreakToTighten: 3,
    opensToRestore: 3,
    quietStartMin: 22 * 60,
    quietEndMin: 8 * 60,
    batchWindowMs: 10 * 60 * 1000,
  };
  const TIGHTEN_NOTICE = "You haven't opened the last three alerts, so I'm tightening what reaches you instantly — the daily cap drops to 3 and lower-ranked matches go to your morning digest until you start opening them again.";
  const BUCKET_RANK = { Reach: 0, Match: 1, Safety: 2 };
  const bucketRank = (r) => {
    const b = r && r.fit && r.fit.bucket;
    return b && b in BUCKET_RANK ? BUCKET_RANK[b] : 0;
  };

  function defaultDeliveryState(userId) {
    return {
      type: "career_delivery_state", version: 1, user_id: s(userId),
      day: null, instant_sent: 0, digest_ids: [],
      skip_streak: 0, open_streak: 0, tightened: false, notice_pending: null,
      updated_at: null,
    };
  }
  async function loadDeliveryState(store, userId) {
    const raw = await store.get(DELIVERY_KEY(userId));
    return raw && raw.type === "career_delivery_state" && raw.user_id === s(userId) ? raw : null;
  }
  async function saveDeliveryState(store, state) {
    if (!state || state.type !== "career_delivery_state" || !s(state.user_id))
      throw new Error("invalid delivery state (type + user_id required — delivery state is per-user)");
    state.updated_at = new Date().toISOString();
    await store.set(DELIVERY_KEY(state.user_id), state);
    return state;
  }

  function localParts(now, tzOffsetMinutes) {
    const shifted = new Date(nowMs(now) + (tzOffsetMinutes || 0) * 60000);
    return { day: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
  }
  function inQuiet(minutes, quiet) {
    const a = quiet && quiet.startMin != null ? quiet.startMin : FATIGUE.quietStartMin;
    const b = quiet && quiet.endMin != null ? quiet.endMin : FATIGUE.quietEndMin;
    return a <= b ? (minutes >= a && minutes < b) : (minutes >= a || minutes < b);
  }

  function batchSpeakLine(unit) {
    const members = unit.reminders;
    const company = unit.company;
    const roles = [...new Set(members.map((m) => m.role_title).filter(Boolean))];
    const head = roles.length === 1
      ? `${members.length} new ${roles[0]} postings${company ? ` at ${company}` : ""}`
      : `${members.length} new postings${company ? ` at ${company}` : ""}`;
    const parts = members.map((m) =>
      `"${m.title}"${m.location ? ` — ${m.location}` : ""}${m.deadline ? ` (deadline, in the posting's own words: "${m.deadline.text}")` : ""}`);
    const links = members.map((m) => m.url).filter(Boolean);
    return `${head}: ${parts.join("; ")}.${links.length ? ` Apply: ${links.join(" · ")}` : ""}`;
  }
  function digestSpeakLine(unit) {
    const members = unit.reminders;
    const parts = members.map((m) =>
      `${m.company ? `${m.company}: ` : ""}"${m.title}"${m.deadline ? ` (deadline, in the posting's own words: "${m.deadline.text}")` : ""}`);
    const links = members.map((m) => m.url).filter(Boolean);
    return `Your morning digest — ${members.length} posting${members.length === 1 ? "" : "s"} held for you: ${parts.join("; ")}.${links.length ? ` Apply: ${links.join(" · ")}` : ""}`;
  }

  function planDeliveries(reminders, state, opts) {
    opts = opts || {};
    const input = (reminders || []).slice();
    const uid = (state && state.user_id) || opts.userId || (input[0] && input[0].user_id);
    if (!uid) throw new Error("152 planDeliveries requires a user (state, opts.userId, or the reminders' user_id)");
    const st = Object.assign(defaultDeliveryState(uid), state ? JSON.parse(JSON.stringify(state)) : {});
    const now = nowMs(opts.now);
    const lp = localParts(now, opts.tzOffsetMinutes || 0);
    const quiet = inQuiet(lp.minutes, opts.quiet) && !opts.nightOptIn;

    const dayChanged = st.day !== lp.day;
    if (dayChanged) { st.day = lp.day; st.instant_sent = 0; }

    const foldedIds = new Set(st.digest_ids);
    const priorDigest = input.filter((r) => foldedIds.has(r.reminder_id));
    const fresh = input.filter((r) => !foldedIds.has(r.reminder_id));

    const units = [], digested = [], held = [];
    // Quiet hours hold EVERYTHING, the digest flush included (the flush's
    // own hour — 08:00 — is quiet's end by construction).
    if (quiet) {
      return { units, digested, held: input.slice(), flushed: null, notice: null, state: st };
    }
    // Morning flush: a new day (or a forced flush) delivers the fold as one
    // digest unit and clears it. The flush is not an instant alert and does
    // not consume the day's budget.
    let flushed = null;
    if ((dayChanged || opts.flushDigest) && priorDigest.length) {
      flushed = { kind: "digest", company: null, reminders: priorDigest.slice() };
      flushed.speak_line = digestSpeakLine(flushed);
      units.push(flushed);
      st.digest_ids = st.digest_ids.filter((id) => !priorDigest.some((r) => r.reminder_id === id));
    } else {
      held.push(...priorDigest); // folded earlier, flush not due — stays folded
    }

    // Batch: chain-group fresh arrivals by company, consecutive arrivals
    // within the 10-minute window in one group. Unstated-company postings
    // never batch together (TN-1a: "not stated" is not a company).
    const sorted = fresh.slice().sort((a, b) => Date.parse(a.detected_at || 0) - Date.parse(b.detected_at || 0));
    const openGroups = new Map();
    const groups = [];
    for (const r of sorted) {
      const key = r.company ? `co:${lc(r.company)}` : `solo:${r.reminder_id}`;
      const at = Date.parse(r.detected_at || 0) || now;
      const g = openGroups.get(key);
      if (g && at - g.lastAt <= FATIGUE.batchWindowMs) { g.reminders.push(r); g.lastAt = at; }
      else { const ng = { key, company: r.company || null, reminders: [r], lastAt: at }; openGroups.set(key, ng); groups.push(ng); }
    }
    const cap = st.tightened ? FATIGUE.tightenedCapPerDay : (opts.instantCap || FATIGUE.instantCapPerDay);
    for (const g of groups) {
      const unit = g.reminders.length > 1
        ? { kind: "batch", company: g.company, reminders: g.reminders }
        : { kind: "instant", company: g.company, reminders: g.reminders };
      if (unit.kind === "batch") unit.speak_line = batchSpeakLine(unit);
      else unit.speak_line = speakLine(g.reminders[0]);
      // Tightened threshold: a unit whose weakest member ranks below Match
      // folds to the digest even with budget left.
      if (st.tightened && Math.min(...g.reminders.map(bucketRank)) < 1) {
        digested.push(...g.reminders);
        for (const r of g.reminders) if (!st.digest_ids.includes(r.reminder_id)) st.digest_ids.push(r.reminder_id);
        continue;
      }
      if (st.instant_sent < cap) { st.instant_sent += 1; units.push(unit); }
      else {
        digested.push(...g.reminders);
        for (const r of g.reminders) if (!st.digest_ids.includes(r.reminder_id)) st.digest_ids.push(r.reminder_id);
      }
    }

    // The tightening notice rides the next delivered unit, exactly once.
    let notice = null;
    if (st.notice_pending && units.length) {
      notice = st.notice_pending;
      units[0] = Object.assign({}, units[0], { notice });
      st.notice_pending = null;
    }
    return { units, digested, held, flushed, notice, state: st };
  }

  // One reported delivery outcome. Pure: the caller persists the returned
  // state (recordDeliveryOutcome does it against the store).
  function noteDeliveryOutcome(state, outcome) {
    const st = Object.assign(defaultDeliveryState(state && state.user_id), state ? JSON.parse(JSON.stringify(state)) : {});
    let notice = null;
    if (outcome === "skipped") {
      st.skip_streak += 1; st.open_streak = 0;
      if (st.skip_streak >= FATIGUE.skipStreakToTighten && !st.tightened) {
        st.tightened = true;
        st.notice_pending = TIGHTEN_NOTICE;
        notice = TIGHTEN_NOTICE;
      }
    } else if (outcome === "opened" || outcome === "acted") {
      st.open_streak += 1; st.skip_streak = 0;
      if (st.tightened && st.open_streak >= FATIGUE.opensToRestore) st.tightened = false;
    }
    return { state: st, notice };
  }
  async function recordDeliveryOutcome(store, userId, outcome) {
    const cur = (await loadDeliveryState(store, userId)) || defaultDeliveryState(userId);
    const r = noteDeliveryOutcome(cur, outcome);
    await saveDeliveryState(store, r.state);
    return r;
  }

  // ---- the assignment cycle ------------------------------------------------------
  function normalizeCandidate(c) {
    if (c && c.type === "career_job_alert") {
      return {
        job_id: c.job_id, company: c.company || "", title: c.title, location: c.location || "",
        remote: /remote/i.test(c.location || "") ? "remote" : "onsite",
        url: c.url, posted_at: c.posted_at || null, source: c.source,
        seniority_band: c.seniority_band, role_family: c.role_family,
        // BUG-207 / FR-364: preserve the posting's own text the alert record
        // carries (151 composeAlert, BUG-207) — blanking it here made
        // extractDeadline see an empty string (deadline null on every
        // alert-fed reminder) and removed roleMatch's JD-head leg.
        jd_text: c.jd_text || "",
        // MI-106: 121's repost/stale verdicts ride the alert record (151) —
        // preserve them so the reminder can flag a possibly-stale posting.
        reposted: c.reposted === true, repost_count: c.repost_count || 0,
        possibly_stale: c.possibly_stale === true, first_seen_at: c.first_seen_at || null,
        _inherited_fit: c.fit || null, _inherited_fit_lines: c.fit_lines || [], _inherited_fact_ids: c.matched_fact_ids || [],
      };
    }
    return c;
  }

  async function runAssignCycle(deps) {
    if (!Jobs) throw new Error("152 requires 121-career-jobs alongside it");
    deps = deps || {};
    const wp = deps.watchProfile;
    if (!wp) throw new Error("152 runAssignCycle requires a watchProfile (createWatchProfile)");
    const v = validateWatchProfile(wp);
    if (!v.ok) throw new Error(`invalid watch profile: ${v.errors.join("; ")}`);
    const store = deps.store;
    if (!store || typeof store.get !== "function" || typeof store.set !== "function")
      throw new Error("152 runAssignCycle requires an injected store {get,set}");
    const now = nowMs(deps.now);
    const candidates = [...(deps.alerts || []), ...(deps.postings || [])].map(normalizeCandidate);
    const queue = createReminderQueue(store, wp.user_id);
    const history = (await store.get(HISTORY_KEY(wp.user_id))) || {};
    const optedOutCompanies = ((wp.opt_out || {}).companies || []).map(lc);

    const reminders = [], suppressed = [], rejected = [];
    const cycleSeats = new Set();
    const summary = new Map(); // interest_id -> { considered, reasons: {class: count} }
    const bump = (iid, reasons) => {
      if (!summary.has(iid)) summary.set(iid, { interest_id: iid, considered: 0, reasons: {} });
      const row = summary.get(iid);
      row.considered += 1;
      for (const r of reasons) {
        const cls = /blocker/.test(r) ? "seniority_blocker" : /band is/.test(r) ? "band" : /location/.test(r) ? "location" : /firm/.test(r) ? "firm_filter" : /hard-excluded/.test(r) ? "scorefit_excluded" : /no term/.test(r) ? "role_no_match" : "other";
        row.reasons[cls] = (row.reasons[cls] || 0) + 1;
      }
    };

    for (const posting of candidates) {
      // Opt-out binds before any matching (shared cross-user suppression is a
      // host store; the per-user + per-company opt-outs live on the profile).
      if (wp.opt_out && wp.opt_out.global) { suppressed.push({ job_id: posting.job_id, reason: "opt-out: the user has opted out of job reminders globally" }); continue; }
      if (posting.company && optedOutCompanies.includes(lc(posting.company))) { suppressed.push({ job_id: posting.job_id, reason: `opt-out: the user opted out of ${posting.company}` }); continue; }

      let best = null;
      for (const interest of wp.interests) {
        const verdict = matchInterest(posting, interest, wp.scoring_profile);
        if (!verdict.matched) { rejected.push({ job_id: posting.job_id, interest_id: interest.interest_id, reasons: verdict.reasons }); bump(interest.interest_id, verdict.reasons); continue; }
        const reminder = composeReminder(posting, interest, verdict, wp, now);
        if (!best || ((reminder.fit.score || 0) > (best.reminder.fit.score || 0))) best = { reminder, interest };
      }
      if (!best) continue;

      // Seat suppression (151 BUG-092 semantics, persisted per user): the same
      // seat reminded within 14 days never re-reminds — a re-presented req is
      // the same seat; a replacement req while the old one is gone is a repost
      // (absorb the new id); a replacement while the old one still stands is a
      // seat-count change and DOES remind. Presence comes from the host's 151
      // snapshots (deps.presentJobIds); without it, a different req id is
      // treated as a new seat — we never eat a possibly-real req on a guess —
      // but a second candidate for the same seat inside ONE cycle is always
      // the cross-board duplicate 151 names.
      const r = best.reminder;
      const seat = history[r.dedupe_key];
      if (cycleSeats.has(r.dedupe_key)) { suppressed.push({ job_id: r.job_id, reason: "cross-board duplicate: same seat already reminded this cycle" }); continue; }
      if (seat && now - seat.reminded_at < SEAT_WINDOW_MS) {
        if ((seat.job_ids || []).includes(r.job_id)) { suppressed.push({ job_id: r.job_id, reason: "same req re-presented — seat already reminded" }); continue; }
        if (deps.presentJobIds && !(seat.job_ids || []).some((id) => deps.presentJobIds.has(id))) {
          seat.job_ids = (seat.job_ids || []).concat([r.job_id]);
          suppressed.push({ job_id: r.job_id, reason: "repost of a reminded seat (prior req gone, within 14 days) — absorbed" });
          continue;
        }
      }
      r.reminder_id = `rem:${r.dedupe_key}:${r.job_id}`;
      const added = await queue.enqueue(r);
      if (added) {
        reminders.push(r);
        cycleSeats.add(r.dedupe_key);
        const ids = new Set(seat ? seat.job_ids || [] : []); ids.add(r.job_id);
        history[r.dedupe_key] = { job_ids: [...ids], reminded_at: now };
      } else suppressed.push({ job_id: r.job_id, reason: "already queued (duplicate reminder suppressed)" });
    }
    await store.set(HISTORY_KEY(wp.user_id), history);

    return {
      type: "career_assign_cycle",
      user_id: wp.user_id,
      at: new Date(now).toISOString(),
      considered: candidates.length,
      reminders,
      suppressed,
      rejected,
      no_match_summary: [...summary.values()],
      queue_depth: await queue.size(),
    };
  }

  return { createWatchProfile, validateWatchProfile, upsertInterest, removeInterest, setOptOut,
    saveWatchProfile, loadWatchProfile, roleSpecFor, SPLITS, matchInterest, matchBasisLines, composeReminder,
    speakLine, extractDeadline, createReminderQueue, runAssignCycle,
    defaultDeliveryState, loadDeliveryState, saveDeliveryState, planDeliveries,
    noteDeliveryOutcome, recordDeliveryOutcome, batchSpeakLine, digestSpeakLine,
    PROFILE_KEY, QUEUE_KEY, HISTORY_KEY, DELIVERY_KEY, FATIGUE, TIGHTEN_NOTICE, SEAT_WINDOW_MS,
    REGION_TABLE, regionsOf, restrictionsOf, postingScope, locationOk };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerAssign;
