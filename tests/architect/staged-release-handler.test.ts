// D-035 (owner, 2026-11-01: "Ship staged brain"), at the REAL handler (handleChat) on real Postgres, with CAREER_BRAIN
// UNSET: the committed release brain (staged) as production deploys it. A scripted model answers at the Anthropic URL and
// counts the brain's requests (a request that offers tools is the brain's). What code still owns, proven turn by turn:
//   J  "judge prompt: ..." is saved by code (career_search_judge.ts), never sent to the brain.
//   K  with no model key configured the brain is never tried: the router answers, the model is never called.
//   S  an apply ask on Indeed or LinkedIn is refused by code before the brain; nothing is queued.
//   C  "yes" on a prepared-applications card approves through code, each application under the exact payload hash the
//      card showed; the brain is never asked.
//   P  CAREER_PLANNER=on: crisis text with two asks gets code's 988 reply before the planner (no model call, nothing queued,
//      no reminder kept); with no model key the planner is never tried (no request, no cost row, no planner log).
//   A control: an advice question with the key set does reach the brain (so the zero counts above mean something).
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/staged-release-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { crisisReply } from "../../supabase/functions/agent-chat/crisis.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
// architect amendment E.21 (2026-11-10): a search's posting-page checks are held to helpers/posting_checks.ts (no board listing, at most N for the N shown, never over 10); every other off-machine request is still a fault.
import { postingChecks } from "./helpers/posting_checks.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const RESUME_FILE = "%PDF-1.4\n% TEST staged-release resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const PEOPLE: Record<string, string> = {
  "tok-d35j": "7b0f8f8e-6a43-4a49-9d2c-0000000d3501", "tok-d35k": "7b0f8f8e-6a43-4a49-9d2c-0000000d3502",
  "tok-d35s": "7b0f8f8e-6a43-4a49-9d2c-0000000d3503", "tok-d35c": "7b0f8f8e-6a43-4a49-9d2c-0000000d3504",
  "tok-d35a": "7b0f8f8e-6a43-4a49-9d2c-0000000d3505", "tok-d35p": "7b0f8f8e-6a43-4a49-9d2c-0000000d3506",
  "tok-d35q": "7b0f8f8e-6a43-4a49-9d2c-0000000d3507",
};
const P = (t: string) => PEOPLE[t];
const ADVICE = "how should I follow up after an interview?";
const BRAIN_ANSWER = "Send a short thank-you note within a day, then one polite follow-up if their date passes.";
const POSTINGS = [["alpha", "Alpha Works"], ["bravo", "Bravo Labs"]]
  .map(([board, company], i) => ({ key: `greenhouse:${board}:${i + 1}`, board, company, url: `https://boards.greenhouse.io/${board}/jobs/${i + 1}` }));

