// The hosted File list shows each role's REAL company logo, or initials: never a logo guessed from the company's name.
// Sources, in order: (1) the logo the ATS itself published for the posting's board (logo_url, https, on an ATS_LOGO_HOSTS host);
// (2) the employer's own domain (company_domain / its own careers host) through the configured logo provider (TRAINEE_LOGO_URL);
// (3) the initials badge, no <img>. Memory stores, no network.
import assertNode from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { ATS_LOGO_HOSTS, atsLogoUrl } from "../../supabase/functions/_shared/page_csp.ts";
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

Deno.test("api/_page_csp.js and page_csp.ts list the same ATS logo hosts, all exact hostnames", () => {
  const js = readFileSync(new URL("../../api/_page_csp.js", import.meta.url), "utf8");
  const listed = [...(/ATS_LOGO_HOSTS = \[([\s\S]*?)\]/.exec(js)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  eq(listed, ATS_LOGO_HOSTS);
  ok(ATS_LOGO_HOSTS.every((h) => /^[a-z0-9.-]+$/.test(h) && !h.includes("*")));
});
