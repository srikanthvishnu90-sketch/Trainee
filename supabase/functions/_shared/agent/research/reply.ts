// The reply path for an open career question: the model writes ONE short paragraph; code enforces it. Order:
//   1. strip every URL the model wrote and append the file link ourselves (code inserts the link, only when a file really exists);
//   2. lintChat (length cap, one paragraph, verdict first, no filler or canned opener, correct basics, no unsourced specifics);
//   3. on a failure, ask the model once to rewrite with the exact problems listed;
//   4. still failing: send a plain short verdict built from the brief's own verdict lines, with no link and no claim of a file.
import { lintChat } from "./chat.ts";
import type { ResearchResult } from "./index.ts";

type Ok = Extract<ResearchResult, { status: "ok" }>;
export const stripUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").replace(/[\s:]+$/, "").trim();
const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim();

export function withLink(paragraph: string, url: string | null): string {
  const body = stripUrls(paragraph).replace(/\s*\n+\s*/g, " ");
  if (!url) return body;
  return `${body.replace(/[.:]?$/, ".")} ${url}`;
}
export function problemsIn(paragraph: string, r: Ok, message: string): string[] {
  return lintChat(withLink(paragraph, r.file_url), { link: r.file_url, noLink: !r.file_url, facts: r.facts, person: r.person, message });
}
// Plain, short, true: what is realistic now and later (the brief's verdict lines), nothing about a file.
// The first action and the code-minted file link are added when they exist: a failed lint never costs the person the plan.
export function fallbackVerdict(r: Ok): string {
  const act = r.first_action ? ` This week: ${firstSentence(r.first_action).replace(/[.]+$/, "")}.` : "";
  const body = `${firstSentence(r.verdict.now)} ${firstSentence(r.verdict.later)}${act}`;
  return r.file_url ? `${body} The full plan, timeline and honest odds: ${r.file_url}` : body;
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
