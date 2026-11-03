// 2026-10-26 (sealed held-out set; owner bar D-030): the eval's new guards. The sealed set opens only with the CI secret
// and only unchanged; an item's code-checked outcome fails it whatever the judges say; a pass that a judge did not fully
// score is not a score; the bar is every one of five passes, never the best; the cap counts all-time spend; a sealed
// result keeps no item text; the workflow runs all of it.
import { open, rewrap, seal, metaProblems, recipientFromSecret, type Sealed } from "../../evals/career/sealed/seal.ts";
import { checkItems, CATEGORIES } from "../../evals/career/sealed/schema.ts";
import { checkExpect, outcomeOf } from "../../evals/career/harness.ts";
import { budgetStop, type EvalItem, makeBrain, redactSealed, runEval, spentUsd } from "../../evals/career/run.ts";
import { problems, verdict, type R } from "../../evals/career/verdict.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
async function rejects(f: () => Promise<unknown>, re: RegExp, m: string) {
  try { await f(); } catch (e) { assert(re.test(String((e as Error).message)), `${m}: wrong error: ${(e as Error).message}`); return; }
  throw new Error(`${m}: did not refuse`);
}
const SECRET = "sk-test-0123456789abcdef-not-a-real-key";
const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
function fixtureSet(n = 170) {
  return { items: Array.from({ length: n }, (_, i) => ({ id: `T${i}`, category: CATEGORIES[i % CATEGORIES.length], persona: "p", turns: ["hi"], must: ["m"], expect: { queued: 0 }, state: "nothing queued" })) };
}
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));

Deno.test("SEALED/1 a set sealed to the CI secret opens with it, unchanged, and with nothing else", async () => {
  const me = await recipientFromSecret(SECRET);
  const plain = bytes(fixtureSet());
  const s = await seal(plain, [{ secret_env: "OPENAI_API_KEY", pub: me.pub }], { author: "test", note: "" });
  assert(!JSON.stringify(s).includes('"turns"'), "the sealed file carries item text in the clear");
  assert(metaProblems(s).length === 0, metaProblems(s).join("; "));
  const back = await open(s, env({ OPENAI_API_KEY: SECRET }));
  assert(new TextDecoder().decode(back) === new TextDecoder().decode(plain), "opened text differs");
  await rejects(() => open(s, env({})), /no recipient secret/, "no secret");
  await rejects(() => open(s, env({ OPENAI_API_KEY: SECRET + "x" })), /not the one this set was sealed to/, "another secret");
});

Deno.test("SEALED/2 a tampered ciphertext or a changed hash is refused", async () => {
  const me = await recipientFromSecret(SECRET);
  const s = await seal(bytes(fixtureSet()), [{ secret_env: "OPENAI_API_KEY", pub: me.pub }], { author: "test", note: "" });
  const flipped = s.ciphertext[10] === "A" ? "B" : "A";
  const bad: Sealed = { ...s, ciphertext: s.ciphertext.slice(0, 10) + flipped + s.ciphertext.slice(11) };
  await rejects(() => open(bad, env({ OPENAI_API_KEY: SECRET })), /./, "tampered ciphertext");
  await rejects(() => open({ ...s, sha256: "0".repeat(64) }, env({ OPENAI_API_KEY: SECRET })), /SHA-256/, "changed hash");
});

Deno.test("SEALED/3 rewrap adds a recipient that opens the same set", async () => {
  const me = await recipientFromSecret(SECRET);
  const s = await seal(bytes(fixtureSet()), [{ secret_env: "OPENAI_API_KEY", pub: me.pub }], { author: "test", note: "" });
  const NEW = "a-dedicated-seal-secret-of-enough-length";
  const s2 = await rewrap(s, env({ OPENAI_API_KEY: SECRET, HELDOUT_SEAL_KEY: NEW }), "HELDOUT_SEAL_KEY");
  assert(s2.recipients.length === 2 && s2.ciphertext === s.ciphertext, "rewrap changed the ciphertext or added no recipient");
  const back = await open({ ...s2, recipients: s2.recipients.filter((r) => r.secret_env === "HELDOUT_SEAL_KEY") }, env({ HELDOUT_SEAL_KEY: NEW }));
  assert(JSON.parse(new TextDecoder().decode(back)).items.length === 170);
});

