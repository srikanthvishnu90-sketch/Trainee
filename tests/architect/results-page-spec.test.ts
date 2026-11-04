// The hosted results page against the product spec (PRD 4 file anatomy, 5 button meanings, 6 states and evidence, 7.10 pause,
// 8.8 duplicate tap, 4.9 export). Memory world (tests/helpers/results_world.ts): no network, no model, no database.
import assertNode from "node:assert/strict";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { AppRow } from "../../supabase/functions/trainee-file/handler.ts";
import { countsOf, coverage, reqIdOf, roleIds, specOf, NOTHING_SENT } from "../../supabase/functions/_shared/results_spec.ts";
import { cardOf, get, HASH, made, NOW, plain, POSTINGS, post, refIn, U, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const tagOf = (n: number) => hashTag(HASH(n));
async function open(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  return { w, r, s, html: await (await get(w, s)).text() };
}
const app = (state: string, extra: Partial<AppRow> = {}): AppRow => ({ id: "j", state, reason: null, confirmation_id: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), email_confirmed_at: null, payload: {}, company: "Acme Web", url: "u", ...extra });
const top = (html: string) => plain(/<section class="top"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");

// ---------------------------------------------------------------- pure
Deno.test("spec: role ids come from the sorted refs, so the order the page shows them in never changes them", () => {
  const refs = ["c3", "a1", "b2"];
  eq([...roleIds(refs)], [["a1", "R-01"], ["b2", "R-02"], ["c3", "R-03"]]);
  eq(roleIds([...refs].reverse()).get("b2"), "R-02");
});
Deno.test("spec: a requisition id only where the posting states one", () => {
  eq(reqIdOf("Requisition ID: R-4471 Build things"), "R-4471");
  eq(reqIdOf("Build React components. Job ID 12"), null);
});
Deno.test("spec: primary states are mutually exclusive and counted once; 'confirmed' with no evidence is Still checking", () => {
  const base = { byHand: false, blocked: null, tag: null as string | null };
  const rows = [
    { ...base, status: null, tag: "a".repeat(16) },
    { ...base, status: null, openQs: 2 },
    { ...base, status: { word: "preparing" as const, detail: "x" } },
    { ...base, status: { word: "confirmed" as const, detail: "x", evidence: "Employer reference Z9" } },
    { ...base, status: { word: "confirmed" as const, detail: "x", evidence: null } },
    { ...base, status: { word: "queued" as const, detail: "x" } },
    { ...base, status: null, byHand: true },
  ];
  const c = countsOf(rows);
  eq(c.reduce((n, x) => n + x.n, 0), rows.length, "every role counted exactly once");
  eq(Object.fromEntries(c.map((x) => [x.key, x.n])), { ready: 1, needs: 1, preparing: 1, notprep: 0, progress: 2, done: 1, blocked: 1 });
  eq(specOf(rows[4]).label, "Checking");
  eq(specOf(rows[3]).label, "Submitted - confirmed");
  eq(specOf(rows[5]).label, "Queued");
  eq(coverage([rows[0]]), NOTHING_SENT);
  assert(!/^Nothing has been sent/.test(coverage(rows)), "never says nothing was sent when roles are approved or submitted");
});

// ---------------------------------------------------------------- the page
Deno.test("top: counts by primary state from the rows, the coverage line, the updated time, Pause remaining", async () => {
  const { html } = await open();
  const t = top(html);
  assert(/3 Ready for review/.test(t), t);
  assert(t.includes("Nothing has been sent. Apply sends only the application as its card shows it."), t);
  assert(/Page updated .*20\d\d/.test(t), t);
  assert(/Pause on this page/.test(t) && /not cancelled/.test(t), "pause says in-flight stays");
});
Deno.test("top: counts follow row states, not clicks: a queued row moves out of Ready and the line stops saying nothing was sent", async () => {
  const { w, s } = await open();
  const ref = refIn(await (await get(w, s)).text(), "Frontend Engineering Intern", "Acme Web");
  await post(w, s, { action: "apply", ref, tag: tagOf(1) });
  const html = await (await get(w, s)).text(), t = top(html);
  assert(/2 Ready for review/.test(t) && /1 Queued/.test(t), t);
  assert(!t.includes("Nothing has been sent."), t);
  assert(/1 role is already approved, started or submitted/.test(t), t);
  // a second tap on the same role: current state and what it holds, not a bare refusal
  const again = plain(await (await post(w, s, { action: "apply", ref, tag: tagOf(1) })).text());
  assert(/Already in your applications, so nothing more was sent/.test(again), again);
});
Deno.test("card: Apply is explained in words, role id and unknown labels are readable", async () => {
  const { html } = await open();
  const card = plain(cardOf(html, refIn(html, "Frontend Intern", "Globex")));
  assert(/R-0\d/.test(card), card);
  assert(card.includes("Apply approves and sends exactly the application as its card shows it."), card);
  assert(/Requisition ID Not listed/.test(card) && /Checked Check time unknown/.test(card) && /Pay not listed/i.test(card), card);
  assert(/Ready for review/.test(card), "a ready role reads Ready for review");
});
Deno.test("ids: a role keeps its id when the filter or sort changes", async () => {
  const { w, s, html } = await open();
  const idOf = (h: string, t: string, c: string) => /R-\d+/.exec(plain(cardOf(h, refIn(h, t, c))))![0];
  const a1 = idOf(html, "Frontend Engineering Intern", "Acme Web");
  const filtered = await (await get(w, s, "where=remote")).text();
  const g1 = idOf(html, "Frontend Intern", "Globex"), g2 = idOf(filtered, "Frontend Intern", "Globex");
  eq(g1, g2);
  assert(a1 !== g1);
});
Deno.test("status: confirmed with an employer reference reads Submitted and confirmed, with the evidence; without evidence it is Still checking", async () => {
  for (const [row, label, evid] of [[app("confirmed", { confirmation_id: "ABC-123" }), "Submitted - confirmed", "Employer reference ABC-123"], [app("confirmed"), "Checking", ""], [app("driving"), "In progress", ""]] as const) {
    const w = world(); const r = await made(w); const s = await w.A.tok(U, r.listId, NOW);
    const orig = w.store.appRow; w.store.appRow = async (u, id, url) => id === POSTINGS[0].job_id ? row : orig(u, id, url);
    const html = await (await get(w, s)).text();
    const ref = refIn(html, "Frontend Engineering Intern", "Acme Web"), card = plain(cardOf(html, ref));
    assert(card.includes(label), card);
    const ex = await (await get(w, s, "export=txt")).text();
    assert(ex.includes(`Status: ${label}`), ex);
    if (evid) assert(ex.includes(`Evidence: ${evid}`), ex);
    if (label === "Submitted - confirmed") {
      const dup = plain(await (await post(w, s, { action: "apply", ref, tag: "none" })).text());
      assert(/Already submitted for this role/.test(dup) && dup.includes("Employer reference ABC-123"), dup);
    }
  }
});
Deno.test("dismiss: private and reversible, keeps ids, leaves counts honest and touches no application", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Intern", "Globex");
  const before = /R-\d+/.exec(plain(cardOf(html, ref)))![0];
  const after = await (await post(w, s, { action: "dismiss", ref })).text();
  assert(!/<h3 class="title">Frontend Intern<\/h3><p class="co">Globex/.test(after.split("Dismissed (")[0]), "gone from the active list");
  assert(/Dismissed \(1\)/.test(after) && after.includes(before), "listed at the bottom with the same id");
  assert(/2 Ready for review/.test(top(after)));
  eq(w.queue.length, 0); eq(w.wants.length, 0);
  const blocked = plain(await (await post(w, s, { action: "apply", ref, tag: tagOf(2) })).text());
  assert(/dismissed/i.test(blocked)); eq(w.queue.length, 0);
  const back = await (await post(w, s, { action: "restore", ref })).text();
  assert(/3 Ready for review/.test(top(back)) && !/Dismissed \(/.test(back));
});
Deno.test("pause: no new approvals from the page, says in-flight stays, resume restores; nothing is cancelled", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const p = await (await post(w, s, { action: "pause" })).text();
  assert(/Paused on this page\./.test(plain(p)) && /already approved or in progress are not cancelled/.test(plain(p)));
  assert(!/class="apply"/.test(p.split('<ul class="cards">')[1] ?? ""), "no Apply while paused");
  const tap = plain(await (await post(w, s, { action: "apply", ref, tag: tagOf(1) })).text());
  assert(/Paused/.test(tap)); eq(w.queue.length, 0);
  const r = await (await post(w, s, { action: "resume" })).text();
  assert(/class="apply"/.test(r) && !/<b>Paused on this page\.<\/b>/.test(r));
});
Deno.test("export: ?export=txt is text/plain, every role with state, source URL and a real or honest action line; signed-out gets no list", async () => {
  const { w, s } = await open();
  const res = await get(w, s, "export=txt");
  assert((res.headers.get("content-type") ?? "").startsWith("text/plain"));
  const t = await res.text();
  for (const p of POSTINGS.slice(0, 3)) assert(t.includes(p.company!) && t.includes(`Source URL: ${p.url}`), p.company);
  eq((t.match(/^R-\d+ /gm) ?? []).length, 3);
  assert((t.match(/Action available in private workspace/g) ?? []).length >= 3);
  assert(!/Open application: (?!https?:\/\/)/.test(t), "no fake urls");
  assert(t.includes("Status: Ready for review") && t.includes("Nothing has been sent."));
  const anon = await get(w, "not-a-session", "export=txt");
  assert(!(await anon.text()).includes("Source URL:"), "same auth as the page");
});

