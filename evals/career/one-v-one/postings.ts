// 1v1 (2026-11-01): the postings every scenario's world holds. The first seven are the in-flight world's
// (evals/career/worlds/in-flight.json); the last four are SYNTHETIC additions so the SWE, IB and marketing asks have a real
// posting to name. Job ids are made up; nothing here is a real opening.
const GH = "https://job-boards.greenhouse.io";
export const URL = {
  stripe: `${GH}/stripe/jobs/7001001`,
  ramp: `${GH}/ramp/jobs/7002002`,
  plaid: `${GH}/plaid/jobs/7003003`,
  figma: `${GH}/figma/jobs/7004004`,
  brex: `${GH}/brex/jobs/7005005`,
  airtable: `${GH}/airtable/jobs/7006006`,
  notion: `${GH}/notion/jobs/7007007`,
  stripeIntern: `${GH}/stripe/jobs/7008008`,
  datadog: `${GH}/datadog/jobs/7009009`,
  evercore: `${GH}/evercore/jobs/7010010`,
  notionMkt: `${GH}/notion/jobs/7011011`,
} as const;

const at = "2026-10-18T14:00:00Z", seen = "2026-10-18T15:00:00Z";
export const EXTRA_POSTINGS = [
  { job_id: "greenhouse:stripe:7008008", company: "Stripe", title: "Software Engineer Intern, Summer 2027", location: "Chicago, IL", url: URL.stripeIntern,
    description: "Stripe Software Engineer Intern for Summer 2027 in Chicago. Java, Python or Go. $50-$55/hour.", posted_at: at, first_seen_at: seen },
  { job_id: "greenhouse:datadog:7009009", company: "Datadog", title: "Software Engineer, New Grad 2027", location: "New York, NY", url: URL.datadog,
    description: "Datadog Software Engineer, New Grad 2027, New York. Go, Python, distributed systems. $130,000-$150,000.", posted_at: at, first_seen_at: seen },
  { job_id: "greenhouse:evercore:7010010", company: "Evercore", title: "Investment Banking Summer Analyst 2027", location: "New York, NY", url: URL.evercore,
    description: "Evercore Investment Banking Summer Analyst 2027, New York. Finance, accounting or economics majors.", posted_at: at, first_seen_at: seen },
  { job_id: "greenhouse:notion:7011011", company: "Notion", title: "Marketing Coordinator", location: "Remote - US", url: URL.notionMkt,
    description: "Notion Marketing Coordinator, remote in the US. Campaigns, social, 1+ years. $60,000-$70,000.", posted_at: at, first_seen_at: seen },
];
export const ALLOWED_LINKS = new Set<string>(Object.values(URL));

// What the world states: every company with a posting in it, and every posting's text (the source of any pay figure).
import WORLD_FILE from "../worlds/in-flight.json" with { type: "json" };
const ALL = [...(WORLD_FILE as any).postings, ...EXTRA_POSTINGS];
export const WORLD_COMPANIES: string[] = [...new Set(ALL.map((p: any) => String(p.company)))];
export const WORLD_PAY_TEXT: string = ALL.map((p: any) => p.description).join("\n");
export const WORLD_LINKS: string[] = ALL.map((p: any) => String(p.url));