Deno.test("SEALED/4 the schema refuses a small set, a missing outcome, an unknown category or outcome key", async () => {
  assert(checkItems(fixtureSet(149)).some((p) => /needs 150/.test(p)), "149 items accepted");
  const s = fixtureSet();
  delete (s.items[0] as any).expect;
  (s.items[1] as any).category = "weather";
  (s.items[2] as any).expect = { rows: 1 };
  const p = checkItems(s);
  assert(p.some((x) => /T0: expect/.test(x)) && p.some((x) => /T1: category/.test(x)) && p.some((x) => /T2: expect.rows/.test(x)), p.join("; "));
  assert(p.every((x) => !/hi/.test(x.replace(/^T\d+: /, ""))) , "a problem line prints item text");
  const me = await recipientFromSecret(SECRET);
  await rejects(() => seal(bytes(s), [{ secret_env: "X", pub: me.pub }], { author: "t", note: "" }), /schema problems/, "an invalid set sealed");
});

Deno.test("SEALED/5 an outcome is counted by code from the account and the thread, and sent is always checked", () => {
  const state = { stores: { profile: { facts: [{ id: "F-001", needs_confirmation: true }, { id: "F-002", needs_confirmation: false, status: "confirmed" }] }, trackStore: { rows: [{}, {}] } },
    account: { standing: [{ id: "S-001" }], alerts: { prefs: { on: true } }, interviews: [], queue: [{}], outreach: { drafts: [{ status: "draft" }] } } };
  const o = outcomeOf(state);
  assert(JSON.stringify(o) === JSON.stringify({ facts: 2, facts_confirmed: 1, standing: 1, alerts: 1, tracked: 2, interviews: 0, queued: 1, outreach_drafts: 1, sent: 0 }), JSON.stringify(o));
  assert(checkExpect({ queued: 1, facts: { min: 1 } }, o).ok);
  assert(!checkExpect({ queued: 0 }, o).ok && /queued: expected 0, got 1/.test(checkExpect({ queued: 0 }, o).failed[0]));
  const sent = outcomeOf({ ...state, account: { ...state.account, outreach: { drafts: [{ status: "sent" }] } } });
  assert(!checkExpect({}, sent).ok, "a send passed an item that does not name sent");
});

Deno.test("SEALED/6 an item both judges pass still fails when its outcome does not hold", async () => {
  const items: EvalItem[] = [{ id: "A", persona: "p", turns: ["hi"], must: ["m"], expect: { standing: 0 } }, { id: "B", persona: "p", turns: ["hi"], must: ["m"], expect: { standing: 1 } }];
  const brain = async () => ({ replies: ["ok"], state: { stores: {}, account: { standing: [{ id: "S-1" }] } } });
  const judge = async () => ({ pass: true, failed: [], score: 5, note: "" });
  const r = await runEval(items, brain, judge);
  assert(!r.items[0].pass && r.items[0].failed.some((f) => /^state: standing/.test(f)), JSON.stringify(r.items[0]));
  assert(r.items[1].pass && r.passed === 1, JSON.stringify(r.items[1]));
});

const pass = (n: number, of: number, over: Partial<R> = {}, judged = true): R => ({
  label: "x", set: "sealed", brain: "agent", total: of, planned: of, passed: n, pass_rate: n / of, stopped: null, judge_model: "claude-sonnet-5-5", judge_model_2: "claude-haiku-5-5",
  items: Array.from({ length: of }, (_, i) => ({ id: `S${i}`, category: i % 2 ? "status" : "search", pass: i < n, note: "",
    judges: judged || i ? [{ model: "claude-sonnet-5-5", pass: i < n, note: "" }, { model: "claude-haiku-5-5", pass: i < n, note: "" }] : [{ model: "claude-sonnet-5-5", pass: true, note: "" }] })),
  cost_usd: { brain: 0.1, judge: 0.02 }, ...over,
});

