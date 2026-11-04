// Generated chat scenarios for the safety and truth rules (scenarios-*.test.ts and flow-scenarios-safety.test.ts). Every
// generator is seeded, so a run is the same run every time and a failure names its input. No network, no model.
//   sites    asks to apply, message, connect, DM or reach out on LinkedIn, Indeed or Handshake (words, typos, links on any
//            country host, with query strings, fragments, trailing punctuation, parentheses, markdown and angle brackets),
//            and controls that must never be refused (the plain words, their own export or profile link, advice
//            questions, employer careers links, a tracking parameter naming a site)
//   secrets  passwords, one-time codes and card numbers in many phrasings, and controls that must stay (phone numbers,
//            zip codes, job ids, salaries, dates, years, order numbers)
//   apply    apply asks in many phrasings (for the no-resume gate)

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, pick, int };
}
export type R = ReturnType<typeof rng>;
export type Site = "LinkedIn" | "Indeed" | "Handshake";
export type Case<T> = { input: string; expect: T; family: string };

const NAMES = ["Maya", "Maya Chen", "Sam", "the recruiter", "Priya Patel", "him", "her", "Jordan Lee", "the hiring manager", "Alex"];
const COS = ["Stripe", "Contoso", "Ramp", "Acme", "Northwind", "Plaid", "Figma"];
const ROLES = ["Data Analyst", "SWE intern", "product intern", "analyst", "frontend engineer"];
const SITE_WORDS: Record<Site, string[]> = {
  LinkedIn: ["linkedin", "LinkedIn", "LINKEDIN", "Linkedin", "linked in", "Linked In", "linkedn", "linkdin", "linkedln", "linked-in", "LinkedIn.com", "linkedin.com"],
  Indeed: ["indeed", "Indeed", "INDEED", "indeed.com", "Indeed.com", "indeed.co.uk"],
  Handshake: ["handshake", "Handshake", "HANDSHAKE", "joinhandshake", "joinhandshake.com", "Handshake app"],
};
// Actions named on a site in words: {s} is the site, {n} a person, {c} a company, {r} a role.
const ACTS = [
  "apply to the {r} job at {c} on {s}", "can you apply for me on {s}", "apply to this one on {s} for me", "please apply through {s}",
  "apply for the {r} role via {s}", "apply me to {c} on {s}", "can u apply 2 the {c} job on {s}", "easy apply to {c} on {s}",
  "message {n} on {s}", "dm {n} on {s}", "DM the recruiter on {s} for me", "msg {n} on {s} pls", "send {n} a message on {s}",
  "connect with {n} on {s}", "send {n} a connection request on {s}", "reach out to {n} on {s}", "reach out to recruiters at {c} via {s}",
  "reach out on {s} to {n}", "ping {n} on {s}", "message recruiters on {s} for me", "can you connect me with {n} on {s}?",
  "Apply to {c}'s {r} posting on {s}!", "dm {n} through {s} and ask about the {r} role", "hey can you message {n} over {s}",
];
const fill = (r: R, tpl: string, s: string) => tpl.replace("{s}", s).replace("{n}", r.pick(NAMES)).replace("{c}", r.pick(COS)).replace("{r}", r.pick(ROLES));

