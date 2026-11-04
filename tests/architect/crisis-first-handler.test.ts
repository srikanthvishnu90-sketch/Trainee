// CRISIS FIRST (#406, on #354's three-layer screen) at the REAL handler (handleChat) on real Postgres, with CAREER_BRAIN
// UNSET (the staged release) and under the router rollback. Each message below is one a turn would otherwise take; each
// gets the crisis reply (988) and NOTHING that turn would have done is done: no Gmail or Outlook link, no site-refusal
// record, no card answered, no mock answer recorded, nothing queued. Outcomes are rows, read before and after.
//   paused     "pause all career work", then "I want to kill myself": the crisis reply, not "career_paused"
//   card       "yes. I want to kill myself" with a card open: the card stays open and unanswered
//   site       "apply on LinkedIn for me, I want to kill myself"
//   connector  "connect gmail, I don't want to live anymore": no Gmail link issued
//   outlook    "connect my outlook, I want to die": no Outlook link issued
//   mock       "I want to die" while a mock interview waits for an answer: no answer recorded
//   phrases    "I want to die", "stop, i want to die", "I wanna die", "I want to end it" (each a crisis, every brain)
//   idioms     "I'd rather die than miss this, yes apply", "this interview is killing me, yes", "I'd kill for this job":
//              never the crisis reply
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/crisis-first-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { crisisReply } from "../../supabase/functions/agent-chat/crisis.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const RESUME_FILE = "%PDF-1.4\n% TEST crisis-first resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const TOKENS = ["paused", "card", "site", "conn", "outlook", "mock", "phr", "idiom", "rb"];
const PEOPLE: Record<string, string> = Object.fromEntries(TOKENS.map((t, i) => [`tok-cf-${t}`, `7b0f8f8e-6a43-4a49-9d2c-0000000cf${String(i).padStart(3, "0")}`]));
const P = (t: string) => PEOPLE[`tok-cf-${t}`];
const POSTINGS = [["alpha", "Alpha Works"], ["bravo", "Bravo Labs"]]
  .map(([board, company], i) => ({ key: `greenhouse:${board}:${i + 1}`, board, company, url: `https://boards.greenhouse.io/${board}/jobs/${i + 1}` }));

