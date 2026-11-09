// R10 (owner order 2026-11-09), WO-I: the world the R10 acceptance suite replays in. It is the Telegram acceptance suite's
// composition (tests/architect/telegram-acceptance.test.ts: the REAL trainee-telegram webhook as index.ts composes it, the
// REAL agent-chat handler on the live brain's path, a real Postgres 16 with every migration behind the PostgREST double, the
// release flags at their release values) plus what the R10 gate needs to judge OUTPUTS, not words:
//   - every document a reply carries is captured byte for byte (sendDocument's multipart body), and opened: a PDF's text
//     with the product's own reader (channel_resume_upload.ts fileText) and, where installed, poppler's pdftotext, its page
//     count, its font sizes and its text positions; a DOCX's text from word/document.xml;
//   - every link a reply carries is followed: a File link opens through the REAL trainee-file handler (buildFileDeps, as
//     index.ts serves it), signed in the way the person signs in from Telegram (the Mini App's signed initData for the
//     person's own chat id), and what comes back is a PDF (opened as above) or a page (rendered in Chromium at 390 px,
//     deviceScaleFactor 2, and screenshotted);
//   - employer pages answer only inside this double: an "open" posting's page names the role, a "closed" one is a 404, a
//     "blocked" one refuses (403); every page request is recorded, so a reply that calls a role open can be checked against
//     whether its page was ever opened;
//   - the model is a $0 scripted stand-in at the Anthropic URL. The staged brain's turns (a request that offers tools) get a
//     fixed sentence with no tool call (BRAIN_STUB): a deliverable (a file, a listing, a link) can only come from code the
//     suite can inspect, never from the stub, so a pass is never the fake model's words.
// Every test of the suite records its evidence (item, test, PASS/FAIL, why, files, screenshots, reply excerpt) to
// R10_EVIDENCE_DIR/evidence.jsonl, which scripts/r10-acceptance-report.ts reads. Nothing leaves the machine: any other host
// is refused and recorded.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { virtualClock } from "../../flow/virtual-clock.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../../flow/handler.ts";
import { fakeBot, plainOf } from "../scenarios/telegram-bot-api.ts";
import { anthropicWire } from "./anthropic_wire.ts";
import { INTAKE_RESUME, MARKET, OLD_LIST, OLD_SEARCH, type Seeded } from "./r10_turns.ts";

export const ITEMS: Record<number, string> = {
  1: "Keep the requested target through the whole task",
  2: "Make corrections repair the current task",
  3: "Use supplied resume facts without inventing or repeatedly asking",
  4: "Deliver real, inspectable files and honest file claims",
  5: "Turn job searches into usable results",
  6: "Verify openings and separate fit from eligibility",
  7: "Handle limits without abandoning or misrepresenting work",
  8: "Make replies useful, direct and evidence-based",
  9: "Build a coherent visual system for every File family",
  10: "Fix entry/recovery layout and verify real sign-in",
  11: "Make account connections explicit and recoverable",
  12: "Make application review an exact, usable approval artifact",
  13: "Make application execution and proof match reality",
  14: "Make research and follow-up drafts concrete and sourced",
  15: "Prove fixes with end-to-end acceptance, then verify deployment",
};

export const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
export const TOKEN = "123456:TEST-r10-acceptance-token-not-real", SECRET = "TEST_r10_acceptance_webhook_secret_0123456789";
export const FILE_BASE = "https://trainee.test/file", FILE_SECRET = "TEST-r10-file-link-secret-0123456789abcdef";
export const BRAIN_STUB = "BRAIN_STUB: the fake model made no tool call.";
// SCRIPTED BRAIN (architect ruling 2026-11-09): only where an order's fix depends on the brain choosing a tool (research through
// a tool, for one). A fixture, $0 and deterministic: the first step whose pattern matches the person's latest message answers
// with that tool call (only when the request offers that tool; otherwise it says so in words and the check fails on it); once
// the tool's result is back, the step's `after` text (or the stub) is the brain's answer. Code-delivered fixes still run with
// the plain stub; the live replay with the real model is the final check. Evidence labels such a check "scripted brain: <name>".
export interface BrainScript { name: string; steps: { when: RegExp; tool: string; input: Record<string, unknown>; after?: string }[] }
const lastUserText = (body: any) => {
  for (const m of [...(body.messages ?? [])].reverse()) if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  return "";
};
const enc = new TextEncoder();

