// WO-091b acceptance tests (architect-authored; builders make them pass, never edit them).
// Code checks what a tool call means, not only its shape (audit chat-brain F2, F4):
//   queue_applications  each pick is resolved by its job_id from the postings on file, and its employer and title come from
//                       that record, never from the model. A pick is refused, with a reason the model relays, when its
//                       employer is not the one the person named (or showed them last turn), when this exact posting is already in
//                       their applications (every thread, the apply queue; D-MS-3, 2026-10-27: no one-per-company window, another
//                       posting at the same employer is allowed), or when it is their confirmed current employer.
//   remember_instruction  an instruction that waives the person's approval, or asks for a forbidden act, is never kept.
// Battery rows: BR-023 (wrong company), BR-018 (already applied by hand), BR-019 (no company window), BR-021 (current employer),
// BR-084 (autopilot). Contract: docs/architect/work-orders/WO-091b-tool-checks.md. Offline: scripted model, fake stores.
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { addStanding, memoryStandingStore } from "../../supabase/functions/_shared/agent/memory.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 20, 15);

// The postings on file (career_postings), by job_id, as the posting reader returns them.
const rec = (board: string, id: string, company: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ job_id: `greenhouse:${board}:${id}`, company, title, location: "Remote, US", url: `https://job-boards.greenhouse.io/${board}/jobs/${id}`, description: `${title} at ${company}.`, ...extra });
const SHELF = [
  rec("meridian", "1001", "Meridian Fulfillment", "Operations Analyst"),
  rec("northwindledger", "2002", "Northwind Ledger", "New Grad Software Engineer"),
  rec("eastbank", "3003", "Eastbank Systems", "Early Career Software Engineer"),
  rec("copperlineinfra", "4100016", "Copperline Infra, Inc.", "Software Engineer, Platform"),
  rec("acme", "5001", "Acme Corp", "Data Analyst"),
  rec("globex", "5002", "Globex", "Data Analyst"),
  rec("initech", "5003", "Initech LLC", "Data Analyst"),
  rec("stripe", "6001", "Stripe", "Data Analyst"),
  rec("hooli", "7001", "Hooli", "Data Analyst", { closed_at: "2026-10-19T00:00:00Z" }),
];
const byId = new Map(SHELF.map((p) => [p.job_id, p]));
const pick = (id: string, label: Record<string, string> = {}) => { const p = byId.get(id)!; return { job_id: p.job_id, url: p.url, company: p.company, title: p.title, ...label }; };

function setup(o: { mail?: any } = {}) {
  const wants = memoryWantStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], wants, posting: async (id: string) => byId.get(id) ?? null, mail: o.mail ?? null } as any).map((x) => [x.name, x]));
  return { wants, t };
}
const ctx = (message: string, state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, now = NOW) =>
  ({ userId: "u1", threadId: "t1", now, state, turn: { message, added: [] as string[], ...extra } }) as any;
const confirmedFact = (text: string, kind = "experience") => ({ id: `F-${Math.random().toString(36).slice(2, 6)}`, kind, text, needs_confirmation: false, status: "confirmed" });

// ------------------------------------------------------------------------------------------------ F2: queue_applications
Deno.test("WO-091b/1 BR-023: the person names Quickhire, the model picks Meridian: nothing is queued, and the reason names both", async () => {
  const { wants, t } = setup();
  const out: any = await t.queue_applications.run({ postings: [pick("greenhouse:meridian:1001", { company: "Quickhire Remote Jobs", title: "Operations" })] },
    ctx("Apply me to the operations role at Quickhire Remote Jobs."));
  eq(out.queued, 0, "a posting at another employer is never queued");
  eq(out.refused.length, 1);
  const r = out.refused[0];
  eq(r.posting.company, "Meridian Fulfillment", "the refusal names the posting's real employer, from the record");
  assert(/Quickhire/.test(r.reason) && /not the employer/i.test(r.reason), `the reason names who they asked for: ${r.reason}`);
  eq(wants.dump().u1 ?? [], [], "the queue is untouched");
});

