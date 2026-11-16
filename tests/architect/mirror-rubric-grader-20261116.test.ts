// MIRROR RUBRIC GRADER (architect, 2026-11-16). The 10/10 rubric for the Instinct WhatsApp benchmark
// (evals/mirror/instinct-wa-batch1/rubric.json) graded by evals/mirror/score-rubric.ts. All at $0: stub judges only.
//   1 the standard   26 scenarios, 281 yes/no elements, MUST/NICE, five groups; every check is a known key with a valid regex;
//                    nothing about a run (no trainee_* fields), fictional names only
//   2 code checks    a tool ran with its inputs and no error, File and posting links, length, date, "not sent", no action,
//                    no unproven claim, documents, a failed check never reaches the judge
//   3 quote rule     a judge's yes stands only when its quote is in what the turn delivered
//   4 the cap        10 x MUST met / MUST total, capped at 8 unless at least half the NICEs are met
//   5 Instinct       its own replies grade deterministically-only without a crash; a failing judge is a no, not a crash
import assertNode from "node:assert/strict";
import { gradeTranscript, gradeTurn, type Judge, quoteFound, RUBRIC_PATH, runCheck, type Rubric, scoreOf, subscriptionJudge, summaryTable, type Turn } from "../../evals/mirror/score-rubric.ts";

const rubric: Rubric = JSON.parse(await Deno.readTextFile(RUBRIC_PATH));
const KEYS = new Set(["tool", "tool_ok", "tool_all", "no_tool", "no_error", "args", "file", "doc", "doc_has", "doc_lacks", "link", "max", "date", "has", "lacks", "not_sent", "no_action", "no_claim", "no_host", "ends_ask", "clean", "judge"]);
const turn = (reply: string, trace: Turn["trace"] = {}, actions: Turn["actions"] = []): Turn => ({ id: "X", reply, trace, actions });

