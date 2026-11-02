// Apply flow round 3 (architect, 2026-10-30): a fresh seed and new adversarial categories over the whole Apply path, the jobs page's
// row -> Apply (or Apply to all, or Telegram's Confirm) -> the one-transaction card approval -> career_apply_jobs. The categories are
// what changes BETWEEN the page drawing a row and the person's yes (scenarios/apply-r3-generator.ts): the payload's own expiry and the
// database's clock, the account record (paused, forget, the authority fence, erased), answers no confirmed fact supports (D-007's
// quarantined bank, answer-all, derivations, texted answers, another account's fact, EEO questions), the resume replaced or deleted,
// the same posting already sent another way (the extension, another id under the same link), two devices and Telegram at once,
// sessions ending, links minted by a clock ahead, lists past the page's 30 with Unicode names. Rounds 1 and 2 (scenarios-apply*,
// scenarios-file-apply*, scenarios-file-journey-r2*, scenarios-file-signin*) never drew these.
//
// Every scenario runs through the real handler (trainee-file/handler.ts handleFile) and the real Telegram card path (telegram_jobs.ts
// tapJob: Apply, then the Confirm it offers), over a world that is either memory (this file: the database's rules as plain code,
// career_apply_card_confirm_for / career_apply_enqueue / career_apply_current / the resume guards / career_apply_posting_sent) or
// real Postgres 16 (flow-scenarios-apply-r3.test.ts: the deployed stores). After EVERY request:
//   exact payload   a row is queued only by a request from a live session of its account (or Telegram's own Confirm), carrying the
//                   tag of exactly the payload queued, for a posting that request named (Apply) or that was in the set shown (Apply
//                   to all)
//   sendable        a queued payload is current (its own expiry ahead of the DATABASE's clock, the account's epoch and version,
//                   not paused), carries the resume on file, and every answer is one the worker's contract sends
//                   (approve-first.ts payloadTrust and its owner check: the worker's own code is the oracle)
//   offered         a row offers Apply bound to a tag only when that tap could be queued and sent as approved (the same tests);
//                   a posting sent or on its way another way shows a status, never Apply
//   once            one application per posting (its id and its canonical link, the extension's reports included), ever
//   nobody else     another account's companies, values and refs never reach this account's page; its ref approves nothing
//   time            nothing is approved at or after the session's expiry instant or after sign-out everywhere; a link minted
//                   more than a minute ahead of this clock is refused, within a minute it opens the sign-in
//   page            the first 30 rows are drawn, each company whole and escaped; Apply past them approves nothing
// The oracle is this file's own model of each posting's truth and the worker's own contract; it never asks the page what a row should show.
import assertNode from "node:assert/strict";
import { handleFile, type FileDeps, type FileStore, MAX_ROWS } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, type JobView, jobViewOf, type PostingRow, type PreparedRow, refOf, tapJob } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { pageTokenOf, SESSION_TTL_MS, sha256, startSession, type SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { COUNTED_STATES, postingKey } from "../../supabase/functions/_shared/career_apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { stampOf, type AccountStamp, QUARANTINE_RULES } from "../../supabase/functions/_shared/apply_trust.ts";
import { payloadTrust } from "../../workers/career-browser/approve-first.ts";
import { QUARANTINE_VERSION } from "../../extension/src/apply_core.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";
import { type FieldKind, generate, type Mut, type PostSpec, type PrepSpec, type Scenario, type Step } from "./scenarios/apply-r3-generator.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const U = "33333333-3333-4333-8333-3333333333aa", V = "44444444-4444-4444-8444-4444444444bb";
export const T0 = Date.parse("2026-10-30T16:00:00Z");
export const SEED = 20261030 + 3;
export const COUNT = Number(Deno.env.get("R3_COUNT") ?? 10_000);
export const SCENARIOS = generate({ seed: SEED, count: COUNT });
export const SECRET_LINK = ["apply", "r3", "link", "secret", "0123456789"].join("-");
export const RESUME_A = "%PDF-1.4\n% TEST apply r3 resume A\n%%EOF\n";
const hex = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
export const SHA_A = await hex(RESUME_A), SHA_B = await hex("%PDF-1.4\n% TEST apply r3 resume B\n%%EOF\n");
const DAY = 86_400_000;
const V_MARK = "VSECRETR3";
const BIDI = /[‪-‮⁦-⁩]/g;
export const escH = (s: string) => s.replace(BIDI, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---------------------------------------------------------------- postings and payloads
export interface Post { spec: PostSpec; jobId: string; url: string; variant: string; ref: string; job: JobView; row: PostingRow }
export function urlOf(p: PostSpec, salt: number): { url: string; jobId: string; variant: string } {
  const id = 8_100_000 + salt * 1000 + p.n, board = `r3b${salt}x${p.n}`;
  const uuid = `${(salt * 1000 + p.n).toString(16).padStart(8, "0")}-bbbb-4ccc-8ddd-${String(salt).padStart(12, "0")}`;
  // The variant is the same posting under another link (career_apply_posting_key equal): the other board host with tracking
  // parameters, a trailing /apply, a tracking query.
  if (p.provider === "greenhouse") return { url: `https://boards.greenhouse.io/${board}/jobs/${id}`, jobId: `greenhouse:${board}:${id}`, variant: `https://job-boards.greenhouse.io/${board}/jobs/${id}?utm_source=r3&gh_src=x` };
  if (p.provider === "lever") return { url: `https://jobs.lever.co/${board}/${uuid}`, jobId: `lever:${board}:${uuid}`, variant: `https://jobs.lever.co/${board}/${uuid}/apply` };
  return { url: `https://jobs.ashbyhq.com/${board}/${uuid}`, jobId: `ashby:${board}:${uuid}`, variant: `https://jobs.ashbyhq.com/${board}/${uuid}?utm_source=linkedin` };
}
export async function postOf(p: PostSpec, userId: string, salt: number, now: number): Promise<Post> {
  const { url, jobId, variant } = urlOf(p, salt);
  const row: PostingRow = { job_id: jobId, provider: jobId.split(":")[0], company: p.company, title: `Data Analyst ${p.n}`, location: "Austin, TX", url, description: "We build tools for analysts. Requirements: SQL and Python.",
    remote: null, seniority_band: null, posted_at: new Date(now - 2 * DAY).toISOString(), first_seen_at: new Date(now - 2 * DAY).toISOString(), pay: null, closed_at: null, deadline: null };
  return { spec: p, jobId, url, variant, ref: await refOf(userId, jobId), job: jobViewOf({ job_id: jobId, company: p.company, title: row.title, url }, row), row };
}
const LABELS = ["Gender", "Veteran status", "Disability status", "Race / ethnicity", "Years of experience", "Work authorization", "How did you hear about us?"];
function fieldOf(k: FieldKind, i: number, userId: string): Record<string, unknown> {
  const label = LABELS[i % LABELS.length];
  const base = { name: `q${i}`, label, value: "Prefer not to say", provenance: "the person said it in chat", confirmation_event_id: `ev-${i}` };
  switch (k) {
    case "plain": return { name: "first_name", label: "First name", value: "Ada", factId: "F-003", provenance: "the person said it in chat", confirmation_event_id: "ev-3" };
    case "eeo_decline": return { ...base, label: "Gender (optional)", value: "Decline to self-identify", factId: "F-004" };
    case "eeo_value": return { ...base, value: "No", factId: `F-0${10 + (i % 9)}` };
    case "q_bank": return { ...base, value: "Yes", factId: `F-0${27 + (i % 53)}` };
    case "q_bank_padded": return { ...base, value: "Yes", factId: ` F-00${30 + (i % 40)} ` };
    case "q_answer_all": return { ...base, value: "5 years", factId: `F-1${i}`, provenance: "Answer-All delegation, 2026-10-17" };
    case "q_delegated": return { ...base, value: "Yes", factId: `F-2${i}`, provenance: "owner-delegated batch" };
    case "q_derived": return { ...base, value: "Yes", factId: `F-3${i}`, derived_from: ["F-002", `F-0${27 + (i % 53)}`] };
    case "q_derived_alias": return { ...base, value: "Yes", factId: `F-4${i}`, derivedFrom: ["F-79"] };
    case "derived_ok": return { ...base, value: "3", factId: `F-5${i}`, derived_from: ["F-002"], derivedFrom: ["F-003"] };
    case "derived_bad": return { ...base, value: "3", factId: `F-6${i}`, derived_from: "F-002" };
    case "text_no_key": return { ...base, value: "No", factId: `text-answer:r3${i}` };
    case "text_keyed": return { ...base, value: "No", factId: `text-answer:r3k${i}`, source: { table: "answers", key: `visa${i}`, value: "No" } };
    case "other_owner": return { ...base, value: `${V_MARK}-${i}`, factId: `F-7${i}`, user_id: V };
    case "own_owner": return { ...base, value: "Yes", factId: `F-8${i}`, user_id: userId };
  }
}
export function payloadOf(p: Post, s: PrepSpec, version: number, acct: { epoch: number; version: number; authority: number }, start: number, userId: string, resumeSha: string): Record<string, unknown> {
  const stamp = s.stamp === "old_epoch" ? { privacy_epoch: acct.epoch + 1, account_version: acct.version } : s.stamp === "behind_fence" ? { privacy_epoch: acct.epoch, account_version: acct.authority - 1 }
    : s.stamp === "ahead" ? { privacy_epoch: acct.epoch, account_version: acct.version + 1 } : { privacy_epoch: acct.epoch, account_version: acct.version };
  return { version: 1, user_id: userId, job_id: p.jobId, company: p.spec.company, url: p.url, fields: s.fields.map((k, i) => fieldOf(k, i, userId)), ...stamp,
    expires_at: s.expiresIn === "invalid" ? "soon" : new Date(start + s.expiresIn).toISOString(), resume_sha256: resumeSha, resume_name: "ada-cv-2026.pdf",
    cover_note: { text: `I built the pricing model (v${version}).` }, attempt: version, ...(s.quarantine === "none" ? {} : { quarantine_version: s.quarantine === "current" ? QUARANTINE_RULES : "d007-v0" }) };
}

// ---------------------------------------------------------------- the world
export interface App { job_id: string; url: string; hash: string; payload: Record<string, unknown>; state: string }
export interface Truth {
  prep: Map<string, { hash: string; payload: Record<string, unknown> } | null>; // by job id: the current ready / shown payload
  apps: App[];
  ext: string[]; // posting links the extension reported as sent
  account: AccountStamp | null;
  resume: { sha: string | null; retired: Set<string> } | null; // null: no resume record (the queue then takes the payload's resume)
  erased: boolean;
}
export interface World {
  u: string; posts: Post[]; vRef: string; vTag: string; listId: string; deps: FileDeps; clock: { now: number }; skew: number;
  sessions: SessionStore; tokens: Record<"A" | "B", string>; expiry: Record<"A" | "B", number>;
  dbNow(): number; // the database's clock (the queue judges expiry by it)
  truth(): Promise<Truth>;
  mutate(m: Mut): Promise<void>;
}
export const counted = (s: string) => COUNTED_STATES.has(s);
export const untrustedByWorker = (pl: Record<string, unknown>) => [...payloadTrust(pl), ...((Array.isArray(pl.fields) ? pl.fields : []) as { user_id?: string }[]).some((f) => f?.user_id !== undefined && f.user_id !== pl.user_id) ? ["FACT_OWNER_MISMATCH"] : []];
export function currentAt(pl: Record<string, unknown>, a: AccountStamp | null, dbNow: number): boolean {
  if (!a || a.paused) return false;
  const exp = Date.parse(String(pl.expires_at ?? ""));
  return Number(pl.privacy_epoch) === a.epoch && Number(pl.account_version) >= a.authority_version && Number(pl.account_version) <= a.version && !Number.isNaN(exp) && exp > dbNow;
}
export const resumeOk = (pl: Record<string, unknown>, t: Truth) => /^[a-f0-9]{64}$/.test(String(pl.resume_sha256 ?? "")) && (!t.resume || (t.resume.sha === pl.resume_sha256 && !t.resume.retired.has(String(pl.resume_sha256))));
export const sentBefore = (t: Truth, jobId: string, url: string, exceptJob?: string) => t.apps.some((a) => counted(a.state) && a.job_id !== exceptJob && (a.job_id === jobId || postingKey(a.url) === postingKey(url))) || t.ext.some((x) => postingKey(x) === postingKey(url));

export async function memWorld(s: Scenario): Promise<World> {
  const clock = { now: T0 };
  const salt = s.id % 997;
  const posts: Post[] = [];
  for (const p of s.posts) posts.push(await postOf(p, U, salt, T0));
  const vPost = await postOf({ n: 999, company: `${V_MARK} Corp`, provider: "greenhouse", prep: null, elsewhere: null }, V, salt + 1, T0);
  let account: { epoch: number; version: number; authority_version: number; paused: boolean } | null = { epoch: s.account.epoch, version: s.account.version, authority_version: s.account.authority, paused: s.account.paused };
  let resume: { sha: string | null; retired: Set<string> } | null = { sha: SHA_A, retired: new Set() };
  const preps: { id: string; user: string; job_id: string; payload: Record<string, unknown>; hash: string; state: string; created: number }[] = [];
  const apps: (App & { user: string })[] = [];
  const ext: string[] = [];
  const kv = new Map<string, unknown>();
  const wanted = new Set<string>();
  let pid = 0, erased = false;
  const accounts: Record<string, string | null> = { [U]: "+15125550133", [V]: "+15125550144" };
  const phone = fakePhone(accounts);
  const S = memSessions();
  const dbNow = () => clock.now + s.skew;
  const addPrep = async (user: string, p: Post, spec: PrepSpec) => {
    if (!resume?.sha && user === U) return; // the prepared guard: no resume, nothing prepared
    const acct = { epoch: account?.epoch ?? 0, version: account?.version ?? 0, authority: account?.authority_version ?? 0 };
    const v = preps.filter((x) => x.job_id === p.jobId && x.user === user).length + 1;
    const payload = payloadOf(p, spec, v, acct, clock.now, user, user === U ? resume!.sha! : SHA_A);
    for (const x of preps) if (x.user === user && x.job_id === p.jobId && (x.state === "ready" || x.state === "shown")) x.state = "expired";
    preps.push({ id: `p${++pid}`, user, job_id: p.jobId, payload, hash: await hashApplyPayload(payload), state: "ready", created: pid });
  };
  for (const p of posts) {
    if (p.spec.prep) await addPrep(U, p, p.spec.prep);
    if (p.spec.elsewhere === "extension") ext.push(p.variant);
    if (p.spec.elsewhere === "alt_id") apps.push({ user: U, job_id: `custom:alt:${p.jobId}`, url: p.variant, hash: "0".repeat(64), payload: {}, state: "submitted_unconfirmed" });
  }
  await addPrep(V, vPost, { expiresIn: 7 * DAY, stamp: "current", fields: ["plain", "other_owner"], quarantine: "none" });
  const curPrep = (user: string, jobId: string) => preps.filter((x) => x.user === user && x.job_id === jobId && (x.state === "ready" || x.state === "shown")).sort((a, b) => b.created - a.created)[0] ?? null;
  const all = [...posts, vPost];
  const byJob = (jobId: string) => all.find((p) => p.jobId === jobId) ?? null;
  const truthApps = (user: string) => apps.filter((a) => a.user === user);
  const posting = (jobId: string, url: string, user: string, exceptJob?: string) => apps.some((a) => a.user === user && counted(a.state) && a.job_id !== exceptJob && (a.job_id === jobId || postingKey(a.url) === postingKey(url))) || (user === U && ext.some((x) => postingKey(x) === postingKey(url)));
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return (kv.get(`${u}|job|${ref}`) as { job: JobView; shownAs: "text" }) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, [...refs]); },
    async recallList(u, id) { return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async postings(ids) { return all.filter((p) => ids.includes(p.jobId)).map((p) => ({ ...p.row })); },
    async save() { return "saved"; },
    async prepared(u, jobId) {
      const x = curPrep(u, jobId), p = byJob(jobId);
      return x && p ? { id: x.id, job_id: jobId, company: String(x.payload.company), url: String(x.payload.url), payload: structuredClone(x.payload), payload_hash: x.hash, card_lines: [], state: x.state } as PreparedRow : null;
    },
    async applied(u, jobId) { return apps.some((a) => a.user === u && a.job_id === jobId); },
    async want(u, job) {
      if (posting(job.job_id, job.url, u)) return { result: "refused", reason: "this posting is already in your applications, and each posting goes at most once" };
      const k = postingKey(job.url) ?? job.url;
      if (wanted.has(`${u}|${k}`)) return { result: "already" };
      wanted.add(`${u}|${k}`);
      return { result: "queued" };
    },
    async appRow(u, jobId, url) {
      const a = apps.find((x) => x.user === u && x.job_id === jobId) ?? (url ? apps.filter((x) => x.user === u && x.url === url).at(-1) : undefined);
      return a ? { id: `app-${a.job_id}`, state: a.state, reason: null, confirmation_id: null, created_at: new Date(clock.now).toISOString(), updated_at: new Date(clock.now).toISOString(), email_confirmed_at: null, payload: a.payload, company: String(a.payload.company ?? "Employer"), url: a.url } : null;
    },
    async wanted(u, url) { return wanted.has(`${u}|${postingKey(url) ?? url}`); },
    async elsewhere(u, job) { return posting(job.job_id, job.url, u); },
  };
  // career_apply_card_confirm_for -> career_apply_card_answer_for -> career_apply_enqueue, rule for rule (the database never
  // judges the answers' sources: that is the worker's contract, and the page's and Confirm's since round 3).
  const cards = {
    async open() { throw new Error("the deployed store confirms in one transaction"); },
    async confirm(u: string, ids: string[], hashes: string[]) {
      const items = ids.map((id, k) => { const x = preps.find((y) => y.id === id && y.user === u); if (!x || x.hash !== hashes[k]) throw new Error("card_changed"); return x; });
      if (items.some((x) => x.state !== "ready" && x.state !== "shown")) throw new Error("invalid card");
      const results = items.map((x, k) => {
        const p = byJob(x.job_id)!;
        let result: string;
        const exp = Date.parse(String(x.payload.expires_at ?? ""));
        const t: Truth = { prep: new Map(), apps: [], ext: [], account: account ? { ...account } : null, resume, erased };
        if (Number.isNaN(exp) && x.payload.expires_at !== undefined) result = "refused"; // the cast fails inside the enqueue
        else if (!currentAt(x.payload, account, dbNow())) result = "stale";
        else if (apps.some((a) => a.user === u && a.job_id === x.job_id)) result = "duplicate";
        else if (posting(x.job_id, String(x.payload.url), u)) result = "duplicate";
        else if (!resumeOk(x.payload, t)) result = "no_resume";
        else { apps.push({ user: u, job_id: x.job_id, url: String(x.payload.url), hash: x.hash, payload: structuredClone(x.payload), state: "queued" }); result = "queued"; }
        x.state = result === "queued" ? "approved" : result === "stale" ? "expired" : "declined";
        return { n: k + 1, company: p.spec.company, result };
      });
      return { card: { id: `card-${pid}`, items: items.map((x, k) => ({ n: k + 1, prepared_id: x.id, payload_hash: x.hash })), shown_at: new Date(dbNow()).toISOString() }, results };
    },
  };
  const listId = (await hex(`r3|${s.id}`)).slice(0, 10);
  const vList = (await hex(`r3v|${s.id}`)).slice(0, 10);
  for (const p of posts) await store.remember(U, p.ref, p.job, "text");
  await store.rememberList(U, listId, posts.map((p) => p.ref));
  await store.remember(V, vPost.ref, vPost.job, "text");
  await store.rememberList(V, vList, [vPost.ref]);
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET_LINK, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
  const deps: FileDeps = { store, cards: cards as never, tap: {} as never, now: () => clock.now, env: { get: (k) => env[k] }, events: null, facts: async () => [], sessions: S.store, phone: phone.auth, userOfTelegram: async () => null,
    account: async (u) => (u === U ? (account ? { ...account } : null) : { epoch: 0, version: 9, authority_version: 0, paused: false }) };
  const tokens = { A: await startSession(S.store, { userId: U, via: "phone", phone: accounts[U], telegramId: null, list: listId, now: clock.now }), B: await startSession(S.store, { userId: U, via: "phone", phone: accounts[U], telegramId: null, list: listId, now: clock.now + 1000 }) };
  const vp = curPrep(V, vPost.jobId)!;
  return {
    dbNow,
    u: U, posts, vRef: vPost.ref, vTag: hashTag(vp.hash), listId, deps, clock, skew: s.skew, sessions: S.store, tokens, expiry: { A: clock.now + SESSION_TTL_MS, B: clock.now + 1000 + SESSION_TTL_MS },
    async truth() {
      const prep = new Map<string, { hash: string; payload: Record<string, unknown> } | null>();
      for (const p of posts) { const x = curPrep(U, p.jobId); prep.set(p.jobId, x ? { hash: x.hash, payload: x.payload } : null); }
      return { prep, apps: truthApps(U).map(({ user: _u, ...a }) => a), ext: [...ext], account: account ? { ...account } : null, resume: resume ? { sha: resume.sha, retired: new Set(resume.retired) } : null, erased };
    },
    async mutate(m) {
      if (m.m === "pause") { if (account) account.paused = true; }
      else if (m.m === "forget") { if (account) account.epoch++; }
      else if (m.m === "fence") { if (account) { account.version++; account.authority_version = account.version; } }
      else if (m.m === "bump") { if (account) account.version++; }
      else if (m.m === "erase") { account = null; erased = true; accounts[U] = null; for (const x of preps) if (x.user === U) x.state = "expired"; resume = null; }
      else if (m.m === "replace_resume" || m.m === "delete_resume") {
        if (!resume?.sha) return;
        const old = resume.sha;
        resume = { sha: m.m === "replace_resume" ? SHA_B : null, retired: new Set([...resume.retired, old]) };
        // career_resume_stop_unbound: prepared applications and unstarted queued ones bound to the old resume are removed.
        for (let k = preps.length - 1; k >= 0; k--) if (preps[k].user === U && (preps[k].state === "ready" || preps[k].state === "shown") && preps[k].payload.resume_sha256 === old) preps.splice(k, 1);
        for (let k = apps.length - 1; k >= 0; k--) if (apps[k].user === U && apps[k].state === "queued" && apps[k].payload.resume_sha256 === old) apps.splice(k, 1);
      } else if (m.m === "elsewhere") {
        const p = posts[m.i % posts.length];
        if (posting(p.jobId, p.url, U)) return; // already sent: another way would be a second application, which the world never makes
        if (m.how === "extension") ext.push(p.variant);
        else apps.push({ user: U, job_id: `custom:alt:${p.jobId}`, url: p.variant, hash: "0".repeat(64), payload: {}, state: "submitted_unconfirmed" });
      } else if (m.m === "reprepare") {
        const p = posts[m.i % posts.length];
        if (!apps.some((a) => a.user === U && a.job_id === p.jobId)) await addPrep(U, p, { expiresIn: 7 * DAY, stamp: "current", fields: ["plain"], quarantine: "current" });
      }
    },
  };
}

