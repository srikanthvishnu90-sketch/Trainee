// The jobs page and its Apply flow at scale (owner, 2026-10-29: "open the postings with company logos, roles and details, log in with
// my phone number, then click Apply and have it apply for me"): ~10,000 seeded random scenarios (scenarios/file-apply-generator.ts) of
// signed-in lists of 1-30 postings in every state, and of taps and world changes on them, run through the real handler
// (supabase/functions/trainee-file/handler.ts) over memory stores; then a seeded sample through the deployed stores (career_postings,
// career_apply_prepared, career_apply_jobs, career_apply_wanted and the card RPCs) on real Postgres 16. After EVERY request:
//   - the logo is only the employer's own domain through the configured https provider, else the lettermark; every detail shown
//     (location, pay, deadline, source, fit) is the stored posting's, or the search result's labelled "Reported, not verified";
//     nothing is invented; all text is escaped (no foreign tag or attribute, no script link, no bidi override reaching the page);
//   - the status word is the row's truth (Queued / Preparing / Sending / Submitted / Confirmed / Failed / Not submitted / Needs you /
//     Unknown) and "applied" is never said; LinkedIn, Indeed and Handshake rows only link out; a row that cannot pass the posting
//     screen (closed, stale, scam-looking, past its deadline, a knock-out for this person, no posting on file) offers no Apply;
//   - an approval happens only for the exact tag that is current for that row; Apply to all approves exactly the approvable set or
//     nothing; each posting is approved at most once ever; a changed payload approves nothing and says to refresh; a row with a
//     secret-looking field is "Needs you", never one-tap approvable, its value never printed;
//   - "What we send" lists exactly the values of the real payload (resume, every field, the cover note, the page-set fields, any
//     other key, the destination) and nothing else;
//   - an unprepared row's Apply queues its preparation once (after the screen), never approves, and the row then says Preparing.
// The oracle is this file's own model of each posting's truth; it never asks the product what a row should show.
import assertNode from "node:assert/strict";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, secretFields, sourceOf, supabaseConfirmedFacts, supabaseJobStore, type JobView, type PostingRow, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { wantsFrom } from "../../supabase/functions/_shared/career_apply_want.ts";
import { neverOpen } from "../../supabase/functions/_shared/career_people_sites.ts";
import { chatScreenFacts } from "../../supabase/functions/_shared/career_apply_gate.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { supabaseFileStore } from "../../supabase/functions/trainee-file/store.ts";
import { supabaseTapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { supabaseCardStore } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { PgConn } from "../flow/pgwire.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";
import { BY_HAND, descText, generate, HIT_LOCS, HIT_PAYS, type PayloadSpec, type PostingSpec, rng, ROW_LOCS, ROW_PAYS, sample, type Scenario, SECRET_MARK,
  type Step } from "./scenarios/file-apply-generator.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", LIST = "0123456789";
const T0 = Date.parse("2026-10-29T15:00:00Z");
const DAY = 86_400_000;
const SCENARIOS = generate({ seed: 20261029, count: 10_000 });
const ONLY = Deno.env.get("FAB_ONLY"), FIRST = Number(Deno.env.get("FAB_N") ?? 0); // local debugging: one scenario, or the first N
const PG_SAMPLE = 100;
// Split across test files for CI time (2026-10-30: the battery ran ~170 s in one file, longer than a CI shard should wait
// on one file). scenarios-file-apply.test.ts, scenarios-file-apply-2.test.ts and scenarios-file-apply-3.test.ts each call
// fileApplyTests(part): part 1 runs the regressions and the forced interleavings, every part runs its third of the 10,000
// memory scenarios (every invariant after every request, as before), and part 3 the Postgres sample. Together they run every
// test of this battery once and every scenario once; part 1 checks the other two are on disk and register their parts.
export const FILE_APPLY_PARTS = 3;
const registry: { parts: number[]; args: unknown[] }[] = [];
const later = (parts: number[], ...args: unknown[]) => { registry.push({ parts, args }); };
export function fileApplyTests(part: number) {
  if (!Number.isInteger(part) || part < 1 || part > FILE_APPLY_PARTS) throw new Error(`no part ${part} of ${FILE_APPLY_PARTS}`);
  for (const t of registry) if (t.parts.includes(part)) (Deno.test as (...a: unknown[]) => void)(...t.args);
  if (part === 1) {
    Deno.test(`file apply battery: all ${FILE_APPLY_PARTS} parts are test files, each registering its own part`, async () => {
      for (let k = 1; k <= FILE_APPLY_PARTS; k++) {
        const f = new URL(`./scenarios-file-apply${k === 1 ? "" : `-${k}`}.test.ts`, import.meta.url);
        const text = await Deno.readTextFile(f);
        if (!new RegExp(`fileApplyTests\\(${k}\\)`).test(text)) throw new Error(`${f.pathname} does not register part ${k}`);
      }
    });
  }
}
const RESUME_FILE = "%PDF-1.4\n% TEST file-apply battery resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const LOGO_TPL: Record<Scenario["logo"], string> = { default: "", custom: "https://logos.example/{domain}.png", http: "http://logos.example/{domain}.png", garbage: "logo:{domain}" };
const BIDI = /[‪-‮⁦-⁩]/g;
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const norm = (s: unknown) => String(s ?? "").replace(BIDI, "").replace(/\s+/g, " ").trim();
const textOf = (h: string) => norm(unesc(h.replace(/<[^>]+>/g, " ")));
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; if (Number.isNaN(t)) return null; const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

// ---------------------------------------------------------------- the world: each posting's truth
interface Prep { id: string; payload: Record<string, unknown>; hash: string; state: "ready" | "shown" | "approved" | "declined" | "expired"; secrets: string[]; hidden: string[]; needsYou: boolean }
interface Post {
  spec: PostingSpec; n: number; job: JobView; ref: string; url: string; jobId: string; ownDomain: string | null; row: PostingRow | null; deadline: string | null;
  hashes: string[]; // every payload hash this row ever had (stale tags come from here)
}
interface App { state: string; reason: string | null; job_id: string; url: string; payload: Record<string, unknown>; via: "approval" | "elsewhere" }
interface Snapshot { preps: (Prep | null)[]; apps: (App | null)[]; appByJob: Map<string, App>; wanted: boolean[]; rows: (PostingRow | null)[]; approvals: Map<string, number> }
interface World {
  posts: Post[]; scenario: Scenario; now: number; deps: FileDeps;
  snapshot(): Promise<Snapshot>;
  mutate(step: Step, r: () => number): Promise<void>;
  wantCalls: { key: string; result: string }[];
}
const KEY_OF = (p: Post) => wantsFrom([{ url: p.url, job_id: p.jobId, company: p.job.company, title: p.job.title } as any], 0);

function urlOf(p: PostingSpec, id: number, board: string, uuid: string): { url: string; jobId: string } {
  const gh = `greenhouse:${board}:${id}`;
  switch (p.url) {
    case "greenhouse": return { url: `https://boards.greenhouse.io/${board}/jobs/${id}`, jobId: gh };
    case "lever": return { url: `https://jobs.lever.co/${board}/${uuid}`, jobId: `lever:${board}:${uuid}` };
    case "ashby": return { url: `https://jobs.ashbyhq.com/${board}/${uuid}`, jobId: `ashby:${board}:${uuid}` };
    case "own_gh": return { url: `https://careers.${p.slug}.com/jobs/${id}?gh_jid=${id}`, jobId: gh };
    case "own_link": return { url: `https://jobs.${p.slug}.io/openings/${id}`, jobId: `link:${id.toString(16)}` };
    case "ats_other": return { url: `https://${p.slug}.${p.atsHost}/careers/${id}`, jobId: gh };
    case "board": return { url: `https://${p.boardHost}/jobs/${id}`, jobId: gh };
    case "http_gh": return { url: `http://boards.greenhouse.io/${board}/jobs/${id}`, jobId: gh };
    case "linkedin": return { url: `https://www.linkedin.com/jobs/view/${id}`, jobId: gh };
    case "linkedin_dot": return { url: `https://www.linkedin.com./jobs/view/${id}`, jobId: gh };
    case "lnkd": return { url: `https://lnkd.in/j${id}`, jobId: gh };
    case "indeed": return { url: `https://www.indeed.com/viewjob?jk=${id}`, jobId: gh };
    case "indeed_uk": return { url: `https://www.indeed.co.uk/viewjob?jk=${id}`, jobId: gh };
    case "handshake": return { url: `https://app.joinhandshake.com/jobs/${id}`, jobId: gh };
    case "js_linkedin": return { url: `javascript://www.linkedin.com/%0Aalert(${id})`, jobId: gh };
  }
}
const ownDomainOf = (p: PostingSpec): string | null => {
  if (p.domain === "stated" || p.domain === "stated_url") return `${p.slug ?? `employer${p.n}`}.com`;
  if (p.url === "own_gh") return `${p.slug}.com`;
  if (p.url === "own_link") return `${p.slug}.io`;
  return null;
};
const statedDomainOf = (p: PostingSpec) => p.domain === "stated" ? `${p.slug ?? `employer${p.n}`}.com` : p.domain === "stated_url" ? `https://www.${p.slug ?? `employer${p.n}`}.com/about` : p.domain === "hostile" ? p.hostileDomain : null;

// The payload a prepared application carries, and what the runner knows about it: which labels and keys are secrets, which values must never print.
function payloadOf(post: { jobId: string; job: JobView; url: string }, spec: PayloadSpec, version: number, now: number, userId: string): { payload: Record<string, unknown>; secrets: string[]; hidden: string[]; needsYou: boolean } {
  const resumeName = spec.resumeName ? "adaline-cv-2026.pdf" : null;
  const fields: Record<string, unknown>[] = spec.fields.map((f) => ({ name: f.name, label: f.label, ...(f.type ? { type: f.type } : {}), value: f.value }));
  if (spec.resumeFileField) fields.unshift({ name: "resume", label: "Resume/CV", type: "input_file", value: resumeName ?? RESUME_SHA });
  const secrets = spec.fields.filter((f) => f.secret).map((f) => f.label);
  const hidden = spec.fields.filter((f) => f.secret && f.value !== "").map((f) => String(f.value));
  let needsYou = spec.fields.some((f) => !!f.secret);
  const p: Record<string, unknown> = { version: 1, user_id: userId, job_id: post.jobId, company: post.job.company || "Employer", url: post.url, fields,
    privacy_epoch: 0, account_version: 0, expires_at: new Date(now + 30 * DAY).toISOString(), resume_sha256: RESUME_SHA, ...(resumeName ? { resume_name: resumeName } : {}) };
  if (spec.cover) p.cover_note = spec.cover === "str" ? `I like this team. (v${version})` : { text: spec.cover === "long" ? `${"I would bring careful work to this team. ".repeat(60)}(v${version})` : `I built the pricing model. (v${version})` };
  if (spec.pageFields) p.page_field_names = ["g-recaptcha-response", "utm_source"];
  if (spec.destination === "apply") p.destination = `${post.url.replace(/\?.*$/, "")}/apply`;
  if (spec.destination === "byhand") p.destination = "https://www.linkedin.com/jobs/apply/77";
  if (spec.extra === "plain") p.referral = `Jamie Ortiz (v${version})`;
  if (spec.extra === "object") p.answers_meta = { source: "careers page", attempt: version };
  if (spec.extra === "secret_key") { p.api_key = `sk-${SECRET_MARK}key${version}abcdefghijklmnop`; secrets.push("api_key"); hidden.push(String(p.api_key)); needsYou = true; }
  if (spec.extra === "nested_secret") { p.account = { password: `${SECRET_MARK}nested${version}` }; secrets.push("account.password"); hidden.push(`${SECRET_MARK}nested${version}`); needsYou = true; }
  if (!spec.cover && !spec.fields.length) p.version_note = version; // a re-prepare always changes the hash
  else if (spec.cover === null) p.attempt = version;
  return { payload: p, secrets, hidden, needsYou };
}
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}` : JSON.stringify(v);

function profileFacts(needsSponsor: boolean) {
  const profile: any = CareerProfile.createProfile({});
  CareerProfile.addFact(profile, { needs_confirmation: false, status: "confirmed", kind: "eligibility", text: needsSponsor ? "Needs visa sponsorship" : "Does not need visa sponsorship", value: needsSponsor ? "yes" : "no", screen_key: "sponsorship", source: "screen_answer", evidence: ["x"] });
  return { profile, facts: chatScreenFacts(CareerProfile.confirmedFacts(profile), []) };
}

// Shared by both worlds: each posting's static truth (its links, its JobView as the bot stored it, its stored posting row).
async function postsOf(s: Scenario, now: number, userId: string, salt: number): Promise<Post[]> {
  const r = rng(s.id * 31 + 7);
  const posts: Post[] = [];
  for (const p of s.postings) {
    const id = 4_000_000 + salt * 100 + p.n, board = (p.slug ?? `b${p.n}`).slice(0, 30), uuid = `${(salt * 1000 + p.n).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(s.id).padStart(12, "0")}`;
    let { url, jobId } = urlOf(p, id, board, uuid);
    const twin = p.twinOf !== null && !BY_HAND.includes(s.postings[p.twinOf - 1].url) && s.postings[p.twinOf - 1].url !== "http_gh";
    if (twin) url = posts[p.twinOf! - 1].url; // the same posting link under another id (its host is then not this employer's own)
    const desc = descText(p, r);
    const ago = (d: number | null) => d === null ? null : new Date(now - d * DAY).toISOString();
    const rowOk = p.hasRow && /^(greenhouse|lever|ashby):/.test(jobId);
    const row: PostingRow | null = rowOk ? { job_id: jobId, provider: jobId.split(":")[0], company: p.company || "Employer", title: p.title, location: p.rowLoc ?? "", url: url.replace(/^http:/, "https:").replace(/^javascript:/, "https:"),
      description: desc ?? "", remote: p.remote, seniority_band: null, posted_at: ago(p.postedDaysAgo), first_seen_at: ago(p.postedDaysAgo ?? 3) ?? new Date(now - 3 * DAY).toISOString(), pay: p.rowPay,
      closed_at: p.shape === "closed" ? new Date(now - DAY).toISOString() : null } : null;
    const deadline = p.hitDeadlineDays === null ? null : p.hitDeadlineDays === "garbage" ? "soon-ish" : new Date(now + p.hitDeadlineDays * DAY).toISOString();
    const hit: Record<string, unknown> = { job_id: jobId, company: p.company, title: p.title, url, ...(p.hitLoc ? { location: p.hitLoc } : {}), ...(p.hitPay ? { pay: p.hitPay } : {}),
      ...(deadline ? { deadline } : {}), ...(p.reasons.length ? { fit: { reasons: p.reasons } } : {}), ...(statedDomainOf(p) !== null ? { company_domain: statedDomainOf(p) } : {}) };
    const job = jobViewOf(hit, row);
    const src = twin ? s.postings[p.twinOf! - 1] : null;
    const own = p.domain === "stated" || p.domain === "stated_url" || !src ? ownDomainOf(p) : src.company === p.company && (src.url === "own_gh" || src.url === "own_link") ? ownDomainOf({ ...src, domain: "none" }) : null;
    posts.push({ spec: p, n: p.n, job, ref: await refOf(userId, jobId), url, jobId, ownDomain: own, row, deadline, hashes: [] });
  }
  return posts;
}
const appRowOf = (a: App, company: string, now: number): AppRow => ({ id: `app-${a.job_id}`, state: a.state, reason: a.reason, confirmation_id: a.state === "confirmed" ? "C-1" : null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  email_confirmed_at: null, payload: a.payload, company, url: a.url });

// ---------------------------------------------------------------- the memory world (the database's rules as plain code)
// hooks.approving: awaited by every approval step that can interleave with another request's (the card read after an open, and a
// confirm before it runs), so a test can hold requests there and force an interleaving.
async function memWorld(s: Scenario, auth: ReturnType<typeof signedIn>, hooks: { approving?: (what: "card" | "confirm") => Promise<void> } = {}): Promise<World> {
  const now = T0;
  const posts = await postsOf(s, now, U, s.id % 1000);
  const r0 = rng(s.id * 13 + 1);
  const preps: Prep[][] = posts.map(() => []);
  const apps = new Map<string, App>(); // by job id (once per posting: the database's unique row)
  const wanted = new Map<string, { url: string }>(); // by posting key
  const approvals = new Map<string, number>();
  let pidN = 0, cardN = 0;
  const pid = () => `33333333-3333-4333-8333-${String(s.id * 1000 + ++pidN).padStart(12, "0")}`;
  const addPrep = async (i: number, spec: PayloadSpec) => {
    const p = posts[i], version = p.hashes.length + 1;
    const made = payloadOf(p, spec, version, now, U);
    const hash = await sha(canonical(made.payload));
    for (const old of preps[i]) if (old.state === "ready" || old.state === "shown") old.state = "expired";
    preps[i].push({ id: pid(), payload: made.payload, hash, state: "ready", secrets: made.secrets, hidden: made.hidden, needsYou: made.needsYou });
    p.hashes.push(hash);
  };
  const cur = (i: number) => preps[i].findLast((x) => x.state === "ready" || x.state === "shown") ?? null;
  const open = (x: Prep) => x.state === "ready" || x.state === "shown";
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i].spec;
    if (p.prep) await addPrep(i, p.prep);
    if (p.app) apps.set(posts[i].jobId, { state: p.app, reason: p.appReason, job_id: posts[i].jobId, url: posts[i].url, payload: {}, via: "elsewhere" });
    if (p.wanted) { const w = KEY_OF(posts[i]); if (w.ok[0]) wanted.set(w.ok[0].posting_key, { url: w.ok[0].url }); }
  }
  const idx = (jobId: string) => posts.findIndex((p) => p.jobId === jobId);
  const sentByLink = (jobId: string, url: string) => apps.has(jobId) || [...apps.values()].some((a) => a.url === url);
  const kv = new Map<string, unknown>();
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return (kv.get(`${u}|job|${ref}`) as any) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, refs); },
    async recallList(u, id) { return (kv.get(`${u}|list|${id}`) as string[]) ?? null; },
    async postings(ids) { return posts.filter((p) => p.row && ids.includes(p.jobId)).map((p) => ({ ...p.row! })); },
    async save() { return "saved"; },
    async prepared(u, jobId) {
      const i = idx(jobId); if (u !== U || i < 0) return null;
      const p = cur(i); return p ? { id: p.id, job_id: jobId, company: String(p.payload.company), url: posts[i].url, payload: structuredClone(p.payload), payload_hash: p.hash, card_lines: [], state: "ready" } as PreparedRow : null;
    },
    async applied(u, jobId) { return u === U && apps.has(jobId); },
    // The real store's want (telegram_jobs.ts supabaseJobStore.want over career_apply_want_put_for): the posting's key, once.
    async want(u, job) {
      const w = wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title } as any], now);
      if (w.refused.length) { world.wantCalls.push({ key: job.job_id, result: "refused" }); return { result: "refused", reason: w.refused[0].reason }; }
      const it = w.ok[0];
      if (wanted.has(it.posting_key)) { world.wantCalls.push({ key: it.posting_key, result: "already" }); return { result: "already" }; }
      if (sentByLink(it.posting_key, it.url)) { world.wantCalls.push({ key: it.posting_key, result: "duplicate" }); return { result: "refused", reason: "this posting is already in your applications, and each posting goes at most once" }; }
      wanted.set(it.posting_key, { url: it.url });
      world.wantCalls.push({ key: it.posting_key, result: "queued" });
      void u;
      return { result: "queued" };
    },
    // The real store's reads (trainee-file/store.ts): the application by its posting id, else by the posting's link; "to be prepared" by the posting's key.
    async appRow(u, jobId, url?: string) {
      if (u !== U) return null;
      const a = apps.get(jobId) ?? (url ? [...apps.values()].find((x) => x.url === url) : undefined);
      return a ? appRowOf(a, posts[Math.max(0, idx(a.job_id))].job.company, now) : null;
    },
    async wanted(u, url, job?: JobView) {
      if (u !== U) return false;
      if (job) { const w = wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title } as any], now); if (w.ok[0]) return wanted.has(w.ok[0].posting_key); }
      return [...wanted.values()].some((x) => x.url === url);
    },
  };
  const cards = new Map<string, { id: string; user_id: string; items: { n: number; prepared_id: string; payload_hash: string }[]; state: string; shown_at: string }>();
  const prepById = (id: string) => { for (let i = 0; i < preps.length; i++) for (const p of preps[i]) if (p.id === id) return { i, p }; return null; };
  const tap: TapStore = {
    async card(u, id) { await hooks.approving?.("card"); const c = cards.get(id); return c && c.user_id === u ? structuredClone(c) : null; },
    async prepared(u, ids) { return ids.map((id) => prepById(id)).filter(Boolean).map((x) => ({ id: x!.p.id, payload_hash: x!.p.hash, company: String(x!.p.payload.company) })); void u; },
    // career_apply_card_answer_for: once per card, each item only if it still hashes to the card's hash; career_apply_enqueue: once per posting (its id or its link).
    async answer(u, cardId, approve) { return answerCard(u, cardId, approve); },
  };
  function answerCard(u: string, cardId: string, approve: number[]) {
      const c = cards.get(cardId);
      if (!c || c.user_id !== u) throw new Error("invalid card answer");
      if (c.state !== "open") throw new Error("card_answered");
      c.state = "answered";
      return c.items.map((it) => {
        const x = prepById(it.prepared_id)!;
        let result: string;
        if (x.p.hash !== it.payload_hash) result = "changed";
        else if (!approve.includes(it.n)) result = "declined";
        else if (!open(x.p)) result = "refused";
        else if (sentByLink(posts[x.i].jobId, posts[x.i].url)) result = "duplicate";
        else {
          apps.set(posts[x.i].jobId, { state: "queued", reason: null, job_id: posts[x.i].jobId, url: posts[x.i].url, payload: x.p.payload, via: "approval" });
          approvals.set(posts[x.i].jobId, (approvals.get(posts[x.i].jobId) ?? 0) + 1);
          result = "queued";
        }
        x.p.state = result === "queued" ? "approved" : "declined";
        return { n: it.n, company: String(x.p.payload.company), result };
      });
  }
  // career_apply_card_open_for: every item ready or shown, each now shown; a newer card closes the person's other open cards.
  const openCard = (u: string, ids: string[]) => {
    const items = ids.map((id, k) => { const x = prepById(id); if (!x || !open(x.p)) throw new Error("invalid card"); return { n: k + 1, prepared_id: id, payload_hash: x.p.hash }; });
    for (const id of ids) prepById(id)!.p.state = "shown";
    for (const c of cards.values()) if (c.user_id === u && c.state === "open") c.state = "answered";
    const id = `44444444-4444-4444-8444-${String(s.id * 1000 + ++cardN).padStart(12, "0")}`;
    cards.set(id, { id, user_id: u, items, state: "open", shown_at: new Date(now).toISOString() });
    return { id, items, shown_at: new Date(now).toISOString() };
  };
  const { facts } = profileFacts(s.needsSponsor);
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot", TRAINEE_LOGO_URL: LOGO_TPL[s.logo] || undefined };
  const deps: FileDeps = { ...auth.deps, store, now: () => now, env: { get: (k) => env[k] }, events: null, facts: async () => facts,
    cards: {
      async open(u, ids) { return openCard(u, ids) as any; },
      // career_apply_card_confirm_for: the hashes the person approved, then the open and the answer with nothing in between.
      async confirm(u, ids, hashes) {
        await hooks.approving?.("confirm");
        if (ids.some((id, k) => prepById(id)?.p.hash !== hashes[k])) throw new Error("card_changed");
        const card = openCard(u, ids);
        return { card, results: answerCard(u, card.id, card.items.map((x) => x.n)) } as any;
      },
    },
    tap };
  for (const p of posts) await store.remember(U, p.ref, p.job, "text");
  await store.rememberList(U, LIST, posts.map((p) => p.ref));
  const world: World = {
    posts, scenario: s, now, deps, wantCalls: [],
    async snapshot() {
      const ps = posts.map((_, i) => cur(i));
      const as = posts.map((p) => apps.get(p.jobId) ?? [...apps.values()].find((a) => a.url === p.url) ?? null);
      const ws = posts.map((p) => { const w = KEY_OF(p); return !!w.ok[0] && wanted.has(w.ok[0].posting_key); });
      return { preps: ps.map((p) => p && { ...p }), apps: as.map((a) => a && { ...a }), appByJob: new Map(apps), wanted: ws, rows: posts.map((p) => p.row && { ...p.row }), approvals: new Map(approvals) };
    },
    async mutate(step, r) {
      if (step.k === "payload") {
        const i = step.row % posts.length, p = posts[i];
        if (apps.has(p.jobId) || BY_HAND.includes(p.spec.url) || p.spec.url === "js_linkedin") return; // career_apply_prepare_own refuses a posting already applied for
        const c = cur(i);
        if (step.op === "unprepare") { if (c) c.state = "expired"; return; }
        if (step.op === "prepare" && c) return;
        const base: PayloadSpec = p.spec.prep ? structuredClone(p.spec.prep) : { fields: [{ name: "email", label: "Email", value: "adaline@example.test" }], cover: "obj", pageFields: false, destination: "apply", extra: "none", resumeName: true, resumeFileField: false };
        if (step.op === "secret") base.fields.push({ name: "otp", label: "One-time code", type: "one-time-code", value: `${SECRET_MARK}otp${p.hashes.length}`, secret: "verify_code" });
        await addPrep(i, base);
      } else if (step.k === "elsewhere") {
        const p = posts[step.row % posts.length];
        const a = apps.get(p.jobId);
        if (a) a.state = step.state; else apps.set(p.jobId, { state: step.state, reason: null, job_id: p.jobId, url: p.url, payload: {}, via: "elsewhere" });
      } else if (step.k === "close") {
        const p = posts[step.row % posts.length]; if (p.row) p.row.closed_at = new Date(now - 60_000).toISOString();
      } else if (step.k === "prepare_wanted") {
        for (let i = 0; i < posts.length; i++) {
          const w = KEY_OF(posts[i]);
          if (w.ok[0] && wanted.has(w.ok[0].posting_key) && !cur(i) && !apps.has(posts[i].jobId)) await addPrep(i, posts[i].spec.prep ?? { fields: [{ name: "first_name", label: "First name", value: "Adaline" }], cover: null, pageFields: false, destination: "apply", extra: "none", resumeName: true, resumeFileField: true });
        }
      }
      void r;
    },
  };
  void r0;
  return world;
}

// ---------------------------------------------------------------- the oracle: what each row must show, from the world's truth
const APP_WORD: Record<string, string> = { queued: "Queued", driving: "Sending", submitted_unconfirmed: "Submitted", confirmed: "Confirmed", failed: "Failed", not_submitted: "Not submitted", needs_user: "Needs you", unknown_outcome: "Unknown" };
interface Expect { chip: string | null; byHand: boolean; link: string | null; blocked: boolean; why: string; form: string | null; approvable: boolean; send: string[] | null; hidden: string[] }
function expectRow(w: World, i: number, S: Snapshot, firstUrl: Map<string, number>): Expect {
  const p = w.posts[i], prep = S.preps[i], app = S.apps[i], row = S.rows[i];
  const hidden = prep?.hidden ?? [];
  const chip = app ? (APP_WORD[app.state] ?? "Unknown") : prep?.needsYou ? "Needs you" : !prep && S.wanted[i] ? "Preparing" : null;
  const byHand = neverOpen(hostOf(p.url)) || /linkedin|indeed|joinhandshake|lnkd/i.test(hostOf(p.url));
  // TELEGRAM SCENARIOS (2026-10-30): a posting past its own deadline is expired, never approvable (stricter than before: it was offered).
  const expired = p.deadline !== null && !Number.isNaN(Date.parse(p.deadline)) && Date.parse(p.deadline) < w.deps.now();
  const screened = !row || !!row.closed_at || expired || p.spec.shape === "stale" || p.spec.shape === "scam" || (p.spec.shape === "knockout" && w.scenario.needsSponsor);
  const twin = (firstUrl.get(p.url) ?? i) < i; // the same posting link as an earlier row
  const toByHand = prep && typeof prep.payload.destination === "string" && neverOpen(hostOf(String(prep.payload.destination)));
  const blocked = !chip && !byHand && (screened || twin || !!toByHand);
  const form = chip || byHand || blocked ? null : prep ? hashTag(prep.hash) : "none";
  return { why: screened ? "screen" : twin ? "twin" : toByHand ? "destination" : "", chip, byHand, link: byHand && !chip && /^https?:\/\//i.test(p.url) ? p.url : null, blocked, form, approvable: !!form && form !== "none", send: !app && prep ? sendOf(prep) : null, hidden };
}
// "What we send": every value of the payload the hash covers, and nothing else.
const INTERNAL = new Set(["version", "user_id", "job_id", "company", "url", "title", "fields", "resume_sha256", "resume_name", "resume_file", "cover_note", "page_field_names", "destination",
  "privacy_epoch", "account_version", "expires_at", "kind", "resume_tailored", "resume_persona"]);
function sendOf(prep: Prep): string[] {
  const pl = prep.payload as any, out: string[] = [];
  const resume = pl.resume_name ?? `resume ${String(pl.resume_sha256).slice(0, 12)}`;
  out.push(`Resume: ${resume}`);
  for (const f of pl.fields as any[]) {
    const label = norm(f.label ?? f.name) || "Field";
    if (prep.secrets.includes(f.label)) { out.push(`${label}: Needs you`); continue; }
    if (/file/i.test(String(f.type ?? "")) && (f.value === pl.resume_name || f.value === pl.resume_sha256)) continue;
    const v = f.value;
    const shown = v === "" || v === null || v === undefined ? "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v);
    out.push(`${label}: ${/file/i.test(String(f.type ?? "")) ? `file ${shown}` : shown}`);
  }
  const cover = typeof pl.cover_note === "string" ? pl.cover_note : pl.cover_note?.text;
  if (cover) out.push(`Cover note: ${cover}`);
  if (pl.page_field_names?.length) out.push(`Also sent, set by the employer's page, unchanged: ${pl.page_field_names.join(", ")}`);
  for (const [k, v] of Object.entries(pl)) {
    if (INTERNAL.has(k)) continue;
    out.push(prep.secrets.some((x) => x === k || x.startsWith(`${k}.`)) ? `${k}: Needs you` : `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  out.push(`Sends to: ${hostOf(String(pl.destination ?? pl.url))}`);
  return out.map(norm);
}
async function setHashOf(w: World, ex: Expect[]): Promise<{ hash: string | null; size: number; members: number[] }> {
  const members = ex.map((e, i) => e.approvable ? i : -1).filter((i) => i >= 0);
  if (!members.length) return { hash: null, size: 0, members };
  return { hash: (await sha(`v1|${members.map((i) => `${w.posts[i].ref}:${ex[i].form}`).join(",")}`)).slice(0, 16), size: members.length, members };
}
function expectAll(w: World, S: Snapshot): Expect[] {
  const firstUrl = new Map<string, number>();
  w.posts.forEach((p, i) => { if (!firstUrl.has(p.url)) firstUrl.set(p.url, i); });
  return w.posts.map((_, i) => expectRow(w, i, S, firstUrl));
}

// ---------------------------------------------------------------- reading the page
interface SeenRow { ref: string; html: string; name: string; img: string | null; chip: string | null; tag: string | null; link: string | null; role: string; desc: string; send: string[] | null; meta: string[]; why: string | null; note: string }
interface Seen { rows: SeenRow[]; set: string | null; setSize: number | null; top: string; html: string }
function readPage(html: string): Seen {
  const parts = html.split('<li class="row" id="r-').slice(1);
  const rows = parts.map((raw) => {
    const h = raw;
    const m = (re: RegExp) => re.exec(h)?.[1] ?? null;
    const sendUl = m(/<ul class="send">([\s\S]*?)<\/ul>/);
    return {
      ref: unesc(raw.slice(0, raw.indexOf('"'))), html: h, name: unesc(m(/<span class="name">([\s\S]*?)<\/span>/) ?? ""), img: m(/<img src="([^"]*)"/), chip: m(/<span class="chip [a-z-]+" role="status">([^<]*)<\/span>/),
      tag: m(/<input type="hidden" name="action" value="apply"><input type="hidden" name="ref" value="[^"]*"><input type="hidden" name="tag" value="([^"]*)">/),
      link: m(/<a class="apply" href="([^"]*)"/), role: textOf(m(/<span class="role">([\s\S]*?)<\/span>/) ?? ""), desc: textOf(m(/<span class="desc">([\s\S]*?)<\/span>/) ?? ""),
      send: sendUl === null ? null : [...sendUl.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => textOf(x[1])), meta: [...h.matchAll(/<p class="meta">([\s\S]*?)<\/p>/g)].map((x) => textOf(x[1])),
      why: m(/<p class="why">([\s\S]*?)<\/p>/), note: textOf([...h.matchAll(/<p class="note">([\s\S]*?)<\/p>/g)].map((x) => x[1]).join(" ")),
    };
  });
  return { rows, set: /name="set" value="([^"]*)"/.exec(html)?.[1] ?? null, setSize: Number(/>Apply to all (\d+)</.exec(html)?.[1] ?? 0) || null, top: textOf(/<p class="top-note" role="alert">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ""), html };
}

// ---------------------------------------------------------------- the report
interface Report { handlerMs: number; violations: Map<string, string[]>; requests: number; approvals: number; wants: number; refused: number; statuses: Record<number, number>; liveness: Record<string, number>; scenarios: number }
const newReport = (): Report => ({ handlerMs: 0, violations: new Map(), requests: 0, approvals: 0, wants: 0, refused: 0, statuses: {}, liveness: {}, scenarios: 0 });
function printReport(label: string, rep: Report): number {
  let failed = 0;
  for (const [k, list] of rep.violations) { failed += list.length; console.log(`  VIOLATION ${k}: ${list.length}\n    ${list.slice(0, 4).join("\n    ")}`); }
  console.log(`[file-apply] ${label}: ${rep.scenarios} scenarios, ${rep.requests} requests (${(rep.handlerMs / 1000).toFixed(1)} s in the handler), ${rep.approvals} approvals, ${rep.wants} queued to prepare, ${rep.refused} refused taps; statuses ${JSON.stringify(rep.statuses)}; liveness ${JSON.stringify(rep.liveness)}; ${failed} violations`);
  return failed;
}

// R16: employer-domain default. With no provider configured the logo is the employer's own domain through the page's own origin.
const LOGO_SRC = (tpl: string, dom: string) => tpl ? tpl.split("{domain}").join(encodeURIComponent(dom)) : `?logo=${encodeURIComponent(dom)}`;
const ALLOWED_TAGS = new Set(["html", "head", "meta", "link", "title", "style", "body", "div", "header", "svg", "rect", "text", "span", "h1", "p", "form", "input", "button", "main", "ul", "li", "img", "details", "summary", "a", "strong", "footer", "script"]);
const CODES = /\b(duplicate_job|daily_cap|no_resume|pace_unreadable|company_cooldown|not_submitted|needs_user|unknown_outcome|submitted_unconfirmed|invalid card)\b/;

// Everything that must hold for one page, against the truth right after it was drawn.
function checkPage(w: World, S: Snapshot, ex: Expect[], set: { hash: string | null; size: number }, html: string, fail: (k: string, m: string) => void, o: { full: boolean }) {
  const seen = readPage(html);
  // escaping and markup: only the page's own tags and attributes; no event handler; no script link; no bidi override
  for (const t of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    if (!ALLOWED_TAGS.has(t[1].toLowerCase())) fail("markup: a foreign tag reached the page", t[0].slice(0, 80));
    for (const a of t[2].replace(/"[^"]*"/g, '""').matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?==|\s|$)/g)) if (/^on/i.test(a[1])) fail("markup: an event-handler attribute reached the page", t[0].slice(0, 80));
  }
  if ((html.match(/<script\b/g) ?? []).length !== 2) fail("markup: a script tag other than the page's own", String((html.match(/<script\b/g) ?? []).length));
  for (const h of html.matchAll(/href="([^"]*)"/g)) if (!/^(https?:\/\/|data:image\/svg\+xml)/i.test(unesc(h[1]))) fail("markup: a link that is not http(s)", h[1].slice(0, 80));
  if (BIDI.test(html)) fail("markup: a bidi override or isolate reached the page", JSON.stringify(html.match(BIDI)?.[0]));
  BIDI.lastIndex = 0;
  for (const e of ex) for (const hsec of e.hidden) { const head = hsec.split(" ")[0]; if (html.includes(hsec) || (head.length >= 8 && html.includes(head))) fail("secret: a secret-looking value was printed", hsec.slice(0, 40)); }
  if (html.includes(SECRET_MARK)) fail("secret: a secret-looking value was printed", html.slice(html.indexOf(SECRET_MARK) - 40, html.indexOf(SECRET_MARK) + 20));
  const plainAll = textOf(html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ")).replace(/Not applied for automatically on this site/g, "");
  if (/\bapplied\b/i.test(plainAll)) fail("status: 'applied' was said", plainAll.slice(Math.max(0, plainAll.search(/\bapplied\b/i) - 60), plainAll.search(/\bapplied\b/i) + 30));
  if (CODES.test(plainAll)) fail("status: a raw code was shown to the person", plainAll.match(CODES)![0]);
  if (!o.full) return;
  if (seen.rows.length !== w.posts.length) { fail("list: not one row per posting", `${seen.rows.length} of ${w.posts.length}`); return; }
  // Apply to all: exactly the approvable set
  if ((set.size >= 2) !== (seen.setSize !== null)) fail("apply to all: shown when it should not be, or missing", `${seen.setSize} vs ${set.size}`);
  if (seen.setSize !== null && (seen.setSize !== set.size || seen.set !== set.hash)) fail("apply to all: not exactly the approvable set", `${seen.setSize} vs ${set.size}`);
  const tpl = LOGO_TPL[w.scenario.logo];
  const providerOk = !tpl || /^https:\/\//.test(tpl);
  const names = new Set<string>();
  seen.rows.forEach((r, i) => {
    const p = w.posts[i], e = ex[i], row = S.rows[i], id = `#${w.scenario.id} row ${i + 1} (${p.spec.url}/${p.spec.shape}${S.apps[i] ? `/app ${S.apps[i]!.state}` : ""}${S.preps[i] ? "/prep" : ""})`;
    if (r.ref !== p.ref) fail("list: rows out of order", id);
    if (norm(r.name) !== norm(p.job.company)) fail("detail: the company is not the posting's", `${id}: ${r.name}`);
    if (norm(r.role) !== norm(p.job.title)) fail("detail: the title is not the posting's", `${id}: ${r.role}`);
    // the logo
    const want = providerOk && p.ownDomain ? LOGO_SRC(tpl, p.ownDomain) : null;
    if ((r.img ? unesc(r.img) : null) !== want) fail("logo: not the employer's own domain through the configured https provider", `${id}: ${r.img ? unesc(r.img) : "lettermark"} vs ${want ?? "lettermark"}`);
    // the status word and the action
    if (r.chip !== e.chip) fail("status: the word is not the row's truth", `${id}: ${r.chip} vs ${e.chip}`);
    if (e.form === null && r.tag !== null) fail(e.byHand ? "by hand: an Apply button on a never-automated site" : e.blocked ? (e.why === "screen" ? "screen: Apply offered on a posting that cannot pass the screen (closed, stale, scam-looking, knock-out, not on file)" : e.why === "twin" ? "duplicate: Apply offered on a second row for a posting already on the list" : "by hand: Apply offered on an application that would go to a never-automated site") : e.chip === "Needs you" ? "secret: a row that needs you is one-tap approvable" : "status: Apply offered on a row already in motion", `${id}: tag ${r.tag}`);
    if (e.form !== null && r.tag !== e.form) fail("apply: the row's Apply is not bound to the current payload", `${id}: ${r.tag} vs ${e.form}`);
    if (r.link !== null && (!e.byHand || unesc(r.link) !== e.link)) fail("by hand: a link out where there should be none", `${id}: ${r.link}`);
    if (e.link && unesc(r.link ?? "") !== e.link) fail("by hand: the never-automated row does not link to the posting", id);
    if (e.byHand && !e.chip && !/Not applied for automatically/.test(r.note)) fail("by hand: the row does not say it is not automated", id);
    if (e.blocked && !e.chip && !r.note) fail("screen: a row that is not offered does not say why", id);
    // what we send
    if (e.send === null && r.send !== null) fail("what we send: a list on a row with nothing to approve", `${id}`);
    if (e.send !== null) {
      if (r.send === null) fail("what we send: the payload's values are not shown", id);
      else if (JSON.stringify(r.send) !== JSON.stringify(e.send)) {
        const miss = e.send.filter((x) => !r.send!.includes(x)), extra = r.send.filter((x) => !e.send!.includes(x));
        fail("what we send: not exactly the payload's values", `${id}: missing ${JSON.stringify(miss.map((x) => x.slice(0, 70)))} extra ${JSON.stringify(extra.map((x) => x.slice(0, 70)))}`);
      }
    }
    const sendsLine = r.meta.find((x) => x.startsWith("Sends: "));
    if (sendsLine && (!S.preps[i] || S.apps[i] || S.preps[i]!.needsYou)) fail("what we send: a 'Sends:' line with nothing to send", id);
    if (sendsLine && S.preps[i] && !sendsLine.includes(String(S.preps[i]!.payload.resume_name ?? `resume ${RESUME_SHA.slice(0, 12)}`))) fail("what we send: the 'Sends:' line names another resume", `${id}: ${sendsLine}`);
    if (sendsLine && /saved answers/.test(sendsLine) && !(S.preps[i]!.payload.fields as any[]).some((f) => f.value !== "" && f.value !== null)) fail("what we send: the 'Sends:' line claims answers the payload does not carry", `${id}: ${sendsLine}`);
    if (!S.apps[i] && S.preps[i]) names.add(String(S.preps[i]!.payload.resume_name ?? `resume ${RESUME_SHA.slice(0, 12)}`));
    // the key details: the stored posting's, or the search result's labelled
    const meta = r.meta.find((x) => !x.startsWith("Sends: "));
    if (meta) {
      const bits = meta.split(" · ");
      const label = bits.at(-1) === "Reported, not verified" || bits.at(-1) === "From the posting" ? bits.pop() : null;
      if (!label) fail("detail: key details without a source label", `${id}: ${meta}`);
      let reported = false;
      for (const b of bits) {
        if (ROW_LOCS.map(norm).includes(b)) { if (!row || norm(row.location) !== b) fail("detail: a location the posting does not state", `${id}: ${b}`); }
        else if (ROW_PAYS.map(norm).includes(b)) { if (!row || norm(row.pay) !== b) fail("detail: pay the posting does not state", `${id}: ${b}`); }
        else if (HIT_LOCS.map(norm).includes(b)) { reported = true; if (norm(p.job.location) !== b || (row && row.location)) fail("detail: a location neither stated nor reported", `${id}: ${b}`); }
        else if (HIT_PAYS.map(norm).includes(b)) { reported = true; if (norm(p.job.pay) !== b || (row && row.pay)) fail("detail: pay neither stated nor reported", `${id}: ${b}`); }
        else if (b.startsWith("Apply by ")) { reported = true; if (b !== `Apply by ${dayOf(p.deadline)}`) fail("detail: a deadline neither stated nor reported", `${id}: ${b}`); }
        else if (b === sourceOf(p.jobId, row?.provider)) { /* where it was found */ }
        else fail("detail: a detail from nowhere", `${id}: ${b}`);
      }
      if (reported && label !== "Reported, not verified") fail("detail: a search-only detail not labelled 'Reported, not verified'", `${id}: ${meta}`);
    }
    // the short description: the posting's own words, else what the posting states; never a search-only detail
    for (const loc of [...HIT_LOCS, ...ROW_LOCS]) if (r.desc.includes(norm(loc)) && !(row && (norm(row.location) === norm(loc) || norm(row.description).includes(norm(loc))))) fail("detail: the short description carries a detail the posting does not state", `${id}: ${loc}`);
    if (r.why !== null) {
      const said = textOf(r.why).replace(/^Why it fits you: /, "");
      if (said !== norm(p.job.reasons.slice(0, 2).join(" "))) fail("detail: a fit reason the tools did not give", `${id}: ${said}`);
    }
  });
  const withLine = /<p class="with">Applying with: ([^<]*)<\/p>/.exec(html)?.[1];
  for (const nm of withLine ? unesc(withLine).split(", ") : []) if (!names.has(nm)) fail("what we send: 'Applying with' names a resume no row sends", nm);
}

