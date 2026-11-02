// The reply path for an open career question: the model writes ONE short paragraph; code enforces it. Order:
//   1. strip every URL the model wrote and append the file link ourselves (code inserts the link, only when a file really exists);
//   2. lintChat (length cap, one paragraph, verdict first, no filler or canned opener, correct basics, no unsourced specifics);
//   3. on a failure, ask the model once to rewrite with the exact problems listed;
//   4. still failing: send a plain short verdict built from the brief's own verdict lines, with no link and no claim of a file.
import { lintChat } from "./chat.ts";
import type { ResearchResult } from "./index.ts";

type Ok = Extract<ResearchResult, { status: "ok" }>;
// RESEARCH SCENARIOS (2026-10-29): every link the model wrote counts, not only http(s) ones: a markdown link, a "www."
// address, a bare host with a path ("evil.example.com/apply") and a javascript:/data:/mailto: URI. The only link a reply
// carries is the file link code adds (withLink strips every one the model wrote, of any shape).
const MODEL_LINK = /\[([^\]]*)\]\([^)]*\)|[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|\b(?:javascript|data|vbscript|mailto|file):[^\s<>"']+|\bwww\.[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']*/gi;
export const stripUrls = (s: string) => s.replace(MODEL_LINK, (_m, label) => label ?? "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").replace(/[\s:]+$/, "").trim();
const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim();

export function withLink(paragraph: string, url: string | null): string {
  const body = stripUrls(paragraph).replace(/\s*\n+\s*/g, " ");
  if (!url) return body;
  return `${body.replace(/[.:]?$/, ".")} ${url}`;
}
export function problemsIn(paragraph: string, r: Ok, message: string): string[] {
  return lintChat(withLink(paragraph, r.file_url), { link: r.file_url, noLink: !r.file_url, facts: r.facts, person: r.person, message });
}
// Plain, short, true: what is realistic now and later (the brief's verdict lines), one thing to do this week, and the link.
// Each part is cut at a clause boundary so the paragraph is a Telegram message (about 60 to 90 words), not the brief's prose.
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1);
const wc = (s: string) => (s.match(/\S+/g) ?? []).length;
export function clip(text: string, max: number): string {
  let t = firstSentence(text).replace(/[.]+$/, "");
  if (wc(t) <= max) return t;
  const head = t.split(/\s*[;:]\s+/)[0];
  if (wc(head) >= 8 && wc(head) <= max) return head;
  t = head;
  const words = t.split(/\s+/);
  let cut = words.slice(0, max).join(" ");
  const i = Math.max(cut.lastIndexOf(", and "), cut.lastIndexOf(", "));
  if (i > 30) cut = cut.slice(0, i);
  return cut.replace(/[,\s]+(?:and|or|but|with|of|to|the|a|an)?$/i, "");
}
export function fallbackVerdict(r: Ok): string {
  const name = r.name ?? "";
  const lead = (t: string) => (/\bnow\b|\brealistic/i.test(t.slice(0, 80)) ? t : `Right now, ${lowerFirst(t)}`);
  const sNow = r.short?.now;
  // hand-written lines start "right now ..." and are named here; the template already names the occupation
  const now = sNow ? (name && !sNow.toLowerCase().includes(name.toLowerCase()) ? `Right now, for ${name}, ${sNow.replace(/^right now\s+/i, "")}` : cap1(sNow)) : lead(clip(r.verdict.now, 26));
  const later = r.short?.later ?? clip(r.verdict.later, 24), act = r.short?.act ?? (r.first_action ? clip(r.first_action, 22) : "");
  // An asked "is it worth it" / "do I need a degree" gets its direct answer as the verdict (first sentence); the route sentence
  // then yields to it, since the brief carries the route.
  const parts = r.answer ? [`Realistically, ${name && !r.answer.toLowerCase().includes(name.toLowerCase().replace(/^the /, "")) ? `for ${name}, ` : ""}${lowerFirst(r.answer)}`] : [`${now}.`];
  parts.push(`Later, ${lowerFirst(later)}.`);
  if (act) parts.push(`This week: ${lowerFirst(act)}.`);
  if (r.lead && wc(parts.join(" ")) + wc(r.lead) <= 88) parts.splice(parts.length - 1, 0, r.lead);
  const body = parts.join(" ");
  return r.file_url ? `${body} The full plan and honest odds: ${r.file_url}` : body;
}
export interface Enforced { reply: string; action: "kept" | "regenerated" | "fallback"; problems: string[] }
export async function enforceResearchReply(o: { reply: string; result: Ok; message: string; regenerate: (problems: string[]) => Promise<string | null> }): Promise<Enforced> {
  const first = problemsIn(o.reply, o.result, o.message);
  if (!first.length) return { reply: withLink(o.reply, o.result.file_url), action: "kept", problems: [] };
  const again = await o.regenerate(first).catch(() => null);
  if (again) {
    const second = problemsIn(again, o.result, o.message);
    if (!second.length) return { reply: withLink(again, o.result.file_url), action: "regenerated", problems: first };
  }
  return { reply: fallbackVerdict(o.result), action: "fallback", problems: first };
}
