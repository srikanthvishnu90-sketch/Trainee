// Third review of #370 (2026-11-01): the reply counts every role and gives each the true reason it could not be checked; a list has
// exactly one plum action ("Apply there" cards are secondary too); a range's upper figure must carry a currency or the pay unit;
// and the guards a mutation run showed untested: the payload tag inside the code's selection hash, the row tag check on review,
// and the lockout check before a new code is sent. The atomic lockout on Postgres: approval-code-lockout-pg.test.ts.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { parsePay, payText, resultsReply } from "../../supabase/functions/_shared/role_pay.ts";
import { HASH, made, NOW, plain, POSTINGS, U, world, type Posting, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const FLOOR = { amount: 30, period: "hour" as const }, WHAT = { one: "frontend internship", many: "frontend internships" }, URL_ = "https://trainee.example/file?t=x";
const tag = (n: number) => hashTag(HASH(n));
const post = (w: W, body: Record<string, string | string[]>) => handleFile(new Request("https://x.example/f", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(Object.entries(body).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x]))).toString() }), w.deps).then((r) => r.text());
const page = (w: W, s: string) => handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${s}` } }), w.deps).then((r) => r.text());
const refOf = (html: string, company: string) => html.split('<li class="card" id="r-').slice(1).find((x) => x.includes(`<p class="co">${company}</p>`))!.slice(0, 12);
const lastCode = (w: W) => /code is (\d{6})/.exec(w.outbox.at(-1)!.text)![1];

// ================================================================== the reply counts every role, with its true reason
Deno.test("reply: mixed results count every role found and say why each unchecked one couldn't be checked", () => {
  const first = (o: Parameters<typeof resultsReply>[0]) => resultsReply(o).split("\n")[0];
  eq(first({ what: WHAT, floor: FLOOR, meets: 0, unlisted: 1, otherCurrency: 1, url: URL_ }),
    "I found 2 frontend internships: 1 doesn't list pay and 1 lists pay in another currency, so I couldn't check those 2 against $30/hr. Here they are by fit, with Apply on each:");
  eq(first({ what: WHAT, floor: FLOOR, meets: 2, unlisted: 1, otherCurrency: 1, noPeriod: 1, url: URL_ }),
    "I found 5 frontend internships: 2 list pay of $30/hr or more; 1 doesn't list pay, 1 lists pay in another currency and 1 lists pay without saying per hour or per year, so I couldn't check those 3 against $30/hr. Here they are by fit, with Apply on each:");
  eq(first({ what: WHAT, floor: FLOOR, meets: 0, unlisted: 0, otherCurrency: 2, url: URL_ }),
    "I found 2 frontend internships, but they list pay in another currency, so I couldn't compare them with $30/hr. Here they are by fit, with Apply on each:");
  eq(first({ what: WHAT, floor: FLOOR, meets: 0, unlisted: 0, noPeriod: 1, url: URL_ }),
    "I found 1 frontend internship, but it lists pay without saying per hour or per year, so I couldn't compare it with $30/hr. Here it is, with Apply on it:");
});

Deno.test("results file: other-currency and no-period roles are counted apart in the reply", async () => {
  const board: Posting[] = [
    { ...POSTINGS[1], job_id: "lever:quiet:1" },
    { ...POSTINGS[0], job_id: "greenhouse:maple:2", company: "Maple Co", pay: "CA$60,000-75,000", description: "<p>Build things.</p>" },
  ];
  const r = await made(world({ postings: board }));
  eq(r.reply.split("\n")[0], "I found 2 frontend internships: 1 doesn't list pay and 1 lists pay in another currency, so I couldn't check those 2 against $30/hr. Here they are by fit, with Apply on each:");
});

// ================================================================== exactly one plum action on a list
Deno.test("design: an 'Apply there' card (a site Trainee never applies on) is secondary too; the list has exactly one plum action", async () => {
  const board: Posting[] = [POSTINGS[0], { ...POSTINGS[2], job_id: "linkedin:hand:9", url: "https://www.linkedin.com/jobs/view/9", company: "Handco" }];
  const w = world({ postings: board });
  const r = await made(w);
  const html = await page(w, await w.A.tok(U, r.listId, NOW));
  assert(/<a class="ghost[^"]*" href="https:\/\/www\.linkedin\.com\/jobs\/view\/9"[^>]*>Apply there<\/a>/.test(html), "Apply there is secondary");
  eq((html.match(/class="apply"/g) ?? []).length, 1, "one plum action");
});

// ================================================================== a range's upper figure
Deno.test("pay: '$25 - 40 hours per week' is $25 (no period), not $25-40/hr; a bare upper figure needs the pay unit", () => {
  const p = parsePay("$25 - 40 hours per week")!;
  eq([p.min, p.max, p.period], [25, 25, null]);
  eq(payText(parsePay("$35-40/hr")!), "$35-40/hr", "the unit right after the upper figure");
  eq(payText(parsePay("$35 - 40 per hour")!), "$35-40/hr");
  eq(payText(parsePay("$90-120k")!), "$90-120k/yr", "k is the unit");
  eq(payText(parsePay("$60,000 - 75,000 a year")!), "$60-75k/yr");
});

// ================================================================== guards the mutation run found untested
Deno.test("scope: a code sent for one payload does not approve the same role's new payload, even when the page shows the new one", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const acme = refOf(await page(w, s), "Acme Web");
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  const code = lastCode(w);
  const newHash = "e".repeat(64), newTag = hashTag(newHash);
  w.preps.set("greenhouse:acme:1", { ...w.preps.get("greenhouse:acme:1")!, payload_hash: newHash });
  const t = plain(await post(w, { t: s, action: "approve", ref: acme, tag: newTag, code }));
  assert(/That code was sent for a different selection, so nothing was sent/.test(t), t);
  eq(w.queue.length, 0);
});

Deno.test("review: a stale payload tag shows nothing for approval and says it changed", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const acme = refOf(await page(w, s), "Acme Web");
  w.preps.set("greenhouse:acme:1", { ...w.preps.get("greenhouse:acme:1")!, payload_hash: "e".repeat(64) });
  const t = plain(await post(w, { t: s, action: "review", ref: acme, tag: tag(1) }));
  assert(/Changed since you opened this page, so nothing was sent/.test(t) && !/Check your application/.test(t), t);
  const t2 = plain(await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) }));
  assert(/Changed since you opened this page/.test(t2), t2);
  eq(w.outbox.length, 0, "no code for a payload that changed");
});

Deno.test("lockout: once locked, asking for a new code sends none and says why", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const acme = refOf(await page(w, s), "Acme Web");
  await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) });
  const wrong = String((Number(lastCode(w)) + 1) % 1000000).padStart(6, "0");
  for (let i = 0; i < 5; i++) await post(w, { t: s, action: "approve", ref: acme, tag: tag(1), code: wrong });
  const before = w.outbox.length;
  const t = plain(await post(w, { t: s, action: "code_send", ref: acme, tag: tag(1) }));
  assert(/Too many wrong codes in the last 10 minutes, so no new code was sent/.test(t), t);
  eq(w.outbox.length, before);
});
