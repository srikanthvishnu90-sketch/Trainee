// One question at a time (coordinator review of #360, 2026-10-31): "what do you need from me" shows the first open
// question; the next is asked in the reply that saves an answer; "skip" moves past one. The flow tests answer through the
// product's own chat with these helpers, matching each question by its words, never by a list number.
type Reply = { reply: string; resultStatus?: string | null };
type Say = (message: string) => Promise<Reply>;

// The question a reply is asking now (after "Next:" when the reply also confirms a save).
export const askedPart = (reply: string) => (reply.includes("\nNext: ") ? reply.slice(reply.lastIndexOf("\nNext: ") + 7) : reply);
// The question's own line (its label, the employer, the hint), never the offer or the help text around it.
export function questionLine(reply: string) {
  const lines = askedPart(reply).split("\n");
  const i = lines.findIndex((l) => /^(?:Next: )?(?:One question|Question 1 of \d+) only you can answer/.test(l));
  return i >= 0 && lines[i + 1] ? lines[i + 1] : askedPart(reply);
}

// architect amendment (D-093, owner 2026-11-16, "All at once"): a batch's open questions come in ONE numbered message
// ("N questions only you can answer are holding up your applications"); one question alone is still asked as before (E3).
export const ALL_AT_ONCE = /\d+ questions only you can answer are holding up your applications/;
// The numbered questions of an all-at-once message: [number, its line].
export function numberedQuestions(reply: string): [number, string][] {
  const part = askedPart(reply);
  if (!ALL_AT_ONCE.test(part)) return [];
  return part.split("\n").map((l) => /^(\d+)\. (.+)$/.exec(l)).filter(Boolean).map((m) => [Number(m![1]), m![2]] as [number, string]);
}
// The turn's status, as the handler gives it; a channel that only shows the words (Telegram) is read from them.
const statusOf = (r: Reply) => r.resultStatus ??
  (r.reply.includes("\nNext: ") ? "answered_next" : /(?:One question|Question 1 of \d+) only you can answer/.test(r.reply) || ALL_AT_ONCE.test(r.reply) ? "shown" : "other");

// Answer each [question words, answer] as its question comes up; any other question shown is skipped (it stays open).
// `use`: the answer is "use 1" (their offered words), else the text itself. Returns every reply, in order.
export async function answerOneByOne(say: Say, answers: [RegExp | string, string][], o: { ask?: string } = {}) {
  const left = [...answers];
  const shown: string[] = [], saved: string[] = [];
  let s = await say(o.ask ?? "what do you need from me");
  if (statusOf(s) !== "shown") throw Error(`no question was shown: ${s.reply}`);
  shown.push(s.reply);
  for (let i = 0; i < 40 && left.length; i++) {
    // D-093: every question shown at once is answered in one message, each by its number; one not in `answers` is left out
    // (it stays open), as "skip" leaves it.
    const many = numberedQuestions(s.reply);
    if (many.length) {
      const said: string[] = [];
      for (const [n, q] of many) {
        const k = left.findIndex(([re]) => typeof re === "string" ? q.includes(re) : re.test(q));
        if (k >= 0) said.push(`${n} ${left.splice(k, 1)[0][1]}`);
      }
      if (!said.length) throw Error(`none of the questions shown is one to answer: ${s.reply}`);
      const r = await say(said.join("\n"));
      saved.push(r.reply);
      if (!left.length) break;
      if (statusOf(r) === "answered_next") { s = r; shown.push(r.reply); continue; }
      s = await say("what do you need from me");
      if (statusOf(s) !== "shown") throw Error(`questions left (${left.map(([re]) => String(re)).join(", ")}) but none shown: ${s.reply}`);
      shown.push(s.reply);
      continue;
    }
    const now = questionLine(s.reply);
    const k = left.findIndex(([re]) => typeof re === "string" ? now.includes(re) : re.test(now));
    if (k < 0) {
      s = await say("skip");
      if (statusOf(s) !== "answered_next") throw Error(`could not move past a question: ${s.reply}`);
      shown.push(s.reply);
      continue;
    }
    const [, value] = left.splice(k, 1)[0];
    const r = await say(value);
    saved.push(r.reply);
    if (!left.length) break;
    if (statusOf(r) === "answered_next") { s = r; shown.push(r.reply); continue; }
    s = await say("what do you need from me");
    if (statusOf(s) !== "shown") throw Error(`questions left (${left.map(([re]) => String(re)).join(", ")}) but none shown: ${s.reply}`);
    shown.push(s.reply);
  }
  if (left.length) throw Error(`never asked: ${left.map(([re]) => String(re)).join(", ")}\n${shown.join("\n---\n")}`);
  return { shown: shown.join("\n"), saved: saved.join("\n") };
}
