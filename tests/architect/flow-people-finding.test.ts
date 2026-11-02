// PEOPLE FINDING and INTRODUCTIONS (D-033) through the REAL handler (agent-chat/handler-career.ts handleChat) on real
// Postgres, as new people use it on the web (their app's request, with `attachments`) and through the texting bridge
// (Telegram and SMS turns arrive as the service-role call with `as_user_id`, exactly as channel_runtime sends them).
// Every step asserts the database, and that the reply says no more than the database holds. The model (OpenAI), Gmail
// and one company website are scripted fakes at their real URLs; any other host fails the test. Nothing is sent: no
// request to Gmail's send endpoint, no outreach row, no outbox row; nothing is fetched from LinkedIn, Indeed or Handshake.
import { personalOpenAI, seedFactsSql, seedKeysSql } from "./personal-fixture.ts";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeNet, HANDSHAKE_HTML, http, INDEED_HTML, zipOf } from "./people-finding-fixtures.ts";
const MAX_INFLATE = 20_000_000; // career_people_import.ts MAX_INFLATE: one ZIP entry inflates to at most this

function assert(v: unknown, m?: string): asserts v { assertNode.ok(v, m); }
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const FIXTURE = await Deno.readTextFile(`${ROOT}tests/fixtures/people/Connections.csv`);
const PEOPLE: Record<string, string> = { "tok-a": "8c0f8f8e-6a43-4a49-9d2c-0000000000a1", "tok-b": "8c0f8f8e-6a43-4a49-9d2c-0000000000b2", "tok-c": "8c0f8f8e-6a43-4a49-9d2c-0000000000c3" };
const A = PEOPLE["tok-a"], B = PEOPLE["tok-b"], C = PEOPLE["tok-c"];
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------------------------------------------ the fakes
let modelCalls = 0;
function fakeOpenAI(body: any): Response {
  // PERSONALIZED OUTREACH (2026-10-31): a first email's payload is the engine's, answered from it (personal-fixture.ts).
  const personal = personalOpenAI(body);
  if (personal) { modelCalls++; return personal as any; }
  modelCalls++;
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
  const topic = /ASK ABOUT[^\n]*\n- (.+)/.exec(user)?.[1] ?? "";
  const intro = /^an introduction to ([^,;]+)/.exec(topic);
  const ask = /to ask about ([^;]+)/.exec(topic)?.[1] ?? (/^(?:the|a|an) /.test(topic) ? topic : "how you got started");
  const text = intro
    ? `Subject: An introduction\n\nHi ${first},\n\nWould you be open to an introduction to ${intro[1]}? I'd like to ask about ${ask}. A short note you can forward is below.`
    : `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to ask about ${ask}. Would you be open to a short call?`;
  return Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } });
}
const hdr = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const AUTH_OK = (d: string) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`;
const job = (from: string, auth: string, html: string) => ({ internalDate: String(Date.parse("2026-10-20T12:00:00Z")), payload: { mimeType: "multipart/alternative", headers: hdr({ From: from, "Authentication-Results": auth }), parts: [{ mimeType: "text/html", body: { data: b64u(html) } }] } });
const GMAIL: Record<string, any> = {
  c1: { internalDate: String(Date.parse("2026-10-01T15:00:00Z")), payload: { headers: hdr({ From: '"Jordan Rivera" <jordan.rivera@ramp.com>', To: "a@example.test", Cc: "careers@ramp.com, Mallory <mal@ramp.com.evil.io>" }) } },
  j1: job("Indeed <alert@indeed.com>", AUTH_OK("indeed.com"), INDEED_HTML),
  j2: job("Handshake <notifications@notifications.joinhandshake.com>", AUTH_OK("joinhandshake.com"), HANDSHAKE_HTML),
  j3: job("Indeed <alert@indeed.com>", "mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=indeed.com", INDEED_HTML),
  r1: { internalDate: String(Date.now()), payload: { headers: [] } },
};
let replyFrom = ""; // the address that has written back (Gmail's view)
function fakeGmail(u: URL): Response {
  if (u.pathname.endsWith("/profile")) return Response.json({ emailAddress: "a@example.test" });
  if (u.pathname.endsWith("/messages")) {
    const q = u.searchParams.get("q") ?? "";
    if (/^\{from:ramp /.test(q)) return Response.json({ messages: [{ id: "c1" }] });
    if (/indeed\.com/.test(q)) return Response.json({ messages: [{ id: "j1" }, { id: "j2" }, { id: "j3" }] });
    if (replyFrom && q.startsWith(`from:${replyFrom} after:`)) return Response.json({ messages: [{ id: "r1" }] });
    return Response.json({ resultSizeEstimate: 0 });
  }
  const m = GMAIL[u.pathname.split("/").pop()!];
  return m ? Response.json(m) : new Response("{}", { status: 404 });
}
const TEAM = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Ramp","employee":[
{"@type":"Person","name":"Maya Chen","jobTitle":"Data Science Manager","worksFor":{"@type":"Organization","name":"Ramp"}},
{"@type":"Person","name":"Jordan Lee","jobTitle":"Head of Talent","email":"mailto:jordan.lee@rampfixture.com"}]}</script></head>
<body><p>Meet Bob Smith and Alice Jones.</p><a href="mailto:careers@rampfixture.com">Email us</a><a href="mailto:pat.lee@rampfixture.com">Pat Lee</a></body></html>`;

