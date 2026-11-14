// WO-N REPLY RUBRIC (2026-11-09): the reply-quality rules of docs/architect/specs/APP-LAYER-15-FIXES.md as a deterministic
// checker. Spec A.5 (clarity, brevity, context, ownership, evidence), B.1-B.7 (the target replies), D.4 (content rules),
// E.4 (ambiguity) and E.6 (limits and reply quality). It reads one reply and what is known about its turn and returns
// the rules the reply breaks, each with the words that break it. It never changes a reply.
//
// Who uses it: unit tests (tests/edge/reply-rubric.test.ts), the WO-N sweep over the flow and journey suites, and the R10
// loop's R-3 writing-quality row. On the live reply path only answersFirst is used, and only as a check that asks the model once
// to rewrite (D-072: agent-chat/career_brain.ts processCheck, a review of a practice answer); it never changes a reply itself.
//
// A rule that needs an input the caller did not give (facts, proofs, a pending decision, a blocker, the person's zone) is
// reported in `skipped`, never passed silently.

import { splitNatural } from "./channel_voice.ts";

export type RubricChannel = "telegram" | "whatsapp" | "imessage" | "sms" | "web";

export type RuleId =
  | "answers_first" // the first sentence answers the actual ask (A.5 clarity; E.6 52)
  | "ends_at_decision" // a pending decision is the last sentence (D.4 8; B.6 "a short stop at a real decision")
  | "unproven_action" // no claim that something happened without proof of it this turn (D-024; B.7; D.4 7)
  | "invented_fact" // every name, number, link and address comes from the facts or the ask (D-007; D.4 10)
  | "blocker_named" // a stop names the specific blocker and its evidence (A.5 pattern 5; E.6 52, 54)
  | "repeats_ask" // no echo of the ask, no asking again for what the ask already gave (A.5 pattern 1)
  | "apology_loop" // at most one apology, and not again turn after turn (B.7 "repeating a failure with new wording")
  | "boilerplate_tail" // no resume-confirmation tail, "let me know if", catch-all next-step filler (F.1; A.2)
  | "internal" // no internal ids, queue codes or system words (D.4 9; A.5 pattern 3)
  | "channel_length" // fits the channel's bubble limits; short asks get short replies (E.6 52)
  | "time_zone" // clock times in the person's own zone, never UTC or a stale "as of" date (E.6 50; D.4 9)
  | "leaked_instruction"; // no text addressed to the model (a tool note: "tell them ...", "do not claim ...") in a reply (H2H fix 1)

export const RULES: readonly RuleId[] = [
  "answers_first", "ends_at_decision", "unproven_action", "invented_fact", "blocker_named", "repeats_ask", "apology_loop",
  "boilerplate_tail", "internal", "channel_length", "time_zone", "leaked_instruction",
];

// What happened this turn, with proof (a tool result, a row read back, an employer receipt). Only these may be claimed.
export type ProofKind =
  | "submitted" | "sent" | "file" | "saved" | "scheduled" | "connected" | "paused" | "cancelled" | "verified" | "searched";

export interface RubricInput {
  reply: string;
  ask: string; // the person's latest message
  intent?: string | null;
  channel?: RubricChannel;
  // Confirmed facts and tool results of this turn as text. Given: every name, number, link and email in the reply must be
  // in them or in the ask. Absent: invented_fact is skipped.
  facts?: string[];
  // The actions this turn did and proved ([] = nothing was proved). Absent: unproven_action is skipped.
  proofs?: ProofKind[];
  decisionPending?: boolean; // the turn leaves a decision with the person (an approval, a choice, a missing answer)
  blocker?: { what: string; evidence: string } | null; // the turn stopped on this, with this evidence
  timeZone?: string | null; // the person's IANA zone ("America/Chicago")
  now?: Date; // the turn's clock (stale "as of" dates are judged against it)
  previousReplies?: string[]; // earlier replies in the conversation, oldest first
  bubbles?: string[]; // the bubbles actually delivered (else the channel's own splitter is used)
}

export interface Violation { rule: RuleId; detail: string; quote?: string }
export interface RubricResult { ok: boolean; violations: Violation[]; skipped: RuleId[] }

