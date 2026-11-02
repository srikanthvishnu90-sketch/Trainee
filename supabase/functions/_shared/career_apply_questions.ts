// Ask once (owner target, v2: "every unknown question asked to the user exactly once over iMessage, then never again").
// The questions that stopped a preparation on the person's computer (career_apply_questions, stored there by
// prepare-batch) are asked here, a few at a time, numbered; the person answers in one text ("1 no 2 3 years"). Code
// decides what an answer is, never the model: an answer to a question with choices must be one of the employer's own
// choices (or say one plainly: "no" for "No, I will not require sponsorship"), a yes/no question takes a yes or a no, and
// an essay or a statement is kept word for word as the person wrote it. Nothing is guessed; an answer that does not fit
// is said back with the choices and the question stays open. The next preparation on the person's computer reads the
// answers back as their confirmed facts (factsWithTextAnswers in workers/career-browser/approve-first.ts).
//
// Never asked by text: an identity, bank or card number, or a password (NEVER_BY_TEXT); the person types those on the
// form. An answer whose number the chat input removed (identity_redact.ts) is not saved.
//
// WO-030: a written answer can be drafted from the person's confirmed facts ("draft 2", essay_draft.ts), shown in full,
// and saved only by "use 2" through the same check and store.answer as a typed answer. The draft waits on the account
// beside the questions shown (career:questions-shown), under the same rules: this thread's last word, a day, the numbers
// shown. The employer's own AI policy decides first.
//
// G4: a cover letter drafted before the person asked (workers/career-browser/prepare-ahead.ts) waits beside its question.
// The questions say it is ready; "draft 2" shows it whole, once it passes again every check a new draft must pass
// (essay_draft.ts checkDraft: the employer's policy, their confirmed facts as they are now), with no model call; only
// "use 2" saves it, as with any draft.
import { chooseOption, yesNoOf } from "./answer_options.ts";
import { decodeRowQuestionType } from "./row_answer.ts";
import { matchOption, typedFieldProblem } from "./career_apply.ts";
import { factType, mapQuestion, NEVER_BY_TEXT } from "./question_map.ts";
import { readAiPolicy } from "./ai_policy.ts";
import { checkDraft, type DraftDeps, draftEssay, draftReply, parseDraftCommand } from "./essay_draft.ts";
import { needsText, type Situation } from "./career_situation.ts";
import { draftNote, eligibilityDraft, eligibilityFactOf, type Said } from "./eligibility_draft.ts";
import { contactDraft, isContactFact } from "./contact_draft.ts";
import { redactIdentity } from "./identity_redact.ts";

export interface OpenQuestion {
  id: string;
  key: string; // fact:<fact> | label:<hash> | job:<hash> (answerKey in question_map.ts)
  kind: string;
  label: string;
  type: string;
  options: string[];
  company: string | null;
  job_ids: string[];
  misfit: boolean;
  answer: string | null;
  ai_policy?: string | null; // the posting's own words about AI help, carried by the person's computer (WO-030)
}
export interface PendingDraft { text: string; at: string; n: number }
export interface AheadDraft { text: string; at: string } // G4: drafted before the person asked; never their answer
export interface Shown { thread: string; ids: string[]; at: string; drafts?: Record<string, PendingDraft>; skipped?: string[] }
export interface QuestionStore {
  open(userId: string, limit: number): Promise<OpenQuestion[]>; // open questions, oldest first
  countOpen(userId: string): Promise<number>;
  get(userId: string, ids: string[]): Promise<OpenQuestion[]>;
  answer(userId: string, id: string, answer: string): Promise<void>;
  shown(userId: string): Promise<Shown | null>;
  setShown(userId: string, s: Shown): Promise<void>;
  lastAssistantIntent(threadId: string): Promise<string | null>;
  // Every stored question (open or answered) on these postings: the employer's AI policy may be any of them (WO-030).
  // Without it no essay is drafted.
  onPostings?(userId: string, jobIds: string[]): Promise<OpenQuestion[]>;
  // G2: the person's own chat messages about sponsorship or work authorization, word for word with when they were said.
  // Without it, nothing is offered from them.
  statements?(userId: string): Promise<Said[]>;
  // G4: the drafts written ahead for these open questions, by question id. Without it, every draft is written on "draft N".
  drafted?(userId: string, ids: string[]): Promise<Record<string, AheadDraft>>;
}

export const QUESTIONS_INTENT = "career_apply_questions";
// One question per message, on every channel (owner, 2026-10-31): the next is asked after the answer, and the card is
// built only when none is left open (career_hosted_prepare.ts prepareAfterAnswers).
export const PER_TEXT = 1;
export const TEXT_BUDGET = 1600; // two or more questions stay under this; one alone may go to 4,000, never cut
const MAX_ANSWER = 2000;

