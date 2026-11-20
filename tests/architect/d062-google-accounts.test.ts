// D-062 (owner, 2026-11-11: "do all of it"; Instinct read three Gmail accounts): several Google accounts per person, at $0 through
// the REAL career handler under production flags, with TWO stub Gmail accounts (each answers only its own access token; every send
// recorded, never delivered) and a stub Google OAuth host (code exchange, userinfo, revoke).
//   GA-1  connecting a second account through the real callback (oauth_connect.ts googleCallback) ADDS it: the first grant is
//         untouched; "what's connected" lists both; a third person cannot take either address.
//   GA-2  "have I applied to anything?" reads both inboxes; each application's evidence names the account it came from; the
//         coverage says 2 accounts were read. The tracker File names the accounts too.
//   GA-3  a reply to an email that reached the second account is sent FROM that account (its token), in its thread, only on the
//         yes; asking to send it from the other account is honoured and shown on the card.
//   GA-4  "disconnect <second address>" removes only it (revoked at Google, its token and its events gone); the first stays, with
//         its events; "disconnect gmail" then removes everything.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d062-google-accounts.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "./helpers/response_world.ts";
import type { Step } from "./helpers/mirror_process.ts";
import { conversation, DAY, fakeGmail, parse, READ, SEND } from "./helpers/d062_world.ts";
import { googleCallback } from "../../supabase/functions/_shared/oauth_connect.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const skip = canRun() !== null && canRun() !== "FAIL";
const FIRST = "sam@example.test", SECOND = "sam.work@example.test";

