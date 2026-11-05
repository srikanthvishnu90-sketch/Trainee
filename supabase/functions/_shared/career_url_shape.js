/* Career posting URL-SHAPE guard (MUSE-F-010).
   Pure domain module, UMD like the other domain modules. No fetch, no I/O:
   this classifies the SHAPE of a URL — is this string even the shape of a job
   posting, before anyone asks whether it is live (that is MUSE-F-003's
   liveness question, a separate check). Built after the 2026-10-20 link
   audit found the shelf serving Socrata dataset API endpoints
   (nyc-open-data rows: https://data.cityofnewyork.us/resource/<id>.json?job_id=…)
   and Hacker News discussion threads (hn-algolia rows:
   https://news.ycombinator.com/item?id=…) to users as "job links".

   Verdicts:
     "posting"     — matches a recognized posting grammar (ATS board URL with
                     a job id, an employer-hosted greenhouse wrapper carrying
                     gh_jid, or a job-board URL with an id-bearing job path).
     "not_posting" — a shape that is never a posting: data/API endpoint,
                     discussion thread, search/listing page, or not a URL.
     "unknown"     — neither. Loaders keep the row but flag it; the guard
                     NEVER promotes an unrecognized shape to "posting"
                     (wrong is worse than empty).

   Contract for callers (see docs/discovery-quality/url-shape-guard-integration-2026-10-21.md):
   load-side, reject/quarantine "not_posting"; keep "unknown" with a flag. */
