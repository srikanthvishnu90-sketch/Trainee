// WHOLE JOURNEYS ROUND 2: the interaction bugs the seeded journeys found (journeys-r2-*.test.ts), each as the shortest
// journey that shows it, through the same world (scenarios/journeys-r2-world.ts: the real agent-chat, trainee-telegram and
// trainee-file handlers on Postgres). Each step here failed on trunk before its fix.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/journeys-r2-regressions.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { CI, emailOf, POSTINGS, resumeOf, startWorld, tokenOf, uidOf, type Person, type World } from "./scenarios/journeys-r2-world.ts";
import { textOf } from "./scenarios/journeys-r2-run.ts";
import { answerText } from "../../supabase/functions/_shared/career_apply_cards.ts";

// The card's answer for an item whose prepared application is gone (a newer resume discards prepared applications,
// 20261026120018 career_resume_stop_unbound; the database's result then has no company): was "1. null: not sent: ...".
// Found in the 2,000-journey run (journey 942: the card on Telegram, a correction on the web, "send them" on Telegram).
Deno.test("whole journeys round 2: a card's answer never reads 'null' for an application no longer on file", () => {
  const t = answerText([{ n: 1, company: null as unknown as string, result: "changed" }, { n: 2, company: "Bravo Labs", result: "changed" }]);
  assertNode.ok(!/\bnull\b/.test(t), t);
  assertNode.ok(/^1\. An application no longer on file: not sent: it changed after the card was shown$/m.test(t) && /^2\. Bravo Labs: not sent/m.test(t), t);
});

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