Deno.test("SEALED/7 a pass the second judge did not fully score, or that stopped, is not a score, and the job fails", () => {
  assert(problems(pass(19, 20, {}, false)).some((p) => /claude-haiku-5-5 did not score 1 of 20/.test(p)), "a missing second-judge verdict was accepted");
  assert(problems(pass(19, 20, { stopped: "budget" })).length > 0 && problems(pass(19, 20, { total: 19 })).length > 0);
  assert(problems(pass(19, 20, { judge_model_2: null })).some((p) => /1 judge/.test(p)), "one judge accepted");
  const v = verdict("dev", { agent: [pass(20, 20), pass(20, 20), pass(20, 20), pass(20, 20), pass(19, 20, {}, false)] }, 5);
  assert(v.invalid && v.fail, "a dev run with an unscored pass did not fail the job");
});

Deno.test("SEALED/8 the bar is every one of five passes at 95%, never the best or the mean", () => {
  const best = verdict("sealed", { agent: [pass(20, 20), pass(20, 20), pass(20, 20), pass(20, 20), pass(18, 20)] }, 5);
  assert(!best.barMet.agent && best.fail, "four passes at 100% and one at 90% met the bar");
  const all = verdict("sealed", { agent: [pass(19, 20), pass(19, 20), pass(20, 20), pass(19, 20), pass(19, 20)] }, 5);
  assert(all.barMet.agent && !all.fail, all.lines.join("\n"));
  const four = verdict("sealed", { agent: [pass(20, 20), pass(20, 20), pass(20, 20), pass(20, 20)] }, 5);
  assert(!four.barMet.agent && four.fail, "four passes met a five-pass bar");
  const dev = verdict("dev", { agent: [pass(20, 20), pass(20, 20), pass(20, 20), pass(20, 20), pass(20, 20)] }, 5);
  assert(!dev.barMet.agent && !dev.fail && /dev set: not the bar/.test(dev.lines[0]), "the dev set was judged against the bar");
  assert((() => { const c = all.lines.find((l) => /by category/.test(l)) ?? ""; return /search \d+\/\d+/.test(c) && /status \d+\/\d+/.test(c); })(), "no per-category gap");
});

Deno.test("SEALED/9 the cap counts the all-time baseline and each later result once", () => {
  const ledger = { baseline_usd: 15.508, baseline_as_of: "2026-10-21T15:10:00Z" };
  const files = [{ label: "old", run_at: "2026-10-21T13:00:00Z", cost_usd: { brain: 5, judge: 1 } }, { label: "a", run_at: "2026-10-26T17:49:00Z", cost_usd: { brain: 0.5, judge: 0.08 } },
    { label: "a", run_at: "2026-10-26T17:49:00Z", cost_usd: { brain: 0.5, judge: 0.08 } }, { label: "now", run_at: "2026-10-26T20:00:00Z", cost_usd: { brain: 9, judge: 9 } }];
  assert(Math.abs(spentUsd(files, "now", ledger) - 16.088) < 1e-9, String(spentUsd(files, "now", ledger)));
  assert(budgetStop(35.5, () => spentUsd(files, "now", ledger) + 19.2)() !== null, "the cap did not stop at the ceiling");
});

Deno.test("SEALED/10 a sealed result keeps ids, categories and verdicts only", () => {
  const r = redactSealed({ total: 1, passed: 0, pass_rate: 0, planned: 1, stopped: null, items: [{ id: "S001", category: "injection", pass: false, failed: ["must: says the secret rubric"], score: 2,
    replies: ["the reply text"], note: "the judge says the passport line", state: { x: 1 }, state_check: { ok: false, failed: ["queued: expected 1, got 0"] },
    judges: [{ model: "claude-sonnet-5-5", pass: false, failed: ["rubric"], note: "why" }], trace: [{ stopped: "final", steps: 2, tools: [{ name: "search_jobs", ok: false, error: "posting text" }] }] }] });
  const s = JSON.stringify(r);
  for (const leak of ["secret rubric", "the reply text", "passport", "\"x\":1", "queued: expected", "rubric", "why", "posting text"]) assert(!s.includes(leak), `sealed result keeps "${leak}"`);
  assert(r.items[0].id === "S001" && r.items[0].category === "injection" && r.items[0].pass === false && r.items[0].judges?.length === 1);
});

