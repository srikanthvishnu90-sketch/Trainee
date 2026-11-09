// R10 fix 8 (spec E.10 8; E.6 52-54; E.3 26; A.5 rubric): replies are useful, direct and evidence-based. A short question gets
// a short plain answer ("Did you apply anywhere?" -> no, zero, said as zero); a blocker reply says what is done, what remains
// and the one decision needed; no internal process words anywhere in the scenario.
// EXPECTED TO FAIL ON TRUNK (WO-A). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-08-replies.test.ts", CHAT = 7_910_801;
R.suite(FILE, [8], [CHAT], async (t: Deno.TestContext, w: any) => {
  await w.observedPerson(CHAT);
  const all: string[] = [];
  await check(t, FILE, 8, "'Did you apply anywhere?' after a search: a short, plain zero", async (ev: any) => {
    all.push((await w.say(CHAT, T.SCENARIOS.search[0].text)).reply);
    const r = await w.say(CHAT, "Did you apply anywhere?");
    ev.reply = r.reply;
    all.push(r.reply);
    const first = r.reply.split(/(?<=[.!?])\s+/)[0] ?? "";
    // The first sentence answers with application wording ("No, I haven't applied anywhere", "No applications yet"); "Nothing
    // was..." or "the list is empty" alone does not say what was asked.
    ok(/\b(no|not|haven't|have not|zero|0|none)\b/i.test(first) && /\bappl(y|ied|ying|ications?)\b/i.test(first), `answers the question in its first sentence: ${first.slice(0, 200)}`);
    ok(r.reply.length <= 400, `short (${r.reply.length} chars)`);
    ok(!/\b(submitted|applied)\b(?! anywhere| to anything| yet)/i.test(r.reply.replace(/haven't applied|have not applied|nothing (was )?submitted/gi, "")), "claims no submission");
  }, w);
  await check(t, FILE, 8, "a blocker reply says what is done, what remains, and the one decision needed", async (ev: any) => {
    const r = await w.say(CHAT, "Apply to the first one.");
    ev.reply = r.reply;
    all.push(r.reply);
    const sentences = r.reply.trim().split(/(?<=[.!?])\s+/).filter((x: string) => x.trim());
    const last = sentences.at(-1) ?? "";
    ok(/\?\s*$/.test(last) || /^(reply|say|tap|choose|pick)\b/i.test(last), `ends at the decision: the last sentence is the question or choice: "${last.slice(0, 200)}"`);
    ok(/(not (sent|submitted)|nothing (is |was )?(sent|submitted))/i.test(r.reply), "says what has not happened");
    ok(/\b(email( address)?|phone( number)?|contact details|GPA|graduation date|work authori[sz]ation)\b|review (the|this|your) (application|answers|exact)/i.test(r.reply), `names the concrete element that remains (an open fact by name, or the payload review): ${r.reply.slice(0, 400)}`);
  }, w);
  await check(t, FILE, 8, "no internal process language and no repeated sentence anywhere in the scenario", async (ev: any) => {
    ev.reply = all.join("\n---\n");
    for (const r of all) { ok(internalHits(r).length === 0, `internal language (${internalHits(r).join(", ")}): ${r.slice(0, 300)}`); ok(repeated(r).length === 0, `repeats: ${repeated(r).join(" | ")}`); }
  }, w);
});
