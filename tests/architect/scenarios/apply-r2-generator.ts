// Round 2 of the apply and mass-submission scenarios (tests/architect/scenarios-apply-r2*.test.ts, every scenario on the
// real code in memory; tests/architect/flow-scenarios-apply-r2.test.ts, a seeded sample on real Postgres). Fresh seeds,
// and the categories round 1 (apply-generator.ts, file-apply-generator.ts) does not cover. Seeded: a run is the same run
// every time, and a failure names its input. No network, no model, no Chromium.
//   forms      an employer's application form (fields drawn from a pool, in English, German, French or Spanish, in any
//              order, on one to three pages) and one hostile turn: a field renamed, reordered, added or an option removed
//              between the person's yes and the submit; a password box; an identity number (SSN, SIN, Aadhaar, PESEL,
//              passport, ID card, IBAN ...); a date of birth, demographics or salary history; hidden fields set by the page
//              (benign, or consenting for the person); a honeypot (by its words, or hidden from people and placed off the
//              page); a verification check at open, after Next, at the click or after the application went; the posting
//              or the thank-you redirecting to LinkedIn, Indeed or Handshake; the site refusing for load at open; the
//              page's script rewriting an answer, adding a field or swapping the file at the click; a box whose maxlength
//              is shorter than the answer; the page reformatting an answer as it is typed; the resume or a fact changed
//              after the yes; the approved run started twice. And what the employer's page says after the one request:
//              thanks (with or without a confirmation number), nothing (moved or not), the form again, validation errors,
//              "you already applied", an error in thank-you words, a thank-you in another language, an emailed code, a 500
//   outcomes   the page after the one application request as an observation (text, url, form, check, code), for the
//              engine's judge
//   labels     identity-number questions in many countries' terms and phrasings, sensitive questions (birth date, age,
//              demographics, salary history), honeypot wordings, and controls that must still be answered
//   integrity  an approved application and what can change after the yes: the resume file, an answer, an added answer,
//              the payload's hash, the approval
//   scale      one person and 2,000 postings, 2,000 people and ten each, with the same job on two boards and one
//              employer through two application systems; hosts that refuse for load in storms; workers killed at each step
//              (claim, start, engine, after the send before the record); the record's write failing or landing twice
import { rng, type R } from "../scenarios-fixture.ts";
export { rng };
export type { R };

