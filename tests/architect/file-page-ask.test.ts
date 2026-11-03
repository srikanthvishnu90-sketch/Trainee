// "Can you show me a File page for getting started with job applications? Do not apply or submit anything." (Telegram, live).
// The router read the words as a job search for the role "file page getting started applications do submit anything", found
// nothing and answered "Nothing to show yet" with no page. A File page ask that states no role and no limit is not a search:
// stagedDecision gives it to the brain (reason file_page_ask), which can make the page (create_file) and cannot apply. Real
// searches, with or without the words "File page", stay on code's path. Memory stores, a fake clock, no network, no database.
//   deno test -A --no-check tests/architect/file-page-ask.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { filePageAsk, stagedDecision, STAGED_WITHHELD_TOOLS } from "../../supabase/functions/agent-chat/career_staged.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ASK = "Can you show me a File page for getting started with job applications? Do not apply or submit anything.";
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const U = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-03T15:00:00Z");
const ENV = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE } as Record<string, string | undefined>;

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-fp", threadId: "t-fp", now: Date.UTC(2026, 10, 3, 15), snapshot: null, accountPersistence: true });
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const STAGED = env({ CAREER_BRAIN: "staged" });
const decide = (m: string) => stagedDecision({ env: STAGED, message: m, ctx: fresh(), host, structured: false });

Deno.test("FP-1 the Telegram File page ask goes to the brain, not to an empty job search", () => {
  const d = decide(ASK);
  eq([d.brain, d.reason], [true, "file_page_ask"], `${d.reason}`);
  // The router still reads it as a search; that reading is what the brain now overrides, and what it would have said.
  const r = host.runTurn(ASK, fresh());
  assert(/Nothing to show yet/.test(r.reply), "the empty-list fallback is what the router alone answers");
});

Deno.test("FP-2 real job searches are unchanged: roles, places and limits keep code's path, with or without 'File page'", () => {
  for (const m of ["find data analyst jobs in Chicago", "I want frontend internships that pay $30/hr", "show me a File page of data analyst jobs in Chicago",
    "show me a File page of data analyst jobs", "show me remote software engineer jobs on a File page", "find me new grad roles at Stripe"]) {
    const d = decide(m);
    assert(d.reason !== "file_page_ask", `${m}: ${d.reason}`);
  }
  eq(decide("find data analyst jobs in Chicago").brain, false);
});

Deno.test("FP-3 filePageAsk reads the ask's own words only", () => {
  assert(filePageAsk(ASK, { role: "file page getting started applications do submit anything", place: null, remote: false, limits: {} }));
  assert(!filePageAsk(ASK, { role: "file page getting started", place: "Chicago", remote: false, limits: {} }), "a place is a search");
  assert(!filePageAsk(ASK, { role: "file page getting started", place: null, remote: true, limits: {} }), "remote is a search");
  assert(!filePageAsk(ASK, { role: "file page", place: null, remote: false, limits: { pay: { amount: 30, period: "hour" } } }), "a pay floor is a search");
  assert(!filePageAsk("find data analyst jobs", { role: "data analyst", place: null, remote: false, limits: {} }), "no File page, no change");
  assert(!filePageAsk("show me a File page of data analyst jobs", { role: "file page data analyst", place: null, remote: false, limits: {} }), "a named role is a search");
  assert(!filePageAsk(ASK, { role: "file page getting started", place: null, remote: false, limits: { bands: ["intern"] } }), "a level is a search");
});

// ---- the page itself: the brain's create_file, the link minted by code, the link opening, nothing applied
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
const GETTING_STARTED = {
  title: "Getting started with job applications", variant: "pipeline", period: "Nothing sent yet",
  sections: [
    { heading: "Where you are", items: [{ label: "Request", value: "You asked for a page for getting started and said not to apply or submit anything.", source: "From you" }] },
    { heading: "Before anything is sent", items: [
      { label: "Resume", value: "Paste or attach your resume in the chat and confirm it. Nothing is sent before it is confirmed.", source: "From you" },
      { label: "Approval", value: "You see each application and say yes to it first.", source: "From you" }] },
  ],
};

Deno.test("FP-4 a usable signed File link returns for the ask and opens; nothing is applied or submitted", async () => {
  // The brain's tools for this turn: create_file only matters here; the staged policy withholds the tools that apply.
  assert(STAGED_WITHHELD_TOOLS.includes("queue_applications"), "the brain cannot queue an application");
  const store = memoryFileStore(), at = { t: NOW };
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => at.t });
  let i = 0;
  const script = [use("create_file", { kind: "plan_review", data: GETTING_STARTED }), text("Here is your getting-started page. Nothing was applied or submitted.")];
  const r = await runAgentTurn({ system: "s", message: ASK, history: [], tools: [createFileTool(svc)], ctx: { userId: U, threadId: "th", now: NOW, state: {} }, model: async () => script[Math.min(i++, script.length - 1)] });
  assert(r.tool_calls.every((c) => c.ok), JSON.stringify(r.tool_calls));
  const links = (r as any).fileLinks as string[];
  eq(links.length, 1);
  assert(links[0].startsWith(`${BASE}?t=v1.`), `a signed link on the configured base: ${links[0]}`);
  eq(store.size(), 1);

  // Open it: the link reaches the sign-in (a link alone proves nothing, file_link.ts), and the signed-in session shows the page.
  const A = signedIn();
  const calls = { want: 0, save: 0, open: 0 };
  const fs: FileStore = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { calls.save++; return "saved"; },
    async prepared() { return null; }, async want() { calls.want++; return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } };
  const deps: FileDeps = { ...A.deps, store: fs, now: () => at.t, env: { get: (k) => ENV[k] }, cards: { async open() { calls.open++; throw new Error("no"); } }, tap: {} as never, files: svc };
  const opened = await handleFile(new Request(links[0]), deps);
  // A link opens a phone sign-in and nothing private (file_link.ts): it redirects to the sign-in, which answers 200.
  eq(opened.status, 303, "the link is accepted and sent to the sign-in");
  const where = opened.headers.get("location") ?? "";
  console.log("link redirect:", where.replace(/t=[^&]+/, "t=<token>"));
  const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
  const signin = await handleFile(new Request(new URL(where, "https://x.example/f"), { headers: cookie ? { cookie } : {} }), deps);
  eq(signin.status, 200, "the sign-in page opens");
  assert(!/Getting started with job applications/.test(await signin.text()), "the sign-in shows nothing private");
  const id = store.all()[0].id;
  const page = await handleFile(new Request(`https://x.example/f`, { headers: { cookie: `tf_s=${await A.tok(U, id, NOW)}` } }), deps);
  eq(page.status, 200);
  const html = await page.text();
  assert(/Getting started with job applications/.test(html), "the page shows the getting-started file");
  eq(calls, { want: 0, save: 0, open: 0 }, "no application was queued, saved or opened");
});
