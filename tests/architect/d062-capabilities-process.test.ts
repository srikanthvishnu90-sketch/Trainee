// D-062 (owner, 2026-11-11, in chat: "your job is to know exactly what any job posting requires, be able to answer emails, find
// alumni, do all of it. not gmail read, but gmail read and send"). The capability turns' process at $0, through the REAL career
// handler under PRODUCTION's configuration (every RELEASE_FLAGS switch at its release value, no never-on switch, PRODUCTION_BRAIN),
// with a scripted model on the Anthropic wire, a stub Gmail API (the person's own token only; every send recorded, never
// delivered) and a stubbed web search. Every other host is refused and recorded.
//   D62-1  C6 with Gmail connected: "have I applied to anything?" reads the person's Gmail now (mail tracking), answers from the
//          employer's confirmation email, keeps tonight's researched role apart, states the coverage, offers a tracker.
//   D62-2  C16: the tracker File (kind "tracker", built by code) with the application, its evidence and date, the researched role
//          and the coverage; after a new email changed the application's stage, the tracker names the correction (G9).
//   D62-3  answering an email: the inbox is searched, the one email read, the reply drafted and shown word for word as a card;
//          NOTHING is sent until a yes; the yes sends exactly that message once, from the person's Gmail, in the email's thread;
//          a second yes sends nothing more.
//   D62-4  without Gmail: the reply says so and how to connect it (the person signs in themselves); nothing is read or sent.
//   D62-5  C19 alumni: one people search from web search excerpts, LinkedIn never opened, three leads not verified, one to start
//          with, "Nobody was contacted."
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d062-capabilities-process.test.ts
import assertNode from "node:assert/strict";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";
import { type Call, flagsNow, type Step } from "./helpers/mirror_process.ts";
import { C19_INPUT, C19_STEPS, isPeopleSearch, peopleSearchAnswer, PEOPLE_PAGES } from "./helpers/d062_fixtures.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { applicationRecordAsk, alumniSearchAsk, emailReplyAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { leadsFrom } from "../../supabase/functions/_shared/career_alumni_search.ts";
import { buildRaw } from "../../supabase/functions/_shared/career_outreach_gmail.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const READ = "https://www.googleapis.com/auth/gmail.readonly", SEND = "https://www.googleapis.com/auth/gmail.send";
const DAY = 86_400_000;
const parse = (calls: Call[], name: string) => { try { return JSON.parse(calls.find((c) => c.name === name)?.result || "{}"); } catch { return {}; } };

