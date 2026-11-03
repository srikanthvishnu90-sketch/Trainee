// WO-022 W2 + W3: the card of prepared applications and the one text that answers it. Code decides what was approved;
// the model never does. D-031 (SERIAL-1440): one text yes within 10 minutes approves exactly the batch the card shows,
// once, by the hashes it carries; it never sends. SERIAL-1451: the yes answers the card this thread showed (its id in the
// reply's meta) and no other; the 10-minute window is also the database's (20261025170000). Every word of a card comes
// from the engine's own card lines (what the dry run read back from the form); every word of an answer from the queue's
// own results.
//
// D-MS-1 (owner, 2026-10-27, replaces Option A and SERIAL-1461's reply-only rule): a texted yes on any channel (SMS and
// iMessage, WhatsApp, Telegram, the web app) approves exactly the batch that was shown to the person: the card that is
// this thread's last word, or the card whose message the text replies to. Each item stays bound to its payload hash
// (career_apply_card_answer_as): one that changed since it was shown is refused by name and the rest go on. "yes except
// 3", "not Acme" and "only 1, 2 and 5" approve the stated subset; "wait" holds; "maybe", "ok?", "1 or 2" approve nothing
// and say how to answer. Of two cards shown, only the latest can be approved (opening a card closes the older one).
// D-MS-2: one card carries the whole batch (no 8-per-card limit on "show my applications"); it is paged into messages
// for reading, and one yes covers every page.
//
// Declining is "no", never "stop": over SMS, STOP is the carrier's opt-out keyword, and trainee-inbound treats it as the
// channel command that silences every text before a turn runs.
//
// WO-027: each answered line is written to the account's timeline (approved, or the reason it was not sent). A timeline
// that cannot be written never changes the answer.
import { type EventStore, recordEvents } from "./agent/timeline.ts";
import { sameCompany } from "./career_mail.ts";
import { approvalWords } from "./approval_words.ts";

export interface Prepared {
  id: string;
  company: string;
  card_lines: string[];
  created_at?: string;
  resume_sha256?: string | null; // the payload's resume hash, when the store reads it (OWNER RULE 2026-10-26)
}
export interface Card {
  id: string;
  items: { n: number; prepared_id: string; payload_hash: string }[];
  shown_at: string;
}
export interface CardResult {
  n: number;
  company: string;
  result: string;
}
export interface CardStore {
  pending(userId: string): Promise<Prepared[]>; // ready, or shown on a card that closed: oldest first
  open(userId: string, ids: string[]): Promise<Card>;
  // One Confirm (the jobs page's Apply, Telegram's Confirm): open a card of exactly these prepared applications, each still at
  // exactly the hash the person approved, and approve every item, in ONE transaction (career_apply_card_confirm_as). Opening a
  // card closes the person's other open cards, so an open and an answer in two calls let two approvals at once close each
  // other's card and both approve nothing. Throws card_changed (a hash differs) or invalid card (no longer open to approve).
  confirm?(userId: string, ids: string[], hashes: string[]): Promise<{ card: Card; results: CardResult[] }>;
  latestOpen(userId: string): Promise<Card | null>;
  answer(userId: string, cardId: string, approve: number[]): Promise<CardResult[]>;
  lastAssistantIntent(threadId: string): Promise<string | null>;
  // SERIAL-1451: the card this thread's last reply showed (its id in that message's meta), or null. A yes answers that
  // card and no other: a newer card shown in another thread closes it, and the yes then approves nothing.
  lastShownCard(threadId: string): Promise<string | null>;
  // SERIAL-1460 (2): the card the given message of this thread showed (meta.card_id), or null when that message is not a
  // card. Read only when the channel passes the id of the message a yes replies to.
  cardOfMessage?(threadId: string, messageId: string | number, userId: string): Promise<string | null>;
  // D-MS-1: what became of a card that is no longer open: answered by the person, or closed by a newer card. Absent,
  // a yes to a card no longer open is not this turn's.
  cardState?(userId: string, cardId: string): Promise<"open" | "answered" | "closed" | null>;
  // SCALE: the employer of each of these prepared applications (a card's items), in one bounded read, for "not Acme".
  cardCompanies?(userId: string, preparedIds: string[]): Promise<Map<string, string>>;
}

// D-MS-1 (owner, 2026-10-27): the forms a person answers a card with. Anything else is not an answer and goes to the
// brain as any other text. Every shape here is checked again against the card itself before anything is approved.
export type CardReply =
  | { kind: "show" }
  | { kind: "yes"; except: number[]; exceptNames?: string[]; count?: number }
  | { kind: "only"; only: number[]; onlyNames?: string[] }
  | { kind: "except_only"; except: number[]; exceptNames?: string[] } // "not Acme" with no yes: asked, never approved
  | { kind: "no" }
  | { kind: "hold" }
  | { kind: "unclear" }
  | { kind: "change"; n: number };

export const CARD_INTENT = "career_apply_card";
export const CARD_ANSWER_INTENT = "career_apply_card_answer";
// The pushed card (career_proactive_run / career_prepare_ahead) is one text of at most 4,000 characters, and the
// database's push takes at most 8 until builder A's D-MS-2 migration. It is a size for one text, never a limit on what
// one yes approves: "show my applications" shows the whole batch (batchFor) and one yes approves all of it.
export const MAX_PER_CARD = 8;
export const YES_WINDOW_MS = 10 * 60_000; // D-031: a text yes counts only this long after the card was shown
export const CARD_CHAR_BUDGET = 1600; // one pushed card with two or more applications stays under this
export const CARD_HARD_LIMIT = 4000; // one application alone may go up to the outbox's limit, never cut
// D-MS-2: the batch shown on "show my applications" is paged into messages of at most PAGE_CHARS for reading (one text
// each); one yes covers every page. There is no page or item ceiling (NO LIMITS, owner 2026-10-27).
export const PAGE_CHARS = 3800;
// Until builder A's D-MS-2 migration lands, the database refuses a card of more than 8 ('invalid card'). Only then is a
// card of 8 shown, and the reply says how many more are waiting.
export const DB_CARD_MAX_BEFORE_DMS2 = 8;

