// D-072 (files reachable): the record-backed File families the chat makes (file_family_make.ts), their names and titles, and the
// asks that call for one (familyAskOf). Kept apart from the maker so the staged router (career_staged.ts) reads the ask without
// loading the record readers. The family -> ask -> creator table is in docs/architect/specs/FILE-RECORDS.md section 6.
// The families made here. F-09 is made by createReview (application_review_links.ts) and F-05, F-06, F-10, F-11 by the results list.
// Written out (not derived from file_family_serve.ts) so the brain loads no File page code; tests/architect/files-reachable-d072.test.ts
// D72-1 holds it equal to the served families less F-09.
export type MadeFamily = "F-01" | "F-02" | "F-03" | "F-04" | "F-07" | "F-08" | "F-12" | "F-13" | "F-14" | "F-14n" | "F-15";
export const FAMILY_BY_NAME: Record<string, MadeFamily> = {
  career_brief: "F-01", profile_facts: "F-02", path_comparison: "F-03", search_plan: "F-04", materials: "F-07", answer_library: "F-08",
  message_review: "F-12", interview_hub: "F-13", weekly_brief: "F-14", negotiation_plan: "F-14n", offer_comparison: "F-15",
};
export const FAMILY_NAMES = Object.keys(FAMILY_BY_NAME);
export const FAMILY_TITLE: Record<MadeFamily, string> = {
  "F-01": "Career brief", "F-02": "Profile facts", "F-03": "Path comparison", "F-04": "Search plan", "F-07": "Materials", "F-08": "Answer library",
  "F-12": "Message review", "F-13": "Interview hub", "F-14": "Weekly brief", "F-14n": "Negotiation plan", "F-15": "Offer comparison",
};

// ---------------------------------------------------------------- the asks
// A family named as a page to see, open or keep. Each phrase is the File's own name or the plain words for it; a generic phrase
// ("my interviews", "compare my offers") counts only with a File word beside it, so an ordinary question stays an ordinary question.
// A control ("pause my weekly brief"), an opt-out ("no more weekly brief"), an approval or a bare reply is never an ask here, and
// neither is an ask to make something new ("build a search plan"): those are the settings tools' and the planning turn's.
const FILE_WORD = /\b(?:file|page|link|doc(?:ument)?|one[- ]?pager|sheet)s?\b/i;
const SHOW = /\b(?:show|open|see|view|send|give|get|pull\s+up|bring\s+up|share)\b|\bwhere(?:'s|\s+is)\b|\bwhat(?:'s|\s+is)\s+(?:in|on)\b/i;
// A generic phrase is a File ask only with a verb that asks to SEE what is on record (never one that asks to write something new:
// "make me an interview prep file" is the prep File's, "draft a message" is the draft tool's).
const SEE = /\b(?:show|open|see|view|pull\s+up|bring\s+up)\b|\b(?:send|give)\s+me\b|\bwhere(?:'s|\s+is)\b/i;
// A control or a decision about the File's subject is not a File ask: "pause my weekly brief", "approve my search plan".
// An opt-out is a control however it is worded (review of #798: "don't send me the weekly brief anymore", "no more weekly brief",
// "skip the weekly summary", "mute weekly brief", "weekly digest off" were each read as "make the File", so the person got a brief
// link in place of the pause they asked for). Any negation, stop, skip, mute or off word leaves the turn to the settings path.
const CONTROL = /\b(?:pause|stop|resume|turn\s+(?:off|on)|off|cancel|unsubscribe|opt(?:ing)?[- ]out|skip|mute|silence|snooze|disable|quit|end|change|move|approve|delete|remove|edit|update|never|no\s+(?:more|longer)|not|(?:do|does|did|wo|would|ca|can)n'?t|cannot)\b|\benough\s+(?:of|with)\b/i;
// An ask to write or make something new is not an ask to open what is on record (review of #798: "make me a search plan for PM
// roles in NYC", "build a search plan" and "draft a counter plan" were held to opening the existing File, which answers "nothing
// on record" where the planning turn would have made the plan). Read with the File's own name taken out, so the noun "plan" in
// "search plan" is not the verb.
const WRITE_NEW = /\b(?:write|draft|compose|prep|prepare|practi[cs]e|mock|tailor|research|make|create|build|generate|plan|design|start|put\s+together|come\s+up\s+with|set\s+up|work\s+(?:out|up))\b/i;
const NAMED: [MadeFamily, RegExp][] = [
  ["F-01", /\bcareer\s+brief\b/i],
  ["F-02", /\bprofile\s+facts\b|\bfacts\s+(?:you\s+have|on\s+file|about\s+me)\b/i],
  ["F-03", /\bpath\s+comparison\b/i],
  ["F-04", /\bsearch\s+plan\b/i],
  ["F-07", /\bmaterials?\s+(?:studio|file|page)\b|\b(?:resume|r[e\u00e9]sum[e\u00e9]|cover\s+letter)\s+versions\b/i],
  ["F-08", /\banswer\s+library\b|\bsaved\s+answers\b/i],
  ["F-12", /\bmessage\s+review\b/i],
  ["F-13", /\binterview\s+hub\b/i],
  ["F-14", /\bweekly\s+(?:brief|summary|digest|report)\b/i],
  ["F-14n", /\bnegotiation\s+plan\b|\bcounter(?:offer)?\s+plan\b/i],
  ["F-15", /\boffer\s+comparison\b/i],
];
const WITH_FILE_WORD: [MadeFamily, RegExp][] = [
  ["F-02", /\bmy\s+(?:profile|facts)\b|\bwhat\s+you\s+know\s+about\s+me\b/i],
  ["F-03", /\bcompar(?:e|ing|ison)\b[^.?!]{0,30}\b(?:paths?|directions)\b/i],
  ["F-07", /\bmy\s+materials\b/i],
  ["F-08", /\bmy\s+(?:saved\s+|application\s+)?answers\b/i],
  ["F-12", /\b(?:my|the|that)\s+(?:outreach\s+|email\s+)?(?:draft|message)\b/i],
  ["F-13", /\bmy\s+(?:upcoming\s+)?interviews?\b/i],
  ["F-14n", /\bnegotiation\b/i],
  ["F-15", /\bcompar(?:e|ing|ison)\b[^.?!]{0,30}\boffers\b|\bmy\s+offers\b/i],
];
// The family the message asks to see as a File, or null. A File's own name with a verb to see it, a File word, or alone
// ("my weekly brief"); a generic phrase only with a File word and a verb to see it. Never a control, an opt-out or a new thing to make.
export function familyAskOf(message: string): MadeFamily | null {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'").trim();
  if (!m || m.length > 600 || CONTROL.test(m)) return null;
  const named = NAMED.find(([, re]) => re.test(m));
  if (named) return !WRITE_NEW.test(m.replace(named[1], " ")) && (SHOW.test(m) || FILE_WORD.test(m) || m.split(/\s+/).length <= 4) ? named[0] : null;
  if (!FILE_WORD.test(m) || !SEE.test(m) || WRITE_NEW.test(m)) return null;
  return WITH_FILE_WORD.find(([, re]) => re.test(m))?.[0] ?? null;
}

