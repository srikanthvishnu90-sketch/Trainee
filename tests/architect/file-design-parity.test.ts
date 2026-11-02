// The owner's parity audit (Nov 1, 2026), File rows R06, R14-R17 and design criteria D01-D10, as checks on the shared File parts
// (file_design.ts), the File kinds (file_kinds.ts), the same-origin logo cache (logo_cache.ts) and the trainee-file handler. The
// pixel half (spacing, type sizes, one plum ground per card, focus and hover, 390 and 1280 px) is file-design-parity-browser.test.ts.
// Brand plum stays #5C2751 (owner: "keep the current color"); synthetic people and companies only.
import assertNode from "node:assert/strict";
import { contrast, PLUM, TOKENS_CSS } from "../../supabase/functions/_shared/brand.ts";
import { FILE_SOURCES, jobCardHtml, rowsSectionHtml, stated, totalOf, UNKNOWN, unknown, valueHtml, verified, type Value } from "../../supabase/functions/_shared/file_design.ts";
import { bodyHtml, SOURCES, validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import { fetchLogo, MAX_BYTES, memoryLogoCache, sniff, validDomain } from "../../supabase/functions/_shared/logo_cache.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-11-01T21:30:00Z");
const SECRET = "file-link-secret-0123456789-abcdef";

// ================================================================== R17: a source chip on every fact; creation refuses an unsourced one
const SAMPLES: Record<string, any> = {
  introduction: { title: "Intro to Dana", person: { name: "Dana Lee", role: "Analytics Manager", company: "Acme", source: "Reported, not verified" },
    why: [{ text: "You built pricing dashboards in SQL.", source: "From your resume" }, { text: "Acme is hiring a Data Analyst.", source: "From the posting" }, { text: "You want a growth-team role.", source: "From you" }],
    message: { channel: "email", subject: "A question about analytics at Acme", body: "Hi Dana, I build pricing dashboards and saw Acme is hiring. Could I ask two questions about the team?" } },
  plan_review: { title: "Your week", variant: "pipeline", sections: [{ heading: "Applications", items: [{ label: "Submitted", value: "4", source: "From you" }, { label: "Confirmed", value: "2", source: "Reported, not verified" }] }] },
  comparison: { title: "Acme vs Globex", options: [{ name: "Acme" }, { name: "Globex" }], rows: [{ label: "Base pay", cells: [{ value: "$90k", source: "From the posting" }, { value: "$95k", source: "Reported, not verified" }] }] },
  draft: { title: "Cover letter", type: "cover_letter", body: "Dear Acme team,\n\nI build weekly pricing dashboards in SQL.\n\nAda", basis: [{ label: "Experience", value: "Pricing dashboards in SQL", source: "From your resume" }] },
  research_brief: { title: "Acme research", subject: "Acme", findings: [{ label: "Product", value: "Pricing analytics", source: "Reported, not verified" }], sources: [{ title: "About", url: "https://acme.example/about" }] },
};
// The path to each sample's facts, so the source can be removed from exactly one of them.
const FACT_PATHS: Record<string, (d: any) => any> = {
  introduction: (d) => d.why[0], plan_review: (d) => d.sections[0].items[0], comparison: (d) => d.rows[0].cells[0], draft: (d) => d.basis[0], research_brief: (d) => d.findings[0],
};

Deno.test("R17: every File kind refuses a fact with no source, or a source that isn't one of the labels, at creation", () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    ok(validateKind(kind, structuredClone(sample)).ok, `${kind}: the sourced sample is accepted`);
    for (const bad of [undefined, "", "Trust me", "from the posting "]) {
      const d = structuredClone(sample); const f = FACT_PATHS[kind](d);
      if (bad === undefined) delete f.source; else f.source = bad;
      ok(!validateKind(kind, d).ok, `${kind}: a fact with source ${JSON.stringify(bad)} is refused`);
    }
  }
});

