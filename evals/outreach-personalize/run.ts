// Personalized outreach eval: trunk's drafting (career_outreach.ts draftFor on the recipient's row) against the
// personalization engine (draftFor with the recipient's sourced facts), over the 32 fixture recipients. No paid call:
// each side is written by a scripted writer that writes the most specific thing its payload gives it (fixtures.ts), or,
// with --recorded <file.json>, by recorded model text ({ "<fixture key>": { "trunk": "Subject: ...", "new": "Subject: ..." } }).
// Measures, per side: drafted, swap-test pass (against every other recipient and a same-title colleague), sourced-fact
// rate (names a sourced fact about them beyond title and firm), overlap said when there is one, zero unsourced claims
// (the fact-lock with the recipient's sourced facts), one ask, and within the field's length norm.
// Run: deno run -A --no-check evals/outreach-personalize/run.ts [--json] [--recorded file.json]
import { FIXTURES, fakeWriter, NOW, SENDER_FACTS, trunkWriter } from "./fixtures.ts";
import { anchorsUsed, asksIn, buildRecipientBrief, planFor, swapTest } from "../../supabase/functions/_shared/career_outreach_personalize.ts";
import { draftFor, type ModelFn, outreachLock } from "../../supabase/functions/_shared/career_outreach.ts";

const args = Deno.args;
const recordedPath = args.includes("--recorded") ? args[args.indexOf("--recorded") + 1] : null;
const recorded: Record<string, { trunk?: string; new?: string }> | null = recordedPath ? JSON.parse(await Deno.readTextFile(recordedPath)) : null;
const replay = (text: string): ModelFn => async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

const briefs = FIXTURES.map((f) => buildRecipientBrief(f.r, f.facts, NOW));
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
type Side = "trunk" | "new";
const rows: Record<Side, { key: string; drafted: boolean; swap: boolean; sourced: boolean; overlap: boolean | null; clean: boolean; oneAsk: boolean; inLength: boolean; why?: string }[]> = { trunk: [], new: [] };

for (const [i, f] of FIXTURES.entries()) {
  const brief = briefs[i], others = briefs.filter((_, j) => j !== i);
  const plan = planFor({ facts: SENDER_FACTS, r: f.r, recipientFacts: f.facts, role: f.role, now: NOW });
  for (const side of ["trunk", "new"] as Side[]) {
    const text = recorded?.[f.key]?.[side];
    const model = text ? replay(text) : side === "trunk" ? trunkWriter() : fakeWriter();
    const d = side === "trunk"
      ? await draftFor({ model, facts: SENDER_FACTS, r: f.r, topic: f.role ?? null, personal: false })
      : await draftFor({ model, facts: SENDER_FACTS, r: { ...f.r, facts: f.facts }, personal: { role: f.role, others, now: NOW } });
    if (!d.ok) { rows[side].push({ key: f.key, drafted: false, swap: false, sourced: false, overlap: plan.overlap.length ? false : null, clean: true, oneAsk: false, inLength: false, why: d.detail.join("; ") }); continue; }
    const used = anchorsUsed(d.body, brief).filter((x) => x.id !== "row:title" && x.id !== "row:firm");
    const shared = [...d.shared, ...plan.overlap.map((o) => ({ kind: "school" as const, value: o.value, fact: o.sender_fact, field: "school" as const }))];
    const lock = outreachLock(`${d.subject}\n${d.body}`, { facts: SENDER_FACTS.filter((x) => !(x as any).needs_confirmation).map((x) => x.text), recipient: f.r, shared,
      recipientFacts: brief.facts.map((x) => `${x.text} \n ${x.anchor}`), ...(f.role ? { topic: f.role } : {}) });
    rows[side].push({
      key: f.key, drafted: true, swap: swapTest(d.body, brief, others).pass, sourced: used.length > 0,
      overlap: plan.overlap.length ? plan.overlap.some((o) => o.kind === "their_work" ? used.some((u) => u.id === o.recipient_fact) : plain(d.body).includes(plain(o.value))) : null,
      clean: lock.pass, oneAsk: asksIn(d.body).sentences.length === 1, inLength: d.body.split(/\s+/).filter(Boolean).length <= plan.max_words,
    });
  }
}

// With nothing sourced about them (title and firm only): trunk writes an email anyway; the engine asks one question.
const bare = { trunk: { drafted: 0, generic: 0 }, new: { drafted: 0, asked: 0 } };
for (const [i, f] of FIXTURES.entries()) {
  const others = briefs.filter((_, j) => j !== i), r = { ...f.r, school: "", prior_firms: [] };
  const t = await draftFor({ model: trunkWriter(), facts: SENDER_FACTS, r, topic: f.role ?? null, personal: false });
  if (t.ok) { bare.trunk.drafted++; if (!swapTest(t.body, buildRecipientBrief(r, [], NOW), others).pass) bare.trunk.generic++; }
  const n = await draftFor({ model: fakeWriter(), facts: SENDER_FACTS, r, personal: { role: f.role, others, now: NOW } });
  if (n.ok) bare.new.drafted++; else if (n.why === "unsourced") bare.new.asked++;
}
const pct = (xs: boolean[]) => xs.length ? `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}% (${xs.filter(Boolean).length}/${xs.length})` : "n/a";
const summary = (side: Side) => {
  const r = rows[side];
  return {
    drafted: pct(r.map((x) => x.drafted)), swap_test: pct(r.map((x) => x.swap)), sourced_fact: pct(r.map((x) => x.sourced)),
    overlap_said: pct(r.filter((x) => x.overlap !== null).map((x) => !!x.overlap)), no_unsourced_claim: pct(r.filter((x) => x.drafted).map((x) => x.clean)),
    one_ask: pct(r.map((x) => x.oneAsk)), within_length: pct(r.map((x) => x.inLength)),
  };
};
const out = { recipients: FIXTURES.length, writer: recorded ? `recorded (${recordedPath})` : "scripted (no model call)", trunk: summary("trunk"), new: summary("new"), nothing_sourced: bare, rows };
if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`Personalized outreach eval: ${out.recipients} recipients, ${out.writer}`);
  console.log(`${"metric".padEnd(20)}${"trunk".padEnd(16)}new`);
  for (const k of Object.keys(out.trunk) as (keyof typeof out.trunk)[]) console.log(`${k.padEnd(20)}${out.trunk[k].padEnd(16)}${out.new[k]}`);
  console.log(`nothing sourced (title and firm only), ${FIXTURES.length} recipients: trunk drafted ${bare.trunk.drafted} (${bare.trunk.generic} fail the swap test); new drafted ${bare.new.drafted}, asked one question ${bare.new.asked}`);
}
