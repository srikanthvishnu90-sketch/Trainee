// REPLY PROCEDURE (owner, 2026-11-01: "make sure the agent actually knows how to respond in a conversation similar to
// Claude/Instinct, same grammar process"). The steps every reply is composed by, written from the owner's response brief
// (Part 5, the response brain's requirements; Part 8, the builder prompt), in the architect's own words. It goes in the
// brain's system prompt (career_brain.ts agentTurn, the staged and full brain alike) and in the reply writer's rules
// (career_reply_writer.ts, the router's output rewritten in the texting voice). Code then holds what code can hold
// (shapeByProcedure: bubbles of at most three sentences, no markdown; procedureProblems: the checks the tests run on a reply).
// Instructions, not wording: no sentence here is meant to be sent.

export const REPLY_PROCEDURE = `HOW TO COMPOSE EVERY REPLY (in this order)
1. Read the whole message first and decide what they are actually asking for. Shorthand, typos and lowercase are fine to read; answer the question they meant.
2. Pick the size. A chat-sized answer (a status, a yes or no, one fact, two or three sentences) is one plain message, with no acknowledgment around it. Anything structured (a set of roles, a comparison, a plan, a summary) belongs in a file or page, never a wall of rows in chat: say one line about what is in it, with its caveat, and the link follows as its own message. Never write a URL yourself: links come from your tools and the system adds them; each sits alone on its own line, never inside a sentence.
3. The first sentence answers the question, or corrects it. If their premise is wrong, correct it with the actual numbers first, then help.
4. One idea per message, at most three sentences each. Plain sentences with contractions, the way a capable friend texts. No markdown: no asterisks, no headers, no backticks, no dash lists, no "1/3" counters. Match their register: a short casual message gets a short casual answer, careful if they are upset, always clear. One warm beat at most; no filler openers ("great question", "absolutely"), no "as an AI", no strings of exclamation marks.
5. Say what you don't know. Anything not verified is called unverified or unknown, with what would settle it. Never present a guess, a stale posting or an assumed fit as fact.
6. Ask at most one question, and only when a wrong guess would cost them something (money, an application, an email in their name, embarrassment). Otherwise pick the sensible reading, say in a few words that you assumed it, and go ahead.
7. End with one concrete next step: what you will do, or the one thing they can say to move it forward.
8. Never say something happened unless a tool did it this turn or the record shows it. "Queued", "sent", "submitted", "applied", "set up" and "I'll flag it" each need the action to be real.`;

// ------------------------------------------------------------------------------------------------ what code holds
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// Sentences of a paragraph: after . ! ? followed by a space and a capital, digit, $ or quote; URLs and decimals never end one.
export function sentencesIn(text: string): string[] {
  const masked = String(text ?? "").replace(URL_RE, (u) => "U".repeat(u.length)).replace(/(\d)\.(\d)/g, "$1,$2")
    .replace(/\b(e\.g|i\.e|vs|etc|Inc|St|Dr|Mr|Ms|Jr|Sr|No)\./g, (m) => m.replace(/\./g, ","));
  const out: string[] = [];
  let at = 0;
  const re = /[.!?…]+["”’)]?(?=\s+["“(]?[A-Z0-9$]|\s*$)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(masked));) {
    const end = m.index + m[0].length;
    const s = text.slice(at, end).trim();
    if (s) out.push(s);
    at = end;
  }
  const rest = text.slice(at).trim();
  if (rest) out.push(rest);
  return out;
}
const URL_ONLY = /^https?:\/\/\S+$/;
// A line's words, then each link it carried alone on the next line(s). Self-contained (no channel module): the brain eval's
// import closure is the reply code (scripts/launch/reply-code.ts). A link's own trailing punctuation (the sentence's period, a
// closing bracket) stays with the words; brackets left empty by the move go.
function linksOnOwnLine(text: string): string {
  return text.split("\n").map((line) => {
    const urls: string[] = [];
    const words = line.replace(/https?:\/\/[^\s<>"]+/g, (u) => {
      const m = /^(.*?)([.,;:!?)\]]*)$/.exec(u)!;
      urls.push(m[1]);
      return m[2];
    });
    if (!urls.length) return line;
    const rest = words.replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").replace(/\s*[:—–-]\s*$/, "").trim();
    return [...(rest && !/^[•\d.)\s-]*$/.test(rest) ? [rest] : []), ...[...new Set(urls)]].join("\n");
  }).join("\n");
}
const MARKDOWN_LINE = /^\s{0,3}#{1,6}\s+|^\s*[-*+]\s+(?=\S)/gm;
// Structured rows a person reads or approves as a whole (a card's answers, a numbered list, "Label: value") stay together.
const ROW = /^\s*(?:\d{1,3}[.)]\s|•\s|[A-Z][A-Za-z /&'()-]{0,40}:\s\S)/;
const structured = (lines: string[]) => { const rows = lines.filter((l) => ROW.test(l) && l.length <= 300).length; return rows >= 2 && rows >= Math.ceil(lines.length / 2); };

// The router's reply on a texting channel, held to steps 2 and 4 in code: markdown marks go (a link written [words](url)
// becomes "words url"), list dashes become bullets, and a paragraph of more than three sentences is split into paragraphs of
// at most three (each its own message on the channel). Not one word is added, dropped or changed; structured rows stay whole.
export function shapeByProcedure(reply: string): string {
  const text = String(reply ?? "")
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, l: string, u: string) => (l.trim() === u ? u : `${l.trim()} ${u}`))
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => a ?? b ?? "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_\n]*?)[*_](?=[\s.,!?;:)]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*+]\s+(?=\S)/gm, "$1• ");
  // A link never sits inside a sentence: the line's words, then each link alone on the next line (channel_voice.ts linksOnOwnLine).
  // A link moved out of "Here's the posting: <link>." leaves no stray mark behind ("posting:." reads "posting.").
  const paras = linksOnOwnLine(text).replace(/\s*[:—–]\s*([.,;!?])(?=\s|$)/g, "$1").split(/\n\s*\n/);
  const out: string[] = [];
  for (const p of paras) {
    const lines = p.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (structured(lines)) { out.push(lines.join("\n")); continue; }
    if (lines.some((l) => URL_ONLY.test(l.trim()))) {
      // Each link is its own message, right after the words that introduce it; the words around it keep the three-sentence cap.
      let buf: string[] = [];
      const flush = () => { for (let i = 0; i < buf.length; i += 3) out.push(buf.slice(i, i + 3).join(" ")); buf = []; };
      for (const l of lines) {
        if (URL_ONLY.test(l.trim())) { flush(); out.push(l.trim()); }
        else buf.push(...sentencesIn(l));
      }
      flush();
      continue;
    }
    const units = lines.flatMap((l) => sentencesIn(l));
    if (units.length <= 3) { out.push(lines.join("\n")); continue; }
    for (let i = 0; i < units.length; i += 3) out.push(units.slice(i, i + 3).join(" "));
  }
  return out.join("\n\n").trim();
}

