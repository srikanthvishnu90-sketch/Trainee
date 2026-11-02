// NEW-PERSON ONBOARDING AND RESUME CONFIRMATION end to end (architect, 2026-10-29): a seeded sample of the generated first
// conversations (tests/architect/scenarios/onboarding-generator.ts; all of them run through the pure code in
// scenarios-onboarding.test.ts) through the REAL production handler (handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration). No model
// (CAREER_BRAIN and OPENAI_API_KEY unset), no network (every host but the Supabase double is refused). Each person is new:
// they paste a resume, then reply in any order (ambiguous replies, a no, a correction, a question in between, a new ask,
// the same resume again, a different resume), say yes or never do, and maybe replace the resume. After every turn the
// database is judged against the same model the pure test uses:
//   - the thread's profile holds exactly the confirmed entries and the latest paste's drafts (as corrected); no entry twice
//   - career_resume_on_file is true exactly when they confirmed a resume (fail closed before, and after an ambiguous reply)
//   - the record (career_resume_record) names the message they pasted the confirmed resume in; career_apply_profile_for
//     (what every application is prepared from) holds that resume's entries and none of a replaced or unconfirmed one
//   - a confirming yes is evidenced in full (every confirmed entry carries its fact_confirmed event; a corrected entry
//     too), never held back
//   - an apply ask before the yes queues nothing; a secret typed into the resume is in no table and the person is told
//   - two messages sent at once (yes + yes, yes + a hedge, two pastes) leave one consistent state
// Volume and time: 100 people and about 470 turns, under 90 seconds. One long-lived psql session (tests/flow/psql-session.ts).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type Journey, journeys, modelStep, newModel, pasted, resume, rng, sig, type Step } from "./scenarios/onboarding-generator.ts";

