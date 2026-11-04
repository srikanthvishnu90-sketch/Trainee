// REQS DOC 1 (conversation and trust, 2026-10-31): the plain questions a person asks about Trainee itself, answered by
// code before the router, from what is true: what Trainee is, what happens to their own information, what it can see
// and holds for them, and that a personal legal, tax or medical question belongs with a professional. Each one fell to
// the router's "I may have missed what you meant" banner on trunk (or worse: a tax question about a bonus got the
// negotiation script, and "am I talking to a real person" got "that is not on your record").
//
//   identity       "are you a bot?", "am I talking to a real person?": Trainee is an AI career agent, not a person.
//   privacy_sell   "do you sell my data?", "who can see my messages?": only what the privacy policy says
//                  (docs/launch/legal-pages/privacy.template.html; tests/architect/trust-turn.test.ts derives the list of
//                  services from the policy text and checks every claim there).
//   privacy_store  "what do you keep about me?": the categories the policy names, then what is actually saved for this
//                  person right now (deps.stored), and what "forget everything" really erases (career_host.js erase,
//                  handler-career.ts tailored resumes, career_erase_messages for the chat messages).
//   access         "can you see my other apps / my email?": every connection on the person's account (deps.connections,
//                  user_oauth_connections), plus what Trainee holds for them; a read that failed is said, never guessed.
//   referral       a personal legal, tax or medical question: a professional's call, never a confident guess. A job search
//                  in those fields, work authorization, an offer or negotiation question, and distress are left alone.
//   ack            a whole-message thanks or laugh: one short word back, nothing changed (meta.ack lets a channel show it
//                  as a reaction instead). Never "ok", "yes", "cool" or a thumbs-up: those can answer a card.
//
// Every kind but ack answers only when the whole message is that question: a message that also asks for something else
// ("is my data safe? find me jobs") goes on to the router, so the rest is never dropped. No model, no send, no write.
import type { Connection } from "./career_capabilities.ts";
import { CareerSafety } from "./router_core.career.js";

export type TrustKind = "safety" | "identity" | "privacy_sell" | "privacy_store" | "access" | "referral" | "ack";
export const TRUST_INTENTS: Record<TrustKind, string> = {
  safety: "safety_support", identity: "career_identity", privacy_sell: "career_privacy", privacy_store: "career_privacy",
  access: "career_account_access", referral: "career_out_of_domain", ack: "conversation_ack",
};
// rest: the person's other ask in the same message (a referral answered first); the caller runs it on, never drops it.
export interface TrustAnswer { kind: TrustKind; intent: string; reply: string; status: "completed"; meta?: Record<string, unknown>; rest?: string }
// What Trainee holds for this person right now; null in a field: that record could not be read.
export interface StoredRecord { resume: boolean | null; facts: number | null; tracker: number | null; applications: number | null }
export interface TrustDeps {
  connections: () => Promise<Connection[] | null>; // every user_oauth_connections row; null: unreadable
  stored: () => Promise<StoredRecord | null>;
}

// The services that process a person's information for Trainee, as the privacy policy lists them ("Service providers
// that run Trainee for us"); the test reads the policy and requires this list to match it, name for name.
export const POLICY_SERVICES = ["Supabase", "OpenAI", "Vercel", "Telegram", "LoopMessage", "Meta"] as const;
// What "forget everything" erases: the host's erase (profile and active context, watches, and it pauses career work;
// career_host.js), the handler's tailored-resume removal, and every chat message in every thread of theirs
// (career_erase_messages, migration 20261031080000): Trainee's records only. Copies a channel already delivered stay in
// the person's own Telegram, iMessage or WhatsApp app, which Trainee cannot delete, so no answer says "every channel".
export const ERASE_SENTENCE = "Say \"forget everything\" to erase your saved profile, confirmed facts, tracker, job watches, tailored resumes and our chat messages from Trainee's records (copies already delivered stay in your messaging app). It also pauses career work.";

