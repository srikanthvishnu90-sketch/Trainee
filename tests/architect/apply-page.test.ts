// "Ask for a role, get a link, press the black Apply" (owner, 2026-11-02 12:10 CT). The results page's Apply is one tap when the
// application is READY (prepared, its tag matches, nothing marked needs): it approves exactly the "What will be sent" shown on
// the card, through the same hash-bound path as every Apply (kill switch, tag-changed refusal and duplicate guard unchanged). When
// it is NOT ready, Apply never sends and never fails silently: it asks the employer's open questions ("A few things first"),
// says the application is being prepared, or says what it can't collect. A GET never acts; a cross-site post is refused.
// Memory world (tests/helpers/results_world.ts): no network, no model, no database.
import assertNode from "node:assert/strict";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { MARKDOWN } from "../../supabase/functions/_shared/role_pay.ts";
import type { OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { cardOf, get, HASH, made, NOW, plain, POSTINGS, post, refIn, textOf, U, V, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const tagOf = (n: number) => hashTag(HASH(n));
const ACME = POSTINGS[0].job_id, GLOBEX = POSTINGS[1].job_id, INITECH = POSTINGS[2].job_id;
const Q = (id: string, o: Partial<OpenQuestion>): OpenQuestion => ({ id, key: `job:${id}`, kind: "text", label: "A question", type: "text", options: [], company: null, job_ids: [ACME], misfit: false, answer: null, ...o });
const SPONSOR = Q("11111111-aaaa-4aaa-8aaa-000000000001", { label: "Will you now or in the future require sponsorship?", type: "select", options: ["Yes", "No"] });
const LANG = Q("11111111-aaaa-4aaa-8aaa-000000000002", { label: "What is your strongest programming language?" });
const SSN = Q("11111111-aaaa-4aaa-8aaa-000000000003", { label: "Enter your Social Security Number" });
async function open(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  return { w, r, s, html: await (await get(w, s)).text() };
}
const acmeApply = (ref: string, tag = tagOf(1)) => ({ action: "apply", ref, tag });

// ================================================================== 1. the black Apply on every card
Deno.test("design: every role card has one solid black 'Apply' pill with an accessible name; What will be sent is on the card before the tap", async () => {
  const { html, w } = await open();
  const cards = html.split('<li class="card" id="r-').slice(1);
  eq(cards.length, 3);
  for (const c of cards) {
    eq((c.match(/<button type="submit" class="apply" aria-label="Apply to [^"]+ at [^"]+">Apply<\/button>/g) ?? []).length, 1, "one Apply per card, labelled exactly Apply");
    eq((c.match(/class="apply"/g) ?? []).length, 1, "one primary per card");
    assert(/<details class="send"><summary>What will be sent<\/summary>/.test(c), "the exact application is an expand on the card");
  }
  const acme = plain(cardOf(html, refIn(html, "Frontend Engineering Intern", "Acme Web")));
  for (const x of ["Resume ada-resume.pdf", "First name Ada", "Email ada@example.test", "Are you 18 or older? Yes", "Cover note I'd love to build at Acme Web.", "Sends to boards.greenhouse.io", `Application ${tagOf(1)}`]) assert(acme.includes(x), `${x}: ${acme}`);
  assert(/aria-label="Apply to Frontend Engineering Intern at Acme Web"/.test(html));
  // CSS: black, white text, 48px+ tall, kept visible in dark mode; the list's other primary, Apply to selected, is black too.
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  assert(/\.results \.apply,\.things \.apply\{[^}]*min-height:48px[^}]*border:2px solid #000;background:#000;color:#fff/.test(css), "black pill, white text, 48px");
  assert(/prefers-color-scheme:dark\)\{\.results \.apply[^}]*border-color:var\(--ink\)/.test(css), "dark mode: still clearly the primary (light edge)");
  assert(/<form method="post" id="sel">[\s\S]*?<button type="submit" class="apply">Apply to selected<\/button>/.test(html));
  eq(w.queue.length, 0, "drawing the page sends nothing");
});

// ================================================================== 2. ready: one tap approves exactly what was shown, once
Deno.test("ready: one POST approves exactly the prepared payload once; the card then shows the real status chip; a second POST is a duplicate", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const t = await textOf(await post(w, s, acmeApply(ref)));
  assert(/Approved\. It's queued to be sent exactly as its card showed/.test(t), t);
  eq(w.queue.length, 1);
  eq(w.queue[0].payload_hash, HASH(1));
  eq(w.queue[0].payload, w.preps.get(ACME)!.payload, "exactly the payload shown");
  const after = await (await get(w, s)).text();
  const card = cardOf(after, ref);
  assert(/<span class="chip queued" role="status">Approved<\/span>/.test(card), "the status is the record's: queued");
  assert(!/class="apply"/.test(card), "no Apply once it is in motion");
  // The same tap again: the posting goes once.
  const again = await textOf(await post(w, s, acmeApply(ref)));
  assert(/Already in your applications, so nothing more was sent/.test(again), again);
  eq(w.queue.length, 1, "the second POST is a duplicate: nothing more queued");
});

Deno.test("tag changed: a payload re-prepared after the page was drawn approves nothing, and the page says so", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  w.preps.set(ACME, { ...w.preps.get(ACME)!, payload_hash: HASH(7), payload: { ...(w.preps.get(ACME)!.payload as object), cover_note: "A different note." } });
  const t = await textOf(await post(w, s, acmeApply(ref)));
  assert(/Changed since you opened this page, so nothing was sent/.test(t), t);
  eq(w.queue.length, 0);
  assert(plain(cardOf(await (await get(w, s)).text(), ref)).includes("A different note."), "the new payload is shown, to check again");
});