Deno.test({ name: "people finding and intros at the real handler: import, who, alumni, page, intro, approve, track, jobs, forget, erase", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const env = { CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: "sk-test-not-real", CAREER_MODEL: "gpt-5-mini" };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const outside: string[] = [];
  let restoreDns = () => {};
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    handler = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
      outside.push(`${req.method} ${u.host}${u.pathname}${u.search}`);
      if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
      if (u.host === "gmail.googleapis.com") return fakeGmail(u);
      return new Response("not faked", { status: 599 });
    }) as typeof fetch;
    // DNS, faked like every other outside service: the one company site answers with a public address; any other name
    // doesn't resolve (the page reader checks every address a name resolves to before it fetches).
    const realDns = Deno.resolveDns, realConnect = Deno.connect, realStartTls = Deno.startTls;
    restoreDns = () => { Object.assign(Deno as any, { resolveDns: realDns, connect: realConnect, startTls: realStartTls }); };
    // The company site, at the TCP and TLS layer the page reader really uses (pinnedGet): what it connects to and the name
    // it does TLS for are recorded; the requests are answered from fixtures.
    const site = fakeNet(({ ip, sni, request }) => {
      const path = /^GET (\S+) HTTP\/1\.1/.exec(request)?.[1] ?? "";
      outside.push(`GET ${sni}${path}`);
      if (ip !== "93.184.215.14" || sni !== "rampfixture.com") return http(421, { "content-length": "0" }, "");
      if (path === "/robots.txt") return http(200, { "content-type": "text/plain", "content-length": "33" }, "User-agent: *\nDisallow: /private\n");
      if (path === "/team") return http(200, { "content-type": "text/html", "transfer-encoding": "chunked" }, `${new TextEncoder().encode(TEAM).length.toString(16)}\r\n${TEAM}\r\n0\r\n\r\n`);
      return http(404, { "content-length": "0" }, "");
    });
    Object.assign(Deno as any, { connect: (o: { hostname: string; port: number }) => site.connect(o), startTls: (c: any, o: { hostname: string }) => site.startTls(c, o) });
    (Deno as any).resolveDns = async (host: string, type: string) => {
      outside.push(`DNS ${host}/${type}`);
      if (host === "rampfixture.com") return type === "A" ? ["93.184.215.14"] : [];
      throw new Error(`NXDOMAIN ${host}`);
    };
    const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
    // The texting bridge's call (channel_runtime.ts): service role, as the person, the thread the channel keeps.
    const bridge = (userId: string) => {
      let thread: string | null = null;
      return async (message: string) => {
        const res = await handleChat(new Request(`${SUPABASE_URL}/functions/v1/agent-chat`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ as_user_id: userId, message, turn_key: crypto.randomUUID(), ...(thread ? { thread_id: thread } : {}) }) }));
        const body = await res.json().catch(() => ({}));
        if (body?.thread_id) thread = body.thread_id;
        eq(res.status, 200, JSON.stringify(body));
        return { reply: String(body?.reply ?? ""), intent: body?.meta?.intent ?? null, resultStatus: body?.meta?.result_status ?? null };
      };
    };
    const web: Chat = handler.chat("tok-a");
    const say = async (message: string, extra: Record<string, unknown> = {}) => { const r = await web.say(message, extra); eq(r.status, 200, r.reply); return r; };
    const q = async (sql: string) => JSON.parse(await pg.sql(sql));
    const people = (u: string, src = "linkedin_export") => q(`select coalesce(jsonb_agg(jsonb_build_object('name', name, 'email', email, 'company', company, 'key', company_key, 'school', school, 'url', source_url, 'ref', source_ref) order by id), '[]') from public.career_people where user_id = '${u}' and source = '${src}'`);
    const count = async (tbl: string, u: string, extra = "") => Number(await q(`select count(*) from public.${tbl} where user_id = '${u}' ${extra}`));
    const intro = async (n: number) => q(`select to_jsonb(i) from public.career_intro_requests i where user_id = '${A}' and n = ${n}`);
    const stateContacts = async () => q(`select coalesce(state->'career'->'stores'->'contacts', '[]') from public.agent_flow_state where user_id = '${A}' order by updated_at desc limit 1`);
    // Architect ruling R1 (#225): the drafter's contacts are the account's (career_account_contacts), never a chat's copy.
    const accountContacts = async (u = A, more = "") => Number(await q(`select count(distinct person_key) from public.career_account_contacts where user_id = '${u}' ${more}`));

    await t.step("a new person asks who they know before sending anything: the one ask (why, three steps), recorded once", async () => {
      const r = await say("who do I know at Ramp?");
      eq([r.intent, r.resultStatus], ["career_contacts_at", "no_contacts"], r.reply);
      assert(/haven't sent me any contacts yet/.test(r.reply) && /1\) on LinkedIn: Me, Settings & Privacy, Data privacy, Get a copy of your data, Connections, Request archive; 2\)/.test(r.reply) && /I never open LinkedIn for you/.test(r.reply), r.reply);
      assert(/Attaching a file isn't available in this chat yet/.test(r.reply), "the reply says what isn't available");
      assert(await q(`select to_jsonb(export_asked_at is not null) from public.career_people_prefs where user_id = '${A}'`), "the ask is recorded");
      const again = await say("hmm do i know anyone at ramp");
      eq(again.resultStatus, "no_contacts", again.reply);
      assert(/steps are in my earlier message/.test(again.reply) && !/1\) on LinkedIn/.test(again.reply), `asked once, then pointed back: ${again.reply}`);
      eq(await count("career_people", A), 0);
    });

    await t.step("their resume, confirmed", async () => {
      eq((await say(`here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
      eq((await say("yes, that's my resume")).resultStatus, "completed");
    });

    await t.step("web: the LinkedIn export as a file: one line with the database's counts; formulas, no-name rows and duplicates never kept", async () => {
      const r = await say("here's my linkedin export", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: FIXTURE }] });
      eq([r.intent, r.resultStatus], ["career_contacts_import", "imported"], r.reply);
      eq(r.reply, "Connections.csv: imported 8/11 rows into your contacts (left out: 1 duplicate; row 7: a name that is a spreadsheet formula; row 9: no name). 3/8 have an email address; LinkedIn includes one only when the person allowed it, and I never guess an address. I blanked 1 cell that a spreadsheet would run as a formula.");
      const rows = await people(A);
      eq(rows.length, 8);
      eq(rows.filter((x: any) => x.email).length, 3);
      assert(!JSON.stringify(rows).includes("linkedin.com") && !JSON.stringify(rows).includes("HYPERLINK") && !JSON.stringify(rows).includes("cmd|"), JSON.stringify(rows));
      eq(rows.find((x: any) => x.name === "Sam Rivera").company, "");
      eq(await q(`select jsonb_build_object('read', rows_read, 'imported', imported, 'skipped', skipped, 'with_email', with_email) from public.career_people_imports where user_id = '${A}'`), { read: 11, imported: 8, skipped: 2, with_email: 3 });
      eq(await accountContacts(), 8, "the drafter's copy, on the account");
      eq((await stateContacts()).length, 0, "no copy in the chat");
      // the same file again (a retry): replaced, never doubled
      const again = await say("here's my linkedin export", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: FIXTURE }] });
      assert(/imported 8\/11 rows/.test(again.reply), again.reply);
      eq(await count("career_people", A), 8);
    });

    await t.step("web: the archive as a ZIP is read; a zip bomb, an encrypted ZIP and a ZIP without the file change nothing", async () => {
      const zip = await zipOf([{ name: "Basic_LinkedInDataExport_10-26-2026/Connections.csv", data: new TextEncoder().encode(FIXTURE) }, { name: "Profile.csv", data: new TextEncoder().encode("a,b") }]);
      const z = await say("the zip linkedin sent me", { attachments: [{ name: "Basic_LinkedInDataExport_10-26-2026.zip", mime: "application/zip", text: b64(zip) }] });
      eq(z.resultStatus, "imported", z.reply);
      assert(/^Basic_LinkedInDataExport_10-26-2026\.zip \(Connections\.csv\): imported 8\/11 rows/.test(z.reply), z.reply);
      eq(await count("career_people", A), 8);
      const before = JSON.stringify(await people(A));
      const bomb = await zipOf([{ name: "Connections.csv", data: new Uint8Array(MAX_INFLATE + 1), claim: 1000 }]);
      for (const [file, why] of [[bomb, /unpacks to far more data/], [await zipOf([{ name: "Connections.csv", data: new Uint8Array(5), flags: 1 }]), /password-protected/], [await zipOf([{ name: "Messages.csv", data: new Uint8Array(5) }]), /no Connections\.csv in it/]] as const) {
        const r = await say("linkedin zip", { attachments: [{ name: "export.zip", mime: "application/zip", text: b64(file) }] });
        eq([r.intent, r.resultStatus], ["career_contacts_import", "not_imported"], r.reply);
        assert(why.test(r.reply) && /nothing imported/.test(r.reply), r.reply);
      }
      eq(JSON.stringify(await people(A)), before, "a refused file changes nothing");
    });

    await t.step("Telegram: a long export pasted in parts (header first, then rows only); SMS: messy asks; nobody sees anyone else's people", async () => {
      const tg = bridge(B);
      const lines = FIXTURE.split("\r\n");
      const header = lines.findIndex((l) => l.startsWith("First Name"));
      const p1 = await tg([lines[header], lines[header + 1], lines[header + 2], lines[header + 3]].join("\n"));
      eq([p1.intent, p1.resultStatus], ["career_contacts_import", "imported"], p1.reply);
      assert(/imported 3\/3 rows/.test(p1.reply) && /paste the next part/.test(p1.reply), p1.reply);
      const p2 = await tg([lines[header + 4], lines[header + 5], lines[header + 10]].join("\n"));
      eq(p2.resultStatus, "imported", p2.reply);
      assert(/imported 3\/3 rows/.test(p2.reply), p2.reply);
      eq(await count("career_people", B), 6);
      const who = await tg("who do i know at ramp");
      eq([who.intent, who.resultStatus], ["career_contacts_at", "listed"], who.reply);
      assert(/^You have 3 contacts at ramp, 2 with an email address:/.test(who.reply) && /Alex O'Brien/.test(who.reply) && !/Dana Kim|Zoë/.test(who.reply), who.reply);
      const sms = bridge(C);
      const s1 = await sms("yo who do i know at stripe??");
      eq([s1.intent, s1.resultStatus], ["career_contacts_at", "no_contacts"], s1.reply);
      assert(/Get a copy of your data, Connections/.test(s1.reply), s1.reply);
      eq(await count("career_people", C), 0);
      eq(await count("career_people", A), 8, "A's people untouched by B and C");
    });

    await t.step("who and alumni: their sources named; the export's missing school said; a school they give is kept", async () => {
      const r = await say("who do I know at Ramp?");
      eq([r.intent, r.resultStatus], ["career_contacts_at", "listed"], r.reply);
      assert(/^You have 3 contacts at Ramp, 2 with an email address:/.test(r.reply), r.reply);
      assert(/- Priya Shah, Senior Data Analyst \(no email address\) · your LinkedIn export, connected 2025-03-14/.test(r.reply), r.reply);
      assert(/- Lee Park, Software Engineer \(lee\.park@rampfixture\.com\)/.test(r.reply) && /Gmail isn't connected/.test(r.reply), r.reply);
      const gs = await say("do I know anyone at Goldman?");
      assert(/You have 1 contact at Goldman/.test(gs.reply) && /Dana Kim/.test(gs.reply), gs.reply);
      const al = await say("DePaul alumni at Ramp");
      eq([al.intent, al.resultStatus], ["career_people_alumni", "none"], al.reply);
      assert(/LinkedIn's Connections file has no school column/.test(al.reply), al.reply);
      const set = await say("Priya Shah went to DePaul");
      eq([set.intent, set.resultStatus], ["career_people_school", "saved"], set.reply);
      eq((await people(A)).find((x: any) => x.name === "Priya Shah").school, "DePaul");
      const al2 = await say("any alumni from DePaul at Ramp?");
      eq(al2.resultStatus, "listed", al2.reply);
      assert(/^1 contact at Ramp on file as DePaul alumni:\n- Priya Shah/.test(al2.reply), al2.reply);
      eq(al2.reply.split("\n").filter((l) => l.startsWith("- ")).length, 1, al2.reply);
    });

    await t.step("a public page they send: only names marked up as people and published addresses, with the source URL; LinkedIn refused unopened", async () => {
      const r = await say("here's Ramp's team page https://rampfixture.com/team");
      eq([r.intent, r.resultStatus], ["career_people_page", "read"], r.reply);
      const rows = await people(A, "company_page");
      eq(rows.map((x: any) => [x.name, x.email, x.key, x.url]), [["Maya Chen", null, "ramp", "https://rampfixture.com/team"], ["Jordan Lee", "jordan.lee@rampfixture.com", "ramp", "https://rampfixture.com/team"], ["Pat Lee", "pat.lee@rampfixture.com", "ramp", "https://rampfixture.com/team"]]);
      assert(!/Bob Smith|careers@/.test(r.reply) && /never guess an email/.test(r.reply), r.reply);
      assert(outside.includes("GET rampfixture.com/robots.txt"), "robots.txt read first");
      const li = await say("find people at Ramp on https://www.linkedin.com/company/ramp/people/");
      eq([li.intent, li.resultStatus], ["career_people_page", "refused"], li.reply);
      assert(/never open LinkedIn, Indeed or Handshake pages/.test(li.reply), li.reply);
    });

    let introOne: any;
    await t.step("intro through a mutual: drafted from confirmed facts with a forwardable note; double tap is one draft; nothing sent", async () => {
      const before = modelCalls;
      // PERSONALIZED OUTREACH (2026-10-31): the people the notes are to each carry one sourced fact (what the person told
      // Trainee), so the note is written for them; with nothing on record the person is asked one question instead.
      await pg.sql(seedKeysSql(A, ["n:maya chen@ramp", "n:priya shah@ramp"]));
      const r = await say("can u get me an intro to maya chen at ramp about the data analyst role");
      eq([r.intent, r.resultStatus], ["career_intro_request", "drafted"], r.reply);
      eq(modelCalls - before, 2, "one request, one forwardable note");
      introOne = await intro(1);
      eq([introOne.route, introOne.target_name, introOne.status, introOne.delivery], ["mutual", "Maya Chen", "drafted", "mailto"]);
      assert(["Alex O'Brien", "Lee Park"].includes(introOne.via_name) && introOne.to_email && /rampfixture\.com$/.test(introOne.to_email), JSON.stringify(introOne));
      eq(introOne.payload_hash, await sha(JSON.stringify([introOne.to_email, introOne.subject, introOne.body, introOne.blurb])));
      assert(r.reply.includes(introOne.body) && r.reply.includes(introOne.blurb) && /I don't send anything/.test(r.reply) && /approve intro 1/.test(r.reply), r.reply);
      const again = await say("can u get me an intro to maya chen at ramp about the data analyst role");
      assert(/Intro 1 is already drafted/.test(again.reply), again.reply);
      eq([await count("career_intro_requests", A), modelCalls - before], [1, 2]);
    });

    await t.step("approve: exactly the shown text, delivered as a mailto link they open; a second yes changes nothing", async () => {
      const r = await say("approve intro 1");
      eq([r.intent, r.resultStatus], ["career_intro_update", "approved"], r.reply);
      const i = await intro(1);
      eq([i.status, i.approved_hash], ["approved", i.payload_hash]);
      assert(r.reply.includes(`mailto:${encodeURIComponent(i.to_email)}?subject=`) && /I don't send it/.test(r.reply), r.reply);
      const twice = await say("approve intro 1");
      eq(twice.resultStatus, "approved");
      eq((await intro(1)).approved_at, i.approved_at, "the second yes is the same approval");
    });

    await t.step("a direct note, a changed text refused, a redo, a copy-only delivery; no path; another person can't touch it", async () => {
      const d = await say("intro to Priya Shah at Ramp");
      eq(d.resultStatus, "drafted", d.reply);
      eq([(await intro(2)).route, (await intro(2)).delivery], ["direct", "copy"]);
      await pg.sql(`update public.career_intro_requests set body = body || ' P.S. tampered' where user_id = '${A}' and n = 2`);
      const bad = await say("approve intro 2");
      eq(bad.resultStatus, "refused", bad.reply);
      eq([(await intro(2)).status, (await intro(2)).approved_hash], ["drafted", null]);
      const redo = await say("redo intro 2");
      eq(redo.resultStatus, "drafted", redo.reply);
      const ok = await say("approve intro 2");
      eq(ok.resultStatus, "approved", ok.reply);
      assert(/to copy and send to Priya Shah yourself/.test(ok.reply) && /I don't open LinkedIn/.test(ok.reply) && !/mailto:/.test(ok.reply), ok.reply);
      const callsBefore = modelCalls;
      const none = await say("get me an intro to Zed Quill at Nowhere Labs");
      eq([none.intent, none.resultStatus], ["career_intro_request", "no_path"], none.reply);
      assert(/never guess/.test(none.reply) || /I won't guess/.test(none.reply), none.reply);
      eq([await count("career_intro_requests", A), modelCalls], [2, callsBefore]);
      const other = await bridge(B)("approve intro 1");
      eq(other.resultStatus, "not_found", other.reply);
      eq((await intro(1)).status, "approved");
    });

    await t.step("tracking: sent, a reminder only when asked, due once, no reply; Gmail shows a reply", async () => {
      eq((await say("intro 1 sent")).resultStatus, "sent");
      const sentAt = (await intro(1)).sent_at;
      const rem = await say("remind me about intro 1 in 3 days");
      eq(rem.resultStatus, "reminder_set", rem.reply);
      assert(/I can't message you first yet/.test(rem.reply), rem.reply);
      eq(Date.parse((await intro(1)).follow_up_at) - Date.parse(sentAt), 3 * 86400_000);
      eq((await intro(2)).follow_up_at, null, "no reminder anyone didn't ask for");
      await pg.sql(`update public.career_intro_requests set follow_up_at = now() - interval '1 hour' where user_id = '${A}' and n = 1`);
      const due = await say("my intros");
      assert(/^Reminder you asked for: intro 1 to /.test(due.reply), due.reply);
      assert((await intro(1)).reminded_at, "reminded once");
      const again = await say("my intros");
      assert(!/Reminder you asked for/.test(again.reply), again.reply);
      eq((await say("intro 2 sent")).resultStatus, "sent");
      eq((await say("intro 2 no reply")).resultStatus, "no_reply");
      eq([(await intro(2)).status, (await intro(2)).status_source], ["no_reply", "person"]);
    });

    await t.step("Gmail connected: correspondents at ramp.com (headers only), the intro reply seen, Handshake and Indeed postings with their links", async () => {
      await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${A}', 'google_career', 'oauth_google_career_${A}', 'a@example.test', '${READ}');
        select public.oauth_vault_store('oauth_google_career_${A}', '{"access_token":"AT-P","refresh_token":"RT-P","expires_at":${Date.now() + 365 * 86400_000}}');`);
      const r = await say("who do I know at Ramp?");
      assert(/You have 4 contacts at Ramp/.test(r.reply) || /contacts at Ramp/.test(r.reply), r.reply);
      assert(/- Jordan Rivera \(jordan\.rivera@ramp\.com\) · your Gmail, last email 2026-10-01/.test(r.reply), r.reply);
      eq((await people(A, "gmail")).map((x: any) => x.email), ["jordan.rivera@ramp.com"]);
      assert(!outside.some((c) => /gmail.*format=full/.test(c) && /c1/.test(c)), "correspondents read from headers only");
      replyFrom = (await intro(1)).to_email;
      const list = await say("my intros");
      assert(/1\. via .+ to Maya Chen \(Ramp\): replied \(Gmail shows a reply\)/.test(list.reply), list.reply);
      eq([(await intro(1)).status, (await intro(1)).status_source], ["replied", "gmail"]);
      const jobs = await say("show me jobs from my Indeed and Handshake emails");
      eq([jobs.intent, jobs.resultStatus], ["career_job_emails", "listed"], jobs.reply);
      eq(await q(`select jsonb_agg(jsonb_build_object('s', source, 't', title, 'u', url) order by url) from public.career_job_emails where user_id = '${A}'`), [
        { s: "handshake", t: "Analytics Intern", u: "https://app.joinhandshake.com/jobs/1234567?ref=email" },
        { s: "indeed", t: "Data Analyst", u: "https://www.indeed.com/rc/clk?jk=0123456789abcdef&from=ja" },
        { s: "indeed", t: "Business Analyst & Ops", u: "https://www.indeed.com/viewjob?jk=fedcba9876543210" },
      ].sort((a, b) => a.u.localeCompare(b.u)));
      assert(/1 email that claimed to be from them didn't pass Gmail's sender check/.test(jobs.reply) && /I never log in to Handshake or Indeed/.test(jobs.reply), jobs.reply);
    });

    await t.step("the scheduled push's read on Postgres: only approved or sent intros with a reminder armed and due, never replied, cancelled or no-reply ones", async () => {
      const { supabasePeopleStore } = await import("../../supabase/functions/_shared/career_people.ts");
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const store = supabasePeopleStore(createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }));
      const row = (n: number, status: string) => `('${A}', ${n}, 'direct', 'T${n}', 'x', 'you named them', 'P${n}', null, 'copy', 's', 'b', '${"a".repeat(64)}', '${status}',
        ${status === "approved" ? `'${"a".repeat(64)}'` : "null"}, now() - interval '2 days', now() - interval '1 hour', null)`;
      await pg.sql(`insert into public.career_intro_requests (user_id, n, route, target_name, target_company, target_ref, to_name, to_email, delivery, subject, body, payload_hash, status, approved_hash, sent_at, follow_up_at, reminded_at) values
        ${[[901, "approved"], [902, "sent"], [903, "replied"], [904, "cancelled"], [905, "no_reply"], [906, "drafted"]].map(([n, s]) => row(n as number, s as string)).join(",\n")}`);
      const due = (await store.dueIntros(new Date().toISOString())).filter((d) => d.userId === A && d.intro.n >= 900).map((d) => [d.intro.n, d.intro.status]);
      eq(due, [[901, "approved"], [902, "sent"]], "replied, cancelled, no-reply and drafted intros with a reminder still armed are never pushed");
      await pg.sql(`delete from public.career_intro_requests where user_id = '${A}' and n >= 900`);
    });

    await t.step("the remind reply on the web with the push on: no texting channel, so no promise of a text", async () => {
      Deno.env.set("CAREER_INTRO_REMINDERS", "on");
      try {
        const n = Number(await q(`select max(n) from public.career_intro_requests where user_id = '${A}'`));
        await pg.sql(`update public.career_intro_requests set status = 'sent', status_source = 'person', sent_at = now(), follow_up_at = null where user_id = '${A}' and n = ${n}`);
        const r = await say(`remind me about intro ${n} in 4 days`);
        eq(r.resultStatus, "reminder_set", r.reply);
        assert(!/text you/.test(r.reply) && /haven't connected a texting app/.test(r.reply), r.reply);
        await pg.sql(`insert into public.channel_contacts (contact, user_id) values ('tg:4242', '${A}')`);
        const t2 = await say(`remind me about intro ${n} in 5 days`);
        assert(/I'll text you a reminder then/.test(t2.reply), t2.reply);
        await pg.sql(`delete from public.channel_contacts where user_id = '${A}'; update public.career_intro_requests set follow_up_at = null, follow_up_days = null where user_id = '${A}' and n = ${n}`);
      } finally { Deno.env.delete("CAREER_INTRO_REMINDERS"); }
    });

    await t.step("forget: LinkedIn contacts (every copy, in every chat of theirs), job emails, intro requests; Gmail disconnect; forget everything", async () => {
      // A second chat of the same person (a new thread), where they send the export again: both chats now hold a copy.
      const second: Chat = handler!.chat("tok-a");
      const s1 = await second.say("here's my linkedin export again", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: FIXTURE }] });
      eq(s1.resultStatus, "imported", s1.reply);
      const threadA = web.thread()!, threadB = second.thread()!;
      assert(threadA && threadB && threadA !== threadB, "two chats");
      const copies = async (tid: string) => (await q(`select coalesce(state->'career'->'stores'->'contacts', '[]') from public.agent_flow_state where thread_id = '${tid}'`)).filter((r: any) => /Connections/.test(r.file)).length;
      // R1 (#225): no chat holds a copy; the account holds the export's 8 people once each (by person).
      eq([await copies(threadA), await copies(threadB), await accountContacts()], [0, 0, 8]);
      // forgotten from the second chat: every copy goes, and the reply counts all of them
      const f = await second.say("forget my LinkedIn contacts");
      eq([f.intent, f.resultStatus], ["career_people_forget", "forgotten"], f.reply);
      assert(/Deleted your LinkedIn contacts: 8 people from your export/.test(f.reply) && /intro requests are kept/.test(f.reply), f.reply);
      eq([await count("career_people", A, "and source = 'linkedin_export'"), await count("career_people_imports", A, "and source = 'linkedin_export'")], [0, 0]);
      eq([await copies(threadA), await copies(threadB), await accountContacts()], [0, 0, 0], "no copy left in either chat or on the account");
      // back in the first chat, nobody from the export is listed
      const who = await say("who do I know at Ramp?");
      assert(!/Lee Park|Alex O'Brien|Priya Shah/.test(who.reply), who.reply);
      eq(await count("career_people", B), 6, "another person's people stay");
      eq((await say("forget my job emails")).resultStatus, "forgotten");
      eq(await count("career_job_emails", A), 0);
      eq((await say("forget my intro requests")).resultStatus, "forgotten");
      eq(await count("career_intro_requests", A), 0);
      eq(await count("career_people", A, "and source = 'gmail'"), 1);
      await pg.sql(`delete from public.user_oauth_connections where user_id = '${A}'`);
      eq(await count("career_people", A, "and source = 'gmail'"), 0, "disconnecting Gmail deletes what was read from it");
      // "forget everything" (the account epoch moves): seed a row in EACH of the five tables right before it, so the
      // erase trigger is what empties every one of them (the asks above already emptied some).
      await pg.sql(`insert into public.career_people (user_id, source, name, company, company_key, source_ref, dedupe_key) values ('${A}', 'linkedin_export', 'Seed Person', 'Ramp', 'ramp', 'seed, row 1', 'n:seed');
        insert into public.career_people_imports (user_id, source, file_name, rows_read, imported) values ('${A}', 'linkedin_export', 'seed.csv', 1, 1);
        insert into public.career_people_prefs (user_id, export_asked_at) values ('${A}', now()) on conflict (user_id) do update set export_asked_at = now();
        insert into public.career_job_emails (user_id, source, title, url, message_hash, received_at) values ('${A}', 'indeed', 'Seed Job', 'https://www.indeed.com/viewjob?jk=5eed5eed5eed5eed', '${"b".repeat(64)}', now());
        insert into public.career_intro_requests (user_id, n, route, target_name, target_ref, to_name, delivery, subject, body, payload_hash) values ('${A}', 77, 'direct', 'Seed', 'seed', 'Seed', 'copy', 's', 'b', '${"c".repeat(64)}');`);
      const tables = ["career_people", "career_people_imports", "career_people_prefs", "career_job_emails", "career_intro_requests"];
      for (const tbl of tables) assert(await count(tbl, A) >= 1, `${tbl} seeded`);
      await pg.sql(`update public.career_watch_kv set value = jsonb_set(value, '{epoch}', '1') where user_id = '${A}' and key = 'career:account'`);
      for (const tbl of tables) eq(await count(tbl, A), 0, tbl);
      eq(await count("career_people", B), 6);
    });

    await t.step("the network: only the fakes; never LinkedIn, Indeed or Handshake; never a send", () => {
      const hosts = [...new Set(outside.filter((c) => !c.startsWith("DNS ")).map((c) => c.split(" ")[1].split("/")[0]))].sort();
      eq([...new Set(outside.filter((c) => c.startsWith("DNS ")).map((c) => c.split(" ")[1].split("/")[0]))], ["rampfixture.com"], "only the page's own name was resolved");
      eq([...new Set(site.log.connect)], ["93.184.215.14"], "the page reader connected only to the address it checked (pinned)");
      eq([...new Set(site.log.sni)], ["rampfixture.com"], "and did TLS for the page's own name");
      eq(hosts, ["api.openai.com", "gmail.googleapis.com", "rampfixture.com"], outside.join("\n"));
      assert(!outside.some((c) => /\/send|messages\/send/.test(c)), "nothing sent");
    });
    eq(await q(`select count(*) from public.career_outreach_drafts`), 0, "no outreach drafts: intros never ride the sender");
  } finally {
    handler?.restore();
    restoreDns();
    await pg.stop();
  }
} });
