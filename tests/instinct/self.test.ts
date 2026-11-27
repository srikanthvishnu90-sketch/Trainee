// The harness checks itself before it judges the product: the judge flags what it must flag (and only that), a step is
// never silently skipped, the fakes record exactly what they received and refuse like the real services, and the employer
// pages count POSTs and hold a bot wall. No Postgres, no browser.
//   deno test -A --no-check --import-map=tests/instinct/import-map.json tests/instinct/self.test.ts
import assertNode from "node:assert/strict";
import { check, jargonIn, mentions, notBuilt, plainWords, Scorecard } from "./judge.ts";
import { fakeGoogle, fakeProvider, readHit } from "./fakes.ts";
import { employers, market } from "./employers.ts";
import { resumePdf } from "./people.ts";

Deno.test("plain words: internal codes are caught; links and ordinary numbers are not", () => {
  assertNode.deepEqual(jargonIn("Your application is submitted_unconfirmed (NOT_WIRED) id 3f0c2a1e-1111-4222-8333-944445555666"),
    ["NOT_WIRED", "submitted_unconfirmed", "3f0c2a1e-1111-4222-8333-944445555666"]);
  assertNode.deepEqual(jargonIn("Sent 30 of 30. Apply at https://jobs.ashbyhq.com/acme/3f0c2a1e-1111-4222-8333-944445555666 by May 2026."), []);
  assertNode.ok(jargonIn("the host record write is not confirmed").length > 0);
  assertNode.throws(() => plainWords([{ said: "x", text: "state: needs_user" }]));
  assertNode.ok(mentions("60 approved exactly as shown", 60) && !mentions("600 approved", 60));
});

Deno.test("a step is PASS, FAIL or NOT_BUILT with its evidence, and a blocked scenario records every later step as not reached", async () => {
  const card = new Scorecard();
  const run = card.scenario("apply", "self", "web");
  await run.step("passes", async () => "ok evidence");
  await run.step("fails", async () => check(false, "the state said no", "the fix"));
  await run.step("not built", async () => notBuilt("no table", "a table"));
  await run.step("throws", async () => { throw new Error("boom"); });
  run.block("no account");
  let ran = false;
  await run.step("after the block", async () => { ran = true; });
  assertNode.equal(ran, false);
  assertNode.deepEqual(card.cards[0].steps.map((s) => s.status), ["PASS", "FAIL", "NOT_BUILT", "FAIL", "FAIL"]);
  assertNode.equal(card.cards[0].steps[1].needs, "the fix");
  assertNode.match(card.cards[0].steps[4].evidence, /not reached: no account/);
  assertNode.match(card.markdown(), /\| apply \/ web \| 1 \| 3 \| 1 \|/);
});

Deno.test("fake Google: consent, token exchange, one send recorded exactly, a send past the account's limit refused with 429", async () => {
  const g = fakeGoogle();
  const back = new URL(g.consent("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Fsupabase.test%2Ffunctions%2Fv1%2Fgmail-oauth&state=S&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send", "a@gmail.example"));
  assertNode.equal(back.searchParams.get("state"), "S");
  const call = async (req: Request) => { const h = await readHit(req); g.log.push(h); return await g.handle(req, h); };
  const tok = await (await call(new Request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")! }) }))).json();
  assertNode.ok(tok.access_token && tok.refresh_token);
  const raw = btoa("To: x@firm.example\r\nSubject: Hi\r\n\r\nHello there").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const send = () => call(new Request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ raw }) }));
  assertNode.equal((await send()).status, 200);
  assertNode.deepEqual([g.sent.length, g.sent[0].account, g.sent[0].to, g.sent[0].subject, g.sent[0].text], [1, "a@gmail.example", "x@firm.example", "Hi", "Hello there"]);
  g.sendLimit.set("a@gmail.example", 1);
  assertNode.equal((await send()).status, 429);
  assertNode.equal(g.sent.length, 1);
});

Deno.test("fake provider: refuses without the key; answers a domain search with verification", async () => {
  const p = fakeProvider("KEY-fake");
  p.directory.set("acme.example", [{ first: "A", last: "B", email: "a.b@acme.example", position: "Engineer", domain: "acme.example", company: "Acme", verified: true, confidence: 95 }]);
  const ask = async (key: string) => { const req = new Request(`https://api.hunter.io/v2/domain-search?domain=acme.example&api_key=${key}`); const h = await readHit(req); return await p.handle(req, h); };
  assertNode.equal((await ask("wrong")).status, 401);
  const ok = await (await ask("KEY-fake")).json();
  assertNode.equal(ok.data.emails[0].verification.status, "valid");
});

Deno.test("employer pages: each POST is recorded with its fields and resume hash; a walled posting takes no POST", async () => {
  const ps = market(2, { tag: "self" });
  const site = employers(ps);
  try {
    const page = await (await fetch(site.pageFor(ps[0].key)!)).text();
    assertNode.match(page, /Submit Application/);
    const form = new FormData();
    form.set("job_application[email]", "p@example.test");
    form.set("job_application[resume]", new File([resumePdf("TEST")], "r.pdf"));
    assertNode.equal((await fetch(`${site.pageFor(ps[0].key)}/submit`, { method: "POST", body: form })).status, 200);
    assertNode.equal(site.postsTo(ps[0].key).length, 1);
    assertNode.match(site.postsTo(ps[0].key)[0].resumeSha ?? "", /^[0-9a-f]{64}$/);
    ps[1].captcha = "always";
    assertNode.match(await (await fetch(site.pageFor(ps[1].key)!)).text(), /Verify you are human/);
    assertNode.equal((await fetch(`${site.pageFor(ps[1].key)}/submit`, { method: "POST", body: new FormData() })).status, 403);
    assertNode.equal(site.postsTo(ps[1].key).length, 0);
    assertNode.equal(site.postingFor(site.pageFor(ps[0].key)!)?.key, ps[0].key);
  } finally {
    await site.close();
  }
});
