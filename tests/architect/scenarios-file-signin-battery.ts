// Sign-in at scale for the hosted jobs page (owner, 2026-10-29): ~10,000 seeded random scenarios
// (tests/architect/scenarios/file-signin-generator.ts) of owners, strangers with forwarded links, other accounts, link-preview
// crawlers and the Telegram Mini App, run through the real handler (supabase/functions/trainee-file/handler.ts) over memory
// stores; then a seeded sample through the deployed session store on real Postgres 16. After EVERY request:
//   - nobody without a valid session of account U gets anything private of U (companies, titles, resume name, field values,
//     U's phone or its last four digits, another person's session id); an error page carries nothing private at all;
//   - no approval unless the request carries a valid, unrevoked, unexpired session of U whose account check passes NOW, with
//     the exact current payload tag (Apply) or the exact set shown (Apply to all); never twice for one posting;
//   - a text goes only to the confirmed phone of the link's account; at most 3 per link; at most 5 code tries per link; a link
//     starts at most one session; a locked link starts none; a session starts only from a code that proves the link's account
//     (or Telegram's signed data for the linked Telegram id);
//   - the answer to a typed number is the same whether or not it is the account's;
//   - session ids never appear in a URL or Location; the store holds only their hashes; every cookie is HttpOnly; Secure;
//     SameSite=Lax; every status is one of 200/303/400/401/403/404/405/410/429/503 and the handler never throws;
//   - liveness: the owner who opens a fresh link reaches the phone step, a live code opens the list, Apply on what is shown queues it.
// The oracle is this file's own model of who holds which session, which code is live and what was shown; it never asks the
// product whether a session is valid. Clocks are injected, randomness is seeded (crypto.getRandomValues is replaced for the run
// and restored), no network: the phone and the texts are fakes, every fetch that is not the PostgREST double is refused.
import assertNode from "node:assert/strict";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { LOGIN_TTL_MS, MAX_CODE_SENDS, MAX_CODE_TRIES, normalizePhone, PAGE_TOKEN, pageTokenOf, SESSION_TTL_MS, sha256, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, type JobView, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { renderPhoneLogin } from "../../supabase/functions/_shared/file_page.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { memSessions } from "./file-session-fakes.ts";
import { type Actor, type CodeInput, generate, PHONE_FORMATS, type PhoneInput, rng, sample, type Scenario, type Step, type TPick } from "./scenarios/file-signin-generator.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests", OTHER_BOT = "654321:OTHER-BOT-for-tests";
const BOT_URL = "https://t.me/TraineeBot";
const LIST_U = "0123456789", LIST_V = "9876543210";
const T0 = Date.parse("2026-10-29T15:00:00Z");
const HOST = "https://trainee.example";
const SCENARIOS = generate({ seed: 20261029, count: 10_000 });
const ONLY = Deno.env.get("FSB_ONLY"), FIRST = Number(Deno.env.get("FSB_N") ?? 0); // local debugging: one scenario, or the first N
const PG_SAMPLE = 100;
// Split across test files for CI time (2026-10-30: the battery ran ~110 s in one file). scenarios-file-signin.test.ts and
// scenarios-file-signin-2.test.ts each call fileSigninTests(part): part 1 runs the regressions, each part its half of the
// 10,000 memory scenarios (every invariant after every request, as before), and part 2 the Postgres sample. Together they
// run every test of this battery once and every scenario once; part 1 checks the other is on disk and registers its part.
export const FILE_SIGNIN_PARTS = 2;
const registry: { parts: number[]; args: unknown[] }[] = [];
const later = (parts: number[], ...args: unknown[]) => { registry.push({ parts, args }); };
export function fileSigninTests(part: number) {
  if (!Number.isInteger(part) || part < 1 || part > FILE_SIGNIN_PARTS) throw new Error(`no part ${part} of ${FILE_SIGNIN_PARTS}`);
  for (const t of registry) if (t.parts.includes(part)) (Deno.test as (...a: unknown[]) => void)(...t.args);
  if (part === 1) {
    Deno.test(`file sign-in battery: all ${FILE_SIGNIN_PARTS} parts are test files, each registering its own part`, async () => {
      for (let k = 1; k <= FILE_SIGNIN_PARTS; k++) {
        const f = new URL(`./scenarios-file-signin${k === 1 ? "" : `-${k}`}.test.ts`, import.meta.url);
        const text = await Deno.readTextFile(f);
        if (!new RegExp(`fileSigninTests\\(${k}\\)`).test(text)) throw new Error(`${f.pathname} does not register part ${k}`);
      }
    });
  }
}
const STATUSES = new Set([200, 303, 400, 401, 403, 404, 405, 410, 429, 503]);
const CANON_CODE = renderPhoneLogin({ step: "code", botUrl: BOT_URL });

// ---------------------------------------------------------------- the people and their private data (synthetic)
const PHONES = { u: "+15125557319", u2: "+15125554826", u3: "+15125556093", v: "+14695558142" };
const PEOPLE = {
  u: { companies: ["Quillfeather", "Marrowbyte", "Zentrafy", "Oskarion"], titles: ["Pricing Strategist", "Growth Cartographer", "Ledger Whisperer", "Signal Tinkerer"], resume: "adaline-cv-2026.pdf", first: "Adaline", last: "Pemberforth" },
  v: { companies: ["Velloway", "Brintcorp"], titles: ["Harbor Planner", "Freight Oracle"], resume: "barnaby-resume.pdf", first: "Barnaby", last: "Quarrington" },
};
const privateOf = (p: typeof PEOPLE.u) => [...p.companies, ...p.titles, p.resume, p.first, p.last].map((s) => s.toLowerCase());
const PRIV = { u: privateOf(PEOPLE.u), v: privateOf(PEOPLE.v) };
const phoneLeak = (body: string, phone: string) => {
  const d = phone.replace(/[^0-9]/g, ""), d10 = d.slice(-10), last4 = d.slice(-4);
  return body.includes(phone) || body.includes(d10) || body.includes(d10.slice(3)) || new RegExp(`(?<![0-9A-Za-z])${last4}(?![0-9A-Za-z])`).test(body);
};

// Telegram's own signing of Mini App data (the documented algorithm; an independent implementation, as in file-page.test.ts).
async function signedInit(telegramId: string, authDate: number, token = BOT): Promise<string> {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Tg" }) });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), token), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}
const claimsOf = (tok: string): { u: string; j: string; e: number; k: string } | null => {
  try { const c = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return typeof c?.j === "string" ? c : null; } catch { return null; }
};
const FS1 = /fs1\.[0-9a-f]{64}/g;
const shaCache = new Map<string, string>();
const hashOf = async (id: string) => { let h = shaCache.get(id); if (!h) { h = await sha256(id); if (shaCache.size > 50_000) shaCache.clear(); shaCache.set(id, h); } return h; };
const TRACE = Deno.env.get("FSB_TRACE") === "1";

// ---------------------------------------------------------------- the battery's report
type Report = { scenarios: number; requests: number; statuses: Record<number, number>; byCategory: Record<string, number>; phoneSessions: number; tgSessions: number; approvals: number;
  texts: number; locked: number; faults: number; concurrent: number; liveness: Record<string, number>; violations: Map<string, string[]> };
const newReport = (): Report => ({ scenarios: 0, requests: 0, statuses: {}, byCategory: {}, phoneSessions: 0, tgSessions: 0, approvals: 0, texts: 0, locked: 0, faults: 0, concurrent: 0, liveness: {}, violations: new Map() });
function printReport(name: string, r: Report): number {
  const failed = [...r.violations.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[file-signin] ${name}: ${r.scenarios} scenarios (${Object.entries(r.byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}), ${r.requests} requests, ${failed} violations`,
    `  statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k}:${v}`).join(" ")}`,
    `  sessions: ${r.phoneSessions} by phone code, ${r.tgSessions} by Telegram; approvals ${r.approvals}; texts ${r.texts}; links locked ${r.locked}; injected faults hit ${r.faults}; concurrent groups ${r.concurrent}`,
    `  liveness checked: ${Object.entries(r.liveness).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  for (const [k, xs] of r.violations) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 4)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return failed;
}

// ---------------------------------------------------------------- one world: two accounts, their lists, the stores
type Who = "u" | "v";
interface Env {
  ids: Record<Who, string>; // account ids
  sessions: SessionStore; // the store under test (memory twin or the deployed store on Postgres)
  mem?: ReturnType<typeof memSessions>;
  deleteAccount(id: string): Promise<void>;
}
interface OSession { id: string | null; hash: string; user: Who; via: "phone" | "telegram"; phone: string | null; tg: string | null; created: number; holder: Actor; revoked: boolean; dead: boolean }
interface Link { token: string; who: Who; jti: string; e: number }
interface Page { t: string; rows: { ref: string; tag: string }[]; set: string | null }
interface ActorState { jar: Map<string, string>; page: Page | null; sets: Map<string, string[]>; tags: Map<string, string[]>; held: string[] }
interface Approval { user: Who; job: string; hash: string; current: boolean }
interface Ctx {
  actor: Actor; step: string; method: string; form: URLSearchParams | null; jti: string | null; linkWho: Who | null; presented: string[];
  faulted: string[]; provider: string[]; lookups: string[]; created: { idHash: string; userId: string; via: string; phone: string | null; telegramId: string | null }[];
  begins: string[]; finishes: { jti: string; ok: boolean }[]; texts: string[]; checks: string[]; approvals: Approval[]; dupAnswers: string[]; init?: string;
}

export async function runScenario(s: Scenario, env: Env, rep: Report): Promise<void> {
  const r = rng(1_000_003 * (s.id + 1));
  const violate = (ctx: Ctx | null, kind: string, msg: string) => {
    const list = rep.violations.get(kind) ?? [];
    list.push(`#${s.id} ${s.category} ${ctx ? `${ctx.step} by ${ctx.actor}` : ""}: ${msg}`.slice(0, 400));
    rep.violations.set(kind, list);
  };
  const W = {
    now: T0, smsOff: s.smsOff, fault: null as string | null,
    phone: { u: PHONES.u as string | null, v: PHONES.v as string | null } as Record<Who, string | null>,
    uPhones: [PHONES.u], exists: { u: true, v: true } as Record<Who, boolean>,
    tg: { "777": "u", "888": "v" } as Record<string, Who | undefined>,
    live: new Map<string, string>(), usedCodes: new Set<string>(), staleCodes: [] as string[], textsTo: [] as string[],
  };
  const whoOf = (id: string): Who | null => (id === env.ids.u ? "u" : id === env.ids.v ? "v" : null);
  // the lists: U has 4 postings, V has 2; each prepared with its own payload hash
  let hashN = 0;
  const newHash = () => { hashN++; return [...Array(64)].map((_, i) => "0123456789abcdef"[(hashN * 7 + i * 13 + s.id) % 16]).join(""); };
  const slug = (c: string) => c.toLowerCase();
  const jobsOf: Record<Who, JobView[]> = { u: [], v: [] };
  const refs: Record<Who, string[]> = { u: [], v: [] };
  const refOfJob = new Map<string, string>();
  const preps = new Map<string, PreparedRow | null>(); // `${who}|${job_id}`
  const queued = new Map<string, number>(); // `${who}|${job_id}` -> times queued
  const apps = new Map<string, AppRow>();
  const postingRow = (who: Who, i: number) => ({ job_id: `greenhouse:${slug(PEOPLE[who].companies[i])}:${i + 1}`, provider: "greenhouse", company_domain: `${slug(PEOPLE[who].companies[i])}.com`,
    description: "<p>Build dashboards and own the weekly pricing report for the growth team.</p><p>Requirements</p><ul><li>3 years of SQL</li></ul>" });
  const pid = (who: Who, i: number) => `33333333-3333-4333-8333-${who === "u" ? "1" : "2"}${String(i + 1).padStart(11, "0")}`;
  const prepOf = (who: Who, i: number): PreparedRow => ({ id: pid(who, i), job_id: postingRow(who, i).job_id, company: PEOPLE[who].companies[i], url: `https://boards.greenhouse.io/${slug(PEOPLE[who].companies[i])}/jobs/${i + 1}`,
    payload_hash: newHash(), state: "ready", card_lines: [], payload: { resume_sha256: "f".repeat(64), resume_name: PEOPLE[who].resume,
      fields: [{ name: "first_name", label: "First name", value: PEOPLE[who].first }, { name: "last_name", label: "Last name", value: PEOPLE[who].last }] } });
  for (const who of ["u", "v"] as Who[]) {
    for (let i = 0; i < PEOPLE[who].companies.length; i++) {
      const c = PEOPLE[who].companies[i];
      const v = jobViewOf({ job_id: postingRow(who, i).job_id, company: c, title: PEOPLE[who].titles[i], location: "Austin, TX", url: `https://boards.greenhouse.io/${slug(c)}/jobs/${i + 1}`, pay: "$90k" }, postingRow(who, i));
      jobsOf[who].push(v);
      const ref = await refOf(env.ids[who], v.job_id);
      refs[who].push(ref); refOfJob.set(`${who}|${v.job_id}`, ref);
      preps.set(`${who}|${v.job_id}`, prepOf(who, i));
    }
  }
  const prepById = (who: Who, id: string) => [...preps.entries()].find(([k, p]) => k.startsWith(`${who}|`) && p?.id === id)?.[1] ?? null;
  const kv = new Map<string, unknown>();
  for (const who of ["u", "v"] as Who[]) {
    jobsOf[who].forEach((v, i) => kv.set(`${env.ids[who]}|job|${refs[who][i]}`, { job: v, shownAs: "text" }));
    kv.set(`${env.ids[who]}|list|${who === "u" ? LIST_U : LIST_V}`, refs[who]);
  }
  const baseStore: FileStore = {
    async remember() {}, async rememberList() {},
    async recall(u, ref) { return (kv.get(`${u}|job|${ref}`) as { job: JobView; shownAs: "text" }) ?? null; },
    async recallList(u, id) { return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async postings(ids) { return ids.map((id) => { for (const who of ["u", "v"] as Who[]) { const i = jobsOf[who].findIndex((j) => j.job_id === id); if (i >= 0) return postingRow(who, i); } return null; }).filter(Boolean) as never; },
    async save() { return "saved"; },
    async prepared(u, jobId) { const w = whoOf(u); return w ? preps.get(`${w}|${jobId}`) ?? null : null; },
    async applied(u, jobId) { const w = whoOf(u); return !!w && apps.has(`${w}|${jobId}`); },
    async want() { return { result: "queued" }; },
    async appRow(u, jobId) { const w = whoOf(u); return w ? apps.get(`${w}|${jobId}`) ?? null : null; },
    async wanted() { return false; },
  };
  // the approval path's store: one card per Confirm; answering approves each item once (a second answer for a posting already
  // queued is "duplicate", as the database's card answer is)
  const cards = new Map<string, { id: string; user_id: string; items: { n: number; prepared_id: string; payload_hash: string }[]; state: string }>();
  let cardN = 0;
  const answer = (ctx: Ctx, u: string, cardId: string, approve: number[]) => {
    const card = cards.get(cardId), w = whoOf(u);
    if (!card || card.user_id !== u || !w) throw new Error("card_stale");
    if (card.state !== "open") throw new Error("card_answered");
    card.state = "answered";
    return card.items.filter((i) => approve.includes(i.n)).map((i) => {
      const p = prepById(w, i.prepared_id)!;
      const key = `${w}|${p?.job_id}`;
      if (apps.has(key)) { ctx.dupAnswers.push(key); return { n: i.n, company: p.company, result: "duplicate" }; }
      queued.set(key, (queued.get(key) ?? 0) + 1);
      apps.set(key, { id: `a-${key}`, state: "queued", reason: null, confirmation_id: null, created_at: new Date(W.now).toISOString(), updated_at: new Date(W.now).toISOString(), email_confirmed_at: null, payload: {}, company: p.company, url: p.url });
      ctx.approvals.push({ user: w, job: p.job_id, hash: i.payload_hash, current: preps.get(key)?.payload_hash === i.payload_hash });
      return { n: i.n, company: p.company, result: "queued" };
    });
  };

  // ---- per-request dependencies: the shared stores, each call recorded against this request, and the one injected fault
  function depsFor(ctx: Ctx): FileDeps {
    const fail = (name: string) => { if (W.fault === name) { W.fault = null; ctx.faulted.push(name); rep.faults++; throw new Error(`injected: ${name}`); } };
    const base = env.sessions;
    const sessions: SessionStore = {
      async createSession(x) { fail("sessions.createSession"); ctx.created.push({ idHash: x.idHash, userId: x.userId, via: x.via, phone: x.phone, telegramId: x.telegramId }); return await base.createSession(x); },
      async session(h) { fail("sessions.session"); ctx.lookups.push(h); return await base.session(h); },
      async setList(h, l) { fail("sessions.setList"); return await base.setList(h, l); },
      async revoke(h, at) { fail("sessions.revoke"); return await base.revoke(h, at); },
      async revokeAll(u, at) { fail("sessions.revokeAll"); return await base.revokeAll(u, at); },
      async beginLogin(l) { fail("sessions.beginLogin"); ctx.begins.push(l.jti); return await base.beginLogin(l); },
      async login(j) { fail("sessions.login"); return await base.login(j); },
      async setPhone(j, p, m) { fail("sessions.setPhone"); return await base.setPhone(j, p, m); },
      async countSend(j, m) { fail("sessions.countSend"); return await base.countSend(j, m); },
      async countTry(j, m) { fail("sessions.countTry"); return await base.countTry(j, m); },
      async finishLogin(j, at) { fail("sessions.finishLogin"); const ok = await base.finishLogin(j, at); ctx.finishes.push({ jti: j, ok }); return ok; },
    };
    const store: FileStore = { ...baseStore,
      async recallList(u, id) { fail("store.recallList"); return await baseStore.recallList(u, id); },
      async recall(u, ref) { fail("store.recall"); return await baseStore.recall(u, ref); },
      async prepared(u, j) { fail("store.prepared"); return await baseStore.prepared(u, j); },
      async appRow(u, j) { fail("store.appRow"); return await baseStore.appRow(u, j); },
      async applied(u, j) { fail("store.applied"); return await baseStore.applied(u, j); },
    };
    const tap: TapStore = {
      async card(u, id) { fail("tap.card"); const c = cards.get(id); return c && c.user_id === u ? { ...c, items: c.items.map((i) => ({ ...i })) } as never : null; },
      async prepared(u, ids) { const w = whoOf(u); return w ? ids.map((id) => prepById(w, id)).filter(Boolean).map((p) => ({ id: p!.id, payload_hash: p!.payload_hash, company: p!.company })) : []; },
      async answer(u, id, approve) { fail("tap.answer"); return answer(ctx, u, id, approve) as never; },
    };
    return {
      store, tap, now: () => W.now,
      env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file`, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] },
      cards: { async open(u, ids) {
        fail("cards.open");
        const w = whoOf(u)!;
        const id = `44444444-4444-4444-8444-${String(++cardN).padStart(12, "0")}`;
        const items = ids.map((p, i) => ({ n: i + 1, prepared_id: p, payload_hash: prepById(w, p)?.payload_hash ?? "" }));
        cards.set(id, { id, user_id: u, items, state: "open" });
        return { id, items, shown_at: new Date(W.now).toISOString() };
      } },
      sessions,
      phone: {
        async ready() { return !W.smsOff; },
        async accountPhone(u) { fail("phone.accountPhone"); const w = whoOf(u); return w && W.exists[w] ? W.phone[w] : null; },
        async send(phone) {
          if (W.fault === "phone.send_refused" || W.fault === "phone.send") { ctx.provider.push(W.fault); W.fault = null; rep.faults++; if (ctx.provider.at(-1) === "phone.send") throw new Error("provider down"); return { ok: false, why: "refused" }; }
          if (W.smsOff) return { ok: false, why: "not_configured" };
          let code = "";
          do { code = String(100000 + Math.floor(r() * 900000)); } while (W.usedCodes.has(code));
          W.usedCodes.add(code);
          const old = W.live.get(phone); if (old) W.staleCodes.push(old);
          W.live.set(phone, code); ctx.texts.push(phone); W.textsTo.push(phone);
          return { ok: true };
        },
        async check(phone, code) {
          fail("phone.check");
          ctx.checks.push(phone);
          if (W.live.get(phone) !== code) return null;
          W.live.delete(phone); W.staleCodes.push(code);
          const w = (["u", "v"] as Who[]).find((x) => W.exists[x] && W.phone[x] === phone);
          return w ? env.ids[w] : null;
        },
      },
      userOfTelegram: async (tg) => { fail("tg.lookup"); const w = W.tg[tg]; return w && W.exists[w] ? env.ids[w] : null; },
    };
  }

  // ---- the oracle
  const links: Link[] = [], forwarded: Link[] = [];
  const perJti = new Map<string, { texts: number; checks: number; wrong: number; sessions: number; firstBegin: number | null; used: boolean; phone: string | null | "unknown" }>();
  const J = (j: string) => { if (!perJti.has(j)) perJti.set(j, { texts: 0, checks: 0, wrong: 0, sessions: 0, firstBegin: null, used: false, phone: null }); return perJti.get(j)!; };
  const sessions: OSession[] = [];
  const byHash = new Map<string, OSession>();
  const actors: Record<Actor, ActorState> = Object.fromEntries((["owner", "stranger", "other", "crawler", "mini"] as Actor[]).map((a) => [a, { jar: new Map(), page: null, sets: new Map(), tags: new Map(), held: [] }])) as never;
  const bound = (x: OSession) => W.exists[x.user] && (x.via === "phone" ? !!x.phone && W.phone[x.user] === x.phone : !!x.tg && W.tg[x.tg] === x.user);
  const valid = (x: OSession | undefined) => !!x && !x.revoked && !x.dead && W.now < x.created + SESSION_TTL_MS && bound(x);
  const permanentlyEnded = (x: OSession) => x.revoked || x.dead || W.now >= x.created + SESSION_TTL_MS || !W.exists[x.user];
  const holderWho: Partial<Record<Actor, Who>> = { owner: "u", other: "v" };
  // Which session a post acts as (file_session.ts, the page-token round): a phone session only through its own cookie AND the
  // page token drawn for it; a Mini App session through its id in the form AND Telegram's fresh initData for its own Telegram user
  // (the oracle knows which initData it minted, for whom). Anything else acts as no session at all.
  const inits = new Map<string, string>(); // initData minted fresh by the oracle -> its Telegram user
  const freshInit = async (tg: string) => { const x = await signedInit(tg, Math.floor(W.now / 1000) - 10); inits.set(x, tg); return x; };
  const authOf = async (ck: string, form: URLSearchParams | null, method: string): Promise<OSession | undefined> => {
    if (method !== "POST" || !form) return undefined;
    const ft = form.get("t") ?? "";
    if (PAGE_TOKEN.test(ft)) {
      const x = /^fs1\./.test(ck) ? byHash.get(await hashOf(ck)) : undefined;
      return x && x.via === "phone" && ft === await pageTokenOf(x.hash, SECRET) ? x : undefined;
    }
    if (/^fs1\./.test(ft)) {
      const x = byHash.get(await hashOf(ft)), tg = inits.get(form.get("init") ?? "");
      return x && x.via === "telegram" && !!tg && tg === x.tg ? x : undefined;
    }
    return undefined;
  };

  async function request(actor: Actor, step: string, o: { method?: string; query?: string; form?: Record<string, string>; cookie?: string; ua?: string; init?: string }): Promise<{ status: number; body: string; ctx: Ctx; res: Response | null }> {
    const st = actors[actor];
    const cookie = o.cookie ?? [...st.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const method = o.method ?? (o.form ? "POST" : "GET");
    const form = o.form ? new URLSearchParams(o.form) : null;
    const cookieOf = (n: string) => cookie.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${n}=`))?.slice(n.length + 1) ?? "";
    const qT = o.query ? new URLSearchParams(o.query).get("t") ?? "" : "";
    const linkTok = qT || cookieOf("tf_l");
    const lc = linkTok ? claimsOf(linkTok) : null;
    // The Mini App's script adds Telegram's initData (its own Telegram user's) to every post it makes.
    if (actor === "mini" && form?.get("t") && !form.has("init")) form.set("init", await freshInit(sessions.find((x) => x.id === form.get("t"))?.tg ?? "777"));
    const presented = [cookieOf("tf_s"), form?.get("t") ?? ""].filter((x) => /^fs1\./.test(x));
    const ctx: Ctx = { actor, step, method, form, jti: lc?.j ?? null, linkWho: lc ? whoOf(lc.u) : null, presented, faulted: [], provider: [], lookups: [], created: [], begins: [], finishes: [], texts: [], checks: [], approvals: [], dupAnswers: [], init: o.init };
    // what the oracle knows before the request
    const ck = cookieOf("tf_s"), validT = await authOf(ck, form, method);
    const cookieS = method === "GET" && /^fs1\./.test(ck) ? byHash.get(await hashOf(ck)) : undefined;
    const entitled = new Set<Who>([validT, cookieS?.via === "phone" ? cookieS : undefined].filter((x) => valid(x) && x!.holder === actor).map((x) => x!.user));
    const validTAtStart = valid(validT); // a request racing a sign-out may still pass the check it made first
    const liveBefore = { u: W.phone.u ? W.live.get(W.phone.u) ?? null : null, v: W.phone.v ? W.live.get(W.phone.v) ?? null : null };
    const tgBefore = { ...W.tg };
    const jBefore = ctx.jti ? { ...J(ctx.jti) } : null;
    const queuedBefore = new Set([...apps.keys()]);
    const url = `${HOST}/file${o.query ? `?${o.query}` : ""}`;
    let res: Response | null = null, body = "";
    try {
      res = await handleFile(new Request(url, { method, headers: { cookie, "user-agent": o.ua ?? "Mozilla/5.0", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? form.toString() : undefined }), depsFor(ctx));
      body = await res.text();
    } catch (e) {
      violate(ctx, "the handler threw (no page, no status)", `${String((e as Error)?.message ?? e).slice(0, 120)} [faults: ${ctx.faulted.join(",")}]`);
    }
    rep.requests++;
    const status = res?.status ?? 0;
    rep.statuses[status] = (rep.statuses[status] ?? 0) + 1;
    if (!res) return { status, body, ctx, res };
    const setCookies = res.headers.getSetCookie();
    const location = res.headers.get("location") ?? "";

    // -- sessions this response started: who for, to whom, and was it earned
    const idsInResponse = [...new Set([...(body.match(FS1) ?? []), ...setCookies.flatMap((c) => c.match(FS1) ?? [])])];
    const created: string[] = [];
    if (TRACE) console.log(`  ${step} ${actor} ${method} ${o.query ?? ""} ${form ? form.toString().slice(0, 80) : ""} -> ${status} ${/<h1>([^<]*)/.exec(body)?.[1] ?? ""} ${location} ${setCookies.map((c) => c.split(";")[0].slice(0, 12)).join(",")} faults=${ctx.faulted}`);
    for (const c of ctx.created) {
      const cw = whoOf(c.userId);
      let id: string | null = null;
      for (const x of idsInResponse) if (!presented.includes(x) && await hashOf(x) === c.idHash) id = x;
      if (id) created.push(id);
      let legit = false;
      if (c.via === "phone") {
        const code = (form?.get("code") ?? "").replace(/[\s-]/g, "");
        legit = !!cw && holderWho[actor] === cw && ctx.linkWho === cw && !!liveBefore[cw] && code === liveBefore[cw];
        if (!ctx.jti) violate(ctx, "a phone session without a link", c.userId);
        else {
          const jj = J(ctx.jti);
          jj.sessions++;
          if (jj.sessions > 1) violate(ctx, "a link started a second session", ctx.jti);
          if (jBefore && jBefore.wrong >= MAX_CODE_TRIES) violate(ctx, "a locked link started a session", ctx.jti);
          const link = links.concat(forwarded).find((l) => l.jti === ctx.jti);
          if (link && W.now >= link.e) violate(ctx, "an expired link started a session", ctx.jti);
          if (jBefore?.firstBegin != null && W.now >= jBefore.firstBegin + LOGIN_TTL_MS) violate(ctx, "a sign-in past 15 minutes started a session", ctx.jti);
        }
        if (cw && c.phone !== W.phone[cw]) violate(ctx, "a phone session bound to a number that is not the account's", `${c.phone}`);
        rep.phoneSessions++;
      } else {
        const tg = c.telegramId ?? "";
        legit = actor === "mini" && (ctx.init === "u" || ctx.init === "v") && tg === (ctx.init === "u" ? "777" : "888") && !!cw && tgBefore[tg] === cw && W.exists[cw];
        rep.tgSessions++;
      }
      if (!legit) violate(ctx, "a session was started for someone who did not prove the account", `via ${c.via} for ${cw} to ${actor} (code ${form?.get("code")}, init ${ctx.init})`);
      const x: OSession = { id, hash: c.idHash, user: cw ?? "u", via: c.via as "phone" | "telegram", phone: c.phone, tg: c.telegramId, created: W.now, holder: actor, revoked: false, dead: false };
      sessions.push(x); byHash.set(c.idHash, x);
      if (id) st.held.push(id);
      if (legit && cw) entitled.add(cw);
    }

    // -- nothing private to anyone not entitled; nothing private on an error page; no phone ever
    const lower = body.toLowerCase() + "\n" + location.toLowerCase();
    for (const who of ["u", "v"] as Who[]) {
      const ok = entitled.has(who) && status < 400;
      if (!ok) { const leak = PRIV[who].find((p) => lower.includes(p)); if (leak) violate(ctx, status >= 400 ? "private data on an error page" : "private data to someone without that account's session", `${who}'s "${leak}" (status ${status})`); }
    }
    for (const p of [...W.uPhones, PHONES.v]) if (phoneLeak(body + location, p)) violate(ctx, "a phone number (or its last 4) in a response", `${p} (status ${status})`);
    for (const x of idsInResponse) if (!presented.includes(x) && !created.includes(x)) violate(ctx, "another session id in a response", x.slice(0, 12));
    // -- session ids never in a URL; cookies HttpOnly, Secure, SameSite=Lax
    if (/fs1\./.test(location) || /(href|action|src)="[^"]*fs1\./.test(body) || /[?&]t=fs1/.test(body)) violate(ctx, "a session id in a URL", location || "body");
    if (location && !location.startsWith("/")) violate(ctx, "a redirect off this site", location);
    for (const c of setCookies) if (!/;\s*HttpOnly/i.test(c) || !/;\s*Secure/i.test(c) || !/;\s*SameSite=Lax/i.test(c)) violate(ctx, "a cookie without HttpOnly; Secure; SameSite=Lax", c.split(";")[0].slice(0, 20));
    if (!STATUSES.has(status)) violate(ctx, "a status outside 200/303/400/401/403/404/405/410/429/503", String(status));

    // -- texts: to the confirmed phone of the link's account only; at most 3 per link
    for (const p of ctx.texts) {
      rep.texts++;
      if (!ctx.linkWho || !W.exists[ctx.linkWho] || W.phone[ctx.linkWho] !== p) violate(ctx, "a text to a number that is not the link's account's confirmed phone", p);
      if (ctx.jti && ++J(ctx.jti).texts > MAX_CODE_SENDS) violate(ctx, "more than 3 texts for one link", ctx.jti);
    }
    // -- code tries: at most 5 per link; a locked link checks no more codes
    if (ctx.jti && ctx.checks.length) {
      const jj = J(ctx.jti);
      jj.checks += ctx.checks.length;
      if (jj.checks > MAX_CODE_TRIES) violate(ctx, "more than 5 codes checked for one link", ctx.jti);
      if (jBefore && jBefore.wrong >= MAX_CODE_TRIES) violate(ctx, "a locked link checked a code", ctx.jti);
    }
    if (ctx.jti && form?.get("action") === "phone_verify" && status === 401) {
      const jj = J(ctx.jti);
      if (++jj.wrong > MAX_CODE_TRIES) violate(ctx, "more than 5 wrong codes answered for one link", ctx.jti);
      if (jj.wrong === MAX_CODE_TRIES) rep.locked++;
    }
    for (const j of ctx.begins) { const jj = J(j); jj.firstBegin ??= W.now; }
    for (const f of ctx.finishes) if (f.ok) J(f.jti).used = true;

    // -- approvals: only from a valid session of that account, with the exact current tag or the exact set shown; once
    for (const a of ctx.approvals) {
      rep.approvals++;
      const ref = refOfJob.get(`${a.user}|${a.job}`)!;
      const why: string[] = [];
      if (method !== "POST" || !validT || !validTAtStart || validT.user !== a.user || validT.holder !== actor) why.push("no valid session of that account in the request");
      if (!a.current) why.push("not the current payload");
      const act = form?.get("action");
      if (act === "apply") { if (form?.get("ref") !== ref || form?.get("tag") !== hashTag(a.hash)) why.push(`not the posted row/tag (${form?.get("tag")} vs ${hashTag(a.hash)})`); }
      else if (act === "applyall") { const shown = st.sets.get(form?.get("set") ?? ""); if (!shown || !shown.includes(`${ref}:${hashTag(a.hash)}`)) why.push("not in the set that was shown"); }
      else why.push(`approved by action ${act}`);
      if ((queued.get(`${a.user}|${a.job}`) ?? 0) > 1) why.push("approved twice");
      if (why.length) violate(ctx, "an approval that should not have happened", `${a.user} ${a.job}: ${why.join("; ")}`);
    }
    if (!ctx.faulted.length && step !== "par") for (const k of ctx.dupAnswers) if (queuedBefore.has(k)) violate(ctx, "an already-queued posting was approved again at the store", k);

    // -- a session checked while its account no longer binds it is ended for good (unless the check itself could not run)
    if (!ctx.faulted.some((f) => /sessions\.(session|revoke)|phone\.accountPhone|tg\.lookup/.test(f))) {
      for (const h of ctx.lookups) { const x = byHash.get(h); if (x && !x.revoked && W.now < x.created + SESSION_TTL_MS && !bound(x)) x.dead = true; }
    }
    // -- sign out: a 200 means that session (or every session of the account) is over
    if (status === 200 && /Signed out/.test(body) && validT) {
      if (form?.get("action") === "signout") validT.revoked = true;
      else for (const x of sessions) if (x.user === validT.user && x.created <= W.now) x.revoked = true;
    }

    // -- the cookie jar (what a browser keeps)
    for (const c of setCookies) { const [kvp, ...attrs] = c.split(";"); const [k, ...v] = kvp.split("="); if (attrs.some((a) => /Max-Age=0/i.test(a))) st.jar.delete(k.trim()); else st.jar.set(k.trim(), v.join("=")); }
    // -- a list page: what it shows (the set is the hash of exactly the rows it shows with their tags)
    if (status === 200 && /<ul class="rows">/.test(body)) {
      const rows = [...body.matchAll(/name="ref" value="([^"]+)"><input type="hidden" name="tag" value="([^"]+)">/g)].map((m) => ({ ref: m[1], tag: m[2] }));
      const t = /name="t" value="([^"]+)"/.exec(body)?.[1] ?? "";
      const set = /name="set" value="([^"]+)"/.exec(body)?.[1] ?? null;
      const approvable = rows.filter((x) => /^[0-9a-f]{16}$/.test(x.tag));
      const expect = approvable.length ? (await sha256(`v1|${approvable.map((x) => `${x.ref}:${x.tag}`).join(",")}`)).slice(0, 16) : null;
      if (set && set !== expect) violate(ctx, "Apply to all carries a set hash that is not the rows shown", `${set} vs ${expect}`);
      if (set) st.sets.set(set, approvable.map((x) => `${x.ref}:${x.tag}`));
      for (const x of rows) st.tags.set(x.ref, [...(st.tags.get(x.ref) ?? []), x.tag]);
      st.page = { t, rows, set };
    }
    return { status, body, ctx, res };
  }

  // ---- the store holds only hashes (memory twin; the Postgres run reads the table itself)
  const checkStore = () => {
    if (!env.mem) return;
    for (const [k, row] of env.mem.sessions) {
      if (!/^[0-9a-f]{64}$/.test(k) || /fs1\./.test(JSON.stringify(row))) violate(null, "the session store holds something other than a hash", k.slice(0, 12));
    }
    for (const x of sessions) if (x.id && env.mem.sessions.has(x.id)) violate(null, "the session store holds a session id itself", x.id.slice(0, 12));
    for (const row of env.mem.logins.values()) if (row.tries > MAX_CODE_TRIES || row.sends > MAX_CODE_SENDS) violate(null, "a sign-in counted past its cap", `${row.tries} tries, ${row.sends} sends`);
  };

  // ---- inputs
  const linksOf = (a: Actor): Link[] => a === "owner" ? links.filter((l) => l.who === "u") : a === "other" ? links.filter((l) => l.who === "v") : a === "stranger" ? forwarded : links;
  const digits = (p: string) => p.replace(/[^0-9]/g, "").slice(-10);
  const typed = (a: Actor, p: PhoneInput): string => {
    const fmt = (phone: string | null, f: number) => phone ? PHONE_FORMATS[f % PHONE_FORMATS.length](digits(phone)) : "0";
    if (p.k === "own") return fmt(a === "other" ? W.phone.v : W.phone.u, p.fmt);
    if (p.k === "account_u") return fmt(W.phone.u, p.fmt);
    if (p.k === "account_v") return fmt(W.phone.v, p.fmt);
    if (p.k === "old_u") return W.uPhones.length > 1 ? W.uPhones[W.uPhones.length - 2] : "+17375550000";
    if (p.k === "random") return `+1737${String(p.n).padStart(7, "0")}`;
    return p.s;
  };
  const codeFor = (a: Actor, c: CodeInput): string => {
    const live = (who: Who) => (W.phone[who] ? W.live.get(W.phone[who]!) : undefined) ?? "";
    const mine: Who = a === "other" ? "v" : "u";
    if (c.k === "live") return a === "owner" || a === "other" ? live(mine) : "";
    if (c.k === "live_spaced") { const x = a === "owner" || a === "other" ? live(mine) : ""; return x ? ` ${x.slice(0, 3)} ${x.slice(3)} ` : ""; }
    if (c.k === "other_live") return live("v");
    if (c.k === "stale") return W.staleCodes.length ? W.staleCodes[Math.floor(r() * W.staleCodes.length)] : "100000";
    if (c.k === "random") { let x = String(c.n).padStart(6, "0"); while ([...W.live.values()].includes(x)) x = String((Number(x) + 1) % 1e6).padStart(6, "0"); return x; }
    return c.s;
  };
  const randomFs1 = () => `fs1.${[...Array(64)].map(() => "0123456789abcdef"[Math.floor(r() * 16)]).join("")}`;
  const graveyard = () => { const g = sessions.filter((x) => x.id && x.user === "u" && permanentlyEnded(x)); return g.length ? g[Math.floor(r() * g.length)].id! : randomFs1(); };
  const tOf = (a: Actor, t: TPick): string | null => {
    const st = actors[a];
    if (t === "own") return st.page?.t || st.held.at(-1) || null;
    if (t === "none") return null;
    if (t === "garbage") return r() < 0.5 ? randomFs1() : "not-a-session";
    if (t === "stolen") return graveyard();
    return st.held[0] ?? randomFs1(); // foreign: the oldest id this actor ever held (often ended), or none it ever had
  };

  // ---- the steps
  const liveness = (k: string) => { rep.liveness[k] = (rep.liveness[k] ?? 0) + 1; };
  async function run(step: Step, label: string): Promise<void> {
    const name = `${label}:${step.k}`;
    const solo = !label.includes("."); // liveness is checked only for a request that is not racing another
    switch (step.k) {
      case "link": {
        const who: Who = step.to === "owner" ? "u" : "v";
        if (!W.exists[who]) return;
        const token = (await mintFileToken({ secret: SECRET, userId: env.ids[who], list: who === "u" ? LIST_U : LIST_V, now: W.now - step.age, kind: "l" }))!;
        const l: Link = { token, who, jti: claimsOf(token)!.j, e: W.now - step.age + 24 * 3600_000 };
        links.push(l);
        if (step.forward && who === "u") forwarded.push(l);
        return;
      }
      case "open": {
        const a = step.actor, pool = linksOf(a);
        let tok = "", link: Link | undefined;
        const pickIdx = (xs: Link[]) => xs[Math.min(xs.length - 1, Math.floor(step.r * xs.length))];
        if (step.pick === "latest") link = pool.at(-1);
        else if (step.pick === "random") link = pool.length ? pickIdx(pool) : undefined;
        else if (step.pick === "oldest") link = pool[0];
        else if (step.pick === "other_user") { const o = links.filter((l) => l.who !== (a === "other" ? "v" : "u")); link = o.length ? pickIdx(o) : undefined; }
        if (link) tok = link.token;
        else if (step.pick === "forged") { const l = pool.at(-1) ?? links.at(-1); tok = l ? l.token.slice(0, -2) + (l.token.endsWith("AA") ? "BB" : "AA") : "v1.forged.sig"; }
        else if (step.pick === "truncated") tok = (pool.at(-1)?.token ?? "v1.x.y").slice(0, -6);
        else if (step.pick === "session_id") tok = actors[a].held.at(-1) ?? randomFs1();
        else if (step.pick === "kind_s") tok = (await mintFileToken({ secret: SECRET, userId: env.ids.u, list: LIST_U, now: W.now, kind: "s" }))!;
        else tok = r() < 0.5 ? "v1.abc.def" : "%00<script>";
        if (!tok) tok = "v1.abc.def";
        const crawler = a === "crawler";
        const fresh = link && J(link.jti).firstBegin === null && !J(link.jti).used;
        const ownValid = sessions.some((x) => x.holder === a && x.user === "u" && valid(x) && actors[a].jar.get("tf_s") === x.id);
        const first = await request(a, name, { query: `t=${encodeURIComponent(tok)}`, ua: crawler ? "TelegramBot (like TwitterBot)" : undefined });
        const clean = !first.ctx.faulted.length;
        if (clean && !link && first.status !== 403 && first.status !== 410) violate(first.ctx, "a bad link opened something", `${step.pick} -> ${first.status}`);
        if (clean && link && W.now >= link.e && first.status !== 410) violate(first.ctx, "an expired link was not 410", String(first.status));
        if (crawler && link && W.now < link.e) {
          if (first.status !== 200 || first.res?.headers.getSetCookie().length || first.ctx.begins.length) violate(first.ctx, "a link preview touched the link or set a cookie", `${first.status}`);
          return;
        }
        if (first.status !== 303 || crawler) return;
        const follow = await request(a, `${name}>follow`, {});
        const fclean = clean && !follow.ctx.faulted.length;
        // liveness: the owner who opens a fresh link of its own (no valid session here) reaches the phone step
        if (solo && fclean && a === "owner" && link?.who === "u" && fresh && W.now < link.e && W.exists.u && !ownValid) {
          liveness("fresh link -> phone step");
          if (follow.status !== 200 || !/name="phone"|name="code"/.test(follow.body)) violate(follow.ctx, "the owner's fresh link did not reach the phone step", `${follow.status} ${/<h1>([^<]*)/.exec(follow.body)?.[1]}`);
        }
        if (solo && fclean && a === "owner" && link?.who === "u" && ownValid && W.now < link.e) {
          liveness("link while signed in -> list");
          if (follow.status !== 200 || !/<ul class="rows">/.test(follow.body)) violate(follow.ctx, "the signed-in owner's link did not open the list", String(follow.status));
        }
        return;
      }
      case "get": {
        const a = step.actor, st = actors[a];
        if (step.mode === "none") {
          const x = await request(a, name, { cookie: "" });
          if (!x.ctx.faulted.length && x.status !== 403) violate(x.ctx, "no cookies, but not 403", String(x.status));
          return;
        }
        if (step.mode === "bootstrap") { await request(a, name, { query: `list=${LIST_U}` }); return; }
        if (step.mode === "stolen") { await request(a, name, { cookie: `tf_s=${graveyard()}` }); return; }
        if (step.mode === "foreign_cookie") { await request(a, name, { cookie: [`tf_s=${randomFs1()}`, st.jar.has("tf_l") ? `tf_l=${st.jar.get("tf_l")}` : ""].filter(Boolean).join("; ") }); return; }
        const cur = sessions.find((x) => x.id && x.id === st.jar.get("tf_s"));
        const x = await request(a, name, { query: step.mode === "text" ? "format=text" : undefined });
        if (x.ctx.faulted.length) return;
        if (solo && cur && valid(cur) && cur.holder === a && step.mode === "cookies") {
          liveness("signed-in read -> list");
          if (x.status !== 200 || !/<ul class="rows">/.test(x.body)) violate(x.ctx, "a valid session did not open its list", String(x.status));
        }
        if (solo && cur && !valid(cur) && !st.jar.has("tf_l") && x.status !== 401 && x.status !== 403) violate(x.ctx, "an ended session was not 401/403", String(x.status));
        return;
      }
      case "start": {
        const a = step.actor, ph = typed(a, step.phone);
        const jti = claimsOf(actors[a].jar.get("tf_l") ?? "")?.j ?? null;
        const x = await request(a, name, { form: { action: "phone_start", phone: ph } });
        const n = normalizePhone(ph);
        if (jti && x.status !== 0) {
          // what the sign-in now holds (for the liveness check of the code step)
          if (x.ctx.faulted.length) J(jti).phone = "unknown";
          else if (n && (x.status === 200 || x.status === 503)) J(jti).phone = n;
        }
        if (n && !x.ctx.faulted.length && x.status !== 0) {
          // the same answer for every number: the account's own, someone else's, a random one
          if (x.status === 200 && x.body !== CANON_CODE) violate(x.ctx, "a typed number got a different answer than any other number (a note only the account's number gets)", `${step.phone.k}: ${/role="alert">([^<]*)/.exec(x.body)?.[1] ?? "(other page)"}`);
          if (x.status === 503 && !W.smsOff) violate(x.ctx, "a typed number got a different answer than any other number (an error only the account's number gets)", `${step.phone.k}: 503 ${/<h1>([^<]*)/.exec(x.body)?.[1]} / ${/role="alert">([^<]*)/.exec(x.body)?.[1] ?? ""}`);
          if (x.status === 200 && W.smsOff) violate(x.ctx, "a typed number got a different answer than any other number (texting off: 503 for the account's number only)", `${step.phone.k}: 200 while the account's own number gets 503`);
        }
        return;
      }
      case "verify": {
        const a = step.actor, code = codeFor(a, step.code);
        const jti = claimsOf(actors[a].jar.get("tf_l") ?? "")?.j ?? null;
        const link = jti ? links.find((l) => l.jti === jti) : undefined;
        const jj = jti ? { ...J(jti) } : null;
        const liveU = W.phone.u ? W.live.get(W.phone.u) : undefined;
        const x = await request(a, name, { form: { action: "phone_verify", code } });
        if (!jj || x.ctx.faulted.length) return;
        if (jj.wrong >= MAX_CODE_TRIES && ![429, 410, 403].includes(x.status)) violate(x.ctx, "a locked link was not 429/410", String(x.status));
        // liveness: the owner, on its own open sign-in with its own number recorded, typing the live code, is signed in
        if (solo && a === "owner" && link?.who === "u" && (step.code.k === "live" || step.code.k === "live_spaced") && liveU && W.exists.u && !W.smsOff && !jj.used && jj.wrong < MAX_CODE_TRIES
          && jj.phone === W.phone.u && W.now < link.e && jj.firstBegin !== null && W.now < jj.firstBegin + LOGIN_TTL_MS) {
          liveness("live code -> session");
          if (x.status !== 303 || !x.res?.headers.getSetCookie().some((c) => /^tf_s=fs1\./.test(c))) violate(x.ctx, "the owner's live code did not sign in", `${x.status} ${/role="alert">([^<]*)/.exec(x.body)?.[1] ?? /<h1>([^<]*)/.exec(x.body)?.[1]}`);
        }
        return;
      }
      case "reset": {
        const jti = claimsOf(actors[step.actor].jar.get("tf_l") ?? "")?.j ?? null;
        const x = await request(step.actor, name, { form: { action: "phone_reset" } });
        if (jti) J(jti).phone = x.ctx.faulted.length ? "unknown" : x.status === 200 ? null : J(jti).phone;
        return;
      }
      case "apply": {
        const a = step.actor, st = actors[a], t = tOf(a, step.t);
        const rows = st.page?.rows ?? [];
        const pick = <T>(xs: T[]) => xs[Math.min(xs.length - 1, Math.floor(step.r * xs.length))];
        const seen = rows.length ? pick(rows) : null;
        const ref = step.ref === "seen" ? seen?.ref ?? refs.u[0] : step.ref === "random_u" ? pick(refs.u) : step.ref === "random_v" ? pick(refs.v) : "zzzzzzzzzzzz";
        const who: Who = refs.v.includes(ref) ? "v" : "u";
        const job = jobsOf[who][refs[who].indexOf(ref)]?.job_id;
        const cur = job ? preps.get(`${who}|${job}`) : null;
        const tag = step.tag === "seen" ? rows.find((x) => x.ref === ref)?.tag ?? "none" : step.tag === "stale" ? (st.tags.get(ref) ?? ["0".repeat(16)])[0] : step.tag === "garbage" ? "zz'><b>"
          : step.tag === "none" ? "none" : step.tag === "other_row" ? rows.find((x) => x.ref !== ref)?.tag ?? "f".repeat(16) : cur ? hashTag(cur.payload_hash) : "none";
        const curSession = t ? await authOf(st.jar.get("tf_s") ?? "", new URLSearchParams({ t, ...(a === "mini" ? { init: await freshInit(sessions.find((x) => x.id === t)?.tg ?? "777") } : {}) }), "POST") : undefined;
        const before = job ? queued.get(`${who}|${job}`) ?? 0 : 0;
        const x = await request(a, name, { form: { ...(t ? { t } : {}), action: "apply", ref, tag } });
        // liveness: Apply on a row as shown, with the payload unchanged, from a valid session, queues it
        if (solo && !x.ctx.faulted.length && step.tag === "seen" && step.ref === "seen" && curSession && valid(curSession) && curSession.holder === a && curSession.user === who && cur
          && /^[0-9a-f]{16}$/.test(tag) && tag === hashTag(cur.payload_hash) && before === 0) {
          liveness("Apply as shown -> queued");
          if ((queued.get(`${who}|${job}`) ?? 0) !== 1) violate(x.ctx, "Apply on the row as shown did not queue it", `${x.status} ${/class="note">([^<]*)/.exec(x.body)?.[1] ?? ""}`);
        }
        return;
      }
      case "applyall": {
        const a = step.actor, st = actors[a], t = tOf(a, step.t);
        const set = step.set === "seen" ? st.page?.set ?? "" : step.set === "stale" ? [...st.sets.keys()][0] ?? "0".repeat(16) : step.set === "garbage" ? "'; drop table x; --" : "";
        await request(a, name, { form: { ...(t ? { t } : {}), action: "applyall", set } });
        return;
      }
      case "refresh": { const t = tOf(step.actor, step.t); await request(step.actor, name, { form: { ...(t ? { t } : {}), action: "refresh" } }); return; }
      case "signout": { const t = tOf(step.actor, step.t); await request(step.actor, name, { form: { ...(t ? { t } : {}), action: step.all ? "signout_all" : "signout" } }); return; }
      case "mini_boot": { await request("mini", name, { query: `list=${step.list === "u" ? LIST_U : step.list === "v" ? LIST_V : step.list === "random" ? "abcdef0123" : "zz"}` }); return; }
      case "mini_post": {
        const sec = Math.floor(W.now / 1000);
        let init = "";
        if (step.init === "u" || step.init === "v") init = await signedInit(step.init === "u" ? "777" : "888", sec - 10);
        else if (step.init === "unlinked") init = await signedInit("999", sec - 10);
        else if (step.init === "tampered") { const p = new URLSearchParams(await signedInit("999", sec - 10)); p.set("user", JSON.stringify({ id: 777, first_name: "Tg" })); init = p.toString(); }
        else if (step.init === "stale") init = await signedInit("777", sec - 7200);
        else if (step.init === "future") init = await signedInit("777", sec + 600);
        else if (step.init === "wrong_bot") init = await signedInit("777", sec - 10, OTHER_BOT);
        else if (step.init === "garbage") init = "hash=abc&user=%7B%22id%22%3A777%7D&auth_date=1";
        const list = step.list === "u" ? LIST_U : step.list === "v" ? LIST_V : step.list === "random" ? "abcdef0123" : "zz";
        const linked = step.init === "u" && W.tg["777"] === "u" && W.exists.u;
        const x = await request("mini", name, { form: { list, init }, init: step.init });
        if (solo && !x.ctx.faulted.length && linked && step.list === "u") {
          liveness("Mini App (linked) -> list");
          if (x.status !== 200 || !/<ul class="rows">/.test(x.body)) violate(x.ctx, "the linked Mini App did not open the list", String(x.status));
        }
        return;
      }
      case "method": { const x = await request("stranger", name, { method: step.m, cookie: "" }); if (x.status !== 405) violate(x.ctx, "an unsupported method was not 405", String(x.status)); return; }
      case "clock": W.now += step.ms; return;
      case "phone_change": {
        if (!W.exists.u) return;
        if (step.to === "none") W.phone.u = null;
        else if (step.to === "back") W.phone.u = PHONES.u;
        else { W.phone.u = W.phone.u === PHONES.u2 ? PHONES.u3 : PHONES.u2; }
        if (W.phone.u && W.uPhones.at(-1) !== W.phone.u) W.uPhones.push(W.phone.u);
        return;
      }
      case "delete_account": {
        if (!W.exists.u) return;
        W.exists.u = false; delete W.tg["777"];
        await env.deleteAccount(env.ids.u);
        return;
      }
      case "tg": { if (step.op === "unlink") delete W.tg["777"]; else if (W.exists.u) W.tg["777"] = "u"; return; }
      case "payload": {
        const i = (step.n - 1) % jobsOf.u.length, key = `u|${jobsOf.u[i].job_id}`;
        if (step.op === "unprepare") preps.set(key, null);
        else if (step.op === "prepare" && !preps.get(key)) preps.set(key, prepOf("u", i));
        else if (step.op === "change" && preps.get(key)) preps.set(key, { ...preps.get(key)!, payload_hash: newHash() });
        return;
      }
      case "fault": W.fault = step.f; return;
      case "par": {
        rep.concurrent++;
        await Promise.all(step.steps.map((x, i) => run(x, `${label}.${i}`)));
        return;
      }
    }
  }

  let faultAge = 0;
  if (TRACE) console.log(`#${s.id} ${s.category} smsOff=${s.smsOff}`);
  rep.scenarios++;
  rep.byCategory[s.category] = (rep.byCategory[s.category] ?? 0) + 1;
  for (let i = 0; i < s.steps.length; i++) {
    await run(s.steps[i], `s${i}`);
    if (s.steps[i].k === "fault") faultAge = 0; else if (W.fault && ++faultAge >= 4) W.fault = null; // a fault lasts until it is hit, at most 4 steps
    checkStore();
  }
  (env as Env & { oracle?: unknown }).oracle = { sessions, perJti };
}

