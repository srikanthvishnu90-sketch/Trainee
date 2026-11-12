// deno-lint-ignore-file no-explicit-any require-await
// D-060 (owner, 2026-11-11, in chat: "Web research"; live spend "Up to $10"): Trainee's web research is on, with sources and caveats
// like Instinct's in the owner's WhatsApp batch 1 (evals/mirror/instinct-wa-batch1/). $0: a stubbed web search on the Anthropic wire,
// a scripted model, a fake web; nothing leaves the process.
//   unit     the gateway's webSearch door (tool, cap, reservation, cost), the web provider (per-turn cap, cache, official first,
//            the never-list), source kinds (Citadel is not Citadel Securities), the reply rules (C9 layout, C22 "median", labels),
//            the posting re-check (only the boards Trainee reads), the release flag and its rollback;
//   handler  the REAL handler (handleChat) on Postgres 16: research is offered only when on; one web search per turn however often
//            the model asks; the reply cites only the sources the search returned, one topic per message with its link on its own
//            line, anecdotes labelled, no invented figure, no "median" a source does not say; the earlier research is recalled
//            from the cache with the same source (C23); "still open?" re-checks a Greenhouse posting live and names Workday as a
//            host Trainee does not read (C18).
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/web-research-d060.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { costMicros, modelConfigFor, TRAINEE_MODEL, WEB_SEARCH_AVAILABLE, WEB_SEARCH_MAX_USES, WEB_SEARCH_TOOL, webSearch } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";
import { claudeWebProvider, memoryWebCache, postingJobId, recheckPosting, sourceKind, webResearchOn, WEB_RESEARCH_SEARCHES, withWebSearch } from "../../supabase/functions/_shared/research_web.ts";
import { enforceMarketReply, messagesLayout, type MarketResult, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { NEVER_SEARCH_DOMAINS } from "../../supabase/functions/_shared/research_never.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });

// ------------------------------------------------------------------------------------------------ the fake web and search
const CITADEL = "https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process";
const CITSEC = "https://www.citadelsecurities.com/careers/career-perspectives/internship-and-new-graduates-engineering-interview-process";
const REDDIT = "https://www.reddit.com/r/cscareerquestions/comments/abc123/citadel_hours";
const LEVELS = "https://www.levels.fyi/companies/citadel/salaries/software-engineer";
const GLASSDOOR = "https://www.glassdoor.com/Interview/Citadel-Software-Engineer-Interview-Questions-EI_IE14937.htm";
const PAGES: Record<string, string> = {
  [CITADEL]: "<html><head><title>Our Campus Engineering Interview Process - Citadel</title></head><body><p>There are four steps in the process. At Citadel, the overall process takes roughly eight weeks from start to finish.</p></body></html>",
};
const PASSAGES: Record<string, { title: string; text: string }> = {
  [CITADEL]: { title: "Our Campus Engineering Interview Process - Citadel", text: "There are four steps in the process." },
  [REDDIT]: { title: "Citadel hours? : cscareerquestions", text: "Anonymous posters describe 70-hour weeks at Citadel." },
  [LEVELS]: { title: "Citadel Software Engineer Salaries", text: "Citadel new grad software engineer total compensation reported at $400,000." },
  [GLASSDOOR]: { title: "Citadel interview questions", text: "Glassdoor text that is never used." },
};
// A web search answer in the shape the live proof recorded (evals/research-live/43069018220).
function searchAnswer(body: any) {
  const cite = (u: string) => ({ type: "text", text: PASSAGES[u].text, citations: [{ type: "web_search_result_location", url: u, title: PASSAGES[u].title, cited_text: PASSAGES[u].text, encrypted_index: "x" }] });
  return { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [CITSEC, REDDIT, LEVELS, CITADEL, GLASSDOOR].map((u) => ({ type: "web_search_result", url: u, title: PASSAGES[u]?.title ?? "Citadel Securities interview process", encrypted_content: "x", page_age: u === LEVELS ? "400 days ago" : null })) },
    cite(CITADEL), cite(REDDIT), cite(LEVELS), cite(GLASSDOOR),
  ], usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } } };
}

