// R9-C (2026-11-07): the market research brief, a variant of the research_brief File kind (the kind list stays as it is). Blocks: a
// cover card (title, one-line thesis, the date its sources were read), a summary, a comparison table, "what would have to be true",
// risks and sources. Every summary line and cell is a sourced fact that names its numbered sources; every source is an https page
// with its fetch time; the date is computed from those times. The link preview is the brand's research card, naming only the kind.
// The page in Chromium at 390 and 1280 px is research-brief-browser.test.ts. Synthetic companies and figures only.
import assertNode from "node:assert/strict";
import { DISPLAY_FONT, LIGHT, PLUM } from "../../supabase/functions/_shared/brand.ts";
import { bodyHtml, KIND_CSS, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { RESEARCH_OG_FILE, researchOgCardHtml, researchOgImage } from "../../supabase/functions/_shared/research_og.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";
import { clone, MARKET, marketPage, marketRecord, NOW } from "./research-brief-fixture.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname;
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const refused = (mut: (x: any) => void, why: string) => { const x: any = clone(MARKET); mut(x); const v = validateKind("research_brief", x, { now: NOW }); ok(!v.ok, `accepted: ${why}`); return v.ok ? [] : v.errors; };

Deno.test("market brief: the sample validates; the classic research brief is unchanged", () => {
  const v = validateKind("research_brief", MARKET, { now: NOW });
  ok(v.ok, JSON.stringify(v));
  ok(validateKind("research_brief", { title: "Acme research", subject: "Acme", findings: [{ label: "Product", value: "Pricing analytics", source: "Reported, not verified" }], sources: [{ title: "About", url: "https://acme.example/about" }] }).ok);
  const noTable = clone(MARKET) as any; delete noTable.comparison;
  ok(validateKind("research_brief", noTable, { now: NOW }).ok, "the comparison table is optional (one company, one salary)");
});

Deno.test("market brief: citations are enforced at creation (no claim without a numbered source, no source without a claim)", () => {
  refused((x) => { delete x.summary[0].cite; }, "a summary line with no cite");
  refused((x) => { x.summary[0].cite = [9]; }, "a cite past the last source");
  refused((x) => { x.summary[0].cite = [0]; }, "cite 0");
  refused((x) => { x.conditions[0].cite = []; }, "a condition with no cite");
  refused((x) => { x.risks[0].cite = ["1"]; }, "a cite that is not a number");
  refused((x) => { x.comparison.rows[0].cells[0].cite = [7]; }, "a cell citing a missing source");
  refused((x) => { delete x.summary[0].source; }, "a summary fact without a source label");
  refused((x) => { x.summary[0].source = "Trust me"; }, "a made-up source label");
  refused((x) => { x.sources.push({ title: "Padding", url: "https://pad.example/", fetched_at: "2026-11-07T15:00:00Z" }); }, "a source nothing cites");
  refused((x) => { delete x.sources[0].fetched_at; }, "a source with no fetch time");
  refused((x) => { x.sources[0].fetched_at = "2026-12-01T00:00:00Z"; }, "a fetch time in the future");
  refused((x) => { x.sources[0].url = "http://research.example/battery-prices-2024"; }, "an http source");
  refused((x) => { x.summary[0].text = "Prices fell, see https://evil.example/x"; }, "a link inside a claim");
  refused((x) => { x.thesis = "Read www.evil.example first"; }, "a link in the thesis");
  refused((x) => { x.comparison.rows[0].cells[0].value = "unknown"; }, "a placeholder value");
  refused((x) => { x.comparison.rows[1].cells = [null, null, null]; }, "a row with nothing known");
  refused((x) => { x.comparison.options.push({ name: "D" }, { name: "E" }); }, "more than four options");
  refused((x) => { x.conditions = []; }, "no 'what would have to be true'");
  refused((x) => { x.risks = []; }, "no risks");
  refused((x) => { x.summary = []; }, "no summary");
  refused((x) => { x.thesis = "x".repeat(161); }, "a thesis longer than one line");
});

Deno.test("market brief page: the six blocks in order, each claim with its source chip and numbered cite, sources linked with their read date", () => {
  const h = marketPage(), t = plain(h);
  const order = ["rb-cover", ">Summary<", ">Comparison<", ">What would have to be true<", ">Risks<", ">Sources<"].map((s) => h.indexOf(s));
  ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `blocks in order: ${order}`);
  ok(t.includes(MARKET.thesis) && t.includes("Sources read Nov 7, 2026 · 4 sources"), "the cover: thesis and the newest fetch date, computed");
  for (const s of MARKET.summary) ok(t.includes(`${s.text} [${s.cite.join("][")}] Reported, not verified`), `summary line with cite and chip: ${s.text}`);
  ok(/<th scope="col">Acme Energy<\/th><th scope="col">Globex Power<\/th><th scope="col">Initech Grid<\/th>/.test(h), "the comparison header");
  ok(t.includes("41,000 [2] Reported, not verified") && (h.match(/Not stated/g) ?? []).length === 3, "cells carry their cite and chip; unknown cells say so");
  for (const c of [...MARKET.conditions, ...MARKET.risks]) ok(t.includes(`${c.text} [${c.cite.join("][")}] Trainee's reading`), `reading labelled as such: ${c.text}`);
  MARKET.sources.forEach((s, i) => ok(h.includes(`<li id="src-${i + 1}"><span class="rb-n">[${i + 1}]</span><a href="${s.url}" rel="noopener noreferrer">${s.title}</a>`), `source ${i + 1} linked`));
  ok(t.includes("utility.example · Read Nov 6, 2026") && t.includes("research.example · Read Nov 7, 2026"), "each source says where and when it was read");
  ok(!/<a [^>]*href="#src/.test(h), "cites are text, not tap targets under 44 px");
  ok(h.includes('<p class="eyebrow">Research brief</p>') && /<h1 class="ftitle">What would change the market for home batteries<\/h1>/.test(h), "the shell's eyebrow and serif title");
});

Deno.test("market brief page: untrusted text is refused at creation and escaped if stored; a stored cite that is not a number never renders as markup", () => {
  refused((x) => { x.title = "<script>alert(1)</script> batteries"; }, "markup in the title");
  const d: any = clone(marketRecord().data);
  d.title = "<script>alert(1)</script>"; d.thesis = "Prices <img src=x onerror=alert(1)> fall."; d.summary[0].text = "A & B <b>bold</b> claim."; d.summary[1].cite = ["<i>x</i>"];
  const h = bodyHtml({ ...marketRecord(), data: d }, "t");
  ok(!/<script>alert|<img src=x|<b>bold|<i>x/.test(h) && h.includes("Prices &lt;img src=x onerror=alert(1)&gt; fall.") && h.includes("A &amp; B &lt;b&gt;bold&lt;/b&gt; claim."));
});

Deno.test("market brief text twin: every block, every cite, every source url with its read date", () => {
  const t = textOf(marketRecord(), { now: NOW });
  for (const s of ["## Summary", "## Comparison", "### Home batteries installed (2025)", "- Initech Grid: Not stated", "## What would have to be true", "## Risks", "## Sources", MARKET.thesis, "Sources read Nov 7, 2026. 4 sources."]) ok(t.includes(s), s);
  ok(t.includes("- Battery pack prices fell 20% in 2024, the survey reports. [1] [Reported, not verified]"));
  ok(t.includes("- A tariff change could remove most of the bill savings. [4] [Trainee's reading]"));
  MARKET.sources.forEach((s, i) => ok(t.includes(`${i + 1}. ${s.title}: ${s.url} (read `), s.url));
});

Deno.test("market brief: the CSS uses the brand tokens only (no new hue)", () => {
  const css = KIND_CSS.slice(KIND_CSS.indexOf("/* R9-C"));
  ok(css.includes(".rb-cover") && css.includes("var(--bg)") && css.includes("Brygada 1918"));
  eq(css.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), null, "colours come from the tokens");
});