Deno.test("kill switch: a paused account approves nothing from the page; a role that closed after the page was drawn approves nothing", async () => {
  const { w, s, html } = await open();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  w.deps.account = async () => ({ epoch: 0, version: 0, authority_version: 0, paused: true });
  assert(/Trainee is paused for you/.test(await textOf(await post(w, s, acmeApply(ref)))));
  eq(w.queue.length, 0);
  assert(!/aria-label="Apply to /.test(await (await get(w, s)).text()), "no Apply while paused");
  const b = await open();
  b.w.closed.add(ACME);
  assert(/Nothing was approved: .*closed/i.test(await textOf(await post(b.w, b.s, acmeApply(refIn(b.html, "Frontend Engineering Intern", "Acme Web"))))));
  eq(b.w.queue.length, 0);
});

// ================================================================== 3a. needs answers: "A few things first"
Deno.test("needs answers: Apply opens the questions (nothing sent); a bad answer re-asks with the reason; good answers are saved, the role is prepared again, and its card shows What will be sent and Apply", async () => {
  const w = world({ unprepared: [ACME] });
  w.qs.push({ ...SPONSOR }, { ...LANG });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await (await get(w, s)).text();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const card = plain(cardOf(html, ref));
  assert(/2 questions need your answer first\./.test(card), card);
  // Apply on a card that isn't ready opens the questions.
  const things = await (await post(w, s, { action: "apply", ref, tag: "none" })).text();
  assert(/A few things first/.test(things) && things.includes("Will you now or in the future require sponsorship?") && things.includes("What is your strongest programming language?"));
  assert(/type="radio"[^>]*name="q_11111111-aaaa-4aaa-8aaa-000000000001"[^>]*value="Yes"/.test(things) && /value="No"/.test(things), "the employer's options as radios");
  assert(/<input type="text" id="q_11111111-aaaa-4aaa-8aaa-000000000002"/.test(things), "free text otherwise");
  eq(w.queue.length, 0); eq(w.wants.length, 0); eq(w.saved.length, 0);
  // A wrong choice and an empty answer: re-asked with the reason, nothing saved, nothing prepared, nothing sent.
  const bad = await (await post(w, s, { action: "answer", ref, [`q_${SPONSOR.id}`]: "Maybe", [`q_${LANG.id}`]: "" })).text();
  assert(/Needs one of: Yes \/ No/.test(bad) && /Needs an answer/.test(bad), plain(bad));
  eq(w.saved.length, 0); eq(w.prepared.length, 0); eq(w.queue.length, 0);
  // One good, one still empty: the good one is saved, only the other is asked again.
  const half = await (await post(w, s, { action: "answer", ref, [`q_${SPONSOR.id}`]: "No", [`q_${LANG.id}`]: "" })).text();
  eq(w.saved, [{ id: SPONSOR.id, answer: "No" }]);
  assert(/Saved 1 answer/.test(plain(half)) && !half.includes("Will you now or in the future"), plain(half));
  eq(w.prepared.length, 0);
  // Both answered: saved as typed, prepared again (a NEW prepared row), back on the list with What will be sent and Apply. Not sent.
  const done = await (await post(w, s, { action: "answer", ref, [`q_${LANG.id}`]: "TypeScript" })).text();
  eq(w.saved.at(-1), { id: LANG.id, answer: "TypeScript" });
  eq(w.prepared, [ACME]);
  assert(/Saved\. Getting your application ready with your answers/.test(plain(done)), plain(done));
  const back = cardOf(done, ref);
  assert(/<summary>What will be sent<\/summary>/.test(back) && /class="apply" aria-label="Apply to Frontend Engineering Intern at Acme Web"/.test(back), "the fresh card has the black Apply");
  eq(w.queue.length, 0, "answering sends nothing");
  // Now the tap approves exactly the fresh payload.
  const tag = /name="tag" value="([0-9a-f]{16})"/.exec(back)![1];
  assert(/Approved\./.test(await textOf(await post(w, s, { action: "apply", ref, tag }))));
  eq(w.queue.length, 1);
});

Deno.test("needs answers: a question that needs a secret is never collected and a posted value is neither saved nor shown", async () => {
  const w = world({ unprepared: [ACME] });
  w.qs.push({ ...SSN });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await get(w, s)).text(), "Frontend Engineering Intern", "Acme Web");
  const page = await (await post(w, s, { action: "apply", ref, tag: "none" })).text();
  assert(/Trainee never collects this\. Type it yourself on the employer's site/.test(plain(page)), plain(page));
  assert(!/<input type="text"|<textarea|type="radio"/.test(page) && !/Save answers/.test(page), "no input for a secret");
  const forced = await (await post(w, s, { action: "answer", ref, [`q_${SSN.id}`]: "123-45-6789" })).text();
  assert(!forced.includes("123-45-6789"), "the value is not echoed");
  eq(w.saved.length, 0, "never saved"); eq(w.prepared.length, 0); eq(w.queue.length, 0);
});

