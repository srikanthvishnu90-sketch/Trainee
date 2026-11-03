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
import { batchHoldBack, hashTag, screenedOut, tapJob, type JobDeps, type JobSender, type JobView, type ListMeta } from "./telegram_jobs.ts";
import { YES_WINDOW_MS } from "./career_apply_cards.ts";
import { type ApplySummary, applySummary } from "./apply_status_summary.ts";
import type { OpenQuestion } from "./career_apply_questions.ts";

export const APPLY_ALL_INTENT = "career_apply_all_yes";
export const OFFER_WINDOW_MS = YES_WINDOW_MS;
export const OFFER_MAX = 25;
// CAREER_APPLY_ALL_YES=off turns the whole feature off: no question or offer in the results message, no yes handling, and the results page
// neither shows its Apply to all button nor accepts the applyall action (agent-chat/release_config.ts applyAllYesOn is the same rule).
export const applyAllYesEnabled = (env: { get(k: string): string | undefined }): boolean => (env.get("CAREER_APPLY_ALL_YES") ?? "on").trim().toLowerCase() === "on";
// Said in the offer itself: the exact payloads are on the page, and the yes skips any with blank or sensitive answers.
const PAGE_NOTE = " Each application's exact answers are on the page; I skip any with blank or sensitive answers.";

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
  if (n === 1) return ready ? `Reply yes and I'll apply to it.${PAGE_NOTE}` : "Reply yes and I'll start getting it ready to apply.";
  if (ready === n) return `Reply yes and I'll apply to all ${n} shown.${PAGE_NOTE}`;
  return ready ? `Reply yes and I'll apply to the ${ready} prepared so far and get the other ${n - ready} ready.${PAGE_NOTE}` : `Reply yes and I'll start getting all ${n} shown ready to apply.`;
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
// D-MS-1: only these words approve. "ok", "okay", "sure", "sounds good", "absolutely", "definitely", "ya", "maybe", "yes?", a thumbs-up
// and the rest approve NOTHING.
const YES = /^(?:(?:yes|yep|yeah)(?: (?:please|do it|go ahead|apply to all(?: of them)?|send them all|approve all))?|do it|go ahead|apply to all(?: of them)?|send them all|send all|approve all)(?: please)?$/;
const norm = (message: string) => String(message ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[!.\s]+$/g, "").replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
export function isApplyAllYes(message: string): boolean {
  const t = norm(message);
  return t.length > 0 && t.length <= 40 && YES.test(t);
}
// A yes with a condition on it ("yes but not Acme", "yeah except 2", "yes skip the first"): approves nothing, and says the offer is still open.
export function isConditionalYes(message: string): boolean {
  const t = norm(message);
  return t.length <= 200 && /^(?:yes|yep|yeah)\b/.test(t) && !YES.test(t) && /\b(?:but|except|not|skip|without|only|besides|other than|don't|dont|exclude|minus)\b/.test(t);
}

export interface ApplyAllResult {
  reply: string; status: string; intent: typeof APPLY_ALL_INTENT;
  // Meta for the reply: the spent offer's record, the counts' source, and (only when the offer could not be read at all) the offer again.
  meta: Record<string, unknown>;
  summary: ApplySummary;
  // What the handler still has to ask, one at a time (a model-written question, never code's): a profile need that stops roles from
  // being prepared, and/or the employer's open questions.
  asks: { questions: number; unprepared: number };
  counts: { approved: number; already: number; changed: number; blocked: number; failed: number; skipped_blank: number; skipped_sensitive: number; ready_since: number; getting_ready: number; needs_info: number; left_out: number };
}
export interface ApplyAllDeps {
  message: string; userId: string; now: number;
  last: { intent: string | null; meta: Record<string, unknown> } | null; // the thread's last assistant reply
  deps: JobDeps;
  questions?: { open(userId: string, limit: number): Promise<OpenQuestion[]> };
  prepare?: (userId: string) => Promise<"started" | "failed" | "off" | "skipped">; // career_hosted_prepare.ts reprepareQueued
  // Whether the person has a confirmed resume on file (apply_readiness.ts "resume"). false: nothing is approved or prepared and the
  // handler asks for the resume through the readiness path. Absent: not checked here.
  resumeConfirmed?: boolean;
}

const sink = (said: string[]): JobSender => ({ photo: async () => ({ ok: true }), text: async (a) => { said.push(a.text); return { ok: true, id: null }; } });
const names = (xs: string[]) => { const u = [...new Set(xs.filter(Boolean))]; return u.length <= 4 ? u.join(", ") : `${u.slice(0, 4).join(", ")} and ${u.length - 4} more`; };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const who = (j: JobView | null) => j ? (j.company || j.title || "a role") : "a role";

export async function applyAllYesTurn(o: ApplyAllDeps): Promise<ApplyAllResult | null> {
  const plain = isApplyAllYes(o.message), conditional = !plain && isConditionalYes(o.message);
  if (!plain && !conditional) return null;
  const offer = readOffer(o.last?.meta);
  if (!offer) return null; // no live offer: this yes is nothing new, the turn goes on as before
  if (!(o.now >= offer.at && o.now - offer.at <= OFFER_WINDOW_MS)) return null;
  const { deps, userId } = o;
  const counts = { approved: 0, already: 0, changed: 0, blocked: 0, failed: 0, skipped_blank: 0, skipped_sensitive: 0, ready_since: 0, getting_ready: 0, needs_info: 0, left_out: 0 };
  const done = (reply: string, status: string, extra: Partial<ApplyAllResult["asks"]> = {}, keepOffer = false): ApplyAllResult => {
    const summary = applySummary([], { prepared: 0 });
    return { reply, status, intent: APPLY_ALL_INTENT, summary, counts, asks: { questions: 0, unprepared: 0, ...extra },
      meta: keepOffer ? { apply_all_offer: offer } : { apply_all_done: { list: offer.list, at: o.now, ...counts } } };
  };
  if (conditional) return done(`I haven't approved anything. The offer to apply to all ${offer.jobs.length} shown is still open: reply just "yes" to approve exactly those, or use Apply on the list for one at a time.`, "not_plain", {}, true);
  if (o.resumeConfirmed === false) return done("I don't have a confirmed resume on file, so nothing was approved or prepared.", "no_resume", { unprepared: 1 });
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
    gettingReady: string[] = [], skippedBlank: string[] = [], skippedSensitive: string[] = [], needsInfo: string[] = [], leftOut: string[] = [];
  const open = o.questions ? await o.questions.open(userId, 500).catch(() => null) : null;
  const toPrepare: JobView[] = [];
  let kicked: "started" | "failed" | "off" | "skipped" | "none" = "none";
  for (const j of offer.jobs) {
    const got = onList.has(j.ref) ? await deps.store.recall(userId, j.ref).catch(() => null) : null;
    const job = got?.job ?? null, name = who(job);
    if (dismissed.has(j.ref)) { leftOut.push(name); continue; }
    if (!job || job.job_id !== j.job_id) { blocked.push(name); continue; } // not on the list any more, or not the posting that was offered
    if (j.tag) {
      // A payload with a blank required field or a sensitive answer is never approved by a batch yes: the person reviews it on the page.
      const held = await deps.store.prepared(userId, job.job_id).catch(() => null);
      const why = held ? batchHoldBack(held) : null;
      if (why) { (why === "blank" ? skippedBlank : skippedSensitive).push(name); continue; }
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
    // The posting screen the page's Apply runs before it queues a posting to prepare: closed, stale, scam-looking, a knock-out.
    if (await screenedOut(userId, job, deps)) { blocked.push(name); continue; }
    if (open && open.some((q) => q.job_ids.includes(job.job_id))) { needsInfo.push(name); continue; }
    const w = await deps.store.want(userId, job, deps.now()).catch(() => ({ result: "refused" as const }));
    if (w.result === "refused") { blocked.push(name); continue; }
    gettingReady.push(name); toPrepare.push(job);
  }
  if (toPrepare.length && o.prepare) kicked = await o.prepare(userId).catch(() => "failed" as const);
  Object.assign(counts, { approved: approved.length, already: already.length, changed: changed.length, blocked: blocked.length, failed: failed.length, skipped_blank: skippedBlank.length, skipped_sensitive: skippedSensitive.length,
    ready_since: readySince.length, getting_ready: gettingReady.length, needs_info: needsInfo.length, left_out: leftOut.length });

  const L: string[] = [];
  if (approved.length) L.push(`Approved and queued ${plural(approved.length, "application", "applications")}, each exactly as it was prepared: ${names(approved)}.`);
  else L.push("Nothing was approved.");
  if (already.length) L.push(`${names(already)} ${already.length === 1 ? "was" : "were"} already in your applications, so nothing more was queued for ${already.length === 1 ? "it" : "them"}.`);
  if (changed.length) L.push(`${names(changed)} changed after I offered ${changed.length === 1 ? "it" : "them"}, so I didn't approve ${changed.length === 1 ? "it" : "them"}; open the list to check the new version.`);
  if (skippedBlank.length || skippedSensitive.length) {
    const sk = skippedBlank.length + skippedSensitive.length, why = [skippedBlank.length ? `${skippedBlank.length} with a blank required field` : "", skippedSensitive.length ? `${skippedSensitive.length} with sensitive answers` : ""].filter(Boolean).join(" and ");
    L.push(`Skipped ${plural(sk, "role", "roles")} (${why}): ${names([...skippedBlank, ...skippedSensitive])}. Their exact answers are on the page; review each there and tap its own Apply.`);
  }
  if (blocked.length) L.push(`${names(blocked)} can't be approved right now, so nothing was queued for ${blocked.length === 1 ? "it" : "them"}.`);
  if (failed.length) L.push(`I couldn't open the approval for ${names(failed)} just now, so nothing was queued for ${failed.length === 1 ? "it" : "them"}. Use Apply on the list to try again.`);
  if (readySince.length) L.push(`${names(readySince)} got ready after I offered ${readySince.length === 1 ? "it" : "them"}, so I left ${readySince.length === 1 ? "it" : "them"} for you to check on the list first.`);
  if (gettingReady.length) L.push(`${plural(gettingReady.length, "role is", "roles are")} getting ready (${names(gettingReady)}); ${kicked === "started" || kicked === "none" ? "nothing is sent for them until you see and approve what's prepared" : "preparing hasn't started yet, so they wait in your queue; nothing is sent for them"}.`);
  if (needsInfo.length) L.push(`${names(needsInfo)} ${needsInfo.length === 1 ? "needs" : "need"} an answer from you first, so none of ${needsInfo.length === 1 ? "that one was" : "those were"} queued.`);
  if (leftOut.length) L.push(`${plural(leftOut.length, "role", "roles")} you dismissed on the list ${leftOut.length === 1 ? "was" : "were"} left out.`);
  const res = done(L.join(" "), approved.length ? (approved.length === offer.jobs.length ? "approved" : "partial") : (skippedBlank.length + skippedSensitive.length ? "skipped" : "none"), { questions: needsInfo.length, unprepared: gettingReady.length + blocked.length });
  // Counts from the taps' own results: approved rows are "approved" (queued); what is prepared but not approved is "prepared".
  res.summary = applySummary(approved.map(() => ({ state: "queued" })), { prepared: changed.length + readySince.length + blocked.length + failed.length + skippedBlank.length + skippedSensitive.length });
  res.meta = { apply_all_done: { list: offer.list, at: o.now, ...counts }, apply_summary: res.summary };
  return res;
}

// The offer is live only while its message is the thread's last word BY MESSAGE ID: the newest assistant row carries it AND no user turn
// has been stored after that row (a user turn with no assistant reply, e.g. a failed turn, also ends the offer). `admin` is a supabase client.
// deno-lint-ignore no-explicit-any
export async function liveOfferRow(admin: any, threadId: string): Promise<{ id: number; intent: string | null; meta: Record<string, unknown> } | null> {
  const a = await admin.from("agent_messages").select("id,meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1);
  if (a.error) throw new Error(`read the thread's last reply: ${a.error.message}`);
  const row = a.data?.[0];
  if (!row) return null;
  const u = await admin.from("agent_messages").select("id").eq("thread_id", threadId).eq("role", "user").gt("id", row.id).limit(1);
  if (u.error) throw new Error(`read the thread's later turns: ${u.error.message}`);
  if (u.data?.length) return null;
  return { id: row.id, intent: row.meta?.intent ?? null, meta: row.meta ?? {} };
}
