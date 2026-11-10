// R10 WO-D (owner order 2026-11-09, spec APP-LAYER-15-FIXES.md A.2 search turn 2, A.5 #6, C.24, E.6 #50-51; fix 7), as
// updated by the owner's ruling of 2026-11-09 (D-046: no per-person AI cap; Sonnet only): when a REAL limit stops the AI
// mid-task, the person is told what stopped, that the task is kept, and the next step (with a time only when one is known,
// in their own zone); nothing was applied for; and no unrelated template stands in for the answer. Production, at a limit,
// sent the graduation-window template with "as of 2026-10-13" and then "The limit resets at midnight UTC."
//
// The limits, from the model call's own refusal (model_calls.ts ModelUnavailableError types):
//   global        the product's AI budget is used up (model_budget.ts, $70 for the cycle): the owner must approve more
//   budget_day    an approved day window's own cap is used up: it resets when the budget day turns, midnight US Central
//                 (model_budget_day: the America/Chicago date; chicagoDay is its twin), said in the person's own zone
//   budget_after  the budget window ended: the owner must approve more
//   budget_before the budget window has not opened
//   paused        the owner switched the AI off for a while (MODEL_BUDGET_PAUSED or its database twin)
//   unchecked     the budget could not be read, so no call was made
//   rate_limit    the AI provider refused for rate (HTTP 429) or was overloaded (529); its retry-after, when it gave one
// Any other model failure is an outage, not a limit (stop "outage", below): the router answers when it has a real intent for
// the message, else the turn is held the same way (architect amendment, r-states 2026-11-10). Nothing here changes any limit.
import { ModelBudgetBlockedError, ModelUnavailableError } from "./model_calls.ts";
import { BUDGET_ERROR_TYPE, BUDGET_TIME_ZONE, chicagoDay } from "./model_budget.ts";
import type { PersonZone } from "./person_zone.ts";

// outage: not a limit (stopOfError never returns it); the model call failed. Architect amendment (r-states, 2026-11-10): the
// turn is held the same way, so the router's catch-all never answers a different question.
export type LimitStop = "global" | "budget_day" | "budget_after" | "budget_before" | "paused" | "unchecked" | "rate_limit" | "outage";
export const HELD_INTENT = "career_limit_held";

export function stopOfError(e: unknown): LimitStop | null {
  if (!(e instanceof ModelUnavailableError)) return null;
  const t = String(e.type ?? "");
  if (t === BUDGET_ERROR_TYPE.limit) return e instanceof ModelBudgetBlockedError && e.day ? "budget_day" : "global";
  if (t === BUDGET_ERROR_TYPE.after) return "budget_after";
  if (t === BUDGET_ERROR_TYPE.before) return "budget_before";
  if (t === BUDGET_ERROR_TYPE.paused) return "paused";
  if (t === BUDGET_ERROR_TYPE.unavailable) return "unchecked";
  if (e.status === 429 || e.status === 529 || /rate_limit|overloaded/.test(t)) return "rate_limit";
  return null;
}
// When the provider said the call may be retried (its retry-after), as an instant; null when it did not say.
// A day window's cap: the moment its budget day ends (the next one starts), read from the same day function as enforcement.
export const retryAtOf = (e: unknown, now: number): number | null =>
  e instanceof ModelBudgetBlockedError && e.block === "limit" && e.day ? budgetDayEnd(now)
    : e instanceof ModelUnavailableError && typeof e.retryAfterMs === "number" ? now + e.retryAfterMs : null;

// The first instant after `now` whose budget day (chicagoDay, the twin of SQL model_budget_day) differs: the next midnight
// America/Chicago, 23, 24 or 25 hours after the last one across a DST change. Found by search on the day function itself, so
// copy and enforcement cannot drift.
export function budgetDayEnd(now: number): number {
  const today = chicagoDay(now);
  let lo = now, hi = now + 26 * 3600000;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (chicagoDay(mid) === today) lo = mid; else hi = mid; }
  return hi;
}
// "midnight US Central", in the person's own words for their zone when they stated one (never UTC).
function resetWords(ms: number, zone: PersonZone | null): string {
  if (!zone) return "midnight US Central";
  if (zone.tz === BUDGET_TIME_ZONE) return "midnight Chicago time";
  return `midnight US Central, which is ${timeIn(ms, zone)}`;
}

// "6:44 PM Chicago time" / "6:44 PM CST"; UTC (said) when the zone is unknown.
function timeIn(ms: number, zone: PersonZone | null): string {
  const tz = zone?.tz ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const clock = `${get("hour")}${get("minute") === "00" ? "" : `:${get("minute")}`} ${get("dayPeriod")}`;
  return `${clock} ${zone ? (zone.city ? `${zone.city} time` : get("timeZoneName")) : "UTC (I don't know your time zone)"}`;
}

