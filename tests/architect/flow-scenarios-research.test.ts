// RESEARCH AND COMPANY ANSWERS END TO END (architect, 2026-10-29; owner rule D-007). A sample of the generated scenarios
// (tests/architect/scenarios/research-generator.ts; every one runs through the product's own code in
// scenarios-research.test.ts) sent through the REAL production handler (handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration):
//   A  company asks   ~64 intel, prep, networking, figure and timeline asks (no model: CAREER_BRAIN and ANTHROPIC_API_KEY unset),
//                     by people with no resume and with one pasted and confirmed in chat: every firm a reply is about was
//                     named as a whole name; every number is in a source the product holds; a figure the file does not
//                     hold is said plainly not to be on record; no network.
//   B  open questions ~20 open career questions through the staged brain (CAREER_BRAIN=staged, CAREER_KNOWLEDGE=on) with a
//                     scripted model on the Anthropic Messages wire. Research ships DARK (owner directive 2026-11-02: Claude-only,
//                     Claude web search not verified): the brain is not offered research_career_question, no search request
//                     goes anywhere, the reply carries no link, nothing injected, and no budget is reserved.
//   C  over budget    the day's budget used up: no request reaches the model at all, and the reply says so plainly.
// Every host but the Supabase double and the scripted Anthropic wire is refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { askCases, type AskCase, INJECTIONS, PERSON_CLAIMS, researchCases, type ResearchCase, rng, SECRETS } from "./scenarios/research-generator.ts";
import { turnViolations } from "./scenarios/research-oracle.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

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

// ------------------------------------------------------------------------------------------------ the scripted Anthropic wire
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
Deno.test({
  name: "research and company answers through the real handler on real Postgres: only named firms, only sourced facts and links, the search budget held",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL",
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
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeChat(chat));
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
      // Architect amendment (D-060; owner, 2026-11-11, "Web research"): research is ON in production, measured through the real
      // handler in tests/architect/web-research-d060.test.ts. "Research dark" is now its rollback, CAREER_KNOWLEDGE=off, and this
      // step holds the rollback to the same bars.
      Deno.env.set("CAREER_KNOWLEDGE", "off");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      Deno.env.set("TRAINEE_FILE_BASE_URL", FILE_BASE);
      Deno.env.set("TRAINEE_FILE_LINK_SECRET", "test-file-link-secret-0123456789abcdef");
      const openReservations = async () => Number((await pg.sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`)).trim());
      // The briefs filed for a person, by key: a turn's own brief is the one its turn added.
      const briefsOf = async (who: string) => new Map<string, string>(JSON.parse((await pg.sql(`select coalesce(json_agg(json_build_array(key, value::text)), '[]') from public.career_watch_kv where user_id = '${who}' and value::text like '%research_brief%'`)).trim() || "[]"));
      await t.step("B. ~20 open questions through the staged brain, research dark: the research tool is not offered, nothing is searched or reserved, no link and nothing injected", async () => {
        const all = researchCases(rng(20261029 + 8), 600);
        const seen = new Set<string>(), cases: ResearchCase[] = [];
        for (const c of all) if (!seen.has(c.message) && cases.length < 20) { seen.add(c.message); cases.push(c); }
        for (const [i, c] of cases.entries()) {
          active = c; searchIndex = 0;
          const r = await say(h!.chat(`tok-${12 + (i % 3)}`), c.message);
          bump("B_turns");
          const tag = `B [${c.family}] ${JSON.stringify(c.message)} -> ${r.intent}`;
          const used = (r.body?.meta?.tool_calls ?? []).map((x: any) => x.name);
          if (used.includes("research_career_question")) failures.push(`${tag}: the dark research tool was called`);
          for (const u of linksIn(r.reply)) if (!u.startsWith(`${FILE_BASE}?t=`)) failures.push(`${tag}: the reply links ${u}`);
          for (const b of BAD_TEXT) if (r.reply.includes(b)) failures.push(`${tag}: injected text in the reply: ${b}`);
          const open = await openReservations();
          if (open !== 0) failures.push(`${tag}: ${open} micro-USD left reserved after the turn`);
        }
        assertNode.equal(wire.responses + wire.searchCalls, 0, "no search request while research is dark");
      });

      // ------------------------------------------------------------------------------------------ C: over budget
      await t.step("C. the day's budget used up: no request reaches the model, and the reply says so plainly", async () => {
        await pg.sql(`update public.model_budget_days set limit_micros = spent_micros + reserved_micros`);
        active = researchCases(rng(20261029 + 9), 1)[0]; searchIndex = 0;
        const n0 = wire.chat + wire.responses;
        const r = await say(h!.chat("tok-15"), "how do I get hired as a nurse?");
        bump("C_turns");
        if (wire.chat + wire.responses !== n0) failures.push(`C: ${wire.chat + wire.responses - n0} model requests over the day's budget`);
        for (const u of linksIn(r.reply)) failures.push(`C: the reply links ${u}`);
        for (const b of BAD_TEXT) if (r.reply.includes(b)) failures.push(`C: injected text: ${b}`);
      });

      console.log(`flow-scenarios-research: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; model chat requests ${wire.chat}, searches ${wire.responses}; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
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