Deno.test("WO-091b/2 company and title come from the posting on file, never from the model's label", async () => {
  const { wants, t } = setup();
  const out: any = await t.queue_applications.run({ postings: [pick("greenhouse:meridian:1001", { company: "Quickhire Remote Jobs", title: "Operations" })] },
    ctx("Apply me to the Operations Analyst role at Meridian Fulfillment."));
  eq(out.queued, 1);
  eq(wants.dump().u1.map((w) => [w.company, w.title, w.posting_key]), [["Meridian Fulfillment", "Operations Analyst", "greenhouse:meridian:1001"]]);
  // A link without its job_id is resolved by the posting's own key.
  const { wants: w2, t: t2 } = setup();
  const byLink: any = await t2.queue_applications.run({ postings: [{ url: "https://boards.greenhouse.io/meridian/jobs/1001", company: "whatever" }] },
    ctx("Apply me to the Meridian Fulfillment operations role."));
  eq(byLink.queued, 1);
  eq(w2.dump().u1[0].company, "Meridian Fulfillment");
});

Deno.test("WO-091b/3 a pick that is not on file, or has closed, is refused with a reason", async () => {
  const { wants, t } = setup();
  const out: any = await t.queue_applications.run({ postings: [
    { job_id: "greenhouse:nowhere:999", url: "https://job-boards.greenhouse.io/nowhere/jobs/999", company: "Nowhere", title: "Analyst" },
    pick("greenhouse:hooli:7001"),
  ] }, ctx("Apply me to the analyst roles at Nowhere and Hooli."));
  eq(out.queued, 0);
  eq(out.refused.length, 2);
  assert(out.refused.every((r: any) => typeof r.reason === "string" && r.reason.length > 15 && r.posting), "each refusal has the posting and a reason");
  assert(/not .*on file|not found/i.test(out.refused[0].reason), out.refused[0].reason);
  assert(/closed/i.test(out.refused[1].reason), out.refused[1].reason);
  eq(wants.dump().u1 ?? [], []);
});

Deno.test("WO-091b/4 BR-018: the exact posting already applied to (this thread's tracker, another thread's, or Trainee's queue) is refused; another posting at that employer is not (D-MS-3)", async () => {
  const NW = "https://job-boards.greenhouse.io/northwindledger/jobs/2002";
  const queueRow = (url: string, ago: number) => ({ id: "J-9", company: "Northwind Ledger", url, state: "confirmed", created_at: new Date(NOW - ago * DAY).toISOString(), updated_at: new Date(NOW - ago * DAY).toISOString() });
  // A hand-reported application names an employer, not a posting: it never blocks a different posting there.
  const { t } = setup();
  const state: Record<string, unknown> = {};
  await t.track_application.run({ company: "Northwind Ledger", role: "New Grad Software Engineer", stage: "Submitted" }, ctx("I applied to Northwind Ledger by hand", state, {}, NOW - 2 * DAY));
  const byEmployer: any = await t.queue_applications.run({ postings: [pick("greenhouse:northwindledger:2002")] },
    ctx("Apply me to the New Grad Software Engineer role at Northwind Ledger.", state));
  eq(byEmployer.queued, 1, "an employer-level note is not this posting (no one-per-company rule)");

  // The same posting recorded in Trainee's own queue, however long ago, is a duplicate, under another host spelling too.
  for (const [ago, url] of [[3, NW], [40, "https://boards.greenhouse.io/northwindledger/jobs/2002"]] as const) {
    const mail = memoryMailStore({ queue: { u1: [queueRow(url, ago)] } });
    const out: any = await setup({ mail }).t.queue_applications.run({ postings: [pick("greenhouse:northwindledger:2002")] }, ctx("Apply me to the New Grad Software Engineer role at Northwind Ledger."));
    eq(out.queued, 0, `the same posting ${ago} days later is still a duplicate`);
    assert(/same posting/i.test(out.refused[0].reason) && !/30 days/.test(out.refused[0].reason), out.refused[0].reason);
  }
  // A different posting at the same employer, applied to 3 days ago through Trainee, is allowed.
  const mail3 = memoryMailStore({ queue: { u1: [queueRow("https://job-boards.greenhouse.io/northwindledger/jobs/1", 3)] } });
  eq(((await setup({ mail: mail3 }).t.queue_applications.run({ postings: [pick("greenhouse:northwindledger:2002")] }, ctx("Apply me to the New Grad Software Engineer role at Northwind Ledger."))) as any).queued, 1, "another posting at the same employer within 30 days is allowed");
});

