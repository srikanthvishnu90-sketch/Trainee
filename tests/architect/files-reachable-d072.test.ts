// D-072 (files reachable; architect, 2026-11-12, on the item 6b finding (PR #794): no production code called createFamily, so the
// record-backed File pages for F-01 to F-04, F-07, F-08 and F-12 to F-15 were served and tested but no person could reach them).
// Owner standard (behavior guide P5/P17, "complete product"): every File family the product defines is reachable from the chat when
// the person's ask calls for it, made from their real records, and a "made" claim needs a made File that opens (D-066 P6, D-067).
// $0: a scripted model, in-memory stores, the real File server; no network, nothing sent.
//   D72-1  THE TABLE: every served family has its creator (F-09 createReview, F-05/06/10/11 the results list, the other eleven
//          open_record_file) and the ask that calls for it; a control, an approval or an ordinary question is not a File ask.
//   D72-2  ROUTING: in staged mode each ask is the brain's (reason file_family_ask), which offers open_record_file; a control stays code's.
//   D72-3  EACH FAMILY FROM ITS ASK, through the real brain turn (agentTurn, the real tool, the real file service): the File is made,
//          the reply carries its link (code's, never the model's), the link opens through the real File server (signed link ->
//          sign-in page; the signed-in page 200), and the page holds every record the reply names.
//   D72-4  NOTHING ON RECORD: no File is made (never a hollow File); the reply says what is missing; a "made" claim without a made
//          File is unbacked (the loop's claim guard); unreadable records make nothing.
//   D72-5  APPROVALS STAY HASH-BOUND (D-MS-1, D-MN-2): on a File made from chat, F-12's Approve send and F-04's Approve plan are forms
//          bound to the payload hash shown; a stale or forged hash changes nothing.
//   D72-6  THE PROCESS CHECK: an ask for a File that the model answers without calling open_record_file is asked once to make it.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/files-reachable-d072.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { agentTurn, processCheck } from "../../supabase/functions/agent-chat/career_brain.ts";
import { FAMILY_BY_NAME, FAMILY_TITLE, familyAskOf, type FamilyMakeDeps, holdsOf, type MadeFamily, makeFamilyFile } from "../../supabase/functions/_shared/file_family_make.ts";
import { FAMILY_FILE_TOOL } from "../../supabase/functions/_shared/agent/file_family_tool.ts";
import { FILE_MAKERS, unbackedClaims } from "../../supabase/functions/_shared/agent/loop.ts";
import { SERVED_FAMILIES } from "../../supabase/functions/_shared/file_family_serve.ts";
import { FAMILIES } from "../../supabase/functions/_shared/file_family.ts";
import { recordsFamilies } from "../../supabase/functions/_shared/file_family_actions.ts";
import { memoryPlanMaterialStore, planMaterialRecords } from "../../supabase/functions/_shared/file_family_records_materials.ts";
import { messageRecords } from "../../supabase/functions/_shared/file_family_message.ts";
import { memoryOutreachStore, messageOf, type OutreachDraft, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";
import { FULL, NONE, NOW } from "./files-records-fixtures.ts";
import type { Records } from "../../supabase/functions/_shared/file_family_records.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", SECRET = "file-link-secret-d072-reachable-0123456789";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const env = { get: (k: string) => ENV[k] };
const FULL_U = "33333333-3333-4333-8333-333333333333", NONE_U = "44444444-4444-4444-8444-444444444444";
const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
  async save() { return "saved"; }, async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; },
  async wanted() { return false; } }) as unknown as FileStore;
const realFetch = globalThis.fetch;
// Nothing here may reach the network (a send would have to).
globalThis.fetch = () => Promise.reject(new Error("no network in the D-072 test: nothing is sent"));
addEventListener("unload", () => { globalThis.fetch = realFetch; });

