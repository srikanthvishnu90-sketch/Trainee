// 1v1 (2026-11-01): the rubric, checked by script (no judge, no model, free). Every scenario's gold reply must pass its
// own rubric (tests/architect/one-v-one-texting.test.ts proves it), so a Trainee failure is a real gap, not a strict check.
//
// What a reply is: the messages the person's phone shows, in order (link-only messages included). The checks follow the
// owner's requirement docs, cited by number only: Q73/Q89 numbered options; Q74/Q581 no markdown on texting channels;
// Q75/Q76/Q91 no filler openers, closers or banned phrases; Q77/Q87/Q88 one to three short sentences a bubble and a few
// bubbles at most; Q79 no emoji; Q94 no internal jargon; Q583-Q585/Q632/Q633 every link is a full URL alone on its own
// line, right after the line that says what it is, and only a link that exists (D-007: nothing invented).
import { findUrls } from "../../../supabase/functions/_shared/channel_text.ts";
import { WORLD_PAY_TEXT, WORLD_COMPANIES } from "./postings.ts";

export type Channel = "imessage" | "sms" | "whatsapp" | "telegram" | "web";
export const TEXTING: Channel[] = ["imessage", "sms", "whatsapp", "telegram"];

export interface Rubric {
  maxBubbles?: number; // text messages (a message that is only a link is not counted); default 3
  maxBubbleChars?: number; // each text message, links left out; default 320
  maxChars?: number; // all text, links left out; default 480
  maxQuestions?: number; // default 1
  askOne?: boolean; // the reply must ask exactly one question
  links?: number; // at least this many links; default 0
  maxLinks?: number; // default 3
  numbered?: boolean; // options are numbered 1., 2., ... (Q89)
  must?: string[]; // regexes (case-insensitive) that must all match: required facts
  mustNot?: string[]; // regexes that must not match: forbidden claims and invented facts
}

export const CHECKS = ["bubbles", "bubble_len", "length", "markdown", "links_present", "link_format", "links_valid", "questions", "numbered", "facts", "claims", "invented", "substance", "voice"] as const;
export type Check = typeof CHECKS[number];
export const CHECK_WHAT: Record<Check, string> = {
  bubbles: "too many text bubbles (Q77, Q87, Q88)",
  bubble_len: "a bubble longer than a text (Q77)",
  length: "reply too long overall (Q87, Q88)",
  markdown: "markdown a phone shows raw: **bold**, # headings, tables, [label](url), code fences (Q74, Q581)",
  links_present: "a link the reply needed is missing (Q583, Q587)",
  link_format: "a link not alone on its own line right after the line that says what it is (Q584, Q585, Q632)",
  links_valid: "a link no tool returned and the person did not give (Q633, D-007)",
  questions: "more questions than allowed, or the one needed question missing (one question at most)",
  numbered: "options not numbered (Q73, Q89)",
  facts: "a required fact is missing",
  claims: "a forbidden claim (an action not taken, an invented fact, a wrong promise)",
  invented: "an invented fact (D-007): a pay figure, employer, person or sponsorship that neither the world, the gold nor the person gave",
  substance: "not a reply: empty, an echo of the person's message, or keywords without sentences",
  voice: "filler opener or closer, banned phrase, emoji, 'as an AI' or internal jargon (Q75, Q76, Q79, Q91, Q94)",
};

const BANNED = [/\bi'?d be happy to\b/i, /\bgreat question\b/i, /^\s*absolutely\b/i, /\blet me know if you need anything( else)?\b/i, /\bi hope this helps\b/i,
  /^\s*(certainly|sure thing|of course)\b/i, /\bthanks for asking\b/i, /\bas an ai\b/i, /\blanguage model\b/i];
