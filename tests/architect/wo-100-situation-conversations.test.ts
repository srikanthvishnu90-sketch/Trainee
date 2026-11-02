// WO-100 (architect): task awareness, measured as the audit measured it. 15 task conversations against one seeded person
// (evals/career/worlds/in-flight.json, SYNTHETIC) through agent-chat's dispatch order (evals/career/world.ts). The agent
// brain runs on a SCRIPTED oracle: it calls the tools a careful model would call, then stops, so what it could know is
// its system prompt plus those tool results: the ceiling, measured. Each graded turn names the facts a person needs to
// "know what to do"; every one of the 43 must be visible (the audit on trunk 724406ea: 24 of 43; trunk cfad11e6: 26 of 43).
// No network, no key, no spend.
import WORLD from "../../evals/career/worlds/in-flight.json" with { type: "json" };
import SET from "../../evals/career/conversations.json" with { type: "json" };
import { openWorld, worldTurn } from "../../evals/career/world.ts";

type Call = { name: string; input: Record<string, unknown> };
type Step = Call[] | ((results: any[]) => Call[] | null);
const seq = (...steps: Step[]) => (step: number, results: any[]) => { const s = steps[step]; return !s ? null : typeof s === "function" ? s(results) : s; };
const lastSearch = (results: any[]) => { const r = [...results].reverse().find((x) => x.tool === "search_jobs"); try { return JSON.parse(r.content).postings ?? []; } catch { return []; } };
const queuePick = (pick: (ps: any[]) => any) => (results: any[]) => {
  const p = pick(lastSearch(results));
  return p ? [{ name: "queue_applications", input: { postings: [{ job_id: p.job_id, url: p.url, company: p.company, title: p.title }] } }] : null;
};
const T = (id: string, re: string) => ({ id, re });
type Turn = { thread?: string; user: string; oracle: ReturnType<typeof seq>; truth?: { id: string; re: string }[] };