// ------------------------------------------------------------------------------------------------ unit
Deno.test("D-060 gateway: the web search door is proven, capped, reserved before it sends, and priced with its search fee", async () => {
  eq([WEB_SEARCH_AVAILABLE, WEB_SEARCH_TOOL, WEB_SEARCH_MAX_USES], [true, "web_search_20250305", 3]);
  let sent = 0;
  const none = await webSearch("Citadel interview process", { request: (async () => { sent++; return new Response("{}"); }) as typeof fetch });
  ok(!none.available && sent === 0, "no config, no key: nothing is reserved or sent");
  ok(!(await webSearch("", { cfg: modelConfigFor(env({ ANTHROPIC_API_KEY: "sk-test-not-real" }), TRAINEE_MODEL) })).available, "no query: nothing sent");
  const bodies: any[] = [];
  const gate = memoryBudgetGate(500_000);
  const r = await webSearch("Citadel new grad interview process", { cfg: modelConfigFor(env({ ANTHROPIC_API_KEY: "sk-test-not-real" }), TRAINEE_MODEL), maxUses: 9, blockedDomains: [...NEVER_SEARCH_DOMAINS], budget: gate,
    request: (async (_u: any, init: any) => { const b = JSON.parse(init.body); bodies.push(b); return Response.json(searchAnswer(b)); }) as typeof fetch });
  ok(r.available, JSON.stringify(r));
  const tool = bodies[0].tools[0];
  eq([tool.type, tool.name, tool.max_uses], ["web_search_20250305", "web_search", 3], "max_uses is capped at 3 whatever the caller asks");
  ok(tool.blocked_domains.includes("linkedin.com") && tool.blocked_domains.includes("glassdoor.com"), "the never-list is handed to the search");
  eq(bodies[0].model, TRAINEE_MODEL, "Sonnet 5.5 only (D-046)");
  if (!r.available) return;
  eq(r.searches, 2);
  eq(r.citations.map((c) => c.url), [CITADEL, REDDIT, LEVELS, GLASSDOOR]);
  eq(r.cost_usd, (9000 * 2 + 300 * 10) / 1e6 + 2 * 0.01, "tokens at Sonnet's price plus $0.01 a search");
  eq(costMicros(TRAINEE_MODEL, { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }), 30_000);
  eq(gate.snapshot().spent, Math.round(r.cost_usd! * 1e6), "the ledger is settled to the proven cost, search fees included");
});

Deno.test("D-060 provider: one web search per turn, cached across turns (the same sources, no new search), official first, never-list out", async () => {
  let calls = 0;
  const search = async () => { calls++; const b = searchAnswer({ model: TRAINEE_MODEL }); return await webSearch("q", { cfg: modelConfigFor(env({ ANTHROPIC_API_KEY: "sk-test-not-real" }), TRAINEE_MODEL), budget: memoryBudgetGate(), request: (async () => Response.json(b)) as typeof fetch }); };
  const cache = memoryWebCache();
  const turn1 = claudeWebProvider({ search, now: () => 1000, cache, companies: ["Citadel"] });
  const a = await turn1.search({ queries: ["Citadel new grad interview process"], companies: ["Citadel"] });
  eq(calls, 1);
  eq(a.hits[0].url, CITADEL, "the employer's own page first");
  ok(!a.hits.some((h) => /glassdoor|linkedin|indeed/.test(h.url)), "the never-list never becomes a hit");
  ok(a.hits.findIndex((h) => h.url === REDDIT) > a.hits.findIndex((h) => h.url === LEVELS), "anecdotes after self-reported data");
  eq(a.passages!.map((p) => p.url).sort(), [CITADEL, LEVELS, REDDIT].sort());
  const again = await turn1.search({ queries: ["Citadel culture"] });
  eq([calls, again.hits.length], [1, 0], "per-turn cap: a second search in the same turn is not made");
  ok(again.notes.some((n) => /already used/.test(n)));
  const turn2 = claudeWebProvider({ search, now: () => 2000, cache });
  const b = await turn2.search({ queries: ["Citadel new grad interview process"] });
  eq([calls, b.searches, b.hits.map((h) => h.url)], [1, 0, a.hits.map((h) => h.url)], "C23: the same question later gets the same sources from the cache, unsearched");
  eq(WEB_RESEARCH_SEARCHES, 2);
  // With the free sources: theirs first, then the web's.
  const free = { id: "first_party" as const, needsKey: false, search: async () => ({ hits: [{ url: "https://www.bls.gov/oes/current/oes151252.htm", title: "BLS", provider: "bls_oes" as const, foundAt: 1 }], notes: [], provider: "first_party", searches: 1 }) };
  const both = await withWebSearch(claudeWebProvider({ search, now: () => 3000 }), free).search({ queries: ["software developer pay"] });
  eq(both.hits[0].url, "https://www.bls.gov/oes/current/oes151252.htm");
});

