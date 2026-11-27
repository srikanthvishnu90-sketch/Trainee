// MIRROR scorer, answers-first is given the ask (architect, 2026-11-13). reply_rubric.ts answersFirst reads RubricInput.ask (a
// required input: "the first sentence takes up the ask or gives a result"); every other caller gives it (the product's process
// check, evals/mirror/score.ts, the held-out G2, the tone gate). score-conversation.ts wa-1/d066 called it without the ask, so a
// reply that took up the ask in the person's own words could only pass by a result word, a digit or a name. On live-9 that
// failed C16 ("Your tracker is set up." to "yea set up that application tracker"), C20 and C21.
// This pins: the ask reaches the rule on BOTH sides (Trainee's reply and Instinct's), a non-answer still fails, the scorer's
// version changed so the old score files are not compared like for like, and the committed re-score of live-9's recorded text is
// what the scorer gives (and the original score file is untouched).
//   deno test -A --no-check tests/architect/mirror-scorer-ask-20261113.test.ts
import assertNode from "node:assert/strict";
import { comparable, SCORER_VERSION, scoreConversation, scoreTurn } from "../../evals/mirror/score-conversation.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url).pathname;
const jsonl = (p: string) => Deno.readTextFileSync(p).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const turn = (reply: string) => ({ id: "T", reply, route: "model", status: 200, trace: { offered: ["x"] } });
const J = { T: { correct: true, usable: true, honest: true, why: "judged" } };

Deno.test("the ask reaches answers-first: a first sentence that takes up the ask passes", () => {
  const ask = "yea set up that application tracker";
  const instinct = ["Your tracker is ready, with past applications separated from researched roles."];
  const r = scoreTurn(turn("Your tracker is set up. It holds your applications."), instinct, { id: "T", prompt: ask }, J);
  eq(r.answers_first, true, "live-9 C16's opening answers the ask");
  // The same reply to an ask it shares no content word with still fails: the pass comes from the ask, not from a looser rule.
  const other = scoreTurn(turn("Your tracker is set up. It holds your applications."), instinct, { id: "T", prompt: "which city pays more" }, J);
  eq(other.answers_first, false, "the ask is what is read");
});

Deno.test("a preamble or a sentence that takes up nothing still fails answers-first, with the ask given", () => {
  const ask = "yea set up that application tracker";
  const instinct = ["Your tracker is ready, with past applications separated from researched roles."];
  for (const reply of ["Let me check on that tracker for you. One moment.", "Great question! Your tracker is set up.", "On it, setting up the tracker.", "That would be lovely to have. More soon."]) {
    const r = scoreTurn(turn(reply), instinct, { id: "T", prompt: ask }, J);
    eq([r.answers_first, r.pass], [false, false], reply);
  }
});

Deno.test("Instinct's reply is read against the same ask: the mirror allowance holds only when Instinct really fails the rule", () => {
  const ask = "uhh probably when one of my first agency clients didn't like the site";
  const bare = "That's a plot summary, not an answer. Say what went wrong.";
  // Instinct takes up the person's words, so it passes; a bare verdict from Trainee then fails (live-9 C21f, D-072 RC4).
  eq(scoreTurn(turn(bare), ["Right now that's a plot summary: the clients didn't like it."], { id: "T", prompt: ask }, J).answers_first, false);
  // Instinct's own reply fails the rule too: the mirror is the bar, the turn is not failed for it.
  eq(scoreTurn(turn(bare), ["That would be lovely to hear more of."], { id: "T", prompt: ask }, J).answers_first, true);
});

Deno.test("the scorer's version changed, so a wa-1/d066 score file is not compared like for like", () => {
  ok(SCORER_VERSION !== "wa-1/d066", SCORER_VERSION);
  const old = JSON.parse(Deno.readTextFileSync(DIR + "results/live-9/score-live-9.json")).summary;
  eq(old.scorer, "wa-1/d066", "the committed live-9 score is the original scorer's");
  eq([old.pass, old.answers_first], [4, 20], "and is not overwritten");
  ok(/different scorers/.test(comparable(old, { scorer: SCORER_VERSION, scored_ids: old.scored_ids }) ?? ""));
});

Deno.test("the committed re-score of live-9's recorded text is what the scorer gives; only answers-first moved", () => {
  const R = DIR + "results/live-9/";
  const now = scoreConversation({ instinct: jsonl(DIR + "instinct.jsonl"), trainee: jsonl(R + "trainee-live-9.jsonl"), prompts: jsonl(DIR + "prompts.jsonl"), judged: JSON.parse(Deno.readTextFileSync(R + "judged-live-9.json")) });
  const kept = JSON.parse(Deno.readTextFileSync(R + "rescore-live-9-recorded-text-scorer-wa-1-d066-ask.json"));
  eq(JSON.parse(JSON.stringify({ summary: now.summary, gaps: now.gaps, rows: now.rows })), kept);
  const old = JSON.parse(Deno.readTextFileSync(R + "score-live-9.json"));
  eq(kept.gaps, old.gaps, "the same coverage");
  const moved: Record<string, unknown> = {};
  kept.rows.forEach((row: any, k: number) => {
    const was = old.rows[k];
    for (const key of Object.keys(row)) if (key !== "answers_first" && key !== "pass") eq(row[key], was[key], `${row.id}.${key}`);
    if (row.answers_first !== was.answers_first || row.pass !== was.pass) moved[row.id] = [was.answers_first, row.answers_first, was.pass, row.pass];
  });
  // [answers_first before, after, pass before, after]. C21f gets worse and is reported, not hidden.
  eq(moved, { C16: [false, true, false, true], C20: [false, true, false, false], C21: [false, true, false, true], C21f: [true, false, true, false] });
  eq([kept.summary.pass, kept.summary.answers_first, kept.summary.scored], [5, 22, 23]);
});
