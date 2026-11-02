// REMOTE ONLY (2026-11-01): a remote search returns only postings that say they are remote (the posting's remote field, or
// "remote" in its own location, e.g. "New York, NY or Remote"); an onsite posting is never offered as remote. A negated
// remote ("no remote") and a place named beside it ("Chicago or remote") are not remote-only asks. Live path
// (evals/career/world.ts) over the in-flight world's postings (SYNTHETIC): Figma and Airtable "Remote - US", Ramp "New York,
// NY or Remote", Stripe, Plaid, Brex and Notion "Chicago, IL".
import assertNode from "node:assert/strict";
import { openWorld, worldTurn } from "../../evals/career/world.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const ONSITE = ["Stripe", "Plaid", "Brex", "Notion"];

async function search(message: string, profiled = false) {
  const w = await openWorld(profiled ? { now: W.now, postings: W.postings, facts: W.facts } : { now: W.now, postings: W.postings });
  return await worldTurn(w, { brain: "router", threadId: "A", message, now: w.now });
}
const named = (reply: string, cos: string[]) => cos.filter((co) => new RegExp(`\\b${co}\\b`).test(reply));

Deno.test("a remote search lists only postings that say they are remote", async () => {
  for (const [m, profiled] of [["any remote data analyst jobs", false], ["find me remote data analyst roles", false], ["remote jobs please", true]] as const) {
    const r = await search(m, profiled);
    assertNode.match(r.handler, /^router:career_(?:internship_)?discovery$/, `${m}: ${r.handler}`);
    assertNode.deepEqual(named(r.reply, ONSITE), [], `${m}: an onsite role offered as remote\n${r.reply}`);
    assertNode.ok(named(r.reply, ["Figma", "Ramp"]).length >= 1, `${m}: the remote roles are shown\n${r.reply}`);
  }
});

Deno.test("not remote-only: a negated remote, and a place named beside remote", async () => {
  const no = await search("data analyst jobs in chicago, no remote");
  assertNode.ok(named(no.reply, ONSITE).length >= 1, no.reply);
  const either = await search("data analyst jobs in chicago or remote");
  assertNode.ok(named(either.reply, ONSITE).length >= 1, either.reply);
});