Deno.test("D-060 source kinds: the employer's own site is official; a similarly named employer is not; forums are anecdotes", () => {
  eq(sourceKind(CITADEL, ["Citadel"]), "official");
  eq(sourceKind(CITSEC, ["Citadel"]), "reported", "Citadel Securities is a different employer");
  eq(sourceKind(REDDIT), "anecdote");
  eq(sourceKind(LEVELS), "self_reported");
  eq(sourceKind("https://www.bls.gov/oes/current/oes151252.htm"), "official");
  eq(sourceKind("https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/x"), "official", "a posting on the employer's ATS");
});

const RES = (o: Partial<Extract<MarketResult, { status: "ok" }>> = {}): MarketResult => ({ status: "ok", format: "inline", asked: "inline", title: "Citadel", thesis: null,
  points: [{ text: "Citadel's process has four steps", cite: [1] }, { text: "Anonymous posters describe 70-hour weeks at Citadel", cite: [2] }, { text: "Citadel new grad total compensation reported at $400,000", cite: [3] }],
  conditions: [], risks: [], comparison: null, file_url: null, dropped: 0, notes: [], searched: "claude_web", note: "", layout: "messages",
  sources: [{ n: 1, url: CITADEL, title: "Citadel", fetched_at: "2026-11-11T00:00:00Z", kind: "official" }, { n: 2, url: REDDIT, title: "reddit", fetched_at: "2026-11-11T00:00:00Z", kind: "anecdote" }, { n: 3, url: LEVELS, title: "levels", fetched_at: "2026-11-11T00:00:00Z", kind: "self_reported" }], ...o } as MarketResult);

Deno.test("D-060 reply rules: one topic per message with its link on its own line (C9); labels; no unsourced median (C22); no invented figure", () => {
  const reply = "Citadel's process has four steps [1].\n\nAnonymous posters describe 70-hour weeks at Citadel, anecdotes rather than proof [2]. The hours there are brutal [2].\n\nSelf-reported total compensation is $400,000, and those reports can lag [3]. The median new grad pay at Citadel is $400,000 [3]. Citadel pays new grads $999,000 [1].";
  const out = enforceMarketReply(reply, RES());
  eq(out, [
    `Citadel's process has four steps.\n${CITADEL}`,
    `Anonymous posters describe 70-hour weeks at Citadel, anecdotes rather than proof.\n${REDDIT}`,
    `Self-reported total compensation is $400,000, and those reports can lag.\n${LEVELS}`,
  ].join("\n\n"));
  ok(!/brutal|median|999/.test(out), "an unlabelled anecdote, an unsourced median and an invented figure are all dropped");
  // A point that itself says median lets the reply say median.
  const med = enforceMarketReply("The median hourly pay is $40 [1].", RES({ points: [{ text: "The median hourly pay is $40", cite: [1] }], sources: [{ n: 1, url: "https://www.bls.gov/x", title: "BLS", fetched_at: "2026-11-11T00:00:00Z", kind: "official" }] }));
  ok(/median hourly pay is \$40/.test(med), med);
  // Without the web layout the reply keeps the numbered sources, and labels the kind of each.
  const plain = enforceMarketReply("Citadel's process has four steps [1].", RES({ layout: undefined }));
  ok(/\[1\] Citadel: https:\/\/www\.citadel\.com/.test(plain) && /\[2\] reddit \(anecdote\)/.test(plain) && /\[3\] levels \(self-reported\)/.test(plain), plain);
  eq(messagesLayout("A [1][2].\n\nB.", RES().status === "ok" ? (RES() as any).sources : []), `A.\n${CITADEL}\n${REDDIT}\n\nB.`);
});

