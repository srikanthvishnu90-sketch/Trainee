// RESEARCH AND COMPANY ANSWERS END TO END (architect, 2026-10-29; owner rule D-007). A sample of the generated scenarios
// (tests/architect/scenarios/research-generator.ts; every one runs through the product's own code in
// scenarios-research.test.ts) sent through the REAL production handler (handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration):
//   A  company asks   ~64 intel, prep, networking, figure and timeline asks (no model: CAREER_BRAIN and OPENAI_API_KEY unset),
//                     by people with no resume and with one pasted and confirmed in chat: every firm a reply is about was
//                     named as a whole name; every number is in a source the product holds; a figure the file does not
//                     hold is said plainly not to be on record; no network.
//   B  open questions ~20 open career questions through the staged brain (CAREER_BRAIN=staged, CAREER_KNOWLEDGE=on) with a
//                     scripted model on the OpenAI wire: the brain calls research_career_question, the web search answers
//                     on the Responses wire with good and adversarial facts (invented numbers, fabricated URLs, injected
//                     instructions, claims about the person, secrets, links in a fact's words), and the chat paragraph may
//                     invent a figure, write its own link or follow an injection. The reply carries only the file link
//                     code minted; the stored brief (career_watch_kv) holds only the search's own source URLs and nothing
//                     injected; every search reserved its worst case in the day's budget (model_budget_days) before the
//                     call, asked for at most one tool call, and the day holds no open reservation after the turn; a
//                     question whose answer is already on file makes no search at all.
//   C  over budget    the day's budget used up: no request reaches OpenAI at all, and the reply says so plainly.
// Every host but the Supabase double and the scripted OpenAI wire is refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { askCases, type AskCase, INJECTIONS, PERSON_CLAIMS, researchCases, type ResearchCase, rng, SECRETS } from "./scenarios/research-generator.ts";
import { turnViolations } from "./scenarios/research-oracle.ts";
import { WEB_SEARCH_MAX_CALLS } from "../../supabase/functions/_shared/model_gateway.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const PEOPLE = Array.from({ length: 16 }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000019${String(i).padStart(4, "0")}`);
const TOKENS = Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p]));
const FILE_BASE = "https://files.trainee.test/f";
const LINKS = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|\b(?:javascript|data|vbscript|mailto|file):[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*/gi;
const linksIn = (s: string) => (String(s).match(LINKS) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
const numbersOf = (t: string): string[] => [...(String(t).replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? [])];
const BAD_TEXT = [...INJECTIONS, ...PERSON_CLAIMS, ...SECRETS].map((x) => x.slice(0, 30));

// A stratified sample: a few of every family, in the generator's own order.
function sampleOf(cases: AskCase[], perFamily: number, total: number): AskCase[] {
  const by = new Map<string, AskCase[]>();
  for (const c of cases) { const k = c.family.split(":").slice(0, 2).join(":"); if (!by.has(k)) by.set(k, []); if (by.get(k)!.length < perFamily) by.get(k)!.push(c); }
  const out: AskCase[] = [];
  for (let i = 0; out.length < total && i < perFamily; i++) for (const xs of by.values()) if (xs[i] && out.length < total) out.push(xs[i]);
  return out;
}

// ------------------------------------------------------------------------------------------------ the scripted OpenAI wire
let active: ResearchCase | null = null;
const wire = { chat: 0, responses: 0, searchCalls: 0, bodies: [] as any[], reservedAtCall: [] as number[], returned: new Set<string>() };
let searchIndex = 0;
const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
function fakeChat(body: any): Response {
  wire.chat++;
  const msgs: any[] = body.messages ?? [];
  const system = String(msgs.find((m) => m.role === "system")?.content ?? "");
  const user = String(msgs.filter((m) => m.role === "user").pop()?.content ?? "");
  const results = msgs.filter((m) => m.role === "tool");
  if (/You name the occupation/.test(system)) return completion(body, { role: "assistant", content: JSON.stringify({ field: "unknown" }) });
  if (/Rewrite the paragraph/.test(system)) return completion(body, { role: "assistant", content: active?.paragraph2 ?? "" });
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  if (!results.length && tools.includes("research_career_question")) {
    return completion(body, { role: "assistant", content: null, tool_calls: [{ id: `call-r-${wire.chat}`, type: "function", function: { name: "research_career_question", arguments: JSON.stringify({ question: user.slice(0, 300) }) } }] });
  }
  return completion(body, { role: "assistant", content: active?.paragraph ?? "I can't help with that." });
}
function fakeResponses(body: any): Response {
  wire.responses++;
  wire.bodies.push(body);
  const a = active?.answers[searchIndex++] ?? { status: "ok", facts: [], urls: [] };
  if (a.status === "error") return new Response(JSON.stringify({ error: { message: "scripted outage" } }), { status: 500, headers: { "content-type": "application/json" } });
  if (a.status === "blocked") return new Response(JSON.stringify({ error: { message: "scripted rate limit" } }), { status: 429, headers: { "content-type": "application/json" } });
  wire.searchCalls++;
  for (const u of a.urls) wire.returned.add(u);
  const output = [{ type: "web_search_call", action: { type: "search", sources: a.urls.map((url) => ({ url })) } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts: a.facts.map((f) => ({ kind: f.kind, text: f.text, quote: f.quote, url: f.url })) }), annotations: [] }] }];
  return Response.json({ output, usage: { input_tokens: 1500, output_tokens: 200 } });
}

