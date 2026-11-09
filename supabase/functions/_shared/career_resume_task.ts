// R10 WO-A + WO-B (owner order 2026-11-09; spec docs/architect/specs/APP-LAYER-15-FIXES.md A.2 resume turns 1-3, B.1, B.4,
// B.6, E.1, E.4, E.6): the resume as ONE task that keeps its target.
//
// A resume ask that names a target ("a clean one-page PDF for data analyst internships") and no posting makes a general
// version for that target, now: it never says there is no file, and never tailors to the first role of an old list. The
// target, its level and place, and the person's limits (one page, facts as written, no new experience, don't apply) are
// kept on the profile (_resumeTask) and carried to every later turn of the task. A correction ("that's the wrong role")
// repairs the task: the mismatch is owned once and the file is made again for the right target; "send a download link"
// gets one; "don't apply" is a boundary, never an apply or batch ask. "Send this one" with a resume and job cards both on
// the screen gets one two-choice question and no action until it is settled.
//
// Facts: only the person's own, as written (confirmed facts; with none confirmed, the saved intake, said to be unconfirmed).
// A GPA the record states twice with different values is left off and asked about; a name or email not on file prints as a
// flagged placeholder and is asked for. Each missing or conflicting fact is ONE narrow question.
//
// Files: the PDF (and the DOCX only when asked for) ride the reply as documents (channel_artifacts.ts) and the PDF is kept in
// a resume File (file_kinds.ts draft variant "resume") opened only on the signed-in File page: a link is sent only when asked for, and
// never a bearer link to the bytes (privacy ruling, 2026-11-09). The words are read back out of the PDF
// before it is offered: a file that does not carry exactly the lines built for it is not sent. No reply claims a check, an
// attachment or a format that is not delivered.
import { CareerProfile, CareerRender } from "./router_core.career.js";
import { type Block, renderBlocks, splitDates } from "./career_resume_design.ts";
import { auditRewrite } from "./career_tailor_rewrite.ts";
import { CONTACT_QUESTION, resumeContact } from "./career_tailor.ts";

export const RESUME_TASK_INTENT = "career_resume_task";
export const RESUME_CLARIFY_INTENT = "career_resume_clarify";
export const TASK_TTL_MS = 24 * 3600_000;
// Over [before, after] pairs: the stored copy comes back from jsonb with its keys reordered, the words do not change.
const proposalHash = async (xs: { before: string; after: string }[]) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(xs.map((x) => [x.before, x.after])))))].map((x) => x.toString(16).padStart(2, "0")).join("");
type Target = { role: string; level: string | null; label: string };
export interface ResumeTask {
  target: Target; limits: string[]; rejected: string | null; said: string[]; asked: string[];
  file: { sha256: string; filename: string; pages: number; label: string } | null; pending: "send_choice" | "fact_detail" | "target_which" | null; at: string;
  // B.6 continuation 1: the order changes of the last build, a bullet rewrite shown and not yet approved, and the approved ones.
  moved?: string[]; proposed?: { before: string; after: string }[] | null; swaps?: { before: string; after: string }[];
  // Re-review of #644 (1): an approval binds to the exact rewording shown (its hash) and to the turn right after it; the fact a
  // "new job" turn asked about, so its answer is kept.
  proposedHash?: string | null; lastAsk?: string | null; factId?: string | null;
  // Round 5 ruling: an unclear target ("the Quillstone role", nothing on hand) is asked once; the answer is kept for the task.
  which?: { name: string; target: Target } | null; fields?: string[]; employers?: string[];
}
type Doc = { kind: "document"; format: string; filename: string; mime: string; base64: string; sha256: string };
export type ResumeTurn = { reply: string; intent: string; resultStatus: string; documents: Doc[]; link: string | null; task: ResumeTask };

const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'");
const ROLE = "(?:internships?|interns?|analysts?|engineers?|scientists?|developers?|designers?|managers?|associates?|consultants?|specialists?|coordinators?|researchers?|accountants?|traders?|nurses?|teachers?|writers?|recruiters?|paralegals?|roles?|jobs?|positions?)";
const FIELD = /^(data|business|financial|finance|product|marketing|software|research|operations|ops|sales|analytics|analyst|analysts|machine|learning|ml|ai|engineering|engineer|engineers|scientist|scientists|science|developer|developers|designer|designers|ux|ui|manager|managers|associate|associates|consultant|consultants|specialist|specialists|coordinator|coordinators|researcher|researchers|accountant|accountants|accounting|investment|banking|quantitative|quant|policy|strategy|supply|chain|people|hr|legal|healthcare|health|climate|frontend|front-end|backend|back-end|full-stack|fullstack|web|mobile|cloud|security|devops|qa|test|economics|statistics|reporting|bi|intelligence|junior|senior|entry-level|graduate|summer|fall|spring|remote|hybrid|technical|it|support|customer|success|growth|content|communications|design|venture|capital|equity|private|public|tech|technology|platform|management|consulting|trading|trader|traders|nursing|nurse|nurses|teaching|teacher|teachers|education|law|paralegal|paralegals|medicine|medical|clinical|pharmacy|biotech|biology|chemistry|physics|mathematics|math|nonprofit|government|journalism|writing|writer|writers|editorial|media|publishing|retail|hospitality|real|estate|insurance|actuarial|audit|tax|wealth|asset|risk|compliance|hardware|electrical|mechanical|civil|chemical|aerospace|manufacturing|logistics|procurement|recruiting|recruiter|recruiters|talent|administration|administrative|project|program|partnerships|events|social|digital|brand|advertising|pr|relations|user|game|games|gaming|film|music|arts|architecture|environmental|energy|sustainability|agriculture|food|nutrition|sports|entry|level|new|grad|computer|economic|international|corporate|commercial|retail|sales|account|executive|executives|client|services|service|fintech|cybersecurity|cyber|robotics|blockchain|crypto|web3|edtech|healthtech|medtech|proptech|insurtech|cleantech|climatetech|pharma|pharmaceutical|ui\/ux|ux\/ui|sre|esg|nlp|llm|iot|embedded|semiconductor|semiconductors|quantum|animation|fashion|beauty|underwater|basket|weaving|crafts|woodworking|ceramics|automotive|maritime|aviation|telecom|biomedical|neuroscience|genomics|bioinformatics|geospatial|gis|devrel|localization|translation)$/;
const NOT_TARGET = /\b(resume|cv|pdf|docx|file|page|version|draft|that|this|it|one)\b/;
// What is rejected ("not a machine learning manager job at Reddit") is taken out before the target is read.
function rejectedOf(message: string): string | null {
  const m = /\bnot (?:an? |the )?([a-z][a-z0-9 &/+.-]{2,80}?)(?=[,.;!?]|$| please| since| and )/.exec(lc(message));
  return m ? String(message).slice(m.index + m[0].length - m[1].length, m.index + m[0].length).trim() : null;
}
// R1 (owner readiness review): any stated target is the person's target, with or without a role word ("for product management",
// "for consulting roles", "for trading"). Only an employer named in front of a role ("the Quillstone data analyst intern role")
// makes it a posting, which is the posting tailor's.
const GENERIC = /^(internships?|interns?|roles?|jobs?|positions?)$/;
const LEADS_TO = `(?:for|is|as|asked for|toward|towards|targeting|aimed at)\\s+(?:an? |the |some )?`;
// Architect ruling (round 5; spec E.4, ask when ambiguous, never guess), in this order:
// 1. every word of the phrase (generic words aside) is in the field vocabulary, or a field the person named for this task:
//    a TARGET, whatever its capitalisation ("Fintech internships", "Robotics roles");
// 2. the phrase (generic words aside), or the name in front of its field words, EQUALS an employer on hand (the last job list,
//    a pool company, one the person named for this task) or a well-known employer, whole name and case-insensitive (never a
//    substring: "robotics" is not "Boston Robotics"): a POSTING, the posting tailor's or 142's named-firm reply;
// 3. anything else: ASK once, "roles at X (a company), or X as a field?", and build nothing until it is answered.
const KNOWN_EMPLOYERS = ["ibm", "mckinsey", "google", "alphabet", "meta", "facebook", "amazon", "apple", "microsoft", "netflix", "stripe",
  "goldman sachs", "goldman", "jpmorgan", "jpmorgan chase", "jp morgan", "morgan stanley", "citi", "citigroup", "bank of america", "wells fargo",
  "blackrock", "deloitte", "pwc", "ey", "kpmg", "accenture", "bain", "bcg", "boston consulting group", "nvidia", "tesla", "salesforce", "oracle",
  "adobe", "intel", "uber", "airbnb", "spotify", "palantir", "openai", "anthropic", "reddit", "linkedin", "citadel", "jane street", "two sigma",
  "bloomberg", "pfizer", "ramp"];
