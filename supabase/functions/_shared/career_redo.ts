// REQS DOC 1 (Q83, Q196): a frustrated reply or "that's not what I asked", with nothing else in the message, answered by
// code: one line that owns the miss, what the last answer was taken as (from the record: the last reply's intent and the
// search it ran, never a guess), and one question that lets the person say what they wanted in a few words. Before this,
// these messages got the router's catch-all ("I'm not sure which part of your search that's about"), which reads as not
// listening. A message that carries the real ask after the complaint ("not what I asked, I want marketing roles") is the
// router's, which already re-runs on it; so is "that's wrong", which the router reads as a correction. Read only: nothing
// is changed, sent or undone here.
export const REDO_INTENT = "conversation_redo";

const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.…]+\s*$/, "").replace(/\s+/g, " ").trim()
  .replace(/^(?:(?:no|nope|nah|ugh+|bro|bruh|dude|man|omg|um+|hmm+)\b[,!.:]*\s+)+/, "")} `;
const MISS = [
  /^ (?:that'?s|that is|this is|thats) not what i (?:asked(?: for| you)?|meant|wanted|said|was asking(?: for)?)(?: at all)? $/,
  /^ not what i (?:asked(?: for)?|meant|wanted|said) $/,
  /^ (?:you'?re|you are|ur|u r|youre) not (?:listening|getting it|understanding(?: me)?|answering my question|helping) $/,
  /^ (?:are you|r u|are u) (?:even )?(?:listening|reading (?:my messages|what i (?:say|write)))(?: to me)? $/,
  /^ you (?:didn'?t|did not) (?:answer|get|read) (?:my question|the question|what i asked|it|that) $/,
  /^ (?:that|this) (?:didn'?t|doesn'?t|did not|does not) answer (?:my question|the question|what i asked|it) $/,
  /^ (?:you )?(?:misunderstood|misread)(?: me| that| what i (?:said|asked))? $/,
  /^ you got (?:it|that|me) wrong $/,
  /^ (?:that'?s|that is|this is|thats) not (?:it|right|helpful|what i need) $/,
  /^ (?:(?:that'?s|that is|this is|thats|that was|this was|you'?re|you are) )?(?:so |really |completely |totally )?(?:useless|not helpful|unhelpful|no help|pointless) $/,
  /^ (?:wrong answer|not helpful|wtf|ugh+|bruh|smh) $/,
];

export function redoAsk(message: string): boolean {
  const t = plain(message);
  return MISS.some((re) => re.test(t));
}

// What the last answer was, said from the record: the last reply's intent, and for a search the role it searched as
// the router kept it. Unknown: nothing is said about it.
// deno-lint-ignore no-explicit-any
export function lastAnswerAs(lastIntent: string | null | undefined, discovery: any): string | null {
  const i = String(lastIntent ?? "");
  if (!i) return null;
  if (/discovery|search|role_results|role_pay/.test(i)) {
    const role = String(discovery?.lastParams?.roleText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const where = String(discovery?.lastParams?.whereText ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return role ? `a job search for ${role}${where ? ` in ${where}` : ""}` : "a job search";
  }
  if (/apply_status|overview|waiting_on_you|standing|activity/.test(i)) return "a status check on your applications";
  if (/resume|tailor/.test(i)) return "a resume request";
  if (/^prep_|mock/.test(i)) return "interview prep"; // prep_* and the mock turns; packet_prep is an application packet, not prep
  if (/outreach|networking|email/.test(i)) return "an email or networking request";
  if (/offer|negotiat|salary|pay/.test(i)) return "an offer or pay question";
  if (/catchall|fallback/.test(i)) return "something I couldn't place";
  return null;
}

export function redoTurn(o: { message: string; lastIntent: string | null | undefined; discovery?: unknown }): { reply: string; status: string; intent: string } | null {
  if (!redoAsk(o.message)) return null;
  const as = lastAnswerAs(o.lastIntent, o.discovery);
  const lines = ["You're right, that answer missed what you asked."];
  if (as) lines.push(`I took your last message as ${as}.`);
  lines.push("What did you want instead? A few words is enough, like the role and city or the task, and I'll redo it now.");
  return { reply: lines.join(" "), status: as ? "asked" : "asked_unknown", intent: REDO_INTENT };
}
