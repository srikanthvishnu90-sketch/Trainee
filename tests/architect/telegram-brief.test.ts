// TELEGRAM BRIEF (architect, 2026-11-01): the owner's response brief (Parts 1, 2, 4, 5 and 7; cited as "brief P<part>.<rule>")
// on the live Telegram path, judged by outcome and shape on the wire and in the outbox.
//
// The observed failure (brief P7, "why this section exists"): asked three times for real job postings that match the goal, with
// the links, the bot never sent a link; it recorded the goal instead of acting. Reproduced on trunk 1f9cc9d6a through this same
// harness: the ask was searched as the role "real postings match goal links" and answered "I found no posting for real postings
// match goal links", with three live postings for the recorded goal on the board.
//
// End to end: the REAL trainee-telegram webhook (handleTelegram, composed as its index.ts composes it: the inbound store over
// supabase-js, agent-chat through chatThroughAgent, the head-start deliverer, the service client for the job store) and the real
// agent-chat handler, on a real Postgres 16 with every migration behind the PostgREST double. The brain is the deployed router
// (no model call is made). Telegram is the fake Bot API (scenarios/telegram-bot-api.ts) with setMessageReaction answered as
// Telegram answers it. Live postings are rows in career_postings; the saved snapshot is career_kb_postings. Every other host is
// refused. CAREER_TELEGRAM_BRIEF=on (the bubble shape and the search's File shape; threading and the reaction do not need it).
//
//   observed  "show me real job postings that match my goal, with the links", three times: each answered with the goal's live
//             roles as one summary line and the File link as its own message (the File's rows: company, title, location,
//             posted date, pay where listed, a working https link), never "recorded your goal", never a fallback
//   target 1  brief P7 target 1: "find me SWE internships in Chicago for summer 2027, remote ok, $30/hr+": the eyes reaction at
//             once, then one summary line (count, new this week, checked-at) and the File link
//   target 2  brief P7 target 2: "did my Acme application actually go through": one text bubble from the record; no ack
//   target 3  brief P7 target 3: "any new roles today" with nothing new in the goal's place: one line, the widest change that
//             would actually help (counted on the live board) and an ask; the person's filters unchanged after it
//   one role  plain text: company, title, location, pay (or "pay not listed"), posted date, checked-at; the link next, alone
//   not live  nothing verifiably live: said so, the nearest real alternative (the snapshot, said as such) and an ask
//   premise   a pay floor the listed ranges do not reach: corrected with the numbers in the first bubble
//   shape     every message of an answer threaded (reply_to_message_id) to the person's message; no visible Markdown; at most
//             about three sentences a bubble; a link only after a line of context; one ack at most (the reaction, or where it
//             is refused the N12 interim, never both); none for a one-line answer
//
// Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/telegram-brief.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeBot } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { textingNativeOn } from "../../supabase/functions/_shared/channel_voice.ts";
import { supabaseJobStore } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { briefBubbles, slowWork, telegramBriefOn } from "../../supabase/functions/_shared/telegram_brief.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const TOKEN = "123456:TEST-brief-bot-token-not-real", SECRET = "TEST_brief_webhook_secret_0123456789_abcdef";
const CHAT = 700000731;
const FILE_BASE = "https://files.trainee.test/f";
const DAY = 86400000;

