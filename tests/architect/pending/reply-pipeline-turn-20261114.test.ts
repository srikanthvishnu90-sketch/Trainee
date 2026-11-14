// REPLY PIPELINE end to end (ruling 2026-11-14: on in production, the path chosen by the draft): a production-shaped turn. The real
// drafting prompt asks for tags; a tool result carries its evidence units; a stub model returns a tagged draft with one unsupported
// sentence; the one repair call gets code's reason; what still fails is dropped; the trace says "tagged". An untagged draft of the
// same turn keeps the support check (pipeline "untagged"). $0, no network.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { LEDGER_RULE, PIPELINE, REPAIR_SYSTEM } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";

FAIL_CLOSED.support = true;
const NOW = Date.parse("2026-11-14T15:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const URL0 = "https://careers.hudsonridge.example/sa";
const postingTool = { name: "get_posting_test", effect: "read", description: "Read one posting (test).", input_schema: { type: "object", properties: {} },
  run: async () => ({ posting: { company: "Hudson Ridge Capital", title: "Summer Analyst 2027", location: "New York, NY", pay: "$55 - $60 Hourly", deadline: "2027-01-15", state: "open", url: URL0 } }) };
const ASK = "what does the hudson ridge capital summer analyst role in new york pay";
const yes = async (cs: { claim: string }[]) => cs.map(() => "yes" as const);
// (a judge that refuses what the posting does not say: the desk)
const judge = async (cs: { claim: string }[]) => cs.map((c) => /desk/.test(c.claim) ? "no" as const : "yes" as const);

function model(draft: (ev: string[]) => string, repaired: (ev: string[]) => string) {
  const seen: any[] = [], repairs: any[] = [];
  let ev: string[] = [];
  const m = async (p: any) => {
    seen.push(p);
    if (!p.tools?.length) {
      const sys = String(p.system ?? "");
      if (sys.startsWith(REPAIR_SYSTEM.slice(0, 40))) { repairs.push(p); return text(repaired(ev)); }
      return text("");
    }
    const tr = (p.messages ?? []).flatMap((x: any) => Array.isArray(x.content) ? x.content : []).filter((b: any) => b?.type === "tool_result");
    if (!tr.length) return use("get_posting_test", {});
    try { ev = JSON.parse(String(tr.at(-1).content)).evidence ?? []; } catch { ev = []; }
    return text(draft(ev));
  };
  return { m, seen, repairs };
}
const idOf = (ev: string[], re: RegExp) => /^\[(E\d+)\]/.exec(ev.find((l) => re.test(l)) ?? "")?.[1] ?? "E?";

Deno.test("a tagged draft goes through the pipeline: ledger in the prompt and the tool result, verify, ONE repair, drop", async () => {
  eq(PIPELINE.on, true);
  const s = model((ev) => `Hudson Ridge Capital's Summer Analyst role in New York pays $55-$60 an hour [${idOf(ev, /pay/)}]. Its analysts sit on the credit desk [${idOf(ev, /pay/)}]. That's a posting figure, not a market rate.`,
    (ev) => `The posting closes 2027-01-15 [${idOf(ev, /closes/)}].\nIts analysts sit on the credit desk [${idOf(ev, /pay/)}].`);
  const r: any = await agentTurn({ message: ASK, history: [], stores: { profile: { facts: [] } }, userId: "u-rp", threadId: "th-rp", now: NOW, model: s.m, capabilities: [postingTool], market: { judge } } as any);
  ok(String(s.seen[0].system).includes(LEDGER_RULE), "the drafting prompt asks for tags");
  const tr = s.seen.flatMap((p: any) => (p.messages ?? []).flatMap((x: any) => Array.isArray(x.content) ? x.content : [])).find((b: any) => b?.type === "tool_result");
  ok(/"evidence":\["\[E\d+\] \(this chat's tool result\) Hudson Ridge Capital, Summer Analyst 2027 \(New York, NY\): pay \$55 - \$60 Hourly/.test(String(tr?.content)), String(tr?.content).slice(0, 400));
  eq(r.pipeline, "tagged");
  eq(s.repairs.length, 1, `one repair call: ${JSON.stringify({ piped: r.piped, reply: r.reply, show: !!r.show })}`);
  ok(/Its analysts sit on the credit desk\. \(code: the cited unit does not state/.test(String(s.repairs[0].messages[0].content[0].text)), s.repairs[0].messages[0].content[0].text);
  ok(r.reply.startsWith("Hudson Ridge Capital's Summer Analyst role in New York pays $55-$60 an hour."), r.reply);
  ok(r.reply.includes("The posting closes 2027-01-15.") && !/desk|\[E\d/.test(r.reply), r.reply);
  eq(r.piped.calls, 1);
  eq(r.piped.dropped.map((f: any) => f.sentence), ["Its analysts sit on the credit desk."]);
});

Deno.test("an untagged draft keeps the support check (pipeline 'untagged'); no repair call", async () => {
  const s = model(() => "Hudson Ridge Capital pays $55-$60 an hour in New York.", () => "x");
  const r: any = await agentTurn({ message: ASK, history: [], stores: { profile: { facts: [] } }, userId: "u-rp", threadId: "th-rp", now: NOW, model: s.m, capabilities: [postingTool], market: { judge: yes } } as any);
  eq(r.pipeline, "untagged");
  eq(s.repairs.length, 0);
  ok(!/\[E\d/.test(r.reply), r.reply);
});
