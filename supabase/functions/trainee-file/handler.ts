// trainee-file: the hosted jobs list page. Tests: tests/architect/file-page.test.ts.
//
// Login (owner, 2026-10-29; ../_shared/file_session.ts): the link the bot sends says WHICH list, never WHO opened it, so it opens
// a phone sign-in and nothing private. The code is texted only to the confirmed phone of the account the link was issued for,
// and a session starts only when the code proves that same account. A Mini App opened by the bot's web_app button is a separate
// Telegram login (signed initData, mapped to the linked account). Either way: a server-side session, revocable, checked against
// the account again on every request. Every read is scoped to the session's account.
//
// The Apply tap IS the approval: it carries the first 16 hex of the payload hash shown for that row, the payload is read again
// at the tap, and a payload that changed since the page was drawn is refused with a refresh prompt (D-MS-1). The approval runs
// through tapJob's Confirm (the same path as Telegram's Confirm button: one card opened and answered in one transaction, once).
// "Apply to all" carries the hash of the exact set shown; it approves nothing unless the set is still exactly that when it is
// read. Taps at once are each judged against the list as it is when they run: an Apply that queued a row first changes the set
// (the Apply to all then approves nothing and says so); an Apply to all that ran first leaves that Apply "Already in your
// applications". Either way each posting is approved once.
import { FILE_TTL_MS, verifyFileToken, type FileClaims } from "../_shared/file_link.ts";
import { checkSession, CLEAR_LOGIN, CLEAR_SESSION, codeOf, LOGIN_TTL_MS, loginCookie, MAX_CODE_SENDS, MAX_CODE_TRIES, normalizePhone, PAGE_TOKEN, pageTokenOf, sameToken, SESSION_ID, sessionCookie, sha256, startSession, type PhoneAuth, type SessionCheck, type SessionStore } from "../_shared/file_session.ts";
import { verifyInitData } from "../_shared/telegram_webapp.ts";
import { BOOT_SCRIPT, cut, FEED_SCRIPT, fullOf, hostOf, renderBootstrap, renderFeed, renderLinkState, renderPhoneLogin, renderPreview, renderText, signOutFoot, snippetOf, statusOf, type AppRow, type Feed, type Row } from "../_shared/file_page.ts";
import { dayOf, BRAND, esc, layout, postedLine, webUrl } from "../_shared/file_page.ts";
import { actOn, bodyHtml, COPY_SCRIPT, KIND_CSS, KIND_LABEL, textOf, type Effects, type FileRecord } from "../_shared/file_kinds.ts";
import type { FileService } from "../_shared/file_service.ts";
import { fetchLogo, memoryLogoCache, validDomain, type LogoCache } from "../_shared/logo_cache.ts";
import { renderResults, renderThings, type PayFilter, type ResultRow, type ThingQuestion } from "../_shared/results_page.ts";
import { conversionNote, floorText, type Pay, payGroup, payText, startsBelow } from "../_shared/role_pay.ts";
import { checkAnswer, type OpenQuestion, type QuestionStore } from "../_shared/career_apply_questions.ts";
import { type PendingRow, pendingLine } from "../_shared/career_hosted_prepare.ts";
import { NO_RESUME_NEXT, NO_RESUME_REASON } from "../_shared/career_apply_from_chat.ts";
import { factType, NEVER_BY_TEXT } from "../_shared/question_map.ts";
import { decodeRowQuestionType } from "../_shared/row_answer.ts";
import { redactIdentity } from "../_shared/identity_redact.ts";
import { coverage, countsOf, NOTHING_SENT, NOT_LISTED, renderExport, reqIdOf, roleIds, specOf } from "../_shared/results_spec.ts";
import type { ListMeta } from "../_shared/telegram_jobs.ts";
import { fileShellHtml, firstNameOf, freshnessStamp, madeForLine, stateHtml } from "../_shared/file_design.ts";
import { byHandUrl, FEED_ROWS, foreignFact, hashTag, isSecretField, NOT_YOURS, logoDomain, postingVerdict, secretFields, secretKey, tapJob, unsendable, type JobDeps, type JobSender, type JobStore, type JobView, type PostingRow, type PreparedRow } from "../_shared/telegram_jobs.ts";

export type { AppRow } from "../_shared/file_page.ts";
export interface FileStore extends JobStore {
  // This person's application row for the posting (career_apply_jobs): by its id, else by its link (the same posting found under
  // another id is the same application; each posting goes at most once).
  appRow(userId: string, jobId: string, url?: string): Promise<AppRow | null>;
  // Queued to be prepared (career_apply_wanted): by the posting's key, as the queue stores it (its board form's link, not always the
  // link shown), else by the link.
  wanted(userId: string, url: string, job?: JobView): Promise<boolean>;
  // elsewhere (JobStore): asked only when this posting has no application row of its own, so a yes means another path.
}
export interface FileDeps extends Omit<JobDeps, "store"> {
  store: FileStore;
  userOfTelegram?: (telegramId: string) => Promise<string | null>; // channel_contacts: 'tg:<id>' -> the linked account
  sessions?: SessionStore; // server-side, revocable sessions and the phone sign-ins links open (file_session.ts); absent, nothing opens
  phone?: PhoneAuth; // the account's confirmed phone and the texted code; absent, phone sign-in is off
  files?: FileService; // the other file kinds (introduction, proof, plan, comparison, draft, brief); an id not found there is a jobs list
  fileEffects?: Effects; // what Introduce really does (send); absent, an approved introduction says it was not sent
  logoFetch?: typeof fetch; // TRAINEE_LOGO_URL=self: how the server fetches an employer's own logo (tests pass a fake; default fetch)
  logoCache?: LogoCache; // and where it keeps them (default: one in-memory cache per instance)
  timeZone?: (userId: string) => Promise<string | null>; // the person's own zone (dates on the page are their day); absent or unknown, Chicago, said
  // The employer's open questions (career_apply_questions): a results card that isn't ready asks them on "A few things first", and
  // answers are checked (checkAnswer) and saved (store.answer) exactly as the chat saves them. Absent: the page asks nothing.
  questions?: QuestionStore;
  // Prepare the person's queued applications again now that their questions are answered (career_hosted_prepare.ts). Absent: they
  // wait in the queue and the page says so.
  reprepare?: (userId: string) => Promise<"started" | "failed" | "off" | "skipped">;
  // Whether the person has a confirmed resume (career_resume_on_file, the check the chat's apply turn makes). false: Apply asks for the
  // resume first and queues nothing. null or absent: the queue is not held back here (the card still refuses a send without one).
  resumeOnFile?: (userId: string) => Promise<boolean | null>;
  // Where each queued posting stands (career_apply_pending_for), in the person's words. Absent: "getting it ready".
  pending?: (userId: string) => Promise<PendingRow[] | null>;
  // Every phone step (number, code) answers only after this resolves, given how long the step took: deps.ts pads to a floor
  // (file_session.ts PHONE_STEP_FLOOR_MS) so time cannot tell whether the typed number is the account's. Absent: no padding.
  pace?: (step: "phone_start" | "phone_verify", elapsedMs: number) => Promise<void>;
  // Work that outlives the answer (the sign-in text): the edge runtime keeps it alive (EdgeRuntime.waitUntil). Absent: it runs on.
  background?: (work: Promise<unknown>) => void;
}
// A form post is never bigger than this (a typed number or code, the Mini App's signed data, a short note): a bigger body is
// refused without being read past it.
export const MAX_BODY_BYTES = 64 * 1024;
export const ALLOWED_METHODS = "GET, HEAD, POST";

// A post that another site made the browser send (a cross-site form, with the person's cookies; SameSite stops neither a sibling
// subdomain nor a browser that ignores it) changes nothing. The browser's own Sec-Fetch-Site decides when it is there; else the
// Origin (this page's own origin, or the site's address in TRAINEE_FILE_BASE_URL, which the /file proxy serves it at); else the
// Referer. A "null" origin passes only when the browser itself says the post is same-origin (a page under a no-referrer policy).
// A request with none of them is not from a browser that sends cross-site forms (every current one sends Origin on a POST).
export function crossSite(req: Request, env: { get(k: string): string | undefined }): boolean {
  const own = new Set<string>();
  try { own.add(new URL(req.url).origin); } catch { /* no own origin */ }
  try { const b = new URL((env.get("TRAINEE_FILE_BASE_URL") || "").trim()); if (b.protocol === "https:") own.add(b.origin); } catch { /* not set */ }
  const site = (req.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin !== null) return origin.trim() === "null" ? !site : !own.has(origin.trim());
  if (site) return false;
  const ref = req.headers.get("referer");
  if (ref) { try { return !own.has(new URL(ref).origin); } catch { return true; } }
  return false;
}
// The body, read no further than `cap` bytes: null when it is bigger (an honest or a lying Content-Length alike).
async function readCapped(req: Request, cap: number): Promise<string | null> {
  const said = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(said) && said > cap) { await req.body?.cancel().catch(() => {}); return null; }
  if (!req.body) return "";
  const reader = req.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}