// ---------------------------------------------------------------- the runner
// Taps at once are judged as SOME one-at-a-time order of them (each against the list as the ones before it left it), never as
// all of them against the list before any ran: an Apply that queued a row first legitimately changes the set an Apply to all
// carries (it then approves nothing, by its contract), and an Apply to all that ran first leaves the Apply nothing to do. What
// each order approves, from this file's own model of the truth: the exact current tag of an approvable row approves it; the
// exact current set approves every member; a row approved earlier in the order is in the applications (as is its twin by link).
function withApproved(w: World, S: Snapshot, i: number): Snapshot {
  const p = w.posts[i];
  const app: App = { state: "queued", reason: null, job_id: p.jobId, url: p.url, payload: S.preps[i]?.payload ?? {}, via: "approval" };
  return { ...S, apps: S.apps.map((a, j) => a ?? (w.posts[j].jobId === p.jobId || w.posts[j].url === p.url ? app : null)) };
}
const ordersOf = <T,>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, k) => ordersOf([...xs.slice(0, k), ...xs.slice(k + 1)]).map((rest) => [x, ...rest]));
async function serialOutcomes(w: World, S0: Snapshot, reqs: { kind: string; i: number; tag?: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // the approved rows (sorted, joined) -> one order that approves exactly them
  for (const order of ordersOf(reqs.map((r, k) => ({ ...r, k })))) {
    let S = S0;
    const approved = new Set<number>();
    for (const r of order) {
      const ex = expectAll(w, S);
      const go = r.kind === "apply" ? (ex[r.i].approvable && r.tag === ex[r.i].form ? [r.i] : [])
        : r.kind === "applyall" ? await (async () => { const c = await setHashOf(w, ex); return c.hash && r.tag === c.hash ? c.members : []; })() : [];
      for (const i of go) { approved.add(i); S = withApproved(w, S, i); }
    }
    const key = [...approved].sort((a, b) => a - b).join(",");
    if (!out.has(key)) out.set(key, order.map((r) => `${r.kind}#${r.k + 1}`).join(" then "));
  }
  return out;
}

async function runScenario(s: Scenario, w: World, rep: Report, tok: string, o: { parOrder?: "forward" | "reverse" } = {}): Promise<Seen | null> {
  rep.scenarios++;
  const fail = (k: string, m: string) => { const l = rep.violations.get(k) ?? []; if (l.length < 50) l.push(m); else l.length++; rep.violations.set(k, l); };
  const r = rng(s.id * 101 + 3);
  let seen: Seen | null = null;
  const pages: Seen[] = []; // every page the person saw (stale sets come from here)
  const send = async (f: Record<string, string> | null, text = false): Promise<{ status: number; html: string }> => {
    rep.requests++; const t0 = performance.now();
    let res: Response;
    try {
      res = f ? await handleFile(new Request("https://x.example/f", await phonePost({ t: tok, ...f }, w.deps.env.get("TRAINEE_FILE_LINK_SECRET") ?? "")), w.deps)
        : await handleFile(new Request(`https://x.example/f${text ? "?format=text" : ""}`, { headers: { cookie: `tf_s=${tok}` } }), w.deps);
    } catch (e) { fail("handler: threw", `#${s.id}: ${String(e).slice(0, 120)}`); return { status: 0, html: "" }; }
    rep.statuses[res.status] = (rep.statuses[res.status] ?? 0) + 1;
    const body = await res.text(); rep.handlerMs += performance.now() - t0; return { status: res.status, html: body };
  };
  const tagFor = (st: Extract<Step, { k: "apply" }>, ex: Expect[]): string => {
    const i = st.row % w.posts.length, p = w.posts[i];
    switch (st.tag) {
      case "seen": return seen?.rows[i]?.tag ?? "none";
      case "current": return ex[i].form ?? (w.posts[i].hashes.length ? hashTag(w.posts[i].hashes.at(-1)!) : "none");
      case "stale": return p.hashes.length >= 2 ? hashTag(p.hashes[st.r % (p.hashes.length - 1)]) : (st.r % 2 ? "0123456789abcdef" : "none");
      case "other_row": { const o = w.posts[(i + 1 + (st.r % Math.max(1, w.posts.length - 1))) % w.posts.length]; return o.hashes.length ? hashTag(o.hashes.at(-1)!) : "f".repeat(16); }
      case "none": return "none";
      case "garbage": return [`"><script>alert(1)</script>`, "zz", "", "0".repeat(15), "A".repeat(16)][st.r % 5];
    }
  };
  const setFor = (st: Extract<Step, { k: "applyall" }>, cur: { hash: string | null }): string => {
    switch (st.set) {
      case "seen": return seen?.set ?? "";
      case "current": return cur.hash ?? "";
      case "stale": return pages.find((p) => p.set && p.set !== cur.hash)?.set ?? "1234567890abcdef";
      case "garbage": return `x"><b>`;
      case "empty": return "";
    }
  };
  // One request, with what it must and must not have done.
  const one = async (st: Step, S: Snapshot, ex: Expect[], cur: { hash: string | null; size: number; members: number[] }): Promise<{ allowed: Set<number>; must: Set<number>; resp: { status: number; html: string }; kind: string; i: number; tag?: string }> => {
    const allowed = new Set<number>(), must = new Set<number>();
    if (st.k === "apply") {
      const i = st.row % w.posts.length, tag = tagFor(st, ex);
      if (ex[i].approvable && tag === ex[i].form) { allowed.add(i); must.add(i); }
      return { allowed, must, resp: await send({ action: "apply", ref: w.posts[i].ref, tag }), kind: "apply", i, tag };
    }
    if (st.k === "applyall") {
      const posted = setFor(st, cur);
      if (cur.hash && posted === cur.hash) for (const i of cur.members) { allowed.add(i); must.add(i); }
      return { allowed, must, resp: await send({ action: "applyall", set: posted }), kind: "applyall", i: -1, tag: posted };
    }
    if (st.k === "text") return { allowed, must, resp: await send(null, true), kind: "text", i: -1 };
    if (st.k === "refresh") return { allowed, must, resp: await send({ action: "refresh" }), kind: "refresh", i: -1 };
    return { allowed, must, resp: await send(null), kind: "get", i: -1 };
  };
  for (const st of s.steps) {
    if (st.k === "payload" || st.k === "elsewhere" || st.k === "close" || st.k === "prepare_wanted") { await w.mutate(st, r); continue; }
    const S = await w.snapshot(), ex = expectAll(w, S), cur = await setHashOf(w, ex);
    const wantsBefore = w.wantCalls.length;
    const reqs = st.k === "par" ? st.steps : [st];
    // o.parOrder (the regression below): the taps of a "par" step one after another, in that order, instead of at once.
    const out = st.k !== "par" ? [await one(st, S, ex, cur)] : !o.parOrder ? await Promise.all(reqs.map((x) => one(x, S, ex, cur)))
      : await (async () => { const done = new Map<Step, Awaited<ReturnType<typeof one>>>(); for (const x of o.parOrder === "reverse" ? [...reqs].reverse() : reqs) done.set(x, await one(x, S, ex, cur)); return reqs.map((x) => done.get(x)!); })();
    const S2 = await w.snapshot(), ex2 = expectAll(w, S2), cur2 = await setHashOf(w, ex2);
    // approvals: only what was allowed; everything that had to be approved was; never twice for one posting. Taps at once:
    // exactly what one of their one-at-a-time orders approves (serialOutcomes), whichever order the scheduler happened to pick.
    const allowed = new Set(out.flatMap((x) => [...x.allowed])), must = new Set(out.flatMap((x) => [...x.must]));
    if (st.k === "par") {
      const outcomes = await serialOutcomes(w, S, out);
      const got = w.posts.map((p, i) => (S2.approvals.get(p.jobId) ?? 0) > (S.approvals.get(p.jobId) ?? 0) ? i : -1).filter((i) => i >= 0);
      if (!outcomes.has(got.join(","))) {
        fail("approval: taps at once approved what no one-at-a-time order of them approves", `#${s.id} rows ${got.map((i) => i + 1).join(",") || "none"} approved; ${[...outcomes].map(([k, v]) => `${v}: ${k ? k.split(",").map((i) => Number(i) + 1).join(",") : "none"}`).join(" | ")} ${JSON.stringify(out.map((x) => [x.kind, x.tag]))}`);
      }
      // the Apply that lost to another tap of the same posting says it is already in the applications, never that it changed or failed
      for (const x of out) {
        if (x.kind !== "apply" || !x.must.size || !got.includes(x.i) || x.resp.status !== 200) continue;
        const note = readPage(x.resp.html).rows[x.i]?.note ?? "";
        if (/Changed since|changed after|could ?n.t|Nothing was approved|not approved/i.test(note)) fail("approval: a tap that lost to another approval of the same posting did not say it is already in the applications", `#${s.id} row ${x.i + 1}: ${note}`);
      }
    }
    w.posts.forEach((p, i) => {
      const before = S.approvals.get(p.jobId) ?? 0, after = S2.approvals.get(p.jobId) ?? 0;
      if (after > 1) fail("approval: a posting approved twice", `#${s.id} row ${i + 1}`);
      if (after > before) { rep.approvals++; if (st.k !== "par" && !allowed.has(i)) fail("approval: approved without the exact current tag or set", `#${s.id} step ${st.k} row ${i + 1}: ${JSON.stringify(out.map((x) => [x.kind, x.tag]))}`); }
      if (st.k !== "par" && must.has(i) && after === before && !(S.apps[i])) fail("approval: the exact current tag or set approved nothing (liveness)", `#${s.id} step ${st.k} row ${i + 1} (${p.spec.url}) ${JSON.stringify(out.map((x) => [x.kind, x.tag]))}: ${textOf(out[0].resp.html).slice(-300)}`);
      if (must.has(i) && after > before) rep.liveness["Apply as shown -> queued"] = (rep.liveness["Apply as shown -> queued"] ?? 0) + 1;
    });
    // preparation: only for an unprepared row the person tapped with no tag, that is not in motion, not by hand, and passes the screen
    const newWants = w.wantCalls.slice(wantsBefore);
    for (const c of newWants) {
      rep.wants += c.result === "queued" ? 1 : 0;
      const i = w.posts.findIndex((p) => p.jobId === c.key || KEY_OF(p).ok[0]?.posting_key === c.key);
      const tapped = out.some((x) => x.kind === "apply" && x.i === i && x.tag === "none");
      if (i < 0 || !tapped || ex[i].form !== "none") fail("prepare: queued for preparation without an Apply on an unprepared, offered row", `#${s.id} row ${i + 1} (${ex[i]?.chip}/${ex[i]?.blocked}/${ex[i]?.form})`);
    }
    if (newWants.filter((c) => c.result === "queued").length > new Set(newWants.filter((c) => c.result === "queued").map((c) => c.key)).size) fail("prepare: queued twice", `#${s.id}`);
    // each response
    for (const x of out) {
      if (x.resp.status !== 200) { fail("handler: a signed-in request did not get the page", `#${s.id} ${x.kind}: ${x.resp.status}`); continue; }
      if (x.kind === "text") {
        if (x.resp.html.includes(SECRET_MARK)) fail("secret: a secret-looking value was printed (text)", `#${s.id}`);
        if (BIDI.test(x.resp.html)) fail("markup: a bidi override reached the text version", `#${s.id}`);
        BIDI.lastIndex = 0;
        const t = x.resp.html.replace(/Not applied for automatically on this site/g, "");
        if (/\bapplied\b/i.test(t.replace(/not automated on this site; apply there yourself/g, ""))) fail("status: 'applied' was said (text)", `#${s.id}`);
        const statuses = [...t.matchAll(/^ {3}Status: ([a-z ]+?)(?: \(|$)/gm)].map((m) => m[1]);
        ex2.forEach((e, i) => { const want = e.chip ? e.chip.toLowerCase() : "available"; if (statuses[i] !== want) fail("status: the text version's word is not the row's truth", `#${s.id} row ${i + 1}: ${statuses[i]} vs ${want}`); });
        const applies = [...t.matchAll(/^ {3}Apply: (.+)$/gm)].map((m) => m[1]);
        ex2.forEach((e, i) => { if ((applies[i] === "available") !== (e.form !== null)) fail("apply: the text version offers Apply where the page does not (or the reverse)", `#${s.id} row ${i + 1}: ${applies[i]}`); });
        continue;
      }
      // a page drawn while other taps ran is checked for safety only; the follow-up read below is checked in full
      checkPage(w, S2, ex2, cur2, x.resp.html, fail, { full: st.k !== "par" });
      const pg = readPage(x.resp.html);
      if (st.k !== "par") { seen = pg; pages.push(pg); }
      if (x.kind === "apply" && st.k !== "par") {
        const i = x.i, e = ex[i], row = pg.rows[i];
        if (!row) continue;
        rep.refused += x.must.size ? 0 : 1;
        if (e.form !== null && e.form !== "none" && x.tag !== e.form && !/Changed since you opened this page, so nothing was sent/.test(row.note)) fail("apply: a stale or wrong tag did not say it changed", `#${s.id} row ${i + 1}: ${row.note}`);
        if (e.form !== null && e.form !== "none" && x.tag !== e.form && !/Refresh/.test(row.note)) fail("apply: a changed payload did not offer a refresh", `#${s.id} row ${i + 1}`);
        if (e.form === "none" && x.tag === "none" && !S.wanted[i]) {
          const queued = newWants.some((c) => c.result === "queued"), refusedW = newWants.some((c) => c.result === "refused" || c.result === "duplicate");
          if (queued && ex2[i].chip !== "Preparing") fail("prepare: queued but the row does not say Preparing", `#${s.id} row ${i + 1}`);
          if (queued && row.chip !== "Preparing") fail("prepare: queued but the page does not say Preparing", `#${s.id} row ${i + 1}: ${row.chip}`);
          if (refusedW && !/^Not queued/.test(row.note)) fail("prepare: refused without saying why", `#${s.id} row ${i + 1}: ${row.note}`);
          if (queued) rep.liveness["unprepared Apply -> Preparing"] = (rep.liveness["unprepared Apply -> Preparing"] ?? 0) + 1;
        }
        if (e.blocked && !e.chip && !row.note) fail("screen: a tap on a row that is not offered says nothing", `#${s.id} row ${i + 1}`);
      }
      if (x.kind === "applyall" && st.k !== "par") {
        if (!(cur.hash && x.tag === cur.hash) && !/changed since you opened it, so nothing was approved/.test(pg.top)) fail("apply to all: a stale set did not say nothing was approved", `#${s.id}: ${pg.top}`);
        if (cur.hash && x.tag === cur.hash) rep.liveness["Apply to all -> each queued"] = (rep.liveness["Apply to all -> each queued"] ?? 0) + 1;
      }
    }
    if (st.k === "par") {
      // after taps at once, a fresh read must be fully right
      const S3 = await w.snapshot(), ex3 = expectAll(w, S3), cur3 = await setHashOf(w, ex3);
      const again = await send({ action: "refresh" });
      if (again.status === 200) { checkPage(w, S3, ex3, cur3, again.html, fail, { full: true }); seen = readPage(again.html); pages.push(seen); }
    }
  }
  return seen;
}

// ================================================================== the bugs this battery found, each as a scenario of its own
// (the PR lists them as input -> expected -> actual). Each must pass every invariant AND reach the state that shows the fix.
const PREP = (o: Partial<PayloadSpec> = {}): PayloadSpec => ({ fields: [{ name: "email", label: "Email", value: "adaline@example.test" }], cover: "obj", pageFields: false, destination: "apply", extra: "none", resumeName: true, resumeFileField: false, ...o });
const POST = (n: number, o: Partial<PostingSpec> = {}): PostingSpec => ({ n, company: COMPANY_POOL[n % COMPANY_POOL.length], title: "Pricing Analyst", slug: null, url: "greenhouse", atsHost: "bamboohr.com", boardHost: "remoteok.com", domain: "none",
  hostileDomain: "", twinOf: null, shape: "clean", hasRow: true, desc: "normal", postedDaysAgo: 3, rowLoc: "Austin, TX", hitLoc: null, rowPay: null, hitPay: null, hitDeadlineDays: null, remote: null, reasons: [],
  prep: PREP(), app: null, appReason: null, wanted: false, ...o });
const COMPANY_POOL = ["Quillfeather", "Marrowbyte", "Zentrafy", "Oskarion", "Velloway"];
const SC = (id: number, postings: PostingSpec[], steps: Step[], o: Partial<Scenario> = {}): Scenario => ({ id, needsSponsor: true, logo: "default", postings, steps, category: "regression", ...o });
const rowOf = (seen: Seen | null, i: number) => seen?.rows[i] ?? null;
later([1], { name: "file apply battery regressions: secrets, what we send, status words, preparing, by-hand hosts, logos, bidi, search-only details, the screen, the same posting twice", sanitizeOps: false, sanitizeResources: false, async fn() {
  const A = signedIn();
  const secretSpec = (label: string, extra: Partial<PayloadSpec> = {}) => PREP({ fields: [{ name: "first_name", label: "First name", value: "Adaline" }, { name: "x", label, value: `48213-${SECRET_MARK}r1`, secret: "verify_code" }], ...extra });
  const cases: { name: string; s: Scenario; want: (seen: Seen | null, w: World, S: Snapshot) => boolean }[] = [
    { name: "a 'Verification code' field with a value: Needs you, no Apply, value never printed, the current tag approves nothing (was: printed in What we send and one-tap approvable)",
      s: SC(910_001, [POST(1, { prep: secretSpec("Verification code") }), POST(2)], [{ k: "get" }, { k: "apply", row: 0, tag: "current", r: 0 }, { k: "applyall", set: "seen" }]),
      want: (seen, _w, S) => rowOf(seen, 0)?.chip === "Needs you" && rowOf(seen, 0)!.tag === null && !S.approvals.has(_w.posts[0].jobId) && /Verification code: Needs you/.test(rowOf(seen, 0)!.send!.join("|")) },
    { name: "a password-type field labelled 'Account login', an SSN-looking value and an api_key key: each Needs you (was: shown and approvable on the page)",
      s: SC(910_002, [POST(1, { prep: PREP({ fields: [{ name: "acct", label: "Account login", type: "password", value: `pw-${SECRET_MARK}a`, secret: "type" }] }) }),
        POST(2, { prep: PREP({ fields: [{ name: "tax", label: "Tax ID", value: `123-45-6789 ${SECRET_MARK}b`, secret: "value_ssn" }] }) }), POST(3, { prep: PREP({ extra: "secret_key" }) })], [{ k: "get" }, { k: "applyall", set: "current" }]),
      want: (seen) => [0, 1, 2].every((i) => rowOf(seen, i)?.chip === "Needs you") && !/Apply to all/.test(seen!.html) },
    { name: "What we send lists every value in full: a 2,400-character cover note, an object answer, a transcript file, an extra key (was: clipped, '[object Object]', dropped)",
      s: SC(910_003, [POST(1, { prep: PREP({ cover: "long", extra: "plain", resumeFileField: true, fields: [{ name: "links", label: "Links", value: { github: "https://github.example/ada" } }, { name: "t", label: "Transcript", type: "input_file", value: "transcript-2025.pdf" }] }) })], [{ k: "get" }]),
      want: (seen) => { const l = rowOf(seen, 0)!.send!.join("|"); return /Cover note: (I would bring careful work to this team\. ){50}/.test(l) && l.includes('Links: {"github":"https://github.example/ada"}') && l.includes("Transcript: file transcript-2025.pdf") && /referral: Jamie Ortiz/.test(l) && !/Resume\/CV/.test(l); } },
    { name: "a posting applied for elsewhere while a newer payload is prepared: the row says Queued and lists no payload (was: listed the prepared payload under the chip)",
      s: SC(910_004, [POST(1), POST(2)], [{ k: "get" }, { k: "elsewhere", row: 0, state: "queued" }, { k: "refresh" }]),
      want: (seen) => rowOf(seen, 0)?.chip === "Queued" && rowOf(seen, 0)!.send === null },
    { name: "being sent says Sending and a run that stopped before sending says Not submitted (was: Preparing, Failed)",
      s: SC(910_005, [POST(1, { app: "driving" }), POST(2, { app: "not_submitted", appReason: "approval no longer current" })], [{ k: "get" }, { k: "text" }]),
      want: (seen) => rowOf(seen, 0)?.chip === "Sending" && rowOf(seen, 1)?.chip === "Not submitted" },
    { name: "an unprepared posting's Apply queues it once and the row says Preparing; a second tap queues nothing more (was: the row kept offering Apply)",
      s: SC(910_006, [POST(1, { prep: null }), POST(2, { prep: null, url: "lever" })], [{ k: "get" }, { k: "apply", row: 0, tag: "seen", r: 0 }, { k: "apply", row: 0, tag: "none", r: 0 }, { k: "apply", row: 1, tag: "seen", r: 0 }]),
      want: (seen, w) => rowOf(seen, 0)?.chip === "Preparing" && rowOf(seen, 1)?.chip === "Preparing" && w.wantCalls.filter((c) => c.result === "queued").length === 2 },
    { name: "www.linkedin.com. (trailing dot), lnkd.in and indeed.co.uk only link out; a javascript: link is never a link (was: Apply on each; a script href)",
      s: SC(910_007, [POST(1, { url: "linkedin_dot", prep: null }), POST(2, { url: "lnkd", prep: null }), POST(3, { url: "indeed_uk", prep: null }), POST(4, { url: "js_linkedin", prep: null })],
        [{ k: "get" }, { k: "apply", row: 0, tag: "none", r: 0 }, { k: "apply", row: 3, tag: "none", r: 0 }]),
      want: (seen, w) => [0, 1, 2].every((i) => rowOf(seen, i)?.link !== null && rowOf(seen, i)?.tag === null) && rowOf(seen, 3)?.link === null && !/javascript:/.test(seen!.html) && w.wantCalls.length === 0 },
    { name: "a posting on acme.bamboohr.com, on remoteok.com or news.ycombinator.com gets the lettermark; one on the employer's own careers host gets its logo (was: the ATS's or board's favicon)",
      s: SC(910_008, [POST(1, { url: "ats_other", slug: "marrowbyte" }), POST(2, { url: "board", boardHost: "news.ycombinator.com" }), POST(3, { url: "own_gh", slug: "oskarion" })], [{ k: "get" }]),
      want: (seen) => rowOf(seen, 0)?.img === null && rowOf(seen, 1)?.img === null && /(?:domain|logo)=oskarion\.com/.test(rowOf(seen, 2)?.img ?? "") },
    { name: "bidi overrides in a company, a title and a location never reach the page (was: rendered, reversing 'Reported, not verified')",
      s: SC(910_009, [POST(1, { company: "Evil‮gnp.exe Ltd", title: "Planner ‮reganam", rowLoc: "Lisbon ‮PT" })], [{ k: "get" }, { k: "text" }]),
      want: (seen) => !/[‪-‮⁦-⁩]/.test(seen!.html) && rowOf(seen, 0)!.name === "Evilgnp.exe Ltd" },
    { name: "no posting text and a location only the search result gave: the short description stays empty, the location is labelled (was: the search's location as the description)",
      s: SC(910_010, [POST(1, { desc: "none", rowLoc: null, hitLoc: "Springfield, IL" })], [{ k: "get" }]),
      want: (seen) => !rowOf(seen, 0)!.desc.includes("Springfield") && rowOf(seen, 0)!.meta.some((m) => /Springfield, IL .* Reported, not verified/.test(m)) },
    { name: "closed, scam-looking and knock-out postings (prepared) offer no Apply and are not in Apply to all, which approves exactly the rest (was: Apply on each; '2 of 4 were not approved')",
      s: SC(910_011, [POST(1, { shape: "closed" }), POST(2, { shape: "scam" }), POST(3, { shape: "knockout" }), POST(4), POST(5)], [{ k: "get" }, { k: "applyall", set: "seen" }]),
      want: (seen, w, S) => [0, 1, 2].every((i) => rowOf(seen, i)?.tag === null && /^Not offered/.test(rowOf(seen, i)!.note)) && S.approvals.size === 2 && S.approvals.has(w.posts[3].jobId) && !seen!.top },
    { name: "the same posting twice on one list (one link, two ids): the second row offers no Apply; once the first is approved, the second shows its status (was: both offered)",
      s: SC(910_012, [POST(1), POST(2, { twinOf: 1 })], [{ k: "get" }, { k: "applyall", set: "seen" }, { k: "apply", row: 0, tag: "seen", r: 0 }]),
      want: (seen, w, S) => rowOf(seen, 1)?.chip === "Queued" && S.approvals.size === 1 && S.approvals.has(w.posts[0].jobId) },
    { name: "an application that would be sent to LinkedIn is not offered (was: one-tap approvable)",
      s: SC(910_013, [POST(1, { prep: PREP({ destination: "byhand" }) })], [{ k: "get" }, { k: "apply", row: 0, tag: "current", r: 0 }]),
      want: (seen, _w, S) => rowOf(seen, 0)?.tag === null && S.approvals.size === 0 && /LinkedIn/.test(rowOf(seen, 0)!.note) },
    { name: "a payload with no answers says only what it sends (was: 'Sends: <resume> + your saved answers')",
      s: SC(910_014, [POST(1, { prep: PREP({ fields: [], cover: null }) })], [{ k: "get" }]),
      want: (seen) => rowOf(seen, 0)!.meta.some((m) => m === "Sends: adaline-cv-2026.pdf") },
  ];
  const failed: string[] = [];
  for (const c of cases) {
    const rep = newReport();
    const w = await memWorld(c.s, A);
    const seen = await runScenario(c.s, w, rep, await A.tok(U, LIST, T0));
    if (printReport(`regression: ${c.name}`, rep)) failed.push(`${c.name}: an invariant failed`);
    if (!c.want(seen, w, await w.snapshot())) failed.push(`${c.name}: ${JSON.stringify(seen?.rows.map((r) => ({ chip: r.chip, tag: r.tag, link: r.link, note: r.note, img: r.img, send: r.send?.map((x) => x.slice(0, 60)), meta: r.meta })))}`);
  }
  eq(failed, [], "every regression scenario holds every invariant and reaches the fixed state");
} });

later([1], "secretFields: a resume hash or an account id with a long card-like run of digits is bookkeeping, not a secret (was: every application carrying it 'needs you'); a real one still is", () => {
  const luhnRun = "4111111111111111";
  const sha = (luhnRun + "a".repeat(48)).slice(0, 64);
  const p = { id: "x", job_id: "greenhouse:a:1", company: "A", url: "https://boards.greenhouse.io/a/jobs/1", payload_hash: "0".repeat(64), card_lines: [], state: "ready",
    payload: { version: 1, user_id: "41111111-1111-1111-1111-111111111111", job_id: "greenhouse:a:1", resume_sha256: sha, fields: [{ name: "email", label: "Email", value: "a@example.test" }] } } as PreparedRow;
  eq(secretFields(p), []);
  eq(secretFields({ ...p, payload: { ...p.payload, notes: `card ${luhnRun}` } }), ["notes"]);
});

later([1], "want: the queue's refusal codes reach the person as words, never as a code (was: 'Not queued: duplicate_job')", async () => {
  // The person has a confirmed resume and the account is not paused (the tap's own checks before the queue, journeys r2), so the
  // queue's answer is what reaches them.
  const kv = { select: () => kv, eq: () => kv, maybeSingle: async () => ({ data: { value: { paused: false } }, error: null }) };
  const admin = { from: () => kv, rpc: async (name: string) => name === "career_resume_on_file" ? { data: true, error: null }
    : ({ data: { added: [], refused: [{ posting_key: "greenhouse:acme:1", reason: "duplicate_job" }] }, error: null }) };
  const store = supabaseJobStore(admin);
  const r = await store.want(U, { job_id: "greenhouse:acme:1", url: "https://boards.greenhouse.io/acme/jobs/1", company: "Acme", title: "Analyst" } as JobView, T0);
  eq(r.result, "refused");
  assertNode.ok(!/_/.test(String(r.reason)) && /already in your applications/.test(String(r.reason)), String(r.reason));
});

// ================================================================== taps at once, with the interleaving forced (no timing)
// Found by an independent re-run of the at-scale battery on a loaded 4-core box (7 violations, 0 in CI): a "par" step of an Apply
// (the row's exact current tag) and Apply to all (the exact current set) at once, where neither approved the other rows of the
// set. Two causes, each pinned here so the verdict never depends on the scheduler:
//  - the oracle demanded every member of the set even when the Apply ran first and so changed the set (an Apply to all of a set
//    that no longer exists approves nothing, by its contract); it now accepts exactly what some one-at-a-time order approves;
//  - the product's approval was two calls (open a card, then answer it), and opening a card closes the person's other open cards
//    (career_apply_card_open_for), so two approvals at once could close each other's card and both approve nothing. One Confirm is
//    now one transaction (career_apply_card_confirm_as; the memory store models both the closing and the confirm).
// gate(n): the first n approval steps wait until all n have arrived, then go together; later ones pass.
const gate = (n: number) => { let k = 0, go!: () => void; const all = new Promise<void>((r) => { go = r; }); return async () => { if (++k === n) go(); if (k <= n) await all; }; };
later([1], { name: "taps at once, forced: two Applies held at the approval approve both rows; the same row twice approves it once and the other tap says 'Already in your applications'; Apply and Apply to all in either order approve exactly what that order does; #1432 and #1742 replayed both ways", sanitizeOps: false, sanitizeResources: false, async fn() {
  const A = signedIn();
  const failed: string[] = [];
  const approvedRows = (w: World, S: Snapshot) => w.posts.map((p, i) => S.approvals.get(p.jobId) ? i + 1 : 0).filter(Boolean);
  const run = async (name: string, s: Scenario, o: { parOrder?: "forward" | "reverse"; held?: number }, want: (w: World, S: Snapshot, seen: Seen | null) => string | null) => {
    const rep = newReport();
    const w = await memWorld(s, A, o.held ? { approving: gate(o.held) } : {});
    const seen = await runScenario(s, w, rep, await A.tok(U, LIST, T0), { parOrder: o.parOrder });
    if (printReport(`forced: ${name}`, rep)) failed.push(`${name}: an invariant failed`);
    const why = want(w, await w.snapshot(), seen);
    if (why) failed.push(`${name}: ${why}`);
  };
  const three = () => [POST(1), POST(2, { url: "lever" }), POST(3, { url: "ashby" })];
  const apply = (row: number): Step => ({ k: "apply", row, tag: "seen", r: 0 });
  // Two different rows, both held after the approval starts: before, the second card closed the first and row 1 approved nothing.
  await run("two Applies on two rows, held together", SC(920_001, three(), [{ k: "get" }, { k: "par", steps: [apply(0), apply(1)] }]), { held: 2 },
    (w, S) => JSON.stringify(approvedRows(w, S)) === "[1,2]" ? null : `approved rows ${approvedRows(w, S)}, want 1,2`);
  // The same row twice, held together: approved once; the other tap is told it is already in the applications (the oracle checks the note).
  await run("the same Apply twice, held together", SC(920_002, three(), [{ k: "get" }, { k: "par", steps: [apply(0), apply(0)] }]), { held: 2 },
    (w, S) => JSON.stringify(approvedRows(w, S)) === "[1]" && S.approvals.get(w.posts[0].jobId) === 1 ? null : `approved rows ${approvedRows(w, S)}, want 1 once`);
  // Apply to all twice and an Apply, the first approval steps held together: every member approved once.
  await run("two Apply to alls and an Apply, held together", SC(920_003, three(), [{ k: "get" }, { k: "par", steps: [{ k: "applyall", set: "seen" }, { k: "applyall", set: "seen" }, apply(2)] }]), { held: 3 },
    (w, S) => JSON.stringify(approvedRows(w, S)) === "[1,2,3]" ? null : `approved rows ${approvedRows(w, S)}, want 1,2,3`);
  // Apply then Apply to all of the page both came from: the Apply changed the set, so Apply to all approves nothing and says so.
  await run("Apply, then Apply to all of the same page", SC(920_004, three(), [{ k: "get" }, { k: "par", steps: [apply(1), { k: "applyall", set: "seen" }] }]), { parOrder: "forward" },
    (w, S) => JSON.stringify(approvedRows(w, S)) === "[2]" ? null : `approved rows ${approvedRows(w, S)}, want 2 only`);
  // Apply to all first: every member, and the Apply finds its row already in the applications.
  await run("Apply to all, then Apply of the same page", SC(920_005, three(), [{ k: "get" }, { k: "par", steps: [apply(1), { k: "applyall", set: "seen" }] }]), { parOrder: "reverse" },
    (w, S, seen) => JSON.stringify(approvedRows(w, S)) === "[1,2,3]" && seen?.rows[1]?.chip === "Queued" ? null : `approved rows ${approvedRows(w, S)}, want 1,2,3`);
  // The two scenarios the loaded box failed, replayed in each order and held together.
  for (const id of [1432, 1742]) {
    const s = SCENARIOS.find((x) => x.id === id)!;
    for (const o of [{ parOrder: "forward" as const }, { parOrder: "reverse" as const }, { held: 2 }]) await run(`#${id} ${JSON.stringify(o)}`, s, o, () => null);
  }
  eq(failed, [], "taps at once are judged by what one at a time would do, and each approval holds whatever the interleaving");
} });

// ================================================================== part 1: every scenario over the memory stores
const scaleTest = (part: number) => {
  const from = Math.round(((part - 1) * SCENARIOS.length) / FILE_APPLY_PARTS), to = Math.round((part * SCENARIOS.length) / FILE_APPLY_PARTS);
  return { name: `file apply at scale, part ${part} of ${FILE_APPLY_PARTS}: scenarios ${from + 1}-${to} of ${SCENARIOS.length} seeded scenarios (1-30 postings in every state; Apply, Apply to all, refresh, taps at once, payloads changing) through handleFile over memory stores; every invariant after every request`, sanitizeOps: false, sanitizeResources: false, async fn() {
  eq(SCENARIOS.length, 10_000);
  eq(JSON.stringify(generate({ seed: 20261029, count: 40 })), JSON.stringify(SCENARIOS.slice(0, 40)), "the generator is deterministic");
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  const rep = newReport();
  const started = Date.now();
  const A = signedIn();
  try {
    const mine = SCENARIOS.slice(from, to);
    for (const s of ONLY ? mine.filter((x) => String(x.id) === ONLY) : FIRST ? mine.filter((_, k) => from + k < FIRST) : mine) {
      const w = await memWorld(s, A);
      await runScenario(s, w, rep, await A.tok(U, LIST, T0));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`[file-apply] memory run, part ${part} (scenarios ${from + 1}-${to}): ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const failed = printReport(`memory stores, part ${part}`, rep);
  eq(outside, [], "nothing left the machine");
  if (!ONLY && !FIRST) {
    // The whole battery's floors (2,000 / 300 / 300), each part its share, so the parts together check at least as much.
    for (const [k, all] of [["Apply as shown -> queued", 2000], ["unprepared Apply -> Preparing", 300], ["Apply to all -> each queued", 300]] as const) {
      const min = Math.ceil((all * (to - from)) / SCENARIOS.length);
      if ((rep.liveness[k] ?? 0) < min) throw new Error(`liveness "${k}" checked only ${rep.liveness[k] ?? 0} times (want ≥ ${min})`);
    }
  }
  eq(failed, 0, "every invariant held after every request");
} };
};
for (let part = 1; part <= FILE_APPLY_PARTS; part++) later([part], scaleTest(part));

// ================================================================== part 2: a sample through the deployed stores on Postgres
// The same scenarios, the same oracle, but every read and write through the deployed stores (trainee-file/store.ts supabaseFileStore,
// career_apply_cards.ts supabaseCardStore, channel_card_tap.ts supabaseTapStore, telegram_jobs.ts supabaseConfirmedFacts) over
// supabase-js and the PostgREST double, into the real tables and RPCs (career_postings, career_apply_prepared through the person's own
// career_apply_prepare_own, career_apply_card_open_as / career_apply_card_answer_as and career_apply_enqueue, career_apply_want_put_for,
// career_apply_wanted, career_apply_jobs). The truth the oracle reads is the database's own rows.
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };
async function pgWorld(s: Scenario, pg: Pg, admin: any, auth: ReturnType<typeof signedIn>, n: number): Promise<World & { userId: string }> {
  const now = Date.now();
  const u = `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const { profile } = profileFacts(s.needsSponsor);
  await pg.sql(`insert into auth.users (id, email) values ('${u}', 'fa${n}@example.test'); insert into public.profiles (id) values ('${u}');
    insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', ${lit(JSON.stringify({ epoch: 0, version: 0, paused: false, memory: { profile } }))}::jsonb);
    ${confirmedResumeSql(u, RESUME_FILE)}`);
  const posts = await postsOf(s, now, u, n);
  const meta = new Map<string, { secrets: string[]; hidden: string[]; needsYou: boolean }>();
  const elsewhere = new Set<string>();
  const sqlTs = (v: string | null | undefined) => v ? `${lit(v)}::timestamptz` : "null";
  const rowsSql = posts.filter((p) => p.row).map((p) => { const r = p.row!; return `(${lit(r.job_id)}, ${lit(String(r.provider))}, ${lit(r.job_id.split(":")[1])}, ${lit(String(r.company))}, ${lit(String(r.title))}, ${lit(String(r.location ?? ""))}, ${lit(String(r.url))}, ${lit(String(r.description ?? ""))}, ${r.remote ? lit(r.remote) : "null"}, ${sqlTs(r.posted_at)}, ${sqlTs(r.first_seen_at)}, now(), ${sqlTs(r.closed_at)}, ${r.pay ? lit(r.pay) : "null"})`; });
  if (rowsSql.length) await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, remote, posted_at, first_seen_at, last_seen_at, closed_at, pay) values ${rowsSql.join(",\n")};`);
  const prepare = async (i: number, spec: PayloadSpec) => {
    const p = posts[i], made = payloadOf(p, spec, p.hashes.length + 1, now, u);
    // The person's own computer stores it (career_apply_prepare_own under their session; the database computes the hash).
    let row: { id: string; payload_hash: string };
    try {
      row = JSON.parse(await pg.sql(`begin; set local role authenticated;
select set_config('request.jwt.claim.sub', '${u}', true), set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: u, role: "authenticated" }))}, true);
select to_jsonb(public.career_apply_prepare_own(p_payload => ${lit(JSON.stringify(made.payload))}::jsonb, p_card_lines => array[${lit(String(made.payload.company))}]::text[])); commit;`));
    } catch (e) { if (Deno.env.get("FAB_DEBUG")) console.log("prepare refused:", String(e).slice(0, 160)); return; } // career_apply_prepare_own refuses (already applied for, a link it does not take): the world stays as the database says
    // a re-prepare: the older payload is no longer the one shown (the newest ready one is what prepared() reads)
    await pg.sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.jobId)} and state in ('ready', 'shown') and id <> '${row.id}'`);
    meta.set(row.payload_hash, { secrets: made.secrets, hidden: made.hidden, needsYou: made.needsYou });
    p.hashes.push(row.payload_hash);
  };
  const recordElsewhere = async (i: number, state: string) => {
    const p = posts[i], st = state === "paused_by_site" ? "unknown_outcome" : state;
    const pl = JSON.stringify({ version: 1, user_id: u, job_id: p.jobId, company: p.job.company || "Employer", url: p.url, fields: [], resume_sha256: RESUME_SHA, recorded: "elsewhere" });
    try {
      const had = (await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${u}' and job_id = ${lit(p.jobId)}`)) !== "0";
      if (had) await pg.sql(`update public.career_apply_jobs set state = ${lit(st)}, attempts = 1, claimed_at = coalesce(claimed_at, now()), lease_token = coalesce(lease_token, gen_random_uuid()) where user_id = '${u}' and job_id = ${lit(p.jobId)}`);
      else await pg.sql(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, reason, attempts, claimed_at, lease_token)
        select '${u}', ${lit(p.jobId)}, ${lit(p.job.company || "Employer")}, ${lit(p.url)}, x.p, h, h, ${lit(st)}, ${p.spec.appReason ? lit(p.spec.appReason) : "null"}, ${st === "queued" ? "0, null, null" : "1, now(), gen_random_uuid()"}
        from (select ${lit(pl)}::jsonb as p) x, lateral (select public.career_apply_payload_hash(x.p) as h) y`);
      elsewhere.add(p.jobId);
    } catch { /* the database refuses this record (a link it does not take, a transition it does not allow): the world is what the database says */ }
  };
  const base = supabaseFileStore(admin);
  const store: FileStore = { ...base, async want(uu, job, at) {
    const r = await base.want(uu, job, at);
    const k = wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title } as any], 0).ok[0]?.posting_key ?? job.job_id;
    world.wantCalls.push({ key: k, result: r.result === "refused" && /already in your applications/.test(String(r.reason)) ? "duplicate" : r.result });
    return r;
  } };
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot", TRAINEE_LOGO_URL: LOGO_TPL[s.logo] || undefined };
  const deps: FileDeps = { ...auth.deps, store, cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), events: null, facts: supabaseConfirmedFacts(admin), now: () => Date.now(), env: { get: (k) => env[k] } };
  for (const p of posts) await base.remember(u, p.ref, p.job, "text");
  await base.rememberList(u, LIST, posts.map((p) => p.ref));
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i].spec;
    if (p.prep) await prepare(i, p.prep);
    if (p.app) await recordElsewhere(i, p.app);
    if (p.wanted) await base.want(u, posts[i].job, now).catch(() => null);
  }
  const json = async (q: string) => JSON.parse(await pg.sql(q) || "[]");
  const world: World & { userId: string } = {
    posts, scenario: s, now, deps, wantCalls: [], userId: u,
    async snapshot() {
      const preps = await json(`select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'payload', payload, 'hash', payload_hash) order by created_at desc, id), '[]') from public.career_apply_prepared where user_id = '${u}' and state in ('ready', 'shown')`) as { id: string; job_id: string; payload: Record<string, unknown>; hash: string }[];
      const apps = await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'url', url, 'state', state, 'reason', reason) order by created_at desc), '[]') from public.career_apply_jobs where user_id = '${u}'`) as { job_id: string; url: string; state: string; reason: string | null }[];
      const approved = await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'n', n)), '[]') from (select job_id, count(*) as n from public.career_apply_prepared where user_id = '${u}' and state = 'approved' group by job_id) x`) as { job_id: string; n: number }[];
      const keys = new Set((await json(`select coalesce(json_agg(posting_key), '[]') from public.career_apply_wanted where user_id = '${u}'`)) as string[]);
      const appOf = (p: Post) => apps.find((a) => a.job_id === p.jobId) ?? apps.find((a) => a.url === p.url) ?? null;
      return {
        preps: posts.map((p) => { const x = preps.find((y) => y.job_id === p.jobId); return x ? { id: x.id, payload: x.payload, hash: x.hash, state: "ready" as const, ...(meta.get(x.hash) ?? { secrets: [], hidden: [], needsYou: false }) } : null; }),
        apps: posts.map((p) => { const a = appOf(p); return a ? { ...a, payload: {}, via: elsewhere.has(a.job_id) ? "elsewhere" as const : "approval" as const } : null; }),
        appByJob: new Map(), wanted: posts.map((p) => { const k = KEY_OF(p).ok[0]?.posting_key; return !!k && keys.has(k); }), rows: posts.map((p) => p.row && { ...p.row }),
        approvals: new Map(approved.map((a) => [a.job_id, Number(a.n)])),
      };
    },
    async mutate(step) {
      if (step.k === "payload") {
        const i = step.row % posts.length, p = posts[i];
        if (BY_HAND.includes(p.spec.url)) return;
        const S = await world.snapshot();
        if (step.op === "unprepare") { await pg.sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.jobId)} and state in ('ready', 'shown')`); return; }
        if (step.op === "prepare" && S.preps[i]) return;
        const spec: PayloadSpec = p.spec.prep ? structuredClone(p.spec.prep) : { fields: [{ name: "email", label: "Email", value: "adaline@example.test" }], cover: "obj", pageFields: false, destination: "apply", extra: "none", resumeName: true, resumeFileField: false };
        if (step.op === "secret") spec.fields.push({ name: "otp", label: "One-time code", type: "one-time-code", value: `${SECRET_MARK}otp${p.hashes.length}`, secret: "verify_code" });
        await prepare(i, spec);
      } else if (step.k === "elsewhere") await recordElsewhere(step.row % posts.length, step.state);
      else if (step.k === "close") {
        const p = posts[step.row % posts.length];
        if (p.row) { p.row.closed_at = new Date(Date.now() - 60_000).toISOString(); await pg.sql(`update public.career_postings set closed_at = ${lit(p.row.closed_at)}::timestamptz where job_id = ${lit(p.jobId)}`); }
      } else if (step.k === "prepare_wanted") {
        const S = await world.snapshot();
        for (let i = 0; i < posts.length; i++) if (S.wanted[i] && !S.preps[i] && !S.apps[i]) await prepare(i, posts[i].spec.prep ?? { fields: [{ name: "first_name", label: "First name", value: "Adaline" }], cover: null, pageFields: false, destination: "apply", extra: "none", resumeName: true, resumeFileField: true });
      }
    },
  };
  return world;
}

