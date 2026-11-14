// MIRROR, one conversation (architect builder, 2026-11-11). The 1,000-prompt runner (run-trainee.ts) gives every prompt a
// fresh person; a real benchmark like the owner's WhatsApp batch (evals/mirror/instinct-wa-batch1/) is ONE person texting
// many asks in a row, where later turns lean on earlier ones ("that referral draft from earlier"). This sends a whole
// conversation through the same real handler and world, in order, on one person and one thread.
//
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/run-conversation.ts --dry-run --conv <file> [--persona <file>] [--out file]
//   MIRROR_SPEND_APPROVED=D-057 deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/run-conversation.ts --live --budget-usd <cap> --conv <file> --persona <file> --out <file>
//
// --conv: JSON, an array of {id, prompt} (extra fields ignored), sent in order. --persona: JSON {setup: string[]}: turns sent
// first, not scored (how the person's resume and facts got into the account, the way a real person gives them). Neither
// file needs to be in the repository: a benchmark that carries the owner's own facts is kept outside it and read by path.
// Same guards as run-trainee.ts: --live refuses without MIRROR_SPEND_APPROVED, ANTHROPIC_API_KEY and --budget-usd, meters
// usage at the D-038 claude-sonnet-5-5 price and stops at the cap; every host but the model and the database double is
// refused and recorded, so nothing can be submitted or sent. Each line: {id, reply, actions, route, intent, status, ms, usd}.
import { anthropicWire } from "../../tests/architect/helpers/anthropic_wire.ts";
import { openWorld } from "../../tests/architect/helpers/response_world.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON, releaseFlagOn, releaseValue } from "../../supabase/functions/agent-chat/release_config.ts";
import { FILE_ENV } from "./heldout/harness.ts";
import { worldFetch, worldGmail, worldSql } from "./instinct-wa-batch1/world.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "../../tests/architect/file-session-fakes.ts";
import { fetchArtifactBytes } from "../../supabase/functions/_shared/channel_artifacts.ts";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import * as zlib from "node:zlib";
import * as nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";

const realFetch = globalThis.fetch;
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const dry = a.includes("--dry-run"), live = a.includes("--live");
const convPath = opt("--conv");
if (dry === live || !convPath) { console.log("usage: run-conversation.ts --dry-run | --live --budget-usd <cap>  --conv <file> [--persona <file>] [--out file]"); Deno.exit(2); }
const budget = Number(opt("--budget-usd") ?? 0);
if (live) {
  if (!/^D-\d{3}[a-z]?$/.test(Deno.env.get("MIRROR_SPEND_APPROVED") ?? "")) { console.log("refused: --live needs MIRROR_SPEND_APPROVED=<the DECISIONS.md line of the owner's written spend approval>"); Deno.exit(3); }
  if (!Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }
  if (!(budget > 0)) { console.log("refused: --live needs --budget-usd <cap>"); Deno.exit(3); }
}
type ConvTurn = { id: string; prompt: string };
// A .jsonl file (one turn per line) or a JSON array.
const convText = await Deno.readTextFile(convPath);
const turns: ConvTurn[] = (convPath.endsWith(".jsonl") ? convText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(convText))
  .map((t: any) => ({ id: String(t.id), prompt: String(t.prompt) }));
const persona: { setup: string[] } = opt("--persona") ? JSON.parse(await Deno.readTextFile(opt("--persona")!)) : { setup: [] };
const out = opt("--out") ?? new URL(`./results/conversation-${dry ? "dry" : "live"}.jsonl`, import.meta.url).pathname;
const promptLog = opt("--prompt-log"); // dry run only: where to write the system prompt each model call saw (debugging)

