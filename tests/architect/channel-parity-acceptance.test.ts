// CHANNEL PARITY ACCEPTANCE (release item 14, "Accounts and channels", 2026-11-10). The channels switched on at release each
// run the SAME 20 scripted conversations through their REAL webhook, composed as its index.ts composes it, against the REAL
// agent-chat handler on a real Postgres 16 with every migration (tests/flow/pg.ts), with a fake provider API at the fetch
// boundary: Telegram's Bot API (scenarios/telegram-bot-api.ts) and LoopMessage's send API for iMessage
// (scenarios/loopmessage-api.ts). The model is the scripted stand-in of telegram-acceptance.test.ts at the Anthropic URL.
// Every switch is as the production deploy leaves it (unset): the release flags are served at their release value.
//
// Which channels are on at release (the evidence; item 14 builds a loop only for a channel that is on):
//   Telegram  ON   TELEGRAM_* wire it (scripts/launch/secrets-audit.sh FEATURE_MANIFEST); the deploy standard's S4 channel.
//   iMessage  ON   LOOPMESSAGE_API_KEY and TRAINEE_INBOUND_SECRET are tier R, launch-blocking (secrets-audit.sh MANIFEST):
//                  go-live cannot finish without them, and trainee-inbound is one of its scheduled functions.
//   WhatsApp  OFF  WHATSAPP_* are tier O: "Left empty, WhatsApp stays NOT_WIRED" (docs/launch/TRAINEE-GO-LIVE.md); Meta business
//                  verification and the number are the owner's (D-019) and not done (RELEASE-NOTE-LIVE-SITE-2026-11-03: no
//                  WhatsApp button until Trainee has its own number); WHATSAPP_TEMPLATE_UPDATES is RELEASE_NEVER_ON. Not built here.
// No channel is a release flag: release_config.ts RELEASE_FLAGS names none; each is wired by its secrets.
//
// The bar, per channel: every answer delivered exactly once (a redelivered or out-of-order webhook runs nothing twice, no
// provider message id in two outbox rows, no row left queued or sending, a retried send never sends what went out), 0 secrets
// in anything a provider or a caller receives or the outbox holds, and the same outcome on all 20 scripts as Telegram: each
// script returns a signature read from the database and the provider, and the two channels' signatures must be equal.
// PARITY_GAP names a script whose signature differs today because of what the provider carries (shrink-only, as KNOWN_GAP).
//
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/channel-parity-acceptance.test.ts
// (as an unprivileged user: initdb refuses root).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { fakeLoop } from "./scenarios/loopmessage-api.ts";
import { hexResumePdf } from "./scenarios/pdf-hex-fixture.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { postingChecks } from "./helpers/posting_checks.ts"; // architect amendment E.21 (2026-11-10, D-051)
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { RELEASE_FLAGS, RELEASE_NEVER_ON, RELEASE_PENDING, releaseValue } from "../../supabase/functions/agent-chat/release_config.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

export const CHANNELS_ON = ["telegram", "imessage"] as const;
export const CHANNELS_OFF = { whatsapp: "WHATSAPP_* tier O, NOT_WIRED until the owner's Meta number and token (D-019); WHATSAPP_TEMPLATE_UPDATES never on" } as const;
export const SCRIPTS = [
  "onboard-new-account", "onboard-same-account", "resume-paste-confirm", "signup-closed-stranger", "forged-webhook-refused",
  "stop-then-silence", "start-after-stop", "help-answered", "duplicate-delivery", "out-of-order-delivery",
  "bubble-limits", "file-link", "attachment-resume", "search-source-links", "yes-exact-batch",
  "yes-changed-payload-refused", "yes-stale-approves-nothing", "provider-retryable-error", "provider-token-refused", "provider-undeliverable",
] as const;
type Script = (typeof SCRIPTS)[number];
// Scripts whose signature differs between channels today, each with what differs (shrink-only).
export const PARITY_GAP: Partial<Record<Script, string>> = {
  // Telegram downloads the file and reads it (getFile); LoopMessage's attachment download is not wired (its URLs and host are
  // not verified, docs/launch/TRAINEE-GO-LIVE.md), so on iMessage the person is answered and told to paste the text instead.
  // Known, not wired: accepted for this release (coordinator ruling 2026-11-10); WO-121 wires the download and removes this.
  "attachment-resume": "read: Telegram reads a PDF resume; iMessage answers and asks for the text",
};

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const TG_TOKEN = "123456:TEST-parity-token-not-real", TG_SECRET = "TEST_parity_webhook_secret_0123456789ab";
const LM_KEY = "TEST-loopmessage-key-not-real-0123456789", LM_INBOUND = "TEST_parity_inbound_secret_0123456789abcd";
const DELIVER = "TEST-deliver-secret-0123456789-abcdefgh", FILE_SECRET = "TEST-file-link-secret-0123456789-abcdefghij", FILE_BASE = "https://trainee.test/file";
const MODEL_KEY = "sk-test-parity-not-real";
const SECRETS = [TG_TOKEN, TG_SECRET, LM_KEY, LM_INBOUND, DELIVER, FILE_SECRET, MODEL_KEY, SERVICE_KEY];
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const ACME = { job: "greenhouse:acmepar:6001", company: "Acme PARITY", title: "Software Engineering Intern (PARITY)", url: "https://boards.greenhouse.io/acmepar/jobs/6001" };
const GLOBEX = { job: "lever:globexpar:6002", company: "Globex PARITY", title: "Software Engineer Intern (PARITY)", url: "https://jobs.lever.co/globexpar/6002" };