const HOSTS: Record<Site, string[]> = {
  LinkedIn: ["www.linkedin.com", "linkedin.com", "in.linkedin.com", "uk.linkedin.com", "m.linkedin.com", "WWW.LinkedIn.com"],
  Indeed: ["www.indeed.com", "indeed.com", "uk.indeed.com", "indeed.co.uk", "www.indeed.co.uk", "ca.indeed.com", "de.indeed.com", "Indeed.com"],
  Handshake: ["app.joinhandshake.com", "joinhandshake.com", "uw.joinhandshake.com", "nyu.joinhandshake.com", "www.joinhandshake.com"],
};
const PATHS: Record<Site, string[]> = {
  LinkedIn: ["/jobs/view/3812345678", "/jobs/view/123/?refId=abc&trackingId=x%3D%3D", "/jobs/view/42#apply", "/jobs/collections/recommended/?currentJobId=99"],
  Indeed: ["/viewjob?jk=abc123def", "/viewjob?jk=9f8e7d&from=serp&vjs=3", "/jobs?q=analyst&l=Chicago", "/cmp/Acme/jobs?jk=1#top", "/rc/clk?jk=55"],
  Handshake: ["/stu/jobs/12345", "/stu/jobs/98765?ref=open-in-new-tab", "/jobs/12345", "/stu/postings/77#details", "/stu/employers/123"],
};
const SCHEMES = ["https://", "http://", ""];
const WRAPS: ((u: string) => string)[] = [(u) => u, (u) => `(${u})`, (u) => `[the job](${u})`, (u) => `<${u}>`, (u) => `${u}.`, (u) => `${u}!`, (u) => `${u},`, (u) => `"${u}"`, (u) => `${u})`];
const LINK_LEADS = ["", "apply to this", "apply to this one", "can you apply here:", "apply for me", "message this recruiter", "connect with this person",
  "apply me to", "pls apply", "reach out to whoever posted", "apply to this job for me", "this one", "can you dm the poster of"];

export function siteLink(r: R, site: Site) {
  const host = r.pick(HOSTS[site]);
  return `${r.pick(SCHEMES)}${host}${r.pick(PATHS[site])}`;
}

// Asks that must be refused, naming the site.
export function siteAsks(r: R, n: number): Case<Site>[] {
  const fixed: [string, Site][] = [
    ["here is a job on linkedin, apply to it for me", "LinkedIn"], ["here is the posting https://www.linkedin.com/jobs/view/1 apply", "LinkedIn"],
    ["here are some jobs on indeed, apply to them", "Indeed"], ["attached is a handshake posting, apply for me", "Handshake"],
    ["can you message recruiters on linkedin for me?", "LinkedIn"], ["how do I get you to apply on indeed for me?", "Indeed"],
    ["should I have you dm her on linkedin?", "LinkedIn"], ["here's my linkedin, now connect me with Stripe recruiters on it", "LinkedIn"],
    ["apply to this https://in.linkedin.com/jobs/view/123?refId=abc#x", "LinkedIn"], ["https://app.joinhandshake.com/stu/jobs/1234?ref=abc", "Handshake"],
    ["this one (https://uk.indeed.com/viewjob?jk=1) please", "Indeed"], ["[apply](https://www.linkedin.com/jobs/view/1)", "LinkedIn"],
  ];
  const out: Case<Site>[] = fixed.map(([input, expect]) => ({ input, expect, family: "fixed" }));
  const sites: Site[] = ["LinkedIn", "Indeed", "Handshake"];
  while (out.length < n) {
    const site = r.pick(sites);
    if (r.next() < 0.5) {
      const tpl = r.pick(ACTS);
      out.push({ input: fill(r, tpl, r.pick(SITE_WORDS[site])), expect: site, family: "words" });
    } else {
      const lead = r.pick(LINK_LEADS);
      const link = r.pick(WRAPS)(siteLink(r, site));
      const tail = r.pick(["", "", " for me", " please", " thanks", " asap"]);
      out.push({ input: `${lead}${lead ? " " : ""}${link}${tail}`.trim(), expect: site, family: "link" });
    }
  }
  return out;
}

const EMPLOYER_LINKS = ["https://boards.greenhouse.io/acme/jobs/4012345", "https://jobs.lever.co/ramp/7d1e0c2a-1111-2222-3333-444455556666",
  "https://jobs.ashbyhq.com/plaid/0b9b6a3e-aaaa-bbbb-cccc-ddddeeeeffff", "https://careers.stripe.com/jobs/123456", "https://www.figma.com/careers/job/5",
  "https://contoso.wd5.myworkdayjobs.com/en-US/External/job/Chicago/Analyst_R123", "https://job-boards.greenhouse.io/northwind/jobs/77"];