(function (root) {
  "use strict";
  const VERSION = 1;

  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  function out(verdict, shape, reasons) { return { verdict, shape, reasons }; }

  // Discussion/forum item pages: a thread ABOUT a job is not a posting.
  const THREAD_SHAPES = [
    { host: /(^|\.)news\.ycombinator\.com$/, path: /^\/item\b/, why: "Hacker News item page (discussion thread)" },
    { host: /(^|\.)reddit\.com$/, path: /^\/r\/[^/]+\/comments\//, why: "Reddit thread" },
  ];
  // Job-board / ATS posting grammars (host + id-bearing path).
  const POSTING_SHAPES = [
    { re: /(^|\.)greenhouse\.io$/, path: new RegExp("/jobs?/\\d{5,}\\b"), why: "Greenhouse posting (board + numeric job id)" },
    { re: /(^|\.)ashbyhq\.com$/, path: new RegExp("/[^/]+/" + UUID + "$"), why: "Ashby posting (company + job uuid)" },
    { re: /(^|\.)lever\.co$/, path: new RegExp("/[^/]+/" + UUID), why: "Lever posting (company + job uuid)" },
    { re: /(^|\.)myworkdayjobs\.com$/, path: /\/job\//, why: "Workday posting (/job/ path)" },
    { re: /(^|\.)smartrecruiters\.com$/, path: /\/[^/]+\/\d{6,}/, why: "SmartRecruiters posting (company + numeric id)" },
    // SEARCH COVERAGE: the posting links of the other ATS boards ingest reads (they were all "unknown").
    { re: /(^|\.)workable\.com$/, path: /^\/j\/[A-Za-z0-9]{6,}/, why: "Workable posting (/j/<shortcode>)" },
    { re: /(^|\.)recruitee\.com$/, path: /^\/o\/[^/]+/, why: "Recruitee posting (/o/<slug>)" },
    { re: /(^|\.)personio\.(de|com)$/, path: /^\/job\/\d+/, why: "Personio posting (/job/<id>)" },
    { re: /(^|\.)teamtailor\.com$/, path: /^\/jobs\/\d+/, why: "Teamtailor posting (/jobs/<id>)" },
    { re: /(^|\.)breezy\.hr$/, path: /^\/p\/[0-9a-f]{8,}/, why: "Breezy posting (/p/<id>)" },
    { re: /(^|\.)bamboohr\.com$/, path: /^\/careers\/\d+/, why: "BambooHR posting (/careers/<id>)" },
    { re: /(^|\.)themuse\.com$/, path: /^\/jobs\/[^/]+\/[^/]+/, why: "The Muse posting (company + slug)" },
    { re: /(^|\.)arbeitnow\.[a-z.]+$/, path: /^\/jobs\/companies\/[^/]+\/[^/]+-\d{4,}$/, why: "Arbeitnow posting (company + slug-id)" },
    { re: /(^|\.)jobicy\.com$/, path: /^\/jobs\/\d{4,}(-|$)/, why: "Jobicy posting (numeric id)" },
    { re: /(^|\.)remoteok\.com$/, path: /^\/remote-jobs\/[^/]+-\d{5,}$/, why: "RemoteOK posting (slug + numeric id)" },
    { re: /(^|\.)remotive\.com$/, path: /^\/remote-jobs\/[^/]+\/[^/]+-\d{5,}$/, why: "Remotive posting (category + slug-id)" },
  ];
  // Board roots on the ATS hosts: a company board page lists many jobs; it is
  // not itself a posting.
  const BOARD_ROOT_HOSTS = [/(^|\.)greenhouse\.io$/, /(^|\.)lever\.co$/, /(^|\.)ashbyhq\.com$/];

  function classifyPostingUrl(raw) {
    if (raw == null || typeof raw !== "string" || !raw.trim()) {
      return out("not_posting", "invalid", ["empty or non-string URL"]);
    }
    let u;
    try { u = new URL(raw.trim()); } catch { return out("not_posting", "invalid", ["unparseable URL"]); }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return out("not_posting", "invalid", [`non-http(s) protocol: ${u.protocol}`]);
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    // 1) Data / API endpoints — machine-readable dataset or API responses.
    if (host.startsWith("api.") || /\/api\//.test(path)) {
      return out("not_posting", "api_endpoint", ["API endpoint host/path, not a posting page"]);
    }
    if (/\/resource\/[^/]+\.(json|xml|csv)$/i.test(path) || /\.(json|xml|csv)$/i.test(path)) {
      return out("not_posting", "api_endpoint", ["data-file URL (Socrata-style /resource/<dataset>.json or .json/.xml/.csv suffix)"]);
    }
    // 2) Discussion threads.
    for (const s of THREAD_SHAPES) {
      if (s.host.test(host) && s.path.test(path)) return out("not_posting", "thread", [s.why]);
    }
    // 3) Employer-hosted Greenhouse wrapper: the gh_jid query param IS the
    //    posting identity, and identity beats route naming — Stripe's real
    //    posting URLs are /jobs/search?gh_jid=<id> (audited 2026-10-20).
    //    This runs BEFORE the search-path rule but AFTER the API rule:
    //    a dataset endpoint carrying ?job_id= is still an endpoint (and
    //    job_id is not gh_jid).
    if (u.searchParams.has("gh_jid") && /^\d{5,}$/.test(u.searchParams.get("gh_jid") || "")) {
      return out("posting", "greenhouse_wrapper", ["gh_jid parameter carries the Greenhouse job id"]);
    }
    // 4) Search pages and board/listing roots.
    if (/\/(search|job-search)\b/.test(path)) {
      return out("not_posting", "search_or_listing", ["search page path"]);
    }
    if (BOARD_ROOT_HOSTS.some((re) => re.test(host)) && /^\/[^/]+\/?$/.test(path)) {
      return out("not_posting", "search_or_listing", ["ATS board root (company page, no job id)"]);
    }
    if (path === "/" || path === "") {
      return out("not_posting", "search_or_listing", ["site root, no posting path"]);
    }
    // 5) Recognized posting grammars.
    for (const s of POSTING_SHAPES) {
      if (s.re.test(host) && s.path.test(path)) return out("posting", "ats_posting", [s.why]);
    }
    // 6) Generic id-bearing job path on any other host.
    if (/\/(jobs?|postings?|openings?|positions?|vacancies|remote-jobs)\//.test(path)
        && (new RegExp(UUID, "i").test(path) || /-\d{5,}(\/|$)/.test(path) || /\/\d{6,}(\/|$)/.test(path))) {
      return out("posting", "generic_id_posting", ["job path carries a uuid / long numeric id segment"]);
    }
    // 7) Never promote an unrecognized shape.
    return out("unknown", "unclassified", ["no recognized posting grammar and no junk shape matched"]);
  }

  function isPostingUrl(raw) { return classifyPostingUrl(raw).verdict === "posting"; }

  const CareerUrlShape = { VERSION, classifyPostingUrl, isPostingUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = CareerUrlShape;
  root.CareerUrlShape = CareerUrlShape;
})(typeof globalThis !== "undefined" ? globalThis : this);
