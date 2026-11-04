// PENDING (family APPLICATION MATERIALS, 2026-10-26): the acceptance tests for what a brand-new person asks of their
// materials and does not get on trunk. Each fails on trunk for the reason in its step name; each names the file that
// owns the fix, all of them files that open PRs change (so the fix belongs to that PR's owner, with the patch note in
// the PR that added this file). Pending tests are excluded from the gate (scripts/gate.sh --ignore=tests/architect/pending);
// move a step into tests/architect/family-materials.test.ts when it passes.
//
// Same world as the landed suite: the REAL handler on real Postgres, the real supabase-js client, a fake OpenAI endpoint.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/family-materials-gaps.test.ts
import assertNode from "node:assert/strict";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity, type Turn } from "../../flow/handler.ts";
import { CareerRender } from "../../../supabase/functions/_shared/router_core.career.js";
import { chatThroughAgent } from "../../../supabase/functions/_shared/channel_runtime.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../../supabase/functions/_shared/career_tailor.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-00000000a3f1";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RESUME = `Jordan Rivera
jordan.rivera@example.test | (312) 555-0142 | Chicago, IL

EDUCATION
DePaul University - B.S. Computer Science, GPA 3.6, expected June 2028

EXPERIENCE
Software Engineering Intern, Brightline Labs, June 2025 - August 2025
- Built a customer dashboard in React and TypeScript used by 300 clinic staff
- Reduced page load time by 35% by caching API responses

Data Analyst Intern, Northside Credit Union, June 2024 - August 2024
- Automated weekly loan reports in Python and SQL for the lending team

PROJECTS
StudyBuddy
- Built a study-group matching web app in JavaScript and Node.js with 150 student users

SKILLS
JavaScript, TypeScript, React, Node.js, Python, SQL`;
const RAMP = `Frontend Engineering Intern at Ramp. You will build customer-facing product surfaces in React and TypeScript.
Requirements: React, JavaScript, TypeScript; experience building dashboards for users. Nice to have: Python.`;
const QUILL = `Data Analyst Intern at Quillstone Analytics. You will automate reporting for internal teams.
Requirements: Python and SQL; experience automating reports. Nice to have: Tableau.`;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
async function files(pg: Pg, r: Turn) {
  const refs = (r.body.artifacts ?? []).map((a: any) => `'${a.ref}'`).join(",") || "null";
  const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('mime', mime, 'b64', bytes_b64, 'filename', filename)), '[]') from public.channel_artifacts where user_id = '${PERSON}' and id::text in (${refs})`));
  const pdf = rows.find((x: any) => x.mime === "application/pdf"), docx = rows.find((x: any) => x.mime === DOCX);
  return {
    pdf: pdf ? squash((R.extractPdfLines(Buffer.from(pdf.b64, "base64")) as string[]).join(" ")) : null,
    docx: docx ? squash((R.extractDocxLines(Buffer.from(docx.b64, "base64")) as string[]).join(" ")) : null,
    pdfB64: pdf?.b64 ?? null,
  };
}

Deno.test({ name: "PENDING materials gaps: a new person's asks the router does not do yet", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { console.log("NOT_RUN: no Postgres binaries"); return; }
  const pg = await startPg();
  await supabaseParity(pg);
  await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'p@example.test'); insert into public.profiles (id) values ('${PERSON}');
    insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
    insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ('test:ramp:fe-intern', 'ashby', 'ramp', 'Ramp', 'Frontend Engineering Intern', 'New York, NY', 'https://jobs.ashbyhq.com/ramp/fe-intern', now(), '${RAMP.replace(/'/g, "''")}', 'h-ramp'),
    ('test:quillstone:da-intern', 'greenhouse', 'quillstone', 'Quillstone Analytics', 'Data Analyst Intern', 'Chicago, IL', 'https://boards.greenhouse.io/quillstone/jobs/2', now(), '${QUILL.replace(/'/g, "''")}', 'h-quill')`);
  Deno.env.set("CAREER_ACCOUNT_MEMORY", "on");
  const handler = await careerHandler(pg, { tok: PERSON });
  const via = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    if (new URL(req.url).host === "api.openai.com") return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }], usage: {} }), { headers: { "content-type": "application/json" } });
    return via(req);
  }) as typeof fetch;
  Deno.env.set("OPENAI_API_KEY", "sk-test-fake");
  const chat: Chat = handler.chat("tok");
  const say = async (m: string) => { const r = await chat.say(m); console.log(`>>> ${m}\n<<< [${r.intent} ${r.resultStatus}] ${r.reply.slice(0, 400)}`); eq(r.status, 200); return r; };
  try {
    await say(`here's my resume\n${RESUME}`);
    await say("yes, that's my resume");

    // Owner: packages/domain/142-career-router.js (PRs #200, #201). Trunk tailors to a posting the person never named
    // (the first one in the pool), with no critique at all.
    await t.step("AM-09 'make my resume look better' -> line-level critique of their own resume, not a tailoring to an unnamed posting", async () => {
      const r = await say("make my resume look better");
      assert(r.intent !== "career_tailor", `not tailored to a posting the person did not name: ${r.reply}`);
      assert(/Built a customer dashboard|Reduced page load time|Automated weekly loan reports|StudyBuddy/.test(r.reply), `the critique names one of their own lines: ${r.reply}`);
    });

    // Owner: 142 (PRs #200, #201) intake of contact lines, or the intake (PR #201): the name and email the person pasted,
    // or typed, go on the top of the file. Trunk: no name, no email, no phone on any tailored file.
    await t.step("AM-03 the contact line: name and email at the top of the file", async () => {
      await say("my name is Jordan Rivera and my email is jordan.rivera@example.test");
      const r = await say("tailor my resume for the Ramp frontend intern role");
      const f = await files(pg, r);
      assert(f.pdf && f.pdf.includes("Jordan Rivera") && f.pdf.includes("jordan.rivera@example.test"), `the name and email are on the PDF: ${f.pdf}`);
    });

    // Owner: 142 (PRs #200, #201). Trunk: catchall ("I did not catch what to do with that one").
    await t.step("AM-01 change of mind in plain words: 'actually do the quillstone data analyst intern one instead'", async () => {
      const r = await say("actually do the quillstone data analyst intern one instead");
      eq(r.intent, "career_tailor", r.reply);
      assert(/Quillstone/.test(r.reply), r.reply);
    });

    // Owner: 142 (PRs #200, #201) + a version store. Trunk: catchall for all three.
    let withGpa: string | null = null;
    await t.step("AM-01 'remove the GPA' -> a new version without it; 'undo that' -> the previous version, byte for byte", async () => {
      const before = await say("tailor my resume for the Ramp frontend intern role");
      withGpa = (await files(pg, before)).pdfB64;
      const r = await say("remove the GPA");
      const f = await files(pg, r);
      assert(f.pdf && !/GPA/.test(f.pdf) && /DePaul University/.test(f.pdf), `a new file without the GPA: ${r.reply}`);
      const u = await say("undo that");
      eq((await files(pg, u)).pdfB64, withGpa, `the previous version comes back: ${u.reply}`);
    });
    await t.step("AM-01 'shorter' -> a shorter version, every line still traced", async () => {
      const r = await say("shorter");
      const f = await files(pg, r);
      assert(f.pdf && f.pdf.length < 600, `a shorter file: ${r.reply}`);
    });

    // Owner: 142 handleDocumentDelivery (PRs #200, #201): trunk catchall for these words, and for "send me the docx" it
    // says the DOCX "renders with the application packet" though the tailor turn attaches it (this PR).
    await t.step("AM-03 'can I get it as a word doc' -> the DOCX of the latest version", async () => {
      const r = await say("can I get it as a word doc");
      assert((r.body.artifacts ?? []).some((a: any) => a.mime === DOCX), `a DOCX rides the reply: ${r.reply}`);
    });

    // Owner: 142 handleTailor's cover-letter branch (PRs #200, #201); career_essay_card.ts drafts letters for the
    // extension only. Trunk: "Cover letters only where the portal actually asks", no letter.
    await t.step("AM-04 'write a cover letter for the Ramp role' -> a full letter from confirmed facts, stored; 'shorter' -> shorter", async () => {
      const r = await say("write a cover letter for the Ramp frontend intern role");
      const text = r.reply + " " + ((await files(pg, r)).docx ?? "");
      assert(/Ramp/.test(text) && /Brightline Labs/.test(text) && text.split(/[.!?]\s/).length >= 6, `a letter that cites their record: ${r.reply}`);
      assert(!/Google|Meta|Stripe/.test(text), "no employer they never had");
      const s = await say("shorter");
      assert(s.reply.length < r.reply.length && /Ramp/.test(s.reply), `a shorter letter: ${s.reply}`);
    });

    // Owner: career_apply_email.ts supabaseResumes / workers prepare-ahead (no open PR) or the router: the application
    // attaches a file tailored again by tailorForPosting from a differently built posting text, so it can differ from the
    // version the person approved in chat (and never carries an accepted rewrite).
    await t.step("AM-01 the version an application attaches is the version the person was shown", async () => {
      const shown = await say("tailor my resume for the Ramp frontend intern role");
      const chatLines = (await files(pg, shown)).pdf;
      const acct = JSON.parse(await pg.sql(`select value from public.career_watch_kv where user_id = '${PERSON}' and key = 'career:account'`));
      const store = memoryResumeStore();
      const applied = await tailorForPosting({ userId: PERSON, profile: acct.memory?.profile, posting: { text: `Frontend Engineering Intern at Ramp\n\n${RAMP}`, job_id: "test:ramp:fe-intern", company: "Ramp" }, deps: { render: edgeRenderer(), resumes: store }, now: Date.now() });
      assert(applied.ok, `the application path builds a file: ${JSON.stringify(applied).slice(0, 300)}`);
      const appliedText = squash((R.extractPdfLines(Buffer.from([...store.files.values()][0])) as string[]).join(" "));
      eq(appliedText, chatLines, "the same lines");
    });

    // Owner: channel_runtime.ts chatThroughAgent / channel_inbound.ts (PR #194 for Telegram files; SMS and WhatsApp on
    // the Trainee channels have no file path): trunk drops the reply's artifacts, so a texting channel says "attached"
    // and attaches nothing.
    await t.step("CH the file reaches the texting channels: chatThroughAgent keeps the reply's artifacts", async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify({ reply: "Saved as PDF and DOCX files, attached", thread_id: "t", artifacts: [{ kind: "document", ref: "r1", filename: "Resume_Ramp.pdf", mime: "application/pdf" }], meta: {} }), { headers: { "content-type": "application/json" } })) as typeof fetch;
      try {
        const out: any = await chatThroughAgent("http://supabase.test", "k")({ userId: PERSON, threadId: null, message: "x", turnKey: "k1" });
        assert(Array.isArray(out.artifacts) && out.artifacts[0]?.ref === "r1", `the artifacts reach the channel: ${JSON.stringify(out)}`);
      } finally { globalThis.fetch = real; }
    });

    // Owner: PR #200 (career_erase_person deletes every channel_ table's rows). Trunk: the files outlive the erase.
    await t.step("erase: 'forget everything' + 'yes, erase it' removes every stored file", async () => {
      await say("forget everything");
      await say("yes, erase it");
      eq(await pg.sql(`select count(*) from public.channel_artifacts where user_id = '${PERSON}'`), "0", "no file is left");
    });
  } finally {
    handler.restore();
    await pg.stop();
  }
} });
