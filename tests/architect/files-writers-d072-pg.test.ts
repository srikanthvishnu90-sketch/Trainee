// D-072 (files writers), through the REAL agent-chat handler on Postgres 16 (handler-career.ts handleChat on tests/flow: real
// supabase-js over the PostgREST double, every migration), the staged brain served, and a scripted $0 model on the Anthropic wire.
// PR #798 made the F-03, F-04 and F-07 Files reachable but nothing in production wrote their rows. Here each writer fires from its
// own chat path, and the family File then opens, through the deployed File server's dependencies, with those rows:
//   F-04  "find me data analyst internships in Chicago" (the search path) writes search plan v1; the same search again writes
//         nothing; "watch for data analyst roles in Chicago" (the router's watch, then the alert settings) writes v2 with the watch.
//         The page's Approve plan is bound to v2's payload hash; approving it, then changing the search, writes v3 and v2 stays
//         approved (a version is never overwritten).
//   F-07  "make me a one-page resume PDF for data analyst internships" (the resume task) delivers a PDF and writes material v1
//         with the file itself; the same file again writes nothing; the page lists the version and its download returns the
//         exact bytes delivered.
//   F-03  "I'm weighing two paths ... compare them" routes to the brain, which saves the comparison with compare_paths (each path
//         in the person's own words; a path they did not write is refused); "open my path comparison" then makes the File with it.
// Prints: FILES WRITERS PG: ... Nothing is sent: fetch to any host but the database double and the model wire throws.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/files-writers-d072-pg.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { familyAskOf, FAMILY_BY_NAME } from "../../supabase/functions/_shared/file_family_make.ts";
import { FAMILY_FILE_TOOL } from "../../supabase/functions/_shared/agent/file_family_tool.ts";
import { PATH_TOOL } from "../../supabase/functions/_shared/agent/path_comparison_tool.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { fakePhone, sessionFor } from "./file-session-fakes.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../../", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const BASE = "https://trainee.example/file", SECRET = "TEST-d072-files-writers-link-secret-0123456789";
const ENVK: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeTestBot" };
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0731";
const COMPARE = "I'm weighing two paths: consulting at Deloitte or product management at a startup. Can you compare them for me?";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const onPage = (html: string, s: string) => html.includes(s) || html.includes(esc(s));

// The scripted brain: open_record_file for a File ask; compare_paths for the comparison (the paths quoted from the person's
// message, and once a path they never wrote, which must be refused); after a result it says only what the result holds.
// deno-lint-ignore no-explicit-any
function scripted(b: any, seen: { tools: string[]; refused: string[] }): Response {
  const done = (content: string) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
  const call = (name: string, args: unknown, id = "call_1") => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
  // deno-lint-ignore no-explicit-any
  const tools: string[] = (b.tools ?? []).map((t: any) => t.function?.name);
  if (!tools.length) return done("");
  seen.tools = tools;
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = b.messages ?? [];
  const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content ?? "");
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  const last = toolMsgs.at(-1);
  if (lastUser.includes("weighing two paths") && tools.includes(PATH_TOOL)) {
    // First a path the person never wrote (refused), then the two in their own words.
    if (!toolMsgs.length) return call(PATH_TOOL, { paths: [{ name: "Investment banking", said: "investment banking at Goldman" }, { name: "Product management", said: "product management at a startup" }] }, "call_0");
    if (toolMsgs.length === 1) { seen.refused.push(String(last.content ?? "")); return call(PATH_TOOL, { title: "Consulting vs product management", paths: [{ name: "Consulting at Deloitte", said: "consulting at Deloitte" }, { name: "Product management", said: "product management at a startup" }] }); }
    if (String(last.content).startsWith("ERROR:")) { seen.refused.push(String(last.content)); return done(`Not saved: ${String(last.content).slice(0, 200)}`); }
    const r = JSON.parse(String(last.content));
    return done(`I saved your comparison: ${r.directions.map((d: { letter: string; name: string; evidence: string }) => `${d.letter} ${d.name}, ${d.evidence}`).join("; ")}.`);
  }
  const fam = familyAskOf(lastUser);
  if (!last && fam && tools.includes(FAMILY_FILE_TOOL)) return call(FAMILY_FILE_TOOL, { family: Object.entries(FAMILY_BY_NAME).find(([, v]) => v === fam)![0] });
  if (last) {
    const c = String(last.content ?? "");
    if (c.startsWith("ERROR:")) return done(`I couldn't make that File: ${c.replace(/^ERROR:\s*(?:not made:\s*)?/, "")}.`);
    const r = JSON.parse(c);
    return done(`Your ${r.title} holds: ${(r.holds ?? []).join("; ")}.`);
  }
  return done("I can help with that.");
}