export const NOW = Date.parse("2026-10-30T15:00:00Z");
export const SEED = 20261030;
export function sample<T>(r: R, xs: T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = r.int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// ------------------------------------------------------------------------------------------------ the person
// Facts every generated person confirmed (owner-stated, each with its confirmation event), and the optional ones.
export const CORE_FACTS = ["first_name", "last_name", "email"] as const;
export const OPTIONAL_FACTS = ["phone", "linkedin", "website", "sponsorship", "work_authorization", "salary_expectation", "city"] as const;
export type FactKey = typeof CORE_FACTS[number] | typeof OPTIONAL_FACTS[number];
const FIRST = ["Test", "Ana", "Wei", "Priya", "Jordan", "Sam", "Noor", "Luis"];
const LAST = ["Person", "Okafor", "Nguyen", "Patel", "Lee", "Garcia", "Kowalski", "Haddad"];
export interface Person { id: string; facts: Partial<Record<FactKey, string>> }
export function person(r: R, n: number): Person {
  const f = r.pick(FIRST), l = r.pick(LAST);
  const facts: Partial<Record<FactKey, string>> = { first_name: f, last_name: l, email: `${f.toLowerCase()}.${l.toLowerCase()}${n}@example.test` };
  if (r.next() < 0.8) facts.phone = `+1 555 01${String(r.int(0, 99)).padStart(2, "0")}`;
  if (r.next() < 0.7) facts.linkedin = `https://www.linkedin.com/in/${f.toLowerCase()}-${l.toLowerCase()}-${n}`;
  if (r.next() < 0.6) facts.website = `https://${f.toLowerCase()}${n}.example.test`;
  if (r.next() < 0.8) facts.sponsorship = r.pick(["No", "Yes"]);
  if (r.next() < 0.7) facts.work_authorization = "Yes";
  if (r.next() < 0.7) facts.salary_expectation = `$${r.int(60, 160)},000`;
  if (r.next() < 0.6) facts.city = r.pick(["Austin", "Chicago", "Seattle", "Boston"]);
  return { id: `00000000-0000-4000-8000-${String(900000 + n).padStart(12, "0")}`, facts };
}

// ------------------------------------------------------------------------------------------------ forms
export type Lang = "en" | "de" | "fr" | "es";
export type FieldKind = FactKey | "resume" | "why" | "hear";
export interface FieldSpec { kind: FieldKind | string; name: string; id: string; label: string; type: "text" | "email" | "tel" | "file" | "textarea" | "select" | "radio" | "checkbox" | "password" | "date"; required: boolean;
  options?: { label: string; value: string }[]; maxlength?: number; honeypot?: "words" | "dom"; page: number }
const LABELS: Record<Lang, Partial<Record<FieldKind, string[]>>> = {
  en: { first_name: ["First name", "First Name", "Given name", "First name *"], last_name: ["Last name", "Last Name", "Surname", "Family name"], email: ["Email", "Email address", "E-mail"],
    phone: ["Phone", "Phone number", "Mobile phone"], linkedin: ["LinkedIn Profile", "LinkedIn URL", "LinkedIn"], website: ["Website", "Portfolio", "Personal website"],
    sponsorship: ["Will you now or in the future require visa sponsorship?", "Do you require sponsorship to work in the US?"],
    work_authorization: ["Are you legally authorized to work in the United States?"], salary_expectation: ["Desired salary", "Salary expectations", "Expected salary"],
    city: ["City", "City:"], resume: ["Resume/CV", "Resume", "CV", "Upload your resume"], why: ["Why do you want to work here?", "Why are you interested in this role?"],
    hear: ["How did you hear about us?"] },
  de: { first_name: ["Vorname"], last_name: ["Nachname"], email: ["E-Mail-Adresse"], phone: ["Telefonnummer"], resume: ["Lebenslauf"], city: ["Wohnort"], why: ["Warum möchten Sie bei uns arbeiten?"] },
  fr: { first_name: ["Prénom"], last_name: ["Nom de famille"], email: ["Adresse e-mail"], phone: ["Téléphone"], resume: ["CV (curriculum vitae)"], city: ["Ville"], why: ["Pourquoi voulez-vous nous rejoindre ?"] },
  es: { first_name: ["Nombre"], last_name: ["Apellidos"], email: ["Correo electrónico"], phone: ["Teléfono"], resume: ["Currículum"], city: ["Ciudad"], why: ["¿Por qué quieres trabajar con nosotros?"] },
};
export type Twist =
  | "none" | "rename_label" | "reorder" | "add_required" | "add_optional" | "remove_option" | "rename_name"
  | "password" | "identity" | "sensitive" | "hidden_benign" | "hidden_consent" | "honeypot_words" | "honeypot_dom"
  | "captcha_open" | "captcha_next" | "captcha_click" | "captcha_after" | "redirect_open" | "redirect_after"
  | "refuse_open" | "click_rewrite" | "click_add_field" | "click_swap_file" | "maxlength" | "reformat" | "resume_swap"
  | "fact_edit" | "other_approval" | "twice" | "back_nav";
export type After = "thanks" | "thanks_id" | "moved_silent" | "same_silent" | "form_again" | "errors" | "dup" | "error_words" | "foreign_thanks" | "email_code" | "http500";
export const TWISTS: Twist[] = ["none", "rename_label", "reorder", "add_required", "add_optional", "remove_option", "rename_name", "password", "identity", "sensitive",
  "hidden_benign", "hidden_consent", "honeypot_words", "honeypot_dom", "captcha_open", "captcha_next", "captcha_click", "captcha_after", "redirect_open", "redirect_after",
  "refuse_open", "click_rewrite", "click_add_field", "click_swap_file", "maxlength", "reformat", "resume_swap", "fact_edit", "other_approval", "twice", "back_nav"];
export const AFTERS: After[] = ["thanks", "thanks_id", "moved_silent", "same_silent", "form_again", "errors", "dup", "error_words", "foreign_thanks", "email_code", "http500"];
// Identity numbers, the way forms around the world ask for them (never filled, never asked by text, never kept).
export const IDENTITY_LABELS = [
  "Social Security Number", "SSN", "Last 4 digits of SSN", "Social Security # (for background check)", "Social Insurance Number (SIN)", "SIN", "Social insurance number",
  "National Insurance number", "NI number", "National ID number", "National identification number", "Aadhaar number", "Aadhar Number", "PAN card number",
  "PESEL", "Personnummer", "CPF", "CURP", "NRIC", "BSN (Burgerservicenummer)", "DNI / NIE", "PPS number", "Tax File Number (TFN)", "Passport #", "Passport number",
  "Passport No.", "Driver's license number", "Driver's Licence #", "ID card number", "Identity card no.", "Government-issued ID number", "Tax ID", "Taxpayer ID", "ITIN",
  "Alien registration number", "A-Number", "IBAN", "Bank account number", "Routing number", "Sort code", "Credit card number",
];
// Questions about the person that only their own confirmed answer to that exact question may fill.
export const SENSITIVE_LABELS = [
  "Date of birth", "Date of Birth (MM/DD/YYYY)", "Birthdate", "Age", "How old are you?", "Gender", "Race / Ethnicity", "Veteran status", "Disability status",
  "Salary history", "Your salary history", "What is your current salary?", "Current compensation", "Previous salary", "Prior salary", "Last salary", "Past salary",
  "What was your salary at your last job?", "Previous compensation", "Salary history (last three positions)", "Compensation history", "Mother's maiden name", "Marital status",
  "Religion", "Sexual orientation", "Height and weight",
];
// The words a form uses to hide a field from robots: never filled.
export const HONEYPOT_WORDS = ["Website (leave blank)", "Leave this field blank", "Leave this field empty", "Do not fill this in", "If you are human, leave this blank",
  "Don't fill this out if you're human", "Phone (leave empty)", "Email (do not fill)", "Leave blank: website", "Do not enter anything here"];
const HONEYPOT_DOM_LABELS = ["Website", "Phone", "Email address", "LinkedIn URL", "Company"];
export const REDIRECT_TARGETS = ["https://www.linkedin.com/jobs/view/3812345678/", "https://linkedin.com/jobs/view/42", "https://www.indeed.com/viewjob?jk=abc123",
  "https://uk.indeed.com/viewjob?jk=9f8e", "https://app.joinhandshake.com/stu/jobs/12345", "https://nyu.joinhandshake.com/jobs/777", "https://evil.example.net/apply"];
export const RETRY_AFTER = ["30", "120", "0", "86400", "Fri, 30 Oct 2026 15:10:00 GMT", "soon", "", "-5", "1.5"];

export interface FormCase {
  n: number; twist: Twist; after: After; lang: Lang; person: Person; fields: FieldSpec[]; hidden: [string, string][]; pages: number;
  posting: string; action: "same" | "other"; extraLabel?: string; extraRequired?: boolean; redirect?: string; refuse?: { status: number; retryAfter: string };
  why?: string; whyMax?: number; employer: string;
}
const EMPLOYERS = ["acme", "contoso", "northwind", "fabrikam", "tailspin", "wingtip", "adatum", "litware"];
const rid = (r: R, p: string) => `${p}${r.int(100, 999)}${"abcdefghij"[r.int(0, 9)]}`;
// One form: the person's answerable fields first chosen, then the twist's own field, all shuffled and paged.
export function formCase(r: R, n: number): FormCase {
  const twist: Twist = r.next() < 0.1 ? "none" : TWISTS[n % TWISTS.length];
  const after = twist === "none" || twist === "twice" || twist === "hidden_benign" ? AFTERS[(n >> 5) % AFTERS.length] : r.pick(AFTERS);
  const lang: Lang = twist === "none" && r.next() < 0.2 ? r.pick(["de", "fr", "es"]) : "en";
  const p = person(r, n);
  const employer = r.pick(EMPLOYERS);
  const fields: FieldSpec[] = [];
  const add = (kind: FieldKind | string, label: string, type: FieldSpec["type"], required: boolean, extra: Partial<FieldSpec> = {}) => {
    const name = r.next() < 0.5 ? `${String(kind).replace(/[^a-z_]/g, "")}_${r.int(10, 99)}` : `question_${r.int(1000000, 9999999)}`;
    fields.push({ kind, name, id: r.next() < 0.85 ? `${rid(r, "f")}_${fields.length}` : "", label, type, required, page: 0, ...extra });
  };
  const L = LABELS[lang];
  for (const k of CORE_FACTS) add(k, r.pick(L[k] ?? LABELS.en[k]!), k === "email" ? "email" : "text", true);
  add("resume", r.pick(L.resume ?? LABELS.en.resume!), "file", true);
  for (const k of OPTIONAL_FACTS) {
    if (r.next() < 0.45) continue;
    const has = p.facts[k] !== undefined;
    const required = has && r.next() < 0.5;
    if (k === "sponsorship" || k === "work_authorization") {
      const opts = [{ label: "Yes", value: r.next() < 0.5 ? "1" : "Yes" }, { label: "No", value: r.next() < 0.5 ? "0" : "No" }];
      const radio = r.next() < 0.5;
      add(k, r.pick(LABELS.en[k]!), radio ? "radio" : "select", required, { options: radio ? opts : [{ label: r.pick(["Select...", "Please select", "--"]), value: "" }, ...opts] });
      continue;
    }
    add(k, r.pick(L[k] ?? LABELS.en[k] ?? [k]), k === "phone" ? "tel" : "text", required);
  }
  const c: FormCase = { n, twist, after, lang, person: p, fields, hidden: [], pages: 1, posting: `http://127.0.0.1:${8100 + (n % 50)}/${employer}/jobs/${100000 + n}`,
    action: r.next() < 0.5 ? "same" : "other", employer };
  if (r.next() < 0.3) { c.why = "I want to build tools for analysts. ".repeat(r.int(2, 6)).trim(); add("why", r.pick(L.why ?? LABELS.en.why!), "textarea", r.next() < 0.5); }
  if (r.next() < 0.3) c.hidden.push(["csrf_token", rid(r, "tok")]);
  if (r.next() < 0.2) c.hidden.push(["job_id", String(100000 + n)]);
  switch (twist) {
    case "identity": c.extraLabel = r.pick(IDENTITY_LABELS); c.extraRequired = r.next() < 0.7; add("identity", c.extraLabel, "text", c.extraRequired); break;
    case "sensitive": c.extraLabel = r.pick(SENSITIVE_LABELS); c.extraRequired = r.next() < 0.5; add("sensitive", c.extraLabel, /birth/i.test(c.extraLabel) && r.next() < 0.5 ? "date" : "text", c.extraRequired); break;
    case "password": add("password", r.pick(["Password", "Create a password", "Choose a password"]), "password", true); break;
    case "honeypot_words": c.extraLabel = r.pick(HONEYPOT_WORDS); add("honeypot", c.extraLabel, "text", false, { honeypot: "words" }); break;
    case "honeypot_dom": c.extraLabel = r.pick(HONEYPOT_DOM_LABELS); add("honeypot", c.extraLabel, "text", false, { honeypot: "dom" }); break;
    case "hidden_benign": c.hidden.push([r.pick(["csrf_token", "authenticity_token", "utm_source", "source", "locale"]), rid(r, "v")]); break;
    case "hidden_consent": c.hidden.push([r.pick(["agree_terms", "marketing_opt_in", "privacy_consent", "newsletter", "consent_to_texts"]), r.pick(["1", "true", "yes", "on"])]); break;
    case "maxlength": c.why = "I have spent three years building dashboards for operations teams and I want to keep doing that here. ".repeat(r.int(2, 5)).trim();
      c.whyMax = r.int(40, c.why.length - 1); add("why", r.pick(LABELS.en.why!), "textarea", true, { maxlength: c.whyMax }); break;
    case "redirect_open": case "redirect_after": c.redirect = r.pick(REDIRECT_TARGETS); break;
    case "refuse_open": c.refuse = { status: r.pick([429, 503]), retryAfter: r.pick(RETRY_AFTER) }; break;
    case "captcha_next": case "back_nav": c.pages = 2; break;
    default: break;
  }
  if (twist === "remove_option") {
    // The option removed is the person's own answer: every choice field here is one they answered.
    if (!fields.some((f) => f.options)) add("sponsorship", LABELS.en.sponsorship![0], "radio", true, { options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }] });
    for (const f of fields.filter((x) => x.options)) if (!p.facts[f.kind as FactKey]) p.facts[f.kind as FactKey] = f.kind === "work_authorization" ? "Yes" : "No";
  }
  // Shuffle (the resume and names stay where the generator put them only by chance), then page.
  const shuffled = sample(r, fields, fields.length);
  c.fields = shuffled;
  if (c.pages === 1 && r.next() < 0.25) c.pages = r.int(2, 3);
  c.fields.forEach((f, i) => { f.page = Math.min(c.pages - 1, Math.floor(i * c.pages / c.fields.length)); });
  return c;
}
export function formCases(seed: number, count: number): FormCase[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, n) => formCase(r, n));
}

