// Review of #849, round 10 (2026-11-16; architect direction, D-088 structural bar). Earlier tests are unchanged except where the
// round-9 file says so. Fixtures are invented. Stub judges only; no network.
// R1: no shape skips the check. Advice, Trainee's own offers and needs lists need no unit that states them, but each still goes to
//     the judge (inside the per-reply cap): a "no" judge, or none, drops it.
// R2: a URL names a posting's employer only as a known ATS board, or as a host the posting's own text names; a job board never does.
//     A sentence naming an employer the turn does not know carries that subject, never onto another employer's unit.
// R3: a year in a posting's title names the role only when it is the turn's year or later; an older one still dates the figure.
import * as RP from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import * as SP from "../../../supabase/functions/_shared/agent/research/support.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const { Ledger, runReplyPipeline } = RP;
type Ledger = InstanceType<typeof RP.Ledger>;
type C = { claim: string; source: string };
const NOW = Date.parse("2026-11-16T15:00:00Z");
let asked: string[] = [];
const yes = async (cs: C[]) => { asked.push(...cs.map((c) => c.claim)); return cs.map(() => "yes" as const); };
const no = async (cs: C[]) => { asked.push(...cs.map((c) => c.claim)); return cs.map(() => "no" as const); };
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
const two = () => { const l = new Ledger(NOW);
  l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1" } });
  l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", location: "New York, NY", pay: "$80 an hour", state: "open", deadline: "December 7, 2026", url: "https://citadel.example/1" } });
  return l; };

// Round-9 shapes that carried a claim past every check on 16418afc3 (probes-rv10-849/p8-hatches.ts).
const HATCHES = ["Remember they don't sponsor visas.", "Remember the role is fully remote.", "Skip the cover letter, since their recruiters never read them.",
  "Don't ask about sponsorship, because they never sponsor anyone.", "Use the referral portal, because the team fills most seats through referrals.",
  "Be ready for a take-home test, which every candidate gets.", "Apply in the first round, when most seats are filled.",
  "Want me to prepare the PayPal application for the fully remote, visa-sponsored role?", "I can tell you PayPal sponsors visas for interns.",
  "I can confirm PayPal sponsors visas for interns.", "I can draft a note asking PayPal to match Citadel's higher pay.",
  "Want me to apply to Citadel instead, the better-paying firm?", "Would you like me to apply to PayPal's best-paying team?",
  "Before sending, settle your email and PayPal's relocation bonus."];
const ADVICE = ["Apply early in the cycle.", "Lead your message with the project closest to the role.", "Keep it short and specific.", "Mention the team you want to join.",
  "Ask for a referral only after a short chat.", "Want me to prepare the PayPal application for your approval?"];

