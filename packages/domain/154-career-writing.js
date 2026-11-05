/* Career writing pattern (MI-097 / BUG-236 / FR-394).
   Design: docs/career/writing-pattern-prompt-v2.md renders this module's
   template; the design of record is
   ~/workspace/your_files/writing-pattern/design-upmore-writing-pattern.md.

   THE DEFECT THIS MODULE EXISTS TO KILL (BUG-236): the draft QA that
   shipped the owner's real 12-draft networking wave on 2026-10-13
   (124's qualityGate + the same-firm skeleton check) passed every draft
   while the wave failed HS-1/2/3/4/5/6 on measurement — verbatim
   sentence reuse 12/12, one bridge clause 12/12, one subject frame
   12/12 (five byte-identical subjects to one firm), word counts in a
   92–109 band (ratio 1.18), one fact kind 12/12, one logistics string
   12/12. The words were clean; the sameness was the tell, and nothing
   in the product measured sameness, voice, fact-tracing, or whether a
   context forbids AI-written text at all.

   PIPELINE (design §1): [G0] prohibition gate runs FIRST and cannot be
   overridden downstream -> fact pack -> voice profile -> generation
   (pattern prompt v2 + structural seed) -> slop gate (deterministic
   metrics + fact-lock) with a targeted rewrite loop (max 2; a
   still-failing draft is returned WITH its failing metrics named,
   never unflagged) -> batch variation enforcer for waves.

   HONEST LIMITS (design §9, claims register): this module never runs
   or quotes a third-party AI detector and never claims a draft is
   "undetectable". It measures distance to THIS user's own writing
   (never to a generic human mean — design §2.5), sameness within and
   across drafts, and whether every entity/number/date traces to a
   fact. That is all it claims.

   Functions:
     resolvePolicy(context)     the context's AI-use policy + its source
     gate0(context)             { allowed, policy, reason, assistance[] }
     extractVoiceProfile(samples, opts)
                                measured voice statistics, or null (cold
                                start: NO profile — the product says so)
     voiceTargetsText(profile)  the profile as plain-language targets
     sampleStructuralSeed(profile, opts)
                                per-draft opening/length/shape/lead seed
     renderPromptV2(profile, seed)
                                pattern prompt v2 with blocks filled
     traceFacts(text, factPack, opts)
                                every entity/number/date -> traced or not
     slopGate(text, opts)       per-draft deterministic scorecard
     rewriteInstruction(card)   the targeted instruction from a scorecard
     runGateLoop(generate, opts) generate -> gate -> rewrite (max 2)
     batchGate(drafts, opts)    the §4 wave-level variation enforcer
     captureEdits(profile, originalText, editedText)
                                user edits folded back into the profile
     composePatternDraft(input) deterministic reference generator (the
                                harness/offline generation path; the
                                hosted path injects its own generator
                                driven by renderPromptV2's text) */
