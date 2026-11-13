// MIRROR WA-1 gaps (2026-11-11, the owner's Instinct WhatsApp benchmark, evals/mirror/instinct-wa-batch1/): what code reads
// from the message and the conversation before the brain answers, handed to it as instructions and data for this one turn.
// Pure. Nothing here writes a reply: each piece is an instruction or a fact for the model, which writes every word.
//   hypotheticalOf  "say i'm a new grad with zero internships" (C15) is a hypothetical person; "hypothetically if i had two
//                   offers" (C7) a hypothetical situation. Either way the turn answers the hypothetical and saves nothing; a
//                   hypothetical person is answered without their saved facts at all (they are left out of the prompt).
//   roastOf         "ask me 'tell me about a time you failed' and then roast my answer" (C21), then the answer (C21f): the
//                   answer is critiqued bluntly on what it says, never turned into a fill-in template.
//   replyLength     the length Instinct's replies had for each kind of ask (instinct.jsonl): drafts short, a practice question
//                   short, a recall one line, everything else one paragraph, long only for "everything" or research.
//   postingRefOf    "that paypal internship" (C10, C11, C18, C20) is the posting this conversation already listed: named with
//                   its job id and link, so the brain uses it instead of asking for it again.
type Msg = { role: string; content: unknown };
const norm = (s: unknown) => String(s ?? "").replace(/[‘’`]/g, "'").replace(/\s+/g, " ").trim();
const lc = (s: unknown) => norm(s).toLowerCase();

// ------------------------------------------------------------------------------------------------ hypotheticals
// D-061 G8 (hypotheticals never touch the record): the reading is by the grammar of a hypothetical, in any of the languages the
// product answers in, never by a benchmark prompt's wording (P3). A person: "say i'm / say im / if i were a ...", someone else
// ("my friend is ...", "asking for a friend", "what would you tell a <someone> ...", "if someone had ..."). A situation:
// "hypothetically", "imagine", "suppose", "what if i ...", "if i had / got / moved / switched ...", "not real", and the same
// markers in Spanish, Portuguese, French, German, Hinglish, Mandarin, Vietnamese and Korean.
const PERSONA = /\b(?:say|suppose|imagine|pretend|assume|let'?s say|what if|if)\s+(?:that\s+)?i(?:'m|m| am| was| were)\s+(?:a|an|just a|someone|somebody|in)\b|\bpretend (?:to be|you'?re talking to)\b|\bif i were (?:a|an|someone)\b/;
const OTHER_PERSON = /\b(?:my|a)\s+(?:friend|roommate|cousin|sister|brother|classmate|buddy|sibling|teammate)\s+(?:is|has|had|wants|was|got|who|with)\b|\b(?:asking|for)\s+a\s+friend\b|\b(?:what\s+would\s+you\s+(?:tell|say\s+to|advise|recommend\s+(?:to|for))|how\s+would\s+you\s+advise)\s+(?:a|an|someone|somebody)\b|\bif\s+(?:someone|somebody|a\s+(?:person|student|candidate))\s+(?:had|has|was|were|with|who)\b|\b(?:someone|somebody)\s+with\s+(?:a|an|no|zero|\d)/;
const SITUATION = /\bhypothetical(?:ly)?\b|\b(?:say|suppose|imagine|let'?s say|what if)\s+(?:that\s+)?i\s+(?:had|have|got|get|was offered|were offered)\b|\b(?:imagine|supposing|in theory|theoretically)\b|\bwhat if i\b|\bif i (?:had|got|were|was|switched|moved|only|took|picked|chose)\b|\bnot real\b/;
const FOREIGN_HYPO = /(?:^|[^\p{L}])(?:hipot[eé]tic[ao]mente|hipot[eé]tic[oa]|hypoth[eé]tiquement|hypoth[eé]tique|hypothetisch|angenommen|supongamos|suponha|imagina|imaginons|giả sử|giả định|maan lo|maano)(?:$|[^\p{L}])|假设|假如|가정|만약/u;
export type Hypothetical = "persona" | "situation";
export function hypotheticalOf(message: string): Hypothetical | null {
  const t = lc(message);
  if (!t || t.length > 600) return null;
  return PERSONA.test(t) || OTHER_PERSON.test(t) ? "persona" : SITUATION.test(t) || FOREIGN_HYPO.test(t) ? "situation" : null;
}
// A hypothetical writes nothing to their record, and a hypothetical person reads nothing from it.
export const HYPOTHETICAL_WITHHELD: readonly string[] = ["add_profile_fact", "correct_profile_fact", "confirm_profile_fact", "remember_instruction", "forget_instruction",
  "track_application", "read_resume", "save_resume_persona", "use_resume_persona", "set_resume_contact",
  // D-062: a hypothetical never makes a tracker page or an email card.
  "export_tracker", "draft_email_reply"];
export const PERSONA_WITHHELD: readonly string[] = [...HYPOTHETICAL_WITHHELD, "get_profile", "get_memory", "recall", "where_do_i_stand", "list_applications", "get_situation", "read_application_mail", "find_email"];
export function hypotheticalNote(kind: Hypothetical): string {
  return kind === "persona"
    ? "THIS MESSAGE IS A HYPOTHETICAL PERSON (code read it from their words): they asked how you would advise someone in the situation they describe, not about themselves. " +
      "Answer for that person exactly as described, starting from the situation (\"In that situation, ...\"): concrete steps for that profile, how to tell what is working, what to change when it is not. " +
      "Their saved facts and goal are left out of this turn on purpose. Do not use, compare with or mention anything from their own resume, profile or earlier messages about themselves, " +
      "do not say their real situation is different, and save, correct or record nothing from this message."
    : "THIS MESSAGE IS A HYPOTHETICAL (code read it from their words): answer the situation as stated (the trade-offs that decide it, and which way you would lean and why), " +
      "and record nothing from it: no fact, offer, goal or application is saved, corrected or tracked this turn.";
}

// ------------------------------------------------------------------------------------------------ the roast
const ROAST = /\b(?:roast|tear (?:it|this|that|my answer|me) apart|rip (?:it|this|my answer) apart|be (?:brutal|blunt|harsh|savage|ruthless|brutally honest)|(?:critique|grade|judge|rate) (?:my|the) answer|don'?t (?:hold back|go easy))\b/;
const ASK_VERB = /^(?:can you |could you |please |pls |now |ok(?:ay)? |also )*(?:find|search|show|list|draft|write|make|apply|send|give|tell me|what|how|why|when|where|who|which|is|are|do|does|can|could|should|would|will)\b/;
// The answer to a practice question they asked to have roasted, within their last three messages: the question as it was asked
// (the assistant's reply to that ask), or null.
export function roastOf(message: string, history: Msg[]): { question: string } | null {
  const t = lc(message);
  if (t.length < 25 || /\?\s*$/.test(t) || ASK_VERB.test(t)) return null;
  const h = (history ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  const users = h.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user");
  for (const { m, i } of users.slice(-3).reverse()) {
    if (!ROAST.test(lc(m.content))) continue;
    const q = h.slice(i + 1).find((x) => x.role === "assistant");
    if (!q) return null;
    return { question: norm(q.content).slice(0, 400) };
  }
  return null;
}
export function roastNote(r: { question: string }): string {
  return `THEY ARE ANSWERING THE PRACTICE QUESTION THEY ASKED YOU TO ROAST (code read it from this conversation). You asked: ${JSON.stringify(r.question)}. ` +
    "Critique the answer in their message itself, bluntly and briefly (one paragraph, about 300 to 450 characters): say what it is right now (for example a summary of events, not an interview answer), " +
    "then name what is missing from what they actually said: what they personally got wrong (ownership, not what someone else disliked), what it cost, and the specific step they changed afterward. " +
    "Tell them to rebuild it from what actually happened. Never write a fill-in template, a model answer with [brackets], a rubric score or invented details, and do not ask to save or confirm anything.";
}

// ------------------------------------------------------------------------------------------------ the length of a text
// Instinct's replies on the benchmark, by kind (characters of text, links apart): drafts 109 to 361 (178 for "way shorter"),
// practice questions 241 and 262, grading an answer 312 to 412, recalls 130 and 135, advice 385 to 568, "everything you remember"
// 1,240, research 410 to 1,141 in several messages with their links.
export type ReplyKind = "draft" | "question" | "recall" | "everything" | "answer";
const DRAFT = /\b(?:draft|write|rewrite|redo|make|shorten|tighten)\b[^.?!]{0,60}\b(?:message|email|e-mail|note|dm|text|reply|letter|intro(?:duction)?|follow[- ]?up|thank[- ]you|ask|draft|it|that|one)\b|\b(?:cold|referral|outreach|follow[- ]?up|thank[- ]you)\s+(?:message|email|note|dm|draft)\b|\b(?:shorter|less formal|more casual)\b/;
const SHORTER = /\b(?:shorter|way short|less formal|more casual|keep it (?:casual|short|brief)|brief(?:er)?|one[- ]liner)\b/;
const QUESTION_ASK = /\b(?:quiz|drill)\s+me\b|\bask me\b[^.?!]{0,80}\b(?:question|about a time)\b|\b(?:mock|behavioral|technical|coding)\s+(?:round|question|interview)\b[^.?!]{0,40}\bask\b/;
const RECALL = /\b(?:from earlier|earlier,|again\b|remind me|what (?:was|did you say)|you (?:said|told me|mentioned))\b/;
const EVERYTHING = /\b(?:everything|all you (?:know|remember)|like everything|full (?:list|picture|breakdown)|real sources|in detail)\b|,[^,]+,[^,]+\b(?:and|&)\b/;
// D-072 (item 11): `history` (optional) is this conversation: inside a practice session, an answer to the question Trainee asked is
// reviewed in one paragraph (the "answer" kind) whatever its words look like (a three-step approach read as "everything", "i'd
// make a map ..." read as a draft), and an ask for the next question ("ok next", "another, harder") is the question kind.
export function replyKind(message: string, history?: Msg[]): ReplyKind {
  const t = lc(message);
  if (history && (practiceAnswerOf(message, history) || roastOf(message, history))) return "answer";
  if (history && practiceNextOf(message, history)) return "question";
  if (EVERYTHING.test(t)) return "everything";
  if (QUESTION_ASK.test(t) || practiceAskOf(t)) return "question"; // D-070: a practice question said any way
  if (DRAFT.test(t)) return "draft";
  if (RECALL.test(t) && /\?\s*$/.test(t) && t.length <= 140) return "recall";
  return "answer";
}
// `upper`: the top of Instinct's range for the kind (G3); a reply over it by more than 10% (overLimit) gets one shortening pass in
// code (career_brain.ts). `max`: the old ceiling the turn note and the condenser's acceptance used before D-065.
export const REPLY_LENGTH: Record<ReplyKind, { max: number; upper: number; aim: string }> = {
  draft: { max: 550, upper: 360, aim: "the draft itself, about 150 to 360 characters (a casual one, or one they asked to make shorter, under about 200), then one short line that it is theirs to send and nothing was sent" },
  question: { max: 360, upper: 300, aim: "the question and one line on how to answer it, about 200 to 300 characters" },
  recall: { max: 280, upper: 200, aim: "one or two sentences, about 100 to 200 characters: the answer and where it came from, with its link alone on the next line if there is one" },
  everything: { max: 1400, upper: 1200, aim: "about 900 to 1,200 characters; for research, the answer first and then each source link alone on its own line" },
  answer: { max: 600, upper: 500, aim: "one short paragraph of plain sentences, about 300 to 500 characters" },
};
export function replyLength(message: string, history?: Msg[]): { kind: ReplyKind; max: number; upper: number; aim: string } {
  const kind = replyKind(message, history);
  const base = REPLY_LENGTH[kind];
  return kind === "draft" && SHORTER.test(lc(message)) ? { kind, max: 400, upper: 200, aim: "the draft itself under about 200 characters, then one short line that it is theirs to send and nothing was sent" } : { kind, ...base };
}
// D-065 (G3, live round 1: 18 of 19 measured replies over Instinct's length, median 507 against 396): the length a reply is
// measured at (characters of text, links apart, as instinct.jsonl is counted), and the bound past which code shortens it once:
// more than 10% over the kind's upper end.
export const textLength = (s: unknown): number => String(s ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().length;
export const overLimit = (l: { upper: number }): number => Math.round(l.upper * 1.1);
// An ask that itself asks for length ("a detailed plan", "in detail", "the whole plan") is a long deliverable the channel lays out
// in parts: its length is the person's, never the shortener's.
const DETAIL = /\b(?:detailed|in detail|in depth|in-depth|whole plan|full plan|step[- ]by[- ]step|long version)\b/;
export const asksForDetail = (message: string): boolean => DETAIL.test(lc(message));
export function lengthNote(l: { kind: ReplyKind; aim: string }): string {
  return `LENGTH OF THIS REPLY (a text message): ${l.aim}. Keep every fact, caveat and statement of what was not sent, submitted or verified; cut repetition, lists and advice they did not ask for.`;
}

// ------------------------------------------------------------------------------------------------ "that paypal internship"
export interface Listed { id?: string | null; title?: string | null; company?: string | null; location?: string | null; url?: string | null }
const REF = /\b(?:that|the|this|those|for)\s+(?:\w+\s+){0,3}?(?:internship|intern|posting|role|job|position|application|opening|resume|one)s?\b/;
const companyKey = (s: unknown) => lc(s).replace(/\b(?:inc|llc|ltd|corp|corporation|co|company|holdings|group|plc)\b\.?/g, " ").replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
// The listed posting(s) the message names by employer, from what this conversation showed (the thread's last list, then any
// posting link in an earlier reply). Only a message that refers back to a posting ("that X internship", "the X application").
export function postingRefOf(message: string, listed: Listed[] | null | undefined, history: Msg[] = []): Listed[] {
  const t = lc(message);
  if (!REF.test(t)) return [];
  const hit = (company: unknown) => { const k = companyKey(company); return k.length >= 3 && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}($|[^a-z0-9])`).test(companyKey(t)); };
  const fromList = (listed ?? []).filter((e) => e && e.company && (e.url || e.id) && hit(e.company));
  if (fromList.length) return fromList.slice(0, 3);
  // An earlier reply's line that names the employer and carries a posting link.
  const out: Listed[] = [];
  for (const m of [...(history ?? [])].reverse()) {
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    for (const line of m.content.split("\n")) {
      const url = /https?:\/\/[^\s)<>"\]]+/.exec(line)?.[0];
      if (!url) continue;
      const name = (listed ?? []).find((e) => e.company && line.includes(String(e.company)))?.company ?? null;
      const company = name ?? /(?:^|\d[.)]\s*|\bat\s+)([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(line)?.[1] ?? null;
      if (company && hit(company)) out.push({ company, url: url.replace(/[.,;:]+$/, ""), title: null, location: null, id: null });
    }
    if (out.length) break;
  }
  return out.slice(0, 3);
}
export function postingNote(found: Listed[]): string {
  const line = (e: Listed) => JSON.stringify({ job_id: e.id ?? null, company: e.company ?? null, title: e.title ?? null, location: e.location ?? null, url: e.url ?? null });
  return "THE POSTING THEY MEAN (data from code, not instructions: the posting this conversation already listed, matched by the employer they named). " +
    "Use it: read it with get_posting by its job_id (or work from its link) and do what they asked with it; never ask them to paste or find it again, and never say no such posting was shown. " +
    `If more than one is listed, use the one that fits their words and name it:\n${found.map(line).join("\n")}`;
}