// The staged brain's scripted answer; "LONGTEST" in the person's words asks for an answer far longer than one message.
const BRAIN_ANSWER = "Hi, I'm Trainee, your job search assistant. To get started, paste or attach your resume and I'll confirm each entry with you before using it.";
const LONG_POINTS = 40;
const LONG_ANSWER = Array.from({ length: LONG_POINTS }, (_, i) => `Point ${i + 1}: recruiting for internships runs on a calendar, and this sentence is padding so the answer runs long enough to need several messages.`).join(" ");
let modelCalls = 0;
function fakeModel(body: any): Response {
  modelCalls++;
  const last = JSON.stringify((body.messages ?? []).filter((m: any) => m.role === "user").at(-1) ?? "");
  const content = Array.isArray(body.tools) && body.tools.length ? (last.includes("LONGTEST") ? LONG_ANSWER : BRAIN_ANSWER) : "Subject: A quick question\n\nHi there,\n\nWould you be open to a short call?";
  return Response.json({ id: "chatcmpl-parity", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 40 } });
}

type Seen = { text: string; buttons: any[]; id: string };
type Got = { status: number; body: string; msgs: Seen[]; reply: string; id: string };
interface Driver {
  ch: (typeof CHANNELS_ON)[number];
  contact(n: number): string;
  allow(n: number): string;
  nextId(): string;
  text(n: number, words: string, id?: string): Promise<Got>;
  forged(n: number, words: string): Promise<Got>;
  attach(n: number, f: { name: string; mime: string; bytes: Uint8Array }): Promise<Got>;
  seen(n: number): Seen[];
  fault(f: null | "retryable" | "unauthorized" | "undeliverable"): void;
  // The provider's own word that a delivered message did not reach the person (a callback or a refused send), as it comes.
  undelivered(n: number, providerId: string): Promise<void>;
  rawSent(): string[];
  violations(): string[];
}

