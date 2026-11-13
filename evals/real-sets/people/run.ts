// REAL SET, item 5 (finding people; VERIFICATION-15 "The 95% bars", D-068): 20 real public asks (queries.json: a real school x
// real employers, a fictional asker) through the brain's find_people tool (agent/capability_tools.ts capabilityTools, wired as
// handler-career.ts wires `people`), which calls career_alumni_search.ts searcher -> leadsFrom (the lead guard) and the reply
// guard enforcePeopleReply.
//
//   (default)  $0. The web search is model spend and this environment reaches no search engine, and a real search answer would
//              put real people's names in the repository, so the search answer is SCRIPTED: per ask, one answer in the exact shape
//              model_gateway.ts webSearch returns (results, word-for-word cited passages, the model's JSON), carrying FICTIONAL people
//              on reserved example.* hosts and 8 proposals a faithful guard must sort:
//                L1  name, employer and school all in the page's quoted passage            -> kept, school shown
//                L2  name and employer in the passage, school not                          -> kept, school "not shown"
//                D1  the name only in the model's JSON, not in the passage                 -> dropped
//                D2  the employer not in the passage                                       -> dropped
//                D3  a LinkedIn page                                                       -> dropped (never-list)
//                D4  a url that is not one of the search's results                         -> dropped
//                D5  an email address as the name                                          -> dropped
//                D6  an employer the person did not ask about                              -> dropped
//              Checked per ask: the tool ran one search with LinkedIn and Indeed blocked; exactly L1 and L2 kept (L1 first); every kept
//              lead's name and employer are in its own excerpt or title; every lead verified:false and the caveat on the result;
//              contacted "nobody" and the tool's effect is "read"; a reply that left the caveat and "Nobody was contacted." out
//              gets both from enforcePeopleReply. Bar: >= 95% of asks pass every check. This measures the code's guard on real
//              asks; it is not a measurement of what a live search finds (that is --live).
//   --live     the paid run (NOT made here): the same 20 asks with the real web search (D-060, Claude's web_search tool) and the
//              same tool. Refused unless PEOPLE_SEARCH_SPEND_APPROVED=<a DECISIONS.md line> and ANTHROPIC_API_KEY are set; capped
//              by --budget-usd (at most 3). It stores, per ask, counts and the guard's checks, with every name replaced by the first
//              8 hex of its sha256: no real name is written. Quote: README.md.
//
//   deno run -A --no-check evals/real-sets/people/run.ts [--live --budget-usd 2.5]
// deno-lint-ignore-file no-explicit-any require-await
import { capabilityTools } from "../../../supabase/functions/_shared/agent/capability_tools.ts";
import { CAVEAT, enforcePeopleReply, type PeopleSearchFn } from "../../../supabase/functions/_shared/career_alumni_search.ts";

const HERE = new URL(".", import.meta.url).pathname;
interface Q { id: string; school: string; employers: string[]; count: number; ask: string }
const QUERIES: Q[] = JSON.parse(await Deno.readTextFile(`${HERE}queries.json`)).queries;
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const live = a.includes("--live");

