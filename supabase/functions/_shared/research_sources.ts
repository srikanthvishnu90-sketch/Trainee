// RESEARCH ANSWER LAYOUT (owner, 2026-10-28): the sources a research answer may stand on, and the guard every link in it
// passes. A URL is "verified" only when this module fetched it and got HTTP 200 with readable text; that fetch result is
// the only thing that can put a link in front of the person (research_reply.ts). LinkedIn, Indeed and Handshake are never
// fetched (owner rule: never automate or fetch them), nor are private or local addresses.
//
// This is not a search engine: it reads the pages it is handed (from whatever search capability the turn has) and says
// which ones it could actually open. Its one import is the shared SSRF address check (contact_sources/web_gate.ts isPrivateIp).
//
// Review of #589 (DNS rebinding) and R9 free sources (2026-11-08): fetchSources also takes, per call,
//   resolver  the host's A/AAAA answers, checked on EVERY hop (the first request and each redirect) BEFORE the fetch and again
//             right AFTER it. Before: one private, loopback, link-local, CGNAT or reserved answer refuses the hop (private_address);
//             no answer is unreachable. After: the body is kept only if the name answers again, every answer is public, and every
//             answer was in the set checked before; otherwise it is discarded unread (private_address for a private answer,
//             address_changed for a new address or for no answer, an error, a timeout or NXDOMAIN: it fails closed). research_dns.ts systemResolver is the
//             production one (Deno.resolveDns, read at call time so the eval can stand in a stub).
//             What this does NOT close (review of #628): fetch() resolves the name again itself, and the edge runtime cannot pin
//             a connection to the checked address (no IP with SNI), so a TTL-0 name could answer a private address to fetch()
//             alone, between the two checks. The second check discards the page whenever its answer differs from the checked
//             set in any way; a name that flips for exactly fetch()'s lookup and answers the same set before and after can
//             still reach an internal address once (the request is sent; its body is discarded only if a check catches it).
//   deadline  a wall-clock time (by `clock`, the machine's real clock) after which no further hop starts: the rest are refused as
//             time_budget, so a research turn names what it did not read instead of waiting.
//   robots    may this exact URL be read (robots.txt; research_free_sources.ts robotsGate)? Checked on every hop too.
//   convert   documented public JSON, RSS and XML answers (ATS job boards, Wikidata, GitHub, USAJOBS, news RSS) turned into
//             plain sentences by code from the fields of the answer, so the facts guard can quote them like any page.
import { isPrivateIp } from "./contact_sources/web_gate.ts";

export interface SourcePage {
  url: string; // the address that answered 200 (after any redirects); the only form of this source ever linked
  requested: string; // the address it was asked to read
  status: 200;
  title: string;
  text: string; // the page's readable text (tags, scripts and styles removed), capped
  fetchedAt: number;
}
export interface SourceRejection { url: string; why: "blocked_site" | "not_http" | "private_address" | "robots_disallow" | "http_status" | "not_text" | "too_many_redirects" | "unreachable" | "empty" | "time_budget" | "address_changed" }
export type Resolver = (host: string) => Promise<string[]>;
export type RobotsCheck = (url: string) => Promise<boolean>;
export type Convert = (url: string, contentType: string, body: string) => { title: string; text: string } | null;
export interface FetchedSources { verified: SourcePage[]; rejected: SourceRejection[] }

// Never fetched, never linked (owner rule). Matched on the host and every parent domain; Indeed's country sites too.
const BLOCKED_DOMAINS = ["linkedin.com", "lnkd.in", "licdn.com", "indeed.com", "joinhandshake.com", "handshake.com"];
// R9 free sources: the never-list on ANY TLD and at any depth, as a whole DNS label (glassdoor.co.uk, linkedin.cn,
// www.ziprecruiter.ca, glassdoor.com.evil.example all refuse), the same names career_contact_sources.ts never opens.
// Google Scholar is the label pair scholar.google on any suffix.
const NEVER_LABELS = new Set(["linkedin", "lnkd", "licdn", "indeed", "indeedemail", "indeedmail", "joinhandshake", "glassdoor", "ziprecruiter", "crunchbase", "commoncrawl"]);
export function isBlockedHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return true; }
  if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  const named = host.split(".").filter(Boolean).slice(0, -1);
  if (named.some((l) => NEVER_LABELS.has(l)) || named.some((l, i) => l === "scholar" && named[i + 1] === "google")) return true;
  return /(^|\.)indeed\.(co\.)?[a-z]{2,3}$/.test(host);
}
export function isPrivateHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
  // An IPv4 literal is judged by the full address check (CGNAT, multicast, reserved and the rest), not only the common ranges.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIp(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.includes(":")) return true; // IPv6 literals: none are needed for public sources
  return false;
}
const isHttp = (url: string) => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } };
// A page read over plain http can be read, but it is never shown as a link (scenarios 2026-10-29): only https is linked.
export const isHttps = (url: string) => { try { return new URL(url).protocol === "https:"; } catch { return false; } };

