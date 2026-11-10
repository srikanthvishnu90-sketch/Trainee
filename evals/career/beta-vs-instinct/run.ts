// BETA VS INSTINCT (2026-11-04): the 104 beta inputs (C01-C04 live, A1.1-A25.4 the offline simulation) through the REAL
// career turn path: supabase/functions/agent-chat/handler-career.ts handleChat, with the committed release config
// (release_config.ts: PRODUCTION_BRAIN "staged" because CAREER_BRAIN is unset; every RELEASE_FLAGS switch at its release
// value because none is set), on the flow harness's real Postgres 16 with every migration (tests/flow/handler.ts,
// tests/flow/pg.ts), as the architect tests run it (tests/architect/f13-staged-brain-handler.test.ts).
//
// NO PAID CALL. The model is a scripted stand-in answered in-process at the Anthropic URL (tests/architect/helpers/
// anthropic_wire.ts); the key the handler sees is a dummy string, so careerModelConfig has "a key" and the staged brain is
// reachable exactly as in production, but nothing leaves the process. Every other host is refused and recorded.
// Consequence, stated in every scorecard: a turn the staged brain answers carries the scripted text, so brain-reply
// QUALITY is not measured here; for those turns only routing (which layer decided), deliverable coverage (was a File tool
// even offered) and the code-checked guards are scored. Live-model reply quality is S3's job in the deploy workflow.
//
// Two account states per case (cases.json "states"): empty, and seeded by five real turns (resume confirmed, an offer on
// record, a counter draft held, then a three-role list shown last). One fresh person per case and state.
//
// Semantic criteria ("judge") are answered by Claude Haiku through the Claude CLI on the owner's subscription, never an
// API key: `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude -p --model haiku --output-format json --tools ""
// --strict-mcp-config`, prompt on stdin, cached by prompt hash. Without --judge they are reported NOT JUDGED.
//
//   TMPDIR=/tmp/bvi PGBIN=/opt/homebrew/opt/postgresql@16/bin deno run -A --no-check \
//     --import-map=tests/flow/supabase-npm.json evals/career/beta-vs-instinct/run.ts --label trunk [--judge] [--only C01,A1.2]
//   (TMPDIR: Postgres refuses a socket path over 103 bytes; macOS's default TMPDIR is too long.)
import process from "node:process";
import { pgBinDir, type Pg, startPg } from "../../../tests/flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../../../tests/flow/handler.ts";
import { anthropicWire } from "../../../tests/architect/helpers/anthropic_wire.ts";
import { CareerHost } from "../../../supabase/functions/_shared/career_host.js";
import { buckets, type Case, CLI_ARGS, cliEnv, type Crit, EFFECT_TABLES, IGNORE_KV, IGNORE_WRITE, type Rec, recDeliverable, recGuards, pageRoles, recPass, recScore, SCRIPTED, scoreDet, subscriptionGate, URLS } from "./score.ts";
import { verifySubscription } from "./opus.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../../..", import.meta.url).pathname;
const args = Deno.args;
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LABEL = arg("--label") ?? "local";
const JUDGE = args.includes("--judge");
const ONLY = arg("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const STATES = (arg("--states") ?? "empty,seeded").split(",") as ("empty" | "seeded")[];
const OUT = arg("--out") ?? `${HERE}results`;

const SPEC = JSON.parse(await Deno.readTextFile(`${HERE}cases.json`));
const CASES: Case[] = SPEC.cases;
// --adhoc "<text>": one extra unscored input (case X0), for looking at a route by hand; never part of a scorecard.
// "a || b || c" runs a and b first in the same thread (after), then c.
if (arg("--adhoc")) {
  const parts = arg("--adhoc")!.split("||").map((x) => x.trim());
  parts.slice(0, -1).forEach((t, i) => CASES.push({ id: `X${i + 1}`, feature: "C", input: t, criteria: [] }));
  CASES.push({ id: "X0", feature: "C", input: parts.at(-1)!, after: parts.slice(0, -1).map((_, i) => `X${i + 1}`), criteria: [] });
}
const byId = new Map(CASES.map((c) => [c.id, c]));

// ------------------------------------------------------------------------------------------------ the scripted model
type ModelCall = { tools: string[]; system: string; user: string };
let calls: ModelCall[] = [];
const scripted = (body: any): Response => {
  const msgs: any[] = body.messages ?? [];
  const system = String(msgs.find((m) => m.role === "system")?.content ?? "");
  const user = String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
  const tools = (body.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
  calls.push({ tools, system: system.slice(0, 160), user: user.slice(0, 160) });
  // A drafter (networking, counter, rewrite) gets a short draft shape; the brain gets the marker text. Never a tool call.
  const drafter = !tools.length && /\b(draft|email|subject line|write the message)\b/i.test(system);
  const content = drafter ? "Subject: A quick question\n\nHi there,\n\nScripted draft text.\n\nThanks" : SCRIPTED;
  return new Response(JSON.stringify({ id: "scripted", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
};
let outbound: string[] = [];
const fakeNet = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  const u = new URL(req.url);
  if (u.hostname === "api.anthropic.com") return anthropicWire(req, (b) => scripted(b));
  outbound.push(`${req.method} ${u.host}${u.pathname}`);
  throw new TypeError(`network refused in the beta benchmark: ${u.host}`);
};

// ------------------------------------------------------------------------------------------------ router trace
// The handler builds its host per request (handler-career.ts CareerHost.createCareerHost). Wrapped here, before the
// handler module loads, so every runTurn is timed and recorded; the turn's real ctx is the one createTurnCtx returned,
// every other ctx is a probe (the pool probe, career_pool_need.ts; the staged probe, career_staged.ts stagedDecision).
type RouterCall = { real: boolean; ms: number; intent: string | null; handler: string | null; contained: boolean; boundary: string | null; postings: number };
let trace: RouterCall[] = [];
const origCreate = (CareerHost as any).createCareerHost;
(CareerHost as any).createCareerHost = (deps: any) => {
  const host = origCreate(deps);
  let realCtx: unknown = null;
  const createTurnCtx = (o: any) => { const c = host.createTurnCtx(o); realCtx = c; return c; };
  const runTurn = (text: string, ctx: any) => {
    const t0 = performance.now();
    const before = Array.isArray(ctx?.containmentRecords) ? ctx.containmentRecords.length : 0;
    const r = host.runTurn(text, ctx);
    const recs = Array.isArray(ctx?.containmentRecords) ? ctx.containmentRecords.slice(before) : [];
    let n = 0; try { n = Array.isArray(ctx?.postings) ? ctx.postings.length : 0; } catch { n = 0; }
    trace.push({ real: ctx === realCtx, ms: performance.now() - t0, intent: r?.intent ?? null, handler: r?.handler ?? null, contained: !!r?.contained, boundary: recs.at(-1)?.boundary ?? null, postings: n });
    return r;
  };
  return { ...host, createTurnCtx, runTurn };
};

// ------------------------------------------------------------------------------------------------ the market (postings)
// 600 synthetic postings, the production pool's size (career_pool.js DEFAULT_LIMIT): the board the beta's account read.
// 14 customer-support roles in Chicago (enough for "ten"), 6 remote support roles, healthcare entry roles, and the rest
// across other families and cities. Fictional employers; every URL on a board host shape; nothing is fetched.
function market() {
  const rows: { key: string; board: string; company: string; title: string; location: string; url: string; desc: string; hours: number }[] = [];
  const add = (company: string, title: string, location: string, desc: string) => {
    const i = rows.length + 1, board = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
    rows.push({ key: `greenhouse:${board}:${i}`, board, company, title, location, url: `https://boards.greenhouse.io/${board}/jobs/${1000 + i}`, desc, hours: i % 240 });
  };
  const SUP = ["Lakeview Telecom", "Harbor Freight Lines", "Northwind Health", "Prairie Bank", "Loop Software", "Wicker Supply", "Midway Travel", "Fulton Foods", "Union Station Retail", "Pilsen Logistics", "Ravenswood Insurance", "Bridgeport Utilities", "Hyde Park Learning", "Lincoln Park Pets"];
  for (const c of SUP) add(`${c} (TEST)`, "Customer Support Specialist (Entry Level)", "Chicago, IL", "Entry-level customer support. Answer customer calls, chat and email. No degree required. Requirements: communication, patience, CRM tools.");
  for (const c of ["Cloudnine Apps", "Remotely Inc", "Async Works", "Homebase Help", "Anywhere Desk", "Distant Co"]) add(`${c} (TEST)`, "Remote Customer Support Associate", "Remote (US)", "Fully remote customer support associate. Ticket queue, chat. Entry level.");
  for (const [t, c] of [["Patient Access Representative", "Lakeshore Clinic"], ["Medical Receptionist", "Southside Health"], ["Unit Coordinator", "Mercy Lake Hospital"], ["Medical Records Clerk", "Northshore Medical"], ["Billing Specialist (Healthcare)", "Riverside Physicians"], ["Pharmacy Technician Trainee", "Elm Pharmacy"]]) add(`${c} (TEST)`, t, "Chicago, IL", `${t}. Entry level; training provided; certificate a plus.`);
  const FAM = ["Data Analyst", "Software Engineer Intern", "Marketing Coordinator", "Sales Development Representative", "Retail Store Associate", "Warehouse Associate", "Accounting Assistant", "Product Intern", "Registered Nurse", "Barista"];
  const CITIES = ["New York, NY", "Austin, TX", "Seattle, WA", "Denver, CO", "Boston, MA", "Atlanta, GA", "Chicago, IL", "Remote (US)"];
  let k = 0;
  while (rows.length < 600) { const f = FAM[k % FAM.length], city = CITIES[Math.floor(k / FAM.length) % CITIES.length]; add(`Synthco ${k + 1} (TEST)`, f, city, `${f}. Requirements: SQL, Excel, teamwork.`); k++; }
  return rows;
}
const esc = (s: string) => s.replaceAll("'", "''");

// ------------------------------------------------------------------------------------------------ account readings
let userTables: string[] = [];
async function counts(pg: Pg, id: string): Promise<Record<string, number>> {
  const parts = userTables.map((t) => `select '${t}' as t, count(*)::int as n from public.${t} where user_id = '${id}'`).join(" union all ");
  const rows = JSON.parse(await pg.sql(`select coalesce(json_object_agg(t, n), '{}') from (${parts}) x`));
  const kv = JSON.parse(await pg.sql(`select coalesce(json_object_agg(key, md5(value::text)), '{}') from public.career_watch_kv where user_id = '${id}'`));
  for (const [key, h] of Object.entries(kv)) rows[`kv:${key}`] = parseInt(String(h).slice(0, 7), 16);
  return rows;
}
// The person's facts, wherever the turn keeps them (account record, thread snapshots): every "facts" array found.
async function facts(pg: Pg, id: string): Promise<string> {
  const vals: any[] = JSON.parse(await pg.sql(`select coalesce(json_agg(value order by key), '[]') from public.career_watch_kv where user_id = '${id}'`));
  const snaps: any[] = JSON.parse(await pg.sql(`select coalesce(json_agg(to_jsonb(t) order by t.id), '[]') from public.agent_threads t where t.user_id = '${id}'`).catch(() => "[]"));
  const found: string[] = [];
  const walk = (v: any, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (k === "facts" && Array.isArray(x)) found.push(JSON.stringify(x.map((f: any) => [f?.kind, f?.text ?? f?.value ?? f?.label, f?.needs_confirmation, f?.status]).sort()));
      else walk(x, depth + 1);
    }
  };
  walk(vals); walk(snaps);
  return [...new Set(found)].sort().join("|");
}
// ------------------------------------------------------------------------------------------------ one turn
// A stored File as plain lines: its title, each section's heading, and every item as "label: value" (the shape of every
// File kind's data; file_kinds.ts).
function fileText(v: any): string {
  const d = v?.data ?? v ?? {};
  const L: string[] = [String(d.title ?? "")];
  const walk = (x: any, depth = 0) => {
    if (x == null || depth > 6) return;
    if (typeof x === "string") { L.push(x); return; }
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x === "object") {
      if (x.heading) L.push(`${x.heading}:`);
      if (x.label !== undefined || x.value !== undefined) { L.push(`${x.label ?? ""}: ${typeof x.value === "string" ? x.value : JSON.stringify(x.value ?? "")}`); return; }
      for (const [k, y] of Object.entries(x)) if (!["heading", "id", "kind", "variant", "source", "sources", "tag"].includes(k)) walk(y, depth + 1);
    }
  };
  walk(d.sections ?? d.items ?? d);
  return L.filter(Boolean).join("\n");
}

function layerOf(body: any, tr: RouterCall[]): { layer: string; handler: string } {
  const meta = body?.meta ?? {};
  if (meta.brain === "staged" || meta.brain === "agent") return { layer: "staged_brain", handler: `career_brain.ts agentTurn (router said ${meta.router_intent ?? "?"})` };
  const real = tr.filter((c) => c.real).at(-1);
  if (real && (real.intent ?? null) === (meta.intent ?? null)) {
    if (real.contained) return { layer: "containment", handler: `CareerContainment (boundary ${real.boundary ?? "?"})` };
    const overlay = meta.results_file ? " + search_judge/role_results" : "";
    return { layer: "router", handler: `${real.handler ?? "?"}:${real.intent}${overlay}` };
  }
  if (real && meta.intent == null && real.contained) return { layer: "containment", handler: `CareerContainment (boundary ${real.boundary ?? "?"})` };
  return { layer: "code_first", handler: `handler-career.ts code-first turn → ${meta.intent ?? "?"}` };
}

async function personFor(pg: Pg, id: string) {
  await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test') on conflict do nothing; insert into public.profiles (id) values ('${id}') on conflict do nothing;
    insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}') on conflict do nothing;`);
}

const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
export const SEED_TURNS = [
  `here is my resume:\n${RESUME}`,
  "yes, that's my resume",
  "I got an offer from Northwind Health for $24/hour as a Customer Support Specialist in Chicago",
  "Customer Support Specialist", // the offer turn asks for the title it did not read from the sentence above
  "draft a counter email asking for $27/hour",
  // The list is asked for with a digit: "find three entry-level customer support jobs in Chicago" finds nothing at this SHA (the
  // count and level words are read into the role text; see the failure map), and the digit is not honoured either (8 listed).
  "find 3 customer support jobs in Chicago",
];

// ------------------------------------------------------------------------------------------------ the judge (Claude CLI)
const cachePath = `${OUT}/judge-cache.json`;
let cache: Record<string, any> = {};
try { cache = JSON.parse(await Deno.readTextFile(cachePath)); } catch { cache = {}; }
async function sha(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join(""); }
export const JUDGE_PROMPT = `You are grading one reply from a career assistant against yes/no checks. Be strict and literal: answer yes only when the reply itself plainly does what the check asks. For every check give a short verbatim quote from the reply that is your evidence (copied exactly), or "" if the answer is no.
Return ONLY JSON: {"checks":[{"id":"<id>","pass":true|false,"quote":"<verbatim>"}]}`;
// --judge: the subscription gate runs once, before the first judge call; a run that is not on the subscription stops.
let judgeGated = false;
async function claudeJudge(prompt: string): Promise<any> {
  if (!judgeGated) {
    try { await subscriptionGate(verifySubscription); } catch (e) { console.error((e as Error).message); Deno.exit(3); }
    judgeGated = true;
  }
  const env = cliEnv(Deno.env.toObject());
  const p = new Deno.Command("claude", { args: CLI_ARGS("haiku"), stdin: "piped", stdout: "piped", stderr: "piped", env, clearEnv: true, cwd: "/tmp" }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(prompt)); await w.close();
  const o = await p.output();
  const out = JSON.parse(new TextDecoder().decode(o.stdout));
  const text = String(out.result ?? "");
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return j;
}
const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
async function judgeRec(r: Rec, cs: Case, crits: Crit[]) {
  const prompt = `${JUDGE_PROMPT}\n\nTHE PERSON SAID:\n${r.input}\n\nTHE REPLY:\n${r.reply}\n\nCHECKS:\n${crits.map((c) => `- ${c.id}: ${c.q}`).join("\n")}`;
  const key = await sha(prompt);
  if (!cache[key]) {
    // One attempt per prompt: a failure is recorded as no verdict, never retried in a loop.
    try { cache[key] = await claudeJudge(prompt); } catch (e) { cache[key] = { error: String((e as Error).message ?? e) }; }
  }
  const got = cache[key];
  for (const c of crits) {
    const g = (got?.checks ?? []).find((x: any) => x.id === c.id);
    if (!g) { r.criteria[c.id] = { pass: false, why: `judge gave no verdict${got?.error ? `: ${got.error}` : ""}`, kind: "judge" }; continue; }
    const quoted = !g.pass || (g.quote && norm(r.reply).includes(norm(String(g.quote))));
    r.criteria[c.id] = { pass: !!g.pass && !!quoted, why: g.pass ? (quoted ? `yes: "${String(g.quote).slice(0, 120)}"` : `yes, but the quote is not in the reply: "${String(g.quote).slice(0, 80)}"`) : "no", kind: "judge" };
  }
}

// ------------------------------------------------------------------------------------------------ main
if (!pgBinDir()) { console.error("needs Postgres 16 binaries (PGBIN)"); Deno.exit(2); }
const t0 = Date.now();
const pg = await startPg();
await supabaseParity(pg);
userTables = (await pg.sql(`select string_agg(table_name, ',' order by table_name) from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
  where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'`)).split(",").filter(Boolean);
const M = market();
await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
  ${M.map((p) => `('${p.key}', 'greenhouse', '${p.board}', '${esc(p.company)}', '${esc(p.title)}', '${esc(p.location)}', '${p.url}', '${esc(p.desc)}', now() - interval '${p.hours} hours', now())`).join(",")};
  insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, fetched_on, text_excerpt, content_hash) values
  ${M.map((p, i) => `('${p.key}', 'greenhouse', '${p.board}', '${esc(p.company)}', '${esc(p.title)}', '${esc(p.location)}', '${p.url}', now() - interval '${p.hours} hours', current_date, '${esc(p.desc)}', 'bvi${i}')`).join(",")};`);

// The production environment as the committed release serves it: no rollback set, no flag overridden.
for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_REPLY_WRITER", "CAREER_KNOWLEDGE", "CAREER_JUDGE", "UPMORE_CAREER_WORKER_URL", "UPMORE_CAREER_WORKER_SECRET"]) Deno.env.delete(k);
Deno.env.set("ANTHROPIC_API_KEY", "sk-scripted-not-a-key"); // answered in-process by the scripted model; never leaves the process
// File links as production configures them (file_link.ts feedUrlsFor): without a base URL and a signing secret every File
// is refused with "file links aren't set up", and no File could ever be measured. Test-only values; nothing is served.
Deno.env.set("TRAINEE_FILE_BASE_URL", "https://trainee.test/file");
Deno.env.set("TRAINEE_FILE_LINK_SECRET", "bvi-fixture-link-signing-value");
globalThis.fetch = fakeNet as typeof fetch;
const people: Record<string, string> = {};
const plan: { cs: Case; state: "empty" | "seeded"; id: string; token: string }[] = [];
let n = 0;
for (const state of STATES) for (const cs of CASES) {
  if (ONLY && !ONLY.includes(cs.id)) continue;
  n++;
  const id = `7b0f8f8e-6a43-4a49-9d2c-${String(n).padStart(12, "0")}`, token = `tok-bvi-${n}`;
  people[token] = id; plan.push({ cs, state, id, token });
}
const h = await careerHandler(pg, people);
const realErr = console.error, realLog = console.log;
const logs: string[] = [];
const recs: Rec[] = [];
for (const p of plan) {
  await personFor(pg, p.id);
  const chat: Chat = h.chat(p.token);
  const say = async (m: string) => { await pg.sql(`delete from public.agent_rate_limits where user_id = '${p.id}'`); return await chat.say(m, { channel: "telegram" }); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const setup: string[] = [];
  try {
    if (p.state === "seeded") for (const m of SEED_TURNS) { const r = await say(m); setup.push(`${r.intent}/${r.resultStatus}${r.body?.meta?.brain ? " (brain)" : ""}: ${r.reply.slice(0, 160).replaceAll("\n", " ")}`); }
    for (const a of p.cs.after ?? []) { const prior = byId.get(a)!; const r = await say(prior.input); setup.push(`after ${a}: ${r.intent}/${r.resultStatus}${r.body?.meta?.brain ? " (brain)" : ""}: ${r.reply.slice(0, 200).replaceAll("\n", " ")}`); }
    const before = await counts(pg, p.id), fBefore = await facts(pg, p.id);
    calls = []; trace = []; outbound = [];
    const cpu0 = process.cpuUsage(), w0 = performance.now();
    const r = await say(p.cs.input);
    const cpu = process.cpuUsage(cpu0), wall = performance.now() - w0;
    const after = await counts(pg, p.id), fAfter = await facts(pg, p.id);
    const writes: Record<string, [number, number]> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if ((before[k] ?? 0) !== (after[k] ?? 0)) writes[k] = [before[k] ?? 0, after[k] ?? 0];
    const body = r.body ?? {};
    // A File made this turn is scored on its content too: the store row (file_service.ts "tf:file:<id>") rendered as lines.
    const madeFiles = Object.keys(writes).filter((k) => k.startsWith("kv:tf:file:")).map((k) => k.slice(3));
    if (madeFiles.length) {
      const vals: any[] = JSON.parse(await pg.sql(`select coalesce(json_agg(value), '[]') from public.career_watch_kv where user_id = '${p.id}' and key in (${madeFiles.map((k) => `'${esc(k)}'`).join(",")})`));
      body.__fileText = vals.map(fileText).join("\n\n");
    }
    const meta = body.meta ?? {};
    const lay = layerOf(body, trace);
    const urls = [...new Set((r.reply.match(URLS) ?? []))];
    const docs = [...(body.artifacts ?? []), ...(body.documents ?? []), ...((body.result?.documents) ?? [])];
    const fileMeta = ["prep_file", "file", "results_file"].map((k) => meta[k]).filter(Boolean).map((f: any) => typeof f === "object" ? `${f.kind ?? "file"}:${f.title ?? f.id ?? ""}` : String(f));
    const files = [...docs.map((d: any) => d?.name ?? d?.title ?? d?.kind ?? "document"), ...urls.filter((u) => /\/file(\/|\?)/.test(u)), ...fileMeta];
    // Roles: postings the reply carries, posting links in it, or the role-results page's list (meta.results_file / apply_all_offer).
    let listed = 0;
    if (meta.results_file) {
      const v = await pg.sql(`select value::text from public.career_watch_kv where user_id = '${p.id}' and value::text like '%${esc(String(meta.results_file))}%' limit 1`).catch(() => "");
      try { const j = JSON.parse(v || "null"); const arr = j?.picked ?? j?.roles ?? j?.jobs ?? j?.items ?? j?.list ?? null; listed = Array.isArray(arr) ? arr.length : (v.match(/boards\.greenhouse\.io/g) ?? []).length; } catch { listed = (v.match(/boards\.greenhouse\.io/g) ?? []).length; }
      // The page's own list: "tg:list:<id>" is an array of refs, each row under "tg:job:<ref>" (score.ts pageRoles).
      const listV = JSON.parse(await pg.sql(`select coalesce((select value from public.career_watch_kv where user_id = '${p.id}' and key = 'tg:list:${esc(String(meta.results_file))}'), 'null'::jsonb)::text`).catch(() => "null"));
      const refs: string[] = Array.isArray(listV) ? listV.map(String) : [];
      const jobs: Record<string, unknown> = refs.length ? JSON.parse(await pg.sql(`select coalesce(json_object_agg(substr(key, 8), value), '{}') from public.career_watch_kv where user_id = '${p.id}' and key in (${refs.map((r) => `'tg:job:${esc(r)}'`).join(",")})`)) : {};
      const page = pageRoles(listV, jobs);
      listed = Math.max(listed, page.refs.length);
      if (page.rows.length) body.__fileText = [body.__fileText, `Results page:\n${page.rows.join("\n")}`].filter(Boolean).join("\n\n");
    }
    const roles = Math.max(Array.isArray(body.postings) ? body.postings.length : 0, urls.filter((u) => /greenhouse|lever|ashby|workday/.test(u)).length, listed, Array.isArray(meta.apply_all_offer?.jobs) ? meta.apply_all_offer.jobs.length : 0);
    const brainCall = calls.find((c) => c.tools.length);
    const rec: Rec = {
      case: p.cs.id, state: p.state, input: p.cs.input, status: r.status, reply: r.reply, intent: r.intent, result_status: r.resultStatus, contained: !!meta.contained,
      brain: meta.brain ?? null, router_intent: meta.router_intent ?? null, layer: lay.layer, handler: lay.handler,
      router_ms: Math.round(trace.reduce((s, c) => s + c.ms, 0)), router_calls: trace.length, turn_ms: Math.round(wall), cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
      model_calls: calls.length, brain_tools: brainCall?.tools ?? [], file_tool_offered: !!brainCall?.tools.some((t) => t === "create_file" || t === "attach_document"),
      files, roles, links: urls.length, file_words: body.__fileText ? body.__fileText.split(/\s+/).filter(Boolean).length : 0, writes, profile_changed: fBefore !== fAfter, outbound: [...outbound], meta_keys: Object.keys(meta), setup,
      criteria: {}, pass: null, bucket: [],
    };
    const applicable = p.cs.criteria.filter((c) => !c.when || c.when === p.state);
    if (!applicable.some((c) => c.k === "no_effect")) applicable.push({ id: "no_effect", k: "no_effect" });
    // Every criterion is scored by code; a judge criterion by its deterministic proxy (score.ts proxy) unless --judge.
    for (const c of applicable) { const s = scoreDet(c, rec, body); rec.criteria[c.id] = { ...s, kind: c.k === "judge" ? "judge-proxy" : c.k }; }
    const sem = applicable.filter((c) => c.k === "judge");
    if (sem.length && JUDGE && rec.layer !== "staged_brain") await judgeRec(rec, p.cs, sem);
    rec.pass = recPass(rec);
    rec.score = recScore(rec) ?? undefined;
    rec.delivered = recDeliverable(rec);
    rec.guards = recGuards(rec);
    rec.bucket = buckets(rec, p.cs);
    recs.push(rec);
  } finally { console.error = realErr; console.log = realLog; }
  Deno.stderr.writeSync(new TextEncoder().encode(`${p.cs.id}/${p.state}: ${recs.at(-1)?.layer} ${recs.at(-1)?.intent} ${recs.at(-1)?.pass}\n`));
}
await Deno.mkdir(OUT, { recursive: true });
if (JUDGE) await Deno.writeTextFile(cachePath, JSON.stringify(cache, null, 1));
h.restore();
await pg.stop();

// ------------------------------------------------------------------------------------------------ scorecard
const sha1 = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped" }).output()).stdout).trim();
// PRIMARY METRIC (task completion, strict): the share of prompts whose every requested deliverable was verifiably
// produced (score.ts recDeliverable true). An unverified record (the scripted brain answered, so its content cannot be
// measured) counts as NOT complete in the strict share and is reported on its own. Guards (no send, no write, no profile
// change) are reported separately. The Opus arm (opus.ts) is the quality metric.
type Tally = { cases: number; pass: number; fail: number; partial: number; crit: number; critPass: number; critUnmeasured: number; score: number; scored: number; brain: number; delivered: number; undelivered: number; unverified: number; guards: number; strict: number };
const tally = (rs: Rec[]): Tally => {
  const t: Tally = { cases: rs.length, pass: 0, fail: 0, partial: 0, crit: 0, critPass: 0, critUnmeasured: 0, score: 0, scored: 0, brain: 0, delivered: 0, undelivered: 0, unverified: 0, guards: 0, strict: 0 };
  for (const r of rs) {
    if (r.delivered === true) t.delivered++; else if (r.delivered === false) t.undelivered++; else t.unverified++;
    if (r.guards) t.guards++;
    if (typeof r.score === "number") { t.score += r.score; t.scored++; }
    if (r.layer === "staged_brain") t.brain++;
    if (r.pass === true) t.pass++; else if (r.pass === false) t.fail++; else t.partial++;
    for (const c of Object.values(r.criteria)) { if (c.pass === null) t.critUnmeasured++; else { t.crit++; if (c.pass) t.critPass++; } }
  }
  t.score = t.scored ? Math.round(1000 * t.score / t.scored) / 10 : 0;
  t.strict = t.cases ? Math.round(1000 * t.delivered / t.cases) / 10 : 0;
  return t;
};
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : "n/a";
const byState: Record<string, Tally> = {}, byFeature: Record<string, Record<string, Tally>> = {}, byBucket: Record<string, Record<string, number>> = {}, byLayer: Record<string, Record<string, number>> = {};
for (const s of STATES) {
  const rs = recs.filter((r) => r.state === s);
  byState[s] = tally(rs);
  for (const f of Object.keys(SPEC.features)) { const fr = rs.filter((r) => byId.get(r.case)!.feature === f); if (fr.length) (byFeature[f] ??= {})[s] = tally(fr); }
  for (const r of rs) { for (const b of r.bucket) (byBucket[b] ??= {})[s] = ((byBucket[b] ??= {})[s] ?? 0) + 1; (byLayer[r.layer] ??= {})[s] = ((byLayer[r.layer] ??= {})[s] ?? 0) + 1; }
}
// Trainee vs Instinct where an Instinct reference exists (C01-C04): the same criteria, Instinct's verdicts as the report recorded them.
const vsInstinct = CASES.filter((c) => c.instinct && (!ONLY || ONLY.includes(c.id))).map((c) => {
  const row: any = { case: c.id, title: c.title, instinct: { pass: Object.values(c.instinct.verdicts).every(Boolean), met: Object.values(c.instinct.verdicts).filter(Boolean).length, of: Object.keys(c.instinct.verdicts).length } };
  for (const s of STATES) {
    const r = recs.find((x) => x.case === c.id && x.state === s);
    if (!r) continue;
    const ids = Object.keys(c.instinct.verdicts);
    row[s] = { pass: r.pass, met: ids.filter((i) => r.criteria[i]?.pass === true).length, unmeasured: ids.filter((i) => r.criteria[i]?.pass === null).length, of: ids.length, layer: r.layer, intent: r.intent };
  }
  return row;
});
const summary = { label: LABEL, sha: sha1, at: new Date().toISOString(), judged: JUDGE, states: STATES, harness: "handler-career.ts handleChat on tests/flow Postgres 16; release config (staged brain, release flags); scripted model; 600-posting synthetic pool",
  caveat: "Semantic criteria are scored by deterministic proxies (score.ts proxy) unless --judge. Trainee's staged-brain turns carry scripted text: brain reply quality is NOT measured (routing, deliverable coverage and code-checked guards only). Live-model reply quality is S3's job in the deploy workflow. C01's exact live text is not in the report; its input is reconstructed. Instinct verdicts are the report's descriptions of prepared control outputs, not an independent observation.",
  overall: byState, layers: byLayer, buckets: byBucket, features: byFeature, vs_instinct: vsInstinct, seconds: Math.round((Date.now() - t0) / 1000) };
// Signed File-link tokens are minted with the fixture secret above; they are redacted from what is written all the same.
const redact = (t: string) => t.replace(/([?&]t=)[A-Za-z0-9._-]{20,}/g, "$1<redacted-fixture-token>");
await Deno.writeTextFile(`${OUT}/${LABEL}.json`, redact(JSON.stringify({ summary, records: recs }, null, 1)));
const md: string[] = [];
md.push(`# Beta vs Instinct scorecard: ${LABEL}`, "", `SHA \`${sha1}\` · ${summary.at} · judge ${JUDGE ? "Claude Haiku via CLI (subscription)" : "OFF (semantic criteria scored by deterministic proxies, score.ts proxy)"} · ${summary.seconds}s`, "", `> ${summary.caveat}`, "");
md.push("## Overall (primary metric: task completion, strict)", "", "Task completion = prompts whose every requested deliverable was verifiably produced, over all prompts. Unverified = the scripted brain answered, so the content cannot be measured here; it counts as not complete.", "", "| state | prompts | TASK COMPLETION (strict) | delivered | failed a deliverable | unverified (scripted brain) | guards held | criteria met (measured) | criteria unmeasured |", "|---|---|---|---|---|---|---|---|---|");
for (const s of STATES) { const t = byState[s]; md.push(`| ${s} | ${t.cases} | **${t.strict}%** | ${t.delivered} | ${t.undelivered} | ${t.unverified} | ${t.guards}/${t.cases} | ${t.critPass}/${t.crit} (${pct(t.critPass, t.crit)}) | ${t.critUnmeasured} |`); }
md.push("", "## Which layer decided", "", `| layer | ${STATES.join(" | ")} |`, `|---|${STATES.map(() => "---").join("|")}|`);
for (const [l, v] of Object.entries(byLayer)) md.push(`| ${l} | ${STATES.map((s) => v[s] ?? 0).join(" | ")} |`);
md.push("", "## Root-cause buckets (failed records; one record can be in several)", "", `| bucket | ${STATES.join(" | ")} |`, `|---|${STATES.map(() => "---").join("|")}|`);
for (const [b, v] of Object.entries(byBucket).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))) md.push(`| ${b} | ${STATES.map((s) => v[s] ?? 0).join(" | ")} |`);
md.push("", "## Trainee vs Instinct (C01-C04; Instinct = the report's prepared control outputs)", "", `| case | Instinct criteria met | ${STATES.map((s) => `Trainee ${s}`).join(" | ")} |`, `|---|---|${STATES.map(() => "---").join("|")}|`);
for (const v of vsInstinct) md.push(`| ${v.case} ${v.title} | ${v.instinct.met}/${v.instinct.of}${v.instinct.pass ? " (pass)" : ""} | ${STATES.map((s) => v[s] ? `${v[s].met}/${v[s].of}${v[s].unmeasured ? ` (+${v[s].unmeasured} unmeasured)` : ""} via ${v[s].layer} ${v[s].intent ?? ""}` : "-").join(" | ")} |`);
md.push("", "## Per feature", "", `| feature | ${STATES.map((s) => `${s} delivered/failed/unverified · criteria`).join(" | ")} |`, `|---|${STATES.map(() => "---").join("|")}|`);
for (const [f, v] of Object.entries(byFeature)) md.push(`| ${f} ${SPEC.features[f]} | ${STATES.map((s) => v[s] ? `${v[s].delivered}/${v[s].undelivered}/${v[s].unverified} · ${v[s].critPass}/${v[s].crit}` : "-").join(" | ")} |`);
md.push("", "## Records", "", "| case | state | layer | intent | delivered | guards | failed criteria | buckets | router ms | cpu ms |", "|---|---|---|---|---|---|---|---|---|---|");
for (const r of recs) md.push(`| ${r.case} | ${r.state} | ${r.layer} | ${r.intent ?? "-"} | ${r.delivered === null ? "unverified" : r.delivered} | ${r.guards ? "held" : "BROKEN"} | ${Object.entries(r.criteria).filter(([, c]) => c.pass === false).map(([k, c]) => `${k}: ${c.why}`).join("; ").replaceAll("|", "/").slice(0, 220)} | ${r.bucket.join(", ")} | ${r.router_ms} | ${r.cpu_ms} |`);
await Deno.writeTextFile(`${OUT}/${LABEL}.md`, redact(md.join("\n") + "\n"));
console.log(`wrote ${OUT}/${LABEL}.json and .md: ${STATES.map((s) => `${s} task completion ${byState[s].strict}% (${byState[s].delivered} delivered, ${byState[s].undelivered} failed, ${byState[s].unverified} unverified), guards ${byState[s].guards}/${byState[s].cases}, criteria ${byState[s].critPass}/${byState[s].crit}`).join("; ")}`);
Deno.exit(0);
