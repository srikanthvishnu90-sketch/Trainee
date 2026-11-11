// D-060 live proof of Claude's web_search server tool through the gateway's one door (`webSearch`, _shared/model_gateway.ts).
// It makes at most WEB_PROOF_SEARCHES real searches (one call per query, max_uses 1), with an in-process hard cap of --budget-usd
// (at most $0.50) on top of the shared $70 ledger reservation the workflow makes first (.github/workflows/research-live.yml).
// It records exactly what came back (the result pages, the cited passages, the usage and the cost) and says whether the tool is
// proven: every call answered, searched at least once, and returned at least one result page and one cited passage.
// Nothing is sent to anyone: the only host is the model API.
//
//   WEB_RESEARCH_SPEND_APPROVED=D-060 ANTHROPIC_API_KEY=... deno run -A --no-check evals/research-live/run.ts --live --budget-usd 0.5 --out <dir>
//   deno run -A --no-check evals/research-live/run.ts --dry-run --out <dir>     (a scripted provider answer, $0)
import { costMicros, modelConfigFor, TRAINEE_MODEL, webSearch, type WebSearchResult } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";

export const WEB_PROOF_QUERIES = [
  "Citadel new grad software engineer interview process (official Citadel careers page)",
  "Chicago software engineer intern hourly pay 2026",
];
export const WEB_PROOF_SEARCHES = 2; // at most 3 (D-060 proof); one search per query
export const WEB_PROOF_MAX_USD = 0.5;

const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const live = a.includes("--live"), dry = a.includes("--dry-run");
const out = opt("--out");
const budget = Number(opt("--budget-usd") ?? (dry ? WEB_PROOF_MAX_USD : 0));
if (live === dry || !out) { console.log("usage: run.ts --live --budget-usd <=0.5 --out <dir> | --dry-run --out <dir>"); Deno.exit(2); }
if (!(budget > 0 && budget <= WEB_PROOF_MAX_USD)) { console.log(`refused: --budget-usd must be above 0 and at most ${WEB_PROOF_MAX_USD}`); Deno.exit(3); }
if (live && !/^D-\d{3}[a-z]?$/.test(Deno.env.get("WEB_RESEARCH_SPEND_APPROVED") ?? "")) { console.log("refused: --live needs WEB_RESEARCH_SPEND_APPROVED=<the DECISIONS.md line>"); Deno.exit(3); }
if (live && !Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }

// Dry run: a provider answer in the documented shape, so the recorder and the verdict are tested at $0.
const scripted: typeof fetch = async (_u, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const q = body.messages?.[0]?.content?.[0]?.text ?? "";
  return Response.json({ id: "dry", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [
    { type: "server_tool_use", id: "srvtoolu_dry", name: "web_search", input: { query: q } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_dry", content: [{ type: "web_search_result", url: "https://example.org/dry", title: "Dry run page", encrypted_content: "x", page_age: "November 1, 2026" }] },
    { type: "text", text: "A dry-run passage.", citations: [{ type: "web_search_result_location", url: "https://example.org/dry", title: "Dry run page", cited_text: "A dry-run passage.", encrypted_index: "x" }] },
  ], usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 1 } } });
};

const cfg = modelConfigFor({ get: (k) => (k === "ANTHROPIC_API_KEY" ? (dry ? "sk-test-not-real" : Deno.env.get(k)) : k === "ANTHROPIC_EFFORT" ? "low" : undefined) }, TRAINEE_MODEL);
const gate = memoryBudgetGate(Math.round(budget * 1e6));
// The request may narrow the run (a later proof call): its queries (at most WEB_PROOF_SEARCHES) and the tool version.
const req = (() => { try { return JSON.parse(Deno.readTextFileSync(new URL("./run-request.json", import.meta.url))); } catch { return {}; } })();
const queries: string[] = Array.isArray(req.queries) && req.queries.length ? req.queries.map(String) : WEB_PROOF_QUERIES;
const toolVersion = req.tool === "web_search_20250305" ? "web_search_20250305" as const : "web_search_20260209" as const;
const rows: (WebSearchResult & { ms: number; asked: string })[] = [];
let spent = 0, searches = 0;
for (const q of queries.slice(0, WEB_PROOF_SEARCHES)) {
  if (spent >= budget) { console.log(`stopped: budget reached ($${spent.toFixed(4)} of $${budget})`); break; }
  const t0 = performance.now();
  const r = await webSearch(q, { tool: toolVersion, cfg, maxUses: 1, budget: gate, request: dry ? scripted : undefined });
  const ms = Math.round(performance.now() - t0);
  rows.push({ ...r, ms, asked: q });
  if (r.available) { searches += r.searches; spent += r.cost_usd ?? 0; }
  console.log(`${q}\n  -> ${r.available ? `${r.searches} search(es), ${r.results.length} result page(s), ${r.citations.length} cited passage(s), $${(r.cost_usd ?? NaN).toFixed(4)}, ${ms} ms, stop ${r.stop_reason}, shape ${r.shape.join(" ")}${r.errors.length ? `, errors ${r.errors.join(",")}` : ""}` : `NOT AVAILABLE (${r.reason}): ${r.detail}`}`);
  if (r.available) for (const c of r.citations.slice(0, 4)) console.log(`     cited ${c.url}: "${c.cited_text.slice(0, 140)}"`);
}
const problems: string[] = [];
for (const r of rows) {
  if (!r.available) problems.push(`"${r.asked}": the API did not answer the search (${r.reason}: ${r.detail})`);
  else {
    if (r.searches < 1) problems.push(`"${r.asked}": no search was made (usage.server_tool_use.web_search_requests is 0)`);
    if (!r.results.length) problems.push(`"${r.asked}": no result pages came back${r.errors.length ? ` (${r.errors.join(", ")})` : ""}`);
    if (!r.citations.length) problems.push(`"${r.asked}": no cited passage came back`);
    if (r.cost_usd === null) problems.push(`"${r.asked}": the cost could not be computed from the usage block`);
  }
}
if (!rows.length) problems.push("no call was made");
const verdict = problems.length ? "not_proven" : "proven";
const record = { kind: "research-live", approval: Deno.env.get("WEB_RESEARCH_SPEND_APPROVED") ?? null, mode: dry ? "dry" : "live", model: cfg.model, tool: toolVersion,
  run_id: Deno.env.get("GITHUB_RUN_ID") ?? null, sha: Deno.env.get("GITHUB_SHA") ?? null, at: new Date().toISOString(), budget_usd: budget,
  searches, spent_usd: Number(spent.toFixed(6)), verdict, problems,
  calls: rows.map((r) => r.available ? { query: r.asked, ms: r.ms, searches: r.searches, cost_usd: r.cost_usd, cost_check_usd: (costMicros(cfg.model, r.usage) ?? 0) / 1e6, stop_reason: r.stop_reason, shape: r.shape, errors: r.errors, usage: r.usage, results: r.results, citations: r.citations, answer: r.answer }
    : { query: r.asked, ms: r.ms, available: false, reason: r.reason, detail: r.detail }) };
await Deno.mkdir(out, { recursive: true });
await Deno.writeTextFile(`${out}/result.json`, JSON.stringify(record, null, 2) + "\n");
console.log(`verdict=${verdict} searches=${searches} spent_usd=${spent.toFixed(6)}${problems.length ? `\n${problems.join("\n")}` : ""}`);
if (verdict !== "proven") Deno.exit(1);