Deno.test({
  name: "whole journeys round 2: the interaction bugs, each the shortest journey that shows it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const ids = [900001, 900002, 900003, 900004, 900005];
    const w: World = await startWorld({ tokens: Object.fromEntries(ids.map((j) => [tokenOf(j), uidOf(j)])) });
    try {
      const n = async (s: string) => Number(await w.sql(s));
      const wanted = async (p: Person) => await n(`select count(*) from public.career_apply_wanted where user_id = ${q(p.uid)}`);
      const confirmedOnTelegram = async (p: Person) => {
        const up = await w.tgResumeFile(p, resumeOf(p.spec));
        assert(/15 facts/.test(up.said.join("\n")), `setup: the resume file is read: ${up.said.join(" | ")}`);
        const yes = await w.tg(p, "yes, that's my resume");
        assert(/confirmed/i.test(yes.said.join("\n")), `setup: confirmed: ${yes.said.join(" | ")}`);
        eq(await w.sql(`select public.career_resume_on_file(${q(p.uid)})`), "t", "setup: a resume on file");
      };

      await t.step("Telegram's Apply and the jobs page's Apply queue nothing without a confirmed resume, and say why (as the chat does)", async () => {
        const p = await w.addPerson(ids[0], 0);
        const chat = await w.web(p, `apply to the Data Analyst role at ${POSTINGS[0].company}`);
        eq(chat.resultStatus, "no_resume", `the chat refuses: ${chat.reply}`);
        const at = w.bot.to(p.tg).length;
        await w.tg(p, "find data analyst jobs in Chicago");
        const apply = w.bot.to(p.tg).slice(at).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).find((d) => /^jca:/.test(d));
        assert(apply, `setup: the cards carry Apply: ${JSON.stringify(w.bot.to(p.tg).slice(at).map((m) => [m.text.slice(0, 80), m.buttons]))}`);
        const tap = await w.tap(p, apply!);
        eq(await wanted(p), 0, `was: "Queued, not applied ... When it's ready I'll show you the exact application to approve" with no resume on file: ${tap.said.join(" | ")}`);
        assert(/no resume on file/.test(tap.said.join("\n")), `the reason is said: ${tap.answer} | ${tap.said.join(" | ")}`);
        const page = await w.filePage(p);
        assert(page && page.rows.length, `setup: the jobs page lists the postings: ${page && textOf(page.html).slice(0, 200)}`);
        const res = await w.filePost(p, page!.sid, { action: "apply", ref: page!.rows[0].ref, tag: page!.rows[0].tag });
        eq(await wanted(p), 0, `the jobs page queued it without a resume: ${textOf(res.html).slice(0, 300)}`);
        assert(/no resume on file/.test(textOf(res.html)), `the page says why: ${textOf(res.html).slice(0, 300)}`);
      });

      await t.step("a GPA corrected after their computer prepared: the card never shows or approves the old value; an approval carrying it is withdrawn", async () => {
        const p = await w.addPerson(ids[1], 1);
        await confirmedOnTelegram(p);
        for (const po of POSTINGS.slice(0, 3)) eq((await w.web(p, `apply to the Data Analyst role at ${po.company}`)).resultStatus, "queued");
        eq(await w.prepare(p, POSTINGS.slice(0, 2).map((x) => x.key)), 2, "setup: two prepared with the confirmed GPA");
        const first = await w.web(p, "show my applications");
        eq(first.resultStatus, "shown", first.reply);
        const one = await w.web(p, "only 1");
        eq(one.resultStatus, "answered", `setup: the first approved with the old GPA, not yet sent: ${first.reply} => ${one.reply}`);
        const old = p.gpa;
        const fix = await w.web(p, "actually my GPA is 3.95");
        eq(fix.resultStatus, "completed", fix.reply);
        assert(/everything I prepare uses the corrected words/.test(fix.reply), fix.reply);
        const card = await w.web(p, "show my applications");
        assert(!new RegExp(`GPA: ${old.replace(".", "\\.")}\\b`).test(card.reply), `was: the card showed "GPA: ${old}" after the correction, "exactly as shown": ${card.reply}`);
        const yes = await w.web(p, "yes");
        const jobs = await w.json<{ company: string; fields: string }>(`select company, (payload->'fields')::text as fields from public.career_apply_jobs where user_id = ${q(p.uid)} and state in ('queued', 'driving')`);
        eq(jobs.filter((j) => j.fields.includes(`"value": "${old}"`) || j.fields.includes(`"value":"${old}"`)), [], `an approval carrying the corrected-away GPA stands: ${yes.reply}`);
        // Prepared again from the corrected entry, it is shown and approved with the new value.
        eq(await w.prepare({ ...p, gpa: "3.95" }, POSTINGS.slice(0, 2).map((x) => x.key)), 2, "prepared again from the corrected entry");
        const again = await w.web(p, "show my applications");
        assert(/GPA: 3\.95/.test(again.reply) && !new RegExp(`GPA: ${old.replace(".", "\\.")}\\b`).test(again.reply), again.reply);
        // The card on screen, then another correction, then "yes" to that card: nothing approved, each item named (was
        // "1. null: not sent: it changed after the card was shown" in the 2,000-journey run, journey 942).
        const onTg = await w.tg(p, "show my applications");
        assert(/applications? (?:is|are) ready/.test(onTg.said.join("\n")), `setup: the card on Telegram: ${onTg.said.join(" | ")}`);
        const fix2 = await w.web(p, "actually my GPA is 3.85");
        eq(fix2.resultStatus, "completed", fix2.reply);
        const late = (await w.tg(p, "yes")).said.join("\n");
        assert(!/\bnull\b/.test(late), `the answer names each application: ${late}`);
        const jobs2 = await w.json<{ fields: string }>(`select (payload->'fields')::text as fields from public.career_apply_jobs where user_id = ${q(p.uid)} and state in ('queued', 'driving')`);
        eq(jobs2.filter((j) => /"value": ?"3\.95"/.test(j.fields)), [], `the yes approved the corrected-away 3.95: ${late}`);
        void emailOf;
      });

      await t.step("career work paused in the chat: Telegram's Apply and the jobs page's Apply queue nothing either, and say why", async () => {
        const p = await w.addPerson(ids[4], 4);
        await confirmedOnTelegram(p);
        const at = w.bot.to(p.tg).length;
        await w.tg(p, "find data analyst jobs in Chicago");
        const applies = w.bot.to(p.tg).slice(at).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((d) => /^jca:/.test(d));
        assert(applies.length >= 2, "setup: the cards carry Apply");
        const pause = await w.web(p, "pause all career work");
        eq(pause.intent, "career_paused", pause.reply);
        const chat = await w.web(p, `apply to the Data Analyst role at ${POSTINGS[0].company}`);
        assert(/paused/.test(chat.reply), `the chat holds: ${chat.reply}`);
        const tap = await w.tap(p, applies[1]);
        eq(await wanted(p), 0, `was: the Apply tap queued it while paused: ${tap.said.join(" | ")}`);
        assert(/paused/.test(tap.said.join("\n")), `the tap says why: ${tap.said.join(" | ")}`);
        const page = await w.filePage(p);
        assert(page && page.rows.length, "setup: the jobs page");
        const res = await w.filePost(p, page!.sid, { action: "apply", ref: page!.rows[0].ref, tag: page!.rows[0].tag });
        eq(await wanted(p), 0, `was: the jobs page queued it while paused: ${textOf(res.html).slice(0, 300)}`);
        assert(/paused/.test(textOf(res.html)), `the page says why: ${textOf(res.html).slice(0, 300)}`);
        eq((await w.web(p, "resume career work")).intent, "career_resumed");
        await w.tap(p, applies[1]);
        eq(await wanted(p), 1, "after the pause is lifted the same tap queues it");
      });

      await t.step("'show my applications' with nothing to show, then 'yes': never told a card was already answered", async () => {
        const p = await w.addPerson(ids[2], 2);
        const none = await w.web(p, "show my applications");
        assert(/no confirmed resume/i.test(none.reply), none.reply);
        const yes = await w.web(p, "yes");
        assert(!/That card was already answered/.test(yes.reply), `was: "That card was already answered. Nothing more was sent." with no card ever shown: ${yes.reply}`);
        const p2 = await w.addPerson(ids[3], 3);
        await confirmedOnTelegram(p2);
        const empty = await w.tg(p2, "show my applications");
        assert(/Nothing is ready/.test(empty.said.join("\n")), empty.said.join(" | "));
        const yes2 = await w.tg(p2, "yes");
        assert(!/That card was already answered/.test(yes2.said.join("\n")), `was: "That card was already answered" on Telegram with no card: ${yes2.said.join(" | ")}`);
        eq(await n(`select count(*) from public.career_apply_jobs where user_id in (${q(p.uid)}, ${q(p2.uid)})`), 0);
      });
    } finally {
      await w.stop();
    }
  },
});
