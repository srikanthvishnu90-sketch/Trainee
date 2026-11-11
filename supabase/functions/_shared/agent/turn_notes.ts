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
const PERSONA = /\b(?:say|suppose|imagine|pretend|assume|let'?s say|what if|if)\s+(?:that\s+)?i(?:'m| am| was| were)\s+(?:a|an|just a|someone|somebody|in)\b|\bpretend (?:to be|you'?re talking to)\b|\bif i were (?:a|an|someone)\b/;
const SITUATION = /\bhypothetical(?:ly)?\b|\b(?:say|suppose|imagine|let'?s say|what if)\s+(?:that\s+)?i\s+(?:had|have|got|get|was offered|were offered)\b/;
export type Hypothetical = "persona" | "situation";
export function hypotheticalOf(message: string): Hypothetical | null {
  const t = lc(message);
  if (!t || t.length > 600) return null;
  return PERSONA.test(t) ? "persona" : SITUATION.test(t) ? "situation" : null;
}
// A hypothetical writes nothing to their record, and a hypothetical person reads nothing from it.
export const HYPOTHETICAL_WITHHELD: readonly string[] = ["add_profile_fact", "correct_profile_fact", "confirm_profile_fact", "remember_instruction", "forget_instruction",
  "track_application", "read_resume", "save_resume_persona", "use_resume_persona", "set_resume_contact"];
export const PERSONA_WITHHELD: readonly string[] = [...HYPOTHETICAL_WITHHELD, "get_profile", "get_memory", "recall", "where_do_i_stand", "list_applications", "get_situation"];
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
export function replyKind(message: string): ReplyKind {
  const t = lc(message);
  if (EVERYTHING.test(t)) return "everything";
  if (QUESTION_ASK.test(t)) return "question";
  if (DRAFT.test(t)) return "draft";
  if (RECALL.test(t) && /\?\s*$/.test(t) && t.length <= 140) return "recall";
  return "answer";
}
export const REPLY_LENGTH: Record<ReplyKind, { max: number; aim: string }> = {
  draft: { max: 550, aim: "the draft itself, about 150 to 360 characters (a casual one, or one they asked to make shorter, under about 200), then one short line that it is theirs to send and nothing was sent" },
  question: { max: 360, aim: "the question and one line on how to answer it, about 200 to 300 characters" },
  recall: { max: 280, aim: "one or two sentences, about 100 to 200 characters: the answer and where it came from, with its link alone on the next line if there is one" },
  everything: { max: 1400, aim: "about 900 to 1,200 characters; for research, the answer first and then each source link alone on its own line" },
  answer: { max: 600, aim: "one short paragraph of plain sentences, about 300 to 500 characters" },
};
export function replyLength(message: string): { kind: ReplyKind; max: number; aim: string } {
  const kind = replyKind(message);
  const base = REPLY_LENGTH[kind];
  return kind === "draft" && SHORTER.test(lc(message)) ? { kind, max: 400, aim: "the draft itself under about 200 characters, then one short line that it is theirs to send and nothing was sent" } : { kind, ...base };
}
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
