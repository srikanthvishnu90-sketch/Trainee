// PEOPLE FINDING (D-033): the person's own Gmail, read with the career grant's gmail.readonly (career_mail_gmail.ts
// careerTokenFor; the token reader is reused, never changed). Two reads, each on the person's ask:
//
//   correspondents  people at a company the person has written to or heard from. Headers only (format=metadata: From,
//                   To, Cc, Date), never a body. An address counts only when its own domain is the company's name
//                   ("ramp.com" for Ramp), and a role inbox (careers@, noreply@) is never a person. A name is the display
//                   name the mail itself carried, or none: never made from the address.
//   job alerts      postings in the person's own Handshake and Indeed alert emails. Only mail from the senders those sites
//                   publish (career_people_sites.ts JOB_ALERT_SENDERS, data only, with its sources), and only when
//                   Gmail's own authentication result passes for that domain (career_mail.ts authenticated). The body is
//                   read (format=full) for these senders alone, held in memory for the run, and only each posting's
//                   title, the words beside it and its link are kept. A link is kept exactly as the email carried it and
//                   only when it points at the same site; nothing is opened on either site.
//                   Neither site documents its alert format: a posting is an anchor whose link is a job link on that
//                   site; anything else in the mail is left alone.
import { authenticated } from "./career_mail.ts";
import { JOB_ALERT_SENDERS, type JobSite } from "./career_people_sites.ts";
import { isRoleAddress, ROLE_LOCALS } from "./career_contacts.ts";
import { cleanCell, cleanEmail, companyKey, readsAsInstruction } from "./career_people_import.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export type Token = (userId: string) => Promise<string | null>;
export interface GmailRead { fetch: typeof fetch; token: Token }
export type Read<T> = { status: "ok"; items: T[]; read: number } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };

const SECOND_LEVEL = new Set(["co", "com", "ac", "org", "net", "gov", "edu"]);
// The registrable domain: "mail.ramp.com" is "ramp.com", "bank.co.uk" is "bank.co.uk".
export function registrable(domain: string): { full: string; label: string } {
  const parts = String(domain ?? "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length < 2) return { full: parts.join("."), label: parts[0] ?? "" };
  const two = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]);
  const take = two ? 3 : 2;
  const full = parts.slice(-take).join(".");
  return { full, label: parts[parts.length - take] };
}
// A company's name as a domain label: "Ramp" ramp, "Jane Street" janestreet, "Stripe, Inc." stripe.
export const domainLabelOf = (company: string) => companyKey(company).replace(/[^a-z0-9]/g, "");
const FREEMAIL = new Set(["gmail", "googlemail", "yahoo", "outlook", "hotmail", "live", "icloud", "me", "aol", "proton", "protonmail", "gmx", "mail", "yandex", "zoho"]);

// "Maya Chen" <maya@ramp.com>, Lee <lee@ramp.com>, plain@x.com  (quoted commas kept inside the name)
export function addresses(header: string): { name: string | null; email: string }[] {
  const out: { name: string | null; email: string }[] = [];
  const parts: string[] = [];
  let cur = "", q = false, angle = 0;
  for (const ch of String(header ?? "")) {
    if (ch === '"') q = !q;
    if (!q && ch === "<") angle++;
    if (!q && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !q && !angle) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(p) ?? /^\s*()([^\s<>]+@[^\s<>]+)\s*$/.exec(p);
    if (!m) continue;
    const email = cleanEmail(m[2]);
    if (!email) continue;
    const n = cleanCell(m[1] ?? "", 200).replace(/^'+|'+$/g, "");
    // A display name is whatever the sender typed: one that reads as an instruction is no name at all.
    out.push({ name: n && !n.includes("@") && /\p{L}/u.test(n) && !readsAsInstruction(n) ? n : null, email });
  }
  return out;
}

async function getJson(d: GmailRead, url: string, token: string): Promise<{ ok: true; body: any } | { ok: false; status: number; retryAfterMs?: number; slow?: boolean }> {
  const r = await d.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.ok) return { ok: true, body: await r.json().catch(() => ({})) };
  // Gmail refusing because of its own rate limits (429, or 403 with a rate-limit reason): the caller backs off and resumes.
  const text = await r.text().catch(() => "");
  const slow = r.status === 429 || (r.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(text));
  const ra = Number(r.headers.get("retry-after"));
  return { ok: false, status: r.status, slow, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 };
}
const header = (msg: any, name: string) => (msg?.payload?.headers ?? []).filter((h: any) => String(h?.name ?? "").toLowerCase() === name).map((h: any) => String(h?.value ?? ""));

