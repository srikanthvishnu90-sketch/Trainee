// PEOPLE FINDING (D-033): a public page the person sends (a company's team or about page, or someone's own site), read
// once on their ask. Trainee has no web search (none is wired in the product: checked 2026-10-26), so it never looks a
// page up itself; it reads only the link it was given.
//
// What counts as a person: a schema.org Person the page itself publishes (JSON-LD: name, jobTitle, worksFor, alumniOf,
// email), and an address the page publishes as a mailto: link, named only when the link's own words are a name. Page
// prose is never mined for names, and no address is ever made up: an email is only one the page wrote.
// Never LinkedIn, Indeed or Handshake on any country domain or subdomain (owner rule: never automate them;
// career_people_sites.ts), never a private or local address (checked on the name AND on every address the name
// resolves to, before the first request and again on every redirect), never a non-HTTPS page, never a page the site's
// robots.txt disallows; at most 3 redirects, each checked again; 2 MB, 8 s.
// DNS rebinding: closed. Each hop connects to the address that was checked (pinnedGet below); nothing resolves the name
// a second time, so a DNS answer that changes after the check (a near-zero TTL) is never used.
import { cleanCell, cleanEmail, readsAsInstruction } from "./career_people_import.ts";
import { neverOpen } from "./career_people_sites.ts";
import { isRoleAddress, isTeamName } from "./career_contacts.ts";

export const PAGE_MAX_BYTES = 2_000_000, PAGE_TIMEOUT_MS = 8_000, MAX_REDIRECTS = 3; // what one fetch may hold; no count of people (the 2 MB bounds the work)
export const UA = "TraineeBot/1.0 (reads one page a person sent; no crawling)";

export type PageWhy = "bad_url" | "not_https" | "blocked_site" | "private_host" | "robots" | "too_large" | "not_html" | "http" | "timeout" | "network" | "redirects" | "not_allowed";
// former: the page itself says they no longer hold the role (a title "Former ...", "ex-...", "Previously ...", "until 2024",
// "now at ..."; a worksFor role with an end date). NETWORKING R2 (2026-10-30).
export interface PagePerson { name: string | null; title: string; company: string; school: string; email: string | null; how: "schema.org Person" | "mailto link"; former?: boolean }
// Words in a title that say the role is over (dated evidence included: "until 2024", "2019-2023", "left in 2025").
export const FORMER_TITLE = /(?:^|[\s(,;\/|-])(?:former(?:ly)?|ex[- ](?=\p{L})|previously|retired|left (?:in |the company|\p{Lu})|until (?:\w+ )?(?:19|20)\d{2}|(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}|now (?:at|with|leading|heading)\b|no longer)/iu;
export const formerTitle = (t: unknown) => FORMER_TITLE.test(String(t ?? ""));
export type PageRead = { ok: true; url: string; people: PagePerson[]; org: string | null } | { ok: false; why: PageWhy; detail?: string };
// Every address a host name resolves to (A and AAAA). Throws, or returns none, when the name doesn't resolve.
export type Resolver = (host: string) => Promise<string[]>;

// A host Trainee may fetch: a public DNS name with a dot, never an IP literal, never localhost or an internal suffix.
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; why: PageWhy } {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return { ok: false, why: "bad_url" }; }
  if (u.protocol !== "https:") return { ok: false, why: "not_https" };
  if (u.username || u.password || (u.port && u.port !== "443")) return { ok: false, why: "bad_url" };
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (neverOpen(h)) return { ok: false, why: "blocked_site" };
  if (!h.includes(".") || /^\[|^[\d.]+$|^0x|:/.test(h) || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|arpa)$/.test(h)) return { ok: false, why: "private_host" };
  return { ok: true, url: u };
}

