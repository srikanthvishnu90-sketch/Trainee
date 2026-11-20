// ROUTER ROUTING ROUND, END TO END (architect, 2026-11-02; D-007). A small sample of tests/architect/scenarios-router-routes.test.ts
// sent through the REAL production handler (handler-career.ts handleChat; harness tests/flow/handler.ts: real supabase-js over
// tests/flow/postgrest.ts, real Postgres 16 with every migration), because two fixes reach the handler's own wiring: the role
// search after the router (career_search_judge.ts askFor) and the staged brain's decision (career_staged.ts codeProduct).
//   A  no model: a role search at a named employer lists that employer's postings only (never the look-alike), never as a
//      people search; "who works at People Inc." is the networking turn's; nothing is sent, approved or queued.
//   B  the staged brain with a scripted model: "what does Applebee's pay?" (no company file) reaches the brain; "tell me
//      about Applebee's" stays the router's honest no-file answer, with no model call.
// Every host but the Supabase double and the scripted Anthropic wire is refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const PEOPLE = Array.from({ length: 12 }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000044${String(i).padStart(4, "0")}`);
const TOKENS = Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p]));
const lit = (s: string) => `$q$${s}$q$`;
const BOARD = [
  { id: "greenhouse:rr:apple", company: "Apple", title: "Data Analyst", location: "Cupertino, CA", text: "Retail analytics. SQL and Python." },
  { id: "greenhouse:rr:applebees", company: "Applebee's", title: "Data Analyst", location: "Kansas City, MO", text: "Restaurant analytics. SQL and Python. Pay: $28/hr." },
  { id: "greenhouse:rr:jobber", company: "Jobber", title: "Marketing Coordinator", location: "Edmonton, AB", text: "Campaigns for home-service businesses." },
];
const wire = { chat: 0 };
const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-rr", model: body.model, choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 40 } });
function fakeChat(body: any): Response {
  wire.chat++;
  return completion(body, { role: "assistant", content: "I can't confirm Applebee's pay from a source I can read right now." });
}

Deno.test({
  name: "router routing round through the real handler on real Postgres: searches at a named employer, people, and pay questions to the brain",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL",
      "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL", "CAREER_NETWORKING_DRAFT", "CAREER_PEOPLE_SEARCH", "STRIPE_SECRET_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${BOARD.map((b) => `(${lit(b.id)}, 'greenhouse', 'rr', ${lit(b.company)}, ${lit(b.title)}, ${lit(b.location)}, ${lit(`https://boards.greenhouse.io/rr/jobs/${b.id.split(":")[2]}`)}, ${lit(b.text)}, now() - interval '2 days', now())`).join(",\n")};`);
      h = await careerHandler(pg, TOKENS);
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeChat(chat));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      const failures: string[] = [];
      const n = async (sql: string) => Number(await pg.sql(sql));
      const effects = async () => ({
        send: await n(`select count(*) from public.career_send_queue`),
        approvedDrafts: await n(`select count(*) from public.career_outreach_drafts where approved_hash is not null`),
        jobs: await n(`select count(*) from public.career_apply_jobs`),
        wanted: await n(`select count(*) from public.career_apply_wanted`),
      });
      const zero = await effects();
      let tok = 0;
      const say = async (m: string) => { await pg.sql(`delete from public.agent_rate_limits`); const r = await h!.chat(`tok-${tok++}`).say(m); if (r.status !== 200) failures.push(`${m}: HTTP ${r.status}`); return r; };
      const named = (reply: string, co: string) => new RegExp(`(?<![\\p{L}\\p{N}])${co.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}'])`, "u").test(reply);

      await t.step("A. no model: a search at a named employer is that employer's postings, never a people search", async () => {
        for (const [m, co, never] of [["find me data analyst roles at Applebee's", "Applebee's", "Apple"], ["any data analyst openings at Applebee's?", "Applebee's", "Apple"],
          ["data analyst roles at Apple", "Apple", "Applebee's"]] as const) {
          const r = await say(m);
          if (/^career_people_|^career_networking_/.test(String(r.intent))) failures.push(`A ${m}: a people search (${r.intent}) | ${r.reply.slice(0, 200)}`);
          if (!named(r.reply, co)) failures.push(`A ${m}: ${co}'s posting not named (${r.intent}) | ${r.reply.slice(0, 300)}`);
          if (named(r.reply, never)) failures.push(`A ${m}: named the look-alike ${never} | ${r.reply.slice(0, 300)}`);
        }
        const p = await say("who works at People Inc.");
        if (!/^career_people_|^career_networking_|^career_contacts_/.test(String(p.intent))) failures.push(`A who works at People Inc.: ${p.intent} | ${p.reply.slice(0, 200)}`);
        if (/who work/i.test(p.reply)) failures.push(`A who works at People Inc.: searched the title "who work" | ${p.reply.slice(0, 200)}`);
      });

      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      await t.step("B. staged brain: a pay question at a firm with no file reaches the brain; another no-file question stays the router's", async () => {
        const before = wire.chat;
        const pay = await say("what does Applebee's pay?");
        if (wire.chat === before) failures.push(`B pay: the model was never called (${pay.intent}) | ${pay.reply.slice(0, 200)}`);
        if (/has no company file yet/.test(pay.reply)) failures.push(`B pay: stopped at the no-file answer | ${pay.reply.slice(0, 200)}`);
        const mid = wire.chat;
        const about = await say("tell me about Applebee's");
        // Architect amendment (D-061): G1 and G14 with web research on (D-060): a question about a firm is the brain's research turn,
        // with the router's no-file answer as data; nothing about the firm comes from the model unsourced (enforceCompanyReply).
        if (wire.chat === mid) failures.push(`B about: a company question was not the brain's research turn (${about.intent}) | ${about.reply.slice(0, 200)}`);
      });

      assertNode.deepStrictEqual(failures, [], failures.join("\n"));
      assertNode.deepStrictEqual(await effects(), zero, "nothing sent, approved, submitted or queued");
      assertNode.deepStrictEqual(outbound.filter((o) => !/^GET (?:boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com|boards\.greenhouse\.io|jobs\.lever\.co)$/.test(o)), [], "no request left but a board read");
    } finally {
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
