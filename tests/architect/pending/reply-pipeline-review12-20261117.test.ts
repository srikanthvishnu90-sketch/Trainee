// Review of #849, round 12 (2026-11-17). Earlier tests are unchanged. Fixtures are invented. Stub judges only; no network.
// B1: a name is known only as a posting's or a page's owner. A name some unit merely mentions (a record line "Intern at Stripe", a
//     page naming Stripe in passing) is still a subject of its own, and is carried: "It pays …" after it never takes PayPal's pay.
//     A carried subject never rests on a posting record whose employer code cannot tell.
// N3: a season anywhere in the title goes with its year: "2026 Summer Internship", "Summer Internship 2026", "Summer '26".
// N3 also: a title whose period has ended dates its figures however the year is written ("2026 Summer Internship").
// Note 2: "PayPal's Software Engineer Intern pays …" on the title "Software Engineer Intern - Summer 2027", and "PayPal's SWE Intern
//     closes December 6, 2026" on the deadline unit, stand.
import * as RP from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const { Ledger, runReplyPipeline } = RP;
type Ledger = InstanceType<typeof RP.Ledger>;
type C = { claim: string; source: string };
const NOW = Date.parse("2026-11-16T12:00:00Z");
const yes = async (cs: C[]) => cs.map(() => "yes" as const);
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
const paypal = (l: Ledger, extra: Record<string, unknown> = {}) => l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1", ...extra } });

Deno.test("#849 round 12 B1: a name a unit only mentions is a subject of its own, carried, and never takes another employer's figure", async () => {
  for (const where of ["record", "page", "none"]) {
    for (const d of ["Stripe is hiring in Chicago. It pays $28-$49 an hour [E].", "Stripe has a Chicago internship, I think. It pays $28-$49 an hour [E]."]) {
      const l = new Ledger(NOW);
      if (where === "record") l.addRecord(["experience: Software Engineering Intern at Stripe, Summer 2025"], []);
      paypal(l);
      if (where === "page") l.add("page", "Fintech interns often compare offers from Stripe and others.", { host: "blog.example", url: "https://blog.example/x" });
      const out = await runReplyPipeline(d.replace("[E]", `[${id(l, /\$28/)}]`), l, { judge: yes, ask: "what does stripe's chicago internship pay", repair: null });
      eq(/pays \$28/.test(out.text), false, `${where}: ${d} -> ${out.text}`);
    }
  }
  // A carried subject never rests on a posting record whose employer code cannot tell (another posting's, the turn only lacks its name).
  const l = new Ledger(NOW); paypal(l);
  l.fromToolResult("inspect_apply_flow", { url: "https://careers.acmecorp.com/jobs/1", posting: { title: "Software Engineer Intern", location: "Austin, TX", pay: "$45 an hour", state: "open" } });
  const out = await runReplyPipeline(`PayPal also has an Austin role. It pays $45 an hour [${id(l, /\$45/)}].`, l, { judge: yes, ask: "what does paypal's austin role pay", repair: null });
  eq(out.text.includes("$45"), false, out.text);
});

Deno.test("#849 round 12 N3: a season anywhere in the title goes with its year", async () => {
  for (const [t, cur] of [["2026 Summer Internship - Software Engineer", false], ["Summer Internship 2026", false], ["SWE Intern (Summer '26)", false], ["Software Engineer Intern - Summer 2026", false],
    ["2027 Summer Internship", true], ["Summer Internship 2027", true], ["SWE Intern (Summer '27)", true], ["Fall 2026 Intern", true], ["Winter 2026 Co-op", false], ["Analyst 2026", true]] as const) {
    eq(RP.titleYearsCurrent(t, NOW), cur, t);
  }
  const l = new Ledger(NOW); paypal(l, { title: "2026 Summer Internship - Software Engineer" });
  const out = await runReplyPipeline(`PayPal's internship pays $28-$49 an hour [${id(l, /pay/)}].`, l, { judge: yes, ask: "what does it pay", repair: null });
  eq(out.text.startsWith("PayPal's internship pays $28-$49 an hour."), false, out.text);
});

Deno.test("#849 round 12 note 2: the role without its season, and the deadline with its role, stand", async () => {
  const l = new Ledger(NOW); paypal(l, { title: "Software Engineer Intern - Summer 2027", deadline: "December 6, 2026" });
  const o1 = await runReplyPipeline(`PayPal's Software Engineer Intern pays $28-$49 an hour [${id(l, /pay/)}].`, l, { judge: yes, ask: "what does it pay", repair: null });
  eq(o1.text.startsWith("PayPal's Software Engineer Intern pays $28-$49 an hour."), true, o1.text);
  const m = new Ledger(NOW); paypal(m, { deadline: "December 6, 2026" });
  const o2 = await runReplyPipeline(`PayPal's SWE Intern closes December 6, 2026 [${id(m, /closes/)}].`, m, { judge: yes, ask: "when does the paypal swe intern close", repair: null });
  eq(o2.text.startsWith("PayPal's SWE Intern closes December 6, 2026."), true, o2.text);
  // (another employer still never takes it)
  const o3 = await runReplyPipeline(`Citadel's SWE Intern closes December 6, 2026 [${id(m, /closes/)}].`, m, { judge: yes, ask: "when does it close", repair: null });
  eq(o3.text.includes("Citadel's SWE Intern closes"), false, o3.text); // (the fallback may list PayPal's own deadline)
});
