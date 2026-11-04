// A copied page is not a session (owner, 2026-10-29: "A signed, expiring, single-use link is not proof of who opened it. An unused,
// forwarded or copied link must not let another person read my private data or apply as me."; follow-up 2026-11-02).
//
// After the phone sign-in the session id lived in the HttpOnly tf_s cookie AND in every form of the page (the value `t`), and a post
// carrying `t` alone was the session: a saved, copied, cached or shared page (or a screenshot of view-source) handed its holder the
// owner's list and the Apply button until the session ended. A seeded battery (seed 20261102, SCENARIO_COUNT scenarios) through
// the real handler (supabase/functions/trainee-file/handler.ts), over memory stores (scenarios-file-session-binding.test.ts) and
// a sample over the deployed session store on real Postgres 16 (flow-scenarios-file-session-binding.test.ts). The attacker
// controls every header (a script, not a victim's browser), so #415's cross-site check does not stop any of this:
//   saved_no_cookie  the owner's saved page replayed from another browser with no cookie: every form (Refresh, Apply, Apply to all,
//                    Sign out, Sign out everywhere), its form value as the page now draws it, and the raw session id the page
//                    used to carry; and a plain read with that value in the query;
//   other_cookie     the same forms posted with the attacker's own live cookie (another account's phone session);
//   foreign_token    the owner's own cookie with the page token of ANOTHER session (another sign-in of the same account, another
//                    account's page);
//   tampered         the page token changed: a digit flipped, cut short, upper-cased, another version prefix, made under another
//                    key, the bare hash of the cookie, empty;
//   mini_replay      a saved Mini App page (its form carries the Telegram session's id) replayed: with no Telegram data, with
//                    stale, future-dated, tampered or wrongly-signed data, with fresh data of another (linked or unlinked)
//                    Telegram user, and the id planted as a tf_s cookie;
//   kind_swap        a phone session's id posted with the owner's own fresh Telegram data; a phone page token without a cookie
//                    but with fresh Telegram data;
//   signout_replay   the owner signs out (here or everywhere; phone or Mini App), then every saved form is replayed, with the old
//                    cookie, without it, and with fresh Telegram data.
// Invariants after EVERY attacking request: refused (401, 403 or 410); no private content of either account; nothing approved;
// the session store exactly as it was; no cookie set. After every honest page: no phone session's id anywhere in it. And the owner
// is never locked out: their own browser (cookie + its page's token) reads the list and Apply approves; the Mini App with
// Telegram's fresh data for the bound user reads and approves.
// The oracle is this file's own model (who holds which session, which page was drawn for whom); it never asks the product.
import assertNode from "node:assert/strict";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf, type JobView, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { sha256, type PhoneAuth, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
// Built at run time: no whole key-shaped string on disk.
const SECRET = ["file", "link", "binding", "0123456789", "abcdef"].join("-");
const OTHER_SECRET = ["file", "link", "attacker", "0123456789", "fedcba"].join("-");
const BOT = ["515151", "BINDING-bot-for-tests"].join(":");
const OTHER_BOT = ["616161", "ATTACKER-bot-for-tests"].join(":");
export const HOST = "https://trainee.example";
export const LIST_U = "0123456789", LIST_V = "9876543210";
export const T0 = Date.parse("2026-11-02T15:00:00Z");
export const SCENARIO_COUNT = 3_000, SEED = 20261102;
const MIN = 60_000;
export const CATEGORIES = ["saved_no_cookie", "other_cookie", "foreign_token", "tampered", "mini_replay", "kind_swap", "signout_replay"] as const;
export type Category = typeof CATEGORIES[number];
const WEIGHTS: Record<Category, number> = { saved_no_cookie: 20, other_cookie: 14, foreign_token: 12, tampered: 12, mini_replay: 20, kind_swap: 10, signout_replay: 12 };
const REFUSED = new Set([401, 403, 410]);

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export interface Scenario { id: number; cat: Category }
export function generate(count = SCENARIO_COUNT, seed = SEED): Scenario[] {
  const r = rng(seed), total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0), out: Scenario[] = [];
  for (let id = 0; id < count; id++) {
    let x = r() * total, cat: Category = "saved_no_cookie";
    for (const c of CATEGORIES) { x -= WEIGHTS[c]; if (x < 0) { cat = c; break; } }
    out.push({ id, cat });
  }
  return out;
}

