// Review of #849, round 7 (2026-11-16): a page about another employer names it however the fact is phrased ("At Citadel, …",
// "Interns at Citadel …", "Citadel typically requires …", "Citadel, a hedge fund, requires …", its own careers site, Google), so
// such a page never holds a sentence of another employer's reply; a source is dropped only where it is used as a source.
// Earlier tests unchanged. Invented fixtures.
import { Ledger, runReplyPipeline } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const yes = async (cs: { claim: string; source: string }[]) => cs.map(() => "yes" as const);
const posting = (l: Ledger, co = "PayPal", url = "https://paypal.example/1") => l.fromToolResult("get_posting", { posting: { company: co, title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", url } });

Deno.test("#849 round 7: another employer's page never holds a requirement in this employer's reply", async () => {
  for (const [text, host] of [["At Citadel, interns must hold an active security clearance.", "s.example"], ["Interns at Citadel must hold an active security clearance.", "s.example"],
    ["Citadel typically requires an active security clearance.", "s.example"], ["Citadel, a hedge fund, requires an active security clearance.", "s.example"],
    ["Citadel interns must hold an active security clearance.", "www.citadel.com"], ["Google interns must hold an active security clearance.", "s.example"]]) {
    for (const two of [false, true]) {
      const l = new Ledger(); posting(l); if (two) posting(l, "Citadel", "https://citadel.example/1");
      const pg = l.add("page", text, { host, url: `https://${host}/x` });
      const out = await runReplyPipeline(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. Interns must hold an active security clearance [${pg}].`, l, { judge: yes, ask: "x", repair: null });
      eq(/clearance/.test(out.text), false, `${text} (${two ? "two postings" : "one"})`);
    }
  }
});

Deno.test("#849 round 7: a source used as a source still names no employer, so market sentences stand", async () => {
  const l = new Ledger(); posting(l);
  const g = l.add("page", "Software engineering interns earn an average of $45 an hour on Glassdoor.", { host: "glassdoor.com", url: "https://glassdoor.com/x" });
  const b = l.add("page", "According to the Bureau of Labor Statistics, the median pay for software developers was $132,270 in May 2023.", { host: "bls.gov", url: "https://bls.gov/x" });
  const out = await runReplyPipeline(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. Software engineering interns earn an average of $45 an hour [${g}]. According to the Bureau of Labor Statistics, the median pay for software developers was $132,270 in May 2023 [${b}].`, l, { judge: yes, ask: "x", repair: null });
  for (const s of ["$45 an hour", "$132,270"]) eq(out.text.includes(s), true, s);
});
