// B.6 REPLAY (agent2/responses, 2026-11-09; VERIFICATION-15 item 7; RESPONSE-RULES R1-R10 and section 6 gap 1, "R3
// cross-turn carry: a scenario battery over B.6 continuations, run turn by turn, asserting the carried values").
// Instinct's five continuations (tests/architect/helpers/b6_continuations.ts, the spec's turns and target replies kept
// exactly) are replayed turn by turn, one thread each, through the REAL handler on real Postgres 16
// (tests/architect/helpers/response_world.ts). Every reply is scored with the reply rubric (checkReply, with the earlier
// replies of the thread, the person's zone, and whether the turn leaves a decision), and the carried values are checked: at
// the turn where the person gives or corrects a role, place, recipient or subject the reply names it, and from then on no
// reply brings back the value they ruled out.
//   S  staged brain, scripted model: production's brain (CAREER_BRAIN=staged) with a scripted Anthropic wire that answers each
//      turn with the spec's own target reply. What is measured is everything the product does around a good model answer:
//      the code-first handlers that claim the turn instead, the loop's guards, and the notes appended after. Bar: 0.
//   R  router only, no model: the same turns with no model key, the code's own words (the rollback path, and what a person
//      reads when the model is unavailable). Measured and printed; it may not get worse than the recorded count.
// Each phase prints: B6 <phase>: <turns> turns, <violations> rubric violations, <carry> carry failures.
import assertNode from "node:assert/strict";
import { checkReply, describe } from "../../supabase/functions/_shared/reply_rubric.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { B6, type B6Continuation } from "./helpers/b6_continuations.ts";
import { canRun, openWorld, type World, ZONE } from "./helpers/response_world.ts";

// R's counts when this test was written (agent2/responses). Lower them when a fix lands; never raise them.
const ROUTER_CEILING = { violations: 16, carry: 3 };

// The scripted model: the spec's target reply for the latest B.6 turn in the request.
const TURNS = B6.flatMap((c) => c.turns);
function scripted(chat: any): Response {
  const users = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  const last = users.at(-1) ?? "";
  const hit = TURNS.filter((t) => last.includes(t.say)).sort((a, b) => b.say.length - a.say.length)[0]
    ?? TURNS.filter((t) => users.some((u: string) => u.includes(t.say))).at(-1);
  const content = chat.response_format ? "{}" : (hit?.target ?? "I can't answer that from this chat yet.");
  return Response.json({ id: "chatcmpl-b6", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
}

// asModel: the delivered reply is the scripted model's answer (the spec's target), unchanged by the product.
interface Row { c: string; turn: number; say: string; intent: string | null; reply: string; lines: string[]; asModel: boolean }
async function replay(w: World, cs: B6Continuation[]): Promise<{ rows: Row[]; carry: string[] }> {
  const rows: Row[] = [], carry: string[] = [];
  for (const c of cs) {
    const p = await w.person({ resume: c.resume });
    const prev: string[] = [];
    for (const [k, t] of c.turns.entries()) {
      const r = await p.say(t.say);
      assertNode.equal(r.status, 200, `${c.id} turn ${k + 1}: HTTP ${r.status}`);
      const res = checkReply({ ask: t.say, reply: r.reply, channel: "telegram", timeZone: ZONE, previousReplies: [...prev], decisionPending: !!t.decision });
      rows.push({ c: c.id, turn: k + 1, say: t.say, intent: r.intent, reply: r.reply, lines: describe(res), asModel: r.reply.trim() === t.target.trim() });
      for (const cr of c.carry) {
        if (k + 1 === cr.from && cr.named !== false && !cr.value.test(r.reply)) carry.push(`${c.id} turn ${k + 1} (${cr.kind}): the reply drops ${cr.value} | ${r.reply.slice(0, 200)}`);
        if (k + 1 >= cr.from && cr.never?.test(r.reply)) carry.push(`${c.id} turn ${k + 1} (${cr.kind}): the reply brings back ${cr.never} | ${r.reply.slice(0, 200)}`);
      }
      prev.push(r.reply);
    }
  }
  return { rows, carry };
}
// On the staged path a violation in a reply that IS the spec's target, unchanged, is the rubric disagreeing with the spec's
// own proposed text, not something the product did: it is printed and counted apart (a finding for the rubric's owner).
function report(phase: string, out: { rows: Row[]; carry: string[] }, apartSpec = false): number {
  const specOnly = apartSpec ? out.rows.filter((r) => r.lines.length && r.asModel) : [];
  for (const r of specOnly) console.log(`[${phase} ${r.c} t${r.turn}] spec target, delivered unchanged, flagged by the rubric: "${r.reply.slice(0, 160)}"\n  ${r.lines.join("\n  ")}`);
  const bad = out.rows.filter((r) => r.lines.length && !specOnly.includes(r));
  for (const r of bad) console.log(`[${phase} ${r.c} t${r.turn}] (${r.intent}) "${r.say}"\n  reply: ${r.reply.replace(/\n/g, " / ").slice(0, 300)}\n  ${r.lines.join("\n  ")}`);
  for (const f of out.carry) console.log(`[${phase} carry] ${f}`);
  const v = bad.reduce((n, r) => n + r.lines.length, 0);
  const model = out.rows.filter((r) => r.asModel).length;
  console.log(`B6 ${phase}: ${out.rows.length} turns, ${v} rubric violations in ${bad.length} replies, ${out.carry.length} carry failures${apartSpec ? `; ${model} turns delivered the model's answer unchanged, ${specOnly.length} spec targets flagged by the rubric (not counted)` : ""}`);
  return v;
}

Deno.test({
  name: "B.6 replay: Instinct's five continuations turn by turn, R1-R10 and the carried role, place, recipient and subject",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: B.6 replay not run`); return; }
    const w = await openWorld(2 * B6.length + 2, { model: (req) => anthropicWire(req, scripted) });
    const result: Record<string, unknown> = {};
    try {
      await t.step("R: router only, no model (may not get worse than the recorded count)", async () => {
        const r = await replay(w, B6);
        const v = report("ROUTER", r);
        result.router = { turns: r.rows.length, violations: v, carry: r.carry.length, rows: r.rows, carryFailures: r.carry };
        assertNode.ok(v <= ROUTER_CEILING.violations, `router-only violations rose: ${v} > ${ROUTER_CEILING.violations}`);
        assertNode.ok(r.carry.length <= ROUTER_CEILING.carry, `router-only carry failures rose: ${r.carry.length} > ${ROUTER_CEILING.carry}`);
      });
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      await t.step("S: staged brain with the spec's target replies as the model (bar: 0)", async () => {
        const r = await replay(w, B6);
        const v = report("STAGED", r, true);
        result.staged = { turns: r.rows.length, violations: v, carry: r.carry.length, rows: r.rows, carryFailures: r.carry };
        assertNode.equal(v, 0, `${v} rubric violations on the staged path (listed above)`);
        assertNode.deepStrictEqual(r.carry, [], "carried values");
      });
      assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
    } finally {
      const out = Deno.env.get("B6_REPLAY_OUT");
      if (out) Deno.writeTextFileSync(out, JSON.stringify(result, null, 1));
      await w.close();
    }
  },
});
