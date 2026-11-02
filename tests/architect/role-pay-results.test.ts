// "I want X roles that pay $Y" (owner, 2026-11-01): the search's rows become a hosted results page (role_results.ts), drawn
// like every Trainee file (results_page.ts), with Apply on each card and Apply to selected. Apply shows the exact application;
// Approve needs the one-time code Trainee sends to the person's own chat (approval_code.ts) and then goes through the same
// hash-bound Confirm as every other Apply (telegram_jobs.ts tapJob -> cards.confirm). Memory stores and a fixed clock: no
// network, no model, no database. The handler-level proof is role-pay-results-handler.test.ts; the browser proof is
// role-pay-results-browser.test.ts.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { MARKDOWN, parsePay, payGroup, payText, resultsReply } from "../../supabase/functions/_shared/role_pay.ts";
import { BASE, HASH, made, NOW, plain, prep, U, V, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const req = (w: W, o: { cookie?: string; method?: string; query?: string; body?: Record<string, string | string[]>; ua?: string }) => {
  const body = o.body ? new URLSearchParams(Object.entries(o.body).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x]))).toString() : undefined;
  return handleFile(new Request(`https://x.example/f${o.query ? `?${o.query}` : ""}`, { method: o.method ?? (body ? "POST" : "GET"),
    headers: { ...(o.cookie ? { cookie: `tf_s=${o.cookie}` } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(o.ua ? { "user-agent": o.ua } : {}) }, body }), w.deps);
};
const tagOf = (n: number) => hashTag(HASH(n));
const refIn = (html: string, title: string, company?: string) => {
  const card = html.split('<li class="card" id="r-').slice(1).find((c) => c.includes(`<h3 class="title">${title}</h3>`) && (!company || c.includes(`<p class="co">${company}</p>`)));
  assert(card, `a card for ${title}`);
  return card!.slice(0, 12);
};
const codeIn = (t: string) => /code is (\d{6})/.exec(t)?.[1] ?? "";

// ================================================================== pay
Deno.test("pay: read from the posting into numbers; one format; a floor keeps only listed pay that reaches it; no pay is its own group", () => {
  const p = (s: unknown, d?: unknown) => parsePay(s, d);
  eq(payText(p("$35 - $40 per hour")!), "$35-40/hr");
  eq(payText(p("$30/hr")!), "$30/hr");
  eq(payText(p("$90k-$120k")!), "$90-120k/yr");
  eq(payText(p("$153,000 - $221,000 USD")!), "$153-221k/yr");
  eq(payText(p(null, "<p>Pay: $35 - $40 per hour.</p>")!), "$35-40/hr", "read from the description when the field is empty");
  eq(p(null, "We raised $40M in funding."), null, "funding is not pay");
  eq(p(null, "Ship UI features."), null, "no pay stated: none invented");
  const floor = { amount: 30, period: "hour" as const };
  eq(payGroup(p("$35-40/hr"), floor), "meets");
  eq(payGroup(p("$30/hr"), floor), "meets");
  eq(payGroup(p("$25/hr"), floor), "below");
  eq(payGroup(p("$25-32/hr"), floor), "meets", "the top of a listed range reaches the floor");
  eq(payGroup(p("$70,000 - $80,000"), floor), "meets", "$70k a year is over $30/hr (2,080 hours)");
  eq(payGroup(p("$50,000"), floor), "below");
  eq(payGroup(null, floor), "unlisted", "no pay is never counted as meeting the floor");
  eq(payGroup(p("€60k–€75k"), floor), "unchecked", "another currency is not compared with a dollar floor");
});

Deno.test("reply: one or two plain sentences (found, how many meet the pay, the caveat), then the link alone on its own line", () => {
  const what = { one: "frontend internship", many: "frontend internships" }, floor = { amount: 30, period: "hour" as const }, url = `${BASE}?t=v1.abc.def`;
  const r = resultsReply({ what, floor, meets: 2, unlisted: 1, url });
  eq(r, `I found 2 frontend internships that list pay of $30/hr or more, plus 1 that doesn't list pay, so I couldn't check it. Here they are by fit, with Apply on each:\n${url}`);
  const lines = r.split("\n");
  eq(lines.length, 2); eq(lines[1], url);
  assert(!MARKDOWN.test(r), "no markdown on a texting channel");
  assert((lines[0].match(/[.:](\s|$)/g) ?? []).length <= 2, "two sentences at most before the link");
  eq(resultsReply({ what, floor, meets: 0, unlisted: 3, url }).split("\n")[0], "I found 3 frontend internships, but none of them list pay, so I couldn't check them against $30/hr. Here they are by fit, with Apply on each:");
  eq(resultsReply({ what, floor, meets: 1, unlisted: 0, url }).split("\n")[0], "I found 1 frontend internship that lists pay of $30/hr or more. Here they are by fit, with Apply on each:");
});