const CI = Deno.env.get("CI") === "true";
const SEED = 20261029;
const N = 100;
const ID = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000000b${String(n).padStart(4, "0")}`;
const RESUME_KINDS = new Set(["experience", "education", "project", "leadership", "certification"]);
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
const joined = (s: string) => s.replace(/(\d)[ -](?=\d)/g, "$1");

type Role = "plain" | "apply" | "secret" | "race-yes" | "race-hedge" | "race-paste";
// The sample: short journeys from the generator (each a different person), a role each.
function people(): { j: Journey; role: Role }[] {
  const all = journeys(rng(SEED + 7), 2000).filter((j) => j.steps.length <= 6);
  const out: { j: Journey; role: Role }[] = [];
  for (let i = 0; i < N; i++) {
    const j = all[i * Math.floor(all.length / N)];
    const role: Role = i % 12 === 3 ? "apply" : i % 12 === 5 ? "secret" : i % 20 === 7 ? "race-yes" : i % 20 === 11 ? "race-hedge" : i % 20 === 17 ? "race-paste" : "plain";
    if (role === "secret") j.a = resume(rng(SEED + 70_000 + i), 0, { secret: true });
    out.push({ j, role });
  }
  return out;
}

Deno.test({
  name: "generated onboarding journeys through the real handler on real Postgres: only what the person confirmed is theirs",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "OPENAI_API_KEY"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    // D-036: CAREER_MAIL_TRACKING is a release flag (on when unset): every mail path stays off only with "off".
    Deno.env.set("CAREER_MAIL_TRACKING", "off");
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    let closeSession: (() => Promise<void>) | null = null;
    try {
      const sample = people();
      await supabaseParity(pg);
      const ids = sample.map((_, i) => ID(i));
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
          ('greenhouse:onbalpha:1', 'greenhouse', 'onbalpha', 'TEST Onboarding Alpha', 'TEST Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/onbalpha/jobs/1', 'TEST Analyst. Requirements: SQL.', now(), now());
        insert into auth.users (id, email) select x, x || '@example.test' from unnest(array[${ids.map((x) => `'${x}'::uuid`).join(",")}]) x;
        insert into public.profiles (id) select x from unnest(array[${ids.map((x) => `'${x}'::uuid`).join(",")}]) x;
        insert into public.career_watch_kv (user_id, key, value) select x, 'career:account', '{"epoch":0,"version":0,"paused":false}' from unnest(array[${ids.map((x) => `'${x}'::uuid`).join(",")}]) x;`);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, Object.fromEntries(ids.map((x, i) => [`tok-${i}`, x])));
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      // The handler's log lines are kept, not printed (and searched for secrets).
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };

      const failures: string[] = [];
      const fail = (m: string) => failures.push(m);
      // The person's whole state, read in one query.
      const state = async (u: string) => JSON.parse(await fast.sql(`select json_build_object(
        'facts', coalesce((select s.state->'career'->'stores'->'profile'->'facts' from public.agent_flow_state s where s.user_id = '${u}' order by s.updated_at desc limit 1), '[]'::jsonb),
        'on_file', public.career_resume_on_file('${u}'),
        'record', (select json_build_object('state', r.state, 'ref', r.source_ref, 'kind', r.kind) from public.career_resume_record r where r.user_id = '${u}'),
        'upload', (select m.content from public.career_resume_record r join public.agent_messages m on 'agent_messages:' || m.id = r.source_ref where r.user_id = '${u}'),
        'apply', coalesce(public.career_apply_profile_for('${u}')->'facts', '[]'::jsonb),
        'events', (select count(*) from public.career_events e where e.user_id = '${u}' and e.kind = 'fact_confirmed' and e.detail->>'via' = 'router: their yes to the resume entries shown to them'),
        'queued', (select count(*) from public.career_apply_wanted where user_id = '${u}') + (select count(*) from public.career_apply_jobs where user_id = '${u}')
          + (select count(*) from public.career_apply_cards where user_id = '${u}') + (select count(*) from public.career_apply_prepared where user_id = '${u}'))`));
      let turns = 0;
      const counts: Record<string, number> = {};

      await t.step(`${sample.length} new people: paste, reply, confirm (or not), replace; the database holds only what each confirmed`, async () => {
        for (const [i, { j, role }] of sample.entries()) {
          const u = ids[i], chat: Chat = h!.chat(`tok-${i}`);
          const log: string[] = [];
          const where = () => `person ${i} (${role}) [${j.family}]\n      ${log.join("\n      ")}`;
          const say = async (m: string) => {
            turns++;
            const r = await chat.say(m);
            log.push(`${JSON.stringify(m.slice(0, 60))} -> ${r.status} ${r.intent}/${r.resultStatus}: ${r.reply.slice(0, 160).replace(/\n/g, " | ")}`);
            if (r.status !== 200) fail(`turn not answered: ${where()}`);
            return r;
          };
          const model = newModel();
          let steps: Step[] = j.steps;
          if (role.startsWith("race")) steps = j.steps.slice(0, 1); // the race is the second turn
          for (const [k, s] of steps.entries()) {
            const input = s.t === "paste" ? pasted(s.which === "B" ? j.b : j.a, s.lead) : s.input;
            const r = await say(input);
            modelStep(model, s, j);
            const st = await state(u);
            // deno-lint-ignore no-explicit-any
            const facts = (st.facts as any[]).filter((f) => f && f.source === "resume-ingest");
            const got = (xs: typeof facts) => xs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
            const conf = facts.filter((f) => f.needs_confirmation === false), drafts = facts.filter((f) => f.needs_confirmation === true);
            if (JSON.stringify(got(conf)) !== JSON.stringify(sig(model.confirmed))) fail(`confirmed entries are not what the person confirmed: ${where()}\n      db    ${JSON.stringify(got(conf))}\n      model ${JSON.stringify(sig(model.confirmed))}`);
            if (JSON.stringify(got(drafts)) !== JSON.stringify(sig(model.pending?.entries ?? null))) fail(`drafts are not the latest paste's: ${where()}\n      db    ${JSON.stringify(got(drafts))}\n      model ${JSON.stringify(sig(model.pending?.entries ?? null))}`);
            if (st.on_file !== (model.confirmed !== null)) fail(`career_resume_on_file is ${st.on_file}, the person ${model.confirmed ? "confirmed" : "did not confirm"} a resume: ${where()}`);
            if (model.confirmed) {
              const src = model.confirmedFrom === "B" ? j.b : j.a;
              if (st.record?.state !== "confirmed" || st.record?.kind !== "paste" || !String(st.upload ?? "").includes(src.school)) fail(`the record does not name the confirmed paste: ${where()}\n      ${JSON.stringify(st.record)}`);
              if (conf.some((f) => !f.confirmation_event_id || !f.source_ref?.upload_sha256)) fail(`a confirmed entry carries no evidence: ${where()}`);
              // deno-lint-ignore no-explicit-any
              const applyFacts = (st.apply as any[]).filter((f) => RESUME_KINDS.has(f.kind)).map((f) => `${f.kind}|${titleOf(f)}`).sort();
              const want = sig(model.confirmed).filter((x) => RESUME_KINDS.has(x.split("|")[0]));
              if (JSON.stringify(applyFacts) !== JSON.stringify(want)) fail(`applications would be prepared from other entries: ${where()}\n      apply ${JSON.stringify(applyFacts)}\n      model ${JSON.stringify(want)}`);
            } else if (st.record) fail(`a resume record with nothing confirmed: ${where()} ${JSON.stringify(st.record)}`);
            if (s.t === "yes" && model.confirmed && !model.pending && r.intent === "career_resume_ingest" && r.resultStatus !== "completed") fail(`a confirming yes was not evidenced in full: ${where()}`);
            if (s.t !== "yes" && s.t !== "paste" && r.intent === "career_resume_ingest" && r.resultStatus === "completed") fail(`${s.t} confirmed: ${where()}`);
            if (s.t === "question") {
              const held = (model.confirmed ?? []).map((e) => e.title).join(" ");
              for (const v of [j.a.school, j.a.gpa, j.b.school, j.b.gpa]) if (r.reply.includes(v) && !held.includes(v)) fail(`a value not on the confirmed resume was read back (${v}): ${where()}`);
            }
            // The apply ask, right after the first paste (nothing confirmed): nothing queued, and the reason said.
            if (role === "apply" && k === 0) {
              const a = await say("apply to the TEST Analyst job at TEST Onboarding Alpha");
              modelStep(model, { t: "other", input: "apply" }, j);
              const after = await state(u);
              if (Number(after.queued) !== 0 || after.on_file) fail(`queued without a confirmed resume: ${where()}`);
              if (!/resume/i.test(a.reply)) fail(`the apply ask does not say the resume is why: ${where()}`);
            }
            if (role === "secret" && k === 0) {
              const v = j.a.secret!.value;
              if (!/I removed the /.test(r.reply)) fail(`not told the ${j.a.secret!.kind} was removed: ${where()}`);
              const kept = await fast.sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and (m.content like ${`$q$%${v}%$q$`} or replace(replace(m.content, ' ', ''), '-', '') like ${`$q$%${joined(v).replace(/-/g, "")}%$q$`})`);
              const inState = await fast.sql(`select count(*) from public.agent_flow_state s where s.user_id = '${u}' and replace(replace(s.state::text, ' ', ''), '-', '') like ${`$q$%${joined(v).replace(/-/g, "")}%$q$`}`);
              if (kept !== "0" || inState !== "0" || logged.some((l) => joined(l).includes(joined(v)))) fail(`a ${j.a.secret!.kind} was kept (messages ${kept}, state ${inState}): ${where()}`);
            }
          }
          if (role.startsWith("race")) {
            // Two messages at once. The turns run one at a time in the order they arrived (career_turn_gate); whichever
            // order, the state is one consistent state.
            const pair = role === "race-yes" ? ["yes", "yes, that's my resume"] : role === "race-hedge" ? ["yes", "hmm wait"] : [pasted(j.b), pasted(j.a)];
            const rs = await Promise.all(pair.map((m) => chat.say(m)));
            turns += 2;
            log.push(`${JSON.stringify(pair.map((m) => m.slice(0, 30)))} at once -> ${rs.map((r) => `${r.status} ${r.intent}/${r.resultStatus}`).join(" ; ")}`);
            const st = await state(u);
            // deno-lint-ignore no-explicit-any
            const facts = (st.facts as any[]).filter((f) => f && f.source === "resume-ingest");
            const conf = facts.filter((f) => f.needs_confirmation === false), drafts = facts.filter((f) => f.needs_confirmation === true);
            if (conf.length && drafts.length) fail(`a race left confirmed entries and drafts side by side: ${where()}`);
            if (st.on_file !== (conf.length > 0)) fail(`after a race career_resume_on_file is ${st.on_file} with ${conf.length} confirmed entries: ${where()}`);
            if (Boolean(st.record) !== (conf.length > 0)) fail(`after a race the record (${JSON.stringify(st.record)}) and the profile (${conf.length} confirmed) disagree: ${where()}`);
            if (conf.length && Number(st.events) !== conf.length) fail(`after a race ${st.events} fact_confirmed events for ${conf.length} confirmed entries: ${where()}`);
            if (role === "race-yes" && conf.length !== j.a.entries.length) fail(`two yeses did not confirm the resume once: ${where()}`);
            if (role === "race-paste") {
              const g = drafts.map((f) => `${f.kind}|${titleOf(f)}`).sort().join(";");
              const a = j.a.entries.map((e) => `${e.kind}|${e.title}`).sort().join(";"), b = j.b.entries.map((e) => `${e.kind}|${e.title}`).sort().join(";");
              if (g !== a && g !== b) fail(`two pastes at once left a mix of both: ${where()}`);
            }
            counts[role] = (counts[role] ?? 0) + 1;
          }
          // The end: their school is the confirmed resume's, or not on record.
          if (!role.startsWith("race")) {
            const r = await say("where did I go to school?");
            const edu = (model.confirmed ?? []).find((e) => e.kind === "education");
            if (edu ? !r.reply.includes(edu.title.split(/ - |, | \| /)[0]) : !/not on your record|have not stated|not stored|don't have|do not have/i.test(r.reply)) fail(`school read-back: ${where()}`);
            for (const v of [j.a.school, j.b.school]) if ((!edu || !edu.title.includes(v)) && r.reply.includes(v)) fail(`an unconfirmed or replaced school read back (${v}): ${where()}`);
          }
          counts.people = (counts.people ?? 0) + 1;
          // Setup, not the person: the hourly chat limit is reset so a long scripted run is not rate limited.
          if (i % 20 === 19) await fast.sql(`delete from public.agent_rate_limits`);
        }
      });

      await t.step("nothing left the machine; the run stayed under 90 seconds", () => {
        const secs = (Date.now() - started) / 1000;
        realLog.log(`flow-scenarios-onboarding: ${counts.people} people, ${turns} turns (races: ${["race-yes", "race-hedge", "race-paste"].map((k) => `${k} ${counts[k] ?? 0}`).join(", ")}) in ${secs.toFixed(1)} s; refused reads: ${outbound.join("; ") || "none"}`);
        if (outbound.some((o) => !o.startsWith("GET "))) fail(`outbound writes: ${outbound.join(", ")}`);
        if (secs > 90 && CI) fail(`took ${secs.toFixed(0)} s`);
        // The handler's own words about anything it could not record, beside the failures.
        const why = [...new Set(logged.filter((l) => /not recorded|career evidence|revision|conflict/i.test(l)).map((l) => l.slice(0, 300)))].slice(0, 8);
        assertNode.deepEqual(failures.slice(0, 25), [], `${failures.length} failures:\n${failures.slice(0, 25).join("\n")}\nhandler log:\n${why.join("\n")}`);
      });
    } finally {
      Object.assign(console, realLog);
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
