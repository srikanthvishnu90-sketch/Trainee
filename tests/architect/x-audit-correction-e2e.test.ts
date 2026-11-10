// x-audit (E.11 #9, coordinator 2026-11-10): a person corrects a confirmed fact in chat ("actually I graduate May 2027,
// not 2026"), end to end through the real handlers on Postgres (scenarios/journeys-r2-world.ts: the real agent-chat,
// trainee-telegram and trainee-file handlers). The correction is stored as confirmed with its own event, replaces the old
// value everywhere it is used, never travels on an application already approved without a new yes, and the old value is
// in none of the person's live records afterwards (their own words in the chat history and the timeline are history).
// Where the old value can still be used, each place is checked on its own, so a failure names it:
//   profile       the confirmed education entry, and what applications are prepared from (career_apply_profile_for)
//   approved      an approved, not yet sent application carrying the old date: withdrawn, never sent without a new yes
//   prepared      a prepared, not yet approved application: not shown or approved with the old date
//   next card     "show my applications" after the correction never shows the old date
//   library       the answer the person gave once to "Expected graduation date" (career_apply_questions, the answer
//                 library every later form is filled from): not reused with the old date
// 6/7 on trunk (the answer library kept the old answer); 7/7 with 20261110200000.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/x-audit-correction-e2e.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { CI, emailOf, POSTINGS, resumeOf, startWorld, tokenOf, uidOf, type Person, type World } from "./scenarios/journeys-r2-world.ts";
import { ENTRY_CORRECTION_VIA } from "../../supabase/functions/_shared/career_router_evidence.ts";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const OLD = "May 2026", NEW = "May 2027";

