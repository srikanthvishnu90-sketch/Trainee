// Review of #849, round 4 (2026-11-15): a sentence that names no employer cannot stand on another employer's unit; a figure in words
// and an opening name are never left to the judge alone; a place is not an owner, and the first employer named is the subject.
// Earlier tests are unchanged. Fixtures are invented.
import { Ledger, runReplyPipeline } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const mk = () => {
  const l = new Ledger();
  l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1" }, requirements: { required: ["Pursuing a BS in Computer Science"], preferred: [] } });
  l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", location: "New York, NY", pay: "$80 an hour", state: "closed", url: "https://citadel.example/1" }, requirements: { required: ["An active security clearance", "US citizenship"], preferred: ["Kdb+ experience"] } });
  return l;
};
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
let asked: { claim: string; source: string }[] = [];
const yes = async (cs: { claim: string; source: string }[]) => { asked.push(...cs); return cs.map(() => "yes" as const); };
const run = async (d: (l: Ledger) => string, l = mk()) => { asked = []; return await runReplyPipeline(d(l), l, { judge: yes, ask: "tell me about the paypal role", repair: null }); };

Deno.test("#849 round 4 B1: a sentence naming no employer never stands on another employer's unit", async () => {
  for (const second of [(l: Ledger) => `An active security clearance is required [${id(l, /clearance/)}].`, () => "An active security clearance is required.", () => "US citizenship is required.", () => "Kdb+ experience is preferred."]) {
    const r = await run((l) => `PayPal's SWE Intern in Chicago pays $28-$49 an hour [${id(l, /PayPal.*pay/)}]. ${second(l)}`);
    for (const a of asked) eq(/Citadel/.test(a.source), false, `the judge saw Citadel's unit for "${a.claim}"`);
    eq(/clearance is required \[|Citadel/.test(r.text), false, r.text);
  }
});

Deno.test("#849 round 4 B2: a figure in words, a quantity word or an opening employer name never goes to the judge alone", async () => {
  const l = new Ledger();
  l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1" }, requirements: { required: [], preferred: [] } });
  const count = l.add("chat", "The search (search_jobs) returned 3 postings.", { source: "search_jobs", owner: null });
  for (const d of [`The search returned five postings [${count}].`, "PayPal pays about fifty dollars an hour [E1].", "PayPal pays a six-figure salary [E1].", "Google requires a computer science degree [E1]."]) {
    asked = [];
    await runReplyPipeline(d, l, { judge: yes, ask: "x", repair: null });
    eq(asked.some((a) => /five|fifty|six-figure|Google/.test(a.claim)), false, d);
  }
});

Deno.test("#849 round 4: a place is not an owner; the first employer named is the subject; a carried subject skips unowned earlier-reply lines", async () => {
  const l = new Ledger();
  const place = l.add("chat", "Chicago, IL: $28-$49 an hour", { source: "an earlier reply in this chat" });
  eq(l.get(place)!.owner, null, "a City, ST line has no owner");
  l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", url: "https://paypal.example/1" } });
  l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", location: "Chicago, IL", pay: "$80 an hour", url: "https://citadel.example/1" } });
  const pp = id(l, /^PayPal.*pay/);
  eq((await runReplyPipeline(`PayPal pays $28-$49 an hour in Chicago [${pp}].`, l, { judge: yes, ask: "x", repair: null })).text.startsWith("PayPal pays $28-$49"), true, "kept");
  const r = await runReplyPipeline(`Citadel's role is also in Chicago. The pay there is $28-$49 an hour [${place}].`, l, { judge: yes, ask: "x", repair: null });
  eq(/\$28-\$49/.test(r.text), false, "PayPal's figure is not Citadel's");
});
