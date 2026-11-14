// Review of #832 (e7e7e46a8): a correction to the record (G9) is stated only from a complete read, and only a complete read
// becomes the snapshot the next read is compared with. A partial read (the saved applications store unreadable) once said
// "Correction: Stripe (SWE) is no longer on the record." and overwrote the snapshot with the partial list.
//   deno test -A --no-check tests/architect/applied-check-partial-changes-20261113.test.ts
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/agent-chat/career_brain.ts";
import { capabilityTools } from "../../supabase/functions/_shared/agent/capability_tools.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.UTC(2026, 10, 13);
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const scripted = (steps: any[]) => { let n = 0; return async (p: any) => (p.tools?.length ? steps[n++] ?? text("ok") : text("")); };
const boom = async () => { throw new Error("boom"); };
const A = { mailbox: "a@x.test", can_read: true };
const OK_NOW = async () => ({ status: "ok", read: 0, statuses: [], offers: [], read_through: "2026-11-13T00:00:00Z" });
const stripe = { ref: "job:Stripe", company: "Stripe", role: "SWE", applied_at: "2026-11-01", stage: "Submitted", source: "queue", events: [] };
const SNAP = { at: "2026-11-12T00:00:00.000Z", items: [{ ref: "job:Stripe", company: "Stripe", role: "SWE", stage: "Submitted", hashes: [] }] };

function world(mail: Record<string, unknown>) {
  const saved: any[] = [];
  const snapshot = { get: async () => structuredClone(SNAP), set: async (_u: string, s: unknown) => { saved.push(s); } };
  const capabilities = capabilityTools({ readTimeoutMs: 50, tracking: true, connectUrl: "https://x.test/connect", situation: null, files: null, people: null, inbox: null, reply: null, snapshot, cursor: null, accounts: async () => [A], readNow: OK_NOW, mail } as any);
  return { saved, capabilities };
}
const ask = (capabilities: unknown) => B.agentTurn({ message: "have i applied anywhere?", history: [], stores: { profile: { facts: [] } }, userId: "u-pc", threadId: "th-pc", now: NOW,
  model: scripted([use("read_application_mail", {}), ...Array(4).fill(text("Here's where things stand."))]), capabilities } as any);

Deno.test("partial read (saved applications store unreadable): no Correction line, no change to the model, snapshot unchanged", async () => {
  const w = world({ applications: boom, events: async () => [] });
  const r: any = await ask(w.capabilities);
  ok(!/Correction:/.test(r.reply), r.reply);
  ok(/couldn't read/.test(r.reply), `the partial read is said: ${r.reply}`);
  const call = (r.tool_calls ?? []).find((c: any) => c.name === "read_application_mail");
  ok(!call?.result || !/no longer on record/.test(String(call.result)), `no change reaches the model: ${call?.result}`);
  eq(w.saved, [], "a partial read is not saved as the snapshot");
});

Deno.test("complete read: a real change is stated and the snapshot is replaced", async () => {
  const w = world({ applications: async () => [{ ...stripe, stage: "Interview" }], events: async () => [] });
  const r: any = await ask(w.capabilities);
  ok(/Correction: stage was Submitted, now Interview \(Stripe\)\./.test(r.reply), r.reply);
  eq(w.saved.length, 1, "the complete read is the new snapshot");
  eq(w.saved[0].items.map((i: any) => [i.company, i.stage]), [["Stripe", "Interview"]]);
});
