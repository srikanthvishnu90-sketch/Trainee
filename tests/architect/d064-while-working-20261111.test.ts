// D-064 (architect, 2026-11-11): G13, several messages while work runs, from the handler's own signal, and G5 over G3. $0: every
// migration on a throwaway Postgres 16, the real career handler, a SCRIPTED model on the Anthropic wire, production's release flags
// (P4). Two turns on one conversation where the second arrives before the first's reply: the turn gate (career_turn_gate.ts) holds the
// second until the first commits, and that wait is the in-flight signal: the second is the brain's, told what the first asked, even
// when on its own it would be code's (a plain search). Turns sent one after another stay as they were.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d064-while-working-20261111.test.ts
import assertNode from "node:assert/strict";
import { RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { SEARCH_NOT_CHECKED } from "../../supabase/functions/_shared/career_search_judge.ts";
import { whileWorkingNote } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const SLOW = "what should my first week of recruiting look like for product analyst roles";
const SECOND = "find me data analyst internships in Chicago";

Deno.test("D064-1 the note and the caveat are instructions and one plain clause, not reply prose", () => {
  assertNode.match(whileWorkingNote(SLOW), /^THIS MESSAGE ARRIVED WHILE YOU WERE STILL WORKING ON THEIR PREVIOUS ONE/);
  assertNode.ok(whileWorkingNote(SLOW).includes(JSON.stringify(SLOW)));
  assertNode.match(SEARCH_NOT_CHECKED, /\bnot checked\b/);
});

Deno.test({ name: "D064-2 through the real handler: a second message that arrives before the first's reply is the brain's, told what came first", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("D064-2 needs Postgres 16 in CI");
  const seen: { last: string; system: string }[] = [];
  let release: (() => void) | null = null, hold = false;
  const firstHeld = new Promise<void>((r) => (release = r));
  const scripted = (chat: any) => Response.json({ id: "d064", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : "scripted" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const model = async (req: Request) => {
    const body = await req.clone().json().catch(() => ({}));
    const msgs = (body.messages ?? []) as any[];
    const last = JSON.stringify(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
    if (!body.output_config?.format) seen.push({ last, system: JSON.stringify(body.system ?? "") });
    // The first turn's model call is held until the second message has been sent, so the second arrives while the first runs.
    if (hold && last.includes(SLOW)) await firstHeld;
    return await anthropicWire(req, scripted);
  };
  const w = await openWorld(3, { model });
  // Architect amendment (test isolation only, no assertion changed): every variable this test clears is put back as it found it
  // at close. It deleted the gate's explicit release-flag "off"s and never restored them, so CAREER_TEXTING_NATIVE fell to its
  // release default (on) for every later file in the same shard (flow-telegram-e2e: parse_mode HTML), as D-066 and D-072 found.
  const touched = [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, "ANTHROPIC_API_KEY"];
  const envBefore = new Map(touched.map((k) => [k, Deno.env.get(k)]));
  try {
    for (const k of [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
    // Control: one after another, the search is code's (no model call for it).
    const calm = await w.person({ resume: true });
    await calm.say(SLOW);
    const n0 = seen.length;
    await calm.say(SECOND);
    assertNode.equal(seen.length, n0, "a search sent after the reply stays code's");

    const p = await w.person({ resume: true });
    await p.say("hi"); // the conversation exists (its thread), as when a person texts twice in a row
    const nBefore = seen.length;
    hold = true;
    const first = p.say(SLOW);
    // Let the first turn take the gate and reach the model before the second is sent.
    for (let i = 0; i < 200 && !seen.slice(nBefore).some((s) => s.last.includes(SLOW)); i++) await new Promise((r) => setTimeout(r, 50));
    assertNode.ok(seen.slice(nBefore).some((s) => s.last.includes(SLOW)), "the first turn is at the model");
    const n1 = seen.length;
    const second = p.say(SECOND);
    await new Promise((r) => setTimeout(r, 400));
    release!();
    const [a, b] = await Promise.all([first, second]);
    assertNode.equal(a.status, 200); assertNode.equal(b.status, 200);
    const later = seen.slice(n1).filter((s) => s.last.includes(SECOND));
    assertNode.ok(later.length > 0, "the second message reached the brain");
    assertNode.ok(later.some((s) => s.system.includes("THIS MESSAGE ARRIVED WHILE YOU WERE STILL WORKING ON THEIR PREVIOUS ONE") && s.system.includes("product analyst")), "the brain is told what the first message asked");
    for (const t of ["career_apply_receipts", "career_apply_jobs", "career_apply_prepared", "career_outbox", "career_contact_sends"]) {
      if (!(await w.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t")) continue;
      assertNode.equal((await w.pg.sql(`select count(*) from public.${t} where user_id = '${p.id}'`)).replace(/\D+/g, " ").trim().split(" ")[0], "0", `${t} has rows`);
    }
    assertNode.deepEqual(w.outbound, [], "a request left the machine");
  } finally {
    for (const [k, v] of envBefore) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await w.close();
  }
} });