Deno.test("D-060 research: a passage the search quoted stands for a page the reader could not open; the never-list never does", async () => {
  const search = claudeWebProvider({ search: async () => await webSearch("q", { cfg: modelConfigFor(env({ ANTHROPIC_API_KEY: "sk-test-not-real" }), TRAINEE_MODEL), budget: memoryBudgetGate(), request: (async () => Response.json(searchAnswer({ model: TRAINEE_MODEL }))) as typeof fetch }), now: () => 5000 });
  let drafted = "";
  const r = await researchMarket({ question: "what's Citadel like for new grad SWE", format: "inline", plan: { queries: ["Citadel new grad"], companies: ["Citadel"] }, deps: { search, layout: "messages",
    read: async (urls) => ({ verified: urls.filter((u) => PAGES[u]).map((u) => ({ url: u, requested: u, status: 200 as const, title: "Our Campus Engineering Interview Process - Citadel", text: "There are four steps in the process. At Citadel, the overall process takes roughly eight weeks from start to finish.", fetchedAt: 1 })), rejected: urls.filter((u) => !PAGES[u]).map((url) => ({ url, why: "http_status" as const })) }),
    draft: async (p) => { drafted = p.messages[0].content; return JSON.stringify({ title: "Citadel", summary: [
      { text: "At Citadel the overall process takes roughly eight weeks", quote: "At Citadel, the overall process takes roughly eight weeks from start to finish.", url: CITADEL },
      { text: "Anonymous posters describe 70-hour weeks at Citadel", quote: "Anonymous posters describe 70-hour weeks at Citadel.", url: REDDIT },
      { text: "Glassdoor says something", quote: "Glassdoor text that is never used.", url: GLASSDOOR } ] }); } } });
  ok(r.status === "ok", JSON.stringify(r));
  if (r.status !== "ok") return;
  ok(!/glassdoor/i.test(drafted), "a never-list page is never put in front of the model");
  eq(r.points.map((p) => p.text), ["At Citadel the overall process takes roughly eight weeks", "Anonymous posters describe 70-hour weeks at Citadel"]);
  eq(r.sources.map((s) => [s.url, s.kind, s.via ?? "read"]), [[CITADEL, "official", "read"], [REDDIT, "anecdote", "search_passage"]]);
  eq(r.layout, "messages");
  ok(/Official sources first/.test(r.note) && /benchmark, never a median/.test(r.note) && /different employers/.test(r.note) && /same source/.test(r.note), "the note asks for Instinct's process");
});

