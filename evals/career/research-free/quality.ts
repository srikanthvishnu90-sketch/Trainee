// R9 free sources (owner, 2026-11-08): the brutal File quality check, at $0. Thirty research brief Files over the e2e eval world
// (generate.ts: the research.employer, research.market, research.pay and research.compare families, in seed order), each made the
// way the product makes it with no search key: research_market's researchMarket with the FREE provider and the FREE reader
// (research_free_sources.ts: every free source proposed, every hop's resolved address checked, robots.txt read), the eval's
// deterministic research draft (fake_model.ts marketDraft: the fake model, no spend), and the File service's own validation and
// renderer (file_kinds.ts bodyHtml inside the trainee-file shell). The web is the eval's stub web (web.ts): every other host 404s,
// as in the eval, so the free sources that are not stubbed show up as gaps on the brief.
//
// Each brief's page is opened in Chromium at 390 px and 1280 px (light), screenshotted at deviceScaleFactor 2 into
// tests/architect/snapshots/research-free/, and scored on the rubric below. Failures are reported, never hidden: the report is
// tests/architect/snapshots/research-free/REPORT.md (and report.json).
//
//   R1 cited       every summary line, table cell, condition and risk names at least one source; every number on the page
//                  (outside the cover's source count and read date, and the sources list) sits in a cited line, or in the
//                  title/thesis with that number on a cited source page.
//   R2 plum        plum (brand.ts accent) only on links, buttons and the mark: no plum text outside a link, no plum ground
//                  outside the mark.
//   R3 order       the sections appear in the fixed order Summary, Comparison, What would have to be true, Risks, Not found in a
//                  free source, Sources; Summary, What would have to be true, Risks and Sources are always there.
//   R4 layout      no sideways scroll at either width, no element past the card's edge, no empty section, no empty list item.
//   R5 readable    at 390 px: fact text at least 16 px, nothing under 13 px, every text at least WCAG AA on its ground, every tap
//                  target at least 44 px tall.
// A task whose brief could not be made (the tool fell back to an inline answer) fails every rubric line.
//
//   deno run -A --no-check evals/career/research-free/quality.ts [--n 30] [--no-shots]
// deno-lint-ignore-file no-explicit-any require-await
import { createRequire } from "node:module";
import { generate, SEED } from "../e2e/generate.ts";
import { addStubPages, freeFixtureFetch, isFreeFixtureHost, isStubWebHost, stubWebFetch } from "../e2e/web.ts";
import { marketDraft } from "../tasks/fake_model.ts";
import { marketDraftPayload, type MarketResult, researchMarket } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { freeProvider, freeReader } from "../../../supabase/functions/_shared/research_free_sources.ts";
import { bodyHtml, type FileRecord, KIND_CSS, validateKind } from "../../../supabase/functions/_shared/file_kinds.ts";
import { fileShellHtml } from "../../../supabase/functions/_shared/file_design.ts";
import { layout } from "../../../supabase/functions/_shared/file_page.ts";
import { LIGHT } from "../../../supabase/functions/_shared/brand.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const OUT = `${ROOT}tests/architect/snapshots/research-free`;
const NOW = Date.parse("2026-11-08T15:00:00Z");
const args = Deno.args, flag = (k: string) => args.includes(k), val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const N = Number(val("--n") ?? 30), SHOTS = !flag("--no-shots");
const FAMILIES = ["research.employer", "research.market", "research.pay", "research.compare"];
export const SECTION_ORDER = ["Summary", "Comparison", "Where the sources differ", "What would have to be true", "Risks", "How the sources were chosen", "Not found in a free source", "Sources"];
const REQUIRED = ["Summary", "What would have to be true", "Risks", "Sources"];

