// /file -> the trainee-file edge function, served as a real HTML page. Supabase answers an edge function's HTML as
// text/plain on its own domain, so this thin proxy (no logic, no secrets beyond the function's public URL) returns the same
// body as HTML with the page's security headers. The function signs people in itself (phone code or Telegram).
import { IMAGE_CSP, pageCsp } from "./_page_csp.js";
const UPSTREAM = process.env.TRAINEE_FILE_UPSTREAM; // e.g. https://<project>.supabase.co/functions/v1/trainee-file
// Never "content-security-policy": on *.supabase.co that is the gateway's sandbox policy, not the page's (BETA B1, ./_page_csp.js).
const KEEP = ["cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options", "allow", "cross-origin-resource-policy"];
// An employer's logo (the page's img src "?logo=<domain>", served by the function from its own cache): raster bytes, passed on as
// bytes with the function's own image type. Read as text and labelled text/html, every logo was mangled (file page sign-in round 4)
// and the employer's bytes were served on this site as a document. Only these types; anything else is the page's text.
const IMAGE = /^image\/(png|x-icon|jpeg|gif|webp)$/;
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
  const upType = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (r.status === 200 && src.searchParams.has("logo") && IMAGE.test(upType)) {
    const img = new Headers({ "content-type": upType });
    for (const k of KEEP) { const v = r.headers.get(k); if (v) img.set(k, v); }
    img.set("content-security-policy", pageCsp(r.headers, IMAGE_CSP));
    return new Response(await r.arrayBuffer(), { status: 200, headers: img });
  }
  // The resume File's download (R10): its PDF passes as bytes with the function's own type and file name, never as page text.
  if (r.status === 200 && upType === "application/pdf") {
    const pdf = new Headers({ "content-type": "application/pdf" });
    for (const k of [...KEEP, "content-disposition"]) { const v = r.headers.get(k); if (v) pdf.set(k, v); }
    return new Response(await r.arrayBuffer(), { status: 200, headers: pdf });
  }
  const body = await r.text();
  // Supabase answers a function that is not deployed with its own 404 JSON; passing that on looks like a missing page on this site.
  if (r.status === 404 && /"code":"NOT_FOUND"/.test(body) && /Requested function was not found/.test(body)) return new Response("File pages are not available yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const wantsText = src.searchParams.get("format") === "text";
  const h = new Headers({ "content-type": wantsText ? "text/plain; charset=utf-8" : "text/html; charset=utf-8" });
  for (const k of KEEP) { const v = r.headers.get(k); if (v) h.set(k, v); }
  h.set("content-security-policy", pageCsp(r.headers));
  // Each cookie as its own header (a sign-in sets the session and clears the pending link in one answer; joined, both break).
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
  for (const c of cookies) h.append("set-cookie", c);
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) h.set("location", "/file"); // the clean URL on this site, never the upstream path
  return new Response(r.status >= 300 && r.status < 400 ? null : body, { status: r.status, headers: h });
}
export const GET = pass;
export const POST = pass;
