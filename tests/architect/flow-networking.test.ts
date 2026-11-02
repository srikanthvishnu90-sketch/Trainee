// FEATURE 10: networking from chat through the REAL handler (agent-chat/handler-career.ts handleChat) on real Postgres.
// A person pastes their resume and confirms it, uploads their LinkedIn Connections.csv and pastes a contacts CSV, asks who
// they know at Stripe, asks to email Maya about a role (Trainee asks how they sign, then drafts from confirmed facts onto
// the outreach batch), approves exactly that message with "send 1", and the scheduled send run (runOutreachSends over the
// same database, its claim RPC, a fake Gmail) sends exactly what was approved, once. The model is a scripted stand-in at
// the OpenAI URL; nothing leaves the machine. Addresses come only from the person's own files; another person sees none.
import { personalOpenAI, seedFactsSql, seedKeysSql } from "./personal-fixture.ts";
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type Message, runOutreachSends, type Sender, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
const CONTACTS = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/contacts.csv`);
const PEOPLE: Record<string, string> = { "tok-n": "7b0f8f8e-6a43-4a49-9d2c-0000000000f1", "tok-x": "7b0f8f8e-6a43-4a49-9d2c-0000000000f2" };

// The scripted writer at the OpenAI URL: one short email from the recipient row and the ask it was given. Sam's draft
// claims a job that is not on record, so the fact-lock refuses it twice and it is never shown.
let modelCalls = 0;
function fakeOpenAI(body: any): Response {
  // PERSONALIZED OUTREACH (2026-10-31): a first email's payload is the engine's, answered from it (personal-fixture.ts).
  const personal = personalOpenAI(body, (first) => (first === "Sam" ? "I worked at Google for two years." : ""));
  if (personal) { modelCalls++; return personal as any; }
  modelCalls++;
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /- name: (\S+)/.exec(user)?.[1] ?? "there", topic = /ASK ABOUT[^\n]*\n- (.+)/.exec(user)?.[1];
  const extra = first === "Sam" ? " I worked at Google for two years." : "";
  const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to ${topic ? `ask about ${topic}` : "hear how you got started"}.${extra} Would you be open to a short call?`;
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json" } });
}