const plain = (s: string) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
const ASK =
  /^(?:so )?(?:what (?:else )?(?:do|did) you need(?: from me| me to answer)?|what questions do you have(?: for me)?|(?:any|got any) questions(?: for me)?|(?:show|send|list|give)(?: me)? (?:my |the |your )?(?:open )?questions|what'?s (?:missing|left|blocking my applications|stopping my applications)|what do i (?:need to|have to|still need to) answer|(?:let me |i'?ll |i want to )?answer (?:your|the|my) questions)\??$/;
export const isAsk = (text: string) => ASK.test(plain(text));

// The few words a person uses for yes and no that the option matcher does not know.
const YES_WORDS = /^(yup|yea|ya|yes yes|sure|of course|absolutely|correct|definitely|affirmative|i do|i am|i will|i can|i have)$/;
const NO_WORDS = /^(nope|nah|no no|negative|never|i don'?t|i'?m not|i won'?t|i can'?t|i haven'?t|not at all)$/;
function yesNoWord(raw: string, explicit = false): "yes" | "no" | null {
  const t = plain(raw);
  if (YES_WORDS.test(t)) return "yes";
  if (NO_WORDS.test(t)) return "no";
  if (explicit && !/^(yes|no|y|n|true|false)$/.test(t)) return null;
  return yesNoOf(t);
}
const REMOVED = /\[(?:SSN|card number|number|password|code|security code) removed\]/;
// With one question shown the whole message is its answer, so a deferral at its start is never saved as one ("not yet,
// I'll answer later" is not anyone's first name).
const SKIP = /^(skip|later|pass|not now|not yet|leave it|skip it|maybe later|ask me later|i'?ll (?:do|answer) (?:it |that |this )?later)\b/;
const YES_NO_TYPE = /checkbox|boolean/;
// "Not yet" on its own answers a yes or no question asked with "yet" ("Have you graduated yet?": a no). With anything
// after it ("not yet, I'll answer later"), or to any other question, it stays a deferral.
const NOT_YET_ALONE = /^(?:no,? )?not yet[\s,;:.!?\u2014\u2013-]*$/;
function asksYet(q: OpenQuestion, type: string): boolean {
  if (q.kind === "consent" || !/\byet\b/i.test(q.label)) return false;
  if (q.options.length) return q.options.some((l) => yesNoOf(l) === "no");
  return YES_NO_TYPE.test(type) || (q.key.startsWith("fact:") && factType(q.key.slice(5)) === "yesno");
}

export type Check =
  | { ok: true; value: string }
  | { ok: false; why: string; skip?: boolean };

// One answer against its question. The value saved is what the next preparation fills: the employer's own option for a
// question asked on this wording or this posting, the person's own words (plain "Yes"/"No" for a yes or no) for a fact
// that goes to every employer, so each form's options are chosen from it again (a choice that does not fit reopens it).
export function checkAnswer(q: OpenQuestion, raw: string): Check {
  const row = decodeRowQuestionType(q.type);
  if (/^row:/i.test(q.type) && (!row || row.key !== q.key)) return { ok: false, why: "has no valid binding to its original form row; show the current questions again" };
  const type = row?.type ?? q.type;
  let value = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "");
  if (!value) return { ok: false, why: "had no answer" };
  const yetNo = NOT_YET_ALONE.test(plain(value)) && asksYet(q, type);
  if (!yetNo && SKIP.test(plain(value))) return { ok: false, why: "left for later", skip: true };
  if (yetNo) value = "no";
  if (REMOVED.test(value)) return { ok: false, why: "had a number Upmore never keeps; type that one on the form yourself" };
  // TAILORING SCENARIOS (2026-10-29): the chat input is redacted before it gets here, but a draft saved by "use N" (one
  // written by a model, or ahead on the person's computer) never passed that redaction. An SSN, card number, password or
  // one-time code is never saved as an answer, whoever wrote it.
  if (redactIdentity(value).removed.length) return { ok: false, why: "had a number or password Upmore never keeps; type that one on the form yourself" };
  if (value.length > MAX_ANSWER) return { ok: false, why: `is longer than ${MAX_ANSWER.toLocaleString("en-US")} characters` };
  const shared = q.key.startsWith("fact:");
  const fact = shared ? q.key.slice(5) : mapQuestion({ label: q.label, type }).fact;
  if (q.options.length) {
    // Never chosen from the question's wording (no derivation here): the person's own answer, onto the form's own option.
    // A yes or a no is read as one only where the choices are yeses and noes ("I have a bachelor's" is not a yes).
    const opts = q.options.map((l) => ({ label: l, value: l }));
    const yn = q.options.some((l) => yesNoOf(l) !== null) ? yesNoWord(value, !!row) : null;
    const choice = matchOption(value, opts) ?? (yn ? matchOption(yn, opts) ?? chooseOption("", yn, opts) : null) ??
      (row ? null : chooseOption(fact, value, opts));
    if (choice === null) return { ok: false, why: `needs one of: ${choiceList(q.options, 8)}` };
    return { ok: true, value: shared && yn ? cap(yn) : choice };
  }
  if (YES_NO_TYPE.test(type) || q.kind === "consent" || (shared && factType(fact) === "yesno")) {
    const yn = yesNoWord(value, !!row);
    return yn ? { ok: true, value: cap(yn) } : { ok: false, why: "needs a yes or a no" };
  }
  const typedProblem = typedFieldProblem({ type, label: q.label, options: [] }, value);
  if (typedProblem) return { ok: false, why: typedProblem };
  return { ok: true, value };
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const choiceList = (o: string[], n: number) =>
  o.length <= n ? o.join(" / ") : `${o.slice(0, n).join(" / ")} (or one of the other ${o.length - n})`;

// Which number answers what: "1 no 2 3 years", one a line, or (one question shown) the whole text. A number counts as a
// question's number only in order, only up to how many were shown, and never when a unit follows it ("3 years").
const UNIT = /^\s*(?:\+|%|k\b|years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|days a week|times|people|kids|percent)/i;
export function splitAnswers(text: string, count: number): Map<number, string> | null {
  const t = String(text ?? "").trim();
  if (!t || count < 1) return null;
  const out = new Map<number, string>();
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (count > 1 && lines.length > 1 && lines.every((l) => /^\d{1,2}\s*[.):-]?\s+\S/.test(l))) {
    for (const l of lines) {
      const m = /^(\d{1,2})\s*[.):-]?\s+([\s\S]+)$/.exec(l)!;
      const n = Number(m[1]);
      if (n < 1 || n > count || out.has(n)) return null;
      out.set(n, m[2].trim());
    }
    return out;
  }
  const marks: { n: number; at: number; end: number }[] = [];
  const re = /(^|[\s,;])(\d{1,2})(?:\s*[.):-])?\s+/g;
  let m: RegExpExecArray | null, cur = 0;
  while ((m = re.exec(t))) {
    const n = Number(m[2]), at = m.index + m[1].length, end = m.index + m[0].length;
    if (n <= cur || n > count || UNIT.test(t.slice(at + m[2].length))) continue;
    marks.push({ n, at, end });
    cur = n;
  }
  if (!marks.length || marks[0].at !== 0) {
    if (count !== 1) return null;
    out.set(1, t);
    return out;
  }
  marks.forEach((k, i) => {
    const a = t.slice(k.end, i + 1 < marks.length ? marks[i + 1].at : t.length).trim().replace(/[,;]$/, "").trim();
    out.set(k.n, a);
  });
  return out;
}