export const MAX_ROWS = FEED_ROWS;

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (h: string) => btoa(h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join(""));
// The file kinds' page script: the same in-place form flip as the jobs list, plus the draft's Copy button.
const KIND_SCRIPT = FEED_SCRIPT + COPY_SCRIPT;
const scriptHashes = (async () => `'sha256-${b64(await sha(FEED_SCRIPT))}' 'sha256-${b64(await sha(BOOT_SCRIPT))}'`)();
const kindScriptHash = (async () => `'sha256-${b64(await sha(KIND_SCRIPT))}'`)();
// frame-ancestors: Telegram's own web clients only (the Mini App is a frame inside web.telegram.org); nothing else may frame the page.
// img-src: the logo provider's origin only (computed from config), never every https host.
const FRAMES = "https://web.telegram.org https://*.telegram.org";
// Logos (audit R16, architect decision 2026-11-01): by DEFAULT from the employer's own domain, fetched by the server and served from
// this page's own origin (logo_cache.ts), so img-src is 'self' and the reader's browser contacts no third party; no own domain, the
// lettermark. A third-party logo service is never the default (Google's s2 favicons would tell Google which companies a person is
// looking at): TRAINEE_LOGO_URL=google, or an explicit https template with {domain}, opts in; a non-https template means no logos.
const S2 = "https://www.google.com/s2/favicons?sz=128&domain={domain}";
const logoMode = (env: { get(k: string): string | undefined }): string => { const v = (env.get("TRAINEE_LOGO_URL") || "").trim(); return !v || v === "self" ? "self" : v === "google" ? S2 : v; };
const selfLogos = (env: { get(k: string): string | undefined }) => logoMode(env) === "self";
const LOGOS = memoryLogoCache();
function logoOrigins(env: { get(k: string): string | undefined }): string {
  if (selfLogos(env)) return "'self'";
  const tpl = logoMode(env);
  let origin = "";
  try { const u = new URL(tpl.split("{domain}").join("example.com")); if (u.protocol === "https:") origin = u.origin; } catch { /* no logo provider */ }
  return [origin, origin.includes("google.com") ? "https://*.gstatic.com" : ""].filter(Boolean).join(" ");
}
async function headers(type: string, env: { get(k: string): string | undefined }): Promise<Record<string, string>> {
  // same-origin, not no-referrer: the page's own posts then carry its Origin (which the cross-site check reads; under no-referrer a
  // browser sends "Origin: null"), and nothing is ever sent to another site.
  return { "cache-control": "no-store", "referrer-policy": "same-origin", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "content-type": type,
    "content-security-policy": `default-src 'none'; script-src ${await scriptHashes} https://telegram.org; connect-src 'self'; img-src ${logoOrigins(env) || "'none'"}; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors ${FRAMES}` };
}
const NEW_LINK = "Ask Trainee in Telegram for your jobs again and open the new link.";

