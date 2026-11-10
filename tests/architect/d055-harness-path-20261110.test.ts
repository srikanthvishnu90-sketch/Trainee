// D-055 (builder, 2026-11-10): the three cases the real-model re-measure still failed five of five (brain-eval run 42897333579,
// set evals/career/d054-items-7-9.json, branch ag/d054-fixes@2e8f5302) although tests/architect/d054-fixes-20261110.test.ts
// passed them. That test drives CareerHost alone and the real handler; the eval drives neither: it runs evals/career/run.ts
// makeBrain (handleInbound, the staged decision, CareerHost, the in-memory stores and the item's seeded postings). Every test
// here drives THAT path, with a scripted model where the model would answer: $0, no network.
//   R05 the router answered from its own empty pool: the harness skipped the handler's search step (FEATURE 5: askFor and
//       searchJudgeTurn over the live board), so "actually remote only" never listed the seeded remote role. The harness now
//       runs that step (evals/career/harness.ts searchStep); the corrected reply says what the correction dropped.
//   M04 asked only "1 of 2: When do you graduate?" and never asked the salary; the reply now asks for both, in order, and
//       still poses one question (RESPONSE-RULES E3).
//   M09 went to the model, whose reply asked no sensitive field. With the account's own ledger read and empty, code answers:
//       nothing on file to reuse, nothing filled in, the sensitive answers asked one at a time. The harness now gives the
//       router the ledger the handler gives it (ctx.applyLedger).
//   deno test -A --no-check tests/architect/d055-harness-path-20261110.test.ts   (the handler part needs Postgres 16, not as root)
import assertNode from "node:assert/strict";
import { makeBrain } from "../../evals/career/run.ts";
import { checkReply } from "../../supabase/functions/_shared/reply_rubric.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SET = JSON.parse(await Deno.readTextFile(new URL("../../evals/career/d054-items-7-9.json", import.meta.url)));
const item = (id: string) => SET.items.find((i: any) => i.id === id);
const MODEL_MARK = "SCRIPTED MODEL REPLY";
const calls: string[] = [];
const scripted = async (p: any) => {
  const last = (p.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
  calls.push(String(last).slice(0, 120));
  return { content: [{ type: "text", text: MODEL_MARK }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
};
const brain = await makeBrain({ name: "staged", model: scripted, env: { get: (k: string) => Deno.env.get(k) } });
// One eval item as run.ts runs it: its turns, its world, a fresh person.
async function harness(id: string, turns?: string[]) {
  const it = item(id);
  return await brain(turns ?? it.turns, it);
}
const RULES = ["answers_first", "boilerplate_tail", "internal", "ends_at_decision", "leaked_instruction", "channel_length", "repeats_ask"];
const rubric = (ask: string, reply: string) =>
  checkReply({ ask, reply, channel: "telegram", timeZone: ZONE }).violations.filter((v) => RULES.includes(v.rule)).map((v) => `${v.rule}: ${v.quote ?? v.detail}`);
const ONE_QUESTION = (r: string) => (r.match(/\?/g) ?? []).length === 1 && /\?$/.test(r.trim());

Deno.test("R05 harness path: 'actually remote only' after the Chicago search keeps data analyst, drops Chicago and its onsite and hybrid roles, lists the remote one", async () => {
  const r = await harness("R05");
  const [first, last] = r.replies;
  // The first search lists the item's seeded Chicago roles (it used to say none were on the list).
  assert(/Lakefront Data/.test(first) && /Prairie Analytics/.test(first), first);
  eq(r.trace?.map((t) => [t.route, (t as any).searched === true]), [["router", true], ["router", true]], JSON.stringify(r.trace));
  assert(/^Remote only now: Chicago is dropped, so the 2 Chicago roles I listed that aren't remote are off the list\./.test(last), last);
  assert(/Northline Health/.test(last) && /remote data analyst/.test(last), `the remote role remains, the role is kept: ${last}`);
  assert(!/Lakefront|Prairie/.test(last), `no onsite or hybrid role is offered: ${last}`);
  assert(!/what role|which role|tell me the role/i.test(last), `intake is not restarted: ${last}`);
  // Only the seeded posting's link; nothing invented.
  eq([...last.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]), ["https://jobs.example.test/northline/data-analyst-i"]);
  eq(rubric(item("R05").turns[1], last).filter((v) => !v.startsWith("channel_length")), [], last);
  assert(!calls.some((c) => /remote only/.test(c)), "the model was never asked");
});

Deno.test("R05 harness path: a correction with no earlier list says only what changed", async () => {
  const r = await harness("R05", [item("R05").turns[1]]);
  assert(!/^Remote only now/.test(r.replies[0]), "no search to correct, no correction line");
});

Deno.test("M04 harness path: the citizenship fact is said back; the graduation date and the salary are both asked for, one question; nothing chosen", async () => {
  const r = await harness("M04");
  const [reply] = r.replies;
  eq(r.trace?.[0]?.route, "router");
  assert(/^I can't pick your graduation date or your expected salary for the Acme Analytics application/.test(reply), reply);
  assert(/Noted: you're a US citizen\./.test(reply), reply);
  assert(/I need both from you, one at a time: your graduation date, then your expected salary for Acme Analytics\./.test(reply), reply);
  assert(ONE_QUESTION(reply) && /1 of 2: When do you graduate\?$/.test(reply.trim()), reply);
  assert(!/\b20\d\d\b|\$\s?\d/.test(reply) && !/submitted|sent/i.test(reply), reply);
  eq(rubric(item("M04").turns[0], reply), [], reply);
  // The next answers follow, one per reply (d054-fixes keeps the rest of this flow pinned).
  const go = await harness("M04", [item("M04").turns[0], "May 2027", "$85,000"]);
  assert(/2 of 2: What salary do you expect for the Acme Analytics role\?$/.test(go.replies[1].trim()), go.replies[1]);
  assert(/\$85,000/.test(go.replies[2]) && !/\?/.test(go.replies[2]), go.replies[2]);
});

Deno.test("M09 harness path: nothing on file to reuse is said, nothing is filled in, and the sensitive answers are asked one at a time", async () => {
  const r = await harness("M09");
  const [reply] = r.replies;
  eq(r.trace?.[0]?.route, "router", "code answers it; the model is not asked");
  assert(/^There's no earlier application of yours on file, so I have no answers to reuse for the Brightwave Labs application, and I won't fill any in\./.test(reply), reply);
  assert(/your work authorization, whether you need visa sponsorship, your graduation date, then your expected salary for Brightwave Labs/.test(reply), reply);
  assert(ONE_QUESTION(reply) && /1 of 4: What is your work authorization\?$/.test(reply.trim()), reply);
  assert(!/\b20\d\d\b|\$\s?\d|citizen|submitted|prepared|\bsent\b/i.test(reply), `no answer stated for the person, nothing claimed: ${reply}`);
  eq(rubric(item("M09").turns[0], reply), [], reply);
  // The answers follow on the same list, in the person's words.
  const go = await harness("M09", [item("M09").turns[0], "I'm a US citizen", "No", "May 2027", "skip"]);
  assert(/2 of 4: Do you need visa sponsorship/.test(go.replies[1]), go.replies[1]);
  assert(/3 of 4: When do you graduate\?$/.test(go.replies[2].trim()), go.replies[2]);
  assert(/4 of 4: What salary do you expect for the Brightwave Labs role\?$/.test(go.replies[3].trim()), go.replies[3]);
  assert(/stays blank, and I won't fill it in/.test(go.replies[4]) && /nothing was chosen for you/.test(go.replies[4]), go.replies[4]);
});

// The reuse answer claims "nothing on file" only from the account's own records: with no ledger to read (CareerHost alone),
// a part of it unreadable, an application on it, or a sensitive answer already given, code says nothing and the turn goes on.
const C = core as any;
const host = (CareerHost as any).createCareerHost({ CareerAccess: C.CareerAccess, CareerOnboarding: C.CareerOnboarding, CareerRouter: C.CareerRouter, CareerDoorstep: C.CareerDoorstep, CareerReply: C.CareerReply, CareerContainment: C.CareerContainment });
function routerTurn(turns: string[], ledger: unknown) {
  let snap: unknown = null, last: any = null;
  for (const m of turns) {
    const ctx = host.createTurnCtx({ userId: "u-d055", threadId: `t-d055-${Math.random()}`, now: Date.UTC(2026, 10, 10, 15), snapshot: snap });
    if (ledger !== undefined) (ctx as any).applyLedger = ledger;
    last = host.runTurn(m, ctx);
    snap = host.extractSnapshot(ctx);
  }
  return last;
}
Deno.test("M09 router: 'nothing on file' is said only when the ledger was read, all of it, and holds nothing", () => {
  const ask = item("M09").turns[0];
  const empty = { asOf: "2026-11-10T15:00:00Z", tasks: [], receipts: [], unreadable: [] };
  eq(routerTurn([ask], empty).intent, "sensitive_answer_ask");
  for (const [why, ledger] of [
    ["no ledger", undefined],
    ["a part unreadable", { ...empty, unreadable: ["prepared"] }],
    ["an application on it", { ...empty, tasks: [{ id: "job:1", kind: "application", company: "Northline Health", state: "submitted_unconfirmed" }] }],
    ["a tracked one", { ...empty, tasks: [{ id: "track:1", kind: "tracked", company: "Acme", state: "tracked" }] }],
  ] as const) {
    const r = routerTurn([ask], ledger);
    assert(!/no earlier application of yours on file/.test(String(r.reply)), `${why}: ${r.reply}`);
  }
  // A sensitive answer already given is on file: nothing is said to be missing.
  const given = routerTurn(["I'm a US citizen", ask], empty);
  assert(!/no earlier application of yours on file/.test(String(given.reply)), given.reply);
  // Not a reuse ask.
  for (const m of ["Use the same expected salary for the Lakefront Data application", "what answers did I give on my last application?"]) {
    assert(!/no earlier application of yours on file/.test(String(routerTurn([m], empty).reply)), m);
  }
});

const POSTINGS = [
  { id: "greenhouse:d055:lakefront-data", company: "Lakefront Data", title: "Data Analyst", location: "Chicago, IL (onsite)", text: "Onsite in Chicago five days a week. SQL, Excel, Tableau." },
  { id: "greenhouse:d055:northline-health", company: "Northline Health", title: "Data Analyst I", location: "Remote (US)", text: "Fully remote within the US. SQL and Python." },
  { id: "greenhouse:d055:prairie-analytics", company: "Prairie Analytics", title: "Junior Data Analyst", location: "Chicago, IL (hybrid, 3 days onsite)", text: "Hybrid, three days a week in the Chicago office." },
];
const lit = (s: string) => `$q$${s}$q$`;

Deno.test({
  name: "through the real handler (staged brain, scripted model): R05 M04 M09 answer as the harness path does",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: D-055 handler part not run`); return; }
    const modelAsked: string[] = [];
    const wire = (chat: any) => {
      modelAsked.push(JSON.stringify(chat.messages ?? []).slice(-200));
      return Response.json({ id: "d055", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : MODEL_MARK }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const w = await openWorld(6, { model: (req) => anthropicWire(req, wire) });
    try {
      await w.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${POSTINGS.map((b) => `(${lit(b.id)}, 'greenhouse', 'd055', ${lit(b.company)}, ${lit(b.title)}, ${lit(b.location)}, ${lit(`https://boards.greenhouse.io/d055/jobs/${b.id.split(":")[2]}`)}, ${lit(b.text)}, now() - interval '1 day', now())`).join(",\n")};`);
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const transcript: string[] = [];
      const talk = async (id: string, turns: string[]) => {
        const p = await w.person();
        const out = [];
        for (const m of turns) {
          const r = await p.say(m);
          assertNode.equal(r.status, 200, m);
          transcript.push(`${id} [${r.intent}] ${m}\n  => ${r.reply.replace(/\n/g, " / ")}`);
          out.push(r);
        }
        return out;
      };
      const [, r05] = await talk("R05", item("R05").turns);
      assert(/^Remote only now: Chicago is dropped, so the \d Chicago roles? I listed that (?:aren't|isn't) remote (?:are|is) off the list\./.test(r05.reply), r05.reply);
      assert(/Northline Health/.test(r05.reply) && !/Lakefront Data|Prairie Analytics/.test(r05.reply), r05.reply);
      const [m04] = await talk("M04", item("M04").turns);
      assert(/I need both from you, one at a time: your graduation date, then your expected salary for Acme Analytics\./.test(m04.reply) && ONE_QUESTION(m04.reply), m04.reply);
      const [m09] = await talk("M09", item("M09").turns);
      eq(m09.intent, "sensitive_answer_ask", m09.reply);
      assert(/^There's no earlier application of yours on file/.test(m09.reply) && /1 of 4: What is your work authorization\?$/.test(m09.reply.trim()), m09.reply);
      assert(!m09.reply.includes(MODEL_MARK), m09.reply);
      console.log(`D-055 TRANSCRIPT\n${transcript.join("\n")}`);
      eq(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
