// The results file's header (owner design input, 2026-11-01, from an Instinct file): a small "Made for <first name> · <date>",
// the large title, directly under it exactly what was read and when, a plain sentence on what is NOT confirmed, and a 2-3 line
// "Quick read" before the cards. Every count is counted from the rows; nothing is guessed (no name: "you"; a snapshot is said).
// The browser half (order on screen, sizes, contrast, light and dark) is in role-pay-results-browser.test.ts.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { made, NOW, plain, POSTINGS, U, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const open = async (w: W, s: string) => await (await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${s}` } }), w.deps)).text();
const between = (html: string, a: string, b: string) => { const i = html.indexOf(a), j = html.indexOf(b); assert(i >= 0 && j >= 0, `${a} and ${b} on the page`); return i < j; };

Deno.test("header: made for the person's first name and day, the title, what was read and when, what is not confirmed, then the quick read, then the cards", async () => {
  const w = world();
  w.deps.timeZone = async () => "America/Chicago";
  const r = await made(w, U, undefined, { name: "Ada Lovelace", source: "live" });
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await open(w, s), t = plain(html);
  assert(/Made for Ada · Nov 1, 2026/.test(t), t);
  assert(/Frontend internships, \$30\/hr or more Check time unknown From 2 sources on the live board\./.test(t), "the checked-at line (no time on file here), then where they came from");
  assert(/Pay is shown only where the posting lists it; 1 role doesn't list pay, so it's grouped separately\. Fit is judged only on what you've confirmed\./.test(t), t);
  assert(/Quick read Best matches: Frontend Engineering Intern at Acme Web; UI Engineer Intern at Initech\. 2 of 3 list \$30\/hr or more; 1 doesn't list pay\. Next: tap Apply/.test(t), t);
  for (const [a, b] of [['class="made"', "<h1>"], ["<h1>", 'class="stamp"'], ['class="stamp"', 'class="caveat"'], ['class="caveat"', 'class="quick"'], ['class="quick"', '<li class="card"']]) assert(between(html, a, b), `${a} before ${b}`);
  const quickLines = /<section class="quick"[\s\S]*?<\/section>/.exec(html)![0].match(/<p>/g)!.length;
  assert(quickLines >= 2 && quickLines <= 3, `the quick read is 2-3 lines (${quickLines})`);
});

Deno.test("header: no name on file says 'you'; no zone on file is Chicago's; a snapshot list says it is not the live board", async () => {
  const w = world();
  const r = await made(w, U, undefined, { name: null, source: "snapshot", read: "2026-10-15" });
  const s = await w.A.tok(U, r.listId, NOW);
  const t = plain(await open(w, s));
  assert(/Made for you · Nov 1, 2026/.test(t), t);
  assert(/From a saved snapshot of job boards read Oct 15, 2026, not the live board, so some may have closed; 2 sources\./.test(t), t);
  assert(!/Postings checked/.test(t), "a snapshot is never called a check of the postings");
  // A name is only letters: markup or a sentence in the name field becomes no name at all, never markup.
  const w2 = world();
  const r2 = await made(w2, U, undefined, { name: "<img src=x onerror=alert(1)>", source: "live" });
  const t2 = await open(w2, await w2.A.tok(U, r2.listId, NOW));
  assert(!/<img src=x/.test(t2) && /Made for (?:you|img) · /.test(plain(t2)), plain(t2).slice(0, 200));
});

Deno.test("header: when every role lists pay, the caveat says nothing is estimated and the quick read has no 'doesn't list pay'", async () => {
  const w = world({ postings: POSTINGS.filter((p) => p.company !== "Globex") }); // Globex is the one role without pay
  const r = await made(w, U, undefined, { name: "Ada", source: "live" });
  const t = plain(await open(w, await w.A.tok(U, r.listId, NOW)));
  assert(/Pay is shown only where the posting lists it, and nothing is estimated\./.test(t), t);
  assert(/2 of 2 list \$30\/hr or more\./.test(t) && !/doesn't list pay|don't list pay/.test(t), t);
  eq(r.unlisted, 0);
});