// ------------------------------------------------------------------------------------------------ addresses
const v4 = (s: string): number[] | null => {
  const p = s.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.map(Number);
};
// Public unicast IPv4 only: never this-network, private (RFC 1918), CGNAT (100.64/10), loopback, link-local with the
// cloud metadata address (169.254/16), the IETF, TEST-NET, benchmark and 6to4-relay ranges, multicast, reserved, broadcast.
function publicV4(b: number[]): boolean {
  const [a, c, d] = b;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && c >= 64 && c <= 127) return false;
  if (a === 169 && c === 254) return false;
  if (a === 172 && c >= 16 && c <= 31) return false;
  if (a === 192 && c === 168) return false;
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return false;
  if (a === 192 && c === 88 && d === 99) return false;
  if (a === 198 && (c === 18 || c === 19)) return false;
  if (a === 198 && c === 51 && d === 100) return false;
  if (a === 203 && c === 0 && d === 113) return false;
  return true;
}
// Eight 16-bit groups, or null. Takes "::", a dotted IPv4 tail and a zone id (dropped).
function v6(s: string): number[] | null {
  let t = s.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (tail) { const b = v4(tail[1]); if (!b) return null; t = t.slice(0, -tail[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":") : []);
  const head = part(halves[0]), rest = halves.length === 2 ? part(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
}
// Public unicast IPv6 only: global unicast (2000::/3) minus documentation, ORCHID, Teredo and 6to4 (which carry an IPv4
// address), and IPv4-mapped, IPv4-compatible and NAT64 addresses judged by the IPv4 address they carry. Never loopback,
// unspecified, unique-local (fc00::/7: fd00::/8, so AWS's fd00:ec2::254 metadata address), link-local or multicast.
function publicV6(g: number[]): boolean {
  const carried = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 ? false : publicV4(carried());
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicV4(carried());
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] < 0x0200 || (g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020)) return false;
  if (g[0] === 0x2002) return false;
  return true;
}
// True only for an address on the public internet. Anything that doesn't parse is not public.
export function publicAddress(ip: string): boolean {
  const s = String(ip ?? "").trim();
  const b = v4(s);
  if (b) return publicV4(b);
  const g = v6(s);
  return g ? publicV6(g) : false;
}
// The runtime's DNS: A and AAAA together; a name with neither does not resolve.
export const dnsResolver: Resolver = async (host) => {
  const got = await Promise.allSettled([Deno.resolveDns(host, "A"), Deno.resolveDns(host, "AAAA")]);
  const ips = got.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!ips.length) throw new Error(`no address for ${host}`);
  return ips;
};
// The URL check, then every address the name resolves to: one private address refuses it (a name may answer with several).
// The vetted address is returned, and it is the only one the request may connect to (pinnedGet): the name is never
// resolved again between this check and the connection.
export async function checkHost(raw: string, resolve: Resolver): Promise<{ ok: true; url: URL; ip: string } | { ok: false; why: PageWhy; detail?: string }> {
  const c = checkUrl(raw);
  if (!c.ok) return c;
  let ips: string[];
  try { ips = await resolve(c.url.hostname.replace(/\.$/, "")); } catch (e) { return { ok: false, why: "network", detail: e instanceof Error ? e.message : String(e) }; }
  if (!ips.length) return { ok: false, why: "network", detail: "no address" };
  if (!ips.every(publicAddress)) return { ok: false, why: "private_host" };
  return { ...c, ip: ips[0].replace(/^\[|\]$/g, "") };
}

