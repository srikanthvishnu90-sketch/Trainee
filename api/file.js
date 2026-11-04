// /file -> the trainee-file edge function, served as a real HTML page. Supabase answers an edge function's HTML as
// text/plain on its own domain, so this thin proxy (no logic, no secrets beyond the function's public URL) returns the same
// body as HTML with the page's security headers. The function signs people in itself (phone code or Telegram).
const UPSTREAM = process.env.TRAINEE_FILE_UPSTREAM; // e.g. https://<project>.supabase.co/functions/v1/trainee-file
const KEEP = ["cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options", "content-security-policy", "allow"];
// origin, referer and sec-fetch-site: the function refuses a post another site made the browser send (it reads them; without them
// here it could not tell a cross-site form from the page's own).
const PASS_REQ = ["cookie", "user-agent", "origin", "referer", "sec-fetch-site"];

async function pass(request) {
  if (!UPSTREAM || !/^https:\/\//.test(UPSTREAM)) return new Response("File pages are not set up yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const src = new URL(request.url), up = new URL(UPSTREAM);
  up.search = src.search;
  const headers = { "content-type": request.headers.get("content-type") || "application/x-www-form-urlencoded" };
  for (const k of PASS_REQ) { const v = request.headers.get(k); if (v) headers[k] = v; }
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method === "POST") init.body = await request.text();
  const r = await fetch(up, init);
  const body = await r.text();
  // Supabase answers a function that is not deployed with its own 404 JSON; passing that on looks like a missing page on this site.
  if (r.status === 404 && /"code":"NOT_FOUND"/.test(body) && /Requested function was not found/.test(body)) return new Response("File pages are not available yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const wantsText = src.searchParams.get("format") === "text";
  const h = new Headers({ "content-type": wantsText ? "text/plain; charset=utf-8" : "text/html; charset=utf-8" });
  for (const k of KEEP) { const v = r.headers.get(k); if (v) h.set(k, v); }
  // Each cookie as its own header (a sign-in sets the session and clears the pending link in one answer; joined, both break).
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
  for (const c of cookies) h.append("set-cookie", c);
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) h.set("location", "/file"); // the clean URL on this site, never the upstream path
  return new Response(r.status >= 300 && r.status < 400 ? null : body, { status: r.status, headers: h });
}
export const GET = pass;
export const POST = pass;