// ------------------------------------------------------------------------------------------------ reading in full
// Gmail is read in full, never truncated: a read is a sequence of STEPS over one query, each resuming from a cursor (the
// list page's token and the position inside it: keyset over Gmail's own order). A step stops at its deadline (a turn's
// wait, a scheduled run's share), or when Gmail asks to slow down (then it says when to resume), and hands back the
// cursor; the caller saves it (career_people_sweep.ts) and the next step continues exactly there.
export interface Cursor { query: string; pageToken: string | null; skip: number }
export type Step<T> =
  | { status: "ok"; items: T[]; read: number; refused: number; next: Cursor | null; newestMs: number | null }
  | { status: "SLOW_DOWN"; items: T[]; read: number; refused: number; next: Cursor; newestMs: number | null; retryAfterMs: number }
  | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };
export const LIST_PAGE = 100; // messages per list call (Gmail's own maximum is 500): a page size, not a limit
const PARALLEL = 10;          // message reads in flight at once: how fast, not how many
type One<T> = { ok: true; items: T[]; refused: boolean; atMs: number } | { ok: false; status: number; slow?: boolean; retryAfterMs?: number } | null;
async function step<T>(d: GmailRead, token: string, cur: Cursor, deadline: number, one: (id: string) => Promise<One<T>>): Promise<Step<T>> {
  const items: T[] = [];
  let read = 0, refused = 0, newestMs: number | null = null, c: Cursor = { ...cur };
  const out = (next: Cursor | null): Step<T> => ({ status: "ok", items, read, refused, next, newestMs });
  for (;;) {
    if (read > 0 && Date.now() >= deadline) return out(c);
    const list = await getJson(d, `${API}/messages?q=${encodeURIComponent(c.query)}&maxResults=${LIST_PAGE}${c.pageToken ? `&pageToken=${encodeURIComponent(c.pageToken)}` : ""}`, token);
    if (!list.ok) return list.slow ? { status: "SLOW_DOWN", items, read, refused, next: c, newestMs, retryAfterMs: list.retryAfterMs ?? 60_000 } : { status: "ERROR", detail: `list messages: HTTP ${list.status}` };
    const ids: string[] = (list.body?.messages ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
    for (let i = c.skip; i < ids.length; i += PARALLEL) {
      if (read > 0 && Date.now() >= deadline) return out({ ...c, skip: i });
      const got = await Promise.all(ids.slice(i, i + PARALLEL).map(one));
      const bad = got.find((g) => g && !g.ok) as Extract<One<T>, { ok: false }> | undefined;
      // A refusal anywhere in the group: none of the group counts, and the cursor stays at the group's start.
      if (bad) return bad.slow ? { status: "SLOW_DOWN", items, read, refused, next: { ...c, skip: i }, newestMs, retryAfterMs: bad.retryAfterMs ?? 60_000 } : { status: "ERROR", detail: `read a message: HTTP ${bad.status}` };
      for (const g of got) {
        if (!g || !g.ok) continue; // gone (404) since the list
        read++; if (g.refused) refused++;
        items.push(...g.items);
        if (g.atMs && (newestMs === null || g.atMs > newestMs)) newestMs = g.atMs;
      }
    }
    const tok = list.body?.nextPageToken ? String(list.body.nextPageToken) : null;
    if (!tok) return out(null);
    c = { query: c.query, pageToken: tok, skip: 0 };
  }
}
// A query for mail after a time (an incremental read after a finished one): Gmail's after: takes seconds; one second of
// overlap, and the rows it would repeat are already kept (dedupe in the database).
const afterPart = (afterMs: number | null | undefined) => (afterMs ? ` after:${Math.max(0, Math.floor(afterMs / 1000) - 1)}` : "");
const msOf = (g: any) => Number(g?.internalDate) || Date.parse(header(g, "date")[0] ?? "") || 0;

// ------------------------------------------------------------------------------------------------ correspondents
export interface Correspondent { name: string | null; email: string; domain: string; last_seen_at: string; message_hash: string }
export const correspondentsQuery = (label: string, afterMs?: number | null) => `{from:${label} to:${label} cc:${label}} -in:chats -in:spam -in:trash${afterPart(afterMs)}`;
export const isCompanyLabel = (label: string) => label.length >= 2 && !FREEMAIL.has(label);
export async function correspondentsStep(d: GmailRead, userId: string, label: string, cur: Cursor, deadline = Number.POSITIVE_INFINITY): Promise<Step<Correspondent>> {
  if (!isCompanyLabel(label)) return { status: "ok", items: [], read: 0, refused: 0, next: null, newestMs: null };
  const token = await d.token(userId).catch(() => null);
  if (!token) return { status: "NOT_WIRED" };
  try {
    const me = await getJson(d, `${API}/profile`, token);
    const mine = me.ok ? cleanEmail(me.body?.emailAddress) : null;
    const r = await step<Correspondent>(d, token, cur, deadline, async (id) => {
      const g = await getJson(d, `${API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&fields=id,internalDate,payload/headers`, token);
      if (!g.ok) return g.status === 404 ? null : g;
      const atMs = msOf(g.body), at = new Date(atMs).toISOString();
      const hash = await sha(`gmail:${userId}:${id}`);
      const items: Correspondent[] = [];
      for (const a of [...header(g.body, "from"), ...header(g.body, "to"), ...header(g.body, "cc")].flatMap(addresses)) {
        const [local, domain] = a.email.split("@");
        if (a.email === mine || registrable(domain).label !== label) continue;
        if (ROLE_LOCALS.has(local) || ROLE_LOCALS.has(local.replace(/[._+-]/g, "")) || isRoleAddress(local) || /^(no-?reply|do-?not-?reply|notifications?|mailer|bounce)/.test(local)) continue;
        items.push({ name: a.name, email: a.email, domain: registrable(domain).full, last_seen_at: at, message_hash: hash });
      }
      return { ok: true, items, refused: false, atMs };
    });
    if (r.status !== "ok" && r.status !== "SLOW_DOWN") return r;
    // one person once in a step: their newest message, and a name if any message carried one
    const by = new Map<string, Correspondent>();
    for (const x of r.items) {
      const y = by.get(x.email);
      if (!y || y.last_seen_at < x.last_seen_at) by.set(x.email, { ...x, name: x.name ?? y?.name ?? null });
      else if (!y.name && x.name) y.name = x.name;
    }
    return { ...r, items: [...by.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at)) };
  } catch (e) {
    return { status: "ERROR", detail: e instanceof Error ? e.message : String(e) };
  }
}
// Every correspondent at the company, all pages, in one call (no deadline): for callers that read in full at once.
export async function correspondentsAt(d: GmailRead, userId: string, company: string): Promise<Read<Correspondent>> {
  const label = domainLabelOf(company);
  if (!isCompanyLabel(label)) return { status: "ok", items: [], read: 0 };
  const r = await correspondentsStep(d, userId, label, { query: correspondentsQuery(label), pageToken: null, skip: 0 });
  if (r.status === "NOT_WIRED" || r.status === "ERROR") return r;
  if (r.status === "SLOW_DOWN") return { status: "ERROR", detail: "Gmail asked to slow down" };
  return { status: "ok", items: r.items, read: r.read };
}
async function sha(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Has this address written to the person since a time (the intro's reply check): one list call, headers never read.
export async function heardFrom(d: GmailRead, userId: string, email: string, sinceMs: number): Promise<"yes" | "no" | "NOT_WIRED" | "ERROR"> {
  const e = cleanEmail(email);
  if (!e) return "no";
  const token = await d.token(userId).catch(() => null);
  if (!token) return "NOT_WIRED";
  const g = await getJson(d, `${API}/messages?q=${encodeURIComponent(`from:${e} after:${Math.floor(sinceMs / 1000)}`)}&maxResults=1`, token).catch(() => ({ ok: false as const, status: 0 }));
  if (!g.ok) return "ERROR";
  return (g.body?.messages ?? []).length ? "yes" : "no";
}

// ------------------------------------------------------------------------------------------------ job alerts
export type { JobSite };
const SITE = JOB_ALERT_SENDERS;
export const siteOfDomain = (domain: string): JobSite | null => {
  const r = registrable(domain).full;
  return (Object.keys(SITE) as JobSite[]).find((s) => SITE[s].includes(r)) ?? null;
};
// A job link on the site: Indeed's posting and click paths, Handshake's job pages. Never anything else on the site.
const JOB_PATH: Record<JobSite, RegExp> = {
  indeed: /^\/(?:rc\/clk|pagead\/clk|viewjob|jobs?\b|m\/viewjob)|[?&]jk=[0-9a-f]{8,}/i,
  handshake: /^\/(?:stu\/)?(?:jobs|job-search|postings)\/\d+/i,
};
const NOT_A_TITLE = /^(?:view|see|apply|show|browse|manage|update|edit|unsubscribe|email preferences|privacy|terms|help|sign in|log in|download|get the app|more jobs|all jobs|search|settings|indeed|handshake|here|click here|learn more|save|dismiss)\b/i;
export interface JobEmail { source: JobSite; title: string; detail: string; url: string; message_hash: string; received_at: string }

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; });
// The words of some HTML, one entry per line or block (cleaned each), markup and scripts gone.
const linesOf = (html: string) => decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|tr|td|li|h\d|table|tbody)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))
  .split("\n").map((l) => cleanCell(l, 300)).filter(Boolean);
