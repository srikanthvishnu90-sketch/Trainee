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
import { checkSession, CLEAR_LOGIN, CLEAR_SESSION, codeOf, LOGIN_TTL_MS, loginCookie, MAX_CODE_SENDS, MAX_CODE_TRIES, normalizePhone, SESSION_ID, sessionCookie, startSession, type PhoneAuth, type SessionStore } from "../_shared/file_session.ts";
import { verifyInitData } from "../_shared/telegram_webapp.ts";
import { BOOT_SCRIPT, cut, FEED_SCRIPT, fullOf, hostOf, renderBootstrap, renderFeed, renderLinkState, renderPhoneLogin, renderPreview, renderText, signOutFoot, snippetOf, statusOf, type AppRow, type Feed, type Row } from "../_shared/file_page.ts";
import { dayOf, BRAND, esc, layout, postedLine } from "../_shared/file_page.ts";
import { actOn, bodyHtml, COPY_SCRIPT, KIND_CSS, KIND_LABEL, textOf, type Effects, type FileRecord } from "../_shared/file_kinds.ts";
import type { FileService } from "../_shared/file_service.ts";
import { byHandUrl, FEED_ROWS, foreignFact, hashTag, isSecretField, NOT_YOURS, logoDomain, logoUrl, postingVerdict, secretFields, secretKey, tapJob, unsendable, type JobDeps, type JobSender, type JobStore, type JobView, type PostingRow, type PreparedRow } from "../_shared/telegram_jobs.ts";

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
  timeZone?: (userId: string) => Promise<string | null>; // the person's own zone (dates on the page are their day); absent or unknown, Chicago, said
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
function logoOrigins(env: { get(k: string): string | undefined }): string {
  const tpl = (env.get("TRAINEE_LOGO_URL") || "").trim() || "https://www.google.com/s2/favicons?sz=128&domain={domain}";
  let origin = "";
  try { const u = new URL(tpl.split("{domain}").join("example.com")); if (u.protocol === "https:") origin = u.origin; } catch { /* no logo provider */ }
  return [origin, origin.includes("google.com") ? "https://*.gstatic.com" : ""].filter(Boolean).join(" ");
}
async function headers(type: string, env: { get(k: string): string | undefined }): Promise<Record<string, string>> {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "content-type": type,
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
  const dom = logoDomain(job, env), u = logoUrl(job, env);
  if (!dom || !u) return null;
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
  return { token, rows, setHash, setSize: set.length, top, og, total: all.length };
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
    return new Response(renderLinkState("Couldn't open this just now", ["Nothing was opened and nothing was sent. Try again in a minute."]), { status: 503, headers: await headers("text/html; charset=utf-8", d.env) });
  }
}