Deno.test("#849 round 10 R1: advice and Trainee's own offers are judged; a 'no' judge, or none, drops every one", async () => {
  for (const s of [...HATCHES, ...ADVICE]) {
    for (const j of [no, null]) {
      const l = two(); asked = [];
      const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /^PayPal.*pay/)}]. ${s}`, l, { judge: j, ask: "tell me about the paypal internship", repair: null });
      eq(out.text.includes(s.replace(/\.$/, "")), false, `${j ? "no judge answer" : "no judge"}: ${s} -> ${out.text}`);
    }
  }
  // The tagged imperative too.
  const l = two(); asked = [];
  const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(l, /^PayPal.*pay/)}]. Remember they require a background check and drug test [${id(l, /^Citadel.*pay/)}].`, l, { judge: no, ask: "x", repair: null });
  eq(out.text.includes("background check"), false, out.text);
  // Pure advice still stands on a judge's yes, and the judge was asked about it (it is never skipped).
  for (const s of ADVICE) {
    const m = two(); asked = [];
    const o2 = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${id(m, /^PayPal.*pay/)}]. ${s}`, m, { judge: yes, ask: "what does it pay and any tips", repair: null });
    eq([o2.text.includes(s), asked.some((c) => c.includes(s))], [true, true], `${s}: ${o2.text}`);
  }
});

Deno.test("#849 round 10 R2: only a known ATS board or a host the posting names owns a posting; job boards never do", async () => {
  const ue = (SP as any).urlEmployer as (u: string, t?: string) => string | null;
  for (const u of ["https://www.simplify.jobs/p/1", "https://app.joinhandshake.com/jobs/1", "https://wellfound.com/jobs/1", "https://www.builtin.com/job/1", "https://www.ziprecruiter.com/x", "https://www.levels.fyi/x"]) eq(ue(u, "Software Engineer Intern at Stripe"), null, u);
  eq([ue("https://jobs.ashbyhq.com/ramp/1"), ue("https://boards.greenhouse.io/stripe/jobs/1"), ue("https://jobs.smartrecruiters.com/acme/1")], ["ramp", "stripe", "acme"], "ATS boards");
  eq([ue("https://careers.paypal.com/x", "SWE Intern"), ue("https://careers.paypal.com/x", "SWE Intern at PayPal")], [null, "paypal"], "an employer host only when the posting names it");
  // Two company-less postings on an aggregator: each is its title's employer, so "It pays $60" after Stripe never takes Ramp's figure.
  for (const j of [yes]) {
    const l = new Ledger(NOW);
    l.fromToolResult("search_postings", { postings: [
      { title: "Software Engineer Intern at Stripe", location: "Seattle, WA", pay: "$45 an hour", url: "https://www.simplify.jobs/p/1" },
      { title: "Software Engineer Intern at Ramp", location: "New York, NY", pay: "$60 an hour", url: "https://www.simplify.jobs/p/2" }] });
    eq(l.units.filter((u) => /pay/.test(u.text)).map((u) => u.owner), ["Stripe", "Ramp"], "owners from the titles");
    const out = await runReplyPipeline(`Stripe's internship is in Seattle [${id(l, /Stripe/)}]. It pays $60 an hour [${id(l, /Ramp/)}].`, l, { judge: j, ask: "what does stripe pay", repair: null });
    eq(out.text.includes("$60"), false, out.text);
    const fb = await runReplyPipeline(`Stripe pays $70 an hour [${id(l, /Stripe/)}].`, l, { judge: j, ask: "what's the pay there?", repair: null });
    eq(fb.text.includes("$60"), false, `the fallback never lists Ramp's pay for a Stripe answer: ${fb.text}`);
  }
  // The host names one employer, the title another: the title's.
  const h = new Ledger(NOW);
  h.fromToolResult("get_posting", { posting: { title: "Quant Research Intern at Jane Street", pay: "$100 an hour", url: "https://careers.citadel.com/x" } });
  eq(h.units[0].owner, "Jane Street", "title over an unnamed host");
  const o3 = await runReplyPipeline(`Citadel pays $100 an hour [${h.units[0].id}].`, h, { judge: yes, ask: "what does citadel pay", repair: null });
  eq(o3.text.includes("Citadel pays $100"), false, o3.text);
  // An employer no tool result names is carried too: "It pays $60" after it never stands on Ramp's unit.
  const r = new Ledger(NOW);
  r.fromToolResult("get_posting", { posting: { title: "Software Engineer Intern", location: "New York, NY", pay: "$60 an hour", state: "open", url: "https://jobs.ashbyhq.com/ramp/1" } });
  const o4 = await runReplyPipeline(`Stripe's internship is in Seattle. It pays $60 an hour [${id(r, /pay/)}].`, r, { judge: yes, ask: "what does stripe pay", repair: null });
  eq(o4.text.includes("$60"), false, o4.text);
});

Deno.test("#849 round 10 R3: a year in a posting's title names the role only from the turn's year on", async () => {
  const mk = (title: string, now = NOW) => { const l = new Ledger(now); l.fromToolResult("get_posting", { posting: { company: "PayPal", title, pay: "$28-$49 an hour", url: "https://paypal.example/x" } }); return l; };
  for (const [title, now, stands] of [["SWE Intern - Summer 2023", NOW, false], ["SWE Intern - Summer 2027", NOW, true], ["SWE Intern - Summer 2026", NOW, false /* amended in round 11 (N3): that summer ended Aug 31 */], ["SWE Intern - Fall 2026", NOW, true], ["SWE Intern - Summer 2027", Date.parse("2028-02-01T00:00:00Z"), false]] as const) {
    const l = mk(title, now);
    const out = await runReplyPipeline(`PayPal pays $28-$49 an hour [${l.units[0].id}].`, l, { judge: yes, ask: "what does it pay", repair: null });
    eq(out.text.startsWith("PayPal pays $28-$49 an hour."), stands, `${title} at ${new Date(now).toISOString().slice(0, 10)}: ${out.text}`);
  }
});
