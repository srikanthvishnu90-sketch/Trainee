// "Knows exactly what is needed" (spec 2.2, 3.3, shared contract 1; capability 01/05/16): from the person's CONFIRMED facts only,
// what an application needs and what is still missing, ordered so the single most consequential gap is first.
//
// This is DATA for the model, not words: the reply to a role ask (model-written, D-007) is handed `ask_now` (at most two keys,
// consequence order) and the reason each matters, and it asks about the first one in chat while the link goes out in the same
// turn. Code never writes the question. Nothing here asks, sends, applies, or writes a fact:
//   - a value counts as known only when the person confirmed it (a confirmed profile fact, a confirmed resume for the contact
//     lines it carries, or words said in THIS message). Inferred, generated, quarantined, rejected and unconfirmed rows count as missing;
//   - work authorization and sponsorship are never inferred (residence, citizenship, an unqualified "authorized", a country that is
//     not the US, or a profile default do not answer them);
//   - secrets (password, one-time code, SSN or other ID number, card number) are never missing items asked in chat: they are
//     listed under `secure_only` and only ever reach the person through the supported secure step;
//   - the answer to a question goes where every confirmed fact goes (the router's capture and its confirmation); this module has no write.
import { personalSourceDenied } from "./personal_fact_source.ts";
import type { SearchAsk } from "./career_search_judge.ts";

export type NeedKey = "resume" | "work_authorization" | "sponsorship" | "seniority" | "remote_scope" | "location" | "email" | "phone" | "full_name" | "salary_floor";
// Consequence order, most consequential first (spec 2.2: unknown work authorization can invalidate an application; wrong seniority
// can waste the shortlist; a style preference blocks nothing). Same-turn asks follow this order.
export const NEED_ORDER: readonly NeedKey[] = ["resume", "work_authorization", "sponsorship", "remote_scope", "seniority", "location", "email", "phone", "full_name", "salary_floor"];
const WHY: Record<NeedKey, string> = {
  resume: "no confirmed resume on file: nothing can be prepared or checked against a role without it",
  work_authorization: "work authorization in the role's country is not confirmed: unknown authorization can invalidate an application",
  sponsorship: "whether they need visa sponsorship is not confirmed: some roles refuse sponsorship",
  remote_scope: "they want remote but the scope is not confirmed (their country, or anywhere): eligibility cannot be claimed",
  seniority: "no level is confirmed or stated: a wrong level wastes the shortlist",
  location: "no confirmed location and none stated: on-site and hybrid roles cannot be checked",
  email: "no confirmed email: an application form needs a contact email",
  phone: "no confirmed phone: many forms require one",
  full_name: "no confirmed full name: every form needs it",
  salary_floor: "they made pay a hard constraint but gave no floor: pay cannot be checked",
};
// What each item is, in neutral terms, for the model to put in its own words.
const LABEL: Record<NeedKey, string> = {
  resume: "resume", work_authorization: "work authorization (US)", sponsorship: "visa sponsorship need", remote_scope: "remote scope",
  seniority: "target level", location: "location", email: "email", phone: "phone", full_name: "full name", salary_floor: "salary floor",
};