Deno.test("WO-091b/5 BR-019: no one-per-company window (D-MS-3): a different posting 10 days after a rejection is queued; only the exact posting is refused, at any date", async () => {
  const row = (url: string, ago: number, state = "confirmed") => ({ id: "J-5", company: "Eastbank Systems", url, state, created_at: new Date(NOW - ago * DAY).toISOString(), updated_at: new Date(NOW - ago * DAY).toISOString() });
  const EB = "https://job-boards.greenhouse.io/eastbank/jobs/3003";
  const ask = (rows: any[], s: Record<string, unknown> = {}) => setup({ mail: memoryMailStore({ queue: { u1: rows } }) }).t.queue_applications.run({ postings: [pick("greenhouse:eastbank:3003")] }, ctx("Apply me to the Early Career role at Eastbank Systems.", s)) as Promise<any>;
  // Employer-level tracker rejection 10 days ago (no posting named): the new posting goes through.
  const { t } = setup();
  const state: Record<string, unknown> = {};
  await t.track_application.run({ company: "Eastbank Systems", role: "Software Engineer", stage: "Rejected" }, ctx("I applied to Eastbank Systems and got rejected", state, {}, NOW - 10 * DAY));
  eq(((await t.queue_applications.run({ postings: [pick("greenhouse:eastbank:3003")] }, ctx("Apply me to the Early Career role at Eastbank Systems.", state))) as any).queued, 1, "10 days after a rejection at the employer: allowed");
  eq((await ask([row("https://job-boards.greenhouse.io/eastbank/jobs/9", 10)])).queued, 1, "another posting there 10 days ago: allowed");
  const dup = await ask([row(EB, 10)]);
  eq(dup.queued, 0, "the exact posting 10 days ago: refused");
  assert(/same posting/i.test(dup.refused[0].reason) && !/30 days|2026-11-09/.test(dup.refused[0].reason), dup.refused[0].reason);
  eq((await ask([row(EB, 31)])).queued, 0, "the exact posting 31 days ago: still refused (no window)");
  eq((await ask([row(EB, 2, "queued")])).queued, 1, "a row that never went out is not an application");
});

Deno.test("WO-091b/6 BR-021: the person's confirmed current employer is refused; a past one, or an unconfirmed draft, is not", async () => {
  const msg = "Apply me to the Software Engineer, Platform role at Copperline Infra.";
  const cur = setup();
  const out: any = await cur.t.queue_applications.run({ postings: [pick("greenhouse:copperlineinfra:4100016")] },
    ctx(msg, { profile: { facts: [confirmedFact("I currently work part-time at Copperline Infra LLC")] } }));
  eq(out.queued, 0);
  assert(/current employer/i.test(out.refused[0].reason), out.refused[0].reason);

  const past = setup();
  eq(((await past.t.queue_applications.run({ postings: [pick("greenhouse:copperlineinfra:4100016")] },
    ctx(msg, { profile: { facts: [confirmedFact("I interned at Copperline Infra in summer 2024")] } }))) as any).queued, 1, "a past internship is not a current employer");
  const draft = setup();
  eq(((await draft.t.queue_applications.run({ postings: [pick("greenhouse:copperlineinfra:4100016")] },
    ctx(msg, { profile: { facts: [{ ...confirmedFact("I currently work at Copperline Infra"), needs_confirmation: true, status: "draft" }] } }))) as any).queued, 1, "only confirmed facts (D-007)");
  // Their knowing go-ahead, in their own words this turn.
  const ok = setup();
  eq(((await ok.t.queue_applications.run({ postings: [pick("greenhouse:copperlineinfra:4100016")] },
    ctx("I know I work there, apply me to the Copperline Infra platform role anyway.", { profile: { facts: [confirmedFact("I currently work part-time at Copperline Infra")] } }))) as any).queued, 1);
});

