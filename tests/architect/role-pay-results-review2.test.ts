// Second review of #370 (2026-11-01). (1) [The chat code and its scope tests were removed with the code, owner 2026-11-02; the
// Apply flows are in apply-page.test.ts.] (2) Pay is a figure next to its currency, and a range
// only two such figures joined by a range word; 401(k), bonus and signing numbers are never pay. (3) The period is read on the pay
// figure only ("40-hour week" is not a wage). (4) All roles in another currency: the reply says so. (5) A posting's full text is
// escaped even where the store's cleaning leaves markup. (7)
// One primary (black) Apply per card; Apply to selected is the list's own primary.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { parsePay, payGroup, payText, resultsReply } from "../../supabase/functions/_shared/role_pay.ts";
import { DAY, HASH, made, NOW, plain, POSTINGS, U, world, type Posting, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const HOURLY30 = { amount: 30, period: "hour" as const };
const tag = (n: number) => hashTag(HASH(n));
const page = (w: W, s: string) => handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${s}` } }), w.deps).then((r) => r.text());
const refOf = (html: string, company: string) => { const c = html.split('<li class="card" id="r-').slice(1).find((x) => x.includes(`<p class="co">${company}</p>`)); assert(c, company); return c!.slice(0, 12); };

// ================================================================== (1) a code approves exactly what it was sent for
// ================================================================== (6) wrong codes per person per window
// ================================================================== (2) (3) pay is a figure next to its currency
Deno.test("pay: benefit, bonus and 401(k) numbers are never pay, and never the end of a range", () => {
  const cases: [string, string, "meets" | "below"][] = [
    ["$25/hr • 401(k)", "$25/hr", "below"],
    ["$25/hr, 401k match", "$25/hr", "below"],
    ["$120,000/yr + 401k", "$120k/yr", "meets"],
    ["Up to $150,000 annually, plus $10k signing bonus", "Up to $150k/yr", "meets"],
    ["$28/hr plus a $2,000 relocation stipend", "$28/hr", "below"],
    ["$90,000 base + 15% bonus", "$90k/yr", "meets"],
    ["$32 an hour; 403(b) and 4 weeks PTO", "$32/hr", "meets"],
    // A number with no currency that comes first is not pay either.
    ["401(k) match and $25/hr", "$25/hr", "below"],
    ["40-hour week at $28/hr", "$28/hr", "below"],
    ["4 weeks PTO, $95,000/yr", "$95k/yr", "meets"],
  ];
  for (const [t, shown, g] of cases) {
    const p = parsePay(t)!;
    eq(payText(p), shown, t);
    eq(payGroup(p, HOURLY30), g, t);
  }
  eq([parsePay("$25/hr • 401(k)")!.min, parsePay("$25/hr • 401(k)")!.max], [25, 25]);
  // A real range still reads as one: two pay figures joined by a range word.
  for (const t of ["$35 - $40 per hour", "$35 to $40/hr", "$90k–$120k a year", "$90-120k"]) assert(parsePay(t)!.min < parsePay(t)!.max, t);
});

Deno.test("pay: the period is read on the pay figure, never from '40-hour week' or other words in the sentence", () => {
  eq(payText(parsePay("$95,000 for a 40-hour week")!), "$95k/yr");
  eq(payGroup(parsePay("$95,000 for a 40-hour week"), HOURLY30), "meets");
  eq(payText(parsePay("$22/hr, 20 hours a week")!), "$22/hr");
  eq(payText(parsePay("Hourly rate: $31")!), "$31/hr", "a period word right before the figure counts");
  eq(parsePay("$45, 40-hour week")!.period, null, "no period on the figure itself: not guessed");
});

// ================================================================== (4) every role in another currency
Deno.test("reply: when every role lists pay in another currency, the reply says so, never 'found 0 roles'", () => {
  const r = resultsReply({ what: { one: "frontend internship", many: "frontend internships" }, floor: HOURLY30, meets: 0, unlisted: 0, unchecked: 2, url: "https://trainee.example/file?t=x" });
  const first = r.split("\n")[0];
  assert(!/\b0 /.test(first) && !/none of them list pay/.test(first), first);
  eq(first, "I found 2 frontend internships, but they list pay in another currency or without a period, so I couldn't compare them with $30/hr. Here they are by fit, with Apply on each.");
});

// ================================================================== (5) the full posting text is escaped
Deno.test("XSS: markup the store's cleaning leaves in a posting's full text (an unclosed tag) is escaped on the page", async () => {
  const evil: Posting = { ...POSTINGS[0], description: "<p>Great team.</p> Pay rises <img src=x onerror=alert(7)", posted_at: new Date(NOW - DAY).toISOString() };
  const w = world({ postings: [evil] });
  const r = await made(w);
  const html = await page(w, await w.A.tok(U, r.listId, NOW));
  assert(!/<img src=x onerror/.test(html), "no live image from the posting text");
  assert(html.includes("&lt;img src=x onerror=alert(7)"), "shown as text");
});

// ================================================================== (7) one black primary per card
Deno.test("design: each card has exactly one primary (the black Apply); Apply to selected is the list's own primary", async () => {
  const w = world();
  const r = await made(w);
  const html = await page(w, await w.A.tok(U, r.listId, NOW));
  for (const c of html.split('<li class="card" id="r-').slice(1)) eq((c.match(/class="apply"/g) ?? []).length, 1, "one primary per card");
  assert(/<form method="post" id="sel">[\s\S]*?<button type="submit" class="apply">Apply to selected<\/button>/.test(html));
  eq((html.match(/<button type="submit" class="apply" aria-label="Apply to /g) ?? []).length, 3);
});