// ================================================================== the list and the page
Deno.test("results file: fit order, listed-and-meeting first, then 'pay not listed'; below the floor left out; what was asked kept with the list", async () => {
  const w = world();
  const r = await made(w);
  eq([r.meets, r.unlisted, r.below], [2, 1, 1]);
  const refs = (await w.store.recallList(U, r.listId))!;
  const jobs = await Promise.all(refs.map(async (x) => (await w.store.recall(U, x))!.job));
  eq(jobs.map((j) => j.company), ["Acme Web", "Initech", "Globex"], "Hooli ($25/hr) is out; Globex (no pay) is last, in its own group");
  eq(jobs.map((j) => j.pay), ["$35-40/hr", "$30/hr", null], "pay only as the posting states it; none invented for Globex");
  eq(await w.store.recallListMeta!(U, r.listId), { kind: "results", what: "frontend internships", floor: { amount: 30, period: "hour" }, at: NOW, name: null, source: null, read: null, sources: 2 });
  assert(r.url.startsWith(`${BASE}?t=v1.`), "a signed link");
});

Deno.test("page: one card per role (title, company, pay with its source or 'Pay not listed', place, posted age, fit reason, source link, Apply), grouped, filters", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const res = await req(w, { cookie: s });
  eq(res.status, 200);
  const html = await res.text(), t = plain(html);
  assert(/Frontend internships, \$30\/hr or more/.test(t), "the title says what was asked");
  assert(/Lists \$30\/hr or more \(2\)[\s\S]*Frontend Engineering Intern Acme Web[\s\S]*UI Engineer Intern Initech[\s\S]*Pay not listed \(1\)[\s\S]*Frontend Intern Globex/.test(t), t);
  assert(/Pay \$35-40\/hr · listed on the posting/.test(t), "pay with where it came from");
  assert(/Frontend Intern Globex Pay Pay not listed/.test(t), "no pay: said, never invented");
  assert(/Where Austin, TX · Hybrid/.test(t) && /Posted 2 d ago/.test(t), t);
  assert(/Why it fits: You listed React and TypeScript\./.test(t), "the fit reason from confirmed facts");
  assert(html.includes('href="https://boards.greenhouse.io/acme/jobs/1"') && /Open on boards\.greenhouse\.io/.test(t), "the source link");
  eq((html.match(/<button type="submit" class="ghost go" aria-label="Apply to /g) ?? []).length, 3, "an Apply on each card (secondary; Apply to selected is the primary)");
  eq((html.match(/type="checkbox" form="sel" name="pick"/g) ?? []).length, 3, "each card can be selected");
  assert(/<form method="post" id="sel">[\s\S]*Apply to selected/.test(html), "Apply to selected");
  assert(!/Hooli/.test(t), "below the floor: not on the page");
  // Filters (a GET form): pay listed and meeting the floor only; remote only; a place.
  // The cards only (the quick read above them names the best matches whatever the filter).
  const cards = (h: string) => plain(h.slice(h.indexOf('<main id="main">')));
  const only = cards(await (await req(w, { cookie: s, query: "pay=meets" })).text());
  assert(/Acme Web/.test(only) && /Initech/.test(only) && !/Globex/.test(only), only);
  const remote = cards(await (await req(w, { cookie: s, query: "where=remote" })).text());
  assert(!/Acme Web/.test(remote) && /Initech/.test(remote) && /Globex/.test(remote), remote);
  const none = cards(await (await req(w, { cookie: s, query: "pay=meets&where=Boston" })).text());
  assert(/No roles match these filters\. Show all 3/.test(none), "an empty state that says how to widen it");
});

// ================================================================== Apply: the exact application, then Approve with the chat code
Deno.test("apply: the exact application is shown; approve needs the code sent to the person's chat; then one queue row with exactly that payload", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await req(w, { cookie: s })).text(), "Frontend Engineering Intern");
  // A one-tap approval from this list does nothing.
  const tap = plain(await (await req(w, { body: { t: s, action: "apply", ref, tag: tagOf(1) } })).text());
  assert(/Apply opens the exact application first/.test(tap) && w.queue.length === 0, "one tap approves nothing on a results list");
  // Apply: the review, with every field, the resume, the cover note, where it goes and the payload tag.
  const rv = await (await req(w, { body: { t: s, action: "review", ref, tag: tagOf(1) } })).text(), rt = plain(rv);
  for (const x of ["Check your application", "Resume ada-resume.pdf", "First name Ada", "Email ada@example.test", "Are you authorized to work in the US? Yes", "Cover note I'd love to build at Acme Web.", "Sends to boards.greenhouse.io", `Application ${tagOf(1)}`]) assert(rt.includes(x), `${x}: ${rt}`);
  eq(w.queue.length, 0, "showing it approves nothing");
  // Approve without a code, and with a wrong one: nothing.
  assert(/Get a code first/.test(plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code: "" } })).text())));
  const sent = plain(await (await req(w, { body: { t: s, action: "code_send", ref, tag: tagOf(1) } })).text());
  assert(/We sent a 6-digit code to your Trainee chat/.test(sent), sent);
  eq(w.outbox.length, 1); eq(w.outbox[0].user, U, "the code goes to this person's own chat");
  assert(/^status:approve-code:/.test(w.outbox[0].key));
  const code = codeIn(w.outbox[0].text);
  assert(/^\d{6}$/.test(code));
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
  assert(/That code didn't work, so nothing was sent/.test(plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code: wrong } })).text())));
  eq(w.queue.length, 0);
  // The right code: one queue row, bound to the payload hash that was shown, carrying exactly that payload.
  const ok = plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code } })).text());
  assert(/Approved\. It's queued to be sent exactly as you checked it/.test(ok) && /Queued/.test(ok), ok);
  eq(w.queue.length, 1);
  eq(w.queue[0].payload_hash, HASH(1));
  eq(w.queue[0].payload, w.preps.get("greenhouse:acme:1")!.payload, "exactly the payload shown");
  // The code works once; the posting goes once.
  const again = plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code } })).text());
  assert(/Already in your applications/.test(again), again);
  eq(w.queue.length, 1);
  // The spent code on another role: refused; nothing more queued.
  const other = refIn(await (await req(w, { cookie: s })).text(), "UI Engineer Intern");
  const reused = plain(await (await req(w, { body: { t: s, action: "approve", ref: other, tag: tagOf(3), code } })).text());
  assert(/That code was already used, so nothing was sent/.test(reused), reused);
  eq(w.queue.length, 1);
});

