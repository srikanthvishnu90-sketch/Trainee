// Chat entries for the batch scenario runner, and the two guards every entry runs behind.
//
//   stub     --mock    a canned stub brain (no model, no network, no database): tests the harness itself.
//   inbound  --live    the channel-neutral conversation core (conversation.ts handleInbound) with the career brain exactly as
//                      evals/career/run.ts builds it (CareerHost router, or agentTurn with --brain agent), over an in-memory store.
//   handler  --live    the production agent-chat career handler (handler-career.ts handleChat, the function Telegram's webhook
//                      reaches through chatThroughAgent) on tests/flow's real Postgres 16 with every migration. Needs the Postgres binaries
//                      and an unprivileged user, as the flow tests do.
// Isolation: one TEST user per scenario (variants.ts testUserId/testContact/testUuid), never a real person. Effects: nothing can leave.
// The fetch guard refuses every host except the test database double and api.openai.com; a refused attempt is recorded and fails the
// chat (external_attempt). A scenario's `approve` turn is recorded with the digest of the card it answers and is never sent to the entry.
// Money: the RunCap is an outer, per-run limit on top of the product's own model_budget reserve (callModel still reserves first).
import { AsyncLocalStorage } from "node:async_hooks";
import { memoryBudgetGate, REFUSED_BEFORE_GENERATION, usageProven, worstCaseMicros, type BudgetGate } from "../../../supabase/functions/_shared/model_budget.ts";
import { PRICES, responsesSettle, responsesWorst, VOICE_MODEL } from "../../../supabase/functions/_shared/model_gateway.ts";
import { fnv, rng, type Scenario } from "./variants.ts";

// ---- the cap ----------------------------------------------------------------------------------------------------------
export class CapExceededError extends Error { constructor(public detail: string) { super(`run cap: ${detail}`); this.name = "CapExceededError"; } }
export const DEFAULT_MAX_USD = 3.0;
export class RunCap {
  readonly gate: BudgetGate & { snapshot(): { spent: number; reserved: number; limit: number } };
  tripped = false;
  constructor(public readonly maxUsd: number) {
    if (!(maxUsd > 0) || !Number.isFinite(maxUsd)) throw new Error(`--max-usd must be a positive number (got ${maxUsd})`);
    this.gate = memoryBudgetGate(Math.floor(maxUsd * 1e6));
  }
  spentUsd() { const s = this.gate.snapshot(); return (s.spent + s.reserved) / 1e6; }
  settledUsd() { return this.gate.snapshot().spent / 1e6; }
  // Fail closed: a reservation that does not fit trips the cap for good; nothing is sent after it.
  async reserve(micros: number, meta: { model: string; role: string }): Promise<string> {
    if (this.tripped) throw new CapExceededError("already tripped");
    const r = await this.gate.reserve(micros, meta);
    if (!r.ok) { this.tripped = true; throw new CapExceededError(`${r.reason} (worst case $${(micros / 1e6).toFixed(4)} does not fit in $${this.maxUsd.toFixed(2)}; $${this.spentUsd().toFixed(4)} used)`); }
    return r.id;
  }
}

// Only OpenAI chat models. Voice, speech and realtime models are refused, and so is anything that is not an OpenAI model name.
export function assertAllowedModel(model: string) {
  if (VOICE_MODEL.test(model)) throw new Error(`voice model refused: ${model}`);
  if (/claude|anthropic|haiku|sonnet|opus/i.test(model) || !/^(?:gpt-|o\d|chatgpt)/i.test(model)) throw new Error(`only OpenAI chat models are allowed here (got ${model})`);
}
export const als = new AsyncLocalStorage<{ i: number }>();
export interface GuardState { blocked: { i: number; what: string }[]; calls: number }