// The eval world's web, as run.ts serves it: the stub sites and the free sources' fixtures answer, every other host 404s; those
// hosts resolve to a public documentation address and every other name has no answer.
const web = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  const h = new URL(req.url).hostname;
  return isFreeFixtureHost(h) ? freeFixtureFetch(req) : isStubWebHost(h) ? stubWebFetch(req) : new Response("not reachable in the e2e eval", { status: 404 });
}) as typeof fetch;
const resolver = async (h: string) => { if (isStubWebHost(h) || isFreeFixtureHost(h)) return ["203.0.113.80"]; throw new Error("no answer"); };

// Thirty tasks, round-robin over the four families in the generated set's order (8, 8, 7, 7).
export function pickTasks(n = N) {
  const g = generate(SEED), by = FAMILIES.map((f) => g.full.filter((t: any) => t.area === "research" && t.family === f));
  const out: any[] = [];
  for (let i = 0; out.length < n && i < 100; i++) for (const xs of by) if (xs[i] && out.length < n) out.push(xs[i]);
  return out;
}
function pageOf(rec: FileRecord): string {
  return layout(`${rec.data.title} - Trainee`, `<div id="root">${fileShellHtml({ made: "Made for you · Nov 8, 2026", eyebrow: "Research brief", title: rec.data.title, stamp: "Facts as of Nov 8, 2026", body: bodyHtml(rec, "fs1." + "a".repeat(64)) })}</div>`, { css: KIND_CSS });
}

export async function makeBrief(t: any): Promise<{ result: MarketResult; record: FileRecord | null; error: string | null; pages: Record<string, string> }> {
  addStubPages(t.pages ?? {});
  const m = t.turns.at(-1), step = t.oracle[m].find((s: any) => s.capability === "research.market"), a = step.args;
  // The brain's call as the fake model makes it, plus the companies a person named (employer and compare), so the free company
  // sources (ATS boards, Wikipedia, GitHub, news, SEC) are all asked.
  const companies = t.family === "research.employer" || t.family === "research.compare" ? (t.expect?.research?.has ?? []) : (a.companies ?? []);
  let record: FileRecord | null = null, error: string | null = null;
  const read = freeReader({ fetch: web, resolver, now: () => NOW });
  const seenPages: Record<string, string> = {};
  const result = await researchMarket({ question: m, format: "file", plan: { queries: [m], sites: a.sites ?? [], companies },
    deps: {
      search: freeProvider({ fetch: web, now: () => NOW, userAgent: "TraineeBot e2e eval (stub world, no real contact)" }),
      read: async (urls) => { const r = await read(urls); for (const p of r.verified) seenPages[p.url] = p.text; return r; },
      draft: async (p) => JSON.stringify(marketDraft(p.messages[0].content)),
      publish: async (data) => {
        const v = validateKind("research_brief", data, { now: NOW });
        if (!v.ok) { error = v.errors.join("; "); return null; }
        record = { id: t.id, userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 86400_000, revoked_at: null } as FileRecord;
        return { url: `https://file.e2e.test/f/${t.id}` };
      },
    } });
  void marketDraftPayload;
  return { result, record, error, pages: seenPages };
}

// R1 and R3 from the File's data (the renderer is checked in the browser for the rest).
const NUM = /\$?\d[\d,]*(?:\.\d+)?%?/g;
export function dataChecks(d: any, pages: Record<string, string>): { r1: string[]; r3: string[] } {
  const r1: string[] = [], n = (d.sources ?? []).length;
  const lines: [string, any][] = [...(d.summary ?? []).map((x: any, i: number) => [`summary[${i}]`, x]), ...(d.conditions ?? []).map((x: any, i: number) => [`conditions[${i}]`, x]), ...(d.risks ?? []).map((x: any, i: number) => [`risks[${i}]`, x])];
  for (const r of d.comparison?.rows ?? []) r.cells.forEach((c: any, j: number) => { if (c) lines.push([`cell ${r.label}/${j}`, { text: c.value, cite: c.cite }]); });
  for (const [k, x] of lines) {
    if (!Array.isArray(x.cite) || !x.cite.length || x.cite.some((c: number) => !(c >= 1 && c <= n))) r1.push(`${k} has no valid citation`);
  }
  const cited = (d.sources ?? []).map((s: any) => pages[s.url] ?? "").join("\n");
  for (const [k, s] of [["title", d.title], ["thesis", d.thesis]] as const) for (const num of String(s ?? "").match(NUM) ?? []) if (!cited.includes(num.replace(/^\$/, ""))) r1.push(`${k} has a number no cited source states: ${num}`);
  const h: string[] = ["Summary", ...(d.comparison ? ["Comparison"] : []), "What would have to be true", "Risks", ...(d.gaps?.length ? ["Not found in a free source"] : []), "Sources"];
  return { r1, r3: h.length ? [] : ["no sections"] };
}

