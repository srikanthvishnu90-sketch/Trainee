// deno-lint-ignore-file no-explicit-any require-await
// Review of #628 (architect, 2026-11-09), required before research reply goes on in production (D-047): body caps read as streams,
// the resolver's 3 s timeout and a per-read wall-clock budget, DNS rebinding re-checked right after the fetch, the IPv6 gaps in
// isPrivateIp, Wikipedia's REST API as a documented API, the default User-Agent to every other host, robots.txt redirects and
// Crawl-delay. Fake web, fake resolver, fake clock: no network, no spend. Every host and page is synthetic.
import assertNode from "node:assert/strict";
import { fetchSources, readCapped } from "../../supabase/functions/_shared/research_sources.ts";
import { RESOLVE_TIMEOUT_MS, RESEARCH_BUDGET_MS, systemResolver } from "../../supabase/functions/_shared/research_dns.ts";
import { DEFAULT_UA, documentedApi, freeFetch, freeProvider, freeReader, JSON_MAX_BYTES, robotsGate, ROBOTS_MAX_BYTES } from "../../supabase/functions/_shared/research_free_sources.ts";
import { isPrivateIp } from "../../supabase/functions/_shared/contact_sources/web_gate.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-09T15:00:00Z");
const PUBLIC = async () => ["203.0.113.10"];
// A body of `total` bytes in 64 KB chunks that counts how much was pulled from it.
function counted(total: number, type = "text/html", pre = "<html><body><p>") {
  const seen = { bytes: 0, cancelled: false };
  const enc = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) { c.close(); return; }
      const n = Math.min(65536, total - sent), chunk = sent === 0 ? enc.encode(pre.padEnd(n, "a")) : new Uint8Array(n).fill(97);
      sent += n; seen.bytes += n; c.enqueue(chunk);
    },
    cancel() { seen.cancelled = true; },
  });
  return { res: new Response(stream, { headers: { "content-type": type } }), seen };
}

Deno.test("body caps: a page stops at 1.5 MB, robots.txt at 512 KB, a JSON probe at 2 MB; nothing past the cap is pulled", async () => {
  const big = counted(5_000_000);
  const got = await readCapped(big.res, 1_500_000);
  eq([got.bytes.length, got.truncated, big.seen.cancelled], [1_500_000, true, true]);
  ok(big.seen.bytes < 1_500_000 + 65536 * 2, `pulled ${big.seen.bytes}`);
  // Through the reader: a 5 MB page is read to its cap and still yields its text.
  const page = counted(5_000_000);
  const r = await fetchSources(["https://huge.example/"], { fetch: (async () => page.res) as typeof fetch, resolver: PUBLIC, now: () => NOW });
  eq(r.verified.length, 1); ok(page.seen.bytes < 1_500_000 + 65536 * 2 && page.seen.cancelled);
  // robots.txt: an endless file is read only to 512 KB.
  const robo = counted(3_000_000, "text/plain", "User-agent: *\nDisallow: /private\n#");
  const g = robotsGate((async () => robo.res) as typeof fetch);
  ok(await g("https://bigrobots.example/public") && !(await g("https://bigrobots.example/private/x")));
  ok(robo.seen.bytes <= ROBOTS_MAX_BYTES + 65536 * 2 && robo.seen.cancelled, `robots pulled ${robo.seen.bytes}`); // a stream may queue one chunk ahead
  // A provider's JSON probe over 2 MB is not parsed: the board counts as not found.
  let pulled = 0;
  const jf = (async (i: RequestInfo | URL) => {
    if (String(i).startsWith("https://boards-api.greenhouse.io/")) { const c = counted(JSON_MAX_BYTES + 500_000, "application/json", '{"jobs":['); pulled = 1; return c.res; }
    return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const out = await freeProvider({ fetch: jf, now: () => NOW, userAgent: null }).search({ queries: ["Hugeboard"], companies: ["Hugeboard"] });
  ok(pulled === 1 && !out.hits.some((h) => h.provider === "ats_board"), "an over-cap board answer is never a source");
});

Deno.test("timeouts: the system resolver gives up within 3 s; one read stops at its budget and names what it did not read", async () => {
  ok(RESOLVE_TIMEOUT_MS <= 3000 && RESEARCH_BUDGET_MS <= 25_000);
  const real = Deno.resolveDns;
  try {
    (Deno as any).resolveDns = () => new Promise(() => {}); // never answers
    const t0 = Date.now();
    let err = "";
    try { await systemResolver("slow.example"); } catch (e) { err = String(e); }
    ok(/no address/.test(err) && Date.now() - t0 < RESOLVE_TIMEOUT_MS + 1500, `${err} after ${Date.now() - t0} ms`);
  } finally { (Deno as any).resolveDns = real; }
  // A fake clock that jumps past the budget after the first page: the rest are time_budget, never fetched.
  let t = NOW, fetched = 0;
  const f = (async (i: RequestInfo | URL) => { fetched++; t += 30_000; return new Response(`<p>page ${String(i)}</p>`, { headers: { "content-type": "text/html" } }); }) as typeof fetch;
  const read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW, clock: () => t, budgetMs: 25_000 });
  const got = await read(["https://a.example/1", "https://b.example/2", "https://c.example/3", "https://d.example/4", "https://e.example/5", "https://f.example/6", "https://g.example/7"]);
  ok(got.rejected.some((r) => r.why === "time_budget"), JSON.stringify(got.rejected));
  ok(fetched < 7 * 2, `robots and pages fetched: ${fetched}`);
});

