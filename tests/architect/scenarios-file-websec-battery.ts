// The jobs page as a WEB APP under attack (owner, 2026-10-29: "a signed, expiring, single-use link is not proof of who opened it;
// a forwarded or copied link must never let another person read private data or apply as the owner; sessions revocable; account
// re-checked on private actions"). A fresh-seed battery (~10,000 scenarios, seed 20261102) over the trainee-file HTTP surface,
// through the real handler (supabase/functions/trainee-file/handler.ts) over memory stores, plus a seeded sample through the
// deployed session store on real Postgres 16 (flow-scenarios-file-websec.test.ts). The categories the earlier sign-in and journey
// batteries do not cover:
//   csrf_phone   a cross-site form post with the victim's cookies to phone_start / phone_verify / phone_reset (SameSite alone does
//                not stop a sibling subdomain or an old browser): nothing changes, nothing is texted, no code is checked;
//   csrf_action  the same for Apply / Apply to all / Refresh / Sign out / Sign out everywhere, even carrying the session's own
//                form value (worst case: it leaked): nothing is approved, nobody is signed out;
//   csrf_init    a cross-site post of (the attacker's own, valid) Telegram Mini App data: no session starts (login CSRF);
//   methods      HEAD with a link (with and without a session), OPTIONS, PUT, DELETE, PATCH, PROPFIND: no state change, no CORS,
//                405 says what is allowed;
//   body         very large request bodies (honest, missing or lying Content-Length): refused without being read past the cap;
//   link         the signed link's own fields: a span longer than the bot ever mints (expiry far in the future), issued in the
//                future, re-signed with another secret, alg confusion (another prefix, another hash, no signature, the standard
//                base64 alphabet), kind "s", a list id of another account: never a session to anything that is not the
//                link's own account's own list;
//   cookies      tf_s tampered, truncated, oversize, quoted, upper-cased, duplicated (dead + live, another account's + own),
//                tf_l tampered: private content only for a live session of that account;
//   fixation     a session id planted before the sign-in (another account's live one, one never issued, a revoked one) never
//                survives it;
//   devices      one link's tf_l on two browsers (the owner's and a forwarded copy) in any order: one session at most, the
//                owner's only;
//   brute        many forwarded links of one account, each guessed at: texts and code checks are capped PER ACCOUNT (not only
//                per link), and the owner gets in again once the hour has passed;
//   enum         the account's own number against any other well-formed number: the same answer, the same work, and the
//                answer never waits for the text to go out (time cannot tell which number is the account's);
//   redirect     next / return / redirect parameters and odd paths: every Location is this host's own path;
//   xss          payloads in company, title, description, location, pay, posting link, query parameters and form fields: no
//                injected tag, handler or javascript: link is ever rendered;
//   unicode      the phone typed with full-width or Arabic-Indic digits, invisible marks, NBSP and the like: a text only ever
//                goes to the account's own confirmed number;
//   faults       a store or provider that throws (with a stack-trace-looking message): a plain message, never the error.
// After EVERY response: one of the known statuses; no-store; CSP with default-src 'none' and frame-ancestors limited to Telegram;
// nosniff; a referrer policy that never sends the URL to another site; no CORS grant; every cookie HttpOnly, Secure,
// SameSite, Path=/, no Domain, Max-Age within the server's own TTL; every redirect to this host's own path; no session id in a
// URL; no other session's id in a body; no stack trace; no private content without a live session of that account; no
// injected markup; a HEAD answer has no body.
// The oracle is this file's own model (who holds which session, which code is live, what was shown); it never asks the
// product whether a request was allowed. No network: the phone and its texts are fakes.
import assertNode from "node:assert/strict";
import { phoneLeak as sharedPhoneLeak } from "./phone-leak.ts";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf, type JobView, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { LOGIN_TTL_MS, pageTokenOf, SESSION_TTL_MS, sha256, type PhoneAuth, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { renderPhoneLogin } from "../../supabase/functions/_shared/file_page.ts";
import { memSessions } from "./file-session-fakes.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
// Built at run time: no whole key-shaped string on disk.
export const SECRET = ["file", "link", "websec", "0123456789", "abcdef"].join("-");
const OTHER_SECRET = ["file", "link", "attacker", "9876543210", "fedcba"].join("-");
const BOT = ["424242", "WEBSEC-bot-for-tests"].join(":");
const BOT_URL = "https://t.me/TraineeBot";
export const HOST = "https://trainee.example";
const EVIL = "https://evil.example";
export const LIST_U = "0123456789", LIST_V = "9876543210";
export const T0 = Date.parse("2026-11-02T15:00:00Z");
const HOUR = 3600_000, MIN = 60_000;
export const SCENARIO_COUNT = 10_000, SEED = 20261102;
// The oracle's own policy numbers (owner rule: rate limits per account, not only per link).
export const POLICY = { accountSendsPerHour: 10, accountTriesPerHour: 15, bodyCap: 64 * 1024, linkSpanMs: 72 * HOUR };
const STATUSES = new Set([200, 303, 400, 401, 403, 404, 405, 410, 413, 429, 503]);
const CANON_CODE = renderPhoneLogin({ step: "code", botUrl: BOT_URL });
export const CATEGORIES = ["csrf_phone", "csrf_action", "csrf_init", "methods", "body", "link", "cookies", "fixation", "devices", "brute", "enum", "redirect", "xss", "unicode", "faults"] as const;
export type Category = typeof CATEGORIES[number];
const WEIGHTS: Record<Category, number> = { csrf_phone: 12, csrf_action: 12, csrf_init: 5, methods: 7, body: 5, link: 9, cookies: 8, fixation: 6, devices: 7, brute: 5, enum: 7, redirect: 4, xss: 6, unicode: 5, faults: 2 };

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export interface Scenario { id: number; cat: Category }
export function generate(count = SCENARIO_COUNT, seed = SEED): Scenario[] {
  const r = rng(seed), total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0), out: Scenario[] = [];
  for (let id = 0; id < count; id++) {
    let x = r() * total, cat: Category = "csrf_phone";
    for (const c of CATEGORIES) { x -= WEIGHTS[c]; if (x < 0) { cat = c; break; } }
    out.push({ id, cat });
  }
  return out;
}

// ---------------------------------------------------------------- the people (synthetic)
export const PHONES = { u: "+15125557319", v: "+14695558142" };
const PEOPLE = {
  u: { companies: ["Quillfeather", "Marrowbyte", "Zentrafy"], titles: ["Pricing Strategist", "Growth Cartographer", "Ledger Whisperer"], resume: "adaline-cv-2026.pdf", first: "Adaline", last: "Pemberforth" },
  v: { companies: ["Velloway"], titles: ["Harbor Planner"], resume: "barnaby-resume.pdf", first: "Barnaby", last: "Quarrington" },
};
type Who = "u" | "v";
const privOf = (p: typeof PEOPLE.u) => [...p.companies, ...p.titles, p.resume, p.first, p.last].map((s) => s.toLowerCase());
const PRIV: Record<Who, string[]> = { u: privOf(PEOPLE.u), v: privOf(PEOPLE.v) };
const phoneLeak = (body: string, phone: string) => sharedPhoneLeak(body, phone);
// Markup an attacker would like rendered. Escaped, each is harmless text; raw, each is a live tag, handler or link.
const PAYLOADS = [`<script>alert(1)</script>`, `"><img src=x onerror=alert(2)>`, `'><svg onload=alert(3)>`, `</title><script>alert(4)</script>`, `<iframe src="javascript:alert(5)">`,
  `{{constructor.constructor('alert(6)')()}}`, `<a href="javascript:alert(7)">x</a>`, `‮<b>moc.live</b>`, `</textarea><script>alert(8)</script>`, `<style>@import'//evil.example/x.css'</style>`,
  `<meta http-equiv="refresh" content="0;url=https://evil.example">`, `<base href="https://evil.example/">`, `<form action="https://evil.example"><button>`, `<object data="data:text/html,x">`];
const RAW_MARKS = [/<script>alert/i, /<img src=x/i, /<svg onload/i, /<iframe/i, /<a href="javascript:/i, /<b>moc/i, /<\/textarea><script/i, /<style>@import/i, /<meta http-equiv/i, /<base href/i, /<form action="https:\/\/evil/i, /<object/i];

