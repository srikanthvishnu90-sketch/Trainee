/* Career warm-path graph (REF-001..010; SC-161..175 slice, w09).
   Pure domain logic, UMD like 124/126/127. User-owned data ONLY: LinkedIn export,
   alumni directory, club roster, pasted contacts — no scraping, no LinkedIn automation.
   Nothing here sends: every ask is a draft on a card until the user approves it.
   Honesty rules: warmth is never inflated (cross-city alumni are discounted AND the
   discount is disclosed); a departed contact is never written to blindly; a contact at
   the user's CURRENT employer is excluded by default with the reason surfaced;
   referral-bonus amounts are reported ONLY from a CIR field that carries them —
   no CIR in the corpus carries a bonus amount, so bonus intel says so (BUG-122).
   Persistence is injected: makeGraphStore() -> { people, interactions, referrals }.
   The application-row seam is 126-career-track (vendored from origin/career/sc-f04):
   markReferralSubmitted writes source/referred_by + a referral_submitted event onto
   the matching application row in that store.
   CONSOLIDATION (item-10 dedupe, 2026-10-13): this module is the SINGLE warm-path
   graph engine. 138-career-graphcore.js (the w08 engine, renamed at the sc-w08 merge
   in c2b2c03) is retired and deleted; everything it uniquely provided is ported
   below, adapted to THIS schema (full_name/current_firm/schools[]): createGraph +
   importRecords (with an adapter for 138-shaped records: name/company/school/email/
   position/connectedVia/publicLinks), STAGES + setStage, recordInteraction,
   rankPaths/topWarmPathSweep/secondDegreeMap, publicSourceLookup, mentorMap,
   planReferralAsk, recordReferralSignal, linkReferralToApplication,
   conversionTracking, keepWarmSuggestions, draftUpdateTouch, draftIntroRequest,
   importLinkedInCsv, snapshot/newHireRadar, byName/atCompany, sharedFacts/warmthOf.
   DROPPED from 138: its parallel person/store schema (name/company/school singular,
   P-###-only identity — importRecords adapts those records in, it does not keep a
   second store), and its standalone `norm` export (135's internal norm covers it).
   WARMTH CONFLICT, decided: 135's rankWarmth (additive numeric score, cross-city
   alumni -15 disclosed) is UNCHANGED and remains the scoring for the w09 family
   (findPaths/pickStrongerPath/miniCampaign). The ported rankPaths/warmthOf keep
   138's canonical TIER precedence (alumni > club > major > hometown > cold,
   tier points 50/40/30/20) because SC-147 pins that exact order and 135's additive
   points (major 10 < hometown 15) would invert major/hometown in a tier ranking.
   The two models therefore coexist by surface: numeric score on rankWarmth rows,
   canonical tier on rankPaths rows — never mixed in one row.
   DUAL-SHAPE returns (both pinned by tests, kept deliberately): relationshipMemory
   returns the union of 135's fields (person/last/summary) and 138's (company/stage/
   chats/last_contact_at/last_summary); forwardableBlurb dispatches on its first
   argument — (profile, facts) is the 135 shape (lines as {text, fact_id} objects),
   (graphStore, profile122Profile) is the ported 138 shape (lines as strings +
   fact_ids array). */