Deno.test("apply: a payload that changed after it was shown approves nothing, even with a good code", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await req(w, { cookie: s })).text(), "Frontend Engineering Intern");
  await req(w, { body: { t: s, action: "review", ref, tag: tagOf(1) } });
  await req(w, { body: { t: s, action: "code_send", ref, tag: tagOf(1) } });
  w.preps.set("greenhouse:acme:1", { ...prep("greenhouse:acme:1", 1), payload_hash: "e".repeat(64) });
  const t = plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code: codeIn(w.outbox[0].text) } })).text());
  assert(/Changed since you opened this page, so nothing was sent/.test(t), t);
  eq(w.queue.length, 0);
});

Deno.test("apply: an unprepared role is queued to be prepared (nothing sent) and says so", async () => {
  const w = world({ unprepared: ["greenhouse:initech:3"] });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await req(w, { cookie: s })).text(), "UI Engineer Intern");
  const t = plain(await (await req(w, { body: { t: s, action: "review", ref, tag: "none" } })).text());
  assert(/Getting your application ready\. Nothing is sent until you check it and approve it here/.test(t), t);
  eq(w.wants, ["greenhouse:initech:3"]); eq(w.queue.length, 0);
});

Deno.test("apply to selected: one review of exactly the ticked roles, one approval with one code, each queued with its own payload", async () => {
  const w = world();
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await (await req(w, { cookie: s })).text();
  const a = refIn(html, "Frontend Engineering Intern"), g = refIn(html, "Frontend Intern", "Globex");
  const picks = [`${a}:${tagOf(1)}`, `${g}:${tagOf(2)}`];
  const rv = await (await req(w, { body: { t: s, action: "review_sel", pick: picks } })).text(), rt = plain(rv);
  assert(/Check 2 applications/.test(rt) && /Acme Web/.test(rt) && /Globex/.test(rt) && !/Initech/.test(rt), rt);
  const set = /name="set" value="([0-9a-f]{16})"/.exec(rv)![1];
  await req(w, { body: { t: s, action: "code_send", pick: picks, set } });
  const code = codeIn(w.outbox.at(-1)!.text);
  // A set that is not the one reviewed (a third role slipped in) approves nothing.
  const i = refIn(html, "UI Engineer Intern");
  const slipped = plain(await (await req(w, { body: { t: s, action: "approve_sel", pick: [...picks, `${i}:${tagOf(3)}`], set, code } })).text());
  assert(/That code was sent for a different selection, so nothing was sent/.test(slipped), slipped);
  eq(w.queue.length, 0);
  const done = plain(await (await req(w, { body: { t: s, action: "approve_sel", pick: picks, set, code } })).text());
  assert(/All 2 approved and queued, each exactly as you checked it/.test(done), done);
  eq(w.queue.map((q) => [q.job_id, q.payload_hash]), [["greenhouse:acme:1", HASH(1)], ["lever:globex:2", HASH(2)]]);
});

