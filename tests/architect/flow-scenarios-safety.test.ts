// The safety and truth rules end to end, sampled from the generated scenarios (tests/architect/scenarios-fixture.ts), through
// the REAL production handler (handler-career.ts handleChat; harness tests/flow/handler.ts: real supabase-js over
// tests/flow/postgrest.ts, real Postgres 16 with every migration). No model (CAREER_BRAIN and OPENAI_API_KEY unset), and
// every host but the Supabase double is refused and recorded: none may be LinkedIn, Indeed or Handshake, and none may
// write (a GET of an employer's public job board, which the apply turn reads on demand, is refused here and listed). After every turn the database is checked:
//   sites    an ask on LinkedIn, Indeed or Handshake is declined naming the site; nothing queued, carded or batched; a
//            "yes" after it is not taken by a batch. Controls ("indeed I did", employer links, advice) are never declined.
//   secrets  a password, one-time code or card number is never echoed, never in any table, never in a log line; the
//            person is told what was removed. Controls (phones, zips, job ids, salaries, dates, order numbers) are stored
//            exactly as written.
//   apply    with no confirmed resume nothing is queued, carded or prepared, and an apply ask says why.
//   facts    a person with no record is told a fact is not on record and asked, never given a value; a person with a
//            confirmed resume gets its school and GPA back, and nothing else.
// Volume and time: about 260 turns, well under three minutes. The handler's database calls go through one long-lived psql
// session (tests/flow/psql-session.ts, as the scale load test does) instead of a new psql per call: the same database,
// statements and roles, without measuring process start-up 30 times a turn.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { applyAsks, cards, codes, keptNumbers, passwords, rng, type Secret, siteAsks, siteControls } from "./scenarios-fixture.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const A = "7b0f8f8e-6a43-4a49-9d2c-00000000ccd1", B = "7b0f8f8e-6a43-4a49-9d2c-00000000ccd2";
const POSTINGS = [
  ["greenhouse:scenalpha:1", "greenhouse", "scenalpha", "TEST Scenario Alpha", "TEST Analyst", "https://boards.greenhouse.io/scenalpha/jobs/1"],
  ["greenhouse:scenbravo:2", "greenhouse", "scenbravo", "TEST Scenario Bravo", "Data Analyst", "https://boards.greenhouse.io/scenbravo/jobs/2"],
  ["greenhouse:scencharlie:3", "greenhouse", "scencharlie", "TEST Scenario Charlie", "Operations Analyst", "https://boards.greenhouse.io/scencharlie/jobs/3"],
];
const joined = (s: string) => s.replace(/(\d)[ .-](?=\d)/g, "$1");
const leaks = (text: string, secret: string) => text.includes(secret) || joined(text).includes(joined(secret));
// A 4 to 8 digit code is looked for as a number of its own (as typed, or with its spaces or dashes), never inside a UUID,
// a timestamp or a longer number that happens to hold the same digits.
const codeIn = (text: string, c: Secret) => [c.secret, c.input.match(/\d(?:[ -]?\d){3,7}/)?.[0] ?? c.secret]
  .some((v) => new RegExp(`(?<![0-9a-f:.-])${v.replace(/-/g, "\\-")}(?![0-9a-f:.-])`, "i").test(text));
const leakOf = (text: string, c: Secret) => c.kind === "code" ? codeIn(text, c) : leaks(text, c.secret);