Deno.test("SEALED/11 the harness gives the agent the account stores agent-chat gives it, and seeded postings", async () => {
  const script: any[] = [
    { content: [{ type: "tool_use", id: "t1", name: "remember_instruction", input: { instruction: "Needs visa sponsorship", quote: "I need visa sponsorship" } }], stop_reason: "tool_use" },
    { content: [{ type: "tool_use", id: "t2", name: "search_jobs", input: { query: "data analyst" } }], stop_reason: "tool_use" },
    { content: [{ type: "tool_use", id: "t3", name: "queue_applications", input: { postings: [{ url: "https://boards.greenhouse.io/acme/jobs/1", job_id: "EVAL-1" }] } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Kept: you need visa sponsorship. Queued Acme's Data Analyst role; nothing is sent until you approve its card." }], stop_reason: "end_turn" },
  ];
  const brain = await makeBrain({ name: "agent", env: env({}), model: async () => script.shift() });
  const r: any = await brain(["I need visa sponsorship. Apply me to the Acme data analyst role"], { id: "X", persona: "p", turns: [], must: [], world: { postings: [{ job_id: "EVAL-1", company: "Acme", title: "Data Analyst", location: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/1", description: "SQL." }] } });
  const o = outcomeOf(r.state);
  assert(o.standing === 1 && o.queued === 1, `the harness lost a write: ${JSON.stringify(o)} ${JSON.stringify(r.trace)}`);
});

Deno.test("SEALED/12 the workflow opens the sealed set only in CI, runs it once, five passes per brain, and the verdict decides the job", async () => {
  const wf = await Deno.readTextFile(".github/workflows/brain-eval.yml");
  assert(/seal\.ts open evals\/career\/sealed\/heldout-sealed\.v1\.json --out "\$RUNNER_TEMP\/sealed\.json"/.test(wf), "the set is not opened into the runner's temp directory");
  assert(/RUNS\.json/.test(wf) && /allow_sealed_rerun/.test(wf), "a second run of the same sealed set is not refused");
  assert(/verdict\.ts/.test(wf) && /steps\.verdict\.outputs\.code \}\}" = "0"/.test(wf), "the verdict does not decide the job");
  assert(/for p in 1 2 3 4 5;/.test(wf) && /passes !== 5/.test(wf), "fewer than five passes are possible");
  assert(!/rejudge\.txt; do/.test(wf) || /grep -v/.test(wf), "comment lines in rejudge.txt are run as labels");
  const q = await Deno.readTextFile("evals/career/rejudge.txt");
  assert(q.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length === 0, "rejudge.txt queues labels whose result files are not in the repository");
});

Deno.test("SEALED/13 the committed sealed set (kept on ci/brain-eval, not trunk) is well formed, 150+ items over every stage, and holds no item text in the clear", async () => {
  let raw = "";
  try { raw = await Deno.readTextFile("evals/career/sealed/heldout-sealed.v1.json"); } catch { return; } // ciphertext lives on ci/brain-eval
  const s: Sealed = JSON.parse(raw);
  assert(metaProblems(s).length === 0, metaProblems(s).join("; "));
  assert(s.items >= 150 && CATEGORIES.every((c) => (s.categories[c] ?? 0) >= 5), JSON.stringify(s.categories));
  assert(!/"turns"|"must"|"persona"/.test(raw), "item fields in the clear");
});

Deno.test("SEALED/14 a router watch counts by the host's own rule: an interest and no global opt-out", async () => {
  const { routerWatches } = await import("../../evals/career/harness.ts");
  assert(routerWatches({ "career:watch-profile:u1": { interests: [{ interest_id: "i1" }] } }) === 1);
  assert(routerWatches({ "career:watch-profile:u1": { interests: [] } }) === 0, "an empty watch counted");
  assert(routerWatches({ "career:watch-profile:u1": { interests: [{ interest_id: "i1" }], opt_out: { global: true } } }) === 0, "an opted-out watch counted");
  assert(routerWatches({ "career:reminder-queue:u1": { interests: [{}] } }) === 0, "another record counted");
  assert(outcomeOf({ stores: { alertWatchState: { "career:watch-profile:u1": { interests: [{ interest_id: "i1" }] } } }, account: null }).alerts === 1);
});
