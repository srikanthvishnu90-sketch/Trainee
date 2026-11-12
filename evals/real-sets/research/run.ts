// REAL SET, item 10 (research before an interview; VERIFICATION-15 "The 95% bars", D-068): 20 real companies (cases.json), run
// through the product's company research (agent/research/company.ts researchCompany) on what the product's own free search and
// reader returned from the live public web, recorded once per case.
//
//   --capture   the product's free provider and free reader (research_free_sources.ts freeResearchFor, the code the chat uses
//               with no key) run once per case over the real network: public GETs only (robots.txt honoured, the never-list
//               applied, its own user agent), no model. What they returned (the search's hits, notes and gaps; the reader's
//               verified pages and its refusals with why) is stored in recorded/<id>.json. Nothing else is stored.
//   (default)   $0: replays the recordings. The draft is a scripted model (the model only drafts; code decides what stands):
//               per case it proposes up to 3 lines copied word for word from the fetched pages, plus 4 planted lines that a
//               faithful guard must drop (a figure no page has, a page that was never fetched, a date the page does not carry,
//               a competitor its quote does not name). Checked per case, all by code:
//                 sources    every source the brief lists is a page the reader fetched (status 200, https, fetched_at set)
//                 cited      every kept line cites a listed source, and its text is on that page
//                 invented   0 planted lines kept
//                 unread     every page the reader could not open is named with why (or the case has none)
//                 entity     every job-board source the brief cites is the company's own board (cases.json `board`)
//                 brief      the result is a brief (status ok) with at least one kept line; "no_sources" is honest but no brief
//               Bar: >= 95% of cases pass all six.
//   --live      the paid run (NOT made here): the same 20 asks with Claude's web search (D-060) added to the free sources and the
//               real model drafting, wired as handler-career.ts wires `market` with web research on. Refused unless
//               WEB_RESEARCH_SPEND_APPROVED=<a DECISIONS.md line> and ANTHROPIC_API_KEY are set, and capped by --budget-usd
//               (at most 5). Quote: README.md.
//
//   deno run -A --no-check evals/real-sets/research/run.ts [--capture | --live --budget-usd 5]
// deno-lint-ignore-file no-explicit-any require-await
import { researchCompany } from "../../../supabase/functions/_shared/agent/research/company.ts";
import { RESEARCH_DRAFT_MAX_TOKENS } from "../../../supabase/functions/_shared/agent/research/draft_json.ts";
import { freeProvider, freeReader, freeResearchFor } from "../../../supabase/functions/_shared/research_free_sources.ts";
import { normalizeUrl } from "../../../supabase/functions/_shared/research_sources.ts";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 12, 15);
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const mode = a.includes("--capture") ? "capture" : a.includes("--live") ? "live" : "replay";
interface Case { id: string; company: string; site: string; role: string; board: string }
const CASES: Case[] = JSON.parse(await Deno.readTextFile(`${HERE}cases.json`)).cases;
const question = (c: Case) => `Research ${c.company} before my interview for the ${c.role} role. I want the company, business model, recent developments and what I should ask.`;
const planOf = (c: Case) => ({ queries: [c.company, `${c.company} ${c.role}`], companies: [c.company], sites: [c.site] });
const env = { get: (k: string) => k === "RESEARCH_USER_AGENT" ? "TraineeBot/1.0 (+https://trainee.chat/bot) measurement set, read-only" : undefined };

