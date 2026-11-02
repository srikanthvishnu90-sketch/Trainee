// RESEARCH, COMPANY ANSWERS AND INTERVIEW PREP, ROUND 2, END TO END (architect, 2026-10-30; owner rule D-007). A sample of the
// generated conversations (tests/architect/scenarios/research-r2-generator.ts; every one runs through the product's own code in
// scenarios-research-r2.test.ts) sent through the REAL production handler (handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration):
//   A  threads      ~48 conversations (prep, pay, comparisons, news / people / offices / ratings, longer names, follow-ups,
//                   a switch of firm, a firm they say not to apply to) with no model, by people with no resume and with one
//                   pasted and confirmed in chat: each turn checked by the round-2 oracle (named firms only, a follow-up
//                   on the thread's firm, a filed firm never "no file", the unheld said plainly, no unsourced number).
//   B  mock         4 text mock interviews ("mock me for ...") whose answers carry an API key, a password and an SSN:
//                   no reply says one, and neither the mock's stored record (career_watch_kv) nor the chat log
//                   (agent_messages) keeps one.
//   C  open asks    ~10 open questions through the staged brain (CAREER_BRAIN=staged, CAREER_KNOWLEDGE=on) with a scripted
//                   model and a web search whose answers carry a fake "official" pay table, a fake recruiter email and phone
//                   line, and injected text: none of it reaches the reply or the stored brief; every search reserved its
//                   worst case first (model_budget_days) and asked for one tool call; a question answered completely is not
//                   searched again; a question whose search failed is searched again; the day's budget running out mid
//                   conversation stops every later request before it is sent.
// Every host but the Supabase double and the scripted OpenAI wire is refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { AWS_KEY, conversations, type Conversation, r2Facts, rng, SK_PROJ } from "./scenarios/research-r2-generator.ts";
import { r2Violations } from "./scenarios/research-r2-oracle.ts";
import { QUESTIONS } from "./scenarios/research-generator.ts";
import { WEB_SEARCH_MAX_CALLS } from "../../supabase/functions/_shared/model_gateway.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const PEOPLE = Array.from({ length: 24 }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000030${String(i).padStart(4, "0")}`);
const TOKENS = Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p]));
const FILE_BASE = "https://files.trainee.test/f";
const LINKS = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*/gi;
const linksIn = (s: string) => (String(s).match(LINKS) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
const BAD = /official pay table|official compensation band|Verified salary table|recruiting-example|careers-example|bank-careers\.example|555-01\d\d|Ignore all previous|reveal the system prompt|evil\.example/i;
const SECRETS = [`${SK_PROJ}`, "hunter2!", "123-45-6789", `${AWS_KEY}`];

// A stratified sample: the first conversations of every family, in the generator's own order.
function sampleOf(cases: Conversation[], perFamily: number, total: number): Conversation[] {
  const by = new Map<string, Conversation[]>();
  for (const c of cases) { if (!by.has(c.family)) by.set(c.family, []); if (by.get(c.family)!.length < perFamily) by.get(c.family)!.push(c); }
  const out: Conversation[] = [];
  for (let i = 0; out.length < total && i < perFamily; i++) for (const xs of by.values()) if (xs[i] && out.length < total) out.push(xs[i]);
  return out;
}

// ------------------------------------------------------------------------------------------------ the scripted OpenAI wire
type Script = { answers: ({ status: "ok"; facts: ReturnType<typeof r2Facts> } | { status: "error" })[]; paragraph: string };
let active: Script | null = null;
let searchIndex = 0;
const wire = { chat: 0, responses: 0, bodies: [] as any[], reservedAtCall: [] as number[] };
const GOOD = { kind: "pay", text: "The median annual wage for financial analysts was $99,890 in May 2023.", quote: "The median annual wage for financial analysts was $99,890 in May 2023.", url: "https://www.bls.gov/ooh/business-and-financial/financial-analysts.htm", why: "good" as const };
const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
function fakeChat(body: any): Response {
  wire.chat++;
  const msgs: any[] = body.messages ?? [];
  const system = String(msgs.find((m) => m.role === "system")?.content ?? "");
  const user = String(msgs.filter((m) => m.role === "user").pop()?.content ?? "");
  const results = msgs.filter((m) => m.role === "tool");
  if (/You name the occupation/.test(system)) return completion(body, { role: "assistant", content: JSON.stringify({ field: "unknown" }) });
  if (/Rewrite the paragraph/.test(system)) return completion(body, { role: "assistant", content: "Right now the realistic step is a base: coursework and a first small-firm internship. Later the larger programs open. This week, message one alum for a short call. The full plan is in the file." });
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  if (!results.length && tools.includes("research_career_question")) {
    return completion(body, { role: "assistant", content: null, tool_calls: [{ id: `call-r-${wire.chat}`, type: "function", function: { name: "research_career_question", arguments: JSON.stringify({ question: user.slice(0, 300) }) } }] });
  }
  return completion(body, { role: "assistant", content: active?.paragraph ?? "I can't help with that." });
}
function fakeResponses(body: any): Response {
  wire.responses++;
  wire.bodies.push(body);
  const a = active?.answers[searchIndex++] ?? { status: "ok", facts: [GOOD] };
  if (a.status === "error") return new Response(JSON.stringify({ error: { message: "scripted outage" } }), { status: 500, headers: { "content-type": "application/json" } });
  const kinds = String(body.input).match(/"kind":"([^"]+)"/)?.[1].split("|") ?? ["pay"];
  const facts = a.facts.map((f) => ({ kind: kinds.includes(f.kind) ? f.kind : kinds[0], text: f.text, quote: f.quote, url: f.url }));
  const output = [{ type: "web_search_call", action: { type: "search", sources: [...new Set(a.facts.map((f) => f.url))].map((url) => ({ url })) } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts }), annotations: [] }] }];
  return Response.json({ output, usage: { input_tokens: 1500, output_tokens: 200 } });
}