Deno.test({ name: "GA-1..4 two Google accounts: added not replaced, both read and named, a reply from the account it reached, disconnect one alone", sanitizeOps: false, sanitizeResources: false, ignore: skip, fn: async () => {
  if (canRun() === "FAIL") throw new Error("GA needs Postgres 16 in CI");
  const now = Date.now();
  const a = fakeGmail("AT-FIRST"), b = fakeGmail("AT-SECOND");
  a.inbox.push({ id: "gm-acme-1", threadId: "thr-acme", at: now - 2 * DAY, from: "Acme Analytics Careers <careers@acmeanalytics.com>", subject: "Thank you for applying: Data Analyst at Acme Analytics",
    snippet: "Hi Sam, thank you for applying to the Data Analyst role at Acme Analytics. We have received your application and our team will review it.", messageId: "<acme-1@mail.acmeanalytics.com>", dkim: "acmeanalytics.com" });
  b.inbox.push({ id: "gm-globex-1", threadId: "thr-globex-app", at: now - 2 * DAY + 1000, from: "Globex Careers <careers@globex.com>", subject: "Thank you for applying: Software Engineer Intern at Globex",
    snippet: "Hi Sam, thank you for applying to the Software Engineer Intern role at Globex. We have received your application.", messageId: "<globex-app@mail.globex.com>", dkim: "globex.com" });
  b.inbox.push({ id: "gm-dana-1", threadId: "thr-dana", at: now - DAY, from: "Dana Park <dana.park@globex.com>", subject: "Quick chat about the internship",
    snippet: "Hi Sam, would you have 20 minutes this week to talk about the internship at Globex?", body: "Hi Sam,\n\nWould you have 20 minutes this week to talk about the internship at Globex?\n\nDana", messageId: "<dana-1@mail.globex.com>" });
  // The stub OAuth host: a code is exchanged for that account's token; userinfo names the account; revokes are recorded.
  const CODES: Record<string, { token: string; email: string }> = { "code-first": { token: "AT-FIRST", email: FIRST }, "code-second": { token: "AT-SECOND", email: SECOND } };
  const revoked: string[] = [];
  const google = async (req: Request): Promise<Response | null> => {
    const u = new URL(req.url);
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const c = CODES[new URLSearchParams(await req.text()).get("code") ?? ""];
      return c ? Response.json({ access_token: c.token, refresh_token: `RT-${c.token}`, expires_in: 365 * 86400, scope: `openid email ${READ} ${SEND}` }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") { revoked.push(new URLSearchParams(await req.text()).get("token") ?? ""); return new Response("", { status: 200 }); }
    if (u.host === "www.googleapis.com" && u.pathname === "/oauth2/v2/userinfo") {
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const c = Object.values(CODES).find((x) => x.token === tok);
      return c ? Response.json({ email: c.email }) : Response.json({}, { status: 401 });
    }
    if (u.host === "gmail.googleapis.com") return await (req.headers.get("authorization") === "Bearer AT-SECOND" ? b : a).handle(req);
    return null;
  };
  const script: Record<string, Step[]> = {
    C6: [{ tool: "read_application_mail", input: {} }, { text: (calls) => { const r = parse(calls, "read_application_mail"); return `${r.coverage?.[0]}. ${(r.applied ?? []).map((x: any) => `${x.company} (${x.evidence.find((e: any) => e.account)?.account})`).join(", ")}. Want a tracker?`; } }],
    C16: [{ tool: "export_tracker", input: {} }, { text: "Your tracker is ready." }],
    R1: [{ tool: "find_email", input: { query: "Globex" } }, { tool: "find_email", input: (calls) => ({ ref: parse(calls, "find_email").mails?.find((m: any) => /Dana/.test(m.from_name))?.ref }) },
      { tool: "draft_email_reply", input: (calls) => ({ ref: parse(calls, "find_email").mails?.find((m: any) => /Dana/.test(m.from_name))?.ref, body: "Hi Dana,\n\nThanks for reaching out. Tuesday afternoon works for me for 20 minutes.\n\nBest," }) },
      { text: "Here's the reply." }],
    R2: [{ tool: "find_email", input: { query: "Globex" } }, { tool: "draft_email_reply", input: (calls) => ({ ref: parse(calls, "find_email").mails?.find((m: any) => /Dana/.test(m.from_name))?.ref, body: "Hi Dana,\n\nThanks for reaching out. Tuesday afternoon works for me for 20 minutes.\n\nBest,", send_from: FIRST }) },
      { text: "Here's the reply." }],
  };
  const { world, person, say, close } = await conversation({ google, script, setup: async (pg, u) => { await pg.sql(`insert into public.career_outreach_prefs (user_id, signature) values ('${u}', 'Sam Rivera')`); } });
  const q = async (sql: string) => (await world.pg.sql(sql)).trim();
  const cb = (code: string, userId: string) => googleCallback({ admin: world.pg.asService() as any, fetch: (async (i: any, init?: any) => (await google(new Request(i, init)))!) as typeof fetch, now: Date.now,
    clientId: "cid", clientSecret: "csecret", redirectUri: "https://trainee.example.test/oauth", grantedFallback: () => READ }, { code, state: `st-${code}-${userId}`, userId, provider: "google_career" });
  try {
    // GA-1: the first account, then the second: added beside it.
    const c1 = await cb("code-first", person.id);
    ok(c1.ok && !(c1 as any).added, `the first account is the first grant: ${JSON.stringify(c1)}`);
    const c2 = await cb("code-second", person.id);
    ok(c2.ok && (c2 as any).added === true, `the second account is added: ${JSON.stringify(c2)}`);
    eq(await q(`select email from public.user_oauth_connections where user_id = '${person.id}' and provider = 'google_career'`), FIRST, "the first grant is untouched");
    eq(await q(`select mailbox from public.career_google_accounts where user_id = '${person.id}'`), SECOND);
    const other = await world.person({ resume: false });
    const c3 = await cb("code-second", other.id);
    ok(!c3.ok && (c3 as any).why === "taken", `another person cannot take an added address: ${JSON.stringify(c3)}`);
    const listed = await say("W1", "what's connected?");
    ok(listed.reply.includes(FIRST) && listed.reply.includes(SECOND) && /2 accounts/.test(listed.reply), listed.reply);

    // GA-2: both inboxes read; each piece of evidence names its account; coverage says two accounts.
    const c6 = await say("C6", "have i applied to anything yet? trying to keep track");
    const r6 = parse(c6.calls, "read_application_mail");
    eq(r6.mail?.accounts, [FIRST, SECOND]); eq(r6.mail?.accounts_read, [FIRST, SECOND]);
    const by = Object.fromEntries((r6.applied ?? []).map((x: any) => [x.company, x.evidence.find((e: any) => e.from === "gmail")?.account]));
    eq(by, { "Acme Analytics": FIRST, Globex: SECOND }, `evidence by account: ${JSON.stringify(r6.applied)}`);
    ok(/^Gmail-based: 2 Gmail accounts read \(sam@example\.test, sam\.work@example\.test\)/.test(r6.coverage?.[0] ?? ""), `coverage: ${r6.coverage}`);
    ok(a.calls.some((c) => c.includes("?q=after:")) && b.calls.some((c) => c.includes("?q=after:")), "both inboxes were read now");
    eq(await q(`select string_agg(company || '|' || coalesce(mailbox, '-'), ',' order by company) from public.career_mail_events where user_id = '${person.id}'`), `Acme Analytics|${FIRST},Globex|${SECOND}`);
    const c16 = await say("C16", "yea set up that application tracker");
    eq(parse(c16.calls, "export_tracker").status, "ok");
    const ev = await q(`select string_agg(e->>'what', ' / ') from public.career_watch_kv w, jsonb_array_elements(w.value->'data'->'applied') a, jsonb_array_elements(a->'evidence') e where w.user_id = '${person.id}' and w.key like 'tf:file:%'`);
    ok(ev.includes(`(${FIRST})`) && ev.includes(`(${SECOND})`), `the tracker names each account: ${ev}`);

    // GA-3: Dana wrote to the second account: the reply goes from it, in its thread, only on the yes.
    const r1 = await say("R1", "reply to the email from Dana at Globex and say tuesday afternoon works");
    const found = parse(r1.calls, "find_email");
    ok((found.mails ?? []).some((m: any) => m.account === SECOND && /Dana/.test(m.from_name)), `find_email names the account: ${JSON.stringify(found).slice(0, 300)}`);
    eq(parse(r1.calls, "draft_email_reply").status, "ok", JSON.stringify(r1.calls.at(-1)));
    ok(r1.reply.includes(`From: ${SECOND}`) && r1.reply.includes("To: dana.park@globex.com"), r1.reply);
    eq(a.sent.length + b.sent.length, 0, "nothing is sent by drafting");
    const y1 = await say("Y1", "yes");
    eq([a.sent.length, b.sent.length], [0, 1], `sent once, from the second account: ${y1.reply}`);
    eq(b.sent[0].threadId, "thr-dana", "in that account's thread");
    ok(/\r\nIn-Reply-To: <dana-1@mail\.globex\.com>\r\n/.test(b.sent[0].raw), b.sent[0].raw);
    ok(y1.reply.includes(`from ${SECOND}`), y1.reply);
    // The person chose the other account: shown on the card, sent from it, as a new thread there.
    const r2 = await say("R2", "reply to Dana's email again but send it from my other gmail");
    ok(r2.reply.includes(`From: ${FIRST}`), r2.reply);
    await say("Y2", "yes");
    eq([a.sent.length, b.sent.length], [1, 1], "the second reply went from the first account");
    eq(a.sent[0].threadId, null, "a new thread in the other account");

    // GA-4: disconnect the second account alone; then everything.
    const d1 = await say("D1", `disconnect ${SECOND}`);
    ok(new RegExp(`^${SECOND.replace(/\./g, "\\.")} is disconnected\\.`).test(d1.reply) && d1.reply.includes(`${FIRST} stays connected`), d1.reply);
    ok(revoked.includes("RT-AT-SECOND"), `revoked at Google: ${revoked}`);
    eq(await q(`select count(*) from public.career_google_accounts where user_id = '${person.id}'`), "0");
    eq(await q(`select count(*) from vault.secrets where name like 'oauth_google_career_${person.id}_%'`), "0", "its token is gone");
    eq(await q(`select string_agg(company, ',') from public.career_mail_events where user_id = '${person.id}'`), "Acme Analytics", "only its events went");
    eq(await q(`select email from public.user_oauth_connections where user_id = '${person.id}' and provider = 'google_career'`), FIRST, "the first stays");
    await cb("code-second", person.id); // added again, then everything goes at once
    const d2 = await say("D2", "disconnect gmail");
    ok(/^Gmail is disconnected\./.test(d2.reply), d2.reply);
    eq(await q(`select (select count(*) from public.user_oauth_connections where user_id = '${person.id}' and provider = 'google_career') + (select count(*) from public.career_google_accounts where user_id = '${person.id}') + (select count(*) from public.career_mail_events where user_id = '${person.id}')`), "0", "nothing is left");
    eq(await q(`select count(*) from vault.secrets where name like 'oauth_google_career_${person.id}%'`), "0", "no token is left");
  } finally {
    await close();
  }
} });