// A text that is talk, not an answer, when only one question is shown: a question back, or a request.
const TALK = /\?\s*$|^(show|stop|cancel|help|what|how|why|when|where|who|can you|could you|would you|will you|set|find|search|remind|apply|send|list|pause|start|thanks|thank you|ok|okay|hi|hello|hey)\b/i;

function hint(q: OpenQuestion): string {
  if (q.options.length) {
    return q.options.length <= 6 ? `(${q.options.join(" / ")})` : `(one of ${q.options.length} choices, like ${q.options.slice(0, 3).join(", ")})`;
  }
  if (/select|radio/.test(q.type)) return "(type it as the form would list it)";
  if (YES_NO_TYPE.test(q.type) || q.kind === "consent") return "(yes or no)";
  if (q.kind === "essay") return "(in your own words; it goes on the form exactly as you write it)";
  if (q.kind === "attestation") return "(your own statement, word for word)";
  return "";
}
const line = (q: OpenQuestion, n: number) => {
  const where = q.key.startsWith("job:") && q.company ? ` For ${q.company}.` : "";
  const before = q.misfit && q.answer ? ` (Your earlier answer "${q.answer.slice(0, 60)}" is not one of this form's choices.)` : "";
  return `${n}. ${q.label.replace(/\s+/g, " ").trim()}${where} ${hint(q)}${before}`.replace(/\s+$/, "");
};

// A written answer is offered for drafting unless its own words, or the posting's carried AI statement, rule it out.
const offerDraft = (q: OpenQuestion) =>
  q.kind === "essay" && !["prohibited", "unread"].includes(readAiPolicy([q.label, q.ai_policy ?? ""]).policy);

