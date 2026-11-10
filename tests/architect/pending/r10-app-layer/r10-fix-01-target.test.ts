// R10 fix 1 (spec E.10 1; E.1 1, 11, 12; B.6 continuation 1): the requested target is kept through the whole task. After the
// data analyst internship draft, three follow-ups (a one-page data-analyst emphasis, a shorter first bullet, "give me the PDF")
// each stay on that target: every file delivered is one page, aimed at data analyst internships, never at a role of the old
// list. EXPECTED TO FAIL ON TRUNK (WO-A). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-01-target.test.ts", CHAT = 7_910_101;
R.suite(FILE, [1], [CHAT], async (t: Deno.TestContext, w: any) => {
  await w.observedPerson(CHAT);
  const onTarget = async (said: any, label: string, ev: any) => {
    ev.reply = said.reply;
    ok(!/Machine Learning|reddit|Ads Conversion/i.test(said.reply), `${label}: the reply is not about the old list's role: ${said.reply.slice(0, 300)}`);
    const files = await deliveredFiles(w, CHAT, said, label, ev);
    const pdf = files.find((f: any) => f.kind === "pdf");
    ok(pdf, `${label}: a PDF came with the reply (docs ${said.docs.length}, links ${said.links.length}): ${said.reply.slice(0, 300)}`);
    ok(pdf.pdf.pages === 1, `${label}: one page (${pdf.pdf.pages})`);
    ok(/data analyst/i.test(pdf.pdf.text) || /data[_ -]?analyst/i.test(pdf.name), `${label}: the file is aimed at data analyst internships`);
    ok(!/Machine Learning Engineering Manager|reddit/i.test(pdf.pdf.text), `${label}: the file is not aimed at the Reddit role`);
    return pdf;
  };
  await check(t, FILE, 1, "the first draft names the data analyst internship target", async (ev: any) => {
    await onTarget(await w.say(CHAT, T.SCENARIOS.resume[0].text), "T1", ev);
  }, w);
  await check(t, FILE, 1, "'Make it more like a data analyst resume. Keep it one page.' keeps the target and the page", async (ev: any) => {
    await onTarget(await w.say(CHAT, "Make it more like a data analyst resume. Keep it one page."), "C1", ev);
  }, w);
  await check(t, FILE, 1, "'Can you make the first bullet less wordy?' proposes the changed bullet beside the old one, on the same target", async (ev: any) => {
    const r = await w.say(CHAT, "Can you make the first bullet less wordy?");
    ev.reply = r.reply;
    ok(/100\+/.test(r.reply), `the proposed bullet keeps the supplied scale (100+): ${r.reply.slice(0, 400)}`);
    // Old beside new: labelled ("Before:" / "Previous:" / "Old:" / "Was:"), or from "<old, quoted>" to "<new>", or the old
    // bullet itself verbatim beside the new; "before you apply" or "from the long version to a short one" is not it.
    const OLD_BULLET = "Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets";
    ok(/\b(before|previous|old|original|was)\s*:/i.test(r.reply) || /\bfrom\s+["“'][^"”']{8,}["”']\s+to\s+["“']/i.test(r.reply) || r.reply.includes(OLD_BULLET), `the change is shown old beside new: ${r.reply.slice(0, 400)}`);
    ok(!/Machine Learning|reddit/i.test(r.reply), "still the data analyst target");
  }, w);
  await check(t, FILE, 1, "'That is fine, give me the PDF.' delivers the revised one-page PDF on the same target", async (ev: any) => {
    const pdf = await onTarget(await w.say(CHAT, "That is fine, give me the PDF."), "C4", ev);
    ok(/100\+/.test(pdf.pdf.text), "the revised file carries the approved bullet's supplied scale");
  }, w);
});