// The ask each family is made from (the person's own words), and the records each page must hold.
export const ASKS: Record<MadeFamily, string> = {
  "F-01": "show me my career brief", "F-02": "show me my profile facts", "F-03": "open my path comparison", "F-04": "show me my search plan",
  "F-07": "open my materials page", "F-08": "what's in my answer library?", "F-12": "show me the message review", "F-13": "pull up my interview hub",
  "F-14": "send me my weekly brief", "F-14n": "show me my negotiation plan", "F-15": "show me my offer comparison",
};
const HOLDS: Record<Exclude<MadeFamily, "F-03">, string[]> = {
  "F-01": ["Analyst roles at Evercore", "No staffing agencies"],
  "F-02": ["BS Economics, Rutgers University", "No staffing agencies", "New York"],
  "F-04": ["Climate operations search", "US remote only"],
  "F-07": ["the operations resume, process work first", "the operations resume for R-07"],
  "F-08": ["Mobile", "Why Evercore?"],
  "F-12": ["Dana Lee", "Operations roles at Example Grid Co"],
  "F-13": ["Evercore", "Dana Park"],
  "F-14": ["1 search run", "1 application approved"],
  "F-14n": ["Evercore", "$110,000"],
  "F-15": ["$110,000", "$15,000"],
};

const DRAFT = { n: 1, recipient: { name: "Dana Lee", firm: "Example Grid Co", title: "Operations Manager", school: "", email: "dana.lee@examplegrid.com", source: "https://examplegrid.com/team", address: "published" as const },
  subject: "Operations roles at Example Grid Co", body: "Hi Dana,\n\nWould you have 15 minutes for a short call about the operations team?",
  footer: "Ada Park\n\nIf you'd rather not hear from me, reply stop and I won't write again.", shared: [], approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null };

// One world: the File service and the File server over the same stores, and the maker over the SAME family records the server reads.
async function world(o: { failRead?: boolean } = {}) {
  const A = signedIn(), store = memoryFileStore(), plans = memoryPlanMaterialStore(), outreach = memoryOutreachStore();
  await plans.addPlan(FULL_U, { version: 1, title: "Climate operations search", batch_cap: 12, created_at: "2026-11-10T14:00:00Z",
    hard: [{ k: "Work arrangement", v: "US remote only", src: { kind: "you", at: "2026-11-09T15:00:00Z" } }], prefs: [{ k: "Sector", v: "Grid, solar, carbon", src: { kind: "you" } }], watch: null });
  const doc = { doc_key: "operations-resume", doc_kind: "resume" as const, based_on: "master v6", role_job_id: "job-r07", rid: "R-07", format_check: "Dates, page flow, contact line verified" };
  await plans.addDoc(FULL_U, { ...doc, version: 2, label: "the operations resume for R-07", changes: [], created_at: "2026-11-09T12:00:00Z", file: null, approved_at: "2026-11-09T13:00:00Z", approved_role: "job-r07" });
  await plans.addDoc(FULL_U, { ...doc, version: 3, label: "the operations resume, process work first", changes: [], created_at: "2026-11-10T14:30:00Z", file: null });
  const draft = { ...DRAFT, status: "shown" as const, hash: "" } as unknown as OutreachDraft;
  draft.hash = await payloadHash(messageOf(draft));
  const [saved] = await outreach.saveBatch(FULL_U, null, [draft as never], NOW);
  const outbox: unknown[] = [];
  const rail = { drafts: (u: string, ids: string[]) => outreach.drafts!(u, ids),
    // deno-lint-ignore no-explicit-any
    rpc: (name: string, a: { p: any }) => name !== "career_send_enqueue" ? Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } })
      // deno-lint-ignore no-explicit-any
      : Promise.resolve({ data: a.p.items.map((x: any) => { outbox.push(x); return { source_id: x.source_id, status: "queued", id: `Q${outbox.length}` }; }), error: null }) };
  const PEOPLE: Record<string, Records> = { [FULL_U]: FULL, [NONE_U]: NONE };
  const records = {
    ...recordsFamilies({ now: () => NOW, read: async (u) => { if (o.failRead) throw new Error("records unreadable (test)"); return PEOPLE[u] ?? NONE; }, digest: { async setEnabled() {} } }),
    ...planMaterialRecords(plans, () => NOW),
    "F-12": messageRecords({ store: outreach as never, rail }),
  };
  const files = createFileService({ store, env, now: () => NOW });
  const maker: FamilyMakeDeps = { files, records, refs: {
    latestDoc: async (u) => (await plans.docs(u, "operations-resume")).length ? "operations-resume" : null,
    latestDraft: async (u) => u === FULL_U ? saved.id : null,
  } };
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env, cards: { async open() { throw new Error("no"); } } as never, tap: {} as never, files, familyRecords: records };
  const serve = (url: string, init: { sid?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { ...(init.sid ? { cookie: `tf_s=${init.sid}` } : {}), origin: new URL(BASE).origin, ...(init.headers ?? {}) }, body: init.body }), deps);
  // Open a File link the way the person does: the signed link answers (its sign-in page), then the signed-in page.
  const open = async (url: string) => {
    ok(url.startsWith(`${BASE}?t=`), `a File link minted by code: ${url}`);
    const t = await verifyFileToken(new URL(url).searchParams.get("t"), SECRET, NOW);
    if (!t.ok) throw new Error(`link token: ${t.why}`);
    const link = await serve(url);
    const sid = await A.tok(t.claims.u, t.claims.r, NOW);
    const page = await serve(BASE, { sid });
    return { link: link.status, status: page.status, html: await page.text(), sid, user: t.claims.u, id: t.claims.r };
  };
  return { maker, files, store, outbox, open, serve, plans, outreach, saved };
}

