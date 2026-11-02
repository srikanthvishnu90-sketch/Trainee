// TAILORING END TO END, ROUND 2 (architect, 2026-10-30; owner rule D-007). A sample of round 2's battery
// (tests/architect/scenarios/tailoring-r2-generator.ts; ~10,000 scenarios in scenarios-tailoring-r2.test.ts) sent through
// the REAL production handler (handler-career.ts handleChat; harness tests/flow/handler.ts: real supabase-js over
// tests/flow/postgrest.ts, real Postgres 16 with every migration). Each person pastes the fixture resume and confirms it in
// chat (the evidenced confirm: their facts carry the real provenance and confirmation event), in a thread of their own:
//   draft    an essay question waiting for them: "what do you need from me", "draft 1" (the fake model answers with an
//            HONEST draft built only from their confirmed words, with the words the checks used to refuse: "my manager
//            said", "double-check", "managed to", "was led by", the posting's own numbers and year, a title that names
//            another company, a spelled-out year and percent the record holds; or with a planted round-2 claim: a
//            lower-case invented employer or school, "over a decade", a certification, a clearance, a language, work rights
//            said sideways, military service, an award, a publication, a promotion, a fraction, honours, a percent that
//            only matches a count, or "owner of" traced to the fact's own provenance), then "use 1": an honest draft is
//            shown and saved word for word; a planted claim is never shown or saved
//   tailor   "tailor my resume for ..." with CAREER_TAILOR_REWRITE=on: the fake model rewords each bullet faithfully or with
//            a planted round-2 claim; the PDF in channel_artifacts carries none of them
//   ask      questions the prepare path stored for them (workers/career-browser/ask-once.ts questionsToStore over an
//            engine result: salary, notice period, years with a named tool, a clearance, a felony, a start date): "draft N"
//            on one never calls the model and saves nothing; "N <answer>" is saved as typed; a secret never
// The model is a fake OpenAI endpoint (no spend, no network): every other host is refused and recorded (asserted empty).
import assertNode from "node:assert/strict";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import { questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { leaks, type Poison, rng } from "./scenarios/tailoring-r2-generator.ts";
import { askedPart } from "../helpers/one_question.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
const COMPANY = "Quillstone Analytics (TEST)", ROLE = "Data Analyst";
const POSTING = `${ROLE} at ${COMPANY}. You will build dashboards for internal users and automate reporting.
Requirements: Python, PostgreSQL and React; experience automating data pulls and reporting for internal users.`;
const N_DRAFT = 30, N_TAILOR = 8, N_ASK = 8;
const PEOPLE = Array.from({ length: N_DRAFT + N_TAILOR + N_ASK }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-00000030${String(i).padStart(4, "0")}`);
const COMPANIES = ["Larkspur Health (TEST)", "Quarry Bank (TEST)", "Fernway Labs (TEST)", "Otter Freight (TEST)"];
const BASE = [
  "At TEST Systems Inc, I built a reporting dashboard in React and Python used by 200 internal users.",
  "As a Finance Intern, I also prepared 10 pages of investment committee materials.",
];
// Honest words for the fixture person: only their confirmed facts, someone else, or the posting. Each with the question it
// needs (null: any) and the company it names.
const HONEST: { say: (c: string) => string; label?: (c: string) => string; company?: string }[] = [
  { say: () => "My manager at TEST Systems Inc said the reporting dashboard helped." },
  { say: () => "I would welcome a manager who gives direct feedback." },
  { say: () => "I double-check every number before anyone relies on it." },
  { say: () => "At TEST Systems Inc, I managed to cut weekly reporting time by 40% by automating data pulls from PostgreSQL." },
  { say: () => "The team I joined at TEST Systems Inc was led by a director who cared about clean data." },
  { say: (c) => `I want to learn from veteran engineers at ${c}.` },
  { say: () => "At Example Capital, I reported to the head of finance." },
  { say: () => "This role asks for 6+ years of Python, and I want to grow toward that.", label: () => "This role asks for 6+ years of Python. Why are you interested in it?" },
  { say: (c) => `${c} was founded in 1998 and has grown since.`, label: (c) => `${c} was founded in 1998. Why do you want to join us?` },
  { say: () => "I want to be your Google Cloud Engineer because I built DeployBoard in Go to deploy containerised apps on Kubernetes.", label: () => "Why do you want to be our Google Cloud Engineer?", company: "Cloudmark Partners (TEST)" },
  { say: () => "I started at TEST Systems Inc in twenty twenty-five." },
  { say: () => "At TEST Systems Inc, I cut weekly reporting time by forty percent." },
  { say: () => "I led the TEST University Investing Club of forty-five members." },
];
const P = (kind: string, say: string, ...marks: RegExp[]): Poison => ({ kind, say, marks });
const PLANTED: Poison[] = [
  P("employer-invented", "before that i worked at hooli.", /\bhooli\b/i),
  P("school-invented", "i graduated from harmon polytechnic.", /harmon polytechnic/i),
  P("decade", "I have over a decade of experience with dashboards.", /\bdecade\b/i),
  P("cert", "i am pmp certified.", /\bpmp\b/i),
  P("clearance", "i hold an active ts/sci.", /ts\/sci/i),
  P("language", "i am fluent in tagalog.", /tagalog/i),
  P("visa-sideways", "As a green card holder, I can start right away.", /green card/i),
  P("military", "i served in the navy before this.", /\bnavy\b/i),
  P("award", "I won the company hackathon.", /hackathon/i),
  P("publication", "I published research on forecasting.", /\bpublished\b/i),
  P("promotion", "I was promoted quickly at TEST Systems Inc.", /\bpromoted\b/i),
  P("fraction", "I raised revenue by a third.", /by a third/i),
  P("honours", "I graduated top of my class.", /top of my class/i),
  P("percent-of-a-count", "At Example Capital, I cut costs by forty-five percent.", /forty-five percent/i),
  P("provenance-owner", "I was the owner of the data team at TEST Systems Inc.", /\bowner of\b/i),
];
const hex16 = (n: number) => n.toString(16).padStart(16, "0");

Deno.test({
  name: "round 2: honest drafts shown and saved, planted claims never, through the real handler on real Postgres",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "OPENAI_API_KEY", "CAREER_MODEL", "CAREER_TAILOR_REWRITE", "CAREER_HOSTED_PREPARE"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      const sq = (s: string) => s.replace(/'/g, "''");
      await pg.sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
          ('test:quillstone:r2', 'greenhouse', 'quillstone', '${sq(COMPANY)}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/quillstone/jobs/2', now(), '${sq(POSTING)}', 'h2');
        insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.profiles (id) select id::uuid from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);
        insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${PEOPLE.map((p) => `('${p}')`).join(", ")}) v(id);`);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, Object.fromEntries(PEOPLE.map((p, i) => [`tok-${i}`, p])));

      let rewrite: (text: string) => string = (x) => x;
      let essay: string[] = [];
      const calls = { rewrite: 0, essay: 0, other: 0 };
      const answer = (content: string, model: string) => new Response(JSON.stringify({ id: "chatcmpl-test", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 500, completion_tokens: 100 } }), { headers: { "content-type": "application/json" } });
      const fakeOpenAI = (body: any): Response => {
        const sys = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
        const user = body.messages?.find((m: any) => m.role === "user");
        const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).map((c: any) => c.text ?? "").join("");
        if (/reword resume bullets/.test(sys)) {
          calls.rewrite++;
          const ask = JSON.parse(text);
          return answer(JSON.stringify({ bullets: ask.bullets.map((b: any) => ({ id: b.id, text: rewrite(b.text) })) }), body.model);
        }
        if (/one answer to a job application question/.test(sys)) { calls.essay++; return answer(essay.shift() ?? "", body.model); }
        calls.other++;
        return answer("{}", body.model);
      };
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.openai.com") return fakeOpenAI(await req.json());
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      Deno.env.set("OPENAI_API_KEY", ["sk", "test", "fake"].join("-"));
      Deno.env.set("CAREER_MODEL", "gpt-5-mini");

      const failures: string[] = [];
      const counts: Record<string, number> = {};
      const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
      const onboard = async (n: number) => {
        const chat = h!.chat(`tok-${n}`);
        const pasted = await chat.say(`here is my resume:\n${RESUME}`);
        assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await chat.say("yes, that's my resume");
        assertNode.deepEqual([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        count("setup turns"); count("setup turns");
        return chat;
      };
      const stored = async (who: string) => await pg.sql(`select coalesce(string_agg(m.content || ' ' || coalesce(m.meta::text, ''), E'\\n'), '') from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${who}'`);
      const answerOf = async (who: string, key?: string) => (await pg.sql(`select coalesce(string_agg(answer, '|' order by key), '') from public.career_apply_questions where user_id = '${who}' and answer is not null${key ? ` and key = '${sq(key)}'` : ""}`)).trim();
      const r = rng(20261030 + 7);
      let honestShown = 0, honestTotal = 0;

      await t.step(`draft: ${N_DRAFT} people, an essay question each, drafted honestly or with a planted round-2 claim`, async () => {
        for (let k = 0; k < N_DRAFT; k++) {
          const n = k, who = PEOPLE[n];
          const chat = await onboard(n);
          let company = r.pick(COMPANIES);
          const h1 = HONEST[k % HONEST.length], h2 = r.pick(HONEST.filter((x) => !x.label && x !== h1));
          if (h1.company) company = h1.company;
          const label = h1.label ? h1.label(company) : r.pick([`Why do you want to work at ${company}?`, "Describe a challenge you overcame.", "Tell us about a project you are proud of."]);
          await pg.sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, options, job_ids, company)
            values ('${who}', 'job:${hex16(n + 1)}', 'essay', '${sq(label)}', 'textarea', '[]', array['greenhouse:${sq(company.toLowerCase().replace(/\W+/g, ""))}:${n}'], '${sq(company)}')`);
          const honest = [BASE[0], h1.say(company), BASE[1], h2.say(company)].join(" ");
          const mode = k % 3 === 2 ? "honest" : "planted";
          const planted = mode === "planted" ? [PLANTED[k % PLANTED.length]] : [];
          const splice = () => [BASE[0], planted[0].say, h1.say(company), BASE[1]].join(" ");
          const retryHonest = mode === "planted" && r.next() < 0.5;
          essay = mode === "honest" ? [honest] : [splice(), retryHonest ? honest : splice()];
          if (mode === "honest" || retryHonest) honestTotal++;
          const tag = `draft #${k} ${JSON.stringify(label)} [${planted.map((p) => p.kind).join(", ") || "honest"}${retryHonest ? ", honest retry" : ""}]`;
          const list = await chat.say("what do you need from me");
          count("draft turns");
          if (list.intent !== "career_apply_questions" || !list.reply.includes(label)) { failures.push(`${tag}: the question is not shown: ${list.intent}: ${list.reply.slice(0, 200)}`); continue; }
          const d = await chat.say("draft 1");
          count("draft turns");
          const shown = /^Draft for 1, written only from your confirmed facts/.test(d.reply);
          const body = shown ? d.reply.split("\n\n")[1] ?? "" : "";
          for (const p of planted) if (shown && leaks(body, p)) failures.push(`${tag}: the draft shown holds the ${p.kind}: ${body}`);
          if ((mode === "honest" || retryHonest) && !shown) failures.push(`${tag}: an honest draft from their confirmed words is not shown: ${d.reply.slice(0, 400)}`);
          if (shown && (mode === "honest" || retryHonest)) honestShown++;
          if (shown) {
            const use = await chat.say("use 1");
            count("draft turns");
            const ans = await answerOf(who);
            if (!ans) failures.push(`${tag}: "use 1" saved nothing: ${use.reply.slice(0, 200)}`);
            for (const p of planted) if (leaks(ans, p)) failures.push(`${tag}: the saved answer holds the ${p.kind}: ${ans}`);
            if (ans && ans !== body.trim()) failures.push(`${tag}: the saved answer is not the draft shown: ${ans}`);
          } else if (await answerOf(who)) failures.push(`${tag}: an answer was saved with no draft shown`);
        }
      });

      await t.step(`tailor: ${N_TAILOR} people, each bullet reworded faithfully or with a planted round-2 claim`, async () => {
        Deno.env.set("CAREER_TAILOR_REWRITE", "on");
        const TAILS: Poison[] = [
          P("rewrite-employer-invented", " at hooli", /\bhooli\b/i), P("rewrite-cert", " as a certified PMP", /\bpmp\b/i), P("rewrite-language", ", presenting in fluent Tagalog", /tagalog/i),
          P("rewrite-decade", ", drawing on over a decade of practice", /\bdecade\b/i), P("rewrite-lead-on", " as the lead on the project", /the lead on/i),
          P("rewrite-clearance", " under a TS/SCI clearance", /ts\/sci/i), P("rewrite-fraction", ", cutting costs by a third", /by a third/i),
        ];
        for (let k = 0; k < N_TAILOR; k++) {
          const n = N_DRAFT + k;
          const chat = await onboard(n);
          const planted: Poison[] = [];
          rewrite = (text) => {
            if (r.next() < 0.4) return text.replace(/^Built /, "Developed ");
            const p = r.pick(TAILS);
            planted.push(p);
            return `${text}${p.say}`;
          };
          const before = calls.rewrite;
          const res = await chat.say(`tailor my resume for the ${ROLE} role at ${COMPANY}`);
          count("tailor turns");
          const tag = `tailor #${k} [${planted.map((p) => p.kind).join(", ") || "faithful"}]`;
          if (res.status !== 200 || res.intent !== "career_tailor") { failures.push(`${tag}: ${res.status} ${res.intent}: ${res.reply.slice(0, 200)}`); continue; }
          if (calls.rewrite !== before + 1) failures.push(`${tag}: ${calls.rewrite - before} rewrite calls`);
          const ref = res.body.artifacts?.[0]?.ref;
          const b64 = ref ? (await pg.sql(`select bytes_b64 from public.channel_artifacts where id = '${ref}' and user_id = '${PEOPLE[n]}'`)).trim() : "";
          if (b64.length < 100) { failures.push(`${tag}: no PDF rides the reply`); continue; }
          const lines = (R.extractPdfLines(Buffer.from(b64, "base64")) as string[]).join("\n");
          for (const p of planted) if (leaks(lines, p)) failures.push(`${tag}: ${p.kind} printed:\n${lines}`);
        }
        Deno.env.delete("CAREER_TAILOR_REWRITE");
      });

      await t.step(`ask: ${N_ASK} people, the questions the prepare path stored for them`, async () => {
        const ENGINE = (i: number) => ({ posting: `greenhouse:larkspur:${900 + i}`, company: "Larkspur Health (TEST)", location: "Chicago, IL", questions: [
          { label: "What are your salary expectations?", type: "input_text" },
          { label: "What is your notice period?", type: "input_text" },
          { label: "How many years of experience do you have with Kubernetes?", type: "input_text" },
          { label: "Do you have an active security clearance?", type: "select", options: ["Yes", "No"] },
          { label: "Have you ever been convicted of a felony?", type: "select", options: ["Yes", "No"] },
        ] });
        const TYPED = ["95000", "2 weeks", "3 years", "No", "No"];
        for (let k = 0; k < N_ASK; k++) {
          const n = N_DRAFT + N_TAILOR + k, who = PEOPLE[n];
          const chat = await onboard(n);
          const res = ENGINE(k);
          const qs = questionsToStore(res, { facts: {}, answered: new Set() }).questions as any[];
          for (const q of qs) {
            await pg.sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, options, job_ids, company)
              values ('${who}', '${sq(String(q.key))}', '${sq(String(q.kind))}', '${sq(String(q.label))}', '${sq(String(q.type))}', '${sq(JSON.stringify(q.options))}', array['${sq(res.posting)}'], '${sq(String(q.company))}')`);
          }
          const tag = `ask #${k}`;
          // One question per message (review of #360): the first is shown; "skip" moves to the next.
          const list = await chat.say("what do you need from me");
          count("ask turns");
          const first = qs.find((q) => list.reply.includes(q.label));
          if (!first || !new RegExp(`Question 1 of ${qs.length} `).test(list.reply) || qs.filter((q) => list.reply.includes(q.label)).length !== 1) {
            failures.push(`${tag}: not one question of ${qs.length}: ${list.reply.slice(0, 300)}`); continue;
          }
          // "draft 1" on a question that is not a written answer: no model call, nothing saved.
          const before = calls.essay;
          const d = await chat.say("draft 1");
          count("ask turns");
          if (calls.essay !== before) failures.push(`${tag}: "draft 1" (${first.label}) called the model`);
          if (!/isn't a written answer/.test(d.reply)) failures.push(`${tag}: "draft 1" (${first.label}) -> ${d.reply.slice(0, 200)}`);
          if (await answerOf(who)) failures.push(`${tag}: "draft 1" saved an answer`);
          // A typed answer is saved as typed; a secret never. Odd scenarios answer the second question, after a "skip".
          let shown = await chat.say("what do you need from me");
          count("ask turns");
          if (k % 2 === 1) { shown = await chat.say("skip"); count("ask turns"); }
          const asked = qs.filter((q) => askedPart(shown.reply).includes(q.label));
          if (asked.length !== 1) { failures.push(`${tag}: not one question shown: ${shown.reply.slice(0, 300)}`); continue; }
          const label = asked[0].label;
          const typed = k % 4 === 3 ? "my ssn is 219-09-9999" : TYPED[qs.findIndex((q) => q.label === label)];
          const a = await chat.say(typed);
          count("ask turns");
          const key = asked[0].key;
          const got = await answerOf(who, key);
          if (/ssn/.test(typed)) {
            if (got) failures.push(`${tag}: a secret saved as the answer to ${label}`);
            if (/219\D?09\D?9999/.test(await stored(who))) failures.push(`${tag}: the SSN is kept in a stored message`);
          } else if (got !== typed) failures.push(`${tag}: "${typed}" (${label}) -> saved ${JSON.stringify(got)}: ${a.reply.slice(0, 200)}`);
        }
      });

      console.log(`flow-scenarios-tailoring-r2: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; honest drafts shown ${honestShown}/${honestTotal}; model calls ${JSON.stringify(calls)}; ${failures.length} failures; refused reads: ${outbound.join("; ") || "none"}`);
      assertNode.deepEqual(outbound, [], "no network");
      assertNode.deepEqual(failures, [], failures.join("\n"));
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
