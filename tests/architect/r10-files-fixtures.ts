// R10 WO-E fixtures: fictional content only (the spec's own specimen names, "Example ... Co"), never a real person or employer.
// The clock and zone are inputs, so every time on a page is deterministic.
import type { ShortRole, ShortlistInput } from "../../supabase/functions/_shared/file_family_roles.ts";

export const NOW = Date.parse("2026-11-09T15:45:00Z"); // 9:45 AM in Chicago
export const TZ = "America/Chicago";
export const CTX = { now: NOW, tz: TZ };
export const TOKEN = "fs1." + "a".repeat(64);

const job = (n: number, company: string, title: string, url: string, o: Partial<ShortRole["job"]> = {}) => ({
  job_id: `greenhouse:example:${n}`, company, title, location: "US remote", url, pay: null, level: null, remote: "remote" as const, posted_at: "2026-11-05T14:00:00Z",
  first_seen_at: "2026-11-05T15:00:00Z", deadline: null, source: "Greenhouse", reasons: [], gaps: [], company_domain: null, ...o,
});
export function role(n: number, o: Partial<ShortRole> & { company?: string; title?: string; url?: string; gaps?: string[] } = {}): ShortRole {
  const { company = "Example Solar Co", title = "Customer Operations Specialist", url = `https://boards.greenhouse.io/examplesolar/jobs/${4000 + n}`, gaps = [], ...rest } = o;
  return {
    ref: `ref${n}`, job: job(n, company, title, url, { gaps }), logo: null, snippet: "", full: null, status: null, tag: null, resume: "Operations v3", byHand: false,
    payShown: null, payGroup: "unlisted", payNote: null, payConv: null, place: "US remote", checkedAt: "2026-11-09T15:12:00Z", ...rest,
  } as ShortRole;
}
// The spec's F-05 specimen (C.7) plus Example 2's internship additions (student window, uncertain line) and the honest edge cases:
// a blocked role, a prepared role, a role applied by hand, a role whose check time is not on file, and a target with no opening.
export function shortlist(): ShortlistInput {
  return {
    token: TOKEN, title: "Climate operations roles", review: "review v1", updatedAt: "2026-11-09T15:40:00Z", sourcesChecked: "9 boards + employer pages", back: "/f",
    rows: [
      role(1, { payShown: "$85-98k", payGroup: "meets", why: ["Matches your process-rollout record."], gaps: ["Energy-sector experience preferred, not required."] }),
      role(2, { title: "Program Operations Associate with a deliberately long title that has to wrap on a phone screen", place: "US remote - excludes 3 states", blocked: "your state may be excluded by this posting's location rules." }),
      role(3, { company: "Example Carbon Co", title: "Operations Associate", url: "https://jobs.lever.co/examplecarbon/cc-2214", payShown: "$80-90k", payGroup: "meets", tag: "0123456789abcdef", why: ["Uses your confirmed scheduling-tool rollout."],
        send: [{ label: "Resume", value: "Operations v3" }, { label: "Where it goes", value: "jobs.lever.co" }, { label: "Earliest start", value: "", needs: true }] }),
      role(4, { company: "Example Carbon Co", title: "Data Operations Intern, Summer 2027", url: "https://jobs.lever.co/examplecarbon/cc-2290", window: "Enrolled undergraduate graduating Dec 2027 to June 2028",
        uncertain: "The posting does not say whether remote interns outside the US are accepted.", checkedAt: null }),
      role(5, { company: "Example Grid Co", title: "Field Operations Coordinator", url: "https://example-grid.com/careers/fo-12", byHand: true, why: ["Field coordination matches your confirmed logistics work."] }),
    ],
    targets: [{ company: "Example Climate Lab", note: "Fits your niche.", watch: { label: "Watch openings", effect: "decide", href: "?watch=example-climate-lab" } }],
  };
}