Deno.test("D-060 C18: a posting is re-checked live only on the boards Trainee reads; any other host is named, not guessed", async () => {
  eq(postingJobId("https://boards.greenhouse.io/paypal/jobs/12345"), { id: "greenhouse:paypal:12345", board: "Greenhouse" });
  eq(postingJobId("https://jobs.lever.co/acme/0f8f8e6a-4349-9d2c-0000-a2000001"), { id: "lever:acme:0f8f8e6a-4349-9d2c-0000-a2000001", board: "Lever" });
  const seen: string[] = [];
  const check = async (j: { job_id?: string }) => { seen.push(String(j.job_id)); return j.job_id === "greenhouse:paypal:12345" ? "live" as const : "dead" as const; };
  eq((await recheckPosting("https://boards.greenhouse.io/paypal/jobs/12345", check, () => 0)).state, "open");
  eq((await recheckPosting("https://boards.greenhouse.io/paypal/jobs/999", check, () => 0)).state, "closed");
  // Architect amendment (D-062): Workday is now a board Trainee reads (the posting's own CXS data, workday_posting.ts), so its
  // link is checked by the same check (never guessed: "closed" here is what the check answered); a host Trainee does not read
  // is still named, never fetched, never guessed.
  const wd = await recheckPosting("https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern_R0138586", check);
  eq([wd.state, (wd as any).board], ["closed", "Workday"]);
  const other = await recheckPosting("https://careers.example.com/jobs/123", check);
  eq([other.state, (other as any).host], ["not_readable", "careers.example.com"]);
  eq(seen, ["greenhouse:paypal:12345", "greenhouse:paypal:999", "workday:paypal.wd1.myworkdayjobs.com:Software-Engineer-Intern_R0138586"], "only the boards Trainee reads were asked");
});

Deno.test("D-060 release: web research is on at the release value and off with CAREER_KNOWLEDGE=off; people search stays off", () => {
  eq(RELEASE_FLAGS.CAREER_KNOWLEDGE, "on");
  ok(webResearchOn(env({})) && !webResearchOn(env({ CAREER_KNOWLEDGE: "off" })));
  // Architect amendment (D-062; owner, 2026-11-11: "find alumni"): people search was approved after D-060, as its own release flag.
  ok(!RELEASE_NEVER_ON.includes("CAREER_PEOPLE_SEARCH") && RELEASE_FLAGS.CAREER_PEOPLE_SEARCH === "on", "people search is D-062's release flag");
});