// ------------------------------------------------------------------------------------------------ shape checks (independent)
const URL_ONLY = /^https:\/\/\S+$/;
const MARKDOWN = /\*\*|__|~~|`|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|\[[^\]\n]+\]\(https?:|(?:^|\s)[*_][^*_\s][^*_\n]*[*_](?=[\s.,!?]|$)/m;
// Sentences, counted without the code under test: URLs and decimals out, then each run of . ! ? that ends a sentence.
const sentenceCount = (t: string) => t.replace(/https?:\/\/\S+/g, "URL").replace(/(\d)\.(\d)/g, "$1$2").replace(/\b(?:e\.g|i\.e|vs|etc)\./g, "x")
  .split(/[.!?]+(?=\s|$)/).map((x) => x.trim()).filter((x) => /[A-Za-z0-9]/.test(x)).length;
const FALLBACK = /didn't catch that|not sure which part|I'm Trainee, a career agent: I find roles/i;
const RECORDED = /\brecorded\b[^.]{0,40}\bgoal\b|\bgoal\b[^.]{0,30}\b(?:on your record|recorded|noted|saved)\b/i;

// ------------------------------------------------------------------------------------------------ unit: the bubble shape
Deno.test("brief P1.2/P1.3/P2: bubbles of at most three sentences, one idea each; no markdown; a link alone after its line; a short answer stays one bubble", () => {
  const short = "Yes - submitted Oct 30, confirmation email in your inbox. No response from them yet.";
  eq(briefBubbles(short), [short], "a short complete answer is one bubble");
  eq(briefBubbles("Yes, it went through on Oct 30.\n\nNo reply from them yet."), ["Yes, it went through on Oct 30.\n\nNo reply from them yet."], "never split for the look of it");
  const long = "**0.5% a day** compounded turns $1,000 into about $6,175 in a year. That is roughly 517% a year. It is not a sensible guaranteed return. " +
    "Judge a model by returns after costs. Look at its _losing streaks_ too.\n\n## My take\n- Freeze the rule before testing it.\n\nThe paper is here: https://example.test/paper.pdf\n\nAnd the *carry* study: [the BIS paper](https://example.test/carry.pdf)";
  const b = briefBubbles(long);
  for (const x of b) {
    assert(!MARKDOWN.test(x), `no visible markdown: ${JSON.stringify(x)}`);
    assert(URL_ONLY.test(x) || sentenceCount(x) <= 3, `at most three sentences: ${JSON.stringify(x)}`);
  }
  assert(b.length >= 4, `split into ideas: ${JSON.stringify(b)}`);
  const at = b.indexOf("https://example.test/paper.pdf");
  assert(at > 0 && !URL_ONLY.test(b[at - 1]) && /paper is here/i.test(b[at - 1]), `the link alone, right after its line: ${JSON.stringify(b)}`);
  assert(/^0\.5% a day compounded/.test(b[0]), `the correction with its numbers leads: ${b[0]}`);
  const at2 = b.indexOf("https://example.test/carry.pdf");
  assert(at2 > 0 && /carry study/.test(b[at2 - 1]) && !/\[|\]\(/.test(b[at2 - 1]), `a markdown link becomes its words, then the link alone: ${JSON.stringify(b)}`);
  // brief P2 / P4: connect links, one per account, each right after the line that says which account it is for.
  const connect = "I can read your school inbox, but two need connecting.\nFor your personal inbox: https://connect.example.test/a?x=1\nFor your work inbox: https://connect.example.test/b?x=2";
  const c = briefBubbles(connect);
  eq(c.filter((x) => URL_ONLY.test(x)).length, 2, JSON.stringify(c));
  for (const [i, x] of c.entries()) if (URL_ONLY.test(x)) assert(i > 0 && /For your (personal|work) inbox/.test(c[i - 1]), `each link labeled by the line before it: ${JSON.stringify(c)}`);
  // An application card's exact rows stay together (one payload is never spread across messages).
  const card = "Ready to send. Reply yes to approve.\n\n1. Name: TEST Person\n2. Email: test@example.test\n3. Work authorization: Yes\n4. Start date: June 2027";
  const list = briefBubbles("Three things to check first.\n\nNext steps:\n- Freeze the rule.\n- Paper trade it.\n- Check the drawdown.");
  for (const x of list) assert(!MARKDOWN.test(x), `a list reads as plain bullets, no markdown dashes: ${JSON.stringify(list)}`);
  assert(list.some((x) => /Freeze the rule\.\n.*Paper trade it/.test(x)), `a list stays one bubble: ${JSON.stringify(list)}`);
  const cb = briefBubbles(card);
  assert(cb.some((x) => x.includes("1. Name: TEST Person") && x.includes("4. Start date: June 2027")), `the card's rows in one bubble: ${JSON.stringify(cb)}`);
});

Deno.test("brief P1.1/P5.1: slow work is acknowledged; a one-line question is not", () => {
  for (const m of ["show me real job postings that match my goal — with the links", "find me SWE internships in Chicago for summer 2027, remote ok, $30/hr+", "any new roles today"]) assert(slowWork(m), m);
  for (const m of ["did my Acme application actually go through", "what's my goal?", "thanks", "yes", "/start"]) assert(!slowWork(m), m);
  eq(telegramBriefOn({ get: () => undefined }), false, "the bubble shape is switched on per deploy");
});