// The one question a text asks (PER_TEXT), the first open one, with how many are open in all. The numbered list is gone:
// a person answers one question, then the next is asked. `total`: every open question, this one included.
// G2: notes(q, n) adds a line under the question (the person's own earlier words, offered as a draft).
export function questionsText(
  qs: OpenQuestion[], total: number, notes?: (q: OpenQuestion, n: number) => string | null,
): { take: OpenQuestion[]; text: string } | null {
  const ask = qs.filter((q) => !NEVER_BY_TEXT.test(q.label));
  if (!ask.length) return null;
  const take = ask.slice(0, PER_TEXT), q = take[0];
  // An identity-number question is never asked by text, so it is not counted among the ones asked.
  const all = Math.max(total - (qs.length - ask.length), 1), rest = all - 1;
  const head = all === 1
    ? "One question only you can answer is holding up your applications. Answer it once and I won't ask again."
    : `Question 1 of ${all} only you can answer, one at a time. Answer it once and I won't ask again.`;
  const foot = [
    "Just reply with your answer.",
    offerDraft(q) ? `For a written answer, say "draft 1" and I'll draft it from your confirmed facts for you to check first.` : "",
    rest > 0 ? `I'll ask the next one after you answer this.` : "",
  ].filter(Boolean).join(" ");
  return { take, text: [head, line(q, 1).replace(/^1\. /, ""), notes?.(q, 1) ?? "", foot].filter(Boolean).join("\n") };
}

const said = (q: OpenQuestion, value: string) => {
  const label = q.label.replace(/\s+/g, " ").trim();
  const short = label.length > 70 ? `${label.slice(0, 67)}...` : label;
  const v = q.kind === "essay" || value.length > 80 ? `"${value.slice(0, 60)}${value.length > 60 ? "..." : ""}" (kept word for word)` : value;
  return `${short}: ${v}`;
};

// The first open question, shown as the questions turn shows it (with its draft offers), and recorded as the one the
// next message answers. Null when none is open.
async function present(o: { userId: string; threadId: string; now: number; store: QuestionStore }, skipped: string[] = []): Promise<string | null> {
  const [all, total] = await Promise.all([o.store.open(o.userId, 20 + skipped.length), o.store.countOpen(o.userId)]);
  // "skip" leaves a question for later: the next one is asked; the skipped one comes back once the others are answered.
  const later = all.filter((q) => !skipped.includes(q.id)), open = later.length ? later : all;
  if (!later.length) skipped = [];
  const offers = await eligibilityOffers(o.store, o.userId, open);
  const ahead = await aheadDrafts(o.store, o.userId, open);
  const t = questionsText(open, Math.max(total, open.length), (q, n) => {
    const d = offers.get(q.id);
    if (d) return draftNote(d.draft, d.value, n);
    return ahead.has(q.id) && offerDraft(q)
      ? `   A draft of ${n} is ready, written only from your confirmed facts. Say "draft ${n}" to read it; nothing is saved until you say "use ${n}".`
      : null;
  });
  if (!t) return null;
  const at = new Date(o.now).toISOString();
  // G2: an offered draft waits beside the question shown, and only "use N" saves it (draftTurn), as an essay draft does.
  const drafts: Record<string, PendingDraft> = {};
  t.take.forEach((q, i) => {
    const d = offers.get(q.id);
    if (d) drafts[q.id] = { text: d.value, at, n: i + 1 };
  });
  await o.store.setShown(o.userId, { thread: o.threadId, ids: t.take.map((q) => q.id), at, ...(Object.keys(drafts).length ? { drafts } : {}),
    ...(skipped.length ? { skipped } : {}) });
  return t.text;
}