const CareerWriting = (() => {
  "use strict";

  // ---------------- text utilities ----------------
  // Apostrophes are removed entirely ("school's" -> "schools", "i'm" ->
  // "im") so possessives and contractions match across renderings.
  const norm = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/'/g, "").replace(/\s+/g, " ").trim();
  const wordsOf = (s) => String(s || "").split(/\s+/).filter(Boolean);
  function splitParagraphs(text) {
    return String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  function splitSentences(text) {
    const flat = String(text || "").replace(/\s*\n\s*/g, " ");
    const parts = flat.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
    return parts.map((s) => s.trim()).filter((s) => /[A-Za-z0-9]/.test(s));
  }
  // The envelope is not prose: a greeting-only first paragraph and the
  // trailing sign-off block carry the sender's signature data (class
  // years, school lines), which are not claims the fact-lock grades.
  function stripEnvelope(text) {
    const paras = splitParagraphs(text);
    const kept = paras.filter((p, i) => {
      if (i === 0 && /^(hi|hello|hey)\b/i.test(p) && wordsOf(p).length <= 4) return false;
      if (/^(thanks|thank you|sincerely|best|warmly)\b/i.test(p)) return false;
      return true;
    });
    return kept.join("\n\n");
  }
  // A seeded RNG (mulberry32): structural seeds must be reproducible in
  // tests and varied in production (caller passes a seed per draft).
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m)))); };
  const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  // ---------------- [G0] prohibition gate (design §7) ----------------
  // Policy values: AI_OK / AI_ASSIST_WITH_DISCLOSURE / OWNER_WRITE_ONLY /
  // UNKNOWN. UNKNOWN is treated as OWNER_WRITE_ONLY until a rule is found
  // and recorded — absence of a found prohibition is not permission.
  const POLICY_REGISTRY = [
    {
      id: "MATS",
      match: (c) => /mats\b/i.test(String(c.program || c.contextName || "")) || /ml alignment theory scholars/i.test(String(c.program || "")),
      policy: "OWNER_WRITE_ONLY",
      source: "MATS program rules as recorded in the owner's fellowship landscape + census 2026-10-15: the program prohibits LLM-written application text and states it monitors for it.",
    },
  ];
  const KIND_DEFAULTS = {
    outreach: "AI_OK",
    outreach_email: "AI_OK",
    cover_letter: "AI_OK",
    networking_email: "AI_OK",
    follow_up: "AI_OK",
    referral_ask: "AI_OK",
    personal_statement: "UNKNOWN",
    fellowship_statement: "UNKNOWN",
    application_essay: "UNKNOWN",
    program_statement: "UNKNOWN",
  };
  function resolvePolicy(context) {
    // Accept both the flat context ({kind, program, aiPolicy, ...}) and
    // the nested form ({kind, program, context: {...}}) the pipeline
    // call sites pass.
    const c = Object.assign({}, (context && context.context) || {}, context || {});
    delete c.context;
    // An explicit, sourced policy on the context itself wins (e.g. a CIR
    // that records an employer's ban — 123's cover path already honors
    // cir.aiPolicy === "ban"; the registry speaks the same truth here).
    if (c.aiPolicy === "ban" || c.aiPolicy === "OWNER_WRITE_ONLY" || c.bansAiWrittenText) {
      return { policy: "OWNER_WRITE_ONLY", source: c.aiPolicySource || "the context's own record states AI-written text is banned here", entry: "context" };
    }
    if (c.aiPolicy === "AI_ASSIST_WITH_DISCLOSURE" || c.aiPolicy === "disclose") {
      return { policy: "AI_ASSIST_WITH_DISCLOSURE", source: c.aiPolicySource || "the context's own record allows AI assistance with disclosure", entry: "context" };
    }
    if (c.aiPolicy === "AI_OK" || c.aiPolicy === "ok") {
      return { policy: "AI_OK", source: c.aiPolicySource || "the context's own record allows AI drafting", entry: "context" };
    }
    for (const e of POLICY_REGISTRY) {
      let hit = false;
      try { hit = !!e.match(c); } catch { hit = false; }
      if (hit) return { policy: e.policy, source: e.source, entry: e.id };
    }
    const kind = String(c.kind || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KIND_DEFAULTS, kind)) {
      return { policy: KIND_DEFAULTS[kind], source: KIND_DEFAULTS[kind] === "UNKNOWN" ? "no rule for this context has been checked and recorded; UNKNOWN defaults to owner-write-only (design §7.1)" : "ordinary drafting context; no prohibition on record", entry: "kind:" + kind };
    }
    return { policy: "UNKNOWN", source: "unrecognized drafting context; UNKNOWN defaults to owner-write-only (design §7.1)", entry: "default" };
  }
  const OWNER_WRITE_ASSISTANCE = [
    "organize your confirmed facts for this statement",
    "give you the structure and prompts to write from",
    "check your own draft for the mechanics you ask about (names spelled right, word count)",
  ];
  function gate0(context) {
    const r = resolvePolicy(context);
    if (r.policy === "OWNER_WRITE_ONLY" || r.policy === "UNKNOWN") {
      const name = (context && (context.program || context.contextName)) || "This program";
      return {
        allowed: false, policy: r.policy, entry: r.entry, source: r.source,
        reason: `${name} prohibits AI-written application text, so I won't draft this — here are your facts organized, and the structure, for your own draft.`,
        assistance: OWNER_WRITE_ASSISTANCE.slice(),
      };
    }
    return {
      allowed: true, policy: r.policy, entry: r.entry, source: r.source,
      disclosureRequired: r.policy === "AI_ASSIST_WITH_DISCLOSURE",
      reason: r.policy === "AI_ASSIST_WITH_DISCLOSURE" ? "AI assistance is allowed here with disclosure; the draft carries the required disclosure." : "No prohibition on record for this context.",
      assistance: [],
    };
  }

  // ---------------- [1] voice profile (design §2) ----------------
  const FUNCTION_WORDS = ["and", "but", "so", "actually", "honestly", "just", "really", "also", "though", "because"];
  const OPENER_TIME = /^(last|this|in|on|after|before|when|since|during|over|back)\b/i;
  const OPENER_STARTERS = new Set(["if", "totally", "whatever", "another", "any", "also", "still", "just", "now", "then", "here", "well", "sure", "yes", "no", "thanks", "thank", "most", "even", "much", "more", "each", "every", "finally", "however", "instead", "often", "sometimes", "maybe", "perhaps", "currently", "recently", "earlier", "later", "today", "back", "glad", "happy", "quick", "short", "keeping", "looking", "writing", "reaching", "hoping", "working", "building", "making", "taking", "getting", "let", "please", "given", "based", "using", "having", "being", "going", "coming", "trying", "starting", "joining", "leaving", "moving", "reading", "hearing", "seeing", "knowing", "thinking", "asking", "wondering", "sending", "sharing", "checking", "following", "adding", "noting"]);
  function openerClass(sentence) {
    const s = sentence.trim();
    if (!s) return "other";
    const firstWord = (s.match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
    if (/\?$/.test(s)) return "question";
    if (/^(hi|hello|hey)\b/i.test(s)) return "greeting";
    if (/^(and|but|so)\b/i.test(s)) return "conjunction";
    if (/^(i|i'm|i've|i'd|i'll|my)\b/i.test(s)) return "first_person";
    if (/^(we|we're|our)\b/i.test(s)) return "we";
    if (/^(you|your|you're)\b/i.test(s)) return "second_person";
    if (OPENER_TIME.test(s)) return "time";
    if (firstWord === "if") return "conditional";
    if (OPENER_STARTERS.has(firstWord)) return "other";
    if (/^(it|there|that|this)\b/i.test(s)) return "impersonal";
    if (/^[A-Z][a-z]+/.test(s)) return "name_or_noun";
    const w = wordsOf(s).length;
    if (w <= 4) return "fragment";
    return "other";
  }
  function computeStats(texts) {
    const sentences = texts.flatMap((t) => splitSentences(t));
    const paras = texts.flatMap((t) => splitParagraphs(t));
    const lens = sentences.map((s) => wordsOf(s).length).filter((n) => n > 0);
    const allWords = texts.reduce((a, t) => a + wordsOf(t).length, 0);
    const openers = {};
    for (const s of sentences) { const k = openerClass(s); openers[k] = (openers[k] || 0) + 1; }
    const openerRates = {};
    for (const k of Object.keys(openers)) openerRates[k] = +(openers[k] / Math.max(1, sentences.length)).toFixed(4);
    const fw = {};
    const lowText = " " + norm(texts.join(" ")) + " ";
    for (const w of FUNCTION_WORDS) {
      const n = (lowText.match(new RegExp("\\b" + w + "\\b", "g")) || []).length;
      fw[w] = +(n / Math.max(1, sentences.length) * 100).toFixed(2); // per 100 sentences
    }
    const per100 = (count) => +(count / Math.max(1, sentences.length) * 100).toFixed(2);
    const joined = texts.join("\n");
    const paraSentCounts = paras.map((p) => splitSentences(p).length).filter((n) => n > 0);
    return {
      sentenceCount: sentences.length,
      wordCount: allWords,
      sentenceLength: {
        mean: +mean(lens).toFixed(2), sd: +sd(lens).toFixed(2),
        cv: +(mean(lens) ? sd(lens) / mean(lens) : 0).toFixed(3),
        p10: pct(lens, 0.1), p90: pct(lens, 0.9),
        shortShare: +(lens.filter((n) => n <= 6).length / Math.max(1, lens.length)).toFixed(3),
        longShare: +(lens.filter((n) => n >= 30).length / Math.max(1, lens.length)).toFixed(3),
      },
      paragraphs: {
        count: paras.length,
        sentencesPerParagraph: +mean(paraSentCounts).toFixed(2),
        singleSentenceRate: +(paraSentCounts.filter((n) => n === 1).length / Math.max(1, paraSentCounts.length)).toFixed(3),
      },
      openers: openerRates,
      functionWords: fw,
      contractionRate: +(((joined.match(/\b\w+['’](t|s|re|ve|ll|d|m)\b/g) || []).length) / Math.max(1, allWords) * 100).toFixed(2), // per 100 words
      firstPersonRate: +(sentences.filter((s) => /\b(i|i'm|i've|my|me|we|our)\b/i.test(s)).length / Math.max(1, sentences.length)).toFixed(3),
      punctuation: {
        emDashPer100: per100((joined.match(/—|--/g) || []).length),
        parentheticalPer100: per100((joined.match(/\([^)]*\)/g) || []).length),
        commasPer100Words: +(((joined.match(/,/g) || []).length) / Math.max(1, allWords) * 100).toFixed(2),
        questionPer100: per100(sentences.filter((s) => /\?\s*$/.test(s)).length),
        exclamationPer100: per100(sentences.filter((s) => /!\s*$/.test(s)).length),
      },
      // Sufficient statistics so edit capture (§2.4) can fold new text in
      // without retaining prose: sentence-length sum/sumsq/count + opener
      // counts + sentence count. Statistics, not copies.
      acc: {
        sentenceLengths: lens.slice(0, 2000),
        openerCounts: openers,
        sentenceCount: sentences.length,
      },
    };
  }
  // samples: [{ text, audience? }] — ONLY the user's own writing (design
  // §2.1). No samples -> null: cold start means NO profile, and the
  // product says so; a fingerprint is never synthesized from facts.
  function extractVoiceProfile(samples, opts) {
    const o = opts || {};
    // Samples arrive as plain strings or {text, audience?} records
    // (design §2.3 accepts both).
    const normSample = (s) => (typeof s === "string" ? { text: s } : s && typeof s.text === "string" ? s : null);
    const list = (samples || []).map(normSample).filter((s) => s && s.text.trim().length >= 40);
    if (!list.length) return null;
    const texts = list.map((s) => s.text);
    const stats = computeStats(texts);
    if (stats.sentenceCount < 3) return null; // too thin to be a voice; say so rather than fake one
    const snippets = [];
    for (const t of texts) {
      const s = splitSentences(t)[0];
      if (s && s.length >= 30) snippets.push(s.slice(0, 280));
      if (snippets.length >= 2) break;
    }
    const profile = {
      kind: "voice_profile", version: 1,
      basis: { samples: list.length, sentences: stats.sentenceCount, words: stats.wordCount, edits: 0 },
      sentenceLength: stats.sentenceLength,
      paragraphs: stats.paragraphs,
      openers: stats.openers,
      functionWords: stats.functionWords,
      contractionRate: stats.contractionRate,
      firstPersonRate: stats.firstPersonRate,
      punctuation: stats.punctuation,
      snippets,
      acc: stats.acc,
    };
    // Register range (§2.2): per-audience sub-profiles only when the
    // samples actually span audiences; never extrapolated silently.
    const byAud = {};
    for (const s of list) if (s.audience) (byAud[s.audience] = byAud[s.audience] || []).push(String(s.text));
    const audKeys = Object.keys(byAud).filter((k) => byAud[k].length >= 1 && computeStats(byAud[k]).sentenceCount >= 3);
    if (audKeys.length >= 2) {
      profile.byAudience = {};
      for (const k of audKeys) { const st = computeStats(byAud[k]); profile.byAudience[k] = { sentenceLength: st.sentenceLength, openers: st.openers, contractionRate: st.contractionRate, firstPersonRate: st.firstPersonRate, punctuation: st.punctuation }; }
    }
    if (o.userId) profile.userId = o.userId;
    return profile;
  }
  function voiceTargetsText(profile) {
    if (!profile) return "No voice profile exists for this user yet — the product says so and offers sample intake; generation uses the generic pattern (v1) meanwhile.";
    const sl = profile.sentenceLength, pu = profile.punctuation;
    const topOpeners = Object.entries(profile.openers || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, " ")} (${Math.round(v * 100)}%)`).join(", ");
    const lines = [
      `Your sentences average ${sl.mean} words but swing: about ${Math.round(sl.shortShare * 100)} in 100 are six words or fewer, and about ${Math.round(sl.longShare * 100)} in 100 run past 30 (your spread, CV ${sl.cv}).`,
      `You open sentences most often with: ${topOpeners || "no dominant opener"}.`,
      `Em dashes in your writing: ${pu.emDashPer100} per 100 sentences. Parenthetical asides: ${pu.parentheticalPer100} per 100 sentences. Questions: ${pu.questionPer100} per 100 sentences. Exclamations: ${pu.exclamationPer100} per 100 sentences.`,
      `Contractions: ${profile.contractionRate} per 100 words. First person in ${Math.round(profile.firstPersonRate * 100)}% of your sentences.`,
      `Your paragraphs average ${profile.paragraphs.sentencesPerParagraph} sentences; ${Math.round(profile.paragraphs.singleSentenceRate * 100)}% of them stand alone.`,
    ];
    if (profile.snippets && profile.snippets.length) lines.push(`Your own words, for rhythm: "${profile.snippets[0]}"${profile.snippets[1] ? ` / "${profile.snippets[1]}"` : ""}`);
    return lines.join("\n");
  }
  // Per-draft structural seed sampled from the PROFILE's own distributions
  // (design §3): variation by construction, not by hope.
  // Opening CONSTRUCTIONS the generator can actually build; a profile's
  // measured opener classes map onto them (first_person -> self_intro,
  // time/impersonal -> fact_lead, name_or_noun -> name_intro, fragment
  // -> short_honest). Cold start samples the constructions evenly —
  // variation by construction even before a voice exists.
  const OPENING_CONSTRUCTIONS = ["fact_lead", "name_intro", "self_intro", "question", "short_honest"];
  function sampleStructuralSeed(profile, opts) {
    const o = opts || {};
    const r = rng(o.seed != null ? o.seed : 1234567);
    let dist;
    if (profile && profile.openers) {
      const op = profile.openers;
      dist = {
        fact_lead: (op.time || 0) + (op.impersonal || 0) + (op.other || 0) + (op.conditional || 0),
        name_intro: op.name_or_noun || 0,
        self_intro: (op.first_person || 0) + (op.we || 0) + (op.conjunction || 0),
        question: op.question || 0,
        short_honest: op.fragment || 0,
      };
      if (Object.values(dist).every((v) => !v)) dist = null;
    }
    let openingMode;
    if (o.openingMode && OPENING_CONSTRUCTIONS.includes(o.openingMode)) openingMode = o.openingMode;
    else if (dist) {
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      let x = r() * total;
      openingMode = "fact_lead";
      for (const k of OPENING_CONSTRUCTIONS) { x -= dist[k] || 0; if (x <= 0) { openingMode = k; break; } }
    } else {
      openingMode = OPENING_CONSTRUCTIONS[Math.floor(r() * OPENING_CONSTRUCTIONS.length)];
    }
    const sl = profile ? profile.sentenceLength : { mean: 14, sd: 7, p10: 6, p90: 26 };
    const spp = profile ? profile.paragraphs.sentencesPerParagraph : 1.6;
    // A wave assembler may assign a length tier per draft (short drafts
    // stay short — HS-4's fix); single drafts sample the full range.
    const tierFactor = o.lengthTier === "short" ? 0.55 : o.lengthTier === "long" ? 1.6 : 1.0;
    const targetSentences = Math.max(3, Math.round(spp * (1.2 + r() * 3) * tierFactor));
    const meanWords = Math.max(5, sl.mean + (r() - 0.5) * 2 * (sl.sd || 5));
    // Per-draft length factor: a wave must contain genuinely short and
    // genuinely long drafts (HS-4) — the band center swings with the seed.
    const center = Math.round(targetSentences * meanWords * (0.65 + r() * 0.9));
    const band = { min: Math.max(25, Math.round(center * 0.75)), max: Math.round(center * 1.3) };
    const kinds = o.leadFactKinds && o.leadFactKinds.length ? o.leadFactKinds : ["registry", "work_product", "shared_context", "publication", "path"];
    const leadFactKind = o.leadFactKind || kinds[Math.floor(r() * kinds.length)];
    return { openingMode, targetSentences, lengthBand: band, paragraphCount: Math.max(2, Math.round(targetSentences / Math.max(1, spp))), leadFactKind };
  }

  // ---------------- [2] pattern prompt v2 (design §3) ----------------
  // The canonical text lives in docs/career/writing-pattern-prompt-v2.md;
  // this constant is the runtime copy and a guard asserts the two agree.
  const PATTERN_PROMPT_V2_TEMPLATE = `You are writing AS this person, in their voice, from their confirmed facts only. Never invent an event, number, date, name, or feeling they have not actually provided.

VOICE — THIS PERSON'S MEASURED NUMBERS (from their own writing; design §2.2)
{{voice_numbers}}
Write to those numbers, not to a generic idea of "natural". Their rhythm is the target even where it differs from yours.

THIS DRAFT'S STRUCTURE (assigned, not optional; design §3 structural seed)
{{structural_seed}}
- Opening mode: write the first sentence in the assigned mode.
- Length: land inside the assigned band. A short draft stays short.
- Paragraphs: use the assigned count; no two the same shape.
- Lead fact kind: lead with a fact of the assigned kind from the fact pack.

VOICE RULES (from v1, unchanged)
1. Burstiness is the whole game. Mix very short sentences with long ones. A 4-word sentence. Then one that runs, stacks two or three real details, and lands somewhere specific. Never write five medium-length sentences in a row.
2. Specific beats general, every time. Names, numbers, dates, places, dollar amounts — if a sentence could be written about anyone, rewrite it until it could only be about this person.
3. First person. Contractions always (I'm, don't, it's). Start a sentence with And or But when a person would. Use a fragment when it sounds like speech. Occasional parenthetical aside — like this — is fine.
4. Have a point of view. Say what they actually think, including the mildly unflattering or uncertain parts. Hedged, committee-approved prose reads as machine prose.
5. Open with the most specific true thing, never a generality.
6. No two adjacent sentences starting the same way.

STAGING BANS (design §3 — stating, not staging)
- No "not X, but Y" contrast frames. Say the true half plainly.
- No one-line dramatic closer. No aphorism or saying standing in for a claim.
- No staged run-ups ("Here's the thing —", "Let's be honest:"). Start at the fact.
- Never argue with an objection nobody raised.
- No inflated-significance clauses ("a pivotal moment for the industry") and no "experts say" without a named source from the fact pack.

CLOSE RULE (enforceable form of v1's "close concrete")
The final sentence must contain a fact, a date, a number, or an ask. Never a restatement or summary of what the draft just said.

BANNED — instant slop tells (v1 list, unchanged)
delve, furthermore, moreover, additionally, in conclusion, it's worth noting, it's important to note, in today's fast-paced world, landscape, realm, tapestry, journey (as a metaphor), passionate about (unless a fact proves it), leverage/utilize (say "use"), "not only X but also Y", tidy rule-of-three lists, "I am writing to express", "I would be honored", "I look forward to hearing from you", generic praise of the reader or their company, and any sentence praising how "exciting" or "incredible" something is without a fact attached.

FACT LAW
Every claim traces to a provided fact (the fact pack lists each fact with its ID). If the perfect sentence needs a fact you don't have, write the plainer sentence or leave the gap visible — never fill it with something plausible. A stance or feeling may be phrased only when the person's own materials state it.

SELF-CHECK BEFORE RETURNING
Read it aloud in your head. If it sounds like a press release, a template, or a very polite stranger, rewrite it. If you can swap the person's name for anyone else's and nothing breaks, rewrite it. If every sentence is the same length and rhythm, rewrite it. Check the close rule and the staging bans last — they are the tells that survive a casual read.`;
  function renderPromptV2(profile, seed, opts) {
    if (!profile) return null; // cold start: v1 is the fallback, and the draft is labeled generic-pattern
    const o = opts || {};
    const sd = seed || sampleStructuralSeed(profile, o);
    const seedText = [
      `Opening mode: ${sd.openingMode}.`,
      `Length band: ${sd.lengthBand.min}–${sd.lengthBand.max} words (about ${sd.targetSentences} sentences).`,
      `Paragraphs: ${sd.paragraphCount}.`,
      `Lead fact kind: ${sd.leadFactKind}.`,
    ].join("\n");
    return PATTERN_PROMPT_V2_TEMPLATE.replace("{{voice_numbers}}", voiceTargetsText(profile)).replace("{{structural_seed}}", seedText);
  }

  // ---------------- [6] fact-lock tracing (design §6) ----------------
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  const COMMON_START_WORDS = new Set(["can", "is", "are", "was", "were", "do", "does", "did", "have", "has", "had", "keeping", "looking", "writing", "reaching", "hoping", "working", "building", "making", "taking", "getting", "let", "please", "happy", "glad", "quick", "short", "will", "shall", "may", "must", "should", "would", "could", "might", "one", "two", "three", "it", "there", "here", "this", "that", "the", "a", "an", "my", "your", "his", "her", "their", "our", "we", "you", "he", "she", "they", "what", "when", "where", "who", "how", "why", "if", "as", "at", "in", "on", "by", "for", "with", "from", "after", "before", "since", "until", "while", "though", "although", "because", "unless", "given", "based", "using", "having", "being", "going", "coming", "trying", "starting", "joining", "leaving", "moving", "reading", "hearing", "seeing", "knowing", "thinking", "feeling", "wondering", "asking", "hoping", "wishing", "sending", "sharing", "checking", "following", "adding", "noting", "overall", "recently", "currently", "finally", "first", "second", "next", "last", "now", "then", "today", "yesterday", "tomorrow", "yes", "no", "sure", "well", "also", "just", "even", "still", "back", "out", "up", "down", "over", "about", "into", "through", "across", "between", "under", "again", "once", "twice", "every", "each", "any", "some", "many", "few", "all", "both", "either", "neither", "another", "other", "same", "such", "only", "own", "very", "too", "so", "not", "nor", "yet", "thus", "hence", "instead", "rather", "perhaps", "maybe", "almost", "nearly", "quite", "pretty", "really", "truly", "actually", "honestly", "totally", "whatever", "whenever", "wherever", "whoever", "however", "saw", "met", "read", "heard", "noticed", "loved", "liked", "enjoyed", "followed", "caught", "spotted", "joined", "started", "built", "ran", "led", "made", "took", "gave", "got", "came", "went", "sat", "stood", "grew", "moved", "turned", "kept", "left", "found", "told", "asked", "called", "tried", "used", "worked", "played", "watched", "listened", "spoke", "talked", "wrote", "sent", "shared", "helped", "learned", "taught", "studied", "finished", "graduated", "interned", "volunteered", "founded", "launched", "created", "designed", "developed", "managed", "led"]);
  const ENTITY_STOP = new Set(["the", "i", "i'm", "i've", "hi", "hello", "thanks", "thank", "would", "could", "might", "my", "we", "it", "this", "that", "and", "but", "so", "if", "in", "on", "at", "a", "an", "dear", "sincerely", "best", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "another", "totally", "whatever", "any", "most", "recently", "currently", "earlier", "later", "also", "still", "just", "now", "then", "here", "yes", "no", "sure", "well", "first", "second", "finally", "however", "instead", "often", "sometimes", "maybe", "perhaps", "actually", "honestly", "each", "every", "many", "some", "back", "even", "much", "more", "over", "after", "before", "when", "since", "during", "last", "next", "one", ...MONTHS]);
  function factCorpus(factPack, opts) {
    const o = opts || {};
    const texts = [];
    for (const f of factPack || []) texts.push(typeof f === "string" ? f : String((f && (f.text || f.fact)) || ""));
    for (const x of o.extraFacts || []) texts.push(String(x || ""));
    if (o.recipient) { texts.push(String(o.recipient.full_name || "")); texts.push(String(o.recipient.current_firm || o.recipient.firm || "")); texts.push(String(o.recipient.title || "")); }
    if (o.senderName) texts.push(String(o.senderName));
    return norm(texts.join(" \n "));
  }
  // Extract every checkable span: numbers (digits and spelled), dates,
  // and capitalized name-like entities. Each must trace into the corpus.
  function extractCheckables(text) {
    const out = [];
    const sentences = splitSentences(text);
    for (const s of sentences) {
      // dates: Month D, YYYY / Month YYYY / bare year
      for (const m of s.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b|\b(19|20)\d{2}\b/g)) {
        out.push({ type: "date", value: m[0], sentence: s });
      }
      // numbers: $ amounts, percents, grouped/plain digits (not years — covered as dates)
      for (const m of s.matchAll(/\$[\d,]+(?:\.\d+)?|\b\d[\d,]*\.\d+\b|\b\d+%/g)) out.push({ type: "number", value: m[0], sentence: s });
      for (const m of s.matchAll(/\b\d[\d,]*\b/g)) {
        if (/^(19|20)\d{2}$/.test(m[0])) continue; // year: already a date checkable
        out.push({ type: "number", value: m[0], sentence: s });
      }
      // spelled-out numbers — only when a unit follows (fifteen minutes,
      // nine years, two live deals); a bare "one" is a determiner, not a claim
      for (const m of s.toLowerCase().matchAll(new RegExp("\\b(" + Object.keys(NUMBER_WORDS).join("|") + ")\\s+(minutes?|hours?|days?|weeks?|months?|years?|users?|people|students?|deals?|dollars?|percent|companies|roles?|calls?|chats?|meetings?|live)\\b", "g"))) {
        out.push({ type: "number", value: m[1], numeric: NUMBER_WORDS[m[1]], sentence: s });
      }
      // entities: runs of capitalized words; a token carrying sentence
      // punctuation (, ; :) ENDS the run — "Wharton School, University of
      // Pennsylvania" is two entities, never one merged phantom.
      const toks = s.split(/\s+/);
      let run = [];
      const flush = () => {
        if (!run.length) return;
        // A lone capitalized word at the very start of a sentence that is
        // an ordinary English word (Can / Is / Keeping / Would) is a verb
        // or auxiliary, not a name — names at sentence start are either
        // multiword or uncommon. Dropping it is the honest direction:
        // the tracer exists to catch INVENTED names, and a sentence-start
        // auxiliary is not one.
        const sentenceInitial = toks[0] && run[0] === toks[0].replace(/^[^A-Za-z]+|[^A-Za-z&.']+$/g, "");
        if (!(run.length === 1 && sentenceInitial && COMMON_START_WORDS.has(run[0].toLowerCase()))) out.push({ type: "entity", value: run.join(" "), sentence: s });
        run = [];
      };
      toks.forEach((tok, i) => {
        const clean = tok.replace(/^[^A-Za-z]+|[^A-Za-z&.']+$/g, "");
        const isCap = /^[A-Z][a-z]+$/.test(clean) || /^[A-Z]{2,}$/.test(clean);
        const stop = ENTITY_STOP.has(clean.toLowerCase());
        if (isCap && !stop && clean.length >= 2) run.push(clean);
        else if (isCap && stop && run.length) run.push(clean); // keep "Bank of X" style runs together
        else flush();
        if (/[,;:]$/.test(tok)) flush();
        if (i === toks.length - 1) flush();
      });
    }
    return out;
  }
  function traceFacts(text, factPack, opts) {
    const corpus = factCorpus(factPack, opts || {});
    text = stripEnvelope(text);
    const corpusNums = new Set();
    for (const m of corpus.matchAll(/\b\d[\d,]*\.?\d*\b/g)) corpusNums.add(m[0].replace(/,/g, ""));
    const checkables = extractCheckables(text);
    const untraced = [];
    let traced = 0;
    for (const c of checkables) {
      let ok = false;
      if (c.type === "number") {
        if (c.numeric != null) ok = corpusNums.has(String(c.numeric)) || new RegExp("\\b" + c.value + "\\b").test(corpus);
        else { const n = c.value.replace(/[$,%]/g, ""); ok = corpusNums.has(n) || corpusNums.has(n.replace(/,/g, "")); }
      } else {
        ok = corpus.includes(norm(c.value));
        if (!ok && c.type === "entity") {
          // an entity also traces when every significant token appears in
          // the corpus (e.g. "Lincoln International in Chicago" reordered)
          const toks = norm(c.value).split(" ").filter((t) => t.length >= 3 && !["the", "of", "in", "at", "and"].includes(t));
          ok = toks.length > 0 && toks.every((t) => corpus.includes(t));
        }
      }
      if (ok) traced++;
      else untraced.push(c);
    }
    return { pass: untraced.length === 0, traced, total: checkables.length, untraced };
  }

  // ---------------- [4] slop gate (design §5) ----------------
  // Design §5.2, verbatim in effect: 124's existing BANNED_PHRASES
  // (already law on the composer path) + prompt v1's hard bans + the
  // template openers/closers. One hit fails the draft.
  const HARD_BANNED = [
    "i hope this email finds you well", "hope this email finds you well",
    "i came across your profile", "came across your profile",
    "pick your brain", "i'd love to connect", "i would love to connect", "love to connect",
    "admire your impressive career", "impressive career",
    "i am writing to express", "i'm writing to express", "i am excited to apply",
    "please do not hesitate", "dynamic world of", "in today's fast-paced world",
    "in conclusion", "it's worth noting", "it is worth noting",
    "it's important to note", "it is important to note", "i would be honored",
    "i look forward to hearing from you",
  ];
  const MARKER_WORDS = ["delve", "showcase", "underscore", "underscores", "intricate", "pivotal", "realm", "tapestry", "seamlessly", "furthermore", "moreover", "additionally", "landscape", "spearhead", "spearheading", "synergy", "synergies", "nuanced", "utilize", "passionate", "vibrant", "testament", "dynamic", "esteemed"];
  function bannedScan(text) {
    const low = " " + norm(text) + " ";
    const hard = [];
    for (const p of HARD_BANNED) { const np = norm(p); if (low.includes(" " + np + " ") || low.includes(" " + np + ".") || low.includes(" " + np + ",")) hard.push(p); }
    if (/not only\b[^.!?]{1,60}\bbut also\b/i.test(text)) hard.push("not only X but also Y");
    const markers = [];
    for (const w of MARKER_WORDS) if (new RegExp("\\b" + w + "\\b").test(low)) markers.push(w);
    if (/\bleverag(e|es|ed|ing)\b/i.test(text)) markers.push("leverage (verb)");
    if (/\bjourney\b/i.test(text)) markers.push("journey");
    return { hard, markers };
  }
  const PRAISE_WORDS = /\b(exciting|incredible|amazing|impressive|fascinating|remarkable|inspiring|thrilled|honored)\b/i;
  function anchorSpans(paragraph, factPack, opts) {
    // A paragraph is anchored when it contains a span that also traces:
    // a number, a date, an entity present in the fact corpus — or a
    // 6+-word run rendered from a fact (a fact stated in the sender's
    // own clause is the strongest trace there is).
    const corpus = factCorpus(factPack, opts || {});
    const checks = extractCheckables(paragraph);
    let anchors = 0;
    for (const c of checks) {
      if (c.type === "number") anchors++;
      else if (corpus.includes(norm(c.value))) anchors++;
    }
    if (!anchors && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(paragraph)) anchors = 1; // scheduling-specific logistics are anchors (not fact-lock claims)
    if (!anchors && corpus) {
      const grams = ngrams(norm(paragraph).split(" ").map((t) => t.replace(/[.!?]+$/, "")), 6);
      if (grams.some((g) => corpus.includes(g))) anchors = 1;
    }
    return anchors;
  }
  function slopGate(text, opts) {
    const o = opts || {};
    const profile = o.profile || null;
    const factPack = o.factPack || [];
    const metrics = {};
    // Substance floor: a degenerate near-empty text must not sail
    // through every content metric vacuously — it is not a draft.
    {
      const n = wordsOf(String(text || "")).length;
      metrics.substance = { value: { words: n }, pass: n >= 25, detail: n >= 25 ? "draft-length text" : `only ${n} words — below the minimum for a submittable draft` };
    }
    const failures = [];
    const warnings = [];
    const sentences = splitSentences(stripEnvelope(text));
    const lens = sentences.map((s) => wordsOf(s).length).filter((n) => n > 0);

    // (1) sentence-length variance — profile-relative (design §2.5/§5.1)
    {
      const cv = mean(lens) ? sd(lens) / mean(lens) : 0;
      let run = 1, maxRun = 1;
      for (let i = 1; i < lens.length; i++) { run = Math.abs(lens[i] - lens[i - 1]) <= 3 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
      // Design §5.1 defines the CV bar PROFILE-relative ("CV below the
      // profile's own CV by >40%"). With no profile there is no honest
      // CV bar — the gate reports the CV and grades only the uniform
      // run, which §5.1 defines absolutely. A distribution statistic
      // also needs a distribution: under 5 sentences the CV check
      // stands down even with a profile.
      const target = profile ? profile.sentenceLength.cv : null;
      const cvApplies = !!profile && lens.length >= 5;
      const cvPass = !cvApplies || cv >= target * 0.6;
      const runPass = maxRun < 5;
      metrics.sentence_variance = { value: { cv: +cv.toFixed(3), profileCv: target, maxUniformRun: maxRun, sentences: lens.length }, pass: cvPass && runPass, detail: !cvPass ? `draft rhythm (CV ${cv.toFixed(2)}) is flatter than the user's own (CV ${target.toFixed(2)} x 0.6)` : !runPass ? `${maxRun} sentences in a row within ±3 words of each other` : cvApplies ? "rhythm varies" : `CV ${cv.toFixed(2)} reported; no profile CV bar applies` };
      if (!metrics.sentence_variance.pass) failures.push("sentence_variance");
    }
    // (2) banned phrases — hard: fail on 1; markers: warn on 1, fail on >=2
    {
      const b = bannedScan(text);
      const pass = b.hard.length === 0 && b.markers.length < 2;
      metrics.banned_phrases = { value: b, pass, detail: b.hard.length ? `hard-banned: ${b.hard.join("; ")}` : b.markers.length ? `marker vocabulary: ${b.markers.join(", ")}` : "clean" };
      if (b.hard.length || b.markers.length >= 2) failures.push("banned_phrases");
      else if (b.markers.length === 1) warnings.push("banned_phrases:1 marker (" + b.markers[0] + ")");
    }
    // (3) tell-taxonomy spot checks (design §5.3)
    {
      const tells = [];
      if (/\bnot (only|just|merely)\b[^.!?]{1,60}\bbut\b/i.test(text) || /\bisn't\b[^.!?]{1,40}\bit's\b/i.test(text) || /\bnot a\b[^.!?]{1,40}\bbut a\b/i.test(text)) tells.push("not_x_but_y frame");
      // tricolons (HS-15 budget): a sentence carrying a three-part list —
      // "A, B, and C" (two commas, the last before "and") or "A, B, C" —
      // is one candidate; >=2 candidates in one draft fails.
      let tricolons = 0;
      for (const s of sentences) {
        const commas = (s.match(/,/g) || []).length;
        if (commas >= 2 && /,?\s+and\s+/i.test(s.split(",").slice(1).join(",")) && /,\s*and\s+/i.test(s)) tricolons++;
        else if (/,[^,.;!?]{2,40},[^,.;!?]{2,40},[^,.;!?]{2,40}/.test(s)) tricolons++;
      }
      if (tricolons >= 2) tells.push(`${tricolons} tricolons/aphoristic triples`);
      // repeated openings within the doc: the same first TWO words twice,
      // or one opener class (other than first_person — a first-person
      // genre opens with "I" the way speech does) 3+ times
      const twoWord = {};
      const counts = {};
      for (const s of sentences) {
        const w2 = norm(s).split(" ").slice(0, 2).join(" ");
        if (w2) twoWord[w2] = (twoWord[w2] || 0) + 1;
        const k = openerClass(s); counts[k] = (counts[k] || 0) + 1;
      }
      for (const [k, n] of Object.entries(twoWord)) if (n >= 2) tells.push(`the opening "${k}" starts ${n} sentences`);
      for (const [k, n] of Object.entries(counts)) if (n >= 3 && k !== "first_person" && sentences.length >= 5) tells.push(`opener class "${k}" opens ${n} sentences`);
      // summary close: the final sentence RESTATES (shares most of its
      // content words with an earlier sentence) or is a bare generic
      // closer — and carries no fact/date/number/ask. A courtesy clause
      // ("totally understand if you're swamped") is neither: it passes.
      const last = sentences[sentences.length - 1] || "";
      const hasAsk = /\?/.test(last) || /\b(would|could|can|will|please|open to|up for|works|work for you|let me know)\b/i.test(last);
      const hasFact = extractCheckables(last).length > 0;
      if (last && !hasAsk && !hasFact) {
        const lastToks = new Set(norm(last).split(" ").filter((w) => w.length >= 4));
        let restates = false;
        for (const s of sentences.slice(0, -1)) {
          const toks = new Set(norm(s).split(" ").filter((w) => w.length >= 4));
          const shared = [...lastToks].filter((w) => toks.has(w)).length;
          if (lastToks.size && shared / lastToks.size >= 0.5) restates = true;
        }
        if (restates || /^(thanks for your time|thank you for your time|i hope this|looking forward to hearing|please do not hesitate)/i.test(last)) tells.push("summary close: the final sentence restates instead of landing on a fact, date, number, or ask");
      }
      // generic praise: a praise word in a sentence with no traced anchor
      for (const s of sentences) if (PRAISE_WORDS.test(s) && anchorSpans(s, factPack, o) === 0) { tells.push(`generic praise with no fact attached: "${s.slice(0, 60)}"`); break; }
      // staged run-ups
      if (/\bhere's the thing\b|\blet's be honest\b|\bthe truth is\b/i.test(text)) tells.push("staged run-up");
      metrics.tells = { value: tells, pass: tells.length === 0, detail: tells.length ? tells.join("; ") : "no staging tells" };
      if (tells.length) failures.push("tells");
    }
    // (4) name-swap, mechanical half: fact-anchor density per paragraph
    {
      const paras = splitParagraphs(text);
      const thin = [];
      paras.forEach((p, i) => {
        if (i === 0 && /^(hi|hello|hey)\b/i.test(p) && wordsOf(p).length <= 4) return; // greeting line
        if (i === paras.length - 1 && /^(thanks|thank you|sincerely|best|warmly)\b/i.test(p)) return; // sign-off block
        if (wordsOf(p).length <= 8) return; // a framing line (a short opener question, a fragment) carries no claims to anchor; fact-lock still grades every word of it
        if (anchorSpans(p, factPack, o) === 0) thin.push(i + 1);
      });
      metrics.fact_anchor_density = { value: { paragraphs: paras.length, unanchored: thin }, pass: thin.length === 0, detail: thin.length ? `paragraph(s) ${thin.join(", ")} contain no fact that could only belong to this person` : "every paragraph is anchored" };
      if (thin.length) failures.push("fact_anchor_density");
    }
    // (5) fact-lock: untraced entities/numbers/dates are a HARD fail,
    // listed separately — a rewrite fixes style; an untraced fact is
    // deleted, never rephrased (design §6).
    {
      const t = traceFacts(text, factPack, o);
      metrics.fact_lock = { value: { traced: t.traced, total: t.total, untraced: t.untraced.map((u) => `${u.type}:${u.value}`) }, pass: t.pass, detail: t.pass ? `all ${t.total} checkable spans trace to the fact pack` : `untraced: ${t.untraced.map((u) => u.value).join("; ")}` };
      if (!t.pass) failures.push("fact_lock");
    }
    return { pass: failures.length === 0, failures, warnings, metrics, untraced: metrics.fact_lock.value.untraced };
  }
  function rewriteInstruction(scorecard) {
    if (!scorecard || scorecard.pass) return "";
    const parts = [];
    for (const name of scorecard.failures) {
      const m = scorecard.metrics[name];
      if (!m) continue;
      if (name === "fact_lock") parts.push(`FACT LOCK: delete these untraced claims entirely — do not rephrase them: ${m.value.untraced.join("; ")}.`);
      else parts.push(`Fix ${name}: ${m.detail}.`);
    }
    return "Rewrite the draft. " + parts.join(" ");
  }
  // The rewrite loop (design §1 [4]): max 2 rewrites; a still-failing
  // draft is returned WITH its failing metrics named — never unflagged.
  function runGateLoop(generate, opts) {
    const o = opts || {};
    const maxRewrites = o.maxRewrites != null ? o.maxRewrites : 2;
    let instruction = null;
    let attempts = 0;
    let text = null, card = null;
    while (attempts <= maxRewrites) {
      text = generate(instruction, attempts);
      attempts++;
      card = slopGate(text, o);
      if (card.pass) return { text, scorecard: card, attempts, flagged: false, pass: true };
      instruction = rewriteInstruction(card);
    }
    return { text, scorecard: card, attempts, flagged: true, pass: false, failingMetrics: card.failures.map((f) => `${f}: ${card.metrics[f] ? card.metrics[f].detail : ""}`) };
  }

  // ---------------- [5] batch variation enforcer (design §4) ----------------
  const WEEKDAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
  function proseSentencesOf(body) {
    const paras = splitParagraphs(body);
    const prose = paras.filter((p, i) => !(i === 0 && /^(hi|hello|hey)\b/i.test(p) && wordsOf(p).length <= 4) && !/^(thanks|thank you|sincerely|best)\b/i.test(p));
    return prose.flatMap((p) => splitSentences(p));
  }
  function ngrams(words, n) {
    const out = [];
    for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
    return out;
  }
  function subjectFrame(subject, draft) {
    let f = " " + norm(subject) + " ";
    for (const raw of [draft.recipientName, draft.firm, draft.title]) {
      if (raw) f = f.split(norm(raw)).join(" {} ");
    }
    return f.replace(/\s+/g, " ").trim();
  }
  function closingType(body) {
    const s = splitSentences(stripEnvelope(body));
    const last = s[s.length - 1] || "";
    if (/\?/.test(last)) return "question";
    if (extractCheckables(last).length) return "fact";
    if (/\b(would|could|can|please|open to|let me know)\b/i.test(last)) return "ask";
    return "statement";
  }
  function batchGate(drafts, opts) {
    const o = opts || {};
    const list = (drafts || []).filter((d) => d && (d.body || d.text));
    const n = list.length;
    const metrics = {};
    const failures = [];
    const bodies = list.map((d) => String(d.body || d.text || ""));
    const factCorpusText = norm(((o.factTexts || []).join(" ")) + " " + list.map((d) => (d.factTexts || []).join(" ")).join(" "));
    const pctOf = (share, limit) => share > limit;

    // HS-1: verbatim sentence reuse (non-signature) in >25% of drafts
    {
      const freq = new Map();
      for (const b of bodies) for (const s of new Set(proseSentencesOf(b).map(norm))) freq.set(s, (freq.get(s) || 0) + 1);
      const bad = [...freq.entries()].filter(([, c]) => pctOf(c / Math.max(1, n), 0.25)).map(([s, c]) => ({ sentence: s.slice(0, 90), drafts: c }));
      metrics.verbatim_sentence_reuse = { value: bad, pass: bad.length === 0, detail: bad.length ? `${bad.length} sentence(s) repeat across >25% of the batch` : "no sentence repeats across >25%" };
      if (bad.length) failures.push("verbatim_sentence_reuse");
    }
    // HS-2: bridge-clause monoculture — a 6+ word NON-FACT phrase in >25%
    {
      const freq = new Map();
      for (const b of bodies) {
        const grams = new Set();
        for (const s of proseSentencesOf(b)) for (const g of ngrams(norm(s).split(" ").map((t) => t.replace(/[.!?]+$/, "")), 6)) grams.add(g);
        for (const g of grams) freq.set(g, (freq.get(g) || 0) + 1);
      }
      const bad = [...freq.entries()].filter(([g, c]) => pctOf(c / Math.max(1, n), 0.25) && !factCorpusText.includes(g)).map(([g, c]) => ({ phrase: g, drafts: c }));
      metrics.bridge_clause_monoculture = { value: bad.slice(0, 5), pass: bad.length === 0, detail: bad.length ? `non-fact phrase(s) in >25%: ${bad.slice(0, 3).map((x) => '"' + x.phrase + '"').join(", ")}` : "no bridge monoculture" };
      if (bad.length) failures.push("bridge_clause_monoculture");
    }
    // HS-3: subject frames
    {
      const frames = new Map(); const seenFirmSubject = new Set(); let dupFirm = false;
      for (const d of list) {
        const frame = subjectFrame(String(d.subject || ""), d);
        frames.set(frame, (frames.get(frame) || 0) + 1);
        const key = norm(d.firm || "") + "|" + norm(d.subject || "");
        if (d.firm && d.subject) { if (seenFirmSubject.has(key)) dupFirm = true; seenFirmSubject.add(key); }
      }
      const topFrame = [...frames.entries()].sort((a, b) => b[1] - a[1])[0];
      const frameShare = topFrame ? topFrame[1] / Math.max(1, n) : 0;
      const pass = !pctOf(frameShare, 0.5) && !dupFirm;
      metrics.subject_frames = { value: { topFrame: topFrame ? topFrame[0] : "", share: +frameShare.toFixed(2), duplicateSubjectSameFirm: dupFirm }, pass, detail: dupFirm ? "an identical subject goes to two people at the same firm" : pctOf(frameShare, 0.5) ? `one subject frame covers ${Math.round(frameShare * 100)}% of the batch` : "subject frames vary" };
      if (!pass) failures.push("subject_frames");
    }
    // HS-4: length spread (only meaningful at >=8 drafts)
    {
      const counts = bodies.map((b) => wordsOf(b).length);
      const ratio = counts.length ? Math.max(...counts) / Math.max(1, Math.min(...counts)) : 0;
      const applies = n >= 8;
      const pass = !applies || ratio >= 1.5;
      metrics.length_spread = { value: { min: Math.min(...counts, 0), max: Math.max(...counts, 0), ratio: +ratio.toFixed(2), applies }, pass, detail: applies ? `max/min word ratio ${ratio.toFixed(2)}` : "batch under 8 drafts; spread not gated" };
      if (!pass) failures.push("length_spread");
    }
    // HS-5: lead-fact-kind spread
    {
      const kinds = list.map((d) => d.leadFactKind).filter(Boolean);
      let pass = true, detail = "no lead fact kinds recorded";
      if (kinds.length >= 4) {
        const freq = {};
        for (const k of kinds) freq[k] = (freq[k] || 0) + 1;
        const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
        pass = !pctOf(top[1] / kinds.length, 0.5);
        detail = `top lead fact kind "${top[0]}" at ${Math.round(top[1] / kinds.length * 100)}%`;
      }
      metrics.lead_fact_kind_spread = { value: detail, pass, detail };
      if (!pass) failures.push("lead_fact_kind_spread");
    }
    // HS-6: logistics repetition — identical weekday time-window string in >50%
    {
      const freq = new Map();
      const re = new RegExp("\\b(?:" + WEEKDAYS + ") (?:morning|afternoon|evening)(?: or (?:" + WEEKDAYS + ") (?:morning|afternoon|evening))?", "i");
      for (const b of bodies) { const m = b.match(re); if (m) { const k = norm(m[0]); freq.set(k, (freq.get(k) || 0) + 1); } }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = top ? top[1] / Math.max(1, n) : 0;
      const pass = !pctOf(share, 0.5);
      metrics.logistics_repetition = { value: { top: top ? top[0] : null, share: +share.toFixed(2) }, pass, detail: top ? `"${top[0]}" appears in ${Math.round(share * 100)}% of drafts` : "no repeated logistics string" };
      if (!pass) failures.push("logistics_repetition");
    }
    // Opening diversity (new): one opening mode >50%
    {
      const freq = {};
      for (const b of bodies) { const s = proseSentencesOf(b)[0]; if (s) { const k = openerClass(s); freq[k] = (freq[k] || 0) + 1; } }
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      const share = top ? top[1] / Math.max(1, n) : 0;
      const pass = !top || !pctOf(share, 0.5);
      metrics.opening_diversity = { value: { top: top ? top[0] : null, share: +share.toFixed(2) }, pass, detail: top ? `top opening mode "${top[0]}" at ${Math.round(share * 100)}%` : "no openings" };
      if (!pass) failures.push("opening_diversity");
    }
    // Structure fingerprint (new): (paragraph count, opener class, closing type) in >25%
    {
      const freq = new Map();
      for (const b of bodies) {
        const key = [splitParagraphs(b).length, openerClass(proseSentencesOf(b)[0] || ""), closingType(b)].join("|");
        freq.set(key, (freq.get(key) || 0) + 1);
      }
      const bad = [...freq.entries()].filter(([, c]) => pctOf(c / Math.max(1, n), 0.25)).map(([k, c]) => ({ fingerprint: k, drafts: c }));
      metrics.structure_fingerprint = { value: bad, pass: bad.length === 0, detail: bad.length ? `structure fingerprint(s) shared by >25%: ${bad.map((x) => x.fingerprint).join(", ")}` : "structures vary" };
      if (bad.length) failures.push("structure_fingerprint");
    }
    return { pass: failures.length === 0, failures, metrics, draftCount: n };
  }

  // ---------------- [6] edit capture (design §2.4) ----------------
  // The user's edits are the highest-quality voice data that exists.
  // Capture folds the EDITED text's statistics into the profile's
  // sufficient statistics and recomputes — statistics only, no prose
  // retained beyond the snippets the profile already holds.
  function captureEdits(profile, originalText, editedText) {
    if (!profile) return null;
    const editStats = computeStats([String(editedText || "")]);
    if (!editStats.sentenceCount) return profile;
    const acc = profile.acc || { sentenceLengths: [], openerCounts: {}, sentenceCount: 0 };
    const lens = [...(acc.sentenceLengths || []), ...editStats.acc.sentenceLengths].slice(-2000);
    const openerCounts = { ...(acc.openerCounts || {}) };
    for (const [k, v] of Object.entries(editStats.acc.openerCounts)) openerCounts[k] = (openerCounts[k] || 0) + v;
    const totalSent = (acc.sentenceCount || 0) + editStats.sentenceCount;
    const openerRates = {};
    for (const [k, v] of Object.entries(openerCounts)) openerRates[k] = +(v / Math.max(1, totalSent)).toFixed(4);
    const next = JSON.parse(JSON.stringify(profile));
    next.sentenceLength = {
      mean: +mean(lens).toFixed(2), sd: +sd(lens).toFixed(2),
      cv: +(mean(lens) ? sd(lens) / mean(lens) : 0).toFixed(3),
      p10: pct(lens, 0.1), p90: pct(lens, 0.9),
      shortShare: +(lens.filter((x) => x <= 6).length / Math.max(1, lens.length)).toFixed(3),
      longShare: +(lens.filter((x) => x >= 30).length / Math.max(1, lens.length)).toFixed(3),
    };
    next.openers = openerRates;
    next.acc = { sentenceLengths: lens, openerCounts, sentenceCount: totalSent };
    next.basis = { ...(profile.basis || {}), edits: ((profile.basis && profile.basis.edits) || 0) + 1 };
    next.lastEditLengthRatio = +(wordsOf(String(editedText || "")).length / Math.max(1, wordsOf(String(originalText || "")).length)).toFixed(3);
    next.version = (profile.version || 1) + 1;
    return next;
  }

  // ---------------- reference generator (harness generation path) -------
  // A deterministic composer driven by the structural seed: the hosted
  // path injects its own generator running renderPromptV2's text; this
  // is the offline/harness generator so the pipeline (gates, batch
  // enforcer, rewrite loop) is provable end to end without a model.
  const LOGISTICS_FORMS = [
    (a) => `Would ${a.minutes} minutes on ${a.dayA} afternoon or ${a.dayB} morning work`,
    (a) => `Could we do ${a.minutes} minutes sometime this week — ${a.dayA} or ${a.dayB} both work on my end`,
    (a) => `Is there a ${a.minutes}-minute window on ${a.dayA} that suits you`,
    (a) => `Happy to work around your schedule — even ${a.minutes} minutes would help`,
    (a) => `Would a short call on ${a.dayB} morning work, or is ${a.dayA} better`,
    (a) => `Could we talk for ${a.minutes} minutes this week? ${a.dayA} or ${a.dayB} both work on my end`,
  ];
  function composePatternDraft(input) {
    const i = input || {};
    const seed = i.seed || sampleStructuralSeed(i.profile || null, { seed: i.seedValue != null ? i.seedValue : 99, leadFactKind: i.leadFactKind, lengthTier: i.lengthTier, openingMode: i.openingMode });
    const r = rng(i.seedValue != null ? i.seedValue + 7 : 4242);
    const facts = (i.factPack || []).filter((f) => f && f.text);
    const byKind = (k) => facts.filter((f) => f.kind === k);
    const pickFrom = (arr, fb) => (arr.length ? arr[Math.floor(r() * arr.length)] : fb);
    const recipientFact = pickFrom(byKind("recipient"), facts[0] || { text: "" });
    // A sender SENTENCE must be a substantive clause (>=5 words) — a
    // fragment fact ("sophomore at TEST University") belongs in the
    // intro line, never standing alone as a pasted block.
    const senderFact = pickFrom(byKind("sender").filter((f) => wordsOf(f.text).length >= 5), null);
    const days = ["Tuesday", "Thursday", "Monday", "Wednesday", "Friday"];
    const dayA = days[Math.floor(r() * days.length)];
    let dayB = days[Math.floor(r() * days.length)]; if (dayB === dayA) dayB = days[(days.indexOf(dayA) + 2) % days.length];
    // A wave assembler may pin the logistics form + tail per draft so
    // a batch de-clusters BY CONSTRUCTION instead of hoping the rng
    // stream decorrelates; single drafts draw from the rng stream.
    const formIdx = i.logisticsIndex != null ? Math.abs(i.logisticsIndex) % LOGISTICS_FORMS.length : Math.floor(r() * LOGISTICS_FORMS.length);
    const askBase = LOGISTICS_FORMS[formIdx]({ minutes: 15, dayA, dayB });
    const tails = [` to talk about ${i.askTopic || "your work"}?`, ` — about ${i.askTopic || "your work"}?`, "?", `, if you're open to it — about ${i.askTopic || "your work"}?`];
    const tailIdx = i.tailIndex != null ? Math.abs(i.tailIndex) % tails.length : Math.floor(r() * tails.length);
    // A two-sentence ask base (question + statement) closes as a
    // statement — appending a question tail would break its grammar.
    const ask = askBase.includes("?") ? askBase + "." : askBase + tails[tailIdx];
    const first = String(i.recipientName || "there").split(" ")[0];
    const asSentence = (t) => { const s = String(t || "").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) + (/\.$/.test(s) ? "" : ".") : ""; };
    const factSentence = recipientFact.text ? `I saw that ${recipientFact.text.replace(/\.$/, "")}.` : "";
    const senderSentence = senderFact && senderFact.text !== recipientFact.text ? asSentence(senderFact.text) : "";
    // The intro and the sender fact are RE-CAST per draft (HS-1's own
    // prescribed fix: the sender-fact block is re-cast, never pasted) —
    // several surface forms, chosen by the draft's own rng stream.
    const introForms = [
      `${i.senderName || "A student"} here${i.senderLine ? ` — ${i.senderLine}` : ""}.`,
      `I'm ${i.senderName || "a student"}${i.senderLine ? `, ${i.senderLine}` : ""}.`,
      i.senderLine ? `${i.senderLine.charAt(0).toUpperCase() + i.senderLine.slice(1)} — ${i.senderName || "a student"}.` : `I'm ${i.senderName || "a student"}.`,
    ];
    const selfIntro = introForms[Math.floor(r() * introForms.length)];
    // Sentence assembly with a budget: opener + fact first, the ask last,
    // the sender sentence and extra facts only while the seed's sentence
    // budget allows — short seeds produce genuinely short drafts.
    const body = [];
    switch (seed.openingMode) {
      case "name_intro": body.push(selfIntro); if (factSentence) body.push(factSentence); break;
      case "self_intro": body.push(selfIntro); if (factSentence) body.push(factSentence); break;
      case "question": body.push(`Can I ask you about ${i.askTopic || "your work"}?`); if (factSentence) body.push(factSentence); break;
      case "short_honest": body.push("Keeping this short."); if (factSentence) body.push(factSentence); break;
      default: if (factSentence) body.push(factSentence); break; // fact_lead
    }
    const budget = Math.max(3, seed.targetSentences || 4);
    if (senderSentence && body.length + 2 <= budget) {
      // Re-cast: sometimes the sender fact ships as two shorter
      // sentences (split at its own comma) instead of one pasted block.
      const raw = String(senderFact.text || "");
      if (raw.includes(", ") && r() < 0.5 && body.length + 3 <= budget) {
        const cut = raw.indexOf(", ");
        body.push(asSentence(raw.slice(0, cut)));
        body.push(asSentence(raw.slice(cut + 2)));
      } else body.push(senderSentence);
    }
    // Padding uses only PER-RECIPIENT facts — never the ask fact (the
    // ask is the closing sentence itself) and never sender facts: a
    // sender fact rendered verbatim into many drafts is exactly the
    // HS-1 clone pattern, so sender material ships once, re-cast, in
    // its own slot above. Recipient facts differ per draft by
    // construction, so padding with them cannot clone.
    let guard = 0;
    while (body.length + 1 < budget && guard < facts.length) {
      const extra = facts[guard++];
      if (extra && extra.text && extra.kind === "recipient" && extra !== recipientFact) body.push(asSentence(extra.text));
      else if (guard >= facts.length) break;
    }
    body.push(ask);
    // Rhythm pass (design §5.1's run rule, fixed at generation): work
    // on the flattened SENTENCE list (one body element can hold two
    // sentences). If a run of 5+ sentences sits within ±3 words of its
    // neighbours the draft reads as a metronome — break the pattern
    // with the draft's OWN words only: split the longest comma-bearing
    // sentence, or merge the first two into one longer one. Nothing is
    // added or invented.
    {
      const sents = body.flatMap((el) => splitSentences(el));
      const lens = sents.map((s) => wordsOf(s).length);
      let run = 1, maxRun = 1;
      for (let q = 1; q < lens.length; q++) { run = Math.abs(lens[q] - lens[q - 1]) <= 3 ? run + 1 : 1; if (run > maxRun) maxRun = run; }
      if (maxRun >= 5) {
        const longestIdx = lens.indexOf(Math.max(...lens));
        if (sents[longestIdx].includes(", ") && longestIdx !== sents.length - 1) {
          const cut = sents[longestIdx].indexOf(", ");
          const head = sents[longestIdx].slice(0, cut) + ".";
          const rest = sents[longestIdx].slice(cut + 2);
          sents.splice(longestIdx, 1, head, rest.charAt(0).toUpperCase() + rest.slice(1));
        } else if (sents.length >= 2) {
          const merged = sents[0].replace(/[.]$/, "") + " — " + sents[1].charAt(0).toLowerCase() + sents[1].slice(1);
          sents.splice(0, 2, merged);
        }
        body.length = 0;
        body.push(...sents);
      }
    }
    // Paragraph shape from the seed: the body splits into
    // (paragraphCount - 2) paragraphs, sequential chunks — never the
    // same shape for every draft in a wave.
    const paras = [`Hi ${first},`];
    const bodyParas = Math.max(1, Math.min(body.length, seed.paragraphCount - 2 + 1));
    if (bodyParas > 1 && body.length >= 3) {
      // A fragment opener ("Keeping this short.") never stands as its
      // own paragraph — it rides with the sentence it introduces.
      const units = [];
      for (let u = 0; u < body.length; u++) {
        if (u === 0 && wordsOf(body[0]).length <= 4 && body.length > 1) { units.push(body[0] + " " + body[1]); u++; }
        else units.push(body[u]);
      }
      const cut = Math.max(1, Math.floor(units.length / bodyParas));
      for (let s0 = 0; s0 < units.length; s0 += cut) paras.push(units.slice(s0, s0 + cut).join(" "));
    } else {
      paras.push(body.join(" "));
    }
    paras.push(`Thanks,\n${i.senderName || ""}`);
    return { subject: i.subject || "", body: paras.join("\n\n"), seed, leadFactKind: seed.leadFactKind };
  }

  // Wave assembly with recycling (design §1 [5]): compose every draft,
  // run the batch enforcer, and send the drafts that make the batch fail
  // back through generation with a different structural seed and a
  // different lead fact kind. Returns the final wave + the batch verdict
  // + how many drafts were recycled. If the batch still fails after
  // maxRounds, the verdict says so — a failing wave is never dressed as
  // ready.
  function assembleWave(items, compose, opts) {
    const o = opts || {};
    const maxRounds = o.maxRounds != null ? o.maxRounds : 4;
    const kinds = o.leadFactKinds || ["registry", "work_product", "shared_context", "publication", "path", "deal"];
    const tiers = ["short", "mid", "long"];
    const seedFor = (idx, round) => ({
      seedValue: (o.seedBase || 1000) + idx * 137 + round * 7919,
      leadFactKind: kinds[(idx + round) % kinds.length],
      lengthTier: tiers[(idx + round) % tiers.length],
      openingMode: OPENING_CONSTRUCTIONS[(idx + round) % OPENING_CONSTRUCTIONS.length],
      logisticsIndex: idx + round * 3,
      tailIndex: idx * 2 + round,
    });
    let drafts = (items || []).map((it, idx) => compose(it, seedFor(idx, 0)));
    let verdict = batchGate(drafts, o);
    let recycled = 0;
    for (let round = 1; round <= maxRounds && !verdict.pass; round++) {
      // Offenders are named BY the verdict's own metrics: drafts holding
      // a flagged sentence/phrase, drafts in the majority opening class
      // or fingerprint, drafts holding the repeated logistics string,
      // and (for length) the median drafts. Half the offenders recycle
      // per round, always with a new seed + construction + tier.
      const flagged = new Set();
      const m = verdict.metrics;
      const bodies = drafts.map((d) => String(d.body || d.text || ""));
      if (m.verbatim_sentence_reuse && !m.verbatim_sentence_reuse.pass) {
        const bad = new Set(m.verbatim_sentence_reuse.value.map((x) => x.sentence));
        bodies.forEach((b, idx) => { if (proseSentencesOf(b).map(norm).some((s) => bad.has(s.slice(0, 90)) || [...bad].some((x) => s.startsWith(x.slice(0, 40))))) flagged.add(idx); });
      }
      if (m.bridge_clause_monoculture && !m.bridge_clause_monoculture.pass) {
        const bad = m.bridge_clause_monoculture.value.map((x) => x.phrase);
        bodies.forEach((b, idx) => { if (bad.some((p) => norm(b).includes(p.split(" ").slice(0, 4).join(" ")))) flagged.add(idx); });
      }
      if (m.logistics_repetition && !m.logistics_repetition.pass && m.logistics_repetition.value.top) {
        bodies.forEach((b, idx) => { if (norm(b).includes(m.logistics_repetition.value.top)) flagged.add(idx); });
      }
      if (m.opening_diversity && !m.opening_diversity.pass && m.opening_diversity.value.top) {
        bodies.forEach((b, idx) => { const s = proseSentencesOf(b)[0]; if (s && openerClass(s) === m.opening_diversity.value.top) flagged.add(idx); });
      }
      if (m.structure_fingerprint && !m.structure_fingerprint.pass) {
        const bad = new Set(m.structure_fingerprint.value.map((x) => x.fingerprint));
        bodies.forEach((b, idx) => { const key = [splitParagraphs(b).length, openerClass(proseSentencesOf(b)[0] || ""), closingType(b)].join("|"); if (bad.has(key)) flagged.add(idx); });
      }
      if (m.length_spread && !m.length_spread.pass) {
        const sorted = bodies.map((b, idx) => ({ idx, n: wordsOf(b).length })).sort((a, b2) => a.n - b2.n);
        for (const x of sorted.slice(Math.floor(sorted.length / 4), Math.ceil(sorted.length * 3 / 4))) flagged.add(x.idx);
      }
      if (!flagged.size) drafts.forEach((d, idx) => { if (idx % 2 === 0) flagged.add(idx); });
      const toRecycle = [...flagged].filter((_, i) => i % 2 === 0 || flagged.size <= 2);
      drafts = drafts.map((d, idx) => {
        if (!toRecycle.includes(idx)) return d;
        recycled++;
        return compose(items[idx], seedFor(idx, round));
      });
      verdict = batchGate(drafts, o);
    }
    return { drafts, verdict, recycled, pass: verdict.pass };
  }

  // ---------------- word-budget drafting (beta 2026-11-04: A7, A12, C04) ----------------
  // "Draft a 100-word why this role answer", "Shorten that answer to 50 words", "Draft a networking email for review
  // only", "Shorten the draft to 80 words" all fell to the catchall: nothing composed a written answer from the record,
  // and nothing held a draft's structure so a follow-up could re-fit it to a word count.
  //
  // A budgeted draft is a list of UNITS; each unit is a list of VARIANTS (alternative wordings of the same content,
  // "" where the unit may be left out). fitUnits picks one variant per unit so the total word count is EXACTLY the
  // target when any combination reaches it (and otherwise the largest total under it, reported as such — never padded
  // with a claim the person did not make). Every person-fact in a variant comes from a confirmed fact; the connective
  // wording is the only text added. The units ride with the held draft, so "shorten to N" re-fits the same draft.
  // Counted words: tokens holding a letter or digit (a dash is not a word); an email's "Subject:" line is not counted.
  function countWords(text) {
    return String(text || "").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  }
  function draftWordCount(text) {
    const lines = String(text || "").split("\n");
    const body = /^subject:/i.test((lines[0] || "").trim()) ? lines.slice(1).join("\n") : lines.join("\n");
    return countWords(body);
  }
  // The word target a request states: "100-word", "100 word", "to 50 words", "in 80 words" (exact); "under 80 words",
  // "at most 80 words", "no more than 80 words", "max 80 words" (a ceiling). null when none is stated.
  function wordTargetOf(text) {
    const t = String(text || "").toLowerCase().replace(/[‐-―]/g, "-");
    let m = t.match(/\b(?:under|fewer than|less than)\s+(\d{1,4})\s*-?\s*words?\b/);
    if (m) return { words: Math.max(1, Number(m[1]) - 1), mode: "max", stated: Number(m[1]) };
    m = t.match(/\b(?:at most|no more than|max(?:imum)?(?: of)?|up to|within)\s+(\d{1,4})\s*-?\s*words?\b/);
    if (m) return { words: Number(m[1]), mode: "max", stated: Number(m[1]) };
    m = t.match(/\b(\d{1,4})\s*-?\s*words?\b/);
    if (m && Number(m[1]) > 0) return { words: Number(m[1]), mode: "exact", stated: Number(m[1]) };
    return null;
  }
  // units: [{ id, variants: [string], weights?: [number] }]. Returns { picks, text parts, words, exact }.
  function fitUnits(units, target) {
    const U = (units || []).map((u) => ({ id: u.id, variants: (u.variants || []).map(String), weights: u.weights || null }));
    const N = Math.max(0, Math.floor(Number(target) || 0));
    // dp[w] = { score, picks } for the best way to reach exactly w words with the units seen so far.
    let dp = new Map([[0, { score: 0, picks: [] }]]);
    for (const u of U) {
      const next = new Map();
      for (const [w, st] of dp) {
        u.variants.forEach((v, vi) => {
          const nw = w + countWords(v);
          if (nw > N) return;
          // Weight: an earlier variant is the fuller wording (preferred); a non-empty variant beats leaving it out.
          const weight = u.weights ? Number(u.weights[vi]) || 0 : (v ? 10 + (u.variants.length - vi) : 0);
          const sc = st.score + weight;
          const cur = next.get(nw);
          if (!cur || sc > cur.score) next.set(nw, { score: sc, picks: st.picks.concat(vi) });
        });
      }
      dp = next;
      if (!dp.size) break;
    }
    if (!dp.size) return { picks: null, words: 0, exact: false, parts: [] };
    const best = dp.has(N) ? N : Math.max(...dp.keys());
    const picks = dp.get(best).picks;
    const parts = picks.map((vi, i) => U[i].variants[vi]);
    return { picks, words: best, exact: best === N, parts };
  }
  // The natural (unbudgeted) length: each unit's first non-empty variant.
  function defaultFit(units) {
    const parts = (units || []).map((u) => (u.variants || []).find((v) => v) || "");
    return { picks: null, parts, words: parts.reduce((n, p) => n + countWords(p), 0), exact: false };
  }
  const capFirst = (x) => { const t = String(x || "").trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ""; };
  const endStop = (x) => { const t = String(x || "").trim().replace(/[\s;,:]+$/, ""); return t ? (/[.!?]$/.test(t) ? t : t + ".") : ""; };
  const article = (w) => (/^[aeiou]/i.test(String(w || "")) ? "an" : "a");
  // A confirmed fact as first-person sentences, shortest to fullest — the fact's own words only.
  const PAST_VERB = /^(led|built|ran|made|wrote|taught|sold|kept|handled|managed|answered|resolved|trained|helped|served|supported|created|designed|organized|coordinated|processed|performed|launched|improved|reduced|increased|cut|grew|analyzed|developed|tutored|volunteered|worked|assisted|scheduled|maintained|prepared|reviewed|tracked|delivered|opened|closed|cleaned|cooked|drove|counted|stocked|greeted|planned|ran)\b/i;
  function factVariants(f) {
    const text = String((f && (f.text || f.detail || f.value)) || "").trim().replace(/\.$/, "");
    const title = String((f && f.title) || "").trim();
    const org = String((f && (f.org || f.company)) || "").trim();
    if (!text && !title) return [];
    const out = [];
    if (text && PAST_VERB.test(text)) {
      const vp = text.charAt(0).toLowerCase() + text.slice(1);
      if (title && org) out.push(`As ${article(title)} ${title} at ${org}, I ${vp}.`);
      if (org) out.push(`At ${org}, I ${vp}.`);
      if (title) out.push(`As ${article(title)} ${title}, I ${vp}.`);
      out.push(`I ${vp}.`);
    } else if (f && f.kind === "education") {
      const what = title || text;
      const verb = /^(a|an|the)\s/i.test(what) ? "I studied for" : "I studied";
      if (org) out.push(`${verb} ${what} at ${org}.`);
      out.push(`${verb} ${what}.`);
    } else {
      out.push(endStop(capFirst(text || title)));
    }
    return [...new Set(out)];
  }
  // A "why this role" answer. input: { role, company, facts (confirmed only), words (target), mode }
  function whyRoleUnits(input) {
    const i = input || {};
    const role = String(i.role || "").trim();
    const at = i.company ? ` at ${i.company}` : "";
    const facts = (i.facts || []).slice(0, 5);
    const units = [];
    units.push({ id: "open", variants: [
      `I want the ${role} role${at} because it builds directly on work I have already done.`,
      `I want the ${role} role${at} because it builds on work I have done.`,
      `I want the ${role} role${at} because it fits work I have done.`,
      `I want this ${role} role${at}.`,
      `I want this role.`,
    ], weights: [60, 59, 58, 57, 1] });
    units.push({ id: "bridge", variants: ["Here is why, from what I have actually done so far.", "Here is why, from my own record.", "Here is why.", ""] });
    facts.forEach((f, k) => { const v = factVariants(f); if (v.length) units.push({ id: `fact${k}`, variants: v.concat(""), weights: v.map((_, vi) => 40 + (v.length - vi)).concat(0) }); });
    units.push({ id: "close", variants: [
      `That is the work I want to keep doing, and the ${role} role${at} is where I want to do it next.`,
      `That is the work I want to keep doing, and this role is where I want to do it next.`,
      "That is the work I want to keep doing.",
      "I want to keep doing that work.",
    ] });
    units.push({ id: "commit", variants: ["I would bring the same effort to it from my first week.", "I would bring the same effort to it.", ""] });
    return units;
  }
  // A networking email with no recipient named: an introduction and a 15-minute ask, from the person's record.
  // input: { senderName, intro (a confirmed school/year/major line), field (their stated target), facts }
  function networkingUnits(input) {
    const i = input || {};
    const name = String(i.senderName || "").trim();
    const intro = String(i.intro || "").trim();
    const field = String(i.field || "").trim();
    const units = [{ id: "greet", variants: ["Hi,"] }];
    const introV = [];
    if (name && intro) introV.push(`I'm ${name}, ${intro}.`);
    if (name) introV.push(`I'm ${name}.`);
    if (!name && intro) introV.push(`I'm ${intro}.`);
    if (introV.length) units.push({ id: "intro", variants: introV });
    (i.facts || []).slice(0, 2).forEach((f, k) => { const v = factVariants(f); if (v.length) units.push({ id: `fact${k}`, variants: v.concat(""), weights: v.map((_, vi) => 40 + (v.length - vi)).concat(0) }); });
    units.push({ id: "purpose", variants: field
      ? [`I'm exploring ${field} work and trying to learn how people in it actually got started.`, `I'm exploring ${field} work and learning how people got started.`, `I'm exploring ${field} work.`]
      : ["I'm working out my next step and trying to learn how people in your line of work got started.", "I'm learning how people in your line of work got started."] });
    units.push({ id: "ask", variants: [
      "Would you be open to a 15-minute call in the next couple of weeks to tell me how you got into your role?",
      "Would you have 15 minutes for a short call about how you got started?",
      "Could we talk for 15 minutes?",
    ] });
    units.push({ id: "thanks", variants: ["Thank you for reading, and no worries if the timing doesn't work.", "Thank you for reading.", ""] });
    units.push({ id: "sign", variants: [name ? `Best,\n${name}` : "Best,"] });
    return units;
  }
  // Paragraphing for a fitted email: greeting, body, sign-off on their own lines.
  function renderParts(kind, parts, subject) {
    const p = parts.filter((x) => x && String(x).trim());
    if (kind === "networking_email") {
      const greet = p[0] || "Hi,";
      const sign = p[p.length - 1];
      const body = p.slice(1, -1).join(" ");
      return [subject ? `Subject: ${subject}` : null, subject ? "" : null, greet, "", body, "", sign].filter((x) => x !== null).join("\n");
    }
    // 128 counterDraftUnits: one line per body unit (128 renderCounterUnits lays the first draft out the same way).
    if (kind === "counter_email") {
      return [subject ? `Subject: ${subject}` : null, subject ? "" : null, p[0], "", ...p.slice(1, -1), "", p[p.length - 1]].filter((x) => x !== null).join("\n");
    }
    return p.join(" ");
  }
  // Compose a budgeted draft. kind: "why_role_answer" | "networking_email".
  function composeBudgetedDraft(kind, input, target) {
    const units = kind === "networking_email" ? networkingUnits(input) : whyRoleUnits(input);
    const tgt = target && Number(target.words) > 0 ? target : null;
    let fit = tgt ? fitUnits(units, tgt.words) : defaultFit(units);
    // A target below the shortest form: the shortest form (never an empty draft), reported by its real count.
    if (tgt && !fit.picks) fit = { parts: units.map((u) => (u.variants || []).reduce((x, v) => (countWords(v) < countWords(x) ? v : x), (u.variants || [""])[0])) };
    const subject = kind === "networking_email" ? (input && input.subject) || null : null;
    const text = renderParts(kind, fit.parts, subject);
    return { kind, text, units, subject, words: draftWordCount(text), target: tgt, exact: tgt ? draftWordCount(text) === tgt.words : null };
  }
  // Re-fit a held draft to a new word target. With its units (a budgeted draft) the result is exact whenever any
  // combination reaches the target. A draft without units (written by another route) is cut by whole sentences only:
  // the opening and the closing ask stay, middle sentences go from the end, and the reply reports the real count —
  // no sentence is broken and nothing is added.
  function refitDraft(draft, target) {
    const d = draft || {};
    const tgt = target && Number(target.words) > 0 ? target : null;
    if (!tgt) return null;
    if (Array.isArray(d.units) && d.units.length) {
      let fit = fitUnits(d.units, tgt.words);
      // N below the draft's shortest form (greeting, ask and sign-off kept): the shortest form, reported as such.
      const floor = !fit.picks;
      if (floor) fit = { parts: d.units.map((u) => (u.variants || []).reduce((a, v) => (countWords(v) < countWords(a) ? v : a), (u.variants || [""])[0])) };
      const text = renderParts(d.kind, fit.parts, d.subject || null);
      return { kind: d.kind, text, units: d.units, subject: d.subject || null, words: draftWordCount(text), target: tgt, exact: draftWordCount(text) === tgt.words, method: "units", floor };
    }
    const src = String(d.text || "");
    const before = draftWordCount(src);
    if (before <= tgt.words) return { kind: d.kind || "draft", text: src, words: before, target: tgt, exact: before === tgt.words, method: "unchanged", already: true };
    const lines = src.split("\n");
    const subject = /^subject:/i.test((lines[0] || "").trim()) ? lines[0] : null;
    const rest = (subject ? lines.slice(1) : lines).join("\n");
    const paras = splitParagraphs(rest);
    const isGreet = (p) => /^(hi|hello|hey|dear)\b[^.!?\n]{0,40},?$/i.test(p.trim());
    const isSign = (p) => /^(thanks|thank you|best|sincerely|regards|warmly|cheers)\b[^.!?]{0,40}(,|\n|$)/i.test(p.trim()) && countWords(p) <= 6;
    const head = paras.length && isGreet(paras[0]) ? paras[0] : null;
    const tail = paras.length > 1 && isSign(paras[paras.length - 1]) ? paras[paras.length - 1] : null;
    const core = paras.slice(head ? 1 : 0, tail ? -1 : undefined);
    const sents = core.flatMap((p, pi) => splitSentences(p).map((x) => ({ x, pi })));
    const fixed = countWords(head || "") + countWords(tail || "");
    const keep = sents.map(() => true);
    const total = () => fixed + sents.reduce((n, s0, k) => n + (keep[k] ? countWords(s0.x) : 0), 0);
    for (let k = sents.length - 2; k >= 1 && total() > tgt.words; k--) keep[k] = false;
    for (let k = 1; k < sents.length && total() < tgt.words; k++) { if (!keep[k]) { keep[k] = true; if (total() > tgt.words) keep[k] = false; } }
    const byPara = new Map();
    sents.forEach((s0, k) => { if (keep[k]) byPara.set(s0.pi, (byPara.get(s0.pi) || []).concat(s0.x)); });
    const body = [...byPara.keys()].sort((a, b) => a - b).map((pi) => byPara.get(pi).join(" "));
    const text = [subject, subject ? "" : null, head, head ? "" : null, body.join("\n\n"), tail ? "" : null, tail].filter((x) => x !== null).join("\n");
    const words = draftWordCount(text);
    return { kind: d.kind || "draft", text, words, target: tgt, exact: words === tgt.words, method: "sentences" };
  }

  return {
    countWords, draftWordCount, wordTargetOf, fitUnits, factVariants, whyRoleUnits, networkingUnits, composeBudgetedDraft, refitDraft,
    resolvePolicy, gate0, POLICY_REGISTRY, KIND_DEFAULTS,
    assembleWave,
    extractVoiceProfile, voiceTargetsText, sampleStructuralSeed, openerClass,
    PATTERN_PROMPT_V2_TEMPLATE, renderPromptV2,
    traceFacts, extractCheckables, slopGate, rewriteInstruction, runGateLoop,
    batchGate, captureEdits, composePatternDraft,
    splitSentences, splitParagraphs,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerWriting;
