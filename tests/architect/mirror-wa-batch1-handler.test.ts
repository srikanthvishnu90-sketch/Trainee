// MIRROR WA-1, the whole conversation through the real handler (architect, 2026-11-11). The owner's WhatsApp benchmark against
// Instinct (evals/mirror/instinct-wa-batch1/: the 26 turns in order, the persona with fictional names) is the standard Trainee is
// held to. This runs it at $0: every migration on a throwaway Postgres 16, the real career handler, a SCRIPTED model, every host
// but the database double refused. It cannot judge what the model says (the live run does: evals/mirror/instinct-wa-batch1/
// results/), so it pins what code decides, where the dry run of 2026-11-11 showed code answering a different task:
//   - which turns code answers: only the search (C3), the record reads (C6, C16), and the people list (C19);
//     every other turn reaches the brain (before: 18 of 26 were code's, 11 of them scored as interview answers);
//   - no reply is a keyword-rubric score ("Your answer, scored: 2/15") and none serves a practice question for a research ask;
//   - the hypothetical offer (C7) records no offer; the search's scope names the title, not "could actually right now";
//   - nothing is queued, prepared, submitted or sent, and no request leaves the machine (every ask says don't apply / don't send).
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/mirror-wa-batch1-handler.test.ts
import assertNode from "node:assert/strict";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const lines = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const turns: { id: string; prompt: string }[] = lines("prompts.jsonl");
const persona: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
// Architect amendment (D-062; owner, 2026-11-11: "find alumni, do all of it"): C19's people search is on (CAREER_PEOPLE_SEARCH in
// RELEASE_FLAGS), so C19 reaches the brain (find_people). C6 and C16 stay code's HERE only because this shared world rolls
// CAREER_MAIL_TRACKING back to "off" (response_world.ts); under production flags they are the brain's too (mirror-wa-batch1-process
// MP-1, d062-capabilities-process). Every other assertion is unchanged.
const CODE_TURNS = ["C3", "C6", "C16"];

Deno.test({ name: "WA1-H the benchmark conversation: code answers only its own work, and nothing acts", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("WA1-H needs Postgres 16 in CI");
  assertNode.equal(turns.length, 26, "the 23 scenarios and their 3 follow-ups");
  let label = "", calls = 0;
  const scripted = (chat: any) => { calls++; return Response.json({ id: "wa1", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : `scripted (${label})` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }); };
  const w = await openWorld(2, { model: (req) => anthropicWire(req, scripted) });
  try {
    Deno.env.set("CAREER_BRAIN", "staged");
    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
    const person = await w.person({ resume: false });
    for (const s of persona.setup) { label = "setup"; await person.say(s); }
    const code: string[] = [], replies: Record<string, string> = {};
    for (const t of turns) {
      label = t.id;
      const before = calls;
      const r = await person.say(t.prompt);
      replies[t.id] = String(r.reply ?? "");
      if (calls === before) code.push(t.id);
    }
    assertNode.deepEqual(code, CODE_TURNS, `code answered ${code.join(",")}`);
    for (const [id, reply] of Object.entries(replies)) {
      assertNode.ok(!/Your answer, scored: \d+\/15|read against the rubric/.test(reply), `${id} was scored as an interview answer: ${reply.slice(0, 120)}`);
      assertNode.ok(!/^Your (?:coding|behavioral) question:|^Here is your question:/.test(reply), `${id} served a practice question: ${reply.slice(0, 120)}`);
    }
    assertNode.ok(!/\b(?:could|actually|right now)\b/i.test(replies.C3.split("\n")[0]), `C3's scope: ${replies.C3.slice(0, 160)}`);
    const offers = await w.pg.sql(`select count(*) from public.agent_flow_state where user_id = '${person.id}' and state::text ~ '120,?000'`);
    assertNode.equal(offers.replace(/\D+/g, " ").trim().split(" ")[0], "0", "the hypothetical offer was recorded");
    for (const t of ["career_apply_receipts", "career_apply_jobs", "career_apply_prepared", "career_outbox", "career_contact_sends"]) {
      const exists = (await w.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t");
      if (!exists) continue;
      const n = (await w.pg.sql(`select count(*) from public.${t} where user_id = '${person.id}'`)).replace(/\D+/g, " ").trim().split(" ")[0];
      assertNode.equal(n, "0", `${t} has rows`);
    }
    assertNode.deepEqual(w.outbound, [], "a request left the machine");
  } finally {
    Deno.env.delete("CAREER_BRAIN");
    Deno.env.delete("ANTHROPIC_API_KEY");
    await w.close();
  }
} });
