// R10 fix 6 (spec E.10 6; E.2 14, 21, 22, 24; E.8 68; B.6 continuation 2 turn 6): openings are verified and fit is kept
// apart from eligibility. A role whose employer page is gone is not offered as open; a page that refused the check is a
// limited check, never "verified"; "why not that one?" gives the sourced constraint; an unknown graduation date keeps a
// posting's window from being called met, while the skill fit is still said.
// EXPECTED TO FAIL ON TRUNK (WO-C). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-06-verify.test.ts", CHAT = 7_910_601;
const closed = T.MARKET.find((m: any) => m.page === "closed")!, blocked = T.MARKET.find((m: any) => m.page === "blocked")!, remote = T.MARKET.find((m: any) => /Remote/.test(m.location))!;
R.suite(FILE, [6], [CHAT], async (t: Deno.TestContext, w: any) => {
  await w.observedPerson(CHAT);
  let s2 = "";
  await check(t, FILE, 6, "every listed role's employer page was opened during the search; a gone page is not listed as open", async (ev: any) => {
    await w.say(CHAT, T.SCENARIOS.search[0].text);
    const r = await w.say(CHAT, T.SCENARIOS.search[1].text);
    ev.reply = s2 = r.reply;
    const listed = T.MARKET.filter((m: any) => new RegExp(`^\\s*\\d+[.)].*${m.company}`, "m").test(r.reply));
    ok(listed.length >= 3, `a shortlist: ${r.reply.slice(0, 400)}`);
    for (const m of listed) ok(w.pageChecks.includes(m.url), `${m.company}: its page was opened before it was listed (${m.url})`);
    ok(!listed.some((m: any) => m === closed), `${closed.company}'s page is gone; it is not listed as open`);
  }, w);
  await check(t, FILE, 6, "a page that refused the check is a limited check, not verified", async (ev: any) => {
    ev.reply = s2;
    const i = s2.indexOf(blocked.company);
    ok(i >= 0, `${blocked.company} matches the widened ask and is reported (limited), not silently dropped or verified: ${s2.slice(0, 400)}`);
    ok(/couldn't (open|check|verify)|limited|not verified|blocked/i.test(s2.slice(i, i + 400)), `${blocked.company} is marked as a limited check: ${s2.slice(i, i + 300)}`);
  }, w);
  await check(t, FILE, 6, "'Why not the Example Carbon one?' gives the observed constraint (its page is gone)", async (ev: any) => {
    const r = await w.say(CHAT, "Why not the Example Carbon Co one?");
    ev.reply = r.reply;
    ok(/no longer (available|open|posted)|page (is )?(gone|removed|closed)|closed/i.test(r.reply), `the sourced reason: ${r.reply.slice(0, 300)}`);
  }, w);
  await check(t, FILE, 6, "'Am I eligible for the Harborview one?': the posting's window and the unknown graduation date, apart from the skill fit", async (ev: any) => {
    const r = await w.say(CHAT, `Am I eligible for the ${remote.company} one?`);
    ev.reply = r.reply;
    ok(/December 2027/.test(r.reply) && /June 2028/.test(r.reply), `quotes the posting's window: ${r.reply.slice(0, 400)}`);
    ok(/graduation date/i.test(r.reply) && /(not (on file|confirmed|stated)|don't have|haven't told)/i.test(r.reply), "names the unknown graduation date");
    ok(!/\byou (are|'re) eligible\b|\bexcellent fit\b/i.test(r.reply), "does not call it eligible or an excellent fit while the window is unmet-unknown");
    ok(/SQL|Python/.test(r.reply), "the fit (supplied skills against the posting) is said separately");
  }, w);
});
