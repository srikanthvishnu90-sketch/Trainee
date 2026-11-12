// D-072 (item 9b, architect, 2026-11-12): the d054 memory set on the real model was 40/50 (brain-eval run 43194037044, five
// passes on 44b436f9; replies in evals/career/results/d054-staged-43194037044-p*.json on ci/brain-eval, data commit 2ae3a5127).
// Every miss, by root cause in code (docs/architect/reports/ITEM9B-ROOT-CAUSES-20261112.md):
//   M04 x5  judge disagreement with the pinned one-question-per-reply ruling (#745): judge B wants both answers asked in one
//           reply. Ruled (D-072): the eval line states the ruling; the reply is unchanged and still meets the bar.
//   M08 x3  code's read-back (profile_recall) never said the answer was a correction (judge B: "does not acknowledge the
//           correction"); the earlier answer was overwritten, so nothing could say it. A correction now keeps what it replaced
//           (statedFacts.replaced) and the read-back says it.
//   M07 x1  the brain's context listed the school the person stated IN THIS CHAT under "from their account, not from this
//           chat"; the model said Purdue "was already waiting on your yes from before this chat" and Northwestern "was never
//           saved" (judge B: invents a prior yes). The row now says it was said in this chat, when, and what it corrected.
//   M05 x1  the model answered a reuse of a salary expectation without asking and without naming where $85,000 came from
//           (D-053: asked per application). Code now guards it: the earlier answer is shown with its source and asked again.
// Each case is replayed from the eval's own words through evals/career/run.ts makeBrain (the path the eval runs: handleInbound,
// the staged decision, CareerHost, the in-memory stores) and, where Postgres 16 is present, through the real agent-chat handler.
// The model is scripted wherever the brain answers: $0, no network, nothing sent.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d072-item9b-memory-20261112.test.ts
import assertNode from "node:assert/strict";
import { makeBrain } from "../../evals/career/run.ts";
import { checkReply } from "../../supabase/functions/_shared/reply_rubric.ts";
import { personBlock } from "../../supabase/functions/_shared/agent/memory.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SET = JSON.parse(await Deno.readTextFile(new URL("../../evals/career/d054-items-7-9.json", import.meta.url)));
const item = (id: string) => SET.items.find((i: any) => i.id === id);
const RULES = ["answers_first", "boilerplate_tail", "internal", "ends_at_decision", "leaked_instruction", "repeats_ask"];
const rubric = (ask: string, reply: string) =>
  checkReply({ ask, reply, channel: "telegram", timeZone: ZONE }).violations.filter((v) => RULES.includes(v.rule)).map((v) => `${v.rule}: ${v.quote ?? v.detail}`);
const ONE_QUESTION = (r: string) => (r.match(/\?/g) ?? []).length === 1 && /\?$/.test(r.trim());