const TRACKING = ["?gh_src=linkedin", "?utm_source=indeed", "?utm_source=handshake&utm_medium=jobboard", "?source=LinkedIn", "?lever-source=Indeed", ""];
// Messages that must never be refused.
export function siteControls(r: R, n: number): Case<null>[] {
  const fixed = [
    "indeed I did", "Indeed, I applied yesterday", "I did indeed apply to Stripe last week", "yes indeed", "Indeed! that's the one", "that is indeed the plan",
    "a firm handshake", "I gave the recruiter a firm handshake", "we sealed it with a handshake, then I applied", "how firm should my handshake be at the fair?",
    "here is my LinkedIn export", "here's my linkedin connections export", "my linkedin connections export is attached", "here are my linkedin connections",
    "Connections.csv from linkedin attached", "update my linkedin headline?", "how should I update my linkedin headline?", "what should my linkedin headline say?",
    "tips for my linkedin summary", "is linkedin premium worth it?", "should I put my GPA on linkedin?", "who do I know at Stripe from linkedin",
    "my LinkedIn is https://www.linkedin.com/in/alex-testcase", "here's my linkedin: https://www.linkedin.com/in/alex-testcase",
    "my linkedin profile https://www.linkedin.com/in/alex-testcase", "use my linkedin url https://linkedin.com/in/alex-testcase on applications",
    "how do I message recruiters on LinkedIn?", "should I connect with alumni on linkedin?", "is it ok to dm a recruiter on handshake?", "how do I apply on handshake?",
    "should I apply on indeed or the company site?", "what should I write when I message a recruiter on linkedin?", "is Handshake worth using?",
    "I found the job on Indeed but applied on the company site", "email maya@indeed.com about the analyst role", "Maya from LinkedIn said to email her",
    "apply to the analyst job at Indeed Inc https://careers.example.com/jobs/1",
  ];
  const out: Case<null>[] = fixed.map((input) => ({ input, expect: null, family: "fixed" }));
  while (out.length < n) {
    const k = r.int(0, 3);
    if (k === 0) out.push({ input: `${r.pick(["apply to", "apply me to", "can you apply to", "please apply for me:", ""])} ${r.pick(EMPLOYER_LINKS)}${r.pick(TRACKING)}`.trim(), expect: null, family: "employer link" });
    else if (k === 1) out.push({ input: `${r.pick(["Indeed,", "indeed", "Yes indeed,", "It was indeed"])} ${r.pick(["I applied to", "I talked to", "I interviewed at", "great news from"])} ${r.pick(COS)}`, expect: null, family: "indeed word" });
    else if (k === 2) out.push({ input: `${r.pick(["I gave", "Remember to give", "Should I give"])} ${r.pick(NAMES)} a ${r.pick(["firm", "good", "strong"])} handshake${r.pick(["", "?", " at the career fair"])}`, expect: null, family: "handshake word" });
    else out.push({ input: `${r.pick(["how do I", "how should I", "should I", "is it ok to", "what's the best way to"])} ${r.pick(["update my", "improve my", "write my", "rewrite my"])} ${r.pick(SITE_WORDS.LinkedIn.slice(0, 6))} ${r.pick(["headline", "summary", "about section", "profile photo"])}?`, expect: null, family: "advice" });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ secrets
// Every secret is generated at run time (no card- or code-shaped literal sits in the repo).
export type Secret = { input: string; secret: string; kind: "password" | "code" | "card"; family: string };
export type Kept = { input: string; keep: string; family: string };

function luhnDigit(body: string) {
  let sum = 0, dbl = true;
  for (let i = body.length - 1; i >= 0; i--) { let d = body.charCodeAt(i) - 48; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return String((10 - (sum % 10)) % 10);
}
export function luhnOk(digits: string) { return luhnDigit(digits.slice(0, -1)) === digits.slice(-1); }
const digits = (r: R, n: number) => Array.from({ length: n }, () => String(r.int(0, 9))).join("");
// A card number: Visa, Mastercard or Discover 16 digits, Amex 15; Luhn-valid unless asked otherwise.
export function cardNumber(r: R, o: { valid?: boolean } = {}) {
  const kind = r.pick(["visa", "mc", "amex", "discover"] as const);
  const prefix = kind === "visa" ? "4" : kind === "mc" ? String(r.int(51, 55)) : kind === "amex" ? r.pick(["34", "37"]) : "6011";
  const len = kind === "amex" ? 15 : 16;
  const body = prefix + digits(r, len - 1 - prefix.length);
  let check = luhnDigit(body);
  if (o.valid === false) check = String((Number(check) + r.int(1, 9)) % 10);
  const raw = body + check;
  const sep = r.pick(["", " ", "-", ".", " "]);
  const text = kind === "amex" ? [raw.slice(0, 4), raw.slice(4, 10), raw.slice(10)].join(sep) : raw.match(/.{4}/g)!.join(sep);
  return { raw, text, kind };
}
const PW_VALUES = (r: R) => r.pick([
  () => `${r.pick(["hunter", "Tr0ub4dor", "bluefish", "Summer", "Maple", "goBears", "Panda"])}${r.int(1, 9999)}${r.pick(["", "!", "#", "$$", "?"])}`,
  () => `${r.pick(["correcthorse", "letmein", "sunshine", "dragonfly", "qwertyuiop", "iloveyou", "monkeybread"])}${r.pick(["", "", "!"])}`,
  () => `${r.pick(["S3cr3t", "P@ssw0rd", "Xk9#mQ2v", "zP4!rL8w", "Aa1!Bb2@"])}${digits(r, 2)}`,
])();
const USERS = ["alex.testcase@example.test", "alex_t", "atestcase", "alex@school.edu", "ATestcase99"];
const PW_TEMPLATES: [string, string][] = [
  ["my pw is {v}", "pw"], ["password: {v}", "label"], ["Password: {v}", "label"], ["pass={v}", "pass="], ["pass: {v}", "pass:"], ["my password is {v}", "is"],
  ["PASSWORD IS {v}", "caps"], ["the password for workday is {v}", "for"], ["my workday password is {v} if you need it", "named"], ["passcode is {v}", "passcode"],
  ["pwd: {v}", "pwd"], ["Password = {v}", "eq"], ["my password's {v}", "'s"], ["login is {u} / {v}", "login slash"], ["login: {u} / {v}", "login: slash"],
  ["my login is {u} and the password is {v}", "login and"], ["username {u} password {v}", "user password"], ["user: {u} pass: {v}", "user pass"],
  ["creds: {u}/{v}", "creds"], ["credentials are {u} / {v}", "credentials"], ["sign in with {u} / {v}", "sign in with"], ["use {v} as the password", "as the password"],
  ["the pw for my greenhouse account is {v}", "pw for"], ["here's my password {v}", "here's"], ["password - {v}", "dash"], ["pw {v}", "pw bare"],
  ["my login for the portal: {u} pw {v}", "login pw"], ["account password is {v}, please apply", "then ask"], ["Password:{v}", "no space"],
];
export function passwords(r: R, n: number): Secret[] {
  const out: Secret[] = [];
  while (out.length < n) {
    const [tpl, family] = r.pick(PW_TEMPLATES);
    const v = PW_VALUES(r);
    const lead = r.pick(["", "", "ok ", "fyi ", "btw "]), tail = r.pick(["", "", ".", " thanks", " — apply to stripe for me"]);
    out.push({ input: `${lead}${tpl.replace("{u}", r.pick(USERS)).replace("{v}", v)}${tail}`, secret: v, kind: "password", family });
  }
  return out;
}
const CODE_TEMPLATES: [string, string][] = [
  ["code is {c}", "code is"], ["my code is {c}", "my code"], ["the code is {c}", "the code"], ["OTP {c}", "OTP"], ["otp: {c}", "otp:"], ["verification code: {c}", "verification"],
  ["my 2fa code is {c}", "2fa"], ["the 2FA code: {c}", "2FA"], ["here's the code: {c}", "here's the code"], ["sms code {c}", "sms"], ["Your code: {c}", "your code"],
  ["auth code {c}", "auth"], ["one-time passcode {c}", "one-time passcode"], ["one time code is {c}", "one time"], ["security code is {c}", "security"],
  ["login code {c}", "login code"], ["sign-in code: {c}", "sign-in"], ["mfa {c}", "mfa"], ["the code they texted me is {c}", "texted"], ["code: {c}", "code:"],
  ["confirmation code is {c}", "confirmation code"], ["my pin is {c}", "pin"], ["PIN: {c}", "PIN"], ["access code {c}", "access"], ["the code workday emailed me is {c}", "emailed"],
];
export function codes(r: R, n: number): Secret[] {
  const out: Secret[] = [];
  while (out.length < n) {
    const [tpl, family] = r.pick(CODE_TEMPLATES);
    const len = /pin/i.test(family) ? r.pick([4, 6]) : r.pick([4, 6, 6, 6, 8]);
    const raw = String(r.int(1, 9)) + digits(r, len - 1);
    const c = len === 6 ? r.pick([raw, raw, `${raw.slice(0, 3)} ${raw.slice(3)}`, `${raw.slice(0, 3)}-${raw.slice(3)}`, raw.match(/../g)!.join(" ")]) : raw;
    const tail = r.pick(["", "", ".", " thanks", "!"]);
    out.push({ input: `${tpl.replace("{c}", c)}${tail}`, secret: raw, kind: "code", family });
  }
  return out;
}
const CARD_TEMPLATES: [string, string][] = [
  ["my card is {n}", "card is"], ["card number {n}", "card number"], ["visa {n} exp 09/29", "visa"], ["use my credit card {n} for the fee", "credit card"],
  ["{n}", "bare"], ["charge {n}", "charge"], ["here: {n}", "here"], ["cc# {n}", "cc#"], ["my debit card: {n}, exp 11/27", "debit"], ["amex {n}", "amex"],
  ["pay the application fee with {n} please", "pay with"], ["the number is {n}", "the number"], ["({n})", "parens"], ["mastercard {n}", "mastercard"],
];
const CARD_LABEL = /\b(?:card|visa|amex|mastercard|cc#?|debit|credit)\b/i;
// Luhn-valid numbers anywhere, and a mistyped (Luhn-invalid) number when it is labeled as a card.
export function cards(r: R, n: number): Secret[] {
  const out: Secret[] = [];
  while (out.length < n) {
    const [tpl, family] = r.pick(CARD_TEMPLATES);
    const invalid = CARD_LABEL.test(tpl) && r.next() < 0.3;
    const c = cardNumber(r, { valid: !invalid });
    out.push({ input: tpl.replace("{n}", c.text), secret: c.raw, kind: "card", family: `${family}${invalid ? " (luhn-invalid)" : ""} ${c.kind}` });
  }
  return out;
}
// Numbers that must stay exactly as written.
export function keptNumbers(r: R, n: number): Kept[] {
  const out: Kept[] = [];
  const gens: [string, () => [string, string]][] = [
    ["phone", () => { const p = `${r.int(201, 989)}-${r.int(200, 999)}-${digits(r, 4)}`; return [`call me at ${p}`, p]; }],
    ["phone parens", () => { const p = `(${r.int(201, 989)}) ${r.int(200, 999)}-${digits(r, 4)}`; return [`my number is ${p}`, p]; }],
    ["phone +1", () => { const p = `+1 ${r.int(201, 989)} ${r.int(200, 999)} ${digits(r, 4)}`; return [`text me on ${p}`, p]; }],
    ["phone 10", () => { const p = `${r.int(201, 989)}${r.int(200, 999)}${digits(r, 4)}`; return [`phone ${p}`, p]; }],
    ["zip", () => { const z = digits(r, 5); return [r.pick([`my zip code is ${z}`, `zip ${z}`, `I live in ${z}`, `zip code: ${z}`, `postal code ${z}`]), z]; }],
    ["zip+4", () => { const z = `${digits(r, 5)}-${digits(r, 4)}`; return [`zip ${z}`, z]; }],
    ["area code", () => { const z = String(r.int(201, 989)); return [`area code ${z}`, z]; }],
    ["job id", () => { const z = String(r.int(1, 9)) + digits(r, r.pick([6, 7, 9, 10])); return [r.pick([`job id ${z}`, `the job id is ${z}`, `req ${z}`, `requisition #${z}`, `job ${z}`, `posting ${z}`]), z]; }],
    ["job id 16", () => { const z = String(r.int(1, 9)) + digits(r, 15); return [r.pick([`job id ${z}`, `the posting id is ${z}`, `requisition ${z}`, `application id: ${z}`]), z]; }],
    ["letter job id", () => { const z = `R${digits(r, 6)}`; return [`apply to ${z} at Acme`, z]; }],
    ["salary", () => { const z = `$${r.int(50, 250)},000`; return [r.pick([`I want ${z}`, `the offer is ${z} a year`, `base ${z} plus bonus`, `my floor is ${z}`]), z]; }],
    ["salary range", () => { const a = r.int(60, 150); const z = `$${a},000 - $${a + 20},000`; return [`range is ${z}`, z]; }],
    ["salary plain", () => { const z = String(r.int(50, 250) * 1000); return [`they offered ${z}`, z]; }],
    ["salary k", () => { const z = `${r.int(50, 250)}k`; return [`asking ${z}`, z]; }],
    ["date", () => { const z = `${r.int(1, 12)}/${r.int(1, 28)}/${r.int(2024, 2028)}`; return [`interview on ${z}`, z]; }],
    ["iso date", () => { const z = `${r.int(2024, 2028)}-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`; return [`start date ${z}`, z]; }],
    ["year", () => { const z = String(r.int(2018, 2030)); return [r.pick([`class of ${z}`, `I graduate in ${z}`, `since ${z}`, `${z} grad`]), z]; }],
    ["years", () => { const a = r.int(2016, 2026); const z = `${a}-${a + 4}`; return [`at school ${z}`, z]; }],
    ["order", () => { const z = `${digits(r, 3)}-${digits(r, 7)}-${digits(r, 7)}`; return [`order number ${z}`, z]; }],
    ["order card-shaped", () => { const c = cardNumber(r).raw; return [r.pick([`order #${c}`, `confirmation number ${c}`, `tracking number ${c}`, `ticket ${c}`]), c]; }],
    ["confirmation", () => { const z = digits(r, 8); return [`confirmation number ${z}`, z]; }],
    ["luhn-invalid unlabeled 16", () => { const c = cardNumber(r, { valid: false }); return [`reference ${c.raw}`, c.raw]; }],
    ["counts", () => { const z = `${r.int(2, 40)} jobs`; return [`I applied to ${z} this week`, z]; }],
    ["gpa", () => { const z = `3.${r.int(0, 9)}`; return [`my gpa is ${z}`, z]; }],
    ["bare number, no code waiting", () => { const z = String(r.int(1, 9)) + digits(r, 5); return [z, z]; }],
    ["zip code is", () => { const z = digits(r, 5); return [`the zip code is ${z}`, z]; }],
    ["other codes", () => { const z = digits(r, 6); return [r.pick([`promo code ${z}`, `the course code is ${z}`, `error code ${z}`, `referral code: ${z}`, `class code ${z}`]), z]; }],
  ];
  while (out.length < n) { const [family, g] = r.pick(gens); const [input, keep] = g(); out.push({ input, keep, family }); }
  return out;
}
// Words about a password that hold no password.
export const PASSWORD_WORDS = ["my password is wrong", "I forgot my password", "reset my password please", "what is a strong password?", "my password is expired",
  "do you need my password?", "the password field is required", "should I use a password manager?", "I changed my password yesterday", "my password is too short",
  "never ask me for my password", "password reset link didn't come", "I'll sign in myself, no password here", "my login doesn't work", "how do I log in?",
  "what's the code of conduct?", "I need to write code for the take-home", "my login is my school email"];
// Resume and posting prose that names sign-in, codes and passwords without holding one (a pasted resume is chat input).
export const PROSE = ["Built login / signup flows in React", "Built the login page / dashboard for 200 users", "User research / UX design for the checkout",
  "Implemented user login and password hashing with bcrypt", "Added password reset and 2FA to the admin portal", "Wrote code: 1,500 lines of Go",
  "Shipped login/signup pages and a password-protected admin area", "Requirements: SQL, Python; zip code 60601 preferred", "Job code 448812, posting 2026-11",
  "Credentials: CPA (2024) / CFA Level I", "Pass rate: 98% on 1200 test cases", "Used Okta sign-in with SSO / SAML", "Area code 312 candidates only",
  "Cut weekly reporting time by 40% by automating data pulls from PostgreSQL", "Requisition code 2025-118 / Analyst", "Source code: github.com/example-testcase/deployboard",
  "Course code 15122, grade A", "Error code 500123 fixed in the payment service", "my password manager is 1Password", "I passed: 3 of 4 rounds"];

// ------------------------------------------------------------------------------------------------ apply asks
// Apply asks for the no-resume gate: a named role at a company, a company alone, and the thread's last list.
export const APPLY_SINGLE = ["apply to the {r} role at {c}", "apply me to the {r} position at {c}", "Apply for the {r} job at {c}.", "apply to the {r} internship at {c}!",
  "apply to {c}", "apply me at {c}", "please apply to the {r} role at {c}", "pls apply me to the {r} role at {c}", "APPLY TO THE {r} ROLE AT {c}",
  "ok apply to the {r} role at {c}", "apply for {c}", "apply to that {r} role at {c}", "can you apply to the {r} role at {c}?", "go ahead and apply to the {r} role at {c}",
  "apply to {c}'s {r} role", "I want to apply to the {r} role at {c}", "submit an application to the {r} role at {c}", "apply me to {c} please"];
export const APPLY_BATCH = ["apply to all of them", "apply to these", "apply to the first 2", "apply to 1 and 3", "apply to #2", "apply to the second one", "apply to all of these",
  "apply to them all", "apply to the top 3", "Apply to both.", "apply me to 2 and 4", "apply to the first and third", "apply to every analyst role you found", "apply to 3 roles",
  "apply to all", "apply to those", "apply to each of these", "apply to the first one", "APPLY TO ALL OF THEM!", "apply to 1, 2 and 4"];
export function applyAsks(r: R, n: number, postings: { company: string; title: string }[]): { input: string; family: "single" | "batch" }[] {
  const out: { input: string; family: "single" | "batch" }[] = [];
  while (out.length < n) {
    if (r.next() < 0.6) {
      const p = r.pick(postings);
      const t = r.pick(APPLY_SINGLE);
      out.push({ input: t.replace("{r}", t === t.toUpperCase() ? p.title.toUpperCase() : p.title).replace("{c}", p.company), family: "single" });
    } else out.push({ input: r.pick(APPLY_BATCH), family: "batch" });
  }
  return out;
}
