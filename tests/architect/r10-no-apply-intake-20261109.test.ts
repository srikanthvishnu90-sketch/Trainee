// R10 WO-A, the architect's priority additions (2026-11-09, from the acceptance replay on trunk):
//   apply/1  SAFETY: resume T3 ("That's the wrong role … Don't apply to anything.") and F.2a ("Let's leave the job search for
//            now. What's Stripe like …") through the REAL handler (tests/flow: Postgres, the PostgREST double, the fake model):
//            nothing on the apply list, no application, no card, and no apply run kept on the thread. On trunk both put a
//            batch on the thread ("0/1 applications ready for your yes").
//   intake/1 fix 3: a resume's labelled lines ("Skills: …", "Certifications: …", "Interests: …"), with no heading of their
//            own, were filed as 3 experience entries; under a heading, as skills named "Skills: Python". Each is now its own
//            kind (skill, certification, interest), none is experience, and the resume file prints them under their labels.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { CareerProfile, CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { buildResume, targetOf } from "../../supabase/functions/_shared/career_resume_task.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = (await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`)).split("\n").slice(5).join("\n");
const T3 = "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything.";
const F2A = "Let's leave the job search for now. What's Stripe like to work for as a data analyst intern? Give me a useful company research answer: what its business does, what an analyst might work on, any concerns to investigate, and 5 good questions to ask in an interview. Use real sources and distinguish facts from your interpretation. Don't apply or contact anyone.";
const P = ["7b0f8f8e-6a43-4a49-9d2c-0000010c0001", "7b0f8f8e-6a43-4a49-9d2c-0000010c0002"];
const POSTINGS = [["reddit", "reddit", "Ads Conversion Modeling, Machine Learning Engineering Manager", "San Francisco, CA"], ["stripe", "Stripe", "Data Analyst Intern", "Chicago, IL"]];

Deno.test({
  name: "apply/1 'don't apply' and 'leave the job search' (resume T3, F.2a) queue, prepare and keep nothing, through the real handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_MODEL", "CAREER_PLANNER", "CAREER_TAILOR_REWRITE", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    try {
      await supabaseParity(pg);
      const ids = P.map((p) => `('${p}')`).join(",");
      await pg.sql(`insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${ids}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${ids}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${ids}) v(id);
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${POSTINGS.map(([b, c, t, l], i) => `('greenhouse:${b}:${i + 1}', 'greenhouse', '${b}', '${c}', '${t}', '${l}', 'https://boards.greenhouse.io/${b}/jobs/${i + 1}', 'Requirements: SQL', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${POSTINGS.map(([b, c, t, l], i) => `('greenhouse:${b}:${i + 1}', 'greenhouse', '${b}', '${c}', '${t}', '${l}', 'https://boards.greenhouse.io/${b}/jobs/${i + 1}', now(), 'Requirements: SQL', 'r10na${i}')`).join(",")};`);
      h = await careerHandler(pg, { "tok-a": P[0], "tok-b": P[1] });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        // deno-lint-ignore no-explicit-any
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => new Response(JSON.stringify({ id: "chatcmpl-test", model: chat.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } }));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(u.host); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      Deno.env.set("ANTHROPIC_API_KEY", ["sk", "test", "fake"].join("-"));
      const nothing = async (who: string, what: string) => {
        for (const table of ["career_apply_wanted", "career_apply_jobs", "career_apply_cards", "career_send_queue", "career_outreach_drafts"]) {
          assertNode.equal(await pg.sql(`select count(*) from public.${table} where user_id = '${who}'`), "0", `${what}: nothing in ${table}`);
        }
        const run = await pg.sql(`select count(*) from public.agent_flow_state where user_id = '${who}' and state->'career'->'stores' ? 'batchApplyState'`);
        assertNode.equal(run, "0", `${what}: no apply run kept on the thread`);
      };
      const run = async (tok: string, who: string, list: string, ask: string) => {
        const chat = h!.chat(tok);
        for (const m of [`here is my resume:\n${RESUME}`, "yes, that's my resume", list, ask]) {
          await pg.sql(`delete from public.agent_rate_limits where user_id = '${who}'`);
          const r = await chat.say(m);
          assertNode.equal(r.status, 200, r.reply);
          if (m === ask) {
            assertNode.ok(!/applications ready|haven't started that batch|apply list:|queued/i.test(r.reply) || /haven't applied/.test(r.reply), `${ask.slice(0, 40)}: no apply or batch reply: ${r.reply}`);
            assertNode.ok(!["career_batch_apply", "career_apply_queue"].includes(String(r.intent)), `${ask.slice(0, 40)}: not an apply turn: ${r.intent}`);
            console.log(`${ask.slice(0, 50)} -> [${r.intent}] ${r.reply.slice(0, 160)}`);
          }
        }
        await nothing(who, ask.slice(0, 40));
      };
      await run("tok-a", P[0], "find machine learning jobs", T3);
      await run("tok-b", P[1], "find data analyst jobs", F2A);
      assertNode.deepEqual(outbound, [], "no network");
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});

const LABELLED = `EDUCATION
State University (TEST) - B.S. Economics, May 2027

EXPERIENCE
Analyst Intern, Acme (TEST), June 2025 - August 2025
- Built a Python screening workflow across 100+ targets
Founder, Lemonade Co (TEST), 2023 - 2024
- Ran a weekend stand for two summers
Skills: Python, SQL, Excel
Certifications: Bloomberg Market Concepts (TEST)
Interests: Coding, Golf`;

Deno.test("intake/1 labelled skills, certifications and interests are their own kinds, never experience; the file prints them under their labels", () => {
  for (const [what, text] of [["no heading", LABELLED], ["one heading", LABELLED.replace("Skills: Python", "SKILLS & CERTIFICATIONS\nSkills: Python")]] as const) {
    const p = CareerProfile.createProfile({});
    CareerProfile.ingestResume(p, { text, fileName: "intake.txt" });
    const of = (k: string) => p.facts.filter((f: { kind: string }) => f.kind === k).map((f: { title?: string; name?: string }) => f.name || f.title);
    assertNode.deepEqual(of("experience").length, 2, `${what}: the two roles only: ${JSON.stringify(of("experience"))}`);
    assertNode.deepEqual(of("skill"), ["Python", "SQL", "Excel"], `${what}: skills by name, no label`);
    assertNode.deepEqual(of("certification"), ["Bloomberg Market Concepts (TEST)"], what);
    assertNode.deepEqual(p.facts.filter((f: { text?: string }) => /^Interest: /.test(f.text || "")).map((f: { name: string }) => f.name), ["Coding", "Golf"], what);
    for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
    const lines = buildResume(p, targetOf("for data analyst internships")!, false).blocks.map((b) => `${b.label ?? ""}${b.text}`);
    assertNode.ok(lines.includes("Technical:Python, SQL, Excel") && lines.includes("Certifications:Bloomberg Market Concepts (TEST)") && lines.includes("Interests:Coding, Golf"), `${what}: ${JSON.stringify(lines)}`);
    assertNode.ok(!lines.some((l) => /^Skills?: (Skills|Interests)/.test(l)), what);
  }
  const ctx: { now: number; thread: Record<string, unknown> } = { now: Date.UTC(2026, 10, 9), thread: {} };
  const shown = CareerRouter.handleChat(`here is my resume:\n${LABELLED}`, ctx).reply;
  assertNode.ok(/\(1 education, 2 experience, 3 skill, 1 certification, 2 interest\)/.test(shown), `the counts the person reads: ${shown}`);
});
