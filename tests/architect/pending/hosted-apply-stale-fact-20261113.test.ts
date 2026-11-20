// PENDING: its own work order (needs a migration). Review of #790, round 3, item 5 (2026-11-13).
// An application the person approved carries the answers and the resume it was prepared with (career_apply_jobs.payload, frozen
// under payload_hash at prepare time). Nothing on the hosted path reads the person's facts again: no hosted apply code reads
// fact_version, withdrawn_by_owner or corrected_from, the claim RPC (career_apply_claim_fair) takes every queued row, and
// reopenContradicted is skipped on agent turns (handler-career.ts, `out.handler !== "agent"`). So after the person says a fact is
// out of date (code sets it aside) or corrects it (correct_profile_fact), an approved application that states that fact can still
// be claimed and sent. This test drives the real handler on a real Postgres and fails today: the approved row is still queued.
// Design (smallest fix; a migration, so not in this PR):
//   - one SQL function, career_apply_stop_stale_facts(p_user uuid, p_values text[], p_reason text), modelled on
//     career_resume_stop_unbound (20261026120018): in one transaction, career_apply_jobs rows of that person in state 'queued' with
//     attempts = 0 whose payload->'answers' holds one of the values become 'cancelled' (reason 'fact_changed'), and
//     career_apply_prepared rows in 'ready' or 'shown' are discarded; rows already 'driving' are returned as being_sent;
//   - called from the brain turn when result.set_aside is non-empty or a correct_profile_fact call succeeded
//     (handler-career.ts, after agentTurn; the reply says what was stopped, as replacedResumeLines does for a resume);
//   - the race with a claim in flight is closed in the claim RPC, not the worker: career_apply_claim_fair skips a row whose
//     user has a fact_changed stop newer than the row's approval (a column career_apply_jobs.facts_at set at prepare, compared
//     with a per-person career_account facts_changed_at stamp).
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/hosted-apply-stale-fact-20261113.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, supabaseParity } from "../../flow/handler.ts";
import { anthropicWire } from "../helpers/anthropic_wire.ts";

const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("../../../evals/mirror/instinct-wa-batch1/persona.json", import.meta.url)));
const WHO = "7b0f8f8e-6a43-4a49-9d2c-00000b0d0c01";
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("no", { status: 404 });
  return anthropicWire(req, async (body: any) => new Response(JSON.stringify({ id: "f", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Okay." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } }));
};

Deno.test({ name: "an application approved before a fact was set aside is not handed to the worker with that fact", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg(), realFetch = globalThis.fetch;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${WHO}', '${WHO}@example.test'); insert into public.profiles (id) values ('${WHO}'); insert into public.career_watch_kv (user_id, key, value) values ('${WHO}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-not-a-key"); globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, { "tok-s": WHO });
    const chat = handler.chat("tok-s");
    await chat.say(PERSONA.setup[0]); await chat.say(PERSONA.setup[1]);
    // An application they approved, whose answers state the GPA.
    // Seeded past the resume guard (the pasted resume has no stored file; the guard is not what this test is about).
    await pg.sql(`set session_replication_role = replica; insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
      values ('${WHO}', 'greenhouse:acme:1', 'Acme', 'https://boards.greenhouse.io/acme/jobs/1', '{"answers":[{"label":"GPA","value":"3.9"}]}', repeat('b', 64), repeat('b', 64), 'queued', now()); set session_replication_role = origin;`);
    const said = await chat.say("the 3.9 gpa is outdated");
    assertNode.ok(/Set aside, not deleted[^\n]*GPA: 3\.9/.test(String(said.reply)), `the fact was set aside: ${said.reply}`);
    // career_apply_claim_fair hands the worker every row still 'queued' with attempts = 0: the row must have left that state.
    const state = (await pg.sql(`select state from public.career_apply_jobs where user_id = '${WHO}'`)).trim();
    assertNode.notEqual(state, "queued", "the approved application stating GPA 3.9 is still queued for the worker after the person set that fact aside");
  } finally { handler?.restore(); globalThis.fetch = realFetch; await pg.stop(); }
} });
