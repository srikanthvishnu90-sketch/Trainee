// Second review of #370 (2026-11-01). (1) A code approves exactly the selection it was sent for: its row and hash carry the refs
// and payload tags, and an approve whose selection differs (another posting, a wider or narrower set, a payload changed since the
// review) approves nothing; the chat message says what the code approves. (2) Pay is a figure next to its currency, and a range
// only two such figures joined by a range word; 401(k), bonus and signing numbers are never pay. (3) The period is read on the pay
// figure only ("40-hour week" is not a wage). (4) All roles in another currency: the reply says so. (5) A posting's full text is
// escaped even where the store's cleaning leaves markup. (6) Wrong codes are counted per person per 10 minutes across codes. (7)
// Plum only on the page's one primary action: on the list that is Apply to selected; each card's Apply is secondary.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { parsePay, payGroup, payText, resultsReply } from "../../supabase/functions/_shared/role_pay.ts";
import { DAY, HASH, made, NOW, plain, POSTINGS, U, world, type Posting, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const HOURLY30 = { amount: 30, period: "hour" as const };
const tag = (n: number) => hashTag(HASH(n));
const post = (w: W, body: Record<string, string | string[]>) => handleFile(new Request("https://x.example/f", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(Object.entries(body).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x]))).toString() }), w.deps).then((r) => r.text());
const page = (w: W, s: string) => handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${s}` } }), w.deps).then((r) => r.text());
const refOf = (html: string, company: string) => { const c = html.split('<li class="card" id="r-').slice(1).find((x) => x.includes(`<p class="co">${company}</p>`)); assert(c, company); return c!.slice(0, 12); };
const lastCode = (w: W) => /code is (\d{6})/.exec(w.outbox.at(-1)!.text)![1];
const wrongOf = (c: string) => String((Number(c) + 1) % 1000000).padStart(6, "0");
async function signed() {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await page(w, s);
  return { w, s, acme: refOf(html, "Acme Web"), globex: refOf(html, "Globex"), initech: refOf(html, "Initech") };
}
const setOf = async (w: W, s: string, picks: string[]) => /name="set" value="([0-9a-f]{16})"/.exec(await post(w, { t: s, action: "review_sel", pick: picks }))![1];

// ================================================================== (1) a code approves exactly what it was sent for
Deno.test("scope: the chat message names what the code approves", async () => {
  const { w, s, acme, globex } = await signed();
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  assert(/code for: Apply to Acme Web — Frontend Engineering Intern\b/.test(w.outbox.at(-1)!.text), w.outbox.at(-1)!.text);
  const picks = [`${acme}:${tag(1)}`, `${globex}:${tag(2)}`];
  await post(w, { t: s, action: "code_send", pick: picks, set: await setOf(w, s, picks) });
  assert(/code for: Apply to Acme Web — Frontend Engineering Intern; Globex — Frontend Intern\b/.test(w.outbox.at(-1)!.text), w.outbox.at(-1)!.text);
});

Deno.test("scope: a code sent while reviewing one posting approves no other posting", async () => {
  const { w, s, acme, initech } = await signed();
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  const t = plain(await post(w, { t: s, action: "approve", ref: initech, tag: tag(3), code: lastCode(w) }));
  assert(/That code was sent for a different selection, so nothing was sent/.test(t), t);
  eq(w.queue.length, 0);
});

Deno.test("scope: a code for {Acme} does not approve a widened set {Acme, Initech}, even with the set hash recomputed", async () => {
  const { w, s, acme, initech } = await signed();
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  const code = lastCode(w), wide = [`${acme}:${tag(1)}`, `${initech}:${tag(3)}`];
  const t = plain(await post(w, { t: s, action: "approve_sel", pick: wide, set: await setOf(w, s, wide), code }));
  assert(/That code was sent for a different selection, so nothing was sent/.test(t), t);
  eq(w.queue.length, 0);
});

Deno.test("scope: a code for {Acme, Globex} does not approve a narrowed set or one of them alone", async () => {
  const { w, s, acme, globex } = await signed();
  const both = [`${acme}:${tag(1)}`, `${globex}:${tag(2)}`];
  await post(w, { t: s, action: "code_send", pick: both, set: await setOf(w, s, both) });
  const code = lastCode(w);
  const narrow = [`${acme}:${tag(1)}`];
  assert(/different selection/.test(plain(await post(w, { t: s, action: "approve_sel", pick: narrow, set: await setOf(w, s, narrow).catch(() => ""), code }))));
  assert(/different selection/.test(plain(await post(w, { t: s, action: "approve", ref: acme, tag: tag(1), code }))));
  eq(w.queue.length, 0);
  // The code itself still works for exactly what it was sent for.
  assert(/All 2 approved and queued/.test(plain(await post(w, { t: s, action: "approve_sel", pick: both, set: await setOf(w, s, both), code }))));
  eq(w.queue.length, 2);
});

Deno.test("scope: a payload changed after the review (one row's tag no longer its tag) approves nothing in the set", async () => {
  const { w, s, acme, globex } = await signed();
  const both = [`${acme}:${tag(1)}`, `${globex}:${tag(2)}`];
  const set = await setOf(w, s, both);
  await post(w, { t: s, action: "code_send", pick: both, set });
  const code = lastCode(w);
  w.preps.set("lever:globex:2", { ...w.preps.get("lever:globex:2")!, payload_hash: "e".repeat(64) });
  const t = plain(await post(w, { t: s, action: "approve_sel", pick: both, set, code }));
  assert(/This selection changed since you checked it, so nothing was approved/.test(t), t);
  eq(w.queue.length, 0);
});

// ================================================================== (6) wrong codes per person per window
Deno.test("lockout: five wrong codes in 10 minutes across codes and sessions lock approvals for the person; after the window it works again", async () => {
  const { w, s, acme } = await signed();
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  for (let i = 0; i < 3; i++) await post(w, { t: s, action: "approve", ref: acme, tag: tag(1), code: wrongOf(lastCode(w)) });
  // A fresh code (and another session of the same person) does not reset the count.
  const s2 = await w.A.tok(U, (await made(w)).listId, NOW);
  const acme2 = refOf(await page(w, s2), "Acme Web");
  await post(w, { t: s2, action: "code_send", ref: acme2, tag: tag(1) });
  for (let i = 0; i < 2; i++) await post(w, { t: s2, action: "approve", ref: acme2, tag: tag(1), code: wrongOf(lastCode(w)) });
  await post(w, { t: s2, action: "code_send", ref: acme2, tag: tag(1) });
  const t = plain(await post(w, { t: s2, action: "approve", ref: acme2, tag: tag(1), code: lastCode(w) }));
  assert(/Too many wrong codes/.test(t), t);
  eq(w.queue.length, 0);
  w.clock.t = NOW + 10 * 60_000 + 1000;
  await post(w, { t: s2, action: "code_send", ref: acme2, tag: tag(1) });
  assert(/Approved\./.test(plain(await post(w, { t: s2, action: "approve", ref: acme2, tag: tag(1), code: lastCode(w) }))));
  eq(w.queue.length, 1);
});

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
  eq(first, "I found 2 frontend internships, but they list pay in another currency or without a period, so I couldn't compare them with $30/hr. Here they are by fit, with Apply on each:");
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

// ================================================================== (7) plum only on the one primary action
Deno.test("design: on the list, Apply to selected is the one primary (plum) action; each card's Apply is secondary", async () => {
  const { w, s } = await signed();
  const html = await page(w, s);
  eq((html.match(/class="apply"/g) ?? []).length, 1, "one primary action");
  assert(/<form method="post" id="sel">[\s\S]*?<button type="submit" class="apply">Apply to selected<\/button>/.test(html));
  eq((html.match(/<button type="submit" class="ghost go" aria-label="Apply to /g) ?? []).length, 3, "each card's Apply is the secondary button");
});