const resumeOf = (p: PreparedRow | null): string | null => {
  if (!p) return null;
  const name = String((p.payload as Record<string, unknown>)?.resume_name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (name) return name;
  const s = String((p.payload as Record<string, unknown>)?.resume_sha256 ?? "");
  return /^[a-f0-9]{64}$/.test(s) ? `resume ${s.slice(0, 12)}` : null;
};
const byHandOf = (url: string) => byHandUrl(url);

// Key details: only what the posting (or the search result) states. A part from the stored posting is "From the posting"; if any part
// came only from the search result the line says "Reported, not verified". Nothing unstated is shown.
function metaOf(job: JobView, post: PostingRow | null): { meta: string; metaSrc: "From the posting" | "Reported, not verified" | null } {
  const parts: string[] = []; let reported = false;
  const take = (fromPost: unknown, fromHit: unknown) => { if (fromPost) parts.push(String(fromPost)); else if (fromHit) { parts.push(String(fromHit)); reported = true; } };
  take(post?.location, job.location);
  take(post?.pay, job.pay);
  const dl = post?.deadline ?? job.deadline;
  if (dl && dayOf(dl)) { parts.push(`Apply by ${dayOf(dl)}`); if (!post?.deadline) reported = true; }
  if (job.source) parts.push(job.source);
  return { meta: parts.join(" · "), metaSrc: parts.length ? (reported ? "Reported, not verified" : "From the posting") : null };
}

const ogImage = (env: { get(k: string): string | undefined }) => { const b = (env.get("TRAINEE_FILE_BASE_URL") || "").trim(); return /^https:\/\//.test(b) ? `${new URL(b).origin}/og-file.png` : null; };
// Every value the application will send, from the real payload the hash covers, in full: the resume, each field (a file by its name),
// the cover note, the page-set fields, every other key of the payload, and the destination. A secret-looking field or key (the same
// rule the Telegram card's Confirm uses: telegram_jobs.ts isSecretField / secretKey / secretFields) is shown as "Needs you", never its
// value, and makes the row unapprovable here. The payload's own bookkeeping (who, which posting, epochs, expiry) is not sent to anyone.
const BOOKKEEPING = new Set(["version", "user_id", "job_id", "company", "url", "title", "fields", "resume_sha256", "resume_name", "resume_file", "cover_note", "page_field_names",
  "destination", "privacy_epoch", "account_version", "expires_at", "kind", "resume_tailored", "resume_persona"]);
const shownValue = (v: unknown) => v === "" || v === null || v === undefined ? "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v);
function sendOf(p: PreparedRow): { items: { label: string; value: string; needs?: boolean }[]; secret: string | null; answers: boolean; cover: boolean } {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const items: { label: string; value: string; needs?: boolean }[] = [];
  let secret: string | null = null, answers = false;
  const sha = String(pl.resume_sha256 ?? ""), resumeName = String(pl.resume_name ?? ""), resumeFile = String(pl.resume_file ?? "");
  items.push({ label: "Resume", value: resumeOf(p) ?? "none attached" });
  // deno-lint-ignore no-explicit-any
  for (const f of (Array.isArray(pl.fields) ? pl.fields : []) as any[]) {
    const label = String(f?.label ?? f?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Field";
    if (isSecretField(f)) { items.push({ label, value: "", needs: true }); secret ??= label; continue; }
    if (foreignFact(f, pl)) { items.push({ label, value: NOT_YOURS }); continue; }
    const v = f?.value, file = /file/i.test(String(f?.type ?? ""));
    if ((sha && v === sha) || (file && ((resumeName && v === resumeName) || (resumeFile && v === resumeFile)))) continue; // the resume line above
    if (shownValue(v) !== "(empty)") answers = true;
    items.push({ label, value: file ? `file ${shownValue(v)}` : shownValue(v) });
  }
  const coverRaw = typeof pl.cover_note === "string" ? pl.cover_note : pl.cover_note && typeof pl.cover_note === "object" ? (pl.cover_note as Record<string, unknown>).text : "";
  const cover = String(coverRaw ?? "").trim();
  if (cover) items.push({ label: "Cover note", value: cover });
  const pageFields = Array.isArray(pl.page_field_names) ? pl.page_field_names.map(String) : [];
  if (pageFields.length) items.push({ label: "Also sent, set by the employer's page, unchanged", value: pageFields.join(", ") });
  for (const [k, v] of Object.entries(pl)) {
    if (BOOKKEEPING.has(k)) continue;
    if (secretKey(k, v)) { items.push({ label: k, value: "", needs: true }); secret ??= k; continue; }
    items.push({ label: k, value: typeof v === "string" ? v : JSON.stringify(v) });
  }
  const dest = String(pl.destination ?? p.url ?? "");
  if (dest) items.push({ label: "Sends to", value: hostOf(dest) || dest.slice(0, 120) });
  secret ??= secretFields(p)[0] ?? null; // anything else the card's Confirm would refuse (a card line, a nested value)
  return { items, secret, answers, cover: !!cover };
}
// The logo only from the employer's own domain, through the configured provider, https only; the CSP allows that provider's origin only.
function rowLogo(job: JobView, env: { get(k: string): string | undefined }): string | null {
  if (selfLogos(env)) { const dom = logoDomain(job, env); return dom && validDomain(dom) ? `?logo=${encodeURIComponent(dom)}` : null; }
  const dom = logoDomain(job, env), tpl = logoMode(env), u = dom ? tpl.split("{domain}").join(encodeURIComponent(dom)) : null;
  if (!dom || !u || !/^https:\/\//.test(u)) return null;
  try {
    const x = new URL(u), allowed = logoOrigins(env).split(" ").filter(Boolean)[0];
    return x.protocol === "https:" && x.origin === allowed && u.includes(encodeURIComponent(dom)) ? u : null;
  } catch { return null; }
}

async function loadFeed(claims: FileClaims, token: string, d: FileDeps, notes: Record<string, string> = {}, top?: string): Promise<Feed | null> {
  const all = (await d.store.recallList(claims.u, claims.r).catch(() => null)) ?? [];
  const refs = all.slice(0, MAX_ROWS);
  const got = (await Promise.all(refs.map(async (ref) => ({ ref, c: await d.store.recall(claims.u, ref).catch(() => null) })))).filter((x) => x.c);
  if (!got.length) return null;
  const postings = await d.store.postings(got.map((x) => x.c!.job.job_id)).catch(() => [] as PostingRow[]);
  // The posting screen (closed, stale, scam-looking, a knock-out against a CONFIRMED fact) runs on every row the page would offer,
  // with one read of the facts: a row that cannot pass it offers no Apply and says why, so neither Apply nor "Apply to all" offers
  // what the tap would then refuse (scenarios-file-apply.test.ts: a closed posting showed Apply and sat in the "Apply to all" set).
  const facts = d.facts ? await d.facts(claims.u).then((f) => f ?? [], () => []) : [];
  // The account's stamp, once (apply_trust.ts): a payload prepared under another account state is not offered.
  const account = d.account ? await d.account(claims.u).catch(() => "unreadable" as const) : undefined;
  const tz = d.timeZone ? await d.timeZone(claims.u).catch(() => null) : null;
  const rows: Row[] = await Promise.all(got.map(async ({ ref, c }) => {
    const job = { ...c!.job }, post = postings.find((p) => p.job_id === job.job_id) ?? null;
    job.company_domain = job.company_domain ?? post?.company_domain ?? null;
    const [app, prep] = await Promise.all([d.store.appRow(claims.u, job.job_id, job.url).catch(() => null), d.store.prepared(claims.u, job.job_id).catch(() => null)]);
    // Sent or on its way by another path (the extension, a batch, the same posting under another id): the row says so and offers
    // nothing (apply round 3: such a row offered Apply, and the tap could only be refused as a duplicate).
    const away = !app && d.store.elsewhere ? await d.store.elsewhere(claims.u, job).catch(() => false) : false;
    const wanted = app || prep || away ? false : await d.store.wanted(claims.u, job.url, job).catch(() => false);
    // An application already in motion is described by its status; the prepared payload is not what it sends.
    const sd = prep && !app && !away ? sendOf(prep) : null;
    const status = statusOf({ app, wanted }) ?? (away ? ELSEWHERE : null) ?? (sd?.secret ? { word: "needs you" as const, detail: `"${sd.secret}" needs you. I never send a password, code or ID number from here; tell Trainee in Telegram.` } : null);
    const byHand = byHandOf(job.url);
    let blocked: string | null = null;
    if (!status && !byHand) {
      if (prep && byHandOf(String((prep.payload as Record<string, unknown>)?.destination ?? prep.url ?? ""))) blocked = "it would be sent to LinkedIn, Indeed or Handshake, which Trainee never applies on for you.";
      // A destination that is not a web address (javascript:, data:, a bare word) is not somewhere an application can go (file journey
      // round 2: a payload sending to "javascript:..." was offered for one-tap approval).
      else if (prep && !webDestination(prep)) blocked = "its application doesn't go to a web address, so it can't be sent. Tell Trainee in Telegram to prepare it again.";
      // Expired, prepared under another account state, or an answer the contract never sends (apply_trust.ts): the queue or the
      // worker would refuse it after the yes, so the page offers no Apply (apply round 3).
      else if (prep && (blocked = await unsendable(claims.u, prep, d, account))) blocked = `${blocked}.`;
      else if (!post) blocked = "I couldn't check this posting just now (it may have closed). Refresh in a minute.";
      else blocked = postingVerdict(job, post, facts, !!d.facts, d.now());
    }
    const tag = prep && !sd?.secret && !status && !byHand && !blocked && /^[0-9a-f]{16}$/.test(hashTag(prep.payload_hash)) ? hashTag(prep.payload_hash) : null;
    // The short description and the key details: the stored posting's own words; a search-only detail only in the labelled line.
    const stated = { ...job, location: post?.location ?? "", remote: post ? job.remote : null };
    return { ref, job, logo: rowLogo(job, d.env), snippet: snippetOf(stated, post?.description), full: fullOf(post?.description),
      status, inApps: !!app || away, tag, resume: app || away ? null : resumeOf(prep), byHand, blocked, note: notes[ref], ...metaOf(job, post), posted: postedLine({ posted_at: post?.posted_at ?? job.posted_at, first_seen_at: post?.first_seen_at ?? job.first_seen_at }, d.now(), tz), why: job.reasons.slice(0, 2),
      sends: sd && !sd.secret ? `Sends: ${[resumeOf(prep) ?? "no resume", sd.answers ? "your saved answers" : "", sd.cover ? "a cover note" : ""].filter(Boolean).join(" + ")}` : undefined, send: sd?.items };
  }));
  // The same posting twice on one list (the same link under two ids): only the first row offers Apply.
  const seenUrl = new Set<string>();
  for (const r of rows) {
    if (!r.status && !r.byHand && !r.blocked && seenUrl.has(r.job.url)) { r.blocked = "it's the same posting as a row above."; r.tag = null; }
    seenUrl.add(r.job.url);
  }
  // The set "Apply to all" approves: the rows that can be approved right now, with the exact payload tag each shows.
  const set = rows.filter((r) => !r.status && !r.byHand && !r.blocked && r.tag);
  const setHash = set.length ? (await sha(`v1|${set.map((r) => `${r.ref}:${r.tag}`).join(",")}`)).slice(0, 16) : null;
  const n = rows.length;
  // The preview card is the brand card (static, nothing about the person in a public image) plus counts the page itself shows.
  const og = { title: `${n} match${n === 1 ? "" : "es"} for you`, description: "Tap Apply on any job. Opens in Trainee.", image: ogImage(d.env) };
  // The File shell (file_design.ts): who it is for (a CONFIRMED name only, else "you"), and when the postings on it were last seen
  // live on their boards (career_postings.last_seen_at), in the person's zone; none known, the page says the check time is unknown.
  const shown = new Set(rows.map((r) => r.job.job_id));
  const stamp = freshnessStamp("Postings checked", postings.filter((p) => shown.has(p.job_id)).map((p) => p.last_seen_at), { now: d.now(), tz });
  return { token, rows, setHash, setSize: set.length, top, og, total: all.length, made: madeForLine(firstNameOf(facts), d.now(), tz), stamp };
}

// One Apply = one hash-bound approval through the Telegram Confirm path. Returns a note for the row when it did not go.
// The page's own words where Telegram's would name a button the page does not have (file journey round 2: "Tap Confirm again" on a
// page whose button is Apply), and a reason in full, never cut mid-word or mid-link.
async function approveOne(u: string, ref: string, tag: string, d: FileDeps): Promise<string | null> {
  const said: string[] = [];
  const send: JobSender = { photo: async () => ({ ok: true }), text: async (a) => { said.push(a.text); return { ok: true, id: null }; } };
  const res = await tapJob({ userId: u, data: `jcy:${ref}:${tag}`, messageId: null, deps: d, send });
  if (res.status === "confirmed") return null;
  if (res.status === "changed") return "Changed since you opened this page, so nothing was sent.";
  if (res.status === "duplicate") return "Already in your applications.";
  if (res.status === "failed") return "I couldn't open the approval just now, so nothing was approved. Tap Apply again in a minute.";
  return cut((said[0] ?? "Nothing was approved.").replace(/\s+/g, " ").trim(), 600);
}
const ELSEWHERE = { word: "in applications" as const, detail: "Already sent or on its way another way (your computer, the browser extension, or the same posting under another link). Each posting goes once." };
const webDestination = (p: PreparedRow) => { const dest = (p.payload as Record<string, unknown>)?.destination; return dest === undefined || dest === null || dest === "" || /^https?:\/\/\S+$/i.test(String(dest)); };

const CRAWLER = /TelegramBot|Twitterbot|facebookexternalhit|Slackbot|WhatsApp|Discordbot|LinkedInBot/i;
const cookieOf = (req: Request, name: string) => {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
  return "";
};

// A store or provider that throws where no step expects it still gets a page: nothing was opened or sent, try again
// (tests/architect/scenarios-file-signin.test.ts: a failing count or sign-in write used to reject with no response at all).
export async function handleFile(req: Request, d: FileDeps): Promise<Response> {
  try {
    return await handleFileOnce(req, d);
  } catch {
    // The designed error state (brief P6.8): what happened, why, what happens next, and a retry that reopens this same page.
    const here = (() => { try { return `/${new URL(req.url).pathname.replace(/^[\/\\]+/, "")}`; } catch { return "/"; } })();
    const page = layout("Couldn't open this just now - Trainee", `<div id="root"><header class="fhead">${BRAND}</header><div class="fcard"><main id="main">${stateHtml({ kind: "error", title: "Couldn't open this just now",
      reason: "Part of Trainee didn't answer. Nothing was opened and nothing was sent.", next: "Try again in a minute. Your link keeps working until it expires.", retry: { href: here, label: "Try again" } })}</main></div></div>`);
    return new Response(page, { status: 503, headers: await headers("text/html; charset=utf-8", d.env) });
  }
}

async function handleFileOnce(req: Request, d: FileDeps): Promise<Response> {
  const html = async (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...(await headers("text/html; charset=utf-8", d.env)), ...extra } });
  const text = async (body: string, status = 200) => new Response(body, { status, headers: await headers("text/plain; charset=utf-8", d.env) });
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return html(renderLinkState("Not supported", ["This page only opens and answers."]), 405, { allow: ALLOWED_METHODS });
  // A HEAD (a link scanner, a preview, a prefetch) reads nothing and changes nothing: it never begins a link's sign-in (whose
  // 15 minutes would then run out before the person opens it) and never uses a link up (file page web-security round).
  if (req.method === "HEAD") return html("", 200);
  const url = new URL(req.url);
  // Every redirect goes to this page's own path on this host: a path that starts with two slashes (or a backslash a browser reads as
  // one) would be a link to another host (file journey round 2: "//evil.example/?t=..." redirected there after the sign-in).
  const here = `/${url.pathname.replace(/^[\/\\]+/, "")}`;
  let fields: URLSearchParams = url.searchParams;
  if (req.method === "POST") {
    // Another site's form changes nothing here (file page web-security round: a cross-site post with the person's cookies texted
    // codes, checked guesses, reset the sign-in, and with the page's form value approved and signed out).
    if (crossSite(req, d.env)) { await req.body?.cancel().catch(() => {}); return html(renderLinkState("This came from another site", ["Nothing was done and nothing was sent. Open the page itself and try again."]), 403); }
    let body: string | null = "";
    try { body = await readCapped(req, MAX_BODY_BYTES); } catch { body = ""; }
    if (body === null) return html(renderLinkState("That was too large", ["Nothing was done and nothing was sent."]), 413);
    fields = new URLSearchParams(body);
  }
  const botUrl = (d.env.get("TRAINEE_BOT_URL") || "").trim();
  const bot = /^https:\/\//.test(botUrl) ? botUrl : null;
  const secret = d.env.get("TRAINEE_FILE_LINK_SECRET");
  const state = (title: string, paras: string[], status: number) => html(renderLinkState(title, paras, bot), status);
  const bad = (why: string) => why === "not_configured" ? state("Links aren't set up yet", ["The jobs page isn't switched on yet, so nothing can be opened. Nothing was sent."], 503)
    : why === "expired" ? state("This link has expired", ["Links last a day so a forwarded one stops working. " + NEW_LINK], 410)
    : state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);

  const sessions = d.sessions;
  if (!sessions) return state("Sign-in isn't set up yet", ["The jobs page isn't switched on yet, so nothing can be opened. Nothing was sent."], 503);
  const check = (id: string) => checkSession(id, { sessions, phone: d.phone, userOfTelegram: d.userOfTelegram, now: d.now() });
  const action = req.method === "POST" ? (fields.get("action") ?? "") : "";
  // A tap that reaches an ended sign-in says what became of it: nothing was approved (file journey round 2: an Apply after the session
  // expired or was signed out elsewhere only said "You were signed out", leaving whether it went unsaid).
  const tapped = action === "apply" || action === "applyall" || action === "applysel" || action === "answer" || action === "dismiss" || action === "restore" || action === "pause" || action === "resume" ? ["Nothing was approved or sent from this tap."] : [];
  const signedOut = (why: string) => why === "error" ? state("Couldn't open this just now", ["Nothing was sent. Try again in a minute."], 503)
    : why === "expired" ? state("You were signed out", [...tapped, "Sign-ins last two hours. " + NEW_LINK], 401)
    : why === "revoked" || why === "unbound" ? state("You were signed out", [...tapped, "This sign-in was ended. " + NEW_LINK], 401)
    : state("This link isn't valid", [...tapped, "It may be cut short or changed. " + NEW_LINK], 403);
  const given = req.method === "GET" ? (url.searchParams.get("t") ?? "") : "";
  // The browser's own session: the tf_s cookie, and only ever a phone session (a Telegram session never lives in a cookie, so an id
  // copied out of a Mini App page and planted as a cookie opens nothing).
  const cookieSession = async (): Promise<SessionCheck> => {
    const sc = await check(cookieOf(req, "tf_s"));
    return sc.ok && sc.row.via !== "phone" ? { ok: false, why: "none" } : sc;
  };
  // A post whose form value is not backed by what only the session's own holder has (the cookie; for the Mini App, Telegram's fresh
  // signed data for that Telegram user): a saved, copied, cached or shared page. Nothing is read, approved or changed.
  const notHere = () => state("Sign in on this device", [...tapped, "This page works only in the browser or Telegram screen where you signed in, so nothing was opened, approved or changed.",
    "If that is here, reload the page. Otherwise: " + NEW_LINK], 401);

  // ---- the link from the bot: says WHICH list, never WHO opened it. It opens a phone sign-in, never the list itself.
  if (given) {
    const c = await verifyFileToken(given, secret, d.now());
    if (!c.ok) return bad(c.why);
    if (c.claims.k !== "l") return bad("malformed");
    if (CRAWLER.test(req.headers.get("user-agent") ?? "")) {
      // A link preview fetch: the brand card and, for a file of another kind, the kind's name; nothing about the person (not even
      // how many jobs) and the link is not touched.
      const g = d.files ? await d.files.get(c.claims.u, c.claims.r).catch(() => null) : null;
      if (g && g.state !== "missing") return html(layout("Trainee", `<header>${BRAND}<h1>A file from Trainee</h1></header><main id="main"><p>Open this link in your browser, or from Telegram.</p></main>`, { og: { title: `${KIND_LABEL[g.rec.kind]} from Trainee`, description: "Sign in to open it.", image: ogImage(d.env) } }));
      return html(renderPreview({ title: "Your jobs from Trainee", description: "Sign in with your phone number to see them.", image: ogImage(d.env) }));
    }
    const cur = await cookieSession();
    if (cur.ok && cur.userId !== c.claims.u) {
      return html(layout("A different account - Trainee", `<header>${BRAND}<h1>This link is for a different Trainee account</h1></header><main id="main"><p>You are signed in as someone else here, so nothing from this link was opened. Sign out first, then open the link again.</p>${signOutFoot((await pageTokenOf(cur.idHash, secret)) ?? "")}</main>`), 403);
    }
    const row = await sessions.beginLogin({ jti: c.claims.j, userId: c.claims.u, list: c.claims.r, at: d.now(), expiresAt: Math.min(d.now() + LOGIN_TTL_MS, c.claims.e) }).catch(() => null);
    if (!row) return state("Couldn't open this just now", ["Nothing was used up. Try the link again in a minute."], 503);
    if (row.user_id !== c.claims.u || row.list !== c.claims.r) return bad("malformed");
    if (cur.ok) {
      // Already signed in on this browser as the same account (by phone or Telegram): the link only picks the list.
      await sessions.finishLogin(c.claims.j, d.now()).catch(() => false);
      await sessions.setList(cur.idHash, c.claims.r).catch(() => {});
      return html("", 303, { location: here });
    }
    if (row.done_at) return state("This link was already used", ["A link opens a sign-in once. " + NEW_LINK], 410);
    return html("", 303, { location: here, "set-cookie": loginCookie(given) });
  }

  const locked = () => state("Too many wrong codes", ["This link is locked so nobody can guess the code. " + NEW_LINK], 429);
  // ---- phone sign-in steps (the pending link is in the HttpOnly tf_l cookie)
  if (action === "phone_reset") return phoneStep(action);
  if (action === "phone_start" || action === "phone_verify") {
    // Every answer of these two steps is paced to the same floor, whatever the number and whatever was refused, so the time an
    // answer takes cannot say whether the typed number is the account's (only then is a code texted or checked).
    const began = performance.now();
    const res = await phoneStep(action);
    if (d.pace) await d.pace(action, performance.now() - began).catch(() => {});
    return res;
  }
  async function phoneStep(step: string): Promise<Response> {
    const lt = await verifyFileToken(cookieOf(req, "tf_l"), secret, d.now());
    if (!lt.ok) return lt.why === "expired" ? bad("expired") : state("Open your link again", ["This sign-in isn't open any more. " + NEW_LINK], 403);
    if (lt.claims.k !== "l") return bad("malformed");
    const row = await sessions!.login(lt.claims.j).catch(() => null);
    if (!row || row.user_id !== lt.claims.u) return state("Open your link again", ["This sign-in isn't open any more. " + NEW_LINK], 403);
    if (row.done_at) return state("This link was already used", ["A link opens a sign-in once. " + NEW_LINK], 410);
    if (d.now() >= Date.parse(row.expires_at)) return state("This sign-in has expired", ["Codes must be typed within 15 minutes. " + NEW_LINK], 410);
    if (row.tries >= MAX_CODE_TRIES) return locked();
    const page = (st: "phone" | "code", note?: string, status = 200) => html(renderPhoneLogin({ step: st, note, botUrl: bot }), status);
    const down = () => state("Couldn't open this just now", ["Nothing was sent. Try again in a minute."], 503);
    if (!d.phone) return state("Phone sign-in isn't switched on yet", ["Nothing was opened and nothing was sent."], 503);
    if (step === "phone_reset") { await sessions!.setPhone(row.jti, null, false).catch(() => {}); return page("phone"); }
    if (step === "phone_start") {
      const phone = normalizePhone(fields.get("phone"));
      if (!phone) return page("phone", "That doesn't look like a phone number. Include the country code if it's outside the US.", 400);
      // Whether texting is switched on is asked BEFORE the number is compared, so the answer cannot depend on the number.
      if (d.phone.ready && !(await d.phone.ready().catch(() => false))) return state("Phone sign-in isn't switched on yet", ["No code was sent. Nothing was opened."], 503);
      const own = await d.phone.accountPhone(row.user_id).catch(() => undefined);
      if (own === undefined) return down();
      const matched = !!own && own === phone;
      if (!(await sessions!.setPhone(row.jti, phone, matched).then(() => true, () => false))) return down();
      // The same answer whether or not the number is the account's: a forwarded link never learns whose it is. So a number
      // that matched answers exactly as any other number does, also when its texts are used up or the text could not go out
      // (a different note there told a stranger "this is the account's number"; scenarios-file-signin.test.ts).
      if (matched) {
        const counted = await sessions!.countSend(row.jti, MAX_CODE_SENDS).catch(() => null);
        if (counted === null) return down();
        if (counted) {
          // Sent in the background: the answer never waits for the provider, so its time is the same for any number.
          let sending: Promise<void>;
          try {
            sending = d.phone.send(phone).then((sent) => { if (!sent.ok) console.error(`trainee-file: the sign-in code was not texted (${sent.why})`); },
              () => console.error("trainee-file: the sign-in code was not texted (refused)"));
          } catch { sending = Promise.resolve(); console.error("trainee-file: the sign-in code was not texted (refused)"); }
          if (d.background) d.background(sending);
        }
      }
      return page("code");
    }
    // phone_verify
    if (!row.phone) return page("phone");
    const tried = await sessions!.countTry(row.jti, MAX_CODE_TRIES).catch(() => null);
    if (tried === null) return down();
    if (!tried) return locked();
    const code = codeOf(fields.get("code"));
    const who = code && row.matched ? await d.phone.check(row.phone, code).catch(() => null) : null;
    const still = who === row.user_id ? await d.phone.accountPhone(row.user_id).catch(() => null) : null;
    if (who !== row.user_id || still !== row.phone) return page("code", "That code didn't work. Check the latest text and try again.", 401);
    const finished = await sessions!.finishLogin(row.jti, d.now()).catch(() => null);
    if (finished === null) return down();
    if (!finished) return state("This link was already used", ["A link opens a sign-in once. " + NEW_LINK], 410);
    const id = await startSession(sessions!, { userId: row.user_id, via: "phone", phone: row.phone, telegramId: null, list: row.list, now: d.now() }).catch(() => "");
    if (!id) return state("Couldn't open this just now", ["Nothing was opened. This link is used up, so " + NEW_LINK.charAt(0).toLowerCase() + NEW_LINK.slice(1)], 503);
    return new Response("", { status: 303, headers: [...Object.entries(await headers("text/html; charset=utf-8", d.env)), ["location", here], ["set-cookie", sessionCookie(id)], ["set-cookie", CLEAR_LOGIN]] });
  }

  // token: what this session's pages carry in their forms (a phone session's page token; a Mini App session's id, see file_session.ts).
  let token = "";
  let s: SessionCheck;
  if (req.method === "POST" && !fields.get("t")) {
    const list = fields.get("list") ?? "";
    if (!/^[0-9a-f]{10}$/.test(list) || !fields.get("init")) return state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);
    // Mini App login: Telegram's signed initData, then the account that Telegram identity is linked to (a Telegram login, not a phone check).
    const init = await verifyInitData(fields.get("init"), d.env.get("TELEGRAM_BOT_TOKEN"), d.now());
    if (!init.ok) {
      if (init.why === "not_configured") return state("Sign-in isn't set up yet", ["Telegram sign-in isn't switched on yet, so nothing can be opened. Nothing was sent."], 503);
      if (init.why === "stale") return state("This sign-in has expired", ["Close this screen and open the list again from Telegram."], 410);
      return state("Telegram couldn't verify this sign-in", ["Nothing was opened. Open the list again from the button in Telegram."], 403);
    }
    const user = d.userOfTelegram ? await d.userOfTelegram(init.telegramId).catch(() => null) : null;
    if (!user) return state("This Telegram account isn't linked", ["Share your phone number with Trainee in the Telegram chat first, then open the list again."], 403);
    token = await startSession(sessions, { userId: user, via: "telegram", phone: null, telegramId: init.telegramId, list, now: d.now() }).catch(() => "");
    if (!token) return state("Couldn't open this just now", ["Nothing was sent. Try again in a minute."], 503);
    s = await check(token);
  } else if (req.method === "POST") {
    const t = fields.get("t") ?? "";
    if (PAGE_TOKEN.test(t)) {
      // A phone session's page: the cookie is the session; the form's page token must be the one drawn for that very cookie.
      const cookie = cookieOf(req, "tf_s");
      if (!SESSION_ID.test(cookie)) return notHere();
      const want = await pageTokenOf(await sha256(cookie), secret);
      if (!want || !sameToken(t, want)) return notHere();
      s = await check(cookie);
      if (s.ok && s.row.via !== "phone") return notHere();
    } else if (SESSION_ID.test(t)) {
      // A Mini App session's page: the id in the form opens it only with Telegram's signed data, fresh, for the session's own
      // Telegram user (the Mini App's script adds it to every post; it is never in the page).
      if (!fields.get("init")) return notHere();
      const init = await verifyInitData(fields.get("init"), d.env.get("TELEGRAM_BOT_TOKEN"), d.now());
      if (!init.ok) {
        if (init.why === "not_configured") return state("Sign-in isn't set up yet", ["Telegram sign-in isn't switched on yet, so nothing can be opened. Nothing was sent."], 503);
        if (init.why === "stale") return state("This sign-in has expired", [...tapped, "Close this screen and open the list again from Telegram."], 410);
        return state("Telegram couldn't verify this sign-in", [...tapped, "Nothing was opened. Open the list again from the button in Telegram."], 403);
      }
      s = await check(t);
      if (s.ok && (s.row.via !== "telegram" || s.row.telegram_id !== init.telegramId)) return notHere();
      token = t;
    } else return notHere();
  } else {
    const list = url.searchParams.get("list") ?? "";
    if (/^[0-9a-f]{10}$/.test(list)) return html(renderBootstrap(list)); // the Mini App page: reads Telegram's signed data and posts it back
    const cookie = cookieOf(req, "tf_s");
    // A link opened on this browser that is waiting for the phone sign-in.
    const pending = async (): Promise<Response | null> => {
      const lt = await verifyFileToken(cookieOf(req, "tf_l"), secret, d.now());
      if (!lt.ok || lt.claims.k !== "l") return null;
      const row = await sessions.login(lt.claims.j).catch(() => null);
      if (row && !row.done_at && row.user_id === lt.claims.u && d.now() < Date.parse(row.expires_at)) return row.tries >= MAX_CODE_TRIES ? locked() : html(renderPhoneLogin({ step: row.phone ? "code" : "phone", botUrl: bot }));
      return null;
    };
    if (!SESSION_ID.test(cookie)) return (await pending()) ?? state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);
    // An ended session's cookie (signed out elsewhere, expired, phone changed) must not hide the sign-in a NEW link opened:
    // the browser keeps tf_s until its Max-Age, and every read would say "signed out, open a new link" in a loop
    // (scenarios-file-signin.test.ts). The pending sign-in wins and the dead cookie is cleared.
    s = await cookieSession();
    if (!s.ok && s.why !== "error") {
      const p = await pending();
      if (p) { p.headers.append("set-cookie", CLEAR_SESSION); return p; }
    }
  }

  // ---- every private read and action: the session again, checked against the account right now
  if (!s.ok) return signedOut(s.why);
  // A phone session's pages carry its page token, never its id (the id is in the HttpOnly cookie only).
  if (!token) token = (await pageTokenOf(s.idHash, secret)) ?? "";
  if (!token) return state("Sign-in isn't set up yet", ["The jobs page isn't switched on yet, so nothing can be opened. Nothing was sent."], 503);
  if (action === "signout" || action === "signout_all") {
    const ok = await (action === "signout" ? sessions.revoke(s.idHash, d.now()) : sessions.revokeAll(s.userId, d.now())).then(() => true, () => false);
    if (!ok) return state("Couldn't sign out just now", ["You are still signed in. Try again in a minute."], 503);
    return new Response(renderLinkState("Signed out", [action === "signout" ? "You are signed out on this device." : "You are signed out everywhere this page was open.", "Open a new link from Trainee to sign in again."], bot), { status: 200, headers: [...Object.entries(await headers("text/html; charset=utf-8", d.env)), ["set-cookie", CLEAR_SESSION]] });
  }
  const claims = { u: s.userId, r: s.list, k: "s", j: "0".repeat(16), i: 0, e: Date.parse(s.row.expires_at) } as FileClaims;
  const { u } = claims;
  // A logo for a row of THIS signed-in person's list, from that employer's own domain (TRAINEE_LOGO_URL=self). Any other domain: 404.
  if (req.method === "GET" && url.searchParams.has("logo")) return await logoOf(url.searchParams.get("logo") ?? "", claims, d);
  if (d.files) {
    const g = await d.files.get(u, claims.r).catch(() => null);
    if (g && g.state !== "missing") return handleKind({ g, d, claims, token, action, fields, req, html, text, state });
  }
  // A results list (a role ask, role_results.ts): Apply on a prepared card approves what its "What will be sent" shows; on a card
  // that isn't ready it asks for what's missing. Unreadable is not "a plain list": the page then offers nothing.
  let meta: ListMeta | null = null;
  if (d.store.recallListMeta) {
    try { meta = await d.store.recallListMeta(u, claims.r); } catch { return state("Couldn't open this just now", ["Nothing was opened and nothing was sent. Try again in a minute."], 503); }
  }
  if (meta) return handleResults({ meta, d, claims, token, action, fields, url, req, html, text, state });
  const notes: Record<string, string> = {};
  let top: string | undefined;

  if (action) {
    if (!["apply", "applyall", "refresh"].includes(action)) return state("Not done", ["That is not something this page can do. Nothing was sent."], 400);
    const refs = (await d.store.recallList(u, claims.r).catch(() => null)) ?? [];
    if (action === "refresh") { /* a fresh read below; nothing to do */ }
    else if (action === "apply") {
      const ref = fields.get("ref") ?? "", tag = fields.get("tag") ?? "";
      if (!refs.includes(ref)) return state("This job isn't on your list", ["It is no longer on your list. " + NEW_LINK], 404);
      const cur = await loadFeed(claims, token, d);
      const row = cur?.rows.find((r) => r.ref === ref);
      if (!row && refs.indexOf(ref) >= MAX_ROWS) return state("This job isn't on this page", [`The page shows the first ${MAX_ROWS} postings of your list and this one is past them. Nothing was sent. ` + NEW_LINK], 404);
      if (!row) return state("This job isn't on your list", [NEW_LINK], 404);
      // Already in motion (approved from Telegram, another device, or before): nothing more is approved, and the row says so rather
      // than the tap silently turning into the status word as if this tap had queued it (file journey round 2).
      if (row.status) notes[ref] = row.inApps ? `Already in your applications, so nothing more was sent. ${row.status.detail}` : `Nothing was approved: ${row.status.detail}`;
      else if (row.byHand) notes[ref] = "Not applied for automatically on this site. Open it and apply there yourself.";
      // The posting screen ran when the row was read (closed, stale, scam-looking, knock-out, the same posting twice): nothing goes.
      else if (row.blocked) notes[ref] = `${tag === "none" ? "Not queued" : "Nothing was approved"}: ${row.blocked}`;
      else if (tag === "none" && !row.tag) {
        const w = await d.store.want(u, row.job, d.now()).catch(() => ({ result: "refused" as const, reason: "I couldn't save that just now." }));
        if (w.result === "refused") notes[ref] = `Not queued: ${w.reason ?? "I can't open that posting's application form yet."}`;
      } else if (!/^[0-9a-f]{16}$/.test(tag) || tag !== row.tag) {
        notes[ref] = "Changed since you opened this page, so nothing was sent.";
      } else {
        const n = await approveOne(u, ref, tag, d);
        if (n) notes[ref] = n;
      }
    } else {
      // Apply to all: exactly the set that was shown. If the set is not the same now, nothing is approved.
      const cur = await loadFeed(claims, token, d);
      const posted = fields.get("set") ?? "";
      if (!cur || !cur.setHash || posted !== cur.setHash) top = "This list changed since you opened it, so nothing was approved.";
      else {
        for (const r of cur.rows.filter((x) => !x.status && !x.byHand && !x.blocked && x.tag)) {
          const n = await approveOne(u, r.ref, r.tag!, d);
          if (n) notes[r.ref] = n;
        }
        const failed = Object.keys(notes).length;
        if (failed) top = `${failed} of ${cur.setSize} were not approved; each says why.`;
      }
    }
  }

  const feed = await loadFeed(claims, token, d, notes, top);
  if (!feed) return state("This list is gone", ["It is no longer available. " + NEW_LINK], 404);
  if (req.method === "GET" && fields.get("format") === "text") return text(renderText(feed));
  return html(renderFeed(feed));
}

