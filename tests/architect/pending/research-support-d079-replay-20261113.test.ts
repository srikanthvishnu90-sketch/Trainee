// Round 9, $0: the 19 verdicts the paid judge measurement (D-079) got wrong, replayed against the code. No model call, no network.
// The recorded data (evals/research-support/d079-replay.ts) is what judge-measure.ts at 2ffb717 sent for each case and the verdict
// the live judge gave. Only code is under test here: what the code now sends (passage, question, which claims reach the judge), and
// that the judge prompt now states each rule the judge got wrong. Whether the live judge now answers those right is for the next
// paid run (owner approval first), not for this file.
import { assert, assertEquals as eq } from "jsr:@std/assert@1";
import { CAUSES, D079_WRONG, ASK_OF } from "../../../evals/research-support/d079-replay.ts";
import { decide, echoes, findSupport, indexPages, quoteClaim, SUPPORT_JUDGE_SYSTEM, supportJudgePayload, type SupportJudge } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { abbreviated } from "../../../supabase/functions/_shared/agent/research/market.ts";

const PAY_Q = "what does citadel pay interns";
const now = (r: (typeof D079_WRONG)[number]) => {
  const idx = indexPages([{ text: r.page, title: r.title }], abbreviated, ["Citadel"], { ask: ASK_OF(r.claim) });
  const f = findSupport(r.claim, idx, [0]);
  return { idx, f, sent: f ? { claim: echoes(r.claim, f.sentence) ? quoteClaim(f.sentence, idx, f.unit.lent) : r.claim, source: f.unit.passage } : null };
};
const of = (cause: string) => D079_WRONG.filter((r) => r.cause === cause);

Deno.test("D-079 replay: the recorded data is the 19 wrong verdicts (14 true refused, 5 false passed), each with a cause", () => {
  eq(D079_WRONG.length, 19);
  eq(D079_WRONG.filter((r) => r.want === "yes" && r.live === "no").length, 14);
  eq(D079_WRONG.filter((r) => r.want === "no" && r.live === "yes").length, 5);
  for (const r of D079_WRONG) assert(r.cause in CAUSES, r.key);
  const n = (c: string) => of(c).length;
  console.log(`D-079 wrong verdicts by cause: ${Object.keys(CAUSES).map((c) => `${c} ${n(c)}`).join(", ")}`);
  eq([n("harness"), n("prompt"), n("judge"), n("passage"), n("label"), n("layerA")], [6, 7, 2, 1, 2, 1]);
});

Deno.test("D-079 replay, harness: a fact that is not about pay is no longer asked whether it answers the pay question", () => {
  for (const r of of("harness")) {
    assert(r.sentClaim.includes(PAY_Q), `recorded: ${r.key}`);
    const { sent } = now(r);
    assert(sent, r.key);
    assert(!sent.claim.includes(PAY_Q), `now: ${r.key}: ${sent.claim}`);
    eq(sent.source, r.sentPassage, r.key); // the passage itself was right
  }
  // A pay fact is still asked under the pay question.
  eq(ASK_OF("Citadel interns earn $5,000 a week."), PAY_Q);
});

Deno.test("D-079 replay, passage: the cut half of a ';' sentence now travels with the marked unit", () => {
  const [r] = of("passage");
  assert(!r.sentPassage.includes("Its whole sentence"), r.sentPassage);
  const { sent } = now(r);
  assert(sent, r.key);
  assert(sent.source.includes("Its whole sentence: Citadel interns are paid $5,000/week; housing is provided."), sent.source);
});

Deno.test("D-079 replay, layer A: a figure written with another noun no longer reaches the judge", () => {
  const [r] = of("layerA");
  eq(r.live, "yes");
  eq(now(r).f, null, r.key);
});

Deno.test("D-079 replay, table rows: the row's header travels with the cell (it did; the case label was the error)", () => {
  for (const r of of("label")) {
    const { sent } = now(r);
    assert(sent, r.key);
    assert(/Table header: (?:Role \| Monthly stipend|Company \| Offer rate)/.test(sent.source), sent.source);
  }
});