let modelCalls = 0, brainCalls = 0;
function fakeModel(body: any): Response {
  modelCalls++;
  if (Array.isArray(body.tools) && body.tools.length) brainCalls++;
  const text = Array.isArray(body.tools) && body.tools.length ? BRAIN_ANSWER : "Subject: Hello\n\nHi there,\n\nWould you be open to a short call?";
  return Response.json({ id: "chatcmpl-d035", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
}

Deno.test({ name: "D-035: with CAREER_BRAIN unset (staged), code keeps judge prompts, site refusals and card approvals; no key means no brain", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_KNOWLEDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_JUDGE", "CAREER_PREPARE_AHEAD_URL",
    "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "CAREER_SEND_RAIL", "CAREER_PLANNER", "CAREER_PLANNER_USERS"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const k of keys) Deno.env.delete(k); // CAREER_BRAIN unset: the release brain, staged
  const withKey = () => { Deno.env.set("ANTHROPIC_API_KEY", "sk-test-d035-not-real"); Deno.env.set("CAREER_MODEL", "claude-haiku-5-5"); };
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
      ${POSTINGS.map((p, i) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', 'Data Analyst', 'Chicago, IL', '${p.url}', now() - interval '${i} hours', '${desc}', 'd35${i}')`).join(",")};`);
    h = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch, outbound: string[] = [], checks = postingChecks();
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
      if (checks.take(req.method, req.url)) throw new TypeError(`network refused: ${u.host}`);
      if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
      return await viaDouble(req);
    }) as typeof fetch;
    const sayAs = (c: Chat, id: string) => async (m: string): Promise<Turn> => {
      await pg.sql(`delete from public.agent_rate_limits where user_id = '${id}'`);
      const r = await checks.turn(m, () => c.say(m), (t) => t.reply); eq(r.status, 200, `${m}: ${r.reply}`);
      return r;
    };

    await t.step("J: 'judge prompt: ...' is saved by code, never sent to the brain", async () => {
      withKey();
      const say = sayAs(h!.chat("tok-d35j"), P("tok-d35j")), b = brainCalls;
      const r = await say("judge prompt: remote roles with a real mentor matter most to me");
      eq([r.intent, r.body.meta.brain], ["career_judge_prompt", undefined], r.reply);
      const shown = await say("what's my judge prompt?");
      eq(shown.intent, "career_judge_prompt", shown.reply);
      assert(/real mentor/.test(shown.reply), `the instruction was saved by code: ${shown.reply}`);
      eq(brainCalls, b, "the brain was never asked");
    });

    await t.step("K: no model key configured: the router answers, the model is never called", async () => {
      Deno.env.delete("ANTHROPIC_API_KEY");
      const say = sayAs(h!.chat("tok-d35k"), P("tok-d35k")), n = modelCalls;
      // The brain path, even when its model call fails before any request, logs its fallback: it must not be entered.
      const realError = console.error, logged: string[] = [];
      console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      try {
        for (const m of [ADVICE, "I'm so overwhelmed with all of this", "hello"]) {
          const r = await say(m);
          eq(r.body.meta.brain, undefined, `${m}: ${r.reply}`);
          assert(r.reply && r.reply !== BRAIN_ANSWER, `${m}: the router's reply`);
        }
      } finally { console.error = realError; }
      eq(modelCalls, n, "no model request at all");
      eq(logged.filter((l) => /agent brain/.test(l)), [], "the brain path was never tried");
    });

    await t.step("S: Indeed and LinkedIn apply asks are refused by code before the brain; nothing queued", async () => {
      withKey();
      const say = sayAs(h!.chat("tok-d35s"), P("tok-d35s")), b = brainCalls;
      for (const [m, site] of [["apply to jobs on Indeed for me", "Indeed"], ["apply to jobs on LinkedIn for me", "LinkedIn"],
        ["apply to this job for me https://www.indeed.com/viewjob?jk=abc", "Indeed"], ["apply me to https://www.linkedin.com/jobs/view/12345", "LinkedIn"]]) {
        const r = await say(m);
        eq([r.intent, r.resultStatus, r.body.meta.brain], [site === "LinkedIn" ? "career_linkedin_refused" : "career_site_refused", "refused", undefined], `${m}: ${r.reply}`);
        assert(r.reply.includes(site), `${m}: names ${site}: ${r.reply}`);
      }
      eq(brainCalls, b, "the brain was never asked");
      eq(await pg.sql(`select count(*) from public.career_apply_wanted where user_id = '${P("tok-d35s")}'`), "0", "nothing queued");
      eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P("tok-d35s")}'`), "0", "nothing approved");
    });

    await t.step("C: 'yes' on the prepared-applications card approves through code, by the exact payload hash; never the brain", async () => {
      withKey();
      const id = P("tok-d35c"), say = sayAs(h!.chat("tok-d35c"), id), b = brainCalls;
      eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
      const conf = await say("yes, that's my resume");
      eq([conf.intent, conf.resultStatus], ["career_resume_ingest", "completed"], conf.reply);
      await pg.sql(confirmedResumeSql(id, RESUME_FILE));
      eq((await say("find data analyst jobs in Chicago")).intent, "career_discovery");
      const q = await say("apply to these");
      eq([q.intent, q.resultStatus], ["career_apply_queue", "queued"], q.reply);
      // Their computer prepares each queued posting (the extension's career_apply_prepare_own; the database hashes it).
      for (const p of POSTINGS) {
        const payload = { version: 1, user_id: id, job_id: p.key, company: p.company, url: p.url,
          fields: [{ name: "email", label: "Email", value: "alex.testcase@example.test", factId: "TEST-D035-1" }], privacy_epoch: 0, account_version: 0,
          expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
        const r = await pg.asPerson(id).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`${p.company}: Data Analyst`, "Email: alex.testcase@example.test"] });
        eq(r.error, null, `setup: prepare ${p.company}: ${JSON.stringify(r.error)}`);
      }
      const card = await say("show my applications");
      eq([card.intent, card.resultStatus, card.body.meta.brain], ["career_apply_card", "shown", undefined], card.reply);
      const yes = await say("yes");
      eq([yes.intent, yes.resultStatus, yes.body.meta.brain], ["career_apply_card_answer", "answered", undefined], yes.reply);
      const jobs = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('company', company, 'state', state) order by company), '[]') from public.career_apply_jobs where user_id = '${id}'`));
      eq(jobs, POSTINGS.map((p) => ({ company: p.company, state: "queued" })), "exactly the card's applications");
      eq(await pg.sql(`select coalesce(bool_and(j.approval_hash = j.payload_hash and j.payload_hash = p.payload_hash), false) from public.career_apply_jobs j
        join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id where j.user_id = '${id}'`), "t", "each approved under the hash the card carried");
      eq(brainCalls, b, "the brain was never asked");
    });

    await t.step("P: CAREER_PLANNER=on: crisis text with two asks gets code's 988 reply before the planner; the model is never called", async () => {
      withKey(); Deno.env.set("CAREER_PLANNER", "on");
      try {
        const id = P("tok-d35p"), say = sayAs(h!.chat("tok-d35p"), id), n = modelCalls;
        const m = "I don't want to live anymore. Apply to the Alpha Works Data Analyst role and remind me Friday to prep";
        const r = await say(m);
        eq([r.reply, r.intent, r.body.meta.brain], [crisisReply(m), "safety_support", undefined], r.reply);
        assert(/\b988\b/.test(r.reply), r.reply);
        eq(modelCalls, n, "no model call: not the planner, not the brain");
        for (const tbl of ["career_apply_wanted", "career_apply_jobs"]) eq(await pg.sql(`select count(*) from public.${tbl} where user_id = '${id}'`), "0", `nothing in ${tbl}`);
        eq(await pg.sql(`select count(*) from public.career_watch_kv where user_id = '${id}' and key = 'career:reminders'`), "0", "no reminder kept");
        eq(await pg.sql(`select count(*) from public.career_outbox where user_id = '${id}'`), "0", "nothing queued to send");
      } finally { Deno.env.delete("CAREER_PLANNER"); }
    });

    await t.step("P: CAREER_PLANNER=on with no model key: the planner is never tried; no request, no cost row with a call", async () => {
      Deno.env.delete("ANTHROPIC_API_KEY"); Deno.env.set("CAREER_PLANNER", "on");
      const realLog = console.log, realError = console.error, logged: string[] = [];
      console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      try {
        const id = P("tok-d35q"), n = modelCalls;
        await sayAs(h!.chat("tok-d35q"), id)("find data analyst jobs in Chicago and remind me Friday to prep");
        eq(modelCalls, n, "no model request");
        eq(logged.filter((l) => /planner|agent brain/.test(l)), [], "neither the planner nor the brain was tried");
        eq(await pg.sql(`select count(*) from public.agent_turn_costs where user_id = '${id}' and coalesce(calls, 1) > 0`), "0", "no cost row with a call");
      } finally { console.log = realLog; console.error = realError; Deno.env.delete("CAREER_PLANNER"); }
    });

    await t.step("control: with the key set, an advice question does reach the staged brain", async () => {
      withKey();
      const b = brainCalls;
      const r = await sayAs(h!.chat("tok-d35a"), P("tok-d35a"))(ADVICE);
      eq([r.reply, r.body.meta.brain], [BRAIN_ANSWER, "staged"]);
      eq(brainCalls, b + 1);
    });
    eq(outbound, [], "no network beyond the double and the scripted model");
    eq(checks.faults, [], "a search checks at most the postings it shows, each on its own page");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