// One form for comparing links: no fragment, no trailing slash on the path, host lowercased.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(String(url).trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch { return String(url ?? "").trim(); }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
  if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
  if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});
export function readableText(html: string): { title: string; text: string } {
  const h = String(html ?? "");
  const og = h.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const title = decode((og ?? h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
  const text = decode(h.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t\f\r]+/g, " ").replace(/\n\s*/g, "\n").trim();
  return { title, text };
}

const MAX_BYTES = 1_500_000, MAX_TEXT = 60_000, MAX_REDIRECTS = 3;

// Reads each page once. Nothing here throws: a page that cannot be read is a rejection with its reason.
type ReadOpts = { resolver?: Resolver; robots?: RobotsCheck; convert?: Convert; deadline?: number; clock?: () => number };
// Review of #628: a body is read as a stream and stops at its cap; nothing past the cap is ever buffered. truncated: the cap was hit.
export async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(0, max), truncated: false };
  const reader = res.body.getReader(), parts: Uint8Array[] = [];
  let n = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - n;
      if (value.length > room) { parts.push(value.subarray(0, room)); n += room; truncated = true; break; }
      parts.push(value); n += value.length;
    }
  } finally { if (truncated) await reader.cancel().catch(() => {}); else reader.releaseLock(); }
  const bytes = new Uint8Array(n); let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, truncated };
}
export async function fetchSources(urls: string[], o: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; max?: number } & ReadOpts = {}): Promise<FetchedSources> {
  const f = o.fetch ?? fetch, timeout = o.timeoutMs ?? 10000, now = o.now ?? Date.now;
  const out: FetchedSources = { verified: [], rejected: [] };
  const seen = new Set<string>();
  for (const raw of urls.slice(0, o.max ?? 8)) {
    const requested = normalizeUrl(raw);
    if (seen.has(requested)) continue;
    seen.add(requested);
    const page = await readOne(requested, f, timeout, o);
    if ("why" in page) { out.rejected.push({ url: requested, why: page.why }); continue; }
    if (out.verified.some((v) => v.url === page.url)) continue;
    out.verified.push({ ...page, requested, status: 200, fetchedAt: now() });
  }
  return out;
}

