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

let modelCalls = 0, spent = 0, label = "";
const modelErrors = new Map<number, string>();
const prompts: string[] = [];
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.5 / 1e6 };
const scripted = (chat: any) => {
  modelCalls++;
  if (promptLog) prompts.push(`=== ${label}\n${JSON.stringify(chat.messages?.[0]?.content ?? "").slice(0, 20000)}`);
  const text = chat.response_format ? "{}" : `Dry run, no model (${label}).`;
  return Response.json({ id: "mirror-dry", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
};
const model = async (req: Request): Promise<Response> => {
  if (dry) return await anthropicWire(req, scripted);
  if (spent >= budget) throw new Error(`budget reached: $${spent.toFixed(3)} of $${budget}`);
  modelCalls++;
  const res = await realFetch(req);
  // A model error is the product's to handle (it falls back), but the run says what it was, once per status.
  if (!res.ok && !modelErrors.has(res.status)) { modelErrors.set(res.status, (await res.clone().text()).slice(0, 300)); console.log(`model answered ${res.status}: ${modelErrors.get(res.status)}`); }
  try {
    const u = (await res.clone().json())?.usage ?? {};
    spent += (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite;
  } catch { /* a non-JSON answer is the product's to handle */ }
  return res;
};

// Read before openWorld: it clears ANTHROPIC_API_KEY (response_world ENV_KEYS) so a test world never holds a real key; the first
// live run (2026-11-11) sent the string "undefined" and every model call came back 401.
const LIVE_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ACTION_TABLES: [string, string][] = [["career_apply_receipts", "submit"], ["career_contact_sends", "send"], ["career_outbox", "send"], ["career_outlook_sends", "send"], ["career_apply_jobs", "queue"], ["career_apply_prepared", "prepare"]];
const w = await openWorld(2, { model });
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
  for (const [i, s] of persona.setup.entries()) {
    label = `setup-${i}`;
    const r = await person.say(s);
    lines.push(JSON.stringify({ id: label, setup: true, reply: String(r.reply ?? ""), intent: r.intent }));
  }
  for (const t of turns) {
    label = t.id;
    const before = await counts(person.id), outBefore = w.outbound.length, callsBefore = modelCalls, spentBefore = spent, t1 = performance.now();
    let reply = "", intent: string | null = null, status = 0;
    try { const r = await person.say(t.prompt); reply = String(r.reply ?? ""); intent = r.intent; status = r.status; } catch (e) { stopped = String((e as Error).message ?? e); }
    if (stopped) break;
    const after = await counts(person.id);
    const actions: { type: string; hosts?: string[] }[] = Object.keys(after).filter((k) => after[k] > (before[k] ?? 0)).map((type) => ({ type }));
    if (w.outbound.length > outBefore) actions.push({ type: "external", hosts: [...new Set(w.outbound.slice(outBefore))] });
    lines.push(JSON.stringify({ id: t.id, reply, actions, route: modelCalls > callsBefore ? (dry ? "model-scripted" : "model") : "router", intent, status, ms: Math.round(performance.now() - t1), usd: Number((spent - spentBefore).toFixed(4)) }));
  }
} finally {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("CAREER_BRAIN");
  await w.close();
}
await Deno.writeTextFile(out, lines.join("\n") + (lines.length ? "\n" : ""));
if (promptLog) await Deno.writeTextFile(promptLog, prompts.join("\n\n"));
console.log(`MIRROR-CONVERSATION ${dry ? "dry-run" : "live"} turns=${lines.filter((l) => !l.includes('"setup":true')).length}/${turns.length} model_calls=${modelCalls} external_requests=${w.outbound.length} spent_usd=${spent.toFixed(4)} in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${out}${stopped ? ` (stopped: ${stopped})` : ""}`);
