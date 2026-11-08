// R9 OUTREACH SAFETY (2026-11-08): an address no person reads, or one that is not the employer's own person. Outreach is
// written to a person; it is never drafted to, approved for, queued for, or sent to:
//   - a no-reply or automation sender: no-reply@, noreply@, do-not-reply@, donotreply@, notifications@, notify@, alerts@,
//     mailer@, mailer-daemon@, bounce(s)@, automated@ (with a +tag dropped, and with a qualifier such as
//     "no-reply.jobs@" or "notifications-eu@"), on any domain;
//   - a role inbox (career_contacts.ts isRoleAddress: careers@, jobs@, recruiting-team@, ...), on any domain;
//   - any address on an applicant tracking system's or a job board's domain, a subdomain included
//     (no-reply@us.greenhouse-mail.io, notifications@hire.lever.co, someone@ashbyhq.com, jobs@smartrecruiters.com),
//     UNLESS that system is the person's own employer: maya@linkedin.com for a contact at LinkedIn, dana@workday.com for
//     one at Workday, is a person (architect review of #607). The employer is the contact's company as stored on the row,
//     the draft or the connector's result; an address is on the employer's own domain when its registrable label is the
//     company's name as a domain label ("LinkedIn" linkedin.com, "Workday" workday.com; never myworkdayjobs.com or
//     greenhouse-mail.io, the systems' candidate-mail domains). With no employer known, the domain is refused (fail closed).
//     A no-reply or role inbox is refused on every domain, the employer's own included.
// One predicate, used where an address is chosen (the contact checks, the people connector, drafting) and again at the
// sending rail's last check before an email goes (queueApproved, sendOne), so a row stored before this rule or a path
// that skipped the first check still never sends.
import { isRoleAddress } from "./career_contacts.ts";
import { domainLabelOf, registrable } from "./career_people_gmail.ts";

// Application systems (and their candidate-mail domains) and scheduling tools that send for them.
export const ATS_DOMAINS: readonly string[] = [
  "greenhouse.io", "greenhouse-mail.io", "lever.co", "ashbyhq.com", "myworkday.com", "myworkdayjobs.com", "workday.com",
  "smartrecruiters.com", "icims.com", "taleo.net", "successfactors.com", "successfactors.eu", "jobvite.com", "workablemail.com",
  "workable.com", "bamboohr.com", "avature.net", "breezy.hr", "recruitee.com", "jazzhr.com", "applytojob.com", "paylocity.com",
  "ultipro.com", "eightfold.ai", "phenompeople.com", "brassring.com", "teamtailor.com", "pinpointhq.com",
  "dayforcehcm.com", "gem.com", "goodtime.io", "gupy.io", "welcomekit.co", "softgarden.io", "modernloop.io", "prelude.co", "paradox.ai",
];
// Job boards and marketplaces: a person there is never reached by mail to the board.
export const JOB_BOARD_DOMAINS: readonly string[] = [
  "linkedin.com", "indeed.com", "indeedemail.com", "glassdoor.com", "ziprecruiter.com", "joinhandshake.com", "handshake.com", "wellfound.com",
  "angel.co", "monster.com", "dice.com", "simplyhired.com", "careerbuilder.com", "builtin.com", "otta.com", "hired.com",
  "upwork.com", "fiverr.com", "freelancer.com",
];
const AUTOMATION_WORDS = new Set(["noreply", "donotreply", "dontreply", "notifications", "notification", "notify", "notifier", "alerts", "alert",
  "mailer", "mailerdaemon", "postmaster", "bounce", "bounces", "automated", "automailer", "autoreply", "daemon", "unsubscribe"]);
const AUTOMATION_RUN = /^(?:no-?reply|do-?not-?reply|dont-?reply|donotreply|noreply)(?:$|[._+-])/;

const onDomain = (domain: string, list: readonly string[]) => list.some((d) => domain === d || domain.endsWith("." + d));
export const isAtsOrBoardDomain = (domain: unknown) => {
  const d = String(domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
  return !!d && (onDomain(d, ATS_DOMAINS) || onDomain(d, JOB_BOARD_DOMAINS));
};

export type AutomatedWhy = "no_reply" | "role_inbox" | "ats_domain";
// The address's domain is the employer's own: its registrable label is the company's name as a domain label.
export function employersOwnDomain(domain: string, employer: unknown): boolean {
  const name = String(employer ?? "").trim();
  if (!name) return false;
  const label = registrable(domain).label.replace(/[^a-z0-9]/g, ""), key = domainLabelOf(name);
  return label.length >= 2 && label === key;
}
// Why this address is never written to, or null when it may be a person's. `employer`: the contact's company, when known.
export function automatedInbox(email: unknown, employer?: unknown): AutomatedWhy | null {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return null;
  const local = e.slice(0, at).replace(/\+.*$/, ""), domain = e.slice(at + 1);
  if (AUTOMATION_RUN.test(local)) return "no_reply";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (AUTOMATION_WORDS.has(local.replace(/[._-]+/g, "")) || parts.some((p) => AUTOMATION_WORDS.has(p))) return "no_reply";
  if (isRoleAddress(e)) return "role_inbox";
  if (isAtsOrBoardDomain(domain) && !employersOwnDomain(domain, employer)) return "ats_domain";
  return null;
}
export const isAutomatedInbox = (email: unknown, employer?: unknown) => automatedInbox(email, employer) !== null;
// What the person is told when a contact is held for this.
export const AUTOMATED_WHY: Record<AutomatedWhy, string> = {
  no_reply: "is an automated no-reply sender, not a person",
  role_inbox: "is a shared inbox, not a person",
  ats_domain: "is an application system's or job board's address, not a person at the employer",
};
