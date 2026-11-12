// MIRROR HELD-OUT (P2), the runner both scorers share (architect builder, 2026-11-11). Sends each conversation, in order, on
// one fresh person and thread, through the real career handler (tests/architect/helpers/response_world.ts: every migration on
// a throwaway Postgres 16, the PostgREST double, a small fictional posting board, every other host refused and recorded), and
// records what CODE decided on each turn: who answered (the brain, or code with no model call), the tools code handed the
// brain and the ones it called, the router's intent, the rows the turn added (submit, send, queue, prepare, cards), any
// request that tried to leave the machine, whether a File came back, and whether a hypothetical's figures reached the
// person's record.
//
// P4, production's configuration: the release flags exactly as release_config.ts ships them. The world sets two test values
// that production does not have (CAREER_BRAIN=staged in the batch-1 tests, CAREER_MAIL_TRACKING=off in openWorld); both are
// removed here, so each flag serves its committed release value. Production also serves File links (TRAINEE_FILE_BASE_URL and
// its link secret are set there); a world has none, so a non-routable example.test base and a TEST secret stand in, and no
// link is fetched. Nothing else is set. The channel is the handler's default (as in the WA-1 handler test).
import { anthropicWire } from "../../../tests/architect/helpers/anthropic_wire.ts";
import { openWorld } from "../../../tests/architect/helpers/response_world.ts";
import type { Conversation } from "./generate.ts";

export interface TurnRecord {
  conv: string; id: string; split: string; family: string; prompt: string;
  route: "brain" | "code"; brain_calls: number; json_calls: number;
  offered: string[]; called: string[]; intent: string | null; router_intent: string | null; status: number;
  reply: string; effects: Record<string, number>; cards: number; outbound: string[]; artifact: boolean; markers_hit: string[];
  ms: number; usd: number; error?: string;
}
export interface RunOptions {
  mode: "dry" | "live";
  budgetUsd?: number; // live only: stop when the metered cost reaches it
  liveKey?: string; // live only: read before openWorld (it clears ANTHROPIC_API_KEY)
  onTurn?: (r: TurnRecord) => void;
}
const EFFECT_TABLES: [string, string][] = [["career_apply_receipts", "submit"], ["career_contact_sends", "send"], ["career_outbox", "send"], ["career_outlook_sends", "send"],
  ["career_send_queue", "send"], ["career_apply_jobs", "queue"], ["career_apply_prepared", "prepare"], ["career_apply_prepare_requests", "prepare"]];
const CARD_TABLES = ["career_apply_cards", "career_apply_message_cards", "career_apply_batch_approvals"];
// D-038 claude-sonnet-5-5 prices, as run-trainee.ts meters them.
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.5 / 1e6 };
// What production serves for a File link, with nothing real in it (see the header).
export const FILE_ENV = { TRAINEE_FILE_BASE_URL: "https://file.example.test", TRAINEE_FILE_LINK_SECRET: "TEST-not-real-file-link-secret-0000000000" };

export const markerRx = (m: string) => /k$/.test(m) ? new RegExp(`\\b${m.slice(0, -1)}(?:k|,000|000)\\b`, "i") : new RegExp(`(?<![\\d.])${m.replace(".", "\\.")}(?![\\d])`);

