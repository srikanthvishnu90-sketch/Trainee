// The jobs page and its Apply flow at scale (owner, 2026-10-29: "open the postings with company logos, roles and details, log in with
// my phone number, then click Apply and have it apply for me"): a deterministic, seeded generator of signed-in jobs lists and of what
// the person (and the world) does to them. The runner and the invariants are in tests/architect/scenarios-file-apply-battery.ts.
//
// A scenario is a list of 1-30 postings, each with its own truth (who the employer is and which domain is theirs, where the link
// points, what the stored posting says and what only the search result said, whether it is open, stale, scam-looking or a knock-out
// for this person, whether an application is prepared and exactly what it would send, where its application row stands), then 3-12
// steps: requests (Apply with the right, a stale, another row's or no tag; Apply to all with the right or a stale set; refresh; the
// plain-text twin; two taps at once) and changes in the world between them (the payload re-prepared, unprepared or given a secret
// field; the posting applied for elsewhere; the posting closed; the worker preparing what was queued).
// Synthetic only: no real person, employer, posting or credential.

export type UrlKind =
  | "greenhouse" | "lever" | "ashby" // the board's own posting link
  | "own_gh" // a board posting shown on the employer's own careers site (WO-078)
  | "own_link" // the employer's own careers site, no board id (search only)
  | "ats_other" // another applicant-tracking host (not the employer's site)
  | "board" // a job board's host (not the employer's site)
  | "linkedin" | "linkedin_dot" | "lnkd" | "indeed" | "indeed_uk" | "handshake" // never automated
  | "js_linkedin" // a script link dressed as LinkedIn
  | "http_gh"; // a board link over plain http
export const BY_HAND: UrlKind[] = ["linkedin", "linkedin_dot", "lnkd", "indeed", "indeed_uk", "handshake", "js_linkedin"];
export type DomainKind = "stated" | "stated_url" | "none" | "hostile";
export type Shape = "clean" | "closed" | "stale" | "scam" | "knockout";
export type Desc = "normal" | "none" | "html" | "huge" | "unicode" | "rtl";
export type AppState = "queued" | "driving" | "submitted_unconfirmed" | "confirmed" | "failed" | "not_submitted" | "needs_user" | "unknown_outcome" | "paused_by_site";
export type Secret = "label" | "type" | "value_ssn" | "value_card" | "value_token" | "verify_code" | "empty_password";
export interface FieldSpec { name: string; label: string; type?: string; value: unknown; secret?: Secret }
export interface PayloadSpec {
  fields: FieldSpec[]; cover: null | "obj" | "str" | "long"; pageFields: boolean; destination: "apply" | "none" | "byhand";
  extra: "none" | "plain" | "object" | "secret_key" | "nested_secret"; resumeName: boolean; resumeFileField: boolean;
}
export interface PostingSpec {
  n: number; company: string; title: string; slug: string | null; url: UrlKind; atsHost: string; boardHost: string;
  domain: DomainKind; hostileDomain: string; twinOf: number | null; // twinOf: the same posting link as an earlier row, under another id
  shape: Shape; hasRow: boolean; desc: Desc; postedDaysAgo: number | null;
  rowLoc: string | null; hitLoc: string | null; rowPay: string | null; hitPay: string | null; hitDeadlineDays: number | null | "garbage";
  remote: "remote" | "hybrid" | "onsite" | null; reasons: string[];
  prep: PayloadSpec | null; app: AppState | null; appReason: string | null; wanted: boolean;
}
export type TagPick = "seen" | "current" | "stale" | "other_row" | "none" | "garbage";
export type SetPick = "seen" | "current" | "stale" | "garbage" | "empty";
export type Step =
  | { k: "get" } | { k: "text" } | { k: "refresh" }
  | { k: "apply"; row: number; tag: TagPick; r: number }
  | { k: "applyall"; set: SetPick }
  | { k: "par"; steps: Step[] } // requests at once (Promise.all)
  | { k: "payload"; row: number; op: "change" | "unprepare" | "prepare" | "secret" }
  | { k: "elsewhere"; row: number; state: AppState }
  | { k: "close"; row: number }
  | { k: "prepare_wanted" };
