// #360 takeover (2026-11-01):
//   N  "not yet" on its own answers a yes/no question asked with "yet" (a no); "not yet, I'll answer later" and "later"
//      stay deferrals there; to any other question "not yet" is still a deferral, never saved as the answer.
//   D  the dry-run engine refuses --submit and --approved (and any *submit / cloud-authorize argument) before it spawns.
import assertNode from "node:assert/strict";
import { checkAnswer, type OpenQuestion, type QuestionStore, questionsTurn, type Shown } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { dryEngine } from "../../scripts/career/ramp-dry-run.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "00000000-0000-4000-8000-0000000007a1", T = "00000000-0000-4000-8000-0000000007a2";
const q = (n: number, label: string, extra: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`, key: `job:${String(n).repeat(16).slice(0, 16)}`, kind: "unknown", label,
  type: "input_text", options: [], company: "Ramp", job_ids: ["ashby:ramp:a13ae586-f4cb-4385-8822-c42b9b54ed74"], misfit: false, answer: null, ...extra,
});
const GRAD_OPTS = q(1, "Have you graduated yet?", { type: "radio", options: ["Yes", "No"] });
const GRAD_BOX = q(2, "Have you completed your degree yet?", { type: "checkbox", options: [] });
const NAME = q(3, "First name");
const SPONSOR = q(4, "Will you require visa sponsorship?", { type: "checkbox", options: ["Yes", "No"] });

Deno.test("N1 bare 'not yet' answers a yes/no 'yet' question as No", () => {
  for (const said of ["not yet", "Not yet.", "not yet!", "no, not yet"]) {
    eq(checkAnswer(GRAD_OPTS, said), { ok: true, value: "No" }, `options: ${said}`);
    eq(checkAnswer(GRAD_BOX, said), { ok: true, value: "No" }, `checkbox: ${said}`);
  }
});

Deno.test("N2 a deferral is still a deferral, on a 'yet' question and on any other", () => {
  for (const said of ["not yet, I'll answer later", "not yet — I'll answer later", "later", "skip", "maybe later", "not yet, ask me later"]) {
    const c = checkAnswer(GRAD_OPTS, said);
    eq([c.ok, (c as { skip?: boolean }).skip], [false, true], `yet question: ${said}`);
  }
  for (const qq of [NAME, SPONSOR, q(5, "Do you agree yet?", { kind: "consent", type: "checkbox", options: ["Yes", "No"] })]) {
    const c = checkAnswer(qq, "not yet");
    eq([c.ok, (c as { skip?: boolean }).skip], [false, true], `not a yet yes/no: ${qq.label}`);
  }
});

Deno.test("N3 in chat: 'not yet' to 'Have you graduated yet?' is saved as No; 'not yet, I'll answer later' saves nothing", async () => {
  for (const [said, want] of [["not yet", "No"], ["not yet, I'll answer later", undefined]] as const) {
    const answered = new Map<string, string>();
    let shown: Shown | null = null, last: string | null = null;
    const rows = [GRAD_OPTS, NAME];
    const store: QuestionStore = {
      open: async (_u, limit) => rows.filter((r) => !answered.has(r.id)).slice(0, limit),
      countOpen: async () => rows.filter((r) => !answered.has(r.id)).length,
      get: async (_u, ids) => rows.filter((r) => ids.includes(r.id)),
      answer: async (_u, id, a) => { answered.set(id, a); },
      shown: async () => shown,
      setShown: async (_u, s) => { shown = structuredClone(s); },
      lastAssistantIntent: async () => last,
    };
    const turn = async (message: string) => {
      const r = (await questionsTurn({ message, userId: U, threadId: T, now: Date.now(), store, situation: undefined }))!;
      last = ["shown", "partial", "answered_next"].includes(r.status) ? "career_apply_questions" : "other";
      return r;
    };
    eq((await turn("what do you need from me")).status, "shown");
    const r = await turn(said);
    eq(answered.get(GRAD_OPTS.id), want, `${said}: ${r.reply}`);
    eq(answered.has(NAME.id), false);
  }
});

Deno.test("D1 the dry-run engine throws on --submit and --approved, from args or extra, and never spawns", async () => {
  const root = await Deno.makeTempDir({ prefix: "fx7-dry-" });
  try {
    const cases: [string[], string[]][] = [
      [["--submit"], []], [["--approved"], []], [["--url", "x", "--submit"], []], [[], ["--submit"]], [[], ["--approved"]],
      [["--cloud-authorize"], []], [["--script-submit", "--approved"], []],
    ];
    for (const [args, extra] of cases) {
      const run = dryEngine({ root: "/nonexistent-root", extra, evidenceRoot: root });
      await assertNode.rejects(() => run(args), /DRY_RUN_ONLY/, `args ${args} extra ${extra}`);
      eq(run.dirs.length, 0, `nothing spawned: ${args} ${extra}`);
    }
  } finally { await Deno.remove(root, { recursive: true }); }
});

Deno.test("D2 --script-submit alone is allowed through the guard (it names the family, not a submit)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fx7-dry-" });
  try {
    const run = dryEngine({ root: "/nonexistent-root", extra: ["--script-submit"], evidenceRoot: root });
    const r = await run(["--url", "http://127.0.0.1:9/"]);
    eq(run.dirs.length, 1, "the guard let it reach the engine");
    eq((r as { result: { state: string } }).result.state, "not_submitted");
  } finally { await Deno.remove(root, { recursive: true }); }
});
