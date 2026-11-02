// The only way any adapter fetches a web page: default deny. A fetch happens only if
//   1. the host is on the allowlist (a site whose terms a human reviewed; the review is dated and expires after 365 days),
//   2. the host is not on the hard blocklist (LinkedIn, Indeed, Handshake, Glassdoor, ZipRecruiter: never, even if listed),
//   3. the URL is https and the path is inside the rule's allowed prefixes,
//   4. robots.txt for that host was read and allows our user agent for that path (unreadable robots = deny),
//   5. the per-host delay (rule, or robots Crawl-delay if longer) has passed.
// It never logs in, never sends cookies, never follows a redirect off the host, and treats a login wall as a stop.
// The network is a seam (Fetcher): tests pass fixtures; nothing here calls fetch() on its own.
import { isBlockedHost } from "./types.ts";

export interface SiteRule {
  host: string;                 // exact host, e.g. "www.sec.gov"
  org_name: string;             // the organization the pages belong to (firm / university / conference)
  terms_url: string;            // the page a human read
  terms_reviewed_on: string;    // YYYY-MM-DD
  terms_reviewed_by: string;    // a name or role
  terms_summary: string;        // what the terms allow, one sentence
  license_note: string;         // goes on every contact taken from this site
  path_prefixes?: string[];     // default: any path robots allows
  min_delay_ms?: number;        // default 2000
}
export interface FetchResult { status: number; url: string; text: string; location?: string | null }
// The seam. Implementations MUST NOT follow redirects (redirect: "manual"): the gate validates every hop itself.
export type Fetcher = (url: string, init: { headers: Record<string, string>; redirect: "manual" }) => Promise<FetchResult>;
// Production fetcher: no redirects followed, no cookies/credentials sent.
export const manualRedirectFetcher: Fetcher = async (url, init) => {
  const r = await fetch(url, { headers: init.headers, redirect: "manual", credentials: "omit" });
  return { status: r.status, url, text: r.status >= 300 && r.status < 400 ? "" : await r.text(), location: r.headers.get("location") };
};
export type Resolver = (host: string) => Promise<string[]>; // optional DNS seam: A/AAAA answers for a host
export type GateDeny = "not_allowlisted" | "blocked_site" | "not_https" | "path_not_allowed" | "terms_review_expired" | "robots_disallow" | "robots_unavailable"
  | "login_wall" | "redirect_denied" | "too_many_redirects" | "unsafe_host" | "userinfo_not_allowed" | "port_not_allowed" | "private_address" | "http_error" | "fetch_error" | "bad_user_agent";
export type GateResult = { ok: true; text: string; final_url: string; retrieved_at: string; rule: SiteRule } | { ok: false; reason: GateDeny; detail?: string };