export interface Scenario { id: number; needsSponsor: boolean; logo: "default" | "custom" | "http" | "garbage"; postings: PostingSpec[]; steps: Step[]; category: string }

// mulberry32: every run generates the same scenarios.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: () => number, p: number) => r() < p;

export const COMPANIES = ["Quillfeather", "Marrowbyte", "Zentrafy", "Oskarion", "Velloway", "Brintcorp", "Lumenhart", "Tessaract Labs", "Corvane", "Halvorsen & Daughters",
  "O'Malley Freight", "Pinewick", "Glimmerstack", "Northbarrow", "Saltmarsh Analytics", "Ferrolux", "Kestrelwing", "Drummond Pike"];
export const COMPANIES_ODD = ["Zürichwerk", "Ångström Analytics", "株式会社ミライ", "شركة النخيل", "Ωmega Systems", "Café ☕ Collective", "<script>alert(1)</script> Corp",
  `Acme "Quoted" & Sons`, "Evil‮gnp.exe Ltd", "⁦Isolated⁩ Holdings", "Rtl‫Marker Co", ""];
const TITLES = ["Pricing Analyst", "Data Engineer II", "Growth Cartographer", "Ledger Whisperer", "Signal Tinkerer", "Operations Planner", "Analytics Lead"];
const TITLES_ODD = ["Ingénieur Données", "محلل بيانات", "Analyst <img src=x onerror=alert(1)>", "Planner ‮reganam", `${"Senior Staff Principal ".repeat(12)}Analyst`, "データアナリスト"];
// Where the stored posting says the role is, and (a different pool) where only the search result said it is: a value from one pool
// can never be mistaken for the other.
export const ROW_LOCS = ["Austin, TX", "Denver, CO", "Zürich, CH", "القاهرة", "Lisbon ‮PT", "Remote (US)"];
export const HIT_LOCS = ["Springfield, IL", "Reno, NV", "Tallinn, EE", "Ōsaka, JP"];
export const ROW_PAYS = ["$90,000 – $110,000", "€70,000", "$45/hour", "<b>$120k</b>"];
export const HIT_PAYS = ["$85k (estimated)", "£50,000", "₹18 LPA"];
const ATS_HOSTS = ["bamboohr.com", "recruitee.com", "breezy.hr", "applytojob.com", "teamtailor.com", "pinpointhq.com"];
const BOARD_HOSTS = ["remoteok.com", "weworkremotely.com", "dice.com", "simplyhired.com", "news.ycombinator.com", "careerbuilder.com"];
// Safe posting text: nothing here is a scam signal or a knock-out for anyone.
const SAFE = ["Build dashboards and own the weekly pricing report for the growth team.", "You will partner with finance on quarterly planning.",
  "Our team ships small, careful changes every week.", "Requirements: SQL and a spreadsheet you trust.", "The role reports to the head of analytics.",
  "We value clear writing and calm reviews.", "Benefits include a learning budget and parental leave."];
const UNICODE_TXT = ["Équipe données à Zürich — café inclus ☕.", "データ分析チームで働きます。", "Ωmega crew ships ✓ weekly 🚀."];
const RTL_TXT = ["فريق البيانات يعمل كل أسبوع.", "Plan ‮troper eht nwo‬ each week.", "⁧عربي⁩ mixed text with numbers 123."];
export const SCAM_LINE = "You must pay a $50 training fee before you start.";
export const KNOCKOUT_LINE = "We are unable to sponsor visas for this role.";
const REASONS = ["You list SQL", "Your last role was analytics", "You asked for remote roles", "You know <b>Excel</b>"];

