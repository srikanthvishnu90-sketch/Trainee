// BETA C03 / A15.1 (2026-11-04): "Make a one-page interview prep File with five questions and a 30-minute plan" makes a File.
// Before: the router answered with the night-before template or the interview brief and no File existed (no prep route had an
// artifact path; the staged brain never sees an instruction-shaped prep turn). Now the router builds the page in code
// (result.file) and the agent-chat step (career_prep_file.ts) stores it with the File service, mints the signed link and sends
// it after the summary. This runs the deployed bundle (router_core.career.js), the real host, the real File service over a memory
// store, and the real File page handler: the link opens the page, and the page is one page with no image and no company invented.
// The staged-brain classification keeps the turn on code's path. Memory stores, a fake clock, no network, no model, no database.
//   deno test -A --no-check tests/architect/prep-file.test.ts
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { codeProduct, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { prepFileTurn } from "../../supabase/functions/agent-chat/career_prep_file.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const C03 = "I have a customer support interview tomorrow. Make a one-page interview prep File with five questions and a 30-minute plan. No external actions and no changes to my profile.";
const A15_1 = "Make a one-page interview prep File with five questions and a 30-minute plan";
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const U = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-04T22:20:00Z");
const ENV = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE } as Record<string, string | undefined>;

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: U, threadId: "t-prep", now: NOW, snapshot: null, accountPersistence: true });
const env = (o: Record<string, string | undefined>) => ({ get: (k: string) => o[k] });
const questionsOf = (data: any) => data.sections.find((s: any) => /practice questions?$/.test(s.heading)).items;
const planMinutes = (data: any) => data.sections.find((s: any) => /-minute plan$/.test(s.heading)).items.map((i: any) => Number(i.label.match(/\((\d+) min\)$/)[1]));

// The handler's two steps for one turn: the router (host.runTurn), then the prep File step, exactly as handler-career.ts runs them.
async function chat(message: string, files: ReturnType<typeof createFileService> | null) {
  const out = host.runTurn(message, fresh());
  const pf = await prepFileTurn({ out, userId: U, files });
  return { routed: out, out: pf ? pf.out : out, meta: pf?.meta ?? null };
}

