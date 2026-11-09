// R10 fix 14 (spec E.10 14; E.5 42-49; E.4 41; B.5; B.6 continuations 4 and 5): research and follow-up drafts are concrete and
// sourced. The world serves the scripted source double (helpers/r10_sources.ts: fictional, dated pages about a Stripe-like company
// at fixed URLs; every request recorded), so the owner's research question and its correction (spec F.2) must get the real
// research answer: checked sources with links (fetched on that turn), labelled interpretation, five grounded questions, the
// unknowns named, and no figure that is not on a fetched page; the brief opens on a phone when it is a File. The refused-host
// case (a named, evidenced blocker) is r10-post-reset-replay. Drafts never turn a company into a guessed address and invent no
// meeting, referral or history.
// EXPECTED TO FAIL ON TRUNK (WO-H). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-14-research.test.ts", CHAT = 7_911_401;
const S = await import(`${helper}r10_sources.ts`);
const [F2a, F2b] = T.SCENARIOS_F.research;
// The research answer, judged on what was fetched (spec E.5 42-49, F.2 acceptance). Text = the reply plus any File it links.
async function sourcedResearch(w: any, r: any, label: string, ev: any) {
  let text = r.reply;
  for (const l of r.links.filter((x: string) => x.startsWith(R.FILE_BASE))) {
    const got = await w.open(l, CHAT);
    ok(got.status === 200 && got.html, `${label}: the brief File opens (HTTP ${got.status})`);
    const shot = await R.renderOpened(got, `f14-${label}`);
    ev.screenshots.push(shot.screenshot);
    ok(shot.scrollWidth <= shot.innerWidth, `${label}: the brief fits a phone (390 px)`);
    text += `\n${shot.text}`;
  }
  const cited = S.STRIPE_SOURCES.filter((p: any) => text.includes(p.url) || r.links.includes(p.url) || r.buttons.some((b: any) => b.url === p.url));
  ok(cited.length >= 2, `${label}: at least two sources cited by link (${cited.map((p: any) => p.url).join(", ") || "none"}): ${r.reply.slice(0, 300)}`);
  for (const p of cited) ok(r.sourceChecks.includes(p.url), `${label}: ${p.url} is cited and was fetched on this turn`);
  ok(/interpret|my read|in my view|this suggests/i.test(text) && /fact|reported|announced|says/i.test(text), `${label}: facts and labelled interpretation are kept apart`);
  const questions = text.split("\n").filter((l: string) => /\?\s*$/.test(l.trim()) && l.trim().length > 20);
  ok(questions.length >= 5, `${label}: five interview questions (${questions.length})`);
  ok(/unknown|not (verified|confirmed|stated)|couldn't (confirm|verify)|open question|did not comment/i.test(text), `${label}: the unknowns are named`);
  const served = S.STRIPE_SOURCES.map((p: any) => p.body).join(" ");
  for (const n of [...new Set([...text.matchAll(/\$\s?[\d.,]+\s?(?:billion|million|trillion)?|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?%/g)].map((m) => m[0].trim()))]) ok(served.includes(n.replace(/^\$\s?/, "")), `${label}: the figure "${n}" is on a fetched page`);
  if (/Ledger Insights/.test(text)) ok(/2026-10-02|October 2, 2026|Oct\.? 2, 2026/.test(text), `${label}: the development carries its date`);
  ok(!/BRAIN.STUB|MODEL.STUB|SCRIPTED.BRAIN/.test(text), `${label}: the product's answer, not a stub's`);
}
R.suite(FILE, [14], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  const sideEffects = async () => Number(await w.sql(`select (select count(*) from public.career_apply_wanted where user_id = '${person}') + (select count(*) from public.career_outreach_drafts where user_id = '${person}') + (select count(*) from public.career_send_queue where user_id = '${person}')`));
  await check(t, FILE, 14, "F2a with sources reachable: the research answer (sources fetched and linked, interpretation labelled, five questions, unknowns, figures from the pages)", async (ev: any) => {
    const r = await w.say(CHAT, F2a.text);
    ev.reply = r.reply;
    await sourcedResearch(w, r, "F2a", ev);
    ok((await sideEffects()) === 0, "no application, people list or outreach");
  }, w);
  await check(t, FILE, 14, "E.5 47: the paywalled and the stale source are marked beside the claims that rest on them", async (ev: any) => {
    const r = await w.say(CHAT, "What has changed at Stripe recently, and is any of it older news? Include anything you could only partly read.");
    ev.reply = r.reply;
    const paywalled = S.STRIPE_SOURCES.find((p: any) => p.kind === "paywalled")!, stale = S.STRIPE_SOURCES.find((p: any) => p.kind === "stale")!;
    const near = (needle: RegExp, marker: RegExp) => { const i = r.reply.search(needle); return i >= 0 && marker.test(r.reply.slice(Math.max(0, i - 250), i + 250)); };
    ok(r.sourceChecks.includes(paywalled.url) && r.sourceChecks.includes(stale.url), `both listed sources were opened this turn (opened: ${JSON.stringify(r.sourceChecks)})`);
    ok(/reorgani[sz]/i.test(r.reply), `the paywalled item is reported (its headline is all that could be read): ${r.reply.slice(0, 300)}`);
    ok(near(/reorgani[sz]/i, /paywall|subscri|couldn't read|could not read|only the headline|not (able|accessible)/i), "the paywalled claim is marked beside it as unread past the headline");
    ok(!/reorgani[sz]\w* (?:its )?analytics team (?:into|by|because|to)\b/i.test(r.reply), "nothing beyond the headline is claimed about the paywalled story");
    ok(/Atlas Express/.test(r.reply) && near(/Atlas Express/, /2023|older|out of date|stale|not recent/i), "the stale item carries its 2023 date or an older-news label beside it");
    ok(!/BRAIN.STUB|MODEL.STUB|SCRIPTED.BRAIN/.test(r.reply), "the product's answer, not a stub's");
  }, w);
  await check(t, FILE, 14, "F2b (the correction) with sources reachable: the same research answer in chat, no batch, no people list", async (ev: any) => {
    const r = await w.say(CHAT, F2b.text);
    ev.reply = r.reply;
    ok(!/batch|analysts at Stripe|LinkedIn export/i.test(r.reply), "not an application batch or a people list");
    await sourcedResearch(w, r, "F2b", ev);
    ok((await sideEffects()) === 0, "no application, people list or outreach");
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
}, undefined, { sources: true });