// ---------------------------------------------------------------- review fixes (F1-F8)
Deno.test("F1: a dismissed role that was already sent still stops the page saying nothing was sent; Dismiss is refused on a sent row", async () => {
  const w = world(); const r = await made(w); const s = await w.A.tok(U, r.listId, NOW);
  const html0 = await (await get(w, s)).text(), ref = refIn(html0, "Frontend Engineering Intern", "Acme Web");
  await post(w, s, { action: "apply", ref, tag: tagOf(1) }); // now queued
  const refused = plain(await (await post(w, s, { action: "dismiss", ref })).text());
  assert(/Not dismissed: this application is already approved/.test(refused), refused);
  // force the stored mark (an older dismissal, then the role was sent): header and export still tell the truth
  const meta = await w.store.recallListMeta!(U, r.listId); await w.store.rememberListMeta!(U, r.listId, { ...meta!, dismissed: [ref] });
  const html = await (await get(w, s)).text();
  assert(!top(html).includes("Nothing has been sent."), top(html));
  assert(/already approved, started or submitted/.test(top(html)));
  const ex = await (await get(w, s, "export=txt")).text();
  const lead = ex.split("\nWhere things stand")[0];
  assert(!lead.includes("Nothing has been sent.") && /already approved, started or submitted/.test(lead) && /Dismissed by you/.test(ex), ex);
});
Deno.test("F2: needs_user with an emailed code counts as sent", async () => {
  const w = world(); const r = await made(w); const s = await w.A.tok(U, r.listId, NOW);
  const orig = w.store.appRow; w.store.appRow = async (u, id, url) => id === POSTINGS[0].job_id ? app("needs_user", { reason: "email_code" }) : orig(u, id, url);
  const html = await (await get(w, s)).text();
  assert(!top(html).includes("Nothing has been sent."), top(html));
  assert(!(await (await get(w, s, "export=txt")).text()).split("\nWhere things stand")[0].includes("Nothing has been sent."));
  assert(/already approved, started or submitted/.test(top(html)));
});
Deno.test("F3: the pause control says it covers this page and that Telegram still works", async () => {
  const { html } = await open();
  assert(/Pause on this page/.test(html) && /Telegram: the buttons there still work/.test(plain(html)));
  assert(!/>Pause remaining</.test(html));
});
Deno.test("F4: ids come from the raw list; a role's id does not move when other roles are dismissed", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Intern", "Globex"), id = /R-\d+/.exec(plain(cardOf(html, ref)))![0];
  const other = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const after = await (await post(w, s, { action: "dismiss", ref: other })).text();
  eq(/R-\d+/.exec(plain(cardOf(after, ref)))![0], id);
});
Deno.test("F5: no requisition id from prose or without a digit or label", () => {
  eq(reqIdOf("Requisition: Engineering team"), null);
  eq(reqIdOf("Req: Platform"), null);
  eq(reqIdOf("requisition for a senior role"), null);
  eq(reqIdOf("Requisition ID: ENG"), null);
  eq(reqIdOf("Req # 4471"), "4471");
  eq(reqIdOf("Requisition number: JR-2231"), "JR-2231");
});
Deno.test("F6: totals and the quick read count the kept (non-dismissed) roles", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Intern", "Globex");
  const after = plain(await (await post(w, s, { action: "dismiss", ref })).text());
  assert(/\b2 roles, sorted by fit|2 of 2 list/.test(after), after.slice(0, 600));
});
Deno.test("F7: dismiss merges into the freshly stored meta (a pause saved meanwhile is kept)", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Intern", "Globex");
  await post(w, s, { action: "pause" });
  await post(w, s, { action: "dismiss", ref });
  const page = await (await get(w, s)).text();
  assert(/Paused on this page/.test(page) && /Dismissed \(1\)/.test(page), "both marks survive");
});
Deno.test("F8: all picks dismissed says so; signed-out dismiss says nothing changed; the quick read follows coverage", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Intern", "Globex");
  await post(w, s, { action: "dismiss", ref });
  const t = plain(await (await post(w, s, { action: "applysel" }, { pick: [`${ref}:${tagOf(2)}`] })).text());
  assert(/Those roles are dismissed/.test(t) && !/Tick at least one role/.test(t), t);
  const out = plain(await (await post(w, "not-a-session", { action: "dismiss", ref })).text());
  assert(/Nothing was approved or sent from this tap/.test(out), out);
  const one = await open();
  const r1 = refIn(one.html, "Frontend Engineering Intern", "Acme Web");
  await post(one.w, one.s, { action: "apply", ref: r1, tag: tagOf(1) });
  const q = plain(await (await get(one.w, one.s)).text());
  assert(/Each new send needs your tap on Apply/.test(q) && !/Next:[^.]*\. [^.]*\. Nothing is sent until you tap Apply/.test(q), q.slice(0, 900));
});