Deno.test("PF-1 C03 verbatim: a File is created with 5 questions and a 30-minute plan, its link is in the reply, and it opens", async () => {
  const store = memoryFileStore(), at = { t: NOW };
  const svc = createFileService({ store, env: env(ENV), now: () => at.t });
  const { out, meta } = await chat(C03, svc);
  eq(store.size(), 1, "exactly one File was stored");
  const rec = store.all()[0];
  eq([rec.userId, rec.kind, rec.data.variant], [U, "plan_review", "interview_prep"]);
  eq(questionsOf(rec.data).length, 5, "five questions");
  eq(planMinutes(rec.data).reduce((a: number, b: number) => a + b, 0), 30, "a plan of exactly 30 minutes");
  eq(rec.expires_at - rec.created_at, 168 * 3600_000, "the same lifetime as every File");
  // The reply: the summary, then the signed link alone as its own message.
  const parts = out.parts as string[];
  eq(parts.length, 2);
  assert(/^Your one-page interview prep File: 5 questions and a 30-minute plan\./.test(parts[0]), parts[0]);
  assert(parts[1].startsWith(`${BASE}?t=v1.`) && !/\s/.test(parts[1]), `the link alone: ${parts[1]}`);
  assert(out.reply.includes(parts[1]), "the link is in the reply");
  eq((meta as any).prep_file.id, rec.id);

  // Open it: the link goes to the phone sign-in (it alone proves nothing), and a signed-in session shows the page.
  const A = signedIn();
  const fs: FileStore = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; },
    async prepared() { return null; }, async applied() { return false; }, async want() { throw new Error("nothing is queued from a prep File"); }, async appRow() { return null; }, async wanted() { return false; } };
  const deps: FileDeps = { ...A.deps, store: fs, now: () => at.t, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc };
  const opened = await handleFile(new Request(parts[1]), deps);
  eq(opened.status, 303, "the link is accepted and sent to the sign-in");
  const page = await handleFile(new Request(`https://x.example/f`, { headers: { cookie: `tf_s=${await A.tok(U, rec.id, NOW)}` } }), deps);
  eq(page.status, 200);
  const html = await page.text();
  assert(html.includes("Interview prep: 5 questions, 30 minutes"), "the page shows the File");
  for (const q of questionsOf(rec.data)) assert(html.includes(q.value.replace(/'/g, "&#39;")), `question on the page: ${q.value}`);
  assert(/Made by Trainee/.test(html) && /From you/.test(html), "every line carries its source");
  const main = html.slice(html.indexOf('<div id="root">'));
  assert(!/<img\b/i.test(main), "no image on the File");
  // One page: the File's plain-text twin (every line, label and source) fits a printed page.
  const twin = textOf(rec, { now: NOW });
  assert(twin.length <= 3400 && twin.split("\n").length <= 50, `one page: ${twin.length} chars, ${twin.split("\n").length} lines`);
});

Deno.test("PF-2 counts and lengths are honored exactly (3 questions / 15 minutes; 8 / 45) and nothing about a company is invented", async () => {
  for (const [m, n, min] of [["Make a one-page interview prep File with three questions and a 15-minute plan", 3, 15], ["Create an interview prep page with 8 questions and a 45 minute plan", 8, 45]] as const) {
    const store = memoryFileStore();
    const { out } = await chat(m, createFileService({ store, env: env(ENV), now: () => NOW }));
    const rec = store.all()[0];
    eq(questionsOf(rec.data).length, n, m);
    eq(planMinutes(rec.data).reduce((a: number, b: number) => a + b, 0), min, m);
    assert(new RegExp(`${n} questions and a ${min}-minute plan`).test(out.reply), out.reply);
    const companyGap = rec.data.sections.find((s: any) => /^Not on file/.test(s.heading)).items.find((i: any) => i.label === "Company");
    eq(companyGap.value, "You didn't name it, so nothing here is about a specific company.");
    const html = bodyHtml(rec, "tok");
    assert(!/company file|hiring bar|culture|interview process at/i.test(html), "no company facts");
  }
});

Deno.test("PF-3 the File cannot be made (links not set up): nothing claims a File, the reply says so and gives the page as text", async () => {
  const store = memoryFileStore();
  const { out, meta } = await chat(A15_1, createFileService({ store, env: env({}), now: () => NOW }));
  eq(store.size(), 0, "no File was stored");
  eq(out.parts, undefined);
  assert(!/https?:\/\//.test(out.reply), "no link is claimed");
  assert(/I couldn't make the File page itself \(File links aren't set up on this service yet\), so no File was created\./.test(out.reply), out.reply);
  assert(!/^Your one-page interview prep File/.test(out.reply), "the summary does not call it a File");
  assert(/Question 5: /.test(out.reply) && /Minute 0 to 3 \(3 min\)/.test(out.reply), "the questions and the plan are in the reply");
  assert((meta as any).prep_file_error, "the failure is on the turn's meta");
});

Deno.test("PF-4 staged brain: a File-producing prep turn stays with code, asked as an instruction or as a question", () => {
  const STAGED = env({ CAREER_BRAIN: "staged" });
  for (const m of [C03, A15_1, "Could you make me a one-page interview prep File with 5 questions?", "Is it possible to make me a one page interview prep file with 3 questions and a 20 minute plan?"]) {
    const d = stagedDecision({ env: STAGED, message: m, ctx: fresh(), host, structured: false });
    eq(d.brain, false, `${m}: ${d.reason}`);
    eq(d.intent, "prep_brief", m);
  }
  assert(codeProduct("career_guidance", { file: { kind: "plan_review", data: {} } }), "a File is a code product whatever the intent");
});

Deno.test("PF-5 'Made by Trainee' is code's label only: the model's create_file cannot use it, the trusted path can", async () => {
  const data = host.runTurn(A15_1, fresh()).result.file.data;
  assert(validateKind("plan_review", data, { trusted: true }).ok, "code-built data validates");
  const asModel = validateKind("plan_review", data);
  assert(!asModel.ok && /Made by Trainee|source is missing/.test(JSON.stringify(asModel)), "refused without trust");
  const store = memoryFileStore(), svc = createFileService({ store, env: env(ENV), now: () => NOW });
  const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const use = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
  const script = [use("create_file", { kind: "plan_review", data }), text("Here it is.")];
  let i = 0;
  const r = await runAgentTurn({ system: "s", message: A15_1, history: [], tools: [createFileTool(svc)], ctx: { userId: U, threadId: "th", now: NOW, state: {} }, model: async () => script[Math.min(i++, script.length - 1)] });
  assert(r.tool_calls.every((c: any) => !c.ok), "the model's create_file with code's label is refused");
  eq(store.size(), 0);
});

// The page the link opens, as served (handleFile with a signed-in session), for the render check below.
async function servedPage(message: string): Promise<string> {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: env(ENV), now: () => NOW });
  await chat(message, svc);
  const rec = store.all()[0];
  const A = signedIn();
  const fs: FileStore = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; },
    async prepared() { return null; }, async applied() { return false; }, async want() { throw new Error("no"); }, async appRow() { return null; }, async wanted() { return false; } };
  const deps: FileDeps = { ...A.deps, store: fs, now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc };
  const page = await handleFile(new Request(`https://x.example/f`, { headers: { cookie: `tf_s=${await A.tok(U, rec.id, NOW)}` } }), deps);
  eq(page.status, 200);
  return await page.text();
}
function playwright(): any {
  const req = createRequire(import.meta.url);
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${root}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}

