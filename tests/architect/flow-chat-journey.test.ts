// THE CHAT JOURNEY (architect, 2026-10-28): one person, one thread, top to bottom, through the REAL production handler
// (supabase/functions/agent-chat/handler-career.ts handleChat; harness tests/flow/handler.ts: real supabase-js over
// tests/flow/postgrest.ts, real Postgres 16 with every migration). After each turn the reply is checked for facts
// (numbers, names, a question asked) and the database for what changed. No real model and no network: the only model
// call (the networking drafter, CAREER_NETWORKING_DRAFT=on) is a scripted stand-in at the OpenAI URL, as in
// flow-networking.test.ts and flow-send-rail.test.ts, with a dummy key; every other host than the Supabase double is
// refused here and the attempt recorded (asserted empty at the end).
//
//   1  no resume       a first message claims nothing about them; asking to apply queues nothing
//   2  resume          pasted and confirmed in chat (the evidenced confirm); the confirmed upload seeded as
//                      tests/flow/resume-seed.ts does (the file the person's computer prepares with); facts asked back
//                      come only from the confirmed facts
//   3  apply           seeded postings listed; "apply to these" queues the list (an exact duplicate posting once); their
//                      computer prepares (career_apply_prepare_own, as mass-submit-handler-pg.test.ts); the card shows the
//                      batch; "maybe" / "later" / "wait" / a question approve nothing; "yes" approves exactly the card,
//                      each by the hash it showed; "1 and 3" only those; "none" nothing; a repeat ask is blocked
//   4  cancel          "cancel my application to <company>" stops an approved one before it is sent
//   5  networking      contacts imported; "reach people at <company>"; drafts shown; ambiguous replies approve nothing;
//                      "yes" approves exactly the shown drafts; without a Gmail grant the send rail refuses them
//                      (not_connected, nothing queued); with one (send-rail-fixture person()'s grant row) they are queued
//                      on career_send_queue, each bound to its approval hash
//   6  status          "where are my applications" / "where are my emails" with the real counts
//   7  never           LinkedIn, Indeed, Handshake: declined plainly, nothing queued
//   8  secrets         a password and a card number pasted in chat are removed before storage and never echoed
//
// Steps marked PRODUCT GAP assert what the product should do and fail on trunk today; the assertion is kept as written
// (never weakened) so the gap stays visible until the product closes it. Skipped steps: none (trunk has every feature;
// where a phrasing has no handler the step asserts it and is marked PRODUCT GAP).
import { personalOpenAI, seedFactsSql } from "./personal-fixture.ts";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
// The resume file the person's computer sends with every application (synthetic); its sha256 binds into each payload.
const RESUME_FILE = "%PDF-1.4\n% TEST chat-journey resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000c4a01";
const CATCHALL = /I did not catch what to do with that one/;

// Seven open Data Analyst postings in Chicago, on file (career_postings) and in the knowledge base the search reads
// (career_kb_postings); the eighth knowledge-base row is an exact duplicate of Alpha's posting (same link) under another key.
const POSTINGS = [["alpha", "Alpha Works"], ["bravo", "Bravo Labs"], ["charlie", "Charlie Freight"], ["delta", "Delta Metrics"], ["echo", "Echo Systems"], ["foxtrot", "Foxtrot Data"], ["golf", "Golf Analytics"]]
  .map(([board, company], i) => ({ key: `greenhouse:${board}:${i + 1}`, board, company, url: `https://boards.greenhouse.io/${board}/jobs/${i + 1}` }));
const DUP_KEY = "kb-duplicate:alpha:1";
const byCompany = (c: string) => POSTINGS.find((p) => p.company === c)!;

