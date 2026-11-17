// Review of #849, round 6 (2026-11-16): names come only from a page's own employer facts (not earlier-reply lines, skills,
// seasons or data sources), so a one-employer turn stays one employer and market sentences from a source page stand; a subject
// carries only into a sentence that leans on the one before; "a second look" is no figure. Earlier tests unchanged. Invented.
import { Ledger, runReplyPipeline, unitNames } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const yes = async (cs: { claim: string; source: string }[]) => cs.map(() => "yes" as const);
const run = (d: string, l: Ledger) => runReplyPipeline(d, l, { judge: yes, ask: "x", repair: null });
const posting = (l: Ledger) => l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", deadline: "December 6, 2026", url: "https://paypal.example/1" } });

Deno.test("#849 round 6: earlier-reply lines, skills, seasons and sources name no employer", () => {
  const l = new Ledger();
  const prev = l.add("chat", "Harbor Global, Intern: Fall 2027 start; Python and Java", { source: "an earlier reply in this chat" });
  const g = l.add("page", "Software engineering interns earn an average of $45 an hour on Glassdoor.", { host: "glassdoor.com", url: "https://glassdoor.com/x" });
  const b = l.add("page", "According to the Bureau of Labor Statistics, the median pay was $132,270.", { host: "bls.gov", url: "https://bls.gov/x" });
  eq([unitNames(l.get(g)!), unitNames(l.get(b)!)], [[], []], "a source page names no employer");
  eq(unitNames(l.get(prev)!), ["Harbor Global"], "a carried line belongs to its own employer only (no skill or season is a name)");
  const c = l.add("page", "Citadel interns must hold an active security clearance.", { host: "c.example", url: "https://c.example" });
  eq(unitNames(l.get(c)!, true), ["Citadel"], "a page's employer fact names its employer");
});

Deno.test("#849 round 6: a one-employer turn keeps its posting facts; market sentences from a source page stand", async () => {
  const l = new Ledger(); posting(l);
  l.add("chat", "Harbor Global, Intern: Fall 2027 start", { source: "an earlier reply in this chat" });
  const g = l.add("page", "Software engineering interns earn an average of $45 an hour on Glassdoor.", { host: "glassdoor.com", url: "https://glassdoor.com/x" });
  const out = await run(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. The posting is open and closes December 6, 2026 [E2]. Software engineering interns earn an average of $45 an hour [${g}].`, l);
  for (const s of ["$28-$49", "December 6, 2026", "$45 an hour"]) eq(out.text.includes(s), true, s);
});

Deno.test("#849 round 6: a fresh-topic sentence carries no subject; a leaning one does; 'a second look' is no figure", async () => {
  const l = new Ledger(); posting(l);
  const g = l.add("page", "Employment of software developers is projected to grow 17 percent from 2023 to 2033.", { host: "bls.gov", url: "https://bls.gov/x" });
  eq((await run(`PayPal's SWE Intern in Chicago pays $28-$49 an hour [E1]. Employment of software developers is projected to grow 17 percent from 2023 to 2033 [${g}].`, l)).text.includes("17 percent"), true, "fresh topic");
  eq((await run("The PayPal posting is open, so a second look at your resume is worth it [E2].", l)).text.includes("second look"), true, "a second look");
  const r = new Ledger();
  const a = r.add("page", "Jane Street interns earn $20,000 a month.", { host: "a.example", url: "https://a.example/js" });
  const c = r.add("page", "Citadel interns must pass a background check.", { host: "b.example", url: "https://b.example/c" });
  eq((await run(`Jane Street interns earn $20,000 a month [${a}]. They must pass a background check [${c}].`, r)).text.includes("background check"), false, "a leaning sentence keeps its subject");
});
