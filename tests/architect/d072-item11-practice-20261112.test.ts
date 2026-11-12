// D-072 (architect, 2026-11-12): item 11, interview practice. The held-out practice sample on the real model (CI run 43193882444,
// trunk 44b436f9, `live.ts --sample 6 --family practice --seed 7`, $1.4640) scored G12 24/24, G2 19/24, G3 5/24. Its per-turn file is
// sealed (P2) and was not read; the causes are found in code and replayed here on the DEV split only (dev.jsonl's practice
// conversations HO-0842, HO-0858, HO-0859) and on batch 1's own practice turns (C5, C5f1, C5f2, C21, C21f), with a scripted model
// returning the shapes live-7 and live-8 recorded (evals/mirror/instinct-wa-batch1/results/live-7, live-8). Root causes:
// docs/architect/reports/ITEM11-ROOT-CAUSES-20261112.md. No network, no spend, nothing sent.
//   D72-1  KIND (G3): inside a practice session an answer is reviewed at the review length (a three-step approach had read as
//          "everything", 900 to 1,200 characters), a closing "thoughts?" does not make the answer a new ask, an ask for the next
//          question said any way is the question kind, and a new ask is still a new ask.
//   D72-2  G2 + G3, C5f1 (live-8, 873 characters, "Short answer: that's a different problem ..."): the review is asked once to open with
//          the verdict on what they said, and complexity notation no longer stops the length pass ("carries code").
//   D72-3  G3, C5f2 (live-8, 791 characters, their code pasted): a practice review is shortened with every code token kept verbatim;
//          a shorter text that drops one is refused; a code block is never shortened; a non-practice turn with code keeps D-067.
//   D72-4  G2, C21f (live-7, "That's a plot summary, not an interview answer."): the roast review gets the same check; a verdict
//          that names their answer (D-070's own example) is not asked again.
//   D72-5  G3 on dev turns through the real handler path (agentTurn): HO-0842.t2's note is the review length, HO-0858.t4's (Q-harder)
//          is the question length, and a 420-character question with an "O(n)" hint is shortened.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d072-item11-practice-20261112.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { agentTurn, carriesCode, codeKept, processCheck, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { overLimit, practiceAnswerOf, practiceAskIn, practiceNextOf, REPLY_LENGTH, replyKind, replyLength, roastOf, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { answersFirst } from "../../supabase/functions/_shared/reply_rubric.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (u: URL) => Deno.readTextFileSync(u).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read(new URL("prompts.jsonl", DIR)).map((t: any) => [t.id, t.prompt]));
const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const LIVE7: Record<string, any> = Object.fromEntries(read(new URL("results/live-7/trainee-live-7.jsonl", DIR)).map((t: any) => [t.id, t]));
const LIVE8: Record<string, any> = Object.fromEntries(read(new URL("results/live-8/trainee-live-8.jsonl", DIR)).map((t: any) => [t.id, t]));
// The DEV split only (P2: the held-out split is sealed and never tuned on).
const DEV: Record<string, any> = Object.fromEntries(read(new URL("../../evals/mirror/heldout/dev.jsonl", import.meta.url)).map((c: any) => [c.id, c]));
const devTurn = (id: string) => { const c = DEV[id.split(".")[0]]; ok(c && c.split === "dev", `${id} is a dev conversation`); return c.turns.find((t: any) => t.id === id); };
const NOW = Date.parse("2026-11-12T03:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
type Payload = { system: string; messages: any[]; tools: any[] };
function scripted(brain: (p: Payload, n: number) => any, plain: (p: Payload) => string = () => "") {
  const seen: Payload[] = [];
  let n = 0;
  const model = async (p: any) => { seen.push(p); return p.tools?.length ? brain(p, n++) : text(plain(p)); };
  return { model, seen };
}
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
const turn = (message: string, history: { role: string; content: string }[], model: any) =>
  agentTurn({ message, history, stores: { profile: personaProfile() }, userId: "u-d072", threadId: "th-d072", now: NOW, model } as any) as Promise<any>;
// A faithful stand-in for the shortener (it only deletes): whole sentences that carry no figure, link, code or question are
// dropped from the end until the text is within the bound (a boundary or caveat line stays too). The first sentence (the verdict)
// always stays.
function faithful(long: string, bound: number): string {
  const ss = long.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const must = (x: string, k: number) => k === 0 || /\d|https?:\/\/|`|\w[([]|\w_\w|\?$|\bnothing (?:was|is) (?:sent|submitted)\b|\bnot (?:verified|confirmed)\b/i.test(x);
  const keep = ss.map((x, k) => ({ x, m: must(x, k) }));
  for (let k = keep.length - 1; k >= 0 && textLength(keep.map((y) => y.x).join(" ")) > bound; k--) if (!keep[k].m) keep.splice(k, 1);
  return keep.map((y) => y.x).join(" ");
}
// D-066's far bound for the held-out kinds (expect.ts: practice_question 300, practice_review 500; far = more than 25% over).
const FAR = { question: Math.round(300 * 1.25), review: Math.round(500 * 1.25) };
const g2 = (ask: string, reply: string) => !answersFirst({ ask, reply } as any).length;

// ---------------------------------------------------------------- D72-1 kind
Deno.test("D72-1 KIND (G3): in a practice session an answer is a review, a check-in does not make it a new ask, and 'next' is a question", () => {
  const ask842 = devTurn("HO-0842.t1").prompt, appr842 = devTurn("HO-0842.t2").prompt;
  const h842 = [{ role: "user", content: ask842 }, { role: "assistant", content: "Your question: a launch with a fixed budget. Walk me through your plan first." }];
  // Before: the three-step approach ("the audience, the goal, then channels and a budget split, then how we measure") read as an
  // "everything" ask (900 to 1,200 characters, bound 1,320); the review was told to run that long.
  eq(replyKind(appr842), "everything");
  eq(replyLength(appr842, h842).kind, "answer");
  eq(overLimit(replyLength(appr842, h842)), 550);
  // HO-0859.t2 ends "— thoughts?": a check-in on the answer itself. Before, any "?" made it a new ask (no review note).
  const ask859 = devTurn("HO-0859.t1").prompt, appr859 = devTurn("HO-0859.t2").prompt, ans859 = devTurn("HO-0859.t3").prompt;
  ok(/thoughts\?\s*$/.test(appr859));
  const h859 = [{ role: "user", content: ask859 }, { role: "assistant", content: "A 4 m simply supported beam carries 10 kN at midspan. Find the support reactions. Walk me through your approach first." }];
  ok(practiceAnswerOf(appr859, h859), "an answer with a closing check-in");
  // The answer after the review: the review ended on an instruction to answer, not a "?".
  const h859b = [...h859, { role: "user", content: appr859 }, { role: "assistant", content: "Right method: a free body diagram, then the sums of forces and moments. Now solve it." }];
  ok(practiceAnswerOf(ans859, h859b), "the answer the review asked for");
  eq(replyLength(ans859, h859b).kind, "answer");
  // HO-0858.t3 is their code (a "?" inside code is code, not a new ask); HO-0858.t4 / HO-0859.t4 ask for the next question.
  const ask858 = devTurn("HO-0858.t1").prompt, appr858 = devTurn("HO-0858.t2").prompt, code858 = devTurn("HO-0858.t3").prompt, next858 = devTurn("HO-0858.t4").prompt;
  const h858 = [{ role: "user", content: ask858 }, { role: "assistant", content: "Return the first element that appears once. Your approach first?" },
    { role: "user", content: appr858 }, { role: "assistant", content: "Your Map count, then a second loop, is right. Write it?" }];
  ok(practiceAnswerOf(code858, h858), "their code");
  ok(practiceAnswerOf("const f = (a) => a.length ? a[0] : null; // ok?", h858), "a ternary's '?' is code");
  ok(!practiceNextOf(appr858, h858.slice(0, 2)), "'then loop again' in an answer is not a next ask");
  const h858c = [...h858, { role: "user", content: code858 }, { role: "assistant", content: "Your filter returns every unique value, not the first. What would you return instead?" }];
  for (const [m, h] of [[next858, h858c], [devTurn("HO-0859.t4").prompt, [...h859b, { role: "user", content: ans859 }, { role: "assistant", content: "Right: 5 kN each. Next?" }]]] as const) {
    ok(practiceNextOf(m, h as any) && practiceAskIn(m, h as any), m);
    eq(replyKind(m, h as any), "question", m);
    ok(!practiceAnswerOf(m, h as any), `${m}: a next ask is not an answer`);
  }
  for (const m of ["ok next", "another one, harder", "can you give me a tougher one"]) eq(replyKind(m, h858c), "question", m);
  ok(!practiceNextOf("find me another internship in chicago", [{ role: "user", content: "find me internships" }]), "outside a session 'another' is not a practice ask");
  // A new ask inside a session is still a new ask (D-070's own control).
  ok(!practiceAnswerOf("have i applied to anything yet?", h858), "a new question");
  // Batch 1: C5f1 and C21f are reviews at the review length; without the conversation the kinds are as before (the WA scorer's view).
  eq(replyLength(P.C5f1, [{ role: "user", content: P.C5 }, { role: "assistant", content: LIVE8.C5.reply }]).kind, "answer");
  ok(roastOf(P.C21f, [{ role: "user", content: P.C21 }, { role: "assistant", content: LIVE8.C21.reply }]));
  eq(replyLength(P.C21f, [{ role: "user", content: P.C21 }, { role: "assistant", content: LIVE8.C21.reply }]).kind, "answer");
  eq([replyLength(P.C5).kind, replyLength(P.C5f1).kind, replyLength(P.C5f2).kind], ["question", "answer", "answer"]);
});

// ---------------------------------------------------------------- D72-2 C5f1
const C5f1_REWRITE = "Your dict-count approach is right for a different problem: it finds the first value that appears exactly once, and I asked for the first value that appears more than once. " +
  "Different question, different answer: on [2, 1, 2, 1], yours returns None, and the correct result is 2. Check that before you code anything. " +
  "Your complexity came through as \"o👎\", so I can't score it as written. Assuming you meant O(n) time and O(n) space, those are right for your approach. " +
  "The honest read is that a two-pass counting approach is fine, but you answered the wrong question, and in a real interview, not restating the problem first is what costs you. " +
  "Restating it out loud before coding is the habit that fixes this. Follow-up, harder: what do you track to solve my actual question in a single pass?";
Deno.test("D72-2 C5f1 (live-8, G2 + G3): the review is asked once to open with its verdict on their approach, and complexity notation does not stop the length pass", async () => {
  const live = LIVE8.C5f1;
  // What live-8 recorded: 873 characters (the far bound is 625), skipped as "carries code" (only "O(n)" in the reply), and a first
  // sentence that is a verdict on nothing they said.
  eq([textLength(live.reply) > FAR.review, live.trace.shorten.why, carriesCode(live.reply), carriesCode(P.C5f1)], [true, "carries code", true, false]);
  ok(!g2(P.C5f1, live.reply), "live-8's first sentence fails answers-first");
  ok(g2(P.C5f1, C5f1_REWRITE), "the rewrite's first sentence names their approach");
  const history = [{ role: "user", content: P.C5 }, { role: "assistant", content: LIVE8.C5.reply }];
  const bound = overLimit(replyLength(P.C5f1, history));
  eq(bound, 550);
  const s = scripted((_p, n) => text(n === 0 ? live.reply : C5f1_REWRITE), (q) => faithful(String(q.messages[0].content[0].text), bound));
  const r = await turn(P.C5f1, history, s.model);
  const asked = s.seen.filter((p) => /It gives a verdict without saying what it is a verdict on/.test(p.system));
  eq(asked.length, 1, "the review check ran once");
  ok(asked[0].system.includes("Short answer: that's a different problem"), "it quotes the opening it asks to change");
  ok(/FIRST sentence is your verdict/.test(s.seen[0].system), "D-070's review note is on the turn");
  ok(r.shorten.ran && r.shorten.why !== "carries code", JSON.stringify(r.shorten));
  eq(r.shorten.outcome, "accepted", JSON.stringify(r.shorten));
  ok(textLength(r.reply) <= bound && textLength(r.reply) <= FAR.review, `${textLength(r.reply)}`);
  ok(g2(P.C5f1, r.reply), r.reply);
  for (const keep of ["[2, 1, 2, 1]", "O(n) time and O(n) space", "None"]) ok(r.reply.includes(keep), keep);
  eq((r.reply.match(/\?/g) ?? []).length, 1);
  eq(r.tool_calls ?? [], [], "nothing called, nothing sent");
});

// ---------------------------------------------------------------- D72-3 C5f2
const C5f2_REWRITE = "Your first_unique function is still the wrong problem, and the code has two flaws of its own. " +
  "First, first_unique answers \"first value appearing exactly once.\" I asked for the first value that appears more than once. On [2, 1, 2, 1] yours raises an error, and the right answer is 2. " +
  "Second, `next(...)` with no default raises StopIteration when nothing is unique, but the spec said to return None. Third, using a list comprehension just for its side effects is a style red flag; use a plain for loop. " +
  "You also skipped the single-pass follow-up I asked for. The fix is a set: scan once, return n if n is already in seen, otherwise add it. That's O(n) time and O(n) space, and it returns at the first repeat. " +
  "Rewrite it that way and tell me what changes if memory is tight?";
Deno.test("D72-3 C5f2 (live-8, G3): a practice code review is shortened with every code token kept verbatim; a code block and non-practice code keep D-067's rule", async () => {
  const live = LIVE8.C5f2;
  eq([textLength(live.reply) > FAR.review, live.trace.shorten.why, carriesCode(P.C5f2)], [true, "carries code", true]);
  ok(!g2(P.C5f2, live.reply) && g2(P.C5f2, C5f2_REWRITE));
  const history = [{ role: "user", content: P.C5 }, { role: "assistant", content: LIVE8.C5.reply }, { role: "user", content: P.C5f1 }, { role: "assistant", content: LIVE8.C5f1.reply }];
  ok(practiceAnswerOf(P.C5f2, history), "their code answers the follow-up");
  const bound = overLimit(replyLength(P.C5f2, history));
  const s = scripted((_p, n) => text(n === 0 ? live.reply : C5f2_REWRITE), (q) => faithful(String(q.messages[0].content[0].text), bound));
  const r = await turn(P.C5f2, history, s.model);
  eq(s.seen.filter((p) => /It gives a verdict without saying/.test(p.system)).length, 1);
  ok(r.shorten.ran && ["accepted", "shorter"].includes(r.shorten.outcome), JSON.stringify(r.shorten));
  ok(textLength(r.reply) <= FAR.review, `${textLength(r.reply)}`);
  for (const keep of ["`next(...)`", "first_unique", "[2, 1, 2, 1]", "O(n)"]) ok(r.reply.includes(keep), keep);
  ok(g2(P.C5f2, r.reply), r.reply);
  // A shorter text that drops or changes code is refused: the long review stands.
  ok(codeKept(C5f2_REWRITE, faithful(C5f2_REWRITE, bound)));
  const changed = faithful(C5f2_REWRITE, bound).replace("`next(...)`", "the next call");
  ok(!codeKept(C5f2_REWRITE, changed) && shortenedOk(C5f2_REWRITE, changed, Number.POSITIVE_INFINITY), "only the code guard refuses it");
  const s2 = scripted((_p, n) => text(n === 0 ? live.reply : C5f2_REWRITE), () => changed);
  const r2 = await turn(P.C5f2, history, s2.model);
  eq(r2.shorten.outcome, "rejected");
  ok(r2.reply.includes("`next(...)`"), "the review keeps its code");
  // A review that shows a code block is never shortened.
  const block = C5f2_REWRITE.replace("The fix is a set:", "The fix is a set:\n```\nseen = set()\nfor n in nums:\n    if n in seen: return n\n    seen.add(n)\nreturn None\n```\n");
  const s3 = scripted(() => text(block), () => "short");
  const r3 = await turn(P.C5f2, history, s3.model);
  eq([r3.shorten.ran, r3.shorten.why], [false, "a practice reply with a code block"]);
  // Not a practice turn: code in the message keeps D-067's rule (never shortened).
  const long = "This raises because x is None on the first call, so x + 1 fails. ".repeat(10);
  const s4 = scripted(() => text(long), () => "short");
  const r4 = await turn("def f(x): return x + 1  why does this crash", [], s4.model);
  eq([r4.shorten.ran, r4.shorten.why], [false, "carries code"]);
});

// ---------------------------------------------------------------- D72-4 C21f
Deno.test("D72-4 C21f (live-7, G2): a roast review opens with its verdict on their story; a verdict that names their answer is not asked again", async () => {
  const live = LIVE7.C21f.reply;
  ok(!g2(P.C21f, live), "live-7's opening fails answers-first");
  const history = [{ role: "user", content: P.C21 }, { role: "assistant", content: LIVE7.C21.reply }];
  const rewrite = live.replace(/^That's a plot summary, not an interview answer\./, "Your agency-client story is a plot summary, not an interview answer.");
  ok(g2(P.C21f, rewrite));
  const s = scripted((_p, n) => text(n === 0 ? live : rewrite));
  const r = await turn(P.C21f, history, s.model);
  eq(s.seen.filter((p) => /It gives a verdict without saying/.test(p.system)).length, 1);
  ok(/ROAST/.test(s.seen[0].system), "the roast note is on the turn");
  ok(r.reply.startsWith("Your agency-client story is a plot summary"), r.reply);
  ok(textLength(r.reply) <= FAR.review);
  // D-070's verdict-first example names their approach: the check does not fire.
  const check = processCheck({ draftAsk: false, planSearch: false, parts: [], review: P.C5f1 })!;
  eq(check("Partly right: counting works, but it answers a different question.", []), null);
  ok(/verdict without saying/.test(check("Right approach for the wrong problem. Counting finds the first unique value.", []) ?? ""), "live-7 C5f1's opening");
  // No practice answer, no check (a plain question turn is unchanged).
  eq(processCheck({ draftAsk: false, planSearch: false, parts: [], review: null }), null);
});

// ---------------------------------------------------------------- D72-5 dev turns through agentTurn
Deno.test("D72-5 dev practice turns (G3): the review note is the review length and Q-harder's is the question length; a hinted question is shortened", async () => {
  // HO-0842.t2: the review of a three-step approach is told 300 to 500 characters, not "everything".
  const h842 = [{ role: "user", content: devTurn("HO-0842.t1").prompt }, { role: "assistant", content: "Your question: a new snack launch with $20k. Walk me through how you'd plan the campaign." }];
  const s1 = scripted(() => text("Your plan of audience, goal, channels, budget split and measurement is right, and it is in the right order. The fix: tie the budget split to the goal you name first. What would you measure in week one?"));
  const r1 = await turn(devTurn("HO-0842.t2").prompt, h842, s1.model);
  ok(s1.seen[0].system.includes(REPLY_LENGTH.answer.aim) && !s1.seen[0].system.includes(REPLY_LENGTH.everything.aim), "the review length");
  eq(r1.shorten.why, "within the bound");
  // HO-0858.t4 (Q-harder): the question length, and a 420-character question with an O(n) hint is shortened, not skipped as code.
  const t = (id: string) => devTurn(id).prompt;
  const h858 = [{ role: "user", content: t("HO-0858.t1") }, { role: "assistant", content: "Given an array, return the first element that appears exactly once. Your approach first?" },
    { role: "user", content: t("HO-0858.t2") }, { role: "assistant", content: "Your Map count, then a second loop, is right. Write it?" },
    { role: "user", content: t("HO-0858.t3") }, { role: "assistant", content: "Your filter returns every unique value, not the first, and cx is undefined. What would you return instead?" }];
  const q = "Harder one, same topic: given a stream of integers you can read only once, return the first value that appears exactly once at any moment. " +
    "You get add(n) and first() calls. Aim for O(1) per call. Think about what you keep for counts and what keeps the order of the candidates. " +
    "Talk me through the data structures first, then the code. Edge case to cover: every value repeats. What do you keep?";
  ok(textLength(q) > overLimit(REPLY_LENGTH.question) && carriesCode(q), `${textLength(q)}: over 330 and "code" only by its O(1)`);
  const s2 = scripted(() => text(q), (p) => faithful(String(p.messages[0].content[0].text), 330));
  const r2 = await turn(t("HO-0858.t4"), h858, s2.model);
  ok(s2.seen[0].system.includes(REPLY_LENGTH.question.aim), "the question length");
  ok(!/THEY ARE ANSWERING THE PRACTICE QUESTION/.test(s2.seen[0].system), "a next ask gets no review note");
  ok(r2.shorten.ran && r2.shorten.why !== "carries code", JSON.stringify(r2.shorten));
  ok(textLength(r2.reply) <= FAR.question && r2.reply.includes("O(1)"), `${textLength(r2.reply)}: ${r2.reply}`);
});
