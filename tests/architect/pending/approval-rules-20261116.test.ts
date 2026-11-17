// The 10/10 rubric's gap #8, approval half (2026-11-16; evals/mirror/instinct-wa-batch1/, live-12 C12): the approval rules the brain
// reads come from the approval code, at $0 with a scripted model through the real brain turn (agentTurn).
//   CU-1   built from APPROVAL_RULES, the yes window read from career_apply_cards.ts, a batch yes, never "one by one"; the
//          capacity note (C12) points at them; the brain sees them on every turn
//   CU-1b  each rule holds in the card parser (parseCardReply); no prompt or tool description says approval is per card
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/approval-rules-20261116.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { careerSystemPrompt, MIRROR_RULES } from "../../../supabase/functions/_shared/agent/prompt.ts";
import { capacityNote } from "../../../supabase/functions/_shared/agent/turn_notes.ts";
import { APPROVAL_RULES, approvalRulesText, PER_ITEM_APPROVAL } from "../../../supabase/functions/_shared/agent/approval_rules.ts";
import { isApproval, parseCardReply, YES_WINDOW_MS } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const TURNS: { id: string; prompt: string }[] = Deno.readTextFileSync(new URL("prompts.jsonl", DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const PERSONA: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const NOW = Date.parse("2026-11-16T15:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}

Deno.test("CU-1 the approval rules the brain reads are built from the approval code: one yes approves exactly the batch shown", async () => {
  const t = approvalRulesText();
  eq(APPROVAL_RULES.yesWindowMinutes, YES_WINDOW_MS / 60_000, "the window is the card code's");
  ok(t.includes(`${YES_WINDOW_MS / 60_000} minutes`), t);
  ok(/one yes approves exactly the applications that card shows/.test(t) && /one yes approves exactly the batch of messages shown/.test(t), t);
  ok(!PER_ITEM_APPROVAL.test(t), "the rules themselves never say one by one");
  // Every fixed piece of the brain's prompt, and the capacity note C12 gets, agree with them.
  for (const [name, piece] of [["system prompt", careerSystemPrompt("2026-11-16")], ["mirror rules", MIRROR_RULES], ["capacity note", capacityNote()]] as const) ok(!PER_ITEM_APPROVAL.test(piece), `${name}: ${PER_ITEM_APPROVAL.exec(piece)?.[0]}`);
  ok(/HOW APPROVAL WORKS/.test(capacityNote()), "the capacity note points at the rules");
  // The brain sees them on every turn, exactly.
  const seen: any[] = [];
  await agentTurn({ message: TURNS.find((x) => x.id === "C12")!.prompt, history: [], stores: { profile: personaProfile() }, userId: "u-cu1", threadId: "th", now: NOW,
    model: async (p: any) => { seen.push(p); return text("I haven't verified that pace."); } } as any);
  ok(String(seen[0].system).includes(t), "HOW APPROVAL WORKS is in the system prompt as built");
});

// Review of f7abd6c30: each rule the brain is told is what the card code does (parseCardReply), and no fixed text the brain reads
// (the core prompt's "what can you do" line, queue_applications' description) still says approval is per card.
Deno.test("CU-1b each approval rule holds in the card code; no prompt, tool description or run note says approval is per card", async () => {
  const r = (t: string) => parseCardReply(t);
  ok(APPROVAL_RULES.batchYes && isApproval(r("yes")) && (r("yes") as any).except.length === 0, "one yes approves the whole card");
  ok(APPROVAL_RULES.subsets && isApproval(r("yes except 3")) && JSON.stringify((r("yes except 3") as any).except) === "[3]" && JSON.stringify((r("only 1, 2 and 5") as any).only) === "[1,2,5]", "subsets");
  ok(!isApproval(r("maybe")) && !isApproval(r("yes?")) && !isApproval(r("no")), "an unclear reply approves nothing");
  ok(/an unclear reply approves nothing/.test(approvalRulesText()));
  for (const t of careerTools({ postings: async () => [], wants: {} as any } as any)) ok(!PER_ITEM_APPROVAL.test(t.description), `${t.name}: ${PER_ITEM_APPROVAL.exec(t.description)?.[0]}`);
  ok(!PER_ITEM_APPROVAL.test(careerSystemPrompt("2026-11-16")), PER_ITEM_APPROVAL.exec(careerSystemPrompt("2026-11-16"))?.[0]);
  // Review rv2: the run note queue_applications returns, and D-R9-2's every-page-delivered condition.
  const queue = careerTools({ postings: async () => [], alerts: null, wants: memoryWantStore() } as any).find((t) => t.name === "queue_applications")!;
  ok(queue.description.length <= 400 && /browser/.test(queue.description) && /approv/i.test(queue.description), queue.description);
  const out: any = await queue.run({ postings: [{ url: "https://job-boards.greenhouse.io/acme/jobs/4000001", company: "Acme", title: "Data Analyst 1" }] }, { userId: "u1", threadId: "t1", now: Date.UTC(2026, 9, 20, 15), state: {}, turn: { message: "apply me", added: [] } } as any);
  ok(typeof out.note === "string" && !PER_ITEM_APPROVAL.test(out.note), `run note: ${out.note}`);
  ok(PER_ITEM_APPROVAL.test("The Trainee extension prepares each posting in the person's browser and shows a card; it goes only after they approve that card."), "the old run note is caught");
  ok(APPROVAL_RULES.allPagesDelivered && /only once every page of it has reached them/.test(approvalRulesText()));
  const cards = Deno.readTextFileSync(new URL("../../../supabase/functions/_shared/career_apply_cards.ts", import.meta.url));
  ok(/card_pages_undelivered[\s\S]{0,200}nothing was approved/.test(cards), "the card code refuses a yes to a card whose pages were not all delivered");
  for (const old of ["they review and approve each card in the Trainee extension", "each application goes only on their approval in the extension", "each goes only after they approve its card in the Trainee extension"]) ok(PER_ITEM_APPROVAL.test(old), old);
});