// ================================================================== 3b. not prepared yet
Deno.test("not prepared: Apply queues it to be prepared, sends nothing, and the card says it is getting ready with a Refresh", async () => {
  const { w, s, html } = await open({ unprepared: [GLOBEX] });
  const ref = refIn(html, "Frontend Intern", "Globex");
  assert(/Not prepared yet\./.test(plain(cardOf(html, ref))));
  delete (w.deps as { reprepare?: unknown }).reprepare; // no preparer wired: the card waits with a Refresh
  const t = await textOf(await post(w, s, { action: "apply", ref, tag: "none" }));
  assert(/Getting your application ready\. Nothing is sent until you check it here and tap Apply/.test(t), t);
  eq(w.wants, [GLOBEX]); eq(w.queue.length, 0);
  const card = cardOf(await (await get(w, s)).text(), ref);
  assert(/Getting your application ready/.test(plain(card)) && />Refresh<\/a>/.test(card) && !/class="apply"/.test(card), "preparing: Refresh, no Apply");
  // Where the preparation really stands is said in the person's words when it is known (no resume: not invented as "working").
  w.deps.pending = async () => [{ posting_key: GLOBEX, company: "Globex", title: "Frontend Intern", url: "https://jobs.lever.co/globex/2", stage: "no_resume", detail: null, open_questions: 0, at: "" }];
  assert(/I don't have your resume file to attach/.test(plain(cardOf(await (await get(w, s)).text(), ref))));
});

Deno.test("not prepared: the first Apply tap starts preparing it (the person's own ask), sends nothing, and the card then shows What will be sent with its own Apply", async () => {
  const { w, s, html } = await open({ unprepared: [GLOBEX] });
  const ref = refIn(html, "Frontend Intern", "Globex");
  const t = await textOf(await post(w, s, { action: "apply", ref, tag: "none" }));
  assert(/Getting your application ready\. Nothing is sent until you check it here and tap Apply/.test(t), t);
  eq(w.wants, [GLOBEX]); eq(w.prepared, [GLOBEX]); eq(w.queue.length, 0);
  const card = cardOf(await (await get(w, s)).text(), ref);
  assert(/What will be sent/.test(plain(card)) && /class="apply"/.test(card), "prepared by the tap: What will be sent, then Apply");
  eq(w.queue.length, 0);
});

// ================================================================== safety: GET never acts, cross-site refused, other accounts
Deno.test("GET never acts: action words in the query, a preview, HEAD and the questions page save, approve and queue nothing", async () => {
  const w = world({ unprepared: [GLOBEX] });
  w.qs.push({ ...SPONSOR, job_ids: [GLOBEX] });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await (await get(w, s)).text();
  const a = refIn(html, "Frontend Engineering Intern", "Acme Web"), g = refIn(html, "Frontend Intern", "Globex");
  const q = new URLSearchParams({ action: "apply", ref: a, tag: tagOf(1), pick: `${a}:${tagOf(1)}`, [`q_${SPONSOR.id}`]: "No" }).toString();
  assert((await get(w, s, q)).status === 200);
  assert((await get(w, s, "", { method: "HEAD" })).status === 200);
  assert((await get(w, s, q, { headers: { "user-agent": "facebookexternalhit/1.1" } })).status === 200);
  const things = await (await get(w, s, `things=${g}&${q}`)).text();
  assert(/A few things first/.test(things), "the questions page opens on a GET");
  eq(w.queue.length, 0); eq(w.wants.length, 0); eq(w.saved.length, 0); eq(w.prepared.length, 0);
});

Deno.test("cross-site: a post another site made the browser send approves, saves and queues nothing", async () => {
  const { w, s, html } = await open({ unprepared: [GLOBEX] });
  w.qs.push({ ...SPONSOR, job_ids: [GLOBEX] });
  const a = refIn(html, "Frontend Engineering Intern", "Acme Web"), g = refIn(html, "Frontend Intern", "Globex");
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    for (const f of [acmeApply(a), { action: "answer", ref: g, [`q_${SPONSOR.id}`]: "No" }, { action: "apply", ref: g, tag: "none" }]) {
      const res = await post(w, s, f, { headers });
      eq(res.status, 403);
      assert(/came from another site/.test(await textOf(res)));
    }
  }
  eq(w.queue.length, 0); eq(w.wants.length, 0); eq(w.saved.length, 0);
});