const CORP = /^(inc|llc|ltd|corp|corporation|co|company|group|labs|lab|technologies|holdings|plc|the|&)$/;
// An employer's names, for equality: as written, without its corporate suffix, and without its trailing field words
// ("Quillstone Analytics" is also "quillstone").
const keysOf = (name: string) => {
  const ws = lc(name).replace(/[^a-z0-9& ]+/g, " ").split(/\s+/).filter(Boolean);
  const bare = ws.filter((w, i) => !(CORP.test(w) && (i > 0 || w === "the")));
  const out = new Set([ws.join(" "), bare.join(" ")]);
  const stem = [...bare]; while (stem.length > 1 && FIELD.test(stem[stem.length - 1])) stem.pop();
  out.add(stem.join(" "));
  return [...out].filter(Boolean);
};
const keyCache = new WeakMap<string[], Set<string>>();
const employerKeys = (names: string[]) => {
  let k = keyCache.get(names);
  if (!k) keyCache.set(names, k = new Set([...KNOWN_EMPLOYERS, ...names].flatMap(keysOf)));
  return k;
};
export type TargetRead = { kind: "target"; target: Target } | { kind: "posting"; name: string } | { kind: "ask"; name: string; target: Target };
export type TargetHints = { employers?: string[]; fields?: string[] };
export function readTarget(message: string, hints: TargetHints = {}): TargetRead | null {
  const employers = employerKeys(hints.employers ?? []), fields = new Set((hints.fields ?? []).flatMap((f) => lc(f).split(/\s+/)));
  const known = (w: string) => FIELD.test(w) || new RegExp(`^${ROLE}$`).test(w) || fields.has(w);
  const t = lc(message).replace(/\bnot (?:an? |the )?[a-z][a-z0-9 &/+.-]{2,80}?(?=[,.;!?]|$| please| since| and )/g, " ");
  const withRole = new RegExp(`\\b${LEADS_TO}((?:[a-z][a-z&/+-]*\\s+){0,4}?${ROLE}(?:\\s+${ROLE})*)\\b`, "g");
  const fieldOnly = new RegExp(`\\b${LEADS_TO}((?:[a-z][a-z&/+-]*\\s+){0,3}[a-z][a-z&/+-]*)(?=\\s*(?:[,.;!?]|$|\\s(?:please|and|since|now|instead)\\b))`, "g");
  const read = (phrase: string, needField: boolean): TargetRead | null => {
    const words = phrase.trim().split(/\s+/);
    if (words.some((w) => NOT_TARGET.test(w)) || words.length < 2 && /^(roles?|jobs?|positions?)$/.test(words[0])) return null;
    const level = /\bintern/.test(phrase) ? "internship" : /\b(senior|lead|manager|director|principal|staff)\b/.test(phrase) ? "senior" : null;
    const role = words.filter((w) => !GENERIC.test(w)).join(" ");
    if (!role) return null;
    const ws = role.split(" ");
    const target = { role, level, label: level === "internship" ? `${role} internships` : `${role} roles` };
    if (ws.every(known)) return { kind: "target", target };
    const firstKnown = ws.findIndex(known);
    const lead = (firstKnown < 0 ? ws : ws.slice(0, firstKnown)).join(" ");
    const restKnown = ws.slice(lead.split(" ").length).every(known);
    if (employers.has(role) || restKnown && employers.has(lead)) return { kind: "posting", name: employers.has(role) ? role : lead };
    if (needField) return null;
    return { kind: "ask", name: restKnown ? lead : ws.filter((w) => !known(w)).join(" "), target };
  };
  for (const m of t.matchAll(withRole)) { const r = read(m[1], false); if (r) return r; }
  for (const m of t.matchAll(fieldOnly)) { const r = read(m[1], true); if (r) return r; }
  return null;
}
export const postingTarget = (message: string, hints: TargetHints = {}) => readTarget(message, hints)?.kind === "posting";
export function targetOf(message: string, hints: TargetHints = {}): Target | null { const r = readTarget(message, hints); return r?.kind === "target" ? r.target : null; }
// The pool is read for any ask that would otherwise be decided by rule 2 or 3 (an unknown word in the stated target).
const needsEmployers = (message: string) => readTarget(message)?.kind === "ask";
const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const LIMITS: [string, RegExp][] = [
  ["one_page", /\b(one|1|single)[- ]page\b/], ["facts_as_written", /\b(facts as written|keep the facts|don'?t (add|invent|change)|do not (add|invent))\b/],
  ["no_new_experience", /\b(don'?t|do not) add (any )?experience\b/], ["no_apply", /\b(don'?t|do not|never) (apply|submit)\b|\bnot apply\b/],
  ["ask_first", /\bask me\b/], ["no_gpa", /\b(leave|keep) (the |my )?gpa off\b|\b(no|drop|remove|omit) (the |my )?gpa\b/],
];
// A message that says not to apply, or to leave the job search, is a boundary: nothing is queued, prepared or sent on it.
export const noApplyAsk = (message: string) => /\b(don'?t|do not|never) (apply|submit)\b|\bnot apply\b|\bleave the (job )?search\b|\bnot asking for an application\b/.test(lc(message));
// Review of #634 (e): a parser's pass is not evidence for the person, so "parse check PASS" goes; a failed check is said in plain words.
export const parseCheckWords = (x: string) => x
  .replace(/\s*(?:—|-|,)\s*(?:the\s+)?parse check (?:FAIL|failed)\b/gi, ", but an applicant tracking system may not read it correctly, so check the file before you use it")
  .replace(/\s*(?:—|-|,)\s*(?:the\s+)?parse check (?:PASS|passed|WARN|ran)\b/gi, "");
export const limitsOf = (message: string) => LIMITS.filter(([, re]) => re.test(lc(message))).map(([k]) => k);

const RESUME = /\b(resume|résumé|cv)\b/;
const MAKE = /\b(turn|make|tailor|create|generate|build|format|redo|regenerate|rewrite|fix|update|clean|send|give|produce)\b/;
const DOC = /\b(pdf|docx|word file|one[- ]page|file|document|draft|version)\b/;
const CORRECTION = /\b(wrong (role|job|target|position|resume|one|version)|fix the (target|role)|not what i asked|that'?s not (the|my) (role|target))\b/;
// Review of #634 (c): a link to the PDF, resume or file only; a posting or page link is never the resume task's.
const LINK = /\b(download link|link (to|for) (the |my |this |that )?(pdf|resume|cv|file|document|attachment)|(pdf|resume|file|attachment) link|(attachment|pdf|file)\b[^.?!]{0,20}\b(isn'?t|won'?t|can'?t|doesn'?t|not) (open|opening|load|loading))\b/;
const SEARCH = /\b(leave the resume|find me|search for|look for|looking for|show me)\b[^.?!]*\b(jobs?|roles?|internships?|openings?|postings?)\b/;
const NEW_FACT = /\b(?:update|add)\b[^.?!]*\b(?:resume|cv)\b[^.?!]*\b(?:my )?new (?:job|role|position|internship) (?:at|with) ([A-Za-z0-9&.'() -]{2,60})/;
// Re-review of #644 (7): a number is a job number only with a cue ("job 2", "#2", "number 2", "the 2nd one"); "the 1 page version" is not.
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
export function jobNumberOf(t: string): number | null {
  const m = /(?:\bjob\s*(?:#|no\.?|number)?\s*|#\s*|\bnumber\s+|\bno\.\s*)(\d{1,2})\b|\bthe\s+(\d{1,2})(?:st|nd|rd|th)\s+(?:one|job)\b|\bthe\s+(first|second|third|fourth|fifth)\s+(?:one|job)\b/.exec(t);
  return m ? Number(m[1] ?? m[2] ?? ORD[m[3]]) : null;
}
const RESTYLE = /^\s*(?:can you |could you |please |ok(?:ay)?,? )?(?:make|keep) (?:it|this|that)(?: a (?:bit|little|touch))?(?: more| less)? (?:warmer|friendlier|friendly|shorter|tighter|punchier|formal|casual|concise|wordy|clearer|stronger|professional|crisper|confident|simpler|direct)\b[^?]*[.!]?\s*$/;
const AMBIGUOUS = /^\s*(?:please\s+|ok(?:ay)?,?\s+)?send (?:this|that|it)(?: one)?(?: now)?\s*[.!]?\s*$/;
// A posting named or pasted is the posting tailor's (142 career_tailor), not a general version.
function postingNamed(t: string, companies: string[]): boolean {
  if (/\b(this posting|the posting|job (#|number )?\d|number \d|#\d|(role|position|job|opening) at)\b/.test(t)) return true;
  if (t.length > 600 && /\b(requirements|qualifications|responsibilities)\b/.test(t)) return true;
  return companies.some((c) => c.length > 2 && new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}
const BARE = /^\s*(?:yes|yeah|yep|yup|no|nope|nah|ok(?:ay)?|sure|right|correct|fine)\s*[.!]*\s*$/;
const ROLE_WORD = /\b(?:analyst|engineer|intern|associate|manager|developer|designer|scientist|consultant|assistant|coordinator|specialist|lead|director|researcher|technician|representative|officer|administrator|teacher|tutor|barista|cashier|server|clerk|writer|editor|accountant|fellow|trainee|apprentice|founder|volunteer|president|treasurer|architect|programmer|strategist|planner|advisor|agent|operator|partner|aide|instructor|counselor|nurse|chef|cook|driver|recruiter|vp|cto|ceo|coo|cfo)s?\b/;
const NOT_TITLE = /\?|^\s*(?:what|how|why|who|when|where|which|can|could|would|do|does|did|is|are|will|should|find|search|show|look|get|send|tell|make|list|give|apply|submit|help|stop|cancel|leave|update|add|tailor|turn|create|generate)\b|\b(?:jobs?|roles?|internships?|openings?|postings?|resume|cv|pdf|file|link)\b/;
const CHAT_WORD = /^\s*(?:thanks?|thank you|ty|great|perfect|cool|hello|hi|hey|wait|lol|lmao|nice|awesome|got it|sounds good|amazing|wow|hmm+|ha+|oops|sorry)\b/;
// A title or role, with or without when it started: "Analyst since May", "Data Analyst, started June 2026", "Sous Chef".
export const titleShaped = (message: string) => {
  const s = message.trim().replace(/^(?:ok(?:ay)?|yes|sure|so)[,!. ]+/i, "").replace(/[.!]+$/, "");
  if (!s || BARE.test(lc(s)) || s.length > 100 || s.split(/\s+/).length > 12 || NOT_TITLE.test(lc(s))) return false;
  if (CHAT_WORD.test(lc(s))) return false;
  // Round 3 (1a): one word is a title only if it is a title word ("Analyst"); "Thanks", "Perfect", "LOL" are not.
  if (s.split(/\s+/).length === 1) return ROLE_WORD.test(lc(s));
  return ROLE_WORD.test(lc(s)) || /^[A-Z][\w&.'-]*(?:\s+(?:of|&|[A-Z][\w&.'-]*)){0,4}(?:,?\s+(?:since|from|starting|started)\b.*)?$/.test(s);
};
export type ResumeAsk = "target_which" | "target_field" | "target_company" | "fact_detail" | "submit_job" | "new_fact" | "make" | "correct" | "link" | "ask_send" | "send_pdf" | "explain" | "edit" | "restyle" | "approve_edit" | "why_contact" | "apply_which" | null;
export function resumeAskOf(message: string, task: ResumeTask | null, view: { companies: string[]; employers?: string[]; jobs: number; posting: boolean; lastFile?: boolean; resumeShown?: boolean }): ResumeAsk {
  // A pasted resume or posting is material, not an ask about the resume task (its own words say "for", "file", "update").
  if (message.length > 600 || message.split("\n").filter((l) => l.trim()).length > 4 || /^\s*(here'?s|here is|this is|my) (my |the )?(resume|cv)\b/i.test(message)) return null;
  const t = lc(message), rest = t.replace(/\bnot (?:an? |the )?[a-z][a-z0-9 &/+.-]{2,80}?(?=[,.;!?]|$| please| since| and )/g, " ");
  // The answer to the "new job" question ("ok, Analyst since May"): kept with that fact, never read as a yes to anything else.
  // Round-2 re-review (1a): only an answer shaped like a title or role is kept; a bare yes or no is asked again, and a search, a
  // question or any other ask leaves this question and runs as itself.
  if (task?.pending === "target_which" && view.resumeShown) {
    if (/\b(compan(y|ies)|employer|firm|business|work (there|at)|at (them|it)|the org)\b/.test(t)) return "target_company";
    if (/\b(field|industry|area|sector|kind of (work|role)|type of (work|role)|in general|generally)\b/.test(t)) return "target_field";
  }
  if (task?.pending === "fact_detail" && view.resumeShown && (BARE.test(t) || titleShaped(message))) return "fact_detail";
  if (task?.pending === "send_choice") {
    // Example 4's other answer: "Submit job 2" names the application; its exact payload is reviewed before anything is sent.
    if (/\b(submit|apply)\b/.test(t) && jobNumberOf(t) !== null) return "submit_job";
    if (/\b(submit|apply)\b/.test(t)) return null;
    if (/\b(pdf|resume|to me|the file|download|send it to me)\b/.test(t)) return "send_pdf";
  }
  if (AMBIGUOUS.test(t) && task?.file) return view.jobs > 0 || task.limits.includes("no_apply") ? "ask_send" : "send_pdf";
  if (task?.proposed && (task.lastAsk === "edit" || task.lastAsk === "restyle") && view.resumeShown && /\b(fine|good|ok(ay)?|yes|use (it|that)|approve)\b/.test(t) && !/\b(no|not|don'?t)\b/.test(t)) return "approve_edit";
  if (task?.file && /\bbullet\b/.test(t) && /\b(less wordy|shorter|shorten|tighten|trim|concise|simplify)\b/.test(t)) return "edit";
  // A bare follow-up ("Make it warmer.") right after the resume was shown is about that resume, never a fresh tailor.
  if (task?.file && view.resumeShown && RESTYLE.test(t)) return "restyle";
  if (task && /\bwhy\b/.test(t) && /\b(placeholders?|to fill in|to add)\b|\bcontact\b[^?.!]*\b(resume|pdf|file|top)\b/.test(t)) return "why_contact";
  if (task?.file && /\bwhat (did|have) you change(d)?\b|\bwhat changed\b/.test(t)) return "explain";
  if (task?.file && /^\s*(now |ok(ay)?,? |then )?apply (with|using) (it|this|that)\s*[.!]?\s*$/.test(t)) return "apply_which";
  const hints = { employers: [...(view.employers ?? view.companies), ...(task?.employers ?? [])], fields: task?.fields ?? [] };
  const read = AMBIGUOUS.test(t) ? null : readTarget(message, hints);
  if (read?.kind === "posting") return null;
  if (read?.kind === "ask" && RESUME.test(t) && (MAKE.test(t) || DOC.test(t)) && !(/\b(apply|submit)\b/.test(t) && !noApplyAsk(message))) return "target_which";
  const target = targetOf(message, hints);
  // A correction or a link ask about the resume file this person was last given (ours, or the posting tailor's).
  const onFile = !!task || !!view.lastFile && !!target;
  // A cover letter, a job search and an apply are their own paths; a correction is this task's only about the resume's target.
  if (/\bcover letters?\b/.test(t) || SEARCH.test(t) && !/\b(resume|cv|pdf)\b[^.?!]*\b(make|turn|tailor|generate)\b/.test(t)) return null;
  const wantsApply = /\b(apply|submit)\b/.test(t) && !noApplyAsk(message);
  if (task && NEW_FACT.test(message.toLowerCase()) && !wantsApply) return "new_fact";
  if (onFile && CORRECTION.test(t) && !wantsApply && (view.resumeShown || /\b(resume|cv|pdf|target)\b/.test(t)) && !postingNamed(rest, view.companies)) return "correct";
  if ((task?.file || onFile) && LINK.test(t) && !postingNamed(rest, view.companies)) return "link";
  if (view.posting || postingNamed(rest, view.companies)) return null;
  if (RESUME.test(t) && (MAKE.test(t) || DOC.test(t)) && (target || task) && !wantsApply) return "make";
  return null;
}

// ---------------------------------------------------------------- the record, as written
// deno-lint-ignore no-explicit-any
type Fact = any;
const SECTION: Record<string, string> = { education: "Education", experience: "Experience", project: "Projects", leadership: "Leadership", certification: "Certifications" };
// Every way a GPA is written (review of #634 (d)): "GPA 3.7", "GPA: 3.7", "GPA of 3.7", "3.7 GPA", "GPA 3.7/4.0", "3.7/4.0 GPA",
// "3.7 cumulative GPA". The values are read by gpaValues; the scale ("/4.0") goes with it when it is taken off.
// Re-review of #644 (2): the scale in any form ("/4.0", "out of 4", "(4.0 scale)") goes with the value and is never read as one;
// "Cumulative"/"Overall" and a dash or colon after "GPA" go with it too.
// Round-2 re-review of #644 (2): a full stop after the value or the scale ("GPA 3.8.", "GPA 3.8/4.0.") is the sentence's, not
// part of a number; "Major GPA 3.9, overall 3.6" reads the overall value and comes off whole; "on a 4.0 scale", "(GPA: 3.8)",
// "GPA (cumulative): 3.8" and "CGPA 3.8" are GPA phrases too. "3.8/4.0" with no GPA word is not one.
const NUM = "\\d\\.\\d{1,2}(?!\\d)(?!\\.\\d)";
const SCALE_N = "\\d(?:\\.\\d{1,2})?(?!\\d)(?!\\.\\d)";
const SCALE = `(?:\\s*(?:\\/|out\\s+of)\\s*${SCALE_N})?(?:\\s*\\(\\s*(?:on\\s+an?\\s+)?${SCALE_N}\\s*(?:-?\\s*point\\s+)?scale\\s*\\)|\\s+on\\s+an?\\s+${SCALE_N}\\s*(?:-?\\s*point\\s+)?scale\\b)?`;
const LEAD = "(?:\\b(?:cumulative|overall|major)\\s+)?";
const LEAD_C = "(?:\\b(cumulative|overall|major)\\s+)?";
const WORD = "\\bC?GPA(?:\\s*\\(\\s*(?:cumulative|overall|major)\\s*\\))?";
const GPA_SRC = `${LEAD_C}${WORD}\\s*(?:of\\s*|[-–—:]\\s*)?(${NUM})${SCALE}(?:\\s+(?:and|or|&)\\s+(${NUM})${SCALE})?(?:\\s*[,;]?\\s*(?:and\\s+)?(overall|cumulative|major)(?:\\s+C?GPA)?\\s*(?:of\\s*|[-–—:]\\s*)?(${NUM})${SCALE})?|\\b(${NUM})${SCALE}\\s*${LEAD}C?GPA\\b`;
const GPA = new RegExp(GPA_SRC, "gi");
// In parentheses the parentheses go with it; otherwise the comma before it does.
const GPA_OFF = new RegExp(`\\s*\\(\\s*(?:${GPA_SRC})\\s*\\)|,?\\s*(?:${GPA_SRC})`, "gi");
// Groups: 1 the first label, 2 its value, 3 a second value with no label ("GPA 3.6 and 3.8"), 4 the second label, 5 its
// value, 6 the value of "3.8 GPA". The overall value wins over a major value, in either order; an unlabelled second value is
// read too, so two values written together are a conflict.
const gpaValues = (m: RegExpMatchArray) => [m[5] && /overall|cumulative/i.test(m[4] ?? "") ? m[5] : m[2] ?? m[6], m[3]].filter(Boolean) as string[];
const gpaOff = (s: string) => s.replace(GPA_OFF, "").replace(/\(\s*\)/g, "").replace(/\s+([,.;])/g, "$1").replace(/([,;])\s*([,.;])/g, "$2")
  .replace(/\s{2,}/g, " ").replace(/^[,;.\s]+|[,;\s]+$/g, "").trim();
const textOf = (f: Fact) => `${f.title || ""} ${f.text || ""} ${(f.bullets || []).join(" ")}`;
// Words that make an entry relevant to the target: the target's own words and the family's usual evidence.
function scorer(target: Target): (f: Fact) => number {
  const words = target.role.split(/\s+/).filter((w) => w.length > 2);
  const family = /analy|data|business/.test(target.role) ? ["data", "analy", "sql", "python", "excel", "dashboard", "report", "statistic", "model", "tableau", "postgres", "metric"]
    : /engineer|developer|software/.test(target.role) ? ["built", "python", "java", "go", "react", "deploy", "api", "kubernetes", "aws"] : [];
  return (f) => { const x = lc(textOf(f)); return [...words, ...family].reduce((n, w) => n + (x.includes(w) ? 1 : 0), 0); };
}
// A skill read with its label still on it ("Skills: Python", "Interests: Coding"): the label is the person's, kept as theirs.
function skillLines(skills: Fact[]): { label?: string; text: string; group: string }[] {
  const groups = new Map<string, string[]>();
  for (const f of skills) {
    const raw = String(f.name || f.title || f.text || "").trim();
    const m = /^(skills?|technical|interests?|certifications?|languages?|tools?)\s*:\s*(.+)$/i.exec(raw);
    const label = m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()).replace(/^Skill$/, "Skills") : "Skills";
    const v = (m ? m[2] : raw).trim();
    if (v) groups.set(label, [...(groups.get(label) ?? []), v]);
  }
  // A.4's run-in labels (Technical:, Certifications:, Interests:); a lone group of plain skills needs none.
  return [...groups].map(([k, v]) => ({ group: k, text: v.join(", "), ...(groups.size === 1 && k === "Skills" ? {} : { label: `${k === "Skills" ? "Technical" : k}:` }) }));
}
const printedOf = (bs: Block[]) => bs.flatMap((b) => [...(b.label ? [b.label] : []), b.text, ...(b.right ? [b.right] : [])]);
export interface Built { blocks: Block[]; lines: string[]; gpaConflict: string[] | null; contactMissing: boolean; unconfirmed: boolean; left: string[]; moved: string[]; facts: { text: string; fact: Fact }[] }
const short = (s: string) => String(s).split(/,| - | \(/)[0].trim();
// deno-lint-ignore no-explicit-any
export function buildResume(profile: any, target: Target, uploaded: boolean, o: { noGpa?: boolean; swaps?: { before: string; after: string }[] } = {}): Built {
  const confirmed = (CareerProfile.confirmedFacts(profile || {}) as Fact[]).filter((f) => f.status !== "draft");
  const unconfirmed = !confirmed.length;
  // R3a (D-007): with nothing confirmed, the saved intake is used, but never a quarantined (agent-invented) fact.
  const facts: Fact[] = unconfirmed ? (profile?.facts || []).filter((f: Fact) => f && f.kind && !CareerProfile.quarantinedFact(f)) : confirmed;
  // The values as written, one per number (3.7 and 3.70 are one value).
  const byValue = new Map<number, string>();
  for (const f of facts) for (const m of textOf(f).matchAll(GPA)) for (const v of gpaValues(m)) if (!byValue.has(Number(v))) byValue.set(Number(v), v);
  const gpas = [...byValue.values()];
  const gpaConflict = gpas.length > 1 && !o.noGpa ? gpas : null;
  const asWritten = (s: string) => gpaConflict || o.noGpa ? gpaOff(s) : s;
  const top = resumeContact(profile, "confirmed");
  const contactMissing = !top.name || !top.email;
  const blocks: Block[] = [], moved: string[] = [], bullets: { text: string; fact: Fact }[] = [];
  blocks.push(top.name ? { kind: "name", text: top.name } : { kind: "name", text: "[Your name]", flag: true });
  const line = profile?.resume_header?.contactLine || [profile?.basics?.location, top.email, profile?.basics?.phone].filter(Boolean).join(" | ");
  if (!contactMissing && line) blocks.push({ kind: "contact", text: String(line) });
  else blocks.push({ kind: "contact", text: "[email · phone · LinkedIn to add]", flag: true });
  const score = scorer(target);
  // A student target leads with education; everything else leads with experience. Within a section, the entries that show
  // the target's work come first (a stable order otherwise: the person's own).
  const order = target.level === "internship" ? ["education", "experience", "project", "leadership"] : ["experience", "project", "education", "leadership"];
  for (const kind of order) {
    const xs = facts.filter((f) => f.kind === kind).map((f, i) => ({ f, i, s: score(f) })).sort((a, b) => b.s - a.s || a.i - b.i);
    if (!xs.length) continue;
    xs.forEach((x, k) => { if (x.i > k) moved.push(`${short(x.f.title || x.f.text)} above ${short(xs.find((y) => y.i === k)!.f.title || "")}`); });
    blocks.push({ kind: "heading", text: SECTION[kind] });
    for (const { f } of xs) {
      blocks.push({ kind: "entry", ...splitDates(asWritten(String(f.title || f.text))) });
      for (const b of (f.bullets?.length ? f.bullets : (f.text && f.text !== f.title ? [f.text] : []))) {
        const own = asWritten(String(b)), swap = (o.swaps ?? []).find((x) => x.before === own);
        blocks.push({ kind: "bullet", text: swap ? swap.after : own });
        if (kind !== "education") bullets.push({ text: swap ? swap.after : own, fact: f });
      }
      if (kind === "education" && gpaConflict && new RegExp(GPA.source, "i").test(textOf(f))) blocks.push({ kind: "line", text: "GPA omitted: conflicting source values need confirmation before use.", flag: true });
    }
  }
  // Certifications and interests print in the skills block under their own labels (spec A.4), never as experience.
  const skills = skillLines([...facts.filter((f) => f.kind === "skill"),
    ...facts.filter((f) => f.kind === "certification").map((f) => ({ name: `Certifications: ${f.title || f.text}` })),
    ...facts.filter((f) => f.kind === "other" && /^Interest: /.test(f.text || "")).map((f) => ({ name: `Interests: ${f.name || f.title}` }))]);
  if (skills.length) {
    const more = skills.find((x) => /^Certifications?$/.test(x.group)) ? " & Certifications" : skills.find((x) => /^Interests?$/.test(x.group)) ? " & Interests" : "";
    blocks.push({ kind: "heading", text: `Skills${more}` });
    for (const x of skills) blocks.push({ kind: "line", text: x.text, ...(x.label ? { label: x.label } : {}) });
  }
  // A.4's closing note, in the flag colour under a dotted rule: what this draft is, what it was built from, what is open.
  const notes = [`Review draft for ${target.label}, built from ${uploaded ? "your uploaded resume" : "the saved intake notes, not the original resume file"}.`];
  notes.push(unconfirmed ? "Facts unconfirmed; not for external submission." : contactMissing || gpaConflict ? "Details to confirm; not for external submission." : "General version, not written for a specific posting.");
  blocks.push({ kind: "line", text: notes.join(" "), flag: true });
  return { blocks, lines: printedOf(blocks), gpaConflict, contactMissing, unconfirmed, left: [], moved, facts: bullets };
}
// Over one page: the least relevant bullets come off first, then whole entries (never education), each one said.
// One page when the person asked for one; otherwise up to two (a real two-page resume is kept whole up to there).
function toOnePage(R: unknown, b: Built, target: Target, maxPages = 1) {
  let out = renderBlocks(R, b.blocks);
  const score = scorer(target);
  while (out.fit.pages > maxPages) {
    const idx = b.blocks.map((x, i) => ({ x, i })).filter(({ x }) => x.kind === "bullet").sort((p, q) => score({ title: p.x.text }) - score({ title: q.x.text }) || q.i - p.i)[0]?.i;
    if (idx === undefined) break;
    b.left.push(b.blocks[idx].text);
    b.blocks.splice(idx, 1);
    out = renderBlocks(R, b.blocks);
  }
  b.lines = printedOf(b.blocks);
  return out;
}

// ---------------------------------------------------------------- the turn
let runtime: Promise<unknown> | null = null;
const R0 = () => runtime ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
  .then(([zlib, crypto, b]) => (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }));
const words = (xs: string[]) => xs.join(" ").replace(/•/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
const fileStem = (t: Target) => `Resume_${t.label.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/[^A-Za-z0-9]+/g, "_").replace(/_+$/, "")}`;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const hex = async (u: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(u)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// deno-lint-ignore no-explicit-any
// CodeRabbit #1 on #634 (architect, round 5): after "don't apply" is a limit of this task, "Send this one" or a bare yes is never an
// approval of an open card: the card step is held and the resume task asks which one is meant.
const CARD_YES = /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|approve(?: it)?|send it|submit it|go(?: ahead)?|do it)\s*[.!]*\s*$/;
export function holdsCardApproval(profile: any, message: string, now: number): boolean {
  const task = profile?._resumeTask;
  if (!task || typeof task !== "object" || !(now - Date.parse(task.at) < TASK_TTL_MS)) return false;
  return Array.isArray(task.limits) && task.limits.includes("no_apply") && (AMBIGUOUS.test(lc(message)) || CARD_YES.test(lc(message)));
}
// CodeRabbit #8 (architect, round 5): an error once the message is the resume task's is a contained reply, never a fall-through
// to the planner or an apply step.
// deno-lint-ignore no-explicit-any
export async function resumeTaskTurn(o: { message: string; ctx: any; userId: string; now: number;
  deps: Parameters<typeof resumeTaskTurnInner>[0]["deps"] }): Promise<ResumeTurn | null> {
  let claimed = false;
  try { return await resumeTaskTurnInner(o, () => { claimed = true; }); } catch (e) {
    if (!claimed) throw e;
    const reason = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
    const task = (o.ctx?.profile?._resumeTask ?? null) as ResumeTask;
    return { reply: `I couldn't finish the resume step: ${reason}. Nothing was applied or sent.`, intent: RESUME_TASK_INTENT, resultStatus: "failed", documents: [], link: null, task };
  }
}
async function resumeTaskTurnInner(o: { message: string; ctx: any; userId: string; now: number;
  deps: { file?: (data: Record<string, unknown>) => Promise<{ url: string } | { error: string }>; uploaded: () => Promise<boolean>; rewrite?: (bullet: string, ask: string) => Promise<string | null>; lastIntent?: () => Promise<string | null>; loadPool?: () => Promise<void> } }, claim: () => void = () => {}): Promise<ResumeTurn | null> {
  const profile = o.ctx?.profile;
  if (!profile || typeof profile !== "object" || !(profile.facts || []).some((f: Fact) => f && SECTION[f.kind])) return null;
  // The task lapses after a day without a turn of its own (review of #634): an old target is never carried into a new day's asks.
  const kept: ResumeTask | null = profile._resumeTask && typeof profile._resumeTask === "object" ? profile._resumeTask : null;
  const prior = kept && o.now - Date.parse(kept.at) < TASK_TTL_MS ? kept : null;
  if (kept && !prior) delete profile._resumeTask;
  const shortlist = Array.isArray(o.ctx?.discovery?.lastShortlist) ? o.ctx.discovery.lastShortlist : [];
  const companies = shortlist.map((r: any) => lc(r?.company)).filter(Boolean);
  // Round 4: the posting pool's employers are names too ("the quillstone data analyst intern role" written in lower case). The
  // pool is read only when the stated target holds a word the field vocabulary does not know.
  if (needsEmployers(o.message)) await o.deps.loadPool?.().catch(() => undefined);
  const poolRaw = o.ctx?.postings || o.ctx?.corpus || o.ctx?.discovery?.postings || [];
  const pool = (Array.isArray(poolRaw) ? poolRaw : poolRaw.postings || []).map((p: any) => lc(p?.company || p?.company_name)).filter(Boolean);
  const employers = [...new Set([...companies, ...pool])];
  const routerLast = [...(Array.isArray(profile._careerRouterArtifacts) ? profile._careerRouterArtifacts : [])].reverse().find((a: any) => a?.pdf?.base64);
  const lastIntent = o.deps.lastIntent ? await o.deps.lastIntent().catch(() => null) : null;
  const resumeShown = lastIntent === RESUME_TASK_INTENT || lastIntent === RESUME_CLARIFY_INTENT;
  // A shown rewording and the two-choice question answer only the very next turn: once any other reply came between (a card, an
  // offer, a question), a plain "yes" or "the PDF" is that reply's, never this task's.
  if (prior && !resumeShown) { prior.pending = null; prior.proposed = null; }
  let ask = resumeAskOf(o.message, prior, { companies, employers, jobs: shortlist.length, posting: !!o.ctx?.posting, lastFile: !!routerLast, resumeShown });
  if (!ask) { if (prior) { prior.pending = null; prior.proposed = null; } return null; }
  const t = lc(o.message);
  const hints = { employers: [...employers, ...(prior?.employers ?? [])], fields: prior?.fields ?? [] };
  const unclear = ask === "target_which" ? readTarget(o.message, hints) : null;
  if (ask === "target_field" && !prior?.which) ask = null;
  const named = unclear?.kind === "ask" ? null : ask === "target_field" ? prior!.which!.target : targetOf(o.message, hints);
  if (!ask || !named && !prior && unclear?.kind !== "ask") { if (prior) { prior.pending = null; prior.proposed = null; } return null; }
  claim();
  const target = named ?? prior?.target ?? (unclear as { target: Target }).target;
  const task: ResumeTask = { target, limits: [...new Set([...(prior?.limits ?? []), ...limitsOf(o.message)])], rejected: rejectedOf(o.message) ?? prior?.rejected ?? null,
    said: prior && prior.target.label === target.label ? [...prior.said] : [], asked: [...(prior?.asked ?? [])], file: prior?.file ?? null, pending: null, at: new Date(o.now).toISOString(),
    // Only an edit or restyle turn shows a rewording; every other turn (a fact, a correction, a question, a new file) ends it.
    moved: prior?.moved ?? [], proposed: null, proposedHash: null, lastAsk: ask, factId: null, swaps: [...(prior?.swaps ?? [])],
    which: null, fields: [...(prior?.fields ?? [])], employers: [...(prior?.employers ?? [])] };
  if (ask === "target_which" && unclear?.kind === "ask") {
    task.pending = "target_which"; task.which = { name: unclear.name, target: unclear.target };
    if (!prior) task.file = null;
    profile._resumeTask = task;
    return { reply: `Do you mean roles at ${title(unclear.name)} (a company), or ${unclear.name} as a field?`, intent: RESUME_CLARIFY_INTENT, resultStatus: "awaiting_user", documents: [], link: null, task };
  }
  if (ask === "target_company") {
    const name = prior!.which!.name;
    task.employers = [...new Set([...(task.employers ?? []), name])];
    profile._resumeTask = task;
    return { reply: `Then this is a posting at ${title(name)}. I need the ${title(name)} posting to tailor against: paste it or its link and I'll tailor your resume to it.`, intent: RESUME_CLARIFY_INTENT, resultStatus: "awaiting_user", documents: [], link: null, task };
  }
  if (ask === "target_field") { task.fields = [...new Set([...(task.fields ?? []), prior!.which!.name])]; ask = "make"; task.lastAsk = ask; }
  if (ask === "approve_edit") {
    const shown = prior?.proposed ?? [];
    if (!shown.length || await proposalHash(shown) !== prior?.proposedHash) return null;
    task.swaps = [...(task.swaps ?? []), ...shown];
  }
  const say: string[] = [];
  const noGpa = task.limits.includes("no_gpa");
  const uploaded = await o.deps.uploaded().catch(() => false);
  const reply = (text: string, intent = RESUME_TASK_INTENT, status = "awaiting_user"): ResumeTurn => { profile._resumeTask = task; return { reply: text, intent, resultStatus: status, documents: [], link: null, task }; };
  if (ask === "submit_job") {
    const n = jobNumberOf(t)!, job = shortlist[n - 1];
    if (!job) return reply(`There's no job ${n} on the list I showed. Which one do you mean?`, RESUME_CLARIFY_INTENT);
    const open = buildResume(profile, target, false, { noGpa: task.limits.includes("no_gpa"), swaps: task.swaps });
    return reply([`This is the ${job.title} application at ${job.company}. Nothing has been sent: you haven't reviewed its exact answers and resume yet.`,
      open.contactMissing || open.unconfirmed ? "The resume draft still has placeholders or unconfirmed facts, so it can't go to an employer as it is." : null,
      `Say "apply to ${n}" and I'll prepare it and show you exactly what would be sent before anything is submitted.`].filter(Boolean).join(" "), RESUME_CLARIFY_INTENT);
  }
  if (ask === "fact_detail") {
    const f = (profile.facts || []).find((x: Fact) => x.id === prior?.factId);
    if (!f) return reply("I've lost track of which new job that was. Tell me the employer, your title and when you started.");
    if (!titleShaped(o.message)) {
      task.pending = "fact_detail"; task.factId = f.id;
      return reply(`What is your title at ${String(f.title).replace(/^New job at /, "").replace(/:.*$/, "")}, and when did you start? I'll keep it with that job, unconfirmed.`);
    }
    const said = o.message.trim().replace(/^(ok(ay)?|yes|sure|so)[,!. ]+/i, "").replace(/[.!]+$/, "");
    f.title = `${f.title}: ${said}`; f.text = f.title;
    return reply(`Kept with your new job: "${said}". It stays unconfirmed and off the resume until you confirm it. Is "${f.title}" right as written?`);
  }
  // Review of #634 (c): "update my resume with my new job at X" is kept, unconfirmed, in their words, and the missing details are
  // asked; it is never dropped, and it prints on no file until they confirm it.
  if (ask === "new_fact") {
    const at = (NEW_FACT.exec(o.message.toLowerCase())![1] ?? "").trim().replace(/[.!?]+$/, "");
    const said = o.message.slice(o.message.toLowerCase().indexOf(at), o.message.toLowerCase().indexOf(at) + at.length);
    const f = CareerProfile.addFact(profile, { kind: "experience", title: `New job at ${said}`, text: `New job at ${said}`, bullets: [], source: "chat", needs_confirmation: true });
    task.pending = "fact_detail"; task.factId = f.id;
    return reply(`I've noted your new job at ${said} as unconfirmed, so it isn't on the resume yet. What is your title there, and when did you start?`);
  }
  // B.6 continuation 1, the turns that answer from the task without a new file.
  if (ask === "why_contact" || ask === "apply_which" || ask === "explain" || ask === "edit" || ask === "restyle") {
    const now = buildResume(profile, target, uploaded, { noGpa, swaps: task.swaps });
    const open = [...(now.gpaConflict ? ["your correct GPA"] : []), ...(now.contactMissing ? ["your contact details"] : [])];
    if (ask === "why_contact") return reply(now.contactMissing
      ? "The source I used didn't establish the contact details for this resume, so I left the missing information visible instead of choosing an address or number. Send the contact line you want printed and I'll replace the placeholders."
      : "Your contact details are on file and printed at the top; nothing there is a placeholder now.", RESUME_TASK_INTENT, now.contactMissing ? "awaiting_user" : "completed");
    if (ask === "apply_which") return reply(`Which role should this go to? Before anything is sent, I'll show you the target, the final resume and the exact application answers.${open.length ? ` The draft still needs ${open.join(" and ")}, so it isn't ready to submit.` : ""}`, RESUME_CLARIFY_INTENT);
    if (ask === "explain") {
      const moves = task.moved?.length ? `I moved ${task.moved.join("; and ")}.` : "I kept the order of your intake; nothing was moved.";
      return reply([moves, `I did not add a new job, tool, result or credential.${(task.swaps ?? []).length ? ` I used the shorter wording you approved for ${task.swaps!.length === 1 ? "one bullet" : `${task.swaps!.length} bullets`}.` : ""}`,
        ...(noGpa ? ["GPA stays off."] : []), ...(now.contactMissing ? ["Contact details are still placeholders."] : [])].join(" "), RESUME_TASK_INTENT, "completed");
    }
    if (ask === "restyle") {
      // Every bullet the model rewrites in the asked tone, each audited against its own fact; only those that pass are shown.
      const out: { before: string; after: string }[] = [];
      for (const b of now.facts.slice(0, 8)) {
        const a = (await (o.deps.rewrite?.(b.text, o.message) ?? Promise.resolve(null)).catch(() => null) ?? "").replace(/^[-•\s"]+|["\s]+$/g, "").replace(/\s+/g, " ");
        if (a && a !== b.text && auditRewrite({ original: b.text, proposed: a, fact: b.fact, profile }).ok) out.push({ before: b.text, after: a });
      }
      if (!out.length) return reply(`I couldn't change the tone of your resume for ${target.label} without changing what it says, so it stays as it is.`, RESUME_TASK_INTENT, "completed");
      // Round-2 re-review (1b): a yes approves exactly what was shown. Only the shown pairs are kept and hashed; the rest are not
      // proposed until they are shown.
      const shown = out.slice(0, 2), rest = out.length - shown.length;
      task.proposed = shown; task.proposedHash = await proposalHash(shown);
      return reply([`For your ${target.label} resume, ${shown.length === 1 ? "this bullet" : "these 2 bullets"} would change:`,
        ...shown.flatMap((x) => [`New: ${x.after}`, `Now: ${x.before}`]),
        ...(rest > 0 ? [`${rest === 1 ? "One more bullet" : `${rest} more bullets`} could change the same way; ${rest === 1 ? "it isn't" : "they aren't"} part of this change.`] : []),
        `Nothing else changes. Say if ${shown.length === 1 ? "it's" : "these are"} fine and I'll put ${shown.length === 1 ? "it" : "them"} in the PDF.`].join("\n"));
    }
    const ord = /\b(second|2nd)\b/.test(t) ? 1 : /\b(third|3rd)\b/.test(t) ? 2 : /\blast\b/.test(t) ? now.facts.length - 1 : 0;
    const pick = now.facts[ord];
    if (!pick) return reply("There's no bullet like that on this draft.");
    const after = await (o.deps.rewrite?.(pick.text, o.message) ?? Promise.resolve(null)).catch(() => null);
    const clean = after ? after.replace(/^[-•\s"]+|["\s]+$/g, "").replace(/\s+/g, " ") : "";
    const audit = clean && clean !== pick.text ? auditRewrite({ original: pick.text, proposed: clean, fact: pick.fact, profile }) : { ok: false, reasons: [] };
    if (!audit.ok) return reply(`I couldn't shorten it without changing what it says, so it stays as written: "${pick.text}".`, RESUME_TASK_INTENT, "completed");
    task.proposed = [{ before: pick.text, after: clean }]; task.proposedHash = await proposalHash(task.proposed);
    const nums = (clean.match(/\d[\d,.]*\+?%?/g) ?? []).filter((n) => pick.text.includes(n.replace(/\+$/, "")));
    return reply([`Proposed replacement: ${clean}`, `Now: ${pick.text}`, ...nums.slice(0, 1).map((n) => `This keeps the ${n} already in your intake. If ${n} is not accurate, tell me the supported number before we use it.`), "Say if it's fine and I'll put it in the PDF."].join("\n"));
  }
  if (ask === "ask_send") {
    task.pending = "send_choice";
    profile._resumeTask = task;
    const n = shortlist.length;
    const which = n === 0 ? "the application on your card" : n === 1 ? "the job I listed" : `one of the ${n} jobs I listed`;
    const held = task.limits.includes("no_apply") ? " You asked me not to apply, so I haven't approved anything." : "";
    return { reply: `Do you mean submit ${n === 0 ? which : `an application for ${which}`}, or send you the resume PDF for ${task.file!.label}?${held} Nothing is sent until you say.`, intent: RESUME_CLARIFY_INTENT, resultStatus: "awaiting_user", documents: [], link: null, task };
  }
  // The last resume file this person was given, by its target: ours, or the posting tailor's (142 _careerRouterArtifacts).
  const lastWasOther = ask === "correct" && (routerLast && (!prior?.file || Date.parse(routerLast.at || routerLast.created_at || "") > Date.parse(prior.at)) || (prior?.file && prior.file.label !== target.label));
  if (ask === "correct") {
    const used = routerLast?.company && (!prior?.file || prior.file.label === target.label) ? `the ${routerLast.company} posting from your earlier list` : task.rejected;
    if (lastWasOther) say.push(`You're right, I used the wrong role${used ? ` (${used})` : ""}. This version is for ${target.label}.`);
    else say.push(`The file I sent is for ${target.label}${task.rejected ? `, not the ${task.rejected}` : ""}; here it is again.`);
  }
  const R = await R0();
  const source = uploaded ? "the facts read from your uploaded resume" : "your saved resume intake, not the original file";
  const built = buildResume(profile, target, uploaded, { noGpa, swaps: task.swaps });
  const movedBefore = prior?.file ? (prior.moved ?? []) : null;
  task.moved = built.moved;
  const out = toOnePage(R, built, target, task.limits.includes("one_page") ? 1 : 2);
  // The words read back out of the PDF must be exactly the lines built (no line lost, none added).
  const back = (R as any).extractPdfLines((R as any).primitives.bytes(out.pdf)) as string[];
  if (words(back) !== words(built.lines)) {
    profile._resumeTask = task;
    return { reply: `I couldn't make a PDF for ${target.label} that reads back correctly, so I haven't sent one. Ask me again and I'll rebuild it.`, intent: RESUME_TASK_INTENT, resultStatus: "failed", documents: [], link: null, task };
  }
  const sha = await hex(out.pdf), filename = `${fileStem(target)}.pdf`;
  const documents: Doc[] = [{ kind: "document", format: "pdf", filename, mime: "application/pdf", base64: b64(out.pdf), sha256: sha }];
  if (/\b(docx|word)\b/.test(t)) documents.push({ kind: "document", format: "docx", filename: `${fileStem(target)}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: b64(out.docx), sha256: await hex(out.docx) });
  // A link only when the person asks for one (T3: "send a download link … the attachment isn't opening"): the File page, sign-in first.
  const wantsLink = ask === "link" || /\b(link|download)\b/.test(t);
  let link: string | null = null, linkFail = "";
  if (wantsLink && o.deps.file) {
    const made = await o.deps.file({ variant: "resume", title: `Resume for ${target.label}`, target: target.label, filename, review: built.contactMissing || built.unconfirmed || !!built.gpaConflict,
      note: built.unconfirmed ? "Built from your saved intake; the facts are not confirmed yet." : built.contactMissing ? "Contact details are placeholders until you send them." : undefined, sha256: sha, pdf_b64: b64(out.pdf) })
      .catch((e) => ({ error: String((e as Error)?.message ?? e) }));
    if ("url" in made) link = made.url; else linkFail = made.error.replace(/^not created:\s*/, "").replace(/^[\w.[\]]+:\s*/, "");
  }
  task.file = { sha256: sha, filename, pages: out.fit.pages, label: target.label };
  const pages = out.fit.pages === 1 ? "one-page" : `${out.fit.pages}-page`;
  if (ask === "approve_edit") {
    say.push(`Here is the revised ${pages} PDF.`);
    say.push([noGpa || built.gpaConflict ? "GPA is omitted" : null, (prior?.proposed?.length ?? 0) > 1 ? `${prior!.proposed!.length} bullets are reworded as you asked` : "the bullet is changed as you asked", built.contactMissing ? "the contact placeholders still need filling" : null].filter(Boolean).join(", ").replace(/, ([^,]*)$/, ", and $1").replace(/^./, (c) => c.toUpperCase()) + ".");
    if (built.contactMissing || built.gpaConflict || built.unconfirmed) say.push("This is a review draft, not ready for an employer.");
  } else if (ask === "make" && movedBefore && built.moved.length && !named) {
    say.push(`Here is the ${pages} PDF for ${target.label}: I put ${built.moved[0]}${task.limits.includes("one_page") ? ", kept it to one page" : ""} and left the experience itself unchanged.`);
  } else if (ask === "make" || ask === "send_pdf") say.push(documents.length > 1 ? `Here are the PDF and Word (DOCX) files of your resume for ${target.label}.`
    : ask === "send_pdf" || prior?.file?.label === target.label && !named ? `Here is the resume PDF for ${target.label}.` : `Here is your ${pages} resume PDF for ${target.label}.`);
  else if (ask === "link" && !say.length) say.push(`Here is the resume PDF for ${target.label} again.`);
  if (!task.said.includes("general") && ask !== "send_pdf") { say.push("It's a general version, not written for one posting; send me a posting and I'll tailor it to that."); task.said.push("general"); }
  if (!task.said.includes("source")) {
    say.push(`I used ${source}${built.unconfirmed ? " (not yet confirmed by you)" : ""}, kept every fact as written and added no experience.`);
    task.said.push("source");
  }
  if (built.left.length) say.push(`To fit ${task.limits.includes("one_page") ? "one page" : "two pages"} I left off ${built.left.length === 1 ? "one bullet" : `${built.left.length} bullets`}: "${built.left[0]}"${built.left.length > 1 ? " and the next least relevant" : ""}.`);
  if (task.limits.includes("one_page") && out.fit.pages > 1) say.push(`It runs to ${out.fit.pages} pages even with the least relevant bullets off; I set nothing below 10 pt.`);
  const questions: [string, string][] = [];
  if (built.gpaConflict) questions.push(["gpa", `Your GPA is left off because your resume shows two values (${built.gpaConflict.join(" and ")}). Which one is right?`]);
  if (built.contactMissing) questions.push(["contact", `Your name and contact details aren't on file, so the top shows placeholders. ${CONTACT_QUESTION}`]);
  if (built.unconfirmed) questions.push(["confirm", `These facts are still unconfirmed. Are they right as written?`]);
  const asking = /\bask me\b/.test(t) || ask === "make" && !prior;
  for (const [k, q] of questions) {
    if (!task.asked.includes(k) || asking) { say.push(q); if (!task.asked.includes(k)) task.asked.push(k); }
  }
  if (questions.length && !say.some((s) => s.endsWith("?")) && ask !== "send_pdf" && ask !== "approve_edit") say.push(`I still need ${questions.map(([k]) => k === "gpa" ? "your correct GPA" : k === "contact" ? "your contact details" : "your confirmation of the facts").join(" and ")} before this is ready to send outside this chat.`);
  if (limitsOf(o.message).includes("no_apply")) say.push("I haven't applied to anything.");
  if (link) say.push(`Download it from your private File page (you sign in to open it):\n${link}`);
  // Re-review of #644 (4): what failed is said, not a generic "couldn't".
  else if (wantsLink) say.push(`There's no link this time: your private File page couldn't be made (${linkFail || "links to File pages aren't set up"}).`);
  profile._resumeTask = task;
  return { reply: say.join("\n"), intent: RESUME_TASK_INTENT, resultStatus: questions.length ? "awaiting_user" : "completed", documents, link, task };
}