// ------------------------------------------------------------------------------------------------ the pinned request
// DNS rebinding is closed by never letting anything resolve the name again: the TCP connection goes to the address
// checkHost vetted, and TLS runs over it for the page's own name (Deno.startTls: SNI and certificate verification
// against the name, so a hostile DNS answer can't reach an internal service, and a certificate for the name is still
// required). The request is plain HTTP/1.1 written on that connection (Connection: close, identity encoding), so no
// client library resolves anything. This runs in Supabase edge functions: outbound TCP and startTls are what the
// Postgres drivers there use.
export type PageGet = (url: URL, ip: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;
export interface Conn { read(p: Uint8Array): Promise<number | null>; write(p: Uint8Array): Promise<number>; close(): void }
export interface Net { connect(o: { hostname: string; port: number }): Promise<Conn>; startTls(c: Conn, o: { hostname: string }): Promise<Conn> }
export const denoNet: Net = {
  connect: (o) => Deno.connect({ hostname: o.hostname, port: o.port, transport: "tcp" }),
  startTls: (c, o) => Deno.startTls(c as Deno.TcpConn, { hostname: o.hostname }),
};
// Bytes one response may carry before it is refused as too large: the page cap plus room for headers and chunk framing.
const WIRE_MAX = PAGE_MAX_BYTES + 256_000;
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const abortError = () => named("AbortError", "the page took too long");

function indexOf(h: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= h.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (h[i + j] !== needle[j]) continue outer; return i; }
  return -1;
}
const CRLF = [13, 10], HEAD_END = [13, 10, 13, 10];
const latin1 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
function dechunk(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0, n = 0;
  for (;;) {
    const eol = indexOf(b, CRLF, i);
    if (eol < 0) throw named("BadResponse", "chunked body ends early");
    const size = parseInt(latin1(b.subarray(i, eol)).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw named("BadResponse", "bad chunk size");
    if (size === 0) break;
    const start = eol + 2, end = start + size;
    if (end + 2 > b.length) throw named("BadResponse", "chunked body ends early");
    parts.push(b.subarray(start, end)); n += size;
    i = end + 2;
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Pure: a whole HTTP/1.1 response (as read until the server closed) into a Response. Exported for the tests.
export function parseHttpResponse(raw: Uint8Array): Response {
  const end = indexOf(raw, HEAD_END);
  if (end < 0) throw named("BadResponse", "no response headers");
  const lines = latin1(raw.subarray(0, end)).split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
  const status = m ? Number(m[1]) : 0;
  if (status < 200 || status > 599) throw named("BadResponse", `status ${lines[0]?.slice(0, 40)}`);
  const headers = new Headers();
  for (const l of lines.slice(1)) {
    const k = l.indexOf(":");
    if (k <= 0) continue;
    try { headers.append(l.slice(0, k).trim(), l.slice(k + 1).trim()); } catch { /* a header no client could hold: dropped */ }
  }
  let body = raw.subarray(end + 4);
  if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) body = dechunk(body);
  else if (headers.has("content-length")) {
    const cl = Number(headers.get("content-length"));
    if (!Number.isFinite(cl) || cl < 0 || body.length < cl) throw named("BadResponse", "body shorter than its content-length");
    body = body.subarray(0, cl);
  }
  return new Response([204, 205, 304].includes(status) ? null : body.slice(), { status, headers });
}
export function pinnedGet(net: Net = denoNet): PageGet {
  return async (url, ip, headers, signal) => {
    if (signal.aborted) throw abortError();
    const target = `${url.pathname || "/"}${url.search}`;
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    if (/[\r\n\s]/.test(target + url.hostname) || Object.entries(headers).some(([k, v]) => /[\r\n]/.test(k + v))) throw named("BadRequest", "a line break in the request");
    let conn: Conn | null = null;
    const onAbort = () => { try { conn?.close(); } catch { /* closed */ } };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const tcp = await net.connect({ hostname: ip, port: 443 });
      conn = tcp;
      const tls = await net.startTls(tcp, { hostname: url.hostname });
      conn = tls;
      const req = new TextEncoder().encode(`GET ${target} HTTP/1.1\r\nHost: ${url.hostname}\r\n${extra}Accept-Encoding: identity\r\nConnection: close\r\n\r\n`);
      for (let o = 0; o < req.length;) o += await tls.write(req.subarray(o));
      const parts: Uint8Array[] = [];
      let n = 0;
      const buf = new Uint8Array(64 * 1024);
      for (;;) {
        const got = await tls.read(buf);
        if (got === null) break;
        n += got;
        if (n > WIRE_MAX) throw named("TooLarge", "the page is over the size limit");
        parts.push(buf.slice(0, got));
      }
      const raw = new Uint8Array(n); let o = 0;
      for (const p of parts) { raw.set(p, o); o += p.length; }
      return parseHttpResponse(raw);
    } catch (e) {
      if (signal.aborted) throw abortError();
      throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { conn?.close(); } catch { /* closed */ }
    }
  };
}

async function timed(get: PageGet, url: URL, ip: string, headers: Record<string, string>): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PAGE_TIMEOUT_MS);
  try { return await get(url, ip, headers, ac.signal); } finally { clearTimeout(t); }
}
async function capped(r: Response, max: number): Promise<string | null> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return new TextDecoder().decode(out);
}

