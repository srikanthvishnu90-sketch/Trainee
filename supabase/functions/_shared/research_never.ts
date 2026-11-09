// Never read, never linked (owner rule): the research never-list, kept apart from the modules that make network requests, so the
// host names it lists never sit in fetch code (tests/architect/wo-037-discovery.test.ts, WO-037/D7). research_sources.ts re-exports
// isBlockedHost; every page the research reader opens, and every link a research answer shows, passes it first.
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
