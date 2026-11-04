// LETTER TARGET END TO END (architect, 2026-10-29; owner rule D-007). A sample of the generated letter and tailoring asks
// (tests/architect/scenarios/letter-target-generator.ts; every one runs through the router's own code in
// scenarios-letter-target.test.ts) sent through the REAL production handler (handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration), each in a
// thread of its own, by a person with no resume and by a person whose resume they pasted and confirmed in chat. After every
// turn:
//   reply     every target the reply sets or states is made only of what they said (a firm's own short form counts), and it
//             names no company with a file on record that the ask did not name; a named target is the one read back
//   database  the target the thread keeps for the resume they will paste (the thread's tailorTarget) is a company the ask
//             named, or there is none
// "write a cover letter … I live in Boston" (the onboarding battery's turn, trunk: "the Boston Consulting Group role") is
// the first turn. No model (CAREER_BRAIN and ANTHROPIC_API_KEY unset), no network: every host but the Supabase double is
// refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type LetterCase, letterCases, namedIn, ONFILE, replyViolation, rng } from "./scenarios/letter-target-generator.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
// One person per ask (what one ask said never colours the next): 40 with no resume, 16 with a confirmed one.
const PEOPLE = Array.from({ length: 56 }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000017${String(i).padStart(4, "0")}`);
const NO_RESUME = 40;

// A stratified sample: a few of every family, in the generator's own order.
function sampleOf(cases: LetterCase[], perFamily: number, total: number): LetterCase[] {
  const by = new Map<string, LetterCase[]>();
  for (const c of cases) { const k = c.family.split(":").slice(0, 2).join(":"); if (!by.has(k)) by.set(k, []); if (by.get(k)!.length < perFamily) by.get(k)!.push(c); }
  const out: LetterCase[] = [];
  for (let i = 0; out.length < total && i < perFamily; i++) for (const xs of by.values()) if (xs[i] && out.length < total) out.push(xs[i]);
  return out;
}

Deno.test({
  name: "letter and tailoring targets through the real handler on real Postgres: only what the person named",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    // D-036: CAREER_MAIL_TRACKING is a release flag (on when unset): every mail path stays off only with "off".
    Deno.env.set("CAREER_MAIL_TRACKING", "off");
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      // Open postings at firms whose names open with a city or a plain word (Boston Dynamics, Delta Metrics ...).
      const desc = "TEST Data Analyst. Requirements: SQL, dashboards.";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${ONFILE.map((c, i) => `('greenhouse:lt${i}:${i + 1}', 'greenhouse', 'lt${i}', '${c}', 'Data Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/lt${i}/jobs/${i + 1}', '${desc}', now(), now())`).join(",\n")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${ONFILE.map((c, i) => `('greenhouse:lt${i}:${i + 1}', 'greenhouse', 'lt${i}', '${c}', 'Data Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/lt${i}/jobs/${i + 1}', now() - interval '${i} hours', '${desc}', 'lt${i}')`).join(",\n")};
        insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);`);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p])));
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;

      const failures: string[] = [];
      const counts: Record<string, number> = {};
      // The target each of the person's threads keeps for the resume they will paste (the thread mirror's tailorTarget).
      const keptTargets = async (who: string) => {
        const rows = await pg.sql(`select coalesce(string_agg(state::text, E'\\n'), '') from public.agent_flow_state where user_id = '${who}'`);
        return [...rows.matchAll(/"tailorTarget"\s*:\s*\{(?:"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)*?"company"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
      };
      const turn = async (n: number, c: LetterCase) => {
        const who = PEOPLE[n], resume = n >= NO_RESUME;
        const before = await keptTargets(who);
        const r = await h!.chat(`tok-${n}`).say(c.input);
        counts[resume ? "resume" : "no_resume"] = (counts[resume ? "resume" : "no_resume"] ?? 0) + 1;
        const tag = `${resume ? "resume" : "no-resume"} [${c.family}] ${JSON.stringify(c.input)} -> ${r.intent}`;
        if (r.status !== 200) { failures.push(`${tag}: status ${r.status}`); return r; }
        const v = replyViolation(c.input, r.reply);
        if (v) failures.push(`${tag}: ${v}: ${r.reply.slice(0, 300)}`);
        if (!resume && r.intent === "career_tailor") {
          const m = /target is set — (.+?)\.(?:\s+(?:It|One)\b|[ \t]*\n|\s*$)/.exec(r.reply);
          if (c.expect && !(m && m[1].includes(c.expect))) failures.push(`${tag}: the named target ${c.expect} is not read back: ${r.reply.split("\n")[0]}`);
          if (!c.expect && m && /^the [A-Z]/.test(m[1])) failures.push(`${tag}: a company target with none named: ${m[0]}`);
        }
        const after = await keptTargets(who);
        counts.kept_targets = (counts.kept_targets ?? 0) + after.length - before.length;
        for (const k of after.slice(before.length)) if (!namedIn(c.input, k)) failures.push(`${tag}: the thread keeps the target ${k}, never named`);
        return r;
      };

      await t.step("the onboarding battery's turn: 'write a cover letter … I live in Boston' sets no firm", async () => {
        const r = await turn(0, { input: "write a cover letter for me. I live in Boston", expect: null, family: "bug:boston" });
        assertNode.ok(!/Boston Consulting/.test(r.reply), `trunk: "The letter's target is set — the Boston Consulting Group role.": ${r.reply}`);
        assertNode.ok(/role it is for|name the role|which role/i.test(r.reply), `no target named: the reply asks for the role: ${r.reply}`);
      });

      const sample = sampleOf(letterCases(rng(20261029 + 2), 10000), 4, PEOPLE.length - 1);
      await t.step(`no resume: ${NO_RESUME - 1} sampled asks, one person each`, async () => {
        for (let n = 1; n < NO_RESUME; n++) await turn(n, sample[n - 1]);
      });
      await t.step(`a confirmed resume: ${PEOPLE.length - NO_RESUME} sampled asks, one person each`, async () => {
        for (let n = NO_RESUME; n < PEOPLE.length; n++) {
          // Their resume, pasted and confirmed in chat (the evidenced confirm), in a thread of its own.
          const resumeChat = h!.chat(`tok-${n}`);
          const pasted = await resumeChat.say(`here is my resume:\n${RESUME}`);
          assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
          const yes = await resumeChat.say("yes, that's my resume");
          assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
          await turn(n, sample[n - 1]);
        }
      });
      console.log(`flow-scenarios-letter-target: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")} turns; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
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
