// PEOPLE FINDING (D-033): which sites are which, as data only. No network code lives here (the architect's D7 scan
// reads every file that makes a request for LinkedIn and Indeed hosts; these names are matched against, never opened).
//
//   JOB_ALERT_SENDERS  the domains Handshake and Indeed send their alert emails from, for matching an email's From
//                      header (career_people_gmail.ts). Indeed: indeed.com, indeedemail.com, indeedmail.com (its help
//                      page "How to verify emails from Indeed"); Handshake: joinhandshake.com and its subdomains ("About
//                      Student Emails"). Gmail's own authentication result must also pass for that domain.
//   NEVER_OPEN_LABELS  the site names Trainee never opens a page on (owner rule: never automate LinkedIn or Indeed, and
//                      Handshake likewise), matched as a whole DNS label on ANY suffix and at any depth: linkedin.com,
//                      linkedin.cn, www.indeed.co.uk, indeed.jobs, lnkd.in, uk.joinhandshake.com all refuse. A look-alike
//                      that carries the label (linkedin.com.evil.io) refuses too: it fails closed.
export type JobSite = "handshake" | "indeed";
export const JOB_ALERT_SENDERS: Record<JobSite, string[]> = {
  indeed: ["indeed.com", "indeedemail.com", "indeedmail.com"],
  handshake: ["joinhandshake.com"],
};
export const NEVER_OPEN_LABELS = new Set(["linkedin", "lnkd", "licdn", "indeed", "indeedemail", "indeedmail", "joinhandshake"]);

// True when a host name is one of those sites on any suffix (every label but the last is checked).
export function neverOpen(hostname: string): boolean {
  const labels = String(hostname ?? "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  return labels.slice(0, -1).some((l) => NEVER_OPEN_LABELS.has(l));
}