// Telegram's own signing of Mini App data (the documented algorithm; an independent implementation).
async function signedInit(telegramId: string, authDate: number, token = BOT): Promise<string> {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Tg" }) });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), token), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}
// A link token signed here (the test knows the secret, as an attacker who stole it would not): any claims, any alg.
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function forge(claims: Record<string, unknown>, o: { secret?: string; prefix?: string; hash?: "SHA-256" | "SHA-1" | "SHA-512"; std?: boolean; noSig?: boolean } = {}): Promise<string> {
  const prefix = o.prefix ?? "v1";
  let body = b64u(new TextEncoder().encode(JSON.stringify(claims)));
  if (o.std) { let json = JSON.stringify(claims); while (json.length % 3 === 0) json += " "; body = btoa(json); } // the standard alphabet, padded
  if (o.noSig) return `${prefix}.${body}.`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(o.secret ?? SECRET), { name: "HMAC", hash: o.hash ?? "SHA-256" }, false, ["sign"]);
  return `${prefix}.${body}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${prefix}.${body}`))))}`;
}
const jti = (r: () => number) => [...Array(16)].map(() => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

// ---------------------------------------------------------------- the report
export type Report = { scenarios: number; requests: number; statuses: Record<number, number>; byCat: Record<string, number>; refusedCross: number; sessions: number; approvals: number;
  texts: number; liveness: Record<string, number>; violations: Map<string, string[]> };
export const newReport = (): Report => ({ scenarios: 0, requests: 0, statuses: {}, byCat: {}, refusedCross: 0, sessions: 0, approvals: 0, texts: 0, liveness: {}, violations: new Map() });
export function printReport(name: string, r: Report): number {
  const failed = [...r.violations.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[file-websec] ${name}: ${r.scenarios} scenarios (${Object.entries(r.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${r.requests} requests, ${failed} violations`,
    `  statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k}:${v}`).join(" ")}`,
    `  cross-site requests refused ${r.refusedCross}; sessions started ${r.sessions}; approvals ${r.approvals}; texts ${r.texts}`,
    `  liveness checked: ${Object.entries(r.liveness).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  for (const [k, xs] of r.violations) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return failed;
}

// The enum oracle: did the answer come while the text it started is still held by the provider? With W.hang the fake provider
// holds every text until `release` runs, and nothing runs it before the answer is in (or the deadline passes): an answer that
// waits for its text can never arrive, however fast the store. So this is not a stopwatch on the store. It used to be one (an
// answer within 25 ms), which a real Postgres store on a loaded CI runner missed without waiting for anything: the account's
// own number does one more store round trip (countSend) than any other number, and the 1.5 s pacing floor (deps.ts), not the
// test's 25 ms, is what hides that from the person typing. The deadline only ends a scenario whose answer never came.
export const ANSWER_DEADLINE_MS = 5_000;
export async function answeredWhileHeld<T>(pr: Promise<T>, release: () => void, deadlineMs = ANSWER_DEADLINE_MS): Promise<{ answered: boolean; value: T }> {
  let timer = 0;
  const won = await Promise.race([pr.then(() => "answer"), new Promise<string>((res) => { timer = setTimeout(() => res("deadline"), deadlineMs); })]);
  clearTimeout(timer);
  if (won !== "answer") release(); // let a waiting answer finish, so the scenario ends and the rest of it still runs
  return { answered: won === "answer", value: await pr };
}

