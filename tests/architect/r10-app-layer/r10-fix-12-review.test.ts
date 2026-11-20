// R10 fix 12 (spec E.10 12; E.3 25, 27-31, 35; C.11, C.21; B.3): application review is an exact, usable approval artifact.
// "Apply to the top three from that list" refers to the verified numbered shortlist (never the old ML list) and names the three.
// The review for a prepared application shows, per employer: the exact role, the application URL, the resume version by a
// human label, every answer that will be sent, and each unanswered required question as a narrow question; it says nothing is
// submitted; and its File page carries the same at 390 px. A wording approval approves no unknown fact and no submit.
// EXPECTED TO FAIL ON TRUNK (WO-G). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-12-review.test.ts", CHAT = 7_911_201;
const LAKE = T.MARKET[0];
const OUTSIDE = "Will you continue an outside business while employed?";
R.suite(FILE, [12], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  await w.say(CHAT, T.SCENARIOS.search[0].text);
  await check(t, FILE, 12, "'Apply to the top three from that list' names three roles of the verified shortlist, not the old list, and sends nothing", async (ev: any) => {
    const r = await w.say(CHAT, "Apply to the top three from that list.");
    ev.reply = r.reply;
    ok(!/reddit|Machine Learning|Northwind|Quanta|Vectorworks/i.test(r.reply), `the referent is the shortlist just shown: ${r.reply.slice(0, 300)}`);
    const named = T.MARKET.filter((m: any) => m.s1 && r.reply.includes(m.company));
    ok(named.length === 3, `names the three targets (${named.map((m: any) => m.company).join(", ")})`);
    ok((await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)) === "0", "nothing approved");
  }, w);
  const prep = await R.prepare(w, person, LAKE, [{ name: "first_name", label: "First name", value: "Jordan" }, { name: "last_name", label: "Last name", value: "Rivera" },
    { name: "why", label: "Why this role?", value: "I like work where data helps someone make a concrete decision." }], [OUTSIDE]);
  let shown: any = null;
  await check(t, FILE, 12, "the review shows employer, exact role, application URL, resume version, every answer, and the unanswered question as a question", async (ev: any) => {
    shown = await w.say(CHAT, "Show my applications.");
    ev.reply = shown.reply;
    ok(shown.reply.includes(LAKE.company) && shown.reply.includes(LAKE.title), `employer and exact role: ${shown.reply.slice(0, 400)}`);
    ok(shown.reply.includes(LAKE.url) || shown.buttons.some((b: any) => b.url === LAKE.url), "the application URL");
    ok(/resume[^\n]*(one-page|data analyst|version|draft)/i.test(shown.reply), "the resume version by a human label");
    for (const a of ["First name: Jordan", "Last name: Rivera", "Why this role?"]) ok(shown.reply.includes(a), `the exact answer "${a}"`);
    ok(shown.reply.includes("outside business") && /\?/.test(shown.reply), "the unanswered required question is asked, narrowly");
    ok(/not (sent|submitted)|nothing (is |was |has been )?(sent|submitted)/i.test(shown.reply), "says nothing is submitted");
  }, w);
  await check(t, FILE, 12, "the review's File page carries the same exact payload on a phone (390 px)", async (ev: any) => {
    ok(shown, "the review ran");
    const link = shown.links.find((l: string) => l.startsWith(R.FILE_BASE));
    ok(link, `the review links its File: ${JSON.stringify(shown.links)}`);
    const got = await w.open(link, CHAT);
    ok(got.status === 200 && got.html, "the review File opens");
    const r = await R.renderOpened(got, "f12-review");
    ev.screenshots.push(r.screenshot);
    ev.reply = r.text.slice(0, 600);
    for (const s of [LAKE.company, LAKE.title, "Jordan", "outside business"]) ok(r.text.includes(s), `the File shows "${s}"`);
    ok(/not submitted|nothing (is |has been )?submitted/i.test(r.text), "the File says not submitted");
    ok(r.scrollWidth <= r.innerWidth, "no sideways scroll");
  }, w);
  await check(t, FILE, 12, "'Use that.' for the wording approves no unknown fact and no submit", async (ev: any) => {
    const r = await w.say(CHAT, "Use that.");
    ev.reply = r.reply;
    ok((await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)) === "0", `a wording approval queued nothing to send: ${r.reply.slice(0, 300)}`);
    ok(/outside business/i.test(r.reply) && /(still|remain|unanswered|need)/i.test(r.reply), "the open required question is still named as open");
    ok(prep.hash, "the prepared payload exists");
  }, w);
});