// robots.txt, the group for "*" (or this agent): a Disallow prefix that matches the path refuses the read; an Allow that
// matches it longer wins. No robots.txt (or an unreadable one) is no rule.
export function robotsAllows(txt: string, path: string): boolean {
  let applies = false, inGroup = false, best = { len: -1, allow: true };
  for (const raw of String(txt ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!inGroup) applies = false; inGroup = true; if (v === "*" || /traineebot/i.test(v)) applies = true; continue; }
    inGroup = false;
    if (!applies || (k !== "disallow" && k !== "allow") || !v) continue;
    const rx = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (rx.test(path) && v.length > best.len) best = { len: v.length, allow: k === "allow" };
  }
  return best.allow;
}

export async function readPage(get: PageGet, raw: string, resolve: Resolver = dnsResolver): Promise<PageRead> {
  const r = await fetchHtml(get, raw, resolve);
  if (!r.ok) return r;
  const { people, org } = peopleOnPage(r.html);
  return { ok: true, url: r.url, people, org };
}
// One public page read under every rule above (HTTPS, public host, never LinkedIn/Indeed/Handshake, robots.txt, pinned
// address, 3 redirects, 2 MB, 8 s): its HTML. PERSONALIZED OUTREACH reads a contact's team page or filing through this.
// `allow`: the caller's allowlist (career_networking.ts: the host the fact's source kind was judged on). It is checked on
// the first URL and on every redirect hop before that hop is resolved, with the private-address block after it, at most
// MAX_REDIRECTS hops: a firm page that redirects anywhere else is never read (#361 takeover, 2026-11-01).
export async function fetchHtml(get: PageGet, raw: string, resolve: Resolver = dnsResolver, allow?: (url: URL) => boolean): Promise<{ ok: true; url: string; html: string } | { ok: false; why: PageWhy; detail?: string }> {
  // An unparsable URL is left to checkHost, which refuses it as bad_url.
  const offList = (u: string) => { if (!allow) return false; let x: URL; try { x = new URL(u); } catch { return false; } return !allow(x); };
  if (offList(raw)) return { ok: false, why: "not_allowed" };
  const c = await checkHost(raw, resolve);
  if (!c.ok) return c.detail ? { ok: false, why: c.why, detail: c.detail } : { ok: false, why: c.why };
  let url = c.url, ip = c.ip;
  try {
    const rob = await timed(get, new URL("/robots.txt", url.origin), ip, { "User-Agent": UA }).catch(() => null);
    if (rob && rob.ok) { const txt = await capped(rob, 200_000); if (txt !== null && !robotsAllows(txt, url.pathname + url.search)) return { ok: false, why: "robots" }; }
    else await rob?.body?.cancel().catch(() => {});
    for (let hop = 0; ; hop++) {
      const r = await timed(get, url, ip, { "User-Agent": UA, Accept: "text/html" });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        await r.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { ok: false, why: "redirects" };
        const target = new URL(r.headers.get("location")!, url).toString();
        if (offList(target)) return { ok: false, why: "not_allowed", detail: "it redirected to a site I don't read" };
        const next = await checkHost(target, resolve);
        if (!next.ok) return next.detail ? { ok: false, why: next.why, detail: next.detail } : { ok: false, why: next.why };
        url = next.url; ip = next.ip;
        continue;
      }
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return { ok: false, why: "http", detail: `HTTP ${r.status}` }; }
      if (!/text\/html|application\/xhtml/i.test(r.headers.get("content-type") ?? "")) { await r.body?.cancel().catch(() => {}); return { ok: false, why: "not_html" }; }
      if (Number(r.headers.get("content-length") ?? 0) > PAGE_MAX_BYTES) { await r.body?.cancel().catch(() => {}); return { ok: false, why: "too_large" }; }
      const html = await capped(r, PAGE_MAX_BYTES);
      if (html === null) return { ok: false, why: "too_large" };
      return { ok: true, url: url.toString(), html };
    }
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TooLarge") return { ok: false, why: "too_large" };
    return { ok: false, why: name === "AbortError" ? "timeout" : "network", detail: e instanceof Error ? e.message : String(e) };
  }
}