let secretN = 0;
// Every secret value carries a marker the runner looks for in every page: it must never be printed.
export const SECRET_MARK = "ZZSECRET";
function secretField(r: () => number, kind: Secret): FieldSpec {
  const mark = `${SECRET_MARK}${(++secretN).toString(36)}`;
  switch (kind) {
    case "label": return { name: "account_password", label: "Create a password", value: `hunter-${mark}`, secret: kind };
    case "type": return { name: "acct", label: "Account login", type: "password", value: `pw-${mark}`, secret: kind };
    case "value_ssn": return { name: "tax", label: "Tax ID", value: `123-45-${String(1000 + Math.floor(r() * 8999))} ${mark}`, secret: kind };
    case "value_card": return { name: "card", label: "Card", value: `4111 1111 1111 1111 ${mark}`, secret: kind };
    case "value_token": return { name: "ref", label: "Reference", value: `sk-live-${mark}abcdefghijklmnop`, secret: kind };
    case "verify_code": return { name: "vcode", label: "Verification code", value: `48213-${mark}`, secret: kind };
    case "empty_password": return { name: "password", label: "Password", type: "password", value: "", secret: kind };
  }
}
const FIELD_POOL: ((r: () => number) => FieldSpec)[] = [
  () => ({ name: "first_name", label: "First name", value: "Adaline" }),
  () => ({ name: "last_name", label: "Last name", value: "Pemberforth" }),
  () => ({ name: "email", label: "Email", value: "adaline@example.test" }),
  () => ({ name: "phone", label: "Phone", value: "+1 512 555 0142" }),
  () => ({ name: "work_auth", label: "Authorized to work in the US?", value: "Yes" }),
  () => ({ name: "consent", label: "I agree to the privacy notice", type: "checkbox", value: true }),
  () => ({ name: "years", label: "Years of SQL", value: 4 }),
  () => ({ name: "links", label: "Links", value: { github: "https://github.example/ada", site: "https://ada.example" } }),
  () => ({ name: "pronouns", label: "Pronouns", value: "" }),
  () => ({ name: "transcript", label: "Transcript", type: "input_file", value: "transcript-2025.pdf" }),
  (r) => ({ name: "why", label: "Why do you want this role?", value: `${"I like careful analytics work. ".repeat(8 + Math.floor(r() * 30))}End.` }),
  () => ({ name: "city", label: "Ville actuelle", value: "Zürich — Kreis 4" }),
  () => ({ name: "note", label: "Anything else?", value: `<b>bold</b> & "quotes" 'single'` }),
];

function payloadSpec(r: () => number): PayloadSpec {
  const fields: FieldSpec[] = [];
  const k = Math.floor(r() * 6);
  const used = new Set<number>();
  for (let i = 0; i < k; i++) { const j = Math.floor(r() * FIELD_POOL.length); if (!used.has(j)) { used.add(j); fields.push(FIELD_POOL[j](r)); } }
  if (chance(r, 0.14)) fields.splice(Math.floor(r() * (fields.length + 1)), 0, secretField(r, pickOf(r, ["label", "type", "value_ssn", "value_card", "value_token", "verify_code", "empty_password"] as const)));
  return {
    fields, cover: pickOf(r, [null, null, "obj", "obj", "str", "long"] as const), pageFields: chance(r, 0.25),
    destination: chance(r, 0.05) ? "byhand" : chance(r, 0.25) ? "none" : "apply",
    extra: chance(r, 0.8) ? "none" : pickOf(r, ["plain", "object", "secret_key", "nested_secret"] as const),
    resumeName: chance(r, 0.85), resumeFileField: chance(r, 0.4),
  };
}
export const slugOf = (company: string) => { if (/[<>]/.test(company)) return null; const s = company.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, ""); return s.length >= 3 ? s : null; };

