// CONTACT OUTREACH, the person-supplied recipient (D-048 option a, coordinator ruling 2026-11-10). With people search off,
// the only recipient Trainee may email is one the person gave it, in their own words, in this message:
//   typed      "email Maya Chen at maya@acme.com about the analyst role", "write to Maya Chen <maya@acme.com>",
//              "reach out to Maya Chen, maya@acme.com, with 1 follow-up"
//   signature  "email her about the analyst role" followed by a pasted signature: a full-name line, optionally a title
//              line ("Senior Analyst, Acme" / "Senior Analyst at Acme"), and exactly one address
// The address is only ever the one the person wrote here: never one made from a company name or a name (E.4 41), never one
// from earlier in the chat. Nothing is saved until the person confirms the name and the address (confirmCard, then a yes
// while it is the thread's last word). The yes checks the address again (syntax, its own domain's mail server, not a
// role, no-reply or ATS inbox) and saves the contact with supplied_by 'person': its email evidence says 'person_supplied',
// and the person's own words (the title line, what they want to ask) are kept as 'person_stated' facts, never as a web
// source. The draft, the card, the yes to its exact hash and the send are the contact turn's, unchanged.
import type { MxResolver } from "./career_contacts.ts";
import { automatedInbox, AUTOMATED_WHY } from "./automated_inbox.ts";
import { FACT_TTL_DAYS } from "./career_contact_facts.ts";
import { readsAsInstruction } from "./career_people_import.ts";

export const SUPPLY_CONFIRM_INTENT = "career_contact_confirm";
export const PERSON_SUPPLIED_SCORE = 95;
export interface Supplied { name: string; email: string; title: string; company: string; domain: string; topic: string | null; followups: number }

const VERB = String.raw`(?:please\s+)?(?:e-?mail|write to|reach out to|draft an? e-?mail to)`;
const NAME = String.raw`([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3})`;
const ADDR = String.raw`([A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24})`;
const TAIL = String.raw`(?:,?\s+about\s+(.+?))?(?:,?\s+with\s+(an?|one|two|1|2)\s+follow[- ]?ups?)?\s*[.!]*\s*$`;
const TYPED = new RegExp(String.raw`^\s*${VERB}\s+${NAME}\s*(?:,|\bat\b|<|\()\s*${ADDR}\s*[>)]?\s*${TAIL}`, "i");
const PRONOUN = new RegExp(String.raw`^\s*${VERB}\s+(?:her|him|them|this person)${TAIL}`, "i");
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, "1": 1, "2": 2 };
const ADDRS = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/g;

const clean = (s: string | undefined | null) => String(s ?? "").replace(/\s+/g, " ").trim();
const domainOfAddr = (e: string) => e.slice(e.lastIndexOf("@") + 1).toLowerCase();
function topicOf(t: string | undefined): string | null {
  const s = clean(t).replace(/[.!]+$/, "").slice(0, 200);
  return s && !readsAsInstruction(s) ? s : null;
}

// The recipient the person wrote in this message, or null. A message naming more than one address names no one.
export function parseSupplied(message: string): Supplied | null {
  const text = String(message ?? "");
  const all = text.match(ADDRS) ?? [];
  if (new Set(all.map((a) => a.toLowerCase())).size !== 1) return null;
  const email = all[0]!.toLowerCase(), domain = domainOfAddr(email);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t = lines.length === 1 ? TYPED.exec(lines[0]) : null;
  if (t) return { name: clean(t[1]), email, title: "", company: domain, domain, topic: topicOf(t[3]), followups: t[4] ? NUM[t[4].toLowerCase()] ?? 0 : 0 };
  const p = lines.length >= 3 ? PRONOUN.exec(lines[0]) : null;
  if (!p) return null;
  const rest = lines.slice(1);
  const nameLine = rest.find((l) => new RegExp(`^${NAME}$`).test(l));
  if (!nameLine) return null;
  const after = rest[rest.indexOf(nameLine) + 1] ?? "";
  const tm = !after.includes("@") ? /^(.{2,120}?)\s*(?:,|\bat\b|\|| - )\s*(.{2,120})$/.exec(after) : null;
  return { name: clean(nameLine), email, title: tm ? clean(tm[1]) : "", company: tm ? clean(tm[2]) : domain, domain, topic: topicOf(p[1]), followups: p[2] ? NUM[p[2].toLowerCase()] ?? 0 : 0 };
}

// Why this address is not one Trainee will write to, or null.
export function suppliedProblem(s: Supplied): string | null {
  if (!s.email.includes("@") || s.domain !== domainOfAddr(s.email)) return "That address doesn't read as an address, so I won't save it.";
  const why = automatedInbox(s.email, s.company);
  return why ? `${s.email} ${AUTOMATED_WHY[why]}, so I won't send to it.` : null;
}

// Step 1: show back what was read, and nothing else happens until the person confirms it.
export function confirmCard(s: Supplied): { reply: string; meta: { contact_supply: Supplied } } {
  const who = [s.name, s.title && `${s.title}${s.company && s.company !== s.domain ? `, ${s.company}` : ""}`, s.email].filter(Boolean).join(" · ");
  return {
    reply: `Before I write anything, check this is right: ${who}${s.topic ? ` (about ${s.topic})` : ""}. Say yes and I'll save them as your contact and draft the email for you to approve; nothing is sent until you approve that exact email. If anything is wrong, send it again corrected.`,
    meta: { contact_supply: s },
  };
}

// Step 2, on the yes: the contact as the store saves it (career_contact_save), with the address's evidence. The mail
// server is asked again here; a domain with no mail server is saved at 0 and never gets a card.
export async function suppliedContact(s: Supplied, mx: MxResolver, now: number) {
  const at = new Date(now).toISOString(), expires_at = new Date(now + FACT_TTL_DAYS * 86400_000).toISOString();
  const r = await mx(s.domain).catch(() => ({ status: "error" as const }));
  const pass = (r as any).status === "ok" && ((r as any).hosts ?? []).length > 0;
  const fact = (claim: string, quote: string) => ({ claim: claim.slice(0, 240), source_url: "", source_type: "person_stated", published_at: null, retrieved_at: at,
    quote_snippet: quote.slice(0, 200), confidence: 1, method: "said by the person in chat", expires_at });
  const facts = [
    ...(s.title ? [fact(`${s.title} at ${s.company}`, `${s.name}, ${s.title}${s.company !== s.domain ? `, ${s.company}` : ""}`)] : []),
    ...(s.topic ? [fact(`You want to ask them about ${s.topic}`, s.topic)] : []),
  ];
  return {
    person: { name: s.name, title: s.title, company: s.company, domain: s.domain, source_url: "", source_type: "person_stated", supplied_by: "person" as const },
    facts,
    email: { email: s.email, method: "person_supplied", score: pass ? PERSON_SUPPLIED_SCORE : 0, approvable: pass, syntax: "pass", mx: pass ? "pass" : "fail", provider: "unknown", catch_all: null,
      rcpt: "not_probed", source_url: null, format: null, format_evidence: 0, checked_at: at,
      why: pass ? "the address you gave me, and its domain has a mail server" : "the address you gave me, but its domain has no mail server" },
    expires_at,
  };
}