// Seeded randomness for the run (session ids, link ids), restored afterwards.
function seededRandom(seed: number) {
  const real = crypto.getRandomValues;
  let next = rng(seed);
  // deno-lint-ignore no-explicit-any
  (crypto as any).getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
    if (a) { const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(next() * 256); }
    return a;
  };
  return { reseed: (s: number) => { next = rng(s); }, restore: () => { (crypto as { getRandomValues: typeof real }).getRandomValues = real; } };
}

// The memory twin of the session store, with the database's foreign keys: a deleted account's sessions and sign-ins go with
// it, and none can be added for it.
function memEnv(): Env {
  const mem = memSessions();
  const ids = { u: "11111111-1111-4111-8111-111111111111", v: "22222222-2222-4222-8222-222222222222" };
  const deleted = new Set<string>();
  const fk: SessionStore = { ...mem.store,
    async createSession(x) { if (deleted.has(x.userId)) throw new Error("violates foreign key"); return await mem.store.createSession(x); },
    async beginLogin(l) { if (deleted.has(l.userId)) throw new Error("violates foreign key"); return await mem.store.beginLogin(l); } };
  return { ids, sessions: fk, mem, async deleteAccount(id) {
    deleted.add(id);
    for (const [k, row] of mem.sessions) if (row.user_id === id) mem.sessions.delete(k);
    for (const [k, row] of mem.logins) if (row.user_id === id) mem.logins.delete(k);
  } };
}