export async function runConversations(convs: Conversation[], o: RunOptions): Promise<{ records: TurnRecord[]; spent: number; outbound: string[]; stopped: string | null }> {
  const realFetch = globalThis.fetch;
  let spent = 0, label = "";
  let calls: { tools: string[]; json: boolean }[] = [];
  const scripted = (chat: any) => Response.json({ id: "heldout-dry", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : `Dry run, no model (${label}).` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const model = async (req: Request): Promise<Response> => {
    const body = await req.clone().json().catch(() => ({}));
    calls.push({ tools: (body.tools ?? []).map((t: any) => String(t.name)), json: !!body.output_config?.format });
    if (o.mode === "dry") return await anthropicWire(req, scripted);
    if (spent >= (o.budgetUsd ?? 0)) throw new Error(`budget reached: $${spent.toFixed(3)} of $${o.budgetUsd}`);
    const res = await realFetch(req);
    try {
      const u = (await res.clone().json())?.usage ?? {};
      // D-060: a web search call also pays $0.01 a search (usage.server_tool_use.web_search_requests), as run-conversation.ts meters it.
      spent += (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.server_tool_use?.web_search_requests ?? 0) * 0.01;
    } catch { /* a non-JSON answer is the product's to handle */ }
    return res;
  };
  const people = convs.length + 1;
  const w = await openWorld(people, { model });
  const records: TurnRecord[] = [];
  let stopped: string | null = null;
  try {
    // P4: no test-only switch (see the header)
    Deno.env.delete("CAREER_BRAIN");
    Deno.env.delete("CAREER_MAIL_TRACKING");
    for (const [k, v] of Object.entries(FILE_ENV)) Deno.env.set(k, v);
    Deno.env.set("ANTHROPIC_API_KEY", o.mode === "dry" ? "sk-test-not-real" : (o.liveKey ?? ""));
    const cols = new Set((await w.pg.sql(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`)).split("\n").map((s) => s.trim()));
    const effects = EFFECT_TABLES.filter(([t]) => cols.has(t)), cards = CARD_TABLES.filter((t) => cols.has(t));
    const snapshot = async (u: string) => {
      const parts = [...effects.map(([t], i) => `'e${i}', (select count(*) from public.${t} where user_id = '${u}')`), ...cards.map((t, i) => `'c${i}', (select count(*) from public.${t} where user_id = '${u}')`)];
      const j = JSON.parse((await w.pg.sql(`select json_build_object(${parts.join(", ")})`)).trim().split("\n").find((l) => l.trim().startsWith("{")) ?? "{}");
      const e: Record<string, number> = {};
      effects.forEach(([, kind], i) => (e[kind] = (e[kind] ?? 0) + Number(j[`e${i}`] ?? 0)));
      return { e, cards: cards.reduce((a, _, i) => a + Number(j[`c${i}`] ?? 0), 0) };
    };
    // The person's record: profile and stored state, memory, the key-value records, the event log.
    const recordText = async (u: string) => await w.pg.sql(`select coalesce((select string_agg((state->'career'->'stores')::text, ' ') from public.agent_flow_state where user_id = '${u}'), '') || ' ' ||
      coalesce((select string_agg(value::text, ' ') from public.career_watch_kv where user_id = '${u}'), '') || ' ' ||
      coalesce((select string_agg(coalesce(subject, '') || ' ' || coalesce(detail::text, ''), ' ') from public.career_events where user_id = '${u}'), '')`);
    outer: for (const c of convs) {
      const person = await w.person({ resume: false });
      for (const [i, s] of c.setup.turns.entries()) { label = `${c.id}.setup${i + 1}`; await person.say(s); }
      const before0 = await recordText(person.id);
      const mine: TurnRecord[] = [];
      for (const t of c.turns) {
        label = t.id; calls = [];
        const b = await snapshot(person.id), outAt = w.outbound.length, spentAt = spent, t0 = performance.now();
        let r: any = null, error: string | undefined;
        try { r = await person.say(t.prompt); } catch (e) { error = String((e as Error).message ?? e); }
        if (error && /budget reached/.test(error)) { stopped = error; break outer; }
        const a = await snapshot(person.id);
        const meta = r?.body?.meta ?? {};
        const brain = calls.filter((x) => !x.json);
        const reply = String(r?.reply ?? "");
        const rec: TurnRecord = {
          conv: c.id, id: t.id, split: c.split, family: c.family, prompt: t.prompt,
          route: brain.length ? "brain" : "code", brain_calls: brain.length, json_calls: calls.length - brain.length,
          offered: [...new Set(brain.flatMap((x) => x.tools))].sort(), called: [...new Set(((meta.tool_calls ?? []) as any[]).map((x) => String(x?.name ?? x)))].sort(),
          intent: r?.intent ?? null, router_intent: meta.router_intent ?? null, status: r?.status ?? 0, reply,
          effects: Object.fromEntries(Object.keys(a.e).map((k) => [k, a.e[k] - (b.e[k] ?? 0)]).filter(([, v]) => (v as number) > 0)),
          cards: a.cards - b.cards, outbound: w.outbound.slice(outAt),
          artifact: !!(r?.body?.artifacts?.length || r?.body?.file_cards?.length) || reply.includes(FILE_ENV.TRAINEE_FILE_BASE_URL),
          markers_hit: [], ms: Math.round(performance.now() - t0), usd: Number((spent - spentAt).toFixed(4)), ...(error ? { error } : {}),
        };
        mine.push(rec);
        // the product falls back to the router when the model call is refused, so the cap is checked here too
        if (o.mode === "live" && spent >= (o.budgetUsd ?? 0)) { stopped = `budget reached: $${spent.toFixed(3)} of $${o.budgetUsd}`; break; }
      }
      // G8: a hypothetical's figures that are in the record now and were not before the conversation
      const after = await recordText(person.id);
      for (const t of c.turns) {
        const rec = mine.find((x) => x.id === t.id);
        if (rec) rec.markers_hit = t.expect.process.record_markers.filter((m) => markerRx(m).test(after) && !markerRx(m).test(before0));
      }
      for (const rec of mine) { records.push(rec); o.onTurn?.(rec); }
      if (stopped) break;
    }
  } finally {
    for (const k of [...Object.keys(FILE_ENV), "ANTHROPIC_API_KEY"]) Deno.env.delete(k);
    await w.close();
  }
  return { records, spent, outbound: w.outbound, stopped };
}