interface RobotsRule { allow: boolean; pat: string }
export interface Robots { rules: RobotsRule[]; crawlDelayS: number }
export function parseRobots(text: string, token: string): Robots {
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; delay: number }> = [];
  let cur: { agents: string[]; rules: RobotsRule[]; delay: number } | null = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false; if (!cur) continue;
    if (k === "allow" || k === "disallow") { if (v !== "" || k === "allow") cur.rules.push({ allow: k === "allow", pat: v }); }
    else if (k === "crawl-delay") { const n = Number(v); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const t = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), crawlDelayS: Math.max(0, ...chosen.map((g) => g.delay)) };
}
// Percent-decode (except %2F, which stays a different character from "/") so /pri%76ate/ and /private/ are the same path.
const pdec = (v: string) => v.replace(/%([0-9a-f]{2})/gi, (m, h: string) => h.toLowerCase() === "2f" ? "%2F" : String.fromCharCode(parseInt(h, 16)));
function patMatch(pat: string, path: string): boolean {
  if (pat === "") return false;
  pat = pdec(pat); path = pdec(path);
  const end = pat.endsWith("$"); const body = end ? pat.slice(0, -1) : pat;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (end ? "$" : ""));
  return re.test(path);
}
export function robotsAllows(r: Robots, pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of r.rules) if (patMatch(rule.pat, pathAndQuery)) {
    if (!best || rule.pat.length > best.pat.length || (rule.pat.length === best.pat.length && rule.allow && !best.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// ---- SSRF guards ----
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h.includes(":") || /^\d+(\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/i.test(h);
}
export function isInternalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return !h.includes(".") || h === "localhost" || /\.(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(h) || h === "metadata.google.internal";
}
export function isPrivateIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const m4 = h.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m4) { const [a, b] = [Number(m4[1]), Number(m4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)); }
  if (h.includes(":")) return h === "::" || h === "::1" || /^(fc|fd|fe[89ab])/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b");
  return true; // not parseable as an address: refuse
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sso|auth|authenticate|account\/login|uas\/login)(\/|$|\?)/i;
const LOGIN_BODY = /<input[^>]+type=["']password["']/i;

export class WebGate {
  private robots = new Map<string, Robots | "unavailable">();
  private last = new Map<string, number>();
  private queue = new Map<string, Promise<void>>();
  constructor(private o: {
    allowlist: SiteRule[]; fetcher: Fetcher; userAgent: string; robotsToken?: string; resolver?: Resolver;
    now?: () => Date; sleep?: (ms: number) => Promise<void>; maxAgeDays?: number; maxHops?: number;
  }) {}
  get userAgent(): string { return this.o.userAgent; }
  private now() { return (this.o.now ?? (() => new Date()))(); }
  private sleep(ms: number) { return (this.o.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms); }
  // Exact hostname match only (no suffix or wildcard matching), and the rule's own host must be a plain public-looking hostname.
  ruleFor(host: string): SiteRule | undefined { return this.o.allowlist.find((r) => r.host === host.toLowerCase()); }

  // Pre-flight with no network: scheme, userinfo, port, IP literal / internal name, blocklist, allowlist, review age, path.
  precheck(url: string): { ok: true; u: URL; rule: SiteRule } | { ok: false; reason: GateDeny; detail?: string } {
    let u: URL; try { u = new URL(url); } catch { return { ok: false, reason: "not_https", detail: "unparseable" }; }
    if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
    if (u.username || u.password) return { ok: false, reason: "userinfo_not_allowed" };
    if (u.port !== "") return { ok: false, reason: "port_not_allowed", detail: u.port };
    const host = u.hostname.toLowerCase();
    if (isIpLiteral(host) || isInternalName(host)) return { ok: false, reason: "unsafe_host", detail: host };
    if (isBlockedHost(host)) return { ok: false, reason: "blocked_site" };
    const rule = this.ruleFor(host);
    if (!rule) return { ok: false, reason: "not_allowlisted" };
    if (rule.host !== rule.host.trim().toLowerCase() || isIpLiteral(rule.host) || isInternalName(rule.host) || /[\/:@*]/.test(rule.host)) return { ok: false, reason: "unsafe_host", detail: "allowlist entry" };
    if (isBlockedHost(rule.host)) return { ok: false, reason: "blocked_site" };
    const rev = Date.parse(rule.terms_reviewed_on);
    const maxAge = (this.o.maxAgeDays ?? 365) * 86400000;
    if (!rule.terms_url || !rule.terms_reviewed_by || Number.isNaN(rev) || this.now().getTime() - rev > maxAge || rev > this.now().getTime() + 86400000) return { ok: false, reason: "terms_review_expired" };
    if (rule.path_prefixes?.length && !rule.path_prefixes.some((p) => u.pathname.startsWith(p))) return { ok: false, reason: "path_not_allowed" };
    if (!this.o.userAgent || this.o.userAgent.length < 10) return { ok: false, reason: "bad_user_agent" };
    return { ok: true, u, rule };
  }
  // With a resolver: every answer must be public. Without one, only allowlisted hostnames can be fetched (above).
  private async publicDns(host: string): Promise<boolean> {
    if (!this.o.resolver) return true;
    try { const ips = await this.o.resolver(host); return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip)); } catch { return false; }
  }
  // Serialized per host: concurrent callers queue, each waits out the gap since the previous request.
  private pace(host: string, rule: SiteRule, crawlDelayS: number): Promise<void> {
    const gap = Math.max(rule.min_delay_ms ?? 2000, crawlDelayS * 1000);
    const run = async () => {
      const prev = this.last.get(host);
      if (prev != null) { const wait = prev + gap - this.now().getTime(); if (wait > 0) await this.sleep(wait); }
      this.last.set(host, this.now().getTime());
    };
    const next = (this.queue.get(host) ?? Promise.resolve()).then(run, run);
    this.queue.set(host, next.catch(() => {}));
    return next;
  }
  private async getRobots(u: URL, rule: SiteRule): Promise<Robots | "unavailable"> {
    const cached = this.robots.get(u.host); if (cached) return cached;
    let out: Robots | "unavailable";
    try {
      await this.pace(u.host, rule, 0);
      const r = await this.o.fetcher(`https://${u.host}/robots.txt`, { headers: { "User-Agent": this.o.userAgent, Accept: "text/plain" }, redirect: "manual" });
      const sameHost = (() => { try { return new URL(r.url).host === u.host; } catch { return false; } })();
      if (r.status === 200 && sameHost) out = parseRobots(r.text, this.o.robotsToken ?? this.o.userAgent.split(/[\s/]/)[0]);
      else if (r.status === 404 || r.status === 410) out = { rules: [], crawlDelayS: 0 };
      else out = "unavailable"; // 3xx/401/403/429/5xx: cannot tell, so do not crawl
    } catch { out = "unavailable"; }
    this.robots.set(u.host, out); return out;
  }
  async fetchText(url: string, hop = 0): Promise<GateResult> {
    const pre = this.precheck(url); if (!pre.ok) return hop ? { ok: false, reason: "redirect_denied", detail: `${pre.reason}${pre.detail ? ":" + pre.detail : ""}` } : pre;
    const { u, rule } = pre;
    if (!(await this.publicDns(u.hostname))) return { ok: false, reason: "private_address", detail: u.hostname };
    const rb = await this.getRobots(u, rule);
    if (rb === "unavailable") return { ok: false, reason: "robots_unavailable" };
    if (!robotsAllows(rb, u.pathname + u.search)) return { ok: false, reason: "robots_disallow" };
    await this.pace(u.host, rule, rb.crawlDelayS);
    let r: FetchResult;
    try { r = await this.o.fetcher(u.toString(), { headers: { "User-Agent": this.o.userAgent, Accept: "text/html,application/xhtml+xml,application/json,application/xml;q=0.9" }, redirect: "manual" }); }
    catch (e) { return { ok: false, reason: "fetch_error", detail: String((e as Error)?.message ?? e).slice(0, 120) }; }
    if (r.status >= 300 && r.status < 400) {
      if (hop >= (this.o.maxHops ?? 3)) return { ok: false, reason: "too_many_redirects" };
      let next: URL; try { next = new URL(r.location ?? "", u); } catch { return { ok: false, reason: "redirect_denied", detail: "bad location" }; }
      return this.fetchText(next.toString(), hop + 1); // the hop goes through the same gate, robots included
    }
    let fu: URL; try { fu = new URL(r.url || url); } catch { fu = u; }
    if (fu.host !== u.host || fu.protocol !== "https:") { const p = this.precheck(fu.toString()); return { ok: false, reason: "redirect_denied", detail: p.ok ? `off host ${fu.host}` : String(p.reason) }; }
    if (r.status === 401 || r.status === 403 || LOGIN_PATH.test(fu.pathname + fu.search) && !LOGIN_PATH.test(u.pathname)) return { ok: false, reason: "login_wall", detail: String(r.status) };
    if (r.status < 200 || r.status >= 300) return { ok: false, reason: "http_error", detail: String(r.status) };
    if (LOGIN_BODY.test(r.text)) return { ok: false, reason: "login_wall", detail: "password field" };
    return { ok: true, text: r.text, final_url: fu.toString(), retrieved_at: this.now().toISOString(), rule };
  }
}
