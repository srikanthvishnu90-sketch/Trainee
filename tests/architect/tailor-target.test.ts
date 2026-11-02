// TAILOR TARGET (2026-11-01, 1v1 V039): "tailor my resume for the stripe data analyst job" tailored Figma's Data Analyst,
// Growth role. The posting the person names is the one tailored: by company (in any case), by a link to it, or by its
// number in the list last shown. When more than one posting fits, the person is asked which and nothing is tailored; no
// other posting is picked for them. Every scenario runs the live path in-process (evals/career/world.ts) with the 1v1's
// postings in the thread: two at Stripe, two at Notion, and Ramp, Plaid, Figma, Brex, Airtable, Datadog and Evercore.
// Every person, company posting and number here is SYNTHETIC test data.
import { openWorld, worldTurn } from "../../evals/career/world.ts";
import { seed } from "../../evals/career/one-v-one/run.ts";
import { URL } from "../../evals/career/one-v-one/postings.ts";

const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const COMPANIES = ["Stripe", "Ramp", "Plaid", "Figma", "Brex", "Airtable", "Notion", "Datadog", "Evercore"];

async function talk(state: "new" | "profile" | "inflight", turns: string[]) {
  const w = await openWorld(seed(state));
  let now = w.now;
  const out: { reply: string; intent: string | null; handler: string }[] = [];
  for (const m of turns) { out.push(await worldTurn(w, { brain: "router", threadId: "A", message: m, now }) as any); now += 90000; }
  return out;
}
const tailored = (r: { reply: string }) => (/tailored for (.+?) at ([A-Z][A-Za-z]+)/.exec(r.reply) || []).slice(1, 3);
const others = (reply: string, keep: string[]) => COMPANIES.filter((c) => !keep.includes(c) && reply.includes(c));
const questions = (reply: string) => (reply.match(/\?/g) || []).length;

Deno.test("a company named in lower case is the posting tailored (V039: asked for Stripe, tailored Figma)", async () => {
  const [r] = await talk("profile", ["tailor my resume for the stripe data analyst job"]);
  const [title, company] = tailored(r);
  assert(company === "Stripe" && title === "Data Analyst", `tailored "${title} at ${company}", want Data Analyst at Stripe: ${r.reply}`);
  assert(!others(r.reply, ["Stripe"]).length, `no other company in the reply: ${others(r.reply, ["Stripe"])}`);
});

Deno.test("a role named after its company picks that company's posting, and a short ask by company alone too", async () => {
  for (const [ask, want] of [["tailor for ramp", "Ramp"], ["make my resume fit the brex role", "Brex"], ["can you tailor my resume to Airtable's posting", "Airtable"]]) {
    const [r] = await talk("profile", [ask]);
    assert(tailored(r)[1] === want, `"${ask}" tailored ${tailored(r).join(" at ") || "nothing"}, want ${want}: ${r.reply.slice(0, 200)}`);
    assert(r.intent === "career_tailor", `"${ask}" intent ${r.intent}`);
  }
});

Deno.test("a link to a posting in hand is the posting tailored", async () => {
  const [r] = await talk("profile", [`tailor my resume to this one ${URL.plaid}`]);
  assert(tailored(r)[1] === "Plaid", `tailored ${tailored(r).join(" at ") || "nothing"}, want Plaid: ${r.reply.slice(0, 200)}`);
});

Deno.test("two postings at the named company: asked which, both listed and numbered, nothing tailored; the answer tailors it", async () => {
  const [ask, pick] = await talk("profile", ["tailor my resume for stripe", "2"]);
  assert(ask.intent === "tailor_needs_posting", `intent ${ask.intent}: ${ask.reply}`);
  assert(!/\btailored for\b/.test(ask.reply), `nothing tailored: ${ask.reply}`);
  assert(/^1\) .+ at Stripe$/m.test(ask.reply) && /^2\) .+ at Stripe$/m.test(ask.reply), `both Stripe postings numbered: ${ask.reply}`);
  assert(!others(ask.reply, ["Stripe"]).length, `only Stripe's postings offered: ${ask.reply}`);
  assert(questions(ask.reply) === 1, `one question: ${ask.reply}`);
  const second = /^2\) (.+) at Stripe$/m.exec(ask.reply)![1];
  assert(tailored(pick)[1] === "Stripe" && tailored(pick)[0] === second, `"2" tailored ${tailored(pick).join(" at ") || "nothing"}, want ${second} at Stripe: ${pick.reply.slice(0, 200)}`);
});

Deno.test("two companies named: asked which of the two; a negated company is not a target", async () => {
  const [r] = await talk("profile", ["tailor my resume for ramp or brex"]);
  assert(r.intent === "tailor_needs_posting" && !/\btailored for\b/.test(r.reply), `asked, not tailored: ${r.reply}`);
  assert(/\bat Ramp$/m.test(r.reply) && /\bat Brex$/m.test(r.reply) && !others(r.reply, ["Ramp", "Brex"]).length, `Ramp and Brex offered, no other: ${r.reply}`);
  const [n] = await talk("profile", ["tailor my resume for figma, not stripe"]);
  assert(tailored(n)[1] === "Figma", `"figma, not stripe" tailored ${tailored(n).join(" at ") || "nothing"}: ${n.reply.slice(0, 200)}`);
});

Deno.test("a number from the list just shown is that role", async () => {
  const [list, r] = await talk("profile", ["find me data analyst jobs", "tailor my resume for #2"]);
  const second = /^2\) (.+?) at ([A-Z][A-Za-z]+)/m.exec(list.reply) || /\b2\) (.+?) at ([A-Z][A-Za-z]+)/.exec(list.reply);
  assert(second, `the search numbers its roles: ${list.reply.slice(0, 300)}`);
  assert(tailored(r)[1] === second![2] && tailored(r)[0] === second![1], `#2 tailored ${tailored(r).join(" at ") || "nothing"}, want ${second![1]} at ${second![2]}`);
});

Deno.test("an ask that names no posting is asked which, and nothing is tailored (V040)", async () => {
  for (const state of ["new", "profile"] as const) {
    const [r] = await talk(state, ["tailor my resume"]);
    assert(r.intent === "tailor_needs_posting" && !/\btailored for\b/.test(r.reply), `${state}: asked, not tailored: ${r.reply}`);
    assert(/^1\) /m.test(r.reply) && /^2\) /m.test(r.reply), `${state}: options numbered: ${r.reply}`);
    assert(questions(r.reply) === 1, `${state}: one question: ${r.reply}`);
  }
});
