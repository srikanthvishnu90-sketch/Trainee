// R10 WO-E live-page fixtures: one fictional feed in the shape trainee-file/handler.ts passes renderResults (every row kind it draws).
import type { ResultRow, ResultsFeed } from "../../supabase/functions/_shared/results_page.ts";
import { role, TOKEN } from "./r10-files-fixtures.ts";

export const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const rows = (): ResultRow[] => [
  role(1, { rid: "R-01", payShown: "$85-98k", payGroup: "meets", why: ["matches your process-rollout record."] }),
  role(2, { rid: "R-02", restriction: "Location restriction", blocked: "your state may be excluded" }),
  role(3, { rid: "R-03", company: "Example Carbon Co", url: "https://jobs.lever.co/examplecarbon/cc-2214", tag: "0123456789abcdef", send: [{ label: "Resume", value: "Operations v3" }] }),
  role(4, { rid: "R-04", company: "Example Carbon Co", url: "https://jobs.lever.co/examplecarbon/cc-2290", tag: "fedcba9876543210", openQs: 2, guide: "2 questions need your answer first",
    send: [{ label: "Earliest start", value: "", needs: true }] }),
  role(5, { rid: "R-05", company: "Example Grid Co", url: "https://example-grid.com/careers/fo-12", byHand: true }),
  role(6, { rid: "R-06", status: { word: "preparing", detail: "Getting it ready." }, guide: "Getting your application ready. Nothing has been sent." }),
  role(7, { rid: "R-07", status: { word: "queued", detail: "Approved and queued." }, inApps: true }),
] as ResultRow[];
export const feed = (o: Partial<ResultsFeed> = {}): ResultsFeed => {
  const all = rows(), dismissed = [role(8, { rid: "R-08", title: "Dismissed Role" }) as ResultRow];
  return { token: TOKEN, title: "Climate operations roles", floor: "$80k/yr", rows: all, total: all.length, filters: { pay: "any", where: "" }, places: ["Austin, TX", "US remote"],
    countRows: all, coverRows: [...all, ...dismissed], dismissed, madeFor: "Made for Sam · Nov 9", stamp: "Postings checked Nov 9, 9:12 AM CT", caveat: "Pay is shown only where the posting lists it.",
    quick: ["Best match: Customer Operations Specialist at Example Solar Co."], top: "1 of 1 approved and queued.", notes: { ref3: "Approved and queued." }, updated: "9:45 AM",
    all: { hash: HASH, size: 2, filtered: false }, ...o };
};