// ---------------------------------------------------------------- one world
export interface Env {
  ids: Record<Who, string>;
  sessions: SessionStore;
  snapshot(): Promise<string>; // the session store's whole state for these accounts (sessions and sign-ins)
  liveSessions(who: Who, now: number): Promise<string[]>; // id hashes of unrevoked, unexpired sessions
}
interface Res { status: number; headers: Headers; body: string; method: string }
type Hdrs = Record<string, string>;
const SAME: Hdrs[] = [{ origin: HOST, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin" }, { origin: HOST }, {}];
const CROSS: Hdrs[] = [{ origin: EVIL, "sec-fetch-site": "cross-site" }, { origin: "null", "sec-fetch-site": "cross-site" }, { origin: EVIL }, { origin: "null" },
  { origin: "https://jobs.trainee.example", "sec-fetch-site": "same-site" }, { referer: `${EVIL}/x` }, { origin: "https://trainee.example.evil.example", "sec-fetch-site": "cross-site" },
  { origin: "http://trainee.example" }, { origin: `${HOST}:8443` }, { origin: EVIL, "sec-fetch-site": "cross-site", referer: `${HOST}/file` }];
const NAV: Hdrs = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }; // opening the link from Telegram

export async function runScenario(s: Scenario, env: Env, rep: Report): Promise<void> {
  const r = rng(7919 * (s.id + 1) + SEED);
  rep.scenarios++; rep.byCat[s.cat] = (rep.byCat[s.cat] ?? 0) + 1;
  const violate = (kind: string, msg: string) => { const l = rep.violations.get(kind) ?? []; l.push(`#${s.id} ${s.cat}: ${msg}`.slice(0, 400)); rep.violations.set(kind, l); };
  const live = (k: string) => { rep.liveness[k] = (rep.liveness[k] ?? 0) + 1; };
  const W = {
    now: T0, fault: null as string | null, hang: false, releases: [] as (() => void)[],
    texts: [] as { phone: string; code: string }[], checks: [] as { phone: string; code: string }[], codes: new Map<string, string>(), used: new Set<string>(),
    approvals: [] as string[], paced: [] as string[], background: 0,
    ids: new Map<string, Who>(), // oracle: live session ids -> account
  };
  const whoOf = (id: string): Who | null => (id === env.ids.u ? "u" : id === env.ids.v ? "v" : null);

  // ---- the lists: U has three postings, each prepared; V has one. In an xss scenario U's postings carry payloads.
  const xss = s.cat === "xss";
  const P = (i: number) => xss ? pick(r, PAYLOADS) + String(i) : "";
  const jobs: Record<Who, JobView[]> = { u: [], v: [] }, refs: Record<Who, string[]> = { u: [], v: [] };
  const preps = new Map<string, PreparedRow>(), postings = new Map<string, Record<string, unknown>>(), apps = new Map<string, AppRow>();
  const slug = (c: string) => c.toLowerCase();
  for (const who of ["u", "v"] as Who[]) {
    for (let i = 0; i < PEOPLE[who].companies.length; i++) {
      const c = PEOPLE[who].companies[i], jobId = `greenhouse:${slug(c)}:${i + 1}`;
      const url = xss && who === "u" && r() < 0.3 ? pick(r, ["javascript:alert(9)", "data:text/html,<script>alert(10)</script>", `https://boards.greenhouse.io/${slug(c)}/jobs/${i + 1}?q="><script>alert(11)</script>`]) : `https://boards.greenhouse.io/${slug(c)}/jobs/${i + 1}`;
      const post = { job_id: jobId, provider: "greenhouse", company_domain: `${slug(c)}.com`, location: xss && who === "u" ? `Austin ${P(i)}` : "Austin, TX", pay: xss && who === "u" ? `$90k ${P(i)}` : "$90k",
        description: `<p>Build dashboards and own the weekly pricing report ${who === "u" ? P(i) : ""}.</p><p>Requirements</p><ul><li>3 years of SQL ${who === "u" ? P(i) : ""}</li></ul>` };
      postings.set(jobId, post);
      const v = jobViewOf({ job_id: jobId, company: who === "u" && xss ? `${c} ${P(i)}` : c, title: who === "u" && xss ? `${PEOPLE[who].titles[i]} ${P(i)}` : PEOPLE[who].titles[i], location: "Austin, TX", url, pay: "$90k" }, post as never);
      jobs[who].push(v);
      const ref = await refOf(env.ids[who], jobId); refs[who].push(ref);
      preps.set(`${who}|${jobId}`, { id: `33333333-3333-4333-8333-${who === "u" ? "1" : "2"}${String(i + 1).padStart(11, "0")}`, job_id: jobId, company: c, url, payload_hash: (await sha256(`${s.id}|${who}|${i}`)), state: "ready", card_lines: [],
        payload: { resume_sha256: "f".repeat(64), resume_name: PEOPLE[who].resume, fields: [{ name: "first_name", label: "First name", value: PEOPLE[who].first }, { name: "last_name", label: "Last name", value: PEOPLE[who].last }] } });
    }
  }
  const kv = new Map<string, unknown>();
  for (const who of ["u", "v"] as Who[]) { jobs[who].forEach((v, i) => kv.set(`${env.ids[who]}|job|${refs[who][i]}`, { job: v, shownAs: "text" })); kv.set(`${env.ids[who]}|list|${who === "u" ? LIST_U : LIST_V}`, refs[who]); }
  const boom = (where: string) => { if (W.fault === where) { W.fault = null; throw new Error(`TypeError: relation "public.${where}" does not exist\n    at handler (file:///srv/supabase/functions/trainee-file/store.ts:42:7)`); } };
  const store: FileStore = {
    async remember() {}, async rememberList() {},
    async recall(u, ref) { boom("store"); return (kv.get(`${u}|job|${ref}`) as { job: JobView; shownAs: "text" }) ?? null; },
    async recallList(u, id) { boom("store"); return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async postings(ids) { return ids.map((id) => postings.get(id)).filter(Boolean) as never; },
    async save() { return "saved"; },
    async prepared(u, jobId) { const w = whoOf(u); return w && !apps.has(`${w}|${jobId}`) ? preps.get(`${w}|${jobId}`) ?? null : null; },
    async applied(u, jobId) { const w = whoOf(u); return !!w && apps.has(`${w}|${jobId}`); },
    async want() { return { result: "queued" }; },
    async appRow(u, jobId) { const w = whoOf(u); return w ? apps.get(`${w}|${jobId}`) ?? null : null; },
    async wanted() { return false; },
  };
  const confirm = async (u: string, ids: string[], hashes: string[]) => {
    const w = whoOf(u)!;
    const results = ids.map((pid, n) => {
      const p = [...preps.entries()].find(([k, x]) => k.startsWith(`${w}|`) && x.id === pid)?.[1];
      if (!p || p.payload_hash !== hashes[n]) throw new Error("card_changed");
      const key = `${w}|${p.job_id}`;
      if (apps.has(key)) return { n: n + 1, company: p.company, result: "duplicate" };
      apps.set(key, { id: `a-${key}`, state: "queued", reason: null, confirmation_id: null, created_at: new Date(W.now).toISOString(), updated_at: new Date(W.now).toISOString(), email_confirmed_at: null, payload: {}, company: p.company, url: p.url });
      W.approvals.push(key); rep.approvals++;
      return { n: n + 1, company: p.company, result: "queued" };
    });
    return { card: { id: "44444444-4444-4444-8444-000000000001", items: [], shown_at: new Date(W.now).toISOString() }, results };
  };
  const base = env.sessions;
  const sessions: SessionStore = {
    async createSession(x) { boom("sessions"); return await base.createSession(x); },
    async session(h) { boom("sessions"); return await base.session(h); },
    async setList(h, l) { boom("sessions"); return await base.setList(h, l); },
    async revoke(h, at) { boom("sessions"); return await base.revoke(h, at); },
    async revokeAll(u, at) { boom("sessions"); return await base.revokeAll(u, at); },
    async beginLogin(l) { boom("sessions"); return await base.beginLogin(l); },
    async login(j) { boom("sessions"); return await base.login(j); },
    async setPhone(j, p, m) { boom("sessions"); return await base.setPhone(j, p, m); },
    async countSend(j, m) { boom("sessions"); return await base.countSend(j, m); },
    async countTry(j, m) { boom("sessions"); return await base.countTry(j, m); },
    async finishLogin(j, at) { boom("sessions"); return await base.finishLogin(j, at); },
  };
  const phone: PhoneAuth = {
    async ready() { return true; },
    async accountPhone(u) { boom("phone"); const w = whoOf(u); return w ? PHONES[w] : null; },
    send(p) {
      let code = "";
      do { code = String(100000 + Math.floor(r() * 900000)); } while (W.used.has(code));
      W.used.add(code); W.texts.push({ phone: p, code }); W.codes.set(p, code); rep.texts++;
      if (!W.hang) return Promise.resolve({ ok: true as const });
      return new Promise((res) => W.releases.push(() => res({ ok: true as const })));
    },
    async check(p, code) {
      boom("phone");
      W.checks.push({ phone: p, code });
      if (W.codes.get(p) !== code) return null;
      W.codes.delete(p);
      return p === PHONES.u ? env.ids.u : p === PHONES.v ? env.ids.v : null;
    },
  };
  const d = {
    store, cards: { async open() { throw new Error("not used: confirm is"); }, confirm } as never, tap: { async card() { return null; }, async prepared() { return []; }, async answer() { return []; } },
    now: () => W.now, env: { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file`, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] },
    sessions, phone, userOfTelegram: async (tg: string) => (tg === "777" ? env.ids.u : tg === "888" ? env.ids.v : null),
    // what the deployed function pads every phone step with (deps.ts): here only recorded, so the battery can see it is the same
    pace: async (step: string) => { W.paced.push(step); },
    background: (p: Promise<unknown>) => { W.background++; p.catch(() => {}); },
  } as unknown as FileDeps;

  // ---- one request, checked against every universal invariant
  // starts: the Mini App post that may open a session of that account (its page then carries the new session's own id)
  interface Req { method?: string; path?: string; query?: Record<string, string> | string; form?: Record<string, string>; body?: BodyInit | null; jar?: Map<string, string>; cookie?: string; headers?: Hdrs; cross?: boolean; starts?: Who }
  const presentedOf = (o: Req): string[] => {
    const ids: string[] = [];
    const ck = o.cookie ?? (o.jar ? [...o.jar].map(([k, v]) => `${k}=${v}`).join("; ") : "");
    for (const part of ck.split(";")) { const [k, ...v] = part.trim().split("="); if (k === "tf_s") ids.push(v.join("=")); }
    if (o.form?.t) ids.push(o.form.t);
    return ids;
  };
  async function call(o: Req): Promise<Res> {
    const method = o.method ?? (o.form || o.body !== undefined ? "POST" : "GET");
    const q = typeof o.query === "string" ? o.query : o.query ? `?${new URLSearchParams(o.query)}` : "";
    const cookie = o.cookie ?? (o.jar ? [...o.jar].map(([k, v]) => `${k}=${v}`).join("; ") : "");
    const headers: Hdrs = { ...(cookie ? { cookie } : {}), ...(o.headers ?? {}) };
    let body: BodyInit | null = null;
    if (o.form) { body = new URLSearchParams(o.form).toString(); headers["content-type"] ??= "application/x-www-form-urlencoded"; }
    else if (o.body !== undefined) body = o.body;
    const req = new Request(`${HOST}${o.path ?? "/file"}${q}`, { method, headers, body: method === "GET" || method === "HEAD" ? null : body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
    let res: Response;
    try { res = await handleFile(req, d); } catch (e) { violate("the handler threw", String(e).slice(0, 120)); return { status: 0, headers: new Headers(), body: "", method }; }
    const text = method === "HEAD" ? "" : await res.text();
    const out: Res = { status: res.status, headers: res.headers, body: text, method };
    if (method === "HEAD" && res.body) { const extra = await res.text(); if (extra.length) violate("a HEAD answer carried a body", extra.slice(0, 60)); }
    rep.requests++; rep.statuses[res.status] = (rep.statuses[res.status] ?? 0) + 1;
    await universal(o, out);
    if (o.jar) for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const [k, ...v] = kv.split("="); if (/Max-Age=0/i.test(c) || !v.join("=")) o.jar.delete(k.trim()); else o.jar.set(k.trim(), v.join("=")); }
    return out;
  }
  const scriptHash = async (src: string) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src)))))}'`;
  async function universal(o: Req, x: Res) {
    const h = x.headers, where = `${x.method} ${o.form?.action ?? (typeof o.query === "object" ? Object.keys(o.query ?? {}).join(",") : o.query ?? "")} -> ${x.status}`;
    const fail = (k: string, m = "") => violate(k, `${where}${m ? `: ${m}` : ""}`);
    if (!STATUSES.has(x.status)) fail("an unexpected status");
    if (!/no-store/.test(h.get("cache-control") ?? "")) fail("a cacheable response", h.get("cache-control") ?? "(none)");
    const csp = h.get("content-security-policy") ?? "";
    const fa = /frame-ancestors ([^;]+)/.exec(csp)?.[1]?.trim() ?? "";
    if (!fa || fa.split(/\s+/).some((v) => !/^https:\/\/(\*\.)?(web\.)?telegram\.org$/.test(v) && v !== "'none'")) fail("frameable by any site (frame-ancestors)", fa || "(none)");
    if (!/default-src 'none'/.test(csp)) fail("no default-src 'none'", csp.slice(0, 60));
    if (/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\s\*|\shttps:(\s|;|$))/.test(csp)) fail("script-src allows more than hashed scripts");
    if (h.get("x-content-type-options") !== "nosniff") fail("no nosniff");
    if (!["no-referrer", "same-origin"].includes(h.get("referrer-policy") ?? "")) fail("a referrer policy that sends the URL to other sites", h.get("referrer-policy") ?? "(none)");
    if (h.get("access-control-allow-origin") || h.get("access-control-allow-credentials")) fail("a CORS grant");
    for (const c of h.getSetCookie()) {
      const name = c.split("=")[0].trim(), max = /Max-Age=(-?\d+)/i.exec(c)?.[1];
      if (!/;\s*HttpOnly/i.test(c) || !/;\s*Secure/i.test(c) || !/;\s*SameSite=(Lax|Strict)/i.test(c) || !/;\s*Path=\/(;|$)/.test(c)) fail("a cookie without HttpOnly / Secure / SameSite / Path=/", c.slice(0, 20));
      if (/;\s*Domain=/i.test(c)) fail("a cookie widened to a Domain");
      if (/;\s*Expires=/i.test(c)) fail("a cookie with an absolute Expires");
      if (!["tf_s", "tf_l"].includes(name)) fail("an unknown cookie", name);
      if (max === undefined) fail("a cookie that lives past the browser session without a Max-Age", name);
      else if (Number(max) > (name === "tf_s" ? SESSION_TTL_MS : LOGIN_TTL_MS) / 1000) fail("a cookie that outlives the server's own TTL", `${name} ${max}`);
      const v = c.split(";")[0].split("=").slice(1).join("=");
      if (name === "tf_s" && v && !/^fs1\.[0-9a-f]{64}$/.test(v)) fail("a session cookie that is not a session id");
    }
    const loc = h.get("location");
    if (loc !== null && (!/^\/(?![\/\\])/.test(loc) || /fs1\.|[?#]|^\/[^\/]*:/.test(loc))) fail("a redirect off this host's own path", loc);
    if (x.method === "HEAD" && x.body) fail("a HEAD answer with a body");
    const body = x.body, low = body.toLowerCase();
    // no stack trace, no exception text, no source path
    if (/TypeError|ReferenceError|SyntaxError|RangeError|Error:|\.ts:\d+|file:\/\/|\/srv\/|supabase\/functions|relation "/.test(body)) fail("an error's text reached the page", body.match(/.{0,30}(TypeError|Error:|\.ts:\d+|file:\/\/|relation ").{0,30}/)?.[0] ?? "");
    // session ids: only the one this request presented (an action page's own forms), never another
    const presented = presentedOf(o);
    const started = o.starts && !o.cross ? [...body.matchAll(/name="t" value="(fs1\.[0-9a-f]{64})"/g)].map((m) => m[1]) : [];
    for (const id of started) if (!W.ids.has(id)) W.ids.set(id, o.starts!);
    for (const m of body.matchAll(/fs1\.[0-9a-f]{64}/g)) if (!presented.includes(m[0]) && !started.includes(m[0])) fail("another session's id in the page");
    // private content: only for a request that carried a live session of that account
    for (const who of ["u", "v"] as Who[]) {
      const has = PRIV[who].some((p) => low.includes(p));
      const may = [...presented, ...started].some((id) => W.ids.get(id) === who);
      if (has && o.cross) fail("private content in the answer to a cross-site post", PRIV[who].find((p) => low.includes(p)));
      else if (has && !may) fail(`${who === "u" ? "U" : "V"}'s private content without a live session of ${who === "u" ? "U" : "V"}`, PRIV[who].find((p) => low.includes(p)));
      if (phoneLeak(body, PHONES[who])) fail("a phone number in the page");
    }
    if (/text\/html/.test(h.get("content-type") ?? "") && body) {
      for (const re of RAW_MARKS) if (re.test(body)) fail("injected markup rendered", body.match(new RegExp(`.{0,20}${re.source}.{0,20}`, "i"))?.[0] ?? re.source);
      const tags = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
      if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(tags)) fail("an event handler attribute", /<[a-z][^>]*\son[a-z]+\s*=[^>]*>/i.exec(tags)?.[0]?.slice(0, 80));
      for (const m of body.matchAll(/(?:href|src|action)="([^"]*)"/g)) { const v = m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim(); if (/^(javascript|vbscript|data):/i.test(v) && !/^data:image\/svg\+xml,/.test(v)) fail("a javascript:/data: link", v.slice(0, 40)); }
      const ss = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
      for (const m of body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        const tag = m[0].slice(0, m[0].indexOf(">") + 1);
        if (/\ssrc=/.test(tag)) { if (!/src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"/.test(tag)) fail("a script from somewhere else", tag); continue; }
        if (!ss.includes(await scriptHash(m[1]))) fail("an inline script the CSP does not allow");
      }
    }
  }

  // ---- the people's moves
  const mint = async (who: Who, o: { iat?: number; exp?: number } = {}) => await forge({ u: env.ids[who], r: who === "u" ? LIST_U : LIST_V, k: "l", j: jti(r), i: o.iat ?? W.now, e: o.exp ?? W.now + 24 * HOUR });
  const open = async (jar: Map<string, string>, link: string, extra: Hdrs = {}, path?: string) => await call({ query: { t: link }, jar, headers: { ...NAV, ...extra }, path });
  const post = async (jar: Map<string, string>, form: Record<string, string>, hdr: Hdrs = pick(r, SAME), o: Partial<Req> = {}) => await call({ form, jar, headers: hdr, ...o });
  const fmt = (p: string) => { const d10 = p.slice(-10); return pick(r, [p, d10, `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`, `+1 ${d10.slice(0, 3)} ${d10.slice(3, 6)} ${d10.slice(6)}`, `1${d10}`]); };
  const guess = () => { let c = ""; do { c = String(100000 + Math.floor(r() * 900000)); } while ([...W.codes.values()].includes(c)); return c; };
  const otherNumber = () => `+1${pick(r, ["415", "212", "737", "646"])}555${String(1000 + Math.floor(r() * 8999))}`;
  // The owner's whole sign-in from a fresh link, by same-origin posts. Returns the session id (or null) and records it.
  async function signIn(who: Who, jar: Map<string, string>, o: { link?: string; path?: string } = {}): Promise<string | null> {
    const link = o.link ?? await mint(who);
    const a = await open(jar, link, {}, o.path);
    if (a.status !== 303 || !jar.get("tf_l")) return null;
    const b = await post(jar, { action: "phone_start", phone: fmt(PHONES[who]) }, pick(r, SAME), { path: o.path });
    if (b.status !== 200) return null;
    const code = W.codes.get(PHONES[who]);
    if (!code) return null;
    const c = await post(jar, { action: "phone_verify", code: pick(r, [code, `${code.slice(0, 3)} ${code.slice(3)}`, `${code.slice(0, 3)}-${code.slice(3)}`]) }, pick(r, SAME), { path: o.path });
    const id = jar.get("tf_s") ?? null;
    if (c.status !== 303 || !id) return null;
    W.ids.set(id, who); rep.sessions++;
    return id;
  }
  // The page's own Sign out, from the browser that holds the session (its cookie, and the page token its page carries; a session id
  // alone in a form signs nothing out since the page-token round, file_session.ts PAGE_TOKEN).
  const signOutAs = async (id: string, jar = new Map([["tf_s", id]])) => await post(jar, { t: (await pageTokenOf(await sha256(id), SECRET))!, action: "signout" });
  const pageOf = (body: string) => ({ t: /name="t" value="([^"]+)"/.exec(body)?.[1] ?? "", rows: [...body.matchAll(/name="ref" value="([0-9a-f]{12})"><input type="hidden" name="tag" value="([0-9a-f]{16}|none)"/g)].map((m) => ({ ref: m[1], tag: m[2] })), set: /name="set" value="([0-9a-f]{16})"/.exec(body)?.[1] ?? null });
  const readable = async (jar: Map<string, string>) => { const x = await call({ jar, headers: { "sec-fetch-site": "same-origin" } }); return x.status === 200 && PRIV.u.some((p) => x.body.toLowerCase().includes(p)) ? x : null; };
  const unchanged = async (before: string, what: string, extra = "") => { const after = await env.snapshot(); if (after !== before) violate(`${what} changed the session store`, extra); };
  const counters = () => `${W.texts.length}|${W.checks.length}|${W.approvals.length}`;

  switch (s.cat) {
    case "csrf_phone": {
      const jar = new Map<string, string>(), link = await mint("u");
      await open(jar, link);
      if (r() < 0.5) { await post(jar, { action: "phone_start", phone: fmt(PHONES.u) }); }
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const before = await env.snapshot(), c0 = counters();
        const step = pick(r, ["phone_start", "phone_start", "phone_verify", "phone_reset"] as const);
        const form: Record<string, string> = { action: step };
        if (step === "phone_start") form.phone = r() < 0.5 ? fmt(PHONES.u) : otherNumber();
        if (step === "phone_verify") form.code = guess();
        const x = await post(jar, form, pick(r, CROSS), { cross: true });
        if (x.status !== 403) violate("a cross-site sign-in post was not refused", `${step} -> ${x.status}`); else rep.refusedCross++;
        await unchanged(before, `a cross-site ${step}`);
        if (counters() !== c0) violate(`a cross-site ${step} texted or checked a code`, `${c0} -> ${counters()}`);
      }
      // the owner, on this page, still signs in
      W.codes.delete(PHONES.u);
      const b = await post(jar, { action: "phone_start", phone: fmt(PHONES.u) });
      const code = W.codes.get(PHONES.u);
      if (b.status === 200 && code) {
        const c = await post(jar, { action: "phone_verify", code });
        if (c.status === 303 && jar.get("tf_s")) { W.ids.set(jar.get("tf_s")!, "u"); rep.sessions++; if (await readable(jar)) live("csrf_phone: owner still signs in"); else violate("liveness: the owner's session did not open the list", ""); }
        else violate("liveness: the owner's code did not sign in after a refused cross-site post", String(c.status));
      } else violate("liveness: the owner got no code after a refused cross-site post", String(b.status));
      break;
    }
    case "csrf_action": {
      const jar = new Map<string, string>();
      const id = await signIn("u", jar);
      if (!id) { violate("liveness: sign-in failed", ""); break; }
      const page = await readable(jar);
      if (!page) { violate("liveness: the list did not open", ""); break; }
      const pg = pageOf(page.body);
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const before = await env.snapshot(), c0 = counters();
        const action = pick(r, ["apply", "apply", "applyall", "signout", "signout_all", "refresh"] as const);
        const form: Record<string, string> = { action };
        const leaked = r() < 0.7;
        if (leaked) form.t = pg.t;
        if (action === "apply") { const row = pick(r, pg.rows); form.ref = row?.ref ?? ""; form.tag = row?.tag ?? ""; }
        if (action === "applyall") form.set = pg.set ?? "";
        const x = await post(jar, form, pick(r, CROSS), { cross: true });
        if (x.status !== 403 && x.status !== 401) violate("a cross-site action was not refused", `${action}${leaked ? " (with the session's form value)" : ""} -> ${x.status}`); else rep.refusedCross++;
        await unchanged(before, `a cross-site ${action}`);
        if (counters() !== c0) violate(`a cross-site ${action} approved something`, `${c0} -> ${counters()}`);
      }
      // still signed in; Apply as shown, from the page, approves; sign out from the page ends the session
      if (!(await readable(jar))) { violate("liveness: a refused cross-site post signed the owner out", ""); break; }
      const row = pg.rows.find((x) => x.tag !== "none");
      if (row) {
        const n = W.approvals.length;
        await post(jar, { t: pg.t, action: "apply", ref: row.ref, tag: row.tag });
        if (W.approvals.length === n + 1) live("csrf_action: Apply from the page approves"); else violate("liveness: Apply from the page did not approve", "");
      }
      if (r() < 0.5) {
        const all = r() < 0.5;
        await post(jar, { t: pg.t, action: all ? "signout_all" : "signout" });
        W.ids.delete(id);
        const after = await call({ cookie: `tf_s=${id}`, headers: { "sec-fetch-site": "same-origin" } });
        if (after.status !== 401) violate("a signed-out session still opened the page", String(after.status)); else live("csrf_action: sign-out ends the session");
        if ((await env.liveSessions("u", W.now)).includes(await sha256(id))) violate("a signed-out session is live in the store", "");
      }
      break;
    }
    case "csrf_init": {
      const tg = pick(r, ["777", "888"]);
      for (let k = 1 + Math.floor(r() * 2); k > 0; k--) {
        const before = await env.snapshot();
        const x = await call({ form: { init: await signedInit(tg, Math.floor(W.now / 1000) - 30), list: tg === "777" ? LIST_U : LIST_V }, headers: pick(r, CROSS), cross: true });
        if (x.status !== 403) violate("a cross-site Mini App post was not refused", String(x.status)); else rep.refusedCross++;
        await unchanged(before, "a cross-site Mini App post");
      }
      const x = await call({ form: { init: await signedInit("777", Math.floor(W.now / 1000) - 30), list: LIST_U }, headers: pick(r, SAME.slice(0, 3)), starts: "u" });
      const t = /name="t" value="(fs1\.[0-9a-f]{64})"/.exec(x.body)?.[1];
      if (x.status === 200 && t && W.ids.get(t) === "u") live("csrf_init: the Mini App opens from the page");
      else violate("liveness: the same-origin Mini App post did not open the list", String(x.status));
      break;
    }
    case "methods": {
      const jar = new Map<string, string>();
      const signed = r() < 0.6 ? await signIn("u", jar) : null;
      if (signed === null && jar.size) jar.clear();
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const before = await env.snapshot(), c0 = counters();
        const m = pick(r, ["HEAD", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH", "PROPFIND"] as const);
        const withLink = r() < 0.6 ? await mint("u") : null;
        const x = await call({ method: m, query: withLink ? { t: withLink } : r() < 0.3 ? { format: "text" } : undefined, jar: new Map(jar), headers: m === "HEAD" ? NAV : { origin: EVIL, "access-control-request-method": "POST" },
          body: m === "HEAD" ? undefined : "action=signout_all", form: undefined });
        if (m === "HEAD") {
          if (x.headers.getSetCookie().length) violate("a HEAD set a cookie", x.headers.getSetCookie()[0].split("=")[0]);
        } else {
          if (x.status !== 405) violate("an unsupported method was not 405", `${m} -> ${x.status}`);
          if (!/GET/.test(x.headers.get("allow") ?? "") || !/POST/.test(x.headers.get("allow") ?? "")) violate("405 without an Allow header", `${m}: ${x.headers.get("allow") ?? "(none)"}`);
        }
        await unchanged(before, `a ${m}${withLink ? " with a link" : ""}${signed ? " (signed in)" : ""}`);
        if (counters() !== c0) violate(`a ${m} texted, checked or approved`, "");
        // the link still opens normally afterwards (a HEAD from a link scanner does not start its sign-in clock or use it up)
        if (withLink && m === "HEAD") {
          W.now += 20 * MIN;
          const j2 = new Map<string, string>();
          const o = await open(j2, withLink);
          if (o.status !== 303 || !j2.get("tf_l")) violate("liveness: a link HEAD-fetched 20 minutes earlier no longer opens", String(o.status));
          else { const p = await call({ jar: j2, headers: { "sec-fetch-site": "same-origin" } }); if (p.status === 200 && /name="phone"/.test(p.body)) live("methods: a HEAD-fetched link still opens later"); else violate("liveness: a HEAD-fetched link did not reach the phone step later", String(p.status)); }
          W.now -= 20 * MIN;
        }
      }
      if (signed && !(await readable(jar))) violate("liveness: the session did not survive HEAD/OPTIONS/...", "");
      break;
    }
    case "body": {
      const jar = new Map<string, string>(), link = await mint("u");
      await open(jar, link);
      for (let k = 1 + Math.floor(r() * 2); k > 0; k--) {
        const before = await env.snapshot(), c0 = counters();
        const size = pick(r, [POLICY.bodyCap + 1, 100_000, 400_000, 1_000_000]);
        const head = `action=phone_start&phone=${encodeURIComponent(PHONES.u)}&pad=`;
        let pulled = 0;
        const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
        let left = size - head.length;
        const stream = new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new TextEncoder().encode(head)); pulled += head.length; },
          pull(c) { if (left <= 0) { c.close(); return; } const n = Math.min(left, chunk.length); c.enqueue(chunk.subarray(0, n)); left -= n; pulled += n; },
        });
        const lie = pick(r, ["honest", "none", "small"] as const);
        const hdr: Hdrs = { ...pick(r, SAME), "content-type": "application/x-www-form-urlencoded", ...(lie === "honest" ? { "content-length": String(size) } : lie === "small" ? { "content-length": "40" } : {}) };
        const x = await call({ method: "POST", body: stream, jar, headers: hdr });
        if (x.status !== 413) violate("a body past the cap was not refused with 413", `${size} bytes (${lie} length) -> ${x.status}`);
        if (pulled > POLICY.bodyCap + 2 * chunk.length + head.length) violate("a body was read far past the cap", `${pulled} of ${size} bytes read`);
        await unchanged(before, "an oversized body");
        if (counters() !== c0) violate("an oversized body texted", "");
      }
      // a body under the cap still works
      const x = await post(jar, { action: "phone_start", phone: fmt(PHONES.u), pad: "b".repeat(Math.floor(r() * 8000)) });
      if (x.status === 200 && W.codes.get(PHONES.u)) live("body: a normal body under the cap works"); else violate("liveness: a normal-size phone step failed", String(x.status));
      break;
    }
    case "link": {
      const u = env.ids.u, j = jti(r);
      const variant = pick(r, ["span_future", "span_past", "span_max", "iat_future", "other_secret", "prefix", "sha1", "sha512", "std_b64", "no_sig", "kind_s", "j_upper", "other_list", "list_of_other", "expired", "garbage_e"] as const);
      const c = { u, r: LIST_U, k: "l", j, i: W.now, e: W.now + 24 * HOUR } as Record<string, unknown>;
      let tok = "";
      let accept = false; // whether the link may begin a sign-in
      switch (variant) {
        case "span_future": c.e = W.now + pick(r, [30, 365, 3650]) * 24 * HOUR; tok = await forge(c); break;
        case "span_past": c.i = W.now - 100 * HOUR; c.e = W.now + 2 * HOUR; tok = await forge(c); break;
        case "span_max": c.i = W.now - 1 * HOUR; c.e = c.i as number + POLICY.linkSpanMs; tok = await forge(c); accept = true; break;
        case "iat_future": c.i = W.now + 2 * HOUR; c.e = W.now + 10 * HOUR; tok = await forge(c); break;
        case "other_secret": tok = await forge(c, { secret: OTHER_SECRET }); break;
        case "prefix": tok = await forge(c, { prefix: pick(r, ["v2", "v0", "V1", "none"]) }); break;
        case "sha1": tok = await forge(c, { hash: "SHA-1" }); break;
        case "sha512": tok = await forge(c, { hash: "SHA-512" }); break;
        case "std_b64": tok = await forge(c, { std: true }); break;
        case "no_sig": tok = await forge(c, { noSig: true }); break;
        case "kind_s": c.k = "s"; tok = await forge(c); break;
        case "j_upper": c.j = j.toUpperCase().replace(/[0-9]/, "A"); tok = await forge(c); break;
        case "other_list": c.r = LIST_V; tok = await forge(c); accept = true; break; // U's account, V's list id
        case "list_of_other": c.u = env.ids.v; tok = await forge(c); accept = true; break; // V's account, U's list id
        case "expired": c.e = W.now - 1; tok = await forge(c); break;
        case "garbage_e": c.e = pick(r, ["9999999999999", 1e308, null, "Infinity"]); tok = await forge(c); break;
      }
      const before = await env.snapshot();
      const jar = new Map<string, string>();
      const x = await open(jar, tok);
      if (!accept) {
        if (x.status === 303 || jar.get("tf_l")) violate("a bad link began a sign-in", variant);
        if (![403, 410].includes(x.status)) violate("a bad link was not a plain 403/410", `${variant} -> ${x.status}`);
        await unchanged(before, `a bad link (${variant})`);
      } else {
        if (x.status !== 303 || !jar.get("tf_l")) { violate("liveness: a good link did not begin a sign-in", `${variant} -> ${x.status}`); break; }
        // the account's own phone signs in; the list shown is only that account's own list (another's list id shows nothing)
        const who: Who = variant === "list_of_other" ? "v" : "u";
        await post(jar, { action: "phone_start", phone: fmt(PHONES[who]) });
        const code = W.codes.get(PHONES[who]);
        const v = code ? await post(jar, { action: "phone_verify", code }) : null;
        const id = jar.get("tf_s");
        if (!v || v.status !== 303 || !id) { violate("liveness: a good link's own account could not sign in", variant); break; }
        W.ids.set(id, who); rep.sessions++;
        const p = await call({ jar, headers: { "sec-fetch-site": "same-origin" } });
        const other: Who = who === "u" ? "v" : "u";
        if (PRIV[other].some((q) => p.body.toLowerCase().includes(q))) violate("another account's list through a link's list id", variant);
        if (variant === "span_max" && p.status === 200) live("link: a 72-hour link still works");
        if (variant !== "span_max" && p.status === 404) live("link: another account's list id shows nothing");
      }
      break;
    }
    case "cookies": {
      const jar = new Map<string, string>();
      const id = await signIn("u", jar);
      if (!id) { violate("liveness: sign-in failed", ""); break; }
      const vJar = new Map<string, string>();
      const vid = r() < 0.4 ? await signIn("v", vJar) : null;
      const dead = r() < 0.5 ? (await signIn("u", new Map())) : null;
      if (dead) { await signOutAs(dead); W.ids.delete(dead); }
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const variant = pick(r, ["truncated", "upper", "extra", "spaces", "quoted", "encoded", "oversize", "name_case", "dup_dead_first", "dup_live_first", "dup_other_first", "empty_then_live", "many", "tf_l_tamper", "nul"] as const);
        let cookie = "";
        switch (variant) {
          case "truncated": cookie = `tf_s=${id.slice(0, -1 - Math.floor(r() * 10))}`; break;
          case "upper": cookie = `tf_s=${id.toUpperCase()}`; break;
          case "extra": cookie = `tf_s=${id}0`; break;
          case "spaces": cookie = ` tf_s = ${id} `; break;
          case "quoted": cookie = `tf_s="${id}"`; break;
          case "encoded": cookie = `tf_s=${encodeURIComponent(id).replace(".", "%2E")}`; break;
          case "oversize": cookie = `tf_s=${"f".repeat(8000 + Math.floor(r() * 8000))}`; break;
          case "name_case": cookie = `TF_S=${id}`; break;
          case "dup_dead_first": cookie = `tf_s=${dead ?? "fs1." + "0".repeat(64)}; tf_s=${id}`; break;
          case "dup_live_first": cookie = `tf_s=${id}; tf_s=${dead ?? "fs1." + "0".repeat(64)}`; break;
          case "dup_other_first": cookie = vid ? `tf_s=${vid}; tf_s=${id}` : `tf_s=${id}`; break;
          case "empty_then_live": cookie = `tf_s=; tf_s=${id}`; break;
          case "many": cookie = [...Array(60)].map((_, i) => `c${i}=${"x".repeat(80)}`).join("; ") + `; tf_s=${id}`; break;
          case "tf_l_tamper": cookie = `tf_l=${(await mint("u")).slice(0, -3)}abc`; break;
          case "nul": cookie = `tf_s=${id.slice(0, 20)}%00${id.slice(20)}`; break;
        }
        const before = await env.snapshot();
        const x = await call({ cookie, headers: { "sec-fetch-site": "same-origin" } });
        if (variant === "tf_l_tamper") {
          const y = await call({ cookie, form: { action: "phone_start", phone: fmt(PHONES.u) }, headers: pick(r, SAME) });
          if (y.status !== 403) violate("a tampered tf_l opened a phone step", String(y.status));
          await unchanged(before, "a tampered tf_l");
        }
        if (x.status === 200 && PRIV.u.some((p) => x.body.toLowerCase().includes(p))) live(`cookies: ${variant} -> list`);
      }
      break;
    }
    case "fixation": {
      const jar = new Map<string, string>();
      const plant = pick(r, ["v_live", "never_issued", "u_revoked", "u_expired", "garbage"] as const);
      let planted = "";
      if (plant === "v_live") planted = (await signIn("v", new Map())) ?? "";
      else if (plant === "never_issued") planted = `fs1.${[...Array(64)].map(() => "0123456789abcdef"[Math.floor(r() * 16)]).join("")}`;
      else if (plant === "u_revoked") { planted = (await signIn("u", new Map())) ?? ""; await signOutAs(planted); W.ids.delete(planted); }
      else if (plant === "u_expired") { planted = (await signIn("u", new Map())) ?? ""; W.now += SESSION_TTL_MS + MIN; W.ids.delete(planted); }
      else planted = "planted-by-attacker";
      jar.set("tf_s", planted);
      const link = await mint("u");
      const a = await open(jar, link);
      if (plant === "v_live") {
        if (a.status !== 403) violate("another account's planted session was not stopped at the link", String(a.status));
        // the page's own Sign out (same origin) ends the planted session; then the link signs in
        await signOutAs(planted, jar);
        W.ids.delete(planted);
      }
      const id = await signIn("u", jar, { link });
      if (!id) { violate("liveness: the victim could not sign in after a planted cookie", plant); break; }
      if (id === planted) violate("a planted session id survived the sign-in", plant);
      const row = /^fs1\./.test(planted) ? await env.sessions.session(await sha256(planted)) : null;
      if (row && row.user_id === env.ids.u && !row.revoked_at && Date.parse(row.expires_at) > W.now) violate("a planted id is a live session of the victim", plant);
      if (await readable(jar)) live(`fixation: ${plant} -> fresh session`);
      break;
    }
    case "devices": {
      const link = await mint("u");
      const A = new Map<string, string>(), B = new Map<string, string>(), A2 = new Map<string, string>();
      await open(A, link);
      if (r() < 0.5) await open(B, link); else if (A.get("tf_l")) B.set("tf_l", A.get("tf_l")!); // forwarded link, or the copied cookie
      let aDone = false, bInterfered = false;
      for (let k = 0; k < 4 + Math.floor(r() * 5); k++) {
        const who = pick(r, ["A", "A", "B", "A2"] as const);
        const jar = who === "B" ? B : who === "A2" ? A2 : A;
        if (who === "A2" && !A2.size && A.get("tf_l")) A2.set("tf_l", A.get("tf_l")!); // a second tab of the owner's browser
        const step = pick(r, ["phone_start", "phone_verify", "phone_reset"] as const);
        const form: Record<string, string> = { action: step };
        if (step === "phone_start") form.phone = who === "B" ? (r() < 0.5 ? fmt(PHONES.u) : otherNumber()) : fmt(PHONES.u);
        if (step === "phone_verify") form.code = who === "B" ? guess() : (W.codes.get(PHONES.u) ?? guess());
        if (who === "B" && step !== "phone_verify") bInterfered = true;
        await post(jar, form);
        for (const [j, name] of [[A, "A"], [A2, "A2"], [B, "B"]] as const) {
          const id = j.get("tf_s");
          if (!id || W.ids.has(id)) continue;
          if (name === "B") violate("a forwarded copy of the link got a session", "");
          else { W.ids.set(id, "u"); rep.sessions++; aDone = true; }
        }
      }
      const n = (await env.liveSessions("u", W.now)).length;
      if (n > 1) violate("one link started more than one session", String(n));
      if (B.get("tf_s")) violate("the stranger's browser holds a session", "");
      if (aDone) live("devices: the owner signed in, the copy did not");
      else if (!bInterfered && W.codes.get(PHONES.u)) { /* the owner simply had not typed the code yet */ }
      break;
    }
    case "brute": {
      const links = 4 + Math.floor(r() * 9);
      const sendsBefore = W.texts.filter((t) => t.phone === PHONES.u).length;
      let locked = 0;
      for (let i = 0; i < links; i++) {
        const jar = new Map<string, string>();
        await open(jar, await mint("u"));
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) await post(jar, { action: "phone_start", phone: fmt(PHONES.u) }); // the stranger knows the number
        for (let k = 5 + Math.floor(r() * 3); k > 0; k--) { const x = await post(jar, { action: "phone_verify", code: guess() }); if (x.status === 429) locked++; if (jar.get("tf_s")) violate("a guessed code started a session", ""); }
        W.now += Math.floor(r() * 2 * MIN);
      }
      const texts = W.texts.filter((t) => t.phone === PHONES.u).length - sendsBefore, checks = W.checks.length;
      if (texts > POLICY.accountSendsPerHour) violate("texts to one account past the per-account cap", `${texts} texts from ${links} links`);
      if (checks > POLICY.accountTriesPerHour) violate("codes checked for one account past the per-account cap", `${checks} checks from ${links} links`);
      if (locked) live("brute: guessing locks");
      // an hour later the owner gets in from a fresh link
      W.now += HOUR + 5 * MIN; W.codes.clear();
      const id = await signIn("u", new Map());
      if (id) live("brute: the owner gets in after the hour"); else violate("liveness: the owner could not sign in an hour after the guessing", "");
      break;
    }
    case "enum": {
      W.hang = r() < 0.5; // the text provider is slow: the answer must not wait for it
      const own = new Map<string, string>(), other = new Map<string, string>();
      await open(own, await mint("u")); await open(other, await mint("u"));
      const p0 = W.paced.length;
      const settle = async (pr: Promise<Res>, what: string) => {
        const x = await answeredWhileHeld(pr, () => { for (const f of W.releases.splice(0)) f(); });
        if (!x.answered) violate("the answer waited for the text to go out (time tells the account's number)", `${what}: no answer in ${ANSWER_DEADLINE_MS} ms while its text was held (hang=${W.hang})`);
        else if (what === "own" && W.hang && W.releases.length) live("enum: answered while the text was held");
        return x.value;
      };
      const hdr = pick(r, SAME);
      const [a, b] = r() < 0.5
        ? [await settle(post(own, { action: "phone_start", phone: fmt(PHONES.u) }, hdr), "own"), await settle(post(other, { action: "phone_start", phone: otherNumber() }, hdr), "other")]
        : (await Promise.all([settle(post(other, { action: "phone_start", phone: otherNumber() }, hdr), "other"), settle(post(own, { action: "phone_start", phone: fmt(PHONES.u) }, hdr), "own")])).reverse();
      for (const f of W.releases.splice(0)) f();
      if (a.status !== b.status || a.body !== b.body || a.body !== CANON_CODE) violate("the answer to the account's number differs from any other number's", `${a.status}/${b.status}`);
      if (JSON.stringify(a.headers.getSetCookie().map((c) => c.split("=")[0])) !== JSON.stringify(b.headers.getSetCookie().map((c) => c.split("=")[0]))) violate("the cookies differ by number", "");
      const startPaced = W.paced.slice(p0);
      if (startPaced.filter((x) => x === "phone_start").length !== 2) violate("a phone step was not paced to the floor (time could tell the numbers apart)", `phone_start paced ${startPaced.length} of 2`);
      // a wrong code: the same answer and the same pacing either way
      const p1 = W.paced.length;
      const g = guess();
      const [c, e] = [await post(own, { action: "phone_verify", code: g }, hdr), await post(other, { action: "phone_verify", code: g }, hdr)];
      if (c.status !== e.status || c.body !== e.body) violate("a wrong code answers differently by number", `${c.status}/${e.status}`);
      if (W.paced.slice(p1).filter((x) => x === "phone_verify").length !== 2) violate("a code step was not paced to the floor (time could tell the numbers apart)", "");
      if (a.body === b.body) live("enum: same answer, same pacing");
      W.hang = false;
      break;
    }
    case "redirect": {
      const jar = new Map<string, string>();
      const path = pick(r, ["/file", "//evil.example/file", "/\\evil.example", "/%2F%2Fevil.example", "/file/..//evil.example", "/./%5Cevil.example", "/file;//evil.example"]);
      const extra = pick(r, ["next", "return", "redirect", "redirect_uri", "continue", "url"]);
      const link = await mint("u");
      const a = await call({ path, query: `?t=${encodeURIComponent(link)}&${extra}=${encodeURIComponent(pick(r, ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]))}`, jar, headers: NAV });
      if (a.status !== 303) { violate("liveness: a link with an extra parameter did not open", String(a.status)); break; }
      const id = await signIn("u", jar, { link, path });
      if (id === null && !jar.get("tf_s")) { /* a used link: the signIn re-opened it */ }
      live("redirect: every Location stayed on this host's path");
      break;
    }
    case "xss": {
      const jar = new Map<string, string>();
      // query parameters and form fields with payloads, signed out
      for (const k of ["t", "list", "format", "action", "ref"]) await call({ query: { [k]: pick(r, PAYLOADS) }, headers: NAV });
      await open(jar, await mint("u"));
      await post(jar, { action: "phone_start", phone: pick(r, PAYLOADS) });
      await post(jar, { action: pick(r, PAYLOADS), code: pick(r, PAYLOADS) });
      jar.clear();
      const id = await signIn("u", jar);
      if (!id) { violate("liveness: sign-in failed", ""); break; }
      const p = await readable(jar);
      if (!p) { violate("liveness: the list with payloads did not open", ""); break; }
      const pg = pageOf(p.body);
      await post(jar, { t: pg.t, action: "apply", ref: pick(r, pg.rows)?.ref ?? pick(r, PAYLOADS), tag: pick(r, [pick(r, pg.rows)?.tag ?? "", pick(r, PAYLOADS)]) });
      await post(jar, { t: pg.t, action: pick(r, PAYLOADS) });
      await call({ jar, query: { format: "text" }, headers: { "sec-fetch-site": "same-origin" } });
      live("xss: payloads only ever escaped");
      break;
    }
    case "unicode": {
      const jar = new Map<string, string>();
      await open(jar, await mint("u"));
      const d10 = PHONES.u.slice(-10);
      const toDigits = (s: string, zero: number) => s.replace(/[0-9]/g, (c) => String.fromCharCode(zero + Number(c)));
      const variants = [toDigits(PHONES.u, 0xFF10).replace("+", "＋"), toDigits(d10, 0x0660), toDigits(d10, 0x06F0), toDigits(d10, 0x0966), `+1 ${d10}`, `+1 ${d10}`, `+1​${d10}`, `‎+1${d10}`, `+1${d10}‮`,
        `+1 ${d10.slice(0, 3)}‑${d10.slice(3)}`, `+1${d10}́`, `📞${PHONES.u}`, `+1${d10}`.padEnd(40, " "), `\t+1${d10}\n`, `xn--${d10}`, `+1${toDigits(d10.slice(0, 5), 0xFF10)}${d10.slice(5)}`, PHONES.u.replace("+", "﹢"),
        `${otherNumber()} `, toDigits(otherNumber(), 0xFF10)];
      for (let k = 2 + Math.floor(r() * 3); k > 0; k--) {
        const typed = pick(r, variants);
        const x = await post(jar, { action: "phone_start", phone: typed });
        if (![200, 400].includes(x.status)) violate("a typed number got neither the code step nor a plain refusal", `${JSON.stringify(typed)} -> ${x.status}`);
        if (x.status === 200 && x.body !== CANON_CODE) violate("the code step differs by what was typed", JSON.stringify(typed));
        await post(jar, { action: "phone_reset" });
      }
      for (const t of W.texts) if (t.phone !== PHONES.u) violate("a text went to a number that is not the account's", t.phone);
      live("unicode: texts only to the account's number");
      break;
    }
    case "faults": {
      const jar = new Map<string, string>();
      const where = pick(r, ["sessions", "phone", "store"]);
      const at = Math.floor(r() * 4);
      const link = await mint("u");
      const steps = [() => open(jar, link), () => post(jar, { action: "phone_start", phone: fmt(PHONES.u) }), () => post(jar, { action: "phone_verify", code: W.codes.get(PHONES.u) ?? guess() }), () => call({ jar, headers: { "sec-fetch-site": "same-origin" } })];
      for (let i = 0; i < steps.length; i++) {
        if (i === at) W.fault = where;
        const x = await steps[i]();
        W.fault = null;
        if (jar.get("tf_s") && !W.ids.has(jar.get("tf_s")!)) { W.ids.set(jar.get("tf_s")!, "u"); rep.sessions++; }
        if (x.status >= 500 && !/[Tt]ry (the link )?again|again in a minute/.test(x.body)) violate("a failure page without a plain way forward", `${x.status} ${/<h1>([^<]*)/.exec(x.body)?.[1] ?? ""} / ${/<main[^>]*>(.*?)<\/main>/s.exec(x.body)?.[1]?.replace(/<[^>]+>/g, " ").slice(0, 160) ?? ""}`);
      }
      live("faults: plain messages only");
      break;
    }
  }
  // every session of U in the store was started by a sign-in the oracle saw
  const liveU = await env.liveSessions("u", W.now);
  const known = new Set(await Promise.all([...W.ids].filter(([, w]) => w === "u").map(([id]) => sha256(id))));
  for (const h of liveU) if (!known.has(h)) violate("a live session of U the oracle never saw start", h.slice(0, 12));
}

// ---------------------------------------------------------------- the memory store env
export function memEnv(): Env & { mem: ReturnType<typeof memSessions> } {
  const mem = memSessions();
  const ids = { u: "11111111-1111-4111-8111-1111111111aa", v: "22222222-2222-4222-8222-2222222222bb" };
  return { ids, mem, sessions: mem.store,
    async snapshot() { return JSON.stringify([[...mem.sessions].sort(), [...mem.logins].sort()]); },
    async liveSessions(who, now) { const out: string[] = []; for (const [h, row] of mem.sessions) if (row.user_id === ids[who] && !row.revoked_at && Date.parse(row.expires_at) > now) out.push(h); return out; },
  };
}

// The memory run of one part of the scenarios.
export async function memoryRun(part: number, parts: number): Promise<void> {
  const all = generate();
  const per = Math.ceil(all.length / parts), from = (part - 1) * per, to = Math.min(all.length, part * per);
  const only = Deno.env.get("FWS_ONLY");
  const rep = newReport();
  const started = Date.now();
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  try {
    for (const s of all.slice(from, to)) {
      if (only && String(s.id) !== only) continue;
      const env = memEnv();
      // a live session in the store is "live" by the oracle's clock only while unexpired: the memory env cannot know the clock,
      // so expiry is judged by the product's own check (the scenarios that expire a session also drop it from the oracle).
      await runScenario(s, env, rep);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`[file-websec] memory run, part ${part} of ${parts} (scenarios ${from + 1}-${to}): ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const failed = printReport(`memory stores, part ${part}`, rep);
  eq(outside, [], "nothing left the machine");
  if (!only) {
    const share = (n: number) => Math.floor(n * (to - from) / SCENARIO_COUNT);
    for (const [k, min] of [["csrf_phone: owner still signs in", 800], ["csrf_action: Apply from the page approves", 600], ["csrf_init: the Mini App opens from the page", 300], ["methods: a HEAD-fetched link still opens later", 150],
      ["body: a normal body under the cap works", 300], ["brute: the owner gets in after the hour", 300], ["enum: same answer, same pacing", 400], ["devices: the owner signed in, the copy did not", 150], ["xss: payloads only ever escaped", 400]] as const) {
      if ((rep.liveness[k] ?? 0) < share(min)) throw new Error(`liveness "${k}" checked only ${rep.liveness[k] ?? 0} times (want ≥ ${share(min)})`);
    }
    if (rep.refusedCross < share(2000)) throw new Error(`only ${rep.refusedCross} cross-site requests were refused`);
  }
  eq(failed, 0, "every invariant held after every request");
}