Deno.test({
  name: "PF-6 the prep File page at 360 px in Chromium: no sideways scroll, no image, 44 px taps, every question and plan block visible, short",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pw = playwright();
    if (!pw) {
      if (Deno.env.get("CI") === "true") throw Error("the 360 px render check needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
    try {
      for (const [message, n, min] of [[C03, 5, 30], ["Create an interview prep page with 8 questions and a 45 minute plan", 8, 45]] as const) {
        const html = await servedPage(message);
        for (const scheme of ["light", "dark"] as const) {
          const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
          await ctx.route("**/*", (r: any) => r.abort());
          const pg = await ctx.newPage();
          await pg.setContent(html, { waitUntil: "load" });
          const m = await pg.evaluate(`(() => {
            const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
            const root = document.getElementById("root") || document.body;
            const wide = [...root.querySelectorAll("*")].filter(visible).filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).map((el) => el.tagName + "." + el.className);
            return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, height: document.documentElement.scrollHeight,
              imgs: root.querySelectorAll("img,picture,svg image").length, wide,
              taps: [...document.querySelectorAll("a[href],button,summary,input:not([type=hidden])")].filter(visible).map((el) => ({ el: el.tagName + " " + (el.textContent || "").trim().slice(0, 30), h: el.getBoundingClientRect().height })),
              text: root.innerText };
          })()`) as any;
          const tag = `${n}q/${min}m ${scheme}`;
          assert(m.scrollW <= m.innerW, `${tag}: scrolls sideways (${m.scrollW} > ${m.innerW})`);
          eq(m.wide, [], `${tag}: nothing past the right edge`);
          eq(m.imgs, 0, `${tag}: no image on the File`);
          eq(m.taps.filter((x: any) => x.h < 44), [], `${tag}: every tap target 44 px or more`);
          for (let i = 1; i <= n; i++) assert(m.text.includes(`Question ${i}`), `${tag}: question ${i} shown`);
          assert(!m.text.includes(`Question ${n + 1}`), `${tag}: no extra question`);
          assert(new RegExp(`Your ${min}-minute plan`).test(m.text) && m.text.includes(`to ${min} (`), `${tag}: the plan ends at minute ${min}`);
          // Concise: the C03 page (5 questions), including the File header and footer, stays within three phone screens at 360 px
          // (measured 2351 px on 2026-11-04; Instinct's control File for the same ask was a long scroll with a large illustration).
          if (n === 5) assert(m.height <= 780 * 3.1, `${tag}: page is ${m.height}px tall at 360 px`);
          console.log(`${tag}: ${m.height}px tall at 360 px`);
          if (Deno.env.get("PF_SHOTS")) await pg.screenshot({ path: `${Deno.env.get("PF_SHOTS")}/prep-${n}q-${scheme}-360.png`, fullPage: true });
          await ctx.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
});
