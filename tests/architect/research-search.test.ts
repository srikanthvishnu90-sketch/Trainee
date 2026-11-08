// R9-C (2026-11-07): the market research search providers (_shared/research_search.ts). Brave Search when the owner sets
// BRAVE_SEARCH_API_KEY; with no key, first-party sources only (SEC EDGAR, BLS wage pages, company sites the turn names). A provider
// only proposes addresses: https only, never LinkedIn, Indeed or Handshake, every hit with the time it was found. Fake web only.
import assertNode from "node:assert/strict";
import { braveProvider, declaredFetch, firstPartyProvider, searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { fakeWeb, NOW } from "./research-web-fixture.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const envOf = (o: Record<string, string>) => ({ get: (k: string) => o[k] });

Deno.test("provider choice: Brave with the owner's key (unless first_party is asked for), else first-party with no key", () => {
  const f = fakeWeb();
  eq(searchProviderFor(envOf({ BRAVE_SEARCH_API_KEY: "test-key-not-real" }), f).id, "brave");
  eq(searchProviderFor(envOf({ BRAVE_SEARCH_API_KEY: "test-key-not-real", RESEARCH_SEARCH_PROVIDER: "first_party" }), f).id, "first_party");
  const none = searchProviderFor(envOf({}), f);
  eq([none.id, none.needsKey], ["first_party", false]);
  eq(searchProviderFor(envOf({ RESEARCH_SEARCH_PROVIDER: "brave" }), f).id, "first_party", "asking for Brave without a key cannot use it");
});

Deno.test("brave: the key goes in its header, the endpoint and count are configurable, results keep url and time; blocked and http hits are dropped", async () => {
  const log: { url: string; headers: Headers }[] = [];
  const p = searchProviderFor(envOf({ BRAVE_SEARCH_API_KEY: "test-key-not-real", RESEARCH_SEARCH_COUNT: "7" }), fakeWeb(log), () => NOW);
  const out = await p.search({ queries: ["home battery market outlook", "", "battery prices"] });
  eq(out.searches, 2);
  const call = new URL(log[0].url);
  eq([call.origin + call.pathname, call.searchParams.get("count"), log[0].headers.get("x-subscription-token")], ["https://api.search.brave.com/res/v1/web/search", "7", "test-key-not-real"]);
  ok(out.hits.every((h) => h.foundAt === NOW && h.provider === "brave" && h.url.startsWith("https://")));
  ok(!out.hits.some((h) => /linkedin|indeed/.test(h.url)), "LinkedIn and Indeed are never proposed");
  eq(new Set(out.hits.map((h) => h.url)).size, out.hits.length, "no duplicates across queries");
  const other = braveProvider({ key: "k", fetch: fakeWeb(log), now: () => NOW, endpoint: "https://search.internal.example/v1" });
  await other.search({ queries: ["x"] }).catch(() => null);
  ok(log.at(-1)!.url.startsWith("https://search.internal.example/v1?"), "a configured endpoint is used");
});

Deno.test("brave: a refused key stops after one call and says the search was not completed", async () => {
  let calls = 0;
  const f = (async () => { calls++; return new Response("{}", { status: 401 }); }) as typeof fetch;
  const out = await braveProvider({ key: "bad", fetch: f, now: () => NOW }).search({ queries: ["a", "b", "c"] });
  eq([calls, out.hits.length], [1, 0]); ok(/not completed \(HTTP 401\)/.test(out.notes[0]));
});

Deno.test("first-party: BLS wage pages from an occupation code (and a metro code), company sites named, nothing invented", async () => {
  const p = firstPartyProvider({ fetch: fakeWeb(), now: () => NOW, userAgent: null });
  const out = await p.search({ queries: ["software developer salary seattle"], soc: "15-1252", cbsa: "42660", sites: ["Acme.example", "https://globex.example/products", "not a domain", "javascript:alert(1)"] });
  eq(out.hits.map((h) => h.url), ["https://www.bls.gov/oes/current/oes151252.htm", "https://www.bls.gov/oes/current/oes_42660.htm", "https://acme.example/", "https://acme.example/about", "https://globex.example/", "https://globex.example/about"]);
  ok(out.hits.every((h) => h.foundAt === NOW));
  eq((await p.search({ queries: ["q"], soc: "software" })).notes.includes("the occupation code is not a BLS code like 15-1252"), true);
  ok((await p.search({ queries: ["what would change the market for batteries"] })).notes.some((n) => /no first-party source fits/.test(n)), "with nothing to look up it says so");
});

Deno.test("first-party: SEC EDGAR needs a declared contact; with one it finds the latest 10-K from data.sec.gov", async () => {
  const noUa = await firstPartyProvider({ fetch: fakeWeb(), now: () => NOW, userAgent: null }).search({ queries: [], companies: ["Acme Energy"] });
  eq(noUa.hits, []); ok(/RESEARCH_USER_AGENT/.test(noUa.notes[0]));
  const seen: string[] = [];
  const sec = (async (u: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(u); seen.push(`${url} ${new Headers(init.headers).get("user-agent")}`);
    if (url.endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 1234567, ticker: "ACME", title: "ACME ENERGY INC" } });
    if (url.includes("CIK0001234567.json")) return Response.json({ filings: { recent: { form: ["8-K", "10-K"], accessionNumber: ["0001-26-000002", "0001234567-26-000001"], primaryDocument: ["x.htm", "acme-10k.htm"] } } });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const out = await firstPartyProvider({ fetch: sec, now: () => NOW, userAgent: "Trainee research test@example.com" }).search({ queries: [], companies: ["Acme Energy", "Nobody Corp"] });
  eq(out.hits.map((h) => [h.url, h.provider]), [["https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/acme-10k.htm", "sec_edgar"]]);
  ok(seen.every((s) => s.endsWith("Trainee research test@example.com")), "every SEC call declares the contact");
  ok(out.notes.some((n) => /no 10-K on SEC EDGAR for Nobody Corp/.test(n)));
});

Deno.test("declaredFetch: the contact User-Agent goes to sec.gov and bls.gov only", async () => {
  const log: { url: string; headers: Headers }[] = [];
  const f = declaredFetch(fakeWeb(log), "Trainee research test@example.com");
  await f("https://www.bls.gov/oes/current/oes151252.htm"); await f("https://acme.example/annual-report"); await f("https://evilsec.gov.example/");
  eq(log.map((l) => l.headers.get("user-agent")), ["Trainee research test@example.com", null, null]);
});