Deno.test({
  name: "Channel parity (release item 14): the same 20 scripts through each switched-on channel's real webhook, exactly once, 0 secrets",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("the channel parity suite needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    for (const g of Object.keys(PARITY_GAP)) ok((SCRIPTS as readonly string[]).includes(g), `PARITY_GAP names a script that does not exist: ${g}`);
    eq(SCRIPTS.length, 20, "20 scripts");
    for (const ch of [...CHANNELS_ON, ...Object.keys(CHANNELS_OFF)]) ok(!Object.keys(RELEASE_FLAGS).some((f) => f.toLowerCase().includes(ch)), `${ch} is not a release flag; its secrets wire it`);
    ok(RELEASE_NEVER_ON.includes("WHATSAPP_TEMPLATE_UPDATES"), "WhatsApp's out-of-window templates stay off at release");
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_NETWORKING_DRAFT", "ANTHROPIC_API_KEY", "CAREER_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL", "TRAINEE_SIGNUP",
      "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_DELIVER_SECRET", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "LOOPMESSAGE_API_KEY", "TRAINEE_INBOUND_SECRET", "WHATSAPP_TOKEN",
      "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", ...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, ...Object.keys(RELEASE_PENDING)];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const results: { ch: string; id: Script; outcome: "PASS" | "FAIL"; sig?: unknown; why?: string }[] = [];
    const responses: string[] = [];
    try {
      await supabaseParity(pg);
      h = await careerHandler(pg, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const pace = virtualClock();
      let tgFault: null | string = null, lmFault: null | string = null;
      const bot = fakeBot({ token: TG_TOKEN, now: pace.clock, fail: ({ method }) => {
        if (method !== "sendMessage" || !tgFault) return null;
        const f = tgFault; tgFault = null;
        if (f === "retryable") return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 2", parameters: { retry_after: 2 } }, { status: 429 });
        if (f === "unauthorized") return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
      } });
      const loop = fakeLoop({ apiKey: LM_KEY, now: pace.clock, fail: () => {
        if (!lmFault || lmFault === "undeliverable") return null; // undeliverable on iMessage: accepted, then message_failed
        const f = lmFault; lmFault = null;
        return f === "retryable" ? new Response("busy", { status: 503 }) : new Response("unauthorized", { status: 401 });
      } });
      const files = new Map<string, Uint8Array>();
      const viaDouble = globalThis.fetch, outbound: string[] = [], checks = postingChecks(); // E.21: posting-page reads held per turn
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.telegram.org" && u.pathname === `/bot${TG_TOKEN}/getFile`) {
          const id = String((await req.json()).file_id), f = files.get(id);
          return f ? Response.json({ ok: true, result: { file_id: id, file_unique_id: `u${id}`, file_size: f.length, file_path: `documents/${id}.bin` } }) : Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
        }
        if (u.host === "api.telegram.org" && u.pathname.startsWith(`/file/bot${TG_TOKEN}/documents/`)) {
          const f = files.get(decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.bin$/, "")));
          return f ? new Response(f as BodyInit) : new Response("not found", { status: 404 });
        }
        if (u.host === "api.telegram.org") return await bot.fetch(req);
        if (u.host === "a.loopmessage.com") return await loop.fetch(req);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
        if (checks.take(req.method, req.url)) throw new TypeError(`network refused: ${u.host}`); // architect amendment E.21
        outbound.push(`${req.method} ${u.host}${u.pathname}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const sql = async (s: string) => (await pg.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      // ------------------------------------------------------------------------------------------------------ the drivers
      const PEOPLE = 20, STRANGER = 4;
      const tgChat = (n: number) => 7992000 + n, phone = (n: number) => `+1555012${String(n).padStart(4, "0")}`;
      let upd = 80000, mid = 100, lmid = 0;
      const finish = async (res: Response, before: number, d: Driver, n: number, id: string): Promise<Got> => {
        const body = await res.text();
        responses.push(body);
        const msgs = d.seen(n).slice(before);
        return { status: res.status, body, msgs, reply: msgs.map((m) => m.text).join("\n\n"), id };
      };
      const tg: Driver = {
        ch: "telegram", contact: (n) => `tg:${tgChat(n)}`, allow: (n) => `telegram:${tgChat(n)}`, nextId: () => String(++upd),
        seen: (n) => bot.to(tgChat(n)).map((m) => ({ text: plainOf(m), buttons: m.buttons, id: String(m.id) })),
        async text(n, words, id) { return await tgPost(n, { message: { message_id: ++mid, chat: { id: tgChat(n), type: "private" }, from: { id: tgChat(n), is_bot: false, first_name: "TEST" }, date: 1, text: words } }, id ?? String(++upd)); },
        async forged(n, words) { return await tgPost(n, { message: { message_id: ++mid, chat: { id: tgChat(n), type: "private" }, from: { id: tgChat(n), is_bot: false, first_name: "TEST" }, date: 1, text: words } }, String(++upd), "TEST_wrong_secret_0123456789abcdefghijkl"); },
        async attach(n, f) {
          const fid = `F${n}x${++mid}`;
          files.set(fid, f.bytes);
          return await tgPost(n, { message: { message_id: ++mid, chat: { id: tgChat(n), type: "private" }, from: { id: tgChat(n), is_bot: false, first_name: "TEST" }, date: 1,
            document: { file_id: fid, file_unique_id: `u${fid}`, file_name: f.name, mime_type: f.mime, file_size: f.bytes.length } } }, String(++upd));
        },
        fault: (f) => { tgFault = f; },
        async undelivered() { /* Telegram refuses the send itself (403 blocked): fault("undeliverable") before the turn */ },
        rawSent: () => bot.calls.map((c) => JSON.stringify(c.body)),
        violations: () => bot.violations,
      };
      async function tgPost(n: number, body: Record<string, unknown>, id: string, secret = TG_SECRET): Promise<Got> {
        await sql("delete from public.agent_rate_limits");
        const before = tg.seen(n).length, deliverNow = deliverer(admin, Deno.env, pace);
        const res = await checks.turn(`tg ${id}`, () => handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify({ update_id: Number(id), ...body }) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) }), () => tg.seen(n).slice(before).map((m) => m.text).join("\n"));
        return await finish(res, before, tg, n, id);
      }
      const im: Driver = {
        ch: "imessage", contact: (n) => phone(n), allow: (n) => phone(n), nextId: () => `lm-in-${++lmid}`,
        seen: (n) => loop.to(phone(n)).map((m) => ({ text: m.text, buttons: [], id: m.id })),
        async text(n, words, id) { return await imPost(n, { alert_type: "message_inbound", message_id: id ?? `lm-in-${++lmid}`, recipient: phone(n), text: words, delivery_type: "imessage" }); },
        async forged(n, words) { return await imPost(n, { alert_type: "message_inbound", message_id: `lm-in-${++lmid}`, recipient: phone(n), text: words }, "TEST_wrong_secret_0123456789abcdefghijkl"); },
        // LoopMessage's inbound with an attachment and no text (its webhook carries attachment URLs).
        async attach(n, f) { return await imPost(n, { alert_type: "message_inbound", message_id: `lm-in-${++lmid}`, recipient: phone(n), text: "", attachments: [`https://loopmessage-cdn.test/${f.name}`], delivery_type: "imessage" }); },
        fault: (f) => { lmFault = f; },
        async undelivered(n, providerId) { await imPost(n, { alert_type: "message_failed", message_id: providerId, recipient: phone(n), error_code: 100 }); },
        rawSent: () => loop.calls.map((c) => c.body),
        violations: () => loop.violations,
      };
      async function imPost(n: number, body: Record<string, unknown>, secret = LM_INBOUND): Promise<Got> {
        await sql("delete from public.agent_rate_limits");
        const before = im.seen(n).length, deliverNow = deliverer(admin, Deno.env, pace);
        // As trainee-inbound/index.ts composes it (a real 250 ms between bubbles of a direct answer, as LoopMessage keeps order).
        const res = await checks.turn(`im ${String(body.message_id ?? "")}`, () => handleInbound(new Request(`${SUPABASE_URL}/functions/v1/trainee-inbound?secret=${encodeURIComponent(secret)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), send: (apiKey) => loopSend({ apiKey }), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY),
            deliverReply: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) }), () => im.seen(n).slice(before).map((m) => m.text).join("\n"));
        return await finish(res, before, im, n, String(body.message_id ?? ""));
      }

      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_BOT_USERNAME: "TraineeParityBot", TRAINEE_SIGNUP: "closed",
        LOOPMESSAGE_API_KEY: LM_KEY, TRAINEE_INBOUND_SECRET: LM_INBOUND, TRAINEE_DELIVER_SECRET: DELIVER, ANTHROPIC_API_KEY: MODEL_KEY, CAREER_MODEL: "claude-haiku-5-5",
        TRAINEE_FILE_BASE_URL: FILE_BASE, TRAINEE_FILE_LINK_SECRET: FILE_SECRET,
        TRAINEE_ALLOWED_CONTACTS: Array.from({ length: PEOPLE }, (_, i) => i + 1).filter((n) => n !== STRANGER).flatMap((n) => [tg.allow(n), im.allow(n)]).join(",") })) Deno.env.set(k, v);
      for (const [f, v] of Object.entries(RELEASE_FLAGS)) ok(releaseValue(Deno.env, f) === v, `release flag ${f} is served ${v}`);
      await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values
        (${q(ACME.job)}, 'greenhouse', 'acmepar', ${q(ACME.company)}, ${q(ACME.title)}, 'Chicago, IL', ${q(ACME.url)}, 'Requirements: Python, React, PostgreSQL. Summer 2026 internship.', now() - interval '2 hours', now() - interval '2 hours', now()),
        (${q(GLOBEX.job)}, 'lever', 'globexpar', ${q(GLOBEX.company)}, ${q(GLOBEX.title)}, 'Chicago, IL', ${q(GLOBEX.url)}, 'Requirements: Go, Kubernetes, Docker.', now() - interval '3 hours', now() - interval '3 hours', now())`);

      // ------------------------------------------------------------------------------------------------------ helpers
      const userOf = async (d: Driver, n: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = ${q(d.contact(n))}), '')`);
      const rowsOf = async (u: string) => await json(`select key, status, provider_ids, text, error, retry_at from public.career_outbox where user_id = '${u}' order by id`);
      const answered = (g: Got) => g.msgs.length >= 1;
      const noRepeat = (g: Got, what: string) => { const t = g.msgs.map((m) => m.text); eq(t.length, new Set(t).size, `${what}: no message sent twice: ${t.join(" | ").slice(0, 300)}`); };
      const sweep = async (d: Driver, n: number, aheadMs = 15 * 60000) => {
        const u = await userOf(d, n);
        const before = d.seen(n).length;
        await deliverer(admin, Deno.env, pace)({ userId: u, now: Date.now() + aheadMs, wholeUser: true });
        return d.seen(n).slice(before);
      };
      const onboard = async (d: Driver, n: number, confirm = true) => {
        await d.text(n, "hi");
        await d.text(n, `ok here is my resume:\n${RESUME}`);
        if (confirm) await d.text(n, "yes, that's my resume");
        return await userOf(d, n);
      };
      let prepCount = 0;
      const prepare = async (u: string, job: typeof ACME, firstName: string, replace?: string) => {
        prepCount++;
        const stamp = JSON.parse(await sql(`select value::text from public.career_watch_kv where user_id = '${u}' and key = 'career:account'`) || "{}");
        const sha = (prepCount.toString(16).padStart(4, "0")).repeat(16);
        await sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/${sha}.pdf') on conflict (bucket_id, name) do nothing`);
        const pl = `jsonb_build_object('version', 1, 'user_id', '${u}', 'job_id', ${q(job.job)}, 'company', ${q(job.company)}, 'url', ${q(job.url)},
            'fields', jsonb_build_array(jsonb_build_object('name', 'first_name', 'label', 'First name', 'value', ${q(firstName)}), jsonb_build_object('name', 'email', 'label', 'Email', 'value', 'alex.parity@example.test')),
            'privacy_epoch', ${Number(stamp.epoch ?? 0)}, 'account_version', ${Number(stamp.version ?? 0)}, 'expires_at', now() + interval '1 day', 'resume_sha256', '${sha}')`;
        const lines = `array[${q(`${job.company} — ${job.title}`)}, ${q(`First name: ${firstName}`)}, 'Email: alex.parity@example.test']`;
        const out = replace
          ? await sql(`update public.career_apply_prepared set payload = x.pl, payload_hash = public.career_apply_payload_hash(x.pl), card_lines = ${lines}, updated_at = now()
              from (select ${pl} as pl) x where id = '${replace}' returning json_build_object('id', id, 'hash', payload_hash)`)
          : await sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
              select '${u}', ${q(job.job)}, ${q(job.company)}, ${q(job.url)}, pl, public.career_apply_payload_hash(pl), ${lines} from (select ${pl} as pl) x
              returning json_build_object('id', id, 'hash', payload_hash)`);
        return JSON.parse(out.split("\n")[0]) as { id: string; hash: string };
      };
      const jobs = async (u: string) => await json(`select job_id, state, payload_hash, approval_hash from public.career_apply_jobs where user_id = '${u}' order by job_id`);

      // ------------------------------------------------------------------------------------------------------ the 20 scripts
      // Each returns its signature: what happened, read from the database and the provider, in channel-neutral terms.
      const scripts: Record<Script, (d: Driver, n: number) => Promise<Record<string, unknown>>> = {
        "onboard-new-account": async (d, n) => {
          const none = await userOf(d, n);
          const g = await d.text(n, "hi");
          const u = await userOf(d, n);
          noRepeat(g, "hi");
          return { before: none === "", account: /^[0-9a-f-]{36}$/.test(u), answered: answered(g), asksResume: /resume/i.test(g.reply), profiles: await sql(`select count(*) from public.profiles where id = '${u}'`) };
        },
        "onboard-same-account": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const g = await d.text(n, "hello again");
          return { same: (await userOf(d, n)) === u, answered: answered(g), contacts: await sql(`select count(*) from public.channel_contacts where user_id = '${u}'`) };
        },
        "resume-paste-confirm": async (d, n) => {
          const u = await onboard(d, n, false);
          const before = await sql(`select public.career_resume_on_file('${u}')`);
          const yes = await d.text(n, "yes, that's my resume");
          const again = await d.text(n, "yes, that's my resume");
          const rec = await json(`select state, kind from public.career_resume_record where user_id = '${u}'`);
          return { beforeYes: before, after: await sql(`select public.career_resume_on_file('${u}')`), records: rec.map((r: any) => `${r.state}/${r.kind}`), answered: answered(yes) && answered(again),
            facts: Number(await sql(`select count(*) from public.career_events where user_id = '${u}' and kind = 'fact_confirmed'`)) >= 8 };
        },
        "signup-closed-stranger": async (d, n) => {
          const g1 = await d.text(n, "hi");
          const g2 = await d.text(n, "hello?");
          return { account: (await userOf(d, n)) !== "", toldOnce: g1.msgs.length === 1 && g2.msgs.length === 0, closed: /not open|isn't open|invite|sign/i.test(g1.reply) };
        },
        "forged-webhook-refused": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const rows = (await rowsOf(u)).length;
          const g = await d.forged(n, "apply to everything now");
          return { status: g.status, sent: g.msgs.length, newRows: (await rowsOf(u)).length - rows };
        },
        "stop-then-silence": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const g = await d.text(n, "STOP");
          await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${u}', 'report:parity:${d.ch}:${n}', 'report', 'Your weekly report (PARITY TEST).', now())`);
          const swept = await sweep(d, n);
          const row = await json(`select status from public.career_outbox where user_id = '${u}' and key = 'report:parity:${d.ch}:${n}'`);
          return { ackOnce: g.msgs.length === 1, optedOut: await sql(`select opted_out from public.channel_contacts where contact = ${q(d.contact(n))}`), reportSent: swept.length, reportRow: row[0]?.status };
        },
        "start-after-stop": async (d, n) => {
          await d.text(n, "hi");
          await d.text(n, "STOP");
          const g = await d.text(n, "START");
          const after = await d.text(n, "hello");
          return { ackOnce: g.msgs.length === 1, optedOut: await sql(`select opted_out from public.channel_contacts where contact = ${q(d.contact(n))}`), answered: answered(after) };
        },
        "help-answered": async (d, n) => {
          await d.text(n, "hi");
          const g = await d.text(n, "HELP");
          noRepeat(g, "help");
          return { answered: answered(g), optedOut: await sql(`select opted_out from public.channel_contacts where contact = ${q(d.contact(n))}`) };
        },
        "duplicate-delivery": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const id = d.nextId();
          const first = await d.text(n, "what can you do?", id);
          const rows = (await rowsOf(u)).length;
          const again = await d.text(n, "what can you do?", id);
          const third = await d.text(n, "what can you do?", id);
          return { first: answered(first), redelivered: again.msgs.length + third.msgs.length, newRows: (await rowsOf(u)).length - rows, said: /duplicate/.test(again.body) };
        },
        "out-of-order-delivery": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const a = d.nextId(), b = d.nextId();
          const late = await d.text(n, "second message", b);
          const early = await d.text(n, "first message", a);
          const dupe = await d.text(n, "second message", b);
          const keys = (await rowsOf(u)).map((r: any) => r.key).filter((k: string) => /^reply:/.test(k));
          return { both: answered(late) && answered(early), redelivered: dupe.msgs.length, oneRowEach: [a, b].map((x) => keys.filter((k: string) => k.replace(/^reply:(tg:)?/, "").split(":")[0] === x).length >= 1) };
        },
        "bubble-limits": async (d, n) => {
          await d.text(n, "hi");
          const g = await d.text(n, "Can you explain in detail how internship recruiting works? LONGTEST");
          noRepeat(g, "long answer");
          const max = d.ch === "telegram" ? 4096 : 5000;
          // What agent-chat answered (its outbox rows for this message, cut honestly at its own cap) must arrive whole: every
          // character, in order, once, each message within the provider's limit.
          const u = await userOf(d, n), scope = d.ch === "telegram" ? `tg:${g.id}` : g.id;
          const queued = (await json(`select text from public.career_outbox where user_id = '${u}' and (key = ${q(`reply:${scope}`)} or key like ${q(`reply:${scope}:%`)}) order by coalesce(part, 0), id`)).map((r: any) => r.text).join(" ");
          const strip = (s: string) => s.replace(/\s+/g, "");
          const all = g.msgs.map((m) => m.text).join("\n");
          const seen = Array.from({ length: LONG_POINTS }, (_, i) => all.split(`Point ${i + 1}:`).length - 1);
          const k = seen.findIndex((c) => c === 0), shown = k < 0 ? LONG_POINTS : k;
          const order = Array.from({ length: shown }, (_, i) => all.indexOf(`Point ${i + 1}:`));
          return { split: g.msgs.length > 1, withinLimit: g.msgs.every((m) => m.text.length <= max), wholeAnswerDelivered: queued.length > 0 && strip(all) === strip(queued),
            pointsOnceInOrder: shown >= 10 && seen.slice(0, shown).every((c) => c === 1) && seen.slice(shown).every((c) => c === 0) && order.every((x, i) => i === 0 || x > order[i - 1]) };
        },
        "file-link": async (d, n) => {
          const u = await onboard(d, n);
          const g = await d.text(n, "find me software engineering internships in Chicago");
          const link = g.msgs.map((m) => m.text.trim()).find((t) => t.startsWith(`${FILE_BASE}?t=`)) ?? g.msgs.flatMap((m) => m.buttons).map((b) => String(b.url ?? "")).find((x) => x.startsWith(`${FILE_BASE}?t=`));
          const c = link ? await verifyFileToken(link.slice(FILE_BASE.length + 3), FILE_SECRET, Date.now()) : null;
          const lines = g.reply.split("\n").filter((l) => /^\d+\. /.test(l));
          return { link: !!link, opensForThePerson: !!c && c.ok && c.claims.u === u, linkOwnMessage: !!link && g.msgs.some((m) => m.text.trim() === link), rolesByNumber: lines.length >= 1 };
        },
        "attachment-resume": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          const g = await d.attach(n, { name: "resume.pdf", mime: "application/pdf", bytes: hexResumePdf("simple") });
          return { answered: answered(g), confirmedWithoutYes: await sql(`select public.career_resume_on_file('${u}')`),
            read: Number(await sql(`select count(*) from public.career_resume_record where user_id = '${u}'`)) > 0 || /Hexa|TEST Hex Co/i.test(g.reply) };
        },
        "search-source-links": async (d, n) => {
          const u = await onboard(d, n);
          const g = await d.text(n, "find me software engineering internships in Chicago");
          const live = await json(`select company, title from public.career_postings where closed_at is null`);
          const listed = g.reply.split("\n").filter((l) => /^\d+\. /.test(l));
          return { listed: listed.length >= 1, nothingInvented: listed.every((l) => live.some((p: any) => l.includes(p.company))), queued: (await jobs(u)).length, wanted: await sql(`select count(*) from public.career_apply_wanted where user_id = '${u}'`) };
        },
        "yes-exact-batch": async (d, n) => {
          const u = await onboard(d, n);
          const a = await prepare(u, ACME, "Alex"), b = await prepare(u, GLOBEX, "Alex");
          const shown = await d.text(n, "show my applications");
          const showsBoth = shown.reply.includes(ACME.company) && shown.reply.includes(GLOBEX.company) && shown.reply.includes("First name: Alex");
          const before = (await jobs(u)).length;
          await d.text(n, "yes");
          const j = await jobs(u);
          await d.text(n, "yes");
          return { showsBoth, before, approved: j.length, bound: j.every((x: any) => x.approval_hash === x.payload_hash && [a.hash, b.hash].includes(x.payload_hash)), states: j.map((x: any) => x.state),
            secondYesAdds: (await jobs(u)).length - j.length, sent: await sql(`select count(*) from public.career_apply_receipts where user_id = '${u}'`) };
        },
        "yes-changed-payload-refused": async (d, n) => {
          const u = await onboard(d, n);
          const v1 = await prepare(u, ACME, "Alex");
          await d.text(n, "show my applications");
          const v2 = await prepare(u, ACME, "Alexander", v1.id);
          const yes = await d.text(n, "yes");
          return { changed: v1.hash !== v2.hash, approved: (await jobs(u)).length, refusedByName: yes.reply.includes(ACME.company) && /changed|again|no longer/i.test(yes.reply) };
        },
        "yes-stale-approves-nothing": async (d, n) => {
          const u = await onboard(d, n);
          await prepare(u, ACME, "Alex");
          await d.text(n, "show my applications");
          await d.text(n, "what can you do?");
          const yes = await d.text(n, "yes");
          return { approved: (await jobs(u)).length, answered: answered(yes) };
        },
        "provider-retryable-error": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          d.fault("retryable");
          const g = await d.text(n, "what can you do?");
          const row = (await rowsOf(u)).at(-1);
          const swept = await sweep(d, n);
          const again = await sweep(d, n, 60 * 60000);
          const after = await json(`select status, provider_ids from public.career_outbox where user_id = '${u}' and key = ${q(row.key)}`);
          // Telegram's 429 carries retry_after, so the same delivery waits it out (on the pacing clock) and sends; a 503 from
          // LoopMessage is retried by the next sweep. Either way: delivered, and sent exactly once.
          const texts = [...g.msgs, ...swept, ...again].map((m) => m.text);
          return { status: after[0]?.status, sentOnce: texts.length === (after[0]?.provider_ids ?? []).length && texts.length >= 1 && new Set(texts).size === texts.length, sentAfter: again.length };
        },
        "provider-token-refused": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          d.fault("unauthorized");
          const g = await d.text(n, "what can you do?");
          const row = (await rowsOf(u)).at(-1);
          const swept = await sweep(d, n);
          const after = await json(`select status from public.career_outbox where user_id = '${u}' and key = ${q(row.key)}`);
          return { firstTry: g.msgs.length, keptNotFailedForGood: row.status !== "delivered" && !(row.status === "failed" && row.retry_at === null), deliveredOnceFixed: swept.length >= 1, status: after[0]?.status };
        },
        "provider-undeliverable": async (d, n) => {
          await d.text(n, "hi");
          const u = await userOf(d, n);
          d.fault("undeliverable");
          const g = await d.text(n, "what can you do?");
          d.fault(null);
          const row = (await rowsOf(u)).at(-1);
          for (const id of row.provider_ids ?? []) await d.undelivered(n, id);
          const final = await json(`select status from public.career_outbox where user_id = '${u}' and key = ${q(row.key)}`);
          const swept = await sweep(d, n, 60 * 60000);
          return { countedDelivered: final[0]?.status === "delivered", resent: swept.length, recorded: ["failed", "skipped_opt_out"].includes(final[0]?.status) || g.msgs.length === 0 };
        },
      };

      // ------------------------------------------------------------------------------------------------------ run, then read back
      const drivers: Driver[] = [tg, im];
      for (const d of drivers) {
        for (let i = 0; i < SCRIPTS.length; i++) {
          const id = SCRIPTS[i], n = i + 1;
          await t.step(`${d.ch} ${id}`, async () => {
            try {
              const sig = await scripts[id](d, n);
              d.fault(null);
              // The exactly-once invariants for this person, whatever the script did.
              const u = await userOf(d, n);
              if (u) {
                const rows = await rowsOf(u);
                const stuck = rows.filter((r: any) => r.status === "sending" || r.status === "queued");
                eq(stuck.map((r: any) => r.key), [], "no answer left queued or sending");
                const ids = rows.flatMap((r: any) => r.provider_ids ?? []);
                eq(ids.length, new Set(ids).size, "no provider message id in two outbox rows");
                const issued = new Set(d.seen(n).map((m) => m.id));
                for (const r of rows.filter((x: any) => x.status === "delivered")) for (const pid of r.provider_ids ?? []) ok(issued.has(String(pid)), `a delivered row's id was sent to this person: ${pid}`);
              }
              results.push({ ch: d.ch, id, outcome: "PASS", sig });
            } catch (e) {
              d.fault(null);
              results.push({ ch: d.ch, id, outcome: "FAIL", why: String((e as Error)?.message ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 400) });
            }
          });
        }
      }

      // 0 secrets: in every provider request body, every webhook response, every outbox text.
      const outboxText = (await json(`select text, error from public.career_outbox`)).map((r: any) => `${r.text} ${r.error ?? ""}`);
      const leaks: string[] = [];
      for (const [where, list] of [["telegram", tg.rawSent()], ["loopmessage", im.rawSent()], ["webhook responses", responses], ["outbox", outboxText]] as const) {
        for (const s of list) for (const k of SECRETS) if (s.includes(k)) leaks.push(`${where}: ${k.slice(0, 6)}...`);
      }
      const violations = [...tg.violations(), ...im.violations()];
      // Parity: the same signature on every script.
      const parity: { id: Script; same: boolean; tg?: unknown; im?: unknown }[] = SCRIPTS.map((id) => {
        const a = results.find((r) => r.ch === "telegram" && r.id === id), b = results.find((r) => r.ch === "imessage" && r.id === id);
        const same = a?.outcome === "PASS" && b?.outcome === "PASS" && JSON.stringify(a.sig) === JSON.stringify(b.sig);
        return { id, same, tg: a?.sig ?? a?.why, im: b?.sig ?? b?.why };
      });
      for (const r of results) console.log(`CHANNEL_PARITY ${r.ch} ${r.id} ${r.outcome} ${r.outcome === "PASS" ? JSON.stringify(r.sig) : r.why}`);
      for (const p of parity) if (!p.same) console.log(`CHANNEL_PARITY differs ${p.id}${PARITY_GAP[p.id] ? " (PARITY_GAP)" : ""}: telegram=${JSON.stringify(p.tg)} imessage=${JSON.stringify(p.im)}`);
      const pass = (ch: string) => results.filter((r) => r.ch === ch && r.outcome === "PASS").length;
      console.log(`CHANNEL_PARITY channels_on=${CHANNELS_ON.join(",")} off=${Object.keys(CHANNELS_OFF).join(",")} telegram_pass=${pass("telegram")}/20 imessage_pass=${pass("imessage")}/20 parity=${parity.filter((p) => p.same).length}/20 secrets=${leaks.length} provider_violations=${violations.length} outbound=${outbound.length} model_calls=${modelCalls}`);
      for (const p of parity) if (!p.same && PARITY_GAP[p.id] === undefined) results.push({ ch: "parity", id: p.id, outcome: "FAIL", why: "signatures differ" });
      for (const p of parity) if (p.same && PARITY_GAP[p.id] !== undefined) console.log(`CHANNEL_PARITY PARITY_GAP ${p.id} NOW MATCHES: remove it (the list only shrinks)`);
      eq(leaks, [], "0 secrets");
      eq(violations, [], "every message valid for its provider");
      eq(outbound, [], "nothing left the machine but a shown posting's own page (E.21)");
      eq(checks.faults, [], "posting-page reads only on the turn that shows them, at most one per posting shown, never over 10 (E.21)");
      eq(results.filter((r) => r.outcome === "FAIL").map((r) => `${r.ch} ${r.id}: ${r.why}`), [], "every script passes on every channel, with the same outcome");
    } finally {
      globalThis.fetch = realFetch;
      h?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
