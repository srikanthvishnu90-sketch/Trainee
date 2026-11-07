// MANY ROLES, ONE FILE, ONE TAP (2026-11-06). "Find me 50 data analyst roles", "find data analyst roles in Chicago and apply",
// "apply to 15 data analyst roles": one results File holds what was asked for (up to RESULTS_FILE_MAX), the chat stays short
// and links it, and when the person asked to apply, every role on the File is put on their own apply queue and prepared
// through the one existing door (career_apply_chat.ts applyManyTurn -> career_apply_wanted -> kickPrepare ->
// career_apply_prepare_request_put), with its screens, resume check, pace and limits. Preparing sends nothing: each
// application still goes only on the person's tap on its card, which approves that exact payload (D-MS-1).
// Pure helpers here; agent-chat (handler-career.ts) and the File (trainee-file/handler.ts) wire them.
import type { ApplyChatResult, ShortlistEntry } from "./career_apply_chat.ts";
import type { FilePrep } from "./telegram_jobs.ts";
import { NO_RESUME_NEXT, NO_RESUME_REASON, prepareConfigured } from "./career_apply_from_chat.ts";
import { releaseValue } from "../agent-chat/release_config.ts";

export { RESULTS_FILE_MAX } from "./role_results.ts";

// How many roles the person asked for, in their words: "find me 50 data analyst roles", "top 40 jobs", "apply to 15 software
// engineering intern roles". A pay figure ("$30/hr", "150k"), a year ("2027") or a duration is never a count. null: no count.
const COUNT = /(?<![$\d.,])\b(\d{1,3})\b(?!\s*(?:k\b|%|\/|\$|per\b|an?\s+(?:hour|year)|hours?\b|years?\b|yrs?\b|days?\b|weeks?\b|months?\b|minutes?\b))\s+(?:[a-z+#/&.-]+\s+){0,6}?(?:roles?|jobs?|internships?|openings?|positions?|postings?|listings?|matches|opportunities)\b/i;
export function askedCount(message: string): number | null {
  const m = COUNT.exec(String(message ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// The search was also an ask to apply ("... and apply", "apply to 15 ... roles"). A question, or a negated apply ("don't apply
// yet"), is not.
const APPLY_WORDS = /\bapply\s+(?:to|for|at|me|on|now)\b|\bapply\b[^.?!]{0,40}\b(?:jobs?|roles?|postings?|positions?|internships?|openings?)\b|\bsubmit (?:my|an?) applications?\b|\b(?:and|then|&)\s+(?:also\s+)?apply\b/;
const NOT_APPLY = /\b(?:don'?t|do not|never|not|won'?t|without|before)\s+(?:\w+\s+){0,2}apply/;
export function wantsApply(message: string): boolean {
  const t = String(message ?? "").toLowerCase();
  return !/\?\s*$/.test(t) && APPLY_WORDS.test(t) && !NOT_APPLY.test(t);
}

// The prepare switch, as agent-chat can read it: the door is configured (CAREER_PREPARE_AHEAD_URL and its token) and the cloud
// preparation tick is not rolled back (CLOUD_PREPARE_ENABLED, a release flag). Off: nothing is queued for preparation by a File,
// and the reply and the File say preparation is not running.
export function prepareOn(env: { get(k: string): string | undefined }): boolean {
  return prepareConfigured(env) && releaseValue(env, "CLOUD_PREPARE_ENABLED") === "on";
}

// What happened to the File's rows: preparation started, the switch is off, the kick failed, or nothing was queued.
export type { FilePrep };
type PrepState = FilePrep["state"];

// Queues and prepares the File's rows through `run` (the apply turn over exactly these rows). Never throws.
export async function prepareFileRows(o: { on: boolean; total: number; now: number; run: () => Promise<ApplyChatResult | null> }): Promise<{ prep: FilePrep; result: ApplyChatResult | null }> {
  const base = { total: o.total, at: o.now };
  if (!o.on) return { prep: { state: "off", queued: 0, ...base }, result: null };
  let r: ApplyChatResult | null = null;
  try { r = await o.run(); } catch (e) { console.error("many roles: queueing the File's roles:", (e as Error)?.message ?? e); }
  const queued = r?.coverage?.queued ?? r?.queued?.length ?? 0;
  const state: PrepState = !r ? "failed" : !queued ? "not_queued" : r.prepare === "started" ? "started" : r.prepare === "off" ? "off" : "failed";
  return { prep: { state, queued, ...base }, result: r };
}

const them = (n: number) => (n === 1 ? "it" : "them");
// The chat's one or two sentences about it (the File link follows as its own message). resumeSaid: the reply already says
// nothing goes before the resume is confirmed.
export function prepLine(p: FilePrep, r: ApplyChatResult | null, o: { resumeSaid?: boolean } = {}): string {
  const all = p.queued === p.total ? (p.total === 1 ? "it" : `all ${p.total}`) : `${p.queued} of the ${p.total}`;
  const tap = "nothing goes to an employer until you tap Apply on its card in the File.";
  const left = (r?.refused ?? []).filter((x) => !/^(screened out|held, not guessed)/.test(x.reason));
  const notQueued = p.queued && left.length
    ? ` ${left.length} ${left.length === 1 ? "wasn't" : "weren't"} queued: ${left.slice(0, 3).map((x) => `${x.title || "a role"} at ${x.company || "an employer"} (${x.said ?? x.reason})`).join("; ")}${left.length > 3 ? `; and ${left.length - 3} more` : ""}.`
    : "";
  switch (p.state) {
    case "started": return `I've started preparing ${all} from your confirmed facts; each one shows its Apply in the File when it's ready, and ${tap}${notQueued}`;
    case "failed": return p.queued
      ? `${p.queued === 1 ? "It's" : `${p.queued} are`} on your apply list, but preparing ${them(p.queued)} hasn't started yet; nothing was sent, and ${tap}${notQueued}`
      : "I couldn't queue them just now, so nothing was prepared or sent. Ask again in a minute, or tap Apply on a role in the File.";
    case "off": return p.queued
      ? `${p.queued === 1 ? "It's" : `${p.queued} are`} on your apply list, but preparation isn't running right now, so ${p.queued === 1 ? "it isn't" : "they aren't"} being prepared yet; nothing was sent.${notQueued}`
      : "Preparation isn't running right now, so I haven't started on them and nothing was sent. Each role in the File has its own Apply.";
    case "not_queued":
      if (r?.status === "no_resume") return o.resumeSaid ? "" : `Nothing was queued: ${NO_RESUME_REASON}. ${NO_RESUME_NEXT}`;
      if (r?.status === "already") return "They're already on your apply list, so nothing changed and nothing was sent.";
      return r?.reply ? `Nothing was queued or prepared. ${r.reply}` : "Nothing was queued or prepared, and nothing was sent.";
  }
}

// The File's own line about it, at the top of the page. null: nothing to say.
export function prepTop(p: FilePrep | null | undefined): string | null {
  if (!p) return null;
  if (p.state === "started") return `Getting ${p.queued === p.total ? (p.total === 1 ? "this role" : `all ${p.total} roles`) : `${p.queued} of these ${p.total} roles`} ready. A role shows Apply when it's ready; nothing is sent until you tap it.`;
  if (p.state === "off") return "Preparation isn't running right now, so these roles aren't being prepared. Nothing is sent; tap Apply on a role to put it on your list.";
  if (p.state === "failed") return "Preparing these roles hasn't started yet. Nothing was sent; refresh in a minute.";
  return null;
}

// The rows a results File shows, as the apply turn reads a list.
export function rowsAsShortlist(rows: { job_id: string; title: string; company: string; location: string; url: string }[]): ShortlistEntry[] {
  return rows.map((r) => ({ id: r.job_id, title: r.title, company: r.company, location: r.location, url: r.url }));
}
