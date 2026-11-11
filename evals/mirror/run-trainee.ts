// MIRROR-1000 Trainee side (architect builder, 2026-11-11). Sends each prompt of evals/mirror/prompts.v1.jsonl (after its
// setup turns, on a fresh person and thread) through the real career handler (handler-career.ts on a throwaway Postgres 16,
// tests/architect/helpers/response_world.ts: every migration, the PostgREST double, a small fictional posting board, every
// other host refused and recorded) and writes one transcript line per prompt: {id, reply, actions, route, intent}.
//
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/run-trainee.ts --dry-run [--spread 50 | --limit N --offset N] [--out file]
//   deno run -A --no-check evals/mirror/run-trainee.ts --live --budget-usd <cap> [--limit N] [--out ...]     (owner approval only)
//
// --dry-run: the staged brain (CAREER_BRAIN=staged) with a SCRIPTED model on the Anthropic wire. $0, no key, no request leaves
//   the machine (asserted). Turns the router answers are the product's real words; turns that reach the model get the scripted
//   line "Dry run, no model. The task here: <the prompt's first must_do>." It proves the harness end to end (set -> handler ->
//   transcript -> score.ts); it does not measure Claude.
// --live: the same path with the real model. Refuses to start unless MIRROR_SPEND_APPROVED names the owner's written approval
//   (a DECISIONS.md line, e.g. "D-056") and ANTHROPIC_API_KEY is set; stops when the metered cost (usage tokens x the
//   claude-sonnet-5-5 price of D-038: $2 / M input, $10 / M output, $0.10 / M cache read, $2.50 / M cache write) reaches
//   --budget-usd. Real employer submission stays impossible here: every host but the model and the database double is refused.
// actions: what the person's rows show after the turn: "submit" (a receipt), "send" (an outreach send or outbox row), "queue"
//   (an apply job), "prepare" (a prepared application); plus "external" for any request the world refused.
// Postgres 16 must be on PATH or PGBIN; as root, set CI=true (pg.ts then runs Postgres as the postgres user). Where esm.sh is
// unreachable, add --import-map=tests/flow/supabase-npm.json (the same supabase-js from npm; tests/flow/handler.ts).
import { anthropicWire } from "../../tests/architect/helpers/anthropic_wire.ts";
import { openWorld } from "../../tests/architect/helpers/response_world.ts";
import { loadSet, SET_PATH, type MirrorPrompt } from "./distinct.ts";

const realFetch = globalThis.fetch;
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const dry = a.includes("--dry-run"), live = a.includes("--live");
if (dry === live) { console.log("usage: run-trainee.ts --dry-run | --live --budget-usd <cap>  [--limit N | --spread N] [--offset N] [--out file] [--set file]"); Deno.exit(2); }
const budget = Number(opt("--budget-usd") ?? 0);
if (live) {
  const approved = Deno.env.get("MIRROR_SPEND_APPROVED") ?? "";
  if (!/^D-\d{3}[a-z]?$/.test(approved)) { console.log("refused: --live needs MIRROR_SPEND_APPROVED=<the DECISIONS.md line of the owner's written spend approval>"); Deno.exit(3); }
  if (!Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }
  if (!(budget > 0)) { console.log("refused: --live needs --budget-usd <cap>"); Deno.exit(3); }
}
const all = await loadSet(opt("--set") ?? SET_PATH);
const offset = Number(opt("--offset") ?? 0), limit = Number(opt("--limit") ?? all.length);
// --spread N: N prompts evenly spaced over the whole set (every category), instead of the first N.
const spread = Number(opt("--spread") ?? 0);
const set = spread > 0 ? Array.from({ length: Math.min(spread, all.length) }, (_, i) => all[Math.floor((i * all.length) / Math.min(spread, all.length))]) : all.slice(offset, offset + limit);
const out = opt("--out") ?? new URL(`./results/trainee-${dry ? "dry" : "live"}.jsonl`, import.meta.url).pathname;

// The scripted model (dry run) and the meter (live).
let current: MirrorPrompt | null = null, modelCalls = 0, spent = 0;
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.5 / 1e6 };
const scripted = (chat: any) => {
  modelCalls++;
  const text = chat.response_format ? "{}" : `Dry run, no model. The task here: ${current?.task.must_do[0] ?? "answer the message"}.`;
  return Response.json({ id: "mirror-dry", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
};
const model = async (req: Request): Promise<Response> => {
  if (dry) return await anthropicWire(req, scripted);
  if (spent >= budget) throw new Error(`budget reached: $${spent.toFixed(3)} of $${budget}`);
  modelCalls++;
  const res = await realFetch(req);
  try {
    const u = (await res.clone().json())?.usage ?? {};
    spent += (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite;
  } catch { /* a non-JSON answer is the product's to handle */ }
  return res;
};

const ACTION_TABLES: [string, string][] = [["career_apply_receipts", "submit"], ["career_contact_sends", "send"], ["career_outbox", "send"], ["career_outlook_sends", "send"], ["career_apply_jobs", "queue"], ["career_apply_prepared", "prepare"]];
const w = await openWorld(set.length + 1, { model });
const lines: string[] = [];
const t0 = performance.now();
let stopped: string | null = null;
try {
  Deno.env.set("CAREER_BRAIN", "staged");
  Deno.env.set("ANTHROPIC_API_KEY", dry ? "sk-test-not-real" : Deno.env.get("ANTHROPIC_API_KEY")!);
  const cols = new Set((await w.pg.sql(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`)).split("\n").map((s) => s.trim()));
  const tables = ACTION_TABLES.filter(([t]) => cols.has(t));
  const counts = async (u: string) => {
    const out: Record<string, number> = {};
    for (const [t, kind] of tables) out[kind] = (out[kind] ?? 0) + Number((await w.pg.sql(`select count(*) from public.${t} where user_id = '${u}'`)).replace(/\D+/g, " ").trim().split(" ")[0] || 0);
    return out;
  };
  for (const p of set) {
    current = p;
    const person = await w.person({ resume: (p.setup.state as any)?.resume === "confirmed" });
    for (const t of p.setup.turns) await person.say(t);
    const before = await counts(person.id), outBefore = w.outbound.length, callsBefore = modelCalls;
    let reply = "", intent: string | null = null, status = 0;
    try { const r = await person.say(p.prompt); reply = String(r.reply ?? ""); intent = r.intent; status = r.status; } catch (e) { stopped = String((e as Error).message ?? e); }
    if (stopped) break;
    const after = await counts(person.id);
    const actions = Object.keys(after).filter((k) => after[k] > (before[k] ?? 0)).map((type) => ({ type }));
    if (w.outbound.length > outBefore) actions.push({ type: "external" });
    lines.push(JSON.stringify({ id: p.id, reply, actions, route: modelCalls > callsBefore ? (dry ? "model-scripted" : "model") : "router", intent, status }));
  }
} finally {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("CAREER_BRAIN");
  await w.close();
}
await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true }).catch(() => {});
await Deno.writeTextFile(out, lines.join("\n") + (lines.length ? "\n" : ""));
const routes = lines.map((l) => JSON.parse(l).route as string);
console.log(`MIRROR-TRAINEE ${dry ? "dry-run" : "live"} prompts=${lines.length}/${set.length} router=${routes.filter((r) => r === "router").length} model=${routes.filter((r) => r !== "router").length} ` +
  `external_requests=${w.outbound.length} spent_usd=${spent.toFixed(4)} in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${out}${stopped ? ` (stopped: ${stopped})` : ""}`);
if (dry && w.outbound.length) { console.log("a request left the machine in a dry run:", w.outbound.slice(0, 5)); Deno.exit(1); }
