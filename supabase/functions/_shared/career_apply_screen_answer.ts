// The posting screen's question, answered (F09). When the screen holds postings for a fact the person has not confirmed it
// asks once ("Will you need visa sponsorship...?") and the reply carries what it asked (meta.screen_ask) and which postings
// wait (meta.screen_held). The person's next message, while that question is the thread's last word, is read here:
//   * the answer becomes a CONFIRMED profile fact in their own words (screen_key + value + the message as evidence), so the
//     screen reads it now, on every later turn, and replaces an older answer for the same key;
//   * the held postings are screened again with it and queued if they pass (the caller's `rerun`), never before;
//   * a message that is not an answer to a question asked (a command, a question, another topic) is left alone: null.
// Nothing is guessed (D-007): a reply that does not clearly answer saves nothing and the question stands.
import { educationLevelOf, type GateResult, placeOf } from "./career_apply_gate.ts";
import { FACT_QUESTIONS, type ScreenFactKey } from "./career_apply_screen.ts";

export interface ScreenAsk { fact: ScreenFactKey; question: string }
export interface HeldPosting { job_id: string | null; company: string; title: string; url: string }

// What the reply keeps for the next turn. ONE question at a time: only the first open ask is put to the person (the rest come back on
// their own, because the held postings are screened again with each answer), so the person is never told to answer several at once.
// A single yes/no question also carries screen_buttons and a fresh screen_qid: the id the Yes / No buttons are bound to, so a tap
// answers only the question that is open right now (screenTapTurn).
export const newQid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
export function askMeta(ask: { fact: ScreenFactKey; question: string }, held: HeldPosting[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { screen_ask: [{ fact: ask.fact, question: ask.question }], screen_held: held, ...(isYesNoFact(ask.fact) ? { screen_buttons: ["Yes", "No"], screen_qid: newQid() } : {}), ...extra };
}
export function screenMeta(screen?: GateResult | null): Record<string, unknown> | null {
  if (!screen?.asks?.length) return null;
  return askMeta(screen.asks[0], screen.held.map((h) => ({ job_id: h.job_id, company: h.company, title: h.title, url: h.url })));
}

// A real yes / no only. "I don't know", "idk", "skip", "maybe" are NOT a no (D-007: never invent an answer): nothing is saved.
const UNSURE_PHRASE = /\b(?:(?:do\s*not|don'?t|didn'?t)\s+know|dunno|idk|no\s+(?:idea|clue)|not\s+(?:sure|certain)|unsure|uncertain|undecided|maybe|perhaps|possibly|it\s+depends|depends|prefer\s+not|rather\s+not\s+say|not\s+telling|no\s+comment)\b/i;
const UNSURE_WORD = /^\W*(?:skip|skipped|pass|later|n\/?a|none|nothing|nil|null|unknown|whatever|anything|anywhere|nowhere|somewhere|secret|private|test|asdf|\?+|ok|okay|hmm+|um+|uh+)\W*$/i;
const UNSURE = { test: (m: string) => !m.trim() || UNSURE_PHRASE.test(m) || UNSURE_WORD.test(m) };
const YES = /^(?:y|yes|yeah|yep|yup|sure|i do|i would|i will|i need (?:it|that|sponsorship)|definitely|absolutely|correct)\b(?!.*\b(?:not|n't|never|no)\b)/i;
const NO = /^(?:n|no|nope|nah|nay|not really|never|negative|i (?:do not|don'?t|would not|wouldn'?t|will not|won'?t)\s*)(?:\b|$)(?!.*\b(?:know|sure|idea|clue)\b)/i;
const NEG = /\b(?:not|n't|never|non|no longer|cannot|unwilling|won'?t|wouldn'?t|can'?t|rather not|prefer not to|no)\b|\bn'?t\b/i;
const BAD_PLACE = /^(?:skip|idk|none|pass|later|nowhere|anywhere|somewhere|unknown|here|there|home|earth|planet|nope|nah|not\b.*|no\b.*|n\/a|na|nil|null|undefined|test|asdf|secret|private|whatever|everywhere|the world|world|global|globe|online|internet|mars|moon)$/i;
const COMMAND = /\b(apply|queue|send|show|list|find|search|cancel|set|draft|write|tell me|remind|what|how|why|who|when|where|can you|could you|please)\b/i;
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const clean = (m: string) => String(m ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const KEYWORD: Record<ScreenFactKey, RegExp> = {
  location: /\b(live|living|reside|based|located|moved|in [A-Z])\b|\b(live|based)\b/i,
  relocation: /\b(relocat\w*|move|moving|remote only|in[- ]office|on[- ]?site)\b/i,
  sponsorship: /\b(sponsor\w*|visa|h-?1b|opt|work permit|authori[sz]ed)\b/i,
  citizenship: /\b(citizen\w*|green card|permanent resident|national)\b/i,
  years_experience: /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\+?\s*(?:years?|yrs?)\b/i,
  education_level: /\b(bachelor\w*|master\w*|ph\.?d|doctorate|mba|degree|associate|high school|ged|b\.?s|m\.?s|b\.?a|b\.?tech)\b/i,
};
// Words that make a "place" something else: another question's answer, or yes / no wording. A location is a place only.
const OTHER_TOPIC = /\b(?:sponsor\w*|visa|h-?1b|opt|work permit|authori[sz]ed|need|needs|needed|require\w*|citizen\w*|green card|permanent resident|relocat\w*|move|moving|degree|bachelor\w*|master\w*|ph\.?d|doctorate|mba|years?|yrs?|experience|y|n|yes|yeah|yep|yup|no|nope|nah|not|don'?t|do not|won'?t|cannot|can'?t)\b/i;
export interface Parsed { value: string | number; text: string }

// ONE table: question -> the only forms it accepts. A yes/no question accepts the WHOLE trimmed message, case-insensitive and
// punctuation-stripped, equal to yes / y / yeah / yep / no / n / nope (what the Yes / No buttons send) and nothing else: never a
// phrase, never a sentence that happens to contain one ("No, I need sponsorship" is not a "no"). A phrase can be read two ways, and the
// wrong way records a person who needs sponsorship as a citizen (D-007). Free text is for the place (validated as a place) and for
// years ("N years" only). Every ScreenFactKey must have a row (the type enforces it), so no question can be left unguarded.
const YES_FORMS = new Set(["yes", "y", "yeah", "yep"]);
const NO_FORMS = new Set(["no", "n", "nope"]);
const yesNoOf = (m: string): "yes" | "no" | null => { const t = m.toLowerCase().replace(/[^a-z]/g, ""); return YES_FORMS.has(t) ? "yes" : NO_FORMS.has(t) ? "no" : null; };
// A place has a letter-led name that is not a number word, a school, or a generic noun ("three", "high school", "the city" are not places).
const NOT_PLACE_WORDS = new Set(("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million first second third fourth fifth " +
  "high school college university degree bachelor bachelors master masters phd doctorate diploma ged associate associates mba grad graduate undergrad student students class course major minor " +
  "a an the my our your his her their some any this that these those it thing things stuff place places person people home house apartment work office job jobs city town state country area region street road location address nothing something anything everything").split(" "));
const looksLikePlace = (v: string): boolean => {
  const toks = v.split(/[\s,]+/).filter(Boolean);
  if (!toks.length || !toks.some((t) => /^[A-Za-z]/.test(t))) return false;
  if (toks.some((t) => /\d/.test(t))) return false;
  return !toks.every((t) => NOT_PLACE_WORDS.has(t.toLowerCase().replace(/[.']/g, "")));
};
type Form = { kind: "yesno"; yes: Parsed; no: Parsed } | { kind: "free"; parse: (m: string, named: boolean) => Parsed | null };
const FORMS: Record<ScreenFactKey, Form> = {
  sponsorship: { kind: "yesno", yes: { value: "yes", text: "Needs visa sponsorship" }, no: { value: "no", text: "Does not need visa sponsorship" } },
  citizenship: { kind: "yesno", yes: { value: "yes", text: "US citizen" }, no: { value: "no", text: "Not a US citizen" } },
  relocation: { kind: "yesno", yes: { value: "yes", text: "Open to relocating" }, no: { value: "no", text: "Not open to relocating" } },
  location: { kind: "free", parse: (m) => {
    if (/\?/.test(m) || (COMMAND.test(m) && !/\b(live|based|located|reside)\b/i.test(m))) return null;
    if (/^remote[.!]*$/i.test(m)) return { value: "remote", text: "Lives in remote" }; // as the person said it; the screen reads it as no place to match
    if (/\b(want|prefer|looking|seeking|remote|interested|work in)\b/i.test(m)) return null;
    if (OTHER_TOPIC.test(m)) return null; // an answer to another question (sponsorship, visa, citizenship, a degree, years, yes / no) is not a place
    const stripped = placeOf(m).replace(/^(?:i'?m|i am)\s+(?:in|from)\s+/i, "").trim();
    if (!/^[A-Za-z][A-Za-z.' -]*(?:,\s*[A-Za-z][A-Za-z.' -]*)*$/.test(stripped) || stripped.length > 60 || stripped.split(/\s+/).length > 6) return null;
    if (stripped.split(/[\s,]+/).some((w) => /^(?:y|n|ye+s+|ye+a+h*|ye+p+|yu+p+|no+|no+pe+|na+h+)$/i.test(w))) return null; // yes / no in any spelling is not a place
    if (!looksLikePlace(stripped)) return null;
    if (OTHER_TOPIC.test(stripped) || /\b(ok|okay|sure|thanks|thank you|hi|hello|hey|maybe)\b/i.test(stripped) || BAD_PLACE.test(stripped) || stripped.length < 2) return null;
    return { value: stripped, text: `Lives in ${stripped}` };
  } },
  years_experience: { kind: "free", parse: (m) => {
    const w = m.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/g, (x) => String(NUM_WORDS[x])).replace(/[.!]+$/, "").trim();
    const n = /^(?:i have |i've got |i got )?(?:about |around |roughly |almost |nearly |over |just over )?(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?: of (?:professional |work |relevant )?experience)?$/.exec(w);
    if (!n) return null;
    const v = Number(n[1]);
    return v >= 0 && v <= 50 ? { value: v, text: `${v} years of professional experience` } : null;
  } },
  education_level: { kind: "free", parse: (m) => {
    if (/\?/.test(m) || m.length > 80 || /\b(?:yes|yeah|yep|no|nope|sponsor\w*|visa|citizen\w*|need|needs|relocat\w*|years?|yrs?|not|don'?t)\b/i.test(m)) return null;
    const lvl = educationLevelOf(m.replace(/\bexpected\b/gi, "")) ?? (/\b(finishing|finish|expected)\b/i.test(m) ? educationLevelOf(m.replace(/\b(pursuing|expected|finishing|currently)\b/gi, "")) : null);
    return lvl ? { value: lvl, text: `Highest degree: ${lvl.replace("_", " ")}` } : null;
  } },
};
export const YES_NO_FACTS = (Object.keys(FORMS) as ScreenFactKey[]).filter((f) => FORMS[f].kind === "yesno");
export const isYesNoFact = (f: ScreenFactKey) => FORMS[f].kind === "yesno";

// `alone` is true when this question is the only one open; with several open a bare yes / no answers none of them.
export function parseScreenAnswer(fact: ScreenFactKey, raw: string, alone: boolean): Parsed | null {
  const m = clean(raw).replace(/[.!]+$/, "");
  if (!m || m.length > 200) return null;
  const form = FORMS[fact];
  if (form.kind === "yesno") {
    if (!alone) return null;
    const a = yesNoOf(m);
    return a === "yes" ? form.yes : a === "no" ? form.no : null;
  }
  if (UNSURE.test(m)) return null; // an unsure / skipped / empty reply answers nothing
  const named = KEYWORD[fact].test(m);
  if (!alone && !named) return null;
  return form.parse(m, named);
}

// The several questions one message may answer ("Austin, TX; no relocation; I need sponsorship"): clause by clause.
export function parseScreenAnswers(asks: ScreenFactKey[], message: string): { fact: ScreenFactKey; parsed: Parsed }[] {
  if (asks.length === 1) { const p = parseScreenAnswer(asks[0], message, true); return p ? [{ fact: asks[0], parsed: p }] : []; }
  const out: { fact: ScreenFactKey; parsed: Parsed }[] = [];
  const clauses = clean(message).split(/\s*(?:[;\n]|\.\s|,\s*(?=(?:and\s+)?(?:i\b|no\b|yes\b|not\b)))|\s+and\s+(?=i\b|no\b|not\b)/i).filter(Boolean);
  for (const fact of asks) {
    for (const c of clauses) { const p = parseScreenAnswer(fact, c, false); if (p) { out.push({ fact, parsed: p }); break; } }
  }
  return out;
}

// Save the answer as a confirmed profile fact (replacing the earlier answer to the same question).
export interface ProfileLike { facts?: any[] }
export function saveScreenFact(profile: ProfileLike, addFact: (profile: any, input: any) => any, fact: ScreenFactKey, parsed: Parsed, message: string, at: string): any {
  profile.facts = (profile.facts ?? []).filter((f: any) => !(f && f.screen_key === fact));
  const kind = fact === "location" ? "location" : fact === "relocation" ? "preference" : fact === "sponsorship" || fact === "citizenship" ? "eligibility" : "profile";
  return addFact(profile, { kind, text: parsed.text, value: parsed.value, screen_key: fact, source: "screen_answer", evidence: [clean(message).slice(0, 200)], answered_at: at, needs_confirmation: false, status: "confirmed" });
}

export interface ScreenAnswerResult {
  reply: string; status: string; intent: string;
  saved: { fact: ScreenFactKey; value: string | number }[];
  meta?: Record<string, unknown>;
  pending?: undefined; answers?: undefined;
}
export interface ScreenAnswerDeps {
  message: string; now: number;
  last: { intent: string | null; meta: Record<string, any> } | null; // the thread's last assistant reply
  profile: ProfileLike; addFact: (profile: any, input: any) => any;
  // Screen the held postings again with the saved answers and queue those that pass; the caller's apply turn.
  rerun?: (held: HeldPosting[]) => Promise<{ reply: string; status: string; intent: string; screen?: GateResult } | null>;
}
const LABEL: Record<ScreenFactKey, string> = { location: "where you live", relocation: "relocation", sponsorship: "visa sponsorship", citizenship: "citizenship", years_experience: "years of experience", education_level: "your degree" };
export async function screenAnswerTurn(o: ScreenAnswerDeps): Promise<ScreenAnswerResult | null> {
  const asked = ((o.last?.meta?.screen_ask ?? []) as ScreenAsk[]).filter((a) => a && a.fact in FACT_QUESTIONS);
  if (!asked.length) return null;
  const facts = [...new Set(asked.map((a) => a.fact))];
  const msg = clean(o.message);
  const answers = parseScreenAnswers(facts, msg);
  const intent = o.last?.intent ?? "career_apply_queue";
  if (!answers.length) {
    const held0 = (o.last?.meta?.screen_held ?? []) as HeldPosting[];
    // Several questions open (an older reply): put ONE to the person, the first. A bare yes / no answers none of several, and no phrase is
    // taken for an answer, so asking them to "answer them in one message" was a dead end.
    if (facts.length > 1 && (yesNoOf(msg) || UNSURE.test(msg))) {
      return { reply: `One question at a time. ${asked[0].question}`, status: "which", intent, saved: [], meta: askMeta(asked[0], held0, o.last?.meta?.screen_reasked ? { screen_reasked: true } : {}) };
    }
    // A reply that is not an answer (I don't know, skip, a place that is none, a short non-answer) saves NOTHING (D-007). Ask once more;
    // when it was already asked twice, leave the postings held and drop the question: they wait until the person says.
    // So is a reply that answers ANOTHER question, or leads with yes / no and then contradicts itself ("No, I need sponsorship"): nothing is written.
    // A yes/no question takes exactly yes or no: anything else (a sentence, another question's answer, "Austin") that is not a command or
    // a question of its own is a non-answer. Nothing is written; it is asked again once, with "Reply yes or no" and Yes / No buttons.
    const yn = facts.some(isYesNoFact), ynOne = isYesNoFact(asked[0].fact);
    const touches = !/\?/.test(msg) && !COMMAND.test(msg.replace(/\bplease\b/gi, "")) && (yn || /\b(?:sponsor\w*|visa|h-?1b|work permit|citizen\w*|green card|relocat\w*|degree|bachelor\w*|master\w*|ph\.?d)\b/i.test(msg) || !!yesNoOf(msg));
    const nonAnswer = UNSURE.test(msg) || touches || (facts.length === 1 && msg.split(/\s+/).length <= 4 && !COMMAND.test(msg.replace(/\bplease\b/gi, "")) && !/\?/.test(msg));
    if (nonAnswer) {
      if (!o.last?.meta?.screen_reasked) {
        return { reply: `${ynOne ? "Reply yes or no. " : ""}I need a real answer for that, so I haven't saved anything. ${asked[0].question}`, status: "asking", intent, saved: [],
          meta: askMeta(asked[0], held0, { screen_reasked: true }) };
      }
      return { reply: `No problem, I haven't saved an answer and I'll keep ${held0.length === 1 ? "that posting" : "those postings"} on hold. Tell me ${asked.map((a) => LABEL[a.fact]).join(" and ")} whenever you want them screened.`, status: "held", intent, saved: [] };
    }
    return null;
  }
  const at = new Date(o.now).toISOString();
  const saved: { fact: ScreenFactKey; value: string | number }[] = [];
  for (const a of answers) { saveScreenFact(o.profile, o.addFact, a.fact, a.parsed, msg, at); saved.push({ fact: a.fact, value: a.parsed.value }); }
  const said = answers.map((a) => `${LABEL[a.fact]}: ${a.parsed.text.replace(/^Lives in /, "").replace(/^Highest degree: /, "")}`).join("; ");
  const held = (o.last?.meta?.screen_held ?? []) as HeldPosting[];
  const left = asked.filter((a) => !saved.some((s) => s.fact === a.fact));
  const lead = `Saved (${said}). Tell me if that's wrong and I'll change it.`;
  const re = held.length && o.rerun ? await o.rerun(held) : null;
  if (re) {
    const meta = screenMeta(re.screen) ?? undefined;
    return { reply: `${lead} ${re.reply}`.trim(), status: re.status, intent: re.intent, saved, ...(meta ? { meta } : {}) };
  }
  if (left.length) return { reply: `${lead} Next: ${left[0].question}`, status: "asking", intent, saved, meta: askMeta(left[0], held) };
  return { reply: lead, status: "saved", intent, saved };
}

// A tap on a Yes / No button (callback data scr:<qid>:yes|no): an EXPLICIT answer to the one question those buttons were made for.
// It runs ONLY when that question is still the thread's open screen question (same qid, a single yes/no ask); otherwise nothing is
// written and nothing else runs. The caller skips every other yes/no consumer for a tap (the card's "reply to the card", an
// employer question, a link confirmation, Introduce): a button is never a typed "yes" for whichever consumer happens to wait.
export const TAP_STALE_REPLY = "That question is no longer open. Nothing was recorded.";
export const TAP_INTENT = "career_screen_tap";
export const QID = /^[0-9a-f]{8}$/;
export async function screenTapTurn(o: Omit<ScreenAnswerDeps, "message"> & { qid: string; answer: string }): Promise<ScreenAnswerResult> {
  const answer = String(o.answer ?? "").trim().toLowerCase();
  const meta = o.last?.meta ?? {};
  // A stale tap must not become the thread's last word and kill what is open: the notice carries the last reply's meta forward
  // (the open question's screen_ask / screen_qid / screen_held / screen_buttons, or a pending card), keeps its intent, and puts the
  // open question again under the notice so its buttons and typed answers still work.
  const openAsk = Array.isArray(meta.screen_ask) ? (meta.screen_ask as ScreenAsk[])[0] : null;
  const stale: ScreenAnswerResult = {
    reply: openAsk?.question ? `${TAP_STALE_REPLY} ${openAsk.question}` : TAP_STALE_REPLY, status: "stale",
    intent: Object.keys(meta).length && o.last?.intent ? o.last.intent : TAP_INTENT, saved: [],
    ...(Object.keys(meta).length ? { meta: { ...meta } } : {}),
  };
  const ask = Array.isArray(meta.screen_ask) ? meta.screen_ask as ScreenAsk[] : [];
  if ((answer !== "yes" && answer !== "no") || !QID.test(String(o.qid)) || meta.screen_qid !== o.qid || ask.length !== 1 || !(ask[0]?.fact in FACT_QUESTIONS) || !isYesNoFact(ask[0].fact)) return stale;
  return (await screenAnswerTurn({ ...o, message: answer })) ?? stale;
}