Deno.test({
  name: "FILES WRITERS PG: the search plan, material version and path comparison writers fire from their chat paths, and each family File opens with those rows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "MODEL_BUDGET_PAUSED",
      "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_SEND_RAIL", "CAREER_MAIL_TRACKING", ...Object.keys(ENVK)];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error, realLog = console.log;
    const errors: string[] = [];
    try {
      await supabaseParity(pg);
      const sql = (q: string) => pg.sql(q);
      await sql(`insert into auth.users (id, email) values ('${U}', '${U}@example.test'); insert into public.profiles (id) values ('${U}');
        insert into public.career_watch_kv (user_id, key, value) values ('${U}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      const now = new Date().toISOString();
      for (let n = 1; n <= 3; n++) await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, posted_at, first_seen_at, last_seen_at)
        values ('greenhouse:acme:${n}', 'greenhouse', 'acme', 'Acme ${n}', 'Data Analyst Intern', 'Chicago, IL', 'https://boards.greenhouse.io/acme/jobs/${n}', '${now}', '${now}', '${now}')`);
      h = await careerHandler(pg, { "d072-w": U });
      const viaDouble = globalThis.fetch, outbound: string[] = [], seen = { tools: [] as string[], refused: [] as string[] };
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as string, init);
        const u = new URL(req.url);
        // deno-lint-ignore no-explicit-any
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => scripted(b, seen));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = (...a: unknown[]) => { const s = a.map(String).join(" "); if (/search plan|materials|path comparison/i.test(s)) errors.push(s); };
      console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].startsWith("{\"evt\"")) return; realLog(...a); };
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      Deno.env.set("CAREER_MAIL_TRACKING", "off");
      for (const [k, v] of Object.entries(ENVK)) Deno.env.set(k, v);
      // deno-lint-ignore no-explicit-any
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      const env = { get: (k: string) => Deno.env.get(k) };
      const PHONE = "+15125550731";
      const deps = { ...buildFileDeps(admin, env, Date.now), phone: fakePhone({ [U]: PHONE }).auth };
      const sessions = supabaseSessionStore(admin);
      const linkOf = (body: unknown) => (JSON.stringify(body).match(/https:\/\/trainee\.example\/file\?t=[A-Za-z0-9._-]+/g) ?? [])[0] ?? null;
      const chat = h.chat("d072-w");
      const say = async (m: string) => { await sql(`delete from public.agent_rate_limits`); const r = await chat.say(m, { channel: "imessage" }); assertNode.equal(r.status, 200, `${m}: ${r.status} ${r.reply}`); return r; };
      // Opens the File the reply links, signed in as the person, through the deployed File server's dependencies.
      const open = async (r: { body: unknown; reply: string }, what: string) => {
        const link = linkOf(r.body);
        assertNode.ok(link, `${what}: a File link. Reply: ${r.reply.slice(0, 300)}`);
        const t = await verifyFileToken(new URL(link!).searchParams.get("t"), SECRET, Date.now());
        assertNode.ok(t.ok && t.claims.u === U, `${what}: the link is the person's`);
        const signIn = await handleFile(new Request(link!, { headers: { origin: new URL(BASE).origin } }), deps);
        const sid = await sessionFor(sessions, { userId: U, list: t.ok ? t.claims.r : [], now: Date.now(), phone: PHONE });
        const get = async (q = "") => await handleFile(new Request(`${BASE}${q}`, { headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin } }), deps);
        const page = await get();
        const html = await page.text();
        assertNode.equal(signIn.status, 303, `${what}: sign-in redirect`);
        assertNode.equal(page.status, 200, `${what}: page ${html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
        return { html, get };
      };
      const rows = async (q: string) => JSON.parse((await sql(`select coalesce(jsonb_agg(x), '[]') from (${q}) x`)).trim() || "[]");
      const sum: string[] = [];

      // The person's resume, confirmed in chat (the router's own intake), so the resume task and the comparison have a record.
      await say(`here is my resume:\n${RESUME}`);
      const yes = await say("yes, that's my resume");
      assertNode.equal(yes.intent, "career_resume_ingest", `resume confirmed: ${yes.reply}`);

      // ---------------------------------------------------------------- F-04: a search, then the same search, then a watch
      const s1 = await say("find me data analyst internships in Chicago");
      let plans = await rows(`select version, title, hard, watch, approved_at from public.career_search_plans where user_id = '${U}' order by version`);
      assertNode.equal(plans.length, 1, `the search wrote plan v1 (${s1.intent}: ${s1.reply.slice(0, 200)}); errors: ${errors.join(" | ")}`);
      // deno-lint-ignore no-explicit-any
      const hard1 = Object.fromEntries(plans[0].hard.map((e: any) => [e.k, e.v]));
      assertNode.ok(/data analyst/i.test(hard1.Role ?? "") && /Chicago/.test(hard1.Location ?? ""), `the plan holds the person's role and place: ${JSON.stringify(plans[0])}`);
      assertNode.ok(plans[0].hard.every((e: { src?: { kind?: string } }) => e.src?.kind === "you"), "every hard limit names the person as its source");
      await say("find me data analyst internships in Chicago");
      assertNode.equal((await rows(`select version from public.career_search_plans where user_id = '${U}'`)).length, 1, "the same search again writes no new version");
      const w = await say("Watch for data analyst roles in Chicago");
      plans = await rows(`select version, title, hard, watch, payload_hash, approved_at from public.career_search_plans where user_id = '${U}' order by version`);
      assertNode.equal(plans.length, 2, `the watch wrote plan v2 (${w.intent}: ${w.reply.slice(0, 200)})`);
      assertNode.ok(plans[1].watch?.active === true && /data analyst/.test(plans[1].watch.text), `v2 carries the watch as saved: ${JSON.stringify(plans[1].watch)}`);
      const p4 = await say("show me my search plan");
      const f4 = await open(p4, "F-04");
      for (const s of [`Search plan v2`, hard1.Role, "Watch: new roles"]) assertNode.ok(onPage(f4.html, s) || p4.reply.includes(s), `F-04 holds "${s}"`);
      assertNode.ok(p4.reply.includes("Search plan v2") && p4.reply.includes("not approved yet"), `the reply says what the page holds: ${p4.reply}`);
      assertNode.ok(f4.html.includes(plans[1].payload_hash), "the page's Approve plan carries v2's payload hash");
      assertNode.ok(!f4.html.includes(plans[0].payload_hash), "never v1's");
      assertNode.equal((await sql(`select public.career_search_plan_approve_as('${U}', 1, '${plans[0].payload_hash}', now())`)).trim(), "superseded", "v1 can no longer be approved");
      assertNode.equal((await sql(`select public.career_search_plan_approve_as('${U}', 2, '${plans[1].payload_hash}', now())`)).trim(), "approved", "v2 approved with its own hash");
      await say("find me data analyst internships in Chicago over $30 an hour");
      plans = await rows(`select version, hard, approved_at, approved_hash from public.career_search_plans where user_id = '${U}' order by version`);
      assertNode.equal(plans.length, 3, "a changed search writes v3");
      assertNode.ok(plans[1].approved_at && !plans[2].approved_at, "v2 stays approved as it was; v3 needs its own approval");
      assertNode.ok(plans[2].hard.some((e: { k: string; v: string }) => e.k === "Pay floor" && /\$30/.test(e.v)), `v3 holds the pay floor said: ${JSON.stringify(plans[2].hard)}`);
      sum.push(`F-04 plans ${plans.length} (search, watch, changed search; repeat wrote none), page v2 hash-bound`);

      // ---------------------------------------------------------------- F-07: a delivered resume, the same file again
      const m1 = await say("make me a one-page resume PDF for data analyst internships");
      let mats = await rows(`select doc_key, version, label, role_job_id, file_name, file_sha256, changes, encode(file_bytes, 'base64') as b64 from public.career_material_versions where user_id = '${U}' order by created_at`);
      assertNode.equal(mats.length, 1, `the delivered resume wrote one version (${m1.intent}: ${m1.reply.slice(0, 200)}); errors: ${errors.join(" | ")}`);
      const art = await rows(`select sha256, filename from public.channel_artifacts where user_id = '${U}' and filename like '%.pdf'`);
      assertNode.ok(art.some((a: { sha256: string; filename: string }) => a.sha256 === mats[0].file_sha256 && a.filename === mats[0].file_name), `the version's file is the file delivered: ${JSON.stringify(art)} vs ${mats[0].file_name}`);
      assertNode.ok(/resume for data analyst internships/i.test(mats[0].label), `labelled by its target: ${mats[0].label}`);
      await say("send me that resume PDF again");
      assertNode.equal((await rows(`select version from public.career_material_versions where user_id = '${U}'`)).length, 1, "the same file delivered again writes nothing");
      const p7 = await say("open my materials page");
      const f7 = await open(p7, "F-07");
      assertNode.ok(onPage(f7.html, mats[0].label) && p7.reply.includes(mats[0].label), `the materials page and reply list the version: ${p7.reply}`);
      const dl = await f7.get(`?download=${encodeURIComponent(mats[0].doc_key)}&v=1`);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
      assertNode.equal(dl.status, 200, "the version downloads");
      assertNode.equal(hex, mats[0].file_sha256, "the download is the exact file delivered");
      sum.push(`F-07 versions ${mats.length} (resend wrote none), download = delivered bytes`);

      // ---------------------------------------------------------------- F-03: compare paths in chat, then open the File
      const c1 = await say(COMPARE);
      const calls = (c1.body?.meta?.tool_calls ?? []) as { name: string; ok: boolean }[];
      assertNode.ok(seen.refused.some((x) => /own words/.test(x)), `a path the person never wrote is refused: ${seen.refused.join(" | ")}`);
      assertNode.ok(calls.some((x) => x.name === PATH_TOOL && x.ok), `the brain saved the comparison: ${JSON.stringify(calls)} ${c1.reply} ${seen.refused.join(' | ')}`);
      const cmp = await rows(`select version, title, directions, confirmed_facts from public.career_path_comparisons where user_id = '${U}'`);
      assertNode.equal(cmp.length, 1, "one comparison");
      assertNode.deepEqual(cmp[0].directions.map((d: { name: string; said: string }) => [d.name, d.said]), [["Consulting at Deloitte", "consulting at Deloitte"], ["Product management", "product management at a startup"]]);
      assertNode.ok(!JSON.stringify(cmp[0]).includes("Goldman"), "nothing of the refused path is stored");
      const p3 = await say("open my path comparison");
      const f3 = await open(p3, "F-03");
      for (const s of ["Consulting vs product management", "Consulting at Deloitte", "product management at a startup"]) assertNode.ok(onPage(f3.html, s), `F-03 page holds "${s}"`);
      assertNode.ok(p3.reply.includes("A: Consulting at Deloitte") && p3.reply.includes("B: Product management"), `the reply says what the page holds: ${p3.reply}`);
      assertNode.ok(!/odds|chance of|likely to get/i.test(f3.html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/Hiring odds are not predicted|predicts your odds/g, "")), "nothing predicted");
      sum.push(`F-03 comparisons ${cmp.length} (refused path not stored), page opens`);

      realLog(`FILES WRITERS PG: ${sum.join("; ")}; errors ${errors.length}`);
      // The search re-checks each posting it lists on its board (a read, GET boards-api.greenhouse.io); here it is refused like any
      // other host, and nothing else left: nothing was sent.
      assertNode.deepEqual(outbound.filter((x) => x !== "GET boards-api.greenhouse.io"), [], "no request left but the database double, the model wire and the posting checks (refused)");
      assertNode.deepEqual(errors, [], "no writer failed");
    } finally {
      console.error = realError;
      console.log = realLog;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
