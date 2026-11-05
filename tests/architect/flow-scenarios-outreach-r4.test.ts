// OUTREACH R4 END TO END (2026-11-05): sampled whole outreach journeys through the PRODUCTION handlers on real Postgres 16
// (every migration): the person's own chat (agent-chat handler-career.ts handleChat; harness tests/flow/handler.ts) imports
// their contacts, drafts, shows, and takes their answer; the sending rail's function (career-send handleSend) sends from a
// fake Gmail at the HTTP boundary and reads what came back; the older scheduled sender and reader (career-proactive's
// runOutreachSends / runOutreachReplies over supabaseOutreachStore) run alongside, as both are served ON. Judged by the
// database's rows and by what "Gmail" received. The whole-journey runs (journeys-r2) never reached an email approved or sent:
// their scripted writer answered at the OpenAI URL, and the gateway is Claude-only since 2026-11-02 (D-038), so every draft
// failed; here the writer is a scripted stand-in at the Anthropic URL. Nothing leaves the machine; no real model or mail.
//   A  draft -> show -> "send all" / "yes" / "send 1-2" -> the rail -> Gmail: exactly the approved payloads, once each, each
//      under its approval hash, with List-Unsubscribe; the older sender sends none of them (20261105100000 on_rail).
//   B  then what comes back: a bounce (bounce list, draft bounced), a stop (do-not-contact, for everyone), a real answer
//      (replied), a delay warning and an out-of-office (nothing changes, either reader); a follow-up after any answer is
//      refused, and a new draft to a bounced or stopped address is never written.
//   C  edits after approval: "edit 1: ..." makes a new message that needs a new yes; the old approval never sends; the new
//      one sends once, exactly as edited. A question ("send them all?") or a hedge approves nothing.
//   D  Gmail answers 5xx after taking the email: the draft stays the rail's (an edit is refused, the older sender leaves
//      it), the next try finds it in Sent: one email, recorded sent.
//   E  one address under two names in the list: one draft. An address that opted out with someone else after the draft
//      was written, approved while Gmail is not connected: said won't be sent, and no ready-to-send link for it.
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { PgConn, serviceRpc } from "../flow/pgwire.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { FakeGmail } from "../flow/send-rail-fixture.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { memoryBudgetGate, resetLocalBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";
import { handleSend } from "../../supabase/functions/career-send/handler.ts";
import { emailHash, payloadHash, runOutreachReplies, runOutreachSends, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { queueApproved, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const N_USERS = 60;
const uid = (i: number) => `7d0f8f8e-6a43-4a49-9d2c-${String(940000000000 + i).padStart(12, "0")}`;
const TOKENS: Record<string, string> = Object.fromEntries(Array.from({ length: N_USERS }, (_, i) => [`tok-r4-${i}`, uid(i)]));
const FACTS = [{ id: "F-1", kind: "education", text: "BS Economics, DePaul University, Class of 2027", status: "confirmed" },
  { id: "F-2", kind: "experience", text: "Data analyst intern at Bravo Labs", status: "confirmed" }];
const SEND_SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const sq = (s: string) => s.replace(/'/g, "''");
const SEED = 20261105;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(SEED);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

// The scripted writer: a short honest email from the row it is given (never a fact that is not there).
let writerCalls = 0;
function fakeModel(body: any): Response {
  writerCalls++;
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const name = /^- name: (.*)$/m.exec(user)?.[1]?.trim() ?? "there";
  const text = `Subject: A quick question\n\nHi ${name.split(/\s+/)[0]},\n\nI'd be grateful for 15 minutes to hear how you got started. Would you be open to a short call?`;
  return Response.json({ id: "chatcmpl-r4", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 50 } });
}

Deno.test({ name: "outreach r4 end to end: draft, show, approve, send, bounce and reply through the real handlers on real Postgres", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  resetLocalBudgetGate(memoryBudgetGate(Number.MAX_SAFE_INTEGER));
  const pg: Pg = await startPg();
  // Placeholders built at run time (never a literal that reads as a key): the model key the gateway checks is present,
  // the scheduler's secret for career-send.
  const fakeKey = ["test", "r4", "placeholder", "not", "a", "key"].join("-");
  const sendSecret = ["r4", crypto.randomUUID(), crypto.randomUUID()].join("-");
  const env: Record<string, string> = { CAREER_NETWORKING_DRAFT: "on", ANTHROPIC_API_KEY: fakeKey, CAREER_MODEL: "claude-haiku-5-5", CAREER_MODEL_DAILY_CALLS: "1000", CAREER_MODEL_DAILY_USD: "5", CAREER_SEND_RAIL: "on" };
  const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "CAREER_PEOPLE_SEARCH", "CAREER_REPLY_WRITER"];
  const saved = Object.fromEntries([...Object.keys(env), ...unset].map((k) => [k, Deno.env.get(k)]));
  for (const k of unset) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const outbound: string[] = [];
  const realError = console.error;
  const conns: PgConn[] = [];
  try {
    await supabaseParity(pg);
    for (const id of Object.values(TOKENS)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_outreach_prefs (user_id, signature) values ('${id}', 'Sam Testcase');`);
    }
    const q = async (s: string) => (await pg.sql(s)).trim();
    const json = async (s: string) => JSON.parse((await q(s)) || "null");
    h = await careerHandler(pg, TOKENS);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
      if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.origin}${u.pathname}`); throw new TypeError(`network refused: ${u.host}`); }
      return await viaDouble(req);
    }) as typeof fetch;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: h.double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const store = supabaseOutreachStore(admin);
    const conn = await PgConn.connect({ host: pg.host, port: pg.port }); conns.push(conn);
    const rpc = serviceRpc(conn);
    const gmail = new FakeGmail();
    const fails: string[] = [];
    const fail = (x: string) => { fails.push(x); };
    let later = 0; // the workers' clock runs ahead of the database's by this much (a retry's wait)
    const railDeps = (): WorkerDeps => ({
      rpc: rpc.rpc, fetch: gmail.fetch, now: () => Date.now() + later,
      token: async (u, scope) => ((await q(`select exists (select 1 from public.user_oauth_connections where user_id = '${u}' and provider = 'google_career')`)) === "t" ? `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}` : null),
      drafts: (u, ids) => store.drafts!(u, ids),
    });
    // career-send, the rail's function, as pg_cron calls it: send what is due, then read what came back.
    const sendRun = async () => {
      const res = await handleSend(new Request("http://x/career-send", { method: "POST", headers: { "x-trainee-proactive-secret": sendSecret } }), {
        env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? sendSecret : Deno.env.get(k)) }, now: Date.now, rail: railDeps });
      const body = await res.json();
      if (res.status !== 200) fail(`career-send answered ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return body;
    };
    // The reply check reads a sent email's thread again after 15 minutes (career_send_replies_due): that much time passes.
    const minutesPass = async () => { await pg.sql(`update public.career_send_queue set checked_at = checked_at - interval '20 minutes' where checked_at is not null`); };
    // career-proactive's older outreach run, alongside (CAREER_OUTREACH_SEND is served ON too).
    const legacySent: string[] = [];
    const legacyRun = async () => {
      await runOutreachSends({ store, now: Date.now(), sender: { send: async (_u, m) => { legacySent.push(m.to); return { status: "sent", id: `legacy-${legacySent.length}`, thread_id: `legacy-t-${legacySent.length}` }; } } });
      await runOutreachReplies({ store, now: Date.now(), read: async (_u, tid) => ({ status: "ok", messages: (gmail.threads.get(tid) ?? []).filter((m) => !m.labelIds.includes("SENT")).map((m) => ({ from: m.from, subject: m.subject, snippet: m.snippet, at: new Date().toISOString() })) }) });
    };
    let next = 0;
    const person = async (o: { connected?: boolean } = {}) => {
      const i = next++;
      if (i >= N_USERS) throw new Error("more people than tokens");
      const id = uid(i);
      if (o.connected !== false) await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${id}', 'google_career', 'oauth_google_career_${id}', 'person${i}@example.test', '${SEND_SCOPES}')`);
      const tid = (await q(`with t as (insert into public.agent_threads (user_id, title) values ('${id}', 'TEST r4') returning id)
        insert into public.agent_flow_state (thread_id, user_id, state, updated_at) select id, '${id}', '${sq(JSON.stringify({ career: { stores: { profile: { facts: FACTS } } } }))}'::jsonb, now() from t returning thread_id`)).split("\n")[0].trim();
      const chat = h!.chat(`tok-r4-${i}`);
      let first = true;
      const say = async (m: string, extra: Record<string, unknown> = {}): Promise<Turn> => {
        await pg.sql(`delete from public.agent_rate_limits`);
        const res = await chat.say(m, first ? { thread_id: tid, ...extra } : extra);
        first = false;
        eq(res.status, 200, `${m}: ${res.reply}`);
        return res;
      };
      const drafts = async () => await json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'n', n, 'to', recipient_email, 'status', status, 'hash', hash, 'approved_hash', approved_hash, 'result', result, 'body', body) order by created_at, n), '[]') from career_outreach_drafts where user_id = '${id}'`);
      const queue = async () => await json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'source_id', source_id, 'state', state, 'to', recipient_email, 'hash', approval_hash, 'result', result, 'thread', gmail_thread) order by created_at), '[]') from career_send_queue where user_id = '${id}'`);
      const importList = async (rows: { name: string; firm: string; title?: string; email: string }[]) => {
        const csv = ["Name,Company,Title,Email", ...rows.map((x) => [x.name, x.firm, x.title ?? "Engineer", x.email].join(","))].join("\n");
        const res = await say("here are my contacts", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: csv }] });
        if (res.intent !== "career_contacts_import") fail(`import: ${res.intent} ${res.reply.slice(0, 200)}`);
      };
      return { id, i, say, drafts, queue, importList };
    };
    // Every email Gmail took for this person is one of their live approvals, under that exact hash, once per address.
    const approvals = new Map<string, Set<string>>(); // draft id -> hashes the person approved
    const noteApproved = async (p: { drafts: () => Promise<any[]> }) => { for (const d of await p.drafts()) if (d.approved_hash) (approvals.get(d.id) ?? approvals.set(d.id, new Set()).get(d.id)!).add(d.approved_hash); };
    const checkGmail = async (tag: string, p: { id: string; drafts: () => Promise<any[]> }) => {
      const ds = await p.drafts();
      const mine = gmail.sent.filter((m) => m.account === p.id);
      for (const m of mine) {
        const d = ds.find((x: any) => x.to === m.to);
        const hsh = await payloadHash({ to: m.to, subject: m.subject, text: m.text });
        if (!d) { fail(`${tag}: Gmail took an email to ${m.to}, no draft of theirs`); continue; }
        if (!approvals.get(d.id)?.has(hsh)) fail(`${tag}: Gmail took a payload to ${m.to} the person never approved (hash ${hsh.slice(0, 12)})`);
        if (mine.filter((x) => x.to === m.to).length !== 1) fail(`${tag}: ${mine.filter((x) => x.to === m.to).length} emails to ${m.to}`);
        if (!m.headers.some((x) => /^List-Unsubscribe: <mailto:/.test(x))) fail(`${tag}: an email without List-Unsubscribe`);
      }
      for (const d of ds) if (["sent", "replied", "bounced"].includes(d.status) && mine.filter((m) => m.to === d.to).length !== 1) fail(`${tag}: draft ${d.n} says ${d.status} with ${mine.filter((m) => m.to === d.to).length} emails in Gmail`);
      if (legacySent.length) fail(`${tag}: the older sender sent ${legacySent.length} email(s) the rail had: ${legacySent.join(", ")}`);
    };
    const firmsList = ["Stripe", "Ramp", "Plaid", "Brex", "Figma", "Notion"];
    const people = ["Maya Chen", "Jordan Lee", "Priya Shah", "Alex Kim", "Sam Rivera", "Noah Patel", "Lena Fischer", "Omar Haddad"];
    const listAt = (i: number, firm: string, n: number) => Array.from({ length: n }, (_, k) => ({ name: people[(i + k) % people.length], firm, email: `${people[(i + k) % people.length].split(" ")[0].toLowerCase()}.${i}.${k}@${firm.toLowerCase()}.example` }));

    // ------------------------------------------------------------------------------------------------ A + B
    await t.step("A+B. draft, show, approve, send; then a bounce, a stop, a reply, a delay and an away notice", async () => {
      for (let f = 0; f < 14; f++) {
        const p = await person();
        const firm = firmsList[f % firmsList.length], size = 2 + (f % 3);
        await p.importList(listAt(p.i, firm, size));
        const shown = await p.say(`draft intros to my contacts at ${firm}`);
        const ds = await p.drafts();
        if (shown.intent !== "career_outreach_batch" || ds.length !== size) { fail(`A${f}: drafted ${ds.length}/${size} (${shown.intent}/${shown.resultStatus}): ${shown.reply.slice(0, 200)}`); continue; }
        for (const d of ds) if (!shown.reply.includes(`<${d.to}>`)) fail(`A${f}: draft ${d.n} to ${d.to} was not shown`);
        const ans = pick(["send all", "yes", "send 1-2", "yes, send them all", "send all except 1"]);
        const want = ans === "send 1-2" ? [1, 2] : ans === "send all except 1" ? ds.map((d: any) => d.n).filter((n: number) => n !== 1) : ds.map((d: any) => d.n);
        const said = await p.say(ans);
        await noteApproved(p);
        const after = await p.drafts();
        const approvedNs = after.filter((d: any) => d.status === "approved").map((d: any) => d.n);
        if (JSON.stringify(approvedNs) !== JSON.stringify(want)) fail(`A${f}: "${ans}" approved ${JSON.stringify(approvedNs)}, wanted ${JSON.stringify(want)}: ${said.reply.slice(0, 200)}`);
        if (!said.reply.includes(`Approved ${want.length}, exactly as shown`)) fail(`A${f}: the reply does not say what was approved: ${said.reply.slice(0, 200)}`);
        for (const d of after.filter((x: any) => x.status === "approved")) if (d.approved_hash !== ds.find((x: any) => x.id === d.id).hash) fail(`A${f}: draft ${d.n} approved under another hash than the one shown`);
        const qd = await p.queue();
        if (qd.length !== want.length || qd.some((x: any) => x.state !== "queued")) fail(`A${f}: the hand-off queued ${JSON.stringify(qd.map((x: any) => x.state))}`);
        await legacyRun();
        await sendRun();
        await legacyRun();
        await checkGmail(`A${f}`, p);
        const sent = gmail.sent.filter((m) => m.account === p.id);
        if (sent.length !== want.length) { fail(`A${f}: Gmail took ${sent.length}, wanted ${want.length}`); continue; }
        // B: what comes back, one kind per sent email.
        const kinds = ["bounce", "stop", "reply", "delay", "ooo"] as const;
        const got: Record<string, string> = {};
        for (const [k, m] of sent.entries()) {
          const kind = kinds[(f + k) % kinds.length];
          got[m.to] = kind;
          if (kind === "bounce") gmail.reply(m.threadId, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", `Address not found: ${m.to}`);
          if (kind === "delay") gmail.reply(m.threadId, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "This is a warning message only. Delivery will continue to be attempted.");
          if (kind === "stop") gmail.reply(m.threadId, `Contact <${m.to}>`, `Re: ${m.subject}`, "Not interested, thanks. Please remove me from your list.");
          if (kind === "reply") gmail.reply(m.threadId, `Contact <${m.to}>`, `Re: ${m.subject}`, "Happy to chat! How is Thursday?");
          if (kind === "ooo") gmail.reply(m.threadId, `Contact <${m.to}>`, `Automatic reply: ${m.subject}`, "I am out of the office until Monday.");
        }
        await minutesPass();
        await sendRun();
        await legacyRun();
        const fin = await p.drafts(), qq = await p.queue();
        for (const [to, kind] of Object.entries(got)) {
          const d = fin.find((x: any) => x.to === to), row = qq.find((x: any) => x.to === to);
          const bad = (await q(`select count(*) from public.career_send_bad_addresses where email_hash = '${await emailHash(to)}'`)) === "1";
          const dnc = (await q(`select count(*) from public.career_outreach_dnc where email_hash = '${await emailHash(to)}'`)) !== "0";
          const wantDraft = kind === "bounce" ? "bounced" : kind === "stop" || kind === "reply" ? "replied" : "sent";
          if (d?.status !== wantDraft) fail(`B${f}: after a ${kind} the draft is ${d?.status}, wanted ${wantDraft}`);
          if ((kind === "bounce") !== bad) fail(`B${f}: after a ${kind} the bounce list says ${bad}`);
          if ((kind === "stop") !== dnc) fail(`B${f}: after a ${kind} the do-not-contact list says ${dnc}`);
          if (kind === "delay" || kind === "ooo") { if (row?.state !== "sent") fail(`B${f}: a ${kind} changed the rail's row to ${row?.state}`); }
          // A follow-up after any answer, or to a bounced address, is refused.
          if (row && (kind === "bounce" || kind === "stop" || kind === "reply")) {
            const text = "Hi again, just following up on my note below.\n\nSam Testcase";
            const fu = await queueApproved({ rpc: rpc.rpc }, p.id, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to, subject: `Re: A quick question`, text }), to, subject: "Re: A quick question", text, followUpOf: row.id }]);
            if (fu[0]?.status !== "refused") fail(`B${f}: a follow-up after a ${kind} was ${fu[0]?.status}`);
          }
        }
        // Someone else drafting to a bounced or stopped address: never written.
        const blockedTos = Object.entries(got).filter(([, k]) => k === "bounce" || k === "stop").map(([to]) => to);
        if (blockedTos.length) {
          const o = await person();
          await o.importList(blockedTos.map((to, k) => ({ name: `Again ${String.fromCharCode(65 + k)} Person`, firm: "Globex", email: to })));
          const res = await o.say("draft intros to my contacts at Globex");
          const od = await o.drafts();
          if (od.length) fail(`B${f}: another person drafted to a bounced or stopped address: ${JSON.stringify(od.map((x: any) => x.to))} (${res.reply.slice(0, 200)})`);
        }
        await checkGmail(`B${f}`, p);
      }
    });

    // ------------------------------------------------------------------------------------------------ C
    await t.step("C. an edit after approval needs a fresh yes; a question or a hedge approves nothing", async () => {
      for (let f = 0; f < 6; f++) {
        const p = await person();
        await p.importList(listAt(p.i, "Plaid", 2));
        await p.say("draft intros to my contacts at Plaid");
        const hedge = await p.say(pick(["send them all?", "maybe", "yes but not Acme", "ok", "send 1?"]));
        if ((await p.drafts()).some((d: any) => d.status !== "shown")) fail(`C${f}: a question or a hedge approved something: ${hedge.reply.slice(0, 200)}`);
        if (hedge.intent !== "career_outreach_batch") await p.say("show my drafts");
        await p.say("send all");
        await noteApproved(p);
        const before = await p.drafts();
        // Everything approved: the batch is no longer the thread's last word; showing it again makes it so (an edit is
        // read only then, as on the card).
        const again = await p.say("show my drafts");
        if (!/\(approved\)/.test(again.reply)) fail(`C${f}: the approved drafts are not shown as approved: ${again.reply.slice(0, 200)}`);
        const words = `Hi there, a shorter note (${f}): could we talk for 10 minutes next week?`;
        const e = await p.say(`edit 1: ${words}`);
        const mid = await p.drafts();
        const d1 = mid.find((d: any) => d.n === 1);
        if (d1.status !== "shown" || d1.approved_hash || d1.hash === before.find((d: any) => d.n === 1).hash || !d1.body.includes(words)) fail(`C${f}: the edit did not make a new message needing a yes: ${JSON.stringify(d1).slice(0, 200)} (${e.intent}/${e.resultStatus}: ${e.reply.slice(0, 160)})`);
        if (f % 2 === 0) { await sendRun(); await legacyRun(); }
        // The old approval never sends; the new one only after a fresh yes.
        if (gmail.sent.some((m) => m.account === p.id && m.to === d1.to)) fail(`C${f}: the edited draft went on its old approval`);
        await p.say("send 1");
        await noteApproved(p);
        await sendRun();
        await legacyRun();
        await checkGmail(`C${f}`, p);
        const to1 = gmail.sent.filter((m) => m.account === p.id && m.to === d1.to);
        if (to1.length !== 1 || !to1[0].text.includes(words)) fail(`C${f}: the edited draft went ${to1.length} times, or not as edited`);
      }
    });

    // ------------------------------------------------------------------------------------------------ D
    await t.step("D. Gmail answers 5xx after taking the email: the draft stays the rail's; one email, recorded sent", async () => {
      for (let f = 0; f < 5; f++) {
        const p = await person();
        await p.importList(listAt(p.i, "Brex", 1));
        await p.say("draft intros to my contacts at Brex");
        await p.say("send it");
        await noteApproved(p);
        let once = true;
        gmail.afterAccept = () => { if (once) { once = false; throw new TypeError("connection reset by peer"); } };
        await sendRun();
        gmail.afterAccept = null;
        const d = (await p.drafts())[0];
        if (d.status !== "sending") fail(`D${f}: after a try Gmail may have taken, the draft is ${d.status} (wanted sending: the rail's until it looks in Sent)`);
        const e = await p.say(`edit 1: Hi, a different note (${f}).`);
        if ((await p.drafts())[0].hash !== d.hash) fail(`D${f}: an email that may be in their inbox was edited: ${e.reply.slice(0, 160)}`);
        await legacyRun();
        later = 120_000; // the retry is due
        await sendRun();
        later = 0;
        await checkGmail(`D${f}`, p);
        const fin = (await p.drafts())[0], row = (await p.queue())[0];
        if (fin.status !== "sent" || row.state !== "sent") fail(`D${f}: after the Sent check the draft is ${fin.status} and the rail ${row.state} (${row.result})`);
      }
    });

    // ------------------------------------------------------------------------------------------------ E
    await t.step("E. one address under two names: one draft; opted out since the draft and Gmail not connected: no link", async () => {
      for (let f = 0; f < 4; f++) {
        const p = await person();
        const dup = `jsmith.${p.i}@stripe.example`;
        await p.importList([{ name: "Jon Smith", firm: "Stripe", email: dup }, { name: "Jonathan Smith", firm: "Stripe", email: f % 2 ? dup.toUpperCase() : dup }, { name: "Ann Lee", firm: "Stripe", email: `ann.${p.i}@stripe.example` }]);
        const res = await p.say("draft intros to my contacts at Stripe");
        const ds = await p.drafts();
        if (ds.filter((d: any) => d.to === dup).length !== 1 || ds.length !== 2) fail(`E${f}: ${ds.length} drafts, ${ds.filter((d: any) => d.to === dup).length} to the shared address: ${res.reply.slice(0, 240)}`);
        // The import may already keep one row per address; if both rows reach the drafter, the second is said.
        const m = /Drafted (\d+)\/(\d+)/.exec(res.reply);
        if (m && m[1] !== m[2] && !/same address as/.test(res.reply)) fail(`E${f}: the second name is not said: ${res.reply.slice(0, 300)}`);
      }
      for (let f = 0; f < 4; f++) {
        const p = await person({ connected: false });
        await p.importList(listAt(p.i, "Figma", 2));
        await p.say("draft intros to my contacts at Figma");
        const ds = await p.drafts();
        const stopped = ds[0].to;
        await pg.sql(`insert into public.career_outreach_dnc (user_id, email_hash, reason) values ('${uid(0)}', '${await emailHash(stopped)}', 'recipient asked to stop') on conflict do nothing`);
        const res = await p.say("send all");
        if (!new RegExp(`Won't be sent: [^.]*\\b1 \\(`).test(res.reply)) fail(`E${f}: the opted-out one is not said as won't be sent: ${res.reply.slice(0, 300)}`);
        if (res.reply.includes(`mailto:${stopped}`)) fail(`E${f}: a ready-to-send link to someone who asked not to be contacted`);
        if (!res.reply.includes(`mailto:${ds[1].to}`)) fail(`E${f}: no link for the one that may be sent: ${res.reply.slice(0, 300)}`);
        const fin = await p.drafts();
        if (fin[0].status !== "skipped" || fin[0].result !== "opted_out") fail(`E${f}: the opted-out draft is ${fin[0].status}/${fin[0].result}`);
        // Connected later: the older run sends what never reached the rail, once, and never the opted-out one.
        await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${p.id}', 'google_career', 'oauth_google_career_${p.id}', 'p@example.test', '${SEND_SCOPES}')`);
        const before = legacySent.length;
        await legacyRun();
        const went = legacySent.slice(before);
        legacySent.length = before;
        if (went.length !== 1 || went[0] !== ds[1].to) fail(`E${f}: after connecting, the older run sent ${JSON.stringify(went)}`);
      }
    });

    await t.step("nothing left the machine; every problem found is listed", async () => {
      eq(outbound, [], "no request but the Supabase double and the scripted Anthropic URL");
      if (fails.length) throw new Error(`${fails.length} scenario failures:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
      const sent = gmail.sent.length;
      console.log(`[outreach-r4 e2e] ${next} people, ${writerCalls} writer calls, ${sent} emails Gmail took, ${Object.keys(approvals).length || approvals.size} drafts approved`);
      assert(sent >= 40, `the journeys reached Gmail (${sent} emails)`);
      const unexpected = errors.filter((e) => !/not connected|NOT_WIRED|send rail: approved drafts not queued/i.test(e));
      if (unexpected.length) console.log(`[outreach-r4 e2e] logged errors (${unexpected.length}): ${unexpected.slice(0, 5).join(" | ")}`);
    });
  } finally {
    console.error = realError;
    for (const c of conns) c.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    await pg.stop();
    resetLocalBudgetGate();
  }
} });