// ================================================================== the bugs this battery found, each as a scenario of its own
// (the PR lists them as input -> expected -> actual). Each must now pass every invariant AND reach the state that shows the fix.
later([1], { name: "file sign-in battery regressions: dead session cookie vs a new link; used-up texts; texting off; a refused text; a store that throws", sanitizeOps: false, sanitizeResources: false, async fn() {
  const rnd = seededRandom(3);
  try {
    const signIn: Step[] = [{ k: "link", to: "owner", forward: true, age: 0 }, { k: "open", actor: "owner", pick: "latest", r: 0 }, { k: "start", actor: "owner", phone: { k: "own", fmt: 1 } },
      { k: "verify", actor: "owner", code: { k: "live" } }, { k: "get", actor: "owner", mode: "cookies", r: 0 }];
    const cases: { name: string; s: Scenario; want: (r: Report) => boolean }[] = [
      { name: "the account's phone changed, the old session ended; a NEW link must reach the phone step (was: 401 'signed out' forever while the dead cookie lasted)",
        s: { id: 900_001, smsOff: false, category: "regression", steps: [...signIn, { k: "phone_change", to: "new" }, { k: "get", actor: "owner", mode: "cookies", r: 0 },
          { k: "link", to: "owner", forward: false, age: 0 }, { k: "open", actor: "owner", pick: "latest", r: 0 }, { k: "start", actor: "owner", phone: { k: "own", fmt: 2 } }, { k: "verify", actor: "owner", code: { k: "live" } }, { k: "get", actor: "owner", mode: "cookies", r: 0 }] },
        want: (r) => (r.liveness["fresh link -> phone step"] ?? 0) >= 2 && (r.liveness["live code -> session"] ?? 0) >= 2 && r.statuses[401] >= 1 },
      { name: "a stranger types the account's number four times on a forwarded link: the 4th answer equals any number's (was: 'already texted to this number several times')",
        s: { id: 900_002, smsOff: false, category: "regression", steps: [{ k: "link", to: "owner", forward: true, age: 0 }, { k: "open", actor: "stranger", pick: "latest", r: 0 },
          ...[0, 1, 2, 3, 4].map((f) => ({ k: "start", actor: "stranger", phone: { k: "account_u", fmt: f } }) as Step)] },
        want: (r) => r.texts === 3 && r.statuses[200] >= 6 },
      { name: "texting is switched off: every number gets the same 503 (was: 503 only for the account's own number, 200 for any other)",
        s: { id: 900_003, smsOff: true, category: "regression", steps: [{ k: "link", to: "owner", forward: true, age: 0 }, { k: "open", actor: "stranger", pick: "latest", r: 0 },
          { k: "start", actor: "stranger", phone: { k: "random", n: 1234567 } }, { k: "start", actor: "stranger", phone: { k: "account_u", fmt: 0 } }] },
        want: (r) => r.statuses[503] === 2 && r.texts === 0 },
      { name: "the SMS provider refuses: the account's number is answered like any other (was: 503 'couldn't be texted' for the account's number only)",
        s: { id: 900_004, smsOff: false, category: "regression", steps: [{ k: "link", to: "owner", forward: true, age: 0 }, { k: "open", actor: "stranger", pick: "latest", r: 0 },
          { k: "fault", f: "phone.send_refused" }, { k: "start", actor: "stranger", phone: { k: "account_u", fmt: 0 } }] },
        want: (r) => r.statuses[200] >= 2 && r.faults === 1 && r.texts === 0 },
      { name: "the sign-in store throws while counting a code try or a text: a 503 page (was: the handler rejected, no response)",
        s: { id: 900_005, smsOff: false, category: "regression", steps: [{ k: "link", to: "owner", forward: false, age: 0 }, { k: "open", actor: "owner", pick: "latest", r: 0 },
          { k: "fault", f: "sessions.countSend" }, { k: "start", actor: "owner", phone: { k: "own", fmt: 0 } }, { k: "start", actor: "owner", phone: { k: "own", fmt: 0 } },
          { k: "fault", f: "sessions.countTry" }, { k: "verify", actor: "owner", code: { k: "live" } }, { k: "verify", actor: "owner", code: { k: "live" } }] },
        want: (r) => r.statuses[503] === 2 && r.phoneSessions === 1 },
    ];
    for (const c of cases) {
      rnd.reseed(c.s.id);
      const rep = newReport();
      await runScenario(c.s, memEnv(), rep);
      eq(printReport(`regression: ${c.name}`, rep), 0, c.name);
      eq(c.want(rep), true, `${c.name}: ${JSON.stringify({ statuses: rep.statuses, texts: rep.texts, liveness: rep.liveness, faults: rep.faults, sessions: rep.phoneSessions })}`);
    }
  } finally {
    rnd.restore();
  }
} });

