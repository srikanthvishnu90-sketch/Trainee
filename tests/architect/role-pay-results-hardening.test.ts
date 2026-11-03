// Review of #370 (2026-11-01): pay is stored as numbers (never re-read from its own display text), every converted figure says
// it was converted and how, other currencies are shown as such and never silently compared with a dollar floor; and the
// approve paths hold against hostile posting text, a paused account (the person's kill switch) and a posting that closed
// after it was shown (the chat code is gone: owner, 2026-11-02; apply-page.test.ts has the Apply flows). Memory world (tests/helpers/results_world.ts).
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { conversionNote, parsePay, payGroup, payText } from "../../supabase/functions/_shared/role_pay.ts";
import { DAY, HASH, made, NOW, plain, POSTINGS, post, U, world, type Posting, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const HOURLY30 = { amount: 30, period: "hour" as const };
const req = async (w: W, o: { cookie?: string; body?: Record<string, string | string[]> }) => {
  if (o.body) { const { t, pick, ...f } = o.body as Record<string, string>; return post(w, t, f, { pick: pick as unknown as string[] | undefined }); }
  return handleFile(new Request("https://x.example/f", { headers: o.cookie ? { cookie: `tf_s=${o.cookie}` } : {} }), w.deps);
};
const page = async (w: W, s: string) => await (await req(w, { cookie: s })).text();
const refIn = (html: string, company: string) => { const c = html.split('<li class="card" id="r-').slice(1).find((x) => x.includes(`<p class="co">${company}</p>`)); assert(c, `a card for ${company}`); return c!.slice(0, 12); };
const tag = (n: number) => hashTag(HASH(n));
const posting = (n: number, company: string, pay: string | null, description = "<p>Build our web app.</p>", title = "Frontend Intern"): Posting => ({
  job_id: `greenhouse:p${n}:${n}`, provider: "greenhouse", company, title, location: "Remote", url: `https://boards.greenhouse.io/p${n}/jobs/${n}`, description, remote: "remote",
  posted_at: new Date(NOW - n * DAY).toISOString(), first_seen_at: null, pay, fitReasons: [], score: 90 - n,
});
async function signedWorld(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  return { w, r, s };
}

// ================================================================== pay: numbers, periods, currencies
Deno.test("pay: an annual range is read as a year in thousands, in every way a posting writes it; never as an hourly wage", () => {
  for (const t of ["$90,000-$120,000", "$90,000 - $120,000", "$90k-$120k", "$90-120k", "$90K–$120K", "$90,000 to $120,000 per year", "USD 90,000 - 120,000"]) {
    const p = parsePay(t)!;
    eq([p.min, p.max, p.period, p.currency], [90000, 120000, "year", "USD"], t);
    eq(payText(p), "$90-120k/yr", t);
  }
  const yearly = parsePay("$90,000-$120,000")!;
  eq(payGroup(yearly, HOURLY30), "meets", "$43-58/hr is over $30/hr");
  eq(payGroup(yearly, { amount: 70, period: "hour" }), "below");
  eq(conversionNote(yearly, HOURLY30), "≈ $43-58/hr, assuming 2,080 hrs/yr");
  eq(payGroup(parsePay("$50,000 a year"), HOURLY30), "below", "$24/hr is under $30/hr");
  // Stated text survives as written, for the page's attribution.
  eq(yearly.text, "$90,000-$120,000");
});

Deno.test("pay: monthly and hourly figures keep their period; a conversion is always labelled with its assumption", () => {
  const m = parsePay("$5,000 per month")!;
  eq([m.min, m.max, m.period], [5000, 5000, "month"]);
  eq(payText(m), "$5,000/mo");
  eq(payGroup(m, HOURLY30), "below", "$5,000 a month is about $28.85/hr");
  eq(conversionNote(m, HOURLY30), "≈ $29/hr, assuming 2,080 hrs/yr");
  const h = parsePay("$35 - $40 per hour")!;
  eq(payText(h), "$35-40/hr");
  eq(conversionNote(h, HOURLY30), null, "same period: nothing converted");
  eq(conversionNote(h, { amount: 80000, period: "year" }), "≈ $73-83k/yr, assuming 2,080 hrs/yr");
  // A number with no period at all: shown, never compared.
  const bare = parsePay("$45")!;
  eq(bare.period, null);
  eq(payGroup(bare, HOURLY30), "unchecked");
});

Deno.test("pay: Canadian, Australian, euro, pound and rupee figures are shown in their currency and never compared with a dollar floor", () => {
  const cases: [string, string, string][] = [
    ["CA$60,000-75,000", "CAD", "CA$60-75k/yr"], ["C$40/hr", "CAD", "CA$40/hr"], ["60k-75k CAD", "CAD", "CA$60-75k/yr"], ["$60,000 - $75,000 CAD", "CAD", "CA$60-75k/yr"],
    ["A$80k", "AUD", "A$80k/yr"], ["AU$45/hr", "AUD", "A$45/hr"], ["€60k–€75k", "EUR", "€60-75k/yr"], ["£40,000", "GBP", "£40k/yr"], ["₹12,00,000 per annum", "INR", "₹12,00,000 per annum"],
  ];
  for (const [t, cur, shown] of cases) {
    const p = parsePay(t)!;
    eq(p.currency, cur, t);
    eq(payText(p), shown, t);
    eq(payGroup(p, HOURLY30), "unchecked", `${t} is not compared with $30/hr`);
    eq(conversionNote(p, HOURLY30), null, `${t}: no dollar conversion`);
  }
});

Deno.test("results file: the parsed pay is stored with each role and the page renders from it, never from re-reading its own text", async () => {
  const board = [posting(1, "Annual Co", "$90,000-$120,000"), posting(2, "Hourly Co", "$32/hr"), posting(3, "Maple Co", "CA$60,000-75,000"), posting(4, "Quiet Co", null)];
  const { w, r, s } = await signedWorld({ postings: board });
  eq([r.meets, r.unchecked, r.unlisted], [2, 1, 1]);
  const refs = (await w.store.recallList(U, r.listId))!;
  const annual = (await w.store.recall(U, refs[0]))!.job as any;
  eq(annual.company, "Annual Co");
  eq(annual.pay_parsed, { min: 90000, max: 120000, period: "year", currency: "USD", text: "$90,000-$120,000" });
  const t = plain(await page(w, s));
  assert(/Annual Co Pay \$90-120k\/yr · listed on the posting ≈ \$43-58\/hr, assuming 2,080 hrs\/yr/.test(t), t);
  assert(!/90-120000|\$90-120k\/hr|\$90-120\/hr/.test(t), "a yearly salary is never shown as an hourly wage");
  // The page reads the stored numbers, not the display text: a display string that says something else changes nothing.
  await w.store.remember(U, refs[0], { ...annual, pay: "$1/hr" }, "text");
  assert(/Annual Co Pay \$90-120k\/yr · listed on the posting/.test(plain(await page(w, s))), "rendered from pay_parsed");
  assert(/Lists \$30\/hr or more \(2\)[\s\S]*Annual Co[\s\S]*Hourly Co[\s\S]*Pay in another currency \(1\)[\s\S]*Maple Co Pay CA\$60-75k\/yr · listed on the posting; in CAD, not compared with your \$30\/hr[\s\S]*Pay not listed \(1\)[\s\S]*Quiet Co/.test(t), t);
});

// ================================================================== hostile posting text and answers are text, never markup
Deno.test("XSS: hostile titles, companies, descriptions and application answers are escaped on the card and in What will be sent", async () => {
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
  const board = [posting(1, `Evil"><img src=x onerror=alert(3)> Inc`, "$40/hr", `<p>Hi</p><script>alert(4)</script><img src=x onerror=alert(5)>`, `Intern ${evil}`)];
  const { w, s } = await signedWorld({ postings: board, fields: [{ label: `Why? ${evil}`, value: `Because "><script>alert(6)</script>` }] });
  const list = await page(w, s);
  const ref = list.split('<li class="card" id="r-')[1].slice(0, 12);
  void ref;
  for (const [name, html] of [["list", list], ["what will be sent", list]] as const) {
    const body = html.replace(/<style[\s\S]*?<\/style>/, "");
    assert(!/<script>alert|<img src=x|onerror=alert\(\d\)>/.test(body.replace(/&lt;[^&]*&gt;/g, "")), `${name}: no live markup from posting or answers`);
    assert(!/<script(?![^>]*telegram)/i.test(body), `${name}: no script element at all`);
    assert(!/<img[^>]*onerror/i.test(body), `${name}: no image with a handler`);
  }
  // The job store keeps posting text as plain text (telegram_jobs.ts clean: tags dropped); either way it is never markup.
  assert(/<h3 class="title">Intern (?:alert\(1\)|&lt;script&gt;alert\(1\)&lt;\/script&gt;)/.test(list), "the title shown as text");
  assert(list.includes("Because &quot;&gt;&lt;script&gt;alert(6)&lt;/script&gt;"), "an answer shown as text, on the card");
});

// ================================================================== the approve paths
Deno.test("kill switch: a person who paused Trainee after the page was drawn gets nothing approved, and the list offers no Apply", async () => {
  const { w, s } = await signedWorld();
  const ref = refIn(await page(w, s), "Acme Web");
  w.deps.account = async () => ({ epoch: 0, version: 0, authority_version: 0, paused: true });
  const t = plain(await (await req(w, { body: { t: s, action: "apply", ref, tag: tag(1) } })).text());
  assert(/Trainee is paused for you/.test(t), t);
  eq(w.queue.length, 0);
  assert(!/aria-label="Apply to /.test(await page(w, s)), "no Apply while paused");
});

Deno.test("closed posting: a role that closed after it was shown approves nothing", async () => {
  const { w, s } = await signedWorld();
  const ref = refIn(await page(w, s), "Acme Web");
  w.closed.add(POSTINGS[0].job_id);
  const t = plain(await (await req(w, { body: { t: s, action: "apply", ref, tag: tag(1) } })).text());
  assert(/Nothing was approved: .*closed/i.test(t), t);
  eq(w.queue.length, 0);
});
