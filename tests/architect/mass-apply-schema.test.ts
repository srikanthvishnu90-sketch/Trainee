// MASS APPLY (2026-11-01): the form's shape from Greenhouse's public board API, no browser, cached; Lever and Ashby (whose
// public APIs publish no application questions) and any failed read fall back to the browser (null). Measured against the
// fixture board (tests/helpers/ats_world.ts), beside the browser dry run's 11.6 s per posting (flow-mass-apply-telegram).
import assertNode from "node:assert/strict";
import { postingSchema, schemaCache, schemaUrlFor } from "../../supabase/functions/_shared/posting_schema.ts";
import { AUTH_Q, atsWorld, type Posting } from "../helpers/ats_world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);

Deno.test("Greenhouse: every question from the board API, once per TTL; Lever/Ashby and failures: the browser", async () => {
  const ps: Posting[] = [
    { family: "greenhouse", board: "acme", id: "5000001", company: "TEST Acme", title: "Frontend Engineering Intern", extraQuestion: true },
    { family: "lever", board: "beta", id: "1c3b0e00-0000-4000-8000-000000000002", company: "TEST Beta", title: "Frontend Engineering Intern" },
    { family: "ashby", board: "gamma", id: "2c3b0e00-0000-4000-8000-000000000003", company: "TEST Gamma", title: "Frontend Engineering Intern" },
  ];
  const w = atsWorld(ps);
  try {
    const api = w.origin("greenhouse");
    eq(schemaUrlFor("https://boards.greenhouse.io/acme/jobs/5000001"), "https://boards-api.greenhouse.io/v1/boards/acme/jobs/5000001?questions=true");
    let gets = 0;
    const f = (u: string, i?: RequestInit) => { gets++; return fetch(u, i); };
    const cache = schemaCache();
    const t0 = performance.now();
    const s = await postingSchema(w.urlOf(ps[0]), { fetch: f, cache, greenhouseApi: api });
    const ms = performance.now() - t0;
    assert(s, "read");
    const names = s!.fields.map((x) => x.name);
    for (const n of ["first_name", "last_name", "email", "phone", "resume", "question_4100001", "question_4100002", "question_4100009"]) assert(names.includes(n), n);
    const auth = s!.fields.find((x) => x.label === AUTH_Q)!;
    eq([auth.required, auth.options.map((o) => o.label)], [true, ["Yes", "No"]]);
    eq(s!.fields.find((x) => x.name === "resume_text")!.required, false, "the paste-instead box is not a second required resume");
    await postingSchema(w.urlOf(ps[0]), { fetch: f, cache, greenhouseApi: api });
    eq(gets, 1, "cached: one GET per posting per TTL");
    eq(await postingSchema(w.urlOf(ps[1]), { fetch: f, cache, greenhouseApi: api }), null);
    eq(await postingSchema(w.urlOf(ps[2]), { fetch: f, cache, greenhouseApi: api }), null);
    eq(await postingSchema(`${api}/acme/jobs/9999999`, { fetch: f, cache, greenhouseApi: api }), null, "a posting the API does not know: the browser");
    console.log(`MEASURED: Greenhouse form schema from the board API in ${ms.toFixed(1)} ms (browser dry run: 11.6 s per posting)`);
  } finally { await w.close(); }
});

// Wired (prepare-ahead.ts prepareOne): with the board's published form, the shared facts it needs and the person has not
// given are asked with NO browser pass (fact:* questions only); once they are known, the browser reads the form as before.
import { prepareOne } from "../../workers/career-browser/prepare-ahead.ts";
Deno.test("prepareOne: missing shared facts asked from the schema with no browser; known facts: the browser runs", async () => {
  const schema = { fields: [
    { name: "first_name", label: "First Name", required: true, type: "input_text", options: [] },
    { name: "email", label: "Email", required: true, type: "input_text", options: [] },
    { name: "resume", label: "Resume/CV", required: true, type: "input_file", options: [] },
    { name: "question_9", label: "Why do you want to work here?", required: true, type: "textarea", options: [] },
  ] };
  const run = async (answers: any[]) => {
    const calls: { name: string; args: any }[] = [];
    let engineRuns = 0;
    const db = { rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_answers_for") return { data: answers, error: null };
      if (name === "career_apply_prepare_ask_for") return { data: args.p_questions.length, error: null };
      return { data: null, error: null };
    } };
    const out = await prepareOne({ db, runEngine: async () => { engineRuns++; return null; }, resumeFor: async () => ({ path: "/dev/null", sha256: "a".repeat(64), tag: null }),
      schemaFor: async () => schema } as any, { user_id: "u", job_id: "greenhouse:acme:1", company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1", epoch: 0, version: 0 } as any);
    return { out, calls, engineRuns };
  };
  const a = await run([]);
  eq([a.out.outcome, a.engineRuns], ["asked", 0]);
  const asked = a.calls.find((c) => c.name === "career_apply_prepare_ask_for")!.args.p_questions.map((q: any) => q.key).sort();
  eq(asked, ["fact:email", "fact:first_name"], "only shared facts; the essay is left to the browser's read");
  const b = await run([{ id: "1", key: "fact:first_name", kind: "fact", answer: "Alex" }, { id: "2", key: "fact:email", kind: "fact", answer: "a@example.test" }]);
  eq(b.engineRuns, 1, "facts known: the browser reads the form");
  assert(!b.calls.some((c) => c.name === "career_apply_prepare_ask_for" && c.args.p_questions.some((q: any) => /^fact:/.test(q.key))), "nothing asked twice");
});