// ================================================================== part 1: every scenario over the memory stores
const scaleTest = (part: number) => {
  const from = Math.round(((part - 1) * SCENARIOS.length) / FILE_SIGNIN_PARTS), to = Math.round((part * SCENARIOS.length) / FILE_SIGNIN_PARTS);
  // The whole battery's floors, each part its share (the parts together check at least as much).
  const share = (all: number) => Math.ceil((all * (to - from)) / SCENARIOS.length);
  return { name: `file sign-in at scale, part ${part} of ${FILE_SIGNIN_PARTS}: scenarios ${from + 1}-${to} of ${SCENARIOS.length} seeded scenarios (owner, forwarded link, other account, crawler, Mini App) through handleFile over memory stores; every invariant after every request`, sanitizeOps: false, sanitizeResources: false, async fn() {
  eq(SCENARIOS.length, 10_000);
  eq(generate({ seed: 20261029, count: 50 }), SCENARIOS.slice(0, 50), "the generator is deterministic");
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  const rnd = seededRandom(1);
  const rep = newReport();
  const started = Date.now();
  try {
    const mine = SCENARIOS.slice(from, to);
    for (const s of ONLY ? mine.filter((x) => String(x.id) === ONLY) : FIRST ? mine.filter((_, k) => from + k < FIRST) : mine) {
      rnd.reseed(s.id + 1);
      await runScenario(s, memEnv(), rep);
    }
  } finally {
    rnd.restore();
    globalThis.fetch = realFetch;
  }
  console.log(`[file-signin] memory run, part ${part} (scenarios ${from + 1}-${to}): ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const failed = printReport(`memory stores, part ${part}`, rep);
  eq(outside, [], "nothing left the machine");
  // the battery is not vacuous: people do get in, approve, get locked out
  if (!ONLY && !FIRST) for (const [k, min] of [["fresh link -> phone step", 1000], ["live code -> session", 1000], ["signed-in read -> list", 1000], ["Apply as shown -> queued", 300], ["Mini App (linked) -> list", 300]] as const) {
    if ((rep.liveness[k] ?? 0) < share(min)) throw new Error(`liveness "${k}" checked only ${rep.liveness[k] ?? 0} times (want ≥ ${share(min)})`);
  }
  if (!ONLY && !FIRST && (rep.phoneSessions < share(3000) || rep.tgSessions < share(500) || rep.approvals < share(1000) || rep.locked < share(100))) throw new Error(`too few sessions/approvals/locks: ${rep.phoneSessions}/${rep.tgSessions}/${rep.approvals}/${rep.locked}`);
  eq(failed, 0, "every invariant held after every request");
} };
};
for (let part = 1; part <= FILE_SIGNIN_PARTS; part++) later([part], scaleTest(part));

// ================================================================== part 2: a sample through the deployed session store on Postgres

later([FILE_SIGNIN_PARTS], { name: `file sign-in at scale on real Postgres: ${PG_SAMPLE} sampled scenarios through supabaseSessionStore (hash only in the table, caps counted atomically, cascade on delete)`, sanitizeOps: false, sanitizeResources: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const rnd = seededRandom(2);
  const rep = newReport();
  const realFetch = globalThis.fetch;
  try {
    const URL_ = "http://supabase.test", KEY = "service-test-key";
    const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
    const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    const outside: string[] = [];
    globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    const store = supabaseSessionStore(admin);
    const picked = sample(SCENARIOS, PG_SAMPLE, 2910);
    const started = Date.now();
    let n = 0;
    for (const s of picked) {
      rnd.reseed(100_000 + s.id);
      n++;
      const ids = { u: `aaaaaaaa-0000-4000-8000-${String(2 * n).padStart(12, "0")}`, v: `aaaaaaaa-0000-4000-8000-${String(2 * n + 1).padStart(12, "0")}` };
      await pg.sql(`insert into auth.users (id, email) values ('${ids.u}', 'u${n}@example.test'), ('${ids.v}', 'v${n}@example.test');`);
      const env: Env & { oracle?: { sessions: OSession[]; perJti: Map<string, { sessions: number }> } } = { ids, sessions: store, async deleteAccount(id) { await pg.sql(`delete from auth.users where id = '${id}'`); } };
      await runScenario(s, env, rep);
      // the table itself: only hashes; every session the oracle saw is there by its hash (unless its account was deleted);
      // ended by sign-out where the person signed out; caps never passed; a deleted account left nothing behind
      const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('h', id_hash, 'u', user_id, 'r', revoked_at is not null)), '[]') from trainee_file_sessions where user_id in ('${ids.u}', '${ids.v}')`)) as { h: string; u: string; r: boolean }[];
      const logins = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('t', tries, 's', sends, 'u', user_id)), '[]') from trainee_file_logins where user_id in ('${ids.u}', '${ids.v}')`)) as { t: number; s: number; u: string }[];
      const fail = (k: string, m: string) => { const l = rep.violations.get(k) ?? []; l.push(`#${s.id}: ${m}`); rep.violations.set(k, l); };
      for (const row of rows) if (!/^[0-9a-f]{64}$/.test(row.h)) fail("the table holds something other than a hash", row.h.slice(0, 12));
      for (const x of env.oracle!.sessions) {
        if (x.id && rows.some((row) => row.h === x.id)) fail("the table holds a session id itself", x.id.slice(0, 12));
        const row = rows.find((y) => y.h === x.hash);
        const deleted = !(await pg.sql(`select count(*) from auth.users where id = '${ids[x.user]}'`)).startsWith("1");
        if (deleted && row) fail("a deleted account's session is still in the table", x.hash.slice(0, 12));
        if (!deleted && !row) fail("a started session is missing from the table", x.hash.slice(0, 12));
        if (row && x.revoked && !row.r) fail("a signed-out session is not revoked in the table", x.hash.slice(0, 12));
      }
      for (const l of logins) if (l.t > 5 || l.s > 3) fail("a sign-in counted past its cap in the table", `${l.t} tries, ${l.s} sends`);
    }
    console.log(`[file-signin] Postgres run: ${picked.length} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    eq(outside, [], "nothing left the machine but the PostgREST double");
  } finally {
    globalThis.fetch = realFetch;
    rnd.restore();
    await pg.stop();
  }
  const failed = printReport("real Postgres", rep);
  eq(failed, 0, "every invariant held after every request, and the table agrees");
} });