Deno.test("cross-person: another account's session sees nothing and approves nothing", async () => {
  const { w, r, html } = await open();
  const ref = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const sv = await w.A.tok(V, r.listId, NOW);
  const other = await textOf(await post(w, sv, acmeApply(ref)));
  assert(!/Approved/.test(other));
  eq(w.queue.length, 0);
});

// ================================================================== 4. Apply to selected: ready ones in one tap, the rest skipped with a reason
Deno.test("apply to selected: the ready ones go in one tap, each with its own payload once; a not-ready one is skipped with a note and its questions link", async () => {
  const w = world({ unprepared: [GLOBEX] });
  w.qs.push({ ...SPONSOR, job_ids: [GLOBEX] });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await (await get(w, s)).text();
  const a = refIn(html, "Frontend Engineering Intern", "Acme Web"), i = refIn(html, "UI Engineer Intern", "Initech"), g = refIn(html, "Frontend Intern", "Globex");
  assert(new RegExp(`id="r-${g}"[\\s\\S]*?href="\\?things=${g}"`).test(html), "the not-ready card links to its questions");
  const res = await post(w, s, { action: "applysel" }, { pick: [`${a}:${tagOf(1)}`, `${i}:${tagOf(3)}`, `${g}:none`] });
  const out = await res.text(), t = plain(out);
  assert(/2 of 3 approved and queued, each exactly as its card showed\. 1 needs a few answers first\./.test(t), t);
  eq(w.queue.map((q) => q.job_id).sort(), [ACME, INITECH].sort());
  eq(w.queue.find((q) => q.job_id === ACME)!.payload, w.preps.get(ACME)!.payload);
  assert(/Needs a few answers first, so nothing was sent for it/.test(t));
  eq(w.wants.length, 0, "the skipped one was not even queued");
  // The same tap again approves nothing more.
  await post(w, s, { action: "applysel" }, { pick: [`${a}:${tagOf(1)}`, `${i}:${tagOf(3)}`] });
  eq(w.queue.length, 2);
  // A stale tag in the set is skipped, not approved.
  const w2 = world();
  const r2 = await made(w2), s2 = await w2.A.tok(U, r2.listId, NOW);
  const h2 = await (await get(w2, s2)).text();
  w2.preps.set(INITECH, { ...w2.preps.get(INITECH)!, payload_hash: HASH(8) });
  await post(w2, s2, { action: "applysel" }, { pick: [`${refIn(h2, "Frontend Engineering Intern", "Acme Web")}:${tagOf(1)}`, `${refIn(h2, "UI Engineer Intern", "Initech")}:${tagOf(3)}`] });
  eq(w2.queue.map((q) => q.job_id), [ACME], "the changed role was not approved");
});