const CareerGraph = (() => {
  "use strict";
  // CLOCK-SOURCE (BUG-198 class, FR-383): the turn clock arrives as
  // numeric epoch ms from the router/host and Date.parse(number) is
  // NaN. Coerce type-safely — a finite number passes through, a
  // string parses, anything else is NaN and the caller defaults.
  // (Closure-local name: the bundle concatenates files into one
  // module scope, so file-scope helper names must be unique.)
  const clockMsOf = (v) => { if (v == null) return NaN; if (typeof v === "number") return Number.isFinite(v) ? v : NaN; const t = Date.parse(v); return Number.isNaN(t) ? NaN : t; };
  const s = (v) => (v == null ? "" : String(v));
  const lc = (v) => s(v).toLowerCase();
  const norm = (v) => lc(v).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const normCo = (v) => norm(v).replace(/\b(inc|llc|ltd|corp|the)\b/g, " ").replace(/\s+/g, " ").trim();
  function hash(str) { let h = 0x811c9dc5; const t = s(str); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }

  function makeGraphStore() { return { people: [], interactions: [], referrals: [], snapshots: [], _seq: 0, user: null }; }
  function createGraph(user) { const store = makeGraphStore(); store.user = Object.assign({ name: "", school: null, major: null, hometown: null, clubs: [] }, user || {}); return store; }
  function normalizePerson(r) {
    return Object.assign({ person_id: null, full_name: "", current_firm: "", prior_firms: [], title: "", role_kind: null,
      geography: "", office: "", schools: [], major: null, hometown: null, clubs: [], work_email: null, linkedin: null,
      relationship_to_user: "none", connection_degree: null, at_company: true, departed_at: null, next_firm: null,
      is_professor: false, is_family_friend: false, source_list: [], last_verified_at: null, label: null,
      stage: "cold", chats: 0, last_contact_at: null, connected_via: null, connected_on: null, joined_company_at: null, prior_company: null, public_links: [] }, r || {});
  }
  // Identity keys: exact email / exact linkedin / name+firm / name+school (never name alone).
  function identityKeys(p) {
    const keys = [];
    if (p.work_email) keys.push("email:" + norm(p.work_email));
    if (p.linkedin) keys.push("li:" + norm(p.linkedin).replace(/ /g, ""));
    if (p.full_name && p.current_firm) keys.push("nf:" + norm(p.full_name) + "@" + normCo(p.current_firm));
    if (p.full_name && (p.schools || []).length) keys.push("ns:" + norm(p.full_name) + "@" + norm(p.schools[0]));
    return keys;
  }
  function mergeInto(a, b) {
    for (const k of ["title", "role_kind", "geography", "office", "major", "hometown", "work_email", "linkedin", "relationship_to_user", "connection_degree", "departed_at", "next_firm", "last_verified_at", "label"])
      if ((a[k] == null || a[k] === "") && b[k] != null && b[k] !== "") a[k] = b[k];
    if (b.at_company === false) { a.at_company = false; }
    for (const k of ["schools", "clubs", "prior_firms", "source_list", "public_links"]) a[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])];
    for (const k of ["connected_via", "connected_on", "joined_company_at", "last_contact_at"]) if (!a[k] && b[k]) a[k] = b[k];
    if (b.chats) a.chats = Math.max(a.chats || 0, b.chats); if (b.stage && b.stage !== "cold") a.stage = b.stage;
    if (b.is_professor) a.is_professor = true;
    if (b.is_family_friend) a.is_family_friend = true;
    return a;
  }
  function mergeIdentities(records) {
    const out = []; const merges = []; const byKey = new Map();
    for (const raw of records || []) {
      const r = normalizePerson(raw);
      if (!r.person_id) r.person_id = "person-" + hash(norm(r.full_name) + "|" + norm(r.work_email || r.linkedin || r.current_firm));
      const keys = identityKeys(r);
      let hit = null;
      for (const k of keys) if (byKey.has(k)) { hit = byKey.get(k); break; }
      if (hit) { merges.push({ kept: hit.person_id, absorbed_name: r.full_name, sources: r.source_list, keys_matched: keys.filter((k) => byKey.has(k)) }); mergeInto(hit, r); for (const k of keys) byKey.set(k, hit); }
      else { out.push(r); for (const k of keys) byKey.set(k, r); }
    }
    return { people: out, merges, input_count: (records || []).length, merged_count: out.length };
  }
  function importGraph(store, sources) {
    const all = [];
    for (const src of sources || []) for (const r of src.records || []) all.push(Object.assign({}, r, { source_list: [...new Set([...(r.source_list || []), src.source])] }));
    const { people, merges } = mergeIdentities(all);
    store.people = people;
    return { imported: all.length, people: store.people.length, merges, sources: (sources || []).map((x) => x.source) };
  }

  // ---------- warmth ----------
  // Base points mirror 124 rankContacts (alumni 40 / shared org 25 / hometown 15 / 1st-degree 20)
  // plus: major 10, club roster 25, professor 30, family friend 35, warm interaction history up to 15.
  // Honest discounts, always disclosed in `adjustments`: cross-city alumni -15 (SC-173),
  // departed contact -> excluded, current-employer contact -> excluded (SC-171).
  function rankWarmth(person, profile, opts) {
    opts = opts || {}; profile = profile || {};
    const p = normalizePerson(person); const why = []; const adjustments = []; let score = 0;
    const rel = norm(p.relationship_to_user);
    if (profile.school && (p.schools || []).map(norm).includes(norm(profile.school))) { score += 40; why.push("alumni:" + profile.school); }
    if ((p.clubs || []).length && profile.clubs && (p.clubs || []).some((c) => (profile.clubs || []).map(norm).includes(norm(c)))) { score += 25; why.push("shared club"); }
    else if (/club|fraternity|same org/.test(rel)) { score += 25; why.push("shared org"); }
    if (profile.major && p.major && norm(profile.major) === norm(p.major)) { score += 10; why.push("same major"); }
    if (profile.hometown && p.hometown && norm(profile.hometown) === norm(p.hometown)) { score += 15; why.push("same hometown"); }
    if (p.connection_degree === 1 || /1st|first/.test(rel)) { score += 20; why.push("1st-degree"); }
    else if (p.connection_degree === 2 || /2nd|second|mutual/.test(rel)) { score += 10; why.push("2nd-degree via mutual"); }
    if (p.is_professor) { score += 30; why.push("professor"); }
    if (p.is_family_friend) { score += 35; why.push("family friend"); }
    if (/recruiter/.test(norm(p.role_kind || p.title))) why.push("recruiter (routing ask, not practitioner ask)");
    const lastDays = opts.lastInteractionDaysAgo;
    if (lastDays != null) { if (lastDays <= 30) { score += 15; why.push("talked within 30 days"); } else if (lastDays <= 90) { score += 8; why.push("talked within 90 days"); } else if (lastDays >= 180) adjustments.push({ delta: 0, note: `dormant: last interaction ${lastDays} days ago — warmth is historical, not current` }); }
    // SC-173: alumni in a different city than the ROLE — discount and disclose, never inflate.
    let crossCity = false;
    if (opts.roleCity && (p.geography || p.office)) {
      const pc = norm(p.geography || p.office), rc = norm(opts.roleCity);
      if (pc && !pc.includes(rc) && !rc.includes(pc)) { crossCity = true; score -= 15; adjustments.push({ delta: -15, note: `cross-city: contact is in ${p.geography || p.office}, role is in ${opts.roleCity} — alumni warmth discounted, not inflated` }); }
    }
    return { person_id: p.person_id, name: p.full_name, firm: p.current_firm, score: Math.max(0, score), why, adjustments, cross_city: crossCity };
  }
  function exclusionFor(p, profile) {
    if (p.at_company === false) return { excluded: true, reason: "departed", detail: `left ${p.current_firm}${p.departed_at ? " (" + p.departed_at + ")" : ""}${p.next_firm ? " — now at " + p.next_firm : ""}; do not write to them as a ${p.current_firm} contact` };
    if (profile && profile.current_employer && normCo(p.current_firm) === normCo(profile.current_employer))
      return { excluded: true, reason: "current_employer", detail: `${p.full_name} sits at your current employer (${profile.current_employer}) — excluded by default; asking there can surface your search at work. Override only knowingly, in person, on a card.` };
    return { excluded: false };
  }
  function findPaths(store, company, profile, opts) {
    opts = opts || {};
    const rows = (store.people || []).filter((p) => normCo(p.current_firm) === normCo(company));
    const paths = [], excluded = [];
    for (const p of rows) {
      const ex = exclusionFor(p, profile);
      const w = rankWarmth(p, profile, opts);
      const row = Object.assign({}, w, { title: p.title, role_kind: p.role_kind || null, relationship: p.relationship_to_user, sources: p.source_list });
      if (ex.excluded && !opts.includeExcluded) { excluded.push(Object.assign({}, row, { exclusion: ex })); continue; }
      if (ex.excluded) row.exclusion = ex;
      paths.push(row);
    }
    paths.sort((a, b) => b.score - a.score); excluded.sort((a, b) => b.score - a.score);
    // GATE-3 record completion (03 F4 doorstep): the referral/intro draft
    // for each ranked path is represented as a HELD CARD on this record —
    // never a loose draft and never sent. The card holds the ask slot for
    // that person; the draft text itself is composed on the card only
    // when its turn comes (a referral ask never goes in email one — it
    // follows a good chat, SC-151) and nothing sends until the user
    // approves the card. Excluded (departed / current-employer) contacts
    // get NO card: there is no ask to hold for them.
    const draftCards = paths.map((p) => ({
      card_id: "path-card-" + (p.person_id || hash(norm(p.name) + "@" + normCo(p.firm))),
      kind: "referral_intro_draft", status: "held", held_as_card: true,
      person_id: p.person_id || null, name: p.name, firm: p.firm,
      draft: null, sends: 0, requires_card_approval: true,
      note: "Held as a card — not drafted loose, not sent. The intro/referral draft is composed on this card when its turn comes and sends only on the user's approval of the card.",
    }));
    return { company, paths, excluded, best: paths[0] || null, draft_cards: draftCards, drafts_held_as_cards: draftCards };
  }
  function pickStrongerPath(store, company, profile, opts) {
    const { paths, excluded } = findPaths(store, company, profile, opts);
    if (!paths.length) return { company, chosen: null, held: [], excluded, reason: "no live path at this company" };
    const [chosen, ...rest] = paths;
    return { company, chosen, held: rest.map((r) => Object.assign({}, r, { held_reason: "weaker path — held, not contacted, so the two asks never collide or burn both contacts" })), excluded,
      rationale: `${chosen.name} scores ${chosen.score} (${chosen.why.join(", ") || "no shared fact"}) vs ${rest.length ? rest[0].name + " at " + rest[0].score : "no second path"}. One ask, through the stronger path only.` };
  }
  function departedNextPath(store, departedName, profile, opts) {
    const dep = (store.people || []).find((p) => norm(p.full_name) === norm(departedName));
    if (!dep) return { found: false, departed: departedName };
    const company = dep.current_firm;
    const res = findPaths(store, company, profile, opts);
    return { found: true, departed: { name: dep.full_name, firm: company, departed_at: dep.departed_at || null, next_firm: dep.next_firm || null, do_not_contact_as: company + " contact" },
      next_paths: res.paths, note: res.paths.length ? `Next path at ${company}: ${res.paths[0].name} (${res.paths[0].why.join(", ") || "cold"}).` : `No other live path at ${company} in your graph — a mini-campaign (SC-170 pattern) is the honest next step, not writing to the departed contact.` };
  }

  // ---------- relationship memory / keep-warm ----------
  function relationshipMemory(store, name) {
    const person = (store.people || []).find((p) => norm(p.full_name) === norm(name)) || null;
    const rows = (store.interactions || []).filter((i) => (person && i.person_id && i.person_id === person.person_id) || norm(i.full_name || i.name || "") === norm(name)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const chats = person ? (person.chats || rows.filter((i) => i.kind === "coffee_chat" || i.channel === "coffee_chat").length) : 0;
    if (!rows.length) return { name, found: !!person, person, last: null, history: [], summary: person ? "In your graph, but no interaction logged yet." : "Not in your graph.",
      company: person ? person.current_firm : null, stage: person ? (person.stage || "cold") : null, chats, last_contact_at: person ? (person.last_contact_at || null) : null, last_summary: null };
    const last = rows[rows.length - 1];
    return { name, found: true, person, last: { at: last.at, channel: last.channel || last.kind || null, topic: last.topic || null, summary: last.summary || null, outcome: last.outcome || null },
      history: rows, summary: `Last talked ${last.at}: ${last.summary || last.topic || "(no summary logged)"}`,
      company: person ? person.current_firm : null, stage: person ? (person.stage || "cold") : null, chats,
      last_contact_at: (person && person.last_contact_at) || last.at || null, last_summary: last.summary || null };
  }
  function keepWarm(store, opts) {
    opts = opts || {}; const now = (() => { const t = clockMsOf(opts.now); return Number.isNaN(t) ? Date.now() : t; })();
    const due = [];
    for (const p of store.people || []) {
      const mem = relationshipMemory(store, p.full_name);
      if (!mem.last) continue;
      const days = Math.floor((now - Date.parse(mem.last.at)) / 86400000);
      const weeks = opts.weeks || 6;
      if (days >= weeks * 7 && mem.last.outcome === "good_chat")
        due.push({ name: p.full_name, firm: p.current_firm, days_since: days, last_topic: mem.last.topic, suggested_reason: opts.reasonFor ? opts.reasonFor(p, mem) : `It has been ${days} days since your good chat about ${mem.last.topic || "your last topic"} — a short, real update keeps the path warm.`, status: "suggested_not_sent" });
    }
    return due.sort((a, b) => b.days_since - a.days_since);
  }
  function logInteraction(store, row) { const r = Object.assign({ at: new Date().toISOString() }, row); store.interactions.push(r); return r; }

  // ---------- blurb + asks (drafts only; approval card required) ----------
  function forwardableBlurb(profile, facts) {
    // Ported 138 shape: forwardableBlurb(graphStore, profile122Profile) -> lines as
    // strings + fact_ids array, built ONLY from confirmed 122 facts.
    if (profile && Array.isArray(profile.people)) {
      const graph = profile; const prof122 = facts || {};
      const confirmed = ((prof122 && prof122.facts) || []).filter((f) => !f.needs_confirmation);
      const edu = confirmed.find((f) => f.kind === "education"), exp = confirmed.find((f) => f.kind === "experience" || f.kind === "project");
      if (!edu || !exp) return { ok: false, reason: "profile_needs_education_and_experience_facts" };
      const lines = [`${(graph.user || {}).name || ""} \u2014 ${edu.text}`, `${exp.text}`, `Reachable via me; happy to share a resume on request.`];
      return { ok: true, blurb: lines.join("\n"), lines, fact_ids: [edu.id, exp.id], note: "Three lines, built only from confirmed profile facts." };
    }
    const usable = (facts || []).filter((f) => f && (f.action || f.text) && ["experience", "project", "leadership", "education"].includes(f.kind || "experience"));
    if (!usable.length || !profile || !profile.name) return { ok: false, reason: "no_real_profile_facts", blurb: null, lines: [] };
    const lines = [];
    const edu = usable.find((f) => f.kind === "education");
    lines.push({ text: `${profile.name} is a ${profile.year || "student"}${profile.school ? " at " + profile.school : ""}${edu ? " (" + (edu.title || "degree on file") + ")" : ""}.`, fact_id: edu ? edu.id : "profile" });
    const exp = usable.find((f) => f.kind === "experience") || usable[0];
    lines.push({ text: `${exp.action ? exp.action[0].toUpperCase() + exp.action.slice(1) : exp.text}${exp.result ? " — " + exp.result : ""}.`, fact_id: exp.id || null });
    const lead = usable.find((f) => f.kind === "leadership" || f.kind === "project");
    if (lead && lead !== exp) lines.push({ text: `${lead.action ? lead.action[0].toUpperCase() + lead.action.slice(1) : lead.text}${lead.result ? " — " + lead.result : ""}.`, fact_id: lead.id || null });
    const blurb = lines.map((l) => l.text).join(" ");
    return { ok: true, blurb, lines, word_count: blurb.split(/\s+/).length, rule: "Built only from real profile facts; every line carries its fact_id. Three lines, forwardable as-is." };
  }
  function askKindFor(person) {
    const p = normalizePerson(person);
    if (p.is_professor) return "professor";
    if (p.is_family_friend) return "family_friend";
    if (/recruiter|talent|hiring/.test(norm(p.role_kind || "") + " " + norm(p.title))) return "recruiter";
    return "practitioner";
  }
  function draftReferralAsk(person, user, opts) {
    opts = opts || {}; const p = normalizePerson(person); const kind = askKindFor(p);
    const first = (p.full_name || "").split(/\s+/)[0] || "there";
    if ((opts.touchNumber || 1) <= 1 && !opts.hadGoodChat)
      return { ok: false, reason: "referral_ask_never_in_email_one", kind, draft: null, rule: "A referral ask comes after a good coffee chat, never in email one (SC-151 rule carried into this slice)." };
    let body;
    if (kind === "recruiter") body = `Hi ${first},\n\nThanks for the conversation about the ${opts.role || "role"} at ${p.current_firm}. I'm applying this week — could you confirm the right requisition/team for my background and whether an employee referral should be attached before I submit, so I follow your process exactly?\n\nHappy to send my resume and the blurb below.\n\n${opts.blurb || ""}\n\nThanks,\n${user.name || ""}`;
    else if (kind === "professor") body = `Dear Professor ${p.full_name.split(/\s+/).slice(-1)[0]},\n\nI'm applying for the ${opts.role || "role"} at ${p.current_firm}, where I understand you previously worked. Would you be willing to refer me, or to point me to the right person on the team? I've attached my resume; my relevant work: ${opts.proof || "(proof from profile)"}.\n\nThank you for considering it — and for your class, which is part of why I'm aiming at this work.\n\n${user.name || ""}`;
    else if (kind === "family_friend") body = `Hi ${first},\n\nHope you and the family are well. I'm applying for the ${opts.role || "role"} at ${p.current_firm} and wanted to ask — only if you're genuinely comfortable — whether you'd be open to referring me. No pressure at all and no hard feelings either way; I completely understand if the timing or fit isn't right.\n\n${opts.blurb || ""}\n\nWith thanks,\n${user.name || ""}`;
    else body = `Hi ${first},\n\nReally enjoyed our chat${opts.chatNote ? " — " + opts.chatNote : ""}. I'm applying for the ${opts.role || "role"} at ${p.current_firm}. Would you be open to referring me? Here's a forwardable blurb so it's zero work:\n\n${opts.blurb || ""}\n\nTotally fine if not — either way, thank you for the conversation.\n\nThanks,\n${user.name || ""}`;
    return { ok: true, kind, status: "draft_only", requires_card_approval: true,
      draft: { to: p.work_email || null, person_id: p.person_id, subject: kind === "professor" ? `Referral request — ${opts.role || "role"} at ${p.current_firm}` : `Referral for ${opts.role || "the role"} at ${p.current_firm}?`, body },
      tone_note: kind === "family_friend" ? "Extra care: explicit no-pressure out, family warmth first, the user's yes required before anything sends." : kind === "recruiter" ? "Recruiter ask = process/routing (right requisition, referral attached pre-submit). Practitioner ask = endorsement. Different asks, deliberately." : null };
  }
  function thankYouReferralCombo(person, user, opts) {
    opts = opts || {};
    if (!opts.offeredToRefer) return { ok: false, reason: "no_referral_offer_on_record", draft: null, rule: "The combo is only drafted when they actually offered to refer in the chat — it is never used to manufacture an offer." };
    if (!opts.note) return { ok: false, reason: "user_note_required: the thank-you must cite one real thing said", draft: null };
    const p = normalizePerson(person); const first = (p.full_name || "").split(/\s+/)[0];
    const body = `Hi ${first},\n\nThank you for the chat — ${opts.note}\n\nAnd thank you for offering to refer me for the ${opts.role || "role"} at ${p.current_firm}. To make it zero work, here's the forwardable blurb:\n\n${opts.blurb || ""}\n\nI'll confirm the exact role link today so your referral attaches to the right posting.\n\nGrateful,\n${user.name || ""}`;
    return { ok: true, status: "draft_only", requires_card_approval: true, draft: { to: p.work_email || null, person_id: p.person_id, subject: `Thank you — and the referral blurb`, body } };
  }
  function dormantRevival(person, user, opts) {
    opts = opts || {};
    if (!opts.realUpdate || !opts.realUpdate.fact_id) return { ok: false, reason: "real_update_required", draft: null, rule: "A dormant contact is revived honestly, with a real update from your profile — never a fabricated milestone." };
    const p = normalizePerson(person); const first = (p.full_name || "").split(/\s+/)[0];
    const body = `Hi ${first},\n\nIt's been a while since we last spoke${opts.lastTopic ? " about " + opts.lastTopic : ""} — no agenda in resurrecting the thread, just a real update: ${opts.realUpdate.text}\n\nI'm now aiming at ${opts.goal || "my next step"}, and your perspective last time genuinely shaped that. Would a brief catch-up be welcome sometime in the next few weeks? No worries at all if not.\n\n${user.name || ""}`;
    return { ok: true, status: "draft_only", requires_card_approval: true, honest: true, draft: { to: p.work_email || null, person_id: p.person_id, subject: "A real update since last season", body }, update_fact_id: opts.realUpdate.fact_id };
  }

  // ---------- referral timing + lifecycle + tracking seam (126) ----------
  function referralTiming(opts) {
    opts = opts || {};
    const deadlineDays = opts.deadlineDays, eta = opts.referralEtaDays != null ? opts.referralEtaDays : 2, holdHours = opts.holdHours || 48;
    if (deadlineDays == null) return { decision: "ASK", reason: "No real deadline on file for this posting — timing cannot be decided honestly without it.", hold_hours: holdHours };
    if (deadlineDays * 24 <= holdHours + 12) return { decision: "APPLY_NOW_REFER_AFTER", reason: `Deadline is in ${deadlineDays} day(s) — inside the ${holdHours}h hold window plus a safety margin. Apply now so the application exists, then attach the referral after (most portals accept a referral note/referral link post-submit; a missed deadline accepts nothing).`, hold_hours: holdHours, eta_days: eta };
    return { decision: "WAIT_FOR_REFERRAL", max_wait_hours: holdHours, reason: `Deadline is ${deadlineDays} days out and the referral ETA is ~${eta} day(s): holding up to ${holdHours}h keeps the referral attached pre-submit without risking the deadline. Hard stop: submit at T-${Math.max(12, deadlineDays * 24 - holdHours)}h even if the referral has not landed.`, hold_hours: holdHours, eta_days: eta };
  }
  function createReferral(store, input) {
    const r = { referral_id: "ref-" + hash(s(input.company) + "|" + s(input.contact_name) + "|" + s(input.role) + "|" + (store.referrals.length + 1)),
      company: s(input.company), role: s(input.role || ""), contact_name: s(input.contact_name), contact_person_id: input.contact_person_id || null,
      ask_kind: input.ask_kind || null, status: "draft_on_card", draft: input.draft || null, created_at: new Date().toISOString(),
      approved_at: null, submitted_at: null, application_id: null, label: "TEST" };
    store.referrals.push(r); return r;
  }
  function approveReferral(store, id) { const r = store.referrals.find((x) => x.referral_id === id); if (!r) throw new Error("referral not found"); r.status = "approved_not_sent"; r.approved_at = new Date().toISOString(); return r; }
  // Seam into 126-career-track: referral submitted -> application row updated in place.
  function markReferralSubmitted(graphStore, trackStore, Track, referralId, opts) {
    opts = opts || {};
    const r = graphStore.referrals.find((x) => x.referral_id === referralId); if (!r) throw new Error("referral not found: " + referralId);
    r.status = "submitted"; r.submitted_at = opts.at || new Date().toISOString();
    let app = Track.findByCompany(trackStore, r.company);
    if (!app) app = Track.addApplication(trackStore, { company: r.company, role: r.role, role_family: opts.role_family || "SWE", source: "referred", referred_by: r.contact_name, resume_version: opts.resume_version || "", stage: "Submitted" }, { now: Date.parse(r.submitted_at) });
    else {
      app.source = "referred"; app.referred_by = r.contact_name;
      app.events.push({ type: "referral_submitted", at: r.submitted_at, source: "user-reported", detail: `referral submitted by ${r.contact_name} (TEST)`, evidence: r.referral_id });
    }
    r.application_id = app.app_id;
    return { referral: r, application: app };
  }
  function conversionByContact(store) {
    const by = {};
    for (const i of store.interactions || []) { by[i.full_name] = by[i.full_name] || { chats: 0, referrals: 0 }; if (i.outcome === "good_chat" || i.channel === "coffee_chat") by[i.full_name].chats++; }
    for (const r of store.referrals || []) { const cn = r.contact_name || r.name; if (!cn) continue; by[cn] = by[cn] || { chats: 0, referrals: 0 }; if (r.status === "submitted") by[cn].referrals++; }
    return by;
  }

  // ---------- mini-campaign at one company (SC-170) ----------
  function miniCampaign(store, company, profile, opts) {
    opts = opts || {}; const n = opts.count || 8;
    const { paths, excluded } = findPaths(store, company, profile, opts);
    const cold = (store.people || []).filter((p) => normCo(p.current_firm) === normCo(company) && !paths.some((x) => x.person_id === p.person_id) && !excluded.some((x) => x.person_id === p.person_id) && p.at_company !== false);
    const seq = paths.slice(0, n).map((p, i) => ({ order: i + 1, name: p.name, warmth: p.score, why: p.why, ask: "coffee chat first — referral ask never in email one", status: "queued_not_sent" }));
    for (const c of cold) { if (seq.length >= n) break; const w = rankWarmth(c, profile, opts); seq.push({ order: seq.length + 1, name: c.full_name, warmth: w.score, why: w.why.length ? w.why : ["cold — no shared fact on file"], ask: "coffee chat first — referral ask never in email one", status: "queued_not_sent" }); }
    return { company, count: seq.length, requested: n, sequence: seq, excluded, rule: `Sequenced warm to cold; one person at a time, replies re-rank the rest; the per-firm cap — 15 sends to one firm in 30 days — is never approached by ${n === 8 ? "an" : "a"} ${n}-person sequence.` };
  }

  // ---------- referral-bonus intel (SC-161) ----------
  function referralBonusIntel(cirs, companies) {
    const rows = [];
    for (const co of companies || []) {
      const cir = (cirs || []).find((c) => normCo(c.company_name || c.company_id) === normCo(co) || norm(c.company_id) === norm(co));
      if (!cir) { rows.push({ company: co, cir: false, bonus_amount: null, bonus_status: "NO_CIR", referral_weight: null, note: "No CIR on file — no bonus claim made." }); continue; }
      const notes = cir.referral_weight_notes || {};
      const weight = s(notes.note || notes.statement || "") || null;
      const bonusField = cir.referral_bonus || cir.referral_bonus_notes || null;
      rows.push({ company: cir.company_name || co, cir: true, company_id: cir.company_id, bonus_amount: bonusField ? (bonusField.amount || null) : null,
        bonus_status: bonusField ? "SOURCED" : "NOT_IN_CIR",
        referral_weight: weight,
        note: bonusField ? "Bonus figure carried by the CIR field, source-labeled there." : "This CIR carries referral-WEIGHT notes but no referral-BONUS amount. No amount is claimed — inventing one would be exactly the failure this program exists to prevent. Practical read from the CIR note: a referral routes you into the process; the artifacts still carry the decision, so practitioner asks (people who can speak to your work) outrank routing asks." });
    }
    return { rows, sourced_bonus_count: rows.filter((r) => r.bonus_status === "SOURCED").length,
      headline: "No target in the merged CIR corpus publishes a sourced referral-bonus amount, so none is reported. What IS sourced per company is the referral-weight note below." };
  }

  // ---------- CIR -> 127 adapter (BUG-123) ----------
  // pivot/career's normalized CIR schema (statement fields; screening_signals as
  // {stated, revealed}; hiring_bar_summary.statement) crashes 127's normalizeCir,
  // which expects the pre-normalization shapes. adaptCirForPrep converts WITHOUT
  // altering claim text; 127 itself stays vendored unchanged.
  function adaptCirForPrep(cir) {
    if (!cir) return null;
    const flat = (v) => { if (Array.isArray(v)) return v; if (v && typeof v === "object") return [...(v.stated || []), ...(v.revealed || []), ...(v.claims || [])]; return []; };
    const toText = (x) => { if (typeof x === "string") return x; if (!x) return x; const o = Object.assign({}, x); if (!o.text && (o.statement || o.summary || o.claim)) o.text = o.statement || o.summary || o.claim; return o; };
    const bar = cir.hiring_bar_summary;
    return Object.assign({}, cir, {
      hiring_bar_summary: typeof bar === "string" ? bar : { text: s(bar && (bar.statement || bar.summary || bar.text)) },
      screening_signals: flat(cir.screening_signals).map(toText),
      interview_styles: flat(cir.interview_styles).map(toText),
      values_culture_signals: flat(cir.values_culture_signals).map(toText),
      compensation_notes: flat(cir.compensation_notes).map(toText),
      process_stages: (cir.process_stages || []).map((st) => typeof st === "string" ? st : Object.assign({}, st, { name: st.stage || st.name, description: st.description || st.claim || "" })),
      red_flags: (cir.red_flags || []).map((x) => typeof x === "string" ? x : s(x.claim || x.statement || x.text || "")),
    });
  }

  // ---------- ported from 138-career-graphcore (w08 engine; adapted to 135 schema) ----------
  const DAY = 86400000;
  const STAGES = ["cold", "contacted", "chat_scheduled", "chatted", "warm", "referral_asked", "referred", "converted", "dormant"];
  const WARMTH = [
    { key: "alumni", points: 50 }, { key: "club", points: 40 }, { key: "major", points: 30 }, { key: "hometown", points: 20 },
  ];
  const daysBetween = (a, b) => Math.floor((b - a) / DAY);
  const byName = (graph, name) => (graph.people || []).find((p) => norm(p.full_name) === norm(name)) || null;
  const atCompany = (graph, company) => (graph.people || []).filter((p) => normCo(p.current_firm) === normCo(company));
  // Adapter: a 138-shaped record (name/company/school singular/email/position/
  // connectedVia/publicLinks) becomes a 135 person; no second schema is kept.
  function adaptRecord(r0, source) {
    const r = r0 || {};
    return normalizePerson({
      full_name: r.full_name || r.name || "", current_firm: r.current_firm || r.company || "",
      title: r.title || r.position || "", work_email: r.work_email || r.email || null, linkedin: r.linkedin || null,
      schools: r.schools || (r.school ? [r.school] : []), major: r.major || null, hometown: r.hometown || null,
      clubs: r.clubs || [], prior_firms: r.prior_firms || (r.priorCompany ? [r.priorCompany] : []),
      prior_company: r.prior_company || r.priorCompany || null, stage: r.stage || "cold", chats: r.chats || 0,
      last_contact_at: r.last_contact_at || r.lastContactAt || null, connected_via: r.connected_via || r.connectedVia || null,
      connected_on: r.connected_on || r.connectedOn || null, joined_company_at: r.joined_company_at || r.joinedCompanyAt || null,
      public_links: r.public_links || r.publicLinks || [], relationship_to_user: r.relationship_to_user || r.relationship || "none",
      source_list: [...new Set([...(r.source_list || []), ...(r.sources || []), r.source || source].filter(Boolean))],
    });
  }
  function samePerson(a, b) {
    if (a.work_email && b.work_email && norm(a.work_email) === norm(b.work_email)) return true;
    if (norm(a.full_name) && norm(a.full_name) === norm(b.full_name)) {
      if (a.current_firm && b.current_firm && normCo(a.current_firm) === normCo(b.current_firm)) return true;
      if ((a.schools || []).length && (b.schools || []).length && norm(a.schools[0]) === norm(b.schools[0])) return true;
      if (!a.current_firm && !b.current_firm) return true;
    }
    return false;
  }
  function importRecords(graph, records, source) {
    let added = 0, merged = 0;
    graph.snapshots = graph.snapshots || []; graph._seq = graph._seq || 0;
    for (const r0 of records || []) {
      const r = adaptRecord(r0, source);
      const hit = (graph.people || []).find((p) => samePerson(p, r));
      if (hit) {
        merged++;
        if (r.current_firm && hit.current_firm && normCo(r.current_firm) !== normCo(hit.current_firm)) { hit.prior_company = hit.prior_company || hit.current_firm; hit.prior_firms = [...new Set([...(hit.prior_firms || []), hit.current_firm])]; hit.current_firm = r.current_firm; if (r.joined_company_at) hit.joined_company_at = r.joined_company_at; }
        mergeInto(hit, r);
      } else {
        graph._seq++;
        r.person_id = "P-" + String(graph._seq).padStart(3, "0");
        graph.people.push(r); added++;
      }
    }
    // Alias sync: ported (138-shaped) callers read name/company/email/position/
    // sources/publicLinks/connectedVia/lastContactAt off person records; the
    // canonical fields stay full_name/current_firm/work_email/title/source_list/
    // public_links/connected_via/last_contact_at and the aliases point at them.
    for (const p of graph.people) { p.name = p.full_name; p.company = p.current_firm; p.email = p.work_email; p.position = p.title;
      p.school = (p.schools || [])[0] || null; p.sources = p.source_list; p.publicLinks = p.public_links;
      p.connectedVia = p.connected_via; p.lastContactAt = p.last_contact_at; }
    return { added, merged, total: graph.people.length };
  }
  function importLinkedInCsv(graph, csvText, profile122) {
    if (!profile122 || !profile122.parseLinkedInConnections) throw new Error("122-career-profile parser required (real LinkedIn export shape)");
    const { connections, errors } = profile122.parseLinkedInConnections(csvText);
    const recs = connections.map((c) => ({ name: c.name, email: c.email, company: c.company, position: c.position, connectedOn: c.connectedOn, source: "linkedin-export" }));
    return Object.assign(importRecords(graph, recs, "linkedin-export"), { parse_errors: errors });
  }
  function sharedFacts(graph, person) {
    const u = (graph && graph.user) || {}; const p = normalizePerson(person); const out = [];
    const tests = {
      alumni: !!u.school && (p.schools || []).map(norm).includes(norm(u.school)),
      club: (p.clubs || []).some((c) => (u.clubs || []).map(norm).includes(norm(c))),
      major: !!u.major && !!p.major && norm(p.major) === norm(u.major),
      hometown: !!u.hometown && !!p.hometown && norm(p.hometown) === norm(u.hometown),
    };
    for (const w of WARMTH) if (tests[w.key]) out.push({ kind: w.key, points: w.points,
      fact: w.key === "alumni" ? `Both ${u.school}` : w.key === "club" ? `Shared club: ${(p.clubs || []).find((c) => (u.clubs || []).map(norm).includes(norm(c)))}`
        : w.key === "major" ? `Same major: ${u.major}` : `Same hometown: ${u.hometown}`, source: (p.source_list || []).join("+") });
    if (p.connected_via) out.push({ kind: "second_degree", points: 10, fact: `Connected via ${p.connected_via}`, source: "graph" });
    return out;
  }
  function warmthOf(graph, person) {
    const facts = sharedFacts(graph, person); const p = normalizePerson(person);
    const top = facts.filter((f) => f.kind !== "second_degree").sort((a, b) => b.points - a.points)[0] || null;
    const direct = p.connected_via ? 5 : 15;
    return { score: (top ? top.points : 0) + direct + (facts.some((f) => f.kind === "second_degree") ? 5 : 0),
      tier: top ? top.kind : "cold", shared_fact: top ? top.fact : "No shared fact on record \u2014 cold path", all_facts: facts };
  }
  function rankPaths(graph, company) {
    return atCompany(graph, company).map((p) => { const w = warmthOf(graph, p);
      return { person_id: p.person_id, name: p.full_name, position: p.title || null, company: p.current_firm, degree: p.connected_via ? 2 : 1,
        via: p.connected_via || null, warmth_tier: w.tier, warmth_score: w.score, shared_fact: w.shared_fact, stage: p.stage || "cold", sources: p.source_list }; })
      .sort((a, b) => b.warmth_score - a.warmth_score || a.name.localeCompare(b.name));
  }
  function topWarmPathSweep(graph, companies) {
    return (companies || []).map((company) => { const paths = rankPaths(graph, company);
      return { company, paths_found: paths.length, best: paths[0] || null, all: paths }; });
  }
  function secondDegreeMap(graph, company) {
    return rankPaths(graph, company).filter((p) => p.degree === 2)
      .map((p) => Object.assign({}, p, { path: `You \u2192 ${p.via} \u2192 ${p.name}` }));
  }
  function publicSourceLookup(graph, company) {
    return atCompany(graph, company).filter((p) => (p.source_list || []).some((x) => String(x).startsWith("public:")))
      .map((p) => ({ name: p.full_name, position: p.title || null, company: p.current_firm, public_links: p.public_links, sources: p.source_list,
        note: "Public sources only (GitHub / speakers / team pages as supplied by the user) \u2014 no LinkedIn scraping." }));
  }
  function mentorMap(graph, companies) {
    return (companies || []).map((company) => ({ company,
      mentors: rankPaths(graph, company).filter((p) => /manager|lead|senior|principal|director|advocate/i.test(p.position || "")).slice(0, 3) }));
  }
  function setStage(graph, name, stage, opts) {
    opts = opts || {}; const p = byName(graph, name); if (!p) return { ok: false, reason: "person_not_in_graph:" + name };
    if (!STAGES.includes(stage)) return { ok: false, reason: "unknown_stage:" + stage };
    const from = p.stage || "cold"; p.stage = stage;
    graph.interactions.push({ person_id: p.person_id, name: p.full_name, full_name: p.full_name, kind: opts.kind || "stage_change", channel: opts.kind || "stage_change", at: opts.at || null,
      summary: opts.summary || `stage ${from} -> ${stage}`, stage_after: stage });
    if (opts.at) p.last_contact_at = opts.at;
    return { ok: true, person: p.full_name, from, to: stage };
  }
  function recordInteraction(graph, name, input) {
    input = input || {}; const p = byName(graph, name); if (!p) return { ok: false, reason: "person_not_in_graph:" + name };
    const ix = { person_id: p.person_id, name: p.full_name, full_name: p.full_name, kind: input.kind || "chat", channel: input.kind || "chat", at: input.at || null, summary: input.summary || "", stage_after: p.stage || "cold" };
    graph.interactions.push(ix); if (input.at) p.last_contact_at = input.at;
    if (input.kind === "coffee_chat") { p.chats = (p.chats || 0) + 1; ix.outcome = "good_chat"; if (["contacted", "chat_scheduled", "cold"].includes(p.stage || "cold")) { p.stage = "chatted"; ix.stage_after = p.stage; } }
    return { ok: true, interaction: ix };
  }
  function planReferralAsk(graph, name, opts) {
    // SC-151 law: a referral ask NEVER goes in email one \u2014 it needs a held chat first.
    opts = opts || {}; const p = byName(graph, name);
    if (!p) return { ok: false, reason: "person_not_in_graph:" + name };
    if (!(p.chats > 0) && p.stage !== "chatted" && p.stage !== "warm") return { ok: false, blocked: true,
      reason: "no_held_chat_on_record: referral asks come after a good coffee chat, never in email one (SC-151)", stage: p.stage || "cold" };
    return { ok: true, kind: "referral_ask", requires_approval: true, sends: false, t3: true,
      draft: { to_name: p.full_name, subject: `Referral for ${opts.company || p.current_firm} \u2014 ${opts.role || "the role"}`,
        body: `Hi ${p.full_name.split(/\s+/)[0]}, thanks again for the chat${opts.chat_note ? ` \u2014 ${opts.chat_note}` : ""}. I applied for ${opts.role || "a role"} at ${opts.company || p.current_firm}. Would you be willing to refer me? Happy to send a short blurb and my resume so it's easy. No pressure at all if the timing isn't right.\n\nThanks,\n${(graph.user || {}).name || ""}` } };
  }
  function recordReferralSignal(graph, name, input) {
    input = input || {}; const p = byName(graph, name);
    if (!p) return { ok: false, reason: "person_not_in_graph:" + name };
    const ref = { person_id: p.person_id, name: p.full_name, contact_name: p.full_name, company: input.company || p.current_firm, role: input.role || null,
      status: input.status || "submitted", at: input.at || null, app_id: null };
    graph.referrals.push(ref); setStage(graph, name, "referred", { at: input.at, kind: "referral", summary: `referral ${ref.status} for ${ref.company}` });
    return { ok: true, referral: ref };
  }
  function linkReferralToApplication(graph, trackStore, name, company) {
    const rows = Array.isArray(trackStore) ? trackStore : (trackStore && trackStore.rows) || [];
    const app = rows.find((r) => normCo(r.company) === normCo(company));
    const ref = graph.referrals.filter((r) => norm(r.name || r.contact_name || "") === norm(name)).slice(-1)[0];
    if (!app) return { ok: false, reason: "no_application_row_for:" + company };
    if (!ref) return { ok: false, reason: "no_referral_signal_for:" + name };
    app.source = "referred"; app.referred_by = name; ref.app_id = app.app_id;
    app.events = app.events || []; app.events.push({ type: "referral_linked", at: ref.at, source: "graph", detail: `referral submitted by ${name} (graph ${ref.person_id})`, evidence: ref.person_id });
    return { ok: true, app_id: app.app_id, company: app.company, source_after: app.source, referred_by: app.referred_by };
  }
  function conversionTracking(graph) {
    const per = graph.people.filter((p) => (p.chats || 0) > 0 || graph.referrals.some((r) => r.person_id === p.person_id)).map((p) => {
      const refs = graph.referrals.filter((r) => r.person_id === p.person_id);
      return { name: p.full_name, company: p.current_firm, chats: p.chats || 0, stage: p.stage || "cold", referrals: refs.length,
        converted: refs.length > 0 }; });
    const chatted = per.length, converted = per.filter((x) => x.converted).length;
    return { contacts_with_chats: chatted, converted_to_referral: converted,
      conversion_pct: chatted ? Math.round(1000 * converted / chatted) / 10 : 0, per_contact: per };
  }
  function keepWarmSuggestions(graph, opts) {
    opts = opts || {}; const now = opts.now || Date.now(); const afterDays = opts.afterDays || 42;
    return graph.people.filter((p) => ["chatted", "warm", "referred"].includes(p.stage || "cold") && p.last_contact_at
      && daysBetween(Date.parse(p.last_contact_at), now) >= afterDays)
      .map((p) => ({ name: p.full_name, company: p.current_firm, stage: p.stage, days_since: daysBetween(Date.parse(p.last_contact_at), now),
        reason: `${daysBetween(Date.parse(p.last_contact_at), now)} days since your last touch \u2014 past the 6-week keep-warm line, and the relationship was warm (${p.stage}).` }))
      .sort((a, b) => b.days_since - a.days_since);
  }
  function draftUpdateTouch(graph, name, profile122Profile, opts) {
    opts = opts || {}; const p = byName(graph, name); if (!p) return { ok: false, reason: "person_not_in_graph:" + name };
    const facts = ((profile122Profile && profile122Profile.facts) || []).filter((f) => !f.needs_confirmation);
    const news = opts.factId ? facts.find((f) => f.id === opts.factId) : facts[facts.length - 1];
    if (!news) return { ok: false, reason: "no_confirmed_profile_fact_to_share" };
    return { ok: true, requires_approval: true, sends: false, fact_id: news.id,
      draft: { to_name: p.full_name, body: `Hi ${p.full_name.split(/\s+/)[0]}, quick update since we last spoke: ${news.text} Thought you'd appreciate hearing it \u2014 your advice helped. Hope things are well at ${p.current_firm}.\n\nBest,\n${(graph.user || {}).name || ""}` } };
  }
  function draftIntroRequest(graph, mutualName, targetName, blurb) {
    const m = byName(graph, mutualName), tg = byName(graph, targetName);
    if (!m || !tg) return { ok: false, reason: "mutual_or_target_not_in_graph" };
    if (!blurb) return { ok: false, reason: "forwardable_blurb_required" };
    return { ok: true, requires_approval: true, sends: false, t3: true, card: { kind: "intro_request", mutual: m.full_name, target: tg.full_name },
      draft: { to_name: m.full_name, subject: `Intro to ${tg.full_name} at ${tg.current_firm}?`,
        body: `Hi ${m.full_name.split(/\s+/)[0]}, would you be willing to introduce me to ${tg.full_name} at ${tg.current_firm}? Forwardable blurb below so it's one copy-paste \u2014 no worries at all if not.\n\n${blurb}\n\nThanks,\n${(graph.user || {}).name || ""}` } };
  }
  function snapshot(graph, at) { graph.snapshots = graph.snapshots || []; const snap = { at: at || null, people: graph.people.map((p) => ({ name: p.full_name, company: p.current_firm })) }; graph.snapshots.push(snap); return snap; }
  function newHireRadar(graph, prevSnap, opts) {
    opts = opts || {}; const now = opts.now || Date.now(); const targets = (opts.targetCompanies || []).map(normCo);
    const prev = {}; for (const pp of (prevSnap && prevSnap.people) || []) prev[norm(pp.name)] = pp.company;
    return graph.people.filter((p) => targets.includes(normCo(p.current_firm)) && (
      (prev[norm(p.full_name)] && normCo(prev[norm(p.full_name)]) !== normCo(p.current_firm)) ||
      (p.joined_company_at && daysBetween(Date.parse(p.joined_company_at), now) <= (opts.withinDays || 90))))
      .map((p) => { const w = warmthOf(graph, p);
        return { name: p.full_name, company: p.current_firm, prior_company: p.prior_company || prev[norm(p.full_name)] || null, joined_at: p.joined_company_at || null,
          warmth_tier: w.tier, shared_fact: w.shared_fact, flag: "New hire from your network/school at a target company \u2014 usually the warmest path in." }; });
  }

  return { makeGraphStore, normalizePerson, identityKeys, mergeIdentities, importGraph, adaptCirForPrep,
    rankWarmth, findPaths, pickStrongerPath, departedNextPath, exclusionFor,
    relationshipMemory, keepWarm, logInteraction,
    forwardableBlurb, askKindFor, draftReferralAsk, thankYouReferralCombo, dormantRevival,
    referralTiming, createReferral, approveReferral, markReferralSubmitted, conversionByContact,
    miniCampaign, referralBonusIntel,
    STAGES, WARMTH, createGraph, importRecords, importLinkedInCsv, byName, atCompany, samePerson,
    sharedFacts, warmthOf, rankPaths, topWarmPathSweep, secondDegreeMap, publicSourceLookup, mentorMap,
    setStage, recordInteraction, planReferralAsk, recordReferralSignal, linkReferralToApplication,
    conversionTracking, keepWarmSuggestions, draftUpdateTouch, draftIntroRequest, snapshot, newHireRadar };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerGraph;
