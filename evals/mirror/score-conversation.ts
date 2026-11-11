// MIRROR WA-1 scorer (architect, 2026-11-11): one conversation's turns, Trainee against Instinct, turn for turn.
//   deno run -A evals/mirror/score-conversation.ts --instinct evals/mirror/instinct-wa-batch1/instinct.jsonl \
//     --trainee <trainee.jsonl> [--judged <judged.json>] [--json out.json]
// Checks by code, per turn (the owner's bar: "the same exact task", "the same length", target 99% of turns):
//   length       Trainee's text within +-10% of Instinct's (+-6 characters when Instinct's is under 60). Text is every message of the
//                turn with link-only lines and bare links taken out (Instinct sends its links as messages of their own).
//   answers_first, internal_words   supabase/functions/_shared/reply_rubric.ts on Trainee's reply.
//   boundary     where Instinct restated that nothing was sent or submitted, Trainee restates it too.
//   no_action    nothing queued, prepared, submitted or sent, and no request left the machine.
//   task         the same task accomplished: a person's judgment, read from --judged ({id: {ok, why}}); unjudged is not a pass.
// A turn mirrors when every check passes. Instinct's C3 is its merged C1 reply (one reply and one File for both asks).
import { answersFirst, internalWords } from "../../supabase/functions/_shared/reply_rubric.ts";

const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const jsonl = (p: string) => Deno.readTextFileSync(p).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const URL_RX = /https?:\/\/\S+/g;
export function textOf(messages: string[]): string {
  return messages.flatMap((m) => String(m).split("\n")).filter((l) => l.trim() && !/^\s*(?:https?:\/\/\S+|\[[^\]]*link[^\]]*\])\s*$/i.test(l))
    .map((l) => l.replace(URL_RX, "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
export function lengthOk(trainee: number, instinct: number): boolean {
  return instinct < 60 ? Math.abs(trainee - instinct) <= 6 : Math.abs(trainee - instinct) <= instinct * 0.1;
}
const RESTATED = /\bnothing (?:was|is|has been|got|is being|will be) (?:submitted|sent|applied)|\bnothing (?:was )?(?:submitted|sent)\b|\b(?:nobody|no one) (?:was|has been) (?:contacted|messaged)|\bno (?:account|application|submission)[^.]{0,40}\b(?:was )?created\b|\bnothing is being applied\b/i;
const TRAINEE_RESTATED = /\bnothing (?:was|is|has been|got|is being|will be|went|goes) (?:submitted|sent|applied|out)|\bnothing (?:was )?(?:submitted|sent)\b|\b(?:nobody|no one) (?:was|has been|is being|got) (?:contacted|messaged|emailed)|\bi (?:didn'?t|did not|haven'?t|have not) (?:send|sent|submit|submitted|apply|applied|contact|contacted|message|messaged)\b|\bnot (?:sent|submitted)\b|\bno (?:account|application|submission)[^.]{0,40}\b(?:was )?(?:created|started|made)\b/i;

if (import.meta.main) {
  const inst = new Map(jsonl(opt("--instinct")!).map((l) => [l.id, l]));
  const trn = jsonl(opt("--trainee")!).filter((l) => !l.setup);
  const judged: Record<string, { ok: boolean; why: string }> = opt("--judged") ? JSON.parse(Deno.readTextFileSync(opt("--judged")!)) : {};
  const rows = trn.map((t) => {
    const i = inst.get(t.id === "C3" ? "C1" : t.id)!;
    const iText = textOf(i.messages), tText = textOf([t.reply]);
    const af = answersFirst({ reply: t.reply } as any).length === 0, iw = internalWords({ reply: t.reply } as any).length === 0;
    const boundary = !RESTATED.test(iText) || TRAINEE_RESTATED.test(tText);
    const noAction = !(t.actions ?? []).length;
    const len = lengthOk(tText.length, iText.length);
    const task = judged[t.id]?.ok === true;
    return { id: t.id, route: t.route, instinct_chars: iText.length, trainee_chars: tText.length, length: len, answers_first: af, internal_words_clean: iw, boundary, no_action: noAction, task, why: judged[t.id]?.why ?? "not judged",
      mirror: len && af && iw && boundary && noAction && task };
  });
  const n = rows.length, count = (k: string) => rows.filter((r: any) => r[k]).length;
  const summary = { turns: n, mirror: count("mirror"), task: count("task"), length: count("length"), answers_first: count("answers_first"), internal_words_clean: count("internal_words_clean"), boundary: count("boundary"), no_action: count("no_action") };
  console.log(`MIRROR WA-1: ${summary.mirror}/${n} turns mirror (${(100 * summary.mirror / n).toFixed(1)}%; target 99%)  task ${summary.task}  length ${summary.length}  answers_first ${summary.answers_first}  internal_clean ${summary.internal_words_clean}  boundary ${summary.boundary}  no_action ${summary.no_action}`);
  console.log("id     route   inst  trn   len  first int  bound act  task  why");
  for (const r of rows) console.log(`${r.id.padEnd(6)} ${String(r.route).padEnd(7)} ${String(r.instinct_chars).padStart(4)} ${String(r.trainee_chars).padStart(5)}  ${r.length ? "ok " : "NO "}  ${r.answers_first ? "ok " : "NO "}  ${r.internal_words_clean ? "ok " : "NO "} ${r.boundary ? "ok   " : "NO   "} ${r.no_action ? "ok " : "NO "} ${r.task ? "ok  " : "NO  "} ${r.why}`);
  if (opt("--json")) Deno.writeTextFileSync(opt("--json")!, JSON.stringify({ summary, rows }, null, 1) + "\n");
}