// The scripted writer at the OpenAI URL (flow-send-rail.test.ts's): one short email from the recipient row.
let modelCalls = 0;
function fakeOpenAI(body: any): Response {
  modelCalls++;
  // PERSONALIZED OUTREACH (2026-10-31): a first email's payload is the engine's, answered from it (personal-fixture.ts).
  const personal = personalOpenAI(body);
  if (personal) return personal as any;
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
  const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to hear how you got started. Would you be open to a short call?`;
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json" } });
}

Deno.test({
  name: "The chat journey: one person, one thread, from no resume to applications, outreach, status, refusals and secrets, through the real handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("the chat journey needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const env: Record<string, string> = { CAREER_NETWORKING_DRAFT: "on", OPENAI_API_KEY: "sk-test-not-real", CAREER_MODEL: "gpt-5-mini", CAREER_SEND_RAIL: "on" };
    // The router path (no brain): every turn is the product's code; the only model call is the drafter's, scripted above.
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY"];
    const saved = Object.fromEntries([...Object.keys(env), ...unset].map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realError = console.error;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'journey@example.test'); insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      const desc = "TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${POSTINGS.map((p) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', 'Data Analyst', 'Chicago, IL', '${p.url}', '${desc}', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${POSTINGS.map((p, i) => `('${p.key}', 'greenhouse', '${p.board}', '${p.company}', 'Data Analyst', 'Chicago, IL', '${p.url}', now() - interval '${i} hours', '${desc}', 'cj${i}')`).join(",")},
        ('${DUP_KEY}', 'greenhouse', 'alpha', 'Alpha Works', 'Data Analyst', 'Chicago, IL', '${POSTINGS[0].url}', now() - interval '30 minutes', '${desc}', 'cj-dup');`);
      h = await careerHandler(pg, { "tok-journey": PERSON });
      // No network: the Supabase double answers its own origin, the scripted model the OpenAI URL; anything else is refused.
      const viaDouble = globalThis.fetch;
      const outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.origin}${u.pathname}`); throw new TypeError(`network refused in the journey test: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      // What the handler logs: the send rail's refusals are only logged (handler-career.ts onApproved).
      const logged: string[] = [];
      console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); realError(...a); };

      const chat: Chat = h.chat("tok-journey");
      const say = async (message: string, extra: Record<string, unknown> = {}): Promise<Turn> => {
        // One person's whole journey runs well past the chat's 60-per-hour abuse guard in seconds; that guard is not what
        // this test measures, so the person's window starts fresh each turn.
        await pg.sql(`delete from public.agent_rate_limits where user_id = '${PERSON}'`);
        const r = await chat.say(message, extra);
        eq(r.status, 200, `${message}: ${r.reply}`);
        return r;
      };
      const n = async (sql: string) => Number(await pg.sql(sql));
      const wanted = async () => (await pg.sql(`select coalesce(string_agg(posting_key, ',' order by posting_key), '') from public.career_apply_wanted where user_id = '${PERSON}'`)).split(",").filter(Boolean);
      const jobs = async () => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('company', company, 'state', state) order by company), '[]') from public.career_apply_jobs where user_id = '${PERSON}'`)) as { company: string; state: string }[];
      const approvedCount = async () => (await jobs()).filter((j) => j.state === "queued").length;
      const sendQueue = async () => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('to', recipient_email, 'state', state, 'hash', approval_hash, 'source', source_id) order by created_at), '[]') from public.career_send_queue where user_id = '${PERSON}'`)) as { to: string; state: string; hash: string; source: string }[];
      const drafts = async () => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('id', id, 'n', n, 'to', recipient_email, 'status', status, 'hash', hash, 'approved_hash', approved_hash) order by created_at, n), '[]') from public.career_outreach_drafts where user_id = '${PERSON}'`)) as { id: string; n: number; to: string; status: string; hash: string; approved_hash: string | null }[];
      // Their computer prepares a posting from the queue (the extension's career_apply_prepare_own; the database hashes it).
      const prepare = async (companies: string[]) => {
        for (const c of companies) {
          const p = byCompany(c);
          const payload = { version: 1, user_id: PERSON, job_id: p.key, company: p.company, url: p.url,
            fields: [{ name: "email", label: "Email", value: "alex.testcase@example.test", factId: "TEST-JOURNEY-1" }], privacy_epoch: 0, account_version: 0,
            expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
          const r = await pg.asPerson(PERSON).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`${p.company}: Data Analyst`, "Email: alex.testcase@example.test"] });
          eq(r.error, null, `setup: their computer prepares ${c}: ${JSON.stringify(r.error)}`);
        }
      };
      // Each approved application is queued under exactly the hash its prepared payload had when the card showed it.
      const hashBound = async () => await pg.sql(`select coalesce(bool_and(j.approval_hash = j.payload_hash and j.payload_hash = p.payload_hash), true) from public.career_apply_jobs j
        join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id where j.user_id = '${PERSON}'`);

      // ------------------------------------------------------------------------------------------------ 1. no resume
      await t.step("1. no resume: the first message claims no fact about them; asking to apply is refused and queues nothing", async () => {
        const hi = await say("hi, I'm looking for a data analyst job in Chicago");
        for (const fact of ["Alex", "TEST University", "alex.testcase@example.test", "555-0100", "GPA"]) {
          assert(!hi.reply.includes(fact), `no invented fact (${fact}) before anything is on record: ${hi.reply}`);
        }
        const who = await say("what do you know about me?");
        assert(/nothing is on your record/i.test(who.reply), `recall with nothing on record says so: ${who.reply}`);
        assert(!/TEST University|Alex/.test(who.reply), `recall invents nothing: ${who.reply}`);
        const one = await say("apply to the Data Analyst role at Alpha Works");
        eq([one.intent, one.resultStatus], ["career_apply_queue", "no_resume"], `apply without a confirmed resume is refused: ${one.reply}`);
        assert(/^0\/1 queued/.test(one.reply) && /no resume on file/.test(one.reply), `the refusal names the count and the reason: ${one.reply}`);
        const list = await say("find data analyst jobs in Chicago");
        eq(list.intent, "career_discovery", list.reply);
        const all = await say("apply to these");
        eq([all.intent, all.resultStatus], ["career_apply_queue", "no_resume"], `a batch ask without a resume is refused: ${all.reply}`);
        assert(/^0\/\d+ queued/.test(all.reply), `nothing queued, said as a count: ${all.reply}`);
        eq(await wanted(), [], "no posting queued without a confirmed resume");
        eq(await jobs(), [], "no application row without a confirmed resume");
        eq(await n(`select count(*) from public.career_apply_cards where user_id = '${PERSON}'`), 0, "no card without a confirmed resume");
      });

      // ------------------------------------------------------------------------------------------------ 2. resume
      await t.step("2. resume: pasted, shown as drafts, confirmed by their yes; the confirmed upload on file", async () => {
        const pasted = await say(`here is my resume:\n${RESUME}`);
        eq(pasted.intent, "career_resume_ingest", pasted.reply);
        assert(/15 facts/.test(pasted.reply) && /DRAFT/.test(pasted.reply), `a pasted resume is held as drafts, with the count: ${pasted.reply}`);
        const yes = await say("yes, that's my resume");
        eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], `their yes confirms the shown facts: ${yes.reply}`);
        assert(/15 facts/.test(yes.reply), `the confirmed count is said: ${yes.reply}`);
        // The confirmed upload (the file their computer prepares with), as tests/flow/resume-seed.ts seeds it.
        await pg.sql(confirmedResumeSql(PERSON, RESUME_FILE));
        eq(await n(`select count(*) from public.career_events where user_id = '${PERSON}' and kind = 'fact_confirmed'`) >= 1, true, "a fact_confirmed event is on record");
      });

      await t.step("2. recall: what they know is the confirmed resume; what was never said is not on record", async () => {
        const all = await say("what do you know about me?");
        assert(/15 confirmed/.test(all.reply) && all.reply.includes("TEST University"), `recall reads the confirmed facts: ${all.reply}`);
        const auth = await say("am I authorized to work in the US?");
        assert(/not on your record/i.test(auth.reply), `work authorization was never said: not on record, never guessed: ${auth.reply}`);
        assert(!/\b(yes|you are authorized|you're authorized)\b/i.test(auth.reply.split("\n")[0]), `no invented yes: ${auth.reply}`);
        const email = await say("what's my email address?");
        const addresses = email.reply.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
        assert(addresses.every((a) => a === "alex.testcase@example.test"), `no invented address: ${email.reply}`);
      });

      // PRODUCT GAP: a confirmed fact asked back is not answered. Input "where did I go to school?" and "what is my GPA?"
      // after the resume (education: "TEST University - B.S. Computer Science, GPA 3.7") was confirmed. Expected: TEST
      // University; 3.7. Actual (trunk 2026-10-28): the router's catch-all ("I did not catch what to do with that one"), and
      // "I do not have your GPA stored yet — what is it?" (profile_recall reads a GPA fact the resume ingest never writes).
      await t.step("2. PRODUCT GAP: confirmed facts asked back are answered from the record (school, GPA)", async () => {
        const school = await say("where did I go to school?");
        assert(school.reply.includes("TEST University"), `PRODUCT GAP: the confirmed school is answered: ${school.reply}`);
        const gpa = await say("what is my GPA?");
        const said = gpa.reply.match(/\b\d\.\d{1,2}\b/g) ?? [];
        assert(said.every((g) => g === "3.7"), `never an invented GPA: ${gpa.reply}`);
        assert(said.includes("3.7"), `PRODUCT GAP: the confirmed GPA (3.7) is answered: ${gpa.reply}`);
      });

      // PRODUCT GAP: an invented verdict. Input "do I need visa sponsorship?" (sponsorship never stated; no posting named).
      // Expected: not on record, asked of them (as "am I authorized to work in the US?" is answered). Actual (trunk
      // 2026-10-28): intent eligibility_check, "Graded against the posting's own text. Verdict: this record evidences every
      // hard requirement and every required skill stated in the posting." — a verdict on a posting nobody named (D-007).
      await t.step("2. PRODUCT GAP: a question about a fact never stated (sponsorship) gets no invented verdict", async () => {
        const r = await say("do I need visa sponsorship?");
        assert(!/Verdict/i.test(r.reply), `PRODUCT GAP: no verdict on a posting nobody named: ${r.reply}`);
        assert(/not on your record|haven't told me|have not told me/i.test(r.reply), `PRODUCT GAP: sponsorship is said to be not on record: ${r.reply}`);
      });

      // ------------------------------------------------------------------------------------------------ 3. apply
      await t.step("3. find: the seeded postings are listed; listing queues nothing", async () => {
        const r = await say("find data analyst jobs in Chicago");
        eq(r.intent, "career_discovery", r.reply);
        for (const p of POSTINGS) assert(r.reply.includes(p.company), `${p.company} is listed: ${r.reply}`);
        const shortlist = JSON.parse(await pg.sql(`select coalesce((select state->'career'->'stores'->'discovery'->'lastShortlist' from public.agent_flow_state where user_id = '${PERSON}' and thread_id = '${chat.thread()}')::text, '[]')`)) as any[];
        assert(shortlist.length >= POSTINGS.length, `the served list is kept on the thread: ${JSON.stringify(shortlist.map((e) => e.id))}`);
        eq(await wanted(), [], "listing queues nothing");
      });

      await t.step("3. 'apply to these': every listed posting queued once (the duplicate link once), the count said; nothing approved", async () => {
        const r = await say("apply to these");
        eq([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        const keys = await wanted();
        eq(keys.length, POSTINGS.length, `seven postings, one queue row each; the duplicate link is not a second row: ${keys.join(",")}`);
        assert(new RegExp(`^${POSTINGS.length}/\\d+ queued`).test(r.reply), `the reply leads with the number queued: ${r.reply}`);
        for (const p of POSTINGS) assert(r.reply.includes(p.company), `${p.company} is named: ${r.reply}`);
        eq(await jobs(), [], "queued is not approved: no application row");
        eq(await n(`select count(*) from public.career_apply_cards where user_id = '${PERSON}'`), 0, "no card yet");
      });

      let cardId = "";
      await t.step("3. the card shows the batch their computer prepared; 'maybe', 'later', 'wait', a question approve nothing", async () => {
        await prepare(["Alpha Works", "Bravo Labs", "Charlie Freight"]);
        const card = await say("show my applications");
        eq([card.intent, card.resultStatus], ["career_apply_card", "shown"], card.reply);
        assert(/^3 applications are ready/.test(card.reply), `the card counts what it shows: ${card.reply}`);
        for (const c of ["Alpha Works", "Bravo Labs", "Charlie Freight"]) assert(card.reply.includes(c), `${c} on the card: ${card.reply}`);
        cardId = String(card.body?.meta?.card_id ?? "");
        assert(cardId, "the card's id rides the reply");
        for (const m of ["maybe", "later", "wait"]) {
          const r = await say(m);
          eq(r.intent, "career_apply_card", `${m}: the card stays this thread's last word`);
          assert(/nothing was approved/i.test(r.reply), `${m}: says nothing was approved: ${r.reply}`);
          eq(await approvedCount(), 0, `${m}: approves nothing`);
        }
        const q = await say("which one pays the most?");
        eq(await approvedCount(), 0, `a question approves nothing: ${q.reply}`);
        eq(await pg.sql(`select state from public.career_apply_cards where id = '${cardId}'`), "open", "the card is still open, unanswered");
      });

      await t.step("3. after another reply the card is shown again; 'yes' approves exactly its 3, each by the hash it showed", async () => {
        // SERIAL-1460 (2): after another reply a bare yes is not the card's; the person sees the card again and answers it.
        const again = await say("show my applications");
        eq([again.intent, again.resultStatus], ["career_apply_card", "shown"], again.reply);
        assert(/^3 applications are ready/.test(again.reply), again.reply);
        const yes = await say("yes");
        eq([yes.intent, yes.resultStatus], ["career_apply_card_answer", "answered"], yes.reply);
        assert(/^3 approved exactly as shown/.test(yes.reply) && /Nothing has gone to an employer yet/.test(yes.reply), `the count approved, nothing sent yet: ${yes.reply}`);
        eq(await jobs(), ["Alpha Works", "Bravo Labs", "Charlie Freight"].map((company) => ({ company, state: "queued" })), "exactly the card's three");
        eq(await hashBound(), "t", "each approved under the hash the card carried");
        const twice = await say("yes");
        eq(await approvedCount(), 3, `a second yes approves nothing more: ${twice.reply}`);
      });

      await t.step("3. a subset: '1 and 3' approves only those two; 'none' approves nothing", async () => {
        await prepare(["Delta Metrics", "Echo Systems", "Foxtrot Data"]);
        const card = await say("show my applications");
        assert(/^3 applications are ready/.test(card.reply), card.reply);
        const lines = card.reply.split("\n");
        const at = (c: string) => Number(/^(\d+)\./.exec(lines.find((l) => /^\d+\./.test(l) && l.includes(c)) ?? "")?.[1]);
        eq([at("Delta Metrics"), at("Echo Systems"), at("Foxtrot Data")], [1, 2, 3], card.reply);
        const some = await say("1 and 3");
        eq(some.resultStatus, "answered", some.reply);
        assert(/^2 approved exactly as shown/.test(some.reply) && /Echo Systems: not sent: you left it out/.test(some.reply), `the subset and the one left out, by name: ${some.reply}`);
        const now = await jobs();
        eq(now.filter((j) => j.state === "queued").map((j) => j.company), ["Alpha Works", "Bravo Labs", "Charlie Freight", "Delta Metrics", "Foxtrot Data"], "only 1 and 3 were added");
        eq(await hashBound(), "t");
        await prepare(["Golf Analytics"]);
        const last = await say("show my applications");
        assert(/^1 application/.test(last.reply) && last.reply.includes("Golf Analytics"), last.reply);
        const none = await say("none");
        assert(/Nothing was approved/.test(none.reply), `'none' approves nothing: ${none.reply}`);
        eq(await approvedCount(), 5, "'none' added nothing");
      });

      await t.step("3. a repeat ask is blocked: an employer already approved, a posting already queued, the list again", async () => {
        const w = (await wanted()).length, a = await approvedCount();
        const alpha = await say("apply to the Data Analyst role at Alpha Works");
        eq([alpha.intent, alpha.resultStatus], ["career_apply_queue", "refused"], alpha.reply);
        // Blocked with its reason named: this exact posting is already in the applications (the more specific reason, which wins
        // once the application is on record) or the once-per-employer rule (30 days). Either is honest; nothing is queued.
        assert(/^0\/1 queued/.test(alpha.reply) && (/Alpha Works[^\n]*already in (?:their|your) applications as the same posting/.test(alpha.reply) || (/already applied to Alpha Works/.test(alpha.reply) && /30 days/.test(alpha.reply))), `blocked, the reason named: ${alpha.reply}`);
        const echo = await say("apply to the Data Analyst role at Echo Systems");
        assert(/^0\/1 queued/.test(echo.reply), `Echo is already in the queue: ${echo.reply}`);
        eq(echo.resultStatus === "queued", false, echo.reply);
        const list = await say("find data analyst jobs in Chicago");
        eq(list.intent, "career_discovery", list.reply);
        const all = await say("apply to these");
        assert(/^0\/\d+ queued/.test(all.reply), `the whole list again queues nothing new: ${all.reply}`);
        eq([(await wanted()).length, await approvedCount()], [w, a], "no new queue row, no new approval");
      });

      // ------------------------------------------------------------------------------------------------ 4. cancel
      await t.step("4. 'cancel my application to Bravo Labs' stops the approved one before it is sent; the others stand", async () => {
        const r = await say("cancel my application to Bravo Labs");
        eq([r.intent, r.resultStatus], ["career_apply_cancel", "cancelled"], r.reply);
        assert(/Nothing was sent to Bravo Labs/.test(r.reply), `says nothing went to Bravo Labs: ${r.reply}`);
        const bravo = (await jobs()).find((j) => j.company === "Bravo Labs")!;
        eq(bravo.state, "not_submitted", "Bravo's approved application is withdrawn, never sent");
        eq(await approvedCount(), 4, "the other four approvals stand");
        const nothing = await say("cancel my application to Stripe");
        assert(/nothing to cancel/i.test(nothing.reply), `nothing on file for Stripe is said: ${nothing.reply}`);
      });

      // ------------------------------------------------------------------------------------------------ 5. networking
      await t.step("5. contacts imported from their LinkedIn export, with the coverage said", async () => {
        const up = await say("here are my LinkedIn connections", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] });
        eq([up.intent, up.resultStatus], ["career_contacts_import", "imported"], up.reply);
        assert(/imported 6\/8 rows/.test(up.reply) && /4\/6 have an email address/.test(up.reply), up.reply);
        const who = await say("who do I know at Stripe?");
        assert(/You have 4 contacts at Stripe, 3 with an email address/.test(who.reply), `the real count at the firm: ${who.reply}`);
        // PERSONALIZED OUTREACH (2026-10-31): the people they will write to carry one sourced fact (what they told Trainee).
        await pg.sql(seedFactsSql(PERSON, ["maya.chen@stripe.example", "sam.rivera@stripe.example", "priya.shah@ramp.example"]));
      });

      // PRODUCT GAP: "I want to reach people at Stripe" (4 Stripe contacts on file, 3 with an address). Expected: the people on
      // file named (or drafts shown), and no pacing the product does not have. Actual (trunk 2026-10-28): intent
      // outreach_clarification, "Building the list now: people at Stripe ..." naming nobody, and "what paces this is your
      // daily number (10 a day in your first week, then 20 unless you set up to 30)" — a daily limit the send rail does not
      // have (career_send_rail.ts: "No volume limit of Trainee's own", owner 2026-10-27).
      await t.step("5. PRODUCT GAP: 'reach people at Stripe' names the people on file and invents no daily limit", async () => {
        const r = await say("I want to reach people at Stripe");
        eq((await drafts()).filter((d) => d.status === "approved").length, 0, "nothing approved by asking");
        assert(/Maya Chen/.test(r.reply) && /Sam Rivera/.test(r.reply), `PRODUCT GAP: the Stripe contacts with an address are named: ${r.reply}`);
        assert(!/\d+ a day/.test(r.reply), `PRODUCT GAP: no daily number the product does not enforce: ${r.reply}`);
      });

      await t.step("5. drafts shown: how they sign asked, then one draft per contact with an address; nothing approved", async () => {
        const ask = await say("draft intros to my contacts at Stripe");
        eq([ask.intent, ask.resultStatus], ["career_outreach_signature", "needs_signature"], `a question is asked before drafting: ${ask.reply}`);
        assert(/\?/.test(ask.reply), ask.reply);
        const sig = await say("Alex Testcase\nTEST University");
        eq([sig.intent, sig.resultStatus], ["career_outreach_batch", "drafted"], sig.reply);
        assert(/Drafted 2\/4/.test(sig.reply) && /Lee Park \(no email address/.test(sig.reply) && /careers@stripe\.example is a shared inbox/.test(sig.reply), `the count and each one not drafted, with why: ${sig.reply}`);
        eq((await drafts()).map((d) => [d.n, d.to, d.status]), [[1, "maya.chen@stripe.example", "shown"], [2, "sam.rivera@stripe.example", "shown"]], "two drafts shown, none approved");
        assert(modelCalls >= 2, "the drafts came from the scripted writer, not a real model");
      });

      await t.step("5. ambiguous replies to the drafts approve nothing and queue nothing", async () => {
        for (const m of ["maybe", "later", "wait", "none of these?", "send them?"]) {
          const r = await say(m);
          eq((await drafts()).map((d) => d.status), ["shown", "shown"], `${m}: approves nothing (${r.intent}: ${r.reply.slice(0, 160)})`);
          eq(await sendQueue(), [], `${m}: queues nothing`);
        }
      });

      await t.step("5. no Gmail connected: 'yes' approves exactly the 2 shown, the send rail refuses them (not_connected), nothing queued", async () => {
        // The batch answers only while it is the thread's last word: after the ambiguous replies it is shown again.
        const shown = await say("show my drafts");
        eq([shown.intent, shown.resultStatus], ["career_outreach_batch", "shown"], shown.reply);
        logged.length = 0;
        const yes = await say("yes");
        eq(yes.resultStatus, "approved", yes.reply);
        assert(/Approved 2, exactly as shown/.test(yes.reply), `the count approved: ${yes.reply}`);
        assert(/Nothing has gone out/.test(yes.reply) && /Gmail is connected/.test(yes.reply), `says nothing went and why: ${yes.reply}`);
        eq((await drafts()).map((x) => [x.status, x.approved_hash === x.hash]), [["approved", true], ["approved", true]], "each approved under its own hash");
        assert(logged.some((l) => /send rail: approved drafts not queued: not_connected, not_connected/.test(l)), `the rail refused both as not_connected: ${logged.join(" | ")}`);
        eq(await sendQueue(), [], "nothing on the send rail without a connected Gmail");
      });

      await t.step("5. Gmail connected (send-rail-fixture person()'s grant): a new draft, 'yes' queues exactly it on the send rail, bound to its hash", async () => {
        await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${PERSON}', 'google_career', 'oauth_google_career_${PERSON}', 'me@example.test',
          'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send')`);
        const draft = await say("email Priya at Ramp about the product role");
        eq([draft.intent, draft.resultStatus], ["career_outreach_batch", "drafted"], draft.reply);
        assert(/Drafted 1\/1/.test(draft.reply) && /priya\.shah@ramp\.example/.test(draft.reply), draft.reply);
        const maybe = await say("maybe");
        eq(await sendQueue(), [], `'maybe' queues nothing: ${maybe.reply.slice(0, 120)}`);
        await say("show my drafts");
        const yes = await say("yes");
        eq(yes.resultStatus, "approved", yes.reply);
        assert(/Approved 1, exactly as shown/.test(yes.reply) && /go from your Gmail/.test(yes.reply), yes.reply);
        const priya = (await drafts()).find((d) => d.to === "priya.shah@ramp.example")!;
        eq(await sendQueue(), [{ to: "priya.shah@ramp.example", state: "queued", hash: priya.hash, source: priya.id }], "exactly the approved draft, under its approval hash");
        eq(priya.approved_hash, priya.hash);
      });

      // ------------------------------------------------------------------------------------------------ 6. status
      await t.step("6. 'where are my applications' answers from the record: the four approved and not sent", async () => {
        const r = await say("where are my applications?");
        eq([r.intent, r.resultStatus], ["career_apply_status", "shown"], r.reply);
        for (const c of ["Alpha Works", "Charlie Freight", "Delta Metrics", "Foxtrot Data"]) {
          assert(new RegExp(`${c}: approved, not sent yet`).test(r.reply), `${c} approved, not sent: ${r.reply}`);
        }
        assert(!/Bravo Labs: approved/.test(r.reply), `the cancelled one is not said to be approved: ${r.reply}`);
        assert(!/submitted|confirmed by/i.test(r.reply), `nothing is said to be submitted: ${r.reply}`);
      });

      // PRODUCT GAP: "where are my emails" has no chat answer. Input "where are my emails" with 1 email queued on the send
      // rail and 2 approved but not queued. Expected: the real counts (outreachSendStatus in career_send_rail.ts exists for
      // exactly this ask: "0 emails sent from your Gmail, 1 waiting to go."). Actual (trunk 2026-10-28): the router's
      // catch-all ("I did not catch what to do with that one"); outreachSendStatus is not wired into handler-career.ts.
      // "what's the status of my emails?" answers "Your tracker holds no applications on record in this session".
      await t.step("6. PRODUCT GAP: 'where are my emails' answers with the real counts", async () => {
        const r = await say("where are my emails");
        assert(!CATCHALL.test(r.reply), `PRODUCT GAP: the ask is understood: ${r.reply}`);
        assert(/\b1\b[^.]*waiting|\b1 email/i.test(r.reply), `PRODUCT GAP: the one email waiting on the rail is counted: ${r.reply}`);
        const status = await say("what's the status of my emails?");
        assert(!/no applications on record/i.test(status.reply), `PRODUCT GAP: no false 'nothing on record' with 4 approved applications and 3 approved emails: ${status.reply}`);
      });

      // ------------------------------------------------------------------------------------------------ 7. never
      const snapshot = async () => [(await wanted()).length, (await jobs()).length, (await sendQueue()).length, (await drafts()).length,
        await n(`select count(*) from public.career_apply_cards where user_id = '${PERSON}'`)];
      await t.step("7. LinkedIn: applying and messaging there are declined plainly; nothing queued", async () => {
        const before = await snapshot();
        for (const m of ["apply to the Data Analyst job at Contoso on LinkedIn", "apply to this one https://www.linkedin.com/jobs/view/123456", "send a message to Maya on LinkedIn"]) {
          const r = await say(m);
          eq([r.intent, r.resultStatus], ["career_linkedin_refused", "refused"], `${m}: ${r.reply}`);
          assert(/I don't (apply|message)[^.]*LinkedIn/.test(r.reply) && /Nothing was sent or done on LinkedIn/.test(r.reply), `${m}: declined plainly: ${r.reply}`);
        }
        eq(await snapshot(), before, "nothing queued, drafted or carded");
      });

      // PRODUCT GAP: Indeed and Handshake are not declined plainly. Inputs and actual replies (trunk 2026-10-28):
      //   "apply to the Data Analyst job at Contoso on Indeed" -> named_role_apply/blocked: "I can't apply to the Data Analyst
      //     at Contoso on Indeed yet — that posting is not in the list I can work from." (implies it would, once on file)
      //   "apply to this job for me https://www.indeed.com/viewjob?jk=abc" -> career_batch_apply/completed: "0/1 applications
      //     ready for your yes. - a company — a role: Trainee can't reach this employer's application site from here"; and the
      //     batch it opens then answers every later bare "yes" ("Nothing was submitted — this batch is not ready").
      //   "apply to jobs on Handshake for me" / "message recruiters on Handshake for me" -> the catch-all.
      //   "apply me on handshake https://app.joinhandshake.com/jobs/12345" -> career_batch_apply, as the Indeed link.
      // Expected: each declined plainly, naming the site, as LinkedIn is (career_linkedin_refused); nothing queued (true today).
      await t.step("7. PRODUCT GAP: Indeed and Handshake are declined plainly, naming the site; nothing queued", async () => {
        const before = await snapshot();
        const gaps: string[] = [];
        for (const m of ["apply to the Data Analyst job at Contoso on Indeed", "apply to this job for me https://www.indeed.com/viewjob?jk=abc",
          "apply to jobs on Handshake for me", "message recruiters on Handshake for me", "apply me on handshake https://app.joinhandshake.com/jobs/12345"]) {
          const r = await say(m);
          eq(await snapshot(), before, `${m}: nothing queued, drafted or carded`);
          const words = r.reply.replace(/https?:\/\/\S+/g, "");
          const site = /indeed/i.test(m) ? /indeed/i : /handshake/i;
          if (!(site.test(words) && /\b(don't|do not|never|won't)\b/i.test(words) && !/\byet\b/i.test(words) && !CATCHALL.test(r.reply))) gaps.push(`"${m}" -> ${r.intent}/${r.resultStatus}: ${r.reply.slice(0, 200)}`);
        }
        eq(gaps, [], `PRODUCT GAP: each is declined plainly, naming the site`);
      });

      // ------------------------------------------------------------------------------------------------ 8. secrets
      await t.step("8. a password and a card number pasted in chat: removed before storage, never echoed, said so", async () => {
        const r = await say("my password is Hunter2!x and my card is 4111 1111 1111 1111");
        assert(!r.reply.includes("Hunter2") && !r.reply.includes("4111"), `never echoed: ${r.reply}`);
        assert(/removed the card number and password/.test(r.reply), `they are told what was removed: ${r.reply}`);
        eq(await pg.sql(`select content from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${PERSON}' and m.role = 'user' order by m.id desc limit 1`),
          "my password is [password removed] and my card is [card number removed]", "the stored message carries neither");
        for (const [table, col] of [["agent_messages", "content"], ["agent_flow_state", "state::text"], ["career_events", "detail::text || coalesce(subject, '')"]]) {
          eq(await n(`select count(*) from public.${table} where ${col} like '%Hunter2%' or ${col} like '%4111 1111%' or ${col} like '%4111111111111111%'`), 0, `nothing in ${table}`);
        }
      });

      await t.step("no network and no real model: every request stayed on the machine", () => {
        eq(outbound, [], "no request left for any host but the Supabase double and the scripted model");
      });
    } finally {
      console.error = realError;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
