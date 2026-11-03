// Live corpus evals: every example's turns sent to the DEPLOYED agent-chat handler (one fresh thread per example), graded
// by the same rules as offline (graders.cjs) and scored for mannerisms by the LLM judge (judge.cjs, the cheap OpenAI model
// through the gateway). Money paths stay gated: a turn that would approve a live card (a yes after a confirm) is NOT sent,
// is reported as not sent, and the thread is closed with "never mind". Results: evals/corpus/results/live-<stamp>.json.
// Started by: deno run -A evals/corpus/run.ts --live (needs UPMORE_CHAT_URL, UPMORE_TEST_JWT, ANTHROPIC_API_KEY).
import graders from "./graders.cjs";
import judge from "./judge.cjs";
import corpus from "../../corpus/corpus.json" with { type: "json" };
import { callModel, modelConfigFor } from "../../supabase/functions/_shared/model_gateway.ts";
const { grade } = graders as any;
const { judgeMessages, parseJudge } = judge as any;
const APPROVE = /^\s*(y|ya|yes|yep|yeah|yup|ok|okay|confirm|do it|go|send it|approve)\b/i;
const EXECUTED = new Set(["sent", "filled", "executed", "cancelled", "confirmed", "accepted", "placed", "partially_filled"]);

export async function live(url: string, jwt: string, key: string, only: string[] = []) {
  const post = async (body: any) => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({ error: `HTTP ${r.status}, not JSON` })); if (!r.ok && !j.error) j.error = `HTTP ${r.status}`; return j;
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  };
  const cfg = modelConfigFor({ get: (k: string) => ({ ANTHROPIC_API_KEY: key } as any)[k] }, "claude-haiku-5-5");
  const rows: any[] = [];
  for (const e of (corpus as any).examples) {
    if (only.length && !only.includes(e.id)) continue;
    let thread: string | null = null, lastOutcome: string | null = null; const actual: any[] = [];
    for (const t of e.turns) {
      if (t.role !== "user") continue;
      if (lastOutcome === "confirm" && APPROVE.test(t.text)) { actual.push({ user: t.text, reply: null, outcome: "not_sent", executed: false, skipped: "approval of a live card; money paths are gated" }); continue; }
      const res: any = await post(Object.assign(thread ? { thread_id: thread } : {}, { message: t.text }));
      if (res.thread_id) thread = res.thread_id;
      lastOutcome = res.route && res.route.outcome || null;
      actual.push({ user: t.text, reply: res.reply ?? null, outcome: res.error ? "error" : lastOutcome, executed: EXECUTED.has(lastOutcome || ""), error: res.error || null, failure_code: res.failure_code || null });
    }
    if (thread) await post({ thread_id: thread, message: "never mind" });
    // Rules grade the turns up to the first one not sent (the grader pairs turns by position).
    const cut = actual.findIndex(a => a.outcome === "not_sent"), sent = cut < 0 ? actual : actual.slice(0, cut);
    const g = grade(e, sent, {});
    const errors = sent.filter(a => a.error);
    let j: any = { score: null, why: "not judged", pass: false };
    if (!errors.length) {
      const m = judgeMessages(e, actual);
      try {
        const out = await callModel(cfg, { max_tokens: 200, system: m.system, messages: [{ role: "user", content: m.user }] }, { role: "probe", timeoutMs: 30000 });
        j = parseJudge((out.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
      } catch (err) { j = { score: null, why: "judge unavailable: " + String((err as any)?.summary?.() || err), pass: false }; }
    }
    const status = errors.length ? "ERROR" : g.status === "FAIL" ? "FAIL" : !j.pass ? "STYLE_FAIL" : g.status;
    rows.push({ id: e.id, file: e.file, title: e.title, status, rules_failed: g.failed, judge: j, turns: actual });
    console.log(`${status} ${e.id} ${e.title}${j.score ? " (judge " + j.score + ")" : ""}${g.failed[0] ? " | " + g.failed[0] : ""}${errors[0] ? " | " + errors[0].error : ""}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(new URL(`./results/live-${stamp}.json`, import.meta.url), JSON.stringify({ url_host: new URL(url).host, at: new Date().toISOString(), rows }, null, 1) + "\n");
  const c = (s: string) => rows.filter(r => r.status === s).length;
  console.log(`corpus LIVE: ${rows.length} examples; PASS ${c("PASS")}, LIMITED ${c("LIMITED")}, STYLE_FAIL ${c("STYLE_FAIL")}, FAIL ${c("FAIL")}, ERROR ${c("ERROR")}. Raw log: evals/corpus/results/live-${stamp}.json`);
  return rows;
}