const textOf = (html: string) => linesOf(html).join(" ").slice(0, 2000);

// The postings in one alert email's HTML. Pure: the caller has already checked who sent it.
export function postingsIn(site: JobSite, html: string): { title: string; detail: string; url: string }[] {
  const out: { title: string; detail: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]{0,600}?)<\/a>/gi;
  const src = html.slice(0, 600_000);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && out.length < 50) {
    const href = decodeEntities((m[2] ?? m[3] ?? "").trim());
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (u.protocol !== "https:" || u.username || u.password || siteOfDomain(u.hostname) !== site || !JOB_PATH[site].test(u.pathname + u.search)) continue;
    const title = textOf(m[4]).trim();
    if (title.length < 2 || title.length > 200 || !/\p{L}/u.test(title) || NOT_A_TITLE.test(title) || /https?:\/\//i.test(title) || readsAsInstruction(title)) continue;
    // The words right after the link, up to the next link: the company and place, as the email wrote them (a line that
    // reads as an instruction is left out).
    const after = src.slice(re.lastIndex, re.lastIndex + 1500);
    const stop = after.search(/<a\b/i);
    const detail = linesOf(stop >= 0 ? after.slice(0, stop) : after).filter((l) => !readsAsInstruction(l)).slice(0, 2).join(" · ").slice(0, 300);
    const url = u.toString().slice(0, 2048);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, detail, url });
  }
  return out;
}
const b64url = (s: string) => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return ""; }
};
function htmlOf(payload: any, depth = 0): string {
  if (!payload || depth > 6) return "";
  if (String(payload.mimeType ?? "").toLowerCase() === "text/html" && payload.body?.data) return b64url(payload.body.data).slice(0, 600_000);
  for (const p of Array.isArray(payload.parts) ? payload.parts : []) { const h = htmlOf(p, depth + 1); if (h) return h; }
  return "";
}