// ---------------------------------------------------------------- the other kinds: one shell, the kind's body, the kind's actions
async function handleKind(o: { g: Exclude<Awaited<ReturnType<FileService["get"]>>, { state: "missing" }>; d: FileDeps; claims: FileClaims; token: string; action: string; fields: URLSearchParams; req: Request;
  html: (b: string, s?: number, e?: Record<string, string>) => Promise<Response>; text: (b: string, s?: number) => Promise<Response>; state: (t: string, p: string[], s: number) => Promise<Response> }): Promise<Response> {
  const { d, claims, token, action, fields, req } = o, files = d.files!, u = claims.u;
  if (o.g.state === "expired") return o.state("This file has expired", [`Files last ${files.ttlHours()} hours so a forwarded link stops working. Ask Trainee in Telegram to make it again.`], 410);
  if (o.g.state === "revoked") return o.state("This file was removed", ["It is no longer available. Ask Trainee in Telegram if you need it again."], 410);
  let rec: FileRecord = o.g.rec, note = "";
  if (action === "remove") {
    const done = await files.revoke(u, rec.id).catch(() => false);
    if (!done) return o.state("Couldn't remove this file", ["It was not removed and its link still works. Try again in a minute."], 500);
    return o.state("File removed", ["This file is removed. The link no longer opens it."], 200);
  }
  if (action) {
    const r = await actOn(rec, action, fields, d.now(), d.fileEffects, (patch) => files.patchState(u, rec.id, patch), () => files.claim(u, rec.id, "choice"));
    if (r.status === 400) return o.state("Not done", [r.note], 400);
    if (r.patch) await files.patchState(u, rec.id, r.patch);
    note = r.note;
    const again = await files.get(u, rec.id);
    if (again.state !== "ok") return o.state("This file is gone", ["It is no longer available."], 410);
    rec = again.rec;
  }
  if (req.method === "GET" && fields.get("format") === "text") return o.text(textOf(rec, { now: d.now() }));
  // The shared File shell (file_design.ts): "Made for <first name> · <date>" above one card; the title, then when its facts were read
  // (the moment this File was built from them; an application proof reads the application record), in the person's zone.
  const [tz, facts] = await Promise.all([d.timeZone ? d.timeZone(u).catch(() => null) : null, d.facts ? d.facts(u).then((f) => f ?? [], () => []) : []]);
  const stampLabel = rec.kind === "application_proof" ? "Application record read" : "Facts as of";
  const shots = evidenceOrigin(d.env);
  const body = `${note ? `<p class="note-top" role="status">${esc(note)}</p>` : ""}${bodyHtml(rec, token, { tz, evidenceImage: (x) => !!shots && originOf(x) === shots })}`;
  const inner = `<div id="root">${fileShellHtml({ made: madeForLine(firstNameOf(facts), rec.created_at, tz), eyebrow: KIND_LABEL[rec.kind], title: String(rec.data?.title ?? KIND_LABEL[rec.kind]), stamp: freshnessStamp(stampLabel, [rec.created_at], { now: d.now(), tz }), body })}`
    + `<footer class="foot"><p>Expires ${esc(new Date(rec.expires_at).toISOString().slice(0, 16).replace("T", " "))} UTC. <a href="?format=text">Plain text version</a></p><form method="post"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="remove"><button type="submit" class="lnk">Remove this file</button></form></footer></div>`;
  let csp = (await headers("text/html", d.env))["content-security-policy"].replace("script-src ", `script-src ${await kindScriptHash} `);
  // A confirmation screenshot is shown inline only from the project's own storage origin; img-src then allows exactly that origin.
  if (shots) csp = csp.replace(/img-src ([^;]+)/, (_m, v: string) => `img-src ${v === "'none'" ? shots : `${v} ${shots}`}`);
  return o.html(layout(`${String(rec.data?.title ?? KIND_LABEL[rec.kind])} - Trainee`, inner, { script: KIND_SCRIPT, tg: true, css: KIND_CSS, og: { title: `${KIND_LABEL[rec.kind]} from Trainee`, description: "Open in Trainee.", image: ogImage(d.env) } }), 200, { "content-security-policy": csp });
}
async function logoOf(want: string, claims: FileClaims, d: FileDeps): Promise<Response> {
  const none = () => new Response("", { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  const dom = want.trim().toLowerCase();
  if (!selfLogos(d.env) || !validDomain(dom)) return none();
  const refs = ((await d.store.recallList(claims.u, claims.r).catch(() => null)) ?? []).slice(0, MAX_ROWS);
  const jobs = (await Promise.all(refs.map((r) => d.store.recall(claims.u, r).catch(() => null)))).filter(Boolean).map((c) => c!.job);
  const posts = jobs.length ? await d.store.postings(jobs.map((j) => j.job_id)).catch(() => [] as PostingRow[]) : [];
  const allowed = jobs.some((j) => logoDomain({ ...j, company_domain: j.company_domain ?? posts.find((p) => p.job_id === j.job_id)?.company_domain ?? null }, d.env) === dom);
  if (!allowed) return none();
  const logo = await fetchLogo(dom, { fetch: d.logoFetch ?? fetch, cache: d.logoCache ?? LOGOS, now: d.now() }).catch(() => null);
  if (!logo) return none();
  return new Response(logo.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": logo.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" } });
}
const originOf = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" ? x.origin : null; } catch { return null; } };
// The one origin a File may show evidence images from: the project's own storage (SUPABASE_URL), https only. Anything else is a link.
const evidenceOrigin = (env: { get(k: string): string | undefined }) => originOf((env.get("SUPABASE_URL") || "").trim());
export { FILE_TTL_MS, hostOf };

