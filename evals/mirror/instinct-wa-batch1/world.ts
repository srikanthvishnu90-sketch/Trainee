// MIRROR WA-1, the test world (D-065 item 7; eval only, never product code). Live round 1 (live-5) ran batch 1 in a world with
// no SWE postings and no Gmail, so C1, C3, C6, C10, C11, C16, C18 and C20 had nothing to work on that Instinct had. This seeds the
// runner's world the way Instinct's was, from recorded public pages and the persona's fiction only:
//   postings   the benchmark's own PayPal posting (Workday, R0138586; its public CXS answer recorded byte for byte in
//              tests/fixtures/posting-reads/, served for its own URL), and the one recorded remote SWE posting (NVIDIA's OpenShell,
//              Workday, also served from its recording). Those are the recorded fixtures that are SWE roles in Chicago or remote; no
//              other is recorded, and none is invented. Every other posting host is refused and recorded, as before.
//   Gmail      a stub Gmail API for the persona's own fictional account (tests/architect/helpers/d062_world.ts fakeGmail): the
//              application confirmations Instinct read for the tester (C6), with the fictional employer names the benchmark uses
//              (evals/mirror/instinct-wa-batch1/README.md), dated inside the product's first mail read (career_proactive_run.ts
//              MAIL_FIRST_LOOKBACK_MS, three days). No real address or mailbox; nothing can be sent (every send is recorded only).
//   web reads  live runs only: the research reader's GETs of public pages (its declared TraineeBot User-Agent, research_dns.ts /
//              research_free_sources.ts) go out as they do in production. Everything else stays refused and recorded: any method
//              but GET, the boards' listing endpoints (whole-board scrapes), any application step, and the never-list (LinkedIn,
//              Indeed, Glassdoor, Handshake). A $0 run reads nothing off the machine.
import { fakeGmail, READ, SEND } from "../../../tests/architect/helpers/d062_world.ts";

const FX = new URL("../../../tests/fixtures/posting-reads/", import.meta.url);
const fx = (name: string) => Deno.readTextFileSync(new URL(name, FX));
const q = (s: string) => `$q$${s}$q$`;
const plain = (html: string) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export const PAYPAL_WD = "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
export const PAYPAL_CXS = "https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
export const NVIDIA_WD = "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825";
export const NVIDIA_CXS = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825";
// Each recorded answer, served for its own request (any reader: the search's link check, check_posting_open, get_posting).
export const RECORDED: Record<string, string> = {
  [`GET ${PAYPAL_CXS}`]: "workday-paypal-R0138586.cxs.json",
  [`GET ${NVIDIA_CXS}`]: "workday-nvidia-JR2020825.cxs.json",
};
const info = (file: string) => JSON.parse(fx(file)).jobPostingInfo ?? {};
export const POSTINGS = [
  { id: "workday:paypal.wd1/jobs:Software-Engineer-Intern---Summer-2027_R0138586", provider: "workday", board: "paypal.wd1/jobs", company: "PayPal",
    title: info("workday-paypal-R0138586.cxs.json").title ?? "Software Engineer Intern - Summer 2027", location: "Chicago, IL", url: PAYPAL_WD,
    description: plain(info("workday-paypal-R0138586.cxs.json").jobDescription) },
  { id: "workday:nvidia.wd5/nvidiaexternalcareersite:Software-Engineer--OpenShell_JR2020825", provider: "workday", board: "nvidia.wd5/NVIDIAExternalCareerSite", company: "NVIDIA",
    title: info("workday-nvidia-JR2020825.cxs.json").title ?? "Software Engineer, OpenShell", location: "Remote, US", url: NVIDIA_WD,
    description: plain(info("workday-nvidia-JR2020825.cxs.json").jobDescription) },
];

