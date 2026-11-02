// "I want X roles that pay $Y" on a texting channel (owner, 2026-11-01): the matches go into a hosted results page (the jobs
// list file, trainee-file), the chat gets a short answer and the link. The page's Apply shows the exact application for approval
// and approves through the same code-enforced path as every other Apply (trainee-file/handler.ts).
//
// The list is written here, by code, from the search's own rows: ordered by fit (career_search.ts ranks by fit to CONFIRMED
// facts), roles whose listed pay reaches the floor first, then the roles that list no pay (a separate group, never counted as
// meeting it). A role whose listed pay is below the floor is not on the list. Nothing about pay is invented.
import { jobViewOf, refOf, type JobStore, type ListMeta, type PostingRow } from "./telegram_jobs.ts";
import { type Floor, parsePay, type Pay, payGroup, payText, resultsReply, type What } from "./role_pay.ts";
import type { SearchHit } from "./career_search.ts";
import type { SourcePosting } from "./career_search_judge.ts";
import type { Limits } from "./posting_constraints.ts";

export const RESULTS_MAX = 25;
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// What the person asked for, in their words' shape: "frontend internship(s)", "data analyst role(s)", "... in Chicago", "remote ...".
export function whatOf(ask: { role: string; place: string | null; remote: boolean; remoteOnly?: boolean; limits?: Limits }): What {
  const role = ask.role.replace(/\s+(roles?|jobs?|openings?|positions?)$/i, "").trim();
  const bands = ask.limits?.bands ?? [];
  const noun = bands.includes("intern") ? ["internship", "internships"] : bands.includes("new_grad") ? ["new grad role", "new grad roles"] : ["role", "roles"];
  const pre = ask.remoteOnly ? "remote " : "";
  const where = ask.place ? ` in ${ask.place}${ask.remote && !ask.remoteOnly ? " or remote" : ""}` : "";
  return { one: `${pre}${role} ${noun[0]}${where}`.replace(/\s+/g, " ").trim(), many: `${pre}${role} ${noun[1]}${where}`.replace(/\s+/g, " ").trim() };
}

export interface Picked { hit: SearchHit; posting: SourcePosting | null }
export async function resultsFile(o: {
  userId: string; now: number; what: What; floor: Floor | null; picked: Picked[]; store: JobStore;
  name?: string | null; source?: "live" | "snapshot" | null; read?: string | null;
  links: (userId: string, listId: string) => Promise<{ url: string | null }>;
}): Promise<{ reply: string; listId: string; url: string; meets: number; unlisted: number; unchecked: number; otherCurrency: number; noPeriod: number; below: number } | null> {
  if (!o.store.rememberListMeta) return null;
  const meets: Picked[] = [], unlisted: Picked[] = [], unchecked: Picked[] = [];
  let below = 0;
  const pays = new Map<string, Pay | null>();
  for (const p of o.picked) {
    const pay = parsePay(p.posting?.pay ?? p.hit.pay, p.posting?.description);
    const g = payGroup(pay, o.floor);
    if (g === "below") { below++; continue; }
    pays.set(p.hit.job_id, pay);
    (g === "meets" ? meets : g === "unchecked" ? unchecked : unlisted).push(p);
  }
  const ordered = [...meets, ...unchecked, ...unlisted].slice(0, RESULTS_MAX);
  if (!ordered.length) return null;
  const refs: string[] = [], boards = new Set<string>();
  for (const p of ordered) {
    // A live-board posting is a whole career_postings row (remote, level, provider, its own posted date); a snapshot one is not.
    const live = (p.posting ?? {}) as Partial<PostingRow>;
    const row: PostingRow = { job_id: p.hit.job_id, provider: live.provider ?? null, company: p.posting?.company ?? p.hit.company, title: p.posting?.title ?? p.hit.title, location: p.posting?.location ?? p.hit.location,
      url: p.posting?.url ?? p.hit.url, description: p.posting?.description ?? null, remote: live.remote ?? null, seniority_band: live.seniority_band ?? null, posted_at: live.posted_at ?? null,
      first_seen_at: p.posting?.first_seen_at ?? p.hit.first_seen_at, pay: p.posting?.pay ?? null, company_domain: live.company_domain ?? null };
    const pay = pays.get(p.hit.job_id) ?? null;
    const view = { ...jobViewOf(p.hit, row), pay: pay ? payText(pay) : null, pay_parsed: pay };
    const ref = await refOf(o.userId, view.job_id);
    await o.store.remember(o.userId, ref, view, "text");
    boards.add(String(view.source ?? row.provider ?? view.job_id.split(":")[0]).toLowerCase());
    refs.push(ref);
  }
  const listId = (await hex(`${o.userId}|results|${refs.join(",")}|${o.now}`)).slice(0, 10);
  await o.store.rememberList(o.userId, listId, refs);
  const name = String(o.name ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "").slice(0, 40) || null;
  const meta: ListMeta = { kind: "results", what: o.what.many, floor: o.floor, at: o.now, name, source: o.source ?? null, read: o.read ?? null, sources: boards.size };
  await o.store.rememberListMeta(o.userId, listId, meta);
  const { url } = await o.links(o.userId, listId);
  if (!url) return null;
  // Shown but not compared, each for its own reason: pay in another currency, or a figure with no period.
  const shownUnchecked = ordered.filter((p) => unchecked.includes(p));
  const otherCurrency = shownUnchecked.filter((p) => pays.get(p.hit.job_id)?.currency !== "USD").length;
  const counts = { meets: Math.min(meets.length, ordered.length), unchecked: shownUnchecked.length, otherCurrency, noPeriod: shownUnchecked.length - otherCurrency, unlisted: ordered.filter((p) => unlisted.includes(p)).length };
  return { reply: resultsReply({ what: o.what, floor: o.floor, meets: counts.meets, unlisted: counts.unlisted, otherCurrency: counts.otherCurrency, noPeriod: counts.noPeriod, url }), listId, url, below, ...counts };
}