// ---------------------------------------------------------------- a results list: one black Apply per card
const PAY_FILTERS = new Set<PayFilter>(["any", "meets", "listed"]);
const placeOf = (j: JobView) => {
  const parts = [j.location, j.remote === "remote" ? "Remote" : j.remote === "hybrid" ? "Hybrid" : j.remote === "onsite" ? "On-site" : ""].filter(Boolean);
  return parts.filter((w, i) => parts.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i).join(" · ");
};
const CHANGED = "Changed since you opened this page, so nothing was sent.";
const SENT = "Approved. It's queued to be sent exactly as its card showed; the status here changes when the employer's site confirms it.";
// How a question is asked: the employer's options, yes or no, a longer answer, or text. A secret (password, code, ID or bank number)
// is never asked: the person does it on the employer's site.
const kindOf = (q: OpenQuestion): ThingQuestion["kind"] => {
  if (NEVER_BY_TEXT.test(q.label)) return "secret";
  if (q.options.length) return "choice";
  const type = decodeRowQuestionType(q.type)?.type ?? q.type;
  if (/checkbox|boolean/.test(type) || q.kind === "consent" || (q.key.startsWith("fact:") && factType(q.key.slice(5)) === "yesno")) return "yesno";
  return q.kind === "essay" ? "long" : "text";
};
const qsFor = (all: OpenQuestion[] | null, r: Row) => (all ?? []).filter((q) => q.job_ids.includes(r.job.job_id));

