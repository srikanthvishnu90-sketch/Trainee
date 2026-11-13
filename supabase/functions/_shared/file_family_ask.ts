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
// A control or a decision about the File's subject is not a File ask: "pause my weekly brief", "approve my search plan". An
// opt-out is a control however it is worded (review of #798: "don't send me the weekly brief anymore", "no more weekly brief",
// "skip the weekly summary", "mute weekly brief", "weekly digest off" each got a brief link in place of the pause asked for).
// Review of #803: these words were read anywhere in the message, so "where's my weekly brief? I can't find the link", "show me my
// weekly brief by end of day" and "show me my materials page for the design role" stopped being asks. They are now read only where
// they GOVERN the File's name: in the name's own clause before the name (the verb and its negation: "don't send me the weekly
// brief", "no more weekly brief"), straight after it ("weekly digest off"), or in another clause that points back at it ("the weekly
// brief is too much, stop sending it"). A clause is cut at sentence punctuation, a comma, and "so", "because", "before", "but", "then".
const CLAUSE_CUT = /[.?!;:,\n]+|\s+(?:so(?:\s+that)?|because|cause|before|after|but|then|since|while|though|although|once)\s+/i;
const CTRL = /\b(?:pause|stop|resume|turn\s+(?:off|on)|off|cancel|unsubscribe|opt(?:ing)?[- ]out|skip|mute|silence|snooze|disable|quit|end|change|move|approve|delete|remove|edit|update)\b|\benough\s+(?:of|with)\b/i;
const NEG = /\b(?:never|no\s+(?:more|longer)|not|(?:do|does|did|wo|would|ca|can)n'?t|cannot)\b/i;
// Words that look like a control or a negation and are neither: "by end of day", "don't forget to send", "make sure", "not sure where".
const BENIGN = /\b(?:by|at|before|until|till)\s+(?:the\s+)?end\b|\bend\s+of\b|\b(?:do\s+not|don'?t)\s+forget\b|\bmake\s+sure\b|\bnot\s+sure\b|\bwhy\s+not\b|\b(?:can'?t|cannot)\s+wait\b/gi;
// "can't open my career brief", "I didn't get my weekly brief": the person can't reach the File, which is an ask to see it.
const CANT_REACH = /\b(?:(?:ca|can|could|did|have|has)n'?t|cannot|can\s+not|unable\s+to|not\s+able\s+to)(?:\s+(?:i|we|even|seem\s+to|manage\s+to|yet))?\s+(?:open|find|access|load|get(?:\s+(?:to|into))?|got(?:ten)?|receive[d]?|see|seen|view|locate|pull\s+up|reach)(?:\s+(?:my|the|this|that|our|to|into|up))*\s*$/i;
// Straight after the name: "weekly digest off", "the weekly brief needs to stop", "weekly brief emails no more".
const OFF_AFTER = /^\s*(?:(?:file|page|link|email|text|message)s?)?[\s\-–—]*(?:(?:is|are|should|needs?\s+to|has\s+to|must|can|please|to)\s+)*(?:(?:be|get|go)\s+)?(?:off|no\s+more|stop(?:ped|s)?|paused?|cancel(?:l?ed)?|muted?|disabled?|end(?:ed|s)?|gone|away|skipped|skip|snoozed?|unsubscribe)\b/i;
// Another clause that points back at the File: a bare control ("please stop"), a control on "it" ("stop sending it", "turn it off"),
// or "don't send it", "I don't want them".
const STRONG = "pause|stop|turn\\s+off|cancel|unsubscribe|opt(?:ing)?[- ]out|skip|mute|silence|snooze|disable|quit|delete|remove";
const POINTS = "(?:it|them|that|this|those|these)\\b";
const FAR_OFF = new RegExp(`^\\W*(?:please\\s+|just\\s+)?(?:${STRONG}|off)(?:\\s+please)?\\W*$|\\b(?:${STRONG})\\s+(?:(?:sending|emailing|texting|messaging|getting|receiving)\\s+)?(?:me\\s+)?${POINTS}|\\bturn\\s+${POINTS}\\s+off\\b|\\bopt(?:ing)?[- ]out\\b|\\bunsubscribe\\b|\\bno\\s+more\\s+of\\s+${POINTS}|\\b(?:never|not|(?:do|does|did|wo|would)n'?t|no\\s+longer)\\s+(?:\\w+\\s+){0,2}?(?:send|want|need|show|give|text|email|message|get|receive|like)(?:\\s+(?:me|to\\s+(?:see|get|receive)))?\\s+${POINTS}`, "i");
// An ask to write or make something new is not an ask to open what is on record (review of #798: "make me a search plan for PM
// roles in NYC", "build a search plan" and "draft a counter plan" are the planning turn's). Review of #803: only when the File's
// name is the verb's OBJECT ("draft a counter plan"), not when the verb is somewhere else in the message ("show me my interview hub
// so I can prepare", "my materials page for the design role"), and when the message asks for a new one beside it ("and draft a new one").
const WRITE = "write|draft|compose|prep|prepare|practi[cs]e|mock|tailor|research|make|create|build|generate|plan|design|start|put\\s+together|come\\s+up\\s+with|set\\s+up|work\\s+(?:out|up)";
const WRITE_NEW = new RegExp(`\\b(?:${WRITE})\\b`, "i");
const WRITE_OBJECT = new RegExp(`\\b(?:${WRITE})(?:\\s+(?:me|us|a|an|the|my|our|new|another|one|up|out|quick|short|better|fresh|some|this|that|first|full|whole|different))*\\s*$`, "i");
const WRITE_ANOTHER = new RegExp(`\\b(?:${WRITE})\\s+(?:(?:me|us|a|an|up)\\s+)*(?:(?:new|another|different|fresh|updated)\\s+)?(?:one|version)\\b`, "i");
// "make me my weekly brief": the File is the person's own ("my", "the") and its page is drawn for everyone from what is on record
// (F-01, F-02, F-14 never answer "nothing on record"), so making it IS opening it (#798: "made from the chat when the ask calls for
// it"). "a search plan", "my search plan for consulting" and the plan families stay the planning turn's.
const MAKE_OWN = /\b(?:make|create|build|generate|put\s+together)(?:\s+(?:me|us))?\s+(?:my|the)\s*$/i;
const ALWAYS_DRAWN = new Set<MadeFamily>(["F-01", "F-02", "F-14"]);
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
// How the message stands to the File whose name `re` matches: "off" (a control or an opt-out governs it), "new" (it is the
// object of a verb that writes something new), "own" (an ask to make the person's own always-drawn File), "cant" (they can't reach it)
// or "" (none of these).
function standingOf(m: string, re: RegExp, family: MadeFamily, named: boolean): "off" | "new" | "own" | "cant" | "" {
  const clauses = m.split(CLAUSE_CUT).filter((c) => c && c.trim());
  const withName = clauses.filter((c) => re.test(c));
  if (clauses.some((c) => !re.test(c) && FAR_OFF.test(c))) return "off";
  let out: "new" | "own" | "cant" | "" = WRITE_ANOTHER.test(m.replace(re, " ")) ? "new" : "";
  for (const c of withName.length ? withName : [m]) {
    const at = re.exec(c)!;
    const pre = c.slice(0, at.index).replace(BENIGN, " "), post = c.slice(at.index + at[0].length);
    if (CTRL.test(pre) || OFF_AFTER.test(post) || FAR_OFF.test(post)) return "off";
    if (CANT_REACH.test(pre)) { out ||= "cant"; continue; }
    if (NEG.test(pre)) return "off";
    if (!(named ? WRITE_OBJECT : WRITE_NEW).test(named ? pre : c.replace(BENIGN, " "))) continue;
    out = out !== "new" && named && MAKE_OWN.test(pre) && ALWAYS_DRAWN.has(family) && !/^\s*(?:(?:file|page|link)\s+)?(?:for|about|on)\s+(?!me\b)/i.test(post) ? "own" : "new";
  }
  return out;
}
// The family the message asks to see as a File, or null. A File's own name with a verb to see it, a File word, or alone
// ("my weekly brief"); a generic phrase only with a File word and a verb to see it. Never a control, an opt-out or a new thing to
// make, each read from the clause that governs the File's name (standingOf). Genuinely mixed messages are null (the older routes).
export function familyAskOf(message: string): MadeFamily | null {
  const m = String(message ?? "").replace(/[’`]/g, "'").trim();
  if (!m || m.length > 600) return null;
  const named = NAMED.find(([, re]) => re.test(m));
  const hit = named ?? (FILE_WORD.test(m) && SEE.test(m) ? WITH_FILE_WORD.find(([, re]) => re.test(m)) : undefined);
  if (!hit) return null;
  const st = standingOf(m, hit[1], hit[0], !!named);
  if (st === "off" || st === "new") return null;
  return !named || st === "own" || st === "cant" || SHOW.test(m) || FILE_WORD.test(m) || m.split(/\s+/).length <= 4 ? hit[0] : null;
}