// ================================================================== phone width
Deno.test("design: phone-first, light and dark, 44px touch targets, nothing wider than 360px", async () => {
  const w = world({ unprepared: [ACME] });
  w.qs.push({ ...SPONSOR }, { ...LANG });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const list = await (await get(w, s)).text();
  const things = await (await post(w, s, { action: "apply", ref: refIn(list, "Frontend Engineering Intern", "Acme Web"), tag: "none" })).text();
  for (const html of [list, things]) {
    assert(/name="viewport" content="width=device-width/.test(html));
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    assert(/prefers-color-scheme:dark/.test(css), "dark mode");
    assert(/min-height:44px/.test(css) && /min-height:48px/.test(css), "44px+ targets");
    assert(!/(?:^|[;{\s])width:(?:[4-9]\d\d|\d{4,})px/.test(css.replace(/@media[^{]*\{[^}]*\}/g, "")), "no fixed width past 360px");
    assert(/overflow-wrap:anywhere/.test(css));
  }
  assert(/<label class="opt" for="q_[^"]+_0"><input type="radio"/.test(things) && /<legend>/.test(things), "labelled inputs");
});

// ================================================================== 5. the chat reply: sentences, then the link alone
Deno.test("chat reply: the owner's phrasings give one or two plain sentences with honest counts, then the signed link ALONE as its own message, no markdown", async () => {
  for (const said of ["I want a data analyst role that pays $60k in Chicago", "find me 10 SWE intern roles", "I want frontend internships that pay $30/hr"]) {
    const w = world();
    const r = await made(w, U, said);
    eq(r.parts.length, 2, said);
    eq(r.parts[1], r.url, "the link is its own message");
    assert(/^https:\/\/trainee\.example\/file\?t=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(r.parts[1]));
    assert(!/https?:\/\//.test(r.parts[0]), "no link in the sentences");
    assert((r.parts[0].match(/[.!?](\s|$)/g) ?? []).length <= 3, `at most three sentences: ${r.parts[0]}`);
    assert(!MARKDOWN.test(r.parts.join("\n")), "no markdown on SMS, iMessage or WhatsApp");
    assert(!/Acme|Globex|Initech/.test(r.parts[0]), "no wall of postings");
    eq(r.reply, r.parts.join("\n"));
  }
  // Counts are honest with and without a pay floor.
  const a = await made(world(), U, "find me 10 SWE intern roles");
  assert(/^I found 4 [a-z ]+: 3 list pay and 1 doesn't\. Here they are by fit, with Apply on each\.$/.test(a.parts[0]), a.parts[0]);
  const b = await made(world(), U, "I want frontend internships that pay $30/hr");
  assert(/2 frontend internships that list pay of \$30\/hr or more, plus 1 that doesn't list pay/.test(b.parts[0]), b.parts[0]);
});