// The checks a reply is held to (the tests run these; nothing here rewrites a reply).
export interface ProcedureCheck { claimsAllowed?: RegExp | null }
export function procedureProblems(reply: string, o: ProcedureCheck = {}): string[] {
  const text = String(reply ?? "").trim(), problems: string[] = [];
  if (!text) return ["empty"];
  if (/\*\*|__|`/.test(text) || MARKDOWN_LINE.test(text) || /\[[^\]\n]+\]\(https?:/.test(text)) problems.push("markdown");
  MARKDOWN_LINE.lastIndex = 0;
  for (const p of text.split(/\n\s*\n/)) {
    const lines = p.split("\n").filter((l) => l.trim());
    if (!lines.length || structured(lines)) continue;
    const n = lines.flatMap((l) => sentencesIn(l.replace(URL_RE, ""))).filter((s) => /[A-Za-z0-9]/.test(s)).length;
    if (n > 3) problems.push(`a message of ${n} sentences`);
  }
  const questions = sentencesIn(text.replace(URL_RE, "")).filter((s) => /\?["”’)]?$/.test(s.trim())).length;
  if (questions > 1) problems.push(`${questions} questions`);
  if (/^\s*https?:\/\//.test(text)) problems.push("a link before any words");
  // parity audit R04: a link alone on its line, never inside a sentence.
  if (text.split("\n").some((l) => { const t = l.trim(); return /https?:\/\/\S/.test(t) && !URL_ONLY.test(t); })) problems.push("a link inside a sentence");
  // parity audit R05: structure lives in a File, never a wall of rows in chat.
  const rows = text.split("\n").filter((l) => ROW.test(l)).length;
  if (rows >= 4) problems.push(`a wall of ${rows} rows`);
  // parity audit R02: no part counters.
  if (/(?:^|\s)\(?\d+\s*\/\s*\d+\)(?=\s|$)/m.test(text)) problems.push("a part counter");
  // parity audit R12: one warm beat at most; no strings of exclamation marks, no "as an AI".
  if (/!{2,}/.test(text) || (text.match(/!/g) ?? []).length > 1) problems.push("exclamation strings");
  if (/\bas an ai\b/i.test(text)) problems.push("as an AI");
  const claim = /\b(?:I(?:'ve| have)? (?:sent|submitted|applied|emailed|messaged|scheduled|booked|set up)|(?:has|have) been (?:sent|submitted|applied)|I'll flag it)\b/i;
  if (claim.test(text) && !(o.claimsAllowed && o.claimsAllowed.test(text))) problems.push("claims an action");
  if (/^(?:great question|absolutely|certainly|sure thing|of course|happy to help|no problem|i'd be happy|thanks for asking)\b/i.test(text)) problems.push("filler opener");
  return problems;
}

// The shaped reply as the messages it is sent as (each its own outbox row: channel_inbound.ts replyParts), so a channel that
// packs short paragraphs together still sends one idea per message. One paragraph: null (the reply goes as it is).
export function procedureParts(reply: string): string[] | null {
  const parts = shapeByProcedure(reply).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : null;
}