function posting(r: () => number, n: number, earlier: PostingSpec[]): PostingSpec {
  const same = earlier.length && chance(r, 0.15) ? pickOf(r, earlier) : null; // the same employer twice
  const company = same ? same.company : chance(r, 0.18) ? pickOf(r, COMPANIES_ODD) : pickOf(r, COMPANIES);
  const slug = slugOf(company);
  let url: UrlKind = pickOf(r, ["greenhouse", "greenhouse", "greenhouse", "lever", "ashby", "own_gh", "own_gh", "own_link", "ats_other", "board", "http_gh",
    "linkedin", "linkedin_dot", "lnkd", "indeed", "indeed_uk", "handshake", "js_linkedin"] as const);
  if ((url === "own_gh" || url === "own_link" || url === "ats_other") && !slug) url = "greenhouse";
  const twinOf = earlier.length && chance(r, 0.04) ? pickOf(r, earlier).n : null;
  const shape: Shape = chance(r, 0.72) ? "clean" : pickOf(r, ["closed", "stale", "scam", "knockout"] as const);
  const byHand = BY_HAND.includes(url);
  const prep = !byHand && chance(r, 0.7) ? payloadSpec(r) : null;
  const app: AppState | null = chance(r, 0.18) ? pickOf(r, ["queued", "driving", "submitted_unconfirmed", "confirmed", "failed", "not_submitted", "needs_user", "unknown_outcome", "paused_by_site"] as const) : null;
  return {
    n, company, slug, title: chance(r, 0.15) ? pickOf(r, TITLES_ODD) : pickOf(r, TITLES), url, twinOf,
    atsHost: pickOf(r, ATS_HOSTS), boardHost: pickOf(r, BOARD_HOSTS),
    domain: pickOf(r, ["stated", "stated", "stated_url", "none", "none", "none", "hostile"] as const),
    hostileDomain: pickOf(r, [`evil"onerror="alert(1).com`, "javascript:alert(1)", "acme .com", "ac<b>me.com", "xn--zrich-kva.example‮", "", "localhost"]),
    shape, hasRow: url !== "own_link" && chance(r, 0.9), desc: pickOf(r, ["normal", "normal", "normal", "normal", "normal", "none", "none", "html", "html", "huge", "unicode", "unicode", "rtl", "rtl"] as const),
    postedDaysAgo: shape === "stale" ? 60 + Math.floor(r() * 300) : chance(r, 0.2) ? null : Math.floor(r() * 30),
    rowLoc: chance(r, 0.6) ? pickOf(r, ROW_LOCS) : null, hitLoc: chance(r, 0.6) ? pickOf(r, HIT_LOCS) : null,
    rowPay: chance(r, 0.4) ? pickOf(r, ROW_PAYS) : null, hitPay: chance(r, 0.4) ? pickOf(r, HIT_PAYS) : null,
    hitDeadlineDays: chance(r, 0.25) ? (chance(r, 0.2) ? "garbage" : Math.floor(r() * 40) - 5) : null,
    remote: pickOf(r, [null, "remote", "hybrid", "onsite"] as const),
    reasons: chance(r, 0.4) ? REASONS.slice(0, 1 + Math.floor(r() * 3)) : [],
    prep, app, appReason: app && chance(r, 0.6) ? pickOf(r, ["the form changed", "a captcha", "approval no longer current", "Sent <b>twice</b>?"]) : null,
    wanted: !prep && !app && chance(r, 0.2),
  };
}
export function descText(p: PostingSpec, r: () => number): string | null {
  const body = (() => {
    switch (p.desc) {
      case "none": return "";
      case "normal": return SAFE.slice(0, 2 + (p.n % 4)).join(" ");
      case "html": return `<p>${SAFE[0]}</p><img src=x onerror=alert(1)><script>alert(2)</script><ul><li>${SAFE[3]}</li></ul> 3 < 5 &amp; "q"`;
      case "huge": return Array.from({ length: 160 }, (_, i) => SAFE[i % SAFE.length]).join(" ").slice(0, 15000);
      case "unicode": return `${UNICODE_TXT.join(" ")} ${SAFE[1]}`;
      case "rtl": return `${RTL_TXT.join(" ")} ${SAFE[2]}`;
    }
  })();
  const extra = p.shape === "scam" ? ` ${SCAM_LINE}` : p.shape === "knockout" ? ` ${KNOCKOUT_LINE}` : "";
  void r;
  return (body + extra).trim();
}