export interface Need { key: NeedKey; label: string; why: string; rank: number; chat: true; blocks: "apply" | "quality" }
// Items that must never be asked in chat. Never in `missing`.
export const SECRET_FIELD = /\b(pass(?:word|code)?|pwd|otp|one[- ]?time|verification code|2fa|mfa|security code|pin\b|ssn|social security|tax id|itin|national id|passport (?:number|no)|driver'?s? licen[sc]e|card number|cvv|cvc|bank account|routing number|api[- ]?key|secret|token)\b/i;
export const isSecretField = (label: string) => SECRET_FIELD.test(String(label ?? ""));

export interface ReadinessInput {
  profile: any;                                  // the router's profile object (facts, basics, preferences, constraints)
  ask?: Pick<SearchAsk, "role" | "place" | "remote" | "remoteOnly" | "limits"> | null; // this turn's role ask: words said now count
  resumeLinePending?: boolean;                   // the reply already carries the resume line (paste or confirm): no second resume ask
  salaryHard?: boolean;                          // the person made pay a hard constraint
  formFields?: string[];                         // field labels a role's form asked for, when known (secrets are sorted out of them)
}
export interface Readiness {
  ready: boolean;                                // nothing is missing
  known: NeedKey[];
  missing: Need[];                               // all gaps, most consequential first
  ask_now: Need[];                               // at most 2: the blocking ones to ask about, one at a time, first first
  secure_only: string[];                         // secret fields a form wants: never asked in chat
  rule: string;                                  // the constraint on the reply, as data
}

const confirmedFact = (f: any) => !!f && typeof f === "object" && f.needs_confirmation !== true && (f.status == null || f.status === "confirmed") && f.status !== "rejected" && !personalSourceDenied(f);
// Work authorization and sponsorship change what may be claimed on an application: only an explicit confirmation counts, a row that
// merely lacks the flags does not.
const explicitlyConfirmed = (f: any) => confirmedFact(f) && f.status === "confirmed" && f.needs_confirmation === false;
const text = (f: any) => String(f?.text ?? f?.title ?? f?.name ?? "") + " " + String(f?.value ?? "");
const US = /^(?:the )?(?:US|U\.S\.?|USA|United States(?: of America)?)$/i;

export function applyReadiness(i: ReadinessInput): Readiness {
  const p = i.profile && typeof i.profile === "object" ? i.profile : {};
  // A profile rebuilt from stated facts (_fromStatedFacts) is not a confirmed profile: nothing in it counts as known.
  const denied = personalSourceDenied(p) || p._fromStatedFacts === true;
  const facts: any[] = denied ? [] : (Array.isArray(p.facts) ? p.facts : []).filter(confirmedFact);
  const confirmedResume = !denied && facts.some((f) => ["education", "experience", "project", "leadership", "skill"].includes(f.kind));
  const basicsOk = (v: unknown) => !denied && confirmedResume && typeof v === "string" && v.trim().length > 0 && !personalSourceDenied(p.basics);
  const known = new Set<NeedKey>();
  if (confirmedResume) known.add("resume");
  if (basicsOk(p.basics?.name)) known.add("full_name");
  if (basicsOk(p.basics?.email)) known.add("email");
  if (basicsOk(p.basics?.phone)) known.add("phone");
  // A contact line the person confirmed on its own as a profile fact ("my phone is ...", "my email is ...").
  for (const f of facts) {
    const t = text(f);
    if (f.kind === "profile" || f.kind === "other") {
      if (/\b(?:mobile )?phone\b/i.test(t) && /\d{7,}/.test(t.replace(/\D/g, ""))) known.add("phone");
      if (/\bemail\b/i.test(t) && /\S+@\S+\.\S+/.test(t)) known.add("email");
    }
  }
  // Work authorization and sponsorship: only an explicit, confirmed eligibility fact (US-scoped authorization). Never inferred.
  for (const f of facts) {
    if (f.kind !== "eligibility" || !explicitlyConfirmed(f)) continue;
    const name = String(f.name ?? f.title ?? "").trim(), value = String(f.value ?? "").trim();
    if (/^work authori[sz]ation(?: \(US\))?$/i.test(name) && /^(yes|no)$/i.test(value) && US.test(String(f.country ?? "").trim())) known.add("work_authorization");
    else if (/^(?:visa )?sponsorship(?: needed| required)?$/i.test(name) && /^(yes|no)$/i.test(value)) known.add("sponsorship");
    else if (/\bI (?:am|'m) (?:not )?authori[sz]ed to work in (?:the )?(?:US|U\.S\.?|USA|United States)\b/i.test(String(f.text ?? ""))) known.add("work_authorization");
    else if (/\bI (?:do not|don't|will not|won't) need (?:visa )?sponsorship\b|\bI (?:need|will need|require) (?:visa )?sponsorship\b/i.test(String(f.text ?? ""))) known.add("sponsorship");
  }
  // Said in this message: a sponsorship limit ("I need sponsorship") is the person's own words this turn.
  if (i.ask?.limits?.needsSponsor) known.add("sponsorship");
  // Level: stated now, or a confirmed goal/preference fact that names one, or a confirmed stated level preference.
  const levelWord = /\b(intern(?:ship)?s?|new[- ]?grad|entry[- ]level|junior|mid[- ]level|senior|staff|principal|lead|manager|director)\b/i;
  if (i.ask?.limits?.bands?.length || facts.some((f) => ["goal", "preference"].includes(f.kind) && levelWord.test(text(f)))) known.add("seniority");
  // Place: stated now, a confirmed location fact, or the confirmed resume's location line.
  if (i.ask?.place || facts.some((f) => f.kind === "location") || basicsOk(p.basics?.location)) known.add("location");
  // Remote scope matters only when remote is wanted: confirmed scope ("remote in the US", "work from anywhere") or said now with a place.
  // A negation ("I do not want remote roles") is not a wish for remote, and a search that stated on-site (remote false) is not asking for it.
  const NEG_REMOTE = /\b(?:not|no|never|don'?t|do not|won'?t|without|avoid|except|rather than|instead of)\b[^.]{0,30}\bremote\b/i;
  const wantsRemote = i.ask?.remote === false ? false : (!!i.ask?.remote || facts.some((f) => ["goal", "location", "preference"].includes(f.kind) && /\bremote\b/i.test(text(f)) && !NEG_REMOTE.test(text(f))));
  const scope = /\bremote\b[^.]{0,30}\b(?:in|within|across|from)\s+(?:the\s+)?(?:US|U\.S\.?|USA|United States|my country|anywhere|[A-Z][a-z]+)\b|\bwork from anywhere\b|\banywhere\b|\bUS[- ]remote\b|\bremote\s+\(?US\)?\b/i;
  if (wantsRemote && (facts.some((f) => ["goal", "location", "preference"].includes(f.kind) && scope.test(text(f))) || (i.ask?.place && i.ask.remote) || (i.ask?.remote && !i.ask.remoteOnly))) known.add("remote_scope");
  if (!wantsRemote) known.add("remote_scope");
  // Pay: a floor matters only when the person made it hard.
  if (!i.salaryHard || i.ask?.limits?.pay || Number(p.preferences?.compFloor) > 0) known.add("salary_floor");

  const rule = "Start with the result (the link goes out in the same turn). Ask at most the first item in ask_now, in chat, in your own words, as one question; hold the second for the next turn. Never ask for a password, code or ID number in chat. Never say anything is applied, submitted or sent.";
  const blockers: NeedKey[] = ["resume", "work_authorization", "sponsorship", "remote_scope"];
  const missing: Need[] = NEED_ORDER.filter((k) => !known.has(k)).map((key, idx) => ({ key, label: LABEL[key], why: WHY[key], rank: idx + 1, chat: true as const, blocks: blockers.includes(key) ? "apply" as const : "quality" as const }));
  // Sponsorship only matters when work authorization is not already confirmed as not needing it; with no sponsorship answer the single
  // most consequential authorization item is asked, and the second is held (one at a time).
  const missingNow = missing.filter((m) => !(m.key === "sponsorship" && missing.some((x) => x.key === "work_authorization")));
  // The resume line already in the reply is the resume ask: asking again in the same turn would be two asks (one at a time).
  const ask_now = i.resumeLinePending && missingNow.some((m) => m.key === "resume") ? [] : missingNow.filter((m) => m.blocks === "apply" || m.key === "seniority").slice(0, 2);
  const secure_only = [...new Set((i.formFields ?? []).filter(isSecretField).map((s) => s.trim()))];
  return { ready: missing.length === 0, known: [...known], missing: missingNow, ask_now, secure_only, rule };
}

// Facts handed to the reply writer: only keys and reasons (no values: nothing about the person that is not needed to ask).
export function readinessFacts(r: Readiness): string {
  if (r.ready) return "Application needs: nothing missing.";
  r = { ...r, missing: r.missing ?? [], ask_now: r.ask_now ?? [], secure_only: r.secure_only ?? [] };
  return `Application needs (most consequential first): ${(r.missing ?? []).map((m) => `${m.label} (${m.why})`).join("; ")}. Ask about: ${r.ask_now.map((m) => m.label).join(", then ") || "nothing yet"}.${r.secure_only.length ? ` A form also wants ${r.secure_only.length} secure field(s); never ask for those in chat.` : ""}`;
}