const FIRST = ["Avery", "Quinn", "Rowan", "Sasha", "Emerson", "Harper", "Indigo", "Jules"], LAST = ["Fixture", "Placeholder", "Sampleton", "Testwood", "Mockford", "Stubley", "Demoray", "Dummitt"];
function scriptedAnswer(q: Q, i: number) {
  const nm = (k: number) => `${FIRST[(i + k) % 8]} ${LAST[(i * 3 + k) % 8]}`;
  const emp = q.employers[0], other = "Initech Example";
  const host = (k: number) => `https://alumni.example.edu/${q.id.toLowerCase()}/news-${k}`;
  const results = [1, 2, 3, 4, 6].map((k) => ({ url: host(k), title: `Alumni news ${k}`, page_age: k === 1 ? "March 3, 2026" : null }));
  results.push({ url: "https://www.linkedin.com/in/fictional-profile", title: `${nm(4)} - ${emp}`, page_age: null });
  const citations = [
    { url: host(1), title: "Alumni news 1", cited_text: `${nm(0)}, who graduated from ${q.school}, is a software engineer at ${emp}.` },
    { url: host(2), title: "Alumni news 2", cited_text: `${nm(1)} works on the payments team at ${emp}.` },
    { url: host(3), title: "Alumni news 3", cited_text: `A panel of ${q.school} graduates spoke about careers at ${emp}.` },
    { url: host(4), title: "Alumni news 4", cited_text: `${nm(3)} spoke at the ${q.school} career fair.` },
    { url: "https://www.linkedin.com/in/fictional-profile", title: `${nm(4)} - ${emp}`, cited_text: `${nm(4)} at ${emp}, ${q.school}.` },
    { url: host(6), title: "Alumni news 6", cited_text: `${nm(6)}, a ${q.school} alumnus, is an analyst at ${other}.` },
  ];
  const proposals = [
    { tag: "L1", name: nm(0), role: "software engineer", employer: emp, school: q.school, url: host(1) },
    { tag: "L2", name: nm(1), role: "", employer: emp, school: "", url: host(2) },
    { tag: "D1", name: nm(2), role: "", employer: emp, school: q.school, url: host(3) },
    { tag: "D2", name: nm(3), role: "", employer: emp, school: q.school, url: host(4) },
    { tag: "D3", name: nm(4), role: "", employer: emp, school: q.school, url: "https://www.linkedin.com/in/fictional-profile" },
    { tag: "D4", name: nm(5), role: "", employer: emp, school: q.school, url: `https://alumni.example.edu/${q.id.toLowerCase()}/never-returned` },
    { tag: "D5", name: `${nm(0).split(" ")[0].toLowerCase()}@example.com`, role: "", employer: emp, school: "", url: host(1) },
    { tag: "D6", name: nm(6), role: "analyst", employer: other, school: q.school, url: host(6) },
  ];
  const json = JSON.stringify(proposals.map(({ tag: _t, ...p }) => p));
  return { proposals, result: { available: true, query: "", results, citations, answer: `Here is what the pages say.\n${json}`, searches: 2, errors: [], cost_usd: 0, usage: {}, stop_reason: "end_turn", shape: [] } as any };
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
const inText = (text: string, phrase: string) => fold(phrase).split(" ").filter((w) => w.length >= 2).every((w) => ` ${fold(text)} `.includes(` ${w} `));
const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");

async function runOne(q: Q, search: PeopleSearchFn, expect: { kept: string[] } | null) {
  const calls: { blocked: string[] }[] = [];
  const wrapped: PeopleSearchFn = async (query, o) => { calls.push({ blocked: o.blockedDomains }); return await search(query, o); };
  const tools = capabilityTools({ mail: null, tracking: false, accounts: null, cursor: null, readNow: null, connectUrl: "", situation: null, snapshot: null, files: null, people: { on: true, search: wrapped, cache: new Map() } } as any);
  const tool: any = tools.find((t: any) => t.name === "find_people");
  const r: any = await tool.run({ school: q.school, employers: q.employers, count: q.count }, { userId: "00000000-0000-4000-8000-00000000a1e7" } as any);
  const leads: any[] = r.leads ?? [];
  const notes: string[] = [];
  const oneSearch = calls.length === 1 && ["linkedin.com", "indeed.com"].every((d) => calls[0].blocked.includes(d));
  if (!oneSearch) notes.push(`searches ${calls.length}, blocked ${calls[0]?.blocked?.join(",")}`);
  const guard = leads.every((l) => inText(`${l.title} ${l.excerpt}`, l.name) && inText(`${l.title} ${l.excerpt}`, l.employer) && /^https:\/\//.test(l.url) && !/linkedin|indeed/.test(l.url));
  if (!guard) notes.push("a kept lead's name or employer is not in its own excerpt");
  const caveat = leads.every((l) => l.verified === false) && (r.status !== "ok" || r.caveat === CAVEAT);
  if (!caveat) notes.push("a lead without the caveat");
  const nobody = r.contacted === "nobody" && tool.effect === "read";
  const reply = enforcePeopleReply(leads.map((l, i) => `${i + 1}. ${l.name}, ${l.employer}`).join("\n") || "No one found.", r);
  const replyOk = /nobody was contacted/i.test(reply) && (r.status !== "ok" || /not verified/i.test(reply));
  if (!nobody || !replyOk) notes.push(`contacted ${r.contacted}, effect ${tool.effect}, reply guard ${replyOk}`);
  let sorted = true;
  if (expect) {
    const got = leads.map((l) => l.name);
    sorted = JSON.stringify(got) === JSON.stringify(expect.kept) && leads[0]?.school_match === "shown" && leads[1]?.school_match === "not shown";
    if (!sorted) notes.push(`kept ${JSON.stringify(got)}, expected ${JSON.stringify(expect.kept)}`);
  }
  const checks = { one_search: oneSearch, guard, caveat, nobody_contacted: nobody && replyOk, sorted };
  return { id: q.id, status: r.status, kept: leads.length, dropped: r.dropped ?? 0, school_shown: leads.filter((l) => l.school_match === "shown").length, leads, checks, notes, pass: Object.values(checks).every(Boolean) };
}

if (live) {
  const approval = Deno.env.get("PEOPLE_SEARCH_SPEND_APPROVED") ?? "", budget = Number(opt("--budget-usd") ?? 0);
  if (!/^D-\d{3}[a-z]?$/.test(approval)) { console.log("refused: --live is model spend (web search); it needs PEOPLE_SEARCH_SPEND_APPROVED=<the DECISIONS.md line> (quote: README.md)"); Deno.exit(3); }
  if (!Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }
  if (!(budget > 0 && budget <= 3)) { console.log("refused: --budget-usd must be above 0 and at most 3"); Deno.exit(3); }
  // The shared $80 ledger: the cap is reserved before the first model call, settled at the end (eval_budget.ts openLiveRunLedger).
  const bud = await import("../../../supabase/functions/_shared/model_budget.ts");
  const { openLiveRunLedger } = await import("../../career/eval_budget.ts");
  const ledger = await openLiveRunLedger({ budgetUsd: budget, approval, get: (k) => Deno.env.get(k), bud });
  if ("error" in ledger) { console.log(`refused: ${ledger.error}`); Deno.exit(3); }
  const { modelConfigFor, TRAINEE_MODEL, webSearch } = await import("../../../supabase/functions/_shared/model_gateway.ts");
  const cfg = modelConfigFor({ get: (k: string) => Deno.env.get(k) }, TRAINEE_MODEL);
  const gate = bud.memoryBudgetGate(Math.round(budget * 1e6));
  const rows: any[] = [];
  let spent = 0;
  try {
  for (const q of QUERIES) {
    const r = await runOne(q, async (query, w) => { const x: any = await webSearch(query, { cfg, budget: gate, ...w }); spent += x.cost_usd ?? 0; return x; }, null);
    rows.push({ ...r, leads: await Promise.all(r.leads.map(async (l: any) => ({ name: await hash(l.name), employer: l.employer, school_match: l.school_match, host: new URL(l.url).hostname, page_age: l.page_age }))) });
    console.log(`${q.id}: ${r.status}, kept ${r.kept}, dropped ${r.dropped}, ${r.pass ? "pass" : r.notes.join("; ")}`);
  }
  // The run's metered cost is the gate's own count (every reservation settled to the provider's usage, web searches included).
  const metered = Math.max(spent, gate.snapshot().spent / 1e6);
  const dir = Deno.env.get("REAL_SET_OUT") ?? `${HERE}results/live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await Deno.mkdir(dir, { recursive: true });
  const n = QUERIES.length, pass = rows.filter((r) => r.pass).length, bar = Math.ceil(n * 0.95);
  const per = ["one_search", "guard", "caveat", "nobody_contacted"].map((k) => `${k} ${rows.filter((r: any) => r.checks[k]).length}/${n}`).join(", ");
  const line = `REAL-SET PEOPLE LIVE (Claude web search, the real find_people tool and guard): ${rows.length}/${n} asks run; asks with at least one lead ${rows.filter((r) => r.kept > 0).length}/${n}; leads kept ${rows.reduce((s, r) => s + r.kept, 0)} (school shown ${rows.reduce((s, r) => s + r.school_shown, 0)}), dropped ${rows.reduce((s, r) => s + r.dropped, 0)}; ${per}; PASS ${pass}/${n} (bar ${bar}/${n}) ${pass >= bar ? "MEETS" : "BELOW"}`;
  await Deno.writeTextFile(`${dir}/results.json`, JSON.stringify({ approval, budget_usd: budget, spent_usd: Number(metered.toFixed(4)), line, note: "names are sha256 prefixes; no real name is stored", rows }, null, 1) + "\n");
  console.log(line);
  console.log(`REAL-SET PEOPLE LIVE spent_usd=${metered.toFixed(4)} -> ${dir}`);
  } finally { await ledger.settle(Math.max(spent, gate.snapshot().spent / 1e6)); }
  Deno.exit(0);
}

const results: any[] = [];
for (const [i, q] of QUERIES.entries()) {
  const s = scriptedAnswer(q, i);
  const keep = s.proposals.filter((p) => p.tag === "L1" || p.tag === "L2").map((p) => p.name);
  results.push(await runOne(q, async () => s.result, { kept: keep }));
}
const n = results.length, pass = results.filter((r) => r.pass).length, bar = Math.ceil(n * 0.95);
const per = ["one_search", "guard", "caveat", "nobody_contacted", "sorted"].map((k) => `${k} ${results.filter((r: any) => r.checks[k]).length}/${n}`).join(", ");
const line = `REAL-SET PEOPLE ($0, scripted search answers with fictional people): ${n} real school x employer asks; leads kept ${results.reduce((s, r) => s + r.kept, 0)} (expected ${2 * n}), dropped ${results.reduce((s, r) => s + r.dropped, 0)} (expected ${6 * n}); ${per}; PASS ${pass}/${n} (bar ${bar}/${n}) ${pass >= bar ? "MEETS" : "BELOW"}`;
for (const r of results) if (!r.pass) console.log(`FAIL ${r.id}: ${r.notes.join("; ")}`);
await Deno.mkdir(`${HERE}results`, { recursive: true });
await Deno.writeTextFile(`${HERE}results/latest.json`, JSON.stringify({ at: new Date().toISOString(), line, results }, null, 1) + "\n");
console.log(line);
Deno.exit(pass >= bar ? 0 : 1);
