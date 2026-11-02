// The WHOLE jobs-page journey at scale, round 2 (owner, 2026-10-29: "open the postings with company logos, roles and details, log in
// with my phone number, then click Apply and have it apply for me"). Seeded scenarios (scenarios/file-journey-r2-generator.ts) run
// through the real handler (supabase/functions/trainee-file/handler.ts) and the real Telegram card path (telegram_jobs.ts sendJobCards
// and tapJob), over memory stores with a fixed clock; a seeded sample runs the same journeys on real Postgres 16 through the deployed
// stores (flow-scenarios-file-journey-r2.test.ts). After EVERY request:
//   - nothing private without a valid session for that account: a link, a crawler, a cross-site form, a planted cookie, another
//     account's session, an expired or signed-out session see no row, no company, no title, no ref, and approve nothing;
//   - the exact payload shown is approved once: only the current tag of an approvable row approves it; Apply to all approves
//     exactly the approvable set shown or nothing; across the page and Telegram's Confirm each posting is approved at most once,
//     and the other side says it is already in the applications; "applied" is never said (on the page, in Telegram, in a toast);
//   - every row is the posting's own truth: the status word for an application, Preparing, Needs you, Apply there for LinkedIn /
//     Indeed / Handshake, no Apply for a posting that cannot pass the screen or whose application goes nowhere a browser can; the
//     page shows the first 30 of a longer list and says so, and so does the Telegram message that links it;
//   - rendering truth: every company, title and lettermark whole (no half emoji), escaped, bidi controls dropped; no foreign tag,
//     handler, script or javascript:/data: link; the plain-text twin likewise;
//   - security on every response: CSP with hashed scripts only and frame-ancestors limited to Telegram, nosniff, no-store,
//     a referrer policy that never sends to another site (same-origin); every cookie HttpOnly, Secure, SameSite; every redirect to this host's own path; a session id planted before the
//     sign-in never survives it; sign-in texts and code tries per link stay under their caps and a stranger's number gets no text;
//   - accessibility that decides correctness: every Apply names its role and company, every status chip is a status, the page has
//     one live region for what changed.
// The oracle is this file's own model of each posting's truth; it never asks the product what a row should show.
import assertNode from "node:assert/strict";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, sendJobCards, tapJob, type JobDeps, type JobSender, type JobView, type PostingRow, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { MAX_CODE_SENDS, MAX_CODE_TRIES, SESSION_TTL_MS, sha256, startSession, type PhoneAuth, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { FEED_SCRIPT, renderFeed } from "../../supabase/functions/_shared/file_page.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { wantsFrom } from "../../supabase/functions/_shared/career_apply_want.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";
import { Page } from "./scenarios/file-journey-r2-dom.ts";
import { descOf, generate, type PostingSpec, type PrepKind, type Scenario, type Step, TEXT, TITLE } from "./scenarios/file-journey-r2-generator.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const U = "11111111-1111-4111-8111-1111111111aa", V = "22222222-2222-4222-8222-2222222222bb";
export const T0 = Date.parse("2026-10-30T15:00:00Z");
const DAY = 86_400_000;
export const SECRET_LINK = ["file-link", "secret", "0123456789", "journey"].join("-"); // built at run time (no whole key-shaped string on disk)
export const BOT_TOKEN = ["123456", "JOURNEY-r2-bot"].join(":");
export const SCENARIOS = generate({ seed: 20261030, count: 10_000 });
export const RESUME_FILE = "%PDF-1.4\n% TEST file-journey r2 resume\n%%EOF\n";
export const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const SECRET_MARK = ["hunter", "2", "SECRETVALUE"].join("");
const BIDI = /[‪-‮⁦-⁩]/g;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (h: string) => btoa(h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join(""));
// The HTML contract every value is written under (bidi controls dropped, the five characters escaped).
export const escH = (s: string) => s.replace(BIDI, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const textOf = (h: string) => unesc(h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const BYHAND = /(^|\.)(linkedin\.com|indeed\.com|joinhandshake\.com)$/i;
export const APP_WORD: Record<string, string> = { queued: "Queued", driving: "Sending", submitted_unconfirmed: "Submitted", confirmed: "Confirmed", failed: "Failed", not_submitted: "Not submitted", needs_user: "Needs you", unknown_outcome: "Unknown" };
// "applied" is never said before a submit record: only "not applied" (a by-hand row) may carry the word.
const saysApplied = (t: string) => /\bapplied\b/i.test(t.replace(/\bnot applied\b/gi, ""));
// The lettermark, computed here: the first whole character of the company (bidi controls dropped, trimmed), upper-cased.
export const initialOf = (c: string) => { const ch = [...c.replace(BIDI, "").trim()][0]; return ch ? [...ch.toLocaleUpperCase("en")][0] : "?"; };

// ---------------------------------------------------------------- the world
export interface Post { spec: PostingSpec; n: number; jobId: string; url: string; ref: string; job: JobView; row: PostingRow | null; hashes: string[] }
export interface Truth {
  list: string[]; // the list's refs, in order
  prep: Map<string, { hash: string; secret: boolean; dest: string | null } | null>; // by job id: the current ready payload
  app: Map<string, string | null>; // by job id: the application's state
  wanted: Map<string, boolean>;
  closed: Map<string, boolean>;
  approvals: Map<string, number>; // by job id: approvals ever
}
export interface World {
  userId: string; accounts: Record<string, string | null>; posts: Post[]; deps: FileDeps; phone: ReturnType<typeof fakePhone>; sessions: SessionStore; clock: { now: number };
  listId: string | null; setList(refs: string[]): Promise<void>;
  truth(): Promise<Truth>;
  prepare(i: number, kind: PrepKind): Promise<void>;
  mutate(op: "close" | "reprepare" | "elsewhere" | "unprepare", i: number, r: () => number): Promise<void>;
  addPosting(): Promise<number>;
  sessionRows(): Promise<{ user_id: string; revoked: boolean; idHash: string }[]>;
  vSession(): Promise<string>;
}

export function urlOf(spec: PostingSpec, salt: number): { url: string; jobId: string } {
  const id = 7_000_000 + salt * 100 + spec.n, board = `jr${salt}b${spec.n}`;
  const uuid = `${(salt * 1000 + spec.n).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(salt).padStart(12, "0")}`;
  switch (spec.url) {
    case "greenhouse": return { url: `https://boards.greenhouse.io/${board}/jobs/${id}`, jobId: `greenhouse:${board}:${id}` };
    case "lever": return { url: `https://jobs.lever.co/${board}/${uuid}`, jobId: `lever:${board}:${uuid}` };
    case "ashby": return { url: `https://jobs.ashbyhq.com/${board}/${uuid}`, jobId: `ashby:${board}:${uuid}` };
    case "linkedin": return { url: `https://www.linkedin.com/jobs/view/${id}`, jobId: `greenhouse:${board}:${id}` };
    case "indeed": return { url: `https://www.indeed.com/viewjob?jk=${id}`, jobId: `greenhouse:${board}:${id}` };
    case "handshake": return { url: `https://app.joinhandshake.com/jobs/${id}`, jobId: `greenhouse:${board}:${id}` };
    case "javascript": return { url: `javascript:alert(${id})//https://boards.greenhouse.io/x`, jobId: `greenhouse:${board}:${id}` };
    case "data": return { url: `data:text/html,<script>alert(${id})</script>`, jobId: `greenhouse:${board}:${id}` };
  }
}
export const textFor = (s: PostingSpec) => ({ company: TEXT[s.company](s.n), title: TITLE[s.title](s.n) });
export const providerOf = (jobId: string) => jobId.split(":")[0];

export async function postsOf(specs: PostingSpec[], userId: string, salt: number, now: number): Promise<Post[]> {
  const out: Post[] = [];
  for (const s of specs) out.push(await postOf(s, userId, salt, now));
  return out;
}
export async function postOf(s: PostingSpec, userId: string, salt: number, now: number): Promise<Post> {
  const { url, jobId } = urlOf(s, salt);
  const { company, title } = textFor(s);
  const row: PostingRow | null = s.hasRow ? { job_id: jobId, provider: providerOf(jobId), company, title, location: s.n % 3 ? "Tel Aviv · תל אביב" : "Remote", url: url.replace(/^http:/, "https:"),
    description: descOf(s) ?? "", remote: s.n % 2 ? "hybrid" : null, seniority_band: null, posted_at: new Date(now - 2 * DAY).toISOString(), first_seen_at: new Date(now - 2 * DAY).toISOString(),
    pay: s.n % 4 ? "$120k" : null, closed_at: s.closed ? new Date(now - DAY).toISOString() : null, deadline: s.deadlinePast ? new Date(now - DAY).toISOString() : null } : null;
  const domain = s.logo === "stated" ? `northwind${s.n}.com` : s.logo === "hostile" ? `evil.example" onerror="alert(1)` : undefined;
  const hit = { job_id: jobId, company, title, url, ...(s.n % 2 ? { location: "Austin, TX" } : {}), ...(domain ? { company_domain: domain } : {}), fit: { reasons: [`Your SQL <b>matches</b> (${s.n})`] } };
  return { spec: s, n: s.n, jobId, url, ref: await refOf(userId, jobId), job: jobViewOf(hit, row), row, hashes: [] };
}

export function payloadOf(p: Post, kind: PrepKind, version: number, now: number, userId: string): Record<string, unknown> {
  const fields: Record<string, unknown>[] = [{ name: "first_name", label: "First name", value: "Ada" }];
  if (kind === "markup") fields.push({ name: "why", label: `Why <b>us</b>? "'&`, value: `<script>alert(${p.n})</script> & 🚀 ${"long answer ".repeat(30)}` });
  if (kind === "secret") fields.push({ name: "password", label: "Password", type: "password", value: `${SECRET_MARK}${version}` });
  const pl: Record<string, unknown> = { version: 1, user_id: userId, job_id: p.jobId, company: p.job.company || "Employer", url: /^https?:/.test(p.url) ? p.url : `https://boards.greenhouse.io/x/jobs/${p.n}`, fields,
    privacy_epoch: 0, account_version: 0, expires_at: new Date(now + 30 * DAY).toISOString(), resume_sha256: RESUME_SHA, resume_name: "ada-cv-2026.pdf", cover_note: { text: `I built the pricing model. (v${version})` }, attempt: version };
  if (kind === "bad_dest") pl.destination = version % 2 ? `javascript:alert(${p.n})` : `data:text/html,<script>alert(${p.n})</script>`;
  if (kind === "byhand_dest") pl.destination = "https://www.linkedin.com/jobs/apply/77";
  return pl;
}
export const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const canPrepare = (p: Post) => /^https:\/\//.test(p.url) && !BYHAND.test(hostOf(p.url));
export const envOf = (s: Scenario): Record<string, string | undefined> => ({ TRAINEE_FILE_LINK_SECRET: SECRET_LINK, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRAINEE_LOGO_URL: s.logoTpl === "custom" ? "https://logos.example/{domain}.png" : undefined });

// ---------------------------------------------------------------- the memory world (the database's rules as plain code)
export async function memWorld(s: Scenario): Promise<World> {
  const clock = { now: T0 };
  const posts = await postsOf(s.postings, U, s.id % 1000, T0);
  const preps = new Map<string, { id: string; payload: Record<string, unknown>; hash: string; state: string }[]>(); // by job id
  const apps = new Map<string, { state: string; url: string }>();
  const wanted = new Set<string>(); // posting keys
  const approvals = new Map<string, number>();
  const kv = new Map<string, unknown>();
  let pidN = 0, cardN = 0, extra = 0;
  const S = memSessions();
  const accounts: Record<string, string | null> = { [U]: "+15125550100", [V]: "+15125550199" };
  const phone = fakePhone(accounts);
  const keyOf = (job: { url: string; job_id: string; company: string; title: string }) => wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title } as never], clock.now).ok[0]?.posting_key ?? null;
  const cur = (jobId: string) => (preps.get(jobId) ?? []).findLast((x) => x.state === "ready" || x.state === "shown") ?? null;
  const postByJob = (jobId: string) => posts.find((p) => p.jobId === jobId) ?? null;
  const sentByLink = (jobId: string, url: string) => apps.has(jobId) || [...apps.values()].some((a) => a.url === url);
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return (kv.get(`${u}|job|${ref}`) as { job: JobView; shownAs: "text" }) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, [...refs]); },
    async recallList(u, id) { return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async postings(ids) { return posts.filter((p) => p.row && ids.includes(p.jobId)).map((p) => ({ ...p.row! })); },
    async save() { return "saved"; },
    async prepared(u, jobId) {
      if (u !== U) return null;
      const p = cur(jobId), post = postByJob(jobId);
      return p && post ? { id: p.id, job_id: jobId, company: String(p.payload.company), url: String(p.payload.url), payload: structuredClone(p.payload), payload_hash: p.hash, card_lines: [], state: p.state } as PreparedRow : null;
    },
    async applied(u, jobId) { return u === U && apps.has(jobId); },
    async want(u, job) {
      if (u !== U) return { result: "refused", reason: "not yours" };
      const w = wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title } as never], clock.now);
      if (w.refused.length) return { result: "refused", reason: w.refused[0].reason };
      const it = w.ok[0];
      if (wanted.has(it.posting_key)) return { result: "already" };
      if (sentByLink(it.posting_key, it.url)) return { result: "refused", reason: "this posting is already in your applications, and each posting goes at most once" };
      wanted.add(it.posting_key);
      return { result: "queued" };
    },
    async appRow(u, jobId, url) {
      if (u !== U) return null;
      const a = apps.get(jobId) ?? (url ? [...apps.entries()].find(([, x]) => x.url === url)?.[1] : undefined);
      if (!a) return null;
      return { id: `app-${jobId}`, state: a.state, reason: null, confirmation_id: a.state === "confirmed" ? "C-1" : null, created_at: new Date(clock.now).toISOString(), updated_at: new Date(clock.now).toISOString(),
        email_confirmed_at: null, payload: {}, company: postByJob(jobId)?.job.company ?? "Employer", url: a.url } as AppRow;
    },
    async wanted(u, url, job) { if (u !== U) return false; const k = job ? keyOf(job) : null; return k ? wanted.has(k) : false; void url; },
  };
  const cards = new Map<string, { id: string; user_id: string; items: { n: number; prepared_id: string; payload_hash: string }[]; state: string; shown_at: string }>();
  const prepById = (id: string) => { for (const [jobId, xs] of preps) for (const p of xs) if (p.id === id) return { jobId, p }; return null; };
  const answer = (u: string, cardId: string, approve: number[]) => {
    const c = cards.get(cardId);
    if (!c || c.user_id !== u) throw new Error("invalid card answer");
    if (c.state !== "open") throw new Error("card_answered");
    c.state = "answered";
    return c.items.map((it) => {
      const x = prepById(it.prepared_id)!;
      const post = postByJob(x.jobId)!;
      let result: string;
      if (x.p.hash !== it.payload_hash) result = "changed";
      else if (!approve.includes(it.n)) result = "declined";
      else if (x.p.state !== "ready" && x.p.state !== "shown") result = "refused";
      else if (sentByLink(x.jobId, post.url)) result = "duplicate";
      else { apps.set(x.jobId, { state: "queued", url: post.url }); approvals.set(x.jobId, (approvals.get(x.jobId) ?? 0) + 1); result = "queued"; }
      x.p.state = result === "queued" ? "approved" : "declined";
      return { n: it.n, company: String(x.p.payload.company), result };
    });
  };
  const openCard = (u: string, ids: string[]) => {
    const items = ids.map((id, k) => { const x = prepById(id); if (!x || (x.p.state !== "ready" && x.p.state !== "shown")) throw new Error("invalid card"); return { n: k + 1, prepared_id: id, payload_hash: x.p.hash }; });
    for (const id of ids) prepById(id)!.p.state = "shown";
    for (const c of cards.values()) if (c.user_id === u && c.state === "open") c.state = "answered";
    const id = `44444444-4444-4444-8444-${String(s.id * 1000 + ++cardN).padStart(12, "0")}`;
    cards.set(id, { id, user_id: u, items, state: "open", shown_at: new Date(clock.now).toISOString() });
    return { id, items, shown_at: new Date(clock.now).toISOString() };
  };
  const tap: TapStore = {
    async card(u, id) { const c = cards.get(id); return c && c.user_id === u ? structuredClone(c) as never : null; },
    async prepared(_u, ids) { return ids.map((id) => prepById(id)).filter(Boolean).map((x) => ({ id: x!.p.id, payload_hash: x!.p.hash, company: String(x!.p.payload.company) })); },
    async answer(u, cardId, approve) { return answer(u, cardId, approve) as never; },
  };
  const env = envOf(s);
  const deps: FileDeps = { store, now: () => clock.now, env: { get: (k) => env[k] }, events: null, facts: async () => [], sessions: S.store, phone: phone.auth,
    userOfTelegram: async () => null,
    cards: {
      async open(u, ids) { return openCard(u, ids) as never; },
      async confirm(u, ids, hashes) {
        if (ids.some((id, k) => prepById(id)?.p.hash !== hashes[k])) throw new Error("card_changed");
        const card = openCard(u, ids);
        return { card, results: answer(u, card.id, card.items.map((x) => x.n)) } as never;
      },
    },
    tap };
  const world: World = {
    userId: U, accounts, posts, deps, phone, sessions: S.store, clock, listId: null,
    async setList(refs) { if (world.listId) await store.rememberList(U, world.listId, refs); },
    async prepare(i, kind) {
      const p = posts[i];
      if (!canPrepare(p) || apps.has(p.jobId)) return;
      const payload = payloadOf(p, kind, p.hashes.length + 1, clock.now, U);
      const hash = await sha(canonical(payload));
      for (const old of preps.get(p.jobId) ?? []) if (old.state === "ready" || old.state === "shown") old.state = "expired";
      preps.set(p.jobId, [...(preps.get(p.jobId) ?? []), { id: `33333333-3333-4333-8333-${String(s.id * 1000 + ++pidN).padStart(12, "0")}`, payload, hash, state: "ready" }]);
      p.hashes.push(hash);
    },
    async mutate(op, i, r) {
      const p = posts[i % posts.length];
      if (op === "close") { if (p.row) p.row.closed_at = new Date(clock.now - 60_000).toISOString(); }
      else if (op === "reprepare") await world.prepare(i % posts.length, p.spec.prep && p.spec.prep !== "secret" ? p.spec.prep : "plain");
      else if (op === "unprepare") { const c = cur(p.jobId); if (c) c.state = "expired"; }
      else if (op === "elsewhere") { if (!apps.has(p.jobId)) apps.set(p.jobId, { state: ["queued", "driving", "submitted_unconfirmed", "failed"][Math.floor(r() * 4)], url: p.url }); }
    },
    async addPosting() {
      const n = posts.length + 1 + 100 * ++extra;
      const spec: PostingSpec = { n, company: "latin", title: "latin", desc: "plain", url: "greenhouse", logo: "none", hasRow: true, closed: false, deadlinePast: false, prep: "plain", app: null, wanted: false };
      const p = await postOf(spec, U, s.id % 1000, clock.now);
      posts.push(p);
      await store.remember(U, p.ref, p.job, "text");
      await world.prepare(posts.length - 1, "plain");
      return posts.length - 1;
    },
    async truth() {
      const list = (world.listId ? await store.recallList(U, world.listId) : null) ?? [];
      const prep = new Map<string, Truth["prep"] extends Map<string, infer X> ? X : never>(), app = new Map<string, string | null>(), want = new Map<string, boolean>(), closed = new Map<string, boolean>();
      for (const p of posts) {
        const c = cur(p.jobId);
        const fields = (c?.payload.fields ?? []) as { type?: string }[];
        prep.set(p.jobId, c ? { hash: c.hash, secret: fields.some((f) => f.type === "password"), dest: typeof c.payload.destination === "string" ? c.payload.destination : null } : null);
        const a = apps.get(p.jobId) ?? [...apps.values()].find((x) => x.url === p.url);
        app.set(p.jobId, a?.state ?? null);
        const k = keyOf(p.job); want.set(p.jobId, !!k && wanted.has(k));
        closed.set(p.jobId, !!p.row?.closed_at);
      }
      return { list, prep, app, wanted: want, closed, approvals: new Map(approvals) };
    },
    async sessionRows() { return [...S.sessions.entries()].map(([h, r]) => ({ user_id: r.user_id, revoked: !!r.revoked_at, idHash: h })); },
    async vSession() { return await startSession(S.store, { userId: V, via: "phone", phone: accounts[V], telegramId: null, list: "ffffffffff", now: clock.now }); },
  };
  // The world before the bot speaks: postings remembered as the cards would remember them, payloads prepared, applications on file.
  for (let i = 0; i < posts.length; i++) {
    const sp = posts[i].spec;
    if (sp.prep) await world.prepare(i, sp.prep);
    if (sp.app) apps.set(posts[i].jobId, { state: sp.app, url: posts[i].url });
    if (sp.wanted) { const k = keyOf(posts[i].job); if (k && canPrepare(posts[i])) wanted.add(k); }
  }
  return world;
}

