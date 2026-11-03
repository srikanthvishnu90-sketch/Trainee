// RESEARCH ANSWER LAYOUT (owner, 2026-10-28): the link-verification guard. Written fail-first: against a permissive guard
// (every link kept, nothing blocked) each of these fails. Fake fetch at the HTTP boundary only; no network.
// Check: deno test -A --no-check tests/edge/research-link-guard.test.ts
import assertNode from "node:assert/strict";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
import { fetchSources, isBlockedHost, verifiedLinkGuard } from "../../supabase/functions/_shared/research_sources.ts";

const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
function fakeWeb(pages: Record<string, { status: number; body?: string; type?: string; location?: string }>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const p = pages[url];
    if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html; charset=utf-8" };
    if (p.location) headers.location = p.location;
    return new Response(p.body ?? "", { status: p.status, headers });
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("guard: a link no fetch returned is dropped, a fetched one is kept", () => {
  const verified = [{ url: "https://example.org/reviews", status: 200 as const }];
  const g = verifiedLinkGuard(["https://example.org/reviews", "https://made-up.example.com/report"], verified);
  assertEquals(g.kept, ["https://example.org/reviews"]);
  assertEquals(g.dropped, ["https://made-up.example.com/report"]);
});

Deno.test("guard: the same page with a fragment or trailing slash still matches; a different path does not", () => {
  const verified = [{ url: "https://example.org/reviews", status: 200 as const }];
  const g = verifiedLinkGuard(["https://example.org/reviews/#top", "https://example.org/reviews/page-2"], verified);
  assertEquals(g.kept, ["https://example.org/reviews"]);
  assertEquals(g.dropped, ["https://example.org/reviews/page-2"]);
});

Deno.test("guard: LinkedIn, Indeed and Handshake are blocked, even if something claims they were fetched", () => {
  for (const u of ["https://www.linkedin.com/company/x", "https://lnkd.in/abc", "https://ca.indeed.com/jobs", "https://www.indeed.co.uk/x", "https://app.joinhandshake.com/jobs/1"]) {
    assert(isBlockedHost(u), u);
    const g = verifiedLinkGuard([u], [{ url: u, status: 200 }]);
    assertEquals(g.kept, [], u);
  }
  assert(!isBlockedHost("https://www.trustpilot.com/review/www.linkedin.com"), "a review site about LinkedIn is not LinkedIn");
});

Deno.test("fetch: a blocked site is never requested; a 404, a redirect to a blocked site and a PDF are not verified", async () => {
  const { f, calls } = fakeWeb({
    "https://reviews.example.org/linkedin": { status: 200, body: html("LinkedIn reviews", "Users report login loops and spam.") },
    "https://short.example.net/x": { status: 302, location: "https://www.linkedin.com/feed" },
    "https://files.example.org/a.pdf": { status: 200, body: "%PDF", type: "application/pdf" },
  });
  const r = await fetchSources([
    "https://www.linkedin.com/company/linkedin", "https://reviews.example.org/linkedin", "https://gone.example.org/page",
    "https://short.example.net/x", "https://files.example.org/a.pdf", "http://127.0.0.1/admin",
  ], { fetch: f, now: () => 1 });
  assertEquals(r.verified.map((v) => v.url), ["https://reviews.example.org/linkedin"]);
  assertEquals(r.verified[0].title, "LinkedIn reviews");
  assert(r.verified[0].text.includes("login loops"));
  assertEquals(Object.fromEntries(r.rejected.map((x) => [x.url, x.why])), {
    "https://www.linkedin.com/company/linkedin": "blocked_site",
    "https://gone.example.org/page": "http_status",
    "https://short.example.net/x": "blocked_site",
    "https://files.example.org/a.pdf": "not_text",
    "http://127.0.0.1/admin": "private_address",
  });
  assert(!calls.some((c) => /linkedin\.com|127\.0\.0\.1/.test(c)), `never requested: ${calls.join(", ")}`);
});