export const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr"); };
  const name = (el) => el.tagName.toLowerCase() + "." + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "") + " '" + (el.textContent || "").trim().slice(0, 40) + "'";
  const card = document.querySelector(".fcard"), cr = card ? card.getBoundingClientRect() : { left: 0, right: innerWidth };
  const texts = [], over = [], grounds = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (card && card.contains(el) && (r.right > cr.right + 0.5 || r.left < cr.left - 0.5) && !el.closest(".sr")) over.push(name(el));
    const bg = rgb(getComputedStyle(el).backgroundColor); if (bg && bg.a > 0.5) grounds.push({ el: name(el), c: bg.c, mark: !!el.closest("svg") });
    if (el.closest("svg") || ["SCRIPT","STYLE"].includes(el.tagName) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    texts.push({ el: name(el), color: rgb(getComputedStyle(el).color).c, ground: ground(el), link: !!el.closest("a,button"), size: parseFloat(getComputedStyle(el).fontSize), fact: !!el.closest(".rb-t,.rb-v,.rb-thesis") && !el.closest(".rb-cite") });
  }
  const fills = [...document.querySelectorAll("svg rect, svg path, svg circle")].filter((e) => !e.closest(".rb-mark,.mark,.brand")).map((e) => ({ el: name(e), fill: getComputedStyle(e).fill }));
  const taps = [...document.querySelectorAll("a[href],button")].filter(vis).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const heads = [...document.querySelectorAll("section.blk > h2")].map((h) => h.textContent.trim());
  const empty = [...document.querySelectorAll("section.blk")].filter((s) => !(s.textContent || "").replace((s.querySelector("h2") || {}).textContent || "", "").trim()).map((s) => (s.querySelector("h2") || {}).textContent);
  const emptyLi = [...document.querySelectorAll("section.blk li")].filter((l) => !(l.textContent || "").trim()).length;
  return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, texts, over, grounds, fills, taps, heads, empty, emptyLi };
})()`;
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgbOf = (hex: string) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const PLUMS = [LIGHT.accent, LIGHT.accentHover, LIGHT.link].map(rgbOf);
const isPlum = (c: number[]) => PLUMS.some((p) => near(c, p));

export function browserChecks(m: any, width: number): { r2: string[]; r3: string[]; r4: string[]; r5: string[] } {
  const r2: string[] = [], r3: string[] = [], r4: string[] = [], r5: string[] = [];
  for (const x of m.texts) if (isPlum(x.color) && !x.link) r2.push(`plum text outside a link: ${x.el}`);
  for (const g of m.grounds) if (isPlum(g.c) && !g.mark && !/^(a|button)\./.test(g.el)) r2.push(`plum ground: ${g.el}`);
  for (const f of m.fills) { const c = (/rgb\(([^)]+)\)/.exec(f.fill)?.[1] ?? "").split(/[ ,]+/).map(Number); if (c.length === 3 && isPlum(c)) r2.push(`plum fill outside the mark: ${f.el}`); }
  let at = -1;
  for (const h of m.heads) { const i = SECTION_ORDER.indexOf(h); if (i < 0) r3.push(`unknown section: ${h}`); else if (i <= at) r3.push(`out of order: ${h}`); else at = i; }
  for (const h of REQUIRED) if (!m.heads.includes(h)) r3.push(`missing section: ${h}`);
  if (m.scrollW > m.innerW) r4.push(`${width}px scrolls sideways (${m.scrollW} > ${m.innerW})`);
  for (const o of m.over.slice(0, 5)) r4.push(`${width}px past the card edge: ${o}`);
  for (const e of m.empty) r4.push(`empty section: ${e}`);
  if (m.emptyLi) r4.push(`${m.emptyLi} empty list item(s)`);
  if (width === 390) {
    for (const x of m.texts) { if (x.fact && x.size < 16) r5.push(`fact text ${x.size}px: ${x.el}`); else if (x.size < 13) r5.push(`text ${x.size}px: ${x.el}`); }
    for (const x of m.texts) if (ratio(x.color, x.ground) < 4.5) r5.push(`under AA ${ratio(x.color, x.ground).toFixed(2)}: ${x.el}`);
    for (const x of m.taps) if (x.h < 44) r5.push(`tap target ${x.h}px: ${x.el}`);
  }
  return { r2, r3, r4, r5 };
}
export function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}tools/node_modules/playwright`, "/opt/node-tools/node_modules/playwright", "playwright"]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}

