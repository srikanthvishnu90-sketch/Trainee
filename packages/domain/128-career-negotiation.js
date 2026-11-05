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
    const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
    const o = offer || {};
    const role = o.role ? String(o.role) : null;
    // C04: an hourly offer is restated and asked in the person's units ("$24 an hour"); an annual figure (a benchmark, a
    // competing base) is converted at 2,080 hours with the conversion said, never silently.
    const hourly = Number.isFinite(Number(o.hourly)) && Number(o.hourly) > 0 ? Number(o.hourly) : null;
    const perHour = (n) => "$" + (Math.round((n / 2080) * 100) / 100).toFixed(2) + " an hour";
    const competing = (opts.competing || []).filter((c) => c && c.said && Number.isFinite(c.base));
    const best = competing.slice().sort((a, b) => b.base - a.base)[0] || null;
    const bench = opts.benchmark && Number.isFinite(opts.benchmark.median) ? opts.benchmark : null;
    const base = Number.isFinite(o.base) ? o.base : null;
    // One question in the email; the call script says the same asks as statements, so the whole text asks once.
    let ask, askSay, because = [];
    if (best && base != null && best.base > base) {
      because.push(`I have another offer${best.company ? ` from ${best.company}` : ""} with a base of ${usd(best.base)}.`);
      if (hourly) { ask = `Could you bring the rate to ${perHour(best.base)} (${usd(best.base)} a year at 2,080 hours)?`; askSay = `Ask them to bring the rate to ${perHour(best.base)}.`; }
      else { ask = `Could you bring the base to ${usd(best.base)}?`; askSay = `Ask them to bring the base to ${usd(best.base)}.`; }
    } else if (bench && base != null && bench.median > base) {
      because.push(`${bench.cite} shows a median of ${usd(bench.median)}${hourly ? ` a year, about ${perHour(bench.median)} at 2,080 hours` : ""}.`);
      if (hourly) { ask = `Could you bring the rate closer to ${perHour(bench.median)}?`; askSay = `Ask them to bring the rate closer to ${perHour(bench.median)}.`; }
      else { ask = `Could you bring the base closer to ${usd(bench.median)}?`; askSay = `Ask them to bring the base closer to ${usd(bench.median)}.`; }
    } else {
      if (best) because.push(`I have another offer${best.company ? ` from ${best.company}` : ""} with a base of ${usd(best.base)}.`);
      ask = hourly ? "Is there flexibility on the hourly rate or a signing bonus?" : "Is there flexibility on the base or the signing bonus?";
      askSay = hourly ? "Ask whether the hourly rate or a signing bonus can move." : "Ask whether the base or the signing bonus can move.";
    }
    const fallback = o.signing != null ? `If the base is set, a higher signing bonus than ${usd(o.signing)} would also help.` : "If the base is set, a signing bonus would also help.";
    const deadline = opts.deadline && opts.deadline.text ? String(opts.deadline.text) : null;
    const stated = [hourly ? `${"$" + (Number.isInteger(hourly) ? hourly : hourly.toFixed(2))} an hour` : base != null ? `a base of ${usd(base)}` : null, o.signing != null ? `a ${usd(o.signing)} signing bonus` : null].filter(Boolean).join(" and ");
    const email = [
      `Subject: ${role ? `${role[0].toUpperCase() + role.slice(1)} offer` : "Your offer"}${o.company ? `, ${o.company}` : ""}`,
      "",
      "Hi,",
      "",
      `Thank you for the offer${role ? ` for the ${role} role` : ""}${stated ? `, with ${stated}` : ""}. Before I decide, I'd like to talk about the pay.`,
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

  // ---------- C04 (beta 2026-11-04): "should I counter?" and the counter the person can stand behind ----------
  // The live case: a $24/hour support offer, "should I counter?" and "draft a counteroffer for review". The shipped draft
  // asked for the same $24 (the offer's own figure was read as the ask), named "the firm" as the employer, never answered
  // the question and never raised the terms nobody had stated. counterPlan is the one place that decides, from the
  // record alone:
  //   - the counter figure: the person's own stated target when it is above the offer; otherwise the top of a range
  //     derived from a SOURCED benchmark in the offer's own units (labelled with its source and date); otherwise none,
  //     and the person is asked for their target with the reason shown. A figure at or below the offer is never asked for.
  //   - the employer: the name the person gave, or none (the draft leaves it out and the reply asks). Never "the firm".
  //   - a direct answer to "should I counter?", with its reasons, and the terms not on the record (benefits, schedule,
  //     start date) listed and asked for in the draft.
  // Nothing is sent: the draft is held ({ status: "held", sent: false, requires_approval: true }).
  const COUNTER_TERMS = [
    { key: "benefits", label: "benefits (health coverage, paid time off, any retirement plan)", ask: "what benefits come with the role (health coverage, paid time off and any retirement plan)" },
    { key: "schedule", label: "the schedule (hours a week, shift times, weekends)", ask: "the schedule (hours a week, shift times and whether weekends are included)" },
    { key: "start_date", label: "the start date", ask: "the start date you have in mind" },
  ];
  // Pay periods a counter can be stated in. Every figure is said in the unit the person used; nothing is converted.
  const PAY_UNITS = ["hour", "week", "month", "year"];
  const UNIT_PHRASE = { hour: "an hour", week: "a week", month: "a month", year: "a year" };
  const UNIT_NOUN = { hour: "hourly rate", week: "weekly pay", month: "monthly pay", year: "salary" };
  const UNIT_RATE_WORD = { hour: "rate", week: "weekly pay", month: "monthly pay", year: "base salary" };
  const rateShort = (n, unit) => {
    const v = Number(n);
    if (unit === "hour") return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
    return `$${(Number.isInteger(v) ? v : Math.round(v * 100) / 100).toLocaleString("en-US")}`;
  };
  const rateText = (n, unit) => {
    if (n == null || !Number.isFinite(Number(n))) return null;
    return `${rateShort(n, unit)} ${UNIT_PHRASE[unit] || UNIT_PHRASE.year}`;
  };
  // The offer's pay as the person stated it: { rate, low, unit, text, current } or null. A range ("$22-24/hour") keeps
  // both ends; its top is the offer for the never-at-or-below rule. unit is null when no period is stated and the
  // figure is not plainly a salary (a bare "$4,000"): the caller asks rather than guess a unit. Signing bonuses and
  // figures framed as the person's own ask ("counter at $27") are not the offer.
  // Each figure is read in its own clause. A figure in a clause about the person's current or past pay ("I make $20
  // an hour now", "my current job pays $20") is context (`current`), never the offer and never a floor. A figure in a
  // clause with an offer cue ("offered", "the offer is", "they'd pay") is the offer. Two different offer figures, or
  // two uncued figures with no offer cue on either, are not guessed between: { ambiguous: [texts] }.
  function statedPayOf(text) {
    const found = statedPayFigures(text);
    if (!found.length) return null;
    const current = found.filter((f) => f.role === "current");
    const offers = found.filter((f) => f.role === "offer");
    const neutral = found.filter((f) => f.role === "neutral");
    const distinct = (list) => list.filter((f, i) => list.findIndex((g) => g.rate === f.rate && g.unit === f.unit && g.low === f.low) === i);
    const pick = (f) => ({ rate: f.rate, low: f.low, unit: f.unit, text: f.text, current: current.map((c) => ({ rate: c.rate, unit: c.unit, text: c.text })) });
    const off = distinct(offers);
    if (off.length === 1) return pick(off[0]);
    if (off.length > 1) return { ambiguous: off.map((f) => f.text), current: current.map((c) => c.text) };
    const neu = distinct(neutral);
    if (neu.length === 1) return pick(neu[0]);
    if (neu.length > 1) return { ambiguous: neu.map((f) => f.text), current: current.map((c) => c.text) };
    return null; // only current or past pay: no offer was stated
  }
  function statedPayFigures(text) {
    const raw = s(text).replace(/[’]/g, "'").replace(/[‐-―]/g, "-");
    const num = (v, k) => { const n = Number(String(v).replace(/,/g, "")); return k ? n * 1000 : n; };
    const PERIOD = "(hours?|hrs?|hourly|h|weeks?|wks?|weekly|months?|mos?|monthly|years?|yrs?|yearly|annual(?:ly)?|annum)";
    const re = new RegExp(`\\$\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?(k)?(?:\\s*(?:-|to)\\s*\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?(k)?)?(?:\\s*(?:\\/\\s*|an?\\s+|per\\s+|each\\s+)?${PERIOD}\\b)?`, "gi");
    const toUnit = (p) => {
      if (!p) return null;
      const w = p.toLowerCase();
      if (/^(h|hrs?|hours?|hourly)$/.test(w)) return "hour";
      if (/^(wks?|weeks?|weekly)$/.test(w)) return "week";
      if (/^(mos?|months?|monthly)$/.test(w)) return "month";
      return "year";
    };
    // A clause: the text between sentence or clause breaks (. ; ! ? , and the joins "and", "but", "while", "whereas").
    const BREAK = /[.;!?](?=\s|$)|,|\s(?:and|but|while|whereas|though)\s/gi;
    const breaks = [0];
    let bm;
    while ((bm = BREAK.exec(raw))) breaks.push(bm.index, bm.index + bm[0].length);
    breaks.push(raw.length);
    const clauseAt = (start, end) => {
      let lo = 0, hi = raw.length;
      for (const b of breaks) { if (b <= start && b > lo) lo = b; if (b >= end && b < hi) hi = b; }
      return raw.slice(lo, hi).toLowerCase();
    };
    const CURRENT = /\b(i\s+(?:make|earn|get paid|get|am making|'m making|was making|made|earned)|i'm\s+(?:making|earning|paid|getting)|currently|right now|at the moment|my (?:current|old|last|previous|present) (?:job|role|employer|position|pay|rate|salary|wage)|(?:current|last|previous|old|present) (?:job|role|employer|position)|i'm (?:on|at) \$|now\b)/;
    const OFFER = /\b(offer(?:ed|ing|s)?|they'?(?:d| would| will| are|'re)? (?:pay|paying|give|giving)|would pay|will pay|pays? for (?:this|the) (?:role|job|position)|the role pays|this job pays|the job pays|position pays)\b/;
    const out = [];
    let m;
    while ((m = re.exec(raw))) {
      const before = raw.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 25).toLowerCase();
      if (/\b(signing|sign-on|sign on|relocation|bonus|stipend)\b[^$]*$/.test(before) || /^\s*(signing|sign-on|sign on|relocation|bonus|stipend)\b/.test(after)) continue;
      if (/\b(counter(?:\s?offer)?\s+(?:at|with|of|to|for)|ask(?:ing)?\s+(?:them\s+)?(?:for|at|to)|target|goal|i\s+(?:want|need|would like|'d like)(?:\s+to\s+(?:get|ask for|make))?|bring\s+(?:it|the \w+)\s+(?:up\s+)?to)\s*$/.test(before)) continue;
      const a = num(m[1], m[2] || (m[4] && Number(String(m[1]).replace(/,/g, "")) < 1000 ? "k" : null));
      const b = m[3] != null ? num(m[3], m[4] || (m[2] && !m[4] && num(m[3]) < 1000 ? "k" : null)) : null;
      if (!Number.isFinite(a) || a <= 0) continue;
      const hi = b != null && Number.isFinite(b) && b > a ? b : a;
      const lo = b != null && Number.isFinite(b) && b > a ? a : null;
      let unit = toUnit(m[5]);
      if (!unit && hi >= 20000) unit = "year";
      // The clause without the figure itself ("$24/hour" must not read as "hour ... now").
      const clause = clauseAt(m.index, m.index + m[0].length).replace(m[0].toLowerCase(), " ");
      const role = CURRENT.test(clause) && !/\boffer(?:ed|ing|s)?\b/.test(clause) ? "current" : OFFER.test(clause) ? "offer" : "neutral";
      out.push({ rate: hi, low: lo, unit, text: m[0].trim(), role });
    }
    return out;
  }
  // The person's own target, read from their words: a figure framed as the ask ("counter at $27", "ask for $27 an
  // hour", "my target is $27", "I want $27/hr"). A bare figure is the offer, not an ask — that misread
  // is exactly how the shipped draft asked for $24 on a $24 offer.
  function counterTargetOf(text, unit) {
    const t = s(text).replace(/[’]/g, "'").replace(/,(?=\d{3}\b)/g, "");
    const fig = "\\$\\s?(\\d+(?:\\.\\d{1,2})?)\\s?(k)?";
    const frames = [
      new RegExp(`\\bcounter(?:\\s?offer)?\\s+(?:at|with|of|to|for)\\s+${fig}`, "i"),
      new RegExp(`\\b(?:ask(?:ing)?|aim(?:ing)?|hoping|push(?:ing)?)\\s+(?:them\\s+)?(?:for|at|to)\\s+${fig}`, "i"),
      new RegExp(`\\b(?:my\\s+)?(?:target|goal|number|floor|minimum)\\s+(?:is|was|of|would be|=)\\s+${fig}`, "i"),
      new RegExp(`\\bi\\s+(?:want|need|would like|'d like)\\s+(?:to (?:get|ask for|make)\\s+)?${fig}`, "i"),
      new RegExp(`\\b(?:bring|get|move|raise)\\s+(?:it|the (?:rate|pay|base|offer|salary))\\s+(?:up\\s+)?to\\s+${fig}`, "i"),
    ];
    for (const re of frames) {
      const m = t.match(re);
      if (!m) continue;
      let v = Number(m[1]);
      if (m[2]) v *= 1000;
      if (!Number.isFinite(v) || v <= 0) continue;
      // Units follow the offer: "$27" on an hourly offer is $27 an hour; "$70k" on a yearly offer is $70,000.
      if (unit === "year" && v < 1000) continue;
      if (unit === "hour" && v >= 1000) continue;
      if ((unit === "week" || unit === "month") && v < 50) continue;
      return v;
    }
    return null;
  }
  // Which of the three terms the record (or this turn) already holds. A term the person says they do not have yet is
  // missing; a term stated nowhere is missing.
  function missingTermsOf(offer, text) {
    const o = offer || {};
    const t = s(text).toLowerCase();
    const has = {
      benefits: Array.isArray(o.benefits) ? o.benefits.length > 0 : !!o.benefits,
      schedule: !!o.schedule,
      start_date: !!o.start_date,
    };
    // A term the person states ("benefits include health insurance", "starts on Dec 1", "Mon-Fri 9-5") is on the
    // record; one they say they lack ("no benefits details yet", "start date unknown") is missing.
    const TERM_RE = { benefits: "benefits?|health (?:insurance|coverage)|pto|paid time off|401\\(?k\\)?", schedule: "schedule|shifts?|hours a week|full[- ]time|part[- ]time|mon(?:day)?\\s*(?:-|to|through)\\s*fri(?:day)?", start_date: "start(?:ing)? date|start(?:s|ing)? (?:on|in)\\b" };
    const NEG = "(?:no|not|don'?t|do not|haven'?t|have not|without|any|none)";
    for (const key of Object.keys(TERM_RE)) {
      const term = new RegExp(`\\b(?:${TERM_RE[key]})`);
      if (!term.test(t)) continue;
      // Within one clause only: "health insurance; start date unknown" denies the start date, not the benefits.
      const denied = new RegExp(`\\b${NEG}\\b(?:[ \\t/-]+[\\w'-]+){0,4}?[ \\t/-]+(?:${TERM_RE[key]})|(?:${TERM_RE[key]})(?:[ \\t]+[\\w'-]+){0,3}?[ \\t]+(?:yet|unknown|missing|tbd|unclear)\\b`).test(t);
      has[key] = !denied;
    }
    return COUNTER_TERMS.filter((x) => !has[x.key]);
  }
  // A sourced benchmark is usable only in the offer's own units and only with its source and date.
  function usableBenchmark(b, unit) {
    if (!b || typeof b !== "object") return null;
    const high = Number(b.high), low = Number(b.low != null ? b.low : b.high);
    if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0) return null;
    if ((b.unit || "year") !== unit) return null;
    if (!b.cite || !b.as_of) return null;
    return { low: Math.min(low, high), high: Math.max(low, high), median: Number.isFinite(Number(b.median)) ? Number(b.median) : null, cite: String(b.cite), as_of: String(b.as_of), reported: !!b.reported };
  }
  function listJoin(items) {
    const a = items.filter(Boolean);
    if (a.length <= 1) return a.join("");
    if (a.length === 2) return `${a[0]} and ${a[1]}`;
    return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
  }
  // The counter email as UNITS (154 fitUnits): each unit lists wordings of the same content, fullest first, "" where the
  // unit may be left out. The greeting, the pay ask and the sign-off are never left out, so "shorten it to N words"
  // re-fits the same draft and keeps the ask. Layout (154 renderParts "counter_email" is the same): subject, greeting,
  // one line per body unit, sign-off.
  const TERM_SHORT = { benefits: "benefits", schedule: "schedule", start_date: "start date" };
  function counterDraftUnits(i) {
    const roleAt = `${i.role ? ` for the ${i.role} role` : ""}${i.company ? ` at ${i.company}` : ""}`;
    const signingTxt = Number.isFinite(Number(i.signing)) && Number(i.signing) > 0 ? `, plus the $${Math.round(Number(i.signing)).toLocaleString("en-US")} signing bonus` : "";
    const missing = i.missing || [];
    const before = `Before I accept, I'd like to ask about the pay${missing.length ? " and a few details" : ""}.`;
    const units = [{ id: "greet", variants: ["Hi,"] }];
    // [wording, weight] pairs, fullest first; a repeated wording keeps its first (higher) weight. The weights decide what
    // goes first when a re-fit has to cut: the courtesy line, then the terms ask; the pay ask keeps its fullest wording.
    const mk = (id, pairs) => {
      const seen = new Set(), variants = [], weights = [];
      for (const [v, w] of pairs) { if (seen.has(v)) continue; seen.add(v); variants.push(v); weights.push(w); }
      return { id, variants, weights };
    };
    units.push(mk("thanks", [
      [`Thank you for the offer${roleAt}: ${i.offerText}${signingTxt}. ${before}`, 20],
      [`Thank you for the offer${roleAt}: ${i.offerText}${signingTxt}.`, 16],
      [`Thank you for the offer of ${i.offerText}.`, 14],
      ["Thank you for the offer.", 12],
    ]));
    const rateWord = UNIT_RATE_WORD[i.unit] || UNIT_RATE_WORD.year;
    if (i.counter) {
      const fig = rateText(i.counter.value, i.unit);
      const why = i.counter.basis === "sourced_range" && i.range ? ` Public pay data for this role (${i.range.cite}, as of ${i.range.as_of}) runs up to ${rateShort(i.range.high, i.unit)}.` : "";
      const keep = i.keepSigning && signingTxt ? " The signing bonus as offered works for me." : "";
      units.push(mk("ask", [[`Could you bring the ${rateWord} to ${fig}?${why}${keep}`, 60], [`Could you bring the ${rateWord} to ${fig}?${keep}`, 55], [`Could you bring the ${rateWord} to ${fig}?`, 50], [`Could you do ${fig}?`, 30]]));
    } else {
      units.push(mk("ask", [[`Is there room to move the ${i.unit === "year" ? "base salary" : UNIT_NOUN[i.unit] || "pay"} above ${i.offerText}?`, 60], [`Can the ${rateWord} go above ${i.offerText}?`, 30]]));
    }
    if (missing.length) {
      const short = listJoin(missing.map((m) => TERM_SHORT[m.key] || m.key));
      units.push(mk("terms", [[`Could you also send me ${listJoin(missing.map((m) => m.ask))}?`, 24], [`Could you also send me the ${short} details?`, 20], [`What are the ${short}?`, 18], ["", 0]]));
    }
    if (i.deadline) units.push(mk("deadline", [[`I'll get back to you by ${String(i.deadline).replace(/^(mon|tues|wednes|thurs|fri|satur|sun)day\b/i, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())}.`, 10], ["", 0]]));
    units.push({ id: "sign", variants: [i.senderName ? `Thank you,\n${s(i.senderName)}` : "Thank you,"] });
    return units;
  }
  function renderCounterUnits(parts, subject) {
    const p = parts.filter((x) => x && String(x).trim());
    return [subject ? `Subject: ${subject}` : null, subject ? "" : null, p[0], "", ...p.slice(1, -1), "", p[p.length - 1]].filter((x) => x !== null).join("\n");
  }
  // offer: { company, role, rate, unit ("hour" | "year"), signing, benefits, schedule, start_date, deadline }
  // opts:  { text (this turn's words), target (a target already on the record), benchmark ({ low, high, median, unit,
  //          cite, as_of, reported }), keepSigning, senderName }
  function counterPlan(offer, opts) {
    opts = opts || {};
    const o = offer || {};
    const unit = PAY_UNITS.includes(o.unit) ? o.unit : "year";
    const rateLow = Number.isFinite(Number(o.rate_low)) && Number(o.rate_low) > 0 ? Number(o.rate_low) : null;
    const rate = Number.isFinite(Number(o.rate)) && Number(o.rate) > 0 ? Number(o.rate) : null;
    const clean = (v) => s(v).trim().replace(/[\s.,;:!?]+$/, "");
    const company = o.company && clean(o.company) && !/^(the )?(firm|company|employer|team|recruiter)$/i.test(clean(o.company)) ? clean(o.company) : null;
    // "customer support job" is the role "customer support": the noun the role was named with is not part of it.
    const role = o.role && clean(o.role) ? clean(o.role).replace(/\s+(job|role|position|offer)$/i, "").trim() || null : null;
    const roleRef = role ? `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role} role` : "this role";
    // A range is restated as the person gave it; its top is what any counter must clear.
    const offerText = rate != null && rateLow != null && rateLow < rate ? `${rateShort(rateLow, unit)} to ${rateText(rate, unit)}` : rateText(rate, unit);
    const stated = counterTargetOf(opts.text, unit);
    const recorded = Number.isFinite(Number(opts.target)) && Number(opts.target) > 0 ? Number(opts.target) : null;
    let target = null, rejected = null;
    // "Counter at the same rate" / "ask for the same amount": a counter at the offer itself asks for nothing.
    const sameRate = rate != null && /\b(?:counter|ask(?:ing)?(?: them)?(?: for)?|stick|keep it|go back)\b[^.?!]{0,30}\b(?:same|current|their|that|the offered)\s+(?:rate|pay|amount|figure|number|salary|offer)\b/i.test(s(opts.text));
    if (stated != null) { if (rate != null && stated <= rate) rejected = stated; else target = stated; }
    else if (sameRate) rejected = rate;
    else if (recorded != null && (rate == null || recorded > rate)) target = recorded;
    const bench = usableBenchmark(opts.benchmark, unit);
    let range = null;
    if (bench && rate != null && bench.high > rate) {
      // The range starts at the first sourced figure above the offer (the median, else the low end); when only the top
      // is above the offer, the range is "above the offer, up to the top".
      const low = [bench.median, bench.low].find((x) => x != null && x > rate);
      range = { low: low != null ? low : null, high: bench.high, cite: bench.cite, as_of: bench.as_of, reported: bench.reported };
    }
    // With no figure of the person's and no sourced range, a counter is still worth asking for (unless sourced figures
    // sit at or below the offer): the suggestion is a modest step above the offer, said to be judgment, never market
    // data. About 8% on an hourly rate, rounded up to a whole dollar ($24 -> $26); about 7% on a salary, rounded up to
    // the next $1,000 ($70,000 -> $75,000). Always above the offer.
    const benchBelow = !!(bench && rate != null && bench.high <= rate);
    let judgment = null;
    if (target == null && !range && rate != null && rejected == null && !benchBelow) {
      const v = unit === "hour" ? Math.ceil(rate * 1.08) : unit === "week" ? Math.ceil((rate * 1.07) / 10) * 10 : unit === "month" ? Math.ceil((rate * 1.07) / 50) * 50 : Math.ceil((rate * 1.07) / 1000) * 1000;
      judgment = v > rate ? v : null;
    }
    const counter = target != null ? { value: target, basis: "person_target" } : range ? { value: range.high, basis: "sourced_range" } : judgment != null ? { value: judgment, basis: "judgment" } : null;
    const missing = missingTermsOf(o, opts.text);
    const needs = [];
    if (rate == null) needs.push("offer_figure");
    if (!company) needs.push("company");
    if (!counter && rate != null) needs.push("target");

    // The direct answer to "should I counter?" — a verdict first, then its reasons. No outcome is promised.
    const reasons = [];
    let verdict;
    const risk = "One polite counter is, in my judgment, a normal part of accepting an offer, but I can't promise how this employer will react: the answer can be a yes, a smaller move or a no, and in rare cases an offer is withdrawn.";
    if (rate == null) {
      verdict = "I can answer that once I know the figure they offered.";
    } else if (rejected != null) {
      verdict = `Not at ${rateShort(rejected, unit)}: that is at or below the ${offerText} they already offered, so it asks for nothing.`;
      if (sameRate && stated == null) verdict = `Countering at the same ${offerText} asks for nothing new, so it isn't a counter; if ${offerText} works for you, accepting it and asking about the terms is the stronger email.`;
      reasons.push(`A counter has to be above ${offerText}.`);
    } else if (counter && counter.basis === "judgment") {
      const pct = Math.round(((counter.value - rate) / rate) * 100);
      verdict = `Yes, counter once, in writing, at ${rateText(counter.value, unit)}, a figure that is my judgment, not market data.`;
      reasons.push(`I have no sourced pay figure for ${roleRef}${company ? ` at ${company}` : ""}, so I won't quote a market rate. ${rateText(counter.value, unit)} is a modest step, about ${pct}% above the ${offerText} on the table: enough to be worth asking for, small enough to be a reasonable first ask. If you have a number of your own, I'll use yours.`);
      reasons.push(risk);
    } else if (counter) {
      verdict = `Yes, counter once, in writing, at ${rateText(counter.value, unit)}.`;
      if (counter.basis === "person_target") reasons.push(`${rateText(counter.value, unit)} is the figure you named, and it is above the ${offerText} on the table.`);
      else reasons.push(`It is the top of a range derived from ${range.cite}${range.reported ? " (a reported figure, not a measured one)" : ""}, as of ${range.as_of}: ${range.low != null ? `${rateShort(range.low, unit)} to ${rateShort(range.high, unit)}` : `above ${rateShort(rate, unit)}, up to ${rateShort(range.high, unit)}`} ${UNIT_PHRASE[unit]}.`);
      reasons.push(risk);
    } else if (benchBelow) {
      verdict = `On pay alone, probably not: the sourced figures (${bench.cite}, as of ${bench.as_of}) top out at ${rateShort(bench.high, unit)}, at or below ${offerText}.`;
      reasons.push("If you counter anyway, put the ask on the terms (start date, schedule) rather than the rate, or name a figure of your own and say why.");
    } else {
      verdict = `Yes, it's reasonable to ask whether the pay can move; that is my judgment, and I have no sourced pay figure for ${roleRef}${company ? ` at ${company}` : ""}.`;
      reasons.push(risk);
    }
    const termsLine = missing.length ? `Before you decide, get the rest of the package: ${listJoin(missing.map((m) => m.label))} ${missing.length === 1 ? "is" : "are"} not on your record yet, and ${offerText || "the pay"} alone can't tell you whether the offer is a good one.` : null;
    if (termsLine) reasons.push(termsLine);
    // Current or past pay the person mentioned is context only: the counter is measured against the offer.
    const cur = Array.isArray(opts.current) ? opts.current.filter((c) => c && c.text) : [];
    if (cur.length && rate != null) reasons.push(`You mentioned ${cur.map((c) => c.text).join(" and ")} as what you make now; that's context, and the counter is measured against the ${offerText} offer.`);
    const targetQuestion = rejected != null
      ? `Want an email that accepts ${offerText} and asks about the terms, or a counter at a figure above it?`
      : rate != null && !counter
      ? `To name a figure in the draft, it has to be yours and above ${offerText}: what ${UNIT_NOUN[unit]} would make this an easy yes for you?`
      : counter && counter.basis === "judgment"
        ? `Keep ${rateText(counter.value, unit)} in the draft, or tell me your own figure (it has to be above ${offerText}).`
        : null;
    const companyQuestion = !company ? "I'll put the employer's name in the draft rather than a placeholder: which company made the offer?" : null;

    // The draft: held, never sent. With no counter figure it asks whether the rate can move (no number is invented)
    // and asks for the missing terms; with one it asks for that figure.
    let draft = null;
    if (rate != null && rejected == null) {
      const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
      const subject = `${role ? `${cap(role)} offer` : "Your offer"}${company ? `, ${company}` : ""}`;
      const units = counterDraftUnits({ role, company, offerText, unit, signing: o.signing, keepSigning: !!opts.keepSigning, counter, range, rate, missing, deadline: o.deadline || null, senderName: opts.senderName || null });
      const body = renderCounterUnits(units.map((u) => u.variants[0]), subject);
      draft = { kind: "counter_email", body, text: body, subject, units, company, status: "held", sent: false, requires_approval: true, counter_figure: counter ? counter.value : null, counter_basis: counter ? counter.basis : null, asks_terms: missing.map((m) => m.key) };
    }
    // "I have no benefits or schedule details yet": the terms answer on its own.
    const terms = missing.length
      ? { headline: `Then get ${listJoin(missing.map((m) => m.key === "start_date" ? "the start date" : m.key))} in writing before you decide — they are part of what ${offerText || "the offer"} is worth.`, line: termsLine }
      : { headline: "Benefits, schedule and start date are all on your record, so the offer can be judged as a whole.", line: null };
    return { sends: false, unit, rate, rateLow, offerText, counterText: counter ? rateText(counter.value, unit) : null, company, role, target, rejected, range, counter, missing: missing.map((m) => ({ key: m.key, label: m.label })), needs, answer: { verdict, reasons }, terms, targetQuestion, companyQuestion, draft };
  }

  return { DISCLAIMER, payData, factScript, createStore, counterPlan, counterTargetOf, statedPayOf, statedPayFigures, missingTermsOf, counterDraftUnits, renderCounterUnits, COUNTER_TERMS, parseOffer, parseDate, parseMoney, storeOffer, extractFigures, benchmark, totalComp, compareOffers, bonusAmount, approvalCard, counterStrategy, roleplayTurn, extensionDraft, trackExtension, declineDraft, deadlinePlan };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerNegotiation;