// ---------------------------------------------------------------- the people (synthetic)
export const PHONES = { u: "+15125557320", v: "+14695558143" };
type Who = "u" | "v";
const PEOPLE = {
  u: { companies: ["Quillfeather", "Marrowbyte"], titles: ["Pricing Strategist", "Growth Cartographer"], resume: "adaline-cv-2026.pdf", first: "Adaline", last: "Pemberforth" },
  v: { companies: ["Velloway"], titles: ["Harbor Planner"], resume: "barnaby-resume.pdf", first: "Barnaby", last: "Quarrington" },
};
const PRIV: Record<Who, string[]> = { u: [], v: [] };
for (const w of ["u", "v"] as Who[]) { const p = PEOPLE[w]; PRIV[w] = [...p.companies, ...p.titles, p.resume, p.first, p.last].map((s) => s.toLowerCase()); }
const TG = { u: "777", v: "888", stranger: "999" };

// Telegram's own signing of Mini App data (the documented algorithm; an independent implementation).
async function signedInit(telegramId: string, authDate: number, token = BOT): Promise<string> {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Tg" }) });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), token), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}
const hmacHex = async (key: string, msg: string) => [...new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- the report
export type Report = { scenarios: number; requests: number; attacks: number; statuses: Record<number, number>; byCat: Record<string, number>; approvals: number; liveness: Record<string, number>; violations: Map<string, string[]> };
export const newReport = (): Report => ({ scenarios: 0, requests: 0, attacks: 0, statuses: {}, byCat: {}, approvals: 0, liveness: {}, violations: new Map() });
export function printReport(name: string, r: Report): number {
  const failed = [...r.violations.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[file-session-binding] ${name}: ${r.scenarios} scenarios (${Object.entries(r.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${r.requests} requests (${r.attacks} attacking), ${failed} violations`,
    `  attack statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k}:${v}`).join(" ")}; honest approvals ${r.approvals}`,
    `  liveness checked: ${Object.entries(r.liveness).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  for (const [k, xs] of r.violations) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return failed;
}

export interface Env {
  ids: Record<Who, string>;
  sessions: SessionStore;
  snapshot(): Promise<string>; // the session store's whole state for these accounts (sessions and sign-ins)
}
interface Res { status: number; headers: Headers; body: string }
type Form = Record<string, string>;
interface Page { t: string; forms: Form[] }
const SAME = { origin: HOST, "sec-fetch-site": "same-origin" };

export async function runScenario(s: Scenario, env: Env, rep: Report): Promise<void> {
  const r = rng(104729 * (s.id + 1) + SEED);
  rep.scenarios++; rep.byCat[s.cat] = (rep.byCat[s.cat] ?? 0) + 1;
  const violate = (kind: string, msg: string) => { const l = rep.violations.get(kind) ?? []; l.push(`#${s.id} ${s.cat}: ${msg}`.slice(0, 400)); rep.violations.set(kind, l); };
  const live = (k: string) => { rep.liveness[k] = (rep.liveness[k] ?? 0) + 1; };
  const W = { now: T0 + Math.floor(r() * 30) * MIN, codes: new Map<string, string>(), approvals: [] as string[], phoneIds: new Set<string>() };
  const whoOf = (id: string): Who | null => (id === env.ids.u ? "u" : id === env.ids.v ? "v" : null);

  // ---- the lists: U has two prepared postings, V one.
  const refs: Record<Who, string[]> = { u: [], v: [] }, jobs = new Map<string, JobView>();
  const preps = new Map<string, PreparedRow>(), postings = new Map<string, Record<string, unknown>>(), apps = new Map<string, AppRow>();
  for (const who of ["u", "v"] as Who[]) {
    for (let i = 0; i < PEOPLE[who].companies.length; i++) {
      const c = PEOPLE[who].companies[i], slug = c.toLowerCase(), jobId = `greenhouse:${slug}:${i + 1}`, url = `https://boards.greenhouse.io/${slug}/jobs/${i + 1}`;
      const post = { job_id: jobId, provider: "greenhouse", company_domain: `${slug}.com`, location: "Austin, TX", pay: "$90k", description: "<p>Own the weekly pricing report.</p>" };
      postings.set(jobId, post);
      const ref = await refOf(env.ids[who], jobId); refs[who].push(ref);
      jobs.set(`${env.ids[who]}|${ref}`, jobViewOf({ job_id: jobId, company: c, title: PEOPLE[who].titles[i], location: "Austin, TX", url, pay: "$90k" }, post as never));
      preps.set(`${who}|${jobId}`, { id: `33333333-3333-4333-8333-${who === "u" ? "1" : "2"}${String(i + 1).padStart(11, "0")}`, job_id: jobId, company: c, url, payload_hash: await sha256(`${s.id}|${who}|${i}`), state: "ready", card_lines: [],
        payload: { resume_sha256: "f".repeat(64), resume_name: PEOPLE[who].resume, fields: [{ name: "first_name", label: "First name", value: PEOPLE[who].first }, { name: "last_name", label: "Last name", value: PEOPLE[who].last }] } });
    }
  }
  const store: FileStore = {
    async remember() {}, async rememberList() {},
    async recall(u, ref) { const j = jobs.get(`${u}|${ref}`); return j ? { job: j, shownAs: "text" } as never : null; },
    async recallList(u, id) { const w = whoOf(u); return w && id === (w === "u" ? LIST_U : LIST_V) ? refs[w] : null; },
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
      W.approvals.push(key);
      return { n: n + 1, company: p.company, result: "queued" };
    });
    return { card: { id: "44444444-4444-4444-8444-000000000001", items: [], shown_at: new Date(W.now).toISOString() }, results };
  };
  const phone: PhoneAuth = {
    async ready() { return true; },
    async accountPhone(u) { const w = whoOf(u); return w ? PHONES[w] : null; },
    async send(p) { const code = String(100000 + Math.floor(r() * 900000)); W.codes.set(p, code); return { ok: true }; },
    async check(p, code) { if (W.codes.get(p) !== code) return null; W.codes.delete(p); return p === PHONES.u ? env.ids.u : p === PHONES.v ? env.ids.v : null; },
  };
  const d = {
    store, cards: { async open() { throw new Error("not used: confirm is"); }, confirm } as never, tap: { async card() { return null; }, async prepared() { return []; }, async answer() { return []; } },
    now: () => W.now, env: { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file`, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: "https://t.me/TraineeBot" } as Record<string, string>)[k] },
    sessions: env.sessions, phone, userOfTelegram: async (tg: string) => (tg === TG.u ? env.ids.u : tg === TG.v ? env.ids.v : null),
  } as unknown as FileDeps;

  async function call(o: { method?: string; query?: string; form?: Form; cookie?: string }): Promise<Res> {
    const method = o.method ?? (o.form ? "POST" : "GET");
    const headers: Record<string, string> = { ...SAME, ...(o.cookie ? { cookie: o.cookie } : {}) };
    if (o.form) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await handleFile(new Request(`${HOST}/file${o.query ?? ""}`, { method, headers, body: o.form ? new URLSearchParams(o.form).toString() : null }), d);
    rep.requests++;
    const out = { status: res.status, headers: res.headers, body: await res.text() };
    // after every answer: no phone session's id anywhere in a page (it lives in the HttpOnly cookie only)
    for (const m of out.body.matchAll(/fs1\.[0-9a-f]{64}/g)) if (W.phoneIds.has(m[0])) violate("a phone session's id in the page", `${method} ${o.form?.action ?? ""} -> ${out.status}`);
    return out;
  }
  const pageOf = (body: string): Page => {
    const forms: Form[] = [];
    for (const m of body.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
      const f: Form = {};
      for (const i of m[1].matchAll(/<input type="hidden" name="([a-z]+)" value="([^"]*)">/g)) f[i[1]] = i[2].replace(/&amp;/g, "&");
      if (f.action) forms.push(f);
    }
    return { t: /name="t" value="([^"]+)"/.exec(body)?.[1] ?? "", forms };
  };
  const privateIn = (body: string): Who | null => { const low = body.toLowerCase(); return (["u", "v"] as Who[]).find((w) => PRIV[w].some((p) => low.includes(p))) ?? null; };

  // The owner's (or V's) whole phone sign-in from a fresh link, as their browser does it. Returns the cookie and the list page.
  async function phoneSignIn(who: Who): Promise<{ id: string; page: Page } | null> {
    const link = (await mintFileToken({ secret: SECRET, userId: env.ids[who], list: who === "u" ? LIST_U : LIST_V, now: W.now, kind: "l" }))!;
    const a = await call({ query: `?t=${encodeURIComponent(link)}` });
    const tfl = a.headers.getSetCookie().find((c) => c.startsWith("tf_l="))?.split(";")[0];
    if (a.status !== 303 || !tfl) return null;
    if ((await call({ form: { action: "phone_start", phone: PHONES[who] }, cookie: tfl })).status !== 200) return null;
    const c = await call({ form: { action: "phone_verify", code: W.codes.get(PHONES[who]) ?? "" }, cookie: tfl });
    const id = c.headers.getSetCookie().find((x) => x.startsWith("tf_s="))?.split(";")[0].slice(5) ?? "";
    if (c.status !== 303 || !id) return null;
    W.phoneIds.add(id);
    const p = await call({ cookie: `tf_s=${id}` });
    if (p.status !== 200 || privateIn(p.body) !== who) return null;
    return { id, page: pageOf(p.body) };
  }
  const fresh = async (tg: string, age = 30) => await signedInit(tg, Math.floor(W.now / 1000) - age);
  async function miniSignIn(who: Who): Promise<{ id: string; page: Page } | null> {
    const x = await call({ form: { init: await fresh(TG[who]), list: who === "u" ? LIST_U : LIST_V } });
    const p = pageOf(x.body);
    if (x.status !== 200 || privateIn(x.body) !== who || !p.t) return null;
    return { id: p.t, page: p };
  }

  // One attacking request: refused, no private content, nothing approved, the store unchanged, no cookie set.
  async function attack(what: string, o: { method?: string; query?: string; form?: Form; cookie?: string }) {
    const before = await env.snapshot(), n = W.approvals.length;
    const x = await call(o);
    rep.attacks++; rep.statuses[x.status] = (rep.statuses[x.status] ?? 0) + 1;
    const where = `${what} (${o.form?.action ?? "read"}) -> ${x.status}`;
    if (!REFUSED.has(x.status)) violate("an attacking request was not refused", where);
    const who = privateIn(x.body);
    if (who) violate(`${who === "u" ? "U" : "V"}'s private content reached an attacker`, where);
    if (W.approvals.length !== n) violate("an attacker approved an application", where);
    if ((await env.snapshot()) !== before) violate("an attacking request changed the session store", where);
    if (x.headers.getSetCookie().some((c) => /^tf_s=[^;]/.test(c))) violate("an attacking request was handed a session cookie", where);
  }
  // A form from a page, with the form value replaced (or left as drawn).
  const formsOf = (p: Page) => p.forms.length ? p.forms : [{ t: p.t, action: "refresh" }];
  const someForm = (p: Page, t?: string): Form => { const f = { ...pick(r, formsOf(p)) }; if (t !== undefined) f.t = t; return f; };

  // ---- the owner's own browser and page (every scenario)
  const owner = await phoneSignIn("u");
  if (!owner) { violate("liveness: the owner could not sign in", ""); return; }
  const ownerCookie = `tf_s=${owner.id}`;
  if (owner.page.t === owner.id) violate("the page carries the session's id", "the list page's form value is the cookie's session id");
  let ownerLive = true, miniLive: { id: string; page: Page } | null = null;

  switch (s.cat) {
    case "saved_no_cookie": {
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
        const kind = pick(r, ["drawn", "drawn", "raw_id", "query"] as const);
        if (kind === "query") await attack("a read with the page's value in the query", { query: `?t=${encodeURIComponent(pick(r, [owner.page.t, owner.id]))}${r() < 0.5 ? "&format=text" : ""}` });
        else await attack(kind === "drawn" ? "the saved page's form, no cookie" : "the raw session id in the form, no cookie", { form: someForm(owner.page, kind === "drawn" ? undefined : owner.id) });
      }
      // a read with no cookie at all
      await attack("a read with no cookie", { query: pick(r, ["", "?format=text"]) });
      break;
    }
    case "other_cookie": {
      const v = await phoneSignIn("v");
      if (!v) { violate("liveness: V could not sign in", ""); break; }
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
        const t = pick(r, [owner.page.t, owner.page.t, owner.id]);
        await attack("the owner's saved form with another account's cookie", { form: someForm(owner.page, t), cookie: `tf_s=${v.id}` });
      }
      // V's own page still works for V (the refusals did not end V's session)
      const vv = await call({ form: { t: v.page.t, action: "refresh" }, cookie: `tf_s=${v.id}` });
      if (vv.status === 200 && privateIn(vv.body) === "v") live("other_cookie: the cookie's own holder still reads their own list"); else violate("liveness: V's own page stopped working", String(vv.status));
      break;
    }
    case "foreign_token": {
      // another page token: the owner's second sign-in (another browser), or V's page
      const other = r() < 0.5 ? await phoneSignIn("u") : await phoneSignIn("v");
      if (!other) { violate("liveness: the second sign-in failed", ""); break; }
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) await attack("the owner's cookie with another session's page token", { form: someForm(owner.page, other.page.t), cookie: ownerCookie });
      // and the other session's cookie with the owner's token
      await attack("another session's cookie with the owner's page token", { form: someForm(owner.page), cookie: `tf_s=${other.id}` });
      break;
    }
    case "tampered": {
      const t = owner.page.t;
      const flip = (x: string, i: number) => x.slice(0, i) + ((parseInt(x[i], 16) ^ (1 + Math.floor(r() * 15))).toString(16)) + x.slice(i + 1);
      const variants = [
        () => flip(t, 4 + Math.floor(r() * (t.length - 4))),
        () => t.slice(0, 4 + Math.floor(r() * (t.length - 5))),
        () => t.toUpperCase(),
        () => t.replace(/^[a-z]+\d\./, pick(r, ["fp2.", "fp0.", "fs1.", "FP1.", ""])),
        async () => `fp1.${await hmacHex(OTHER_SECRET, `trainee-file/page-token/v1|${await sha256(owner.id)}`)}`,
        async () => `fp1.${await sha256(owner.id)}`,
        async () => `fp1.${await sha256(`trainee-file/page-token/v1|${await sha256(owner.id)}`)}`,
        () => "",
        () => `${t} `,
        () => `${t}0`,
      ];
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
        const tv = await pick(r, variants)();
        await attack("a tampered page token with the owner's cookie", { form: someForm(owner.page, tv), cookie: r() < 0.8 ? ownerCookie : undefined });
      }
      break;
    }
    case "mini_replay": {
      const m = await miniSignIn("u");
      if (!m) { violate("liveness: the Mini App did not open", ""); break; }
      miniLive = m;
      if (W.phoneIds.has(m.id)) violate("a Mini App page carries a phone session", "");
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
        const kind = pick(r, ["none", "stale", "future", "other_linked", "unlinked", "tampered", "other_bot", "planted_cookie", "v_session"] as const);
        const base = someForm(m.page);
        if (kind === "planted_cookie") { await attack("a Mini App session id planted as tf_s", r() < 0.5 ? { cookie: `tf_s=${m.id}`, query: pick(r, ["", "?format=text"]) } : { cookie: `tf_s=${m.id}`, form: someForm(m.page, owner.page.t) }); continue; }
        if (kind === "v_session") {
          const mv = await miniSignIn("v");
          if (!mv) { violate("liveness: V's Mini App did not open", ""); continue; }
          await attack("the owner's fresh Telegram data with V's Mini App session", { form: { ...someForm(mv.page), init: await fresh(TG.u) } });
          continue;
        }
        let init = "";
        if (kind === "stale") init = await fresh(TG.u, 3601 + Math.floor(r() * 86_400));
        if (kind === "future") init = await fresh(TG.u, -(600 + Math.floor(r() * 3600)));
        if (kind === "other_linked") init = await fresh(TG.v);
        if (kind === "unlinked") init = await fresh(TG.stranger);
        if (kind === "other_bot") init = await signedInit(TG.u, Math.floor(W.now / 1000) - 30, OTHER_BOT);
        if (kind === "tampered") { const p = new URLSearchParams(await fresh(pick(r, [TG.v, TG.stranger]))); p.set("user", JSON.stringify({ id: Number(TG.u), first_name: "Tg" })); init = p.toString(); }
        await attack(`a saved Mini App page replayed (${kind})`, { form: init ? { ...base, init } : base });
      }
      break;
    }
    case "kind_swap": {
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        if (r() < 0.5) await attack("a phone session's id with the owner's own fresh Telegram data", { form: { ...someForm(owner.page, owner.id), init: await fresh(TG.u) } });
        else await attack("a phone page token with fresh Telegram data and no cookie", { form: { ...someForm(owner.page), init: await fresh(TG.u) } });
      }
      break;
    }
    case "signout_replay": {
      const mini = r() < 0.4;
      if (mini) {
        const m = await miniSignIn("u");
        if (!m) { violate("liveness: the Mini App did not open", ""); break; }
        const all = r() < 0.5;
        const out = await call({ form: { t: m.id, action: all ? "signout_all" : "signout", init: await fresh(TG.u) } });
        if (out.status !== 200) { violate("liveness: Mini App sign-out failed", String(out.status)); break; }
        live("signout_replay: Mini App sign-out");
        if (all) ownerLive = false;
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) await attack("a signed-out Mini App page replayed with fresh Telegram data", { form: { ...someForm(m.page), init: await fresh(TG.u) } });
      } else {
        const all = r() < 0.5;
        const out = await call({ form: { t: owner.page.t, action: all ? "signout_all" : "signout" }, cookie: ownerCookie });
        if (out.status !== 200) { violate("liveness: sign-out from the page failed", String(out.status)); break; }
        live("signout_replay: phone sign-out");
        ownerLive = false;
        for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
          const how = pick(r, ["cookie", "none", "raw", "init"] as const);
          if (how === "cookie") await attack("a signed-out page replayed with its old cookie", { form: someForm(owner.page), cookie: ownerCookie });
          else if (how === "none") await attack("a signed-out page replayed with no cookie", { form: someForm(owner.page) });
          else if (how === "raw") await attack("the signed-out session id in the form", { form: someForm(owner.page, owner.id) });
          else await attack("a signed-out phone session id with fresh Telegram data", { form: { ...someForm(owner.page, owner.id), init: await fresh(TG.u) } });
        }
        await attack("a read with the signed-out cookie", { cookie: ownerCookie });
      }
      break;
    }
  }

  // ---- liveness: the owner is never locked out of their own list by any of the above
  if (ownerLive) {
    const n = W.approvals.length;
    const refresh = await call({ form: { t: owner.page.t, action: "refresh" }, cookie: ownerCookie });
    if (refresh.status !== 200 || privateIn(refresh.body) !== "u") violate("liveness: the owner's own page stopped working", String(refresh.status));
    else {
      const apply = pageOf(refresh.body).forms.find((f) => f.action === "apply" && /^[0-9a-f]{16}$/.test(f.tag ?? ""));
      if (apply) {
        const x = await call({ form: apply, cookie: ownerCookie });
        if (x.status === 200 && W.approvals.length === n + 1) { live("owner: Apply from the page approves"); rep.approvals++; }
        else violate("liveness: Apply from the owner's own page did not approve", String(x.status));
      } else violate("liveness: the owner's page offered no Apply", "");
    }
  }
  if (miniLive) {
    const n = W.approvals.length;
    const p = await call({ form: { t: miniLive.id, action: "refresh", init: await fresh(TG.u) } });
    const apply = pageOf(p.body).forms.find((f) => f.action === "apply" && /^[0-9a-f]{16}$/.test(f.tag ?? ""));
    if (p.status !== 200 || privateIn(p.body) !== "u" || !apply) violate("liveness: the Mini App with fresh data stopped working", String(p.status));
    else {
      const x = await call({ form: { ...apply, init: await fresh(TG.u) } });
      if (x.status === 200 && W.approvals.length === n + 1) { live("mini: Apply with fresh Telegram data approves"); rep.approvals++; }
      else violate("liveness: Apply from the Mini App did not approve", String(x.status));
    }
  }
}

// The memory run: the session store's memory twin, part `part` of `of`.
export async function memoryRun(part: number, of: number, count = SCENARIO_COUNT): Promise<void> {
  const { memSessions } = await import("./file-session-fakes.ts");
  const all = generate(count), size = Math.ceil(all.length / of), mine = all.slice((part - 1) * size, part * size);
  const rep = newReport();
  const started = Date.now();
  for (const s of mine) {
    const m = memSessions();
    const ids = { u: `aaaaaaaa-0000-4000-8000-${String(2 * s.id).padStart(12, "0")}`, v: `aaaaaaaa-0000-4000-8000-${String(2 * s.id + 1).padStart(12, "0")}` };
    await runScenario(s, { ids, sessions: m.store, snapshot: async () => JSON.stringify([[...m.sessions].sort(), [...m.logins].sort()]) }, rep);
  }
  console.log(`[file-session-binding] memory part ${part}/${of} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  eq(printReport(`memory part ${part}/${of}`, rep), 0, "every invariant held after every request");
  for (const c of CATEGORIES) if (!rep.byCat[c]) throw new Error(`category ${c} never ran`);
}