// The page as committed (tests/architect/snapshots/research-brief-market.html). A deliberate change: UPDATE_SNAPSHOTS=1 rewrites it.
Deno.test("market brief page: HTML snapshot", async () => {
  const path = `${ROOT}tests/architect/snapshots/research-brief-market.html`, html = marketPage() + "\n";
  if (Deno.env.get("UPDATE_SNAPSHOTS") === "1") await Deno.writeTextFile(path, html);
  eq(html, await Deno.readTextFile(path), "the page changed; review it and run with UPDATE_SNAPSHOTS=1");
});

// ================================================================== the link preview
Deno.test("share card: og-research.png is a 1200x630 PNG on the warm ground, drawn from the brand tokens", async () => {
  const png = await Deno.readFile(`${ROOT}${RESEARCH_OG_FILE}`);
  const dv = new DataView(png.buffer);
  eq([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
  eq([dv.getUint32(16), dv.getUint32(20)], [1200, 630]);
  const card = researchOgCardHtml();
  ok(card.includes(`background:${LIGHT.bg}`) && card.includes(`fill="${PLUM}"`) && card.includes(DISPLAY_FONT) && card.includes(">Trainee<") && card.includes("<h1>Research brief</h1>"));
  const hexes = new Set((card.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));
  for (const h of hexes) ok([LIGHT.bg, LIGHT.ink, LIGHT.mute, LIGHT.line, PLUM].includes(h) , `no new hue: ${h}`);
  eq(researchOgImage("https://trainee.example/file"), "https://trainee.example/og-research.png");
  eq(researchOgImage("http://trainee.example/file"), null);
});

const U = "11111111-1111-4111-8111-111111111111", A = signedIn();
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
function world() {
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc };
  return { svc, deps };
}
Deno.test("share card: a link-preview crawler gets the research card and the kind's name, nothing of the brief; the owner gets the page", async () => {
  const w = world();
  const made = (await w.svc.create(U, "research_brief", MARKET)) as { ok: boolean; id: string; url: string };
  ok(made.ok, JSON.stringify(made));
  const r = await handleFile(new Request(made.url, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), w.deps), h = await r.text();
  eq(r.status, 200);
  ok(h.includes('property="og:image" content="https://trainee.example/og-research.png"') && h.includes('og:title" content="Research brief from Trainee"'), h.slice(0, 900));
  ok(!h.includes("batter") && !h.includes("Acme") && !h.includes("tariff"), "nothing of the brief in the preview");
  for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "Mozilla/5.0 (compatible; Discordbot/2.0)"]) {
    const x = await (await handleFile(new Request(made.url, { headers: { "user-agent": ua } }), w.deps)).text();
    if (x.includes("og:image")) ok(x.includes("/og-research.png") && !x.includes("Acme"), ua);
  }
  const page = await (await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await A.tok(U, made.id, NOW)}` } }), w.deps)).text();
  ok(plain(page).includes(MARKET.thesis) && page.includes("/og-research.png"), "the signed-in page renders the brief");
  const other = (await w.svc.create(U, "comparison", { title: "A vs B", options: [{ name: "A" }, { name: "B" }], rows: [{ label: "Pay", cells: [{ value: "$1", source: "From you" }, null] }] })) as { url: string };
  ok((await (await handleFile(new Request(other.url, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), w.deps)).text()).includes("/og-file.png"), "other kinds keep their card");
});
