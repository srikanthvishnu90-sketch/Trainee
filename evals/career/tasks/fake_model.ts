// The fake model on the OpenAI wire for the task-completion eval: no key, no spend, deterministic. It plays each task's
// oracle (evals/career/tasks/tasks.json: what a competent planner would do), keyed by the person's message:
//   - the planner's call (the plan_task tool is forced): the oracle's steps;
//   - the agent brain's loop (career tools offered): the oracle as agent tool calls, one per step, reading earlier tool
//     results for the postings a search returned; then a short final line (the brain has no reminder tool: skipped);
//   - an outreach draft (the networking turn's writer): one short email from the recipient row and the topic;
//   - anything else (staged advice, the reply writer): a short neutral line.
// It is a fixture: its score measures what the code paths complete when the model plans right, never a model.
// deno-lint-ignore-file no-explicit-any

const POSTINGS: any[] = JSON.parse(await Deno.readTextFile(new URL("./tasks.json", import.meta.url))).postings;
export type OracleStep = { capability: string; text: string; args?: Record<string, any> };
const oracle = new Map<string, OracleStep[]>();
export const calls: { kind: "plan" | "agent" | "draft" | "other"; user: string }[] = [];
export function setOracle(map: Record<string, OracleStep[]>) { for (const [k, v] of Object.entries(map)) oracle.set(norm(k), v); }
export function clearOracle() { oracle.clear(); }
// A mutation hook for the eval's own guards (tests): drop or change the steps the planner is given.
export let mutatePlan: ((steps: OracleStep[]) => OracleStep[]) | null = null;
export function setMutation(f: ((steps: OracleStep[]) => OracleStep[]) | null) { mutatePlan = f; }
const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const reply = (body: any, message: any, finish: string) => new Response(JSON.stringify({ id: `fake-${calls.length}`, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
const text = (body: any, t: string) => reply(body, { role: "assistant", content: t }, "stop");
const tool = (body: any, name: string, input: unknown) => reply(body, { role: "assistant", content: null, tool_calls: [{ id: `call_${calls.length}_${name}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, "tool_calls");
const contentOf = (m: any) => typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";

// The agent brain's calls for one task turn, given the tool results so far (in order).
function agentActions(steps: OracleStep[], results: { name: string; out: any }[]): { name: string; input: any }[] {
  const acts: { name: string; input: any }[] = [];
  // A long tool result reaches the model cut short (loop.ts RESULT_CHARS), so the postings are read by their job ids, in
  // the order the result lists them, and completed from the seeded postings.
  const lastSearch = () => {
    const r = [...results].reverse().find((x) => x.name === "search_jobs");
    if (!r) return [];
    if (Array.isArray(r.out?.postings)) return r.out.postings;
    const ids = [...new Set([...String(r.out ?? "").matchAll(/"job_id":"([^"]+)"/g)].map((m) => m[1]))];
    return ids.map((id) => POSTINGS.find((p) => p.job_id === id)).filter(Boolean);
  };
  const pick = (n: number) => { const p = lastSearch()[n - 1]; return p ? { url: p.url, job_id: p.job_id, company: p.company, title: p.title } : null; };
  for (const s of steps) {
    const a = s.args ?? {};
    if (s.capability === "jobs.search") acts.push({ name: "search_jobs", input: { query: a.query ?? s.text, limit: a.limit ?? 10 } });
    else if (s.capability === "apply.queue" || s.capability === "resume.tailor") {
      const picks: number[] = Array.isArray(a.picks) ? a.picks : [1];
      if (!a.picks) acts.push({ name: "search_jobs", input: { query: a.query ?? s.text, limit: 5 } });
      if (s.capability === "apply.queue") acts.push({ name: "queue_applications", input: { postings: picks.map(pick).filter(Boolean) } });
      else for (const n of picks) acts.push({ name: "tailor_resume", input: { job_id: pick(n)?.job_id ?? "" } });
    } else if (s.capability === "outreach.draft") acts.push({ name: "draft_outreach", input: { ...(a.firm ? { firm: a.firm } : {}), ...(a.title ? { title: a.title } : {}), count: 1 } });
    else if (s.capability === "tracker.update") acts.push({ name: "track_application", input: { company: a.company, ...(a.role ? { role: a.role } : {}), stage: a.stage ?? "Saved", ...(a.when ? { when: a.when } : {}) } });
    else if (s.capability === "interview.prep") acts.push({ name: "interview_brief", input: { company: a.company ?? "", ...(a.role ? { role: a.role } : {}) } });
    else if (s.capability === "alerts.watch") acts.push({ name: "set_job_alerts", input: { keywords: a.keywords ?? [s.text], locations: a.locations ?? [] } });
    else if (s.capability === "instruction.remember") acts.push({ name: "remember_instruction", input: { instruction: a.instruction ?? s.text, quote: a.quote ?? s.text } });
    // reminder.set: the agent brain has no reminder tool.
  }
  return acts;
}

export async function fakeOpenAI(req: Request): Promise<Response> {
  const body = await req.json();
  const msgs: any[] = body.messages ?? [];
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const user = contentOf(lastUser);
  if (tools.includes("plan_task")) {
    calls.push({ kind: "plan", user });
    const message = user.replace(/^THE PERSON'S MESSAGE:\s*/, "");
    let steps = oracle.get(norm(message));
    if (!steps) return tool(body, "plan_task", { kind: "not_a_task" });
    if (mutatePlan) steps = mutatePlan(steps);
    return tool(body, "plan_task", { kind: "task", steps: steps.map((s) => ({ capability: s.capability, text: s.text, ...(s.args ? { args: s.args } : {}) })) });
  }
  if (tools.includes("search_jobs") || tools.includes("get_situation")) {
    calls.push({ kind: "agent", user });
    // This turn's calls so far: everything after the person's last message.
    const at = msgs.lastIndexOf(lastUser);
    const results: { name: string; out: any }[] = [];
    const byId = new Map<string, string>();
    for (const m of msgs.slice(at + 1)) {
      if (m.role === "assistant") for (const c of m.tool_calls ?? []) byId.set(c.id, c.function?.name);
      if (m.role === "tool") { let out: any = null; try { out = JSON.parse(contentOf(m)); } catch { out = contentOf(m); } results.push({ name: byId.get(m.tool_call_id) ?? "", out }); }
    }
    const steps = oracle.get(norm(user));
    const acts = steps ? agentActions(steps, results) : [];
    const next = acts[results.length];
    return next ? tool(body, next.name, next.input) : text(body, "Here is where that stands.");
  }
  if (/- name: /.test(user)) {
    calls.push({ kind: "draft", user });
    const first = /- name: (\S+)/.exec(user)?.[1] ?? "there", topic = /ASK ABOUT[^\n]*\n- (.+)/.exec(user)?.[1];
    return text(body, `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to ${topic ? `ask about ${topic}` : "hear how you got started"}. Would you be open to a short call?`);
  }
  calls.push({ kind: "other", user });
  return text(body, "Here is what I can tell you.");
}