// ------------------------------------------------------------------------------------------------ the stub Gmail
type Mail = { id: string; threadId: string; at: number; from: string; subject: string; snippet: string; messageId: string; body?: string; dkim?: string };
function fakeGmail(token: string) {
  const inbox: Mail[] = [], sent: { raw: string; threadId: string | null }[] = [], calls: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const meta = (m: Mail) => ({ id: m.id, threadId: m.threadId, internalDate: String(m.at), snippet: m.snippet, labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [
    { name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.at).toUTCString() }, { name: "Message-ID", value: m.messageId },
    ...(m.dkim ? [{ name: "Authentication-Results", value: `mx.google.com; dkim=pass header.i=@${m.dkim} header.s=s1; spf=pass smtp.mailfrom=x@${m.dkim}; dmarc=pass header.from=${m.dkim}` }] : []),
  ], body: { data: btoa(m.body ?? m.snippet).replace(/\+/g, "-").replace(/\//g, "_") } } });
  const handle = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.pathname}${u.searchParams.get("q") ? `?q=${u.searchParams.get("q")}` : ""}`);
    if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: { code: 401 } }, 401);
    if (req.method === "GET" && u.pathname === "/gmail/v1/users/me/messages") {
      const q = u.searchParams.get("q") ?? "", after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
      const words = q.replace(/after:\d+|-in:\w+/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = inbox.filter((m) => m.at > after && words.every((w) => `${m.from} ${m.subject} ${m.snippet}`.toLowerCase().includes(w.replace(/^from:/, ""))));
      return json({ messages: hits.slice().reverse().map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const one = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && one) { const m = inbox.find((x) => x.id === decodeURIComponent(one[1])); return m ? json(meta(m)) : json({ error: "not found" }, 404); }
    if (req.method === "POST" && u.pathname === "/gmail/v1/users/me/messages/send") {
      const b = await req.json();
      const raw = String(b.raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
      sent.push({ raw: new TextDecoder().decode(Uint8Array.from(atob(raw + "=".repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0))), threadId: b.threadId ?? null });
      return json({ id: `sent-${sent.length}`, threadId: b.threadId ?? `thr-new-${sent.length}` });
    }
    return json({ error: "not found" }, 404);
  };
  return { inbox, sent, calls, handle };
}

// ------------------------------------------------------------------------------------------------ the conversation driver
type Seen = { code: boolean; tools: string[]; calls: Call[]; reply: string; intent: string | null; body: any; outbound: string[]; searches: number };
async function conversation(o: { gmail?: ReturnType<typeof fakeGmail> | null; script: Record<string, Step[]>; setup?: (pg: any, userId: string) => Promise<void> }) {
  let label = "";
  const seen: Record<string, Seen> = {};
  const fresh = (): Seen => ({ code: true, tools: [], calls: [], reply: "", intent: null, body: null, outbound: [], searches: 0 });
  const scripted = (chat: any) => {
    const msgs: any[] = chat.messages ?? [];
    const reply = (content: string, tool_calls?: unknown[]) => Response.json({ id: "d62", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    if (!Array.isArray(chat.tools) || !chat.tools.length) return reply(chat.response_format ? "{}" : `scripted (${label})`);
    const s = seen[label] ??= fresh();
    if (s.code) { s.code = false; s.tools = chat.tools.map((t: any) => t.function?.name ?? t.name); }
    const last = msgs.at(-1);
    if (last?.role === "tool" && s.calls.length && !s.calls.at(-1)!.result) s.calls.at(-1)!.result = String(last.content ?? "");
    const steps = o.script[label] ?? [], step = steps[s.calls.length];
    if (step && "tool" in step) {
      const input = typeof step.input === "function" ? step.input(s.calls) : step.input;
      s.calls.push({ name: step.tool, input, result: "" });
      return reply("", [{ id: `toolu_d62_${s.calls.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(input) } }]);
    }
    const t = steps.find((x): x is Extract<Step, { text: unknown }> => "text" in x)?.text;
    return reply((typeof t === "function" ? t(s.calls) : t) ?? `scripted (${label})`);
  };
  const model = async (req: Request) => {
    const body = await req.clone().json().catch(() => ({}));
    if ((body.tools ?? []).some((t: any) => /^web_search_/.test(String(t?.type ?? "")))) {
      (seen[label] ??= fresh()).searches++;
      (seen[label] as any).searchBody = body;
      return Response.json(isPeopleSearch(body) ? peopleSearchAnswer(body) : { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } });
    }
    return anthropicWire(req, scripted);
  };
  const world = await openWorld(2, { model });
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (o.gmail && u.host === "gmail.googleapis.com") return await o.gmail.handle(req);
    if (u.host !== "api.anthropic.com" && u.host !== "supabase.test") (seen[label] ??= fresh()).outbound.push(`${req.method} ${u.origin}${u.pathname}`);
    return await below(req);
  }) as typeof fetch;
  // PRODUCTION CONFIGURATION: every release flag unset (served at its release value), no never-on switch, the production brain.
  for (const k of Object.keys(RELEASE_FLAGS)) Deno.env.delete(k);
  for (const k of RELEASE_NEVER_ON) Deno.env.delete(k);
  Deno.env.set("CAREER_BRAIN", PRODUCTION_BRAIN);
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
  // File links (the tracker page) as production has them; a test secret, not a real one.
  Deno.env.set("TRAINEE_FILE_BASE_URL", "https://trainee.example.test"); Deno.env.set("TRAINEE_FILE_LINK_SECRET", "test-file-link-secret-0123456789abcdef");
  const person = await world.person({ resume: false });
  await o.setup?.(world.pg, person.id);
  const close = async () => { globalThis.fetch = below; for (const k of ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"]) Deno.env.delete(k); await world.close(); };
  const say = async (id: string, text: string) => {
    label = id;
    const f = flagsNow();
    eq(f.release, { ...RELEASE_FLAGS }, `${id}: effective release flags`); eq(f.neverOnOn, [], `${id}: a never-on switch is on`); eq(f.brain, PRODUCTION_BRAIN, `${id}: the brain`);
    const r: any = await person.say(text);
    const s = seen[id] ??= fresh();
    s.reply = String(r.reply ?? ""); s.intent = r.intent ?? null; s.body = r.body ?? null;
    return s;
  };
  return { world, person, say, seen, close };
}
const connectSql = (u: string, token: string) => `insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${u}', 'google_career', 'oauth_google_career_${u}', 'sam.rivera@example.test', '${READ} ${SEND}');
  select public.oauth_vault_store('oauth_google_career_${u}', '{"access_token":"${token}","refresh_token":"RT-D62","expires_at":${Date.now() + 365 * DAY}}');
  insert into public.career_outreach_prefs (user_id, signature) values ('${u}', 'Sam Rivera');`;
const POSTING = `insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
  ('greenhouse:paypalwa1:9101', 'greenhouse', 'paypalwa1', 'PayPal', 'Software Engineer Intern', 'Chicago, IL', 'https://boards.greenhouse.io/paypalwa1/jobs/9101', 'Summer 2027 software engineering internship. Python, Java, SQL.', now() - interval '1 day', now())`;
const skip = canRun() !== null && canRun() !== "FAIL";

Deno.test("D62-0 routing: the record, tracker and alumni asks are the brain's under the release flags; a send ask is not a find", () => {
  const prod = { get: (_k: string) => undefined as string | undefined };
  ok(applicationRecordAsk(prod, "have i applied to anything yet? trying to keep track", "tracking_status"));
  ok(applicationRecordAsk(prod, "yea set up that application tracker", "tracking_status"));
  ok(!applicationRecordAsk({ get: (k) => (k === "CAREER_MAIL_TRACKING" ? "off" : undefined) }, "have i applied to anything yet?", "tracking_status"), "rolled back: the router's");
  ok(!applicationRecordAsk(prod, "have i applied to anything yet?", "career_batch_apply"), "code's own work stays code's");
  ok(alumniSearchAsk(prod, "find me 3 lakeshore alumni working at google or trading firms i could reach out to, just research don't message anyone", "outreach_clarification"));
  ok(!alumniSearchAsk(prod, "find lakeshore alumni at google and email them my resume", "outreach_clarification"), "an ask to send stays on code's networking path");
  ok(!alumniSearchAsk({ get: (k) => (k === "CAREER_PEOPLE_SEARCH" ? "off" : undefined) }, "find me 3 lakeshore alumni at google", "outreach_clarification"), "rolled back: no people search");
  for (const m of ["reply to the email from Globex: tuesday afternoon works", "answer Dana's email and say I'm free Tuesday", "can you respond to that recruiter message for me"]) ok(emailReplyAsk(prod, m, "career_catchall"), m);
  ok(!emailReplyAsk(prod, "reply to the email from Globex", "career_apply_email_draft"), "an exact payload stays code's");
});

Deno.test("D62-0b people leads stand only on their own page's quoted words; LinkedIn and an unnamed employer are dropped", () => {
  const body = { model: "m" };
  const msg = peopleSearchAnswer(body);
  const results = (msg.content[1] as any).content.map((r: any) => ({ url: r.url, title: r.title, page_age: r.page_age }));
  const citations = msg.content.filter((b: any) => b.type === "text" && b.citations).map((b: any) => ({ url: b.citations[0].url, title: b.citations[0].title, cited_text: b.citations[0].cited_text }));
  const answer = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const { leads, dropped } = leadsFrom({ available: true, query: "q", results, citations, answer, searches: 2, errors: [], cost_usd: 0, usage: null, stop_reason: "end_turn", shape: [] }, { ...C19_INPUT });
  eq(leads.map((l) => l.name), ["Priya Raman", "Marcus Lee", "Dana Ortiz"]);
  eq(dropped, 2, "the LinkedIn result and the page that never names Citadel");
  ok(leads.every((l) => l.verified === false && l.school_match === "shown" && !/linkedin/.test(l.url)));
});

Deno.test({ name: "D62-1..3 Gmail read and send: the record from confirmations, the tracker with a correction, and an email answered on one yes", sanitizeOps: false, sanitizeResources: false, ignore: skip, fn: async () => {
  if (canRun() === "FAIL") throw new Error("D62 needs Postgres 16 in CI");
  const gmail = fakeGmail("AT-D62");
  const now = Date.now();
  gmail.inbox.push({ id: "gm-acme-1", threadId: "thr-acme", at: now - 2 * DAY, from: "Acme Analytics Careers <careers@acmeanalytics.com>", subject: "Thank you for applying: Data Analyst at Acme Analytics",
    snippet: "Hi Sam, thank you for applying to the Data Analyst role at Acme Analytics. We have received your application and our team will review it.", messageId: "<acme-1@mail.acmeanalytics.com>", dkim: "acmeanalytics.com" });
  const script: Record<string, Step[]> = {
    C6: [{ tool: "read_application_mail", input: {} }, { text: (calls) => { const r = parse(calls, "read_application_mail"); return `From your Gmail: ${(r.applied ?? []).map((a: any) => `${a.company} (${a.status})`).join(", ")}. ${(r.researched ?? []).map((x: any) => x.company).join(", ")} was research only. Want a tracker?`; } }],
    C16: [{ tool: "export_tracker", input: {} }, { text: (calls) => { const r = parse(calls, "export_tracker"); return `Tracker made. ${(r.changes ?? []).map((c: any) => `Correction: ${c.what} was ${c.was}, now ${c.now}.`).join(" ")} Coverage: ${(r.coverage ?? [])[0] ?? ""}.`; } }],
    R1: [{ tool: "find_email", input: { query: "Globex" } }, { tool: "find_email", input: (calls) => ({ ref: parse(calls, "find_email").mails?.[0]?.ref }) },
      { tool: "draft_email_reply", input: (calls) => ({ ref: parse(calls, "find_email").mails?.[0]?.ref, body: "Hi Dana,\n\nThanks for reaching out. Tuesday afternoon works for me for a 20 minute chat about the Data Analyst role.\n\nBest," }) },
      { text: "Here's the reply." }],
  };
  const { world, person, say, close } = await conversation({ gmail, script, setup: async (pg, u) => { await pg.sql(POSTING); await pg.sql(connectSql(u, "AT-D62")); } });
  try {
    // Tonight's research: the search lists PayPal (C3's turn).
    const c3 = await say("C3", "find me 5 swe internships i could actually apply to right now, chicago or remote");
    ok(c3.reply.includes("PayPal"), c3.reply);

    // D62-1 (C6): the mail run reads Gmail now; the employer's confirmation is the evidence; research is kept apart.
    const c6 = await say("C6", "have i applied to anything yet? trying to keep track");
    ok(!c6.code && c6.tools.includes("read_application_mail"), `C6 reached the brain with the record tool: ${c6.reply}`);
    const r6 = parse(c6.calls, "read_application_mail");
    eq(r6.mail?.gmail, "connected"); eq(r6.mail?.mailbox, "sam.rivera@example.test"); eq(r6.mail?.read_now, "read", "Gmail was read now");
    eq(r6.mail?.multiple_accounts_supported, false, "one Gmail account at a time, said as data");
    ok(gmail.calls.some((c) => c.startsWith("GET /gmail/v1/users/me/messages?q=after:")), gmail.calls.join("\n"));
    const acme = (r6.applied ?? []).find((a: any) => a.company === "Acme Analytics");
    ok(acme && acme.confirmed_by === "employer email" && acme.evidence.some((e: any) => e.from === "gmail" && e.kind === "received" && e.at), `C6: Acme from its confirmation email: ${JSON.stringify(r6.applied)}`);
    ok((r6.researched ?? []).some((x: any) => x.company === "PayPal") && !(r6.applied ?? []).some((a: any) => a.company === "PayPal"), "PayPal is research, not an application");
    ok((r6.coverage ?? []).some((c: string) => /Gmail-based/.test(c)) && (r6.coverage ?? []).some((c: string) => /portal/.test(c)), `coverage: ${r6.coverage}`);
    ok(/Acme Analytics/.test(c6.reply) && /PayPal was research only/.test(c6.reply) && /tracker\?/.test(c6.reply), c6.reply);

    // D62-2 (C16): a rejection arrives; the tracker File is built from the record and corrects the earlier stage out loud (G9).
    gmail.inbox.push({ id: "gm-acme-2", threadId: "thr-acme", at: Date.now() - 1000, from: "Acme Analytics Careers <careers@acmeanalytics.com>", subject: "Update on your application: Data Analyst at Acme Analytics",
      snippet: "Hi Sam, thank you for your interest in the Data Analyst role at Acme Analytics. Unfortunately, we will not be moving forward with your application at this time.", messageId: "<acme-2@mail.acmeanalytics.com>", dkim: "acmeanalytics.com" });
    const c16 = await say("C16", "yea set up that application tracker");
    const t16 = parse(c16.calls, "export_tracker");
    eq(t16.status, "ok", `C16 tracker: ${JSON.stringify(t16).slice(0, 400)}`);
    ok((t16.changes ?? []).some((c: any) => c.what === "stage" && c.was === "Submitted" && c.now === "Rejected"), `the correction: ${JSON.stringify(t16.changes)}`);
    ok(/Correction: stage was Submitted, now Rejected/.test(c16.reply), c16.reply);
    const file = (await world.pg.sql(`select x.kind || '|' || (x.data->'applied'->0->>'company') || '|' || (x.data->'applied'->0->>'source') || '|' || (x.data->'researched'->0->>'company') || '|' || jsonb_array_length(x.data->'coverage') from (select value as d from public.career_watch_kv where user_id = '${person.id}' and key like 'tf:file:%') f, lateral (select d->>'kind' as kind, d->'data' as data) x`)).trim();
    ok(/^tracker\|Acme Analytics\|employer email\|PayPal\|\d+$/.test(file), `the tracker File: ${file}`);
    ok(/https:\/\/\S+/.test(c16.reply) || JSON.stringify(c16.body ?? {}).includes("https://"), `the tracker's link rides the reply: ${c16.reply}`);

    // D62-3: answering an email. The card shows the exact message; nothing is sent until the yes.
    gmail.inbox.push({ id: "gm-globex-1", threadId: "thr-globex", at: Date.now() - 500, from: "Dana Park <dana.park@globex.com>", subject: "Quick chat about the Data Analyst role",
      snippet: "Hi Sam, would you have 20 minutes this week to talk about the Data Analyst role at Globex?", body: "Hi Sam,\n\nWould you have 20 minutes this week to talk about the Data Analyst role at Globex? Let me know what times work.\n\nDana", messageId: "<globex-1@mail.globex.com>" });
    const r1 = await say("R1", "can you reply to the email from Globex and tell Dana tuesday afternoon works for me");
    ok(!r1.code && r1.tools.includes("find_email") && r1.tools.includes("draft_email_reply"), `R1 reached the brain with the email tools (${r1.intent}): ${r1.reply}`);
    const d1 = parse(r1.calls, "draft_email_reply");
    eq(d1.status, "ok", `the draft: ${JSON.stringify(d1)}`);
    eq(r1.intent, "career_mail_reply_card");
    const want = "Hi Dana,\n\nThanks for reaching out. Tuesday afternoon works for me for a 20 minute chat about the Data Analyst role.\n\nBest,\n\nSam Rivera";
    ok(r1.reply.startsWith("Reply to Dana Park") && r1.reply.includes("To: dana.park@globex.com") && r1.reply.includes("Subject: Re: Quick chat about the Data Analyst role") && r1.reply.includes(want), `the card shows the exact message:\n${r1.reply}`);
    eq(gmail.sent.length, 0, "nothing is sent by drafting");
    eq((await world.pg.sql(`select status from public.career_outreach_drafts where user_id = '${person.id}'`)).trim(), "shown");

    const yes = await say("Y1", "yes");
    eq(yes.intent, "career_mail_reply_answer", yes.reply);
    eq(gmail.sent.length, 1, `exactly one send: ${yes.reply}`);
    const mime = gmail.sent[0].raw;
    ok(/^To: dana\.park@globex\.com\r\n/m.test(mime) && /\r\nSubject: Re: Quick chat about the Data Analyst role\r\n/.test(mime) && /\r\nIn-Reply-To: <globex-1@mail\.globex\.com>\r\n/.test(mime), mime);
    ok(mime.endsWith(want.replace(/\n/g, "\r\n")), `the body sent is exactly the body shown:\n${mime}`);
    ok(!/^(?:Cc|Bcc):/im.test(mime), "no Cc or Bcc");
    eq(gmail.sent[0].threadId, "thr-globex", "in the email's own thread");
    eq(buildRaw({ to: "dana.park@globex.com", subject: "Re: x", text: "y" }, { inReplyTo: "<a@b.c>", threadId: null }).length > 0, true);
    eq((await world.pg.sql(`select status from public.career_outreach_drafts where user_id = '${person.id}'`)).trim(), "sent");
    const again = await say("Y2", "yes");
    eq(gmail.sent.length, 1, `a second yes sends nothing more: ${again.reply}`);
  } finally {
    await close();
  }
} });

Deno.test({ name: "D62-4 no Gmail: the record says so and how to connect it; nothing is read; D62-5 C19 alumni from search excerpts, nobody contacted", sanitizeOps: false, sanitizeResources: false, ignore: skip, fn: async () => {
  if (canRun() === "FAIL") throw new Error("D62 needs Postgres 16 in CI");
  const script: Record<string, Step[]> = {
    C6: [{ tool: "read_application_mail", input: {} }, { text: (calls) => { const r = parse(calls, "read_application_mail"); return `No Gmail is connected, so I couldn't read confirmations. Connect it yourself here:\n${r.connect_url}`; } }],
    R1: [{ tool: "find_email", input: { query: "Globex" } }, { text: (calls) => { const r = parse(calls, "find_email"); return `I can't see your email: Gmail isn't connected. Connect it here:\n${r.connect_url}`; } }],
    C19: C19_STEPS,
  };
  const { world, person, say, close } = await conversation({ gmail: null, script });
  try {
    const c6 = await say("C6", "have i applied to anything yet? trying to keep track");
    const r6 = parse(c6.calls, "read_application_mail");
    eq(r6.mail?.gmail, "not_connected"); ok(/\/connect\/gmail$/.test(r6.connect_url), r6.connect_url);
    ok((r6.coverage ?? []).some((c: string) => /no Gmail is connected/.test(c) && /sign in to Google/.test(c)), `${r6.coverage}`);
    ok(/No Gmail is connected/.test(c6.reply) && /\/connect\/gmail/.test(c6.reply), c6.reply);
    eq(c6.outbound, [], "nothing read off the machine");
    const r1 = await say("R1", "can you reply to the email from Globex and say tuesday works");
    eq(parse(r1.calls, "find_email").status, "not_connected", r1.reply);

    // D62-5 (C19): one people search; LinkedIn is blocked in the search and never opened; three leads not verified; nobody contacted.
    const c19 = await say("C19", "find me 3 lakeshore alumni working at google or trading firms i could reach out to, just research don't message anyone");
    ok(!c19.code && c19.tools.includes("find_people"), `C19 reached the brain with find_people: ${c19.reply}`);
    eq(c19.searches, 1, "one people search");
    const body = (c19 as any).searchBody;
    const tool = (body.tools ?? []).find((t: any) => /^web_search_/.test(t.type));
    ok(tool.blocked_domains.includes("linkedin.com") && tool.blocked_domains.includes("indeed.com"), `blocked: ${tool.blocked_domains}`);
    eq(c19.outbound, [], "no page is fetched: excerpts only (LinkedIn never opened)");
    const r19 = parse(c19.calls, "find_people");
    eq(r19.leads.map((l: any) => l.name), ["Priya Raman", "Marcus Lee", "Dana Ortiz"]);
    ok(!r19.leads.some((l: any) => l.url === PEOPLE_PAGES[3].url), "the LinkedIn result is not a lead");
    eq((c19.reply.match(/^\s*\d+\. /gm) ?? []).length, 3, c19.reply);
    ok(/not verified; current employment needs confirming/.test(c19.reply) && /I'd start with/.test(c19.reply), c19.reply);
    ok(/Nobody was contacted\.$/.test(c19.reply), `code keeps the boundary: ${c19.reply}`);
    for (const t of ["career_outreach_drafts", "career_contact_sends", "career_outbox"]) {
      if (!(await world.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t")) continue;
      eq((await world.pg.sql(`select count(*) from public.${t} where user_id = '${person.id}'`)).trim(), "0", `${t}: nobody contacted`);
    }
  } finally {
    await close();
  }
} });