let modelCalls = 0, spent = 0, label = "", webSearches = 0;
// The tool trace (P5, the process check): per model call, the tools offered and whether it was a web search or a JSON call.
let calls: { tools: string[]; web: boolean; json: boolean }[] = [];
const modelErrors = new Map<number, string>();
const prompts: string[] = [];
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.5 / 1e6 };
// Replay (live-10 diagnosis, $0): --replay <file> gives, per turn id, the tool calls a live run made ({name, args}) and the reply text
// to give after them (the model's draft). A dry run then plays them through the real handler, and answers the support judge's calls
// per --judge: "stub" (the mirror suite's word stub, tests/architect/helpers/mirror_stub_judge.ts) or "yes" (yes to every claim, so
// what is still removed is removed by code, not the judge).
const replay: Record<string, { calls: { name: string; args: Record<string, unknown> }[]; reply: string }> | null = opt("--replay") ? JSON.parse(await Deno.readTextFile(opt("--replay")!)) : null;
const judgeMode = opt("--judge") ?? "stub";
const { mirrorJudgeAnswer } = await import("../../tests/architect/helpers/mirror_stub_judge.ts");
let step = 0, stepLabel = "";
const replayed = (chat: any): string | { calls: { name: string; args: Record<string, unknown> }[] } | null => {
  const r = replay?.[label];
  if (!r) return null;
  const sys = String(chat.messages?.[0]?.role === "system" ? chat.messages[0].content : "");
  if (/^You check claims against passages/.test(sys)) {
    const items = JSON.parse(String(chat.messages.find((m: any) => m.role === "user")?.content ?? "[]"));
    return judgeMode === "yes" ? JSON.stringify(items.map(() => "yes")) : mirrorJudgeAnswer(JSON.stringify(items));
  }
  if (chat.response_format) return "{}";
  if (!chat.tools?.length) return r.reply; // a rewrite pass gets the same draft back (so it never shortens it into something else)
  if (stepLabel !== label) { stepLabel = label; step = 0; }
  const c = r.calls[step++];
  return c ? { calls: [c] } : r.reply;
};
const scripted = (chat: any) => {
  modelCalls++;
  const rp = replayed(chat);
  if (rp !== null) {
    if (typeof rp === "string") return Response.json({ id: "mirror-replay", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: rp }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    return Response.json({ id: "mirror-replay", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: rp.calls.map((c, k) => ({ id: `rp-${label}-${step}-${k}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }
  if (promptLog) prompts.push(`=== ${label}\n${JSON.stringify(chat.messages?.[0]?.content ?? "").slice(0, 20000)}`);
  const text = chat.response_format ? "{}" : `Dry run, no model (${label}).`;
  return Response.json({ id: "mirror-dry", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
};
const model = async (req: Request): Promise<Response> => {
  const body = await req.clone().json().catch(() => ({}));
  const tools = (body.tools ?? []).map((t: any) => String(t.name ?? t.type));
  calls.push({ tools, web: (body.tools ?? []).some((t: any) => /^web_search/.test(String(t.type ?? ""))), json: !!body.output_config?.format });
  if (dry) return await anthropicWire(req, scripted);
  // D-065 (item 6): at the cap the runner refuses the call the way the provider refuses at an account's spending limit (HTTP 400,
  // its own words), so the product says it stopped at a spending limit, never "an error on its side, not a limit" (limit_stop.ts).
  if (spent >= budget) return Response.json({ type: "error", error: { type: "invalid_request_error", message: `You have reached your specified API usage limits (mirror runner cap $${budget}, $${spent.toFixed(3)} spent).` } }, { status: 400 });
  modelCalls++;
  const res = await realFetch(req);
  // A model error is the product's to handle (it falls back), but the run says what it was, once per status.
  if (!res.ok && !modelErrors.has(res.status)) { modelErrors.set(res.status, (await res.clone().text()).slice(0, 300)); console.log(`model answered ${res.status}: ${modelErrors.get(res.status)}`); }
  try {
    const u = (await res.clone().json())?.usage ?? {};
    webSearches += u.server_tool_use?.web_search_requests ?? 0;
    // D-060: a web search call also pays $0.01 a search (usage.server_tool_use.web_search_requests).
    spent += (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.server_tool_use?.web_search_requests ?? 0) * 0.01;
  } catch { /* a non-JSON answer is the product's to handle */ }
  return res;
};

// Read before openWorld: it clears ANTHROPIC_API_KEY (response_world ENV_KEYS) so a test world never holds a real key; the first
// live run (2026-11-11) sent the string "undefined" and every model call came back 401.
const LIVE_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ACTION_TABLES: [string, string][] = [["career_apply_receipts", "submit"], ["career_contact_sends", "send"], ["career_outbox", "send"], ["career_outlook_sends", "send"], ["career_apply_jobs", "queue"], ["career_apply_prepared", "prepare"]];
const w = await openWorld(2, { model });
// D-065 (item 7): the test world Instinct had (instinct-wa-batch1/world.ts): the benchmark's recorded postings served from their
// recordings, the persona's stub Gmail, and on a live run the research reader's public GETs; everything else stays refused.
const gmail = worldGmail(), served = worldFetch({ live, realFetch, gmail }), below = globalThis.fetch;
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  return (await served(req)) ?? await below(req);
}) as typeof fetch;
const lines: string[] = [];
const t0 = performance.now();
let stopped: string | null = null;
try {
  // PRODUCTION CONFIGURATION (owner, 2026-11-11: "Make sure everything is turned on in production, whenever testing"): the run
  // serves the release configuration exactly as release_config.ts ships it. The test world turns CAREER_MAIL_TRACKING off for its
  // own tests; here every release flag and never-on switch is cleared (each release flag then serves its release value, each
  // never-on switch is off), and the brain is PRODUCTION_BRAIN. docs/architect/specs/MIRROR-PROCESS.md.
  for (const k of [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON]) Deno.env.delete(k);
  Deno.env.set("CAREER_BRAIN", PRODUCTION_BRAIN);
  // Production serves File links; a non-routable example.test base and a TEST secret stand in (as heldout/harness.ts does).
  for (const [k, v] of Object.entries(FILE_ENV)) Deno.env.set(k, v);
  const served = { release: Object.fromEntries(Object.keys(RELEASE_FLAGS).map((k) => [k, releaseValue(Deno.env, k)])), never_on_on: RELEASE_NEVER_ON.filter((k) => releaseFlagOn(Deno.env, k)) };
  if (JSON.stringify(served.release) !== JSON.stringify({ ...RELEASE_FLAGS }) || served.never_on_on.length) throw new Error(`not production's configuration: ${JSON.stringify(served)}`);
  Deno.env.set("ANTHROPIC_API_KEY", dry ? "sk-test-not-real" : LIVE_KEY);
  const cols = new Set((await w.pg.sql(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`)).split("\n").map((s) => s.trim()));
  const tables = ACTION_TABLES.filter(([t]) => cols.has(t));
  const counts = async (u: string) => {
    const r: Record<string, number> = {};
    for (const [t, kind] of tables) r[kind] = (r[kind] ?? 0) + Number((await w.pg.sql(`select count(*) from public.${t} where user_id = '${u}'`)).replace(/\D+/g, " ").trim().split(" ")[0] || 0);
    return r;
  };
  const person = await w.person({ resume: false });
  await w.pg.sql(worldSql(person.id));
  // D-067 (e), the owner's must-fix "Files and tracker links arrive and open": every File link a turn returns is followed right
  // after that turn through the real File server (trainee-file/handler.ts handleFile, with the deployed function's own deps over
  // this world's database), in the person's own signed-in session (a phone session, as file-session-fakes.ts opens one), exactly
  // as a tap would. Recorded per turn: the link, the status, and the page as text (its first 4,000 characters).
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const auth = signedIn();
  const fileDeps = { ...buildFileDeps(admin, { get: (k: string) => Deno.env.get(k) }, Date.now), ...auth.deps };
  const sid = await auth.tok(person.id, "chat", Date.now());
  const plain = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  const openLink = async (link: string) => {
    const hdr = { cookie: `tf_s=${sid}`, origin: new URL(FILE_ENV.TRAINEE_FILE_BASE_URL).origin };
    try {
      let res = await handleFile(new Request(link, { headers: hdr }), fileDeps as any);
      for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) res = await handleFile(new Request(new URL(res.headers.get("location") ?? "", link).toString(), { headers: hdr }), fileDeps as any);
      return { link, status: res.status, text: plain(await res.text()).slice(0, 4000) };
    } catch (e) { return { link, status: 0, text: `error: ${String((e as Error).message ?? e).slice(0, 300)}` }; }
  };
  // Live-8 (owner must-fix (a), "don't trust the changelog"): every document a turn attaches (the tailored resume's PDF and Word
  // copies, body.artifacts refs into channel_artifacts) is read back from the store as the channel bridge would fetch it, and its
  // printed text is recorded (the renderer's own extractPdfLines / extractDocxLines, as the architect tests read a PDF).
  const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
  const readDocument = async (ref: any) => {
    try {
      const got = await fetchArtifactBytes(admin, { userId: person.id, ref: String(ref?.ref ?? "") });
      if (!got) return { ref: ref?.ref ?? null, filename: ref?.filename ?? null, status: "missing", text: "" };
      // The bytes are kept beside the transcript (the workflow uploads that folder), so the PDF itself can be opened after the run.
      const keep = `${out.replace(/[^/]*$/, "")}documents/${label}-${String(got.filename).replace(/[^\w.-]+/g, "_")}`;
      try { await Deno.mkdir(keep.replace(/[^/]*$/, ""), { recursive: true }); await Deno.writeFile(keep, got.bytes); } catch { /* the text below is still recorded */ }
      const docx = /wordprocessingml|\.docx$/i.test(`${got.mime} ${got.filename}`);
      const lines = (docx ? R.extractDocxLines(Buffer.from(got.bytes)) : R.extractPdfLines(Buffer.from(got.bytes))) as string[];
      return { ref: ref.ref, filename: got.filename, mime: got.mime, bytes: got.bytes.length, status: "read", text: lines.join("\n").slice(0, 8000) };
    } catch (e) { return { ref: ref?.ref ?? null, filename: ref?.filename ?? null, status: "error", text: String((e as Error).message ?? e).slice(0, 300) }; }
  };
  const linksOf = (reply: string, body: any): string[] => {
    const rx = new RegExp(`${FILE_ENV.TRAINEE_FILE_BASE_URL.replace(/[.]/g, "\\.")}[^\\s)\\]>"']*`, "g");
    const xs = [...(reply.match(rx) ?? []), ...((body?.shape?.links ?? []) as string[]), ...((body?.artifacts ?? []) as any[]).map((x) => x?.url), ...((body?.file_cards ?? []) as any[]).map((x) => x?.url)];
    return [...new Set(xs.filter((x): x is string => typeof x === "string" && x.startsWith(FILE_ENV.TRAINEE_FILE_BASE_URL)).map((x) => x.replace(/[.,;:]+$/, "")))];
  };
  for (const [i, s] of persona.setup.entries()) {
    label = `setup-${i}`;
    const r = await person.say(s);
    lines.push(JSON.stringify({ id: label, setup: true, reply: String(r.reply ?? ""), intent: r.intent }));
  }
  for (const t of turns) {
    label = t.id;
    const before = await counts(person.id), outBefore = w.outbound.length, callsBefore = modelCalls, spentBefore = spent, webBefore = webSearches, t1 = performance.now();
    calls = [];
    let reply = "", intent: string | null = null, status = 0, meta: any = {}, artifact = false, body: any = null;
    try {
      const r: any = await person.say(t.prompt); reply = String(r.reply ?? ""); intent = r.intent; status = r.status; meta = r?.body?.meta ?? {}; body = r?.body ?? null;
      // D-065: a File link the turn sends after its answer (body.shape.links; on WhatsApp and iMessage it rides the answer) counts too.
      artifact = !!(r?.body?.artifacts?.length || r?.body?.file_cards?.length) || reply.includes(FILE_ENV.TRAINEE_FILE_BASE_URL) || (r?.body?.shape?.links ?? []).some((l: string) => l.includes(FILE_ENV.TRAINEE_FILE_BASE_URL));
    } catch (e) { stopped = String((e as Error).message ?? e); }
    if (stopped) break;
    const files = [];
    for (const l of linksOf(reply, body)) files.push(await openLink(l));
    const documents = [];
    for (const d of ((body?.artifacts ?? []) as any[])) documents.push(await readDocument(d));
    const after = await counts(person.id);
    const actions: { type: string; hosts?: string[] }[] = Object.keys(after).filter((k) => after[k] > (before[k] ?? 0)).map((type) => ({ type }));
    if (w.outbound.length > outBefore) actions.push({ type: "external", hosts: [...new Set(w.outbound.slice(outBefore))] });
    const trace = {
      offered: [...new Set(calls.filter((c) => !c.json && !c.web).flatMap((c) => c.tools))].sort(),
      called: ((meta.tool_calls ?? []) as any[]).map((x) => String(x?.name ?? x)),
      web_search_calls: calls.filter((c) => c.web).length, web_searches: webSearches - webBefore, json_calls: calls.filter((c) => c.json).length,
      // D-070: why a call failed (create_file refused, live-7 C1) and what the length pass did (ran, accepted or rejected, why).
      call_errors: ((meta.tool_calls ?? []) as any[]).filter((x) => x && x.ok === false).map((x) => ({ name: String(x.name), error: String(x.error ?? "").slice(0, 300) })),
      shorten: meta.shorten ?? null,
      // D-071: what research did with its pages and draft (drafted, kept, dropped by reason), and what each search asked.
      research: meta.research ?? null,
      // Live-10: the model's draft before the support check, and each sentence it removed with the reason (layer A or the judge).
      support: meta.support ?? null,
      args: ((meta.tool_calls ?? []) as any[]).filter((x) => x && x.args).map((x) => ({ name: String(x.name), args: x.args })),
      router_intent: meta.router_intent ?? null, brain: meta.brain ?? null, artifact, files, documents,
    };
    lines.push(JSON.stringify({ id: t.id, reply, actions, route: modelCalls > callsBefore ? (dry ? "model-scripted" : "model") : "router", intent, status, ms: Math.round(performance.now() - t1), usd: Number((spent - spentBefore).toFixed(4)), trace }));
    // The product falls back to the router when the model call is refused at the cap, so later turns would be the fallback's
    // words, not the model's: stop here (as heldout/harness.ts does). Live run 5 (2026-11-12) ran C18 to C23 on the fallback.
    if (live && spent >= budget) { stopped = `budget reached: $${spent.toFixed(3)} of $${budget}`; break; }
  }
} finally {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("CAREER_BRAIN");
  for (const k of Object.keys(FILE_ENV)) Deno.env.delete(k);
  globalThis.fetch = below;
  await w.close();
}
await Deno.writeTextFile(out, lines.join("\n") + (lines.length ? "\n" : ""));
if (promptLog) await Deno.writeTextFile(promptLog, prompts.join("\n\n"));
console.log(`MIRROR-CONVERSATION ${dry ? "dry-run" : "live"} gmail_sent=${gmail.sent.length} turns=${lines.filter((l) => !l.includes('"setup":true')).length}/${turns.length} model_calls=${modelCalls} external_requests=${w.outbound.length} web_searches=${webSearches} spent_usd=${spent.toFixed(4)} in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${out}${stopped ? ` (stopped: ${stopped})` : ""}`);