Deno.test("R17: every fact a File kind renders carries its source chip", () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const v = validateKind(kind, structuredClone(sample)) as { ok: true; data: any };
    const rec: FileRecord = { id: "0123456789", userId: U, kind: kind as never, data: v.data, state: {}, tag: kind === "introduction" ? "0123456789abcdef" : null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null };
    const h = bodyHtml(rec, "t");
    const facts = (h.match(/<dd>/g) ?? []).length + (h.match(/<li>[^<]*<span class="src">/g) ?? []).length + (h.match(/<td>/g) ?? []).length;
    const chips = (h.match(/<span class="src">(From the posting|From your resume|From you|Reported, not verified|From Trainee&#39;s records)<\/span>/g) ?? []).length;
    ok(facts > 0 && chips >= facts - (h.match(/<td><span class="meta">Not stated<\/span><\/td>/g) ?? []).length, `${kind}: ${chips} chips for ${facts} facts`);
  }
});

Deno.test("R17: a shared File value is a fact only with its source; without one it is drawn as Unverified", () => {
  for (const s of SOURCES) ok((FILE_SOURCES as readonly string[]).includes(s), `the File kinds' label "${s}" is a File source`);
  ok(valueHtml(stated("$30/hr", "From the posting")).includes(`<span class="fsrc">From the posting</span>`));
  for (const bad of [undefined, "", "Trust me"]) {
    const h = valueHtml({ kind: "verified", text: "$30/hr", source: bad } as unknown as Value);
    eq(h, `<span class="v v-unknown" data-v="unknown">Unverified</span>`, `source ${JSON.stringify(bad)}`);
  }
  // The job card's deciding facts each carry their chip; an unknown carries none (it is not a fact).
  const c = jobCardHtml({ company: "Acme", title: "Data Analyst Intern", pay: stated("$32/hr", "From the posting"), location: stated("Chicago, IL", "From the posting"), posted: unknown(UNKNOWN.postedNotGiven), action: null });
  eq((c.match(/class="fsrc"/g) ?? []).length, 2);
});

// ================================================================== D08: caveats wherever data is incomplete; no totals from partial data
Deno.test("D08: a total only from complete, same-unit, sourced amounts; otherwise no total, and the caveat says how many are missing", () => {
  const p = (t: string) => stated(t, "From Trainee's records");
  const full = totalOf([p("$20"), p("$15.95"), p("$1,000")]);
  eq(full.caveat, null); eq(full.value, stated("$1,035.95", "Added up from the rows above"));
  eq(totalOf([p("$30/hr"), p("$32/hr")]).value, stated("$62/hr", "Added up from the rows above"));
  const part = totalOf([p("$20"), unknown(UNKNOWN.amountUnknown), p("$15")]);
  eq(part.value, unknown("No total")); eq(part.caveat, "1 of 3 amounts isn't known, so there is no total.".replace("amounts isn't", "amount isn't"));
  eq(totalOf([p("$20"), unknown(), unknown()]).caveat, "2 of 3 amounts aren't known, so there is no total.");
  eq(totalOf([p("$20"), p("$30/hr")]).value, unknown("No total"), "mixed units");
  eq(totalOf([p("$20"), { kind: "stated", text: "$5", source: "nobody" } as unknown as Value]).value, unknown("No total"), "an unsourced amount");
  eq(totalOf([]).value, unknown("No total"));
  eq(totalOf([p("about $20")]).value, unknown("No total"), "a fuzzy amount is not added");
});

Deno.test("D08: a rows section with unknowns and no caveat gets one, directly above the rows; a complete section gets none", () => {
  const items = [{ name: "Acme", value: stated("$32/hr", "From the posting") }, { name: "Globex", value: unknown(UNKNOWN.payNotListed) }];
  const h = rowsSectionHtml("Pay", items);
  ok(h.includes(`<aside class="caveat" role="note">1 of 2 isn&#39;t known, so it is shown as unknown rather than guessed.</aside><ol class="nrows">`), h);
  ok(!rowsSectionHtml("Pay", [items[0]]).includes("caveat"));
  ok(rowsSectionHtml("Pay", items, { text: "Globex lists no pay." }).includes(">Globex lists no pay.</aside>"), "the caller's caveat wins");
  eq(rowsSectionHtml("Pay", []), "");
});

// ================================================================== D01 closed state; D06 one primary action per File
Deno.test("D01: a closed posting's card offers no action and says Closed where the action would be", () => {
  const c = jobCardHtml({ company: "Initech", title: "Analyst Intern", pay: unknown(), location: unknown(), posted: unknown(), closed: true, action: { href: "https://jobs.example/1", label: "Apply" } });
  ok(!c.includes(`class="apply`) && !c.includes("https://jobs.example/1"), "no Apply on a closed posting");
  ok(c.includes(`<article class="jcard jcard-closed">`) && c.includes(`<p class="jclosed" role="status"><span class="v v-unknown" data-v="unknown">Closed</span> This posting is no longer taking applications.</p>`));
});

Deno.test("D06: every File kind draws at most ONE primary (plum) button; the rest are secondary", () => {
  const recs: [string, any, Record<string, any>][] = [["introduction", SAMPLES.introduction, {}], ["draft", SAMPLES.draft, {}]];
  const proof = validateKind("application_proof", { from_record: true, title: "Application to Acme", company: "Acme", role: "Data Analyst", status: "submitted", prepared_at: "2026-10-30T14:00:00Z", submitted_at: "2026-10-30T15:04:00Z", as_of: "2026-10-30T15:05:00Z", answers: [], problems: [] }, { trusted: true, now: NOW }) as { ok: true; data: any };
  ok(proof.ok, JSON.stringify(proof));
  recs.push(["application_proof", proof.data, {}]);
  for (const [kind, data] of recs) {
    const d = kind === "application_proof" ? data : (validateKind(kind, structuredClone(data)) as { ok: true; data: any }).data;
    const h = bodyHtml({ id: "0123456789", userId: U, kind: kind as never, data: d, state: {}, tag: "0123456789abcdef", created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null }, "t");
    const primary = (h.match(/class="btn"/g) ?? []).length, all = (h.match(/class="btn( ghost)?"/g) ?? []).length;
    ok(primary <= 1, `${kind}: ${primary} primary buttons`);
    if (all) eq(primary, 1, `${kind}: its first action is the primary`);
  }
});

// ================================================================== D10: contrast recomputed from the SHIPPED CSS, both schemes, no rounding
Deno.test("D10: every File text/ground pair, read back from the shipped TOKENS_CSS, is at least 4.5:1 (no rounding), light and dark", () => {
  const block = (css: string) => Object.fromEntries([...css.matchAll(/--([a-z-]+):(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const [light, dark] = [block(TOKENS_CSS.split("@media")[0]), block(TOKENS_CSS.split("@media")[1])];
  eq(light.accent, PLUM, "the shipped plum is #5C2751");
  for (const [scheme, t] of [["light", light], ["dark", dark]] as const) {
    for (const g of ["bg", "card", "tint", "panel"]) for (const f of ["ink", "mute", "link", "verified"]) {
      const r = contrast(t[f], t[g]);
      ok(r >= 4.5, `${scheme}: ${f} ${t[f]} on ${g} ${t[g]} is ${r}:1`);
    }
    ok(contrast(t["accent-ink"], t.accent) >= 7, `${scheme}: action text on plum`);
  }
});

// ================================================================== R16: logos only from the employer's own domain, else a lettermark
const png = () => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const fakeFetch = (routes: Record<string, () => Response>, seen: string[]) => (async (u: string | URL | Request, init?: RequestInit) => {
  const url = String(u); seen.push(url);
  ok(init?.redirect === "manual", "redirects are never followed");
  return (routes[url] ?? (() => new Response("", { status: 404 })))();
}) as typeof fetch;

Deno.test("R16 logo cache: only the employer's own https host, real images by their bytes, capped, no redirects, cached hits and misses", async () => {
  for (const d of ["acme.com", "careers.acme.co.uk"]) ok(validDomain(d), d);
  for (const d of ["localhost", "127.0.0.1", "10.0.0.1", "acme", "acme.local", "a..b.com", "evil.com/x", "acme.com:8080", ""]) ok(!validDomain(d), d);
  eq(sniff(png()), "image/png"); eq(sniff(new Uint8Array([0, 0, 1, 0, 1])), "image/x-icon"); eq(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0])), "image/jpeg");
  eq(sniff(new TextEncoder().encode("<svg onload=alert(1)>")), null, "never SVG"); eq(sniff(new TextEncoder().encode("<html>")), null);
  const seen: string[] = [], cache = memoryLogoCache();
  const f = fakeFetch({ "https://acme.com/apple-touch-icon.png": () => new Response(png(), { status: 200, headers: { "content-type": "text/html" } }) }, seen);
  const got = await fetchLogo("acme.com", { fetch: f, cache, now: NOW });
  eq(got?.type, "image/png", "the type is the bytes', not the server's header");
  eq(seen, ["https://acme.com/apple-touch-icon.png"]);
  await fetchLogo("acme.com", { fetch: f, cache, now: NOW + 1000 }); eq(seen.length, 1, "a hit is cached");
  // A redirect elsewhere, an SVG and an oversized file are misses; the miss is cached for a day.
  const seen2: string[] = [];
  const f2 = fakeFetch({
    "https://globex.com/apple-touch-icon.png": () => new Response("", { status: 302, headers: { location: "https://tracker.example/x.png" } }),
    "https://globex.com/favicon.ico": () => new Response(new TextEncoder().encode("<svg/>"), { status: 200 }),
    "https://big.com/apple-touch-icon.png": () => { const b = new Uint8Array(MAX_BYTES + 1); b.set(png()); return new Response(b, { status: 200 }); },
  }, seen2);
  eq(await fetchLogo("globex.com", { fetch: f2, cache, now: NOW }), null);
  eq(await fetchLogo("big.com", { fetch: f2, cache, now: NOW }), null);
  ok(seen2.every((u) => /^https:\/\/(globex|big)\.com\//.test(u)), `only the employer's own host: ${seen2}`);
  const n = seen2.length; await fetchLogo("globex.com", { fetch: f2, cache, now: NOW + 3600_000 }); eq(seen2.length, n, "a miss is cached");
  await fetchLogo("globex.com", { fetch: f2, cache, now: NOW + 2 * 86_400_000 }); ok(seen2.length > n, "and retried after a day");
  eq(await fetchLogo("localhost", { fetch: f2, cache, now: NOW }), null);
});

async function jobsWorld(env: Record<string, string | undefined>) {
  const A = signedIn(), LIST = "0123456789", kv = new Map<string, unknown>(), seen: string[] = [];
  const post = (n: number) => ({ job_id: `greenhouse:acme:${n}`, provider: "greenhouse", company: n === 1 ? "Acme" : "Globex", title: "Data Analyst", location: "Chicago, IL", url: `https://boards.greenhouse.io/acme/jobs/${n}`,
    description: "<p>Build dashboards.</p>", pay: "$30/hr", closed_at: null, first_seen_at: "2026-10-30T10:00:00Z", posted_at: "2026-10-30T10:00:00Z", last_seen_at: "2026-11-01T21:08:00Z", company_domain: n === 1 ? "acme.com" : null });
  const store = { async remember(u: string, ref: string, job: unknown) { kv.set(`${u}|${ref}`, { job }); }, async recall(u: string, ref: string) { return kv.get(`${u}|${ref}`) ?? null; }, async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|l|${id}`, refs); },
    async recallList(u: string, id: string) { return kv.get(`${u}|l|${id}`) ?? null; }, async postings(ids: string[]) { return ids.map((id) => post(Number(id.split(":").pop()))); }, async save() { return "saved"; }, async prepared() { return null; },
    async applied() { return false; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
  const refs: string[] = [];
  for (const n of [1, 2]) { const ref = await refOf(U, `greenhouse:acme:${n}`); refs.push(ref); await store.remember(U, ref, jobViewOf({ job_id: `greenhouse:acme:${n}`, company: post(n).company, title: "Data Analyst", url: post(n).url, company_domain: post(n).company_domain } as never, post(n) as never), "text"); }
  await store.rememberList(U, LIST, refs);
  const f = fakeFetch({ "https://acme.com/apple-touch-icon.png": () => new Response(png(), { status: 200 }) }, seen);
  const d = { ...A.deps, store, now: () => NOW, env: { get: (k: string) => env[k] }, cards: { async open() { return null; } }, tap: {} as never, logoFetch: f, logoCache: memoryLogoCache() } as unknown as FileDeps;
  return { d, seen, tok: await A.tok(U, LIST, NOW) };
}

Deno.test("R16 jobs File with TRAINEE_LOGO_URL=self: logos come from the page's own origin; img-src 'self'; only domains on the person's own list", async () => {
  const w = await jobsWorld({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_LOGO_URL: "self" });
  const get = (q = "", cookie = `tf_s=${w.tok}`) => handleFile(new Request(`https://trainee.example/file${q}`, { headers: { cookie } }), w.d);
  const page = await get(), h = await page.text();
  ok(h.includes(`<img src="?logo=acme.com"`), "the employer's own domain, through this origin");
  ok(!/<img src="https?:/.test(h), "no third-party image on the page");
  ok(/<span class="lettermark" aria-hidden="true">G<\/span><\/span>/.test(h), "no own domain: the lettermark, no image");
  eq(/img-src ([^;]+)/.exec(page.headers.get("content-security-policy")!)![1], "'self'");
  const img = await get("?logo=acme.com");
  eq(img.status, 200); eq(img.headers.get("content-type"), "image/png"); ok(/default-src 'none'; sandbox/.test(img.headers.get("content-security-policy")!));
  eq(w.seen, ["https://acme.com/apple-touch-icon.png"], "fetched by the server from the employer's own host");
  for (const q of ["?logo=globex.com", "?logo=tracker.example", "?logo=127.0.0.1", "?logo=localhost"]) eq((await get(q)).status, 404, `${q}: not on this person's list`);
  eq(w.seen.length, 1, "nothing else was fetched");
  ok([401, 403].includes((await get("?logo=acme.com", "")).status), "no session, no logo");
});

// ================================================================== R06/D07, D09: every hosted File: one page-level checked line; private metas
Deno.test("R06/D07 + D09: every hosted File kind has exactly one page-level checked-at line under its one title, and carries the private metas", async () => {
  const A = signedIn(), env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => env[k] }, now: () => NOW });
  const stub = { async recallList() { return null; }, async recall() { return null; } } as unknown as FileStore;
  const d = { ...A.deps, store: stub, now: () => NOW, env: { get: (k: string) => env[k] }, cards: { async open() { return null; } }, tap: {} as never, files: svc, timeZone: async () => "America/Chicago" } as unknown as FileDeps;
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const m = await svc.create(U, kind, structuredClone(sample)) as { ok: boolean; id: string };
    ok(m.ok, kind);
    const r = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await A.tok(U, m.id, NOW)}` } }), d);
    const h = await r.text();
    eq((h.match(/<p class="stamp" data-stamp="known">/g) ?? []).length, 1, `${kind}: one checked-at line`);
    ok(/<\/h1><p class="stamp" data-stamp="known">Facts as of Nov 1, 2026, 3:30 PM CT<\/p>/.test(h), `${kind}: directly under the title`);
    ok(h.includes(`<meta name="robots" content="noindex,nofollow">`) && h.includes(`<meta name="referrer" content="no-referrer">`), `${kind}: private metas`);
    eq(r.headers.get("referrer-policy"), "no-referrer"); ok(/noindex/.test(r.headers.get("x-robots-tag")!));
  }
});

Deno.test("R16: employer-domain default. With no logo setting, no File's HTML or CSP references Google's favicon service or any third-party image host", async () => {
  const w = await jobsWorld({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file" });
  const r = await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${w.tok}` } }), w.d);
  const h = await r.text(), csp = r.headers.get("content-security-policy")!;
  ok(!/google\.com\/s2|s2\/favicons|[a-z0-9-]+\.gstatic\.com\/favicon/.test(h) && !/<img src="https?:/.test(h), "the jobs File references no Google favicon");
  eq(/img-src ([^;]+)/.exec(csp)![1], "'self'");
  ok(h.includes(`<img src="?logo=acme.com"`) && !/<img src="https?:/.test(h), "the employer's own domain, through the page's own origin");
  eq((await handleFile(new Request("https://trainee.example/file?logo=acme.com", { headers: { cookie: `tf_s=${w.tok}` } }), w.d)).status, 200);
  eq(w.seen, ["https://acme.com/apple-touch-icon.png"], "fetched from the employer, by the server");
  // Every other File kind too.
  const A = signedIn(), env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => env[k] }, now: () => NOW });
  const d = { ...A.deps, store: { async recallList() { return null; }, async recall() { return null; } } as unknown as FileStore, now: () => NOW, env: { get: (k: string) => env[k] }, cards: { async open() { return null; } }, tap: {} as never, files: svc } as unknown as FileDeps;
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const m = await svc.create(U, kind, structuredClone(sample)) as { id: string };
    const kr = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await A.tok(U, m.id, NOW)}` } }), d);
    ok(!/google\.com\/s2|s2\/favicons/.test(await kr.text()) && !/img-src[^;]*google/.test(kr.headers.get("content-security-policy")!), kind);
  }
  // Opt-in only: TRAINEE_LOGO_URL=google.
  const g = await jobsWorld({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_LOGO_URL: "google" });
  ok((await (await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${g.tok}` } }), g.d)).text()).includes("https://www.google.com/s2/favicons?sz=128&amp;domain=acme.com"));
});