async function handleFileOnce(req: Request, d: FileDeps): Promise<Response> {
  const html = async (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...(await headers("text/html; charset=utf-8", d.env)), ...extra } });
  const text = async (body: string, status = 200) => new Response(body, { status, headers: await headers("text/plain; charset=utf-8", d.env) });
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return html(renderLinkState("Not supported", ["This page only opens and answers."]), 405);
  const url = new URL(req.url);
  // Every redirect goes to this page's own path on this host: a path that starts with two slashes (or a backslash a browser reads as
  // one) would be a link to another host (file journey round 2: "//evil.example/?t=..." redirected there after the sign-in).
  const here = `/${url.pathname.replace(/^[\/\\]+/, "")}`;
  let fields: URLSearchParams = url.searchParams;
  if (req.method === "POST") { try { fields = new URLSearchParams(await req.text()); } catch { fields = new URLSearchParams(); } }
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
  const tapped = action === "apply" || action === "applyall" ? ["Nothing was approved or sent from this tap."] : [];
  const signedOut = (why: string) => why === "error" ? state("Couldn't open this just now", ["Nothing was sent. Try again in a minute."], 503)
    : why === "expired" ? state("You were signed out", [...tapped, "Sign-ins last two hours. " + NEW_LINK], 401)
    : why === "revoked" || why === "unbound" ? state("You were signed out", [...tapped, "This sign-in was ended. " + NEW_LINK], 401)
    : state("This link isn't valid", [...tapped, "It may be cut short or changed. " + NEW_LINK], 403);
  const given = req.method === "GET" || req.method === "HEAD" ? (url.searchParams.get("t") ?? "") : "";

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
    const cur = await check(cookieOf(req, "tf_s"));
    if (cur.ok && cur.userId !== c.claims.u) {
      return html(layout("A different account - Trainee", `<header>${BRAND}<h1>This link is for a different Trainee account</h1></header><main id="main"><p>You are signed in as someone else here, so nothing from this link was opened. Sign out first, then open the link again.</p>${signOutFoot(cookieOf(req, "tf_s"))}</main>`), 403);
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
  if (action === "phone_start" || action === "phone_verify" || action === "phone_reset") return phoneStep(action);
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
          const sent = await d.phone.send(phone).catch(() => ({ ok: false as const, why: "refused" as const }));
          if (!sent.ok) console.error(`trainee-file: the sign-in code was not texted (${sent.why})`);
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

  let token = "";
  let checked: Awaited<ReturnType<typeof check>> | null = null;
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
  } else if (req.method === "POST") {
    token = fields.get("t") ?? ""; // an action: the session's own value in the form (a cookie alone approves nothing)
  } else {
    const list = url.searchParams.get("list") ?? "";
    if (/^[0-9a-f]{10}$/.test(list)) return html(renderBootstrap(list)); // the Mini App page: reads Telegram's signed data and posts it back
    token = cookieOf(req, "tf_s");
    // A link opened on this browser that is waiting for the phone sign-in.
    const pending = async (): Promise<Response | null> => {
      const lt = await verifyFileToken(cookieOf(req, "tf_l"), secret, d.now());
      if (!lt.ok || lt.claims.k !== "l") return null;
      const row = await sessions.login(lt.claims.j).catch(() => null);
      if (row && !row.done_at && row.user_id === lt.claims.u && d.now() < Date.parse(row.expires_at)) return row.tries >= MAX_CODE_TRIES ? locked() : html(renderPhoneLogin({ step: row.phone ? "code" : "phone", botUrl: bot }));
      return null;
    };
    if (!SESSION_ID.test(token)) return (await pending()) ?? state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);
    // An ended session's cookie (signed out elsewhere, expired, phone changed) must not hide the sign-in a NEW link opened:
    // the browser keeps tf_s until its Max-Age, and every read would say "signed out, open a new link" in a loop
    // (scenarios-file-signin.test.ts). The pending sign-in wins and the dead cookie is cleared.
    checked = await check(token);
    if (!checked.ok && checked.why !== "error") {
      const p = await pending();
      if (p) { p.headers.append("set-cookie", CLEAR_SESSION); return p; }
    }
  }

  // ---- every private read and action: the session again, checked against the account right now
  const s = checked ?? await check(token);
  if (!s.ok) return signedOut(s.why);
  if (action === "signout" || action === "signout_all") {
    const ok = await (action === "signout" ? sessions.revoke(s.idHash, d.now()) : sessions.revokeAll(s.userId, d.now())).then(() => true, () => false);
    if (!ok) return state("Couldn't sign out just now", ["You are still signed in. Try again in a minute."], 503);
    return new Response(renderLinkState("Signed out", [action === "signout" ? "You are signed out on this device." : "You are signed out everywhere this page was open.", "Open a new link from Trainee to sign in again."], bot), { status: 200, headers: [...Object.entries(await headers("text/html; charset=utf-8", d.env)), ["set-cookie", CLEAR_SESSION]] });
  }
  const claims = { u: s.userId, r: s.list, k: "s", j: "0".repeat(16), i: 0, e: Date.parse(s.row.expires_at) } as FileClaims;
  const { u } = claims;
  if (d.files) {
    const g = await d.files.get(u, claims.r).catch(() => null);
    if (g && g.state !== "missing") return handleKind({ g, d, claims, token, action, fields, req, html, text, state });
  }
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
  const title = esc(String(rec.data?.title ?? KIND_LABEL[rec.kind]));
  const inner = `<div id="root"><header>${BRAND}<p class="eyebrow">${esc(KIND_LABEL[rec.kind])}</p><h1>${title}</h1></header><main id="main">${note ? `<p class="note-top" role="status">${esc(note)}</p>` : ""}${bodyHtml(rec, token)}</main>`
    + `<footer class="foot"><p>Expires ${esc(new Date(rec.expires_at).toISOString().slice(0, 16).replace("T", " "))} UTC. <a href="?format=text">Plain text version</a></p><form method="post"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="remove"><button type="submit" class="lnk">Remove this file</button></form></footer></div>`;
  const csp = (await headers("text/html", d.env))["content-security-policy"].replace("script-src ", `script-src ${await kindScriptHash} `);
  return o.html(layout(`${String(rec.data?.title ?? KIND_LABEL[rec.kind])} - Trainee`, inner, { script: KIND_SCRIPT, tg: true, css: KIND_CSS, og: { title: `${KIND_LABEL[rec.kind]} from Trainee`, description: "Open in Trainee.", image: ogImage(d.env) } }), 200, { "content-security-policy": csp });
}
export { FILE_TTL_MS, hostOf };