Deno.test("1 the standard: 26 scenarios, 281 elements, known check keys, nothing about a run", async () => {
  assertNode.equal(rubric.scenarios.length, 26);
  const els = rubric.scenarios.flatMap((s) => s.elements);
  assertNode.equal(els.length, 281);
  assertNode.equal(new Set(els.map((e) => e.id)).size, 281);
  for (const e of els) {
    assertNode.ok(["MUST", "NICE"].includes(e.level), e.id);
    assertNode.ok(["acts", "specifics", "depth", "honesty", "form"].includes(e.group), e.id);
    for (const [k, v] of Object.entries(e.check ?? {})) {
      assertNode.ok(KEYS.has(k), `${e.id}: unknown check ${k}`);
      if (["args", "doc", "doc_has", "doc_lacks", "has", "lacks", "no_host"].includes(k)) new RegExp(String(v), "i");
    }
  }
  const raw = await Deno.readTextFile(RUBRIC_PATH);
  assertNode.ok(!/"trainee_/.test(raw), "the standard carries no trainee_* fields");
  assertNode.ok(!/@(?!example\.)[a-z0-9-]+\.[a-z]/i.test(raw), "no email address");
  const ids = new Set((await Deno.readTextFile(new URL("../../evals/mirror/instinct-wa-batch1/prompts.jsonl", import.meta.url))).trim().split("\n").map((l) => JSON.parse(l).id));
  assertNode.deepStrictEqual(new Set(rubric.scenarios.map((s) => s.id)), ids);
});

Deno.test("2 code checks: tools and inputs, links, length, date, boundary, actions, claims, documents", () => {
  const t = turn("PayPal's Software Engineer Intern is open through Sunday, December 6, 2026. Nothing was sent. Want me to prepare it?\nhttps://paypal.wd1.myworkdayjobs.com/x", {
    called: ["search_jobs", "remember_instruction"], call_errors: [{ name: "remember_instruction", error: "missing required input: instruction" }],
    args: [{ name: "search_jobs", args: { query: "software engineer intern summer 2027 Chicago OR remote" } }],
  });
  assertNode.equal(runCheck({ tool: ["search_jobs"], args: "(?=.*intern)(?=.*(?:chicago|remote))" }, t), null);
  assertNode.match(String(runCheck({ tool: ["search_jobs"], args: "new york" }, t)), /no recorded input/);
  assertNode.match(String(runCheck({ tool_ok: ["remember_instruction"] }, t)), /did not run without error/);
  assertNode.match(String(runCheck({ no_error: ["remember_instruction"] }, t)), /missing required input/);
  assertNode.match(String(runCheck({ tool: ["create_file"] }, t)), /none of create_file ran/);
  assertNode.equal(runCheck({ link: true, date: true, not_sent: true, no_action: true, no_claim: true, ends_ask: true, max: 600 }, t), null);
  assertNode.match(String(runCheck({ max: 50 }, t)), /over 50/);
  assertNode.match(String(runCheck({ file: true }, t)), /no File link/);
  // A File link is not a posting link.
  const f = turn("Your plan is in the File.\nhttps://file.example.test?t=abc", { artifact: true, files: [{ link: "https://file.example.test?t=abc", status: 200, text: "Plan" }] });
  assertNode.equal(runCheck({ file: true }, f), null);
  assertNode.match(String(runCheck({ link: true }, f)), /no posting or source link/);
  assertNode.match(String(runCheck({ date: true, not_sent: true }, turn("Here it is."))), /no date/);
  assertNode.match(String(runCheck({ not_sent: true }, turn("Here it is."))), /boundary/);
  assertNode.match(String(runCheck({ no_action: true }, turn("Done.", {}, [{ type: "submit" }]))), /submit/);
  assertNode.equal(runCheck({ no_action: true }, turn("Read only.", {}, [{ type: "external", hosts: ["GET api.lever.co"] }])), null);
  assertNode.match(String(runCheck({ no_host: "linkedin\\." }, turn("x", {}, [{ type: "external", hosts: ["GET www.linkedin.com"] }]))), /linkedin/);
  // Unproven claims: a send that no action records, a live check whose tool failed.
  assertNode.match(String(runCheck({ no_claim: true }, turn("I've sent it to the recruiter."))), /no send or submit recorded/);
  assertNode.equal(runCheck({ no_claim: true }, turn("I haven't sent anything."))!, null);
  const live = turn("Yes, I checked it live just now and it is still open.", { called: ["check_posting_open"], call_errors: [{ name: "check_posting_open", error: "missing required input: url" }] });
  assertNode.match(String(runCheck({ no_claim: true }, live)), /no live check ran without error/);
  assertNode.equal(runCheck({ no_claim: true }, turn(live.reply!, { called: ["check_posting_open"] })), null);
  // Documents: attached and read; what the page holds.
  const d = turn("Your resume is attached.", { documents: [{ filename: "resume.pdf", mime: "application/pdf", status: "read", text: "Sam Rivera GPA: 3.9" }] });
  assertNode.match(String(runCheck({ doc: "pdf", doc_lacks: "3\\.9" }, d)), /contains/);
  assertNode.match(String(runCheck({ doc: "docx" }, d)), /no docx/);
  assertNode.match(String(runCheck({ clean: true }, turn("Found 1 (open-checked) role, job_id 123abc."))) + String(runCheck({ lacks: "open-checked" }, turn("Found 1 (open-checked) role."))), /open-checked/);
});

Deno.test("2b a failed code check is a no without asking the judge; a passed gate goes to the judge", async () => {
  const asked: string[] = [];
  const judge: Judge = async (a) => { asked.push(...a.elements.map((e) => e.id)); return a.elements.map((e) => ({ id: e.id, yes: true, quote: "Draft, not sent" })); };
  const s = rubric.scenarios.find((x) => x.id === "C2")!;
  const r = await gradeTurn(s, { id: "C2", reply: "Hi [Name], could you refer me for [role link]? Thanks, Sam\n\nDraft, not sent.", trace: { called: [] }, actions: [] }, judge);
  const a1 = r.elements.find((e) => e.id === "C2.A1")!;
  assertNode.equal(a1.yes, false); assertNode.equal(a1.by, "code");
  assertNode.ok(!asked.includes("C2.A1") && !asked.includes("C2.H1"), "code-decided elements are never sent to the judge");
  assertNode.ok(asked.includes("C2.S2") && asked.includes("C2.S1"), "a gate that passed, and judge-only elements, are asked");
  assertNode.equal(r.elements.find((e) => e.id === "C2.H1")!.by, "code");
});

Deno.test("3 the quote rule: a yes whose quote is not in the delivered text is a no", async () => {
  const t = turn("Yes — it’s open through December 6.", { files: [{ link: "https://file.example.test?t=1", status: 200, text: "PayPal pay $28-$49 hourly" }] });
  assertNode.ok(quoteFound("it's open through december 6", t), "case, curly quotes and spacing are normalised");
  assertNode.ok(quoteFound("pay $28-$49 hourly", t), "the File's text counts as delivered");
  assertNode.ok(!quoteFound("open through December 9", t));
  assertNode.ok(!quoteFound("", t) && !quoteFound("Yes", t), "an empty or too-short quote is no evidence");
  const s = rubric.scenarios.find((x) => x.id === "C21")!;
  const reply = '"Tell me about a time you failed." Say what it cost and what you changed. Answer it the way you would in the room.';
  const honest: Judge = async (a) => a.elements.map((e) => ({ id: e.id, yes: true, quote: e.id === "C21.S1" ? "Tell me about a time you failed." : "I will invent a quote here" }));
  const r = await gradeTurn(s, { id: "C21", reply, trace: {}, actions: [] }, honest);
  const s1 = r.elements.find((e) => e.id === "C21.S1")!, d1 = r.elements.find((e) => e.id === "C21.D1")!;
  assertNode.equal(s1.yes, true); assertNode.match(s1.evidence, /Tell me about a time/);
  assertNode.equal(d1.yes, false); assertNode.match(d1.evidence, /quote is not in the reply/);
});

Deno.test("4 the cap: 10 x MUST met / MUST total, at most 8 unless half the NICEs are met", () => {
  const m = (n: number, of: number) => Array.from({ length: of }, (_, i) => ({ level: "MUST", yes: i < n }));
  const nn = (n: number, of: number) => Array.from({ length: of }, (_, i) => ({ level: "NICE", yes: i < n }));
  assertNode.deepStrictEqual(scoreOf([...m(6, 6), ...nn(1, 4)]), { score: 8, capped: true, must: { met: 6, total: 6 }, nice: { met: 1, total: 4 } });
  assertNode.equal(scoreOf([...m(6, 6), ...nn(2, 4)]).score, 10);
  assertNode.equal(scoreOf([...m(6, 6), ...nn(2, 5)]).score, 8, "2 of 5 is under half");
  assertNode.equal(scoreOf([...m(3, 6), ...nn(0, 4)]).score, 5, "under 8 the cap does not bite");
  assertNode.equal(scoreOf([...m(5, 6), ...nn(0, 2)]).score, 8, "8.3 is capped to 8");
  assertNode.equal(scoreOf([...m(2, 3)]).score, 6.7);
  assertNode.equal(scoreOf(m(4, 4)).score, 10, "no NICEs: nothing to cap on");
});

Deno.test("5 Instinct's own replies grade deterministically-only; a failing judge is a no, never a crash", async () => {
  const lines: Turn[] = (await Deno.readTextFile(new URL("../../evals/mirror/instinct-wa-batch1/instinct.jsonl", import.meta.url))).trim().split("\n").map((l) => JSON.parse(l));
  const rows = await gradeTranscript(rubric, lines, null);
  assertNode.equal(rows.length, 26);
  for (const r of rows) {
    assertNode.ok(r.score >= 0 && r.score <= 10, r.id);
    assertNode.ok(r.elements.every((e) => e.by !== "judge"), "no judge ran");
    assertNode.ok(r.elements.filter((e) => e.by === "unjudged").every((e) => !e.yes), "unjudged is never a yes");
  }
  const table = summaryTable(rows, { C1: 3 });
  assertNode.match(table, /\| C1 \| [\d.]+ \| 6 \|/); assertNode.match(table, /\| mean \|/);
  const broken: Judge = () => Promise.reject(new Error("bridge down"));
  const one = await gradeTranscript(rubric, lines, broken, ["C18"]);
  assertNode.ok(one[0].elements.filter((e) => e.by === "judge").every((e) => !e.yes && /judge failed: bridge down/.test(e.evidence)));
  const missing = await gradeTranscript(rubric, [], null, ["C1"]);
  assertNode.equal(missing[0].ran, false); assertNode.equal(missing[0].score, 0);
});

Deno.test("5b the subscription judge refuses while an API key is in the environment ($0: it stops before the CLI)", async () => {
  const had = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-a-key");
  try { await assertNode.rejects(() => subscriptionJudge(), /refusing: unset ANTHROPIC_API_KEY/); } finally {
    if (had === undefined) Deno.env.delete("ANTHROPIC_API_KEY"); else Deno.env.set("ANTHROPIC_API_KEY", had);
  }
});
