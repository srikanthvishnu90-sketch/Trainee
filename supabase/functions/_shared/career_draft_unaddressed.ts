// "Draft a note to Maya at Stripe about the analyst role" when Maya is in none of the person's contacts (r-audit battery,
// RESPONSE-RULES s2 Draft row; coordinator ruling 2026-11-10). The person still gets the draft they asked for, marked
// "Recipient not set", and one narrow question for the address. Nothing is saved, queued or sent, and no address is ever
// made from the company's name or the person's name (E.4 41): the question shows the shape of the answer, never an address.
// Once the person writes the name and address, it goes through the read-back and confirm path (career_contact_supply.ts).
//
// The draft is built from the ask alone: the name, the company and the topic exactly as the person typed them. Nothing
// about the person, the recipient or any tie between them is claimed: no meeting, referral or relationship (CLAIMED_TIE),
// and what only the person knows is a [bracketed] blank for them to fill. A topic that reads as an instruction is dropped.
import { CLAIMED_TIE } from "./career_contact_draft.ts";
import { readsAsInstruction } from "./career_people_import.ts";

export interface Unaddressed { name: string; firm: string | null; topic: string | null; signature: string | null }

const clean = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
// Where a second request starts ("…role. Also, …", "…role and then …", "…role + …", "…role; …") and the asides around
// an ask ("(again)", "for me", "please", "thanks"): none of it is the topic or the company.
const JOIN = /\s*(?:[;+]|\.\s|,?\s+and\s+(?:also|then)\b|,\s*also\b|\s+also,|\s+after that\b|\s+then\b)/i;
const ASIDE = /\s*(?:\(again\)|\bfor me\b|\bplease\b|\bthanks?(?: you)?\b|\bpls\b)\s*/gi;
const clip = (s: string | null | undefined) => clean(clean(s).split(JOIN)[0].replace(ASIDE, " ")).replace(/[.!?,;:]+$/, "");
// Shouting or all lower case reads as typed in a hurry: a name or a company is put in title case, a topic in lower case.
const shouted = (s: string) => s === s.toUpperCase() && /[A-Z]{2}/.test(s);
const titled = (s: string) => (shouted(s) || s === s.toLowerCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);
const plainCase = (s: string) => (shouted(s) ? s.toLowerCase() : s);
// The topic as typed, up to where a second request starts ("... role. Also, find me jobs" keeps "... role").
function topicOf(t: string | null): string {
  const s = plainCase(clip(t).replace(/^(?:about|on|regarding|re:?)\s+/i, "")).slice(0, 120);
  // A question is a second request read as the topic ("…; what about Northline, why skip it?"), never the topic.
  return s && !readsAsInstruction(s) && !CLAIMED_TIE.test(s) && !/@/.test(s) && !/\b(?:why|what|how|which|when|where)\b|\?/i.test(s) ? s : "";
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function unaddressedDraft(u: Unaddressed): { subject: string; body: string; text: string } {
  const first = titled(clean(u.name).split(" ")[0] || "there"), firm = titled(clip(u.firm)), topic = topicOf(u.topic);
  const at = firm ? ` at ${firm}` : "";
  const thanks = /\bthank/i.test(clean(u.topic)), advice = /\badvice\b/i.test(clean(u.topic));
  const role = /\b(role|position|job|internship|opening)\b/i.test(topic);
  const subject = thanks ? `Thank you` : role ? cap(`${topic}${at}`) : topic ? cap(topic) : firm ? `A question about ${firm}` : "A short question";
  const open = thanks ? `Thank you for [what they did for you].`
    : role ? `I'm interested in ${/^(?:the|a|an|your)\b/i.test(topic) ? topic : `the ${topic}`}${at}, and I'm reaching out to learn more about it.`
    : advice ? `I'm reaching out${firm ? ` because of your work${at}` : ""} to ask for a little advice${topic && !/^asking for advice$/i.test(topic) ? ` on ${topic.replace(/^asking for advice\s*(?:on|about)?\s*/i, "")}` : ""}.`
    : `I'm reaching out${firm ? ` because I'm interested in the work${at}` : ""}${topic ? ` about ${topic}` : ""}.`;
  const ask = thanks ? `[One line on what it meant to you.]` : `Would you be open to a short conversation in the next few weeks?`;
  const body = `Hi ${first},\n\n${open} [One line about you: your school, your role or what you're working on.]\n\n${ask}\n\nThanks,\n${clean(u.signature) || "[Your name]"}`;
  return { subject, body, text: `Subject: ${subject}\n\n${body}` };
}

// The whole reply: the draft, its state, and the one question. lead is what the contacts lookup found (or "").
export function unaddressedReply(u: Unaddressed, lead: string): string {
  const d = unaddressedDraft(u), who = titled(clean(u.name)), firm = titled(clip(u.firm)), at = firm ? ` at ${firm}` : "";
  return [
    lead,
    `Here's a draft to ${who}${at}. Recipient not set: I don't have ${who}'s address and won't guess one, so nothing is saved or sent. Fill in the [brackets] first.`,
    "",
    d.text,
    "",
    // The question is the last thing read (RESPONSE-RULES: the decision ends the reply); the answer's shape comes before it.
    `Reply like "email ${who} <last name> at <their work email>" and I'll read it back before anything is written to them. What are ${who}'s full name and work email?`,
  ].filter((x, i) => i !== 0 || x).join("\n");
}
