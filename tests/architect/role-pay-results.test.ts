// "I want X roles that pay $Y" (owner, 2026-11-01): the search's rows become a hosted results page (role_results.ts), drawn
// like every Trainee file (results_page.ts), with a black Apply on each card and Apply to selected (owner, 2026-11-02: no chat
// code; the Apply flows are in apply-page.test.ts). Memory stores and a fixed clock: no network, no model, no database. The
// handler-level proof is role-pay-results-handler.test.ts; the browser proof is role-pay-results-browser.test.ts.
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { MARKDOWN, parsePay, payGroup, payText, resultsParts, resultsReply } from "../../supabase/functions/_shared/role_pay.ts";
import { BASE, HASH, made, NOW, plain, post, prep, U, V, world, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const req = async (w: W, o: { cookie?: string; method?: string; query?: string; body?: Record<string, string | string[]>; ua?: string }) => {
  if (o.body) { const { t, pick, ...f } = o.body as Record<string, string>; return post(w, t, f, { pick: pick as unknown as string[] | undefined }); }
  return handleFile(new Request(`https://x.example/f${o.query ? `?${o.query}` : ""}`, { method: o.method ?? "GET", headers: { ...(o.cookie ? { cookie: `tf_s=${o.cookie}` } : {}), ...(o.ua ? { "user-agent": o.ua } : {}) } }), w.deps);
};
const tagOf = (n: number) => hashTag(HASH(n));
const refIn = (html: string, title: string, company?: string) => {
  const card = html.split('<li class="card" id="r-').slice(1).find((c) => c.includes(`<h3 class="title">${title}</h3>`) && (!company || c.includes(`<p class="co">${company}</p>`)));
  assert(card, `a card for ${title}`);
  return card!.slice(0, 12);
};

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
  eq(r, `I found 2 frontend internships that list pay of $30/hr or more, plus 1 that doesn't list pay, so I couldn't check it. Here they are by fit, with Apply on each.\n${url}`);
  const lines = r.split("\n");
  eq(lines.length, 2); eq(lines[1], url);
  assert(!MARKDOWN.test(r), "no markdown on a texting channel");
  assert((lines[0].match(/[.:](\s|$)/g) ?? []).length <= 2, "two sentences at most before the link");
  eq(resultsParts({ what, floor, meets: 2, unlisted: 1, url }), [lines[0], url], "on every channel the link is its own message");
  eq(resultsReply({ what, floor, meets: 0, unlisted: 3, url }).split("\n")[0], "I found 3 frontend internships, but none of them list pay, so I couldn't check them against $30/hr. Here they are by fit, with Apply on each.");
  eq(resultsReply({ what, floor, meets: 1, unlisted: 0, url }).split("\n")[0], "I found 1 frontend internship that lists pay of $30/hr or more. Here it is, with Apply on it.");
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
  eq((html.match(/<button type="submit" class="apply" aria-label="Apply to /g) ?? []).length, 3, "a black Apply on each card");
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

// ================================================================== GET never consumes or approves
Deno.test("GET-safety: link previews and any GET (with action words in the query, any agent, HEAD) approve nothing and use up nothing", async () => {
  const w = world();
  const r = await made(w);
  const link = new URL(r.url).searchParams.get("t")!;
  const s = await w.A.tok(U, r.listId, NOW);
  const ref = refIn(await (await req(w, { cookie: s })).text(), "Frontend Engineering Intern");
  const q = `action=apply&ref=${ref}&tag=${tagOf(1)}&t=${encodeURIComponent(s)}`;
  for (const ua of ["facebookexternalhit/1.1 Facebot Twitterbot/1.0", "WhatsApp/2.23", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (iPhone) AppleWebKit Safari", "curl/8"]) {
    for (const method of ["GET", "HEAD"]) {
      await req(w, { method, query: `t=${encodeURIComponent(link)}`, ua });
      await req(w, { method, query: q, ua, cookie: s });
      await req(w, { method, query: q.replace("apply", "applysel"), ua, cookie: s });
      // The signed-in browser's own cookie, the action words in the query and no t= at all (a prefetch of a crafted URL).
      const bare = q.replace(/&t=[^&]*/, "");
      for (const a of ["apply", "applysel", "answer", "approve", "applyall"]) await req(w, { method, query: bare.replace("apply", a) + `&pick=${ref}:${tagOf(1)}`, ua, cookie: s });
    }
  }
  eq(w.queue.length, 0, "no GET approved anything");
  eq(w.wants.length, 0, "no GET queued anything");
  for (const l of w.A.logins.values()) eq(l.done_at, null, "no GET used up the link");
  // Nothing was spent: the tap on the page still works, once.
  assert(/Approved\./.test(plain(await (await req(w, { body: { t: s, action: "apply", ref, tag: tagOf(1) } })).text())));
  eq(w.queue.length, 1);
});

// ================================================================== another person's link
Deno.test("cross-person: another account's link or session opens, shows and approves nothing", async () => {
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
  // V posting U's row and tag: V's list has no such row; nothing queued.
  const ref = refIn(await (await req(w, { cookie: sU })).text(), "Frontend Engineering Intern");
  const tv = await req(w, { body: { t: sV, action: "apply", ref, tag: tagOf(1) } });
  assert(!/Approved/.test(plain(await tv.text())));
  eq(w.queue.length, 0);
  // A forged link for U's list signed with another key opens nothing.
  const forged = (await mintFileToken({ secret: "another-secret-0123456789-abcdefgh", userId: U, list: mine.listId, now: NOW, kind: "l" }))!;
  eq((await req(w, { query: `t=${encodeURIComponent(forged)}` })).status, 403);
});
