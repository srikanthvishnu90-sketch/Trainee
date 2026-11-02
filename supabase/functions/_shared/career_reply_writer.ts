// V1 TEXTING VOICE (2026-10-27): the one reply writer every chat turn's final reply passes through.
//
// Owner goal: Trainee texts "the same way Claude does" — natural, warm, direct, short, specific to the person's actual
// state, one clear next step, never canned, never an internal code. Voice spec: docs/architect/specs/TEXTING-VOICE-2026-10-27.md.
//
// Where it sits: agent-chat/handler-career.ts, at the final-reply boundary, after every code-first turn, the router, the
// brain and the post-router rewriters have produced today's reply, and before the reply is saved. Nothing upstream changes.
//
//   input:  the verified facts of this turn (TurnFacts: what code said from state this turn, what the turn did — sends,
//           queued applications, writes — and the person's situation read at the top of the turn) + the person's message
//           + the channel;
//   output: the reply.
//
// The model writes (through the gateway, metered, under the person's spend ceiling); code checks. Every number, name,
// company, link, status ("sent", "submitted", "applied", "scheduled" ...) and promise ("I'll ...") in the model's text
// must come from the verified facts (D-007). A text that adds or changes any of them, or breaks the voice rules (canned
// phrases, internal codes, headers, more than one question, longer than today's reply, a link dropped), is rejected and
// the reply falls back to a plain deterministic template built from the same facts: today's reply with its boilerplate,
// catch-all and internal sentences taken out and nothing added.
//
// Off by default (CAREER_REPLY_WRITER=on turns it on): off, today's reply goes out exactly as before. Turns that show an
// exact payload the person approves (a card, an email or outreach draft, an offer counter, a mock question, a structured
// task or batch, a reply in parts) are never rewritten: the words the person approves are the words that are sent.

// ---------------------------------------------------------------------------------------------------------------------
// The flag and which turns are written.

export const replyWriterOn = (env: { get(k: string): string | undefined }) => env.get("CAREER_REPLY_WRITER") === "on";

// Intents whose reply carries an exact payload or a question whose exact words matter. The values are the modules'
// constants (tests/architect/v1-texting-voice.test.ts checks each against its module), written out here so this module
// imports none of them.
export const PAYLOAD_INTENTS: ReadonlySet<string> = new Set([
  "career_apply_card", "career_apply_email", "career_outreach_batch", "career_apply_questions", "career_message_approval",
  "career_followup_card", "career_networking_draft", "career_mock", "career_apply_confirm_which", "career_apply_employer_ask",
  "career_offer_counter", "career_cloud_optin", "career_outreach_signature",
  // router intents that show a draft or a mock question verbatim
  "outreach_draft", "negotiation_draft", "career_tailor", "prep_mock_start", "prep_mock_next", "prep_mock_followup",
]);
// results_file: the reply carries the results page's link, minted by code (role_results.ts); its words and link stay as they are.
const PAYLOAD_META = ["card_id", "email_card", "offer_card", "open_card", "career_approval_card_id", "employer_question", "screen_ask", "results_file"];

