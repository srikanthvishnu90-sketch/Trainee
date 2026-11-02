// SERIAL-1410 (1) (2026-10-25): the batch ask in chat, on the queue path, with no test-only seam.
//   chat     "find analyst jobs in Chicago" -> handleChat -> the router's discovery lists four postings from the knowledge
//            base (career_kb_postings) and keeps the served list on the thread (discovery.lastShortlist)
//   chat     "apply to these" -> handleChat (handler-career.ts) -> each listed posting through the same screens as a single
//            ask: their current employer (a confirmed fact) refuses one, the very posting applied to 10 days ago refuses one, the
//            two others go into career_apply_wanted; the reply lists queued and not queued with the reason for each;
//            nothing is approved, filled or sent
//   prepare  prepare-ahead.ts prepareAhead draws both; shared facts asked once; the essay asked once PER posting
//   answers  "what do you need from me" / "use N" / "N <text>" through handleChat
//   card     "show my applications" -> one card with both; their one text "yes" within 10 minutes approves exactly those
//            two payloads (D-031), each by the hash the card carries
//   drive    runApproved -> scripts/apply.ts, once per employer; each receives only its own essay
// Everything but the employer pages (127.0.0.1) and the person's taps is the product's own code.
// Fail-first on b3c23bf5: "apply to these" is the router's catch-all ("I did not catch what to do with that one"),
// nothing is queued.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
const AUTH = "Are you legally authorized to work in the United States?";
const COMPANY = "TEST Chat Employer";
const SIBLING = "TEST Sibling Employer";
const ROLE = "TEST Analyst";
const WHY = "Why do you want to work here?";