const norm = (m: string) => String(m ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const LEAD = String.raw`^(?:(?:hey|hi|hello|so|wait|ok|okay|lol|honestly|real quick|quick question|be honest|serious question|also)[\s,!.:]+)*`;
const END = String.raw`[?.!]*$`;
const MAX_CHARS = 300; // a longer text carries more than one of these questions: the router reads it

// Distress is answered first, before every other check and at any length, with the crisis answer the router's own safety
// screen gives (125 respondToRequest; the test holds the two equal). The detector is the ONE shared list,
// CareerSafety.isDistress (packages/domain/139-career-safety.js, where its policy is written): the router's first check
// and 125's screen read the same one, so no path catches what another misses (#354 safety follow-up, 2026-11-01).
export const isDistress = (message: string): boolean => (CareerSafety as { isDistress: (t: string) => boolean }).isDistress(message);
// #354 re-review 2: a gentle check-in, never alarm words (a false alarm costs one kind message): 988, the text line, 911
// only for danger right now, and a way back to what they asked (the router resumes it on "i'm fine": 142 resumeAfterCheckin).
export const SAFETY_REPLY = "I want to check in, because what you wrote sounded really heavy. If you're thinking about hurting yourself, you can call or text 988 any time (US), or text HOME to 741741, and if you're in danger right now, call 911. I'm here and glad to keep talking. If I read that wrong, just tell me and we'll pick up where you left off.";
const JOB_WORDS = /\b(jobs?|roles?|positions?|internships?|openings?|postings?|hiring|careers?|apply|applying|applications?|interviews?|resume)\b/;
const WORK_AUTH = /\b(authori[sz]ed|authori[sz]ation|sponsor\w*|visas?|opt|cpt|h-?1b|work permit|green card|citizen\w*)\b/;
// An offer or a negotiation is career advice the router gives (negotiation, offer benchmark), never a lawyer's question.
const OFFER_WORDS = /\b(offers?|negotiat\w*|counter\w*|salary|raise|more money|comp|compensation|signing bonus|equity|pay bump)\b/;

const rx = (body: string) => new RegExp(LEAD + body + END);
const IDENTITY = [
  rx(String.raw`(?:are|r) (?:you|u) (?:a |an |actually |even |really |just |like )*(?:real |actual )?(?:bot|robot|ai|a\.i\.?|human|person|real person|real|machine|chatbot|chat ?gpt|gpt|computer|program|automated)(?: or (?:a |an )?(?:real )?(?:bot|robot|ai|human|person|machine))?`),
  rx(String.raw`am i (?:talking|texting|chatting|speaking|messaging) (?:to|with) (?:a |an )?(?:real |actual )?(?:person|human|bot|robot|ai|machine|chatbot)(?: or (?:a |an )?(?:real )?(?:bot|robot|ai|human|person|machine))?`),
  rx(String.raw`is (?:this|that|trainee) (?:a |an )?(?:real )?(?:bot|robot|ai|human|person|real person|automated|chatbot|machine)`),
  rx(String.raw`(?:is there|are there) (?:a |any )?(?:real )?(?:person|human|people|humans) (?:on the other end|behind (?:this|you|it)|reading (?:this|these))`),
  rx(String.raw`who am i (?:talking|texting|chatting|speaking) (?:to|with)`),
];
// The person's own information only ("my", "me"): "what do you collect from employers" is not this question.
const MINE = String.raw`(?:my|our) (?:personal )?(?:data|info|information|details|messages|chats|texts|conversations?|number|stuff)`;
const SELL = [
  rx(String.raw`(?:do|will|would|did) (?:you|u|y'?all|trainee) (?:ever )?(?:sell|share|give away|hand over|rent) ${MINE}(?: with (?:anyone|employers|advertisers|third parties|other companies))?`),
  rx(String.raw`who (?:else )?(?:can|could|will|gets to|is able to) (?:see|read|access) ${MINE}`),
  rx(String.raw`(?:is|are) ${MINE} (?:safe|private|secure|shared|sold|protected|encrypted)(?: with (?:you|trainee))?`),
  rx(String.raw`do (?:you|u) train (?:your ai |the ai |a model )?on ${MINE}`),
  rx(String.raw`what (?:happens|do you do) (?:to|with) ${MINE}`),
];
const STORE = [
  rx(String.raw`what (?:do|did|will|would) (?:you|u) (?:store|keep|save|retain|collect|log|have) (?:about|on|of) me`),
  rx(String.raw`what (?:data|info|information) (?:do|did) (?:you|u) (?:have|keep|store|collect|save) (?:about|on) me`),
  rx(String.raw`what (?:of )?my (?:data|info|information) do (?:you|u) (?:have|keep|store|collect|save)`),
  rx(String.raw`do (?:you|u) (?:store|keep|save|log|record) ${MINE}`),
];
const ACCESS = [
  rx(String.raw`can (?:you|u) (?:see|read|access|look at|get into|view) my (?:other )?(?:apps?|accounts?|e-?mails?|inbox|gmail|outlook|texts|text messages|imessages?|messages|phone|contacts|photos|camera|files|calendar|linkedin|browser|history|location|computer|resume|tracker|applications?)(?: too| as well| at all| right now| already)?`),
  rx(String.raw`do (?:you|u) have access to my (?:other )?[a-z ]{2,30}`),
  rx(String.raw`what (?:can|do) (?:you|u) (?:have )?(?:access|see)(?: on my (?:phone|computer))?`),
  rx(String.raw`what (?:apps|accounts) (?:can|do) (?:you|u) (?:see|access|read)`),
];
const LEGAL = /\b(?:is (?:it|this|that) (?:il)?legal|against the law|can (?:they|my (?:employer|boss|company|manager|job|landlord))\b[^?.]{0,40}\b(?:fire|sue|withhold|keep my|refuse to pay|make me)|should i (?:sue|get|hire|talk to|call|see) (?:a |an )?(?:lawyer|attorney)|wrongful(?:ly)? (?:fired|terminat\w*|dismiss\w*)|(?:file|filing) (?:a )?(?:lawsuit|complaint|claim) against|(?:sue|suing) (?:my|the|them|him|her)\b|non-?competes? (?:is |are |be )?(?:enforceable|valid|legal)|do i need a (?:lawyer|attorney))\b/;
const TAX = /\b(?:(?:do|will|would|should|have to|must) i (?:have to )?(?:owe|pay|file)\b[^?.]{0,30}\btax(?:es)?|tax(?:es)? (?:on|for) (?:my|a|the)\b|how much (?:tax|taxes)\b|(?:is|are) (?:my |this |the |a )?[a-z0-9$ ]{0,25}(?:taxable|tax[- ]deductible|deductible)|(?:get|be|is|are) taxed|file my taxes|my tax return|w-?4 (?:form|withholding)|1099 (?:or|vs\.?) w-?2)\b/;
const MEDICAL = /\b(?:should i (?:see|talk to|go to|call) (?:a |my )?(?:doctor|therapist|psychiatrist|counsel?or|physician|gp)|my (?:medication|meds|prescription|diagnosis|symptoms?)|(?:is|are) (?:this|these|my) [a-z ]{0,20}symptoms?|what (?:medication|meds) should i)\b/;
const THANKS = /^(?:(?:ok(?:ay)?|cool|great|perfect|awesome|nice|got it|alright)[,!. ]+)?(?:thanks|thank you|thank u|thanks so much|thanks a lot|thanks again|thx|ty|tysm|tyvm|appreciate (?:it|you|that)|much appreciated|cheers)(?:[,! ]+(?:man|bro|dude|trainee|so much|a lot))?[\s!.]*$/;
const LAUGH = /^(?:lol+|lmao+|haha+|hah|hehe+|ha(?: ha)+|(?:😂|🤣)+)[\s!.]*$/u;

// One question, nothing else: a second sentence, or a second clause that asks for something, is something else the
// person wants, and the router reads the whole message.
const SECOND_ASK = /,\s*(?:and |also |then |plus |now |but )?(?:find|show|apply|search|send|draft|tailor|get|give|help|tell|check|look|what|can|could|how|where|who|when|do|does|did|is|are|will|i)\b/;
// The clauses of one message: its sentences, each split again where a second ask is joined on with a comma or with
// "and", "also" or "plus" ("do I owe taxes on my bonus and should I counter").
const ASK_WORD = String.raw`(?:should|can|could|how|what|which|where|when|who|do|does|did|is|are|will|would|help|find|show|apply|search|send|draft|tailor|get|give|tell|check|look|write|make|prep)\b`;
const CLAUSE_SPLIT = new RegExp(String.raw`\s*,\s*(?:(?:and|also|plus|then|but|now)\s+)?(?=(?:${ASK_WORD}|i\b))|\s+(?:and|also|plus)\s+(?:also\s+)?(?=${ASK_WORD})`);
export function clauses(t: string): string[] {
  const body = t.replace(new RegExp(LEAD), "");
  return body.split(/[.?!\n;]+/).flatMap((x) => x.split(CLAUSE_SPLIT)).map((x) => x.trim()).filter(Boolean);
}
export function oneQuestion(t: string): boolean {
  const body = t.replace(new RegExp(LEAD), ""); // "ok, are you a bot?" is one question: the lead word is not an ask
  const sentences = body.split(/[.?!\n;]+/).map((s) => s.trim()).filter(Boolean);
  return sentences.length <= 1 && !SECOND_ASK.test(body);
}

// The kind of the message and, for a referral asked beside something else, that something else (the rest).
export function trustRead(message: string): { kind: TrustKind; rest?: string } | null {
  const t = norm(message);
  if (!t) return null;
  if (isDistress(message)) return { kind: "safety" }; // before the length limit and every other check
  if (t.length > MAX_CHARS) return null;
  if (THANKS.test(t) || LAUGH.test(t)) return { kind: "ack" };
  if (oneQuestion(t)) {
    if (IDENTITY.some((r) => r.test(t))) return { kind: "identity" };
    if (SELL.some((r) => r.test(t))) return { kind: "privacy_sell" };
    if (STORE.some((r) => r.test(t))) return { kind: "privacy_store" };
    if (ACCESS.some((r) => r.test(t))) return { kind: "access" };
  }
  // A referral is judged on its own clause; anything asked beside it is the rest, answered after it, never dropped.
  const [first, ...more] = clauses(t);
  if (!first || JOB_WORDS.test(first) || WORK_AUTH.test(first)) return null;
  if (!((LEGAL.test(first) && !OFFER_WORDS.test(first)) || TAX.test(first) || MEDICAL.test(first))) return null;
  return more.length ? { kind: "referral", rest: more.join(". ") } : { kind: "referral" };
}
export function trustKind(message: string): TrustKind | null { return trustRead(message)?.kind ?? null; }

function professional(t: string): string {
  if (TAX.test(t)) return "a tax professional";
  if (MEDICAL.test(t)) return "a doctor";
  return "a lawyer";
}

const scopeTail = (s: string) => (s.split(/[/:]/).pop() ?? "").toLowerCase();
// One line per connection on the account, from its own scopes; an unknown provider is named, never described.
export function connectionLines(conns: Connection[]): string[] {
  return conns.map((c) => {
    const tails = new Set(c.scopes.map(scopeTail));
    if (c.provider === "google_career" || c.provider === "microsoft") {
      const name = c.provider === "google_career" ? "Gmail" : "Outlook";
      const read = c.provider === "google_career" ? tails.has("gmail.readonly") : tails.has("mail.read");
      const send = c.provider === "google_career" ? tails.has("gmail.send") : tails.has("mail.send");
      if (read && send) return `${name}: I read your job mail for confirmations and replies, and I send an email only after your yes on its exact words.`;
      if (read) return `${name}: I read your job mail for confirmations and replies. I can't send from it.`;
      if (send) return `${name}: I can send an email only after your yes on its exact words. I can't read your mail.`;
      return `${name}: connected, with no mail permission granted.`;
    }
    return `${c.provider}: connected.`;
  });
}

// What is always kept for an account (the policy's "Contact and account details" and "What you tell Trainee"): the
// number or messaging account they text from, the name and email if they gave them, and the messages. Then what else is
// saved for this person now.
export const ALWAYS_KEPT = "your contact details (the number or messaging account you text from, and your name and email if you gave them) and our messages";
export function storedLine(s: StoredRecord | null): string {
  if (!s) return `I keep ${ALWAYS_KEPT}. I couldn't read what else is saved for you just now, so I won't guess.`;
  const have: string[] = [];
  if (s.resume) have.push("your resume");
  if (s.facts) have.push(`${s.facts} confirmed fact${s.facts === 1 ? "" : "s"} about you`);
  if (s.tracker) have.push(`${s.tracker} application${s.tracker === 1 ? "" : "s"} on your tracker`);
  if (s.applications) have.push(`${s.applications} application${s.applications === 1 ? "" : "s"} sent or queued through Trainee`);
  const lost = (["resume", "facts", "tracker", "applications"] as const).filter((k) => s[k] === null);
  const lostNote = lost.length ? ` I couldn't read your ${lost.join(" and ")} just now.` : "";
  if (!have.length) return `Saved for you now: ${ALWAYS_KEPT}. Nothing else yet.${lostNote}`;
  return `Saved for you now: ${ALWAYS_KEPT}, plus ${have.join(", ")}.${lostNote}`;
}

async function accessReply(d: TrustDeps): Promise<string> {
  const [conns, stored] = await Promise.all([d.connections().catch(() => null), d.stored().catch(() => null)]);
  const lines = ["I see what you send me here, what I've saved for you, and the accounts you connect. I can't see other apps, your texts outside this chat, your contacts or your photos."];
  lines.push(storedLine(stored));
  if (conns === null) lines.push("I couldn't read your connected accounts just now, so I won't guess what's connected. Ask \"what's connected\" in a minute.");
  else if (!conns.length) lines.push("No account is connected.");
  else lines.push(...connectionLines(conns));
  return lines.join("\n");
}

// distress: the crisis screen's verdict for this message (career_crisis_screen.ts: the list or OpenAI moderation); true
// gives the crisis answer even when the list alone would not.
export async function trustTurn(o: { message: string; deps: TrustDeps; distress?: boolean }): Promise<TrustAnswer | null> {
  const read = o.distress ? { kind: "safety" as const } : trustRead(o.message);
  if (!read) return null;
  const kind = read.kind, t = norm(o.message);
  const answer = (reply: string, meta?: Record<string, unknown>): TrustAnswer => ({ kind, intent: TRUST_INTENTS[kind], reply, status: "completed", ...(meta ? { meta } : {}) });
  switch (kind) {
    case "safety":
      return answer(SAFETY_REPLY, { safety: true });
    case "ack":
      return answer(LAUGH.test(t) ? "Ha." : "Anytime.", { ack: true });
    case "identity":
      return answer("I'm Trainee, an AI career agent, not a person. I find roles, get applications ready for your OK, and prep you for interviews.");
    case "privacy_sell":
      return answer([
        "I don't sell your information or use it for advertising.",
        "It goes to an employer only when you approve the exact application. The services that run Trainee process it for us only: Supabase (database and servers), OpenAI (the AI model), Vercel (the website and cloud apply), and your messaging service (Telegram, LoopMessage for SMS and iMessage, or Meta for WhatsApp).",
        ERASE_SENTENCE,
      ].join("\n"));
    case "privacy_store": {
      const stored = await o.deps.stored().catch(() => null);
      return answer([
        "I keep what you tell me and confirm (the jobs you want, your facts and answers), your resume and the tailored versions I make, your application tracker, and our messages. I don't sell any of it or use it for advertising.",
        storedLine(stored),
        ERASE_SENTENCE,
      ].join("\n"));
    }
    case "access":
      return answer(await accessReply(o.deps));
    case "referral":
      // Asked beside something else: the referral in one line, and the rest goes on (the caller answers it).
      if (read.rest) return { ...answer(`The ${TAX.test(t) ? "tax" : MEDICAL.test(t) ? "medical" : "legal"} part is a question for ${professional(t)}, and I won't guess at it.`), rest: read.rest };
      return answer(`That's a question for ${professional(t)}, and I won't guess at it. If there's a job-search side to it, like a message to HR or your next role, tell me and I'll take that part.`);
  }
}
