// Spec 2.3 (conversation behavior): a correction updates the task. "Only individual-contributor roles" or "remote only"
// changes the constraints the NEXT results use, and the old filter is not kept. Pure: the previous search's ask (kept on
// the thread by the handler as discovery.lastAsk) plus the person's correction in, the corrected ask out. Code only
// changes constraints; what the reply says about the change is the model's (or the results page's), never written here.
import type { BandName, Limits } from "./posting_constraints.ts";
import type { SearchAsk } from "./career_search_judge.ts";
import { US_CITIES } from "./posting_place.ts";

export const MANAGER_BANDS: BandName[] = ["manager", "director"];
export type Change = "remote_only" | "not_remote" | "individual_contributor" | "level_dropped" | "place_changed" | "role_changed";
export interface Correction { remoteOnly?: true; notRemote?: true; contributorOnly?: true; place?: string; role?: string }

const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
// "I need remote only" / "I want only remote roles" (B.6 continuation 2, turn 3) is the same correction, said as a need.
const REMOTE_ONLY = /^(?:(?:ok|okay|actually|sorry|wait|hmm|no|and|also|please)[,!:]?\s+)*(?:i\s+(?:need|want|only want|would like|'d like)\s+)?(?:(?:only|just)\s+(?:show\s+(?:me\s+)?)?(?:fully\s+)?remote(?:\s+(?:roles?|jobs?|positions?|ones|work|postings?))?|remote\s+(?:only|roles? only|jobs? only)|(?:make|keep) it remote(?: only)?|(?:fully )?remote please)(?:\s+(?:please|thanks|pls))?[.!]*$/;
const NOT_REMOTE = /^(?:(?:ok|okay|actually|sorry|wait|hmm|no|and|also|please)[,!:]?\s+)*(?:i\s+(?:need|want|only want|would like|'d like)\s+)?(?:no remote(?: roles?| jobs?)?|not remote|(?:only|just)\s+(?:on-?site|in[- ]person)(?:\s+(?:roles?|jobs?))?|(?:on-?site|in[- ]person) only)(?:\s+(?:please|thanks|pls))?[.!]*$/;
const LEAD = "^(?:(?:ok|okay|actually|sorry|wait|hmm|no|and|also|please)[,!:]?\\s+)*";
const TAIL = "(?:\\s+(?:please|thanks|pls))?[.!]*$";
// The WHOLE message must be the correction: "no management consulting", "not a manager yet", "no director of engineering" or
// "skip managers" inside a longer sentence say something else and change nothing.
const CONTRIB = new RegExp(LEAD + "(?:(?:only|just)\\s+(?:individual[- ]contributors?|ics?)(?:\\s+(?:roles?|jobs?|positions?))?|(?:individual[- ]contributors?|ic)\\s+(?:roles?\\s+)?only|(?:no|without|exclude|skip|drop|remove|ignore)\\s+(?:any\\s+)?(?:people[- ])?(?:managers?|management|manager roles?|managerial roles?|director(?:s| roles?)?|people management|people[- ]manager roles?)(?:\\s+(?:roles?|jobs?|positions?))?|not (?:looking for|interested in|applying to)\\s+(?:any\\s+)?(?:manager|management|managerial|director)s?(?:\\s+(?:roles?|jobs?|positions?))?|no people[- ]management)(?:\\s*,\\s*(?:and\\s+)?(?:no|without|exclude|skip)\\s+(?:any\\s+)?(?:people[- ])?(?:managers?|management|directors?)(?:\\s+(?:roles?|jobs?|positions?))?)?" + TAIL);
// "only individual contributor roles, no manager roles" is one correction.

// Whether this message corrects the previous search (null: it is not a correction, so nothing here applies).
export function correctionOf(message: string): Correction | null {
  const t = lc(message);
  if (!t || t.length > 120 || /\?\s*$/.test(t)) return null;
  const c: Correction = {};
  if (REMOTE_ONLY.test(t)) c.remoteOnly = true;
  else if (NOT_REMOTE.test(t)) c.notRemote = true;
  if (CONTRIB.test(t)) c.contributorOnly = true;
  if (!c.remoteOnly && !c.notRemote && !c.contributorOnly) Object.assign(c, replacementOf(message));
  return c.remoteOnly || c.notRemote || c.contributorOnly || c.place || c.role ? c : null;
}

// r-audit battery (2026-11-10, R3): "actually Denver, not Chicago", "sorry, I meant data analyst roles", "change the city to
// Seattle", "make that business analyst instead" replace the place or the role of the last search. Before this only remote
// and level corrections were read, so "sorry, I meant data analyst roles" searched for the role "sorry meant data analyst" and
// "switch it to Denver instead of Chicago" was taken as a new message recipient. The WHOLE message must be the replacement;
// a role needs a job word, a place must be a known city or written with a capital ("try harder" changes nothing).
const ROLE_WORD = /\b(?:analyst|analytics|engineer(?:ing)?|developer|designer|design|scientist|science|coordinator|manager|intern(?:ship)?s?|associate|consultant|specialist|marketing|sales|product|data|finance|financial|accounting|ux|software|operations|research(?:er)?|writer|nurse|teacher|recruiter)\b/i;
const R_LEAD = /^(?:(?:ok|okay|so|actually|sorry|oops|wait|hmm|no|and|also|please|right|um|correction|quick question|one more thing|hey(?: trainee)?)[,!:]?\s+)*/i;
const R_TAIL = /(?:\s+(?:please|thanks|thank you|pls|now|for me|asap))*[.!]*$/i;
const R_FORMS: RegExp[] = [
  /^(?:i meant|i mean|make (?:that|it)|change (?:it|that|the (?:city|place|location|role|title|job))? ?to|switch (?:it|that|the (?:city|place|role))? ?to|swap (?:it|that) (?:to|for)|let'?s do)\s+(.+?)(?:\s+instead(?:\s+of\s+(.+?))?)?(?:,?\s+not\s+(.+?))?$/i,
  /^not\s+(?<y>.+?),\s*(.+?)$/i,
  /^(.+?),?\s+not\s+(.+?)$/i,
  /^(.+?)\s+instead(?:\s+of\s+(.+?))?$/i,
];
const JOBNOUN = /\s+(?:roles?|jobs?|positions?|openings?)$/i;
function replacementOf(message: string): { place?: string; role?: string } {
  const raw = String(message ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 80 || /\?\s*$/.test(raw)) return {};
  const body = raw.replace(R_LEAD, "").replace(R_TAIL, "").trim();
  for (const rx of R_FORMS) {
    const m = rx.exec(body);
    if (!m) continue;
    const x = (m.groups?.y ? m[2] : m[1]).replace(JOBNOUN, "").trim();
    if (!x || x.split(" ").length > 4 || /^(?:remote|it|that|this|them|one)$/i.test(x)) return {};
    if (ROLE_WORD.test(x)) return { role: x.toLowerCase() };
    const known = US_CITIES.has(x.toLowerCase());
    if (known || /^[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}$/.test(x)) return { place: x.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) };
    return {};
  }
  return {};
}

// The previous ask with the correction applied. Everything the correction does not touch is kept; what it touches is
// REPLACED, never added to: remote-only drops the place the earlier ask was limited to (a remote role has no commute),
// not-remote drops remote, individual-contributor drops manager levels (and a manager level asked for earlier).
export function applyCorrection(prev: SearchAsk, c: Correction): { ask: SearchAsk; changes: Change[] } {
  const changes: Change[] = [];
  // A role that names a manager title ("product manager") keeps its own level: a correction against managers is about the people
  // management in a posting, not the role asked for.
  const managerRole = /\bmanager\b/i.test(prev.role ?? "");
  const ruledOut = managerRole ? MANAGER_BANDS.filter((b) => b !== "manager") : MANAGER_BANDS;
  const limits: Limits = { ...(prev.limits ?? { bands: null, pay: null, company: null, term: null, needsSponsor: false }) };
  let { place, remote, remoteOnly } = prev;
  let prevPlace = prev.prevPlace ?? null;
  // The place a remote-only correction drops is kept (prevPlace) so "actually, not remote" restores it.
  if (c.remoteOnly) { if (place) prevPlace = place; remote = true; remoteOnly = true; place = null; changes.push("remote_only"); }
  if (c.notRemote) { remote = false; remoteOnly = false; if (!place && prevPlace) place = prevPlace; prevPlace = null; changes.push("not_remote"); }
  if (c.contributorOnly) {
    const kept = (limits.bands ?? []).filter((b) => !ruledOut.includes(b));
    if ((limits.bands ?? []).length !== kept.length) changes.push("level_dropped");
    limits.bands = kept.length ? kept : null;
    limits.notBands = [...new Set([...(limits.notBands ?? []), ...ruledOut])];
    changes.push("individual_contributor");
  }
  let role = prev.role;
  if (c.place) { place = c.place; remote = false; remoteOnly = false; prevPlace = null; changes.push("place_changed"); }
  if (c.role) { role = c.role; changes.push("role_changed"); }
  return { ask: { ...prev, role, place, remote, remoteOnly, limits, prevPlace }, changes };
}

// A correction corrects the search that is still the conversation's last word: the ask was kept (lastAsk) within this window, and
// the handler drops it on any turn that was not a search.
export const CORRECTION_WINDOW_MS = 30 * 60 * 1000;
// The correction to the thread's last search, if this message is one and there is a recent last search to correct.
export function correctedAsk(message: string, discovery: unknown, now: number = Date.now()): { ask: SearchAsk; changes: Change[] } | null {
  const d = discovery as { lastAsk?: SearchAsk; lastAskAt?: number } | null;
  const prev = d?.lastAsk;
  if (!prev || typeof prev !== "object" || typeof prev.role !== "string") return null;
  if (typeof d?.lastAskAt !== "number" || now - d.lastAskAt > CORRECTION_WINDOW_MS || now < d.lastAskAt) return null;
  const c = correctionOf(message);
  return c ? applyCorrection(prev, c) : null;
}
