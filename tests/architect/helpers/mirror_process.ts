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
};
// A step of a turn's script: a tool call (its input may read what earlier calls returned), or the final text.
export type Step = { tool: string; input: Record<string, unknown> | ((calls: Call[]) => Record<string, unknown>) } | { text: string };

export async function runConversation(script: Record<string, Step[]>, opts: { only?: string[] } = {}): Promise<{ seen: Record<string, Seen>; world: World; person: { id: string } ; close: () => Promise<void> }> {
  let label = "";
  const seen: Record<string, Seen> = {};
  const fresh = (): Seen => ({ code: true, tools: [], schemas: {}, system: "", history: "", calls: [], reply: "", intent: null, documents: [], outbound: [] });
  const scripted = (chat: any) => {
    const msgs: any[] = chat.messages ?? [];
    const reply = (content: string, tool_calls?: unknown[]) => Response.json({ id: "mp", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    // A call with no tools (a structured read, the condenser, a rewrite): no script.
    if (!Array.isArray(chat.tools) || !chat.tools.length) return reply(chat.response_format ? "{}" : `scripted (${label})`);
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
    const text = steps.find((x): x is { text: string } => "text" in x)?.text;
    return reply(text ?? `scripted (${label})`);
  };
  const world = await openWorld(2, { model: (req) => anthropicWire(req, scripted) });
  // Every off-machine request, with its full address, on the turn that made it (the world's double refuses it after).
  const refuse = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "api.anthropic.com" && u.origin !== new URL(SUPABASE_URL).origin) (seen[label] ??= fresh()).outbound.push(`${req.method} ${u.origin}${u.pathname}`);
    return await refuse(req);
  }) as typeof fetch;
  Deno.env.set("CAREER_BRAIN", "staged");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
  const close = async () => { globalThis.fetch = refuse; Deno.env.delete("CAREER_BRAIN"); Deno.env.delete("ANTHROPIC_API_KEY"); await world.close(); };
  try {
    await world.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      ('${PAYPAL.id}', 'greenhouse', 'paypalwa1', 'PayPal', 'Software Engineer Intern', 'Chicago, IL', '${PAYPAL.url}', 'Summer 2027 software engineering internship. Python, Java, SQL. Pay: $28 - $49 per hour.', now() - interval '1 day', now())`);
    const person = await world.person({ resume: false });
    for (const [k, s] of PERSONA.setup.entries()) { label = `setup${k}`; await person.say(s); }
    for (const t of TURNS) {
      if (opts.only && !opts.only.includes(t.id)) continue;
      label = t.id;
      const r: any = await person.say(t.prompt);
      const s = seen[t.id] ??= fresh();
      s.reply = String(r.reply ?? ""); s.intent = r.intent ?? null; s.documents = Array.isArray(r.body?.documents) ? r.body.documents : [];
    }
    return { seen, world, person, close };
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