Deno.test("WO-091b/7 R8: three bad picks in one call: queued 0, each refused with its own reason", async () => {
  const state: Record<string, unknown> = { profile: { facts: [confirmedFact("Software engineer at Copperline Infra (current)")] } };
  const mail = memoryMailStore({ queue: { u1: [{ id: "J-7", company: "Northwind Ledger", url: "https://job-boards.greenhouse.io/northwindledger/jobs/2002", state: "confirmed", created_at: new Date(NOW - DAY).toISOString(), updated_at: new Date(NOW - DAY).toISOString() }] } });
  const { wants, t } = setup({ mail });
  const out: any = await t.queue_applications.run({ postings: [
    pick("greenhouse:meridian:1001", { company: "Quickhire Remote Jobs", title: "Operations" }),
    pick("greenhouse:northwindledger:2002"),
    pick("greenhouse:copperlineinfra:4100016"),
  ] }, ctx("Apply me to the operations role at Quickhire Remote Jobs, and the Northwind Ledger and Copperline Infra roles.", state));
  eq(out.queued, 0);
  eq(out.refused.map((r: any) => r.posting.company), ["Meridian Fulfillment", "Northwind Ledger", "Copperline Infra, Inc."]);
  const [wrong, tracked, current] = out.refused.map((r: any) => r.reason);
  assert(/not the employer/i.test(wrong), wrong);
  assert(/same posting/i.test(tracked) && !/not the employer/i.test(tracked), tracked);
  assert(/current employer/i.test(current), current);
  eq(wants.dump().u1 ?? [], []);
});

Deno.test("WO-091b/8 a broad ask queues across employers; one naming an employer holds to it; names are compared without case, punctuation or Inc/LLC", async () => {
  const a = setup();
  const out: any = await a.t.queue_applications.run({ postings: [pick("greenhouse:acme:5001"), pick("greenhouse:globex:5002"), pick("greenhouse:initech:5003")] },
    ctx("Apply me to 3 data analyst jobs, remote is fine.", {}, { before: "" }));
  eq(out.queued, 3, "the person left the choice of employers open");

  const b = setup();
  const held: any = await b.t.queue_applications.run({ postings: [pick("greenhouse:acme:5001"), pick("greenhouse:stripe:6001")] },
    ctx("Apply me to data analyst jobs at Stripe.", {}, { before: "" }));
  eq(held.queued, 1);
  eq(b.wants.dump().u1.map((w) => w.company), ["Stripe"]);
  eq(held.refused.map((r: any) => r.posting.company), ["Acme Corp"]);

  const c = setup();
  eq(((await c.t.queue_applications.run({ postings: [pick("greenhouse:initech:5003")] }, ctx("apply me to the initech, inc data analyst role", {}, { before: "" }))) as any).queued, 1, "Initech LLC = initech, inc");
});

Deno.test("WO-091b/9 a pick by position must be one the previous turn showed, through the agent loop", async () => {
  const shown = "Here are three:\n1. Data Analyst at Acme Corp (remote)\n2. Data Analyst at Globex (Austin)\n3. Data Analyst at Stripe (NYC)";
  const run = async (picked: string, message: string) => {
    const { wants, t } = setup();
    let step = 0;
    const model = async () => step++ === 0
      ? { content: [{ type: "tool_use", id: "q1", name: "queue_applications", input: { postings: [pick(picked)] } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
    const seen: any[] = [];
    const wrapped = async (p: any) => { seen.push(p); return await model(); };
    await runAgentTurn({ system: "s", history: [{ role: "user", content: "find me data analyst jobs" }, { role: "assistant", content: shown }], message, tools: [t.queue_applications], model: wrapped as any, ctx: { userId: "u1", threadId: "t1", now: NOW, state: {} } });
    const result = JSON.stringify(seen[1].messages.at(-1));
    return { queued: (wants.dump().u1 ?? []).length, result };
  };
  eq((await run("greenhouse:acme:5001", "apply me to the first one")).queued, 1, "the first one shown");
  eq((await run("greenhouse:globex:5002", "yes, the second")).queued, 1);
  const wrong = await run("greenhouse:initech:5003", "apply me to the first one");
  eq(wrong.queued, 0, "a posting the person was never shown is not 'the first one'");
  assert(/Initech/.test(wrong.result) && /refused/.test(wrong.result), `the model reads the refusal: ${wrong.result.slice(0, 300)}`);
  eq((await run("greenhouse:initech:5003", "apply me to the operations role")).queued, 0, "one specific role, its employer never named nor shown");
});

// ------------------------------------------------------------------------------------------------ F4: remember_instruction
const NOT_KEPT = "Not kept: every application and message still needs your yes on its card.";

Deno.test("WO-091b/10 BR-084: 'autopilot ... and don't ask me' is not kept; nothing is stored", async () => {
  const memory = memoryStandingStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], memory } as any).map((x) => [x.name, x]));
  const msg = "Set up autopilot: apply to anything with fit 80 or more at my 25 companies, max 10 a day, and don't ask me.";
  let err = "";
  try { await t.remember_instruction.run({ instruction: "Autopilot: apply without asking me", quote: "and don't ask me" }, ctx(msg)); } catch (e) { err = (e as Error).message; }
  eq(err, NOT_KEPT);
  eq(await memory.standing("u1"), [], "memory.standing stays empty");
  // The same through the agent loop: the model reads the refusal in the tool result.
  let step = 0;
  const seen: any[] = [];
  const model = async (p: any) => { seen.push(p); return step++ === 0
    ? { content: [{ type: "tool_use", id: "r1", name: "remember_instruction", input: { instruction: "Autopilot: apply to fit 80+ without asking", quote: "don't ask me" } }], stop_reason: "tool_use" }
    : { content: [{ type: "text", text: "I can't apply without your yes on each card." }], stop_reason: "end_turn" }; };
  const r = await runAgentTurn({ system: "s", history: [], message: msg, tools: [t.remember_instruction], model: model as any, ctx: { userId: "u1", threadId: "t1", now: NOW, state: {} } });
  eq(r.tool_calls.map((x) => [x.name, x.ok]), [["remember_instruction", false]]);
  assert(JSON.stringify(seen[1].messages.at(-1)).includes(NOT_KEPT));
  eq(await memory.standing("u1"), []);
});

