// R10 fix 5 (spec E.10 5; E.2 16-20, 23): job searches turn into usable results. An empty result explains the scope checked,
// why nothing verified and the nearest useful variation (never "Nothing was invented to fill the list" alone, never "no
// internships anywhere"); a numbered shortlist keeps its numbers in later replies.
// EXPECTED TO FAIL ON TRUNK (WO-C). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-05-search.test.ts", CHAT = 7_910_501;
R.suite(FILE, [5], [CHAT], async (t: Deno.TestContext, w: any) => {
  await w.observedPerson(CHAT);
  await check(t, FILE, 5, "an empty search names the scope checked, why nothing verified, and the nearest variation", async (ev: any) => {
    const r = await w.say(CHAT, "Find me 5 data analyst internships in Boise that are actually open. Don't apply yet.");
    ev.reply = r.reply;
    ok(!/^\s*Nothing was invented to fill the list/im.test(r.reply) && !/no internships (anywhere|at all)/i.test(r.reply), `not a bare empty answer: ${r.reply.slice(0, 300)}`);
    ok(/Boise/.test(r.reply) && /data analyst/i.test(r.reply), "names the role and place it checked");
    ok(/(found|checked|searched) \d+|no (open )?(data analyst )?internships? (posted |listed )?in Boise/i.test(r.reply), "says what was checked and what was found");
    ok(/remote|Chicago|nearby|wider|business analyst|analytics/i.test(r.reply), "offers the most promising nearby variation");
    ok(!/\bsearch query\b|let s leave|don t yet/i.test(r.reply), `does not echo the parsed words back: ${r.reply.slice(0, 200)}`);
  }, w);
  let first = "";
  await check(t, FILE, 5, "a shortlist's numbers stay attached to their jobs: 'tell me more about 2' is the second job listed", async (ev: any) => {
    const s1 = await w.say(CHAT, T.SCENARIOS.search[0].text);
    const line2 = s1.reply.split("\n").find((l: string) => /^\s*2[.)]\s/.test(l)) ?? "";
    const company = T.MARKET.find((m: any) => line2.includes(m.company))?.company;
    ok(company, `the shortlist has a numbered second job: ${s1.reply.slice(0, 400)}`);
    const more = await w.say(CHAT, "Tell me more about 2.");
    ev.reply = more.reply;
    ok(more.reply.includes(company!), `"2" is ${company}: ${more.reply.slice(0, 300)}`);
    first = s1.reply;
  }, w);
  await check(t, FILE, 5, "the result sentence's counts are the listed results' counts", async (ev: any) => {
    ev.reply = first;
    const n = first.split("\n").filter((l: string) => /^\s*\d+[.)]\s/.test(l)).length;
    ok(n >= 1, "a numbered shortlist");
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    // A count sentence of its own ("3 roles", "three open"), not the list's own "1." and "2." markers.
    const prose = first.split("\n").filter((l: string) => !/^\s*(\d+[.)]|[-*•])\s/.test(l)).join(" ");
    ok(new RegExp(`\\b(${n}|${words[n]})\\b(?:\\s+[\\w-]+){0,3}?\\s+(roles?|open|internships?|postings?|jobs?|results?|matches)\\b`, "i").test(prose), `a sentence outside the list counts ${n} roles: ${prose.slice(0, 200)}`);
  }, w);
});
