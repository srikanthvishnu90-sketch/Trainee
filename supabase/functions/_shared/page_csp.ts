// The page's own Content-Security-Policy, carried past Supabase's gateway to the site's proxies (api/file.js, api/connect.js).
//
// BETA B1 (2026-11-05, build eaa5a3f): a File link opened to an unstyled sign-in page whose form could not be sent. Supabase's
// gateway answers an edge function's page on *.supabase.co with its own `Content-Security-Policy: default-src 'none'; sandbox`
// (it also labels the page text/plain), and the /file proxy copied that header onto the site's page, so the browser blocked every
// style and every form post (sandbox without allow-forms). The function's own policy (strict: script hashes, form-action 'self',
// frame-ancestors Telegram only) never reached the browser. Now each page function also sends its policy in PAGE_CSP_HEADER,
// which the gateway leaves alone; the proxy sends that as the page's Content-Security-Policy and never the gateway's.
export const PAGE_CSP_HEADER = "x-trainee-csp";

// The same response with its own Content-Security-Policy copied into PAGE_CSP_HEADER (nothing else changes).
export function relayPageCsp(res: Response): Response {
  const csp = res.headers.get("content-security-policy");
  if (!csp) return res;
  const h = new Headers(res.headers);
  h.set(PAGE_CSP_HEADER, csp);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Employer logos the applicant-tracking systems themselves publish for a board (a posting's `logo_url`), shown straight from the
// ATS's image host. The exact hosts below are the only ones a page's img-src ever gains, and only on a page that has a row using one
// (trainee-file/handler.ts logoCsp); an image from any other host is dropped and the row draws its initials. api/_page_csp.js
// carries the same list (tests/architect/file-logos-20261106.test.ts keeps them equal).
export const ATS_LOGO_HOSTS = [
  "s101-recruiting.cdn.greenhouse.io", // Greenhouse board logos
  "lever-client-logos.s3.us-west-2.amazonaws.com", // Lever
  "app.ashbyhq.com", // Ashby org logos
  "c.smartrecruiters.com", // SmartRecruiters company logos
];
// The logo URL as an https image on one of those hosts (no credentials, no port, bounded), else null.
export function atsLogoUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500 || /[\s"'<>]/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && ATS_LOGO_HOSTS.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}
