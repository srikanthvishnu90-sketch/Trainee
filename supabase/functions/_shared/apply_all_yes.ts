// "Reply yes and I'll apply to all N shown" (owner, 2026-11-02 17:10 CT): the mass-apply flow's one-word approval.
//
// The results message (role_results.ts, on every channel) ends with a plain question and records, in that assistant turn's meta, an
// OFFER: the results list's id and, for each role shown, its ref, job id and the application tag (the first 16 hex of the payload
// hash) it had when it was offered, or no tag when it was not prepared yet. A bare yes ("yes", "yep", "do it", "apply to all",
// "send them all") on the very next user turn, while that offer is the thread's last assistant word and is no older than the
// text-yes window (YES_WINDOW_MS, the same 10 minutes the card's yes uses), approves exactly those roles, and only those:
//   - a role that was prepared when offered goes through tapJob's Confirm, the same hash-bound path as the page's Apply and
//     Telegram's Confirm button (duplicate guard, tag-changed refusal, posting screen, unsendable payload, paused account, and the
//     queue's own pace limits and cloud-runner opt-in rules, which live behind that door). A role whose application changed since
//     the offer is refused: the yes never approves a payload that was not the one offered;
//   - a role that was NOT prepared when offered is never approved by this yes (nobody saw its payload). It is queued to be
//     prepared (what the page's Apply does on such a card) and listed as getting ready; a role with open employer questions is
//     not queued and is listed as needing an answer (the handler then asks the first, one at a time);
//   - a role the person dismissed on the page, or any role while the page is paused ("Pause on this page"), is left out.
// A yes with no live offer (none, stale, spent, or not the thread's last word) returns null and the turn goes on exactly as before.
// The reply states only counts taken from what each tap returned (apply_status_summary.ts: "approved", never "applied"). The
// offer is spent by this turn: its reply carries `apply_all_done`, not the offer, so a second yes approves nothing new (and the
// duplicate guard would refuse it anyway). This module sends nothing itself; the person's worker claims and finishes.
import { hashTag, tapJob, type JobDeps, type JobSender, type JobView, type ListMeta } from "./telegram_jobs.ts";
import { YES_WINDOW_MS } from "./career_apply_cards.ts";
import { type ApplySummary, applySummary } from "./apply_status_summary.ts";
import type { OpenQuestion } from "./career_apply_questions.ts";

export const APPLY_ALL_INTENT = "career_apply_all_yes";
export const OFFER_WINDOW_MS = YES_WINDOW_MS;
export const OFFER_MAX = 25;

export interface OfferJob { ref: string; job_id: string; tag: string | null }
export interface ApplyAllOffer { v: 1; list: string; at: number; jobs: OfferJob[] }

const TAG = /^[0-9a-f]{16}$/, REF = /^[0-9a-f]{12}$/, LIST = /^[0-9a-f]{10}$/;

// The offer to record, from the roles shown: each role's tag is the one its page card shows (null: not prepared, or its prepared
// payload has no usable hash).
export function offerOf(o: { list: string; at: number; jobs: { ref: string; job_id: string; payload_hash?: string | null }[] }): ApplyAllOffer {
  return { v: 1, list: o.list, at: o.at, jobs: o.jobs.slice(0, OFFER_MAX).map((j) => {
    const tag = j.payload_hash ? hashTag(j.payload_hash) : null;
    return { ref: j.ref, job_id: j.job_id, tag: tag && TAG.test(tag) ? tag : null };
  }) };
}
// The question that ends the results message. "Apply to all" only when something is ready to approve; otherwise what a yes really does.
export function offerQuestion(offer: ApplyAllOffer): string {
  const n = offer.jobs.length, ready = offer.jobs.filter((j) => j.tag).length;
  if (n === 1) return ready ? "Reply yes and I'll apply to it." : "Reply yes and I'll start getting it ready to apply.";
  if (ready === n) return `Reply yes and I'll apply to all ${n} shown.`;
  return ready ? `Reply yes and I'll apply to the ${ready} prepared so far and get the other ${n - ready} ready.` : `Reply yes and I'll start getting all ${n} shown ready to apply.`;
}
export function readOffer(meta: Record<string, unknown> | null | undefined): ApplyAllOffer | null {
  const o = meta?.apply_all_offer as Partial<ApplyAllOffer> | undefined;
  if (!o || o.v !== 1 || typeof o.list !== "string" || !LIST.test(o.list) || !Number.isFinite(o.at) || !Array.isArray(o.jobs) || !o.jobs.length) return null;
  const jobs: OfferJob[] = [];
  for (const j of o.jobs.slice(0, OFFER_MAX)) {
    if (!j || typeof j.ref !== "string" || !REF.test(j.ref) || typeof j.job_id !== "string" || !j.job_id) return null;
    jobs.push({ ref: j.ref, job_id: j.job_id, tag: typeof j.tag === "string" && TAG.test(j.tag) ? j.tag : null });
  }
  return { v: 1, list: o.list, at: Number(o.at), jobs };
}