async function handleResults(o: { meta: ListMeta; d: FileDeps; claims: FileClaims; token: string; action: string; fields: URLSearchParams; url: URL; req: Request;
  html: (b: string, s?: number, e?: Record<string, string>) => Promise<Response>; text: (b: string, s?: number) => Promise<Response>; state: (t: string, p: string[], s: number) => Promise<Response> }): Promise<Response> {
  const { d, claims, token, action, fields } = o, u = claims.u;
  let meta = o.meta;
  const floor = meta.floor ? { amount: meta.floor.amount, period: meta.floor.period } : null;
  const notes: Record<string, string> = {};
  let top: string | undefined;
  // The one checked-at line under each page's title: when the postings shown were last seen live on their boards (career_postings
  // .last_seen_at), in the person's zone; none known (or unreadable): "Check time unknown", never an invented time.
  const tzOf = async () => d.timeZone ? await d.timeZone(u).catch(() => null) : null;
  const stampOf = async (rows: Row[]) => {
    const ids = rows.map((r) => r.job.job_id);
    const seen = ids.length ? await d.store.postings(ids).catch(() => [] as PostingRow[]) : [];
    return freshnessStamp("Postings checked", seen.filter((p) => ids.includes(p.job_id)).map((p) => p.last_seen_at), { now: d.now(), tz: await tzOf() });
  };
  const readQs = async () => d.questions ? await d.questions.open(u, 500).catch(() => null) : null;
  const thingsPage = async (row: Row, qs: OpenQuestion[], o2: { errs?: Record<string, string>; vals?: Record<string, string>; note?: string } = {}) =>
    o.html(renderThings({ token, ref: row.ref, title: row.job.title, company: row.job.company, link: webUrl(row.job.url), stamp: await stampOf([row]), note: o2.note,
      questions: qs.map((q) => ({ id: q.id, label: q.label, options: q.options, kind: kindOf(q), value: o2.vals?.[q.id], error: o2.errs?.[q.id] })) }));
  // One row, judged now against the page as it is (the same screen the list ran): the row to approve, the questions it still needs
  // answered, or why nothing goes for it. An unprepared row with no questions is queued to be prepared (nothing is sent by that).
  type Gate = { row: Row } | { note: string } | { things: Row; qs: OpenQuestion[] };
  const gate = async (feed: Feed | null, ref: string, tag: string, all: OpenQuestion[] | null): Promise<Gate> => {
    const row = feed?.rows.find((r) => r.ref === ref);
    if (!row) return { note: "This job isn't on this list any more. Nothing was sent." };
    const asking = !row.byHand && !row.blocked && !row.tag && (!row.status || row.status.word === "preparing") ? qsFor(all, row) : [];
    if (row.status && !asking.length) {
      // A second tap on a role that is already sent shows the current state and the evidence the row holds, never a bare refusal (PRD 8.8).
      const sp = specOf(row);
      const proof = sp.sent ? ` Already submitted for this role. ${sp.evidence ? `Evidence: ${sp.evidence}.` : "No confirmation is on file yet, so it is still being checked."}` : "";
      return { note: row.inApps ? `Already in your applications, so nothing more was sent.${proof} ${row.status.detail}` : `Nothing was approved: ${row.status.detail}` };
    }
    if (row.byHand) return { note: "Not applied for automatically on this site. Open it and apply there yourself." };
    if (row.blocked) return { note: `Nothing was approved: ${row.blocked}` };
    if (!row.tag) {
      if (tag !== "none") return { note: CHANGED };
      if (asking.length) return { things: row, qs: asking };
      // No confirmed resume: ask for exactly that (as the chat does) instead of queueing a preparation that cannot start.
      if (d.resumeOnFile && (await d.resumeOnFile(u).catch(() => null)) === false) return { note: `Not queued: ${NO_RESUME_REASON}. ${NO_RESUME_NEXT} Nothing was sent.` };
      const w = await d.store.want(u, row.job, d.now()).catch(() => ({ result: "refused" as const, reason: "I couldn't save that just now." }));
      if (w.result === "refused") return { note: `Not queued: ${w.reason ?? "I can't open that posting's application form yet."}` };
      // The tap IS the person's ask to get this one ready: start preparing now (the queue holds only what they asked for). Preparing
      // sends nothing; the Apply that sends comes after they see "What will be sent".
      const k = d.reprepare ? await d.reprepare(u).catch(() => "failed" as const) : "off";
      return { note: k === "failed" ? "Saved, but getting it ready didn't start. Tap Apply again in a minute. Nothing was sent." : "Getting your application ready. Nothing is sent until you check it here and tap Apply. Refresh in a minute." };
    }
    if (!/^[0-9a-f]{16}$/.test(tag) || tag !== row.tag) return { note: CHANGED };
    return { row };
  };
  const picks = () => [...new Set(fields.getAll("pick"))].slice(0, MAX_ROWS).map((p) => { const [ref = "", tag = ""] = p.split(":"); return { ref, tag }; });

  // A GET only shows: the questions of one role, drawn for the person to fill in. It saves and sends nothing.
  const thingsRef = o.req.method === "GET" ? o.url.searchParams.get("things") : null;
  if (thingsRef) {
    const feed = await loadFeed(claims, token, d), all = await readQs(), row = feed?.rows.find((r) => r.ref === thingsRef);
    const qs = row ? qsFor(all, row) : [];
    if (row && qs.length && !row.byHand && !row.blocked && !row.tag) return thingsPage(row, qs);
    top = "Nothing is waiting on you for that role. Nothing was sent.";
  }

  if (action) {
    if (!["apply", "applysel", "answer", "refresh", "dismiss", "restore", "pause", "resume"].includes(action)) return o.state("Not done", ["That is not something this page can do. Nothing was sent."], 400);
    // Re-read the stored meta right before writing and change only this field, so two taps cannot overwrite each other.
    const saveMeta = async (patch: (m: ListMeta) => void) => {
      try {
        const fresh = (await d.store.recallListMeta?.(u, claims.r).catch(() => null)) ?? meta;
        patch(fresh); await d.store.rememberListMeta?.(u, claims.r, fresh); meta = fresh; return true;
      } catch { return false; }
    };
    const paused = !!meta.paused, marked = new Set(meta.dismissed ?? []);
    if (action === "refresh") { /* a fresh read below */ }
    else if (action === "pause" || action === "resume") {
      // Pause remaining (PRD 5, 7.10): this page only. It stops this page from approving or starting anything new; it cancels nothing
      // already approved or in progress, and says so.
      if (!(await saveMeta((m) => { m.paused = action === "pause" ? { at: d.now() } : null; }))) { top = "I couldn't save that just now. Nothing changed and nothing was sent."; }
      else top = action === "pause" ? "Paused on this page. It will not approve or start anything new. Telegram buttons still work. Applications already approved or in progress are not cancelled and may still finish. Nothing else will start from here." : "Resumed. Nothing was sent by resuming; each Apply still needs your tap.";
    } else if (action === "dismiss" || action === "restore") {
      const ref = fields.get("ref") ?? "";
      const on = (await d.store.recallList(u, claims.r).catch(() => null)) ?? [];
      const rowNow = action === "dismiss" ? await loadFeed(claims, token, d) : null;
      if (!on.includes(ref)) top = "That role isn't on this list. Nothing changed.";
      else {
        const sp = action === "dismiss" ? (() => { const r0 = rowNow?.rows.find((x) => x.ref === ref); return r0 ? specOf(r0) : null; })() : null;
        if (sp && (sp.sent || sp.bucket === "progress" || sp.bucket === "done")) notes[ref] = "Not dismissed: this application is already approved, started or submitted, so it stays on your list. Nothing was changed.";
        else if (!(await saveMeta((m) => { const s2 = new Set(m.dismissed ?? []); if (action === "dismiss") s2.add(ref); else s2.delete(ref); m.dismissed = [...s2]; }))) top = "I couldn't save that just now. Nothing changed.";
        else notes[ref] = action === "dismiss" ? "Dismissed. Private to you; no application was touched. You can restore it at the bottom of the page." : "Restored to your list. No application was touched.";
      }
    } else if ((action === "apply" || action === "applysel") && paused) {
      top = "Paused. Nothing was approved or started from this tap. Tap Resume at the top to continue.";
    } else if (action === "apply" && marked.has(fields.get("ref") ?? "")) {
      notes[fields.get("ref") ?? ""] = "This role is dismissed. Restore it first. Nothing was sent.";
    } else if (action === "apply") {
      const ref = fields.get("ref") ?? "", tag = fields.get("tag") ?? "";
      const g = await gate(await loadFeed(claims, token, d), ref, tag, await readQs());
      if ("things" in g) return thingsPage(g.things, g.qs);
      if ("note" in g) notes[ref] = g.note;
      else notes[ref] = (await approveOne(u, ref, tag, d)) ?? SENT;
    } else if (action === "applysel") {
      const want = picks().filter((p) => !marked.has(p.ref));
      if (!want.length) top = picks().length ? "Those roles are dismissed. Restore them first. Nothing was sent." : "Tick at least one role first. Nothing was sent.";
      else {
        // Every ticked role is judged against the page as it is now; the ones that are ready go together, each bound to the exact
        // payload tag its card showed. A role that isn't ready, or changed since, is skipped and says why.
        const feed = await loadFeed(claims, token, d), all = await readQs();
        const ready: Row[] = [];
        let asked = 0;
        for (const p of want) {
          const g = await gate(feed, p.ref, p.tag, all);
          if ("things" in g) { notes[p.ref] = "Needs a few answers first, so nothing was sent for it. Use Answer them now on its card."; asked++; }
          else if ("note" in g) notes[p.ref] = g.note;
          else ready.push(g.row);
        }
        let sent = 0;
        for (const r of ready) { const n = await approveOne(u, r.ref, r.tag!, d); notes[r.ref] = n ?? SENT; if (!n) sent++; }
        const skipped = want.length - sent - asked;
        top = `${sent} of ${want.length} approved and queued, each exactly as its card showed.${asked ? ` ${asked} ${asked === 1 ? "needs" : "need"} a few answers first.` : ""}${skipped ? ` ${skipped} not approved; each says why.` : ""} Nothing else was sent.`;
      }
    } else {
      // "A few things first": each answer is checked and saved the way the chat saves it; never guessed, defaulted or invented.
      const ref = fields.get("ref") ?? "";
      const feed = await loadFeed(claims, token, d), row = feed?.rows.find((r) => r.ref === ref), all = await readQs();
      if (!row) top = "This job isn't on this list any more. Nothing was saved or sent.";
      else if (!d.questions || !all) top = "I can't save answers from this page just now. Nothing was saved and nothing was sent.";
      else {
        const qs = qsFor(all, row), errs: Record<string, string> = {}, vals: Record<string, string> = {};
        let saved = 0;
        for (const q of qs) {
          if (kindOf(q) === "secret") { errs[q.id] = "Trainee never collects this. Type it yourself on the employer's site."; continue; }
          const raw = (fields.get(`q_${q.id}`) ?? "").trim();
          // A password, a code or an ID/card number typed here is refused and not drawn back into the page (the chat never echoes one either).
          vals[q.id] = redactIdentity(raw).removed.length ? "" : raw;
          const c = checkAnswer(q, raw);
          if (!c.ok) { errs[q.id] = c.skip ? "needs an answer here (to leave it for later, go back to the list)" : c.why === "had no answer" ? "needs an answer" : c.why; continue; }
          try { await d.questions.answer(u, q.id, c.value); saved++; } catch { errs[q.id] = "couldn't be saved just now; nothing was lost, try again"; }
        }
        const still = qs.filter((q) => errs[q.id]);
        if (!qs.length) notes[ref] = "Nothing is waiting on you for this role now. Refresh to see where it stands.";
        else if (still.length) return thingsPage(row, still, { errs, vals, note: saved ? `Saved ${saved} ${saved === 1 ? "answer" : "answers"}. These still need you; nothing was sent.` : "Nothing was saved yet, and nothing was sent." });
        else {
          // Every question for this role is answered: it goes back in the queue and is prepared again with the answers. A fresh
          // card, with every exact answer, comes back here; nothing is sent until its Apply is tapped.
          if (paused) notes[ref] = "Saved. This page is paused, so nothing was queued or prepared. Resume to continue; nothing was sent.";
          else {
          const w = await d.store.want(u, row.job, d.now()).catch(() => ({ result: "refused" as const, reason: "I couldn't queue it just now." }));
          const r = d.reprepare ? await d.reprepare(u).catch(() => "failed" as const) : "off";
          notes[ref] = w.result === "refused" ? `Saved. It wasn't queued to prepare: ${w.reason ?? "I can't open that posting's form yet."} Nothing was sent.`
            : r === "started" ? "Saved. Getting your application ready with your answers. Refresh in a minute to see exactly what will be sent; nothing is sent until you tap Apply."
            : "Saved. Preparing it again hasn't started yet; it waits in your queue. Refresh in a minute. Nothing is sent until you tap Apply.";
          }
        }
      }
    }
  }

  const feed = await loadFeed(claims, token, d, notes);
  if (!feed) return o.state("This list is gone", ["It is no longer available. " + NEW_LINK], 404);
  if (o.req.method === "GET" && o.url.searchParams.get("format") === "text") return o.text(renderText(feed));
  const pf = o.url.searchParams.get("pay") as PayFilter, filters = { pay: PAY_FILTERS.has(pf) ? pf : "any" as PayFilter, where: (o.url.searchParams.get("where") ?? "").trim().slice(0, 80) };
  const openNow = await readQs(), pend = d.pending ? await d.pending(u).catch(() => null) : null;
  // Stable ids over the WHOLE list (not the filter, not the sort, not what is dismissed).
  const rawRefs = (await d.store.recallList(u, claims.r).catch(() => null)) ?? feed.rows.map((r) => r.ref);
  const ids = roleIds(rawRefs);
  const seenAt = new Map((await d.store.postings(feed.rows.map((r) => r.job.job_id)).catch(() => [] as PostingRow[])).map((p) => [p.job_id, p.last_seen_at]));
  const checkedOf = (id: string) => freshnessStamp("Checked", [seenAt.get(id)], { now: d.now(), tz: ztz });
  const ztz = await tzOf();
  const all: ResultRow[] = feed.rows.map((r0) => {
    // The numbers stored with the role when the list was made; the display text is never read back (it is not the posting's words).
    const asking = !r0.byHand && !r0.blocked && !r0.tag && (!r0.status || r0.status.word === "preparing") ? qsFor(openNow, r0).length : 0;
    const r: Row = asking ? { ...r0, status: null } : r0;
    const where = pend?.find((p) => p.url === r.job.url || p.posting_key === r.job.job_id);
    const guide = asking ? `${asking} ${asking === 1 ? "question needs" : "questions need"} your answer first.`
      : r.status?.word === "preparing" ? (where ? pendingLine(where) : null)
      : !r.status && !r.byHand && !r.blocked && !r.tag ? "Not prepared yet. Tap Apply and I'll start getting it ready; nothing is sent." : null;
    const pay = (r.job.pay_parsed ?? null) as Pay | null, g = payGroup(pay, floor);
    const other = g === "unchecked" && pay ? (pay.currency !== "USD" ? `in ${pay.currency === "unknown" ? "a currency it doesn't name" : pay.currency}` : "no period stated") : null;
    const payNote = other && floor ? `${other}, not compared with your ${floorText(floor)}` : other ?? (g === "meets" && startsBelow(pay, floor) && floor ? `the range starts below ${floorText(floor)}` : null);
    return { ...r, payShown: pay ? payText(pay) : null, payGroup: g, payNote, payConv: conversionNote(pay, floor), place: placeOf(r.job), guide, openQs: asking,
      rid: ids.get(r.ref), reqId: reqIdOf(r.full), checked: checkedOf(r.job.job_id) };
  });
  const dismissedSet = new Set(meta.dismissed ?? []);
  const gone = all.filter((r) => dismissedSet.has(r.ref));
  const keep = all.filter((r) => !dismissedSet.has(r.ref));
  const zoneNow = ztz && (() => { try { new Intl.DateTimeFormat("en-US", { timeZone: ztz }); return true; } catch { return false; } })() ? ztz : "America/Chicago";
  const updated = new Intl.DateTimeFormat("en-US", { timeZone: zoneNow, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(d.now()));
  // The plain-text export (PRD 4.9): ?export=txt, behind the same session and list check as the page (it is drawn only from the
  // feed loaded above), a GET that changes nothing. Real links only; never a made-up address.
  if (o.req.method === "GET" && o.url.searchParams.get("export") === "txt") {
    const roles = [...all].sort((a, b) => (a.rid ?? "") < (b.rid ?? "") ? -1 : 1).map((r) => ({ id: r.rid ?? "R-??", employer: r.job.company, title: r.job.title, reqId: r.reqId ?? null, place: r.place,
      pay: r.payShown ? `${r.payShown} (as the posting lists it)` : "Pay not listed", source: r.job.source ?? "", url: r.job.url ?? null, checked: r.checked ?? null, spec: specOf(r), byHand: r.byHand, dismissed: dismissedSet.has(r.ref) }));
    const act = keep;
    return o.text(renderExport({ title: `${meta.what}${floor ? `, ${floorText(floor)} or more` : ""}`, updated, counts: countsOf(act), coverageLine: coverage(all), paused: !!meta.paused, roles }));
  }
  const rows = keep.filter((r) => (filters.pay === "meets" ? r.payGroup === "meets" : filters.pay === "listed" ? !!r.payShown : true)
    && (!filters.where ? true : filters.where === "remote" ? r.job.remote === "remote" || /\bremote\b/i.test(r.job.location) : r.job.location.toLowerCase().includes(filters.where.toLowerCase())));
  const places = [...new Set(all.map((r) => r.job.location.split(/[;|]/)[0].trim()).filter((p) => p && !/^remote$/i.test(p)))].slice(0, 8);
  const title = `${meta.what}${floor ? `, ${floorText(floor)} or more` : ""}`;
  // The file's header (Instinct-style, owner 2026-11-01): who it was made for and when, exactly what was read and when, what is not
  // confirmed, and a quick read. Every number here is counted from the rows; the person's day and zone (else Chicago, said).
  const tz = await tzOf();
  const zone = tz && (() => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } })() ? tz : "America/Chicago";
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: zone, ...o }).format(new Date(ms));
  const day = fmt(meta.at, { month: "short", day: "numeric", year: "numeric" });
  const nSources = meta.sources ?? new Set(all.map((r) => r.job.source).filter(Boolean)).size;
  const srcWord = `${nSources} ${nSources === 1 ? "source" : "sources"}`;
  // Where the postings came from (the checked-at time itself is the stamp line, from the postings' own last_seen_at).
  const fromWhere = meta.source === "snapshot"
    ? `From a saved snapshot of job boards${meta.read ? ` read ${fmt(Date.parse(meta.read), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}, not the live board, so some may have closed; ${srcWord}.`
    : `From ${srcWord} on the live board.`;
  const nMeets = keep.filter((r) => r.payGroup === "meets").length, nUnlisted = keep.filter((r) => r.payGroup === "unlisted").length;
  const nOther = keep.filter((r) => r.payGroup === "unchecked").length, nBelow = keep.filter((r) => r.payGroup === "below").length;
  const fl = floor ? floorText(floor) : null;
  const caveat = [
    fromWhere,
    `Pay is shown only where the posting lists it${nUnlisted ? `; ${nUnlisted} ${nUnlisted === 1 ? "role doesn't" : "roles don't"} list pay, so ${nUnlisted === 1 ? "it's" : "they're"} grouped separately` : ", and nothing is estimated"}.`,
    nOther ? `${nOther} ${nOther === 1 ? "lists" : "list"} pay in another currency or without a period, so ${nOther === 1 ? "it wasn't" : "they weren't"} compared${fl ? ` with ${fl}` : ""}.` : "",
    "Fit is judged only on what you've confirmed.",
  ].filter(Boolean).join(" ");
  const best = keep.filter((r) => r.payGroup === "meets").slice(0, 2).map((r) => `${r.job.title} at ${r.job.company}`);
  const quick = [
    best.length ? `Best ${best.length === 1 ? "match" : "matches"}: ${best.join("; ")}.` : keep.length ? `Closest by fit: ${keep[0].job.title} at ${keep[0].job.company}.` : "",
    fl ? `${nMeets} of ${keep.length} list ${fl} or more${nUnlisted ? `; ${nUnlisted} ${nUnlisted === 1 ? "doesn't" : "don't"} list pay` : ""}${nOther ? `; ${nOther} can't be compared` : ""}${nBelow ? `; ${nBelow} now list less` : ""}.` : `${keep.length} ${keep.length === 1 ? "role" : "roles"}, sorted by fit.`,
    `Next: tap Apply on a role. A ready one is sent exactly as its What will be sent shows; one that isn't ready asks for what it needs first. ${coverage(all) === NOTHING_SENT ? "Nothing is sent until you tap Apply." : "Each new send needs your tap on Apply."}`,
  ].filter(Boolean);
  return o.html(renderResults({ token, title, floor: fl, rows, coverRows: all, countRows: keep, total: all.length, filters, places, top, notes,
    madeFor: `Made for ${meta.name ?? "you"} · ${day}`, stamp: await stampOf(rows), caveat, quick,
    paused: !!meta.paused, updated, dismissed: gone }));
}
