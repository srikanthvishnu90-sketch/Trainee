// Review of #849, round 8 (2026-11-15): the subject is structural. A clause is about the employer it names, or else the one carried
// from the clause before it (across sentences, whatever word refers back); every check of it (the units it may stand on, layer A,
// the judge, the repair pass and code's fallback line) uses that subject. A clause naming two employers is checked part by part.
// Earlier tests are unchanged. Fixtures are invented.
import { Ledger, runReplyPipeline } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { keepSupported } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { testSupportJudge } from "../support-test-judge.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
let asked: { claim: string; source: string }[] = [];
const yes = async (cs: { claim: string; source: string }[]) => { asked.push(...cs); return cs.map(() => "yes" as const); };
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
const paypal = (l: Ledger) => l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1" }, requirements: { required: ["Pursuing a BS in Computer Science"], preferred: [] } });
const citadel = (l: Ledger, where = "New York, NY", pay = "$80 an hour") => l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", location: where, pay, state: "open", url: "https://citadel.example/1" }, requirements: { required: ["An active security clearance"], preferred: [] } });
// A line carried from an earlier reply whose employer code cannot tell (it may be another employer's).
const earlier = (l: Ledger) => l.add("chat", "New York, NY: $80 an hour", { source: "an earlier reply in this chat" });

Deno.test("#849 round 8 B1: the repaired sentence is verified in the place it is sent, with the subject carried into it", async () => {
  // Fail-open on 5828d1a93: the repair's "It pays $80…" was verified alone (no subject), so an unowned earlier line held it.
  const l = new Ledger(); paypal(l); const e = earlier(l);
  const d = `PayPal's SWE Intern in Chicago pays $28-$49 an hour [${id(l, /^PayPal.*pay/)}]. It pays $80 an hour in New York [${e}].`;
  const out = await runReplyPipeline(d, l, { judge: yes, ask: "what does the paypal role pay", repair: async () => `It pays $80 an hour in New York [${e}].` });
  eq(/\$80/.test(out.text), false, out.text);
  // Wrong refusal on 5828d1a93: in a two-employer turn the repaired "It requires…" (PayPal's, in place) was refused as about no one.
  const m = new Ledger(); paypal(m); citadel(m);
  const d2 = `PayPal's SWE Intern in Chicago pays $28-$49 an hour [${id(m, /^PayPal.*pay/)}]. It requires an active security clearance [${id(m, /clearance/)}].`;
  const out2 = await runReplyPipeline(d2, m, { judge: yes, ask: "what does the paypal role need", repair: async () => `It requires pursuing a BS in Computer Science [${id(m, /Computer Science/)}].` });
  eq([/Computer Science/.test(out2.text), /clearance/.test(out2.text)], [true, false], out2.text);
});

