// FEATURE 16 (2026-10-26): the owner's own test of Trainee in Telegram, end to end through the Telegram webhook the
// deploy ships (supabase/functions/trainee-telegram/handler.ts handleTelegram, composed exactly as its index.ts composes
// it: the inbound store, agent-chat through chatThroughAgent, the head-start deliverer, the service client), with every
// outcome checked against the database and the wire, not only the replies:
//
//   1. /start: an account is made for the chat; the welcome goes out through the outbox, to this chat id
//   2. the resume sent as a PDF: getFile, the file downloaded; its bytes and sha256 stored with the upload's reference;
//      each entry it read shown back
//   3. "yes, that's my resume": a fact_confirmed event per entry, each naming the FILE (its reference and sha256)
//   4. "apply me to this: <Ashby link>": the posting read from Ashby's API, queued; the reply matches the queue row
//   5. only what is needed is asked (name, email; then the form's own questions), answered in chat by number
//   6. "show my applications": the card, every exact answer, with Approve and Decline buttons bound to the card id and
//      its hash; a text yes with no reply, a forged button and a changed card approve nothing; the tap queues exactly one
//      row bound to the approval hash, answered once on the button; a webhook retry and a second tap add nothing
//   7. the queued message; the sender (the real engine with --approved on the employer's form); the employer form gets
//      exactly one POST with exactly the card's values and the resume file whose sha256 was approved; the finish state is
//      what the form returned; the receipt goes out through trainee-deliver to this chat
//   8. "did it go through?": the recorded state, said as recorded
//   and a person with no resume who asks to apply: refused in plain words, nothing queued, no card, nothing sent.
//
// The seams, disclosed: the HTTP hop to the Supabase project (tests/flow/postgrest.ts over the real Postgres, as in every
// flow test), Telegram's Bot API (a local server answering getFile, the file download, sendMessage, sendChatAction and
// answerCallbackQuery, recording each call), and Ashby (api.ashbyhq.com answered on 127.0.0.1 with one synthetic posting;
// the employer's form a locally served copy of a captured Ashby form, as in flow-e2e-chat-submit.test.ts). agent-chat is
// the real handler, reached through the real chatThroughAgent fetch. The persona is the synthetic TEST resume. Any other
// outbound request fails the test: no real Telegram, no real employer, nothing to a real person.
import assertNode from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { loginHash } from "../../supabase/functions/_shared/telegram_login.ts";
import { handleTelegramLink } from "../../supabase/functions/trainee-telegram-link/handler.ts";
import { TELEGRAM_CHANNEL_ONLY_REPLY, TELEGRAM_UNLINKED_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { answerOneByOne } from "../helpers/one_question.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const CAPTURED = `${ROOT}/tests/fixtures/forms-ci/ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03.html`;
const JOB_UUID = "a13ae586-f4cb-4385-8822-c42b9b54ed74";
const LINK = `https://jobs.ashbyhq.com/ramp/${JOB_UUID}`;
const KEY = `ashby:ramp:${JOB_UUID}`;
const TITLE = "Frontend Engineer Intern (TEST)";
const TOKEN = "123456:TEST-bot-token-not-real";
const SECRET = "TEST_webhook_secret_0123456789_abcdefghij";
const CHAT = 700000101, NO_RESUME_CHAT = 700000202;
// The button's binding, computed here from its definition (not imported), so this file also runs on a base without it:
// the first 16 hex of sha256 over the card's id and each item's number and payload hash.
const cardDigest = async (c: { id: string; items: { n: number; payload_hash: string }[] }) =>
  (await hex(new TextEncoder().encode(`${c.id}|${[...c.items].sort((a, b) => a.n - b.n).map((i) => `${i.n}:${i.payload_hash}`).join(",")}`))).slice(0, 16);
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

// The synthetic resume as a real PDF: one page, one line of text per line, in a Flate content stream (the shape a
// word processor's export has).
function resumePdf(text: string): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const lines = text.split("\n");
  const ops = lines.map((l, i) => l.trim() ? `BT /F1 9 Tf 1 0 0 1 40 ${800 - i * 12} Tm (${esc(l)}) Tj ET` : "").filter(Boolean).join("\n");
  const stream = deflateSync(new TextEncoder().encode(ops));
  const enc = new TextEncoder(), parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { parts.push(b); pos += b.length; };
  push(enc.encode("%PDF-1.4\n"));
  const objs: (string | Uint8Array)[][] = [
    ["<< /Type /Catalog /Pages 2 0 R >>"], ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
    [`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, stream, "\nendstream"], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  objs.forEach((o, i) => { offsets.push(pos); push(enc.encode(`${i + 1} 0 obj\n`)); for (const p of o) push(typeof p === "string" ? enc.encode(p) : p); push(enc.encode("\nendobj\n")); });
  const xref = pos;
  push(enc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(pos);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

// Telegram's Bot API, on 127.0.0.1: every call recorded with its method and body.
function botApi(files: Map<string, Uint8Array>) {
  const calls: { method: string; body: any }[] = [];
  let next = 5000;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const file = new RegExp(`^/file/bot${TOKEN.replace(/[:]/g, ":")}/(.+)$`).exec(decodeURIComponent(u.pathname));
    if (req.method === "GET" && file) {
      calls.push({ method: "download", body: { path: file[1] } });
      const b = files.get(file[1]);
      return b ? new Response(b as BodyInit) : new Response("no", { status: 404 });
    }
    const m = new RegExp(`^/bot${TOKEN}/([A-Za-z]+)$`).exec(decodeURIComponent(u.pathname));
    if (!m || req.method !== "POST") return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    calls.push({ method: m[1], body });
    if (m[1] === "sendMessage") return Response.json({ ok: true, result: { message_id: next++, chat: { id: body.chat_id, type: "private" }, date: 1, text: body.text } });
    if (m[1] === "getFile") {
      const path = `documents/${body.file_id}.pdf`;
      return files.has(path) ? Response.json({ ok: true, result: { file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_size: files.get(path)!.length, file_path: path } })
        : Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
    }
    if (m[1] === "answerCallbackQuery" || m[1] === "sendChatAction") return Response.json({ ok: true, result: true });
    return Response.json({ ok: false, error_code: 400, description: `unexpected ${m[1]}` }, { status: 400 });
  });
  return { origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, calls, close: () => server.shutdown() };
}

// Ashby's public posting API and the employer's form, on 127.0.0.1 (as flow-e2e-chat-submit.test.ts serves them).
function ashby() {
  const applications: any[] = [], other: string[] = [];
  const strip = (h: string) => h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace(/\s(src|srcset)="https?:[^"]*"/gi, "").replace(/Crusoe/g, "Ramp");
  const script = `<script>
document.querySelectorAll(".ashby-application-form-input-yesno").forEach((g) => g.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
  e.preventDefault(); g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  const box = g.querySelector("input[type=checkbox]"); if (box) box.checked = b.dataset.option === "yes";
})));
document.querySelectorAll("input[role=combobox]").forEach((inp) => {
  const list = document.createElement("div"); list.setAttribute("role", "listbox"); inp.parentElement.appendChild(list);
  inp.addEventListener("input", () => { list.innerHTML = inp.value ? '<div role="option" tabindex="-1">' + inp.value.replace(/[<>&"]/g, "") + "</div>" : ""; inp.setAttribute("aria-expanded", String(!!inp.value));
    const o = list.firstElementChild; if (o) o.addEventListener("mousedown", (e) => { e.preventDefault(); inp.value = o.textContent; list.innerHTML = ""; inp.setAttribute("aria-expanded", "false"); }); });
});
document.querySelector(".ashby-application-form-submit-button").addEventListener("click", async (e) => {
  e.preventDefault();
  const fieldEntries = [];
  document.querySelectorAll(".ashby-application-form-field-entry").forEach((f) => {
    const field = f.dataset.fieldPath, yes = f.querySelector("button[aria-pressed=true]");
    const input = f.querySelector("input:not([type=file]):not([type=checkbox]), textarea");
    if (yes) fieldEntries.push({ field, value: yes.textContent.trim() });
    else if (input && input.value) fieldEntries.push({ field, value: input.value });
  });
  const file = document.querySelector("[data-field-path=_systemfield_resume] input[type=file]").files[0];
  let bin = ""; if (file) new Uint8Array(await file.arrayBuffer()).forEach((c) => { bin += String.fromCharCode(c); });
  const content = file ? btoa(bin) : null;
  const r = await fetch("/api/non-user-graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction", query: "mutation ApiSubmitSingleApplicationFormAction { submit }",
    variables: { organizationHostedJobsPageName: "ramp", jobPostingId: ${JSON.stringify(JOB_UUID)}, applicationForm: { fieldEntries }, resume: file ? { name: file.name, content } : null } }) });
  if (r.ok) document.body.innerHTML = "<h1>Thank you for applying</h1><p>Application received. Confirmation number: RAMP-TEST-4410.</p>";
});
</script>`;
  const form = strip(Deno.readTextFileSync(CAPTURED)).replace(/<\/body>/i, `${script}</body>`);
  const board = { apiVersion: "1", jobs: [{
    id: JOB_UUID, title: TITLE, location: "New York, NY", departmentName: "Engineering", employmentType: "Intern", isListed: true,
    publishedAt: new Date().toISOString(), jobUrl: LINK, applyUrl: `${LINK}/application`,
    descriptionPlain: "TEST synthetic posting. Build product UI in React and TypeScript with the engineering team.",
  }] };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/posting-api/job-board/ramp") return Response.json(board);
    if (req.method === "GET" && u.pathname === `/ramp/${JOB_UUID}/application`) return new Response(form, { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && u.pathname === "/api/non-user-graphql") {
      const body = await req.json().catch(() => ({}));
      if (/^ApiSubmit/.test(String(body?.operationName))) applications.push(body); else other.push(String(body?.operationName));
      return Response.json({ data: { ok: true } });
    }
    other.push(`${req.method} ${u.pathname}`);
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { origin, form: `${origin}/ramp/${JOB_UUID}/application`, applications, other, close: () => server.shutdown() };
}

Deno.test({
  name: "FEATURE 16 Telegram gold path: /start, resume PDF, yes, 'apply me to this: <link>', asked only what is needed, card with buttons, tap, queued, sent, receipt, 'did it go through?'; and no resume: refused",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the Telegram gold path needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
    const pg = await startPg();
    const site = ashby();
    const PDF = resumePdf(RESUME), PDF_SHA = await hex(PDF);
    const bot = botApi(new Map([["documents/RESUME-FILE-1.pdf", PDF]]));
    const work = await Deno.makeTempDir({ prefix: "trainee-tg-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const outbound: string[] = [];
    const envBefore = new Map(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_DELIVER_SECRET"].map((k) => [k, Deno.env.get(k)]));
    try {
      await supabaseParity(pg);
      agentChat = await careerHandler(pg, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      Deno.env.set("TELEGRAM_BOT_TOKEN", TOKEN);
      Deno.env.set("TELEGRAM_WEBHOOK_SECRET", SECRET);
      Deno.env.set("TRAINEE_ALLOWED_CONTACTS", `telegram:${CHAT},telegram:${NO_RESUME_CHAT}`);
      Deno.env.set("TRAINEE_DELIVER_SECRET", "TEST-deliver-secret-0123456789-abcdefgh");
      // Every outbound request: the Supabase double, agent-chat (the real handler), Telegram's and Ashby's local servers.
      const double = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin || u.hostname === "127.0.0.1") return double(req);
        outbound.push(u.href);
        if (u.hostname === "api.telegram.org") return double(new Request(`${bot.origin}${u.pathname}${u.search}`, req));
        if (u.hostname === "api.ashbyhq.com") return double(new Request(`${site.origin}${u.pathname}${u.search}`, req));
        return Promise.reject(new Error(`the Telegram test reaches no real host: ${u.href}`));
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      // The webhook, composed as supabase/functions/trainee-telegram/index.ts composes it.
      let update = 900;
      const post = async (body: Record<string, unknown>, id = ++update) => {
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, {
          method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: id, ...body }),
        }), { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY), admin,
          deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        eq(res.status, 200, await res.clone().text());
        return { id, body: await res.json() };
      };
      let msgId = 100;
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      // What Trainee said to a chat since a mark: each sendMessage to that chat id, in order.
      const said = (chat: number, since: number) => bot.calls.slice(since).filter((c) => c.method === "sendMessage" && c.body.chat_id === chat);
      const text = async (chat: number, words: string, extra: Record<string, unknown> = {}) => {
        const mark = bot.calls.length;
        const r = await post({ message: { message_id: ++msgId, ...from(chat), text: words, ...extra } });
        const out = said(chat, mark);
        assert(out.length >= 1, `Trainee answered "${words}" on Telegram: ${JSON.stringify(r.body)} ${JSON.stringify(bot.calls.slice(mark))}`);
        for (const c of out) assert(typeof c.body.text === "string" && c.body.text.length <= 4096 && c.body.parse_mode === undefined, `plain text under Telegram's limit: ${JSON.stringify(c.body).slice(0, 300)}`);
        return { reply: out.map((c) => c.body.text).join("\n\n"), calls: out, result: r.body };
      };
      const q1 = async (sql: string) => await pg.sql(sql);
      const PERSON = async (chat: number) => await q1(`select coalesce(user_id::text, '') from public.channel_contacts where contact = 'tg:${chat}'`);
      let person = "";
      // Every reply Trainee queued went out: each outbox row for the person delivered, to their Telegram chat, with the id Telegram gave.
      const allDelivered = async (who: string) => {
        const rows = JSON.parse(await q1(`select coalesce(json_agg(json_build_object('key', key, 'status', status, 'contact', contact, 'provider_id', provider_id) order by id), '[]') from public.career_outbox where user_id = '${who}'`));
        for (const r of rows) assert(r.status === "delivered" && r.contact === `tg:${CHAT}` && /^\d+$/.test(String(r.provider_id)), `outbox row delivered to this chat: ${JSON.stringify(r)}`);
        return rows;
      };

      const svc = pg.asService();
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => { await memory.put(path, pdf); await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`); },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, "--script-submit", "ashby"] });
      const deps = { db: svc, runEngine, profileFor: storedProfile(svc), urlFor: () => site.form, resumeFor: tailoredResume({ render: edgeRenderer(), resumes }) };
      const prepare = async () => (await prepareAhead(deps, { only: { user_id: person, job_ids: [KEY] } })).map((d) => d.outcome);
      const open = async () => await q1(`select coalesce(string_agg(key, ',' order by key), '') from public.career_apply_questions where user_id = '${person}' and state = 'open'`);
      // One question at a time (review of #360): each answered in chat, in their words, as it is asked.
      const answer = async (answers: [RegExp, string][]) => {
        const r = await answerOneByOne((m) => text(CHAT, m), answers);
        assert(!/doesn't fit|does not fit|isn't one of/i.test(r.saved), `their answers are taken: ${r.saved}`);
      };
      const jobs = async () => JSON.parse(await q1(`select coalesce(json_agg(row_to_json(j)), '[]') from public.career_apply_jobs j where user_id = '${person}'`));

      await t.step("1. /start: an account for this chat; the welcome goes out through the outbox to this chat id", async () => {
        const r = await text(CHAT, "/start");
        person = await PERSON(CHAT);
        assert(/^[0-9a-f-]{36}$/.test(person), `an account was made for the chat: ${person}`);
        // Supabase Auth takes a user only with an email or a phone; a Telegram chat gives neither, so the account carries an
        // undeliverable, channel-only address (trainee-inbound/store.ts createPerson).
        eq(await q1(`select email from auth.users where id = '${person}'`), `tg-${CHAT}@users.trainee.invalid`);
        eq(await q1(`select count(*) from auth.users where email like 'tg-%@users.trainee.invalid'`), "1");
        assert(r.calls.every((c) => c.body.chat_id === CHAT), "to this chat");
        await allDelivered(person);
      });

      await t.step("2. the resume as a PDF: downloaded, its bytes and sha256 stored with the upload's reference; each entry shown", async () => {
        const mark = bot.calls.length;
        const docUpdate = { message: { message_id: ++msgId, ...from(CHAT), document: { file_id: "RESUME-FILE-1", file_unique_id: "AgADTESTresume1", file_name: "Alex_Testcase_Resume.pdf", mime_type: "application/pdf", file_size: PDF.length } } };
        const sent = await post(docUpdate);
        const calls = bot.calls.slice(mark);
        // Telegram retries the same update: nothing is downloaded, stored or said again.
        const before = bot.calls.length;
        eq((await post(docUpdate, sent.id)).body.results?.[0]?.ignored, "duplicate webhook");
        eq(bot.calls.length, before, "a retried document update calls Telegram for nothing");
        assert(calls.some((c) => c.method === "getFile" && c.body.file_id === "RESUME-FILE-1"), JSON.stringify(calls.map((c) => c.method)));
        assert(calls.some((c) => c.method === "download" && c.body.path === "documents/RESUME-FILE-1.pdf"), "the file itself was downloaded");
        const up = JSON.parse(await q1(`select json_agg(row_to_json(u)) from public.career_resume_uploads u where user_id = '${person}'`));
        eq(up.length, 1);
        eq([up[0].channel, up[0].provider_ref, up[0].filename, up[0].mime, up[0].bytes, up[0].sha256], ["telegram", "telegram:AgADTESTresume1", "Alex_Testcase_Resume.pdf", "application/pdf", PDF.length, PDF_SHA]);
        const stored = Uint8Array.from(atob(up[0].content_b64), (c) => c.charCodeAt(0));
        eq(await hex(stored), PDF_SHA, "the stored bytes are the file, byte for byte");
        const reply = said(CHAT, mark).map((c) => c.body.text).join("\n");
        assert(/Here is what I read/.test(reply) && reply.includes("Software Engineering Intern, TEST Systems Inc"), reply.slice(0, 600));
        // The thread holds the file's text as the person's message, and that message is the one the upload is bound to.
        const msg = await q1(`select encode(sha256(convert_to(content, 'UTF8')), 'hex') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${person}' and m.role = 'user' and m.content like 'here is my resume:%'`);
        eq(msg, up[0].message_sha256, "the upload is bound to the message the chat read");
        eq(await q1(`select count(*) from public.career_events where user_id = '${person}' and kind = 'fact_confirmed'`), "0", "nothing is confirmed by the upload");
      });

      await t.step("3. 'yes, that's my resume': a fact_confirmed event per entry, each naming the file's reference and sha256", async () => {
        const r = await text(CHAT, "yes, that's my resume");
        assert(!/stay drafts|Nothing from your resume is confirmed/.test(r.reply), r.reply);
        const ev = JSON.parse(await q1(`select json_agg(detail) from public.career_events where user_id = '${person}' and kind = 'fact_confirmed'`));
        assert(ev.length >= 8, `one event per entry: ${ev.length}`);
        for (const d of ev) eq([d.upload?.kind, d.upload?.sha256, String(d.upload?.ref).startsWith("telegram:AgADTESTresume1")], ["file", PDF_SHA, true], JSON.stringify(d));
        // Every later message from this chat is the same account: still one user for the chat, one contact row.
        eq(await q1(`select count(*) from auth.users where email = 'tg-${CHAT}@users.trainee.invalid'`), "1");
        eq(await q1(`select string_agg(user_id::text, ',') from public.channel_contacts where contact = 'tg:${CHAT}'`), person);
        eq(await q1(`select public.career_resume_on_file('${person}')`), "t");
      });

      await t.step("4. 'apply me to this: <link>': read from Ashby, stored, queued; the reply matches the queue row", async () => {
        const r = await text(CHAT, `apply me to this: ${LINK}`);
        assert(/^1\/1 queued/.test(r.reply) && r.reply.includes(TITLE), r.reply);
        eq(await q1(`select string_agg(posting_key || ' ' || state, ',') from public.career_apply_wanted where user_id = '${person}'`), `${KEY} waiting`, "the 'queued' reply has its queue row");
        eq((await jobs()).length, 0, "nothing approved");
        eq(site.applications.length, 0);
      });

      await t.step("5. only what is needed is asked, one question at a time, answered in chat", async () => {
        eq(await prepare(), ["asked"]);
        eq(await open(), "fact:email,fact:first_name,fact:last_name");
        await answer([[/First name/i, "Alex"], [/Last name/i, "Testcase"], [/Email/i, "alex.testcase@example.test"]]);
        eq(await open(), "");
        eq(await prepare(), ["asked"]);
        const asked = await q1(`select string_agg(label, ' | ' order by label) from public.career_apply_questions where user_id = '${person}' and state = 'open'`);
        assert(!/first name|last name|email/i.test(asked), `nothing known is asked again: ${asked}`);
        await answer([[/sponsorship/i, "no"], [/currently work for Ramp/i, "no"], [/state, province, or region/i, "Illinois"]]);
        eq(await open(), "");
        eq(site.applications.length, 0, "a dry run sends nothing");
        eq(await prepare(), ["ready"]);
      });

      let card: any = null, prepared: any = null, cardMsg = 0, buttons: any[] = [];
      await t.step("6a. 'show my applications': the card with every exact answer, Approve and Decline bound to the card id and hash", async () => {
        const r = await text(CHAT, "show my applications");
        prepared = JSON.parse(await q1(`select row_to_json(p) from public.career_apply_prepared p where user_id = '${person}'`));
        card = JSON.parse(await q1(`select row_to_json(c) from public.career_apply_cards c where user_id = '${person}' and state = 'open'`));
        eq(card.items.map((i: any) => i.payload_hash), [prepared.payload_hash], "the card carries the prepared payload's hash");
        for (const f of prepared.payload.fields.filter((x: any) => typeof x.value === "string" && x.name !== "_systemfield_resume")) {
          assert(r.reply.includes(f.value), `the card shows ${f.label} = ${f.value}: ${r.reply}`);
        }
        assert(/Resume: .*tailored for this role \([0-9a-f]{12}\)/.test(r.reply), r.reply);
        const last = r.calls.at(-1)!;
        buttons = last.body.reply_markup?.inline_keyboard?.flat() ?? [];
        const d = await cardDigest(card);
        eq(buttons.map((b: any) => [b.text, b.callback_data]), [["Approve", `tca:${card.id}:${d}`], ["Decline", `tcd:${card.id}:${d}`]]);
        assert(buttons.every((b: any) => new TextEncoder().encode(b.callback_data).length <= 64), "callback_data fits Telegram's 64 bytes");
        const row = JSON.parse(await q1(`select row_to_json(o) from public.career_outbox o where user_id = '${person}' and card_id = '${card.id}'`));
        cardMsg = Number(row.provider_id);
        eq([row.status, row.contact], ["delivered", `tg:${CHAT}`]);
        eq(cardMsg, bot.calls.filter((c) => c.method === "sendMessage").indexOf(last) + 5000, "the outbox recorded the id Telegram gave the card's message");
      });

      const tap = async (data: string, id = `cbq-${++update}`, updateId?: number) => {
        const mark = bot.calls.length;
        const r = await post({ callback_query: { id, from: { id: CHAT, is_bot: false }, message: { message_id: cardMsg, chat: { id: CHAT, type: "private" }, date: 1 }, data } }, updateId);
        return { r, calls: bot.calls.slice(mark), id };
      };
      await t.step("6b. an unclear reply, a forged button, a changed card and a late reply-yes approve nothing", async () => {
        // D-MS-1 (owner, 2026-10-27; replaces the reply-only rule): a plain "yes" right after the card would approve it
        // (mass-submit-*.test.ts). Here an unclear "maybe" approves nothing and the card stays open for the tap below.
        const maybe = await text(CHAT, "maybe");
        assert(/nothing was approved/i.test(maybe.reply), maybe.reply);
        const forged = await tap(`tca:${card.id}:${"0".repeat(16)}`);
        const ans = forged.calls.find((c) => c.method === "answerCallbackQuery");
        eq([ans?.body.callback_query_id, ans?.body.text], [forged.id, "Nothing was approved."]);
        assert(said(CHAT, 0).at(-1)!.body.text.includes("That card changed after it was shown"), "said in the chat");
        // The prepared application changed after the card was shown: its button approves nothing.
        await q1(`set session_replication_role = replica; update public.career_apply_prepared set payload_hash = repeat('9', 64) where id = '${prepared.id}'; set session_replication_role = origin;`);
        const changed = await tap(buttons[0].callback_data);
        assert(changed.calls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "Nothing was approved."), JSON.stringify(changed.calls));
        await q1(`set session_replication_role = replica; update public.career_apply_prepared set payload_hash = '${prepared.payload_hash}' where id = '${prepared.id}'; set session_replication_role = origin;`);
        // A typed yes in direct reply to the card follows the card's yes window (D-031): shown more than 10 minutes ago, it
        // approves nothing. The reply id resolves to this card through the outbox's record of Telegram's message id.
        const shownAt = await q1(`select shown_at from public.career_apply_cards where id = '${card.id}'`);
        await q1(`update public.career_apply_cards set shown_at = now() - interval '11 minutes' where id = '${card.id}'`);
        const late = await text(CHAT, "yes", { reply_to_message: { message_id: cardMsg, chat: { id: CHAT, type: "private" }, date: 1 } });
        assert(/shown more than 10 minutes ago/.test(late.reply) && /nothing was sent/.test(late.reply), late.reply);
        await q1(`update public.career_apply_cards set shown_at = '${shownAt}' where id = '${card.id}'`);
        eq((await jobs()).length, 0, "nothing queued");
        eq(await q1(`select state from public.career_apply_cards where id = '${card.id}'`), "open");
      });

      await t.step("6c. the tap: exactly one queue row bound to the approval hash; the button answered once; the queued message to this chat", async () => {
        const approved = await tap(buttons[0].callback_data, "cbq-approve");
        const answers = approved.calls.filter((c) => c.method === "answerCallbackQuery");
        eq(answers.map((c) => [c.body.callback_query_id, c.body.text]), [["cbq-approve", "Approved."]]);
        const msg = approved.calls.filter((c) => c.method === "sendMessage");
        eq(msg.length, 1);
        eq(msg[0].body.chat_id, CHAT);
        assert(/1 approved exactly as shown\. Nothing has gone to an employer yet\./.test(msg[0].body.text) && /Ramp: approved/.test(msg[0].body.text), msg[0].body.text);
        const j = await jobs();
        eq(j.length, 1, "the 'approved' message has exactly one queue row");
        eq([j[0].state, j[0].approval_hash, j[0].payload_hash, j[0].company], ["queued", prepared.payload_hash, prepared.payload_hash, "Ramp"]);
        eq(await q1(`select public.career_apply_payload_hash(payload) = '${prepared.payload_hash}' from public.career_apply_jobs where user_id = '${person}'`), "t", "the queued payload is the one the card showed");
        eq(await q1(`select state from public.career_apply_cards where id = '${card.id}'`), "answered");
        // The same webhook again (Telegram retries an update it got no answer for): nothing runs twice.
        const retry = await tap(buttons[0].callback_data, "cbq-approve", approved.r.id);
        eq(retry.r.body.results?.[0]?.ignored, "duplicate webhook");
        eq(retry.calls.length, 0, "a retried update sends nothing");
        // A second tap: answered, nothing more.
        const again = await tap(buttons[0].callback_data, "cbq-again");
        assert(again.calls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "Already answered."), JSON.stringify(again.calls));
        eq((await jobs()).length, 1, "no second row");
        const back = await text(CHAT, "did it go through?");
        assert(/approved, not sent yet/.test(back.reply), back.reply);
      });

      await t.step("7. the sender: one POST with exactly the card's values and the approved resume file; finish = what the form returned; the receipt to this chat", async () => {
        const queue = ownQueue(pg.asPerson(person));
        let sentResume: Uint8Array | null = null;
        const done = await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => {
            const path = `${work}/sent-resume.pdf`;
            sentResume = memory.files.get(`career-resumes/${person}/${job.payload.resume_sha256}.pdf`)!;
            await Deno.writeFile(path, sentResume);
            return { path, sha256: job.payload.resume_sha256 };
          },
          writeFacts: async (_job, facts) => { const p = `${work}/approved-facts.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; },
          runEngine,
        });
        eq(done.length, 1);
        eq(site.applications.length, 1, `exactly one application POST: ${JSON.stringify(site.other)}`);
        const v = site.applications[0].variables;
        eq(v.jobPostingId, JOB_UUID);
        const got = new Map((v.applicationForm.fieldEntries as any[]).map((e) => [e.field, e.value]));
        for (const f of prepared.payload.fields.filter((x: any) => typeof x.value === "string" && x.name !== "_systemfield_resume")) {
          assert(got.has(f.name), `the form got ${f.label}: ${JSON.stringify([...got])}`);
          eq(String(got.get(f.name)).toLowerCase(), String(f.value).toLowerCase(), `${f.label} as approved`);
        }
        eq(got.size, prepared.payload.fields.filter((x: any) => typeof x.value === "string" && x.name !== "_systemfield_resume").length, "nothing the card did not show");
        const posted = Uint8Array.from(atob(v.resume.content), (c) => c.charCodeAt(0));
        eq(await hex(posted), prepared.payload.resume_sha256, "the resume file the form got is the one approved, byte for byte");
        eq(await hex(sentResume!), prepared.payload.resume_sha256);
        const j = (await jobs())[0];
        eq([j.state, j.confirmation_id], ["submitted_unconfirmed", "RAMP-TEST-4410"], "the page's confirmation, recorded as not confirmed by the employer");
        // The receipt: the scheduled run queues it, trainee-deliver sends it to this chat.
        const mark = bot.calls.length;
        const n = await runReceipts({ outbox: supabaseAlertStore(admin), now: Date.now(), finished: async (since) => {
          const { data, error } = await admin.from("career_apply_jobs").select("id,user_id,company,url,state,reason,confirmation_id,email_confirmed_at,evidence,source")
            .in("state", ["confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"]).gte("updated_at", since).limit(2000);
          if (error) throw new Error(error.message);
          return data ?? [];
        } });
        eq(n, 1);
        const run = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": Deno.env.get("TRAINEE_DELIVER_SECRET")! } }), {
          env: Deno.env, now: Date.now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }),
          adapters: (env) => adaptersFromEnv(env),
          recordRun: async (r) => { const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out, capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 }); if (error) throw new Error(error.message); },
        });
        eq((await run.json()).delivered, 1);
        const receipt = said(CHAT, mark);
        eq(receipt.length, 1);
        assert(/^Sent to Ramp\./.test(receipt[0].body.text) && /has not confirmed it yet|their confirmation email is the proof/.test(receipt[0].body.text), receipt[0].body.text);
        eq(await q1(`select status || ' ' || contact from public.career_outbox where user_id = '${person}' and key = 'receipt:${j.id}'`), `delivered tg:${CHAT}`);
      });

      await t.step("8. 'did it go through?': the recorded state, as recorded; every reply went out to this chat", async () => {
        const r = await text(CHAT, "did it go through?");
        assert(/submitted/.test(r.reply) && /has not confirmed it yet/.test(r.reply) && /RAMP-TEST-4410/.test(r.reply), r.reply);
        assert(!/confirmed it\b(?! yet)|successful/i.test(r.reply.replace("has not confirmed it yet", "")), r.reply);
        eq((await jobs())[0].state, "submitted_unconfirmed", "the reply's state is the row's");
        await allDelivered(person);
        eq(site.applications.length, 1, "still exactly one application");
      });

      await t.step("9. unlink (review of PR #194): a chat that is its own account is not unlinked; linked to a web account, unlinked, it comes back to its own account", async () => {
        const contactOwner = async () => await q1(`select coalesce(user_id::text, '') from public.channel_contacts where contact = 'tg:${CHAT}'`);
        const refused = await text(CHAT, "unlink telegram");
        eq(refused.reply, TELEGRAM_CHANNEL_ONLY_REPLY);
        eq(await contactOwner(), person, "the chat is still its account");
        // The person signs in on the web and links this Telegram account with Telegram's login: the chat moves there.
        const WEB = "7b0f8f8e-6a43-4a49-9d2c-0000000000f9";
        await q1(`insert into auth.users (id, email) values ('${WEB}', 'alex.web@example.test'); insert into public.profiles (id) values ('${WEB}');`);
        const fields = { id: String(CHAT), first_name: "TEST", auth_date: String(Math.floor(Date.now() / 1000)) };
        const res = await handleTelegramLink(new Request("http://x/trainee-telegram-link", { method: "POST", headers: { authorization: "Bearer web-tok", "content-type": "application/json" },
          body: JSON.stringify({ action: "link", auth: { ...fields, hash: await loginHash(fields, TOKEN) } }) }),
          { env: Deno.env, now: Date.now, userOf: async (t) => (t === "web-tok" ? WEB : null), rpc: async (n, a) => await svc.rpc(n, a) });
        eq([(await res.json()).outcome, await contactOwner()], ["linked", WEB]);
        const unlinked = await text(CHAT, "unlink telegram");
        eq(unlinked.reply, TELEGRAM_UNLINKED_REPLY);
        eq(await contactOwner(), "", "the chat belongs to no account");
        // Its next message: a second sign-up would be refused (the address is taken); the chat returns to its own account.
        const back = await text(CHAT, "hi");
        assert(!/couldn't answer/i.test(back.reply), back.reply);
        eq(await contactOwner(), person, "reattached to its own account");
        eq(await q1(`select count(*) from auth.users where email = 'tg-${CHAT}@users.trainee.invalid'`), "1", "no second account");
      });

      await t.step("no resume: 'apply me to this: <link>' is refused in plain words; nothing queued, no card, nothing sent", async () => {
        await text(NO_RESUME_CHAT, "/start");
        const other = await PERSON(NO_RESUME_CHAT);
        assert(/^[0-9a-f-]{36}$/.test(other) && other !== person);
        eq(await q1(`select email from auth.users where id = '${other}'`), `tg-${NO_RESUME_CHAT}@users.trainee.invalid`, "a second chat is a second account");
        const r = await text(NO_RESUME_CHAT, `apply me to this: ${LINK}`);
        assert(/^0\/1 queued/.test(r.reply) && /no resume on file/.test(r.reply) && /Paste or attach your resume, confirm it, then ask again\./.test(r.reply), r.reply);
        eq(await q1(`select count(*) from public.career_apply_wanted where user_id = '${other}'`), "0", "no queue row");
        const shown = await text(NO_RESUME_CHAT, "show my applications");
        assert(/no confirmed resume on file/.test(shown.reply) && /attach it as a PDF or Word file, or paste it here/.test(shown.reply), shown.reply);
        eq(await q1(`select (select count(*) from public.career_apply_cards where user_id = '${other}') + (select count(*) from public.career_apply_prepared where user_id = '${other}') + (select count(*) from public.career_apply_jobs where user_id = '${other}')`), "0");
        eq(site.applications.length, 1, "nothing more sent to the employer");
        // Someone else's button, tapped from this chat: not their card, nothing approved, nothing queued for anyone.
        const mark = bot.calls.length;
        await post({ callback_query: { id: "cbq-foreign", from: { id: NO_RESUME_CHAT, is_bot: false }, message: { message_id: cardMsg, chat: { id: NO_RESUME_CHAT, type: "private" }, date: 1 }, data: buttons[0].callback_data } });
        eq(bot.calls.slice(mark).filter((c) => c.method === "answerCallbackQuery").map((c) => [c.body.callback_query_id, c.body.text]), [["cbq-foreign", "Nothing was approved."]]);
        eq([await q1(`select count(*) from public.career_apply_jobs where user_id = '${other}'`), (await jobs()).length], ["0", 1]);
        assert(bot.calls.every((c) => c.method === "download" || [CHAT, NO_RESUME_CHAT].includes(c.body.chat_id) || c.method === "getFile" || c.method === "answerCallbackQuery"), "every Bot API call was for these two chats");
        assert(outbound.every((u) => u.startsWith("https://api.telegram.org/") || u.startsWith("https://api.ashbyhq.com/")), `no other host: ${outbound}`);
        assert(outbound.filter((u) => u.startsWith("https://api.telegram.org/")).every((u) => u.includes(`/bot${TOKEN}/`) || u.includes(`/file/bot${TOKEN}/`)));
      });
    } finally {
      agentChat?.restore();
      for (const [k, v] of envBefore) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
      await site.close();
      await bot.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
