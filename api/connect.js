// /connect -> the trainee-connect edge function, served as a real HTML page (Supabase answers an edge function's HTML as
// text/plain on its own domain). A thin proxy: no logic, no secrets beyond the function's public URL. The signed link, or
// Telegram's signed Mini App data, is the only credential. A redirect to the provider's own sign-in page is passed through;
// any other redirect becomes the clean /connect URL on this site.
import { pageCsp } from "./_page_csp.js";
const UPSTREAM = process.env.TRAINEE_CONNECT_UPSTREAM; // e.g. https://<project>.supabase.co/functions/v1/trainee-connect
// Never "content-security-policy": on *.supabase.co that is the gateway's sandbox policy, not the page's (BETA B1, ./_page_csp.js).
const KEEP = ["cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options"];
const PASS_REQ = ["cookie", "user-agent", "accept"];
const PROVIDER_SIGN_IN = /^https:\/\/(?:accounts\.google\.com|login\.microsoftonline\.com)\//;

async function pass(request) {
  if (!UPSTREAM || !/^https:\/\//.test(UPSTREAM)) return new Response("Connect pages are not set up yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const src = new URL(request.url), up = new URL(UPSTREAM);
  up.search = src.search;
  const headers = { "content-type": request.headers.get("content-type") || "application/x-www-form-urlencoded" };
  for (const k of PASS_REQ) { const v = request.headers.get(k); if (v) headers[k] = v; }
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method === "POST") init.body = await request.text();
  const r = await fetch(up, init);
  const body = await r.text();
  // Supabase answers a function that is not deployed with its own 404 JSON; passing that on looks like a missing page on this site.
  if (r.status === 404 && /"code":"NOT_FOUND"/.test(body) && /Requested function was not found/.test(body)) return new Response("Connect pages are not available yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const json = /application\/json/.test(r.headers.get("content-type") || "");
  const h = new Headers({ "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8" });
  for (const k of KEEP) { const v = r.headers.get(k); if (v) h.set(k, v); }
  h.set("content-security-policy", pageCsp(r.headers));
  const sc = r.headers.get("set-cookie"); if (sc) h.append("set-cookie", sc);
  const to = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && to) h.set("location", PROVIDER_SIGN_IN.test(to) ? to : "/connect");
  return new Response(r.status >= 300 && r.status < 400 ? null : body, { status: r.status, headers: h });
}
export const GET = pass;
export const POST = pass;
