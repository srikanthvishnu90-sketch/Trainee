/* Career negotiation rail (NEGO-001..006; starter pack §3.6).
   Pure domain module, UMD like the other domain modules. NO SENDS: every outward text is a
   draft behind an approval card ({ requires_approval: true, sent: false }) — the chat layer
   sends only after the user taps yes, and only to the destination on the card.
   COMP HONESTY LAW: benchmarks use ONLY figures that appear verbatim in CIR compensation_notes
   (packages/career-data/cirs/*.json), each carried with its source_url, source_type and as_of.
   A CIR that publishes no figure yields an explicit no-figure note — never an invented number.
   Total-comp math shows every assumption; equity with no stated value/price is reported as
   unvalued, never priced by guesswork. Advice, not guarantees; legal/tax disclaimer attached.
   The offer log seam is a simple injected store: a plain object with an `offers` array
   (createStore() below, shared shape with 129-career-os) — no dependency on the 126 tracker
   branch; the tracker can adopt the same row shape later. */
const CareerNegotiation = (() => {
  const DISCLAIMER = "Negotiation support is advice, not a guarantee of outcome. It is not legal or tax advice — have an employment lawyer review any agreement before you sign.";
  const s = (v) => (v == null ? "" : String(v));
  const money = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
  // CLOCK-SOURCE (BUG-198 class, FR-383): the turn clock arrives as
  // numeric epoch ms from the router/host and Date.parse(number) is
  // NaN. Coerce type-safely — a finite number passes through, a
  // string parses, anything else is NaN and the caller defaults.
  // (Closure-local name: the bundle concatenates files into one
  // module scope, so file-scope helper names must be unique.)
  const clockMsOf = (v) => { if (v == null) return NaN; if (typeof v === "number") return Number.isFinite(v) ? v : NaN; const t = Date.parse(v); return Number.isNaN(t) ? NaN : t; };

  function createStore() { return { offers: [], deadlines: [], drafts: [], wins: [], relationships: [], goals: [], applications: [], watches: [] }; }

  // ---------- offer parsing (NEGO-001) ----------
  function parseMoney(str) {
    const m = s(str).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*(k)?\b/i);
    if (!m) return null;
    let n = Number(m[1]); if (m[2]) n *= 1000;
    return n;
  }
  const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  function parseDate(str) {
    const t = s(str);
    let m = t.match(/(20\d\d)-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(20\d\d)/);
    if (m && MONTHS[m[1].toLowerCase()] != null) { const d = new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]))); return d.toISOString().slice(0, 10); }
    return null;
  }
  function line(text, re) { const m = s(text).match(re); return m ? m : null; }

  function parseOffer(text, opts) {
    opts = opts || {};
    const t = s(text);
    const grab = (re) => { const m = t.match(re); return m ? m[1] : null; };
    // Amounts accept the $k shorthand letters actually use ("$128k") — the
    // captures carry the optional k through to parseMoney, which scales it;
    // without it "$128k" parsed as $128 (SC-206 replay, fixer wave).
    const AMT = "([\\d,]+(?:\\.\\d+)?\\s*k?)";
    const baseM = line(t, new RegExp("base salary[:\\s]*\\$" + AMT, "i")) || line(t, new RegExp("base pay[^$\\n]*\\$" + AMT, "i")) || line(t, new RegExp("(?:^|\\n)[-\\s]*salary[:\\s]*\\$" + AMT, "im"));
    const signM = line(t, new RegExp("signing bonus[:\\s]*\\$" + AMT, "i")) || line(t, new RegExp("sign-on bonus[:\\s]*\\$" + AMT, "i"));
    const bonusPct = grab(/target (?:annual )?bonus[:\s]*([\d.]+)%/i);
    const bonusAmt = grab(new RegExp("(?:^|\\n)[-\\s]*annual bonus[:\\s]*\\$" + AMT, "im"));
    const grantVal = grab(new RegExp("grant value of \\$" + AMT, "i")) || grab(new RegExp("equity[^$\\n]*\\$" + AMT, "i"));
    const shares = grab(/([\d,]+)\s+(?:stock options|shares|RSUs?)/i);
    const vest = grab(/vesting over (\d+(?:\.\d+)?) years/i) || grab(/vest\w* over (\d+(?:\.\d+)?) years/i);
    const cliff = (() => { const m = t.match(/(\d+)-(year|month) cliff/i); return m ? { n: m[1], unit: m[2].toLowerCase() } : null; })();
    const pto = grab(/(\d+) days of PTO/i);
    const startLine = grab(/start date[:\s]*([^\n]+)/i);
    const expiryLine = grab(/(?:respond by|respond no later than|deadline to respond|decision deadline|accept by|expires(?: at[^.]*)? on|offer expires[^A-Za-z]*)([A-Za-z]+ \d{1,2}, 20\d\d|20\d\d-\d{2}-\d{2})/i)
      || grab(/(?:respond by|respond no later than|deadline to respond|decision deadline|accept by|expires on)[:\s]*([^\n.]+)/i);
    const benefits = [];
    if (/health/i.test(t)) benefits.push("health insurance (as stated in letter)");
    if (/dental/i.test(t)) benefits.push("dental (as stated in letter)");
    if (/vision/i.test(t)) benefits.push("vision (as stated in letter)");
    if (/401\(k\)/i.test(t)) benefits.push("401(k) (as stated in letter)");
    if (/unlimited PTO/i.test(t)) benefits.push("unlimited PTO (as stated in letter)");
    const offer = {
      company: opts.company || grab(/^([A-Z][\w .&'-]+?)(?:, Inc\.| \(TEST)/m) || null,
      role: opts.role || grab(/role[:\s]*([^\n]+)/i) || null,
      location: grab(/location[:\s]*([^\n]+)/i) || null,
      base_salary: baseM ? parseMoney(baseM[1]) : null,
      signing_bonus: signM ? parseMoney(signM[1]) : 0,
      annual_bonus: bonusPct ? { kind: "target_pct", pct: Number(bonusPct) } : (bonusAmt ? { kind: "amount", amount: parseMoney(bonusAmt) } : null),
      equity: {
        type: /stock options/i.test(t) ? "options" : (/RSU/i.test(t) ? "RSU" : null),
        shares: shares ? Number(shares.replace(/,/g, "")) : null,
        grant_value: grantVal ? parseMoney(grantVal) : null,
        share_price: opts.sharePrice != null ? opts.sharePrice : null,
        vest_years: vest ? Number(vest) : null,
        cliff: cliff ? `${cliff.n}-${cliff.unit}` : null,
      },
      benefits, pto_days: pto ? Number(pto) : (/unlimited PTO/i.test(t) ? "unlimited" : null),
      start_date: startLine ? parseDate(startLine) : null,
      expiry_date: expiryLine ? parseDate(expiryLine) : null,
      parsed_at: opts.now || new Date().toISOString(),
      source: "user-pasted offer text (TEST fixture)" ,
    };
    offer.missing = ["base_salary", "start_date", "expiry_date"].filter((k) => offer[k] == null);
    if (offer.equity.grant_value == null && offer.equity.shares == null) offer.missing.push("equity value");
    return offer;
  }

  function storeOffer(store, offer) {
    if (!store || !Array.isArray(store.offers)) throw new Error("store with offers[] required (see createStore)");
    const row = Object.assign({ offer_id: `offer-${store.offers.length + 1}` }, offer);
    store.offers.push(row);
    if (row.expiry_date) store.deadlines = store.deadlines || [], store.deadlines.push({ kind: "offer_expiry", offer_id: row.offer_id, company: row.company, date: row.expiry_date });
    return row;
  }

  // ---------- comp benchmark from CIRs ONLY (NEGO-002) ----------
  function extractFigures(cir) {
    const out = [], noFigure = [], excludedPeriod = [];
    for (const note of (cir && cir.compensation_notes) || []) {
      const fact = note.fact || note;
      const claim = s(fact.claim || fact.text || note.note || "");
      const srcType = fact.source_type || note.source_type || "unknown";
      // R-C5: community-reported items are labeled reported, not measured —
      // the label follows what the note's own text says ("reported by a
      // secondary aggregator"), not only the source_type field, which CIR
      // files sometimes carry as "official" for a reported figure.
      const anecdotal = /anecdotal|reported|aggregator/i.test(srcType) || /\breported by\b|user-reported|community-reported|aggregator/i.test(claim);
      const ranges = [...claim.replace(/,/g, "").matchAll(/\$(\d{4,7})\s*-\s*\$(\d{4,7})/g)];
      const singles = [...claim.replace(/,/g, "").matchAll(/\$(\d{4,7})(?!\s*-)/g)];
      if (/no .*figure|none is claimed|not (?:treated|used)|do not quote|no official/i.test(claim) && !ranges.length) {
        noFigure.push({ company_id: cir.company_id, note: claim.slice(0, 300), source_url: fact.source_url || null, source_type: srcType, as_of: fact.as_of || cir.as_of });
        continue;
      }
      // BUG-003 guard: a figure stated per week/month/hour (e.g. an intern's $5,800 WEEKLY rate) is
      // not an annual figure — never let it into annual benchmarks/estimates. It is recorded as an
      // excluded period figure so the omission is visible, not silent.
      if (/weekly|per week|monthly|per month|hourly|\/hr|per hour/i.test(claim)) { excludedPeriod.push({ company_id: cir.company_id, note: claim.slice(0, 300), source_url: fact.source_url || null, source_type: srcType, as_of: fact.as_of || cir.as_of }); continue; }
      for (const r of ranges) out.push({ company_id: cir.company_id, company: cir.company_name, low: Number(r[1]), high: Number(r[2]), figure_text: claim.slice(0, 300), source_url: fact.source_url || null, source_type: srcType, as_of: fact.as_of || cir.as_of, anecdotal, label: note.label || srcType });
      if (!ranges.length) for (const r of singles) out.push({ company_id: cir.company_id, company: cir.company_name, low: Number(r[1]), high: Number(r[1]), figure_text: claim.slice(0, 300), source_url: fact.source_url || null, source_type: srcType, as_of: fact.as_of || cir.as_of, anecdotal, label: note.label || srcType });
    }
    return { figures: out, noFigure, excludedPeriod };
  }
  function benchmark(cir, opts) {
    opts = opts || {};
    const { figures, noFigure, excludedPeriod } = extractFigures(cir);
    const asOf = cir ? cir.as_of : null;
    // R-C5 (SC-208/209 replay): the chat layer speaks bench.text's FIRST
    // sentence, so that sentence itself must name the source class
    // (company file) and the as-of date — "carries its source and date"
    // without the date does not meet the standard. When no CIR is on
    // record, no date is invented: the text says the file is missing.
    const text = !cir
      ? "No company file (company-file compensation notes) is on record for this company yet, so no benchmark figure is claimed. Name the company and its file can be pulled before any range is quoted."
      : figures.length
        ? `Benchmark figures come from the company file (this company's company-file compensation notes)${asOf ? `, as of ${asOf}` : ""}. ${figures.length} sourced figure(s) follow, each with its source URL, source type, and as-of date; any figure the notes mark as reported is labeled reported, not measured.`
        : `No benchmark figure is claimed from the company file (this company's company-file compensation notes)${asOf ? `, as of ${asOf}` : ""}. The notes publish no compensation figure, and no third-party salary-site number is substituted as a fact.`;
    return {
      company: cir ? cir.company_name : null, company_id: cir ? cir.company_id : null,
      role: opts.role || null, as_of: asOf,
      figures, no_figure_notes: noFigure, excluded_period_figures: excludedPeriod || [],
      has_sourced_figure: figures.length > 0,
      text,
      statement: figures.length ? `${figures.length} sourced figure(s) from this company's company-file comp notes (source class: company file${asOf ? `, as of ${asOf}` : ""}) — each figure below carries its source and date.`
        : `No sourced compensation figure exists in this company's company-file comp notes (source class: company file${asOf ? `, as of ${asOf}` : ""}). No benchmark number is claimed — do not substitute third-party salary-site figures as facts.`,
      disclaimer: DISCLAIMER,
    };
  }

  // ---------- total-comp math (NEGO-005 / NEGO honesty) ----------
  function bonusAmount(offer) {
    if (!offer.annual_bonus) return 0;
    if (offer.annual_bonus.kind === "amount") return offer.annual_bonus.amount || 0;
    if (offer.annual_bonus.kind === "target_pct") return money((offer.base_salary || 0) * offer.annual_bonus.pct / 100);
    return 0;
  }
  function totalComp(offer, opts) {
    opts = opts || {};
    const assumptions = [];
    const base = offer.base_salary || 0;
    const bonus = bonusAmount(offer);
    assumptions.push(offer.annual_bonus ? `Bonus counted at ${offer.annual_bonus.kind === "target_pct" ? `target ${offer.annual_bonus.pct}% of base` : "stated amount"} = $${bonus.toLocaleString()} — target is not guaranteed pay.` : "No annual bonus stated in the letter; counted as $0.");
    assumptions.push(`Signing bonus $${(offer.signing_bonus || 0).toLocaleString()} counted in year 1 only, not in the annualized figure.`);
    let equityAnnual = null, equityTotal = null;
    const eq = offer.equity || {};
    if (eq.grant_value != null && eq.vest_years) { equityTotal = eq.grant_value; equityAnnual = money(eq.grant_value / eq.vest_years); assumptions.push(`Equity: grant value $${eq.grant_value.toLocaleString()} spread evenly over the stated ${eq.vest_years}-year vest = $${equityAnnual.toLocaleString()}/yr. Even spread is a simplification — cliff and schedule change real timing.`); }
    else if (eq.shares != null && eq.share_price != null && eq.vest_years) { equityTotal = eq.shares * eq.share_price; equityAnnual = money(equityTotal / eq.vest_years); assumptions.push(`Equity: ${eq.shares.toLocaleString()} shares × the price YOU supplied ($${eq.share_price}) = $${equityTotal.toLocaleString()} over ${eq.vest_years} years. Pre-IPO/private share prices are not cash value.`); }
    else if (eq.shares != null || eq.type) { assumptions.push(`Equity: ${eq.type || "equity"} ${eq.shares ? `(${eq.shares.toLocaleString()} shares/options)` : ""} has NO stated grant value and NO share price in the letter — it is valued at $0 in this math and flagged unvalued. It may be worth something or nothing; no valuation is promised.`); }
    else assumptions.push("No equity stated in the letter; counted as $0.");
    assumptions.push("Benefits are listed, not monetized — the letter states no dollar value for them.");
    const year1 = money(base + bonus + (offer.signing_bonus || 0) + (equityAnnual || 0));
    const annualized = money(base + bonus + (equityAnnual || 0));
    return { company: offer.company, role: offer.role, base_salary: base, bonus, signing_bonus: offer.signing_bonus || 0, equity_annual: equityAnnual, equity_total_stated: equityTotal, equity_unvalued: equityAnnual == null && !!(eq.shares || eq.type), year1_total: year1, annualized_total: annualized, assumptions, disclaimer: "Total-comp math only — not a valuation promise. Equity value depends on the company's future price and vesting; unvalued equity is shown as unvalued, not as zero-worth." };
  }
  function compareOffers(a, b, opts) {
    const ta = totalComp(a, opts), tb = totalComp(b, opts);
    const rows = ["base_salary", "bonus", "signing_bonus", "equity_annual", "year1_total", "annualized_total"].map((k) => ({ field: k, a: ta[k], b: tb[k], delta_b_minus_a: (ta[k] == null || tb[k] == null) ? null : money(tb[k] - ta[k]) }));
    return { a: ta, b: tb, rows, note: "Deltas are null where either side is unvalued (e.g. options with no stated price) — an unvalued component is never treated as $0 in a delta.", disclaimer: DISCLAIMER };
  }

  // ---------- cards, strategy, scripts (NEGO-003) ----------
  function approvalCard(kind, payload) {
    return { type: "approval_card", kind, title: payload.title, body: payload.body, destination: payload.destination || null, requires_approval: true, sent: false, note: "Nothing sends without your yes on this card." };
  }
  function counterStrategy(offer, bench, opts) {
    opts = opts || {};
    const fig = bench && bench.figures && bench.figures[0];
    const asks = [];
    if (fig && offer.base_salary != null && offer.base_salary < fig.high) asks.push({ lever: "base_salary", ask: `Ask base toward $${fig.high.toLocaleString()} (top of the sourced range below)`, evidence: fig });
    else if (!fig) asks.push({ lever: "base_salary", ask: "No sourced benchmark figure exists for this company — anchor the ask on your competing offer / floor instead of an invented market number", evidence: null });
    asks.push({ lever: "signing_bonus", ask: "If base cannot move, ask for a signing-bonus increase to close the year-1 gap (one-time cost to them, real money to you)" });
    asks.push({ lever: "start_date_or_review", ask: "Ask for a 6-month comp review in writing if neither cash lever moves" });
    const target = fig ? `$${fig.high.toLocaleString()}` : "the top of your stated range";
    const email = `Subject: ${offer.role || "Offer"} — ${offer.company || "your company"}\n\nHi [Recruiter name],\n\nThank you — I'm genuinely excited about the ${offer.role || "role"} and the team. I've reviewed the offer (base $${(offer.base_salary || 0).toLocaleString()}${offer.signing_bonus ? `, $${offer.signing_bonus.toLocaleString()} signing` : ""}).\n\nBased on the sourced range for this role${fig ? ` (${fig.figure_text}; source: ${fig.source_url}, as of ${fig.as_of})` : ""}, I was hoping we could get base closer to ${target}. If base is fixed, a signing-bonus adjustment or a written 6-month review would help close the gap.\n\nI'm ready to sign promptly once we land — this is my first choice.\n\nThanks for working with me on this,\n[Your name]`;
    const call = `OPEN: "Thanks for the offer — I'm excited, and I want to find a version I can say yes to today."\nANCHOR: "Looking at the sourced range for this role${fig ? ` — ${fig.figure_text} (${fig.source_url})` : ""} — I was hoping base could land closer to ${target}."\nIF PUSHED BACK: "I understand bands are real. If base can't move, could we look at the signing bonus, or a written 6-month review?"\nCLOSE: "If we can get there, I'm ready to accept and stop my other processes."\n(Stay warm, don't bluff a competing offer you don't have, and let silences sit.)`;
    // The chat layer speaks strat.text's first sentence (it was undefined,
    // so the prepared path spoke nothing from the strategy). First sentence
    // is a claim-verb-free summary; the sourced range carries its source
    // class + as-of inline (R-C5) when a figure exists.
    const text = fig
      ? `Counter plan for ${offer.company || "this offer"}: ask base toward $${fig.high.toLocaleString()} — the top of the sourced range from the company file${fig.as_of ? `, as of ${fig.as_of}` : ""} — and trade a signing-bonus increase or a written 6-month review if base cannot move. Nothing goes out without your yes on the card.`
      : `Counter plan for ${offer.company || "this offer"}: no sourced benchmark figure exists in the company file for this company, so the ask anchors on your competing offer or your own floor instead of an invented market number. Nothing goes out without your yes on the card.`;
    return { asks, floor: opts.floor || null, text, sends: false, scripts: { email, call }, card: approvalCard("counter_email", { title: `Counter for ${offer.company || "offer"} — review before anything sends`, body: email, destination: "recruiter (address confirmed on the card before send)" }), disclaimer: DISCLAIMER };
  }

  // ---------- roleplay (NEGO-004) ----------
  function roleplayTurn(state, userLine) {
    state = state || { turn: 0, pushes: 0 };
    const t = s(userLine).toLowerCase(); const next = { turn: state.turn + 1, pushes: state.pushes || 0, done: false, feedback: null, recruiter: null };
    if (/ready to (sign|accept)|i accept|deal\b/.test(t) && state.turn >= 2) { next.done = true; next.recruiter = "That's great to hear — let me take that to the comp team and confirm in writing."; }
    else if (/\$\s?\d|base|signing|bonus|review/.test(t)) { next.pushes = (state.pushes || 0) + 1; next.recruiter = next.pushes > 1 ? "I hear you. The band is the band, but I might have room on signing — what number gets you to a yes today?" : "Appreciate you laying that out. Our band for this level is pretty firm — is there anything besides base that matters most to you?"; }
    else if (/thank|excited|first choice/.test(t)) next.recruiter = "Love to hear that. Walk me through how you're thinking about the numbers side.";
    else next.recruiter = "Tell me more — what would make this an easy yes for you?";
    if (next.done || next.turn >= 6) { next.done = true; next.feedback = `Roleplay feedback: you made ${next.pushes} concrete ask(s) with a number or lever — concrete asks are what move offers. ${next.pushes ? "Good: you named a lever when base was pushed back." : "Gap: you never named a specific number or lever — recruiters cannot route 'more' to a comp team."} Close every round by restating that you will sign if the ask lands — that readiness is your leverage. (Practice only — real outcomes vary.)`; }
    return next;
  }

  // ---------- extension / decline drafts (NEGO-006, decline) ----------
  function extensionDraft(offer, opts) {
    opts = opts || {};
    const days = opts.days || 7; const cur = offer.expiry_date ? Date.parse(offer.expiry_date + "T00:00:00Z") : null;
    const newDate = cur ? new Date(cur + days * 86400000).toISOString().slice(0, 10) : null;
    const body = `Subject: Request for a short extension — ${offer.role || "offer"}\n\nHi [Recruiter name],\n\nThank you for the offer — I'm very excited about ${offer.company || "the team"} and I'm taking it seriously. So I can give it the careful review it deserves${opts.reason ? ` (${opts.reason})` : ""}, would it be possible to extend my decision deadline by ${days} days, to ${newDate || "[new date]"}?\n\nI don't expect to need longer than that, and I'll keep you posted either way.\n\nThank you for understanding,\n[Your name]`;
    return { draft: body, current_deadline: offer.expiry_date || null, requested_deadline: newDate, days, card: approvalCard("extension_email", { title: `Extension request for ${offer.company || "offer"} — review before anything sends`, body, destination: "recruiter (address confirmed on the card before send)" }), disclaimer: DISCLAIMER };
  }
  function trackExtension(store, offer, ext) {
    const row = { kind: "offer_deadline_extended", offer_id: offer.offer_id || null, company: offer.company, from: ext.current_deadline, to: ext.requested_deadline, status: "drafted_not_sent" };
    (store.deadlines = store.deadlines || []).push(row); return row;
  }
  function declineDraft(offer, opts) {
    opts = opts || {};
    const body = `Subject: Thank you — ${offer.role || "role"} decision\n\nHi [Recruiter name],\n\nThank you so much for the offer and for everything the team shared with me through the process. After a lot of thought, I've decided to accept another opportunity that fits my goals right now, so I need to decline.\n\nThis was a genuinely hard decision — I have huge respect for ${offer.company || "the team"} and the people I met. I'd love to stay in touch, and I hope our paths cross again.\n\nWith gratitude,\n[Your name]`;
    return { draft: body, relationship_kept_checks: { thanks_team: /thank you/i.test(body), names_reason_as_fit_not_money: /fits my goals/i.test(body), leaves_door_open: /stay in touch/i.test(body), no_bridge_burning_language: !/lowball|insult|waste/i.test(body) }, card: approvalCard("decline_email", { title: `Decline ${offer.company || "offer"} warmly — review before anything sends`, body, destination: "recruiter (address confirmed on the card before send)" }), disclaimer: DISCLAIMER };
  }

  // ---------- deadline sequencing (colliding deadlines) ----------
  function deadlinePlan(offers, opts) {
    opts = opts || {}; const now = (() => { const t = clockMsOf(opts.now); return Number.isNaN(t) ? Date.now() : t; })();
    const sorted = [...(offers || [])].filter((o) => o.expiry_date).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))
      .map((o) => ({ offer_id: o.offer_id || null, company: o.company, expiry_date: o.expiry_date, days_left: Math.ceil((Date.parse(o.expiry_date + "T00:00:00Z") - now) / 86400000) }));
    const collide = sorted.length > 1 && sorted[0].expiry_date === sorted[sorted.length - 1].expiry_date;
    const steps = [];
    if (collide) {
      steps.push(`Both deadlines land on ${sorted[0].expiry_date} — nothing is implicit: (1) TODAY send the extension request to the offer you rank second (draft is card-gated); (2) use the extra days to finish the counter on your first choice; (3) decide by ${sorted[0].expiry_date} at the latest if no extension lands; (4) decline the other offer warmly the same day you accept — don't let it lapse silently.`);
    } else if (sorted.length) {
      steps.push(`Earliest deadline: ${sorted[0].company} on ${sorted[0].expiry_date} (${sorted[0].days_left} days left). Sequence every other step backwards from that date.`);
    } else steps.push("No offer deadlines are stored — parse the offers first so dates exist in the log.");
    return { deadlines: sorted, collision: collide, steps, as_of: new Date(now).toISOString() };
  }

  // ---------- WO-036: public pay data and the script from the person's own facts ----------
  // The public pay data the offer benchmark reads: DOL LCA filed wages per company/SOC/metro, BLS OEWS metro wages,
  // the BLS national records already on file, the per-company LCA aggregate and the maps between them. Node reads
  // packages/career-data/datasets from disk; the Deno bundle embeds the same files as CAREER_PAY_JSON (BUG-174 pattern).
  let _pay = null;
  function payData() {
    if (_pay) return _pay;
    try {
      const fs = require("fs"); const path = require("path");
      const dir = path.join(__dirname, "..", "career-data", "datasets");
      const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      _pay = { maps: read("pay-maps.json"), lca_wages: read("dol-lca-wages.json"), oews_metro: read("bls-oews-metro.json"), bls_national: read("bls-labor-data.json"), lca_companies: read("dol-lca-fy2025q4-cir-companies.json") };
    } catch { _pay = null; }
    if (!_pay) { try { if (typeof CAREER_PAY_JSON !== "undefined" && CAREER_PAY_JSON) _pay = CAREER_PAY_JSON; } catch { _pay = null; } }
    return _pay;
  }
  // A counter draft and a call script built ONLY from what the person stated: their offer, a competing offer they
  // named (company and number in their words), their actual deadline, and a public benchmark already labeled by the
  // caller. Nothing else is claimed: no competing offer, no "first choice", no "ready to sign" unless they said it.
  // Nothing is sent: the draft is returned for the person to read, change and send themselves.
  function factScript(offer, opts) {
    opts = opts || {};
    // D-069: each figure in its own currency when the caller passes how to write it ("AUD 87,600"); US dollars otherwise.
    const fmt = typeof opts.money === "function" ? opts.money : null;
    const usd = (n, field) => fmt ? fmt(n, field) : "$" + Math.round(n).toLocaleString("en-US");
    const o = offer || {};
    // 2026-11-13: a title that already ends in "role" is not doubled, and an offer with no title is not "the role role".
    const role = String(o.role || "role").replace(/\s+role$/i, "");
    const competing = (opts.competing || []).filter((c) => c && c.said && Number.isFinite(c.base));
    const best = competing.slice().sort((a, b) => b.base - a.base)[0] || null;
    const bench = opts.benchmark && Number.isFinite(opts.benchmark.median) ? opts.benchmark : null;
    const base = Number.isFinite(o.base) ? o.base : null;
    // One question in the email; the call script says the same asks as statements, so the whole text asks once.
    let ask, askSay, because = [];
    if (best && base != null && best.base > base) {
      because.push(`I have another offer${best.company ? ` from ${best.company}` : ""} with a base of ${usd(best.base)}.`);
      ask = `Could you bring the base to ${usd(best.base)}?`; askSay = `Ask them to bring the base to ${usd(best.base)}.`;
    } else if (bench && base != null && bench.median > base) {
      because.push(`${bench.cite} shows a median of ${usd(bench.median)}.`);
      ask = `Could you bring the base closer to ${usd(bench.median)}?`; askSay = `Ask them to bring the base closer to ${usd(bench.median)}.`;
    } else {
      if (best) because.push(`I have another offer${best.company ? ` from ${best.company}` : ""} with a base of ${usd(best.base)}.`);
      ask = "Is there flexibility on the base or the signing bonus?"; askSay = "Ask whether the base or the signing bonus can move.";
    }
    const fallback = o.signing != null ? `If the base is set, a higher signing bonus than ${usd(o.signing, "signing")} would also help.` : "If the base is set, a signing bonus would also help.";
    const deadline = opts.deadline && opts.deadline.text ? String(opts.deadline.text) : null;
    const stated = [base != null ? `a base of ${usd(base)}` : null, o.signing != null ? `a ${usd(o.signing, "signing")} signing bonus` : null].filter(Boolean).join(" and ");
    const email = [
      `Subject: ${o.role ? role[0].toUpperCase() + role.slice(1) : "Your"} offer${o.company ? `, ${o.company}` : ""}`,
      "",
      "Hi,",
      "",
      `Thank you for the offer${o.role ? ` for the ${role} role` : ""}${stated ? `, with ${stated}` : ""}. Before I decide, I'd like to talk about the pay.`,
      ...because,
      `${ask} ${fallback}`,
      deadline ? `I'll get back to you by ${deadline}.` : null,
      "",
      "Thanks,",
    ].filter((x) => x !== null).join("\n");
    const call = [
      `Open: Thank you for the offer. Before I decide I'd like to talk about the pay.`,
      ...because.map((b) => `Why: ${b}`),
      askSay,
      `If they say the base is fixed: ${fallback}`,
      deadline ? `Close: I'll get back to you by ${deadline}.` : `Close: find out when they need your answer.`,
    ].join("\n");
    return { email, call, sends: false, used: { competing: best ? [best] : [], deadline, benchmark: bench ? bench.cite : null } };
  }

  return { DISCLAIMER, payData, factScript, createStore, parseOffer, parseDate, parseMoney, storeOffer, extractFigures, benchmark, totalComp, compareOffers, bonusAmount, approvalCard, counterStrategy, roleplayTurn, extensionDraft, trackExtension, declineDraft, deadlinePlan };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerNegotiation;
