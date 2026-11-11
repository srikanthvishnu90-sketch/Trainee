// MIRROR PROCESS (architect, 2026-11-11; docs/architect/specs/MIRROR-PROCESS.md): the owner's Instinct WhatsApp benchmark, batch 1
// (evals/mirror/instinct-wa-batch1/), run through the REAL career handler at $0 with a scripted model that records, per turn,
// which tools code OFFERED the brain, what code put in its system prompt, which tool calls the brain made (the script makes the
// calls the process names) and what each returned, and whether code answered the turn itself. Every migration on a throwaway
// Postgres 16; every host but the database double and the scripted model refused and recorded with its full address.
// Used by tests/architect/mirror-wa-batch1-process.test.ts (the turns whose capabilities exist) and
// tests/architect/pending/mirror-process-blocked.test.ts (the turns blocked on a capability that is off or missing).
import { anthropicWire } from "./anthropic_wire.ts";
import { openWorld, type World } from "./response_world.ts";
import { SUPABASE_URL } from "../../flow/handler.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON, releaseFlagOn, releaseValue } from "../../../supabase/functions/agent-chat/release_config.ts";

const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const lines = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
export const TURNS: { id: string; prompt: string }[] = lines("prompts.jsonl");
export const PERSONA: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
// "that paypal internship": the posting the conversation lists (the benchmark's is on Workday; this board is Greenhouse, which the
// open check reads by id).
export const PAYPAL = { id: "greenhouse:paypalwa1:9101", url: "https://boards.greenhouse.io/paypalwa1/jobs/9101" };

export type Call = { name: string; input: Record<string, unknown>; result: string };
export type Seen = {
  code: boolean; // code answered: the brain was never called with tools on this turn
  tools: string[]; // the tools offered on the brain's first call
  schemas: Record<string, any>; // each offered tool's input schema
  system: string; // the system prompt of the brain's first call
  history: string; // every earlier message the brain was shown, joined
  calls: Call[]; // the tool calls the script made, with what each returned
  reply: string; intent: string | null; documents: any[];
  outbound: string[]; // off-machine requests made during this turn (method and full address), each refused
  searches: number; // web searches (the web_search server tool) requested on this turn
};
// The switches as the handler reads them at a turn: every release flag's served value, and whether any never-on switch is on.
export type FlagsAtTurn = { release: Record<string, string | undefined>; neverOnOn: string[]; brain: string | undefined };
export function flagsNow(): FlagsAtTurn {
  return { release: Object.fromEntries(Object.keys(RELEASE_FLAGS).map((k) => [k, releaseValue(Deno.env, k)])), neverOnOn: RELEASE_NEVER_ON.filter((k) => releaseFlagOn(Deno.env, k)), brain: Deno.env.get("CAREER_BRAIN") };
}
// A step of a turn's script: a tool call (its input may read what earlier calls returned), or the final text.
export type Step = { tool: string; input: Record<string, unknown> | ((calls: Call[]) => Record<string, unknown>) } | { text: string | ((calls: Call[]) => string) };

