// R10 fix 2 (spec E.10 2; E.1 3, 4, 11; E.2 19; B.6 continuation 2 turn 4): a correction repairs the current task. "That is
// the wrong role." acknowledges once and regenerates the data analyst draft (no batch, no re-asking the target); "I need remote
// only" after a Chicago shortlist removes the onsite roles from that same list instead of starting over or padding it.
// EXPECTED TO FAIL ON TRUNK (WO-A, WO-C). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-02-corrections.test.ts", CHAT = 7_910_201, CHAT_B = 7_910_202;
R.suite(FILE, [2], [CHAT, CHAT_B], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  await check(t, FILE, 2, "'That is the wrong role.' after a draft: acknowledged once, the data analyst draft regenerated, nothing applied", async (ev: any) => {
    await w.say(CHAT, T.SCENARIOS.resume[0].text);
    const r = await w.say(CHAT, "That is the wrong role.");
    ev.reply = r.reply;
    ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)) === "0", "a correction queues no application");
    ok(!/\bbatch\b|applications? ready for your yes|apply list/i.test(r.reply), `a correction is not an application batch: ${r.reply.slice(0, 300)}`);
    ok(/wrong role|used the wrong|my mistake|you're right/i.test(r.reply), `acknowledges the mismatch: ${r.reply.slice(0, 300)}`);
    ok(!/which role|what role|name the role/i.test(r.reply), "does not ask for a target it already has");
    const files = await deliveredFiles(w, CHAT, r, "wrong-role", ev);
    const pdf = files.find((f: any) => f.kind === "pdf");
    ok(pdf && pdf.pdf.pages === 1 && (/data analyst/i.test(pdf.pdf.text) || /data[_ -]?analyst/i.test(pdf.name)), "the regenerated one-page data analyst draft comes with the reply");
  }, w);
  const searcher = await w.observedPerson(CHAT_B);
  await check(t, FILE, 2, "'I need remote only.' after the Chicago shortlist: the onsite roles leave that list, remote-US stays the hard requirement, nothing padded", async (ev: any) => {
    await w.say(CHAT_B, T.SCENARIOS.search[0].text);
    const r = await w.say(CHAT_B, "I need remote only.");
    ev.reply = r.reply;
    ok(!/haven't started|runner|batch/i.test(r.reply), r.reply.slice(0, 300));
    // The S1 shortlist's onsite and hybrid roles (seeded open, so they were on it) must leave; a numbered or bulleted line counts.
    for (const c of ["Lakefront Transit Analytics", "Northline Health Data", "Prairie Ledger"]) ok(!new RegExp(`^\\s*(\\d+[.)]|[-*•])\\s.*${c}`, "m").test(r.reply), `${c} is onsite or hybrid: not offered as a remote match`);
    ok(/remote/i.test(r.reply) && /(removed?|drops?|no longer|takes? out|leaves?)/i.test(r.reply), `says which earlier options the change removed: ${r.reply.slice(0, 400)}`);
    ok(/remote[- ]US|remote in the US|US remote/i.test(r.reply), "keeps remote-US as the requirement");
    ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${searcher}'`)) === "0", "nothing queued");
  }, w);
});