// ---------------------------------------------------------------- a browser per device: a cookie jar, the last page it drew
interface Browser { jar: Map<string, string>; page: string | null; planted: string | null }
const newBrowser = (): Browser => ({ jar: new Map(), page: null, planted: null });
const cookieHeader = (b: Browser) => [...b.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
function takeCookies(b: Browser, r: Response) {
  for (const c of r.headers.getSetCookie()) {
    const [kv] = c.split(";"); const [k, ...v] = kv.split("="); const val = v.join("=");
    if (/Max-Age=0/i.test(c) || !val) b.jar.delete(k.trim()); else b.jar.set(k.trim(), val);
  }
}
export interface Report { scenarios: number; requests: number; failures: string[]; counts: Record<string, number>; byKind: Record<string, number> }
export const newReport = (): Report => ({ scenarios: 0, requests: 0, failures: [], counts: {}, byKind: {} });
const bump = (rep: Report, k: string, n = 1) => { rep.counts[k] = (rep.counts[k] ?? 0) + n; };

const SCRIPT_HASHES = new Map<string, string>();
async function scriptHash(body: string) { let h = SCRIPT_HASHES.get(body); if (!h) { h = `'sha256-${b64(await sha(body))}'`; SCRIPT_HASHES.set(body, h); } return h; }

// ---------------------------------------------------------------- the checks every response gets
async function checkResponse(rep: Report, where: string, res: Response, body: string, o: { privateOk: boolean; posts: Post[] }) {
  const fail = (m: string, x = "") => rep.failures.push(`${where}: ${m}${x ? ` | ${x.slice(0, 220)}` : ""}`);
  const h = res.headers;
  const csp = h.get("content-security-policy") ?? "";
  if (!csp) fail("no content-security-policy");
  else {
    const fa = /frame-ancestors ([^;]+)/.exec(csp)?.[1]?.trim() ?? "";
    if (!fa || /(^|\s)\*(\s|$)|https:(\s|$)|'self' \*/.test(fa) || fa.split(/\s+/).some((x) => !/^https:\/\/(\*\.)?(web\.)?telegram\.org$/.test(x))) fail("frame-ancestors is not Telegram only", fa);
    const ss = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
    if (/unsafe-inline|unsafe-eval|(^|\s)\*|(^|\s)https:(\s|$)|data:/.test(ss)) fail("script-src allows more than hashed scripts", ss);
    if (!/default-src 'none'/.test(csp) || !/base-uri 'none'/.test(csp) || !/form-action 'self'/.test(csp)) fail("CSP lost default-src/base-uri/form-action", csp);
    for (const m of (/text\/html/.test(h.get("content-type") ?? "") ? body : "").matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      const tag = m[0].slice(0, m[0].indexOf(">") + 1);
      if (/\ssrc=/.test(tag)) { if (!/src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"/.test(tag)) fail("a script from somewhere else", tag); continue; }
      if (!ss.includes(await scriptHash(m[1]))) fail("an inline script whose hash the CSP does not allow", m[1].slice(0, 60));
    }
  }
  if (h.get("x-content-type-options") !== "nosniff") fail("no nosniff");
  if (!/no-store/.test(h.get("cache-control") ?? "")) fail("cacheable");
  if (h.get("referrer-policy") !== "same-origin") fail("referrer leaks"); // same-origin since the web-security round: nothing to another site
  for (const c of h.getSetCookie()) if (!/;\s*HttpOnly/i.test(c) || !/;\s*Secure/i.test(c) || !/;\s*SameSite=(Lax|Strict)/i.test(c) || !/;\s*Path=\//.test(c)) fail("a cookie without HttpOnly / Secure / SameSite / Path", c.replace(/=fs1\.[0-9a-f]+/, "=fs1.…").replace(/=v1\.[^;]+/, "=v1.…"));
  const loc = h.get("location");
  if (loc !== null && !/^\/(?![\/\\])/.test(loc)) fail("a redirect that leaves this host's own path", loc);
  if (/text\/html/.test(h.get("content-type") ?? "")) {
    const tags = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
    if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(tags)) fail("an event handler attribute", /<[a-z][^>]*\son[a-z]+\s*=[^>]*>/i.exec(tags)?.[0] ?? "");
    for (const t of tags.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) if (!ALLOWED_TAGS.has(t[1].toLowerCase())) { fail("a foreign tag", t[0]); break; }
    for (const m of body.matchAll(/(?:href|src|action|content)="([^"]*)"/g)) { const v = unesc(m[1]).trim(); if (/^(javascript|vbscript|data):/i.test(v) && !/^data:image\/svg\+xml,/.test(v)) fail("a javascript:/data: link", v); }
  }
  if (LONE.test(body)) fail("half of a character (a lone surrogate) in the page", JSON.stringify(body.match(new RegExp(`.{0,20}(${LONE.source}).{0,5}`))?.[0] ?? ""));
  if (/[‪-‮⁦-⁩]/.test(body)) fail("a bidi control reached the page");
  if (saysApplied(textOf(body))) fail('"applied" said before a submit record', textOf(body).match(/.{0,60}\bapplied\b.{0,30}/i)?.[0] ?? "");
  if (!o.privateOk) {
    if (/class="row"/.test(body)) fail("rows without a valid session");
    for (const p of o.posts) {
      if (body.includes(p.ref)) { fail("a ref without a valid session", p.ref); break; }
      const t = escH(p.job.title);
      if (t.length >= 10 && body.includes(t)) { fail("a title without a valid session", t); break; }
    }
  }
}
const ALLOWED_TAGS = new Set(["html", "head", "body", "meta", "link", "title", "style", "script", "div", "header", "main", "footer", "h1", "p", "a", "ul", "li", "span", "img", "form", "input", "button", "details", "summary", "strong", "svg", "rect", "text", "label", "noscript"]);

// ---------------------------------------------------------------- what a feed page must show, from the world's truth
interface Drawn { refs: string[]; forms: Map<string, string>; set: string | null; html: string }
function readFeed(html: string): Drawn {
  const refs = [...html.matchAll(/<li class="row" id="r-([0-9a-f]{12})">/g)].map((m) => m[1]);
  const forms = new Map<string, string>();
  for (const m of html.matchAll(/name="ref" value="([0-9a-f]{12})"><input type="hidden" name="tag" value="([0-9a-f]{16}|none)">/g)) forms.set(m[1], m[2]);
  return { refs, forms, set: /name="set" value="([0-9a-f]+)"/.exec(html)?.[1] ?? null, html };
}
interface Expect { chip: string | null; form: string | null; byHand: boolean; approvable: boolean }
// The posting's own deadline, from its stored row or the search result the card carried.
const pastDeadline = (p: Post, now: number) => { const d = Date.parse(String(p.row?.deadline ?? p.job.deadline ?? "")); return !Number.isNaN(d) && d < now; };
export function approvableNow(p: Post, T: Truth, now: number): boolean {
  const pr = T.prep.get(p.jobId);
  if (T.app.get(p.jobId) || !pr || pr.secret) return false;
  if (BYHAND.test(hostOf(p.url)) || !/^https?:\/\//.test(p.url)) return false;
  if (pr.dest !== null && (!/^https?:\/\/\S+$/i.test(pr.dest) || BYHAND.test(hostOf(pr.dest)))) return false;
  if (!p.row || T.closed.get(p.jobId) || pastDeadline(p, now)) return false;
  return true;
}
function expectRow(p: Post, T: Truth, now: number): Expect {
  const a = T.app.get(p.jobId), pr = T.prep.get(p.jobId);
  const byHandUrl = BYHAND.test(hostOf(p.url));
  const chip = a ? APP_WORD[a] ?? "Unknown" : pr?.secret ? "Needs you" : !pr && T.wanted.get(p.jobId) ? "Preparing" : null;
  if (chip || byHandUrl) return { chip, form: null, byHand: !chip && byHandUrl, approvable: false };
  const ok = approvableNow(p, T, now);
  const screenOk = !!p.row && !T.closed.get(p.jobId) && !pastDeadline(p, now);
  return { chip: null, form: ok ? hashTag(pr!.hash) : !pr && screenOk ? "none" : null, byHand: false, approvable: ok };
}
function checkFeed(rep: Report, where: string, html: string, w: World, T: Truth) {
  const fail = (m: string, x = "") => rep.failures.push(`${where}: ${m}${x ? ` | ${x.slice(0, 220)}` : ""}`);
  const d = readFeed(html);
  const shown = T.list.slice(0, 30);
  if (d.refs.join(",") !== shown.join(",")) { fail("the rows are not the list's first 30, in order", `${d.refs.length} vs ${shown.length}`); return; }
  const more = /Showing the first (\d+) of (\d+)\./.exec(html);
  if (T.list.length > 30 ? !more || Number(more[1]) !== 30 || Number(more[2]) !== T.list.length : !!more) fail("the page does not say it shows the first 30 of a longer list (or says it of a short one)", more?.[0] ?? `none for ${T.list.length}`);
  if (!/<p id="live" class="sr" role="status" aria-live="polite"><\/p>/.test(html)) fail("no live region for what changes");
  for (const ref of shown) {
    const p = w.posts.find((x) => x.ref === ref)!;
    const e = expectRow(p, T, w.clock.now);
    const li = new RegExp(`<li class="row" id="r-${ref}">([\\s\\S]*?)</li>\\n?(?=<li class="row"|</ul></main>)`).exec(html)?.[1] ?? "";
    const id = `#${p.n}`;
    if (!li.includes(`<span class="lettermark" aria-hidden="true">${escH(initialOf(p.job.company))}</span>`)) fail("lettermark is not the company's first whole character", `${id} ${JSON.stringify(/lettermark" aria-hidden="true">([^<]*)</.exec(li)?.[1])} vs ${JSON.stringify(initialOf(p.job.company))}`);
    if (!li.includes(`<span class="name">${escH(p.job.company)}</span>`)) fail("company not shown whole and escaped", id);
    if (!li.includes(`<span class="role">${escH(p.job.title)}</span>`)) fail("title not shown whole and escaped", id);
    for (const img of li.matchAll(/<img src="([^"]*)"/g)) { const u = unesc(img[1]); const want = w.deps.env.get("TRAINEE_LOGO_URL") ? "https://logos.example" : "https://www.google.com"; if (!u.startsWith(`${want}/`)) fail("a logo from somewhere other than the configured provider", u); }
    if (p.spec.logo === "hostile" && /<img /.test(li)) fail("a logo for a hostile domain", id);
    const chip = /<span class="chip [a-z-]+" role="status">([^<]*)<\/span>/.exec(li)?.[1] ?? null;
    if (chip !== e.chip) fail("status chip is not the posting's truth", `${id} ${chip} vs ${e.chip}`);
    const form = d.forms.get(ref) ?? null;
    if (form !== e.form) fail("Apply form is not the row's truth", `${id} ${form} vs ${e.form} (app ${T.app.get(p.jobId)} prep ${JSON.stringify(T.prep.get(p.jobId))} closed ${T.closed.get(p.jobId)} row ${!!p.row}; the row says: ${textOf([...li.matchAll(/<p class="note">([\s\S]*?)<\/p>/g)].map((x) => x[1]).join(" ")).slice(0, 160)})`);
    if (form) {
      const label = /<button type="submit" class="apply" aria-label="([^"]*)">Apply<\/button>/.exec(li)?.[1] ?? "";
      if (label !== `Apply to ${escH(p.job.title)} at ${escH(p.job.company)}`) fail("Apply does not name its role and company", `${id} ${label.slice(0, 80)}`);
    }
    const there = /<a class="apply" href="([^"]*)"[^>]*aria-label="([^"]*)">Apply there<\/a>/.exec(li);
    if (e.byHand !== !!there) fail("LinkedIn / Indeed / Handshake: not a link out (or a link out elsewhere)", id);
    if (there && !there[2].includes(escH(p.job.company))) fail("Apply there does not name the company", id);
  }
}

// ---------------------------------------------------------------- run one scenario
export async function runScenario(s: Scenario, w: World, rep: Report, o: { pg?: boolean } = {}) {
  rep.scenarios++; rep.byKind[s.kind] = (rep.byKind[s.kind] ?? 0) + 1;
  const where = (k: number, st: Step) => `#${s.id} ${s.kind} step ${k + 1} ${st.k}${o.pg ? " (pg)" : ""}`;
  const fail = (wh: string, m: string, x = "") => rep.failures.push(`${wh}: ${m}${x ? ` | ${x.slice(0, 260)}` : ""}`);
  const B: [Browser, Browser] = [newBrowser(), newBrowser()];
  const lastShown = new Map<string, string>(); // Telegram: the Confirm tag last shown for a ref
  const accounts = w.accounts;
  const tgSaid: string[] = [];
  const tgSender: JobSender = { photo: async () => ({ ok: false }), text: async (a) => { tgSaid.push(a.text); for (const row of a.buttons ?? []) for (const b of row) { const m = /^jcy:([0-9a-f]{12}):([0-9a-f]{16})$/.exec(String((b as { data?: string }).data ?? "")); if (m) lastShown.set(m[1], m[2]); } return { ok: true, id: null }; } };
  const jd = (): JobDeps => ({ ...w.deps, feedLinks: (userId, listId) => feedUrlsFor(w.deps.env, userId, listId, w.clock.now) }) as JobDeps;
  let link: string | null = null;
  let drawnTruth: Truth | null = null; // the world when device 0 last drew the list (Apply to all's set)
  const draws: [Truth | null, Truth | null] = [null, null];
  let jtiTexts = new Map<string, number>(); void jtiTexts;
  const signIns = { links: 0, own: 0 };
  const req = async (wh: string, dev: number, r: { get?: string; form?: Record<string, string>; noCookie?: boolean; ua?: string; path?: string }, privateOk: boolean): Promise<{ res: Response; body: string }> => {
    const b = B[dev];
    const path = r.path ?? "/file";
    const headers: Record<string, string> = r.noCookie ? {} : { cookie: cookieHeader(b) };
    if (r.ua) headers["user-agent"] = r.ua;
    const init: RequestInit = r.form ? { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(r.form).toString() } : { headers };
    const res = await handleFile(new Request(`https://trainee.example${path}${r.get ?? ""}`, init), w.deps);
    const body = await res.text();
    rep.requests++;
    takeCookies(b, res);
    await checkResponse(rep, wh, res, body, { privateOk, posts: w.posts });
    return { res, body };
  };
  const follow = async (wh: string, dev: number, res: Response, privateOk: boolean) => {
    if (res.status !== 303) return null;
    return await req(wh, dev, { path: res.headers.get("location") ?? "/file" }, privateOk);
  };
  const valid = async (dev: number): Promise<boolean> => {
    const sid = B[dev].jar.get("tf_s");
    if (!sid) return false;
    const row = await w.sessions.session(await sha256(sid)).catch(() => null);
    return !!row && row.user_id === w.userId && !row.revoked_at && w.clock.now < Date.parse(row.expires_at) && accounts?.[w.userId] === row.phone;
  };
  const view = async (wh: string, dev: number, text = false) => {
    const ok = await valid(dev);
    const { res, body } = await req(wh, dev, { get: text ? "?format=text" : "" }, ok);
    if (!ok) { if (res.status < 400 && /class="row"/.test(body)) fail(wh, "a list without a valid session"); return null; }
    if (res.status !== 200) { fail(wh, "a valid session could not open its list", `${res.status} ${textOf(body).slice(0, 120)}`); return null; }
    const T = await w.truth();
    if (text) {
      if (!/^text\/plain/.test(res.headers.get("content-type") ?? "")) fail(wh, "the plain-text twin is not text/plain");
      for (const [i, ref] of T.list.slice(0, 30).entries()) { const p = w.posts.find((x) => x.ref === ref)!; if (!body.includes(`${i + 1}. ${p.job.company.replace(/[‪-‮⁦-⁩]/g, "")} - ${p.job.title.replace(/[‪-‮⁦-⁩]/g, "")}`)) { fail(wh, "plain text: a row missing or altered", `#${p.n}`); break; } }
      if ((T.list.length > 30) !== /Showing the first 30 of/.test(body)) fail(wh, "plain text: the first 30 of a longer list is not said");
      return null;
    }
    checkFeed(rep, wh, body, w, T);
    B[dev].page = body; draws[dev] = T; if (dev === 0) drawnTruth = T;
    bump(rep, "views");
    return body;
  };

  for (let k = 0; k < s.steps.length; k++) {
    const st = s.steps[k], wh = where(k, st);
    const before = await w.truth();
    let expectApprove = new Set<string>(); // job ids this step should approve
    let allowWant = false;
    switch (st.k) {
      case "cards": {
        const hits = w.posts.map((p) => ({ job_id: p.jobId, company: p.job.company, title: p.job.title, url: p.url, company_domain: p.job.company_domain, fit: { reasons: p.job.reasons } }));
        tgSaid.length = 0;
        let listId: string | null = null;
        const store = w.deps.store;
        const spy = { ...store, rememberList: async (u: string, id: string, refs: string[]) => { listId = id; await store.rememberList(u, id, refs); } };
        const r = await sendJobCards({ userId: w.userId, hits, deps: { ...jd(), store: spy } as JobDeps, send: tgSender });
        w.listId = listId ?? "abcdefabcd";
        // Postings whose link is not a web address never reach the bot's list (sendJobCards drops them); a stored list may still
        // hold one (an older card), so the page's handling of a javascript: / data: link is exercised too.
        const all = w.posts.map((p) => p.ref);
        for (const p of w.posts) await store.remember(w.userId, p.ref, p.job, "text");
        await w.setList(all);
        const httpCount = w.posts.filter((p) => /^https?:\/\//.test(p.url)).length;
        if (httpCount > 3) {
          const line = tgSaid.find((t) => /jobs for you\./.test(t)) ?? "";
          if (!new RegExp(`^${httpCount} jobs for you\\.`).test(line)) fail(wh, "Telegram: the list message does not count the postings", line.slice(0, 80));
          if ((httpCount > 30) !== /The list shows the first 30\./.test(line)) fail(wh, "Telegram: a list longer than the page does not say the page shows the first 30", line.slice(0, 120));
          const m = /\?t=(v1\.[A-Za-z0-9_.-]+)/.exec(line);
          link = m ? m[1] : null;
          if (!link) fail(wh, "Telegram: no link to the list");
        } else {
          if (r.sent !== httpCount) fail(wh, "Telegram: not one card per posting", `${r.sent} of ${httpCount}`);
          link = (await feedUrlsFor(w.deps.env, w.userId, w.listId, w.clock.now)).url?.split("?t=")[1] ?? null; // "open the full list" sent later
        }
        for (const t of tgSaid) if (saysApplied(t)) fail(wh, 'Telegram said "applied"', t.slice(0, 100));
        bump(rep, "telegram lists");
        break;
      }
      case "open": {
        const b = B[st.dev];
        // The bot mints a fresh link each time it is asked ("open the list" again).
        const fresh = (await feedUrlsFor(w.deps.env, w.userId, w.listId ?? "abcdefabcd", w.clock.now)).url?.split("?t=")[1] ?? link;
        if (!fresh) { fail(wh, "no link to open"); break; }
        if (st.plant === "random") { b.planted = `fs1.${"7a".repeat(32)}`; b.jar.set("tf_s", b.planted); }
        if (st.plant === "other_account") { b.planted = await w.vSession(); b.jar.set("tf_s", b.planted); }
        signIns.links++;
        const path = st.path === "double_slash" ? "//evil.example/" : st.path === "backslash" ? "/\\evil.example/" : "/file";
        const r = await req(wh, st.dev, { path, get: `?t=${encodeURIComponent(fresh)}`, ua: st.crawler ? "TelegramBot (like TwitterBot)" : undefined }, false);
        if (st.crawler) { if (r.res.status !== 200 || r.res.headers.getSetCookie().length) fail(wh, "a crawler preview touched the link or set a cookie"); break; }
        if (st.plant === "other_account") {
          if (r.res.status !== 403) { fail(wh, "another account's planted session did not stop the link", String(r.res.status)); break; }
          // The person signs out of the other account from that page, then opens the link again.
          const t = /name="t" value="(fs1\.[0-9a-f]{64})"><input type="hidden" name="action" value="signout"/.exec(r.body)?.[1];
          if (t !== b.planted) { fail(wh, "the different-account page offers no sign out of that session"); break; }
          await req(wh, st.dev, { form: { t, action: "signout" } }, false);
          const again = await req(wh, st.dev, { path, get: `?t=${encodeURIComponent(fresh)}` }, false);
          await follow(wh, st.dev, again.res, false);
          break;
        }
        if (r.res.status !== 303) { fail(wh, "a fresh link did not open the sign-in", `${r.res.status}`); break; }
        await follow(wh, st.dev, r.res, await valid(st.dev));
        break;
      }
      case "phone": {
        const before = w.phone.texts.length;
        const number = st.who === "own" ? accounts![w.userId]! : st.who === "stranger" ? "+14155550123" : "call me maybe";
        await req(wh, st.dev, { form: { action: "phone_start", phone: number } }, false);
        const sent = w.phone.texts.length - before;
        if (st.who !== "own" && sent) fail(wh, "a text to a number that is not the account's");
        if (st.who === "own") { signIns.own++; bump(rep, "codes texted", sent); }
        if (w.phone.texts.slice(before).some((t) => t.phone !== accounts![w.userId])) fail(wh, "a code texted to another number");
        break;
      }
      case "code": {
        const b = B[st.dev];
        const planted = b.planted;
        const code = st.right ? w.phone.lastCode() : "000000";
        const had = b.jar.get("tf_s");
        const r = await req(wh, st.dev, { form: { action: "phone_verify", code } }, false);
        const sid = b.jar.get("tf_s");
        if (r.res.status === 303 && sid && sid !== had) {
          bump(rep, "phone sign-ins");
          if (planted && sid === planted) fail(wh, "session fixation: the planted session id survived the sign-in");
          const row = await w.sessions.session(await sha256(sid));
          if (!row || row.user_id !== w.userId || row.via !== "phone" || row.phone !== accounts![w.userId]) fail(wh, "the session is not bound to the account's phone");
          if (planted) {
            const p = await req(wh, st.dev, { noCookie: true, form: { t: planted, action: "refresh" } }, false);
            if (p.res.status < 400) fail(wh, "the planted session id opens the account after the sign-in");
            bump(rep, "fixation checked");
          }
          await follow(wh, st.dev, r.res, true);
        } else if (st.right && r.res.status !== 303 && r.res.status !== 410 && r.res.status !== 403 && r.res.status !== 429) fail(wh, "the right code did not sign in", `${r.res.status} ${textOf(r.body).slice(0, 100)}`);
        if (!st.right && r.res.status === 303) fail(wh, "a wrong code signed in");
        break;
      }
      case "view": await view(wh, st.dev, !!st.text); break;
      case "apply": {
        const b = B[st.dev];
        const T0w = await w.truth();
        const ref = T0w.list[st.row % Math.max(1, T0w.list.length)];
        if (!ref) break;
        const drawn = b.page ? readFeed(b.page) : null;
        const shownTag = drawn?.forms.get(ref) ?? null;
        const p = w.posts.find((x) => x.ref === ref)!;
        let tag: string;
        if (st.tag === "shown") { if (!shownTag) { bump(rep, "apply skipped: no Apply drawn"); break; } tag = shownTag; }
        else if (st.tag === "stale") tag = p.hashes.length > 1 ? hashTag(p.hashes[p.hashes.length - 2]) : "0123456789abcdef";
        else if (st.tag === "forged") tag = (await sha(`${s.id}|${k}`)).slice(0, 16);
        else tag = "none";
        const t = b.jar.get("tf_s") ?? /name="t" value="([^"]*)"/.exec(b.page ?? "")?.[1] ?? "";
        const ok = await valid(st.dev);
        const idx = T0w.list.indexOf(ref);
        if (ok && idx < 30 && tag !== "none" && approvableNow(p, T0w, w.clock.now) && tag === hashTag(T0w.prep.get(p.jobId)!.hash)) expectApprove = new Set([p.jobId]);
        allowWant = ok && tag === "none";
        // The plain form posts its own hidden inputs; with script on (and the form drawn), the page's own script flips the list in
        // place (scenarios/file-journey-r2-dom.ts runs FEED_SCRIPT unchanged): one request either way, the same answer drawn.
        let r: { res: Response; body: string };
        const viaScript = st.js && !!b.page && shownTag === tag;
        if (viaScript) {
          const answers: { res: Response; body: string }[] = [];
          const page = new Page("https://trainee.example/file", b.page!, async (body) => { const x = await req(wh, st.dev, { form: Object.fromEntries(new URLSearchParams(body)) }, ok); answers.push(x); return x.body; });
          page.run();
          const f = page.html.getElementById(`r-${ref}`)?.all().find((n) => n.tag === "form" && n.classList.contains("ajax")) ?? null;
          if (!f) { fail(wh, "the drawn Apply form is not in the page"); break; }
          await page.tap(f);
          if (page.requests !== 1 || answers.length !== 1) fail(wh, "the script path did not make exactly one request (the plain form makes one)", `${page.requests} requests`);
          if (!answers.length) break;
          r = answers[0];
          const root = page.html.getElementById("root");
          if (root && /id="root"/.test(r.body)) {
            const want = new Page("https://trainee.example/file", r.body, async () => "").html.getElementById("root")!.innerHTML;
            if (root.innerHTML !== want) fail(wh, "the script drew something other than the server's answer");
            const row = page.html.getElementById(`r-${ref}`), top = root.querySelector(".top-note");
            const a = page.active;
            const where = !a ? "nowhere" : a.closest("li.row")?.id ? `row ${a.closest("li.row")!.id}` : a.matches(".top-note") ? "top note" : a.tag ?? "?";
            if (!a || (row ? !(a.closest("li.row") === row || (top && a === top)) : !(a.tag === "h1" || a === top))) fail(wh, "focus was lost after the in-place update", where);
            const live = page.html.getElementById("live")?.textContent ?? null;
            const said = (top ? top.textContent : (row?.querySelector(".note") ?? row?.querySelector(".chip"))?.textContent ?? "").replace(/\s+/g, " ").trim();
            if (live === null || (said && live !== said)) fail(wh, "the change was not announced in the live region", `${JSON.stringify(live)} vs ${JSON.stringify(said.slice(0, 80))}`);
            bump(rep, "script flips checked");
          } else if (!/id="root"/.test(r.body)) {
            // Not the list (signed out, an error): shown as it came, never posted again.
            if (page.title !== (/<title>([^<]*)<\/title>/.exec(r.body)?.[1] ?? "").replace(/&#39;/g, "'").replace(/&amp;/g, "&")) fail(wh, "the script did not show the answer that is not the list", page.title);
            bump(rep, "script non-list answers checked");
          }
        } else r = await req(wh, st.dev, { form: { t, action: "apply", ref, tag } }, ok);
        if (!ok) {
          if (r.res.status < 400) fail(wh, "an Apply on an ended session was answered as if signed in", String(r.res.status));
          if (!/Nothing was approved or sent from this tap/.test(textOf(r.body))) fail(wh, "an Apply on an ended session does not say nothing was approved", textOf(r.body).slice(0, 160));
          bump(rep, "apply on an ended session");
          break;
        }
        if (r.res.status !== 200) { if (!(idx >= 30 && r.res.status === 404)) fail(wh, "an Apply was not answered with the list", `${r.res.status} ${textOf(r.body).slice(0, 120)}`); break; }
        const after = await w.truth();
        checkFeed(rep, wh, r.body, w, after);
        b.page = r.body; draws[st.dev] = after; if (st.dev === 0) drawnTruth = after;
        const li = new RegExp(`<li class="row" id="r-${ref}">([\\s\\S]*?)</li>\\n?(?=<li class="row"|</ul></main>)`).exec(r.body)?.[1] ?? "";
        const note = textOf([...li.matchAll(/<p class="note">([\s\S]*?)<\/p>/g)].map((x) => x[1]).join(" "));
        if (expectApprove.size) { bump(rep, `apply ${st.js ? "(script)" : "(plain form)"} approved`); if (/Changed since|nothing was approved/i.test(note)) fail(wh, "an approved Apply says it was not", note); }
        else if (T0w.app.get(p.jobId) && tag !== "none" && !/Already in your applications/.test(note)) fail(wh, "an Apply on a posting already in the applications does not say so", note || "(no note)");
        else if (!T0w.app.get(p.jobId) && approvableNow(p, T0w, w.clock.now) && tag !== "none" && !/Changed since you opened this page/.test(note)) fail(wh, "a stale or forged tag does not say it changed", note || "(no note)");
        if (tag !== "none") bump(rep, `apply tag ${st.tag}`);
        break;
      }
      case "applyall": {
        const b = B[st.dev];
        const set = b.page ? readFeed(b.page).set : null;
        if (!set) { bump(rep, "applyall skipped: none drawn"); break; }
        const ok = await valid(st.dev);
        const T1 = await w.truth(), D = draws[st.dev];
        const setOf = (T: Truth) => T.list.slice(0, 30).map((ref) => w.posts.find((x) => x.ref === ref)!).filter((p) => approvableNow(p, T, w.clock.now)).map((p) => `${p.ref}:${hashTag(T.prep.get(p.jobId)!.hash)}`).join(",");
        // The page dedups the same posting twice; none are generated, so the approvable set is the set.
        if (ok && D && setOf(D) === setOf(T1) && setOf(T1)) expectApprove = new Set(T1.list.slice(0, 30).map((ref) => w.posts.find((x) => x.ref === ref)!).filter((p) => approvableNow(p, T1, w.clock.now)).map((p) => p.jobId));
        const t = b.jar.get("tf_s") ?? "";
        const r = await req(wh, st.dev, { form: { t, action: "applyall", set } }, ok);
        if (!ok) { if (!/Nothing was approved or sent from this tap/.test(textOf(r.body))) fail(wh, "an Apply to all on an ended session does not say nothing was approved"); break; }
        if (r.res.status === 200) { const after = await w.truth(); checkFeed(rep, wh, r.body, w, after); b.page = r.body; draws[st.dev] = after; }
        if (expectApprove.size) bump(rep, "apply to all approved"); else bump(rep, "apply to all refused (set changed)");
        if (!expectApprove.size && ok && !/This list changed since you opened it, so nothing was approved/.test(r.body)) fail(wh, "a changed set did not say nothing was approved");
        break;
      }
      case "tg_apply": {
        const ref = before.list[st.row % Math.max(1, before.list.length)];
        if (!ref) break;
        tgSaid.length = 0;
        const res = await tapJob({ userId: w.userId, data: `jca:${ref}`, messageId: null, deps: jd(), send: tgSender });
        for (const t of [res.toast, ...tgSaid]) if (saysApplied(t)) fail(wh, 'Telegram said "applied"', t.slice(0, 100));
        const p = w.posts.find((x) => x.ref === ref)!;
        if (res.status === "shown" && lastShown.get(ref) !== hashTag(before.prep.get(p.jobId)?.hash ?? "")) fail(wh, "Telegram showed a Confirm for a payload that is not the current one");
        if (res.status === "queued_unprepared") allowWant = true;
        bump(rep, `telegram apply ${res.status}`);
        break;
      }
      case "tg_confirm": {
        const ref = before.list[st.row % Math.max(1, before.list.length)];
        if (!ref) break;
        const p = w.posts.find((x) => x.ref === ref)!;
        const tag = lastShown.get(ref) ?? "fedcba9876543210";
        if (approvableNow(p, before, w.clock.now) && tag === hashTag(before.prep.get(p.jobId)!.hash)) expectApprove = new Set([p.jobId]);
        tgSaid.length = 0;
        const res = await tapJob({ userId: w.userId, data: `jcy:${ref}:${tag}`, messageId: null, deps: jd(), send: tgSender });
        for (const t of [res.toast, ...tgSaid]) if (saysApplied(t)) fail(wh, 'Telegram said "applied"', t.slice(0, 100));
        if (before.app.get(p.jobId) && !(res.status === "duplicate" && !saysApplied(res.toast) && /in your applications/.test(tgSaid.join(" ")))) fail(wh, "Telegram's Confirm on a posting already approved (on the page) does not say it is already in the applications", `${res.status} ${res.toast} ${tgSaid.join(" ").slice(0, 100)}`);
        bump(rep, `telegram confirm ${res.status}`);
        break;
      }
      case "world": {
        if (st.op === "new_posting") { const i = await w.addPosting(); await w.setList([...(await w.truth()).list, w.posts[i].ref]); }
        else await w.mutate(st.op, st.row, (() => { let x = s.id * 7 + k; return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648); })());
        bump(rep, `world ${st.op}`);
        break;
      }
      case "clock": w.clock.now += st.ms; bump(rep, st.ms >= SESSION_TTL_MS ? "clock past expiry" : "clock before expiry"); break;
      case "phone_change": if (accounts) accounts[w.userId] = "+15125550111"; bump(rep, "phone changed"); break;
      case "signout": {
        const t = B[st.dev].jar.get("tf_s") ?? "";
        const ok = await valid(st.dev);
        const r = await req(wh, st.dev, { form: { t, action: st.all ? "signout_all" : "signout" } }, false);
        if (ok && r.res.status !== 200) fail(wh, "sign out failed", String(r.res.status));
        const rows = await w.sessionRows();
        if (ok && st.all && rows.some((x) => x.user_id === w.userId && !x.revoked)) fail(wh, "sign out everywhere left a session open");
        if (ok && !st.all && t && !rows.find((x) => x.user_id === w.userId && x.revoked)) fail(wh, "sign out did not end this session");
        bump(rep, st.all ? "signout everywhere" : "signout here");
        break;
      }
      case "csrf": {
        // A cross-site form posts with the browser's cookie (SameSite=Lax keeps it off a cross-site POST in a real browser; this is
        // the worse case where it rides along) but never the session's own value, which only the page itself holds.
        const ref = before.list[st.row % Math.max(1, before.list.length)];
        if (!ref) break;
        const p = w.posts.find((x) => x.ref === ref)!;
        const tag = before.prep.get(p.jobId) ? hashTag(before.prep.get(p.jobId)!.hash) : "none";
        const r = await req(wh, st.dev, { form: { action: "apply", ref, tag } }, false);
        if (r.res.status < 400) fail(wh, "a cross-site form without the session's value was answered", String(r.res.status));
        const r2 = await req(wh, st.dev, { form: { action: "signout_all" } }, false);
        if (r2.res.status < 400) fail(wh, "a cross-site sign-out was answered", String(r2.res.status));
        bump(rep, "csrf refused");
        break;
      }
      case "foreign": {
        const ref = before.list[st.row % Math.max(1, before.list.length)];
        if (!ref) break;
        const p = w.posts.find((x) => x.ref === ref)!;
        const tag = before.prep.get(p.jobId) ? hashTag(before.prep.get(p.jobId)!.hash) : "none";
        const vt = await w.vSession();
        const r = await req(wh, 1, { noCookie: true, form: { t: vt, action: "apply", ref, tag } }, false);
        if (r.res.status !== 404) fail(wh, "another account's session reached this account's row", String(r.res.status));
        bump(rep, "foreign session refused");
        break;
      }
      case "brute": {
        // Someone with a forwarded link: a stranger's number, then codes until the link locks.
        const texts = w.phone.texts.length;
        await req(wh, 1, { form: { action: "phone_start", phone: "+14155550123" } }, false);
        let locked = false;
        for (let i = 0; i < st.tries; i++) {
          const r = await req(wh, 1, { form: { action: "phone_verify", code: String(100000 + ((s.id * 31 + i) % 899999)) } }, false);
          if (r.res.status === 303) fail(wh, "a guessed code signed in");
          if (r.res.status === 429) locked = true;
          if (i >= MAX_CODE_TRIES && r.res.status !== 429) fail(wh, "codes past the cap were still checked", `${i + 1}: ${r.res.status}`);
        }
        if (st.tries > MAX_CODE_TRIES && !locked) fail(wh, "the link never locked");
        if (w.phone.texts.length !== texts) fail(wh, "a stranger's number caused a text");
        bump(rep, "brute tries", st.tries);
        break;
      }
    }
    // Every step: what changed in the world is exactly what the step was allowed to change.
    const after = await w.truth();
    for (const p of w.posts) {
      const a = before.approvals.get(p.jobId) ?? 0, b2 = after.approvals.get(p.jobId) ?? 0;
      if (b2 > 1) fail(wh, "a posting approved more than once", `#${p.n}`);
      if (b2 > a && !expectApprove.has(p.jobId)) fail(wh, "an approval the step did not allow", `#${p.n} (app ${before.app.get(p.jobId)} prep ${JSON.stringify(before.prep.get(p.jobId))})`);
      if (b2 === a && expectApprove.has(p.jobId)) fail(wh, "an allowed approval did not happen", `#${p.n} ${JSON.stringify(after.prep.get(p.jobId))} ${after.app.get(p.jobId)}`);
      if (!before.wanted.get(p.jobId) && after.wanted.get(p.jobId) && !allowWant) fail(wh, "queued to be prepared without an unprepared Apply", `#${p.n}`);
    }
    if (st.k === "phone" || st.k === "brute") {
      // Texts per link stay under the cap; every text went to the account's own phone.
      if (w.phone.texts.length > MAX_CODE_SENDS * Math.max(1, signIns.links)) fail(wh, "more texts than the per-link cap allows", `${w.phone.texts.length} for ${signIns.links} links`);
    }
  }
}

export function printReport(name: string, rep: Report): number {
  const counts = Object.entries(rep.counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`[file-journey-r2] ${name}: ${rep.scenarios} scenarios (${Object.entries(rep.byKind).map(([k, v]) => `${k} ${v}`).join(", ")}), ${rep.requests} requests; ${counts}; ${rep.failures.length} failures`);
  const seen = new Map<string, number>();
  // Grouped by what failed (not where): each kind of failure once, with its count and one example.
  const keyOf = (f: string) => f.replace(/^#\d+ [a-z_]+ step \d+ [a-z_]+(?: \(pg\))?: /, "").replace(/ \|.*$/, "");
  for (const f of rep.failures) seen.set(keyOf(f), (seen.get(keyOf(f)) ?? 0) + 1);
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${n}x ${k}  e.g. ${rep.failures.find((f) => keyOf(f) === k)}`);
  return rep.failures.length;
}

// ---------------------------------------------------------------- the scale runs (two parts for CI time; each scenario runs once)
export const JOURNEY_PARTS = 4;
export function journeyScale(part: number) {
  if (!Number.isInteger(part) || part < 1 || part > JOURNEY_PARTS) throw new Error(`no part ${part} of ${JOURNEY_PARTS}`);
  const per = Math.ceil(SCENARIOS.length / JOURNEY_PARTS), from = (part - 1) * per, to = Math.min(SCENARIOS.length, part * per);
  Deno.test({ name: `file journey r2 at scale, memory stores, part ${part}: scenarios ${from + 1}-${to} (every check after every request)`, sanitizeOps: false, sanitizeResources: false, async fn() {
    const only = Deno.env.get("FJ_ONLY"), first = Number(Deno.env.get("FJ_N") ?? 0);
    const picked = only ? SCENARIOS.filter((s) => only.split(",").includes(String(s.id))) : SCENARIOS.slice(from, first ? Math.min(to, from + first) : to);
    const rep = newReport();
    for (const s of picked) await runScenario(s, await memWorld(s), rep);
    const failed = printReport(`memory, part ${part}`, rep);
    if (!only && !first) {
      // Liveness: the journeys really reach what they are about.
      for (const [k, min] of [["phone sign-ins", 2000], ["apply (plain form) approved", 150], ["apply (script) approved", 150], ["apply to all approved", 40], ["apply to all refused (set changed)", 20],
        ["telegram confirm duplicate", 50], ["telegram confirm confirmed", 40], ["apply on an ended session", 150], ["csrf refused", 50], ["foreign session refused", 50], ["fixation checked", 30], ["world new_posting", 40]] as const) {
        if ((rep.counts[k] ?? 0) < min) throw new Error(`liveness: "${k}" reached only ${rep.counts[k] ?? 0} times (want ${min})`);
      }
    }
    eq(failed, 0, "every check held after every request");
  } });
  if (part === 1) {
    Deno.test(`file journey r2: all ${JOURNEY_PARTS} parts are test files, each registering its own part`, async () => {
      for (let k = 1; k <= JOURNEY_PARTS; k++) {
        const f = new URL(`./scenarios-file-journey-r2${k === 1 ? "" : `-${k}`}.test.ts`, import.meta.url);
        if (!new RegExp(`journeyScale\\(${k}\\)`).test(await Deno.readTextFile(f))) throw new Error(`${f.pathname} does not register part ${k}`);
      }
    });
  }
}
// ---------------------------------------------------------------- the regressions this round found (each was a failure above first)
const spec = (n: number, o: Partial<PostingSpec> = {}): PostingSpec => ({ n, company: "latin", title: "latin", desc: "plain", url: "greenhouse", logo: "none", hasRow: true, closed: false, deadlinePast: false, prep: "plain", app: null, wanted: false, ...o });
// A signed-in world: the bot's list for these postings, and a phone session on it (the way the code step opens one).
async function signedWorld(postings: PostingSpec[], id = 990_001) {
  const s: Scenario = { id, kind: "journey", postings, steps: [], logoTpl: "default" };
  const w = await memWorld(s);
  w.listId = "0a1b2c3d4e";
  for (const p of w.posts) await w.deps.store.remember(U, p.ref, p.job, "text");
  await w.setList(w.posts.map((p) => p.ref));
  const accounts = w.accounts;
  const sid = await startSession(w.sessions, { userId: U, via: "phone", phone: accounts[U], telegramId: null, list: w.listId, now: w.clock.now });
  const get = async (q = "") => await (await handleFile(new Request(`https://trainee.example/file${q}`, { headers: { cookie: `tf_s=${sid}` } }), w.deps)).text();
  const post = async (f: Record<string, string>) => { const r = await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { cookie: `tf_s=${sid}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), w.deps); return { status: r.status, body: await r.text() }; };
  return { w, sid, get, post, accounts };
}
const formTag = (html: string, ref: string) => new RegExp(`name="ref" value="${ref}"><input type="hidden" name="tag" value="([0-9a-f]{16}|none)">`).exec(html)?.[1] ?? null;
const noteOf = (html: string, ref: string) => textOf([...(new RegExp(`<li class="row" id="r-${ref}">([\\s\\S]*?)</li>\\n?(?=<li class="row"|</ul></main>)`).exec(html)?.[1] ?? "").matchAll(/<p class="note">([\s\S]*?)<\/p>/g)].map((x) => x[1]).join(" "));
const tg = () => { const said: string[] = []; const shown = new Map<string, string>(); const send: JobSender = { photo: async () => ({ ok: false }), text: async (a) => { said.push(a.text); for (const r of a.buttons ?? []) for (const b of r) { const m = /^jcy:([0-9a-f]{12}):([0-9a-f]{16})$/.exec(String((b as { data?: string }).data ?? "")); if (m) shown.set(m[1], m[2]); } return { ok: true, id: null }; } }; return { said, shown, send }; };

export function journeyRegressions() {
  Deno.test("regression: an emoji- or astral-first company gets its whole first character as the lettermark, and a short description cut at an emoji keeps it whole (was: half a surrogate pair, a replacement box)", async () => {
    const { w, get } = await signedWorld([spec(1, { company: "emoji", desc: "emoji_cut" }), spec(2, { company: "astral" }), spec(3, { company: "bidi" })]);
    const html = await get();
    assertNode.ok(!LONE.test(html), "no half character anywhere");
    assertNode.ok(html.includes(`<span class="lettermark" aria-hidden="true">🚀</span>`), "the rocket, whole");
    assertNode.ok(html.includes(`<span class="lettermark" aria-hidden="true">𝔉</span>`), "the astral letter, whole");
    assertNode.ok(html.includes(`<span class="lettermark" aria-hidden="true">E</span>`), "a bidi control before the name is not the lettermark");
    const desc = /<span class="desc">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
    assertNode.ok(/^a{148}(?:🚀)?…$/u.test(desc), `the cut keeps the emoji whole or leaves it out: ${JSON.stringify(desc.slice(-6))}`);
    void w;
  });
  Deno.test("regression: Telegram's Confirm on a posting the page already approved says it is already in the applications, and the toast never says 'applied' (was: toast 'Already applied.' for a queued application)", async () => {
    const { w, get, post } = await signedWorld([spec(1), spec(2)]);
    const p = w.posts[0], t = tg();
    await tapJob({ userId: U, data: `jca:${p.ref}`, messageId: null, deps: w.deps as JobDeps, send: t.send });
    const html = await get();
    eq((await post({ t: (await signedWorldSid(html)), action: "apply", ref: p.ref, tag: formTag(html, p.ref)! })).status, 200);
    const res = await tapJob({ userId: U, data: `jcy:${p.ref}:${t.shown.get(p.ref)}`, messageId: null, deps: w.deps as JobDeps, send: t.send });
    eq(res.status, "duplicate");
    assertNode.ok(!saysApplied(res.toast) && /in your applications/i.test(res.toast), res.toast);
    assertNode.ok(/already have .* in your applications/.test(t.said.at(-1)!), t.said.at(-1));
    eq((await w.truth()).approvals.get(p.jobId), 1);
  });
  Deno.test("regression: the page's Apply on a posting Telegram's Confirm already approved says it is already in the applications (was: the button silently became 'Queued', as if this tap had queued it)", async () => {
    const { w, get, post } = await signedWorld([spec(1), spec(2)]);
    const p = w.posts[0], t = tg();
    const html = await get();
    await tapJob({ userId: U, data: `jca:${p.ref}`, messageId: null, deps: w.deps as JobDeps, send: t.send });
    eq((await tapJob({ userId: U, data: `jcy:${p.ref}:${t.shown.get(p.ref)}`, messageId: null, deps: w.deps as JobDeps, send: t.send })).status, "confirmed");
    const r = await post({ t: await signedWorldSid(html), action: "apply", ref: p.ref, tag: formTag(html, p.ref)! });
    assertNode.ok(/^Already in your applications, so nothing more was sent\./.test(noteOf(r.body, p.ref)), noteOf(r.body, p.ref));
    eq((await w.truth()).approvals.get(p.jobId), 1);
  });
  Deno.test("regression: a redirect never names another host: '//evil.example/' and '/\\\\evil.example/' stay on this host's own path (was: Location //evil.example/)", async () => {
    const { w } = await signedWorld([spec(1)]);
    for (const path of ["//evil.example/", "/\\evil.example/", "///evil.example/x"]) {
      const l = (await feedUrlsFor(w.deps.env, U, "0a1b2c3d4e", w.clock.now)).url!.split("?t=")[1];
      const r = await handleFile(new Request(`https://trainee.example${path}?t=${l}`), w.deps);
      eq(r.status, 303);
      assertNode.ok(/^\/(?![\/\\])/.test(r.headers.get("location")!), r.headers.get("location")!);
    }
  });
  Deno.test("regression: an Apply or Apply to all that reaches an ended sign-in (expired, signed out on another device, phone changed) says nothing was approved or sent (was: only 'You were signed out')", async () => {
    for (const how of ["expired", "signed out elsewhere", "phone changed"] as const) {
      const { w, get, post, accounts, sid } = await signedWorld([spec(1), spec(2)]);
      const html = await get();
      if (how === "expired") w.clock.now += SESSION_TTL_MS;
      if (how === "signed out elsewhere") await w.sessions.revokeAll(U, w.clock.now);
      if (how === "phone changed") accounts[U] = "+15125550111";
      for (const f of [{ t: sid, action: "apply", ref: w.posts[0].ref, tag: formTag(html, w.posts[0].ref)! }, { t: sid, action: "applyall", set: /name="set" value="([0-9a-f]+)"/.exec(html)![1] }] as Record<string, string>[]) {
        const r = await post(f);
        eq(r.status, 401, how);
        assertNode.ok(/Nothing was approved or sent from this tap\./.test(textOf(r.body)), `${how}: ${textOf(r.body)}`);
      }
      eq((await w.truth()).approvals.size, 0);
    }
  });
  Deno.test("regression: 45 postings: Telegram says the list shows the first 30, the page says 'Showing the first 30 of 45', and a tap on row 36 says it is past the page (was: '45 jobs for you' opened 30 rows that never said so; row 36 'isn't on your list')", async () => {
    const s: Scenario = { id: 990_045, kind: "render", postings: Array.from({ length: 45 }, (_, i) => spec(i + 1)), steps: [], logoTpl: "default" };
    const w = await memWorld(s), t = tg();
    let listId = "";
    const store = w.deps.store;
    await sendJobCards({ userId: U, hits: w.posts.map((p) => ({ job_id: p.jobId, company: p.job.company, title: p.job.title, url: p.url })), deps: { ...w.deps, store: { ...store, rememberList: async (u: string, id: string, refs: string[]) => { listId = id; await store.rememberList(u, id, refs); } }, feedLinks: (u: string, l: string) => feedUrlsFor(w.deps.env, u, l, w.clock.now) } as JobDeps, send: t.send });
    assertNode.ok(/^45 jobs for you\. The list shows the first 30\. Open the list: https:/.test(t.said[0]), t.said[0]);
    w.listId = listId;
    const accounts = w.accounts;
    const sid = await startSession(w.sessions, { userId: U, via: "phone", phone: accounts[U], telegramId: null, list: listId, now: w.clock.now });
    const html = await (await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${sid}` } }), w.deps)).text();
    eq((html.match(/<li class="row"/g) ?? []).length, 30);
    assertNode.ok(html.includes("Showing the first 30 of 45. Ask Trainee in Telegram for the rest."));
    const r = await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: sid, action: "apply", ref: w.posts[35].ref, tag: "none" }).toString() }), w.deps);
    eq(r.status, 404);
    assertNode.ok(/past them\. Nothing was sent\./.test(textOf(await r.text())));
  });
  Deno.test("regression: a prepared application whose destination is javascript: or data: offers no Apply and Telegram's Confirm approves nothing (was: one-tap approvable, 'Sends to: javascript:alert(1)')", async () => {
    const { w, get, post, sid } = await signedWorld([spec(1, { prep: "bad_dest" }), spec(2, { prep: "bad_dest" }), spec(3)]);
    await w.prepare(1, "bad_dest"); // the second version: a data: destination
    const html = await get();
    for (const p of w.posts.slice(0, 2)) {
      eq(formTag(html, p.ref), null);
      assertNode.ok(/Not offered: its application doesn't go to a web address/.test(noteOf(html, p.ref)), noteOf(html, p.ref));
      eq((await post({ t: sid, action: "apply", ref: p.ref, tag: hashTag((await w.truth()).prep.get(p.jobId)!.hash) })).status, 200);
      const t = tg();
      const res = await tapJob({ userId: U, data: `jcy:${p.ref}:${hashTag((await w.truth()).prep.get(p.jobId)!.hash)}`, messageId: null, deps: w.deps as JobDeps, send: t.send });
      eq(res.status, "bad_destination");
    }
    eq((await w.truth()).approvals.size, 0);
    assertNode.ok(/>Apply<\/button>/.test(html), "the posting with a web destination still offers Apply");
  });
  Deno.test("regression: when the approval cannot be opened, the page's note names the page's own button (was: 'Tap Confirm again in a minute' on a page with no Confirm)", async () => {
    const { w, get, post, sid } = await signedWorld([spec(1)]);
    const html = await get();
    w.deps.cards = { ...w.deps.cards, async confirm() { throw new Error("connection reset"); } };
    const r = await post({ t: sid, action: "apply", ref: w.posts[0].ref, tag: formTag(html, w.posts[0].ref)! });
    const note = noteOf(r.body, w.posts[0].ref);
    assertNode.ok(/nothing was approved\. Tap Apply again in a minute\./.test(note) && !/Confirm/.test(note), note);
  });
  Deno.test("regression: the script path is the plain form's twin: one request, focus back on the row, the change announced; an answer that is not the list is shown, never posted again (was: focus lost, nothing announced, a second POST)", async () => {
    const { w, get } = await signedWorld([spec(1), spec(2, { prep: null }), spec(3)]);
    let requests = 0;
    const html = await get();
    const page = new Page("https://trainee.example/file", html, async (body) => { requests++; return await (await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), w.deps)).text(); });
    page.run();
    const form = (ref: string) => page.html.getElementById(`r-${ref}`)!.all().find((n) => n.tag === "form")!;
    await page.tap(form(w.posts[1].ref));
    eq(requests, 1);
    eq(page.active?.closest("li.row")?.id, `r-${w.posts[1].ref}`, "focus stays on the row tapped");
    eq(page.html.getElementById("live")?.textContent, "Getting it ready. Nothing has been sent.");
    w.clock.now += SESSION_TTL_MS; // the session ends; the next tap's answer is the signed-out page
    await page.tap(form(w.posts[0].ref));
    eq(requests, 2, "one request for the tap, never a second POST of the same form");
    eq(page.title, "You were signed out - Trainee");
    assertNode.ok(/Nothing was approved or sent from this tap\./.test(page.body.textContent));
  });
  Deno.test("regression: long unbroken words wrap and right-to-left names keep their own direction (Playwright at 320-390 px: the page scrolled sideways to 1,394 px; a trailing '!' sat on the wrong side of a Hebrew title)", () => {
    // What the browser check found, pinned where it is decided: the posting's own text wraps anywhere and sets its own direction.
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderFeedFor())![1];
    for (const sel of [".role{", ".desc{", ".meta,.why,.note{"]) assertNode.ok(new RegExp(`${sel.replace(/[.{,]/g, (c) => `\\${c}`)}[^}]*overflow-wrap:anywhere`).test(css), sel);
    assertNode.ok(/\.name,\.role,\.desc,\.full\{unicode-bidi:plaintext;text-align:start\}/.test(css));
  });
}
// The page's session value as the page holds it (the form's own hidden input).
async function signedWorldSid(html: string) { return /name="t" value="(fs1\.[0-9a-f]{64})"/.exec(html)![1]; }
function renderFeedFor() { return renderFeed({ token: "x", rows: [], setHash: null, setSize: 0 }); }
