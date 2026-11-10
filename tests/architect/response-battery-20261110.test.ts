// THE 1,000-ASK BATTERY (r-audit, 2026-11-10; VERIFICATION-15 item 7; RESPONSE-RULES.md sections 1 and 2). It extends the
// response sweep (99 templated replies) to 1,000 seeded asks (tests/architect/helpers/ask_battery.ts): varied phrasings of
// every section 2 intent, typos, two intents in one message, corrections, off-topic asks and asks sent while the AI budget is
// switched off. Each ask runs on its own thread through the REAL handler on Postgres 16 with every migration
// (tests/architect/helpers/response_world.ts), and each reply is scored with the reply rubric (checkReply, with the thread's
// earlier replies, the person's zone and whether a decision is pending) and with the section 2 row's Must and Never columns.
//   S  staged brain (production's CAREER_BRAIN=staged) with a scripted model that answers each ask with the section 2 target
//      shape for its intent. The targets pass the rubric and every Never check on their own (asserted first), so whatever
//      is flagged was done by the product around a good model answer. Bar: 0 rubric violations and 0 Never hits.
//   R  router only, no model key: the code's own words. The ceiling is recorded and may only go down.
// Prints: BATTERY <phase>: <asks> asks, <rubric> rubric violations in <n> replies, <never> never hits, <must> must misses.
import assertNode from "node:assert/strict";
import { checkReply, describe } from "../../supabase/functions/_shared/reply_rubric.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { type Ask, battery, bringsBack, SETUP_TARGETS } from "./helpers/ask_battery.ts";
import { canRun, openWorld, type World, ZONE } from "./helpers/response_world.ts";

// R's counts when this test was written. Lower them when a fix lands; never raise them.
const ROUTER_CEILING = { rubric: 391, never: 0 };
// S: the bar is 0 and 0. Never is at its bar. The rubric count left (2026-11-10) is a ratchet, not an allowance: 5 are code
// products longer than a short ask allows (company file and interview brief), which RESPONSE-RULES 3.1 puts in a File, not
// served yet (section 6 gap 2; the coordinator keeps them counted until File serving and the card land), and 1 is the
// coordinator's own plain-words queue-halt reply ("I have not paused your account. ..."), whose lead R1 does not read as an
// answer to "stop everything for now??". Lower it as each lands; never raise it.
const STAGED_CEILING = { rubric: 6, never: 0 };