Deno.test("DNS rebinding: a name that turns private between the check and the fetch is discarded unread", async () => {
  let calls = 0, bodyRead = false;
  const flipAfterCheck = async () => (calls++ === 0 ? ["203.0.113.10"] : ["169.254.169.254"]);
  const f = (async () => new Response(new ReadableStream({ pull(c) { bodyRead = true; c.enqueue(new TextEncoder().encode("<p>metadata</p>")); c.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } })) as typeof fetch;
  const got = await fetchSources(["https://ttl0.example/"], { fetch: f, resolver: flipAfterCheck, now: () => NOW });
  eq([got.verified.length, got.rejected.map((r) => r.why), calls], [0, ["private_address"], 2]);
  ok(!bodyRead, "the body is never read");
  // The answer set gaining one private address is enough.
  let k = 0;
  const grows = async () => (k++ === 0 ? ["203.0.113.10"] : ["203.0.113.10", "10.0.0.7"]);
  eq((await fetchSources(["https://grows.example/"], { fetch: f, resolver: grows, now: () => NOW })).rejected.map((r) => r.why), ["private_address"]);
});

Deno.test("isPrivateIp: IPv4-compatible, 6to4 with a private IPv4, Teredo, site-local and multicast are refused", () => {
  for (const ip of ["::10.0.0.1", "::7f00:1", "2002:0a00:0001::1", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fec0::1", "ff02::1", "ff0e::1", "::ffff:169.254.169.254", "[::1]", "fe80::1%eth0"])
    ok(isPrivateIp(ip), ip);
  for (const ip of ["2606:4700:4700::1111", "2002:0808:0808::1", "93.184.216.34", "2a00:1450:4001:81c::200e"]) ok(!isPrivateIp(ip), ip);
});

Deno.test("Wikipedia's REST API is documented (robots.txt does not govern it); every other host gets the default User-Agent", async () => {
  ok(documentedApi("https://en.wikipedia.org/api/rest_v1/page/summary/Zentrafin") && !documentedApi("https://en.wikipedia.org/wiki/Zentrafin"));
  const seen: [string, string][] = [];
  const f = freeFetch((async (i: RequestInfo | URL, init: RequestInit = {}) => { seen.push([new URL(String(i)).hostname, new Headers(init.headers).get("user-agent") ?? ""]); return new Response(""); }) as typeof fetch, { userAgent: "Trainee research contact@example.test" });
  for (const u of ["https://www.sec.gov/x", "https://en.wikipedia.org/api/rest_v1/page/summary/X", "https://zentrafin.example/careers", "https://news.example/a"]) await f(u);
  eq(seen, [["www.sec.gov", "Trainee research contact@example.test"], ["en.wikipedia.org", "Trainee research contact@example.test"], ["zentrafin.example", DEFAULT_UA], ["news.example", DEFAULT_UA]]);
});

Deno.test("robots.txt: up to 5 redirects are followed (RFC 9309), a sixth is no read; Crawl-delay paces one host, serially", async () => {
  const hops = (n: number) => (async (i: RequestInfo | URL) => {
    const u = new URL(String(i)), k = Number(u.searchParams.get("k") ?? 0);
    if (u.pathname === "/robots.txt" && k < n) return new Response(null, { status: 301, headers: { location: `https://robots-host.example/robots.txt?k=${k + 1}` } });
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /no\n", { status: 200 });
    return new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const five = robotsGate(hops(5));
  ok(await five("https://site.example/yes") && !(await five("https://site.example/no/x")), "5 redirects: the rules are read");
  ok(!(await robotsGate(hops(6))("https://site.example/yes")), "6 redirects: no read");
  // Crawl-delay: 3 on one host: the second page waits 3 s after the first (a fake clock and sleep); another host does not wait.
  let t = NOW;
  const waits: number[] = [];
  const f = (async (i: RequestInfo | URL) => {
    const u = new URL(String(i));
    if (u.pathname === "/robots.txt") return new Response(u.hostname === "slow.example" ? "User-agent: *\nCrawl-delay: 3\n" : "", { status: u.hostname === "slow.example" ? 200 : 404 });
    return new Response(`<p>${u.pathname} on ${u.hostname}</p>`, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW, clock: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  const got = await read(["https://slow.example/a", "https://slow.example/b", "https://fast.example/c"]);
  eq(got.verified.length, 3);
  eq(waits, [3000], "one wait, the delay robots.txt asked for, on the slow host only");
});