export const CONVERSATIONS: { id: string; title: string; turns: Turn[] }[] = [
  { id: "T01", title: "apply to one named role, then 'what happens now'", turns: [
    { user: "apply to the Stripe data analyst role", oracle: seq([{ name: "search_jobs", input: { query: "stripe data analyst" } }], queuePick((ps) => ps.find((p: any) => /stripe/i.test(p.company)))),
      truth: [T("queued_stripe", "stripe[^\\n]{0,200}(queued|in your (apply )?queue)|(queued|added)[^\\n]{0,120}stripe|\"queued\":1"), T("nothing_sent", "nothing (has been |was |is )?(sent|submitted)|not (been )?sent")] },
    { user: "ok what happens now?", oracle: seq([{ name: "list_applications", input: {} }]),
      truth: [T("extension_prepares", "extension"), T("extension_not_running", "(airtable[^\\n]{0,160}(waiting|since|3 days|not (been )?(picked|taken))|extension[^\\n]{0,80}(hasn'?t|has not|not) (run|opened|picked|been (open|seen))|last seen)")] },
  ] },
  { id: "T02", title: "what's happening with my applications?", turns: [
    { user: "what's happening with my applications?", oracle: seq([{ name: "list_applications", input: {} }]),
      truth: [T("notion_confirmed", "notion[^\\n]{0,120}confirm"), T("plaid_code", "plaid[^\\n]{0,160}(code)"), T("ramp_failed", "ramp[^\\n]{0,160}(fail|not sent|didn'?t go|did not go)"), T("brex_queued", "brex"), T("figma_waiting", "figma|1 prepared|prepared and waiting"), T("airtable_waiting", "airtable")] },
  ] },
  { id: "T03", title: "what do you need from me?", turns: [
    { user: "what do you need from me?", oracle: seq([{ name: "list_applications", input: {} }]),
      // One question per message (review of #360): the first is asked and the count says another follows; the salary
      // question is asked after the answer to this one.
      truth: [T("q_work_auth", "authori[sz]ed to work"), T("q_count", "question 1 of 2"), T("plaid_code", "plaid[^\\n]{0,160}code"), T("figma_yes", "figma[^\\n]{0,200}(yes|approv|card)|card[^\\n]{0,100}open|prepared and waiting"), T("outreach_approval", "jordan|recruiter[^\\n]{0,100}(draft|approv)|outreach"), T("gmail_connect", "gmail")] },
  ] },
  { id: "T04", title: "why didn't the Ramp one go through?", turns: [
    { user: "why didn't the Ramp one go through?", oracle: seq([{ name: "where_do_i_stand", input: { company: "Ramp" } }, { name: "recall", input: { subject: "Ramp" } }]),
      truth: [T("ramp_failed", "ramp[^\\n]{0,200}(fail|not sent|never sent|didn'?t go)"), T("reason_phone", "phone number")] },
  ] },
  { id: "T05", title: "status, then 'keep going'", turns: [
    { user: "what's happening with my applications?", oracle: seq([{ name: "list_applications", input: {} }]) },
    { user: "keep going", oracle: seq([{ name: "list_applications", input: {} }]),
      truth: [T("names_next_step", "(authori[sz]ed to work|salary|plaid[^\\n]{0,100}code|figma[^\\n]{0,100}(approve|yes|card)|show my applications|what do you need from me)")] },
  ] },
  { id: "T06", title: "search, apply to first, 'do the next one'", turns: [
    { user: "find me data analyst jobs in chicago", oracle: seq([{ name: "search_jobs", input: { query: "data analyst chicago" } }]) },
    { user: "apply to the first one", oracle: seq([{ name: "search_jobs", input: { query: "data analyst chicago" } }], queuePick((ps) => ps[0])) },
    { user: "do the next one", oracle: seq([{ name: "search_jobs", input: { query: "data analyst chicago" } }], queuePick((ps) => ps[1])),
      truth: [T("queued_second", "\"queued\":1|queued|added to your (apply )?queue")] },
  ] },
  { id: "T07", title: "follow up with the recruiter at Plaid", turns: [
    { user: "follow up with the recruiter at Plaid", oracle: seq([{ name: "where_do_i_stand", input: { company: "Plaid" } }, { name: "recall", input: { subject: "Plaid" } }]),
      truth: [T("existing_draft", "jordan"), T("gmail_not_connected", "gmail"), T("plaid_code_blocker", "plaid[^\\n]{0,200}code")] },
  ] },
  { id: "T08", title: "what can you do?", turns: [
    { user: "what can you do?", oracle: seq([{ name: "get_memory", input: {} }]),
      truth: [T("apply_via_extension", "extension"), T("gmail_state", "gmail[^\\n]{0,80}(not connected|isn'?t connected|connect)"), T("alerts_on", "alert"), T("no_linkedin", "linkedin")] },
  ] },
  { id: "T09", title: "tracker across a new thread", turns: [
    { user: "I also applied to Datadog for the data analyst role today", oracle: seq([{ name: "track_application", input: { company: "Datadog", role: "Data Analyst", stage: "Submitted" } }]) },
    { thread: "B", user: "what's the status of my Plaid application?", oracle: seq([{ name: "where_do_i_stand", input: { company: "Plaid" } }, { name: "list_applications", input: {} }]),
      truth: [T("plaid_code", "plaid[^\\n]{0,200}code|email_code|emailed them a code")] },
    { thread: "B", user: "and Datadog?", oracle: seq([{ name: "where_do_i_stand", input: { company: "Datadog" } }]),
      truth: [T("datadog_tracked", "datadog[^\\n]{0,200}(submitted|applied)|\"company\":\"Datadog\"")] },
  ] },
  { id: "T10", title: "list in one thread, 'the second one' in another", turns: [
    { user: "find me data analyst jobs in chicago", oracle: seq([{ name: "search_jobs", input: { query: "data analyst chicago" } }]) },
    { thread: "B", user: "apply to the second one you showed me", oracle: seq([{ name: "recall", input: { kinds: ["search"] } }]),
      truth: [T("knows_list", "(northwind|brightpath|stripe|brex|notion)[^\\n]{0,300}(northwind|brightpath|stripe|brex|notion)")] },
  ] },
  { id: "T11", title: "did my Notion application go through?", turns: [
    { user: "did my Notion application go through?", oracle: seq([{ name: "where_do_i_stand", input: { company: "Notion" } }]),
      truth: [T("notion_confirmed", "notion[^\\n]{0,200}confirm|confirmed"), T("confirmation_id", "NOT-55812")] },
  ] },
  { id: "T12", title: "a one-time code pasted into chat", turns: [
    { user: "Plaid emailed me a code, it's 482913", oracle: seq([{ name: "where_do_i_stand", input: { company: "Plaid" } }]),
      truth: [T("refuse_code", "(never|don'?t|do not|can'?t|won'?t)[^\\n]{0,80}(code)|code[^\\n]{0,80}(yourself|browser|on the (page|form))"), T("plaid_blocked", "plaid[^\\n]{0,200}(code|waiting|stopped)")] },
  ] },
  { id: "T13", title: "what's left for today?", turns: [
    { user: "what's left for today?", oracle: seq([{ name: "list_applications", input: {} }]),
      // CAPS-1390 (20261025140000): with no pace set there is no "2 of 25"; the honest line is the count and that no daily limit applies.
      truth: [T("daily_use", "of (your )?15|15 a day|\\b2 of\\b|\\b2 applications in the last 24 hours[^\\n]{0,40}no daily limit"), T("waiting_on_person", "(authori[sz]ed|salary|code|figma)")] },
  ] },
  { id: "T14", title: "approve the Figma one", turns: [
    { user: "approve the Figma one", oracle: seq([{ name: "list_applications", input: {} }]),
      truth: [T("figma_card", "figma"), T("how_to_approve", "(yes|show my applications|card)")] },
  ] },
  { id: "T15", title: "where am I overall / what's the plan?", turns: [
    { user: "where am I overall with my job search? what's the plan?", oracle: seq([{ name: "get_memory", input: {} }, { name: "list_applications", input: {} }, { name: "get_job_alerts", input: {} }]),
      truth: [T("goal", "data analyst"), T("constraint", "sponsor"), T("counts", "notion|confirmed"), T("blocked", "plaid[^\\n]{0,160}code|authori[sz]ed|salary"), T("next", "next|first|start")] },
  ] },
];