Deno.test({
  name: "research and company answers through the real handler on real Postgres: only named firms, only sourced facts and links, the search budget held",
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
      const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

      // ------------------------------------------------------------------------------------------ A: company asks, no model
      await t.step("A. ~64 company asks, no model: only named firms, only sourced numbers, a missing figure said plainly", async () => {
        const sample = sampleOf(askCases(rng(20261029 + 7), 5000), 3, 64);
        // their resume, pasted and confirmed in chat, for the last four people of this step
        for (let n = 8; n < 12; n++) {
          const c = h!.chat(`tok-${n}`);
          const pasted = await say(c, `here is my resume:\n${RESUME}`);
          assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
          const yes = await say(c, "yes, that's my resume");
          assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        }
        for (const [i, c] of sample.entries()) {
          const n = i % 12, resume = n >= 8;
          const r = await say(h!.chat(`tok-${n}`), c.input);
          bump(resume ? "A_resume" : "A_no_resume");
          for (const v of turnViolations(c, r.reply, String(r.intent))) failures.push(`A ${resume ? "resume" : "no-resume"} [${c.family}] ${JSON.stringify(c.input)} -> ${r.intent}: ${v} | ${r.reply.slice(0, 200)}`);
        }
        assertNode.equal(wire.chat + wire.responses, 0, "no model, no search");
      });

      // ------------------------------------------------------------------------------------------ B: open questions, staged brain
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("CAREER_KNOWLEDGE", "on");
      Deno.env.set("OPENAI_API_KEY", "sk-test-not-real");
      Deno.env.set("CAREER_MODEL", "gpt-5-mini");
      Deno.env.set("TRAINEE_FILE_BASE_URL", FILE_BASE);
      Deno.env.set("TRAINEE_FILE_LINK_SECRET", "test-file-link-secret-0123456789abcdef");
      const openReservations = async () => Number((await pg.sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`)).trim());
      // The briefs filed for a person, by key: a turn's own brief is the one its turn added.
      const briefsOf = async (who: string) => new Map<string, string>(JSON.parse((await pg.sql(`select coalesce(json_agg(json_build_array(key, value::text)), '[]') from public.career_watch_kv where user_id = '${who}' and value::text like '%research_brief%'`)).trim() || "[]"));
      await t.step("B. ~20 open questions through the staged brain: code's file link only, the brief holds only the search's sources and nothing injected, every search reserved first", async () => {
        // one case per question in the generator's list (each question is its own cache key), then a repeat
        const all = researchCases(rng(20261029 + 8), 600);
        const seen = new Set<string>(), cases: ResearchCase[] = [];
        for (const c of all) if (!seen.has(c.message) && c.answers.some((a) => a.status === "ok" && a.facts.some((f) => f.why === "good"))) { seen.add(c.message); cases.push(c); }
        for (const c of all) if (cases.length < 20 && !cases.includes(c) && /p[1-6]$/.test(c.family)) cases.push(c);
        const onFile: ResearchCase[] = [];
        for (const [i, c] of cases.entries()) {
          active = c; searchIndex = 0;
          const who = PEOPLE[12 + (i % 3)];
          const before = { responses: wire.responses, bodies: wire.bodies.length, briefs: await briefsOf(who) };
          const r = await say(h!.chat(`tok-${12 + (i % 3)}`), c.message);
          bump("B_turns");
          const tag = `B [${c.family}] ${JSON.stringify(c.message)} -> ${r.intent}`;
          if (r.body?.meta?.brain !== "staged") {
            // A question the staged release keeps on the router (its library answer): no link, nothing injected.
            bump("B_router");
            for (const u of linksIn(r.reply)) failures.push(`${tag}: the router's reply links ${u}`);
            if (wire.responses !== before.responses) failures.push(`${tag}: searched although the router answered`);
            continue;
          }
          const used = (r.body?.meta?.tool_calls ?? []).map((x: any) => x.name);
          if (!used.includes("research_career_question")) failures.push(`${tag}: the research tool was not called (${used.join(",")})`);
          // links: only the file link code minted
          for (const u of linksIn(r.reply)) if (!u.startsWith(`${FILE_BASE}?t=`)) failures.push(`${tag}: the reply links ${u}`);
          for (const b of BAD_TEXT) if (r.reply.includes(b)) failures.push(`${tag}: injected text in the reply: ${b}`);
          if (/guaranteed|wire the deposit|Lazard|Moelis/.test(r.reply)) failures.push(`${tag}: an unsourced claim in the reply: ${r.reply}`);
          const good = c.answers.flatMap((a) => a.facts).filter((f) => f.why === "good" || f.why === "utm_url");
          const support = [...good.flatMap((f) => [f.text, f.quote]), c.message].join(" ");
          const extra = numbersOf(r.reply.replace(/https:\/\/\S+/g, "")).filter((n) => !numbersOf(support).includes(n));
          if (extra.length) failures.push(`${tag}: numbers no source gave: ${extra.join(", ")} | ${r.reply}`);
          // the stored brief: only the search's own source URLs, nothing injected or secret
          // (a cached answer carries the sources an earlier search returned: every search's own URLs count)
          const stored = [...(await briefsOf(who))].filter(([k]) => !before.briefs.has(k)).map(([, v]) => v).join("\n");
          if (r.reply.includes(FILE_BASE) && !stored) failures.push(`${tag}: a file link with no brief filed`);
          for (const u of linksIn(stored)) if (!wire.returned.has(u) && !u.startsWith(FILE_BASE)) failures.push(`${tag}: the stored brief links ${u}`);
          // an answer now on file: every search answered and at least one sourced fact kept (the brief cites a source)
          if (wire.responses - before.responses > 0 && c.answers.every((a) => a.status === "ok") && linksIn(stored).some((u) => wire.returned.has(u))) onFile.push(c);
          for (const b of BAD_TEXT) if (stored.includes(b.replace(/"/g, '\\"'))) failures.push(`${tag}: injected text in the stored brief: ${b}`);
          // every search: at most one tool call, reserved before the call, nothing left open after the turn
          for (const b of wire.bodies.slice(before.bodies)) if (!(Number(b.max_tool_calls) >= 1 && Number(b.max_tool_calls) <= WEB_SEARCH_MAX_CALLS)) failures.push(`${tag}: max_tool_calls ${b.max_tool_calls}`);
          for (const x of wire.reservedAtCall.slice(before.bodies)) if (!(x > 0)) failures.push(`${tag}: a search went out with nothing reserved`);
          const open = await openReservations();
          if (open !== 0) failures.push(`${tag}: ${open} micro-USD left reserved after the turn`);
          counts.B_searches = (counts.B_searches ?? 0) + (wire.responses - before.responses);
        }
        // the same question again: the answer is on file, so no search at all
        assertNode.ok(onFile.length > 0, "at least one answer was filed from a complete search");
        const again = onFile[0];
        active = again; searchIndex = 0;
        const n0 = wire.responses;
        const r = await say(h!.chat("tok-15"), again.message);
        if (wire.responses !== n0) failures.push(`B repeat ${JSON.stringify(again.message)}: ${wire.responses - n0} searches with the answer already on file`);
        if (r.body?.meta?.brain === "staged" && linksIn(r.reply).some((u) => !u.startsWith(`${FILE_BASE}?t=`))) failures.push(`B repeat: links ${linksIn(r.reply).join(", ")}`);
        bump("B_repeat");
      });

      // ------------------------------------------------------------------------------------------ C: over budget
      await t.step("C. the day's budget used up: no request reaches OpenAI, and the reply says so plainly", async () => {
        await pg.sql(`update public.model_budget_days set limit_micros = spent_micros + reserved_micros`);
        active = researchCases(rng(20261029 + 9), 1)[0]; searchIndex = 0;
        const n0 = wire.chat + wire.responses;
        const r = await say(h!.chat("tok-15"), "how do I get hired as a nurse?");
        bump("C_turns");
        if (wire.chat + wire.responses !== n0) failures.push(`C: ${wire.chat + wire.responses - n0} OpenAI requests over the day's budget`);
        for (const u of linksIn(r.reply)) failures.push(`C: the reply links ${u}`);
        for (const b of BAD_TEXT) if (r.reply.includes(b)) failures.push(`C: injected text: ${b}`);
      });

      console.log(`flow-scenarios-research: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; OpenAI chat requests ${wire.chat}, searches ${wire.responses}; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
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