// ------------------------------------------------------------------------------------------------ outcomes
// What the page shows after the one application request went and the employer answered it.
export const THANKS: Record<Lang, string[]> = {
  en: ["Thank you for applying!", "Your application has been submitted.", "We've received your application.", "Application submitted successfully.", "Thank you for your application to {c}."],
  de: ["Vielen Dank für Ihre Bewerbung!", "Ihre Bewerbung wurde erfolgreich übermittelt."],
  fr: ["Merci pour votre candidature !", "Votre candidature a bien été envoyée."],
  es: ["¡Gracias por tu postulación!", "Hemos recibido tu solicitud."],
};
export const DUP = ["You have already applied to this job.", "It looks like you've already applied for this position. We have received your application.", "Duplicate application: an application with this email already exists.",
  "You already submitted an application for this role. Thank you for applying!", "Our records show you have previously applied to this posting."];
export const ERROR_WORDS = ["Thank you for applying. Unfortunately an error occurred and your application could not be submitted. Please try again.",
  "Something went wrong. Your application was not submitted.", "Thank you for your application. We were unable to process it; please try again later.",
  "Application failed: please try again.", "Thanks for applying! Submission failed due to a server error."];
export interface OutcomeCase { n: number; kind: After | "captcha" | "code_and_thanks"; obs: { url_before: string; url_after: string; form_present_after: boolean; required_empty_after: number;
  validation_errors: string[]; captcha: boolean; email_code_prompt: boolean; page_text: string }; expect: string[] }