Deno.test({
  name: "x-audit E.11 #9: a fact corrected in chat replaces the old value everywhere it is used, and never travels on an approved application",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const ID = 910001;
    const w: World = await startWorld({ tokens: { [tokenOf(ID)]: uidOf(ID) } });
    try {
      const n = async (s: string) => Number(await w.sql(s));
      // slot 0: graduating May 2026 (journeys-r2-world personSpec)
      const p: Person = await w.addPerson(ID, 0);
      assertNode.equal(p.grad, 2026, "setup: the resume says graduating May 2026");
      const up = await w.tgResumeFile(p, resumeOf(p.spec));
      assertNode.ok(/facts/.test(up.said.join("\n")), `setup: the resume is read: ${up.said.join(" | ")}`);
      const yes = await w.tg(p, "yes, that's my resume");
      assertNode.ok(/confirmed/i.test(yes.said.join("\n")), `setup: confirmed: ${yes.said.join(" | ")}`);
      for (const po of POSTINGS.slice(0, 3)) assertNode.equal((await w.web(p, `apply to the Data Analyst role at ${po.company}`)).resultStatus, "queued");
      // Their computer prepares two, each with the graduation date from the confirmed entry (as career_apply_prepare_own).
      const sha = await w.sql(`select coalesce((select detail->'upload'->>'sha256' from public.career_events where user_id = ${q(p.uid)} and kind = 'fact_confirmed' and detail ? 'upload' order by at desc limit 1), '')`);
      const acct = async (k: string) => Number(await w.sql(`select coalesce((value->>${q(k)})::int, 0) from public.career_watch_kv where user_id = ${q(p.uid)} and key = 'career:account'`) || 0);
      for (const po of POSTINGS.slice(0, 2)) {
        const payload = { version: 1, user_id: p.uid, job_id: po.key, company: po.company, url: po.url,
          fields: [{ name: "email", label: "Email", value: emailOf(p.spec), factId: "x9-email" }, { name: "graduation", label: "Expected graduation date", value: OLD, factId: "x9-grad" }],
          privacy_epoch: await acct("epoch"), account_version: await acct("version"), expires_at: new Date(Date.now() + 2 * 86400_000).toISOString(), resume_sha256: sha || "0".repeat(64) };
        // deno-lint-ignore no-explicit-any
        const r = await (w.pg as any).asPerson(p.uid).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`${po.company}: ${po.title}`, `Email: ${emailOf(p.spec)}`, `Expected graduation date: ${OLD}`] });
        assertNode.ok(!r.error, `setup: prepared ${po.company}: ${JSON.stringify(r.error)}`);
      }
      const shown = await w.web(p, "show my applications");
      assertNode.equal(shown.resultStatus, "shown", shown.reply);
      const one = await w.web(p, "only 1");
      assertNode.equal(one.resultStatus, "answered", `setup: the first approved with ${OLD}: ${one.reply}`);
      assertNode.equal(await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)} and state = 'queued' and position(${q(OLD)} in (payload->'fields')::text) > 0`), 1, "setup: one approved, queued, not yet sent, carrying the old date");
      // The answer library: the person once answered an employer's "Expected graduation date" with the old date.
      await w.sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, state, answer, answered_at)
        values (${q(p.uid)}, 'fact:graduation_date', 'fact', 'Expected graduation date', 'input_text', 'answered', ${q(OLD)}, now())
        on conflict (user_id, key) do update set state = 'answered', answer = excluded.answer, answered_at = now()`);

      const fix = await w.web(p, `actually I graduate ${NEW}, not 2026`);
      const results: Record<string, string> = {};
      const check = (name: string, ok: boolean, detail: string) => { results[name] = ok ? "ok" : `FAIL ${detail}`; };

      await t.step("the correction is stored as confirmed, with its own event", async () => {
        // What every application is prepared from (career_apply_profile_for); a fact's own correction trail ("corrections":
        // from, to, the person's words) is its history and stays, so it is left out of the search for the old value.
        type Fact = { kind: string; text: string; title: string; confirmed_at?: string; confirmation_event_id?: string; corrections?: unknown[] };
        const facts = (await w.json<{ facts: Fact[] }[]>(`select coalesce(public.career_apply_profile_for(${q(p.uid)})->'facts', '[]'::jsonb) as facts`))[0]?.facts ?? [];
        const edu = facts.filter((f) => f.kind === "education");
        const live = JSON.stringify(facts.map(({ corrections: _c, ...f }) => f));
        const events = await n(`select count(*) from public.career_events where user_id = ${q(p.uid)} and kind = 'fact_confirmed' and detail->>'via' = ${q(ENTRY_CORRECTION_VIA)}`);
        check("profile: corrected entry confirmed, its own event", edu.some((f) => `${f.text} ${f.title}`.includes(NEW) && !!(f.confirmed_at || f.confirmation_event_id)) && events === 1,
          `education ${JSON.stringify(edu.map((f) => f.title))}, correction events ${events}, reply: ${fix.reply.slice(0, 200)}`);
        // Only the graduation date was corrected: another entry may end in May 2026 (a club role, "September 2025 - May
        // 2026") and rightly keeps it. The education entry is where the old graduation date must be gone.
        const eduLive = JSON.stringify(edu.map(({ corrections: _c, ...f }) => f));
        const at = eduLive.indexOf(OLD);
        check("prepared from: only the corrected graduation date", eduLive.includes(NEW) && at < 0, at < 0 ? "the corrected value is missing" : `the old value at: ...${eduLive.slice(Math.max(0, at - 200), at + 40)}`);
        void live;
      });

      await t.step("never on an approved or prepared application, nor the next card, nor the answer library", async () => {
        check("approved: withdrawn, not sent", await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)} and state in ('queued', 'driving') and position(${q(OLD)} in (payload->'fields')::text) > 0`) === 0,
          "an approved application still carries the old date");
        check("prepared: not ready with the old date", await n(`select count(*) from public.career_apply_prepared where user_id = ${q(p.uid)} and state in ('ready', 'shown') and position(${q(OLD)} in payload::text) > 0`) === 0,
          "a prepared application is still ready with the old date");
        const card = await w.web(p, "show my applications");
        check("next card: no old date", !card.reply.includes(OLD), card.reply.slice(0, 300));
        const after = await w.web(p, "yes");
        check("a yes after the correction approves nothing with the old date",
          await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)} and state in ('queued', 'driving') and position(${q(OLD)} in (payload->'fields')::text) > 0`) === 0, after.reply.slice(0, 200));
        check("library: the old answer is not reused", await n(`select count(*) from public.career_apply_questions where user_id = ${q(p.uid)} and state = 'answered' and answer = ${q(OLD)}`) === 0,
          "career_apply_questions still holds the answered 'Expected graduation date' = May 2026, which later forms are filled from");
      });

      await t.step("result", () => {
        const failed = Object.entries(results).filter(([, v]) => v !== "ok");
        console.log(`E.11 #9: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} places hold only the corrected value`);
        for (const [k, v] of Object.entries(results)) console.log(`  ${v === "ok" ? "ok  " : "FAIL"} ${k}${v === "ok" ? "" : ": " + v.slice(5)}`);
        assertNode.deepStrictEqual(failed, []);
      });
    } finally {
      await w.stop();
    }
  },
});