// The employers: two postings on 127.0.0.1 with the same form (name, email, phone, a resume, sponsorship, work
// authorization and a required essay), one per route; every POST is kept per route.
function employer() {
  const posts: Record<string, Record<string, string>[]> = { apply: [], sibling: [] };
  const uploads: Record<string, string> = {};
  const select = (name: string, label: string) =>
    `<label for="${name}">${label}</label><select name="${name}" id="${name}" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>`;
  const form = (route: string, company: string) => `<!doctype html><title>TEST role</title><h1>${ROLE}</h1><p>${company}</p><form method="post" action="/${route}/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="phone">Phone</label><input name="phone" id="phone" type="tel" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    select("sponsorship", SPONSOR) + select("work_auth", AUTH) +
    `<label for="why">${WHY}</label><textarea name="why" id="why" required></textarea>` +
    `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") {
      const route = path.split("/")[1];
      const data = await req.formData(), got: Record<string, string> = {};
      for (const [k, v] of data.entries()) {
        if (typeof v === "string") got[k] = v;
        else { got[k] = `file:${v.name}`; uploads[route] = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await v.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
      }
      (posts[route] ??= []).push(got);
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: CHAT-${route.toUpperCase()}-1.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (path === "/apply") return new Response(form("apply", COMPANY), { headers: { "content-type": "text/html" } });
    if (path === "/sibling") return new Response(form("sibling", SIBLING), { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { url: `${base}/apply`, sibling: `${base}/sibling`, posts, upload: (route: string) => uploads[route] ?? "", close: () => server.shutdown() };
}
const day = (d = new Date()) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

Deno.test({
  name: "From a listed shortlist to the queue: 'apply to these' queues each posting that passes its own screens, names what it refused and why; each is prepared, approved and sent on its own",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the batch-ask flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
    const pg = await startPg();
    const site = employer(), site2 = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-chat-many-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      const JOB = "greenhouse:chattest:7", JOB2 = "greenhouse:chatsib:8", JOB3 = "greenhouse:current:9", JOB4 = "greenhouse:prior:10";
      const CURRENT = "Contoso Analytics", PRIOR = "Fabrikam Data";
      const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000e2", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000000e3";
      const rows = [
        [JOB, "greenhouse", "chattest", COMPANY, ROLE, "https://boards.greenhouse.io/chattest/jobs/7"],
        [JOB2, "greenhouse", "chatsib", SIBLING, ROLE, "https://boards.greenhouse.io/chatsib/jobs/8"],
        [JOB3, "greenhouse", "current", CURRENT, "Data Analyst", "https://boards.greenhouse.io/current/jobs/9"],
        [JOB4, "greenhouse", "prior", PRIOR, "Data Analyst", "https://boards.greenhouse.io/prior/jobs/10"],
      ];
      const desc = `${ROLE}. Requirements: SQL, Python, dashboards for internal teams.`;
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${rows.map((r) => `('${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}', '${r[4]}', 'Chicago, IL', '${r[5]}', '${desc}', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${rows.map((r, i) => `('${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}', '${r[4]}', 'Chicago, IL', '${r[5]}', now() - interval '${i} hours', '${desc}', 'h${i}')`).join(",")};
        insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test'), ('${OTHER}', '${OTHER}@example.test');
        insert into public.profiles (id) values ('${PERSON}'), ('${OTHER}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${OTHER}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
        values ('${PERSON}', 'greenhouse:prior:10', '${PRIOR}', 'https://boards.greenhouse.io/prior/jobs/10', '{}', repeat('a', 64), repeat('a', 64), 'submitted_unconfirmed', now() - interval '10 days');`);
      const svc = pg.asService(), person = pg.asPerson(PERSON);
      agentChat = await careerHandler(pg, { "tok-person": PERSON, "tok-other": OTHER });
      const chat: Chat = agentChat.chat("tok-person");
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => { await memory.put(path, pdf); await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`); },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const deps = { db: svc, runEngine, profileFor: storedProfile(svc), urlFor: (c: { job_id: string }) => c.job_id === JOB2 ? site2.sibling : site.url, resumeFor: tailoredResume({ render: edgeRenderer(), resumes }) };
      const say = async (message: string, extra: Record<string, unknown> = {}) => { const r = await chat.say(message, extra); assertEquals(r.status, 200, r.reply); return r; };
      const wanted = async () => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('key', posting_key, 'state', state, 'company', company) order by posting_key), '[]') from public.career_apply_wanted where user_id = '${PERSON}'`));

      await t.step("chat: resume confirmed; name, email, phone, work rights and their current employer said", async () => {
        await say(`here is my resume:\n${RESUME}`);
        const yes = await say("yes, that's my resume");
        assertEquals([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        for (const m of ["my name is Jordan Rivera", "my email is jordan.rivera@example.test", "my phone number is 312-555-0142", "I'm a US citizen and I don't need visa sponsorship", "I'm authorized to work in the US"]) await say(m);
        const job = await say(`I work at ${CURRENT}`);
        assertEquals(job.intent, "profile_correction", job.reply);
        // What they state in chat is kept on the thread's statedFacts store (the resume's facts are the profile's).
        const stated = JSON.parse(await pg.sql(`select coalesce((select state->'career'->'stores'->'statedFacts'->'facts' from public.agent_flow_state where user_id = '${PERSON}' order by updated_at desc limit 1)::text, '[]')`));
        assert((stated as any[]).some((f) => f.kind === "experience" && f.value === CURRENT), `their current employer is on the record: ${JSON.stringify(stated)}`);
      });

      await t.step("chat: 'apply to these' before any list: told what to say, nothing queued, no catch-all", async () => {
        const r = await say("apply to these");
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "no_list"], r.reply);
        assert(/find <role> jobs in <place>/i.test(r.reply) && /apply to the <role> role at <Company>/i.test(r.reply) && /nothing was queued/i.test(r.reply), r.reply);
        assertEquals(await wanted(), []);
      });

      await t.step("chat: 'find analyst jobs in Chicago' lists the four postings; the served list stays on the thread", async () => {
        const r = await say("find analyst jobs in Chicago");
        assertEquals(r.intent, "career_discovery", r.reply);
        for (const c of [COMPANY, SIBLING, CURRENT, PRIOR]) assert(r.reply.includes(c), `${c} is listed: ${r.reply}`);
        const snap = JSON.parse(await pg.sql(`select coalesce((select state->'career'->'stores'->'discovery'->'lastShortlist' from public.agent_flow_state where user_id = '${PERSON}' order by updated_at desc limit 1)::text, 'null')`));
        assertEquals(Array.isArray(snap) ? snap.length : snap, 4, "four entries kept on the thread");
        assertEquals(await wanted(), [], "listing queues nothing");
      });

      await t.step("chat: 'apply to these' queues the two that pass; their current employer and the one applied to 10 days ago are named with the reason; nothing sent", async () => {
        const r = await say("apply to these");
        assertEquals(r.intent, "career_apply_queue", `the chat queues from the list: intent=${r.intent} ${r.reply}`);
        assertEquals(r.resultStatus, "queued", r.reply);
        assertEquals((await wanted()).map((w: any) => w.key), [JOB2, JOB].sort(), "exactly the two that pass their screens");
        assert(/Queued 2/.test(r.reply) && r.reply.includes(`${ROLE} at ${COMPANY}`) && r.reply.includes(`${ROLE} at ${SIBLING}`), r.reply);
        assert(new RegExp(`${CURRENT}[^\\n]*current employer`, "i").test(r.reply), `the current-employer refusal, with its reason: ${r.reply}`);
        assert(new RegExp(`${PRIOR}[^\\n]*already[^\\n]*same posting`, "i").test(r.reply) && !/30 days/.test(r.reply), `the exact-duplicate refusal, with its reason (D-MS-3: no 30-day rule): ${r.reply}`);
        assert(/nothing (is|was) (sent|submitted)/i.test(r.reply) && /the card that shows it exactly/.test(r.reply) && /one yes to that card approves exactly what it shows/.test(r.reply), r.reply);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}' and company in ('${COMPANY}', '${SIBLING}')`), "0", "nothing approved: no queue row until their tap");
        assertEquals(site.posts.apply.length + site2.posts.sibling.length, 0);
        const again = await say("apply to these");
        assertEquals(again.resultStatus, "already", again.reply);
        assertEquals((await wanted()).length, 2);
      });

      await t.step("SERIAL-1441: another person, and the same person in a new thread, have no list to apply from; nothing of the first thread's is seen or queued", async () => {
        const other: Chat = agentChat!.chat("tok-other");
        const o = await other.say("apply to these");
        assertEquals([o.status, o.intent, o.resultStatus], [200, "career_apply_queue", "no_list"], o.reply);
        assert(!o.reply.includes(COMPANY) && !o.reply.includes(SIBLING), `the first person's postings are not named to another person: ${o.reply}`);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_wanted where user_id = '${OTHER}'`), "0", "nothing queued for the other person");
        const fresh: Chat = agentChat!.chat("tok-person");
        const f = await fresh.say("apply to these");
        assertEquals([f.intent, f.resultStatus], ["career_apply_queue", "no_list"], `a new thread has no list of its own: ${f.reply}`);
        assert(fresh.thread() !== chat.thread(), "a different thread");
        assertEquals((await wanted()).length, 2, "the first thread's two stay as they were; the new thread added nothing");
      });

      // One question at a time (review of #360): "what do you need from me" shows the first open question; "skip" moves on
      // to the next; the one shown is answered with the whole message, or "use 1" for its offered draft.
      const untilShown = async (label: string, company?: string) => {
        let s = await say("what do you need from me");
        assertEquals(s.resultStatus, "shown", s.reply);
        for (let i = 0; i < 12 && !(s.reply.includes(label) && (!company || s.reply.includes(company))); i++) {
          s = await say("skip");
          assertEquals(s.resultStatus, "answered_next", s.reply);
        }
        assert(s.reply.includes(label) && (!company || s.reply.includes(company)), `${label}${company ? ` for ${company}` : ""} is asked: ${s.reply}`);
        return s.reply;
      };
      const useAll = async (labels: string[]) => {
        for (const label of labels) {
          await untilShown(label);
          const used = await say("use 1");
          assert(/Saved, as drafted/.test(used.reply), `${label}: ${used.reply}`);
        }
      };
      const outcomes = (done: { user_id: string; job_id: string; outcome: string }[]) =>
        done.filter((d) => d.user_id === PERSON).map((d) => [d.job_id, d.outcome]).sort((a, b) => a[0].localeCompare(b[0]));
      const openKeys = async () => (await pg.sql(`select coalesce(string_agg(key, ',' order by key), '') from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`)).split(",").filter(Boolean);
      await t.step("prepare: the server run draws exactly the two queued postings; shared facts asked once, the essay once per posting", async () => {
        assertEquals(outcomes(await prepareAhead(deps)), [[JOB2, "asked"], [JOB, "asked"]].sort((a, b) => a[0].localeCompare(b[0])));
        assertEquals(await openKeys(), ["fact:email", "fact:first_name", "fact:last_name"]);
        await useAll(["First name", "Last name", "Email"]);
        assertEquals(outcomes(await prepareAhead(deps)), [[JOB2, "asked"], [JOB, "asked"]].sort((a, b) => a[0].localeCompare(b[0])));
        const keys = await openKeys();
        assertEquals(keys.filter((k) => !k.startsWith("job:")), ["fact:phone", "fact:sponsorship", "fact:work_authorization"]);
        assertEquals(keys.filter((k) => k.startsWith("job:")).length, 2, `the essay is one question per posting: ${keys.join(",")}`);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepare_attempts where user_id = '${PERSON}' and posting_job_id in ('${JOB3}', '${JOB4}')`), "0", "the refused postings were never drawn");
      });

      const FIRST_WHY = "I built the TEST Chat analytics pipeline and want to keep building it.";
      const SIBLING_WHY = "TEST Sibling ships weekly and I want to learn that pace.";
      let preparedId = "", preparedId2 = "";
      await t.step("their words (SERIAL-1441: a posting-bound answer never crosses postings in a batch): the first employer's essay readies the first only; the sibling waits for its own, then is ready with that text alone", async () => {
        await useAll(["Phone", SPONSOR, AUTH]);
        await untilShown(WHY, COMPANY);
        await say(FIRST_WHY);
        let done = await prepareAhead(deps);
        assertEquals(outcomes(done), [[JOB, "ready"]], JSON.stringify(done));
        preparedId = done.find((d) => d.job_id === JOB)!.prepared_id!;
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}' and job_id = '${JOB2}'`), "0", "the sibling is not prepared on the first's essay");
        await untilShown(WHY, SIBLING);
        await say(SIBLING_WHY);
        done = await prepareAhead(deps);
        assertEquals(outcomes(done), [[JOB2, "ready"]], JSON.stringify(done));
        preparedId2 = done[0].prepared_id!;
        const why = async (id: string) => JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${id}'`)).payload.fields.find((f: any) => f.name === "why")?.value;
        assertEquals([await why(preparedId), await why(preparedId2)], [FIRST_WHY, SIBLING_WHY]);
      });

      await t.step("their one yes (SERIAL-1451/1461/1462): the card shown in thread A is closed by the card shown in thread B; a bare yes says how; a yes in reply to A's card message approves nothing, a replay nothing; a yes in reply to B's card message approves exactly the two payloads", async () => {
        const cardA = await say("show my applications");
        assertEquals([cardA.intent, cardA.resultStatus], ["career_apply_card", "shown"], cardA.reply);
        assert(/2 applications are ready/.test(cardA.reply) && cardA.reply.includes(FIRST_WHY) && cardA.reply.includes(SIBLING_WHY), `the card shows both essays verbatim: ${cardA.reply}`);
        const metaA = JSON.parse(await pg.sql(`select coalesce((select meta::text from public.agent_messages where thread_id = '${chat.thread()}' and role = 'assistant' order by id desc limit 1), 'null')`));
        assert(typeof metaA?.card_id === "string" && metaA.intent === "career_apply_card", `the shown card's id rides the reply: ${JSON.stringify(metaA)}`);
        // The same person in a second thread shows a card: it closes thread A's card (card_open_for) and is now the newest.
        const threadB: Chat = agentChat!.chat("tok-person");
        const cardB = await threadB.say("show my applications");
        assertEquals([cardB.intent, cardB.resultStatus], ["career_apply_card", "shown"], cardB.reply);
        const metaB = JSON.parse(await pg.sql(`select coalesce((select meta::text from public.agent_messages where thread_id = '${threadB.thread()}' and role = 'assistant' order by id desc limit 1), 'null')`));
        assert(typeof metaB?.card_id === "string" && metaB.card_id !== metaA.card_id, `a different card: ${JSON.stringify([metaA.card_id, metaB.card_id])}`);
        assertEquals(await pg.sql(`select state from public.career_apply_cards where id = '${metaA.card_id}'`), "answered", "thread A's card was closed by the newer card");
        // SERIAL-1442: another person's yes approves nothing of anyone's.
        const other: Chat = agentChat!.chat("tok-other");
        const theirs = await other.say("yes");
        assert(theirs.resultStatus !== "answered" && theirs.intent !== "career_apply_card", `another person's yes is not this card's: ${theirs.intent} ${theirs.reply}`);
        // D-MS-1 (2026-10-27; replaces SERIAL-1461's reply-only rule): a bare yes in thread A is about the card A showed,
        // and that card was closed by B's: out of date, nothing approved.
        const bareA = await say("yes");
        assertEquals(bareA.resultStatus, "card_outdated", bareA.reply);
        assert(/out of date/.test(bareA.reply) && /nothing was approved/.test(bareA.reply), bareA.reply);
        // A yes in thread A in reply to A's card message: that card is out of date; nothing is approved, on either card.
        const cardMsgA = await pg.sql(`select id from public.agent_messages where thread_id = '${chat.thread()}' and role = 'assistant' and meta->>'card_id' = '${metaA.card_id}' order by id desc limit 1`);
        const yesA = await say("yes", { reply_to_message_id: Number(cardMsgA) });
        assertEquals([yesA.intent, yesA.resultStatus], ["career_apply_card_answer", "card_outdated"], yesA.reply);
        assert(/out of date/.test(yesA.reply) && /nothing was approved/.test(yesA.reply), yesA.reply);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'queued'`), "0", "nothing approved by the yes in A");
        assertEquals(await pg.sql(`select state from public.career_apply_cards where id = '${metaB.card_id}'`), "open", "B's card untouched");
        const replayA = await say("yes", { reply_to_message_id: Number(cardMsgA) });
        assert(replayA.resultStatus !== "answered", `a replay in A approves nothing: ${replayA.intent} ${replayA.resultStatus}`);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'queued'`), "0");
        // SERIAL-1460 (2): after another reply in thread B a bare yes is not the card's; a yes that replies to the card's
        // own message (the channel's reply-to id) binds to that card.
        const between = await threadB.say("where are my applications");
        assert(between.intent !== "career_apply_card", between.intent ?? "");
        const bareB = await threadB.say("yes");
        assert(bareB.resultStatus !== "answered", `a bare yes after another reply approves nothing: ${bareB.intent} ${bareB.resultStatus}`);
        assert(!/approved exactly as shown/.test(bareB.reply), bareB.reply);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'queued'`), "0");
        const cardMsgB = await pg.sql(`select id from public.agent_messages where thread_id = '${threadB.thread()}' and role = 'assistant' and meta->>'card_id' = '${metaB.card_id}' order by id desc limit 1`);
        const toOther = await threadB.say("yes", { reply_to_message_id: Number(cardMsgB) + 1 });
        assertEquals(toOther.resultStatus, "needs_reply", `a yes in reply to a message that is not the card approves nothing and says how: ${toOther.intent} ${toOther.reply}`);
        // The thread that showed the newest card approves it, once, by replying to the card's message.
        const yesB = await threadB.say("yes", { reply_to_message_id: Number(cardMsgB) });
        assertEquals(yesB.resultStatus, "answered", `SERIAL-1440 (1): one text yes in the thread that showed the card approves the batch it shows: ${yesB.reply}`);
        assert(/2 approved exactly as shown/.test(yesB.reply) && /Nothing has gone to an employer yet/.test(yesB.reply), yesB.reply);
        assertEquals(await pg.sql(`select count(distinct payload_hash) from public.career_apply_jobs where user_id = '${PERSON}' and state = 'queued'`), "2", "two applications, two exact payloads, by the hashes the card carried");
        assertEquals(await threadB.say("yes").then((r) => r.resultStatus === "answered"), false, "a second yes approves nothing: the card is single-use");
        const queue = ownQueue(person);
        const done = await runApproved({
          claim: () => queue.claim(2),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => { const path = `${work}/sent-resume-${job.payload.resume_sha256.slice(0, 8)}.pdf`; await Deno.writeFile(path, memory.files.get(`career-resumes/${PERSON}/${job.payload.resume_sha256}.pdf`)!); return { path, sha256: job.payload.resume_sha256 }; },
          writeFacts: async (job, facts) => { const p = `${work}/approved-facts-${job.id}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; },
          runEngine,
        });
        assertEquals(done.length, 2);
        assertEquals([site.posts.apply.length, site2.posts.sibling.length], [1, 1], "exactly one POST each");
        assertEquals([site.posts.apply[0].why, site2.posts.sibling[0].why], [FIRST_WHY, SIBLING_WHY]);
        const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('company', company, 'state', state, 'conf', confirmation_id) order by confirmation_id), '[]') from public.career_apply_jobs where user_id = '${PERSON}' and company in ('${COMPANY}', '${SIBLING}')`));
        assertEquals(rows, [{ company: COMPANY, state: "submitted_unconfirmed", conf: "CHAT-APPLY-1" }, { company: SIBLING, state: "submitted_unconfirmed", conf: "CHAT-SIBLING-1" }]);
        const all = await say("where are my applications");
        assert(all.reply.includes(COMPANY) && all.reply.includes(SIBLING), all.reply);
      });
    } finally {
      agentChat?.restore();
      await site.close();
      await site2.close();
      await pg.stop();
    }
  },
});
