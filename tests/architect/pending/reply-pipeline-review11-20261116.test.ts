// Review of #849, round 11 (2026-11-16). Earlier tests are unchanged except where round 10's file says so. Fixtures are invented.
// Stub judges only; no network.
// B1: a capitalised function word or imperative opener ("Don't", "Never", "Please", "Politely") is no employer: it is not carried.
// N1: a judge answer of the wrong length is asked once more inside the cap; a second bad answer fails closed.
// N2: "one" after a determiner ("Which one do you prefer?") is a pronoun, not a figure.
// N3: a season in a posting's title counts as current only until it ends (Summer to Aug 31, Fall to Dec 31, Spring to Jun 30,
//     Winter to Mar 31; a bare year to Dec 31).
// N4: after a sentence about an employer no unit names, "It pays …" never stands on a unit that names no one.
import * as RP from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import * as SP from "../../../supabase/functions/_shared/agent/research/support.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const { Ledger, runReplyPipeline } = RP;
type Ledger = InstanceType<typeof RP.Ledger>;
type C = { claim: string; source: string };
const NOW = Date.parse("2026-11-16T12:00:00Z");
let asked: string[] = [];
const yes = async (cs: C[]) => { asked.push(...cs.map((c) => c.claim)); return cs.map(() => "yes" as const); };
const no = async (cs: C[]) => { asked.push(...cs.map((c) => c.claim)); return cs.map(() => "no" as const); };
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
const paypal = () => { const l = new Ledger(NOW);
  l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", deadline: "December 6, 2026", url: "https://paypal.example/1" } }); return l; };

Deno.test("#849 round 11 B1: an opener ('Don't', 'Never', 'Please', 'Politely') is no employer, and the sentence after it keeps its subject", async () => {
  for (const mid of ["Don't ask about pay yet.", "Don't ask about sponsorship, because it comes later.", "Always ask about the team early.", "Also ask about relocation.", "Please ask about the team.",
    "Never ask about pay in the first call.", "First ask about the team.", "Just ask about the timeline.", "Then ask about next steps.", "Politely ask about the timeline.", "Ideally ask about the team.", "Maybe ask about the team."]) {
    const l = paypal(); asked = [];
    const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /pay/)}]. ${mid} It closes December 6, 2026 [${id(l, /closes/)}].`, l, { judge: yes, ask: "tell me about the paypal role", repair: null });
    eq(out.text.includes("It closes December 6, 2026."), true, `after "${mid}": ${out.text}`);
    eq(asked.some((c) => /about (?:Don't|Never|Always|Also|Please|First|Just|Then|Politely|Ideally|Maybe)\)/.test(c)), false, `the judge is never told the opener is the subject: ${asked.join(" || ")}`);
  }
});

Deno.test("#849 round 11 N1: a wrong-length judge answer is asked once more inside the cap; a second one fails closed", async () => {
  let n = 0;
  const flaky = async (cs: C[]) => { n++; return (n === 1 ? cs.slice(1) : cs).map(() => "yes" as const); };
  const l = paypal();
  const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /pay/)}]. It closes December 6, 2026 [${id(l, /closes/)}].`, l, { judge: flaky, ask: "x", repair: null });
  eq([out.text.includes("$28-$49"), out.text.includes("December 6"), (out as any).judgeCalls], [true, true, 2], out.text);
  let m = 0;
  const broken = async (cs: C[]) => { m++; return cs.slice(1).map(() => "yes" as const); };
  const o2 = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /pay/)}].`, paypal(), { judge: broken, ask: "x", repair: null });
  eq([o2.text.includes("$28-$49"), m <= 2], [false, true], o2.text);
});

Deno.test("#849 round 11 N2: 'which one' is a pronoun, not a figure", async () => {
  eq(SP.personQuestion("Which one do you prefer?"), true, "a question to the person");
  eq(SP.plainTalk("tell me which one you prefer."), true, "plain talk");
  eq(SP.personQuestion("Do you want one more posting?"), false, "'one more' is still a figure");
  const l = paypal();
  const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /pay/)}]. Which one do you prefer?`, l, { judge: no, ask: "compare", repair: null });
  eq(out.text.includes("Which one do you prefer?"), true, out.text);
});

Deno.test("#849 round 11 N3: a season in the title is current only until it ends", async () => {
  for (const [title, stands] of [["SWE Intern - Summer 2026", false], ["SWE Intern - Fall 2026", true], ["SWE Intern - Winter 2026", false], ["SWE Intern - Spring 2027", true], ["Analyst 2026", true], ["Analyst 2025", false]] as const) {
    const l = new Ledger(NOW); l.fromToolResult("get_posting", { posting: { company: "PayPal", title, pay: "$28-$49 an hour", url: "https://paypal.example/x" } });
    const out = await runReplyPipeline(`PayPal pays $28-$49 an hour [${l.units[0].id}].`, l, { judge: yes, ask: "what does it pay", repair: null });
    eq(out.text.startsWith("PayPal pays $28-$49 an hour."), stands, `${title}: ${out.text}`);
  }
});

Deno.test("#849 round 11 N4: after an employer no unit names, 'It pays …' never stands on a unit that names no one", async () => {
  const l = new Ledger(NOW);
  l.fromToolResult("get_posting", { posting: { title: "Software Engineer Intern", location: "Austin, TX", pay: "$45 an hour", state: "open", url: "https://careers.acmecorp.com/jobs/1" } });
  const out = await runReplyPipeline(`Stripe is hiring interns in Austin. It pays $45 an hour [${id(l, /pay/)}].`, l, { judge: yes, ask: "what does the stripe internship pay", repair: null });
  eq(out.text.includes("pays $45"), false, out.text);
});