const STAND_IN = "8.8.8.8";
if (mode === "capture") {
  await Deno.mkdir(`${HERE}recorded`, { recursive: true });
  for (const c of CASES) {
    // This build environment has no DNS (outbound HTTPS goes only through its proxy; Deno.resolveDns answers NotFound for every
    // name), so the reader's address check is given a stand-in resolver: every name "resolves" to STAND_IN, a public address,
    // the same before and after each hop. Everything else is the reader as shipped: https only, the never-list, private names,
    // robots.txt, redirects, size caps, conversion. The bytes come from the real hosts through the proxy. Production resolves
    // for real (research_dns.ts systemResolver). Each recording says so (`resolver`).
    const ua = env.get("RESEARCH_USER_AGENT")!;
    const deps = { search: freeProvider({ fetch, now: () => NOW, userAgent: ua }), read: freeReader({ fetch, userAgent: ua, now: () => NOW, resolver: async () => [STAND_IN] }) };
    const at = new Date().toISOString();
    const search = await deps.search.search(planOf(c));
    const read = search.hits.length ? await deps.read(search.hits.map((h) => h.url)) : { verified: [], rejected: [] };
    await Deno.writeTextFile(`${HERE}recorded/${c.id}.json`, JSON.stringify({ case: c, plan: planOf(c), captured_at: at, how: "research_free_sources.ts freeProvider + freeReader (the pair freeResearchFor builds), real network through this environment's proxy", resolver: `stand-in: every host -> ${STAND_IN} (no DNS in this environment)`, search, read }, null, 1) + "\n");
    console.log(`${c.id} ${c.company}: hits ${search.hits.length} (${[...new Set(search.hits.map((h) => h.provider))].join(", ")}), read ${read.verified.length}, refused ${read.rejected.length} (${[...new Set(read.rejected.map((r: any) => r.why))].join(", ")})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  Deno.exit(0);
}

if (mode === "live") {
  const approval = Deno.env.get("WEB_RESEARCH_SPEND_APPROVED") ?? "", budget = Number(opt("--budget-usd") ?? 0);
  if (!/^D-\d{3}[a-z]?$/.test(approval)) { console.log("refused: --live is model spend; it needs WEB_RESEARCH_SPEND_APPROVED=<the DECISIONS.md line> (quote: README.md)"); Deno.exit(3); }
  if (!Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }
  if (!(budget > 0 && budget <= 5)) { console.log("refused: --budget-usd must be above 0 and at most 5"); Deno.exit(3); }
  const { callModel, modelConfigFor, TRAINEE_MODEL, webSearch } = await import("../../../supabase/functions/_shared/model_gateway.ts");
  const { memoryBudgetGate } = await import("../../../supabase/functions/_shared/model_budget.ts");
  const { claudeWebProvider, withWebSearch } = await import("../../../supabase/functions/_shared/research_web.ts");
  const cfg = modelConfigFor({ get: (k: string) => Deno.env.get(k) }, TRAINEE_MODEL);
  const gate = memoryBudgetGate(Math.round(budget * 1e6));
  const out: any[] = [], scored: any[] = [];
  for (const c of CASES) {
    const free = freeResearchFor(env, fetch);
    const search = withWebSearch(claudeWebProvider({ search: (q: string, w: any) => webSearch(q, { cfg, budget: gate, ...w }), now: Date.now }), free.search);
    const draft = async (p: any) => { const r = await callModel(cfg, { system: p.system, messages: p.messages.map((m: any) => ({ role: m.role, content: [{ type: "text", text: m.content }] })), max_tokens: RESEARCH_DRAFT_MAX_TOKENS }, { budget: gate, role: "chat" } as any); return (r.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""); };
    // What the reader returned this run, kept so the brief is scored against the pages it actually stood on.
    const reads: any[] = [];
    const read = async (urls: string[]) => { const r = await free.read(urls); reads.push(r); return r; };
    let r: any;
    try { r = await researchCompany({ company: c.company, role: c.role, question: question(c), plan: planOf(c), deps: { search, read, draft }, now: Date.now(), format: "inline" } as any); }
    catch (e) { r = { status: "error", blocker: String((e as Error).message ?? e).slice(0, 300) }; }
    const s = scoreLive(c, r, reads);
    out.push({ case: c, result: r, read: { verified: reads.flatMap((x) => x.verified ?? []).map((v: any) => ({ url: v.url, status: v.status, fetched_at: v.fetchedAt ?? v.fetched_at ?? null, chars: String(v.text ?? "").length })), rejected: reads.flatMap((x) => x.rejected ?? []) } });
    scored.push(s);
    const spentNow = gate.snapshot().spent / 1e6;
    console.log(`${c.id} ${c.company}: ${r.status}, kept ${s.kept}, ${s.pass ? "pass" : `FAIL ${s.notes.join("; ")}`} ($${spentNow.toFixed(4)} so far)`);
    if (r.status === "error" && /limit|budget/i.test(String(r.blocker))) { console.log(`stopped: the cap $${budget} was reached at ${c.id}`); break; }
  }
  const spent = gate.snapshot().spent / 1e6, n = CASES.length, pass = scored.filter((x) => x.pass).length, bar = Math.ceil(n * 0.95);
  const per = ["sources", "cited", "invented", "unread", "entity", "brief"].map((k) => `${k} ${scored.filter((x: any) => x.checks[k]).length}/${n}`).join(", ");
  const line = `REAL-SET RESEARCH LIVE (real model drafting, Claude web search + the free sources, live web): ${scored.length}/${n} cases run; ${per}; PASS ${pass}/${n} (bar ${bar}/${n}) ${pass >= bar ? "MEETS" : "BELOW"}`;
  const dir = Deno.env.get("REAL_SET_OUT") ?? `${HERE}results/live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/results.json`, JSON.stringify({ approval, budget_usd: budget, spent_usd: Number(spent.toFixed(4)), line, scored, out }, null, 1) + "\n");
  console.log(line);
  console.log(`REAL-SET RESEARCH LIVE spent_usd=${spent.toFixed(4)} -> ${dir}`);
  Deno.exit(0);
}

// The live checks: the replay's six, scored on the pages this run's reader returned. A live draft is the model's own sentence (code
// keeps it only when its quote is on its page and the claim says what the quote says), so "cited" here is independent of the
// product's guard: every kept line cites a listed source, every figure in it is on a cited page, and at least 60% of its content
// words (first five letters) are on the cited pages. "invented" is 0 kept lines with a figure no cited page has.
function scoreLive(c: Case, r: any, reads: any[]) {
  const fetched = new Map<string, any>(reads.flatMap((x) => x.verified ?? []).map((v: any) => [normalizeUrl(v.url), v]));
  const notes: string[] = [];
  const ok = r.status === "ok";
  const kept: any[] = ok ? [...(r.frame ? [r.frame] : []), ...(r.business ?? []), ...(r.developments ?? []), ...(r.competitors ?? []), ...(r.role_asks ?? []), ...(r.questions ?? [])] : [];
  const pageOf = (n: number) => { const s = (r.sources ?? []).find((x: any) => x.n === n); return s && fetched.get(normalizeUrl(s.url)); };
  const srcOk = ok ? (r.sources ?? []).every((s: any) => { const v = fetched.get(normalizeUrl(s.url)); return v && v.status === 200 && /^https:\/\//.test(s.url) && !!s.fetched_at; }) : true;
  if (!srcOk) notes.push("a listed source is not a page this run's reader fetched");
  const flat = (t: string) => String(t ?? "").replace(/\s+/g, " ").toLowerCase();
  const figs = (t: string) => (String(t).match(/\d[\d,.]*\d|\d/g) ?? []).map((x) => x.replace(/,/g, "").replace(/\.$/, "")).filter((x) => x.length >= 2);
  const words = (t: string) => [...new Set((flat(t).match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 5)))];
  let inventedKept = 0, citedOk = true;
  for (const l of kept) {
    const pages = (l.cite ?? []).map(pageOf).filter(Boolean);
    if (!pages.length) { citedOk = false; continue; }
    const text = flat(pages.map((p: any) => p.text).join(" ")).replace(/,/g, "");
    const lineText = flat(l.text);
    if (figs(lineText).some((f) => !text.includes(f))) { inventedKept++; continue; }
    const ws = words(lineText), on = ws.filter((w) => text.includes(w)).length;
    if (ws.length && on / ws.length < 0.6) citedOk = false;
  }
  if (!citedOk) notes.push("a kept line is not on the pages it cites");
  if (inventedKept) notes.push(`${inventedKept} kept line(s) carry a figure no cited page has`);
  const refused = reads.flatMap((x) => x.rejected ?? []).filter((x: any) => x.why !== "blocked_site");
  const unreadOk = !refused.length || (r.unread ?? []).length > 0;
  if (!unreadOk) notes.push("pages the reader could not open are not named");
  const [bp, bt] = c.board.split(":");
  const API: Record<string, string> = { greenhouse: "boards-api.greenhouse.io/v1/boards/", lever: "api.lever.co/v0/postings/", ashby: "api.ashbyhq.com/posting-api/job-board/", smartrecruiters: "api.smartrecruiters.com/v1/companies/" };
  const boardSrc = (ok ? r.sources : []).map((s: any) => s.url).filter((u: string) => Object.values(API).some((h) => u.includes(h)));
  const wrong = boardSrc.filter((u: string) => !u.toLowerCase().includes(`${API[bp]}${bt.toLowerCase()}`));
  if (wrong.length) notes.push(`cites another company's board as ${c.company}'s: ${wrong.join(", ")} (its own: ${c.board})`);
  const brief = ok && kept.length > 0;
  if (!brief) notes.push(ok ? "no line was kept" : `no brief: ${r.blocker ?? r.status}`);
  const checks = { sources: srcOk, cited: citedOk, invented: inventedKept === 0, unread: unreadOk, entity: wrong.length === 0, brief };
  return { id: c.id, company: c.company, status: r.status, kept: kept.length, sources: ok ? (r.sources ?? []).map((s: any) => s.url) : [], hosts: [...new Set((ok ? r.sources : []).map((s: any) => new URL(s.url).hostname))], checks, notes, pass: Object.values(checks).every(Boolean) };
}

// ---------------------------------------------------------------- $0 replay
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 40 && s.length <= 300 && /[a-z]/.test(s) && !/https?:\/\//.test(s));
function scripted(c: Case, pages: { url: string; text: string }[]) {
  const honest: { text: string; quote: string; url: string }[] = [];
  for (const p of pages) for (const s of sentences(p.text)) { if (honest.length >= 3) break; if (!honest.some((h) => h.text === s)) honest.push({ text: s, quote: s, url: p.url }); }
  const p0 = pages[0], q0 = p0 ? sentences(p0.text)[0] ?? "" : "";
  const planted = [
    { key: "business", line: { text: `${c.company} has 987,654 paying customers in 41 countries.`, quote: q0, url: p0?.url ?? "" } },
    { key: "business", line: { text: q0 || `${c.company} sells software.`, quote: q0 || `${c.company} sells software.`, url: `https://www.${c.site}/a-page-never-fetched` } },
    { key: "developments", line: { text: q0, quote: q0, url: p0?.url ?? "", date: "January 15, 2019" } },
    { key: "competitors", line: { name: "Acme Example Corp", text: `Acme Example Corp competes with ${c.company}.`, quote: q0, url: p0?.url ?? "" } },
  ];
  return { honest, planted };
}
async function runCase(c: Case) {
  const rec = JSON.parse(await Deno.readTextFile(`${HERE}recorded/${c.id}.json`));
  const fetched = new Map<string, any>((rec.read.verified as any[]).map((v) => [normalizeUrl(v.url), v]));
  let script: ReturnType<typeof scripted> | null = null;
  const deps = {
    search: { id: "first_party", needsKey: false, search: async () => rec.search },
    read: async () => rec.read,
    draft: async () => {
      const pages = (rec.read.verified as any[]).filter((v) => v.status === 200).map((v) => ({ url: v.url, text: String(v.text ?? "") }));
      script = scripted(c, pages);
      const d: any = { title: `${c.company}: ${c.role}`, business: [], developments: [], competitors: [], role: [], tensions: [], unknowns: ["The team's day-to-day work"] };
      d.business.push(...script.honest);
      for (const p of script.planted) d[p.key].push(p.line);
      return JSON.stringify(d);
    },
  };
  const r: any = await researchCompany({ company: c.company, role: c.role, question: question(c), plan: planOf(c), deps: deps as any, now: NOW, format: "inline" });
  const notes: string[] = [];
  const kept = r.status === "ok" ? [...(r.frame ? [r.frame] : []), ...r.business, ...r.developments, ...r.competitors, ...r.role_asks, ...r.questions] : [];
  const srcOk = r.status === "ok" ? r.sources.every((s: any) => { const v = fetched.get(normalizeUrl(s.url)); return v && v.status === 200 && /^https:\/\//.test(s.url) && !!s.fetched_at; }) : true;
  if (!srcOk) notes.push("a listed source is not a fetched page");
  const citedOk = kept.every((l: any) => (l.cite ?? []).length > 0 && l.cite.every((n: number) => { const s = r.sources.find((x: any) => x.n === n); const v = s && fetched.get(normalizeUrl(s.url)); return !!v; }) &&
    (l.area ? true : (l.cite ?? []).some((n: number) => { const s = r.sources.find((x: any) => x.n === n); const v = s && fetched.get(normalizeUrl(s.url)); return v && String(v.text).replace(/\s+/g, " ").includes(String(l.text).replace(/\s+/g, " ")); })));
  if (!citedOk) notes.push("a kept line is not on the page it cites");
  const plantedTexts = new Set(["987,654", "a-page-never-fetched", "Acme Example Corp", "2019"]);
  const inventedKept = kept.filter((l: any) => [...plantedTexts].some((p) => JSON.stringify(l).includes(p))).length + (r.status === "ok" ? r.developments.filter((d: any) => /2019/.test(d.date)).length : 0);
  // The guard's own count: all 4 planted lines dropped (a kept line carries cite numbers, not its url, so "never fetched" is seen here).
  const plantedDropped = r.status !== "ok" || (r.dropped ?? 0) >= 4;
  if (inventedKept) notes.push(`${inventedKept} planted line(s) kept`);
  if (!plantedDropped) notes.push(`the guard dropped ${r.dropped} lines, fewer than the 4 planted`);
  const refused = (rec.read.rejected as any[]).filter((x) => x.why !== "blocked_site");
  const unreadOk = !refused.length || (r.unread ?? []).length > 0;
  if (!unreadOk) notes.push("pages the reader could not open are not named");
  const [bp, bt] = c.board.split(":");
  const API: Record<string, string> = { greenhouse: "boards-api.greenhouse.io/v1/boards/", lever: "api.lever.co/v0/postings/", ashby: "api.ashbyhq.com/posting-api/job-board/", smartrecruiters: "api.smartrecruiters.com/v1/companies/" };
  const boardSrc = (r.status === "ok" ? r.sources : []).map((s: any) => s.url).filter((u: string) => Object.values(API).some((h) => u.includes(h)));
  const wrong = boardSrc.filter((u: string) => !u.toLowerCase().includes(`${API[bp]}${bt.toLowerCase()}`));
  const entity = wrong.length === 0;
  if (!entity) notes.push(`cites another company's board as ${c.company}'s: ${wrong.join(", ")} (its own: ${c.board})`);
  const brief = r.status === "ok" && kept.length > 0;
  if (!brief) notes.push(r.status === "ok" ? "no line was kept" : `no brief: ${r.blocker}`);
  const checks = { sources: srcOk, cited: citedOk, invented: inventedKept === 0 && plantedDropped, unread: unreadOk, entity, brief };
  return { id: c.id, company: c.company, status: r.status, fetched: fetched.size, refused: refused.length, refused_why: [...new Set(refused.map((x) => x.why))], kept: kept.length, sources: r.status === "ok" ? r.sources.map((s: any) => s.url) : [], unread: r.unread ?? [], checks, notes, pass: Object.values(checks).every(Boolean) };
}
const results: any[] = [];
for (const c of CASES) results.push(await runCase(c));
const n = results.length, pass = results.filter((r) => r.pass).length, bar = Math.ceil(n * 0.95);
const per = ["sources", "cited", "invented", "unread", "entity", "brief"].map((k) => `${k} ${results.filter((r: any) => r.checks[k]).length}/${n}`).join(", ");
const hosts = [...new Set(results.flatMap((r) => r.sources.map((u: string) => new URL(u).hostname)))];
const line = `REAL-SET RESEARCH ($0 replay, scripted draft): ${n} real companies; pages fetched ${results.reduce((s, r) => s + r.fetched, 0)} (hosts: ${hosts.join(", ") || "none"}), refused ${results.reduce((s, r) => s + r.refused, 0)}; ${per}; planted lines kept ${results.reduce((s, r: any) => s + (r.checks.invented ? 0 : 1), 0)} cases; PASS ${pass}/${n} (bar ${bar}/${n}) ${pass >= bar ? "MEETS" : "BELOW"}`;
for (const r of results) if (!r.pass) console.log(`FAIL ${r.id} ${r.company}: ${r.notes.join("; ")}`);
await Deno.mkdir(`${HERE}results`, { recursive: true });
await Deno.writeTextFile(`${HERE}results/latest.json`, JSON.stringify({ at: new Date().toISOString(), line, results }, null, 1) + "\n");
console.log(line);
Deno.exit(pass >= bar ? 0 : 1);
