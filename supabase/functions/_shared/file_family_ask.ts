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
// A non-null answer HOLDS the brain's turn to opening that File (career_staged.ts reason file_family_ask; career_brain.ts
// processCheck familyFile). So this reader FAILS CLOSED (review of #805: three rounds of "an ask unless a listed stop word is
// found" each sent the File to people who had asked for it to stop, in words the list did not have). It is an ALLOWLIST of whole
// messages: a family is returned only when the ENTIRE message, once normalised, is one of the shapes below. Any other word anywhere
// means null: an opt-out however it is worded, a new thing to make, a comparison, a question about something else, a second topic.
// A see-ask that is not one of the shapes is null too (it stays with the older routes, never held to the tool): a person who has to
// rephrase is a small cost, a person sent the thing they asked to stop is not.
//   polite   hey / please / thanks around the ask; "can you", "could you", "would you" before it
//   see      show | open | see | view | pull up | bring up | send | resend | give | get | share [me|us], "can i see|have|get|open",
//            "i want to|i'd like to|i need to|let me see|open|view|get|look at", "where is|where's", "what's in|on", "link to|for"
//   File     [my|the|that|our|this] + the File's own name [+ a File word], or a generic phrase WITH a File word ("my interviews
//            page", "the page with my profile", "a file comparing my offers")
//   tail     again, now, today, tonight, this morning, real quick, for me, here, in chat, on telegram|whatsapp|imessage,
//            by end of day, when you can
//   bare     the File's own name alone ("my weekly brief", "weekly brief?")
//   can't    "i can't find|open|see|get <File>", "i never got <File>", "<File> link doesn't open" [, send me the link]
//   + one clause, before or after, that says they can't reach it: "i can't find the link", "the old one doesn't work",
//     "i never got it", "you didn't send it", "i lost the link". Nothing else.
const alt = (...xs: string[]) => `(?:${xs.join("|")})`;
const FW = "(?:file|page|link|doc|document|one[- ]?pager|sheet|url)";
const DET = "(?:my|the|that|our|this)";
// A generic word names a File only with a word that means a Trainee page. "doc", "link" and "url" beside a generic word are other
// things (review of #805: "my draft doc" is a resume draft, "the interview link" a meeting link, "my profile url" LinkedIn).
const FW_PAGE = "(?:file|page|one[- ]?pager|sheet)";
// The File's own name, and the generic words for it that count only with a File word beside them.
const FAMILY_WORDS: [MadeFamily, string, string | null, string | null][] = [
  // family, own name, generic + File word after it, File word + "with|comparing ..." before it
  ["F-01", "career brief", null, null],
  ["F-02", alt("profile facts", "facts you have on file", "facts you have about me", "facts you have", "facts on file", "facts about me"), alt("profile", "facts"), `(?:with|of|for) ${alt("my profile", "my facts", "what you know about me")}`],
  ["F-03", "path comparison", null, `(?:comparing|that compares) (?:my|the) ${alt("paths", "directions")}`],
  ["F-04", "search plan", null, null],
  ["F-07", alt("materials? studio", "(?:resume|r[eé]sum[eé]|cover letter) versions"), "materials?", "(?:with|of|for) my materials"],
  ["F-08", alt("answer library", "saved answers"), "(?:saved |application )?answers", "(?:with|of|for) my (?:saved |application )?answers"],
  ["F-12", "message review", "(?:outreach |email )?(?:draft|message)", `(?:with|of|for) ${DET} (?:outreach |email )?(?:draft|message)`],
  ["F-13", "interview hub", "(?:upcoming )?interviews?", "(?:with|of|for) my (?:upcoming )?interviews?"],
  ["F-14", "weekly (?:brief|summary|digest|report)", null, null],
  ["F-14n", alt("negotiation plan", "counter(?:offer)? plan"), "negotiation", "(?:with|of|for) my negotiation"],
  ["F-15", "offer comparison", "offers", "(?:comparing|that compares) (?:my|the) offers"],
];
const POLITE = "(?:hey|hi|hello|ok|okay|please|pls|plz|thanks|thank you|thx|ty)";
const PRE = `(?:${POLITE}[,.!]? ){0,3}`;
const POST = `(?:[.?!,]? ${POLITE}){0,3}`;
const JUST = "(?:(?:please|pls|just) )?";
// Verbs asked OF Trainee ("send me ...") and verbs the person does ("can i see ..."): "can i send my weekly report" is neither.
const ASKED = alt("show", "open", "pull up", "bring up", "send", "resend", "give", "get", "share");
const DOES = alt("see", "view", "open", "get", "look at", "pull up");
const LINK_TO = `(?:${alt("the", "a", "my")} link (?:to|for) )?`;
const SEE_VERB = alt(
  `(?:(?:can|could|would|will) you )?${JUST}${ASKED}(?: (?:me|us))? ${LINK_TO}`,
  `${JUST}(?:see|view) ${LINK_TO}`,
  `(?:can|could|may) i ${JUST}(?:${DOES}|have) ${LINK_TO}`,
  `${alt("i want to", "i wanna", "i'd like to", "id like to", "i would like to", "i need to", "let me")} ${JUST}${DOES} ${LINK_TO}`,
  "where(?:'s|s| is) ", "what(?:'s|s| is) (?:in|on) ", "link (?:to|for) ",
);
const TAIL = `(?: ${alt("again", "now", "right now", "today", "tonight", "this morning", "real quick", "for me", "here", "in (?:the )?chat", "on (?:telegram|whatsapp|imessage)", "by (?:the )?end of (?:the )?day", "by eod", "when you can", "when you get a chance")}){0,3}`;
const NT = "(?:n't|nt| not)";
const CANT = `(?:ca${NT}|cannot|can not|could${NT})`;
const IT = alt("it", "the link", "that link", "the page", "the file");
// The closed list of statements that the person can't reach the File or its link (never a statement about wanting it or not).
const FAIL = alt(
  `(?:i )?${CANT} ${alt("find", "open", "see", "get", "access", "load")} ${IT}`,
  `${alt("it", "(?:the|that|my) (?:old |last )?(?:link|one|page|file)")} ${alt(`does${NT}`, "won't", "wont", "will not", `is${NT}`, `did${NT}`)} ${alt("work", "load", "open")}(?:ing)?`,
  `i ${alt("never", `did${NT}`, `have${NT}`)} ${alt("got", "get", "gotten", "received", "receive")} ${IT}`,
  `you ${alt(`did${NT}`, "never")} sen[dt] ${IT}`,
  `i lost ${IT}`,
);
const SEP = alt("[.?!,] (?:(?:and|but|because|cause|since) )?", " (?:and|but|because|cause|since) ");
const SHAPES: [MadeFamily, RegExp][] = FAMILY_WORDS.map(([family, own, generic, pageWith]) => {
  const named = `(?:${DET} )?${own}(?: ${FW})?`;
  const file = alt(named, ...(generic ? [`(?:${DET} )?${generic} ${FW_PAGE}`] : []), ...(pageWith ? [`(?:a|${DET}) ${FW} ${pageWith}`] : []));
  const see = `${SEE_VERB}${file}${TAIL}`;
  // The File they can't reach, said of the File itself, with nothing after it but an ask for the link.
  const cant = alt(
    `(?:i )?${CANT} ${alt("find", "open", "see", "get", "access", "load")} ${named}`,
    `(?:i )?${alt("never", `did${NT}`, `have${NT}`)} ${alt("got", "get", "gotten", "received", "receive")} ${named}(?: yet)?`,
    `${named} ${alt(`does${NT}`, "won't", "wont", "will not", `is${NT}`, `did${NT}`)} ${alt("work", "load", "open", "arrive", "come")}(?:ing)?`,
  ) + `(?:${SEP}${JUST}(?:re)?send (?:me )?${alt("it", "the link", "a link", "a new link", "a new one")}(?: again)?)?`;
  return [family, new RegExp(`^${PRE}${alt(`(?:${FAIL}${SEP})?${PRE}${alt(see, named)}${POST}(?:${SEP}${FAIL})?`, cant)}${POST}$`)];
});
// Defence in depth: none of these words is in any shape above, so each is null already; said outright so a later edit to a shape
// cannot let one through.
const HARD_NULL = /\b(?:stop\w*|unsub\w*|cancel\w*|paus\w*|mut(?:e|ed|ing)|off|quit\w*|opt(?:ing)?[- ]?out|no more|skip\w*|disabl\w*|delet\w*|remov\w*|eras\w*|wip(?:e|ed|ing))\b/;
// Case, apostrophe variants, dashes and whitespace made one; each run of punctuation one mark and one space; none at the end.
function normalised(message: string): string {
  return String(message ?? "").toLowerCase().replace(/[‘’ʼ´′`]/g, "'").replace(/[—–;:]|\s-\s/g, ", ")
    .replace(/\s*([.?!,])[.?!,\s]*/g, "$1 ").replace(/\s+/g, " ").trim().replace(/[.?!,]+$/, "").trim();
}
// The family the WHOLE message asks to see as a File, or null (see the allowlist above). Null is never "no": it only means this
// turn is not held to open_record_file.
export function familyAskOf(message: string): MadeFamily | null {
  if (typeof message !== "string" || message.length > 600) return null;
  const m = normalised(message);
  if (!m || HARD_NULL.test(m)) return null;
  return SHAPES.find(([, re]) => re.test(m))?.[0] ?? null;
}
// A record-backed File's own name is somewhere in the message (no shape asked of the rest). NOT an ask and never holds a turn to
// the tool: career_staged.ts uses it only to take a message the router read as a resume delivery ("no resume has been tailored")
// to the brain, which has open_record_file and the settings tools and decides for itself what the person meant.
const OWN_NAME = new RegExp(`\\b${alt(...FAMILY_WORDS.map(([, own]) => own))}\\b`);
export function fileNamedIn(message: string): boolean {
  return typeof message === "string" && message.length <= 600 && OWN_NAME.test(normalised(message));
}