// Wraps the network. OpenAI requests are priced at their worst case and reserved on the cap before they leave, then settled to the
// proven cost; anything unproven (no usage block, an unpriced model, an error after sending) keeps the worst case as spent.
export function guardFetch(o: { cap: RunCap; inner: typeof fetch; allowOrigins: string[]; state: GuardState }): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url), who = als.getStore()?.i ?? -1;
    if (o.allowOrigins.includes(u.origin)) return await o.inner(req);
    if (u.host !== "api.openai.com") { o.state.blocked.push({ i: who, what: `${req.method} ${u.host}${u.pathname}` }); throw new TypeError(`network refused in the batch harness: ${u.host}`); }
    const text = await req.text();
    let body: any; try { body = JSON.parse(text); } catch { throw new TypeError("openai request is not JSON"); }
    assertAllowedModel(String(body?.model ?? ""));
    // A Responses call (the web_search tool) is priced exactly as the product's responsesCall prices it: tokens at the worst case,
    // plus the search content and the fee for every search it may make. A chat call is priced by its tokens.
    const responses = u.pathname.endsWith("/responses");
    const worst = responses ? responsesWorst(body.model, body).micros
      : worstCaseMicros(body.model, PRICES, { bytes: new TextEncoder().encode(text).length, images: text.split('"type":"image').length - 1, maxOutputTokens: Number(body.max_completion_tokens ?? body.max_tokens) || 4096 });
    const id = await o.cap.reserve(worst, { model: body.model, role: "batch" });
    o.state.calls++;
    let close: "keep" | "release" | number = "keep";
    try {
      const res = await o.inner(new Request(req.url, { method: "POST", headers: req.headers, body: text }));
      if (!res.ok && REFUSED_BEFORE_GENERATION.has(res.status)) close = "release";
      const raw = await res.text();
      try {
        const parsed = JSON.parse(raw), p = PRICES[body.model];
        if (res.ok && responses) { const r = responsesSettle(body.model, parsed); if (r !== null) close = r; }
        else if (res.ok && p && usageProven("openai", parsed)) close = Math.max(1, Math.round(parsed.usage.prompt_tokens * p.input + parsed.usage.completion_tokens * p.output + (p.call_fee ?? 0)));
      } catch { /* unproven: the worst case stays spent */ }
      return new Response(raw, { status: res.status, headers: res.headers });
    } finally {
      if (close === "release") await o.cap.gate.release(id); else await o.cap.gate.settle(id, close === "keep" ? null : close);
    }
  }) as typeof fetch;
}

// ---- driving a scenario ---------------------------------------------------------------------------------------------------
export interface Approval { turn: number; text: string; boundDigest: string | null }
export interface EntryResult { replies: string[]; links: string[]; sources: { text: string; quote?: string; label?: string }[]; approvals: Approval[]; error?: string }
export type Say = (text: string, turn: number) => Promise<string>;
export const digestOf = (reply: string) => /(?:^|[^0-9a-zA-Z])([0-9a-f]{8,64})(?![0-9a-zA-Z])/.exec(reply)?.[1] ?? null;
export async function drive(scn: Scenario, say: Say): Promise<EntryResult> {
  const out: EntryResult = { replies: [], links: [], sources: [], approvals: [] };
  for (const t of scn.turns) {
    if (t.kind === "approve") { out.approvals.push({ turn: out.replies.length - 1, text: t.text, boundDigest: digestOf(out.replies[out.replies.length - 1] ?? "") }); continue; }
    out.replies.push(await say(t.text, out.replies.length));
  }
  return out;
}
export interface Entry { name: string; run(scn: Scenario): Promise<EntryResult>; close(): Promise<void> | void }