// A page's field, cleaned; one that reads as an instruction to a reader (readsAsInstruction) is dropped, never kept.
// NETWORKING R2 (2026-10-30): read as written too, before cleaning: "<|im_start|>system" lost its markup to the cleaner and
// was kept as a title "system".
const str = (v: unknown, max: number): string => {
  const raw = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : null;
  if (raw === null) return Array.isArray(v) ? str(v[0], max) : "";
  const s = cleanCell(raw, max);
  return readsAsInstruction(raw) || readsAsInstruction(s) ? "" : s;
};
const isType = (o: any, t: string) => { const x = o?.["@type"]; return Array.isArray(x) ? x.includes(t) : x === t; };
const NAME_LIKE = /^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]*){1,3}$/u;

// Pure: the people a page publishes about itself. Exported for the tests.
export function peopleOnPage(html: string): { people: PagePerson[]; org: string | null } {
  const people: PagePerson[] = [];
  let org: string | null = null;
  const seen = new Set<string>();
  const add = (p: PagePerson) => {
    const k = `${(p.name ?? "").toLowerCase()}|${p.email ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k); people.push(p);
  };
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== "object" || depth > 6) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    if (isType(o, "Organization") && !org) org = str(o.name, 200) || null;
    if (isType(o, "Person")) {
      const name = str(o.name, 200);
      if (name && /\p{L}/u.test(name) && !/https?:|@/.test(name) && !isTeamName(name)) { // a team is no person (2026-10-29)
        // NETWORKING SCENARIOS (2026-10-29): a role inbox (careers@, recruiting-team@ ...) on a Person is the company's
        // inbox, never that person's address: the person is kept, without it.
        const found = cleanEmail(String(o.email ?? "").replace(/^mailto:/i, ""));
        const email = found && !isRoleAddress(found) ? found : null;
        // A worksFor that is a dated role (schema.org OrganizationRole / EmployeeRole with an endDate) is a past job; its
        // organization is the one inside it. A company named as their alumniOf is a former employer.
        const roles = (Array.isArray(o.worksFor) ? o.worksFor : [o.worksFor]).filter((x: any) => x && typeof x === "object");
        const ended = roles.some((x: any) => (isType(x, "OrganizationRole") || isType(x, "EmployeeRole") || isType(x, "Role")) && typeof x.endDate === "string" && x.endDate.trim());
        const roleOrg = roles.map((x: any) => (x.worksFor ?? x.memberOf ?? null)).find((x: any) => x) ?? null;
        const company = str(roleOrg ?? o.worksFor, 200), title = str(o.jobTitle ?? roles.map((x: any) => x.roleName).find((x: any) => typeof x === "string"), 300);
        add({ name, title, company, school: str(o.alumniOf, 200), email, how: "schema.org Person", ...(ended || formerTitle(title) ? { former: true } : {}) });
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "@context" && typeof v === "object") walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim()), 0); } catch { /* not JSON: nothing taken from it */ }
  }
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']mailto:([^"'?]+)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const email = cleanEmail(decodeURIComponent(m[1]).trim());
    if (!email) continue;
    const words = cleanCell(m[2].replace(/<[^>]*>/g, " "), 200);
    // A role inbox's link words ("Careers Team", "Talent Acquisition") are never a person's name (2026-10-29).
    const name = NAME_LIKE.test(words) && !readsAsInstruction(words) && !isRoleAddress(email) && !isTeamName(words) ? words : null;
    if ([...people].some((p) => p.email === email)) continue;
    add({ name, title: "", company: "", school: "", email, how: "mailto link" });
  }
  return { people, org };
}
