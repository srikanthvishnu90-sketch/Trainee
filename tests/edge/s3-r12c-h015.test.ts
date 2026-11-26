// S3 r12c (the subscription sitting for 2789d3090: dev H015 split the judges). The transcripts are in
// evals/career/results/s3sub-2789d30903203bd7af2833bcb80ad4facf0c5705-p1.json / -p2.json.
// Run: deno test -A --no-check tests/edge/s3-r12c-h015.test.ts
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CareerAccess, CareerContainment, CareerDoorstep, CareerOnboarding, CareerReply, CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const NOW = Date.UTC(2026, 9, 19, 15);

// ---------------------------------------------------------------------------------------------------------------- H015
const host = (CareerHost as any).createCareerHost({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment });
const fresh = (snapshot: unknown = null) => host.createTurnCtx({ userId: "u-dev", threadId: "t-dev", now: NOW, snapshot, accountPersistence: true });
function turns(texts: string[]): { intent: string; reply: string }[] {
  let snap: unknown = null;
  return texts.map((t) => { const ctx = fresh(snap); const r = host.runTurn(t, ctx); snap = host.extractSnapshot(ctx); return { intent: String(r.intent), reply: String(r.reply) }; });
}

Deno.test("S3 r12c / H015: the honest stop offers the draft for the company they named, and the command it quotes works", () => {
  const ask = "introduce me to an alum working at Bluepeak Networks";
  const [stop] = turns([ask]);
  assert(stop.intent === "people_matching_stop", stop.intent);
  assert(/I can't match or introduce you to people/.test(stop.reply), stop.reply);
  assert(/draft a coffee-chat email to an alum at Bluepeak Networks, written from your confirmed facts, for you to send yourself/.test(stop.reply), stop.reply);
  const cmd = /say "([^"]+)"/.exec(stop.reply)?.[1];
  assert(cmd === "draft a coffee-chat email to an alum at Bluepeak Networks", String(cmd));
  // (the quoted command is answered by the single-draft route, with the company as they wrote it: the routing copy no longer
  // re-spells "Networks" as "Network")
  const [, draft] = turns([ask, cmd!]);
  assert(draft.intent === "outreach_draft", draft.intent);
  assert(/an alum at Bluepeak Networks\./.test(draft.reply) && !/Bluepeak Network\b(?!s)/.test(draft.reply), draft.reply);
  assert(/Nothing has been sent/.test(draft.reply), draft.reply);
});

Deno.test("S3 r12c / H015: no company named keeps the general alternative; no role named quotes no command", () => {
  const [plain] = turns(["find me a mentor"]);
  assert(/draft a coffee-chat email to a role at a named company/.test(plain.reply), plain.reply);
  const [norole] = turns(["introduce me to someone at Google"]);
  assert(/someone in the role you name at Google/.test(norole.reply) && !/say "/.test(norole.reply), norole.reply);
  for (const r of [plain.reply, norole.reply]) assert(!/\b(?:introduced|introduction (?:was|has been) made)\b/i.test(r), r);
});

// (review of PR #871, non-blocking: the draft names a company only when the ask names one, as the one they want to reach)
Deno.test("S3 r12c / H015: two companies named, or one that is where someone else is, keep the general alternative", () => {
  for (const ask of ["my friend at Google said Bluepeak is hiring, can you introduce me to an alum there?", "introduce me to an alum at Bluepeak Networks or Ridgeway Capital",
    "someone at Google said they know people at Bluepeak, introduce me to an alum"]) {
    const [stop] = turns([ask]);
    assert(stop.intent === "people_matching_stop", `${ask}: ${stop.intent}`);
    assert(/draft a coffee-chat email to a role at a named company/.test(stop.reply) && !/say "/.test(stop.reply) && !/at Google,|at Google —/.test(stop.reply), `${ask}: ${stop.reply}`);
  }
});