const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
// The scripted brain: it calls open_record_file with the family the ask names, then says what the File holds from the tool's own
// holds (as the tool tells it to), or what is missing. It never writes a link.
// deno-lint-ignore no-explicit-any
function brain(family: string | null) {
  const calls: string[] = [];
  // deno-lint-ignore no-explicit-any
  const model = async (p: any) => {
    if (!p.tools?.length) return text("");
    // deno-lint-ignore no-explicit-any
    const results = p.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "tool_result") : []);
    if (!results.length && family) { calls.push(family); return use(FAMILY_FILE_TOOL, { family }); }
    const last = results.at(-1);
    const body = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    if (last?.is_error) return text(`I couldn't make that File: ${body.replace(/^not made:\s*/, "")}.`);
    const r = JSON.parse(body);
    return text(`Your ${r.title} holds: ${r.holds.join("; ")}.`);
  };
  return { model, calls };
}
const turn = (message: string, w: Awaited<ReturnType<typeof world>>, model: unknown, userId = FULL_U) =>
  agentTurn({ message, history: [], stores: {}, userId, threadId: "th-d072", now: NOW, model, files: w.files, familyFiles: w.maker } as never);
const nameOf = (f: MadeFamily) => Object.entries(FAMILY_BY_NAME).find(([, v]) => v === f)![0];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const onPage = (html: string, s: string) => html.includes(s) || html.includes(esc(s)) || html.includes(s.replace(/'/g, "&#39;")) || html.includes(esc(s).replace(/'/g, "&#39;"));