Deno.test({ name: "F10: networking emails from chat at the real handler: import, who, draft, one approval, one fake send", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const env = { CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: "sk-test-not-real", CAREER_MODEL: "gpt-5-mini" };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const me = PEOPLE["tok-n"];
    handler = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).host === "api.openai.com") return fakeOpenAI(await req.json());
      return await viaDouble(req);
    }) as typeof fetch;
    const chat: Chat = handler.chat("tok-n");
    const say = async (c: Chat, message: string, extra: Record<string, unknown> = {}) => { const r = await c.say(message, extra); eq(r.status, 200, r.reply); return r; };
    const drafts = async () => JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('n', n, 'to', recipient_email, 'status', status, 'hash', hash, 'approved_hash', approved_hash, 'subject', subject, 'body', body, 'footer', footer) order by created_at, n), '[]'::jsonb) from public.career_outreach_drafts where user_id = '${me}'`));

    await t.step("before any contacts: who and email answer plainly, with how to add people; nothing drafted", async () => {
      const who = await say(chat, "who do I know at Stripe?");
      eq([who.intent, who.resultStatus], ["career_contacts_at", "no_contacts"], who.reply);
      assert(/haven't sent me any contacts yet/.test(who.reply) && /people database or an email finder/.test(who.reply) && /Get a copy of your data, Connections/.test(who.reply), who.reply);
      const rec = await say(chat, "email a recruiter at Stripe");
      eq(rec.resultStatus, "no_contacts", rec.reply);
      eq(await drafts(), []);
    });

    await t.step("their resume, confirmed by them (the router's evidenced confirm)", async () => {
      const pasted = await say(chat, `here is my resume:\n${RESUME}`);
      eq(pasted.intent, "career_resume_ingest", pasted.reply);
      const yes = await say(chat, "yes, that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
    });

    await t.step("upload: the LinkedIn export, imported with a coverage fraction; a pasted CSV adds addresses", async () => {
      const up = await say(chat, "here are my LinkedIn connections", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] });
      eq([up.intent, up.resultStatus], ["career_contacts_import", "imported"], up.reply);
      assert(/Connections\.csv: imported 6\/8 rows into your contacts \(left out: 1 duplicate; row 7: no name\)/.test(up.reply), up.reply);
      assert(/4\/6 have an email address/.test(up.reply) && /never guess an address/.test(up.reply), up.reply);
      // Architect ruling R1 (2026-10-27): the contacts are the account's (career_account_contacts), not the chat's; no chat
      // state carries a copy. Was: the chat snapshot's stores.contacts held the 6 rows.
      const stored = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(data order by row_key), '[]'::jsonb) from public.career_account_contacts where user_id = '${me}'`));
      eq(stored.length, 6);
      eq(await pg.sql(`select count(*) from public.agent_flow_state where user_id = '${me}' and state->'career'->'stores' ? 'contacts'`), "0", "no per-chat copy");
      assert(!JSON.stringify(stored).includes("linkedin.com/in/"), "no profile URL kept");
      const pasted = await say(chat, `and these\n${CONTACTS}`);
      assert(/imported 2\/2 rows/.test(pasted.reply), pasted.reply);
      // PERSONALIZED OUTREACH (2026-10-31): each person they will write to carries one sourced fact (what they told Trainee).
      await pg.sql(seedFactsSql(me, ["maya.chen@stripe.example", "lee.park@stripe.example", "sam.rivera@stripe.example"]));
    });

    await t.step("who: three phrasings, answered from their own contacts, one person once", async () => {
      for (const m of ["who do I know at Stripe?", "find my connections at Stripe", "find me someone at Stripe"]) {
        const r = await say(chat, m);
        eq([r.intent, r.resultStatus], ["career_contacts_at", "listed"], `${m}: ${r.reply}`);
        assert(/You have 4 contacts at Stripe/.test(r.reply) && /- Maya Chen, Data Analyst \(maya\.chen@stripe\.example\)/.test(r.reply) && /- Lee Park, Software Engineer \(lee\.park@stripe\.example\)/.test(r.reply), r.reply);
        eq((r.reply.match(/Lee Park/g) ?? []).length, 1, r.reply);
      }
      const none = await say(chat, "do I know anyone at Plaid Technologies?");
      eq(none.resultStatus, "none_at_firm", none.reply);
    });

    await t.step("email Maya about a role: how they sign, then the draft on the outreach batch, written from confirmed facts", async () => {
      const ask = await say(chat, "email Maya at Stripe about the data analyst role");
      eq([ask.intent, ask.resultStatus], ["career_outreach_signature", "needs_signature"], ask.reply);
      const sig = await say(chat, "Alex Testcase\nTEST University");
      eq([sig.intent, sig.resultStatus], ["career_outreach_batch", "drafted"], sig.reply);
      assert(/^Saved your signature\.\n\nDrafted 1\/1\./.test(sig.reply), sig.reply);
      assert(/To: Maya Chen, Data Analyst, Stripe <maya\.chen@stripe\.example>/.test(sig.reply) && /TEST meetup talk about data pipelines/.test(sig.reply), sig.reply); // was /ask about the data analyst role/ (the generic body)
      assert(/Reply "send all", "send 1-7,9"/.test(sig.reply), sig.reply);
      assert(Array.isArray(sig.body.parts) && sig.body.parts.length >= 2, "the batch rides as whole parts");
      const d = await drafts();
      eq(d.map((x: any) => [x.n, x.to, x.status]), [[1, "maya.chen@stripe.example", "shown"]]);
      const cost = JSON.parse(await pg.sql(`select coalesce(sum(calls), 0) from public.agent_turn_costs where user_id = '${me}'`));
      assert(Number(cost) >= 1, "the model call was metered");
    });

    await t.step("never an invented person or address: not on the list, no address, a role inbox, a claim not on record", async () => {
      const before = modelCalls;
      const jamie = await say(chat, "email Jamie at Stripe about a referral");
      eq(jamie.resultStatus, "not_in_contacts", jamie.reply);
      const gs = await say(chat, "email a recruiter at Goldman");
      eq(gs.resultStatus, "none_at_firm", gs.reply);
      eq(modelCalls, before, "no model call for anyone not on their list");
      // The open batch is still the thread's word only until another reply; draft the group now.
      const group = await say(chat, "draft intros to my 3 contacts at Stripe");
      eq([group.intent, group.resultStatus], ["career_outreach_batch", "drafted"], group.reply);
      assert(/^Drafted 1\/4\./.test(group.reply), group.reply);
      assert(/Maya Chen \(you already have a draft or email to them\)/.test(group.reply) && /Stripe Careers \(careers@stripe\.example is a shared inbox, not a person\)/.test(group.reply)
        && /Sam Rivera \(I couldn't write it without saying something not on record/.test(group.reply), group.reply);
      assert(/To: Lee Park, Software Engineer, Stripe <lee\.park@stripe\.example>/.test(group.reply), group.reply);
      const all = await drafts();
      assert(all.every((x: any) => ["maya.chen@stripe.example", "lee.park@stripe.example"].includes(x.to)), JSON.stringify(all));
    });

    await t.step("one approval per exact message: send 1 approves Lee's draft only; the run sends exactly it, once", async () => {
      const yes = await say(chat, "send 1");
      eq(yes.resultStatus, "approved", yes.reply);
      assert(/Approved 1, exactly as shown: 1 Lee Park \(Stripe\)/.test(yes.reply), yes.reply);
      assert(/Nothing can go out until your Gmail is connected for sending/.test(yes.reply), yes.reply);
      const d = await drafts();
      const lee = d.find((x: any) => x.to === "lee.park@stripe.example"), maya = d.find((x: any) => x.to === "maya.chen@stripe.example");
      eq([lee.status, lee.approved_hash], ["approved", lee.hash]);
      eq(maya.status, "shown", "Maya's earlier batch is not approved by a yes to another batch");
      const sent: Message[] = [];
      const sender: Sender = { send: async (_u, m) => { sent.push(m); return { status: "sent", id: `gm-${sent.length}`, thread_id: `th-${sent.length}` }; } };
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const store = supabaseOutreachStore(admin);
      const first = await runOutreachSends({ store, sender, now: Date.now() });
      eq(first.sent, 1, JSON.stringify(first));
      eq(sent.length, 1);
      eq(sent[0].to, "lee.park@stripe.example");
      eq(sent[0].text, `${lee.body.trim()}\n\n${lee.footer.trim()}`);
      assert(/^Alex Testcase\nTEST University\n\nIf you'd rather not hear from me, reply stop/.test(lee.footer), lee.footer);
      const again = await runOutreachSends({ store, sender, now: Date.now() + 120_000 });
      eq([again.sent, sent.length], [0, 1], "sent once");
      eq((await drafts()).find((x: any) => x.to === "lee.park@stripe.example").status, "sent");
    });

    await t.step("another person sees none of it", async () => {
      const other = handler!.chat("tok-x");
      const r = await say(other, "who do I know at Stripe?");
      eq(r.resultStatus, "no_contacts", r.reply);
      eq(JSON.parse(await pg.sql(`select count(*) from public.career_outreach_drafts where user_id = '${PEOPLE["tok-x"]}'`)), 0);
    });
  } finally {
    for (const k of Object.keys(env)) Deno.env.delete(k);
    handler?.restore();
    await pg.stop();
  }
} });
