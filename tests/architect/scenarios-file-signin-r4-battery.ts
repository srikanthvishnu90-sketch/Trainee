// The file page's sign-in and links, round 4 (owner, 2026-10-29: "a signed, expiring, single-use link is not proof of who opened
// it; a forwarded or copied link must never let another person read private data or apply"). A fresh-seed battery (~10,000
// scenarios, seed 20261105) through the real trainee-file handler (supabase/functions/trainee-file/handler.ts) over memory stores,
// plus a seeded sample through the deployed session store on real Postgres 16 (flow-scenarios-file-signin-r4.test.ts). The
// categories the earlier rounds (scenarios-file-signin*, -websec*, -session-binding*, -journey-r2*) do not cover:
//   two_devices     one link open on two or three browsers AT ONCE (the owner's phone and laptop, a stranger's forwarded copy),
//                   their phone steps interleaved and some sent at the same moment: at most one session per link, only in a
//                   browser that typed the code the owner's phone received;
//   split_code      the number typed on one browser and the code on another; the number changed on a second browser between
//                   the text and the code; the account's phone changed between them: a code opens a session only while the
//                   sign-in holds the account's CURRENT number and the code was texted to it;
//   lockout_oracle  four to six forwarded links of one account, each with a number typed and wrong codes guessed: the answers
//                   (status and page) are the same whether the number is the account's or not (the per-account cap must not
//                   tell the two apart);
//   account_change  the phone changes, the account is deleted, the Telegram identity is unlinked or moved, the person's lists are
//                   erased, while a page session (phone or Mini App) is live and while a sign-in is half done: nothing private and
//                   no Apply after, and the owner can sign in again with the new number;
//   stale_tab       Apply / Apply to all from a tab drawn before: the payload was prepared again, it was approved elsewhere, the
//                   person signed out and in again, another account signed in on that browser, the row left the list, the
//                   session expired: an approval only of the exact payload the tab showed, still the person's, never twice;
//   csrf_forms      the results page's own forms (answer, dismiss, restore, pause, resume, Apply selected, Apply, Sign out
//                   everywhere) posted by another site, a sibling subdomain or a downgraded origin, with the person's cookie and
//                   the page's token: nothing saved, marked, approved or signed out; and no answer is ever framed by a site;
//   cache_referrer  every answer (the list, the text version, the results page, the questions page, a logo, the sign-in, a
//                   refused link) is no-store, sends no referrer to another site, and no URL that leaves the page carries a link
//                   token, a session id or a page token;
//   host_spoof      Host, X-Forwarded-Host, Forwarded and X-Original-URL naming another site: nothing on the page or in a redirect
//                   points there;
//   long_query      very long, repeated, percent-garbled or NUL-laden query strings, link tokens and cookie headers: a known
//                   status, never a crash, never a session, nothing private without one.
// After EVERY response: one of the known statuses; no-store; CSP default-src 'none', frame-ancestors only Telegram's clients,
// form-action 'self' on a page; nosniff; a referrer policy that sends nothing to another site; cookies HttpOnly, Secure,
// SameSite, Path=/, no Domain; every redirect to this host's own path; no session id, page token or link token in any URL; no
// one-time code anywhere; nothing private without a session of that account that is entitled NOW (this file's own model: not
// signed out, not expired, the account's phone still the one it was opened with, the Telegram identity still linked); every
// approval is of the payload's current hash, equal to the tag the tapped tab showed, for the account whose session tapped it,
// once. The oracle never asks the product whether a request was allowed. No network: the phone and its texts are fakes.
import assertNode from "node:assert/strict";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, type JobView, type ListMeta, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { pageTokenOf, SESSION_TTL_MS, LOGIN_TTL_MS, sha256, startSession, type PhoneAuth, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import type { OpenQuestion, QuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { memSessions, signedInit } from "./file-session-fakes.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
// Built at run time: no whole key-shaped string on disk.
export const SECRET = ["file", "link", "round4", "0123456789", "abcdef"].join("-");
const BOT = ["515151", "ROUND4-bot-for-tests"].join(":");
const BOT_URL = "https://t.me/TraineeBot";
export const HOST = "https://trainee.example";
const EVIL = "https://evil.example";
export const LIST_U = "0123456789", LIST_R = "0a1b2c3d4e", LIST_V = "9876543210";
export const T0 = Date.parse("2026-11-05T15:00:00Z");
const HOUR = 3600_000, MIN = 60_000;
export const SCENARIO_COUNT = 10_000, SEED = 20261105;
const STATUSES = new Set([200, 303, 400, 401, 403, 404, 405, 410, 413, 429, 503]);

export const CATEGORIES = ["two_devices", "split_code", "lockout_oracle", "account_change", "stale_tab", "csrf_forms", "cache_referrer", "host_spoof", "long_query"] as const;
export type Category = typeof CATEGORIES[number];
const WEIGHTS: Record<Category, number> = { two_devices: 14, split_code: 12, lockout_oracle: 7, account_change: 13, stale_tab: 15, csrf_forms: 11, cache_referrer: 9, host_spoof: 8, long_query: 11 };

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export interface Scenario { id: number; cat: Category }
export function generate(count = SCENARIO_COUNT, seed = SEED): Scenario[] {
  const r = rng(seed), total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0), out: Scenario[] = [];
  for (let id = 0; id < count; id++) {
    let x = r() * total, cat: Category = "two_devices";
    for (const c of CATEGORIES) { x -= WEIGHTS[c]; if (x < 0) { cat = c; break; } }
    out.push({ id, cat });
  }
  return out;
}

// ---------------------------------------------------------------- the people (synthetic)
export const PHONES = { u: "+15125557421", v: "+14695558263" };
const NEW_PHONE = "+17375550188";
const PEOPLE = {
  u: { companies: ["Brindlequay", "Ostrovane", "Pellucidra"], titles: ["Tariff Cartographer", "Ledger Archivist", "Cohort Steward"], resume: "maribel-cv-r4.pdf", first: "Maribel", last: "Thistlewood" },
  v: { companies: ["Quorvella"], titles: ["Harbor Tactician"], resume: "osric-resume-r4.pdf", first: "Osric", last: "Fenwhistle" },
};
export type Who = "u" | "v";
const privOf = (p: typeof PEOPLE.u) => [...p.companies, ...p.titles, p.resume, p.first, p.last].map((s) => s.toLowerCase());
const PRIV: Record<Who, string[]> = { u: privOf(PEOPLE.u), v: privOf(PEOPLE.v) };
// A random id or token (a session id is fs1. + 64 hex) can hold any 7 digits by chance: one did, failing CI on #557.
// The check reads the page as a person would, so opaque runs are taken out first; every phone form is still looked for.
const opaqueOut = (s: string) => s.replace(/[0-9a-f]{16,}/gi, " ").replace(/[A-Za-z0-9_-]{32,}/g, " ");
const phoneLeak = (raw: string, phone: string) => { const body = opaqueOut(raw); const d10 = phone.replace(/[^0-9]/g, "").slice(-10); return body.includes(phone) || body.includes(d10) || body.includes(d10.slice(3)); };
const QUESTION = "Years of pricing analytics in a regulated market";

// ---------------------------------------------------------------- the report
export type Report = { scenarios: number; requests: number; statuses: Record<number, number>; byCat: Record<string, number>; sessions: number; approvals: number;
  refused: number; diffs: number; liveness: Record<string, number>; violations: Map<string, string[]> };
export const newReport = (): Report => ({ scenarios: 0, requests: 0, statuses: {}, byCat: {}, sessions: 0, approvals: 0, refused: 0, diffs: 0, liveness: {}, violations: new Map() });
export function printReport(name: string, r: Report): number {
  const failed = [...r.violations.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[file-signin-r4] ${name}: ${r.scenarios} scenarios (${Object.entries(r.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${r.requests} requests, ${failed} violations`,
    `  statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k}:${v}`).join(" ")}`,
    `  sessions started ${r.sessions}; approvals ${r.approvals}; cross-site posts refused ${r.refused}; lockout transcripts compared ${r.diffs}`,
    `  liveness checked: ${Object.entries(r.liveness).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  for (const [k, xs] of r.violations) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return failed;
}

// ---------------------------------------------------------------- one world
export interface Env {
  ids: Record<Who, string>;
  sessions: SessionStore;
  snapshot(): Promise<string>; // the session store's whole state for these accounts
  // What the database does to the account's file page sign-ins: "erase" is "forget everything" (the account written with a higher
  // epoch, paused), "delete" is account deletion.
  erase(who: Who, how: "erase" | "delete", at: number): Promise<void>;
}
type Hdrs = Record<string, string>;
interface Res { status: number; headers: Headers; body: string; method: string }
const SAME: Hdrs[] = [{ origin: HOST, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin" }, { origin: HOST }];
const CROSS: Hdrs[] = [{ origin: EVIL, "sec-fetch-site": "cross-site" }, { origin: "https://careers.trainee.example", "sec-fetch-site": "same-site" }, { origin: "null", "sec-fetch-site": "cross-site" },
  { origin: "http://trainee.example" }, { origin: EVIL }, { referer: `${EVIL}/frame.html` }, { origin: "https://trainee.example.evil.example", "sec-fetch-site": "cross-site" },
  { origin: EVIL, "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }, { origin: `${HOST}:444` }];
const NAV: Hdrs = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }; // opening the link from Telegram
interface SessRec { who: Who; via: "phone" | "telegram"; phone: string | null; tg: string | null; until: number; out: boolean; dead: boolean }

export async function runScenario(s: Scenario, env: Env, rep: Report): Promise<void> {
  const r = rng(104729 * (s.id + 1) + SEED);
  rep.scenarios++; rep.byCat[s.cat] = (rep.byCat[s.cat] ?? 0) + 1;
  const violate = (kind: string, msg: string) => { const l = rep.violations.get(kind) ?? []; l.push(`#${s.id} ${s.cat}: ${msg}`.slice(0, 400)); rep.violations.set(kind, l); };
  const live = (k: string) => { rep.liveness[k] = (rep.liveness[k] ?? 0) + 1; };
  if (s.cat === "lockout_oracle") return await lockoutOracle(s, env, rep, r, violate);
  const W = {
    now: T0, phones: { ...PHONES } as Record<Who, string | null>, tg: new Map<string, Who>([["777", "u"], ["888", "v"]]),
    texts: [] as { phone: string; code: string }[], codes: new Map<string, string>(), used: new Set<string>(),
    sess: new Map<string, SessRec>(), approvals: [] as { who: Who; jobId: string; hash: string }[], answers: [] as string[],
    inflight: null as null | { entitled: Set<Who>; tag: string | null; tabTags: Set<string> },
  };
  const whoOf = (id: string): Who | null => (id === env.ids.u ? "u" : id === env.ids.v ? "v" : null);
  // Entitled NOW: this file's own model. A session that a request presented while it did not bind is dead for good (the product
  // revokes it then; a laxer product is still caught, since the model never calls a session entitled while it does not bind).
  const binds = (x: SessRec) => x.via === "phone" ? !!x.phone && W.phones[x.who] === x.phone : !!x.tg && W.tg.get(x.tg) === x.who;
  const entitled = (id: string): Who | null => { const x = W.sess.get(id); return x && !x.out && !x.dead && W.now < x.until && binds(x) ? x.who : null; };

  // ---- the lists: U has three postings (two prepared, the third not; its employer asks a question), V has one, prepared.
  const jobs: Record<Who, JobView[]> = { u: [], v: [] }, refs: Record<Who, string[]> = { u: [], v: [] };
  const preps = new Map<string, PreparedRow>(), postings = new Map<string, Record<string, unknown>>(), apps = new Map<string, AppRow>();
  for (const who of ["u", "v"] as Who[]) {
    for (let i = 0; i < PEOPLE[who].companies.length; i++) {
      const c = PEOPLE[who].companies[i], slug = c.toLowerCase(), jobId = `greenhouse:${slug}:${i + 1}`, url = `https://boards.greenhouse.io/${slug}/jobs/${i + 1}`;
      const post = { job_id: jobId, provider: "greenhouse", company_domain: `${slug}.com`, location: "Austin, TX", pay: "$95k", description: `<p>Own the weekly pricing review.</p><ul><li>SQL</li></ul>` };
      postings.set(jobId, post);
      const v = jobViewOf({ job_id: jobId, company: c, title: PEOPLE[who].titles[i], location: "Austin, TX", url, pay: "$95k" }, post as never);
      jobs[who].push(v);
      refs[who].push(await refOf(env.ids[who], jobId));
      if (who === "u" && i === 2) continue;
      preps.set(`${who}|${jobId}`, { id: `55555555-5555-4555-8555-${who === "u" ? "1" : "2"}${String(i + 1).padStart(11, "0")}`, job_id: jobId, company: c, url, payload_hash: await sha256(`${s.id}|${who}|${i}|0`), state: "ready", card_lines: [],
        payload: { resume_sha256: "e".repeat(64), resume_name: PEOPLE[who].resume, fields: [{ name: "first_name", label: "First name", value: PEOPLE[who].first }, { name: "last_name", label: "Last name", value: PEOPLE[who].last }] } });
    }
  }
  const kv = new Map<string, unknown>();
  const meta = new Map<string, ListMeta>();
  const fillLists = () => {
    for (const who of ["u", "v"] as Who[]) { jobs[who].forEach((v, i) => kv.set(`${env.ids[who]}|job|${refs[who][i]}`, { job: v, shownAs: "text" })); kv.set(`${env.ids[who]}|list|${who === "u" ? LIST_U : LIST_V}`, [...refs[who]]); }
    kv.set(`${env.ids.u}|list|${LIST_R}`, [...refs.u]);
    meta.set(`${env.ids.u}|${LIST_R}`, { kind: "results", what: "Pricing analyst roles", floor: null, at: T0 - HOUR, name: null, source: "live", dismissed: [], paused: null });
  };
  fillLists();
  const erase = (who: Who) => { for (const k of [...kv.keys()]) if (k.startsWith(`${env.ids[who]}|`)) kv.delete(k); for (const k of [...meta.keys()]) if (k.startsWith(`${env.ids[who]}|`)) meta.delete(k); for (const k of [...preps.keys()]) if (k.startsWith(`${who}|`)) preps.delete(k); };
  const store: FileStore = {
    async remember() {}, async rememberList() {},
    async recall(u, ref) { return (kv.get(`${u}|job|${ref}`) as { job: JobView; shownAs: "text" }) ?? null; },
    async recallList(u, id) { return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async recallListMeta(u, id) { const m = meta.get(`${u}|${id}`); return m ? JSON.parse(JSON.stringify(m)) : null; },
    async rememberListMeta(u, id, m) { if (meta.has(`${u}|${id}`)) meta.set(`${u}|${id}`, JSON.parse(JSON.stringify(m))); },
    async postings(ids) { return ids.map((id) => postings.get(id)).filter(Boolean) as never; },
    async save() { return "saved"; },
    async prepared(u, jobId) { const w = whoOf(u); return w && !apps.has(`${w}|${jobId}`) ? preps.get(`${w}|${jobId}`) ?? null : null; },
    async applied(u, jobId) { const w = whoOf(u); return !!w && apps.has(`${w}|${jobId}`); },
    async want(u) { if (!W.inflight?.entitled.has(whoOf(u)!)) violate("a posting queued for an account whose session did not ask", u); return { result: "queued" }; },
    async appRow(u, jobId) { const w = whoOf(u); return w ? apps.get(`${w}|${jobId}`) ?? null : null; },
    async wanted() { return false; },
  };
  // The approval: the oracle checks it before it is recorded (the product's own card check is not trusted to catch it).
  const confirm = async (u: string, ids: string[], hashes: string[]) => {
    const w = whoOf(u);
    const results = ids.map((pid, n) => {
      const hit = [...preps.entries()].find(([, x]) => x.id === pid);
      if (!w || !hit) throw new Error("card_changed");
      const [key, p] = hit;
      if (!key.startsWith(`${w}|`)) violate("an approval of another account's payload", `${w} approved ${key}`);
      if (!W.inflight?.entitled.has(w)) violate("an approval without an entitled session of that account", `${w} ${p.job_id}`);
      if (hashes[n] !== p.payload_hash) violate("an approval of a payload that is not the current one", `${p.job_id}`);
      if (!W.inflight?.tabTags.has(hashTag(hashes[n]))) violate("an approval of a payload the tapped tab did not show", `${p.job_id} ${hashTag(hashes[n])}`);
      if (p.payload_hash !== hashes[n]) throw new Error("card_changed");
      const k = `${w}|${p.job_id}`;
      if (apps.has(k)) return { n: n + 1, company: p.company, result: "duplicate" };
      apps.set(k, { id: `a-${k}`, state: "queued", reason: null, confirmation_id: null, created_at: new Date(W.now).toISOString(), updated_at: new Date(W.now).toISOString(), email_confirmed_at: null, payload: {}, company: p.company, url: p.url });
      W.approvals.push({ who: w, jobId: p.job_id, hash: hashes[n] }); rep.approvals++;
      return { n: n + 1, company: p.company, result: "queued" };
    });
    return { card: { id: "66666666-6666-4666-8666-000000000001", items: [], shown_at: new Date(W.now).toISOString() }, results };
  };
  const questions: QuestionStore = {
    async open(u) {
      if (whoOf(u) !== "u" || !kv.has(`${env.ids.u}|list|${LIST_R}`) || W.answers.length) return [];
      return [{ id: "q-r4-1", key: "label:r4pricing", kind: "text", label: QUESTION, type: "text", options: [], company: PEOPLE.u.companies[2], job_ids: [jobs.u[2].job_id], misfit: false, answer: null } as OpenQuestion];
    },
    async countOpen() { return 0; }, async get() { return []; }, async shown() { return null; }, async setShown() {}, async lastAssistantIntent() { return null; },
    async answer(u, id, a) { if (!W.inflight?.entitled.has(whoOf(u)!)) violate("an answer saved for an account whose session did not send it", `${id}=${a}`); W.answers.push(`${id}=${a}`); },
  } as unknown as QuestionStore;
  const phone: PhoneAuth = {
    async ready() { return true; },
    async accountPhone(u) { const w = whoOf(u); return w ? W.phones[w] : null; },
    send(p) {
      if (!Object.values(W.phones).includes(p)) violate("a text to a number that is no account's current phone", p);
      let code = "";
      do { code = String(100000 + Math.floor(r() * 900000)); } while (W.used.has(code));
      W.used.add(code); W.texts.push({ phone: p, code }); W.codes.set(p, code);
      return Promise.resolve({ ok: true as const });
    },
    async check(p, code) {
      if (W.codes.get(p) !== code) return null;
      W.codes.delete(p);
      return p === W.phones.u ? env.ids.u : p === W.phones.v ? env.ids.v : null;
    },
  };
  const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const d = {
    store, cards: { async open() { throw new Error("not used: confirm is"); }, confirm } as never, tap: { async card() { return null; }, async prepared() { return []; }, async answer() { return []; } },
    now: () => W.now, env: { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file`, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] },
    sessions: env.sessions, phone, questions, userOfTelegram: async (tg: string) => { const w = W.tg.get(tg); return w ? env.ids[w] : null; },
    logoFetch: (async () => new Response(LOGO, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch,
    logoCache: (() => { const m = new Map(); return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => m.set(k, v) }; })(),
  } as unknown as FileDeps;

  // ---- one request, checked against every universal invariant
  interface Req { method?: string; url?: string; query?: string; form?: Record<string, string>; body?: string; jar?: Map<string, string>; cookie?: string; headers?: Hdrs; cross?: boolean; tab?: string; starts?: Who }
  const cookieOf = (o: Req) => o.cookie ?? (o.jar ? [...o.jar].map(([k, v]) => `${k}=${v}`).join("; ") : "");
  const presented = (o: Req): string[] => {
    const ids: string[] = [];
    for (const part of cookieOf(o).split(";")) { const [k, ...v] = part.trim().split("="); if (k === "tf_s") ids.push(v.join("=")); }
    if (o.form?.t && o.form?.init) ids.push(o.form.t);
    return ids;
  };
  async function call(o: Req): Promise<Res> {
    const method = o.method ?? (o.form || o.body !== undefined ? "POST" : "GET");
    const cookie = cookieOf(o);
    const headers: Hdrs = { ...(cookie ? { cookie } : {}), ...(o.headers ?? {}) };
    let body: string | null = null;
    if (o.form) { body = new URLSearchParams(o.form).toString(); headers["content-type"] ??= "application/x-www-form-urlencoded"; } else if (o.body !== undefined) body = o.body;
    // Who this request may act for: the sessions it carries that the model calls entitled now (a Mini App post: only with init).
    const ent = new Set<Who>();
    for (const id of presented(o)) { const w = entitled(id); if (w && !(o.cross)) ent.add(w); }
    if (o.starts) ent.add(o.starts); // a Mini App sign-in whose Telegram identity is linked to that account now
    W.inflight = { entitled: ent, tag: o.form?.tag ?? null, tabTags: new Set(o.tab ? [...o.tab.matchAll(/name="tag" value="([0-9a-f]{16})"/g)].map((m) => m[1]) : []) };
    const req = new Request(`${o.url ?? HOST}/file${o.query ?? ""}`, { method, headers, body: method === "GET" || method === "HEAD" ? null : body });
    let res: Response;
    try { res = await handleFile(req, d); } catch (e) { violate("the handler threw", String(e).slice(0, 120)); W.inflight = null; return { status: 0, headers: new Headers(), body: "", method }; }
    W.inflight = null;
    const ct = res.headers.get("content-type") ?? "";
    const text = /^image\//.test(ct) ? "" : await res.text();
    const out: Res = { status: res.status, headers: res.headers, body: text, method };
    rep.requests++; rep.statuses[res.status] = (rep.statuses[res.status] ?? 0) + 1;
    // A session the product refused while it did not bind is dead in the model from now on.
    for (const id of presented(o)) { const x = W.sess.get(id); if (x && !binds(x)) x.dead = true; }
    universal(o, out, ent);
    if (o.jar) for (const c of res.headers.getSetCookie()) { const [kv0] = c.split(";"); const [k, ...v] = kv0.split("="); if (/Max-Age=0/i.test(c) || !v.join("=")) o.jar.delete(k.trim()); else o.jar.set(k.trim(), v.join("=")); }
    return out;
  }
  function universal(o: Req, x: Res, ent: Set<Who>) {
    const h = x.headers, where = `${x.method} ${o.form?.action ?? (o.query ?? "").slice(0, 40)} -> ${x.status}`;
    const fail = (k: string, m = "") => violate(k, `${where}${m ? `: ${m}` : ""}`);
    if (!STATUSES.has(x.status)) fail("an unexpected status");
    if (!/no-store/.test(h.get("cache-control") ?? "")) fail("a cacheable response", `${h.get("content-type")} ${h.get("cache-control") ?? "(none)"}`);
    const csp = h.get("content-security-policy") ?? "";
    if (!/default-src 'none'/.test(csp)) fail("no default-src 'none'", csp.slice(0, 60));
    const image = /^image\//.test(h.get("content-type") ?? "");
    if (image && !/sandbox/.test(csp)) fail("an image answer that is not sandboxed");
    if (!image && x.status !== 303) {
      const fa = /frame-ancestors ([^;]+)/.exec(csp)?.[1]?.trim() ?? "";
      if (!fa || fa.split(/\s+/).some((v) => !/^https:\/\/(\*\.)?(web\.)?telegram\.org$/.test(v) && v !== "'none'")) fail("frameable by another site (frame-ancestors)", fa || "(none)");
      if (/text\/html/.test(h.get("content-type") ?? "") && !/form-action 'self'/.test(csp)) fail("a page whose forms may post elsewhere (form-action)");
    }
    if (h.get("x-content-type-options") !== "nosniff") fail("no nosniff");
    if (!["no-referrer", "same-origin"].includes(h.get("referrer-policy") ?? "")) fail("a referrer policy that sends the URL to other sites", h.get("referrer-policy") ?? "(none)");
    if (h.get("access-control-allow-origin")) fail("a CORS grant");
    for (const c of h.getSetCookie()) {
      if (!/;\s*HttpOnly/i.test(c) || !/;\s*Secure/i.test(c) || !/;\s*SameSite=(Lax|Strict)/i.test(c) || !/;\s*Path=\/(;|$)/.test(c) || /;\s*Domain=/i.test(c)) fail("a cookie without HttpOnly / Secure / SameSite / Path=/ or with a Domain", c.slice(0, 20));
    }
    const loc = h.get("location");
    if (loc !== null && (!/^\/(?![\/\\])/.test(loc) || /fs1\.|fp1\.|v1\.|[?#]/.test(loc) || /evil/.test(loc))) fail("a redirect off this host's own path, or carrying a token", loc);
    const body = x.body, low = body.toLowerCase();
    for (const t of W.texts) if (body.includes(t.code)) fail("a one-time code on a page", t.code);
    if (/evil\.example/.test(body)) fail("a spoofed host reflected on the page", body.match(/.{0,30}evil\.example.{0,30}/)?.[0] ?? "");
    if (/\bv1\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{43}\b/.test(body)) fail("a link token on a page");
    for (const m of body.matchAll(/fs1\.[0-9a-f]{64}/g)) if (!presented(o).includes(m[0]) && !o.starts) fail("a session id on a page that did not present it");
    // every URL on the page: none carries a token; an off-site one carries nothing of the session or the link
    for (const m of body.matchAll(/(?:href|src|action|content)="([^"]*)"/g)) {
      const v = m[1].replace(/&amp;/g, "&");
      if (/[?&](t|token|s|session|init)=/i.test(v) || /fs1\.|fp1\.|tf_s|tf_l/.test(v)) fail("a URL carrying a token", v.slice(0, 80));
    }
    for (const who of ["u", "v"] as Who[]) {
      const has = PRIV[who].find((p) => low.includes(p));
      if (has && !ent.has(who)) fail(`${who.toUpperCase()}'s private content without an entitled session of ${who.toUpperCase()}`, has);
      for (const p of [PHONES[who], NEW_PHONE]) if (phoneLeak(body, p)) fail("a phone number on a page");
    }
  }

  // ---- moves
  const mint = async (who: Who, list = who === "u" ? LIST_U : LIST_V) => (await mintFileToken({ secret: SECRET, userId: env.ids[who], list, now: W.now, kind: "l" }))!;
  const open = async (jar: Map<string, string>, link: string) => await call({ query: `?t=${encodeURIComponent(link)}`, jar, headers: NAV });
  const post = async (jar: Map<string, string>, form: Record<string, string>, hdr: Hdrs = pick(r, SAME), o: Partial<Req> = {}) => await call({ form, jar, headers: hdr, ...o });
  const fmt = (p: string) => { const d10 = p.slice(-10); return pick(r, [p, d10, `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`, `+1 ${d10.slice(0, 3)} ${d10.slice(3, 6)} ${d10.slice(6)}`]); };
  const guess = () => { let c = ""; do { c = String(100000 + Math.floor(r() * 900000)); } while ([...W.codes.values()].includes(c)); return c; };
  const otherNumber = () => `+1${pick(r, ["415", "212", "646", "303"])}555${String(1000 + Math.floor(r() * 8999))}`;
  // A session started by a code: the model records it only when the code was the live one texted to the account's current phone.
  const noteSession = (jar: Map<string, string>, before: string | undefined, who: Who, ok: boolean, why: string) => {
    const id = jar.get("tf_s");
    if (!id || id === before || W.sess.has(id)) return;
    if (!ok) { violate("a session started that the model does not allow", why); return; }
    W.sess.set(id, { who, via: "phone", phone: W.phones[who], tg: null, until: W.now + SESSION_TTL_MS, out: false, dead: false }); rep.sessions++;
  };
  async function signIn(who: Who, jar: Map<string, string>, list?: string): Promise<string | null> {
    const a = await open(jar, await mint(who, list));
    if (a.status !== 303) return null;
    const b = await post(jar, { action: "phone_start", phone: fmt(W.phones[who]!) });
    const code = W.codes.get(W.phones[who]!);
    if (b.status !== 200 || !code) return null;
    const before = jar.get("tf_s");
    const c = await post(jar, { action: "phone_verify", code });
    noteSession(jar, before, who, true, "the owner's own sign-in");
    return c.status === 303 ? jar.get("tf_s") ?? null : null;
  }
  // A session the way a finished sign-in leaves it (for scenarios about what a signed-in page does): cookie in the jar.
  async function seat(who: Who, jar: Map<string, string>, list: string, via: "phone" | "telegram" = "phone"): Promise<string> {
    const id = await startSession(env.sessions, { userId: env.ids[who], via, phone: via === "phone" ? W.phones[who] : null, telegramId: via === "telegram" ? (who === "u" ? "777" : "888") : null, list, now: W.now });
    W.sess.set(id, { who, via, phone: via === "phone" ? W.phones[who] : null, tg: via === "telegram" ? (who === "u" ? "777" : "888") : null, until: W.now + SESSION_TTL_MS, out: false, dead: false });
    if (via === "phone") jar.set("tf_s", id);
    return id;
  }
  const tokenOf = (body: string) => /name="t" value="([^"]+)"/.exec(body)?.[1] ?? "";
  const rowsOf = (body: string) => [...body.matchAll(/name="ref" value="([0-9a-f]{12})"><input type="hidden" name="tag" value="([0-9a-f]{16}|none)"/g)].map((m) => ({ ref: m[1], tag: m[2] }));
  const setOf = (body: string) => /name="set" value="([0-9a-f]{16})"/.exec(body)?.[1] ?? null;
  const sees = (x: Res) => x.status === 200 && PRIV.u.some((p) => x.body.toLowerCase().includes(p));

  switch (s.cat) {
    case "two_devices": {
      // A: the owner's phone browser, C: the owner's laptop (both see the texts), B: a stranger with a forwarded copy.
      const jars = { A: new Map<string, string>(), B: new Map<string, string>(), C: new Map<string, string>() };
      const owner = (k: keyof typeof jars) => k !== "B";
      const link = await mint("u");
      const order = pick(r, [["A", "B"], ["B", "A"], ["A", "B", "C"], ["B", "C", "A"], ["C", "A", "B"]] as (keyof typeof jars)[][]);
      for (const k of order) await open(jars[k], link);
      const startedBy = new Set<string>();
      for (let n = 3 + Math.floor(r() * 9); n > 0; n--) {
        const k = pick(r, order), jar = jars[k];
        const move = pick(r, ["start_own", "start_own", "start_other", "verify", "verify", "reset", "get", "together"] as const);
        if (move === "get") { const x = await call({ jar, headers: { "sec-fetch-site": "none" } }); if (sees(x) && !owner(k)) violate("the stranger's browser read the list", k); continue; }
        if (move === "reset") { await post(jar, { action: "phone_reset" }); continue; }
        if (move === "start_own" || move === "start_other") { await post(jar, { action: "phone_start", phone: move === "start_own" ? fmt(PHONES.u) : otherNumber() }); continue; }
        const codeFor = (kk: keyof typeof jars) => owner(kk) && r() < 0.8 ? (W.codes.get(PHONES.u) ?? guess()) : guess();
        if (move === "verify") {
          const before = jar.get("tf_s"), code = codeFor(k), live0 = W.codes.get(PHONES.u) === code;
          await post(jar, { action: "phone_verify", code });
          noteSession(jar, before, "u", owner(k) && live0, `${k} typed ${live0 ? "the live code" : "a guess"}`);
          if (jar.get("tf_s") && jar.get("tf_s") !== before) startedBy.add(k);
        } else {
          // two browsers send their step at the same moment
          const k2 = pick(r, order.filter((x) => x !== k) as (keyof typeof jars)[]);
          const c1 = codeFor(k), c2 = codeFor(k2), b1 = jars[k].get("tf_s"), b2 = jars[k2].get("tf_s");
          const l1 = W.codes.get(PHONES.u) === c1, l2 = W.codes.get(PHONES.u) === c2;
          await Promise.all([post(jars[k], { action: "phone_verify", code: c1 }), post(jars[k2], r() < 0.5 ? { action: "phone_verify", code: c2 } : { action: "phone_start", phone: otherNumber() })]);
          noteSession(jars[k], b1, "u", owner(k) && l1, `${k} at once`); noteSession(jars[k2], b2, "u", owner(k2) && l2, `${k2} at once`);
          for (const [kk, b] of [[k, b1], [k2, b2]] as const) if (jars[kk].get("tf_s") && jars[kk].get("tf_s") !== b) startedBy.add(kk);
        }
      }
      if (startedBy.size > 1) violate("one link started sessions in two browsers", [...startedBy].join(","));
      if (startedBy.has("B")) violate("the stranger's browser got a session", "B");
      // liveness: the owner, with a fresh link, gets in
      const jar = new Map<string, string>();
      if (await signIn("u", jar) && sees(await call({ jar, headers: { "sec-fetch-site": "none" } }))) live("two_devices: owner signs in after"); else violate("liveness: the owner could not sign in with a fresh link", "");
      break;
    }
    case "split_code": {
      const A = new Map<string, string>(), C = new Map<string, string>(), B = new Map<string, string>();
      const link = await mint("u");
      await open(A, link); await open(C, link); if (r() < 0.5) await open(B, link);
      const typer = pick(r, [A, B.size ? B : A]);
      await post(typer, { action: "phone_start", phone: fmt(PHONES.u) });
      const code = W.codes.get(PHONES.u);
      if (!code) { violate("liveness: no code to the owner", ""); break; }
      const twist = pick(r, ["none", "none", "other_number_after", "reset_after", "phone_changed", "phone_changed_back", "late"] as const);
      let opens = true;
      if (twist === "other_number_after") { await post(pick(r, B.size ? [B, A] : [A]), { action: "phone_start", phone: otherNumber() }); opens = false; }
      if (twist === "reset_after") { await post(pick(r, B.size ? [B, A] : [A]), { action: "phone_reset" }); opens = false; }
      if (twist === "phone_changed") { W.phones.u = NEW_PHONE; opens = false; }
      if (twist === "phone_changed_back") { W.phones.u = NEW_PHONE; W.phones.u = PHONES.u; }
      if (twist === "late") { W.now += LOGIN_TTL_MS + MIN; opens = false; }
      const typedOn = pick(r, [C, A]);
      const before = typedOn.get("tf_s");
      const x = await post(typedOn, { action: "phone_verify", code: pick(r, [code, `${code.slice(0, 3)} ${code.slice(3)}`]) });
      noteSession(typedOn, before, "u", opens, `twist ${twist}`);
      if (opens && !(x.status === 303 && typedOn.get("tf_s"))) violate("liveness: the owner's code typed on their other browser opened nothing", `${twist} ${x.status}`);
      else if (opens) live("split_code: code on another browser opens it there");
      // nobody else got anything: the browser that typed the number (if not the one that typed the code) and the stranger
      for (const j of [A, B, C]) if (j !== typedOn && j.get("tf_s") && !W.sess.has(j.get("tf_s")!)) violate("a session in a browser that typed no code", "");
      if (!opens && typedOn.get("tf_s") && typedOn.get("tf_s") !== before) violate("a code opened a session after its sign-in changed", twist);
      break;
    }
    case "account_change": {
      const jar = new Map<string, string>();
      const viaTg = r() < 0.3;
      const tgId = "777";
      let tgSession = "";
      if (viaTg) {
        const init = await signedInit(tgId, Math.floor(W.now / 1000), BOT);
        const x = await call({ form: { list: LIST_U, init }, jar, headers: pick(r, SAME), starts: "u" });
        tgSession = /name="t" value="(fs1\.[0-9a-f]{64})"/.exec(x.body)?.[1] ?? "";
        if (!tgSession) { violate("liveness: the Mini App opened nothing", String(x.status)); break; }
        W.sess.set(tgSession, { who: "u", via: "telegram", phone: null, tg: tgId, until: W.now + SESSION_TTL_MS, out: false, dead: false });
        // (the Mini App page had U's list in the same answer: entitled at that moment by the model's own record from now on)
      } else await seat("u", jar, LIST_U);
      // a half-done sign-in on another browser, from another link
      const P = new Map<string, string>();
      await open(P, await mint("u"));
      await post(P, { action: "phone_start", phone: fmt(PHONES.u) });
      const pendingCode = W.codes.get(PHONES.u);
      const tab = viaTg ? "" : (await call({ jar, headers: { "sec-fetch-site": "none" } })).body;
      const change = pick(r, ["phone", "phone", "deleted", "tg_unlinked", "tg_moved", "erased", "phone_and_back"] as const);
      if (change === "phone") W.phones.u = NEW_PHONE;
      if (change === "deleted") { W.phones.u = null; W.tg.delete(tgId); erase("u"); await env.erase("u", "delete", W.now); }
      if (change === "tg_unlinked") W.tg.delete(tgId);
      if (change === "tg_moved") W.tg.set(tgId, "v");
      if (change === "erased") { erase("u"); await env.erase("u", "erase", W.now); for (const x of W.sess.values()) if (x.who === "u") x.out = true; }
      if (change === "phone_and_back") { W.phones.u = NEW_PHONE; await call({ jar, headers: { "sec-fetch-site": "none" } }); W.phones.u = PHONES.u; }
      W.now += Math.floor(r() * 30) * MIN;
      const approvals0 = W.approvals.length;
      for (let n = 1 + Math.floor(r() * 4); n > 0; n--) {
        const m = pick(r, ["get", "text", "apply", "applyall", "logo"] as const);
        const init = viaTg ? await signedInit(tgId, Math.floor(W.now / 1000), BOT) : "";
        const auth = viaTg ? { t: tgSession, init } : { t: tokenOf(tab) };
        if (m === "get" && !viaTg) await call({ jar, headers: { "sec-fetch-site": "none" } });
        else if (m === "text" && !viaTg) await call({ jar, query: "?format=text", headers: { "sec-fetch-site": "none" } });
        else if (m === "logo" && !viaTg) await call({ jar, query: `?logo=${PEOPLE.u.companies[0].toLowerCase()}.com`, headers: { "sec-fetch-site": "same-origin" } });
        else if (m === "apply") { const row = rowsOf(tab)[0]; await post(jar, { ...auth, action: "apply", ref: row?.ref ?? "000000000000", tag: row?.tag ?? "none" }, pick(r, SAME), { tab }); }
        else await post(jar, { ...auth, action: viaTg ? "refresh" : "applyall", set: setOf(tab) ?? "" }, pick(r, SAME), { tab });
      }
      // every approval was already checked against the model (an entitled session of that account, the current payload)
      if ((change === "deleted" || (change === "phone" && !viaTg) || (change.startsWith("tg") && viaTg)) && W.approvals.length !== approvals0) violate("an approval after the account changed", change);
      // the code texted to the old number before the change: it opens nothing now
      if (pendingCode) {
        const before = P.get("tf_s");
        await post(P, { action: "phone_verify", code: pendingCode });
        noteSession(P, before, "u", W.phones.u === PHONES.u && change !== "erased" && change !== "deleted", `pending code after ${change}`);
      }
      // liveness: with the account's current number (unless deleted), a fresh link signs in
      if (W.phones.u) { const j2 = new Map<string, string>(); if (change !== "erased" && change !== "deleted") { if (await signIn("u", j2)) live("account_change: signs in with the current number"); else violate("liveness: no sign-in with the current number", change); } }
      break;
    }
    case "stale_tab": {
      const jar = new Map<string, string>();
      await seat("u", jar, LIST_U);
      const tab = (await call({ jar, headers: { "sec-fetch-site": "none" } })).body;
      const rows = rowsOf(tab).filter((x) => x.tag !== "none");
      if (rows.length < 2) { violate("liveness: the tab offered no Apply", ""); break; }
      const twist = pick(r, ["none", "none", "reprepared", "reprepared_all", "approved_elsewhere", "signed_in_again", "other_account", "row_removed", "expired", "signed_out"] as const);
      const target = pick(r, rows), ji = refs.u.indexOf(target.ref), jobId = jobs.u[ji].job_id;
      if (twist === "reprepared" || twist === "reprepared_all") {
        for (const [k, p] of preps) if (k.startsWith("u|") && (twist === "reprepared_all" || p.job_id === jobId)) { p.payload_hash = await sha256(`${p.payload_hash}|again`); (p.payload as Record<string, unknown>).cover_note = "Written again"; }
      }
      if (twist === "approved_elsewhere") apps.set(`u|${jobId}`, { id: "a-elsewhere", state: "queued", reason: null, confirmation_id: null, created_at: new Date(W.now).toISOString(), updated_at: new Date(W.now).toISOString(), email_confirmed_at: null, payload: {}, company: PEOPLE.u.companies[ji], url: jobs.u[ji].url });
      if (twist === "signed_in_again") { await post(jar, { t: tokenOf(tab), action: "signout" }); await seat("u", jar, LIST_U); }
      if (twist === "other_account") { await post(jar, { t: tokenOf(tab), action: "signout" }); await seat("v", jar, LIST_V); }
      if (twist === "signed_out") { const id = jar.get("tf_s")!; await post(jar, { t: tokenOf(tab), action: "signout" }); const x = W.sess.get(id); if (x) x.out = true; jar.set("tf_s", id); }
      if (twist === "row_removed") kv.set(`${env.ids.u}|list|${LIST_U}`, refs.u.filter((x) => x !== target.ref));
      if (twist === "expired") W.now += SESSION_TTL_MS + MIN;
      for (const [id, x] of W.sess) if (twist === "signed_in_again" || twist === "other_account") { if (x.who === "u" && id !== jar.get("tf_s")) x.out = true; }
      const before = W.approvals.length;
      const all = r() < 0.35;
      const x = all ? await post(jar, { t: tokenOf(tab), action: "applyall", set: setOf(tab) ?? "" }, pick(r, SAME), { tab })
        : await post(jar, { t: tokenOf(tab), action: "apply", ref: target.ref, tag: target.tag }, pick(r, SAME), { tab });
      const got = W.approvals.slice(before);
      if (twist === "none") {
        if (!got.length) violate("liveness: Apply from a fresh tab approved nothing", `${all ? "all" : "one"} ${x.status}`); else live("stale_tab: fresh tab approves");
      } else if (twist === "reprepared_all" || twist === "signed_in_again" || twist === "other_account" || twist === "expired" || twist === "signed_out") {
        if (got.length) violate("an approval from a stale tab", twist);
        if (!/[Nn]othing (was )?(approved|sent)|nothing was opened, approved or changed|changed since/i.test(x.body)) violate("a refused tap that does not say nothing was approved", `${twist} ${x.status}`);
      } else if (got.some((g) => g.jobId === jobId)) violate("the changed row was approved from the stale tab", twist);
      if (all && (twist === "reprepared" || twist === "approved_elsewhere" || twist === "row_removed") && got.length) violate("Apply to all approved a set that is not the one shown", twist);
      // never twice: the same posting tapped again
      const again = await post(jar, { t: tokenOf(tab), action: "apply", ref: target.ref, tag: target.tag }, pick(r, SAME), { tab });
      void again;
      const seen = new Set<string>();
      for (const g of W.approvals) { const k = `${g.who}|${g.jobId}`; if (seen.has(k)) violate("one posting approved twice", k); seen.add(k); }
      break;
    }
    case "csrf_forms": {
      const jar = new Map<string, string>();
      await seat("u", jar, LIST_R);
      const page = await call({ jar, headers: { "sec-fetch-site": "none" } });
      const things = await call({ jar, query: `?things=${refs.u[2]}`, headers: { "sec-fetch-site": "none" } });
      const t = tokenOf(page.body) || tokenOf(things.body);
      if (!t || !sees(page)) { violate("liveness: the results page did not open", String(page.status)); break; }
      const before = { snap: await env.snapshot(), answers: W.answers.length, approvals: W.approvals.length, meta: JSON.stringify([...meta]) };
      for (let n = 1 + Math.floor(r() * 4); n > 0; n--) {
        const action = pick(r, ["answer", "dismiss", "restore", "pause", "resume", "applysel", "apply", "signout_all", "signout"] as const);
        const form: Record<string, string> = { t, action, ref: pick(r, refs.u) };
        if (action === "answer") { form.ref = refs.u[2]; form["q_q-r4-1"] = "4 years"; }
        if (action === "applysel") form.pick = rowsOf(page.body).map((x) => `${x.ref}:${x.tag}`)[0] ?? `${refs.u[0]}:0000000000000000`;
        if (action === "apply") { const row = rowsOf(page.body).find((x) => x.tag !== "none"); form.ref = row?.ref ?? refs.u[0]; form.tag = row?.tag ?? "none"; }
        const x = await post(jar, form, pick(r, CROSS), { cross: true, tab: page.body });
        if (x.status !== 403) violate("a cross-site post of the page's own form was not refused", `${action} -> ${x.status}`); else rep.refused++;
      }
      if (await env.snapshot() !== before.snap) violate("a cross-site post changed the session store", "");
      if (W.answers.length !== before.answers || W.approvals.length !== before.approvals || JSON.stringify([...meta]) !== before.meta) violate("a cross-site post saved, approved or marked something", "");
      // the same form, from the page itself: it works
      const ok = await post(jar, { t, action: "answer", ref: refs.u[2], "q_q-r4-1": "4 years" });
      if (ok.status === 200 && W.answers.length === before.answers + 1) live("csrf_forms: own answer saves"); else violate("liveness: the page's own answer did not save", String(ok.status));
      break;
    }
    case "cache_referrer": {
      const jar = new Map<string, string>();
      const list = pick(r, [LIST_U, LIST_R]);
      const how = pick(r, ["seat", "signin"] as const);
      if (how === "signin") { if (!(await signIn("u", jar, list))) { violate("liveness: sign-in failed", ""); break; } } else await seat("u", jar, list);
      const reads = ["", "?format=text", `?logo=${PEOPLE.u.companies[pick(r, [0, 1, 2])].toLowerCase()}.com`, `?things=${refs.u[2]}`, "?export=txt", "?pay=meets", "?state=ready"];
      for (const q of reads) await call({ jar, query: q, headers: { "sec-fetch-site": pick(r, ["none", "same-origin"]) } });
      // a refused link, an expired one, a used one: the URL in the bar still carries the token; the page sends no referrer anywhere
      const used = await mint("u");
      for (const q of [`?t=${await mint("v")}`, `?t=${used}`, `?t=${used}`, "?t=v1.abc.def"]) {
        const x = await call({ query: q, jar: pick(r, [jar, new Map<string, string>()]), headers: NAV });
        if (x.status === 200 && /<a [^>]*href="https?:/.test(x.body) && x.headers.get("referrer-policy") === "unsafe-url") violate("a page reached by a link token sends its URL on", q);
      }
      live("cache_referrer: every answer checked");
      break;
    }
    case "host_spoof": {
      const jar = new Map<string, string>();
      await seat("u", jar, pick(r, [LIST_U, LIST_R]));
      const spoof: Hdrs = pick(r, [{ "x-forwarded-host": "evil.example" }, { forwarded: "host=evil.example;proto=https" }, { "x-original-url": "https://evil.example/file" }, { "x-rewrite-url": "//evil.example/" }, { "x-forwarded-proto": "http", "x-forwarded-host": "evil.example:443" }]);
      const url = r() < 0.5 ? EVIL : HOST;
      for (const q of ["", "?format=text", `?t=${await mint("u")}`, `?logo=${PEOPLE.u.companies[0].toLowerCase()}.com`]) await call({ url, query: q, jar, headers: { ...spoof, "sec-fetch-site": "none" } });
      const fresh = new Map<string, string>();
      await call({ url, query: `?t=${await mint("u")}`, jar: fresh, headers: { ...spoof, ...NAV } });
      await call({ url, form: { action: "phone_start", phone: fmt(PHONES.u) }, jar: fresh, headers: { ...spoof, origin: HOST } });
      live("host_spoof: nothing reflected");
      break;
    }
    case "long_query": {
      const jar = new Map<string, string>();
      const signed = r() < 0.5;
      if (signed) await seat("u", jar, LIST_U);
      const ascii = (n: number) => [...Array(n)].map(() => pick(r, ["a", "%", "%zz", "&", "=", "t", ".", "+", "-", "_", "0"])).join("");
      const junk = (n: number) => [...Array(n)].map(() => pick(r, ["a", "%", "%zz", "%00", "%ff", "&", "=", "t", ".", "+", "%2e", "v1", "é", "‮", "%0d%0a"])).join("");
      for (let n = 1 + Math.floor(r() * 4); n > 0; n--) {
        const k = pick(r, ["long_t", "many_t", "garble", "nul", "long_logo", "long_things", "long_cookie", "many_fields", "list_and_t"] as const);
        let q = "", cookie: string | undefined, form: Record<string, string> | undefined;
        const link = await mint(pick(r, ["u", "v"] as Who[]));
        if (k === "long_t") q = `?t=${"v1." + "A".repeat(1 + Math.floor(r() * 60_000)) + "." + "B".repeat(43)}`;
        if (k === "many_t") q = `?${[...Array(1 + Math.floor(r() * 400))].map((_, i) => `t=${i === 0 ? junk(8) : link}`).join("&")}`;
        if (k === "garble") q = `?${junk(10 + Math.floor(r() * 4000))}`;
        if (k === "nul") q = `?t=${encodeURIComponent(link)}%00${junk(20)}`;
        if (k === "long_logo") q = `?logo=${"a".repeat(64)}.${"b".repeat(Math.floor(r() * 9000))}.com`;
        if (k === "long_things") q = `?things=${junk(5000)}&state=${junk(3000)}&where=${junk(3000)}&pay=${junk(50)}`;
        if (k === "list_and_t") q = `?list=${LIST_U}&t=${encodeURIComponent(link)}&format=text`;
        if (k === "long_cookie") cookie = `${[...Array(200)].map((_, i) => `x${i}=${ascii(20)}`).join("; ")}; tf_s=fs1.${"0".repeat(64)}; tf_l=${ascii(300)}${jar.get("tf_s") ? `; tf_s=${jar.get("tf_s")}` : ""}`;
        if (k === "many_fields") form = Object.fromEntries([...Array(2000)].map((_, i) => [`f${i}`, junk(8)]).concat([["action", "apply"], ["t", junk(64)], ["ref", junk(12)], ["tag", junk(16)]]));
        const sessions0 = W.sess.size, approvals0 = W.approvals.length;
        const x = await call({ query: q, jar: cookie ? undefined : jar, cookie, form, headers: pick(r, SAME) });
        if (x.status >= 500 && x.status !== 503) violate("a server error on a malformed request", `${k} ${x.status}`);
        if (W.approvals.length !== approvals0) violate("an approval from a malformed request", k);
        if (W.sess.size !== sessions0) violate("a session from a malformed request", k);
      }
      // the person's own page still reads
      if (signed) { if (sees(await call({ jar, headers: { "sec-fetch-site": "none" } }))) live("long_query: page still reads"); else violate("liveness: the page did not read after malformed requests", ""); }
      break;
    }
  }
}

// ---------------------------------------------------------------- lockout_oracle: the same script, the account's number or another
// Two fresh accounts in one store (u and v, no sign-ins yet): the script runs on u's links with u's own number as the candidate,
// then on v's links with a number that is NOT v's. Every answer (status and page) must be the same, request by request.
async function lockoutOracle(s: Scenario, env: Env, rep: Report, r: () => number, violate: (k: string, m: string) => void): Promise<void> {
  const links = 4 + Math.floor(r() * 3);
  const script: { useCand: boolean; tries: number; reset: boolean; fmt: number }[] = [];
  for (let i = 0; i < links; i++) script.push({ useCand: r() < 0.85, tries: 1 + Math.floor(r() * 6), reset: r() < 0.15, fmt: Math.floor(r() * 3) });
  const codes = [...Array(links * 8)].map(() => String(100000 + Math.floor(r() * 900000)));
  const junkNumber = `+1303555${String(1000 + Math.floor(r() * 8999))}`;
  const transcript = async (who: Who, cand: string): Promise<string[]> => {
    const t0 = T0 + s.id * 1000;
    const texts: string[] = [];
    const phone: PhoneAuth = {
      async ready() { return true; }, async accountPhone(u) { return u === env.ids.u ? PHONES.u : u === env.ids.v ? PHONES.v : null; },
      async send(p) { texts.push(p); return { ok: true as const }; }, async check() { return null; }, // the attacker never has the code
    };
    const d = { store: {} as never, cards: {} as never, tap: {} as never, now: () => t0, sessions: env.sessions, phone,
      env: { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file` } as Record<string, string>)[k] } } as unknown as FileDeps;
    const out: string[] = [];
    let c = 0;
    const fmtOf = (p: string, f: number) => { const d10 = p.slice(-10); return [p, d10, `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`][f]; };
    for (const step of script) {
      const link = (await mintFileToken({ secret: SECRET, userId: env.ids[who], list: who === "u" ? LIST_U : LIST_V, now: t0, kind: "l" }))!;
      const o = await handleFile(new Request(`${HOST}/file?t=${encodeURIComponent(link)}`, { headers: NAV }), d);
      const cookie = o.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
      const send = async (form: Record<string, string>) => {
        const x = await handleFile(new Request(`${HOST}/file`, { method: "POST", headers: { cookie, origin: HOST, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }), d);
        rep.requests++; rep.statuses[x.status] = (rep.statuses[x.status] ?? 0) + 1;
        out.push(`${form.action} ${x.status} ${(await x.text()).replace(/\s+/g, " ")}`);
      };
      await send({ action: "phone_start", phone: fmtOf(step.useCand ? cand : junkNumber, step.fmt) });
      for (let k = 0; k < step.tries; k++) await send({ action: "phone_verify", code: codes[c++ % codes.length] });
      if (step.reset) { await send({ action: "phone_reset" }); await send({ action: "phone_start", phone: fmtOf(step.useCand ? cand : junkNumber, step.fmt) }); await send({ action: "phone_verify", code: codes[c++ % codes.length] }); }
    }
    for (const p of texts) if (p !== PHONES[who]) violate("a text to a number that is not the account's", p);
    return out;
  };
  const own = await transcript("u", PHONES.u);
  const other = await transcript("v", `+1415555${String(1000 + Math.floor(r() * 8999))}`);
  rep.diffs++;
  if (own.length !== other.length) { violate("the answers differ in number between the account's own number and another", `${own.length} vs ${other.length}`); return; }
  for (let i = 0; i < own.length; i++) {
    if (own[i] !== other[i]) {
      const short = (x: string) => x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/^\S+ \d+|(Too many wrong codes|That code didn't work|This link was already used|Sign in)/g)?.join(" | ") ?? x.slice(0, 80);
      violate("an answer tells whether the typed number is the account's", `request ${i}: own "${short(own[i])}" vs other "${short(other[i])}"`);
      return;
    }
  }
}

// ---------------------------------------------------------------- the memory run
export function memEnv(): Env {
  const m = memSessions();
  const ids = { u: "aaaaaaaa-0000-4000-8000-000000000401", v: "aaaaaaaa-0000-4000-8000-000000000402" };
  return { ids, sessions: m.store, async snapshot() { return JSON.stringify([[...m.sessions].sort(), [...m.logins].sort()]); },
    async erase(who, how, at) { const u = ids[who]; if (how === "delete") { for (const [h, x] of m.sessions) if (x.user_id === u) m.sessions.delete(h); for (const [j, x] of m.logins) if (x.user_id === u) m.logins.delete(j); } else m.store.eraseAccount(u, at); } };
}
export async function memoryRun(part: number, parts: number): Promise<void> {
  const rep = newReport();
  const all = generate();
  const t0 = Date.now();
  for (const s of all) { if (s.id % parts !== part - 1) continue; await runScenario(s, memEnv(), rep); }
  console.log(`[file-signin-r4] part ${part} of ${parts}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  eq(rep.scenarios, all.filter((s) => s.id % parts === part - 1).length);
  for (const c of CATEGORIES) if (!rep.byCat[c]) throw new Error(`category ${c} never ran in part ${part}`);
  eq(printReport(`memory part ${part}/${parts}`, rep), 0, "every invariant held after every request");
}
