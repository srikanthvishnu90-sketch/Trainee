// TAILORING, LETTERS AND FORM ANSWERS END TO END, ROUND 4 (architect, 2026-11-05; owner rule D-007). A sample of round 4's
// battery (scenarios-tailoring-r4.test.ts, ~12,000 scenarios) through the REAL production handler (handler-career.ts handleChat;
// harness tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration). Each
// person pastes the fixture resume and confirms it in chat, in a thread of their own. The brain is scripted (a fake model
// endpoint answers only the essay drafter; every other host is refused and recorded). Every check reads the database:
//   echo       "Describe your experience with Fivetran ..." drafted first as "At TEST Systems Inc, I used Fivetran ...", then
//              honestly: only the honest draft is shown, and "use 1" saves exactly it
//   upgrade    a draft that moves a date onto another employer ("from June 2024", the year of their other internship), then
//              their real GPA ("a 3.7 GPA", refused on trunk: a decimal was read as two numbers): only the honest one is saved
//   screening  a draft that says they were never convicted and can start immediately, twice: nothing shown, nothing saved,
//              the question still open and the reply says so
//   eeo        a form's three voluntary questions, stored by the ask-once worker code (questionsToStore): three rows, each
//              kept to its posting; the person answers one by text: only that row holds an answer, and the planner, fed
//              the rows as the worker feeds them (factsWithTextAnswers), fills no voluntary question at the next employer
//   compound   "a valid driver's license and reliable transportation?": the stored question is the posting's; the person's
//              "No" is saved, and their license fact never answers the same question at the next employer
//   isolation  no answer of one person is in another's rows
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { factsWithTextAnswers, questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const N_ECHO = 3, N_UP = 3, N_SCREEN = 3, N_EEO = 3, N_COMP = 2;
const TOTAL = N_ECHO + N_UP + N_SCREEN + N_EEO + N_COMP;
const PEOPLE = Array.from({ length: TOTAL }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000041${String(i).padStart(4, "0")}`);
const hex16 = (n: number) => n.toString(16).padStart(16, "0");
const sq = (s: string) => s.replace(/'/g, "''");
const BASE = "At TEST Systems Inc, I built a reporting dashboard in React and Python used by 200 internal users.";
// Honest sentences from the fixture's confirmed facts; each person's draft is their own combination (isolation reads them).
const HONEST = [BASE, "At TEST Systems Inc, I cut weekly reporting time by 40% by automating data pulls from PostgreSQL.",
  "At Example Capital, I built a three-statement financial model in Excel for a fictional retail company."];
const EEO = [
  { label: "Do you have a disability?", type: "select", options: ["Yes", "No", "I don't wish to answer"] },
  { label: "Are you a protected veteran?", type: "select", options: ["Yes", "No", "I don't wish to answer"] },
  { label: "Are you Hispanic or Latino?", type: "select", options: ["Yes", "No", "Decline to self-identify"] },
];

Deno.test({
  name: "round 4 on Postgres: the posting's words, upgrades, screening prose, voluntary and compound questions, through the real handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "CAREER_MODEL", "CAREER_TAILOR_REWRITE", "CAREER_HOSTED_PREPARE"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);`);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p])));
      const sql = async (s: string) => (await fast.sql(s)).trim();

      let essay: string[] = [];
      const calls = { essay: 0, other: 0 };
      const answer = (content: string, model: string) => new Response(JSON.stringify({ id: "chatcmpl-test", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 500, completion_tokens: 100 } }), { headers: { "content-type": "application/json" } });
      // deno-lint-ignore no-explicit-any
      const fakeModel = (body: any): Response => {
        const sys = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
        if (/one answer to a job application question/.test(sys)) { calls.essay++; return answer(essay.shift() ?? "", body.model); }
        calls.other++;
        return answer("{}", body.model);
      };
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        // deno-lint-ignore no-explicit-any
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      Deno.env.set("ANTHROPIC_API_KEY", ["sk", "test", "fake"].join("-"));

      const failures: string[] = [];
      const counts: Record<string, number> = {};
      const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
      const typedBy = new Map<string, string[]>();
      const onboard = async (n: number) => {
        const chat = h!.chat(`tok-${n}`);
        const pasted = await chat.say(`here is my resume:\n${RESUME}`);
        assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await chat.say("yes, that's my resume");
        assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        count("setup turns"); count("setup turns");
        return chat;
      };
      const answerOf = async (who: string) => await sql(`select coalesce(string_agg(answer, '|' order by key), '') from public.career_apply_questions where user_id = '${who}' and answer is not null`);
      const putQuestion = async (who: string, key: string, kind: string, label: string, type: string, options: string[], job: string, company: string) =>
        await sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, options, job_ids, company)
          values ('${who}', '${sq(key)}', '${kind}', '${sq(label)}', '${type}', '${sq(JSON.stringify(options))}', array['${sq(job)}'], '${sq(company)}')`);
      // A written question, a scripted drafter: the planted draft first, then (when given) the honest one.
      const drafted = async (step: string, k: number, n: number, label: string, planted: string, honest: string | null, mark: RegExp) => {
        const who = PEOPLE[n], chat = await onboard(n);
        await putQuestion(who, `job:${hex16(n + 1)}`, "essay", label, "textarea", [], `greenhouse:larkspur:${n}`, "Larkspur Health (TEST)");
        const list = await chat.say("what do you need from me");
        count(`${step} turns`);
        if (!list.reply.includes(label)) { failures.push(`${step} #${k}: the question is not shown: ${list.reply.slice(0, 200)}`); return; }
        essay = honest ? [planted, honest] : [planted, planted];
        const d = await chat.say("draft 1");
        count(`${step} turns`);
        const shown = /^Draft for 1, written only from your confirmed facts/.test(d.reply);
        const body = shown ? d.reply.split("\n\n")[1] ?? "" : "";
        if (mark.test(body)) failures.push(`${step} #${k}: the planted draft was shown: ${body}`);
        if (honest === null) {
          if (shown) failures.push(`${step} #${k}: a draft was shown though both said what the record does not: ${body}`);
          if (!/didn't show a draft for 1/.test(d.reply) || !/Reply "1" and your own answer/.test(d.reply)) failures.push(`${step} #${k}: the person is not told the draft was held back and the question is theirs: ${d.reply.slice(0, 300)}`);
          if (await answerOf(who)) failures.push(`${step} #${k}: an answer was saved`);
          return;
        }
        if (!shown) { failures.push(`${step} #${k}: the honest retry was not shown: ${d.reply.slice(0, 300)}`); return; }
        if (body.trim() !== honest) failures.push(`${step} #${k}: the draft shown is not the honest one: ${body}`);
        await chat.say("use 1");
        count(`${step} turns`);
        const got = await answerOf(who);
        typedBy.set(who, [got]);
        if (got !== body.trim()) failures.push(`${step} #${k}: the saved answer is not the one shown: ${JSON.stringify(got)}`);
      };

      await t.step(`echo: ${N_ECHO} people, the question's own tool said as their experience`, async () => {
        const TERMS = ["Fivetran", "Workiva", "Guidewire"];
        for (let k = 0; k < N_ECHO; k++) {
          const term = TERMS[k % TERMS.length];
          await drafted("echo", k, k, `Describe your experience with ${term} and with reporting.`,
            `At TEST Systems Inc, I used ${term} to load data for a reporting dashboard used by 200 internal users.`, `${HONEST[k % 3]} ${HONEST[(k + 1) % 3]}`, new RegExp(term));
        }
      });

      await t.step(`upgrade: ${N_UP} people, a date moved onto another employer, then their real GPA`, async () => {
        for (let k = 0; k < N_UP; k++) {
          await drafted("upgrade", k, N_ECHO + k, "Tell us about your background.",
            "I worked at TEST Systems Inc from June 2024 to August 2025, where I built a reporting dashboard in React and Python used by 200 internal users.",
            `I study Computer Science at TEST University with a 3.7 GPA. ${HONEST[k % 3]}`, /June 2024 to August 2025/);
        }
      });

      await t.step(`screening: ${N_SCREEN} people, a draft that answers screening questions they never answered`, async () => {
        for (let k = 0; k < N_SCREEN; k++) {
          await drafted("screening", k, N_ECHO + N_UP + k, "Is there anything else you would like us to know?",
            `${BASE} I have never been convicted of a crime and I can start immediately.`, null, /convicted|start immediately/);
        }
      });

      await t.step(`eeo: ${N_EEO} people, three voluntary questions on one form; they answer one by text`, async () => {
        for (let k = 0; k < N_EEO; k++) {
          const n = N_ECHO + N_UP + N_SCREEN + k, who = PEOPLE[n], chat = await onboard(n);
          const res = { posting: `greenhouse:quarry:${800 + k}`, company: "Quarry Bank (TEST)", location: "Chicago, IL", questions: EEO };
          const qs = questionsToStore(res, { facts: {}, answered: new Set() }).questions as { key: string; kind: string; label: string; type: string; options: string[]; company: string }[];
          for (const q of qs) await putQuestion(who, q.key, q.kind, q.label, q.type, q.options, res.posting, q.company);
          const rows = Number(await sql(`select count(*) from public.career_apply_questions where user_id = '${who}'`));
          if (rows !== EEO.length) failures.push(`eeo #${k}: ${rows} rows stored for ${EEO.length} voluntary questions (${qs.map((q) => q.key).join(", ")})`);
          if (Number(await sql(`select count(*) from public.career_apply_questions where user_id = '${who}' and key not like 'job:%'`))) failures.push(`eeo #${k}: a voluntary answer would travel to other employers`);
          const list = await chat.say("what do you need from me");
          count("eeo turns");
          if (!EEO.some((q) => list.reply.includes(q.label))) { failures.push(`eeo #${k}: no voluntary question is shown: ${list.reply.slice(0, 200)}`); continue; }
          const a = await chat.say("No");
          count("eeo turns");
          typedBy.set(who, []);
          const answered = (await sql(`select coalesce(string_agg(label || '=' || answer, '|'), '') from public.career_apply_questions where user_id = '${who}' and answer is not null`)).split("|").filter(Boolean);
          if (answered.length !== 1 || !/=No$/.test(answered[0])) { failures.push(`eeo #${k}: ${JSON.stringify(answered)} answered after one "No": ${a.reply.slice(0, 200)}`); continue; }
          // the worker's next preparation: the person's rows as its facts, another employer's voluntary questions
          const dbRows = (await sql(`select coalesce(json_agg(json_build_object('id', id, 'key', key, 'kind', kind, 'answer', answer))::text, '[]') from public.career_apply_questions where user_id = '${who}' and answer is not null`));
          const facts = factsWithTextAnswers({ answers: { full_name: { value: "Alex Testcase", factId: "fact:full_name" } }, saved: {} }, JSON.parse(dbRows));
          const fields = EEO.map((q, i) => ({ name: `e${i}`, label: q.label, type: "multi_value_single_select", required: false, options: q.options.map((l) => ({ label: l, value: l })) }));
          const next = planBatch({ userId: who, postings: [{ job_id: `greenhouse:otter:${k}`, company: "Otter Freight (TEST)", title: "Analyst", fields, location: "Chicago, IL", url: `https://boards.greenhouse.io/otter/jobs/${k}` }],
            answers: facts.answers, saved: facts.saved, log: [], now: Date.now() });
          for (const x of next.ready[0]?.fields ?? []) failures.push(`eeo #${k}: "${answered[0]}" filled ${JSON.stringify(x.label)} with "${x.value}" at the next employer`);
        }
      });

      await t.step(`compound: ${N_COMP} people, a license question that asks more than the license`, async () => {
        for (let k = 0; k < N_COMP; k++) {
          const n = N_ECHO + N_UP + N_SCREEN + N_EEO + k, who = PEOPLE[n], chat = await onboard(n);
          const label = k % 2 ? "Do you have a valid driver's license with a clean driving record?" : "Do you have a valid driver's license and reliable transportation?";
          const license = { drivers_license: { value: "Yes", factId: "fact:drivers_license" } };
          const res = { posting: `greenhouse:kite:${900 + k}`, company: "Kite Analytics (TEST)", location: "Chicago, IL", questions: [{ label, type: "select", options: ["Yes", "No"] }] };
          const qs = questionsToStore(res, { facts: license, answered: new Set() }).questions as { key: string; kind: string; label: string; type: string; options: string[]; company: string }[];
          if (qs.length !== 1 || !qs[0].key.startsWith("job:")) { failures.push(`compound #${k}: stored as ${JSON.stringify(qs.map((q) => q.key))}`); continue; }
          await putQuestion(who, qs[0].key, qs[0].kind, qs[0].label, qs[0].type, qs[0].options, res.posting, qs[0].company);
          const list = await chat.say("what do you need from me");
          count("compound turns");
          if (!list.reply.includes(label)) { failures.push(`compound #${k}: the question is not shown: ${list.reply.slice(0, 200)}`); continue; }
          await chat.say("No");
          count("compound turns");
          typedBy.set(who, []);
          if (await answerOf(who) !== "No") { failures.push(`compound #${k}: the person's "No" was not saved: ${await answerOf(who)}`); continue; }
          const dbRows = (await sql(`select coalesce(json_agg(json_build_object('id', id, 'key', key, 'kind', kind, 'answer', answer))::text, '[]') from public.career_apply_questions where user_id = '${who}' and answer is not null`));
          const facts = factsWithTextAnswers({ answers: { ...license }, saved: {} }, JSON.parse(dbRows));
          const field = { name: "c", label, type: "multi_value_single_select", required: true, options: ["Yes", "No"].map((l) => ({ label: l, value: l })) };
          const here = planBatch({ userId: who, postings: [{ job_id: res.posting, company: res.company, title: "Analyst", fields: [field], location: "Chicago, IL", url: "https://boards.greenhouse.io/kite/jobs/1" }], answers: facts.answers, saved: facts.saved, log: [], now: Date.now() });
          if (here.ready[0]?.fields[0]?.value !== "No") failures.push(`compound #${k}: the person's own answer is not what is planned at their posting: ${JSON.stringify(here)}`);
          const next = planBatch({ userId: who, postings: [{ job_id: `greenhouse:pine:${k}`, company: "Pinecrest Energy (TEST)", title: "Analyst", fields: [field], location: "Chicago, IL", url: "https://boards.greenhouse.io/pine/jobs/1" }], answers: facts.answers, saved: facts.saved, log: [], now: Date.now() });
          if (next.ready.length) failures.push(`compound #${k}: the license fact answered ${JSON.stringify(label)} at the next employer with "${next.ready[0].fields[0]?.value}"`);
        }
      });

      await t.step("isolation: no one's answer is in another person's rows", async () => {
        for (const [who, typed] of typedBy) {
          for (const text of typed.filter((x) => x && x.length > 12)) {
            const others = Number(await sql(`select count(*) from public.career_apply_questions where user_id <> '${who}' and position('${sq(text)}' in coalesce(answer, '')) > 0`));
            if (others) failures.push(`isolation: ${JSON.stringify(text.slice(0, 60))} of ${who} is in another person's rows`);
          }
        }
      });

      console.log(`flow-scenarios-tailoring-r4: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; model calls ${JSON.stringify(calls)}; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
      assertNode.deepEqual(outbound, [], "no network");
      assertNode.deepEqual(failures, [], failures.join("\n"));
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
