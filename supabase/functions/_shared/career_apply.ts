// The apply core (WO-009a, D-011: mass applying first). Pure functions, no browser and no network:
//   classifyOutcome   what the employer's page shows after submit → the only states we ever report
//   admitApplication  the person's approval of this exact payload; the exact same posting refused as a duplicate (D-MS-3);
//                     only a daily pace the person set themselves (D-MS-2: no product volume cap)
//   greenhouseQuestions / classifyField / planBatch
//                     prepare every application BEFORE a browser opens: the employer's published questions are answered from
//                     the person's confirmed facts; anything missing is asked once for the whole batch and saved, so later
//                     batches need nothing; the batch is admitted against the limits up front.
// The worker (WO-009b) fills exactly the prepared fields by name, reads each back, and classifies the outcome here.
import { answerKey, AUTH_FACTS, FOREIGN, mapQuestion, NAMES_US, norm as normQuestion, RELATIVE_PLACE } from "./question_map.ts";
import { rowAnswerKey } from "./row_answer.ts";
import { chooseOption, levelOption, usCitizenChoice, yesNoFromFact, yesNoOf } from "./answer_options.ts";
import { type PlacePart, postingAtHome, postingCountry, postingPlaces, STATE_NAMES } from "./posting_place.ts";

// ------------------------------------------------------------------------------------------------ outcome
export interface Observation {
  url_before: string; url_after: string;
  form_present_after: boolean; required_empty_after: number;
  validation_errors: string[]; captcha: boolean; email_code_prompt: boolean;
  page_text: string;
}
export type OutcomeState = "confirmed" | "submitted_unconfirmed" | "needs_user" | "failed" | "not_submitted";
export interface Outcome { state: OutcomeState; reason: string; confirmation_id: string | null }