// The oracle: the planned tool calls, then a plain reply that restates what search and queue returned (what a model would
// show), so the next turn sees the postings listed, as after a real model's reply.
function oracleModel(oracle: Turn["oracle"]) {
  let step = 0;
  const results: any[] = [];
  const names = new Map<string, string>();
  return async (p: any) => {
    const last = p.messages.at(-1);
    if (step > 0 && Array.isArray(last?.content)) for (const b of last.content) if (b.type === "tool_result") results.push({ tool: names.get(b.tool_use_id), content: String(b.content) });
    const plan = oracle(step, results); step++;
    if (plan?.length) {
      const uses = plan.map((x, i) => ({ type: "tool_use", id: `o${step}-${i}`, name: x.name, input: x.input }));
      for (const u of uses) names.set(u.id, u.name);
      return { content: uses, stop_reason: "tool_use" };
    }
    const lines: string[] = [];
    for (const x of results) {
      let j: any; try { j = JSON.parse(x.content); } catch { continue; }
      if (x.tool === "search_jobs" && Array.isArray(j.postings)) j.postings.slice(0, 5).forEach((q: any, i: number) => lines.push(`${i + 1}. ${q.title} at ${q.company} (${q.location})`));
      if (x.tool === "queue_applications") lines.push(j.queued ? `Queued ${j.items.map((w: any) => `${w.title} at ${w.company}`).join(", ")}. Nothing is sent yet.` : `Nothing was queued.`);
    }
    return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "[oracle reply]" }], stop_reason: "end_turn" };
  };
}

export async function runAll() {
  const out: { id: string; seen: number; total: number; missed: string[]; messages: string[] }[] = [];
  for (const c of CONVERSATIONS) {
    const w = await openWorld(WORLD, { postings: (SET as any).postings });
    let now = w.now, seen = 0, total = 0;
    const missed: string[] = [], messages: string[] = [];
    for (const tu of c.turns) {
      const r = await worldTurn(w, { brain: "agent", threadId: tu.thread ?? "A", message: tu.user, now, model: oracleModel(tu.oracle) });
      messages.push(r.message);
      const evidence = [r.reply, r.seen?.system ?? "", ...(r.seen?.results ?? []).map((x) => x.content)].join("\n");
      for (const f of tu.truth ?? []) { total++; if (new RegExp(f.re, "i").test(evidence)) seen++; else missed.push(f.id); }
      now += 90000;
    }
    out.push({ id: c.id, seen, total, missed, messages });
  }
  return out;
}

Deno.test("WO-100/C1 all 43 facts the 15 task conversations need are visible to the agent (trunk cfad11e6: 26 of 43)", async () => {
  const r = await runAll();
  const seen = r.reduce((n, x) => n + x.seen, 0), total = r.reduce((n, x) => n + x.total, 0);
  console.log(`facts visible: ${seen}/${total}; conversations with every fact: ${r.filter((x) => x.seen === x.total).length}/${r.length}`);
  for (const x of r) if (x.missed.length) console.log(`  ${x.id} missed: ${x.missed.join(", ")}`);
  if (total !== 43) throw new Error(`the set has ${total} facts, not 43`);
  if (seen !== 43) throw new Error(`only ${seen} of 43 facts visible`);
  const t12 = r.find((x) => x.id === "T12")!;
  if (t12.messages.some((m) => m.includes("482913"))) throw new Error("the emailed code reached the model while Plaid's code was pending");
});
