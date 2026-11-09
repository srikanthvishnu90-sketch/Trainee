// R10 WO-H fix 14b (owner, 2026-11-09; spec B.6 continuation 4, E.4 items 36-41): follow-up and thank-you drafts. The brain writes
// the words (draft_followup, career_tools.ts); code decides whether they may be shown:
//   ambiguity  when "this one" could be more than one document, or the person named no recipient or one name that fits several,
//              nothing is drafted: the reply asks ONE short question (code keeps only that question);
//   history    a draft never states a prior meeting, call, interview, offer, referral or relationship the person did not state
//              in this conversation or in a confirmed fact ("as we discussed", "thanks for the offer", "Sam referred me", "my
//              former manager"): asking for warmer wording never licenses an invented past (D-007);
//   facts      every figure and every name in the draft is in the person's own words, a confirmed fact, or the recipient and
//              company they named; a "[Your name]" placeholder stays visible, never filled with a guess;
//   address    no email address the person did not type is ever written: a company name is never turned into a guessed address.
// Nothing is sent from here: the draft is shown, and sending remains the exact-payload approval flow (D-MS-1).
import { numbersIn, numEq, specifics } from "./agent/research/guard.ts";

export type FollowupKind = "thank_you" | "follow_up" | "note";
export interface FollowupIn { kind: FollowupKind; recipient: string | null; recipient_options: string[]; document: string | null; documents: string[]; body: string; tone: string | null }
export type FollowupOut =
  | { status: "ask"; ask: "document" | "recipient"; options: string[]; note: string }
  | { status: "rewrite"; problems: string[]; note: string }
  | { status: "ok"; to: string; body: string; note: string };

const squash = (s: unknown) => String(s ?? "").replace(/[ \t]+/g, " ").trim();
const PLACEHOLDER = /\[[^\]\n]{1,40}\]/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Each past event a draft can claim, and the words that show the person said it happened.
export const HISTORY: { kind: string; claim: RegExp; said: RegExp }[] = [
  { kind: "a meeting or conversation", claim: /\b(?:(?:great|nice|good|lovely|wonderful)\s+(?:meeting|to\s+meet|talking|speaking|chatting|to\s+(?:talk|speak|chat))|when\s+we\s+(?:met|spoke|talked|chatted)|(?:our|the)\s+(?:call|chat|conversation|coffee|meeting|catch[\s-]?up)\b|as\s+(?:we\s+)?(?:discussed|mentioned|agreed)|as\s+promised|following\s+up\s+on\s+our|you\s+(?:mentioned|said|told\s+me))/i, said: /\b(?:met|meet|meeting|call|called|spoke|speak|talked|talk|chat(?:ted)?|coffee|conversation|interview(?:ed|s)?)\b/i },
  { kind: "an interview", claim: /\b(?:(?:the|my|our|today's|yesterday's)\s+interview|interviewing\s+me|for\s+(?:the\s+)?interview|taking\s+the\s+time\s+to\s+interview)\b/i, said: /\binterview/i },
  { kind: "an offer", claim: /\b(?:(?:the|your|an?|this)\s+(?:job\s+|generous\s+|kind\s+)?offer\b(?!\s+(?:any|some)\s+feedback)|offered\s+me|extend(?:ed|ing)\s+(?:me\s+)?an?\s+offer)/i, said: /\boffer(?:ed)?\b/i },
  { kind: "a referral or introduction", claim: /\b(?:referr(?:al|ed|ing)|recommended\s+(?:me|that\s+i)|suggested\s+(?:i|that\s+i)\s+(?:reach|contact|write|email)|told\s+me\s+to\s+(?:reach|contact|write)|put\s+(?:me\s+)?in\s+touch|introduc(?:ed|tion))\b/i, said: /\b(?:refer|referr|recommend|introduc|put\s+me\s+in\s+touch|suggested\s+i)/i },
  { kind: "a relationship", claim: /\b(?:my\s+(?:friend|former\s+(?:manager|colleague|boss|teammate)|old\s+(?:colleague|classmate|friend)|mentor|classmate)|we\s+(?:worked|studied)\s+together|(?:long|good)\s+time\s+no\s+see|(?:as\s+)?(?:old|good)\s+friends?)\b/i, said: /\b(?:friend|colleague|manager|boss|classmate|mentor|teammate|worked\s+together|studied\s+together)\b/i },
];

// The draft, checked. `said` is everything the person typed in this conversation; `facts` their confirmed facts as text.
export function checkFollowup(i: FollowupIn, o: { said: string; facts: string[] }): FollowupOut {
  const docs = [...new Set(i.documents.map(squash).filter(Boolean))].slice(0, 4), opts = [...new Set(i.recipient_options.map(squash).filter(Boolean))].slice(0, 4);
  const one = " Ask exactly one short question and nothing else; draft nothing yet.";
  if (!i.document && docs.length > 1) return { status: "ask", ask: "document", options: docs, note: `It is not clear which document this is about: ${docs.join(" or ")}.${one}` };
  if (!squash(i.recipient)) return { status: "ask", ask: "recipient", options: opts, note: `No recipient was named.${one}` };
  if (opts.length > 1) return { status: "ask", ask: "recipient", options: opts, note: `The name fits more than one person: ${opts.join(" or ")}.${one}` };
  const body = squash(i.body).replace(/\r\n?/g, "\n"), to = squash(i.recipient).slice(0, 80);
  const support = [o.said, ...o.facts, to, i.document ?? ""].join("\n"), low = support.toLowerCase();
  const problems: string[] = [];
  if (!body) problems.push("the draft is empty");
  if (body.length > 1500) problems.push("the draft is over 1,500 characters; keep it short");
  for (const e of body.match(EMAIL) ?? []) if (!low.includes(e.toLowerCase())) problems.push(`it writes the address ${e}, which the person never gave; never guess an address`);
  const plain = body.replace(PLACEHOLDER, " ");
  for (const h of HISTORY) { const m = h.claim.exec(plain); if (m && !h.said.test(o.said) && !o.facts.some((f) => h.said.test(f))) problems.push(`"${m[0]}" states ${h.kind} the person never mentioned; remove it, do not invent history`); }
  const sNums = numbersIn(support);
  for (const n of numbersIn(plain)) if (!sNums.some((x) => numEq(x, n))) problems.push(`the figure "${n.raw}" is not in the person's words or confirmed facts`);
  const word = (n: string) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(support);
  for (const n of specifics(plain).names) if (!word(n)) problems.push(`the name "${n}" is not in the person's words or confirmed facts`);
  if (problems.length) return { status: "rewrite", problems: [...new Set(problems)].slice(0, 8), note: "Not shown. Rewrite the draft so it fixes every problem, keeping the tone asked for, and call draft_followup again." };
  return { status: "ok", to, body, note: "Code shows the draft to the person exactly as written; do not repeat or change it. Nothing is sent." };
}

// The reply when the tool asked: the first question the reply asks, and nothing else (no draft, no second question).
export function enforceFollowupAsk(reply: string): string | null {
  const q = String(reply ?? "").replace(/https?:\/\/\S+/g, "").split(/(?<=[.!?])\s+/).find((s) => /\?\s*$/.test(s.trim()));
  return q ? q.trim() : null;
}