function request(r: () => number, n: number): Step {
  const x = r();
  if (x < 0.55) return { k: "apply", row: Math.floor(r() * n), tag: pickOf(r, ["seen", "seen", "seen", "seen", "current", "stale", "other_row", "none", "garbage"] as const), r: Math.floor(r() * 1e6) };
  if (x < 0.75) return { k: "applyall", set: pickOf(r, ["seen", "seen", "seen", "current", "stale", "garbage", "empty"] as const) };
  if (x < 0.92) return { k: "refresh" };
  if (x < 0.96) return { k: "text" };
  return { k: "get" };
}
function worldStep(r: () => number, n: number): Step {
  const x = r();
  if (x < 0.45) return { k: "payload", row: Math.floor(r() * n), op: pickOf(r, ["change", "change", "unprepare", "prepare", "secret"] as const) };
  if (x < 0.65) return { k: "elsewhere", row: Math.floor(r() * n), state: pickOf(r, ["queued", "driving", "submitted_unconfirmed", "confirmed", "failed", "not_submitted", "needs_user"] as const) };
  if (x < 0.8) return { k: "close", row: Math.floor(r() * n) };
  return { k: "prepare_wanted" };
}

export function generate(o: { seed: number; count: number; maxRows?: number }): Scenario[] {
  const out: Scenario[] = [];
  for (let id = 1; id <= o.count; id++) {
    const r = rng(o.seed * 7919 + id);
    secretN = id * 1000;
    // Mostly short lists, sometimes the full 30.
    const max = o.maxRows ?? 30;
    const n = Math.min(max, chance(r, 0.06) ? 20 + Math.floor(r() * 11) : chance(r, 0.4) ? 1 + Math.floor(r() * 3) : 2 + Math.floor(r() * 9));
    const postings: PostingSpec[] = [];
    for (let i = 1; i <= n; i++) postings.push(posting(r, i, postings));
    const steps: Step[] = [{ k: "get" }];
    const len = 2 + Math.floor(r() * 7);
    for (let i = 0; i < len; i++) {
      const y = r();
      if (y < 0.62) steps.push(request(r, n));
      else if (y < 0.72) {
        // two or three taps at once: the same row twice, or Apply with Apply to all
        const row = Math.floor(r() * n);
        const same = { k: "apply", row, tag: "seen", r: 0 } as Step;
        steps.push({ k: "par", steps: chance(r, 0.5) ? [same, same] : chance(r, 0.5) ? [same, { k: "applyall", set: "seen" }] : [{ k: "applyall", set: "seen" }, { k: "applyall", set: "seen" }, same] });
      } else if (y < 0.76) {
        const row = Math.floor(r() * n);
        steps.push({ k: "apply", row, tag: "seen", r: 0 }, { k: "apply", row, tag: "seen", r: 0 }); // a double tap
      } else steps.push(worldStep(r, n));
    }
    const kinds = new Set(steps.map((s) => s.k));
    const category = [n >= 20 ? "long" : n === 1 ? "single" : "list", kinds.has("par") ? "concurrent" : "", kinds.has("payload") ? "payload" : "", kinds.has("elsewhere") ? "elsewhere" : ""].filter(Boolean).join("+");
    out.push({ id, needsSponsor: chance(r, 0.5), logo: pickOf(r, ["default", "default", "default", "custom", "custom", "http", "garbage"] as const), postings, steps, category });
  }
  return out;
}

export function sample(all: Scenario[], k: number, seed = 7): Scenario[] {
  const r = rng(seed), pool = [...all], out: Scenario[] = [];
  while (out.length < k && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