Deno.test("#849 round 8 B2: 'the company', 'there', 'this role' and any other referring wording carry the subject", async () => {
  for (const second of ["The company pays $80 an hour in New York", "Pay there is $80 an hour for New York interns", "New York pay for this role is $80 an hour", "Interns at the company earn $80 an hour in New York"]) {
    const l = new Ledger(); paypal(l); const e = earlier(l);
    const out = await runReplyPipeline(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [${id(l, /^PayPal.*pay/)}]. ${second} [${e}].`, l, { judge: yes, ask: "x", repair: null });
    eq(/\$80/.test(out.text), false, second);
  }
  // The judge is shown the carried subject for a clause that rests on a page naming no employer.
  const l = new Ledger(); paypal(l);
  const pg = l.add("page", "Interns must hold an active security clearance.", { host: "s.example", url: "https://s.example/x" });
  asked = [];
  await runReplyPipeline(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. The company requires an active security clearance [${pg}].`, l, { judge: yes, ask: "x", repair: null });
  const c = asked.filter((a) => /clearance/.test(a.claim));
  eq(c.length > 0 && c.every((a) => /PayPal/.test(a.claim)), true, JSON.stringify(asked));
});

Deno.test("#849 round 8 B3: a split clause keeps the sentence's subject (the support check and the pipeline)", async () => {
  // Fail-open on 5828d1a93 (trunk judged the whole sentence): "they must pass a background check" was judged alone and stood on
  // Citadel's page.
  asked = [];
  // (a judge that reads words, and refuses every quote check, so the sentence reaches the clause split)
  const words = async (cs: { claim: string; source: string }[]) => { asked.push(...cs); return (await testSupportJudge(cs)).map((v, j) => /^The marked text/.test(cs[j].claim) ? "no" as const : v); };
  const k = await keepSupported("Jane Street interns earn $20,000 a month, and they must pass a background check.",
    [{ text: "Jane Street interns earn $20,000 a month.", title: "Page A" }, { text: "Citadel interns must pass a background check.", title: "Page B" }], { judge: words });
  eq(k.text, "", JSON.stringify(asked));
  for (const a of asked) if (/background check/.test(a.claim) && !/\$20,000/.test(a.claim)) eq(/Jane Street/.test(a.claim), true, a.claim);
  const r = new Ledger();
  const a = r.add("page", "Jane Street interns earn $20,000 a month.", { host: "a.example", url: "https://a.example/js" });
  const b = r.add("page", "Citadel interns must pass a background check.", { host: "b.example", url: "https://b.example/c" });
  asked = [];
  const out = await runReplyPipeline(`Jane Street interns earn $20,000 a month [${a}], and they must pass a background check [${b}].`, r, { judge: words, ask: "x", repair: null });
  eq(/background check/.test(out.text), false, out.text);
  for (const x of asked) if (/background check/.test(x.claim)) eq([/Jane Street/.test(x.claim), /Citadel/.test(x.source)], [true, false], JSON.stringify(x));
});

Deno.test("#849 round 8 B4: a sentence comparing two employers is checked part by part, each figure against its own employer", async () => {
  const mk = () => { const l = new Ledger(); paypal(l); citadel(l); return l; };
  for (const d of ["PayPal pays $28-$49 an hour in Chicago, while Citadel pays $80 an hour in New York", "Citadel pays $80 an hour in New York, more than PayPal's $28-$49 an hour in Chicago"]) {
    const l = mk();
    const out = await runReplyPipeline(`${d} [${id(l, /^PayPal.*pay/)},${id(l, /^Citadel.*pay/)}].`, l, { judge: yes, ask: "compare paypal and citadel pay", repair: null });
    eq(out.text.startsWith(d), true, `${d} -> ${out.text}`);
  }
  // Each figure must be its own employer's: swapped figures never stand.
  const l = mk();
  const out = await runReplyPipeline(`PayPal pays $80 an hour in New York, while Citadel pays $28-$49 an hour in Chicago [${id(l, /^PayPal.*pay/)},${id(l, /^Citadel.*pay/)}].`, l, { judge: yes, ask: "compare paypal and citadel pay", repair: null });
  eq(/\$80|\$28/.test(out.text.split("\n")[0]), false, out.text);
});

Deno.test("#849 round 8 B5: code's fallback line lists only the subject's own posting facts", async () => {
  const l = new Ledger(); paypal(l); citadel(l, "Chicago, IL"); l.add("chat", "Chicago, IL: $95 an hour", { source: "an earlier reply in this chat" });
  const out = await runReplyPipeline(`PayPal pays $99 an hour in Chicago [${id(l, /^PayPal.*pay/)}].`, l, { judge: yes, ask: "what does it pay in chicago?", names: ["PayPal", "Citadel"], repair: null });
  eq([out.fallback, /\$28-\$49/.test(out.text), /Citadel|\$80|\$95/.test(out.text)], [true, true, false], out.text);
});

Deno.test("#849 round 8 B4: a comparison part's figure in words is never left to the judge", async () => {
  const l = new Ledger(); paypal(l); citadel(l);
  for (const d of ["PayPal pays $28-$49 an hour in Chicago, while Citadel pays a hundred dollars an hour", "PayPal pays $28-$49 an hour in Chicago, while Citadel pays fifty dollars an hour"]) {
    asked = [];
    const out = await runReplyPipeline(`${d} [${id(l, /^PayPal.*pay/)},${id(l, /^Citadel.*pay/)}].`, l, { judge: yes, ask: "compare", repair: null });
    eq([out.text.includes("Citadel pays"), asked.some((a) => /hundred|fifty/.test(a.claim))], [false, false], d);
  }
});