// The persona's fictional application confirmations (Instinct C6 named these employers; C16 corrected "Payroll Co" to Golf Co).
const HOUR = 3_600_000;
export const CONFIRMATIONS: { company: string; role: string; domain: string; hoursAgo: number }[] = [
  { company: "Bank A", role: "Summer Analyst", domain: "banka.example.test", hoursAgo: 60 },
  { company: "Golf Co", role: "Operations Intern", domain: "golfco.example.test", hoursAgo: 56 },
  { company: "Coffee Co", role: "Barista", domain: "coffeeco.example.test", hoursAgo: 50 },
  { company: "Grill Co", role: "Line Cook", domain: "grillco.example.test", hoursAgo: 44 },
  { company: "Gym Co", role: "Front Desk Associate", domain: "gymco.example.test", hoursAgo: 38 },
  { company: "Shirt Co", role: "Retail Associate", domain: "shirtco.example.test", hoursAgo: 30 },
  { company: "Startup Co", role: "Growth Intern", domain: "startupco.example.test", hoursAgo: 24 },
  { company: "Finance Co", role: "Finance Intern", domain: "financeco.example.test", hoursAgo: 16 },
  { company: "Apparel Co", role: "Sales Associate", domain: "apparelco.example.test", hoursAgo: 8 },
];
export const MAILBOX = "sam.rivera@example.test", TOKEN = "AT-MIRROR-WA1";

export function worldGmail(now = Date.now()) {
  const gmail = fakeGmail(TOKEN);
  for (const [i, c] of CONFIRMATIONS.entries()) {
    gmail.inbox.push({ id: `gm-wa1-${i}`, threadId: `thr-wa1-${i}`, at: now - c.hoursAgo * HOUR, from: `${c.company} Careers <careers@${c.domain}>`,
      subject: `Thank you for applying: ${c.role} at ${c.company}`, messageId: `<wa1-${i}@mail.${c.domain}>`, dkim: c.domain,
      snippet: `Hi Sam, thank you for applying to the ${c.role} role at ${c.company}. We have received your application and our team will review it.` });
  }
  return gmail;
}

// The rows: the postings, and the persona's Google grant (read and send scopes, as D-062 asks for; the token is the stub's own).
export function worldSql(userId: string): string {
  return `insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${POSTINGS.map((p) => `(${q(p.id)}, ${q(p.provider)}, ${q(p.board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, ${q(p.description)}, now() - interval '6 days', now())`).join(",\n    ")};
  insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${userId}', 'google_career', 'oauth_google_career_${userId}', '${MAILBOX}', '${READ} ${SEND}');
  select public.oauth_vault_store('oauth_google_career_${userId}', '{"access_token":"${TOKEN}","refresh_token":"RT-MIRROR-WA1","expires_at":${Date.now() + 365 * 86_400_000}}');`;
}

// Hosts never read for anyone (CLAUDE.md: never automate LinkedIn or Indeed), and the boards' whole-listing endpoints.
const NEVER = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|joinhandshake\.com|handshake\.com)$/i;
const LISTING = [
  /^boards-api\.greenhouse\.io$/i, /^api\.lever\.co$/i, /^api\.ashbyhq\.com$/i, /^api\.smartrecruiters\.com$/i,
].map((host) => ({ host, path: /\/(?:jobs|postings|job-board)\/?$/i }));
const APPLY_STEP = /\/apply(?:\/|$)|applyManually|autofillWithResume|useMyLastApplication|\/application(?:s)?(?:\/|$)/i;
// What the world does with one request, or null to leave it to the world below (which refuses and records it).
export function worldFetch(o: { live: boolean; realFetch: typeof fetch; gmail: ReturnType<typeof fakeGmail> }) {
  return async (req: Request): Promise<Response | null> => {
    const u = new URL(req.url);
    if (u.host === "gmail.googleapis.com") return await o.gmail.handle(req);
    const rec = RECORDED[`${req.method} ${u.origin}${u.pathname}`];
    if (rec) return new Response(fx(rec), { headers: { "content-type": "application/json" } });
    // Production's research reader: its own GETs of public pages, nothing else (live only).
    const reader = /^TraineeBot\//.test(req.headers.get("user-agent") ?? "");
    if (o.live && reader && req.method === "GET" && u.protocol === "https:" && !NEVER.test(u.hostname) && !APPLY_STEP.test(u.pathname)
      && !LISTING.some((l) => l.host.test(u.hostname) && l.path.test(u.pathname))) return await o.realFetch(req);
    return null;
  };
}