// ------------------------------------------------------------------------------------------------------------ text helpers
const URL_RX = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi;
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const clean = (s: string) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
const plainQuotes = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
const isUrlLine = (l: string) => /^\s*(?:[-*•]\s*)?https?:\/\/\S+\s*$/.test(l);
const isListLine = (l: string) => /^\s*(?:\d{1,2}[.)]|[-*•])\s/.test(l);
const isPlaceholder = (s: string) => /^\[[^\]]+\]$/.test(s.trim());

// Sentences in reading order (split after . ! ? and at line breaks; never inside a link, a number like 2.5 or "e.g.").
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of clean(text).split("\n")) {
    if (!line.trim()) continue;
    let buf = "";
    for (const tok of line.split(/(\s+)/)) {
      buf += tok;
      if (/[.!?]["')\]]*$/.test(tok) && !/^https?:\/\//.test(tok) && !/^(e\.g|i\.e|etc|vs|mr|ms|mrs|dr|st|no|u\.s)\.$/i.test(tok) &&
        !/^\d+\.$/.test(tok) && !/^[A-Z]\.$/.test(tok)) { out.push(buf.trim()); buf = ""; }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter(Boolean);
}
// The sentences that carry words (a bare link line is where the person taps, not a sentence of the reply).
const proseSentences = (text: string) => sentencesOf(text).filter((s) => !isUrlLine(s));

const STOP = new Set(`the a an and or but so if of to in on at for from by with into onto about as is are was were be been being
it its it's this that these those there here what which who whom whose why how when where can could would should will shall
may might must do does did done have has had having i me my mine you your yours we us our they them their he him his she her
not no yes please just only also too very really some any all each every more most much many few one ones me let get got make
made now then than like want need tell show give send find look see know think say said ask asked still even yet okay ok sure
thanks thank hi hey hello don't didn't can't won't i'm i've i'll it's that's what's there's here's let's`.split(/\s+/));
const stemOf = (w: string) => w.toLowerCase().replace(/'s$/, "").replace(/(ings|ing|ed|es|s)$/, "").slice(0, 6);
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  const t = plainQuotes(String(text ?? "")).replace(URL_RX, " ").toLowerCase();
  for (const m of t.matchAll(/[a-z][a-z0-9'+#-]*/g)) {
    const w = m[0].replace(/'+$/, "");
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stemOf(w));
  }
  for (const m of t.matchAll(/\b\d+(?:\.\d+)?\b/g)) out.add(m[0]);
  return out;
}
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w));

// A clause with a negation, a condition or a future is not a claim that something happened ("nothing was sent", "once you
// say yes I'll submit it", "I will send it after you approve").
const NOT_A_CLAIM = /\b(not|no|nothing|never|none|nobody|neither|nor|until|unless|before|if|once|when|whenever|after|without|yet|cannot|will|would|could|should|can|may|might|going to|ready to|want|wants|ask|asks|approve|proposed|draft)\b|n't\b|'ll\b|\?/i;
function clausesOf(sentence: string): string[] {
  return sentence.replace(URL_RX, " ").split(/[;:,—–]|\s-\s|\b(?:and|but|so|then|because)\b/i).map((c) => c.trim()).filter(Boolean);
}

// ----------------------------------------------------------------------------------------------------------- the rules

// 1. The first sentence answers the actual ask: it is not a preamble or a process statement, and it either shares the
// ask's subject or carries a result (a count, a link, a yes or no, the file, the pick, the blocker, the draft).
const NON_ANSWER: RegExp[] = [
  /^(sure|okay|ok|great|absolutely|certainly|of course|got it|on it|alright|right|thanks[^.]*)[!.,—-]*$/i,
  /\bgreat question\b|\bgood question\b/i,
  /\bnothing was invented\b/i,
  /\bchecked against the record\b/i,
  /^tell me what you['’]?d like to do next/i,
  /^i understand\b|^i hear you\b|^thanks for (asking|your patience|reaching out)\b/i,
  /^let me (see|check|look|think)\b/i,
  /^(here['’]?s|here is) what (i can|you can|runs|works)\b|^what does run\b/i,
  /\bcan['’]?t be graded without\b/i,
  /^on it\b/i,
];
const RESULT_SIGNAL: RegExp[] = [
  /\d/, URL_RX,
  /^(yes|no|yep|nope|not yet|done)\b/i,
  /\b(here is|here['’]s|attached|is ready|are ready)\b/i,
  /^(draft|proposed replacement|my (take|interpretation|read|pick|recommendation))\s*:/i,
  /\bi (used|picked|chose|moved|kept|left|put|made|changed|removed|added|found|verified|hit|cannot|can['’]t|could not|couldn['’]t|did not|didn['’]t)\b/i,
];
// A capitalized word that is not a sentence's first word or a common word: a name (a company, a role, a person).
function namesIn(sentence: string): string[] {
  const words = plainQuotes(sentence).replace(URL_RX, " ").split(/\s+/);
  const out: string[] = [];
  words.forEach((raw, i) => {
    const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").replace(/'s$/, "");
    if (!w || !/^[A-Z]/.test(w)) return;
    const lead = i === 0 || /[:;]$/.test(words[i - 1] ?? "") || /^["'(]/.test(raw);
    if (lead && !NAME_LIKE_LEAD.test(w)) return;
    if (COMMON_CAPS.has(w.toLowerCase())) return;
    out.push(w);
  });
  return out;
}
const NAME_LIKE_LEAD = /^[A-Z][a-z]+[A-Z]|^[A-Z]{2,}$/; // "LinkedIn", "SQL" at a sentence start still read as names
const COMMON_CAPS = new Set(`i i'm i've i'll i'd the a an and but or so if when what which who why how where your you my we our it
this that these those there here then now next first last today tomorrow tonight yesterday monday tuesday wednesday thursday
friday saturday sunday january february march april may june july august september october november december am pm
trainee telegram whatsapp imessage sms pdf docx doc gpa url link file yes no ok okay draft proposed replacement source sources
confirmation submitted job role internship resume cv apply`.split(/\s+/));
export function answersFirst(i: RubricInput): Violation[] {
  const first = proseSentences(i.reply)[0];
  if (!first) return [{ rule: "answers_first", detail: "the reply is empty" }];
  for (const rx of NON_ANSWER) if (rx.test(first)) return [{ rule: "answers_first", detail: "the first sentence is a preamble or a process statement, not the answer", quote: first }];
  if (overlap(contentWords(first), contentWords(i.ask)).length) return [];
  if (RESULT_SIGNAL.some((rx) => new RegExp(rx.source, rx.flags.replace("g", "")).test(first))) return [];
  if (namesIn(first).length) return [];
  // A short clarifying question is an answer to an ambiguous ask (B.4: "a short question prevents a wrong action").
  if (/\?\s*$/.test(first) && first.length <= 160) return [];
  return [{ rule: "answers_first", detail: "the first sentence neither takes up the ask nor gives a result", quote: first }];
}

// 2. A pending decision is where the reply ends: the last sentence is the question or the choice. A question in the middle
// with more prose after it buries the decision (A.2 resume turn 2: the question, then "What changed: ...").
const CHOICE = /\?\s*$|\b(reply|text|say|tap)\b[^.]*\b(yes|no|approve|skip|stop|\d)\b|\b(or|either)\b[^.]*\?$|\bapprove\b[^.]*$/i;
export function endsAtDecision(i: RubricInput): Violation[] {
  const ss = proseSentences(i.reply).filter((s) => !isPlaceholder(s));
  if (!ss.length) return [];
  const last = ss[ss.length - 1];
  const out: Violation[] = [];
  let leads = false;
  const qAt = ss.map((s, k) => (/\?["')]*$/.test(s) && !isListLine(s) ? k : -1)).filter((k) => k >= 0);
  if (qAt.length && qAt[qAt.length - 1] < ss.length - 1) {
    const after = ss.slice(qAt[qAt.length - 1] + 1).filter((s) => !isListLine(s));
    // A reply that LEADS with its question and adds at most two short sentences of why keeps the decision in front
    // (B.6 continuation 1 turn 6: "Which role should this go to? Before sending, I will show you ...").
    leads = qAt[qAt.length - 1] === 0 && after.length <= 2 && after.join(" ").length <= 240;
    if (after.length && !leads) out.push({ rule: "ends_at_decision", detail: "prose follows the question, so the decision is not the last thing read", quote: after.join(" ").slice(0, 200) });
  }
  if (i.decisionPending && !out.length && !leads && !CHOICE.test(last)) out.push({ rule: "ends_at_decision", detail: "a decision is pending but the reply does not end on it", quote: last });
  return out;
}

// 3. No claim of an action without its proof this turn. The claim words map to proof kinds.
const CLAIMS: [ProofKind, RegExp][] = [
  ["submitted", /\b(submitted|applied (?:to|for)|application (?:is |was )?(?:in|sent|submitted)|went through)\b/i],
  ["sent", /\b(sent|emailed|messaged|texted|mailed|delivered|reached out)\b/i],
  ["file", /\b(attached|here is the [^.]*\b(pdf|file|resume|document|packet|brief|draft)|here['’]s the [^.]*\b(pdf|file|resume|document|packet|brief)|saved as (pdf|docx)|download link)\b/i],
  ["saved", /\b(i(?:['’]ve| have)? (?:saved|recorded|stored)|(?:is|was|are|were|been) (?:saved|recorded|stored)|saved (?:it|them|that|this|to your)|updated your|added (?:it |them )?to your|on your profile now)\b/i],
  ["scheduled", /\b(scheduled|booked|calendared|reminder is set|set a reminder)\b/i],
  ["connected", /\b(connected|is linked|signed you in)\b/i],
  ["paused", /\b(paused|pause is (now )?set|stopped everything|is now stopped|global pause)\b/i],
  ["cancelled", /\b(cancell?ed|withdrawn|withdrew)\b/i],
  ["verified", /\b(verified|confirmed (?:open|live)|parse check pass)\b/i],
];
export function unprovenActions(i: RubricInput): Violation[] {
  if (!i.proofs) return [];
  const have = new Set(i.proofs ?? []);
  const out: Violation[] = [];
  for (const s of proseSentences(i.reply)) {
    for (const c of clausesOf(s)) {
      if (NOT_A_CLAIM.test(c)) continue;
      for (const [kind, rx] of CLAIMS) {
        if (!rx.test(c) || have.has(kind)) continue;
        out.push({ rule: "unproven_action", detail: `claims "${kind}" with no proof of it this turn`, quote: c });
      }
    }
  }
  return dedupe(out);
}

// 4. No invented fact: every number, link, email and name in the reply is in the facts or the ask.
const COMMON_ACRONYMS = new Set(`pdf docx doc gpa url us usa uk ai ats faq id ok am pm cst cdt est edt pst pdt mst mdt ct et pt mt
utc gmt sms nyc sf hq ceo cto vp hr cv`.split(/\s+/));
export function inventedFacts(i: RubricInput): Violation[] {
  if (!i.facts) return [];
  const src = plainQuotes([...i.facts, i.ask].join("\n"));
  const lower = src.toLowerCase();
  const nums = new Set<string>();
  for (const m of src.replace(URL_RX, " ").matchAll(/\d[\d,]*(?:\.\d+)?/g)) nums.add(m[0].replace(/,/g, ""));
  const out: Violation[] = [];
  const body = plainQuotes(clean(i.reply)).replace(/\[[^\]\n]*\]/g, " "); // [placeholders] are marked unknowns, not facts
  for (const u of body.match(URL_RX) ?? []) if (!src.includes(u)) out.push({ rule: "invented_fact", detail: "a link that is not in the facts", quote: u });
  for (const e of body.match(EMAIL_RX) ?? []) if (!lower.includes(e.toLowerCase())) out.push({ rule: "invented_fact", detail: "an address that is not in the facts", quote: e });
  const noLinks = body.replace(URL_RX, " ").replace(EMAIL_RX, " ");
  for (const m of noLinks.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, "").replace(/\.$/, "");
    if (!nums.has(n) && !/^[1-9]$/.test(n)) out.push({ rule: "invented_fact", detail: "a number that is not in the facts", quote: m[0] });
  }
  for (const s of sentencesOf(noLinks)) {
    for (const w of namesIn(s)) {
      if (COMMON_ACRONYMS.has(w.toLowerCase())) continue;
      if (new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower)) continue;
      out.push({ rule: "invented_fact", detail: "a name that is not in the facts", quote: w });
    }
  }
  return dedupe(out);
}

// 5. A stop names its blocker, with evidence. Given a blocker, the reply carries its words and its evidence. Either way, a
// reply that says it could not do something says why, specifically, in that sentence or the next.
const FAILED = /\b(couldn['’]?t|could not|can['’]?t|cannot|unable|wasn['’]?t able|failed|not switched on|not available|no (?:roles|results|matches|postings|listings|jobs) (?:found|came back)|nothing (?:found|came back|matched)|nothing was invented|did not find|didn['’]?t find)\b/i;
const REASON = /\b(because|since|due to|blocked by|returned|refused|timed out|is down|was down|limit|rate|sign(?:ed)?[- ]in|not connected|requires?|needs?|missing|unknown|not stated|closed|in (?:the )?(?:scope|places|sources) (?:i )?checked|checked|searched|scanned|across|resets?)\b|:/i;
const VAGUE = /\b(something went wrong|an error occurred|for some reason|technical (?:issue|difficulties)|not switched on|that kind of ask)\b/i;
export function blockerNamed(i: RubricInput): Violation[] {
  const out: Violation[] = [];
  const ss = proseSentences(i.reply);
  if (i.blocker) {
    const words = contentWords(i.reply);
    const need = (t: string) => { const w = contentWords(t); return !w.size || overlap(w, words).length >= Math.min(2, w.size); };
    if (!need(i.blocker.what)) out.push({ rule: "blocker_named", detail: `the blocker is not named (${i.blocker.what})` });
    if (!need(i.blocker.evidence)) out.push({ rule: "blocker_named", detail: `the blocker's evidence is not given (${i.blocker.evidence})` });
  }
  ss.forEach((s, k) => {
    if (!FAILED.test(s)) return;
    if (VAGUE.test(s)) { out.push({ rule: "blocker_named", detail: "the blocker is vague, not the specific one", quote: s }); return; }
    const near = `${s.replace(FAILED, " ")} ${ss[k + 1] ?? ""}`;
    if (!REASON.test(near)) out.push({ rule: "blocker_named", detail: "says it could not do something without saying why", quote: s });
  });
  return dedupe(out);
}

// 6a. No echo of the ask, and no asking again for what the ask already gave (A.5 pattern 1, "Name the role" after the role).
const ECHO = /^(you (?:asked|want(?:ed)?|said|would like)(?: me)? (?:to|for|whether|if|that)|so you(?:['’]re| are) (?:asking|looking)|just to confirm,? you)/i;
const ROLE_IN_ASK = /\b(analyst|engineer|developer|designer|manager|intern(?:ship)?s?|scientist|associate|consultant|coordinator|specialist|assistant|marketing|sales|product|data|finance|accounting|nurse|teacher)\b/i;
const ASKS_ROLE = /\b(name the role|which role|what role|tell me the role|paste the posting|what (?:job|position) (?:is it|are you)|the role you want)\b/i;
const PLACE_IN_ASK = /\b(in|near|around) [A-Z][a-z]+|\bremote\b/;
const ASKS_PLACE = /\b(which city|what city|where (?:do you want|should i look|are you looking)|name the (?:place|city))\b/i;
export function repeatsAsk(i: RubricInput): Violation[] {
  const out: Violation[] = [];
  const first = proseSentences(i.reply)[0] ?? "";
  if (ECHO.test(first)) out.push({ rule: "repeats_ask", detail: "the reply opens by repeating the ask back", quote: first });
  else {
    const a = contentWords(i.ask), f = contentWords(first);
    if (a.size >= 6 && f.size && overlap(f, a).length / f.size >= 0.8 && overlap(f, a).length / a.size >= 0.6) out.push({ rule: "repeats_ask", detail: "the first sentence restates the ask", quote: first });
  }
  const body = clean(i.reply);
  const roleQ = ASKS_ROLE.exec(body), placeQ = ASKS_PLACE.exec(body);
  if (roleQ && ROLE_IN_ASK.test(i.ask)) out.push({ rule: "repeats_ask", detail: "asks for the role the ask already gave", quote: roleQ[0] });
  if (placeQ && PLACE_IN_ASK.test(i.ask)) out.push({ rule: "repeats_ask", detail: "asks for the place the ask already gave", quote: placeQ[0] });
  return out;
}

// 6b. At most one apology in a reply, and not an apology again right after one.
const APOLOGY = /\b(sorry|i apologi[sz]e|apologies|my (?:mistake|bad|fault))\b/gi;
export function apologyLoop(i: RubricInput): Violation[] {
  const here = (clean(i.reply).match(APOLOGY) ?? []).length;
  const out: Violation[] = [];
  if (here >= 2) out.push({ rule: "apology_loop", detail: `apologises ${here} times in one reply` });
  const prev = i.previousReplies?.[i.previousReplies.length - 1];
  if (here >= 1 && prev && APOLOGY.test(prev)) out.push({ rule: "apology_loop", detail: "apologises again right after an apology" });
  APOLOGY.lastIndex = 0;
  if (/\bapologi[sz]e for any (confusion|inconvenience)\b/i.test(i.reply)) out.push({ rule: "apology_loop", detail: "a stock apology" });
  return out;
}

// 6c. No boilerplate tails: the resume-confirmation tail on a reply that is not about the resume (F.1), next-step filler
// ("Tell me what you'd like to do next", A.2), "let me know if ..." and the other stock closers.
const TAILS: [string, RegExp][] = [
  ["resume-confirmation tail", /\b(nothing is sent anywhere before your resume is confirmed|reply "?yes,? that['’]?s my resume"?|its entries are waiting for your word)\b/i],
  ["next-step filler", /\btell me what you['’]?d like to do next\b|\bwhat would you like to do next\b/i],
  ["let-me-know filler", /\b(let me know if|just let me know|feel free to|don['’]t hesitate|i hope this helps|happy to help|is there anything else|anything else i can)\b/i],
  ["source-stamp filler", /\bsource: [^.]*\bas supplied in context\b|\bgrounded in your profile record\b/i],
];
export function boilerplateTails(i: RubricInput): Violation[] {
  const out: Violation[] = [];
  const body = plainQuotes(clean(i.reply));
  const aboutResume = /resume|cv/i.test(i.ask) || /resume/i.test(i.intent ?? "");
  for (const [name, rx] of TAILS) {
    const m = rx.exec(body);
    if (!m) continue;
    if (name === "resume-confirmation tail" && aboutResume && /confirm/i.test(i.ask)) continue;
    out.push({ rule: "boilerplate_tail", detail: name, quote: m[0] });
  }
  return out;
}

// 7. No internal ids, queue codes or system words in what the person reads (D.4 9: "runner", "parse check PASS", "record",
// "packet" as jargon).
const INTERNAL: [string, RegExp][] = [
  ["a code name", /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/],
  ["a snake_case id", /\b[a-z]+(?:_[a-z0-9]+){1,}\b/],
  ["a uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["a hex id", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/i],
  ["a queue or row id", /\b(?:job|app|row|task|queue|trig|run|req|msg|batch)[_#-]?\d{2,}\b|\b(?:MI|WO|Q)-\d+\b/],
  ["system words", /\b(runner|parse check|router|handler|payload|board adapter|served board list|turn key|thread state|the queue['’]s own records|built-in steps|non-ai|in this run|career context|browser worker|wiring|the record|from the record|against the record|this record)\b/i],
  ["a raw status code", /\b(?:status|state)[:=]\s*[a-z_]+\b|\b(?:PASS|FAIL)\b/],
];
export function internalWords(i: RubricInput): Violation[] {
  const body = clean(i.reply).replace(URL_RX, " ").replace(EMAIL_RX, " ");
  const out: Violation[] = [];
  for (const [name, rx] of INTERNAL) {
    const m = rx.exec(body);
    if (m) out.push({ rule: "internal", detail: name, quote: m[0] });
  }
  return out;
}

// 8. The channel's limits. Bubble size and count per channel (the adapters' own numbers: telegram.ts/whatsapp.ts PACK 1500
// with a 4096 hard cap; conversation.ts BUBBLE_CHARS 700 and MAX_BUBBLES 16 on iMessage; channel_shape.ts ANSWER_MAX_CHARS
// 700 on the web), and E.6 52: a short ask gets a short reply (prose only; list items and links are the content asked for).
export const CHANNEL_LIMITS: Record<RubricChannel, { bubbleChars: number; hardChars: number; maxBubbles: number }> = {
  telegram: { bubbleChars: 1500, hardChars: 4096, maxBubbles: 4 },
  whatsapp: { bubbleChars: 1500, hardChars: 4096, maxBubbles: 4 },
  imessage: { bubbleChars: 700, hardChars: 5000, maxBubbles: 6 },
  sms: { bubbleChars: 700, hardChars: 1600, maxBubbles: 4 },
  web: { bubbleChars: 4000, hardChars: 8000, maxBubbles: 1 },
};
export const SHORT_ASK_WORDS = 25, SHORT_REPLY_PROSE = 600;
export function channelLength(i: RubricInput): Violation[] {
  const ch = i.channel ?? "telegram", lim = CHANNEL_LIMITS[ch];
  const out: Violation[] = [];
  const bubbles = i.bubbles ?? splitNatural(clean(i.reply), lim.bubbleChars);
  const worded = bubbles.filter((b) => !isUrlLine(b));
  if (worded.length > lim.maxBubbles) out.push({ rule: "channel_length", detail: `${worded.length} text bubbles on ${ch} (at most ${lim.maxBubbles})` });
  for (const b of bubbles) if (b.length > lim.hardChars) out.push({ rule: "channel_length", detail: `a bubble of ${b.length} characters is over ${ch}'s ${lim.hardChars}` });
  const askWords = String(i.ask ?? "").trim().split(/\s+/).filter(Boolean).length;
  const prose = clean(i.reply).split("\n").filter((l) => l.trim() && !isListLine(l) && !isUrlLine(l)).join(" ").replace(URL_RX, "");
  if (askWords <= SHORT_ASK_WORDS && prose.length > SHORT_REPLY_PROSE) out.push({ rule: "channel_length", detail: `a ${askWords}-word ask got ${prose.length} characters of prose (at most ${SHORT_REPLY_PROSE})` });
  return out;
}

// 9. Times in the person's own zone: no UTC/GMT or another zone's clock, no ISO timestamp, no stale "as of" date.
const ZONE_ABBR = /\b(UTC|GMT|Z|[ECMP][SD]T|[ECMP]T|AKST|AKDT|HST|BST|CET|CEST|IST|JST|AEST|AEDT)\b/;
const CLOCK = /\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|midnight|noon)\b/i;
function zoneLabels(tz: string, at: Date): Set<string> {
  const labels = new Set<string>();
  for (const name of ["short", "shortGeneric"] as const) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: name }).formatToParts(at).find((p) => p.type === "timeZoneName");
      if (part) labels.add(part.value.toUpperCase());
    } catch { /* an unknown zone: no labels */ }
  }
  // "CST" and "CDT" both name the person's zone whatever the season; "CT" is the generic.
  for (const l of [...labels]) if (/^[ECMP][SD]T$/.test(l)) { labels.add(`${l[0]}ST`); labels.add(`${l[0]}DT`); labels.add(`${l[0]}T`); }
  return labels;
}
export function timeZoneRule(i: RubricInput): Violation[] {
  const out: Violation[] = [];
  const body = clean(i.reply).replace(URL_RX, " ");
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/.exec(body);
  if (iso) out.push({ rule: "time_zone", detail: "a raw timestamp", quote: iso[0] });
  const now = i.now ?? null;
  const asOf = /\bas of (\d{4}-\d{2}-\d{2})\b/i.exec(body);
  if (asOf && now && now.getTime() - Date.parse(`${asOf[1]}T00:00:00Z`) > 7 * 86400_000) out.push({ rule: "time_zone", detail: "a stale \"as of\" date", quote: asOf[0] });
  const tz = i.timeZone ?? null;
  for (const s of sentencesOf(body)) {
    if (!CLOCK.test(s)) continue;
    const z = ZONE_ABBR.exec(s.replace(/\b(?:a\.m\.|p\.m\.)/gi, ""));
    if (!z) continue;
    const zone = z[1].toUpperCase();
    if (zone === "UTC" || zone === "GMT" || zone === "Z") { out.push({ rule: "time_zone", detail: "a time in UTC, not the person's zone", quote: s }); continue; }
    if (tz && !zoneLabels(tz, now ?? new Date(0)).has(zone)) out.push({ rule: "time_zone", detail: `a time in ${zone}, not the person's zone (${tz})`, quote: s });
  }
  return dedupe(out);
}

// 10. No instruction meant for the model (H2H fix 1, docs/architect/INSTINCT-HEAD-TO-HEAD.md A.2 resume turn 3: a tool's error
// note, "so the person could not open it. Tell them it isn't available yet; do not claim it was made.", was shown as is). The
// person is "you" in a reply: a sentence about "the person" or "the user", or one telling the writer what to tell "them" or what
// not to claim, is the tool talking to the model. Advice to the person ("tell them you're interested") is theirs and passes.
const TO_MODEL: [string, RegExp][] = [
  ["the reader in the third person", /\bthe (?:person|user)\b(?:['’]s)?\s+(?:could(?:n['’]t| not)?|can(?:['’]t|not)?|cannot|will|would|should|did(?:n['’]t)?|does(?:n['’]t)?|is(?:n['’]t)?|has(?:n['’]t)?|was(?:n['’]t)?|needs?|must|asked|said|wants?|gave|confirmed)\b/i],
  ["an instruction to tell them", /\b(?:tell|inform) (?:them|the (?:person|user)) (?:it|that|this|nothing)\b(?![^.;]{0,30}\b(?:you|your|you're|i'm)\b)/i],
  ["an instruction not to claim", /\b(?:do not|don't|never) (?:claim|describe) (?:it|that|this)\b(?! (?:you|your)\b)(?:\s+(?:was|is|has|were|exists))?/i],
  ["a note to the model", /\b(?:note to (?:the )?(?:model|assistant)|as an ai\b|the (?:model|assistant) (?:should|must)\b|\binstructions? for the (?:model|assistant)\b)/i],
];
export function leakedInstruction(i: RubricInput): Violation[] {
  const body = plainQuotes(clean(i.reply));
  const out: Violation[] = [];
  for (const [name, rx] of TO_MODEL) {
    const m = rx.exec(body);
    if (m) out.push({ rule: "leaked_instruction", detail: name, quote: m[0].trim() });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------- the checker
const dedupe = (vs: Violation[]) => { const seen = new Set<string>(); return vs.filter((v) => { const k = `${v.rule}|${v.detail}|${v.quote ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

export function checkReply(i: RubricInput): RubricResult {
  const skipped: RuleId[] = [];
  if (!i.facts) skipped.push("invented_fact");
  if (!i.proofs) skipped.push("unproven_action");
  if (!i.timeZone) skipped.push("time_zone"); // UTC and raw timestamps are still flagged; another zone's clock is not judged
  const violations = [
    ...answersFirst(i), ...endsAtDecision(i), ...unprovenActions(i), ...inventedFacts(i), ...blockerNamed(i), ...repeatsAsk(i),
    ...apologyLoop(i), ...boilerplateTails(i), ...internalWords(i), ...channelLength(i), ...timeZoneRule(i), ...leakedInstruction(i),
  ];
  return { ok: violations.length === 0, violations, skipped };
}

// One line per violation, for reports (the sweep, the R10 loop's replies.md).
export function describe(r: RubricResult): string[] {
  return r.violations.map((v) => `${v.rule}: ${v.detail}${v.quote ? ` — "${v.quote.slice(0, 160)}"` : ""}`);
}