// ------------------------------------------------------------------------------------------------ evidence
export interface Evidence { item: number; test: string; file: string; outcome: "PASS" | "FAIL" | "NOT_RUN"; brain?: string; why?: string; files?: string[]; screenshots?: string[]; reply?: string; turns?: number; scenario?: string; target?: string; model_calls?: number }
export async function record(e: Evidence) {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.writeTextFile(`${EVIDENCE_DIR}/evidence.jsonl`, JSON.stringify({ ...e, reply: e.reply?.slice(0, 1200), at: new Date().toISOString() }) + "\n", { append: true });
}
// One acceptance check: runs as a Deno step, records PASS or FAIL with what it opened, and fails the step on FAIL (these tests
// are the gate for the R10 orders; a failure is never swallowed). `ev` collects files, screenshots and the reply as it goes.
export type Ev = { files: string[]; screenshots: string[]; reply: string; turns: number; scenario?: string; target?: string };
export async function check(t: Deno.TestContext, file: string, item: number, name: string, fn: (ev: Ev) => Promise<void>, w?: World): Promise<boolean> {
  const ev: Ev = { files: [], screenshots: [], reply: "", turns: 0 };
  return await t.step(`fix ${item}: ${name}`, async () => {
    const calls0 = w?.modelCalls() ?? 0;
    try {
      await fn(ev);
      await record({ item, test: name, file, outcome: "PASS", brain: w?.brainLabel ?? "stub", ...ev, model_calls: (w?.modelCalls() ?? 0) - calls0 });
    } catch (e) {
      const why = String((e as Error)?.message ?? e).split("\n").slice(0, 8).join(" | ").slice(0, 900);
      await record({ item, test: name, file, outcome: "FAIL", why, brain: w?.brainLabel ?? "stub", ...ev, model_calls: (w?.modelCalls() ?? 0) - calls0 });
      throw e;
    }
  });
}
export async function notRun(file: string, items: number[], why: string) {
  for (const item of items) await record({ item, test: `(${file} not run)`, file, outcome: "NOT_RUN", why });
  console.log(`NOT_RUN ${file}: ${why}`);
}
// Whether this machine can run the world (Postgres 16, not root outside CI). In CI a missing piece is a failure, never a skip.
export function canRun(file: string): string | null {
  if (!pgBinDir()) { if (CI) throw new Error(`${file} needs Postgres 16 binaries in CI`); return "no Postgres 16 binaries"; }
  if (Deno.uid?.() === 0 && !CI) return "running as root (initdb refuses root); run as an unprivileged user, or with CI=true where pg.ts drops to postgres";
  return null;
}

export { CI, closeBrowser, EVIDENCE_DIR, inspectDocx, inspectPdf, pdfOf, playwright, renderOpened, renderPhone, ROOT, saveFile } from "./r10_inspect.ts";
export type { PdfInspection, Rendered } from "./r10_inspect.ts";
import { CI, closeBrowser, EVIDENCE_DIR, inspectDocx, inspectPdf, type PdfInspection, pdfOf, saveFile } from "./r10_inspect.ts";
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);