export function outcomeCases(seed: number, count: number): OutcomeCase[] {
  const r = rng(seed);
  const out: OutcomeCase[] = [];
  const kinds = [...AFTERS.filter((a) => a !== "http500"), "captcha", "code_and_thanks"] as OutcomeCase["kind"][];
  for (let n = 0; n < count; n++) {
    const kind = kinds[n % kinds.length];
    const before = `https://job-boards.greenhouse.io/${r.pick(EMPLOYERS)}/jobs/${r.int(10000, 99999)}`;
    const moved = r.next() < 0.5;
    const o = { url_before: before, url_after: moved ? `${before}/confirmation` : before, form_present_after: false, required_empty_after: 0, validation_errors: [] as string[],
      captcha: false, email_code_prompt: false, page_text: "" };
    const c = r.pick(["Acme", "Contoso", "Northwind"]);
    const lang = r.pick(["de", "fr", "es"] as Lang[]);
    let expect: string[];
    switch (kind) {
      case "thanks": o.page_text = r.pick(THANKS.en).replace("{c}", c); expect = ["confirmed"]; break;
      case "thanks_id": o.page_text = `${r.pick(THANKS.en).replace("{c}", c)} Confirmation number: ${r.pick(["GH", "APP", "REF"])}-${r.int(10000, 99999)}`; expect = ["confirmed"]; break;
      case "moved_silent": o.url_after = `${before}/done`; o.page_text = r.pick(["", `${c} careers`, "Back to all jobs"]); expect = ["submitted_unconfirmed"]; break;
      case "same_silent": o.url_after = before; o.page_text = r.pick(["", `${c} careers`]); expect = ["unknown_outcome"]; break;
      case "form_again": o.form_present_after = true; o.required_empty_after = r.int(0, 4); o.page_text = `Apply for this job ${c}`; expect = ["unknown_outcome"]; break;
      case "errors": o.form_present_after = true; o.validation_errors = [r.pick(["Email is invalid", "Resume is required", "Please complete this required field."])]; expect = ["failed"]; break;
      case "dup": o.page_text = r.pick(DUP); expect = ["unknown_outcome"]; break;
      case "error_words": o.page_text = r.pick(ERROR_WORDS); expect = ["unknown_outcome"]; break;
      case "foreign_thanks": o.page_text = r.pick(THANKS[lang]); expect = moved ? ["submitted_unconfirmed"] : ["unknown_outcome"]; break;
      case "email_code": o.email_code_prompt = true; o.page_text = "We emailed you a verification code. Enter it below to finish your application."; expect = ["needs_user"]; break;
      case "captcha": o.captcha = true; o.page_text = r.pick(["Please verify you are human", "", "Thank you for applying!"]); expect = ["unknown_outcome"]; break;
      case "code_and_thanks": o.email_code_prompt = true; o.page_text = "Thank you for applying! Check your email for a code."; expect = ["needs_user"]; break;
      default: expect = [];
    }
    out.push({ n, kind, obs: o, expect });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ labels
const CASES: ((s: string) => string)[] = [(s) => s, (s) => s.toUpperCase(), (s) => s.toLowerCase(), (s) => `${s} *`, (s) => `${s}:`, (s) => `Please enter your ${s.toLowerCase()}`, (s) => `${s} (required)`];
export interface LabelCase { n: number; family: "identity" | "sensitive" | "honeypot" | "control"; label: string; required: boolean }
export const CONTROL_LABELS = ["First name", "Last name", "Email", "Phone number", "LinkedIn Profile", "Desired salary", "Salary expectations", "City"];
export function labelCases(seed: number, count: number): LabelCase[] {
  const r = rng(seed);
  const fams: LabelCase["family"][] = ["identity", "identity", "sensitive", "sensitive", "honeypot", "control"];
  return Array.from({ length: count }, (_, n) => {
    const family = fams[n % fams.length];
    const base = family === "identity" ? r.pick(IDENTITY_LABELS) : family === "sensitive" ? r.pick(SENSITIVE_LABELS) : family === "honeypot" ? r.pick(HONEYPOT_WORDS) : r.pick(CONTROL_LABELS);
    const label = family === "control" ? base : r.pick(CASES)(base);
    return { n, family, label, required: r.next() < 0.6 };
  });
}

// ------------------------------------------------------------------------------------------------ integrity
export type Change = "none" | "resume_bytes" | "resume_other_sha" | "resume_missing" | "answer_value" | "answer_added" | "answer_removed" | "approval" | "payload_hash" | "url" | "user";
export const CHANGES: Change[] = ["none", "resume_bytes", "resume_other_sha", "resume_missing", "answer_value", "answer_added", "answer_removed", "approval", "payload_hash", "url", "user"];

// ------------------------------------------------------------------------------------------------ scale
// Postings for mass submission: the same job on two boards (Greenhouse's own board and the employer's careers page by
// gh_jid), one employer through two application systems (two postings), and plain postings across many hosts.
export interface ScalePosting { url: string; key: string; host: string; dupOf?: number }
export function scalePostings(r: R, count: number, prefix: string): ScalePosting[] {
  const out: ScalePosting[] = [];
  for (let i = 0; out.length < count; i++) {
    const t = `${prefix}${i % 97}`, id = String(4000000 + i);
    const roll = r.next();
    if (roll < 0.1 && out.length + 2 <= count) {
      // One job on two boards: Greenhouse's job board, and the employer's own careers page whose Apply opens Greenhouse's
      // older board (gh_src names the careers page): one posting.
      out.push({ url: `https://job-boards.greenhouse.io/${t}/jobs/${id}`, key: `greenhouse.io/jobs/${id}`, host: "job-boards.greenhouse.io" });
      out.push({ url: `https://boards.greenhouse.io/${t}/jobs/${id}?gh_src=careers-${t}`, key: `greenhouse.io/jobs/${id}`, host: "boards.greenhouse.io", dupOf: out.length - 1 });
    } else if (roll < 0.2 && out.length + 2 <= count) {
      // One employer through two systems: two different postings.
      out.push({ url: `https://jobs.lever.co/${t}/${id}-aaaa-4bbb-8ccc-${String(i).padStart(12, "0")}`, key: "", host: "jobs.lever.co" });
      out.push({ url: `https://jobs.ashbyhq.com/${t}/${id}-dddd-4eee-8fff-${String(i).padStart(12, "0")}`, key: "", host: "jobs.ashbyhq.com" });
    } else {
      const host = `h${r.int(0, 39)}.${prefix}.example.test`;
      out.push({ url: `https://${host}/jobs/${id}`, key: "", host });
    }
  }
  return out.slice(0, count);
}
export type HostBehavior = "ok" | "storm" | "storm_date" | "check" | "slow_ok";
export const KILL_POINTS = ["claim", "journal_start", "engine_open", "engine_fill", "engine_after_send", "after_engine_before_record", "record_lost_reply", "record_fails"] as const;
export type KillPoint = typeof KILL_POINTS[number];
