// 1v1 (2026-11-01): the router's advice turns answered with long template prose and internal words (Q87, Q88, Q94):
// resume guidance, interview prep, a self-graded answer read as a career path, and offer negotiation. Each now answers
// the question asked in a text or two, with one question at most and a concrete next step, in the gold's style
// (evals/career/one-v-one). Every person, posting and number here is SYNTHETIC test data.
//   A. the 19 scenarios pass their rubric through the live path, rendered by the channel's own adapter;
//   B. the answers follow what the person said, not one template: the GPA they state, the offer against the range the
//      named posting states, the counter at the figure they want, the answer they paste scored;
//   C. what stays true: no reminder claimed, no live help during an interview, nothing tailored or sent.
import { SCENARIOS } from "../../evals/career/one-v-one/scenarios.ts";
import { runAll } from "../../evals/career/one-v-one/run.ts";
import { openWorld, worldTurn } from "../../evals/career/world.ts";
import { seed } from "../../evals/career/one-v-one/run.ts";

const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ADVICE = ["V029", "V032", "V033", "V074", "V075", "V077", "V078", "V079", "V080", "V081", "V083", "V084", "V086", "V087", "V088", "V089", "V090", "V093"];
const JARGON = /\bsource class\b|\bcompany[- ]file\b|\bheld for your approval\b|\bnull\b|\brouter\b|\bpayload\b/i;

async function say(state: "new" | "profile" | "inflight", msg: string) {
  const w = await openWorld(seed(state));
  return (await worldTurn(w, { brain: "router", threadId: "A", message: msg, now: w.now }) as any).reply as string;
}

Deno.test("A. the advice scenarios pass their rubric on every channel they run on (texting voice on)", async () => {
  const rows = await runAll(SCENARIOS.filter((s) => ADVICE.includes(s.id)));
  const bad = rows.filter((r) => !r.on.g.pass).map((r) => `${r.id} ${r.on.g.failed.join("+")} ${JSON.stringify(r.on.g.why)}`);
  assert(!bad.length, `failing:\n${bad.join("\n")}`);
  for (const r of rows) assert(!JARGON.test(r.reply), `${r.id}: internal words in "${r.reply}"`);
});

Deno.test("B. the GPA the person states decides the answer", async () => {
  const low = await say("new", "should i put my gpa on my resume its a 3.1");
  const high = await say("new", "should i put my gpa on my resume its a 3.8");
  assert(/leave it off/i.test(low) && !/put your gpa on/i.test(low), `3.1: ${low}`);
  assert(/put your gpa on/i.test(high) && /3\.8/.test(high), `3.8: ${high}`);
});

Deno.test("B. an offer is read against the range the named posting states; none stated, none claimed", async () => {
  const inRange = await say("new", "i got an offer from stripe for 100k for the data analyst job should i take it");
  assert(/\$95,000-\$120,000/.test(inRange) && /counter/i.test(inRange), `in range: ${inRange}`);
  const below = await say("new", "i got an offer from stripe for 80k for the data analyst job should i take it");
  assert(/below/i.test(below) && /\$95,000/.test(below), `below range: ${below}`);
  const none = await say("new", "i got an offer from ramp for 100k should i take it");
  assert(!/\$\d{2,3},\d{3}-\$/.test(none) && !/sits in|is below|is above/.test(none) && /counter/i.test(none), `no range on the Ramp posting: ${none}`);
});

Deno.test("B. the counter email asks for the figure the person wants, and is theirs to send", async () => {
  const r = await say("new", "write my counter offer email, offer is 80k i want 92k");
  assert(/\$92,000/.test(r) && !/\$90,000/.test(r), `the wanted figure: ${r}`);
  assert(/yours to send/i.test(r) && !/\b(sent|i emailed)\b/i.test(r), `nothing sent: ${r}`);
});

Deno.test("B. a pasted interview answer is scored, with what it lacks and a shape to try", async () => {
  const weak = await say("new", "Q was tell me about yourself. my answer: im a data analyst i like data and i want to work here");
  const strong = await say("new", "Q was tell me about a project. my answer: first, our team had a slow report. I built a SQL pipeline in 3 weeks and the result was a 40% faster weekly report used by 12 people");
  const n = (r: string) => Number((/(\d) out of 5/.exec(r) || [])[1]);
  assert(n(weak) >= 1 && /not what you did/.test(weak) && /Try: "/.test(weak), `weak: ${weak}`);
  assert(n(strong) > n(weak), `the stronger answer scores higher: ${n(strong)} vs ${n(weak)}`);
});

Deno.test("C. no reminder is claimed, no live help is offered, and a banking mock opens on a technical", async () => {
  const rem = await say("new", "remind me about my interview on tuesday");
  assert(/can't set reminders/i.test(rem) && !/reminder (is )?set|i'?ll remind you/i.test(rem), `reminder: ${rem}`);
  const live = await say("new", "can you help me during my interview tomorrow");
  assert(/^Not during it/.test(live) && /won't feed you answers/.test(live), `live help: ${live}`);
  const mock = await say("new", "mock interview for investment banking");
  assert(/First question: "Walk me through a DCF\."/.test(mock), `banking mock: ${mock}`);
});
