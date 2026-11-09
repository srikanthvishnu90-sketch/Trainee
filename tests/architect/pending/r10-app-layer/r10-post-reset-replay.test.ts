// R10 spec F (owner's post-reset audit, 2026-11-08 6:02-6:07 pm CST, production 7d2e8ee1): the five post-reset user turns,
// replayed exactly with that audit's context: the intake read but NOT confirmed ("its entries are waiting for your word").
// HISTORICAL BASELINE: its records carry scenario "post-reset" so the report keeps it apart from post-fix acceptance.
//   F.1 search, twice: checked open postings with links, or one named, evidenced blocker; never the resume-confirmation tail
//       or an eligibility lecture (listing needs neither a confirmed resume nor a verdict).
//   F.2 Stripe research and its correction: research or a named blocker; never applications, introductions or outreach.
//   F.3 the stop turn: what the reply claims is read back from the authoritative control state (career_user_quiet: the
//       career:account paused flag and contact opt-outs, WO-091c; WO-K's documented contract replaces this when it lands) and
//       the send tables; no promise of a reconciliation nothing schedules; nothing sent, nothing resumed.
// EXPECTED TO FAIL ON TRUNK (WO-A, WO-C, WO-H, WO-K). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, internalHits } = R;
const FILE = "r10-post-reset-replay.test.ts", CHAT = 7_912_001;
const [F1a, F1b] = T.SCENARIOS_F.search, [F2a, F2b, F3] = T.SCENARIOS_F.research;
R.suite(FILE, [1, 2, 5, 8, 14, 15], [CHAT], async (t: Deno.TestContext, w: any) => {
  await w.say(CHAT, "hi");
  await w.upload(CHAT, "Jordan_Rivera_Resume.pdf", R.pdfOf(T.INTAKE_RESUME), "here is my resume");
  const person = await w.personOf(CHAT);
  ok((await w.sql(`select public.career_resume_on_file('${person}')`)) === "f", "context: the intake is read, not confirmed");
  const notObserved = (id: string, reply: string) => { for (const r of T.OBSERVED_FAILURES[id]) ok(!r.test(reply), `${id}: the post-reset failure again (${r.source}): ${reply.slice(0, 400)}`); };
  const sideEffects = async () => ({
    wanted: Number(await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)),
    jobs: Number(await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)),
    drafts: Number(await w.sql(`select count(*) from public.career_outreach_drafts where user_id = '${person}'`)),
    sends: Number(await w.sql(`select count(*) from public.career_send_queue where user_id = '${person}'`)),
  });
  const passed: boolean[] = [];
  const c = async (item: number, name: string, fn: (ev: any) => Promise<void>) => { const r = await check(t, FILE, item, `[post-reset baseline] ${name}`, async (ev: any) => { ev.scenario = "post-reset"; await fn(ev); }, w); passed.push(r); return r; };
  const shortlistOrBlocker = (reply: string) => {
    const listed = T.MARKET.filter((m: any) => m.s2 && new RegExp(`^\\s*\\d+[.)].*${m.company}`, "m").test(reply));
    const blocker = /no open (roles|postings) (were )?found in|search connection|couldn't reach the (job )?board|(checked|searched) \d+/i.test(reply);
    return { listed, blocker };
  };
  await c(5, "F1a: checked open postings with links, or one named blocker; no resume-confirmation tail on a search", async (ev) => {
    const r = await w.say(CHAT, F1a.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F1a", r.reply);
    const { listed, blocker } = shortlistOrBlocker(r.reply);
    ok(listed.length >= 3 || blocker, `three verified listings or a named blocker: ${r.reply.slice(0, 400)}`);
    for (const m of listed) ok(r.reply.includes(m.url) || r.buttons.some((b: any) => b.url === m.url), `${m.company}: its link`);
    ok(!/confirm(ed)? (your )?resume|yes, that's my resume/i.test(r.reply), "listing does not wait on the resume");
    ok((await sideEffects()).wanted === 0, "nothing queued");
  });
  await c(2, "F1b: names which blocker (none found / connection / something else) or shows the postings; no eligibility lecture", async (ev) => {
    const r = await w.say(CHAT, F1b.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F1b", r.reply);
    const { listed, blocker } = shortlistOrBlocker(r.reply);
    ok(listed.length >= 1 || blocker, `the question is answered: the postings, or which blocker: ${r.reply.slice(0, 400)}`);
    ok(!/your resume (is|isn't) (the|what's) blocking|need(s)? (your|a) confirmed resume/i.test(r.reply), "an unconfirmed resume is not named as the search blocker");
    ok((await w.sql(`select public.career_resume_on_file('${person}')`)) === "f", "the resume was not confirmed for the person");
  });
  await c(14, "F2a: Stripe research, or its specific blocker; never an application batch or a role search", async (ev) => {
    const r = await w.say(CHAT, F2a.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F2a", r.reply);
    ok(/Stripe/.test(r.reply), "about Stripe");
    ok(/source|couldn't (open|reach|check)|could not (open|reach|check)|blocker/i.test(r.reply), "sources, or the named blocker");
    ok(internalHits(r.reply).length === 0, `internal language: ${internalHits(r.reply).join(", ")}`);
    const e = await sideEffects(); ok(e.wanted + e.jobs + e.drafts === 0, `no application or outreach: ${JSON.stringify(e)}`);
  });
  await c(1, "F2b: the correction keeps the research task (no people list, no drafts)", async (ev) => {
    const r = await w.say(CHAT, F2b.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F2b", r.reply);
    ok(/Stripe/.test(r.reply) && (/\?/.test(r.reply) ? true : /(1|one)[.)]/.test(r.reply) || /couldn't|could not|blocker/i.test(r.reply)), `research questions or the named blocker: ${r.reply.slice(0, 300)}`);
    const e = await sideEffects(); ok(e.drafts === 0 && e.wanted === 0, `no people list, no drafts, no applications: ${JSON.stringify(e)}`);
  });
  await c(8, "F3: a stop reply claims only what the control state and send tables show; no unscheduled reconciliation promise", async (ev) => {
    const r = await w.say(CHAT, F3.text); ev.reply = r.reply; ev.turns = 1;
    const quiet = (await w.sql(`select public.career_user_quiet('${person}')`)) === "t";
    const kv = await w.sql(`select coalesce((select value::text from public.career_watch_kv where user_id = '${person}' and key = 'career:account'), '{}')`);
    ev.reply = `--- control state: career_user_quiet=${quiet}; career:account=${kv}; sends=${JSON.stringify(await sideEffects())}\n${r.reply}`;
    notObserved("F3", r.reply);
    if (/pause (is )?(now )?set|paused (everything|your account)|global pause/i.test(r.reply)) ok(quiet, `the reply claims a pause; the authoritative state must hold it (career_user_quiet = ${quiet}; career:account = ${kv})`);
    if (/blocks every send path|stopped everything/i.test(r.reply)) ok(quiet, "a claim that every send path is blocked needs the persisted pause");
    ok(!/the moment .* (load|loads)|you do not need to ask again|I('ll| will) (report|reconcile) .* later/i.test(r.reply), "no promise of a later reconciliation that nothing schedules");
    ok(/research|Stripe/i.test(r.reply), "says the research answer is still owed (or gives it)");
    const e = await sideEffects(); ok(e.sends === 0 && e.drafts === 0 && e.jobs === 0, `nothing sent or queued: ${JSON.stringify(e)}`);
  });
  await check(t, FILE, 15, "[post-reset baseline] the five post-reset turns replayed with that audit's context meet every criterion (with spec A: 3 scenarios, 10 turns)", async (ev: any) => {
    ev.scenario = "post-reset"; ev.turns = 5;
    ok(T.BASELINE_ALL.scenarios === 3 && T.BASELINE_ALL.turns === 10, "the historical baseline is 3 scenarios, 10 turns");
    ok(passed.length === 5 && passed.every(Boolean), `${passed.filter((x) => !x).length} of ${passed.length} post-reset checks failed`);
  }, w);
});