let modelCalls = 0;
function fakeOpenAI(body: any): Response {
  modelCalls++;
  return Response.json({ id: "chatcmpl-cf", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "NO" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
}

Deno.test({ name: "CRISIS FIRST: crisis text gets the 988 reply before every turn that would take it, and that turn does nothing", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "CAREER_PLANNER", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_CRISIS_MODERATION", "CAREER_CRISIS_CLASSIFIER", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const k of keys) Deno.env.delete(k); // CAREER_BRAIN unset: the staged release; no model key: the word list decides
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const realFetch = globalThis.fetch;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const desc = "TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.";
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      ${POSTINGS.map((p) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', 'Data Analyst', 'Chicago, IL', '${p.url}', '${desc}', now(), now())`).join(",")};
      insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
      ${POSTINGS.map((p, i) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', 'Data Analyst', 'Chicago, IL', '${p.url}', now() - interval '${i} hours', '${desc}', 'cf${i}')`).join(",")};`);
    h = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
      if (u.origin !== new URL(SUPABASE_URL).origin) throw new TypeError(`network refused: ${u.host}`);
      return await viaDouble(req);
    }) as typeof fetch;
    const sayAs = (tok: string) => { const c: Chat = h!.chat(`tok-cf-${tok}`); return async (m: string): Promise<Turn> => {
      await pg.sql(`delete from public.agent_rate_limits where user_id = '${P(tok)}'`);
      const r = await c.say(m); eq(r.status, 200, `${m}: ${r.reply}`); return r; }; };
    // What every guarded turn could write for this person, as one snapshot (rows and their states).
    const snapshot = async (tok: string) => {
      const u = P(tok);
      return await pg.sql(`select json_build_object(
        'gmail_links', (select count(*) from public.career_connector_links where user_id = '${u}'),
        'outlook_links', (select count(*) from public.career_outlook_links where user_id = '${u}'),
        'cards', (select coalesce(json_agg(json_build_object('state', state) order by id), '[]') from public.career_apply_cards where user_id = '${u}'),
        'jobs', (select count(*) from public.career_apply_jobs where user_id = '${u}'),
        'wanted', (select count(*) from public.career_apply_wanted where user_id = '${u}'),
        'outbox', (select count(*) from public.career_outbox where user_id = '${u}'),
        'events', (select count(*) from public.career_events where user_id = '${u}' and kind <> 'fact_confirmed'),
        'mock', (select coalesce(json_agg(value order by key), '[]') from public.career_watch_kv where user_id = '${u}' and key like 'career:mock:%'))::text`);
    };
    const crisisOnly = async (tok: string, m: string) => {
      const say = sayAs(tok), before = await snapshot(tok), n = modelCalls;
      const r = await say(m);
      eq(r.intent, "safety_support", `${m}: ${r.intent}: ${r.reply}`);
      assert(/\b988\b/.test(r.reply), `${m}: ${r.reply}`);
      eq(await snapshot(tok), before, `${m}: the turn it would have gone to did nothing`);
      eq(modelCalls, n, `${m}: no model call`);
      return r;
    };

    await t.step("paused: a paused account still gets the crisis reply, not 'career_paused'", async () => {
      const say = sayAs("paused");
      eq((await say("pause all career work")).intent, "career_paused");
      await crisisOnly("paused", "I want to kill myself");
      eq((await say("how should I follow up after an interview?")).intent === "safety_support", false, "the pause still holds other turns");
    });

    await t.step("card: 'yes. I want to kill myself' with a card open: the 988 reply; the card stays open, nothing approved", async () => {
      const id = P("card"), say = sayAs("card");
      eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
      eq((await say("yes, that's my resume")).resultStatus, "completed");
      await pg.sql(confirmedResumeSql(id, RESUME_FILE));
      eq((await say("find data analyst jobs in Chicago")).intent, "career_discovery");
      eq((await say("apply to these")).resultStatus, "queued");
      for (const p of POSTINGS) {
        const payload = { version: 1, user_id: id, job_id: p.key, company: p.company, url: p.url,
          fields: [{ name: "email", label: "Email", value: "alex.testcase@example.test", factId: "TEST-CF-1" }], privacy_epoch: 0, account_version: 0,
          expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
        const r = await pg.asPerson(id).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`${p.company}: Data Analyst`, "Email: alex.testcase@example.test"] });
        eq(r.error, null, `setup: prepare ${p.company}`);
      }
      eq((await say("show my applications")).intent, "career_apply_card");
      await crisisOnly("card", "yes. I want to kill myself");
      eq(await pg.sql(`select state from public.career_apply_cards where user_id = '${id}'`), "open");
    });

    await t.step("site: 'apply on LinkedIn for me, I want to kill myself': the 988 reply; no site-refusal record", async () => {
      await crisisOnly("site", "apply on LinkedIn for me, I want to kill myself");
    });

    await t.step("connector: 'connect gmail, I don't want to live anymore': the 988 reply; no Gmail link issued", async () => {
      await crisisOnly("conn", "connect gmail, I don't want to live anymore");
    });

    await t.step("outlook: 'connect my outlook, I want to die': the 988 reply; no Outlook link issued", async () => {
      await crisisOnly("outlook", "connect my outlook, I want to die");
    });

    await t.step("mock: 'I want to die' while a mock question waits: the 988 reply; no answer recorded", async () => {
      const r = await sayAs("mock")("mock me for a data analyst interview at Northwind Ledger");
      assert(/mock/i.test(String(r.intent)), `a mock started: ${r.intent}: ${r.reply}`);
      await crisisOnly("mock", "I want to die");
    });

    await t.step("phrases: 'I want to die', 'stop, i want to die', 'I wanna die', 'I want to end it' each get the crisis reply", async () => {
      for (const m of ["I want to die", "stop, i want to die", "I wanna die", "I want to end it"]) {
        ok(crisisReply(m), m);
        await crisisOnly("phr", m);
      }
    });

    await t.step("idioms: never the crisis reply", async () => {
      const say = sayAs("idiom");
      for (const m of ["I'd rather die than miss this, yes apply", "this interview is killing me, yes", "I'd kill for this job"]) {
        eq(crisisReply(m), null, m);
        const r = await say(m);
        assert(r.intent !== "safety_support" && !/\b988\b/.test(r.reply), `${m}: ${r.intent}: ${r.reply}`);
      }
    });

    await t.step("router rollback (CAREER_BRAIN=router): the same — the crisis reply first, the card untouched", async () => {
      Deno.env.set("CAREER_BRAIN", "router");
      try {
        for (const m of ["I want to die", "connect gmail, I don't want to live anymore", "apply on LinkedIn for me, I want to kill myself"]) await crisisOnly("rb", m);
      } finally { Deno.env.delete("CAREER_BRAIN"); }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
