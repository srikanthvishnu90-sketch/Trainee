// The hosted File list shows each role's REAL company logo, or initials: never a logo guessed from the company's name.
// Sources, in order: (1) the logo the ATS itself published for the posting's board (logo_url, https, matching an
// ATS_LOGO_RULES host+path rule); (2) the employer's own domain (company_domain / its own careers host) through the configured logo
// provider (TRAINEE_LOGO_URL); (3) the initials badge, no <img>. Logos off (a non-https provider) means none of them. Memory stores,
// no network.
import assertNode from "node:assert/strict";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { ATS_LOGO_RULES, atsLogoUrl } from "../../supabase/functions/_shared/page_csp.ts";
import { ATS_LOGO_RULES as JS_ATS_LOGO_RULES } from "../../api/_page_csp.js";
import { signedIn } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "file-link-secret-0123456789-abcdef", U = "11111111-1111-4111-8111-111111111111", LIST = "0123456789";
const NOW = Date.parse("2026-11-06T12:00:00Z"), A = signedIn();
const GH = "https://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/123/resized/logo.png";

// One list of three roles: 1 has an ATS logo, 2 only a company domain, 3 neither (a name that would "guess" as globex.com).
const hit = (n: number) => ({ job_id: `greenhouse:co${n}:${n}`, company: ["", "Initech", "Hooli", "Globex"][n], title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/co${n}/jobs/${n}`, pay: "$90k" });
const row = (n: number) => ({ job_id: `greenhouse:co${n}:${n}`, provider: "greenhouse", description: "<p>Build dashboards.</p>",
  logo_url: n === 1 ? GH : null, company_domain: n === 2 ? "hooli.com" : null });

async function page(envExtra: Record<string, string> = {}, rows = [1, 2, 3].map(row)) {
  const kv = new Map<string, any>();
  const store = {
    async remember(u: string, r: string, job: any, s: string) { kv.set(`${u}|job|${r}`, { job, shownAs: s }); }, async recall(u: string, r: string) { return kv.get(`${u}|job|${r}`) ?? null; },
    async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|list|${id}`, refs); }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return rows; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; }, async claimLink() { return true; },
  } as unknown as FileStore;
  const refs: string[] = [];
  for (const r of rows) { const n = Number(r.job_id.split(":").pop()); const v = jobViewOf(hit(n), r as any), ref = await refOf(U, v.job_id); refs.push(ref); await store.remember(U, ref, v, "text"); }
  await store.rememberList(U, LIST, refs);
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot", ...envExtra };
  const d = { ...A.deps, store, now: () => NOW, env: { get: (k: string) => env[k] } } as unknown as FileDeps;
  const t = await A.tok(U, LIST, NOW);
  const res = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${t}` } }), d);
  return { html: await res.text(), csp: res.headers.get("content-security-policy")!, status: res.status };
}
const rowOf = (h: string, company: string) => { const i = h.indexOf(`<span class="name">${company}</span>`); return h.slice(h.lastIndexOf('<li class="row"', i), i); };

Deno.test("a row with an ATS-published logo URL renders that image, with size, alt, lazy, no-referrer", async () => {
  const p = await page();
  eq(p.status, 200);
  const r = rowOf(p.html, "Initech");
  ok(r.includes(`<img src="${GH}" alt="Initech logo" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">`), r);
  ok(r.includes('class="lettermark"'), "the initials sit under the image, so nothing shifts if it fails to load");
});

Deno.test("a row with only a company domain renders the favicon URL for that domain (provider opted in)", async () => {
  const p = await page({ TRAINEE_LOGO_URL: "google" });
  ok(rowOf(p.html, "Hooli").includes(`<img src="https://www.google.com/s2/favicons?sz=128&amp;domain=hooli.com" alt="Hooli logo"`), rowOf(p.html, "Hooli"));
  const own = await page({ TRAINEE_LOGO_URL: "https://icons.duckduckgo.com/ip3/{domain}.ico" });
  ok(rowOf(own.html, "Hooli").includes(`src="https://icons.duckduckgo.com/ip3/hooli.com.ico"`));
  // default: served from the page's own origin, no third party
  ok((await page()).html.includes(`<img src="?logo=hooli.com" alt="Hooli logo"`));
});

Deno.test("a row with neither renders initials and no <img>; no logo is built from the company name", async () => {
  for (const env of [{}, { TRAINEE_LOGO_URL: "google" }]) {
    const r = rowOf((await page(env)).html, "Globex");
    ok(!r.includes("<img"), r);
    ok(/<span class="lettermark" aria-hidden="true">G<\/span>/.test(r));
    ok(!/globex/i.test(r.replace(/Globex/g, "")), "nothing derived from the name");
  }
});

Deno.test("CSP: img-src gains exactly the hosts of the ATS logos on the page, and only then", async () => {
  const withLogo = await page();
  eq(/img-src ([^;]+)/.exec(withLogo.csp)![1], "'self' https://s101-recruiting.cdn.greenhouse.io");
  const none = await page({}, [row(2), row(3)]);
  eq(/img-src ([^;]+)/.exec(none.csp)![1], "'self'");
  // an off-list host or a non-https URL is no logo (and adds no host)
  for (const bad of ["https://evil.example/logo.png", "http://s101-recruiting.cdn.greenhouse.io/a.png", "https://u:p@app.ashbyhq.com/a.png", "javascript:alert(1)", "https://app.ashbyhq.com:8443/a.png"]) {
    eq(atsLogoUrl(bad), null, bad);
    const p = await page({}, [{ ...row(1), logo_url: bad }, row(3)]);
    ok(!p.html.includes("<img") && eq(/img-src ([^;]+)/.exec(p.csp)![1], "'self'") === undefined, bad);
  }
});