Deno.test("D-079 replay, prompt and judge: the prompt now states each rule the judge got wrong, and every request carries it", () => {
  const sys = SUPPORT_JUDGE_SYSTEM;
  const rules: [string, RegExp][] = [
    ["G18 never missed = always paid", /has never missed a bonus payment\\?"? states \\?"?has always paid/],
    ["G13 Not only … also", /Not only do X earn Y, they also get Z\\?"? states both/],
    ["G12 an unrelated clause may be left out", /no cap on overtime/],
    ["N17 double negation", /double negation states the positive/i],
    ["twice: a figure belongs to its own verb and group", /raised pay 10% for interns and cut pay 10% for contractors/],
    ["G15/G09 a limit inside a statement is still a statement", /except Dublin.*between \$4,000 and \$6,000|between \$4,000 and \$6,000.*except Dublin/s],
    ["G17 the whole sentence", /Its whole sentence/],
    ["G27 a reported denial", /reports a denial states the denial/],
    ["table header", /table row is read with its table header/i],
  ];
  for (const [what, re] of rules) assert(re.test(sys), what);
  const p = supportJudgePayload([{ claim: "x", source: "y" }]);
  assert(JSON.stringify(p).includes("double negation"), "the payload carries the system prompt");
});

// End to end with a scripted judge: the recorded live verdict where the code still sends exactly what D-079 sent; a correct verdict
// (the hand label) where it now sends something the live judge never saw. So "fixed" below means "the code changed what is asked",
// and every one of those needs the next live run to confirm.
Deno.test("D-079 replay end to end: what the person would now see, per case", async () => {
  const rows: string[] = [];
  let leak = 0, lost = 0, unseen = 0;
  const lostIds: string[] = [];
  for (const r of D079_WRONG) {
    const { idx, sent } = now(r);
    const judge: SupportJudge = async (cs) => cs.map((c) => {
      const recorded = c.claim === r.sentClaim && c.source === r.sentPassage;
      if (!recorded) unseen++;
      return recorded ? r.live : r.want;
    });
    const [v] = await decide([{ claim: r.claim }], idx, judge);
    const shown = v.how;
    if (r.want === "no" && shown === "model") leak++;
    if (r.want === "yes" && shown === "drop") { lost++; lostIds.push(r.key.split(": ")[1].split(" ")[0]); }
    rows.push(`${r.key.slice(0, 60)} [${r.cause}] sent ${sent ? (sent.claim === r.sentClaim && sent.source === r.sentPassage ? "same" : "changed") : "stopped by code"} -> ${shown}`);
  }
  console.log(rows.join("\n"));
  console.log(`D-079 replay: false in the model's words ${leak} of 5; true dropped ${lost} of 14; claims the live judge never saw ${unseen}`);
  // The 5 false: the relocation bonus is now stopped by code; the two table rows are true of their page (label error); the double
  // negation and the "twice" figure still depend on the judge (prompt rules added; unconfirmed until a live run).
  eq(leak, 4);
  // Three true cases are still dropped. G09, G15 and G27: code sends what D-079 sent and the live judge said no; the prompt now
  // states the rule it missed, unconfirmed until a live run. (Round 10: "Applications close on January 15, 2027." is lent again by
  // its page title "Citadel careers", so it is quoted.) The other eleven now reach the person: as the page's quote (a refused
  // model-worded claim falls back to the page's own sentence) or, for the ';' sentence, in the model's words.
  eq(lostIds, ["G09", "G15", "G27"]);
});

// Layer A's 21 true stops in D-079 (true 28: 2, true 40: 17, split 12: 2). Round 9 frees 14: a "-ly" or "per" period read on
// either side of a figure, "over"/"more than" and "roughly"/"about" read alike, leading function words ("According", "The", "At",
// "Returning", "New") not read as names or owners, "H-1B" not read as a figure, a year that ends a full date not a year of the
// claim, and the year bug on "2025,". Seven stay stopped, each by design: G14 drops the page's "no fewer than"; two units do not
// name Citadel and their page is not on its domain (no lending, round 9); "employees" is not "people" and "internship applications"
// is not "Citadel internship" (another noun, for the judge only if code is sure); the two split pages are hostile.
import { CASES, TRUE_40 } from "../../../evals/research-support/cases.ts";
Deno.test("D-079 replay, layer A: the true claims it stopped for its own reading errors now reach the judge", () => {
  const passes = (title: string, page: string, claim: string) => !!findSupport(claim, indexPages([{ text: page, title }], abbreviated, ["Citadel"], { ask: "x" }), [0]);
  const freed = ["Full-time hires at Citadel get H-1B sponsorship.", "The Citadel internship runs from June 2 to August 15, 2027.", "Citadel reportedly raised intern pay to $5,000 a week in 2025.", "The Citadel Software Engineer Intern role pays $5,000 a week.", "The pay range is $4,000 to $5,000 a week.", "Citadel pays between $4,000 and $5,000 a week.", "Roughly 70% of Citadel interns get a full-time offer.", "New grad engineers at Citadel get a $200k base salary per year.", "Citadel interns work on real trading systems from day one.", "Returning interns get a $10,000 signing bonus.", "Citadel pays interns $125 an hour."];
  for (const claim of freed) { const rows = TRUE_40.filter((t) => t[2] === claim); assert(rows.length, claim); for (const [title, page] of rows) assert(passes(title, page, claim), claim); }
  const g19 = CASES.find((c) => c.id.startsWith("G19"))!;
  assert(passes(g19.title ?? "Citadel compensation notes", g19.page, g19.claim), "G19");
  // (Round 10: "Citadel interns get $5,000 a week plus a housing stipend." is lent again by its page title, so it reaches the judge.)
  const stays = ["Citadel has over 3,000 employees in 17 offices."];
  for (const claim of stays) for (const [title, page] of TRUE_40.filter((t) => t[2] === claim)) assert(!passes(title, page, claim), claim);
  const g14 = CASES.find((c) => c.id.startsWith("G14"))!;
  assert(!passes(g14.title ?? "Citadel compensation notes", g14.page, g14.claim), "G14");
});