// ---------------------------------------------------------------- the page as the person sees it
export interface DrawnRow { ref: string; tag: string | null; chip: string | null; html: string }
export function parsePage(html: string): { rows: DrawnRow[]; set: string | null } {
  const rows: DrawnRow[] = [];
  for (const m of html.matchAll(/<li class="row" id="r-([0-9a-f]{12})">([\s\S]*?)<\/li>/g)) {
    const tag = /name="tag" value="([^"]*)"/.exec(m[2])?.[1] ?? null;
    rows.push({ ref: m[1], tag, chip: /<span class="chip ([a-z-]+)"/.exec(m[2])?.[1] ?? null, html: m[2] });
  }
  return { rows, set: /name="set" value="([0-9a-f]{16})"/.exec(html)?.[1] ?? null };
}
// A device's request: its session cookie; a post also carries the page token its page was drawn with (file_session.ts PAGE_TOKEN).
const req = async (w: World, dev: "A" | "B", form?: Record<string, string>) => form
  ? new Request("https://trainee.example/file", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `tf_s=${w.tokens[dev]}` }, body: new URLSearchParams({ t: (await pageTokenOf(await sha256(w.tokens[dev]), SECRET_LINK)) ?? "", ...form }).toString() })
  : new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${w.tokens[dev]}` } });

// ---------------------------------------------------------------- the run and the checks
export interface Report { total: number; requests: number; fails: Map<string, string[]>; counts: Record<string, number> }
export const newReport = (): Report => ({ total: 0, requests: 0, fails: new Map(), counts: {} });
const fail = (rep: Report, kind: string, detail: string) => { if (!rep.fails.has(kind)) rep.fails.set(kind, []); rep.fails.get(kind)!.push(detail); };
const count = (rep: Report, k: string) => { rep.counts[k] = (rep.counts[k] ?? 0) + 1; };

// What the oracle says a payload is: approvable now (by the database's clock), and why not.
function oracleWhyNot(t: Truth, jobId: string, url: string, pl: Record<string, unknown>, dbNow: number): string | null {
  if (untrustedByWorker(pl).length) return `untrusted answers (${untrustedByWorker(pl)[0]})`;
  if (!currentAt(pl, t.account, dbNow)) return "not current (expiry or account)";
  if (!resumeOk(pl, t)) return "resume not on file";
  if (sentBefore(t, jobId, url)) return "posting already sent";
  return null;
}

export async function runScenario(s: Scenario, w: World, rep: Report): Promise<void> {
  rep.total++;
  count(rep, `cat ${s.cat}`);
  const name = (step: number) => `#${s.id} ${s.cat} step ${step} ${JSON.stringify(s.steps[step]).slice(0, 160)}`;
  const drawn: Record<"A" | "B", { tags: Map<string, string | null>; first: Map<string, string | null>; set: string | null; setTags: Map<string, string> }> = {
    A: { tags: new Map(), first: new Map(), set: null, setTags: new Map() }, B: { tags: new Map(), first: new Map(), set: null, setTags: new Map() } };
  const ended: Record<"A" | "B", boolean> = { A: false, B: false };
  const everKeys = new Map<string, number>();
  for (let k = 0; k < s.steps.length; k++) {
    const st: Step = s.steps[k];
    const before = await w.truth();
    const dbNowBefore = w.dbNow();
    let res: Response | null = null, body = "";
    // Which postings this request may queue, and with which tag (null: it may queue nothing).
    let allowed: Map<string, string> | null = null;
    let live = false;
    const devLive = (dev: "A" | "B") => !ended[dev] && w.clock.now < w.expiry[dev] && !before.erased;
    if (st.k === "draw") {
      res = await handleFile(await req(w, st.dev), w.deps); body = await res.text(); rep.requests++;
      if (res.status === 200 && devLive(st.dev)) {
        const pg = parsePage(body);
        const d = drawn[st.dev];
        d.tags = new Map(pg.rows.map((r) => [r.ref, r.tag]));
        for (const r of pg.rows) if (!d.first.has(r.ref)) d.first.set(r.ref, r.tag);
        d.set = pg.set; d.setTags = new Map(pg.rows.filter((r) => r.tag && r.tag !== "none").map((r) => [r.ref, r.tag!]));
        // offered: a row bound to a tag must be exactly the current payload, and approvable now by the oracle's rules
        const shown = w.posts.slice(0, MAX_ROWS);
        if (pg.rows.length !== shown.length) fail(rep, "page: the first 30 rows are drawn", `${name(k)}: ${pg.rows.length} rows of ${w.posts.length}`);
        for (const r of pg.rows) {
          const p = w.posts.find((x) => x.ref === r.ref);
          if (!p) { fail(rep, "page: a row that is not on the list", `${name(k)} ${r.ref}`); continue; }
          const company = escH(p.job.company);
          if (!r.html.includes(company)) fail(rep, "page: the company is drawn whole and escaped", `${name(k)} ${JSON.stringify(p.job.company)}`);
          const cur = before.prep.get(p.jobId) ?? null;
          const away = sentBefore(before, p.jobId, p.url, p.jobId) && !before.apps.some((a) => a.job_id === p.jobId);
          if (away && (r.tag !== null || !r.chip)) fail(rep, "offered: a posting sent another way shows a status, never Apply", `${name(k)} ${p.jobId} tag=${r.tag} chip=${r.chip}`);
          if (r.tag && r.tag !== "none") {
            count(rep, "rows offered for approval");
            if (!cur || hashTag(cur.hash) !== r.tag) { fail(rep, "offered: the tag is the current payload's", `${name(k)} ${p.jobId}`); continue; }
            const why = oracleWhyNot(before, p.jobId, p.url, cur.payload, dbNowBefore);
            if (why) fail(rep, `offered: a row whose payload can't go as approved (${why.replace(/\(.*\)/, "").trim()})`, `${name(k)} ${p.jobId}: ${why}`);
          } else if (cur && !r.chip) count(rep, "rows held back (not offered)");
        }
        if (body.includes(V_MARK) || body.includes(w.vRef)) fail(rep, "nobody else: another account's data on the page", name(k));
      }
    } else if (st.k === "apply") {
      const p = w.posts[st.i % w.posts.length];
      const d = drawn[st.dev];
      const tag = (st.stale ? d.first.get(p.ref) : d.tags.get(p.ref)) ?? "none";
      live = devLive(st.dev);
      allowed = live && tag !== "none" && st.i % w.posts.length < MAX_ROWS ? new Map([[p.jobId, tag]]) : new Map();
      res = await handleFile(await req(w, st.dev, { action: "apply", ref: p.ref, tag }), w.deps); body = await res.text(); rep.requests++;
      if (st.i % w.posts.length >= MAX_ROWS) { count(rep, "apply past the first 30"); if (res.status !== 404) fail(rep, "page: Apply past the first 30 approves nothing and says so", `${name(k)} -> ${res.status}`); }
    } else if (st.k === "applyall") {
      const d = drawn[st.dev];
      live = devLive(st.dev);
      allowed = live && d.set ? new Map([...d.setTags].map(([ref, tag]) => [w.posts.find((p) => p.ref === ref)!.jobId, tag])) : new Map();
      res = await handleFile(await req(w, st.dev, { action: "applyall", set: d.set ?? "0000000000000000" }), w.deps); body = await res.text(); rep.requests++;
    } else if (st.k === "tg_confirm") {
      // Telegram: Apply on the card, then the Confirm it offers (if any): Telegram's own identity, no page session.
      const p = w.posts[st.i % w.posts.length];
      const said: { text: string; buttons?: { data?: string }[][] }[] = [];
      const send = { photo: async () => ({ ok: true }), text: async (a: { text: string; buttons?: { data?: string }[][] }) => { said.push(a); return { ok: true, id: null }; } };
      await tapJob({ userId: w.u, data: `jca:${p.ref}`, messageId: null, deps: w.deps, send: send as never });
      const conf = said.flatMap((x) => x.buttons ?? []).flat().map((b) => b.data ?? "").find((x) => x.startsWith("jcy:"));
      rep.requests++;
      if (conf) {
        count(rep, "telegram offered Confirm");
        const tag = conf.split(":")[2];
        const cur = before.prep.get(p.jobId) ?? null;
        const why = cur ? oracleWhyNot(before, p.jobId, p.url, cur.payload, dbNowBefore) : "nothing prepared";
        if (!before.erased && why) fail(rep, `offered: Telegram offered Confirm on a payload that can't go as approved (${why.replace(/\(.*\)/, "").trim()})`, `${name(k)} ${p.jobId}: ${why}`);
        allowed = before.erased ? new Map() : new Map([[p.jobId, tag]]);
        live = !before.erased;
        await tapJob({ userId: w.u, data: conf, messageId: null, deps: w.deps, send: send as never });
        rep.requests++;
      } else allowed = new Map();
    } else if (st.k === "mutate") {
      await w.mutate(st.mut);
      allowed = new Map();
    } else if (st.k === "advance") {
      w.clock.now += st.ms; allowed = new Map();
    } else if (st.k === "signout_all") {
      res = await handleFile(await req(w, st.dev, { action: "signout_all" }), w.deps); body = await res.text(); rep.requests++;
      if (res.status === 200) { ended.A = true; ended.B = true; }
      allowed = new Map();
    } else if (st.k === "at_session_end") {
      w.clock.now = w.expiry.A + st.delta; allowed = new Map();
    } else if (st.k === "cross") {
      res = await handleFile(await req(w, st.dev, { action: "apply", ref: w.vRef, tag: w.vTag }), w.deps); body = await res.text(); rep.requests++;
      count(rep, "another account's ref posted");
      if (res.status !== 404) fail(rep, "nobody else: another account's ref is not on this list", `${name(k)} -> ${res.status}`);
      if (body.includes(V_MARK)) fail(rep, "nobody else: another account's data in the answer", name(k));
      allowed = new Map();
    } else if (st.k === "link") {
      const t = await mintFileToken({ secret: SECRET_LINK, userId: w.u, list: w.listId, now: w.clock.now + st.skew, kind: "l" });
      res = await handleFile(new Request(`https://trainee.example/file?t=${t}`), w.deps); body = await res.text(); rep.requests++;
      const want = st.skew > 60_000 ? 410 : 303;
      count(rep, `link minted ${st.skew > 60_000 ? "too far ahead" : "within the skew"}`);
      if (res.status !== want) fail(rep, "time: a link minted ahead of this clock opens only within a minute's skew", `${name(k)} skew ${st.skew} -> ${res.status}`);
      allowed = new Map();
    }
    // ---- after every request: what was queued, by whom, with what
    const after = await w.truth();
    // A mutation's own rows are the world sending it another way (setup), not an approval.
    const fresh = st.k === "mutate" ? [] : after.apps.filter((a) => !before.apps.some((b) => b.job_id === a.job_id && b.hash === a.hash));
    const dbNow = w.dbNow();
    for (const a of fresh) {
      count(rep, `queued via ${st.k}`);
      const tag = allowed?.get(a.job_id);
      if (!tag) fail(rep, "exact payload: queued by a request that could not approve it", `${name(k)} ${a.job_id} live=${live} status=${res?.status}`);
      else if (hashTag(a.hash) !== tag) fail(rep, "exact payload: queued a payload other than the tag the person saw", `${name(k)} ${a.job_id}`);
      const why = oracleWhyNot({ ...before, apps: before.apps }, a.job_id, a.url, a.payload, dbNow);
      if (why) fail(rep, `sendable: queued a payload that can't go as approved (${why.replace(/\(.*\)/, "").trim()})`, `${name(k)} ${a.job_id}: ${why}`);
      if (/\bapplied\b/i.test(body.replace(/\bnot applied\b/gi, ""))) fail(rep, "words: \"applied\" said for a queued application", name(k));
    }
    // once: one application per posting (its id or its canonical link, the extension's reports included)
    for (const a of after.apps.filter((x) => counted(x.state))) {
      const key = postingKey(a.url) ?? a.job_id;
      const n = after.apps.filter((x) => counted(x.state) && (x.job_id === a.job_id || postingKey(x.url) === key)).length + after.ext.filter((x) => postingKey(x) === key).length;
      if (n > 1) fail(rep, "once: a posting has more than one application", `${name(k)} ${a.job_id} x${n}`);
      everKeys.set(key, Math.max(everKeys.get(key) ?? 0, n));
    }
    if (res && ![200, 303, 400, 401, 403, 404, 410, 429, 503].includes(res.status)) fail(rep, "an answer outside the page's statuses", `${name(k)} -> ${res.status}`);
    if ((st.k === "apply" || st.k === "applyall") && !live && fresh.length) fail(rep, "time: approved after the session ended", name(k));
    if ((st.k === "apply" || st.k === "applyall") && !live) count(rep, "taps on an ended session");
  }
}

export function printReport(label: string, rep: Report): number {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[apply r3] ${label}: ${rep.total} scenarios, ${rep.requests} requests, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 400)}`); }
  lines.push(`  counts: ${JSON.stringify(rep.counts)}`);
  console.log(lines.join("\n"));
  return n;
}
export const quarantineRulesAgree = () => eq(QUARANTINE_RULES, QUARANTINE_VERSION, "apply_trust.ts judges by the worker's quarantine rules");
export { stampOf };
