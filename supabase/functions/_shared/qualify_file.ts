// MASS APPLY (architect ruling on review rv-ma7, RESPONSE-RULES 3.1 / D-096): the answer to "apply to every <role> that I qualify
// for" with more than one posting is a File, never a list in chat. The File is the results page (role_results.ts resultsFile,
// the same mechanism as search results), marked eligibility "unchecked": each card shows the requirements its posting states,
// quoted as posted, and that they were not checked against the person; the page claims no fit. The chat text is a short summary:
// the count, "I couldn't confirm you're eligible for them", the File, and the question which to queue ("all of them", or the
// File's numbers). Nothing is queued here.
//
// The thread's list (`listed`) is returned in the File's own numbering (R-01, R-02, ... by results_spec.roleIds), and only the
// postings the File shows, so the next "all of them" queues exactly what the File shows and "1 and 3" means R-01 and R-03.
import { resultsFile, type Picked } from "./role_results.ts";
import { roleIds } from "./results_spec.ts";
import { type ManyWhat, type ShortlistEntry, statedRequirements } from "./career_apply_chat.ts";
import type { JobStore } from "./telegram_jobs.ts";

const cap = (p: string) => p.replace(/\b\w/g, (c) => c.toUpperCase());
// deno-lint-ignore no-explicit-any
const pickedOf = (rows: any[]): Picked[] => rows.filter((p) => p && p.job_id).map((p) => ({
  hit: { job_id: String(p.job_id), company: p.company ?? null, title: p.title ?? "", location: p.location ?? null, url: p.url ?? null, first_seen_at: p.first_seen_at ?? null, pay: p.pay ?? null } as any,
  posting: p, checked: null, stated: statedRequirements(p.description ?? ""),
}));

export async function qualifyFile(o: {
  userId: string; now: number; what: ManyWhat; skipped: string[]; rows: any[]; store: JobStore; name?: string | null;
  links: (userId: string, listId: string) => Promise<{ url: string | null }>;
}): Promise<{ reply: string; listed: ShortlistEntry[]; url: string; listId: string } | null> {
  const picked = pickedOf(o.rows);
  if (picked.length < 2) return null;
  const where = (o.what.places?.length ? o.what.places : o.what.place ? [o.what.place] : []).map(cap);
  const role = o.what.role || "matching";
  const made = await resultsFile({ userId: o.userId, now: o.now, what: { one: `${role} posting${where.length ? ` in ${where.join(" or ")}` : ""}`, many: `${role} postings${where.length ? ` in ${where.join(" or ")}` : ""}` },
    floor: null, picked, store: o.store, name: o.name ?? null, source: "live", read: null, links: o.links, eligibility: "unchecked" });
  if (!made?.url || !made.shown?.length) return null;
  // The File's numbers: R-01.. over the refs it shows (results_spec.roleIds); the thread's list in that order.
  const ids = roleIds(made.shown.map((x) => x.ref));
  const byJob = new Map(o.rows.map((p) => [String(p.job_id), p]));
  const order = [...made.shown].sort((a, b) => String(ids.get(a.ref)).localeCompare(String(ids.get(b.ref))));
  const listed: ShortlistEntry[] = order.map((x) => byJob.get(x.job_id)).filter(Boolean)
    .map((p) => ({ id: String(p.job_id), title: p.title ?? null, company: p.company ?? null, location: p.location ?? null, url: p.url ?? null }) as ShortlistEntry);
  const n = listed.length, more = picked.length > n ? ` (the File shows the first ${n} of ${picked.length})` : "";
  const reply = [`I found ${picked.length} open ${role} postings${where.length ? ` in ${where.join(" or ")}` : ""}${more}${o.skipped.length ? `, leaving out what you said` : ""}.`,
    `I couldn't confirm you're eligible for them: I don't decide that for you, so nothing was queued. What each one states it requires, as posted, is in this File: ${made.url}`,
    `Which should I queue? Say "all of them", or the File's numbers ("1 and 3" for R-01 and R-03).`].join("\n");
  return { reply, listed, url: made.url, listId: made.listId };
}