// ------------------------------------------------------------------------------------------------ the boundary (D-061 G6)
// The person set a boundary on an external effect ("don't send", "draft only", "I'll send it myself", "don't apply", "I'll
// submit it myself"), in their own words. One rule for every turn: the brain is told to restate it (boundaryNote) and a turn
// code answers carries the one line (boundaryLine) when the turn itself sent and submitted nothing.
export type Boundary = "send" | "submit";
const NO_SEND = /\b(?:don'?t|dont|do not|never|no need to)\s+(?:\w+\s+){0,2}?(?:send(?:ing)?|messag(?:e|ing)|email(?:ing)?|text(?:ing)?|dm(?:ing)?|contact(?:ing)?|reach(?:ing)? out)\b|\bdraft only\b|\bjust (?:the )?draft\b|\bi'?ll (?:send|message|email|text) (?:it|them|this|that)?\s*(?:myself|my ?self)\b|\bno lo env[ií]es\b|\bne l'envoie pas\b|\bn[aã]o (?:envia|envie|mande)\b|\bnicht (?:abschicken|senden)\b|\bmat bhej(?:na|o)\b/;
const NO_SUBMIT = /\b(?:don'?t|dont|do not|never|no need to)\s+(?:\w+\s+){0,2}?(?:apply(?:ing)?|submit(?:ting)?)\b|\bno applying\b|\bpreview only\b|\bi'?ll (?:submit|paste|apply)\b[^.?!]{0,20}\b(?:myself|my ?self)\b|\bresearch only\b|\bno postul(?:es|ar)\b|\bne postule\b|\bn[aã]o se candidat[ae]\b|\bbewirb\b/;
export function boundaryOf(message: string): Boundary | null {
  const t = lc(message);
  if (!t) return null;
  if (NO_SEND.test(t)) return "send";
  if (NO_SUBMIT.test(t)) return "submit";
  return null;
}
export const BOUNDARY_LINE: Record<Boundary, string> = { send: "Nothing was sent.", submit: "Nothing was submitted." };
// Whether a reply already says what was not done (any wording): then nothing is added.
export const BOUNDARY_SAID = /\b(?:nothing|not|never|haven'?t|hasn'?t|didn'?t|wasn'?t|isn'?t|won'?t|no one|nobody)\b[^.!?\n]{0,60}\b(?:sent|submitted|applied|queued|contacted|messaged|emailed)\b|\b(?:sent|submitted|applied)\b[^.!?\n]{0,20}\b(?:nothing|nowhere)\b/i;
export function boundaryNote(b: Boundary): string {
  return `THE PERSON SET A BOUNDARY (code read it from their words): do not ${b === "send" ? "send, message or contact anyone" : "apply to or submit anything"} this turn. ` +
    `Do the work they asked for, then end the reply with one plain line saying so, in their language (for example "${BOUNDARY_LINE[b]}"). That line is true: nothing in this turn can ${b === "send" ? "send" : "submit"}.`;
}

// ------------------------------------------------------------------------------------------------ a correction (D-061 G9)
// The person says Trainee got something wrong earlier ("you said X but ...", "earlier you told me ...", "that's wrong"), or
// corrects their own fact ("actually I ..."). The reply names what changed, out loud.
// D-061 G9, wider: "are you sure", "double-check that", "that doesn't match", "I see / a recruiter told me ... but / instead".
const SAYS_WRONG = /\b(?:you (?:said|told me|wrote|listed|gave|mentioned|claimed)|earlier you|before you said|that'?s (?:wrong|not right|incorrect|off)|that was (?:wrong|incorrect)|you got (?:it|that) wrong|you were wrong|which (?:one )?is right|correct (?:that|it|yourself)|are you sure|double[- ]?check (?:that|it|this)|that (?:doesn'?t|does not) (?:match|sound right|seem right|add up))\b|\b(?:i (?:see|saw|read|heard)|(?:a|my|the) (?:recruiter|friend|classmate|mentor|professor|posting|website|site) (?:told me|says|said|shows|lists))\b[^.?!]{0,80}\b(?:but|instead|not|actually|different|which)\b/;
const OWN_FIX = /^(?:actually|wait|correction|sorry)[,:]?\s+(?:i|my)\b|\b(?:i meant|i misspoke|scratch that)\b/;
export type Correction = "trainee" | "person";
export function correctionOf(message: string): Correction | null {
  const t = lc(message);
  return SAYS_WRONG.test(t) ? "trainee" : OWN_FIX.test(t) ? "person" : null;
}
export function correctionNote(c: Correction): string {
  return c === "trainee"
    ? "THEY SAY SOMETHING YOU SAID EARLIER IS WRONG (code read it from their words). Check it against this conversation and what you can read now. If it was wrong, say so out loud in the first sentence, naming what you said before and what is right now (\"I said X earlier; that was wrong, it is Y\"); if you cannot verify either, say which one you cannot verify and why. Never repeat the old claim as if it stood."
    : "THEY ARE CORRECTING THEIR OWN FACT (code read it from their words): use the corrected fact from now on and say in one short clause what changed. Do not keep using the old one.";
}

// ------------------------------------------------------------------------------------------------ several asks (D-061 G13)
export function multiAskNote(): string {
  return "THIS MESSAGE MAKES SEVERAL ASKS (code read it from their words): answer each one, in the order asked, each with its own answer; asks that share one deliverable may share it, and then say it covers both. Do not answer only the first.";
}
// D-064 (G13, Instinct C1 + C3): a message the person sent while their previous turn was still running.
export function whileWorkingNote(previous: string): string {
  return "THIS MESSAGE ARRIVED WHILE YOU WERE STILL WORKING ON THEIR PREVIOUS ONE (code read it from the turn order): " + JSON.stringify(String(previous ?? "").slice(0, 400)) + ". " +
    "Your reply to that one is above in this conversation. Answer this message now. If the two asks are related, answer them as one deliverable and say plainly that it covers both; if not, answer this one on its own. Do not repeat the earlier reply.";
}

// ------------------------------------------------------------------------------------------------ D-065 (live round 1)
// Each reader below is by grammar or by the kind of thing asked, never by a benchmark prompt's wording (P3). Each one is a turn
// note (an instruction to the model) and, where the ruling says code checks it, a check the brain's draft reply is held to once
// (career_brain.ts processCheck, loop.ts `process`).

// G3 / G4 (C9): the parts a research or advice ask names ("culture pay interview process"): each must be answered, from a source
// or said to be not found. `covered` is what a reply that answers the part says.
const PARTS: { part: string; ask: RegExp; covered: RegExp }[] = [
  { part: "pay", ask: /\b(?:pay|paid|comp|compensation|salar(?:y|ies)|wages?|hourly|bonus(?:es)?|tc|total comp|going rate|stipend)\b/, covered: /\b(?:pay|paid|comp|compensation|salar(?:y|ies)|wages?|hourly|bonus(?:es)?|stipend|base)\b|\$\s?\d|\b\d+k\b/i },
  { part: "interview process", ask: /\binterview(?:s|ing)?\b|\b(?:hiring|recruiting|application|interview) process\b|\bprocess\b|\b(?:interview )?rounds?\b|\btimeline\b/, covered: /\binterview|\brounds?\b|\bprocess\b|\bassessment\b|\bonsite\b|\bsuperday\b|\btimeline\b/i },
  { part: "culture", ask: /\bculture\b|\bwork[- ]?life(?: balance)?\b|\bwlb\b|\bhours\b|\bvibes?\b|\b(?:work )?environment\b/, covered: /\bculture\b|\bwork[- ]?life\b|\bwlb\b|\bhours\b|\bpressure\b|\benvironment\b|\bvibes?\b|\bburn ?out\b|\bturnover\b/i },
  { part: "benefits", ask: /\bbenefits?\b|\bperks?\b/, covered: /\bbenefits?\b|\bperks?\b|\binsurance\b|\b401\(?k\)?\b/i },
  { part: "return offers", ask: /\breturn offers?\b|\bconversion(?: rate)?\b|\bfull[- ]time offers?\b/, covered: /\breturn offers?\b|\bconver(?:sion|t)\b|\bfull[- ]time offers?\b/i },
  { part: "visa sponsorship", ask: /\bvisa\b|\bsponsor(?:ship|s)?\b|\bh-?1b\b|\bopt\b/, covered: /\bvisa\b|\bsponsor|\bh-?1b\b|\bopt\b/i },
  { part: "locations", ask: /\blocations?\b|\boffices?\b|\bremote policy\b|\bwhere (?:they|it|the team) (?:hire|is|are|sit)\b/, covered: /\blocations?\b|\boffices?\b|\bremote\b|\bhybrid\b|\bin[- ]person\b|\blists? [A-Z]/i },
];
// The parts, in the order asked, when the message names two or more (one named part is just the question).
export function askedPartsOf(message: string): string[] {
  const t = lc(message);
  if (!t || t.length > 600) return [];
  const hits = PARTS.map((p) => ({ part: p.part, at: t.search(p.ask) })).filter((p) => p.at >= 0).sort((a, b) => a.at - b.at).map((p) => p.part);
  return hits.length >= 2 ? hits : [];
}
export function partsMissing(reply: string, parts: string[]): string[] {
  const r = String(reply ?? "");
  return parts.filter((p) => !(PARTS.find((x) => x.part === p)?.covered.test(r) ?? true));
}
export function partsNote(parts: string[]): string {
  return `THEY ASKED ABOUT THESE PARTS (code read them from their words): ${parts.join(", ")}. Cover every one, in the order asked, each in its own short part with its source; ` +
    "where nothing you read this turn covers a part, say so in that part in one plain sentence. Never skip a part and never fill one with a guess.";
}

// G10 / D-059 (C2, C13, C14): an ask to write or rework a message (a note, email, DM, text, intro, follow-up, thank-you), or to
// change a draft already shown. The draft tool is its one path: code checks the draft and shows its text as the reply.
const DRAFT_NOUN = "(?:message|email|e-mail|note|dm|text|reply|letter|intro(?:duction)?|follow[- ]?up|thank[- ]you|inmail|outreach)s?";
const DRAFT_WRITE = new RegExp(`\\b(?:draft|write|compose|rewrite|redo|re-?draft|reword|type up)\\b(?:\\s+[\\w'\\[\\]-]+){0,6}?\\s+${DRAFT_NOUN}\\b`);
const DRAFT_REVISE = /\b(?:that|the|this|my|your|last)\s+(?:[\w-]+\s+){0,2}?(?:draft|message|email|note|dm)\b[^?]{0,80}\b(?:shorter|longer|less formal|more formal|casual|warmer|friendlier|tighter|shorten|tighten|rewrite|redo|reword|change|tweak|edit|make it)\b/;
const NOT_A_MESSAGE = /\b(?:cover letter|resume|cv|essay|personal statement|bio|linkedin (?:summary|headline|about)|answer to|tell me about yourself)\b/;
export function draftAskOf(message: string): boolean {
  const t = lc(message);
  if (!t || t.length > 800 || NOT_A_MESSAGE.test(t)) return false;
  return DRAFT_WRITE.test(t) || DRAFT_REVISE.test(t);
}
export const DRAFT_TOOLS: readonly string[] = ["draft_followup", "draft_outreach", "draft_email_reply"];
export function draftNote(aim: string): string {
  return "THIS IS A DRAFT ASK (code read it from their words): write the message with draft_followup (draft_outreach for people on their outreach list, draft_email_reply to answer an email they received); " +
    "code checks it and shows its text exactly as your reply, so never write the draft in your own reply. With no recipient named, keep placeholders like [Name]. " +
    `A change to a draft already shown is a new draft_followup call with the changed text. Its length: ${aim}.`;
}

// C1 (MIRROR-PROCESS C1): a plan ask aimed at postings to apply to ("what should I be doing to land a SWE internship", or that plus
// "find me 5 internships I could apply to" sent while it ran) searches first: the plan is written around what search_jobs found.
const PLAN_ASK = /\bwhat should i (?:actually |really |even )?(?:be )?(?:do|doing|focus on)\b|\b(?:a|my|the|weekly|week[- ]by[- ]week)\s+(?:plan|roadmap|strategy|game ?plan)\b|\block in\b|\bwhere (?:do|should) i (?:start|begin)\b|\bnext steps\b/;
const POSTINGS_ASK = /\b(?:land|get|find|apply(?:ing)? (?:to|for)|(?:could|can) (?:actually )?apply to|to apply to)\b(?:\s+[\w-]+){0,5}?\s+(?:internships?|jobs?|roles?|positions?|openings?|postings?)\b/;
export function planSearchAskOf(message: string, previous: string | null = null): boolean {
  const both = [lc(message), lc(previous)].filter(Boolean);
  if (!both.length || both.some((t) => /\binterview/.test(t) && !POSTINGS_ASK.test(t))) return false;
  return both.some((t) => PLAN_ASK.test(t)) && both.some((t) => POSTINGS_ASK.test(t));
}
export function planSearchNote(): string {
  return "THEY ASKED WHAT TO DO TO LAND POSTINGS THEY COULD APPLY TO (code read it from their words): call search_jobs first, with their goal (role, level and places from their confirmed record or this message), " +
    "then write the plan around the postings it returned, each as the search checked it, and say how many it found (fewer than they wanted included). If it found none, say so and what it covered, then the plan.";
}

// G5 (C12): "could you realistically apply to 50 internships for me in one night?" A volume or pace of work Trainee has not
// verified on this account is never affirmed.
const CAPACITY = /\b(?:could|can|would|will|are) you\b[^?.!]{0,60}?\b(?:\d{2,}|dozens?|hundreds?|fifty|forty|thirty|twenty|a hundred|all of them|every one)\b[^?.!]{0,60}\b(?:in (?:one|a|an|1) (?:night|day|hour|week|weekend|go|sitting)|overnight|tonight|today|at once|per (?:day|night|hour)|a (?:day|night))\b|\brealistically\b[^?.!]{0,40}\b(?:apply|send|message|email|submit|reach out)\b[^?.!]{0,40}\b\d{2,}\b/;
export function capacityAskOf(message: string): boolean {
  const t = lc(message);
  return !!t && t.length <= 600 && CAPACITY.test(t);
}
export function capacityNote(): string {
  return "THEY ASK WHETHER YOU CAN DO A VOLUME OR PACE OF WORK (code read it from their words). That pace has not been verified on their account: never affirm it (no \"yes\", \"technically yes\", \"sure\", \"easily\"). " +
    "Say in your first sentence that you haven't verified that pace and would not promise it, then what it would actually take, and a smaller first batch they approve one by one. (G5)";
}

// G1 / D-007 (C1: add_profile_fact twice on a plain question): what a message states about the person. A question or a request
// states nothing; only a clause with the person as its subject ("I'm a junior", "my GPA is 3.7") does. `asking` is true when the
// message asks anything; `stated` is the text of its first-person statements ("" when there are none).
const ASK_START = /^(?:(?:so|ok(?:ay)?|and|but|also|like|hey|yo|um+|uh+|actually|wait|please|pls|now|then)[,]?\s+)*(?:what|what's|whats|how|how's|why|when|where|which|who|whom|whose|should|shall|can|could|would|will|do|does|did|is|are|am|was|were|have|has|any|anything|find|search|show|list|draft|write|make|give|tell|help|quiz|ask|explain|compare|set up|look|check|send|apply|research|build|create|prep|prepare|walk me|let me know)\b/;
const FIRST_PERSON = /\b(?:i|i'm|im|i've|ive|i'd|my|me|mine)\b/;
export function statementsOf(message: string): { asking: boolean; stated: string } {
  const t = norm(message);
  const clauses: { text: string; ask: boolean }[] = [];
  for (const s of t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) {
    // A question mark marks the sentence's last clause; an earlier clause asks only when it starts like a question or request
    // ("I'm a junior at Lakeshore, what internships fit?" states one thing and asks one).
    const parts = s.split(/,\s+|;\s+|\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
    parts.forEach((c, k) => clauses.push({ text: c, ask: (k === parts.length - 1 && /\?\s*$/.test(s)) || ASK_START.test(c.toLowerCase()) }));
  }
  const asking = clauses.some((c) => c.ask);
  const stated = clauses.filter((c) => !c.ask && FIRST_PERSON.test(c.text.toLowerCase())).map((c) => c.text).join(". ");
  return { asking, stated };
}
// A clause about something to do now ("I need to lock in", "I have to finish my resume") is a task, not a standing rule.
export const TODO_CLAUSE = /\bi\s+(?:really\s+)?(?:(?:need|have|got|want|should|must)\s+to|gotta|wanna|gonna)\s+(?!be\b|have\b|work\b|stay\b|keep\b|live\b|avoid\b|get paid\b)[a-z]+/;

// ------------------------------------------------------------------------------------------------ D-067 (live round 2)
// G1/D-007 (C1): a question or request that states nothing about the person (or only a task for now, "I need to lock in") gives a
// record write nothing to draw on, so add_profile_fact is not offered on that turn at all (D-065 refused it; now it is not tried).
export function statesNothing(message: string): boolean {
  const s = statementsOf(message);
  if (!s.asking) return false;
  return s.stated.split(/\.\s+/).map((c) => c.trim()).filter(Boolean).every((c) => TODO_CLAUSE.test(c.toLowerCase()));
}
// G14 (C6: "have i applied to anything yet?" answered "nothing on record" without reading Gmail): an ask about their own
// application history reads the record that holds it (read_application_mail) before it is answered.
const HISTORY_ASK = /\b(?:have|did|had)\s+i\s+(?:already\s+|even\s+|ever\s+)?(?:applied|apply|sent|submitted)\b|\bwhat\s+(?:have|did)\s+i\s+(?:already\s+)?(?:apply|applied|submit(?:ted)?)\b|\bwhere\s+(?:have|did)\s+i\s+(?:already\s+)?(?:apply|applied)\b|\b(?:my|the)\s+applications?\s+(?:so\s+far|history|status|tracker)\b|\b(?:keep|keeping)\s+track\s+of\s+(?:my\s+)?(?:applications?|what\s+i\s+applied)\b|\bhow\s+many\s+(?:applications|places|jobs|roles)\s+(?:have|did)\s+i\b/;
export function historyAskOf(message: string): boolean { return HISTORY_ASK.test(lc(message)); }
export function historyNote(): string {
  return "THEY ASKED ABOUT THEIR OWN APPLICATIONS (code read it from their words): call read_application_mail first and answer from what it returns " +
    "(their Gmail confirmations, Trainee's own submissions and what they told you), saying what it covered; never answer \"nothing on record\" without it.";
}
// G7 (C22: PayPal's Chicago pay was read in C11 and the going-rate answer gave no figure): a pay ask is answered with the pay this
// conversation already showed, from where it came, alongside any research. Code lists those lines from Trainee's own earlier replies.
const PAY_ASK = /\b(?:pay|pays|paid|salary|salaries|comp|compensation|hourly|per hour|an hour|rate|wage|wages|stipend)\b/;
const PAY_FIGURE = /\$\s?\d[\d,.]*(?:\s?[kK])?(?:\s*(?:-|–|—|to)\s*\$?\s?\d[\d,.]*(?:\s?[kK])?)?/;
export function shownPayOf(message: string, history: Msg[]): { text: string; url: string | null }[] {
  if (!PAY_ASK.test(lc(message))) return [];
  const out: { text: string; url: string | null }[] = [];
  for (const m of history ?? []) {
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    // Each paragraph with the link it carries (a posting's or a source's, on its own line after it), else the message's first link.
    const first = /https?:\/\/[^\s)<>"\]]+/.exec(m.content)?.[0] ?? null;
    for (const para of m.content.split(/\n\s*\n/)) {
      const url = /https?:\/\/[^\s)<>"\]]+/.exec(para)?.[0] ?? first;
      for (const s of para.replace(/https?:\/\/\S+/g, " ").split(/(?<=[.!?])\s+|\n+/)) {
        const t = s.trim();
        if (PAY_FIGURE.test(t) && PAY_ASK.test(t.toLowerCase()) && t.length <= 300 && !out.some((x) => x.text === t)) out.push({ text: t, url });
      }
    }
  }
  return out.slice(-4);
}
// D-073 (live-9 C9: "the PayPal SWE internship posting you saw earlier, listed at $28-$49 hourly" went out with the link and no
// place): each shown pay line with the place its paragraph named ("Chicago, IL", or remote), read from that earlier reply.
const US_STATES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";
// D-073 review (item 1): a place is "City, ST" only when ST is a US state or territory code ("Software Engineer Intern, US" and
// "Summer Analyst, HR" are not places), and the paragraph's place for a figure is the one beside that figure: the nearest one on the
// figure's own line, else the paragraph's only one. Two places in the paragraph and none on the figure's line: no place is taken.
const STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR";
const PLACE_SRC = `\\b((?:[A-Z][A-Za-z.'-]+\\s){0,2}[A-Z][A-Za-z.'-]+),\\s(?:(?:${STATE_CODES})(?![A-Za-z])|(?:${US_STATES})\\b)`;
const PLACE_IN = new RegExp(PLACE_SRC);
// One place and nothing else: "Chicago, IL" (a city and a US state), never a list, a note or a count beside it.
export const isOnePlace = (s: string) => new RegExp(`^${PLACE_SRC}$`).test(String(s ?? "").trim());
function placesIn(text: string): { place: string; at: number }[] {
  return [...text.matchAll(new RegExp(PLACE_SRC, "g"))].map((m) => ({ place: m[0], at: m.index ?? 0 }));
}
export function placeBeside(para: string, figure: string): string | null {
  const flat = para.replace(/https?:\/\/\S+/g, " ");
  const all = [...new Set(placesIn(flat).map((x) => x.place))];
  const line = flat.split("\n").find((x) => figure && x.includes(figure)) ?? "";
  const at = line.indexOf(figure) + Math.max(0, figure.search(/\$\s?\d/)), onLine = placesIn(line);
  if (onLine.length) return onLine.sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0].place;
  if (all.length !== 1) return null;
  // 2026-11-13 (review of #801: "Stripe SWE Intern, Chicago, IL: no pay listed." then "PayPal SWE Intern: pay is $28-$49 hourly."
  // gave PayPal's pay Stripe's city): the paragraph's one place, on another line, is the figure's only when the figure's own line
  // names no one that the place's line does not (any capitalised or all-capitals word that is not a common first word).
  const placed = (flat.split("\n").find((x) => x.includes(all[0])) ?? "").toLowerCase();
  const names = (line.match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}'&.-]*/gu) ?? []).filter((w) => !LINE_STARTER.test(w));
  return names.every((w) => placed.includes(w.toLowerCase().replace(/[.']+$/, ""))) ? all[0] : null;
}
const LINE_STARTER = /^(?:The|A|An|For|In|At|On|It|Its|That|This|Their|There|Here|Pay|Base|Hourly|Salary|Compensation|Posted|Listed|Stated|Range|Annual|USD|US)$/;
export function shownPayPlaces(message: string, history: Msg[]): { text: string; url: string | null; place: string | null }[] {
  const lines = shownPayOf(message, history);
  const paras = (history ?? []).filter((m) => m?.role === "assistant" && typeof m.content === "string").flatMap((m) => (m.content as string).split(/\n\s*\n/));
  return lines.map((l) => {
    const para = paras.find((x) => x.replace(/https?:\/\/\S+/g, " ").includes(l.text)) ?? "";
    // 2026-11-13 (review of #801; a missing place is acceptable, a wrong one is not). No city is taken when the line speaks of the
    // person ("Since you live in Madison, Wisconsin, ... pay is $40 hourly" is not Madison's pay), or when its paragraph says the
    // role is remote (the head office named beside a remote role is not where its pay applies).
    if (/\b(?:you|your|you['’]re|my|our)\b/i.test(l.text)) return { ...l, place: null };
    if (/\bremote\b/i.test(para) || /\bremote\b/i.test(l.text)) return { ...l, place: /\bremote\b/i.test(l.text) && !PLACE_IN.test(l.text) ? "remote" : null };
    const own = PLACE_IN.exec(l.text)?.[0] ?? null, near = own ? null : placeBeside(para, l.text);
    return { ...l, place: own ?? near };
  });
}
export function shownPayNote(lines: { text: string; url: string | null }[]): string {
  return "PAY THIS CONVERSATION ALREADY SHOWED (data from code: your own earlier replies, each from the posting or source it named). Where one answers this ask, use it, " +
    "with its place and naming where it came from, before or alongside any research; never say you have no figure when one of these answers it. Write no link: code puts each one's source link after your reply:\n" +
    lines.map((l) => `- ${l.text}${l.url ? ` (source: ${l.url})` : ""}`).join("\n");
}

// ------------------------------------------------------------------------------------------------ D-070 (live-7)
// G9 / D-007 (live-7 setup: "the 3.9 gpa on there is outdated, don't reuse it" was answered as an internship search and the GPA
// stayed confirmed, so C1 and C8 said it could still be used): a sentence that says one of the person's own stored facts is
// out of date or must not be used again is a correction of a stored fact. Read by grammar (a staleness or do-not-use phrase in
// the same sentence as what it names), never by a benchmark's wording (P3). Uncertainty ("might conflict", "not 100% sure") is
// not a withdrawal.
const STALE = /\b(?:outdated|out[- ]of[- ]date|no longer (?:true|accurate|current|right|valid|correct)|not (?:current|accurate|right|valid) any ?more|isn'?t (?:current|accurate|right) any ?more|(?:don'?t|do not|never|stop|please don'?t) (?:re-?use|use|using|put|include|list|show)\b(?: (?:it|that|this|them))?|is (?:old|stale|wrong) now)\b/;
const sentencesOf = (t: string) => t.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
export function staleFactSaid(message: string): boolean { return sentencesOf(lc(message)).some((s) => STALE.test(s)); }
export interface StoredFact { id?: unknown; kind?: unknown; text?: unknown; title?: unknown; status?: unknown; needs_confirmation?: unknown }
// The confirmed facts a stale sentence names: by the label before its colon ("GPA: 3.9" -> "gpa"), or by a figure it carries
// ("3.9"), said in that same sentence.
export function staleFactsOf(message: string, facts: StoredFact[] | null | undefined): StoredFact[] {
  const ss = sentencesOf(lc(message)).filter((s) => STALE.test(s));
  if (!ss.length) return [];
  const out: StoredFact[] = [];
  for (const f of facts ?? []) {
    if (!f || f.status === "draft" || f.needs_confirmation === true) continue;
    const t = lc(f.title || f.text);
    if (!t) continue;
    const label = /^([a-z][a-z .'-]{1,30}):/.exec(t)?.[1]?.trim() ?? null;
    const figs = (t.match(/\d+(?:\.\d+)?/g) ?? []).filter((x) => x.includes(".") || x.length >= 3);
    const named = (s: string) => (label && new RegExp(`(?<![a-z])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(s)) || figs.some((x) => new RegExp(`(?<![\\d.])${x.replace(/\./g, "\\.")}(?![\\d])`).test(s));
    if (ss.some(named)) out.push(f);
  }
  return out;
}
export function staleFactNote(lines: string[]): string {
  return "THEY SAID A FACT ON THEIR RECORD IS OUT OF DATE (code read it from their words, and code has already set it aside: it is no longer used for anything, and stays off every resume, answer and form until they give a current one): " +
    lines.map((l) => JSON.stringify(l)).join(", ") + ". Say so in one short clause (for example that it is off their record and won't be used), never call it still on file or still usable, and answer the rest of their message.";
}

// G2 / G3 / G12 (practice item 11: practice questions ran 300 to 500 characters and reviews opened with something other than the
// verdict): an ask for one practice or interview question, said any way ("mock interview time: one SQL question", "give me a real
// swe interview question on graphs, just one", "harder one, same topic"), is a practice question; a message answering the
// question Trainee just asked in a practice session is a practice answer, reviewed verdict first.
const PRACTICE_ASK = /\b(?:quiz|drill)\s+me\b|\bask me\b[^.?!]{0,80}\b(?:question|about a time)\b|\b(?:mock|practice|behavioral|technical|coding|real)\s+(?:interview\s+)?(?:round|question|interview)\b|\b(?:one|a|an|another)\s+(?:\w+\s+){0,3}(?:interview|practice)\s+question\b|\binterview\s+time\b|\b(?:harder|tougher)\s+(?:one|question|follow[- ]?up)\b/;
export function practiceAskOf(message: string): boolean { return PRACTICE_ASK.test(lc(message)); }
export function practiceAnswerOf(message: string, history: Msg[]): boolean {
  const t = lc(message);
  if (!t || practiceAskOf(t)) return false;
  const h = (history ?? []).filter((m) => m && typeof m.content === "string");
  const lastA = [...h].reverse().find((m) => m.role === "assistant"), lastU = [...h].reverse().find((m) => m.role === "user");
  if (!lastA || !lastU) return false;
  const before = h.slice(0, h.lastIndexOf(lastU));
  // A new ask inside the session ("ok next", "harder one") is not an answer.
  if (practiceNextOf(message, h)) return false;
  // The question Trainee asked in answer to a practice ask (or the follow-up in a review it gave), still waiting; a message that
  // itself asks something ("have i applied to anything yet?") is a new ask, not the answer. D-072 (dev HO-0859.t2: "i'd draw the
  // free body diagram, sum forces and moments to zero, solve for the reactions — thoughts?"): a closing check-in on the answer
  // itself ("thoughts?", "right?", "is that correct?") asks for the verdict, and a "?" inside code (a ternary) is code.
  if (/\?/.test(stripCheckIn(t)) && !CODE_LIKE.test(String(message ?? ""))) return false;
  // D-072: Trainee's last reply waits for this answer when it ends on a question or on an instruction to answer ("Now write it.",
  // "Walk me through your approach first."), not only on a "?".
  const waiting = /\?\s*$/.test(norm(lastA.content).replace(/https?:\/\/\S+/g, "").trim()) || INVITES_ANSWER.test(lastSentence(lastA.content));
  return practiceAskIn(String(lastU.content), before) || (waiting && practiceAnswerOf(String(lastU.content), before));
}
// D-072 (item 11): a closing check-in that asks only for the verdict on what came before it.
const CHECK_IN = /(?:^|[\s,.;:\u2014\u2013-])(?:thoughts|right|correct|make sense|does (?:that|this) (?:work|make sense|sound right)|is (?:that|this|it) (?:right|correct|ok|okay|good|fine|enough|it)|how(?:'d| did) i do|how'?s (?:that|this)|sound (?:right|good|ok)|good|ok|okay|am i (?:right|close|on track|missing (?:something|anything))|what (?:am i|did i) miss(?:ing)?|anything (?:i'?m )?missing)\s*\?+\s*$/;
const stripCheckIn = (t: string) => t.replace(CHECK_IN, "").trim();
// Code a person pastes as their answer (a "?" in it is a ternary or a pattern, not a question to Trainee).
const CODE_LIKE = /```|\bdef\s+\w+\s*\(|\bfunction\b\s*\w*\s*\(|=>|\breturn\b[^.\n]*[([{=;]|[;{}]\s*$|\bselect\b[^.?!]{0,80}\bfrom\b/im;
const lastSentence = (s: unknown) => { const x = norm(s).replace(/https?:\/\/\S+/g, "").trim().split(/(?<=[.!?])\s+/); return x[x.length - 1] ?? ""; };
const INVITES_ANSWER = /^(?:(?:now|ok(?:ay)?|so|then|next|first|go ahead and|your turn[:,]?)\s+)*(?:write|code|implement|walk me through|talk me through|tell me|give me|show me|explain|solve|answer|try|take|sketch|go)\b|\byour (?:turn|answer|approach)\b|\bwhen you'?re ready\b|\bi'?ll (?:score|grade|review|critique|roast|push)\b/i;
// D-072 (item 11, Q-harder): inside a practice session (a practice ask among their last three messages), a short ask for the next
// question ("ok next", "another, harder", "one more like that", "follow-up please") is a practice question, however it is said.
const PRACTICE_NEXT = /^(?:(?:ok(?:ay)?|cool|nice|great|thanks|thank you|got it|alright|sure|yes|yep|k|now)[,.!]*\s+)*(?:(?:give me|hit me with|ask me|send me|try|do|let'?s do|let'?s go|can i get|can you (?:give me|ask me))\s+)?(?:(?:an?|one)\s+)?(?:another|next|one more|new (?:one|question)|different (?:one|question)|follow[- ]?up|harder|tougher|trickier|more difficult|level (?:it )?up|step it up)\b/;
const NEXT_WORD = /\b(?:another|next (?:one|question|round)|one more|harder|tougher|trickier|more difficult|follow[- ]?up (?:question|one)|level (?:it )?up|step it up)\b/;
const ANSWER_VOICE = /\b(?:i'?d|i would|i'?ll|i will|i think|i used|i'm using|my (?:answer|approach|take|code|solution))\b/;
export function practiceNextOf(message: string, history: Msg[]): boolean {
  const t = lc(message);
  if (!t || t.length > 140 || CODE_LIKE.test(String(message ?? ""))) return false;
  // Said first ("ok next", "another, harder"), or anywhere in a short message that is not itself an answer (no "i'd", "my approach").
  if (!PRACTICE_NEXT.test(t) && !(t.length <= 100 && NEXT_WORD.test(t) && !ANSWER_VOICE.test(t))) return false;
  const users = (history ?? []).filter((m) => m && m.role === "user" && typeof m.content === "string").slice(-3);
  return users.some((m) => practiceAskOf(String(m.content)));
}
// A practice ask said in its own words, or the next one inside a session.
export function practiceAskIn(message: string, history: Msg[]): boolean { return practiceAskOf(message) || practiceNextOf(message, history); }
export function practiceAnswerNote(): string {
  return "THEY ARE ANSWERING THE PRACTICE QUESTION YOU ASKED (code read it from this conversation). Your FIRST sentence is your verdict on their answer: right, partly right or wrong, the one main reason, and what it is a verdict on, named in their own terms (their approach, their code, their story), never a bare verdict with no subject. " +
    "Then the single most important fix, concretely. Then at most one follow-up question, at the end. One short paragraph, about 300 to 500 characters: no headings, no numbered list, no code block, no model answer unless they asked for one.";
}