const YES_WORD = /^(?:yes|yep|yeah|yea|yup|ya|y|ok|okay|sure)\b[ ,!:;-]*/;
const ALL_BODY = new RegExp(
  "^(?:(?:please|pls)\\s+)?(?:" + [
    "approve(?: (?:all|them|it|everything|them all|all of them|the batch|the card|the lot))?",
    "send(?: (?:them|it|all|everything|them all|all of them|the batch|the lot))?",
    "submit(?: (?:them|it|all|everything|them all|all of them))?",
    "to all(?: of them)?", "to everything", "all(?: of them)?", "everything", "every one", "the lot",
    "go ahead", "go for it", "do it", "confirm(?:ed)?", "lgtm", "please",
  ].join("|") + ")(?: (?:all )?(\\d{1,4}))?(?: of them)?(?:,? please)?$",
);
const ONLY_HEAD = /^(?:(?:approve|send|submit|apply to|do|yes to|to)\s+)?(?:only|just)\s+(.+)$/;
const PICK_HEAD = /^(?:approve|send|submit|yes to)\s+(?:numbers?\s+|#)?(.+)$/;
const EXCEPT_HEAD =
  /^(?:(?:but|and)\s+)?(?:(?:approve|send|submit)\s+)?(?:(?:all|everything|them all|the rest|every one)\s+)?(?:but not|but|except for|except|excluding|without|minus|skip(?:ping)?|not|leave out|leaving out|drop|other than|apart from)\s+(.+)$/;
const NO =
  /^(?:no|nope|nah|n|none|no thanks|no thank you|send none|skip all|skip them|skip them all|decline|decline all|decline them|reject|reject all|cancel|cancel it|cancel all|cancel them|none of them|no to all|not any|don'?t send(?: (?:them|any|it|anything))?|do not send(?: (?:them|any|it|anything))?|no,? don'?t send(?: (?:them|any|it|anything))?)$/;
const HOLD =
  /^(?:wait|wait a (?:sec|second|minute|moment)|hold on|hold up|hang on|not yet|not now|later|one sec(?:ond)?|give me a (?:sec|second|minute|moment)|let me (?:think|check|look)(?: (?:about it|first|again))?|pause|stop,? (?:don'?t|do not) send(?: (?:it|them|anything))?(?: yet)?|wait,? (?:don'?t|do not) send(?: (?:it|them|anything))?(?: yet)?|(?:don'?t|do not) send (?:it|them|anything) yet|wait,? stop|stop,? wait|hold off|hold them|hold it)(?:,? please)?$/;
const UNCLEAR =
  /^(?:maybe|maybe later|perhaps|possibly|probably|i guess|i think so|not sure|unsure|idk|i don'?t know|dunno|hmm+|um+|ok|okay|k|kk|sure|yes but|yes and no|kind of|sort of|yes no|no yes|only|just|except|but)$/;
const DEFER_OR_NONE =
  /\b(?:none|nothing|nobody|no ?one|neither|later|wait|waiting|hold|holding|pause|tomorrow|tonight|today|soon|after|afterwards|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend|morning|evening|not (?:now|yet)|never|don'?t|do not|cancel|stop|maybe|unless|until|if)\b/;
const CARD_VERB = /^(?:approve|send|submit|go ahead|apply|only|just|all|everything|confirm)\b/;
const NAME_STOP = new Set([
  "the", "it", "that", "this", "them", "these", "those", "one", "ones", "all", "any", "some", "others", "rest", "me",
  "please", "yes", "no", "yet", "now", "sure", "so", "really", "everything", "i", "you",
  "approve", "send", "submit", "apply", "confirm", "go", "go ahead",
]);
const NAME_DESCRIBES = new Set(["one", "ones", "in", "at", "from", "with", "that", "which", "where", "first", "last", "other", "whatever", "something", "remote", "onsite"]);

// "1, 2 and 5", "3-5", "#2", "numbers 1 and 3", "acme and beta", "the acme one": numbers and employer names; null when
// a piece is neither (the reply is then not this shape), or uses "or" (a choice is not an answer).
export function parseSelection(raw: string): { nums: number[]; names: string[] } | null {
  let t = String(raw ?? "").trim().replace(/[.!]+$/, "").replace(/\s+(?:please|thanks|thank you)$/, "").trim();
  if (!t || /\bor\b/.test(t)) return null;
  t = t.replace(/^(?:numbers?|nos?\.?)\s+/, "");
  const nums: number[] = [], names: string[] = [];
  for (let piece of t.split(/\s*(?:,|;|\band\b|&|\+)\s*/).map((x) => x.trim()).filter(Boolean)) {
    // Word-bounded: "none" and "them" must not lose "no"/"the" and turn into a name ("ne", "m").
    piece = piece.replace(/^(?:(?:the|number|no\.?)\b|#)\s*/, "").replace(/\s+(?:one|ones|role|job|application|posting)$/, "").trim();
    if (/^\d{1,4}(?:\s+\d{1,4})+$/.test(piece)) {
      nums.push(...piece.split(/\s+/).map(Number));
      continue;
    }
    let m = /^#?\s*(\d{1,4})(?:st|nd|rd|th)?$/.exec(piece);
    if (m) {
      nums.push(Number(m[1]));
      continue;
    }
    m = /^(\d{1,4})\s*(?:-|–|to|through|thru)\s*(\d{1,4})$/.exec(piece);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a < 1 || b < a || b - a > 1000) return null;
      for (let i = a; i <= b; i++) nums.push(i);
      continue;
    }
    // An employer's name: a few words, none of them a description ("the one in Ohio" is not a name: unclear).
    if (/^[a-z][a-z0-9&.' -]{0,60}$/.test(piece) && !NAME_STOP.has(piece) && piece.split(" ").length <= 4 &&
      !piece.split(" ").some((w) => NAME_DESCRIBES.has(w))) {
      names.push(piece);
      continue;
    }
    return null;
  }
  if (!nums.length && !names.length) return null;
  if (nums.some((n) => n < 1)) return null;
  return { nums: [...new Set(nums)], names: [...new Set(names)] };
}

export function parseCardReply(text: string): CardReply | null {
  // A thumbs-up alone, or "yess"/"yse" alone, is "yes" (approval_words.ts).
  const raw = approvalWords(String(text ?? "")).toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();
  const asked = /\?\s*$/.test(raw);
  const t = raw.replace(/[.!?]+$/, "").trim();
  if (!t) return null;
  if (
    /^(show|see|send|list)( me)? (my )?(prepared |ready )?applications$|^applications ready$|^what'?s ready( to send)?$/
      .test(t)
  ) {
    return { kind: "show" };
  }
  // "stop" alone is the carrier's opt-out (and the host's pause): never a card answer.
  if (t === "stop") return null;
  if (HOLD.test(t)) return { kind: "hold" };
  if (NO.test(t)) return asked ? { kind: "unclear" } : { kind: "no" };
  if (UNCLEAR.test(t)) return { kind: "unclear" };
  // Fail closed (owner, 2026-10-28): a reply that also says "none", "nothing", "later", "wait", "hold" or names a time
  // ("approve none", "send it later", "yes but wait", "yes except none") approves nothing.
  if (DEFER_OR_NONE.test(t) && (YES_WORD.test(t) || CARD_VERB.test(t))) return { kind: "unclear" };
  // A choice ("1 or 2", "yes to 1 or 2") is not an answer anyone can act on.
  if (/^(?:(?:yes|approve|send)(?: to)?\s+)?#?\d{1,4}(?:\s*(?:,|or)\s*#?\d{1,4})*\s+or\s+#?\d{1,4}$/.test(t)) return { kind: "unclear" };
  const c = t.match(/^change (?:number |#)?(\d+)\b/);
  if (c) return { kind: "change", n: Number(c[1]) };
  const yw = YES_WORD.exec(t);
  const softYes = !!yw && /^(?:ok|okay|sure)\b/.test(t);
  const hadYes = !!yw;
  const body = hadYes ? t.slice(yw![0].length).trim() : t;
  // A yes that is also a no ("yes no", "yes, no wait") is not an answer anyone can act on.
  if (hadYes && /^(?:no|nope|nah|wait|hold on|not yet|maybe)\b/.test(body) && !/^not\s+\S/.test(body)) return { kind: "unclear" };
  let r: CardReply | null = null;
  if (hadYes && !body) r = softYes ? { kind: "unclear" } : { kind: "yes", except: [] };
  if (!r) {
    const m = ALL_BODY.exec(body);
    if (m && (hadYes || body !== "please")) {
      // A count is read only with "all" ("approve all 60"); "approve 2" may mean number 2 or two of them: unclear.
      if (m[1] && !/\ball\b/.test(body)) return { kind: "unclear" };
      r = m[1] ? { kind: "yes", except: [], count: Number(m[1]) } : { kind: "yes", except: [] };
    }
  }
  // "approve, skip 2" / "send all but 3": a yes in other words, then what to leave out.
  if (!r && !hadYes) {
    const lead = /^(?:approve|send(?: them| all)?|submit|go ahead)[ ,;:-]+(.+)$/.exec(body);
    const m = lead ? EXCEPT_HEAD.exec(lead[1]) : null;
    const s = m ? parseSelection(m[1]) : null;
    if (m && !s) return { kind: "unclear" };
    if (s) {
      r = { kind: "yes", except: s.nums };
      if (s.names.length) r.exceptNames = s.names;
    }
  }
  if (!r) {
    const m = EXCEPT_HEAD.exec(body);
    if (m) {
      const s = parseSelection(m[1]);
      if (!s) return hadYes ? { kind: "unclear" } : null;
      // "not Acme" alone says what to leave out, not that the rest should go: asked, never approved.
      const affirmed = hadYes || /^(?:(?:approve|send|submit)\s|(?:but|and)\s+(?:approve|send|submit)\s|(?:all|everything|them all|the rest|every one)\s)/.test(body);
      r = affirmed && !softYes ? { kind: "yes", except: s.nums } : { kind: "except_only", except: s.nums };
      if (s.names.length) r.exceptNames = s.names;
    }
  }
  if (!r) {
    const only = ONLY_HEAD.exec(body), pick = only ? null : PICK_HEAD.exec(body);
    const bare = !only && !pick && hadYes ? /^(?:to\s+)?(.+)$/.exec(body) : null;
    const m = only ?? pick ?? bare;
    const s = m ? parseSelection(m[1]) : null;
    if (only && !s) return { kind: "unclear" };
    // One unmarked number without "only"/"just" ("yes 3", "send 3") may be a count or a number: unclear. "#3",
    // "number 3" and "only 3" are clear.
    if (s && !only && !s.names.length && s.nums.length === 1 && !/(?:#|\bnumber\b|\bno\.)/.test(body)) return { kind: "unclear" };
    // A named employer after a bare "yes" ("yes acme") is not clear enough: unclear, never approved. A yes followed by a
    // sentence ("yes, that's my resume", "yes I want alerts for data jobs") is not about the card at all: the brain's.
    if (s && bare && s.names.length) {
      const nameLike = s.names.length === 1 && !s.nums.length && s.names[0].split(" ").length <= 2 &&
        !/\b(?:my|your|our|me|i|i'?m|it'?s|that'?s|this|is|are|was|were|be|do|did|want|need|have|got|can|will|would)\b/.test(s.names[0]);
      return nameLike ? { kind: "unclear" } : null;
    }
    if (s && (only || pick || !s.names.length)) {
      r = softYes && bare ? { kind: "unclear" } : { kind: "only", only: s.nums };
      if (r.kind === "only" && s.names.length) r.onlyNames = s.names;
    }
  }
  if (!r) {
    // "1, 2 and 5" alone, two or more numbers: those only. One bare number is a question, not an answer.
    const s = /^[\d\s,&+#-]+(?:\s*and\s+#?\d+)?$/.test(t) ? parseSelection(t) : null;
    if (s && !s.names.length && s.nums.length >= 2) r = { kind: "only", only: s.nums };
  }
  if (r && asked) return { kind: "unclear" };
  if (!r && hadYes && /^(?:but|except|only|just|and)\b/.test(body)) return { kind: "unclear" };
  return r;
}
// "approve 2" / "yes 3": exported for the tests' messy-phrasing tables.
export function isApproval(r: CardReply | null): boolean {
  return !!r && (r.kind === "yes" || r.kind === "only");
}

const one = (p: Prepared, n: number) => {
  const [head, ...rest] = p.card_lines.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  return [`${n}. ${head ?? p.company}`, ...rest.map((l) => `   ${l}`)].join("\n");
};
const HEAD = (count: number) =>
  `${count === 1 ? "1 application is" : `${count} applications are`} ready. Every answer below goes exactly as shown.`;
const FOOT = (count: number) =>
  count === 1
    ? `Reply "yes" to send it, or "no".`
    : `Reply "yes" to send all ${count}, "yes but not 2" to leave some out, or "no".`;

// The pushed card (one text): how many of the pending applications fit, at most 8, under 1,600 characters with two or
// more, and the first always (alone up to 4,000; an answer is never cut). The chat's own "show" uses batchFor.
export function cardFor(pending: Prepared[]): { take: Prepared[]; text: string } | { tooLong: Prepared } | null {
  if (!pending.length) return null;
  const take: Prepared[] = [];
  for (const p of pending.slice(0, MAX_PER_CARD)) {
    const next = [...take, p];
    const text = render(next);
    if (take.length && text.length > CARD_CHAR_BUDGET) break;
    take.push(p);
  }
  const text = render(take);
  if (text.length > CARD_HARD_LIMIT) return { tooLong: take[0] };
  return { take, text };
}
function render(list: Prepared[]) {
  return [HEAD(list.length), ...list.map((p, i) => one(p, i + 1)), FOOT(list.length)].join("\n\n");
}

// D-MS-1 / D-MS-2: the whole batch on one card, every line of every application verbatim, numbered 1..N, paged into
// messages of at most PAGE_CHARS; one yes approves all of it. An application too long for a text is left for the app
// and named. Only `max` (the database's bound before D-MS-2) holds some back for the next card, said so.
const BATCH_HEAD = (count: number, pages: number) =>
  `${count === 1 ? "1 application is" : `${count} applications are`} ready. Every answer below goes exactly as shown.` +
  (pages > 1 ? ` This card comes in ${pages} messages; one "yes" approves all ${count}.` : "");
const BATCH_FOOT = (count: number) =>
  count === 1
    ? `Reply "yes" to send it, or "no".`
    : `Reply "yes" to send all ${count}, "yes but not 2" to leave some out, "only 1, 3" to send just those, or "no".`;
export interface Batch {
  take: Prepared[];
  text: string;
  parts: string[]; // the pages, when more than one message; [] when one holds it
  more: number; // ready but not on this card (only while the database's bound applies)
  skipped: Prepared[]; // too long for a text: left for the app
}
export function batchFor(pending: Prepared[], o: { max?: number } = {}): Batch | { tooLong: Prepared } | null {
  if (!pending.length) return null;
  const roomFor = PAGE_CHARS - BATCH_HEAD(9999, 99).length - 2;
  const fits = pending.filter((p) => one(p, 9999).length <= roomFor);
  const skipped = pending.filter((p) => !fits.includes(p));
  if (!fits.length) return { tooLong: pending[0] };
  const paginate = (k: number, pagesGuess: number) => {
    const take = fits.slice(0, k), more = fits.length - k;
    const tail = [
      ...(more > 0
        ? [`${more} more ${more === 1 ? "is" : "are"} ready; ${more === 1 ? "it comes" : "they come"} on the next card after you answer this one.`]
        : []),
      ...(skipped.length
        ? [`Too long to show in a text, so not on this card: ${skipped.map((p) => p.company).join("; ")}. Open ${skipped.length === 1 ? "it" : "them"} in the app.`]
        : []),
      BATCH_FOOT(k),
    ].join("\n\n");
    const blocks = [BATCH_HEAD(k, pagesGuess), ...take.map((p, i) => one(p, i + 1)), tail];
    const pages: string[] = [];
    let buf = "";
    for (const b of blocks) {
      if (buf && buf.length + 2 + b.length > PAGE_CHARS) {
        pages.push(buf);
        buf = b;
      } else buf = buf ? `${buf}\n\n${b}` : b;
    }
    if (buf) pages.push(buf);
    return { take, pages, more };
  };
  // NO LIMITS (owner, 2026-10-27 19:55 CDT): every application that fits a text is on this one card, however many pages;
  // only `max` (the database's own bound, before builder A's D-MS-2 migration) holds some back, and the card says so.
  const k = Math.max(1, Math.min(o.max ?? Infinity, fits.length));
  let guess = 1, p = paginate(k, guess);
  for (let i = 0; i < 4 && p.pages.length !== guess; i++) {
    guess = p.pages.length;
    p = paginate(k, guess);
  }
  return { take: p.take, text: p.pages.join("\n\n"), parts: p.pages.length > 1 ? p.pages : [], more: p.more, skipped };
}

const RESULT: Record<string, string> = {
  queued: "approved; it is sent next, from your computer or, if you turned it on, the cloud",
  declined: "not sent",
  left_out: "not sent: you left it out",
  said_no: "not sent: you said no",
  // NO LIMITS: the database says daily_cap only against a daily pace the person set themselves (CAPS-1390).
  daily_cap: "not sent: it is over the daily pace you set yourself; say \"no daily pace\" to lift it, then \"show my applications\"",
  company_cooldown: "not sent: you applied to them in the last 30 days",
  // The same posting is already in the person's applications: sent, being sent, or approved and waiting (a site that
  // asked us to slow down: it goes again by itself, 20261029180000). Never "you already applied" for one never sent.
  duplicate: "not added again: this posting is already in your applications (sent, or approved and waiting to go); each posting goes at most once",
  stale: "not sent: your details changed after it was prepared; prepare it again",
  no_resume: "not sent: there is no confirmed resume on file to send with it",
  changed: "not sent: it changed after the card was shown",
  pace_unreadable: "not sent: your saved daily pace could not be read; say \"set my daily pace to N\" or \"no daily pace\"",
  refused: "not sent: the queue refused it",
};
// The answer in the person's words, from the database's own per-item results (never from what was asked). `declined`
// says why an item the person did not approve was not sent.
export function answerText(results: CardResult[], o: { declined?: "left_out" | "said_no" } = {}): string {
  const queued = results.filter((r) => r.result === "queued").length;
  const notSent = results.length - queued;
  const lines = results.map((r) =>
    `${r.n}. ${String(r.company).replace(/\s+/g, " ").slice(0, 80)}: ${
      r.result === "declined" && o.declined ? RESULT[o.declined] : RESULT[r.result] ?? RESULT.refused
    }`
  );
  const changed = results.filter((r) => r.result === "changed").length;
  const head = queued
    ? `${queued} approved exactly as shown${notSent ? `; ${notSent} of the ${results.length} not sent, each below with why` : ""}. Nothing has gone to an employer yet.`
    : "Nothing was approved. Nothing went to an employer.";
  const after = changed
    ? [`${changed === 1 ? "1 application" : `${changed} applications`} changed after the card was shown, so ${changed === 1 ? "it was" : "they were"} not approved; say "show my applications" to see ${changed === 1 ? "it" : "them"} as ${changed === 1 ? "it is" : "they are"} now.`]
    : [];
  return [head, ...lines, ...after].join("\n");
}
// A long answer (a batch of 60) in messages of at most PAGE_CHARS, lines kept whole; [] when one message holds it.
export function pagesOf(text: string): string[] {
  if (text.length <= PAGE_CHARS) return [];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf && buf.length + 1 + line.length > PAGE_CHARS) {
      out.push(buf);
      buf = line;
    } else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out;
}

// OWNER RULE (2026-10-26): a card shows only applications that send a resume (the payload binds its sha256), and none
// at all while the person has no confirmed resume.
export const CARD_NO_RESUME = `I have no confirmed resume on file, so there is no application to show or approve. Send me your resume first: attach it as a PDF or Word file, or paste it here, then say it's yours.`;
export const CARD_RESUME_UNREAD = `I couldn't check your resume on file just now, so no card was shown and nothing was approved. Say "show my applications" again in a minute.`;
// Fail closed: a prepared application whose resume hash was not read (or is not a sha256) is never on a card.
export const sendsResume = (p: Prepared) => /^[a-f0-9]{64}$/.test(String(p.resume_sha256 ?? ""));
// One turn, before any brain. Returns null when the text is not about a card, so the turn goes on as before.
export const CARD_OUTDATED =
  `That card is out of date: a newer card was shown since, so nothing was approved. Say "show my applications" for the current one.`;
export const CARD_ANSWERED_BEFORE = "That card was already answered. Nothing more was sent.";
// SERIAL-1461 / 1480: what a yes typed as a reply to some other message (not the card) is told, by where it was typed.
// Under D-MS-1 a plain "yes" right after the card approves it on every channel; only a reply that quotes a message that
// is not the card approves nothing, and is told this.
export const NEEDS_REPLY =
  `Nothing was approved. To approve, reply directly to the card message (press and hold it, then Reply) and send "yes", or tap Approve in the app.`;
export const NEEDS_REPLY_CHANNEL =
  `Nothing was approved. To approve, reply directly to the card message (press and hold it, then Reply) and send "yes", or tap Approve on the card.`;
export const NEEDS_TAP_IMESSAGE = `Nothing was approved. To approve, tap the card to approve exactly what it shows.`;
export const CARD_NEEDS_REPLY_STATUS = "needs_reply";
// The channel's wording for a needs_reply answer: by whether this integration has a verified reply-id path there.
export function needsReplyTextFor(channel: string | null | undefined): string {
  return channel === "telegram" || channel === "whatsapp" ? NEEDS_REPLY_CHANNEL : channel === "imessage" ? NEEDS_TAP_IMESSAGE : NEEDS_REPLY;
}
const HOW = (count: number) =>
  count === 1
    ? `Reply "yes" to send it exactly as shown, or "no".`
    : `Reply "yes" to send all ${count} exactly as shown, "yes except 3" or "only 1, 2" to send some, or "no" to send none.`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const HOLD_TEXT = (count: number) =>
  `Okay, holding: nothing was approved and nothing was sent. When you're ready, ${lowerFirst(HOW(count))} A text yes counts within 10 minutes of the card; after that, say "show my applications" for a fresh one.`;
export const UNCLEAR_TEXT = (count: number) => `I couldn't tell which ones you mean, so nothing was approved. ${HOW(count)}`;
// The statuses after which the card is still waiting for its answer: the handler keeps it the thread's last word, with
// its id on the reply, so the next "yes" answers it. "card_outdated" waits only when it carries the current card's id.
export const CARD_WAITING = ["shown", "not_on_card", "change", "hold", "unclear", "not_named", "count_mismatch", "nothing_left", "confirm_except"];
export function cardWaiting(r: { status: string; card_id?: string }): boolean {
  return CARD_WAITING.includes(r.status) || (r.status === "card_outdated" && !!r.card_id);
}

export async function cardTurn(
  o: {
    message: string; userId: string; threadId: string; now: number; store: CardStore; events?: EventStore | null; replyTo?: string | number | null;
    // OWNER RULE (2026-10-26, "never submit applications without a real resume"): whether the person has a confirmed
    // resume on file (career_resume_on_file). false: no card is shown and none is opened; absent: not asked.
    resumeReady?: () => Promise<boolean | null>;
  },
): Promise<{ reply: string; status: string; card_id?: string; parts?: string[] } | null> {
  const r = parseCardReply(o.message);
  if (!r) return null;
  if (r.kind === "show") {
    // Fail closed (review of PR #194): only a confirmed "yes, on file" shows a card; "no" asks for the resume, and a check
    // that could not be made shows nothing and says so.
    if (o.resumeReady) {
      const ready = await o.resumeReady().catch(() => null);
      if (ready === false) return { reply: CARD_NO_RESUME, status: "no_resume" };
      if (ready !== true) return { reply: CARD_RESUME_UNREAD, status: "resume_unreadable" };
    }
    // OWNER RULE (2026-10-26): only applications that send a resume are ever on a card (sendsResume, fail closed).
    const pending = (await o.store.pending(o.userId)).filter(sendsResume);
    let c = batchFor(pending);
    if (!c) {
      return {
        reply: 'Nothing is ready for you to approve yet. Send me a job link with "apply me to" and I\'ll prepare it and send its card here; "where are my applications" says what is being prepared.',
        status: "empty",
      };
    }
    if ("tooLong" in c) {
      return {
        reply:
          `The application to ${c.tooLong.company} is too long to show in a text. Open it in the app to approve it.`,
        status: "too_long",
      };
    }
    let opened: Card;
    try {
      opened = await o.store.open(o.userId, c.take.map((p) => p.id));
    } catch (e) {
      // Before builder A's D-MS-2 migration the database refuses a card of more than 8: the first 8 are shown and the
      // reply says how many more wait. Any other refusal is the turn's error, as before.
      if (!(c.take.length > DB_CARD_MAX_BEFORE_DMS2 && /invalid card/.test(String((e as Error)?.message ?? e)))) throw e;
      const smaller = batchFor(pending, { max: DB_CARD_MAX_BEFORE_DMS2 });
      if (!smaller || "tooLong" in smaller) throw e;
      c = smaller;
      opened = await o.store.open(o.userId, c.take.map((p) => p.id));
    }
    return { reply: c.text, status: "shown", card_id: opened.id, ...(c.parts.length ? { parts: c.parts } : {}) };
  }
  // Which card the answer is about (D-MS-1). With the channel's reply-to id, the card whose message it replies to; a reply
  // to any other message is not about the card (a yes there approves nothing and says how). Without one (iMessage and
  // the web app never send one), the card this thread showed, only while it is still the thread's last word.
  const wantsApproval = r.kind === "yes" || r.kind === "only";
  const hasReply = o.replyTo !== undefined && o.replyTo !== null && String(o.replyTo) !== "";
  const repliedCard = hasReply && o.store.cardOfMessage ? await o.store.cardOfMessage(o.threadId, o.replyTo!, o.userId) : null;
  let shownId: string | null;
  if (hasReply) {
    if (!repliedCard) return wantsApproval ? { reply: NEEDS_REPLY, status: CARD_NEEDS_REPLY_STATUS } : null;
    shownId = repliedCard;
  } else {
    const last = await o.store.lastAssistantIntent(o.threadId);
    // A yes right after the card was answered: said so, never handed to the brain as a fresh yes.
    if (last === CARD_ANSWER_INTENT && wantsApproval) return { reply: CARD_ANSWERED_BEFORE, status: "answered_before" };
    if (last !== CARD_INTENT) return null;
    shownId = await o.store.lastShownCard(o.threadId);
  }
  const card = await o.store.latestOpen(o.userId);
  if (!card) {
    // No card is open: the one shown was answered, or a newer card closed it and that one was answered too.
    if (!shownId || !o.store.cardState) return null;
    const st = await o.store.cardState(o.userId, shownId);
    if (st === "answered") return { reply: CARD_ANSWERED_BEFORE, status: "answered_before" };
    if (st === "closed") return { reply: CARD_OUTDATED, status: "card_outdated" };
    return null;
  }
  // SERIAL-1451: and only for the card that was shown. Opening a card closes older ones, so of two cards shown only the
  // latest is open: a yes to the older one is out of date, and nothing is approved or declined on either.
  if (!shownId || shownId !== card.id) {
    // When the latest card is the one this thread showed last (a reply quoted an older card's message), that card stays
    // waiting: its id rides this reply, so the next plain yes answers it.
    const current = !hasReply ? null : await o.store.lastShownCard(o.threadId);
    return current === card.id
      ? { reply: `${CARD_OUTDATED.replace(/ Say "show my applications" for the current one\.$/, "")} The current card is the last one I showed you: reply "yes" to approve it.`, status: "card_outdated", card_id: card.id }
      : { reply: CARD_OUTDATED, status: "card_outdated" };
  }
  const numbers = card.items.map((i) => i.n);
  const total = numbers.length;
  const waiting = (reply: string, status: string) => ({ reply, status, card_id: card.id });
  if (r.kind === "change") {
    return waiting(
      `Application ${r.n} was not sent. To change an answer, change it where you keep your details and prepare it again; it comes back on a new card. To send the others, reply "yes except ${r.n}".`,
      "change",
    );
  }
  if (r.kind === "hold") return waiting(HOLD_TEXT(total), "hold");
  if (r.kind === "unclear") return waiting(UNCLEAR_TEXT(total), "unclear");
  // Names ("not Acme", "only Acme and Beta"): each must name at least one application on this card, by its employer.
  const names = r.kind === "yes" || r.kind === "except_only" ? r.exceptNames ?? [] : r.kind === "only" ? r.onlyNames ?? [] : [];
  const byName: number[] = [];
  if (names.length) {
    // Only the card's own items, one bounded read (cardCompanies); a store without it falls back to the pending list.
    const ids = card.items.map((i) => i.prepared_id);
    const companies = o.store.cardCompanies
      ? await o.store.cardCompanies(o.userId, ids)
      : new Map((await o.store.pending(o.userId)).map((p) => [p.id, p.company] as const));
    const missing: string[] = [];
    for (const name of names) {
      const hit = card.items.filter((i) => companies.has(i.prepared_id) && sameCompany(companies.get(i.prepared_id), name)).map((i) => i.n);
      if (!hit.length) missing.push(name);
      byName.push(...hit);
    }
    if (missing.length) {
      return waiting(`No application on this card is from ${missing.map((m) => `"${m}"`).join(" or ")}, so nothing was approved. ${HOW(total)}`, "not_named");
    }
  }
  const leaveOut = r.kind === "no" ? numbers : r.kind === "yes" || r.kind === "except_only" ? [...new Set([...r.except, ...byName])] : [];
  const pick = r.kind === "only" ? [...new Set([...r.only, ...byName])] : [];
  const unknown = [...new Set([...leaveOut, ...pick])].filter((n) => !numbers.includes(n));
  if (unknown.length) {
    return waiting(
      `This card has ${total === 1 ? "only number 1" : `numbers 1 to ${total}`}; there is no ${unknown.join(", ")}. Nothing was sent.`,
      "not_on_card",
    );
  }
  if (r.kind === "except_only") {
    const rest = total - leaveOut.length;
    return waiting(
      `Got it: not ${leaveOut.sort((a, b) => a - b).map((n) => `number ${n}`).join(", ")}. Nothing was approved yet. Reply "yes except ${leaveOut.join(", ")}" to send the other ${rest} exactly as shown, or "no" to send none.`,
      "confirm_except",
    );
  }
  if (r.kind === "yes" && r.count !== undefined && r.count !== total) {
    return waiting(`This card has ${total}, not ${r.count}, so nothing was approved. ${HOW(total)}`, "count_mismatch");
  }
  const approve = r.kind === "only" ? numbers.filter((n) => pick.includes(n)) : numbers.filter((n) => !leaveOut.includes(n));
  if (r.kind !== "no" && !approve.length) {
    return waiting(`That leaves nothing on this card to approve, so nothing was approved. Say "no" to decline all ${total}, or ${lowerFirst(HOW(total))}`, "nothing_left");
  }
  // D-031 (the owner, 2026-10-22 5:09 PM: one yes handles a batch of submissions) and D-MS-1 (2026-10-27): a yes to this
  // card, within 10 minutes of its showing, approves exactly the applications it names in one call, each by the payload
  // hash the card carries (career_apply_card_answer_as: an item that changed since is refused by name and the rest go
  // on; the card is single-use). The yes approves and never sends: the person's own worker claims and finishes. A "no"
  // declines at any time: declining sends nothing.
  if (approve.length && Date.parse(card.shown_at) < o.now - YES_WINDOW_MS) {
    return {
      reply:
        `That card was shown more than 10 minutes ago, so a text yes can't approve it; nothing was sent. Say "show my applications" for a fresh card, or tap Approve in the app.`,
      status: "stale_card",
    };
  }
  try {
    const results = await o.store.answer(o.userId, card.id, approve);
    // SCALE (owner, 2026-10-27): the batch's timeline lines in one write, never one round trip per item.
    await recordEvents(o.events, results.map((x) => ({
      user_id: o.userId,
      at: o.now,
      kind: x.result === "queued" ? "application_approved" : "status_change",
      subject: x.company,
      detail: { card: card.id, n: x.n, result: x.result },
      source: "card",
    })));
    const reply = answerText(results, { declined: r.kind === "no" ? "said_no" : "left_out" });
    const parts = pagesOf(reply);
    return { reply, status: "answered", ...(parts.length ? { parts } : {}) };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/card_expired/.test(msg)) {
      return {
        reply: `That card is more than a day old, so nothing was sent. Say "show my applications" to see them again.`,
        status: "expired",
      };
    }
    if (/card_stale/.test(msg)) {
      return {
        reply:
          `That card was shown more than 10 minutes ago, so a text yes can't approve it; nothing was sent. Say "show my applications" for a fresh card, or tap Approve in the app.`,
        status: "stale_card",
      };
    }
    if (/card_answered/.test(msg)) {
      return { reply: CARD_ANSWERED_BEFORE, status: "answered_before" };
    }
    throw e;
  }
}

// The store over the edge function's service client: every call names the person (the _as functions), and every read is
// scoped to them.
const PENDING_PAGE = 1000;
export function supabaseCardStore(admin: any): CardStore {
  const must = (r: any, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  return {
    async pending(userId) {
      // D-MS-2 and NO LIMITS: the whole batch, read in pages (PostgREST returns at most its max-rows per request), never cut.
      const out: Prepared[] = [];
      for (let from = 0; ; from += PENDING_PAGE) {
      const rows: Prepared[] = must(
        await admin.from("career_apply_prepared").select("id,company,card_lines,created_at,resume_sha256:payload->>resume_sha256").eq("user_id", userId)
          .in("state", ["ready", "shown"]).order("created_at", { ascending: true }).order("id", { ascending: true })
          .range(from, from + PENDING_PAGE - 1),
        "read prepared applications",
      ) ?? [];
      out.push(...rows);
      if (rows.length < PENDING_PAGE) return out;
    }
    },
    async open(userId, ids) {
      return must(await admin.rpc("career_apply_card_open_as", { p_user: userId, p_ids: ids }), "open a card");
    },
    async confirm(userId, ids, hashes) {
      return must(await admin.rpc("career_apply_card_confirm_as", { p_user: userId, p_ids: ids, p_hashes: hashes }), "confirm a card");
    },
    async latestOpen(userId) {
      const rows = must(
        await admin.from("career_apply_cards").select("id,items,shown_at").eq("user_id", userId).eq("state", "open")
          .order("shown_at", { ascending: false }).limit(1),
        "read the open card",
      );
      return rows?.[0] ?? null;
    },
    async answer(userId, cardId, approve) {
      return must(
        await admin.rpc("career_apply_card_answer_as", { p_user: userId, p_card: cardId, p_approve: approve }),
        "answer the card",
      );
    },
    async lastAssistantIntent(threadId) {
      const rows = must(
        await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant")
          .order("id", { ascending: false }).limit(1),
        "read the last reply",
      );
      return rows?.[0]?.meta?.intent ?? null;
    },
    async lastShownCard(threadId) {
      // The chat's "show" and the scheduled push (career_apply_card_push_for) both write the card's id as meta.card_id.
      const rows = must(
        await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant")
          .order("id", { ascending: false }).limit(1),
        "read the last reply",
      );
      const m = rows?.[0]?.meta;
      return m?.intent === CARD_INTENT && typeof m?.card_id === "string" ? m.card_id : null;
    },
    async cardCompanies(userId, ids) {
      const out = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 500) {
        const rows = must(await admin.from("career_apply_prepared").select("id,company").eq("user_id", userId).in("id", ids.slice(i, i + 500)), "read the card's employers") ?? [];
        for (const r of rows) out.set(String(r.id), String(r.company ?? ""));
      }
      return out;
    },
    async cardState(userId, cardId) {
      if (!/^[0-9a-f-]{36}$/i.test(String(cardId))) return null;
      const rows = must(
        await admin.from("career_apply_cards").select("state,answer").eq("user_id", userId).eq("id", cardId).limit(1),
        "read the card",
      );
      const c = rows?.[0];
      if (!c) return null;
      if (c.state === "open") return "open";
      return c.answer && typeof c.answer === "object" && "closed" in c.answer ? "closed" : "answered";
    },
    async cardOfMessage(threadId, messageId, userId) {
      // The app replies to its own message ids (agent_messages.id, this thread); a texting channel replies to the
      // provider's id of the message that went out, which the outbox recorded when it delivered the card's text
      // (career_outbox.provider_id / provider_ids, the row's card_id or its 'card:<id>' key). SERIAL-1462.
      const id = String(messageId).slice(0, 200);
      if (/^[0-9]{1,18}$/.test(id)) {
        const rows = must(
          await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").eq("id", Number(id)).limit(1),
          "read the replied-to message",
        );
        const m = rows?.[0]?.meta;
        if (m?.intent === CARD_INTENT && typeof m?.card_id === "string") return m.card_id;
      }
      const sent = must(
        await admin.from("career_outbox").select("key,card_id,provider_id,provider_ids").eq("user_id", userId).eq("status", "delivered")
          .or(`provider_id.eq.${JSON.stringify(id)},provider_ids.cs.{${JSON.stringify(id)}}`).limit(2),
        "read the replied-to text",
      );
      const row = Array.isArray(sent) ? sent[0] : null;
      if (!row) return null;
      if (typeof row.card_id === "string" && row.card_id) return row.card_id;
      return typeof row.key === "string" && row.key.startsWith("card:") ? row.key.slice(5) : null;
    },
  };
}
