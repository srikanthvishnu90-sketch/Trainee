// Mass networking, lane M1, through the REAL chat handler (agent-chat/handler-career.ts handleChat) on real Postgres:
// with CAREER_SEND_RAIL=on and a career Google grant that may send, "send 1" on an outreach batch queues exactly that
// draft on the sending rail (N2's onApproved hand-off -> queueApprovedOutreach), bound to its approval hash; a sender
// instance (runSendWorker, the career-send function's loop) sends it once from the person's Gmail (faked at the HTTP
// boundary); "where are my emails" has a plain answer; another "send 1" never sends it again. The model is a scripted
// stand-in at the OpenAI URL; nothing leaves the machine.
import { personalOpenAI, seedFactsSql, seedKeysSql } from "./personal-fixture.ts";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { PgConn, serviceRpc } from "../flow/pgwire.ts";
import { FakeGmail } from "../flow/send-rail-fixture.ts";
import { outreachSendStatus, runSendWorker } from "../../supabase/functions/_shared/career_send_rail.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
const PEOPLE: Record<string, string> = { "tok-s": "7b0f8f8e-6a43-4a49-9d2c-0000000052f1" };

function fakeOpenAI(body: any): Response {
  // PERSONALIZED OUTREACH (2026-10-31): a first email's payload is the engine's, answered from it (personal-fixture.ts).
  const personal = personalOpenAI(body);
  if (personal) { return personal as any; }
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
  const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to hear how you got started. Would you be open to a short call?`;
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json" } });
}

Deno.test({ name: "M1 flow: chat approval -> send rail queue -> one send from the person's Gmail, at the real handler", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const env = { CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: "sk-test-not-real", CAREER_MODEL: "gpt-5-mini", CAREER_SEND_RAIL: "on" };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const me = PEOPLE["tok-s"];
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${me}', 'sender@example.test'); insert into public.profiles (id) values ('${me}');
      insert into public.career_watch_kv (user_id, key, value) values ('${me}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${me}', 'google_career', 'oauth_google_career_${me}', 'sender@example.test',
        'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');`);
    handler = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).host === "api.openai.com") return fakeOpenAI(await req.json());
      return await viaDouble(req);
    }) as typeof fetch;
    const chat: Chat = handler.chat("tok-s");
    const say = async (message: string, extra: Record<string, unknown> = {}) => { const r = await chat.say(message, extra); eq(r.status, 200, r.reply); return r; };
    const queue = async () => JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'to', recipient_email, 'state', state, 'hash', approval_hash, 'source', source_id) order by created_at), '[]'::jsonb) from public.career_send_queue where user_id = '${me}'`));

    await t.step("resume, contacts, a draft to Lee on the outreach batch", async () => {
      eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
      eq((await say("yes, that's my resume")).resultStatus, "completed");
      eq((await say("here are my LinkedIn connections", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] })).resultStatus, "imported");
      // PERSONALIZED OUTREACH (2026-10-31): Maya carries one sourced fact (what the person told Trainee).
      await pg.sql(seedFactsSql(me, ["maya.chen@stripe.example"]));
      const ask = await say("email Maya at Stripe about the data analyst role");
      eq(ask.resultStatus, "needs_signature", ask.reply);
      const sig = await say("Alex Testcase\nTEST University");
      eq([sig.intent, sig.resultStatus], ["career_outreach_batch", "drafted"], sig.reply);
      eq(await queue(), [], "nothing queued before a yes");
    });

    await t.step("send 1: exactly that draft is queued on the rail, bound to its approval hash", async () => {
      const yes = await say("send 1");
      eq(yes.resultStatus, "approved", yes.reply);
      const d = JSON.parse(await pg.sql(`select jsonb_agg(jsonb_build_object('id', id, 'hash', hash, 'to', recipient_email, 'status', status)) from public.career_outreach_drafts where user_id = '${me}'`));
      eq(d.length, 1);
      const q = await queue();
      eq(q, [{ kind: "outreach", to: d[0].to, state: "queued", hash: d[0].hash, source: d[0].id }]);
    });

    await t.step("a sender instance sends it once from the person's Gmail; a second run sends nothing", async () => {
      const gmail = new FakeGmail();
      const conn = await PgConn.connect({ host: pg.host, port: pg.port });
      const deps = { rpc: serviceRpc(conn).rpc, fetch: gmail.fetch, token: async (u: string, scope: string) => `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}` };
      const first = await runSendWorker(deps, { worker: "flow-1" });
      eq(first.sent, 1, JSON.stringify(first));
      const again = await runSendWorker(deps, { worker: "flow-2" });
      eq(again.sent, 0);
      eq(gmail.sent.length, 1);
      const d = JSON.parse(await pg.sql(`select jsonb_build_object('status', status, 'gmail_id', gmail_id, 'body', body, 'footer', footer, 'to', recipient_email) from public.career_outreach_drafts where user_id = '${me}'`));
      eq([d.status, d.gmail_id], ["sent", gmail.sent[0].id]);
      eq([gmail.sent[0].to, gmail.sent[0].text], [d.to, `${d.body.trim()}\n\n${d.footer.trim()}`], "exactly the approved text");
      const st = await outreachSendStatus(serviceRpc(conn), me);
      assert(/^1 email sent from your Gmail\./.test(st.line), st.line);
      conn.close();
    });

    await t.step("another \"send 1\" on the same batch does not queue or send it again", async () => {
      await say("send 1");
      eq((await queue()).length, 1);
    });
  } finally {
    for (const k of Object.keys(env)) Deno.env.delete(k);
    handler?.restore();
    await pg.stop();
  }
} });