later([FILE_APPLY_PARTS], { name: `file apply at scale on real Postgres: ${PG_SAMPLE} sampled scenarios through the deployed stores and the career_apply_* RPCs (prepare, card open and answer, enqueue once per posting, the wanted queue)`, sanitizeOps: false, sanitizeResources: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const slow: Pg = await startPg();
  // One long-lived session instead of a psql process per call (the PostgREST double's transactions, each one simple query): the same
  // SQL, the same roles and claims, a fraction of the time.
  const conn = await PgConn.connect({ host: slow.host, port: slow.port });
  const pg: Pg = { ...slow, async sql(text: string) {
    try { return (await conn.query(text.replace(/\\g \/dev\/null/g, ";"))).map((r) => r.map((v) => v ?? "").join("|")).join("\n").trim(); }
    catch (e) { await conn.query("rollback").catch(() => {}); throw e; }
  } };
  const rep = newReport();
  const realFetch = globalThis.fetch;
  const A = signedIn();
  try {
    const URL_ = "http://supabase.test", KEY = "service-test-key";
    const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
    const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    const outside: string[] = [];
    globalThis.fetch = ((u: string | URL | Request) => { outside.push(String(u instanceof Request ? u.url : u)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    // Lists of up to 8 postings that tap something (each request here is a few dozen real database round trips; the CI budget is a minute).
    const eligible = SCENARIOS.filter((x) => x.postings.length <= 8 && x.steps.some((st) => st.k === "apply" || st.k === "applyall" || st.k === "par"));
    const picked = ONLY ? SCENARIOS.filter((x) => String(x.id) === ONLY) : sample(eligible, Number(Deno.env.get("FAB_PG_N") ?? PG_SAMPLE), 2910);
    const started = Date.now();
    let n = 0;
    for (const s of picked) {
      const w = await pgWorld(s, pg, admin, A, ++n);
      await runScenario(s, w, rep, await A.tok(w.userId, LIST, Date.now()));
    }
    console.log(`[file-apply] Postgres run: ${picked.length} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    eq(outside, [], "nothing left the machine but the PostgREST double");
    const unsupported = double.log.filter((l) => /unsupported/.test(l.error ?? ""));
    eq(unsupported, [], "every call the stores made is one the double (and PostgREST) answers");
  } finally {
    globalThis.fetch = realFetch;
    conn.close();
    await slow.stop();
  }
  const failed = printReport("real Postgres", rep);
  for (const [k, min] of [["Apply as shown -> queued", 10], ["unprepared Apply -> Preparing", 5]] as const) if (!ONLY && (rep.liveness[k] ?? 0) < min) throw new Error(`liveness on Postgres: "${k}" checked only ${rep.liveness[k] ?? 0} times`);
  eq(failed, 0, "every invariant held after every request, against the database's own rows");
} });