export const jobAlertsQuery = (afterMs?: number | null, days = 30) => `from:(${[...SITE.indeed, ...SITE.handshake].join(" OR ")}) newer_than:${days}d -in:spam -in:trash${afterPart(afterMs)}`;
export async function jobAlertsStep(d: GmailRead, userId: string, cur: Cursor, deadline = Number.POSITIVE_INFINITY): Promise<Step<JobEmail>> {
  const token = await d.token(userId).catch(() => null);
  if (!token) return { status: "NOT_WIRED" };
  try {
    return await step<JobEmail>(d, token, cur, deadline, async (id) => {
      const g = await getJson(d, `${API}/messages/${encodeURIComponent(id)}?format=full`, token);
      if (!g.ok) return g.status === 404 ? null : g;
      const atMs = msOf(g.body) || Date.now();
      const from = addresses(header(g.body, "from")[0] ?? "")[0];
      const site = from ? siteOfDomain(from.email.split("@")[1]) : null;
      if (!from || !site || !authenticated(header(g.body, "authentication-results"), from.email.split("@")[1])) return { ok: true, items: [], refused: true, atMs };
      const hash = await sha(`gmail:${userId}:${id}`);
      return { ok: true, items: postingsIn(site, htmlOf(g.body?.payload)).map((p) => ({ source: site, ...p, message_hash: hash, received_at: new Date(atMs).toISOString() })), refused: false, atMs };
    });
  } catch (e) {
    return { status: "ERROR", detail: e instanceof Error ? e.message : String(e) };
  }
}
// Every alert email of the last `days`, all pages, in one call (no deadline).
export async function readJobAlerts(d: GmailRead, userId: string, o: { days?: number } = {}): Promise<Read<JobEmail> & { refused?: number }> {
  const r = await jobAlertsStep(d, userId, { query: jobAlertsQuery(null, o.days ?? 30), pageToken: null, skip: 0 });
  if (r.status === "NOT_WIRED" || r.status === "ERROR") return r;
  if (r.status === "SLOW_DOWN") return { status: "ERROR", detail: "Gmail asked to slow down" };
  return { status: "ok", items: r.items, read: r.read, refused: r.refused };
}
