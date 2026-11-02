// TASK PLANNER at the REAL handler (agent-chat/handler-career.ts handleChat, unchanged harness tests/flow/handler.ts) on
// real Postgres, with a fake model on the OpenAI wire (evals/career/tasks/fake_model.ts; no key, no spend). Outcomes are
// rows, never wording.
// Fail-first: the first step runs the compound ask with the planner OFF (today's production: CAREER_BRAIN unset, and the
// staged release) and asserts what is lost: the apply part and the reminder are dropped, nothing is tailored. The same ask
// with CAREER_PLANNER=on completes every part, through the paths that already enforce the owner's rules:
//   1. "find 5 frontend internships in Chicago, tailor my resume for the best 2, apply to them and remind me Friday":
//      2 rows in the person's apply queue (the listed postings, no others), 2 tailored resumes, a reminder due Friday;
//      no application approved, no card answered, nothing on the sending rail.
//   2. "email the recruiter at Stripe and follow up in a week": one draft to the recruiter in their own contacts, waiting
//      for approval (status shown), and a reminder a week out; then "send 1" approves exactly that draft through the
//      outreach answer turn (nothing sent: the rail is off).
//   3. Guards at the handler: a plan step on LinkedIn, a step in words the person did not say, an unregistered capability:
//      each refused and named, nothing queued from it, the other parts done.
//   4. Kill switches: CAREER_BRAIN=router (and unset while the release serves the router) with CAREER_PLANNER=on,
//      CAREER_PLANNER_USERS without the person: the
//      planner's model is never called and the reply is today's, byte for byte.
//   5. A model outage: today's chain answers exactly as with the planner off.
//   6. A code-first prompt waiting for its answer (the outreach batch) is never taken by the planner.
//   7. No confirmed resume: the apply step queues nothing (the apply turn's own check), the other parts are done.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/task-planner-handler-pg.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { calls, clearOracle, fakeOpenAI, setOracle } from "../../evals/career/tasks/fake_model.ts";
import { dueDate } from "../../supabase/functions/_shared/task/plan.ts";
import { brainMode } from "../../supabase/functions/agent-chat/career_staged.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const SET = JSON.parse(await Deno.readTextFile(`${ROOT}evals/career/tasks/tasks.json`));
const CONTACTS = await Deno.readTextFile(`${ROOT}evals/career/tasks/contacts.csv`);
const FE = ["Acme", "Brite", "Cobalt", "Dune Works", "Ember Health"];
const COMPOUND = "find 5 frontend internships in Chicago, tailor my resume for the best 2, apply to them and remind me Friday";
const PLAN = SET.tasks.find((t: any) => t.id === "T01").oracle[COMPOUND];
const EMAIL = "email the recruiter at Stripe and follow up in a week";
const EMAIL_PLAN = SET.tasks.find((t: any) => t.id === "T09").oracle[EMAIL];
const people = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`tok-p${i}`, `7b0f8f8e-6a43-4a49-9d2c-0000000a${String(i).padStart(4, "0")}`]));
const q = (s: string) => s.replace(/'/g, "''");
let outage = false;

Deno.test({ name: "TASK PLANNER: compound asks complete at the real handler, through the existing paths; off, kill switches and outages leave today's chain", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const keys = ["CAREER_BRAIN", "CAREER_PLANNER", "CAREER_PLANNER_USERS", "CAREER_NETWORKING_DRAFT", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const set = (o: Record<string, string | null>) => { for (const [k, v] of Object.entries(o)) { if (v === null) Deno.env.delete(k); else Deno.env.set(k, v); } };
  try {
    await supabaseParity(pg);
    const P: any[] = SET.postings;
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      ${P.map((p) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', '${q(p.description)}', now(), now())`).join(",")};
      insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
      ${P.map((p, i) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', now() - interval '${i} hours', '${q(p.description)}', 'k${i}')`).join(",")};`);
    for (const id of Object.values(people)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    set({ OPENAI_API_KEY: "sk-fake-planner-not-a-key", MODEL_PROVIDER: null, CAREER_MODEL: "gpt-5-mini", CAREER_NETWORKING_DRAFT: "on" });
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).hostname === "api.openai.com") return outage ? new Response(JSON.stringify({ error: { type: "server_error", message: "fake outage" } }), { status: 500, headers: { "content-type": "application/json" } }) : await fakeOpenAI(req);
      return new Response("not reachable in this test", { status: 404 });
    }) as typeof fetch;
    h = await careerHandler(pg, people);
    const sql = async (s: string) => (await pg.sql(s)).trim();
    const n = async (s: string) => Number(await sql(s));
    const say = async (c: Chat, m: string, extra: Record<string, unknown> = {}) => { const r = await c.say(m, extra); eq(r.status, 200, r.reply); return r; };
    const setup = async (tok: string, o: { resume?: boolean; contacts?: boolean } = { resume: true }) => {
      set({ CAREER_BRAIN: "router", CAREER_PLANNER: null });
      const c = h!.chat(tok);
      if (o.resume) { await say(c, `here is my resume:\n${RESUME}`); await say(c, "yes, that's my resume"); }
      if (o.contacts) {
        await say(c, "here are my contacts", { attachments: [{ name: "contacts.csv", mime: "text/csv", text: CONTACTS }] });
        await pg.sql(`insert into public.career_outreach_prefs (user_id, signature) values ('${people[tok]}', 'Alex Testcase') on conflict (user_id) do update set signature = excluded.signature`);
      }
      return c;
    };
    const queued = async (tok: string) => (await sql(`select coalesce(string_agg(company, ',' order by company), '') from public.career_apply_wanted where user_id = '${people[tok]}'`)).split(",").filter(Boolean);
    const reminders = async (tok: string) => JSON.parse(await sql(`select coalesce((select value->'items' from public.career_watch_kv where user_id = '${people[tok]}' and key = 'career:reminders')::text, '[]')`)) as any[];
    const tailored = async (tok: string) => n(`select count(*) from public.channel_artifacts where user_id = '${people[tok]}' and mime = 'application/pdf'`);
    const nothingSent = async (tok: string) => {
      const u = people[tok];
      eq(await n(`select count(*) from public.career_apply_jobs where user_id = '${u}'`), 0, "no application approved or sent: only the card's tap does that");
      eq(await n(`select count(*) from public.career_apply_cards where user_id = '${u}'`), 0, "no card opened or answered by the plan");
      eq(await n(`select count(*) from public.career_send_queue where user_id = '${u}'`), 0, "nothing on the sending rail");
      eq(await n(`select count(*) from public.career_outbox where user_id = '${u}'`), 0, "nothing queued to go out on its own");
    };
    const plannerCalls = () => calls.filter((c) => c.kind === "plan").length;

    await t.step("fail-first: OFF (router, then staged), the compound ask loses its parts: nothing queued, nothing tailored, no reminder", async () => {
      for (const [tok, brain] of [["tok-p0", "router"], ["tok-p1", "staged"]] as const) {
        const c = await setup(tok);
        set({ CAREER_BRAIN: brain, CAREER_PLANNER: null });
        setOracle({ [COMPOUND]: PLAN });
        const before = plannerCalls();
        const r = await say(c, COMPOUND);
        eq(plannerCalls(), before, "the planner is never asked");
        eq([await queued(tok), await reminders(tok), await tailored(tok)], [[], [], 0], `${brain ?? "router"}: ${r.intent}: ${r.reply.slice(0, 200)}`);
        await nothingSent(tok);
      }
    });

    await t.step("ON: every part done through its own path: 2 queued from the list, 2 tailored, a reminder due Friday; nothing approved or sent", async () => {
      const tok = "tok-p2", c = await setup(tok);
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      setOracle({ [COMPOUND]: PLAN });
      const r = await say(c, COMPOUND);
      eq([r.intent, r.resultStatus], ["career_plan", "completed"], r.reply);
      const steps = r.body.meta.planner.steps.map((s: any) => `${s.capability}:${s.status}:${s.intent}`);
      eq(steps.map((s: string) => s.replace(/:career_(internship_)?discovery$/, ":search")), ["jobs.search:done:search", "resume.tailor:done:career_tailor", "apply.queue:done:career_apply_queue", "reminder.set:done:reminder_set"]);
      const q2 = await queued(tok);
      eq(q2.length, 2, q2.join(","));
      assert(q2.every((co) => FE.includes(co)), `only the listed frontend postings: ${q2}`);
      // the two queued are the two the search listed first (the thread's own list, code's record)
      const list = JSON.parse(await sql(`select (state->'career'->'stores'->'discovery'->'lastShortlist')::text from public.agent_flow_state where user_id = '${people[tok]}' order by updated_at desc limit 1`));
      eq(q2, list.slice(0, 2).map((p: any) => p.company).sort());
      eq((await reminders(tok)).map((x) => x.due_date), [dueDate("Friday", Date.now(), null)]);
      assert(await tailored(tok) >= 1 && new Set(r.body.meta.planner.steps[1].detail.tailored).size === 2, JSON.stringify(r.body.meta.planner.steps[1]));
      assert(/Not done|Not started/.test(r.reply) === false, r.reply);
      await nothingSent(tok);
    });

    await t.step("ON: email the recruiter and follow up: one draft waiting for approval, a reminder a week out; 'send 1' approves exactly it", async () => {
      const tok = "tok-p3", c = await setup(tok, { resume: true, contacts: true });
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      setOracle({ [EMAIL]: EMAIL_PLAN });
      const r = await say(c, EMAIL);
      eq(r.intent, "career_outreach_batch", "the batch is the thread's last word, so the next text answers it");
      eq(await sql(`select string_agg(recipient_email || ':' || status, ',') from public.career_outreach_drafts where user_id = '${people[tok]}'`), "maya.chen@stripe.example:shown");
      eq((await reminders(tok)).map((x) => x.due_date), [dueDate("in a week", Date.now(), null)]);
      await nothingSent(tok);
      const before = plannerCalls();
      const yes = await say(c, "send 1");
      eq(plannerCalls(), before, "the answer is the outreach turn's, never the planner's");
      eq(await sql(`select string_agg(recipient_email || ':' || status, ',') from public.career_outreach_drafts where user_id = '${people[tok]}'`), "maya.chen@stripe.example:approved", yes.reply);
      eq(await n(`select count(*) from public.career_send_queue where user_id = '${people[tok]}'`), 0, "approved, not sent: the rail is off");
    });

    await t.step("guards at the handler: LinkedIn, words the person did not say, an unregistered capability: refused and named; the other part done", async () => {
      const tok = "tok-p4", c = await setup(tok);
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      const m = "find data analyst jobs in Chicago and apply to the top one and remind me Friday";
      setOracle({ [m]: [
        { capability: "jobs.search", text: "find data analyst jobs in Chicago" },
        { capability: "apply.queue", text: "apply to the top one on linkedin.com/jobs", args: { picks: [1] } },
        { capability: "apply.queue", text: "apply to the Software Engineer, New Grad role at Stripe" },
        { capability: "payments.send", text: "remind me Friday" },
        { capability: "reminder.set", text: "remind me Friday", args: { when: "Friday" } },
      ] });
      const r = await say(c, m);
      eq(r.body.meta.planner.refused.map((x: any) => x.why), ["never_automated", "not_their_words", "unknown_capability"], r.reply);
      eq((r.reply.match(/Not done:/g) ?? []).length, 3, r.reply);
      eq(await queued(tok), [], "nothing queued from a refused step");
      eq((await reminders(tok)).length, 1, "the reminder part is done");
      eq(r.resultStatus, "partial");
      await nothingSent(tok);
    });

    await t.step("kill switches: CAREER_BRAIN unset or router, or the person not on CAREER_PLANNER_USERS: no planner call, today's reply byte for byte", async () => {
      const m = "find data analyst jobs in Chicago and apply to the top one";
      setOracle({ [m]: SET.tasks.find((x: any) => x.id === "T02").oracle[m] });
      set({ CAREER_BRAIN: "router", CAREER_PLANNER: null });
      const base = await say(await setup("tok-p5"), m);
      // Unset is a kill switch only while the release serves the router (before D-035); after it, unset serves staged.
      const unset = brainMode({ get: () => undefined }) === "router" ? [["tok-p6", { CAREER_BRAIN: null, CAREER_PLANNER: "on" }]] as const : [];
      for (const [tok, o] of [...unset, ["tok-p7", { CAREER_BRAIN: "router", CAREER_PLANNER: "on" }],
        ["tok-p8", { CAREER_BRAIN: "staged", CAREER_PLANNER: "on", CAREER_PLANNER_USERS: "someone-else" }]] as const) {
        const c = await setup(tok);
        set(o as any);
        const before = plannerCalls();
        const r = await say(c, m);
        set({ CAREER_PLANNER_USERS: null });
        eq(plannerCalls(), before, `${JSON.stringify(o)}: the planner is never asked`);
        eq([r.reply, r.intent], [base.reply, base.intent], JSON.stringify(o));
        eq(await queued(tok), await queued("tok-p5"));
      }
    });

    await t.step("a model outage: today's chain answers exactly as with the planner off", async () => {
      const m = "find data analyst jobs in Chicago and apply to the top one";
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: null });
      const off = await say(await setup("tok-p9"), m);
      const c = await setup("tok-p10");
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      outage = true;
      try {
        const r = await say(c, m);
        eq([r.reply, r.intent], [off.reply, off.intent]);
        eq(r.body.meta.planner, undefined);
      } finally { outage = false; }
    });

    await t.step("a code-first prompt waiting for its answer is never the planner's; no resume: the apply part queues nothing", async () => {
      const tok = "tok-p11", c = await setup(tok, { resume: false });
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      const m = "find frontend internships in Chicago and apply to the best 2";
      setOracle({ [m]: SET.tasks.find((x: any) => x.id === "T38").oracle[m] });
      const r = await say(c, m);
      eq(r.body.meta.planner.steps.map((s: any) => `${s.capability}:${s.status}`), ["jobs.search:done", "apply.queue:not_done"], r.reply);
      eq(await queued(tok), [], "no confirmed resume: nothing queued (the apply turn's own check)");
      await nothingSent(tok);
      // An outreach batch waiting for its answer: a two-action message is the outreach turn's, never planned.
      const tok2 = "tok-p12", c2 = await setup(tok2, { resume: true, contacts: true });
      const shown = await say(c2, "email Maya at Stripe about the data analyst role");
      eq(shown.intent, "career_outreach_batch", shown.reply);
      set({ CAREER_BRAIN: "staged", CAREER_PLANNER: "on" });
      const m2 = "email Lee at Stripe too and remind me Friday";
      setOracle({ [m2]: [{ capability: "outreach.draft", text: "email Lee at Stripe" }, { capability: "reminder.set", text: "remind me Friday", args: { when: "Friday" } }] });
      const before = plannerCalls();
      await say(c2, m2);
      eq(plannerCalls(), before, "deferred to the outreach turn");
      eq(await reminders(tok2), [], "nothing planned from it");
      await nothingSent(tok2);
    });
  } finally {
    clearOracle();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