// The host's resolved addresses before a fetch: all public (the set, kept), else why not (no answer: unreachable; any private
// answer: private_address).
export async function resolveBefore(url: string, resolver: Resolver): Promise<{ ips: Set<string> } | { why: SourceRejection["why"] }> {
  let ips: string[];
  try { ips = await resolver(new URL(url).hostname.toLowerCase().replace(/\.$/, "")); } catch { return { why: "unreachable" }; }
  if (!Array.isArray(ips) || !ips.length) return { why: "unreachable" };
  return ips.every((ip) => !isPrivateIp(String(ip))) ? { ips: new Set(ips.map((ip) => String(ip).toLowerCase())) } : { why: "private_address" };
}
// The same name looked up again right after the fetch (review of #628, B1 and B2). The body is kept ONLY when this lookup answers,
// every answer is public, and every answer was already in the set checked before the fetch. A private answer is private_address;
// a new address (public too), no answer, an error, a timeout or NXDOMAIN is address_changed. Fails closed.
export async function resolveAfter(url: string, resolver: Resolver, before: Set<string>): Promise<true | SourceRejection["why"]> {
  let ips: string[];
  try { ips = await resolver(new URL(url).hostname.toLowerCase().replace(/\.$/, "")); } catch { return "address_changed"; }
  if (!Array.isArray(ips) || !ips.length) return "address_changed";
  if (ips.some((ip) => isPrivateIp(String(ip)))) return "private_address";
  return ips.every((ip) => before.has(String(ip).toLowerCase())) ? true : "address_changed";
}
async function readOne(start: string, f: typeof fetch, timeout: number, o: ReadOpts = {}): Promise<{ url: string; title: string; text: string } | { why: SourceRejection["why"] }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop passes the same checks, so a redirect can never carry a fetch to a blocked or private address: the name, then
    // (with a resolver) the addresses it resolves to right now, then (with a robots check) robots.txt for that exact path.
    if (!isHttp(url)) return { why: "not_http" };
    if (isBlockedHost(url)) return { why: "blocked_site" };
    if (isPrivateHost(url)) return { why: "private_address" };
    const clock = o.clock ?? Date.now, left = () => (o.deadline === undefined ? Infinity : o.deadline - clock());
    if (left() <= 0) return { why: "time_budget" };
    let checked: Set<string> | null = null;
    if (o.resolver) { const r = await resolveBefore(url, o.resolver); if ("why" in r) return { why: r.why }; checked = r.ips; }
    if (o.robots) { let yes = false; try { yes = await o.robots(url); } catch { yes = false; } if (!yes) return { why: "robots_disallow" }; }
    if (left() <= 0) return { why: "time_budget" };
    let res: Response;
    try {
      res = await f(url, { method: "GET", redirect: "manual", headers: { accept: "text/html,text/plain;q=0.9" }, signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, left()))) });
    } catch { return { why: left() <= 0 ? "time_budget" : "unreachable" }; }
    // Re-resolved right after the fetch (resolveAfter): the body is discarded unread unless the name still answers, every answer
    // is public, and every answer was in the set checked before the fetch. Any other outcome, a lookup error included, discards it.
    if (o.resolver && checked) { const after = await resolveAfter(url, o.resolver, checked); if (after !== true) { await res.body?.cancel().catch(() => {}); return { why: after }; } }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { why: "http_status" };
      try { url = normalizeUrl(new URL(loc, url).toString()); } catch { return { why: "http_status" }; }
      continue;
    }
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return { why: "http_status" }; }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const structured = !!o.convert && /json|xml|rss|atom/.test(type) && !/text\/html|application\/xhtml/.test(type);
    if (!structured && !/text\/html|text\/plain|application\/xhtml/.test(type)) { await res.body?.cancel().catch(() => {}); return { why: "not_text" }; }
    let body = "";
    try { body = new TextDecoder().decode((await readCapped(res, MAX_BYTES)).bytes); } catch { return { why: "unreachable" }; }
    let conv: { title: string; text: string } | null = null;
    if (structured) { try { conv = o.convert!(url, type, body); } catch { conv = null; } if (!conv) return { why: "not_text" }; }
    const { title, text } = conv ?? (/text\/plain/.test(type) ? { title: "", text: body.trim() } : readableText(body));
    if (!text) return { why: "empty" };
    return { url, title: title || new URL(url).hostname, text: text.slice(0, MAX_TEXT) };
  }
  return { why: "too_many_redirects" };
}

// THE LINK GUARD. Of the links a draft wants to show, only those a fetch above returned (status 200, same normalized
// address) survive; every other one is dropped and named, so the reply can say it left a link out instead of passing it on.
export function verifiedLinkGuard(urls: string[], verified: Pick<SourcePage, "url" | "status">[]): { kept: string[]; dropped: string[] } {
  const ok = new Set(verified.filter((v) => v.status === 200 && isHttps(v.url) && !isBlockedHost(v.url)).map((v) => normalizeUrl(v.url)));
  const kept: string[] = [], dropped: string[] = [];
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (ok.has(n) && !isBlockedHost(n)) { if (!kept.includes(n)) kept.push(n); }
    else if (!dropped.includes(n)) dropped.push(n);
  }
  return { kept, dropped };
}

export const URL_IN_TEXT = /https?:\/\/[^\s<>()\]"']+/g;
export const urlsIn = (text: string) => (String(text ?? "").match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
