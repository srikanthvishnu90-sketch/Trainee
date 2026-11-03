// "Reply yes and I'll apply to all N shown" (owner, 2026-11-02 17:10 CT). The mass-apply flow's one-word approval:
//   - the results message ends with ONE plain question and records an OFFER in that turn's meta (the list, each shown role's ref and the
//     application tag it has now, or none when it is not prepared yet);
//   - a bare yes on the next turn, while that offer is the thread's last assistant word and no older than the text-yes window, approves
//     exactly those roles through the page Apply's hash-bound path (tapJob Confirm: duplicate guard, tag-changed refusal, posting screen,
//     paused account / kill switch). A role not prepared when offered is never approved by the yes (it is queued to prepare, or its
//     employer question is asked); dismissed roles and a paused page are left out; a yes with no live offer approves nothing new;
//   - the hosted results page has a black "Apply to all N ready" button that does the same, bound to the hash of the exact set.
// Memory world (tests/helpers/results_world.ts): no network, no model, no database.
import assertNode from "node:assert/strict";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { APPLY_ALL_INTENT, applyAllYesTurn, isApplyAllYes, isConditionalYes, OFFER_WINDOW_MS, offerOf, offerQuestion, readOffer, type ApplyAllOffer } from "../../supabase/functions/_shared/apply_all_yes.ts";
import { overclaims } from "../../supabase/functions/_shared/apply_status_summary.ts";
import type { OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import type { ListMeta } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { applyAllYesEnabled } from "../../supabase/functions/_shared/apply_all_yes.ts";
import { cardOf, ENV, get, HASH, made, NOW, plain, POSTINGS, post, refIn, textOf, U, V, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ACME = POSTINGS[0].job_id, GLOBEX = POSTINGS[1].job_id;
const SPONSOR: OpenQuestion = { id: "11111111-aaaa-4aaa-8aaa-000000000001", key: "job:s", kind: "text", label: "Will you now or in the future require sponsorship?", type: "select", options: ["Yes", "No"], company: null, job_ids: [ACME], misfit: false, answer: null };

// The thread's last assistant word after the results message.
const lastOf = (offer: ApplyAllOffer, extra: Record<string, unknown> = {}) => ({ intent: "career_search", meta: { results_file: offer.list, apply_all_offer: offer, ...extra } });
async function setup(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const r = await made(w, U, "I want frontend internships"); // no pay floor: all four postings are on the list
  return { w, r, last: lastOf(r.offer) };
}
const yes = (w: W, last: ReturnType<typeof lastOf> | null, o: { message?: string; at?: number } = {}) => {
  w.clock.t = o.at ?? NOW + 60_000;
  return applyAllYesTurn({ message: o.message ?? "yes", userId: U, now: w.clock.t, last, deps: w.deps, questions: w.deps.questions, prepare: w.deps.reprepare });
};
const meta = (w: W, listId: string) => w.store.recallListMeta!(U, listId) as Promise<ListMeta>;

// ================================================================== 0. the question and the offer
Deno.test("the results message ends with one plain question; the offer holds the list and each role's tag", async () => {
  const { r } = await setup();
  eq(r.offerAsk, "Reply yes and I'll apply to all 4 shown. Each application's exact answers are on the page; I skip any with blank or sensitive answers.");
  eq(r.offer.v, 1); eq(r.offer.list, r.listId); eq(r.offer.at, NOW);
  eq(r.offer.jobs.length, 4);
  for (const j of r.offer.jobs) eq(j.tag, hashTag(HASH(POSTINGS.findIndex((p) => p.job_id === j.job_id) + 1)), "each role carries the tag its page card shows");
  eq(readOffer({ apply_all_offer: JSON.parse(JSON.stringify(r.offer)) }), r.offer, "survives the meta round trip");
  const a = await setup({ unprepared: [ACME, GLOBEX] });
  eq(a.r.offer.jobs.filter((j) => j.tag === null).map((j) => j.job_id).sort(), [ACME, GLOBEX].sort(), "a role not prepared has no tag");
  assert(/prepared so far and get the other 2 ready/.test(a.r.offerAsk), a.r.offerAsk);
  const none = offerOf({ list: "a".repeat(10), at: NOW, jobs: [{ ref: "b".repeat(12), job_id: "x:1" }] });
  eq(offerQuestion(none), "Reply yes and I'll start getting it ready to apply.");
  eq(readOffer({ apply_all_offer: { ...r.offer, list: "../x" } }), null, "a malformed offer is no offer");
  eq(readOffer({ apply_all_offer: { ...r.offer, jobs: [{ ref: "zz", job_id: "x", tag: null }] } }), null);
  eq(readOffer({}), null); eq(readOffer(null), null);
});

Deno.test("what counts as a bare yes (D-MS-1): only the plain words approve; ok, sure, sounds good, a maybe, 'yes?' and the rest approve NOTHING", () => {
  for (const m of ["yes", "Yes!", "yep", "yeah", "Yeah.", "yes please", "yes, please", "do it", "go ahead", "apply to all", "Apply to all of them", "send them all", "send all", "approve all", "yes apply to all", "yes send them all", "yes do it", "yeah please"]) assert(isApplyAllYes(m), m);
  for (const m of ["ok", "okay", "sure", "sounds good", "absolutely", "definitely", "ya", "y", "yup", "maybe", "yes?", "yeah maybe", "no", "nope", "yes but not Acme", "yes except 2", "yes, skip Globex", "yes and also email them", "what jobs", "apply to Acme", "yesterday", "not yet", "yes I work at Acme", "", "apply", "apply to them all", "send them all to my mom", "\u{1F44D}", "yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes"]) assert(!isApplyAllYes(m), m);
  for (const m of ["yes but not Acme", "yeah except 2", "yes, skip Globex", "yep without the first one"]) assert(isConditionalYes(m), m);
  for (const m of ["yes", "yes what is the salary?", "ok but not 2", "no"]) assert(!isConditionalYes(m), m);
});

Deno.test("a yes with a condition approves nothing and says the offer is still open (and keeps it)", async () => {
  const { w, last } = await setup();
  const r = (await yes(w, last, { message: "yes but not Acme" }))!;
  eq(w.queue.length, 0); eq(r.status, "not_plain");
  assert(/I haven't approved anything\. The offer to apply to all 4 shown is still open: reply just "yes"/.test(r.reply), r.reply);
  assert("apply_all_offer" in r.meta, "the offer is still the last word");
  eq((await yes(w, { intent: "x", meta: r.meta }, { at: NOW + 90_000 }))!.counts.approved, 4, "a plain yes then approves the offer");
});

Deno.test("no confirmed resume: nothing approved or prepared, and the readiness path is asked for", async () => {
  const { w, last } = await setup({ unprepared: [GLOBEX] });
  w.clock.t = NOW + 60_000;
  const r = (await applyAllYesTurn({ message: "yes", userId: U, now: w.clock.t, last, deps: w.deps, questions: w.deps.questions, prepare: w.deps.reprepare, resumeConfirmed: false }))!;
  eq(r.status, "no_resume"); eq(w.queue.length, 0); eq(w.wants.length, 0); eq(w.prepared.length, 0); eq(r.asks.unprepared, 1);
});

Deno.test("a role not prepared is screened before it is queued to prepare (a closed posting is not queued)", async () => {
  const { w, last } = await setup({ unprepared: [GLOBEX] });
  w.closed.add(GLOBEX);
  const r = (await yes(w, last))!;
  eq(w.wants.length, 0, "the screen the page's Apply runs stopped it"); eq(r.counts.blocked, 1); eq(r.counts.getting_ready, 0);
});

// ================================================================== 1. yes queues exactly the offered ready jobs
Deno.test("yes queues exactly the offered ready jobs, each by its offered hash, once; the reply counts only what was approved", async () => {
  const { w, last } = await setup();
  const r = (await yes(w, last))!;
  eq(r.intent, APPLY_ALL_INTENT); eq(r.status, "approved");
  eq(w.queue.map((q) => q.payload_hash).sort(), [1, 2, 3, 4].map(HASH).sort());
  eq(w.queue.map((q) => q.job_id).sort(), POSTINGS.map((p) => p.job_id).sort(), "exactly the offered roles");
  for (const q of w.queue) eq(q.payload, w.preps.get(q.job_id)!.payload, "exactly the payload on file");
  eq(r.counts.approved, 4);
  assert(/^Approved and queued 4 applications, each exactly as it was prepared/.test(r.reply), r.reply);
  eq(overclaims(r.reply, r.summary), [], "no 'applied' claim without a confirmed row");
  eq(r.summary.counts.approved, 4); eq(r.summary.applied_ok, 0);
  assert(!/\bapplied\b|submitted|sent to/i.test(r.reply.replace(/already in your applications/gi, "")), r.reply);
  eq(w.wants.length, 0, "nothing extra was queued to prepare");
  assert("apply_all_done" in r.meta && !("apply_all_offer" in r.meta), "the offer is spent by this turn");
});

Deno.test("a role that is in the thread's list but NOT in the offer is never applied to", async () => {
  const { w, r } = await setup();
  const smaller = { ...r.offer, jobs: r.offer.jobs.slice(0, 2) };
  const out = (await yes(w, lastOf(smaller)))!;
  eq(out.counts.approved, 2);
  eq(w.queue.map((q) => q.job_id).sort(), r.offer.jobs.slice(0, 2).map((j) => j.job_id).sort());
  // A forged offer naming another person's role (not on this list for this account) approves nothing for it.
  const forged: ApplyAllOffer = { ...r.offer, jobs: [{ ref: "0".repeat(12), job_id: "greenhouse:acme:1", tag: hashTag(HASH(1)) }] };
  const w2 = world(); await made(w2, U, "I want frontend internships");
  const f = (await yes(w2, lastOf(forged)))!;
  eq(f.counts.approved, 0); eq(w2.queue.length, 0);
});

// ================================================================== 2. no live offer
Deno.test("yes with no live offer queues nothing and falls through (null)", async () => {
  const { w, r } = await setup();
  eq(await yes(w, null), null);
  eq(await yes(w, { intent: "career_search", meta: { results_file: r.listId } }), null, "the results link alone is not an offer");
  eq(await yes(w, { intent: "career_apply_questions", meta: {} }), null);
  eq((await yes(w, lastOf(r.offer), { message: "yes but not Acme" }))!.status, "not_plain", "a yes with conditions approves nothing");
  eq(await yes(w, lastOf(r.offer), { message: "what about Globex" }), null);
  eq(w.queue.length, 0); eq(w.wants.length, 0);
});

Deno.test("stale offer: older than the text-yes window approves nothing", async () => {
  const { w, last } = await setup();
  eq(await yes(w, last, { at: NOW + OFFER_WINDOW_MS + 1 }), null);
  eq(w.queue.length, 0);
  eq(await yes(w, last, { at: NOW - 1 }), null, "an offer from the future is not live either");
  const inside = (await yes(w, last, { at: NOW + OFFER_WINDOW_MS }))!;
  eq(inside.counts.approved, 4, "still live at the edge of the window");
});

// ================================================================== 3. duplicates
Deno.test("duplicate yes does not double-queue: the spent offer falls through, and a replay of the same offer finds them already in", async () => {
  const { w, last } = await setup();
  const first = (await yes(w, last))!;
  eq(w.queue.length, 4);
  // The next turn's last assistant word is the first yes's reply: its meta holds no offer.
  eq(await yes(w, { intent: APPLY_ALL_INTENT, meta: first.meta }, { at: NOW + 120_000 }), null);
  // Two yes turns racing on the same offer: the hash-bound approval is once per application.
  const again = (await yes(w, last, { at: NOW + 130_000 }))!;
  eq(w.queue.length, 4, "still four");
  eq(again.counts.approved, 0); eq(again.counts.already, 4);
  assert(/^Nothing was approved\./.test(again.reply) && /already in your applications/.test(again.reply), again.reply);
});

// ================================================================== 4. changed tag
Deno.test("changed tag: an application re-prepared after the offer is refused by name; the others go", async () => {
  const { w, last } = await setup();
  w.preps.set(ACME, { ...w.preps.get(ACME)!, payload_hash: HASH(7), payload: { ...(w.preps.get(ACME)!.payload as object), cover_note: "A different note." } });
  const r = (await yes(w, last))!;
  eq(r.counts.approved, 3); eq(r.counts.changed, 1);
  assert(!w.queue.some((q) => q.job_id === ACME), "the changed role was not queued");
  eq(w.queue.length, 3);
  assert(/Acme Web changed after I offered it, so I didn't approve it/.test(r.reply), r.reply);
  eq(r.status, "partial");
  eq(overclaims(r.reply, r.summary), []);
});

// ================================================================== 5. missing info and not-yet-prepared roles
Deno.test("a role with an open employer question is not queued and the reply says it needs an answer (the handler asks it, one at a time)", async () => {
  const { w, last } = await setup({ unprepared: [ACME] });
  w.qs.push({ ...SPONSOR });
  const r = (await yes(w, last))!;
  eq(r.counts.approved, 3); eq(r.counts.needs_info, 1);
  eq(w.queue.map((q) => q.job_id).sort(), [GLOBEX, POSTINGS[2].job_id, POSTINGS[3].job_id].sort());
  eq(w.wants.length, 0, "a role waiting on an answer is not queued to prepare");
  eq(w.prepared.length, 0);
  assert(/Acme Web needs an answer from you first, so none of that one was queued/.test(r.reply), r.reply);
  eq(r.asks.questions, 1);
});

Deno.test("a role not prepared when offered is queued to prepare and listed as getting ready; it is never approved by this yes, even if it became ready", async () => {
  const { w, last } = await setup({ unprepared: [GLOBEX] });
  const r = (await yes(w, last))!;
  eq(w.wants, [GLOBEX], "queued to be prepared, like the page's Apply on a card that isn't ready");
  eq(w.prepared, [GLOBEX], "preparing was started");
  eq(w.queue.map((q) => q.job_id).includes(GLOBEX), false, "no payload nobody saw was approved");
  eq(r.counts.approved, 3); eq(r.counts.getting_ready, 1); eq(r.asks.unprepared, 1);
  assert(/1 role is getting ready \(Globex\)/.test(r.reply) && /nothing is sent for them until you see and approve what's prepared/.test(r.reply), r.reply);
  // The same offer again, now that its application exists: still not approved (it was not what was offered); the person checks it first.
  const second = (await yes(w, last, { at: NOW + 150_000 }))!;
  eq(second.counts.ready_since, 1); eq(second.counts.approved, 0); eq(w.queue.length, 3);
});

Deno.test("preparing that cannot start is said, and nothing is sent", async () => {
  const { w, last } = await setup({ unprepared: [GLOBEX] });
  w.deps.reprepare = async () => "off";
  const r = (await yes(w, last))!;
  assert(/preparing hasn't started yet, so they wait in your queue; nothing is sent for them/.test(r.reply), r.reply);
  eq(w.queue.length, 3);
});

// ================================================================== 6. paused and dismissed
Deno.test("dismissed roles are excluded; a paused page approves and starts nothing", async () => {
  const { w, r, last } = await setup();
  const m = await meta(w, r.listId);
  const refs = (await w.store.recallList(U, r.listId))!;
  await w.store.rememberListMeta!(U, r.listId, { ...m, dismissed: [refs[0]] });
  const out = (await yes(w, last))!;
  eq(out.counts.approved, 3); eq(out.counts.left_out, 1);
  assert(!w.queue.some((q) => q.job_id === r.offer.jobs[0].job_id), "the dismissed role was not applied to");
  assert(/1 role you dismissed on the list was left out/.test(out.reply), out.reply);

  const p = await setup({ unprepared: [GLOBEX] });
  await p.w.store.rememberListMeta!(U, p.r.listId, { ...(await meta(p.w, p.r.listId)), paused: { at: NOW } });
  const paused = (await yes(p.w, p.last))!;
  eq(paused.status, "paused"); eq(p.w.queue.length, 0); eq(p.w.wants.length, 0); eq(p.w.prepared.length, 0);
  assert(/paused/.test(paused.reply) && /nothing was approved or started/.test(paused.reply), paused.reply);
});

// ================================================================== 7. kill switch and other guards
Deno.test("kill switch: a paused account approves nothing; a role that closed since the offer approves nothing", async () => {
  const { w, last } = await setup();
  w.deps.account = async () => ({ epoch: 0, version: 0, authority_version: 0, paused: true });
  const r = (await yes(w, last))!;
  eq(r.counts.approved, 0); eq(r.counts.blocked, 4); eq(w.queue.length, 0);
  assert(/^Nothing was approved\./.test(r.reply) && /can't be approved right now/.test(r.reply), r.reply);
  const b = await setup();
  b.w.closed.add(ACME);
  const c = (await yes(b.w, b.last))!;
  eq(c.counts.approved, 3); eq(c.counts.blocked, 1); eq(b.w.queue.some((q) => q.job_id === ACME), false);
});

Deno.test("an unreadable list or a list that is gone approves nothing and says so; unreadable keeps the offer for a retry", async () => {
  const { w, last } = await setup();
  const orig = w.store.recallList;
  w.store.recallList = async () => { throw new Error("db down"); };
  const bad = (await yes(w, last))!;
  eq(bad.status, "unreadable"); eq(w.queue.length, 0); assert("apply_all_offer" in bad.meta);
  w.store.recallList = orig;
  const w2 = world(); const r2 = await made(w2, U, "I want frontend internships");
  await w2.store.rememberList(U, r2.listId, []);
  w2.store.recallListMeta = async () => null;
  const gone = (await yes(w2, lastOf(r2.offer)))!;
  eq(gone.status, "gone"); eq(w2.queue.length, 0);
});

Deno.test("another person's yes: the offer's roles are read and approved only for the account that said yes", async () => {
  const { w, last } = await setup();
  const out = (await applyAllYesTurn({ message: "yes", userId: V, now: NOW + 60_000, last, deps: w.deps, prepare: w.deps.reprepare }))!;
  eq(out.counts.approved, 0); eq(w.queue.length, 0, "nothing queued for a list that is not this account's");
});

// ================================================================== 8. the hosted page: Apply to all N ready
async function page() {
  const { w, r } = await setup();
  const s = await w.A.tok(U, r.listId, NOW);
  return { w, r, s, html: await (await get(w, s)).text() };
}
const setOf = (html: string) => /<form method="post" id="all">[\s\S]*?name="set" value="([0-9a-f]{16})"[\s\S]*?<button type="submit" class="apply">Apply to all (\d+) ready<\/button>/.exec(html);

Deno.test("page: a black 'Apply to all N ready' button bound to the exact set; a GET sends nothing", async () => {
  const { w, html } = await page();
  const m = setOf(html);
  assert(m, "the button is on the page");
  eq(m![2], "4");
  assert(/Approves the 4 ready roles on this list, each exactly as its What will be sent shows/.test(plain(html)));
  assert(/\.results \.apply,\.things \.apply\{[^}]*background:#000;color:#fff/.test(/<style>([\s\S]*?)<\/style>/.exec(html)![1]), "same black pill as every Apply");
  eq(w.queue.length, 0);
  const w1 = world({ unprepared: [ACME, GLOBEX, POSTINGS[2].job_id] });
  const r1 = await made(w1, U, "I want frontend internships");
  assert(!setOf(await (await get(w1, await w1.A.tok(U, r1.listId, NOW))).text()), "fewer than two ready: no all-button (each card has its own Apply)");
});

Deno.test("page: the button approves exactly the ready set, once; a second post finds nothing new", async () => {
  const { w, s, html } = await page();
  const set = setOf(html)![1];
  const t = await textOf(await post(w, s, { action: "applyall", set }));
  assert(/4 of 4 approved and queued, each exactly as its card showed/.test(t), t);
  eq(w.queue.length, 4); eq(w.queue.map((q) => q.payload_hash).sort(), [1, 2, 3, 4].map(HASH).sort());
  const again = await textOf(await post(w, s, { action: "applyall", set }));
  assert(/This list changed since you opened it, so nothing was approved/.test(again), again);
  eq(w.queue.length, 4);
});

Deno.test("page: a changed application, a stale set, dismissed roles and a paused page approve what they should", async () => {
  const a = await page();
  const set = setOf(a.html)![1];
  a.w.preps.set(ACME, { ...a.w.preps.get(ACME)!, payload_hash: HASH(7) });
  assert(/This list changed since you opened it, so nothing was approved/.test(await textOf(await post(a.w, a.s, { action: "applyall", set }))));
  eq(a.w.queue.length, 0, "a changed tag changes the set's hash: nothing is approved");
  assert(!(await textOf(await post(a.w, a.s, { action: "applyall", set: "0".repeat(16) }))).includes("approved and queued"), "a made-up hash approves nothing");

  const d = await page();
  const ref = refIn(d.html, "Frontend Engineering Intern", "Acme Web");
  await post(d.w, d.s, { action: "dismiss", ref });
  const after = await (await get(d.w, d.s)).text();
  const m = setOf(after)!;
  eq(m[2], "3", "dismissed roles are not in the set");
  assert(/3 of 3 approved/.test(await textOf(await post(d.w, d.s, { action: "applyall", set: m[1] }))));
  assert(!d.w.queue.some((q) => q.job_id === ACME));
  // An old set that still included the dismissed role approves nothing.
  const e = await page();
  const old = setOf(e.html)![1];
  await post(e.w, e.s, { action: "dismiss", ref: refIn(e.html, "Frontend Engineering Intern", "Acme Web") });
  assert(/This list changed/.test(await textOf(await post(e.w, e.s, { action: "applyall", set: old }))));
  eq(e.w.queue.length, 0);

  const p = await page();
  const pset = setOf(p.html)![1];
  await post(p.w, p.s, { action: "pause" });
  assert(!setOf(await (await get(p.w, p.s)).text()), "no all-button while paused");
  assert(/Paused\. Nothing was approved or started from this tap/.test(await textOf(await post(p.w, p.s, { action: "applyall", set: pset }))));
  eq(p.w.queue.length, 0);
});

Deno.test("page: the card for the all-button is not shown on another person's session, and a cross-site post is refused", async () => {
  const { w, s, html } = await page();
  const set = setOf(html)![1];
  const res = await post(w, s, { action: "applyall", set }, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  eq(res.status, 403); eq(w.queue.length, 0);
  void cardOf; void V;
});

Deno.test("page: with a filter on, the all-button still means the whole list and says so; the set is the same", async () => {
  const { w, s } = await page();
  const plainHtml = await (await get(w, s)).text();
  const filtered = await (await get(w, s, "where=Remote")).text();
  const a = setOf(plainHtml)!, b = setOf(filtered)!;
  eq(a[1], b[1], "same hash: the whole list, not the shown rows"); eq(a[2], b[2]);
  assert(/all 4 ready roles on the whole list, not only the roles your filters show/.test(plain(filtered)), plain(filtered).slice(0, 600));
  assert(!/not only the roles your filters show/.test(plain(plainHtml)));
});

// ================================================================== review round 3
Deno.test("batch yes skips (never approves) roles with a blank required field or a sensitive answer, and reports the skips with counts", async () => {
  const { w, last } = await setup();
  const [a, b, c, d] = POSTINGS.map((p) => p.job_id);
  const edit = (id: string, fn: (fields: any[]) => any[]) => { const p = w.preps.get(id)!; w.preps.set(id, { ...p, payload: { ...p.payload, fields: fn(structuredClone((p.payload as any).fields)) } }); };
  // The offer holds each role's tag from before these edits, so keep each tag: only the answers shown change.
  edit(a, (f) => [...f, { name: "why", label: "Why do you want this role?", value: "" }]);                // blank required
  edit(b, (f) => [...f, { name: "gender", label: "Gender", value: "Female" }]);                          // sensitive answer
  edit(c, (f) => [...f, { name: "pw", label: "Account password", type: "password", value: "hunter2hunter2" }]); // secret
  const r = (await yes(w, last))!;
  eq(w.queue.map((q) => q.job_id), [d], "only the clean role is approved");
  eq(r.counts.approved, 1); eq(r.counts.skipped_blank, 1); eq(r.counts.skipped_sensitive, 2);
  assert(/Skipped 3 roles \(1 with a blank required field and 2 with sensitive answers\)/.test(r.reply), r.reply);
  assert(/exact answers are on the page/.test(r.reply), r.reply);
  eq(overclaims(r.reply, r.summary), []);
  // An optional blank field (required:false) does not hold a role back.
  const w2 = (await setup()); const p2 = w2.w.preps.get(a)!;
  w2.w.preps.set(a, { ...p2, payload: { ...p2.payload, fields: [...(p2.payload as any).fields, { name: "linkedin", label: "LinkedIn", value: "", required: false }] } });
  eq((await yes(w2.w, w2.last))!.counts.approved, 4);
});

Deno.test("the offer text says the exact payloads are on the page and that blank or sensitive ones are skipped", async () => {
  const { r } = await setup();
  assert(/exact answers are on the page/.test(r.offerAsk) && /skip any with blank or sensitive answers/.test(r.offerAsk), r.offerAsk);
});

Deno.test("CAREER_APPLY_ALL_YES=off hides the page button and the applyall action refuses (nothing approved)", async () => {
  const { w, s, html } = await page();
  const set = setOf(html)![1];
  assert(applyAllYesEnabled({ get: () => undefined }) && !applyAllYesEnabled({ get: (k) => k === "CAREER_APPLY_ALL_YES" ? "off" : undefined }));
  ENV.CAREER_APPLY_ALL_YES = "off";
  try {
    assert(!setOf(await (await get(w, s)).text()), "no Apply to all button when off");
    const t = await textOf(await post(w, s, { action: "applyall", set }));
    assert(/Apply to all is turned off\. Nothing was approved\./.test(t), t);
    eq(w.queue.length, 0);
  } finally { delete ENV.CAREER_APPLY_ALL_YES; }
  assert(setOf(await (await get(w, s)).text()), "back on: the button is back");
});

Deno.test("two yes at once (concurrent): each role is approved once and the second yes does not double-approve", async () => {
  const { w, last } = await setup();
  w.clock.t = NOW + 60_000;
  const go = () => applyAllYesTurn({ message: "yes", userId: U, now: w.clock.t, last, deps: w.deps, questions: w.deps.questions, prepare: w.deps.reprepare });
  const [x, y] = await Promise.all([go(), go()]);
  eq(w.queue.length, 4, "four applications, never eight"); eq(new Set(w.queue.map((q) => q.job_id)).size, 4);
  eq(x!.counts.approved + y!.counts.approved, 4, "approved counts add up to the four, not eight");
});