// ---------------------------------------------------------------- D72-1
Deno.test("D72-1 THE TABLE: every served File family has its creator from the chat and the ask that calls for it", () => {
  const made = Object.values(FAMILY_BY_NAME).sort();
  // Every family the File server serves is made by exactly one path: F-09 by createReview, the eleven here by open_record_file.
  eq([...SERVED_FAMILIES].sort(), [...made, "F-09"].sort(), "served = made here + F-09");
  const src = (f: string) => Deno.readTextFileSync(new URL(`../../supabase/functions/${f}`, import.meta.url));
  ok(/files\.createReview!\(userId, item\)/.test(src("_shared/application_review_links.ts")), "F-09: application_review_links.ts calls createReview");
  ok(/familyFiles: supabaseFamilyMaker\(admin, createFileService\(/.test(src("agent-chat/handler-career.ts")), "agent-chat wires the maker into the brain");
  // The results-list families are the results page's own live views (file_family_live.ts), made by the search's results link.
  for (const f of ["F-05", "F-06", "F-10", "F-11"]) ok(FAMILIES[f as keyof typeof FAMILIES], f);
  ok(/F-05, F-06, F-10 and F-11 are served from the results list/.test(src("_shared/file_family_serve.ts")));
  for (const [f, ask] of Object.entries(ASKS)) eq(familyAskOf(ask), f, `${f}: "${ask}"`);
  // Other ways people ask.
  for (const [ask, f] of [["send me my career brief", "F-01"], ["give me the page with my profile", "F-02"], ["show me the search plan page", "F-04"], ["show me my answers page", "F-08"],
    ["show me my interviews page", "F-13"], ["my weekly brief", "F-14"], ["where's my weekly summary", "F-14"], ["give me a file comparing my offers", "F-15"], ["open the negotiation file", "F-14n"]] as const) eq(familyAskOf(ask), f, ask);
  // Not a File ask: a control, an approval, a question about the File, a new thing to write, a search.
  for (const ask of ["pause my weekly brief", "approve my search plan", "what is a career brief?", "how often does the weekly brief come", "make me an interview prep file for google",
    "draft a message to Dana and put it in a file", "compare my offers", "find me analyst jobs and put them in a file", "yes", "stop"]) eq(familyAskOf(ask), null, ask);
  ok(FILE_MAKERS.includes(FAMILY_FILE_TOOL), "a File claim is backed by open_record_file");
});

// ---------------------------------------------------------------- D72-2
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-d072", threadId: "t-d072", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
Deno.test("D72-2 ROUTING: each family ask is the brain's in staged mode (file_family_ask); a control, an approval and a bare reply stay code's", () => {
  const realError = console.error;
  console.error = () => {};
  try {
    for (const [f, ask] of Object.entries(ASKS)) {
      const d = stagedDecision({ env: STAGED, message: ask, ctx: fresh(), host, structured: false });
      ok(d.brain, `${f} "${ask}": ${d.reason} (${d.intent})`);
    }
    for (const ask of ["send me my weekly brief", "show me my offer comparison", "show me my profile facts"]) eq(stagedDecision({ env: STAGED, message: ask, ctx: fresh(), host, structured: false }).brain, true, ask);
    for (const ask of ["pause my weekly brief", "yes", "stop"]) {
      const d = stagedDecision({ env: STAGED, message: ask, ctx: fresh(), host, structured: false });
      ok(d.reason !== "file_family_ask", `${ask}: ${d.reason}`);
    }
    const src = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/career_staged.ts", import.meta.url));
    ok(/!NON_ENGLISH_KEPT\.test\(intent\) && !PAYLOAD_INTENTS\.has\(intent\) && familyAskOf\(o\.message\)\) return \{ brain: true, mode, intent, reason: "file_family_ask"/.test(src), "the route keeps payloads, approvals and controls code's");
  } finally { console.error = realError; }
});

// ---------------------------------------------------------------- D72-3
Deno.test("D72-3 EACH FAMILY FROM ITS ASK: made from the person's records, the reply carries its link, the link opens through the File server, the page holds what the reply says", async () => {
  const w = await world();
  const lines: string[] = [];
  for (const [f, ask] of Object.entries(ASKS) as [MadeFamily, string][]) {
    if (f === "F-03") continue; // no store of compared directions exists: D72-4
    const b = brain(nameOf(f));
    const r = await turn(ask, w, b.model);
    eq(b.calls, [nameOf(f)], `${f}: the brain called open_record_file once`);
    const call = r.tool_calls.find((c) => c.name === FAMILY_FILE_TOOL);
    ok(call?.ok, `${f}: made (${call?.error ?? ""})`);
    eq(r.fileLinks?.length, 1, `${f}: one File link rides the reply`);
    ok(!/https?:\/\//.test(r.reply), `${f}: the model wrote no link (${r.reply})`);
    for (const s of HOLDS[f]) ok(r.reply.includes(s), `${f}: the reply names "${s}": ${r.reply}`);
    const p = await w.open(r.fileLinks![0]);
    eq([p.link, p.status, p.user], [303, 200, FULL_U], `${f}: the signed link goes to its sign-in, and the signed-in page opens`);
    const rec = await w.store.get(FULL_U, p.id);
    eq([rec?.data?.family, rec?.data?.live, rec?.data?.from_code, "view" in (rec?.data ?? {})], [f, true, true, false], `${f}: a live File (records read on every open, no stored view)`);
    for (const s of HOLDS[f]) ok(onPage(p.html, s), `${f}: the page holds "${s}"`);
    ok(!/not available on this page yet/i.test(p.html), `${f}: no control shown off`);
    lines.push(`${f} ${FAMILY_TITLE[f]}: "${ask}" -> made, link 303 to its sign-in, page 200, holds ${HOLDS[f].length}/${HOLDS[f].length}`);
  }
  console.log(`FILES REACHABLE (D-072): ${lines.length}/10 families with records made from their ask\n  ${lines.join("\n  ")}`);
  eq(lines.length, 10);
});

// ---------------------------------------------------------------- D72-4
Deno.test("D72-4 NOTHING ON RECORD: no File is made, the reply says what is missing, a 'made' claim without a made File is unbacked; unreadable records make nothing", async () => {
  const w = await world();
  // F-01, F-02 and F-14 are drawn for everyone: what is not on record is named Unknown / "Not set yet" / a quiet week, never guessed
  // (file_family_records.ts). Each is made, and its page says so.
  const ALWAYS: Partial<Record<MadeFamily, string>> = { "F-01": "Not set yet", "F-02": "Unknown", "F-14": "Quiet week" };
  for (const [f, ask] of Object.entries(ASKS) as [MadeFamily, string][]) {
    const b = brain(nameOf(f));
    const r = await turn(ask, w, b.model, NONE_U);
    const call = r.tool_calls.find((c) => c.name === FAMILY_FILE_TOOL);
    if (ALWAYS[f]) {
      eq([call?.ok, r.fileLinks?.length], [true, 1], `${f}: made`);
      const p = await w.open(r.fileLinks![0]);
      ok(p.status === 200 && p.html.includes(ALWAYS[f]!), `${f}: the page says "${ALWAYS[f]}"`);
      ok(!/Analyst|Evercore|Rutgers/.test(p.html), `${f}: nothing of another person's records`);
      continue;
    }
    eq([call?.ok, r.fileLinks?.length ?? 0], [false, 0], `${f}: nothing made for a person with no records`);
    ok(/nothing on record|No .* (?:is )?on record/i.test(call?.error ?? ""), `${f}: the reason says nothing is on record: ${call?.error}`);
    ok(/couldn't make that File/.test(r.reply), `${f}: the reply says it was not made: ${r.reply}`);
  }
  // F-03: no store of compared directions exists anywhere yet (FILE-RECORDS.md), so even a person with records gets the honest answer.
  const p3 = await makeFamilyFile(w.maker, FULL_U, "path_comparison");
  eq([p3.ok, !p3.ok && p3.reason], [false, "nothing_on_record"], "F-03: never a hollow comparison");
  // The claim guard: a reply saying the File was made with no successful open_record_file is unbacked.
  const said = "I've made your weekly brief page.";
  ok(unbackedClaims(said, [{ name: FAMILY_FILE_TOOL, ok: false, effect: "write_own" } as never]).length > 0, "a refused call backs nothing");
  eq(unbackedClaims(said, [{ name: FAMILY_FILE_TOOL, ok: true, effect: "write_own" } as never]), [], "a made File backs the claim");
  // Unreadable records: nothing made, the reason says so; never a stored or partial view.
  const broken = await world({ failRead: true });
  const r = await makeFamilyFile(broken.maker, FULL_U, "weekly_brief");
  eq([r.ok, !r.ok && r.reason, broken.store.size()], [false, "unreadable", 0], "unreadable: nothing made");
  // An unknown family is refused by name.
  eq((await makeFamilyFile(w.maker, FULL_U, "everything")).ok, false);
});

// ---------------------------------------------------------------- D72-5
Deno.test("D72-5 APPROVALS STAY HASH-BOUND on a File made from chat: F-12 Approve send and F-04 Approve plan bind the payload hash shown; a stale or forged hash changes nothing", async () => {
  const w = await world();
  // F-12 from its ask.
  const r12 = await turn(ASKS["F-12"], w, brain("message_review").model);
  const p12 = await w.open(r12.fileLinks![0]);
  const shown = await payloadHash(messageOf((await w.outreach.drafts!(FULL_U, [w.saved.id]))[0]));
  ok(p12.html.includes(`name="action" value="approvesend"`) && p12.html.includes(`value="${shown}"`), "Approve send is a form carrying the shown words' hash");
  const forged = "0".repeat(64);
  const bad = await w.serve(BASE, await phonePost({ t: p12.sid, action: "approvesend", msg: w.saved.id, h: forged }, SECRET) as never);
  eq(bad.status, 409, "a forged hash is refused");
  eq([(await w.outreach.drafts!(FULL_U, [w.saved.id]))[0].status, w.outbox.length], ["shown", 0], "nothing approved, nothing queued");
  const good = await w.serve(BASE, await phonePost({ t: p12.sid, action: "approvesend", msg: w.saved.id, h: shown }, SECRET) as never);
  eq(good.status, 200, "the shown hash approves");
  const d = (await w.outreach.drafts!(FULL_U, [w.saved.id]))[0];
  eq([d.status, d.approved_hash, w.outbox.length], ["approved", shown, 1], "approved exactly the words shown, queued once, not sent");
  // F-04 from its ask: the plan form carries its hash; a stale one is refused.
  const r04 = await turn(ASKS["F-04"], w, brain("search_plan").model);
  const p04 = await w.open(r04.fileLinks![0]);
  const plan = (await w.plans.plans(FULL_U))[0];
  ok(p04.html.includes(`value="approveplan"`) && p04.html.includes(`value="${plan.payload_hash}"`), "Approve plan carries the plan's hash");
  const stale = await w.serve(BASE, await phonePost({ t: p04.sid, action: "approveplan", v: "1", h: forged }, SECRET) as never);
  eq([stale.status, (await w.plans.plans(FULL_U))[0].approved_at], [409, null], "a stale plan hash approves nothing");
});

// ---------------------------------------------------------------- D72-6
Deno.test("D72-6 THE PROCESS CHECK: an ask for a File answered without making it is asked once to make it; a made or refused call is not asked again", async () => {
  const check = processCheck({ draftAsk: false, planSearch: false, parts: [], familyFile: "F-14" })!;
  ok(/Call open_record_file now/.test(check("Your weekly brief shows one search.", []) ?? ""), "asked to make it");
  eq(check("x", [{ name: FAMILY_FILE_TOOL, ok: true }]), null);
  eq(check("x", [{ name: FAMILY_FILE_TOOL, ok: false, error: "not made: nothing on record" }]), null, "nothing on record: answered, not asked again");
  eq(processCheck({ draftAsk: false, planSearch: false, parts: [], familyFile: null }), null, "no File ask: no check");
  // Through the turn: the model first answers in prose; the check asks once; the File is made and its link rides the reply.
  const w = await world();
  let n = 0;
  // deno-lint-ignore no-explicit-any
  const model = async (p: any) => {
    if (!p.tools?.length) return text("");
    n++;
    if (n === 1) return text("You had a search and an approval this week.");
    // deno-lint-ignore no-explicit-any
    const res = p.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "tool_result") : []);
    if (!res.length) { ok(/Call open_record_file now/.test(p.system), "the review asks for the File"); return use(FAMILY_FILE_TOOL, { family: "weekly_brief" }); }
    return text(`Your Weekly brief holds: ${JSON.parse(res.at(-1).content).holds.join("; ")}.`);
  };
  const r = await turn("send me my weekly brief", w, model);
  eq([r.tool_calls.filter((c) => c.name === FAMILY_FILE_TOOL && c.ok).length, r.fileLinks?.length], [1, 1]);
  ok((await w.open(r.fileLinks![0])).html.includes("1 search run"));
  // holdsOf is the page's own view: the same lines for the same records.
  ok(holdsOf("F-15", { offers: [{ letter: "A", company: "Evercore", rows: [{ k: "Base salary", v: "$110,000" }] }], deadline: null })[0].includes("$110,000"));
});
