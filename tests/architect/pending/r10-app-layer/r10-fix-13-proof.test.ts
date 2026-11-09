// R10 fix 13 (spec E.10 13; E.3 26, 32-34; E.7 62; C.11): execution and proof match reality. An approved application whose
// final click timed out (the worker recorded submitted_unconfirmed, no receipt) reads "Submission uncertain" in chat and on its
// proof File, is not retried blindly, and is never "Submitted" or "Confirmed by employer"; a confirmed one shows its real
// receipt; the status keeps queued, uncertain and confirmed apart, never one success count.
// EXPECTED TO FAIL ON TRUNK (WO-G). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-13-proof.test.ts", CHAT = 7_911_301;
const [A, B, C] = [T.MARKET[0], T.MARKET[1], T.MARKET[2]];
R.suite(FILE, [13], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  // Three approved applications (the person's yes to each exact card), then the worker's recorded outcomes: one timed out at the
  // final click, one confirmed by the employer with a receipt, one still queued.
  for (const j of [A, B, C]) {
    await R.prepare(w, person, j, [{ name: "first_name", label: "First name", value: "Jordan" }]);
    await w.say(CHAT, "Show my applications.");
    await w.say(CHAT, "yes");
  }
  const jobs = await w.json(`select id, job_id, state, attempts from public.career_apply_jobs where user_id = '${person}' order by created_at`);
  await check(t, FILE, 13, "setup: three applications approved by the person's yes, each queued with no attempt", async (ev: any) => {
    ev.reply = JSON.stringify(jobs);
    ok(jobs.length === 3 && jobs.every((j: any) => j.state === "queued" && j.attempts === 0), ev.reply);
  }, w);
  if (jobs.length === 3) {
    await w.sql(`update public.career_apply_jobs set state = 'submitted_unconfirmed', attempts = 1, reason = 'the final submit timed out; no confirmation page was seen', updated_at = now() where id = '${jobs[0].id}'`);
    await w.sql(`update public.career_apply_jobs set state = 'confirmed', attempts = 1, confirmation_id = 'LTA-2026-0042', email_confirmed_at = now(), confirmation_mail_hash = repeat('ab', 32), updated_at = now() where id = '${jobs[1].id}'`);
  }
  await check(t, FILE, 13, "'status of my applications': the timed-out one is uncertain, the confirmed one shows its receipt, the queued one is not sent", async (ev: any) => {
    const r = await w.say(CHAT, "status of my applications");
    ev.reply = r.reply;
    const line = (c: string) => r.reply.split("\n").find((l: string) => l.includes(c)) ?? "";
    ok(/uncertain|not sure|couldn't confirm|no confirmation/i.test(line(A.company)) && !/\bsubmitted\b|\bconfirmed\b(?! by| it)/i.test(line(A.company).replace(/not confirmed|unconfirmed|couldn't confirm|no confirmation/gi, "")), `${A.company}: uncertain, never submitted/confirmed: ${line(A.company)}`);
    ok(/LTA-2026-0042/.test(r.reply) && /confirmed/i.test(line(B.company)), `${B.company}: confirmed, with the employer's receipt: ${line(B.company)}`);
    ok(/not (sent|submitted) yet|queued|waiting/i.test(line(C.company)), `${C.company}: approved and not sent: ${line(C.company)}`);
    ok(!/\b3 (submitted|sent|applied)\b|all (three|3) (were )?(sent|submitted)/i.test(r.reply), "no single success count over mixed states");
    ok((await w.sql(`select attempts from public.career_apply_jobs where id = '${jobs[0]?.id}'`)) === "1" && (await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)) === "3", "no blind retry, no new job");
  }, w);
  await check(t, FILE, 13, "the uncertain application's proof File reads 'Submission uncertain', shows no receipt id, and offers no blind retry (390 px)", async (ev: any) => {
    const { createFileService, supabaseFileKindStore } = await import(`${helper}../../../supabase/functions/_shared/file_service.ts`);
    const { supabaseFileStore } = await import(`${helper}../../../supabase/functions/trainee-file/store.ts`);
    // As agent-chat builds it (handler-career.ts): the proof's facts come from the application's own record.
    const svc = createFileService({ store: supabaseFileKindStore(w.admin), env: Deno.env, now: Date.now, records: { application: (u: string, id: string) => supabaseFileStore(w.admin).appRow(u, id) } });
    let made = await svc.create(person, "application_proof", { application_id: jobs[0]?.job_id }, { trusted: true });
    if (!made.ok) made = await svc.create(person, "application_proof", { application_id: jobs[0]?.id }, { trusted: true });
    ok(made.ok && made.url, `a proof File: ${made.error}`);
    const got = await w.open(made.url, CHAT);
    ok(got.status === 200 && got.html, "it opens");
    const r = await R.renderOpened(got, "f13-proof-uncertain");
    ev.screenshots.push(r.screenshot);
    ev.reply = r.text.slice(0, 600);
    ok(/Submission uncertain/i.test(r.text), "reads 'Submission uncertain'");
    ok(!/Confirmed by employer|Submitted\b(?! uncertain)/i.test(r.text.replace(/Submission uncertain/gi, "")), "never 'Submitted' or 'Confirmed by employer'");
    ok(!/LTA-|receipt (id|number)[: ]+\S/i.test(r.text), "no receipt id");
    ok(!/<button[^>]*>\s*(Retry|Submit again|Try again)/i.test(got.html), "no blind retry control");
  }, w);
});
