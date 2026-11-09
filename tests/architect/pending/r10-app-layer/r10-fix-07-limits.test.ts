// R10 fix 7 (spec E.10 7; E.6 50, 51; A.5 "at a known limit"): at the per-person daily AI-answer limit the reply says what
// stopped, keeps the unfinished task, and gives the reset in the person's own time zone (America/Chicago: 6 pm CST while the
// limit resets at 00:00 UTC), with no unrelated template; after the reset, "go ahead" finishes that same task. The caps are
// not raised: the code defaults stay /bin/bash.05 and 100 calls a person a day.
// EXPECTED TO FAIL ON TRUNK (WO-D). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-07-limits.test.ts", CHAT = 7_910_701;
R.suite(FILE, [7], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  await check(t, FILE, 7, "the caps are unchanged: $0.05 and 100 model calls a person a UTC day", async (ev: any) => {
    const cap = await import(`${helper}../../../supabase/functions/_shared/career_spend_cap.ts`);
    ev.reply = `DEFAULT_DAILY_USD=${cap.DEFAULT_DAILY_USD} DEFAULT_DAILY_CALLS=${cap.DEFAULT_DAILY_CALLS}`;
    ok(cap.DEFAULT_DAILY_USD === 0.05 && cap.DEFAULT_DAILY_CALLS === 100, ev.reply);
    ok(Deno.env.get("CAREER_MODEL_DAILY_USD") === undefined && Deno.env.get("CAREER_MODEL_DAILY_CALLS") === undefined, "the suite runs at the defaults");
  }, w);
  await w.sql(`insert into public.career_digest_prefs (user_id, tz) values ('${person}', 'America/Chicago') on conflict (user_id) do update set tz = excluded.tz`);
  await w.sql(`insert into public.agent_turn_costs (user_id, provider, models, calls, usd_micros) values ('${person}', 'anthropic', '{claude-haiku-5-5}', 100, 60000)`);
  const reset = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
  const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: true }).format(reset);
  const [h, ampm] = local.split(" ");
  await check(t, FILE, 7, `at the limit: what stopped, the task kept, the reset at ${local} Chicago time, nothing applied, no template`, async (ev: any) => {
    const r = await w.say(CHAT, T.SCENARIOS.search[1].text);
    ev.reply = r.reply;
    ok(/limit/i.test(r.reply) && r.reply.search(/limit/i) < 300, `the limit is said first: ${r.reply.slice(0, 300)}`);
    ok(!/midnight UTC/i.test(r.reply), "not in UTC");
    ok(new RegExp(`\\b${h}(:00)?\\s?${ampm}\\b`, "i").test(r.reply) && /Chicago|Central|your time/i.test(r.reply), `the reset in the person's zone (${local}): ${r.reply.slice(0, 400)}`);
    ok(/search|internships?|list/i.test(r.reply), "names the task that stopped");
    ok(/(haven't|have not|didn't|did not) appl|nothing (was )?(applied|sent)/i.test(r.reply), "says nothing was applied");
    ok(!/The window, checked against the record|2026-10-13|Tell me what you'd like to do next/.test(r.reply), "no unrelated template or old date");
    ok(R.repeated(r.reply).length === 0, "no repeated sentences");
  }, w);
  await check(t, FILE, 7, "after the reset, 'go ahead' finishes the same widened search", async (ev: any) => {
    await w.sql(`delete from public.agent_turn_costs where user_id = '${person}'`);
    const r = await w.say(CHAT, "Go ahead.");
    ev.reply = r.reply;
    for (const m of T.MARKET.filter((x: any) => x.s2)) ok(r.reply.includes(m.company), `the kept task resumes with ${m.company}: ${r.reply.slice(0, 400)}`);
  }, w);
});