// ------------------------------------------------------------------------------------------------ end to end on Postgres
Deno.test({
  name: "Telegram brief on Postgres: the observed failure fixed and the three target exchanges, through the real webhook and agent-chat",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const vars: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeBriefTestBot", TRAINEE_ALLOWED_CONTACTS: `telegram:${CHAT}`,
      TRAINEE_DELIVER_SECRET: ["TEST", "deliver", "brief", "0123456789", "abcdefghij"].join("-"), TRAINEE_FILE_BASE_URL: FILE_BASE,
      TRAINEE_FILE_LINK_SECRET: ["TEST", "file", "link", "brief", "0123456789abcdef"].join("-"), CAREER_TELEGRAM_BRIEF: "on",
    };
    const saved = Object.fromEntries([...Object.keys(vars), "CAREER_TEXTING_NATIVE", "CAREER_BRAIN", "OPENAI_API_KEY"].map((k) => [k, Deno.env.get(k)]));
    const realFetch = globalThis.fetch;
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      agentChat = await careerHandler(pg, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
      for (const k of ["CAREER_TEXTING_NATIVE", "CAREER_BRAIN", "OPENAI_API_KEY"]) Deno.env.delete(k);

      // Telegram: the fake Bot API, with setMessageReaction answered as Telegram answers it (or refused, per message).
      const B = fakeBot({ token: TOKEN, now: Date.now });
      const refuseReaction = new Set<number>();
      const reactions: { message_id: number; emoji: string }[] = [];
      const botFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        if (req.url.endsWith("/setMessageReaction")) {
          const body = await req.clone().json();
          B.calls.push({ method: "setMessageReaction", body, at: Date.now() });
          if (refuseReaction.has(Number(body.message_id))) return Response.json({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }, { status: 400 });
          reactions.push({ message_id: Number(body.message_id), emoji: body.reaction?.[0]?.emoji });
          return Response.json({ ok: true, result: true });
        }
        return await B.fetch(req);
      }) as unknown as typeof fetch;
      const outbound: string[] = [];
      const double = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === SUPABASE_URL && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === SUPABASE_URL) return await double(req);
        if (u.hostname === "api.telegram.org") return await botFetch(req);
        outbound.push(u.host);
        throw new TypeError(`the brief test reaches no real host: ${u.host}`);
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

      // The clock the typing refresh and the N12 interim run on: recorded, never fired (an armed 6 s timer is an interim to come).
      const armed: number[] = [];
      const timers = { set: (_fn: () => void, ms: number) => { armed.push(ms); return armed.length; }, clear: (_h: unknown) => {} };
      let upd = 70000, mid = 300;
      // One message from the person through the webhook, composed as trainee-telegram/index.ts composes it.
      const say = async (text: string) => {
        const mark = B.calls.length;
        armed.length = 0;
        const messageId = ++mid;
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, {
          method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({ update_id: ++upd, message: { message_id: messageId, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "TEST" }, date: 1, text } }),
        }), { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin, timers,
          deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now, ...(a.replyTo ? { replyTo: a.replyTo } : {}) }),
          adapter: (e) => telegramAdapter({ token: TOKEN, webhookSecret: SECRET, fetch: botFetch, native: textingNativeOn(e), brief: telegramBriefOn(e) }) });
        eq(res.status, 200, await res.clone().text());
        await res.body?.cancel();
        const calls = B.calls.slice(mark);
        const sends = calls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === CHAT);
        return { messageId, calls, sends, texts: sends.map((c) => String(c.body.text)), interimArmed: armed.includes(6000), reacted: calls.some((c) => c.method === "setMessageReaction" && Number(c.body.message_id) === messageId) };
      };
      type Said = Awaited<ReturnType<typeof say>>;
      // brief P1.2, P1.3, P2, P5.2: every answer's shape.
      const shaped = (r: Said, what: string) => {
        assert(r.sends.length >= 1, `${what}: answered on Telegram`);
        for (const c of r.sends) eq(c.body.reply_to_message_id, r.messageId, `${what}: threaded as a reply to the person's message: ${JSON.stringify(c.body).slice(0, 200)}`);
        for (const [i, x] of r.texts.entries()) {
          assert(!MARKDOWN.test(x), `${what}: no visible markdown: ${x}`);
          if (URL_ONLY.test(x)) assert(i > 0 && !URL_ONLY.test(r.texts[i - 1]), `${what}: a link only after a line of context: ${JSON.stringify(r.texts)}`);
          else assert(sentenceCount(x) <= 3, `${what}: at most three sentences a bubble (${sentenceCount(x)}): ${x}`);
        }
        assert(!r.texts.some((x) => FALLBACK.test(x)), `${what}: never a fallback: ${JSON.stringify(r.texts)}`);
        eq(B.violations, [], `${what}: everything within Telegram's limits`);
      };
      // brief P1.1 / P5.1 / P7.5: one acknowledgment at most; slow work gets the reaction first, then nothing until the answer.
      const ackedOnce = (r: Said, what: string) => {
        assert(r.reacted, `${what}: the eyes reaction on the person's message`);
        const first = r.calls.findIndex((c) => c.method === "setMessageReaction"), firstSend = r.calls.findIndex((c) => c.method === "sendMessage");
        assert(first >= 0 && (firstSend < 0 || first < firstSend), `${what}: the reaction lands before any message`);
        eq(r.interimArmed, false, `${what}: no interim line on top of the reaction`);
        assert(!r.texts.some((x) => /^on it\b/i.test(x)), `${what}: no text ack on top of the reaction: ${JSON.stringify(r.texts)}`);
      };
      // The File: the list page's link, alone, after one summary line; its rows read back from the job store by the link's list id.
      const fileOf = async (r: Said, what: string) => {
        const links = r.texts.filter((x) => x.startsWith(`${FILE_BASE}?t=`));
        eq(links.length, 1, `${what}: exactly one File link: ${JSON.stringify(r.texts)}`);
        const at = r.texts.indexOf(links[0]);
        eq(at, r.texts.length - 1, `${what}: the File link is the last message`);
        const summary = r.texts.slice(0, at).filter((x) => !URL_ONLY.test(x));
        eq(summary.length, 1, `${what}: exactly one summary line before the link: ${JSON.stringify(r.texts)}`);
        const token = new URL(links[0]).searchParams.get("t")!;
        const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const store = supabaseJobStore(admin);
        const refs = (await store.recallList(person, String(claims.r))) ?? [];
        const rows = (await Promise.all(refs.map((ref) => store.recall(person, ref)))).map((x) => x!.job);
        for (const j of rows) {
          assert(/^https:\/\//.test(j.url) && j.company && j.title && j.location, `${what}: every row has a working link, company, title and location: ${JSON.stringify(j)}`);
          assert(j.posted_at || j.first_seen_at, `${what}: every row has its posted (or first seen) date: ${JSON.stringify(j)}`);
          const live = await pg.sql(`select count(*) from public.career_postings where job_id = '${j.job_id}' and url = '${j.url}' and closed_at is null`);
          eq(live, "1", `${what}: each row is a live posting with its own link: ${j.job_id}`);
        }
        return { summary: summary[0], rows };
      };

      // ------------------------------------------------------------------------------------------------ the world
      const NOW = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
      const live = (id: number, company: string, title: string, location: string, o: { pay?: string | null; posted?: number | null; seen: number; text?: string }) =>
        `insert into public.career_postings (job_id, provider, board, company, title, location, url, description, pay, posted_at, first_seen_at, last_seen_at)
         values ('greenhouse:tgbrief:${id}', 'greenhouse', 'tgbrief', '${company}', '${title}', '${location}', 'https://boards.greenhouse.io/tgbrief/jobs/${id}',
         '${o.text ?? "Summer 2027 internship. Build services in TypeScript and Go with the platform team."}', ${o.pay ? `'${o.pay}'` : "null"},
         ${o.posted != null ? `'${iso(NOW - o.posted * DAY)}'` : "null"}, '${iso(NOW - o.seen * DAY)}', '${iso(NOW - 30000)}');`;
      await pg.sql([
        live(1, "TEST Acme Labs", "Software Engineering Intern", "Chicago, IL", { pay: "$32-$40/hr", posted: 1, seen: 1 }),
        live(2, "TEST Beta Systems", "Software Engineer Intern, Summer 2027", "Chicago, IL", { pay: "$35/hr", posted: null, seen: 3 }),
        live(3, "TEST Gamma Cloud", "Software Engineering Intern", "Remote (US)", { pay: "$38/hr", posted: 2, seen: 2 }),
        live(4, "TEST Delta Data", "Data Science Intern", "Chicago, IL", { pay: null, posted: 9, seen: 9, text: "Summer 2027. Python, SQL and experiments." }),
        live(5, "TEST Epsilon Corp", "Senior Software Engineer", "Chicago, IL", { pay: "$190,000/yr", posted: 1, seen: 1, text: "Eight years building distributed systems." }),
        `insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, fetched_on, corpus_vintage, text_excerpt, content_hash)
         values ('kb-tgbrief-1', 'greenhouse', 'tgbriefkb', 'TEST Snapshot Studio', 'Product Design Intern', 'Chicago, IL', 'https://boards.example.test/kb-tgbrief-1', '2026-10-10T00:00:00Z', '2026-10-15', '2026-10', 'Figma and user research.', 'kb-tgbrief-1');`,
      ].join("\n"));
      let person = "";

      await t.step("start, then the goal is recorded and acted on at once", async () => {
        const s = await say("/start");
        shaped(s, "/start");
        person = (await pg.sql(`select coalesce(user_id::text, '') from public.channel_contacts where contact = 'tg:${CHAT}'`)).trim();
        assert(/^[0-9a-f-]{36}$/.test(person), `an account for the chat: ${person}`);
        await pg.sql(`set session_replication_role = replica;
          insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, confirmation_id, created_at, updated_at)
          values ('${person}', 'greenhouse:acmeapply:1', 'Acme', 'https://acme.example.test/apply', '{"title":"Software Engineering Intern"}'::jsonb, repeat('c', 64), repeat('c', 64), 'submitted_unconfirmed', 'TEST-CONF-1', '${iso(NOW - 2 * DAY)}', '${iso(NOW - 2 * DAY)}');
          set session_replication_role = origin;`);
        const g = await say("my goal is a software engineering internship in chicago");
        shaped(g, "the goal");
      });

      await t.step("observed failure fixed: 'show me real job postings that match my goal, with the links' gets the goal's live roles as a File, three times", async () => {
        for (let i = 1; i <= 2; i++) {
          const r = await say("show me real job postings that match my goal — with the links");
          const what = `ask ${i}`;
          shaped(r, what);
          ackedOnce(r, what);
          assert(!r.texts.some((x) => RECORDED.test(x)), `${what}: "recorded your goal" is never the answer: ${JSON.stringify(r.texts)}`);
          const f = await fileOf(r, what);
          assert(/^Found 2 live roles for your goal\b/.test(f.summary) && /\bchecked [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M CT\b/.test(f.summary), `${what}: what was found, with the checked-at stamp: ${f.summary}`);
          eq(f.rows.map((j) => j.company).sort(), ["TEST Acme Labs", "TEST Beta Systems"], `${what}: the goal's live roles (Chicago internships), nothing else`);
        }
      });

      await t.step("one role: plain text with company, title, location, pay (not listed: said), posted date and checked-at; then its link alone", async () => {
        const r = await say("show me data science internships in chicago");
        shaped(r, "one role");
        ackedOnce(r, "one role");
        assert(!r.texts.some((x) => x.startsWith(FILE_BASE)), `one role is text, not a File: ${JSON.stringify(r.texts)}`);
        eq(r.texts.length, 2, `the line, then the link: ${JSON.stringify(r.texts)}`);
        assert(/^One live role matches .*: Data Science Intern at TEST Delta Data — Chicago, IL, pay not listed, posted [A-Z][a-z]{2} \d{1,2}\. Checked live [A-Z][a-z]{2} \d{1,2}, .* CT\.$/.test(r.texts[0]), r.texts[0]);
        eq(r.texts[1], "https://boards.greenhouse.io/tgbrief/jobs/4", "the posting's own working link, alone");
      });

      await t.step("nothing verifiably live: said so, with the nearest real alternative (the snapshot, said as such) and an ask", async () => {
        const r = await say("show me product design internships in chicago");
        shaped(r, "not live");
        eq(r.texts.length, 1, `one bubble: ${JSON.stringify(r.texts)}`);
        assert(/^Nothing verifiably live matches product design in chicago \(internships\) right now \(checked .* CT\)\. The nearest real alternative is 1 posting in my saved snapshot of job boards from 2026-10-15, which may have closed since\. Want me to send those\?$/.test(r.texts[0]), r.texts[0]);
      });

      await t.step("a broken premise (a pay floor no listed range reaches) is corrected with the numbers in the first bubble", async () => {
        const r = await say("find me SWE internships in chicago paying $90/hr+");
        shaped(r, "premise");
        eq(r.texts.length, 1, `one bubble: ${JSON.stringify(r.texts)}`);
        assert(/^Nothing live matches .*: the 2 matches list pay up to \$40\/hr, under your \$90\/hr floor\. Widest change that would help: lowering the pay floor \(2 more roles\)\. Want me to\?$/.test(r.texts[0]), r.texts[0]);
      });

      await t.step("target 2: 'did my Acme application actually go through' is one text bubble from the record, with no acknowledgment", async () => {
        const r = await say("did my Acme application actually go through");
        shaped(r, "target 2");
        eq(r.reacted, false, "no reaction for a one-line answer");
        eq(r.texts.length, 1, `one bubble: ${JSON.stringify(r.texts)}`);
        assert(/^Acme \(Software Engineering Intern\): submitted on [A-Z][a-z]{2} \d{1,2}; Acme has not confirmed it yet \(their page showed TEST-CONF-1\)\./.test(r.texts[0]), r.texts[0]);
        assert(!/reply watch|I'll flag it/i.test(r.texts[0]), `no follow-up promised that is not set up: ${r.texts[0]}`);
      });

      await t.step("target 1: SWE internships in Chicago, summer 2027, remote ok, $30/hr+: the reaction, one summary line, the File", async () => {
        const r = await say("find me SWE internships in Chicago for summer 2027, remote ok, $30/hr+");
        shaped(r, "target 1");
        ackedOnce(r, "target 1");
        const f = await fileOf(r, "target 1");
        assert(/^Found 3 live roles for software engineer in Chicago or remote \(internships, summer 2027, \$30\+\/hr\): 3 new this week, checked /.test(f.summary), f.summary);
        eq(f.rows.map((j) => j.company).sort(), ["TEST Acme Labs", "TEST Beta Systems", "TEST Gamma Cloud"], "Chicago or remote, internships, paying $30/hr or more");
      });

      await t.step("target 3: 'any new roles today' with nothing new in Chicago: one line, the widest change counted on the live board, an ask; filters unchanged", async () => {
        // A remote internship first seen now, after the last list: new, but outside the goal's place.
        await pg.sql(live(6, "TEST Zeta Remote", "Software Engineering Intern", "Remote (US)", { pay: "$36/hr", posted: null, seen: 0 })
          .replace(/'[^']*', '[^']*'\);$/, "now(), now());"));
        const r = await say("any new roles today");
        shaped(r, "target 3");
        eq(r.texts.length, 1, `one bubble: ${JSON.stringify(r.texts)}`);
        assert(/^Nothing new matching your goal, software engineering in chicago \(internships\) since your last list \(checked .* CT\)\. Widest change that would help: widening the location beyond chicago \(1 more role\)\. Want me to\?$/.test(r.texts[0]), r.texts[0]);
        // brief P7.7: nothing changed without a yes: the goal still searches Chicago only (the new remote role stays out).
        const again = await say("show me real job postings that match my goal — with the links");
        shaped(again, "ask 3");
        ackedOnce(again, "ask 3");
        const f = await fileOf(again, "ask 3");
        eq(f.rows.map((j) => j.company).sort(), ["TEST Acme Labs", "TEST Beta Systems"], "the filters are what they were: Chicago only");
      });

      await t.step("ack rules: where the reaction is refused, the N12 interim is the one acknowledgment (armed), never both", async () => {
        refuseReaction.add(mid + 1);
        const r = await say("show me software engineering internships in chicago");
        shaped(r, "refused reaction");
        assert(r.calls.some((c) => c.method === "setMessageReaction"), "the reaction was tried");
        eq(r.interimArmed, true, "the interim line is armed instead");
      });

      eq(outbound, [], "nothing left the machine");
      eq(B.violations, []);
    } finally {
      globalThis.fetch = realFetch;
      agentChat?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