if (import.meta.main) {
  const tasks = pickTasks(N), pw = playwright();
  if (!pw) { console.error("no Playwright: the browser half of the rubric cannot run"); Deno.exit(2); }
  await Deno.mkdir(OUT, { recursive: true });
  const browser = await pw.chromium.launch({ headless: true, args: Deno.uid?.() === 0 ? ["--no-sandbox"] : [] });
  const rows: any[] = [];
  try {
    for (const t of tasks) {
      const b = await makeBrief(t);
      const row: any = { id: t.id, family: t.family, style: t.style, question: t.turns.at(-1), format: b.result.format, file: !!b.record, sources: b.record?.data?.sources?.length ?? 0,
        summary: b.record?.data?.summary?.length ?? 0, gaps: b.record?.data?.gaps ?? [], basis: b.record?.data?.basis ?? [],
        cited: (b.record?.data?.sources ?? []).map((x: any) => x.url), thesis_cite: b.record?.data?.thesis_cite ?? null, dropped: (b.result as any).dropped ?? null, notes: b.result.notes, error: b.error, fail: {} as Record<string, string[]>, shots: [] as string[] };
      if (!b.record) {
        const why = b.error ?? b.result.notes.find((n) => /answered inline/.test(n)) ?? b.result.status;
        for (const k of ["R1", "R2", "R3", "R4", "R5"]) row.fail[k] = [`no File: ${why}`];
      } else {
        const html = pageOf(b.record), d = dataChecks(b.record.data, b.pages);
        const agg: Record<string, string[]> = { R1: d.r1, R2: [], R3: [], R4: [], R5: [] };
        for (const width of [390, 1280]) {
          const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light", deviceScaleFactor: 2, reducedMotion: "reduce" });
          await ctx.route("**/*", (r: any) => r.abort());
          const pg = await ctx.newPage();
          await pg.setContent(html, { waitUntil: "load" });
          const c = browserChecks(await pg.evaluate(MEASURE), width);
          agg.R2.push(...c.r2); agg.R3.push(...c.r3); agg.R4.push(...c.r4); agg.R5.push(...c.r5);
          if (SHOTS) { const f = `${OUT}/${t.id}-${width}.png`; await Deno.writeFile(f, new Uint8Array(await pg.screenshot({ fullPage: true, animations: "disabled" }))); row.shots.push(f.replace(ROOT, "")); }
          await ctx.close();
        }
        for (const [k, v] of Object.entries(agg)) if (v.length) row.fail[k] = [...new Set(v)];
      }
      row.pass = Object.keys(row.fail).length === 0;
      rows.push(row);
      console.log(`${row.pass ? "PASS" : "FAIL"} ${t.id} ${t.family} ${row.file ? `${row.sources} sources, ${row.summary} facts` : "no File"}${row.pass ? "" : "  " + Object.entries(row.fail).map(([k, v]) => `${k}: ${(v as string[])[0]}`).join(" | ")}`);
    }
  } finally { await browser.close(); }
  const pass = rows.filter((r) => r.pass).length;
  const per = (k: string) => rows.filter((r) => !r.fail[k]).length;
  const fam = FAMILIES.map((f) => { const xs = rows.filter((r) => r.family === f); return `| ${f} | ${xs.filter((r) => r.pass).length}/${xs.length} |`; });
  // Which free source each brief cites (by address), so every source is seen reaching at least one brief.
  const KIND: [string, RegExp][] = [["stub site (company or market page)", /\.e2e\.test\//], ["BLS OEWS", /bls\.gov\/oes\//], ["BLS OOH", /bls\.gov\/ooh\//], ["USAJOBS", /usajobs\.gov\//],
    ["SEC EDGAR 10-K", /sec\.gov\/Archives\/.*10k/], ["SEC EDGAR full-text search", /sec\.gov\/Archives\/.*8k/], ["Greenhouse board", /greenhouse\.io\//], ["Lever board", /lever\.co\//],
    ["Ashby board", /ashbyhq\.com\//], ["SmartRecruiters board", /smartrecruiters\.com\//], ["Wikipedia", /wikipedia\.org\//], ["Wikidata", /wikidata\.org\//], ["GitHub org", /api\.github\.com\//], ["News RSS (GDELT)", /gdeltproject\.org\//]];
  const coverage = KIND.map(([k, re]) => { const xs = rows.filter((r) => r.cited.some((u: string) => re.test(u))); return `| ${k} | ${xs.length} | ${xs.map((r) => r.id).slice(0, 6).join(", ")} |`; });
  const md = [
    "# Research brief Files from free sources: quality check", "",
    `Generated by \`deno run -A --no-check evals/career/research-free/quality.ts\` on ${new Date(NOW).toISOString().slice(0, 10)} (fake model, $0). ${rows.length} briefs over the e2e eval world (seed ${SEED}), each rendered at 390 px and 1280 px (light, deviceScaleFactor 2).`, "",
    `**Rubric pass rate: ${pass}/${rows.length} (${Math.round((100 * pass) / Math.max(1, rows.length))}%)** (a brief passes only when every line passes).`, "",
    "| Rubric line | Briefs passing |", "|---|---|",
    `| R1 every claim cited, no uncited number | ${per("R1")}/${rows.length} |`, `| R2 plum only where brand.ts allows | ${per("R2")}/${rows.length} |`,
    `| R3 fixed section order | ${per("R3")}/${rows.length} |`, `| R4 no overflow, broken layout or empty section | ${per("R4")}/${rows.length} |`, `| R5 readable at 390 px | ${per("R5")}/${rows.length} |`, "",
    "| Family | Pass |", "|---|---|", ...fam, "",
    "## Free sources cited", "", "| Source | Briefs citing it | Which |", "|---|---|---|", ...coverage, "",
    "## Every brief", "", "| Task | Family | File | Sources | Facts | Gaps shown | Result |", "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.family} | ${r.file ? "yes" : "no"} | ${r.sources} | ${r.summary} | ${r.gaps.length} | ${r.pass ? "pass" : Object.entries(r.fail).map(([k, v]) => `${k}: ${(v as string[]).slice(0, 2).join("; ")}`).join("<br>")} |`), "",
  ].join("\n");
  await Deno.writeTextFile(`${OUT}/REPORT.md`, md);
  await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify({ at: new Date(NOW).toISOString(), seed: SEED, pass, total: rows.length, rows }, null, 1));
  console.log(`\nrubric pass rate: ${pass}/${rows.length}`);
}