const ASKS = battery();
const PAIRS: [string, string][] = [...ASKS.flatMap((a) => [[a.say, a.target] as [string, string], ...a.setup.map((s) => [s.say, s.target] as [string, string])])];
const ANSWERS = new Map(PAIRS);
let modelCalls = 0;
function scripted(chat: any): Response {
  modelCalls++;
  const users = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  const last = users.at(-1) ?? "";
  let best = "";
  for (const k of ANSWERS.keys()) if (k.length > best.length && last.includes(k)) best = k;
  const content = chat.response_format ? "{}" : (best ? ANSWERS.get(best)! : "I can't answer that from this chat yet, because the ask did not reach me.");
  return Response.json({ id: "chatcmpl-battery", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
}

interface Row { id: string; kind: string; intent: string; say: string; reply: string; routed: string | null; lines: string[]; never: string[]; must: string[]; reachedModel: boolean; asModel: boolean }
async function paused(w: World, id: string): Promise<boolean | null> {
  const rows = await w.pg.sql(`select value->>'paused' as p from public.career_watch_kv where user_id = '${id}' and key = 'career:account'`) as unknown as { p: string }[] | string;
  const t = typeof rows === "string" ? rows : JSON.stringify(rows);
  return /true/.test(t) ? true : /false/.test(t) ? false : null;
}
function judge(a: Ask, reply: string, body: unknown, isPaused: boolean | null, prev: string[]) {
  const res = checkReply({ ask: a.say, reply, channel: "telegram", timeZone: ZONE, previousReplies: prev, decisionPending: a.decision });
  const ctx = { reply, ask: a.say, body, paused: isPaused };
  const never = a.never.map((n) => { const h = n.hit(ctx); return h ? `${n.name}: "${h.slice(0, 120)}"` : null; }).filter(Boolean) as string[];
  const must = a.must.map((m) => (m.hit(ctx) ? m.name : null)).filter(Boolean) as string[];
  if (a.carry) {
    if (!a.carry.value.test(reply)) must.push(`R3 names the corrected ${a.carry.label}`);
    const back = bringsBack(reply, a.carry.ruledOut, a.carry.value);
    if (back) never.push(`R3 brings back the ruled-out ${a.carry.label}: "${back.slice(0, 120)}"`);
  }
  return { lines: describe(res), never, must };
}

async function run(w: World, staged: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  for (const a of ASKS) {
    const p = await w.person({ resume: a.resume });
    const prev: string[] = [];
    for (const s of a.setup) { const r = await p.say(s.say); prev.push(r.reply); }
    if (staged && a.kind === "limit") Deno.env.set("MODEL_BUDGET_PAUSED", "true");
    const before = modelCalls;
    const r = await p.say(a.say).finally(() => Deno.env.delete("MODEL_BUDGET_PAUSED"));
    assertNode.equal(r.status, 200, `${a.id} "${a.say}": HTTP ${r.status}`);
    const j = judge(a, r.reply, r.body, a.intent === "pause" ? await paused(w, p.id) : null, prev);
    rows.push({ id: a.id, kind: a.kind, intent: a.intent, say: a.say, reply: r.reply, routed: r.intent, ...j, reachedModel: modelCalls > before, asModel: r.reply.trim() === a.target.trim() });
  }
  return rows;
}

function report(phase: string, rows: Row[]) {
  const bad = rows.filter((r) => r.lines.length || r.never.length);
  for (const r of bad) console.log(`[${phase} ${r.id} ${r.kind}/${r.intent}] (${r.routed}) "${r.say}"\n  reply: ${r.reply.replace(/\n/g, " / ").slice(0, 300)}\n  ${[...r.lines, ...r.never.map((n) => `NEVER ${n}`)].join("\n  ")}`);
  const rubric = rows.reduce((n, r) => n + r.lines.length, 0), never = rows.reduce((n, r) => n + r.never.length, 0), must = rows.reduce((n, r) => n + r.must.length, 0);
  const byRule = new Map<string, number>(), byKind = new Map<string, [number, number]>(), byIntent = new Map<string, [number, number]>();
  for (const r of rows) {
    for (const l of r.lines) { const k = l.split(":")[0]; byRule.set(k, (byRule.get(k) ?? 0) + 1); }
    for (const n of r.never) { const k = `never/${n.split(":")[0]}`; byRule.set(k, (byRule.get(k) ?? 0) + 1); }
    const f = r.lines.length || r.never.length ? 1 : 0;
    const k = byKind.get(r.kind) ?? [0, 0]; byKind.set(r.kind, [k[0] + 1, k[1] + f]);
    const i = byIntent.get(r.intent) ?? [0, 0]; byIntent.set(r.intent, [i[0] + 1, i[1] + f]);
  }
  console.log(`BATTERY ${phase} by rule: ${[...byRule].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`BATTERY ${phase} by kind (asks/flagged): ${[...byKind].map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(", ")}`);
  console.log(`BATTERY ${phase} by intent (asks/flagged): ${[...byIntent].map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(", ")}`);
  const reached = rows.filter((r) => r.reachedModel).length, asModel = rows.filter((r) => r.asModel).length;
  console.log(`BATTERY ${phase}: ${rows.length} asks, ${rubric} rubric violations in ${rows.filter((r) => r.lines.length).length} replies, ${never} never hits, ${must} must misses; ${reached} reached the model, ${asModel} delivered its answer unchanged`);
  return { rubric, never, must };
}

Deno.test("battery: 1,000 distinct seeded asks, every section 2 intent, each target clean on its own", () => {
  assertNode.equal(ASKS.length, 1000);
  assertNode.equal(new Set(ASKS.map((a) => a.say)).size, 1000, "every ask is distinct");
  for (const [k] of SETUP_TARGETS) assertNode.ok(k.length);
  // The script's own answers break nothing: otherwise a violation could be the battery's words, not the product's.
  const broken: string[] = [];
  for (const a of ASKS) {
    const j = judge(a, a.target, {}, a.intent === "pause" ? false : null, []);
    // A limit ask never reaches the model (the budget is off), so its Must is about the code's reply, not the target.
    const mustLeft = a.kind === "limit" ? [] : j.must;
    if (j.lines.length || j.never.length || mustLeft.length) broken.push(`${a.id} ${a.intent} "${a.say}" -> "${a.target}"\n  ${[...j.lines, ...j.never, ...mustLeft].join("\n  ")}`);
  }
  const firstPerIntent = [...new Map(broken.map((b) => [b.split(" ")[1], b])).values()];
  assertNode.equal(broken.length, 0, `${broken.length} scripted targets are not clean; one per intent:\n${firstPerIntent.join("\n")}`);
  const kinds = new Map<string, number>();
  for (const a of ASKS) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  console.log(`BATTERY asks by kind: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ")}; intents ${new Set(ASKS.map((a) => a.intent)).size}`);
});

Deno.test({
  name: "battery: 1,000 asks through the real handler, staged with the scripted model (bar: 0 rubric, 0 never) and router only (ceiling)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: battery not run`); return; }
    const people = 2 * ASKS.length + 2;
    const w = await openWorld(people, { model: (req) => anthropicWire(req, scripted) });
    const out: Record<string, unknown> = {};
    try {
      await t.step("R: router only, no model (ceiling)", async () => {
        const rows = await run(w, false);
        const s = report("ROUTER", rows);
        out.router = { ...s, rows };
        assertNode.ok(s.rubric <= ROUTER_CEILING.rubric, `router-only rubric violations rose: ${s.rubric} > ${ROUTER_CEILING.rubric}`);
        assertNode.ok(s.never <= ROUTER_CEILING.never, `router-only never hits rose: ${s.never} > ${ROUTER_CEILING.never}`);
      });
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      await t.step("S: staged brain, scripted model (bar: 0 rubric violations, 0 never hits; ratchet below)", async () => {
        const rows = await run(w, true);
        const s = report("STAGED", rows);
        out.staged = { ...s, rows };
        console.log(`BATTERY STAGED against the bar (0 and 0): ${s.rubric} rubric violations, ${s.never} never hits`);
        assertNode.ok(s.rubric <= STAGED_CEILING.rubric, `staged rubric violations rose: ${s.rubric} > ${STAGED_CEILING.rubric} (listed above)`);
        assertNode.equal(s.never, STAGED_CEILING.never, `${s.never} never hits on the staged path (listed above)`);
      });
      assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      Deno.env.delete("MODEL_BUDGET_PAUSED");
      const f = Deno.env.get("BATTERY_OUT");
      if (f) Deno.writeTextFileSync(f, JSON.stringify(out, null, 1));
      await w.close();
    }
  },
});
