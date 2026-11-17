// CodeRabbit's review of #849 (316da2ab0), the findings that held against the current code: the record check reaches the tagged
// path; an employer named first in a page and in the claim is that page's subject; no clause stands on two units joined; a verified
// shorter length repair replaces an overlong reply; the joint judge reads the draft facts that admitted a sentence; a sentence of
// free clauses is rescued whatever other sentences do. Earlier tests are unchanged. Fixtures are invented.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { Ledger, REPAIR_SYSTEM, runReplyPipeline } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { keepSupported } from "../../../supabase/functions/_shared/agent/research/support.ts";

FAIL_CLOSED.support = true;
const NOW = Date.parse("2026-11-14T15:00:00Z");
const yes = async (cs: { claim: string; source: string }[]) => cs.map(() => "yes" as const);
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const URL0 = "https://careers.hudsonridge.example/sa";
const postingTool = { name: "get_posting_test", effect: "read", description: "Read one posting (test).", input_schema: { type: "object", properties: {} },
  run: async () => ({ posting: { company: "Hudson Ridge Capital", title: "Summer Analyst 2027", location: "New York, NY", pay: "$55 - $60 Hourly", deadline: "2027-01-15", state: "open", url: URL0 } }) };

Deno.test("CodeRabbit #849: the record check reaches the tagged path (a city on the record is never 'not on file')", async () => {
  let ev: string[] = [];
  const m = async (p: any) => {
    if (!p.tools?.length) return text(String(p.system ?? "").startsWith(REPAIR_SYSTEM.slice(0, 40)) ? "" : "");
    const tr = (p.messages ?? []).flatMap((x: any) => Array.isArray(x.content) ? x.content : []).filter((b: any) => b?.type === "tool_result");
    if (!tr.length) return { content: [{ type: "tool_use", id: "t1", name: "get_posting_test", input: {} }], stop_reason: "tool_use" };
    try { ev = JSON.parse(String(tr.at(-1).content)).evidence ?? []; } catch { ev = []; }
    const pay = /^\[(E\d+)\]/.exec(ev.find((l) => /pay/.test(l)) ?? "")?.[1] ?? "E?";
    return text(`Hudson Ridge Capital's Summer Analyst role in New York pays $55-$60 an hour [${pay}]. Your city isn't on file [${pay}].`);
  };
  const r: any = await agentTurn({ message: "what does the hudson ridge capital summer analyst role pay", history: [], stores: { profile: { facts: [], basics: { city: "Davis" } } }, userId: "u-cr", threadId: "th-cr", now: NOW, model: m, capabilities: [postingTool], market: { judge: yes } } as any);
  eq(r.pipeline, "tagged");
  ok(!/city isn't on file/.test(r.reply), r.reply);
});

Deno.test("CodeRabbit #849: an employer named first in a page and in the claim is the subject", async () => {
  const l = new Ledger();
  const pg = l.add("page", "Acme pays interns $40 per hour.", { host: "x.example", url: "https://x.example/a" });
  const out = await runReplyPipeline(`Acme pays interns $40 per hour [${pg}].`, l, { judge: yes, ask: "what does acme pay", repair: null });
  ok(out.text.startsWith("Acme pays interns $40 per hour."), out.text);
});

Deno.test("CodeRabbit #849: a clause with no figure never stands on two units joined", async () => {
  const l = new Ledger();
  const a = l.add("page", "The role requires Python.", { host: "x.example", url: "https://x.example/a" });
  const b = l.add("page", "The role requires SQL.", { host: "x.example", url: "https://x.example/b" });
  const seen: string[] = [];
  const out = await runReplyPipeline(`The role requires Python and SQL [${a},${b}].`, l, { judge: async (cs) => { seen.push(...cs.map((c) => c.source)); return cs.map(() => "yes" as const); }, ask: "x", repair: null });
  ok(!/Python and SQL/.test(out.text), out.text);
  ok(seen.every((s) => !(s.includes("Python") && s.includes("SQL"))), JSON.stringify(seen));
  // One unit that holds it whole still lets it stand.
  const m = new Ledger();
  const c = m.add("page", "The role requires Python and SQL.", { host: "x.example", url: "https://x.example/c" });
  ok((await runReplyPipeline(`The role requires Python and SQL [${c}].`, m, { judge: yes, ask: "x", repair: null })).text.startsWith("The role requires Python and SQL."));
});

Deno.test("CodeRabbit #849: a verified, shorter length repair replaces an overlong reply", async () => {
  const l = new Ledger();
  const pg = l.add("page", "Brightloop engineers ship to production every day and own their features end to end.", { host: "brightloop.example", url: "https://brightloop.example/eng" });
  const long = `Brightloop engineers ship to production every day and own their features end to end, which is what the team says it values most in every engineer it hires and keeps [${pg}].`;
  const out = await runReplyPipeline(long, l, { judge: yes, ask: "what's brightloop's culture", maxChars: 100, repair: async () => `Brightloop engineers ship to production every day and own their features end to end [${pg}].` });
  eq(out.text.split("\n")[0], "Brightloop engineers ship to production every day and own their features end to end.");
});

Deno.test("CodeRabbit #849: the joint judge reads the draft facts that admitted a sentence", async () => {
  const sources: string[] = [];
  await keepSupported("Lead with the project and leave off the 3.9 GPA since you said it is outdated.", [{ text: "Lead with your strongest project.", title: "Guide" }], {
    judge: async (cs) => { sources.push(...cs.map((c) => c.source)); return cs.map(() => "no" as const); },
    joint: { guide: [{ text: "Lead with your strongest project.", title: "Guide" }], record: "education: Eastbrook College", drafts: "gpa: 3.9 (the person said it is outdated)" } as any,
    also: { when: (s: string) => /leave off/.test(s), sources: [{ text: "gpa: 3.9 (the person said it is outdated)", title: "Not confirmed" }] },
  });
  ok(sources.some((s) => /Two passages/.test(s) && /3\.9/.test(s)), JSON.stringify(sources));
});

Deno.test("CodeRabbit #849: a sentence of free clauses is rescued whatever other sentences do", async () => {
  const one = await keepSupported("Your city isn't on file; I couldn't verify it.", [{ text: "education: Lakeshore University", one: true }], { judge: async (cs) => cs.map(() => "no" as const), onRecord: (s: string) => /^Your city isn't on file\.?$/.test(s) ? true : null });
  ok(one.text.includes("city isn't on file"), JSON.stringify(one));
  const two = await keepSupported("Your city isn't on file; I couldn't verify it. Lakeshore pays $90 an hour, and it is in Ohio.", [{ text: "education: Lakeshore University", one: true }], { judge: async (cs) => cs.map(() => "no" as const), onRecord: (s: string) => /^Your city isn't on file\.?$/.test(s) ? true : null });
  eq(one.text.includes("city isn't on file"), two.text.includes("city isn't on file"));
});

import { createFileTool } from "../../../supabase/functions/_shared/agent/file_tool.ts";
import { createFileService, memoryFileStore } from "../../../supabase/functions/_shared/file_service.ts";
Deno.test("CodeRabbit #849: the File text a reply may restate is the validated File's, not keys the validator dropped", async () => {
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-cr849-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const c = { userId: "33333333-3333-4333-8333-333333333849", threadId: "t", now: NOW, state: {}, turn: { message: "plan", added: [], fileLinks: [] as string[], guard: () => [] } };
  const data = { title: "SWE internship plan", variant: "pipeline", sections: [{ heading: "This week", items: [{ label: "PayPal", value: "Apply this week.", source: "From the posting" }] }], stray_note: "SYN-DROPPED-BY-VALIDATOR text" };
  const made: any = await createFileTool(files).run({ kind: "plan_review", data }, c as any);
  ok(made.created, JSON.stringify(made));
  const texts: string[] = (c.turn as any).fileTexts ?? [];
  ok(texts.includes("Apply this week.") && !texts.some((t) => t.includes("SYN-DROPPED")), JSON.stringify(texts));
});

import { runAgentTurn } from "../../../supabase/functions/_shared/agent/loop.ts";
Deno.test("CodeRabbit #849: a File made this turn is evidence: that it was made, with its link, and its text", async () => {
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-cr849-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const ledger = new Ledger();
  const data = { title: "SWE internship plan", variant: "pipeline", sections: [{ heading: "This week", items: [{ label: "PayPal", value: "Apply this week.", source: "From the posting" }] }] };
  let i = 0;
  const script = [{ content: [{ type: "tool_use", id: "f1", name: "create_file", input: { kind: "plan_review", data } }], stop_reason: "tool_use" }, text("Done.")];
  const turn = { message: "make me a plan", added: [], fileLinks: [] as string[], guard: () => [] };
  await runAgentTurn({ system: "s", message: "make me a plan", history: [], tools: [createFileTool(files)], ctx: { userId: "33333333-3333-4333-8333-333333333849", threadId: "th", now: NOW, state: {}, turn, ledger } as any, model: async () => script[Math.min(i++, script.length - 1)] } as any);
  const made = ledger.units.find((u) => /plan review File titled "SWE internship plan" was made this turn/.test(u.text));
  ok(made && String(made.url).startsWith("https://trainee.example/file"), JSON.stringify(ledger.units));
  ok(ledger.units.some((u) => u.text === "The File made this turn says: Apply this week."), JSON.stringify(ledger.units));
});

import { enforceMarketReplySupported, researchMarket } from "../../../supabase/functions/_shared/agent/research/market.ts";
const MNOW = Date.parse("2026-11-13T03:00:00Z");
async function swePay() {
  const pages = [{ url: "https://levels.example/swe", title: "SWE intern pay", text: "Software engineering interns in Chicago earn a median of $45 an hour." }];
  const deps = { search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: MNOW })), notes: [], provider: "t" }) },
    read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: MNOW })), rejected: [] }),
    draft: async () => JSON.stringify({ summary: [{ text: "Software engineering interns in Chicago earn a median of $45 an hour.", quote: "earn a median of $45 an hour", url: pages[0].url }], conditions: [], risks: [] }), judge: yes };
  return await researchMarket({ question: "swe intern pay chicago", ask: "what do swe interns make in chicago", format: "inline", plan: { queries: ["x"], companies: [] }, deps: deps as any }) as any;
}
Deno.test("CodeRabbit #849: a research turn reads a chat posting's own places as places", async () => {
  const r = await swePay();
  eq(r.status, "ok");
  const out = await enforceMarketReplySupported("Stripe pays $40/hr.", r, [], { judge: yes, ask: "what does stripe pay", chat: [{ text: "Stripe, SWE Intern, Chicago, IL, pay $40/hr", url: "https://stripe.example/j", places: ["Chicago, IL"] }] } as any);
  ok(out.startsWith("Stripe pays $40/hr.\nhttps://stripe.example/j"), out);
});
Deno.test("CodeRabbit #849: a pronoun-led paragraph goes only when the sentence before it was removed", async () => {
  const r = await swePay();
  const out = await enforceMarketReplySupported("They earn a median of $45 an hour in Chicago [1].", r, [], { judge: yes, ask: "what do swe interns make in chicago" });
  ok(out.startsWith("They earn a median of $45 an hour in Chicago"), out);
});
