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
// ATS's image host. A logo URL is allowed only when its host AND path match one rule below (checked 2026-11-06 against live public
// board pages); a page's img-src then gains exactly the hostnames its rows use (trainee-file/handler.ts logoCsp), never a wildcard,
// and only on a page that has such a row. Any other URL is dropped and the row falls back. api/_page_csp.js carries the same rules
// (tests/architect/file-logos-20261106.test.ts keeps them equal).
//   Greenhouse: sN-recruiting.cdn.greenhouse.io (seen s3, s4, s8, s9, s101), board logos only (not the fonts or banners there).
//   Lever: the client-logos bucket, regional and legacy hostnames (a logo-only bucket).
//   Ashby: org-theme-logo only (not the wordmark, social image or custom CSS on the same host).
//   SmartRecruiters: the sr-company-logo-prod-* buckets only (not the sr-company-images-prod-* og:image or the job-ad assets).
export const ATS_LOGO_RULES: ReadonlyArray<{ ats: string; host: string; path: string }> = [
  { ats: "greenhouse", host: "^s\\d{1,4}-recruiting\\.cdn\\.greenhouse\\.io$", path: "^/external_greenhouse_job_boards/logos/" },
  { ats: "lever", host: "^lever-client-logos\\.s3\\.us-west-2\\.amazonaws\\.com$", path: "^/" },
  { ats: "lever", host: "^lever-client-logos\\.s3\\.amazonaws\\.com$", path: "^/" },
  { ats: "ashby", host: "^app\\.ashbyhq\\.com$", path: "^/api/images/org-theme-logo/" },
  { ats: "smartrecruiters", host: "^c\\.smartrecruiters\\.com$", path: "^/sr-company-logo-prod-[a-z0-9-]+/" },
];
const RULES = ATS_LOGO_RULES.map((r) => ({ host: new RegExp(r.host), path: new RegExp(r.path) }));
// The logo URL as an https image matching one rule (no credentials, no port, no encoded slash, bounded), else null. The path is
// read after URL parsing, so "/a/../b" and "%2e%2e" segments are already resolved before the rule sees it.
export function atsLogoUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500 || /[\s"'<>\\]/.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || u.port || /%(2f|5c)/i.test(u.pathname)) return null;
    return RULES.some((r) => r.host.test(u.hostname) && r.path.test(u.pathname)) ? u.href : null;
  } catch { return null; }
}