// One turn, before any brain. Null when the text is neither a request for the questions nor an answer to the ones just
// shown, so the turn goes on as before.
// WO-100: with the person's situation, the questions keep their numbers and everything else only the person can do (a
// code, a card, a draft, a failure to decide) follows; "Nothing is waiting on you" only when the situation shows nothing.
export async function questionsTurn(
  o: { message: string; userId: string; threadId: string; now: number; store: QuestionStore; draft?: DraftDeps; situation?: Situation | null },
): Promise<{ reply: string; status: string } | null> {
  if (isAsk(o.message)) {
    const shownNow = await present(o);
    const rest = o.situation ? needsText(o.situation, { questionsShown: !!shownNow }) : null;
    if (!shownNow) {
      if (rest) return { reply: rest, status: "none" };
      return {
        reply: o.situation === null ? "No questions are open. The rest of your applications could not be read just now, so I can't say whether anything else waits on you."
          : "Nothing is waiting on you. When an application stops on a question only you can answer, I'll ask it here once.",
        status: "none",
      };
    }
    return { reply: rest ? `${shownNow}\n\n${rest}` : shownNow, status: "shown" };
  }
  // An answer counts only while the questions were this thread's last word, and only for a day. This runs on every turn,
  // so the one key read comes first and the thread's last reply is read only while questions are showing here; a read
  // that fails lets the turn go on without this (the person's message is never failed by it).
  let shown: Shown | null;
  try {
    shown = await o.store.shown(o.userId);
  } catch (e) {
    console.error("questions: shown not read", e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!shown || shown.thread !== o.threadId || !shown.ids.length || Date.parse(shown.at) < o.now - 48 * 3600000) return null;
  // WO-030: "draft 2", "redo 2", "use 2" under the same rule as an answer: the questions must be this thread's last word.
  const cmd = parseDraftCommand(o.message);
  if (cmd) {
    if ((await o.store.lastAssistantIntent(o.threadId)) !== QUESTIONS_INTENT) return null;
    return await draftTurn(o, shown, cmd);
  }
  if (shown.ids.length === 1 && TALK.test(o.message.trim())) return null;
  // One question is shown at a time: "1 x 2 y" answers several at once, and only the first is this question's. Nothing is
  // saved from it (part of another answer could land here); the one question is asked again.
  if (shown.ids.length === 1 && /^\s*1\s*[.):-]?\s+\S[\s\S]*?(^|[\s,;])2\s*[.):-]?\s+\S/m.test(o.message) &&
    (await o.store.lastAssistantIntent(o.threadId)) === QUESTIONS_INTENT) {
    const [one] = await o.store.get(o.userId, shown.ids);
    if (one) {
      return { reply: `I'm asking one question at a time, so nothing was saved. Just your answer to this one:\n${line(one, 1).replace(/^1\. /, "")}`, status: "partial" };
    }
  }
  const parts = splitAnswers(o.message, shown.ids.length);
  if (!parts) return null;
  if ((await o.store.lastAssistantIntent(o.threadId)) !== QUESTIONS_INTENT) return null;
  if (Date.parse(shown.at) < o.now - 24 * 3600000) {
    return { reply: `Those questions are more than a day old, so nothing was saved. Say "what do you need from me" to see them again.`, status: "expired" };
  }
  const byId = new Map((await o.store.get(o.userId, shown.ids)).map((q) => [q.id, q]));
  const saved: string[] = [], open: string[] = [];
  for (const [n, raw] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
    const q = byId.get(shown.ids[n - 1]);
    if (!q) { open.push(`${n}: that question is gone (the application was removed).`); continue; }
    if (NEVER_BY_TEXT.test(q.label)) { open.push(`${n}: type that one on the form yourself; Upmore never keeps it.`); continue; }
    const c = checkAnswer(q, raw);
    // One at a time: "skip" moves on to the next open question; this one is asked again after the others.
    if (!c.ok && c.skip && shown.ids.length === 1) {
      const skipped = [...new Set([...(shown.skipped ?? []), q.id])];
      const next = (await o.store.countOpen(o.userId)) > skipped.length ? await present(o, skipped) : null;
      if (next) return { reply: `Left for later; I'll ask it again after the others.\n\nNext: ${next}`, status: "answered_next" };
    }
    if (!c.ok) { open.push(`${n} ${c.why}.`); continue; }
    await o.store.answer(o.userId, q.id, c.value);
    saved.push(`${n}. ${said(q, c.value)}`);
    if (shown.drafts?.[q.id]) delete shown.drafts[q.id]; // their own words replace a draft they did not use
  }
  if (shown.drafts && saved.length) await o.store.setShown(o.userId, shown);
  const left = await o.store.countOpen(o.userId);
  // One at a time: the answer saved, the next open question is asked in the same reply, and it alone is what the next
  // message answers. The card waits until none is left.
  if (saved.length && !open.length && left > 0) {
    const next = await present(o, (shown.skipped ?? []).filter((id) => !shown!.ids.includes(id)));
    if (next) {
      return { reply: [`Saved. I won't ask this again:`, ...saved.map((x) => x.replace(/^\d+\. /, "")), "", `Next: ${next}`].join("\n"), status: "answered_next" };
    }
  }
  const reply = [
    saved.length ? `Saved. I won't ask ${saved.length === 1 ? "this" : "these"} again:` : "Nothing was saved.",
    ...saved,
    ...(open.length ? ["Still open:", ...open] : []),
    saved.length ? "They go on the forms the next time you prepare applications on your computer." : "",
    left > 0 && !open.length ? `${left} more question${left === 1 ? "" : "s"} waiting; say "what do you need from me" for ${left === 1 ? "it" : "them"}.` : "",
  ].filter(Boolean).join("\n");
  return { reply, status: open.length ? "partial" : "answered" };
}

