// FEATURE 4 (DIAGNOSIS 2.2): "tailor my resume for the X role at Y" on the live path (handleChat -> the router's career_tailor)
// now rewrites the selected bullets toward the posting, with every rewritten bullet gated by the truth audit, and returns the
// rewritten resume as a PDF with a "what changed and why" line. The model is a fake Anthropic endpoint (no spend): it returns
// one faithful rewrite and three that each invent something (a metric, an employer, a tool); only the faithful one may
// reach the PDF, and each refusal is recorded with its reason. With CAREER_TAILOR_REWRITE unset the turn is today's
// select-and-reorder output, and no model call is made.
import assertNode from "node:assert/strict";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = { "tok-a": "7b0f8f8e-6a43-4a49-9d2c-0000000004a1", "tok-b": "7b0f8f8e-6a43-4a49-9d2c-0000000004b2" };
const COMPANY = "Quillstone Analytics (TEST)", ROLE = "Data Analyst";
const POSTING = `${ROLE} at ${COMPANY}. You will build dashboards for internal users and automate reporting.
Requirements: Python, PostgreSQL and React; experience automating data pulls and reporting for internal users.`;
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });

// The fake Anthropic endpoint: answers the rewrite prompt by bullet id. The dashboard bullet is reworded faithfully (same
// facts, the posting's priority first); the others each gain one thing the record does not hold.
const calls: any[] = [];
function fakeModel(body: any): Response {
  calls.push(body);
  const user = body.messages.find((m: any) => m.role === "user");
  const ask = JSON.parse(typeof user.content === "string" ? user.content : user.content.map((c: any) => c.text ?? "").join(""));
  const out = ask.bullets.map((b: any) => {
    const t: string = b.text;
    if (/reporting dashboard/i.test(t)) return { id: b.id, text: "Built a Python and React reporting dashboard used by 200 internal users" };
    if (/weekly reporting time/i.test(t)) return { id: b.id, text: "Cut weekly reporting time by 75% by automating data pulls from PostgreSQL" };
    if (/Investing Club/i.test(t)) return { id: b.id, text: "Led TEST University Investing Club of 45 members at Goldman Sachs; organised a stock-pitch competition with 20 participants" };
    if (/^Coursework/i.test(t)) return { id: b.id, text: "Coursework: Data Structures, Algorithms, Databases in Tableau, Probability and Statistics, Corporate Finance" };
    return { id: b.id, text: t };
  });
  const content = JSON.stringify({ bullets: out });
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { headers: { "content-type": "application/json" } });
}

async function pdfOf(pg: Pg, body: any, person: string): Promise<string[]> {
  const ref = body.artifacts?.[0]?.ref;
  assert(ref, `a document rides the reply: ${JSON.stringify(body.artifacts)}`);
  const b64 = (await pg.sql(`select bytes_b64 from public.channel_artifacts where id = '${ref}' and user_id = '${person}'`)).trim();
  assert(b64.length > 100, "the stored artifact has bytes");
  return R.extractPdfLines(Buffer.from(b64, "base64")) as string[];
}

