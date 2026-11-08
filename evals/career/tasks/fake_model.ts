// The fake model on the Anthropic Messages wire (POST https://api.anthropic.com/v1/messages) for the task-completion eval: no key, no spend, deterministic. It plays each task's
// oracle (evals/career/tasks/tasks.json: what a competent planner would do), keyed by the person's message:
//   - the planner's call (the plan_task tool is forced): the oracle's steps;
//   - the agent brain's loop (career tools offered): the oracle as agent tool calls, one per step, reading earlier tool
//     results for the postings a search returned; then a short final line (the brain has no reminder tool: skipped);
//   - an outreach draft (the networking turn's writer): one short email from the recipient row and the topic;
//   - anything else (staged advice, the reply writer): a short neutral line.
// It is a fixture: its score measures what the code paths complete when the model plans right, never a model.
// deno-lint-ignore-file no-explicit-any

const POSTINGS: any[] = JSON.parse(await Deno.readTextFile(new URL("./tasks.json", import.meta.url))).postings;
// The end-to-end eval's scaled set (e2e/generate.ts) brings its own postings: added before its run, so a pick from a search
// result is completed from them as from the task eval's own.
export function addPostings(ps: any[]) { const have = new Set(POSTINGS.map((p) => p.job_id)); for (const p of ps) if (!have.has(p.job_id)) { POSTINGS.push(p); have.add(p.job_id); } }
export type OracleStep = { capability: string; text: string; args?: Record<string, any> };
const oracle = new Map<string, OracleStep[]>();
export const calls: { kind: "plan" | "agent" | "draft" | "other"; user: string }[] = [];
export function setOracle(map: Record<string, OracleStep[]>) { for (const [k, v] of Object.entries(map)) oracle.set(norm(k), v); }
export function clearOracle() { oracle.clear(); }
// A mutation hook for the eval's own guards (tests): drop or change the steps the planner is given.
export let mutatePlan: ((steps: OracleStep[]) => OracleStep[]) | null = null;
export function setMutation(f: ((steps: OracleStep[]) => OracleStep[]) | null) { mutatePlan = f; }
const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const message = (body: any, content: any[], stop: string) => new Response(JSON.stringify({ id: `fake-${calls.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason: stop, usage: { input_tokens: 50, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
const text = (body: any, t: string) => message(body, [{ type: "text", text: t }], "end_turn");
const tool = (body: any, name: string, input: unknown) => message(body, [{ type: "tool_use", id: `toolu_${calls.length}_${name}`, name, input }], "tool_use");
const contentOf = (m: any) => typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
const isToolResult = (m: any) => m?.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "tool_result");

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
    // research.market (R9-F): the research tool as the brain calls it (career_tools.ts research_market): the person's question,
    // the format (a File when they asked for one), search queries and the site domains to read.
    else if (s.capability === "research.market") acts.push({ name: "research_market", input: { question: a.question ?? s.text, format: a.format ?? "file", queries: a.queries ?? [s.text], ...(a.sites ? { sites: a.sites } : {}), ...(a.companies ? { companies: a.companies } : {}) } });
    else if (s.capability === "instruction.remember") acts.push({ name: "remember_instruction", input: { instruction: a.instruction ?? s.text, quote: a.quote ?? s.text } });
    // reminder.set: the agent brain has no reminder tool.
  }
  return acts;
}

export async function fakeAnthropic(req: Request): Promise<Response> {
  const body = await req.json();
  const msgs: any[] = body.messages ?? [];
  const tools: string[] = (body.tools ?? []).map((t: any) => t.name);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !isToolResult(m));
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
      if (m.role === "assistant" && Array.isArray(m.content)) for (const c of m.content) if (c?.type === "tool_use") byId.set(c.id, c.name);
      if (isToolResult(m)) for (const c of m.content) if (c?.type === "tool_result") { const raw = contentOf(c); let out: any = null; try { out = JSON.parse(raw); } catch { out = raw; } results.push({ name: byId.get(c.tool_use_id) ?? "", out }); }
    }
    const steps = oracle.get(norm(user));
    const acts = steps ? agentActions(steps, results) : [];
    const next = acts[results.length];
    return next ? tool(body, next.name, next.input) : text(body, "Here is where that stands.");
  }
  // The research tool's draft (research/market.ts marketDraftPayload): a deterministic reading of the PAGES it was given. A sentence
  // with a figure becomes a summary fact quoted word for word from its page; the first sentence without one is the thesis, the next
  // ones the conditions and the risks, each naming its page. Nothing is added that a page does not say.
  if (/You answer a market research question from the PAGES/.test(Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("") : String(body.system ?? ""))) {
    calls.push({ kind: "other", user });
    return text(body, JSON.stringify(marketDraft(user)));
  }
  if (/- name: /.test(user)) {
    calls.push({ kind: "draft", user });
    const first = /- name: (\S+)/.exec(user)?.[1] ?? "there", topic = /ASK ABOUT[^\n]*\n- (.+)/.exec(user)?.[1];
    return text(body, `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to ${topic ? `ask about ${topic}` : "hear how you got started"}. Would you be open to a short call?`);
  }
  calls.push({ kind: "other", user });
  return text(body, "Here is what I can tell you.");
}

export function marketDraft(user: string) {
  const pages = [...user.matchAll(/^PAGE \d+\nurl: (\S+)\ntitle: ([^\n]*)\n([\s\S]*?)(?=\n\nPAGE \d+\n|(?![\s\S]))/gm)].map((m) => ({ url: m[1], title: m[2].replace(/^About:\s*/, "").trim(), text: m[3] }));
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => /[.!?]$/.test(x) && x.length >= 12);
  const facts: { text: string; quote: string; url: string }[] = [], readings: { text: string; url: string }[] = [];
  for (const p of pages) for (const x of sentences(p.text)) (/\d/.test(x) ? facts.push({ text: x, quote: x, url: p.url }) : readings.push({ text: x, url: p.url }));
  const [thesis, ...rest] = readings;
  return { title: pages[0]?.title ?? "", thesis: thesis?.text ?? "", summary: facts.slice(0, 5), comparison: null,
    conditions: rest.slice(0, 1).map((r) => ({ text: r.text, urls: [r.url] })), risks: rest.slice(1, 3).map((r) => ({ text: r.text, urls: [r.url] })) };
}