// Employer confirmation wording. Only counted when the form is gone from the page.
const SUCCESS = /(application (?:has been |was )?(?:submitted|received)|thank you for (?:applying|your application)|we(?:'ve| have) received your application|successfully submitted|application is complete|your application was sent)/i;
// An id needs an id label and a token with a digit: a word is never an id (BUG-208: "security").
const ID = /(?:application|confirmation|reference|submission|tracking)\s*(?:(?:id|number|no\.?)\s*[:#]?|#)\s*([A-Z0-9][A-Z0-9-]{4,})\b/i;

export function classifyOutcome(o: Observation): Outcome {
  if (o.captcha) return { state: "needs_user", reason: "captcha", confirmation_id: null };
  if (o.email_code_prompt) return { state: "needs_user", reason: "email_code", confirmation_id: null };
  if (o.validation_errors.length) return { state: "failed", reason: o.validation_errors.join("; "), confirmation_id: null };
  if (o.form_present_after) return { state: "not_submitted", reason: o.required_empty_after ? `${o.required_empty_after} required field(s) still empty` : "the form is still open", confirmation_id: null };
  const m = ID.exec(o.page_text || "");
  const id = m && /\d/.test(m[1]) ? m[1] : null;
  if (SUCCESS.test(o.page_text || "")) return { state: "confirmed", reason: "employer confirmation on the page", confirmation_id: id };
  if (o.url_after !== o.url_before) return { state: "submitted_unconfirmed", reason: "the page moved and the form is gone, but the employer said nothing yet", confirmation_id: null };
  return { state: "not_submitted", reason: "nothing changed on the page", confirmation_id: null };
}

// ------------------------------------------------------------------------------------------------ admission
// The person's pace as the apply path carries it: `daily` is their number, or null for none; `unreadable` carries the
// stored value when it is present but not a pace (SERIAL-1430: unknown, never "no limit").
export interface Limits { daily?: number | null; unreadable?: string }
// D-MS-3 (owner, 2026-10-27): no "one per company per 30 days". Kept exported, unused by admission, only so callers that
// still word a refusal by it compile until they move to the duplicate rule (career_apply_want.ts, career_apply_chat.ts).
export const COMPANY_COOLDOWN_DAYS = 30;
const DAY = 86400000;
// States that mean an application reached (or may have reached) the employer, or is approved to; a failed or
// not-submitted attempt can be retried. One list (G3): the database's career_apply_counted_states(), plus the engine's
// own local states (planned, submitting).
export const COUNTED_STATES: ReadonlySet<string> = new Set([
  "queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "unknown_outcome", "planned", "submitting",
]);
const COUNTED = COUNTED_STATES;
export const normCompany = (c: unknown) => String(c ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();
// No volume ceiling (owner, 2026-10-22: no cap on applications or on anything; CAPS-1390). Trainee imposes no daily
// number: a person's own daily pace, if they set one (career:account daily_limit), is honored as their instruction, with
// no maximum but what the integer columns hold. What stays: one application per employer in 30 days, the exact-payload
// approval on each card, idempotency and unique confirmation ids, the cloud gate and its pauses, the spend and site limits.
// SERIAL-1420 (a) / SERIAL-1430: one rule for the pace, the same in SQL (career_apply_pace_state, 20261025160000), in
// three states: a missing or null value is no preference ("none"); a whole number from 1 to INT4_MAX is the pace ("set"),
// never floored, saturated or otherwise changed; anything else present (text, hex, a thousands separator, 0, negative,
// a fraction, an exponent, past int4) is "unreadable": not a pace and not permission for no limit.
export const INT4_MAX = 2147483647;
export const PACE_RE = /^\s*\+?[0-9]+\s*$/;
export type PaceState = { state: "none"; pace: null; raw: null } | { state: "set"; pace: number; raw: string } | { state: "unreadable"; pace: null; raw: string };
export function paceState(v: unknown): PaceState {
  if (v === null || v === undefined) return { state: "none", pace: null, raw: null };
  const raw = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v) ?? String(v);
  const n = typeof v === "number" ? v : typeof v === "string" && PACE_RE.test(v) ? Number(v.trim()) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= INT4_MAX) return { state: "set", pace: n, raw };
  return { state: "unreadable", pace: null, raw };
}
export function parsePace(v: unknown): number | null { return paceState(v).pace; }
// The limit as a number: their pace when set, Infinity when none, NaN when unreadable (no comparison admits on NaN; the
// callers that queue check `unreadable` first and refuse by name).
export const dailyLimit = (l?: Limits): number => {
  if (l?.unreadable !== undefined) return NaN;
  const st = paceState(l?.daily);
  return st.state === "set" ? st.pace : st.state === "none" ? Infinity : NaN;
};

// A job link as one posting: the SQL's career_apply_posting_key (20261027140000), rule for rule (tests/architect/
// mass-submit-posting-key.test.ts compares them). Lower case; the host without www. and without a default port, any other
// port kept; the path without trailing slashes, and without a final /apply or /application when two or more segments come
// before it; the query kept, sorted, without tracking parameters; any Greenhouse link naming a job number is that number.
// Null when it is not a web link.
export function postingKey(url: unknown): string | null {
  const m = /^https?:\/\/([^/?#@]+)([^?#]*)(\?[^#]*)?/.exec(String(url ?? "").trim().toLowerCase());
  if (!m) return null;
  const h = m[1].replace(/^www\./, "").replace(/:(80|443)$/, "");
  let p = (m[2] ?? "").replace(/\/+$/, "");
  if (/^\/[^/]+\/.+\/(apply|application)$/.test(p)) p = p.replace(/\/(apply|application)$/, "").replace(/\/+$/, "");
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    const jid = /[?&]gh_jid=([0-9]+)/.exec(m[3] ?? "")?.[1] ?? /\/jobs\/([0-9]+)$/.exec(p)?.[1];
    if (jid) return "greenhouse.io/jobs/" + jid;
  }
  const q = (m[3] ?? "").slice(1).split("&")
    .filter((x) => x !== "" && !/^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)/.test(x))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("&");
  return h + p + (q ? "?" + q : "");
}
export interface LogRow { user_id: string; job_id: string; company: string; at: number; state: string; url?: string }
// D-MS-3: refused only when this exact posting (its job id, or its canonical link) is already sent or in flight for this
// person. Two roles at one company are two postings. D-MS-2: no product daily number; only a pace the person set.
export function admitApplication(log: LogRow[], a: { user_id: string; job_id: string; company: string; url?: string; approval_hash?: string; payload_hash?: string }, now: number, limits?: Limits): { ok: boolean; reason: string | null } {
  if (a.approval_hash !== undefined || a.payload_hash !== undefined) {
    if (!a.approval_hash || a.approval_hash !== a.payload_hash) return { ok: false, reason: "not_approved" };
  }
  const mine = log.filter((x) => x.user_id === a.user_id && COUNTED.has(x.state));
  const key = postingKey(a.url);
  if (mine.some((x) => x.job_id === a.job_id || (key !== null && postingKey(x.url) === key))) return { ok: false, reason: "duplicate_job" };
  if (limits?.unreadable !== undefined || Number.isNaN(dailyLimit(limits))) return { ok: false, reason: 'pace_unreadable' } as any;
  const own = dailyLimit(limits);
  if (Number.isFinite(own) && mine.filter((x) => x.at > now - DAY).length >= own) return { ok: false, reason: "daily_cap" };
  return { ok: true, reason: null };
}

// ------------------------------------------------------------------------------------------------ preparing
// WO-048: three optional facts a form reader may add about a field; none changes a field that does not carry it.
//   section   the field is one part of a repeating section's row (Workday's work experience, education, languages): the
//             reader names the part; the answer comes only from the person's own list (sectionAnswer below)
//   dial      the form has its own country phone code field, showing this code ("" when none is chosen yet)
//   personal  a form only the person fills (the disability self-identification, CC-305): never planned, never asked by text
export interface FormSection { kind: string; row: number; part: string; anchor?: string; format?: string }
export interface FormField {
  name: string; label: string; required: boolean; type: string; options: { label: string; value: string }[];
  section?: FormSection; dial?: string; personal?: boolean; widget?: string;
}
export function greenhouseQuestions(job: any): FormField[] {
  const out: FormField[] = [];
  for (const q of (job && Array.isArray(job.questions) ? job.questions : [])) {
    for (const f of (Array.isArray(q.fields) ? q.fields : [])) {
      out.push({ name: String(f.name), label: String(q.label ?? "").trim(), required: !!q.required, type: String(f.type ?? "input_text"),
        options: (Array.isArray(f.values) ? f.values : []).map((v: any) => ({ label: String(v.label ?? ""), value: String(v.value ?? "") })) });
    }
  }
  return out;
}

const KEYS: [RegExp, string][] = [
  [/first\s*(name\s*)?(&|and)\s*last\s*name/i, "full_name"],
  [/^first\s*name|^given\s*name|^preferred\s*first/i, "first_name"],
  [/^last\s*name|^family\s*name|^surname/i, "last_name"],
  [/^legal\s*name\b|^full\s+legal\s+name\b/i, "legal_name"],
  [/^(full\s*)?name$/i, "full_name"],
  [/e-?mail/i, "email"],
  [/\b(tele)?phone\b|\bcell\b|^mobile\b(?!\s*(app|development|device|engineer))|mobile\s*(phone|number)/i, "phone"],
  [/resume|\bcv\b|curriculum/i, "resume"],
  [/cover\s*letter/i, "cover_letter"],
  // Before the links: "Hoe ben je met deze vacature in contact gekomen? (bijv. linkedin / ...)" asks how, not for a profile.
  [/how did you (hear|learn|find out|come across)|hoe ben je\b.*\bgekomen|comment as-tu (entendu|connu|trouvé)|where did you (hear|find)/i, "how_heard"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  // A portfolio is work samples, not the person's website: asked (WO-052).
  [/(personal\s*)?website/i, "website"],
  // "City" alone asks for the city, not "City, ST" (WO-048, Workday's address block).
  [/^city\s*[*:]?\s*$/i, "city"],
  [/(require|need).*(sponsor)|sponsorship|visa\s*status/i, "sponsorship"],
  [/(legally\s*)?authori[sz]ed\s*to\s*work|work\s*authori[sz]ation|eligible\s*to\s*work/i, "work_authorization"],
  [/^(current\s*)?(location|city)|where are you (located|based)/i, "location"],
  [/start\s*date|when can you start|earliest.*start/i, "start_date"],
  [/salary|compensation\s*expectation|desired\s*pay/i, "salary_expectation"],
  [/gender|race|ethnicity|veteran|disability|hispanic|latino/i, "eeo"],
];
// A wrong mapping sends a wrong answer; an unknown only asks. So the person's own contact facts go only into a free-text
// box (never a checkbox, radio or select, where "Do you own a smartphone?" or "Email me about other openings" would take
// the person's number or address), and never into a question about someone else (a reference, a manager, an emergency
// contact). tests/architect/wo-009-classify-precision.test.ts holds the real labels that were mapped wrongly before.
const CONTACT = new Set(["first_name", "last_name", "full_name", "email", "phone", "linkedin", "github", "website", "location", "city", "start_date", "salary_expectation"]);
const FREE_TEXT = /^(input_text|text|email|tel|url|textarea|input|search|number|date)$/;
const SOMEONE_ELSE = /\breferr|\breferen|\bteam member|\breferee|\bemergency|\bmanager|\bsupervisor|\brecruiter|\bspouse|\bparent|\bguardian|\bemployee who/i;
export function classifyField(label: string, type: string): string {
  const l = String(label || "");
  if (/file/.test(type) && /resume|cv/i.test(l)) return "resume";
  // One checkbox carrying a long statement (no question in it) is an acknowledgement for the person to read, never a
  // fact. A long question rendered as checkboxes ("Will you ... require sponsorship ...?") is still a question.
  if (type === "checkbox" && l.length > 120 && !l.includes("?")) return "unknown";
  for (const [re, key] of KEYS) {
    if (!re.test(l)) continue;
    if (CONTACT.has(key) && (!FREE_TEXT.test(type) || SOMEONE_ELSE.test(l))) continue;
    // A phone's extension is not the phone number (WO-048, Workday's "Phone Extension").
    if (key === "phone" && /\bext(ension)?\b/i.test(l)) continue;
    // WO-052: "City, State, Zip" and "City, Country" ask for more than the place the person gave; a current, monthly,
    // hourly or ranged pay is not the expected annual salary.
    if ((key === "location" || key === "city") && /zip|postal|country/i.test(l)) continue;
    // WO-058 (sample G): "Where are you located? Are you able to relocate or commute?" asks more than where they live; "the
    // best phone number and email" asks for two; a number given as consent to texts is a consent the person declined.
    if (key === "location" && /relocat|commut/i.test(l)) continue;
    // WO-059 (sample H): authorization bundled with an at-will statement; another name the person studied under; an
    // academic program's or a company's website.
    if (key === "work_authorization" && /\bat[- ]will\b|\bpermanent\b/i.test(l)) continue;
    if (key === "website" && /\b(academic|program|department|school|university|college|company|employer|organi[sz]ation)\b/i.test(l)) continue;
    if ((key === "email" || key === "phone") && /e-?mail/i.test(l) && /phone|mobile|number/i.test(l)) continue;
    if (key === "phone" && /\b(sms|text messages?|texts)\b/i.test(l)) continue;
    if (key === "salary_expectation" && (/current|present|monthly|per month|hourly|per hour|range|bracket|band|format|\$00/i.test(l) || VARIABLE_PAY.test(l))) continue;
    // The resume answer is the approved file itself: it goes into an upload, never typed into a box as text.
    if ((key === "resume" || key === "cover_letter") && !/file/.test(type)) continue;
    // "a visa that does NOT require sponsorship" asks the opposite of the sponsorship fact: ask the person. Only the
    // question itself counts (up to its "?"): a note after it ("you must be authorized without sponsorship") does not.
    if (key === "sponsorship" && /\bnot\b|without|no longer/i.test(l.split("?")[0])) continue;
    // WO-056: "Are you currently authorized to work in the United States? We DO assist with visa sponsorship" asks the
    // authorization: a question that names no sponsorship or visa before its "?" is not the sponsorship question.
    if (key === "sponsorship" && l.includes("?") && !/sponsor|visa/i.test(l.split("?")[0])) continue;
    // The name of the employee who referred them is not how they heard about the job.
    if (key === "how_heard" && /\breferring (employee|person)\b|\bwho referred you\b|\bname of (the )?(person|employee) who referred\b/i.test(l)) continue;
    // "authorized to work WITHOUT sponsorship?" needs both facts at once (authorized now, sponsorship later): ask.
    if (key === "work_authorization" && /sponsor/i.test(l.split("?")[0])) continue;
    return key;
  }
  return "unknown";
}

// Greenhouse asks "Resume/CV" as one question with two ways to answer it: a file upload (resume) and a paste box
// (resume_text), both marked required. The paste box beside its upload is the upload's alternative: uploading the
// approved file answers the question, and nothing is typed into the box. 63 of 80 real Greenhouse postings carry it.
export function fileAlternative(f: { name: string; type: string }, fields: { name: string; type: string }[]): boolean {
  const base = /^(.+)_text$/.exec(String(f.name || ""))?.[1];
  return !!base && !/file/.test(f.type) && fields.some((x) => x.name === base && /file/.test(x.type));
}

export interface Answer { value: string; factId: string }
export interface PlannedField { name: string; label: string; value: string; factId: string }
// location: the posting's own location text as the employer wrote it (WO-053); without it, a question that depends on
// where the job is (an office with no place named, work rights "in the country where this job is located") is asked.
export interface PlanPosting { job_id: string; company: string; title: string; fields: FormField[]; location?: string; url?: string }
export const normLabel = (l: string) => String(l || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const yesNo = (v: string) => (/^(y|yes|true)$/i.test(v.trim()) ? "yes" : /^(n|no|false)$/i.test(v.trim()) ? "no" : null);

// A select is answered only with one of the employer's own options, matched exactly (or yes/no to Yes/No). Never forced.
export function matchOption(value: string, options: { label: string; value: string }[]): string | null {
  const v = value.trim().toLowerCase();
  const exact = options.find((o) => o.label.trim().toLowerCase() === v || o.value.trim().toLowerCase() === v);
  if (exact) return exact.value;
  const yn = yesNo(value);
  if (yn) { const o = options.find((x) => yesNo(x.label) === yn); if (o) return o.value; }
  return null;
}

// WO-020 part 2: a question the keyword classifier does not place is read by meaning (question_map.ts) and answered from
// the person's own confirmed facts, onto the employer's own options (answer_options.ts). What each kind may do:
//   fact, attestation  the person's stated answer (an attestation is never a default: it exists only if they said it)
//   derived            computed from what they stated: "worked here before" from their confirmed employer list
//   consent            their standing consent, shown on the approval card as theirs
//   screen             this job's office days, relocation or travel, from their stated yes/no preference; anything else
//                      about the job is asked
//   essay, file, unknown  asked (an essay is drafted only in a later step, from confirmed facts, and shown in full)
// Contact and identity facts go only into a free-text box or onto a matching option, never into a checkbox.
const TEXT_FACTS = new Set(["full_name", "legal_name", "first_name", "last_name", "preferred_name", "email", "phone", "street_address",
  "full_address", "city", "postal_code", "location", "linkedin", "github", "website", "current_employer", "current_title", "school",
  "major", "salary_expectation", "current_compensation", "signature", "references", "timezone"]);
const PREFERENCE: Record<string, string> = { job_onsite: "onsite_ok", job_relocation: "relocation", job_travel: "travel_ok" };

// WO-052 (an independent review of every fill on samples A and B): three answers that were right in general and wrong
// for the question asked.
// 1. Work rights are the person's for the country they stated. A question about another country's authorization or
//    visa ("authorized to work in South Korea?", "¿Tienes permiso de trabajo en España?", "visa sponsorship in the UK?")
//    is asked; "the US or Canada" may still take the US yes, never a sponsorship "no" for both.
// WO-055 (sample D, scored once): at a job abroad, work rights and pay are that country's. "Will you require us to sponsor
// a visa?" at a Tokyo posting is about Japan, and a bare 95000 in a London pay box reads as pounds: both asked. A question
// that names the US ("authorized to work in the US?") stays the person's own anywhere.
const PAY_FACTS = new Set(["salary_expectation", "current_compensation"]);
const OTHER_CURRENCY = /\b(gbp|eur|jpy|inr|cad|aud|sgd|chf|sek|nok|dkk|pln|brl|mxn|cny|rmb|hkd|nzd|zar|aed|sar|krw|ils)\b|[£€¥₹]|\blakhs?\b|\bcrores?\b/i;
// Pay that is more than the stated expectation, when it is what is asked ("including base salary and bonus", "Variable
// Salary", OTE); an example list after the question ("[Example: base salary, annual commission]") is not the ask.
const VARIABLE_PAY = /\b(including|inclusive of|incl\b\.?)[^.?\[]*\b(bonus|commission|equity|incentive)|\b(plus|\+|and) (bonus|commission|equity)\b|^variable\b|\bvariable (pay|salary|compensation)\b|\bote\b|\bon-target\b/i;
// Work rights where the person lives ("in your country of residence", "remain in your current location", "your current
// work authorization status") are the person's own wherever the job is: their facts answer for a home in the US.
const HOME_PLACE = /\b(country|location|place) (where |in which )?you (currently )?(reside|live|are (currently )?(based|located|living))\b|\bcountry of residence\b|\byour current (location|country|work authori[sz]ation)\b/i;
const homeInUs = (answers: Record<string, unknown> = {}) => {
  const v = (k: string) => String((answers[k] as { value?: unknown } | undefined)?.value ?? "");
  return NAMES_US.test(v("country")) || postingCountry(postingPlaces(v("location"))) === "us";
};
// Owner (Ashby scope, 2026-10-21): an answer offered for a work-rights question can tie it to the job's country ("No, I do
// not require sponsorship to work in the country where this role is located", Harvey). Such a question is read with that
// option: it is the person's US answer only at a posting known to be in the US, and asked at one with no location (F-013).
// A question that names the US itself ("authorized to work in the United States?") stays the person's, whatever its options say.
const placeText = (q: { label: string; options?: { label: string }[] }) => NAMES_US.test(q.label) ? q.label :
  [q.label, ...(q.options ?? []).map((o) => o.label).filter((l) => RELATIVE_PLACE.test(l))].join(" ");
export function otherCountry(fact: string, label: string, location?: string, homeUs = false): boolean {
  if (AUTH_FACTS.has(fact) && HOME_PLACE.test(label) && !FOREIGN.test(label)) return !homeUs;
  const abroad = postingCountry(postingPlaces(location ?? "")) === "abroad";
  if (AUTH_FACTS.has(fact) && RELATIVE_PLACE.test(label)) return postingCountry(postingPlaces(location ?? "")) !== "us";
  if (AUTH_FACTS.has(fact) && abroad && !NAMES_US.test(label)) return true;
  if (fact === "salary_currency" && abroad) return true; // "the currency of the country where this position is based"
  if (PAY_FACTS.has(fact) && (abroad || OTHER_CURRENCY.test(label) || VARIABLE_PAY.test(askedPart(label)) || /\b(bracket|band|range)\b/i.test(askedPart(label)))) return true;
  if (!AUTH_FACTS.has(fact) || !FOREIGN.test(label)) return false;
  return fact === "sponsorship" || !NAMES_US.test(label);
}
// WO-055 (sample D): a question can name a fact's topic and still ask what the fact does not say. Each is asked.
const BEYOND_FACT: [string[], RegExp][] = [
  // the person's visa type; a sponsorship question that lists OPT among its examples is still the sponsorship question
  [["work_authorization"], /\bcpt\b|\bopt\b|curricular practical|optional practical/i],
  [["school"], /\bcurrently (attending|enrolled)\b|\bare you (currently )?(attending|enrolled)\b|\byou are attending\b/i],
  [["school", "major", "education_level", "graduation_date"], /\bsecond[- ](highest|most recent)\b|\b2nd\b|\bother than your highest\b|\badditional (degree|qualification)\b/i],
  [["relocation", "job_relocation"], /\b(need|have|required?) to relocate\b/i], // whether moving is needed, not whether they would
  // able to obtain or hold a clearance is its own fact; "U.S. person status and/or clearance eligibility" is met by being one
  [["us_person"], /\b(obtain|maintain|hold|get|qualify for|eligible for)\b[^?]{0,40}\bclearance\b/i],
  // work through a vendor or an agency is not on the person's own list of employers; a contractor's is
  [["worked_here_before"], /\bvendor\b|\bconsultant\b|\bthrough an agency\b|\bhaken\b|\b(for|at) an? ([\w&-]+ ){0,3}(company|companies|firm|organi[sz]ation|insurer|provider|bank|agency|startup)\b/i],
  // WO-056: a question for those who served ("If you've previously served in the U.S. Armed Forces: ...") is not the
  // person's "no government employment"; its "Not Applicable" is theirs to pick.
  [["government_employment"], /\bif you('ve| have)? (previously |ever )?served\b|\bauthori[sz]e the release\b/i],
  // WO-057: acting for a political party is not employment the person's list records.
  [["worked_here_before", "government_employment"], /\brepresentative of\b|\bpolitical party\b/i],
  [["applied_before"], /\banother\b|\baffiliat|\bsubsidiar|\bsister compan|\bgroup compan|\bany of (our|its)\b/i],
];
// An answer to a question the person's fact does not answer at this posting (above) is this posting's alone: it is stored
// and read back under a job key (answerKey `here`), so a "Yes" to a London posting's "Will you require sponsorship?" never
// becomes the person's US sponsorship fact, and a US "No" saved as the fact never answers London's question.
export function factStaysHere(q: { label: string; type: string; options?: { label: string }[] }, location?: string, answers?: Record<string, unknown>): boolean {
  const m = mapQuestion({ label: q.label, type: q.type, options: q.options ?? [] });
  return m.kind === "fact" && (otherCountry(m.fact, placeText(q), location, homeInUs(answers)) || beyondFact(m.fact, q));
}
const byNationalityList = (options: { label: string }[]) => options.some((o) => /nationality|citizen/i.test(o.label)) && options.some((o) => /permit|visa/i.test(o.label));
export function beyondFact(fact: string, f: { label: string; type: string; options?: { label: string }[] }): boolean {
  // A "select all that apply" list about where they live and would move is answered as a whole, by the person.
  if ((fact === "relocation" || fact === "job_relocation") && /multi_select|multiselect/.test(f.type)) return true;
  // WO-056: "no clearance" does not say whether one was held before, where the list tells "Expired" from "Never held".
  if (fact === "security_clearance" && (f.options ?? []).some((o) => /\b(expired|inactive|previously held|lapsed)\b/i.test(o.label))) return true;
  // WO-057: a list that tells authorization by nationality from a work permit asks which, not only whether: never the
  // direct "yes" (byMeaning answers it for a US citizen at a US job).
  if (fact === "work_authorization" && byNationalityList(f.options ?? [])) return true;
  return BEYOND_FACT.some(([facts, re]) => facts.includes(fact) && re.test(askedPart(f.label)));
}

// 2. The person's yes to working on site is for where they live (onsite_ok, "a posting's city makes a screen"): an
//    office the question names in another city ("in-office 5 days a week in Sunnyvale?", "our Louisville, CO HQ") is
//    asked. The places a form names on its other office questions count too (Anthropic names SF/NYC one question
//    earlier, then asks "our office 4 days/week?").
const STATE_CODE = /,\s*([A-Z]{2})\b/g;
const PLACE_WORDS = /\b(?:in|at|from|to|near|around|within|of)\s+(?:our\s+|the\s+)?((?:[A-Z][\w.'’-]+)(?:\s+[A-Z][\w.'’-]+){0,3})/g;
const OUR_PLACE = /\bour\s+((?:[A-Z][\w.'’-]+\s+){1,3})(?:office|offices|hq|headquarters|campus|location|hub|studio)\b/gi;
const NOT_PLACE = /^(the|our|a|an|us|u\.?s\.?a?|usa|united states( of america)?|america|north america|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hybrid|office|hq|headquarters|remote|person|account|executive|team|engineering|sales|ai|english|eastern|pacific|central|mountain|est|pst|cst|mst|et|pt|ct|mt|i|we|you)$/i;
export function placesNamed(label: string, company = ""): string[] {
  const out: string[] = [];
  const add = (x: string) => {
    const v = x.replace(/['’]s$/, "").replace(/\s+(hq|headquarters|office|offices|campus|location)$/i, "").trim();
    if (!v || NOT_PLACE.test(v) || v.split(/\s+/).every((w) => NOT_PLACE.test(w))) return;
    if (company && normCompany(v) && (normCompany(v) === normCompany(company) || normCompany(company).startsWith(normCompany(v)))) return;
    out.push(v);
  };
  for (const m of label.matchAll(/\b(NYC|SF|DC|LA|Bay Area|Tri-State|Silicon Valley)\b/g)) add(m[1]);
  for (const m of label.matchAll(STATE_CODE)) if (STATE_NAMES[m[1].toLowerCase()]) add(m[1]);
  for (const m of label.matchAll(PLACE_WORDS)) add(m[1]);
  for (const m of label.matchAll(OUR_PLACE)) add(m[1]);
  // "Noida hybrid mode", "SF office", "Austin HQ": a place named right before the way of working (WO-052, sample C).
  for (const m of label.matchAll(/\b([A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+)?)\s+(?:hybrid|office|offices|onsite|on-site|in-office|hq|headquarters|campus)\b/g)) add(m[1]);
  return out;
}
// Whether a named place is where the person lives: their city by name, or their state by code or name.
function isHome(place: string, answers: Record<string, Answer>): boolean {
  const p = place.toLowerCase();
  const city = String(answers.city?.value ?? String(answers.location?.value ?? "").split(",")[0]).trim().toLowerCase();
  const st = String(answers.state?.value ?? String(answers.location?.value ?? "").split(",")[1] ?? "").trim().toLowerCase();
  if (city && (p === city || p.includes(city))) return true;
  return !!st && (p === st || p === STATE_NAMES[st]);
}
const SITE_SCREENS = new Set(["job_onsite", "job_commute"]);
// A form's places, read from its office and location questions.
const SITE_TEXT = /\b(office|on-?site|in-?person|located|location|relocat|based|commut|hq|headquarters)\b/i;
export function formPlaces(fields: { label: string }[], company: string): string[] {
  return fields.filter((f) => SITE_TEXT.test(f.label) && f.label.length <= 300).flatMap((f) => placesNamed(f.label, company));
}
function awayFromHome(f: FormField, places: string[], answers: Record<string, Answer>, posting: PlacePart[]): boolean {
  const own = placesNamed(f.label);
  const named = own.length ? own : places;
  // A state code beside its city ("Louisville, CO") is the same place: home only if the city or the state is theirs.
  if (named.length) return !named.some((x) => isHome(x, answers));
  // WO-053: nothing on the form names the office, so it is the posting's: the person's yes is for their own city, and
  // only a posting there (or one of its places there) takes it. A posting elsewhere, remote, state- or country-wide, or
  // with no location known is asked ("Are you able to work from our US office three days per week?" at a San Francisco
  // posting is not a Chicago person's yes).
  return !postingAtHome(posting, homeOf(answers));
}
const homeOf = (answers: Record<string, Answer>) => ({
  city: String(answers.city?.value ?? String(answers.location?.value ?? "").split(",")[0]).trim(),
  state: String(answers.state?.value ?? String(answers.location?.value ?? "").split(",")[1] ?? "").trim(),
});
// WO-052: a typed pay answer in the employer's terms. "Please include currency" and a CTC (an Indian form's cost to
// company) take the stated amount with the person's stated currency ("95000 USD"); without a stated currency, asked.
function payShape(f: FormField, value: string, fact: string, answers: Record<string, Answer>): string | null {
  if ((fact !== "salary_expectation" && fact !== "current_compensation") || !/\bcurrency\b|\bctc\b/i.test(f.label)) return value;
  const code = /\b[A-Z]{3}\b/.exec(String(answers.salary_currency?.value ?? ""))?.[0];
  return code && /^\d[\d,.]*$/.test(value.trim()) ? `${value.trim()} ${code}` : null;
}
// 3. "Authorized to work in the US without sponsorship?" is yes only when the person is authorized and needs none.
const WITHOUT_SPONSOR = /\bwithout\b.{0,40}\bsponsor/i;
// The question a label asks: its last sentence that asks something ("...without sponsorship. Will you require
// sponsorship?" asks the second; WO-055, sample D). A label cut off before its "?" asks in its last sentence.
// WO-056: an abbreviation ("U.S.", "e.g.", "i.e.") does not end a sentence ("If you've previously served in the U.S. Armed
// Forces: ... authorize the release ...?" is one question).
const askedPart = (label: string) => {
  const kept = label.replace(/\b(?:[A-Za-z]\.){2,}/g, (a) => a.replace(/\./g, "\u2024"));
  const parts = kept.split(/(?<=[.?!])\s+/).filter((x) => x.trim()).map((x) => x.replace(/\u2024/g, "."));
  return parts.filter((x) => /\?/.test(x)).pop() ?? parts.pop() ?? label;
};
function authorizedWithoutSponsorship(answers: Record<string, Answer>): Answer | null {
  const w = answers.work_authorization, sp = answers.sponsorship;
  if (!w || !sp) return null;
  const a = yesNoOf(w.value), n = yesNoOf(sp.value);
  if (a === "yes" && n === "no") return { value: "Yes", factId: w.factId };
  if (a === "no" || n === "yes") return { value: "No", factId: n === "yes" ? sp.factId : w.factId };
  return null;
}
const AFFILIATES = /\bsubsidiar|\baffiliat|\bparent compan|\bsister compan|\brelated (compan|entit)|\bgroup compan|\bfamily of compan|\bpredecessor/i;
// The words of a company's name that could tie two companies together (not "group", "services", "inc").
const GENERIC_NAME = new Set(["and", "the", "of", "group", "holdings", "holding", "global", "international", "services", "service", "solutions", "systems",
  "technologies", "technology", "tech", "partners", "industries", "enterprises", "usa", "america", "americas", "national", "united", "worldwide"]);
const nameWords = (n: string) => n.split(" ").filter((w) => w.length >= 3 && !GENERIC_NAME.has(w));
const SPLIT = /\s*[;,\n]\s*/;
function byMeaning(f: FormField, company: string, answers: Record<string, Answer>, places: string[] = [], posting: PlacePart[] = [], location?: string): Answer | null {
  const m = mapQuestion({ label: f.label, type: f.type, options: f.options });
  if (m.kind === "essay" || m.kind === "file" || m.kind === "unknown") return null;
  // WO-057: a list that tells authorization by nationality from a work permit (Magnet, Exegy): a US citizen at a job in
  // the US, or one that names no place, is authorized by nationality; anyone else, or a job abroad, is asked.
  if ((m.fact === "work_authorization" || m.fact === "citizenship") && byNationalityList(f.options)) {
    const pick = f.options.filter((o) => /nationality|citizen/i.test(o.label) && !/\bnot\b/i.test(o.label));
    const citizen = answers.citizenship && NAMES_US.test(String(answers.citizenship.value)) && yesNoOf(answers.work_authorization?.value ?? "") === "yes";
    return citizen && pick.length === 1 && postingCountry(posting) !== "abroad" ? { value: pick[0].value, factId: answers.citizenship.factId } : null;
  }
  // WO-052: the employer list derives "worked here before"; it is never typed as one employer, a title or a date.
  if (m.fact === "former_employers" || otherCountry(m.fact, placeText(f), location, homeInUs(answers)) || beyondFact(m.fact, f)) return null;
  if (SITE_SCREENS.has(m.fact) && awayFromHome(f, places, answers, posting)) return null;
  // The person's own contact and identity facts never answer a question about someone else, by meaning either
  // ("Phone number of the person referring you"; WO-031, tests/fixtures/extension/answer-key.json).
  // (The person's own answer about their references is theirs to give: the references fact is exempt.)
  if (TEXT_FACTS.has(m.fact) && m.fact !== "references" && SOMEONE_ELSE.test(f.label)) return null;
  let a: Answer | undefined;
  if (m.fact === "worked_here_before" && answers.former_employers) {
    const co = normCompany(company);
    // WO-059 (sample H, Perr&Knight): "Have you previously worked with Microsoft SQL Server?" asks about a tool. "Worked
    // with" is about this employer only when the question names it or speaks as it ("us", "our").
    if (/\bworked with\b/i.test(f.label) && !(co && normCompany(f.label).includes(co)) && !/\b(us|our|we)\b/i.test(f.label)) return null;
    const listed = String(answers.former_employers.value).split(SPLIT).map(normCompany).filter(Boolean);
    // WO-059: the same employer by name, never by letters inside another name ("Meta" is not "Metabase"). One name that is
    // the other with more words ("Example" and "Example Analytics", "Stripe" and "Stripe Payments") may or may not be the
    // same company: the person answers.
    const words = (x: string) => ` ${x} `;
    if (co && listed.some((x) => x !== co && (words(x).includes(words(co)) || words(co).includes(words(x))))) return null;
    const here = !!co && listed.some((x) => x === co);
    // WO-042 (live, SpaceX): a "No" covers only the company checked, yet a question or its options may name others ("I have
    // never worked for SpaceX, SpaceXAI, xAI, X, or Twitter"). When one of the person's own former employers is named
    // there, the answer is theirs to give.
    const named = normCompany([f.label, ...f.options.map((o) => o.label)].join(" "));
    if (!here && listed.some((x) => new RegExp(`(^|[^a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(named))) return null;
    // WO-048 round 2: "X or any of its subsidiaries or affiliates" also names companies nobody listed. No only from a list
    // that is complete (every job the person stated is in it) and where no listed employer shares a name word with X (an
    // affiliate is often named after its parent: "Tailspin Cargo" of "Tailspin Air"); otherwise the person answers.
    if (!here && AFFILIATES.test(f.label)) {
      if (workEntries(answers).some((e) => !listed.includes(normCompany(e.employer)))) return null;
      const theirs = new Set(nameWords(co));
      if (!theirs.size || listed.some((x) => nameWords(x).some((w) => theirs.has(w)))) return null;
    }
    a = { value: here ? "Yes" : "No", factId: answers.former_employers.factId };
  } else if (m.fact === "start_date" && !answers.start_date && answers.notice_period && f.options.length) {
    // WO-048 round 2: "When could you start?" over spans of time ("Within 2 weeks", "Within 1 month") from the stated notice
    // period, by its span alone (bySpan): the one span it falls in, else asked. Never a date, never a yes or no.
    const choice = chooseOption("notice_period", String(answers.notice_period.value), f.options);
    return choice === null ? null : { value: choice, factId: answers.notice_period.factId };
  } else if (m.fact === "employment_status" && !answers.employment_status && answers.current_employer?.value) {
    // WO-058 (sealed-wd3 t4): a stated current employer answers "Are you currently employed?" yes, on a yes/no question only
    // (a list of kinds of employment, full-time or part-time, is the person's to pick).
    if (f.options.length ? !f.options.every((o) => yesNoOf(o.label)) : f.type !== "checkbox" && !/^(radio|boolean)$/.test(f.type)) return null;
    a = { value: "Yes", factId: answers.current_employer.factId };
  } else if (m.fact === "work_authorization" && /\bpermanent\b/i.test(askedPart(f.label))) {
    // WO-059 (sample H, Viget): a permanent right to work in the US is a citizen's or a permanent resident's; a stated
    // authorization does not say it is permanent. Only a stated US citizenship answers it here.
    if (!(answers.citizenship && NAMES_US.test(String(answers.citizenship.value))) || postingCountry(posting) === "abroad") return null;
    a = { value: "Yes", factId: answers.citizenship.factId };
  } else if (m.kind === "screen") {
    const pref = PREFERENCE[m.fact] ? answers[PREFERENCE[m.fact]] : answers[m.fact];
    // Only a plain yes or no from the person answers a question about this job; "3 days" is not "5 days a week".
    if (pref && yesNoOf(pref.value)) a = pref;
  } else if ((m.fact === "sponsorship" || m.fact === "work_authorization") && WITHOUT_SPONSOR.test(askedPart(f.label))) {
    a = authorizedWithoutSponsorship(answers) ?? undefined;
  } else {
    a = answers[m.fact];
  }
  // WO-052: an export-control list of U.S.-person categories ("A United States citizen or national", "A lawful permanent
  // resident", ...): a stated U.S. citizenship is the first, and nothing else is chosen for the person.
  if (m.fact === "us_person" && f.options.length && answers.citizenship) {
    const c = usCitizenChoice(String(answers.citizenship.value), f.options);
    if (c !== null) return { value: c, factId: answers.citizenship.factId };
  }
  if (!a) return null;
  const choice = f.options.length ? chooseOption(m.fact, String(a.value), f.options, f.label) : null;
  if (f.options.length) return choice === null ? null : { value: choice, factId: a.factId };
  if (f.type === "checkbox") {
    const yn = yesNoFromFact(m.fact, String(a.value), f.label) ?? yesNoOf(a.value);
    return yn ? { value: yn, factId: a.factId } : null;
  }
  if (TEXT_FACTS.has(m.fact) && !FREE_TEXT.test(f.type)) return null;
  return { value: String(a.value), factId: a.factId };
}

// A follow-up ("If no, please describe...", "If you selected Other...") depends on another answer on the form: a fact never
// answers it ("If no, describe your work authorization" is not the authorization itself). Only an answer the person gave
// for that wording fills it; otherwise it is left (optional) or asked (required). WO-031.
// WO-042, zero wrong answers: a value from the person's facts goes into a field only when it has that field's shape.
// - A yes or no never answers a field that asks for a name, a number, a date, an address or a link ("Please enter the
//   referring team member's full name": "No" is not a name).
// - A field that asks for a date in a stated format, or a date input, takes only a date ("2 weeks" is not MM/DD/YY).
// - A number input takes only a number.
// Anything else is left: asked when required, empty when optional. Saved answers retain the person's wording, but must
// still fit the employer's typed field. Options are matched by chooseOption, checkboxes by yesNoFromFact.
const ASKS_DATA = /\b(name|e-?mail|phone|number|date|address|url|link|website|zip|postal|street)\b/;
const ASKED_YES_NO = /^(are|do|does|have|has|will|would|can|could|is|did|were|was|may|should|shall)\b|\byes\s*(\/|or)\s*no\b|\(y\/n\)/;
const DATE_FORMAT = /\b(mm|dd)\s*[\/.-]\s*(dd|mm|yy|yyyy)\b|\bdate format\b|\bin (the )?format\b.*\b(dd|mm|yyyy)\b/;
function calendarOk(year: number, month: number | null, day: number | null): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || (month !== null && (month < 1 || month > 12))) return false;
  if (day === null) return true;
  if (month === null || !Number.isInteger(day) || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
type CalendarParts = { year: number; month: number | null; day: number | null };
function calendarParts(value: string, dayFirst = false): CalendarParts | null {
  let year: number, month: number | null = null, day: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})(?:[\/.-](\d{1,2})(?:[\/.-](\d{1,2}))?)?$/.exec(value))) [year, month, day] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null];
  else if ((m = /^(\d{1,2})[\/.-](\d{4})$/.exec(value))) [year, month] = [Number(m[2]), Number(m[1])];
  else if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(value))) [year, month, day] = [Number(m[3]), Number(m[dayFirst ? 2 : 1]), Number(m[dayFirst ? 1 : 2])];
  else if ((m = /^([a-z]+)\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/i.exec(value))) {
    const index = MONTHS.findIndex((s) => s.toLowerCase() === m![1].toLowerCase() || s.slice(0, 3).toLowerCase() === m![1].toLowerCase());
    if (index < 0) return null;
    [year, month, day] = [Number(m[3]), index + 1, m[2] ? Number(m[2]) : null];
  } else return null;
  return calendarOk(year, month, day) ? { year, month, day } : null;
}
type TypedField = Pick<FormField, "type" | "label" | "options" | "section">;
const dateFormat = (f: TypedField) => (f.section?.format || /\b(?:yyyy[-/.]mm(?:[-/.]dd)?|dd[-/.]mm[-/.]yyyy|mm[-/.]dd[-/.]yyyy|mm[-/.]yyyy|yyyy)\b/i.exec(normQuestion(f.label))?.[0] || "").toUpperCase();
// The stored question has no section column. Preserve known date precision in its existing type, rather than guessing
// from an ambiguous label such as "From". Options retain their original type and exact choice validation.
export function questionFieldType(f: TypedField): string {
  const type = String(f.type || "input_text");
  if (f.options?.length || type === "checkbox" || /file/.test(type) || type === "number") return type;
  const format = dateFormat(f);
  if (format === "YYYY") return "year";
  if (/^(?:MM[\/.-]YYYY|YYYY[\/.-]MM)$/.test(format) || /month and year|month\/year/i.test(f.label)) return "month";
  return type;
}
// The same typed check runs before saving and filling. A month/year can fill only a field asking for that precision;
// it never acquires an invented day. Stored answers keep the person's exact representation.
export function typedFieldProblem(f: TypedField, value: string): string | null {
  if (f.options.length || f.type === "checkbox" || /file/.test(f.type)) return null;
  const v = String(value).trim(), label = normQuestion(f.label);
  if (f.type === "number" && (!/^-?\d+(?:\.\d+)?$/.test(v) || !Number.isFinite(Number(v)))) return "needs a finite number, written as digits";
  // Some forms split a date into separately labelled components. Those explicit non-native fields take only
  // their stated component; a native date/month input still requires its complete declared precision.
  const component = !["date", "month", "year"].includes(f.type) && !f.section?.format
    ? /\bdate\s+(month|year)\s*[*:]?$/i.exec(label)?.[1] : null;
  if (component === "year") {
    const p = calendarParts(v);
    return /^\d{4}$/.test(v) && p && p.month === null ? null : "needs a valid four-digit year";
  }
  if (component === "month") {
    const valid = MONTHS.some((month) => month.toLowerCase() === v.toLowerCase()) || /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 12;
    return valid ? null : "needs a valid month only";
  }
  const format = dateFormat(f);
  const monthYear = /month and year|month\/year/i.test(label) || /^(?:MM[\/.-]YYYY|YYYY[\/.-]MM)$/.test(format) || f.type === "month";
  const yearOnly = format === "YYYY" || f.type === "year";
  const date = f.type === "date" || f.type === "month" || f.type === "year" || !!format || DATE_FORMAT.test(label) || (/\bdates?\b/.test(label) && !/up[- ]to[- ]date/.test(label));
  if (!date) return null;
  const p = calendarParts(v, /^DD/.test(format));
  if (!p || (yearOnly ? p.month !== null : monthYear ? p.month === null || p.day !== null : p.day === null)) {
    return yearOnly ? "needs a valid four-digit year" : monthYear ? "needs a valid month and year, without adding a day" : "needs a valid calendar date including month, day and four-digit year";
  }
  return null;
}
// Native date/month inputs require ISO, even when the person stated an equivalent named or slash-separated date.
// Only a fully validated, already-stated precision is reformatted. Segmented date widgets receive their declared
// part order, while the source and saved answer retain the person's exact words.
export function canonicalTypedValue(f: TypedField, value: string): string | null {
  if (typedFieldProblem(f, value)) return null;
  if (f.options.length) return value;
  const format = dateFormat(f);
  if (!f.section?.format && !["date", "month"].includes(f.type)) return value;
  const p = calendarParts(String(value).trim(), /^DD/.test(format));
  if (!p) return null;
  const year = String(p.year).padStart(4, "0"), month = p.month === null ? null : String(p.month).padStart(2, "0"), day = p.day === null ? null : String(p.day).padStart(2, "0");
  if (f.section?.format) {
    if (!/^(?:YYYY|MM[\/.-]YYYY|YYYY[\/.-]MM|YYYY[\/.-]MM[\/.-]DD|MM[\/.-]DD[\/.-]YYYY|DD[\/.-]MM[\/.-]YYYY)$/.test(format)) return null;
    if ((format.includes("MM") && month === null) || (format.includes("DD") && day === null)) return null;
    return format.replace(/YYYY|MM|DD/g, (part) => part === "YYYY" ? year : part === "MM" ? month! : day!);
  }
  if (month === null || (f.type === "date" && day === null)) return null;
  return f.type === "month" ? `${year}-${month}` : `${year}-${month}-${day}`;
}
const YES_NO_VALUE = /^(yes|no|y|n|true|false)$/i;
// WO-052 (an independent review of every fill on samples A and B):
// - A yes, a no or an "I agree" goes into a typed box only when the box asks a yes-or-no question, and only that: "If
//   you were referred, by who?", "In what countries do you have the right to work?", "Please confirm your situation:",
//   "Are you employed by Maven Clinic? If so, list your role" and "Are you local, or would you relocate?" are not.
// - A box that asks for a date takes only a date ("Start date of your most recent employer": "2 weeks" is not one).
const YES_NO_LIKE = /^(yes|no|y|n|true|false|i (agree|accept|acknowledge|consent|understand)\b.*|i am (not )?currently employed)$/i;
const COMPOUND = /\bif (so|yes|not|no|applicable|you (are|were|have|do|did|answered|selected))\b[^?]{0,80}\b(list|provide|describe|explain|specify|enter|state|indicate|give|share|tell|include)\b|\bplease (list|provide|describe|explain|specify|share|confirm your)\b|,? or (would|are|do|will|have|can|could) you\b/;
function asksYesNo(t: string): boolean {
  if (COMPOUND.test(t)) return false;
  const asked = t.split(/(?<=[.?!:])\s+/).filter((x) => x.trim().endsWith("?"));
  const q = (asked.length ? asked[asked.length - 1] : t.split(/(?<=[.!:])\s+/).pop() ?? t).trim();
  return ASKED_YES_NO.test(q) && !/\b(what|which|when|where|how|why|who)\b|%/.test(q);
}
export function fitsField(f: FormField, value: string, ownAnswer = false): boolean {
  if (typedFieldProblem(f, value)) return false;
  // An exact personal answer may be a terse "No" in an ordinary free-text box. Keep its words; only its explicit
  // numeric/date shape is imposed here. Derived answers still pass the semantic checks below.
  if (ownAnswer) return true;
  // A dropdown widget's value is chosen later among its own options (chooseWidgetOption), never typed (WO-052, live run).
  if (f.options.length || f.widget || f.type === "checkbox" || /file/.test(f.type)) return true;
  const t = normQuestion(f.label), v = String(value).trim();
  if (YES_NO_VALUE.test(v) && ASKS_DATA.test(t) && !ASKED_YES_NO.test(t)) return false;
  if (YES_NO_LIKE.test(v) && !asksYesNo(t)) return false;
  // WO-055: a box that says "y/n" or "yes/no" takes a yes or a no, never a fact's text ("U.S. Citizenship is required.
  // Are you able to meet this requirement? y/n" is not "United States").
  if (/\by\s*\/\s*n\b|\byes\s*\/\s*no\b|\(yes or no\)/i.test(f.label) && !YES_NO_VALUE.test(v)) return false;
  // WO-057: "What date are you available to begin (Month and Year)" takes a month and year, never "2 weeks".
  if (/\bdate\b/.test(t) && /\bmonth and year\b|\bmm\s*\/\s*yy/.test(t) && !/\b(19|20)\d\d\b/.test(v)) return false;
  return true;
}

// Greenhouse's education block (school--0, degree--0, discipline--0, end-month--0, end-year--0; WO-042, the live pages):
// "End date month" and "End date year" there are the graduation date the person stated. Only the first entry, beside its
// own school field, and only from that date: an end date anywhere else (a job's) is not the graduation date.
const EDU_END = /^end-(month|year)--0$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function educationEnd(f: FormField, fields: FormField[], answers: Record<string, Answer>): Answer | null {
  const m = EDU_END.exec(f.name);
  const g = answers.graduation_date;
  if (!m || !g || !fields.some((x) => x.name === "school--0")) return null;
  const s = String(g.value).trim();
  const year = /\b(19|20)\d{2}\b/.exec(s)?.[0] ?? null;
  const num = /^(\d{1,2})[\/.-](19|20)\d{2}$/.exec(s)?.[1] ?? /^(19|20)\d{2}-(\d{1,2})\b/.exec(s)?.[2] ?? null;
  const named = MONTHS.find((x) => new RegExp(`\\b${x.slice(0, 3)}`, "i").test(s)) ?? null;
  const month = num && Number(num) >= 1 && Number(num) <= 12 ? MONTHS[Number(num) - 1] : named;
  const value = m[1] === "year" ? year : month;
  return value ? { value, factId: g.factId } : null;
}

// WO-052: and a question that holds only under a condition on the person ("If you are under 18 years of age, can you
// provide proof...?"): its answer is not the person's general one.
const FOLLOW_UP = /^\s*(\(?\d+[a-z]?[.)]\s*)?if\s+(yes|no|so|not|other|applicable|you\s+(selected|answered|chose|checked|said)|you\s+(are|were)\s+(under|over|younger|older|a minor|not)\b)/i;

// ------------------------------------------------------------------------------------------------ repeating sections
// WO-048: a repeating section's rows (Workday's work experience, education, languages) are filled only from the person's
// own list, as they stated it: each job (employer, title, the dates they gave) from the work_history fact, the education
// they stated (school, degree, field, GPA, graduation date), each language with its level ("English (native)"). A part
// they never stated (a job's location, a start year, a role description) is left and asked; a date is never completed
// (a year never becomes a month). The reader names each field's row and part; nothing here reads a page.
export interface WorkEntry { employer: string; title: string; start: string; end: string; location: string; description: string }
const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
export function workEntries(answers: Record<string, Answer>): WorkEntry[] {
  const a = answers.work_history;
  if (!a) return [];
  let list: unknown;
  try {
    list = JSON.parse(String(a.value));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === "object").map((x: any) => ({
    employer: str(x.employer ?? x.company), title: str(x.title), start: str(x.start), end: str(x.end), location: str(x.location), description: str(x.description),
  })).filter((x) => x.employer);
}
const PRESENT = /^(present|current|now|today|ongoing)$/i;
export function educationEntries(answers: Record<string, Answer>) {
  return answers.school ? [{ school: str(answers.school.value) }] : [];
}
export function languageEntries(answers: Record<string, Answer>): { language: string; level: string }[] {
  const a = answers.languages;
  if (!a) return [];
  return String(a.value).split(/\s*[;,\n]\s*/).map((x) => {
    const m = /^([^()]+?)\s*(?:\(([^)]*)\))?$/.exec(x.trim());
    return m ? { language: m[1].trim(), level: (m[2] || "").trim().toLowerCase() } : null;
  }).filter((x): x is { language: string; level: string } => !!x && !!x.language);
}
// WO-048 round 2: a Websites (links) section takes the person's one link: only when they stated exactly one (a LinkedIn, a
// GitHub, a site; a URL as stated) and the form has no field of its own for that kind of link. Two links, or none: left.
const LINK_FACTS = ["linkedin", "github", "website", "portfolio"];
export function linkEntries(answers: Record<string, Answer>, fields: FormField[] = []): { kind: string; url: string }[] {
  const links = LINK_FACTS.filter((k) => answers[k] && /^https?:\/\/\S+$/i.test(str(answers[k].value))).map((k) => ({ kind: k, url: str(answers[k].value) }));
  if (links.length !== 1) return [];
  const own = fields.some((f) => !f.section && !f.personal && (classifyField(f.label, f.type) === links[0].kind || mapQuestion(f).fact === links[0].kind));
  return own ? [] : links;
}
const anchorOf = (kind: string, answers: Record<string, Answer>, fields?: FormField[]): string[] =>
  kind === "work" ? workEntries(answers).map((e) => e.employer) : kind === "education" ? educationEntries(answers).map((e) => e.school)
    : kind === "language" ? languageEntries(answers).map((e) => e.language) : kind === "website" && fields ? linkEntries(answers, fields).map((e) => e.url) : [];
const sameAnchor = (a: string, b: string) => normCompany(a) !== "" && normCompany(a) === normCompany(b);
// A row Workday filled with nearly an entry's name ("Example Analytic" for "Example Analytics", "Sample Retail Inc"): it
// may be that entry, or not. Trainee neither fills it nor adds a second row for the entry (no duplicate job): the person
// checks it.
function nearAnchor(a: string, b: string): boolean {
  const x = normCompany(a), y = normCompany(b);
  if (!x || !y || x === y) return false;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  if (Math.min(x.length, y.length) < 6 || Math.abs(x.length - y.length) > 2) return false;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return d[x.length][y.length] <= 2;
}
// Which of the person's entries each row holds: a row whose anchor (its company, school or language, as the page shows
// it) names an entry is that entry's; an empty row takes the next entry no row names or nearly names; a row naming
// something else is nobody's (Trainee leaves it).
function assignRows(kind: string, rows: { row: number; anchor: string }[], answers: Record<string, Answer>, fields: FormField[]): Map<number, number> {
  const entries = anchorOf(kind, answers, fields), out = new Map<number, number>(), taken = new Set<number>();
  for (const r of rows) {
    const i = r.anchor ? entries.findIndex((e, j) => !taken.has(j) && sameAnchor(e, r.anchor)) : -1;
    if (i >= 0) {
      out.set(r.row, i);
      taken.add(i);
    }
  }
  for (const r of rows) {
    const i = r.anchor && !out.has(r.row) ? entries.findIndex((e, j) => !taken.has(j) && nearAnchor(e, r.anchor)) : -1;
    if (i >= 0) taken.add(i); // nearly this entry: nobody fills the row, and no other row takes the entry
  }
  for (const r of rows) {
    if (r.anchor || out.has(r.row)) continue;
    const i = entries.findIndex((_, j) => !taken.has(j));
    if (i < 0) break;
    out.set(r.row, i);
    taken.add(i);
  }
  return out;
}
// How many rows a section needs added: one per stated entry no row holds yet, less the empty rows already there. A links
// section needs the form's fields (a link the form asks for on its own is not added again); without them, none.
export function rowsToAdd(kind: string, anchors: string[], answers: Record<string, Answer>, fields?: FormField[]): number {
  const entries = anchorOf(kind, answers, fields);
  const held = new Set<number>();
  for (const a of anchors) {
    const i = a ? entries.findIndex((e, j) => !held.has(j) && sameAnchor(e, a)) : -1;
    if (i >= 0) held.add(i);
  }
  for (const a of anchors) {
    const i = a && !entries.some((e) => sameAnchor(e, a)) ? entries.findIndex((e, j) => !held.has(j) && nearAnchor(e, a)) : -1;
    if (i >= 0) held.add(i);
  }
  return Math.max(0, entries.length - held.size - anchors.filter((a) => !a).length);
}
// A stated date in the field's own format, never completed: "06/2022" or "2022-06" or "June 2022" fills MM/YYYY and YYYY;
// a bare year fills only YYYY; MM/DD/YYYY needs a stated day.
function statedDate(value: string, format = "MM/YYYY"): string | null {
  const v = value.trim();
  let y: string | null = null, m: string | null = null, d: string | null = null;
  let x: RegExpExecArray | null;
  if ((x = /^(\d{1,2})[\/.-](\d{1,2})[\/.-]((?:19|20)\d{2})$/.exec(v))) [m, d, y] = [x[1], x[2], x[3]];
  else if ((x = /^(\d{1,2})[\/.-]((?:19|20)\d{2})$/.exec(v))) [m, y] = [x[1], x[2]];
  else if ((x = /^((?:19|20)\d{2})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v))) [y, m, d] = [x[1], x[2], x[3] ?? null];
  else if ((x = /^((?:19|20)\d{2})$/.exec(v))) y = x[1];
  else {
    const i = MONTHS.findIndex((n) => new RegExp(`^${n.slice(0, 3)}[a-z]*\\.?\\s+((?:19|20)\\d{2})$`, "i").test(v));
    if (i >= 0) [m, y] = [String(i + 1), /\d{4}/.exec(v)![0]];
  }
  if (!y || !calendarOk(Number(y), m === null ? null : Number(m), d === null ? null : Number(d))) return null;
  const mm = m && m.padStart(2, "0"), dd = d && d.padStart(2, "0");
  const f = format.toUpperCase();
  if (f === "YYYY") return y;
  if (f === "MM/YYYY") return y && mm ? `${mm}/${y}` : null;
  if (f === "MM/DD/YYYY") return y && mm && dd ? `${mm}/${dd}/${y}` : null;
  if (f === "DD/MM/YYYY") return y && mm && dd ? `${dd}/${mm}/${y}` : null;
  return null;
}
// A row field with options takes only the option that is the stated value itself (a field of study or a language is never
// the nearest-sounding option).
// A list is answered by the stated value exactly as an option, or as the one leaf of that name under a category
// ("Mathematics & Statistics > Statistics", Workday's prompt; WO-058, sealed-wd3 t2).
const pick = (_fact: string, value: string, f: FormField) => {
  if (!f.options.length) return value || null;
  const v = value.toLowerCase(), say = (o: { label: string }) => o.label.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = f.options.find((o) => say(o) === v);
  if (exact) return exact.value;
  const leaf = f.options.filter((o) => / > /.test(o.label) && say(o).split(/\s+>\s+/).pop() === v);
  return leaf.length === 1 ? leaf[0].value : null;
};
const FLUENT = /^(native|fluent|bilingual|mother tongue|first language)$/;
function sectionAnswer(f: FormField, entry: number | undefined, answers: Record<string, Answer>, fields: FormField[]): Answer | null {
  const s = f.section!;
  if (entry === undefined) return null;
  const out = (value: string | null, factId: string | undefined) => (value && factId ? { value, factId } : null);
  if (s.kind === "work") {
    const e = workEntries(answers)[entry], id = answers.work_history?.factId;
    if (!e) return null;
    const current = PRESENT.test(e.end);
    switch (s.part) {
      case "title": return out(e.title, id);
      case "employer": return out(e.employer, id);
      case "location": return out(e.location, id);
      case "description": return out(e.description, id);
      case "start": return out(e.start ? statedDate(e.start, s.format) : null, id);
      case "end": return out(e.end && !current ? statedDate(e.end, s.format) : null, id);
      case "current": return out(current ? "Yes" : e.end ? "No" : null, id);
    }
    return null;
  }
  if (s.kind === "education") {
    if (entry !== 0) return null;
    const a = (k: string) => answers[k];
    switch (s.part) {
      case "school": {
        // A school list is answered only by the school exactly as stated (never "Example State University Online").
        const s = str(a("school")?.value);
        const v = f.options.length ? f.options.find((o) => o.label.trim().toLowerCase() === s.toLowerCase())?.value ?? null : s;
        return a("school") ? out(v, a("school")!.factId) : null;
      }
      case "degree": return a("education_level") && f.options.length ? out(chooseOption("education_level", String(a("education_level")!.value), f.options), a("education_level")!.factId) : null;
      case "major": return a("major") ? out(pick("major", str(a("major")!.value), f), a("major")!.factId) : null;
      case "gpa": return a("gpa") && !f.options.length ? out(str(a("gpa")!.value), a("gpa")!.factId) : null;
      case "end": return a("graduation_date") ? out(statedDate(String(a("graduation_date")!.value), s.format), a("graduation_date")!.factId) : null;
    }
    return null;
  }
  if (s.kind === "website") {
    const e = linkEntries(answers, fields)[entry];
    return s.part === "url" && e && !f.options.length ? out(e.url, answers[e.kind]?.factId) : null;
  }
  if (s.kind === "language") {
    const e = languageEntries(answers)[entry], id = answers.languages?.factId;
    if (!e) return null;
    const fluent = FLUENT.test(e.level);
    switch (s.part) {
      case "language": return out(pick("languages", e.language, f), id);
      case "fluent": return out(fluent ? "Yes" : null, id);
      case "proficiency":
        // Native onto "Native" beside "Fluent" (round 2), fluent onto "Fluent"; nothing for a level never stated.
        return fluent ? out(levelOption(e.level, f.options), id) : null;
    }
  }
  return null;
}
// WO-048 round 3 (sealed-wd2 t4: a past job's Location, id `workExperience-31--location`, took the person's home city): a
// field whose name is Workday's id for a part of a repeating section's row ("<section>-<n>--<part>": work experience,
// education, languages, websites) is a row's part even when no reader said so.
const ROW_PART_NAME = /^(workExperience|education|languages?|websites?|webAddress(?:es)?)(?:Section)?-\d+--/i;
export const rowPartName = (f: FormField) => ROW_PART_NAME.test(String(f.name ?? ""));
// WO-048: a phone number beside the form's own country code field is the national number. The code the form shows must
// be the person's own ("+1" for "+1 555 010 0000"); another code, or none chosen yet, leaves the number to the person.
function nationalNumber(value: string, dial: string): string | null {
  const v = value.trim();
  if (!v.startsWith("+")) return v;
  const code = dial.replace(/[^\d]/g, "");
  if (!code) return null;
  const digits = v.slice(1).replace(/^[\s(]*/, "");
  if (!digits.startsWith(code)) return null;
  const rest = digits.slice(code.length).replace(/^[\s)\-.]+/, "").trim();
  return /\d{4,}/.test(rest.replace(/[^\d]/g, "")) ? rest : null;
}
export function planBatch(o: { userId: string; postings: PlanPosting[]; answers: Record<string, Answer>; saved: Record<string, Answer>; log: LogRow[]; now: number; limits?: Limits }) {
  const ready: { job_id: string; company: string; title: string; fields: PlannedField[] }[] = [];
  const needs = new Map<string, { label: string; key: string; required: boolean; job_ids: string[]; field_name?: string }>();
  const skipped: { job_id: string; reason: string }[] = [];
  const log = o.log.slice();
  for (const p of o.postings) {
    const admit = admitApplication(log, { user_id: o.userId, job_id: p.job_id, company: p.company, url: p.url }, o.now, o.limits);
    if (!admit.ok) { skipped.push({ job_id: p.job_id, reason: admit.reason! }); continue; }
    const filled: PlannedField[] = [];
    let blocked = false;
    // WO-048: each repeating section's rows, matched to the person's own entries (only when the reader named sections).
    const rowsOf = new Map<string, Map<number, number>>();
    for (const kind of new Set(p.fields.filter((f) => f.section).map((f) => f.section!.kind))) {
      const rows = new Map<number, string>();
      // A row 0 is a section's field the reader could tie to no row (round 3): it takes none of the person's entries.
      for (const f of p.fields) if (f.section?.kind === kind && f.section.row >= 1 && !rows.has(f.section.row)) rows.set(f.section.row, String(f.section.anchor ?? ""));
      rowsOf.set(kind, assignRows(kind, [...rows].map(([row, anchor]) => ({ row, anchor })), o.answers, p.fields));
    }
    const places = formPlaces(p.fields, p.company), where = postingPlaces(p.location ?? "");
    for (const f of p.fields) {
      if (fileAlternative(f, p.fields)) continue;
      if (f.personal) continue; // the person's own form: never planned (WO-048)
      if (f.section || rowPartName(f)) {
        // WO-048 round 3: a field the form names as one part of a repeating section's row is answered only from the person's
        // own list, by the row the reader tied it to; with no row it is left (asked when required). Never a fact about the
        // person as a whole (their city, phone, email, name, current employer), never an answer saved under its wording.
        // A direct answer belongs only to this exact posting/field/row snapshot. Neither its displayed wording nor a
        // global date fact may stand in for that binding. An invalid newer answer stays open instead of restoring an
        // older history value; absent a scoped answer, the original structured-history derivation remains unchanged.
        const rowKey = rowAnswerKey(f, p.job_id);
        const scoped: Answer | undefined = rowKey ? o.saved[rowKey] : undefined;
        const s = scoped ?? (f.section && f.section.row >= 1 ? sectionAnswer(f, rowsOf.get(f.section.kind)?.get(f.section.row), o.answers, p.fields) : null);
        const value = s ? (f.options.length && scoped ? matchOption(String(s.value), f.options)
          : scoped && f.type === "checkbox" ? yesNo(String(s.value)) : String(s.value)) : null;
        const shaped = value !== null && fitsField(f, value, !!scoped) ? canonicalTypedValue(f, value) : null;
        if (s && shaped !== null) { filled.push({ name: f.name, label: f.label, value: shaped, factId: s.factId }); continue; }
        if (!f.required) continue;
        blocked = true;
        const k = rowKey ?? normLabel(f.label);
        const n = needs.get(k) ?? { label: f.label, key: "unknown", required: true, job_ids: [], field_name: f.name };
        if (!n.job_ids.includes(p.job_id)) n.job_ids.push(p.job_id);
        needs.set(k, n);
        continue;
      }
      // WO-059 (sample H, Upvest): "Name" beside the form's own "Last name" box asks for the first name.
      const keyed = classifyField(f.label, f.type);
      const key = keyed === "full_name" && /^\s*name\s*[*:]?\s*$/i.test(f.label) && p.fields.some((x) => x !== f && classifyField(x.label, x.type) === "last_name") ? "first_name" : keyed;
      const followUp = FOLLOW_UP.test(f.label);
      // An answer the person texted for this question (ask once) comes first, under the key that says how far it may go:
      // this posting, then this wording (a fact for every employer arrives in `answers` instead).
      const here = factStaysHere(f, p.location, o.answers);
      const own: Answer | undefined = o.saved[answerKey(f, p.job_id, { haveFact: true, here })] ?? o.saved[answerKey(f, p.job_id, { here })] ?? o.saved[normLabel(f.label)];
      const direct: Answer | undefined = o.saved[answerKey(f, p.job_id, { haveFact: true, here })] ?? o.saved[answerKey(f, p.job_id, { here })] ??
        (key !== "unknown" && key !== "eeo" && !followUp && !otherCountry(key, placeText(f), p.location, homeInUs(o.answers)) && !beyondFact(key, f) ? o.answers[key] : undefined) ?? o.saved[normLabel(f.label)];
      let a: Answer | undefined = direct;
      let value: string | null = a ? String(a.value) : null;
      if (value !== null && f.options.length) value = matchOption(value, f.options) ?? (key !== "unknown" && direct === o.answers[key] ? chooseOption(key, value, f.options, f.label) : null);
      if (value === null && !direct) {
        const e = educationEnd(f, p.fields, o.answers);
        if (e) { a = e; value = f.options.length ? matchOption(e.value, f.options) : e.value; }
      }
      // A fact the keyword classifier picked that fits none of the options (the long "U.S. person" explanation names
      // "citizen") gives way to the meaning map, as no answer at all does (WO-042, Snowflake).
      if (value === null && (!direct || direct === o.answers[key]) && !followUp) {
        const m = byMeaning(f, p.company, o.answers, places, where, p.location);
        if (m) { a = m; value = m.value; }
      }
      if (value !== null && f.dial !== undefined && a !== own && (key === "phone" || mapQuestion(f).fact === "phone")) value = nationalNumber(value, f.dial);
      // WO-048: a phone's country code list ("United States of America (+1)") answered from the country is right only when
      // the person's own phone carries that code.
      if (value !== null && a !== own && f.options.length && /\b(phone|dial(l?ing)?) code\b|\bcountry (phone |calling )?code\b/i.test(f.label)) {
        const shown = f.options.find((x) => x.value === value)?.label ?? value;
        const code = /\(\s*\+\s*(\d{1,4})\s*\)/.exec(shown)?.[1];
        const phone = String(o.answers.phone?.value ?? "").trim();
        if (!code || !phone.startsWith("+") || !phone.replace(/\D/g, "").startsWith(code)) value = null;
      }
      if (value !== null && a !== own && !f.options.length) value = payShape(f, value, key !== "unknown" ? key : mapQuestion(f).fact, o.answers);
      const shaped = value !== null && value !== "" && fitsField(f, value, a === own) ? canonicalTypedValue(f, value) : null;
      if (shaped !== null) { filled.push({ name: f.name, label: f.label, value: shaped, factId: a!.factId }); continue; }
      if (!f.required) continue; // optional and unknown: left empty, never guessed
      blocked = true;
      const k = normLabel(f.label);
      const n = needs.get(k) ?? { label: f.label, key, required: true, job_ids: [] };
      if (!n.job_ids.includes(p.job_id)) n.job_ids.push(p.job_id);
      needs.set(k, n);
    }
    if (blocked) { skipped.push({ job_id: p.job_id, reason: "needs_answers" }); continue; }
    ready.push({ job_id: p.job_id, company: p.company, title: p.title, fields: filled });
    log.push({ user_id: o.userId, job_id: p.job_id, company: p.company, url: p.url, at: o.now, state: "planned" });
  }
  return { ready, needs: [...needs.values()].map(({ label, key, job_ids, field_name }) => ({ label, key, job_ids, ...(field_name !== undefined ? { field_name } : {}) })), skipped };
}