// ================================================================== GET never consumes or approves
Deno.test("GET-safety: link previews and any GET (with action words in the query, any agent, HEAD) approve nothing, send no code, use up nothing", async () => {
  const w = world();
  const r = await made(w);
  const link = new URL(r.url).searchParams.get("t")!;
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await req(w, { cookie: s })).text(), "Frontend Engineering Intern");
  await req(w, { body: { t: s, action: "code_send", ref, tag: tagOf(1) } });
  const code = codeIn(w.outbox[0].text);
  const outboxBefore = w.outbox.length;
  const q = `action=approve&ref=${ref}&tag=${tagOf(1)}&code=${code}&t=${encodeURIComponent(s)}`;
  for (const ua of ["facebookexternalhit/1.1 Facebot Twitterbot/1.0", "WhatsApp/2.23", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (iPhone) AppleWebKit Safari", "curl/8"]) {
    for (const method of ["GET", "HEAD"]) {
      await req(w, { method, query: `t=${encodeURIComponent(link)}`, ua });
      await req(w, { method, query: q, ua, cookie: s });
      await req(w, { method, query: q.replace("approve", "approve_sel"), ua, cookie: s });
      await req(w, { method, query: q.replace("approve", "code_send"), ua, cookie: s });
      // The signed-in browser's own cookie, the action words in the query and no t= at all (a prefetch of a crafted URL).
      const bare = q.replace(/&t=[^&]*/, "");
      for (const a of ["approve", "approve_sel", "code_send", "apply", "applyall"]) await req(w, { method, query: bare.replace("approve", a) + `&pick=${ref}:${tagOf(1)}`, ua, cookie: s });
    }
  }
  eq(w.queue.length, 0, "no GET approved anything");
  eq(w.outbox.length, outboxBefore, "no GET sent a code");
  for (const l of w.A.logins.values()) eq(l.done_at, null, "no GET used up the link");
  // The code is still good: the GETs did not spend it.
  const ok = plain(await (await req(w, { body: { t: s, action: "approve", ref, tag: tagOf(1), code } })).text());
  assert(/Approved\./.test(ok), ok);
  eq(w.queue.length, 1);
});

// ================================================================== another person's link or code
Deno.test("cross-person: another account's link, session or code opens, shows and approves nothing", async () => {
  const w = world();
  const mine = await made(w, U);
  const sU = await w.A.tok(U, mine.listId, NOW), sV = await w.A.tok(V, mine.listId, NOW);
  // V's session pointed at U's list id: V has no such list; nothing of U's is shown.
  const seen = await req(w, { cookie: sV });
  const vt = plain(await seen.text());
  assert(seen.status === 404 && !/Acme Web|Globex|Initech/.test(vt), vt);
  // U's link opened in a browser signed in as V: refused, nothing used up.
  const link = new URL(mine.url).searchParams.get("t")!;
  const opened = await req(w, { query: `t=${encodeURIComponent(link)}`, cookie: sV });
  eq(opened.status, 403);
  assert(/This link is for a different Trainee account/.test(plain(await opened.text())));
  // V posting U's row and tag with V's own code: V's list has no such row; nothing queued.
  const ref = refIn(await (await req(w, { cookie: sU })).text(), "Frontend Engineering Intern");
  await req(w, { body: { t: sV, action: "code_send", ref, tag: tagOf(1) } });
  eq(w.outbox.filter((o) => o.user === V).length, 0, "no code is sent for a row that is not V's");
  // U's code typed into V's session, and V's (other session) code typed into U's: both refused.
  await req(w, { body: { t: sU, action: "code_send", ref, tag: tagOf(1) } });
  const uCode = codeIn(w.outbox.at(-1)!.text);
  const otherU = await w.A.tok(U, mine.listId, NOW); // a second session of U (another device): its own code only
  const t = plain(await (await req(w, { body: { t: otherU, action: "approve", ref, tag: tagOf(1), code: uCode } })).text());
  assert(/Get a code first/.test(t), `a code is bound to the session it was sent for: ${t}`);
  const tv = await req(w, { body: { t: sV, action: "approve", ref, tag: tagOf(1), code: uCode } });
  assert(!/Approved/.test(plain(await tv.text())));
  eq(w.queue.length, 0);
  // A forged link for U's list signed with another key opens nothing.
  const forged = (await mintFileToken({ secret: "another-secret-0123456789-abcdefgh", userId: U, list: mine.listId, now: NOW, kind: "l" }))!;
  eq((await req(w, { query: `t=${encodeURIComponent(forged)}` })).status, 403);
});
