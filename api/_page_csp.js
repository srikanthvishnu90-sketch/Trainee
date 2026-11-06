// The Content-Security-Policy the site's /file and /connect proxies send (not a route: Vercel serves no file under api/ whose
// name starts with "_").
//
// BETA B1 (2026-11-05, build eaa5a3f): the proxies copied the upstream Content-Security-Policy, and on *.supabase.co that is the
// gateway's own `default-src 'none'; sandbox`, not the function's: every style and every form post on the page was blocked (an
// unstyled sign-in in Times New Roman, a 1,889 px logo over the form, a form that could not be sent). The function now sends its
// own policy in x-trainee-csp (supabase/functions/_shared/page_csp.ts); that is what the browser gets. The gateway's header is
// never passed on. When the page's policy is missing or not the shape the function sends, a strict policy of this site's own is
// used: no script at all, styles and same-origin form posts only, framed only by Telegram's web clients.
export const PAGE_CSP_HEADER = "x-trainee-csp";
const FRAMES = "https://web.telegram.org https://*.telegram.org";
export const FALLBACK_PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${FRAMES}`;
// The ATS logo rules (host and path) a page's img-src may gain an exact hostname from: a copy of ATS_LOGO_RULES in
// supabase/functions/_shared/page_csp.ts (the evidence is noted there; a test keeps them equal).
export const ATS_LOGO_RULES = [
  { ats: "greenhouse", host: "^s\\d{1,4}-recruiting\\.cdn\\.greenhouse\\.io$", path: "^/external_greenhouse_job_boards/logos/" },
  { ats: "lever", host: "^lever-client-logos\\.s3\\.us-west-2\\.amazonaws\\.com$", path: "^/" },
  { ats: "lever", host: "^lever-client-logos\\.s3\\.amazonaws\\.com$", path: "^/" },
  { ats: "ashby", host: "^app\\.ashbyhq\\.com$", path: "^/api/images/org-theme-logo/" },
  { ats: "smartrecruiters", host: "^c\\.smartrecruiters\\.com$", path: "^/sr-company-logo-prod-[a-z0-9-]+/" },
];
// An image (an employer's logo) is never a document: no script, no style, no form, sandboxed.
export const IMAGE_CSP = "default-src 'none'; sandbox";
// The function's policies all start by denying everything and say who may frame the page; one line, printable ASCII, bounded.
const SHAPE = /^default-src 'none';[\x20-\x7e]{0,4000}$/;

export function pageCsp(upstream, fallback = FALLBACK_PAGE_CSP) {
  const v = upstream && typeof upstream.get === "function" ? upstream.get(PAGE_CSP_HEADER) : null;
  const csp = typeof v === "string" ? v.trim() : "";
  return SHAPE.test(csp) && /(?:^|;\s*)frame-ancestors\s/.test(csp) && !/[,]/.test(csp) ? csp : fallback;
}