// G2: for each open sponsorship or work-authorization question, the person's own newest clear statement about it, when
// it fits the question's own choices. A reader that fails offers nothing; the questions are shown as before.
// SUBMIT-STEER-1130: the same for their name, email and phone (contact_draft.ts), from a question that asks exactly that.
const contactFactOf = (q: OpenQuestion) => {
  const f = q.key.startsWith("fact:") ? q.key.slice(5) : null;
  return isContactFact(f) ? f : null;
};
async function eligibilityOffers(store: QuestionStore, userId: string, open: OpenQuestion[]) {
  const out = new Map<string, { draft: { text: string; at: string }; value: string }>();
  const asked = open.map((q) => ({ q, fact: eligibilityFactOf(q) })).filter((x) => x.fact !== null);
  const contact = open.map((q) => ({ q, fact: contactFactOf(q) })).filter((x) => x.fact !== null);
  if ((!asked.length && !contact.length) || !store.statements) return out;
  let said: Said[];
  try {
    said = await store.statements(userId);
  } catch (e) {
    console.error("questions: statements not read", e instanceof Error ? e.message : String(e));
    return out;
  }
  for (const { q, fact } of asked) {
    if (NEVER_BY_TEXT.test(q.label)) continue;
    const draft = eligibilityDraft(fact!, said);
    if (!draft) continue;
    const c = checkAnswer(q, draft.value);
    if (c.ok) out.set(q.id, { draft, value: c.value });
  }
  for (const { q, fact } of contact) {
    if (NEVER_BY_TEXT.test(q.label)) continue;
    const draft = contactDraft(fact!, said);
    if (!draft) continue;
    const c = checkAnswer(q, draft.value);
    if (c.ok) out.set(q.id, { draft, value: c.value });
  }
  return out;
}

// G4: which open questions have a draft written ahead. A reader that fails offers none; the questions are shown as before.
async function aheadDrafts(store: QuestionStore, userId: string, open: OpenQuestion[]): Promise<Set<string>> {
  const essays = open.filter((q) => q.kind === "essay").map((q) => q.id);
  if (!essays.length || !store.drafted) return new Set();
  try {
    return new Set(Object.keys(await store.drafted(userId, essays)));
  } catch (e) {
    console.error("questions: drafts written ahead not read", e instanceof Error ? e.message : String(e));
    return new Set();
  }
}