export function writable(out: { intent?: string | null; reply?: string; parts?: unknown }, meta: Record<string, unknown> | null, o: { structured: boolean }): boolean {
  if (o.structured) return false;
  if (Array.isArray(out.parts) && out.parts.length) return false;
  if (out.intent && PAYLOAD_INTENTS.has(out.intent)) return false;
  if (meta && PAYLOAD_META.some((k) => meta[k] !== undefined && meta[k] !== null)) return false;
  const text = String(out.reply ?? "");
  if (!text.trim()) return false;
  // A draft shown in any turn (its subject line) is its exact words.
  if (/^\s*Subject:/im.test(text)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The verified facts of one turn.

export type WriterChannel = "web" | "telegram" | "whatsapp" | "imessage" | "sms";
export interface TurnFacts {
  said: string; // today's reply: what code wrote from state this turn (the source the writer may restate, never extend)
  intent: string | null;
  status: string | null;
  effects: { sent: number; queued: number; sendUnknown: number; wrote: boolean };
  // From the situation read at the top of the turn (career_situation.ts), bounded.
  tasks: { company: string | null; title: string | null; state: string }[];
  next: { who: string; what: string; say?: string }[];
}
// deno-lint-ignore no-explicit-any
export function factsForTurn(o: { reply: string; intent?: string | null; resultStatus?: string | null; effects?: { sent?: number; queued?: number; sendUnknown?: number; writes?: { size: number } } | null; situation?: any }): TurnFacts {
  const s = o.situation && typeof o.situation === "object" ? o.situation : null;
  const tasks = Array.isArray(s?.tasks) ? s.tasks.filter((t: any) => t && t.kind !== "question").slice(0, 20)
    .map((t: any) => ({ company: t.company ? String(t.company) : null, title: t.title ? String(t.title) : null, state: String(t.state ?? "") })) : [];
  const next = Array.isArray(s?.next) ? s.next.slice(0, 8).map((n: any) => ({ who: String(n.who ?? ""), what: String(n.what ?? ""), ...(n.say ? { say: String(n.say) } : {}) })) : [];
  const e = o.effects ?? {};
  return {
    said: String(o.reply ?? ""), intent: o.intent ?? null, status: o.resultStatus ?? null,
    effects: { sent: Number(e.sent) || 0, queued: Number(e.queued) || 0, sendUnknown: Number(e.sendUnknown) || 0, wrote: (e.writes?.size ?? 0) > 0 },
    tasks, next,
  };
}

// Everything the facts establish, as sets the check compares against.
interface Ledger { text: string; numbers: Set<string>; links: Set<string>; emails: Set<string>; claims: Set<string>; verbs: string }
function factsText(f: TurnFacts): string {
  return [f.said, ...f.tasks.map((t) => [t.company, t.title, t.state].filter(Boolean).join(" ")), ...f.next.map((n) => `${n.what} ${n.say ?? ""}`)].join("\n");
}
function ledgerOf(f: TurnFacts): Ledger {
  const text = factsText(f);
  const claims = positiveClaims(text);
  if (f.effects.sent > 0) claims.add("sent");
  if (f.effects.queued > 0) claims.add("queued");
  // A task's own state is a fact about it ("sent", "queued", "needs_user" ...).
  for (const t of f.tasks) for (const c of positiveClaims(t.state.replace(/_/g, " "))) claims.add(c);
  return { text: text.toLowerCase(), numbers: numbersIn(text), links: new Set(linksIn(text)), emails: new Set(emailsIn(text)), claims, verbs: text.toLowerCase() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Extractors.

const URL_RX = /https?:\/\/[^\s<>()\]"']+/g;
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
export function linksIn(text: string): string[] { return [...new Set((String(text).match(URL_RX) ?? []).map(trimUrl))]; }
function emailsIn(text: string): string[] { return [...new Set((String(text).replace(URL_RX, " ").match(EMAIL_RX) ?? []).map((e) => e.toLowerCase()))]; }

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, hundred: 100, thousand: 1000, dozen: 12, half: 0.5, twice: 2, double: 2,
};
// Numbers as values ("$85,000", "85k" and "85000" are one number); links and emails are checked on their own.
function numbersIn(text: string): Set<string> {
  const t = String(text).replace(URL_RX, " ").replace(EMAIL_RX, " ");
  const out = new Set<string>();
  for (const m of t.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)(\s?[kK]\b)?/g)) {
    const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (Number.isFinite(n)) out.add(String(n));
  }
  for (const m of t.toLowerCase().matchAll(/\b([a-z]+)\b/g)) if (NUMBER_WORDS[m[1]] !== undefined) out.add(String(NUMBER_WORDS[m[1]]));
  return out;
}

// Clauses: a status word inside a clause with a negation or a condition is not a claim that it happened
// ("nothing was sent", "once you say yes I'll send it", "until you approve").
const NEGATED = /\b(not|no|nothing|never|none|nobody|neither|nor|until|unless|before|if|once|when|whenever|after|without|yet|cannot)\b|n['’]t\b/i;
function clauses(text: string): string[] {
  return String(text).replace(URL_RX, " ").split(/[.!?;:\n,—–]+|\s-\s|\b(?:and|but|so|then)\b/i).map((c) => c.trim()).filter(Boolean);
}
const STATUS: [string, RegExp][] = [
  ["sent", /\b(sent|emailed|delivered|mailed|texted|messaged)\b/i],
  ["submitted", /\b(submitted|filed)\b/i],
  ["applied", /\bapplied\b/i],
  ["approved", /\bapproved\b/i],
  ["queued", /\b(queued|lined up)\b/i],
  ["scheduled", /\b(scheduled|booked|calendared)\b/i],
  ["confirmed", /\bconfirmed\b/i],
  ["connected", /\b(connected|linked)\b/i],
  ["cancelled", /\b(cancell?ed|withdrawn|withdrew)\b/i],
  ["saved", /\b(saved|recorded|added|logged|tracked|updated|stored|noted|set up|on (?:your )?record)\b/i],
  ["prepared", /\b(prepared|filled|tailored|drafted|written|built)\b/i],
  ["found", /\b(found|located)\b/i],
];
function positiveClaims(text: string): Set<string> {
  const out = new Set<string>();
  for (const c of clauses(text)) {
    if (NEGATED.test(c)) continue;
    for (const [k, rx] of STATUS) if (rx.test(c)) out.add(k);
  }
  return out;
}
const PROMISE_RX = /\b(?:i['’]ll|i will|i['’]m going to|i am going to|we['’]ll|we will)\s+(?:also\s+|then\s+|now\s+|just\s+|go ahead and\s+|be sure to\s+)?([a-z]+)/gi;
function promisesIn(text: string): string[] { return [...String(text).matchAll(PROMISE_RX)].map((m) => m[1].toLowerCase()); }
const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, "").slice(0, 5);

// Capitalized words that are not names: sentence starters and the words a texting reply uses, the product's own name and
// its channels. Anything else capitalized must be in the facts.
const COMMON = new Set(`i i'm i've i'll i'd im ive ill id ok okay yes yeah yep no nope sure got done here there this that these those
the a an and but or so if when what which who whom whose why how where your you you're youre my me we our it it's its they them their
he she his her want tell text reply say send paste name ask try check let show give pick keep share start stop pause add set see sorry
thanks thank nice great good cool hey hi hello hmm ah oh one all any some each every nothing none nobody everything something
anything still also just only now then next first last today tomorrow tonight yesterday soon later morning afternoon evening
monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thurs fri sat sun january february march april may
june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec am pm est cst pst et ct pt utc
trainee telegram whatsapp imessage sms not don't can't won't didn't isn't aren't wasn't haven't hasn't couldn't shouldn't wouldn't
looks seems sounds found nope noted saved added recorded updated heads quick quickly happy glad sad tough rough honestly
also plus btw fyi re which's who's what's that's there's here's let's it'd we're they're got gotcha right well alright all-right
want need would could should will can might must maybe probably mostly usually often never always again already yet
before after during while because since though although unless until once per via with without within from into onto about above
below over under between among around across along up down out off on in at to for of by as than like near`.split(/\s+/).filter(Boolean));

// Words that may follow "at", "from", "with" (or "to" after a send or apply verb) without being a name.
const AFTER_PREP = new Set(`the a an your my this that these those it them him her you me us all any some one each every least most
first last once home work school night noon midnight least best worst least scale random large once length least
hand heart length speed least zero no nothing anything something everything nobody anyone someone everyone their our his its
which what who whom whose how where when why there here then now`.split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------------------------------------------------------------
// The checks.

// Every number, name, company, link, address, status and promise in `text` must come from the facts. Returns the
// violations in plain words (for logs and the turn's meta); empty means the text adds or changes nothing.
export function factCheck(text: string, f: TurnFacts): string[] {
  const L = ledgerOf(f), out: string[] = [];
  for (const n of numbersIn(text)) if (!L.numbers.has(n)) out.push(`number ${n} is not in the facts`);
  for (const u of linksIn(text)) if (!L.links.has(u)) out.push(`link ${u} is not in the facts`);
  for (const e of emailsIn(text)) if (!L.emails.has(e)) out.push(`address ${e} is not in the facts`);
  const plain = String(text).replace(URL_RX, " ").replace(EMAIL_RX, " ");
  const known = (w: string) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(L.text);
  for (const m of plain.matchAll(/(?<![A-Za-z0-9'’])[A-Z][A-Za-z0-9&'’.-]*[A-Za-z0-9]|(?<![A-Za-z0-9'’])[A-Z](?![A-Za-z0-9])/g)) {
    const w = m[0].replace(/['’]s$/, "").replace(/\.+$/, "");
    if (!w || /^\d/.test(w)) continue;
    if (COMMON.has(w.toLowerCase()) || known(w)) continue;
    out.push(`name "${w}" is not in the facts`);
  }
  for (const m of plain.matchAll(/\b(?:at|from|with)\s+([a-z][a-z0-9&-]*)|\b(?:sent|send|applied|apply|emailed|email|submitted|wrote|write|reached out|reach out|introduced?(?: you)?)\s+(?:it\s+|them\s+|this\s+)?to\s+([a-z][a-z0-9&-]*)/g)) {
    const w = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!w || AFTER_PREP.has(w) || COMMON.has(w) || known(w)) continue;
    out.push(`"${w}" after "${m[0].split(/\s+/)[0]}" reads as a name that is not in the facts`);
  }
  for (const c of positiveClaims(text)) if (!L.claims.has(c)) out.push(`says "${c}" but the facts do not`);
  const factStems = new Set((L.verbs.match(/[a-z]+/g) ?? []).map(stem));
  for (const v of promisesIn(text)) if (!factStems.has(stem(v))) out.push(`promises "${v}" but the facts do not`);
  return [...new Set(out)];
}

// The voice rules a written reply must keep (docs/architect/specs/TEXTING-VOICE-2026-10-27.md). Returns what it breaks.
const CANNED: RegExp[] = [
  /\bgreat question\b/i, /\bgood question\b/i, /\bi['’]?m just an ai\b/i, /\bas an ai\b/i, /\bi am an ai\b/i, /\blanguage model\b/i,
  /\bhappy to help\b/i, /\bi hope this helps\b/i, /\bfeel free to\b/i, /\bdon['’]t hesitate\b/i, /\blet me know if you have any (other |more )?questions\b/i,
  /^\s*(certainly|absolutely|of course)!/im, /\bi understand your (concern|frustration)\b/i, /\bi apologi[sz]e for any (confusion|inconvenience)\b/i,
  /\bi did not catch (what to do with )?that\b/i, /\bi didn['’]t catch that\b/i, /\bwhat i can['’]t do from this handler\b/i,
  /\byour words are the evidence\b/i, /\bit['’]s important to note\b/i, /\bin today['’]s (competitive )?job market\b/i,
];
const INTERNAL: RegExp[] = [
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, /\b([a-z]+) \1s\b/i,
  /\b(from this handler|in this handler|board adapter|served board list|wiring exists|in this run|request key|owned conversation|career context|browser worker|payload|router|snapshot|containment|turn key|thread state|career_[a-z_]+|MI-\d+)\b/i,
];
export function cannedIn(text: string): string[] { return CANNED.filter((r) => r.test(text)).map((r) => r.source); }
export function internalIn(text: string): string[] { return INTERNAL.map((r) => String(text).match(r)?.[0]).filter((x): x is string => !!x); }

export function voiceCheck(text: string, f: TurnFacts): string[] {
  const out: string[] = [];
  const t = String(text ?? "").trim();
  if (!t) return ["empty"];
  for (const c of cannedIn(t)) out.push(`canned phrase /${c}/`);
  for (const j of internalIn(t)) out.push(`internal word "${j}"`);
  if (/^\s{0,3}#{1,6}\s/m.test(t)) out.push("a header in a text");
  if ((t.replace(URL_RX, " ").match(/\?/g) ?? []).length > 1) out.push("more than one question");
  if (/^\s*\(?\d+\s*\/\s*\d+\)\s|\(\d+\s*\/\s*\d+\)\s*$/m.test(t)) out.push("a part counter");
  const room = Math.max(280, f.said.trim().length);
  if (t.length > room) out.push(`longer than today's reply (${t.length} > ${room})`);
  for (const u of linksIn(f.said)) if (!t.includes(u)) out.push(`drops the link ${u}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The deterministic template: today's reply, sentence by sentence, with the boilerplate and the internal sentences taken
// out and nothing added. Only sentences of `said` survive, so it can state nothing the facts do not; a sentence that says
// nothing was sent or submitted is always kept.

const BOILER: RegExp[] = [
  ...CANNED,
  /\bnothing about you is assumed\b/i, /\bthese facts are what your searches\b/i, /\bstages here are spoken only from this record\b/i,
  /\bno role will be invented to fill it\b/i, /\bgrounded in your own\b/i, /\btell me what you['’]d like to do next\b/i,
  /\beverything from this conversation so far stands\b/i, /\bthe re-run is honest\b/i, /\bis spoken only from the record\b/i,
  /\bnever from a template with the name swapped\b/i, /\bthat loop is the prep\b/i, /\bread back from the tracker before i answered\b/i,
  /\bthe event is real the moment you report it\b/i, /\bthe honest status is\b/i,
];
const SAFETY = /\b(nothing|not|never|no)\b[^.?!\n]*\b(sent|submitted|send|submit|approved|emailed|filled)\b/i;
function sentencesOf(line: string): string[] {
  // Split after . ! ? (not inside a link or a number like 2.5), keeping the punctuation with its sentence.
  const parts: string[] = [];
  let buf = "";
  const tokens = line.split(/(\s+)/);
  for (const tok of tokens) {
    buf += tok;
    if (/[.!?]["”’)]*$/.test(tok) && !/^https?:\/\//.test(tok) && !/^\d+\.$/.test(tok)) { parts.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}
export function templateReply(f: TurnFacts): string {
  const said = String(f.said ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!said) return said;
  const lines = said.split("\n").map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, "").trimEnd());
  const kept: string[][] = lines.map((l) => (l.trim() ? sentencesOf(l) : []));
  // Drop boilerplate (unless it carries a number or says nothing was sent) and every sentence with an internal word.
  for (const ss of kept) {
    for (let i = ss.length - 1; i >= 0; i--) {
      const s = ss[i], safety = SAFETY.test(s);
      const canned = CANNED.some((r) => r.test(s)), boiler = BOILER.some((r) => r.test(s)) && !/\d/.test(s);
      if (internalIn(s).length || ((canned || boiler) && !safety)) ss.splice(i, 1);
    }
  }
  // At most one question: the last one, the next step.
  const qs: [number, number][] = [];
  kept.forEach((ss, li) => ss.forEach((s, si) => { if (/\?["”’)]*$/.test(s)) qs.push([li, si]); }));
  for (const [li, si] of qs.slice(0, -1).reverse()) kept[li].splice(si, 1);
  const out = kept.map((ss) => ss.join(" ")).filter((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || said;
}

// ---------------------------------------------------------------------------------------------------------------------
// The model's request.

export const VOICE_RULES = [
  "You are Trainee, a career agent, texting one person about their job search. Rewrite REPLY in Trainee's voice: how a capable friend who happens to be great at job searching texts — natural, warm, direct, short.",
  "Facts: use ONLY what REPLY and SITUATION say. Every number, name, company, link, email address, status (sent, submitted, applied, queued, scheduled, confirmed, connected) and promise (\"I'll ...\") in your text must appear there, exactly. Never say something was sent, submitted or applied unless REPLY says it was. Never add a fact, an estimate or an example.",
  "Shape: the first line answers or says what happened. Then only what they need. End with one clear next step. At most one question. Keep every link from REPLY, each on its own line.",
  "Voice: lowercase-friendly but correct; plain words; mirror their register (casual if they are casual, careful if they are upset); use their words for things. If something went wrong or Trainee made a mistake, say so plainly in one line. No \"Great question\", no \"As an AI\", no \"I hope this helps\", no headers, no internal codes or system words, no part counters.",
  "Never longer than REPLY. Write only the text to send.",
].join("\n");
const FORMAT: Record<WriterChannel, string> = {
  sms: "Channel: SMS. Plain text only, no markdown at all.",
  imessage: "Channel: iMessage. Plain text only, no markdown at all.",
  whatsapp: "Channel: WhatsApp. Plain text; *bold* at most once if it truly helps.",
  telegram: "Channel: Telegram. Plain text; **bold** at most once if it truly helps. Shape: one short paragraph that answers first; keep what REPLY says is published or confirmed apart from what it says is unknown or not verified, and say plainly when something could not be verified; never turn a gap into a guess. Leave each link on its own line (the channel sends links as separate preview messages) and add none.",
  web: "Channel: the web chat. Plain text; **bold** at most once if it truly helps.",
};
export function writerPayload(f: TurnFacts, message: string, channel: WriterChannel): Record<string, unknown> {
  const situation = [
    ...f.tasks.map((t) => `- ${[t.company, t.title].filter(Boolean).join(", ") || "a task"}: ${t.state.replace(/_/g, " ")}`),
    ...f.next.filter((n) => n.who === "person").map((n) => `- waiting on them: ${n.what}${n.say ? ` (they text "${n.say}")` : ""}`),
  ].join("\n");
  const did = [f.effects.sent ? `${f.effects.sent} email(s) sent this turn` : "", f.effects.queued ? `${f.effects.queued} application(s) queued this turn` : ""].filter(Boolean).join("; ");
  return {
    system: `${VOICE_RULES}\n${FORMAT[channel] ?? FORMAT.web}`,
    messages: [{ role: "user", content: `THEY SAID:\n${String(message ?? "").slice(0, 1500)}\n\nREPLY (what Trainee's code wrote from their account this turn):\n${f.said.slice(0, 6000)}\n\nSITUATION:\n${situation || "- nothing else in flight"}${did ? `\n\nTHIS TURN DID: ${did}` : ""}` }],
    max_tokens: 400, temperature: 0.4,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The writer.

// deno-lint-ignore no-explicit-any
export type ModelFn = (payload: any) => Promise<any>;
export interface Written { text: string; source: "off" | "model" | "template"; rejected: string[] }
// deno-lint-ignore no-explicit-any
const textOf = (msg: any) => Array.isArray(msg?.content) ? msg.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : typeof msg?.content === "string" ? msg.content : "";

export async function writeReply(o: { on: boolean; facts: TurnFacts; message: string; channel?: WriterChannel; model: ModelFn | null }): Promise<Written> {
  if (!o.on) return { text: o.facts.said, source: "off", rejected: [] };
  const template = templateReply(o.facts);
  if (!o.model) return { text: template, source: "template", rejected: ["no model"] };
  let text = "";
  try {
    text = textOf(await o.model(writerPayload(o.facts, o.message, o.channel ?? "web"))).trim().replace(/^["“](.*)["”]$/s, "$1").trim();
  } catch (e) {
    return { text: template, source: "template", rejected: [`model unavailable: ${(e as Error)?.message ?? String(e)}`.slice(0, 160)] };
  }
  const rejected = [...factCheck(text, o.facts), ...voiceCheck(text, o.facts)];
  if (rejected.length) return { text: template, source: "template", rejected };
  return { text, source: "model", rejected: [] };
}

export function writerChannel(raw: unknown): WriterChannel {
  return raw === "telegram" || raw === "whatsapp" || raw === "imessage" || raw === "sms" ? raw : "web";
}
