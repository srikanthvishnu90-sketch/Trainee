// R9-C: a fake web for the market research tests. Every page, company and figure is synthetic (".example" hosts; the bls.gov and
// sec.gov addresses are answered by this fake, never fetched). No network, no model, no spend.
export const NOW = Date.parse("2026-11-07T15:00:00Z");
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
export const PAGES: Record<string, { title: string; body: string }> = {
  "https://research.example/battery-prices-2024": { title: "Battery price survey 2024", body: "Battery pack prices fell 20% in 2024 according to the annual survey of cell makers." },
  "https://acme.example/annual-report": { title: "Acme Energy annual report 2025", body: "Acme Energy installed 41,000 home batteries in 2025. Acme Energy sells batteries and solar panels." },
  "https://globex.example/products": { title: "Globex Power products", body: "Globex Power sells home batteries, solar panels and EV chargers to homeowners." },
  "https://initech.example/about": { title: "About Initech Grid", body: "Initech Grid builds grid software for utilities. It does not sell hardware to homes." },
  "https://utility.example/tariffs/storage": { title: "Utility storage tariff", body: "The utility pays homes for stored power during peak hours. The storage tariff is reviewed every year by the state board." },
  "https://www.bls.gov/oes/current/oes151252.htm": { title: "Software Developers", body: "15-1252 Software Developers. National estimates. Annual mean wage: $150,000 (synthetic fixture)." },
  "https://www.bls.gov/oes/current/oes_42660.htm": { title: "Seattle-Tacoma-Bellevue, WA wage estimates", body: "15-1252 Software Developers annual mean wage $180,000 in the Seattle-Tacoma-Bellevue metro area (synthetic fixture)." },
};
export const SEARCH: Record<string, string[]> = {
  market: ["https://research.example/battery-prices-2024", "https://www.linkedin.com/pulse/batteries", "https://utility.example/tariffs/storage", "https://acme.example/annual-report", "https://dead.example/gone"],
  compare: ["https://acme.example/annual-report", "https://globex.example/products", "https://initech.example/about", "https://indeed.com/cmp/acme"],
};
export function fakeWeb(log: { url: string; headers: Headers }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    log.push({ url, headers: new Headers(init.headers) });
    const u = new URL(url);
    if (u.hostname === "api.search.brave.com") {
      const q = u.searchParams.get("q") ?? "";
      const hits = /compar|acme|globex/i.test(q) ? SEARCH.compare : /batter|market/i.test(q) ? SEARCH.market : [];
      return new Response(JSON.stringify({ web: { results: hits.map((h, i) => ({ url: h, title: `Result ${i + 1}`, description: "search engine text, never stored" })) } }), { headers: { "content-type": "application/json" } });
    }
    const p = PAGES[url.replace(/\/$/, "")];
    if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(html(p.title, p.body), { headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
}