Deno.test({
  name: "research round 2 through the real handler on real Postgres: threads, a mock with secrets, adversarial searches, the cache and the budget",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL",
      "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);`);
      h = await careerHandler(pg, TOKENS);
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.pathname === "/v1/moderations" || (await req.clone().text()).includes("TRAINEE_CRISIS_SCREEN")) return Response.json({ id: "screen", model: "screen", results: [{ flagged: false, categories: {} }], choices: [{ index: 0, message: { role: "assistant", content: "NO" }, finish_reason: "stop" }], content: [{ type: "text", text: "NO" }], stop_reason: "end_turn", usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 } }); // #354: the crisis screen's moderation and classifier calls, not counted (architect OK 2026-11-02)
        if (u.host === "api.openai.com") {
          const body = await req.json().catch(() => ({}));
          if (/\/responses$/.test(u.pathname)) {
            wire.reservedAtCall.push(Number((await pg.sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`)).trim()));
            return fakeResponses(body);
          }
          return fakeChat(body);
        }
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      const say = async (c: Chat, m: string): Promise<Turn> => { await pg.sql(`delete from public.agent_rate_limits`); const r = await c.say(m); assertNode.equal(r.status, 200, `${m}: ${r.reply}`); return r; };
      const failures: string[] = [];
      const counts: Record<string, number> = {};
      const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

      // ------------------------------------------------------------------------------------------ A: threads, no model
      await t.step("A. ~48 conversations, no model: the round-2 oracle on every turn", async () => {
        for (let n = 8; n < 12; n++) {
          const c = h!.chat(`tok-${n}`);
          const pasted = await say(c, `here is my resume:\n${RESUME}`);
          assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
          const yes = await say(c, "yes, that's my resume");
          assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        }
        const sample = sampleOf(conversations(rng(20261030 + 7), 4000), 2, 48);
        for (const [i, conv] of sample.entries()) {
          const n = i % 12, resume = n >= 8;
          // each conversation in its own thread (a fresh chat for the person: a new thread id)
          const c = h!.chat(`tok-${n}`);
          bump(resume ? "A_resume_conversations" : "A_no_resume_conversations");
          for (const [k, turn] of conv.turns.entries()) {
            const r = await say(c, turn.text);
            bump("A_turns");
            const said = conv.turns.slice(0, k + 1).map((x) => x.text);
            for (const v of r2Violations(said, turn, r.reply, String(r.intent))) failures.push(`A ${resume ? "resume" : "no-resume"} [${conv.family}] ${JSON.stringify(said)} -> ${r.intent}: ${v} | ${r.reply.slice(0, 200)}`);
          }
        }
        assertNode.equal(wire.chat + wire.responses, 0, "no model, no search");
      });

      // ------------------------------------------------------------------------------------------ B: the mock, with secrets
      await t.step("B. 4 text mocks whose answers carry a key, a password and an SSN: none said, none kept", async () => {
        const starts = ["mock me for software engineer at Stripe", "start a mock interview for data analyst", "mock me for investment banking analyst at Goldman Sachs", "mock me for consultant at Acme Robotics"];
        const answers = [
          `At my internship I stored our deploy key ${SK_PROJ} in the repo by mistake, then rotated it and cut leaks by 40%.`,
          "I built a SQL dashboard for 3 teams and my password is hunter2! so I could share it.",
          "My SSN is 123-45-6789 and I cut the report runtime from 10 minutes to 2 minutes with an index.",
          `I shipped a config change with the AWS key ${AWS_KEY} and measured 25% faster loads after.`,
          "I led 4 classmates to ship a scheduling app a week early; I wrote the API and the tests.",
          "I disagreed with my manager about a metric, wrote a one-page memo with the data, and we changed the target.",
        ];
        for (const [i, s0] of starts.entries()) {
          const who = 12 + i, c = h!.chat(`tok-${who}`);
          const replies: string[] = [];
          const st = await say(c, s0);
          bump("B_turns");
          replies.push(st.reply);
          if (st.intent !== "career_mock") { failures.push(`B ${s0}: not a mock (${st.intent}): ${st.reply.slice(0, 160)}`); continue; }
          for (const a of answers) { const r = await say(c, a); bump("B_turns"); replies.push(r.reply); if (r.intent !== "career_mock") break; }
          for (const r of replies) for (const x of SECRETS) if (r.includes(x)) failures.push(`B ${s0}: the reply says ${x}: ${r.slice(0, 200)}`);
          const kept = (await pg.sql(`select coalesce(string_agg(value::text, ' '), '') from public.career_watch_kv where user_id = '${PEOPLE[who]}' and key like 'career:mock:%'`)).trim();
          for (const x of SECRETS) if (kept.includes(x)) failures.push(`B ${s0}: the mock's record keeps ${x}`);
          if (/Acme Robotics/.test(s0) && !/No record for Acme Robotics/.test(st.reply)) failures.push(`B ${s0}: no word that Acme Robotics has no record: ${st.reply.slice(0, 200)}`);
        }
        // The chat's own log: a pasted key is removed at the door like a password (trunk kept 8 of them word for word).
        const logged = (await pg.sql(`select count(*) from public.agent_messages where content like '%${SK_PROJ}%' or content like '%${AWS_KEY}%' or content like '%123-45-6789%' or content like '%hunter2!%'`)).trim();
        if (logged !== "0") failures.push(`B: ${logged} chat messages keep a pasted key, password or SSN`);
      });

      // ------------------------------------------------------------------------------------------ C: open questions, staged brain
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("CAREER_KNOWLEDGE", "on");
      Deno.env.set("OPENAI_API_KEY", "sk-test-not-real");
      Deno.env.set("CAREER_MODEL", "gpt-5-mini");
      Deno.env.set("TRAINEE_FILE_BASE_URL", FILE_BASE);
      Deno.env.set("TRAINEE_FILE_LINK_SECRET", "test-file-link-secret-0123456789abcdef");
      const openReservations = async () => Number((await pg.sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`)).trim());
      const briefsOf = async (who: string) => (await pg.sql(`select coalesce(string_agg(value::text, ' '), '') from public.career_watch_kv where user_id = '${who}' and value::text like '%research_brief%'`)).trim();
      const ask = async (who: number, message: string, script: Script, tag: string) => {
        active = script; searchIndex = 0;
        const before = { responses: wire.responses, bodies: wire.bodies.length };
        const r = await say(h!.chat(`tok-${who}`), message);
        bump("C_turns");
        const made = wire.responses - before.responses;
        bump("C_searches", made);
        for (const u of linksIn(r.reply)) if (!u.startsWith(`${FILE_BASE}?t=`)) failures.push(`C ${tag}: the reply links ${u}`);
        if (BAD.test(r.reply)) failures.push(`C ${tag}: adversarial text in the reply: ${(r.reply.match(BAD) ?? [""])[0]}`);
        for (const b of wire.bodies.slice(before.bodies)) if (!(Number(b.max_tool_calls) >= 1 && Number(b.max_tool_calls) <= WEB_SEARCH_MAX_CALLS)) failures.push(`C ${tag}: max_tool_calls ${b.max_tool_calls}`);
        for (const x of wire.reservedAtCall.slice(before.bodies)) if (!(x > 0)) failures.push(`C ${tag}: a search went out with nothing reserved`);
        const open = await openReservations();
        if (open !== 0) failures.push(`C ${tag}: ${open} micro-USD left reserved after the turn`);
        return { r, made };
      };
      await t.step("C. open questions over adversarial searches: nothing adversarial kept, cached when complete, searched again when failed, nothing past the budget", async () => {
        const r = rng(20261030 + 8);
        const qs = [...new Set(QUESTIONS)];
        // 1. adversarial searches, one question each
        for (let i = 0; i < 8; i++) {
          const who = 16 + (i % 4);
          const script: Script = { answers: [0, 1, 2, 3].map(() => ({ status: "ok" as const, facts: [GOOD, ...r2Facts(r)] })), paragraph: "Right now the realistic step is a base: coursework and a first small-firm internship. Later the larger programs open. This week, message one alum for a short call. The full plan is in the file." };
          const { r: res } = await ask(who, qs[i], script, `#${i} ${qs[i]}`);
          const stored = await briefsOf(PEOPLE[who]);
          if (BAD.test(stored)) failures.push(`C #${i}: adversarial text in the stored brief: ${(stored.match(BAD) ?? [""])[0]}`);
          if (res.body?.meta?.brain === "staged" && !(res.body?.meta?.tool_calls ?? []).some((x: any) => x.name === "research_career_question")) failures.push(`C #${i}: the research tool was not called`);
        }
        // 2. the same question again (answered completely above): no search
        {
          const { made } = await ask(20, qs[0], { answers: [], paragraph: "The full plan is in the file." }, `repeat ${qs[0]}`);
          if (made) failures.push(`C repeat ${qs[0]}: ${made} searches with the answer on file`);
        }
        // 3. a question whose searches fail, then asked again: searched again (a failed answer is never cached)
        {
          const q = qs[9];
          const first = await ask(21, q, { answers: [{ status: "error" }, { status: "error" }, { status: "error" }, { status: "error" }], paragraph: "I couldn't verify current data. This week, message one alum." }, `failed ${q}`);
          const again = await ask(21, q, { answers: [0, 1, 2, 3].map(() => ({ status: "ok" as const, facts: [GOOD] })), paragraph: "The full plan is in the file." }, `retried ${q}`);
          bump("C_failed_then_retried");
          if (first.made === 0) failures.push(`C failed ${q}: no search was tried`);
          if (again.made === 0) failures.push(`C retried ${q}: the failed answer was reused instead of searching again`);
        }
        // 4. the day's budget runs out mid-conversation: a little room left, then none; nothing is sent past it
        {
          await pg.sql(`update public.model_budget_days set limit_micros = spent_micros + reserved_micros + 1`);
          const n0 = wire.chat + wire.responses;
          const { r: res } = await ask(22, qs[10], { answers: [0, 1, 2, 3].map(() => ({ status: "ok" as const, facts: [GOOD] })), paragraph: "The full plan is in the file." }, `over budget ${qs[10]}`);
          if (wire.chat + wire.responses !== n0) failures.push(`C over budget: ${wire.chat + wire.responses - n0} OpenAI requests past the day's budget`);
          for (const u of linksIn(res.reply)) failures.push(`C over budget: the reply links ${u}`);
          const n1 = wire.chat + wire.responses;
          await ask(23, qs[11], { answers: [], paragraph: "" }, `over budget again ${qs[11]}`);
          if (wire.chat + wire.responses !== n1) failures.push(`C over budget again: ${wire.chat + wire.responses - n1} OpenAI requests`);
        }
      });

      console.log(`flow-scenarios-research-r2: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; OpenAI chat requests ${wire.chat}, searches ${wire.responses}; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
      assertNode.deepEqual(outbound, [], "no network");
      assertNode.deepEqual(failures, [], failures.join("\n"));
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
