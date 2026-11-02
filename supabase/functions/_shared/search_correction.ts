// Spec 2.3 (conversation behavior): a correction updates the task. "Only individual-contributor roles" or "remote only"
// changes the constraints the NEXT results use, and the old filter is not kept. Pure: the previous search's ask (kept on
// the thread by the handler as discovery.lastAsk) plus the person's correction in, the corrected ask out. Code only
// changes constraints; what the reply says about the change is the model's (or the results page's), never written here.
import type { BandName, Limits } from "./posting_constraints.ts";
import type { SearchAsk } from "./career_search_judge.ts";

export const MANAGER_BANDS: BandName[] = ["manager", "director"];
export type Change = "remote_only" | "not_remote" | "individual_contributor" | "level_dropped";
export interface Correction { remoteOnly?: true; notRemote?: true; contributorOnly?: true }

const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const REMOTE_ONLY = /^(?:(?:ok|okay|actually|sorry|wait|hmm|no|and|also|please)[,!:]?\s+)*(?:(?:only|just)\s+(?:show\s+(?:me\s+)?)?(?:fully\s+)?remote(?:\s+(?:roles?|jobs?|positions?|ones|work|postings?))?|remote\s+(?:only|roles? only|jobs? only)|(?:make|keep) it remote(?: only)?|(?:fully )?remote please)(?:\s+(?:please|thanks|pls))?[.!]*$/;
const NOT_REMOTE = /^(?:(?:ok|okay|actually|sorry|wait|hmm|no|and|also|please)[,!:]?\s+)*(?:no remote(?: roles?| jobs?)?|not remote|(?:only|just)\s+(?:on-?site|in[- ]person)(?:\s+(?:roles?|jobs?))?|(?:on-?site|in[- ]person) only)(?:\s+(?:please|thanks|pls))?[.!]*$/;
const CONTRIB = /\b(?:only|just)\s+(?:individual[- ]contributors?|ics?)\b|\b(?:individual[- ]contributors?|ic)\s+(?:roles?\s+)?only\b|\b(?:no|not|without|exclude|skip|drop|remove|ignore)\s+(?:any\s+)?(?:people[- ])?(?:managers?|management|manager roles?|director(?:s| roles?)?|people management|people[- ]manager roles?|supervis\w+)\b|\bnot (?:looking for|interested in|applying to)\s+(?:a\s+)?(?:manage\w+|director\w*|people management)\b|\bno people[- ]management\b|\bnot a manager\b/;

// Whether this message corrects the previous search (null: it is not a correction, so nothing here applies).
export function correctionOf(message: string): Correction | null {
  const t = lc(message);
  if (!t || t.length > 120 || /\?\s*$/.test(t)) return null;
  const c: Correction = {};
  if (REMOTE_ONLY.test(t)) c.remoteOnly = true;
  else if (NOT_REMOTE.test(t)) c.notRemote = true;
  if (CONTRIB.test(t)) c.contributorOnly = true;
  return c.remoteOnly || c.notRemote || c.contributorOnly ? c : null;
}

// The previous ask with the correction applied. Everything the correction does not touch is kept; what it touches is
// REPLACED, never added to: remote-only drops the place the earlier ask was limited to (a remote role has no commute),
// not-remote drops remote, individual-contributor drops manager levels (and a manager level asked for earlier).
export function applyCorrection(prev: SearchAsk, c: Correction): { ask: SearchAsk; changes: Change[] } {
  const changes: Change[] = [];
  const limits: Limits = { ...(prev.limits ?? { bands: null, pay: null, company: null, term: null, needsSponsor: false }) };
  let { place, remote, remoteOnly } = prev;
  if (c.remoteOnly) { remote = true; remoteOnly = true; place = null; changes.push("remote_only"); }
  if (c.notRemote) { remote = false; remoteOnly = false; changes.push("not_remote"); }
  if (c.contributorOnly) {
    const kept = (limits.bands ?? []).filter((b) => !MANAGER_BANDS.includes(b));
    if ((limits.bands ?? []).length !== kept.length) changes.push("level_dropped");
    limits.bands = kept.length ? kept : null;
    limits.notBands = [...new Set([...(limits.notBands ?? []), ...MANAGER_BANDS])];
    changes.push("individual_contributor");
  }
  return { ask: { ...prev, place, remote, remoteOnly, limits }, changes };
}

// The correction to the thread's last search, if this message is one and there is a last search to correct.
export function correctedAsk(message: string, discovery: unknown): { ask: SearchAsk; changes: Change[] } | null {
  const prev = (discovery as { lastAsk?: SearchAsk } | null)?.lastAsk;
  if (!prev || typeof prev !== "object" || typeof prev.role !== "string") return null;
  const c = correctionOf(message);
  return c ? applyCorrection(prev, c) : null;
}
