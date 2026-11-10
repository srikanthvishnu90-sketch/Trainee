/* Career reply composer — the single module that turns module results and
   raw text into clean user-visible chat bubbles.
   Rule of the house: a chat bubble is short, plain, and human. At most
   MAX_SENTENCES_PER_BUBBLE sentences. No JSON, no code fences, no fact IDs,
   no UUIDs, no tool names, no internal jargon (router/edge/rail words),
   no markdown tables, no source citations — sources and long detail belong
   in a document (composeResult's doc), never in a bubble.
   composeText NEVER returns [] and NEVER returns a bubble that fails
   lint(); when the input carries no human sentence at all it returns
   [fallback("empty")].
   Pure, zero deps. UMD, same shape as 123-career-tailor.js. */
const CareerReply = (() => {
  const MAX_SENTENCES_PER_BUBBLE = 3;

  // Internal words that must never reach a user (lint flags them; the
  // composer strips sentences containing them). Mirrors the spirit of
  // scripts/career/prose-lint.cjs (CIR, tier codes, snake_case) and extends
  // it with the router/edge/rail vocabulary the brief names.
  const JARGON_WORDS = [
    "router_core", "edge function", "rail state",
    "router core", "rail", "rails", "cir", "cirs",
  ];
  const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  // BUG-048: a bare content digest (md5/sha1/sha256 class — 32+ hex chars
  // carrying at least one digit) and the "sha256" label itself are machine
  // payload, never prose. A hash belongs in the typed artifact/doorstep
  // record (proof), never in a bubble. URLs are masked before this scan:
  // an action link's path is the step itself, not a payload token.
  const HASH_WORD_RE = /\bsha-?256\b/i;
  const HASH_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{32,}\b/i;
  const FACT_ID_RE = /\bF-\d{3,}\b/;
  const FACT_ID_WORD_RE = /fact_?ids?/i;
  const TOOL_MARKER_RE = /\b\d{3}\.[a-z][a-zA-Z]+\s*\(/;
  const TOOL_BRACKET_RE = /\[tool /;
  const JSON_BRACE_RE = /\{["\[]/;
  const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

  // Abbreviations whose trailing period is not a sentence end.
  const ABBREVIATIONS = new Set([
    "u.s", "u.k", "e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "st",
    "jr", "sr", "inc", "ltd", "co", "corp", "dept", "approx", "jan", "feb",
    "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "a.m", "p.m", "ph.d", "m.d", "b.a", "m.a", "no",
  ]);

  function sentenceCount(text) {
    return splitSentences(text).length;
  }

  // Sentence-aware splitter: honors common abbreviations (U.S., e.g.),
  // decimals ($120.5k), initials, and ellipses.
  function splitSentences(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return [];
    const out = [];
    let start = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      const rest = t.slice(i + 1);
      // Ellipsis: a run of dots is one terminator, judged at its last dot.
      if (ch === "." && t[i + 1] === ".") continue;
      // Decimal point between digits is not a terminator.
      if (ch === "." && /\d/.test(t[i - 1] || "") && /^\d/.test(rest)) continue;
      // Text after the terminator must start a new sentence (or end input);
      // otherwise this is an abbreviation glued to what follows (U.S. roles).
      const m = rest.match(/^\s+(\S)/);
      if (rest.trim() && !m) continue;
      if (rest.trim() && m && !/[A-Z0-9"“'(]/.test(m[1])) continue;
      if (ch === ".") {
        const before = t.slice(start, i).split(/\s+/).pop() || "";
        const word = before.replace(/["'”’)\]]+$/, "").toLowerCase();
        if (ABBREVIATIONS.has(word)) continue;
        if (/^[a-z]$/.test(word)) continue; // single-letter initial
        if (/^(?:[a-z]\.)*[a-z]$/i.test(word) && word.includes(".")) continue;
      }
      const s = t.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
    const tail = t.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  // Group sentences into bubbles of at most MAX_SENTENCES_PER_BUBBLE.
  function splitBubbles(text) {
    const sentences = splitSentences(text);
    const bubbles = [];
    for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_BUBBLE) {
      bubbles.push(sentences.slice(i, i + MAX_SENTENCES_PER_BUBBLE).join(" "));
    }
    return bubbles;
  }

  function lint(text) {
    const t = String(text == null ? "" : text);
    const violations = [];
    if (!t.trim()) violations.push("empty text");
    if (sentenceCount(t) > MAX_SENTENCES_PER_BUBBLE) violations.push(`more than ${MAX_SENTENCES_PER_BUBBLE} sentences`);
    if (t.includes("```")) violations.push("code fence");
    if (JSON_BRACE_RE.test(t) || /(^|\s)\{/.test(t) || t.includes("}")) violations.push("JSON braces");
    if (UUID_RE.test(t.replace(/https?:\/\/\S+/g, " "))) violations.push("raw UUID"); // MUSE-F-001: a link's own id is not a raw UUID
    if (HASH_RE.test(t.replace(/https?:\/\/\S+/g, " ")) || HASH_WORD_RE.test(t)) violations.push("raw content hash");
    if (FACT_ID_RE.test(t)) violations.push("fact ID");
    if (FACT_ID_WORD_RE.test(t)) violations.push("fact-id wording");
    if (TOOL_MARKER_RE.test(t) || TOOL_BRACKET_RE.test(t)) violations.push("tool marker");
    const low = ` ${t.toLowerCase()} `;
    for (const w of JARGON_WORDS) {
      if (low.includes(` ${w} `) || low.includes(` ${w}.`) || low.includes(` ${w},`)) { violations.push(`internal jargon: ${w}`); break; }
    }
    // Bare URLs are opaque tokens, not prose — mask them before the
    // snake_case scan (a connect link's path legitimately carries "_").
    if (SNAKE_RE.test(t.replace(/https?:\/\/\S+/g, " "))) violations.push("snake_case token");
    if (/\bCIRs?\b/.test(t)) violations.push("internal jargon: CIR");
    if (/§/.test(t)) violations.push("spec-section reference");
    if (/\|/.test(t)) violations.push("markdown table pipe");
    if (/`/.test(t)) violations.push("backtick");
    if (/\]\(https?:/.test(t) || /\(source:/i.test(t)) violations.push("source citation in bubble");
    return { ok: violations.length === 0, violations };
  }

  const FALLBACKS = {
    // Composer rows 55/56/58 (2026-10-14): every fallback ends with
    // a real exit (a tell-me / choice sentence), never a bare stop.
    error: "Something went wrong on my end — nothing changed on your side. Tell me the job, company, or person to work on and I will pick it back up from there.",
    empty: "I do not have anything solid to show you on that yet. Tell me a job, company, or person to work on and I will dig in.",
    // 2026-10-23 (router eval): never the banned "I didn't catch that"; what Trainee is, then one question.
    unmatched: "I'm Trainee, a career agent: I find roles, prepare and track your applications, and get you ready for interviews. I may have missed what you meant, so what should we work on first?",
    timeout: "That took too long, so I stopped it. Tell me one job or one company and I will move faster on it.",
  };
  // Every test and grader that asks "was this the unmatched fallback?" asks this, so a wording change can never
  // silently weaken a detection: it matches the current text and the retired one.
  const FALLBACK_TEXT_RE = /^(I didn't catch that|I'm Trainee, a career agent: I find roles)/;
  function isFallbackText(text) { return FALLBACK_TEXT_RE.test(String(text || "").trim()); }
  function fallback(kind, ctx) {
    const base = FALLBACKS[kind] || FALLBACKS.error;
    const extra = ctx && typeof ctx === "object" && typeof ctx.next === "string" ? cleanInline(ctx.next) : "";
    // Append a caller-supplied next step only when the result still lints.
    if (extra) {
      const joined = `${base} ${extra}`;
      if (lint(joined).ok) return joined;
    }
    return base;
  }

  // ---- stripping machine payload out of raw text ----

  // Drop fenced code blocks and spans that parse as pure JSON. Prose that
  // merely mentions a brace survives here and is handled per-sentence.
  function stripPayloadSpans(text) {
    let t = String(text == null ? "" : text);
    t = t.replace(/```[\s\S]*?(```|$)/g, " ");
    // Whole-input JSON: nothing human to keep.
    const trimmed = t.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try { JSON.parse(trimmed); return ""; } catch { /* prose that starts with a bracket */ }
    }
    // Balanced {...} / [...] spans embedded in prose: drop the ones that
    // parse as JSON or carry JSON's key-colon shape.
    const dropSpans = (s) => {
      let out = "", i = 0;
      while (i < s.length) {
        const open = s[i];
        if (open !== "{" && open !== "[") { out += s[i]; i++; continue; }
        const close = open === "{" ? "}" : "]";
        let depth = 0, j = i, inStr = false, esc = false;
        for (; j < s.length; j++) {
          const c = s[j];
          if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') inStr = true;
          else if (c === open) depth++;
          else if (c === close) { depth--; if (!depth) break; }
        }
        if (j >= s.length) { out += s[i]; i++; continue; }
        const span = s.slice(i, j + 1);
        let isJson = false;
        try { JSON.parse(span); isJson = true; } catch { isJson = /"\s*:/.test(span) || span.length > 120; }
        if (!isJson) out += span;
        i = j + 1;
      }
      return out;
    };
    // Long bracketed spans first (nested payload), then any leftovers.
    t = dropSpans(t);
    t = dropSpans(t);
    return t;
  }

  // Remove machine tokens from one line of prose, keeping the words around
  // them. Returns "" when nothing human remains on the line.
  function cleanInline(line) {
    let s = String(line || "");
    s = s.replace(/\(\s*source:[^)]*\)/gi, " "); // citation parentheticals belong in docs, not bubbles
    // BUG-048: strip bare content digests and the sha256 label. URLs are
    // swapped out first and restored after — an action link is the step
    // itself (SC-286 contract), its path is not a digest token.
    const urls = [];
    s = s.replace(/https?:\/\/\S+/g, (u) => { urls.push(u); return `\u0001${urls.length - 1}\u0001`; });
    s = s.replace(HASH_WORD_RE, " ");
    s = s.replace(HASH_RE, " ");
    // Bare https links SURVIVE: an action link (the connect tap, a step's
    // destination) is the step itself, and the owner's standing rule is
    // that every step carries its exact raw URL (SC-286 contract). Only
    // citation-formatted links are removed above.
    s = s.replace(UUID_RE, " ");
    s = s.replace(FACT_ID_RE, " ");
    s = s.replace(FACT_ID_WORD_RE, " ");
    s = s.replace(/\b\d{3}\.[a-z][a-zA-Z]+\s*\([^)]*\)/g, " ");
    s = s.replace(/\b\d{3}\.[a-z][a-zA-Z]+\b/g, " ");
    s = s.replace(/\[tool [^\]]*\]/gi, " ");
    s = s.replace(/`+/g, " ");
    s = s.replace(/["][^"]*"\s*:/g, " "); // orphaned JSON keys
    s = s.replace(/[{}\[\]]/g, " ");
    s = s.replace(/\*\*|__|^#+\s*/g, " ");
    s = s.replace(/\s+([,.;!?])/g, "$1");
    s = s.replace(/\(\s*\)/g, " ");
    s = s.replace(/\s{2,}/g, " ").trim();
    s = s.replace(/^[\s\-•·]+/, "").trim();
    // MUSE-F-001: the links go back only now, after every machine-token rule: a job link's own path carries a UUID
    // (Lever, Ashby) or an id, and stripping it from the link broke the link the person was given.
    s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => urls[Number(i)] || m);
    return s;
  }

  // A sentence is fit for a bubble only when, after cleaning, it is plain
  // prose: no jargon, no snake_case, no citations, no table pipes.
  function sentenceIsClean(cleaned) {
    if (!cleaned || cleaned.length < 3) return false;
    if (!/[a-zA-Z]/.test(cleaned)) return false;
    const low = cleaned.replace(/https?:\/\/\S+/g, " ").toLowerCase(); // MUSE-F-001: a link's path is not jargon
    for (const w of JARGON_WORDS) if (new RegExp(`\\b${w}\\b`).test(low)) return false;
    // A bare URL is an opaque token, not prose: its underscores/slashes
    // must not trip the snake_case rule (SC-286's connect link carries one).
    if (SNAKE_RE.test(cleaned.replace(/https?:\/\/\S+/g, " "))) return false;
    if (HASH_WORD_RE.test(cleaned) || HASH_RE.test(cleaned.replace(/https?:\/\/\S+/g, " "))) return false; // BUG-048: a digest that survived cleaning still kills the sentence
    if (/\(source:/i.test(cleaned)) return false;
    if (cleaned.includes("|")) return false;
    return lint(cleaned).ok;
  }

  function composeText(raw, opts) {
    const _o = opts || {};
    const noPayload = stripPayloadSpans(raw == null ? "" : String(raw));
    const lines = noPayload.split(/\n+/);
    const sentences = [];
    for (const line of lines) {
      const isTableRow = (line.match(/\|/g) || []).length >= 2;
      const isRule = /^[\s|:-]+$/.test(line);
      if (isTableRow || isRule) continue; // markdown tables never reach a bubble
      for (const s of splitSentences(line)) {
        const cleaned = cleanInline(s);
        if (sentenceIsClean(cleaned)) sentences.push(cleaned);
      }
    }
    if (!sentences.length) return [fallback("empty")];
    const bubbles = [];
    for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_BUBBLE) {
      bubbles.push(sentences.slice(i, i + MAX_SENTENCES_PER_BUBBLE).join(" "));
    }
    const safe = bubbles.filter((b) => lint(b).ok);
    return safe.length ? safe : [fallback("empty")];
  }

  // One short human string from an arbitrary field: first clean sentence,
  // truncated to at most maxSentences sentences.
  function shortText(value, maxSentences) {
    if (value == null) return "";
    const bubbles = composeText(String(value));
    if (bubbles.length === 1 && bubbles[0] === FALLBACKS.empty) return "";
    const sentences = splitSentences(bubbles.join(" "));
    return sentences.slice(0, maxSentences || 1).join(" ");
  }

  function composeResult(result, opts) {
    const r = result || {};
    const o = opts || {};
    const bubbles = [];
    let doc = null;

    const headline = shortText(r.headline, 1);
    const recommendation = shortText(r.recommendation, 2);
    if (recommendation) {
      const lead = /^my take\b/i.test(recommendation) ? recommendation : `My take: ${recommendation.charAt(0).toLowerCase()}${recommendation.slice(1)}`;
      bubbles.push(...splitBubbles([headline, lead].filter(Boolean).join(" ")));
    } else if (headline) {
      bubbles.push(...splitBubbles(headline));
    }

    // Facts: compressed into at most 2 bubbles, however many arrive.
    const factSentences = [];
    for (const f of Array.isArray(r.facts) ? r.facts : []) {
      const s = shortText(f, 1);
      if (s) factSentences.push(s);
    }
    if (factSentences.length) {
      const cap = MAX_SENTENCES_PER_BUBBLE * 2;
      bubbles.push(...splitBubbles(factSentences.slice(0, cap).join(" ")));
    }

    // Long detail goes to a document; the bubble only points at it.
    const longBody = typeof r.longBody === "string" ? r.longBody.trim() : "";
    const longSentences = splitSentences(longBody.replace(/\s+/g, " "));
    if (longBody && (longSentences.length > MAX_SENTENCES_PER_BUBBLE || r.docTitle)) {
      const title = cleanInline(String(r.docTitle || o.docTitle || "Details")) || "Details";
      doc = { title, body: longBody };
      bubbles.push(`Full details in the doc: ${title}.`);
    } else if (longBody) {
      bubbles.push(...composeText(longBody));
    }

    // The next step always closes the reply.
    const nextStep = shortText(r.nextStep, 1);
    if (nextStep) {
      const last = bubbles[bubbles.length - 1];
      if (last && sentenceCount(last) < MAX_SENTENCES_PER_BUBBLE) bubbles[bubbles.length - 1] = `${last} ${nextStep}`;
      else bubbles.push(nextStep);
    }

    const safe = bubbles.filter((b) => b && lint(b).ok);
    return { bubbles: safe.length ? safe : [fallback("empty")], doc };
  }

  // ---- BUG-080: the ending rule (H-12 guarantee without template disease) ----
  // The §1a/§1b seams appended the generic closer whenever the last
  // sentence carried no H-12 token — even over a reply that already ended
  // with a SPECIFIC next step (a question, or a task-specific imperative
  // like SC-209's "answer as you would on the real call"). The re-pass
  // found the generic line in 143/278 replies, rowed in 39 places.
  // The rule now: a reply ends with the handler's specific next step when
  // one exists; the generic closer may be appended ONLY when the reply
  // carries no next step at all; it is never appended after a question or
  // a task-specific imperative; and a generic closer already stamped over
  // a specific ending is removed. Both delivery seams (142's local
  // ensureNextStepText — see the coordinator hand-off — and the harness /
  // host seam in pilot-lib.cjs) are to call THIS function so the rule
  // exists exactly once.
  const GENERIC_CLOSER = "Tell me what you'd like to do next.";
  const NEXT_STEP_TOKEN_RE = /\b(want me to|shall i|say the word|tell me|tap|reply (yes|with)|next:|approve|book it|want the|want to see|shall we)\b/i;
  // Verbs that, at the head of the last sentence or of a clause set off
  // inside it (em dash / semicolon / colon), make that sentence a
  // directive to the user — a specific imperative, not a bare ending.
  const IMPERATIVE_VERBS = new Set([
    "answer", "say", "tell", "open", "review", "check", "send", "give", "name", "pick", "choose", "select",
    "upload", "forward", "confirm", "approve", "tap", "reply", "ask", "share", "paste", "connect", "reconnect",
    "try", "start", "book", "schedule", "watch", "track", "log", "import", "decide", "sign", "list", "show",
    "add", "set", "fill", "prepare", "create", "take", "bring", "keep", "note", "look", "read", "download",
    "request", "stop", "wait", "write", "draft", "run", "submit", "apply", "search", "find", "build", "let",
    "state", "describe", "verify", "accept", "decline", "hold", "release", "resume", "restart", "retry",
    "close", "cancel", "finish", "complete", "follow", "click", "enter", "provide", "specify", "go", "meet",
  ]);
  function lastSentenceOf(text) {
    const sentences = splitSentences(String(text || ""));
    return sentences.length ? sentences[sentences.length - 1] : "";
  }
  function isSpecificImperative(sentence) {
    const s = String(sentence || "");
    if (!s) return false;
    if (/\bplease\b/i.test(s)) return true;
    for (const clause of s.split(/—|;|:/)) {
      const words = clause.replace(/^[\s"“”'‘’(\[]+/, "").split(/\s+/).filter(Boolean);
      if (words.length < 3) continue; // a fragment or a label ("Roleplay") is not a directive
      const head = words[0].replace(/[^a-z'-]/gi, "").toLowerCase();
      if (IMPERATIVE_VERBS.has(head)) return true;
    }
    return false;
  }
  function endsWithNextStep(text) {
    const last = lastSentenceOf(text);
    if (!last) return false;
    if (last === GENERIC_CLOSER) return true; // the guarantee, already satisfied generically
    if (/\?/.test(last) || /\[Yes\]/.test(last)) return true;
    if (NEXT_STEP_TOKEN_RE.test(last)) return true;
    return isSpecificImperative(last);
  }
  function ensureNextStep(text, opts) {
    const raw = String(text == null ? "" : text);
    if (!raw.trim()) return raw;
    const trimmed = raw.replace(/\s+$/, "");
    let specific = "";
    const supplied = opts && typeof opts.nextStep === "string" ? cleanInline(opts.nextStep) : "";
    if (supplied && supplied !== GENERIC_CLOSER) specific = /[.!?]$/.test(supplied) ? supplied : `${supplied}.`;
    // A generic closer already stamped on: keep it only when nothing
    // specific stands before it and no handler step was supplied.
    if (trimmed.endsWith(GENERIC_CLOSER)) {
      const before = trimmed.slice(0, trimmed.length - GENERIC_CLOSER.length).replace(/\s+$/, "");
      if (before && endsWithNextStep(before)) return before; // SC-209: strip the stamp, keep the specific ending
      if (specific && before && !endsWithNextStep(before)) return `${before} ${specific}`;
      if (specific && !before) return specific;
      return trimmed;
    }
    if (endsWithNextStep(trimmed)) return raw;
    if (specific) return `${trimmed} ${specific}`;
    return `${trimmed} ${GENERIC_CLOSER}`;
  }
  // D-054 (RESPONSE-RULES R10 and section 5, 2026-11-10): the reply ends at the decision, and nothing comes after it. The
  // delivery seams (142's compose and the host's ending guarantee) use this one: a handler's specific next step is still
  // appended to a reply that lacks one, and a generic closer already stamped on is removed, but the generic closer is never
  // added. A reply that answers a question with no decision open ends at the answer ("You live in Austin."), not at
  // "Tell me what you'd like to do next." ensureNextStep keeps the older H-12 guarantee for the callers that still want it.
  function endAtDecision(text, opts) {
    const raw = String(text == null ? "" : text);
    if (!raw.trim()) return raw;
    const out = ensureNextStep(raw, opts);
    const trimmed = out.replace(/\s+$/, "");
    if (!trimmed.endsWith(GENERIC_CLOSER)) return out;
    const before = trimmed.slice(0, trimmed.length - GENERIC_CLOSER.length).replace(/\s+$/, "");
    return before || out;
  }

  return { MAX_SENTENCES_PER_BUBBLE, composeText, composeResult, fallback, isFallbackText, FALLBACK_TEXT_RE, lint, splitBubbles, GENERIC_CLOSER, endsWithNextStep, ensureNextStep, endAtDecision };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerReply;