Deno.test("api/_page_csp.js and page_csp.ts hold identical ATS logo rules, each anchored on host and path", () => {
  eq(JS_ATS_LOGO_RULES, ATS_LOGO_RULES);
  for (const r of ATS_LOGO_RULES) {
    ok(r.host.startsWith("^") && r.host.endsWith("$") && !r.host.includes("*") && !r.host.includes(".+"), r.host);
    ok(r.path.startsWith("^/"), r.path);
  }
});

Deno.test("ATS logo rules: the verified logo URLs pass; other paths, other buckets, http, userinfo and ports do not", () => {
  const good = [
    GH,
    "https://s3-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/1/resized/a.png",
    "https://s8-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/290/100/resized/logo.png?1700000000",
    "https://s9-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/9/resized/b.jpg",
    "https://lever-client-logos.s3.us-west-2.amazonaws.com/1ab6341d-336e-4824-850b-352af15419d6-1719943785653.png",
    "https://lever-client-logos.s3.amazonaws.com/f58a3dc7-cedb-410c-bd43-57c7bb06c2d7-1538756846592.png", // legacy bucket
    "https://app.ashbyhq.com/api/images/org-theme-logo/0c0ad039-c59c-4f86-b7ea-e7bebb8a8041/33531299-c352-4642-8992-b14bae985251/x.png",
    "https://c.smartrecruiters.com/sr-company-logo-prod-aws-dc5/607603f1f6e0434123deda49/huge?r=s3-eu-central-1&_1765898724298",
    "https://c.smartrecruiters.com/sr-company-logo-prod-dc5/607603f1f6e0434123deda49/150px?r=s3-eu-central-1",
  ];
  for (const u of good) eq(atsLogoUrl(u), new URL(u).href, u);
  const bad = [
    "https://s8-recruiting.cdn.greenhouse.io/job_board_renderer/custom_fonts/fonts/a.woff", // same host, not a logo
    "https://s8-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/a.png",
    "https://s12345-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/a.png", // five digits
    "https://job-boards.cdn.greenhouse.io/external_greenhouse_job_boards/logos/a.png",
    "https://s8-recruiting.cdn.greenhouse.io.evil.example/external_greenhouse_job_boards/logos/a.png",
    "https://evil-lever-client-logos.s3.amazonaws.com/a.png",
    "https://lever-client-logos.s3.eu-west-1.amazonaws.com/a.png",
    "https://app.ashbyhq.com/api/images/org-theme-wordmark/0c0ad039/33531299/x.png", // off-prefix Ashby
    "https://app.ashbyhq.com/api/images/org-theme-social/0c0ad039/x.png",
    "https://app.ashbyhq.com/api/images/org-theme-logo/../custom-css/x.css", // resolves off-prefix
    "https://app.ashbyhq.com/api/images/org-theme-logo%2F..%2Fcustom-css/x",
    "https://c.smartrecruiters.com/sr-company-images-prod-aws-dc5/58652035e4b04016904de9fe/default_social_logo/300x300?r=s3-eu-central-1", // og:image
    "https://c.smartrecruiters.com/sr-jobad/static/8.102.0/logo.png",
    "http://s8-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/1/a.png", // http
    "https://u:p@app.ashbyhq.com/api/images/org-theme-logo/a/b/c.png", // userinfo
    "https://user@lever-client-logos.s3.amazonaws.com/a.png",
    "https://c.smartrecruiters.com:8443/sr-company-logo-prod-dc5/1/150px", // port
    "https://lever-client-logos.s3.amazonaws.com:443x/a.png",
    "//lever-client-logos.s3.amazonaws.com/a.png", "javascript:alert(1)", "", null, 42,
  ];
  for (const u of bad) eq(atsLogoUrl(u), null, String(u));
});

Deno.test("logos off (a non-https provider): a row with an allowed ATS logo shows no image and the CSP gains no host", async () => {
  for (const off of ["off", "none", "http://icons.example/{domain}.ico"]) {
    const p = await page({ TRAINEE_LOGO_URL: off });
    eq(p.status, 200);
    ok(!p.html.includes("<img"), `${off}: no image of any kind`);
    ok(!p.html.includes("greenhouse.io/external"), off);
    eq(/img-src ([^;]+)/.exec(p.csp)![1], "'none'", off);
    ok(!p.csp.includes("greenhouse"), off);
  }
});

Deno.test("CSP names the exact hostname of each ATS logo used (s8 here), never a pattern", async () => {
  const s8 = "https://s8-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/290/100/resized/logo.png";
  const lv = "https://lever-client-logos.s3.amazonaws.com/f58a3dc7-cedb-410c-bd43-57c7bb06c2d7-1538756846592.png";
  const p = await page({}, [{ ...row(1), logo_url: s8 }, { ...row(2), logo_url: lv }, row(3)]);
  eq(/img-src ([^;]+)/.exec(p.csp)![1], "'self' https://s8-recruiting.cdn.greenhouse.io https://lever-client-logos.s3.amazonaws.com");
  ok(!p.csp.includes("*.greenhouse") && !p.csp.includes("*.amazonaws"));
});