// "draft 2", "redo 2", "use 2": only for a number shown, while the questions are this thread's last word, for a day.
// A draft is shown whole and kept beside the questions shown; "use 2" saves it through the same check and store.answer
// as a typed answer, and nothing else ever saves it.
const DAY = 24 * 3600000;
async function draftTurn(
  o: { userId: string; threadId: string; now: number; store: QuestionStore; draft?: DraftDeps },
  shown: Shown,
  cmd: { act: "draft" | "redo" | "use"; n: number | null },
): Promise<{ reply: string; status: string }> {
  if (Date.parse(shown.at) < o.now - DAY) {
    return { reply: `Those questions are more than a day old, so nothing was drafted or saved. Say "what do you need from me" to see them again.`, status: "expired" };
  }
  const drafts = { ...(shown.drafts ?? {}) };
  const pending = Object.values(drafts);
  const n = cmd.n ?? (cmd.act === "use" && pending.length === 1 ? pending[0].n : shown.ids.length === 1 ? 1 : null);
  if (n === null) return { reply: `Which one? Say "${cmd.act} 2" with the question's number.`, status: "draft_which" };
  if (n < 1 || n > shown.ids.length) {
    const range = shown.ids.length === 1 ? `"${cmd.act} 1"` : `"${cmd.act} 1" to "${cmd.act} ${shown.ids.length}"`;
    return { reply: `I asked ${shown.ids.length === 1 ? "one question" : `${shown.ids.length} questions`}, so there's no ${n}. Say ${range}.`, status: "draft_none" };
  }
  const id = shown.ids[n - 1];
  const q = (await o.store.get(o.userId, [id]))[0];
  if (!q) return { reply: `${n}: that question is gone (the application was removed).`, status: "draft_none" };
  if (NEVER_BY_TEXT.test(q.label)) return { reply: `${n}: type that one on the form yourself; Upmore never keeps it.`, status: "draft_none" };

  if (cmd.act === "use") {
    const d = drafts[id];
    if (!d || d.n !== n) {
      return { reply: `There's no draft for ${n} yet. Say "draft ${n}" and I'll write one from your confirmed facts for you to check.`, status: "draft_none" };
    }
    if (Date.parse(d.at) < o.now - DAY) return { reply: `That draft is more than a day old, so it wasn't saved. Say "draft ${n}" for a new one.`, status: "expired" };
    const c = checkAnswer(q, d.text);
    if (!c.ok) return { reply: `Nothing was saved: the draft for ${n} ${c.why}.`, status: "draft_none" };
    await o.store.answer(o.userId, q.id, c.value);
    delete drafts[id];
    await o.store.setShown(o.userId, { ...shown, drafts });
    const still = (await o.store.get(o.userId, shown.ids)).filter((x) => !x.answer || x.misfit).length;
    // One at a time: the draft saved, the next open question is asked in the same reply.
    if (!still && shown.ids.length === 1 && (await o.store.countOpen(o.userId)) > 0) {
      const next = await present(o, (shown.skipped ?? []).filter((x) => !shown.ids.includes(x)));
      if (next) return { reply: ["Saved, as drafted. I won't ask this again:", said(q, c.value), "", `Next: ${next}`].join("\n"), status: "answered_next" };
    }
    return {
      reply: [
        "Saved, as drafted. I won't ask this again:",
        `${n}. ${said(q, c.value)}`,
        "It goes on the form the next time you prepare applications on your computer.",
        still ? `${still} of the questions above ${still === 1 ? "is" : "are"} still open; answer by number as before.` : "",
      ].filter(Boolean).join("\n"),
      status: still ? "draft_used" : "answered",
    };
  }

  if (q.kind !== "essay") return { reply: `${n} isn't a written answer, so there's nothing to draft. Reply "${n}" and your answer.`, status: "draft_not_essay" };
  if (!o.draft) return { reply: `I can't draft here. Reply "${n}" and your own answer.`, status: "draft_off" };
  // The employer's own policy may sit on any question of the same posting; if those cannot be read, nothing is drafted.
  let siblings: OpenQuestion[];
  try {
    if (!o.store.onPostings) throw new Error("no posting reader");
    siblings = await o.store.onPostings(o.userId, q.job_ids);
  } catch {
    return {
      reply: `I couldn't check ${q.company ?? "this employer"}'s rules on AI help, so I won't draft ${n} right now. Reply "${n}" and your own answer, or try again later.`,
      status: "draft_policy",
    };
  }
  const siblingLabels = siblings.filter((x) => x.id !== q.id).flatMap((x) => [x.label, x.ai_policy ?? ""]);
  // G4: the draft written before they asked, when it still passes every check; otherwise one is written now. "redo" always
  // writes a new one.
  if (cmd.act === "draft" && o.store.drafted) {
    let ready: AheadDraft | undefined;
    try { ready = (await o.store.drafted(o.userId, [id]))[id]; }
    catch (e) { console.error("essay draft: the draft written ahead was not read:", e instanceof Error ? e.message : String(e)); }
    if (ready) {
      const checked = await checkDraft({ q, siblingLabels, deps: o.draft, text: ready.text });
      if (checked.ok) {
        drafts[id] = { text: checked.text, at: new Date(o.now).toISOString(), n };
        await o.store.setShown(o.userId, { ...shown, drafts });
        return { reply: draftReply(n, q, checked), status: "drafted_ahead" };
      }
      if (checked.why === "policy") return { reply: draftReply(n, q, checked), status: "draft_policy" };
    }
  }
  const outcome = await draftEssay({
    q,
    siblingLabels,
    deps: o.draft,
    previous: cmd.act === "redo" ? drafts[id]?.text ?? null : null,
  }).catch((e) => ({ ok: false as const, why: "model" as const, policy: null, detail: [String(e?.message ?? e)], tries: 0 }));
  if (!outcome.ok) {
    if (outcome.why === "model") console.error("essay draft: not drafted:", outcome.detail[0]);
    return { reply: draftReply(n, q, outcome), status: `draft_${outcome.why}` };
  }
  drafts[id] = { text: outcome.text, at: new Date(o.now).toISOString(), n };
  await o.store.setShown(o.userId, { ...shown, drafts });
  return { reply: draftReply(n, q, outcome), status: "drafted" };
}

