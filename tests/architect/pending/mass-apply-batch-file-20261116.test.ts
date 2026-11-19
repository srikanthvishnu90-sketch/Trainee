// D-094 (owner, 2026-11-16): a large batch is shown as a short chat summary (count, top items, File link) plus a File listing
// every application with its exact payload; the one yes approves exactly what the File lists, bound by the payload hashes; a
// File changed after it was shown approves nothing; "yes except 2", "maybe" and a wrong count keep D-MS-1's grammar.
// Before (afc5739d5): 122 postings became 5 preparation requests (parts of 25), each finish pushed its own card, and the yes
// approved only the last card (eval MA14: 25 of 122).
//
// Driven through the production pieces: the database's own put (career_apply_prepare_request_put) and claim, the bridge's
// finish (cloud_prepare.ts handlePrepareBridge, as career-cloud-runner/index.ts wires it: batchFile = supabaseBatchFile),
// the File made by file_service.ts, and the person's texted answer through the REAL agent-chat handler (tests/flow/handler.ts:
// supabase-js, the PostgREST double, Postgres 16 with every migration). SETUP, named as such: each posting's prepared
// application is stored by the person's own computer (career_apply_prepare_own, the database hashes it) and its preparation
// attempt recorded, which is what the sandbox's dry run records. Nothing reaches a network, an employer or a model.
// Run: PGBIN=... deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/mass-apply-batch-file-20261116.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg } from "../../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../../flow/handler.ts";
import { confirmedResumeSql } from "../../flow/resume-seed.ts";
import { handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";
// Read by name, so that on a build without it (afc5739d5) this test runs and fails on what the person sees, not on an import.
const links: any = await import("../../../supabase/functions/_shared/application_review_links.ts");

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const SECRET = "TEST-d094-runner-secret-0123456789abcdef0123";
const FILE_ENV: Record<string, string> = { TRAINEE_FILE_BASE_URL: "https://file.d094.test", TRAINEE_FILE_LINK_SECRET: "TEST-d094-file-link-key-not-real-0123" };
const RESUME_FILE = "%PDF-1.4\n% TEST D-094 batch File resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const PEOPLE: Record<string, string> = {
  "tok-d094-scale": "7b0f8f8e-6a43-4a49-9d2c-0000000d0941", "tok-d094-edit": "7b0f8f8e-6a43-4a49-9d2c-0000000d0942",
  "tok-d094-grammar": "7b0f8f8e-6a43-4a49-9d2c-0000000d0943", "tok-d094-small": "7b0f8f8e-6a43-4a49-9d2c-0000000d0944",
};
const THREAD = (u: string) => `${u.slice(0, -4)}7${u.slice(-3)}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

Deno.test({
  name: "D-094: one summary card and one File per batch; the one yes approves exactly the File's set, by payload hash",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      for (const u of Object.values(PEOPLE)) {
        await pg.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id) values ('${u}');
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(u, RESUME_FILE)}
          insert into public.agent_threads (id, user_id, title) values ('${THREAD(u)}', '${u}', 'TEST chat');
          insert into public.agent_messages (thread_id, role, content, meta) values ('${THREAD(u)}', 'assistant', 'Queued them.', '{"intent":"career_apply_queue"}');`);
      }
      h = await careerHandler(pg, PEOPLE);
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const rpc = async (name: string, args: any) => { const r = await admin.rpc(name, args); if (r.error) throw Error(r.error.message); return r.data; };
      const json = async (sql: string) => JSON.parse((await pg.sql(`select coalesce((${sql})::text, 'null')`)) || "null");

      // n postings asked for in one message: queued, put (the database splits them into parts of 25), claimed, each posting's
      // application prepared (SETUP: as the sandbox's dry run stores it), then each part's finish through the bridge.
      const batchOf = async (u: string, n: number) => {
        const keys = Array.from({ length: n }, (_, i) => `lever:d094${u.slice(-2)}:${String(i + 1).padStart(3, "0")}`);
        await pg.sql(`insert into public.career_apply_wanted (user_id, posting_key, url, company, title) select '${u}', k, 'https://jobs.lever.co/' || replace(k, ':', '/'),
          'D094 Employer ' || right(k, 3), 'Operations Associate' from unnest(array[${keys.map(q).join(",")}]) k;`);
        const put = await rpc("career_apply_prepare_request_put", { p_user: u, p_job_ids: keys, p_per_person_day: null });
        const claimed: any[] = await rpc("career_apply_prepare_request_claim", { p_want: 100, p_global: 1000, p_per_person_day: null, p_per_site_minute: null });
        const parts = claimed.filter((r) => r.user_id === u);
        const person = pg.asPerson(u);
        for (const [i, k] of keys.entries()) {
          const company = `D094 Employer ${k.slice(-3)}`, url = `https://jobs.lever.co/${k.replace(/:/g, "/")}`;
          const payload = { version: 1, user_id: u, job_id: k, company, url, privacy_epoch: 0, account_version: 0, resume_sha256: RESUME_SHA,
            expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
            fields: [{ name: "email", label: "Email", value: "alex.testcase@example.test", factId: "basics.email" }, { name: "why", label: "Why this role?", value: `TEST answer ${i + 1}`, factId: "text-answer:1" }] };
          const r = await person.rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [company, "Email: alex.testcase@example.test", `Why this role?: TEST answer ${i + 1}`, "Resume: Alex_Resume.pdf"] });
          eq(r.error, null, JSON.stringify(r.error));
        }
        await pg.sql(`insert into public.career_apply_prepare_attempts (user_id, posting_job_id, outcome, prepared_id)
          select user_id, job_id, 'ready', id from public.career_apply_prepared where user_id = '${u}';`);
        const deps = { secret: SECRET, rpc, stop: async () => {},
          readRequest: async (id: string) => (await admin.from("career_apply_prepare_requests").select("id,user_id,job_ids,state,lease_token,claimed_at").eq("id", id)).data?.[0] ?? null,
          batchFile: links.supabaseBatchFile?.(admin, { get: (k: string) => FILE_ENV[k] }) };
        const pushes: string[] = [];
        for (const p of parts) {
          const sandbox = `sbx_${p.id.slice(0, 8)}`;
          const out = await handlePrepareBridge("finish", { id: p.id, sandbox, token: await prepareToken(SECRET, p.id, p.lease_token, sandbox),
            outcomes: p.job_ids.map((j: string) => ({ job_id: j, outcome: "ready", detail: "" })) }, deps as any);
          eq(out.status, 200, JSON.stringify(out.body));
          pushes.push((out.body as any).push);
          if (Deno.env.get("D094_DEBUG")) console.log(JSON.stringify(out.body));
        }
        const cards: any[] = await json(`select json_agg(json_build_object('id', id, 'items', items, 'file_id', to_jsonb(c)->>'file_id', 'file_sha', to_jsonb(c)->>'file_sha', 'state', state) order by shown_at) from public.career_apply_cards c where user_id = '${u}'`) ?? [];
        const msgs: any[] = await json(`select json_agg(json_build_object('content', content, 'meta', meta) order by id) from public.agent_messages where thread_id = '${THREAD(u)}' and meta->>'intent' = 'career_apply_card'`) ?? [];
        return { keys, put, parts, pushes, cards, msgs, chat: h!.chat(Object.keys(PEOPLE).find((k) => PEOPLE[k] === u)!) };
      };
      const fileOf = async (u: string, id: string) => await json(`select value from public.career_watch_kv where user_id = '${u}' and key = 'tf:file:${id}'`);
      const jobs = async (u: string) => await json(`select json_agg(json_build_object('job_id', job_id, 'approval_hash', approval_hash, 'payload_hash', payload_hash)) from public.career_apply_jobs where user_id = '${u}'`) ?? [];

      await t.step("122 postings: one card, one File, one yes; all 122 enqueued exactly once, each at the hash the File lists", async () => {
        const u = PEOPLE["tok-d094-scale"], b = await batchOf(u, 122);
        eq(b.parts.length, 5, "the database still prepares 122 in parts of 25 (one sandbox each)");
        eq(b.pushes.filter((p) => p === "held_for_batch").length, 4, `the first four parts hold for the batch: ${b.pushes.join(", ")}`);
        eq(b.pushes.at(-1), "shown_file", `the last part shows the batch: ${b.pushes.join(", ")}`);
        eq(b.cards.length, 1, `ONE card for the whole batch (before: one per part): ${b.cards.length}`);
        const card = b.cards[0];
        eq(card.items.length, 122, "the card carries all 122");
        ok(/^[0-9a-f]{10}$/.test(card.file_id) && /^[0-9a-f]{64}$/.test(card.file_sha), "the card is bound to its File by hash");
        eq(b.msgs.length, 1, `one chat message for the batch (before: about 9): ${b.msgs.length}`);
        const text: string = b.msgs[0].content;
        ok(text.length <= 1600, `the summary fits a phone screen (${text.length} characters)`);
        ok(/^122 applications are ready\./.test(text), text.slice(0, 80));
        ok((text.match(/^\d+\. /gm) ?? []).length <= 5 && /and 117 more/.test(text), "the top 5 by name, then the count of the rest");
        ok(text.includes(FILE_ENV.TRAINEE_FILE_BASE_URL), "the File link is in the summary");
        ok(/Reply "yes" to send all 122/.test(text) && /yes except 2/.test(text), "how to answer, in D-MS-1's words");
        const file = await fileOf(u, card.file_id);
        const items = file.data.batch.items;
        eq(items.length, 122, "the File lists every application");
        eq(items.map((x: any) => x.prepared_id), card.items.map((x: any) => x.prepared_id), "in the card's order: the File's numbers are the card's");
        eq(items.map((x: any) => x.payload_hash), card.items.map((x: any) => x.payload_hash), "each at the payload hash the card binds");
        ok(items.every((x: any) => /^https:\/\/jobs\.lever\.co\//.test(x.url) && /Alex_Resume\.pdf|resume/i.test(String(x.resume)) && x.answers.some((a: any) => /TEST answer/.test(a.answer))),
          "every item names its link, its resume and its exact answers");
        const yes = await b.chat.say("yes", { thread_id: THREAD(u) });
        eq(yes.resultStatus, "answered", yes.reply.slice(0, 300));
        const j = await jobs(u);
        eq(j.length, 122, `one yes enqueued all 122 (before: the last card's only): ${j.length}`);
        eq(new Set(j.map((x: any) => x.job_id)).size, 122, "each exactly once");
        const fileHash = new Map(items.map((x: any) => [x.payload_hash, true]));
        ok(j.every((x: any) => x.approval_hash === x.payload_hash && fileHash.has(x.payload_hash)), "every approval is the hash the File lists");
        ok(/\b122 approved exactly as shown\b/.test(yes.reply), yes.reply.slice(0, 120));
      });

      await t.step("a File edited after it was shown approves nothing", async () => {
        const u = PEOPLE["tok-d094-edit"], b = await batchOf(u, 30);
        eq(b.cards.length, 1, `30 postings in two parts: one card (${b.pushes.join(", ")})`);
        const card = b.cards[0];
        ok(card.file_id, "a summary card bound to its File");
        const before = await fileOf(u, card.file_id);
        await pg.sql(`update public.career_watch_kv set value = jsonb_set(value, '{data,batch,items,2,answers,1,answer}', '"a different answer"') where user_id = '${u}' and key = 'tf:file:${card.file_id}'`);
        const yes = await b.chat.say("yes", { thread_id: THREAD(u) });
        eq(yes.resultStatus, "file_changed", yes.reply);
        ok(/nothing was approved and nothing was sent/.test(yes.reply), yes.reply);
        eq((await jobs(u)).length, 0, "nothing enqueued");
        ok(before.data.batch.items[2].answers[1].answer !== "a different answer", "the File was edited after it was shown");
        const again = await b.chat.say("yes", { thread_id: THREAD(u) });
        eq((await jobs(u)).length, 0, `a second yes approves nothing either: ${again.reply.slice(0, 120)}`);
        eq((await json(`select to_jsonb(state) from public.career_apply_cards where id = '${card.id}'`)), "open", "the card was never answered by a refused yes");
      });

      await t.step("\"maybe\" and a wrong count approve nothing; \"yes except 2\" leaves out the File's number 2", async () => {
        const u = PEOPLE["tok-d094-grammar"], b = await batchOf(u, 40);
        eq(b.cards.length, 1, b.pushes.join(", "));
        const file = await fileOf(u, b.cards[0].file_id);
        const maybe = await b.chat.say("maybe", { thread_id: THREAD(u) });
        eq(maybe.resultStatus, "unclear", maybe.reply);
        const wrong = await b.chat.say("yes send all 41", { thread_id: THREAD(u) });
        eq(wrong.resultStatus, "count_mismatch", wrong.reply);
        ok(/This card has 40, not 41/.test(wrong.reply), wrong.reply);
        eq((await jobs(u)).length, 0, "neither approved anything");
        const except = await b.chat.say("yes except 2", { thread_id: THREAD(u) });
        eq(except.resultStatus, "answered", except.reply.slice(0, 200));
        const j = await jobs(u), two = file.data.batch.items[1];
        eq(j.length, 39, "39 of the File's 40");
        ok(!j.some((x: any) => x.payload_hash === two.payload_hash), `number 2 of the File (${two.employer}) was left out`);
      });

      await t.step("a small batch (fits one card text) still shows inline as today, every line on the card, no File", async () => {
        const u = PEOPLE["tok-d094-small"], b = await batchOf(u, 4);
        eq(b.pushes, ["shown"], b.pushes.join(", "));
        eq(b.cards.length, 1);
        eq(b.cards[0].file_id, null, "no File for a card that fits one text");
        const text: string = b.msgs[0].content;
        for (let i = 1; i <= 4; i++) ok(text.includes(`TEST answer ${i}`), `answer ${i} is on the card itself`);
        const req = await json(`select json_agg(json_build_object('batch_id', to_jsonb(r)->>'batch_id', 'done', to_jsonb(r)->>'batch_done_at' is not null, 'outcome', outcome)) from public.career_apply_prepare_requests r where user_id = '${u}'`);
        eq(req.length, 1, "one part");
        ok(req[0].batch_id && req[0].done && req[0].outcome?.batch?.requests === 1, `a batch of one, recorded: ${JSON.stringify(req[0])}`);
      });
    } finally {
      h?.restore();
      await pg.stop();
    }
  },
});