// A bare affirmative, and nothing more: "yes", "yep", "yeah please", "do it", "go ahead", "apply to all (of them)", "send them all".
// A yes with anything else on it ("yes but not Acme", "yes except 2", "yes and ...") is not this: it approves nothing.
const FILLER = "(?:\\s+(?:please|pls|thanks|thank you|now|then))*";
const YES = new RegExp(`^(?:(?:yes|yep|yeah|yea|yup|ya|y|sure|ok|okay|absolutely|definitely)(?:\\s+(?:please|do it|go ahead|apply|apply to all(?: of them)?|apply to them all|send them(?: all)?|send all|that works))?|do it|go ahead|go for it|please do|sounds good|apply to all(?: of them)?|apply to them all|send them all|send all of them|send all|apply to all of those)${FILLER}$`);
export function isApplyAllYes(message: string): boolean {
  const t = String(message ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[!.\s]+$/g, "").replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= 60 && YES.test(t);
}

export interface ApplyAllResult {
  reply: string; status: string; intent: typeof APPLY_ALL_INTENT;
  // Meta for the reply: the spent offer's record, the counts' source, and (only when the offer could not be read at all) the offer again.
  meta: Record<string, unknown>;
  summary: ApplySummary;
  // What the handler still has to ask, one at a time (a model-written question, never code's): a profile need that stops roles from
  // being prepared, and/or the employer's open questions.
  asks: { questions: number; unprepared: number };
  counts: { approved: number; already: number; changed: number; blocked: number; failed: number; ready_since: number; getting_ready: number; needs_info: number; left_out: number };
}
export interface ApplyAllDeps {
  message: string; userId: string; now: number;
  last: { intent: string | null; meta: Record<string, unknown> } | null; // the thread's last assistant reply
  deps: JobDeps;
  questions?: { open(userId: string, limit: number): Promise<OpenQuestion[]> };
  prepare?: (userId: string) => Promise<"started" | "failed" | "off" | "skipped">; // career_hosted_prepare.ts reprepareQueued
}

const sink = (said: string[]): JobSender => ({ photo: async () => ({ ok: true }), text: async (a) => { said.push(a.text); return { ok: true, id: null }; } });
const names = (xs: string[]) => { const u = [...new Set(xs.filter(Boolean))]; return u.length <= 4 ? u.join(", ") : `${u.slice(0, 4).join(", ")} and ${u.length - 4} more`; };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const who = (j: JobView | null) => j ? (j.company || j.title || "a role") : "a role";

