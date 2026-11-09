// R10 fix 3 (spec E.10 3; E.1 2; A.2 turn-1 screenshot context): supplied resume facts are used, filed correctly, never
// invented and never asked for again. The intake files skills, certifications and interests as what they are (the audit's
// screenshot showed "Skill: Skills: Python", "Skill: Interests: Coding", "Skill: Golf"); the draft is built from those facts;
// "Leave GPA off. What did you change?" answers with the actual edits and the next file has no GPA.
// EXPECTED TO FAIL ON TRUNK (WO-A). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-03-facts.test.ts", CHAT = 7_910_301;
R.suite(FILE, [3], [CHAT], async (t: Deno.TestContext, w: any) => {
  let readback = "";
  await check(t, FILE, 3, "the intake files skills, certifications and interests as themselves (no 'Skill: Interests: ...', no 'Skill: Golf')", async (ev: any) => {
    await w.say(CHAT, "hi");
    const up = await w.upload(CHAT, "Jordan_Rivera_Resume.pdf", R.pdfOf(T.INTAKE_RESUME), "here is my resume");
    readback = up.reply;
    ev.reply = up.reply;
    ok(!/Skill:\s*(Skills|Interests|Certifications):/i.test(up.reply), `a section label is not filed as a skill: ${up.reply.match(/Skill:\s*(Skills|Interests|Certifications):[^\n]*/i)?.[0]}`);
    ok(!/Skill:\s*(Golf|Chess|Coding)\b/i.test(up.reply), "an interest is not a skill");
    const em = /(\d+) experience/i.exec(up.reply);
    ok(em, `the readback says how many experience entries it read: ${up.reply.slice(0, 300)}`);
    const exp = Number(em![1]);
    ok(exp <= 4, `only the four jobs are experience; skills, certifications and interests are not (${exp} experience entries read)`);
    ok(/skills?\b/i.test(up.reply) && /certifications?\b/i.test(up.reply) && /interests?\b/i.test(up.reply), "the readback names skills, certifications and interests as their own kinds");
    ok(!/Skill:\s*(Bloomberg Market Concepts|Google Data Analytics Certificate)/i.test(up.reply), "a certification is not a skill");
    await w.say(CHAT, "yes, that's my resume");
    const person = await w.personOf(CHAT);
    const subjects = (await w.json(`select subject from public.career_events where user_id = '${person}' and kind = 'fact_confirmed'`)).map((x: any) => String(x.subject));
    ev.reply = `RECORD (${subjects.length}): ${subjects.join(" | ")}\n---\n${up.reply}`;
    ok(subjects.length >= 8, `facts were confirmed (${subjects.length})`);
    ok(!subjects.some((s: string) => /^skill:\s*(skills|interests|certifications):/i.test(s)), `no doubled label in the record: ${subjects.filter((s: string) => /^skill:/i.test(s)).join(" | ")}`);
    ok(!subjects.some((s: string) => /^skill:\s*(golf|chess|coding)$/i.test(s)), `interests are not recorded as skills: ${subjects.filter((s: string) => /^skill:/i.test(s)).join(" | ")}`);
    // Nothing supplied is lost either: every section of the intake is on the record as what it is.
    for (const fact of ["Python", "SQL", "Tableau", "Bloomberg Market Concepts", "Google Data Analytics Certificate", "Golf", "Rivera Tutoring", "CourtSide Stats", "SAT"]) ok(subjects.some((s: string) => s.includes(fact)), `the supplied fact "${fact}" is on the record (${subjects.length} facts: ${subjects.join(" | ").slice(0, 500)})`);
    ok(subjects.some((s: string) => /interest/i.test(s) && /Golf/.test(s)) || !subjects.some((s: string) => /skill/i.test(s) && /Golf/.test(s)), "Golf is an interest");
  }, w);
  await w.say(CHAT, T.OLD_SEARCH);
  await check(t, FILE, 3, "the draft asks only for what is not on file (contact details, the conflicting GPA), never for a fact the intake holds", async (ev: any) => {
    const r = await w.say(CHAT, T.SCENARIOS.resume[0].text);
    ev.reply = r.reply;
    ok(!/what('s| is) your (name|school|major)|which (university|school)|what did you do at|tell me about your experience/i.test(r.reply), `does not re-ask a fact on file: ${r.reply.slice(0, 400)}`);
    ok(/email|phone|contact/i.test(r.reply) && /\?/.test(r.reply), `asks the one missing fact by name: ${r.reply.slice(0, 400)}`);
    ok(/GPA/i.test(r.reply) && ((/3\.6/.test(r.reply) && /3\.8/.test(r.reply)) || /GPA[^.?]*\b(conflict\w*|two (different )?(values|GPAs)|differ\w*|disagree\w*|which (one|is right))\b/i.test(r.reply)), `names the GPA conflict (both 3.6 and 3.8, or conflict wording) instead of picking one: ${r.reply.slice(0, 400)}`);
  }, w);
  await check(t, FILE, 3, "'Leave GPA off. What did you change?' names the actual edits, adds nothing, and the file has no GPA", async (ev: any) => {
    const r = await w.say(CHAT, "Leave GPA off. What did you change?");
    ev.reply = r.reply;
    ok(/GPA/.test(r.reply) && /(off|omitted|left out|removed)/i.test(r.reply), `confirms the GPA is off: ${r.reply.slice(0, 400)}`);
    ok(/(did not|didn't) add|nothing (new )?(was )?added|no new (job|tool|result|credential)/i.test(r.reply), "says nothing was added");
    ok(!/ATS[- ]friendly|optimi[sz]ed for ATS|keywords? (were )?added/i.test(r.reply), "explains actual edits, not a generic ATS promise");
    const files = await deliveredFiles(w, CHAT, r, "gpa-off", ev);
    ok(files.some((f: any) => f.kind === "pdf"), "the revised PDF comes with the answer, so the GPA's absence can be checked on the page");
    for (const f of files.filter((x: any) => x.kind === "pdf")) ok(!/GPA|3\.6|3\.8/.test(f.pdf.text), `${f.name}: GPA is off the page`);
  }, w);
});
