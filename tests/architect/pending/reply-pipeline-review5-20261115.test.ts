// Review of #849, round 5 (2026-11-15): a page unit belongs to the organisations it names, so a sentence about one employer (or
// carried from one, or about none) never stands on a page about another, research-only turns included; figures in words code
// cannot read are refused; an offer question opening with a modal word is not a name. Earlier tests unchanged. Invented fixtures.
import { Ledger, runReplyPipeline, unitNames } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const yes = async (cs: { claim: string; source: string }[]) => cs.map(() => "yes" as const);
const run = (d: string, l: Ledger) => runReplyPipeline(d, l, { judge: yes, ask: "x", repair: null });
const posting = (l: Ledger) => l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1" }, requirements: { required: ["Pursuing a BS in Computer Science"], preferred: [] } });

Deno.test("#849 round 5 B1/B2: a page about another employer never holds a sentence about this one, or about none", async () => {
  const l = new Ledger(); posting(l);
  const pg = l.add("page", "Citadel interns must hold an active security clearance.", { host: "levels.example", url: "https://levels.example/citadel" });
  eq(unitNames(l.get(pg)!, true), ["Citadel"], "the page names Citadel");
  for (const d of [`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. Interns must hold an active security clearance [${pg}].`, `Interns must hold an active security clearance [${pg}].`]) {
    eq(/clearance/.test((await run(d, l)).text), false, d);
  }
  const r = new Ledger();
  const a = r.add("page", "Jane Street interns earn $20,000 a month.", { host: "a.example", url: "https://a.example/js" });
  const b = r.add("page", "Citadel interns must pass a background check.", { host: "b.example", url: "https://b.example/c" });
  const out = await run(`Jane Street interns earn $20,000 a month [${a}]. They must pass a background check [${b}].`, r);
  eq([/\$20,000/.test(out.text), /background check/.test(out.text)], [true, false], "research-only: the pronoun is Jane Street's");
});

Deno.test("#849 round 5 B3: a singular magnitude or an ordinal is a figure code cannot check, so it never stands", async () => {
  const l = new Ledger(); posting(l);
  for (const d of ["PayPal pays a hundred dollars an hour [E1].", "PayPal pays its interns a million dollars.", "PayPal's process has a second round."]) {
    eq((await run(d, l)).text.includes(d.replace(/ \[E1\]/, "")), false, d);
  }
});

Deno.test("#849 round 5 B4: an offer question opening with a modal word stands", async () => {
  const l = new Ledger(); posting(l);
  for (const d of ["Want me to prepare the PayPal application for your approval?", "Would you like me to prepare the PayPal application?", "Shall I draft the PayPal application?"]) {
    eq((await run(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. ${d}`, l)).text.includes(d), true, d);
  }
});