Deno.test({
  name: "generated safety scenarios through the real handler on real Postgres: sites, secrets, no-resume applies, facts",
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
    const logged: string[] = [];
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${POSTINGS.map(([id, prov, board, co, title, url]) => `('${id}', '${prov}', '${board}', '${co}', '${title}', 'Chicago, IL', '${url}', '${title}. Requirements: SQL, Python, dashboards.', now(), now())`).join(",\n")};
        insert into auth.users (id, email) values ('${A}', 'scen-a@example.test'), ('${B}', 'scen-b@example.test');
        insert into public.profiles (id) values ('${A}'), ('${B}');
        insert into public.career_watch_kv (user_id, key, value) values ('${A}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${B}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        create or replace function public.scen_dump() returns text language plpgsql as $f$
        declare r record; acc text := ''; chunk text;
        begin
          for r in select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public', 'auth') loop
            execute format('select coalesce(string_agg(t::text, E''\\n''), '''') from %I.%I t', r.table_schema, r.table_name) into chunk;
            acc := acc || chunk || E'\\n';
          end loop;
          return acc;
        end $f$;`);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, { "tok-a": A, "tok-b": B });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host} (after ${JSON.stringify(lastSaid)})`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      // Every log line the handler writes is kept (and not printed): no secret may reach one.
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };

      // A fresh thread every 25 turns, as a person's conversations are: history stays short and each block stands alone.
      let chat: Chat = h.chat("tok-a"), turns = 0, lastSaid = "";
      const say = async (m: string, token = "tok-a") => {
        if (token === "tok-a" && ++turns % 25 === 0) chat = h!.chat("tok-a");
        // Setup, not the person: the hourly chat limit (60 a person) is reset so a long scripted run is not rate limited.
        if (turns % 40 === 0) await pg.sql(`delete from public.agent_rate_limits where user_id in ('${A}', '${B}')`);
        lastSaid = m;
        const r = await chat.say(m);
        assertNode.equal(r.status, 200, `${m}: ${r.status} ${r.reply}`);
        return r;
      };
      const queuedFor = async (who: string) => Number(await pg.sql(`select (select count(*) from public.career_apply_wanted where user_id = '${who}') + (select count(*) from public.career_apply_jobs where user_id = '${who}')
        + (select count(*) from public.career_apply_cards where user_id = '${who}') + (select count(*) from public.career_apply_prepared where user_id = '${who}')`));
      const batchState = async () => await pg.sql(`select coalesce(string_agg(coalesce(state#>>'{career,stores,batchApplyState}', ''), ''), '') from public.agent_flow_state where user_id = '${A}'`);
      const lastStored = async () => await pg.sql(`select m.content from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${A}' and m.role = 'user' order by m.id desc limit 1`);
      const counts: Record<string, number> = {};
      const failures: string[] = [];
      const fail = (m: string) => failures.push(m);

      await t.step("sites: 70 asks declined naming the site, nothing queued or batched; 30 controls never declined", async () => {
        const asks = siteAsks(rng(20261029), 3000).filter((_, i) => i % 43 === 0).slice(0, 70);
        for (const [i, c] of asks.entries()) {
          const r = await say(c.input);
          if (!["career_site_refused", "career_linkedin_refused"].includes(String(r.intent)) || !r.reply.includes(`Nothing was sent or done on ${c.expect}.`)) fail(`site ask not declined: ${JSON.stringify(c.input)} -> ${r.intent}: ${r.reply.slice(0, 200)}`);
          if (await queuedFor(A)) fail(`queued after ${JSON.stringify(c.input)}`);
          if (await batchState()) fail(`batch opened after ${JSON.stringify(c.input)}`);
          if (i % 7 === 6) {
            const yes = await say("yes");
            if (yes.intent === "career_batch_apply" || /this batch is not ready|Nothing was submitted/i.test(yes.reply)) fail(`a "yes" after ${JSON.stringify(c.input)} was taken: ${yes.intent}: ${yes.reply.slice(0, 160)}`);
          }
        }
        const controls = siteControls(rng(91), 1200);
        for (const c of [...controls.slice(0, 15), ...controls.slice(40).filter((_, i) => i % 70 === 0)].slice(0, 30)) {
          const r = await say(c.input);
          if (["career_site_refused", "career_linkedin_refused"].includes(String(r.intent)) || /Nothing was sent or done on (LinkedIn|Indeed|Handshake)/.test(r.reply)) fail(`control declined: ${JSON.stringify(c.input)} -> ${r.intent}: ${r.reply.slice(0, 160)}`);
        }
        counts.sites = asks.length + 30;
      });

      const secrets: Secret[] = [...passwords(rng(1), 1200).filter((_, i) => i % 48 === 0), ...codes(rng(2), 1000).filter((_, i) => i % 50 === 0), ...cards(rng(3), 1000).filter((_, i) => i % 40 === 0)];
      await t.step(`secrets: ${secrets.length} passwords, codes and card numbers never echoed, stored or logged; 20 controls stored as written`, async () => {
        for (const c of secrets) {
          const r = await say(c.input);
          if (leakOf(r.reply, c)) fail(`echoed: ${JSON.stringify(c.input)} -> ${r.reply.slice(0, 200)}`);
          if (!/I removed the .*from your message and didn't keep it/.test(r.reply)) fail(`not told what was removed: ${JSON.stringify(c.input)} -> ${r.reply.slice(0, 200)}`);
          const stored = await lastStored();
          if (leakOf(stored, c)) fail(`stored: ${JSON.stringify(c.input)} -> ${stored}`);
        }
        for (const c of keptNumbers(rng(4), 1500).filter((_, i) => i % 75 === 0).slice(0, 20)) {
          await say(c.input);
          const stored = await lastStored();
          if (!stored.includes(c.keep)) fail(`control changed in storage: ${JSON.stringify(c.input)} -> ${stored}`);
        }
        const dump = await pg.sql(`select public.scen_dump()`);
        for (const c of secrets) if (leakOf(dump, c)) fail(`in the database: ${c.kind} from ${JSON.stringify(c.input)}`);
        for (const c of secrets) if (logged.some((l) => leakOf(l, c))) fail(`in a log line: ${c.kind} from ${JSON.stringify(c.input)}`);
        counts.secrets = secrets.length + 20;
      });

      await t.step("apply with no confirmed resume: 50 asks, nothing queued, carded or prepared; each apply turn says why", async () => {
        chat = h!.chat("tok-a");
        await say("find analyst jobs in Chicago");
        const asks = applyAsks(rng(4040), 2000, POSTINGS.map(([, , , company, title]) => ({ company, title }))).filter((_, i) => i % 40 === 0).slice(0, 50);
        for (const a of asks) {
          const r = await say(a.input);
          if (await queuedFor(A)) fail(`queued without a resume: ${JSON.stringify(a.input)} -> ${r.intent}: ${r.reply.slice(0, 200)}`);
          if (/\b(?:submitted|applied for you|is on your apply list)\b/i.test(r.reply.replace(/nothing (?:is|was|has been) (?:sent|submitted)/ig, ""))) fail(`claims an application: ${JSON.stringify(a.input)} -> ${r.reply.slice(0, 200)}`);
          // An apply turn that found its posting(s) says the resume is why; one with no list or no such posting says that.
          if (String(r.intent).startsWith("career_apply") && !["none", "which", "no_list"].includes(String(r.resultStatus)) && !/no (?:confirmed )?resume|resume on file|paste (?:or attach )?your resume|send me your resume/i.test(r.reply)) fail(`no reason given: ${JSON.stringify(a.input)} -> ${r.intent}/${r.resultStatus}: ${r.reply.slice(0, 200)}`);
        }
        counts.apply = asks.length + 1;
      });

      await t.step("facts: no record says not on record and asks; a confirmed resume reads back its school and GPA only", async () => {
        const QS = ["where did I go to school?", "what's my GPA?", "do I need sponsorship?", "am I a citizen?", "what's my visa status?", "where do I live?",
          "what roles am I looking for?", "WHATS MY GPA", "wher did i go to school", "do i need visa sponsorship", "am I authorized to work in the US?", "where am I based?"];
        const NOT_ON = /not on your record|do not have your|don't have your|have not told me|not stored|you have not stated/i;
        chat = h!.chat("tok-a");
        for (const q of QS) {
          const r = await say(q);
          if (/\bverdict\b|TEST University|\b[0-4]\.\d{1,2}\b|you(?:'re| are) a (?:us )?citizen|(?<!\b(?:do|whether|if)\s)you (?:do not |don't )?need (?:visa )?sponsorship/i.test(r.reply)) fail(`a value not on record: ${JSON.stringify(q)} -> ${r.reply.slice(0, 200)}`);
          if (!NOT_ON.test(r.reply) || !/\?|\bstate (?:it|a|an)\b|\btell me\b/i.test(r.reply)) fail(`not said to be not on record and asked: ${JSON.stringify(q)} -> ${r.intent}: ${r.reply.slice(0, 200)}`);
        }
        const b = h!.chat("tok-b");
        const pasted = await b.say(`here is my resume:\n${RESUME}`);
        assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await b.say("yes that's my resume");
        assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        for (const q of ["where did I go to school?", "what's my GPA?", "whats my gpa", "Where did i go to school??"]) {
          const r = await b.say(q);
          if (!/TEST University|3\.7/.test(r.reply)) fail(`confirmed resume not read back: ${JSON.stringify(q)} -> ${r.intent}: ${r.reply.slice(0, 200)}`);
          const gpas = [...new Set(r.reply.match(/\b[0-4]\.\d{1,2}\b/g) ?? [])];
          if (gpas.some((g) => g !== "3.7")) fail(`a GPA not on record: ${JSON.stringify(q)} -> ${r.reply.slice(0, 200)}`);
        }
        counts.facts = QS.length + 6;
      });

      await t.step("nothing reached LinkedIn, Indeed or Handshake and nothing was written off the machine; the run stayed under three minutes", () => {
        const bad = outbound.filter((o) => !o.startsWith("GET ") || /linkedin|lnkd|licdn|indeed|handshake/i.test(o.split(" (after")[0]));
        if (bad.length) fail(`outbound requests: ${bad.join(", ")}`);
        const secs = (Date.now() - started) / 1000;
        realLog.log(`flow-scenarios-safety: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; total ${Object.values(counts).reduce((a, b) => a + b, 0)} turns in ${secs.toFixed(1)} s; refused reads: ${outbound.join("; ") || "none"}`);
        if (secs > 180) fail(`took ${secs.toFixed(0)} s`);
        assertNode.deepEqual(failures, [], failures.join("\n"));
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
