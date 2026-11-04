// FEATURE 14 (D-024; BACKEND-GAP-MAP G6): every application has a receipt the person can see. One application through
// the person's own stack on a real Postgres (CI's migration order) and a real browser, the employer a page on 127.0.0.1
// served here, then read back in chat at the production handler (handleChat) over the same database:
//   prepare  approve-first.ts prepare() -> scripts/apply.ts dry run -> career_apply_prepare_own
//   approve  career_apply_card_open_own, career_apply_card_answer_own   (the person's own tap)
//   drive    career_apply_claim_own -> runApproved() -> scripts/apply.ts --submit --approved <hash>
//   pictures career_apply_receipt_attach_own                             (the proof's two pictures, under the lease)
//   record   career_apply_finish_own -> the receipt the database writes (career_apply_receipts, ..._files)
//   read     handleChat: "show me the receipt for TEST Acme", "what did you send to TEST Acme?", ...: the exact answers
//            with their facts, where, when, the hashes, the employer's words, and both pictures attached through
//            channel_artifacts; "where do I stand with TEST Acme" links to it; another person sees none of it.
// The facts are a synthetic test person's own statements (name and email), each with its source. Nothing reaches a real
// site; the model is never called (every turn here is code's).
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { engineRunner, ownQueue, prepare, runApproved } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const sha256hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try {
    Deno.statSync(`${ROOT}/tools/node_modules/playwright`);
    Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`);
    return true;
  } catch {
    return false;
  }
}

const PERSON = "7b0f8f8e-6a43-4a49-9d2c-000000001401", OTHER = "7b0f8f8e-6a43-4a49-9d2c-000000001402";
const COMPANY = "TEST Acme";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-receipt-test" };
const FACTS = (url: string) => ({
  user_id: PERSON,
  posting: { url, company: COMPANY },
  answers: {
    first_name: { value: "Rae", factId: "RECEIPT-TEST-FACT-1", ...SOURCE },
    last_name: { value: "Ceipt", factId: "RECEIPT-TEST-FACT-2", ...SOURCE },
    email: { value: "rae.ceipt@example.test", factId: "RECEIPT-TEST-FACT-3", ...SOURCE },
  },
});

function employer() {
  let posts = 0;
  const form = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>${COMPANY}</p><form method="post" action="/apply/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (req.method === "POST") {
      await req.formData();
      posts++;
      return new Response(`<h1>Thank you for applying to ${COMPANY}</h1><p>Application received. Confirmation number: ACME-RCPT-7.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (new URL(req.url).pathname === "/apply") return new Response(form, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  return { base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, posts: () => posts, close: () => server.shutdown() };
}

Deno.test({
  name: "FEATURE 14: one application's receipt, written at the finish with its pictures, read back in chat by its owner only",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the receipt flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-receipt-" });
    let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      for (const id of [PERSON, OTHER]) {
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(id, "%PDF-1.4\n% synthetic receipt-test resume\n%%EOF\n")}`);
      }
      const url = `${site.base}/apply`;
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify(FACTS(url)));
      await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic receipt-test resume\n%%EOF\n"));
      const resumeSha = await sha256hex(await Deno.readFile(resumePath));
      const person = pg.asPerson(PERSON);
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const account = (await person.rpc("career_apply_account_own")).data;

      let jobId = "", evidencePath = "", proof: any = null;
      await t.step("prepare, the person's tap, the drive: the pictures go up under the lease and the finish writes the receipt", async () => {
        const r = await prepare({ url, factsPath, resumePath, account, now: Date.now(), runEngine });
        assert(r.ready, `not ready: ${JSON.stringify((r as any).result)}`);
        eq((r as any).payload.company, COMPANY);
        const saved = await person.rpc("career_apply_prepare_own", { p_payload: (r as any).payload, p_card_lines: (r as any).card });
        eq(saved.error, null);
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [saved.data.id] });
        const tap = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        eq(tap.error, null, JSON.stringify(tap));
        const queue = ownQueue(person);
        const attached: string[] = [];
        const done = await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          attach: async (job, kind, sha, b64) => { attached.push(kind); return await queue.attach(job.id, job.lease_token, kind, sha, b64); },
          resumeFor: async (job) => ({ path: resumePath, sha256: job.payload.resume_sha256 }),
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-facts.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
        eq(done.length, 1);
        eq(site.posts(), 1, "exactly one POST reached the employer's page");
        eq(attached, ["before-click", "after-submit", "page-text"], "both pictures of the proof and the page's text were sent, under the lease, before the finish");
        const row = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}'`));
        eq(row.state, "submitted_unconfirmed");
        jobId = row.id; evidencePath = row.evidence.evidence_path; proof = row.evidence.proof;
        assert(proof?.before_click && proof?.after_submit, `the row keeps the bound proof: ${JSON.stringify(row.evidence)}`);
        for (const v of ["Rae", "Ceipt", "rae.ceipt@example.test", "Thank you"]) assert(!JSON.stringify(row.evidence).includes(v), `the row's evidence holds no answer and no page text (G6): ${v}`);
        const rc = JSON.parse(await pg.sql(`select row_to_json(r) from public.career_apply_receipts r where application_id = '${jobId}'`) || "null");
        assert(rc, "the finish wrote the receipt");
        eq([rc.user_id, rc.company, rc.url, rc.state, rc.reached_employer], [PERSON, COMPANY, url, "submitted_unconfirmed", "yes"]);
        eq(rc.answers.map((a: any) => [a.name, a.answer, a.fact_id]), [
          ["first_name", "Rae", "RECEIPT-TEST-FACT-1"], ["last_name", "Ceipt", "RECEIPT-TEST-FACT-2"], ["email", "rae.ceipt@example.test", "RECEIPT-TEST-FACT-3"]]);
        eq(rc.resume_sha256, resumeSha, "the resume file's hash");
        eq([rc.payload_hash, rc.approval_hash, rc.engine_approval], [row.payload_hash, row.approval_hash, row.payload.engine_approval]);
        eq(rc.confirmation_id, row.confirmation_id);
        assert(/ACME-RCPT-7/.test(rc.confirmation_text ?? ""), `the employer's page text after the click: ${rc.confirmation_text}`);
        assert(rc.clicked_at && Date.parse(rc.clicked_at) === proof.click.at, "the click's own time");
        eq(rc.final_url, proof.final_url);
        // The pictures kept are the proof's own, byte for byte the files the engine took on this computer.
        const files = JSON.parse(await pg.sql(`select json_agg(json_build_object('kind', kind, 'sha256', sha256, 'bound', bound, 'b64', bytes_b64) order by kind desc) from public.career_apply_receipt_files where application_id = '${jobId}'`));
        eq(files.map((f: any) => [f.kind, f.bound]), [["before-click", true], ["after-submit", true]], "the pictures kept; the page text moved onto the receipt");
        for (const [f, key] of [[files[0], "before_click"], [files[1], "after_submit"]] as const) {
          eq(f.sha256, proof[key].sha256);
          eq(await sha256hex(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))), await sha256hex(await Deno.readFile(`${evidencePath}/${proof[key].file}`)));
        }
      });

      handler = await careerHandler(pg, { "tok-a": PERSON, "tok-b": OTHER });
      const say = async (_token: string, chat: Chat, message: string) => { const r = await chat.say(message); eq(r.status, 200, r.reply); return r; };
      const mine = handler.chat("tok-a");

      for (const ask of ["show me the receipt for TEST Acme", "What did you send to TEST Acme?", "can I see the proof for my TEST Acme application", "what answers did you send to TEST Acme"]) {
        await t.step(`chat: "${ask}" -> the exact answers with their facts, where, when, the hashes, and both pictures`, async () => {
          const r = await say("tok-a", mine, ask);
          eq(r.intent, "career_apply_receipt", r.reply);
          for (const w of [/^Receipt for your application to TEST Acme: TEST Acme: submitted on \w+ \d+; TEST Acme has not confirmed it yet/, /Where: http:\/\/127\.0\.0\.1:\d+\/apply/,
            /When: approved .* UTC; Submit clicked .* UTC; recorded .* UTC\./, /What was sent:\n- First name: Rae \(from fact RECEIPT-TEST-FACT-1, owner stated \(TEST person, synthetic\)\)\n- Last name: Ceipt \(from fact RECEIPT-TEST-FACT-2/,
            /- Email: rae\.ceipt@example\.test \(from fact RECEIPT-TEST-FACT-3/, new RegExp(`Resume: the file with sha256 ${resumeSha.slice(0, 12)}`),
            /What their page said after Submit: ".*ACME-RCPT-7/, /Approval: payload [0-9a-f]{12}…, approval [0-9a-f]{12}…/, /Pictures attached: the page just before Submit was clicked and the page after it\. They are kept until/]) {
            assert(w.test(r.reply), `${w}\n${r.reply}`);
          }
          const arts = r.body.artifacts ?? [];
          eq(arts.map((a: any) => [a.kind, a.mime, a.filename]), [["document", "image/png", "receipt-test-acme-before-click.png"], ["document", "image/png", "receipt-test-acme-after-submit.png"]]);
          // Each attachment is the owner's, in this thread, and its bytes are the proof's picture.
          for (const [a, key] of [[arts[0], "before_click"], [arts[1], "after_submit"]] as const) {
            const st = JSON.parse(await pg.sql(`select row_to_json(x) from (select user_id, thread_id, bytes_b64 from public.channel_artifacts where id = '${a.ref}') x`));
            eq([st.user_id, st.thread_id], [PERSON, r.body.thread_id]);
            eq(await sha256hex(Uint8Array.from(atob(st.bytes_b64), (c) => c.charCodeAt(0))), proof[key].sha256);
          }
          assert(!/I've (sent|submitted)|has been submitted successfully/.test(r.reply), "nothing new is claimed");
        });
      }

      await t.step("status links to the receipt; nothing is sent or changed by any of it", async () => {
        const st = await say("tok-a", mine, "where do I stand with TEST Acme?");
        eq(st.intent, "career_apply_status", st.reply);
        assert(/Receipt on record: ask "show me the receipt for TEST Acme" to see exactly what was sent, with the pictures\./.test(st.reply), st.reply);
        const all = await say("tok-a", mine, "where are my applications?");
        assert(/Receipts on record for: TEST Acme\./.test(all.reply), all.reply);
        const list = await say("tok-a", mine, "show me my receipts");
        assert(/^Your application receipts, newest first:\n- TEST Acme: submitted/.test(list.reply), list.reply);
        const none = await say("tok-a", mine, "show me the receipt for Globex");
        assert(/^No receipt for Globex is on record/.test(none.reply) && /Receipts on record: TEST Acme\./.test(none.reply), none.reply);
        eq(site.posts(), 1, "nothing more reached the employer");
        eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "1");
      });

      await t.step("another person never sees, finds or is told of this receipt", async () => {
        const other = handler!.chat("tok-b");
        for (const ask of ["show me the receipt for TEST Acme", "what did you send to TEST Acme?", "show me my receipts"]) {
          const r = await say("tok-b", other, ask);
          eq(r.intent, "career_apply_receipt", r.reply);
          assert(!/Rae|Ceipt|ACME-RCPT|Pictures attached|Receipts on record/.test(r.reply), r.reply);
          eq(r.body.artifacts ?? [], [], "no picture is attached");
        }
        eq(await pg.sql(`select count(*) from public.channel_artifacts where user_id = '${OTHER}'`), "0");
      });
    } finally {
      handler?.restore();
      await site.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