Deno.test({ name: "FEATURE 4: tailor my resume for the X role at Y -> bullets rewritten toward the posting, each audited, PDF returned", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const env = ["CAREER_TAILOR_REWRITE", "ANTHROPIC_API_KEY", "CAREER_MODEL"];
  const before = Object.fromEntries(env.map((k) => [k, Deno.env.get(k)]));
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const esc = (s: string) => s.replace(/'/g, "''");
    await pg.sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
      ('test:quillstone:1', 'greenhouse', 'quillstone', '${esc(COMPANY)}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/quillstone/jobs/1', now(), '${esc(POSTING)}', 'h1')`);
    handler = await careerHandler(pg, PEOPLE);
    // Model calls go to the fake endpoint; everything else to the Supabase double.
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request && !init ? input : new Request(input, init);
      if (new URL(req.url).host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
      return viaDouble(req);
    }) as typeof fetch;
    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-fake");
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    const onboard = async (c: Chat) => {
      const pasted = await say(c, `here is my resume:\n${RESUME}`);
      eq(pasted.intent, "career_resume_ingest", pasted.reply);
      const yes = await say(c, "yes, that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
    };

    await t.step("flag off: today's select-and-reorder resume, no model call", async () => {
      Deno.env.set("CAREER_TAILOR_REWRITE", "off"); // D-036: a release flag (on when unset); "off" is its rollback
      const chat = handler!.chat("tok-b");
      await onboard(chat);
      const n = calls.length;
      const r = await say(chat, `tailor my resume for the ${ROLE} role at ${COMPANY}`);
      console.log("FLAG OFF:", r.intent, r.resultStatus, r.reply, JSON.stringify(r.body.artifacts ?? null));
      eq(r.intent, "career_tailor", r.reply);
      // The GitHub link in the pasted resume used to stage an empty posting, and the tailor cut the resume against it
      // ("tailored for null at null"); the named posting is the one tailored against now.
      assert(r.reply.includes(`${ROLE} at ${COMPANY}`) && !/null at null/.test(r.reply), r.reply);
      eq(calls.length, n, "no model call with the flag off");
      assert(!/Reworded/i.test(r.reply), r.reply);
    });

    const chat = handler.chat("tok-a");
    await t.step("flag on: the faithful rewrite reaches the PDF; the invented metric, employer and tool are each refused with a reason", async () => {
      Deno.env.set("CAREER_TAILOR_REWRITE", "on");
      await onboard(chat);
      const n = calls.length;
      const r = await say(chat, `tailor my resume for the ${ROLE} role at ${COMPANY}`);
      console.log("FLAG ON:", r.intent, r.resultStatus, r.reply, JSON.stringify(r.body.artifacts ?? null), JSON.stringify(r.body.meta));
      eq(r.intent, "career_tailor", r.reply);
      eq(calls.length, n + 1, "one model call rewrites the selected bullets");
      eq(calls.at(-1).model, "claude-sonnet-5-5");
      const lines = (await pdfOf(pg, r.body, PEOPLE["tok-a"])).join("\n");
      assert(lines.includes("Built a Python and React reporting dashboard used by 200 internal users"), `the faithful rewrite is in the PDF:\n${lines}`);
      assert(!lines.includes("Built a reporting dashboard in React and Python used by 200 internal users"), "the original wording of the rewritten bullet is replaced");
      assert(lines.includes("Cut weekly reporting time by 40% by automating data pulls from PostgreSQL"), `the invented metric is refused and the original kept:\n${lines}`);
      for (const bad of ["75%", "Goldman", "Tableau"]) assert(!lines.includes(bad), `${bad} never reaches the PDF:\n${lines}`);
      assert(/Reworded 1 bullet/i.test(r.reply), `the changelog says what changed: ${r.reply}`);
      assert(/75%/.test(r.reply) && /Goldman/.test(r.reply), `the changelog names why each was kept as written: ${r.reply}`);
      const rw = r.body.meta?.tailor_rewrite;
      assert(rw, "the rewrite record rides the reply meta");
      eq(rw.accepted.length, 1, JSON.stringify(rw));
      const reasons = rw.rejected.map((x: any) => `${x.before} => ${x.reasons.join("; ")}`).join("\n");
      assert(/number "75%?"/.test(reasons), reasons);
      assert(/Goldman/.test(reasons), reasons);
      assert(/Tableau/.test(reasons), reasons);
      const cost = await pg.sql(`select calls || ':' || array_to_string(models, ',') from public.agent_turn_costs where user_id = '${PEOPLE["tok-a"]}' order by id desc limit 1`);
      assert(/^1:claude-sonnet-5-5/.test(cost.trim()), `metered: ${cost}`);
    });

    await t.step("other phrasings reach the same rewrite", async () => {
      for (const ask of [`can you tailor my resume to the ${ROLE} job at ${COMPANY}?`, `tailor my resume for ${COMPANY}`]) {
        const n = calls.length;
        const r = await say(chat, ask);
        eq(r.intent, "career_tailor", `${ask}: ${r.reply}`);
        eq(calls.length, n + 1, `${ask}: one model call`);
        assert((await pdfOf(pg, r.body, PEOPLE["tok-a"])).join("\n").includes("Built a Python and React reporting dashboard"), ask);
      }
    });

    await t.step("the model is down: the select-and-reorder PDF still comes back, and the reply says nothing was reworded", async () => {
      Deno.env.set("ANTHROPIC_API_KEY", "");
      const r = await say(chat, `tailor my resume for the ${ROLE} role at ${COMPANY}`);
      eq(r.intent, "career_tailor", r.reply);
      const lines = (await pdfOf(pg, r.body, PEOPLE["tok-a"])).join("\n");
      assert(lines.includes("Built a reporting dashboard in React and Python used by 200 internal users"), lines);
      assert(/not reworded|no bullet was reworded/i.test(r.reply), r.reply);
    });
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    handler?.restore();
    await pg.stop();
  }
} });
// SERVICE_KEY / SUPABASE_URL are re-exported by the harness for tests that act as the channel; unused here.
void SERVICE_KEY; void SUPABASE_URL;
