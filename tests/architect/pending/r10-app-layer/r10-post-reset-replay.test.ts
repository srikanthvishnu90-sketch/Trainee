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
  // The world seeds open matching roles (T.MARKET: the s2 rows answer 200 on their employer pages), so the only correct search answer
  // is those listings; any "nothing found" or "connection problem" claim contradicts the world and FAILS.
  const searchChecks = (id: string, r: any) => {
    const want = T.MARKET.filter((m: any) => m.s2);
    const listed = want.filter((m: any) => new RegExp(`^\\s*\\d+[.)].*${m.company}`, "m").test(r.reply));
    ok(listed.length >= 3, `${id}: at least three of the seeded open roles are listed (${listed.map((m: any) => m.company).join(", ") || "none"}): ${r.reply.slice(0, 400)}`);
    for (const m of listed) ok(r.reply.includes(m.url) || r.buttons.some((b: any) => b.url === m.url), `${id}: ${m.company}'s application link`);
    for (const m of listed) ok(r.pageChecks.includes(m.url), `${id}: ${m.company}'s employer page was opened this turn before it was listed as open`);
    ok(!/no open (roles|postings|internships)|nothing (open|was) found|search connection|couldn't reach the (job )?board|searched 0/i.test(r.reply), `${id}: claims a blocker the world does not have (open roles are seeded): ${r.reply.slice(0, 300)}`);
    ok(!/confirm(ed)? (your )?resume|yes, that's my resume|eligibility can't be graded/i.test(r.reply), `${id}: listing waits on neither the resume nor an eligibility verdict`);
  };
  await c(5, "F1a: the seeded open postings with links, checked this turn; no invented blocker, no resume-confirmation tail", async (ev) => {
    const r = await w.say(CHAT, F1a.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F1a", r.reply);
    searchChecks("F1a", r);
    ok((await sideEffects()).wanted === 0, "nothing queued");
  });
  await c(2, "F1b: answers which blocker applies (none of the three: the open postings are shown), no eligibility lecture", async (ev) => {
    const r = await w.say(CHAT, F1b.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F1b", r.reply);
    searchChecks("F1b", r);
    ok(!/your resume (is|isn't) (the|what's) blocking|need(s)? (your|a) confirmed resume/i.test(r.reply), "an unconfirmed resume is not named as the search blocker");
    ok((await w.sql(`select public.career_resume_on_file('${person}')`)) === "f", "the resume was not confirmed for the person");
  });
  // Research: this world refuses every host outside it (recorded in w.outbound), so no source can be inspected. A brief would have
  // to cite pages it actually opened, which cannot exist here; the only correct answer is the NAMED blocker, and that claim must
  // match the world: a source request was really attempted (and refused) on this turn.
  const researchChecks = (id: string, r: any, out0: number) => {
    const attempted = w.outbound.slice(out0);
    const named = /couldn't (open|reach|load|check)|could not (open|reach|load|check)|unable to (open|reach|load)|(sources?|pages?|web) (were|was|is|are) (unreachable|blocked|unavailable)/i.test(r.reply);
    ok(named, `${id}: names the blocker (the sources could not be opened): ${r.reply.slice(0, 300)}`);
    ok(attempted.length > 0, `${id}: the blocker is evidenced: a source request was attempted this turn and refused (attempts: ${attempted.length})`);
    ok(!/\$\s?\d|\d+(\.\d+)?\s?(%|percent|billion|trillion|million)/i.test(r.reply), `${id}: no metric stated without an inspected source`);
    ok(!/BRAIN.STUB|MODEL.STUB/.test(r.reply), `${id}: the product's answer, not the stub's`);
  };
  await c(14, "F2a: Stripe research, or the named blocker the world really has (sources unreachable, attempted); no batch, no role search", async (ev) => {
    const out0 = w.outbound.length;
    const r = await w.say(CHAT, F2a.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F2a", r.reply);
    researchChecks("F2a", r, out0);
    ok(internalHits(r.reply).length === 0, `internal language: ${internalHits(r.reply).join(", ")}`);
    const e = await sideEffects(); ok(e.wanted + e.jobs + e.drafts === 0, `no application or outreach: ${JSON.stringify(e)}`);
  });
  await c(1, "F2b: the correction keeps the research task: the same named, evidenced blocker; no people list, no drafts", async (ev) => {
    const out0 = w.outbound.length;
    const r = await w.say(CHAT, F2b.text); ev.reply = r.reply; ev.turns = 1;
    notObserved("F2b", r.reply);
    researchChecks("F2b", r, out0);
    ok(!/analysts? at Stripe|people list|LinkedIn/i.test(r.reply), "no people list");
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
    // No automatic unpause (spec F.3): whatever the stop set holds through the next ordinary turn (a probe, not one of the 5).
    const probe = await w.say(CHAT, "ok");
    const quietAfter = (await w.sql(`select public.career_user_quiet('${person}')`)) === "t";
    ev.reply += `\n--- after a probe turn ("ok"): career_user_quiet=${quietAfter}\n${probe.reply.slice(0, 200)}`;
    ok(!quiet || quietAfter, "a pause the stop set is not lifted by the next turn (no automatic unpause)");
  });
  await check(t, FILE, 15, "[post-reset baseline] the five post-reset turns replayed with that audit's context meet every criterion (with spec A: 3 scenarios, 10 turns)", async (ev: any) => {
    ev.scenario = "post-reset"; ev.turns = 5;
    ok(T.BASELINE_ALL.scenarios === 3 && T.BASELINE_ALL.turns === 10, "the historical baseline is 3 scenarios, 10 turns");
    ok(passed.length === 5 && passed.every(Boolean), `${passed.filter((x) => !x).length} of ${passed.length} post-reset checks failed`);
  }, w);
});