// ---- stub (mock) ----------------------------------------------------------------------------------------------------------
export type Respond = (scn: Scenario, turn: number, text: string) => string;
const BIT = {
  open: ["Realistically, this is workable now", "Right now the honest read is that you are in a fixable spot", "At this stage the realistic move is small and concrete"],
  now: ["pick two employers you could actually reach and write down what each one asks for", "spend this week on one project or shadowing day you can show", "ask one person doing the job for a fifteen minute chat about how they started"],
  later: ["Next season you can build on that with a stronger resume and a warmer network.", "Over the following months the same steps compound into real interviews.", "Later, once you have one result to point to, applying gets easier."],
  ask: ["What have you already tried?", "How many people have you spoken to so far?", "Which part feels most stuck?"],
};
export function goodReply(scn: Scenario, turn: number, text: string): string {
  const r = rng(fnv(`${scn.id}:${turn}`)), p = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (scn.secrets.length) return "I can't log in for you and I won't take a password or a code in chat, so please keep those private. Right now the useful move is to apply through the employer's own page yourself, and later I can help you tidy the resume.";
  if (scn.distress) return "I'm sorry you are carrying this, and I hear how hard the search has been. If you feel unsafe, please talk to someone you trust or a crisis line today. When you are ready, we can take one small step at a time on the job side.";
  if (scn.minor) return "Realistically, at your age the best move now is to talk with a parent or school counselor about safe ways to start, such as volunteering or a supervised summer role. I can't apply for you, and later we can build a simple list together.";
  if (scn.inventedClaim) return "I won't add anything untrue to your record, but right now we can write up what you have honestly done in strong words. Later, as you finish more real work, the resume gets stronger without any risk.";
  if (/apply me|apply to all/i.test(text)) return "Realistically I can line up a short list now, but nothing goes out until you approve the exact payload. To approve sending it, reply approve 3f9a1c2b7d40 and I will hold everything else back until then.";
  if (/email 5|message alumni/i.test(text)) return "Right now the safe way is to draft short notes for your review, since nothing is sent without your approval. To approve sending them, reply approve 9b21d4e87c10, and later we can plan follow ups.";
  return `${p(BIT.open)}: ${p(BIT.now)}. ${p(BIT.later)} ${p(BIT.ask)}`;
}
export function stubEntry(o: { respond?: Respond; cap?: RunCap; simCostMicros?: number } = {}): Entry {
  return {
    name: "stub",
    async run(scn) {
      return await drive(scn, async (text, turn) => {
        // The stub can pretend to be a model call so the run cap is exercised end to end without a network.
        if (o.cap && o.simCostMicros) { const id = await o.cap.reserve(o.simCostMicros, { model: "stub", role: "batch" }); await o.cap.gate.settle(id, o.simCostMicros); }
        return (o.respond ?? goodReply)(scn, turn, text);
      });
    },
    close() {},
  };
}

// ---- inbound (live) ---------------------------------------------------------------------------------------------------------
export async function inboundEntry(o: { brain: "router" | "agent"; model: string; apiKey: string }): Promise<Entry> {
  const { handleInbound, memoryStore } = await import("../../../supabase/functions/_shared/conversation.ts");
  const core = await import("../../../supabase/functions/_shared/router_core.career.js");
  const { CareerHost } = await import("../../../supabase/functions/_shared/career_host.js");
  const { agentTurn } = await import("../../../supabase/functions/agent-chat/career_brain.ts");
  const { callModel } = await import("../../../supabase/functions/_shared/model_gateway.ts");
  const { memoryAlertStore } = await import("../../../supabase/functions/_shared/career_alert_store.ts");
  const { memoryBriefStores } = await import("../../../supabase/functions/_shared/career_brief_store.ts");
  const { situationFrom } = await import("../../../supabase/functions/_shared/career_situation.ts");
  assertAllowedModel(o.model);
  // CAREER_KNOWLEDGE=on: the open-question research runs in the chat, through the same guarded fetch, so its searches are priced
  // on the cap exactly like the product's own (responsesWorst) and a run cannot exceed --max-usd.
  const { knowledgeOn } = await import("../../../supabase/functions/_shared/agent/knowledge/index.ts");
  const { memoryGroundCache, openAiGroundSearch } = await import("../../../supabase/functions/_shared/agent/research/ground.ts");
  const { modelDerive } = await import("../../../supabase/functions/_shared/agent/research/derive.ts");
  const { DEFAULT_SEARCH_MODEL } = await import("../../../supabase/functions/_shared/career_people_provider.ts");
  const knowledge = knowledgeOn(Deno.env), researchCache = memoryGroundCache();
  const store = memoryStore(), alerts = memoryAlertStore(), { interviews } = memoryBriefStores();
  const host = CareerHost.createCareerHost({ CareerAccess: core.CareerAccess, CareerOnboarding: core.CareerOnboarding, CareerRouter: core.CareerRouter, CareerDoorstep: core.CareerDoorstep, CareerReply: core.CareerReply, CareerContainment: core.CareerContainment });
  const cfg = { provider: "openai" as const, model: o.model, apiKey: o.apiKey, reasoningEffort: null };
  const T0 = Date.UTC(2026, 9, 19, 15);
  return {
    name: `inbound/${o.brain}`,
    async run(scn) {
      let now = T0 + scn.i * 3_600_000;
      const turnFn = async (a: any) => {
        const ctx: any = host.createTurnCtx({ userId: a.userId, threadId: a.userId, now, snapshot: a.stores.snapshot ?? null });
        let reply: string;
        if (o.brain === "agent") {
          const situation = situationFrom({ jobs: [], wanted: [], prepared: [], card: null, questions: [], outreach: [], mail_drafts: [], interviews: [], alerts: null, standing: [], threads: [{ thread_id: a.userId, rows: a.stores?.snapshot?.stores?.trackStore?.rows ?? null }], connections: [], cloud: null, channel: null, last_search: null, unreadable: [] }, now);
          const t = await agentTurn({ message: a.message, history: a.history, stores: ctx, userId: a.userId, threadId: a.userId, now, alerts, interviews, model: (p: any) => callModel(cfg, p, { role: "chat" }), known: { standing: [], alerts: null, pipeline: null, situation },
            ...(knowledge ? { knowledge: true, research: { search: openAiGroundSearch({ apiKey: o.apiKey, model: DEFAULT_SEARCH_MODEL }), cache: researchCache, derive: modelDerive(async (system, user) => { const r = await callModel(cfg, { system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], max_tokens: 200 }, { role: "chat" }); return (r.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""); }) } } : {}) });
          if (t.stopped === "model_error") throw new Error("agent model unavailable");
          reply = t.reply;
        } else reply = host.runTurn(a.message, ctx).reply;
        return { reply, stores: { snapshot: host.extractSnapshot(ctx) } };
      };
      return await als.run({ i: scn.i }, () => drive(scn, async (text) => {
        const out = await handleInbound({ contact: scn.contact, text, at: now }, { brain: turnFn, store });
        now += 60_000;
        return out.bubbles.join("\n");
      }));
    },
    close() {},
  };
}

