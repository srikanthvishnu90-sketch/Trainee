// R10 fix 7 (spec E.10 7; E.6 50, 51; A.5 "at a known limit"): at the per-person daily AI-answer limit the reply says what
// stopped, keeps the unfinished task, and gives the reset in the person's own time zone, with no unrelated template; after the
// reset, "go ahead" finishes that same task. The global budget day is (now() at time zone 'America/Chicago')::date
// (migration 20261028070000, model_budget_day), so the true reset is the next midnight in Chicago, shown in the person's zone.
// Nothing is raised: the global budget's limit stays as set, and there is no per-person cap (owner, 2026-11-09, WO-J).
// EXPECTED TO FAIL ON TRUNK (WO-D). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-07-limits.test.ts", CHAT = 7_910_701;
R.suite(FILE, [7], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  await w.sql(`insert into public.career_digest_prefs (user_id, tz) values ('${person}', 'America/Chicago') on conflict (user_id) do update set tz = excluded.tz`);
  // The limit, whichever applies on the build under test: the person's recorded spend is past the old per-person ceiling and
  // today's global model budget (model_budget_days, D-038a) is spent. Owner ruling 2026-11-09 (WO-J): no per-person cap; the
  // global budget stays enforced and is never raised here.
  const gate = await R.spendLimit(w, person); // proven: the gate refuses a reservation before the turn
  // The next midnight in America/Chicago (the budget day's end), found as the UTC instant whose Chicago time is 00:00.
  const chi = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]));
  const today = chi(new Date());
  let reset: Date | null = null;
  for (let hUtc = 4; hUtc <= 7 && !reset; hUtc++) { const d = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + 1, hUtc)); if (chi(d).hour === "00" || chi(d).hour === "0") reset = d; }
  if (!reset) throw new Error("could not place the next Chicago midnight");
  const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: true }).format(reset); // the person's zone
  const [h, ampm] = local.split(" ");
  await check(t, FILE, 7, `at the limit: what stopped, the task kept, the reset at ${local} Chicago time, nothing applied, no template`, async (ev: any) => {
    const calls0 = w.modelCalls();
    const r = await w.say(CHAT, T.SCENARIOS.search[1].text);
    ev.reply = `gate: ${gate}\n${r.reply}`;
    ok(w.modelCalls() === calls0, `enforcement intact: no model call at the limit (${w.modelCalls() - calls0} made)`);
    ok(/limit/i.test(r.reply) && r.reply.search(/limit/i) < 300, `the limit is said first: ${r.reply.slice(0, 300)}`);
    ok(!/\b(UTC|GMT)\b|\b\d{1,2}(:\d{2})?\s?Z\b/i.test(r.reply), `no UTC, GMT or Z time anywhere (the reset is the person's): ${r.reply.match(/[^.]*\b(UTC|GMT)\b[^.]*|\b\d{1,2}(:\d{2})?\s?Z\b/i)?.[0]}`);
    ok((new RegExp(`\\b${h}(:00)?\\s?${ampm}\\b`, "i").test(r.reply) || (h === "12" && /\bmidnight\b(?!\s*\(?\s*(UTC|GMT|Z)\b)/i.test(r.reply))) && /Chicago|Central|your time/i.test(r.reply), `the reset in the person's zone (${local}, midnight Chicago): ${r.reply.slice(0, 400)}`);
    ok(/search|internships?|list/i.test(r.reply), "names the task that stopped");
    ok(/(haven't|have not|didn't|did not) appl|nothing (was )?(applied|sent)/i.test(r.reply), "says nothing was applied");
    ok(!/The window, checked against the record|2026-10-13|Tell me what you'd like to do next/.test(r.reply), "no unrelated template or old date");
    ok(R.repeated(r.reply).length === 0, "no repeated sentences");
  }, w);
  await check(t, FILE, 7, "after the reset, 'go ahead' finishes the same widened search", async (ev: any) => {
    await R.releaseLimit(w, person);
    const r = await w.say(CHAT, "Go ahead.");
    ev.reply = r.reply;
    for (const m of T.MARKET.filter((x: any) => x.s2)) ok(r.reply.includes(m.company), `the kept task resumes with ${m.company}: ${r.reply.slice(0, 400)}`);
  }, w);
});