// ------------------------------------------------------------------------------------------------ the real handler
const PEOPLE: Record<string, string> = { "tok-d060a": "7b0f8f8e-6a43-4a49-9d2c-000000d06001", "tok-d060b": "7b0f8f8e-6a43-4a49-9d2c-000000d06002", "tok-d060c": "7b0f8f8e-6a43-4a49-9d2c-000000d06003" };
const C9 = "what's citadel like for new grad swe, culture pay interview process, give me real sources";
const C23 = "that citadel process from earlier, how long was it again total?";
const GH = "https://boards.greenhouse.io/paypal/jobs/12345";
const WD = "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
type Seen = { tools: string[]; toolResult: string | null; lastUser: string };
const seen: Seen[] = [], webCalls: any[] = [], hosts: string[] = [];
let stage = 0;
const last = (msgs: any[]) => msgs.at(-1);
const scripted = async (body: any): Promise<any> => {
  const msgs: any[] = body.messages ?? [], tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  const system = String(msgs[0]?.role === "system" ? msgs[0].content : "");
  const reply = (message: any) => ({ id: "fake", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
  const call = (name: string, args: unknown) => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  // The market draft (market.ts RULES): points quoted word for word from the pages and passages it was given.
  if (/^You answer a market research question from the PAGES/.test(system)) {
    const text = String(msgs.at(-1)?.content ?? "");
    const pts = [
      { text: "At Citadel the overall process takes roughly eight weeks", quote: "At Citadel, the overall process takes roughly eight weeks from start to finish.", url: CITADEL },
      { text: "Anonymous posters describe 70-hour weeks at Citadel", quote: "Anonymous posters describe 70-hour weeks at Citadel.", url: REDDIT },
      { text: "Citadel new grad software engineer total compensation reported at $400,000", quote: "Citadel new grad software engineer total compensation reported at $400,000.", url: LEVELS },
    ].filter((p) => text.includes(p.url));
    return reply({ role: "assistant", content: JSON.stringify({ title: "Citadel for new grad SWE", summary: pts }) });
  }
  const toolMsgs = msgs.filter((m) => m.role === "tool"), lastUser = String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
  const toolResult = last(msgs)?.role === "tool" ? String(last(msgs).content) : null;
  seen.push({ tools, toolResult, lastUser });
  if (!tools.length) return reply({ role: "assistant", content: "ok" });
  const Q = { question: lastUser, format: "inline", queries: ["Citadel new grad software engineer interview process", "Citadel new grad software engineer pay"], companies: ["Citadel"] };
  if (/still open/i.test(lastUser) && tools.includes("check_posting_open")) {
    if (toolMsgs.length === 0) return call("check_posting_open", { url: GH });
    if (toolMsgs.length === 1) return call("check_posting_open", { url: WD });
    return reply({ role: "assistant", content: "Checked." });
  }
  if (/citadel/i.test(lastUser) && tools.includes("research_market")) {
    // Turn 1 asks twice in one turn (the per-turn cap must hold); C23 asks once with the same queries (the cache answers).
    const wanted = stage === 0 ? 2 : 1;
    if (toolMsgs.length < wanted) return call("research_market", toolMsgs.length === 0 ? Q : { ...Q, queries: ["Citadel culture"] });
    const r = JSON.parse(String(toolMsgs[0].content));
    const n = (u: string) => r.sources.find((s: any) => s.url === u)?.n;
    if (stage === 1) return reply({ role: "assistant", content: `At Citadel the overall process takes roughly eight weeks [${n(CITADEL)}].` });
    return reply({ role: "assistant", content: [
      `At Citadel the overall process takes roughly eight weeks [${n(CITADEL)}].`,
      `Anonymous posters describe 70-hour weeks at Citadel, anecdotes rather than proof [${n(REDDIT)}]. The hours there are brutal [${n(REDDIT)}].`,
      `Self-reported total compensation is $400,000, and those reports can lag [${n(LEVELS)}]. The median new grad pay at Citadel is $400,000 [${n(LEVELS)}]. Citadel pays new grads $999,000 [${n(CITADEL)}].`,
    ].join("\n\n") });
  }
  return reply({ role: "assistant", content: "I can help with that." });
};
async function withHandler(fn: (h: Awaited<ReturnType<typeof careerHandler>>) => Promise<void>, extraEnv: Record<string, string> = {}) {
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_PLANNER", "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "BRAVE_SEARCH_API_KEY", "CAREER_PEOPLE_SEARCH", "CAREER_REPLY_WRITER"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  const realResolve = Deno.resolveDns, realFetch = globalThis.fetch;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of keys) Deno.env.delete(k); // every release flag at its release value (production)
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-d060-not-a-key");
    for (const [k, v] of Object.entries(extraEnv)) Deno.env.set(k, v);
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["203.0.113.20"] : []);
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.hostname === "api.anthropic.com") {
        const body = await req.clone().json();
        if ((body.tools ?? []).some((t: any) => /^web_search_/.test(String(t.type)))) { webCalls.push(body); return Response.json(searchAnswer(body)); }
        return anthropicWire(req, (b) => scripted(b));
      }
      hosts.push(u.hostname);
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      const page = PAGES[req.url.replace(/\/$/, "")];
      return page ? new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    // The flow double refuses every posting-page read (tests/flow/postgrest.ts, E.21); this test's one Greenhouse posting is
    // answered by the fake board above, ahead of the double, so the live re-check has something to read.
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // Architect amendment (D-062): the Workday read is refused (as with no network), never answered by the fake board's 404.
      if (/^https:\/\/[^/]+\.myworkdayjobs\.com\//.test(url)) { hosts.push(`${new URL(url).hostname}${new URL(url).pathname}`); throw new TypeError("network refused: myworkdayjobs.com"); }
      if (/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/paypal\/jobs\/\d+/.test(url)) { hosts.push("boards-api.greenhouse.io"); return /\/12345$/.test(url) ? Response.json({ id: 12345, title: "Software Engineer Intern" }) : new Response("gone", { status: 404 }); }
      return viaDouble(input as any, init);
    }) as typeof fetch;
    await fn(handler);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    (Deno as any).resolveDns = realResolve;
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
}
const canRun = () => {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return false; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return false; }
  return true;
};