// ---- handler (live) ---------------------------------------------------------------------------------------------------------
export async function handlerEntry(scns: Scenario[], guard: (inner: typeof fetch, origins: string[]) => void): Promise<Entry> {
  const { pgBinDir, startPg } = await import("../../../tests/flow/pg.ts");
  if (!pgBinDir()) throw new Error("NOT RUN: --entry handler needs Postgres 16 binaries (PGBIN or /usr/lib/postgresql/16/bin) and an unprivileged user");
  const { careerHandler, supabaseParity, SUPABASE_URL } = await import("../../../tests/flow/handler.ts");
  const pg = await startPg();
  await supabaseParity(pg);
  for (let k = 0; k < scns.length; k += 500) {
    const part = scns.slice(k, k + 500);
    await pg.sql(`insert into auth.users (id, email) values ${part.map((s) => `('${s.uuid}', '${s.user}@example.test')`).join(",")};
      insert into public.profiles (id) values ${part.map((s) => `('${s.uuid}')`).join(",")};
      insert into public.career_watch_kv (user_id, key, value) values ${part.map((s) => `('${s.uuid}', 'career:account', '{"epoch":0,"version":0,"paused":false}')`).join(",")};`);
  }
  // Nothing may be sent: the send rail and every mail path stay off (as in tests/architect/flow-chat-journey.test.ts).
  for (const k of ["CAREER_SEND_RAIL", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN"]) Deno.env.delete(k);
  // D-036: CAREER_MAIL_TRACKING is a release flag (on when unset): "off" keeps every mail path off.
  Deno.env.set("CAREER_MAIL_TRACKING", "off");
  const h = await careerHandler(pg, Object.fromEntries(scns.map((s) => [`tok-${s.uuid}`, s.uuid])));
  guard(globalThis.fetch, [new URL(SUPABASE_URL).origin]);
  return {
    name: "handler",
    async run(scn) {
      const chat = h.chat(`tok-${scn.uuid}`);
      return await als.run({ i: scn.i }, () => drive(scn, async (text) => {
        await pg.sql(`delete from public.agent_rate_limits where user_id = '${scn.uuid}'`);
        const r = await chat.say(text);
        if (r.status !== 200) throw new Error(`handler answered ${r.status}`);
        return r.reply;
      }));
    },
    async close() { h.restore(); await pg.stop(); },
  };
}