// ------------------------------------------------------------------------------------------------ the world
export interface Doc { chat: string; filename: string; mime: string; bytes: Uint8Array; at: number }
export interface Said { id: number; reply: string; bubbles: string[]; buttons: { text: string; callback_data?: string; url?: string; web_app?: { url: string } }[]; docs: Doc[]; links: string[]; pageChecks: string[] }
// csp: the Content-Security-Policy the browser gets for this page in production: the function's own policy, relayed past the
// gateway (page_csp.ts relayPageCsp) and chosen by the site's proxy (api/_page_csp.js pageCsp), so a render obeys it.
export interface Opened { url: string; status: number; type: string; bytes: Uint8Array; html: string | null; csp?: string; why?: string }
export interface World {
  pg: Pg; sql(s: string): Promise<string>; json(s: string): Promise<any[]>; admin: any;
  say(chat: number, words: string): Promise<Said>;
  upload(chat: number, filename: string, bytes: Uint8Array, caption?: string): Promise<Said>;
  personOf(chat: number): Promise<string>;
  // The R10 context (spec A.2): an account with an earlier resume intake (uploaded as a PDF, confirmed), an old job list (the
  // five ML roles, the first being the Reddit manager role), and the original file no longer available.
  observedPerson(chat: number): Promise<string>;
  open(url: string, chat: number): Promise<Opened>;
  brainLabel: string; pageChecks: string[]; outbound: string[]; modelCalls(): number; brainCalls(): number; turns(): number; bot: ReturnType<typeof fakeBot>;
  stop(): Promise<void>;
}
const KEYS = ["CAREER_BRAIN", "CAREER_NETWORKING_DRAFT", "ANTHROPIC_API_KEY", "CAREER_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TRAINEE_SIGNUP",
  "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_DELIVER_SECRET", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "TRAINEE_FILE_BASE_URL",
  "TRAINEE_FILE_LINK_SECRET", "TRAINEE_BOT_URL", "TRAINEE_CONNECT_BASE_URL", "TRAINEE_CONNECT_LINK_SECRET", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "SUPABASE_URL"];