export async function applyAllYesTurn(o: ApplyAllDeps): Promise<ApplyAllResult | null> {
  if (!isApplyAllYes(o.message)) return null;
  const offer = readOffer(o.last?.meta);
  if (!offer) return null; // no live offer: this yes is nothing new, the turn goes on as before
  if (!(o.now >= offer.at && o.now - offer.at <= OFFER_WINDOW_MS)) return null;
  const { deps, userId } = o;
  const counts = { approved: 0, already: 0, changed: 0, blocked: 0, failed: 0, ready_since: 0, getting_ready: 0, needs_info: 0, left_out: 0 };
  const done = (reply: string, status: string, extra: Partial<ApplyAllResult["asks"]> = {}, keepOffer = false): ApplyAllResult => {
    const summary = applySummary([], { prepared: 0 });
    return { reply, status, intent: APPLY_ALL_INTENT, summary, counts, asks: { questions: 0, unprepared: 0, ...extra },
      meta: keepOffer ? { apply_all_offer: offer } : { apply_all_done: { list: offer.list, at: o.now, ...counts } } };
  };
  // The list and the person's own marks on its page. Unreadable or gone: fail closed, nothing approved.
  let refs: string[] | null, meta: ListMeta | null = null;
  try {
    refs = await deps.store.recallList(userId, offer.list);
    if (deps.store.recallListMeta) meta = await deps.store.recallListMeta(userId, offer.list);
  } catch {
    return done("I couldn't read that list just now, so nothing was approved. Say yes again in a minute.", "unreadable", {}, true);
  }
  if (!refs || (deps.store.recallListMeta && !meta)) return done("That list isn't available any more, so nothing was approved.", "gone");
  if (meta?.paused) {
    counts.left_out = offer.jobs.length;
    return done("That list is paused on its page, so nothing was approved or started from it. Resume it there, or say yes again after.", "paused");
  }
  const onList = new Set(refs), dismissed = new Set(meta?.dismissed ?? []);
  const approved: string[] = [], already: string[] = [], changed: string[] = [], blocked: string[] = [], failed: string[] = [], readySince: string[] = [],
    gettingReady: string[] = [], needsInfo: string[] = [], leftOut: string[] = [];
  const open = o.questions ? await o.questions.open(userId, 500).catch(() => null) : null;
  const toPrepare: JobView[] = [];
  let kicked: "started" | "failed" | "off" | "skipped" | "none" = "none";
  for (const j of offer.jobs) {
    const got = onList.has(j.ref) ? await deps.store.recall(userId, j.ref).catch(() => null) : null;
    const job = got?.job ?? null, name = who(job);
    if (dismissed.has(j.ref)) { leftOut.push(name); continue; }
    if (!job || job.job_id !== j.job_id) { blocked.push(name); continue; } // not on the list any more, or not the posting that was offered
    if (j.tag) {
      // Prepared when offered: the hash-bound approval of exactly that application.
      const said: string[] = [];
      const r = await tapJob({ userId, data: `jcy:${j.ref}:${j.tag}`, messageId: null, deps, send: sink(said) }).catch(() => null);
      const st = r?.status ?? "failed";
      if (st === "confirmed") approved.push(name);
      else if (st === "duplicate") already.push(name);
      else if (st === "changed") changed.push(name);
      else if (st === "failed") failed.push(name);
      else blocked.push(name);
      continue;
    }
    // Not prepared when offered: never approved by this yes.
    if (await deps.store.applied(userId, job.job_id).catch(() => false) || (deps.store.elsewhere && await deps.store.elsewhere(userId, job).catch(() => false))) { already.push(name); continue; }
    const prepNow = await deps.store.prepared(userId, job.job_id).catch(() => null);
    if (prepNow) { readySince.push(name); continue; }
    if (open && open.some((q) => q.job_ids.includes(job.job_id))) { needsInfo.push(name); continue; }
    const w = await deps.store.want(userId, job, deps.now()).catch(() => ({ result: "refused" as const }));
    if (w.result === "refused") { blocked.push(name); continue; }
    gettingReady.push(name); toPrepare.push(job);
  }
  if (toPrepare.length && o.prepare) kicked = await o.prepare(userId).catch(() => "failed" as const);
  Object.assign(counts, { approved: approved.length, already: already.length, changed: changed.length, blocked: blocked.length, failed: failed.length,
    ready_since: readySince.length, getting_ready: gettingReady.length, needs_info: needsInfo.length, left_out: leftOut.length });

  const L: string[] = [];
  if (approved.length) L.push(`Approved and queued ${plural(approved.length, "application", "applications")}, each exactly as it was prepared: ${names(approved)}.`);
  else L.push("Nothing was approved.");
  if (already.length) L.push(`${names(already)} ${already.length === 1 ? "was" : "were"} already in your applications, so nothing more was queued for ${already.length === 1 ? "it" : "them"}.`);
  if (changed.length) L.push(`${names(changed)} changed after I offered ${changed.length === 1 ? "it" : "them"}, so I didn't approve ${changed.length === 1 ? "it" : "them"}; open the list to check the new version.`);
  if (blocked.length) L.push(`${names(blocked)} can't be approved right now, so nothing was queued for ${blocked.length === 1 ? "it" : "them"}.`);
  if (failed.length) L.push(`I couldn't open the approval for ${names(failed)} just now, so nothing was queued for ${failed.length === 1 ? "it" : "them"}. Use Apply on the list to try again.`);
  if (readySince.length) L.push(`${names(readySince)} got ready after I offered ${readySince.length === 1 ? "it" : "them"}, so I left ${readySince.length === 1 ? "it" : "them"} for you to check on the list first.`);
  if (gettingReady.length) L.push(`${plural(gettingReady.length, "role is", "roles are")} getting ready (${names(gettingReady)}); ${kicked === "started" || kicked === "none" ? "nothing is sent for them until you see and approve what's prepared" : "preparing hasn't started yet, so they wait in your queue; nothing is sent for them"}.`);
  if (needsInfo.length) L.push(`${names(needsInfo)} ${needsInfo.length === 1 ? "needs" : "need"} an answer from you first, so none of ${needsInfo.length === 1 ? "that one was" : "those were"} queued.`);
  if (leftOut.length) L.push(`${plural(leftOut.length, "role", "roles")} you dismissed on the list ${leftOut.length === 1 ? "was" : "were"} left out.`);
  const res = done(L.join(" "), approved.length ? (approved.length === offer.jobs.length ? "approved" : "partial") : "none", { questions: needsInfo.length, unprepared: gettingReady.length + blocked.length });
  // Counts from the taps' own results: approved rows are "approved" (queued); what is prepared but not approved is "prepared".
  res.summary = applySummary(approved.map(() => ({ state: "queued" })), { prepared: changed.length + readySince.length + blocked.length + failed.length });
  res.meta = { apply_all_done: { list: offer.list, at: o.now, ...counts }, apply_summary: res.summary };
  return res;
}
