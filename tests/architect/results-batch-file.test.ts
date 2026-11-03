// F-10 Batch File (owner design spec 3.10, capability 16) on the hosted results page: the batch-level elements.
//   batch id, counts strip by state (verbatim labels), state filters, exception banners, an honest Pause, and "Approve these N
//   applications" as the SAME hash-bound action as "Apply to all N ready" (no second approval path).
// Pure render checks plus the handler over the memory world (tests/helpers/results_world.ts): no network, no browser, no model.
// The Chromium measures (14px / 44px / contrast) are in role-pay-results-browser.test.ts (CI only).
import assertNode from "node:assert/strict";
import { DARK_T, designPairs, LIGHT_T } from "../../supabase/functions/_shared/results_design.ts";
import { BATCH_CSS, batchIdOf, filterByState, parseStateFilter } from "../../supabase/functions/_shared/results_batch.ts";
import { renderResults, type ResultRow } from "../../supabase/functions/_shared/results_page.ts";
import { STATES, type StateKey } from "../../supabase/functions/_shared/results_spec.ts";
import { cardOf, get, made, NOW, plain, post, refIn, U, world } from "../helpers/results_world.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const row = (i: number, o: Partial<ResultRow> = {}): ResultRow => ({
  ref: `ref${i}`, job: { job_id: `j${i}`, company: `Co${i}`, title: `Role ${i}`, url: `https://boards.example.test/${i}`, source: "greenhouse", location: "Austin, TX", remote: "hybrid", reasons: [] } as never,
  logo: null, snippet: "", full: null, status: null, tag: null, resume: null, byHand: false, blocked: null, why: [], posted: "Posted 2 d ago",
  payShown: "$30-40/hr", payGroup: "meets", payNote: null, payConv: null, place: "Austin, TX · Hybrid", rid: `R-0${i}`, ...o,
});
const st = (word: string, extra: Record<string, unknown> = {}) => ({ word, detail: "d", ...extra }) as never;
const feed = (rows: ResultRow[], o: Record<string, unknown> = {}) => ({ token: "tok", title: "frontend internships", floor: "$30/hr", rows, total: rows.length, filters: { pay: "any" as const, where: "" }, places: [], updated: "Nov 2, 2026, 9:00 AM CT", stamp: null, ...o });
// One role in each state the batch screen has to tell apart.
const MIX = () => [
  row(1, { tag: "a".repeat(16) }), row(2, { tag: "b".repeat(16) }), row(3, { openQs: 2 }), row(4, { blocked: "it would be sent to LinkedIn." }),
  row(5, { blocked: "its deadline to apply (Oct 30) has passed" }), row(6, { status: st("queued") }), row(7, { status: st("sending") }),
  row(8, { status: st("unknown") }), row(9, { status: st("needs you") }), row(10, { status: st("confirmed", { evidence: "Employer reference Z9" }) }),
];
const all3 = { hash: "0123456789abcdef", size: 2 };
const header = (html: string) => /<header class="filehead">[\s\S]*?<\/header>/.exec(html)![0];
const section = (html: string, cls: string) => new RegExp(`<section class="${cls}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";
const actions = (html: string) => [...html.matchAll(/name="action" value="([a-z]+)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------- batch id
Deno.test("batch: B-nn is stable for the list: not changed by order, duplicates or the refs it is asked about twice; a different list differs", () => {
  const a = batchIdOf(["r3", "r1", "r2"]);
  ok(/^B-\d\d$/.test(a), a);
  eq(batchIdOf(["r1", "r2", "r3"]), a);
  eq(batchIdOf(["r2", "r3", "r1", "r1"]), a);
  const ids = new Set(["x", "y", "z", "w", "v", "u", "t", "s"].map((r) => batchIdOf(["r1", "r2", r])));
  ok(ids.size > 1, "different lists get different ids");
});
Deno.test("batch: the header carries the batch id and the role total; the id does not move when a role is dismissed or the list is filtered", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length }));
  const id = batchIdOf(rows.map((r) => r.ref));
  ok(header(html).includes(`<b class="bid">${id}</b> 10 roles`), header(html));
  // Dismissed roles are still in coverRows; countRows drops them, and the id is over every role.
  const dismissed = renderResults(feed(rows.slice(1), { coverRows: rows, countRows: rows.slice(1), total: rows.length, dismissed: [rows[0]] }));
  ok(header(dismissed).includes(`<b class="bid">${id}</b> 9 roles`), header(dismissed));
  const filtered = renderResults(feed(rows.slice(0, 2), { coverRows: rows, countRows: rows, total: rows.length, filters: { pay: "meets" as const, where: "" } }));
  ok(header(filtered).includes(`<b class="bid">${id}</b>`));
  ok(!/<p class="batchline">/.test(renderResults(feed([]))), "no roles, no batch line");
});

// ---------------------------------------------------------------- counts strip
Deno.test("batch: the counts strip uses the spec's state words, every role in exactly one state, summing to the batch total", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length }));
  const strip = /<ul class="counts">([\s\S]*?)<\/ul>/.exec(html)![1];
  const items = [...strip.matchAll(/<li class="t-\w+"><b>(\d+)<\/b> ([^<]+)<\/li>/g)].map((m) => [m[2], Number(m[1])] as const);
  eq(items.reduce((n, [, c]) => n + c, 0), rows.length, "sums to the total");
  const labels = new Set(Object.values(STATES).map((s) => s.label));
  for (const [l] of items) ok(labels.has(l), `verbatim label: ${l}`);
  eq(Object.fromEntries(items)["Ready for review"], 2, "blocked and closed roles are never counted ready");
});

// ---------------------------------------------------------------- state filters
Deno.test("filters: one segment per state that has roles, verbatim labels with counts; All first; links keep the pay and place filters; a GET", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length, filters: { pay: "meets" as const, where: "remote" } }));
  const nav = /<nav class="segs"[\s\S]*?<\/nav>/.exec(html)![0];
  const segs = [...nav.matchAll(/<a href="([^"]*)"[^>]*class="seg[^"]*">([^<]*?) <b>(\d+)<\/b><\/a>/g)].map((m) => ({ href: m[1], label: m[2], n: Number(m[3]) }));
  eq(segs[0], { href: "?pay=meets&amp;where=remote", label: "All", n: 10 });
  eq(segs.slice(1).map((s) => s.label).sort(), ["Blocked", "Closed before submission", "In progress", "Needs candidate information", "Queued", "Ready for review", "Submission uncertain", "Submitted - confirmed", "User step needed"].sort());
  eq(segs.find((s) => s.label === "Ready for review")!.n, 2);
  ok(segs.every((s) => s.href.startsWith("?")), "plain GET links");
  ok(segs.find((s) => s.label === "Blocked")!.href.includes("state=blocked") && segs.find((s) => s.label === "Blocked")!.href.includes("pay=meets"));
  // A single state has nothing to filter between.
  ok(!/class="segs"/.test(renderResults(feed([row(1, { tag: "a".repeat(16) })]))));
});
Deno.test("filters: choosing a state shows only those roles, marks the segment, and the pay/place form carries the state along; an unknown state is ignored", () => {
  const rows = MIX();
  const f = (state: StateKey | null) => renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length, filters: { pay: "any" as const, where: "", state } }));
  const html = f("blocked");
  eq((html.match(/<li class="card"/g) ?? []).length, 1);
  ok(html.includes("Role 4") && !html.includes("Role 1<"), "only the blocked role");
  ok(/aria-current="true" class="seg on">Blocked <b>1<\/b>/.test(html), "the chosen segment is marked");
  ok(/<form method="get" class="filters" role="search"><input type="hidden" name="state" value="blocked">/.test(html));
  eq((f(null).match(/<li class="card"/g) ?? []).length, 10);
  eq(parseStateFilter("nonsense"), null);
  eq(parseStateFilter("needs_info"), "needs_info");
  eq(filterByState(rows, "ready").map((r) => r.ref), ["ref1", "ref2"]);
});
Deno.test("filters: through the handler, ?state= filters the cards, an unknown state shows them all, and nothing is sent", async () => {
  const w = world({ unprepared: ["greenhouse:acme:1"] });
  const r = await made(w); const s = await w.A.tok(U, r.listId, NOW);
  const all = await (await get(w, s)).text();
  eq((all.match(/<li class="card"/g) ?? []).length, 3);
  const one = await (await get(w, s, "state=discovered")).text();
  eq((one.match(/<li class="card"/g) ?? []).length, 1);
  ok(plain(cardOf(one, refIn(one, "Frontend Engineering Intern", "Acme Web"))).includes("Discovered"));
  const ready = await (await get(w, s, "state=ready")).text();
  eq((ready.match(/<li class="card"/g) ?? []).length, 2);
  eq((await (await get(w, s, "state=zzz")).text().then((h) => (h.match(/<li class="card"/g) ?? []).length)), 3);
  eq(w.queue.length, 0, "a GET sends nothing");
});

// ---------------------------------------------------------------- exception banners
Deno.test("exceptions: banners come before the role rows, in the owner's words, each a link to its roles; none when there are none", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length }));
  const exc = section(html, "exc");
  eq([...exc.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]), [
    ["1 submission uncertain", "?state=uncertain"], ["1 user step needed", "?state=user_step"], ["1 needs information", "?state=needs_info"],
    ["1 blocked", "?state=blocked"], ["1 closed before submission", "?state=closed"],
  ]);
  ok(html.indexOf('class="exc"') < html.indexOf('<li class="card"'), "before the role rows");
  const two = renderResults(feed([row(1, { openQs: 1 }), row(2, { openQs: 3 }), row(3, { blocked: "x" }), row(4, { blocked: "y" })]));
  const t = plain(section(two, "exc"));
  ok(/2 need information/.test(t) && /2 blocked/.test(t), t);
  eq(section(renderResults(feed([row(1, { tag: "a".repeat(16) }), row(2, { status: st("queued") })])), "exc"), "");
});
Deno.test("exceptions: a Submission uncertain role has no Apply, no retry and no select; blocked and closed roles are listed and never approvable", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length }));
  const card = (t: string) => html.split('<li class="card"').find((c) => c.includes(t))!;
  for (const t of ["Role 8", "Role 4", "Role 5"]) ok(!/class="apply"|type="checkbox"|retry|Try again/i.test(card(t)), `${t} has no approve control`);
  ok(/Submission uncertain/.test(card("Role 8")) && /Blocked/.test(card("Role 4")) && /Closed before submission/.test(card("Role 5")));
});

// ---------------------------------------------------------------- Approve these N: the one hash-bound action
Deno.test("approve: 'Apply to all N ready' is the hash-bound applyall form (action + the set hash), the only approval it draws, none when paused or absent", () => {
  const rows = [row(1, { tag: "a".repeat(16) }), row(2, { tag: "b".repeat(16) })];
  const html = renderResults(feed(rows, { all: all3, coverRows: rows, countRows: rows }));
  const sec = section(html, "batchact");
  const form = /<form method="post" id="all">([\s\S]*?)<\/form>/.exec(sec)![1];
  eq([...form.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]), [["t", "tok"], ["action", "applyall"], ["set", all3.hash]], "exactly the fields of the one hash-bound action");
  ok(/<button type="submit" class="apply">Apply to all 2 ready<\/button>/.test(form));
  ok(header(html).includes("review <span class=\"bid\">01234567</span> covers 2 ready"), "the review version is the hash the approval is bound to");
  // No second path: every action name on the page is one the handler already has.
  const used = new Set(actions(html)); for (const a of used) ok(["apply", "applysel", "applyall", "pause", "resume", "dismiss", "restore"].includes(a), `unknown action ${a}`);
  eq(actions(html).filter((a) => a === "applyall").length, 1);
  eq(section(renderResults(feed(rows, { all: all3, paused: true })), "batchact"), "", "paused: no approve");
  eq(section(renderResults(feed(rows)), "batchact"), "", "fewer than two ready: no approve");
  ok(!/Proceed|Continue/.test(plain(html)), "no generic Proceed or Continue");
});
Deno.test("approve: only the ready roles are named in the count; blocked, excluded and not-ready roles stay visible and out of it", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { all: { hash: "f".repeat(16), size: 2 }, coverRows: rows, countRows: rows, total: rows.length }));
  ok(/Apply to all 2 ready/.test(html) && !/Apply to all 10 ready/.test(html));
  ok(/Dismissed roles and roles that aren't ready are left out\. If anything changes first, nothing is approved\./.test(plain(section(html, "batchact"))));
  ok(html.includes("Role 4") && html.includes("Role 5"), "blocked and closed are still listed");
});

// ---------------------------------------------------------------- Pause is honest
Deno.test("pause: it pauses the page, says queued work is not cancelled, and names the roles that keep going; no cancel claim", () => {
  const rows = MIX();
  const html = renderResults(feed(rows, { coverRows: rows, countRows: rows, total: rows.length }));
  const note = plain(section(html, "pausenote"));
  ok(/Pause on this page does not cancel queued work\. Not stopped by Pause:/.test(note), note);
  ok(/R-06 Role 6 at Co6 Queued/.test(note) && /R-07 Role 7 at Co7 In progress/.test(note), note);
  ok(!/R-01|R-08/.test(note), "only queued, in-progress and approved roles are named");
  ok(/class="ghost danger">Pause on this page</.test(html), "the control is still the page pause, in danger style");
  ok(!/>Pause remaining</.test(html) && !/cancel(s|led)? (the )?queue\b/i.test(plain(html)), "no label or claim that the queue is cancelled");
  const paused = plain(section(renderResults(feed(rows, { paused: true, coverRows: rows, countRows: rows, total: rows.length })), "pausenote"));
  ok(/Paused on this page\. Queued work is not cancelled\. Still going:/.test(paused), paused);
  eq(section(renderResults(feed([row(1, { tag: "a".repeat(16) })])), "pausenote"), "", "nothing queued, nothing to name");
});
Deno.test("pause: through the handler, Pause changes only the page: a queued application stays queued and the page names it", async () => {
  const w = world();
  const r = await made(w); const s = await w.A.tok(U, r.listId, NOW);
  const html0 = await (await get(w, s)).text();
  const ref = refIn(html0, "Frontend Engineering Intern", "Acme Web");
  const tag = /name="tag" value="([0-9a-f]+)"/.exec(cardOf(html0, ref))![1];
  await post(w, s, { action: "apply", ref, tag });
  eq(w.queue.length, 1);
  const paused = await (await post(w, s, { action: "pause" })).text();
  eq(w.queue.length, 1, "pause cancels nothing");
  const note = plain(section(paused, "pausenote"));
  ok(/Paused on this page\. Queued work is not cancelled\. Still going:/.test(note) && /Acme Web Queued/.test(note), note);
  eq(section(paused, "batchact"), "");
});

// ---------------------------------------------------------------- design: 14px, 44px, contrast
Deno.test("design: batch elements are at least 14px, have 44px hit areas, fixed widths of 360px or less, and use only validated colour pairs", () => {
  const css = BATCH_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) { const f = /(?:^|;)font-size:(\d+(?:\.\d+)?)px/.exec(m[2]); if (f) ok(Number(f[1]) >= 14, `under 14px: ${m[1].trim()}`); }
  ok(/\.segs a\.seg\{[^}]*min-height:44px/.test(css) && /\.exc li a\{[^}]*min-height:44px/.test(css), "segments and banner links are 44px");
  for (const m of css.matchAll(/(?:min-width|width):(\d+)px/g)) ok(Number(m[1]) <= 360);
  // Banner text is a status colour on its own tint, the segment is plum text on plum-100, both validated by designPairs in both schemes.
  for (const t of [LIGHT_T, DARK_T]) {
    const pairs = new Map(designPairs(t).map(([n, fg, bg]) => [n, [fg, bg]]));
    for (const k of ["risk", "attention", "neutral"]) ok(pairs.has(`${k} chip text`), `${k} text on its tint is checked`);
    ok(pairs.has("plum text on plum-100 chip"));
  }
  ok(/\.exc li\.t-risk\{background:var\(--st-risk-bg\);color:var\(--st-risk\)\}/.test(css) && /\.segs a\.seg\.on\{background:var\(--plum-100\);color:var\(--plum-text\)/.test(css));
});