// Words from inside the product that mean nothing to the person (Q94).
const JARGON = [/\bpayload\b/i, /\bsource class\b/i, /\bnull\b/, /\bundefined\b/, /\bNaN\b/, /\[object /, /\brouter\b/i, /\bintent\b/i, /\bthe tracker moves\b/i,
  /\bno row\b/i, /\bcompany[- ]file\b/i, /\b20\d\d-\d\d-\d\d\b/, /\bsized by what the sources yield\b/i, /\bheld for your approval\b/i, /\bcontainment\b/i, /\bboundary\b/i];
const EMOJI = /\p{Extended_Pictographic}/u;

const linkOnly = (b: string) => { const t = b.trim(); const u = findUrls(t); return u.length === 1 && u[0].start === 0 && u[0].end === t.length; };
const noUrls = (s: string) => { let out = "", at = 0; for (const u of findUrls(s)) { out += s.slice(at, u.start); at = u.end; } return out + s.slice(at); };
// The text a person reads: Telegram's HTML tags are the platform's formatting, not characters on screen.
export const visible = (b: string, ch: Channel) => ch === "telegram" ? b.replace(/<\/?(b|i|s|u|code|pre|a)( [^>]*)?>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : b;

function markdownIn(text: string, ch: Channel): boolean {
  if (/```/.test(text) || /^\s{0,3}#{1,6}\s/m.test(text) || /^\s*\|.*\|\s*$/m.test(text)) return true;
  if (ch === "web") return false;
  return /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\//.test(text) || (ch !== "whatsapp" && /(^|\s)\*[^*\s][^*\n]*\*(?=\s|$|[.,!?])/m.test(text)) || /^\s*[*•]\s/m.test(text);
}
function questionCount(text: string): number {
  const t = noUrls(text).replace(/"[^"\n]*"|“[^”\n]*”/g, "");
  return (t.match(/\?/g) || []).length;
}

export interface Graded { pass: boolean; failed: Check[]; why: Partial<Record<Check, string>> }
// What a scenario allows a reply to state beyond its gold: the person's own words, the links the scenario allows (the gold's
// own, plus the postings a search there can truly return), and the world's companies and posted pay.
export interface GradeCtx { said?: string; gold?: string[]; links?: Iterable<string>; state?: string }

// D-007 beyond links. Money: every figure must be one the gold, the person or a posting in the world states. People: a
// first name from a common-name list followed by a capitalized word, unless the gold or the person named them. Employers:
// a well-known employer the world has no posting for, unless the gold or the person named it. Sponsorship: saying an
// employer sponsors when the gold does not.
const FIRST = new Set(("james john robert michael william david richard joseph thomas charles mary patricia jennifer linda elizabeth barbara susan jessica sarah karen " +
  "nancy lisa betty dana emily emma olivia ava sophia mia amelia harper evelyn abigail liam noah oliver elijah lucas mason logan ethan jacob jack daniel " +
  "matthew henry alex alexander ryan kevin brian jason eric adam mark steven paul andrew joshua kenneth anna grace chloe rachel laura megan amy kate maria " +
  "jordan taylor morgan casey riley jamie avery chris sam priya raj wei li mohammed ahmed fatima").split(" "));
// Written as the employer writes its name: matched case-sensitively, so "target" or "meta" as ordinary words are not employers.
const EMPLOYERS = ["Google", "Alphabet", "Meta", "Facebook", "Amazon", "Apple", "Microsoft", "Netflix", "Tesla", "Nvidia", "NVIDIA", "Salesforce", "Oracle", "IBM", "Intel",
  "Uber", "Lyft", "Airbnb", "DoorDash", "OpenAI", "Anthropic", "Spotify", "Shopify", "Coinbase", "Robinhood", "Palantir",
  "Goldman Sachs", "Goldman", "Morgan Stanley", "JPMorgan", "JP Morgan", "Citi", "Citadel", "Jane Street", "Blackstone", "Lazard", "Moelis", "Centerview",
  "McKinsey", "Bain", "BCG", "Deloitte", "PwC", "KPMG", "Accenture", "Kaiser", "Mayo Clinic", "Northwestern Medicine", "Walmart", "Target", "Costco"];
// Pay: a dollar figure of 1,000 or more, a "95k", or an hourly "$50/hour"; small amounts ("a $10 increase") are not pay.
const moneyOf = (t: string): number[] => {
  const out: number[] = [];
  for (const m of noUrls(t).matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|K)?(\s?(?:\/|an?\s|per\s)(?:hour|hr))?|\b(\d{2,3})\s?(k|K)\b/g)) {
    const n = Number(String(m[1] ?? m[4]).replace(/,/g, "")) * ((m[2] || m[5]) ? 1000 : 1);
    if (Number.isFinite(n) && (n >= 1000 || m[3])) out.push(n);
  }
  return out;
};
function inventedIn(text: string, c: GradeCtx): string | null {
  const known = [c.said ?? "", ...(c.gold ?? []), c.state ?? "", WORLD_PAY_TEXT].join("\n");
  const okMoney = new Set(moneyOf(known));
  const badMoney = moneyOf(text).find((n) => !okMoney.has(n));
  if (badMoney !== undefined) return `a pay figure nobody gave: ${badMoney}`;
  const lowKnown = known.toLowerCase(), plain = noUrls(text);
  for (const m of plain.matchAll(/\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g)) {
    if (EMPLOYERS.includes(m[0]) || WORLD_COMPANIES.includes(m[2])) continue; // "Morgan Stanley", "Jordan at Plaid" are not people
    if (FIRST.has(m[1].toLowerCase()) && !lowKnown.includes(m[0].toLowerCase()) && !lowKnown.includes(m[1].toLowerCase())) return `a person nobody named: ${m[0]}`;
  }
  for (const e of EMPLOYERS) {
    if (!new RegExp(`\\b${e}\\b`).test(plain) || WORLD_COMPANIES.includes(e) || lowKnown.includes(e.toLowerCase())) continue;
    // Google as the person's own account (Gmail, Calendar, sign-in) is not an employer.
    if (e === "Google" && /\bGoogle\b[^.\n]{0,25}\b(gmail|account|sign|calendar|drive|connect)|\b(connect|connect my|sign in with|your|my)\s+Google\b/i.test(plain)) continue;
    return `an employer nobody gave: ${e}`;
  }
  const sponsors = /\b(sponsors|will sponsor|does sponsor|can sponsor|offers? (visa |h-?1b )?sponsorship|sponsorship (is )?(available|offered))\b/i;
  if (sponsors.test(text) && !(c.gold ?? []).some((g) => sponsors.test(g))) return "says an employer sponsors";
  return null;
}

// A reply, not an echo or a keyword list: some sentence of four or more words with an ordinary function word in it, and not
// the person's own message given back.
const CORE = new Set("the a an to for of in on at with from your you i it is are be was that this my me we and or if so but not no".split(" "));
function substanceOf(text: string, said: string): string | null {
  const t = noUrls(text).replace(/\s+/g, " ").trim();
  if (!t) return "empty";
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const e = norm(t), m = norm(said);
  if (m && (e === m || (m.length > 12 && e.includes(m) && e.length < m.length + 20))) return "an echo of the message";
  const words = e.split(" ").filter(Boolean);
  if (words.length <= 2) return null; // a one- or two-word reply is judged by its rubric ("Anytime.")
  const core = words.filter((w) => CORE.has(w));
  // A sentence: some piece ending in . ! ? or : of three or more words with an ordinary function word, or two different
  // function words across the reply (a list of keywords has neither).
  const sentence = t.split(/(?<=[.!?:])\s+|\n/).some((x) => /[.!?:]$/.test(x.trim()) && x.split(" ").filter(Boolean).length >= 3 && x.toLowerCase().split(/[^a-z']+/).some((w) => CORE.has(w)));
  if (!sentence && new Set(core).size < 2) return "keywords, no sentences";
  return null;
}

export function grade(bubbles: string[], ch: Channel, r: Rubric, ctx: string | GradeCtx = ""): Graded {
  const c: GradeCtx = typeof ctx === "string" ? { said: ctx } : ctx;
  const said = c.said ?? "";
  const shown = bubbles.map((b) => visible(String(b ?? ""), ch)).filter((b) => b.trim());
  const text = shown.join("\n");
  const textBubbles = shown.filter((b) => !linkOnly(b));
  const why: Partial<Record<Check, string>> = {};
  const fail = (c: Check, w: string) => { if (!why[c]) why[c] = w; };
  if (!shown.length) fail("bubbles", "no reply");
  const maxB = r.maxBubbles ?? 3;
  if (textBubbles.length > maxB) fail("bubbles", `${textBubbles.length} text bubbles (max ${maxB})`);
  const maxBC = r.maxBubbleChars ?? 320;
  const longest = Math.max(0, ...textBubbles.map((b) => noUrls(b).trim().length));
  if (longest > maxBC) fail("bubble_len", `a bubble of ${longest} chars (max ${maxBC})`);
  const total = noUrls(text).replace(/\s+/g, " ").trim().length;
  if (total > (r.maxChars ?? 480)) fail("length", `${total} chars (max ${r.maxChars ?? 480})`);
  if (markdownIn(text, ch)) fail("markdown", "markdown found");
  const urls = findUrls(text).map((u) => u.url);
  if (urls.length < (r.links ?? 0)) fail("links_present", `${urls.length} links (need ${r.links})`);
  // Each link alone on its line, the line before it says what it is (not a link, not empty), at most maxLinks.
  const lines = shown.flatMap((b) => b.split("\n")).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const u = findUrls(lines[i]);
    if (!u.length) continue;
    if (!linkOnly(lines[i])) { fail("link_format", `a link inside a sentence: "${lines[i].slice(0, 80)}"`); break; }
    if (i === 0 || linkOnly(lines[i - 1])) { fail("link_format", "a link with no line before it saying what it is"); break; }
  }
  if (new Set(urls).size > (r.maxLinks ?? 3)) fail("link_format", `${new Set(urls).size} links (max ${r.maxLinks ?? 3})`);
  {
    const given = new Set(findUrls(said).map((u) => u.url));
    const allowed = new Set<string>([...(c.links ?? []), ...(c.gold ?? []).flatMap((g) => findUrls(g).map((u) => u.url))]);
    const bad = urls.filter((u) => !allowed.has(u) && !given.has(u));
    if (bad.length) fail("links_valid", `not from a tool or the person: ${bad[0]}`);
    const q = questionCount(text);
    if (q > (r.maxQuestions ?? 1)) fail("questions", `${q} questions`);
    if (r.askOne && q !== 1) fail("questions", `${q} questions (needs exactly one)`);
    if (r.numbered && !/^\s*1[.)]\s/m.test(text)) fail("numbered", "no numbered list");
    // Required facts are read from the words, not from a link (a URL naming "brex" is not the reply saying Brex).
    for (const m of r.must ?? []) if (!new RegExp(m, "i").test(noUrls(text))) { fail("facts", `missing /${m}/`); break; }
    for (const m of r.mustNot ?? []) if (new RegExp(m, "i").test(text)) { fail("claims", `says /${m}/`); break; }
    const inv = inventedIn(text, c);
    if (inv) fail("invented", inv);
    // "Anytime." to a thanks is a whole reply; the substance check needs a gold to know what a reply is.
    const sub = (c.gold ?? []).join(" ").split(/\s+/).length >= 4 ? substanceOf(text, said) : null;
    if (sub) fail("substance", sub);
    const first = textBubbles[0] ?? "";
    const v = BANNED.find((b) => b.test(text) || b.test(first)) ?? JARGON.find((j) => j.test(noUrls(text)));
    if (v) fail("voice", `matches ${v}`);
    else if (EMOJI.test(text)) fail("voice", "emoji");
    const failed = CHECKS.filter((c) => why[c]);
    return { pass: failed.length === 0, failed, why };
  }
}