// The store over the edge function's service client: every write names the person (the _as functions), every read is
// scoped to them. Which questions were shown, and where, is kept on the account (wiped by an erase with the rest).
export function supabaseQuestionStore(admin: any): QuestionStore {
  const must = (r: any, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  const shape = (r: any): OpenQuestion => ({
    id: r.id, key: r.key, kind: r.kind, label: r.label, type: r.type, company: r.company ?? null, job_ids: r.job_ids ?? [],
    options: Array.isArray(r.options) ? r.options.map(String) : [], misfit: !!r.misfit, answer: r.answer ?? null,
    ai_policy: typeof r.ai_policy === "string" ? r.ai_policy : null,
  });
  const COLS = "id,key,kind,label,type,options,company,job_ids,misfit,answer,ai_policy";
  return {
    async open(userId, limit) {
      return (must(await admin.rpc("career_apply_questions_open_as", { p_user: userId, p_limit: limit }), "read open questions") ?? []).map(shape);
    },
    async countOpen(userId) {
      const r = await admin.from("career_apply_questions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("state", "open");
      if (r.error) throw new Error(`count open questions: ${r.error.message}`);
      return r.count ?? 0;
    },
    async get(userId, ids) {
      return (must(
        await admin.from("career_apply_questions").select(COLS).eq("user_id", userId).in("id", ids),
        "read the questions shown",
      ) ?? []).map(shape);
    },
    async answer(userId, id, answer) {
      must(await admin.rpc("career_apply_question_answer_as", { p_user: userId, p_id: id, p_answer: answer }), "save the answer");
    },
    async shown(userId) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", "career:questions-shown").maybeSingle(), "read the questions shown");
      const v = r?.value;
      if (!(v && typeof v.thread === "string" && Array.isArray(v.ids))) return null;
      const drafts: Record<string, PendingDraft> = {};
      for (const [id, d] of Object.entries(v.drafts && typeof v.drafts === "object" ? v.drafts : {})) {
        const x = d as any;
        if (x && typeof x.text === "string" && x.text.length <= 2000 && typeof x.at === "string" && Number.isInteger(x.n)) drafts[id] = { text: x.text, at: x.at, n: x.n };
      }
      const skipped = Array.isArray(v.skipped) ? v.skipped.slice(0, 200).map(String) : [];
      return { thread: v.thread, ids: v.ids.map(String), at: String(v.at), ...(Object.keys(drafts).length ? { drafts } : {}), ...(skipped.length ? { skipped } : {}) };
    },
    async setShown(userId, s) {
      must(await admin.from("career_watch_kv").upsert({ user_id: userId, key: "career:questions-shown", value: s }, { onConflict: "user_id,key" }), "keep the questions shown");
    },
    async onPostings(userId, jobIds) {
      if (!jobIds.length) return [];
      return (must(
        await admin.from("career_apply_questions").select(COLS).eq("user_id", userId).overlaps("job_ids", jobIds).limit(200),
        "read the posting's questions",
      ) ?? []).map(shape);
    },
    // G2: the person's own messages (their threads, role user) that mention sponsorship or authorization, or their name,
    // email or phone (SUBMIT-STEER-1130), newest 200.
    async statements(userId) {
      const threads = (must(await admin.from("agent_threads").select("id").eq("user_id", userId).limit(500), "read the person's threads") ?? [])
        .map((t: any) => t.id);
      if (!threads.length) return [];
      const rows = must(
        await admin.from("agent_messages").select("content,created_at").in("thread_id", threads).eq("role", "user")
          .or("content.ilike.%sponsor%,content.ilike.%authori%,content.ilike.%eligible to work%,content.ilike.%permitted to work%,content.ilike.%work authoris%," +
            "content.ilike.%name is%,content.ilike.%email%,content.ilike.%e-mail%,content.ilike.%phone%,content.ilike.%number is%,content.ilike.%reach me at%,content.ilike.%text me at%")
          .order("created_at", { ascending: false }).limit(200),
        "read the person's own statements",
      ) ?? [];
      return rows.filter((r: any) => typeof r.content === "string" && r.created_at).map((r: any) => ({ text: r.content, at: String(r.created_at) }));
    },
    // G4: the drafts written ahead (prepare-ahead.ts) for these of the person's open questions.
    async drafted(userId, ids) {
      if (!ids.length) return {};
      const rows = must(await admin.rpc("career_apply_question_drafts_as", { p_user: userId, p_ids: ids }), "read the drafts written ahead") ?? [];
      const out: Record<string, AheadDraft> = {};
      for (const r of rows) if (r && typeof r.text === "string" && r.text.trim()) out[String(r.question_id)] = { text: r.text, at: String(r.drafted_at) };
      return out;
    },
    async lastAssistantIntent(threadId) {
      const rows = must(
        await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1),
        "read the last reply",
      );
      return rows?.[0]?.meta?.intent ?? null;
    },
  };
}
