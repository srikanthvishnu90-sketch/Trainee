// R10 fix 14 (spec E.10 14; E.5 42-49; E.4 41; B.5; B.6 continuations 4 and 5): research and follow-up drafts are concrete and
// sourced. In this suite no source on the web can be opened, so a brief must say which claims it could not check and state no
// unsourced company fact or metric; a research brief File, when made, keeps a source beside each claim, dates on developments,
// and opens on a phone. Drafts never turn a company into a guessed address and invent no meeting, referral or history.
// EXPECTED TO FAIL ON TRUNK (WO-H). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-14-research.test.ts", CHAT = 7_911_401;
R.suite(FILE, [14], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  await check(t, FILE, 14, "a research ask with no reachable sources: asks the role or says what could not be checked; no unsourced fact or metric", async (ev: any) => {
    const r = await w.say(CHAT, "Research Stripe before my interview. I want the company, business model, recent developments and what I should ask.");
    ev.reply = r.reply;
    ok(!/BRAIN.STUB|MODEL.STUB/.test(r.reply), `the answer is the product's, not the fake model's: ${r.reply.slice(0, 200)}`);
    ok(!/\$\s?\d|\d+(\.\d+)?\s?(%|percent|billion|trillion|million)/i.test(r.reply), "no metric without an inspected source");
    ok(/what role|which (role|team)|couldn't (open|reach|check)|could not (open|reach|check)|not (able|yet able) to (open|check)|unverified/i.test(r.reply), `asks the one question that changes the brief, or names what it could not check: ${r.reply.slice(0, 300)}`);
  }, w);
  await check(t, FILE, 14, "a research brief File, when linked, keeps sources beside claims, dates on developments, and fits a phone", async (ev: any) => {
    const r = await w.say(CHAT, "Data analyst internship.");
    ev.reply = r.reply;
    const link = r.links.find((l: string) => l.startsWith(R.FILE_BASE));
    ok(link || /couldn't|could not|unverified|not (able|checked)/i.test(r.reply), `a brief File, or the honest reason there is none: ${r.reply.slice(0, 300)}`);
    if (link) {
      const got = await w.open(link, CHAT);
      const shot = await R.renderOpened(got, "f14-brief");
      ev.screenshots.push(shot.screenshot);
      ok(shot.scrollWidth <= shot.innerWidth, "fits a phone");
      ok(/source|inaccessible|not checked/i.test(shot.text), "sources or their limits are shown beside the claims");
    }
    ok(!/BRAIN.STUB|MODEL.STUB/.test(r.reply), "not the fake model's words");
  }, w);
  await check(t, FILE, 14, "'Now send it to Maya' with no Maya on file: asks which Maya and where; drafts nothing to a guessed address", async (ev: any) => {
    const a = await w.say(CHAT, "Now send it to Maya.");
    const b = await w.say(CHAT, "Maya at the company.");
    ev.reply = `${a.reply}\n---\n${b.reply}`;
    ok(/which Maya|who is Maya|where should|her (email|address)|exact recipient/i.test(a.reply), `asks which Maya and where: ${a.reply.slice(0, 200)}`);
    ok(!/@/.test(b.reply) || /\?/.test(b.reply), "a company name is not turned into a guessed email");
    const drafts = await w.json(`select recipient_email from public.career_outreach_drafts where user_id = '${person}'`);
    ok(drafts.every((d: any) => !d.recipient_email), `no draft to a guessed address: ${JSON.stringify(drafts)}`);
  }, w);
  await check(t, FILE, 14, "'What would you say?' gives a short draft with no invented meeting, referral or relationship", async (ev: any) => {
    const r = await w.say(CHAT, "What would you say?");
    ev.reply = r.reply;
    ok(/Maya/.test(r.reply) && /resume/i.test(r.reply), `a draft to Maya about the resume: ${r.reply.slice(0, 300)}`);
    ok(!/we met|great (meeting|chatting)|as (we )?discussed|referred me|you mentioned|following up on our|last week/i.test(r.reply), "invents no prior history");
    ok(!/BRAIN.STUB|MODEL.STUB/.test(r.reply), "not the fake model's words");
    ok((await w.sql(`select count(*) from public.career_send_queue where user_id = '${person}'`)) === "0", "nothing sent");
  }, w);
});