export async function world(o: { chats: number[]; market?: Seeded[]; brain?: BrainScript }): Promise<World> {
  const { RELEASE_FLAGS, RELEASE_NEVER_ON, RELEASE_PENDING } = await import("../../../supabase/functions/agent-chat/release_config.ts");
  const keys = [...KEYS, ...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, ...Object.keys(RELEASE_PENDING)];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const k of keys) Deno.env.delete(k);
  const pg = await startPg();
  await supabaseParity(pg);
  const h = await careerHandler(pg, {});
  const { handleChat } = await import("../../../supabase/functions/agent-chat/handler-career.ts");
  const { handleTelegram } = await import("../../../supabase/functions/trainee-telegram/handler.ts");
  const { chatThroughAgent, deliverer } = await import("../../../supabase/functions/_shared/channel_runtime.ts");
  const { supabaseInboundStore } = await import("../../../supabase/functions/trainee-inbound/store.ts");
  const { handleFile } = await import("../../../supabase/functions/trainee-file/handler.ts");
  const { buildFileDeps } = await import("../../../supabase/functions/trainee-file/deps.ts");
  const { verifyFileToken } = await import("../../../supabase/functions/_shared/file_link.ts");
  const pace = virtualClock();
  const bot = fakeBot({ token: TOKEN, now: pace.clock });
  const realFetch = globalThis.fetch, viaDouble = globalThis.fetch;
  const outbound: string[] = [], pageChecks: string[] = [], docs: Doc[] = [];
  const telegramFiles = new Map<string, Uint8Array>();
  const market = o.market ?? MARKET;
  let modelCalls = 0, brainCalls = 0;
  const fakeModel = (body: any): Response => {
    modelCalls++;
    if (Array.isArray(body.tools) && body.tools.length) {
      brainCalls++;
      const say = (content: string, tool_calls?: unknown[]) => Response.json({ id: "chatcmpl-brain", model: body.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 400, completion_tokens: 20 } });
      const step = o.brain?.steps.find((x) => x.when.test(lastUserText(body)));
      if (!step) return say(BRAIN_STUB);
      if ((body.messages ?? []).at(-1)?.role === "tool") return say(step.after ?? BRAIN_STUB);
      const offered = body.tools.map((x: any) => x.function?.name ?? x.name);
      if (!offered.includes(step.tool)) return say(`SCRIPTED_BRAIN: the tool ${step.tool} is not offered (offered: ${offered.join(", ")})`);
      return say("", [{ id: `toolu_r10_${brainCalls}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.input) } }]);
    }
    // Any other writer (a draft, a rewrite, a judge): a plain sentence that states no fact.
    return Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "MODEL_STUB" }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 10 } });
  };
  const employerPage = (u: URL): Response | null => {
    const hit = [...market, ...OLD_LIST.map((x) => ({ ...x, page: "open" as const }))].find((p) => { const id = p.url.split("/").pop()!; return u.pathname.includes(`/${id}`) && (u.host === new URL(p.url).host || u.host.endsWith(new URL(p.url).host.split(".").slice(-2).join("."))); });
    if (!hit) return null;
    pageChecks.push(hit.url);
    if (hit.page === "closed" || hit.page === "stale") return new Response("<html><body><h1>This job is no longer available</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
    if (hit.page === "blocked") return new Response("Access denied", { status: 403, headers: { "content-type": "text/plain" } });
    if (/api|boards-api/.test(u.host)) return Response.json({ id: hit.url.split("/").pop(), title: hit.title, location: { name: hit.location }, content: hit.description, absolute_url: hit.url });
    return new Response(`<html><head><title>${hit.title} - ${hit.company}</title></head><body><h1>${hit.title}</h1><p>${hit.company} · ${hit.location}</p><p>${hit.description}</p><a href="${hit.url}/apply">Apply for this job</a></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  const fileDeps = () => buildFileDeps(admin, Deno.env, Date.now);
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
    if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
    if (u.host === "api.telegram.org") {
      const file = new RegExp(`^/file/bot${TOKEN.replace(/:/g, ":")}/(.+)$`).exec(decodeURIComponent(u.pathname));
      if (file) { const b = telegramFiles.get(file[1]); return b ? new Response(b as BodyInit) : new Response("no", { status: 404 }); }
      if (u.pathname.endsWith("/getFile")) {
        const id = JSON.parse(await req.clone().text()).file_id, path = `documents/${id}`;
        const b = telegramFiles.get(path);
        return b ? Response.json({ ok: true, result: { file_id: id, file_unique_id: `u-${id}`, file_size: b.length, file_path: path } }) : Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
      }
      if (u.pathname.endsWith("/sendDocument")) {
        const form = await req.clone().formData();
        const f = form.get("document");
        if (f && typeof f !== "string") docs.push({ chat: String(form.get("chat_id")), filename: (f as File).name, mime: (f as File).type, bytes: new Uint8Array(await (f as File).arrayBuffer()), at: Date.now() });
      }
      return await bot.fetch(req);
    }
    if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
    if (`${u.origin}${u.pathname}` === FILE_BASE) return await handleFile(req, fileDeps());
    const page = employerPage(u);
    if (page) return page;
    outbound.push(`${req.method} ${u.host}${u.pathname}`);
    throw new TypeError(`network refused: ${u.host}`);
  }) as typeof fetch;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const sql = async (s: string) => (await pg.sql(s)).trim();
  const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
  for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeR10Bot", TRAINEE_SIGNUP: "closed",
    TRAINEE_ALLOWED_CONTACTS: o.chats.map((c) => `telegram:${c}`).join(","), TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh", ANTHROPIC_API_KEY: "sk-test-not-real",
    CAREER_MODEL: "claude-sonnet-5-5", TRAINEE_FILE_BASE_URL: FILE_BASE, TRAINEE_FILE_LINK_SECRET: FILE_SECRET, TRAINEE_BOT_URL: "https://t.me/TraineeR10Bot", SUPABASE_URL })) Deno.env.set(k, v);

  // The market and the old list, as live posting rows (a "stale" one is closed in the database too).
  const rows = [...market, ...OLD_LIST.map((x) => ({ ...x, page: "open" as const }))].map((p) => {
    const [provider, board] = p.job.split(":");
    return `(${q(p.job)}, ${q(provider)}, ${q(board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, ${q(p.description)}, now() - interval '1 day', now() - interval '1 day', now(), ${p.page === "stale" ? "now() - interval '2 days'" : "null"})`;
  });
  await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at, closed_at) values ${rows.join(",\n")}`);

  let upd = 90000, mid = 100, turns = 0;
  const post = async (body: Record<string, unknown>) => {
    const id = ++upd;
    await sql("delete from public.agent_rate_limits");
    const deliverNow = deliverer(admin, Deno.env, pace);
    const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: id, ...body }) }),
      { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
        deliver: (a: any) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) } as any);
    const text = await res.text();
    eq(res.status, 200, text.slice(0, 300));
    return id;
  };
  const collect = async (chat: number, body: Record<string, unknown>): Promise<Said> => {
    turns++;
    const before = bot.to(chat).length, d0 = docs.length, p0 = pageChecks.length;
    const id = await post(body);
    const msgs = bot.to(chat).slice(before);
    const bubbles = msgs.map(plainOf);
    const buttons = msgs.flatMap((m: any) => m.buttons) as Said["buttons"];
    const reply = bubbles.join("\n\n");
    const links = [...new Set([...reply.matchAll(/https?:\/\/[^\s)<>"\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")).concat(buttons.flatMap((b) => [b.url, b.web_app?.url].filter(Boolean) as string[])))];
    return { id, reply, bubbles, buttons, docs: docs.slice(d0).filter((d) => d.chat === String(chat)), links, pageChecks: pageChecks.slice(p0) };
  };
  const say = (chat: number, words: string) => collect(chat, { message: { message_id: ++mid, chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: Math.floor(Date.now() / 1000), text: words } });
  const upload = (chat: number, filename: string, bytes: Uint8Array, caption?: string) => {
    const fid = `R10-${chat}-${++mid}`;
    telegramFiles.set(`documents/${fid}`, bytes);
    return collect(chat, { message: { message_id: ++mid, chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: Math.floor(Date.now() / 1000), ...(caption ? { caption } : {}),
      document: { file_id: fid, file_unique_id: `AgADr10${mid}`, file_name: filename, mime_type: filename.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_size: bytes.length } } });
  };
  const personOf = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
  const observedPerson = async (chat: number) => {
    await say(chat, "hi");
    const person = await personOf(chat);
    ok(/^[0-9a-f-]{36}$/.test(person), `an account for chat ${chat}`);
    const up = await upload(chat, "Jordan_Rivera_Resume.pdf", pdfOf(INTAKE_RESUME), "here is my resume");
    ok(up.reply.length > 0, "the upload was answered");
    await say(chat, "yes, that's my resume");
    ok(await sql(`select public.career_resume_on_file('${person}')`) === "t", `the intake is confirmed for ${chat}`);
    const old = await say(chat, OLD_SEARCH);
    // Shown as a File link and job cards (TRAINEE_FILE_BASE_URL is set, as in production) or inline: either way, the five roles.
    ok(OLD_LIST.some((p) => old.reply.includes(p.title)) || /\b5 machine learning/i.test(old.reply), `the old list was shown: ${old.reply.slice(0, 300)}`);
    // The original file is no longer available (spec A.3: "built from the saved intake notes, not the original resume file").
    await sql(`delete from public.career_resume_uploads where user_id = '${person}'`);
    await sql(`delete from storage.objects where bucket_id = 'career-resumes' and name like '${person}/%' and name not like '${person}/tailored%'`).catch(() => "");
    return person;
  };
  // Signs in the way the person does from Telegram (the Mini App's initData, signed for their own chat id), then reads the link.
  const signedInit = async (telegramId: number) => {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAH", user: JSON.stringify({ id: telegramId, first_name: "TEST" }) });
    const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
    const chk = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
    p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), TOKEN), chk))].map((b) => b.toString(16).padStart(2, "0")).join(""));
    return p.toString();
  };
  const { relayPageCsp } = await import("../../../supabase/functions/_shared/page_csp.ts");
  const { pageCsp } = await import("../../../api/_page_csp.js");
  const read = async (url: string, raw: Response): Promise<Opened> => {
    const res = relayPageCsp(raw);
    const type = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const html = /html/.test(type) ? new TextDecoder().decode(bytes) : null;
    return { url, status: res.status, type, bytes, html, ...(html !== null ? { csp: pageCsp(res.headers) } : {}) };
  };
  const open = async (url: string, chat: number): Promise<Opened> => {
    let u: URL;
    try { u = new URL(url); } catch { return { url, status: 0, type: "", bytes: new Uint8Array(), html: null, why: "not a URL" }; }
    if (`${u.origin}${u.pathname}` === FILE_BASE) {
      const list = u.searchParams.get("list") ?? (await (async () => { const t = u.searchParams.get("t"); if (!t) return ""; const c = await verifyFileToken(t, FILE_SECRET, Date.now()); return c.ok ? c.claims.r : ""; })());
      const extra = [...u.searchParams.entries()].filter(([k]) => !["t", "list"].includes(k));
      if (!list) return await read(url, await handleFile(new Request(url, { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } }), fileDeps()));
      const body = new URLSearchParams({ list, init: await signedInit(chat), ...Object.fromEntries(extra) });
      return await read(url, await handleFile(new Request(FILE_BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(FILE_BASE).origin, "user-agent": "Mozilla/5.0 (iPhone)" }, body: body.toString() }), fileDeps()));
    }
    try { return await read(url, await globalThis.fetch(url)); } catch (e) { return { url, status: 0, type: "", bytes: new Uint8Array(), html: null, why: (e as Error).message }; }
  };
  return {
    pg, sql, json, admin, say, upload, personOf, observedPerson, open, pageChecks, outbound, bot, brainLabel: o.brain ? `scripted brain: ${o.brain.name}` : "stub",
    modelCalls: () => modelCalls, brainCalls: () => brainCalls, turns: () => turns,
    stop: async () => {
      globalThis.fetch = realFetch;
      h.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    },
  };
}

// ------------------------------------------------------------------------------------------------ reading replies
export const sentences = (s: string) => s.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 30);
export function repeated(s: string): string[] { const seen = new Set<string>(), dup: string[] = []; for (const x of sentences(s)) { const k = x.toLowerCase(); if (seen.has(k)) dup.push(x); seen.add(k); } return dup; }
// Internal machinery and template prose the spec names (A.5 patterns 3, 4, 6; E.6 52) that a person should never read.
export const INTERNAL = [/parse check/i, /\brunner\b/i, /switched on/i, /Eligibility verdict/i, /checked against the record/i, /grounded in your profile record/i, /\bas supplied in context\b/i, /\bnamed in the unknowns\b/i, /What changed: Same as your base resume/i, /BRAIN.STUB|MODEL.STUB|SCRIPTED.BRAIN/,
  /rides with my reply/i, /A file exists here only once/i, /live board/i, /saved snapshot/i, /Nothing was invented to fill the list/i, /in the current list/i];
export const internalHits = (s: string) => INTERNAL.filter((r) => r.test(s)).map((r) => r.source);
// Every number a resume prints must be one the person supplied (years and page furniture aside).
export function inventedNumbers(fileText: string, source: string): string[] {
  const have = new Set([...source.matchAll(/\d+(?:\.\d+)?\+?/g)].map((m) => m[0].replace(/\+$/, "")));
  return [...new Set([...fileText.matchAll(/\d+(?:\.\d+)?\+?%?/g)].map((m) => m[0]))].filter((n) => {
    const v = n.replace(/[+%]$/, "");
    if (/^(19|20)\d\d$/.test(v)) return false;
    if (/^[01]$/.test(v)) return false;
    return !have.has(v);
  });
}
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
export const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
// A file the reply delivered: an attachment, or a link that downloads one. Opens each and returns what it found.
export async function deliveredFiles(w: World, chat: number, said: Said, label: string, ev: Ev): Promise<{ name: string; via: string; kind: "pdf" | "docx" | "other"; bytes: Uint8Array; pdf?: PdfInspection; docx?: { ok: boolean; text: string } }[]> {
  const out: Awaited<ReturnType<typeof deliveredFiles>> = [];
  const take = async (name: string, via: string, mime: string, bytes: Uint8Array) => {
    const kind = /pdf/i.test(mime) || name.toLowerCase().endsWith(".pdf") || latin1(bytes.subarray(0, 5)) === "%PDF-" ? "pdf" : /word|docx/i.test(mime) || name.toLowerCase().endsWith(".docx") ? "docx" : "other";
    const path = await saveFile(`${label}-${via}-${name}`, bytes);
    ev.files.push(path);
    out.push({ name, via, kind, bytes, ...(kind === "pdf" ? { pdf: await inspectPdf(bytes) } : {}), ...(kind === "docx" ? { docx: await inspectDocx(bytes) } : {}) });
  };
  for (const d of said.docs) await take(d.filename, "attachment", d.mime, d.bytes);
  for (const l of said.links) {
    const got = await w.open(l, chat);
    if (got.status === 200 && !got.html && got.bytes.length) await take(new URL(l).pathname.split("/").pop() || "download", "link", got.type, got.bytes);
  }
  return out;
}

// Runs a suite file: the world, the checks, the cleanup; when the machine cannot run it, every item it covers is NOT_RUN.
export function suite(file: string, items: number[], chats: number[], body: (t: Deno.TestContext, w: World) => Promise<void>, brain?: BrainScript) {
  Deno.test({
    name: `R10 acceptance ${file}`,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn(t) {
      const no = canRun(file);
      if (no) { await notRun(file, items, no); return; }
      const w = await world({ chats, brain });
      try { await body(t, w); } finally {
        console.log(`R10 ${file} turns=${w.turns()} model_calls=${w.modelCalls()} brain_calls=${w.brainCalls()} outbound=${w.outbound.length} page_checks=${w.pageChecks.length}`);
        // Item 0 is the run's own count (not one of the fifteen): every message the suite sent, setup included, all in-process.
        await record({ item: 0, test: "(interactions)", file, outcome: "PASS", turns: w.turns(), model_calls: w.modelCalls(), reply: `outbound=${w.outbound.length} page_checks=${w.pageChecks.length} brain_calls=${w.brainCalls()}` });
        await closeBrowser();
        await w.stop();
      }
    },
  });
}

// ------------------------------------------------------------------------------------------------ setup seams
// The preparation worker's output for one posting: a career_apply_prepared row and its stored resume, written as
// tests/architect/telegram-acceptance.test.ts writes it (the worker drives a browser; flow-telegram-e2e.test.ts covers it).
// `fields`: the exact answers that will be sent (label, value). `open`: required questions the person has not answered.
let prepN = 0;
export async function prepare(w: World, person: string, job: { job: string; company: string; title: string; url: string }, fields: { name: string; label: string; value: string }[], open: string[] = []) {
  prepN++;
  const stamp = JSON.parse(await w.sql(`select value::text from public.career_watch_kv where user_id = '${person}' and key = 'career:account'`) || "{}");
  const sha = (prepN.toString(16).padStart(2, "0")).repeat(32);
  await w.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${person}/${sha}.pdf') on conflict (bucket_id, name) do nothing`);
  const f = `jsonb_build_array(${fields.map((x) => `jsonb_build_object('name', ${q(x.name)}, 'label', ${q(x.label)}, 'value', ${q(x.value)})`).join(", ")})`;
  const pl = `jsonb_build_object('version', 1, 'user_id', '${person}', 'job_id', ${q(job.job)}, 'company', ${q(job.company)}, 'url', ${q(job.url)}, 'fields', ${f},
    'privacy_epoch', ${Number(stamp.epoch ?? 0)}, 'account_version', ${Number(stamp.version ?? 0)}, 'expires_at', now() + interval '1 day', 'resume_sha256', '${sha}')`;
  const lines = `array[${[`${job.company} — ${job.title}`, ...fields.map((x) => `${x.label}: ${x.value}`)].map(q).join(", ")}]`;
  const out = await w.sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
    select '${person}', ${q(job.job)}, ${q(job.company)}, ${q(job.url)}, pl, public.career_apply_payload_hash(pl), ${lines} from (select ${pl} as pl) x
    returning json_build_object('id', id, 'hash', payload_hash)`);
  for (const label of open) {
    const key = `label:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(label)))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    await w.sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, job_ids, company) values ('${person}', '${key}', 'screen', ${q(label)}, 'text', array[${q(job.job)}], ${q(job.company)})`);
  }
  return { ...JSON.parse(out.split("\n")[0]) as { id: string; hash: string }, sha };
}