Deno.test({ name: "D-060 at the real handler: research with sources, one search a turn, Instinct's layout and labels, recall from the cache, the posting re-check", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!canRun()) return;
  await withHandler(async (h) => {
    const chat = h.chat("tok-d060a");
    stage = 0; seen.length = 0; webCalls.length = 0;
    const r = await chat.say(C9);
    eq(r.status, 200, r.reply);
    eq(r.body.meta.brain, "staged", r.reply);
    const offered = seen.find((s) => s.tools.length)?.tools ?? [];
    ok(offered.includes("research_market") && offered.includes("research_career_question") && offered.includes("check_posting_open"), `research is offered with web research on: ${offered.join(",")}`);
    eq(webCalls.length, 1, "one web search call in the turn, though the model asked for research twice");
    ok(webCalls[0].tools[0].max_uses <= 2 && webCalls[0].tools[0].type === "web_search_20250305", JSON.stringify(webCalls[0].tools));
    ok(seen.some((s) => s.toolResult && /already used/.test(s.toolResult)), "the second ask in the turn is told the search was used");
    // C9: each topic its own message, its link alone on the next line; only the search's sources; labels kept, the rest dropped.
    ok(r.reply.includes(`roughly eight weeks.\n${CITADEL}`), r.reply);
    ok(r.reply.includes(`anecdotes rather than proof.\n${REDDIT}`), r.reply);
    ok(r.reply.includes(`can lag.\n${LEVELS}`), r.reply);
    ok(!/brutal|median|999/i.test(r.reply), `no unlabelled anecdote, unsourced median or invented figure: ${r.reply}`);
    const links = [...r.reply.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
    ok(links.every((l) => [CITADEL, REDDIT, LEVELS].includes(l)), `every link is a source the search returned: ${links.join(" ")}`);
    ok(!/glassdoor/i.test(r.reply), "the never-list is never shown");
    ok(!hosts.includes("www.glassdoor.com"), "a never-list page is never fetched");
    // C23: the earlier research again, from the cache, with the same source; no new search.
    stage = 1;
    const r2 = await chat.say(C23);
    eq(r2.status, 200, r2.reply);
    eq(webCalls.length, 1, "C23 is answered from the cached search: no new web search");
    ok(r2.reply.includes(`roughly eight weeks.\n${CITADEL}`) || (r2.reply.includes("eight weeks") && r2.reply.includes(CITADEL)), `C23 recalls with the same source: ${r2.reply}`);
    // C18: Greenhouse checked live. Architect amendment (D-062): Workday is read now (its posting's CXS data); with the read
    // refused here it is "not known", never called open or closed, and the one request was that posting's own read.
    const r3 = await chat.say(`is that paypal internship posting still open? check rn ${GH}`);
    eq(r3.status, 200, r3.reply);
    const checks = seen.filter((s) => s.toolResult && /"state"/.test(s.toolResult)).map((s) => JSON.parse(s.toolResult!));
    eq(checks.map((c) => c.state), ["open", "unknown"], JSON.stringify(checks));
    ok(/did not finish/.test(checks[1].note) && /Do not guess/.test(checks[1].note), checks[1].note);
    eq(hosts.filter((x) => /myworkdayjobs/.test(x)), ["paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586",
      "paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586"], "Workday reads: that posting's own data, then its public page; nothing else");
  });
} });

Deno.test({ name: "D-060 at the real handler: with CAREER_KNOWLEDGE=off no web search is made and no web research tool is offered", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!canRun()) return;
  await withHandler(async (h) => {
    stage = 0; seen.length = 0; webCalls.length = 0;
    const r = await h.chat("tok-d060b").say(C9);
    eq(r.status, 200, r.reply);
    eq(webCalls.length, 0, "no web search with the rollback");
    const offered = new Set(seen.flatMap((s) => s.tools));
    ok(!offered.has("research_career_question") && !offered.has("check_posting_open"), [...offered].join(","));
    ok(!r.reply.includes(REDDIT) && !r.reply.includes(LEVELS), `no web source without the web search: ${r.reply}`);
  }, { CAREER_KNOWLEDGE: "off" });
} });
