// RESEARCH ANSWER LAYOUT (owner, 2026-10-28): the sources a research answer may stand on, and the guard every link in it
// passes. A URL is "verified" only when this module fetched it and got HTTP 200 with readable text; that fetch result is
// the only thing that can put a link in front of the person (research_reply.ts). LinkedIn, Indeed and Handshake are never
// fetched (owner rule: never automate or fetch them), nor are private or local addresses.
//
// This is not a search engine: it reads the pages it is handed (from whatever search capability the turn has) and says
// which ones it could actually open. Self-contained on purpose (no imports), so tests load it on its own.

export interface SourcePage {
  url: string; // the address that answered 200 (after any redirects); the only form of this source ever linked
  requested: string; // the address it was asked to read
  status: 200;
  title: string;
  text: string; // the page's readable text (tags, scripts and styles removed), capped
  fetchedAt: number;
}
export interface SourceRejection { url: string; why: "blocked_site" | "not_http" | "private_address" | "http_status" | "not_text" | "too_many_redirects" | "unreachable" | "empty" }
export interface FetchedSources { verified: SourcePage[]; rejected: SourceRejection[] }

// Never fetched, never linked (owner rule). Matched on the host and every parent domain; Indeed's country sites too.
const BLOCKED_DOMAINS = ["linkedin.com", "lnkd.in", "licdn.com", "indeed.com", "joinhandshake.com", "handshake.com"];
export function isBlockedHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return true; }
  if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return /(^|\.)indeed\.(co\.)?[a-z]{2,3}$/.test(host);
}
function isPrivateHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
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
export async function fetchSources(urls: string[], o: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; max?: number } = {}): Promise<FetchedSources> {
  const f = o.fetch ?? fetch, timeout = o.timeoutMs ?? 10000, now = o.now ?? Date.now;
  const out: FetchedSources = { verified: [], rejected: [] };
  const seen = new Set<string>();
  for (const raw of urls.slice(0, o.max ?? 8)) {
    const requested = normalizeUrl(raw);
    if (seen.has(requested)) continue;
    seen.add(requested);
    const page = await readOne(requested, f, timeout);
    if ("why" in page) { out.rejected.push({ url: requested, why: page.why }); continue; }
    if (out.verified.some((v) => v.url === page.url)) continue;
    out.verified.push({ ...page, requested, status: 200, fetchedAt: now() });
  }
  return out;
}

async function readOne(start: string, f: typeof fetch, timeout: number): Promise<{ url: string; title: string; text: string } | { why: SourceRejection["why"] }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop passes the same checks, so a redirect can never carry a fetch to a blocked or private address.
    if (!isHttp(url)) return { why: "not_http" };
    if (isBlockedHost(url)) return { why: "blocked_site" };
    if (isPrivateHost(url)) return { why: "private_address" };
    let res: Response;
    try {
      res = await f(url, { method: "GET", redirect: "manual", headers: { accept: "text/html,text/plain;q=0.9" }, signal: AbortSignal.timeout(timeout) });
    } catch { return { why: "unreachable" }; }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { why: "http_status" };
      try { url = normalizeUrl(new URL(loc, url).toString()); } catch { return { why: "http_status" }; }
      continue;
    }
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return { why: "http_status" }; }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) { await res.body?.cancel().catch(() => {}); return { why: "not_text" }; }
    let body = "";
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      body = new TextDecoder().decode(buf.slice(0, MAX_BYTES));
    } catch { return { why: "unreachable" }; }
    const { title, text } = /text\/plain/.test(type) ? { title: "", text: body.trim() } : readableText(body);
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