Deno.test("WO-091b/11 every instruction that waives approval or asks for a forbidden act is refused", () => {
  const refused: [string, string][] = [
    ["Apply without asking me", "apply without asking me"],
    ["Don't ask me before applying", "don't ask me before applying"],
    ["Stop asking me", "just stop asking me"],
    ["Auto-apply to anything over fit 80", "auto-apply to anything over 80"],
    ["Turn on autopilot", "turn on autopilot"],
    ["Auto submit when ready", "auto submit applications when ready"],
    ["Send outreach emails without my approval", "send outreach emails without my approval"],
    ["Skip the approval card", "skip the approval card"],
    ["Share my resume with any recruiter who asks", "share my resume with any recruiter who asks"],
    ["Use my password to log in for me", "use my password to log in for me"],
    ["Enter the one-time code for me", "enter the one-time code for me"],
    ["Easy Apply on LinkedIn for me", "easy apply on linkedin for me"],
    ["Message recruiters on LinkedIn every day", "message recruiters on linkedin every day"],
    ["Apply on Indeed automatically", "apply on indeed automatically"],
    ["Apply to everything found and just send it", "apply to everything you find and just send it"],
    ["Auto-apply to all of it", "I don't care, auto-apply everything"],
  ];
  for (const [text, said] of refused) {
    const r = addStanding([], { text, said, now: NOW });
    assert(!r.ok && r.error === NOT_KEPT, `should be refused: ${text}`);
  }
});

Deno.test("WO-091b/12 false-positive guards: ordinary standing instructions are still kept", () => {
  const kept: [string, string][] = [
    ["Don't ask about relocation again", "don't ask me about relocation again"],
    ["Ask before weekends", "ask me before weekends"],
    ["Don't ask for my GPA again", "don't ask me for my GPA again"],
    ["Always ask before applying", "always ask me before applying"],
    ["Never apply without asking", "never apply anywhere without asking me"],
    ["Needs visa sponsorship (F-1 OPT)", "I will need visa sponsorship"],
    ["No staffing agencies", "no staffing agencies"],
    ["Never before 9am", "never before 9am"],
    ["No LinkedIn or Indeed postings", "don't show me linkedin or indeed postings"],
    ["No auto-generated cover letters", "no auto-generated cover letters"],
    ["Never auto-apply", "never auto-apply for me"],
    ["Don't share my resume with staffing agencies", "don't share my resume with staffing agencies"],
    ["Don't ask about salary", "stop asking me about salary"],
  ];
  for (const [text, said] of kept) {
    const r = addStanding([], { text, said, now: NOW });
    assert(r.ok, `should be kept: ${text} (${!r.ok ? r.error : ""})`);
  }
});
