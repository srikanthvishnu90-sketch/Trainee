// deno-lint-ignore-file no-explicit-any require-await
// The three review fixes from #589 (split out of #615, 2026-11-09): research_market's effect is write_own when it publishes a File;
// the RESOLVED address of every fetch and redirect is checked (DNS rebinding), and a runtime that cannot resolve reads nothing;
// "give me an overview of everything I applied to" stays with export. Fake web, fake resolver, scripted model: no network, no spend.
// Every company and page is synthetic. The test bodies are #615's, with the free sources (split into their own PR) replaced by a
// one-page stub search.
import assertNode from "node:assert/strict";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { marketResearchAsk, researchAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { type MarketDeps } from "../../supabase/functions/_shared/agent/research/market.ts";
import { testSupportJudge } from "./support-test-judge.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { dnsProbe, resolvedReader } from "../../supabase/functions/_shared/research_dns.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-08T15:00:00Z");
const html = (t: string, b: string) => new Response(`<!doctype html><html><head><title>${t}</title></head><body><p>${b}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const PUBLIC = async () => ["203.0.113.10"];

Deno.test("DNS rebinding: the resolved address is checked on every fetch and every redirect; one private answer refuses the page", async () => {
  const asked: string[] = [];
  const f = (async (i: RequestInfo | URL) => { const u = new URL(String(i)); return u.hostname === "start.example" ? new Response(null, { status: 301, headers: { location: "https://rebind.example/page" } }) : html("t", "a public page"); }) as typeof fetch;
  // The redirect target's name resolves to a private address: refused at that hop, never fetched.
  const res1 = async (h: string) => { asked.push(h); return h === "rebind.example" ? ["93.184.216.34", "10.0.0.5"] : ["203.0.113.10"]; };
  eq((await fetchSources(["https://start.example/"], { fetch: f, resolver: res1 })).rejected.map((r) => r.why), ["private_address"]);
  // Review of #628: every hop resolves before its fetch and again right after it.
  eq(asked, ["start.example", "start.example", "rebind.example"], "every hop resolves, before and after its fetch");
  // The same name answers public for one read (its two lookups), then private (a rebinding server): the second read is refused.
  let n = 0;
  const flip = async () => (n++ < 2 ? ["203.0.113.10"] : ["127.0.0.1"]);
  eq((await fetchSources(["https://flip.example/a"], { fetch: f, resolver: flip })).verified.length, 1);
  eq((await fetchSources(["https://flip.example/b"], { fetch: f, resolver: flip })).rejected.map((r) => r.why), ["private_address"]);
  // Metadata, CGNAT, IPv6 loopback, link-local and v4-mapped answers all refuse; no answer at all is unreachable.
  for (const ip of ["169.254.169.254", "100.64.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"])
    eq((await fetchSources(["https://x.example/"], { fetch: f, resolver: async () => [ip] })).rejected.map((r) => r.why), ["private_address"], ip);
  eq((await fetchSources(["https://x.example/"], { fetch: f, resolver: async () => { throw new Error("NXDOMAIN"); } })).rejected.map((r) => r.why), ["unreachable"]);
  // The chat's reader always resolves: built without a resolver it uses the system one (here, Deno.resolveDns stubbed).
  const real = Deno.resolveDns;
  try {
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["10.1.2.3"] : []);
    eq((await resolvedReader({ fetch: f, now: () => NOW, probe: async () => ({ ok: true, why: "stub" }) })(["https://looks-public.example/"])).rejected.map((r) => r.why), ["private_address"]);
  } finally { (Deno as any).resolveDns = real; }
});

Deno.test("research_market's effect is write_own when it published a File, read when it answered inline", async () => {
  const page = "https://zentrafin.example/careers";
  const f = (async (i: RequestInfo | URL) => String(i) === page ? html("Careers at Zentrafin", "Zentrafin hires new grads into engineering every fall. Zentrafin lists 4 open roles. Fewer open roles would mean fewer first jobs.") : new Response("nf", { status: 404, headers: { "content-type": "text/html" } })) as typeof fetch;
  const draft = { title: "Zentrafin", thesis: "Zentrafin hires new grads into engineering.", summary: [{ text: "Zentrafin lists 4 open roles.", quote: "Zentrafin lists 4 open roles.", url: page }],
    conditions: [{ text: "Zentrafin keeps hiring new grads into engineering.", urls: [page] }], risks: [{ text: "Fewer open roles would mean fewer first jobs.", urls: [page] }] };
  const run = async (format: "file" | "inline") => {
    const d: MarketDeps = { search: { id: "first_party", needsKey: false, search: async () => ({ hits: [{ url: page, title: "t", provider: "company_site", foundAt: NOW }], notes: [], provider: "first_party", searches: 1 }) },
      read: resolvedReader({ fetch: f, resolver: PUBLIC, now: () => NOW }), draft: async () => JSON.stringify(draft), publish: async () => ({ url: "https://trainee.example/file?t=v1.free2" }),
      // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line.
      judge: testSupportJudge };
    let step = 0;
    const model = async () => (++step === 1 ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: "research Zentrafin", format, companies: ["Zentrafin"], sites: ["zentrafin.example"] } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "Zentrafin is hiring; the brief is in the file." }], stop_reason: "end_turn" });
    const t: any = await agentTurn({ message: "research Zentrafin and give me a file", history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: d } as any);
    return t.tool_calls.find((c: any) => c.name === "research_market");
  };
  eq((await run("file")).effect, "write_own");
  eq((await run("inline")).effect, "read");
});

Deno.test("RESEARCH_ASK: an overview of the person's own applications stays with export; research about companies stays research", () => {
  const env = { get: (k: string) => (k === "CAREER_RESEARCH_REPLY" ? "on" : undefined) };
  for (const m of ["give me an overview of everything I applied to", "can you give me a rundown of all the jobs I've applied for", "a report on all my applications please", "overview of everything i’ve applied to", "summary of all of it"]) {
    eq(researchAsk(m), false, m); eq(marketResearchAsk(env as any, m, null), false, m);
  }
  for (const m of ["give me an overview of the fintech market in Chicago", "research the companies I applied to and give me a file", "compare Zentrafin and Quillmont", "research Zentrafin as an employer"])
    eq(researchAsk(m), true, m);
});

Deno.test("startup DNS probe: logged once; a runtime without a usable Deno.resolveDns fails closed (nothing is read)", async () => {
  const lines: string[] = [];
  eq((await dnsProbe({ resolve: null, log: (l) => lines.push(l), fresh: true })).ok, false);
  eq((await dnsProbe({ resolve: async () => { throw new Error("Deno.resolveDns is not supported in this context"); }, log: (l) => lines.push(l), fresh: true })).ok, false);
  eq((await dnsProbe({ resolve: async () => { throw new TypeError("x is not a function"); }, log: (l) => lines.push(l), fresh: true })).ok, false);
  eq((await dnsProbe({ resolve: async () => { const e = new Error("no records"); e.name = "NotFound"; throw e; }, log: (l) => lines.push(l), fresh: true })).ok, true, "a name with no answer is DNS working");
  eq((await dnsProbe({ resolve: async () => ["203.0.113.1"], log: (l) => lines.push(l), fresh: true })).ok, true);
  ok(lines.every((l) => JSON.parse(l).evt === "research_dns_probe") && lines.length === 5);
  let fetched = 0;
  const f = (async () => { fetched++; return html("t", "x"); }) as typeof fetch;
  const read = resolvedReader({ fetch: f, now: () => NOW, probe: async () => ({ ok: false, why: "no DNS" }) });
  const got = await read(["https://zentrafin.example/", "https://www.bls.gov/ooh/"]);
  eq([got.verified.length, got.rejected.map((r) => r.why), fetched], [0, ["unreachable", "unreachable"], 0]);
});