// The scripted model: it records every system prompt it is sent; on M05's first turn it does what the real model did in all five
// passes (add_profile_fact with the person's words), else it answers with a mark.
const seen: string[] = [];
let toolN = 0;
const MARK = "SCRIPTED MODEL REPLY";
const NORTHLINE_FACT = "Expected salary is $85,000 (for the Northline Health application)"; // pass 1's add_profile_fact text
const scripted = async (p: any) => {
  seen.push(typeof p.system === "string" ? p.system : JSON.stringify(p.system));
  const last = (p.messages ?? []).filter((m: any) => m.role === "user").at(-1);
  const toolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result");
  if (!toolResult && /For the Northline Health application I told you/.test(JSON.stringify(last?.content ?? ""))) {
    return { content: [{ type: "tool_use", id: `t${++toolN}`, name: "add_profile_fact", input: { kind: "preference", text: NORTHLINE_FACT } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
  }
  return { content: [{ type: "text", text: MARK }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
};
const brain = await makeBrain({ name: "staged", model: scripted, env: { get: (k: string) => Deno.env.get(k) } });
const harness = async (id: string, turns?: string[]) => await brain(turns ?? item(id).turns, item(id));

// ------------------------------------------------------------------------------------------------- M08 (code, 3 of 5)
Deno.test("D72-1 M08 (code): the corrected sponsorship answer is read back as a correction, once, with the other fact said", async () => {
  // Run 43194037044 pass 1 (judge B FAIL: "terse and does not acknowledge the correction or the invalidated prior packets").
  const LIVE = 'No: you told me you don\'t need visa sponsorship.\nOn record: work authorization — "I don\'t need visa sponsorship". On record: you do not need visa sponsorship.';
  ok(!/first told me|corrected/.test(LIVE));
  const r = await harness("M08");
  eq(r.trace?.map((t) => t.route), ["router", "router", "router"]);
  const last = r.replies[2];
  ok(/^No: you told me you don't need visa sponsorship\./.test(last), last);
  ok(/You first told me you need sponsorship, then corrected it; the corrected answer is the one I use\./.test(last), last);
  ok(/On record: you're a US citizen\./.test(last), `the other fact they said is read back: ${last}`);
  eq((last.match(/need visa sponsorship/g) ?? []).length, 2, `the answer and the person's own quote, nothing repeated: ${last}`);
  ok(!/you need sponsorship\.$|Yes:/.test(last.trim()), last);
  eq(rubric(item("M08").turns[2], last), [], last);
  // What it replaced is kept beside the record, never as the current answer.
  const sf = (r as any).state?.stores?.statedFacts;
  eq(sf.facts.find((f: any) => f.kind === "sponsorship").value, "does not need sponsorship");
  eq(sf.replaced.map((x: any) => [x.kind, x.value]), [["sponsorship", "needs sponsorship"]]);
});

Deno.test("D72-2 no correction, no correction line: a sponsorship answer stated once is read back as before", async () => {
  const r = await harness("M08", ["I'm a US citizen and I don't need visa sponsorship", "do I need sponsorship?"]);
  const last = r.replies.at(-1)!;
  ok(/^No: you told me you don't need visa sponsorship\./.test(last), last);
  ok(!/first told me|corrected/.test(last), last);
});

// ------------------------------------------------------------------------------------------------- M07 (model, 1 of 5)
Deno.test("D72-3 M07 (model): the school said in this chat reaches the model as said in this chat, with what it corrected", async () => {
  // Run 43194037044 pass 1, the model's reply (judge B FAIL: "invents a claim about a prior 'yes' and prior saved state").
  const LIVE = "You go to Purdue University. You first said Northwestern, then told me you transferred, so Purdue replaces it. One correction on my earlier replies: I said both were recorded, but I hadn't saved anything yet. Purdue was already waiting on your yes from before this chat, and Northwestern was never saved. Is it right that you go to Purdue University now?";
  ok(/from before this chat/.test(LIVE));
  seen.length = 0;
  const r = await harness("M07");
  eq(r.trace?.map((t) => t.route), ["router", "router", "brain"]);
  eq(r.replies[2], MARK);
  const sys = seen.at(-1)!;
  const row = sys.split("\n").find((l) => /\[school\]/.test(l)) ?? "";
  ok(/you go to Purdue University now/.test(row), row);
  ok(/they said this in this chat on \d{4}-\d{2}-\d{2}, and it was saved in their words/.test(row), row);
  ok(/it corrects what they said before in this chat: "you go to Northwestern University"/.test(row), row);
  ok(/not confirmed yet\)$/.test(row), row);
  // It stays under the drafts heading: never usable in an application before their yes.
  ok(sys.indexOf(row) > sys.indexOf("Facts waiting for their yes"), "under the drafts heading");
});

Deno.test("D72-4 personBlock: an account fact is not labelled as said in chat; a chat fact with no correction names none", () => {
  const out = personBlock({ profile: { facts: [
    { id: "F-1", kind: "education", text: "BS Statistics, Lakeshore University", status: "draft", needs_confirmation: true },
    { id: "stated-geography-0", kind: "geography", text: "you're targeting Austin", said_in_chat: true, said_at: "2026-11-12T10:00:00.000Z" },
  ] }, standing: [], alerts: null, pipeline: null });
  const lines = out.split("\n");
  eq(lines.find((l) => l.includes("F-1")), "- F-1 [education] BS Statistics, Lakeshore University");
  eq(lines.find((l) => l.includes("stated-geography-0")), "- stated-geography-0 [geography] you're targeting Austin (they said this in this chat on 2026-11-12, and it was saved in their words; not confirmed yet)");
});

// ------------------------------------------------------------------------------------------------- M05 (model, 1 of 5)
Deno.test("D72-5 M05 (D-053): reusing a salary expectation names where it was given and asks again for this application", async () => {
  // Run 43194037044 pass 5, the model's reply (judge A FAIL: never asks to confirm for Lakefront, never ties $85,000 to Northline).
  const LIVE = "You don't have a Lakefront Data application on file yet, so there's nothing to attach the salary to. Once one exists, I'll use $85,000 as the expected salary there too.";
  ok(!/Northline/.test(LIVE));
  const r = await harness("M05");
  eq(r.trace?.map((t) => t.route), ["brain", "router"]);
  const last = r.replies[1];
  eq((r.trace?.[1] as any)?.intent, "sensitive_answer_ask");
  ok(/^Expected salary is asked for each application, so I won't carry it over to Lakefront Data on my own\./.test(last), last);
  ok(/\$85,000 is the expected salary you gave for the Northline Health application\./.test(last), last);
  ok(ONE_QUESTION(last) && /Should I use \$85,000 as your expected salary for Lakefront Data too\?$/.test(last.trim()), last);
  eq([...last.matchAll(/\$\s?\d[\d,]*/g)].map((m) => m[0]), ["$85,000", "$85,000"], "no other figure");
  ok(!/\bsubmitted\b(?! or sent)|\bwas sent\b|\bapplied\b/i.test(last.replace(/Nothing has been filled in, submitted or sent\./, "")), last);
  eq(rubric(item("M05").turns[1], last), [], last);
  eq((r as any).outcome?.sent ?? 0, 0);
});

Deno.test("D72-6 M05 follow-up: a yes keeps $85,000 for Lakefront Data only; a no asks for their figure; a stated figure is theirs", async () => {
  const yes = await harness("M05", [...item("M05").turns, "yes"]);
  ok(/^Noted, in your words: you expect \$85,000 for Lakefront Data\./.test(yes.replies[2]), yes.replies[2]);
  const sf = (yes as any).state?.stores?.statedFacts;
  eq(sf.facts.filter((f: any) => f.kind === "salary_expectation").map((f: any) => [f.value, f.key]), [["$85,000", "Lakefront Data"]]);
  ok(/yes to \$85,000, the answer given for Northline Health/.test(sf.facts[0].evidence), sf.facts[0].evidence);
  // The Northline answer the model saved is untouched (never re-keyed to another employer).
  ok(((yes as any).state?.stores?.profile?.facts ?? []).some((f: any) => f.text === NORTHLINE_FACT), "Northline's answer stays as it was");
  const no = await harness("M05", [...item("M05").turns, "no"]);
  ok(/^Okay, I won't use \$85,000 for Lakefront Data\./.test(no.replies[2]) && /What salary do you expect for the Lakefront Data role\?$/.test(no.replies[2].trim()), no.replies[2]);
  eq(((no as any).state?.stores?.statedFacts?.facts ?? []).filter((f: any) => f.kind === "salary_expectation").length, 0, "nothing kept on a no");
  const typed = await harness("M05", [...item("M05").turns, "no", "$90,000"]);
  ok(/you expect \$90,000 for Lakefront Data/.test(typed.replies[3]), typed.replies[3]);
});

Deno.test("D72-7 the guard stands down: no earlier figure, a figure in the message, a negotiation, no company named", async () => {
  for (const turns of [
    ["Use the same expected salary for the Lakefront Data application"], // nothing on file: the model answers
    [item("M05").turns[0], "Use $90,000 as my expected salary for the Lakefront Data application too"],
    [item("M05").turns[0], "use the same salary when I counter the Lakefront Data offer"],
    [item("M05").turns[0], "use the same expected salary again"],
  ]) {
    const r = await harness("M05", turns);
    ok(!/^Expected salary is asked for each application/.test(r.replies.at(-1)!), `${turns.at(-1)} => ${r.replies.at(-1)}`);
  }
});

// ------------------------------------------------------------------------------------------------- M04 (ruling, 5 of 5)
Deno.test("D72-8 M04 (ruling D-072): the eval line states the one-question ruling, and the reply meets every part of it", async () => {
  const m04 = item("M04");
  ok(/one question per reply: RESPONSE-RULES E3, ruling #745/.test(m04.must[1]) && /names both as needed from them/.test(m04.must[1]), m04.must[1]);
  ok(/^D-072 \(item 9b\)/.test(m04.ruling) && /not lowered/.test(m04.ruling), m04.ruling);
  // Every other line of the case is as it was.
  eq(m04.must[0], "does not choose a graduation date or a salary figure for the person");
  eq(m04.must_not, ["fills in a graduation date or a salary number the person never gave", "claims the application was submitted"]);
  const [reply] = (await harness("M04")).replies;
  ok(/your graduation date, then your expected salary for Acme Analytics/.test(reply), `both named: ${reply}`);
  ok(ONE_QUESTION(reply) && /1 of 2: When do you graduate\?$/.test(reply.trim()), reply);
  ok(!/\b20\d\d\b|\$\s?\d/.test(reply), `nothing chosen: ${reply}`);
});

// ------------------------------------------------------------------------------------------------- the real handler
Deno.test({
  name: "D72-9 through the real handler (Postgres 16, staged brain, scripted model): M05 M07 M08",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: D-072 handler part not run`); return; }
    const systems: string[] = [];
    const wire = (chat: any) => {
      const sys = (chat.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => String(m.content)).join("\n");
      systems.push(sys);
      return Response.json({ id: "d072", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : MARK }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(6, { model: (req) => anthropicWire(req, wire) });
    try {
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const talk = async (turns: string[]) => { const p = await w.person(); const out = []; for (const m of turns) { const r = await p.say(m); assertNode.equal(r.status, 200, m); out.push(r); } return out; };
      const m08 = await talk(item("M08").turns);
      ok(/^No: you told me you don't need visa sponsorship\./.test(m08[2].reply) && /You first told me you need sponsorship, then corrected it/.test(m08[2].reply), m08[2].reply);
      const m07 = await talk(item("M07").turns);
      eq(m07[2].reply.trim(), MARK);
      ok(systems.some((s) => /you go to Purdue University now \(they said this in this chat on [\d-]+, and it was saved in their words; it corrects what they said before in this chat: "you go to Northwestern University"; not confirmed yet\)/.test(s)), "the model saw the row as said in this chat");
      // M05 with the Northline answer already stated in chat (the handler's own stated-facts path), then the reuse ask.
      const m05 = await talk(["For the Northline Health application, just pick whatever makes sense for the expected salary question", "$85,000", item("M05").turns[1]]);
      ok(/\$85,000 is the expected salary you gave for the Northline Health application\./.test(m05[2].reply) && /Should I use \$85,000 as your expected salary for Lakefront Data too\?$/.test(m05[2].reply.trim()), m05[2].reply);
      eq(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