// What stopped and the next step, said for this limit. A time is given only when one is known (the provider's retry-after).
export function nextStepOf(stop: LimitStop, zone: PersonZone | null, retryAt: number | null = null): string {
  switch (stop) {
    case "rate_limit": return retryAt
      ? `The AI service is turning requests away for now. Say "continue" after ${timeIn(retryAt, zone)} and I'll pick it up.`
      : `The AI service is turning requests away for now and didn't say when it will take them again. Say "continue" later and I'll pick it up.`;
    case "budget_day": return retryAt
      ? `Trainee's AI budget for today is used up. It resets at ${resetWords(retryAt, zone)}; say "continue" after that and I'll pick it up.`
      : `Trainee's AI budget for today is used up. It resets at midnight US Central; say "continue" after that and I'll pick it up.`;
    case "global": return `Trainee's AI budget is used up, and more needs the owner's approval. Once it is approved, say "continue" and I'll pick it up.`;
    case "budget_after": return `Trainee's AI budget period has ended, and a new one needs the owner's approval. Once it is approved, say "continue" and I'll pick it up.`;
    case "budget_before": return `Trainee's AI budget hasn't opened yet. Once it opens, say "continue" and I'll pick it up.`;
    case "paused": return `Trainee's AI is switched off for a short while. Say "continue" later and I'll pick it up.`;
    case "unchecked": return `I couldn't check Trainee's AI budget, so I made no AI call. Say "continue" later and I'll pick it up.`;
    case "outage": return `The AI service failed on this one (an error on its side, not a limit). Say "continue" in a minute and I'll pick it up.`;
  }
}

// The kept task in a few words of the person's own ask, never a verbatim echo and never with a question mark (coordinator
// ruling 2026-11-10, r-audit #706: R2 no echo; an echoed "?" mid-reply also buried the decision, R10).
export function taskOf(message: string): string {
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  const t = raw.toLowerCase();
  const name = (/\b(?:at|about|on|for|with|to|of)\s+((?:[A-Z][\w&'.-]*)(?:\s+[A-Z][\w&'.-]*){0,3})/.exec(raw)?.[1]
    ?? /\b(?:my|the|a|an|include)\s+((?:[A-Z][\w&'.-]*)(?:\s+[A-Z][\w&'.-]*){0,3})/.exec(raw)?.[1] ?? "").replace(/[.,!?;:]+$/, "");
  const of = name && !/^(?:I|AI|Trainee)$/.test(name) ? `${name} ` : "";
  if (/\bfollow(?:ing)?[- ]?up\b/.test(t)) return `your ${/\binterview\b/.test(t) ? "interview " : ""}follow-up question`;
  if (/\b(?:interview|prep(?:are)?)\b/.test(t)) return `your ${of}interview prep`;
  if (/\b(?:qualify|eligib\w*|requirements)\b/.test(t)) return `your eligibility question${of ? ` about ${of.trim()}` : ""}`;
  if (/\b(?:draft|write|note|message|email|intro)\b/.test(t)) return `the message${of ? ` to ${of.trim()}` : " draft"}`;
  if (/\b(?:resume|cv)\b/.test(t)) return "your resume edit";
  if (/\b(?:research|tell me about|like to work|brief|why not|why didn'?t|include)\b/.test(t)) return of ? `your question about ${of.trim()}` : "your research question";
  if (/\b(?:find|search|look(?:ing)? for|jobs?|roles?|internships?|openings?|positions?)\b/.test(t)) return "your job search";
  return of ? `your question about ${of.trim()}` : "your last request";
}

// The reply in place of an answer the AI could not give: the kept task named, the next step, nothing applied for.
export function heldReply(message: string, stop: LimitStop, zone: PersonZone | null, retryAt: number | null = null): string {
  return `I couldn't finish ${taskOf(message)} without the AI: it is kept. ${nextStepOf(stop, zone, retryAt)} Nothing was applied for, and searching postings still works now.`;
}

// The task a limit stopped, kept on the thread (discovery.heldAtLimit), and the message that resumes it, once a minute has
// passed (if the limit still holds, the turn is held again and the same task stays kept).
export interface HeldTask { message: string; at: number; stop?: LimitStop }
const RESUME = /^\s*(?:(?:ok(?:ay)?|yes|sure|now)[,!.]?\s+)*(?:please\s+)?(?:continue|go on|go ahead|resume|keep going|carry on|pick (?:it|that) (?:back )?up|try (?:it |that )?again|finish (?:it|that))(?:\s+(?:please|now|where you left off|what you were doing))*[\s.!]*$/i;
export const isResume = (message: string) => RESUME.test(String(message ?? ""));
export function resumedTask(discovery: unknown, message: string, now: number): HeldTask | null {
  const h = (discovery as { heldAtLimit?: HeldTask | null } | null)?.heldAtLimit;
  if (!h || typeof h.message !== "string" || !h.message.trim() || typeof h.at !== "number" || !isResume(message)) return null;
  if (now < h.at || now - h.at > 3 * 86400000 || now - h.at < 60_000) return null;
  return h;
}