// web: a stubbed web search on the Anthropic wire (D-060's search goes to the model host with the web_search server tool): given the
// request body and the turn, the search answer (the shape the live proof recorded, evals/research-live/). Absent, a search gets an
// empty result. Nothing leaves the machine; each search is counted on its turn (Seen.searches). draft: the scripted answer to a
// model call made without tools (e.g. the market research draft, market.ts RULES); null leaves the default.
// Architect amendment (D-062), additive only: posting: the "paypal internship" row seeded in place of PAYPAL's (the benchmark's own
// posting is on Workday); turns: the turns to say in place of the benchmark's (setup still runs first); serve: a recorded copy of
// a real public page answering an off-machine request (tests/fixtures/), or null to refuse it. A served request is still
// recorded on its turn (Seen.outbound) exactly like a refused one; nothing else changes.
export type SeedPosting = { id: string; provider: string; board: string; company: string; title: string; location: string; url: string; description: string };
export async function runConversation(script: Record<string, Step[]>, opts: { only?: string[]; web?: (body: any, turn: string) => any; draft?: (system: string, user: string, turn: string) => string | null; posting?: SeedPosting; turns?: { id: string; prompt: string }[]; serve?: (req: Request, turn: string) => Response | null | Promise<Response | null> } = {}): Promise<{ seen: Record<string, Seen>; flags: Record<string, FlagsAtTurn>; world: World; person: { id: string }; close: () => Promise<void> }> {
  let label = "";
  const seen: Record<string, Seen> = {};
  const fresh = (): Seen => ({ code: true, tools: [], schemas: {}, system: "", history: "", calls: [], reply: "", intent: null, documents: [], outbound: [], searches: 0 });
  const scripted = (chat: any) => {
    const msgs: any[] = chat.messages ?? [];
    const reply = (content: string, tool_calls?: unknown[]) => Response.json({ id: "mp", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    // A call with no tools (a structured read, the condenser, a rewrite): no script.
    if (!Array.isArray(chat.tools) || !chat.tools.length) {
      const sys = String(msgs[0]?.role === "system" ? msgs[0].content : "");
      const own = opts.draft?.(sys, String(msgs.at(-1)?.content ?? ""), label);
      return reply(own ?? (chat.response_format ? "{}" : `scripted (${label})`));
    }
    const s = seen[label] ??= fresh();
    if (s.code) {
      s.code = false;
      s.tools = chat.tools.map((t: any) => t.function?.name ?? t.name);
      s.schemas = Object.fromEntries(chat.tools.map((t: any) => [t.function?.name ?? t.name, t.function?.parameters ?? t.input_schema ?? {}]));
      s.system = String(msgs[0]?.role === "system" ? msgs[0].content : "");
      const firstUser = msgs.findLastIndex((m: any) => m.role === "user");
      s.history = msgs.slice(1, Math.max(1, firstUser)).map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).join("\n");
    }
    // Record what the previous call returned.
    const last = msgs.at(-1);
    if (last?.role === "tool" && s.calls.length && !s.calls.at(-1)!.result) s.calls.at(-1)!.result = String(last.content ?? "");
    const steps = script[label] ?? [];
    const step = steps[s.calls.length];
    if (step && "tool" in step) {
      const input = typeof step.input === "function" ? step.input(s.calls) : step.input;
      s.calls.push({ name: step.tool, input, result: "" });
      return reply("", [{ id: `toolu_mp_${s.calls.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(input) } }]);
    }
    const t = steps.find((x): x is Extract<Step, { text: unknown }> => "text" in x)?.text;
    return reply((typeof t === "function" ? t(s.calls) : t) ?? `scripted (${label})`);
  };
  const model = async (req: Request) => {
    const body = await req.clone().json().catch(() => ({}));
    if ((body.tools ?? []).some((t: any) => /^web_search_/.test(String(t?.type ?? "")))) {
      (seen[label] ??= fresh()).searches++;
      const answer = opts.web?.(body, label) ?? { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } };
      return Response.json(answer);
    }
    return anthropicWire(req, scripted);
  };
  const world = await openWorld(2, { model });
  // Every off-machine request, with its full address, on the turn that made it (the world's double refuses it after).
  const refuse = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "api.anthropic.com" && u.origin !== new URL(SUPABASE_URL).origin) {
      (seen[label] ??= fresh()).outbound.push(`${req.method} ${u.origin}${u.pathname}`);
      const served = opts.serve ? await opts.serve(req.clone(), label) : null;
      if (served) return served;
    }
    return await refuse(req);
  }) as typeof fetch;
  // PRODUCTION CONFIGURATION (owner, 2026-11-11: "Make sure everything is turned on in production, whenever testing"): the
  // backtest runs with the release configuration exactly as release_config.ts ships it. The shared world turns
  // CAREER_MAIL_TRACKING off for its own tests; here every release flag is left unset, so the handler serves its release value
  // (releaseValue), no never-on switch is set, and the brain is PRODUCTION_BRAIN. The model key is a dummy (the model is scripted).
  for (const k of Object.keys(RELEASE_FLAGS)) Deno.env.delete(k);
  for (const k of RELEASE_NEVER_ON) Deno.env.delete(k);
  Deno.env.set("CAREER_BRAIN", PRODUCTION_BRAIN);
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
  const flags: Record<string, FlagsAtTurn> = {};
  const close = async () => { globalThis.fetch = refuse; Deno.env.delete("CAREER_BRAIN"); Deno.env.delete("ANTHROPIC_API_KEY"); await world.close(); };
  try {
    const seed: SeedPosting = opts.posting ?? { id: PAYPAL.id, provider: "greenhouse", board: "paypalwa1", company: "PayPal", title: "Software Engineer Intern", location: "Chicago, IL", url: PAYPAL.url, description: "Summer 2027 software engineering internship. Python, Java, SQL. Pay: $28 - $49 per hour." };
    const q = (v: string) => `$q$${v}$q$`;
    await world.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      (${q(seed.id)}, ${q(seed.provider)}, ${q(seed.board)}, ${q(seed.company)}, ${q(seed.title)}, ${q(seed.location)}, ${q(seed.url)}, ${q(seed.description)}, now() - interval '1 day', now())`);
    const person = await world.person({ resume: false });
    for (const [k, s] of PERSONA.setup.entries()) { label = `setup${k}`; flags[label] = flagsNow(); await person.say(s); }
    for (const t of opts.turns ?? TURNS) {
      if (opts.only && !opts.only.includes(t.id)) continue;
      label = t.id;
      flags[t.id] = flagsNow();
      const r: any = await person.say(t.prompt);
      const s = seen[t.id] ??= fresh();
      s.reply = String(r.reply ?? ""); s.intent = r.intent ?? null; s.documents = Array.isArray(r.body?.documents) ? r.body.documents : [];
    }
    return { seen, flags, world, person, close };
  } catch (e) { await close(); throw e; }
}

// The rows that would mean something was queued, prepared, submitted or sent for this person.
export const EFFECT_TABLES = ["career_apply_receipts", "career_apply_jobs", "career_apply_prepared", "career_outbox", "career_contact_sends", "career_outreach_drafts"];
export async function effectRows(world: World, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of EFFECT_TABLES) {
    if (!(await world.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t")) continue;
    out[t] = Number((await world.pg.sql(`select count(*) from public.${t} where user_id = '${userId}'`)).replace(/\D+/g, " ").trim().split(" ")[0]);
  }
  return out;
}
